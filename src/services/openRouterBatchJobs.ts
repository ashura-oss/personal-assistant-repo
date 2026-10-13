import type { AssistIntent, KnowledgeSelection } from '../core';
import type { OpenRouterBatchInspection, OpenRouterBatchRequestProfileVersion } from './openRouter';
import { isOpenRouterBatchRequestProfile, OPENROUTER_BATCH_MODEL } from './openRouter';

export const OPENROUTER_BATCH_LEDGER_VERSION = 1 as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STATUSES = new Set([
  'preparing', 'submitting', 'submission_unknown', 'queued', 'processing', 'completed',
  'failed', 'expired', 'cancelled', 'result_stale', 'result_invalid', 'result_not_retained', 'cleanup_pending', 'source_removed',
]);

export type AssistantBatchKind = 'note_assistance' | 'mail_reply';
export type AssistantBatchStatus =
  | 'preparing' | 'submitting' | 'submission_unknown' | 'queued' | 'processing' | 'completed'
  | 'failed' | 'expired' | 'cancelled' | 'result_stale' | 'result_invalid' | 'result_not_retained' | 'cleanup_pending' | 'source_removed';

export interface OpenRouterBatchAccounting {
  readonly providerReportedCostUsd?: number;
  readonly byok?: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

/** Private persisted job record. Raw request text never enters AppState/public projections. */
export interface OpenRouterBatchJob {
  readonly id: string;
  readonly customId: string;
  readonly kind: AssistantBatchKind;
  readonly status: AssistantBatchStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: typeof OPENROUTER_BATCH_MODEL;
  readonly effort: 'none' | 'low';
  readonly requestSha256: string;
  readonly sourceRemoved?: true;
  readonly batchId?: string;
  readonly unknownCharge: boolean;
  readonly accounting?: OpenRouterBatchAccounting;
  readonly failureCode?: 'not_submitted' | 'provider_failed' | 'expired' | 'invalid_result' | 'stale_result' | 'result_not_retained';
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
  readonly requestProfileVersion?: OpenRouterBatchRequestProfileVersion;
  readonly requestBytes?: number;
  readonly omittedSourceCount?: number;
  readonly requestBody?: string;
  readonly sourceVersions?: Readonly<Record<string, string>>;
  readonly appliedNoteRevision?: number;
}

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
  readonly noteId?: string;
  readonly noteRevision?: number;
  readonly model: typeof OPENROUTER_BATCH_MODEL;
  readonly effort: 'none' | 'low';
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

function validJob(value: unknown): value is OpenRouterBatchJob {
  const row = record(value);
  const commonRequired = ['id', 'customId', 'kind', 'status', 'createdAt', 'updatedAt', 'model', 'effort', 'requestSha256', 'unknownCharge'];
  const commonOptional = ['batchId', 'accounting', 'failureCode'];
  if (!row || !exactKeys(row, commonRequired, [...commonOptional, 'sourceRemoved', 'noteId', 'noteRevision', 'intent', 'question', 'knowledgeSelection', 'capturedAt', 'captureTimeZone', 'answeredAsOf', 'settingsFingerprint', 'sourceFingerprint', 'requestProfileVersion', 'requestBytes', 'omittedSourceCount', 'requestBody', 'sourceVersions', 'appliedNoteRevision'])) return false;
  if (typeof row.id !== 'string' || row.id.length !== 36 || !UUID_V4.test(row.id) || row.customId !== row.id ||
      row.kind !== 'note_assistance' || typeof row.status !== 'string' || !STATUSES.has(row.status) ||
      !canonicalIso(row.createdAt) || !canonicalIso(row.updatedAt) ||
      row.model !== OPENROUTER_BATCH_MODEL || typeof row.effort !== 'string' || !['none', 'low'].includes(row.effort) ||
      typeof row.requestSha256 !== 'string' || row.requestSha256.length !== 64 || !SHA256.test(row.requestSha256) || typeof row.unknownCharge !== 'boolean') return false;
  if (row.batchId !== undefined && (typeof row.batchId !== 'string' || row.batchId.length < 1 || row.batchId.length > 256 || /[^A-Za-z0-9_-]/.test(row.batchId))) return false;
  if (row.accounting !== undefined && !validAccounting(row.accounting)) return false;
  if (row.failureCode !== undefined && (typeof row.failureCode !== 'string' || !['not_submitted', 'provider_failed', 'expired', 'invalid_result', 'stale_result', 'result_not_retained'].includes(row.failureCode))) return false;
  if ((row.status === 'result_not_retained') !== (row.failureCode === 'result_not_retained')) return false;
  if (row.sourceRemoved === true) {
    return row.status === 'source_removed' && (row.requestProfileVersion === 1 || row.requestProfileVersion === 2) &&
      exactKeys(row, [...commonRequired, 'sourceRemoved', 'requestProfileVersion'], commonOptional);
  }
  if (row.sourceRemoved !== undefined || row.status === 'source_removed' || !exactKeys(row,
    [...commonRequired, 'settingsFingerprint', 'sourceFingerprint', 'requestProfileVersion', 'requestBytes', 'omittedSourceCount', 'requestBody', 'sourceVersions'],
    [...commonOptional, 'noteId', 'noteRevision', 'intent', 'question', 'knowledgeSelection', 'capturedAt', 'captureTimeZone', 'answeredAsOf', 'appliedNoteRevision'])) return false;
  if (typeof row.settingsFingerprint !== 'string' || row.settingsFingerprint.length !== 64 || !SHA256.test(row.settingsFingerprint) ||
      typeof row.sourceFingerprint !== 'string' || row.sourceFingerprint.length !== 64 || !SHA256.test(row.sourceFingerprint) ||
      (row.requestProfileVersion !== 1 && row.requestProfileVersion !== 2) ||
      !Number.isSafeInteger(row.requestBytes) || (row.requestBytes as number) < 1 || (row.requestBytes as number) > 1024 * 1024 ||
      !Number.isSafeInteger(row.omittedSourceCount) || (row.omittedSourceCount as number) < 0 ||
      typeof row.requestBody !== 'string' || new TextEncoder().encode(row.requestBody).byteLength > 1024 * 1024 ||
      new TextEncoder().encode(row.requestBody).byteLength !== row.requestBytes) return false;
  try {
    if (!isOpenRouterBatchRequestProfile(JSON.parse(row.requestBody), row.requestProfileVersion)) return false;
  } catch { return false; }
  if (row.kind === 'note_assistance') {
    if (typeof row.noteId !== 'string' || !row.noteId || row.noteId.length > 512 || !Number.isSafeInteger(row.noteRevision) || (row.noteRevision as number) < 1 ||
        typeof row.intent !== 'string' || !['assist', 'summarize', 'answer', 'extract'].includes(row.intent) || !canonicalIso(row.capturedAt) ||
        typeof row.captureTimeZone !== 'string' || !row.captureTimeZone || row.captureTimeZone.length > 100 || !validTimeZone(row.captureTimeZone) ||
        (row.question !== undefined && (typeof row.question !== 'string' || row.question.length > 16_384)) ||
        (row.answeredAsOf !== undefined && !canonicalIso(row.answeredAsOf)) ||
        (row.knowledgeSelection !== undefined && !validKnowledgeSelection(row.knowledgeSelection))) return false;
  }
  const versions = record(row.sourceVersions);
  if (!versions || Object.entries(versions).some(([key, version]) => !key || key.length > 512 || typeof version !== 'string' || version.length > 320)) return false;
  if (row.appliedNoteRevision !== undefined && (!Number.isSafeInteger(row.appliedNoteRevision) || (row.appliedNoteRevision as number) < 1)) return false;
  if ((row.status === 'queued' || row.status === 'processing' || row.status === 'completed' || row.status === 'expired' || row.status === 'cancelled' || row.status === 'result_stale' || row.status === 'result_invalid' || row.status === 'result_not_retained') && !row.batchId) return false;
  if (row.status === 'failed' && !row.batchId && !(row.failureCode === 'not_submitted' && row.unknownCharge === false)) return false;
  return true;
}

function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function validKnowledgeSelection(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 5) return false;
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
  for (const job of jobs) {
    if (ids.has(job.id)) throw new Error('OpenRouter Batch history failed integrity validation.');
    ids.add(job.id);
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
      ((job.sourceRemoved || ['completed', 'failed', 'expired', 'cancelled', 'result_stale', 'result_invalid', 'result_not_retained'].includes(job.status)) &&
        job.accounting?.providerReportedCostUsd === undefined))),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.noteId ? { noteId: job.noteId } : {}),
    ...(job.noteRevision !== undefined ? { noteRevision: job.noteRevision } : {}),
    model: job.model,
    effort: job.effort,
    ...(job.requestBytes !== undefined ? { requestBytes: job.requestBytes } : {}),
    ...(job.omittedSourceCount !== undefined ? { omittedSourceCount: job.omittedSourceCount } : {}),
    unknownCharge: job.unknownCharge,
    costStatus: job.accounting?.providerReportedCostUsd !== undefined ? 'reported' :
      ['completed', 'failed', 'expired', 'cancelled', 'result_invalid', 'result_stale', 'result_not_retained'].includes(job.status) ? 'unavailable' : 'waiting',
    billingScope: job.accounting?.byok ? 'byok_fee_only' : 'openrouter_reported',
    ...(job.accounting?.providerReportedCostUsd !== undefined ? { providerReportedCostUsd: job.accounting.providerReportedCostUsd } : {}),
    ...(job.accounting?.byok !== undefined ? { byok: job.accounting.byok } : {}),
    ...(job.accounting?.promptTokens !== undefined ? { promptTokens: job.accounting.promptTokens } : {}),
    ...(job.accounting?.completionTokens !== undefined ? { completionTokens: job.accounting.completionTokens } : {}),
    ...(job.accounting?.totalTokens !== undefined ? { totalTokens: job.accounting.totalTokens } : {}),
    ...(job.failureCode ? { failureCode: job.failureCode } : {}),
  });
}

export function isOpenRouterBatchContentJob(job: OpenRouterBatchJob): job is OpenRouterBatchContentJob {
  return job.sourceRemoved !== true && job.status !== 'source_removed' && typeof job.requestBody === 'string' &&
    typeof job.requestBytes === 'number' && typeof job.settingsFingerprint === 'string' &&
    typeof job.sourceFingerprint === 'string' && (job.requestProfileVersion === 1 || job.requestProfileVersion === 2) && !!job.sourceVersions;
}

export function tombstoneOpenRouterBatchJob(job: OpenRouterBatchJob, updatedAt: string): OpenRouterBatchTombstone {
  if (job.sourceRemoved) return job as OpenRouterBatchTombstone;
  return Object.freeze({
    id: job.id, customId: job.customId, kind: job.kind, sourceRemoved: true,
    status: 'source_removed', createdAt: job.createdAt, updatedAt,
    model: job.model, effort: job.effort, requestProfileVersion: job.requestProfileVersion ?? 1, requestSha256: job.requestSha256,
    ...(job.batchId ? { batchId: job.batchId } : {}),
    unknownCharge: job.unknownCharge,
    ...(job.accounting ? { accounting: job.accounting } : {}),
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
