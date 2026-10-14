/** @vitest-environment jsdom */
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { AudioCapture } from '../src/audio/types';
import { useBrowserAudioCapture, type BrowserAudioCaptureOptions, type BrowserAudioClipStore } from '../src/audio/useBrowserAudioCapture';
import { useCloudAudioCapture, type CloudAudioCapture } from '../src/web/useCloudAudioCapture';
import { useAudioCapture } from '../src/audio/useAudioCapture.web';

type Track = { stopped: number; stop(): void };
type Stream = { getTracks(): Track[] };

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static stopBehavior: 'event' | 'throw' = 'event';
  static isTypeSupported = () => true;
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  stopCalls = 0;
  constructor(readonly stream: MediaStream) { FakeRecorder.instances.push(this); }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  emitChunk(value: string) { this.ondataavailable?.({ data: new Blob([value]), } as BlobEvent); }
  stop() {
    this.stopCalls += 1;
    if (FakeRecorder.stopBehavior === 'throw') throw new Error('simulated stop failure');
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.(new Event('stop')));
  }
  finishStop() { this.state = 'inactive'; this.onstop?.(new Event('stop')); }
}

let root: Root;
let host: HTMLDivElement;
const captureRef: { current: AudioCapture | CloudAudioCapture | null } = { current: null };
let streams: Stream[];
let getUserMedia: ReturnType<typeof vi.fn>;
let playGates: (() => void)[];
let audioInstances: FakeAudio[];

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  play() { return new Promise<void>((resolve) => { playGates.push(resolve); }); }
  pause() { this.paused = true; }
  removeAttribute() {}
  constructor(readonly src: string) { audioInstances.push(this); }
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function renderCloud() {
  function Harness() { const value = useCloudAudioCapture(); useEffect(() => { captureRef.current = value; }, [value]); return null; }
  act(() => root.render(React.createElement(Harness)));
}

function renderCloudStrict() {
  function Harness() { const value = useCloudAudioCapture(); useEffect(() => { captureRef.current = value; }, [value]); return null; }
  act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
}

function renderEngine(store: BrowserAudioClipStore) {
  act(() => root.render(React.createElement(EngineHarness, { store })));
}

function EngineHarness({ store }: { store: BrowserAudioClipStore }) {
  const options: BrowserAudioCaptureOptions = { store, unmountPolicy: 'discard' };
  const value = useBrowserAudioCapture(options); useEffect(() => { captureRef.current = value; }, [value]); return null;
}

function renderLegacy() {
  function Harness() { const value = useAudioCapture(); useEffect(() => { captureRef.current = value; }, [value]); return null; }
  act(() => root.render(React.createElement(Harness)));
}

async function startCapture() {
  let started!: Promise<void>;
  await act(async () => { started = captureRef.current!.start(); await started; });
}

async function stopCapture() {
  let result!: Awaited<ReturnType<AudioCapture['stop']>>;
  await act(async () => { result = await captureRef.current!.stop(); });
  return result;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); captureRef.current = null;
  streams = []; playGates = []; audioInstances = []; FakeRecorder.instances = []; FakeRecorder.stopBehavior = 'event';
  getUserMedia = vi.fn(async () => {
    const track: Track = { stopped: 0, stop() { this.stopped += 1; } };
    const stream: Stream = { getTracks: () => [track] }; streams.push(stream);
    return stream as unknown as MediaStream;
  });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:fake-${audioInstances.length + 1}`), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('browser and cloud capture ownership', () => {
  it('admits only one permission request for concurrent starts', async () => {
    renderCloud();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = captureRef.current!.start();
      second = captureRef.current!.start();
    });
    await expect(second).rejects.toThrow('already starting');
    await act(async () => first);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.instances).toHaveLength(1);
  });

  it('allows another recording after commit', async () => {
    renderCloud(); await startCapture();
    FakeRecorder.instances[0].emitChunk('first clip');
    const first = await stopCapture();
    if (!first || !('uri' in first)) throw new Error('Expected the first clip handle.');
    expect(await (captureRef.current as CloudAudioCapture).readTemporaryClip(first.uri).then((blob) => blob.text())).toBe('first clip');
    act(() => captureRef.current!.commit(first.uri));
    await startCapture();
    FakeRecorder.instances[1].emitChunk('second clip');
    const second = await stopCapture();
    if (!second || !('uri' in second)) throw new Error('Expected the second clip handle.');
    expect(second.uri).toMatch(/^temporary-audio:/);
    expect(await (captureRef.current as CloudAudioCapture).readTemporaryClip(second.uri).then((blob) => blob.text())).toBe('second clip');
    expect(FakeRecorder.instances).toHaveLength(2);
  });

  it('creates a fresh RAM store for StrictMode effect replay', async () => {
    renderCloudStrict(); await startCapture();
    const result = await stopCapture();
    if (!result || !('uri' in result)) throw new Error('Expected a temporary clip after StrictMode replay.');
    await expect((captureRef.current as CloudAudioCapture).readTemporaryClip(result.uri)).resolves.toBeInstanceOf(Blob);
  });

  it('fences a permission result arriving after unmount and releases its tracks', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    renderCloud();
    let starting!: Promise<void>;
    act(() => { starting = captureRef.current!.start(); });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    const track: Track = { stopped: 0, stop() { this.stopped += 1; } };
    permission.resolve({ getTracks: () => [track] } as unknown as MediaStream);
    await expect(starting).rejects.toThrow('cancelled');
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(track.stopped).toBe(1);
  });

  it('clears an explicit stop that cancels a pending permission prompt so a later start can succeed', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(permission.promise);
    renderCloud();
    let starting!: Promise<void>;
    act(() => { starting = captureRef.current!.start(); });
    let stopping!: Promise<Awaited<ReturnType<AudioCapture['stop']>>>;
    await act(async () => {
      stopping = captureRef.current!.stop();
      const track: Track = { stopped: 0, stop() { this.stopped += 1; } };
      permission.resolve({ getTracks: () => [track] } as unknown as MediaStream);
      await expect(starting).rejects.toThrow('cancelled');
      expect(await stopping).toBeNull();
      expect(track.stopped).toBe(1);
    });
    await startCapture();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('shares stop proof between simultaneous stop and discard and only releases tracks after onstop', async () => {
    renderCloud(); await startCapture();
    const recorder = FakeRecorder.instances[0];
    let stopResult!: Promise<Awaited<ReturnType<AudioCapture['stop']>>>;
    let discardResult!: Promise<void>;
    await act(async () => {
      stopResult = captureRef.current!.stop();
      discardResult = captureRef.current!.cancel();
      await Promise.resolve();
      expect(recorder.stopCalls).toBe(1);
      expect(streams[0].getTracks()[0].stopped).toBe(0);
      recorder.finishStop();
      await Promise.all([stopResult, discardResult]);
    });
    expect(streams[0].getTracks()[0].stopped).toBe(1);
    expect(await stopResult).toBeNull();
  });

  it('coalesces concurrent stop calls into one clip and one storage write', async () => {
    let created = 0; let writes = 0;
    const store: BrowserAudioClipStore = {
      isOpen: () => true,
      createUri: () => `test:clip-${++created}`,
      put: async () => { writes += 1; }, get: async () => new Blob(['audio']), remove: async () => undefined,
    };
    renderEngine(store); await startCapture();
    let first!: Promise<Awaited<ReturnType<AudioCapture['stop']>>>;
    let second!: Promise<Awaited<ReturnType<AudioCapture['stop']>>>;
    act(() => {
      first = captureRef.current!.stop();
      second = captureRef.current!.stop();
    });
    let left!: Awaited<ReturnType<AudioCapture['stop']>>;
    let right!: Awaited<ReturnType<AudioCapture['stop']>>;
    await act(async () => { [left, right] = await Promise.all([first, second]); });
    expect(left && 'uri' in left ? left.uri : null).toBe('test:clip-1');
    expect(right).toBe(left);
    expect(created).toBe(1); expect(writes).toBe(1);
  });

  it('retains the same clip handle after storage failure for an explicit retry', async () => {
    let created = 0; let writes = 0;
    const store: BrowserAudioClipStore = {
      isOpen: () => true,
      createUri: () => `test:retry-${++created}`,
      put: async () => { writes += 1; if (writes === 1) throw new Error('write failed'); },
      get: async () => new Blob(['audio']), remove: async () => undefined,
    };
    renderEngine(store); await startCapture();
    let failure: unknown;
    await act(async () => { try { await captureRef.current!.stop(); } catch (cause) { failure = cause; } });
    expect(failure).toMatchObject({ message: 'write failed' });
    expect(captureRef.current!.hasPending).toBe(true);
    const result = await stopCapture();
    expect(result && 'uri' in result ? result.uri : null).toBe('test:retry-1');
    expect(created).toBe(1); expect(writes).toBe(2); expect(FakeRecorder.instances[0].stopCalls).toBe(1);
  });

  it('does not claim stop or release the microphone when MediaRecorder.stop fails', async () => {
    renderCloud(); await startCapture();
    const recorder = FakeRecorder.instances[0]; FakeRecorder.stopBehavior = 'throw';
    await expect(stopCapture()).rejects.toMatchObject({ name: 'CaptureStillActiveError' });
    expect(streams[0].getTracks()[0].stopped).toBe(0);
    FakeRecorder.stopBehavior = 'event';
    await act(async () => { recorder.finishStop(); });
    expect(streams[0].getTracks()[0].stopped).toBe(0);
    await act(async () => { await captureRef.current!.cancel(); });
    expect(streams[0].getTracks()[0].stopped).toBe(1);
  });

  it('keeps stopped clips in memory, never opens IndexedDB, and clears them on discard or unmount', async () => {
    const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get: () => { throw new Error('IndexedDB must not be used by cloud capture'); } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('localStorage must not be used by cloud capture'); } });
    try {
      renderCloud(); await startCapture();
      const result = await stopCapture();
      expect(result && 'uri' in result ? result.uri : '').toMatch(/^temporary-audio:/);
      if (!result || !('uri' in result)) throw new Error('Expected a temporary browser capture handle.');
      const readClip = (captureRef.current as CloudAudioCapture).readTemporaryClip;
      const blob = await readClip(result.uri);
      expect(blob).toBeInstanceOf(Blob);
      act(() => root.unmount());
      await expect(readClip(result.uri)).rejects.toThrow('no longer available');
    } finally {
      if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('preserves legacy IndexedDB persistence for the existing browser hook', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const { getAudio } = await import('../src/audio/blobStore.web');
    renderLegacy(); await startCapture();
    const result = await stopCapture();
    if (!result || !('uri' in result)) throw new Error('Expected the legacy browser capture handle.');
    expect(result.uri).toMatch(/^indexeddb-audio:/);
    expect(await getAudio(result.uri)).toBeTruthy();
  });

  it('does not create or play an audio element when an awaited read is superseded', async () => {
    const gate = deferred<Blob>();
    const store: BrowserAudioClipStore = {
      isOpen: () => true, createUri: () => 'test:clip', put: async () => undefined,
      get: () => gate.promise, remove: async () => undefined,
    };
    renderEngine(store);
    let playing!: Promise<void>;
    let newer!: Promise<void>;
    act(() => {
      playing = captureRef.current!.play('test:clip');
      newer = captureRef.current!.play('test:clip');
    });
    gate.resolve(new Blob(['audio']));
    await vi.waitFor(() => expect(audioInstances).toHaveLength(1));
    playGates[0]();
    await act(async () => { await Promise.all([playing, newer]); });
    expect(audioInstances).toHaveLength(1);
    expect(playGates).toHaveLength(1);
  });

  it('fences a delayed old-store write after owner replacement without changing the new owner state', async () => {
    const delayedWrite = deferred<void>();
    const writeStarted = deferred<void>();
    let oldOpen = true; let oldCreated = 0;
    const oldStore: BrowserAudioClipStore = {
      isOpen: () => oldOpen,
      createUri: () => `old:${++oldCreated}`,
      put: async () => { writeStarted.resolve(); await delayedWrite.promise; },
      get: async () => new Blob(['old']), remove: async () => undefined,
      close: () => { oldOpen = false; },
    };
    const newClips = new Map<string, Blob>(); let newCreated = 0;
    const newStore: BrowserAudioClipStore = {
      isOpen: () => true,
      createUri: () => `new:${++newCreated}`,
      put: async (uri, blob) => { newClips.set(uri, blob); },
      get: async (uri) => { const blob = newClips.get(uri); if (!blob) throw new Error('missing'); return blob; },
      remove: async (uri) => { newClips.delete(uri); },
    };
    renderEngine(oldStore); await startCapture();
    FakeRecorder.instances[0].emitChunk('old owner bytes');
    let oldStop!: Promise<Awaited<ReturnType<AudioCapture['stop']>>>;
    act(() => { oldStop = captureRef.current!.stop(); });
    await writeStarted.promise;

    act(() => root.render(React.createElement(EngineHarness, { store: newStore })));
    await startCapture();
    FakeRecorder.instances[1].emitChunk('new owner bytes');
    const newResult = await stopCapture();
    if (!newResult || !('uri' in newResult)) throw new Error('Expected new owner clip.');
    act(() => captureRef.current!.commit(newResult.uri));
    expect(captureRef.current!.hasPending).toBe(false);

    await act(async () => {
      delayedWrite.resolve();
      await expect(oldStop).resolves.toMatchObject({ uri: 'old:1' });
    });
    expect(captureRef.current!.hasPending).toBe(false);
    await startCapture();
    expect(FakeRecorder.instances).toHaveLength(3);
  });
});
