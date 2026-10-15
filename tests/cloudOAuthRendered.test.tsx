/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { Account } from '../src/core';
import type { AuthenticatedSession } from '../src/web/authClient';
import { CloudWorkspaceSession } from '../src/web/CloudWorkspaceSession';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, onPress, onChangeText, style: _style, accessibilityLabel, accessibilityRole, accessibilityState, secureTextEntry, ...props }: Record<string, unknown> & {
    children?: React.ReactNode; onPress?: () => void; onChangeText?: (value: string) => void; accessibilityLabel?: string; accessibilityRole?: string;
    accessibilityState?: { checked?: boolean; disabled?: boolean }; secureTextEntry?: boolean;
  }) => ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}), ...(accessibilityRole ? { role: accessibilityRole } : {}),
    ...(accessibilityState?.checked !== undefined ? { 'aria-checked': accessibilityState.checked } : {}), ...(secureTextEntry ? { 'data-secure-text-entry': 'true' } : {}),
    ...(onPress ? { onClick: onPress } : {}), ...(onChangeText ? { onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.target.value) } : {}) }, children);
  const TextInput = ReactModule.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
    const { accessibilityLabel, secureTextEntry, onChangeText, defaultValue, editable, ...rest } = props;
    const tag = secureTextEntry ? 'input' : 'textarea';
    return ReactModule.createElement(tag, { ...rest, ref, defaultValue, disabled: editable === false, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
      ...(secureTextEntry ? { type: 'password' } : {}), onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => (onChangeText as ((value: string) => void) | undefined)?.(event.target.value) });
  });
  return { ActivityIndicator: () => ReactModule.createElement('span', null, 'loading'), KeyboardAvoidingView: element('div'), Modal: element('div'), View: element('div'),
    Text: element('span'), Pressable: element('button'), ScrollView: element('div'), TextInput,
    Switch: ({ value, disabled, accessibilityLabel, onValueChange }: { value: boolean; disabled?: boolean; accessibilityLabel: string; onValueChange: (value: boolean) => void }) =>
      ReactModule.createElement('input', { type: 'checkbox', checked: value, disabled, 'aria-label': accessibilityLabel, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onValueChange(event.target.checked) }),
    StyleSheet: { create: (value: unknown) => value }, Platform: { OS: 'web' } };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  return { SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', { 'data-safe-area-provider': 'true' }, children),
    SafeAreaView: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children) };
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
  const ReactModule = await import('react');
  return { default: ({ name }: { name: string }) => ReactModule.createElement('span', null, name) };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    IconButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    Field: ({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) => ReactModule.createElement('label', null, label,
      ReactModule.createElement('textarea', { 'aria-label': label, value, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.target.value) })),
  };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00', bg: '#000', input: '#111' }, s: new Proxy({}, { get: () => ({}) }) }));

const workspaceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const replacementWorkspaceId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const stageId = '22222222-2222-4222-8222-222222222222';
const accountId = '66666666-6666-4666-8666-666666666666';
const session: AuthenticatedSession = Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'c'.repeat(43) });
const replacementSession: AuthenticatedSession = Object.freeze({ authenticated: true, workspaceId: replacementWorkspaceId, privacyEpoch: 4, csrfToken: 'd'.repeat(43) });
const startedAt = 1_800_000_000_000;
const expiresAt = startedAt + 600_000;

function snapshot(owner = workspaceId, epoch = 3, revision = 7, installed = false, extraAccount?: Account) {
  const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
  if (installed) state.accounts.push({ id: accountId, provider: 'google', displayName: 'Alex Example', email: 'alex@example.test', connected: true,
    authStatus: 'connected', identity: { providerNamespace: 'google', subject: 'private-subject' }, capabilities: ['mail.read', 'calendar.read'],
    connectionGeneration: 1, lastSyncedAt: '2026-10-15T00:00:00.000Z' } satisfies Account);
  if (extraAccount) state.accounts.push(extraAccount);
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: owner, privacyEpoch: epoch, revision });
}
function stage(status: 'verified' | 'authorization_pending' = 'verified') {
  return { attemptId: stageId, registrationId: 'google-web', provider: 'google', status, payloadGeneration: 1, createdAt: startedAt, expiresAt };
}
function preview() {
  return { displayName: 'Alex Example', email: 'alex@example.test', requestedCapabilities: ['mail.read', 'calendar.read'], capabilities: ['mail.read', 'calendar.read'] };
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function credentials(owner = workspaceId, epoch = 3) { return { workspaceId: owner, privacyEpoch: epoch,
  credentials: { speech: { configured: false, generation: 0 }, openrouter: { configured: false, generation: 0 } } }; }
function flush() { return act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); }); }

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label) || item.getAttribute('aria-label') === label);
  if (!button) throw new Error(`Missing button ${label}; rendered ${host.textContent}`);
  act(() => button.click());
}
function buttonEnabled(label: string): boolean {
  return [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label))?.disabled === false;
}

describe('OAuth rendered through the authenticated browser session', () => {
  it('does not install from a callback hint; retains a lost install command across Settings close/reopen and inspects it exactly once', async () => {
    window.history.replaceState(null, '', `/?oauth_stage=${stageId}`);
    const initial = snapshot();
    const installed = snapshot(workspaceId, 3, 8, true);
    const commandPosts: Record<string, unknown>[] = [];
    const exactInspections: string[] = [];
    let admittedInstallCommandId: string | undefined;
    let refreshes = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/workspace/snapshot') return json(initial);
      if (path === '/api/credentials') return json(credentials());
      if (path === '/api/oauth/availability') return json({ google: true, microsoft: false });
      if (path === '/api/oauth/starts') return json([]);
      if (path === `/api/oauth/stages/${stageId}`) return json({ stage: stage('verified'), verifiedAccount: preview() });
      if (path === '/api/workspace/commands' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        commandPosts.push(body);
        admittedInstallCommandId = String(body.commandId);
        throw new TypeError('lost acknowledgement');
      }
      if (path === `/api/workspace/commands/${admittedInstallCommandId}` && init?.method === 'GET') {
        exactInspections.push(path);
        return json({ schemaVersion: 1, commandId: admittedInstallCommandId, status: 'finished', receipt: { schemaVersion: 1, commandId: admittedInstallCommandId,
          kind: 'accounts.installOAuth', stageId, objectId: accountId, accountGeneration: 1 } });
      }
      if (path === '/api/workspace/refresh') { refreshes += 1; return json(installed); }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
    });
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const storageRemove = vi.spyOn(Storage.prototype, 'removeItem');
    vi.stubGlobal('fetch', fetcher);
    try {
      act(() => root.render(<SafeAreaProvider><CloudWorkspaceSession session={session} onLogout={vi.fn()} /></SafeAreaProvider>));
      await flush();
      click('Open settings');
      click('Manage connections');
      await flush();
      expect(host.textContent).toContain('Alex Example');
      expect(host.textContent).toContain('Requested access · mail.read, calendar.read');
      expect(host.textContent).toContain('Granted access · mail.read, calendar.read');
      expect(window.location.search).toBe('');
      expect(commandPosts).toHaveLength(0);

      click('Add account');
      await flush();
      expect(commandPosts).toHaveLength(1);
      expect(commandPosts[0]).toMatchObject({ command: { kind: 'accounts.installOAuth', stageId } });
      expect(host.textContent).toContain('install result is uncertain');
      expect(exactInspections).toHaveLength(0);
      const commandRequest = fetcher.mock.calls.find(([path, init]) => String(path) === '/api/workspace/commands' && init?.method === 'POST');
      expect((commandRequest?.[1]?.headers as Record<string, string>)['X-Still-CSRF']).toBe(session.csrfToken);

      click('Close connection details');
      click('Close settings');
      click('Open settings');
      expect([...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Close settings'))?.disabled).toBe(false);
      expect([...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Manage connections'))?.disabled).toBe(false);
      click('Manage connections');
      expect(host.textContent).toContain('Close connection details');
      await flush();
      expect(host.textContent).toContain('Inspect exact account-install command');
      expect([...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Inspect exact account-install command'))?.disabled).toBe(false);
      click('Inspect exact account-install command');
      await flush();
      expect(exactInspections).toEqual([`/api/workspace/commands/${admittedInstallCommandId}`]);
      expect(refreshes).toBe(1);
      expect(commandPosts).toHaveLength(1);
      expect(host.textContent).toContain('Account details are refreshed; no install was resent.');
      expect(host.textContent).not.toContain('Add account');
      expect(storageWrite).not.toHaveBeenCalled();
      expect(storageRemove).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', '/');
      vi.unstubAllGlobals();
    }
  });

  it('keeps an uncertain start CID across Settings close/reopen and inspects that exact request without a second POST', async () => {
    window.history.replaceState(null, '', '/');
    const startCids: string[] = [];
    const inspected: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/workspace/snapshot') return json(snapshot());
      if (path === '/api/credentials') return json(credentials());
      if (path === '/api/oauth/availability') return json({ google: true, microsoft: false });
      if (path === '/api/oauth/starts') return json([]);
      if (path === '/api/oauth/google/start' && init?.method === 'POST') {
        startCids.push(String((JSON.parse(String(init.body)) as { startAttemptId: string }).startAttemptId));
        throw new TypeError('connection interrupted');
      }
      const startMatch = path.match(/^\/api\/oauth\/google\/starts\/([0-9a-f-]+)$/);
      if (startMatch && init?.method === 'GET') {
        inspected.push(startMatch[1]!);
        return json({ startAttemptId: startMatch[1], provider: 'google', status: 'inspect_required', stageId,
          createdAt: startedAt, expiresAt });
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
    });
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal('fetch', fetcher);
    try {
      act(() => root.render(<SafeAreaProvider><CloudWorkspaceSession session={session} onLogout={vi.fn()} /></SafeAreaProvider>));
      await flush();
      click('Open settings');
      click('Manage connections');
      await flush();
      click('Connect Google');
      await flush();
      expect(startCids).toHaveLength(1);
      expect(host.textContent).toContain('start result is uncertain');
      click('Close connection details');
      click('Close settings');
      click('Open settings');
      click('Manage connections');
      await flush();
      click('Inspect uncertain start');
      await flush();
      expect(inspected).toEqual(startCids);
      expect(startCids).toHaveLength(1);
      expect(host.textContent).toContain('inspect required');
      expect(storageWrite).not.toHaveBeenCalled();
    } finally { window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); }
  });

  it('refreshes after an exact not-admitted rejection before the user deliberately starts a fresh request', async () => {
    window.history.replaceState(null, '', '/');
    const startIds: string[] = [];
    let refreshes = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/workspace/snapshot') return json(snapshot());
      if (path === '/api/credentials') return json(credentials());
      if (path === '/api/oauth/availability') return json({ google: true, microsoft: false });
      if (path === '/api/oauth/starts') return json([]);
      if (path === '/api/oauth/google/start' && init?.method === 'POST') {
        startIds.push(String((JSON.parse(String(init.body)) as { startAttemptId: string }).startAttemptId));
        return startIds.length === 1
          ? json({ error: 'oauth_start_not_admitted' }, 409)
          : json({ kind: 'started', status: stage('authorization_pending'), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fresh' });
      }
      if (path === '/api/workspace/refresh' && init?.method === 'POST') {
        refreshes += 1;
        return json(snapshot(workspaceId, 3, 8));
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
    });
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const storageRemove = vi.spyOn(Storage.prototype, 'removeItem');
    vi.stubGlobal('fetch', fetcher);
    try {
      act(() => root.render(<SafeAreaProvider><CloudWorkspaceSession session={session} onLogout={vi.fn()} /></SafeAreaProvider>));
      await flush();
      click('Open settings');
      click('Manage connections');
      await flush();
      click('Connect Google');
      await flush();
      expect(startIds).toHaveLength(1);
      expect(host.textContent).toContain('workspace changed before the request started');
      expect(host.textContent).not.toContain('Inspect uncertain start');
      expect(buttonEnabled('Refresh workspace')).toBe(true);
      click('Refresh workspace');
      await flush();
      expect(refreshes).toBe(1);
      expect(host.textContent).toContain('Workspace refreshed. Review the current saved details');
      expect(startIds).toHaveLength(1);
      click('Connect Google');
      await flush();
      expect(startIds).toHaveLength(2);
      expect(startIds[1]).not.toBe(startIds[0]);
      expect(host.textContent).toContain('Connection request started');
      expect(storageWrite).not.toHaveBeenCalled();
      expect(storageRemove).not.toHaveBeenCalled();
    } finally { window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); }
  });

  it('reconnects the exact saved account only after reviewing its verified access and explicit install receipt', async () => {
    window.history.replaceState(null, '', '/');
    const opaqueAccountId = 'acct-東京-🧭-Δ';
    const saved: Account = { id: opaqueAccountId, provider: 'google', displayName: 'Alex Saved', email: 'alex.saved@example.test', connected: true,
      authStatus: 'connected', identity: { providerNamespace: 'google', subject: 'private-subject' }, capabilities: ['mail.read'],
      connectionGeneration: 4, lastSyncedAt: '2026-10-15T00:00:00.000Z' };
    const initial = snapshot(workspaceId, 3, 7, false, saved);
    const reconnectedAccount: Account = { ...saved, connectionGeneration: 5, lastSyncedAt: '2026-10-15T00:10:00.000Z' };
    const refreshed = snapshot(workspaceId, 3, 8, false, reconnectedAccount);
    const startBodies: Record<string, unknown>[] = [];
    const installBodies: Record<string, unknown>[] = [];
    let installPosts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/workspace/snapshot') return json(initial);
      if (path === '/api/credentials') return json(credentials());
      if (path === '/api/oauth/availability') return json({ google: true, microsoft: false });
      if (path === '/api/oauth/starts') return json([]);
      if (path === '/api/oauth/google/start' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        startBodies.push(body);
        return json({ kind: 'started', status: stage('verified'), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=reconnect' });
      }
      if (path === `/api/oauth/stages/${stageId}`) return json({ stage: stage('verified'), verifiedAccount: {
        displayName: 'Alex Saved', email: 'alex.saved@example.test', requestedCapabilities: ['mail.read', 'calendar.read'],
        capabilities: ['mail.read'], reconnectAccountId: opaqueAccountId,
      } });
      if (path === '/api/workspace/commands' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        installBodies.push(body);
        installPosts += 1;
        const envelope = body as { commandId: string; command: { kind: string; stageId: string } };
        return json({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', snapshot: refreshed,
          receipt: { schemaVersion: 1, commandId: envelope.commandId, kind: 'accounts.installOAuth', stageId: envelope.command.stageId,
            objectId: opaqueAccountId, accountGeneration: 5 } });
      }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
    });
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const storageRemove = vi.spyOn(Storage.prototype, 'removeItem');
    vi.stubGlobal('fetch', fetcher);
    try {
      act(() => root.render(<SafeAreaProvider><CloudWorkspaceSession session={session} onLogout={vi.fn()} /></SafeAreaProvider>));
      await flush();
      click('Open settings');
      click('Manage connections');
      await flush();
      expect(host.textContent).toContain('Alex Saved');
      click('Select this account to reconnect');
      click('Reconnect Google account');
      await flush();
      expect(startBodies).toHaveLength(1);
      const start = startBodies[0] as { startAttemptId: string; requestedCapabilities: string[]; reconnectAccountId?: string; expectedRevision: number };
      expect(start.startAttemptId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(start.startAttemptId).not.toBe(stageId);
      expect(start.requestedCapabilities).toEqual(['mail.read', 'calendar.read']);
      expect(start.reconnectAccountId).toBe(opaqueAccountId);
      expect(start.expectedRevision).toBe(7);
      expect(installPosts).toBe(0);

      click('Review verified connection');
      await flush();
      expect(host.textContent).toContain('Reconnect target · Alex Saved');
      expect(host.textContent).toContain('Granted access · mail.read');
      expect(installPosts).toBe(0);
      click('Add account');
      await flush();
      expect(installPosts).toBe(1);
      expect(installBodies[0]).toMatchObject({ command: { kind: 'accounts.installOAuth', stageId } });
      expect(host.textContent).toContain('Account added. Its saved connection details are available in Settings.');
      expect(host.textContent).toContain('Alex Saved');
      expect(host.textContent).not.toContain('Add account');
      expect(startBodies).toHaveLength(1);
      expect(installPosts).toBe(1);
      expect(storageWrite).not.toHaveBeenCalled();
      expect(storageRemove).not.toHaveBeenCalled();
    } finally { window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); }
  });

  it('disposes an in-flight OAuth request on session replacement and ignores its late result', async () => {
    window.history.replaceState(null, '', '/');
    let resolveStart!: (response: Response) => void;
    let startSignal: AbortSignal | undefined;
    let currentOwner = workspaceId;
    const pendingStart = new Promise<Response>((resolve) => { resolveStart = resolve; });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const owner = currentOwner;
      if (path === '/api/workspace/snapshot') return json(snapshot(owner, owner === workspaceId ? 3 : 4));
      if (path === '/api/credentials') return json(credentials(owner, owner === workspaceId ? 3 : 4));
      if (path === '/api/oauth/availability') return json({ google: true, microsoft: false });
      if (path === '/api/oauth/starts') return json([]);
      if (path === '/api/oauth/google/start' && init?.method === 'POST') { startSignal = init.signal as AbortSignal; return pendingStart; }
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const renderSession = (active: AuthenticatedSession) => <SafeAreaProvider><CloudWorkspaceSession key={`${active.workspaceId}:${active.privacyEpoch}:${active.csrfToken}`} session={active} onLogout={vi.fn()} /></SafeAreaProvider>;
      act(() => root.render(renderSession(session)));
      await flush();
      click('Open settings');
      click('Manage connections');
      await flush();
      click('Connect Google');
      await flush();
      expect(startSignal?.aborted).toBe(false);
      currentOwner = replacementWorkspaceId;
      act(() => root.render(renderSession(replacementSession)));
      await flush();
      expect(startSignal?.aborted).toBe(true);
      resolveStart(json({ kind: 'started', status: stage('authorization_pending'), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=private' }));
      await flush();
      expect(host.textContent).not.toContain('Connection request started');
      expect(host.textContent).not.toContain('start result is uncertain');
      expect(host.textContent).not.toContain('Alex Example');
    } finally { window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); }
  });
});
