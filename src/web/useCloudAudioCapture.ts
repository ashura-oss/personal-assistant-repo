import { useBrowserAudioCapture } from '../audio/useBrowserAudioCapture';
import type { AudioCapture } from '../audio/types';
import { createTemporaryAudioStore } from './temporaryAudioStore';

export type CloudAudioCapture = AudioCapture & {
  /** Reads the RAM-only clip for a future explicit upload/save action. */
  readTemporaryClip(uri: string): Promise<Blob>;
};

/** A cloud workspace capture stays in this hook's RAM until an explicit commit or discard. */
export function useCloudAudioCapture(): CloudAudioCapture {
  const capture = useBrowserAudioCapture({ createStore: createTemporaryAudioStore, unmountPolicy: 'discard', commitPolicy: 'remove' });
  return { ...capture, readTemporaryClip: capture.readClip };
}
