import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { AppState } from '../core';
import {
  buildOpenRouterPeriodSummaryRequest,
  createOpenRouterPeriodSummaryBinding,
  type OpenRouterPeriodSummaryBinding,
  type OpenRouterPeriodSummarySubmission,
  type OpenRouterSummaryEffort,
} from '../services/openRouterPeriodSummary';
import type { TrustedPeriodSummaryDispatch } from '../services/controllerRuntimeContracts';
import type { OpenRouterPeriodSummaryContentJob } from '../services/openRouterBatchJobs';
import {
  periodSummaryCaptureCheckpointEvidence,
  revalidatePeriodSummarySourceCaptureWithinTransaction,
  type PeriodSummarySourceCapture,
} from './periodSummarySources.node.js';
import { canonicalBackgroundJson } from '../../server/src/backgroundContracts.js';
import type { CommandJournal, CommandTicketContext } from '../../server/src/commandJournal.js';
import { currentCommandTicket } from '../../server/src/commandJournal.js';
import type { BackgroundPaidBatchLinkInput, BackgroundBatchLinkStore } from '../../server/src/backgroundBatchLink.js';
import type { DurableKernel, OwnedTransactionContext } from '../../server/src/kernel.js';
import type { DocumentLineage } from '../../server/src/documentLineage.js';
import type { SnapshotCommitParticipant, SnapshotCommitParticipantInput } from '../../server/src/workspaceStore.js';
import { PeriodSummaryCaptureStore, type PeriodSummaryCaptureEvidence } from '../../server/src/periodSummaryCaptureStore.js';

const COMMAND_KIND = 'assistant.periodsummary.scheduled.submit';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PRIVATE_BYTES = 16 * 1024 * 1024;

export interface PeriodSummarySubmissionClaim {
  readonly occurrenceId: string;
  readonly attemptId: string;
  /** Opaque occurrence capability stays inside the trusted runtime adapter. */
  readonly capability: string;
}

export interface PeriodSummaryPreparationAuthority {
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly executionOptionsDigest: string;
  readonly occurrenceSourceDigest: string;
  readonly occurrenceRequestDigest: string;
  readonly occurrenceSourceVersionDigest?: string;
  readonly effort: OpenRouterSummaryEffort;
  readonly instructions: string;
  readonly emailTextMode: 'complete_body' | 'available_extracted_email_text';
}

/**
 * Private production seam. Each method operates on the active owned transaction and the
 * already-admitted occurrence claim. Implementations must throw on any mismatch and return
 * synchronously; this interface does not authorize creating a policy or a claim.
 */
export interface PeriodSummaryAuthorityAdapter {
  prepareWithinTransaction(context: OwnedTransactionContext, ticket: CommandTicketContext,
    claim: PeriodSummarySubmissionClaim, capture: ReturnType<typeof periodSummaryCaptureCheckpointEvidence>): PeriodSummaryPreparationAuthority;
  beginSubmissionWithinTransaction(context: OwnedTransactionContext, ticket: CommandTicketContext,
    claim: PeriodSummarySubmissionClaim, evidence: PeriodSummaryCaptureEvidence, job: OpenRouterPeriodSummaryContentJob,
    expectedLink: BackgroundPaidBatchLinkInput): BackgroundPaidBatchLinkInput;
  assertBeforePostWithinTransaction(context: OwnedTransactionContext, ticket: CommandTicketContext,
    claim: PeriodSummarySubmissionClaim, evidence: PeriodSummaryCaptureEvidence,
    job: OpenRouterPeriodSummaryContentJob, link: BackgroundPaidBatchLinkInput): void;
  readRecoveryWithinTransaction?(context: OwnedTransactionContext, evidence: PeriodSummaryCaptureEvidence): Readonly<{
    readonly decision: 'known_batch' | 'certified_not_submitted' | 'inspect_required';
    readonly batchId?: string;
    readonly status?: string;
  }>;
}

export interface PeriodSummaryControllerPort {
  submitPreparedPeriodSummary(input: TrustedPeriodSummaryDispatch): Promise<unknown>;
}

export interface PeriodSummaryPaidWorkDependencies {
  readonly kernel: DurableKernel;
  readonly sessionToken: string;
  readonly journal: CommandJournal;
  readonly captureStore: PeriodSummaryCaptureStore;
  readonly documentLineage: DocumentLineage;
  readonly batchLinks: BackgroundBatchLinkStore;
  readonly authority: PeriodSummaryAuthorityAdapter;
  readonly controller: PeriodSummaryControllerPort;
}

export interface ExecuteScheduledPeriodSummaryInput {
  readonly claim: PeriodSummarySubmissionClaim;
  readonly capture: PeriodSummarySourceCapture;
}

interface Operation {
  readonly ticket: CommandTicketContext;
  readonly claim: PeriodSummarySubmissionClaim;
  readonly capture: PeriodSummarySourceCapture;
  readonly authority: PeriodSummaryPreparationAuthority;
  readonly submission: OpenRouterPeriodSummarySubmission;
  readonly precommitProofs: WeakMap<object, CommitProof>;
  evidence?: PeriodSummaryCaptureEvidence;
  link?: BackgroundPaidBatchLinkInput;
}

interface CommitProof {
  readonly operation: Operation;
  readonly phase: 'preparing' | 'submitting' | 'submitted' | 'not_submitted' | 'inspect_required';
  readonly evidence?: PeriodSummaryCaptureEvidence;
  readonly link?: BackgroundPaidBatchLinkInput;
}

const activeOperation = new AsyncLocalStorage<Operation>();

function fail(code: string): never { throw new Error(code); }
function sha(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function rejectThenable<T>(value: T, code: string): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function') fail(code);
  return value;
}
function requireTicket(): CommandTicketContext {
  const ticket = currentCommandTicket();
  if (!ticket || ticket.kind !== COMMAND_KIND) fail('scheduled_period_summary_ticket_invalid');
  if (typeof ticket.idempotencyKey !== 'string' || !UUID_V4.test(ticket.idempotencyKey) || !UUID_V4.test(ticket.ticketId) ||
      !ticket.runtimeSessionToken || ticket.runtimeSessionToken.length < 1) fail('scheduled_period_summary_ticket_invalid');
  return ticket;
}
function freezeJson<T>(value: T): T {
  const json = canonicalBackgroundJson(value, PRIVATE_BYTES);
  return deepFreeze(JSON.parse(json) as T);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function preparation(value: unknown): PeriodSummaryPreparationAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('period_summary_authority_invalid');
  }
  const row = value as Record<string, unknown>;
  const fields = ['policyId', 'policyRevision', 'policyDigest', 'executionOptionsDigest', 'occurrenceSourceDigest',
    'occurrenceRequestDigest', 'effort', 'instructions', 'emailTextMode'];
  const optional = ['occurrenceSourceVersionDigest'];
  if (Reflect.ownKeys(row).length < fields.length || Reflect.ownKeys(row).length > fields.length + optional.length ||
      Reflect.ownKeys(row).some((key) => typeof key !== 'string' || ![...fields, ...optional].includes(key)) ||
      fields.some((key) => { const d = Object.getOwnPropertyDescriptor(row, key); return !d?.enumerable || !Object.hasOwn(d, 'value'); }) ||
      (Object.hasOwn(row, 'occurrenceSourceVersionDigest') && (() => {
        const d = Object.getOwnPropertyDescriptor(row, 'occurrenceSourceVersionDigest');
        return !d?.enumerable || !Object.hasOwn(d, 'value');
      })()) ||
      typeof row.policyId !== 'string' || !UUID_V4.test(row.policyId) || !Number.isSafeInteger(row.policyRevision) || (row.policyRevision as number) < 1 ||
      typeof row.policyDigest !== 'string' || !SHA256.test(row.policyDigest) || typeof row.executionOptionsDigest !== 'string' || !SHA256.test(row.executionOptionsDigest) ||
      typeof row.occurrenceSourceDigest !== 'string' || !SHA256.test(row.occurrenceSourceDigest) ||
      typeof row.occurrenceRequestDigest !== 'string' || !SHA256.test(row.occurrenceRequestDigest) ||
      (row.occurrenceSourceVersionDigest !== undefined && (typeof row.occurrenceSourceVersionDigest !== 'string' || !SHA256.test(row.occurrenceSourceVersionDigest))) ||
      !['none', 'low', 'medium', 'high', 'max'].includes(String(row.effort)) || typeof row.instructions !== 'string' || !row.instructions.trim() ||
      !['complete_body', 'available_extracted_email_text'].includes(String(row.emailTextMode))) {
    fail('period_summary_authority_invalid');
  }
  return freezeJson(row as unknown as PeriodSummaryPreparationAuthority);
}
function destination(binding: PeriodSummarySourceCapture['destination']): OpenRouterPeriodSummaryBinding['destination'] {
  if (binding.documentId === null) {
    if (binding.expectedRevision !== null || binding.expectedAbsenceGeneration === null) fail('period_summary_destination_invalid');
    return Object.freeze({ kind: 'absent', documentId: null, path: binding.path, expectedRevision: null,
      expectedAbsenceGeneration: binding.expectedAbsenceGeneration });
  }
  if (binding.expectedRevision === null || binding.expectedAbsenceGeneration !== null) fail('period_summary_destination_invalid');
  return Object.freeze({ kind: 'existing', documentId: binding.documentId, path: binding.path, expectedRevision: binding.expectedRevision });
}
function ledgerJobs(state: AppState): readonly unknown[] {
  const ledger = (state as AppState & { openRouterBatchLedger?: unknown }).openRouterBatchLedger;
  if (ledger === undefined) return Object.freeze([]);
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray((ledger as { jobs?: unknown }).jobs)) fail('period_summary_snapshot_invalid');
  return (ledger as { jobs: readonly unknown[] }).jobs;
}
function findJob(state: AppState, jobId: string): OpenRouterPeriodSummaryContentJob | undefined {
  return ledgerJobs(state).find((job) => job && typeof job === 'object' && (job as { id?: unknown }).id === jobId) as OpenRouterPeriodSummaryContentJob | undefined;
}
function publicStateProjection(state: AppState): string {
  const clone = JSON.parse(canonicalBackgroundJson(state, PRIVATE_BYTES)) as Record<string, unknown>;
  delete clone.openRouterBatchLedger;
  return canonicalBackgroundJson(clone, PRIVATE_BYTES);
}
function otherJobsProjection(state: AppState, jobId: string): string {
  return canonicalBackgroundJson(ledgerJobs(state).filter((job) => !job || typeof job !== 'object' || (job as { id?: unknown }).id !== jobId), PRIVATE_BYTES);
}
function sourceProofSha(evidence: ReturnType<typeof periodSummaryCaptureCheckpointEvidence>): string {
  return sha(canonicalBackgroundJson(evidence.sourceProofs, PRIVATE_BYTES));
}
function makeEvidence(operation: Operation, context: OwnedTransactionContext): PeriodSummaryCaptureEvidence {
  const proof = periodSummaryCaptureCheckpointEvidence(operation.capture);
  if (proof.workspaceId !== context.workspaceId || proof.ownerId !== context.ownerId || proof.privacyEpoch !== context.privacyEpoch ||
      proof.sourceManifestSha256 !== operation.submission.summaryBinding.sourceManifestSha256) fail('period_summary_capture_scope_changed');
  const target = proof.destination;
  const storedDestination = target.documentId === null
    ? target.expectedAbsenceGeneration === null || target.expectedRevision !== null
      ? fail('period_summary_destination_invalid')
      : { path: target.path, documentId: null, expectedRevision: null, expectedAbsenceGeneration: target.expectedAbsenceGeneration }
    : target.expectedRevision === null || target.expectedAbsenceGeneration !== null
      ? fail('period_summary_destination_invalid')
      : { path: target.path, documentId: target.documentId, expectedRevision: target.expectedRevision };
  return freezeJson({ schemaVersion: 1, workspaceId: context.workspaceId, ownerId: context.ownerId, privacyEpoch: context.privacyEpoch,
    policyId: operation.authority.policyId, policyRevision: operation.authority.policyRevision, policyDigest: operation.authority.policyDigest,
    occurrenceSourceDigest: operation.authority.occurrenceSourceDigest,
    occurrenceRequestDigest: operation.authority.occurrenceRequestDigest,
    occurrenceSourceVersionDigest: operation.authority.occurrenceSourceVersionDigest ?? null,
    executionOptionsDigest: operation.authority.executionOptionsDigest, occurrenceId: operation.claim.occurrenceId, attemptId: operation.claim.attemptId,
    commandId: operation.ticket.idempotencyKey, ticketId: operation.ticket.ticketId, jobId: operation.submission.operationId,
    customId: operation.submission.operationId, requestSha256: operation.submission.requestSha256, linkCreatedAt: context.now,
    sourceManifestSha256: proof.sourceManifestSha256, sourceProofSha256: sourceProofSha(proof), sourceProofs: proof.sourceProofs,
    period: proof.request.period, timeZone: proof.request.timeZone,
    localInterval: { start: proof.interval.localStart, end: proof.interval.localEnd },
    utcInterval: { start: proof.interval.startUtc, endExclusive: proof.interval.endUtc }, preparedAt: proof.request.preparedAt,
    destination: storedDestination });
}
function jobMatchesOperation(job: OpenRouterPeriodSummaryContentJob | undefined, operation: Operation, status: string): job is OpenRouterPeriodSummaryContentJob {
  return Boolean(job && job.kind === 'period_summary' && job.status === status && job.id === operation.submission.operationId &&
    job.customId === operation.submission.operationId && job.requestProfileVersion === 6 && job.operation === 'period_summary' &&
    job.requestSha256 === operation.submission.requestSha256 && job.requestBody === operation.submission.requestBody &&
    canonicalBackgroundJson(job.summaryBinding, PRIVATE_BYTES) === canonicalBackgroundJson(operation.submission.summaryBinding, PRIVATE_BYTES));
}
function jobMatchesExcept(previous: OpenRouterPeriodSummaryContentJob | undefined, next: OpenRouterPeriodSummaryContentJob | undefined,
  allowedFields: readonly string[]): boolean {
  if (!previous || !next || previous.id !== next.id || previous.kind !== 'period_summary' || next.kind !== 'period_summary') return false;
  const oldValue = JSON.parse(canonicalBackgroundJson(previous, PRIVATE_BYTES)) as Record<string, unknown>;
  const newValue = JSON.parse(canonicalBackgroundJson(next, PRIVATE_BYTES)) as Record<string, unknown>;
  for (const field of allowedFields) { delete oldValue[field]; delete newValue[field]; }
  return canonicalBackgroundJson(oldValue, PRIVATE_BYTES) === canonicalBackgroundJson(newValue, PRIVATE_BYTES);
}
function makeLink(evidence: PeriodSummaryCaptureEvidence, context: OwnedTransactionContext): BackgroundPaidBatchLinkInput {
  return Object.freeze({ occurrenceId: evidence.occurrenceId, attemptId: evidence.attemptId, commandId: evidence.commandId,
    ticketId: evidence.ticketId, policyId: evidence.policyId, policyRevision: evidence.policyRevision, policyDigest: evidence.policyDigest,
    jobId: evidence.jobId, customId: evidence.customId, requestSha256: evidence.requestSha256,
    sourceDigest: evidence.occurrenceSourceDigest,
    ...(evidence.occurrenceSourceVersionDigest === null ? {} : { sourceVersionDigest: evidence.occurrenceSourceVersionDigest }),
    requestDigest: evidence.occurrenceRequestDigest, createdAt: evidence.linkCreatedAt });
}
function exactLink(actual: BackgroundPaidBatchLinkInput, expected: BackgroundPaidBatchLinkInput): boolean {
  return canonicalBackgroundJson(actual) === canonicalBackgroundJson(expected);
}
function evidenceMatchesOperation(evidence: PeriodSummaryCaptureEvidence, operation: Operation,
  context: OwnedTransactionContext): boolean {
  const proof = periodSummaryCaptureCheckpointEvidence(operation.capture);
  return evidence.workspaceId === context.workspaceId && evidence.ownerId === context.ownerId && evidence.privacyEpoch === context.privacyEpoch &&
    evidence.policyId === operation.authority.policyId && evidence.policyRevision === operation.authority.policyRevision &&
    evidence.policyDigest === operation.authority.policyDigest && evidence.executionOptionsDigest === operation.authority.executionOptionsDigest &&
    evidence.occurrenceSourceDigest === operation.authority.occurrenceSourceDigest &&
    evidence.occurrenceRequestDigest === operation.authority.occurrenceRequestDigest &&
    evidence.occurrenceSourceVersionDigest === (operation.authority.occurrenceSourceVersionDigest ?? null) &&
    evidence.occurrenceId === operation.claim.occurrenceId && evidence.attemptId === operation.claim.attemptId &&
    evidence.commandId === operation.ticket.idempotencyKey && evidence.ticketId === operation.ticket.ticketId &&
    evidence.jobId === operation.submission.operationId && evidence.customId === operation.submission.operationId &&
    evidence.requestSha256 === operation.submission.requestSha256 && evidence.sourceManifestSha256 === proof.sourceManifestSha256 &&
    evidence.sourceProofSha256 === sourceProofSha(proof) &&
    canonicalBackgroundJson(evidence.sourceProofs, PRIVATE_BYTES) === canonicalBackgroundJson(proof.sourceProofs, PRIVATE_BYTES) &&
    evidence.destination.path === proof.destination.path && evidence.destination.documentId === proof.destination.documentId &&
    evidence.destination.expectedRevision === proof.destination.expectedRevision &&
    evidence.destination.expectedAbsenceGeneration === (proof.destination.documentId === null ? proof.destination.expectedAbsenceGeneration : undefined) &&
    evidence.period === proof.request.period && evidence.timeZone === proof.request.timeZone &&
    evidence.preparedAt === proof.request.preparedAt && evidence.localInterval.start === proof.interval.localStart &&
    evidence.localInterval.end === proof.interval.localEnd && evidence.utcInterval.start === proof.interval.startUtc &&
    evidence.utcInterval.endExclusive === proof.interval.endUtc && sha(operation.submission.requestBody) === operation.submission.requestSha256;
}

/** Synchronous snapshot participant for atomic preparing/submitting/ack checkpoints. */
export class PeriodSummaryPaidWork {
  constructor(private readonly dependencies: PeriodSummaryPaidWorkDependencies) {
    const d = dependencies;
    if (!d?.kernel || !d.sessionToken || !d.journal || !d.captureStore || !d.documentLineage || !d.batchLinks || !d.authority ||
        !d.controller || typeof d.controller.submitPreparedPeriodSummary !== 'function') throw new TypeError('period_summary_paid_work_unavailable');
  }

  createSnapshotCommitParticipant(): SnapshotCommitParticipant<AppState> {
    const participant: SnapshotCommitParticipant<AppState> = {
      beforeCommit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<AppState>) => this.#beforeCommit(context, input),
      commit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<AppState>) => this.#commit(context, input),
    };
    return Object.freeze(participant);
  }

  async executeScheduledPeriodSummary(input: ExecuteScheduledPeriodSummaryInput): Promise<unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).length !== 2 || !Reflect.ownKeys(input).every((key) => key === 'claim' || key === 'capture')) fail('period_summary_gateway_required');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (!descriptors.claim?.enumerable || !Object.hasOwn(descriptors.claim, 'value') || !descriptors.capture?.enumerable ||
        !Object.hasOwn(descriptors.capture, 'value')) fail('period_summary_gateway_required');
    const claimValue = descriptors.claim.value as PeriodSummarySubmissionClaim;
    const capture = descriptors.capture.value as PeriodSummarySourceCapture;
    if (!claimValue || typeof claimValue !== 'object' || nodeTypes.isProxy(claimValue) || Object.getPrototypeOf(claimValue) !== Object.prototype ||
        Reflect.ownKeys(claimValue).length !== 3 || Reflect.ownKeys(claimValue).some((key) => !['occurrenceId', 'attemptId', 'capability'].includes(String(key)))) {
      fail('period_summary_claim_invalid');
    }
    const claimDescriptors = Object.getOwnPropertyDescriptors(claimValue);
    if (Object.values(claimDescriptors).some((descriptor) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) ||
        typeof claimDescriptors.occurrenceId?.value !== 'string' || !UUID_V4.test(claimDescriptors.occurrenceId.value) ||
        typeof claimDescriptors.attemptId?.value !== 'string' || !UUID_V4.test(claimDescriptors.attemptId.value) ||
        typeof claimDescriptors.capability?.value !== 'string' || !claimDescriptors.capability.value) fail('period_summary_claim_invalid');
    const claim = freezeJson({ occurrenceId: claimDescriptors.occurrenceId.value, attemptId: claimDescriptors.attemptId.value,
      capability: claimDescriptors.capability.value });
    const ticket = requireTicket();
    if (ticket.runtimeSessionToken !== this.dependencies.sessionToken) fail('scheduled_period_summary_session_invalid');
    if (!this.dependencies.kernel || !capture || !periodSummaryCaptureCheckpointEvidence(capture)) fail('period_summary_capture_proof_invalid');
    const proof = periodSummaryCaptureCheckpointEvidence(capture);
    if (proof.workspaceId !== ticket.workspaceId || proof.ownerId !== ticket.ownerId || proof.privacyEpoch !== ticket.privacyEpoch ||
        proof.request.expectedPrivacyEpoch !== ticket.privacyEpoch) fail('period_summary_capture_scope_changed');
    const authority = this.dependencies.kernel.withOwnedTransaction(ticket.runtimeSessionToken, ticket.privacyEpoch, (context) => {
      this.dependencies.journal.assertScheduledPeriodSummarySubmissionWithinTransaction(context, ticket);
      revalidatePeriodSummarySourceCaptureWithinTransaction(this.dependencies.kernel, context, this.dependencies.documentLineage, capture, 'exact');
      return preparation(rejectThenable(this.dependencies.authority.prepareWithinTransaction(context, ticket, claim, proof),
        'period_summary_authority_must_be_synchronous'));
    });
    if (authority.emailTextMode !== (proof.request.emailTextMode ?? 'complete_body')) fail('period_summary_email_consent_mismatch');
    const digest = async (text: string) => sha(text);
    const binding = await createOpenRouterPeriodSummaryBinding({
      version: 1, requestProfileVersion: 6, operation: 'period_summary', policyId: authority.policyId,
      policyRevision: authority.policyRevision, policyDigest: authority.policyDigest, occurrenceId: claim.occurrenceId,
      period: proof.request.period, timeZone: proof.request.timeZone,
      localInterval: { start: proof.interval.localStart, end: proof.interval.localEnd }, startUtc: proof.interval.startUtc,
      endUtc: proof.interval.endUtc, preparedAt: proof.request.preparedAt, sources: capture.sources,
      destination: destination(capture.destination), instructions: authority.instructions, effort: authority.effort,
    }, digest);
    if (binding.sourceManifestSha256 !== proof.sourceManifestSha256) fail('period_summary_source_manifest_mismatch');
    const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
    const operationId = randomUUID();
    const submission: OpenRouterPeriodSummarySubmission = freezeJson({ operationId, requestProfileVersion: 6,
      operation: 'period_summary', requestBody: prepared.body, requestSha256: sha(prepared.body), summaryBinding: prepared.binding });
    const operation: Operation = { ticket, claim, capture, authority, submission, precommitProofs: new WeakMap() };
    return activeOperation.run(operation, () => this.dependencies.controller.submitPreparedPeriodSummary(Object.freeze({
      submission,
      assertCurrentAuthorityBeforePost: () => this.#assertBeforePost(operation),
    })));
  }

  #beforeCommit(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<AppState>): void {
    const operation = activeOperation.getStore();
    if (!operation) return;
    this.#assertOperation(operation, context);
    this.dependencies.journal.assertScheduledPeriodSummarySubmissionWithinTransaction(context, operation.ticket);
    const proof = periodSummaryCaptureCheckpointEvidence(operation.capture);
    const previousJob = findJob(input.previousSnapshot, operation.submission.operationId);
    const nextJob = findJob(input.nextSnapshot, operation.submission.operationId);
    if (publicStateProjection(input.previousSnapshot) !== publicStateProjection(input.nextSnapshot) ||
        otherJobsProjection(input.previousSnapshot, operation.submission.operationId) !== otherJobsProjection(input.nextSnapshot, operation.submission.operationId)) {
      fail('period_summary_snapshot_delta_invalid');
    }
    let phase: CommitProof['phase'];
    let evidence: PeriodSummaryCaptureEvidence | undefined;
    let link: BackgroundPaidBatchLinkInput | undefined;
    if (!previousJob && jobMatchesOperation(nextJob, operation, 'preparing')) {
      revalidatePeriodSummarySourceCaptureWithinTransaction(this.dependencies.kernel, context, this.dependencies.documentLineage,
        operation.capture, 'exact');
      const authority = preparation(rejectThenable(this.dependencies.authority.prepareWithinTransaction(context, operation.ticket,
        operation.claim, proof), 'period_summary_authority_must_be_synchronous'));
      if (canonicalBackgroundJson(authority) !== canonicalBackgroundJson(operation.authority)) fail('period_summary_authority_changed');
      evidence = makeEvidence(operation, context);
      phase = 'preparing';
    } else if (jobMatchesOperation(previousJob, operation, 'preparing') && jobMatchesOperation(nextJob, operation, 'submitting') &&
      jobMatchesExcept(previousJob, nextJob, ['status', 'updatedAt', 'unknownCharge']) && nextJob.unknownCharge === true &&
      nextJob.batchId === undefined) {
      revalidatePeriodSummarySourceCaptureWithinTransaction(this.dependencies.kernel, context, this.dependencies.documentLineage,
        operation.capture, 'exact');
      evidence = this.dependencies.captureStore.readEvidenceWithinTransaction(context, operation.submission.operationId);
      if (!evidence || !evidenceMatchesOperation(evidence, operation, context)) {
        fail('period_summary_capture_evidence_missing');
      }
      phase = 'submitting';
    } else if (jobMatchesOperation(previousJob, operation, 'submitting') && jobMatchesOperation(nextJob, operation, 'queued') &&
      jobMatchesExcept(previousJob, nextJob, ['status', 'batchId', 'updatedAt']) && typeof nextJob.batchId === 'string' &&
      /^[A-Za-z0-9_-]{1,256}$/.test(nextJob.batchId)) {
      evidence = this.dependencies.captureStore.readEvidenceWithinTransaction(context, operation.submission.operationId);
      if (!evidence || !nextJob.batchId) fail('period_summary_capture_evidence_missing');
      link = this.#expectedLink(evidence, context);
      this.dependencies.batchLinks.assertExistingLinkWithinTransaction(context, link);
      phase = 'submitted';
    } else if (jobMatchesOperation(previousJob, operation, 'submitting') && nextJob?.kind === 'period_summary' &&
      nextJob.id === operation.submission.operationId && nextJob.status === 'failed' && nextJob.failureCode === 'not_submitted' &&
      nextJob.unknownCharge === false && nextJob.batchId === undefined &&
      jobMatchesExcept(previousJob, nextJob, ['status', 'updatedAt', 'unknownCharge', 'failureCode'])) {
      evidence = this.dependencies.captureStore.readEvidenceWithinTransaction(context, operation.submission.operationId);
      if (!evidence) fail('period_summary_capture_evidence_missing');
      link = this.#expectedLink(evidence, context);
      phase = 'not_submitted';
    } else if (jobMatchesOperation(previousJob, operation, 'submitting') && nextJob?.kind === 'period_summary' &&
      nextJob.id === operation.submission.operationId && nextJob.status === 'submission_unknown' && nextJob.unknownCharge === true &&
      nextJob.batchId === undefined && jobMatchesExcept(previousJob, nextJob, ['status', 'updatedAt', 'unknownCharge'])) {
      evidence = this.dependencies.captureStore.readEvidenceWithinTransaction(context, operation.submission.operationId);
      if (!evidence) fail('period_summary_capture_evidence_missing');
      link = this.#expectedLink(evidence, context);
      phase = 'inspect_required';
    } else if (jobMatchesOperation(previousJob, operation, 'preparing') && nextJob?.kind === 'period_summary' &&
      nextJob.id === operation.submission.operationId && nextJob.status === 'failed' && nextJob.failureCode === 'not_submitted' &&
      nextJob.unknownCharge === false && nextJob.batchId === undefined &&
      jobMatchesExcept(previousJob, nextJob, ['status', 'updatedAt', 'unknownCharge', 'failureCode'])) {
      evidence = this.dependencies.captureStore.readEvidenceWithinTransaction(context, operation.submission.operationId);
      if (!evidence || evidence.requestSha256 !== operation.submission.requestSha256) fail('period_summary_capture_evidence_missing');
      phase = 'not_submitted';
    } else {
      return fail('period_summary_snapshot_transition_invalid');
    }
    if (phase === 'submitting') {
      if (!evidence || !nextJob) fail('period_summary_capture_evidence_missing');
      const expected = this.#expectedLink(evidence, context);
      const actual = rejectThenable(this.dependencies.authority.beginSubmissionWithinTransaction(context, operation.ticket,
        operation.claim, evidence, nextJob, expected), 'period_summary_authority_must_be_synchronous');
      if (!exactLink(actual, expected)) fail('period_summary_paid_link_mismatch');
      this.dependencies.batchLinks.linkWithinTransaction(context, actual);
      link = actual;
    } else if (link) {
      this.dependencies.batchLinks.assertExistingLinkWithinTransaction(context, link);
    }
    operation.precommitProofs.set(input, Object.freeze({ operation, phase, ...(evidence ? { evidence } : {}), ...(link ? { link } : {}) }));
  }

  #commit(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<AppState>): void {
    const operation = activeOperation.getStore();
    if (!operation) return;
    const proof = operation.precommitProofs.get(input);
    if (!proof || proof.operation !== operation) fail('period_summary_snapshot_commit_proof_invalid');
    this.#assertOperation(operation, context);
    const row = context.db.prepare('SELECT owner_id,revision,privacy_epoch,snapshot_json FROM workspaces WHERE id=?')
      .get(context.workspaceId) as { owner_id: string; revision: number; privacy_epoch: number; snapshot_json: string } | undefined;
    if (!row || row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch || row.revision !== input.nextRevision ||
        row.snapshot_json !== canonicalBackgroundJson(input.nextSnapshot, PRIVATE_BYTES)) fail('period_summary_snapshot_commit_fence_failed');
    const { phase, evidence } = proof;
    if (phase === 'preparing') {
      if (!evidence) fail('period_summary_capture_evidence_missing');
      operation.evidence = this.dependencies.captureStore.insertPreparingWithinTransaction(context, evidence);
      return;
    }
    const stored = evidence ?? this.dependencies.captureStore.readEvidenceWithinTransaction(context, operation.submission.operationId);
    if (!stored) fail('period_summary_capture_evidence_missing');
    if (!evidenceMatchesOperation(stored, operation, context)) fail('period_summary_capture_evidence_invalid');
    if (phase === 'submitting') {
      const job = findJob(input.nextSnapshot, operation.submission.operationId);
      if (!jobMatchesOperation(job, operation, 'submitting')) fail('period_summary_snapshot_transition_invalid');
      const actual = proof.link;
      if (!actual || !exactLink(actual, this.#expectedLink(stored, context))) fail('period_summary_paid_link_mismatch');
      this.dependencies.captureStore.transitionWithinTransaction(context, stored.jobId, stored.requestSha256, 'preparing', 'submitting');
      operation.evidence = stored; operation.link = actual;
      return;
    }
    if (phase === 'submitted') {
      const job = findJob(input.nextSnapshot, operation.submission.operationId);
      if (!job?.batchId) fail('period_summary_snapshot_ack_missing');
      this.dependencies.captureStore.transitionWithinTransaction(context, stored.jobId, stored.requestSha256, 'submitting', 'submitted',
        { batchId: job.batchId, status: job.status });
      return;
    }
    const expectedPhase = phase === 'not_submitted' && findJob(input.previousSnapshot, operation.submission.operationId)?.status === 'preparing'
      ? 'preparing' : 'submitting';
    this.dependencies.captureStore.transitionWithinTransaction(context, stored.jobId, stored.requestSha256, expectedPhase, phase);
  }

  #assertBeforePost(operation: Operation): void {
    if (activeOperation.getStore() !== operation || currentCommandTicket() !== operation.ticket) fail('period_summary_paid_scope_invalid');
    this.dependencies.kernel.withOwnedTransaction(operation.ticket.runtimeSessionToken, operation.ticket.privacyEpoch, (context) => {
      this.#assertOperation(operation, context);
      this.dependencies.journal.assertScheduledPeriodSummarySubmissionWithinTransaction(context, operation.ticket);
      revalidatePeriodSummarySourceCaptureWithinTransaction(this.dependencies.kernel, context, this.dependencies.documentLineage,
        operation.capture, 'exact');
      const evidence = this.dependencies.captureStore.readEvidenceWithinTransaction(context, operation.submission.operationId);
      if (!evidence || !evidenceMatchesOperation(evidence, operation, context)) fail('period_summary_capture_evidence_invalid');
      const snapshot = this.dependencies.kernel.readOwnedSnapshotWithinTransaction(context);
      const state = snapshot.snapshot as unknown as AppState;
      const job = findJob(state, operation.submission.operationId);
      if (!jobMatchesOperation(job, operation, 'submitting')) fail('period_summary_submission_state_invalid');
      const link = this.#expectedLink(evidence, context);
      this.dependencies.batchLinks.assertExistingLinkWithinTransaction(context, link);
      rejectThenable(this.dependencies.authority.assertBeforePostWithinTransaction(context, operation.ticket, operation.claim,
        evidence, job, link), 'period_summary_authority_must_be_synchronous');
    });
  }

  #assertOperation(operation: Operation, context: OwnedTransactionContext): void {
    this.dependencies.kernel.assertOwnedTransactionContext(context);
    if (context.workspaceId !== operation.ticket.workspaceId || context.ownerId !== operation.ticket.ownerId ||
        context.privacyEpoch !== operation.ticket.privacyEpoch || context.privacyEpoch !== periodSummaryCaptureCheckpointEvidence(operation.capture).privacyEpoch ||
        context.revision < 0 || currentCommandTicket() !== operation.ticket) fail('period_summary_paid_scope_invalid');
  }

  #expectedLink(evidence: PeriodSummaryCaptureEvidence, context: OwnedTransactionContext): BackgroundPaidBatchLinkInput {
    return makeLink(evidence, context);
  }
}
