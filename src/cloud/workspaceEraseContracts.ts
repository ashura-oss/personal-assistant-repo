/** Closed browser projections for owner-authenticated workspace erasure. */
export type WorkspaceEraseCounts = Readonly<{ notes: number; documents: number; accounts: number; proposals: number;
  audioUploads: number; backgroundPolicies: number }>;
export type WorkspaceErasePlan = Readonly<{ schemaVersion: 1; commandId: string; expectedRevision: number;
  expectedPrivacyEpoch: number; expiresAt: string; counts: WorkspaceEraseCounts; status: 'prepared' | 'confirmed' }>;
export type WorkspaceEraseReceipt = Readonly<{ schemaVersion: 1; commandId: string; status: 'cleanup_pending' | 'complete';
  erasedPrivacyEpoch: number; currentPrivacyEpoch: number; createdAt: string }>;
export type WorkspaceEraseHold = Readonly<{ commandId: string; status: 'draining' | 'drain_failed' | 'drained';
  expectedRevision: number; expectedPrivacyEpoch: number }>;
export type WorkspaceEraseCancellation = Readonly<{ schemaVersion: 1; commandId: string; status: 'cancelled';
  privacyEpoch: number; cancelledAt: string }>;
export type WorkspaceEraseStatus = Readonly<{ schemaVersion: 1; status: 'none'; hold?: WorkspaceEraseHold }> |
  Readonly<{ schemaVersion: 1; status: 'prepared' | 'confirmed'; plan: WorkspaceErasePlan; hold?: WorkspaceEraseHold }> |
  Readonly<{ schemaVersion: 1; status: 'cleanup_pending' | 'complete'; receipt: WorkspaceEraseReceipt }> |
  Readonly<{ schemaVersion: 1; status: 'cancelled'; cancellation: WorkspaceEraseCancellation; hold?: WorkspaceEraseHold }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNT_KEYS = ['notes', 'documents', 'accounts', 'proposals', 'audioUploads', 'backgroundPolicies'] as const;
type RecordValue = Record<string, unknown>;

function recordHeader(value: unknown, keys: readonly string[], code: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error(code);
  const result = value as RecordValue;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(code);
  }
  if (!Object.hasOwn(result, 'schemaVersion') || !Object.hasOwn(result, 'status')) throw new Error(code);
  return result;
}

function record(value: unknown, keys: readonly string[], code: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error(code);
  const result = value as RecordValue;
  for (const key of keys) {
    if (!Object.hasOwn(result, key)) throw new Error(code);
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(code);
  }
  return result;
}
function generation(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function commandId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }

export function parseWorkspaceEraseCounts(value: unknown): WorkspaceEraseCounts {
  const source = record(value, COUNT_KEYS, 'workspace_erase_counts_invalid');
  for (const key of COUNT_KEYS) if (!generation(source[key])) throw new Error('workspace_erase_counts_invalid');
  return Object.freeze({ notes: source.notes as number, documents: source.documents as number, accounts: source.accounts as number,
    proposals: source.proposals as number, audioUploads: source.audioUploads as number, backgroundPolicies: source.backgroundPolicies as number });
}

export function parseWorkspaceErasePlan(value: unknown): WorkspaceErasePlan {
  const source = record(value, ['schemaVersion', 'commandId', 'expectedRevision', 'expectedPrivacyEpoch', 'expiresAt', 'counts', 'status'], 'workspace_erase_plan_invalid');
  if (source.schemaVersion !== 1 || !commandId(source.commandId) || !generation(source.expectedRevision) || !generation(source.expectedPrivacyEpoch) ||
      !timestamp(source.expiresAt) || (source.status !== 'prepared' && source.status !== 'confirmed')) throw new Error('workspace_erase_plan_invalid');
  return Object.freeze({ schemaVersion: 1, commandId: source.commandId, expectedRevision: source.expectedRevision,
    expectedPrivacyEpoch: source.expectedPrivacyEpoch, expiresAt: source.expiresAt, counts: parseWorkspaceEraseCounts(source.counts), status: source.status });
}

export function parseWorkspaceEraseReceipt(value: unknown): WorkspaceEraseReceipt {
  const source = record(value, ['schemaVersion', 'commandId', 'status', 'erasedPrivacyEpoch', 'currentPrivacyEpoch', 'createdAt'], 'workspace_erase_receipt_invalid');
  if (source.schemaVersion !== 1 || !commandId(source.commandId) || (source.status !== 'cleanup_pending' && source.status !== 'complete') ||
      !generation(source.erasedPrivacyEpoch) || !generation(source.currentPrivacyEpoch) || source.erasedPrivacyEpoch === Number.MAX_SAFE_INTEGER ||
      source.currentPrivacyEpoch !== source.erasedPrivacyEpoch + 1 ||
      !timestamp(source.createdAt)) throw new Error('workspace_erase_receipt_invalid');
  return Object.freeze({ schemaVersion: 1, commandId: source.commandId, status: source.status,
    erasedPrivacyEpoch: source.erasedPrivacyEpoch, currentPrivacyEpoch: source.currentPrivacyEpoch, createdAt: source.createdAt });
}

export function parseWorkspaceEraseHold(value: unknown): WorkspaceEraseHold {
  const source = record(value, ['commandId', 'status', 'expectedRevision', 'expectedPrivacyEpoch'], 'workspace_erase_hold_invalid');
  if (!commandId(source.commandId) || !['draining', 'drain_failed', 'drained'].includes(source.status as string) ||
      !generation(source.expectedRevision) || !generation(source.expectedPrivacyEpoch)) throw new Error('workspace_erase_hold_invalid');
  return Object.freeze({ commandId: source.commandId, status: source.status as WorkspaceEraseHold['status'],
    expectedRevision: source.expectedRevision, expectedPrivacyEpoch: source.expectedPrivacyEpoch });
}

export function parseWorkspaceEraseCancellation(value: unknown): WorkspaceEraseCancellation {
  const source = record(value, ['schemaVersion', 'commandId', 'status', 'privacyEpoch', 'cancelledAt'], 'workspace_erase_cancellation_invalid');
  if (source.schemaVersion !== 1 || !commandId(source.commandId) || source.status !== 'cancelled' || !generation(source.privacyEpoch) ||
      !timestamp(source.cancelledAt)) throw new Error('workspace_erase_cancellation_invalid');
  return Object.freeze({ schemaVersion: 1, commandId: source.commandId, status: 'cancelled', privacyEpoch: source.privacyEpoch, cancelledAt: source.cancelledAt });
}

export function parseWorkspaceEraseStatus(value: unknown): WorkspaceEraseStatus {
  const raw = recordHeader(value, ['schemaVersion', 'status', 'plan', 'hold', 'receipt', 'cancellation'], 'workspace_erase_status_invalid');
  if (raw.schemaVersion !== 1 || typeof raw.status !== 'string') throw new Error('workspace_erase_status_invalid');
  if (raw.status === 'none') {
    const hasHold = Object.hasOwn(raw, 'hold');
    const source = record(value, hasHold ? ['schemaVersion', 'status', 'hold'] : ['schemaVersion', 'status'], 'workspace_erase_status_invalid');
    return Object.freeze({ schemaVersion: 1, status: 'none', ...(!hasHold ? {} : { hold: parseWorkspaceEraseHold(source.hold) }) });
  }
  if (raw.status === 'prepared' || raw.status === 'confirmed') {
    const hasHold = Object.hasOwn(raw, 'hold');
    const source = record(value, hasHold ? ['schemaVersion', 'status', 'plan', 'hold'] : ['schemaVersion', 'status', 'plan'], 'workspace_erase_status_invalid');
    const plan = parseWorkspaceErasePlan(source.plan);
    if (plan.status !== raw.status) throw new Error('workspace_erase_status_invalid');
    const hold = source.hold === undefined ? undefined : parseWorkspaceEraseHold(source.hold);
    if (hold && (hold.commandId !== plan.commandId || hold.expectedRevision !== plan.expectedRevision || hold.expectedPrivacyEpoch !== plan.expectedPrivacyEpoch)) {
      throw new Error('workspace_erase_status_invalid');
    }
    return Object.freeze({ schemaVersion: 1, status: raw.status, plan,
      ...(hold ? { hold } : {}) });
  }
  if (raw.status === 'cleanup_pending' || raw.status === 'complete') {
    const source = record(value, ['schemaVersion', 'status', 'receipt'], 'workspace_erase_status_invalid');
    const receipt = parseWorkspaceEraseReceipt(source.receipt);
    if (receipt.status !== raw.status) throw new Error('workspace_erase_status_invalid');
    return Object.freeze({ schemaVersion: 1, status: raw.status, receipt });
  }
  if (raw.status === 'cancelled') {
    const hasHold = Object.hasOwn(raw, 'hold');
    const source = record(value, hasHold ? ['schemaVersion', 'status', 'cancellation', 'hold'] : ['schemaVersion', 'status', 'cancellation'], 'workspace_erase_status_invalid');
    return Object.freeze({ schemaVersion: 1, status: 'cancelled', cancellation: parseWorkspaceEraseCancellation(source.cancellation),
      ...(!hasHold ? {} : { hold: parseWorkspaceEraseHold(source.hold) }) });
  }
  throw new Error('workspace_erase_status_invalid');
}
