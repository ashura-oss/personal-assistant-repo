import { currentCommandTicket } from '../../server/src/commandJournal.js';
import { SpeechCleanupChildren, type SpeechCleanupChildHandle, type SpeechCleanupOutcome,
  type SpeechCleanupProvider, type SpeechCleanupSettlementProof } from '../../server/src/speechCleanupChildren.js';
import type { LoadedWorkspaceStateProof } from '../../server/src/workspaceStore.js';
import type { ControllerSpeechCleanupObserver, ControllerSpeechCleanupPort } from '../services/controller.shared';

interface ChildWork {
  readonly childId: string;
  readonly leaseId: string;
  readonly parentTicketId: string;
  readonly handle: SpeechCleanupChildHandle;
  parentFinished: boolean;
  markedPending: boolean;
  cleanupOutcome?: SpeechCleanupOutcome;
  retryCleanup?: () => Promise<void>;
  retryInFlight?: Promise<void>;
  observationPromise?: Promise<void>;
  settlementPromise?: Promise<void>;
  settlementAcknowledged: boolean;
  settlementFailed: boolean;
  scheduled: boolean;
  expectedRefresh?: SpeechCleanupSettlementProof;
  retirementOnly?: boolean;
}

export interface NodeSpeechCleanupAdapterOptions {
  readonly children: SpeechCleanupChildren;
  /** Serialized by the owning workspace gateway after the parent command completes. */
  readonly scheduleSettlement: (work: () => Promise<void>) => Promise<void>;
  readonly invalidateLoadedSnapshot: () => void;
}

/**
 * Per-controller bridge from the shared speech hook to the private durable child
 * service. It never exposes handles or callbacks to browser-facing projections.
 */
export class NodeSpeechCleanupAdapter {
  readonly controllerPort: ControllerSpeechCleanupPort;
  private readonly byChild = new Map<string, ChildWork>();
  private readonly byLease = new Map<string, ChildWork>();
  private readonly byParent = new Map<string, Set<ChildWork>>();

  constructor(private readonly options: NodeSpeechCleanupAdapterOptions) {
    this.controllerPort = Object.freeze({ register: (input: Parameters<ControllerSpeechCleanupPort['register']>[0]) => this.register(input) });
  }

  parentInvocationCompleted(parentTicketId: string): boolean {
    const rows = this.byParent.get(parentTicketId);
    if (!rows) return false;
    for (const row of rows) {
      row.parentFinished = true;
      this.trySchedule(row);
    }
    return true;
  }

  hasChildrenForParent(parentTicketId: string): boolean {
    return (this.byParent.get(parentTicketId)?.size ?? 0) > 0;
  }

  /** Called only after an explicit successful controller refresh. */
  acknowledgeAfterRefresh(proof: LoadedWorkspaceStateProof): number {
    let acknowledged = 0;
    for (const row of this.byChild.values()) {
      const expected = row.expectedRefresh;
      if (!expected) continue;
      this.options.children.acknowledgeAfterRefresh(row.handle, proof, expected);
      row.expectedRefresh = undefined;
      row.settlementAcknowledged = true;
      row.settlementFailed = false;
      acknowledged += 1;
    }
    return acknowledged;
  }

  /** Shutdown waits for the real cleanup promise and its one durable settlement attempt. */
  async drain(): Promise<void> {
    const rows = [...this.byChild.values()];
    await Promise.allSettled(rows.map((row) => row.observationPromise ?? Promise.resolve()));
    await Promise.allSettled(rows.map((row) => row.settlementPromise ?? Promise.resolve()));
    if (rows.some((row) => row.cleanupOutcome === undefined || row.cleanupOutcome === 'pending_cleanup' ||
        !row.settlementAcknowledged || row.settlementFailed || row.expectedRefresh)) {
      throw new Error('Speech cleanup ownership requires exact cleanup or settlement acknowledgement before runtime disposal.');
    }
  }

  /** Physical cleanup proof used only when a newer privacy epoch retires this actor. */
  async drainPhysicalCleanupForRetirement(): Promise<void> {
    const rows = [...this.byChild.values()];
    await Promise.all(rows.map((row) => row.observationPromise ?? Promise.resolve()));
    if (rows.some((row) => row.cleanupOutcome !== 'released')) {
      throw new Error('Speech cleanup physical work is unresolved and the old runtime must remain fenced.');
    }
  }

  hasRefreshAcknowledgementHold(): boolean {
    return [...this.byChild.values()].some((row) => row.expectedRefresh !== undefined);
  }

  /** Explicit trusted retry for one exact live child; never called automatically. */
  async retryCleanup(childId: string): Promise<void> {
    const row = this.byChild.get(childId);
    if (!row || !row.retryCleanup) throw new Error('The exact live speech cleanup retry is unavailable.');
    if (this.options.children.inspect(childId)?.refreshRequired) throw new Error('Refresh the workspace before retrying speech cleanup.');
    if (row.retryInFlight) return row.retryInFlight;
    const retry = (async () => {
      row.cleanupOutcome = undefined;
      row.scheduled = false;
      const attempt = Promise.resolve().then(row.retryCleanup);
      row.observationPromise = attempt.then(
        () => { row.cleanupOutcome = 'released'; this.trySchedule(row); },
        () => { row.cleanupOutcome = 'pending_cleanup'; this.trySchedule(row); throw new Error('The exact speech cleanup retry did not complete.'); },
      );
      await row.observationPromise;
      await row.settlementPromise;
    })();
    row.retryInFlight = retry;
    try { await retry; }
    finally { if (row.retryInFlight === retry) row.retryInFlight = undefined; }
  }

  /**
   * Newer-epoch physical retirement only. The caller must first prove this is
   * the exact fenced old entry; this path never inspects or writes through its
   * revoked durable actor and never schedules child settlement.
   */
  async retryCleanupForRetirement(childId: string): Promise<void> {
    const row = this.byChild.get(childId);
    if (!row || !row.retryCleanup || row.cleanupOutcome !== 'pending_cleanup') {
      throw new Error('The exact old-epoch physical cleanup retry is unavailable.');
    }
    row.retirementOnly = true;
    if (row.retryInFlight) return row.retryInFlight;
    const retry = (async () => {
      row.cleanupOutcome = undefined;
      row.scheduled = false;
      const attempt = Promise.resolve().then(row.retryCleanup);
      row.observationPromise = attempt.then(
        () => { row.cleanupOutcome = 'released'; },
        () => { row.cleanupOutcome = 'pending_cleanup'; throw new Error('The exact old-epoch physical cleanup retry did not complete.'); },
      );
      await row.observationPromise;
    })();
    row.retryInFlight = retry;
    try { await retry; }
    finally { if (row.retryInFlight === retry) row.retryInFlight = undefined; }
  }

  async retryCleanupForLease(leaseId: string): Promise<void> {
    const row = this.byLease.get(leaseId);
    if (!row) throw new Error('The exact live speech cleanup retry is unavailable.');
    await this.retryCleanup(row.childId);
  }

  /** Explicitly retries only the same durable named transition after a database failure. */
  async retrySettlement(childId: string): Promise<void> {
    const row = this.byChild.get(childId);
    if (!row || !row.settlementFailed || row.cleanupOutcome === undefined) {
      throw new Error('The exact speech cleanup settlement retry is unavailable.');
    }
    if (row.expectedRefresh) throw new Error('Refresh the workspace before acknowledging speech cleanup settlement.');
    row.scheduled = false;
    this.trySchedule(row);
    if (!row.settlementPromise) throw new Error('The exact speech cleanup settlement retry is unavailable.');
    await row.settlementPromise;
  }

  private register(input: { readonly noteId: string; readonly attemptId: string; readonly leaseId: string; readonly provider: SpeechCleanupProvider }): ControllerSpeechCleanupObserver {
    const ticket = currentCommandTicket();
    if (!ticket) throw new Error('Speech cleanup registration requires its active command ticket.');
    const result = this.options.children.registerCurrentChild(input);
    if (!result.handle) throw new Error('The exact speech cleanup child is not live in this process.');
    const prior = this.byChild.get(result.childId);
    if (prior) {
      if (prior.parentTicketId !== ticket.ticketId || prior.handle !== result.handle) throw new Error('Speech cleanup child is already owned by another command.');
      return this.observerFor(prior);
    }
    const row: ChildWork = { childId: result.childId, leaseId: input.leaseId, parentTicketId: ticket.ticketId, handle: result.handle,
      parentFinished: false, markedPending: false, scheduled: false, settlementAcknowledged: false, settlementFailed: false };
    this.byChild.set(row.childId, row);
    this.byLease.set(row.leaseId, row);
    const children = this.byParent.get(row.parentTicketId) ?? new Set<ChildWork>();
    children.add(row);
    this.byParent.set(row.parentTicketId, children);
    return this.observerFor(row);
  }

  private observerFor(row: ChildWork): ControllerSpeechCleanupObserver {
    return Object.freeze({
      markPending: () => { row.markedPending = true; this.trySchedule(row); },
      observeCleanup: (actualCleanup: Promise<void>, retryCleanup: () => Promise<void>) => {
        if (row.cleanupOutcome !== undefined || row.retryCleanup) throw new Error('Speech cleanup promise was already observed.');
        row.retryCleanup = retryCleanup;
        // Attach both handlers immediately. A failed cleanup is retained as a
        // pending lease; it is never treated as released or retried here.
        row.observationPromise = Promise.resolve(actualCleanup).then(
          () => { row.cleanupOutcome = 'released'; this.trySchedule(row); },
          () => { row.cleanupOutcome = 'pending_cleanup'; this.trySchedule(row); },
        );
      },
    });
  }

  private trySchedule(row: ChildWork): void {
    if (row.retirementOnly || !row.parentFinished || !row.markedPending || row.cleanupOutcome === undefined || row.scheduled) return;
    row.scheduled = true;
    const scheduled = this.options.scheduleSettlement(async () => {
      this.options.invalidateLoadedSnapshot();
      try {
        this.options.children.settle(row.handle, row.cleanupOutcome!);
        row.settlementAcknowledged = true;
        row.settlementFailed = false;
      } catch {
        // Settlement may commit and lose its acknowledgement. Preserve the
        // exact local handle and receipt reference for refresh-only clearing.
        const inspection = this.options.children.inspect(row.childId);
        if (inspection?.refreshRequired && inspection.lastSettlement) {
          row.expectedRefresh = Object.freeze({ childId: row.childId, outcome: inspection.lastSettlement.outcome,
            idempotencyKey: inspection.lastSettlement.idempotencyKey, revision: inspection.lastSettlement.revision });
        }
        row.settlementFailed = true;
        throw new Error('Speech cleanup durable settlement remains unresolved.');
      } finally {
        this.options.invalidateLoadedSnapshot();
      }
    });
    row.settlementPromise = scheduled.catch(() => {
      row.settlementFailed = true;
      row.scheduled = false;
      this.options.invalidateLoadedSnapshot();
      throw new Error('Speech cleanup durable settlement remains unresolved.');
    });
    void row.settlementPromise.catch(() => undefined);
  }
}
