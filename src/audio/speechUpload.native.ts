import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import type { Note } from '../core';
import { validateRecoveryFormat, RECOVERY_FORMATS, MAX_RECOVERY_BYTES, boundedAudioFormatFromSignature } from './formats';
import type { NativeSpeechAudioIO, SpeechAudioCrypto, SpeechAudioService } from './speechUpload.types';
import { validateSpeechAudioSnapshot } from '../transcription/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FOLDER = 'speech-upload/';
const STEP_TIMEOUT_MS = 10_000;

function hashBytes(bytes: Uint8Array): Promise<string> {
  return Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes.slice().buffer as ArrayBuffer)
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

function decodeBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Could not read the audio file header.');
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[index++] = (accumulator >> bits) & 0xff; }
  }
  return out.subarray(0, index);
}

const defaultIO: NativeSpeechAudioIO = {
  cacheDirectory: FileSystem.cacheDirectory,
  async exists(uri) { const value = await FileSystem.getInfoAsync(uri); return { exists: value.exists, isDirectory: value.exists && 'isDirectory' in value ? value.isDirectory : undefined, size: value.exists && 'size' in value ? value.size : undefined }; },
  async makeDirectory(uri) { await FileSystem.makeDirectoryAsync(uri, { intermediates: true }); },
  async copy(from, to) { await FileSystem.copyAsync({ from, to }); },
  async move(from, to) { await FileSystem.moveAsync({ from, to }); },
  async remove(uri) { await FileSystem.deleteAsync(uri, { idempotent: true }); },
  async readHeader(uri) {
    const encoded = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64, position: 0, length: 16 });
    return decodeBase64(encoded);
  },
  async readBytes(uri) { const FileApi = await import('expo-file-system'); return new FileApi.File(uri).bytes(); },
};

/** Exposes only the platform IO seam so a workspace can lease each true filesystem promise. */
export function getNativeSpeechAudioIO(): NativeSpeechAudioIO { return defaultIO; }

function boundedStep<T>(start: () => Promise<T>, signal?: AbortSignal, late?: () => void | Promise<void>): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Audio preparation was cancelled.'));
  let promise: Promise<T>;
  try { promise = Promise.resolve(start()); }
  catch (error) { promise = Promise.reject(error); }
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
    promise.then((value) => {
      if (settled) void Promise.resolve(late?.()).catch(() => undefined);
      else finish(undefined, value);
    }, (error) => finish(error));
  });
}

function privateUri(io: NativeSpeechAudioIO, leaseId: string, ext: string): string {
  if (!io.cacheDirectory) throw new Error('Private speech upload storage is unavailable.');
  if (!UUID.test(leaseId)) throw new Error('Speech upload lease is invalid.');
  return `${io.cacheDirectory}${FOLDER}${leaseId}.${ext}`;
}

function safePrivateSource(uri: string, io: NativeSpeechAudioIO): boolean {
  if (!uri.startsWith('file://') || uri.includes('..') || /[\u0000-\u001f]/.test(uri)) return false;
  return [FileSystem.documentDirectory, io.cacheDirectory].some((root) => Boolean(root && uri.startsWith(root)));
}

function validateDuration(note: Note, maxDurationSeconds: number): number {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) throw new Error('The maximum recording duration is invalid.');
  const limit = Math.min(600, maxDurationSeconds);
  const duration = note.audioAttachment?.durationStatus === 'known'
    ? note.audioAttachment.durationSeconds
    : note.audioAttachment?.durationStatus === 'unknown' ? undefined : note.durationSeconds;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > limit) throw new Error(`Recording duration must be known and no longer than ${limit} seconds.`);
  return duration;
}

function validateAudioByteLimit(maxAudioBytes?: number): number {
  const limit = maxAudioBytes ?? MAX_RECOVERY_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RECOVERY_BYTES) throw new Error('The maximum upload size is invalid.');
  return limit;
}

export function createNativeSpeechAudioService(deps: {
  io?: NativeSpeechAudioIO;
  crypto?: SpeechAudioCrypto;
  withMemoryMutation?: <T>(mutation: () => T) => Promise<T>;
} = {}): SpeechAudioService {
  const io = deps.io ?? defaultIO;
  const crypto = deps.crypto ?? { sha256: hashBytes };
  const leases = new Map<string, string>();
  const owned = new Set<string>();
  const uploadBytesByLease = new Map<string, Uint8Array>();
  const activeWrites = new Map<string, number>();
  const cleanupAfterWrite = new Set<string>();
  const cleanupOperations = new Map<string, Promise<void>>();
  let disposed = false;
  const assertActive = () => { if (disposed) throw new Error('Speech upload staging is no longer available in this workspace.'); };
  const trackWrite = (leaseId: string, start: () => Promise<void>): Promise<void> => {
    activeWrites.set(leaseId, (activeWrites.get(leaseId) ?? 0) + 1);
    let operation: Promise<void>;
    try { operation = Promise.resolve(start()); }
    catch (error) { operation = Promise.reject(error); }
    return operation.finally(() => {
      const remaining = (activeWrites.get(leaseId) ?? 1) - 1;
      if (remaining > 0) activeWrites.set(leaseId, remaining);
      else {
        activeWrites.delete(leaseId);
        if (cleanupAfterWrite.delete(leaseId)) void cleanup(leaseId).catch(() => undefined);
      }
    });
  };
  const ensureFolder = async (signal?: AbortSignal) => {
    if (!io.cacheDirectory) throw new Error('Private speech upload storage is unavailable.');
    const folder = `${io.cacheDirectory}${FOLDER}`;
    const info = await boundedStep(() => io.exists(folder), signal);
    if (!info.exists) await boundedStep(() => io.makeDirectory(folder), signal);
    else if (!info.isDirectory) throw new Error('Private speech upload storage is unavailable.');
    return folder;
  };
  const cleanup = async (leaseId: string) => {
    if (!UUID.test(leaseId)) throw new Error('Speech upload lease is invalid.');
    if (!io.cacheDirectory) throw new Error('Private speech upload storage is unavailable for cleanup.');
    if ((activeWrites.get(leaseId) ?? 0) > 0) throw new Error('Speech upload preparation still owns this audio lease.');
    const inProgress = cleanupOperations.get(leaseId);
    if (inProgress) return inProgress;
    const operation = (async () => {
      for (const ext of ['stage', 'm4a', 'mp3', 'wav', 'webm', 'ogg']) {
        const uri = privateUri(io, leaseId, ext);
        const info = await boundedStep(() => io.exists(uri));
        if (info.exists) {
          if (info.isDirectory) throw new Error('Speech upload cleanup refused a directory.');
          await boundedStep(() => io.remove(uri));
        }
      }
      owned.delete(leaseId);
      leases.delete(leaseId);
      uploadBytesByLease.delete(leaseId);
    })();
    cleanupOperations.set(leaseId, operation);
    try { await operation; }
    finally { if (cleanupOperations.get(leaseId) === operation) cleanupOperations.delete(leaseId); }
  };
  return {
    async prepare(note, { leaseId, maxDurationSeconds, maxAudioBytes, signal }) {
      assertActive();
      if (!UUID.test(leaseId)) throw new Error('Speech upload lease is invalid.');
      if (!note.audioUri || !safePrivateSource(note.audioUri, io)) throw new Error('The note does not have an available private app audio file.');
      const durationSeconds = validateDuration(note, maxDurationSeconds);
      const byteLimit = validateAudioByteLimit(maxAudioBytes);
      const sourceInfo = await boundedStep(() => io.exists(note.audioUri!), signal);
      if (!sourceInfo.exists || sourceInfo.isDirectory || !Number.isSafeInteger(sourceInfo.size) || sourceInfo.size! <= 0 || sourceInfo.size! > MAX_RECOVERY_BYTES) throw new Error('Audio file is empty, unavailable, or exceeds the 40 MiB upload limit.');
      if (sourceInfo.size! > byteLimit) throw new Error('Audio file exceeds the selected upload profile size limit.');
      const folder = await ensureFolder(signal);
      owned.add(leaseId);
      const stage = `${folder}${leaseId}.stage`;
      try {
        await boundedStep(() => trackWrite(leaseId, () => io.copy(note.audioUri!, stage)), signal);
        const stageInfo = await boundedStep(() => io.exists(stage), signal);
        if (!stageInfo.exists || !Number.isSafeInteger(stageInfo.size) || stageInfo.size! <= 0 || stageInfo.size! > MAX_RECOVERY_BYTES) throw new Error('The recording changed while it was copied for upload.');
        if (stageInfo.size! > byteLimit) throw new Error('The staged recording exceeds the selected upload profile size limit.');
        if (stageInfo.size !== sourceInfo.size) throw new Error('The recording changed while it was copied for upload.');
        const header = await boundedStep(() => io.readHeader(stage), signal, () => cleanup(leaseId));
        const headerFormat = boundedAudioFormatFromSignature(header);
        if (!headerFormat) throw new Error('The recording header is not a supported cloud audio format.');
        validateRecoveryFormat(note.audioAttachment?.fileName ?? note.audioUri.split('/').pop() ?? 'recording', note.audioAttachment?.mimeType, header);
        const read = await boundedStep(() => io.readBytes(stage), signal, () => cleanup(leaseId));
        if (read.byteLength !== stageInfo.size) throw new Error('The recording changed while it was read.');
        if (read.byteLength > byteLimit) throw new Error('The staged recording exceeds the selected upload profile size limit.');
        const format = validateRecoveryFormat(note.audioAttachment?.fileName ?? note.audioUri.split('/').pop() ?? 'recording', note.audioAttachment?.mimeType, read);
        const mimeType = RECOVERY_FORMATS[format].mimeType;
        const sha256 = await boundedStep(() => crypto.sha256(read), signal, () => cleanup(leaseId));
        assertActive();
        if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('The recording fingerprint could not be verified.');
        if (note.audioAttachment && (note.audioAttachment.byteLength !== read.byteLength || note.audioAttachment.sha256.toLowerCase() !== sha256.toLowerCase())) throw new Error('The selected recording changed since it was attached.');
        const finalUri = privateUri(io, leaseId, format);
        await boundedStep(() => trackWrite(leaseId, () => io.move(stage, finalUri)), signal);
        const finalInfo = await boundedStep(() => io.exists(finalUri), signal);
        if (!finalInfo.exists || finalInfo.size !== read.byteLength) throw new Error('The private upload copy changed before it was ready.');
        const snapshot = validateSpeechAudioSnapshot({ leaseId, platform: 'native', format, mimeType, byteLength: read.byteLength, sha256, durationSeconds });
        const commitMemory = () => {
          assertActive();
          leases.set(leaseId, finalUri);
          uploadBytesByLease.set(leaseId, read);
        };
        if (deps.withMemoryMutation) await deps.withMemoryMutation(commitMemory);
        else commitMemory();
        const part = Object.freeze({ name: `still-recording.${format}`, type: mimeType, async bytes() {
          const stored = uploadBytesByLease.get(leaseId);
          if (!stored) throw new Error('The prepared upload bytes have been released.');
          return stored.slice();
        } });
        return Object.freeze({ ...snapshot, platform: 'native' as const, upload: Object.freeze({ uri: finalUri, part }) });
      } catch (error) {
        if ((activeWrites.get(leaseId) ?? 0) > 0) cleanupAfterWrite.add(leaseId);
        else void cleanup(leaseId).catch(() => undefined);
        throw error;
      }
    },
    async verify(prepared, signal) {
      assertActive();
      if (prepared.platform !== 'native') throw new Error('Prepared audio platform does not match this adapter.');
      if (!owned.has(prepared.leaseId) || leases.get(prepared.leaseId) !== prepared.upload.uri) throw new Error('The prepared audio lease is no longer owned.');
      const info = await boundedStep(() => io.exists(prepared.upload.uri), signal);
      if (!info.exists || info.size !== prepared.byteLength) throw new Error('The private upload copy changed before dispatch.');
      const bytes = await boundedStep(() => io.readBytes(prepared.upload.uri), signal);
      if (bytes.byteLength !== prepared.byteLength || (await boundedStep(() => crypto.sha256(bytes), signal)).toLowerCase() !== prepared.sha256.toLowerCase()) throw new Error('The private upload copy changed before dispatch.');
    },
    async release(leaseId) { await cleanup(leaseId); },
    disposeMemory() {
      disposed = true;
      owned.clear();
      leases.clear();
      uploadBytesByLease.clear();
      cleanupAfterWrite.clear();
    },
  };
}

export const nativeSpeechAudioService = createNativeSpeechAudioService();
