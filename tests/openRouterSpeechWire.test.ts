import { describe, expect, it } from 'vitest';
import { SPEECH_MAX_AUDIO_BYTES, SPEECH_MAX_TRANSCRIPT_BYTES } from '../src/transcription';
import { getOpenRouterSpeechProfile } from '../src/transcription/openRouterSpeechProfiles';
import {
  buildOpenRouterSpeechWireRequest,
  OPENROUTER_SPEECH_ENDPOINT,
  OPENROUTER_SPEECH_MODEL,
  OPENROUTER_SPEECH_DEFAULT_MODEL,
  parseOpenRouterSpeechResponse,
} from '../src/services/openRouterSpeechWire';

describe('OpenRouter speech wire foundation', () => {
  it('builds exact base64 JSON bytes and fixed privacy routing without a key or URL', () => {
    const source = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const request = buildOpenRouterSpeechWireRequest({ bytes: source, format: 'm4a' });
    source.fill(42);
    expect(request.endpoint).toBe(OPENROUTER_SPEECH_ENDPOINT);
    expect(JSON.parse(request.body)).toEqual({
      model: OPENROUTER_SPEECH_DEFAULT_MODEL,
      input_audio: { data: 'AAEC/f7/', format: 'm4a' },
      response_format: 'json',
      provider: { zdr: true, data_collection: 'deny' },
    });
    expect(request.audioBytes).toBe(6);
    expect(request.profileVersion).toBe(2);
    expect(request.model).toBe(OPENROUTER_SPEECH_DEFAULT_MODEL);
    expect(request.body).not.toContain('data:audio');
    expect(request.body).not.toMatch(/authorization|api.key/i);
  });

  it('retains an explicit immutable profile-1 builder for legacy request receipts', () => {
    const request = buildOpenRouterSpeechWireRequest({ bytes: new Uint8Array([1, 2, 3]), format: 'm4a', profileVersion: 1 });
    expect(request).toMatchObject({ profileVersion: 1, model: OPENROUTER_SPEECH_MODEL });
    expect(JSON.parse(request.body).model).toBe(OPENROUTER_SPEECH_MODEL);
  });

  it('accepts each supported audio format and rejects empty, oversized, and unsupported inputs', () => {
    const bytes = new Uint8Array([1]);
    for (const format of ['m4a', 'wav', 'mp3', 'webm', 'ogg'] as const) {
      expect(JSON.parse(buildOpenRouterSpeechWireRequest({ bytes, format }).body).input_audio.format).toBe(format);
    }
    expect(() => buildOpenRouterSpeechWireRequest({ bytes: new Uint8Array(), format: 'wav' })).toThrow();
    expect(() => buildOpenRouterSpeechWireRequest({ bytes: new Uint8Array(SPEECH_MAX_AUDIO_BYTES + 1), format: 'wav' })).toThrow();
    expect(() => buildOpenRouterSpeechWireRequest({ bytes, format: 'caf' as never })).toThrow();
  });

  it('applies the profile-2 25,000,000-byte media bound without changing legacy profile 1', () => {
    expect(() => buildOpenRouterSpeechWireRequest({ bytes: new Uint8Array(25_000_001), format: 'm4a' })).toThrow(/profile size limit/i);
    expect(getOpenRouterSpeechProfile(1)?.maxAudioBytes).toBe(SPEECH_MAX_AUDIO_BYTES);
    expect(getOpenRouterSpeechProfile(2)?.maxAudioBytes).toBe(25_000_000);
  });

  it('normalizes valid transcript text and keeps only actual bounded usage', () => {
    expect(parseOpenRouterSpeechResponse({
      text: '  hello\r\nworld  ',
      usage: { seconds: 4.125, input_tokens: 75, output_tokens: 14, total_tokens: 89, cost: 0.00000725, ignored: 'private' },
    })).toEqual({
      kind: 'transcript',
      transcript: 'hello\nworld',
      usage: { seconds: 4.125, inputTokens: 75, outputTokens: 14, totalTokens: 89, costUsd: 0.00000725 },
    });
    expect(parseOpenRouterSpeechResponse({ text: 'ok', usage: { cost: 0, seconds: 0 } }))
      .toEqual({ kind: 'transcript', transcript: 'ok', usage: { seconds: 0, costUsd: 0 } });
  });

  it('preserves safe usage when transcript is silent, invalid, or too large', () => {
    expect(parseOpenRouterSpeechResponse({ text: ' \r\n ', usage: { cost: 0.25 } }))
      .toEqual({ kind: 'no_speech', usage: { costUsd: 0.25 } });
    expect(parseOpenRouterSpeechResponse({ text: '\ud800', usage: { seconds: 2 } }))
      .toEqual({ kind: 'invalid', code: 'invalid_text', usage: { seconds: 2 } });
    expect(parseOpenRouterSpeechResponse({ text: 'x'.repeat(SPEECH_MAX_TRANSCRIPT_BYTES + 1), usage: { cost: 1 } }))
      .toEqual({ kind: 'invalid', code: 'transcript_too_large', usage: { costUsd: 1 } });
    expect(parseOpenRouterSpeechResponse({ text: 'x\u0000y', usage: { input_tokens: 2 } }))
      .toEqual({ kind: 'invalid', code: 'invalid_text', usage: { inputTokens: 2 } });
  });

  it('omits malformed or unreported usage rather than estimating it', () => {
    expect(parseOpenRouterSpeechResponse({ text: 'ready', usage: { seconds: -1, cost: Number.NaN, input_tokens: 1.5, output_tokens: 5 } }))
      .toEqual({ kind: 'transcript', transcript: 'ready', usage: { outputTokens: 5 } });
    expect(parseOpenRouterSpeechResponse({ text: 'ready' })).toEqual({ kind: 'transcript', transcript: 'ready' });
    expect(parseOpenRouterSpeechResponse({ text: 22, message: 'raw provider text' }))
      .toEqual({ kind: 'invalid', code: 'invalid_response' });
    expect(parseOpenRouterSpeechResponse({
      text: 'safe',
      api_key: 'SECRET_CANARY',
      error: { message: 'SECRET_CANARY' },
      usage: { cost: 0, secret: 'SECRET_CANARY' },
    })).toEqual({ kind: 'transcript', transcript: 'safe', usage: { costUsd: 0 } });
  });
});
