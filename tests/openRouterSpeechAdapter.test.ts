import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, Note } from '../src/core';
import type { PreparedSpeechAudio, SpeechAudioService } from '../src/audio/speechUpload.types';
import { OpenRouterSpeechAdapter } from '../src/services/openRouterSpeechAdapter';
import { OpenRouterSpeechClient } from '../src/services/openRouterSpeech';

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

function client(overrides: Partial<ConstructorParameters<typeof OpenRouterSpeechClient>[0]> = {}): OpenRouterSpeechClient {
  return new OpenRouterSpeechClient({
    withRequestOwnership: async (actual) => actual(),
    readCredentialSnapshot: async () => ({ key: 'closed-test-key', generation: 1 }),
    assertCredentialGeneration: (generation) => { if (generation !== 1) throw new Error('changed'); },
    assertBeforeStart: () => undefined,
    fetcher: async () => new Response(JSON.stringify({ text: 'recognized', usage: { cost: 0, total_tokens: 4 } }), { status: 200 }),
    ...overrides,
  });
}

describe('OpenRouterSpeechAdapter ownership and source binding', () => {
  it('rejects bytes that do not match the prepared snapshot digest before the durable attempt or POST', async () => {
    const release = vi.fn(async () => undefined);
    const audio = audioService({ release });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ text: 'must not send' }), { status: 200 }));
    const subject = new OpenRouterSpeechAdapter({ audio, client: client({ fetcher }), sha256: async () => 'b'.repeat(64) });
    const onAttempt = vi.fn(async () => undefined);

    await expect(subject.transcribe(note, settings, undefined, onAttempt, () => undefined, () => undefined, leaseId))
      .rejects.toMatchObject({ code: 'audio_changed', dispatched: false });
    expect(audio.prepare).toHaveBeenCalledWith(note, expect.objectContaining({ maxAudioBytes: 25_000_000 }));
    expect(onAttempt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(leaseId);
  });

  it('rejects a profile-2 audio snapshot over 25,000,000 bytes before durable dispatch', async () => {
    const audio = audioService({ prepare: vi.fn(async () => ({
      ...prepared, byteLength: 25_000_001,
    })) });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ text: 'must not send' }), { status: 200 }));
    const subject = new OpenRouterSpeechAdapter({ audio, client: client({ fetcher }), sha256: async () => 'a'.repeat(64) });
    const onAttempt = vi.fn(async () => undefined);

    await expect(subject.transcribe(note, settings, undefined, onAttempt, () => undefined, () => undefined, leaseId))
      .rejects.toMatchObject({ code: 'invalid_audio', dispatched: false });
    expect(onAttempt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the staged audio lease owned until the actual request promise settles', async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const release = vi.fn(async () => undefined);
    const audio = audioService({ release });
    const subject = new OpenRouterSpeechAdapter({
      audio,
      client: client({ withRequestOwnership: async (actual) => { entered(); await gate; return actual(); } }),
      sha256: async () => 'a'.repeat(64),
    });
    const work = subject.transcribe(note, settings, undefined, async () => undefined, () => undefined, () => undefined, leaseId);
    await started;

    await expect(subject.releaseUploadLease(leaseId)).rejects.toThrow('still owns this audio lease');
    expect(release).not.toHaveBeenCalled();

    finish();
    const result = await work;
    expect(result.unknownCharge).toBe(false); // Actual reported zero cost is known.
    await result.cleanupPromise;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses staged-audio release while the native request cancellation acknowledgement is pending', async () => {
    let cancelPending!: () => void;
    const notified = new Promise<void>((resolve) => { cancelPending = resolve; });
    let rejectLifetime!: (reason: Error) => void;
    const release = vi.fn(async () => undefined);
    const subject = new OpenRouterSpeechAdapter({
      audio: audioService({ release }),
      sha256: async () => 'a'.repeat(64),
      client: client({
        deadlineMs: 15,
        withResponseLifetime: (_url, init, _consume, onCancelPending, beforeStart) => new Promise<never>((_resolve, reject) => {
          rejectLifetime = reject;
          beforeStart?.();
          init.signal?.addEventListener('abort', () => {
            onCancelPending?.(async () => { rejectLifetime(new Error('native cancellation acknowledged')); });
            cancelPending();
          }, { once: true });
        }),
      }),
    });
    const work = subject.transcribe(note, settings, undefined, async () => undefined, () => undefined, () => undefined, leaseId);
    await notified;

    await expect(subject.releaseUploadLease(leaseId)).rejects.toThrow('still owns this audio lease');
    expect(release).not.toHaveBeenCalled();
    await subject.retryPendingCleanup(leaseId);
    await expect(work).rejects.toMatchObject({ code: 'timeout', dispatched: true, unknownCharge: true });
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('marks a successful transcript with missing cost as charge-unknown', async () => {
    const subject = new OpenRouterSpeechAdapter({
      audio: audioService(),
      client: client({ fetcher: async () => new Response(JSON.stringify({ text: 'recognized', usage: { total_tokens: 4 } }), { status: 200 }) }),
      sha256: async () => 'a'.repeat(64),
    });
    const result = await subject.transcribe(note, settings, undefined, async () => undefined, () => undefined, () => undefined, leaseId);
    expect(result).toMatchObject({ outcome: 'completed', unknownCharge: true, usage: { totalTokens: 4 } });
    await result.cleanupPromise;
  });
});
