import { createHash, randomUUID } from 'node:crypto';
import type { DurableKernel, JsonValue } from './kernel.js';
import { currentCommandTicket, type CommandJournal } from './commandJournal.js';

export const SERVER_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

export interface ServerWorkspaceStoreOptions {
  readonly kernel: DurableKernel;
  /** Trusted, private kernel-issued session token. Never pass this through HTTP or browser state. */
  readonly sessionToken: string;
  readonly journal?: CommandJournal;
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

  constructor(private readonly options: ServerWorkspaceStoreOptions) {}

  async load(): Promise<TState | undefined> {
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
      if (ticket) {
        if (!this.options.journal) throw new Error('An asynchronous command cannot checkpoint without its durable command journal.');
        const fence = { workspaceId: loaded.workspaceId, revision: loaded.revision, privacyEpoch: loaded.privacyEpoch };
        if (options?.consumeOAuthInstall) {
          committedRevision = this.options.journal.checkpointOAuthInstall(ticket, fence, serialized, accountGenerations, options.consumeOAuthInstall);
        } else if (options?.consumeServerPendingCapture) {
          committedRevision = this.options.journal.checkpointCapture(ticket, fence, serialized, accountGenerations, options.consumeServerPendingCapture);
        } else {
          if (options?.consumePendingCapture || options?.consumeOAuthInstall) throw new Error('A one-use install/capture requires its exact active journal command.');
          committedRevision = this.options.journal.checkpoint(ticket, fence, serialized, accountGenerations);
        }
      } else {
        if (options?.consumePendingCapture || options?.consumeServerPendingCapture || options?.consumeOAuthInstall) throw new Error('A one-use install/capture requires an active journal command.');
        committedRevision = this.commitSnapshot(loaded, serialized, accountGenerations);
      }
      await this.options.afterCommitForTesting?.();
      this.loaded = Object.freeze({ ...loaded, revision: committedRevision });
      this.loadedStateProof = Object.freeze({ workspaceId: loaded.workspaceId, ownerId: loaded.ownerId,
        revision: committedRevision, privacyEpoch: loaded.privacyEpoch, schemaVersion: loaded.schemaVersion,
        sha256: sha256(serialized) });
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

export function createServerWorkspaceStore<TState extends object = Record<string, unknown>>(options: ServerWorkspaceStoreOptions): ServerWorkspaceStore<TState> {
  return new ServerWorkspaceStore<TState>(options);
}
