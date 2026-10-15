/** @vitest-environment jsdom */
import React, { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebPushSubscriptionPanel } from '../src/web/WebPushSubscriptionPanel';
import { createWebPushBrowserCoordinator, type BrowserPushPort } from '../src/web/webPushBrowser';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return { Text: ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => ReactModule.createElement('span', { role: accessibilityRole }, children),
    View: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children) };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) =>
    ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9' } }));

const SESSION = Object.freeze({ authenticated: true as const, workspaceId: '92c41fd4-20f5-4fd3-8a58-347b8c1a3f2f', privacyEpoch: 7, csrfToken: 'csrf' });
const KEY_ID = '7cbd7bab-6eab-4dc3-8ff0-42b0d2c1b9d9';
const PUBLIC_KEY = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, index) => index + 1))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
let host: HTMLDivElement;
let root: Root;

function flush() { return act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Missing button ${label}`);
  act(() => button.click());
}

function Harness({ coordinator }: { coordinator: ReturnType<typeof createWebPushBrowserCoordinator> }) {
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  return <WebPushSubscriptionPanel coordinator={coordinator} state={state} blocked={false} />;
}

describe('browser notification settings panel', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it('shows explicit key setup, then offers device enable only after setup completes', async () => {
    let provisioned = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/web-push/status') return json(provisioned ? { schemaVersion: 1, privacyEpoch: 7, provisioned: true,
        activeKey: { keyId: KEY_ID, publicKey: PUBLIC_KEY, createdAt: '2026-01-01T00:00:00.000Z' }, subscriptionCount: 0 }
        : { schemaVersion: 1, privacyEpoch: 7, provisioned: false, subscriptionCount: 0 });
      if (path === '/api/web-push/vapid-key') return json(provisioned ? { schemaVersion: 1, privacyEpoch: 7, provisioned: true,
        keyId: KEY_ID, publicKey: PUBLIC_KEY, createdAt: '2026-01-01T00:00:00.000Z' }
        : { schemaVersion: 1, privacyEpoch: 7, provisioned: false });
      if (path === '/api/web-push/provision' && init?.method === 'POST') {
        provisioned = true;
        return json({ schemaVersion: 1, commandId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0002', operation: 'provision',
          result: { keyId: KEY_ID, publicKey: PUBLIC_KEY, createdAt: '2026-01-01T00:00:00.000Z' }, createdAt: '2026-01-01T00:00:00.000Z' });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const port: BrowserPushPort = { secureContext: true, standaloneRequired: false, standalone: false, serviceWorkerAvailable: true,
      pushAvailable: true, notificationsAvailable: true, locksAvailable: true, permission: 'default', requestPermission: async () => 'granted',
      withExclusiveLock: testOriginLock(),
      serviceWorkerReady: async () => ({ pushManager: { getSubscription: async () => null, subscribe: async () => { throw new Error('not used'); } } }),
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      randomUUID: () => '92c41fd4-20f5-4fd3-8a58-347b8c1f0002', fetcher };
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await act(async () => { root.render(<Harness coordinator={coordinator} />); });
    await act(async () => { await coordinator.start(); });
    await flush();
    expect(host.textContent).toContain('Set up the workspace notification key');
    click('Set up workspace notification key');
    await flush();
    expect(host.textContent).toContain('The workspace notification key is ready. Choose Enable on this device when you are ready.');
    expect(host.textContent).toContain('Enable notifications on this device');
    expect(host.textContent).not.toContain('generation');
    coordinator.dispose();
  });

  it('offers server disable for an unmatched owned head before any local cleanup action', async () => {
    let revoked = false;
    const subscription = { toJSON: () => ({ endpoint: 'https://push.example.test/opaque', keys: { p256dh: 'opaque', auth: 'opaque' } }),
      unsubscribe: vi.fn(async () => true) };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/web-push/status') return json({ schemaVersion: 1, privacyEpoch: 7, provisioned: true,
        activeKey: { keyId: KEY_ID, publicKey: PUBLIC_KEY, createdAt: '2026-01-01T00:00:00.000Z' }, subscriptionCount: 1 });
      if (path === '/api/web-push/vapid-key') return json({ schemaVersion: 1, privacyEpoch: 7, provisioned: true,
        keyId: KEY_ID, publicKey: PUBLIC_KEY, createdAt: '2026-01-01T00:00:00.000Z' });
      if (path === '/api/web-push/subscriptions/reconcile') return json({ schemaVersion: 1, privacyEpoch: 7,
        deviceId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0001', status: 'unmatched', generation: 1, keyId: KEY_ID, publicKey: PUBLIC_KEY });
      if (path === '/api/web-push/subscriptions' || path.startsWith('/api/web-push/subscriptions?')) return json({ schemaVersion: 1,
        privacyEpoch: 7, subscriptions: [{ deviceId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0001', generation: 1,
          status: revoked ? 'revoked' : 'active', keyId: KEY_ID, updatedAt: '2026-01-01T00:00:00.000Z' }] });
      if (path === '/api/web-push/subscriptions/revoke' && init?.method === 'POST') {
        revoked = true;
        return json({ schemaVersion: 1, commandId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0002', operation: 'revoke',
          result: { deviceId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0001', generation: 1, status: 'revoked', keyId: KEY_ID, updatedAt: '2026-01-01T00:00:00.000Z' },
          createdAt: '2026-01-01T00:00:00.000Z' });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const storage = new Map<string, string>([[`still:webpush:${SESSION.workspaceId}:${SESSION.privacyEpoch}`,
      JSON.stringify({ deviceId: '92c41fd4-20f5-4fd3-8a58-347b8c1f0001' })]]);
    const port: BrowserPushPort = { secureContext: true, standaloneRequired: false, standalone: false, serviceWorkerAvailable: true,
      pushAvailable: true, notificationsAvailable: true, locksAvailable: true, permission: 'default', requestPermission: async () => 'granted',
      withExclusiveLock: testOriginLock(), serviceWorkerReady: async () => ({ pushManager: { getSubscription: async () => subscription,
        subscribe: async () => { throw new Error('not used'); } } }),
      storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: (key) => { storage.delete(key); } },
      randomUUID: () => '92c41fd4-20f5-4fd3-8a58-347b8c1f0002', fetcher };
    const coordinator = createWebPushBrowserCoordinator(SESSION, { port, assertCurrent: () => undefined });
    await act(async () => { root.render(<Harness coordinator={coordinator} />); });
    await act(async () => { await coordinator.start(); });
    expect(host.textContent).toContain('This workspace has a saved device registration');
    expect(host.textContent).toContain('Disable saved device registration');
    expect(host.textContent).not.toContain('Clear this browser subscription locally');
    click('Disable saved device registration');
    await flush();
    expect(revoked).toBe(true);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Clear this browser subscription locally');
    coordinator.dispose();
  });
});

function testOriginLock(): BrowserPushPort['withExclusiveLock'] {
  let tail = Promise.resolve();
  return async (_name, signal, work) => {
    const previous = tail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    tail = previous.then(() => turn);
    await previous;
    if (signal.aborted) { release(); throw new Error('lock_aborted'); }
    try { return await work(); } finally { release(); }
  };
}

function json(value: unknown) { return { ok: true, status: 200, json: async () => value } as Response; }
