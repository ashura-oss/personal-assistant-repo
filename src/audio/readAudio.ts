import { Platform } from 'react-native';
import * as NativeAudio from './readAudio.native';
import * as WebAudio from './readAudio.web';
import type { AudioUpload } from './readAudio.types';
import type { PrivacyAudioBoundary } from '../privacy/audioBoundary';

export function loadAudioForUpload(uri: string, boundary?: PrivacyAudioBoundary): Promise<AudioUpload> {
  const read = () => Platform.OS === 'web' ? WebAudio.loadAudioForUpload(uri) : NativeAudio.loadAudioForUpload(uri);
  return boundary ? boundary.withAudioRead(read) : read();
}

export function audioPlaybackUri(uri: string, boundary?: PrivacyAudioBoundary) {
  const read = () => Platform.OS === 'web' ? WebAudio.audioPlaybackUri(uri) : NativeAudio.audioPlaybackUri(uri);
  return boundary ? boundary.withAudioRead(read) : read();
}

export function removeAudio(uri: string, boundary?: PrivacyAudioBoundary) {
  const remove = () => Platform.OS === 'web' ? WebAudio.removeAudio(uri) : NativeAudio.removeAudio(uri);
  return boundary ? boundary.withAudioWrite(remove) : remove();
}
