import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CommandReceipt, DurableKernel, JsonValue, OwnedTransactionContext } from './kernel.js';
import { currentCommandTicket, type CommandJournal } from './commandJournal.js';
import type { LoadedWorkspaceStateProof } from './workspaceStore.js';

const SCHEMA_VERSION = 1;
const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLEANUP_TYPE = 'speech.cleanup.child.settle';
const SPEECH_PARENT_KIND = 'notes.transcribe';
const STATUS = new Set(['owned', 'pending_cleanup', 'released', 'inspect_required']);

export type SpeechCleanupProvider = 'azure' | 'openrouter';
export type SpeechCleanupOutcome = 'pending_cleanup' | 'released';
export type SpeechCleanupChildStatus = 'owned' | 'pending_cleanup' | 'released' | 'inspect_required';

/** An in-memory capability. The durable child ID alone never restores this handle after restart. */
export interface SpeechCleanupChildHandle {
  readonly childId: string;
}

export interface SpeechCleanupRegistration {
  readonly attemptId: string;
  readonly leaseId: string;
  readonly noteId: string;
  readonly provider: SpeechCleanupProvider;
}

export interface SpeechCleanupChildInspection {
  readonly childId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly parentTicketId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly noteId: string;
  readonly provider: SpeechCleanupProvider;
  readonly status: SpeechCleanupChildStatus;
  readonly refreshRequired?: true;
  readonly lastSettlement?: Readonly<{ outcome: SpeechCleanupOutcome; revision: number; idempotencyKey: string }>;
}

export interface SpeechCleanupSettlement {
  readonly childId: string;
  readonly outcome: SpeechCleanupOutcome;
  /** This is the committed revision, not a promise that an in-memory controller adopted it. */
  readonly revision: number;
  readonly replayed: boolean;
}

export interface SpeechCleanupSettlementProof {
  readonly childId: string;
  readonly outcome: SpeechCleanupOutcome;
  readonly idempotencyKey: string;
  readonly revision: number;
}

export interface SpeechCleanupChildrenOptions {
  readonly kernel: DurableKernel;
  readonly journal: CommandJournal;
  /** Private kernel-issued actor; never an HTTP-supplied token. */
  readonly runtimeSessionToken: string;
  /** Fresh UUIDv4 per host process and shared by every service instance in that process. */
  readonly processInstanceId: string;
  readonly now?: () => number;
  /** Test seam for a lost acknowledgement after the SQLite transaction committed. */
  readonly afterCommitForTesting?: () => void;
}

interface ChildRow {
  child_id: string;
  workspace_id: string;
  owner_id: string;
  privacy_epoch: number;
  parent_ticket_id: string;
  parent_idempotency_key: string;
  parent_kind: string;
  parent_request_digest: string;
  attempt_id: string;
  lease_id: string;
  note_id: string;
  provider: SpeechCleanupProvider;
  binding_json: string;
  binding_digest: string;
  process_instance_id: string;
  status: SpeechCleanupChildStatus;
  last_settlement_key: string | null;
  created_at: number;
  updated_at: number;
}

interface CommandRow {
  request_digest: string;
  command_type: string;
  privacy_epoch: number;
  status: string;
  result_json: string;
  committed_revision: number;
}

interface HandleBinding {
  readonly row: Pick<ChildRow, 'child_id' | 'workspace_id' | 'owner_id' | 'privacy_epoch' | 'binding_digest' | 'process_instance_id'>;
}

/**
 * Private durable ownership evidence for one speech cleanup lease. A trusted
 * caller must first persist the exact lease under the active transcription
 * command, then register it here; this service does not prove who created it.
 * It never retains a provider callback or performs provider I/O. A restart
 * makes unresolved rows inspection-only without rewriting their evidence.
 */
export class SpeechCleanupChildren {
  private readonly handles = new WeakMap<object, HandleBinding>();
  private readonly handleByChildId = new Map<string, WeakRef<SpeechCleanupChildHandle>>();
  private readonly refreshRequiredChildren = new Set<string>();
  private readonly now: () => number;
  private readonly afterCommitForTesting: (() => void) | undefined;

  constructor(private readonly options: SpeechCleanupChildrenOptions) {
    requireUuid(options.processInstanceId, 'Speech cleanup process instance');
    if (!options.runtimeSessionToken) throw new Error('A private runtime session is required for speech cleanup children.');
    this.now = options.now ?? Date.now;
    this.afterCommitForTesting = options.afterCommitForTesting;
    this.options.kernel.getOwnedIdentity(this.options.runtimeSessionToken);
    this.options.kernel.withTrustedDatabaseTransaction((db) => this.initialize(db));
  }

  /** Register an already-persisted exact lease under its active parent ticket. */
  registerCurrentChild(input: SpeechCleanupRegistration): Readonly<{
    childId: string;
    status: SpeechCleanupChildStatus;
    handle?: SpeechCleanupChildHandle;
  }> {
    const ticket = currentCommandTicket();
    if (!ticket) throw new Error('Speech cleanup registration requires an active command parent.');
    if (ticket.kind !== SPEECH_PARENT_KIND) throw new Error('Speech cleanup registration requires the named transcription command.');
    if (ticket.runtimeSessionToken !== this.options.runtimeSessionToken) throw new Error('Speech cleanup parent is not owned by this runtime actor.');
    const registration = validateRegistration(input);
    const binding = canonical({ workspaceId: ticket.workspaceId, ownerId: ticket.ownerId, privacyEpoch: ticket.privacyEpoch,
      parentTicketId: ticket.ticketId, parentIdempotencyKey: ticket.idempotencyKey, parentKind: ticket.kind,
      parentRequestDigest: ticket.requestDigest, admissionSessionDigest: ticket.admissionSessionDigest,
      attemptId: registration.attemptId, leaseId: registration.leaseId, noteId: registration.noteId, provider: registration.provider });
    const bindingDigest = sha256(binding);

    return this.options.journal.withActiveSpeechCleanupRegistration(ticket, (context) => {
      const state = readWorkspace(context);
      assertLeaseRelationship(state.state, registration);
      const prior = context.db.prepare('SELECT * FROM speech_cleanup_children WHERE workspace_id=? AND privacy_epoch=? AND lease_id=?')
        .get(context.workspaceId, context.privacyEpoch, registration.leaseId) as ChildRow | undefined;
      if (prior) {
        validateChildRow(prior);
        if (prior.owner_id !== ticket.ownerId || prior.parent_ticket_id !== ticket.ticketId || prior.parent_idempotency_key !== ticket.idempotencyKey ||
            prior.parent_kind !== ticket.kind || prior.parent_request_digest !== ticket.requestDigest || prior.binding_json !== binding || prior.binding_digest !== bindingDigest ||
            prior.attempt_id !== registration.attemptId || prior.note_id !== registration.noteId || prior.provider !== registration.provider) {
          throw new Error('This speech cleanup lease is already bound to different ownership or parent content.');
        }
        const existingHandle = this.handleByChildId.get(prior.child_id)?.deref();
        const status = this.effectiveStatus(prior, existingHandle);
        return Object.freeze({ childId: prior.child_id, status,
          ...(existingHandle ? { handle: existingHandle } : {}) });
      }
      assertOwnedLease(state.state, registration);

      const childId = randomUUID();
      const now = this.clock();
      context.db.prepare(`INSERT INTO speech_cleanup_children(
        child_id,workspace_id,owner_id,privacy_epoch,parent_ticket_id,parent_idempotency_key,parent_kind,parent_request_digest,
        attempt_id,lease_id,note_id,provider,binding_json,binding_digest,process_instance_id,status,last_settlement_key,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'owned',NULL,?,?)`)
        .run(childId, context.workspaceId, context.ownerId, context.privacyEpoch, ticket.ticketId, ticket.idempotencyKey,
          ticket.kind, ticket.requestDigest, registration.attemptId, registration.leaseId, registration.noteId, registration.provider,
          binding, bindingDigest, this.options.processInstanceId, now, now);
      const row = Object.freeze({ child_id: childId, workspace_id: context.workspaceId, owner_id: context.ownerId,
        privacy_epoch: context.privacyEpoch, binding_digest: bindingDigest, process_instance_id: this.options.processInstanceId });
      const handle = Object.freeze({ childId });
      this.handles.set(handle, { row });
      this.handleByChildId.set(childId, new WeakRef(handle));
      return Object.freeze({ childId, status: 'owned' as const, handle });
    });
  }

  /** Safe private inspection. It never returns a cleanup callback or mutates workspace state. */
  inspect(childId: string): SpeechCleanupChildInspection | undefined {
    requireUuid(childId, 'Speech cleanup child');
    const identity = this.options.kernel.getOwnedIdentity(this.options.runtimeSessionToken);
    return this.options.kernel.withOwnedTransaction(this.options.runtimeSessionToken, identity.privacyEpoch, (context) => {
      const row = context.db.prepare('SELECT * FROM speech_cleanup_children WHERE workspace_id=? AND child_id=?')
        .get(context.workspaceId, childId) as ChildRow | undefined;
      if (!row) return undefined;
      validateChildRow(row);
      if (row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch) throw new Error('Speech cleanup child belongs to another owner or privacy epoch.');
      const projection = this.projectInspection(context, row);
      return this.refreshRequiredChildren.has(row.child_id)
        ? Object.freeze({ ...projection, refreshRequired: true as const })
        : projection;
    });
  }

  /**
   * Apply only the named cleanup-lease transition, snapshot receipt, and child
   * status in one authenticated SQLite transaction. This is not a generic
   * workspace mutator and does not resume a cleanup callback after restart.
   */
  settle(handle: SpeechCleanupChildHandle, outcome: SpeechCleanupOutcome): SpeechCleanupSettlement {
    if (outcome !== 'pending_cleanup' && outcome !== 'released') throw new Error('Speech cleanup settlement outcome is invalid.');
    const capability = handle && typeof handle === 'object' ? this.handles.get(handle as object) : undefined;
    if (!capability || this.handleByChildId.get(capability.row.child_id)?.deref() !== handle) throw new Error('Speech cleanup child handle is not active in this service instance.');
    const binding = capability.row;
    if (this.refreshRequiredChildren.has(binding.child_id)) throw new Error('Speech cleanup settlement requires an explicit workspace refresh.');
    const idempotencyKey = settlementKey(binding.child_id, outcome);
    const request = canonical({ childId: binding.child_id, outcome, bindingDigest: binding.binding_digest });
    const requestDigest = sha256(`${CLEANUP_TYPE}\0${request}`);

    const receipt = this.options.kernel.withOwnedTransaction(this.options.runtimeSessionToken, binding.privacy_epoch, (outer) => {
      if (outer.workspaceId !== binding.workspace_id || outer.ownerId !== binding.owner_id || outer.privacyEpoch !== binding.privacy_epoch) {
        throw new Error('Speech cleanup child is outside the current runtime privacy epoch.');
      }
      const row = outer.db.prepare('SELECT * FROM speech_cleanup_children WHERE workspace_id=? AND child_id=?')
        .get(binding.workspace_id, binding.child_id) as ChildRow | undefined;
      if (!row) throw new Error('Speech cleanup child no longer exists.');
      validateChildRow(row);
      if (row.owner_id !== binding.owner_id || row.privacy_epoch !== binding.privacy_epoch || row.binding_digest !== binding.binding_digest ||
          row.process_instance_id !== binding.process_instance_id || row.process_instance_id !== this.options.processInstanceId || row.status === 'inspect_required') {
        throw new Error('Speech cleanup child ownership is no longer current.');
      }

      // A duplicate receipt is returned without parsing or rewriting the current workspace snapshot.
      const priorCommand = outer.db.prepare(`SELECT request_digest,command_type,privacy_epoch,status,result_json,committed_revision
        FROM commands WHERE workspace_id=? AND idempotency_key=?`).get(binding.workspace_id, idempotencyKey) as CommandRow | undefined;
      if (priorCommand) {
        if (priorCommand.request_digest !== requestDigest || priorCommand.command_type !== CLEANUP_TYPE || priorCommand.privacy_epoch !== binding.privacy_epoch || priorCommand.status !== 'committed') {
          throw new Error('Speech cleanup settlement key is bound to different or incomplete content.');
        }
        parseSettlementReceipt(priorCommand.result_json, binding.child_id, outcome);
        if (row.last_settlement_key !== idempotencyKey && row.status !== 'released') throw new Error('Speech cleanup settlement receipt is inconsistent with its child record.');
        return Object.freeze({ saved: priorCommand.result_json, revision: priorCommand.committed_revision, replayed: true });
      }

      if (!['owned', 'pending_cleanup'].includes(row.status)) throw new Error('Speech cleanup child cannot settle from its current state.');
      const current = readWorkspace(outer);
      const currentLeaseOutcome = assertLeaseRelationship(current.state, {
        attemptId: row.attempt_id, leaseId: row.lease_id, noteId: row.note_id, provider: row.provider,
      });
      const command: CommandReceipt = this.options.kernel.runLocalCommand(this.options.runtimeSessionToken, {
        expectedRevision: outer.revision,
        expectedPrivacyEpoch: outer.privacyEpoch,
        idempotencyKey,
        type: CLEANUP_TYPE,
        canonicalRequest: request,
      }, (commandContext) => {
        if (commandContext.revision !== outer.revision || commandContext.privacyEpoch !== outer.privacyEpoch) throw new Error('Workspace changed during speech cleanup settlement.');
        const snapshot = requireRecord(commandContext.snapshot, 'Workspace snapshot');
        const serialized = canonical(snapshot);
        if (serialized !== current.raw) throw new Error('Workspace snapshot changed before speech cleanup settlement.');
        const cloned = cloneJson(snapshot);
        const next = requireRecord(cloned, 'Workspace snapshot');
        const nextTranscription = requireRecord(next.transcription, 'Transcription state');
        const leases = requireArray(nextTranscription.cleanupLeases, 'Speech cleanup leases');
        const index = leases.findIndex((lease) => isRecord(lease) && lease.leaseId === row.lease_id && lease.attemptId === row.attempt_id);
        if (index < 0) throw new Error('The exact speech cleanup lease is missing from the workspace.');
        const lease = requireRecord(leases[index], 'Speech cleanup lease');
        const expectedCurrent = row.status === 'pending_cleanup' ? ['pending_cleanup'] : ['owned', 'pending_cleanup'];
        if (!expectedCurrent.includes(String(lease.outcome)) || lease.outcome !== currentLeaseOutcome) throw new Error('Speech cleanup child does not match the persisted lease state.');
        const allowed = outcome === 'pending_cleanup'
          ? lease.outcome === 'owned' || lease.outcome === 'pending_cleanup'
          : lease.outcome === 'owned' || lease.outcome === 'pending_cleanup';
        if (!allowed) throw new Error('Speech cleanup lease transition is no longer valid.');
        leases[index] = { ...lease, outcome };
        const expectedAfter = canonical(next);
        const expectedFromOriginal = changedLeaseOnly(current.state, row.lease_id, row.attempt_id, outcome);
        if (expectedAfter !== expectedFromOriginal) throw new Error('Speech cleanup settlement changed unrelated workspace data.');
        return { snapshot: next as unknown as JsonValue, receipt: { childId: row.child_id, kind: 'speech_cleanup_child_settlement', outcome } };
      });
      const childStatus = outcome;
      const updated = outer.db.prepare(`UPDATE speech_cleanup_children SET status=?,last_settlement_key=?,updated_at=?
        WHERE workspace_id=? AND child_id=? AND owner_id=? AND privacy_epoch=? AND process_instance_id=? AND binding_digest=? AND status IN ('owned','pending_cleanup')`)
        .run(childStatus, idempotencyKey, this.clock(), binding.workspace_id, binding.child_id, binding.owner_id, binding.privacy_epoch,
          binding.process_instance_id, binding.binding_digest);
      if (updated.changes !== 1) throw new Error('Speech cleanup child status could not be committed.');
      return Object.freeze({ saved: JSON.stringify(command.result), revision: command.revision, replayed: command.replayed });
    });

    try { this.afterCommitForTesting?.(); }
    catch (error) {
      this.refreshRequiredChildren.add(binding.child_id);
      throw error;
    }
    const saved = parseSettlementReceipt(receipt.saved, binding.child_id, outcome);
    return Object.freeze({ childId: binding.child_id, outcome: saved.outcome, revision: receipt.revision, replayed: receipt.replayed });
  }

  /** Clears a lost-ACK hold only after the controller proves it adopted the exact committed bytes. */
  acknowledgeAfterRefresh(handle: SpeechCleanupChildHandle, proof: LoadedWorkspaceStateProof,
    expected: SpeechCleanupSettlementProof): void {
    const capability = handle && typeof handle === 'object' ? this.handles.get(handle as object) : undefined;
    if (!capability || this.handleByChildId.get(capability.row.child_id)?.deref() !== handle) {
      throw new Error('Speech cleanup child handle is not active in this service instance.');
    }
    const binding = capability.row;
    if (!this.refreshRequiredChildren.has(binding.child_id)) throw new Error('Speech cleanup child does not require refresh acknowledgement.');
    requireUuid(expected.childId, 'Speech cleanup settlement child');
    requireUuid(proof.workspaceId, 'Loaded workspace');
    requireUuid(proof.ownerId, 'Loaded workspace owner');
    if (expected.childId !== binding.child_id || (expected.outcome !== 'pending_cleanup' && expected.outcome !== 'released') ||
        expected.idempotencyKey !== settlementKey(binding.child_id, expected.outcome) ||
        !Number.isSafeInteger(expected.revision) || expected.revision < 0 ||
        proof.workspaceId !== binding.workspace_id || proof.ownerId !== binding.owner_id || proof.privacyEpoch !== binding.privacy_epoch ||
        !Number.isSafeInteger(proof.revision) || proof.revision < expected.revision ||
        !Number.isSafeInteger(proof.schemaVersion) || proof.schemaVersion < 1 || !/^[a-f0-9]{64}$/.test(proof.sha256)) {
      throw new Error('Speech cleanup refresh proof does not match its exact settlement.');
    }

    this.options.kernel.withOwnedTransaction(this.options.runtimeSessionToken, binding.privacy_epoch, (context) => {
      if (context.workspaceId !== proof.workspaceId || context.ownerId !== proof.ownerId ||
          context.privacyEpoch !== proof.privacyEpoch || context.revision !== proof.revision) {
        throw new Error('Speech cleanup refresh proof is no longer current.');
      }
      const workspace = context.db.prepare('SELECT snapshot_json,schema_version,revision,privacy_epoch FROM workspaces WHERE id=?')
        .get(binding.workspace_id) as { snapshot_json: string; schema_version: number; revision: number; privacy_epoch: number } | undefined;
      if (!workspace || workspace.revision !== proof.revision || workspace.privacy_epoch !== proof.privacyEpoch ||
          workspace.schema_version !== proof.schemaVersion || sha256(workspace.snapshot_json) !== proof.sha256) {
        throw new Error('Speech cleanup refresh proof does not match the current durable snapshot.');
      }
      const state = requireRecord(JSON.parse(workspace.snapshot_json), 'Workspace snapshot');
      const child = context.db.prepare('SELECT * FROM speech_cleanup_children WHERE workspace_id=? AND child_id=?')
        .get(binding.workspace_id, binding.child_id) as ChildRow | undefined;
      if (!child) throw new Error('Speech cleanup child no longer exists.');
      validateChildRow(child);
      if (child.owner_id !== binding.owner_id || child.privacy_epoch !== binding.privacy_epoch ||
          child.binding_digest !== binding.binding_digest || child.process_instance_id !== binding.process_instance_id ||
          child.process_instance_id !== this.options.processInstanceId || child.status !== expected.outcome ||
          child.last_settlement_key !== expected.idempotencyKey) {
        throw new Error('Speech cleanup settlement receipt is not the exact current child outcome.');
      }
      const receiptRow = context.db.prepare(`SELECT request_digest,command_type,privacy_epoch,status,result_json,committed_revision
        FROM commands WHERE workspace_id=? AND idempotency_key=?`).get(binding.workspace_id, expected.idempotencyKey) as CommandRow | undefined;
      if (!receiptRow || receiptRow.command_type !== CLEANUP_TYPE || receiptRow.privacy_epoch !== binding.privacy_epoch ||
          receiptRow.status !== 'committed' || receiptRow.committed_revision !== expected.revision) {
        throw new Error('Speech cleanup settlement receipt is unavailable.');
      }
      parseSettlementReceipt(receiptRow.result_json, binding.child_id, expected.outcome);
      const request = canonical({ childId: binding.child_id, outcome: expected.outcome, bindingDigest: binding.binding_digest });
      if (receiptRow.request_digest !== sha256(`${CLEANUP_TYPE}\0${request}`)) throw new Error('Speech cleanup settlement receipt binding is invalid.');
      const leaseOutcome = assertLeaseRelationship(state, { attemptId: child.attempt_id, leaseId: child.lease_id,
        noteId: child.note_id, provider: child.provider });
      if (leaseOutcome !== expected.outcome) throw new Error('The refreshed workspace did not adopt the exact speech cleanup lease outcome.');
    });
    this.refreshRequiredChildren.delete(binding.child_id);
  }

  private initialize(db: Database.Database): void {
    const exists = (name: string): boolean => Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const hasVersion = exists('speech_cleanup_child_schema');
    const hasTable = exists('speech_cleanup_children');
    if (!hasVersion && !hasTable) {
      db.exec(`
        CREATE TABLE speech_cleanup_child_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version>0)) STRICT;
        CREATE TABLE speech_cleanup_children (
          child_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
          parent_ticket_id TEXT NOT NULL, parent_idempotency_key TEXT NOT NULL, parent_kind TEXT NOT NULL,
          parent_request_digest TEXT NOT NULL, attempt_id TEXT NOT NULL, lease_id TEXT NOT NULL, note_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('azure','openrouter')), binding_json TEXT NOT NULL, binding_digest TEXT NOT NULL,
          process_instance_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('owned','pending_cleanup','released','inspect_required')),
          last_settlement_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id,privacy_epoch,lease_id),
          FOREIGN KEY(workspace_id,parent_idempotency_key) REFERENCES async_command_journal(workspace_id,idempotency_key) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX speech_cleanup_child_parent_idx ON speech_cleanup_children(workspace_id,privacy_epoch,parent_ticket_id);
        INSERT INTO speech_cleanup_child_schema(singleton,version) VALUES(1,${SCHEMA_VERSION});
      `);
    } else {
      if (!hasVersion || !hasTable) throw new Error('The speech cleanup child schema is incomplete.');
      const row = db.prepare('SELECT version FROM speech_cleanup_child_schema WHERE singleton=1').get() as { version: number } | undefined;
      if (!row || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('The speech cleanup child schema version is invalid.');
      if (row.version > SCHEMA_VERSION) throw new Error('The speech cleanup child schema was created by a newer server.');
      if (row.version !== SCHEMA_VERSION) throw new Error('The speech cleanup child schema requires an unavailable migration.');
    }
  }

  private projectInspection(context: OwnedTransactionContext, row: ChildRow): SpeechCleanupChildInspection {
    let lastSettlement: SpeechCleanupChildInspection['lastSettlement'];
    if (row.last_settlement_key) {
      if (row.last_settlement_key !== settlementKey(row.child_id, 'pending_cleanup') && row.last_settlement_key !== settlementKey(row.child_id, 'released')) {
        throw new Error('Saved speech cleanup settlement key is invalid.');
      }
      const saved = context.db.prepare(`SELECT command_type,privacy_epoch,status,result_json,committed_revision FROM commands
        WHERE workspace_id=? AND idempotency_key=?`).get(row.workspace_id, row.last_settlement_key) as {
          command_type: string; privacy_epoch: number; status: string; result_json: string; committed_revision: number;
        } | undefined;
      if (saved) {
        if (saved.command_type !== CLEANUP_TYPE || saved.privacy_epoch !== row.privacy_epoch || saved.status !== 'committed') throw new Error('Saved speech cleanup settlement receipt is invalid.');
        const receipt = parseSettlementReceipt(saved.result_json, row.child_id);
        lastSettlement = Object.freeze({ outcome: receipt.outcome, revision: saved.committed_revision, idempotencyKey: row.last_settlement_key });
      }
    }
    const status = this.effectiveStatus(row, this.handleByChildId.get(row.child_id)?.deref());
    return Object.freeze({ childId: row.child_id, workspaceId: row.workspace_id, ownerId: row.owner_id,
      privacyEpoch: row.privacy_epoch, parentTicketId: row.parent_ticket_id, attemptId: row.attempt_id,
      leaseId: row.lease_id, noteId: row.note_id, provider: row.provider, status,
      ...(lastSettlement ? { lastSettlement } : {}) });
  }

  private effectiveStatus(row: ChildRow, handle: SpeechCleanupChildHandle | undefined): SpeechCleanupChildStatus {
    const held = handle ? this.handles.get(handle)?.row : undefined;
    if ((row.status === 'owned' || row.status === 'pending_cleanup') &&
        (row.process_instance_id !== this.options.processInstanceId || !held ||
          held.child_id !== row.child_id || held.workspace_id !== row.workspace_id || held.owner_id !== row.owner_id ||
          held.privacy_epoch !== row.privacy_epoch || held.binding_digest !== row.binding_digest ||
          held.process_instance_id !== row.process_instance_id)) {
      return 'inspect_required';
    }
    return row.status;
  }

  private clock(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Speech cleanup child clock is invalid.');
    return value;
  }
}

function validateRegistration(value: SpeechCleanupRegistration): SpeechCleanupRegistration {
  if (!isRecord(value) || Object.keys(value).some((key) => !['attemptId', 'leaseId', 'noteId', 'provider'].includes(key))) throw new Error('Speech cleanup registration fields are invalid.');
  requireUuid(value.attemptId, 'Speech attempt');
  requireUuid(value.leaseId, 'Speech cleanup lease');
  requireUuid(value.noteId, 'Speech cleanup note');
  if (value.provider !== 'azure' && value.provider !== 'openrouter') throw new Error('Speech cleanup provider is invalid.');
  return Object.freeze({ attemptId: value.attemptId, leaseId: value.leaseId, noteId: value.noteId, provider: value.provider });
}

function assertLeaseRelationship(snapshot: Record<string, unknown>, registration: SpeechCleanupRegistration): 'owned' | 'pending_cleanup' | 'released' {
  if (!Array.isArray(snapshot.notes) || snapshot.notes.filter((item) => isRecord(item) && item.id === registration.noteId).length !== 1) {
    throw new Error('The exact persisted note for this speech attempt is missing or ambiguous.');
  }
  const transcription = requireRecord(snapshot.transcription, 'Transcription state');
  if (transcription.schemaVersion !== 1 || !Array.isArray(transcription.attempts) || !Array.isArray(transcription.cleanupLeases)) throw new Error('Persisted speech state is invalid.');
  const attempts = transcription.attempts.filter((item) => isRecord(item) && item.id === registration.attemptId);
  if (attempts.length !== 1) throw new Error('The exact persisted speech attempt is missing or ambiguous.');
  const attempt = requireRecord(attempts[0], 'Speech attempt');
  const provider = attempt.provider === undefined ? 'azure' : attempt.provider;
  if (attempt.leaseId !== registration.leaseId || attempt.noteId !== registration.noteId || provider !== registration.provider) throw new Error('The speech attempt does not match the cleanup child binding.');
  const leases = transcription.cleanupLeases.filter((item) => isRecord(item) && item.leaseId === registration.leaseId);
  if (leases.length !== 1) throw new Error('The exact persisted speech cleanup lease is missing or ambiguous.');
  const lease = requireRecord(leases[0], 'Speech cleanup lease');
  if (lease.attemptId !== registration.attemptId || !['owned', 'pending_cleanup', 'released'].includes(String(lease.outcome))) throw new Error('The persisted speech cleanup lease does not match this attempt.');
  return lease.outcome as 'owned' | 'pending_cleanup' | 'released';
}

function assertOwnedLease(snapshot: Record<string, unknown>, registration: SpeechCleanupRegistration): void {
  if (assertLeaseRelationship(snapshot, registration) !== 'owned') throw new Error('The persisted speech cleanup lease is not currently owned by this attempt.');
}

function readWorkspace(context: OwnedTransactionContext): { raw: string; state: Record<string, unknown> } {
  const row = context.db.prepare('SELECT snapshot_json,revision,privacy_epoch FROM workspaces WHERE id=?').get(context.workspaceId) as { snapshot_json: string; revision: number; privacy_epoch: number } | undefined;
  if (!row || row.revision !== context.revision || row.privacy_epoch !== context.privacyEpoch || Buffer.byteLength(row.snapshot_json, 'utf8') > SNAPSHOT_LIMIT) throw new Error('Speech cleanup workspace snapshot is unavailable or stale.');
  let parsed: unknown;
  try { parsed = JSON.parse(row.snapshot_json); } catch { throw new Error('Speech cleanup workspace snapshot is invalid.'); }
  const state = requireRecord(parsed, 'Workspace snapshot');
  if (canonical(state) !== row.snapshot_json) throw new Error('Speech cleanup workspace snapshot is not canonical.');
  return { raw: row.snapshot_json, state };
}

function changedLeaseOnly(snapshot: Record<string, unknown>, leaseId: string, attemptId: string, outcome: SpeechCleanupOutcome): string {
  const copy = cloneJson(snapshot) as Record<string, unknown>;
  const transcription = requireRecord(copy.transcription, 'Transcription state');
  const leases = requireArray(transcription.cleanupLeases, 'Speech cleanup leases');
  const matches = leases.map((lease, index) => ({ lease, index })).filter(({ lease }) => isRecord(lease) && lease.leaseId === leaseId && lease.attemptId === attemptId);
  if (matches.length !== 1) throw new Error('The exact speech cleanup lease is missing or ambiguous.');
  const { lease, index } = matches[0]!;
  const row = requireRecord(lease, 'Speech cleanup lease');
  leases[index] = { ...row, outcome };
  return canonical(copy);
}

function parseSettlementReceipt(text: string, childId: string, expectedOutcome?: SpeechCleanupOutcome): Readonly<{ outcome: SpeechCleanupOutcome }> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Saved speech cleanup settlement receipt is invalid.'); }
  const row = requireRecord(value, 'Speech cleanup settlement receipt');
  if (canonical(row) !== text || Object.keys(row).length !== 3 || row.kind !== 'speech_cleanup_child_settlement' || row.childId !== childId ||
      (row.outcome !== 'pending_cleanup' && row.outcome !== 'released') || (expectedOutcome !== undefined && row.outcome !== expectedOutcome)) {
    throw new Error('Saved speech cleanup settlement receipt does not match its child.');
  }
  return Object.freeze({ outcome: row.outcome });
}

function validateChildRow(row: ChildRow): void {
  requireUuid(row.child_id, 'Speech cleanup child');
  requireUuid(row.workspace_id, 'Speech cleanup workspace');
  requireUuid(row.owner_id, 'Speech cleanup owner');
  requireUuid(row.parent_ticket_id, 'Speech cleanup parent ticket');
  requireUuid(row.attempt_id, 'Speech cleanup attempt');
  requireUuid(row.lease_id, 'Speech cleanup lease');
  requireUuid(row.note_id, 'Speech cleanup note');
  requireUuid(row.process_instance_id, 'Speech cleanup process instance');
  if (!Number.isSafeInteger(row.privacy_epoch) || row.privacy_epoch < 0 || !STATUS.has(row.status) || (row.provider !== 'azure' && row.provider !== 'openrouter')) throw new Error('Saved speech cleanup child metadata is invalid.');
  if (typeof row.binding_json !== 'string' || typeof row.binding_digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.binding_digest) || sha256(row.binding_json) !== row.binding_digest) throw new Error('Saved speech cleanup child binding is invalid.');
  let binding: unknown;
  try { binding = JSON.parse(row.binding_json); } catch { throw new Error('Saved speech cleanup child binding is invalid.'); }
  if (canonical(binding) !== row.binding_json) throw new Error('Saved speech cleanup child binding is not canonical.');
  const value = requireRecord(binding, 'Speech cleanup binding');
  const expectedKeys = ['workspaceId', 'ownerId', 'privacyEpoch', 'parentTicketId', 'parentIdempotencyKey', 'parentKind', 'parentRequestDigest',
    'admissionSessionDigest', 'attemptId', 'leaseId', 'noteId', 'provider'];
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('Saved speech cleanup child binding fields are invalid.');
  if (typeof value.parentIdempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.parentIdempotencyKey) ||
      value.parentKind !== SPEECH_PARENT_KIND || typeof value.parentRequestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.parentRequestDigest) ||
      typeof value.admissionSessionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.admissionSessionDigest)) throw new Error('Saved speech cleanup parent binding is invalid.');
  if (value.workspaceId !== row.workspace_id || value.ownerId !== row.owner_id || value.privacyEpoch !== row.privacy_epoch ||
      value.parentTicketId !== row.parent_ticket_id || value.parentIdempotencyKey !== row.parent_idempotency_key ||
      value.parentKind !== row.parent_kind || value.parentRequestDigest !== row.parent_request_digest ||
      value.attemptId !== row.attempt_id || value.leaseId !== row.lease_id || value.noteId !== row.note_id || value.provider !== row.provider) {
    throw new Error('Saved speech cleanup child binding does not match its indexed fields.');
  }
}

function settlementKey(childId: string, outcome: SpeechCleanupOutcome): string {
  return `speech-cleanup:${childId}:${outcome}`;
}

function canonical(value: unknown, ancestors = new Set<object>()): string {
  const normalize = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error('Speech cleanup JSON must be finite and acyclic.');
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item)) throw new Error('Speech cleanup JSON objects must be plain.');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(normalize);
      if (Reflect.ownKeys(item).some((key) => typeof key !== 'string')) throw new Error('Speech cleanup JSON cannot contain symbol keys.');
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('Speech cleanup JSON cannot contain accessors.');
        result[key] = normalize(descriptor.value);
      }
      return result;
    } finally { ancestors.delete(item); }
  };
  const text = JSON.stringify(normalize(value));
  if (Buffer.byteLength(text, 'utf8') > SNAPSHOT_LIMIT) throw new Error('Speech cleanup JSON exceeds the physical snapshot limit.');
  return text;
}

function cloneJson(value: unknown): JsonValue { return JSON.parse(canonical(value)) as JsonValue; }
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function requireUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new Error(`${label} identifier is invalid.`);
}
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
