import { describe, expect, it, vi } from 'vitest';
import { createWebPrivacyArbitration, PRIVACY_WEB_LOCK_NAME, WebPrivacyArbitrationError } from '../src/privacy/arbitration.web';

interface FakeLockWaiter {
  mode: 'shared' | 'exclusive';
  signal: AbortSignal;
  callback: (lock: { name: string } | null) => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  abort?: () => void;
}

class FakeWebLocks {
  readonly waiters: FakeLockWaiter[] = [];
  private readers = 0;
  private writer = false;

  request<T>(name: string, options: { mode: 'shared' | 'exclusive'; signal: AbortSignal }, callback: (lock: { name: string } | null) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: FakeLockWaiter = {
        mode: options.mode,
        signal: options.signal,
        callback: callback as (lock: { name: string } | null) => Promise<unknown>,
        resolve: (value) => resolve(value as T),
        reject,
      };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
          this.pump();
        }
      };
      options.signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.pump(name);
    });
  }

  private pump(name = PRIVACY_WEB_LOCK_NAME) {
    if (this.writer || this.waiters.length === 0) return;
    const first = this.waiters[0];
    if (first.mode === 'exclusive') {
      if (this.readers > 0) return;
      this.waiters.shift();
      this.writer = true;
      this.run(first, name);
      return;
    }
    while (this.waiters[0]?.mode === 'shared' && !this.writer) {
      const next = this.waiters.shift();
      if (next) {
        this.readers += 1;
        this.run(next, name);
      }
    }
  }

  private run(waiter: FakeLockWaiter, name: string) {
    if (waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
    void waiter.callback({ name }).then(waiter.resolve, waiter.reject).finally(() => {
      if (waiter.mode === 'exclusive') this.writer = false;
      else this.readers -= 1;
      this.pump(name);
    });
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

describe('web privacy arbitration', () => {
  it('uses the fixed Web Lock name and holds shared/exclusive callbacks to settlement', async () => {
    const locks = new FakeWebLocks();
    const scope = { isSecureContext: true, navigator: { locks } } as unknown as typeof globalThis;
    const arb = createWebPrivacyArbitration({ scope, waitTimeoutMs: 100 });
    const writerGate = deferred();
    let cleanupEntered = false;
    const writer = arb.withWriterLock(() => writerGate.promise);
    const cleanup = arb.withCleanupLock(async () => { cleanupEntered = true; });
    await tick();
    expect(cleanupEntered).toBe(false);
    expect(locks.waiters).toHaveLength(1);
    expect(locks.waiters[0].mode).toBe('exclusive');
    expect(locks.waiters[0].signal.aborted).toBe(false);
    writerGate.resolve();
    await Promise.all([writer, cleanup]);
    expect(cleanupEntered).toBe(true);
    expect(PRIVACY_WEB_LOCK_NAME).toBe('still-privacy-workspace-v1');
  });

  it('aborts only an ungranted request; it never times out held work', async () => {
    const locks = new FakeWebLocks();
    const scope = { isSecureContext: true, navigator: { locks } } as unknown as typeof globalThis;
    const arb = createWebPrivacyArbitration({ scope, waitTimeoutMs: 15 });
    const gate = deferred();
    let heldWorkFinished = false;
    const heldWriter = arb.withWriterLock(async () => { await gate.promise; heldWorkFinished = true; });
    await tick();

    const pendingCleanup = arb.withCleanupLock(async () => undefined);
    await expect(pendingCleanup).rejects.toMatchObject<Partial<WebPrivacyArbitrationError>>({ code: 'wait_timeout' });
    expect(heldWorkFinished).toBe(false);
    expect(locks.waiters).toHaveLength(0);
    gate.resolve();
    await heldWriter;
    expect(heldWorkFinished).toBe(true);
  });

  it('rejects when secure context or Web Locks are unavailable before work runs', async () => {
    const noLockScope = { isSecureContext: true, navigator: {} } as unknown as typeof globalThis;
    const arb = createWebPrivacyArbitration({ scope: noLockScope });
    const work = vi.fn(async () => undefined);
    await expect(arb.withCleanupLock(work)).rejects.toMatchObject({ code: 'unsupported_runtime' });
    expect(work).not.toHaveBeenCalled();
  });
});
