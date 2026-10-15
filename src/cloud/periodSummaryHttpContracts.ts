import type { PeriodSummaryResultReview } from '../core';
import { OPENROUTER_BATCH_RESPONSE_MAX_BYTES } from '../services/openRouter';

export type PeriodSummaryReadOwner = Readonly<{ expectedRevision: number; expectedPrivacyEpoch: number }>;
export type PeriodSummaryReadEnvelope = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  privacyEpoch: number;
  revision: number;
  review: PeriodSummaryResultReview;
}>;
export type PeriodSummaryApplicationPreviewEnvelope = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  privacyEpoch: number;
  revision: number;
  review: import('../core').PeriodSummaryApplicationPreview;
}>;

function record(value: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('period_summary_response_invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('period_summary_response_invalid');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('period_summary_response_invalid');
  }
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('period_summary_response_invalid');
  }
  return value as Record<string, unknown>;
}

function validUnicode(value: string): boolean {
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

function validLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function summaryIntervalMatches(period: unknown, start: unknown, end: unknown): boolean {
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(String(period)) || !validLocalDate(start) || !validLocalDate(end)) return false;
  const [year, month, day] = start.split('-').map(Number);
  if (period === 'yearly' && (month !== 1 || day !== 1)) return false;
  if (period === 'monthly' && day !== 1) return false;
  if (period === 'weekly') {
    const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
    if (date.getUTCDay() !== 1) return false;
  }
  const date = new Date(0);
  if (period === 'yearly') date.setUTCFullYear(year + 1, 0, 1);
  else if (period === 'monthly') date.setUTCFullYear(year, month, 1);
  else date.setUTCFullYear(year, month - 1, day + (period === 'weekly' ? 7 : 1));
  date.setUTCHours(0, 0, 0, 0);
  const next = `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  return end === next;
}

export function parsePeriodSummaryReadEnvelope(value: unknown, expected: Readonly<{ workspaceId: string; privacyEpoch: number; revision: number; jobId: string }>): PeriodSummaryReadEnvelope {
  const root = record(value, ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision', 'review'], ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision', 'review']);
  const review = record(root.review, ['jobId', 'period', 'timeZone', 'interval', 'preparedAt', 'markdown', 'sourceReferences'],
    ['jobId', 'period', 'timeZone', 'interval', 'preparedAt', 'markdown', 'sourceReferences']);
  const interval = record(review.interval, ['start', 'end'], ['start', 'end']);
  if (root.schemaVersion !== 1 || root.workspaceId !== expected.workspaceId || root.privacyEpoch !== expected.privacyEpoch ||
      root.revision !== expected.revision || review.jobId !== expected.jobId ||
      !['daily', 'weekly', 'monthly', 'yearly'].includes(String(review.period)) ||
      typeof review.timeZone !== 'string' || review.timeZone.length > 128 || !validUnicode(review.timeZone) ||
      !Number.isFinite(Date.parse(review.preparedAt as string)) || new Date(review.preparedAt as string).toISOString() !== review.preparedAt ||
      !summaryIntervalMatches(review.period, interval.start, interval.end) ||
      typeof review.markdown !== 'string' || !review.markdown.trim() || !validUnicode(review.markdown) ||
      new TextEncoder().encode(review.markdown).byteLength > OPENROUTER_BATCH_RESPONSE_MAX_BYTES || !Array.isArray(review.sourceReferences) ||
      review.sourceReferences.some((item) => typeof item !== 'string' || !item.trim() || !validUnicode(item))) {
    throw new Error('period_summary_response_invalid');
  }
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision,
    review: Object.freeze({ jobId: expected.jobId, period: review.period as PeriodSummaryResultReview['period'], timeZone: review.timeZone as string,
      interval: Object.freeze({ start: interval.start as string, end: interval.end as string }), preparedAt: review.preparedAt as string, markdown: review.markdown,
      sourceReferences: Object.freeze([...(review.sourceReferences as string[])]) }) });
}

export function periodSummaryResultPath(jobId: string, owner: PeriodSummaryReadOwner): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId) ||
      !Number.isSafeInteger(owner.expectedRevision) || owner.expectedRevision < 0 ||
      !Number.isSafeInteger(owner.expectedPrivacyEpoch) || owner.expectedPrivacyEpoch < 0) throw new Error('period_summary_read_owner_invalid');
  const query = new URLSearchParams({ jobId, expectedRevision: String(owner.expectedRevision), expectedPrivacyEpoch: String(owner.expectedPrivacyEpoch) });
  return `/api/workspace/assistant/period-summary/result?${query.toString()}`;
}

export function parsePeriodSummaryApplicationPreviewEnvelope(value: unknown, expected: Readonly<{
  workspaceId: string; privacyEpoch: number; revision: number; planId: string; jobId: string;
}>): PeriodSummaryApplicationPreviewEnvelope {
  const root = record(value, ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision', 'review'], ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision', 'review']);
  const review = record(root.review, ['planId', 'jobId', 'period', 'timeZone', 'interval', 'preparedAt', 'markdown', 'sourceReferences'],
    ['planId', 'jobId', 'period', 'timeZone', 'interval', 'preparedAt', 'markdown', 'sourceReferences']);
  const interval = record(review.interval, ['start', 'end'], ['start', 'end']);
  if (root.schemaVersion !== 1 || root.workspaceId !== expected.workspaceId || root.privacyEpoch !== expected.privacyEpoch ||
      root.revision !== expected.revision || review.planId !== expected.planId || review.jobId !== expected.jobId ||
      !['daily', 'weekly', 'monthly', 'yearly'].includes(String(review.period)) ||
      typeof review.timeZone !== 'string' || !review.timeZone.length || review.timeZone.length > 128 || !validUnicode(review.timeZone) ||
      typeof review.preparedAt !== 'string' || !Number.isFinite(Date.parse(review.preparedAt)) || new Date(review.preparedAt).toISOString() !== review.preparedAt ||
      !summaryIntervalMatches(review.period, interval.start, interval.end) ||
      typeof review.markdown !== 'string' || !review.markdown.trim() || !validUnicode(review.markdown) ||
      new TextEncoder().encode(review.markdown).byteLength > OPENROUTER_BATCH_RESPONSE_MAX_BYTES || !Array.isArray(review.sourceReferences) ||
      review.sourceReferences.some((item) => typeof item !== 'string' || !item.trim() || !validUnicode(item))) {
    throw new Error('period_summary_response_invalid');
  }
  // The server's physical workflow-read bound is the same 16 MiB aggregate used by
  // the retained provider result; avoid narrower UI-only count/label quotas here.
  try { new Intl.DateTimeFormat('en-US', { timeZone: review.timeZone }).format(0); } catch { throw new Error('period_summary_response_invalid'); }
  const serializedBytes = new TextEncoder().encode(JSON.stringify(root)).byteLength;
  if (serializedBytes > OPENROUTER_BATCH_RESPONSE_MAX_BYTES) throw new Error('period_summary_response_invalid');
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision,
    review: Object.freeze({ planId: expected.planId, jobId: expected.jobId, period: review.period as import('../core').PeriodSummaryApplicationPreview['period'],
      timeZone: review.timeZone as string, interval: Object.freeze({ start: interval.start as string, end: interval.end as string }), preparedAt: review.preparedAt as string,
      markdown: review.markdown, sourceReferences: Object.freeze([...(review.sourceReferences as string[])]) }) });
}

export function periodSummaryApplicationPreviewPath(planId: string, jobId: string, owner: PeriodSummaryReadOwner): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(planId) || !uuid.test(jobId) || !Number.isSafeInteger(owner.expectedRevision) || owner.expectedRevision < 0 ||
      !Number.isSafeInteger(owner.expectedPrivacyEpoch) || owner.expectedPrivacyEpoch < 0) throw new Error('period_summary_read_owner_invalid');
  return `/api/workspace/assistant/period-summary/application/preview?${new URLSearchParams({ planId, jobId,
    expectedRevision: String(owner.expectedRevision), expectedPrivacyEpoch: String(owner.expectedPrivacyEpoch) }).toString()}`;
}
