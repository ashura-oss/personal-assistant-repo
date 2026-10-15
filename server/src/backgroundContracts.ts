/** Browser-safe value contracts shared by the trusted background-policy store and later UI codecs. */
export const BACKGROUND_CONTRACT_VERSION = 1 as const;
export const BACKGROUND_REQUEST_MAX_BYTES = 1024 * 1024;
export const BACKGROUND_PRIVATE_ROW_MAX_BYTES = 16 * 1024 * 1024;
export const BACKGROUND_PUBLIC_PAGE_MAX = 100;

export type BackgroundPeriodKind = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type BackgroundPolicyKind = 'account_sync' | 'period_summary' | 'proactive_draft' | 'approved_reminder_delivery';
export type BackgroundAccountSelection = Readonly<{ accountId: string; expectedConnectionGeneration: number }>;
export type BackgroundSourceSelection = Readonly<{
  notes: boolean;
  chat: boolean;
  tasks: boolean;
  decisions: boolean;
  acceptedInferences: boolean;
  mailAccounts: readonly BackgroundAccountSelection[];
  calendarAccounts: readonly BackgroundAccountSelection[];
  documentPaths: readonly string[];
  knowledge: readonly Readonly<{ kind: 'person' | 'project'; id: string }> [];
}>;
export type BackgroundPaidConsent = Readonly<{
  authorized: true;
  model: 'openai/gpt-6-luna:batch';
  effort: 'none' | 'low';
}>;
export type BackgroundReminderDevices = 'all_current' | Readonly<{ subscriptionIds: readonly string[] }>;

export type BackgroundPolicySpecification =
  | Readonly<{
      kind: 'account_sync';
      accounts: readonly BackgroundAccountSelection[];
      resources: readonly ('mail' | 'calendars')[];
      intervalMinutes: number;
    }>
  | Readonly<{
      kind: 'period_summary';
      period: BackgroundPeriodKind;
      timeZone: string;
      localDeliveryTime: string;
      sources: BackgroundSourceSelection;
      instructions: string;
      catchUp: 'ask' | 'latest' | 'all';
      paidConsent: BackgroundPaidConsent;
    }>
  | Readonly<{
      kind: 'proactive_draft';
      ruleId: string;
      expectedRuleRevision: number;
      accounts: readonly BackgroundAccountSelection[];
      sourceChangePolicy: 'first_match_only' | 'each_changed_source';
      brief: string;
      replyMode: 'reply' | 'reply_all';
      paidConsent: BackgroundPaidConsent;
    }>
  | Readonly<{
      kind: 'approved_reminder_delivery';
      reminderId: string;
      expectedReminderRevision: number;
      channel: 'web_push';
      devices: BackgroundReminderDevices;
    }>;

export interface SaveBackgroundPolicyEnvelope {
  readonly commandId: string;
  readonly expectedPrivacyEpoch: number;
  readonly policyId: string;
  readonly expectedPolicyRevision: number;
  readonly enabled: boolean;
  readonly specification: BackgroundPolicySpecification;
}

export interface ChangeBackgroundPolicyEnvelope {
  readonly commandId: string;
  readonly expectedPrivacyEpoch: number;
  readonly policyId: string;
  readonly expectedPolicyRevision: number;
}

export type BackgroundPolicyStatus = 'enabled' | 'paused' | 'revoked' | 'suspended';
export type BackgroundPolicySuspension = 'account_changed' | 'rule_changed' | 'reminder_changed' | 'reauthorization_required';
export interface BackgroundPolicyReceipt {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly operation: 'save' | 'pause' | 'revoke';
  readonly policyId: string;
  readonly policyRevision: number;
  readonly status: BackgroundPolicyStatus;
  readonly effectiveFrom: number;
}
export interface BackgroundAccountDisplay {
  readonly accountId: string;
  readonly provider: 'google' | 'microsoft';
  readonly label: string;
  readonly connectionGeneration: number;
  readonly connected: boolean;
}
export interface BackgroundPolicyDisplay {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly revision: number;
  readonly status: BackgroundPolicyStatus;
  readonly enabled: boolean;
  readonly specification: BackgroundPolicySpecification;
  readonly accounts: readonly BackgroundAccountDisplay[];
  readonly suspension?: BackgroundPolicySuspension;
  readonly effectiveFrom: number;
  readonly updatedAt: number;
}

export type BackgroundOccurrenceStatus = 'scheduled' | 'claimed' | 'dispatching' | 'completed' | 'unknown' | 'inspect_required' | 'suppressed';
export type BackgroundAccounting = Readonly<{ status: 'unknown' | 'not_applicable' }> | Readonly<{
  status: 'reported';
  unknownCharge: boolean;
  providerReportedCostUsd?: number;
  byok?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}>;
export interface BackgroundOccurrenceDisplay {
  readonly schemaVersion: 1;
  readonly occurrenceId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyKind: BackgroundPolicyKind;
  readonly status: BackgroundOccurrenceStatus;
  readonly scheduledAt: number;
  readonly actualAt?: number;
  readonly batchJobId?: string;
  readonly accounting: BackgroundAccounting;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UUID_V1_TO_8 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PERIODS = new Set<unknown>(['daily', 'weekly', 'monthly', 'yearly']);
const ENCODER = new TextEncoder();

function isBackgroundPeriod(value: unknown): value is BackgroundPeriodKind { return PERIODS.has(value); }

function invalid(): never { throw new TypeError('background_policy_invalid'); }
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) invalid();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
}
function string(value: unknown, maxBytes: number, allowNewlines = false): string {
  if (typeof value !== 'string' || value.length === 0 || ENCODER.encode(value).byteLength > maxBytes ||
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value) ||
      (allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : CONTROL).test(value)) invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function uuidV4(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) invalid();
  return value;
}
function canonicalUuid(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_UUID_V1_TO_8.test(value)) invalid();
  return value;
}
function opaqueId(value: unknown): string { return string(value, 1024); }
function uniqueArray<T>(value: unknown, parse: (item: unknown) => T, min = 0): readonly T[] {
  if (!Array.isArray(value) || value.length < min) invalid();
  const output: T[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    const item = parse(descriptor.value);
    const key = typeof item === 'string' ? item : JSON.stringify(item);
    if (keys.has(key)) invalid();
    keys.add(key);
    output.push(item);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) invalid();
  return Object.freeze(output);
}
function parseSources(raw: unknown): BackgroundSourceSelection {
  if (!plainRecord(raw)) return invalid();
  exactKeys(raw, ['notes', 'chat', 'tasks', 'decisions', 'acceptedInferences', 'mailAccounts', 'calendarAccounts', 'documentPaths', 'knowledge']);
  const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') invalid(); return v; };
  const documentPaths = uniqueArray(raw.documentPaths, (item) => {
    const path = string(item, 1024);
    if (!path.endsWith('.md') || path.startsWith('/') || path.includes('\\') || /[:?#%<>|"*]/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) invalid();
    return path;
  });
  const knowledge = uniqueArray(raw.knowledge, (item) => {
    if (!plainRecord(item)) return invalid();
    exactKeys(item, ['kind', 'id']);
    if (item.kind !== 'person' && item.kind !== 'project') invalid();
    return Object.freeze({ kind: item.kind, id: canonicalUuid(item.id) });
  });
  const accountSelection = (item: unknown): BackgroundAccountSelection => {
    if (!plainRecord(item)) return invalid();
    exactKeys(item, ['accountId', 'expectedConnectionGeneration']);
    return Object.freeze({ accountId: opaqueId(item.accountId), expectedConnectionGeneration: integer(item.expectedConnectionGeneration, 1) });
  };
  return Object.freeze({ notes: bool(raw.notes), chat: bool(raw.chat), tasks: bool(raw.tasks), decisions: bool(raw.decisions),
    acceptedInferences: bool(raw.acceptedInferences), mailAccounts: uniqueArray(raw.mailAccounts, accountSelection),
    calendarAccounts: uniqueArray(raw.calendarAccounts, accountSelection), documentPaths, knowledge });
}
function parseAccountSelection(item: unknown): BackgroundAccountSelection {
  if (!plainRecord(item)) return invalid();
  exactKeys(item, ['accountId', 'expectedConnectionGeneration']);
  return Object.freeze({ accountId: opaqueId(item.accountId), expectedConnectionGeneration: integer(item.expectedConnectionGeneration, 1) });
}
function parsePaidConsent(raw: unknown): BackgroundPaidConsent {
  if (!plainRecord(raw)) return invalid();
  exactKeys(raw, ['authorized', 'model', 'effort']);
  if (raw.authorized !== true || raw.model !== 'openai/gpt-6-luna:batch' || (raw.effort !== 'none' && raw.effort !== 'low')) invalid();
  return Object.freeze({ authorized: true, model: 'openai/gpt-6-luna:batch', effort: raw.effort });
}
function parseSpecification(raw: unknown): BackgroundPolicySpecification {
  if (!plainRecord(raw) || typeof raw.kind !== 'string') return invalid();
  if (raw.kind === 'account_sync') {
    exactKeys(raw, ['kind', 'accounts', 'resources'], ['intervalMinutes']);
    const accounts = uniqueArray(raw.accounts, parseAccountSelection, 1);
    const resources = uniqueArray(raw.resources, (item) => {
      if (item !== 'mail' && item !== 'calendars') invalid();
      return item;
    }, 1);
    return Object.freeze({ kind: 'account_sync', accounts, resources,
      intervalMinutes: raw.intervalMinutes === undefined ? 5 : integer(raw.intervalMinutes, 1, 1440) });
  }
  if (raw.kind === 'period_summary') {
    exactKeys(raw, ['kind', 'period', 'timeZone', 'sources', 'instructions', 'catchUp', 'paidConsent'], ['localDeliveryTime']);
    if (!isBackgroundPeriod(raw.period)) invalid();
    const timeZone = string(raw.timeZone, 100);
    if (/^[+-]/.test(timeZone)) invalid();
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); } catch { return invalid(); }
    const localDeliveryTime = raw.localDeliveryTime === undefined ? '08:00' : string(raw.localDeliveryTime, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localDeliveryTime)) invalid();
    if (raw.catchUp !== 'ask' && raw.catchUp !== 'latest' && raw.catchUp !== 'all') invalid();
    return Object.freeze({ kind: 'period_summary', period: raw.period, timeZone, localDeliveryTime,
      sources: parseSources(raw.sources), instructions: string(raw.instructions, BACKGROUND_REQUEST_MAX_BYTES, true), catchUp: raw.catchUp,
      paidConsent: parsePaidConsent(raw.paidConsent) });
  }
  if (raw.kind === 'proactive_draft') {
    exactKeys(raw, ['kind', 'ruleId', 'expectedRuleRevision', 'accounts', 'brief', 'replyMode', 'paidConsent'], ['sourceChangePolicy']);
    const sourceChangePolicy = raw.sourceChangePolicy === undefined ? 'first_match_only' : raw.sourceChangePolicy;
    if (sourceChangePolicy !== 'first_match_only' && sourceChangePolicy !== 'each_changed_source') invalid();
    if (raw.replyMode !== 'reply' && raw.replyMode !== 'reply_all') invalid();
    return Object.freeze({ kind: 'proactive_draft', ruleId: opaqueId(raw.ruleId), expectedRuleRevision: integer(raw.expectedRuleRevision, 1),
      accounts: uniqueArray(raw.accounts, parseAccountSelection, 1), sourceChangePolicy, brief: string(raw.brief, BACKGROUND_REQUEST_MAX_BYTES, true),
      replyMode: raw.replyMode, paidConsent: parsePaidConsent(raw.paidConsent) });
  }
  if (raw.kind === 'approved_reminder_delivery') {
    exactKeys(raw, ['kind', 'reminderId', 'expectedReminderRevision', 'channel', 'devices']);
    if (raw.channel !== 'web_push') invalid();
    let devices: BackgroundReminderDevices;
    if (raw.devices === 'all_current') devices = 'all_current';
    else {
      if (!plainRecord(raw.devices)) return invalid();
      exactKeys(raw.devices, ['subscriptionIds']);
      devices = Object.freeze({ subscriptionIds: uniqueArray(raw.devices.subscriptionIds, uuidV4, 1) });
    }
    return Object.freeze({ kind: 'approved_reminder_delivery', reminderId: opaqueId(raw.reminderId),
      expectedReminderRevision: integer(raw.expectedReminderRevision, 1), channel: 'web_push', devices });
  }
  return invalid();
}

export function parseSaveBackgroundPolicyEnvelope(raw: unknown): SaveBackgroundPolicyEnvelope {
  if (!plainRecord(raw)) return invalid();
  canonicalBackgroundJson(raw, BACKGROUND_REQUEST_MAX_BYTES);
  exactKeys(raw, ['commandId', 'expectedPrivacyEpoch', 'policyId', 'expectedPolicyRevision', 'enabled', 'specification']);
  if (typeof raw.enabled !== 'boolean') invalid();
  return Object.freeze({ commandId: uuidV4(raw.commandId), expectedPrivacyEpoch: integer(raw.expectedPrivacyEpoch),
    policyId: uuidV4(raw.policyId), expectedPolicyRevision: integer(raw.expectedPolicyRevision), enabled: raw.enabled,
    specification: parseSpecification(raw.specification) });
}

function parseChangeEnvelope(raw: unknown): ChangeBackgroundPolicyEnvelope {
  if (!plainRecord(raw)) return invalid();
  canonicalBackgroundJson(raw, BACKGROUND_REQUEST_MAX_BYTES);
  exactKeys(raw, ['commandId', 'expectedPrivacyEpoch', 'policyId', 'expectedPolicyRevision']);
  return Object.freeze({ commandId: uuidV4(raw.commandId), expectedPrivacyEpoch: integer(raw.expectedPrivacyEpoch),
    policyId: uuidV4(raw.policyId), expectedPolicyRevision: integer(raw.expectedPolicyRevision, 1) });
}
export const parsePauseBackgroundPolicyEnvelope = parseChangeEnvelope;
export const parseRevokeBackgroundPolicyEnvelope = parseChangeEnvelope;

export function canonicalBackgroundJson(value: unknown, maximumBytes = BACKGROUND_REQUEST_MAX_BYTES): string {
  const ancestors = new Set<object>();
  const clean = (item: unknown): unknown => {
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(item)) invalid();
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
    if (Array.isArray(item)) {
      if (ancestors.has(item)) invalid();
      ancestors.add(item);
      try {
        if (Reflect.ownKeys(item).length !== item.length + 1 ||
            Reflect.ownKeys(item).some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) invalid();
        return Array.from({ length: item.length }, (_, index) => {
          if (!Object.hasOwn(item, index)) invalid();
          return clean(item[index]);
        });
      } finally { ancestors.delete(item); }
    }
    if (!plainRecord(item)) return invalid();
    if (ancestors.has(item)) invalid();
    ancestors.add(item);
    try {
      if (Reflect.ownKeys(item).some((key) => typeof key !== 'string')) invalid();
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        output[key] = clean(item[key]);
      }
      return output;
    } finally { ancestors.delete(item); }
  };
  const json = JSON.stringify(clean(value));
  if (typeof json !== 'string' || ENCODER.encode(json).byteLength > maximumBytes) invalid();
  return json;
}

export function parseBackgroundSpecification(raw: unknown): BackgroundPolicySpecification {
  canonicalBackgroundJson(raw, BACKGROUND_REQUEST_MAX_BYTES);
  const normalized = parseSpecification(raw);
  canonicalBackgroundJson(normalized);
  return normalized;
}

function parsePolicyStatus(value: unknown): BackgroundPolicyStatus {
  if (value !== 'enabled' && value !== 'paused' && value !== 'revoked' && value !== 'suspended') invalid();
  return value;
}
function parsePolicySuspension(value: unknown): BackgroundPolicySuspension {
  if (value !== 'account_changed' && value !== 'rule_changed' && value !== 'reminder_changed' && value !== 'reauthorization_required') invalid();
  return value;
}
export function parseBackgroundPolicyReceipt(raw: unknown): BackgroundPolicyReceipt {
  if (!plainRecord(raw)) return invalid();
  canonicalBackgroundJson(raw, BACKGROUND_REQUEST_MAX_BYTES);
  exactKeys(raw, ['schemaVersion', 'commandId', 'operation', 'policyId', 'policyRevision', 'status', 'effectiveFrom']);
  if (raw.schemaVersion !== 1 || (raw.operation !== 'save' && raw.operation !== 'pause' && raw.operation !== 'revoke')) invalid();
  return Object.freeze({ schemaVersion: 1, commandId: uuidV4(raw.commandId), operation: raw.operation,
    policyId: uuidV4(raw.policyId), policyRevision: integer(raw.policyRevision, 1), status: parsePolicyStatus(raw.status), effectiveFrom: integer(raw.effectiveFrom) });
}
export function parseBackgroundPolicyDisplay(raw: unknown): BackgroundPolicyDisplay {
  if (!plainRecord(raw)) return invalid();
  canonicalBackgroundJson(raw, BACKGROUND_REQUEST_MAX_BYTES);
  exactKeys(raw, ['schemaVersion', 'policyId', 'revision', 'status', 'enabled', 'specification', 'accounts', 'effectiveFrom', 'updatedAt'], ['suspension']);
  if (raw.schemaVersion !== 1 || typeof raw.enabled !== 'boolean') invalid();
  const accounts = uniqueArray(raw.accounts, (item): BackgroundAccountDisplay => {
    if (!plainRecord(item)) return invalid();
    exactKeys(item, ['accountId', 'provider', 'label', 'connectionGeneration', 'connected']);
    if (item.provider !== 'google' && item.provider !== 'microsoft' || typeof item.connected !== 'boolean') invalid();
    return Object.freeze({ accountId: opaqueId(item.accountId), provider: item.provider, label: string(item.label, 1024),
      connectionGeneration: integer(item.connectionGeneration, 1), connected: item.connected });
  });
  const suspension = raw.suspension === undefined ? undefined : parsePolicySuspension(raw.suspension);
  return Object.freeze({ schemaVersion: 1, policyId: uuidV4(raw.policyId), revision: integer(raw.revision, 1), status: parsePolicyStatus(raw.status),
    enabled: raw.enabled, specification: parseSpecification(raw.specification), accounts, ...(suspension ? { suspension } : {}),
    effectiveFrom: integer(raw.effectiveFrom), updatedAt: integer(raw.updatedAt) });
}
export function parseBackgroundOccurrenceDisplay(raw: unknown): BackgroundOccurrenceDisplay {
  if (!plainRecord(raw)) return invalid();
  canonicalBackgroundJson(raw, BACKGROUND_REQUEST_MAX_BYTES);
  exactKeys(raw, ['schemaVersion', 'occurrenceId', 'policyId', 'policyRevision', 'policyKind', 'status', 'scheduledAt', 'accounting', 'createdAt', 'updatedAt'],
    ['actualAt', 'batchJobId']);
  if (raw.schemaVersion !== 1 || !['account_sync', 'period_summary', 'proactive_draft', 'approved_reminder_delivery'].includes(String(raw.policyKind)) ||
      !['scheduled', 'claimed', 'dispatching', 'completed', 'unknown', 'inspect_required', 'suppressed'].includes(String(raw.status))) invalid();
  const rawAccounting = raw.accounting;
  let cleanAccounting: BackgroundAccounting;
  if (!plainRecord(rawAccounting)) return invalid();
  if (rawAccounting.status === 'unknown' || rawAccounting.status === 'not_applicable') {
    exactKeys(rawAccounting, ['status']);
    cleanAccounting = Object.freeze({ status: rawAccounting.status });
  } else {
    exactKeys(rawAccounting, ['status', 'unknownCharge'], ['providerReportedCostUsd', 'byok', 'promptTokens', 'completionTokens', 'totalTokens']);
    if (rawAccounting.status !== 'reported' || typeof rawAccounting.unknownCharge !== 'boolean') invalid();
    const cost = rawAccounting.providerReportedCostUsd;
    if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) invalid();
    if (rawAccounting.unknownCharge !== (cost === undefined)) invalid();
    if (rawAccounting.byok !== undefined && typeof rawAccounting.byok !== 'boolean') invalid();
    const tokens = ['promptTokens', 'completionTokens', 'totalTokens'] as const;
    for (const key of tokens) if (rawAccounting[key] !== undefined) integer(rawAccounting[key]);
    if (cost === undefined && rawAccounting.byok === undefined && tokens.every((key) => rawAccounting[key] === undefined)) invalid();
    cleanAccounting = Object.freeze({ status: 'reported', unknownCharge: rawAccounting.unknownCharge,
      ...(cost === undefined ? {} : { providerReportedCostUsd: cost }), ...(rawAccounting.byok === undefined ? {} : { byok: rawAccounting.byok }),
      ...(rawAccounting.promptTokens === undefined ? {} : { promptTokens: rawAccounting.promptTokens as number }),
      ...(rawAccounting.completionTokens === undefined ? {} : { completionTokens: rawAccounting.completionTokens as number }),
      ...(rawAccounting.totalTokens === undefined ? {} : { totalTokens: rawAccounting.totalTokens as number }) });
  }
  return Object.freeze({ schemaVersion: 1, occurrenceId: uuidV4(raw.occurrenceId), policyId: uuidV4(raw.policyId), policyRevision: integer(raw.policyRevision, 1),
    policyKind: raw.policyKind as BackgroundPolicyKind, status: raw.status as BackgroundOccurrenceStatus, scheduledAt: integer(raw.scheduledAt),
    ...(raw.actualAt === undefined ? {} : { actualAt: integer(raw.actualAt) }), ...(raw.batchJobId === undefined ? {} : { batchJobId: uuidV4(raw.batchJobId) }),
    accounting: cleanAccounting, createdAt: integer(raw.createdAt), updatedAt: integer(raw.updatedAt) });
}

export function isBackgroundUuidV4(value: unknown): value is string { return typeof value === 'string' && UUID_V4.test(value); }
export function isCanonicalBackgroundUuid(value: unknown): value is string { return typeof value === 'string' && CANONICAL_UUID_V1_TO_8.test(value); }
