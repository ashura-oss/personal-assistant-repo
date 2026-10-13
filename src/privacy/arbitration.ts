import { getPrivacyRuntimeOwner, isCanonicalUuid } from './runtime';
import { isSupportedPrivacyBundleIdentifier } from './bundleIdentity';
import type { PrivacyOwner, PrivacyWriterArbitration } from './types';

const MAX_QUEUED = 128;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export type PrivacyArbitrationErrorCode = 'unsupported_runtime' | 'queue_full' | 'wait_timeout';

export class PrivacyArbitrationError extends Error {
  constructor(readonly code: PrivacyArbitrationErrorCode) {
    const message = code === 'unsupported_runtime'
      ? 'Privacy cleanup is unavailable in this runtime.'
      : code === 'queue_full'
        ? 'Privacy work is busy. Wait and try again.'
        : 'Privacy work did not start before the wait limit.';
    super(message);
    this.name = 'PrivacyArbitrationError';
  }
}

type QueueMode = 'shared' | 'exclusive';
interface Waiter {
  mode: QueueMode;
  work: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  granted: boolean;
}

export interface NativePrivacyArbitrationOptions {
  getRuntimeOwner?: () => Promise<PrivacyOwner>;
  waitTimeoutMs?: number;
}

export function isSupportedNativePrivacyOwner(owner: PrivacyOwner): boolean {
  return owner.platform === 'ios' &&
    isCanonicalUuid(owner.runtimeId) &&
    isCanonicalUuid(owner.processLaunchId) &&
    isSupportedPrivacyBundleIdentifier(owner.bundleIdentifier);
}

export function createNativePrivacyArbitration(
  options: NativePrivacyArbitrationOptions = {},
): PrivacyWriterArbitration {
  const ownerReader = options.getRuntimeOwner ?? getPrivacyRuntimeOwner;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const queue: Waiter[] = [];
  let activeWriters = 0;
  let activeCleanup = false;

  const pump = () => {
    if (activeCleanup || queue.length === 0) return;
    const first = queue[0];
    if (first.mode === 'exclusive') {
      if (activeWriters !== 0) return;
      queue.shift();
      grant(first);
      return;
    }
    while (queue.length > 0 && queue[0].mode === 'shared' && !activeCleanup) {
      const waiter = queue.shift();
      if (waiter) grant(waiter);
    }
  };

  const grant = (waiter: Waiter) => {
    waiter.granted = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.mode === 'exclusive') activeCleanup = true;
    else activeWriters += 1;
    void (async () => {
      try {
        waiter.resolve(await waiter.work());
      } catch (error) {
        waiter.reject(error);
      } finally {
        if (waiter.mode === 'exclusive') activeCleanup = false;
        else activeWriters -= 1;
        pump();
      }
    })();
  };

  const enqueue = <T>(mode: QueueMode, work: () => Promise<T>): Promise<T> => {
    if (queue.length >= MAX_QUEUED) return Promise.reject(new PrivacyArbitrationError('queue_full'));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        mode,
        work,
        resolve: (value) => resolve(value as T),
        reject,
        granted: false,
      };
      waiter.timer = setTimeout(() => {
        if (waiter.granted) return;
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        waiter.reject(new PrivacyArbitrationError('wait_timeout'));
        pump();
      }, waitTimeoutMs);
      queue.push(waiter);
      pump();
    });
  };

  return {
    getRuntimeOwner: ownerReader,
    withWriterLock: <T>(work: () => Promise<T>) => enqueue('shared', work),
    withCleanupLock: <T>(work: () => Promise<T>) => enqueue('exclusive', async () => {
      const owner = await ownerReader();
      if (!isSupportedNativePrivacyOwner(owner)) {
        throw new PrivacyArbitrationError('unsupported_runtime');
      }
      return work();
    }),
  };
}
