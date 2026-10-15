import { describe, expect, it, vi } from 'vitest';
import { createWebPushBrowserCoordinator, type BrowserPushManager, type BrowserPushPort, type BrowserPushSubscriptionHandle } from '../src/web/webPushBrowser';

const SESSION = Object.freeze({ authenticated: true as const, workspaceId: '92c41fd4-20f5-4fd3-8a58-347b8c1a3f2f', privacyEpoch: 7, csrfToken: 'csrf' });
const KEY_ID = '7cbd7bab-6eab-4dc3-8ff0-42b0d2c1b9d9';
const DEVICE_ID = '92c41fd4-20f5-4fd3-8a58-347b8c1f0001';
const OTHER_DEVICE_ID = '12c41fd4-20f5-4fd3-8a58-347b8c1f0001';
const PUBLIC_KEY = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, index) => index + 1))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const ENDPOINT = 'https://push.example.test/send/opaque';
const SUBSCRIPTION_JSON = { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-opaque', auth: 'auth-opaque' } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function reply(value: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

function activeStatus() {
  return { schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, provisioned: true,
    activeKey: { keyId: KEY_ID, publicKey: PUBLIC_KEY, createdAt: '2026-01-01T00:00:00.000Z' }, subscriptionCount: 1 };
}
function activePublicKey() {
  return { schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, provisioned: true, keyId: KEY_ID,
    publicKey: PUBLIC_KEY, createdAt: '2026-01-01T00:00:00.000Z' };
}
function head(status: 'active' | 'revoked' = 'active', deviceId = DEVICE_ID) {
  return { deviceId, generation: 1, status, keyId: KEY_ID, updatedAt: '2026-01-01T00:00:00.000Z' };
}
function makeSubscription(unsubscribe = vi.fn(async () => true)): BrowserPushSubscriptionHandle {
  return { toJSON: () => SUBSCRIPTION_JSON, unsubscribe };
}
function createSharedOriginLock(): BrowserPushPort['withExclusiveLock'] {
  let tail = Promise.resolve();
  return async <T,>(name: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    expect(name).toBe('still:webpush:subscription');
    const previous = tail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    tail = previous.then(() => turn);
    await previous;
    if (signal.aborted) { release(); throw new Error('lock_aborted'); }
    try { return await work(); } finally { release(); }
  };
}
function makePort(options: {
  fetcher?: typeof fetch;
  permission?: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
  subscription?: BrowserPushSubscriptionHandle | null;
  getSubscription?: () => Promise<BrowserPushSubscriptionHandle | null>;
  subscribe?: BrowserPushManager['subscribe'];
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  withExclusiveLock?: BrowserPushPort['withExclusiveLock'];
  locksAvailable?: boolean;
} = {}) {
  const storage = options.storage ?? new Map<string, string>();
  const backing = storage instanceof Map ? storage : undefined;
  const localStoragePort = options.storage ?? {
    getItem: (key: string) => backing?.get(key) ?? null,
    setItem: (key: string, value: string) => { backing?.set(key, value); },
    removeItem: (key: string) => { backing?.delete(key); },
  };
  const getSubscription = options.getSubscription ?? vi.fn(async () => options.subscription ?? null);
  const subscribe = options.subscribe ?? vi.fn(async () => makeSubscription());
  const manager: BrowserPushManager = { getSubscription, subscribe };
  const port: BrowserPushPort = {
    secureContext: true, standaloneRequired: false, standalone: false, serviceWorkerAvailable: true, pushAvailable: true,
    notificationsAvailable: true, locksAvailable: options.locksAvailable ?? true, permission: options.permission ?? 'default',
    requestPermission: options.requestPermission ?? vi.fn(async () => 'granted' as NotificationPermission),
    serviceWorkerReady: vi.fn(async () => ({ pushManager: manager })),
    withExclusiveLock: options.withExclusiveLock ?? (async (_name, signal, work) => {
      if (signal.aborted) throw new Error('lock_aborted');
      return work();
    }),
    storage: localStoragePort,
    randomUUID: vi.fn(() => '92c41fd4-20f5-4fd3-8a58-347b8c1f0002'),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  };
  return { port, storage: localStoragePort, manager, getSubscription, subscribe };
}

function fetchForStart(overrides: (path: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const calls: { path: string; method: string }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, method: init?.method ?? 'GET' });
    const overridden = overrides(path, init);
    if (overridden) return overridden;
    if (path === '/api/web-push/status') return reply(activeStatus());
    if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
    if (path.startsWith('/api/web-push/subscriptions')) return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, subscriptions: [] });
    throw new Error(`unexpected request ${path}`);
  });
  return { fetcher, calls };
}

describe('browser Web Push coordinator', () => {
  it('invokes permission synchronously before starting any network or service-worker work', async () => {
    const permission = deferred<NotificationPermission>();
    const order: string[] = [];
    const { fetcher } = fetchForStart((path) => { order.push(`fetch:${path}`); return undefined; });
    const { port } = makePort({ fetcher, requestPermission: () => { order.push('permission'); return permission.promise; } });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    order.length = 0;
    const enabling = coordinator.enable();
    expect(order[0]).toBe('permission');
    expect(order.some((entry) => entry.startsWith('fetch:'))).toBe(false);
    permission.resolve('denied');
    await enabling;
    expect(coordinator.getSnapshot().permission).toBe('denied');
  });

  it('catches a synchronous permission API failure and can refresh the live OS permission later', async () => {
    const { fetcher } = fetchForStart();
    const { port } = makePort({ fetcher, requestPermission: () => { throw new Error('permission_api_blocked'); } });
    let currentPermission: NotificationPermission = 'denied';
    Object.defineProperty(port, 'permission', { configurable: true, get: () => currentPermission });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().permission).toBe('denied');
    await coordinator.enable();
    expect(coordinator.getSnapshot().phase).toBe('error');
    expect(coordinator.getSnapshot().message).toBe('permission_api_blocked');
    currentPermission = 'granted';
    await coordinator.start();
    expect(coordinator.getSnapshot().permission).toBe('granted');
    coordinator.dispose();
  });

  it('stops after the owner changes while permission is pending and never creates or stores a subscription', async () => {
    const permission = deferred<NotificationPermission>();
    const { fetcher } = fetchForStart();
    const values = new Map<string, string>();
    const { port, subscribe } = makePort({ fetcher, requestPermission: () => permission.promise, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    } });
    let current = true;
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => { if (!current) throw new Error('workspace_changed'); } });
    await coordinator.start();
    const creating = coordinator.enable();
    current = false;
    coordinator.dispose();
    permission.resolve('granted');
    await creating;
    expect(subscribe).not.toHaveBeenCalled();
    expect([...values.values()]).toEqual([]);
  });

  it('does not write a local device or register after ownership changes during browser subscription creation', async () => {
    const subscriptionDeferred = deferred<BrowserPushSubscriptionHandle>();
    const subscribeStarted = deferred<void>();
    const values = new Map<string, string>();
    const { fetcher, calls } = fetchForStart();
    const { port, subscribe } = makePort({ fetcher, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    }, subscribe: vi.fn(() => { subscribeStarted.resolve(); return subscriptionDeferred.promise; }) });
    let current = true;
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => { if (!current) throw new Error('workspace_changed'); } });
    await coordinator.start();
    const enabling = coordinator.enable();
    await subscribeStarted.promise;
    current = false;
    coordinator.dispose();
    subscriptionDeferred.resolve(makeSubscription());
    await enabling;
    expect(subscribe).toHaveBeenCalledOnce();
    expect(calls.some(({ path }) => path === '/api/web-push/subscriptions/register')).toBe(false);
    expect([...values.values()]).toEqual([]);
  });

  it('keeps refresh busy and rejects a second operation until the first status JSON settles', async () => {
    const status = deferred<unknown>();
    const jsonStarted = deferred<void>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/web-push/status'
      ? ({ ok: true, status: 200, json: () => { jsonStarted.resolve(); return status.promise; } } as Response)
      : reply(activePublicKey()));
    const { port } = makePort({ fetcher });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    const loading = coordinator.start();
    await jsonStarted.promise;
    expect(coordinator.getSnapshot().busy).toBe(true);
    await expect(coordinator.start()).rejects.toThrow('already in progress');
    status.resolve(activeStatus());
    await loading;
    expect(coordinator.getSnapshot().busy).toBe(false);
  });

  it('does not let a generic error state authorize direct browser cleanup', async () => {
    const unsubscribe = vi.fn(async () => true);
    const { port } = makePort({ fetcher: vi.fn(async () => { throw new Error('offline'); }), subscription: makeSubscription(unsubscribe) });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('error');
    await expect(coordinator.clearLocalSubscription()).rejects.toThrow('Disable an owned workspace registration');
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('recovers a provision receipt after reload from a pending marker without a device ID', async () => {
    const commandId = '92c41fd4-20f5-4fd3-8a58-347b8c1f0003';
    const storageKey = `still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`;
    const values = new Map<string, string>([[storageKey, JSON.stringify({ pending: { commandId, action: 'provision' } })]]);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/web-push/commands/' + commandId) return reply({ schemaVersion: 1, commandId, operation: 'provision',
        result: { keyId: KEY_ID, publicKey: PUBLIC_KEY, createdAt: '2026-01-01T00:00:00.000Z' }, createdAt: '2026-01-01T00:00:00.000Z' });
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      throw new Error(`unexpected request ${path}`);
    });
    const { port } = makePort({ fetcher, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    } });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(fetcher.mock.calls.map(([input]) => String(input))).toContain('/api/web-push/commands/' + commandId);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(values.has(storageKey)).toBe(false);
    expect(coordinator.getSnapshot().phase).toBe('disabled');
  });

  it('does not create a new browser subscription when the server already has an active head', async () => {
    const values = new Map<string, string>([[`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`, JSON.stringify({ deviceId: DEVICE_ID })]]);
    const { fetcher } = fetchForStart((path) => path.startsWith('/api/web-push/subscriptions')
      ? reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, subscriptions: [head()] }) : undefined);
    const { port, subscribe } = makePort({ fetcher, storage: undefined as unknown as Storage });
    port.storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('server_active_local_missing');
    await coordinator.enable();
    expect(coordinator.getSnapshot().phase).toBe('server_active_local_missing');
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('revokes the server registration before asking the browser to unsubscribe', async () => {
    let order: string[] = [];
    let serverRevoked = false;
    const unsubscribe = vi.fn(async () => { order.push('UNSUBSCRIBE'); return true; });
    const subscription = makeSubscription(unsubscribe);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET'; order.push(`${method}:${path}`);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path.startsWith('/api/web-push/subscriptions/reconcile')) return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'matched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      if (path === '/api/web-push/subscriptions' || path.startsWith('/api/web-push/subscriptions?')) return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, subscriptions: [head(serverRevoked ? 'revoked' : 'active')] });
      if (path === '/api/web-push/subscriptions/revoke') { serverRevoked = true; return reply({ schemaVersion: 1, commandId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0002',
        operation: 'revoke', result: head('revoked'), createdAt: '2026-01-01T00:00:00.000Z' }); }
      throw new Error(`unexpected request ${path}`);
    });
    const localStorage = new Map<string, string>([[`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`, JSON.stringify({ deviceId: DEVICE_ID })]]);
    const { port } = makePort({ fetcher, subscription });
    port.storage = { getItem: (key) => localStorage.get(key) ?? null, setItem: (key, value) => { localStorage.set(key, value); }, removeItem: (key) => { localStorage.delete(key); } };
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('enabled');
    await expect(coordinator.clearLocalSubscription()).rejects.toThrow('Disable an owned workspace registration');
    expect(unsubscribe).not.toHaveBeenCalled();
    await coordinator.disable();
    expect(order.findIndex((entry) => entry === 'POST:/api/web-push/subscriptions/revoke')).toBeLessThan(order.findIndex((entry) => entry === 'UNSUBSCRIBE'));
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().phase).toBe('disabled');
  });

  it('does not clear an unmatched browser subscription while its owned server head remains active', async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscription = makeSubscription(unsubscribe);
    const values = new Map<string, string>([[`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`, JSON.stringify({ deviceId: DEVICE_ID })]]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path.startsWith('/api/web-push/subscriptions/reconcile')) return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'unmatched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      throw new Error(`unexpected request ${path}`);
    });
    const { port } = makePort({ fetcher, subscription, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    } });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('unmatched_local');
    await expect(coordinator.clearLocalSubscription()).rejects.toThrow('Disable an owned workspace registration');
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(values.has(`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`)).toBe(true);
  });

  it('disables an unmatched owned server head without unsubscribing another browser subscription', async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscription = makeSubscription(unsubscribe);
    const values = new Map<string, string>([[`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`, JSON.stringify({ deviceId: DEVICE_ID })]]);
    let revoked = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path.startsWith('/api/web-push/subscriptions/reconcile')) return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'unmatched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      if (path === '/api/web-push/subscriptions' || path.startsWith('/api/web-push/subscriptions?')) {
        return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, subscriptions: [head(revoked ? 'revoked' : 'active')] });
      }
      if (path === '/api/web-push/subscriptions/revoke') {
        revoked = true;
        return reply({ schemaVersion: 1, commandId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0002', operation: 'revoke',
          result: head('revoked'), createdAt: '2026-01-01T00:00:00.000Z' });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const { port } = makePort({ fetcher, subscription, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    } });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('unmatched_local');
    await coordinator.disable();
    expect(revoked).toBe(true);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().phase).toBe('unresolved_local');
    expect(values.has(`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`)).toBe(false);
  });

  it('leaves a replacement browser subscription untouched after revoking an older matched owner head', async () => {
    const unsubscribeOld = vi.fn(async () => true);
    const oldSubscription = makeSubscription(unsubscribeOld);
    const unsubscribeReplacement = vi.fn(async () => true);
    const replacement: BrowserPushSubscriptionHandle = { toJSON: () => ({ endpoint: 'https://push.example.test/another',
      keys: { p256dh: 'different-p256dh', auth: 'different-auth' } }), unsubscribe: unsubscribeReplacement };
    let reads = 0;
    const getSubscription = vi.fn(async () => ++reads <= 2 ? oldSubscription : replacement);
    const values = new Map<string, string>([[`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`, JSON.stringify({ deviceId: DEVICE_ID })]]);
    let revoked = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path.startsWith('/api/web-push/subscriptions/reconcile')) return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'matched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      if (path === '/api/web-push/subscriptions' || path.startsWith('/api/web-push/subscriptions?')) {
        return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, subscriptions: [head(revoked ? 'revoked' : 'active')] });
      }
      if (path === '/api/web-push/subscriptions/revoke') {
        revoked = true;
        return reply({ schemaVersion: 1, commandId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0002', operation: 'revoke',
          result: head('revoked'), createdAt: '2026-01-01T00:00:00.000Z' });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const { port } = makePort({ fetcher, getSubscription, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    } });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('enabled');
    await coordinator.disable();
    expect(revoked).toBe(true);
    expect(unsubscribeOld).not.toHaveBeenCalled();
    expect(unsubscribeReplacement).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().phase).toBe('unresolved_local');
  });

  it('rechecks an unresolved local device head under the lock before unsubscribing', async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscription = makeSubscription(unsubscribe);
    const values = new Map<string, string>([[`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`, JSON.stringify({ deviceId: DEVICE_ID })]]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path.startsWith('/api/web-push/subscriptions/reconcile')) return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'missing' });
      if (path === '/api/web-push/subscriptions' || path.startsWith('/api/web-push/subscriptions?')) {
        return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, subscriptions: [head()] });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const { port } = makePort({ fetcher, subscription, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    } });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('unresolved_local');
    await coordinator.clearLocalSubscription();
    expect(coordinator.getSnapshot().phase).toBe('unmatched_local');
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(values.has(`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`)).toBe(true);
  });

  it('serializes same-origin tabs and inspects the first tab’s exact lost-ACK command', async () => {
    const lock = createSharedOriginLock();
    const values = new Map<string, string>();
    let browserSubscription: BrowserPushSubscriptionHandle | null = null;
    let storedReceipt: unknown;
    let registerPosts = 0;
    let receiptReads = 0;
    const registeredCommands: string[] = [];
    const inspectedCommands: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path === '/api/web-push/subscriptions' || path.startsWith('/api/web-push/subscriptions?')) return reply({ schemaVersion: 1,
        privacyEpoch: SESSION.privacyEpoch, subscriptions: storedReceipt ? [head()] : [] });
      if (path === '/api/web-push/subscriptions/reconcile') return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'matched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      if (path === '/api/web-push/subscriptions/register') {
        registerPosts += 1;
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        registeredCommands.push(body.commandId);
        storedReceipt = { schemaVersion: 1, commandId: body.commandId, operation: 'register', result: head(), createdAt: '2026-01-01T00:00:00.000Z' };
        return reply({ error: 'response lost after commit' }, 503);
      }
      if (path.startsWith('/api/web-push/commands/')) { receiptReads += 1; inspectedCommands.push(path.slice('/api/web-push/commands/'.length)); return reply(storedReceipt); }
      throw new Error(`unexpected request ${path}`);
    });
    const makeTabPort = () => makePort({ fetcher, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    }, withExclusiveLock: lock, getSubscription: async () => browserSubscription,
    subscribe: async () => { browserSubscription = makeSubscription(); return browserSubscription; } });
    const first = createWebPushBrowserCoordinator(SESSION, { port: makeTabPort().port, assertCurrent: () => undefined });
    const second = createWebPushBrowserCoordinator(SESSION, { port: makeTabPort().port, assertCurrent: () => undefined });
    await Promise.all([first.start(), second.start()]);
    await Promise.all([first.enable(), second.enable()]);
    expect(registerPosts).toBe(1);
    expect(receiptReads).toBe(1);
    expect(inspectedCommands).toEqual(registeredCommands);
    expect(first.getSnapshot().phase).toBe('registration_unknown');
    expect(second.getSnapshot().phase).toBe('enabled');
    expect(JSON.parse(values.get(`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`) ?? '{}')).toEqual({ deviceId: DEVICE_ID });
    first.dispose(); second.dispose();
  });

  it('cancels a queued cross-tab lock request when that workspace owner is disposed', async () => {
    const lock = createSharedOriginLock();
    const subscriptionDeferred = deferred<BrowserPushSubscriptionHandle>();
    const subscribeStarted = deferred<void>();
    const values = new Map<string, string>();
    let browserSubscription: BrowserPushSubscriptionHandle | null = null;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path === '/api/web-push/subscriptions/register') {
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return reply({ schemaVersion: 1, commandId: body.commandId, operation: 'register', result: head(), createdAt: '2026-01-01T00:00:00.000Z' });
      }
      if (path === '/api/web-push/subscriptions/reconcile') return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'matched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      if (path === '/api/web-push/subscriptions' || path.startsWith('/api/web-push/subscriptions?')) return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch, subscriptions: [] });
      throw new Error(`unexpected request ${path}`);
    });
    const portFor = (subscribe?: BrowserPushManager['subscribe']) => makePort({ fetcher, withExclusiveLock: lock, getSubscription: async () => browserSubscription,
      subscribe: subscribe ?? (async () => { browserSubscription = makeSubscription(); return browserSubscription; }), storage: {
        getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
      } }).port;
    const first = createWebPushBrowserCoordinator(SESSION, { port: portFor(vi.fn(() => { subscribeStarted.resolve(); return subscriptionDeferred.promise; })), assertCurrent: () => undefined });
    const secondPort = portFor();
    const second = createWebPushBrowserCoordinator(SESSION, { port: secondPort, assertCurrent: () => undefined });
    await Promise.all([first.start(), second.start()]);
    const before = vi.mocked(secondPort.serviceWorkerReady).mock.calls.length;
    const firstEnable = first.enable();
    await subscribeStarted.promise;
    const queuedStart = second.start();
    expect(second.getSnapshot().busy).toBe(true);
    second.dispose();
    subscriptionDeferred.resolve(makeSubscription());
    await Promise.all([firstEnable, queuedStart]);
    expect(secondPort.serviceWorkerReady).toHaveBeenCalledTimes(before);
    expect(fetcher.mock.calls.filter(([input]) => String(input) === '/api/web-push/status')).toHaveLength(3);
    first.dispose();
  });

  it('rechecks the origin-global subscription under lock before another workspace can enroll it', async () => {
    const lock = createSharedOriginLock();
    const subscriptionDeferred = deferred<BrowserPushSubscriptionHandle>();
    const subscribeStarted = deferred<void>();
    const values = new Map<string, string>();
    let browserSubscription: BrowserPushSubscriptionHandle | null = null;
    let registerPosts = 0;
    const secondSession = Object.freeze({ authenticated: true as const, workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', privacyEpoch: 7, csrfToken: 'other-csrf' });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path === '/api/web-push/subscriptions') return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        subscriptions: registerPosts ? [head()] : [] });
      if (path === '/api/web-push/subscriptions/register') {
        registerPosts += 1;
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return reply({ schemaVersion: 1, commandId: body.commandId, operation: 'register', result: head(), createdAt: '2026-01-01T00:00:00.000Z' });
      }
      if (path === '/api/web-push/subscriptions/reconcile') return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'matched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      throw new Error(`unexpected request ${path}`);
    });
    const makeTabPort = (subscribe?: BrowserPushManager['subscribe']) => makePort({ fetcher, withExclusiveLock: lock,
      getSubscription: async () => browserSubscription, subscribe: subscribe ?? (async () => { browserSubscription = makeSubscription(); return browserSubscription; }),
      storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } } }).port;
    const first = createWebPushBrowserCoordinator(SESSION, { port: makeTabPort(vi.fn(() => { subscribeStarted.resolve(); return subscriptionDeferred.promise; })), assertCurrent: () => undefined });
    const other = createWebPushBrowserCoordinator(secondSession, { port: makeTabPort(), assertCurrent: () => undefined });
    await first.start();
    const firstEnable = first.enable();
    await subscribeStarted.promise;
    const otherStart = other.start();
    expect(other.getSnapshot().busy).toBe(true);
    browserSubscription = makeSubscription();
    subscriptionDeferred.resolve(browserSubscription);
    await Promise.all([firstEnable, otherStart]);
    expect(other.getSnapshot().phase).toBe('unresolved_local');
    expect(registerPosts).toBe(1);
    expect(values.has(`still:webpush:${secondSession.workspaceId}:${secondSession.privacyEpoch}`)).toBe(false);
    first.dispose(); other.dispose();
  });

  it('does not transfer a browser subscription to another workspace in a concurrent tab', async () => {
    const lock = createSharedOriginLock();
    const values = new Map<string, string>();
    let browserSubscription: BrowserPushSubscriptionHandle | null = null;
    let registerPosts = 0;
    const secondSession = Object.freeze({ authenticated: true as const, workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', privacyEpoch: 7, csrfToken: 'other-csrf' });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/web-push/status') return reply(activeStatus());
      if (path === '/api/web-push/vapid-key') return reply(activePublicKey());
      if (path === '/api/web-push/subscriptions') return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        subscriptions: registerPosts ? [head()] : [] });
      if (path === '/api/web-push/subscriptions/reconcile') return reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        deviceId: DEVICE_ID, status: 'matched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      if (path === '/api/web-push/subscriptions/register') { registerPosts += 1; return reply({ schemaVersion: 1, commandId: JSON.parse(String(init?.body)).commandId,
        operation: 'register', result: head(), createdAt: '2026-01-01T00:00:00.000Z' }); }
      throw new Error(`unexpected request ${path}`);
    });
    const makeTabPort = () => makePort({ fetcher, storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
    }, withExclusiveLock: lock, getSubscription: async () => browserSubscription,
    subscribe: async () => { browserSubscription = makeSubscription(); return browserSubscription; } });
    const owner = createWebPushBrowserCoordinator(SESSION, { port: makeTabPort().port, assertCurrent: () => undefined });
    await owner.start();
    await owner.enable();
    const other = createWebPushBrowserCoordinator(secondSession, { port: makeTabPort().port, assertCurrent: () => undefined });
    await other.start();
    expect(other.getSnapshot().phase).toBe('unresolved_local');
    expect(registerPosts).toBe(1);
    expect(values.has(`still:webpush:${secondSession.workspaceId}:${secondSession.privacyEpoch}`)).toBe(false);
    owner.dispose(); other.dispose();
  });

  it('reports unsupported when origin-wide locking is unavailable', async () => {
    const { fetcher } = fetchForStart();
    const { port } = makePort({ fetcher, locksAvailable: false });
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('unsupported');
    expect(coordinator.getSnapshot().message).toContain('cross-tab safety');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects repeated or non-monotonic subscription page cursors instead of looping', async () => {
    const { fetcher } = fetchForStart((path) => path.startsWith('/api/web-push/subscriptions')
      ? reply({ schemaVersion: 1, privacyEpoch: SESSION.privacyEpoch,
        subscriptions: path.includes('?cursor=') ? [] : [head('active', OTHER_DEVICE_ID)], nextCursor: OTHER_DEVICE_ID }) : undefined);
    const local = new Map<string, string>([[`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`, JSON.stringify({ deviceId: 'f2c41fd4-20f5-4fd3-8a58-347b8c1f0001' })]]);
    const { port } = makePort({ fetcher });
    port.storage = { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => { local.set(key, value); }, removeItem: (key) => { local.delete(key); } };
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await coordinator.start();
    expect(coordinator.getSnapshot().phase).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
