import { useMemo } from 'react';
import { getAudio, putAudio, removeAudio } from './blobStore.web';
import type { PrivacyAudioBoundary } from '../privacy/audioBoundary';
import type { PendingCaptureJournalPort } from './pendingCaptureService.types';
import type { NativeAudioCaptureOptions } from './useAudioCapture.native';
import type { AudioCapture } from './types';
import { useBrowserAudioCapture } from './useBrowserAudioCapture';

/** Legacy native-compatible browser capture; stopped clips persist to IndexedDB as before. */
export function useAudioCapture(boundary?: PrivacyAudioBoundary, journal?: PendingCaptureJournalPort, options?: NativeAudioCaptureOptions): AudioCapture {
  const store = useMemo(() => ({
    isOpen: () => true,
    createUri: () => `indexeddb-audio:${crypto.randomUUID()}`,
    put: async (uri: string, blob: Blob) => { await putAudio(uri.replace(/^indexeddb-audio:/, ''), blob); },
    get: getAudio,
    remove: removeAudio,
  }), []);
  return useBrowserAudioCapture({ store, unmountPolicy: 'save_pending' }, boundary, journal, options);
}
