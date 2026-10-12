import { getAudio, removeAudio as removeBlob } from './blobStore.web';
import type { AudioUpload } from './readAudio.types';
import { boundedAudioFormatFromSignature, RECOVERY_FORMATS } from './formats';

export async function loadAudioForUpload(uri: string): Promise<AudioUpload> {
  const blob = await getAudio(uri);
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const format = boundedAudioFormatFromSignature(bytes);
  if (!format) throw new Error('This audio format cannot be uploaded. Save the recording as M4A, MP3, WAV, WebM, or OGG and try again.');
  const declared = blob.type.split(';', 1)[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && !RECOVERY_FORMATS[format].mimeAliases.includes(declared)) {
    throw new Error('The recording format does not match its file details. Save it again and try uploading it.');
  }
  return { platform: 'web' as const, blob, fileName: `still-recording.${format}`, mimeType: RECOVERY_FORMATS[format].mimeType };
}

export async function audioPlaybackUri(uri: string): Promise<string> {
  return URL.createObjectURL(await getAudio(uri));
}

export async function removeAudio(uri: string): Promise<void> { await removeBlob(uri); }
