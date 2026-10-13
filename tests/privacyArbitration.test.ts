import { describe, expect, it, vi } from 'vitest';
import { createNativePrivacyArbitration, isSupportedNativePrivacyOwner, PrivacyArbitrationError } from '../src/privacy/arbitration';
import type { PrivacyOwner } from '../src/privacy/types';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));

const owner: PrivacyOwner = {
  platform: 'ios',
  runtimeId: 'caa27bbc-5a14-4b73-a8fa-90c6a90207c4',
  processLaunchId: '6b7b5f77-1b6a-4b94-aeb7-7d76a2098131',
  bundleIdentifier: 'com.still.voiceassistant',
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

describe('native privacy arbitration', () => {
  it('supports only the exact base or ten-character team-suffixed iOS bundle identity', () => {
    expect(isSupportedNativePrivacyOwner(owner)).toBe(true);
    expect(isSupportedNativePrivacyOwner({ ...owner, bundleIdentifier: 'com.still.voiceassistant.A1B2C3D4E5' })).toBe(true);
    for (const bundleIdentifier of [
      'com.still.voiceassistant.a1b2c3d4e5',
      'com.still.voiceassistant.A1B2C3D4E',
      'com.still.voiceassistant.A1B2C3D4E5X',
      'com.still.voiceassistant.A1B2C3D4E5\n',
      'com.still.voiceassistant.extra.A1B2C3D4E5',
      'com.other.voiceassistant.A1B2C3D4E5',
    ]) {
      expect(isSupportedNativePrivacyOwner({ ...owner, bundleIdentifier })).toBe(false);
    }
  });

  it('waits for writers, gives queued cleanup priority, then admits later writers', async () => {
    const arb = createNativePrivacyArbitration({ getRuntimeOwner: async () => owner, waitTimeoutMs: 500 });
    const firstGate = deferred();
    const cleanupGate = deferred();
    const started: string[] = [];
    const first = arb.withWriterLock(async () => { started.push('writer-1'); await firstGate.promise; });
    const cleanup = arb.withCleanupLock(async () => { started.push('cleanup'); await cleanupGate.promise; });
    const second = arb.withWriterLock(async () => { started.push('writer-2'); });

    await tick();
    expect(started).toEqual(['writer-1']);
    firstGate.resolve();
    await tick();
    expect(started).toEqual(['writer-1', 'cleanup']);
    cleanupGate.resolve();
    await Promise.all([first, cleanup, second]);
    expect(started).toEqual(['writer-1', 'cleanup', 'writer-2']);
  });

  it('times out only the waiting cleanup and leaves held writer work alive', async () => {
    const arb = createNativePrivacyArbitration({ getRuntimeOwner: async () => owner, waitTimeoutMs: 15 });
    const writerGate = deferred();
    let writerFinished = false;
    const writer = arb.withWriterLock(async () => { await writerGate.promise; writerFinished = true; });
    await tick();
    await expect(arb.withCleanupLock(async () => 'should not run')).rejects.toMatchObject<Partial<PrivacyArbitrationError>>({ code: 'wait_timeout' });
    expect(writerFinished).toBe(false);
    writerGate.resolve();
    await writer;
    expect(writerFinished).toBe(true);
  });

  it('runs queued work so the engine can perform its epoch check', async () => {
    const arb = createNativePrivacyArbitration({ getRuntimeOwner: async () => owner, waitTimeoutMs: 500 });
    const cleanupGate = deferred();
    const cleanup = arb.withCleanupLock(() => cleanupGate.promise);
    let epochCheckRan = false;
    const staleWriter = arb.withWriterLock(async () => {
      epochCheckRan = true;
      throw new Error('stale epoch');
    });
    const staleExpectation = expect(staleWriter).rejects.toThrow('stale epoch');
    await tick();
    cleanupGate.resolve();
    await cleanup;
    await staleExpectation;
    expect(epochCheckRan).toBe(true);
  });

  it('bounds the native wait queue at 128 entries', async () => {
    const arb = createNativePrivacyArbitration({ getRuntimeOwner: async () => owner, waitTimeoutMs: 2_000 });
    const gate = deferred();
    const heldCleanup = arb.withCleanupLock(() => gate.promise);
    await tick();
    const queued = Array.from({ length: 128 }, () => arb.withWriterLock(async () => undefined));
    await expect(arb.withWriterLock(async () => undefined)).rejects.toMatchObject({ code: 'queue_full' });
    gate.resolve();
    await Promise.all([heldCleanup, ...queued]);
  });

  it('rejects cleanup for unsupported owners without invoking deletion work', async () => {
    const arb = createNativePrivacyArbitration({
      getRuntimeOwner: async () => ({ platform: 'unsupported', runtimeId: owner.runtimeId }),
    });
    const work = vi.fn(async () => undefined);
    await expect(arb.withCleanupLock(work)).rejects.toBeInstanceOf(PrivacyArbitrationError);
    expect(work).not.toHaveBeenCalled();
  });
});
