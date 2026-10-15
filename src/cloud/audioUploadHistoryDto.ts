/** Closed, metadata-only browser projection for durable audio upload recovery. */
export type AudioUploadHistoryStatus = 'receiving' | 'ready' | 'failed' | 'inspect_required' | 'consumed' | 'discarded';
export type AudioUploadHistoryEntryDTO = Readonly<{
  uploadId: string;
  capture: Readonly<{ id: string; revision: string; capturedAt: string; timeZone: string }>;
  status: AudioUploadHistoryStatus;
  createdAt: number;
  updatedAt: number;
}>;
export type AudioUploadHistoryPageDTO = Readonly<{
  schemaVersion: 1;
  entries: readonly AudioUploadHistoryEntryDTO[];
  nextCursor?: string;
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS = new Set<AudioUploadHistoryStatus>(['receiving', 'ready', 'failed', 'inspect_required', 'consumed', 'discarded']);

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === 'string' && allowed.has(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')) && required.every((key) => Object.hasOwn(value, key));
}

function plainDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => {
    if (key === 'length') return true;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
  }) && keys.length === value.length + 1;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function timeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export function parseAudioUploadHistoryPageDTO(value: unknown): AudioUploadHistoryPageDTO {
  if (!isPlain(value) || !exact(value, ['schemaVersion', 'entries'], ['nextCursor']) || value.schemaVersion !== 1 || !plainDataArray(value.entries) ||
      (Object.hasOwn(value, 'nextCursor') && (typeof value.nextCursor !== 'string' || value.nextCursor.length < 1 || value.nextCursor.length > 2048 ||
        !/^[A-Za-z0-9_-]+$/.test(value.nextCursor)))) {
    throw new TypeError('audio_history_invalid');
  }
  if (value.entries.length > 50) throw new TypeError('audio_history_invalid');
  const ids = new Set<string>();
  const entries = value.entries.map((entry): AudioUploadHistoryEntryDTO => {
    if (!isPlain(entry) || !exact(entry, ['uploadId', 'capture', 'status', 'createdAt', 'updatedAt']) ||
        typeof entry.uploadId !== 'string' || !UUID_V4.test(entry.uploadId) || ids.has(entry.uploadId) ||
        typeof entry.status !== 'string' || !STATUS.has(entry.status as AudioUploadHistoryStatus) ||
        typeof entry.createdAt !== 'number' || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 ||
        typeof entry.updatedAt !== 'number' || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0 ||
        !isPlain(entry.capture) || !exact(entry.capture, ['id', 'revision', 'capturedAt', 'timeZone']) ||
        typeof entry.capture.id !== 'string' || !UUID_V4.test(entry.capture.id) ||
        typeof entry.capture.revision !== 'string' || !UUID_V4.test(entry.capture.revision) ||
        !canonicalIso(entry.capture.capturedAt) || !timeZone(entry.capture.timeZone)) throw new TypeError('audio_history_invalid');
    ids.add(entry.uploadId);
    return Object.freeze({ uploadId: entry.uploadId, capture: Object.freeze({ id: entry.capture.id, revision: entry.capture.revision,
      capturedAt: entry.capture.capturedAt, timeZone: entry.capture.timeZone }), status: entry.status as AudioUploadHistoryStatus,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt });
  });
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries),
    ...(Object.hasOwn(value, 'nextCursor') ? { nextCursor: value.nextCursor as string } : {}) });
}
