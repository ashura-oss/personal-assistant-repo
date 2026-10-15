import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureStillActiveError, createPrivacyAudioBoundary, createPrivacyBoundNativeSpeechAudioIO, createPrivacyBoundRecordingRecoveryService } from '../src/privacy/audioBoundary';
import { CaptureStillActiveError as BrowserCaptureStillActiveError } from '../src/audio/captureErrors';
import { createPrivacyService } from '../src/privacy/service';
import type { PrivacyService, PrivacyWorkspaceSession } from '../src/privacy/service';
import type { PrivacyControlState, PrivacyControlStore, PrivacyOwner, PrivacyWriterDescriptor, PrivacyWriterLease, PrivacyWriterScope } from '../src/privacy/types';
import { createEmptyPrivacyControlState, validatePrivacyControlState } from '../src/privacy/schema';
import type { RecordingRecoveryService } from '../src/audio/recovery.types';
import type { NativeSpeechAudioIO } from '../src/audio/speechUpload.types';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => undefined }));
afterEach(() => vi.unstubAllGlobals());

it('re-exports the shared capture error class used by browser and native capture', () => {
  expect(CaptureStillActiveError).toBe(BrowserCaptureStillActiveError);
  expect(new BrowserCaptureStillActiveError()).toBeInstanceOf(CaptureStillActiveError);
});

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolvePromise = res; reject = rej; });
  return { promise, resolve: (value?: T | PromiseLike<T>) => resolvePromise(value as T), reject };
}

function makePrivacy() {
  const events: string[] = [];
  let epoch = 'epoch-1';
  const scope = Object.freeze({}) as PrivacyWriterScope;
  const service = {
    async assertWorkspaceEpoch(expected: string) {
      events.push(`assert:${expected}`);
      if (expected !== epoch) throw new Error('stale workspace');
    },
    async withWriter<T>(_epoch: string, descriptor: PrivacyWriterDescriptor, work: (lease: PrivacyWriterLease, scope: PrivacyWriterScope) => Promise<T>) {
      events.push(`acquire:${descriptor.kind}:${descriptor.namespace}`);
      try { return await work({ id: 'lease', epoch: _epoch, owner: { platform: 'web', runtimeId: 'runtime' }, kind: descriptor.kind, namespace: descriptor.namespace, createdAt: new Date(0).toISOString() }, scope); }
      finally { events.push('release'); }
    },
    async registerNamespace(_epoch: string, namespace: string) { events.push(`register:${namespace}`); },
  } as unknown as PrivacyService;
  return { service, events, setEpoch(value: string) { epoch = value; } };
}

class ActualControlStore implements PrivacyControlStore {
  state: PrivacyControlState = createEmptyPrivacyControlState('10000000-0000-4000-8000-000000000001');
  holdRelease?: { started: { resolve(): void }; gate: { promise: Promise<void> } };
  failRelease = false;

  async read() { return structuredClone(validatePrivacyControlState(this.state)); }
  async compareAndSwap(expectedRevision: string, next: PrivacyControlState) {
    if (expectedRevision !== this.state.revision) throw Object.assign(new Error('conflict'), { code: 'conflict' });
    const isRelease = next.writerLeases.length < this.state.writerLeases.length;
    if (isRelease && this.failRelease) { this.failRelease = false; throw new Error('lease release failed'); }
    if (isRelease && this.holdRelease) {
      const pending = this.holdRelease;
      this.holdRelease = undefined;
      pending.started.resolve();
      await pending.gate.promise;
    }
    this.state = structuredClone(validatePrivacyControlState(next));
  }
}

async function actualPrivacyRuntime() {
  const { createNativePrivacyArbitration } = await import('../src/privacy/arbitration');
  const owner: PrivacyOwner = {
    platform: 'ios', runtimeId: '10000000-0000-4000-8000-000000000002',
    processLaunchId: '10000000-0000-4000-8000-000000000003', bundleIdentifier: 'com.still.voiceassistant',
  };
  const control = new ActualControlStore();
  const arbitration = createNativePrivacyArbitration({ getRuntimeOwner: async () => owner, waitTimeoutMs: 2_000 });
  const privacy = createPrivacyService({
    controlStore: control,
    arbitration,
    eraseAdapter: { async erase() {}, async verifyGone() { return true; } },
  });
  const workspace = await privacy.openWorkspace();
  return { control, privacy, arbitration, workspace };
}

const session: PrivacyWorkspaceSession = Object.freeze({ epoch: 'epoch-1', runtimeId: 'runtime' });

describe('privacy-bound audio IO', () => {
  it('waits for writer release before rejecting a failed ordinary start', async () => {
    const events: string[] = [];
    const releaseStarted = deferred();
    const release = deferred();
    const scope = Object.freeze({}) as PrivacyWriterScope;
    const service = {
      async assertWorkspaceEpoch() {},
      async withWriter<T>(_epoch: string, _descriptor: PrivacyWriterDescriptor, work: (lease: PrivacyWriterLease, scope: PrivacyWriterScope) => Promise<T>) {
        try {
          return await work({ id: 'lease', epoch: 'epoch-1', owner: { platform: 'web', runtimeId: 'runtime' }, kind: 'audio_capture', namespace: 'browser_audio', createdAt: new Date(0).toISOString() }, scope);
        } finally {
          releaseStarted.resolve();
          await release.promise;
          events.push('released');
        }
      },
      async registerNamespace() {},
      async registerTokenRef() {},
    };
    const boundary = createPrivacyAudioBoundary({ privacy: service as unknown as PrivacyService, session, captureNamespace: 'browser_audio' });
    const capture = boundary.beginCapture(async () => { throw new Error('setup failed'); });
    let readySettled = false;
    const ready = capture.ready.catch((error) => { readySettled = true; throw error; });
    await releaseStarted.promise;
    await Promise.resolve();
    expect(readySettled).toBe(false);
    expect(events).toEqual([]);
    release.resolve();
    await expect(ready).rejects.toThrow('setup failed');
    expect(readySettled).toBe(true);
    expect(events).toEqual(['released']);
  });

  it('reports uncertain start immediately but retains the capture writer for an explicit stop proof', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'browser_audio' });
    const capture = boundary.beginCapture(async () => { throw new CaptureStillActiveError('status uncertain'); });
    await expect(capture.ready).rejects.toBeInstanceOf(CaptureStillActiveError);
    expect(mock.events).not.toContain('release');
    await expect(capture.stop(async () => { mock.events.push('stop:proved'); return 'stopped'; })).resolves.toBe('stopped');
    expect(mock.events).toContain('stop:proved');
    expect(mock.events).toContain('release');
  });

  it('runs stop after a post-start workspace assertion fails, then releases only after quiescence', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'browser_audio' });
    const capture = boundary.beginCapture(async () => { mock.setEpoch('stale-epoch'); });
    await expect(capture.ready).rejects.toBeInstanceOf(CaptureStillActiveError);
    expect(mock.events).not.toContain('release');
    await expect(capture.stop(async () => {
      mock.events.push('stop:actual-recorder');
      mock.setEpoch(session.epoch);
      return 'stopped';
    })).resolves.toBe('stopped');
    expect(mock.events).toContain('stop:actual-recorder');
    expect(mock.events).toContain('release');
  });

  it('passes the live writer scope to start/actions/stop while retaining zero-argument callback compatibility', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'browser_audio' });
    let startScope: PrivacyWriterScope | undefined;
    let actionScope: PrivacyWriterScope | undefined;
    let stopScope: PrivacyWriterScope | undefined;
    const capture = boundary.beginCapture(async (scope) => { startScope = scope; });
    await capture.ready;
    await capture.runAction(async (scope) => { actionScope = scope; });
    await capture.runAction(async () => { mock.events.push('zero-argument-action'); });
    await capture.stop(async (scope) => { stopScope = scope; return 'done'; });
    expect(startScope).toBe(actionScope);
    expect(stopScope).toBe(startScope);
    expect(mock.events).toContain('zero-argument-action');
  });

  it('admits scoped capture child IO behind queued native exclusive work', async () => {
    vi.stubGlobal('__DEV__', true);
    const { privacy, arbitration, workspace, control } = await actualPrivacyRuntime();
    const boundary = createPrivacyAudioBoundary({ privacy, session: workspace, captureNamespace: 'native_recordings' });
    const startWaiting = deferred();
    const allowChild = deferred();
    const childStarted = deferred();
    const childDone = deferred();
    let exclusiveStarted = false;
    const capture = boundary.beginCapture(async (scope) => {
      startWaiting.resolve();
      await allowChild.promise;
      await privacy.withExistingWriter(scope, workspace.epoch, { kind: 'recording_recovery', namespace: 'recovery_audio' }, async () => {
        childStarted.resolve();
        childDone.resolve();
      });
    });
    const parentReadyToContinue = capture.ready;
    // The start callback is waiting under its real native writer lease; queue an
    // exclusive request before allowing its child to register and perform IO.
    await startWaiting.promise;
    const exclusive = arbitration.withCleanupLock(async () => { exclusiveStarted = true; });
    allowChild.resolve();
    await childStarted.promise;
    await childDone.promise;
    await parentReadyToContinue;
    expect(exclusiveStarted).toBe(false);
    expect(control.state.ownedNamespaces).toContain('recovery_audio');
    await capture.stop(async (scope) => {
      await privacy.withExistingWriter(scope, workspace.epoch, { kind: 'recording_recovery', namespace: 'recovery_audio' }, async () => undefined);
      return 'stopped';
    });
    await exclusive;
    expect(exclusiveStarted).toBe(true);
  });

  it('coalesces public stop until the engine has completed lease release', async () => {
    vi.stubGlobal('__DEV__', true);
    const { privacy, workspace, control } = await actualPrivacyRuntime();
    const boundary = createPrivacyAudioBoundary({ privacy, session: workspace, captureNamespace: 'native_recordings' });
    const releaseStarted = deferred();
    const releaseGate = deferred();
    control.holdRelease = { started: releaseStarted, gate: releaseGate };
    const capture = boundary.beginCapture(async () => undefined);
    await capture.ready;
    let stopCalls = 0;
    let settled = false;
    const first = capture.stop(async () => { stopCalls += 1; return 'saved'; });
    const second = capture.stop(async () => { stopCalls += 1; return 'duplicate'; });
    void first.finally(() => { settled = true; });
    await releaseStarted.promise;
    expect(first).toBe(second);
    expect(stopCalls).toBe(1);
    expect(settled).toBe(false);
    expect(control.state.writerLeases).toHaveLength(1);
    releaseGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['saved', 'saved']);
    expect(settled).toBe(true);
    expect(control.state.writerLeases).toEqual([]);
  });

  it('surfaces a terminal lease-release failure instead of reporting a successful stop', async () => {
    vi.stubGlobal('__DEV__', true);
    const { privacy, workspace, control } = await actualPrivacyRuntime();
    const boundary = createPrivacyAudioBoundary({ privacy, session: workspace, captureNamespace: 'native_recordings' });
    const capture = boundary.beginCapture(async () => undefined);
    await capture.ready;
    control.failRelease = true;
    await expect(capture.stop(async () => 'saved')).rejects.toThrow('lease release failed');
    expect(control.state.writerLeases).toHaveLength(1);
    await expect(privacy.reconcileStartupWriters()).resolves.toMatchObject({ phase: 'ready' });
    expect(control.state.writerLeases).toEqual([]);
  });

  it('keeps the capture writer lease until actual stop/reset settles, including queued pause work', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'browser_audio' });
    const started = deferred();
    const releaseStart = deferred();
    const releasePause = deferred();
    const releaseStop = deferred<string>();
    const capture = boundary.beginCapture(async () => { started.resolve(); await releaseStart.promise; });
    await started.promise;
    releaseStart.resolve();
    await capture.ready;
    const pause = capture.runAction(async () => { mock.events.push('pause:start'); await releasePause.promise; mock.events.push('pause:end'); });
    const stopping = capture.stop(async () => { mock.events.push('stop:start'); const value = await releaseStop.promise; mock.events.push('stop:reset:end'); return value; });
    await Promise.resolve();
    expect(mock.events).toContain('acquire:audio_capture:browser_audio');
    expect(mock.events).not.toContain('release');
    releasePause.resolve();
    await pause;
    await Promise.resolve();
    expect(mock.events.indexOf('pause:end')).toBeLessThan(mock.events.indexOf('stop:start'));
    expect(mock.events).not.toContain('release');
    releaseStop.resolve('saved');
    await expect(stopping).resolves.toBe('saved');
    expect(mock.events.at(-1)).toBe('release');
  });

  it('holds one recovery lease across namespace registration and the real picker/copy promise', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'native_recordings' });
    const picked = deferred<string>();
    const operation = boundary.withRecordingPicker(async () => {
      mock.events.push('picker:start');
      const value = await picked.promise;
      mock.events.push('copy:complete');
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.events.slice(0, 3)).toEqual([
      'acquire:recording_recovery:recovery_audio',
      'register:picker_cache',
      'picker:start',
    ]);
    expect(mock.events).not.toContain('release');
    picked.resolve('staged');
    await expect(operation).resolves.toBe('staged');
    expect(mock.events.at(-2)).toBe('assert:epoch-1');
    expect(mock.events.at(-1)).toBe('release');
  });

  it('holds the backup picker lease through reading the selected file bytes', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'native_recordings' });
    const read = deferred<Uint8Array>();
    const operation = boundary.withBackupPicker(async () => {
      mock.events.push('backup:picker-and-read');
      return read.promise;
    });
    await Promise.resolve();
    expect(mock.events).toContain('acquire:picker_cache:picker_cache');
    expect(mock.events).not.toContain('release');
    read.resolve(new Uint8Array([1, 2, 3]));
    await expect(operation).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(mock.events.at(-1)).toBe('release');
  });

  it('rejects results when the opened workspace epoch changes during an IO operation', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'browser_audio' });
    const result = boundary.withAudioRead(async () => {
      mock.setEpoch('epoch-2');
      return 'private bytes';
    });
    await expect(result).rejects.toThrow('stale workspace');
    expect(mock.events.at(-1)).toBe('release');
  });

  it('keeps an uncertain capture lease for a later stop retry', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'native_recordings' });
    const capture = boundary.beginCapture(async () => undefined);
    await capture.ready;
    await expect(capture.stop(async () => { throw new CaptureStillActiveError(); })).rejects.toBeInstanceOf(CaptureStillActiveError);
    expect(mock.events).not.toContain('release');
    await expect(capture.stop(async () => 'stopped')).resolves.toBe('stopped');
    expect(mock.events.at(-1)).toBe('release');
  });

  it('coalesces simultaneous stop taps into one actual stop/reset operation', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'native_recordings' });
    const gate = deferred();
    let calls = 0;
    const capture = boundary.beginCapture(async () => undefined);
    await capture.ready;
    const stopOne = capture.stop(async () => { calls += 1; await gate.promise; return 'stopped'; });
    const stopTwo = capture.stop(async () => { calls += 1; return 'duplicate'; });
    gate.resolve();
    await expect(Promise.all([stopOne, stopTwo])).resolves.toEqual(['stopped', 'stopped']);
    expect(calls).toBe(1);
  });

  it('does not let an action waiting on start run after stop has been requested', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'browser_audio' });
    const started = deferred();
    const finishStart = deferred();
    const order: string[] = [];
    const capture = boundary.beginCapture(async () => { started.resolve(); await finishStart.promise; });
    await started.promise;
    const action = capture.runAction(async () => { order.push('late-action'); });
    const stop = capture.stop(async () => { order.push('stop'); return 'done'; });
    finishStart.resolve();
    await expect(action).rejects.toThrow('already stopping');
    await expect(stop).resolves.toBe('done');
    expect(order).toEqual(['stop']);
  });

  it('rejects ready promptly when writer acquisition fails before raw capture starts', async () => {
    const mock = makePrivacy();
    const failing = {
      ...mock.service,
      async withWriter() { throw new Error('writer unavailable'); },
    } as unknown as PrivacyService;
    const boundary = createPrivacyAudioBoundary({ privacy: failing, session, captureNamespace: 'browser_audio' });
    const rawStart = { called: false };
    const capture = boundary.beginCapture(async () => { rawStart.called = true; });
    await expect(capture.ready).rejects.toThrow('writer unavailable');
    expect(rawStart.called).toBe(false);
    await expect(capture.stop(async () => undefined)).rejects.toThrow('writer unavailable');
  });

  it('wraps picker once and gives later recovery inspection/removal their own leases', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'native_recordings' });
    const calls: string[] = [];
    const inner: RecordingRecoveryService = {
      async pickAndStage() { calls.push('pick'); return { uri: 'file://private', metadata: { fileName: 'clip.wav', format: 'wav', mimeType: 'audio/wav', byteLength: 4, sha256: 'a'.repeat(64), durationStatus: 'unknown' } }; },
      async inspect() { calls.push('inspect'); return { fileName: 'clip.wav', format: 'wav', mimeType: 'audio/wav', byteLength: 4, sha256: 'a'.repeat(64), durationStatus: 'unknown' }; },
      async remove() { calls.push('remove'); },
    };
    const bound = createPrivacyBoundRecordingRecoveryService(inner, boundary);
    const staged = await bound.pickAndStage({ maxDurationSeconds: 600 });
    await bound.inspect(staged!, { maxDurationSeconds: 600 });
    await bound.remove(staged!);
    expect(calls).toEqual(['pick', 'inspect', 'remove']);
    expect(mock.events.filter(event => event.startsWith('acquire:'))).toEqual([
      'acquire:recording_recovery:recovery_audio',
      'acquire:recording_recovery:recovery_audio',
      'acquire:recording_recovery:recovery_audio',
    ]);
    expect(mock.events.filter(event => event === 'register:picker_cache')).toHaveLength(1);
  });

  it('holds speech staging ownership until the native filesystem promise itself settles', async () => {
    const mock = makePrivacy();
    const boundary = createPrivacyAudioBoundary({ privacy: mock.service, session, captureNamespace: 'native_recordings' });
    const copy = deferred<void>();
    const raw: NativeSpeechAudioIO = {
      cacheDirectory: 'private-cache',
      async exists() { return { exists: false }; },
      async makeDirectory() {},
      copy: () => copy.promise,
      async move() {},
      async remove() {},
      async readHeader() { return new Uint8Array([1]); },
      async readBytes() { return new Uint8Array([1]); },
    };
    const owned = createPrivacyBoundNativeSpeechAudioIO(raw, boundary);
    const actualCopy = owned.copy('source', 'stage');
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.events).toContain('acquire:speech_upload:speech_staging');
    expect(mock.events).not.toContain('release');
    copy.resolve();
    await actualCopy;
    expect(mock.events.at(-1)).toBe('release');
  });
});
