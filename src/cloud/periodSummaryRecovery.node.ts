import { createHash } from 'node:crypto';
import type { AppState } from '../core';
import { validateOpenRouterBatchLedger } from '../services/openRouterBatchJobs';
import type { BackgroundBatchLinkStore, BackgroundPaidBatchLinkInput } from '../../server/src/backgroundBatchLink.js';
import type { DurableKernel, OwnedTransactionContext } from '../../server/src/kernel.js';
import { PeriodSummaryCaptureStore, type PeriodSummaryCaptureEvidence, type PeriodSummaryCapturePhaseRecord } from '../../server/src/periodSummaryCaptureStore.js';
import { canonicalBackgroundJson } from '../../server/src/backgroundContracts.js';
import type { PeriodSummaryAuthorityAdapter } from './periodSummaryPaidWork.node.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRIVATE_BYTES = 16 * 1024 * 1024;
const PROVIDER_BATCH_ID = /^[A-Za-z0-9_-]{1,256}$/;

export type PeriodSummaryRecoveryClassification = Readonly<{
  readonly decision: 'known_batch' | 'certified_not_submitted' | 'inspect_required';
  readonly jobId: string;
  readonly batchId?: string;
  readonly status?: string;
}>;

export interface PeriodSummaryRecoveryDependencies {
  readonly kernel: DurableKernel;
  readonly sessionToken: string;
  readonly captureStore: PeriodSummaryCaptureStore;
  readonly batchLinks: BackgroundBatchLinkStore;
  readonly authority: PeriodSummaryAuthorityAdapter;
}

function fail(code: string): never { throw new Error(code); }
function rejectThenable<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function') fail('period_summary_recovery_authority_must_be_synchronous');
  return value;
}
function readLedger(state: AppState, jobId: string, evidence: PeriodSummaryCaptureEvidence): Readonly<{
  status: string; batchId?: string; requestSha256: string; requestBody: string; failureCode?: string; unknownCharge: boolean;
}> | undefined {
  const raw = (state as AppState & { openRouterBatchLedger?: unknown }).openRouterBatchLedger;
  if (raw === undefined) return undefined;
  const rawJobs = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { readonly jobs?: unknown }).jobs : undefined;
  if (Array.isArray(rawJobs)) {
    const rawJob = rawJobs.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
      (candidate as { readonly id?: unknown }).id === jobId);
    if (rawJob && typeof (rawJob as { readonly requestBody?: unknown }).requestBody === 'string') {
      const body = (rawJob as { readonly requestBody: string }).requestBody;
      if (createHash('sha256').update(body, 'utf8').digest('hex') !== evidence.requestSha256) {
        fail('period_summary_recovery_job_evidence_mismatch');
      }
    }
  }
  const ledger = validateOpenRouterBatchLedger(raw);
  const job = ledger.jobs.find((item) => item.id === jobId);
  if (!job) return undefined;
  if (job.kind !== 'period_summary' || job.requestProfileVersion !== 6 || job.operation !== 'period_summary' || !job.summaryBinding ||
      job.customId !== evidence.customId || job.requestSha256 !== evidence.requestSha256 ||
      !job.requestBody || createHash('sha256').update(job.requestBody, 'utf8').digest('hex') !== evidence.requestSha256 ||
      job.summaryBinding.occurrenceId !== evidence.occurrenceId || job.summaryBinding.policyId !== evidence.policyId ||
      job.summaryBinding.policyRevision !== evidence.policyRevision || job.summaryBinding.policyDigest !== evidence.policyDigest ||
      job.summaryBinding.sourceManifestSha256 !== evidence.sourceManifestSha256 ||
      canonicalBackgroundJson(job.summaryBinding.destination, PRIVATE_BYTES) !== canonicalBackgroundJson(
        evidence.destination.documentId === null
          ? { kind: 'absent', path: evidence.destination.path, documentId: null, expectedRevision: null,
              expectedAbsenceGeneration: evidence.destination.expectedAbsenceGeneration }
          : { kind: 'existing', path: evidence.destination.path, documentId: evidence.destination.documentId,
              expectedRevision: evidence.destination.expectedRevision }, PRIVATE_BYTES)) {
    fail('period_summary_recovery_job_evidence_mismatch');
  }
  return Object.freeze({ status: job.status, ...(job.batchId ? { batchId: job.batchId } : {}),
    ...(job.failureCode ? { failureCode: job.failureCode } : {}), unknownCharge: job.unknownCharge,
    requestSha256: job.requestSha256, requestBody: job.requestBody });
}
function linkMatches(link: BackgroundPaidBatchLinkInput, evidence: PeriodSummaryCaptureEvidence): boolean {
  return link.occurrenceId === evidence.occurrenceId && link.attemptId === evidence.attemptId && link.commandId === evidence.commandId &&
    link.ticketId === evidence.ticketId && link.policyId === evidence.policyId && link.policyRevision === evidence.policyRevision &&
    link.policyDigest === evidence.policyDigest && link.jobId === evidence.jobId && link.customId === evidence.customId &&
    link.requestSha256 === evidence.requestSha256 && link.sourceDigest === evidence.occurrenceSourceDigest &&
    link.sourceVersionDigest === (evidence.occurrenceSourceVersionDigest ?? undefined) && link.requestDigest === evidence.occurrenceRequestDigest &&
    link.createdAt === evidence.linkCreatedAt;
}
function expectedLink(evidence: PeriodSummaryCaptureEvidence): BackgroundPaidBatchLinkInput {
  return Object.freeze({ occurrenceId: evidence.occurrenceId, attemptId: evidence.attemptId, commandId: evidence.commandId,
    ticketId: evidence.ticketId, policyId: evidence.policyId, policyRevision: evidence.policyRevision, policyDigest: evidence.policyDigest,
    jobId: evidence.jobId, customId: evidence.customId, requestSha256: evidence.requestSha256,
    sourceDigest: evidence.occurrenceSourceDigest,
    ...(evidence.occurrenceSourceVersionDigest === null ? {} : { sourceVersionDigest: evidence.occurrenceSourceVersionDigest }),
    requestDigest: evidence.occurrenceRequestDigest, createdAt: evidence.linkCreatedAt });
}
function readCanonicalLinkWithinTransaction(context: OwnedTransactionContext, batchLinks: BackgroundBatchLinkStore,
  evidence: PeriodSummaryCaptureEvidence): BackgroundPaidBatchLinkInput | undefined {
  const table = context.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='background_paid_batch_links'").get();
  if (!table) return undefined;
  const row = context.db.prepare(`SELECT 1 AS found FROM background_paid_batch_links
    WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
    .get(context.workspaceId, context.ownerId, context.privacyEpoch, evidence.occurrenceId);
  if (!row) return undefined;
  const expected = expectedLink(evidence);
  try { batchLinks.assertExistingLinkWithinTransaction(context, expected); }
  catch { fail('period_summary_recovery_link_mismatch'); }
  return expected;
}

/** Restart-only classifier. It never restores capture authority and never submits a provider request. */
export class PeriodSummaryRecovery {
  constructor(private readonly dependencies: PeriodSummaryRecoveryDependencies) {
    const d = dependencies;
    if (!d?.kernel || !d.sessionToken || !d.captureStore || !d.batchLinks || !d.authority ||
        typeof d.authority.readRecoveryWithinTransaction !== 'function') throw new TypeError('period_summary_recovery_unavailable');
  }

  classify(jobId: string): PeriodSummaryRecoveryClassification {
    if (typeof jobId !== 'string' || !UUID_V4.test(jobId)) fail('period_summary_recovery_job_invalid');
    const identity = this.dependencies.kernel.getOwnedIdentity(this.dependencies.sessionToken);
    return this.dependencies.kernel.withOwnedTransaction(this.dependencies.sessionToken, identity.privacyEpoch, (context) => {
      const evidence = this.dependencies.captureStore.readEvidenceWithinTransaction(context, jobId);
      const phase = this.dependencies.captureStore.readPhaseWithinTransaction(context, jobId);
      if (!evidence || !phase) fail('period_summary_recovery_evidence_missing');
      const snapshot = this.dependencies.kernel.readOwnedSnapshotWithinTransaction(context);
      const currentJob = readLedger(snapshot.snapshot as unknown as AppState, jobId, evidence);
      const link = readCanonicalLinkWithinTransaction(context, this.dependencies.batchLinks, evidence);
      if (link && !linkMatches(link, evidence)) fail('period_summary_recovery_link_mismatch');
      const reported = rejectThenable(this.dependencies.authority.readRecoveryWithinTransaction!(context, evidence));
      if (!reported || !['known_batch', 'certified_not_submitted', 'inspect_required'].includes(reported.decision)) {
        fail('period_summary_recovery_authority_invalid');
      }
      return this.#classify(evidence, phase, currentJob, link, reported);
    });
  }

  #classify(evidence: PeriodSummaryCaptureEvidence, phase: PeriodSummaryCapturePhaseRecord,
    job: ReturnType<typeof readLedger>, link: BackgroundPaidBatchLinkInput | undefined,
    authority: Readonly<{ decision: 'known_batch' | 'certified_not_submitted' | 'inspect_required'; batchId?: string; status?: string }>): PeriodSummaryRecoveryClassification {
    if (phase.phase === 'preparing' && !link && job?.status === 'preparing' &&
        authority.decision === 'certified_not_submitted') {
      return Object.freeze({ decision: 'certified_not_submitted', jobId: evidence.jobId, status: 'preparing' });
    }
    if (phase.phase === 'not_submitted' && !link && job?.status === 'failed' && job.failureCode === 'not_submitted' &&
        job.unknownCharge === false && !job.batchId && authority.decision === 'certified_not_submitted') {
      return Object.freeze({ decision: 'certified_not_submitted', jobId: evidence.jobId,
        ...(authority.status ? { status: authority.status } : {}) });
    }
    const phaseBatchId = phase.phase === 'submitted' || phase.phase === 'settled' ? phase.batchId : undefined;
    const expectedJobStatus = phase.phase === 'submitted' ? 'queued' : phase.phase === 'settled' ? phase.status : undefined;
    if (phaseBatchId && PROVIDER_BATCH_ID.test(phaseBatchId) && expectedJobStatus && link && job &&
        job.status === expectedJobStatus && job.batchId === phaseBatchId &&
        (authority.decision === 'known_batch' || authority.decision === 'inspect_required') &&
        (authority.batchId === undefined || authority.batchId === phaseBatchId)) {
      return Object.freeze({ decision: 'known_batch', jobId: evidence.jobId, batchId: phaseBatchId, status: job.status });
    }
    return Object.freeze({ decision: 'inspect_required', jobId: evidence.jobId,
      ...(authority.status ? { status: authority.status } : job ? { status: job.status } : {}) });
  }
}
