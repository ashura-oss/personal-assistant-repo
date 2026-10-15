import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from './config.js';
import type { AuthService } from './auth.js';
import type { DurableKernel, OwnedWorkspaceIdentity } from './kernel.js';
import type { RuntimeSessionResolver } from './workspaceRegistry.js';
import type { OAuthHttpApi, OAuthAttemptMetadata, OAuthCallbackInput, OAuthStageInspection, OAuthStartRequest, OAuthStartResult } from './oauthHttp.js';
import { isValidAccountId } from './accountIds.js';
import { OAuthInstallStages, type OAuthInstallStageStatus, type OAuthReconnectLifecycle, type OAuthStageCapability, type OAuthStageProvider } from './oauthInstallStages.js';
import type { ServerOAuthProviderAdapter } from './oauthProviderAdapter.js';
import { OAuthProviderAdapterError } from './oauthProviderAdapter.js';

const CAPABILITIES: readonly OAuthStageCapability[] = ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const MAX_ATTEMPTS = 32;
const TTL_SECONDS = 10 * 60;

interface StartRow {
  start_attempt_id: string;
  stage_id: string;
  owner_id: string;
  workspace_id: string;
  privacy_epoch: number;
  session_binding: string;
  provider: OAuthStageProvider;
  request_digest: string;
  builder_state: 'building' | 'ready' | 'restart_required';
  disposition: 'active' | 'superseded';
  created_at: number;
  expires_at: number;
}

export class OAuthConnectionServiceError extends Error {
  constructor(readonly code: 'oauth_unavailable' | 'oauth_invalid_input' | 'oauth_conflict' | 'oauth_stale_workspace' |
    'oauth_start_in_progress' | 'oauth_start_not_admitted' | 'oauth_original_session_inactive' | 'oauth_not_found' | 'oauth_provider_failed' |
    'oauth_callback_invalid' | 'oauth_exchange_unknown' | 'oauth_service_closing' | 'oauth_workspace_erasing') {
    super(code);
    this.name = 'OAuthConnectionServiceError';
  }
}

function fail(code: ConstructorParameters<typeof OAuthConnectionServiceError>[0]): never { throw new OAuthConnectionServiceError(code); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function sameHash(left: string, right: string): boolean {
  return HASH.test(left) && HASH.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function objectFields(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('oauth_invalid_input');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('oauth_invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((key) => !keys.includes(key))) fail('oauth_invalid_input');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') fail('oauth_invalid_input');
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('oauth_invalid_input');
    result[key] = descriptor.value;
  }
  return result;
}

function normalizeStart(value: unknown): OAuthStartRequest {
  const fields = objectFields(value, ['startAttemptId', 'requestedCapabilities', 'expectedRevision', 'expectedPrivacyEpoch'],
    ['reconnectAccountId', 'restartOfStartAttemptId']);
  if (typeof fields.startAttemptId !== 'string' || !UUID_V4.test(fields.startAttemptId) ||
      !Array.isArray(fields.requestedCapabilities) || fields.requestedCapabilities.length > CAPABILITIES.length ||
      fields.requestedCapabilities.some((item) => typeof item !== 'string' || !CAPABILITIES.includes(item as OAuthStageCapability)) ||
      new Set(fields.requestedCapabilities).size !== fields.requestedCapabilities.length ||
      fields.requestedCapabilities.includes('calendar.write') && !fields.requestedCapabilities.includes('calendar.read') ||
      typeof fields.expectedRevision !== 'number' || !Number.isSafeInteger(fields.expectedRevision) || fields.expectedRevision < 0 ||
      typeof fields.expectedPrivacyEpoch !== 'number' || !Number.isSafeInteger(fields.expectedPrivacyEpoch) || fields.expectedPrivacyEpoch < 0 ||
      fields.reconnectAccountId !== undefined && !isValidAccountId(fields.reconnectAccountId) ||
      fields.restartOfStartAttemptId !== undefined && (typeof fields.restartOfStartAttemptId !== 'string' || !UUID_V4.test(fields.restartOfStartAttemptId))) fail('oauth_invalid_input');
  return Object.freeze({ startAttemptId: fields.startAttemptId, requestedCapabilities: Object.freeze([...fields.requestedCapabilities] as OAuthStageCapability[]),
    expectedRevision: fields.expectedRevision, expectedPrivacyEpoch: fields.expectedPrivacyEpoch,
    ...(fields.reconnectAccountId !== undefined ? { reconnectAccountId: fields.reconnectAccountId } : {}),
    ...(fields.restartOfStartAttemptId !== undefined ? { restartOfStartAttemptId: fields.restartOfStartAttemptId } : {}) });
}

function digestRequest(value: OAuthStartRequest): string {
  return sha256(JSON.stringify({ startAttemptId: value.startAttemptId, requestedCapabilities: [...value.requestedCapabilities].sort(),
    expectedRevision: value.expectedRevision, expectedPrivacyEpoch: value.expectedPrivacyEpoch,
    ...(value.reconnectAccountId ? { reconnectAccountId: value.reconnectAccountId } : {}),
    ...(value.restartOfStartAttemptId ? { restartOfStartAttemptId: value.restartOfStartAttemptId } : {}) }));
}

function cookieName(provider: OAuthStageProvider, attemptId: string): string { return `__Host-still_oauth_${provider}_${attemptId}`; }
function providerFrom(value: unknown): value is OAuthStageProvider { return value === 'google' || value === 'microsoft'; }

function reconnectFromSnapshot(snapshotJson: string, accountId: string, provider: OAuthStageProvider): OAuthReconnectLifecycle {
  let snapshot: unknown;
  try { snapshot = JSON.parse(snapshotJson); } catch { return fail('oauth_conflict'); }
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot) || !Array.isArray((snapshot as { accounts?: unknown }).accounts)) {
    return fail('oauth_conflict');
  }
  const accounts = (snapshot as { accounts: unknown[] }).accounts;
  const account = accounts.find((item) => typeof item === 'object' && item !== null && !Array.isArray(item) &&
    (item as { id?: unknown }).id === accountId) as Record<string, unknown> | undefined;
  if (!account || account.provider !== provider || !isValidAccountId(accountId) ||
      typeof account.connectionGeneration !== 'number' || !Number.isSafeInteger(account.connectionGeneration) || account.connectionGeneration < 0 ||
      typeof account.connected !== 'boolean' || !['configured', 'connected', 'reauth_required', 'revoked'].includes(account.authStatus as string)) {
    return fail('oauth_conflict');
  }
  const identity = account.identity;
  if (identity !== undefined && (typeof identity !== 'object' || identity === null || Array.isArray(identity) ||
      typeof (identity as { subject?: unknown }).subject !== 'string')) return fail('oauth_conflict');
  const id = identity as Record<string, unknown> | undefined;
  return Object.freeze({ accountId, connectionGeneration: account.connectionGeneration,
    ...(typeof account.tokenRef === 'string' ? { tokenRef: account.tokenRef } : {}), connected: account.connected,
    authStatus: account.authStatus as OAuthReconnectLifecycle['authStatus'],
    ...(id ? { identity: Object.freeze({ subject: id.subject as string,
      ...(id.providerNamespace === undefined ? {} : { providerNamespace: id.providerNamespace as OAuthStageProvider }),
      ...(typeof id.clientId === 'string' ? { clientId: id.clientId } : {}), ...(typeof id.issuer === 'string' ? { issuer: id.issuer } : {}),
      ...(typeof id.tenantId === 'string' ? { tenantId: id.tenantId } : {}), ...(typeof id.resourceUserId === 'string' ? { resourceUserId: id.resourceUserId } : {}) }) } : {}) });
}

export interface OAuthConnectionServiceOptions {
  readonly kernel: DurableKernel;
  readonly auth: AuthService;
  readonly stages: OAuthInstallStages;
  readonly provider: ServerOAuthProviderAdapter;
  readonly config: Pick<ServerConfig, 'googleClientId' | 'googleClientSecret' | 'microsoftClientId' | 'microsoftClientSecret' |
    'googleRedirectUri' | 'microsoftRedirectUri'>;
  readonly runtimeSessionFor: RuntimeSessionResolver;
  readonly now?: () => number;
  readonly withOperationOwnership?: <T>(provider: OAuthStageProvider, operation: () => Promise<T>) => Promise<T>;
  /** Host-private per-workspace erase hold/intent fence, including cold-start prepared plans. */
  readonly isWorkspaceEraseHeldOrPending?: (workspaceId: string, ownerId: string) => boolean;
}

/** Durable, session-bound OAuth start identity plus one-use callback exchange orchestration. */
export class OAuthConnectionService implements OAuthHttpApi {
  private accepting = true;
  private readonly active = new Set<Promise<unknown>>();
  private readonly aborters = new Set<AbortController>();
  private readonly activeBuilders = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: OAuthConnectionServiceOptions) {
    this.now = options.now ?? Date.now;
    options.kernel.withTrustedDatabaseTransaction((db) => {
      const exists = (name: string): boolean => Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
      const hasSchema = exists('oauth_connection_schema');
      const hasStarts = exists('oauth_connection_starts');
      if (!hasSchema && hasStarts) throw new Error('oauth_connection_schema_incomplete');
      if (!hasSchema) db.exec(`CREATE TABLE oauth_connection_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version>0)) STRICT;`);
      else {
        const marker = db.prepare('SELECT version FROM oauth_connection_schema WHERE singleton=1').get() as { version: number } | undefined;
        if (!marker || marker.version !== 1) throw new Error('oauth_connection_schema_unsupported');
      }
      if (!hasStarts) db.exec(`CREATE TABLE oauth_connection_starts (
        start_attempt_id TEXT PRIMARY KEY CHECK(length(start_attempt_id)=36),
        stage_id TEXT NOT NULL UNIQUE CHECK(length(stage_id)=36) REFERENCES oauth_install_stages(stage_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL CHECK(length(owner_id)=36), workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0), session_binding TEXT NOT NULL CHECK(length(session_binding)=64),
        provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')), request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        builder_state TEXT NOT NULL CHECK(builder_state IN ('building','ready','restart_required')),
        disposition TEXT NOT NULL CHECK(disposition IN ('active','superseded')),
        created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
      ) STRICT;`);
      if (!hasSchema) db.prepare('INSERT INTO oauth_connection_schema(singleton,version) VALUES(1,1)').run();
      const columns = new Set((db.prepare('PRAGMA table_info(oauth_connection_starts)').all() as { name: string }[]).map((column) => column.name));
      if (['start_attempt_id', 'stage_id', 'owner_id', 'workspace_id', 'privacy_epoch', 'session_binding', 'provider', 'request_digest',
        'builder_state', 'disposition', 'created_at', 'expires_at'].some((column) => !columns.has(column))) throw new Error('oauth_connection_schema_incomplete');
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS oauth_connection_starts_one_active ON oauth_connection_starts(session_binding,provider)
        WHERE disposition='active';
      CREATE INDEX IF NOT EXISTS oauth_connection_starts_owner_idx ON oauth_connection_starts(owner_id,workspace_id,privacy_epoch,created_at DESC);`);
    });
  }

  private registration(provider: OAuthStageProvider): { id: string; clientId: string; secret: string; redirect: string } {
    const id = provider === 'google' ? this.options.config.googleClientId : this.options.config.microsoftClientId;
    const secret = provider === 'google' ? this.options.config.googleClientSecret : this.options.config.microsoftClientSecret;
    const redirect = provider === 'google' ? this.options.config.googleRedirectUri : this.options.config.microsoftRedirectUri;
    if (!id || !secret || !redirect) fail('oauth_unavailable');
    return { id: provider, clientId: id, secret, redirect };
  }

  availability(admission: { sessionToken: string; assertCurrent: () => void }): Readonly<{ google: boolean; microsoft: boolean }> {
    this.current(admission);
    const available = (provider: OAuthStageProvider) => {
      try { this.registration(provider); return true; } catch { return false; }
    };
    admission.assertCurrent();
    return Object.freeze({ google: available('google'), microsoft: available('microsoft') });
  }

  private current(admission: { sessionToken: string; assertCurrent: () => void }): OwnedWorkspaceIdentity {
    if (!this.accepting) fail('oauth_service_closing');
    admission.assertCurrent();
    const before = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    admission.assertCurrent();
    const after = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (before.workspaceId !== after.workspaceId || before.ownerId !== after.ownerId || before.privacyEpoch !== after.privacyEpoch) fail('oauth_stale_workspace');
    this.assertWorkspaceAvailable(after);
    return after;
  }

  private assertWorkspaceAvailable(identity: Pick<OwnedWorkspaceIdentity, 'workspaceId' | 'ownerId'>): void {
    if (this.options.isWorkspaceEraseHeldOrPending?.(identity.workspaceId, identity.ownerId)) fail('oauth_workspace_erasing');
  }

  private track<T>(provider: OAuthStageProvider, operation: () => Promise<T>): Promise<T> {
    const promise = this.options.withOperationOwnership ? this.options.withOperationOwnership(provider, operation) : operation();
    this.active.add(promise);
    void promise.then(() => this.active.delete(promise), () => this.active.delete(promise));
    return promise;
  }

  start(admission: { sessionToken: string; assertCurrent: () => void }, provider: OAuthStageProvider, inputValue: unknown): Promise<OAuthStartResult> {
    return this.track(provider, () => this.startOwned(admission, provider, inputValue));
  }

  /** All synchronous admission work happens in one transaction before a stage is committed. */
  private prepareStart(admission: { sessionToken: string; assertCurrent: () => void }, provider: OAuthStageProvider,
    inputValue: unknown) {
    let existingStartAttemptId = false;
    let startAttemptId: string | undefined;
    try {
      if (typeof inputValue === 'object' && inputValue !== null && !Array.isArray(inputValue)) {
        const descriptor = Object.getOwnPropertyDescriptor(inputValue, 'startAttemptId');
        if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && UUID_V4.test(descriptor.value)) {
          startAttemptId = descriptor.value;
        }
      }
    } catch { /* Invalid objects are rejected by normalizeStart below. */ }
    try {
      if (!providerFrom(provider)) fail('oauth_invalid_input');
      const input = normalizeStart(inputValue);
      startAttemptId = input.startAttemptId;
      const registration = this.registration(provider);
      const identity = this.current(admission);
      const sessionBinding = sha256(admission.sessionToken);
      const requestDigest = digestRequest(input);
      const prepared = this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
        const prior = context.db.prepare('SELECT * FROM oauth_connection_starts WHERE start_attempt_id=?')
          .get(input.startAttemptId) as StartRow | undefined;
        if (prior) {
          existingStartAttemptId = true;
          if (prior.provider !== provider || prior.owner_id !== context.ownerId || prior.workspace_id !== context.workspaceId ||
              prior.privacy_epoch !== context.privacyEpoch || !sameHash(prior.request_digest, requestDigest) ||
              !sameHash(prior.session_binding, sessionBinding)) fail('oauth_conflict');
          return { existing: true as const, row: prior, status: this.options.stages.readStatus(context, prior.stage_id, sessionBinding), clearCookieNames: [] as string[] };
        }
        if (context.revision !== input.expectedRevision || context.privacyEpoch !== input.expectedPrivacyEpoch) fail('oauth_stale_workspace');
        const previous = context.db.prepare(`SELECT * FROM oauth_connection_starts WHERE session_binding=? AND provider=? AND disposition='active'`)
          .get(sessionBinding, provider) as StartRow | undefined;
        const clearCookieNames: string[] = [];
        if (previous) {
          if (input.restartOfStartAttemptId !== undefined && input.restartOfStartAttemptId !== previous.start_attempt_id) fail('oauth_conflict');
          const priorStatus = this.options.stages.readStatus(context, previous.stage_id, sessionBinding);
          if (previous.builder_state === 'building' && (this.activeBuilders.has(previous.start_attempt_id) || priorStatus.status === 'authorization_pending')) {
            fail('oauth_start_in_progress');
          }
          if (priorStatus.status === 'exchange_claimed') fail('oauth_start_in_progress');
          if (priorStatus.status === 'authorization_pending') {
            if (input.restartOfStartAttemptId !== previous.start_attempt_id) fail('oauth_conflict');
            const replaced = this.options.stages.supersedeAuthorizationWithinTransaction(context, previous.stage_id, sessionBinding);
            if (replaced.status === 'exchange_claimed') fail('oauth_start_in_progress');
          } else if (priorStatus.status === 'inspect_required' && input.restartOfStartAttemptId !== previous.start_attempt_id) {
            fail('oauth_conflict');
          }
          context.db.prepare(`UPDATE oauth_connection_starts SET disposition='superseded' WHERE start_attempt_id=? AND disposition='active'`)
            .run(previous.start_attempt_id);
          clearCookieNames.push(cookieName(provider, previous.start_attempt_id));
        } else if (input.restartOfStartAttemptId !== undefined) fail('oauth_conflict');
        const lifecycle = input.reconnectAccountId
          ? reconnectFromSnapshot((context.db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(context.workspaceId) as { snapshot_json: string }).snapshot_json,
            input.reconnectAccountId, provider)
          : undefined;
        const created = this.options.stages.createAuthorization(context, { initiatingSessionToken: admission.sessionToken,
          registrationId: registration.id, provider, requestedCapabilities: input.requestedCapabilities,
          ...(lifecycle ? { reconnectLifecycle: lifecycle } : {}) });
        const row: StartRow = { start_attempt_id: input.startAttemptId, stage_id: created.status.attemptId, owner_id: context.ownerId,
          workspace_id: context.workspaceId, privacy_epoch: context.privacyEpoch, session_binding: sessionBinding, provider, request_digest: requestDigest,
          builder_state: 'building', disposition: 'active', created_at: created.status.createdAt, expires_at: created.status.expiresAt };
        context.db.prepare(`INSERT INTO oauth_connection_starts(start_attempt_id,stage_id,owner_id,workspace_id,privacy_epoch,session_binding,
          provider,request_digest,builder_state,disposition,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(row.start_attempt_id, row.stage_id, row.owner_id, row.workspace_id, row.privacy_epoch, row.session_binding, row.provider,
            row.request_digest, row.builder_state, row.disposition, row.created_at, row.expires_at);
        return { existing: false as const, row, status: created.status, authorization: created.authorization, clearCookieNames };
      });
      return Object.freeze({ input, registration, identity, sessionBinding, requestDigest, prepared });
    } catch (error) {
      if (existingStartAttemptId) fail('oauth_conflict');
      // A successful exact readback proves whether a synchronous transaction failed
      // before commit or whether its acknowledgement was lost after the row committed.
      if (startAttemptId) {
        let existingRow: unknown;
        try {
          existingRow = this.options.kernel.withTrustedDatabaseTransaction((db) =>
            db.prepare('SELECT 1 FROM oauth_connection_starts WHERE start_attempt_id=?').get(startAttemptId));
        } catch { throw error; }
        if (existingRow) throw error;
      }
      // No exact CID row exists, so this call neither committed nor adopted a stage,
      // and provider work has not begun.
      fail('oauth_start_not_admitted');
    }
  }

  private async startOwned(admission: { sessionToken: string; assertCurrent: () => void }, provider: OAuthStageProvider, inputValue: unknown): Promise<OAuthStartResult> {
    const { input, registration, identity, sessionBinding, prepared } = this.prepareStart(admission, provider, inputValue);
    admission.assertCurrent();
    if (prepared.existing) return Object.freeze({ kind: 'existing', status: prepared.status });
    this.activeBuilders.add(input.startAttemptId);
    try {
      const authorizationUrl = await this.track(provider, () => this.options.provider.buildAuthorizationUrl(registration.id, {
        ...prepared.authorization, requestedCapabilities: input.requestedCapabilities,
      }));
      admission.assertCurrent();
      const current = this.current(admission);
      if (current.workspaceId !== identity.workspaceId || current.ownerId !== identity.ownerId || current.privacyEpoch !== identity.privacyEpoch) fail('oauth_stale_workspace');
      const status = this.options.kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
        const row = context.db.prepare(`SELECT * FROM oauth_connection_starts WHERE start_attempt_id=? AND session_binding=? AND disposition='active'`)
          .get(input.startAttemptId, sessionBinding) as StartRow | undefined;
        if (!row || row.stage_id !== prepared.row.stage_id || row.builder_state !== 'building') fail('oauth_conflict');
        const stageStatus = this.options.stages.readStatus(context, row.stage_id, sessionBinding);
        if (stageStatus.status !== 'authorization_pending' || stageStatus.expiresAt <= this.now()) fail('oauth_conflict');
        context.db.prepare(`UPDATE oauth_connection_starts SET builder_state='ready' WHERE start_attempt_id=? AND builder_state='building'`)
          .run(input.startAttemptId);
        return stageStatus;
      });
      admission.assertCurrent();
      if (status.expiresAt <= this.now()) fail('oauth_conflict');
      return Object.freeze({ kind: 'started', status, authorizationUrl: authorizationUrl.href,
        cookie: Object.freeze({ name: cookieName(provider, input.startAttemptId), value: prepared.authorization.cookieBinding, maxAgeSeconds: TTL_SECONDS }),
        ...(prepared.clearCookieNames.length ? { clearCookieNames: Object.freeze(prepared.clearCookieNames) } : {}) });
    } catch (error) {
      try {
        this.options.kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
          context.db.prepare(`UPDATE oauth_connection_starts SET builder_state='restart_required' WHERE start_attempt_id=? AND session_binding=? AND builder_state='building'`)
            .run(input.startAttemptId, sessionBinding);
        });
      } catch { /* A lost session or epoch is never repaired using stale authority. */ }
      if (error instanceof OAuthConnectionServiceError) throw error;
      if (error instanceof OAuthProviderAdapterError) fail('oauth_provider_failed');
      throw error;
    } finally { this.activeBuilders.delete(input.startAttemptId); }
  }

  inspectStart(admission: { sessionToken: string; assertCurrent: () => void }, provider: OAuthStageProvider, startAttemptId: string): OAuthAttemptMetadata {
    const identity = this.current(admission);
    const sessionBinding = sha256(admission.sessionToken);
    const result = this.options.kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
      const row = context.db.prepare(`SELECT * FROM oauth_connection_starts WHERE start_attempt_id=? AND owner_id=? AND workspace_id=?
        AND privacy_epoch=? AND session_binding=?`).get(startAttemptId, context.ownerId, context.workspaceId, context.privacyEpoch, sessionBinding) as StartRow | undefined;
      if (!row || row.provider !== provider) fail('oauth_not_found');
      const status = this.options.stages.readStatus(context, row.stage_id, sessionBinding);
      return this.metadata(row, status);
    });
    admission.assertCurrent(); return result;
  }

  listStarts(admission: { sessionToken: string; assertCurrent: () => void }, provider?: OAuthStageProvider): readonly OAuthAttemptMetadata[] {
    const identity = this.current(admission);
    const sessionBinding = sha256(admission.sessionToken);
    const results = this.options.kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
      const rows = (provider ? context.db.prepare(`SELECT * FROM oauth_connection_starts WHERE owner_id=? AND workspace_id=? AND privacy_epoch=?
        AND session_binding=? AND provider=? ORDER BY created_at DESC LIMIT ?`).all(context.ownerId, context.workspaceId, context.privacyEpoch,
        sessionBinding, provider, MAX_ATTEMPTS) : context.db.prepare(`SELECT * FROM oauth_connection_starts WHERE owner_id=? AND workspace_id=? AND privacy_epoch=?
        AND session_binding=? ORDER BY created_at DESC LIMIT ?`).all(context.ownerId, context.workspaceId, context.privacyEpoch,
        sessionBinding, MAX_ATTEMPTS)) as StartRow[];
      return Object.freeze(rows.map((row) => this.metadata(row, this.options.stages.readStatus(context, row.stage_id, sessionBinding))));
    });
    admission.assertCurrent(); return results;
  }

  inspectStage(admission: { sessionToken: string; assertCurrent: () => void }, stageId: string): OAuthStageInspection {
    const identity = this.current(admission); const sessionBinding = sha256(admission.sessionToken);
    const inspection = this.options.kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
      const result = this.options.stages.readVerifiedForInstall(context, stageId, sessionBinding);
      if (!result.payload) return Object.freeze({ stage: result.status });
      return Object.freeze({ stage: result.status, verifiedAccount: Object.freeze({ displayName: result.payload.displayName,
        ...(result.payload.email ? { email: result.payload.email } : {}),
        requestedCapabilities: Object.freeze([...result.payload.requestedCapabilities]),
        capabilities: Object.freeze([...result.payload.capabilities]),
        ...(result.reconnectLifecycle ? { reconnectAccountId: result.reconnectLifecycle.accountId } : {}) }) });
    });
    admission.assertCurrent(); return inspection;
  }

  private metadata(row: StartRow, status: OAuthInstallStageStatus): OAuthAttemptMetadata {
    return Object.freeze({ startAttemptId: row.start_attempt_id, provider: row.provider, stageId: row.stage_id,
      status: row.disposition === 'superseded' ? 'superseded' : status.status !== 'authorization_pending' ? status.status :
        row.builder_state === 'building' ? 'building' : row.builder_state === 'restart_required' ? 'restart_required' : status.status,
      createdAt: row.created_at, expiresAt: row.expires_at, ...(status.consumption ? { consumption: status.consumption } : {}) });
  }

  callbackCookieName(provider: OAuthStageProvider, state: string): string | undefined {
    if (!providerFrom(provider) || !PROOF.test(state)) return undefined;
    const stateHash = sha256(state);
    return this.options.kernel.withTrustedDatabaseTransaction((db) => {
      const row = db.prepare(`SELECT s.owner_id,s.workspace_id,s.privacy_epoch,s.initiating_session_binding,c.start_attempt_id,c.provider,
        c.owner_id AS start_owner_id,c.workspace_id AS start_workspace_id,c.privacy_epoch AS start_privacy_epoch,
        c.session_binding AS start_session_binding
        FROM oauth_install_stages s JOIN oauth_connection_starts c ON c.stage_id=s.stage_id
        JOIN workspaces w ON w.id=s.workspace_id WHERE s.state_hash=?`)
        .get(stateHash) as { owner_id: string; workspace_id: string; privacy_epoch: number; initiating_session_binding: string;
          start_attempt_id: string; provider: OAuthStageProvider; start_owner_id: string; start_workspace_id: string;
          start_privacy_epoch: number; start_session_binding: string } | undefined;
      if (!row || row.provider !== provider || row.start_owner_id !== row.owner_id || row.start_workspace_id !== row.workspace_id ||
          row.start_privacy_epoch !== row.privacy_epoch || !sameHash(row.start_session_binding, row.initiating_session_binding)) return undefined;
      const workspace = db.prepare('SELECT owner_id,privacy_epoch FROM workspaces WHERE id=?').get(row.workspace_id) as { owner_id: string; privacy_epoch: number } | undefined;
      if (!workspace || workspace.owner_id !== row.owner_id || workspace.privacy_epoch !== row.privacy_epoch) return undefined;
      return cookieName(provider, row.start_attempt_id);
    });
  }

  callback(provider: OAuthStageProvider, inputValue: OAuthCallbackInput): Promise<Readonly<{ attemptId?: string; status: string; clearCookieName?: string }>> {
    return this.track(provider, () => this.callbackOwned(provider, inputValue));
  }

  private async callbackOwned(provider: OAuthStageProvider, inputValue: OAuthCallbackInput): Promise<Readonly<{ attemptId?: string; status: string; clearCookieName?: string }>> {
    if (!this.accepting) fail('oauth_service_closing');
    if (!providerFrom(provider)) fail('oauth_callback_invalid');
    const fields = objectFields(inputValue, ['state', 'cookieBinding'], ['code', 'error']);
    if (typeof fields.state !== 'string' || !PROOF.test(fields.state) || typeof fields.cookieBinding !== 'string' || !PROOF.test(fields.cookieBinding) ||
        (typeof fields.code === 'string') === (typeof fields.error === 'string') ||
        fields.code !== undefined && (typeof fields.code !== 'string' || fields.code.length > 4096 || /[\u0000-\u001f\u007f]/.test(fields.code)) ||
        fields.error !== undefined && (typeof fields.error !== 'string' || fields.error.length > 256 || /[\u0000-\u001f\u007f]/.test(fields.error))) fail('oauth_callback_invalid');
    const state = fields.state as string;
    const cookieBinding = fields.cookieBinding as string;
    const proof = { state, cookieBinding };
    const clearCookieName = this.callbackCookieName(provider, state);
    let identity: OwnedWorkspaceIdentity;
    let attemptId: string;
    try {
      const resolved = this.options.stages.resolveCallbackIdentity(provider, proof);
      identity = Object.freeze({ workspaceId: resolved.workspaceId, ownerId: resolved.ownerId, revision: resolved.revision, privacyEpoch: resolved.privacyEpoch });
      attemptId = resolved.attemptId;
    } catch { fail('oauth_callback_invalid'); }
    const actor = this.options.runtimeSessionFor(identity);
    this.assertWorkspaceAvailable(identity);
    let claimResult;
    try {
      claimResult = this.options.kernel.withOwnedTransaction(actor, identity.privacyEpoch, (context) => {
        if (fields.error !== undefined) {
          const status = this.options.stages.completeDenied(context, proof);
          return { denied: true as const, status };
        }
        return { denied: false as const, result: this.options.stages.claimExchange(context, proof) };
      });
    } catch { fail('oauth_callback_invalid'); }
    if (claimResult.denied) return Object.freeze({ attemptId, status: claimResult.status.status, ...(clearCookieName ? { clearCookieName } : {}) });
    if (!claimResult.result.claimed) return Object.freeze({ attemptId, status: claimResult.result.status.status,
      ...(clearCookieName ? { clearCookieName } : {}) });
    const { claim, authorization } = claimResult.result;
    const controller = new AbortController(); this.aborters.add(controller);
    try {
      const registration = this.registration(provider);
      const callbackUrl = new URL(registration.redirect);
      callbackUrl.searchParams.set('code', fields.code as string);
      callbackUrl.searchParams.set('state', state);
      const payload = await this.track(provider, () => this.options.provider.exchangeVerified(registration.id, {
        callbackUrl: callbackUrl.href,
        state, nonce: authorization.nonce, pkceVerifier: authorization.pkceVerifier,
        requestedCapabilities: authorization.requestedCapabilities, signal: controller.signal,
        assertCurrent: () => {
          if (!this.accepting) fail('oauth_service_closing');
          this.options.kernel.withOwnedTransaction(actor, identity.privacyEpoch,
            (context) => this.options.stages.assertExchangeClaimCurrent(context, claim));
        },
      }));
      // Provider work may outlive prepare/drain. Recheck the exact resolved stage identity
      // immediately before the verified private payload can be committed.
      this.assertWorkspaceAvailable(identity);
      const status = this.options.kernel.withOwnedTransaction(actor, identity.privacyEpoch,
        (context) => this.options.stages.completeVerified(context, claim, payload));
      return Object.freeze({ attemptId, status: status.status, ...(clearCookieName ? { clearCookieName } : {}) });
    } catch {
      try {
        const status = this.options.kernel.withOwnedTransaction(actor, identity.privacyEpoch,
          (context) => this.options.stages.markExchangeUnknown(context, claim));
        return Object.freeze({ attemptId, status: status.status, ...(clearCookieName ? { clearCookieName } : {}) });
      } catch {
        try {
          const status = this.options.kernel.withOwnedTransaction(actor, identity.privacyEpoch,
            (context) => this.options.stages.readExchangeClaimStatus(context, claim));
          return Object.freeze({ attemptId, status: status.status, ...(clearCookieName ? { clearCookieName } : {}) });
        } catch { fail('oauth_exchange_unknown'); }
      }
    } finally { this.aborters.delete(controller); }
  }

  stopAdmission(): void {
    this.accepting = false;
    for (const controller of this.aborters) controller.abort();
  }

  async drain(): Promise<void> {
    this.stopAdmission();
    while (this.active.size) await Promise.allSettled([...this.active]);
  }
}
