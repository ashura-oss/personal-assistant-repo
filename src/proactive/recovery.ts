import { recoveryUtf8Bytes, validateRecoveryId, validateRecoveryIso } from '../storage/startupRecovery';
import { validateProactiveState } from './state';

export const PROACTIVE_RECOVERY_MAX_ARCHIVES = 4;
export const PROACTIVE_RECOVERY_MAX_SOURCE_BYTES = 256 * 1024;
export const PROACTIVE_RECOVERY_MAX_ARCHIVE_BYTES = 1024 * 1024;
export const PROACTIVE_RECOVERY_TTL_MS = 5 * 60 * 1000;

export interface ProactiveRecoveryArchiveEntry {
  readonly operationId: string;
  readonly archivedAt: string;
  readonly sourceJson: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
}

export interface ProactiveRecoveryArchiveState {
  readonly version: 1;
  readonly entries: readonly ProactiveRecoveryArchiveEntry[];
}

export type ProactiveRecoveryReason =
  | 'archive_invalid'
  | 'archive_full'
  | 'evidence_too_large'
  | 'unsupported_storage'
  | 'privacy_unavailable'
  | 'startup_unavailable';

export interface ProactiveRecoveryPlan {
  readonly operationId: string;
  readonly expiresAt: string;
  readonly evidenceBytes: number;
  readonly archiveCount: number;
  readonly effects: Readonly<{
    resetsRules: true;
    resetsAttention: true;
    resetsDismissalsAndSnoozes: true;
    mailConsentsToRevoke: number | null;
    mailReceiptsPreserved: number | null;
    mailCleanup: 'pending' | 'none' | 'unavailable';
  }>;
}

export interface ProactiveRecoveryStatus {
  readonly status: 'available' | 'prepared' | 'unavailable' | 'refresh_required' | 'busy' | 'not_needed';
  readonly reason?: ProactiveRecoveryReason;
  readonly archiveCount: number | null;
  readonly archiveBytes: number | null;
  readonly plan?: ProactiveRecoveryPlan;
}

export type ProactiveRecoveryResult =
  | Readonly<{ status: 'applied'; operationId: string; archivedAt: string; evidenceBytes: number; archiveCount: number }>
  | Readonly<{ status: 'unknown'; operationId: string }>;

export type ProactiveRecoveryReceiptInspection =
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

function validSourceJson(sourceJson: unknown): sourceJson is string {
  if (typeof sourceJson !== 'string') return false;
  const bytes = recoveryUtf8Bytes(sourceJson, PROACTIVE_RECOVERY_MAX_SOURCE_BYTES);
  if (bytes <= 0 || bytes > PROACTIVE_RECOVERY_MAX_SOURCE_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(sourceJson);
    if (!isRecord(parsed) || Object.keys(parsed).length === 0 ||
        !Object.keys(parsed).every((key) => key === 'proactive' || key === 'proactiveQuarantine')) return false;
    if (Object.prototype.hasOwnProperty.call(parsed, 'proactiveQuarantine')) return true;
    try { validateProactiveState(parsed.proactive); return false; } catch { return true; }
  } catch { return false; }
}

export function emptyProactiveRecoveryArchiveState(): ProactiveRecoveryArchiveState {
  return Object.freeze({ version: 1, entries: Object.freeze([]) });
}

/** Strict bounded validator. It never truncates or drops an archive entry. */
export function validateProactiveRecoveryArchiveState(value: unknown): ProactiveRecoveryArchiveState {
  if (!isRecord(value) || !exactKeys(value, ENVELOPE_KEYS) || value.version !== 1 || !Array.isArray(value.entries) ||
      value.entries.length > PROACTIVE_RECOVERY_MAX_ARCHIVES) throw new Error('Proactive recovery archive is unavailable.');
  const entries: ProactiveRecoveryArchiveEntry[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value.entries) {
    if (!isRecord(candidate) || !exactKeys(candidate, ENTRY_KEYS)) throw new Error('Proactive recovery archive is unavailable.');
    let operationId: string;
    let archivedAt: string;
    try {
      operationId = validateRecoveryId(candidate.operationId, 'Proactive recovery operation');
      archivedAt = validateRecoveryIso(candidate.archivedAt, 'Proactive recovery time');
    } catch { throw new Error('Proactive recovery archive is unavailable.'); }
    if (candidate.operationId !== operationId || candidate.archivedAt !== archivedAt || ids.has(operationId) || !validSourceJson(candidate.sourceJson) ||
        !Number.isSafeInteger(candidate.sourceBytes) || candidate.sourceBytes !== recoveryUtf8Bytes(candidate.sourceJson) ||
        (candidate.sourceBytes as number) <= 0 ||
        typeof candidate.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sourceSha256)) {
      throw new Error('Proactive recovery archive is unavailable.');
    }
    ids.add(operationId);
    totalBytes += candidate.sourceBytes as number;
    if (totalBytes > PROACTIVE_RECOVERY_MAX_ARCHIVE_BYTES) throw new Error('Proactive recovery archive is unavailable.');
    entries.push(Object.freeze({
      operationId, archivedAt, sourceJson: candidate.sourceJson,
      sourceSha256: candidate.sourceSha256, sourceBytes: candidate.sourceBytes as number,
    }));
  }
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
}

/** Select only the two authorized top-level evidence fields, preserving own-property presence. */
export function proactiveRecoveryEvidenceJson(raw: Record<string, unknown>): string | undefined {
  const selected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let found = false;
  for (const key of ['proactive', 'proactiveQuarantine'] as const) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    selected[key] = raw[key];
    found = true;
  }
  if (!found) return undefined;
  const serialized = JSON.stringify(selected);
  return typeof serialized === 'string' && serialized.length > 2 ? serialized : undefined;
}

export function proactiveRecoveryArchiveBytes(state: ProactiveRecoveryArchiveState): number {
  return state.entries.reduce((total, entry) => total + entry.sourceBytes, 0);
}
