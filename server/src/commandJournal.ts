import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { DurableKernel, JsonValue, OwnedTransactionContext } from './kernel.js';
import type { AuthService } from './auth.js';
import type { SecretVault } from './vault.js';
import { isValidAccountId } from './accountIds.js';
import { OAuthInstallStages, type OAuthVerifiedPayload, type OAuthReconnectLifecycle } from './oauthInstallStages.js';
import { ServerOAuthTokenBindings, isValidOAuthTokenRef } from './oauthTokenBindings.js';
import { WORKSPACE_COMMAND_HISTORY_KINDS, WORKSPACE_COMMAND_HISTORY_PAGE_SIZE, isWorkspaceCommandId,
  workspaceCommandKindFromJournal, workspaceCommandKindToJournal, type WorkspaceCommandHistoryEntry,
  type WorkspaceCommandHistoryPage } from './workspaceCommandHistory.js';

const JOURNAL_SCHEMA_VERSION = 3;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND = /^[a-z][a-z0-9._:-]{0,95}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type JournalStatus = 'claimed' | 'checkpointed' | 'finished' | 'inspect_required';

export interface CommandTicket {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly admissionSessionDigest: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly requestDigest: string;
  readonly ticketId: string;
  /** Opaque capability. Keep it inside trusted server modules; never serialize it to a client. */
  readonly capability: string;
  readonly initiatingSessionBinding?: string;
  readonly oauthInstallStageId?: string;
}

export interface CommandAdmission {
  readonly fresh: boolean;
  readonly status: JournalStatus;
  readonly ticket?: CommandTicket;
  readonly receipt?: JsonValue;
  readonly checkpointRevision?: number;
  /** Server-trusted journal kind, included only by authenticated inspection. */
  readonly commandKind?: string;
}

interface HistoryCursor { readonly v: 1; readonly scope: string; readonly createdAt: number; readonly commandId: string }
interface HistoryRow { idempotency_key: string; command_kind: string; status: JournalStatus; created_at: number; updated_at: number }

function historyUuidGlob(): string {
  const hex = '[0-9a-fA-F]';
  return `${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-[89aAbB]${hex.repeat(3)}-${hex.repeat(12)}`;
}

function historyScope(ownerId: string, workspaceId: string, privacyEpoch: number): string {
  return digest(JSON.stringify({ ownerId, workspaceId, privacyEpoch }));
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value: unknown, expectedScope: string): HistoryCursor {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('command_history_cursor_invalid');
  }
  let json: string;
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    json = bytes.toString('utf8');
    if (bytes.toString('base64url') !== value) throw new Error('noncanonical');
    parsed = JSON.parse(json);
  } catch { throw new Error('command_history_cursor_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error('command_history_cursor_invalid');
  }
  const row = parsed as Record<string, unknown>;
  if (Reflect.ownKeys(row).length !== 4 || Reflect.ownKeys(row).some((key) => typeof key !== 'string' || !['v', 'scope', 'createdAt', 'commandId'].includes(key)) ||
      JSON.stringify({ v: row.v, scope: row.scope, createdAt: row.createdAt, commandId: row.commandId }) !== json ||
      row.v !== 1 || row.scope !== expectedScope || typeof row.scope !== 'string' || !/^[a-f0-9]{64}$/.test(row.scope) ||
      !Number.isSafeInteger(row.createdAt) || (row.createdAt as number) < 0 || !isWorkspaceCommandId(row.commandId)) {
    throw new Error('command_history_cursor_invalid');
  }
  return row as unknown as HistoryCursor;
}

export interface OwnedObjectIds {
  readonly notes?: readonly string[];
  readonly tasks?: readonly string[];
  readonly proposals?: readonly string[];
  readonly accounts?: readonly string[];
  readonly documents?: readonly string[];
  readonly calendars?: readonly string[];
}

export interface CommandTicketContext extends CommandTicket {
  readonly runtimeSessionToken: string;
}

export interface CaptureAdoptionCheckpoint {
  readonly id: string;
  readonly revision: string;
  readonly noteId: string;
  readonly uploadId: string;
  readonly mediaId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly format: 'm4a' | 'mp3' | 'wav' | 'webm' | 'ogg';
  readonly mimeType: string;
  readonly durationSeconds: number;
  readonly capturedAt: string;
  readonly captureTimeZone: string;
}

export interface OAuthInstallCheckpoint {
  readonly stageId: string;
  readonly stagePayloadGeneration: number;
  readonly accountId: string;
  readonly accountGeneration: number;
  readonly tokenRef: string;
}

export interface PreparedOAuthInstallFacts {
  readonly stageId: string;
  readonly stagePayloadGeneration: number;
  readonly provider: OAuthVerifiedPayload['provider'];
  readonly identity: OAuthVerifiedPayload['identity'];
  readonly requestedCapabilities: OAuthVerifiedPayload['requestedCapabilities'];
  readonly capabilities: OAuthVerifiedPayload['capabilities'];
  readonly grantedScopes: OAuthVerifiedPayload['grantedScopes'];
  readonly displayName: string;
  readonly email?: string;
  readonly expiresAt: number;
  readonly expectedLifecycle?: OAuthReconnectLifecycle;
}

const currentTicket = new AsyncLocalStorage<CommandTicketContext>();

export function currentCommandTicket(): CommandTicketContext | undefined {
  return currentTicket.getStore();
}

export function withCommandTicket<T>(ticket: CommandTicketContext, work: () => Promise<T>): Promise<T> {
  return currentTicket.run(ticket, work);
}

function canonical(value: unknown, maxBytes = MAX_RECEIPT_BYTES): { text: string; value: JsonValue } {
  const clean = (candidate: unknown, ancestors = new Set<object>()): JsonValue => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (!candidate || typeof candidate !== 'object' || ancestors.has(candidate)) throw new Error('Command journal accepts only finite, acyclic JSON values.');
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(candidate)) throw new Error('Command journal objects must be plain JSON objects.');
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map((entry) => clean(entry, ancestors));
      }
      if (Reflect.ownKeys(candidate).some((key) => typeof key !== 'string')) throw new Error('Command journal objects cannot contain symbol keys.');
      const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(candidate).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('Command journal objects cannot contain accessors.');
        output[key] = clean(descriptor.value, ancestors);
      }
      return output;
    } finally { ancestors.delete(candidate); }
  };
  const json = clean(value);
  const text = JSON.stringify(json);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Command journal JSON exceeds its physical byte limit.');
  return { text, value: json };
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function sessionDigest(value: string): string { return digest(`session\0${value}`); }
function installStageFromCanonicalBody(value: JsonValue, commandId: string, expectedRevision: number, expectedPrivacyEpoch: number): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== ['command', 'commandId', 'expectedPrivacyEpoch', 'expectedRevision', 'schemaVersion'].join('\0')) {
    throw new Error('oauth_install_command_invalid');
  }
  const envelope = value as Record<string, JsonValue>;
  const command = envelope.command;
  if (envelope.schemaVersion !== 1 || envelope.commandId !== commandId || envelope.expectedRevision !== expectedRevision ||
      envelope.expectedPrivacyEpoch !== expectedPrivacyEpoch || !command || typeof command !== 'object' || Array.isArray(command) ||
      Object.keys(command).sort().join('\0') !== ['kind', 'stageId'].join('\0') ||
      (command as Record<string, JsonValue>).kind !== 'accounts.installOAuth' ||
      typeof (command as Record<string, JsonValue>).stageId !== 'string' || !UUID_V4.test((command as Record<string, JsonValue>).stageId as string)) {
    throw new Error('oauth_install_command_invalid');
  }
  return (command as Record<string, JsonValue>).stageId as string;
}
function requireKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !KEY.test(value)) throw new Error('Command idempotency key is invalid.');
}
function requireKind(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !KIND.test(value)) throw new Error('Command kind is invalid.');
}

interface JournalRow {
  workspace_id: string; owner_id: string; session_digest: string; idempotency_key: string;
  initiating_session_binding: string | null;
  request_digest: string; command_kind: string; privacy_epoch: number; ticket_id: string; ticket_digest: string;
  status: JournalStatus; created_at: number; updated_at: number; checkpoint_revision: number | null;
  snapshot_digest: string | null; owned_object_ids_json: string | null; receipt_json: string | null;
}

export interface CommandJournalOptions {
  readonly now?: () => number;
  readonly projectOwnedObjectIds?: (snapshot: unknown) => OwnedObjectIds;
  readonly oauthInstall?: Readonly<{ auth: AuthService; vault: SecretVault; stages: OAuthInstallStages; bindings: ServerOAuthTokenBindings }>;
  /** Fixed failpoint used only by rollback tests; production composition always omits it. */
  readonly oauthInstallFailureForTesting?: 'after_workspace' | 'after_vault' | 'after_binding' | 'after_stage' | 'after_receipt';
}

/** Durable admission and receipt state for async operations; no DB transaction spans awaited work. */
export class CommandJournal {
  private readonly now: () => number;
  private readonly projectOwnedObjectIds: (snapshot: unknown) => OwnedObjectIds;

  constructor(private readonly kernel: DurableKernel, options: CommandJournalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.projectOwnedObjectIds = options.projectOwnedObjectIds ?? projectDefaultObjectIds;
    this.oauthInstall = options.oauthInstall;
    this.oauthInstallFailureForTesting = options.oauthInstallFailureForTesting;
    this.kernel.withTrustedDatabaseTransaction((db) => this.initialize(db));
  }

  private readonly oauthInstall?: CommandJournalOptions['oauthInstall'];
  private readonly oauthInstallFailureForTesting?: CommandJournalOptions['oauthInstallFailureForTesting'];

  private initialize(db: Database.Database): void {
    const exists = (name: string): boolean => Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const hasVersion = exists('command_journal_schema');
    const hasTable = exists('async_command_journal');
    if (!hasVersion && !hasTable) {
      db.exec(`
        CREATE TABLE command_journal_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version>0)) STRICT;
        CREATE TABLE async_command_journal (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL, owner_id TEXT NOT NULL, session_digest TEXT NOT NULL,
          initiating_session_binding TEXT CHECK(initiating_session_binding IS NULL OR length(initiating_session_binding)=64),
          request_digest TEXT NOT NULL, command_kind TEXT NOT NULL, privacy_epoch INTEGER NOT NULL,
          ticket_id TEXT NOT NULL UNIQUE, ticket_digest TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('claimed','checkpointed','finished','inspect_required')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checkpoint_revision INTEGER,
          snapshot_digest TEXT, owned_object_ids_json TEXT, receipt_json TEXT,
          PRIMARY KEY(workspace_id,idempotency_key),
          CHECK ((status='finished' AND receipt_json IS NOT NULL) OR (status!='finished' AND receipt_json IS NULL))
        ) STRICT;
        CREATE INDEX async_command_journal_status_idx ON async_command_journal(workspace_id,status,updated_at);
        CREATE INDEX async_command_journal_history_idx ON async_command_journal(workspace_id,owner_id,privacy_epoch,created_at DESC,idempotency_key DESC);
        INSERT INTO command_journal_schema(singleton,version) VALUES(1,${JOURNAL_SCHEMA_VERSION});
      `);
      return;
    }
    if (!hasVersion || !hasTable) throw new Error('The asynchronous command journal schema is incomplete.');
    const version = db.prepare('SELECT version FROM command_journal_schema WHERE singleton=1').get() as { version: number } | undefined;
    if (!version || !Number.isSafeInteger(version.version) || version.version < 1) throw new Error('The asynchronous command journal schema version is invalid.');
    if (version.version > JOURNAL_SCHEMA_VERSION) throw new Error('The asynchronous command journal was created by a newer server.');
    if (version.version === 1) {
      db.exec(`CREATE INDEX IF NOT EXISTS async_command_journal_history_idx ON async_command_journal(workspace_id,owner_id,privacy_epoch,created_at DESC,idempotency_key DESC);
        UPDATE command_journal_schema SET version=2 WHERE singleton=1;`);
    }
    const current = db.prepare('SELECT version FROM command_journal_schema WHERE singleton=1').get() as { version: number };
    if (current.version === 2) {
      const columns = db.pragma('table_info(async_command_journal)') as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'initiating_session_binding')) {
        db.exec(`ALTER TABLE async_command_journal ADD COLUMN initiating_session_binding TEXT
          CHECK(initiating_session_binding IS NULL OR length(initiating_session_binding)=64);`);
      }
      db.prepare('UPDATE command_journal_schema SET version=? WHERE singleton=1').run(JOURNAL_SCHEMA_VERSION);
    } else if (current.version !== JOURNAL_SCHEMA_VERSION) {
      throw new Error('The asynchronous command journal requires an unavailable migration.');
    }
  }

  admit(input: { admissionSessionToken: string; expectedRevision: number; expectedPrivacyEpoch: number; idempotencyKey: string; kind: string; canonicalBody: string }): CommandAdmission {
    requireKey(input?.idempotencyKey); requireKind(input?.kind);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !Number.isSafeInteger(input.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0) throw new Error('Command admission revision or epoch is invalid.');
    const parsed = parseCanonical(input.canonicalBody, MAX_REQUEST_BYTES);
    const requestDigest = digest(`${input.kind}\0${parsed.text}`);
    const oauthInstallStageId = input.kind === 'accounts.installoauth' ? installStageFromCanonicalBody(parsed.value,
      input.idempotencyKey, input.expectedRevision, input.expectedPrivacyEpoch) : undefined;
    return this.kernel.withOwnedTransaction(input.admissionSessionToken, input.expectedPrivacyEpoch, (context) => {
      const prior = context.db.prepare(`SELECT * FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`)
        .get(context.workspaceId, input.idempotencyKey) as JournalRow | undefined;
      if (prior) {
        if (prior.owner_id !== context.ownerId || prior.request_digest !== requestDigest ||
          prior.command_kind !== input.kind || prior.privacy_epoch !== context.privacyEpoch) {
          throw new Error('This command idempotency key is already bound to different ownership or request content.');
        }
        return Object.freeze({ fresh: false, status: prior.status,
          ...(prior.receipt_json ? { receipt: parseJson(prior.receipt_json) } : {}),
          ...(prior.checkpoint_revision === null ? {} : { checkpointRevision: prior.checkpoint_revision }) });
      }
      if (context.revision !== input.expectedRevision) throw new Error('The workspace revision changed before command admission.');
      const initiatingSessionBinding = oauthInstallStageId
        ? this.oauthInstall?.auth.bindInitiatingSessionWithinTransaction(context, input.admissionSessionToken)
        : undefined;
      if (oauthInstallStageId && !initiatingSessionBinding) throw new Error('oauth_install_unavailable');
      const ticketId = randomUUID();
      const capability = randomBytes(32).toString('base64url');
      const now = this.clock();
      context.db.prepare(`INSERT INTO async_command_journal(workspace_id,idempotency_key,owner_id,session_digest,initiating_session_binding,request_digest,command_kind,privacy_epoch,
        ticket_id,ticket_digest,status,created_at,updated_at,checkpoint_revision,snapshot_digest,owned_object_ids_json,receipt_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,'claimed',?,?,NULL,NULL,NULL,NULL)`)
        .run(context.workspaceId, input.idempotencyKey, context.ownerId, sessionDigest(input.admissionSessionToken), initiatingSessionBinding ?? null, requestDigest, input.kind,
          context.privacyEpoch, ticketId, digest(capability), now, now);
      const ticket: CommandTicket = Object.freeze({ workspaceId: context.workspaceId, ownerId: context.ownerId,
        privacyEpoch: context.privacyEpoch, admissionSessionDigest: sessionDigest(input.admissionSessionToken), idempotencyKey: input.idempotencyKey, kind: input.kind,
        requestDigest, ticketId, capability,
        ...(initiatingSessionBinding ? { initiatingSessionBinding } : {}),
        ...(oauthInstallStageId ? { oauthInstallStageId } : {}) });
      return Object.freeze({ fresh: true, status: 'claimed' as const, ticket });
    });
  }

  async run<T>(ticket: CommandTicket, runtimeSessionToken: string, operation: () => Promise<T>): Promise<T> {
    const context: CommandTicketContext = Object.freeze({ ...ticket, runtimeSessionToken });
    this.kernel.withOwnedTransaction(runtimeSessionToken, ticket.privacyEpoch, (owned) => {
      const row = this.getTicketRow(owned, context);
      if (row.status !== 'claimed') throw new Error('This command is not an executable fresh claim.');
    });
    try {
      const result = await withCommandTicket(context, operation);
      return result;
    } catch (error) {
      // Preserve the operation failure if the runtime session or privacy epoch
      // was revoked while it was running. When still authorized, record that the
      // outcome needs inspection before surfacing the original error.
      try { this.requireInspection(context); } catch { /* the epoch may have been erased */ }
      throw error;
    }
  }

  /** Checkpoint the state-store save and journal revision in the same SQLite transaction. */
  checkpoint(ticket: CommandTicketContext, stateFence: { workspaceId: string; revision: number; privacyEpoch: number },
    serializedSnapshot: string, accountGenerations: Readonly<Record<string, number>>): number {
    if (ticket.kind === 'accounts.installoauth') throw new Error('oauth_install_checkpoint_required');
    const parsed = parseCanonical(serializedSnapshot, 16 * 1024 * 1024);
    const snapshotDigest = digest(parsed.text);
    const ids = canonical(this.projectOwnedObjectIds(parsed.value), 1024 * 1024);
    return this.kernel.withOwnedTransaction(ticket.runtimeSessionToken, ticket.privacyEpoch, (context) => {
      if (stateFence.workspaceId !== ticket.workspaceId || stateFence.revision !== context.revision ||
          stateFence.privacyEpoch !== context.privacyEpoch || context.workspaceId !== ticket.workspaceId || context.ownerId !== ticket.ownerId) {
        throw new Error('Workspace changed before the asynchronous command checkpoint. Reload before continuing.');
      }
      const row = this.getTicketRow(context, ticket);
      if (!['claimed', 'checkpointed'].includes(row.status)) throw new Error('This command can no longer checkpoint state.');
      const idempotencyKey = randomUUID();
      const input = { expectedRevision: context.revision, expectedPrivacyEpoch: context.privacyEpoch,
        idempotencyKey, type: 'workspace.snapshot.write', canonicalRequest: canonical({ command: ticket.idempotencyKey, snapshotDigest }).text };
      const receipt = this.kernel.runLocalCommand(ticket.runtimeSessionToken, input, () => ({
        snapshot: parsed.value,
        receipt: { kind: 'workspace_snapshot_checkpoint', commandKind: ticket.kind, snapshotDigest },
        accountGenerations,
      }));
      const update = context.db.prepare(`UPDATE async_command_journal SET status='checkpointed', updated_at=?, checkpoint_revision=?, snapshot_digest=?, owned_object_ids_json=?
        WHERE workspace_id=? AND idempotency_key=? AND ticket_id=? AND ticket_digest=? AND status IN ('claimed','checkpointed')`)
        .run(this.clock(), receipt.revision, snapshotDigest, ids.text, ticket.workspaceId, ticket.idempotencyKey, ticket.ticketId, digest(ticket.capability));
      if (update.changes !== 1) throw new Error('The command checkpoint could not be recorded.');
      return receipt.revision;
    });
  }

  /**
   * Trusted same-transaction proof for the one scheduled paid mail-reply
   * submission checkpoint. This deliberately accepts no public command data:
   * the ticket must be the exact AsyncLocalStorage object currently executing
   * and its durable row must still be claimed/checkpointed in this workspace.
   */
  assertPaidMailReplySubmissionWithinTransaction(context: OwnedTransactionContext, ticket: CommandTicketContext): void {
    if (!context || !ticket || currentTicket.getStore() !== ticket || ticket.kind !== workspaceCommandKindToJournal('mail.replyBatch.submit')) {
      throw new Error('background_paid_command_ticket_invalid');
    }
    // Also proves this context belongs to this kernel and is the active outer
    // transaction before the private ticket row is inspected.
    this.kernel.readOwnedSnapshotWithinTransaction(context);
    const row = this.getTicketRow(context, ticket);
    if (row.status !== 'claimed' && row.status !== 'checkpointed') throw new Error('background_paid_command_ticket_not_active');
  }

  /** Atomically promotes one verified OAuth stage into the workspace and exact encrypted account slot. */
  checkpointOAuthInstall(ticket: CommandTicketContext, stateFence: { workspaceId: string; revision: number; privacyEpoch: number },
    serializedSnapshot: string, accountGenerations: Readonly<Record<string, number>>, install: OAuthInstallCheckpoint): number {
    if (!ticket || ticket.kind !== 'accounts.installoauth' || currentTicket.getStore() !== ticket ||
        !this.oauthInstall || !install || install.stageId !== ticket.oauthInstallStageId || !UUID_V4.test(install.stageId) ||
        !Number.isSafeInteger(install.stagePayloadGeneration) || install.stagePayloadGeneration < 1 ||
        !isValidAccountId(install.accountId) || !Number.isSafeInteger(install.accountGeneration) || install.accountGeneration < 1 ||
        !isValidOAuthTokenRef(install.tokenRef)) throw new Error('oauth_install_checkpoint_invalid');
    const oauthInstall = this.oauthInstall;
    const parsed = parseCanonical(serializedSnapshot, 16 * 1024 * 1024);
    const snapshotDigest = digest(parsed.text);
    const ids = canonical(this.projectOwnedObjectIds(parsed.value), 1024 * 1024);
    const outcome = this.kernel.withOwnedTransaction(ticket.runtimeSessionToken, ticket.privacyEpoch, (context) => {
      if (stateFence.workspaceId !== ticket.workspaceId || stateFence.revision !== context.revision ||
          stateFence.privacyEpoch !== context.privacyEpoch || context.workspaceId !== ticket.workspaceId || context.ownerId !== ticket.ownerId ||
          context.privacyEpoch !== ticket.privacyEpoch) throw new Error('oauth_install_workspace_changed');
      const row = this.getTicketRow(context, ticket);
      if (row.status !== 'claimed' || row.command_kind !== 'accounts.installoauth' || !row.initiating_session_binding ||
          row.initiating_session_binding !== ticket.initiatingSessionBinding) throw new Error('oauth_install_ticket_invalid');
      const expectedRequest = canonical({ schemaVersion: 1, commandId: ticket.idempotencyKey, expectedRevision: stateFence.revision,
        expectedPrivacyEpoch: ticket.privacyEpoch, command: { kind: 'accounts.installOAuth', stageId: install.stageId } }, 16 * 1024);
      if (digest(`${ticket.kind}\0${expectedRequest.text}`) !== row.request_digest) throw new Error('oauth_install_command_binding_mismatch');

      const staged = oauthInstall.stages.readVerifiedForInstall(context, install.stageId, row.initiating_session_binding);
      if (staged.status.status !== 'verified' || !staged.payload || staged.status.attemptId !== install.stageId ||
          staged.status.payloadGeneration !== install.stagePayloadGeneration) return staged.status.status;
      oauthInstall.auth.assertInitiatingSessionWithinTransaction(context, row.initiating_session_binding);
      validateOAuthInstallCandidate(context, this.kernel, parsed.value, accountGenerations, install, staged.payload,
        staged.reconnectLifecycle, row);

      const result = this.kernel.runLocalCommand(ticket.runtimeSessionToken, {
        expectedRevision: context.revision, expectedPrivacyEpoch: context.privacyEpoch, idempotencyKey: randomUUID(),
        type: 'workspace.snapshot.oauth_install', canonicalRequest: canonical({ command: ticket.idempotencyKey, snapshotDigest }).text,
      }, () => ({ snapshot: parsed.value, receipt: { kind: 'workspace_snapshot_oauth_install', snapshotDigest }, accountGenerations }));
      this.failOAuthInstallForTesting('after_workspace');
      const purpose = staged.payload.provider === 'google' ? 'googleOAuth' : 'microsoftOAuth';
      const credential = JSON.stringify({ accessToken: staged.payload.accessToken, refreshToken: staged.payload.refreshToken,
        expiresAt: staged.payload.expiresAt, identity: staged.payload.identity });
      const metadata = oauthInstall.vault.getMetadataWithinTransaction(context,
        { type: 'account', accountId: install.accountId, expectedAccountGeneration: install.accountGeneration }, purpose);
      const saved = oauthInstall.vault.setSecretWithinTransaction(context,
        { type: 'account', accountId: install.accountId, expectedAccountGeneration: install.accountGeneration }, purpose, metadata.generation, credential);
      this.failOAuthInstallForTesting('after_vault');
      oauthInstall.bindings.writeExistingCredentialBindingWithinTransaction(context, { tokenRef: install.tokenRef,
        accountId: install.accountId, provider: staged.payload.provider, accountGeneration: install.accountGeneration,
        credentialGeneration: saved.generation });
      this.failOAuthInstallForTesting('after_binding');
      this.consumeOAuthStageForInstall(context, row, install);
      this.failOAuthInstallForTesting('after_stage');
      const receipt = canonical({ schemaVersion: 1, commandId: ticket.idempotencyKey, kind: 'accounts.installOAuth',
        objectId: install.accountId, stageId: install.stageId, accountGeneration: install.accountGeneration }, MAX_RECEIPT_BYTES);
      const updated = context.db.prepare(`UPDATE async_command_journal SET status='finished',updated_at=?,checkpoint_revision=?,snapshot_digest=?,
        owned_object_ids_json=?,receipt_json=? WHERE workspace_id=? AND idempotency_key=? AND ticket_id=? AND ticket_digest=?
        AND status='claimed' AND initiating_session_binding=?`)
        .run(this.clock(), result.revision, snapshotDigest, ids.text, receipt.text, ticket.workspaceId, ticket.idempotencyKey,
          ticket.ticketId, digest(ticket.capability), row.initiating_session_binding);
      if (updated.changes !== 1) throw new Error('oauth_install_receipt_conflict');
      this.failOAuthInstallForTesting('after_receipt');
      return result.revision;
    });
    if (typeof outcome !== 'number') throw new Error(`oauth_install_stage_${outcome}`);
    return outcome;
  }

  /** Safe facts only; terminal cleanup commits before an unavailable stage is reported. */
  prepareOAuthInstallFacts(ticket: CommandTicketContext | undefined, stageId: string): PreparedOAuthInstallFacts {
    if (!ticket || ticket.kind !== 'accounts.installoauth' || currentTicket.getStore() !== ticket ||
        ticket.oauthInstallStageId !== stageId || !this.oauthInstall || !UUID_V4.test(stageId)) throw new Error('oauth_install_ticket_invalid');
    const result = this.kernel.withOwnedTransaction(ticket.runtimeSessionToken, ticket.privacyEpoch, (context) => {
      const row = this.getTicketRow(context, ticket);
      if (row.status !== 'claimed' || row.command_kind !== 'accounts.installoauth' || !row.initiating_session_binding ||
          row.initiating_session_binding !== ticket.initiatingSessionBinding) throw new Error('oauth_install_ticket_invalid');
      const staged = this.oauthInstall!.stages.readVerifiedForInstall(context, stageId, row.initiating_session_binding);
      if (staged.status.status !== 'verified' || !staged.payload) return { status: staged.status.status } as const;
      this.oauthInstall!.auth.assertInitiatingSessionWithinTransaction(context, row.initiating_session_binding);
      const payload = staged.payload;
      return { status: 'verified' as const, facts: Object.freeze({ stageId, stagePayloadGeneration: staged.status.payloadGeneration,
        provider: payload.provider, identity: payload.identity, requestedCapabilities: payload.requestedCapabilities,
        capabilities: payload.capabilities, grantedScopes: payload.grantedScopes, displayName: payload.displayName,
        ...(payload.email !== undefined ? { email: payload.email } : {}), expiresAt: payload.expiresAt,
        ...(staged.reconnectLifecycle ? { expectedLifecycle: staged.reconnectLifecycle } : {}) }) };
    });
    if (result.status !== 'verified') throw new Error(`oauth_install_stage_${result.status}`);
    return result.facts!;
  }

  private consumeOAuthStageForInstall(context: OwnedTransactionContext, row: JournalRow, install: OAuthInstallCheckpoint): void {
    if (!this.oauthInstall || row.command_kind !== 'accounts.installoauth' || row.status !== 'claimed' ||
        row.initiating_session_binding === null) throw new Error('oauth_install_ticket_invalid');
    const changed = context.db.prepare(`UPDATE oauth_install_stages SET status='consumed',claim_hash=NULL,nonce=NULL,tag=NULL,ciphertext=NULL,
      consumed_command_id=?,consumed_account_id=?,consumed_account_generation=? WHERE stage_id=? AND owner_id=? AND workspace_id=?
      AND privacy_epoch=? AND status='verified' AND payload_kind='verified' AND payload_generation=? AND initiating_session_binding=?`)
      .run(row.idempotency_key, install.accountId, install.accountGeneration, install.stageId, context.ownerId, context.workspaceId,
        context.privacyEpoch, install.stagePayloadGeneration, row.initiating_session_binding).changes;
    if (changed !== 1) throw new Error('oauth_install_stage_consume_conflict');
  }

  private failOAuthInstallForTesting(phase: NonNullable<CommandJournalOptions['oauthInstallFailureForTesting']>): void {
    if (this.oauthInstallFailureForTesting === phase) throw new Error(`oauth_install_test_failure_${phase}`);
  }

  /** Atomically adopts one ready server capture, writes the workspace snapshot, and finishes its command receipt. */
  checkpointCapture(ticket: CommandTicketContext, stateFence: { workspaceId: string; revision: number; privacyEpoch: number },
    serializedSnapshot: string, accountGenerations: Readonly<Record<string, number>>, capture: CaptureAdoptionCheckpoint): number {
    if (ticket.kind !== 'notes.capture.adopt' || currentTicket.getStore() !== ticket || capture.id !== capture.noteId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(capture.id) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(capture.revision) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(capture.uploadId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(capture.mediaId) ||
        !/^[a-f0-9]{64}$/i.test(capture.sha256) || !Number.isSafeInteger(capture.byteLength) || capture.byteLength <= 0 ||
        !Number.isFinite(capture.durationSeconds) || capture.durationSeconds <= 0) throw new Error('capture_adoption_invalid');
    const parsed = parseCanonical(serializedSnapshot, 16 * 1024 * 1024);
    const snapshotDigest = digest(parsed.text);
    const ids = canonical(this.projectOwnedObjectIds(parsed.value), 1024 * 1024);
    const value = parsed.value as { notes?: unknown };
    if (!Array.isArray(value.notes)) throw new Error('capture_candidate_invalid');
    const matches = value.notes.filter((note) => note && typeof note === 'object' && !Array.isArray(note) &&
      (note as { id?: unknown }).id === capture.noteId) as Record<string, unknown>[];
    if (matches.length !== 1) throw new Error('capture_candidate_invalid');
    const note = matches[0]!;
    if (note.audioUri !== `still-media:${capture.mediaId}` || note.status !== 'recorded' || note.revision !== 1 || note.transcript !== '' ||
        note.durationSeconds !== capture.durationSeconds || note.capturedAt !== capture.capturedAt || note.captureTimeZone !== capture.captureTimeZone) {
      throw new Error('capture_candidate_invalid');
    }
    const receiptValue = { schemaVersion: 1, commandId: ticket.idempotencyKey, kind: 'notes.capture.adopt', objectId: capture.noteId,
      captureId: capture.id, captureRevision: capture.revision };
    const receipt = canonical(receiptValue, MAX_RECEIPT_BYTES);
    return this.kernel.withOwnedTransaction(ticket.runtimeSessionToken, ticket.privacyEpoch, (context) => {
      if (stateFence.workspaceId !== ticket.workspaceId || stateFence.revision !== context.revision ||
          stateFence.privacyEpoch !== context.privacyEpoch || context.workspaceId !== ticket.workspaceId || context.ownerId !== ticket.ownerId ||
          context.privacyEpoch !== ticket.privacyEpoch) throw new Error('capture_workspace_changed');
      const row = this.getTicketRow(context, ticket);
      if (row.status !== 'claimed' || row.command_kind !== 'notes.capture.adopt') throw new Error('capture_ticket_invalid');
      const exactRequest = canonical({ schemaVersion: 1, commandId: ticket.idempotencyKey, expectedRevision: stateFence.revision,
        expectedPrivacyEpoch: ticket.privacyEpoch, command: { kind: 'notes.capture.adopt', captureId: capture.id, captureRevision: capture.revision } }, 16 * 1024);
      if (digest(`${ticket.kind}\0${exactRequest.text}`) !== row.request_digest) throw new Error('capture_command_binding_mismatch');
      const priorSnapshot = context.db.prepare('SELECT snapshot_json FROM workspaces WHERE id=? AND revision=? AND privacy_epoch=?')
        .get(context.workspaceId, context.revision, context.privacyEpoch) as { snapshot_json: string } | undefined;
      if (!priorSnapshot) throw new Error('capture_workspace_changed');
      const prior = parseCanonical(priorSnapshot.snapshot_json, 16 * 1024 * 1024).value as { notes?: unknown };
      if (Array.isArray(prior.notes) && prior.notes.some((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) &&
        (entry as { id?: unknown }).id === capture.noteId)) throw new Error('capture_already_attached');
      const upload = context.db.prepare(`SELECT c.*,u.status AS audio_status,u.media_id AS audio_media_id,u.sha256 AS audio_sha256,
        u.byte_length AS audio_byte_length,u.duration_seconds AS audio_duration,u.format AS audio_format,u.mime_type AS audio_mime
        FROM private_audio_capture_uploads c JOIN private_audio_uploads u ON u.upload_id=c.upload_id
        WHERE c.capture_id=? AND c.capture_revision=? AND c.workspace_id=? AND c.owner_id=? AND c.privacy_epoch=?`)
        .get(capture.id, capture.revision, context.workspaceId, context.ownerId, context.privacyEpoch) as {
          upload_id: string; media_id: string; format: string; sha256: string | null; byte_length: number | null; duration_seconds: number | null;
          mime_type: string; status: string; workspace_id: string; owner_id: string; privacy_epoch: number; captured_at: string; time_zone: string;
          audio_status: string; audio_media_id: string; audio_sha256: string | null; audio_byte_length: number | null; audio_duration: number | null;
          audio_format: string; audio_mime: string;
        } | undefined;
      if (!upload || upload.status !== 'ready' || upload.audio_status !== 'ready' || upload.upload_id !== capture.uploadId ||
          upload.media_id !== capture.mediaId || upload.audio_media_id !== capture.mediaId || upload.sha256 !== capture.sha256 || upload.audio_sha256 !== capture.sha256 ||
          upload.byte_length !== capture.byteLength || upload.audio_byte_length !== capture.byteLength || upload.duration_seconds !== capture.durationSeconds ||
          upload.audio_duration !== capture.durationSeconds || upload.format !== capture.format || upload.audio_format !== capture.format ||
          upload.mime_type !== capture.mimeType || upload.audio_mime !== capture.mimeType || upload.captured_at !== capture.capturedAt ||
          upload.time_zone !== capture.captureTimeZone) throw new Error('capture_upload_unavailable');
      const idempotencyKey = randomUUID();
      const result = this.kernel.runLocalCommand(ticket.runtimeSessionToken, {
        expectedRevision: context.revision, expectedPrivacyEpoch: context.privacyEpoch, idempotencyKey, type: 'workspace.snapshot.write',
        canonicalRequest: canonical({ command: ticket.idempotencyKey, snapshotDigest }).text,
      }, () => ({ snapshot: parsed.value, receipt: { kind: 'workspace_snapshot_capture_adoption', snapshotDigest }, accountGenerations }));
      const consumed = context.db.prepare(`UPDATE private_audio_capture_uploads SET status='consumed',consumed_command_id=?,note_id=?,note_revision=1,updated_at=?
        WHERE upload_id=? AND capture_id=? AND capture_revision=? AND status='ready' AND workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .run(ticket.idempotencyKey, capture.noteId, this.clock(), capture.uploadId, capture.id, capture.revision, context.workspaceId, context.ownerId, context.privacyEpoch);
      if (consumed.changes !== 1) throw new Error('capture_consume_conflict');
      const updated = context.db.prepare(`UPDATE async_command_journal SET status='finished',updated_at=?,checkpoint_revision=?,snapshot_digest=?,owned_object_ids_json=?,receipt_json=?
        WHERE workspace_id=? AND idempotency_key=? AND ticket_id=? AND ticket_digest=? AND status='claimed'`)
        .run(this.clock(), result.revision, snapshotDigest, ids.text, receipt.text, ticket.workspaceId, ticket.idempotencyKey, ticket.ticketId, digest(ticket.capability));
      if (updated.changes !== 1) throw new Error('capture_command_receipt_conflict');
      return result.revision;
    });
  }

  finish(ticket: CommandTicketContext, receiptValue: unknown): JsonValue {
    const receipt = canonical(receiptValue, MAX_RECEIPT_BYTES);
    return this.kernel.withOwnedTransaction(ticket.runtimeSessionToken, ticket.privacyEpoch, (context) => {
      const row = this.getTicketRow(context, ticket);
      if (row.status === 'finished') {
        if (row.receipt_json !== receipt.text) throw new Error('The command already finished with a different receipt.');
        return parseJson(row.receipt_json);
      }
      if (row.status === 'inspect_required') throw new Error('This command requires manual inspection and cannot be finished automatically.');
      if (ticket.kind === 'accounts.installoauth') throw new Error('oauth_install_checkpoint_required');
      if (ticket.kind === 'notes.transcribe' && receipt.value && typeof receipt.value === 'object' && !Array.isArray(receipt.value) &&
          (receipt.value as Record<string, JsonValue>).kind === 'notes.transcribe') {
        this.validateTranscriptionFinish(context, row, receipt.value as Record<string, JsonValue>);
      }
      const update = context.db.prepare(`UPDATE async_command_journal SET status='finished',updated_at=?,receipt_json=?
        WHERE workspace_id=? AND idempotency_key=? AND ticket_id=? AND ticket_digest=? AND status IN ('claimed','checkpointed')`)
        .run(this.clock(), receipt.text, ticket.workspaceId, ticket.idempotencyKey, ticket.ticketId, digest(ticket.capability));
      if (update.changes !== 1) throw new Error('The command finish receipt could not be recorded.');
      return receipt.value;
    });
  }

  /** Bind the named public transcription receipt to its exact durable local terminal checkpoint. */
  private validateTranscriptionFinish(context: OwnedTransactionContext, row: JournalRow,
    receipt: Record<string, JsonValue>): void {
    const fields = ['attemptId', 'commandId', 'kind', 'objectId', 'outcome', 'schemaVersion', 'sourceRevision'].sort();
    if (Object.keys(receipt).sort().join('\0') !== fields.join('\0') || receipt.schemaVersion !== 1 ||
        receipt.commandId !== row.idempotency_key || receipt.kind !== 'notes.transcribe' ||
        typeof receipt.objectId !== 'string' || receipt.objectId.length === 0 || Buffer.byteLength(receipt.objectId, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(receipt.objectId) ||
        typeof receipt.attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.attemptId) ||
        typeof receipt.sourceRevision !== 'number' || !Number.isSafeInteger(receipt.sourceRevision) || receipt.sourceRevision < 1 ||
        typeof receipt.outcome !== 'string' || !['completed', 'no_speech', 'cancelled', 'failed', 'unknown', 'discarded'].includes(receipt.outcome)) {
      throw new Error('transcription_receipt_binding_invalid');
    }
    if (row.checkpoint_revision === null || row.checkpoint_revision !== context.revision || !row.snapshot_digest) {
      throw new Error('transcription_terminal_checkpoint_unavailable');
    }
    const stored = context.db.prepare('SELECT snapshot_json FROM workspaces WHERE id=? AND revision=? AND privacy_epoch=?')
      .get(context.workspaceId, context.revision, context.privacyEpoch) as { snapshot_json: string } | undefined;
    if (!stored) throw new Error('transcription_terminal_checkpoint_unavailable');
    const snapshot = parseCanonical(stored.snapshot_json, 16 * 1024 * 1024);
    if (digest(snapshot.text) !== row.snapshot_digest) throw new Error('transcription_terminal_checkpoint_mismatch');
    const transcription = (snapshot.value && typeof snapshot.value === 'object' && !Array.isArray(snapshot.value)
      ? (snapshot.value as Record<string, JsonValue>).transcription : undefined) as Record<string, JsonValue> | undefined;
    const attempts = transcription?.attempts;
    const attempt = Array.isArray(attempts) ? attempts.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
      (candidate as Record<string, JsonValue>).id === receipt.attemptId) as Record<string, JsonValue> | undefined : undefined;
    const terminalAt = attempt?.terminalAt;
    if (!attempt || attempt.noteId !== receipt.objectId || attempt.sourceRevision !== receipt.sourceRevision || attempt.outcome !== receipt.outcome ||
        typeof terminalAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(terminalAt) ||
        new Date(terminalAt).toISOString() !== terminalAt || !['completed', 'no_speech', 'cancelled', 'failed', 'unknown', 'discarded'].includes(String(attempt.outcome))) {
      throw new Error('transcription_terminal_checkpoint_mismatch');
    }
  }

  requireInspection(ticket: CommandTicketContext): void {
    this.kernel.withOwnedTransaction(ticket.runtimeSessionToken, ticket.privacyEpoch, (context) => {
      this.getTicketRow(context, ticket);
      context.db.prepare(`UPDATE async_command_journal SET status='inspect_required',updated_at=?,receipt_json=NULL
        WHERE workspace_id=? AND idempotency_key=? AND ticket_id=? AND ticket_digest=? AND status IN ('claimed','checkpointed')`)
        .run(this.clock(), ticket.workspaceId, ticket.idempotencyKey, ticket.ticketId, digest(ticket.capability));
    });
  }

  /**
   * TRUSTED INTERNAL ONLY. A single-lease speech cleanup child may be recorded
   * only inside the exact live command execution that owns the lease. This is
   * deliberately registration-specific: it does not expose a general ticket
   * transaction or allow finished tickets to mutate workspace state.
   */
  withActiveSpeechCleanupRegistration<T>(ticket: CommandTicketContext,
    register: (context: OwnedTransactionContext) => T): T {
    if (!ticket || currentTicket.getStore() !== ticket) throw new Error('Speech cleanup registration requires the current command ticket.');
    return this.kernel.withOwnedTransaction(ticket.runtimeSessionToken, ticket.privacyEpoch, (context) => {
      if (currentTicket.getStore() !== ticket) throw new Error('Speech cleanup registration lost its active command context.');
      const row = this.getTicketRow(context, ticket);
      if (row.status !== 'claimed' && row.status !== 'checkpointed') {
        throw new Error('Speech cleanup registration requires an active command parent.');
      }
      return register(context);
    });
  }

  /** Mark claims left by a previous process as ambiguous; never replay their operation. */
  recoverInterrupted(verifyExclusiveProcessOwnership: () => boolean, workspaceId?: string): number {
    if (typeof verifyExclusiveProcessOwnership !== 'function' || verifyExclusiveProcessOwnership() !== true) {
      throw new Error('Interrupted command recovery requires verified exclusive process ownership.');
    }
    return this.kernel.withTrustedDatabaseTransaction((db) => {
      const result = workspaceId
        ? db.prepare(`UPDATE async_command_journal SET status='inspect_required',updated_at=? WHERE workspace_id=? AND status IN ('claimed','checkpointed')`).run(this.clock(), workspaceId)
        : db.prepare(`UPDATE async_command_journal SET status='inspect_required',updated_at=? WHERE status IN ('claimed','checkpointed')`).run(this.clock());
      return result.changes;
    });
  }

  inspect(sessionToken: string, idempotencyKey: string): CommandAdmission {
    const result = this.inspectIfExists(sessionToken, idempotencyKey);
    if (!result) throw new Error('The command receipt was not found.');
    return result;
  }

  /** Authenticated read-only receipt lookup; absence is distinct from any recorded status. */
  inspectIfExists(sessionToken: string, idempotencyKey: string): CommandAdmission | undefined {
    requireKey(idempotencyKey);
    const identity = this.kernel.getOwnedIdentity(sessionToken);
    return this.kernel.withOwnedTransaction(sessionToken, identity.privacyEpoch, (context) => {
      const row = context.db.prepare(`SELECT * FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`)
        .get(context.workspaceId, idempotencyKey) as JournalRow | undefined;
      if (!row) return undefined;
      if (row.owner_id !== context.ownerId || row.workspace_id !== context.workspaceId || row.privacy_epoch !== context.privacyEpoch) throw new Error('The command receipt belongs to another workspace or privacy epoch.');
      return Object.freeze({ fresh: false, status: row.status,
        commandKind: row.command_kind,
        ...(row.receipt_json ? { receipt: parseJson(row.receipt_json) } : {}),
        ...(row.checkpoint_revision === null ? {} : { checkpointRevision: row.checkpoint_revision }) });
    });
  }

  /** Authenticated, bounded history projection; never exposes request or receipt bodies. */
  historyPage(sessionToken: string, rawCursor?: unknown): WorkspaceCommandHistoryPage {
    const identity = this.kernel.getOwnedIdentity(sessionToken);
    const scope = historyScope(identity.ownerId, identity.workspaceId, identity.privacyEpoch);
    const cursor = rawCursor === undefined ? undefined : decodeHistoryCursor(rawCursor, scope);
    const publicKinds = WORKSPACE_COMMAND_HISTORY_KINDS.map(workspaceCommandKindToJournal);
    const placeholders = publicKinds.map(() => '?').join(',');
    const uuidGlob = historyUuidGlob();
    return this.kernel.withOwnedTransaction(sessionToken, identity.privacyEpoch, (context) => {
      if (context.workspaceId !== identity.workspaceId || context.ownerId !== identity.ownerId || context.privacyEpoch !== identity.privacyEpoch) {
        throw new Error('workspace_ownership_changed');
      }
      if (cursor) {
        const anchor = context.db.prepare(`SELECT created_at FROM async_command_journal
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND idempotency_key=? AND created_at=?
            AND command_kind IN (${placeholders}) AND idempotency_key GLOB ?`)
          .get(context.workspaceId, context.ownerId, context.privacyEpoch, cursor.commandId, cursor.createdAt,
            ...publicKinds, uuidGlob) as { created_at: number } | undefined;
        if (!anchor) throw new Error('command_history_cursor_invalid');
      }
      const rows = context.db.prepare(`SELECT idempotency_key,command_kind,status,created_at,updated_at FROM async_command_journal
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND command_kind IN (${placeholders}) AND idempotency_key GLOB ?
          ${cursor ? 'AND (created_at<? OR (created_at=? AND idempotency_key<?))' : ''}
        ORDER BY created_at DESC,idempotency_key DESC LIMIT ?`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch, ...publicKinds, uuidGlob,
          ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.commandId] : []), WORKSPACE_COMMAND_HISTORY_PAGE_SIZE + 1) as HistoryRow[];
      const hasMore = rows.length > WORKSPACE_COMMAND_HISTORY_PAGE_SIZE;
      const pageRows = rows.slice(0, WORKSPACE_COMMAND_HISTORY_PAGE_SIZE);
      const entries: WorkspaceCommandHistoryEntry[] = pageRows.map((row) => {
        const kind = workspaceCommandKindFromJournal(row.command_kind);
        if (!kind || !isWorkspaceCommandId(row.idempotency_key) || !['claimed', 'checkpointed', 'finished', 'inspect_required'].includes(row.status) ||
            !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at)) throw new Error('command_history_projection_invalid');
        return Object.freeze({ commandId: row.idempotency_key, kind, status: row.status,
          createdAt: row.created_at, updatedAt: row.updated_at });
      });
      const last = hasMore ? pageRows.at(-1) : undefined;
      const nextCursor = last ? encodeHistoryCursor({ v: 1, scope, createdAt: last.created_at, commandId: last.idempotency_key }) : undefined;
      return Object.freeze({ schemaVersion: 1 as const, entries: Object.freeze(entries), ...(nextCursor ? { nextCursor } : {}) });
    });
  }

  private getTicketRow(context: OwnedTransactionContext, ticket: CommandTicketContext): JournalRow {
    context.assertActive();
    if (context.workspaceId !== ticket.workspaceId || context.ownerId !== ticket.ownerId || context.privacyEpoch !== ticket.privacyEpoch) {
      throw new Error('The command runtime session does not own this ticket workspace.');
    }
    const row = context.db.prepare(`SELECT * FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`)
      .get(ticket.workspaceId, ticket.idempotencyKey) as JournalRow | undefined;
    if (!row || row.owner_id !== ticket.ownerId || row.privacy_epoch !== ticket.privacyEpoch || row.command_kind !== ticket.kind ||
      row.request_digest !== ticket.requestDigest || row.ticket_id !== ticket.ticketId || row.ticket_digest !== digest(ticket.capability) ||
      row.session_digest !== ticket.admissionSessionDigest || row.initiating_session_binding !== (ticket.initiatingSessionBinding ?? null) ||
      (row.command_kind === 'accounts.installoauth' && (!row.initiating_session_binding || !ticket.oauthInstallStageId || !UUID_V4.test(ticket.oauthInstallStageId)))) {
      throw new Error('The command ticket is invalid for this workspace session.');
    }
    return row;
  }

  private clock(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('The command journal clock is invalid.');
    return value;
  }
}

function validateOAuthInstallCandidate(context: OwnedTransactionContext, kernel: DurableKernel, snapshotValue: JsonValue,
  accountGenerations: Readonly<Record<string, number>>, checkpoint: OAuthInstallCheckpoint, payload: OAuthVerifiedPayload,
  lifecycle: OAuthReconnectLifecycle | undefined, journalRow: JournalRow): void {
  if (journalRow.initiating_session_binding === null || payload.provider !== (payload.identity.providerNamespace) ||
      (payload.provider !== 'google' && payload.provider !== 'microsoft')) throw new Error('oauth_install_stage_invalid');
  const stored = context.db.prepare('SELECT snapshot_json FROM workspaces WHERE id=? AND revision=? AND privacy_epoch=?')
    .get(context.workspaceId, context.revision, context.privacyEpoch) as { snapshot_json: string } | undefined;
  if (!stored) throw new Error('oauth_install_workspace_changed');
  const priorRoot = parseCanonical(stored.snapshot_json, 16 * 1024 * 1024).value;
  const priorAccounts = readAccountArray(priorRoot);
  const candidateAccounts = readAccountArray(snapshotValue);
  const previousForId = priorAccounts.filter((account) => account.id === checkpoint.accountId);
  const candidatesForId = candidateAccounts.filter((account) => account.id === checkpoint.accountId);
  if (candidatesForId.length !== 1) throw new Error('oauth_install_candidate_invalid');
  const priorAccount = previousForId.length === 1 ? previousForId[0] : undefined;
  if (previousForId.length > 1) throw new Error('oauth_install_snapshot_corrupt');
  if (lifecycle) {
    if (lifecycle.accountId !== checkpoint.accountId || !priorAccount || priorAccount.connectionGeneration !== lifecycle.connectionGeneration ||
        priorAccount.tokenRef !== lifecycle.tokenRef || priorAccount.connected !== lifecycle.connected || priorAccount.authStatus !== lifecycle.authStatus ||
        !sameJson(priorAccount.identity ?? null, lifecycle.identity ?? null)) throw new Error('oauth_install_lifecycle_changed');
  } else if (priorAccount || priorAccounts.some((account) => sameJson(account.identity ?? null, payload.identity))) {
    throw new Error('oauth_install_identity_already_present');
  }
  if (candidateAccounts.some((account) => account !== candidatesForId[0] && account.id === checkpoint.accountId) ||
      candidateAccounts.some((account) => account !== candidatesForId[0] && sameJson(account.identity ?? null, payload.identity))) {
    throw new Error('oauth_install_candidate_duplicate');
  }

  const storedGeneration = context.db.prepare('SELECT generation FROM account_generations WHERE workspace_id=? AND account_id=?')
    .get(context.workspaceId, checkpoint.accountId) as { generation: number } | undefined;
  const oldGeneration = storedGeneration?.generation ?? 0;
  if (!Number.isSafeInteger(oldGeneration) || oldGeneration < 0 || lifecycle && oldGeneration !== lifecycle.connectionGeneration) {
    throw new Error('oauth_install_account_generation_changed');
  }
  const expectedGeneration = oldGeneration + 1;
  if (!Number.isSafeInteger(expectedGeneration) || checkpoint.accountGeneration !== expectedGeneration ||
      candidateAccounts[0] === undefined || accountGenerations[checkpoint.accountId] !== expectedGeneration ||
      !Object.hasOwn(accountGenerations, checkpoint.accountId)) throw new Error('oauth_install_account_generation_invalid');

  const candidate = candidatesForId[0]!;
  const priorEmail = typeof priorAccount?.email === 'string' ? priorAccount.email : '';
  const expectedEmail = (payload.email ?? priorEmail).trim().toLowerCase();
  const effective = payload.requestedCapabilities.filter((capability) => payload.capabilities.includes(capability) &&
    scopeGrantedCapabilities(payload.provider, payload.grantedScopes).includes(capability));
  const expectedCapabilities = canonical(effective).text;
  if (candidate.provider !== payload.provider || candidate.connectionGeneration !== expectedGeneration || candidate.tokenRef !== checkpoint.tokenRef ||
      !isValidOAuthTokenRef(candidate.tokenRef) || candidate.connected !== true || candidate.authStatus !== 'connected' ||
      !sameJson(candidate.identity, payload.identity) || candidate.displayName !== payload.displayName.trim() ||
      typeof candidate.email !== 'string' || candidate.email !== expectedEmail ||
      (payload.email !== undefined ? candidate.verifiedEmail !== payload.email.trim().toLowerCase() : Object.hasOwn(candidate, 'verifiedEmail')) ||
      !Array.isArray(candidate.grantedScopes) || canonical(candidate.grantedScopes).text !== canonical(payload.grantedScopes).text ||
      !Array.isArray(candidate.capabilityLimits) || canonical(candidate.capabilityLimits).text !== canonical(payload.requestedCapabilities).text ||
      !Array.isArray(candidate.capabilities) || canonical(candidate.capabilities).text !== expectedCapabilities) {
    throw new Error('oauth_install_candidate_invalid');
  }
  // A generation update in the local kernel command is intentionally the final
  // authority check for the candidate's opaque account key.
  void kernel;
}

function readAccountArray(value: JsonValue): Array<Record<string, JsonValue>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.accounts)) throw new Error('oauth_install_snapshot_invalid');
  return value.accounts.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !isValidAccountId(entry.id)) {
      throw new Error('oauth_install_snapshot_invalid');
    }
    return entry as Record<string, JsonValue>;
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonical(left).text === canonical(right).text; } catch { return false; }
}

function scopeGrantedCapabilities(provider: OAuthVerifiedPayload['provider'], scopes: readonly string[]): string[] {
  const values = new Set(scopes.map((scope) => scope.toLowerCase()));
  const has = (...candidates: string[]) => candidates.some((candidate) => values.has(candidate.toLowerCase()));
  const result: string[] = [];
  if (provider === 'google') {
    if (has('https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.metadata', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/')) result.push('mail.read');
    if (has('https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/')) result.push('mail.draft');
    if (has('https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://mail.google.com/')) result.push('mail.send');
    if (has('https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.events')) result.push('calendar.read');
    if (has('https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events')) result.push('calendar.write');
  } else {
    if (has('mail.read', 'mail.readbasic', 'mail.readwrite')) result.push('mail.read');
    if (has('mail.readwrite')) result.push('mail.draft');
    if (has('mail.send')) result.push('mail.send');
    if (has('calendars.read', 'calendars.readwrite')) result.push('calendar.read');
    if (has('calendars.readwrite')) result.push('calendar.write');
  }
  return result;
}

function parseCanonical(text: string, maxBytes = MAX_RECEIPT_BYTES): { text: string; value: JsonValue } {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Command JSON exceeds its physical byte limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Command JSON is invalid.'); }
  const result = canonical(parsed, maxBytes);
  if (result.text !== text) throw new Error('Command JSON must use canonical encoding.');
  return result;
}

function parseJson(text: string): JsonValue {
  try { return JSON.parse(text) as JsonValue; } catch { throw new Error('The saved command receipt is corrupt.'); }
}

function projectDefaultObjectIds(snapshot: unknown): OwnedObjectIds {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
  const source = snapshot as Record<string, unknown>;
  const project = (key: string): readonly string[] | undefined => {
    const value = source[key];
    if (!Array.isArray(value)) return undefined;
    const ids = value.flatMap((entry) => entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' ? [(entry as { id: string }).id] : []);
    return ids.length ? Object.freeze(ids) : undefined;
  };
  const result: { notes?: readonly string[]; tasks?: readonly string[]; proposals?: readonly string[]; accounts?: readonly string[]; documents?: readonly string[]; calendars?: readonly string[] } = {};
  const notes = project('notes'); if (notes) result.notes = notes;
  const tasks = project('tasks'); if (tasks) result.tasks = tasks;
  const proposals = project('proposals'); if (proposals) result.proposals = proposals;
  const accounts = project('accounts'); if (accounts) result.accounts = accounts;
  const documents = project('documents'); if (documents) result.documents = documents;
  const calendars = project('calendars'); if (calendars) result.calendars = calendars;
  return Object.freeze(result);
}
