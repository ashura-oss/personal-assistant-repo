import { Platform } from 'react-native';
import type { SpeechAudioService } from './speechUpload.types';

export type { PreparedSpeechAudio, SpeechAudioService, SpeechAudioCrypto, NativeSpeechAudioIO } from './speechUpload.types';

export function createSpeechAudioService(): SpeechAudioService {
  const resolve = async () => Platform.OS === 'web'
    ? (await import('./speechUpload.web')).webSpeechAudioService
    : (await import('./speechUpload.native')).nativeSpeechAudioService;
  return {
    async prepare(note, options) { return (await resolve()).prepare(note, options); },
    async verify(prepared, signal) { return (await resolve()).verify(prepared, signal); },
    async release(leaseId) { return (await resolve()).release(leaseId); },
  };
}

export const speechAudioService = createSpeechAudioService();
