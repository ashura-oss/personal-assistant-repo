import { describe, expect, it, vi } from 'vitest';
import { CaptureStillActiveError } from '../src/privacy/audioBoundary';
import { stopNativeRecorderWithProof, type NativeRecorderStatus } from '../src/audio/nativeStopProof';

const inactive = (): NativeRecorderStatus => ({ isRecording: false, canRecord: false });

describe('native recorder stop proof', () => {
  it('keeps the capture lease when a failed stop cannot read recorder status', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('native stop failed'));
    const readRecordingFlag = vi.fn(() => { throw new Error('recorder released'); });
    await expect(stopNativeRecorderWithProof({
      stop,
      disableRecording: async () => undefined,
      readRecordingFlag,
      readStatus: inactive,
      wasPaused: false,
      message: 'Retry stop before leaving.',
    })).rejects.toBeInstanceOf(CaptureStillActiveError);
    expect(stop).toHaveBeenCalledOnce();
    expect(readRecordingFlag).toHaveBeenCalledTimes(2);
  });

  it('does not accept a paused failed stop without first disabling recording mode', async () => {
    const disableRecording = vi.fn(async () => undefined);
    await expect(stopNativeRecorderWithProof({
      stop: async () => { throw new Error('permission failure'); },
      disableRecording,
      readRecordingFlag: () => false,
      readStatus: inactive,
      wasPaused: true,
      message: 'Retry stop before leaving.',
    })).resolves.toBeInstanceOf(Error);
    expect(disableRecording).toHaveBeenCalledOnce();
  });

  it('accepts explicit terminal status after a stop error without needing fallback', async () => {
    const stopError = new Error('stop rejected after termination');
    const disableRecording = vi.fn(async () => undefined);
    await expect(stopNativeRecorderWithProof({
      stop: async () => { throw stopError; },
      disableRecording,
      readRecordingFlag: () => false,
      readStatus: inactive,
      wasPaused: false,
      message: 'Retry stop before leaving.',
    })).resolves.toBe(stopError);
    expect(disableRecording).not.toHaveBeenCalled();
  });

  it('accepts a normally resolved stop only after explicit terminal proof', async () => {
    const disableRecording = vi.fn(async () => undefined);
    await expect(stopNativeRecorderWithProof({
      stop: async () => undefined,
      disableRecording,
      readRecordingFlag: () => false,
      readStatus: inactive,
      wasPaused: false,
      message: 'Retry stop before leaving.',
    })).resolves.toBeUndefined();
    expect(disableRecording).not.toHaveBeenCalled();
  });

  it('falls back from a prepared no-op stop to mode disable and fresh inactive proof', async () => {
    const statuses = [
      { isRecording: false, canRecord: true },
      { isRecording: false, canRecord: true },
    ];
    const readStatus = vi.fn(() => statuses.shift() as NativeRecorderStatus);
    const disableRecording = vi.fn(async () => undefined);
    await expect(stopNativeRecorderWithProof({
      stop: async () => undefined,
      disableRecording,
      readRecordingFlag: () => false,
      readStatus,
      wasPaused: false,
      message: 'Retry stop before leaving.',
    })).resolves.toBeUndefined();
    expect(disableRecording).toHaveBeenCalledOnce();
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it('holds the helper and capture lease while recording-mode disable is pending', async () => {
    let release!: () => void;
    const disable = new Promise<void>((resolve) => { release = resolve; });
    let done = false;
    const task = stopNativeRecorderWithProof({
      stop: async () => undefined,
      disableRecording: () => disable,
      readRecordingFlag: () => false,
      readStatus: () => ({ isRecording: false, canRecord: true }),
      wasPaused: false,
      message: 'Retry stop before leaving.',
    }).then(() => { done = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await task;
    expect(done).toBe(true);
  });

  it('retains the lease if disable fails or a fresh read still reports active', async () => {
    await expect(stopNativeRecorderWithProof({
      stop: async () => undefined,
      disableRecording: async () => { throw new Error('mode change failed'); },
      readRecordingFlag: () => false,
      readStatus: () => ({ isRecording: false, canRecord: true }),
      wasPaused: false,
      message: 'Retry stop before leaving.',
    })).rejects.toBeInstanceOf(CaptureStillActiveError);

    const flags = [false, true];
    const statuses: NativeRecorderStatus[] = [
      { isRecording: false, canRecord: true },
      { isRecording: false, canRecord: false },
    ];
    await expect(stopNativeRecorderWithProof({
      stop: async () => undefined,
      disableRecording: async () => undefined,
      readRecordingFlag: () => flags.shift() ?? true,
      readStatus: () => statuses.shift() ?? inactive(),
      wasPaused: false,
      message: 'Retry stop before leaving.',
    })).rejects.toBeInstanceOf(CaptureStillActiveError);
  });

  it('fails closed when canRecord is missing from the fresh post-disable status', async () => {
    const statuses: unknown[] = [
      { isRecording: false, canRecord: true },
      { isRecording: false },
    ];
    await expect(stopNativeRecorderWithProof({
      stop: async () => undefined,
      disableRecording: async () => undefined,
      readRecordingFlag: () => false,
      readStatus: () => statuses.shift() as NativeRecorderStatus,
      wasPaused: false,
      message: 'Retry stop before leaving.',
    })).rejects.toBeInstanceOf(CaptureStillActiveError);
  });
});
