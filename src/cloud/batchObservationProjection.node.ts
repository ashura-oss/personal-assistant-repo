import { validateOpenRouterBatchLedger, type OpenRouterBatchJob } from '../services/openRouterBatchJobs';
import { BatchObservationIndex, type BatchObservationLedgerProjection } from '../../server/src/batchObservationIndex.js';
import type { OwnedTransactionContext } from '../../server/src/kernel.js';
import type { SnapshotCommitParticipant, SnapshotCommitParticipantInput } from '../../server/src/workspaceStore.js';

const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled', 'result_stale', 'result_invalid', 'result_truncated', 'result_not_retained']);

/** Builds a closed, content-free index projection. Invalid ledgers quarantine this workspace's index. */
export function projectBatchObservationLedger(snapshot: unknown): BatchObservationLedgerProjection {
  try {
    const state = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : undefined;
    if (!state || !Object.prototype.hasOwnProperty.call(state, 'openRouterBatchLedger')) return Object.freeze({ schemaVersion: 1, valid: true, jobs: Object.freeze([]) });
    const ledger = validateOpenRouterBatchLedger(state.openRouterBatchLedger);
    const jobs = ledger.jobs.flatMap((job: OpenRouterBatchJob) => {
      if (!job.batchId) return [];
      const terminalObserved = TERMINAL.has(job.status) || job.status === 'source_removed' && Boolean(job.providerObservation);
      return [Object.freeze({ jobId: job.id, customId: job.customId, batchId: job.batchId, requestSha256: job.requestSha256,
        status: job.status, terminalObserved })];
    });
    return Object.freeze({ schemaVersion: 1, valid: true, jobs: Object.freeze(jobs) });
  } catch {
    return Object.freeze({ schemaVersion: 1, valid: false, jobs: Object.freeze([]) });
  }
}

export function createBatchObservationSnapshotParticipant(index: BatchObservationIndex, now: () => number): SnapshotCommitParticipant<object> {
  if (!index || typeof index.reconcile !== 'function' || typeof now !== 'function' || now.constructor?.name === 'AsyncFunction') {
    throw new Error('batch_observation_participant_unavailable');
  }
  return Object.freeze({
    commit(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<object>) {
      context.assertActive();
      if (input.nextRevision !== context.revision + 1) throw new Error('batch_observation_snapshot_revision_changed');
      const projection = projectBatchObservationLedger(input.nextSnapshot);
      const current = now();
      if (!Number.isSafeInteger(current) || current < 0) throw new Error('batch_observation_time_invalid');
      index.reconcile(context, projection, current);
    },
  });
}
