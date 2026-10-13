import { describe, expect, it } from 'vitest';
import { NativeCaptureIdentity } from '../src/audio/nativeCaptureIdentity';
import { NativeCaptureLifecycle } from '../src/audio/nativeCaptureLifecycle';

const anchor = { capturedAt: '2026-10-13T04:00:00.000Z', captureTimeZone: 'Asia/Singapore' };

describe('native capture identity', () => {
  it('keeps the first source and anchor across a real resume and records reset with unchanged URI', async () => {
    const identity = new NativeCaptureIdentity();
    identity.begin('file:///recording.m4a', anchor);
    identity.observeDuration('file:///recording.m4a', 4.125);
    let enabled = false;
    let recording = false;
    const lifecycle = new NativeCaptureLifecycle({
      record: () => { recording = enabled; },
      pause: () => { recording = false; },
      setRecordingEnabled: async (next) => { enabled = next; if (!next) recording = false; },
      readFacts: () => ({ isRecording: recording, statusRecording: recording, canRecord: true }),
    });
    await lifecycle.start();
    await lifecycle.pause();
    expect((await lifecycle.resume()).state).toBe('recording');
    identity.observeDuration('file:///recording.m4a', 5.25);
    expect(identity.snapshot().anchor).toEqual(anchor);
    expect(identity.snapshot().originalUri).toBe('file:///recording.m4a');
    identity.observe('file:///recording.m4a', true);
    const snapshot = identity.snapshot();
    expect(snapshot).toMatchObject({
      originalUri: 'file:///recording.m4a',
      anchor,
      originalDurationSeconds: 5.25,
      resetObserved: true,
      recoveryRequired: true,
    });
    identity.begin('file:///next.m4a', { ...anchor, capturedAt: '2026-10-13T05:00:00.000Z' });
    expect(identity.snapshot().anchor?.capturedAt).toBe('2026-10-13T05:00:00.000Z');
  });

  it('rejects missing and replaced URIs and never mixes replacement duration into the original', () => {
    const identity = new NativeCaptureIdentity();
    identity.begin('file:///original.m4a', anchor);
    identity.observeDuration('file:///original.m4a', 7.5);
    identity.observe('file:///replacement.m4a');
    identity.observeDuration('file:///replacement.m4a', 99);
    identity.observe(undefined);
    expect(identity.snapshot()).toMatchObject({
      originalUri: 'file:///original.m4a',
      originalDurationSeconds: 7.5,
      recoveryRequired: true,
      replacementUris: ['file:///replacement.m4a'],
    });
    expect(identity.snapshot().anchor).toEqual(anchor);
  });

  it('bounds known replacement URIs without forgetting the original', () => {
    const identity = new NativeCaptureIdentity();
    identity.begin('file:///original.m4a', anchor);
    for (let index = 0; index < 16; index += 1) identity.observe(`file:///replacement-${index}.m4a`);
    identity.observe('file:///replacement-15.m4a');
    expect(identity.snapshot().replacementOverflow).toBe(false);
    identity.observe('file:///replacement-16.m4a');
    expect(identity.snapshot().originalUri).toBe('file:///original.m4a');
    expect(identity.snapshot().replacementUris).toHaveLength(16);
    expect(identity.snapshot().replacementOverflow).toBe(true);
  });

  it('does not fabricate an anchor or source for a failed prepare', () => {
    const identity = new NativeCaptureIdentity();
    expect(identity.observe(undefined).anchor).toBeNull();
    expect(identity.snapshot()).toMatchObject({ originalUri: null, recoveryRequired: false });
  });
});
