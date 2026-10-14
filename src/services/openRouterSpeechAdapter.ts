import * as Crypto from 'expo-crypto';
import type { SpeechAudioService } from '../audio/speechUpload.types';
import type { OpenRouterSpeechClient } from './openRouterSpeech';
import { SharedOpenRouterSpeechAdapter } from './openRouterSpeechAdapter.shared';

export interface OpenRouterSpeechAdapterOptions {
  readonly audio: SpeechAudioService;
  readonly client: OpenRouterSpeechClient;
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
}

/** Native wrapper preserving the existing public API and Expo-backed SHA fallback. */
export class OpenRouterSpeechAdapter extends SharedOpenRouterSpeechAdapter {
  constructor(options: OpenRouterSpeechAdapterOptions) {
    super({ ...options, sha256: options.sha256 ?? hashBytes });
  }
}

function hashBytes(bytes: Uint8Array): Promise<string> {
  return Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes.slice().buffer as ArrayBuffer)
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''));
}
