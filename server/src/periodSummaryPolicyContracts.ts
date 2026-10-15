import { createHash } from 'node:crypto';
import { canonicalBackgroundJson, parseSaveBackgroundPolicyEnvelope, type BackgroundPeriodKind,
  type BackgroundPaidConsent, type BackgroundSourceSelection } from './backgroundContracts.js';

export type PeriodSummaryExecutionOptions = Readonly<{
  version: 2;
  emailText: Readonly<{ mode: 'complete_body' }> | Readonly<{ mode: 'available_extracted_email_text'; consentVersion: 1 }>;
  application: Readonly<{ mode: 'review' }> | Readonly<{ mode: 'automatic'; consentVersion: 1 }>;
}>;

export type LegacyPeriodSummaryPolicy = Readonly<{
  kind: 'period_summary';
  period: BackgroundPeriodKind;
  timeZone: string;
  localDeliveryTime?: string;
  sources: BackgroundSourceSelection;
  instructions: string;
  catchUp: 'ask' | 'latest' | 'all';
  paidConsent: BackgroundPaidConsent;
}>;

export type Version2PeriodSummaryPolicy = Readonly<{
  kind: 'period_summary';
  version: 2;
  period: BackgroundPeriodKind;
  timeZone: string;
  localDeliveryTime: string;
  sources: BackgroundSourceSelection;
  instructions: string;
  catchUp: 'ask' | 'latest' | 'all';
  paidConsent: BackgroundPaidConsent;
  executionOptions: PeriodSummaryExecutionOptions;
}>;

export type ParsedPeriodSummaryPolicy = Readonly<{
  version: 1;
  specification: LegacyPeriodSummaryPolicy;
  executionOptions: Readonly<{ version: 1; emailText: Readonly<{ mode: 'complete_body' }>;
    application: Readonly<{ mode: 'review' }> }>;
  canonicalJson: string;
  digest: string;
}> | Readonly<{
  version: 2;
  specification: Version2PeriodSummaryPolicy;
  executionOptions: PeriodSummaryExecutionOptions;
  canonicalJson: string;
  digest: string;
}>;

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = '00000000-0000-4000-8000-000000000001';

function invalid(): never { throw new TypeError('period_summary_policy_invalid'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) invalid();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
}
function cloneClosed<T>(value: T): T {
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') return item;
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1) return invalid();
      return Object.freeze(Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
        return copy(descriptor.value);
      }));
    }
    const source = record(item);
    const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== 'string') return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
      target[key] = copy(descriptor.value);
    }
    return Object.freeze(target);
  };
  return copy(value) as T;
}
function executionOptions(raw: unknown): PeriodSummaryExecutionOptions {
  const options = record(raw);
  exact(options, ['version', 'emailText', 'application']);
  if (options.version !== 2) return invalid();
  const emailText = record(options.emailText);
  const application = record(options.application);
  if (emailText.mode === 'complete_body') exact(emailText, ['mode']);
  else if (emailText.mode === 'available_extracted_email_text') {
    exact(emailText, ['mode', 'consentVersion']);
    if (emailText.consentVersion !== 1) return invalid();
  } else return invalid();
  if (application.mode === 'review') exact(application, ['mode']);
  else if (application.mode === 'automatic') {
    exact(application, ['mode', 'consentVersion']);
    if (application.consentVersion !== 1) return invalid();
  } else return invalid();
  return cloneClosed(options) as PeriodSummaryExecutionOptions;
}

/** Strict parser for both the byte-compatible legacy contract and explicit V2 consent options. */
export function parsePeriodSummaryPolicy(raw: unknown): ParsedPeriodSummaryPolicy {
  const closed = cloneClosed(raw);
  const value = record(closed);
  if (value.kind !== 'period_summary') return invalid();
  const version = value.version === undefined ? 1 : value.version;
  if (version === 1) {
    exact(value, ['kind', 'period', 'timeZone', 'sources', 'instructions', 'catchUp', 'paidConsent'], ['localDeliveryTime']);
    // The existing parser remains the authority for legacy field validation. Its normalized
    // defaults are deliberately discarded so old stored JSON and digests are not rewritten.
    const normalized = parseSaveBackgroundPolicyEnvelope({ commandId: UUID, expectedPrivacyEpoch: 0, policyId: UUID,
      expectedPolicyRevision: 1, enabled: false, specification: value }).specification;
    if (normalized.kind !== 'period_summary') return invalid();
    const canonicalJson = canonicalBackgroundJson(value);
    const specification = Object.freeze(value) as LegacyPeriodSummaryPolicy;
    return Object.freeze({ version: 1, specification,
      executionOptions: Object.freeze({ version: 1, emailText: Object.freeze({ mode: 'complete_body' }),
        application: Object.freeze({ mode: 'review' }) }), canonicalJson,
      digest: createHash('sha256').update(canonicalJson, 'utf8').digest('hex') });
  }
  if (version !== 2) return invalid();
  exact(value, ['kind', 'version', 'period', 'timeZone', 'localDeliveryTime', 'sources', 'instructions', 'catchUp', 'paidConsent', 'executionOptions']);
  const { version: _version, executionOptions: _options, ...legacyShape } = value;
  const normalized = parseSaveBackgroundPolicyEnvelope({ commandId: UUID, expectedPrivacyEpoch: 0, policyId: UUID,
    expectedPolicyRevision: 1, enabled: false, specification: legacyShape }).specification;
  if (normalized.kind !== 'period_summary' || value.localDeliveryTime !== normalized.localDeliveryTime) return invalid();
  const options = executionOptions(_options);
  const specification = Object.freeze({ ...normalized, version: 2 as const, executionOptions: options }) as Version2PeriodSummaryPolicy;
  const canonicalJson = canonicalBackgroundJson({ ...normalized, version: 2, executionOptions: options });
  return Object.freeze({ version: 2, specification, executionOptions: options, canonicalJson,
    digest: createHash('sha256').update(canonicalJson, 'utf8').digest('hex') });
}

/** A new policy revision is required whenever V2 execution consent changes. */
export function assertPeriodSummaryOptionsRevision(previous: ParsedPeriodSummaryPolicy, next: ParsedPeriodSummaryPolicy,
  previousRevision: number, nextRevision: number): void {
  if (!Number.isSafeInteger(previousRevision) || previousRevision < 1 || !Number.isSafeInteger(nextRevision) || nextRevision < 1) return invalid();
  const oldOptions = canonicalBackgroundJson(previous.executionOptions);
  const newOptions = canonicalBackgroundJson(next.executionOptions);
  if (oldOptions !== newOptions && nextRevision <= previousRevision) return invalid();
}

export function isPeriodSummaryDigest(value: unknown): value is string { return typeof value === 'string' && SHA256.test(value); }
