import { getAudio, removeAudio as removeBlob } from './blobStore.web';
import type { AudioUpload } from './readAudio.types';

export async function loadAudioForUpload(uri: string): Promise<AudioUpload> {
  const blob = await getAudio(uri);
  const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'wav';
  return { platform: 'web' as const, blob, fileName: `still-recording.${ext}`, mimeType: blob.type || 'audio/webm' };
}

export async function audioPlaybackUri(uri: string): Promise<string> {
  return URL.createObjectURL(await getAudio(uri));
}

export async function removeAudio(uri: string): Promise<void> { await removeBlob(uri); }
