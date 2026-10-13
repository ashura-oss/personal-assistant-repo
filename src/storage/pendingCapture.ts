import type { AppState } from '../core';

export const PENDING_CAPTURE_STORAGE_KEY = 'voice-assistant.pending-capture.v1';
export const PENDING_CAPTURE_MAX_BYTES = 16 * 1024;

export type PendingCaptureInspection =
  | Readonly<{ outcome: 'known'; durationSeconds: number }>
  | Readonly<{ outcome: 'unknown' | 'invalid' | 'missing' }>;

export type PendingCaptureRecord = Readonly<{
  version: 1;
  id: string;
  originalPath: string;
  capturedAt: string;
  captureTimeZone: string;
  phase: 'prepared' | 'needs_inspection' | 'inspected' | 'discarding';
  replacementPaths: readonly string[];
  replacementOverflow: boolean;
  inspection?: PendingCaptureInspection;
}>;

export type PendingCaptureRead =
  | Readonly<{ kind: 'empty'; revision: string | null; consumedCaptureId?: string }>
  | Readonly<{ kind: 'valid'; revision: string; capture: PendingCaptureRecord }>
  | Readonly<{ kind: 'blocked'; reason: 'unreadable' | 'unsupported' }>;

export interface PendingCaptureBackend {
  read(): Promise<PendingCaptureRead>;
  create(expectedEmptyRevision: string | null, capture: PendingCaptureRecord): Promise<PendingCaptureRead>;
  update(expected: Readonly<{ id: string; revision: string }>, capture: PendingCaptureRecord): Promise<PendingCaptureRead>;
  clearAfterDiscard(expected: Readonly<{ id: string; revision: string }>): Promise<void>;
}

export type ConsumePendingCapture = Readonly<{ id: string; revision: string; noteId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPTURE_PATH = /^ExpoAudio\/recording-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.m4a$/;
const MAX_PATH_BYTES = 1024;

export function validatePendingCaptureUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Pending recording data is invalid.');
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Pending recording data is invalid.');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('Pending recording data is invalid.');
  return value;
}

function validTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Pending recording data is invalid.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); }
  catch { throw new Error('Pending recording data is invalid.'); }
  return value;
}

export function validatePendingCapturePath(value: unknown): string {
  if (typeof value !== 'string' || utf8Bytes(value) > MAX_PATH_BYTES || !CAPTURE_PATH.test(value)) throw new Error('Pending recording data is invalid.');
  return value;
}

const canonicalCapturePath = validatePendingCapturePath;

function validateInspection(value: unknown): PendingCaptureInspection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pending recording data is invalid.');
  const row = value as Record<string, unknown>;
  if (row.outcome === 'known') {
    if (Object.keys(row).some((key) => !['outcome', 'durationSeconds'].includes(key)) || typeof row.durationSeconds !== 'number' || !Number.isFinite(row.durationSeconds) || row.durationSeconds <= 0) throw new Error('Pending recording data is invalid.');
    return Object.freeze({ outcome: 'known', durationSeconds: row.durationSeconds });
  }
  if (['unknown', 'invalid', 'missing'].includes(String(row.outcome)) && Object.keys(row).length === 1) return Object.freeze({ outcome: row.outcome as 'unknown' | 'invalid' | 'missing' });
  throw new Error('Pending recording data is invalid.');
}

export function validatePendingCaptureRecord(value: unknown): PendingCaptureRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pending recording data is invalid.');
  const row = value as Record<string, unknown>;
  const allowed = ['version', 'id', 'originalPath', 'capturedAt', 'captureTimeZone', 'phase', 'replacementPaths', 'replacementOverflow', 'inspection'];
  if (Object.keys(row).some((key) => !allowed.includes(key)) || row.version !== 1) throw new Error('Pending recording data is invalid.');
  const id = validatePendingCaptureUuid(row.id);
  const originalPath = canonicalCapturePath(row.originalPath);
  const capturedAt = canonicalTimestamp(row.capturedAt);
  const captureTimeZone = validTimeZone(row.captureTimeZone);
  if (!['prepared', 'needs_inspection', 'inspected', 'discarding'].includes(String(row.phase))) throw new Error('Pending recording data is invalid.');
  if (!Array.isArray(row.replacementPaths) || row.replacementPaths.length > 16 || typeof row.replacementOverflow !== 'boolean') throw new Error('Pending recording data is invalid.');
  const replacementPaths = row.replacementPaths.map(canonicalCapturePath);
  const normalizedPaths = replacementPaths.map((path) => path.toLowerCase());
  if (new Set(normalizedPaths).size !== normalizedPaths.length || normalizedPaths.includes(originalPath.toLowerCase())) throw new Error('Pending recording data is invalid.');
  const phase = row.phase as PendingCaptureRecord['phase'];
  let inspection: PendingCaptureInspection | undefined;
  if (row.inspection !== undefined) inspection = validateInspection(row.inspection);
  if (phase === 'prepared' && (replacementPaths.length !== 0 || row.replacementOverflow || inspection !== undefined)) throw new Error('Pending recording data is invalid.');
  if (phase === 'needs_inspection' && inspection !== undefined) throw new Error('Pending recording data is invalid.');
  if (phase === 'inspected' && inspection === undefined) throw new Error('Pending recording data is invalid.');
  return Object.freeze({
    version: 1, id, originalPath, capturedAt, captureTimeZone, phase,
    replacementPaths: Object.freeze(replacementPaths), replacementOverflow: row.replacementOverflow,
    ...(inspection ? { inspection } : {}),
  });
}

export type PendingCaptureSlot = Readonly<{ version: 1; revision: string; capture?: PendingCaptureRecord; consumedCaptureId?: string }>;

export function serializePendingCaptureSlot(value: PendingCaptureSlot): string {
  const slot = validatePendingCaptureSlot(value);
  const raw = JSON.stringify(slot);
  if (utf8Bytes(raw) > PENDING_CAPTURE_MAX_BYTES) throw new Error('Pending recording data exceeds its storage limit.');
  return raw;
}

export function validatePendingCaptureSlot(value: unknown): PendingCaptureSlot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pending recording data is invalid.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['version', 'revision', 'capture', 'consumedCaptureId'].includes(key)) || row.version !== 1) throw new Error('Pending recording data is invalid.');
  const revision = validatePendingCaptureUuid(row.revision);
  if (row.capture === undefined && row.consumedCaptureId === undefined) return Object.freeze({ version: 1, revision });
  if (row.capture !== undefined && row.consumedCaptureId !== undefined) throw new Error('Pending recording data is invalid.');
  if (row.capture !== undefined) return Object.freeze({ version: 1, revision, capture: validatePendingCaptureRecord(row.capture) });
  return Object.freeze({ version: 1, revision, consumedCaptureId: validatePendingCaptureUuid(row.consumedCaptureId) });
}

export function readPendingCaptureSlot(raw: unknown, bytes?: number): PendingCaptureRead {
  if (typeof raw !== 'string') return Object.freeze({ kind: 'blocked', reason: 'unreadable' });
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > PENDING_CAPTURE_MAX_BYTES)) return Object.freeze({ kind: 'blocked', reason: 'unreadable' });
  if (bytes === undefined && (raw.length > PENDING_CAPTURE_MAX_BYTES || utf8Bytes(raw) > PENDING_CAPTURE_MAX_BYTES)) return Object.freeze({ kind: 'blocked', reason: 'unreadable' });
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return Object.freeze({ kind: 'blocked', reason: 'unreadable' }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.freeze({ kind: 'blocked', reason: 'unreadable' });
  if ((parsed as Record<string, unknown>).version !== 1) {
    const version = (parsed as Record<string, unknown>).version;
    return Object.freeze({ kind: 'blocked', reason: Number.isSafeInteger(version) && (version as number) > 1 ? 'unsupported' : 'unreadable' });
  }
  try {
    const slot = validatePendingCaptureSlot(parsed);
    if (slot.capture) return Object.freeze({ kind: 'valid', revision: slot.revision, capture: slot.capture });
    return Object.freeze({ kind: 'empty', revision: slot.revision, ...(slot.consumedCaptureId ? { consumedCaptureId: slot.consumedCaptureId } : {}) });
  } catch { return Object.freeze({ kind: 'blocked', reason: 'unreadable' }); }
}

export function resolvePendingCaptureUri(documentDirectory: string, path: string): string {
  const safePath = canonicalCapturePath(path);
  if (!/^file:\/\/[^\u0000-\u0020]+\/?$/.test(documentDirectory) || documentDirectory.includes('..') || documentDirectory.includes('\\') || /[?#]/.test(documentDirectory)) throw new Error('Pending recording storage is unavailable.');
  return `${documentDirectory.endsWith('/') ? documentDirectory : `${documentDirectory}/`}${safePath}`;
}

export function assertPendingCaptureConsumption(state: AppState, priorRaw: string | undefined, slot: PendingCaptureRead, request: ConsumePendingCapture, expectedUri: string): PendingCaptureRecord {
  if (slot.kind !== 'valid' || slot.revision !== request.revision || slot.capture.id !== request.id || slot.capture.phase !== 'inspected' ||
      slot.capture.replacementOverflow || slot.capture.replacementPaths.length || slot.capture.inspection?.outcome !== 'known' ||
      slot.capture.inspection.durationSeconds <= 0 || slot.capture.inspection.durationSeconds > 600 || request.noteId !== slot.capture.id) {
    throw new Error('Pending recording changed or is not eligible to attach.');
  }
  const notes = state.notes.filter((note) => note.id === request.noteId);
  if (notes.length !== 1) throw new Error('Pending recording note does not match the saved snapshot.');
  const note = notes[0];
  if (note.audioUri !== expectedUri || note.durationSeconds !== slot.capture.inspection.durationSeconds || note.capturedAt !== slot.capture.capturedAt || note.captureTimeZone !== slot.capture.captureTimeZone) {
    throw new Error('Pending recording note does not match the inspected capture.');
  }
  if (priorRaw !== undefined) {
    let prior: unknown;
    try { prior = JSON.parse(priorRaw) as unknown; } catch { throw new Error('Saved app data could not be read.'); }
    const priorNotes = prior && typeof prior === 'object' && !Array.isArray(prior) ? (prior as { notes?: unknown }).notes : undefined;
    if (!Array.isArray(priorNotes)) throw new Error('Saved app data could not be read.');
    if (priorNotes.some((item) => item && typeof item === 'object' && (item as { id?: unknown }).id === request.noteId)) {
      throw new Error('Pending recording note already exists in saved data.');
    }
  }
  return slot.capture;
}

export function emptyPendingCaptureSlot(revision: string, consumedCaptureId?: string): PendingCaptureSlot {
  return Object.freeze({ version: 1, revision: validatePendingCaptureUuid(revision), ...(consumedCaptureId ? { consumedCaptureId: validatePendingCaptureUuid(consumedCaptureId) } : {}) });
}

export function assertPendingCaptureTransition(previous: PendingCaptureRecord, nextValue: PendingCaptureRecord): PendingCaptureRecord {
  const next = validatePendingCaptureRecord(nextValue);
  if (previous.id !== next.id || previous.originalPath !== next.originalPath || previous.capturedAt !== next.capturedAt || previous.captureTimeZone !== next.captureTimeZone) throw new Error('Pending recording identity cannot change.');
  if (previous.phase === 'discarding' && next.phase !== 'discarding') throw new Error('A pending recording cannot leave discard state.');
  if (previous.phase === 'prepared' && !['prepared', 'needs_inspection', 'discarding'].includes(next.phase)) throw new Error('Pending recording phase cannot move backward.');
  if (previous.phase === 'needs_inspection' && !['needs_inspection', 'inspected', 'discarding'].includes(next.phase)) throw new Error('Pending recording phase cannot move backward.');
  if (previous.phase === 'inspected' && !['inspected', 'needs_inspection', 'discarding'].includes(next.phase)) throw new Error('Pending recording phase cannot move backward.');
  if (previous.replacementOverflow && !next.replacementOverflow) throw new Error('Pending recording overflow cannot be cleared.');
  if (previous.phase === 'inspected' && next.phase === 'needs_inspection' && next.inspection) throw new Error('A retry inspection must clear the old measurement.');
  if (previous.inspection && next.phase !== 'needs_inspection' && JSON.stringify(previous.inspection) !== JSON.stringify(next.inspection)) throw new Error('Pending recording inspection cannot change.');
  return next;
}
