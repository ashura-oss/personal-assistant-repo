import { createHash, createHmac, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';

const AUTH_SCHEMA_VERSION = 1;
const PASSWORD_N = 131072;
const PASSWORD_R = 8;
const PASSWORD_P = 1;
const PASSWORD_BYTES = 32;
const SALT_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const INFLIGHT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PASSWORD_BYTES = 1024;

export interface AuthOptions {
  readonly canonicalOrigin: string;
  readonly authSecret: Uint8Array;
  readonly allowLocalHttp?: boolean;
  readonly now?: () => number;
  /** Test synchronization only; it cannot alter the fixed scrypt parameters or digest. */
  readonly afterPasswordHashForTesting?: () => Promise<void>;
}

export interface LoginChallenge {
  readonly preAuthToken: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export interface AuthenticatedSession {
  readonly authenticated: true;
  readonly workspaceId: string;
  readonly privacyEpoch: number;
  readonly csrfToken: string;
}

export type SessionDTO = AuthenticatedSession | { readonly authenticated: false };

export interface LoginResult {
  /** Internal composition value for setting an HttpOnly cookie. Never expose in getSession. */
  readonly sessionToken: string;
  readonly session: AuthenticatedSession;
}

export class AuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function reject(code: string, message: string): never { throw new AuthError(message, code); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function hmac(secret: Buffer, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}\0${value}`, 'utf8').digest('base64url');
}

function validPassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PASSWORD_BYTES) reject('invalid_password', 'The password is invalid.');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_PASSWORD_BYTES || bytes.toString('utf8') !== value) {
    reject('invalid_password', 'The password is invalid.');
  }
}

function validToken(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) reject(code, 'The authentication token is invalid.');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, rejectPromise) => {
    nodeScrypt(password, salt, PASSWORD_BYTES, { N: PASSWORD_N, r: PASSWORD_R, p: PASSWORD_P, maxmem: 256 * 1024 * 1024 },
      (error, key) => error ? rejectPromise(error) : resolve(Buffer.from(key)));
  });
}

interface OwnerRow {
  owner_id: string;
  workspace_id: string;
  password_salt: Buffer;
  password_hash: Buffer;
  password_algorithm: string;
  password_n: number;
  password_r: number;
  password_p: number;
  password_length: number;
  auth_generation: number;
}

interface ThrottleRow {
  failures: number;
  window_started_at: number;
  cooldown_until: number;
  last_now: number;
  inflight_id: string | null;
  inflight_until: number | null;
}

interface ChallengeRow {
  challenge_hash: string;
  csrf_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export class AuthService {
  readonly #secret: Buffer;
  readonly #now: () => number;
  readonly #canonicalOrigin: string;
  readonly #afterPasswordHashForTesting: (() => Promise<void>) | undefined;
  private hashBusy = false;
  private closed = false;

  constructor(private readonly kernel: DurableKernel, options: AuthOptions) {
    if (!(options?.authSecret instanceof Uint8Array) || options.authSecret.byteLength !== 32) {
      reject('invalid_auth_secret', 'The authentication secret must contain exactly 32 bytes.');
    }
    this.#secret = Buffer.from(options.authSecret);
    this.#now = options.now ?? Date.now;
    this.#canonicalOrigin = this.validateConfiguredOrigin(options.canonicalOrigin, options.allowLocalHttp === true);
    this.#afterPasswordHashForTesting = options.afterPasswordHashForTesting;
    try { this.kernel.withTrustedDatabaseTransaction((db) => this.initialize(db)); }
    catch (error) { this.#secret.fill(0); throw error; }
  }

  private validateConfiguredOrigin(origin: string, allowLocalHttp: boolean): string {
    if (typeof origin !== 'string') reject('invalid_origin_config', 'A canonical HTTPS origin is required.');
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return reject('invalid_origin_config', 'The canonical origin is invalid.'); }
    const isLocalHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      (parsed.protocol !== 'https:' && !(allowLocalHttp && isLocalHttp))) {
      reject('invalid_origin_config', 'The canonical origin must be HTTPS (or explicitly enabled local HTTP).');
    }
    return origin;
  }

  private initialize(db: Database.Database): void {
    const exists = (name: string): boolean => Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const hasSchema = exists('auth_schema');
    const tables = ['auth_owner', 'auth_throttle', 'auth_challenges', 'auth_sessions'];
    if (!hasSchema) {
      if (tables.some(exists)) reject('auth_schema_corrupt', 'Authentication tables exist without a schema version.');
      db.exec(`
        CREATE TABLE auth_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version>0)) STRICT;
        CREATE TABLE auth_owner (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL UNIQUE,
          workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id), password_salt BLOB NOT NULL CHECK(length(password_salt)=32),
          password_hash BLOB NOT NULL CHECK(length(password_hash)=32), password_algorithm TEXT NOT NULL CHECK(password_algorithm='scrypt'), password_n INTEGER NOT NULL,
          password_r INTEGER NOT NULL, password_p INTEGER NOT NULL, password_length INTEGER NOT NULL,
          auth_generation INTEGER NOT NULL CHECK(auth_generation>=1), created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE auth_throttle (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), failures INTEGER NOT NULL CHECK(failures>=0),
          window_started_at INTEGER NOT NULL, cooldown_until INTEGER NOT NULL, last_now INTEGER NOT NULL,
          inflight_id TEXT, inflight_until INTEGER
        ) STRICT;
        CREATE TABLE auth_challenges (
          challenge_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, consumed_at INTEGER, CHECK(expires_at>created_at)
        ) STRICT;
        CREATE TABLE auth_sessions (
          token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
          owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          auth_generation INTEGER NOT NULL, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
          revoked_at INTEGER, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX auth_sessions_owner_idx ON auth_sessions(owner_id);
        INSERT INTO auth_schema(singleton,version) VALUES(1,${AUTH_SCHEMA_VERSION});
      `);
      db.prepare('INSERT INTO auth_throttle(singleton,failures,window_started_at,cooldown_until,last_now,inflight_id,inflight_until) VALUES(1,0,0,0,0,NULL,NULL)').run();
      return;
    }
    if (tables.some((table) => !exists(table))) reject('auth_schema_corrupt', 'The authentication schema is incomplete.');
    const row = db.prepare('SELECT version FROM auth_schema WHERE singleton=1').get() as { version: number } | undefined;
    if (!row || !Number.isSafeInteger(row.version) || row.version < 1) reject('auth_schema_corrupt', 'The authentication schema version is invalid.');
    if (row.version > AUTH_SCHEMA_VERSION) reject('auth_newer_schema', 'This server cannot read a newer authentication schema.');
    if (row.version !== AUTH_SCHEMA_VERSION) reject('auth_migration_required', 'No authentication schema migration is available.');
  }

  private assertOpen(): void { if (this.closed) reject('auth_closed', 'The authentication service is closed.'); }
  private clock(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) reject('clock_invalid', 'The server clock is invalid.');
    return now;
  }
  private assertOrigin(origin: unknown): void {
    if (typeof origin !== 'string' || origin !== this.#canonicalOrigin) reject('origin_rejected', 'The request origin is not allowed.');
  }
  private withHashSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.hashBusy) return Promise.reject(new AuthError('Authentication is busy; retry manually.', 'auth_busy'));
    this.hashBusy = true;
    return work().finally(() => { this.hashBusy = false; });
  }
  private async hashPassword(password: string, salt: Buffer): Promise<Buffer> {
    const hash = await derivePassword(password, salt);
    try {
      await this.#afterPasswordHashForTesting?.();
      return hash;
    } catch (error) {
      hash.fill(0);
      throw error;
    }
  }
  private owner(db: Database.Database): OwnerRow | undefined {
    return db.prepare('SELECT * FROM auth_owner WHERE singleton=1').get() as OwnerRow | undefined;
  }

  /** Trusted local enrollment. Creates the sole owner and workspace atomically; never callable from an HTTP handler. */
  async enrollOwner(password: string, initialSnapshot: unknown): Promise<{ ownerId: string; workspaceId: string }> {
    this.assertOpen(); validPassword(password);
    if (this.kernel.withTrustedDatabaseTransaction((db) => Boolean(db.prepare('SELECT 1 FROM auth_owner WHERE singleton=1').get()))) {
      reject('already_enrolled', 'The owner account is already enrolled.');
    }
    return this.withHashSlot(async () => {
      const salt = randomBytes(SALT_BYTES);
      let hash: Buffer | undefined;
      try {
        hash = await this.hashPassword(password, salt);
        this.assertOpen();
        return this.kernel.withTrustedDatabaseTransaction((db) => {
          this.assertOpen();
          if (db.prepare('SELECT 1 FROM auth_owner WHERE singleton=1').get()) reject('already_enrolled', 'The owner account is already enrolled.');
          const ownerId = randomUUID();
          const workspace = this.kernel.createWorkspace(ownerId, initialSnapshot);
          const now = this.clock();
          db.prepare(`INSERT INTO auth_owner(singleton,owner_id,workspace_id,password_salt,password_hash,password_algorithm,password_n,password_r,password_p,password_length,auth_generation,created_at)
            VALUES(1,?,?,?,?,?,?,?,?,?,1,?)`).run(ownerId, workspace.workspaceId, salt, hash, 'scrypt', PASSWORD_N, PASSWORD_R, PASSWORD_P, PASSWORD_BYTES, now);
          return Object.freeze({ ownerId, workspaceId: workspace.workspaceId });
        });
      } finally { salt.fill(0); if (hash) hash.fill(0); }
    });
  }

  createLoginChallenge(origin: string): LoginChallenge {
    this.assertOpen(); this.assertOrigin(origin);
    const preAuthToken = randomBytes(32).toString('base64url');
    const csrfToken = hmac(this.#secret, 'preauth-csrf:v1', preAuthToken);
    const now = this.clock();
    const expiresAt = now + CHALLENGE_TTL_MS;
    this.kernel.withTrustedDatabaseTransaction((db) => {
      if (!db.prepare('SELECT 1 AS present FROM auth_owner WHERE singleton=1').get()) reject('not_enrolled', 'The owner account has not been enrolled.');
      const throttle = db.prepare('SELECT last_now FROM auth_throttle WHERE singleton=1').get() as { last_now: number } | undefined;
      if (!throttle) reject('auth_schema_corrupt', 'The login throttle is unavailable.');
      if (now < throttle.last_now) reject('clock_rollback', 'The server clock moved backwards.');
      db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(now);
      const count = db.prepare('SELECT count(*) AS count FROM auth_challenges WHERE consumed_at IS NULL').get() as { count: number };
      if (count.count >= 64) reject('challenge_limit', 'Too many login challenges are active; retry after one expires.');
      db.prepare('INSERT INTO auth_challenges(challenge_hash,csrf_hash,created_at,expires_at,consumed_at) VALUES(?,?,?,?,NULL)')
        .run(sha256(preAuthToken), sha256(csrfToken), now, expiresAt);
      db.prepare('UPDATE auth_throttle SET last_now=? WHERE singleton=1').run(now);
    });
    return Object.freeze({ preAuthToken, csrfToken, expiresAt });
  }

  async login(input: { password: string; origin: string; preAuthToken: string; csrfToken: string; previousSessionToken?: string }): Promise<LoginResult> {
    this.assertOpen(); this.assertOrigin(input?.origin); validPassword(input?.password);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['password', 'origin', 'preAuthToken', 'csrfToken', 'previousSessionToken'].includes(key)) ||
      !['password', 'origin', 'preAuthToken', 'csrfToken'].every((key) => Object.hasOwn(input, key))) {
      reject('invalid_input', 'The login request is invalid.');
    }
    validToken(input?.preAuthToken, 'challenge_invalid');
    validToken(input?.csrfToken, 'csrf_rejected');
    if (input.previousSessionToken !== undefined) validToken(input.previousSessionToken, 'session_invalid');
    return this.withHashSlot(async () => {
      const ticket = randomUUID();
      const started = this.reserveLogin(input.preAuthToken, input.csrfToken, ticket);
      try {
        let passwordHash: Buffer;
        try { passwordHash = await this.hashPassword(input.password, started.owner.password_salt); }
        catch (error) { this.releaseInflight(ticket); throw error; }
        try {
          this.assertOpen();
          return this.finishLogin(started, passwordHash, input.previousSessionToken);
        }
        catch (error) { this.releaseInflight(ticket); throw error; }
        finally { passwordHash.fill(0); }
      } finally {
        started.owner.password_salt.fill(0);
        started.owner.password_hash.fill(0);
      }
    });
  }

  private reserveLogin(preAuthToken: string, csrfToken: string, ticket: string): { owner: OwnerRow; authGeneration: number; ticket: string } {
    const result = this.kernel.withTrustedDatabaseTransaction((db) => {
      this.assertOpen();
      const now = this.clock();
      const throttle = db.prepare('SELECT * FROM auth_throttle WHERE singleton=1').get() as ThrottleRow | undefined;
      if (!throttle) reject('auth_schema_corrupt', 'The login throttle is unavailable.');
      if (now < throttle.last_now) reject('clock_rollback', 'The server clock moved backwards.');
      const owner = this.owner(db);
      if (!owner) reject('unauthenticated', 'The supplied credentials are invalid.');
      this.assertOwnerPassword(owner);
      const challenge = db.prepare('SELECT * FROM auth_challenges WHERE challenge_hash=?').get(sha256(preAuthToken)) as ChallengeRow | undefined;
      if (!challenge || challenge.consumed_at !== null || now < challenge.created_at || now >= challenge.expires_at ||
        !constantTimeHexEqual(challenge.csrf_hash, sha256(csrfToken)) ||
        !constantTimeHexEqual(sha256(hmac(this.#secret, 'preauth-csrf:v1', preAuthToken)), challenge.csrf_hash)) {
        reject('challenge_invalid', 'The login challenge is invalid or expired.');
      }
      if (throttle.cooldown_until > now) reject('auth_throttled', 'Login is temporarily unavailable.');
      let failures = throttle.failures;
      let windowStartedAt = throttle.window_started_at;
      if (windowStartedAt === 0 || now - windowStartedAt >= FAILURE_WINDOW_MS) { failures = 0; windowStartedAt = now; }
      if (throttle.inflight_id !== null && throttle.inflight_until !== null) {
        if (throttle.inflight_until > now) reject('auth_busy', 'Authentication is busy; retry manually.');
        failures += 1;
        if (failures >= 5) {
          db.prepare('UPDATE auth_challenges SET consumed_at=? WHERE challenge_hash=? AND consumed_at IS NULL').run(now, challenge.challenge_hash);
          db.prepare(`UPDATE auth_throttle SET failures=?,window_started_at=?,cooldown_until=?,last_now=?,inflight_id=NULL,inflight_until=NULL WHERE singleton=1`)
            .run(failures, windowStartedAt, now + COOLDOWN_MS, now);
          return { denied: true as const };
        }
      }
      db.prepare('UPDATE auth_challenges SET consumed_at=? WHERE challenge_hash=? AND consumed_at IS NULL').run(now, challenge.challenge_hash);
      db.prepare(`UPDATE auth_throttle SET failures=?,window_started_at=?,last_now=?,inflight_id=?,inflight_until=? WHERE singleton=1`)
        .run(failures, windowStartedAt, now, ticket, now + INFLIGHT_TIMEOUT_MS);
      return { owner, authGeneration: owner.auth_generation, ticket };
    });
    if ('denied' in result) reject('auth_throttled', 'Login is temporarily unavailable.');
    return result;
  }

  private assertOwnerPassword(owner: OwnerRow): void {
    if (!Buffer.isBuffer(owner.password_salt) || owner.password_salt.length !== SALT_BYTES ||
      !Buffer.isBuffer(owner.password_hash) || owner.password_hash.length !== PASSWORD_BYTES ||
      owner.password_algorithm !== 'scrypt' ||
      owner.password_n !== PASSWORD_N || owner.password_r !== PASSWORD_R || owner.password_p !== PASSWORD_P ||
      owner.password_length !== PASSWORD_BYTES || !Number.isSafeInteger(owner.auth_generation) || owner.auth_generation < 1) {
      reject('auth_store_corrupt', 'The authentication record is unavailable.');
    }
  }

  private finishLogin(started: { owner: OwnerRow; authGeneration: number; ticket: string }, passwordHash: Buffer,
    previousSessionToken?: string): LoginResult {
    const result = this.kernel.withTrustedDatabaseTransaction((db) => {
      this.assertOpen();
      const now = this.clock();
      const current = this.owner(db);
      if (!current) reject('unauthenticated', 'The supplied credentials are invalid.');
      try {
      this.assertOwnerPassword(current);
      const throttle = db.prepare('SELECT * FROM auth_throttle WHERE singleton=1').get() as ThrottleRow | undefined;
      if (!throttle) reject('auth_schema_corrupt', 'The login throttle is unavailable.');
      if (now < throttle.last_now) reject('clock_rollback', 'The server clock moved backwards.');
      if (throttle.inflight_id !== started.ticket) reject('unauthenticated', 'The supplied credentials are invalid.');
      if (current.auth_generation !== started.authGeneration || current.auth_generation !== started.owner.auth_generation) {
        this.clearInflight(db, started.ticket, now, false);
        reject('unauthenticated', 'The supplied credentials are invalid.');
      }
      const matches = timingSafeEqual(passwordHash, current.password_hash);
      if (!matches) {
        const failures = throttle.failures + 1;
        const cooldown = failures >= 5 ? now + COOLDOWN_MS : throttle.cooldown_until;
        this.clearInflight(db, started.ticket, now, true, failures, cooldown);
        return { denied: true as const };
      }

      if (previousSessionToken !== undefined) {
        const previousHash = sha256(previousSessionToken);
        db.prepare('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash=?').run(now, previousHash);
        db.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash=?').run(now, previousHash);
      }
      const sessionToken = this.kernel.createSession(current.workspace_id, current.owner_id, now + SESSION_TTL_MS);
      const tokenHash = sha256(sessionToken);
      const csrfToken = hmac(this.#secret, 'session-csrf:v1', sessionToken);
      db.prepare(`INSERT INTO auth_sessions(token_hash,owner_id,workspace_id,auth_generation,csrf_hash,expires_at,revoked_at,created_at)
        VALUES(?,?,?,?,?,?,NULL,?)`).run(tokenHash, current.owner_id, current.workspace_id, current.auth_generation,
          sha256(csrfToken), now + SESSION_TTL_MS, now);
      this.clearInflight(db, started.ticket, now, false, 0, 0);
      const workspace = db.prepare('SELECT privacy_epoch FROM workspaces WHERE id=?').get(current.workspace_id) as { privacy_epoch: number };
      return Object.freeze({ sessionToken, session: Object.freeze({ authenticated: true as const,
        workspaceId: current.workspace_id, privacyEpoch: workspace.privacy_epoch, csrfToken }) });
      } finally {
        current.password_salt.fill(0);
        current.password_hash.fill(0);
      }
    });
    if ('denied' in result) reject('unauthenticated', 'The supplied credentials are invalid.');
    return result;
  }

  private clearInflight(db: Database.Database, ticket: string, now: number, failed: boolean,
    failures?: number, cooldownUntil?: number): void {
    const row = db.prepare('SELECT * FROM auth_throttle WHERE singleton=1').get() as ThrottleRow | undefined;
    if (!row || row.inflight_id !== ticket) return;
    const nextFailures = failures ?? (failed ? row.failures + 1 : row.failures);
    db.prepare(`UPDATE auth_throttle SET failures=?,window_started_at=?,cooldown_until=?,last_now=?,inflight_id=NULL,inflight_until=NULL WHERE singleton=1`)
      .run(nextFailures, row.window_started_at || now, cooldownUntil ?? row.cooldown_until, now);
  }

  private releaseInflight(ticket: string): void {
    this.kernel.withTrustedDatabaseTransaction((db) => {
      const now = this.clock();
      const row = db.prepare('SELECT * FROM auth_throttle WHERE singleton=1').get() as ThrottleRow | undefined;
      if (!row || row.inflight_id !== ticket || now < row.last_now) return;
      this.clearInflight(db, ticket, now, false);
    });
  }

  /** Returns a safe projection only; the session token is never returned from this method. */
  getSession(sessionToken: string): SessionDTO {
    this.assertOpen();
    try {
      const identity = this.kernel.getOwnedIdentity(sessionToken);
      return this.kernel.withOwnedTransaction(sessionToken, identity.privacyEpoch,
        (context) => this.sessionProjection(context, sessionToken));
    } catch { return Object.freeze({ authenticated: false }); }
  }

  /** Validates same-origin CSRF and the current authenticated session for an HTTP mutation. */
  assertMutation(sessionToken: string, origin: string, csrfToken: string): AuthenticatedSession {
    this.assertOpen();
    this.assertOrigin(origin);
    validToken(sessionToken, 'unauthenticated');
    validToken(csrfToken, 'csrf_rejected');
    const identity = this.kernel.getOwnedIdentity(sessionToken);
    return this.kernel.withOwnedTransaction(sessionToken, identity.privacyEpoch, (context) => {
      const session = this.sessionProjection(context, sessionToken);
      if (!session.authenticated || !constantTimeHexEqual(sha256(session.csrfToken), sha256(csrfToken))) {
        reject('csrf_rejected', 'The session or CSRF token is invalid.');
      }
      return session;
    });
  }

  private sessionProjection(context: OwnedTransactionContext, sessionToken: string): SessionDTO {
    const row = context.db.prepare('SELECT * FROM auth_sessions WHERE token_hash=?').get(sha256(sessionToken)) as
      { owner_id: string; workspace_id: string; auth_generation: number; csrf_hash: string; expires_at: number; revoked_at: number | null } | undefined;
    const owner = context.db.prepare('SELECT owner_id,workspace_id,auth_generation FROM auth_owner WHERE singleton=1').get() as
      Pick<OwnerRow, 'owner_id' | 'workspace_id' | 'auth_generation'> | undefined;
    if (!row || !owner || row.revoked_at !== null || row.expires_at <= context.now || row.owner_id !== context.ownerId ||
      row.workspace_id !== context.workspaceId || owner.owner_id !== context.ownerId || owner.workspace_id !== context.workspaceId ||
      owner.auth_generation !== row.auth_generation) return Object.freeze({ authenticated: false });
    const csrfToken = hmac(this.#secret, 'session-csrf:v1', sessionToken);
    if (!constantTimeHexEqual(row.csrf_hash, sha256(csrfToken))) return Object.freeze({ authenticated: false });
    return Object.freeze({ authenticated: true, workspaceId: context.workspaceId,
      privacyEpoch: context.privacyEpoch, csrfToken });
  }

  logout(sessionToken: string, origin: string, csrfToken: string): void {
    this.assertOpen(); this.assertOrigin(origin); validToken(sessionToken, 'unauthenticated'); validToken(csrfToken, 'csrf_rejected');
    const identity = this.kernel.getOwnedIdentity(sessionToken);
    this.kernel.withOwnedTransaction(sessionToken, identity.privacyEpoch, (context) => {
      const session = this.sessionProjection(context, sessionToken);
      if (!session.authenticated || !constantTimeHexEqual(sha256(session.csrfToken), sha256(csrfToken))) {
        reject('csrf_rejected', 'The session or CSRF token is invalid.');
      }
      const hash = sha256(sessionToken);
      context.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?').run(context.now, hash);
      context.db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(context.now, hash);
    });
  }

  /** Trusted local operation. Invalidates all sessions and any login already hashing against the prior auth generation. */
  logoutAll(): void {
    this.assertOpen();
    this.kernel.withTrustedDatabaseTransaction((db) => {
      const owner = db.prepare('SELECT owner_id,auth_generation FROM auth_owner WHERE singleton=1').get() as
        Pick<OwnerRow, 'owner_id' | 'auth_generation'> | undefined;
      if (!owner) reject('not_enrolled', 'The owner account has not been enrolled.');
      const nextGeneration = owner.auth_generation + 1;
      if (!Number.isSafeInteger(nextGeneration)) reject('auth_generation_overflow', 'The authentication generation cannot advance.');
      const now = this.clock();
      const throttle = db.prepare('SELECT last_now FROM auth_throttle WHERE singleton=1').get() as { last_now: number } | undefined;
      if (!throttle || now < throttle.last_now) reject('clock_rollback', 'The server clock moved backwards.');
      db.prepare('UPDATE auth_owner SET auth_generation=? WHERE singleton=1').run(nextGeneration);
      db.prepare('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE owner_id=?').run(now, owner.owner_id);
      db.prepare(`UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash IN
        (SELECT token_hash FROM auth_sessions WHERE owner_id=?)`).run(now, owner.owner_id);
      db.prepare('DELETE FROM auth_challenges').run();
      db.prepare('UPDATE auth_throttle SET failures=0,window_started_at=?,cooldown_until=0,last_now=?,inflight_id=NULL,inflight_until=NULL WHERE singleton=1')
        .run(now, now);
    });
  }

  /** Trusted local password reset. Invalidates every existing session and every outstanding login challenge. */
  async resetPassword(password: string): Promise<void> {
    this.assertOpen(); validPassword(password);
    const before = this.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT owner_id,auth_generation FROM auth_owner WHERE singleton=1').get() as
      Pick<OwnerRow, 'owner_id' | 'auth_generation'> | undefined);
    if (!before) reject('not_enrolled', 'The owner account has not been enrolled.');
    return this.withHashSlot(async () => {
      const salt = randomBytes(SALT_BYTES);
      let hash: Buffer | undefined;
      try {
        hash = await this.hashPassword(password, salt);
        this.assertOpen();
        this.kernel.withTrustedDatabaseTransaction((db) => {
          this.assertOpen();
          const current = db.prepare('SELECT owner_id,auth_generation FROM auth_owner WHERE singleton=1').get() as
            Pick<OwnerRow, 'owner_id' | 'auth_generation'> | undefined;
          if (!current || current.auth_generation !== before.auth_generation) reject('stale_auth_generation', 'The password changed during reset.');
          const nextGeneration = current.auth_generation + 1;
          if (!Number.isSafeInteger(nextGeneration)) reject('auth_generation_overflow', 'The authentication generation cannot advance.');
          const now = this.clock();
          const throttle = db.prepare('SELECT last_now FROM auth_throttle WHERE singleton=1').get() as { last_now: number } | undefined;
          if (!throttle || now < throttle.last_now) reject('clock_rollback', 'The server clock moved backwards.');
          db.prepare(`UPDATE auth_owner SET password_salt=?,password_hash=?,password_n=?,password_r=?,password_p=?,password_length=?,auth_generation=? WHERE singleton=1`)
            .run(salt, hash, PASSWORD_N, PASSWORD_R, PASSWORD_P, PASSWORD_BYTES, nextGeneration);
          db.prepare('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE owner_id=?').run(now, current.owner_id);
          db.prepare(`UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash IN
            (SELECT token_hash FROM auth_sessions WHERE owner_id=?)`).run(now, current.owner_id);
          db.prepare('DELETE FROM auth_challenges').run();
          db.prepare('UPDATE auth_throttle SET failures=0,window_started_at=?,cooldown_until=0,last_now=?,inflight_id=NULL,inflight_until=NULL WHERE singleton=1')
            .run(now, now);
        });
      } finally { salt.fill(0); if (hash) hash.fill(0); }
    });
  }

  close(): void { if (this.closed) return; this.closed = true; this.#secret.fill(0); }
}
