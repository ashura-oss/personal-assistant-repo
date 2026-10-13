import { describe, expect, it } from 'vitest';
import { CaptureStillActiveError, createPrivacyAudioBoundary, createPrivacyBoundNativeSpeechAudioIO, createPrivacyBoundRecordingRecoveryService } from '../src/privacy/audioBoundary';
import type { PrivacyService, PrivacyWorkspaceSession } from '../src/privacy/service';
import type { PrivacyWriterDescriptor, PrivacyWriterLease } from '../src/privacy/types';
import type { RecordingRecoveryService } from '../src/audio/recovery.types';
import type { NativeSpeechAudioIO } from '../src/audio/speechUpload.types';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makePrivacy() {
  const events: string[] = [];
  let epoch = 'epoch-1';
  const service = {
    async assertWorkspaceEpoch(expected: string) {
      events.push(`assert:${expected}`);
      if (expected !== epoch) throw new Error('stale workspace');
    },
    async withWriter<T>(_epoch: string, descriptor: PrivacyWriterDescriptor, work: (lease: PrivacyWriterLease) => Promise<T>) {
      events.push(`acquire:${descriptor.kind}:${descriptor.namespace}`);
      try { return await work({ id: 'lease', epoch: _epoch, owner: { platform: 'web', runtimeId: 'runtime' }, kind: descriptor.kind, namespace: descriptor.namespace, createdAt: new Date(0).toISOString() }); }
      finally { events.push('release'); }
    },
    async registerNamespace(_epoch: string, namespace: string) { events.push(`register:${namespace}`); },
  } as unknown as PrivacyService;
  return { service, events, setEpoch(value: string) { epoch = value; } };
}

const session: PrivacyWorkspaceSession = Object.freeze({ epoch: 'epoch-1', runtimeId: 'runtime' });

describe('privacy-bound audio IO', () => {
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
