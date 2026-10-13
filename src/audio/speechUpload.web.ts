import type { Note } from '../core';
import { getAudio } from './blobStore.web';
import { RECOVERY_FORMATS, validateRecoveryFormat, MAX_RECOVERY_BYTES } from './formats';
import type { SpeechAudioCrypto, SpeechAudioService } from './speechUpload.types';
import { validateSpeechAudioSnapshot } from '../transcription/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_TIMEOUT_MS = 10_000;
const blobs = new Map<string, Blob>();

async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason ?? new Error('Audio preparation was cancelled.'); }
function boundedStep<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Audio preparation was cancelled.'));
  let operation: Promise<T>;
  try { operation = Promise.resolve(start()); }
  catch (error) { operation = Promise.reject(error); }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    const onAbort = () => finish(signal?.reason ?? new Error('Audio preparation was cancelled.'));
    const timer = setTimeout(() => finish(new Error('Audio preparation exceeded its 10 second I/O limit.')), STEP_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => finish(undefined, value), (error) => finish(error));
  });
}
function duration(note: Note, max: number): number {
  if (!Number.isFinite(max) || max <= 0) throw new Error('The maximum recording duration is invalid.');
  const value = note.audioAttachment?.durationStatus === 'known' ? note.audioAttachment.durationSeconds : note.audioAttachment?.durationStatus === 'unknown' ? undefined : note.durationSeconds;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > Math.min(max, 600)) throw new Error('Recording duration must be known and within the upload limit.');
  return value;
}

export function createWebSpeechAudioService(deps: { get?: (uri: string) => Promise<Blob>; crypto?: SpeechAudioCrypto } = {}): SpeechAudioService {
  const get = deps.get ?? getAudio;
  const hash = deps.crypto?.sha256 ?? sha256;
  return {
    async prepare(note, { leaseId, maxDurationSeconds, signal }) {
      if (!UUID.test(leaseId)) throw new Error('Speech upload lease is invalid.');
      if (!note.audioUri) throw new Error('The note does not have an available recording.');
      const durationSeconds = duration(note, maxDurationSeconds);
      const source = await boundedStep(() => get(note.audioUri!), signal);
      if (!(source instanceof Blob) || !Number.isSafeInteger(source.size) || source.size <= 0 || source.size > MAX_RECOVERY_BYTES) throw new Error('Audio file is empty, unavailable, or exceeds the 40 MiB upload limit.');
      const header = new Uint8Array(await boundedStep(() => source.slice(0, 16).arrayBuffer(), signal));
      checkAbort(signal);
      const fileName = note.audioAttachment?.fileName ?? 'recording';
      validateRecoveryFormat(fileName, note.audioAttachment?.mimeType ?? source.type, header);
      const bytes = new Uint8Array(await boundedStep(() => source.arrayBuffer(), signal));
      checkAbort(signal);
      if (bytes.byteLength !== source.size) throw new Error('The recording changed while it was read.');
      const format = validateRecoveryFormat(fileName, note.audioAttachment?.mimeType ?? source.type, bytes);
      const mimeType = RECOVERY_FORMATS[format].mimeType;
      const blob = new Blob([bytes], { type: mimeType });
      const digest = await boundedStep(() => hash(bytes), signal);
      if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error('The recording fingerprint could not be verified.');
      if (note.audioAttachment && (note.audioAttachment.byteLength !== bytes.byteLength || note.audioAttachment.sha256.toLowerCase() !== digest.toLowerCase())) throw new Error('The selected recording changed since it was attached.');
      checkAbort(signal);
      const snapshot = validateSpeechAudioSnapshot({ leaseId, platform: 'web', format, mimeType, byteLength: bytes.byteLength, sha256: digest, durationSeconds });
      blobs.set(leaseId, blob);
      return Object.freeze({ ...snapshot, platform: 'web' as const, upload: Object.freeze({ blob, fileName: `still-recording.${format}` }) });
    },
    async verify(prepared, signal) {
      checkAbort(signal);
      if (prepared.platform !== 'web') throw new Error('Prepared audio platform does not match this adapter.');
      const blob = blobs.get(prepared.leaseId);
      if (!blob || blob !== prepared.upload.blob || blob.size !== prepared.byteLength) throw new Error('The prepared audio lease is no longer owned.');
      const bytes = new Uint8Array(await boundedStep(() => blob.arrayBuffer(), signal));
      checkAbort(signal);
      if (bytes.byteLength !== prepared.byteLength || (await boundedStep(() => hash(bytes), signal)).toLowerCase() !== prepared.sha256.toLowerCase()) throw new Error('The private upload copy changed before dispatch.');
    },
    async release(leaseId) { if (UUID.test(leaseId)) blobs.delete(leaseId); },
  };
}

export const webSpeechAudioService = createWebSpeechAudioService();
