import { describe, expect, it, vi } from 'vitest';
import * as Crypto from 'expo-crypto';
import type { AppSettings, Note } from '../src/core';
import type { PreparedSpeechAudio, SpeechAudioService } from '../src/audio/speechUpload.types';
import { OpenRouterSpeechAdapter } from '../src/services/openRouterSpeechAdapter';
import { OpenRouterSpeechClient } from '../src/services/openRouterSpeech';

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: vi.fn(async (_algorithm: string, data: ArrayBuffer) => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(Buffer.from(data)).digest();
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
  }),
}));

const leaseId = '11111111-1111-4111-8111-111111111111';
const note = { id: '22222222-2222-4222-8222-222222222222', title: 'Audio', transcript: '', audioUri: 'test:audio', durationSeconds: 2, createdAt: '2026-10-14T00:00:00.000Z', status: 'recorded', revision: 1 } as Note;
const settings = { speechProvider: 'openrouter', speechEnabled: true, maxAudioSeconds: 600 } as AppSettings;
const bytes = new Uint8Array([1, 2, 3, 4]);

describe('native OpenRouter adapter SHA fallback', () => {
  it('uses the existing Expo digest when the optional native sha256 override is omitted', async () => {
    const { createHash } = await import('node:crypto');
    const prepared: PreparedSpeechAudio = {
      leaseId, platform: 'web', format: 'm4a', mimeType: 'audio/mp4', byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), durationSeconds: 2,
      upload: { blob: new Blob([bytes], { type: 'audio/mp4' }), fileName: 'clip.m4a' },
    };
    const audio: SpeechAudioService = { async prepare() { return prepared; }, async verify() {}, async release() {} };
    const client = new OpenRouterSpeechClient({
      withRequestOwnership: (request) => request(),
      readCredentialSnapshot: async () => ({ key: 'fixture-key', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
      fetcher: async () => new Response(JSON.stringify({ text: 'native wrapper fixture', usage: { cost: 0 } }), { status: 200 }),
    });
    const adapter = new OpenRouterSpeechAdapter({ audio, client });
    const result = await adapter.transcribe(note, settings, undefined, async () => undefined, () => undefined, () => undefined, leaseId);

    expect(Crypto.digest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'completed', transcript: 'native wrapper fixture', unknownCharge: false });
    await result.cleanupPromise;
  });
});
