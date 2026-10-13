import { describe, expect, it } from 'vitest';
import { NativeCaptureLifecycle, type NativeCaptureFacts, type NativeCaptureIO } from '../src/audio/nativeCaptureLifecycle';
import { createPrivacyAudioBoundary } from '../src/privacy/audioBoundary';
import { stopNativeRecorderWithProof } from '../src/audio/nativeStopProof';

class FakeRecorder implements NativeCaptureIO {
  enabled = false;
  prepared = false;
  recording = false;
  autoResumeOnForeground = true;
  failDisable = false;
  ignoreRecord = false;
  keepActiveOnDisable = false;
  recoveryRequired = false;
  malformedFacts?: NativeCaptureFacts;

  record() {
    if (this.enabled && !this.ignoreRecord) { this.prepared = true; this.recording = true; }
  }
  pause() { this.recording = false; this.prepared = true; }
  async setRecordingEnabled(enabled: boolean) {
    if (!enabled && this.failDisable) throw new Error('audio mode failed');
    this.enabled = enabled;
    if (!enabled && !this.keepActiveOnDisable) this.recording = false;
  }
  readFacts(): NativeCaptureFacts {
    return this.malformedFacts ?? {
      isRecording: this.recording,
      statusRecording: this.recording,
      canRecord: this.prepared,
      recoveryRequired: this.recoveryRequired,
    };
  }
  foreground() {
    if (this.enabled && this.prepared && this.autoResumeOnForeground) this.recording = true;
  }
}

describe('native capture lifecycle', () => {
  it('starts only after fresh native facts confirm recording', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    const outcome = await lifecycle.start();
    expect(outcome.state).toBe('recording');
    expect(outcome.canResume).toBe(false);
    expect(sdk.enabled).toBe(true);
  });

  it('secures a manual pause against foreground auto-resume', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    const outcome = await lifecycle.pause();
    expect(outcome).toMatchObject({ state: 'paused', canResume: true });
    expect(sdk.enabled).toBe(false);
    sdk.foreground();
    expect(sdk.recording).toBe(false);
    expect((await lifecycle.reconcile())?.state).toBe('paused');
  });

  it('uses fresh native facts rather than a stale cached inactive sample', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    // The caller may still hold an old false sample; reconciliation reads the SDK directly.
    sdk.recording = true;
    expect((await lifecycle.reconcile())?.state).toBe('recording');
    expect(sdk.enabled).toBe(true);
  });

  it('turns an interrupted recording into a secured pause without auto-starting it', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    sdk.recording = false;
    const outcome = await lifecycle.reconcile();
    expect(outcome).toMatchObject({ state: 'paused', canResume: true });
    expect(sdk.enabled).toBe(false);
    expect(sdk.recording).toBe(false);
  });

  it('reports terminal native reset as recovery with Resume disabled', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    sdk.recording = false;
    sdk.prepared = false;
    const outcome = await lifecycle.reconcile();
    expect(outcome).toMatchObject({ state: 'recovery', canResume: false });
  });

  it('treats a reset or replacement URI marker as recovery even when status flags are false', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    sdk.recording = false;
    sdk.malformedFacts = { isRecording: false, statusRecording: false, canRecord: true, recoveryRequired: true };
    const outcome = await lifecycle.reconcile();
    expect(outcome).toMatchObject({ state: 'recovery', canResume: false });
    expect(sdk.enabled).toBe(false);
  });

  it('disables and proves quiescence when recovery is marked while native flags remain active', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    sdk.recoveryRequired = true;
    expect(await lifecycle.reconcile()).toMatchObject({ state: 'recovery', canResume: false });
    expect(sdk.enabled).toBe(false);
    expect(sdk.recording).toBe(false);
  });

  it('does not classify an active replacement source as ordinary recording', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    sdk.failDisable = true;
    sdk.malformedFacts = { isRecording: true, statusRecording: true, canRecord: true, recoveryRequired: true };
    expect(await lifecycle.reconcile()).toMatchObject({ state: 'uncertain', canResume: false });
  });

  it('does not accept a successful mode-disable call if recovery facts remain active', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    sdk.keepActiveOnDisable = true;
    sdk.recoveryRequired = true;
    expect(await lifecycle.reconcile()).toMatchObject({ state: 'uncertain', canResume: false });
    expect(sdk.enabled).toBe(false);
    expect(sdk.recording).toBe(true);
  });

  it('keeps an uncertain recording state when mode disable fails despite false recorder flags', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    sdk.recording = false;
    sdk.failDisable = true;
    const outcome = await lifecycle.pause();
    expect(outcome).toMatchObject({ state: 'uncertain', canResume: false });
  });

  it('does not claim a stable pause when native flags conflict or are malformed', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    sdk.recording = false;
    sdk.malformedFacts = { isRecording: true, statusRecording: false, canRecord: true };
    const outcome = await lifecycle.pause();
    expect(outcome).toMatchObject({ state: 'uncertain', canResume: false });
  });

  it('disables mode after a failed resume and leaves the confirmed pause retryable', async () => {
    const sdk = new FakeRecorder();
    const lifecycle = new NativeCaptureLifecycle(sdk);
    await lifecycle.start();
    await lifecycle.pause();
    sdk.ignoreRecord = true;
    const outcome = await lifecycle.resume();
    expect(outcome).toMatchObject({ state: 'paused', canResume: true });
    expect(sdk.enabled).toBe(false);
    expect(outcome.message).toBeTruthy();
  });

  it('fences a start completion after stop closes the generation', async () => {
    const sdk = new FakeRecorder();
    let release!: () => void;
    const original = sdk.setRecordingEnabled.bind(sdk);
    sdk.setRecordingEnabled = async (enabled) => {
      if (enabled) await new Promise<void>((resolve) => { release = resolve; });
      await original(enabled);
    };
    const lifecycle = new NativeCaptureLifecycle(sdk);
    const start = lifecycle.start();
    lifecycle.close();
    release();
    const outcome = await start;
    expect(outcome.state).toBe('uncertain');
    expect(lifecycle.isCurrent(outcome.generation)).toBe(false);
  });

  it('fails closed before the native adapter has been configured', async () => {
    const lifecycle = new NativeCaptureLifecycle();
    expect(await lifecycle.start()).toMatchObject({ state: 'uncertain', canResume: false });
  });

  it('keeps the capture writer lease until a stop proves quiescence after deferred mode enable', async () => {
    let releaseEnable!: () => void;
    let modeCalled!: () => void;
    let leaseReleased!: () => void;
    const enableGate = new Promise<void>((resolve) => { releaseEnable = resolve; });
    const modeStarted = new Promise<void>((resolve) => { modeCalled = resolve; });
    const released = new Promise<void>((resolve) => { leaseReleased = resolve; });
    const events: string[] = [];
    let enabled = false;
    let recording = false;
    let prepared = true;
    const privacy = {
      assertWorkspaceEpoch: async () => undefined,
      withWriter: async (_epoch: string, _descriptor: unknown, work: (lease: unknown) => Promise<unknown>) => {
        events.push('lease:acquired');
        try { return await work({}); }
        finally { events.push('lease:released'); leaseReleased(); }
      },
    };
    const boundary = createPrivacyAudioBoundary({
      privacy: privacy as never,
      session: { epoch: 'epoch', runtimeId: 'runtime' },
      captureNamespace: 'native_recordings',
    });
    const lifecycle = new NativeCaptureLifecycle({
      record: () => { events.push('record'); recording = enabled; },
      pause: () => { recording = false; },
      setRecordingEnabled: async (next) => {
        if (next) { events.push('mode:enable-start'); modeCalled(); await enableGate; }
        enabled = next;
        if (!next) { events.push('mode:disable'); recording = false; }
      },
      readFacts: () => ({ isRecording: recording, statusRecording: recording, canRecord: prepared }),
    });
    const capture = boundary.beginCapture(async () => { await lifecycle.start(); });
    await modeStarted;
    lifecycle.close();
    const stopping = capture.stop(async () => {
      events.push('stop:start');
      await stopNativeRecorderWithProof({
        stop: async () => { events.push('native:stop'); },
        disableRecording: async () => {
          events.push('mode:disable'); enabled = false; recording = false;
        },
        readRecordingFlag: () => recording,
        readStatus: () => { expect(prepared).toBe(true); return { isRecording: recording, canRecord: prepared }; },
        wasPaused: false,
        message: 'stop did not prove quiescence',
      });
      events.push('quiescence:proven');
    });
    releaseEnable();
    await capture.ready;
    await stopping;
    await released;
    expect(events).toContain('mode:disable');
    expect(enabled).toBe(false);
    expect(recording).toBe(false);
    expect(events.indexOf('mode:disable')).toBeLessThan(events.indexOf('quiescence:proven'));
    expect(events.indexOf('quiescence:proven')).toBeGreaterThan(events.indexOf('lease:acquired'));
    expect(events.indexOf('lease:released')).toBeGreaterThan(events.indexOf('quiescence:proven'));
    expect(events).not.toContain('record');
  });
});
