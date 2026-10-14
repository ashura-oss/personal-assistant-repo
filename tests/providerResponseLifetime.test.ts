import { describe, expect, it, vi } from 'vitest';
import {
  createProviderCleanupRegistry,
  createTrackedProviderResponseLifetime,
  type ProviderResponseLifetime,
} from '../src/services/providerResponseLifetime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('tracked provider response lifetime', () => {
  it('isolates throwing observers and domain notifications while retaining the exact pending cancellation', async () => {
    const registry = createProviderCleanupRegistry();
    const pending = deferred<void>();
    const retryAck = deferred<void>();
    const raw: ProviderResponseLifetime = async (_input, _init, _consume, onCancelPending) => {
      onCancelPending?.(() => retryAck.promise);
      await pending.promise;
      return 'settled' as never;
    };
    const unsubscribe = registry.subscribe(() => { throw new Error('listener failure'); });
    const domainCallback = vi.fn(() => { throw new Error('domain callback failure'); });
    const tracked = createTrackedProviderResponseLifetime(raw, 'connector', registry);
    const operation = tracked('https://example.test', {}, async () => undefined, domainCallback);
    expect(registry.getPending()).toHaveLength(1);
    expect(domainCallback).toHaveBeenCalledTimes(1);

    // The registered handle uses the same exact active registry ticket.
    const state = registry.getPending();
    const retry = registry.retryCancellation(state[0].id);
    const duplicate = registry.retryCancellation(state[0].id);
    expect(duplicate).toBe(retry);
    retryAck.resolve();
    await retry;
    pending.resolve();
    await operation;
    expect(registry.getPending()).toEqual([]);
    unsubscribe();
  });

  it('does not call a stale retry if the lifetime settles before its queued retry starts', async () => {
    const registry = createProviderCleanupRegistry();
    const retryRaw = vi.fn(async () => undefined);
    const raw: ProviderResponseLifetime = async (_input, _init, _consume, onCancelPending) => {
      onCancelPending?.(retryRaw);
      return undefined as never;
    };
    const tracked = createTrackedProviderResponseLifetime(raw, 'azure_speech', registry);
    const operation = tracked('https://example.test', {}, async () => undefined);
    const [item] = registry.getPending();
    const retry = registry.retryCancellation(item.id);
    await operation;
    await expect(retry).rejects.toThrow('no longer pending');
    expect(retryRaw).not.toHaveBeenCalled();
    expect(registry.getPending()).toEqual([]);
  });

  it('invalidates the domain cancellation handle when that exact response lifetime settles', async () => {
    const registry = createProviderCleanupRegistry();
    let domainRetry: (() => Promise<void>) | undefined;
    const retryRaw = vi.fn(async () => undefined);
    const raw: ProviderResponseLifetime = async (_input, _init, _consume, onCancelPending) => {
      onCancelPending?.(retryRaw);
      return undefined as never;
    };
    const tracked = createTrackedProviderResponseLifetime(raw, 'openrouter_batch', registry);
    await tracked('https://example.test', {}, async () => undefined, (retry) => { domainRetry = retry; });
    expect(registry.getPending()).toEqual([]);
    await expect(domainRetry?.()).rejects.toThrow('no longer pending');
    expect(retryRaw).not.toHaveBeenCalled();
  });
});
