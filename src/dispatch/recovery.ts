import { recoveryUtf8Bytes, validateRecoveryId, validateRecoveryIso } from '../storage/startupRecovery';

export const DISPATCH_RECOVERY_MAX_ARCHIVES = 4;
export const DISPATCH_RECOVERY_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const DISPATCH_RECOVERY_MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
export const DISPATCH_RECOVERY_TTL_MS = 5 * 60 * 1000;

export interface DispatchRecoveryArchiveEntry {
  readonly operationId: string;
  readonly archivedAt: string;
  readonly sourceJson: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
}

export interface DispatchRecoveryArchiveState {
  readonly version: 1;
  readonly entries: readonly DispatchRecoveryArchiveEntry[];
}

export type DispatchRecoveryReason =
  | 'archive_invalid'
  | 'archive_full'
  | 'evidence_too_large'
  | 'unsupported_storage'
  | 'privacy_unavailable'
  | 'startup_unavailable';

export interface DispatchRecoveryPlan {
  readonly operationId: string;
  readonly expiresAt: string;
  readonly evidenceBytes: number;
  readonly archiveCount: number;
  readonly effects: Readonly<{
    quarantinedReceiptCount: number;
    preservedValidReceiptCount: number;
    remoteProposalsRetired: number;
    sourceActionFencesAdded: number;
    unresolvedReceiptCount: number;
  }>;
}

export interface DispatchRecoveryStatus {
  readonly status: 'available' | 'prepared' | 'unavailable' | 'refresh_required' | 'busy' | 'not_needed';
  readonly reason?: DispatchRecoveryReason;
  readonly archiveCount: number | null;
  readonly archiveBytes: number | null;
  readonly lastOperationId?: string;
  readonly plan?: DispatchRecoveryPlan;
  readonly unresolvedReceiptCount?: number;
}

export type DispatchRecoveryResult =
  | Readonly<{ status: 'applied'; operationId: string; archivedAt: string; evidenceBytes: number; archiveCount: number }>
  | Readonly<{ status: 'unknown'; operationId: string }>;

export type DispatchRecoveryReceiptInspection =
  | Readonly<{ status: 'applied'; operationId: string; archivedAt: string; evidenceBytes: number; archiveCount: number }>
  | Readonly<{ status: 'not_verified' | 'unavailable'; operationId: string }>;

const ENVELOPE_KEYS = ['version', 'entries'] as const;
const ENTRY_KEYS = ['operationId', 'archivedAt', 'sourceJson', 'sourceSha256', 'sourceBytes'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function subsetKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function boundedCanonicalString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function validIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = ['providerNamespace', 'clientId', 'subject', 'resourceUserId'];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      !(value.providerNamespace === 'google' || value.providerNamespace === 'microsoft') ||
      !['clientId', 'subject'].every((key) => boundedCanonicalString(value[key], 1024))) return false;
  return value.resourceUserId === undefined || boundedCanonicalString(value.resourceUserId, 1024);
}

function identityKey(value: unknown): string {
  if (!isRecord(value)) return '';
  return JSON.stringify(['google', 'microsoft'].includes(String(value.providerNamespace))
    ? [value.providerNamespace, value.clientId, value.subject, value.resourceUserId ?? ''] : []);
}

function validSourceActionFence(value: unknown): boolean {
  if (!isRecord(value) || !subsetKeys(value, ['sourceActionKey', 'operation'], ['accountId', 'identity'])) return false;
  return boundedCanonicalString(value.sourceActionKey, 1024 * 1024) &&
    (value.accountId === undefined || boundedCanonicalString(value.accountId, 512)) &&
    (value.identity === undefined || validIdentity(value.identity)) &&
    (value.operation === 'mail_any' || value.operation === 'event');
}

function validRetiredProposal(value: unknown): boolean {
  if (!isRecord(value) || !subsetKeys(value, ['proposalId', 'kind', 'status'], ['operation', 'sourceActionKey', 'accountId', 'identity'])) return false;
  return boundedCanonicalString(value.proposalId, 160) &&
    (value.kind === 'email' || value.kind === 'event') &&
    typeof value.status === 'string' && ['draft', 'approved', 'dispatching', 'unknown', 'failed', 'accepted', 'simulated', 'executed', 'dismissed'].includes(value.status) &&
    (value.operation === undefined || value.operation === 'draft' || value.operation === 'send' || value.operation === 'event') &&
    (value.sourceActionKey === undefined || boundedCanonicalString(value.sourceActionKey, 1024 * 1024)) &&
    (value.accountId === undefined || boundedCanonicalString(value.accountId, 512)) &&
    (value.identity === undefined || validIdentity(value.identity));
}

function validSourceJson(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const bytes = recoveryUtf8Bytes(value, DISPATCH_RECOVERY_MAX_SOURCE_BYTES);
  if (bytes <= 0 || bytes > DISPATCH_RECOVERY_MAX_SOURCE_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !exactKeys(parsed, ['quarantine', 'trustedRemoteProposals', 'sourceActionFences', 'unresolvedReceiptCount']) ||
        !Object.hasOwn(parsed, 'quarantine') || !Array.isArray(parsed.trustedRemoteProposals) || !parsed.trustedRemoteProposals.every(validRetiredProposal) ||
        !Array.isArray(parsed.sourceActionFences) || !parsed.sourceActionFences.every(validSourceActionFence) ||
        !Number.isSafeInteger(parsed.unresolvedReceiptCount) || Number(parsed.unresolvedReceiptCount) < 0) return false;
    const proposals = parsed.trustedRemoteProposals as Record<string, unknown>[];
    const fences = parsed.sourceActionFences as Record<string, unknown>[];
    const proposalIds = proposals.map((proposal) => proposal.proposalId);
    // A source action can only be fenced once within its scope. Outcomes live
    // in their original receipt/proposal records, never in the retirement key.
    const fenceScope = (row: Record<string, unknown>) => JSON.stringify([row.sourceActionKey, row.accountId ?? '', identityKey(row.identity), row.operation]);
    const fenceByScope = new Map<string, Record<string, unknown>>();
    for (const fence of fences) {
      const key = fenceScope(fence);
      if (fenceByScope.has(key)) return false;
      fenceByScope.set(key, fence);
    }
    if (new Set(proposalIds).size !== proposalIds.length) return false;
    for (const proposal of proposals) {
      if (proposal.sourceActionKey === undefined) continue;
      const operation = proposal.kind === 'email' ? 'mail_any' : 'event';
      const match = fenceByScope.get(fenceScope({ sourceActionKey: proposal.sourceActionKey, accountId: proposal.accountId, identity: proposal.identity, operation }));
      if (!match) return false;
    }
    for (const proposal of proposals) {
      if (proposal.kind === 'email' && proposal.operation === 'event' || proposal.kind === 'event' && proposal.operation !== undefined && proposal.operation !== 'event') return false;
    }
    return true;
  } catch { return false; }
}

export function emptyDispatchRecoveryArchiveState(): DispatchRecoveryArchiveState {
  return Object.freeze({ version: 1, entries: Object.freeze([]) });
}

/** Strict bounded validator. Invalid archives are preserved by the controller and never rewritten. */
export function validateDispatchRecoveryArchiveState(value: unknown): DispatchRecoveryArchiveState {
  if (!isRecord(value) || !exactKeys(value, ENVELOPE_KEYS) || value.version !== 1 || !Array.isArray(value.entries) ||
      value.entries.length > DISPATCH_RECOVERY_MAX_ARCHIVES) throw new Error('Dispatch recovery archive is unavailable.');
  const entries: DispatchRecoveryArchiveEntry[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value.entries) {
    if (!isRecord(candidate) || !exactKeys(candidate, ENTRY_KEYS)) throw new Error('Dispatch recovery archive is unavailable.');
    let operationId: string;
    let archivedAt: string;
    try {
      operationId = validateRecoveryId(candidate.operationId, 'Dispatch recovery operation');
      archivedAt = validateRecoveryIso(candidate.archivedAt, 'Dispatch recovery time');
    } catch { throw new Error('Dispatch recovery archive is unavailable.'); }
    if (candidate.operationId !== operationId || candidate.archivedAt !== archivedAt || ids.has(operationId) ||
        !validSourceJson(candidate.sourceJson) || !Number.isSafeInteger(candidate.sourceBytes) ||
        candidate.sourceBytes !== recoveryUtf8Bytes(candidate.sourceJson) || Number(candidate.sourceBytes) <= 0 ||
        typeof candidate.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sourceSha256)) {
      throw new Error('Dispatch recovery archive is unavailable.');
    }
    ids.add(operationId);
    totalBytes += Number(candidate.sourceBytes);
    if (totalBytes > DISPATCH_RECOVERY_MAX_ARCHIVE_BYTES) throw new Error('Dispatch recovery archive is unavailable.');
    entries.push(Object.freeze({ operationId, archivedAt, sourceJson: candidate.sourceJson,
      sourceSha256: candidate.sourceSha256, sourceBytes: Number(candidate.sourceBytes) }));
  }
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
}

export function dispatchRecoveryArchiveBytes(state: DispatchRecoveryArchiveState): number {
  return state.entries.reduce((total, entry) => total + entry.sourceBytes, 0);
}

export function dispatchRecoveryEvidenceJson(value: unknown): string | undefined {
  const serialized = JSON.stringify(value);
  return typeof serialized === 'string' && serialized.length > 2 ? serialized : undefined;
}
