/** Safe, closed browser projection for authenticated audio upload receipts. */

export type AudioUploadStatus = 'receiving' | 'ready' | 'failed' | 'inspect_required' | 'consumed' | 'discarded';
export type AudioUploadFormat = 'm4a' | 'mp3' | 'wav' | 'webm' | 'ogg';

export type AudioUploadReceiptDTO = Readonly<{
  schemaVersion: 1;
  uploadId: string;
  status: AudioUploadStatus;
  capture: Readonly<{ id: string; revision: string; capturedAt: string; timeZone: string }>;
  consumption?: Readonly<{ commandId: string; noteId: string; noteRevision: number }>;
  media?: Readonly<{ mediaId: `still-media:${string}`; sha256: string; byteLength: number;
    durationSeconds: number; format: AudioUploadFormat; mimeType: string }>;
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MIME_BY_FORMAT: Readonly<Record<AudioUploadFormat, string>> = Object.freeze({
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg',
});
const STATUS = new Set<AudioUploadStatus>(['receiving', 'ready', 'failed', 'inspect_required', 'consumed', 'discarded']);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => {
    if (typeof key !== 'string' || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
  }) && required.every((key) => Object.hasOwn(value, key));
}

function validCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function parseMedia(value: unknown): AudioUploadReceiptDTO['media'] {
  if (!isRecord(value) || !exactKeys(value, ['mediaId', 'sha256', 'byteLength', 'durationSeconds', 'format', 'mimeType'])) {
    throw new TypeError('audio_receipt_invalid');
  }
  const format = value.format;
  if (typeof format !== 'string' || !Object.hasOwn(MIME_BY_FORMAT, format)) throw new TypeError('audio_receipt_invalid');
  const mediaId = value.mediaId;
  const match = typeof mediaId === 'string' ? /^still-media:(.+)$/.exec(mediaId) : null;
  if (!match || !UUID_V4.test(match[1]!) || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256) ||
      typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 ||
      typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 ||
      value.mimeType !== MIME_BY_FORMAT[format as AudioUploadFormat]) throw new TypeError('audio_receipt_invalid');
  return Object.freeze({ mediaId: mediaId as `still-media:${string}`, sha256: value.sha256,
    byteLength: value.byteLength, durationSeconds: value.durationSeconds, format: format as AudioUploadFormat,
    mimeType: value.mimeType });
}

/** Decode only the server's safe data projection; unknown fields and inconsistent status data fail closed. */
export function parseAudioUploadReceiptDTO(value: unknown, expectedUploadId?: string): AudioUploadReceiptDTO {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'uploadId', 'status', 'capture'], ['consumption', 'media']) ||
      value.schemaVersion !== 1 || typeof value.uploadId !== 'string' || !UUID_V4.test(value.uploadId) ||
      (expectedUploadId !== undefined && value.uploadId !== expectedUploadId) ||
      typeof value.status !== 'string' || !STATUS.has(value.status as AudioUploadStatus)) {
    throw new TypeError('audio_receipt_invalid');
  }
  if (!isRecord(value.capture) || !exactKeys(value.capture, ['id', 'revision', 'capturedAt', 'timeZone']) ||
      typeof value.capture.id !== 'string' || !UUID_V4.test(value.capture.id) ||
      typeof value.capture.revision !== 'string' || !UUID_V4.test(value.capture.revision) ||
      !validCanonicalIso(value.capture.capturedAt) || !validTimeZone(value.capture.timeZone)) {
    throw new TypeError('audio_receipt_invalid');
  }
  const status = value.status as AudioUploadStatus;
  let consumption: AudioUploadReceiptDTO['consumption'];
  if (Object.hasOwn(value, 'consumption')) {
    const item = value.consumption;
    if (!isRecord(item) || !exactKeys(item, ['commandId', 'noteId', 'noteRevision']) ||
        typeof item.commandId !== 'string' || !UUID_V4.test(item.commandId) ||
        typeof item.noteId !== 'string' || !UUID_V4.test(item.noteId) ||
        typeof item.noteRevision !== 'number' || !Number.isSafeInteger(item.noteRevision) || item.noteRevision <= 0) {
      throw new TypeError('audio_receipt_invalid');
    }
    consumption = Object.freeze({ commandId: item.commandId, noteId: item.noteId, noteRevision: item.noteRevision });
  }
  const media = Object.hasOwn(value, 'media') ? parseMedia(value.media) : undefined;
  if ((status === 'ready' && (!media || consumption)) ||
      (status === 'consumed' && (!media || !consumption)) ||
      (status !== 'ready' && status !== 'consumed' && (media || consumption))) throw new TypeError('audio_receipt_invalid');
  return Object.freeze({ schemaVersion: 1, uploadId: value.uploadId, status,
    capture: Object.freeze({ id: value.capture.id, revision: value.capture.revision,
      capturedAt: value.capture.capturedAt, timeZone: value.capture.timeZone }),
    ...(consumption ? { consumption } : {}), ...(media ? { media } : {}) });
}

export function audioMediaUrl(mediaId: string): string {
  if (typeof mediaId !== 'string' || !UUID_V4.test(mediaId)) throw new TypeError('audio_media_id_invalid');
  return `/api/audio/${mediaId}`;
}
