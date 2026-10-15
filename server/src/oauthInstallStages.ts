import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AuthError, AuthService } from './auth.js';
import { isValidAccountId } from './accountIds.js';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import { SecretVault, type OAuthStageBinding, type StageCiphertext } from './vault.js';

const SCHEMA_VERSION = 2;
const STAGE_TTL_MS = 10 * 60 * 1000;
const MAX_STAGE_PAYLOAD_BYTES = 64 * 1024;
const MAX_TOKEN_CHARS = 16_384;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REGISTRATION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CAPABILITIES = ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'] as const;

export type OAuthStageProvider = 'google' | 'microsoft';
export type OAuthStageCapability = typeof CAPABILITIES[number];
export type OAuthInstallStageState = 'authorization_pending' | 'exchange_claimed' | 'verified' | 'denied' | 'inspect_required' | 'expired' | 'consumed';

export interface OAuthStageIdentity {
  readonly providerNamespace: OAuthStageProvider;
  readonly clientId: string;
  readonly subject: string;
  readonly issuer?: string;
  readonly tenantId?: string;
  readonly resourceUserId?: string;
}

export interface OAuthReconnectLifecycle {
  readonly accountId: string;
  readonly connectionGeneration: number;
  readonly tokenRef?: string;
  readonly connected: boolean;
  readonly authStatus: 'configured' | 'connected' | 'reauth_required' | 'revoked';
  readonly identity?: OAuthReconnectIdentity;
}

export interface OAuthReconnectIdentity {
  readonly providerNamespace?: OAuthStageProvider;
  readonly clientId?: string;
  readonly subject: string;
  readonly issuer?: string;
  readonly tenantId?: string;
  readonly resourceUserId?: string;
}

/** Trusted registration and user-selected caps; browser callback values never configure provider registration. */
export interface CreateOAuthAuthorizationInput {
  readonly initiatingSessionToken: string;
  readonly registrationId: string;
  readonly provider: OAuthStageProvider;
  readonly requestedCapabilities: readonly OAuthStageCapability[];
  readonly reconnectLifecycle?: OAuthReconnectLifecycle;
}

export interface OAuthCallbackProof {
  readonly state: string;
  readonly cookieBinding: string;
}

export interface OAuthExchangeClaim {
  readonly attemptId: string;
  readonly claimToken: string;
  readonly payloadGeneration: number;
  readonly registrationId: string;
  readonly provider: OAuthStageProvider;
  readonly expiresAt: number;
}

export interface OAuthAuthorizationInputs {
  readonly pkceVerifier: string;
  readonly nonce: string;
  readonly requestedCapabilities: readonly OAuthStageCapability[];
  readonly reconnectLifecycle?: OAuthReconnectLifecycle;
}

/** Trusted provider adapter assertion, not provider verification performed by this repository. */
export interface OAuthVerifiedPayload {
  readonly provider: OAuthStageProvider;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly grantedScopes: readonly string[];
  readonly requestedCapabilities: readonly OAuthStageCapability[];
  readonly capabilities: readonly OAuthStageCapability[];
  readonly identity: OAuthStageIdentity;
  readonly displayName: string;
  readonly email?: string;
}

export interface OAuthInstallStageStatus {
  readonly attemptId: string;
  readonly registrationId: string;
  readonly provider: OAuthStageProvider;
  readonly status: OAuthInstallStageState;
  readonly payloadGeneration: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumption?: Readonly<{ commandId: string; accountId: string; accountGeneration: number }>;
}

export interface OAuthCallbackWorkspaceIdentity {
  readonly attemptId: string;
  readonly registrationId: string;
  readonly provider: OAuthStageProvider;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly privacyEpoch: number;
  readonly expiresAt: number;
}

export interface OAuthAuthorizationStartResult {
  /** Private trusted-service inputs for constructing the provider authorization URL and cookie. */
  readonly authorization: Readonly<{ state: string; cookieBinding: string; nonce: string; codeChallenge: string }>;
  /** Safe receipt contains no OAuth token, verifier, cookie, state, nonce, or encrypted payload. */
  readonly status: OAuthInstallStageStatus;
}

export type OAuthExchangeClaimResult =
  | Readonly<{ claimed: true; claim: OAuthExchangeClaim; authorization: OAuthAuthorizationInputs; status: OAuthInstallStageStatus }>
  | Readonly<{ claimed: false; status: OAuthInstallStageStatus }>;

export type OAuthVerifiedReadResult = Readonly<{ status: OAuthInstallStageStatus; payload?: OAuthVerifiedPayload;
  reconnectLifecycle?: OAuthReconnectLifecycle }>;

export class OAuthInstallStageError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'OAuthInstallStageError'; }
}

interface StageRow {
  stage_id: string;
  owner_id: string;
  workspace_id: string;
  privacy_epoch: number;
  initiating_session_binding: string;
  registration_id: string;
  provider: OAuthStageProvider;
  created_at: number;
  expires_at: number;
  state_hash: string;
  cookie_hash: string;
  claim_hash: string | null;
  payload_generation: number;
  payload_kind: 'authorization' | 'verified';
  status: OAuthInstallStageState;
  nonce: Buffer | null;
  tag: Buffer | null;
  ciphertext: Buffer | null;
  consumed_command_id: string | null;
  consumed_account_id: string | null;
  consumed_account_generation: number | null;
}

interface NormalizedAuthorizationPayload {
  readonly pkceVerifier: string;
  readonly nonce: string;
  readonly requestedCapabilities: readonly OAuthStageCapability[];
  readonly reconnectLifecycle?: OAuthReconnectLifecycle;
}

interface NormalizedVerifiedEnvelope {
  readonly payload: OAuthVerifiedPayload;
  readonly reconnectLifecycle?: OAuthReconnectLifecycle;
}

function fail(code: string, message: string): never { throw new OAuthInstallStageError(message, code); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function constantTimeHashEqual(left: string, right: string): boolean {
  return HASH_PATTERN.test(left) && HASH_PATTERN.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function closedFields(value: unknown, required: readonly string[], optional: readonly string[], code: string): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code, 'The OAuth stage input is invalid.');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code, 'The OAuth stage input is invalid.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set([...required, ...optional]);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((key) => !keys.includes(key))) {
      fail(code, 'The OAuth stage input is invalid.');
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') fail(code, 'The OAuth stage input is invalid.');
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code, 'The OAuth stage input is invalid.');
      result[key] = descriptor.value;
    }
    return result;
  } catch { return fail(code, 'The OAuth stage input is invalid.'); }
}

function safeText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function normalizeCapabilities(value: unknown, code: string): readonly OAuthStageCapability[] {
  if (!Array.isArray(value) || value.length > CAPABILITIES.length || value.some((item) => typeof item !== 'string' ||
      !CAPABILITIES.includes(item as OAuthStageCapability)) || new Set(value).size !== value.length ||
      value.includes('calendar.write') && !value.includes('calendar.read')) {
    fail(code, 'The requested OAuth capabilities are invalid.');
  }
  return Object.freeze([...value] as OAuthStageCapability[]);
}

function sameCapabilities(left: readonly OAuthStageCapability[], right: readonly OAuthStageCapability[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function normalizeIdentity(value: unknown, provider: OAuthStageProvider, code: string): OAuthStageIdentity {
  const fields = closedFields(value, ['providerNamespace', 'clientId', 'subject'], ['issuer', 'tenantId', 'resourceUserId'], code);
  if (fields.providerNamespace !== provider || !safeText(fields.clientId, 256) || !safeText(fields.subject, 2048) ||
      fields.issuer !== undefined && !safeText(fields.issuer, 2048) ||
      fields.tenantId !== undefined && !safeText(fields.tenantId, 512) ||
      fields.resourceUserId !== undefined && !safeText(fields.resourceUserId, 512) ||
      provider === 'microsoft' && !safeText(fields.resourceUserId, 512)) {
    fail(code, 'The verified OAuth identity is invalid.');
  }
  return Object.freeze({ providerNamespace: provider, clientId: fields.clientId, subject: fields.subject,
    ...(fields.issuer !== undefined ? { issuer: fields.issuer } : {}),
    ...(fields.tenantId !== undefined ? { tenantId: fields.tenantId } : {}),
    ...(fields.resourceUserId !== undefined ? { resourceUserId: fields.resourceUserId } : {}) });
}

function normalizeReconnectIdentity(value: unknown, provider: OAuthStageProvider, code: string): OAuthReconnectIdentity {
  const fields = closedFields(value, ['subject'], ['providerNamespace', 'clientId', 'issuer', 'tenantId', 'resourceUserId'], code);
  if (!safeText(fields.subject, 2048) ||
      fields.providerNamespace !== undefined && fields.providerNamespace !== provider ||
      fields.clientId !== undefined && !safeText(fields.clientId, 256) ||
      fields.issuer !== undefined && !safeText(fields.issuer, 2048) ||
      fields.tenantId !== undefined && !safeText(fields.tenantId, 512) ||
      fields.resourceUserId !== undefined && !safeText(fields.resourceUserId, 512)) {
    fail(code, 'The reconnect identity is invalid.');
  }
  return Object.freeze({ subject: fields.subject,
    ...(fields.providerNamespace !== undefined ? { providerNamespace: provider } : {}),
    ...(fields.clientId !== undefined ? { clientId: fields.clientId } : {}),
    ...(fields.issuer !== undefined ? { issuer: fields.issuer } : {}),
    ...(fields.tenantId !== undefined ? { tenantId: fields.tenantId } : {}),
    ...(fields.resourceUserId !== undefined ? { resourceUserId: fields.resourceUserId } : {}) });
}

function normalizeReconnect(value: unknown, provider: OAuthStageProvider, code: string): OAuthReconnectLifecycle {
  const fields = closedFields(value, ['accountId', 'connectionGeneration', 'connected', 'authStatus'], ['tokenRef', 'identity'], code);
  if (!isValidAccountId(fields.accountId) ||
      typeof fields.connectionGeneration !== 'number' || !Number.isSafeInteger(fields.connectionGeneration) || fields.connectionGeneration < 0 ||
      fields.tokenRef !== undefined && !safeText(fields.tokenRef, 128) || typeof fields.connected !== 'boolean' ||
      !['configured', 'connected', 'reauth_required', 'revoked'].includes(fields.authStatus as string)) {
    fail(code, 'The reconnect lifecycle is invalid.');
  }
  return Object.freeze({ accountId: fields.accountId, connectionGeneration: fields.connectionGeneration,
    ...(fields.tokenRef !== undefined ? { tokenRef: fields.tokenRef } : {}), connected: fields.connected,
    authStatus: fields.authStatus as OAuthReconnectLifecycle['authStatus'],
    ...(fields.identity !== undefined ? { identity: normalizeReconnectIdentity(fields.identity, provider, code) } : {}) });
}

function normalizeAuthorizationInput(value: unknown): CreateOAuthAuthorizationInput {
  const fields = closedFields(value, ['initiatingSessionToken', 'registrationId', 'provider', 'requestedCapabilities'], ['reconnectLifecycle'],
    'oauth_stage_invalid_input');
  if (typeof fields.initiatingSessionToken !== 'string' || !TOKEN_PATTERN.test(fields.initiatingSessionToken) ||
      typeof fields.registrationId !== 'string' || !REGISTRATION_PATTERN.test(fields.registrationId) ||
      (fields.provider !== 'google' && fields.provider !== 'microsoft')) {
    fail('oauth_stage_invalid_input', 'The OAuth authorization request is invalid.');
  }
  const requestedCapabilities = normalizeCapabilities(fields.requestedCapabilities, 'oauth_stage_invalid_input');
  const provider = fields.provider;
  return Object.freeze({ initiatingSessionToken: fields.initiatingSessionToken, registrationId: fields.registrationId,
    provider, requestedCapabilities,
    ...(fields.reconnectLifecycle !== undefined ? { reconnectLifecycle: normalizeReconnect(fields.reconnectLifecycle, provider, 'oauth_stage_invalid_input') } : {}) });
}

function normalizeCallbackProof(value: unknown): OAuthCallbackProof {
  const fields = closedFields(value, ['state', 'cookieBinding'], [], 'oauth_stage_invalid_proof');
  if (typeof fields.state !== 'string' || !TOKEN_PATTERN.test(fields.state) || typeof fields.cookieBinding !== 'string' ||
      !TOKEN_PATTERN.test(fields.cookieBinding)) fail('oauth_stage_invalid_proof', 'The OAuth callback proof is invalid.');
  return Object.freeze({ state: fields.state, cookieBinding: fields.cookieBinding });
}

function normalizeAuthorizationPayload(value: unknown, provider: OAuthStageProvider): NormalizedAuthorizationPayload {
  const fields = closedFields(value, ['pkceVerifier', 'nonce', 'requestedCapabilities'], ['reconnectLifecycle'], 'oauth_stage_payload_invalid');
  if (typeof fields.pkceVerifier !== 'string' || !TOKEN_PATTERN.test(fields.pkceVerifier) ||
      typeof fields.nonce !== 'string' || !TOKEN_PATTERN.test(fields.nonce)) fail('oauth_stage_payload_invalid', 'The OAuth authorization payload is invalid.');
  const requestedCapabilities = normalizeCapabilities(fields.requestedCapabilities, 'oauth_stage_payload_invalid');
  return Object.freeze({ pkceVerifier: fields.pkceVerifier, nonce: fields.nonce, requestedCapabilities,
    ...(fields.reconnectLifecycle !== undefined ? { reconnectLifecycle: normalizeReconnect(fields.reconnectLifecycle, provider, 'oauth_stage_payload_invalid') } : {}) });
}

function normalizeVerifiedPayload(value: unknown, provider: OAuthStageProvider, requested: readonly OAuthStageCapability[],
  reconnectLifecycle: OAuthReconnectLifecycle | undefined, now: number): OAuthVerifiedPayload {
  const fields = closedFields(value, ['provider', 'accessToken', 'refreshToken', 'expiresAt', 'grantedScopes',
    'requestedCapabilities', 'capabilities', 'identity', 'displayName'], ['email'], 'oauth_stage_invalid_verified_payload');
  if (fields.provider !== provider || !safeText(fields.accessToken, MAX_TOKEN_CHARS) ||
      !safeText(fields.refreshToken, MAX_TOKEN_CHARS) || typeof fields.expiresAt !== 'number' ||
      !Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= now || !Array.isArray(fields.grantedScopes) ||
      fields.grantedScopes.length > 64 || fields.grantedScopes.some((scope) => !safeText(scope, 256)) ||
      new Set(fields.grantedScopes).size !== fields.grantedScopes.length || !safeText(fields.displayName, 256) ||
      fields.email !== undefined && !safeText(fields.email, 320)) {
    fail('oauth_stage_invalid_verified_payload', 'The verified OAuth result is invalid.');
  }
  const requestedCapabilities = normalizeCapabilities(fields.requestedCapabilities, 'oauth_stage_invalid_verified_payload');
  const capabilities = normalizeCapabilities(fields.capabilities, 'oauth_stage_invalid_verified_payload');
  if (!sameCapabilities(requestedCapabilities, requested) || capabilities.some((capability) => !requested.includes(capability))) {
    fail('oauth_stage_invalid_verified_payload', 'The verified OAuth result exceeds the requested capabilities.');
  }
  const identity = normalizeIdentity(fields.identity, provider, 'oauth_stage_invalid_verified_payload');
  const expectedIdentity = reconnectLifecycle?.identity;
  if (expectedIdentity && (identity.providerNamespace !== expectedIdentity.providerNamespace ||
      identity.clientId !== expectedIdentity.clientId || identity.subject !== expectedIdentity.subject ||
      identity.issuer !== expectedIdentity.issuer || identity.tenantId !== expectedIdentity.tenantId ||
      identity.resourceUserId !== expectedIdentity.resourceUserId)) {
    fail('oauth_stage_reconnect_identity_mismatch', 'The verified identity does not match the selected reconnect lifecycle.');
  }
  return Object.freeze({ provider, accessToken: fields.accessToken, refreshToken: fields.refreshToken, expiresAt: fields.expiresAt,
    grantedScopes: Object.freeze([...fields.grantedScopes] as string[]), requestedCapabilities, capabilities, identity,
    displayName: fields.displayName, ...(fields.email !== undefined ? { email: fields.email } : {}) });
}

function normalizeVerifiedEnvelope(value: unknown, provider: OAuthStageProvider, requested: readonly OAuthStageCapability[],
  now: number): NormalizedVerifiedEnvelope {
  const fields = closedFields(value, ['payload'], ['reconnectLifecycle'], 'oauth_stage_payload_invalid');
  const reconnectLifecycle = fields.reconnectLifecycle === undefined
    ? undefined : normalizeReconnect(fields.reconnectLifecycle, provider, 'oauth_stage_payload_invalid');
  const payload = normalizeVerifiedPayload(fields.payload, provider, requested, reconnectLifecycle, now);
  return Object.freeze({ payload, ...(reconnectLifecycle ? { reconnectLifecycle } : {}) });
}

function parsePayload(plaintext: string): unknown {
  try { return JSON.parse(plaintext) as unknown; }
  catch { return fail('oauth_stage_payload_invalid', 'The OAuth stage payload is invalid.'); }
}

/**
 * Trusted OAuth handoff storage. Provider exchange and identity verification happen elsewhere; this class only
 * serializes callback ownership, encrypted stage transitions, and safe recovery state inside owned transactions.
 */
export class OAuthInstallStages {
  readonly #db: Database.Database;

  constructor(private readonly kernel: DurableKernel, private readonly vault: SecretVault, private readonly auth: AuthService) {
    this.#db = kernel.withTrustedDatabaseTransaction((db) => { this.initialize(db); return db; });
  }

  private initialize(db: Database.Database): void {
    const exists = (name: string): boolean => Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const hasSchema = exists('oauth_install_stage_schema');
    const hasRows = exists('oauth_install_stages');
    if (!hasSchema) {
      if (hasRows) fail('oauth_stage_schema_corrupt', 'The OAuth stage schema is incomplete.');
      db.exec(`
        CREATE TABLE oauth_install_stage_schema (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version>0)
        ) STRICT;`);
      this.createStagesTable(db, 'oauth_install_stages');
      db.prepare('INSERT INTO oauth_install_stage_schema(singleton,version) VALUES(1,?)').run(SCHEMA_VERSION);
      return;
    }
    if (!hasRows) fail('oauth_stage_schema_corrupt', 'The OAuth stage schema is incomplete.');
    const marker = db.prepare('SELECT version FROM oauth_install_stage_schema WHERE singleton=1').get() as { version: number } | undefined;
    if (!marker || !Number.isSafeInteger(marker.version) || marker.version < 1) fail('oauth_stage_schema_corrupt', 'The OAuth stage schema version is invalid.');
    if (marker.version > SCHEMA_VERSION) fail('oauth_stage_newer_schema', 'This server cannot read a newer OAuth stage format.');
    if (marker.version === 1) this.migrateV1ToV2(db);
    else if (marker.version !== SCHEMA_VERSION) fail('oauth_stage_migration_required', 'No OAuth stage schema migration is available.');
  }

  private createStagesTable(db: Database.Database, tableName: string): void {
    if (tableName !== 'oauth_install_stages' && tableName !== 'oauth_install_stages_v2') {
      fail('oauth_stage_schema_corrupt', 'The OAuth stage table name is invalid.');
    }
    db.exec(`CREATE TABLE ${tableName} (
      stage_id TEXT PRIMARY KEY CHECK(length(stage_id)=36),
      owner_id TEXT NOT NULL CHECK(length(owner_id)=36),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
      initiating_session_binding TEXT NOT NULL CHECK(length(initiating_session_binding)=64),
      registration_id TEXT NOT NULL CHECK(length(registration_id) BETWEEN 1 AND 128),
      provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
      created_at INTEGER NOT NULL CHECK(created_at>=0),
      expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
      state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash)=64),
      cookie_hash TEXT NOT NULL CHECK(length(cookie_hash)=64),
      claim_hash TEXT CHECK(claim_hash IS NULL OR length(claim_hash)=64),
      payload_generation INTEGER NOT NULL CHECK(payload_generation>0),
      payload_kind TEXT NOT NULL CHECK(payload_kind IN ('authorization','verified')),
      status TEXT NOT NULL CHECK(status IN ('authorization_pending','exchange_claimed','verified','denied','inspect_required','expired','consumed')),
      nonce BLOB, tag BLOB, ciphertext BLOB,
      consumed_command_id TEXT CHECK(consumed_command_id IS NULL OR length(consumed_command_id)=36),
      consumed_account_id TEXT CHECK(consumed_account_id IS NULL OR length(CAST(consumed_account_id AS BLOB)) BETWEEN 1 AND 1024),
      consumed_account_generation INTEGER CHECK(consumed_account_generation IS NULL OR consumed_account_generation>0),
      CHECK((nonce IS NULL AND tag IS NULL AND ciphertext IS NULL) OR
            (length(nonce)=12 AND length(tag)=16 AND length(ciphertext) BETWEEN 1 AND ${MAX_STAGE_PAYLOAD_BYTES})),
      CHECK((status IN ('authorization_pending','exchange_claimed','verified') AND ciphertext IS NOT NULL) OR
            (status IN ('denied','inspect_required','expired','consumed') AND ciphertext IS NULL)),
      CHECK((status='exchange_claimed' AND claim_hash IS NOT NULL) OR (status!='exchange_claimed' AND claim_hash IS NULL)),
      CHECK((status='consumed' AND payload_kind='verified' AND consumed_command_id IS NOT NULL AND consumed_account_id IS NOT NULL AND consumed_account_generation IS NOT NULL) OR
            (status!='consumed' AND consumed_command_id IS NULL AND consumed_account_id IS NULL AND consumed_account_generation IS NULL))
    ) STRICT;`);
    if (tableName === 'oauth_install_stages') {
      db.exec('CREATE INDEX oauth_install_stages_owner_idx ON oauth_install_stages(owner_id,workspace_id,privacy_epoch,created_at);');
    }
  }

  private migrateV1ToV2(db: Database.Database): void {
    this.createStagesTable(db, 'oauth_install_stages_v2');
    db.exec(`INSERT INTO oauth_install_stages_v2 (stage_id,owner_id,workspace_id,privacy_epoch,initiating_session_binding,
      registration_id,provider,created_at,expires_at,state_hash,cookie_hash,claim_hash,payload_generation,payload_kind,status,nonce,tag,ciphertext,
      consumed_command_id,consumed_account_id,consumed_account_generation)
      SELECT stage_id,owner_id,workspace_id,privacy_epoch,initiating_session_binding,registration_id,provider,created_at,expires_at,state_hash,cookie_hash,
      claim_hash,payload_generation,payload_kind,status,nonce,tag,ciphertext,NULL,NULL,NULL FROM oauth_install_stages;
      DROP TABLE oauth_install_stages;
      ALTER TABLE oauth_install_stages_v2 RENAME TO oauth_install_stages;
      CREATE INDEX oauth_install_stages_owner_idx ON oauth_install_stages(owner_id,workspace_id,privacy_epoch,created_at);`);
    db.prepare('UPDATE oauth_install_stage_schema SET version=? WHERE singleton=1').run(SCHEMA_VERSION);
  }

  private assertContext(context: OwnedTransactionContext): void {
    if (!context || context.db !== this.#db || !UUID_V4.test(context.workspaceId) || !UUID_V4.test(context.ownerId) ||
        !Number.isSafeInteger(context.privacyEpoch) || context.privacyEpoch < 0 || typeof context.assertActive !== 'function') {
      fail('oauth_stage_invalid_context', 'A current owned transaction context is required.');
    }
    context.assertActive();
    const workspace = context.db.prepare('SELECT owner_id,privacy_epoch FROM workspaces WHERE id=?').get(context.workspaceId) as
      { owner_id: string; privacy_epoch: number } | undefined;
    if (!workspace || workspace.owner_id !== context.ownerId || workspace.privacy_epoch !== context.privacyEpoch) {
      fail('oauth_stage_invalid_context', 'A current owned transaction context is required.');
    }
  }

  private status(row: StageRow): OAuthInstallStageStatus {
    return Object.freeze({ attemptId: row.stage_id, registrationId: row.registration_id, provider: row.provider,
      status: row.status, payloadGeneration: row.payload_generation, createdAt: row.created_at, expiresAt: row.expires_at,
      ...(row.status === 'consumed' && row.consumed_command_id && row.consumed_account_id && row.consumed_account_generation !== null
        ? { consumption: Object.freeze({ commandId: row.consumed_command_id, accountId: row.consumed_account_id,
            accountGeneration: row.consumed_account_generation }) } : {}) });
  }

  private binding(row: StageRow, payloadKind: OAuthStageBinding['payloadKind'], payloadGeneration: number): OAuthStageBinding {
    return Object.freeze({ stageId: row.stage_id, initiatingSessionBinding: row.initiating_session_binding,
      registrationId: row.registration_id, provider: row.provider, expiresAt: row.expires_at, payloadKind, payloadGeneration });
  }

  private findStage(context: OwnedTransactionContext, attemptId: string): StageRow | undefined {
    return context.db.prepare('SELECT * FROM oauth_install_stages WHERE stage_id=? AND owner_id=? AND workspace_id=? AND privacy_epoch=?')
      .get(attemptId, context.ownerId, context.workspaceId, context.privacyEpoch) as StageRow | undefined;
  }

  private clearPayload(context: OwnedTransactionContext, row: StageRow, status: OAuthInstallStageState): OAuthInstallStageStatus {
    context.db.prepare(`UPDATE oauth_install_stages SET status=?,claim_hash=NULL,nonce=NULL,tag=NULL,ciphertext=NULL
      WHERE stage_id=? AND owner_id=? AND workspace_id=? AND privacy_epoch=?`)
      .run(status, row.stage_id, context.ownerId, context.workspaceId, context.privacyEpoch);
    return this.status({ ...row, status, claim_hash: null, nonce: null, tag: null, ciphertext: null });
  }

  private expired(context: OwnedTransactionContext, row: StageRow): boolean {
    return context.now >= row.expires_at && ['authorization_pending', 'exchange_claimed', 'verified'].includes(row.status);
  }

  private liveInitiator(context: OwnedTransactionContext, row: StageRow): boolean {
    try { this.auth.assertInitiatingSessionWithinTransaction(context, row.initiating_session_binding); return true; }
    catch (error) {
      if (error instanceof AuthError && error.code === 'initiating_session_inactive') return false;
      throw error;
    }
  }

  private cleanupDiscoveredState(context: OwnedTransactionContext, row: StageRow): OAuthInstallStageStatus | undefined {
    if (!['authorization_pending', 'exchange_claimed', 'verified'].includes(row.status)) return undefined;
    if (this.expired(context, row)) return this.clearPayload(context, row, 'expired');
    if (!this.liveInitiator(context, row)) return this.clearPayload(context, row, 'inspect_required');
    return undefined;
  }

  private payloadCiphertext(value: unknown): StageCiphertext {
    if (!value || typeof value !== 'object') fail('oauth_stage_payload_invalid', 'The OAuth stage payload is invalid.');
    const candidate = value as Partial<StageCiphertext>;
    if (candidate.format !== 1 || !Buffer.isBuffer(candidate.nonce) || !Buffer.isBuffer(candidate.tag) || !Buffer.isBuffer(candidate.ciphertext)) {
      fail('oauth_stage_payload_invalid', 'The OAuth stage payload is invalid.');
    }
    return { format: 1, nonce: candidate.nonce, tag: candidate.tag, ciphertext: candidate.ciphertext };
  }

  private openPayload(context: OwnedTransactionContext, row: StageRow, payloadKind: OAuthStageBinding['payloadKind']): string {
    if (!row.nonce || !row.tag || !row.ciphertext || row.payload_kind !== payloadKind) {
      fail('oauth_stage_payload_invalid', 'The OAuth stage payload is unavailable.');
    }
    return this.vault.openOAuthStageWithinTransaction(context, this.binding(row, payloadKind, row.payload_generation),
      { format: 1, nonce: row.nonce, tag: row.tag, ciphertext: row.ciphertext });
  }

  private sealPayload(context: OwnedTransactionContext, row: StageRow, payloadKind: OAuthStageBinding['payloadKind'],
    payloadGeneration: number, plaintext: string): StageCiphertext {
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_STAGE_PAYLOAD_BYTES) fail('oauth_stage_payload_too_large', 'The OAuth stage payload is too large.');
    return this.vault.sealOAuthStageWithinTransaction(context, this.binding(row, payloadKind, payloadGeneration), plaintext);
  }

  private findCallbackStage(context: OwnedTransactionContext, proof: OAuthCallbackProof): StageRow {
    const row = context.db.prepare('SELECT * FROM oauth_install_stages WHERE state_hash=?').get(sha256(proof.state)) as StageRow | undefined;
    if (!row || row.owner_id !== context.ownerId || row.workspace_id !== context.workspaceId || row.privacy_epoch !== context.privacyEpoch ||
        !constantTimeHashEqual(row.state_hash, sha256(proof.state)) || !constantTimeHashEqual(row.cookie_hash, sha256(proof.cookieBinding))) {
      fail('oauth_stage_proof_invalid', 'The OAuth callback proof is invalid.');
    }
    return row;
  }

  /**
   * Resolves only the workspace identity proved by both callback secrets. This does not claim an exchange;
   * claimExchange still rechecks the original live session and stage status in an owned transaction.
   */
  resolveCallbackIdentity(provider: OAuthStageProvider, proofValue: OAuthCallbackProof): OAuthCallbackWorkspaceIdentity {
    if (provider !== 'google' && provider !== 'microsoft') fail('oauth_stage_proof_invalid', 'The OAuth callback proof is invalid.');
    const proof = normalizeCallbackProof(proofValue);
    return this.kernel.withTrustedDatabaseTransaction((db) => {
      const row = db.prepare(`SELECT s.stage_id,s.owner_id,s.workspace_id,s.privacy_epoch,s.initiating_session_binding,
        s.registration_id,s.provider,s.expires_at,s.state_hash,s.cookie_hash,w.revision,w.owner_id AS current_owner_id,w.privacy_epoch AS current_privacy_epoch
        FROM oauth_install_stages s JOIN workspaces w ON w.id=s.workspace_id WHERE s.state_hash=?`)
        .get(sha256(proof.state)) as (StageRow & { revision: number; current_owner_id: string; current_privacy_epoch: number }) | undefined;
      if (!row || row.provider !== provider || row.owner_id !== row.current_owner_id || row.privacy_epoch !== row.current_privacy_epoch ||
          !constantTimeHashEqual(row.state_hash, sha256(proof.state)) || !constantTimeHashEqual(row.cookie_hash, sha256(proof.cookieBinding))) {
        fail('oauth_stage_proof_invalid', 'The OAuth callback proof is invalid.');
      }
      return Object.freeze({ attemptId: row.stage_id, registrationId: row.registration_id, provider: row.provider,
        workspaceId: row.workspace_id, ownerId: row.owner_id, revision: row.revision, privacyEpoch: row.privacy_epoch,
        expiresAt: row.expires_at });
    });
  }

  /** Marks only an unclaimed authorization pending stage unavailable before an explicit replacement start. */
  supersedeAuthorizationWithinTransaction(context: OwnedTransactionContext, attemptId: string, sessionHash: string): OAuthInstallStageStatus {
    this.assertContext(context);
    const row = this.findStage(context, attemptId);
    if (!row || !constantTimeHashEqual(row.initiating_session_binding, sessionHash)) {
      fail('oauth_stage_not_found', 'The OAuth stage is unavailable.');
    }
    const terminal = this.cleanupDiscoveredState(context, row);
    if (terminal) return terminal;
    if (row.status !== 'authorization_pending') return this.status(row);
    this.auth.assertInitiatingSessionWithinTransaction(context, sessionHash);
    return this.clearPayload(context, row, 'inspect_required');
  }

  private findClaim(context: OwnedTransactionContext, claimInput: OAuthExchangeClaim): { row: StageRow; claim: OAuthExchangeClaim } {
    const fields = closedFields(claimInput, ['attemptId', 'claimToken', 'payloadGeneration', 'registrationId', 'provider', 'expiresAt'], [],
      'oauth_stage_invalid_claim');
    if (typeof fields.attemptId !== 'string' || !UUID_V4.test(fields.attemptId) || typeof fields.claimToken !== 'string' ||
        !TOKEN_PATTERN.test(fields.claimToken) || typeof fields.payloadGeneration !== 'number' || !Number.isSafeInteger(fields.payloadGeneration) ||
        fields.payloadGeneration < 1 || typeof fields.registrationId !== 'string' || !REGISTRATION_PATTERN.test(fields.registrationId) ||
        (fields.provider !== 'google' && fields.provider !== 'microsoft') || typeof fields.expiresAt !== 'number' ||
        !Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= 0) fail('oauth_stage_invalid_claim', 'The OAuth exchange claim is invalid.');
    const claim = fields as unknown as OAuthExchangeClaim;
    const row = this.findStage(context, claim.attemptId);
    if (!row || row.status !== 'exchange_claimed' || row.payload_kind !== 'authorization' || row.payload_generation !== claim.payloadGeneration ||
        row.registration_id !== claim.registrationId || row.provider !== claim.provider || row.expires_at !== claim.expiresAt ||
        !row.claim_hash || !constantTimeHashEqual(row.claim_hash, sha256(claim.claimToken))) {
      fail('oauth_stage_claim_invalid', 'The OAuth exchange claim is no longer active.');
    }
    return { row, claim };
  }

  /** Rechecks claim, original session, owner/workspace epoch, and TTL before each external provider request. */
  assertExchangeClaimCurrent(context: OwnedTransactionContext, claimInput: OAuthExchangeClaim): void {
    this.assertContext(context);
    const { row } = this.findClaim(context, claimInput);
    if (this.claimTerminal(context, row)) fail('oauth_stage_claim_invalid', 'The OAuth exchange claim is no longer active.');
    this.auth.assertInitiatingSessionWithinTransaction(context, row.initiating_session_binding);
  }

  private claimTerminal(context: OwnedTransactionContext, row: StageRow): OAuthInstallStageStatus | undefined {
    return this.cleanupDiscoveredState(context, row);
  }

  /** Starts a ten-minute authorization stage using fixed trusted registration data and server-generated proofs. */
  createAuthorization(context: OwnedTransactionContext, inputValue: CreateOAuthAuthorizationInput): OAuthAuthorizationStartResult {
    this.assertContext(context);
    const input = normalizeAuthorizationInput(inputValue);
    const initiatingSessionBinding = this.auth.bindInitiatingSessionWithinTransaction(context, input.initiatingSessionToken);
    const createdAt = context.now;
    const expiresAt = createdAt + STAGE_TTL_MS;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt) fail('oauth_stage_clock_invalid', 'The OAuth stage expiry is invalid.');
    const attemptId = randomUUID();
    const state = randomBytes(32).toString('base64url');
    const cookieBinding = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const pkceVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(pkceVerifier, 'utf8').digest('base64url');
    const row: StageRow = { stage_id: attemptId, owner_id: context.ownerId, workspace_id: context.workspaceId,
      privacy_epoch: context.privacyEpoch, initiating_session_binding: initiatingSessionBinding, registration_id: input.registrationId,
      provider: input.provider, created_at: createdAt, expires_at: expiresAt, state_hash: sha256(state), cookie_hash: sha256(cookieBinding),
      claim_hash: null, payload_generation: 1, payload_kind: 'authorization', status: 'authorization_pending', nonce: null, tag: null,
      ciphertext: null, consumed_command_id: null, consumed_account_id: null, consumed_account_generation: null };
    const payload: NormalizedAuthorizationPayload = Object.freeze({ pkceVerifier, nonce,
      requestedCapabilities: input.requestedCapabilities,
      ...(input.reconnectLifecycle ? { reconnectLifecycle: input.reconnectLifecycle } : {}) });
    const ciphertext = this.sealPayload(context, row, 'authorization', 1, JSON.stringify(payload));
    context.db.prepare(`INSERT INTO oauth_install_stages(stage_id,owner_id,workspace_id,privacy_epoch,initiating_session_binding,
      registration_id,provider,created_at,expires_at,state_hash,cookie_hash,claim_hash,payload_generation,payload_kind,status,nonce,tag,ciphertext)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.stage_id, row.owner_id, row.workspace_id, row.privacy_epoch,
        row.initiating_session_binding, row.registration_id, row.provider, row.created_at, row.expires_at, row.state_hash, row.cookie_hash,
        null, row.payload_generation, row.payload_kind, row.status, ciphertext.nonce, ciphertext.tag, ciphertext.ciphertext);
    return Object.freeze({ authorization: Object.freeze({ state, cookieBinding, nonce, codeChallenge }), status: this.status(row) });
  }

  /** Claims a callback once; duplicates receive only a safe status and never receive verifier or claim material. */
  claimExchange(context: OwnedTransactionContext, proofValue: OAuthCallbackProof): OAuthExchangeClaimResult {
    this.assertContext(context);
    const proof = normalizeCallbackProof(proofValue);
    const row = this.findCallbackStage(context, proof);
    const terminal = this.claimTerminal(context, row);
    if (terminal) return Object.freeze({ claimed: false, status: terminal });
    if (row.status !== 'authorization_pending') return Object.freeze({ claimed: false, status: this.status(row) });
    let authorization: NormalizedAuthorizationPayload;
    try { authorization = normalizeAuthorizationPayload(parsePayload(this.openPayload(context, row, 'authorization')), row.provider); }
    catch {
      return Object.freeze({ claimed: false, status: this.clearPayload(context, row, 'inspect_required') });
    }
    const claimToken = randomBytes(32).toString('base64url');
    const changed = context.db.prepare(`UPDATE oauth_install_stages SET status='exchange_claimed',claim_hash=?
      WHERE stage_id=? AND owner_id=? AND workspace_id=? AND privacy_epoch=? AND status='authorization_pending'`)
      .run(sha256(claimToken), row.stage_id, context.ownerId, context.workspaceId, context.privacyEpoch).changes;
    if (changed !== 1) {
      const latest = this.findStage(context, row.stage_id);
      return Object.freeze({ claimed: false, status: this.status(latest ?? row) });
    }
    const claim: OAuthExchangeClaim = Object.freeze({ attemptId: row.stage_id, claimToken, payloadGeneration: row.payload_generation,
      registrationId: row.registration_id, provider: row.provider, expiresAt: row.expires_at });
    return Object.freeze({ claimed: true, claim, authorization, status: this.status({ ...row, status: 'exchange_claimed', claim_hash: sha256(claimToken) }) });
  }

  /** Stores provider-adapter-verified identity and credentials. This method does not itself verify any provider response. */
  completeVerified(context: OwnedTransactionContext, claimInput: OAuthExchangeClaim,
    verifiedPayloadValue: OAuthVerifiedPayload): OAuthInstallStageStatus {
    this.assertContext(context);
    const { row } = this.findClaim(context, claimInput);
    const discovered = this.claimTerminal(context, row);
    if (discovered) return discovered;
    let authorization: NormalizedAuthorizationPayload;
    try { authorization = normalizeAuthorizationPayload(parsePayload(this.openPayload(context, row, 'authorization')), row.provider); }
    catch { return this.clearPayload(context, row, 'inspect_required'); }
    const verified = normalizeVerifiedPayload(verifiedPayloadValue, row.provider, authorization.requestedCapabilities,
      authorization.reconnectLifecycle, context.now);
    const nextGeneration = row.payload_generation + 1;
    if (!Number.isSafeInteger(nextGeneration)) fail('oauth_stage_generation_overflow', 'The OAuth stage generation cannot advance.');
    const nextRow: StageRow = { ...row, payload_generation: nextGeneration, payload_kind: 'verified' };
    const envelope: NormalizedVerifiedEnvelope = Object.freeze({ payload: verified,
      ...(authorization.reconnectLifecycle ? { reconnectLifecycle: authorization.reconnectLifecycle } : {}) });
    const encrypted = this.sealPayload(context, nextRow, 'verified', nextGeneration, JSON.stringify(envelope));
    const changed = context.db.prepare(`UPDATE oauth_install_stages SET status='verified',claim_hash=NULL,payload_generation=?,payload_kind='verified',
      nonce=?,tag=?,ciphertext=? WHERE stage_id=? AND owner_id=? AND workspace_id=? AND privacy_epoch=? AND status='exchange_claimed'
      AND claim_hash=? AND payload_generation=?`)
      .run(nextGeneration, encrypted.nonce, encrypted.tag, encrypted.ciphertext, row.stage_id, context.ownerId, context.workspaceId,
        context.privacyEpoch, row.claim_hash, row.payload_generation).changes;
    if (changed !== 1) fail('oauth_stage_claim_invalid', 'The OAuth exchange claim is no longer active.');
    return this.status({ ...nextRow, status: 'verified', claim_hash: null, nonce: encrypted.nonce, tag: encrypted.tag, ciphertext: encrypted.ciphertext });
  }

  /** Marks a provider denial terminal and clears its encrypted authorization payload. */
  completeDenied(context: OwnedTransactionContext, proofValue: OAuthCallbackProof): OAuthInstallStageStatus {
    this.assertContext(context);
    const proof = normalizeCallbackProof(proofValue);
    const row = this.findCallbackStage(context, proof);
    const terminal = this.claimTerminal(context, row);
    if (terminal) return terminal;
    if (row.status !== 'authorization_pending') return this.status(row);
    return this.clearPayload(context, row, 'denied');
  }

  /** Records an exchange whose network outcome is uncertain; never automatically retries provider exchange. */
  markExchangeUnknown(context: OwnedTransactionContext, claimInput: OAuthExchangeClaim): OAuthInstallStageStatus {
    this.assertContext(context);
    const { row } = this.findClaim(context, claimInput);
    const terminal = this.claimTerminal(context, row);
    return terminal ?? this.clearPayload(context, row, 'inspect_required');
  }

  /** Safe status-only fallback after an already-owned callback claim became terminal during provider I/O. */
  readExchangeClaimStatus(context: OwnedTransactionContext, claimInput: OAuthExchangeClaim): OAuthInstallStageStatus {
    this.assertContext(context);
    const fields = closedFields(claimInput, ['attemptId', 'claimToken', 'payloadGeneration', 'registrationId', 'provider', 'expiresAt'], [],
      'oauth_stage_invalid_claim');
    if (typeof fields.attemptId !== 'string' || !UUID_V4.test(fields.attemptId) || typeof fields.claimToken !== 'string' ||
        !TOKEN_PATTERN.test(fields.claimToken) || typeof fields.payloadGeneration !== 'number' || !Number.isSafeInteger(fields.payloadGeneration) ||
        fields.payloadGeneration < 1 || typeof fields.registrationId !== 'string' || !REGISTRATION_PATTERN.test(fields.registrationId) ||
        (fields.provider !== 'google' && fields.provider !== 'microsoft') || typeof fields.expiresAt !== 'number' ||
        !Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= 0) fail('oauth_stage_invalid_claim', 'The OAuth exchange claim is invalid.');
    const claim = fields as unknown as OAuthExchangeClaim;
    const row = this.findStage(context, claim.attemptId);
    if (!row || row.registration_id !== claim.registrationId || row.provider !== claim.provider || row.expires_at !== claim.expiresAt ||
        row.payload_generation < claim.payloadGeneration || row.payload_generation > claim.payloadGeneration + 1) {
      fail('oauth_stage_claim_invalid', 'The OAuth exchange claim is no longer active.');
    }
    return this.cleanupDiscoveredState(context, row) ?? this.status(row);
  }

  /** Returns metadata only. If expiry or initiating-session revocation is discovered, it is persisted as a safe terminal state. */
  readStatus(context: OwnedTransactionContext, attemptId: string, sessionHash: string): OAuthInstallStageStatus {
    this.assertContext(context);
    if (typeof attemptId !== 'string' || !UUID_V4.test(attemptId) || typeof sessionHash !== 'string' || !HASH_PATTERN.test(sessionHash)) {
      fail('oauth_stage_not_found', 'The OAuth stage is unavailable.');
    }
    const row = this.findStage(context, attemptId);
    if (!row || !constantTimeHashEqual(row.initiating_session_binding, sessionHash)) fail('oauth_stage_not_found', 'The OAuth stage is unavailable.');
    return this.cleanupDiscoveredState(context, row) ?? this.status(row);
  }

  /** Returns decrypted token material only to the same live initiating session and only from a verified stage. */
  readVerifiedForInstall(context: OwnedTransactionContext, attemptId: string, sessionHash: string): OAuthVerifiedReadResult {
    const status = this.readStatus(context, attemptId, sessionHash);
    if (status.status !== 'verified') return Object.freeze({ status });
    const row = this.findStage(context, attemptId);
    if (!row || row.status !== 'verified') return Object.freeze({ status: row ? this.status(row) : status });
    try {
      const decoded = closedFields(parsePayload(this.openPayload(context, row, 'verified')), ['payload'], ['reconnectLifecycle'], 'oauth_stage_payload_invalid');
      const payloadFields = closedFields(decoded.payload, ['provider', 'accessToken', 'refreshToken', 'expiresAt', 'grantedScopes',
        'requestedCapabilities', 'capabilities', 'identity', 'displayName'], ['email'], 'oauth_stage_payload_invalid');
      const requested = normalizeCapabilities(payloadFields.requestedCapabilities, 'oauth_stage_payload_invalid');
      const envelope = normalizeVerifiedEnvelope(decoded, row.provider, requested, context.now);
      return Object.freeze({ status, payload: envelope.payload,
        ...(envelope.reconnectLifecycle ? { reconnectLifecycle: envelope.reconnectLifecycle } : {}) });
    } catch {
      return Object.freeze({ status: this.clearPayload(context, row, 'inspect_required') });
    }
  }

  /** Deletes all stage data for this owned workspace as part of a caller-composed privacy transaction. */
  eraseWorkspaceWithinTransaction(context: OwnedTransactionContext): number {
    this.assertContext(context);
    return context.db.prepare('DELETE FROM oauth_install_stages WHERE owner_id=? AND workspace_id=?')
      .run(context.ownerId, context.workspaceId).changes;
  }

  /** Explicit trusted startup recovery; constructor initialization intentionally never invokes this reconciliation. */
  reconcileInterruptedExchanges(): number {
    return this.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`UPDATE oauth_install_stages SET status='inspect_required',
      claim_hash=NULL,nonce=NULL,tag=NULL,ciphertext=NULL WHERE status='exchange_claimed'`).run().changes);
  }
}
