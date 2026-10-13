/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioCapture } from '../src/audio/types';
import type { PendingCaptureJournalPort, PendingCaptureReceipt, PendingCaptureSafeStatus } from '../src/audio/pendingCaptureService.types';
import { shouldAutoStopRecording } from '../src/audio/autoStop';
import { createPrivacyAudioBoundary, type PrivacyAudioBoundary } from '../src/privacy/audioBoundary';
import { useAudioCapture } from '../src/audio/useAudioCapture.native';
import * as FileSystem from 'expo-file-system/legacy';

type HookFakeStatus = { url: string | null; durationMillis: number; isRecording: boolean; canRecord: boolean; mediaServicesDidReset: boolean };
type HookFakeRecorder = {
  id: string;
  getStatus: () => HookFakeStatus;
  readonly currentTime: number;
    record: (options?: { forDuration?: number }) => void;
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
  stopNoopPrepared: false,
  disableFailures: 0,
  prepareGate: undefined as Promise<void> | undefined,
  statusReads: 0,
    appStateListeners: [] as ((state: string) => void)[],
    nextFile: 1,
    files: new Map<string, string>(),
    prepareOptions: [] as unknown[],
    events: [] as string[],
    permissionGate: undefined as Promise<void> | undefined,
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
    get currentTime() { return state.status.durationMillis / 1000; },
    record: (_options?: { forDuration?: number }) => { state.events.push('record'); if (state.enabled && state.status.canRecord) { state.status.isRecording = true; if (state.status.url) state.files.set(state.status.url, `${state.files.get(state.status.url) ?? ''}x`); } },
    pause: () => { state.status.isRecording = false; },
    stop: () => {
      if (state.stopNoopPrepared && !state.status.isRecording && state.status.canRecord) return;
      state.status.isRecording = false; state.status.canRecord = false; state.status.durationMillis = 0;
    },
    prepareToRecordAsync: async (options?: unknown) => {
      state.prepared = true;
      state.prepareOptions.push(options);
      state.events.push('prepare');
      const url = options === undefined && state.status.url
        ? state.status.url
        : `file:///capture-${state.nextFile++}.m4a`;
      state.files.set(url, '');
      state.status = { url, durationMillis: 0, isRecording: false, canRecord: true, mediaServicesDidReset: false };
      state.statusReads = 0;
      await state.prepareGate;
    },
  };
  return Object.assign(state, {
    reset() {
      state.status = { url: null, durationMillis: 0, isRecording: false, canRecord: false, mediaServicesDidReset: false };
      state.enabled = false; state.prepared = false; state.autoResume = true; state.appStateListeners = [];
      state.stopNoopPrepared = false; state.disableFailures = 0;
      state.prepareGate = undefined;
      state.failStatusReads = false; state.statusReads = 0; state.listeners = []; state.nextFile = 1; state.files.clear(); state.prepareOptions = []; state.events = []; state.permissionGate = undefined;
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
    requestRecordingPermissionsAsync: async () => { fake.events.push('permission'); await fake.permissionGate; return { granted: true }; },
    setAudioModeAsync: async ({ allowsRecording }: { allowsRecording: boolean }) => {
      if (!allowsRecording && fake.prepared && fake.disableFailures > 0) { fake.disableFailures -= 1; fake.events.push('mode:disable:failed'); throw new Error('simulated mode-off failure'); }
      fake.enabled = allowsRecording;
      fake.events.push(allowsRecording ? 'mode:enable' : 'mode:disable');
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
  let writers = 0;
  const privacy = {
    assertWorkspaceEpoch: async () => undefined,
    withWriter: async (_epoch: string, _descriptor: unknown, work: (lease: unknown, scope: never) => Promise<unknown>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      writers += 1;
      try { return await work({}, {} as never); }
      finally { writers -= 1; release(); }
    },
  };
  return {
    boundary: createPrivacyAudioBoundary({ privacy: privacy as never, session: { epoch: 'hook-test', runtimeId: 'hook-runtime' }, captureNamespace: 'native_recordings' }),
    isWriterHeld: () => writers > 0,
  };
}

function makeJournal(options: { initial?: PendingCaptureSafeStatus; failPrepare?: boolean; discardResult?: PendingCaptureSafeStatus; prepareGate?: Promise<void> } = {}) {
  let safe: PendingCaptureSafeStatus = options.initial ?? { kind: 'empty' };
  let nextId = 1;
  let nextStatusGate: Promise<void> | undefined;
  const calls: string[] = [];
  const statusScopes: unknown[] = [];
  const port: PendingCaptureJournalPort = {
    async getStatus(scope) { calls.push('getStatus'); statusScopes.push(scope); const gate = nextStatusGate; nextStatusGate = undefined; await gate; return safe; },
    async prepare(_scope, input) {
      calls.push('prepare');
      await options.prepareGate;
      if (options.failPrepare) throw new Error('journal prepare failed');
      const created: PendingCaptureReceipt = { id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, revision: '00000000-0000-4000-8000-000000000100' };
      safe = { kind: 'pending', receipt: created, phase: 'prepared', capturedAt: input.capturedAt, inspection: 'not_checked', canSave: false, canExport: true, canDiscard: true, replacementOverflow: false };
      return created;
    },
    async observe(_scope, receipt) { calls.push('observe'); return receipt; },
    async stopped(_scope, receipt, _observation) {
      calls.push('stopped');
      const next = { ...receipt, revision: '00000000-0000-4000-8000-000000000101' };
      safe = { kind: 'pending', receipt: next, phase: 'needs_inspection', capturedAt: '2026-10-13T04:00:00.000Z', inspection: 'not_checked', canSave: false, canExport: true, canDiscard: true, replacementOverflow: false };
      return next;
    },
    released() { calls.push('released'); },
    async discard(_scope, receipt) { calls.push(`discard:${receipt.id}`); safe = options.discardResult ?? { kind: 'empty' }; return safe; },
    async discardUnjournaled(_scope, uri) { calls.push(`discardUnjournaled:${uri}`); safe = { kind: 'empty' }; return safe; },
  };
  return { port, calls, statusScopes, holdNextStatus(gate: Promise<void>) { nextStatusGate = gate; }, clear() { safe = { kind: 'empty' }; }, get status() { return safe; } };
}

describe('native capture hook wiring', () => {
  let root: Root | undefined;
  let audio: AudioCapture;
  let container: HTMLDivElement;
  let boundary: PrivacyAudioBoundary;
  let isWriterHeld: () => boolean;
  let journal: ReturnType<typeof makeJournal>;
  let previousActEnvironment: boolean | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.reset();
    previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    const made = makeBoundary(); boundary = made.boundary; isWriterHeld = made.isWriterHeld;
    journal = makeJournal();
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  async function mount(maxAudioSeconds = 600, suppliedJournal: PendingCaptureJournalPort | 'none' = journal.port): Promise<void> {
    await act(async () => {
      root?.render(React.createElement(function Harness() {
        audio = useAudioCapture(boundary, suppliedJournal === 'none' ? undefined : suppliedJournal, { ready: true, maxAudioSeconds });
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
    expect(journal.calls.indexOf('prepare')).toBeGreaterThanOrEqual(0);
    expect(fake.events.indexOf('prepare')).toBeLessThan(fake.events.indexOf('record'));
    expect(fake.prepareOptions).toEqual([{ directory: 'document', isMeteringEnabled: true }]);
    expect(audio.error).not.toContain('interrupted');

    for (const millis of [250, 500, 750, 1000]) {
      fake.status.durationMillis = millis;
      await flushTimers(250);
    }
    expect(audio.durationSeconds).toBe(1);
    expect(shouldAutoStopRecording({ startupReady: true, isolatedPreview: false, outcomeUnknown: false, busy: false, status: audio.status, durationSeconds: audio.durationSeconds, maxAudioSeconds: 1 })).toBe(true);
    const observationsBeforeMeters = journal.calls.filter((call) => call === 'observe').length;
    fake.status.durationMillis = 1250;
    await flushTimers(1000);
    expect(journal.calls.filter((call) => call === 'observe')).toHaveLength(observationsBeforeMeters);
    await act(async () => { await audio.cancel(); });
    expect(journal.calls.some((call) => call.startsWith('discard:'))).toBe(true);
  });

  it('keeps SDK foreground resume gated until journal preparation and post-await source verification', async () => {
    let releaseJournal!: () => void;
    journal = makeJournal({ prepareGate: new Promise<void>((resolve) => { releaseJournal = resolve; }) });
    await mount();
    let startError: unknown;
    let startPromise!: Promise<void>;
    await act(async () => { startPromise = audio.start(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(journal.calls).toContain('prepare');
    expect(fake.enabled).toBe(false);
    expect(fake.files.get('file:///capture-1.m4a')).toBe('');
    await act(async () => { fake.foreground(); fake.interruptionEnded(true); });
    expect(fake.events).not.toContain('record');
    expect(fake.files.get('file:///capture-1.m4a')).toBe('');

    releaseJournal();
    await act(async () => { try { await startPromise; } catch (cause) { startError = cause; } });
    expect(startError).toBeUndefined();
    expect(fake.events.indexOf('record')).toBeGreaterThan(fake.events.indexOf('mode:enable'));
    expect(audio.status).toBe('recording');
    await act(async () => { await audio.cancel(); });
  });

  it('does not enable recording if the source changes while durable journal preparation is pending', async () => {
    let releaseJournal!: () => void;
    journal = makeJournal({ prepareGate: new Promise<void>((resolve) => { releaseJournal = resolve; }) });
    await mount();
    let startError: unknown;
    let startPromise!: Promise<void>;
    await act(async () => { startPromise = audio.start(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    fake.status.url = 'file:///replacement-during-journal.m4a';
    fake.emit();
    releaseJournal();
    await act(async () => { try { await startPromise; } catch (cause) { startError = cause; } });
    expect(startError).toBeInstanceOf(Error);
    expect(fake.events).not.toContain('record');
    expect(fake.events).not.toContain('mode:enable');
    expect(audio).toMatchObject({ hasPending: true, status: 'idle' });
    expect(journal.calls).toContain('prepare');
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
    expect(isWriterHeld()).toBe(false);
    expect(firstResult.value?.kind).toBe('pending_capture');
    if (firstResult.value?.kind !== 'pending_capture') throw new Error('Expected a pending capture receipt.');
    const firstCaptureId = firstResult.value.receipt.id;
    const savedFirstFile = fake.files.get(firstUri!);
    await act(async () => { audio.commit(firstCaptureId); });
    journal.clear();

    vi.setSystemTime(new Date('2026-10-13T04:01:00.000Z'));
    await act(async () => { await audio.start(); });
    const secondUri = fake.status.url;
    expect(secondUri).not.toBe(firstUri);
    expect(fake.prepareOptions).toHaveLength(preparesBeforeResume + 1);
    fake.status.durationMillis = 500;
    await flushTimers(250);
    const secondResult: { value: Awaited<ReturnType<AudioCapture['stop']>> } = { value: null };
    await act(async () => { secondResult.value = await audio.stop(); });
    expect(secondResult.value?.kind).toBe('pending_capture');
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
    const stopResult: { value: Awaited<ReturnType<AudioCapture['stop']>> } = { value: null };
    await act(async () => { stopResult.value = await audio.stop(); });
    expect(stopResult.value?.kind).toBe('pending_capture');
    expect(audio).toMatchObject({ hasPending: true, statusLabel: 'Recording interrupted' });
    expect(journal.calls).toContain('stopped');

    await act(async () => { await audio.cancel(); });
    expect(journal.calls.some((call) => call.startsWith('discard:'))).toBe(true);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('keeps a prepared source reachable for Stop and Discard after a native status read fails', async () => {
    await mount();
    fake.failStatusReads = true;
    let startError: unknown;
    await act(async () => { try { await audio.start(); } catch (cause) { startError = cause; } });
    expect(startError).toMatchObject({ name: 'CaptureStillActiveError' });
    expect(audio).toMatchObject({ status: 'recording', canResume: false, statusLabel: 'Recording status uncertain' });

    fake.failStatusReads = false;
    await act(async () => { await audio.cancel(); });
    expect(journal.calls.some((call) => call.startsWith('discard:'))).toBe(true);
    expect(audio.hasPending).toBe(false);
  });

  it('requires journal preparation before the first native record call', async () => {
    journal = makeJournal({ failPrepare: true });
    await mount();
    let startError: unknown;
    await act(async () => { try { await audio.start(); } catch (cause) { startError = cause; } });
    expect(startError).toMatchObject({ message: 'journal prepare failed' });
    expect(journal.calls).toContain('prepare');
    expect(fake.events).toContain('prepare');
    expect(fake.events).not.toContain('record');
    expect(audio).toMatchObject({ hasPending: true, status: 'idle' });
    expect(journal.calls).not.toContain('discardUnjournaled:file:///capture-1.m4a');
    await act(async () => { await audio.cancel(); });
    expect(journal.calls).toContain('discardUnjournaled:file:///capture-1.m4a');
  });

  it('keeps the capture writer lease after failed setup until a later stop proves the prepared recorder quiescent', async () => {
    journal = makeJournal({ failPrepare: true });
    fake.stopNoopPrepared = true;
    fake.disableFailures = 1;
    await mount();
    let startError: unknown;
    await act(async () => { try { await audio.start(); } catch (cause) { startError = cause; } });
    expect(startError).toMatchObject({ name: 'CaptureStillActiveError' });
    expect(audio).toMatchObject({ status: 'recording', canResume: false, statusLabel: 'Recording status uncertain' });
    expect(isWriterHeld()).toBe(true);
    expect(fake.events).not.toContain('record');
    expect(fake.events).toContain('mode:disable:failed');
    expect(journal.calls.filter((call) => call === 'released')).toHaveLength(0);

    await act(async () => { await audio.cancel(); });
    expect(isWriterHeld()).toBe(false);
    expect(fake.events.filter((event) => event === 'mode:disable')).toHaveLength(3);
    expect(journal.calls).toContain('discardUnjournaled:file:///capture-1.m4a');
    expect(journal.calls.filter((call) => call === 'released')).toHaveLength(1);
    expect(audio).toMatchObject({ status: 'idle', hasPending: false });
  });

  it('restores a durable pending receipt without preparing or recording again', async () => {
    const restoredReceipt = { id: '00000000-0000-4000-8000-000000000099', revision: '00000000-0000-4000-8000-000000000100' };
    journal = makeJournal({ initial: {
      kind: 'pending', receipt: restoredReceipt, phase: 'needs_inspection', capturedAt: '2026-10-13T04:00:00.000Z',
      inspection: 'not_checked', canSave: false, canExport: true, canDiscard: true, replacementOverflow: false,
    } });
    await mount();
    expect(audio).toMatchObject({ hasPending: true, status: 'idle' });
    let restoredResult: Awaited<ReturnType<AudioCapture['stop']>> = null;
    await act(async () => { restoredResult = await audio.stop(); });
    expect(restoredResult).toEqual({ kind: 'pending_capture', receipt: restoredReceipt });
    expect(fake.events).toEqual([]);
    expect(journal.calls).not.toContain('prepare');
  });

  it('passes the precise remaining duration on resume and refuses a zero remaining limit', async () => {
    const recordedLimits: number[] = [];
    const originalRecord = fake.recorder.record;
    fake.recorder.record = (input) => { if (input?.forDuration !== undefined) recordedLimits.push(input.forDuration); originalRecord(input); };
    await mount(10);
    await act(async () => { await audio.start(); });
    fake.status.durationMillis = 9_750;
    await act(async () => { await audio.pause(); });
    await act(async () => { await audio.resume(); });
    expect(recordedLimits.at(-1)).toBeCloseTo(0.25, 8);
    fake.status.durationMillis = 10_000;
    await act(async () => { await audio.pause(); });
    const before = recordedLimits.length;
    await act(async () => { await audio.resume(); });
    expect(recordedLimits).toHaveLength(before);
    await act(async () => { await audio.cancel(); });
  });

  it.each([Number.NaN, -0.25])('does not call native record when fresh currentTime is invalid (%s)', async (seconds) => {
    const recordedLimits: number[] = [];
    const originalRecord = fake.recorder.record;
    fake.recorder.record = (input) => { if (input?.forDuration !== undefined) recordedLimits.push(input.forDuration); originalRecord(input); };
    await mount(10);
    await act(async () => { await audio.start(); });
    const callsBeforeResume = recordedLimits.length;
    fake.status.durationMillis = seconds * 1000;
    await act(async () => { await audio.pause(); });
    await act(async () => { await audio.resume(); });
    expect(recordedLimits).toHaveLength(callsBeforeResume);
    await act(async () => { await audio.cancel(); });
  });

  it('retains pending state when discard cannot confirm all tracked files are gone', async () => {
    const receipt = { id: '00000000-0000-4000-8000-000000000077', revision: '00000000-0000-4000-8000-000000000078' };
    journal = makeJournal({
      initial: { kind: 'pending', receipt, phase: 'discarding', capturedAt: '2026-10-13T04:00:00.000Z', inspection: 'not_checked', canSave: false, canExport: false, canDiscard: true, replacementOverflow: true },
      discardResult: { kind: 'pending', receipt, phase: 'discarding', capturedAt: '2026-10-13T04:00:00.000Z', inspection: 'not_checked', canSave: false, canExport: false, canDiscard: true, replacementOverflow: true },
    });
    await mount();
    await act(async () => { await audio.cancel(); });
    expect(audio).toMatchObject({ hasPending: true, status: 'idle' });
    expect(journal.status.kind).toBe('pending');
  });

  it('rejects an unavailable journal before requesting microphone permission', async () => {
    await mount(600, 'none');
    let startError: unknown;
    await act(async () => { try { await audio.start(); } catch (cause) { startError = cause; } });
    expect(startError).toMatchObject({ message: 'Secure recording storage is not configured.' });
    expect(fake.events).toEqual([]);
  });

  it('does not record frames when Stop cancels a delayed permission setup', async () => {
    await mount();
    let releasePermission!: () => void;
    fake.permissionGate = new Promise<void>((resolve) => { releasePermission = resolve; });
    let startPromise!: Promise<void>;
    await act(async () => { startPromise = audio.start(); await Promise.resolve(); });
    let cancelPromise!: Promise<void>;
    await act(async () => { cancelPromise = audio.cancel(); await Promise.resolve(); });
    let settlements!: PromiseSettledResult<void>[];
    await act(async () => {
      releasePermission();
      settlements = await Promise.allSettled([startPromise, cancelPromise]);
    });
    const [started, cancelled] = settlements;
    expect(started.status).toBe('rejected');
    expect(cancelled.status).toBe('rejected');
    expect(fake.events).not.toContain('record');
    expect(journal.calls).not.toContain('prepare');
  });

  it('invalidates a delayed start preflight when Stop is requested before it resolves', async () => {
    await mount();
    let releaseStatus!: () => void;
    journal.holdNextStatus(new Promise<void>((resolve) => { releaseStatus = resolve; }));
    let startError: unknown;
    let startPromise!: Promise<void>;
    await act(async () => { startPromise = audio.start(); await Promise.resolve(); });
    await act(async () => { await audio.stop(); });
    releaseStatus();
    await act(async () => { try { await startPromise; } catch (cause) { startError = cause; } });
    expect(startError).toMatchObject({ message: 'Recording start was cancelled.' });
    expect(fake.events).not.toContain('permission');
    expect(fake.events).not.toContain('prepare');
    expect(isWriterHeld()).toBe(false);
  });

  it('invalidates a delayed start preflight when the hook unmounts', async () => {
    await mount();
    let releaseStatus!: () => void;
    journal.holdNextStatus(new Promise<void>((resolve) => { releaseStatus = resolve; }));
    let startError: unknown;
    let startPromise!: Promise<void>;
    await act(async () => { startPromise = audio.start(); await Promise.resolve(); });
    await act(async () => { root?.unmount(); root = undefined; });
    releaseStatus();
    await act(async () => { try { await startPromise; } catch (cause) { startError = cause; } });
    expect(startError).toMatchObject({ message: 'Recording start was cancelled.' });
    expect(fake.events).not.toContain('permission');
    expect(fake.events).not.toContain('prepare');
    expect(isWriterHeld()).toBe(false);
  });

  it('reads the journal with the current stop scope after quiescence when setup failed before a receipt', async () => {
    journal = makeJournal({ failPrepare: true });
    fake.stopNoopPrepared = true;
    fake.disableFailures = 1;
    await mount();
    let startError: unknown;
    await act(async () => { try { await audio.start(); } catch (cause) { startError = cause; } });
    expect(startError).toMatchObject({ name: 'CaptureStillActiveError' });
    await act(async () => { await audio.stop(); });
    expect(journal.statusScopes.some((scope) => scope !== undefined)).toBe(true);
    expect(isWriterHeld()).toBe(false);
  });

  it('reads the journal with the current cancel scope when setup is cancelled before a receipt exists', async () => {
    await mount();
    let releasePrepare!: () => void;
    fake.prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    fake.stopNoopPrepared = true;
    fake.disableFailures = 1;
    let startPromise!: Promise<void>;
    await act(async () => { startPromise = audio.start(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(fake.events).toContain('prepare');
    let cancelPromise!: Promise<void>;
    await act(async () => { cancelPromise = audio.cancel(); await Promise.resolve(); });
    await act(async () => {
      releasePrepare();
      await Promise.allSettled([startPromise, cancelPromise]);
    });
    expect(journal.statusScopes.some((scope) => scope !== undefined)).toBe(true);
    expect(isWriterHeld()).toBe(false);
  });
});
