import { describe, expect, it, vi } from 'vitest';
import { createPendingCaptureNativeIO, type PendingCaptureNativeIODependencies } from '../src/audio/pendingCaptureNativeIO.native';
import type { AudioDurationPlayer, AudioDurationStatus } from '../src/audio/audioDurationProbe';

vi.mock('expo-audio', () => ({ createAudioPlayer: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///unused/' }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));

const root = 'file:///app/Documents/';
const capturePath = 'ExpoAudio/recording-00000000-0000-4000-8000-000000000001.m4a';
const captureUri = `${root}${capturePath}`;
type EmptyAudioSource = Record<string, never>;

function makeIO(options: {
  exists?: boolean;
  isDirectory?: boolean;
  size?: number;
  status?: AudioDurationStatus;
  replace?: (source: EmptyAudioSource) => void;
  removePlayer?: () => void;
  getInfo?: (uri: string) => Promise<{ exists: boolean; isDirectory?: boolean; size?: number }>;
} = {}) {
  const calls: string[] = [];
  const files = new Set([captureUri]);
  let playerCount = 0;
  let activeSource: string | undefined;
  const status = options.status ?? { isLoaded: true, playbackState: 'ready', duration: 2.375 };
  const dependencies: PendingCaptureNativeIODependencies = {
    documentDirectory: root,
    getInfo: options.getInfo ?? (async (uri) => {
      calls.push(`info:${uri}`);
      return { exists: options.exists ?? files.has(uri), isDirectory: options.isDirectory ?? false, size: options.size ?? 128 };
    }),
    delete: async (uri) => { calls.push(`delete:${uri}`); files.delete(uri); },
    createPlayer: vi.fn((_uri, _options) => {
      playerCount += 1;
      calls.push('player:create');
      activeSource = _uri;
      const player: AudioDurationPlayer & { replace(source: EmptyAudioSource): void } = {
        get currentStatus() { return status; },
        addListener: vi.fn((_event, _listener) => ({ remove: () => { calls.push('listener:remove'); } })),
        replace: (source) => {
          const candidate: unknown = source;
          if (candidate === null) throw new Error('The native SDK rejects null audio sources.');
          expect(Object.keys(source)).toEqual([]);
          options.replace?.(source);
          activeSource = undefined;
          calls.push('player:replace-empty');
        },
        remove: () => { calls.push(`player:remove:${activeSource === undefined ? 'empty' : 'attached'}`); options.removePlayer?.(); },
      };
      return player;
    }),
    sharingAvailable: async () => { calls.push('share:available'); return true; },
    share: async (uri, opts) => { calls.push(`share:${uri}:${opts.mimeType}:${opts.dialogTitle}`); },
  };
  return { io: createPendingCaptureNativeIO(dependencies), calls, files, playerCount: () => playerCount, activePlayerSource: () => activeSource };
}

describe('pending native capture IO', () => {
  it('round-trips only the canonical owned path and rejects unowned inputs before side effects', async () => {
    const fake = makeIO();
    expect(fake.io.toRelativePath(captureUri)).toBe(capturePath);
    expect(fake.io.toUri(capturePath)).toBe(captureUri);
    const before = [...fake.calls];
    await expect(fake.io.exists('file:///app/Documents/ExpoAudio/../private.m4a')).rejects.toThrow(/not owned|invalid/i);
    await expect(fake.io.probe('file:///outside/recording.m4a')).rejects.toThrow(/not owned/i);
    await expect(fake.io.remove('file:///outside/recording.m4a')).rejects.toThrow(/not owned/i);
    await expect(fake.io.export('file:///outside/recording.m4a')).rejects.toThrow(/not owned/i);
    expect(fake.calls).toEqual(before);
  });

  it('reports missing, zero-size, and oversized files without creating a player', async () => {
    const missing = makeIO({ exists: false });
    await expect(missing.io.probe(captureUri)).resolves.toEqual({ inspection: { outcome: 'missing' } });
    const empty = makeIO({ size: 0 });
    await expect(empty.io.probe(captureUri)).resolves.toEqual({ inspection: { outcome: 'unknown' } });
    const oversized = makeIO({ size: 40 * 1024 * 1024 + 1 });
    await expect(oversized.io.probe(captureUri)).resolves.toEqual({ inspection: { outcome: 'invalid' } });
    expect(missing.playerCount()).toBe(0);
    expect(empty.playerCount()).toBe(0);
    expect(oversized.playerCount()).toBe(0);
  });

  it('treats an owned directory as present and never removes it as a file', async () => {
    const directory = makeIO({ exists: true, isDirectory: true });
    await expect(directory.io.exists(captureUri)).resolves.toBe(true);
    await expect(directory.io.probe(captureUri)).resolves.toEqual({ inspection: { outcome: 'invalid' } });
    await expect(directory.io.remove(captureUri)).rejects.toThrow(/owned file/i);
    expect(directory.calls).not.toContain(`delete:${captureUri}`);
  });

  it('preserves exact native probe durations including fractions above the recovery cap without playing', async () => {
    const fake = makeIO({ status: { isLoaded: true, playbackState: 'ready', duration: 600.0001 } });
    const result = await fake.io.probe(captureUri);
    expect(result).toEqual({ inspection: { outcome: 'known', durationSeconds: 600.0001 } });
    expect(fake.calls).toEqual([
      `info:${captureUri}`,
      'player:create',
      'listener:remove',
      'player:replace-empty',
      'player:remove:empty',
    ]);
    expect(fake.calls).not.toContain('play');
  });

  it.each([
    [0, { outcome: 'unknown' }],
    [Number.POSITIVE_INFINITY, { outcome: 'unknown' }],
    [Number.NaN, { outcome: 'invalid' }],
  ] as const)('maps a native duration sample without inventing a bound', async (duration, inspection) => {
    const fake = makeIO({ status: { isLoaded: true, playbackState: 'ready', duration } });
    await expect(fake.io.probe(captureUri)).resolves.toEqual({ inspection });
  });

  it('detaches the exact player source before returning the inspection', async () => {
    const fake = makeIO();
    const result = await fake.io.probe(captureUri);
    expect(result.inspection).toEqual({ outcome: 'known', durationSeconds: 2.375 });
    expect(fake.calls.indexOf('player:replace-empty')).toBeLessThan(fake.calls.indexOf('player:remove:empty'));
    expect(fake.calls.indexOf('player:remove:empty')).toBeLessThan(fake.calls.length);
  });

  it('retains and retries the same player capability if native source detachment fails', async () => {
    let detachFailures = 2;
    const fake = makeIO({ replace: () => { if (detachFailures-- > 0) throw new Error('native detach failed'); } });
    const result = await fake.io.probe(captureUri);
    expect(result.inspection).toEqual({ outcome: 'known', durationSeconds: 2.375 });
    expect(result.sourceRelease).toBeDefined();
    expect(fake.calls).toContain('player:create');
    expect(fake.activePlayerSource()).toBe(captureUri);
    expect(() => result.sourceRelease!.retry()).toThrow('The pending recording source could not be released.');
    expect(fake.activePlayerSource()).toBe(captureUri);
    expect(() => result.sourceRelease!.retry()).not.toThrow();
    expect(fake.activePlayerSource()).toBeUndefined();
    expect(fake.playerCount()).toBe(1);
    expect(fake.calls.filter((call) => call === 'player:create')).toHaveLength(1);
    expect(fake.calls.filter((call) => call === 'player:remove:empty')).toHaveLength(1);
    result.sourceRelease!.retry();
    expect(fake.calls.filter((call) => call === 'player:remove:empty')).toHaveLength(1);
  });

  it('does not retain a source capability when player teardown fails after blanking the source', async () => {
    const fake = makeIO({ removePlayer: () => { throw new Error('native player removal failed'); } });
    const result = await fake.io.probe(captureUri);
    expect(result.inspection).toEqual({ outcome: 'known', durationSeconds: 2.375 });
    expect(result.sourceRelease).toBeUndefined();
    expect(fake.calls.indexOf('player:replace-empty')).toBeLessThan(fake.calls.indexOf('player:remove:empty'));
  });

  it('keeps the original owned file after an export cancellation', async () => {
    const fake = makeIO();
    const share = vi.fn(async () => { throw new Error('user cancelled'); });
    const io = createPendingCaptureNativeIO({
      documentDirectory: root,
      getInfo: async (uri) => ({ exists: fake.files.has(uri), isDirectory: false, size: 128 }),
      delete: async (uri) => { fake.files.delete(uri); },
      createPlayer: (_uri, _options) => { throw new Error('not used'); },
      sharingAvailable: async () => true,
      share,
    });
    await expect(io.export(captureUri)).rejects.toThrow('user cancelled');
    expect(share).toHaveBeenCalledWith(captureUri, { mimeType: 'audio/mp4', dialogTitle: 'Export recording' });
    expect(fake.files.has(captureUri)).toBe(true);
  });
});
