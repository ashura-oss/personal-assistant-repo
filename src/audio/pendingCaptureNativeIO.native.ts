import { createAudioPlayer } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { AudioDurationProbeError, measureAudioDuration } from './audioDurationProbe';
import type { AudioDurationPlayer, AudioDurationPlayerFactory } from './audioDurationProbe';
import { MAX_RECOVERY_BYTES } from './formats';
import { resolvePendingCaptureUri, validatePendingCapturePath } from '../storage/pendingCapture';
import type { PendingCaptureInspection } from '../storage/pendingCapture';
import type { PendingCaptureNativeIO, PendingCaptureNativeProbe } from './pendingCaptureNativeIO.types';

const RELEASE_ERROR = 'The pending recording source could not be released.';
const INVALID_FILE_ERROR = 'The pending recording file could not be inspected.';

type FileInfo = { exists: boolean; isDirectory?: boolean; size?: number };
type EmptyAudioSource = Record<string, never>;
type DetachableAudioPlayer = AudioDurationPlayer & { replace(source: EmptyAudioSource): void };

export type PendingCaptureNativeIODependencies = {
  documentDirectory: string | null;
  getInfo(uri: string): Promise<FileInfo>;
  delete(uri: string): Promise<void>;
  createPlayer(uri: string, options: { downloadFirst: false }): DetachableAudioPlayer;
  sharingAvailable(): Promise<boolean>;
  share(uri: string, options: { mimeType: string; dialogTitle: string }): Promise<void>;
};

function fileUri(documentDirectory: string | null, path: string): string {
  if (!documentDirectory) throw new Error('Pending recording storage is unavailable.');
  return resolvePendingCaptureUri(documentDirectory, path);
}

export function createPendingCaptureNativeIO(dependencies: PendingCaptureNativeIODependencies): PendingCaptureNativeIO {
  const ownedUri = (value: string): { uri: string; path: string } => {
    if (typeof value !== 'string') throw new Error('Pending recording path is invalid.');
    const directory = dependencies.documentDirectory;
    if (!directory) throw new Error('Pending recording storage is unavailable.');
    const prefix = `${directory.endsWith('/') ? directory : `${directory}/`}`;
    if (!value.startsWith(prefix)) throw new Error('Pending recording path is not owned by this app.');
    const path = validatePendingCapturePath(value.slice(prefix.length));
    if (fileUri(directory, path) !== value) throw new Error('Pending recording path is not canonical.');
    return { uri: value, path };
  };

  return {
    toRelativePath(uri) { return ownedUri(uri).path; },
    toUri(path) { return fileUri(dependencies.documentDirectory, validatePendingCapturePath(path)); },
    async exists(uri) {
      const owned = ownedUri(uri);
      const info = await dependencies.getInfo(owned.uri);
      if (!info || typeof info.exists !== 'boolean') throw new Error('Pending recording existence could not be verified.');
      return info.exists;
    },
    async remove(uri) {
      const owned = ownedUri(uri);
      let info: FileInfo;
      try { info = await dependencies.getInfo(owned.uri); }
      catch { throw new Error('Pending recording removal could not be verified.'); }
      if (!info || typeof info.exists !== 'boolean') throw new Error('Pending recording removal could not be verified.');
      if (!info.exists) return;
      if (info.isDirectory !== false) throw new Error('Pending recording removal is limited to an owned file.');
      await dependencies.delete(owned.uri);
    },
    async probe(uri): Promise<PendingCaptureNativeProbe> {
      const owned = ownedUri(uri);
      let info: FileInfo;
      try { info = await dependencies.getInfo(owned.uri); }
      catch { return { inspection: { outcome: 'invalid' } }; }
      if (!info || typeof info.exists !== 'boolean') return { inspection: { outcome: 'invalid' } };
      if (!info.exists) return { inspection: { outcome: 'missing' } };
      if (info.isDirectory !== false) return { inspection: { outcome: 'invalid' } };
      if (!Number.isSafeInteger(info.size) || (info.size as number) < 0 || (info.size as number) > MAX_RECOVERY_BYTES) {
        return { inspection: { outcome: 'invalid' } };
      }
      if (info.size === 0) return { inspection: { outcome: 'unknown' } };

      let player: DetachableAudioPlayer | undefined;
      let detached = false;
      let closed = false;
      const detachAndRemove = () => {
        if (closed) return;
        if (!detached) {
          try { player?.replace({}); }
          catch { throw new Error(RELEASE_ERROR); }
          detached = true;
        }
        closed = true;
        try { player?.remove(); } catch { /* source is detached; player teardown is best effort */ }
      };
      const factory: AudioDurationPlayerFactory = {
        create: (source) => {
          player = dependencies.createPlayer(source, { downloadFirst: false });
          return {
            get currentStatus() { return player!.currentStatus; },
            addListener: (event, listener) => player!.addListener(event, listener),
            remove: detachAndRemove,
          };
        },
      };

      let inspection: PendingCaptureInspection;
      try {
        const measurement = await measureAudioDuration(owned.uri, factory);
        inspection = measurement.outcome === 'known'
          ? { outcome: 'known', durationSeconds: measurement.durationSeconds }
          : { outcome: 'unknown' };
      } catch (error) {
        inspection = error instanceof AudioDurationProbeError && error.code === 'timeout'
          ? { outcome: 'unknown' }
          : { outcome: 'invalid' };
      }

      if (!detached && player) {
        let released = false;
        return {
          inspection,
          sourceRelease: {
            retry() {
              if (released) return;
              try { detachAndRemove(); }
              catch { throw new Error(RELEASE_ERROR); }
              released = true;
            },
          },
        };
      }
      return { inspection };
    },
    async export(uri) {
      const owned = ownedUri(uri);
      let info: FileInfo;
      try { info = await dependencies.getInfo(owned.uri); }
      catch { throw new Error(INVALID_FILE_ERROR); }
      if (!info || typeof info.exists !== 'boolean' || !info.exists || info.isDirectory !== false) throw new Error(INVALID_FILE_ERROR);
      if (!await dependencies.sharingAvailable()) throw new Error('Sharing is unavailable on this device.');
      await dependencies.share(owned.uri, { mimeType: 'audio/mp4', dialogTitle: 'Export recording' });
    },
  };
}

export const pendingCaptureNativeIO: PendingCaptureNativeIO = createPendingCaptureNativeIO({
  documentDirectory: FileSystem.documentDirectory,
  getInfo: async (uri) => await FileSystem.getInfoAsync(uri),
  delete: async (uri) => { await FileSystem.deleteAsync(uri, { idempotent: true }); },
  createPlayer: (uri, options) => createAudioPlayer(uri, options) as DetachableAudioPlayer,
  sharingAvailable: async () => await Sharing.isAvailableAsync(),
  share: async (uri, options) => { await Sharing.shareAsync(uri, options); },
});
