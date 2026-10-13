import { afterEach, describe, expect, it, vi } from 'vitest';
import * as DocumentPicker from 'expo-document-picker';
import {
  measureAudioDuration,
  type AudioDurationPlayer,
  type AudioDurationStatus,
} from '../src/audio/audioDurationProbe';

function makePlayer(initial: AudioDurationStatus) {
  let status = initial;
  let listener: ((next: AudioDurationStatus) => void) | undefined;
  const removeSubscription = vi.fn(() => { listener = undefined; });
  const remove = vi.fn();
  const player: AudioDurationPlayer = {
    get currentStatus() { return status; },
    addListener: vi.fn((_event, callback) => {
      listener = callback;
      return { remove: removeSubscription };
    }),
    remove,
  };
  return {
    player,
    remove,
    removeSubscription,
    update(next: AudioDurationStatus) { status = next; listener?.(next); },
  };
}

const loading: AudioDurationStatus = { isLoaded: false, playbackState: 'loading', duration: 0 };

const nativeRecovery = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  selectedDuration: 3.23456,
  playerUris: [] as string[],
  nextId: 1,
}));

vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digest: async () => new Uint8Array(32).buffer,
  randomUUID: () => `00000000-0000-4000-8000-${String(nativeRecovery.nextId++).padStart(12, '0')}`,
}));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() { return nativeRecovery.files.has(this.uri); }
    get size() { return nativeRecovery.files.get(this.uri)?.byteLength ?? 0; }
    async bytes() {
      const bytes = nativeRecovery.files.get(this.uri);
      if (!bytes) throw new Error('missing fake file');
      return bytes.slice();
    }
  },
}));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///private/',
  getInfoAsync: async () => ({ exists: true, isDirectory: true }),
  makeDirectoryAsync: async () => undefined,
  copyAsync: async ({ from, to }: { from: string; to: string }) => { nativeRecovery.files.set(to, nativeRecovery.files.get(from)!.slice()); },
  moveAsync: async ({ from, to }: { from: string; to: string }) => {
    nativeRecovery.files.set(to, nativeRecovery.files.get(from)!.slice());
    nativeRecovery.files.delete(from);
  },
  deleteAsync: async (uri: string) => { nativeRecovery.files.delete(uri); },
}));
vi.mock('expo-audio', () => ({
  createAudioPlayer: (uri: string) => {
    nativeRecovery.playerUris.push(uri);
    return {
      currentStatus: { isLoaded: true, playbackState: 'ready', duration: nativeRecovery.selectedDuration },
      addListener: () => ({ remove: () => undefined }),
      remove: () => undefined,
    };
  },
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('policy-neutral audio duration probe', () => {
  it('waits for a stale loading sample, then returns an exact duration above recovery limits without playback', async () => {
    const fake = makePlayer(loading);
    const create = vi.fn(() => fake.player);
    const measurement = measureAudioDuration('file:///capture.m4a', { create });
    expect(create).toHaveBeenCalledWith('file:///capture.m4a');
    fake.update({ isLoaded: true, playbackState: 'ready', duration: 600.0001 });
    await expect(measurement).resolves.toEqual({ outcome: 'known', durationSeconds: 600.0001 });
    expect(fake.removeSubscription).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it.each([[0, 'zero'], [Number.POSITIVE_INFINITY, 'indefinite']] as const)('reports %s duration as unknown', async (duration, reason) => {
    const fake = makePlayer({ isLoaded: true, playbackState: 'ready', duration });
    await expect(measureAudioDuration('file:///capture.m4a', { create: () => fake.player }))
      .resolves.toEqual({ outcome: 'unknown', reason });
    expect(fake.removeSubscription).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it.each([-1, Number.NaN, '12'])('rejects malformed loaded duration %s and cleans up', async (duration) => {
    const fake = makePlayer({ isLoaded: true, playbackState: 'ready', duration });
    await expect(measureAudioDuration('file:///capture.m4a', { create: () => fake.player }))
      .rejects.toMatchObject({ name: 'AudioDurationProbeError', code: 'invalid_duration' });
    expect(fake.removeSubscription).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it('rejects decoder errors and cleans up', async () => {
    const fake = makePlayer({ isLoaded: false, playbackState: 'error', duration: 0 });
    await expect(measureAudioDuration('file:///capture.m4a', { create: () => fake.player }))
      .rejects.toMatchObject({ code: 'decode_error' });
    expect(fake.removeSubscription).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it('does not trust a loaded cached duration when playback status is an error', async () => {
    const fake = makePlayer({ isLoaded: true, playbackState: 'error', duration: 4.5 });
    await expect(measureAudioDuration('file:///capture.m4a', { create: () => fake.player }))
      .rejects.toMatchObject({ code: 'decode_error' });
    expect(fake.removeSubscription).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it('times out within the injected bounded deadline and cleans up', async () => {
    vi.useFakeTimers();
    const fake = makePlayer(loading);
    const measurement = measureAudioDuration('file:///capture.m4a', { create: () => fake.player }, 25);
    const rejection = expect(measurement).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(fake.removeSubscription).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it('removes the player when listener attachment throws', async () => {
    const fake = makePlayer(loading);
    fake.player.addListener = vi.fn(() => { throw new Error('listener failed'); });
    await expect(measureAudioDuration('file:///capture.m4a', { create: () => fake.player }))
      .rejects.toMatchObject({ code: 'invalid_duration' });
    expect(fake.removeSubscription).not.toHaveBeenCalled();
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it('removes the subscription and player when the current status getter throws', async () => {
    const fake = makePlayer(loading);
    Object.defineProperty(fake.player, 'currentStatus', { get() { throw new Error('status getter failed'); } });
    await expect(measureAudioDuration('file:///capture.m4a', { create: () => fake.player }))
      .rejects.toMatchObject({ code: 'invalid_duration' });
    expect(fake.removeSubscription).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it('cleans exactly once when the first status callback fires synchronously during registration', async () => {
    const removeSubscription = vi.fn();
    const removePlayer = vi.fn();
    const player: AudioDurationPlayer = {
      currentStatus: loading,
      addListener: vi.fn((_event, listener) => {
        listener({ isLoaded: true, playbackState: 'ready', duration: 3.14159 });
        return { remove: removeSubscription };
      }),
      remove: removePlayer,
    };
    await expect(measureAudioDuration('file:///capture.m4a', { create: () => player }))
      .resolves.toEqual({ outcome: 'known', durationSeconds: 3.14159 });
    expect(removeSubscription).toHaveBeenCalledTimes(1);
    expect(removePlayer).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid timeout configuration before creating a player', async () => {
    const create = vi.fn(() => makePlayer(loading).player);
    await expect(measureAudioDuration('file:///capture.m4a', { create }, 0)).rejects.toThrow('Audio duration probe timeout is invalid.');
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps native recovery zero-duration rejection while indefinite duration remains unknown', async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1]);
    const uri = 'file:///chosen.wav';
    nativeRecovery.files.clear();
    nativeRecovery.files.set(uri, wav);
    nativeRecovery.playerUris = [];
    nativeRecovery.nextId = 1;
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri, name: 'chosen.wav', mimeType: 'audio/wav', size: wav.byteLength, lastModified: 1 }],
    } as never);
    const { recordingRecoveryService } = await import('../src/audio/recovery.native');

    nativeRecovery.selectedDuration = 0;
    await expect(recordingRecoveryService.pickAndStage({ maxDurationSeconds: 120 })).rejects.toThrow(/longer than zero/i);
    expect(nativeRecovery.playerUris).toHaveLength(1);

    nativeRecovery.selectedDuration = Number.POSITIVE_INFINITY;
    const indefinite = await recordingRecoveryService.pickAndStage({ maxDurationSeconds: 120 });
    expect(indefinite?.metadata).toMatchObject({ durationStatus: 'unknown' });

    nativeRecovery.selectedDuration = 3.23456;
    const fractional = await recordingRecoveryService.pickAndStage({ maxDurationSeconds: 120 });
    expect(fractional?.metadata).toMatchObject({ durationStatus: 'known', durationSeconds: 3.235 });

    nativeRecovery.selectedDuration = 600.0001;
    await expect(recordingRecoveryService.pickAndStage({ maxDurationSeconds: 900 })).rejects.toThrow(/600 seconds/i);
  });
});
