import { describe, expect, it, vi } from 'vitest';
import * as Crypto from 'expo-crypto';
import type { AppState, Note } from '../src/core';
import type { PreparedSpeechAudio, SpeechAudioService } from '../src/audio/speechUpload.types';
import { SpeechTranscriptionError } from '../src/transcription';
import { AzureSpeechClient } from '../src/services/azure';
import { createPortableBackup } from '../src/backup';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';

class MemoryStore implements StateStore {
  value?: AppState;
  saves = 0;
  failSaves = 0;
  failOutcomes = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.saves += 1;
    const outcome = state.transcription.attempts.at(-1)?.outcome;
    if (this.failSaves > 0 || this.failOutcomes > 0 && (outcome === 'completed' || outcome === 'failed' || outcome === 'unknown')) {
      if (this.failSaves > 0) this.failSaves -= 1; else this.failOutcomes -= 1;
      throw new Error('disk full');
    }
    this.value = structuredClone(state);
  }
  async clear() { this.value = undefined; }
}

const endpoint = 'https://example.cognitiveservices.azure.com';
const makePrepared = (leaseId: string, durationSeconds = 7): PreparedSpeechAudio => ({
  leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5, sha256: 'a'.repeat(64), durationSeconds,
  upload: { blob: new Blob(['voice']), fileName: 'note.wav' },
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function speechClient(run: (args: {
  note: Note; signal?: AbortSignal; onPrepared?: (prepared: PreparedSpeechAudio) => Promise<void>;
  onAttempt?: (prepared: PreparedSpeechAudio) => Promise<void>; beforeDispatch?: (prepared: PreparedSpeechAudio) => void; leaseId?: string;
}) => Promise<unknown>) {
  return {
    transcribe: vi.fn((note: Note, _settings: unknown, signal: AbortSignal | undefined,
      onAttempt: (prepared: PreparedSpeechAudio) => Promise<void>, beforeDispatch: (prepared: PreparedSpeechAudio) => void,
      onPrepared: (prepared: PreparedSpeechAudio) => Promise<void>, leaseId: string) =>
      run({ note, signal, onAttempt, beforeDispatch, onPrepared, leaseId })),
    releaseUploadLease: vi.fn(async () => undefined),
  } as unknown as AzureSpeechClient;
}

async function readyApp(store = new MemoryStore(), speech = speechClient(async () => ({
  transcript: 'Remember the blue folder.', durationMilliseconds: 2_100, durationSeconds: 2.1, billedEstimateSeconds: 3,
  attempts: 1 as const, cleanupPromise: Promise.resolve(),
})), durationSeconds = 7) {
  const app = new AppControllerImpl(store, { speech });
  await app.load();
  const note = await app.saveNote({ transcript: 'Captured locally.', audioUri: 'file:///private/voice.m4a', durationSeconds });
  await app.saveSettings({ speechEnabled: true, speechEndpoint: endpoint });
  return { app, store, note };
}

describe('explicit transcription controller lifecycle', () => {
  it('persists the attempt and lease before audio preparation, and joins an identical in-flight request', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const client = speechClient(async ({ signal, onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio);
      started.resolve();
      await finish.promise;
      if (signal?.aborted) throw new SpeechTranscriptionError('cancelled', 'cancelled', false);
      await onAttempt!(audio);
      beforeDispatch!(audio);
      return { transcript: 'Remember the blue folder.', durationMilliseconds: 2_100, durationSeconds: 2.1, billedEstimateSeconds: 3, attempts: 1 as const, cleanupPromise: Promise.resolve() };
    });
    const { app, store, note } = await readyApp(new MemoryStore(), client);
    const first = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await started.promise;
    expect(store.value?.transcription.attempts.at(-1)).toMatchObject({ outcome: 'preparing', dispatchStarted: false, leaseId: expect.any(String) });
    expect(store.value?.transcription.cleanupLeases.at(-1)).toMatchObject({ outcome: 'owned', attemptId: store.value?.transcription.attempts.at(-1)?.id });
    const duplicate = app.transcribeNote(note.id, { expectedRevision: note.revision });
    expect(duplicate).toBe(first);
    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision + 1 })).rejects.toThrow(/different note revision/i);
    finish.resolve();
    await expect(first).resolves.toMatchObject({ transcript: 'Remember the blue folder.', revision: note.revision + 1 });
    expect(client.transcribe).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(client.releaseUploadLease).toHaveBeenCalledTimes(1));
  });

  it('runs one bounded Azure request through the controller and releases the matching upload lease', async () => {
    const audio: SpeechAudioService = {
      prepare: vi.fn(async (_note, options): Promise<PreparedSpeechAudio> => ({
        ...makePrepared(options.leaseId, _note.durationSeconds),
        platform: 'web',
        upload: { blob: new Blob(['voice']), fileName: 'note.wav' },
      })),
      verify: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ durationMilliseconds: 3_760, combinedPhrases: [{ text: 'Azure heard this.' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    const speech = new AzureSpeechClient({ audio, fetcher: fetcher as unknown as typeof fetch,
      readKeySnapshot: async () => ({ key: 'fictional-test-key', generation: 4 }), currentCredentialGeneration: () => 4, assertCredentialGeneration: (value) => { if (value !== 4) throw new Error('stale'); } });
    const { app, note } = await readyApp(new MemoryStore(), speech, 4.125);
    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).resolves.toMatchObject({ transcript: 'Azure heard this.' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(audio.prepare).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(audio.release).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(app.getSnapshot().transcription.cleanupLeases.at(-1)).toMatchObject({ outcome: 'released' }));
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'completed', durationMilliseconds: 3_760, billedEstimateSeconds: 4 });
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.durationSeconds).toBe(4.125);
    const backup = createPortableBackup(app.getSnapshot(), { exportId: 'fractional-duration-test', exportedAt: new Date().toISOString() });
    expect(backup.notes.find((item) => item.sourceId === note.id)?.durationSeconds).toBe(4.125);
  });

  it('admits Azure Speech without spend or daily attempt quotas and keeps its price unknown', async () => {
    const posted = vi.fn();
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio);
      await onAttempt!(audio);
      beforeDispatch!(audio);
      posted();
      return { transcript: 'Provider returned a verified duration.', durationMilliseconds: 1_501, durationSeconds: 1.501,
        billedEstimateSeconds: 2, attempts: 1 as const, cleanupPromise: Promise.resolve() };
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    await app.saveSettings({ monthlyBudgetUsd: 0, maxCallsPerDay: 1, speechUsdPerMinute: 25 });
    await (app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> }).mutate((state) => {
      state.usage.attemptsToday = 1;
      state.usage.estimatedCostUsd = 30;
      state.usage.priceKnown = true;
    });

    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).resolves.toMatchObject({ transcript: 'Provider returned a verified duration.' });
    expect(posted).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({
      outcome: 'completed', durationMilliseconds: 1_501, reservation: { reserve: 0 },
    });
    expect(app.getSnapshot().usage).toMatchObject({
      attemptsToday: 2, attempts: 1, requests: 1, transcriptionSeconds: 2,
      estimatedCostUsd: 30, reservedUsd: 0, priceKnown: false, unknownCharges: 1,
    });
  });

  it('clears legacy price-known state as soon as a dispatched Speech charge becomes unknown', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const posted = vi.fn();
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio);
      await onAttempt!(audio);
      beforeDispatch!(audio);
      posted();
      started.resolve();
      await finish.promise;
      throw new SpeechTranscriptionError('Provider failed without returning usage.', 'invalid_response', true);
    });
    const { app, store, note } = await readyApp(new MemoryStore(), client);
    await app.saveSettings({ monthlyBudgetUsd: 0, maxCallsPerDay: 1, speechUsdPerMinute: 25 });
    await (app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> }).mutate((state) => {
      state.usage.attemptsToday = 1;
      state.usage.estimatedCostUsd = 30;
      state.usage.priceKnown = true;
    });

    const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await started.promise;
    expect(app.getSnapshot().usage).toMatchObject({ attemptsToday: 2, requests: 0, reservedUsd: 0, priceKnown: false, unknownCharges: 1, estimatedCostUsd: 30 });
    expect(store.value?.usage).toMatchObject({ priceKnown: false, unknownCharges: 1, estimatedCostUsd: 30 });
    finish.resolve();
    await expect(request).rejects.toThrow(/without returning usage/i);

    expect(posted).toHaveBeenCalledTimes(1);
    expect(client.transcribe).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'unknown', code: 'invalid_response', dispatchStarted: true });
    expect(app.getSnapshot().usage).toMatchObject({ attemptsToday: 2, requests: 0, reservedUsd: 0, priceKnown: false, unknownCharges: 1, estimatedCostUsd: 30 });
  });

  it('rolls back only its own reservation when a typed failure proves no POST was dispatched', async () => {
    const client = speechClient(async ({ onPrepared, onAttempt, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio);
      await onAttempt!(audio);
      throw new SpeechTranscriptionError('Credential changed before upload.', 'stale_credential', false, undefined, undefined, Promise.resolve());
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toThrow(/Credential changed/i);
    const state = app.getSnapshot();
    expect(state.usage.attempts).toBe(0);
    expect(state.usage.attemptsToday).toBe(0);
    expect(state.usage.unknownCharges).toBe(0);
    expect(state.transcription.attempts.at(-1)).toMatchObject({ outcome: 'failed', dispatchStarted: false, code: 'stale_credential' });
    expect(state.transcription.attempts.at(-1)).not.toHaveProperty('reservation');
  });

  it('stops before reservation when the explicit speech setting changes during audio preparation', async () => {
    const prepared = deferred<void>();
    const finish = deferred<void>();
    const posted = vi.fn();
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio);
      prepared.resolve();
      await finish.promise;
      await onAttempt!(audio);
      beforeDispatch!(audio);
      posted();
      return { transcript: 'Should not be sent.', durationMilliseconds: 1_000, durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 as const };
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await prepared.promise;
    await app.saveSettings({ speechEnabled: false });
    finish.resolve();
    await expect(request).rejects.toThrow(/settings changed/i);
    expect(posted).not.toHaveBeenCalled();
    expect(app.getSnapshot().usage.attempts).toBe(0);
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'failed', dispatchStarted: false });
  });

  it.each([
    ['speechUsdPerMinute', 0.25],
    ['monthlyBudgetUsd', 4],
    ['maxCallsPerDay', 19],
  ] as const)('rolls back its reservation if %s changes during final verification', async (key, value) => {
    const prepared = deferred<void>();
    const finish = deferred<void>();
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio);
      await onAttempt!(audio);
      prepared.resolve();
      await finish.promise;
      try { beforeDispatch!(audio); }
      catch (error) { throw new SpeechTranscriptionError('Settings changed before upload.', 'pre_dispatch', false, undefined, { cause: error }); }
      throw new Error('The provider must not be called.');
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await prepared.promise;
    await app.saveSettings({ [key]: value });
    finish.resolve();
    await expect(request).rejects.toThrow(/Settings changed/i);
    expect(app.getSnapshot().usage.attempts).toBe(0);
    expect(app.getSnapshot().usage.attemptsToday).toBe(0);
    expect(app.getSnapshot().usage.unknownCharges).toBe(0);
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'failed', dispatchStarted: false, code: 'audio_invalid' });
    expect(app.getSnapshot().transcription.attempts.at(-1)).not.toHaveProperty('reservation');
  });

  it('uses the real Azure client fence after deferred final audio verification', async () => {
    const finalVerify = deferred<void>();
    const finalVerifyStarted = deferred<void>();
    let verifyCount = 0;
    const audio: SpeechAudioService = {
      prepare: vi.fn(async (_note, options) => makePrepared(options.leaseId)),
      verify: vi.fn(async () => {
        verifyCount += 1;
        if (verifyCount === 2) {
          finalVerifyStarted.resolve();
          await finalVerify.promise;
        }
      }),
      release: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ durationMilliseconds: 1_000, combinedPhrases: [{ text: 'Must not upload.' }] }), { status: 200 }));
    const speech = new AzureSpeechClient({ audio, fetcher: fetcher as unknown as typeof fetch,
      readKeySnapshot: async () => ({ key: 'fictional-test-key', generation: 4 }), currentCredentialGeneration: () => 4,
      assertCredentialGeneration: (generation) => { if (generation !== 4) throw new Error('stale'); } });
    const { app, note } = await readyApp(new MemoryStore(), speech);
    const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await finalVerifyStarted.promise;
    await app.saveSettings({ speechUsdPerMinute: 0.3 });
    finalVerify.resolve();
    await expect(request).rejects.toThrow(/No audio was sent/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(app.getSnapshot().usage.attempts).toBe(0);
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'failed', dispatchStarted: false, code: 'audio_invalid' });
    expect(app.getSnapshot().transcription.attempts.at(-1)).not.toHaveProperty('reservation');
  });

  it('recovers a runtime pending attempt locally after terminal persistence fails, without another POST', async () => {
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      return { transcript: 'Provider returned.', durationMilliseconds: 1_000, durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 as const };
    });
    const store = new MemoryStore();
    const { app, note } = await readyApp(store, client);
    store.failOutcomes = 1; // The successful-response commit loses acknowledgement; fallback journal writes are gated.
    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toThrow(/refresh local data/i);
    expect(app.getSnapshot().transcription.attempts.at(-1)?.outcome).toBe('pending');
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    await app.refreshPersistedWorkspace();
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'unknown', code: 'provider_unknown' });
    expect(client.transcribe).toHaveBeenCalledTimes(1);
    expect(client.transcribe).toHaveBeenCalledTimes(1);
  });

  it('keeps refresh blocked until actual provider cleanup settles after an ambiguous terminal save', async () => {
    const actualCleanup = deferred<void>();
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      return {
        transcript: 'Provider returned before cleanup finished.', durationMilliseconds: 1_000,
        durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 as const, cleanupPromise: actualCleanup.promise,
      };
    });
    const store = new MemoryStore();
    const { app, note } = await readyApp(store, client);
    store.failOutcomes = 1; // The terminal save may have committed; fallback writes are gated.

    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toThrow(/refresh local data/i);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    expect(app.getSnapshot().transcription.attempts.at(-1)?.outcome).toBe('pending');
    await expect(app.refreshPersistedWorkspace()).rejects.toThrow(/busy/i);
    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toThrow(/refresh local data/i);
    expect(client.transcribe).toHaveBeenCalledTimes(1);

    actualCleanup.resolve();
    await vi.waitFor(() => {
      const controller = app as unknown as { transcriptionCleanupPromises: Set<string> };
      expect(controller.transcriptionCleanupPromises.size).toBe(0);
    });
    await app.refreshPersistedWorkspace();
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'unknown', code: 'provider_unknown' });
    expect(client.transcribe).toHaveBeenCalledTimes(1);
  });

  it('does not apply a transcript when cancellation arrives while result hashing is pending', async () => {
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      return { transcript: 'Must not replace the note.', durationMilliseconds: 1_200, durationSeconds: 1.2, billedEstimateSeconds: 2, attempts: 1 as const, cleanupPromise: Promise.resolve() };
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    const hashGate = deferred<string>();
    const original = Crypto.digestStringAsync.bind(Crypto);
    const digest = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (_algorithm, data) => {
      if (data === 'Must not replace the note.') return hashGate.promise;
      return original(_algorithm, data);
    });
    try {
      const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
      await vi.waitFor(() => expect(client.transcribe).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(app.getSnapshot().transcription.attempts.at(-1)?.outcome).toBe('pending'));
      const cancel = await app.cancelTranscription(note.id);
      expect(cancel.status).toBe('cancelled');
      hashGate.resolve('b'.repeat(64));
      await expect(request).rejects.toThrow(/changed while transcription|valid provider result/i);
      expect(app.getSnapshot().notes.find((item) => item.id === note.id)).toMatchObject({ transcript: note.transcript, revision: note.revision });
      expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'cancelled', code: 'cancelled', durationMilliseconds: 1_200 });
      expect(app.getSnapshot().usage.transcriptionSeconds).toBe(2);
    } finally { digest.mockRestore(); }
  });

  it('keeps the transcript and audio unchanged on no-speech while settling the verified duration once', async () => {
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      throw new SpeechTranscriptionError('No speech detected.', 'no_speech', true, 1_801, undefined, Promise.resolve());
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toThrow(/No speech detected/i);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)).toMatchObject({ transcript: note.transcript, audioUri: note.audioUri, revision: note.revision });
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'no_speech', durationMilliseconds: 1_801, billedEstimateSeconds: 2 });
    expect(app.getSnapshot().usage.transcriptionSeconds).toBe(2);
  });

  it('keeps the original note on malformed provider text while settling a valid duration once', async () => {
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      throw new SpeechTranscriptionError('Provider response text was malformed.', 'invalid_response', true, 1_801);
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toThrow(/malformed/i);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)).toMatchObject({ transcript: note.transcript, audioUri: note.audioUri, revision: note.revision });
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'unknown', code: 'invalid_response', durationMilliseconds: 1_801, billedEstimateSeconds: 2 });
    expect(app.getSnapshot().usage.transcriptionSeconds).toBe(2);
  });

  it('discards a valid response rather than overwriting a transcript edited during upload', async () => {
    const response = deferred<void>();
    const returned = deferred<void>();
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      returned.resolve();
      await response.promise;
      return { transcript: 'Old generated text.', durationMilliseconds: 1_500, durationSeconds: 1.5, billedEstimateSeconds: 2, attempts: 1 as const };
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await returned.promise;
    const edited = await app.updateTranscript(note.id, 'A newer user edit.');
    response.resolve();
    await expect(request).rejects.toThrow(/changed while transcription/i);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)).toMatchObject({ transcript: edited.transcript, revision: edited.revision });
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'discarded', transcriptSha256: expect.any(String) });
  });

  it('does not recreate a note deleted while the provider request is pending', async () => {
    const response = deferred<void>();
    const dispatched = deferred<void>();
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      dispatched.resolve(); await response.promise;
      return { transcript: 'Late result.', durationMilliseconds: 1_000, durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 as const };
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await dispatched.promise;
    await app.deleteNote(note.id);
    response.resolve();
    await expect(request).rejects.toThrow(/changed while transcription/i);
    expect(app.getSnapshot().notes.some((item) => item.id === note.id)).toBe(false);
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'discarded' });
  });

  it('does not detach audio when the current retention setting changes back to keep during upload', async () => {
    const response = deferred<void>();
    const started = deferred<void>();
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      started.resolve(); await response.promise;
      return { transcript: 'Saved text.', durationMilliseconds: 1_000, durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 as const };
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    await app.saveSettings({ audioRetention: 'delete_after_transcription' });
    const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
    await started.promise;
    await app.saveSettings({ audioRetention: 'keep' });
    response.resolve();
    await expect(request).resolves.toMatchObject({ audioUri: note.audioUri, transcript: 'Saved text.' });
  });

  it('recovers preparing and pending journal entries at load without a secret read or provider call', async () => {
    for (const pending of [false, true]) {
      const staged = deferred<void>();
      const claimed = deferred<void>();
      const finish = deferred<void>();
      const originalClient = speechClient(async ({ signal, onPrepared, onAttempt, beforeDispatch, leaseId }) => {
        const audio = makePrepared(leaseId!);
        await onPrepared!(audio); staged.resolve();
        if (pending) { await onAttempt!(audio); beforeDispatch!(audio); claimed.resolve(); }
        await finish.promise;
        throw new SpeechTranscriptionError('Cancelled after restart fixture.', pending ? 'cancelled' : 'cancelled', pending, undefined, undefined, Promise.resolve());
      });
      const store = new MemoryStore();
      const { app, note } = await readyApp(store, originalClient);
      const running = app.transcribeNote(note.id, { expectedRevision: note.revision });
      if (pending) await claimed.promise; else await staged.promise;
      const restoredStore = new MemoryStore();
      restoredStore.value = structuredClone(store.value!);
      const noNetworkClient = speechClient(async () => { throw new Error('must not transcribe on load'); });
      const restored = new AppControllerImpl(restoredStore, { speech: noNetworkClient });
      await restored.load();
      expect(restored.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: pending ? 'unknown' : 'failed', code: pending ? 'provider_unknown' : 'preparation_interrupted' });
      expect(noNetworkClient.transcribe).not.toHaveBeenCalled();
      await app.cancelTranscription(note.id);
      finish.resolve();
      await expect(running).rejects.toBeTruthy();
    }
  });

  it('does not settle a prior-month duration into a newly rolled usage ledger', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T10:00:00.000Z'));
    try {
      const response = deferred<void>();
      const started = deferred<void>();
      const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
        const audio = makePrepared(leaseId!);
        await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio); started.resolve(); await response.promise;
        return { transcript: 'January result.', durationMilliseconds: 2_000, durationSeconds: 2, billedEstimateSeconds: 2, attempts: 1 as const };
      });
      const { app, note } = await readyApp(new MemoryStore(), client);
      const request = app.transcribeNote(note.id, { expectedRevision: note.revision });
      await started.promise;
      vi.setSystemTime(new Date('2026-02-01T10:00:00.000Z'));
      const ledger = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void>; rollUsage(state: AppState): void };
      await ledger.mutate((state) => ledger.rollUsage(state));
      response.resolve();
      await request;
      expect(app.getSnapshot().usage.month).toBe('2026-02');
      expect(app.getSnapshot().usage.transcriptionSeconds).toBe(0);
      expect(app.getSnapshot().usage.requests).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('retains a cleanup obligation after release failure and protects a lease while a raw request still owns it', async () => {
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      return { transcript: 'Finished.', durationMilliseconds: 1_000, durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 as const, cleanupPromise: Promise.resolve() };
    });
    const releaseError = vi.fn(async () => { throw new Error('private file locked'); });
    Object.assign(client, { releaseUploadLease: releaseError });
    const { app, note } = await readyApp(new MemoryStore(), client);
    await app.transcribeNote(note.id, { expectedRevision: note.revision });
    await vi.waitFor(() => expect(releaseError).toHaveBeenCalled());
    expect(app.getSnapshot().transcription.cleanupLeases.at(-1)?.outcome).toBe('pending_cleanup');

    const rawSettled = deferred<void>();
    const blockedClient = speechClient(async ({ note: selectedNote, onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!, selectedNote.durationSeconds);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      throw new SpeechTranscriptionError('Upload timed out.', 'timeout', true, undefined, undefined, rawSettled.promise);
    });
    const secondApp = new AppControllerImpl(new MemoryStore(), { speech: blockedClient });
    await secondApp.load();
    const next = await secondApp.saveNote({ transcript: 'Second recording.', audioUri: 'file:///private/second.m4a', durationSeconds: 4 });
    await secondApp.saveSettings({ speechEnabled: true, speechEndpoint: endpoint });
    const impl = secondApp as unknown as { retryTranscriptionCleanup(): Promise<void> };
    await expect(secondApp.transcribeNote(next.id, { expectedRevision: next.revision })).rejects.toThrow(/timed out/i);
    await impl.retryTranscriptionCleanup();
    expect(blockedClient.releaseUploadLease).not.toHaveBeenCalled();
    rawSettled.resolve();
    await vi.waitFor(() => expect(blockedClient.releaseUploadLease).toHaveBeenCalledTimes(1));
  });

  it('keeps a shared original audio URI when delete-after-transcription is enabled', async () => {
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      return { transcript: 'First note transcribed.', durationMilliseconds: 1_000, durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 as const, cleanupPromise: Promise.resolve() };
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    const second = await app.saveNote({ transcript: 'Another local note.', audioUri: note.audioUri, durationSeconds: 7 });
    await app.saveSettings({ audioRetention: 'delete_after_transcription' });
    const transcribed = await app.transcribeNote(note.id, { expectedRevision: note.revision });
    expect(transcribed.audioUri).toBe(note.audioUri);
    expect(app.getSnapshot().notes.find((item) => item.id === second.id)?.audioUri).toBe(note.audioUri);
  });

  it('exports only inert transcription history, never upload leases or local audio URIs', async () => {
    const client = speechClient(async ({ onPrepared, onAttempt, beforeDispatch, leaseId }) => {
      const audio = makePrepared(leaseId!);
      await onPrepared!(audio); await onAttempt!(audio); beforeDispatch!(audio);
      return { transcript: 'A private transcript.', durationMilliseconds: 1_000, durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 as const, cleanupPromise: Promise.resolve() };
    });
    const { app, note } = await readyApp(new MemoryStore(), client);
    await app.transcribeNote(note.id, { expectedRevision: note.revision });
    const portable = createPortableBackup(app.getSnapshot(), { exportId: 'transcription-test', exportedAt: new Date().toISOString() });
    const history = portable.history.find((item) => item.sourceId.startsWith('transcription:'));
    expect(history).toMatchObject({ kind: 'activity', status: 'completed (unverified imported transcription history)' });
    expect(JSON.stringify(portable)).not.toContain('file:///private/voice.m4a');
    expect(JSON.stringify(portable)).not.toContain('leaseId');
    expect(JSON.stringify(portable)).not.toContain('transcriptSha256');
  });
});
