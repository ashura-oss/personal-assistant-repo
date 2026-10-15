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
      typeof interval.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(interval.start) ||
      typeof interval.end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(interval.end) ||
      typeof review.markdown !== 'string' || !review.markdown.trim() || !validUnicode(review.markdown) ||
      new TextEncoder().encode(review.markdown).byteLength > OPENROUTER_BATCH_RESPONSE_MAX_BYTES || !Array.isArray(review.sourceReferences) ||
      review.sourceReferences.some((item) => typeof item !== 'string' || !item.trim() || !validUnicode(item))) {
    throw new Error('period_summary_response_invalid');
  }
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision,
    review: Object.freeze({ jobId: expected.jobId, period: review.period as PeriodSummaryResultReview['period'], timeZone: review.timeZone as string,
      interval: Object.freeze({ start: interval.start, end: interval.end }), preparedAt: review.preparedAt as string, markdown: review.markdown,
      sourceReferences: Object.freeze([...(review.sourceReferences as string[])]) }) });
}

export function periodSummaryResultPath(jobId: string, owner: PeriodSummaryReadOwner): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId) ||
      !Number.isSafeInteger(owner.expectedRevision) || owner.expectedRevision < 0 ||
      !Number.isSafeInteger(owner.expectedPrivacyEpoch) || owner.expectedPrivacyEpoch < 0) throw new Error('period_summary_read_owner_invalid');
  const query = new URLSearchParams({ jobId, expectedRevision: String(owner.expectedRevision), expectedPrivacyEpoch: String(owner.expectedPrivacyEpoch) });
  return `/api/workspace/assistant/period-summary/result?${query.toString()}`;
}
