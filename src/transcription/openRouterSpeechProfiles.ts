/** Fixed OpenRouter transcription request profiles retained with their immutable receipts. */
export const OPENROUTER_SPEECH_PROFILES = Object.freeze({
  1: Object.freeze({ version: 1 as const, model: 'openai/gpt-4o-mini-transcribe' as const, maxAudioBytes: 40 * 1024 * 1024 }),
  2: Object.freeze({ version: 2 as const, model: 'openai/whisper-large-v3-turbo' as const, maxAudioBytes: 25_000_000 }),
});

export type OpenRouterSpeechProfileVersion = keyof typeof OPENROUTER_SPEECH_PROFILES;
export const OPENROUTER_SPEECH_LEGACY_PROFILE_VERSION = 1 as const;
export const OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION = 2 as const;
export const OPENROUTER_SPEECH_LEGACY_MODEL = OPENROUTER_SPEECH_PROFILES[OPENROUTER_SPEECH_LEGACY_PROFILE_VERSION].model;
export const OPENROUTER_SPEECH_DEFAULT_MODEL = OPENROUTER_SPEECH_PROFILES[OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION].model;

export type OpenRouterSpeechModel = typeof OPENROUTER_SPEECH_PROFILES[OpenRouterSpeechProfileVersion]['model'];

export function getOpenRouterSpeechProfile(version: unknown): (typeof OPENROUTER_SPEECH_PROFILES)[OpenRouterSpeechProfileVersion] | undefined {
  return version === 1 || version === 2 ? OPENROUTER_SPEECH_PROFILES[version] : undefined;
}

export function isOpenRouterSpeechModelProfile(version: unknown, model: unknown): model is OpenRouterSpeechModel {
  const profile = getOpenRouterSpeechProfile(version);
  return profile !== undefined && profile.model === model;
}
