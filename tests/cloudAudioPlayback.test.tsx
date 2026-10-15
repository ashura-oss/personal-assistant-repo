/** @vitest-environment jsdom */
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useCloudAudioPlayback,
  type CloudAudioPlaybackElement,
  type CloudAudioPlaybackOptions,
} from '../src/web/useCloudAudioPlayback';

const MEDIA_A = '123e4567-e89b-42d3-a456-426614174000';
const MEDIA_B = '123e4567-e89b-42d3-b456-426614174001';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeAudio implements CloudAudioPlaybackElement {
  preload = '';
  src = '';
  pauseCalls = 0;
  loadCalls = 0;
  playCalls = 0;
  removed: string[] = [];
  listeners = new Map<string, Set<EventListener>>();
  playResult: Promise<void> = Promise.resolve();

  play() { this.playCalls += 1; return this.playResult; }
  pause() { this.pauseCalls += 1; }
  load() { this.loadCalls += 1; }
  removeAttribute(name: string) { this.removed.push(name); if (name === 'src') this.src = ''; }
  addEventListener(type: 'playing' | 'pause' | 'ended' | 'error', listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: 'playing' | 'pause' | 'ended' | 'error', listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: 'playing' | 'pause' | 'ended' | 'error') {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

let host: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof useCloudAudioPlayback> | undefined;
let options: CloudAudioPlaybackOptions;
let created: FakeAudio[];
let factory: () => CloudAudioPlaybackElement;

function Harness(props: CloudAudioPlaybackOptions) {
  const value = useCloudAudioPlayback(props);
  useEffect(() => { current = value; }, [value]);
  return null;
}

function render(props = options, strict = false) {
  act(() => root.render(strict
    ? React.createElement(React.StrictMode, null, React.createElement(Harness, props))
    : React.createElement(Harness, props)));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  current = undefined;
  created = [];
  factory = () => { const audio = new FakeAudio(); created.push(audio); return audio; };
  options = { ownerKey: 'owner-a:note-a:revision-1:epoch-1', mediaId: MEDIA_A, createAudioElement: factory };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('useCloudAudioPlayback', () => {
  it('is StrictMode-safe and does not assign a source or play until explicit play', async () => {
    render(options, true);
    expect(created).toHaveLength(2);
    expect(created[0]?.preload).toBe('none');
    expect(created[0]?.src).toBe('');
    expect(created[0]?.playCalls).toBe(0);
    expect(created[1]?.src).toBe('');
    expect(created[1]?.playCalls).toBe(0);
    expect(current?.state).toEqual({ status: 'ready' });

    await act(async () => { await current?.play(); });
    expect(created[1]?.src).toBe(`/api/audio/${MEDIA_A}`);
    expect(created[1]?.loadCalls).toBe(1);
    expect(created[1]?.playCalls).toBe(1);
    expect(current?.state.status).toBe('playing');
  });

  it('rejects invalid IDs without creating an element or assigning any URL', () => {
    render({ ...options, mediaId: `still-media:${MEDIA_A}` });
    expect(current?.state).toEqual({ status: 'error', error: 'Audio playback is unavailable for this recording.' });
    expect(created).toHaveLength(0);
  });

  it('stops, detaches and clears the old player when owner or media changes', () => {
    render();
    const oldAudio = created[0]!;
    render({ ...options, ownerKey: 'owner-a:note-b:revision-2:epoch-1', mediaId: MEDIA_B });
    expect(oldAudio.pauseCalls).toBe(1);
    expect(oldAudio.removed).toContain('src');
    expect(oldAudio.loadCalls).toBe(1);
    expect([...oldAudio.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1]?.src).toBe('');
    expect(current?.state).toEqual({ status: 'ready' });
  });

  it('returns to A with a fresh ready player after A to B to A selection', async () => {
    render();
    const playerA1 = created[0]!;
    await act(async () => { await current?.play(); });
    expect(current?.state.status).toBe('playing');

    render({ ...options, ownerKey: 'owner-a:note-b:revision-2:epoch-1', mediaId: MEDIA_B });
    render(options);
    expect(created).toHaveLength(3);
    expect(playerA1.src).toBe('');
    expect(created[2]?.src).toBe('');
    expect(created[2]?.playCalls).toBe(0);
    expect(current?.state).toEqual({ status: 'ready' });
  });

  it('resets state when the player factory changes for the same owner and media', async () => {
    render();
    const oldPlayer = created[0]!;
    await act(async () => { await current?.play(); });
    expect(current?.state.status).toBe('playing');

    const replacementFactory = () => { const audio = new FakeAudio(); created.push(audio); return audio; };
    render({ ...options, createAudioElement: replacementFactory });
    expect(created).toHaveLength(2);
    expect(oldPlayer.src).toBe('');
    expect(created[1]?.src).toBe('');
    expect(created[1]?.playCalls).toBe(0);
    expect(current?.state).toEqual({ status: 'ready' });
  });

  it('fences delayed play completion and stale events after logout or owner replacement', async () => {
    render();
    const oldAudio = created[0]!;
    const gate = deferred<void>();
    oldAudio.playResult = gate.promise;
    let oldPlay!: Promise<void>;
    await act(async () => { oldPlay = current!.play(); await Promise.resolve(); });
    expect(oldAudio.playCalls).toBe(1);

    render({ ownerKey: 'owner-b:logged-out:epoch-2' });
    expect(current?.state).toEqual({ status: 'idle' });
    await act(async () => {
      gate.reject(new Error('secret or transport detail'));
      await oldPlay;
    });
    act(() => oldAudio.emit('error'));
    expect(current?.state).toEqual({ status: 'idle' });
    expect(oldAudio.src).toBe('');
  });

  it('reports a safe fixed error for rejected playback and handles pause and ended events', async () => {
    render();
    const audio = created[0]!;
    audio.playResult = Promise.reject(new Error('sensitive browser detail'));
    await act(async () => { await current?.play(); });
    expect(current?.state).toEqual({ status: 'error', error: 'Audio playback could not be started.' });

    audio.playResult = Promise.resolve();
    await act(async () => { await current?.play(); });
    act(() => audio.emit('playing'));
    expect(current?.state.status).toBe('playing');
    act(() => audio.emit('ended'));
    expect(current?.state.status).toBe('ready');
    await act(async () => { await current?.play(); });
    act(() => current?.pause());
    expect(audio.pauseCalls).toBe(1);
    expect(current?.state.status).toBe('paused');
  });

  it('keeps an explicit pause authoritative over a pending play and permits a fresh play', async () => {
    render();
    const audio = created[0]!;
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    audio.playResult = firstGate.promise;
    let firstPlay!: Promise<void>;
    await act(async () => { firstPlay = current!.play(); await Promise.resolve(); });
    act(() => current?.pause());
    expect(current?.state.status).toBe('paused');

    await act(async () => {
      firstGate.resolve();
      await firstPlay;
    });
    act(() => audio.emit('playing'));
    expect(current?.state.status).toBe('paused');

    audio.playResult = secondGate.promise;
    let secondPlay!: Promise<void>;
    await act(async () => { secondPlay = current!.play(); await Promise.resolve(); });
    expect(audio.playCalls).toBe(2);
    await act(async () => {
      secondGate.resolve();
      await secondPlay;
    });
    expect(current?.state.status).toBe('playing');
  });

  it('ignores a rejected pending play after explicit pause', async () => {
    render();
    const audio = created[0]!;
    const gate = deferred<void>();
    audio.playResult = gate.promise;
    let pendingPlay!: Promise<void>;
    await act(async () => { pendingPlay = current!.play(); await Promise.resolve(); });
    act(() => current?.pause());
    await act(async () => {
      gate.reject(new Error('late rejection detail'));
      await pendingPlay;
    });
    expect(current?.state.status).toBe('paused');
  });

  it('starts a fresh play after ended while the old play promise is pending', async () => {
    render();
    const audio = created[0]!;
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    audio.playResult = firstGate.promise;
    let firstPlay!: Promise<void>;
    await act(async () => { firstPlay = current!.play(); await Promise.resolve(); });
    act(() => audio.emit('ended'));
    expect(current?.state.status).toBe('ready');

    audio.playResult = secondGate.promise;
    let secondPlay!: Promise<void>;
    let duplicatePlay!: Promise<void>;
    await act(async () => { secondPlay = current!.play(); duplicatePlay = current!.play(); });
    expect(audio.playCalls).toBe(2);

    await act(async () => {
      firstGate.resolve();
      await firstPlay;
    });
    expect(current?.state.status).toBe('ready');
    expect(audio.playCalls).toBe(2);

    await act(async () => {
      secondGate.resolve();
      await Promise.all([secondPlay, duplicatePlay]);
    });
    expect(current?.state.status).toBe('playing');
    expect(audio.playCalls).toBe(2);
  });

  it('reports missing audio support without throwing during render', async () => {
    render({ ...options, createAudioElement: () => { throw new Error('not available'); } });
    expect(current?.state).toEqual({ status: 'error', error: 'Audio playback is unavailable for this recording.' });

    render(options);
    expect(created).toHaveLength(1);
    expect(current?.state).toEqual({ status: 'ready' });
    expect(created[0]?.src).toBe('');
  });
});
