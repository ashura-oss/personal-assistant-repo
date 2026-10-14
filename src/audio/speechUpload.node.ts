import { createHash } from 'node:crypto';
import type { Note } from '../core';
import { validateSpeechAudioSnapshot, SPEECH_MAX_AUDIO_BYTES } from '../transcription/types';
import type { SpeechAudioService, PreparedSpeechAudio } from './speechUpload.types';
import type { RecoveryFormat } from './recovery.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_URI = /^still-media:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface NodePrivateAudioRepository {
  createSpeechLease(input: { noteId: string; noteRevision: number }): Promise<Readonly<{
    leaseId: string; mediaId: string; sha256: string; byteLength: number; durationSeconds: number;
    fileName: string; format: RecoveryFormat; mimeType: string;
  }>>;
  readSpeechLease(leaseId: string): Promise<Readonly<{ metadata: { sha256: string; byteLength: number }; bytes: Buffer }>>;
  verifySpeechLease(leaseId: string): Promise<void>;
  releaseSpeechLease(leaseId: string): Promise<void>;
}

/** Node-only adapter. It accepts opaque media URIs, never filesystem paths. */
export function createNodeSpeechAudioService(repository: NodePrivateAudioRepository): SpeechAudioService {
  const repositoryLeaseIds = new Map<string, string>();
  const releasePromises = new Map<string, Promise<void>>();
  const preparations = new Set<string>();
  let disposed = false;
  const assertActive = () => { if (disposed) throw new Error('Speech upload staging is no longer available in this workspace.'); };
  return {
    async prepare(note: Note, { leaseId, maxDurationSeconds, maxAudioBytes, signal }): Promise<PreparedSpeechAudio> {
      assertActive();
      if (signal?.aborted) throw signal.reason ?? new Error('Audio preparation was cancelled.');
      if (!UUID.test(leaseId)) throw new Error('Speech upload lease is invalid.');
      const uri = typeof note.audioUri === 'string' ? MEDIA_URI.exec(note.audioUri) : null;
      if (!uri) throw new Error('The note does not have an available server recording.');
      const byteLimit = maxAudioBytes ?? SPEECH_MAX_AUDIO_BYTES;
      if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0 || byteLimit > SPEECH_MAX_AUDIO_BYTES || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
        throw new Error('The maximum upload size or duration is invalid.');
      }
      if (repositoryLeaseIds.has(leaseId) || preparations.has(leaseId)) throw new Error('Speech upload lease is already owned.');
      preparations.add(leaseId);
      try {
      const preparedRef = await repository.createSpeechLease({ noteId: note.id, noteRevision: note.revision });
      // Record cleanup authority synchronously before any other validation or I/O await.
      repositoryLeaseIds.set(leaseId, preparedRef.leaseId);
      if (preparedRef.mediaId.toLowerCase() !== uri[1]!.toLowerCase()) {
        throw new Error('The note recording changed before upload preparation.');
      }
        if (preparedRef.byteLength > byteLimit || preparedRef.durationSeconds > Math.min(maxDurationSeconds, 600)) {
          throw new Error('Recording exceeds the selected upload limit.');
        }
        if (note.audioAttachment && (note.audioAttachment.byteLength !== preparedRef.byteLength ||
          note.audioAttachment.sha256.toLowerCase() !== preparedRef.sha256.toLowerCase() || note.audioAttachment.format !== preparedRef.format ||
          note.audioAttachment.mimeType !== preparedRef.mimeType || note.audioAttachment.fileName !== preparedRef.fileName)) {
          throw new Error('The note recording metadata changed before upload preparation.');
        }
        const read = await repository.readSpeechLease(preparedRef.leaseId);
        let blob: Blob;
        try {
          if (signal?.aborted) throw signal.reason ?? new Error('Audio preparation was cancelled.');
          if (read.bytes.byteLength !== preparedRef.byteLength || read.metadata.sha256 !== preparedRef.sha256) throw new Error('The selected recording changed before upload.');
          const blobBytes = new Uint8Array(read.bytes.buffer as ArrayBuffer, read.bytes.byteOffset, read.bytes.byteLength);
          blob = new Blob([blobBytes], { type: preparedRef.mimeType });
        }
        finally { read.bytes.fill(0); }
        const snapshot = validateSpeechAudioSnapshot({ leaseId, platform: 'server', format: preparedRef.format, mimeType: preparedRef.mimeType,
          byteLength: preparedRef.byteLength, sha256: preparedRef.sha256, durationSeconds: preparedRef.durationSeconds });
        assertActive();
        return Object.freeze({ ...snapshot, platform: 'server' as const, upload: Object.freeze({ blob, fileName: preparedRef.fileName }) });
      } finally { preparations.delete(leaseId); }
    },
    async verify(prepared, signal) {
      assertActive();
      if (signal?.aborted) throw signal.reason ?? new Error('Audio preparation was cancelled.');
      const repositoryLeaseId = repositoryLeaseIds.get(prepared.leaseId);
      if (prepared.platform !== 'server' || !repositoryLeaseId) throw new Error('Prepared audio lease is no longer owned.');
      if (!(prepared.upload.blob instanceof Blob) || prepared.upload.blob.size !== prepared.byteLength || prepared.upload.blob.type !== prepared.mimeType) throw new Error('Prepared audio does not match its immutable lease.');
      const bytes = new Uint8Array(await prepared.upload.blob.arrayBuffer());
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('Audio preparation was cancelled.');
        await repository.verifySpeechLease(repositoryLeaseId);
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== prepared.sha256.toLowerCase()) throw new Error('The private upload copy changed before dispatch.');
      } finally { bytes.fill(0); }
    },
    async release(leaseId) {
      if (!UUID.test(leaseId)) return;
      // The repository lease is tied to a different random ID, so release all live repository leases
      // through the prepared lease map below; it is intentionally never exposed to callers.
      const repositoryLease = repositoryLeaseIds.get(leaseId);
      if (!repositoryLease) return;
      const current = releasePromises.get(leaseId);
      if (current) return current;
      const operation = repository.releaseSpeechLease(repositoryLease).then(() => {
        if (repositoryLeaseIds.get(leaseId) === repositoryLease) repositoryLeaseIds.delete(leaseId);
      }).finally(() => {
        if (releasePromises.get(leaseId) === operation) releasePromises.delete(leaseId);
      });
      releasePromises.set(leaseId, operation);
      await operation;
    },
    disposeMemory() {
      disposed = true;
    },
  };
}
