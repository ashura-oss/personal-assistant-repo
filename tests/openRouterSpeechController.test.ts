import { describe, expect, it, vi } from 'vitest';
import type { AppState, Note } from '../src/core';
import type { PreparedSpeechAudio, SpeechAudioService } from '../src/audio/speechUpload.types';
import { AppControllerImpl } from '../src/services/controller';
import { OpenRouterSpeechAdapter } from '../src/services/openRouterSpeechAdapter';
import { OpenRouterSpeechClient } from '../src/services/openRouterSpeech';
import type { StateStore } from '../src/storage/contracts';

class MemoryStore implements StateStore {
  value?: AppState;
  saves = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.saves += 1; this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

const audioBytes = new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 77, 52, 65, 32]);
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeAudio(): SpeechAudioService {
  return {
    prepare: vi.fn(async (_note, options): Promise<PreparedSpeechAudio> => ({
      leaseId: options.leaseId, platform: 'web', format: 'm4a', mimeType: 'audio/mp4', byteLength: audioBytes.byteLength,
      sha256: 'a'.repeat(64), durationSeconds: 4.125,
      upload: { blob: new Blob([audioBytes], { type: 'audio/mp4' }), fileName: 'clip.m4a' },
    })),
    verify: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

describe('OpenRouter speech controller integration', () => {
  it('persists one provider-specific attempt before POST and keeps actual zero cost without Azure estimates', async () => {
    const store = new MemoryStore();
    const audio = makeAudio();
    const fetcher = vi.fn(async () => {
      const attempt = store.value?.transcription.attempts.at(-1);
      expect(attempt).toMatchObject({ provider: 'openrouter', dispatchStarted: true, outcome: 'pending' });
      expect(attempt).not.toHaveProperty('reservation');
      return response({ text: 'OpenRouter heard this.', usage: { cost: 0, total_tokens: 7 } });
    });
    const client = new OpenRouterSpeechClient({
      withRequestOwnership: async (actual) => actual(),
      readCredentialSnapshot: async () => ({ key: 'closed-fictional-key', generation: 1 }),
      assertCredentialGeneration: (expected) => { if (expected !== 1) throw new Error('changed'); },
      assertBeforeStart: () => undefined,
      fetcher: fetcher as unknown as typeof fetch,
    });
    const adapter = new OpenRouterSpeechAdapter({ audio, client, sha256: async () => 'a'.repeat(64) });
    const app = new AppControllerImpl(store, { speechOpenRouter: adapter }, { speechAudioService: audio, openRouterSpeechAdapter: adapter });
    await app.load();
    const note = await app.saveNote({ transcript: 'Captured audio.', audioUri: 'file:///private/documents/recording-1.m4a', durationSeconds: 4.125 });
    await app.saveSettings({ speechEnabled: true, speechProvider: 'openrouter' });

    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision }))
      .resolves.toMatchObject({ transcript: 'OpenRouter heard this.', revision: note.revision + 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const saved = store.value?.transcription.attempts.at(-1);
    expect(saved).toMatchObject({ provider: 'openrouter', profileVersion: 2, model: 'openai/whisper-large-v3-turbo', outcome: 'completed', actualUsage: { costUsd: 0, totalTokens: 7 }, unknownCharge: false });
    expect(saved).not.toHaveProperty('reservation');
    expect(saved).not.toHaveProperty('durationMilliseconds');
    expect(saved).not.toHaveProperty('billedEstimateSeconds');
    await vi.waitFor(() => expect(store.value?.transcription.cleanupLeases.at(-1)?.outcome).toBe('released'));
  });

  it('records the final credential fence as pre-dispatch when it changes after the durable attempt but before ownership', async () => {
    let credentialGeneration = 1;
    const store = new MemoryStore();
    const audio = makeAudio();
    const fetcher = vi.fn(async () => response({ text: 'must not be sent' }));
    const client = new OpenRouterSpeechClient({
      withRequestOwnership: async (actual) => { credentialGeneration += 1; return actual(); },
      readCredentialSnapshot: async () => ({ key: 'closed-fictional-key', generation: credentialGeneration }),
      assertCredentialGeneration: (expected) => { if (expected !== credentialGeneration) throw new Error('credential rotated'); },
      assertBeforeStart: () => undefined,
      fetcher: fetcher as unknown as typeof fetch,
    });
    const adapter = new OpenRouterSpeechAdapter({ audio, client, sha256: async () => 'a'.repeat(64) });
    const app = new AppControllerImpl(store, { speechOpenRouter: adapter }, { speechAudioService: audio, openRouterSpeechAdapter: adapter });
    await app.load();
    const note = await app.saveNote({ transcript: 'Captured audio.', audioUri: 'file:///private/documents/recording-1.m4a', durationSeconds: 4.125 });
    await app.saveSettings({ speechEnabled: true, speechProvider: 'openrouter' });

    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toMatchObject({ code: 'stale_credential', dispatched: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.value?.transcription.attempts.at(-1)).toMatchObject({ provider: 'openrouter', outcome: 'failed', dispatchStarted: false, code: 'stale_credential' });
    expect(store.value?.transcription.attempts.at(-1)).not.toHaveProperty('reservation');
  });

  it('runs the per-call note fence after writer acquisition and saves no false pending dispatch when the note changes', async () => {
    const store = new MemoryStore();
    let app!: AppControllerImpl;
    let note!: Note;
    const audio = makeAudio();
    const fetcher = vi.fn(async () => response({ text: 'must not be sent' }));
    const client = new OpenRouterSpeechClient({
      withRequestOwnership: async (actual) => {
        await app.updateTranscript(note.id, 'Changed before POST.');
        return actual();
      },
      readCredentialSnapshot: async () => ({ key: 'closed-fictional-key', generation: 1 }),
      assertCredentialGeneration: (expected) => { if (expected !== 1) throw new Error('changed'); },
      assertBeforeStart: () => undefined,
      fetcher: fetcher as unknown as typeof fetch,
    });
    const adapter = new OpenRouterSpeechAdapter({ audio, client, sha256: async () => 'a'.repeat(64) });
    app = new AppControllerImpl(store, { speechOpenRouter: adapter }, { speechAudioService: audio, openRouterSpeechAdapter: adapter });
    await app.load();
    note = await app.saveNote({ transcript: 'Captured audio.', audioUri: 'file:///private/documents/recording-1.m4a', durationSeconds: 4.125 });
    await app.saveSettings({ speechEnabled: true, speechProvider: 'openrouter' });

    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toMatchObject({ code: 'pre_dispatch', dispatched: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.value?.transcription.attempts.at(-1)).toMatchObject({ provider: 'openrouter', outcome: 'failed', dispatchStarted: false });
  });

  it('retains actual provider usage but never applies a transcript after the note changes in flight', async () => {
    const store = new MemoryStore();
    const entered = deferred<void>();
    const finish = deferred<void>();
    const audio = makeAudio();
    const fetcher = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
      return response({ text: 'must not overwrite the edited note', usage: { cost: 0.003, total_tokens: 12 } });
    });
    const client = new OpenRouterSpeechClient({
      withRequestOwnership: async (actual) => actual(),
      readCredentialSnapshot: async () => ({ key: 'closed-fictional-key', generation: 1 }),
      assertCredentialGeneration: (expected) => { if (expected !== 1) throw new Error('changed'); },
      assertBeforeStart: () => undefined,
      fetcher: fetcher as unknown as typeof fetch,
    });
    const adapter = new OpenRouterSpeechAdapter({ audio, client, sha256: async () => 'a'.repeat(64) });
    const app = new AppControllerImpl(store, { speechOpenRouter: adapter }, { speechAudioService: audio, openRouterSpeechAdapter: adapter });
    await app.load();
    const note = await app.saveNote({ transcript: 'Captured audio.', audioUri: 'file:///private/documents/recording-1.m4a', durationSeconds: 4.125 });
    await app.saveSettings({ speechEnabled: true, speechProvider: 'openrouter' });
    const work = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await entered.promise;
    await app.updateTranscript(note.id, 'User edit made while transcription was in flight.');
    finish.resolve();

    await expect(work).rejects.toThrow(/changed while transcription|valid provider result/i);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.transcript).toBe('User edit made while transcription was in flight.');
    expect(store.value?.transcription.attempts.at(-1)).toMatchObject({
      provider: 'openrouter', outcome: 'discarded', code: 'discarded', unknownCharge: false,
      actualUsage: { costUsd: 0.003, totalTokens: 12 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'successful text with no reported cost', payload: { text: 'Transcript without invoice data.', usage: { total_tokens: 5 } }, outcome: 'completed', code: undefined, unknownCharge: true, transcript: 'Transcript without invoice data.' },
    { label: 'no-speech response with actual cost', payload: { text: ' ', usage: { cost: 0.002, total_tokens: 2 } }, outcome: 'no_speech', code: 'no_speech', unknownCharge: false, transcript: 'Captured audio.' },
    { label: 'invalid text response with reported zero cost', payload: { text: '\u0001', usage: { cost: 0, total_tokens: 1 } }, outcome: 'failed', code: 'invalid_response', unknownCharge: false, transcript: 'Captured audio.' },
  ])('preserves OpenRouter billing independently of result validity: $label', async ({ payload, outcome, code, unknownCharge, transcript }) => {
    const store = new MemoryStore();
    const audio = makeAudio();
    const client = new OpenRouterSpeechClient({
      withRequestOwnership: async (actual) => actual(),
      readCredentialSnapshot: async () => ({ key: 'closed-fictional-key', generation: 1 }),
      assertCredentialGeneration: (expected) => { if (expected !== 1) throw new Error('changed'); },
      assertBeforeStart: () => undefined,
      fetcher: async () => response(payload),
    });
    const adapter = new OpenRouterSpeechAdapter({ audio, client, sha256: async () => 'a'.repeat(64) });
    const app = new AppControllerImpl(store, { speechOpenRouter: adapter }, { speechAudioService: audio, openRouterSpeechAdapter: adapter });
    await app.load();
    const note = await app.saveNote({ transcript: 'Captured audio.', audioUri: 'file:///private/documents/recording-1.m4a', durationSeconds: 4.125 });
    await app.saveSettings({ speechEnabled: true, speechProvider: 'openrouter' });

    const action = app.transcribeNote(note.id, { expectedRevision: note.revision });
    if (outcome === 'completed') await expect(action).resolves.toMatchObject({ transcript });
    else await expect(action).rejects.toBeInstanceOf(Error);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.transcript).toBe(transcript);
    expect(store.value?.transcription.attempts.at(-1)).toMatchObject({ provider: 'openrouter', outcome, unknownCharge, ...(code ? { code } : {}) });
    expect(store.value?.transcription.attempts.at(-1)).not.toHaveProperty('reservation');
    expect(store.value?.transcription.attempts.at(-1)).not.toHaveProperty('durationMilliseconds');
    expect(store.value?.transcription.attempts.at(-1)).not.toHaveProperty('billedEstimateSeconds');
  });
});
