import type { AssistIntent, KnowledgeSelection } from '../core';
import { higherOpenRouterRecoveryEfforts, OPENROUTER_BATCH_RESPONSE_MAX_BYTES, type OpenRouterBatchBaseOperation, type OpenRouterBatchInspection, type OpenRouterBatchOutputPolicyVersion, type OpenRouterBatchPersistedRequestProfileVersion, type OpenRouterBatchRequestProfileVersion, type OpenRouterChatRefinementEffort } from './openRouter';
import { validOpenRouterMailReplyBinding, type OpenRouterMailReplyBinding } from './openRouterMailReply';
import { validReplyText } from './openRouterMailReply';
import { isOpenRouterBatchRequestProfile, OPENROUTER_BATCH_MODEL } from './openRouter';
import { isOpenRouterPeriodSummaryBindingShape, isOpenRouterPeriodSummaryRecoveryBindingShape, isOpenRouterPeriodSummaryRequestBodyShape, parseOpenRouterPeriodSummaryResult,
  type OpenRouterPeriodSummaryBinding, type OpenRouterPeriodSummaryKind, type OpenRouterPeriodSummaryRecoveryBinding } from './openRouterPeriodSummary';

export const OPENROUTER_BATCH_LEDGER_VERSION = 1 as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
function validUnicodeText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const STATUSES = new Set([
  'preparing', 'submitting', 'submission_unknown', 'queued', 'processing', 'completed',
  'failed', 'expired', 'cancelled', 'result_stale', 'result_invalid', 'result_truncated', 'result_not_retained', 'cleanup_pending', 'source_removed',
]);

export type AssistantBatchKind = 'note_assistance' | 'mail_reply' | 'period_summary';
export type AssistantBatchStatus =
  | 'preparing' | 'submitting' | 'submission_unknown' | 'queued' | 'processing' | 'completed'
  | 'failed' | 'expired' | 'cancelled' | 'result_stale' | 'result_invalid' | 'result_truncated' | 'result_not_retained' | 'cleanup_pending' | 'source_removed';

export interface OpenRouterBatchRecoveryBinding {
  readonly version: 1;
  readonly parentJobId: string;
  readonly parentKind: 'note_assistance' | 'mail_reply';
  readonly parentRequestProfileVersion: OpenRouterBatchRequestProfileVersion;
  readonly parentOperation?: 'chat_refinement' | 'mail_reply_context';
  readonly parentEffort: OpenRouterBatchJob['effort'];
  readonly parentRequestSha256: string;
  readonly parentSourceFingerprint: string;
  readonly baseRequestProfileVersion: 1 | 2 | 3 | 5;
  readonly baseOperation: OpenRouterBatchBaseOperation;
  readonly baseRequestSha256: string;
  readonly baseSourceFingerprint: string;
  readonly noteRemap?: Readonly<{ fromNoteId: string; toNoteId: string }>;
}

export interface OpenRouterBatchAccounting {
  readonly providerReportedCostUsd?: number;
  readonly byok?: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

/** Compact private proof that a validated provider result was observed before materialization. */
export interface OpenRouterProviderObservation {
  readonly version: 1;
  readonly observedAt: string;
  readonly resultSha256: string;
}

export interface OpenRouterChatContextReference {
  readonly turnId: string;
  readonly jobId: string;
  readonly noteId: string;
  readonly noteRevision: number;
  readonly replySha256: string;
  readonly replyProfileVersion: 1 | 2 | 4 | 5;
  readonly outputPolicyVersion?: OpenRouterBatchOutputPolicyVersion;
}

/** Private binding for the exact ordered history used by one assistant_chat request. */
export interface OpenRouterChatBinding {
  readonly conversationId: string;
  readonly turnId: string;
  readonly context: readonly OpenRouterChatContextReference[];
  readonly omittedTurnCount: number;
  readonly refinementParent?: OpenRouterChatContextReference;
  readonly recoveryParentTurnId?: string;
  readonly transcriptSource?: Readonly<{
    noteId: string;
    noteRevision: number;
    transcriptSha256: string;
    capturedAt: string;
    captureTimeZone: string;
  }>;
}

/** Private, content-free marker requiring the durable standing-consent link to resolve before retained-result use. */
export interface OpenRouterProactiveMailReplyProvenance {
  readonly version: 1;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly occurrenceId: string;
  readonly attemptId: string;
}

/** Private persisted job record. Raw request text never enters AppState/public projections. */
export interface OpenRouterBatchJob {
  readonly id: string;
  readonly customId: string;
  readonly kind: AssistantBatchKind;
  readonly operation?: 'chat_refinement' | 'mail_reply_context' | 'period_summary';
  readonly reasoningEffort?: OpenRouterChatRefinementEffort;
  readonly status: AssistantBatchStatus;
  readonly parentTurnId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: typeof OPENROUTER_BATCH_MODEL;
  readonly effort: 'none' | 'low' | OpenRouterChatRefinementEffort;
  readonly requestSha256: string;
  readonly sourceRemoved?: true;
  readonly batchId?: string;
  readonly unknownCharge: boolean;
  readonly accounting?: OpenRouterBatchAccounting;
  readonly providerObservation?: OpenRouterProviderObservation;
  readonly failureCode?: 'not_submitted' | 'provider_failed' | 'expired' | 'invalid_result' | 'stale_result' | 'result_truncated' | 'result_not_retained';
  readonly noteId?: string;
  readonly noteRevision?: number;
  readonly intent?: AssistIntent;
  readonly question?: string;
  readonly knowledgeSelection?: readonly KnowledgeSelection[number][];
  readonly capturedAt?: string;
  readonly captureTimeZone?: string;
  readonly answeredAsOf?: string;
  readonly settingsFingerprint?: string;
  readonly sourceFingerprint?: string;
  readonly requestProfileVersion?: OpenRouterBatchPersistedRequestProfileVersion;
  /** Private input-selection policy captured when this Batch request was first built. Missing is legacy v1. */
  readonly inputPolicyVersion?: 1 | 2;
  /** Generated-output contract captured at submission; missing legacy jobs mean policy 1. */
  readonly outputPolicyVersion?: OpenRouterBatchOutputPolicyVersion;
  readonly requestBytes?: number;
  readonly omittedSourceCount?: number;
  readonly requestBody?: string;
  readonly sourceVersions?: Readonly<Record<string, string>>;
  readonly appliedNoteRevision?: number;
  readonly chatBinding?: OpenRouterChatBinding;
  readonly recoveryBinding?: OpenRouterBatchRecoveryBinding;
  readonly mailReplyBinding?: OpenRouterMailReplyBinding;
  readonly proactiveMailReply?: OpenRouterProactiveMailReplyProvenance;
  readonly resultText?: string;
  readonly resultSha256?: string;
  /** Bounded provider cutoff bytes retained only as explicit MoreCompute evidence; never complete Markdown. */
  readonly truncatedResultText?: string;
  readonly truncatedResultSha256?: string;
  /** Permanent opaque link to the one draft activated from this job. */
  readonly proposalId?: string;
  /** Explicit operation for the permanently linked proposal; absent legacy jobs mean draft. */
  readonly mailReplyActivationOperation?: 'draft' | 'send';
  /** Closed frozen source contract for the dedicated profile-6 period-summary operation. */
  readonly summaryBinding?: OpenRouterPeriodSummaryBinding;
  /** Present only for explicit higher-effort regeneration children. */
  readonly summaryRecoveryBinding?: OpenRouterPeriodSummaryRecoveryBinding;
  /** Content-free period metadata retained after source removal. */
  readonly summaryMetadata?: OpenRouterPeriodSummaryMetadata;
  /** Content-free parent/root identifiers retained after source removal. */
  readonly summaryRecoveryLineage?: OpenRouterPeriodSummaryLineage;
}

export interface OpenRouterPeriodSummaryMetadata {
  /** Private occurrence key retained only to prevent replay after source removal. */
  readonly occurrenceId?: string;
  readonly period: OpenRouterPeriodSummaryKind;
  readonly timeZone: string;
  readonly localInterval: Readonly<{ start: string; end: string }>;
}

/** Public, content-free period projection. The private occurrence key is never exposed. */
export type OpenRouterPeriodSummaryPublicMetadata = Omit<OpenRouterPeriodSummaryMetadata, 'occurrenceId'>;

export interface OpenRouterPeriodSummaryLineage {
  readonly parentJobId: string | null;
  readonly rootJobId: string;
  readonly ancestorJobIds: readonly string[];
}

export type OpenRouterPeriodSummaryContentJob = OpenRouterBatchJob & {
  readonly kind: 'period_summary';
  readonly status: Exclude<AssistantBatchStatus, 'source_removed'>;
  readonly requestProfileVersion: 6;
  readonly operation: 'period_summary';
  readonly inputPolicyVersion: 2;
  readonly outputPolicyVersion: 2;
  readonly summaryBinding: OpenRouterPeriodSummaryBinding;
  readonly sourceRemoved?: undefined;
};

export type OpenRouterBatchContentJob = OpenRouterBatchJob & {
  readonly sourceRemoved?: undefined;
  readonly status: Exclude<AssistantBatchStatus, 'source_removed'>;
  readonly settingsFingerprint: string;
  readonly sourceFingerprint: string;
  readonly requestProfileVersion: OpenRouterBatchRequestProfileVersion;
  readonly requestBytes: number;
  readonly omittedSourceCount: number;
  readonly requestBody: string;
  readonly sourceVersions: Readonly<Record<string, string>>;
};

/** Content-free receipt retained after the user explicitly removes a source. It can never authorize result application. */
export type OpenRouterBatchTombstone = OpenRouterBatchJob & { readonly sourceRemoved: true; readonly status: 'source_removed' };

export interface OpenRouterBatchLedger {
  readonly version: typeof OPENROUTER_BATCH_LEDGER_VERSION;
  readonly jobs: readonly OpenRouterBatchJob[];
}

/** Safe, fixed-shape view for the foreground job list. It contains no request or result text. */
export interface AssistantBatchJobDTO {
  readonly id: string;
  readonly kind: AssistantBatchKind;
  readonly status: AssistantBatchStatus;
  readonly sourceRemoved?: true;
  readonly canCheck: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Present only after a provider result was observed but before its reply was retained. */
  readonly resultObservedAt?: string;
  readonly noteId?: string;
  readonly noteRevision?: number;
  readonly model: typeof OPENROUTER_BATCH_MODEL;
  readonly effort: 'none' | 'low' | OpenRouterChatRefinementEffort;
  readonly operation?: 'chat_refinement' | 'mail_reply_context' | 'period_summary';
  readonly reasoningEffort?: OpenRouterChatRefinementEffort;
  readonly parentTurnId?: string;
  readonly recoveryParentTurnId?: string;
  readonly requestBytes?: number;
  readonly omittedSourceCount?: number;
  readonly unknownCharge: boolean;
  readonly costStatus: 'waiting' | 'reported' | 'unavailable';
  readonly billingScope: 'openrouter_reported' | 'byok_fee_only';
  readonly providerReportedCostUsd?: number;
  readonly byok?: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly failureCode?: OpenRouterBatchJob['failureCode'];
  readonly mailMessageId?: string;
  readonly hasMailReplyResult?: boolean;
  readonly canReviewMailReply?: boolean;
  readonly mailReplyContextCount?: number;
  readonly mailReplyActivationOperation?: 'draft' | 'send';
  readonly proposalId?: string;
  /** Indicates a possible manual review; prepareMoreCompute revalidates current sources before returning a plan. */
  readonly canRecoverMoreCompute?: boolean;
  readonly moreComputeEfforts?: readonly ('low' | 'medium' | 'high' | 'max')[];
  readonly pendingRecoveryChildId?: string;
  readonly recoveredConversationId?: string;
  readonly recoveredTurnId?: string;
  readonly periodSummary?: OpenRouterPeriodSummaryPublicMetadata;
  readonly summaryLineage?: OpenRouterPeriodSummaryLineage;
}

export function emptyOpenRouterBatchLedger(): OpenRouterBatchLedger {
  return Object.freeze({ version: OPENROUTER_BATCH_LEDGER_VERSION, jobs: Object.freeze([]) });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value).sort();
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validAccounting(value: unknown): value is OpenRouterBatchAccounting {
  const row = record(value);
  if (!row || !exactKeys(row, [], ['providerReportedCostUsd', 'byok', 'promptTokens', 'completionTokens', 'totalTokens'])) return false;
  const cost = row.providerReportedCostUsd;
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) return false;
  if (row.byok !== undefined && typeof row.byok !== 'boolean') return false;
  for (const tokens of [row.promptTokens, row.completionTokens, row.totalTokens]) {
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || (tokens as number) < 0)) return false;
  }
  return true;
}

function validProviderObservation(value: unknown, status: unknown): value is OpenRouterProviderObservation {
  const row = record(value);
  return Boolean(row && exactKeys(row, ['version', 'observedAt', 'resultSha256']) && row.version === 1 &&
    canonicalIso(row.observedAt) && typeof row.resultSha256 === 'string' && row.resultSha256.length === 64 && SHA256.test(row.resultSha256) &&
    (status === 'processing' || status === 'completed' || status === 'result_stale' || status === 'result_not_retained'));
}

function validRecoveryBinding(value: unknown, job?: Record<string, unknown>): value is OpenRouterBatchRecoveryBinding {
  const row = record(value);
  if (!row || !exactKeys(row,
    ['version', 'parentJobId', 'parentKind', 'parentRequestProfileVersion', 'parentEffort', 'parentRequestSha256', 'parentSourceFingerprint',
      'baseRequestProfileVersion', 'baseOperation', 'baseRequestSha256', 'baseSourceFingerprint'],
    ['parentOperation', 'noteRemap']) || row.version !== 1 ||
      typeof row.parentJobId !== 'string' || !UUID_V4.test(row.parentJobId) ||
      (row.parentKind !== 'note_assistance' && row.parentKind !== 'mail_reply') ||
      (row.parentRequestProfileVersion !== 1 && row.parentRequestProfileVersion !== 2 && row.parentRequestProfileVersion !== 3 && row.parentRequestProfileVersion !== 4 && row.parentRequestProfileVersion !== 5) ||
      (row.parentEffort !== 'none' && row.parentEffort !== 'low' && row.parentEffort !== 'medium' && row.parentEffort !== 'high' && row.parentEffort !== 'max') ||
      typeof row.parentRequestSha256 !== 'string' || row.parentRequestSha256.length !== 64 || !SHA256.test(row.parentRequestSha256) ||
      typeof row.parentSourceFingerprint !== 'string' || row.parentSourceFingerprint.length !== 64 || !SHA256.test(row.parentSourceFingerprint) ||
      (row.baseRequestProfileVersion !== 1 && row.baseRequestProfileVersion !== 2 && row.baseRequestProfileVersion !== 3 && row.baseRequestProfileVersion !== 5) ||
      (row.baseOperation !== 'note_assistance' && row.baseOperation !== 'chat_refinement' && row.baseOperation !== 'mail_reply_body' && row.baseOperation !== 'mail_reply_context') ||
      typeof row.baseRequestSha256 !== 'string' || row.baseRequestSha256.length !== 64 || !SHA256.test(row.baseRequestSha256) ||
      typeof row.baseSourceFingerprint !== 'string' || row.baseSourceFingerprint.length !== 64 || !SHA256.test(row.baseSourceFingerprint) ||
      (row.parentOperation !== undefined && row.parentOperation !== 'chat_refinement' && row.parentOperation !== 'mail_reply_context')) return false;
  const remap = row.noteRemap;
  if (remap !== undefined) {
    const item = record(remap);
    if (!item || !exactKeys(item, ['fromNoteId', 'toNoteId']) || typeof item.fromNoteId !== 'string' || !item.fromNoteId || item.fromNoteId.length > 512 ||
        typeof item.toNoteId !== 'string' || !item.toNoteId || item.toNoteId.length > 512 || item.fromNoteId === item.toNoteId) return false;
  }
  if (job && (row.parentJobId === job.id || row.parentKind !== job.kind || row.parentRequestProfileVersion === 4 && !row.baseRequestSha256)) return false;
  if (job && row.noteRemap !== undefined && job.sourceRemoved !== true) {
    const remap = record(row.noteRemap)!;
    const chat = record(job.chatBinding);
    if (job.kind !== 'note_assistance' || !chat || job.noteId !== remap.toNoteId || chat.recoveryParentTurnId === undefined) return false;
  }
  return true;
}

function validChatBinding(value: unknown): value is OpenRouterChatBinding {
  const row = record(value);
  const plainDataObject = (candidate: Record<string, unknown>) => {
    const prototype = Object.getPrototypeOf(candidate);
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(candidate).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      return Boolean(descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value'));
    });
  };
  if (!row || !plainDataObject(row) || !exactKeys(row, ['conversationId', 'turnId', 'context', 'omittedTurnCount'], ['refinementParent', 'transcriptSource', 'recoveryParentTurnId']) ||
      typeof row.conversationId !== 'string' || row.conversationId.length !== 36 || !UUID_V4.test(row.conversationId) ||
      typeof row.turnId !== 'string' || row.turnId.length !== 36 || !UUID_V4.test(row.turnId) ||
      !Number.isSafeInteger(row.omittedTurnCount) || (row.omittedTurnCount as number) < 0 ||
      !Array.isArray(row.context) || Object.getPrototypeOf(row.context) !== Array.prototype || row.context.length > 5_000) return false;
  if (row.recoveryParentTurnId !== undefined && (typeof row.recoveryParentTurnId !== 'string' || row.recoveryParentTurnId.length !== 36 || !UUID_V4.test(row.recoveryParentTurnId))) return false;
  const contextKeys = Reflect.ownKeys(row.context);
  if (contextKeys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) ||
      contextKeys.filter((key) => key !== 'length').length !== row.context.length ||
      !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(row.context, 'length') ?? {}, 'value') ||
      contextKeys.some((key) => {
        if (key === 'length') return false;
        const descriptor = Object.getOwnPropertyDescriptor(row.context, key);
        return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
      })) return false;
  const validReference = (candidate: unknown): candidate is OpenRouterChatContextReference => {
    const item = record(candidate);
    return Boolean(item && plainDataObject(item) && exactKeys(item, ['turnId', 'jobId', 'noteId', 'noteRevision', 'replySha256', 'replyProfileVersion'], ['outputPolicyVersion']) &&
      typeof item.turnId === 'string' && item.turnId.length === 36 && UUID_V4.test(item.turnId) &&
      typeof item.jobId === 'string' && item.jobId.length === 36 && UUID_V4.test(item.jobId) &&
      typeof item.noteId === 'string' && item.noteId.length === 36 && UUID_V4.test(item.noteId) &&
      Number.isSafeInteger(item.noteRevision) && (item.noteRevision as number) > 0 &&
      typeof item.replySha256 === 'string' && item.replySha256.length === 64 && SHA256.test(item.replySha256) &&
      (item.replyProfileVersion === 1 || item.replyProfileVersion === 2 || item.replyProfileVersion === 4 || item.replyProfileVersion === 5) &&
      (item.outputPolicyVersion === undefined || item.outputPolicyVersion === 1 || item.outputPolicyVersion === 2));
  };
  if (row.refinementParent !== undefined && !validReference(row.refinementParent)) return false;
  if (row.refinementParent !== undefined && row.transcriptSource !== undefined) return false;
  if (row.transcriptSource !== undefined) {
    const source = record(row.transcriptSource);
    if (!source || !plainDataObject(source) || !exactKeys(source, ['noteId', 'noteRevision', 'transcriptSha256', 'capturedAt', 'captureTimeZone']) ||
        typeof source.noteId !== 'string' || source.noteId.length < 1 || source.noteId.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(source.noteId) ||
        !Number.isSafeInteger(source.noteRevision) || (source.noteRevision as number) < 1 ||
        typeof source.transcriptSha256 !== 'string' || source.transcriptSha256.length !== 64 || !SHA256.test(source.transcriptSha256) ||
        !canonicalIso(source.capturedAt) || typeof source.captureTimeZone !== 'string' || !source.captureTimeZone || source.captureTimeZone.length > 128) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: source.captureTimeZone }).format(0); } catch { return false; }
  }
  if (row.refinementParent !== undefined && row.context.some((candidate) => record(candidate)?.turnId === record(row.refinementParent)?.turnId)) return false;
  const seenTurnIds = new Set<string>();
  const seenJobIds = new Set<string>();
  const seenNoteIds = new Set<string>();
  return row.context.every((candidate) => {
    const item = record(candidate);
    if (!item || !validReference(item)) return false;
    if (seenTurnIds.has(item.turnId) || seenJobIds.has(item.jobId) || seenNoteIds.has(item.noteId)) return false;
    seenTurnIds.add(item.turnId); seenJobIds.add(item.jobId); seenNoteIds.add(item.noteId);
    return true;
  });
}

function validSummaryMetadata(value: unknown): value is OpenRouterPeriodSummaryMetadata {
  const row = record(value);
  const interval = record(row?.localInterval);
  if (!row || !exactKeys(row, ['period', 'timeZone', 'localInterval'], ['occurrenceId']) ||
      (row.occurrenceId !== undefined && (typeof row.occurrenceId !== 'string' || !UUID_V4.test(row.occurrenceId))) ||
      !['daily', 'weekly', 'monthly', 'yearly'].includes(String(row.period)) ||
      typeof row.timeZone !== 'string' || !row.timeZone || row.timeZone.length > 128 ||
      !interval || !exactKeys(interval, ['start', 'end']) || typeof interval.start !== 'string' || typeof interval.end !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(interval.start) || !/^\d{4}-\d{2}-\d{2}$/.test(interval.end)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: row.timeZone }).format(0); return true; } catch { return false; }
}

function validSummaryLineage(value: unknown, jobId: string): value is OpenRouterPeriodSummaryLineage {
  const row = record(value);
  if (!row || !exactKeys(row, ['parentJobId', 'rootJobId', 'ancestorJobIds']) ||
      (row.parentJobId !== null && (typeof row.parentJobId !== 'string' || !UUID_V4.test(row.parentJobId))) ||
      typeof row.rootJobId !== 'string' || !UUID_V4.test(row.rootJobId) || !Array.isArray(row.ancestorJobIds) ||
      row.ancestorJobIds.some((id) => typeof id !== 'string' || !UUID_V4.test(id)) ||
      new Set(row.ancestorJobIds).size !== row.ancestorJobIds.length || row.ancestorJobIds.includes(jobId)) return false;
  if (row.parentJobId === null) return row.rootJobId === jobId && row.ancestorJobIds.length === 0;
  return row.ancestorJobIds[0] === row.parentJobId && row.ancestorJobIds.includes(row.rootJobId);
}

function validPeriodSummaryJob(row: Record<string, unknown>): boolean {
  const commonRequired = ['id', 'customId', 'kind', 'status', 'createdAt', 'updatedAt', 'model', 'effort', 'requestSha256', 'unknownCharge'];
  const commonOptional = ['batchId', 'accounting', 'failureCode', 'providerObservation'];
  if (typeof row.id !== 'string' || !UUID_V4.test(row.id) || row.customId !== row.id || row.kind !== 'period_summary' ||
      typeof row.status !== 'string' || !STATUSES.has(row.status) || !canonicalIso(row.createdAt) || !canonicalIso(row.updatedAt) ||
      row.model !== OPENROUTER_BATCH_MODEL || !['none', 'low', 'medium', 'high', 'max'].includes(String(row.effort)) ||
      typeof row.requestSha256 !== 'string' || !SHA256.test(row.requestSha256) || typeof row.unknownCharge !== 'boolean' ||
      (row.batchId !== undefined && (typeof row.batchId !== 'string' || row.batchId.length < 1 || row.batchId.length > 256 || /[^A-Za-z0-9_-]/.test(row.batchId))) ||
      (row.accounting !== undefined && !validAccounting(row.accounting)) ||
      (row.failureCode !== undefined && !['not_submitted', 'provider_failed', 'expired', 'invalid_result', 'stale_result', 'result_truncated', 'result_not_retained'].includes(String(row.failureCode))) ||
      ((row.status === 'result_not_retained') !== (row.failureCode === 'result_not_retained')) ||
      ((row.status === 'result_truncated') !== (row.failureCode === 'result_truncated')) ||
      (row.providerObservation !== undefined && !validProviderObservation(row.providerObservation, row.status))) return false;

  if (row.sourceRemoved === true) {
    const removedFields = [...commonRequired, 'sourceRemoved', 'operation', 'requestProfileVersion', 'inputPolicyVersion', 'outputPolicyVersion', 'summaryMetadata', 'summaryRecoveryLineage'];
    return row.status === 'source_removed' && row.operation === 'period_summary' && row.requestProfileVersion === 6 &&
      row.inputPolicyVersion === 2 && row.outputPolicyVersion === 2 && validSummaryMetadata(row.summaryMetadata) &&
      validSummaryLineage(row.summaryRecoveryLineage, row.id as string) && exactKeys(row, removedFields, commonOptional);
  }
  const required = [...commonRequired, 'operation', 'requestProfileVersion', 'inputPolicyVersion', 'outputPolicyVersion', 'requestBytes', 'requestBody', 'summaryBinding'];
  const optional = [...commonOptional, 'summaryRecoveryBinding', 'resultText', 'resultSha256', 'truncatedResultText', 'truncatedResultSha256'];
  if (row.sourceRemoved !== undefined || row.status === 'source_removed' || !exactKeys(row, required, optional) ||
      row.operation !== 'period_summary' || row.requestProfileVersion !== 6 || row.inputPolicyVersion !== 2 || row.outputPolicyVersion !== 2 ||
      !Number.isSafeInteger(row.requestBytes) || (row.requestBytes as number) < 1 || (row.requestBytes as number) > 1024 * 1024 ||
      typeof row.requestBody !== 'string' || new TextEncoder().encode(row.requestBody).byteLength !== row.requestBytes ||
      new TextEncoder().encode(row.requestBody).byteLength > 1024 * 1024 ||
      !isOpenRouterPeriodSummaryBindingShape(row.summaryBinding, row.summaryRecoveryBinding !== undefined) || row.summaryBinding.effort !== row.effort) return false;
  if (row.summaryRecoveryBinding === undefined) {
    if (row.effort !== 'none' && row.effort !== 'low') return false;
  } else if (!isOpenRouterPeriodSummaryRecoveryBindingShape(row.summaryRecoveryBinding, row.summaryBinding, row.id)) return false;
  if (!isOpenRouterPeriodSummaryRequestBodyShape(row.requestBody, row.summaryBinding, row.summaryRecoveryBinding, row.id, row.requestSha256)) return false;
  const resultPair = row.resultText !== undefined || row.resultSha256 !== undefined;
  const truncatedPair = row.truncatedResultText !== undefined || row.truncatedResultSha256 !== undefined;
  if (truncatedPair) {
    if (row.status !== 'result_truncated' || typeof row.truncatedResultText !== 'string' || !validUnicodeText(row.truncatedResultText) ||
        !row.truncatedResultText.trim() || new TextEncoder().encode(row.truncatedResultText).byteLength > OPENROUTER_BATCH_RESPONSE_MAX_BYTES ||
        typeof row.truncatedResultSha256 !== 'string' || !SHA256.test(row.truncatedResultSha256)) return false;
  }
  if (resultPair) {
    if (truncatedPair || typeof row.resultText !== 'string' || typeof row.resultSha256 !== 'string' || !SHA256.test(row.resultSha256)) return false;
    try { parseOpenRouterPeriodSummaryResult(row.resultText, row.summaryBinding); } catch { return false; }
  }
  if ((row.status === 'completed') !== resultPair || (row.status === 'result_truncated') !== truncatedPair) return false;
  if (['queued', 'processing', 'completed', 'expired', 'cancelled', 'result_stale', 'result_invalid', 'result_truncated', 'result_not_retained'].includes(String(row.status)) && !row.batchId) return false;
  if (row.status === 'failed' && !row.batchId && !(row.failureCode === 'not_submitted' && row.unknownCharge === false)) return false;
  return true;
}

function validJob(value: unknown): value is OpenRouterBatchJob {
  const row = record(value);
  if (row?.kind === 'period_summary') return validPeriodSummaryJob(row);
  if (row?.kind === 'mail_reply') return validMailReplyJob(row);
  const commonRequired = ['id', 'customId', 'kind', 'status', 'createdAt', 'updatedAt', 'model', 'effort', 'requestSha256', 'unknownCharge'];
  const commonOptional = ['batchId', 'accounting', 'failureCode', 'providerObservation'];
  if (!row || !exactKeys(row, commonRequired, [...commonOptional, 'operation', 'reasoningEffort', 'parentTurnId', 'recoveryBinding', 'sourceRemoved', 'noteId', 'noteRevision', 'intent', 'question', 'knowledgeSelection', 'capturedAt', 'captureTimeZone', 'answeredAsOf', 'settingsFingerprint', 'sourceFingerprint', 'requestProfileVersion', 'inputPolicyVersion', 'outputPolicyVersion', 'requestBytes', 'omittedSourceCount', 'requestBody', 'sourceVersions', 'appliedNoteRevision', 'chatBinding'])) return false;
  if (row.inputPolicyVersion !== undefined && row.inputPolicyVersion !== 1 && row.inputPolicyVersion !== 2) return false;
  if (row.outputPolicyVersion !== undefined && row.outputPolicyVersion !== 1 && row.outputPolicyVersion !== 2) return false;
  if (typeof row.id !== 'string' || row.id.length !== 36 || !UUID_V4.test(row.id) || row.customId !== row.id ||
      row.kind !== 'note_assistance' || typeof row.status !== 'string' || !STATUSES.has(row.status) ||
      !canonicalIso(row.createdAt) || !canonicalIso(row.updatedAt) ||
      row.model !== OPENROUTER_BATCH_MODEL || typeof row.effort !== 'string' || !['none', 'low', 'medium', 'high', 'max'].includes(row.effort) ||
      typeof row.requestSha256 !== 'string' || row.requestSha256.length !== 64 || !SHA256.test(row.requestSha256) || typeof row.unknownCharge !== 'boolean') return false;
  if ((row.operation !== undefined && row.operation !== 'chat_refinement') ||
      (row.reasoningEffort !== undefined && (typeof row.reasoningEffort !== 'string' || !['medium', 'high', 'max'].includes(row.reasoningEffort))) ||
      ((row.operation === 'chat_refinement') !== (row.reasoningEffort !== undefined)) ||
      (row.operation === 'chat_refinement' && (row.effort !== row.reasoningEffort ||
        (row.sourceRemoved !== true && (typeof row.parentTurnId !== 'string' || row.parentTurnId.length !== 36 || !UUID_V4.test(row.parentTurnId))) ||
        (row.parentTurnId !== undefined && (typeof row.parentTurnId !== 'string' || row.parentTurnId.length !== 36 || !UUID_V4.test(row.parentTurnId))))) ||
      (row.operation !== 'chat_refinement' && row.parentTurnId !== undefined)) return false;
  if (row.batchId !== undefined && (typeof row.batchId !== 'string' || row.batchId.length < 1 || row.batchId.length > 256 || /[^A-Za-z0-9_-]/.test(row.batchId))) return false;
  if (row.accounting !== undefined && !validAccounting(row.accounting)) return false;
  if (row.providerObservation !== undefined && !validProviderObservation(row.providerObservation, row.status)) return false;
  if (row.chatBinding !== undefined && !validChatBinding(row.chatBinding)) return false;
  if (row.failureCode !== undefined && (typeof row.failureCode !== 'string' || !['not_submitted', 'provider_failed', 'expired', 'invalid_result', 'stale_result', 'result_truncated', 'result_not_retained'].includes(row.failureCode))) return false;
  if ((row.status === 'result_not_retained') !== (row.failureCode === 'result_not_retained') ||
      (row.status === 'result_truncated') !== (row.failureCode === 'result_truncated')) return false;
  if (row.recoveryBinding !== undefined && !validRecoveryBinding(row.recoveryBinding, row)) return false;
  if (row.sourceRemoved === true) {
    if ((row.requestProfileVersion === 5 && row.outputPolicyVersion !== 2) ||
        (row.kind === 'note_assistance' && row.outputPolicyVersion === 2 && row.requestProfileVersion !== 4 && row.requestProfileVersion !== 5)) return false;
    return row.status === 'source_removed' && (row.requestProfileVersion === 1 || row.requestProfileVersion === 2 || row.requestProfileVersion === 4 || row.requestProfileVersion === 5) &&
      (row.operation !== 'chat_refinement' || ((row.requestProfileVersion === 2 || row.requestProfileVersion === 4 || row.requestProfileVersion === 5) && row.reasoningEffort === row.effort)) &&
      exactKeys(row, [...commonRequired, 'sourceRemoved', 'requestProfileVersion'], [...commonOptional, 'operation', 'reasoningEffort', 'parentTurnId', 'recoveryBinding', 'chatBinding', 'inputPolicyVersion', 'outputPolicyVersion']);
  }
  if (row.sourceRemoved !== undefined || row.status === 'source_removed' || !exactKeys(row,
    [...commonRequired, 'settingsFingerprint', 'sourceFingerprint', 'requestProfileVersion', 'requestBytes', 'omittedSourceCount', 'requestBody', 'sourceVersions'],
    [...commonOptional, 'operation', 'reasoningEffort', 'parentTurnId', 'recoveryBinding', 'noteId', 'noteRevision', 'intent', 'question', 'knowledgeSelection', 'capturedAt', 'captureTimeZone', 'answeredAsOf', 'appliedNoteRevision', 'chatBinding', 'inputPolicyVersion', 'outputPolicyVersion'])) return false;
  if (typeof row.settingsFingerprint !== 'string' || row.settingsFingerprint.length !== 64 || !SHA256.test(row.settingsFingerprint) ||
      typeof row.sourceFingerprint !== 'string' || row.sourceFingerprint.length !== 64 || !SHA256.test(row.sourceFingerprint) ||
      (row.requestProfileVersion !== 1 && row.requestProfileVersion !== 2 && row.requestProfileVersion !== 4 && row.requestProfileVersion !== 5) ||
      !Number.isSafeInteger(row.requestBytes) || (row.requestBytes as number) < 1 || (row.requestBytes as number) > 1024 * 1024 ||
      !Number.isSafeInteger(row.omittedSourceCount) || (row.omittedSourceCount as number) < 0 ||
      typeof row.requestBody !== 'string' || new TextEncoder().encode(row.requestBody).byteLength > 1024 * 1024 ||
      new TextEncoder().encode(row.requestBody).byteLength !== row.requestBytes) return false;
  try {
    if (!isOpenRouterBatchRequestProfile(JSON.parse(row.requestBody), row.requestProfileVersion, row.operation ?? 'note_assistance',
      row.requestProfileVersion === 4 && record(row.recoveryBinding) ? { profileVersion: record(row.recoveryBinding)!.baseRequestProfileVersion as 1 | 2 | 3 | 5,
        operation: record(row.recoveryBinding)!.baseOperation as OpenRouterBatchBaseOperation } : undefined)) return false;
  } catch { return false; }
  if ((row.requestProfileVersion === 4) !== (row.recoveryBinding !== undefined) ||
      (row.kind === 'note_assistance' && row.outputPolicyVersion === 2 && row.requestProfileVersion !== 4 && row.requestProfileVersion !== 5) ||
      (row.requestProfileVersion === 5 && row.outputPolicyVersion !== 2)) return false;
  if (row.kind === 'note_assistance') {
    if (typeof row.noteId !== 'string' || !row.noteId || row.noteId.length > 512 || !Number.isSafeInteger(row.noteRevision) || (row.noteRevision as number) < 1 ||
        typeof row.intent !== 'string' || !['assist', 'summarize', 'answer', 'extract'].includes(row.intent) || !canonicalIso(row.capturedAt) ||
        typeof row.captureTimeZone !== 'string' || !row.captureTimeZone || row.captureTimeZone.length > 100 || !validTimeZone(row.captureTimeZone) ||
        (row.question !== undefined && (typeof row.question !== 'string' ||
          (row.inputPolicyVersion === 2
            ? new TextEncoder().encode(row.question).byteLength > 1024 * 1024
            : row.question.length > 16_384))) ||
        (row.answeredAsOf !== undefined && !canonicalIso(row.answeredAsOf)) ||
        (row.knowledgeSelection !== undefined && !validKnowledgeSelection(row.knowledgeSelection, row.inputPolicyVersion === 2 ? 2 : 1))) return false;
    if (row.operation === 'chat_refinement' && (row.intent !== 'answer' || (row.requestProfileVersion !== 2 && row.requestProfileVersion !== 4 && row.requestProfileVersion !== 5) ||
        !row.chatBinding || !row.chatBinding.refinementParent || row.reasoningEffort !== row.effort)) return false;
    if (row.operation !== 'chat_refinement' && (row.reasoningEffort !== undefined || row.chatBinding?.refinementParent !== undefined)) return false;
  }
  const versions = record(row.sourceVersions);
  if (!versions || Object.entries(versions).some(([key, version]) => !key || key.length > 512 || typeof version !== 'string' || version.length > 320)) return false;
  if (row.appliedNoteRevision !== undefined && (!Number.isSafeInteger(row.appliedNoteRevision) || (row.appliedNoteRevision as number) < 1)) return false;
  if ((row.status === 'queued' || row.status === 'processing' || row.status === 'completed' || row.status === 'expired' || row.status === 'cancelled' || row.status === 'result_stale' || row.status === 'result_invalid' || row.status === 'result_truncated' || row.status === 'result_not_retained') && !row.batchId) return false;
  if (row.status === 'failed' && !row.batchId && !(row.failureCode === 'not_submitted' && row.unknownCharge === false)) return false;
  return true;
}

function validMailReplyJob(row: Record<string, unknown>): boolean {
  const commonRequired = ['id', 'customId', 'kind', 'status', 'createdAt', 'updatedAt', 'model', 'effort', 'requestSha256', 'unknownCharge'];
  const commonOptional = ['batchId', 'accounting', 'failureCode', 'proposalId', 'mailReplyActivationOperation', 'recoveryBinding', 'providerObservation', 'proactiveMailReply'];
  if (!exactKeys(row, commonRequired, [...commonOptional, 'operation', 'sourceRemoved', 'requestProfileVersion', 'inputPolicyVersion', 'outputPolicyVersion', 'settingsFingerprint', 'sourceFingerprint',
      'requestBytes', 'omittedSourceCount', 'requestBody', 'sourceVersions', 'mailReplyBinding', 'resultText', 'resultSha256']) ||
      typeof row.id !== 'string' || row.id.length !== 36 || !UUID_V4.test(row.id) || row.customId !== row.id ||
      row.kind !== 'mail_reply' || typeof row.status !== 'string' || !STATUSES.has(row.status) ||
      !canonicalIso(row.createdAt) || !canonicalIso(row.updatedAt) || row.model !== OPENROUTER_BATCH_MODEL ||
      typeof row.effort !== 'string' || !['none', 'low', 'medium', 'high', 'max'].includes(row.effort) ||
      typeof row.requestSha256 !== 'string' || row.requestSha256.length !== 64 || !SHA256.test(row.requestSha256) || typeof row.unknownCharge !== 'boolean' ||
      (row.batchId !== undefined && (typeof row.batchId !== 'string' || row.batchId.length < 1 || row.batchId.length > 256 || /[^A-Za-z0-9_-]/.test(row.batchId))) ||
      (row.accounting !== undefined && !validAccounting(row.accounting)) ||
      (row.failureCode !== undefined && !['not_submitted', 'provider_failed', 'expired', 'invalid_result', 'stale_result', 'result_truncated', 'result_not_retained'].includes(String(row.failureCode))) ||
      (row.proposalId !== undefined && (typeof row.proposalId !== 'string' || row.proposalId.length !== 36 || !UUID_V4.test(row.proposalId))) ||
      (row.mailReplyActivationOperation !== undefined && row.mailReplyActivationOperation !== 'draft' && row.mailReplyActivationOperation !== 'send') ||
      (row.mailReplyActivationOperation !== undefined && row.proposalId === undefined)) return false;
  if (row.proactiveMailReply !== undefined) {
    if (!record(row.proactiveMailReply)) return false;
    const provenance = row.proactiveMailReply as Record<string, unknown>;
    if (!exactKeys(provenance, ['version', 'policyId', 'policyRevision', 'occurrenceId', 'attemptId']) ||
        provenance.version !== 1 || typeof provenance.policyId !== 'string' || !UUID_V4.test(provenance.policyId) ||
        !Number.isSafeInteger(provenance.policyRevision) || (provenance.policyRevision as number) < 1 ||
        typeof provenance.occurrenceId !== 'string' || !UUID_V4.test(provenance.occurrenceId) ||
        typeof provenance.attemptId !== 'string' || !UUID_V4.test(provenance.attemptId) || row.operation !== undefined || row.requestProfileVersion !== 1) return false;
  }
  if ((row.status === 'result_not_retained') !== (row.failureCode === 'result_not_retained') ||
      (row.status === 'result_truncated') !== (row.failureCode === 'result_truncated') ||
      (row.recoveryBinding !== undefined && !validRecoveryBinding(row.recoveryBinding, row)) ||
      (row.inputPolicyVersion !== undefined && row.inputPolicyVersion !== 1 && row.inputPolicyVersion !== 2) ||
      (row.outputPolicyVersion !== undefined && row.outputPolicyVersion !== 1 && row.outputPolicyVersion !== 2)) return false;
  if (row.providerObservation !== undefined && !validProviderObservation(row.providerObservation, row.status)) return false;
  if (row.sourceRemoved === true) {
      return row.status === 'source_removed' && (row.requestProfileVersion === 1 || row.requestProfileVersion === 2 || row.requestProfileVersion === 3 || row.requestProfileVersion === 4) &&
      (row.requestProfileVersion === 3 ? row.operation === 'mail_reply_context' :
        row.requestProfileVersion === 4 ? row.recoveryBinding !== undefined :
          row.operation === undefined) &&
      exactKeys(row, [...commonRequired, 'sourceRemoved', 'requestProfileVersion'], [...commonOptional, 'operation', 'inputPolicyVersion', 'outputPolicyVersion']);
  }
  if (row.sourceRemoved !== undefined || row.status === 'source_removed' || !validOpenRouterMailReplyBinding(row.mailReplyBinding, row.inputPolicyVersion === 2 ? 2 : 1) ||
      typeof row.settingsFingerprint !== 'string' || row.settingsFingerprint.length !== 64 || !SHA256.test(row.settingsFingerprint) ||
      typeof row.sourceFingerprint !== 'string' || row.sourceFingerprint.length !== 64 || !SHA256.test(row.sourceFingerprint) ||
      (row.requestProfileVersion !== 1 && row.requestProfileVersion !== 2 && row.requestProfileVersion !== 3 && row.requestProfileVersion !== 4) ||
      !Number.isSafeInteger(row.requestBytes) || (row.requestBytes as number) < 1 || (row.requestBytes as number) > 1024 * 1024 ||
      !Number.isSafeInteger(row.omittedSourceCount) || (row.omittedSourceCount as number) < 0 ||
      typeof row.requestBody !== 'string' || new TextEncoder().encode(row.requestBody).byteLength !== row.requestBytes ||
      new TextEncoder().encode(row.requestBody).byteLength > 1024 * 1024 || !record(row.sourceVersions)) return false;
  try {
    const request = JSON.parse(row.requestBody) as Record<string, unknown>;
    const responseFormat = record(request.response_format);
    const schema = record(responseFormat?.json_schema);
    const contextOperation = row.operation === 'mail_reply_context';
    const recovery = record(row.recoveryBinding);
    const recoveryBase = row.requestProfileVersion === 4 && recovery ? { profileVersion: recovery.baseRequestProfileVersion as 1 | 2 | 3 | 5,
      operation: recovery.baseOperation as OpenRouterBatchBaseOperation } : undefined;
    if ((row.requestProfileVersion === 4) !== Boolean(recovery) ||
        (contextOperation && (row.requestProfileVersion !== 3 && row.requestProfileVersion !== 4 || row.mailReplyBinding?.version !== 2)) ||
        (!contextOperation && (row.operation !== undefined || row.requestProfileVersion === 3 || row.mailReplyBinding?.version !== 1)) ||
        !isOpenRouterBatchRequestProfile(request, row.requestProfileVersion, contextOperation ? 'mail_reply_context' : 'note_assistance', recoveryBase) || schema?.name !== 'mail_reply_body') return false;
  } catch { return false; }
  const versions = record(row.sourceVersions)!;
  if (Object.entries(versions).some(([key, version]) => !key || key.length > 512 || typeof version !== 'string' || version.length > 320)) return false;
  const resultPair = row.resultText !== undefined || row.resultSha256 !== undefined;
  if (resultPair && (typeof row.resultText !== 'string' || !validReplyText(row.resultText, row.outputPolicyVersion === 2 ? Number.MAX_SAFE_INTEGER : 100_000) || typeof row.resultSha256 !== 'string' || row.resultSha256.length !== 64 || !SHA256.test(row.resultSha256))) return false;
  if ((row.status === 'completed') !== resultPair || (row.status === 'result_truncated' && resultPair)) return false;
  if (['queued', 'processing', 'completed', 'expired', 'cancelled', 'result_stale', 'result_invalid', 'result_truncated', 'result_not_retained'].includes(String(row.status)) && !row.batchId) return false;
  if (row.status === 'failed' && !row.batchId && !(row.failureCode === 'not_submitted' && row.unknownCharge === false)) return false;
  return true;
}

function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function validKnowledgeSelection(value: unknown, inputPolicyVersion: 1 | 2 = 1): boolean {
  if (!Array.isArray(value) || (inputPolicyVersion === 1 && value.length > 5)) return false;
  const seen = new Set<string>();
  for (const candidate of value) {
    const row = record(candidate);
    if (!row || !exactKeys(row, ['kind', 'id']) || typeof row.kind !== 'string' || !['person', 'project'].includes(row.kind) ||
        typeof row.id !== 'string' || !row.id || row.id.length > 512) return false;
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export function validateOpenRouterBatchLedger(value: unknown): OpenRouterBatchLedger {
  const row = record(value);
  if (!row || !exactKeys(row, ['version', 'jobs']) || row.version !== OPENROUTER_BATCH_LEDGER_VERSION || !Array.isArray(row.jobs) || !row.jobs.every(validJob)) {
    throw new Error('OpenRouter Batch history failed integrity validation.');
  }
  const jobs = row.jobs as OpenRouterBatchJob[];
  const ids = new Set<string>();
  const byId = new Map<string, OpenRouterBatchJob>();
  for (const job of jobs) {
    if (ids.has(job.id)) throw new Error('OpenRouter Batch history failed integrity validation.');
    ids.add(job.id);
    byId.set(job.id, job);
  }
  for (const job of jobs) {
    if (job.kind === 'period_summary') {
      const summaryRecovery = job.summaryRecoveryBinding;
      if (!summaryRecovery || job.sourceRemoved) continue;
      const parent = byId.get(summaryRecovery.parentJobId);
      if (!parent || parent.kind !== 'period_summary' || parent.sourceRemoved || parent.status !== 'result_truncated' ||
          parent.requestSha256 !== summaryRecovery.parentRequestSha256 || parent.effort !== summaryRecovery.parentEffort ||
          parent.summaryBinding?.sourceManifestSha256 !== summaryRecovery.sourceManifestSha256 ||
          JSON.stringify(parent.summaryBinding?.destination) !== JSON.stringify(summaryRecovery.destination) ||
          JSON.stringify(parent.summaryRecoveryBinding ?? null) !== JSON.stringify(summaryRecovery.parentRecoveryBinding) ||
          ['none', 'low', 'medium', 'high', 'max'].indexOf(job.effort) <= ['none', 'low', 'medium', 'high', 'max'].indexOf(parent.effort)) {
        throw new Error('OpenRouter period summary recovery lineage failed integrity validation.');
      }
      continue;
    }
    const recovery = job.recoveryBinding;
    if (!recovery) continue;
    const parent = byId.get(recovery.parentJobId);
    if (!parent || parent.kind === 'period_summary' || parent.kind !== recovery.parentKind || parent.requestProfileVersion !== recovery.parentRequestProfileVersion ||
        (parent.inputPolicyVersion ?? 1) !== (job.inputPolicyVersion ?? 1) || (parent.outputPolicyVersion ?? 1) !== (job.outputPolicyVersion ?? 1) ||
        parent.effort !== recovery.parentEffort || (parent.operation ?? undefined) !== (recovery.parentOperation ?? undefined) ||
        parent.requestSha256 !== recovery.parentRequestSha256 || (!parent.sourceRemoved && parent.sourceFingerprint !== recovery.parentSourceFingerprint) ||
        (parent.sourceRemoved && !job.sourceRemoved)) throw new Error('OpenRouter Batch recovery lineage failed integrity validation.');
    if (!parent.sourceRemoved && !job.sourceRemoved &&
        (parent.status !== 'result_truncated' || !higherOpenRouterRecoveryEfforts(parent.effort).includes(job.effort as OpenRouterChatRefinementEffort))) {
      throw new Error('OpenRouter Batch recovery effort lineage failed integrity validation.');
    }
    const parentRecovery = parent.recoveryBinding;
    const expectedBaseProfile = parentRecovery?.baseRequestProfileVersion ?? parent.requestProfileVersion;
    const expectedBaseOperation = parentRecovery?.baseOperation ?? (parent.kind === 'mail_reply'
      ? parent.operation === 'mail_reply_context' ? 'mail_reply_context' : 'mail_reply_body'
      : parent.operation ?? 'note_assistance');
    const expectedBaseRequest = parentRecovery?.baseRequestSha256 ?? parent.requestSha256;
    const expectedBaseSource = parentRecovery?.baseSourceFingerprint ?? parent.sourceFingerprint;
    if (expectedBaseProfile !== recovery.baseRequestProfileVersion || expectedBaseOperation !== recovery.baseOperation ||
        expectedBaseRequest !== recovery.baseRequestSha256 || (expectedBaseSource !== undefined && expectedBaseSource !== recovery.baseSourceFingerprint)) {
      throw new Error('OpenRouter Batch recovery base lineage failed integrity validation.');
    }
    if (job.sourceRemoved) continue;
    if (parent.kind === 'mail_reply') {
      if (job.kind !== 'mail_reply' || JSON.stringify(parent.mailReplyBinding) !== JSON.stringify(job.mailReplyBinding) || job.chatBinding || recovery.noteRemap) {
        throw new Error('OpenRouter Batch mail recovery lineage failed integrity validation.');
      }
    } else {
      const parentChat = parent.chatBinding;
      const childChat = job.chatBinding;
      if (Boolean(parentChat) !== Boolean(childChat)) throw new Error('OpenRouter Batch Chat recovery lineage failed integrity validation.');
      if (parentChat && childChat) {
        const { turnId: _parentTurnId, recoveryParentTurnId: _priorRecoveryParent, ...parentBinding } = parentChat;
        const { turnId: _childTurnId, recoveryParentTurnId: childRecoveryParentTurnId, ...childBinding } = childChat;
        if (!recovery.noteRemap || recovery.noteRemap.fromNoteId !== parent.noteId || recovery.noteRemap.toNoteId !== job.noteId ||
            childRecoveryParentTurnId !== parentChat.turnId || JSON.stringify(parentBinding) !== JSON.stringify(childBinding)) {
          throw new Error('OpenRouter Batch Chat recovery binding failed integrity validation.');
        }
      } else if (recovery.noteRemap) throw new Error('OpenRouter Batch recovery note remap failed integrity validation.');
    }
  }
  return Object.freeze({ version: OPENROUTER_BATCH_LEDGER_VERSION, jobs: Object.freeze(jobs.map((job) => Object.freeze({ ...job }))) });
}

export function assistantBatchJobDTO(job: OpenRouterBatchJob, cleanupPending = false): AssistantBatchJobDTO {
  return Object.freeze({
    id: job.id,
    kind: job.kind,
    status: cleanupPending ? 'cleanup_pending' : job.status,
    ...(job.sourceRemoved ? { sourceRemoved: true as const } : {}),
    canCheck: Boolean(!cleanupPending && job.batchId && (
      job.status === 'queued' || job.status === 'processing' ||
      ((job.sourceRemoved || ['completed', 'failed', 'expired', 'cancelled', 'result_stale', 'result_invalid', 'result_truncated', 'result_not_retained'].includes(job.status)) &&
        job.accounting?.providerReportedCostUsd === undefined))),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.providerObservation ? { resultObservedAt: job.providerObservation.observedAt } : {}),
    ...(job.noteId ? { noteId: job.noteId } : {}),
    ...(job.noteRevision !== undefined ? { noteRevision: job.noteRevision } : {}),
    model: job.model,
    effort: job.effort,
    ...(job.operation ? { operation: job.operation } : {}),
    ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
    ...(job.parentTurnId ? { parentTurnId: job.parentTurnId } : {}),
    ...(job.requestBytes !== undefined ? { requestBytes: job.requestBytes } : {}),
    ...(job.omittedSourceCount !== undefined ? { omittedSourceCount: job.omittedSourceCount } : {}),
    unknownCharge: job.unknownCharge,
    costStatus: job.accounting?.providerReportedCostUsd !== undefined ? 'reported' :
      ['completed', 'failed', 'expired', 'cancelled', 'result_invalid', 'result_stale', 'result_truncated', 'result_not_retained'].includes(job.status) ? 'unavailable' : 'waiting',
    billingScope: job.accounting?.byok ? 'byok_fee_only' : 'openrouter_reported',
    ...(job.accounting?.providerReportedCostUsd !== undefined ? { providerReportedCostUsd: job.accounting.providerReportedCostUsd } : {}),
    ...(job.accounting?.byok !== undefined ? { byok: job.accounting.byok } : {}),
    ...(job.accounting?.promptTokens !== undefined ? { promptTokens: job.accounting.promptTokens } : {}),
    ...(job.accounting?.completionTokens !== undefined ? { completionTokens: job.accounting.completionTokens } : {}),
    ...(job.accounting?.totalTokens !== undefined ? { totalTokens: job.accounting.totalTokens } : {}),
    ...(job.failureCode ? { failureCode: job.failureCode } : {}),
    ...(job.kind === 'mail_reply' && job.mailReplyBinding ? { mailMessageId: job.mailReplyBinding.messageId } : {}),
    ...(job.kind === 'mail_reply' && job.mailReplyBinding?.version === 2 ? { mailReplyContextCount: job.mailReplyBinding.context?.length ?? 0 } : {}),
    ...(job.kind === 'mail_reply' && job.resultText !== undefined ? { hasMailReplyResult: true, canReviewMailReply: !job.proposalId && job.status === 'completed' } : {}),
    ...(job.kind === 'mail_reply' && job.mailReplyActivationOperation ? { mailReplyActivationOperation: job.mailReplyActivationOperation } : {}),
    ...(job.kind === 'mail_reply' && job.proposalId ? { proposalId: job.proposalId } : {}),
    ...(job.recoveryBinding && job.chatBinding ? { recoveredConversationId: job.chatBinding.conversationId, recoveredTurnId: job.chatBinding.turnId } : {}),
    ...(job.kind === 'period_summary' ? { periodSummary: job.summaryBinding ? Object.freeze({ period: job.summaryBinding.period,
      timeZone: job.summaryBinding.timeZone, localInterval: Object.freeze({ ...job.summaryBinding.localInterval }) }) : job.summaryMetadata ?
        Object.freeze({ period: job.summaryMetadata.period, timeZone: job.summaryMetadata.timeZone,
          localInterval: Object.freeze({ ...job.summaryMetadata.localInterval }) }) : undefined } : {}),
    ...(job.kind === 'period_summary' && job.summaryRecoveryBinding ? { summaryLineage: summaryLineageFromProof(job.summaryRecoveryBinding) } : {}),
    ...(job.kind === 'period_summary' && job.summaryRecoveryLineage ? { summaryLineage: job.summaryRecoveryLineage } : {}),
  });
}

function summaryLineageFromProof(proof: OpenRouterPeriodSummaryRecoveryBinding): OpenRouterPeriodSummaryLineage {
  const ancestorJobIds: string[] = [];
  let cursor: OpenRouterPeriodSummaryRecoveryBinding | null = proof;
  while (cursor) {
    if (!ancestorJobIds.includes(cursor.parentJobId)) ancestorJobIds.push(cursor.parentJobId);
    cursor = cursor.parentRecoveryBinding;
  }
  return Object.freeze({ parentJobId: proof.parentJobId, rootJobId: proof.rootJobId, ancestorJobIds: Object.freeze(ancestorJobIds) });
}

export function isOpenRouterBatchContentJob(job: OpenRouterBatchJob): job is OpenRouterBatchContentJob {
  return job.kind === 'note_assistance' && job.sourceRemoved !== true && job.status !== 'source_removed' && typeof job.requestBody === 'string' &&
    typeof job.requestBytes === 'number' && typeof job.settingsFingerprint === 'string' &&
    typeof job.sourceFingerprint === 'string' && (job.requestProfileVersion === 1 || job.requestProfileVersion === 2 || job.requestProfileVersion === 4 || job.requestProfileVersion === 5) && !!job.sourceVersions;
}

export type OpenRouterMailReplyContentJob = OpenRouterBatchJob & {
  readonly kind: 'mail_reply';
  readonly sourceRemoved?: undefined;
  readonly status: Exclude<AssistantBatchStatus, 'source_removed'>;
  readonly settingsFingerprint: string;
  readonly sourceFingerprint: string;
  readonly requestProfileVersion: OpenRouterBatchRequestProfileVersion;
  readonly requestBytes: number;
  readonly omittedSourceCount: number;
  readonly requestBody: string;
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly mailReplyBinding: OpenRouterMailReplyBinding;
};

export function isOpenRouterMailReplyContentJob(job: OpenRouterBatchJob): job is OpenRouterMailReplyContentJob {
  return job.kind === 'mail_reply' && job.sourceRemoved !== true && job.status !== 'source_removed' &&
    typeof job.requestBody === 'string' && typeof job.requestBytes === 'number' && Boolean(job.mailReplyBinding);
}

export function tombstoneOpenRouterBatchJob(job: OpenRouterBatchJob, updatedAt: string, stripChatBinding = false): OpenRouterBatchTombstone {
  if (job.sourceRemoved) {
    if (!stripChatBinding || (!job.chatBinding && job.parentTurnId === undefined)) return job as OpenRouterBatchTombstone;
    const { chatBinding: _chatBinding, parentTurnId: _parentTurnId, ...contentFreeReceipt } = job;
    return Object.freeze(contentFreeReceipt) as OpenRouterBatchTombstone;
  }
  if (job.kind === 'period_summary') {
    const metadata = job.summaryBinding ? Object.freeze({ occurrenceId: job.summaryBinding.occurrenceId, period: job.summaryBinding.period, timeZone: job.summaryBinding.timeZone,
      localInterval: Object.freeze({ ...job.summaryBinding.localInterval }) }) : job.summaryMetadata;
    const lineage = job.summaryRecoveryBinding ? summaryLineageFromProof(job.summaryRecoveryBinding) :
      Object.freeze({ parentJobId: null, rootJobId: job.id, ancestorJobIds: Object.freeze([]) });
    return Object.freeze({ id: job.id, customId: job.customId, kind: job.kind, sourceRemoved: true, status: 'source_removed',
      createdAt: job.createdAt, updatedAt, model: job.model, effort: job.effort, operation: 'period_summary',
      requestProfileVersion: 6, inputPolicyVersion: 2, outputPolicyVersion: 2, requestSha256: job.requestSha256,
      ...(job.batchId ? { batchId: job.batchId } : {}), unknownCharge: job.unknownCharge,
      ...(job.accounting ? { accounting: job.accounting } : {}), summaryMetadata: metadata, summaryRecoveryLineage: lineage });
  }
  return Object.freeze({
    id: job.id, customId: job.customId, kind: job.kind, sourceRemoved: true,
    status: 'source_removed', createdAt: job.createdAt, updatedAt,
    model: job.model, effort: job.effort, requestProfileVersion: job.requestProfileVersion ?? 1, requestSha256: job.requestSha256,
    ...(job.operation ? { operation: job.operation } : {}),
    ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
    ...(job.recoveryBinding ? { recoveryBinding: job.recoveryBinding } : {}),
    ...(job.inputPolicyVersion !== undefined ? { inputPolicyVersion: job.inputPolicyVersion } : {}),
    ...(job.outputPolicyVersion !== undefined ? { outputPolicyVersion: job.outputPolicyVersion } : {}),
    ...(!stripChatBinding && job.chatBinding ? { chatBinding: job.chatBinding } : {}),
    ...(job.batchId ? { batchId: job.batchId } : {}),
    unknownCharge: job.unknownCharge,
    ...(job.accounting ? { accounting: job.accounting } : {}),
    ...(job.kind === 'mail_reply' && job.proposalId ? { proposalId: job.proposalId } : {}),
    ...(job.kind === 'mail_reply' && job.mailReplyActivationOperation ? { mailReplyActivationOperation: job.mailReplyActivationOperation } : {}),
    ...(job.kind === 'mail_reply' && job.proactiveMailReply ? { proactiveMailReply: Object.freeze({ ...job.proactiveMailReply }) } : {}),
  });
}

export function accountingFromInspection(inspection: OpenRouterBatchInspection): OpenRouterBatchAccounting | undefined {
  const usage = inspection.usage;
  if (!usage) return undefined;
  return Object.freeze({
    ...(usage.cost !== undefined ? { providerReportedCostUsd: usage.cost } : {}),
    ...(usage.isByok !== undefined ? { byok: usage.isByok } : {}),
    ...(usage.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}),
    ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  });
}
