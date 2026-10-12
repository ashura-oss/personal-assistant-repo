import * as FileSystem from 'expo-file-system/legacy';
import type { AudioUpload } from './readAudio.types';
import { RECOVERY_FORMATS } from './formats';
import type { RecoveryFormat } from './recovery.types';

function formatFromUri(uri: string): RecoveryFormat | 'caf' {
  const pathname = uri.split(/[?#]/, 1)[0];
  const extension = pathname.split('.').pop()?.toLowerCase();
  if (extension === 'caf') return 'caf'; // Existing device captures keep their CAF compatibility.
  if (extension === 'm4a' || extension === 'mp3' || extension === 'wav' || extension === 'webm' || extension === 'ogg') return extension;
  throw new Error('This audio format cannot be uploaded. Save the recording as M4A, MP3, WAV, WebM, or OGG and try again.');
}

export async function loadAudioForUpload(uri: string): Promise<AudioUpload> {
  const format = formatFromUri(uri);
  const mimeType = format === 'caf' ? 'audio/x-caf' : RECOVERY_FORMATS[format].mimeType;
  return { platform: 'native' as const, uri, fileName: `still-recording.${format}`, mimeType };
}

export async function audioPlaybackUri(uri: string): Promise<string> { return uri; }
export async function removeAudio(uri: string): Promise<void> { await FileSystem.deleteAsync(uri, { idempotent: true }); }
