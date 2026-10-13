/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioCapture } from '../src/audio/types';
import { shouldAutoStopRecording } from '../src/audio/autoStop';
import { createPrivacyAudioBoundary, type PrivacyAudioBoundary } from '../src/privacy/audioBoundary';
import { useAudioCapture } from '../src/audio/useAudioCapture.native';
import * as FileSystem from 'expo-file-system/legacy';

type HookFakeStatus = { url: string | null; durationMillis: number; isRecording: boolean; canRecord: boolean; mediaServicesDidReset: boolean };
type HookFakeRecorder = {
  id: string;
  getStatus: () => HookFakeStatus;
  record: () => void;
  pause: () => void;
  stop: () => void;
  prepareToRecordAsync: () => Promise<void>;
  readonly isRecording: boolean;
};

const fake = vi.hoisted(() => {
  const state = {
    status: { url: null, durationMillis: 0, isRecording: false, canRecord: false, mediaServicesDidReset: false } as HookFakeStatus,
  enabled: false,
  prepared: false,
  autoResume: true,
  failStatusReads: false,
  statusReads: 0,
    appStateListeners: [] as ((state: string) => void)[],
    nextFile: 1,
    files: new Map<string, string>(),
    prepareOptions: [] as unknown[],
    listeners: [] as ((status: HookFakeStatus) => void)[],
    recorder: undefined as unknown as HookFakeRecorder,
  };
  state.recorder = {
    id: 'capture-hook-fake',
    getStatus: () => {
      state.statusReads += 1;
      if (state.failStatusReads && state.statusReads > 1) throw new Error('simulated native status read failure');
      return { ...state.status };
    },
    get isRecording() { return state.status.isRecording; },
    record: () => { if (state.enabled && state.status.canRecord) { state.status.isRecording = true; if (state.status.url) state.files.set(state.status.url, `${state.files.get(state.status.url) ?? ''}x`); } },
    pause: () => { state.status.isRecording = false; },
    stop: () => { state.status.isRecording = false; state.status.canRecord = false; state.status.durationMillis = 0; },
    prepareToRecordAsync: async (options?: unknown) => {
      state.prepared = true;
      state.prepareOptions.push(options);
      const url = options === undefined && state.status.url
        ? state.status.url
        : `file:///capture-${state.nextFile++}.m4a`;
      state.files.set(url, '');
      state.status = { url, durationMillis: 0, isRecording: false, canRecord: true, mediaServicesDidReset: false };
      state.statusReads = 0;
    },
  };
  return Object.assign(state, {
    reset() {
      state.status = { url: null, durationMillis: 0, isRecording: false, canRecord: false, mediaServicesDidReset: false };
      state.enabled = false; state.prepared = false; state.autoResume = true; state.appStateListeners = [];
      state.failStatusReads = false; state.statusReads = 0; state.listeners = []; state.nextFile = 1; state.files.clear(); state.prepareOptions = [];
    },
    emit() { for (const listener of state.listeners) listener({ ...state.status }); },
    foreground() {
      if (state.autoResume && state.enabled && state.prepared && state.status.canRecord) state.status.isRecording = true;
      for (const listener of state.appStateListeners) listener('active');
      for (const listener of state.listeners) listener({ ...state.status });
    },
    interruptionEnded(shouldResume: boolean) {
      if (shouldResume && state.autoResume && state.enabled && state.prepared && state.status.canRecord) state.status.isRecording = true;
      for (const listener of state.listeners) listener({ ...state.status });
    },
  });
});

vi.mock('expo-audio', async () => {
  const hooks = await import('react');
  const readStatus = () => {
    fake.statusReads += 1;
    if (fake.failStatusReads && fake.statusReads > 1) throw new Error('simulated native status read failure');
    return { ...fake.status };
  };
  return {
    RecordingPresets: { HIGH_QUALITY: {} },
    requestRecordingPermissionsAsync: async () => ({ granted: true }),
    setAudioModeAsync: async ({ allowsRecording }: { allowsRecording: boolean }) => {
      fake.enabled = allowsRecording;
      if (!allowsRecording) fake.status.isRecording = false;
    },
    useAudioRecorder: (_options: unknown, listener?: (status: HookFakeStatus) => void) => {
      hooks.useEffect(() => {
        if (!listener) return undefined;
        fake.listeners.push(listener);
        return () => { fake.listeners = fake.listeners.filter((item) => item !== listener); };
      }, [listener]);
      return fake.recorder;
    },
    useAudioRecorderState: (_recorder: unknown, interval = 500) => {
      const [state, setState] = hooks.useState(() => readStatus());
      hooks.useEffect(() => {
        const timer = setInterval(() => {
          const next = readStatus();
          setState((previous) => previous.url !== next.url || previous.isRecording !== next.isRecording ||
            previous.canRecord !== next.canRecord || previous.mediaServicesDidReset !== next.mediaServicesDidReset ||
            Math.abs(previous.durationMillis - next.durationMillis) > 50 ? next : previous);
        }, interval);
        return () => clearInterval(timer);
      }, [interval]);
      return state;
    },
    useAudioPlayer: () => ({ replace: () => undefined, play: () => undefined }),
  };
});

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      fake.appStateListeners.push(listener);
      return { remove: () => { fake.appStateListeners = fake.appStateListeners.filter((item) => item !== listener); } };
    },
  },
}));

vi.mock('expo-file-system/legacy', () => ({
  deleteAsync: vi.fn(async () => undefined),
}));

function makeBoundary() {
  let tail = Promise.resolve();
  const privacy = {
    assertWorkspaceEpoch: async () => undefined,
    withWriter: async (_epoch: string, _descriptor: unknown, work: (lease: unknown) => Promise<unknown>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await work({}); }
      finally { release(); }
    },
  };
  return createPrivacyAudioBoundary({ privacy: privacy as never, session: { epoch: 'hook-test', runtimeId: 'hook-runtime' }, captureNamespace: 'native_recordings' });
}

describe('native capture hook wiring', () => {
  let root: Root | undefined;
  let audio: AudioCapture;
  let container: HTMLDivElement;
  let boundary: PrivacyAudioBoundary;
  let previousActEnvironment: boolean | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.reset();
    previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    boundary = makeBoundary();
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root?.render(React.createElement(function Harness() {
        audio = useAudioCapture(boundary);
        return null;
      }));
    });
  }

  async function flushTimers(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it('starts before the first cached poll without latching its old null URI, and publishes fresh fractional duration', async () => {
    await mount();
    await act(async () => { await audio.start(); });
    expect(audio.status).toBe('recording');
    expect(audio.error).not.toContain('interrupted');

    for (const millis of [250, 500, 750, 1000]) {
      fake.status.durationMillis = millis;
      await flushTimers(250);
    }
    expect(audio.durationSeconds).toBe(1);
    expect(shouldAutoStopRecording({ startupReady: true, isolatedPreview: false, outcomeUnknown: false, busy: false, status: audio.status, durationSeconds: audio.durationSeconds, maxAudioSeconds: 1 })).toBe(true);
    await act(async () => { await audio.cancel(); });
  });

  it('prepares a distinct file for each new capture and never prepares again on resume', async () => {
    await mount();
    vi.setSystemTime(new Date('2026-10-13T04:00:00.000Z'));
    await act(async () => { await audio.start(); });
    const firstUri = fake.status.url;
    expect(firstUri).toBe('file:///capture-1.m4a');
    expect(fake.prepareOptions[0]).toEqual({ directory: 'document', isMeteringEnabled: true });
    const preparesBeforeResume = fake.prepareOptions.length;

    await act(async () => { await audio.pause(); });
    await act(async () => { await audio.resume(); });
    expect(fake.status.url).toBe(firstUri);
    expect(fake.prepareOptions).toHaveLength(preparesBeforeResume);
    await act(async () => { fake.foreground(); fake.interruptionEnded(true); });
    expect(audio.status).toBe('recording');
    await act(async () => { await audio.pause(); });
    await act(async () => { fake.foreground(); fake.interruptionEnded(true); });
    expect(fake.status.isRecording).toBe(false);
    expect(audio.status).toBe('paused');
    await act(async () => { await audio.resume(); });
    expect(fake.status.isRecording).toBe(true);

    fake.status.durationMillis = 1250;
    await flushTimers(250);
    const firstResult: { value: Awaited<ReturnType<AudioCapture['stop']>> } = { value: null };
    await act(async () => { firstResult.value = await audio.stop(); });
    expect(firstResult.value?.uri).toBe(firstUri);
    expect(firstResult.value?.capturedAt).toBe('2026-10-13T04:00:00.000Z');
    expect(firstResult.value?.durationSeconds).toBe(1.25);
    const savedFirstFile = fake.files.get(firstUri!);
    await act(async () => { audio.commit(firstUri!); });

    vi.setSystemTime(new Date('2026-10-13T04:01:00.000Z'));
    await act(async () => { await audio.start(); });
    const secondUri = fake.status.url;
    expect(secondUri).not.toBe(firstUri);
    expect(fake.prepareOptions).toHaveLength(preparesBeforeResume + 1);
    fake.status.durationMillis = 500;
    await flushTimers(250);
    const secondResult: { value: Awaited<ReturnType<AudioCapture['stop']>> } = { value: null };
    await act(async () => { secondResult.value = await audio.stop(); });
    expect(secondResult.value?.uri).toBe(secondUri);
    expect(secondResult.value?.capturedAt).toBe('2026-10-13T04:01:00.000Z');
    expect(secondResult.value?.capturedAt).not.toBe(firstResult.value?.capturedAt);
    expect(fake.files.get(firstUri!)).toBe(savedFirstFile);
    expect(fake.files.has(secondUri!)).toBe(true);
  });

  it('latches callback-only reset with unchanged flags and never saves a replacement URI', async () => {
    await mount();
    await act(async () => { await audio.start(); });
    await act(async () => { await audio.pause(); });
    expect(audio).toMatchObject({ status: 'paused', canResume: true });

    fake.status.mediaServicesDidReset = true;
    fake.emit();
    await flushTimers(0);
    expect(audio).toMatchObject({ status: 'paused', canResume: false, statusLabel: 'Recording interrupted' });

    fake.status.url = 'file:///replacement-capture.m4a';
    fake.status.mediaServicesDidReset = false;
    let result: Awaited<ReturnType<AudioCapture['stop']>> = null;
    await act(async () => { result = await audio.stop(); });
    expect(result).toBeNull();
    expect(audio).toMatchObject({ hasPending: true, statusLabel: 'Recording interrupted' });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();

    await act(async () => { await audio.cancel(); });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///capture-1.m4a', { idempotent: true });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///replacement-capture.m4a', { idempotent: true });
  });

  it('keeps a prepared source reachable for Stop and Discard after a native status read fails', async () => {
    await mount();
    fake.failStatusReads = true;
    await act(async () => { await audio.start(); });
    expect(audio).toMatchObject({ status: 'recording', canResume: false, statusLabel: 'Recording status uncertain' });

    fake.failStatusReads = false;
    await act(async () => { await audio.cancel(); });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///capture-1.m4a', { idempotent: true });
    expect(audio.hasPending).toBe(false);
  });
});
