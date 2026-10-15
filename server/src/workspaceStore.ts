import { createHash, randomUUID } from 'node:crypto';
import type { DurableKernel, JsonValue, OwnedTransactionContext } from './kernel.js';
import { currentCommandTicket, type CommandJournal } from './commandJournal.js';

export const SERVER_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

export interface SnapshotCommitParticipantInput<TState extends object> {
  readonly previousSnapshot: TState;
  readonly nextSnapshot: TState;
  readonly nextRevision: number;
  readonly commandId?: string;
}

/** Trusted synchronous side effects that must commit atomically with a persisted snapshot. */
export interface SnapshotCommitParticipant<TState extends object = Record<string, unknown>> {
  /** Synchronous transactional validation/checkpoint work before the snapshot revision advances. */
  beforeCommit?(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>): void;
  commit(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>): readonly string[] | void;
  /** Starts best-effort physical work only after the snapshot acknowledgement was adopted. */
  afterAcknowledged?(intentIds: readonly string[]): void;
}

/** Composes independent trusted participants without installing a second save hook. */
export function composeSnapshotCommitParticipants<TState extends object>(
  entries: readonly Readonly<{ readonly name: string; readonly participant: SnapshotCommitParticipant<TState> }>[],
): SnapshotCommitParticipant<TState> {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) throw new Error('workspace_snapshot_commit_participant_unavailable');
  const names = new Set<string>();
  const frozen = entries.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.name) || names.has(entry.name)) {
      throw new Error('workspace_snapshot_commit_participant_unavailable');
    }
    names.add(entry.name);
    validateSnapshotCommitParticipant(entry.participant);
    return Object.freeze({ name: entry.name, participant: entry.participant });
  });
  return Object.freeze({
    beforeCommit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>) => {
      for (const entry of frozen) {
        const result = entry.participant.beforeCommit?.(context, input);
        rejectAsyncParticipantResult(result);
      }
    },
    commit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>) => {
      const routed: string[] = [];
      for (const entry of frozen) {
        const result = entry.participant.commit(context, input);
        if (isPromiseLike(result)) { void Promise.resolve(result).catch(() => undefined); throw new Error('workspace_snapshot_commit_participant_must_be_synchronous'); }
        if (result !== undefined && (!Array.isArray(result) || result.some((id) => typeof id !== 'string'))) {
          throw new Error('workspace_snapshot_commit_participant_invalid_result');
        }
        for (const id of result ?? []) routed.push(`${entry.name}:${id}`);
      }
      return Object.freeze(routed);
    },
    afterAcknowledged: (routed: readonly string[]) => {
      if (!Array.isArray(routed)) return;
      for (const entry of frozen) {
        const prefix = `${entry.name}:`;
        const ids = routed.filter((value) => typeof value === 'string' && value.startsWith(prefix)).map((value) => value.slice(prefix.length));
        try { entry.participant.afterAcknowledged?.(Object.freeze(ids)); } catch { /* Durable participant work remains retryable. */ }
      }
    },
  });
}

export interface ServerWorkspaceStoreOptions<TState extends object = Record<string, unknown>> {
  readonly kernel: DurableKernel;
  /** Trusted, private kernel-issued session token. Never pass this through HTTP or browser state. */
  readonly sessionToken: string;
  readonly journal?: CommandJournal;
  /** Private Node composition hook; never populated from browser or HTTP input. */
  readonly snapshotCommitParticipant?: SnapshotCommitParticipant<TState>;
  /** Test seam for the ambiguous-ack boundary; production callers should omit it. */
  readonly afterCommitForTesting?: () => void | Promise<void>;
}

interface ServerCaptureConsumption {
  readonly id: string; readonly revision: string; readonly noteId: string; readonly uploadId: string; readonly mediaId: string;
  readonly sha256: string; readonly byteLength: number; readonly format: 'm4a' | 'mp3' | 'wav' | 'webm' | 'ogg';
  readonly mimeType: string; readonly durationSeconds: number; readonly capturedAt: string; readonly captureTimeZone: string;
}

interface OAuthInstallCheckpoint {
  readonly stageId: string; readonly stagePayloadGeneration: number; readonly accountId: string;
  readonly accountGeneration: number; readonly tokenRef: string;
}

interface LoadedWorkspace {
  workspaceId: string;
  ownerId: string;
  revision: number;
  privacyEpoch: number;
  schemaVersion: number;
}

export interface LoadedWorkspaceIdentity {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly privacyEpoch: number;
}

/** Proof of bytes actually adopted by this controller after a successful load/save acknowledgement. */
export interface LoadedWorkspaceStateProof extends LoadedWorkspaceIdentity {
  readonly schemaVersion: number;
  readonly sha256: string;
}

/** The shared controller's StateStore backed by a kernel-owned SQLite workspace snapshot. */
export class ServerWorkspaceStore<TState extends object = Record<string, unknown>> {
  private loaded?: LoadedWorkspace;
  private loadedStateProof?: LoadedWorkspaceStateProof;
  private blockedUntilLoad = false;
  private loadStarted = false;
  private saveStarted = false;
  private snapshotCommitParticipant: SnapshotCommitParticipant<TState> | undefined;

  constructor(private readonly options: ServerWorkspaceStoreOptions<TState>) {
    this.snapshotCommitParticipant = options.snapshotCommitParticipant;
    if (this.snapshotCommitParticipant) validateSnapshotCommitParticipant(this.snapshotCommitParticipant);
  }

  /** One-time private runtime installation before this store loads or commits any state. */
  installSnapshotCommitParticipant(participant: SnapshotCommitParticipant<TState>): void {
    if (this.loadStarted || this.saveStarted || this.snapshotCommitParticipant || !participant) {
      throw new Error('workspace_snapshot_commit_participant_unavailable');
    }
    validateSnapshotCommitParticipant(participant);
    this.snapshotCommitParticipant = participant;
  }

  async load(): Promise<TState | undefined> {
    this.loadStarted = true;
    const snapshot = this.options.kernel.getOwnedSnapshot(this.options.sessionToken);
    const raw = this.readExactSnapshot(snapshot.workspaceId, snapshot.revision, snapshot.privacyEpoch);
    if (raw.schemaVersion !== snapshot.schemaVersion) throw new Error('Workspace snapshot schema changed during load; reload before writing.');
    const value = parseState<TState>(raw.raw);
    this.loaded = Object.freeze({ workspaceId: snapshot.workspaceId, ownerId: raw.ownerId,
      revision: snapshot.revision, privacyEpoch: snapshot.privacyEpoch, schemaVersion: raw.schemaVersion });
    this.loadedStateProof = Object.freeze({ workspaceId: snapshot.workspaceId, ownerId: raw.ownerId,
      revision: snapshot.revision, privacyEpoch: snapshot.privacyEpoch, schemaVersion: raw.schemaVersion,
      sha256: sha256(raw.raw) });
    this.blockedUntilLoad = false;
    return value;
  }

  async readCurrentSnapshot(): Promise<{ readonly raw: string; readonly schemaVersion: number } | undefined> {
    const loaded = this.requireLoaded();
    this.assertNotAckBlocked();
    const snapshot = this.readExactSnapshot(loaded.workspaceId, loaded.revision, loaded.privacyEpoch);
    return Object.freeze({ raw: snapshot.raw, schemaVersion: snapshot.schemaVersion });
  }

  async save(state: TState, options?: { consumePendingCapture?: Readonly<{ id: string; revision: string; noteId: string }>;
    consumeServerPendingCapture?: ServerCaptureConsumption; consumeOAuthInstall?: OAuthInstallCheckpoint }): Promise<void> {
    this.saveStarted = true;
    const loaded = this.requireLoaded();
    this.assertNotAckBlocked();
    const consumeCount = Number(Boolean(options?.consumePendingCapture)) + Number(Boolean(options?.consumeServerPendingCapture)) +
      Number(Boolean(options?.consumeOAuthInstall));
    if (consumeCount > 1) throw new Error('A workspace save cannot consume multiple one-use sources.');
    const serialized = canonicalSnapshot(state);
    const accountGenerations = accountGenerationProjection(state);
    const ticket = currentCommandTicket();
    try {
      let committedRevision: number;
      let committedIntentIds: readonly string[] = Object.freeze([]);
      const participant = this.snapshotCommitParticipant;
      if (participant) {
        const committed = this.options.kernel.withOwnedTransaction(this.options.sessionToken, loaded.privacyEpoch, (context) => {
          context.assertActive();
          if (context.workspaceId !== loaded.workspaceId || context.ownerId !== loaded.ownerId ||
              context.revision !== loaded.revision || context.privacyEpoch !== loaded.privacyEpoch) {
            throw new Error('Workspace changed before the snapshot and private cleanup could commit together.');
          }
          const previous = context.db.prepare('SELECT snapshot_json,schema_version,revision,privacy_epoch FROM workspaces WHERE id=?')
            .get(context.workspaceId) as { snapshot_json: string; schema_version: number; revision: number; privacy_epoch: number } | undefined;
          if (!previous || previous.revision !== loaded.revision || previous.privacy_epoch !== loaded.privacyEpoch ||
              previous.schema_version !== loaded.schemaVersion || Buffer.byteLength(previous.snapshot_json, 'utf8') > SERVER_SNAPSHOT_MAX_BYTES) {
            throw new Error('Workspace changed while preparing the snapshot and private cleanup.');
          }
          const previousSnapshot = deepFreezeSnapshot(parseState<TState>(previous.snapshot_json));
          const nextSnapshot = deepFreezeSnapshot(JSON.parse(serialized) as TState);
          const participantInput = Object.freeze({ previousSnapshot, nextSnapshot,
            nextRevision: context.revision + 1, ...(ticket ? { commandId: ticket.idempotencyKey } : {}) });
          const beforeCommitResult = participant.beforeCommit?.(context, participantInput);
          rejectAsyncParticipantResult(beforeCommitResult);
          const revision = this.commitExistingSnapshotPath(loaded, serialized, accountGenerations, ticket, options);
          if (revision !== participantInput.nextRevision) throw new Error('workspace_snapshot_commit_revision_mismatch');
          context.assertActive();
          const intentIds = participant.commit(context, participantInput);
          if (isPromiseLike(intentIds)) { void Promise.resolve(intentIds).catch(() => undefined); throw new Error('workspace_snapshot_commit_participant_must_be_synchronous'); }
          if (intentIds !== undefined && (!Array.isArray(intentIds) || intentIds.some((id) => typeof id !== 'string'))) {
            throw new Error('workspace_snapshot_commit_participant_invalid_result');
          }
          return Object.freeze({ revision, intentIds: Object.freeze([...(intentIds ?? [])]) });
        });
        committedRevision = committed.revision;
        committedIntentIds = committed.intentIds;
      } else if (ticket) {
        committedRevision = this.commitExistingSnapshotPath(loaded, serialized, accountGenerations, ticket, options);
      } else {
        committedRevision = this.commitExistingSnapshotPath(loaded, serialized, accountGenerations, ticket, options);
      }
      await this.options.afterCommitForTesting?.();
      this.loaded = Object.freeze({ ...loaded, revision: committedRevision });
      this.loadedStateProof = Object.freeze({ workspaceId: loaded.workspaceId, ownerId: loaded.ownerId,
        revision: committedRevision, privacyEpoch: loaded.privacyEpoch, schemaVersion: loaded.schemaVersion,
        sha256: sha256(serialized) });
      try {
        const acknowledgement = participant?.afterAcknowledged?.(committedIntentIds);
        if (isPromiseLike(acknowledgement)) void Promise.resolve(acknowledgement).catch(() => undefined);
      } catch { /* Durable pending intents resume on explicit retry or a later runtime start. */ }
    } catch (error) {
      // A command may have committed before its acknowledgement was lost. Never
      // allow this in-memory controller to overwrite that newer workspace.
      this.blockedUntilLoad = true;
      throw error;
    }
  }

  async clear(): Promise<void> {
    throw new Error('Server workspace state can only be removed by the explicit privacy erase workflow.');
  }

  async assertCurrent(): Promise<void> {
    const loaded = this.requireLoaded();
    this.assertNotAckBlocked();
    const current = this.options.kernel.getOwnedIdentity(this.options.sessionToken);
    if (current.workspaceId !== loaded.workspaceId || current.ownerId !== loaded.ownerId ||
        current.revision !== loaded.revision || current.privacyEpoch !== loaded.privacyEpoch) {
      throw new Error('Workspace changed in another runtime. Reload the current workspace before continuing.');
    }
  }

  getOwnedIdentity(): { readonly workspaceId: string; readonly ownerId: string; readonly revision: number; readonly privacyEpoch: number } {
    return this.options.kernel.getOwnedIdentity(this.options.sessionToken);
  }

  /** The identity loaded by this controller, not a claim about the current database head. */
  getLoadedIdentity(): LoadedWorkspaceIdentity {
    const loaded = this.requireLoaded();
    this.assertNotAckBlocked();
    return Object.freeze({ workspaceId: loaded.workspaceId, ownerId: loaded.ownerId,
      revision: loaded.revision, privacyEpoch: loaded.privacyEpoch });
  }

  /** Private acknowledgement proof; it never rereads the DB to manufacture adoption evidence. */
  getLoadedStateProof(): LoadedWorkspaceStateProof {
    const loaded = this.requireLoaded();
    this.assertNotAckBlocked();
    const proof = this.loadedStateProof;
    if (!proof || proof.workspaceId !== loaded.workspaceId || proof.ownerId !== loaded.ownerId ||
        proof.revision !== loaded.revision || proof.privacyEpoch !== loaded.privacyEpoch || proof.schemaVersion !== loaded.schemaVersion) {
      throw new Error('The loaded workspace state proof is unavailable.');
    }
    return Object.freeze({ ...proof });
  }

  private commitSnapshot(loaded: LoadedWorkspace, serialized: string, accountGenerations: Readonly<Record<string, number>>): number {
    const parsed = JSON.parse(serialized) as JsonValue;
    const snapshotDigest = sha256(serialized);
    const receipt = this.options.kernel.runLocalCommand(this.options.sessionToken, {
      expectedRevision: loaded.revision,
      expectedPrivacyEpoch: loaded.privacyEpoch,
      idempotencyKey: randomUUID(),
      type: 'workspace.snapshot.write',
      canonicalRequest: canonicalJson({ snapshotDigest }),
    }, () => ({ snapshot: parsed, receipt: { kind: 'workspace_snapshot_write', snapshotDigest }, accountGenerations }));
    if (receipt.privacyEpoch !== loaded.privacyEpoch) throw new Error('Workspace privacy epoch changed during state save.');
    return receipt.revision;
  }

  private commitExistingSnapshotPath(loaded: LoadedWorkspace, serialized: string, accountGenerations: Readonly<Record<string, number>>,
    ticket: ReturnType<typeof currentCommandTicket>, options?: { consumePendingCapture?: Readonly<{ id: string; revision: string; noteId: string }>;
      consumeServerPendingCapture?: ServerCaptureConsumption; consumeOAuthInstall?: OAuthInstallCheckpoint }): number {
    if (ticket) {
      if (!this.options.journal) throw new Error('An asynchronous command cannot checkpoint without its durable command journal.');
      const fence = { workspaceId: loaded.workspaceId, revision: loaded.revision, privacyEpoch: loaded.privacyEpoch };
      if (options?.consumeOAuthInstall) {
        return this.options.journal.checkpointOAuthInstall(ticket, fence, serialized, accountGenerations, options.consumeOAuthInstall);
      }
      if (options?.consumeServerPendingCapture) {
        return this.options.journal.checkpointCapture(ticket, fence, serialized, accountGenerations, options.consumeServerPendingCapture);
      }
      if (options?.consumePendingCapture || options?.consumeOAuthInstall) throw new Error('A one-use install/capture requires its exact active journal command.');
      return this.options.journal.checkpoint(ticket, fence, serialized, accountGenerations);
    }
    if (options?.consumePendingCapture || options?.consumeServerPendingCapture || options?.consumeOAuthInstall) {
      throw new Error('A one-use install/capture requires an active journal command.');
    }
    return this.commitSnapshot(loaded, serialized, accountGenerations);
  }

  private readExactSnapshot(expectedWorkspaceId: string, expectedRevision: number, expectedPrivacyEpoch: number): { raw: string; schemaVersion: number; ownerId: string } {
    const raw = this.options.kernel.withOwnedTransaction(this.options.sessionToken, expectedPrivacyEpoch, (context) => {
      if (context.revision !== expectedRevision || context.privacyEpoch !== expectedPrivacyEpoch ||
          context.workspaceId !== expectedWorkspaceId) throw new Error('Workspace changed while reading its snapshot; reload the current workspace.');
      const row = context.db.prepare('SELECT snapshot_json,schema_version,revision,privacy_epoch FROM workspaces WHERE id=?')
        .get(context.workspaceId) as { snapshot_json: string; schema_version: number; revision: number; privacy_epoch: number } | undefined;
      if (!row || row.revision !== expectedRevision || row.privacy_epoch !== expectedPrivacyEpoch) throw new Error('Workspace changed while reading its snapshot; reload the current workspace.');
      if (Buffer.byteLength(row.snapshot_json, 'utf8') > SERVER_SNAPSHOT_MAX_BYTES) throw new Error('Saved workspace exceeds the 16 MiB snapshot read limit.');
      return Object.freeze({ raw: row.snapshot_json, schemaVersion: row.schema_version, ownerId: context.ownerId });
    });
    return raw;
  }

  private requireLoaded(): LoadedWorkspace {
    if (!this.loaded) throw new Error('Load the current workspace before reading or writing it.');
    return this.loaded;
  }

  private assertNotAckBlocked(): void {
    if (this.blockedUntilLoad) throw new Error('A workspace write acknowledgement was lost. Explicitly reload the workspace before writing again.');
  }
}

function parseState<TState extends object>(raw: string): TState {
  if (Buffer.byteLength(raw, 'utf8') > SERVER_SNAPSHOT_MAX_BYTES) throw new Error('Saved workspace exceeds the 16 MiB snapshot read limit.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Saved workspace snapshot is invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved workspace snapshot must be an object.');
  return value as TState;
}

function deepFreezeSnapshot<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeSnapshot(child);
  return Object.freeze(value);
}

function canonicalSnapshot(state: object): string {
  let parsed: unknown;
  try { parsed = JSON.parse(JSON.stringify(state)); } catch { throw new Error('Workspace state cannot be serialized as JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Workspace state must serialize to a JSON object.');
  const canonical = canonicalValue(parsed);
  const raw = JSON.stringify(canonical);
  if (Buffer.byteLength(raw, 'utf8') > SERVER_SNAPSHOT_MAX_BYTES) throw new Error('The complete saved data would exceed the 16 MiB server storage limit.');
  return raw;
}

function canonicalValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return result;
  }
  throw new Error('Workspace state contains a value that cannot be persisted as JSON.');
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonicalValue(value)); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function';
}
function rejectAsyncParticipantResult(value: unknown): void {
  if (!isPromiseLike(value)) return;
  void Promise.resolve(value).catch(() => undefined);
  throw new Error('workspace_snapshot_commit_participant_must_be_synchronous');
}
function validateSnapshotCommitParticipant<TState extends object>(participant: SnapshotCommitParticipant<TState>): void {
  if (!participant || typeof participant !== 'object' || typeof participant.commit !== 'function' ||
      participant.commit.constructor?.name === 'AsyncFunction' || participant.beforeCommit !== undefined &&
      (typeof participant.beforeCommit !== 'function' || participant.beforeCommit.constructor?.name === 'AsyncFunction') || participant.afterAcknowledged !== undefined &&
      (typeof participant.afterAcknowledged !== 'function' || participant.afterAcknowledged.constructor?.name === 'AsyncFunction')) {
    throw new Error('workspace_snapshot_commit_participant_unavailable');
  }
}

function accountGenerationProjection(state: object): Readonly<Record<string, number>> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  const accounts: unknown = (state as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) throw new Error('Saved workspace account list is invalid.');
  for (const value of accounts) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { id?: unknown }).id !== 'string') throw new Error('Saved workspace account identity is invalid.');
    const account = value as { id: string; connectionGeneration?: unknown };
    if (account.connectionGeneration === undefined) continue;
    if (!Number.isSafeInteger(account.connectionGeneration) || (account.connectionGeneration as number) < 0) throw new Error('Saved account generation is invalid.');
    result[account.id] = account.connectionGeneration as number;
  }
  return Object.freeze(result);
}

export function createServerWorkspaceStore<TState extends object = Record<string, unknown>>(options: ServerWorkspaceStoreOptions<TState>): ServerWorkspaceStore<TState> {
  return new ServerWorkspaceStore<TState>(options);
}
