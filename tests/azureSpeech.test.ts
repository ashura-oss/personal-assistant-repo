import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, Note } from '../src/core';
import { AzureSpeechClient } from '../src/services/azure';
import { currentSpeechCredentialGeneration, readSpeechCredentialSnapshot, setCredentials } from '../src/services/credentials';
import { credentialStore } from '../src/storage/credentials';
import { SpeechTranscriptionError } from '../src/transcription';
import type { PreparedSpeechAudio, SpeechAudioService } from '../src/audio/speechUpload.types';

const leaseId = '11111111-1111-4111-8111-111111111111';
const blob = new Blob([new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0])], { type: 'audio/mp4' });
const prepared: PreparedSpeechAudio = Object.freeze({
  leaseId, platform: 'web', format: 'm4a', mimeType: 'audio/mp4', byteLength: blob.size,
  sha256: 'a'.repeat(64), durationSeconds: 12.345,
  upload: Object.freeze({ blob, fileName: 'test.m4a' }),
});
const audio: SpeechAudioService = {
  prepare: vi.fn(async () => prepared), verify: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
};
const note = { id: '22222222-2222-4222-8222-222222222222', title: 'test', transcript: '', audioUri: 'web:audio', durationSeconds: 12.345, createdAt: '2026-10-13T00:00:00.000Z', status: 'recorded', revision: 1 } as Note;
const settings = { speechEnabled: true, speechEndpoint: 'https://example.cognitiveservices.azure.com', maxAudioSeconds: 600 } as AppSettings;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function client(fetcher: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new AzureSpeechClient({ audio, fetcher, readKeySnapshot: async () => ({ key: 'test-key', generation: 3 }), currentCredentialGeneration: () => 3, assertCredentialGeneration: (value) => { if (value !== 3) throw new Error('stale'); }, randomUUID: () => leaseId, ...overrides });
}

describe('Azure Speech single-dispatch client', () => {
  it('sends exactly one multipart request and preserves provider milliseconds', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ durationMilliseconds: 12345, combinedPhrases: [{ text: '  hello\r\nworld  ' }] }));
    const reserve = vi.fn(async () => undefined);
    const result = await client(fetcher as unknown as typeof fetch).transcribe(note, settings, undefined, reserve);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://example.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).has('content-type')).toBe(false);
    expect((init.body as FormData).get('definition')).toBe(JSON.stringify({ locales: ['en-US'] }));
    expect(result).toMatchObject({ transcript: 'hello\nworld', durationMilliseconds: 12345, durationSeconds: 12.345, billedEstimateSeconds: 13, attempts: 1 });
    expect(result.cleanupPromise).toBeInstanceOf(Promise);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('runs source guard and credential generation fence immediately before dispatch', async () => {
    const fetcher = vi.fn(async () => response({ durationMilliseconds: 1000, combinedPhrases: [{ text: 'x' }] }));
    await expect(client(fetcher as unknown as typeof fetch).transcribe(note, settings, undefined, undefined, () => { throw new Error('stale source'); }))
      .rejects.toMatchObject({ code: 'pre_dispatch', dispatched: false });
    const stale = client(fetcher as unknown as typeof fetch, { assertCredentialGeneration: () => { throw new Error('changed'); } });
    await expect(stale.transcribe(note, settings)).rejects.toMatchObject({ code: 'stale_credential', dispatched: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels a stalled credential read before POST or reservation and does not wait for lease cleanup', async () => {
    let entered!: () => void;
    const readStarted = new Promise<void>((resolve) => { entered = resolve; });
    const neverSettles = new Promise<{ key: string | null; generation: number }>(() => undefined);
    const fetcher = vi.fn(async () => response({ durationMilliseconds: 1000, combinedPhrases: [{ text: 'must not send' }] }));
    const releaseNeverSettles = vi.fn(() => new Promise<void>(() => undefined));
    const audioService: SpeechAudioService = { prepare: vi.fn(async () => prepared), verify: vi.fn(async () => undefined), release: releaseNeverSettles };
    const subject = new AzureSpeechClient({ audio: audioService, fetcher: fetcher as unknown as typeof fetch, readKeySnapshot: () => { entered(); return neverSettles; }, randomUUID: () => leaseId });
    const controller = new AbortController();
    const reserve = vi.fn(async () => undefined);
    const request = subject.transcribe(note, settings, controller.signal, reserve);
    await readStarted;
    controller.abort(new Error('cancelled'));
    await expect(request).rejects.toMatchObject({ code: 'cancelled', dispatched: false, cleanupPromise: expect.any(Promise) });
    expect(reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(releaseNeverSettles).toHaveBeenCalledTimes(1);
  });

  it('classifies no-speech and invalid duration while retaining verified usage duration', async () => {
    const none = client(vi.fn(async () => response({ durationMilliseconds: 1001, combinedPhrases: [] })) as unknown as typeof fetch);
    await expect(none.transcribe(note, settings)).rejects.toMatchObject({ code: 'no_speech', dispatched: true, durationMilliseconds: 1001 });
    const invalid = client(vi.fn(async () => response({ durationMilliseconds: 0, combinedPhrases: [] })) as unknown as typeof fetch);
    await expect(invalid.transcribe(note, settings)).rejects.toMatchObject({ code: 'provider_unknown', dispatched: true, durationMilliseconds: undefined });
  });

  it('does not retry rejected, rate-limited, or server responses', async () => {
    for (const [status, code] of [[400, 'provider_rejected'], [429, 'provider_unknown'], [503, 'provider_unknown']] as const) {
      const fetcher = vi.fn(async () => new Response('failure', { status }));
      await expect(client(fetcher as unknown as typeof fetch).transcribe(note, settings)).rejects.toMatchObject({ code, dispatched: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('settles at deadline, retains lease until ignored-abort request settles, and blocks overlap', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const subject = client(fetcher as unknown as typeof fetch, { deadlineMs: 10 });
    let cleanup: Promise<void> | undefined;
    try { await subject.transcribe(note, settings); } catch (error) { cleanup = (error as SpeechTranscriptionError).cleanupPromise; expect(error).toMatchObject({ code: 'timeout', dispatched: true }); }
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(subject.transcribe(note, settings)).rejects.toMatchObject({ dispatched: false });
    finish(response({ durationMilliseconds: 1000, combinedPhrases: [{ text: 'late' }] }));
    await cleanup;
    expect(audio.release).toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed Unicode while preserving known duration on the typed outcome', async () => {
    const fetcher = vi.fn(async () => response({ durationMilliseconds: 2000, combinedPhrases: [{ text: String.fromCharCode(0xd800) }] }));
    await expect(client(fetcher as unknown as typeof fetch).transcribe(note, settings)).rejects.toMatchObject({ code: 'invalid_response', dispatched: true, durationMilliseconds: 2000 });
  });

  it('rejects oversized transcript text without truncating and retains provider duration', async () => {
    const fetcher = vi.fn(async () => response({ durationMilliseconds: 4321, combinedPhrases: [{ text: 'x'.repeat(128 * 1024 + 1) }] }));
    await expect(client(fetcher as unknown as typeof fetch).transcribe(note, settings)).rejects.toMatchObject({ code: 'invalid_response', dispatched: true, durationMilliseconds: 4321 });
  });

  it('rechecks the lock after concurrent preparation so at most one request starts', async () => {
    let entered = 0;
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const racingAudio: SpeechAudioService = {
      prepare: vi.fn(async (_note, options) => ({ ...prepared, leaseId: options.leaseId })),
      verify: vi.fn(async () => { entered += 1; if (entered <= 2) await gate; }),
      release: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn(async () => response({ durationMilliseconds: 1000, combinedPhrases: [{ text: 'sent' }] }));
    const subject = new AzureSpeechClient({ audio: racingAudio, fetcher: fetcher as unknown as typeof fetch, readKeySnapshot: async () => ({ key: 'key', generation: 3 }), assertCredentialGeneration: () => undefined, currentCredentialGeneration: () => 3, randomUUID: () => leaseId });
    const first = subject.transcribe(note, settings);
    const second = subject.transcribe(note, settings);
    while (entered < 2) await Promise.resolve();
    unlock();
    const outcomes = await Promise.allSettled([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
  });

  it('applies the same hard deadline while a response body ignores abort', async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }));
    const subject = client(fetcher as unknown as typeof fetch, { deadlineMs: 10 });
    await expect(subject.transcribe(note, settings)).rejects.toMatchObject({ code: 'timeout', dispatched: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serializes credential writes and fences a snapshot across a pending mutation', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const originalSet = credentialStore.set.bind(credentialStore);
    const setSpy = vi.spyOn(credentialStore, 'set').mockImplementationOnce(async (key, value) => { await gate; await originalSet(key, value); });
    const before = currentSpeechCredentialGeneration();
    const writing = setCredentials({ speechSubscriptionKey: 'new-key-a' });
    expect(currentSpeechCredentialGeneration()).toBe(before + 1);
    const snapshotPromise = readSpeechCredentialSnapshot();
    let snapshotFinished = false;
    void snapshotPromise.then(() => { snapshotFinished = true; });
    await Promise.resolve();
    expect(snapshotFinished).toBe(false);
    finish();
    await writing;
    await expect(snapshotPromise).resolves.toMatchObject({ key: 'new-key-a' });
    setSpy.mockRestore();
  });

  it('applies overlapping credential changes in request order rather than stale completion order', async () => {
    const originalSet = credentialStore.set.bind(credentialStore);
    let firstFinish!: () => void;
    const gate = new Promise<void>((resolve) => { firstFinish = resolve; });
    let first = true;
    const setSpy = vi.spyOn(credentialStore, 'set').mockImplementation(async (key, value) => {
      if (first) { first = false; await gate; }
      await originalSet(key, value);
    });
    const a = setCredentials({ speechSubscriptionKey: 'key-a' });
    const b = setCredentials({ speechSubscriptionKey: 'key-b' });
    firstFinish();
    await Promise.all([a, b]);
    await expect(readSpeechCredentialSnapshot()).resolves.toMatchObject({ key: 'key-b' });
    setSpy.mockRestore();
  });
});
