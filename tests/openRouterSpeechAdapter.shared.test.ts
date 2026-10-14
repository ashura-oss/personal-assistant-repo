import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, Note } from '../src/core';
import type { PreparedSpeechAudio, SpeechAudioService } from '../src/audio/speechUpload.types';
import { SharedOpenRouterSpeechAdapter } from '../src/services/openRouterSpeechAdapter.shared';
import type { OpenRouterSpeechCall, OpenRouterSpeechClient } from '../src/services/openRouterSpeech';
import { OPENROUTER_SPEECH_ENDPOINT, type OpenRouterSpeechParseResult } from '../src/services/openRouterSpeechWire';

const leaseId = '11111111-1111-4111-8111-111111111111';
const note = { id: '22222222-2222-4222-8222-222222222222', title: 'Audio', transcript: '', audioUri: 'test:audio', durationSeconds: 2, createdAt: '2026-10-14T00:00:00.000Z', status: 'recorded', revision: 1 } as Note;
const settings = { speechProvider: 'openrouter', speechEnabled: true, maxAudioSeconds: 600 } as AppSettings;
const bytes = new Uint8Array([1, 2, 3, 4]);
const prepared: PreparedSpeechAudio = Object.freeze({
  leaseId, platform: 'web', format: 'm4a', mimeType: 'audio/mp4', byteLength: bytes.byteLength,
  sha256: 'a'.repeat(64), durationSeconds: 2,
  upload: Object.freeze({ blob: new Blob([bytes], { type: 'audio/mp4' }), fileName: 'clip.m4a' }),
});

function audioService(overrides: Partial<SpeechAudioService> = {}): SpeechAudioService {
  return {
    prepare: vi.fn(async () => prepared),
    verify: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

function client(result: OpenRouterSpeechParseResult = { kind: 'transcript', transcript: 'recognized', usage: { costUsd: 0, seconds: 2 } }) {
  const transcribe = vi.fn(async (call: OpenRouterSpeechCall) => {
    await call.onBeforeDispatch();
    call.assertBeforeStart?.();
    return result;
  });
  const retryPendingCleanup = vi.fn(async () => undefined);
  return { transcribe, retryPendingCleanup } satisfies Pick<OpenRouterSpeechClient, 'transcribe' | 'retryPendingCleanup'>;
}

describe('shared OpenRouter speech adapter Node boundary', () => {
  it('runs with injected Node ports, preserves actual usage, and settles staged lease cleanup', async () => {
    const release = vi.fn(async () => undefined);
    const audio = audioService({ release });
    const provider = client();
    const sha256 = vi.fn(async () => 'a'.repeat(64));
    const adapter = new SharedOpenRouterSpeechAdapter({ audio, client: provider, sha256 });
    const onAttempt = vi.fn(async () => undefined);
    const result = await adapter.transcribe(note, settings, undefined, onAttempt, () => undefined, () => undefined, leaseId);

    expect(sha256).toHaveBeenCalledWith(bytes);
    expect(provider.transcribe).toHaveBeenCalledWith(expect.objectContaining({ operationId: leaseId, request: expect.objectContaining({ endpoint: OPENROUTER_SPEECH_ENDPOINT }) }));
    expect(result).toMatchObject({ outcome: 'completed', transcript: 'recognized', unknownCharge: false, usage: { costUsd: 0 } });
    await result.cleanupPromise;
    expect(release).toHaveBeenCalledWith(leaseId);
  });

  it('requires all shared ports at construction and keeps unknown-charge behavior', async () => {
    const audio = audioService();
    const provider = client({ kind: 'transcript', transcript: 'recognized' });
    expect(() => new SharedOpenRouterSpeechAdapter({ audio, client: provider, sha256: undefined } as never)).toThrow('requires audio, client, and SHA-256 ports');

    const adapter = new SharedOpenRouterSpeechAdapter({ audio, client: provider, sha256: async () => 'a'.repeat(64) });
    const result = await adapter.transcribe(note, settings, undefined, async () => undefined, () => undefined, () => undefined, leaseId);
    expect(result).toMatchObject({ outcome: 'completed', unknownCharge: true });
    await result.cleanupPromise;
  });
});
