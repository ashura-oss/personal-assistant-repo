import * as DocumentPicker from 'expo-document-picker';
import { getAudio, putAudio, removeAudio } from './blobStore.web';
import {
  assertRecoveryByteLength,
  boundedAudioFormatFromSignature,
  boundedRecoveryDuration,
  MAX_RECOVERY_BYTES,
  RECOVERY_FORMATS,
  safeAudioFileName,
  validateRecoveryFormat,
} from './formats';
import type { AudioRecoveryMetadata, RecordingRecoveryService, StagedRecording } from './recovery.types';

const ID_PREFIX = 'indexeddb-audio:recording-recovery-';
const PROBE_TIMEOUT_MS = 10_000;

export type RecoveryBlobStore = {
  put(id: string, blob: Blob): Promise<void>;
  get(id: string): Promise<Blob | undefined>;
  remove(id: string): Promise<void>;
};

const persistentStore: RecoveryBlobStore = {
  async put(id, blob) { await putAudio(`recording-recovery-${id}`, blob); },
  async get(id) { try { return await getAudio(`${ID_PREFIX}${id}`); } catch { return undefined; } },
  async remove(id) { await removeAudio(`${ID_PREFIX}${id}`); },
};

function validateOwnedUri(uri: string): string {
  if (!uri.startsWith(ID_PREFIX)) throw new Error('This staged recording is not owned by the recovery service.');
  const id = uri.slice(ID_PREFIX.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('This staged recording is not owned by the recovery service.');
  }
  return id;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readBoundedBlob(blob: Blob): Promise<{ bytes: Uint8Array; hash: string }> {
  assertRecoveryByteLength(blob.size);
  const buffer = await blob.arrayBuffer();
  if (buffer.byteLength !== blob.size) throw new Error('The selected recording changed while it was being read.');
  assertRecoveryByteLength(buffer.byteLength);
  const bytes = new Uint8Array(buffer);
  return { bytes, hash: await hashBytes(bytes) };
}

async function probeDuration(blob: Blob, maxDurationSeconds: number): Promise<Pick<AudioRecoveryMetadata, 'durationStatus' | 'durationSeconds'>> {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) throw new Error('The maximum recording duration is invalid.');
  const objectUrl = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  try {
    const audio = new Audio();
    return await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer !== undefined) clearTimeout(timer);
        try { audio.removeEventListener('loadedmetadata', onLoaded); } catch { /* cleanup is best effort */ }
        try { audio.removeEventListener('error', onError); } catch { /* cleanup is best effort */ }
        try { audio.removeEventListener('abort', onError); } catch { /* cleanup is best effort */ }
        try { audio.pause(); } catch { /* cleanup is best effort */ }
        try { audio.removeAttribute('src'); } catch { /* cleanup is best effort */ }
        try { audio.load(); } catch { /* cleanup is best effort */ }
        try { URL.revokeObjectURL(objectUrl); } catch { /* cleanup is best effort */ }
      };
      const finish = (result?: Pick<AudioRecoveryMetadata, 'durationStatus' | 'durationSeconds'>, error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(result!);
      };
      const onLoaded = () => {
        try { finish(boundedRecoveryDuration(audio.duration, maxDurationSeconds)); }
        catch (error) { finish(undefined, error instanceof Error ? error : new Error('The audio duration is invalid.')); }
      };
      const onError = () => finish(undefined, new Error('The selected recording could not be loaded as audio.'));
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.addEventListener('abort', onError, { once: true });
      timer = setTimeout(() => finish(undefined, new Error('The selected recording did not finish loading within 10 seconds.')), PROBE_TIMEOUT_MS);
      audio.src = objectUrl;
      audio.load();
    });
  } catch (error) {
    if (!cleaned) URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function metadataFor(blob: Blob, fileName: string, mimeType: string, maxDurationSeconds: number): Promise<AudioRecoveryMetadata> {
  const { bytes, hash } = await readBoundedBlob(blob);
  const format = validateRecoveryFormat(fileName, mimeType, bytes);
  const duration = await probeDuration(blob, maxDurationSeconds);
  return {
    fileName: safeAudioFileName(fileName, format),
    format,
    mimeType: RECOVERY_FORMATS[format].mimeType,
    byteLength: bytes.byteLength,
    sha256: hash,
    ...duration,
  };
}

export function createWebRecordingRecoveryService(store: RecoveryBlobStore = persistentStore): RecordingRecoveryService {
  return {
    async pickAndStage({ maxDurationSeconds }) {
      if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) throw new Error('The maximum recording duration is invalid.');
      const result = await DocumentPicker.getDocumentAsync({ type: ['audio/*'], multiple: false, copyToCacheDirectory: true, base64: false });
      if (result.canceled) return null;
      if (result.assets.length !== 1) throw new Error('Choose one audio file at a time.');
      const asset = result.assets[0];
      const file = asset?.file;
      if (!file || !(file instanceof Blob)) throw new Error('The browser did not provide the selected file contents. Choose a local audio file and try again.');
      // Check the browser's actual File size before any reads or copies.
      assertRecoveryByteLength(file.size);
      const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      validateRecoveryFormat(asset.name, asset.mimeType || file.type, header);
      const id = crypto.randomUUID();
      try {
        await store.put(id, file);
        const stagedBlob = await store.get(id);
        if (!stagedBlob) throw new Error('The staged recording could not be read back from local storage.');
        // Revalidate after staging and ensure the exact local copy is intact.
        const stagedMetadata = await metadataFor(stagedBlob, asset.name, asset.mimeType || file.type, maxDurationSeconds);
        return { uri: `${ID_PREFIX}${id}`, metadata: stagedMetadata };
      } catch (error) {
        // The UUID was generated for this attempt, so cleanup can only touch this new stage.
        await store.remove(id).catch(() => undefined);
        throw error;
      }
    },
    async inspect(staged: StagedRecording, { maxDurationSeconds }) {
      const id = validateOwnedUri(staged.uri);
      const blob = await store.get(id);
      if (!blob) throw new Error('The staged recording is missing from local storage.');
      const metadata = await metadataFor(blob, staged.metadata.fileName, staged.metadata.mimeType, maxDurationSeconds);
      if (metadata.byteLength !== staged.metadata.byteLength || metadata.sha256 !== staged.metadata.sha256) {
        throw new Error('The staged recording has changed since it was selected.');
      }
      return metadata;
    },
    async remove(staged) {
      const id = validateOwnedUri(staged.uri);
      await store.remove(id);
    },
  };
}

export const recordingRecoveryService = createWebRecordingRecoveryService();

// Kept exported for unit tests and narrow integrations; format validation still relies on
// the signature and the browser's successful local media probe.
export { boundedAudioFormatFromSignature, MAX_RECOVERY_BYTES };
