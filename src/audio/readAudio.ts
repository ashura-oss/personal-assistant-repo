import { Platform } from 'react-native';
import * as NativeAudio from './readAudio.native';
import * as WebAudio from './readAudio.web';
import type { AudioUpload } from './readAudio.types';

export function loadAudioForUpload(uri: string): Promise<AudioUpload> {
  return Platform.OS === 'web' ? WebAudio.loadAudioForUpload(uri) : NativeAudio.loadAudioForUpload(uri);
}

export function audioPlaybackUri(uri: string) {
  return Platform.OS === 'web' ? WebAudio.audioPlaybackUri(uri) : NativeAudio.audioPlaybackUri(uri);
}

export function removeAudio(uri: string) {
  return Platform.OS === 'web' ? WebAudio.removeAudio(uri) : NativeAudio.removeAudio(uri);
}
