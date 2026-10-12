import * as FileSystem from 'expo-file-system/legacy';
import type { AudioUpload } from './readAudio.types';

export async function loadAudioForUpload(uri: string): Promise<AudioUpload> {
  const ext = uri.split('.').pop()?.toLowerCase() === 'caf' ? 'caf' : 'm4a';
  return { platform: 'native' as const, uri, fileName: `still-recording.${ext}`, mimeType: ext === 'caf' ? 'audio/x-caf' : 'audio/mp4' };
}

export async function audioPlaybackUri(uri: string): Promise<string> { return uri; }
export async function removeAudio(uri: string): Promise<void> { await FileSystem.deleteAsync(uri, { idempotent: true }); }
