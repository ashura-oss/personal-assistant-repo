import { describe, expect, it, vi } from 'vitest';
import { createMailAlertTapCoordinator, type MailAlertTapBackend, type MailAlertTapKey } from '../src/proactiveMailAlerts/taps';
import { createMailAlertTapBackend, projectDefaultMailAlertTap } from '../src/services/mailAlertTapBackend';
import { proactiveMailAlertNotificationContent } from '../src/services/mailAlertNotificationBackend';

const installationId = '41000000-0000-4000-8000-000000000001';
const receiptId = '41000000-0000-4000-8000-000000000002';
const newerReceiptId = '41000000-0000-4000-8000-000000000003';

function response(id = receiptId, actionIdentifier = 'expo.modules.notifications.actions.DEFAULT') {
  const content = proactiveMailAlertNotificationContent({ installationId, receiptId: id });
  return { actionIdentifier, notification: { request: { identifier: content.identifier, content: {
    title: content.title, body: content.body, data: content.data,
    sound: null, interruptionLevel: content.interruptionLevel,
  } } } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('mail alert notification taps', () => {
  it('projects only the default action and exact private notification into opaque IDs', () => {
    expect(projectDefaultMailAlertTap(response(), installationId)).toEqual({ installationId, receiptId });
    expect(projectDefaultMailAlertTap(response(receiptId, 'snooze'), installationId)).toBeUndefined();
    const changed = response() as { notification: { request: { content: { data: Record<string, unknown> } } } };
    changed.notification.request.content.data.unexpected = 'private body';
    expect(projectDefaultMailAlertTap(changed, installationId)).toBeUndefined();
  });

  it('keeps the latest live tap when cached-response lookup resolves later', async () => {
    const cached = deferred<MailAlertTapKey | undefined>();
    let listener!: (key: MailAlertTapKey) => void;
    const backend: MailAlertTapBackend = {
      async subscribe(_installation, callback) { listener = callback; return { remove() {} }; },
      getLastResponse: () => cached.promise,
    };
    const resolved: string[] = [];
    const coordinator = createMailAlertTapCoordinator(backend);
    const starting = coordinator.start({ installationId, isReady: true,
      async resolve(key) { resolved.push(key.receiptId); return { kind: 'ignored' }; }, onResolution() {} });
    listener(Object.freeze({ installationId, receiptId: newerReceiptId }));
    cached.resolve(Object.freeze({ installationId, receiptId }));
    await starting;
    await vi.waitFor(() => expect(resolved).toEqual([newerReceiptId]));
    coordinator.dispose();
  });

  it('does not route a cold-start live response until subscription and cache ownership have drained', async () => {
    const cacheRead = deferred<MailAlertTapKey | undefined>();
    let listener!: (key: MailAlertTapKey) => void;
    const backend: MailAlertTapBackend = {
      async subscribe(_installation, callback) { listener = callback; return { remove() {} }; },
      getLastResponse: () => cacheRead.promise,
    };
    const resolved = vi.fn(async () => ({ kind: 'ignored' as const }));
    const coordinator = createMailAlertTapCoordinator(backend);
    const starting = coordinator.start({ installationId, isReady: true, resolve: resolved, onResolution() {} });
    listener({ installationId, receiptId });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    cacheRead.resolve(undefined);
    await starting;
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledOnce());
    coordinator.dispose();
  });

  it('retains blocked taps and only retries on explicit action or a readiness transition', async () => {
    let listener!: (key: MailAlertTapKey) => void;
    const backend: MailAlertTapBackend = {
      async subscribe(_installation, callback) { listener = callback; return { remove() {} }; },
      async getLastResponse() { return undefined; },
    };
    const results: string[] = [];
    let attempts = 0;
    let pending = false;
    const coordinator = createMailAlertTapCoordinator(backend);
    await coordinator.start({ installationId, isReady: true,
      async resolve() { attempts += 1; return attempts === 1 ? { kind: 'blocked' } : { kind: 'ignored' }; },
      onResolution(_key, result) { results.push(result.kind); }, onPendingChange(value) { pending = value; } });
    listener(Object.freeze({ installationId, receiptId }));
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(coordinator.hasPending()).toBe(true);
    expect(pending).toBe(true);
    coordinator.retryPending();
    await vi.waitFor(() => expect(results).toEqual(['ignored']));
    expect(coordinator.hasPending()).toBe(false);
    expect(pending).toBe(false);
    coordinator.dispose();
  });

  it('keeps a routable tap pending when the route observer rejects, then succeeds on explicit retry', async () => {
    let listener!: (key: MailAlertTapKey) => void;
    const backend: MailAlertTapBackend = {
      async subscribe(_installation, callback) { listener = callback; return { remove() {} }; },
      async getLastResponse() { return undefined; },
    };
    let attempts = 0;
    const coordinator = createMailAlertTapCoordinator(backend);
    await coordinator.start({ installationId, isReady: true,
      async resolve() { attempts += 1; return { kind: 'status', receiptId, reason: 'changed' }; },
      onResolution() { if (attempts === 1) throw new Error('navigation not accepted'); } });
    listener({ installationId, receiptId });
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(coordinator.hasPending()).toBe(true);
    coordinator.retryPending();
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(coordinator.hasPending()).toBe(false);
    coordinator.dispose();
  });

  it('does not publish a resolver result after readiness closes; readiness reopening re-resolves', async () => {
    let listener!: (key: MailAlertTapKey) => void;
    const backend: MailAlertTapBackend = {
      async subscribe(_installation, callback) { listener = callback; return { remove() {} }; },
      async getLastResponse() { return undefined; },
    };
    const first = deferred<{ kind: 'mail'; receiptId: string; ruleId: string; messageId: string; sourceVersion: string; subject: string; accountLabel: string; receivedAt: string; checkedAt: string }>();
    const routed = vi.fn();
    let attempts = 0;
    const coordinator = createMailAlertTapCoordinator(backend);
    await coordinator.start({ installationId, isReady: true,
      async resolve() { attempts += 1; return attempts === 1 ? await first.promise : { kind: 'ignored' }; },
      onResolution(_key, result) { routed(result); } });
    listener({ installationId, receiptId });
    await vi.waitFor(() => expect(attempts).toBe(1));
    coordinator.setReady(false);
    first.resolve({ kind: 'mail', receiptId, ruleId: 'rule', messageId: 'local-message', sourceVersion: 'v', subject: 'Subject', accountLabel: 'Account', receivedAt: '2026-10-13T00:00:00.000Z', checkedAt: '2026-10-13T00:00:00.000Z' });
    await Promise.resolve();
    await Promise.resolve();
    expect(routed).not.toHaveBeenCalled();
    expect(coordinator.hasPending()).toBe(true);
    coordinator.setReady(true);
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(routed).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it('keeps a cached candidate when readiness changes during the cache read without a newer live tap', async () => {
    const cached = deferred<MailAlertTapKey | undefined>();
    const backend: MailAlertTapBackend = {
      async subscribe() { return { remove() {} }; },
      getLastResponse: () => cached.promise,
    };
    const resolved = vi.fn(async () => ({ kind: 'ignored' as const }));
    const coordinator = createMailAlertTapCoordinator(backend);
    const starting = coordinator.start({ installationId, isReady: false, resolve: resolved, onResolution() {} });
    coordinator.setReady(true);
    cached.resolve({ installationId, receiptId });
    await starting;
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledOnce());
    coordinator.dispose();
  });

  it('removes a listener that finishes installing after disposal and suppresses late resolution', async () => {
    const subscribed = deferred<{ remove(): void }>();
    const removed = vi.fn();
    const backend: MailAlertTapBackend = {
      subscribe: async () => await subscribed.promise,
      async getLastResponse() { return { installationId, receiptId }; },
    };
    const resolution = vi.fn();
    const coordinator = createMailAlertTapCoordinator(backend);
    const starting = coordinator.start({ installationId, isReady: true, async resolve() { return { kind: 'ignored' }; }, onResolution: resolution });
    coordinator.dispose();
    subscribed.resolve({ remove: removed });
    await starting;
    expect(removed).toHaveBeenCalledOnce();
    expect(resolution).not.toHaveBeenCalled();
    expect(coordinator.hasPending()).toBe(false);
  });

  it('owns bridge import and cached response lookup only for the actual operation', async () => {
    let ownershipCalls = 0;
    const backend = createMailAlertTapBackend({ platform: 'ios', withNotificationOwnership: async <T,>(actual: () => Promise<T>) => { ownershipCalls += 1; return await actual(); },
      loadBridge: async () => ({ addNotificationResponseReceivedListener: () => ({ remove() {} }), getLastNotificationResponseAsync: async () => response() }) });
    await expect(backend.getLastResponse(installationId)).resolves.toEqual({ installationId, receiptId });
    expect(ownershipCalls).toBe(1);
  });

  it('removes a listener if privacy ownership fails after the SDK installed it', async () => {
    const removed = vi.fn();
    let sdkListener!: (value: unknown) => void;
    const received = vi.fn();
    const backend = createMailAlertTapBackend({ platform: 'ios',
      withNotificationOwnership: async (actual) => { await actual(); throw new Error('epoch changed after the operation'); },
      loadBridge: async () => ({ addNotificationResponseReceivedListener: (listener) => { sdkListener = listener; return { remove: removed }; }, getLastNotificationResponseAsync: async () => null }) });
    await expect(backend.subscribe(installationId, received)).rejects.toThrow();
    expect(removed).toHaveBeenCalledOnce();
    sdkListener(response());
    expect(received).not.toHaveBeenCalled();
  });
});
