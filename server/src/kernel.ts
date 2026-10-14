import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const PLAN_LIFETIME_MS = 5 * 60 * 1000;
const CURRENT_SCHEMA_VERSION = 1;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface KernelOptions {
  readonly databasePath: string;
  readonly validateSnapshot: (snapshot: unknown) => void;
  readonly now?: () => number;
}

export interface WorkspaceSnapshot {
  readonly workspaceId: string;
  readonly revision: number;
  readonly privacyEpoch: number;
  readonly schemaVersion: number;
  readonly snapshot: JsonValue;
}

export interface CommandInput {
  readonly expectedRevision: number;
  readonly expectedPrivacyEpoch: number;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly canonicalRequest: string;
}

export interface CommandContext {
  readonly snapshot: Readonly<JsonValue>;
  readonly request: Readonly<JsonValue>;
  readonly revision: number;
  readonly privacyEpoch: number;
}

export interface CommandMutation {
  readonly snapshot: JsonValue;
  readonly receipt: JsonValue;
  readonly privacyEpoch?: number;
  readonly accountGenerations?: Readonly<Record<string, number>>;
}

export interface CommandReceipt {
  readonly idempotencyKey: string;
  readonly type: string;
  readonly revision: number;
  readonly privacyEpoch: number;
  readonly replayed: boolean;
  readonly result: JsonValue;
}

export interface OneUsePlan {
  readonly planId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly privacyEpoch: number;
  readonly accountId: string;
  readonly accountGeneration: number;
  readonly sourceHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PlanInput {
  readonly expectedRevision: number;
  readonly expectedPrivacyEpoch: number;
  readonly accountId: string;
  readonly sourceHash: string;
}

export interface ExternalAttemptInput {
  readonly planId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
}

export interface ExternalAttemptReceipt {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly planId: string;
  readonly payloadHash: string;
  readonly accountId: string;
  readonly accountGeneration: number;
  readonly privacyEpoch: number;
  readonly status: 'pending' | 'known' | 'unknown';
  readonly replayed: boolean;
  readonly result?: JsonValue;
}

/** Trusted server-module context. Never serialize or expose this object through an HTTP response. */
export interface OwnedTransactionContext {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly revision: number;
  readonly now: number;
  /** Raw connection access is restricted to trusted internal modules inside this callback. */
  readonly db: Database.Database;
  /** Throws after the synchronous owner transaction callback has returned. */
  readonly assertActive: () => void;
}

export class KernelError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'KernelError';
  }
}

function fail(code: string, message: string): never {
  throw new KernelError(message, code);
}

function requireUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail('invalid_id', `${label} must be a UUIDv4.`);
}

function requireInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('invalid_input', `${label} must be a safe integer.`);
}

function requireCanonicalIdempotencyKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail('invalid_input', 'The idempotency key is invalid.');
  }
}

function requireType(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 96 || !/^[a-z][a-z0-9._:-]{0,95}$/.test(value)) {
    fail('invalid_input', 'The command type is invalid.');
  }
}

function cleanJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_json', 'JSON numbers must be finite.');
    return value;
  }
  if (typeof value !== 'object') fail('invalid_json', 'Only JSON values can be persisted.');
  if (ancestors.has(value)) fail('invalid_json', 'JSON values cannot contain cycles.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        fail('invalid_json', 'JSON arrays cannot contain extra properties.');
      }
      const entries: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail('invalid_json', 'JSON arrays cannot be sparse.');
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('invalid_json', 'JSON arrays cannot contain accessors.');
        entries.push(cleanJson(descriptor.value, ancestors));
      }
      return entries;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('invalid_json', 'JSON objects must be plain objects.');
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) fail('invalid_json', 'JSON objects cannot contain symbol keys.');
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('invalid_json', 'JSON objects cannot contain accessors.');
      output[key] = cleanJson((value as Record<string, unknown>)[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown, maxBytes = MAX_JSON_BYTES): { text: string; value: JsonValue } {
  const json = cleanJson(value);
  const encode = (item: JsonValue): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key]!)}`).join(',')}}`;
  };
  const text = encode(json);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail('size_limit', 'The JSON value exceeds the physical storage limit.');
  return { text, value: json };
}

function parseCanonicalJson(text: unknown, maxBytes = MAX_COMMAND_BYTES): { text: string; value: JsonValue } {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) fail('size_limit', 'The command JSON exceeds the physical byte limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('invalid_json', 'The command request is not valid JSON.'); }
  const canonical = canonicalJson(parsed, maxBytes);
  if (canonical.text !== text) fail('invalid_json', 'The command request must use canonical JSON encoding.');
  return canonical;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseStoredJson(text: string, maxBytes = MAX_JSON_BYTES): JsonValue {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail('corrupt_store', 'Stored JSON exceeds its physical size limit.');
  try { return cleanJson(JSON.parse(text)); }
  catch (error) {
    if (error instanceof KernelError) throw error;
    return fail('corrupt_store', 'Stored JSON is invalid.');
  }
}

interface SessionRow {
  token_hash: string;
  owner_id: string;
  workspace_id: string;
  expires_at: number;
  revoked_at: number | null;
  privacy_epoch: number;
}

interface WorkspaceRow {
  id: string;
  owner_id: string;
  revision: number;
  privacy_epoch: number;
  schema_version: number;
  snapshot_json: string;
}

interface PlanRow {
  plan_id: string;
  owner_id: string;
  token_hash: string;
  workspace_id: string;
  revision: number;
  privacy_epoch: number;
  account_id: string;
  account_generation: number;
  source_hash: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

interface AttemptRow {
  attempt_id: string;
  workspace_id: string;
  owner_id: string;
  token_hash: string;
  idempotency_key: string;
  plan_id: string;
  payload_hash: string;
  account_id: string;
  account_generation: number;
  privacy_epoch: number;
  status: 'pending' | 'known' | 'unknown';
  result_json: string | null;
  created_at: number;
  settled_at: number | null;
}

export class DurableKernel {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: KernelOptions) {
    if (typeof options.validateSnapshot !== 'function') throw new TypeError('A trusted snapshot validator is required.');
    if (!options.databasePath || options.databasePath === ':memory:') {
      if (options.databasePath !== ':memory:') throw new TypeError('A database path is required.');
    } else mkdirSync(dirname(resolve(options.databasePath)), { recursive: true });
    this.now = options.now ?? Date.now;
    this.db = new Database(options.databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    try { this.migrate(); }
    catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    const check = this.db.pragma('quick_check') as Array<{ quick_check?: string }>;
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') fail('corrupt_store', 'SQLite integrity check failed.');
    const versionRow = this.db.pragma('user_version', { simple: true }) as number;
    if (!Number.isSafeInteger(versionRow) || versionRow < 0) fail('corrupt_store', 'SQLite schema version is invalid.');
    if (versionRow > CURRENT_SCHEMA_VERSION) fail('newer_schema', 'This server cannot open a database from a newer schema version.');
    if (versionRow === CURRENT_SCHEMA_VERSION) return;
    if (versionRow !== 0) fail('unsupported_migration', `No migration exists from schema version ${versionRow}.`);

    const migrateV1 = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          privacy_epoch INTEGER NOT NULL CHECK (privacy_epoch >= 0),
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          snapshot_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX workspaces_owner_idx ON workspaces(owner_id);

        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          privacy_epoch INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sessions_workspace_idx ON sessions(workspace_id);

        CREATE TABLE commands (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          command_type TEXT NOT NULL,
          privacy_epoch INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status = 'committed'),
          result_json TEXT NOT NULL,
          committed_revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, idempotency_key)
        ) STRICT;

        CREATE TABLE account_generations (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, account_id)
        ) STRICT;

        CREATE TABLE one_use_plans (
          plan_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          token_hash TEXT NOT NULL REFERENCES sessions(token_hash),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          privacy_epoch INTEGER NOT NULL,
          account_id TEXT NOT NULL,
          account_generation INTEGER NOT NULL,
          source_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER,
          CHECK (expires_at > created_at)
        ) STRICT;
        CREATE INDEX one_use_plans_workspace_idx ON one_use_plans(workspace_id);

        CREATE TABLE external_attempts (
          attempt_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          owner_id TEXT NOT NULL,
          token_hash TEXT NOT NULL REFERENCES sessions(token_hash),
          idempotency_key TEXT NOT NULL,
          plan_id TEXT NOT NULL UNIQUE REFERENCES one_use_plans(plan_id),
          payload_hash TEXT NOT NULL,
          account_id TEXT NOT NULL,
          account_generation INTEGER NOT NULL,
          privacy_epoch INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'known', 'unknown')),
          result_json TEXT,
          created_at INTEGER NOT NULL,
          settled_at INTEGER,
          UNIQUE (workspace_id, idempotency_key),
          CHECK ((status = 'pending' AND settled_at IS NULL) OR (status != 'pending' AND settled_at IS NOT NULL))
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    });
    migrateV1.immediate();
  }

  private assertOpen(): void {
    if (this.closed) fail('closed', 'The persistence kernel is closed.');
  }

  private authenticate(sessionToken: unknown): { tokenHash: string; session: SessionRow; workspace: WorkspaceRow; now: number } {
    this.assertOpen();
    if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) fail('unauthenticated', 'The session is invalid or expired.');
    const tokenHash = digest(sessionToken);
    const session = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as SessionRow | undefined;
    const now = this.clockNow();
    if (!session || session.revoked_at !== null || session.expires_at <= now) fail('unauthenticated', 'The session is invalid or expired.');
    const workspace = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(session.workspace_id) as WorkspaceRow | undefined;
    if (!workspace || workspace.owner_id !== session.owner_id || workspace.privacy_epoch !== session.privacy_epoch) {
      fail('unauthenticated', 'The session no longer owns an active workspace.');
    }
    return { tokenHash, session, workspace, now };
  }

  private clockNow(): number {
    const current = this.now();
    if (!Number.isSafeInteger(current) || current < 0) fail('clock_invalid', 'The server clock is invalid.');
    return current;
  }

  private validateSnapshot(snapshot: unknown): { text: string; value: JsonValue } {
    this.options.validateSnapshot(snapshot);
    return canonicalJson(snapshot, MAX_JSON_BYTES);
  }

  private loadWorkspaceSnapshot(workspace: WorkspaceRow): WorkspaceSnapshot {
    const snapshot = parseStoredJson(workspace.snapshot_json);
    this.options.validateSnapshot(snapshot);
    return Object.freeze({ workspaceId: workspace.id, revision: workspace.revision, privacyEpoch: workspace.privacy_epoch,
      schemaVersion: workspace.schema_version, snapshot });
  }

  /** Trusted bootstrap entry point. Future HTTP handlers must supply the authenticated principal, not a client workspace id. */
  createWorkspace(ownerId: string, initialSnapshot: unknown, schemaVersion = 1): { workspaceId: string; revision: number; privacyEpoch: number } {
    requireUuid(ownerId, 'Owner id');
    requireInteger(schemaVersion, 'Schema version', 1);
    const { text } = this.validateSnapshot(initialSnapshot);
    const workspaceId = randomUUID();
    const createdAt = this.clockNow();
    this.db.prepare(`INSERT INTO workspaces (id, owner_id, revision, privacy_epoch, schema_version, snapshot_json, created_at)
      VALUES (?, ?, 0, 0, ?, ?, ?)`).run(workspaceId, ownerId, schemaVersion, text, createdAt);
    return Object.freeze({ workspaceId, revision: 0, privacyEpoch: 0 });
  }

  /** Trusted session-issuance entry point; workspace ownership is verified before a session is minted. */
  createSession(workspaceId: string, authenticatedOwnerId: string, expiresAt: number): string {
    requireUuid(workspaceId, 'Workspace id');
    requireUuid(authenticatedOwnerId, 'Owner id');
    requireInteger(expiresAt, 'Session expiry', 1);
    const now = this.clockNow();
    if (expiresAt <= now) fail('invalid_input', 'Session expiry must be in the future.');
    const workspace = this.db.prepare('SELECT owner_id, privacy_epoch FROM workspaces WHERE id = ?').get(workspaceId) as Pick<WorkspaceRow, 'owner_id' | 'privacy_epoch'> | undefined;
    if (!workspace || workspace.owner_id !== authenticatedOwnerId) fail('forbidden', 'The authenticated principal does not own this workspace.');
    const token = randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO sessions (token_hash, owner_id, workspace_id, expires_at, revoked_at, privacy_epoch, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)`).run(digest(token), authenticatedOwnerId, workspaceId, expiresAt, workspace.privacy_epoch, now);
    return token;
  }

  getOwnedSnapshot(sessionToken: string): WorkspaceSnapshot {
    const { workspace } = this.authenticate(sessionToken);
    return this.loadWorkspaceSnapshot(workspace);
  }

  /**
   * TRUSTED INTERNAL ONLY. Runs a synchronous server-module operation under BEGIN IMMEDIATE,
   * authenticating its owner, session, workspace and privacy epoch on this same connection.
   * Never pass the context or its database handle to a client or HTTP handler.
   */
  withOwnedTransaction<T>(sessionToken: string, expectedPrivacyEpoch: number,
    callback: (context: OwnedTransactionContext) => T): T {
    requireInteger(expectedPrivacyEpoch, 'Expected privacy epoch');
    if (typeof callback !== 'function') fail('invalid_input', 'A trusted synchronous transaction callback is required.');
    if (callback.constructor?.name === 'AsyncFunction') fail('invalid_mutator', 'Owned transaction callbacks must be synchronous.');
    const transaction = this.db.transaction((): T => {
      const { session, workspace, now } = this.authenticate(sessionToken);
      if (workspace.privacy_epoch !== expectedPrivacyEpoch) fail('stale_epoch', 'The workspace privacy epoch changed.');
      let active = true;
      const context: OwnedTransactionContext = Object.freeze({ workspaceId: workspace.id, ownerId: session.owner_id,
        privacyEpoch: workspace.privacy_epoch, revision: workspace.revision, now, db: this.db,
        assertActive: () => { if (!active) fail('transaction_context_expired', 'The owned transaction context is no longer active.'); } });
      try {
        const result = callback(context);
        if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function') {
          fail('invalid_mutator', 'Owned transaction callbacks must return synchronously.');
        }
        return result;
      } finally {
        active = false;
      }
    });
    return transaction.immediate();
  }

  /** TRUSTED INTERNAL ONLY. Used for module-owned schema setup, never for request authority. */
  withTrustedDatabaseTransaction<T>(callback: (db: Database.Database) => T): T {
    if (typeof callback !== 'function') fail('invalid_input', 'A trusted synchronous database callback is required.');
    if (callback.constructor?.name === 'AsyncFunction') fail('invalid_mutator', 'Database callbacks must be synchronous.');
    this.assertOpen();
    const transaction = this.db.transaction(() => {
      const result = callback(this.db);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function') {
        fail('invalid_mutator', 'Database callbacks must return synchronously.');
      }
      return result;
    });
    return transaction.immediate();
  }

  revokeSession(sessionToken: string): void {
    const authenticated = this.authenticate(sessionToken);
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(authenticated.now, authenticated.tokenHash);
  }

  runLocalCommand(sessionToken: string, input: CommandInput,
    mutator: (context: CommandContext) => CommandMutation): CommandReceipt {
    requireCanonicalIdempotencyKey(input?.idempotencyKey);
    requireType(input?.type);
    requireInteger(input?.expectedRevision, 'Expected revision');
    requireInteger(input?.expectedPrivacyEpoch, 'Expected privacy epoch');
    if (typeof mutator !== 'function') fail('invalid_input', 'A trusted synchronous mutator is required.');
    const request = parseCanonicalJson(input.canonicalRequest);
    const requestDigest = digest(`${input.type}\0${request.text}`);
    this.assertOpen();

    const transaction = this.db.transaction((): CommandReceipt => {
      const { tokenHash, workspace, now } = this.authenticate(sessionToken);
      if (input.expectedPrivacyEpoch !== workspace.privacy_epoch) fail('stale_epoch', 'The workspace privacy epoch changed.');
      const existing = this.db.prepare(`SELECT request_digest, command_type, privacy_epoch, result_json, committed_revision
        FROM commands WHERE workspace_id = ? AND idempotency_key = ?`).get(workspace.id, input.idempotencyKey) as {
          request_digest: string; command_type: string; privacy_epoch: number; result_json: string; committed_revision: number;
        } | undefined;
      if (existing) {
        if (existing.request_digest !== requestDigest || existing.command_type !== input.type || existing.privacy_epoch !== workspace.privacy_epoch) {
          fail('idempotency_conflict', 'This idempotency key is already bound to a different command.');
        }
        return Object.freeze({ idempotencyKey: input.idempotencyKey, type: input.type, revision: existing.committed_revision,
          privacyEpoch: existing.privacy_epoch, replayed: true, result: parseStoredJson(existing.result_json, MAX_COMMAND_BYTES) });
      }
      if (input.expectedRevision !== workspace.revision) fail('stale_revision', 'The workspace revision changed.');

      const originalSnapshot = parseStoredJson(workspace.snapshot_json);
      this.options.validateSnapshot(originalSnapshot);
      const context = Object.freeze({ snapshot: deepFreeze(originalSnapshot), request: deepFreeze(request.value),
        revision: workspace.revision, privacyEpoch: workspace.privacy_epoch });
      let mutation: CommandMutation;
      try { mutation = mutator(context); }
      catch (error) { throw error; }
      if (!mutation || typeof mutation !== 'object' || typeof (mutation as { then?: unknown }).then === 'function') {
        fail('invalid_mutator', 'The local command mutator must return synchronously.');
      }
      const nextSnapshot = this.validateSnapshot(mutation.snapshot);
      const receipt = canonicalJson(mutation.receipt, MAX_COMMAND_BYTES);
      const nextEpoch = mutation.privacyEpoch ?? workspace.privacy_epoch;
      requireInteger(nextEpoch, 'New privacy epoch');
      if (nextEpoch < workspace.privacy_epoch || nextEpoch > workspace.privacy_epoch + 1) fail('invalid_mutator', 'Privacy epoch may only remain the same or advance once.');
      const nextRevision = workspace.revision + 1;
      if (!Number.isSafeInteger(nextRevision)) fail('revision_overflow', 'Workspace revision cannot be advanced.');

      const updatedWorkspace = this.db.prepare(`UPDATE workspaces SET revision = ?, privacy_epoch = ?, snapshot_json = ? WHERE id = ? AND revision = ? AND privacy_epoch = ?`)
        .run(nextRevision, nextEpoch, nextSnapshot.text, workspace.id, workspace.revision, workspace.privacy_epoch);
      if (updatedWorkspace.changes !== 1) {
        fail('stale_revision', 'The workspace changed during command commit.');
      }
      if (mutation.accountGenerations !== undefined) {
        if (!mutation.accountGenerations || typeof mutation.accountGenerations !== 'object' || Array.isArray(mutation.accountGenerations)) {
          fail('invalid_mutator', 'Account generation updates must be a plain map.');
        }
        for (const [accountId, generation] of Object.entries(mutation.accountGenerations)) {
          requireUuid(accountId, 'Account id');
          requireInteger(generation, 'Account generation');
          const old = this.db.prepare('SELECT generation FROM account_generations WHERE workspace_id = ? AND account_id = ?')
            .get(workspace.id, accountId) as { generation: number } | undefined;
          if (old && generation < old.generation) fail('invalid_mutator', 'Account generation cannot move backwards.');
          this.db.prepare(`INSERT INTO account_generations (workspace_id, account_id, generation, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(workspace_id, account_id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at`)
            .run(workspace.id, accountId, generation, now);
        }
      }
      this.db.prepare(`INSERT INTO commands (workspace_id, idempotency_key, request_digest, command_type, privacy_epoch, status, result_json, committed_revision, created_at)
        VALUES (?, ?, ?, ?, ?, 'committed', ?, ?, ?)`)
        .run(workspace.id, input.idempotencyKey, requestDigest, input.type, workspace.privacy_epoch, receipt.text, nextRevision, now);
      if (nextEpoch > workspace.privacy_epoch) {
        this.db.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE workspace_id = ?').run(now, workspace.id);
      }
      return Object.freeze({ idempotencyKey: input.idempotencyKey, type: input.type, revision: nextRevision,
        privacyEpoch: nextEpoch, replayed: false, result: receipt.value });
    });
    return transaction.immediate();
  }

  createOneUsePlan(sessionToken: string, input: PlanInput): OneUsePlan {
    requireInteger(input?.expectedRevision, 'Expected revision');
    requireInteger(input?.expectedPrivacyEpoch, 'Expected privacy epoch');
    requireUuid(input?.accountId, 'Account id');
    if (typeof input?.sourceHash !== 'string' || !SHA256.test(input.sourceHash)) fail('invalid_input', 'Source hash must be a SHA-256 hex digest.');
    const create = this.db.transaction((): OneUsePlan => {
      const { tokenHash, session, workspace, now } = this.authenticate(sessionToken);
      this.assertExpectedWorkspace(workspace, input.expectedRevision, input.expectedPrivacyEpoch);
      const accountGeneration = this.currentAccountGeneration(workspace.id, input.accountId);
      if (accountGeneration === undefined) fail('stale_account', 'The account has no current verified generation.');
      const plan: OneUsePlan = Object.freeze({ planId: randomUUID(), workspaceId: workspace.id, revision: workspace.revision,
        privacyEpoch: workspace.privacy_epoch, accountId: input.accountId, accountGeneration, sourceHash: input.sourceHash.toLowerCase(),
        createdAt: now, expiresAt: now + PLAN_LIFETIME_MS });
      this.db.prepare(`INSERT INTO one_use_plans (plan_id, owner_id, token_hash, workspace_id, revision, privacy_epoch, account_id,
        account_generation, source_hash, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(plan.planId, session.owner_id, tokenHash, workspace.id, plan.revision, plan.privacyEpoch, plan.accountId,
          plan.accountGeneration, plan.sourceHash, plan.createdAt, plan.expiresAt);
      return plan;
    });
    return create.immediate();
  }

  consumeOneUsePlan(sessionToken: string, planId: string, expectedSourceHash: string): OneUsePlan {
    requireUuid(planId, 'Plan id');
    if (typeof expectedSourceHash !== 'string' || !SHA256.test(expectedSourceHash)) fail('invalid_input', 'Source hash must be a SHA-256 hex digest.');
    return this.db.transaction(() => {
      const { tokenHash, session, workspace, now } = this.authenticate(sessionToken);
      const plan = this.readPlan(planId);
      this.assertPlanUsable(plan, tokenHash, session.owner_id, workspace, now, expectedSourceHash.toLowerCase());
      const updated = this.db.prepare(`UPDATE one_use_plans SET consumed_at = ? WHERE plan_id = ? AND consumed_at IS NULL`)
        .run(now, plan.plan_id);
      if (updated.changes !== 1) fail('plan_consumed', 'The review plan has already been consumed.');
      return this.publicPlan(plan);
    }).immediate();
  }

  /** Atomically consumes the plan and creates the sole pending external attempt before any network I/O. */
  claimExternalAttempt(sessionToken: string, input: ExternalAttemptInput): ExternalAttemptReceipt | (ExternalAttemptReceipt & { readonly permission: 'perform_once' }) {
    requireUuid(input?.planId, 'Plan id');
    requireCanonicalIdempotencyKey(input?.idempotencyKey);
    if (typeof input?.payloadHash !== 'string' || !SHA256.test(input.payloadHash)) fail('invalid_input', 'Payload hash must be a SHA-256 hex digest.');
    return this.db.transaction(() => {
      const { tokenHash, session, workspace, now } = this.authenticate(sessionToken);
      const prior = this.db.prepare(`SELECT * FROM external_attempts WHERE workspace_id = ? AND idempotency_key = ?`)
        .get(workspace.id, input.idempotencyKey) as AttemptRow | undefined;
      if (prior) {
        if (prior.plan_id !== input.planId || prior.payload_hash !== input.payloadHash.toLowerCase() || prior.privacy_epoch !== workspace.privacy_epoch) {
          fail('idempotency_conflict', 'This external idempotency key is already bound to another attempt.');
        }
        return this.publicAttempt(prior, true);
      }
      const plan = this.readPlan(input.planId);
      this.assertPlanUsable(plan, tokenHash, session.owner_id, workspace, now, plan.source_hash);
      const attemptId = randomUUID();
      this.db.prepare(`UPDATE one_use_plans SET consumed_at = ? WHERE plan_id = ? AND consumed_at IS NULL`).run(now, plan.plan_id);
      this.db.prepare(`INSERT INTO external_attempts (attempt_id, workspace_id, owner_id, token_hash, idempotency_key, plan_id,
        payload_hash, account_id, account_generation, privacy_epoch, status, result_json, created_at, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`)
        .run(attemptId, workspace.id, session.owner_id, tokenHash, input.idempotencyKey, plan.plan_id,
          input.payloadHash.toLowerCase(), plan.account_id, plan.account_generation, plan.privacy_epoch, now);
      const row = this.db.prepare('SELECT * FROM external_attempts WHERE attempt_id = ?').get(attemptId) as AttemptRow;
      return Object.freeze({ ...this.publicAttempt(row, false), permission: 'perform_once' as const });
    }).immediate();
  }

  settleExternalAttempt(sessionToken: string, attemptId: string, outcome: 'known' | 'unknown', result: unknown): ExternalAttemptReceipt {
    requireUuid(attemptId, 'Attempt id');
    if (outcome !== 'known' && outcome !== 'unknown') fail('invalid_input', 'External outcome must be known or unknown.');
    const resultJson = canonicalJson(result, MAX_COMMAND_BYTES);
    return this.db.transaction(() => {
      const { tokenHash, session, workspace, now } = this.authenticate(sessionToken);
      const row = this.db.prepare('SELECT * FROM external_attempts WHERE attempt_id = ?').get(attemptId) as AttemptRow | undefined;
      if (!row || row.workspace_id !== workspace.id || row.owner_id !== session.owner_id || row.token_hash !== tokenHash) {
        fail('not_found', 'The external attempt was not found for this session.');
      }
      if (row.privacy_epoch !== workspace.privacy_epoch) fail('stale_epoch', 'The external attempt belongs to an earlier privacy epoch.');
      if (row.status !== 'pending') {
        if (row.status !== outcome || row.result_json !== resultJson.text) fail('attempt_settled', 'An external attempt can only be settled once.');
        return this.publicAttempt(row, true);
      }
      this.db.prepare(`UPDATE external_attempts SET status = ?, result_json = ?, settled_at = ? WHERE attempt_id = ? AND status = 'pending'`)
        .run(outcome, resultJson.text, now, attemptId);
      const updated = this.db.prepare('SELECT * FROM external_attempts WHERE attempt_id = ?').get(attemptId) as AttemptRow;
      return this.publicAttempt(updated, false);
    }).immediate();
  }

  recordAccountGeneration(sessionToken: string, accountId: string, verifiedGeneration: number): void {
    requireUuid(accountId, 'Account id');
    requireInteger(verifiedGeneration, 'Verified account generation');
    this.db.transaction(() => {
      const { workspace, now } = this.authenticate(sessionToken);
      const current = this.currentAccountGeneration(workspace.id, accountId);
      if (current !== undefined && verifiedGeneration < current) fail('stale_account', 'Account generation cannot move backwards.');
      this.db.prepare(`INSERT INTO account_generations (workspace_id, account_id, generation, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id, account_id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at`)
        .run(workspace.id, accountId, verifiedGeneration, now);
    }).immediate();
  }

  private assertExpectedWorkspace(workspace: WorkspaceRow, expectedRevision: number, expectedPrivacyEpoch: number): void {
    if (workspace.privacy_epoch !== expectedPrivacyEpoch) fail('stale_epoch', 'The workspace privacy epoch changed.');
    if (workspace.revision !== expectedRevision) fail('stale_revision', 'The workspace revision changed.');
  }

  private currentAccountGeneration(workspaceId: string, accountId: string): number | undefined {
    const row = this.db.prepare('SELECT generation FROM account_generations WHERE workspace_id = ? AND account_id = ?')
      .get(workspaceId, accountId) as { generation: number } | undefined;
    return row?.generation;
  }

  private readPlan(planId: string): PlanRow {
    const plan = this.db.prepare('SELECT * FROM one_use_plans WHERE plan_id = ?').get(planId) as PlanRow | undefined;
    if (!plan) fail('plan_missing', 'The review plan is no longer available.');
    return plan;
  }

  private assertPlanUsable(plan: PlanRow, tokenHash: string, ownerId: string, workspace: WorkspaceRow, now: number, sourceHash: string): void {
    if (plan.token_hash !== tokenHash || plan.owner_id !== ownerId || plan.workspace_id !== workspace.id) fail('forbidden', 'The review plan belongs to another session.');
    if (plan.consumed_at !== null) fail('plan_consumed', 'The review plan has already been consumed.');
    if (now < plan.created_at) fail('clock_rollback', 'The server clock moved backwards after review.');
    if (now >= plan.expires_at) fail('plan_expired', 'The review plan has expired.');
    if (plan.revision !== workspace.revision) fail('stale_revision', 'The workspace changed after review.');
    if (plan.privacy_epoch !== workspace.privacy_epoch) fail('stale_epoch', 'The privacy epoch changed after review.');
    const currentGeneration = this.currentAccountGeneration(workspace.id, plan.account_id);
    if (currentGeneration === undefined || currentGeneration !== plan.account_generation) fail('stale_account', 'The account changed after review.');
    if (plan.source_hash !== sourceHash) fail('stale_source', 'The selected source changed after review.');
  }

  private publicPlan(plan: PlanRow): OneUsePlan {
    return Object.freeze({ planId: plan.plan_id, workspaceId: plan.workspace_id, revision: plan.revision,
      privacyEpoch: plan.privacy_epoch, accountId: plan.account_id, accountGeneration: plan.account_generation,
      sourceHash: plan.source_hash, createdAt: plan.created_at, expiresAt: plan.expires_at });
  }

  private publicAttempt(row: AttemptRow, replayed: boolean): ExternalAttemptReceipt {
    return Object.freeze({ attemptId: row.attempt_id, idempotencyKey: row.idempotency_key, planId: row.plan_id,
      payloadHash: row.payload_hash, accountId: row.account_id, accountGeneration: row.account_generation,
      privacyEpoch: row.privacy_epoch, status: row.status, replayed,
      ...(row.result_json === null ? {} : { result: parseStoredJson(row.result_json, MAX_COMMAND_BYTES) }) });
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

export function createDurableKernel(options: KernelOptions): DurableKernel {
  return new DurableKernel(options);
}
