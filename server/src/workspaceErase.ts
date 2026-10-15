import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { isAbsolute, parse, resolve, dirname, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { AuthService } from './auth.js';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import type { SecretVault } from './vault.js';
import type { WorkspaceHttpAdmission } from './workspaceHttp.js';
import { privateAudioStoragePath, privateAudioWorkspaceRoot } from './privateAudioStorage.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:part|audio)$/i;
const PLAN_TTL_MS = 5 * 60_000;
const activeErase = new WeakMap<object, Readonly<{ context: OwnedTransactionContext; workspaceId: string; ownerId: string;
  firstRetiredEpoch: number; lastRetiredEpoch: number }>>();
const registeredConnections = new WeakSet<object>();

export interface WorkspaceEraseRuntimeHold {
  readonly identity: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number; revision: number }>;
  readonly commandId: string;
  assertHeld(): void;
  releaseAfterCleanup(): void;
  releaseAfterCancellation(): void;
}
type ReserveEraseRuntime = (admission: WorkspaceHttpAdmission, commandId: string) => Promise<WorkspaceEraseRuntimeHold>;
type VerifyEraseRuntimeHold = (hold: WorkspaceEraseRuntimeHold, commandId: string) => void;

export interface WorkspaceEraseOptions {
  readonly kernel: DurableKernel;
  readonly auth: AuthService;
  readonly vault: SecretVault;
  /** Trusted host factory. This is called by the service and never supplied by an HTTP caller. */
  readonly createEmptySnapshot: () => unknown;
  readonly privateAudioRoot?: string;
  readonly privateDocumentsRoot?: string;
  /** @internal Deterministic gate before real filesystem deletion; never wired through host or HTTP options. */
  readonly beforePhysicalCleanupForTesting?: (intent: Readonly<{ commandId: string; workspaceId: string; ownerId: string;
    kind: 'audio' | 'documents'; relativePath: string }>) => Promise<void>;
  readonly now?: () => number;
}

export interface WorkspaceEraseCounts {
  readonly notes: number;
  readonly documents: number;
  readonly accounts: number;
  readonly proposals: number;
  readonly audioUploads: number;
  readonly backgroundPolicies: number;
}

export interface WorkspaceErasePlan {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly expectedPrivacyEpoch: number;
  readonly expiresAt: string;
  readonly counts: WorkspaceEraseCounts;
  readonly status: 'prepared' | 'confirmed';
}

export interface WorkspaceEraseReceipt {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly status: 'cleanup_pending' | 'complete';
  readonly erasedPrivacyEpoch: number;
  readonly currentPrivacyEpoch: number;
  readonly createdAt: string;
}
export interface WorkspaceEraseCancellation {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly status: 'cancelled';
  readonly privacyEpoch: number;
  readonly cancelledAt: string;
}
export type WorkspaceEraseStatus = Readonly<{ schemaVersion: 1; status: 'none' }> |
  Readonly<{ schemaVersion: 1; status: 'prepared' | 'confirmed'; plan: WorkspaceErasePlan }> |
  Readonly<{ schemaVersion: 1; status: 'cleanup_pending' | 'complete'; receipt: WorkspaceEraseReceipt }> |
  Readonly<{ schemaVersion: 1; status: 'cancelled'; cancellation: WorkspaceEraseCancellation }>;

type ErasePlanRow = { command_id: string; workspace_id: string; owner_id: string; privacy_epoch: number; revision: number;
  session_binding: string; counts_json: string; status: 'prepared' | 'confirmed'; created_at: number; expires_at: number };
type CleanupRow = { command_id: string; workspace_id: string; owner_id: string; privacy_epoch: number; kind: 'audio' | 'documents'; relative_path: string };

/**
 * Authenticated Node server workspace erasure. The HTTP port can only prepare, confirm, execute,
 * and inspect; this service owns transaction authority and the private SQLite/file cleanup journal.
 */
export class WorkspaceEraseService {
  readonly #now: () => number;
  readonly #holds = new Map<string, WorkspaceEraseRuntimeHold>();
  readonly #releasedCleanupHolds = new WeakSet<object>();
  readonly #cleanupFlights = new Map<string, { promise: Promise<void>; holds: Set<WorkspaceEraseRuntimeHold> }>();

  constructor(private readonly options: WorkspaceEraseOptions) {
    if (!options?.kernel || !options.auth || !options.vault || typeof options.createEmptySnapshot !== 'function') {
      throw new TypeError('workspace_erase_ports_required');
    }
    for (const root of [options.privateAudioRoot, options.privateDocumentsRoot]) {
      if (root !== undefined && (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0'))) {
        throw new TypeError('workspace_erase_private_root_invalid');
      }
    }
    this.#now = options.now ?? Date.now;
    options.kernel.withTrustedDatabaseTransaction((db) => {
      registerWorkspaceEraseDeleteGuard(db);
      initializeEraseSchema(db);
    });
  }

  async prepare(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>,
    reserveRuntime: ReserveEraseRuntime, verifyRuntimeHold: VerifyEraseRuntimeHold): Promise<WorkspaceErasePlan> {
    validatePlanInput(input);
    admission.assertCurrent();
    // Verify the live owner/epoch first, then stop admission and drain before calculating
    // the final reviewed revision and counts. In-flight work may finish during the drain.
    this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      this.options.auth.bindInitiatingSessionWithinTransaction(context, admission.sessionToken);
      if (context.db.prepare('SELECT 1 AS present FROM workspace_erase_receipts WHERE workspace_id=? AND owner_id=? AND command_id=?')
        .get(context.workspaceId, context.ownerId, input.commandId) ||
          context.db.prepare('SELECT 1 AS present FROM workspace_erase_cancellations WHERE workspace_id=? AND owner_id=? AND command_id=?')
            .get(context.workspaceId, context.ownerId, input.commandId)) throw new Error('workspace_erase_command_conflict');
      if (context.db.prepare(`SELECT 1 AS present FROM workspace_erase_receipts WHERE workspace_id=? AND owner_id=? AND status='cleanup_pending' LIMIT 1`)
        .get(context.workspaceId, context.ownerId)) throw new Error('workspace_erase_cleanup_pending');
    });
    const hold = await reserveRuntime(admission, input.commandId);
    this.#assertHold(admission, hold, input.commandId, verifyRuntimeHold);
    const now = this.#now();
    const result = this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      const binding = this.options.auth.bindInitiatingSessionWithinTransaction(context, admission.sessionToken);
      const existing = context.db.prepare('SELECT * FROM workspace_erase_plans WHERE command_id=?').get(input.commandId) as ErasePlanRow | undefined;
      if (existing) {
        if (existing.workspace_id !== context.workspaceId || existing.owner_id !== context.ownerId || existing.privacy_epoch !== context.privacyEpoch ||
            existing.session_binding !== binding) throw new Error('workspace_erase_command_conflict');
        if (existing.revision === context.revision && existing.expires_at > now) return this.#projectPlan(existing);
        if (existing.status === 'confirmed') throw new Error('workspace_erase_stale');
        context.db.prepare('DELETE FROM workspace_erase_plans WHERE command_id=? AND workspace_id=? AND owner_id=? AND status=\'prepared\'')
          .run(input.commandId, context.workspaceId, context.ownerId);
      }
      const receipt = context.db.prepare('SELECT 1 AS present FROM workspace_erase_receipts WHERE workspace_id=? AND owner_id=? AND command_id=?')
        .get(context.workspaceId, context.ownerId, input.commandId);
      const cancelled = context.db.prepare('SELECT 1 AS present FROM workspace_erase_cancellations WHERE workspace_id=? AND owner_id=? AND command_id=?')
        .get(context.workspaceId, context.ownerId, input.commandId);
      if (receipt || cancelled) throw new Error('workspace_erase_command_conflict');
      const pending = context.db.prepare(`SELECT 1 AS present FROM workspace_erase_receipts WHERE workspace_id=? AND owner_id=? AND status='cleanup_pending' LIMIT 1`)
        .get(context.workspaceId, context.ownerId);
      if (pending) throw new Error('workspace_erase_cleanup_pending');
      const competingPlan = context.db.prepare(`SELECT 1 AS present FROM workspace_erase_plans WHERE workspace_id=? AND owner_id=? AND command_id<>? LIMIT 1`)
        .get(context.workspaceId, context.ownerId, input.commandId);
      if (competingPlan) throw new Error('workspace_erase_plan_exists');
      const snapshot = this.options.kernel.readOwnedSnapshotWithinTransaction(context);
      const counts = countPrivateMetadata(context.db, context.workspaceId, context.ownerId, snapshot.snapshot);
      const expiresAt = now + PLAN_TTL_MS;
      context.db.prepare('DELETE FROM workspace_erase_plans WHERE workspace_id=? AND owner_id=? AND status=\'prepared\' AND expires_at<=?')
        .run(context.workspaceId, context.ownerId, now);
      context.db.prepare(`INSERT INTO workspace_erase_plans(command_id,workspace_id,owner_id,privacy_epoch,revision,session_binding,counts_json,status,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,'prepared',?,?)`).run(input.commandId, context.workspaceId, context.ownerId, context.privacyEpoch,
        context.revision, binding, JSON.stringify(counts), now, expiresAt);
      return Object.freeze({ schemaVersion: 1 as const, commandId: input.commandId, expectedRevision: context.revision,
        expectedPrivacyEpoch: context.privacyEpoch, expiresAt: new Date(expiresAt).toISOString(), counts, status: 'prepared' as const });
    });
    admission.assertCurrent();
    this.#holds.set(this.#holdKey(hold), hold);
    return result;
  }

  async confirm(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>,
    reserveRuntime: ReserveEraseRuntime, verifyRuntimeHold: VerifyEraseRuntimeHold): Promise<WorkspaceErasePlan> {
    validatePlanInput(input);
    admission.assertCurrent();
    const now = this.#now();
    this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      const binding = this.options.auth.bindInitiatingSessionWithinTransaction(context, admission.sessionToken);
      const row = context.db.prepare('SELECT * FROM workspace_erase_plans WHERE command_id=?').get(input.commandId) as ErasePlanRow | undefined;
      if (!row || row.workspace_id !== context.workspaceId || row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch ||
          row.revision !== input.expectedRevision || context.revision !== input.expectedRevision || row.session_binding !== binding ||
          row.expires_at <= now) throw new Error('workspace_erase_plan_unavailable');
    });
    const hold = await reserveRuntime(admission, input.commandId);
    this.#assertHold(admission, hold, input.commandId, verifyRuntimeHold);
    const result = this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      const binding = this.options.auth.bindInitiatingSessionWithinTransaction(context, admission.sessionToken);
      const row = context.db.prepare('SELECT * FROM workspace_erase_plans WHERE command_id=?').get(input.commandId) as ErasePlanRow | undefined;
      if (!row || row.workspace_id !== context.workspaceId || row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch ||
          row.revision !== input.expectedRevision || context.revision !== input.expectedRevision || row.session_binding !== binding ||
          row.expires_at <= now) throw new Error('workspace_erase_plan_unavailable');
      if (row.status === 'prepared') {
        const update = context.db.prepare(`UPDATE workspace_erase_plans SET status='confirmed' WHERE command_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=? AND revision=? AND status='prepared'`)
          .run(input.commandId, context.workspaceId, context.ownerId, context.privacyEpoch, context.revision);
        if (update.changes !== 1) throw new Error('workspace_erase_plan_unavailable');
        row.status = 'confirmed';
      }
      return this.#projectPlan(row);
    });
    admission.assertCurrent();
    this.#holds.set(this.#holdKey(hold), hold);
    return result;
  }

  async cancel(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>,
    reserveRuntime: ReserveEraseRuntime, verifyRuntimeHold: VerifyEraseRuntimeHold): Promise<Readonly<{ schemaVersion: 1; commandId: string; status: 'cancelled' }>> {
    validatePlanInput(input);
    admission.assertCurrent();
    const alreadyCancelled = this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      this.options.auth.bindInitiatingSessionWithinTransaction(context, admission.sessionToken);
      return context.db.prepare(`SELECT 1 AS present FROM workspace_erase_cancellations WHERE workspace_id=? AND owner_id=? AND command_id=?`)
        .get(context.workspaceId, context.ownerId, input.commandId) !== undefined;
    });
    if (alreadyCancelled) return Object.freeze({ schemaVersion: 1, commandId: input.commandId, status: 'cancelled' });
    const hold = await reserveRuntime(admission, input.commandId);
    this.#assertHold(admission, hold, input.commandId, verifyRuntimeHold);
    this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      const cancelled = context.db.prepare(`SELECT 1 AS present FROM workspace_erase_cancellations WHERE workspace_id=? AND owner_id=? AND command_id=?`)
        .get(context.workspaceId, context.ownerId, input.commandId);
      if (cancelled) return;
      if (context.db.prepare(`SELECT 1 AS present FROM workspace_erase_receipts WHERE workspace_id=? AND owner_id=? AND command_id=?`)
        .get(context.workspaceId, context.ownerId, input.commandId)) throw new Error('workspace_erase_already_executed');
      const row = context.db.prepare('SELECT * FROM workspace_erase_plans WHERE command_id=?').get(input.commandId) as ErasePlanRow | undefined;
      if (row && (row.workspace_id !== context.workspaceId || row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch ||
          row.revision !== input.expectedRevision || context.revision !== input.expectedRevision)) throw new Error('workspace_erase_plan_unavailable');
      // A matching runtime-issued held command can be cancelled after failed-drain recovery
      // even if no plan row was inserted yet. Confirm/execute still require the reviewed row.
      context.db.prepare(`INSERT INTO workspace_erase_cancellations(command_id,workspace_id,owner_id,privacy_epoch,cancelled_at)
        VALUES(?,?,?,?,?)`).run(input.commandId, context.workspaceId, context.ownerId, context.privacyEpoch, context.now);
      context.db.prepare(`DELETE FROM workspace_erase_plans WHERE command_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .run(input.commandId, context.workspaceId, context.ownerId, context.privacyEpoch);
    });
    hold.releaseAfterCancellation();
    this.#holds.delete(this.#holdKey(hold));
    admission.assertCurrent();
    return Object.freeze({ schemaVersion: 1, commandId: input.commandId, status: 'cancelled' });
  }

  async execute(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>,
    reserveRuntime: ReserveEraseRuntime, verifyRuntimeHold: VerifyEraseRuntimeHold): Promise<WorkspaceEraseReceipt> {
    validatePlanInput(input);
    admission.assertCurrent();
    const binding = this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      const value = this.#requireConfirmedPlan(context, input, this.#now());
      const sessionBinding = this.options.auth.bindInitiatingSessionWithinTransaction(context, admission.sessionToken);
      if (value.session_binding !== sessionBinding) throw new Error('workspace_erase_plan_unavailable');
      return sessionBinding;
    });
    const hold = await reserveRuntime(admission, input.commandId);
    this.#assertHold(admission, hold, input.commandId, verifyRuntimeHold);
    admission.assertCurrent();
    const result = this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      const current = this.options.kernel.readOwnedSnapshotWithinTransaction(context);
      const plan = this.#requireConfirmedPlan(context, input, this.#now());
      if (plan.session_binding !== binding) throw new Error('workspace_erase_plan_unavailable');
      this.options.auth.assertInitiatingSessionWithinTransaction(context, binding);
      hold.assertHeld();
      const empty = this.options.kernel.validateOwnedSnapshotReplacement(context, this.options.createEmptySnapshot());
      if (context.revision === Number.MAX_SAFE_INTEGER || context.privacyEpoch === Number.MAX_SAFE_INTEGER) throw new Error('workspace_erase_overflow');
      const nextRevision = context.revision + 1;
      const nextEpoch = context.privacyEpoch + 1;
      this.#stagePhysicalCleanup(context, input.commandId, current.snapshot);
      this.options.vault.eraseWithinTransaction(context);
      this.#withEraseDeleteGrant(context, hold, () => this.#deletePrivateRows(context));
      const updated = context.db.prepare(`UPDATE workspaces SET snapshot_json=?,schema_version=?,revision=?,privacy_epoch=?
        WHERE id=? AND owner_id=? AND revision=? AND privacy_epoch=?`)
        .run(empty.canonicalJson, empty.schemaVersion, nextRevision, nextEpoch, context.workspaceId, context.ownerId, context.revision, context.privacyEpoch);
      if (updated.changes !== 1) throw new Error('workspace_erase_stale');
      context.db.prepare(`UPDATE auth_sessions SET revoked_at=? WHERE workspace_id=? AND owner_id=? AND revoked_at IS NULL AND token_hash IN
        (SELECT token_hash FROM sessions WHERE workspace_id=? AND owner_id=? AND privacy_epoch<=?)`)
        .run(context.now, context.workspaceId, context.ownerId, context.workspaceId, context.ownerId, context.privacyEpoch);
      context.db.prepare('UPDATE sessions SET revoked_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch<=? AND revoked_at IS NULL')
        .run(context.now, context.workspaceId, context.ownerId, context.privacyEpoch);
      context.db.prepare(`INSERT INTO workspace_erase_receipts(command_id,workspace_id,owner_id,erased_privacy_epoch,current_privacy_epoch,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'cleanup_pending',?,?)`).run(input.commandId, context.workspaceId, context.ownerId,
        context.privacyEpoch, nextEpoch, context.now, context.now);
      context.db.prepare('DELETE FROM workspace_erase_plans WHERE workspace_id=? AND owner_id=?')
        .run(context.workspaceId, context.ownerId);
      return Object.freeze({ schemaVersion: 1 as const, commandId: input.commandId, status: 'cleanup_pending' as const,
        erasedPrivacyEpoch: context.privacyEpoch, currentPrivacyEpoch: nextEpoch, createdAt: new Date(context.now).toISOString() });
    });
    // The original browser session is revoked by the epoch change; only private held proof remains usable here.
    try { await this.#finishPhysicalCleanup(input.commandId, hold); }
    catch {
      // The database intent and epoch change already committed. Keep the exact runtime hold
      // and return its durable pending receipt so a fresh authenticated session can retry files.
      return this.#inspectReceiptByOwner(result.commandId, hold, result);
    }
    this.#holds.delete(this.#holdKey(hold));
    return this.#inspectReceiptByOwner(result.commandId, hold, result);
  }

  #holdKey(hold: WorkspaceEraseRuntimeHold): string { return JSON.stringify([hold.identity.workspaceId, hold.identity.ownerId, hold.commandId]); }
  #releaseCleanupHold(hold: WorkspaceEraseRuntimeHold): void {
    const key = this.#holdKey(hold);
    if (this.#releasedCleanupHolds.has(hold)) {
      if (this.#holds.get(key) === hold) this.#holds.delete(key);
      return;
    }
    hold.releaseAfterCleanup();
    this.#releasedCleanupHolds.add(hold);
    if (this.#holds.get(key) === hold) this.#holds.delete(key);
  }

  #assertHold(admission: WorkspaceHttpAdmission, hold: WorkspaceEraseRuntimeHold, commandId: string, verify: VerifyEraseRuntimeHold): void {
    if (!hold || typeof hold !== 'object' || hold.commandId !== commandId || typeof verify !== 'function') throw new Error('workspace_erase_hold_rejected');
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (hold.identity.workspaceId !== identity.workspaceId || hold.identity.ownerId !== identity.ownerId ||
        hold.identity.privacyEpoch !== identity.privacyEpoch) throw new Error('workspace_erase_hold_rejected');
    verify(hold, commandId);
    hold.assertHeld();
    const key = this.#holdKey(hold);
    const prior = this.#holds.get(key);
    if (prior && prior !== hold) throw new Error('workspace_erase_hold_replaced');
    this.#holds.set(key, hold);
  }

  async inspect(admission: WorkspaceHttpAdmission, commandId: string): Promise<WorkspaceEraseReceipt | undefined> {
    validateCommandId(commandId);
    admission.assertCurrent();
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const receipt = this.#readReceipt(commandId, identity.workspaceId, identity.ownerId);
    admission.assertCurrent();
    return receipt;
  }

  /** Explicitly retries only an already committed cleanup intent for this authenticated owner. */
  async retryPhysicalCleanup(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedPrivacyEpoch: number }>): Promise<WorkspaceEraseReceipt> {
    validateCommandId(input.commandId);
    if (!Number.isSafeInteger(input.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0) throw new Error('workspace_erase_input_invalid');
    admission.assertCurrent();
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const receipt = this.options.kernel.withOwnedTransaction(admission.sessionToken, input.expectedPrivacyEpoch, (context) => {
      this.options.auth.bindInitiatingSessionWithinTransaction(context, admission.sessionToken);
      const row = context.db.prepare(`SELECT status,current_privacy_epoch FROM workspace_erase_receipts
        WHERE command_id=? AND workspace_id=? AND owner_id=?`).get(input.commandId, context.workspaceId, context.ownerId) as
        { status: 'cleanup_pending' | 'complete'; current_privacy_epoch: number } | undefined;
      if (!row || row.current_privacy_epoch !== context.privacyEpoch || row.current_privacy_epoch !== input.expectedPrivacyEpoch) {
        throw new Error('workspace_erase_receipt_unavailable');
      }
      return row.status;
    });
    const key = JSON.stringify([identity.workspaceId, identity.ownerId, input.commandId]);
    const hold = [...this.#holds.values()].find((candidate) => candidate.identity.workspaceId === identity.workspaceId &&
      candidate.identity.ownerId === identity.ownerId && candidate.commandId === input.commandId);
    if (receipt === 'cleanup_pending') await this.#finishPhysicalCleanup(input.commandId, hold);
    else if (hold) this.#releaseCleanupHold(hold);
    if (hold) this.#holds.delete(key);
    admission.assertCurrent();
    const completed = this.#readReceipt(input.commandId, identity.workspaceId, identity.ownerId);
    if (!completed || completed.status !== 'complete') throw new Error('workspace_erase_cleanup_pending');
    return completed;
  }

  /** Read-only host fence; callers still need an authenticated workspace admission. */
  isWorkspaceErasePending(workspaceId: string, ownerId: string): boolean {
    return this.options.kernel.withTrustedDatabaseTransaction((db) => Boolean(db.prepare(`SELECT 1 AS present FROM workspace_erase_receipts
      WHERE workspace_id=? AND owner_id=? AND status='cleanup_pending'
      UNION ALL SELECT 1 AS present FROM workspace_erase_plans WHERE workspace_id=? AND owner_id=? LIMIT 1`)
      .get(workspaceId, ownerId, workspaceId, ownerId)));
  }

  /** Exact durable plan capability for resuming erase controls after a process restart. */
  isWorkspaceEraseCommandPending(workspaceId: string, ownerId: string, commandId: string): boolean {
    return this.options.kernel.withTrustedDatabaseTransaction((db) => Boolean(db.prepare(`SELECT 1 AS present FROM workspace_erase_plans
      WHERE workspace_id=? AND owner_id=? AND command_id=? AND status IN ('prepared','confirmed')`)
      .get(workspaceId, ownerId, commandId)));
  }

  isWorkspaceEraseComplete(workspaceId: string, ownerId: string, commandId: string): boolean {
    return this.options.kernel.withTrustedDatabaseTransaction((db) => Boolean(db.prepare(`SELECT 1 AS present FROM workspace_erase_receipts
      WHERE workspace_id=? AND owner_id=? AND command_id=? AND status='complete'`).get(workspaceId, ownerId, commandId)));
  }

  isWorkspaceEraseCancellationComplete(workspaceId: string, ownerId: string, commandId: string): boolean {
    return this.options.kernel.withTrustedDatabaseTransaction((db) => Boolean(db.prepare(`SELECT 1 AS present FROM workspace_erase_cancellations
      WHERE workspace_id=? AND owner_id=? AND command_id=?`).get(workspaceId, ownerId, commandId)));
  }

  async inspectStatus(admission: WorkspaceHttpAdmission): Promise<WorkspaceEraseStatus> {
    admission.assertCurrent();
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const result = this.options.kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
      this.options.auth.bindInitiatingSessionWithinTransaction(context, admission.sessionToken);
      const pendingReceipt = context.db.prepare(`SELECT command_id,workspace_id,owner_id,erased_privacy_epoch,current_privacy_epoch,status,created_at
        FROM workspace_erase_receipts WHERE workspace_id=? AND owner_id=? AND status='cleanup_pending' ORDER BY created_at DESC,command_id DESC LIMIT 1`)
        .get(context.workspaceId, context.ownerId) as { command_id: string; workspace_id: string; owner_id: string; erased_privacy_epoch: number;
          current_privacy_epoch: number; status: 'cleanup_pending' | 'complete'; created_at: number } | undefined;
      if (pendingReceipt) return Object.freeze({ schemaVersion: 1 as const, status: pendingReceipt.status,
        receipt: Object.freeze({ schemaVersion: 1 as const, commandId: pendingReceipt.command_id, status: pendingReceipt.status,
          erasedPrivacyEpoch: pendingReceipt.erased_privacy_epoch, currentPrivacyEpoch: pendingReceipt.current_privacy_epoch,
          createdAt: new Date(pendingReceipt.created_at).toISOString() }) });
      const plan = context.db.prepare(`SELECT * FROM workspace_erase_plans WHERE workspace_id=? AND owner_id=? ORDER BY created_at DESC,command_id DESC LIMIT 1`)
        .get(context.workspaceId, context.ownerId) as ErasePlanRow | undefined;
      if (plan) return Object.freeze({ schemaVersion: 1 as const, status: plan.status, plan: this.#projectPlan(plan) });
      const receiptRow = context.db.prepare(`SELECT command_id,workspace_id,owner_id,erased_privacy_epoch,current_privacy_epoch,status,created_at
        FROM workspace_erase_receipts WHERE workspace_id=? AND owner_id=? ORDER BY created_at DESC,command_id DESC LIMIT 1`)
        .get(context.workspaceId, context.ownerId) as { command_id: string; workspace_id: string; owner_id: string; erased_privacy_epoch: number;
          current_privacy_epoch: number; status: 'cleanup_pending' | 'complete'; created_at: number } | undefined;
      const cancellationRow = context.db.prepare(`SELECT command_id,workspace_id,owner_id,privacy_epoch,cancelled_at
        FROM workspace_erase_cancellations WHERE workspace_id=? AND owner_id=? ORDER BY cancelled_at DESC,command_id DESC LIMIT 1`)
        .get(context.workspaceId, context.ownerId) as { command_id: string; privacy_epoch: number; cancelled_at: number } | undefined;
      if (cancellationRow && (!receiptRow || cancellationRow.cancelled_at >= receiptRow.created_at)) {
        return Object.freeze({ schemaVersion: 1 as const, status: 'cancelled' as const,
          cancellation: Object.freeze({ schemaVersion: 1 as const, commandId: cancellationRow.command_id, status: 'cancelled' as const,
            privacyEpoch: cancellationRow.privacy_epoch, cancelledAt: new Date(cancellationRow.cancelled_at).toISOString() }) });
      }
      return receiptRow ? Object.freeze({ schemaVersion: 1 as const, status: receiptRow.status,
        receipt: Object.freeze({ schemaVersion: 1 as const, commandId: receiptRow.command_id, status: receiptRow.status,
          erasedPrivacyEpoch: receiptRow.erased_privacy_epoch, currentPrivacyEpoch: receiptRow.current_privacy_epoch,
          createdAt: new Date(receiptRow.created_at).toISOString() }) })
        : Object.freeze({ schemaVersion: 1 as const, status: 'none' as const });
    });
    admission.assertCurrent();
    return result;
  }

  /** Best effort cold-start resumption; unresolved rows remain durable and block that workspace. */
  async resumePendingPhysicalCleanup(): Promise<void> {
    const pending = this.options.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT command_id,workspace_id,owner_id FROM workspace_erase_receipts
      WHERE status='cleanup_pending' ORDER BY created_at,command_id`).all() as Array<{ command_id: string; workspace_id: string; owner_id: string }>);
    for (const row of pending) {
      try { await this.#finishPhysicalCleanup(row.command_id); } catch { /* The receipt remains pending for explicit retry. */ }
    }
  }

  #requireConfirmedPlan(context: OwnedTransactionContext, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>,
    now: number): ErasePlanRow {
    const row = context.db.prepare('SELECT * FROM workspace_erase_plans WHERE command_id=?').get(input.commandId) as ErasePlanRow | undefined;
    if (!row || row.status !== 'confirmed' || row.workspace_id !== context.workspaceId || row.owner_id !== context.ownerId ||
        row.privacy_epoch !== context.privacyEpoch || row.revision !== input.expectedRevision || context.revision !== input.expectedRevision ||
        row.expires_at <= now) throw new Error('workspace_erase_plan_unavailable');
    return row;
  }

  #withEraseDeleteGrant<T>(context: OwnedTransactionContext, hold: WorkspaceEraseRuntimeHold, operation: () => T): T {
    // The kernel WeakMap proof is required before this private grant can exist.
    this.options.kernel.readOwnedSnapshotWithinTransaction(context);
    hold.assertHeld();
    if (activeErase.has(context.db) || !context.db.inTransaction || hold.identity.workspaceId !== context.workspaceId ||
        hold.identity.ownerId !== context.ownerId || hold.identity.privacyEpoch !== context.privacyEpoch) {
      throw new Error('workspace_erase_delete_authority_rejected');
    }
    const firstRetiredEpoch = 0;
    const lastRetiredEpoch = context.privacyEpoch;
    activeErase.set(context.db, Object.freeze({ context, workspaceId: context.workspaceId, ownerId: context.ownerId,
      firstRetiredEpoch, lastRetiredEpoch }));
    let result: T;
    try {
      result = operation();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('workspace_erase_cleanup_must_be_synchronous');
      }
    } finally { activeErase.delete(context.db); }
    return result;
  }

  #stagePhysicalCleanup(context: OwnedTransactionContext, commandId: string, snapshot: unknown): void {
    const hasAudio = tableExists(context.db, 'private_audio_uploads');
    const audioRows = hasAudio ? context.db.prepare(`SELECT count(*) AS count FROM private_audio_uploads WHERE workspace_id=? AND owner_id=? AND privacy_epoch<=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch) as { count: number } : { count: 0 };
    if (audioRows.count > 0 && !this.options.privateAudioRoot) throw new Error('workspace_erase_audio_cleanup_unavailable');
    if (hasAudio) {
      const rows = context.db.prepare(`SELECT temp_name,final_name FROM private_audio_uploads WHERE workspace_id=? AND owner_id=? AND privacy_epoch<=?`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch) as Array<{ temp_name: string; final_name: string }>;
      for (const row of rows) for (const name of new Set([row.temp_name, row.final_name])) {
        if (!AUDIO_FILE.test(name)) throw new Error('workspace_erase_audio_path_invalid');
        context.db.prepare(`INSERT OR IGNORE INTO workspace_erase_files(command_id,workspace_id,owner_id,privacy_epoch,kind,relative_path)
          VALUES(?,?,?,?,'audio',?)`).run(commandId, context.workspaceId, context.ownerId, context.privacyEpoch, name);
      }
    }
    const documents = snapshot && typeof snapshot === 'object' && Array.isArray((snapshot as { documents?: unknown }).documents)
      ? ((snapshot as { documents: unknown[] }).documents.length) : 0;
    const privateRows = countPrivateDocumentRows(context.db, context.workspaceId, context.ownerId);
    if ((documents > 0 || privateRows > 0) && !this.options.privateDocumentsRoot) throw new Error('workspace_erase_document_cleanup_unavailable');
    if (this.options.privateAudioRoot) context.db.prepare(`INSERT OR IGNORE INTO workspace_erase_files(command_id,workspace_id,owner_id,privacy_epoch,kind,relative_path)
      VALUES(?,?,?,?,'audio','workspace-tree')`).run(commandId, context.workspaceId, context.ownerId, context.privacyEpoch);
    if (this.options.privateDocumentsRoot) context.db.prepare(`INSERT OR IGNORE INTO workspace_erase_files(command_id,workspace_id,owner_id,privacy_epoch,kind,relative_path)
      VALUES(?,?,?,?,'documents','workspace-tree')`).run(commandId, context.workspaceId, context.ownerId, context.privacyEpoch);
  }

  #deletePrivateRows(context: OwnedTransactionContext): void {
    const { db, workspaceId, ownerId, privacyEpoch } = context;
    const scoped = (table: string, columns: Readonly<{ workspace: string; owner?: string; epoch?: string }>) => {
      if (!tableExists(db, table)) return;
      const parts = [`${columns.workspace}=?`, `EXISTS(SELECT 1 FROM workspaces erase_scope WHERE erase_scope.id=${table}.${columns.workspace} AND erase_scope.owner_id=?)`];
      const args: unknown[] = [workspaceId, ownerId];
      if (columns.owner) { parts.push(`${columns.owner}=?`); args.push(ownerId); }
      if (columns.epoch) { parts.push(`${columns.epoch}<=?`); args.push(privacyEpoch); }
      db.prepare(`DELETE FROM ${table} WHERE ${parts.join(' AND ')}`).run(...args);
    };
    // Child rows first; workspace ownership and auth-owner/password rows intentionally survive.
    scoped('external_attempts', { workspace: 'workspace_id' });
    scoped('one_use_plans', { workspace: 'workspace_id' });
    scoped('commands', { workspace: 'workspace_id' });
    scoped('credential_commands', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('speech_cleanup_children', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('async_command_journal', { workspace: 'workspace_id' });
    scoped('oauth_install_stages', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('oauth_connection_starts', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('server_oauth_token_bindings', { workspace: 'workspace_id', epoch: 'privacy_epoch' });
    for (const table of ['background_occurrence_attempts', 'background_occurrence_targets', 'background_occurrences',
      'background_policy_commands', 'background_policy_revisions', 'background_policy_heads', 'background_paid_batch_links',
      'background_proactive_preflight_attempts', 'background_proactive_candidates', 'background_proactive_candidate_scopes']) {
      scoped(table, { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    }
    // Subscription generations and mutable heads precede VAPID-key parents; command receipts contain metadata only.
    scoped('web_push_subscriptions', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('web_push_subscription_heads', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('web_push_vapid_heads', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('web_push_vapid_keys', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('web_push_commands', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    // This parent delete cascades the exact workspace/owner/epoch batch ledger rows.
    scoped('batch_observation_workspaces', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    if (tableExists(db, 'private_audio_cleanup_intents')) {
      db.prepare('DELETE FROM private_audio_cleanup_intents WHERE workspace_id=? AND owner_id=? AND privacy_epoch<=?')
        .run(workspaceId, ownerId, privacyEpoch);
    }
    scoped('private_audio_speech_leases', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('private_audio_readers', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('private_audio_capture_uploads', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('private_audio_uploads', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('document_lineage_heads', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('document_lineage_scopes', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    // Receipt deletion is permitted only while the exact workspace erase proof is active;
    // the table trigger also rejects deletion without this grant.
    scoped('period_summary_application_receipts', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('batch_observation_workspaces', { workspace: 'workspace_id', owner: 'owner_id', epoch: 'privacy_epoch' });
    scoped('account_generations', { workspace: 'workspace_id' });
  }

  #projectPlan(row: ErasePlanRow): WorkspaceErasePlan {
    const counts = parseCounts(row.counts_json);
    return Object.freeze({ schemaVersion: 1, commandId: row.command_id, expectedRevision: row.revision,
      expectedPrivacyEpoch: row.privacy_epoch, expiresAt: new Date(row.expires_at).toISOString(), counts, status: row.status });
  }

  #readReceipt(commandId: string, workspaceId: string, ownerId: string): WorkspaceEraseReceipt | undefined {
    return this.options.kernel.withTrustedDatabaseTransaction((db) => {
      const row = db.prepare(`SELECT command_id,workspace_id,owner_id,erased_privacy_epoch,current_privacy_epoch,status,created_at
        FROM workspace_erase_receipts WHERE command_id=? AND workspace_id=? AND owner_id=?`).get(commandId, workspaceId, ownerId) as
        { command_id: string; workspace_id: string; owner_id: string; erased_privacy_epoch: number; current_privacy_epoch: number;
          status: 'cleanup_pending' | 'complete'; created_at: number } | undefined;
      return row ? Object.freeze({ schemaVersion: 1 as const, commandId: row.command_id, status: row.status,
        erasedPrivacyEpoch: row.erased_privacy_epoch, currentPrivacyEpoch: row.current_privacy_epoch,
        createdAt: new Date(row.created_at).toISOString() }) : undefined;
    });
  }

  #finishPhysicalCleanup(commandId: string, hold?: WorkspaceEraseRuntimeHold): Promise<void> {
    const receipt = this.options.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT workspace_id,owner_id,status
      FROM workspace_erase_receipts WHERE command_id=?`).get(commandId) as { workspace_id: string; owner_id: string; status: string } | undefined);
    if (!receipt) return Promise.resolve();
    if (receipt.status === 'complete') { if (hold) this.#releaseCleanupHold(hold); return Promise.resolve(); }
    if (receipt.status !== 'cleanup_pending') throw new Error('workspace_erase_receipt_changed');
    hold?.assertHeld();
    const files = Object.freeze(this.options.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT kind,relative_path FROM workspace_erase_files
      WHERE command_id=? AND workspace_id=? AND owner_id=? ORDER BY kind,relative_path`).all(commandId, receipt.workspace_id, receipt.owner_id) as
      Array<{ kind: 'audio' | 'documents'; relative_path: string }>).map((file) => Object.freeze(file)));
    const flightKey = JSON.stringify([receipt.workspace_id, receipt.owner_id, commandId]);
    const existing = this.#cleanupFlights.get(flightKey);
    if (existing) {
      if (hold) existing.holds.add(hold);
      return existing.promise;
    }
    const flight: { promise: Promise<void>; holds: Set<WorkspaceEraseRuntimeHold> } = {
      promise: Promise.resolve(), holds: new Set(hold ? [hold] : []),
    };
    this.#cleanupFlights.set(flightKey, flight);
    // Defer actual work until after the shared flight is installed synchronously.
    flight.promise = Promise.resolve().then(async () => {
      try {
        await this.#performPhysicalCleanup(commandId, receipt, files, flight.holds);
        for (const exactHold of flight.holds) this.#releaseCleanupHold(exactHold);
      } finally {
        if (this.#cleanupFlights.get(flightKey) === flight) this.#cleanupFlights.delete(flightKey);
      }
    });
    return flight.promise;
  }

  async #performPhysicalCleanup(commandId: string, receipt: { workspace_id: string; owner_id: string; status: string },
    files: readonly Readonly<{ kind: 'audio' | 'documents'; relative_path: string }>[], holds: ReadonlySet<WorkspaceEraseRuntimeHold>): Promise<void> {
    try {
      for (const file of files) {
        if (file.kind === 'audio') {
          if (!this.options.privateAudioRoot) throw new Error('workspace_erase_audio_cleanup_unavailable');
          const root = privateAudioWorkspaceRoot(this.options.privateAudioRoot, receipt.workspace_id);
          await assertNoSymlinkAncestors(root);
          if (file.relative_path === 'workspace-tree') {
            await this.options.beforePhysicalCleanupForTesting?.(Object.freeze({ commandId, workspaceId: receipt.workspace_id,
              ownerId: receipt.owner_id, kind: file.kind, relativePath: file.relative_path }));
            await removeTreeWithoutFollowingLinks(root);
          }
          else {
            if (!AUDIO_FILE.test(file.relative_path)) throw new Error('workspace_erase_audio_path_invalid');
            const target = privateAudioStoragePath(root, file.relative_path);
            await this.options.beforePhysicalCleanupForTesting?.(Object.freeze({ commandId, workspaceId: receipt.workspace_id,
              ownerId: receipt.owner_id, kind: file.kind, relativePath: file.relative_path }));
            await rm(target, { force: true });
            if (await pathExists(target)) throw new Error('workspace_erase_audio_cleanup_pending');
          }
        } else {
          if (!this.options.privateDocumentsRoot || file.relative_path !== 'workspace-tree') throw new Error('workspace_erase_document_cleanup_unavailable');
          const workspaceRoot = privateDocumentsWorkspaceRoot(this.options.privateDocumentsRoot, receipt.owner_id, receipt.workspace_id);
          await assertNoSymlinkAncestors(workspaceRoot);
          await this.options.beforePhysicalCleanupForTesting?.(Object.freeze({ commandId, workspaceId: receipt.workspace_id,
            ownerId: receipt.owner_id, kind: file.kind, relativePath: file.relative_path }));
          await removeTreeWithoutFollowingLinks(workspaceRoot);
        }
      }
      for (const exactHold of holds) exactHold.assertHeld();
      this.options.kernel.withTrustedDatabaseTransaction((db) => {
        const transaction = db.transaction(() => {
          const current = db.prepare('SELECT status,workspace_id,owner_id FROM workspace_erase_receipts WHERE command_id=?').get(commandId) as
            { status: string; workspace_id: string; owner_id: string } | undefined;
          if (!current || current.workspace_id !== receipt.workspace_id || current.owner_id !== receipt.owner_id) throw new Error('workspace_erase_receipt_changed');
          if (current.status === 'complete') return;
          const remaining = db.prepare('SELECT count(*) AS count FROM workspace_erase_files WHERE command_id=? AND workspace_id=? AND owner_id=?')
            .get(commandId, receipt.workspace_id, receipt.owner_id) as { count: number };
          if (remaining.count !== files.length) throw new Error('workspace_erase_cleanup_changed');
          db.prepare('DELETE FROM workspace_erase_files WHERE command_id=? AND workspace_id=? AND owner_id=?')
            .run(commandId, receipt.workspace_id, receipt.owner_id);
          db.prepare(`UPDATE workspace_erase_receipts SET status='complete',updated_at=? WHERE command_id=? AND status='cleanup_pending'`)
            .run(this.#now(), commandId);
        });
        transaction.immediate();
      });
    } catch (error) {
      throw error;
    }
  }

  #inspectReceiptByOwner(commandId: string, hold: WorkspaceEraseRuntimeHold, fallback: WorkspaceEraseReceipt): WorkspaceEraseReceipt {
    const row = this.options.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT command_id,workspace_id,owner_id,erased_privacy_epoch,current_privacy_epoch,status,created_at
      FROM workspace_erase_receipts WHERE command_id=? AND workspace_id=? AND owner_id=?`).get(commandId, hold.identity.workspaceId, hold.identity.ownerId) as
      { command_id: string; workspace_id: string; owner_id: string; erased_privacy_epoch: number; current_privacy_epoch: number; status: 'cleanup_pending' | 'complete'; created_at: number } | undefined);
    return row ? Object.freeze({ schemaVersion: 1, commandId: row.command_id, status: row.status,
      erasedPrivacyEpoch: row.erased_privacy_epoch, currentPrivacyEpoch: row.current_privacy_epoch, createdAt: new Date(row.created_at).toISOString() }) : fallback;
  }
}

/** Installs the trigger callback once on the exact kernel connection. It never grants authority. */
export function registerWorkspaceEraseDeleteGuard(db: Database.Database): void {
  if (registeredConnections.has(db)) return;
  db.function('still_workspace_erase_authorized', (workspaceId: unknown, ownerId: unknown, epoch: unknown) => {
    const grant = activeErase.get(db);
    if (!grant || !grant.context.db.inTransaction) return 0;
    try { grant.context.assertActive(); } catch { return 0; }
    return workspaceId === grant.workspaceId && ownerId === grant.ownerId && Number.isSafeInteger(epoch) &&
      (epoch as number) >= grant.firstRetiredEpoch && (epoch as number) <= grant.lastRetiredEpoch ? 1 : 0;
  });
  registeredConnections.add(db);
}

function initializeEraseSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_erase_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1)) STRICT;
    INSERT OR IGNORE INTO workspace_erase_schema(singleton,version) VALUES(1,1);
    CREATE TABLE IF NOT EXISTS workspace_erase_plans(command_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),revision INTEGER NOT NULL CHECK(revision>=0),session_binding TEXT NOT NULL CHECK(length(session_binding)=64),
      counts_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('prepared','confirmed')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at>created_at)) STRICT;
    CREATE INDEX IF NOT EXISTS workspace_erase_plans_scope ON workspace_erase_plans(workspace_id,owner_id,privacy_epoch,created_at);
    CREATE TABLE IF NOT EXISTS workspace_erase_receipts(command_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      erased_privacy_epoch INTEGER NOT NULL CHECK(erased_privacy_epoch>=0),current_privacy_epoch INTEGER NOT NULL CHECK(current_privacy_epoch=erased_privacy_epoch+1),
      status TEXT NOT NULL CHECK(status IN ('cleanup_pending','complete')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS workspace_erase_receipts_scope ON workspace_erase_receipts(workspace_id,owner_id,status,created_at);
    CREATE TABLE IF NOT EXISTS workspace_erase_cancellations(command_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),cancelled_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS workspace_erase_files(command_id TEXT NOT NULL,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,
      privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),kind TEXT NOT NULL CHECK(kind IN ('audio','documents')),relative_path TEXT NOT NULL,
      PRIMARY KEY(command_id,kind,relative_path)) STRICT;`);
  const marker = db.prepare('SELECT singleton,version FROM workspace_erase_schema').all() as Array<{ singleton: number; version: number }>;
  if (marker.length !== 1 || marker[0]?.singleton !== 1 || marker[0]?.version !== 1) throw new Error('workspace_erase_schema_invalid');
}

function validatePlanInput(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): void {
  validateCommandId(input?.commandId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !Number.isSafeInteger(input.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0) {
    throw new TypeError('workspace_erase_input_invalid');
  }
}
function validateCommandId(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID_V4.test(value)) throw new TypeError('workspace_erase_command_id_invalid'); }
function privateDocumentsWorkspaceRoot(privateRoot: string, ownerId: string, workspaceId: string): string {
  if (!isAbsolute(privateRoot) || privateRoot.includes('\0') || !UUID_V4.test(ownerId) || !UUID_V4.test(workspaceId)) {
    throw new Error('workspace_erase_document_path_invalid');
  }
  const base = resolve(privateRoot);
  const ownerRoot = resolve(base, ownerId);
  const workspaceRoot = resolve(ownerRoot, workspaceId);
  if (dirname(ownerRoot) !== base || dirname(workspaceRoot) !== ownerRoot ||
      relative(base, workspaceRoot).startsWith(`..${sep}`) || relative(base, workspaceRoot) === '..') {
    throw new Error('workspace_erase_document_path_invalid');
  }
  return workspaceRoot;
}
function tableExists(db: Database.Database, table: string): boolean { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function countRows(db: Database.Database, table: string, workspaceId: string, ownerId?: string): number {
  if (!tableExists(db, table)) return 0;
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'workspace_id')) return 0;
  const hasOwner = columns.some((column) => column.name === 'owner_id');
  const sql = `SELECT count(*) AS count FROM ${table} WHERE workspace_id=?${hasOwner && ownerId ? ' AND owner_id=?' : ''}`;
  return (db.prepare(sql).get(...(hasOwner && ownerId ? [workspaceId, ownerId] : [workspaceId])) as { count: number }).count;
}
function countPrivateDocumentRows(db: Database.Database, workspaceId: string, ownerId: string): number {
  return countRows(db, 'document_lineage_heads', workspaceId, ownerId);
}
function countPrivateMetadata(db: Database.Database, workspaceId: string, ownerId: string, snapshot: unknown): WorkspaceEraseCounts {
  const state = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {};
  const listLength = (key: string) => Array.isArray(state[key]) ? (state[key] as unknown[]).length : 0;
  return Object.freeze({ notes: listLength('notes'), documents: listLength('documents'), accounts: listLength('accounts'),
    proposals: listLength('proposals'), audioUploads: countRows(db, 'private_audio_uploads', workspaceId, ownerId),
    backgroundPolicies: countRows(db, 'background_policy_heads', workspaceId, ownerId) });
}
function parseCounts(value: string): WorkspaceEraseCounts {
  let parsed: unknown; try { parsed = JSON.parse(value) as unknown; } catch { throw new Error('workspace_erase_plan_corrupt'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('workspace_erase_plan_corrupt');
  const fields = ['notes','documents','accounts','proposals','audioUploads','backgroundPolicies'] as const;
  const source = parsed as Record<string, unknown>;
  if (Object.keys(source).length !== fields.length || fields.some((field) => !Number.isSafeInteger(source[field]) || (source[field] as number) < 0)) {
    throw new Error('workspace_erase_plan_corrupt');
  }
  return Object.freeze({ notes: source.notes as number, documents: source.documents as number, accounts: source.accounts as number,
    proposals: source.proposals as number, audioUploads: source.audioUploads as number, backgroundPolicies: source.backgroundPolicies as number });
}
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error;
} }
async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const volumeRoot = parse(absolute).root;
  let current = volumeRoot;
  const pieces = relative(volumeRoot, absolute).split(sep).filter(Boolean);
  for (let index = 0; index < pieces.length; index += 1) {
    current = resolve(current, pieces[index]!);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('workspace_erase_document_symlink_rejected');
    if (index < pieces.length - 1 && !info.isDirectory()) throw new Error('workspace_erase_document_path_invalid');
  }
}
async function removeTreeWithoutFollowingLinks(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) { await rm(path, { force: true }); return; }
  if (!info.isDirectory()) { await rm(path, { force: true }); return; }
  for (const entry of await readdir(path)) await removeTreeWithoutFollowingLinks(resolve(path, entry));
  await rmdir(path);
}
