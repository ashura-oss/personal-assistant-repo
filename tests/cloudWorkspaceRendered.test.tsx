/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { Account, LocalTask, MailboxSnapshotMessage, Note, Proposal } from '../src/core';
import type { CloudWorkspaceSessionState, CloudWorkspaceVoiceActions } from '../src/web/CloudWorkspaceSession';
import { CloudWorkspace } from '../src/web/CloudWorkspace';
import { CloudWorkspaceSession } from '../src/web/CloudWorkspaceSession';
import AppWeb from '../App.web';
import { ServerRecordingPanel } from '../src/ui/ServerRecordingPanel';
import { WorkspaceDocumentEditor } from '../src/ui/WorkspaceDocumentEditor';
import type { CloudVoiceCoordinatorState, CloudVoicePhase } from '../src/web/cloudVoiceCoordinator';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';
import { WorkspaceClientError } from '../src/web/workspaceClient';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, onPress, onChangeText, style: _style, accessibilityRole: _role, accessibilityState: _state, accessibilityLabel, secureTextEntry, ...props }: Record<string, unknown> & { children?: React.ReactNode; onPress?: () => void; onChangeText?: (value: string) => void; accessibilityLabel?: string; secureTextEntry?: boolean }) => ReactModule.createElement(tag, {
    ...props,
    ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
    ...(secureTextEntry ? { 'data-secure-text-entry': 'true' } : {}),
    ...(onPress ? { onClick: onPress } : {}),
    ...(onChangeText ? { onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.target.value) } : {}),
  }, children);
  const TextInput = ReactModule.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
    const { accessibilityLabel, secureTextEntry, onChangeText, defaultValue, editable, ...rest } = props;
    const tag = secureTextEntry ? 'input' : 'textarea';
    const assignRef = (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (node) Object.assign(node, { clear: () => { node.value = ''; } });
      if (typeof ref === 'function') ref(node);
      else if (ref && typeof ref === 'object') (ref as { current: HTMLElement | null }).current = node;
    };
    return ReactModule.createElement(tag, {
      ...rest,
      ref: assignRef,
      defaultValue,
      disabled: editable === false,
      ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
      ...(secureTextEntry ? { type: 'password' } : {}),
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => (onChangeText as ((value: string) => void) | undefined)?.(event.target.value),
    });
  });
  return { ActivityIndicator: () => ReactModule.createElement('span', null, 'loading'), KeyboardAvoidingView: element('div'), Modal: element('div'), View: element('div'), Text: element('span'), Pressable: element('button'), ScrollView: element('div'), TextInput, Switch: ({ value, disabled, accessibilityLabel, onValueChange }: { value: boolean; disabled?: boolean; accessibilityLabel: string; onValueChange: (value: boolean) => void }) => ReactModule.createElement('input', { type: 'checkbox', checked: value, disabled, 'aria-label': accessibilityLabel, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onValueChange(event.target.checked) }), StyleSheet: { create: (value: unknown) => value }, Platform: { OS: 'web' } };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  const context = ReactModule.createContext(false);
  return {
    SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement(context.Provider, { value: true }, ReactModule.createElement('div', { 'data-safe-area-provider': 'true' }, children)),
    SafeAreaView: ({ children }: { children?: React.ReactNode }) => {
      if (!ReactModule.useContext(context)) throw new Error('SafeAreaView requires its provider ancestor.');
      return ReactModule.createElement('div', { 'data-safe-area-view': 'true' }, children);
    },
  };
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
  const ReactModule = await import('react');
  return { default: ({ name }: { name: string }) => ReactModule.createElement('span', null, name) };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    IconButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    Field: ({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) => ReactModule.createElement('label', null, label, ReactModule.createElement('textarea', { 'aria-label': label, value, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.target.value) })),
  };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00', input: '#111' }, s: new Proxy({}, { get: () => ({}) }) }));

const workspaceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
function credentialMetadata(openrouter = false, speech = false, epoch = 3, owner = workspaceId) {
  return { workspaceId: owner, privacyEpoch: epoch, credentials: {
    speech: { configured: speech, generation: speech ? 1 : 0 },
    openrouter: { configured: openrouter, generation: openrouter ? 1 : 0 },
  } };
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function fixture() {
  const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
  const now = '2026-10-15T00:00:00.000Z';
  state.accounts.push({ id: '22222222-2222-4222-8222-222222222222', provider: 'google', displayName: 'Work account', email: 'work@example.com', connected: true, authStatus: 'connected', identity: { providerNamespace: 'google', subject: 'account-subject' }, capabilities: ['mail.read'], lastSyncedAt: now } satisfies Account);
  state.notes.push({ id: '33333333-3333-4333-8333-333333333333', title: 'A saved DTO note', transcript: 'A saved DTO note', durationSeconds: 0, createdAt: now, status: 'recorded', revision: 1 } satisfies Note);
  state.notes.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Second saved DTO note', transcript: 'Second note original text', durationSeconds: 0, createdAt: now, status: 'recorded', revision: 2 } satisfies Note);
  state.proposals.push({ id: '55555555-5555-4555-8555-555555555555', noteId: '33333333-3333-4333-8333-333333333333', kind: 'email', title: 'A proposal from the snapshot', body: 'Safe display body', status: 'draft', revision: 1, recipients: ['person@example.test'], evidence: [] } satisfies Proposal);
  state.tasks.push({ id: '44444444-4444-4444-8444-444444444444', title: 'Review the draft', body: '', status: 'open', createdAt: now, sourceNoteId: '33333333-3333-4333-8333-333333333333', sourceRevision: 1, proposalId: '55555555-5555-4555-8555-555555555555' } satisfies LocalTask);
  state.assistantChatConversations = [{ id: '77777777-7777-4777-8777-777777777777', title: 'Saved conversation', createdAt: now, updatedAt: now, turns: [] }];
  state.mailbox.push({ id: '66666666-6666-4666-8666-666666666666', accountId: '22222222-2222-4222-8222-222222222222', providerMessageId: 'provider-message', identityKey: 'safe-identity', verifiedIdentityKey: 'safe-identity', connectionGeneration: 0, subject: 'Saved mail snapshot', from: 'sender@example.com', snippet: 'A short saved preview.' } satisfies MailboxSnapshotMessage);
  const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
  const store = {
    getSnapshot: () => stateValue,
    execute: vi.fn(async () => { throw new Error('not used in this render test'); }),
    inspect: vi.fn(async () => { throw new Error('not used in this render test'); }),
    refresh: vi.fn(async () => snapshot),
  };
  const stateValue: CloudWorkspaceSessionState = { status: 'ready', snapshot, busy: false, refreshRequired: false };
  return { snapshot, store, state };
}

function click(label: string) {
  const item = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(label) || button.getAttribute('aria-label') === label || button.getAttribute('accessibilityLabel') === label);
  if (!item) throw new Error(`Button not found: ${label}; rendered=${host.textContent}`);
  act(() => item.click());
}

function clickOccurrence(label: string, occurrence: number) {
  const matches = [...host.querySelectorAll('button')].filter((button) => button.textContent?.includes(label) || button.getAttribute('aria-label') === label || button.getAttribute('accessibilityLabel') === label);
  const item = matches[occurrence];
  if (!item) throw new Error(`Button occurrence not found: ${label} #${occurrence + 1}; rendered=${host.textContent}`);
  act(() => item.click());
}

function clickTwice(label: string) {
  const item = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(label) || button.getAttribute('aria-label') === label || button.getAttribute('accessibilityLabel') === label);
  if (!item) throw new Error(`Button not found: ${label}; rendered=${host.textContent}`);
  act(() => { item.click(); item.click(); });
}

function setTextField(label: string, value: string) {
  const field = host.querySelector(`input[aria-label="${label}"], textarea[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!field) throw new Error(`Field not found: ${label}`);
  const setter = Object.getOwnPropertyDescriptor(field.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => { setter?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); });
}

class UiMediaRecorder {
  static isTypeSupported = () => true;
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly stream: MediaStream) { void stream; }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['recorded audio'], { type: this.mimeType }) } as BlobEvent);
    queueMicrotask(() => this.onstop?.(new Event('stop')));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('CloudWorkspace safe DTO presentation', () => {
  it('mounts the real web entry through StrictMode from guest sign-in to workspace and confirmed logout', async () => {
    const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const guest = { authenticated: false, csrfToken: 'guest-csrf' };
    const signedIn = { authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'session-csrf' };
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/auth/session') return { ok: true, status: 200, json: async () => guest };
      if (path === '/auth/login') return { ok: true, status: 200, json: async () => signedIn };
      if (path === '/auth/logout') return { ok: true, status: 200, json: async () => guest };
      if (path === '/api/credentials') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot') return { ok: true, status: 200, json: async () => snapshot };
      throw new Error(`Unexpected PWA request: ${init?.method ?? 'GET'} ${path}`);
    });
    const storageRead = vi.spyOn(Storage.prototype, 'getItem');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const storageRemove = vi.spyOn(Storage.prototype, 'removeItem');
    vi.stubGlobal('fetch', fetcher);
    await act(async () => { root.render(<React.StrictMode><AppWeb /></React.StrictMode>); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector('[data-safe-area-provider="true"]')).not.toBeNull();
    expect(host.querySelector('input[aria-label="Workspace password"]')).not.toBeNull();
    setTextField('Workspace password', 'private test password');
    await act(async () => { click('Sign in'); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Sign out');
    expect(host.textContent).not.toContain('Workspace password');
    expect(fetcher.mock.calls.some(([path]) => String(path) === '/api/workspace/snapshot')).toBe(true);
    const snapshotReadCount = fetcher.mock.calls.filter(([path]) => String(path) === '/api/workspace/snapshot').length;
    await act(async () => { click('Sign out'); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector('input[aria-label="Workspace password"]')).not.toBeNull();
    expect(fetcher.mock.calls.some(([path]) => String(path) === '/auth/logout')).toBe(true);
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/workspace/snapshot')).toHaveLength(snapshotReadCount);
    expect(storageRead).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
  });

  it('offers an explicit retry after the first workspace snapshot fails', async () => {
    const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const signedIn = { authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'session-csrf' };
    let snapshotReads = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/auth/session') return { ok: true, status: 200, json: async () => signedIn };
      if (path === '/api/credentials') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot') {
        snapshotReads += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (path === '/api/workspace/refresh' && init?.method === 'POST') return { ok: true, status: 200, json: async () => snapshot };
      throw new Error(`Unexpected retry request: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => { root.render(<AppWeb />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Retry workspace');
    expect(snapshotReads).toBe(1);
    await act(async () => { clickTwice('Retry workspace'); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Sign out');
    expect(snapshotReads).toBe(1);
    expect(fetcher.mock.calls.filter(([path, init]) => String(path) === '/api/workspace/refresh' && init?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls.some(([path]) => String(path).startsWith('/api/workspace/commands'))).toBe(false);
  });

  it('keeps session credential service across Settings close and reopen, clears drafts, and sends only one explicit key mutation', async () => {
    const { state } = fixture();
    const requests: { path: string; method: string; body?: string }[] = [];
    let configured = false;
    let credentialReads = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      requests.push({ path, method, ...(init?.body ? { body: String(init.body) } : {}) });
      if (path === '/api/credentials' && method === 'GET') {
        credentialReads += 1;
        return { ok: true, status: 200, json: async () => credentialMetadata(configured, false) };
      }
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') return { ok: true, status: 200, json: async () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 }) };
      if (path === '/api/credentials' && method === 'PUT') {
        configured = true;
        return { ok: true, status: 200, json: async () => credentialMetadata(true, false) };
      }
      throw new Error(`Unexpected credential composition request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={{ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' }} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(credentialReads).toBe(1);
      click('Open settings');
      expect(host.textContent).toContain('OpenRouter · not configured');
      const field = host.querySelector('input[aria-label="OpenRouter API key"]') as HTMLInputElement;
      expect(field.type).toBe('password');
      setTextField('OpenRouter API key', 'explicit-test-key');
      click('Save OpenRouter key');
      expect(field.value).toBe('');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(requests.filter((request) => request.path === '/api/credentials' && request.method === 'PUT')).toHaveLength(1);
      expect(configured).toBe(true);
      expect(requests.some((request) => request.path.includes('/api/assistant') || request.path.includes('/api/transcribe'))).toBe(false);
      expect(host.textContent).toContain('OpenRouter credential saved.');
      click('Close settings');
      click('Open settings');
      expect(credentialReads).toBe(1);
      expect(host.textContent).toContain('OpenRouter · configured');
      setTextField('OpenRouter API key', 'unsent-draft');
      click('Close settings');
      click('Open settings');
      expect((host.querySelector('input[aria-label="OpenRouter API key"]') as HTMLInputElement).value).toBe('');
      expect(credentialReads).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('holds an unknown credential save across Settings close and resolves only the exact receipt plus fresh metadata', async () => {
    const { state } = fixture();
    const requests: { path: string; method: string }[] = [];
    let credentialReads = 0;
    let commandId: string | null = null;
    let mutationCount = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      requests.push({ path, method });
      if (path === '/api/credentials' && method === 'GET') {
        credentialReads += 1;
        return { ok: true, status: 200, json: async () => credentialMetadata(credentialReads > 1, false) };
      }
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') return { ok: true, status: 200, json: async () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 }) };
      if (path === '/api/credentials' && method === 'PUT') {
        mutationCount += 1;
        commandId = new Headers(init?.headers).get('X-Still-Command');
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (path.startsWith('/api/credential-commands/') && method === 'GET') return { ok: true, status: 200, json: async () => ({ status: 'finished' }) };
      throw new Error(`Unexpected credential recovery request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={{ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' }} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Open settings');
      setTextField('OpenRouter API key', 'unknown-outcome-key');
      click('Save OpenRouter key');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commandId).not.toBeNull();
      expect(commandId ?? '').toMatch(/^[0-9a-f-]{36}$/i);
      expect(host.textContent).toContain('Inspect its receipt before making another change.');
      expect(mutationCount).toBe(1);
      click('Close settings');
      click('Open settings');
      expect(host.textContent).toContain('A previous credential change needs an exact receipt check.');
      expect(credentialReads).toBe(1);
      click('Inspect pending credential change');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(requests).toContainEqual({ path: `/api/credential-commands/${commandId}`, method: 'GET' });
      expect(credentialReads).toBe(2);
      expect(host.textContent).toContain('OpenRouter · configured');
      expect(host.querySelector('[aria-label="Inspect pending credential change"]')).toBeNull();
      expect(mutationCount).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('disposes the session credential request on unmount and ignores its late acknowledgement', async () => {
    const { state } = fixture();
    const pendingAck = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const requests: { path: string; method: string }[] = [];
    let putCount = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      requests.push({ path, method });
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') return { ok: true, status: 200, json: async () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 }) };
      if (path === '/api/credentials' && method === 'PUT') { putCount += 1; return pendingAck.promise; }
      throw new Error(`Unexpected unmount credential request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () => { root.render(<CloudWorkspaceSession session={{ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' }} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    click('Open settings');
    setTextField('OpenRouter API key', 'late-ack-key');
    click('Save OpenRouter key');
    expect(putCount).toBe(1);
    const beforeUnmount = requests.length;
    await act(async () => { root.unmount(); await Promise.resolve(); });
    pendingAck.resolve({ ok: true, status: 200, json: async () => credentialMetadata(true) });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(requests).toHaveLength(beforeUnmount);
    expect(putCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it('starts only after explicit choice, survives tab changes, and completes one upload and one note adoption without processing', async () => {
    const { state } = fixture();
    const session = { authenticated: true as const, workspaceId, privacyEpoch: 3, csrfToken: 'csrf-test' };
    const track = { stopped: 0, stop() { this.stopped += 1; } };
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] } as unknown as MediaStream));
    const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('MediaRecorder', UiMediaRecorder);
    const captureRevision = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const mediaId = 'efefefef-efef-4fef-8fef-efefefefefef';
    const commandKinds: string[] = [];
    const requests: { path: string; method: string }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ path, method });
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') {
        return { ok: true, status: 200, json: async () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: state.notes.length > 2 ? 9 : 7 }) };
      }
      if (path === '/api/audio/uploads' && method === 'POST') {
        const headers = new Headers(init?.headers);
        const capture = JSON.parse(headers.get('X-Still-Capture') ?? '{}') as { id: string; capturedAt: string; timeZone: string };
        expect((init?.body as Blob).type).toBe('audio/webm');
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, uploadId: headers.get('X-Still-Upload-ID'), status: 'ready', capture: { ...capture, revision: captureRevision },
          media: { mediaId: `still-media:${mediaId}`, sha256: 'a'.repeat(64), byteLength: 14, durationSeconds: 2, format: 'webm', mimeType: 'audio/webm' } }) };
      }
      if (path === '/api/workspace/commands' && method === 'POST') {
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: { kind: string; captureId: string; captureRevision: string } };
        commandKinds.push(envelope.command.kind);
        expect(envelope.command).toEqual({ kind: 'notes.capture.adopt', captureId: expect.any(String), captureRevision });
        const capturedAt = new Date().toISOString();
        state.notes.push({ id: envelope.command.captureId, title: 'Saved voice capture', transcript: '', durationSeconds: 2, createdAt: capturedAt, status: 'recorded', revision: 1 });
        const savedSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 });
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished',
          receipt: { schemaVersion: 1, commandId: envelope.commandId, kind: 'notes.capture.adopt', objectId: envelope.command.captureId,
            captureId: envelope.command.captureId, captureRevision }, snapshot: savedSnapshot }) };
      }
      throw new Error(`Unexpected UI integration request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={session} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Record');
      expect(getUserMedia).not.toHaveBeenCalled();
      click('Start recording a voice note');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(host.textContent).toContain('Audio stays in temporary browser memory until you explicitly save it to this workspace.');
      click('Library');
      click('Record');
      expect(getUserMedia).toHaveBeenCalledOnce();
      click('Stop and save recording');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(requests.filter((request) => request.path === '/api/audio/uploads' && request.method === 'POST')).toHaveLength(1);
      expect(requests.filter((request) => request.path === '/api/workspace/commands' && request.method === 'POST')).toHaveLength(1);
      expect(commandKinds).toEqual(['notes.capture.adopt']);
      expect(host.textContent).toContain('Your recording is saved.');
      expect(host.textContent).toContain('Open saved note');
      expect(requests.some((request) => request.path.includes('transcribe') || request.path.includes('assistant'))).toBe(false);
      expect(track.stopped).toBe(1);
    } finally {
      if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor);
      else Reflect.deleteProperty(navigator, 'mediaDevices');
      vi.unstubAllGlobals();
    }
  });

  it('uses the shared Record composer and sends one text-note command through the real cloud action', async () => {
    const { snapshot } = fixture();
    const commandId = '88888888-8888-4888-8888-888888888888';
    const objectId = '99999999-9999-4999-8999-999999999999';
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => ({
      schemaVersion: 1, commandId, status: 'finished',
      receipt: { schemaVersion: 1, commandId, kind: command.kind, objectId } as WorkspaceCommandResponse['receipt'],
      snapshot,
    }));
    const store = { getSnapshot: () => ({ status: 'ready', snapshot, busy: false, refreshRequired: false } satisfies CloudWorkspaceSessionState), execute, inspect: vi.fn(), refresh: vi.fn(async () => snapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={store.getSnapshot()} onLogout={vi.fn()} />));
    click('Record');
    click('Write a note instead');
    const editor = host.querySelector('textarea[aria-label="Your note"]');
    expect(editor).not.toBeNull();
    act(() => {
      Object.defineProperty(editor!, 'value', { configurable: true, value: 'Keep this thought' });
      editor!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click('Save note');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ kind: 'notes.save', transcript: 'Keep this thought' });
    expect(host.textContent).toContain('Note saved.');
  });

  it('renders shared NoteDetail and saves each edited transcript against the selected note revision', async () => {
    const { snapshot } = fixture();
    const updateId = '88888888-8888-4888-8888-888888888888';
    const commands: WorkspaceCommand[] = [];
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => {
      commands.push(command);
      return { schemaVersion: 1, commandId: updateId, status: 'finished', receipt: { schemaVersion: 1, commandId: updateId, kind: command.kind, objectId: command.kind === 'notes.updateTranscript' ? command.noteId : 'safe-object' } as WorkspaceCommandResponse['receipt'] };
    });
    const store = { getSnapshot: () => ({ status: 'ready', snapshot, busy: false, refreshRequired: false } satisfies CloudWorkspaceSessionState), execute, inspect: vi.fn(), refresh: vi.fn(async () => snapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={store.getSnapshot()} onLogout={vi.fn()} />));
    click('Library');
    click('Notes');
    click('A saved DTO note');
    expect(host.textContent).toContain('A thought, kept.');
    expect(host.textContent).toContain('SAVED NOTE');
    expect(host.textContent).toContain('Note deletion is not connected to a server command.');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Delete note'))?.disabled).toBe(true);
    expect(host.textContent).toContain('Saving a memory suggestion is not connected to a server command.');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    const editorA = host.querySelector('textarea[aria-label="Transcript"]') as HTMLTextAreaElement;
    act(() => { setter?.call(editorA, 'Edited note A only'); editorA.dispatchEvent(new Event('input', { bubbles: true })); });
    click('Save transcript');
    await act(async () => { await Promise.resolve(); });
    click('Second note original text');
    const editorB = host.querySelector('textarea[aria-label="Transcript"]') as HTMLTextAreaElement;
    expect(editorB?.value).toBe('Second note original text');
    act(() => { setter?.call(editorB, 'Edited note B only'); editorB.dispatchEvent(new Event('input', { bubbles: true })); });
    click('Save transcript');
    await act(async () => { await Promise.resolve(); });
    expect(commands).toEqual([
      { kind: 'notes.updateTranscript', noteId: '33333333-3333-4333-8333-333333333333', text: 'Edited note A only', expectedNoteRevision: 1 },
      { kind: 'notes.updateTranscript', noteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'Edited note B only', expectedNoteRevision: 2 },
    ]);
  });

  it.each([
    ['preview', 'openrouter'],
    ['provider', 'azure'],
  ] as const)('does not queue note assistance in %s mode with %s selected', async (mode, llmProvider) => {
    const { state } = fixture();
    state.settings.mode = mode;
    state.settings.llmProvider = llmProvider;
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const execute = vi.fn(async () => { throw new Error('must remain disabled'); });
    const sessionState = { status: 'ready', snapshot, busy: false, refreshRequired: false } satisfies CloudWorkspaceSessionState;
    const store = { getSnapshot: () => sessionState, execute, inspect: vi.fn(), refresh: vi.fn(async () => snapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    click('Library');
    click('Notes');
    click('A saved DTO note');
    expect(host.textContent).toContain('Enable OpenRouter provider analysis in Settings to queue this note.');
    const assist = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Assist with this note'));
    expect(assist?.disabled).toBe(true);
    if (assist) act(() => assist.click());
    await act(async () => { await Promise.resolve(); });
    expect(execute).not.toHaveBeenCalled();
  });

  it('queues the selected assistance intent only for provider-mode OpenRouter and rechecks current settings before dispatch', async () => {
    const { state } = fixture();
    state.settings.mode = 'provider';
    state.settings.llmProvider = 'openrouter';
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const commandId = '88888888-8888-4888-8888-888888888888';
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => ({
      schemaVersion: 1, commandId, status: 'finished',
      receipt: { schemaVersion: 1, commandId, kind: command.kind, objectId: '33333333-3333-4333-8333-333333333333', jobId: '99999999-9999-4999-8999-999999999999' } as WorkspaceCommandResponse['receipt'],
    }));
    const sessionState = { status: 'ready', snapshot, busy: false, refreshRequired: false } satisfies CloudWorkspaceSessionState;
    const store = { getSnapshot: () => sessionState, execute, inspect: vi.fn(), refresh: vi.fn(async () => snapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    click('Library');
    click('Notes');
    click('A saved DTO note');
    click('Show assistance options');
    click('Summarize');
    click('Assist with this note');
    await act(async () => { await Promise.resolve(); });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ kind: 'assistant.batch.submitNote', noteId: '33333333-3333-4333-8333-333333333333', intent: 'summarize' });

    const latestState = createWorkspaceSnapshotDTO({ getSnapshot: () => {
      state.settings.mode = 'provider';
      state.settings.llmProvider = 'azure';
      return state;
    } }, { workspaceId, privacyEpoch: 3, revision: 8 });
    const staleGuardExecute = vi.fn(async () => { throw new Error('must not dispatch under changed settings'); });
    const changingStore = { getSnapshot: () => ({ ...sessionState, snapshot: latestState }), execute: staleGuardExecute, inspect: vi.fn(), refresh: vi.fn(async () => latestState) };
    act(() => root.render(<CloudWorkspace store={changingStore} state={sessionState} onLogout={vi.fn()} />));
    click('Library');
    click('Notes');
    click('A saved DTO note');
    click('Assist with this note');
    await act(async () => { await Promise.resolve(); });
    expect(staleGuardExecute).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Enable OpenRouter provider analysis in Settings to queue this note.');
  });

  it('renders validated connection, mail, note, and task display data without native credentials or audio paths', () => {
    const { snapshot, store } = fixture();
    act(() => root.render(<CloudWorkspace store={store} state={{ status: 'ready', snapshot, busy: false, refreshRequired: false }} onLogout={vi.fn()} />));
    click('Open settings');
    expect(host.textContent).toContain('Work account');
    expect(host.textContent).toContain('Credentials not configured');
    expect(host.textContent).not.toContain('tokenRef');
    click('Close settings');
    click('Library');
    click('Notes');
    expect(host.textContent).toContain('A saved DTO note');
    click('Record');
    expect(host.textContent).toContain('Make space');
    expect(host.textContent).toContain('Browser audio capture is not connected to the server workspace.');
    expect(host.textContent).toContain('A saved DTO note');
    expect(host.textContent).not.toContain('Your recording is saved locally');
    click('Library');
    expect(host.textContent).toContain('Review the draft');
    click('Inbox');
    expect(host.textContent).toContain('Review, when ready.');
    expect(host.textContent).toContain('A proposal from the snapshot');
    expect(host.textContent).toContain('Proposal review actions are not connected to the server workspace yet.');
    expect(host.textContent).toContain('Saved mail snapshot');
    expect(host.textContent).toContain('A short saved preview.');
    const reply = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Reply'));
    expect(reply?.disabled).toBe(true);
    expect(host.textContent).toContain('Mail reply actions are not connected to the server workspace yet.');
  });

  it('keeps server settings and reported usage values display-only in the shared settings surface', () => {
    const { snapshot, store } = fixture();
    act(() => root.render(<CloudWorkspace store={store} state={{ status: 'ready', snapshot, busy: false, refreshRequired: false }} onLogout={vi.fn()} />));
    click('Open settings');
    expect(host.textContent).toContain(snapshot.state.settings.timezone);
    expect(host.textContent).toContain(`${snapshot.state.usage.inputTokens} input tokens`);
    expect(host.textContent).toContain('Provider-reported token counts are not billing estimates.');
    expect(store.execute).not.toHaveBeenCalled();
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Save provider and recording settings'))?.disabled).toBe(false);
  });

  it('shows complete safe status panels and explains unavailable settings actions', () => {
    const { snapshot, store } = fixture();
    act(() => root.render(<CloudWorkspace store={store} state={{ status: 'ready', snapshot, busy: false, refreshRequired: false }} onLogout={vi.fn()} />));
    click('Open settings');
    expect(host.textContent).toContain('Attention and reminders');
    expect(host.textContent).toContain('Knowledge, documents, and backups');
    expect(host.textContent).toContain('Device calendars');
    expect(host.textContent).toContain('Saving explicitly switches new text requests to OpenRouter Batch.');
    expect(host.textContent).toContain('Connection setup, sync, and mail actions are unavailable until matching server actions are available.');
    expect(store.execute).not.toHaveBeenCalled();
  });

  it('edits the controlled settings draft and sends one closed settings command with the fixed profile fields', async () => {
    const { state } = fixture();
    const initialSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    let latestSnapshot = initialSnapshot;
    const sessionState: CloudWorkspaceSessionState = { status: 'ready', snapshot: latestSnapshot, busy: false, refreshRequired: false };
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => {
      expect(command.kind).toBe('settings.update');
      if (command.kind !== 'settings.update') throw new Error('unexpected command');
      state.settings.mode = command.patch.mode ?? state.settings.mode;
      state.settings.llmProvider = 'openrouter';
      state.settings.openRouterModel = 'openai/gpt-6-luna:batch';
      state.settings.llmRequestContractVersion = 1;
      state.settings.openRouterReasoningEffort = command.patch.openRouterReasoningEffort ?? state.settings.openRouterReasoningEffort;
      state.settings.speechEnabled = command.patch.speechEnabled ?? state.settings.speechEnabled;
      state.settings.speechProvider = command.patch.speechProvider ?? state.settings.speechProvider;
      state.settings.speechEndpoint = command.patch.speechEndpoint ?? state.settings.speechEndpoint;
      state.settings.maxAudioSeconds = command.patch.maxAudioSeconds ?? state.settings.maxAudioSeconds;
      state.settings.audioRetention = command.patch.audioRetention ?? state.settings.audioRetention;
      latestSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 });
      (sessionState as { snapshot: typeof latestSnapshot }).snapshot = latestSnapshot;
      const commandId = '88888888-8888-4888-8888-888888888888';
      return { schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId, kind: 'settings.update', objectId: 'workspace-settings' }, snapshot: latestSnapshot };
    });
    const store = { getSnapshot: () => sessionState, execute, inspect: vi.fn(), refresh: vi.fn(async () => latestSnapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    click('Open settings');
    const providerToggle = host.querySelector('input[aria-label="Enable provider analysis"]') as HTMLInputElement;
    act(() => { providerToggle.click(); });
    click('none');
    setTextField('Maximum recording length · seconds', '240');
    click('Save provider and recording settings');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ kind: 'settings.update', patch: {
      mode: 'provider', speechEnabled: state.settings.speechEnabled, speechProvider: state.settings.speechProvider ?? 'azure',
      speechEndpoint: state.settings.speechEndpoint ?? '', openRouterReasoningEffort: 'none', maxAudioSeconds: 240, audioRetention: state.settings.audioRetention,
    } });
    expect(host.textContent).toContain('Settings saved.');
    expect(host.textContent).toContain('Mode · provider');
  });

  it('rejects an out-of-range recording duration before sending any settings command', async () => {
    const { snapshot, store } = fixture();
    act(() => root.render(<CloudWorkspace store={store} state={{ status: 'ready', snapshot, busy: false, refreshRequired: false }} onLogout={vi.fn()} />));
    click('Open settings');
    setTextField('Maximum recording length · seconds', '9');
    click('Save provider and recording settings');
    await act(async () => { await Promise.resolve(); });
    expect(store.execute).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Maximum recording length must be a whole number from 10 to 600 seconds.');
    expect((host.querySelector('textarea[aria-label="Maximum recording length · seconds"]') as HTMLTextAreaElement).value).toBe('9');
  });

  it('blocks saving when an editable setting changed elsewhere and only replaces the draft after explicit reload', async () => {
    const { state } = fixture();
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    let latestSnapshot = snapshot;
    const sessionState: CloudWorkspaceSessionState = { status: 'ready', snapshot, busy: false, refreshRequired: false };
    const execute = vi.fn();
    const refresh = vi.fn().mockRejectedValueOnce(new Error('network unavailable')).mockImplementation(async () => latestSnapshot);
    const store = { getSnapshot: () => ({ ...sessionState, snapshot: latestSnapshot }), execute, inspect: vi.fn(), refresh };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    click('Open settings');
    setTextField('Speech endpoint', 'https://draft.example.com');
    state.settings.speechEndpoint = 'https://saved.example.com';
    latestSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 });
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    expect(host.textContent).toContain('Saved settings changed after this form opened. Reload them before making another change.');
    expect((host.querySelector('textarea[aria-label="Speech endpoint"]') as HTMLTextAreaElement).value).toBe('https://draft.example.com');
    click('Save provider and recording settings');
    expect(execute).not.toHaveBeenCalled();
    click('Reload saved settings');
    await act(async () => { await Promise.resolve(); });
    expect((host.querySelector('textarea[aria-label="Speech endpoint"]') as HTMLTextAreaElement).value).toBe('https://draft.example.com');
    expect(refresh).toHaveBeenCalledOnce();
    click('Reload saved settings');
    await act(async () => { await Promise.resolve(); });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect((host.querySelector('textarea[aria-label="Speech endpoint"]') as HTMLTextAreaElement).value).toBe('https://saved.example.com');
    expect(host.textContent).toContain('Loaded the saved workspace settings.');
  });

  it('suppresses a rejected save error when the live workspace privacy epoch changes while the form stays open', async () => {
    const { state } = fixture();
    const initialSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    let latestSnapshot = initialSnapshot;
    let sessionState: CloudWorkspaceSessionState = { status: 'ready', snapshot: latestSnapshot, busy: false, refreshRequired: false };
    const pendingSave = deferred<WorkspaceCommandResponse>();
    const execute = vi.fn(() => pendingSave.promise);
    const store = { getSnapshot: () => sessionState, execute, inspect: vi.fn(), refresh: vi.fn(async () => latestSnapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    click('Open settings');
    setTextField('Speech endpoint', 'https://draft.example.com');
    click('Save provider and recording settings');

    latestSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 4, revision: 8 });
    sessionState = { ...sessionState, snapshot: latestSnapshot };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    await act(async () => { pendingSave.reject(new WorkspaceClientError('network', 'The workspace connection was interrupted.')); await pendingSave.promise.catch(() => undefined); });

    expect(host.textContent).not.toContain('The workspace connection was interrupted.');
    expect(host.textContent).toContain('Saved settings changed after this form opened. Reload them before making another change.');
    expect((host.querySelector('textarea[aria-label="Speech endpoint"]') as HTMLTextAreaElement).value).toBe('https://draft.example.com');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('suppresses a rejected settings reload error when the live workspace privacy epoch changes', async () => {
    const { state } = fixture();
    const initialSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    let latestSnapshot = initialSnapshot;
    let sessionState: CloudWorkspaceSessionState = { status: 'ready', snapshot: latestSnapshot, busy: false, refreshRequired: false };
    const pendingReload = deferred<typeof initialSnapshot>();
    const refresh = vi.fn(() => pendingReload.promise);
    const store = { getSnapshot: () => sessionState, execute: vi.fn(), inspect: vi.fn(), refresh };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    click('Open settings');
    setTextField('Speech endpoint', 'https://draft.example.com');
    state.settings.speechEndpoint = 'https://remote.example.com';
    latestSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 });
    sessionState = { ...sessionState, snapshot: latestSnapshot };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    click('Reload saved settings');

    latestSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 4, revision: 9 });
    sessionState = { ...sessionState, snapshot: latestSnapshot };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    await act(async () => { pendingReload.reject(new WorkspaceClientError('network', 'The workspace connection was interrupted.')); await pendingReload.promise.catch(() => undefined); });

    expect(refresh).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain('The workspace connection was interrupted.');
    expect(host.textContent).toContain('Saved settings changed after this form opened. Reload them before making another change.');
    expect((host.querySelector('textarea[aria-label="Speech endpoint"]') as HTMLTextAreaElement).value).toBe('https://draft.example.com');
  });

  it('does not optimistically change displayed settings when a finished receipt has no snapshot', async () => {
    const { snapshot } = fixture();
    const commandId = '88888888-8888-4888-8888-888888888888';
    const execute = vi.fn(async (): Promise<WorkspaceCommandResponse> => ({ schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId, kind: 'settings.update', objectId: 'workspace-settings' } }));
    const store = { getSnapshot: () => ({ status: 'ready', snapshot, busy: false, refreshRequired: false } satisfies CloudWorkspaceSessionState), execute, inspect: vi.fn(), refresh: vi.fn(async () => snapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={store.getSnapshot()} onLogout={vi.fn()} />));
    click('Open settings');
    click('Save provider and recording settings');
    await act(async () => { await Promise.resolve(); });
    expect(execute).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Settings were saved. Reload the saved settings to load the confirmed values.');
    expect(host.textContent).toContain('Mode · preview');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Save provider and recording settings'))?.disabled).toBe(true);
    click('Save provider and recording settings');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('holds a settings command after a lost acknowledgement and offers exact inspection without resubmitting', async () => {
    const { snapshot } = fixture();
    const commandId = '88888888-8888-4888-8888-888888888888';
    let sessionState: CloudWorkspaceSessionState = { status: 'ready', snapshot, busy: false, refreshRequired: false };
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => {
      sessionState = { ...sessionState, pendingCommand: { commandId, kind: command.kind } };
      throw new WorkspaceClientError('network', 'The workspace connection was interrupted.');
    });
    const inspect = vi.fn(async (id: string): Promise<WorkspaceCommandResponse> => ({
      schemaVersion: 1, commandId: id, status: 'finished',
      receipt: { schemaVersion: 1, commandId: id, kind: 'settings.update', objectId: 'workspace-settings' },
    }));
    const store = { getSnapshot: () => sessionState, execute, inspect, refresh: vi.fn(async () => snapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    click('Open settings');
    click('Save provider and recording settings');
    await act(async () => { await Promise.resolve(); });
    expect(execute).toHaveBeenCalledOnce();
    act(() => root.render(<CloudWorkspace store={store} state={sessionState} onLogout={vi.fn()} />));
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Save provider and recording settings'))?.disabled).toBe(true);
    click('Inspect exact settings.update command');
    await act(async () => { await Promise.resolve(); });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(commandId);
    expect(execute).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('The exact settings.update receipt is confirmed.');
  });

  it('filters Cloud notes with the shared Library search and restores them when cleared', () => {
    const { snapshot, store } = fixture();
    act(() => root.render(<CloudWorkspace store={store} state={{ status: 'ready', snapshot, busy: false, refreshRequired: false }} onLogout={vi.fn()} />));
    click('Library');
    click('Notes');
    expect(host.textContent).toContain('A saved DTO note');
    const search = host.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => { setter?.call(search, 'Second'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.textContent).toContain('Second note original text');
    expect(host.textContent).not.toContain('A saved DTO note');
    act(() => { setter?.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.textContent).toContain('A saved DTO note');
  });

  it.each(['complete', 'reopen'] as const)('keeps a task visible and reports a failed %s request without an unhandled rejection', async (operation) => {
    const { snapshot, state } = fixture();
    if (operation === 'reopen') state.tasks[0]!.status = 'completed';
    const currentSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const execute = vi.fn(async () => { throw new Error('network unavailable'); });
    const store = { getSnapshot: () => ({ status: 'ready', snapshot: currentSnapshot, busy: false, refreshRequired: false } satisfies CloudWorkspaceSessionState), execute, inspect: vi.fn(), refresh: vi.fn(async () => currentSnapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={{ status: 'ready', snapshot: currentSnapshot, busy: false, refreshRequired: false }} onLogout={vi.fn()} />));
    click('Library');
    click('Notes');
    if (operation === 'reopen') click('Completed tasks');
    const taskButton = operation === 'complete' ? 'Complete Review the draft' : 'Reopen Review the draft';
    click(taskButton);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ kind: operation === 'complete' ? 'tasks.complete' : 'tasks.reopen', taskId: '44444444-4444-4444-8444-444444444444' });
    expect(host.textContent).toContain('The workspace action could not be confirmed.');
    expect(host.textContent).toContain('Review the draft');
    expect(snapshot.state.tasks[0]?.status).toBe('open');
  });

  it('keeps unavailable reminders disabled while enabling the server-backed People editor', () => {
    const { snapshot, store } = fixture();
    act(() => root.render(<CloudWorkspace store={store} state={{ status: 'ready', snapshot, busy: false, refreshRequired: false }} onLogout={vi.fn()} />));
    click('Library');
    click('Reminders');
    expect(host.textContent).toContain('Reminder creation and management are not connected to server commands yet.');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Add reminder'))?.disabled).toBe(true);
    click('People');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Add person'))?.disabled).toBe(false);
    expect(store.execute).not.toHaveBeenCalled();
  });

  it.each(['tasks.complete', 'tasks.reopen', 'chat.create', 'notes.save', 'notes.capture.adopt', 'notes.updateTranscript', 'assistant.batch.submitNote', 'assistant.batch.check', 'chat.submit', 'chat.refine'] as const)(
    'offers exact receipt inspection for a pending %s command without resending it', async (kind) => {
      const { snapshot } = fixture();
      const commandId = '88888888-8888-4888-8888-888888888888';
      const store = {
        getSnapshot: () => ({ status: 'ready', snapshot, busy: false, refreshRequired: true, pendingCommand: { commandId, kind } } satisfies CloudWorkspaceSessionState),
        execute: vi.fn(async () => { throw new Error('must not resend'); }),
        inspect: vi.fn(async (id: string) => ({ schemaVersion: 1 as const, commandId: id, status: 'finished' as const, receipt: { schemaVersion: 1 as const, commandId: id, kind, objectId: 'safe-object' } as never })),
        refresh: vi.fn(async () => snapshot),
      };
      act(() => root.render(<CloudWorkspace store={store} state={store.getSnapshot()} onLogout={vi.fn()} />));
      click(`Inspect exact ${kind} command`);
      await act(async () => { await Promise.resolve(); });
      expect(store.inspect).toHaveBeenCalledExactlyOnceWith(commandId);
      expect(store.execute).not.toHaveBeenCalled();
      expect(host.textContent).toContain(kind === 'chat.submit'
        ? 'The exact chat receipt is confirmed.'
        : `The exact ${kind} receipt is confirmed.`);
    },
  );

  it('keeps an unknown Chat submission held across workspace refresh, then accepts only its exact original receipt', async () => {
    const { snapshot } = fixture();
    const calls: { path: string; init?: RequestInit }[] = [];
    let admitted: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === '/api/credentials' && (init?.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path.endsWith('/api/workspace/snapshot') || path.endsWith('/api/workspace/refresh')) {
        return { ok: true, status: 200, json: async () => snapshot };
      }
      if (path.endsWith('/api/workspace/commands') && init?.method === 'POST') {
        admitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (path.includes('/api/workspace/commands/')) {
        const command = admitted?.command as Record<string, unknown> | undefined;
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: admitted?.commandId, status: 'finished', receipt: { schemaVersion: 1, commandId: admitted?.commandId, kind: 'chat.submit', objectId: command?.conversationId, turnId: '99999999-9999-4999-8999-999999999999', jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }) };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const session = { authenticated: true as const, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' };
    const onLogout = vi.fn();
    act(() => root.render(<CloudWorkspaceSession session={session} onLogout={onLogout} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    click('Chat');
    click('Saved conversation');
    const input = host.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => { setter?.call(input, 'Original unknown message'); input?.dispatchEvent(new Event('change', { bubbles: true })); });
    click('Send');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Your original draft and context are held here.');
    expect(fetcher.mock.calls.filter(([path, init]) => String(path).endsWith('/api/workspace/commands') && init?.method === 'POST')).toHaveLength(1);

    click('Refresh workspace');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('This exact message may already have been accepted.');
    expect(host.textContent).toContain('Original unknown message');
    expect(host.textContent).toContain('Inspect this exact request');
    expect(fetcher.mock.calls.filter(([path, init]) => String(path).endsWith('/api/workspace/commands') && init?.method === 'POST')).toHaveLength(1);

    click('Inspect exact chat.submit command');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('This exact message may already have been accepted.');
    expect(host.textContent).toContain('Original unknown message');
    expect(host.textContent).toContain('Open Chat to inspect the original message and context');

    click('Check submission status');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).not.toContain('This exact message may already have been accepted.');
    expect((host.querySelector('textarea') as HTMLTextAreaElement | null)?.value).toBe('');
    expect(fetcher.mock.calls.filter(([path, init]) => String(path).endsWith('/api/workspace/commands') && init?.method === 'POST')).toHaveLength(1);
    expect(calls.some(({ path }) => path === `/api/workspace/commands/${String(admitted?.commandId)}`)).toBe(true);
    const requestCountBeforeLogout = fetcher.mock.calls.length;
    click('Sign out');
    expect(onLogout).toHaveBeenCalledExactlyOnceWith();
    expect(fetcher.mock.calls).toHaveLength(requestCountBeforeLogout);
    vi.unstubAllGlobals();
  });

  it('holds an unknown recording upload for exact inspection and waits for an explicit save choice', async () => {
    const { state } = fixture();
    const session = { authenticated: true as const, workspaceId, privacyEpoch: 3, csrfToken: 'csrf-test' };
    const track = { stopped: 0, stop() { this.stopped += 1; } };
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] } as unknown as MediaStream));
    const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('MediaRecorder', UiMediaRecorder);
    const captureRevision = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const mediaId = 'efefefef-efef-4fef-8fef-efefefefefef';
    let uploadId: string | undefined;
    let capture: { id: string; capturedAt: string; timeZone: string } | undefined;
    let commandEnvelope: { commandId: string; command: { kind: string; captureId: string; captureRevision: string } } | undefined;
    const requests: { path: string; method: string }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET'; requests.push({ path, method });
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') return { ok: true, status: 200, json: async () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 }) };
      if (path === '/api/audio/uploads' && method === 'POST') {
        const headers = new Headers(init?.headers);
        uploadId = headers.get('X-Still-Upload-ID') ?? undefined;
        capture = JSON.parse(headers.get('X-Still-Capture') ?? '{}') as typeof capture;
        expect(uploadId).toMatch(/^[0-9a-f-]{36}$/i);
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (uploadId && path === `/api/audio/uploads/${uploadId}` && method === 'GET') return { ok: true, status: 200, json: async () => ({
        schemaVersion: 1, uploadId, status: 'ready', capture: { ...capture, revision: captureRevision },
        media: { mediaId: `still-media:${mediaId}`, sha256: 'a'.repeat(64), byteLength: 14, durationSeconds: 2, format: 'webm', mimeType: 'audio/webm' },
      }) };
      if (path === '/api/workspace/commands' && method === 'POST') {
        commandEnvelope = JSON.parse(String(init?.body)) as typeof commandEnvelope;
        if (commandEnvelope?.command.kind !== 'notes.capture.adopt') throw new Error('Only explicit save should adopt this capture.');
        state.notes.push({ id: commandEnvelope.command.captureId, title: 'Saved voice capture', transcript: '', durationSeconds: 2, createdAt: capture?.capturedAt ?? new Date().toISOString(), status: 'recorded', revision: 1 });
        const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 });
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: commandEnvelope?.commandId, status: 'finished',
          receipt: { schemaVersion: 1, commandId: commandEnvelope?.commandId, kind: 'notes.capture.adopt', objectId: commandEnvelope?.command.captureId,
            captureId: commandEnvelope?.command.captureId, captureRevision }, snapshot }) };
      }
      throw new Error(`Unexpected upload integration request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={session} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Record');
      expect(getUserMedia).not.toHaveBeenCalled();
      clickTwice('Start recording a voice note');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(getUserMedia).toHaveBeenCalledOnce();
      clickTwice('Stop and save recording');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Check the original upload.');
      expect(requests.filter((request) => request.path === '/api/audio/uploads' && request.method === 'POST')).toHaveLength(1);
      expect(requests.filter((request) => request.path === '/api/workspace/commands' && request.method === 'POST')).toHaveLength(0);

      click('Inspect exact upload');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Save this recording to notes?');
      expect(requests.filter((request) => request.path === `/api/audio/uploads/${uploadId}` && request.method === 'GET')).toHaveLength(1);
      expect(requests.filter((request) => request.path === '/api/audio/uploads' && request.method === 'POST')).toHaveLength(1);
      expect(requests.filter((request) => request.path === '/api/workspace/commands' && request.method === 'POST')).toHaveLength(0);

      click('Save recording to notes');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Your recording is saved.');
      expect(requests.filter((request) => request.path === '/api/audio/uploads' && request.method === 'POST')).toHaveLength(1);
      expect(requests.filter((request) => request.path === '/api/workspace/commands' && request.method === 'POST')).toHaveLength(1);
      expect(commandEnvelope?.command.kind).toBe('notes.capture.adopt');
      expect(track.stopped).toBe(1);
    } finally {
      if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor);
      else Reflect.deleteProperty(navigator, 'mediaDevices');
      vi.unstubAllGlobals();
    }
  });

  it('requires an explicit history read, separates ready inspection from saving, and inspects a consumed upload command without re-adopting', async () => {
    const { state } = fixture();
    const readyUploadId = 'abababab-abab-4bab-8bab-abababababab';
    const readyCaptureId = 'acacacac-acac-4cac-8cac-acacacacacac';
    const readyRevision = 'adadadad-adad-4dad-8dad-adadadadadad';
    const consumedUploadId = 'babababa-baba-4bab-8bab-babababababa';
    const consumedCaptureId = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
    const consumedRevision = 'bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd';
    const consumedCommandId = 'cececece-cece-4ece-8ece-cececececece';
    const mediaId = 'dededede-dede-4ede-8ede-dededededede';
    const createdAt = '2026-10-15T01:02:03.000Z';
    const requests: { path: string; method: string }[] = [];
    let adoptionPosts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET'; requests.push({ path, method });
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') return { ok: true, status: 200, json: async () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: state.notes.length > 2 ? 8 : 7 }) };
      if (path === '/api/audio/upload-history' && method === 'GET') return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, entries: [
        { uploadId: readyUploadId, capture: { id: readyCaptureId, revision: readyRevision, capturedAt: createdAt, timeZone: 'UTC' }, status: 'ready', createdAt: Date.parse(createdAt), updatedAt: Date.parse(createdAt) },
        { uploadId: consumedUploadId, capture: { id: consumedCaptureId, revision: consumedRevision, capturedAt: createdAt, timeZone: 'UTC' }, status: 'consumed', createdAt: Date.parse(createdAt), updatedAt: Date.parse(createdAt) },
      ] }) };
      if (path === `/api/audio/uploads/${readyUploadId}` && method === 'GET') return { ok: true, status: 200, json: async () => ({
        schemaVersion: 1, uploadId: readyUploadId, status: 'ready', capture: { id: readyCaptureId, revision: readyRevision, capturedAt: createdAt, timeZone: 'UTC' },
        media: { mediaId: `still-media:${mediaId}`, sha256: 'a'.repeat(64), byteLength: 14, durationSeconds: 2, format: 'webm', mimeType: 'audio/webm' },
      }) };
      if (path === `/api/audio/uploads/${consumedUploadId}` && method === 'GET') return { ok: true, status: 200, json: async () => ({
        schemaVersion: 1, uploadId: consumedUploadId, status: 'consumed', capture: { id: consumedCaptureId, revision: consumedRevision, capturedAt: createdAt, timeZone: 'UTC' },
        consumption: { commandId: consumedCommandId, noteId: consumedCaptureId, noteRevision: 1 },
        media: { mediaId: `still-media:${mediaId}`, sha256: 'b'.repeat(64), byteLength: 14, durationSeconds: 2, format: 'webm', mimeType: 'audio/webm' },
      }) };
      if (path === '/api/workspace/commands' && method === 'POST') {
        adoptionPosts += 1;
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: { kind: string; captureId: string; captureRevision: string } };
        expect(envelope.command).toEqual({ kind: 'notes.capture.adopt', captureId: readyCaptureId, captureRevision: readyRevision });
        state.notes.push({ id: readyCaptureId, title: 'Saved ready upload', transcript: '', durationSeconds: 2, createdAt, status: 'recorded', revision: 1 });
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished',
          receipt: { schemaVersion: 1, commandId: envelope.commandId, kind: 'notes.capture.adopt', objectId: readyCaptureId,
            captureId: readyCaptureId, captureRevision: readyRevision }, snapshot: createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 }) }) };
      }
      if (path === `/api/workspace/commands/${consumedCommandId}` && method === 'GET') return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: consumedCommandId, status: 'finished',
        receipt: { schemaVersion: 1, commandId: consumedCommandId, kind: 'notes.capture.adopt', objectId: consumedCaptureId,
          captureId: consumedCaptureId, captureRevision: consumedRevision } }) };
      throw new Error(`Unexpected history integration request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={{ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' }} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Record');
      expect(requests.some((request) => request.path === '/api/audio/upload-history')).toBe(false);
      click('View saved recording history');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(requests.filter((request) => request.path === '/api/audio/upload-history' && request.method === 'GET')).toHaveLength(1);
      expect(host.textContent).toContain('Saved recording history');
      expect(host.textContent).toContain(new Date(createdAt).toLocaleString(undefined, { timeZone: 'UTC' }));
      clickOccurrence('Inspect this saved recording', 0);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Save this recording to notes?');
      expect(adoptionPosts).toBe(0);
      click('Save recording to notes');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Your recording is saved.');
      expect(adoptionPosts).toBe(1);
      click('Record another');
      clickOccurrence('Inspect this saved recording', 1);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Your recording is saved.');
      expect(requests.filter((request) => request.path === `/api/audio/uploads/${consumedUploadId}` && request.method === 'GET')).toHaveLength(1);
      expect(requests.filter((request) => request.path === `/api/workspace/commands/${consumedCommandId}` && request.method === 'GET')).toHaveLength(1);
      expect(adoptionPosts).toBe(1);
      expect(requests.filter((request) => request.path === '/api/audio/uploads' && request.method === 'POST')).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps the exact live transcription parent cancellable while its command request is pending and does not clear it on acknowledgement', async () => {
    const { state } = fixture();
    state.settings.speechEnabled = true;
    state.notes[0]!.audioUri = 'file:///private/native-recording.m4a';
    const mediaId = 'edededed-eded-4ded-8ded-edededededed';
    const commandResponse = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const cancellationResponse = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    let admitted: { commandId: string; command: WorkspaceCommand } | undefined;
    let commandId: string | undefined;
    const cancellationCalls: { path: string; body?: string }[] = [];
    const originalCreateElement = document.createElement;
    const silentAudio = { preload: '', src: '', play: vi.fn(async () => undefined), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn() };
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => tagName.toLowerCase() === 'audio'
      ? silentAudio as unknown as HTMLAudioElement
      : originalCreateElement.call(document, tagName, options)) as typeof document.createElement;
    const snapshot = () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 }, { resolveMediaId: () => mediaId });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/credentials' && (init?.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') return { ok: true, status: 200, json: async () => snapshot() };
      if (path === '/api/workspace/commands' && init?.method === 'POST') {
        admitted = JSON.parse(String(init.body)) as typeof admitted;
        commandId = admitted?.commandId;
        return commandResponse.promise;
      }
      if (commandId && path === `/api/workspace/commands/${commandId}/cancel-transcription` && init?.method === 'POST') {
        cancellationCalls.push({ path, body: String(init.body) });
        return cancellationResponse.promise;
      }
      throw new Error(`Unexpected cancellation request: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={{ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' }} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Library');
      click('Notes');
      click('A saved DTO note');
      click('Replace transcript');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(admitted?.command).toEqual({ kind: 'notes.transcribe', noteId: '33333333-3333-4333-8333-333333333333', expectedNoteRevision: 1 });
      expect(host.textContent).toContain('Cancel transcription request');
      expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Library'))?.disabled).toBe(true);
      expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Cancel transcription request'))?.disabled).toBe(false);
      clickTwice('Cancel transcription request');
      expect(cancellationCalls).toEqual([{ path: `/api/workspace/commands/${commandId}/cancel-transcription`, body: '{}' }]);
      cancellationResponse.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId, status: 'cancellation_requested' }) });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Cancellation was requested for this transcription. The final command receipt is still pending.');
      expect(host.textContent).toContain('Cancel transcription request');
      expect(admitted?.commandId).toBe(commandId);

      commandResponse.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId, status: 'claimed' }) });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Cancel transcription request');
      expect(cancellationCalls).toHaveLength(1);
      expect(fetcher.mock.calls.filter(([path, init]) => String(path) === '/api/workspace/commands' && init?.method === 'POST')).toHaveLength(1);
    } finally { document.createElement = originalCreateElement; vi.unstubAllGlobals(); }
  });

  it('plays only the selected validated media URL, lets pause cancel a pending play, and releases audio when hidden', async () => {
    const { state } = fixture();
    state.notes[0]!.audioUri = 'file:///private/native-recording.m4a';
    const mediaId = 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1';
    const resolver = { resolveMediaId: () => mediaId };
    const snapshot = () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 }, resolver);
    const playPending = deferred<void>();
    const makeAudio = (play: () => Promise<void>) => {
      const listeners = new Map<string, Set<EventListener>>();
      const audio = {
        preload: '', src: '', play: vi.fn(play), pause: vi.fn(), load: vi.fn(),
        removeAttribute: vi.fn((name: string) => { if (name === 'src') audio.src = ''; }),
        addEventListener: vi.fn((type: string, listener: EventListener) => { const set = listeners.get(type) ?? new Set<EventListener>(); set.add(listener); listeners.set(type, set); }),
        removeEventListener: vi.fn((type: string, listener: EventListener) => listeners.get(type)?.delete(listener)),
        dispatch(type: string) { for (const listener of listeners.get(type) ?? []) listener(new Event(type)); },
      };
      return audio;
    };
    const firstAudio = makeAudio(() => playPending.promise);
    const secondAudio = makeAudio(async () => undefined);
    const thirdAudio = makeAudio(async () => undefined);
    const audioElements = [firstAudio, secondAudio, thirdAudio];
    const originalCreateElement = document.createElement;
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => tagName.toLowerCase() === 'audio'
      ? audioElements.shift() as unknown as HTMLAudioElement
      : originalCreateElement.call(document, tagName, options)) as typeof document.createElement;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/api/credentials') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') return { ok: true, status: 200, json: async () => snapshot() };
      throw new Error(`Playback must not create unrelated requests: ${path}`);
    }));
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={{ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' }} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Library'); click('Notes'); click('A saved DTO note');
      click('Play recording');
      expect(firstAudio.src).toBe(`/api/audio/${mediaId}`);
      expect(firstAudio.play).toHaveBeenCalledOnce();
      expect(host.textContent).toContain('Playback · ready');
      const pause = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Pause recording'));
      expect(pause?.disabled).toBe(false);
      click('Pause recording');
      expect(firstAudio.pause).toHaveBeenCalledOnce();
      await act(async () => { playPending.resolve(); await Promise.resolve(); });
      expect(host.textContent).toContain('Playback · paused');
      expect(host.textContent).not.toContain('Playback · playing');

      click('Inbox tab');
      await act(async () => { await Promise.resolve(); });
      expect(firstAudio.removeAttribute).toHaveBeenCalledWith('src');
      expect(firstAudio.src).toBe('');

      click('Library tab');
      click('A saved DTO note');
      click('Play recording');
      expect(secondAudio.src).toBe(`/api/audio/${mediaId}`);
      click('Open settings');
      await act(async () => { await Promise.resolve(); });
      expect(secondAudio.removeAttribute).toHaveBeenCalledWith('src');
      expect(secondAudio.src).toBe('');

      click('Close settings');
      click('Play recording');
      expect(thirdAudio.src).toBe(`/api/audio/${mediaId}`);
      click('Back to recordings');
      await act(async () => { await Promise.resolve(); });
      expect(thirdAudio.removeAttribute).toHaveBeenCalledWith('src');
      expect(thirdAudio.src).toBe('');
    } finally {
      document.createElement = originalCreateElement;
      vi.unstubAllGlobals();
    }
  });

  it('ignores a late exact upload inspection after a real session is replaced', async () => {
    const { state } = fixture();
    const secondState = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
    secondState.notes.push({ id: 'f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2', title: 'Replacement session marker', transcript: 'Only the new session is visible', durationSeconds: 0, createdAt: '2026-10-15T00:00:00.000Z', status: 'recorded', revision: 1 });
    const sessionA = { authenticated: true as const, workspaceId, privacyEpoch: 3, csrfToken: 'csrf-a' };
    const sessionB = { authenticated: true as const, workspaceId: 'f3f3f3f3-f3f3-43f3-83f3-f3f3f3f3f3f3', privacyEpoch: 4, csrfToken: 'csrf-b' };
    const track = { stop: vi.fn() };
    const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] } as unknown as MediaStream)) } });
    vi.stubGlobal('MediaRecorder', UiMediaRecorder);
    let oldUploadId: string | undefined;
    let oldCapture: { id: string; capturedAt: string; timeZone: string } | undefined;
    const oldInspection = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    let snapshotReads = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata(false, false, snapshotReads > 1 ? sessionB.privacyEpoch : sessionA.privacyEpoch, snapshotReads > 1 ? sessionB.workspaceId : sessionA.workspaceId) };
      if (path === '/api/workspace/snapshot') {
        snapshotReads += 1;
        const isNewSession = snapshotReads > 1;
        return { ok: true, status: 200, json: async () => createWorkspaceSnapshotDTO({ getSnapshot: () => isNewSession ? secondState : state }, {
          workspaceId: isNewSession ? sessionB.workspaceId : workspaceId, privacyEpoch: isNewSession ? sessionB.privacyEpoch : sessionA.privacyEpoch, revision: isNewSession ? 2 : 7,
        }) };
      }
      if (path === '/api/audio/uploads' && method === 'POST') {
        const headers = new Headers(init?.headers);
        oldUploadId = headers.get('X-Still-Upload-ID') ?? undefined;
        oldCapture = JSON.parse(headers.get('X-Still-Capture') ?? '{}') as typeof oldCapture;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (oldUploadId && path === `/api/audio/uploads/${oldUploadId}` && method === 'GET') return oldInspection.promise;
      throw new Error(`Unexpected session replacement request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession key="session-a" session={sessionA} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Record'); click('Start recording a voice note');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Stop and save recording');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Check the original upload.');
      click('Inspect exact upload');
      expect(oldUploadId).toBeDefined();
      await act(async () => { await Promise.resolve(); });

      await act(async () => { root.render(<CloudWorkspaceSession key="session-b" session={sessionB} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Library'); click('Notes');
      expect(host.textContent).toContain('Only the new session is visible');
      oldInspection.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, uploadId: oldUploadId, status: 'ready',
        capture: { ...oldCapture, revision: 'f4f4f4f4-f4f4-44f4-84f4-f4f4f4f4f4f4' },
        media: { mediaId: 'still-media:f5f5f5f5-f5f5-45f5-85f5-f5f5f5f5f5f5', sha256: 'a'.repeat(64), byteLength: 14, durationSeconds: 2, format: 'webm', mimeType: 'audio/webm' } }) });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Only the new session is visible');
      expect(host.textContent).not.toContain('Save this recording to notes?');
      expect(fetcher.mock.calls.filter(([path, init]) => String(path) === '/api/workspace/commands' && init?.method === 'POST')).toHaveLength(0);
    } finally {
      if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor);
      else Reflect.deleteProperty(navigator, 'mediaDevices');
      vi.unstubAllGlobals();
    }
  });

  it('offers local-copy cleanup after confirmed save when cleanup remains pending, then unlocks Record another without another save', async () => {
    const noteId = 'f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6';
    const discardLocalClip = vi.fn(async () => undefined);
    const uploadStoppedClip = vi.fn(async () => undefined);
    const saveReady = vi.fn(async () => undefined);
    const inspectAdoption = vi.fn(async () => undefined);
    const resetAfterSave = vi.fn();
    function Harness() {
      const [localClipPresent, setLocalClipPresent] = React.useState(true);
      const [phase, setPhase] = React.useState<CloudVoicePhase>('saved');
      const actions: CloudWorkspaceVoiceActions = {
        start: async () => {}, pause: async () => {}, resume: async () => {}, stopAndSave: async () => {},
        uploadStoppedClip, saveReady, inspectUpload: async () => { throw new Error('not used'); }, listHistory: async () => ({ schemaVersion: 1, entries: [] }),
        inspectAdoption, discardLocalClip: async () => { await discardLocalClip(); setLocalClipPresent(false); },
        cancelCurrentRecording: async () => {}, resetAfterSave: () => { resetAfterSave(); setPhase('idle'); },
      };
      const voice: CloudVoiceCoordinatorState = { phase, localClipPresent, noteId };
      return <ServerRecordingPanel voice={voice} actions={actions} busy={false} openNoteAvailable onOpenNote={vi.fn()} onError={vi.fn()} />;
    }
    act(() => root.render(<Harness />));
    expect(host.textContent).toContain('Your recording is saved.');
    expect(host.textContent).toContain('Open saved note');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Record another'))?.disabled).toBe(true);
    const discardButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Discard local recording copy'));
    expect(discardButton).toBeDefined();
    await act(async () => { discardButton!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(discardLocalClip).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Your recording is saved.');
    expect(host.textContent).toContain('Open saved note');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Record another'))?.disabled).toBe(false);
    const recordAnotherButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Record another'));
    expect(recordAnotherButton?.disabled).toBe(false);
    await act(async () => { recordAnotherButton!.click(); await Promise.resolve(); });
    expect(resetAfterSave).toHaveBeenCalledOnce();
    expect(uploadStoppedClip).not.toHaveBeenCalled();
    expect(saveReady).not.toHaveBeenCalled();
    expect(inspectAdoption).not.toHaveBeenCalled();
  });

  it('saves shared documents and People/Projects through exact cloud commands and confirmed receipts', async () => {
    const { state } = fixture();
    const commands: WorkspaceCommand[] = [];
    const personId = 'abababab-abab-4bab-8bab-abababababab';
    const existingPersonId = '01234567-89ab-7def-8abc-0123456789ab';
    const projectId = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
    const factId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const contactId = 'dededede-dede-4ede-8ede-dededededede';
    const memberId = 'efefefef-efef-4fef-8fef-efefefefefef';
    let snapshotRevision = 7;
    state.knowledge.people.push({ id: existingPersonId, revision: 6, name: 'Existing Jordan', aliases: [], narrativePath: `people/${existingPersonId}.md`, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', facts: [], contacts: [], sourceLinks: [] } satisfies import('../src/knowledge/types').Person);
    state.documents.push({ path: `people/${existingPersonId}.md`, content: 'Existing saved narrative.', revision: 4, updatedAt: '2026-10-14T00:00:00.000Z' });
    const makeSnapshot = () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: ++snapshotRevision });
    const getEntity = (kind: 'person' | 'project', id: string) => kind === 'person'
      ? state.knowledge.people.find((item) => item.id === id)
      : state.knowledge.projects.find((item) => item.id === id);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot' || path === '/api/workspace/refresh') return { ok: true, status: 200, json: async () => makeSnapshot() };
      if (path === '/api/workspace/commands' && method === 'POST') {
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: WorkspaceCommand };
        const command = envelope.command;
        commands.push(command);
        const timestamp = new Date().toISOString();
        let objectId = '';
        let receiptExtra: Record<string, unknown> = {};
        switch (command.kind) {
          case 'documents.save': {
            const current = state.documents.find((item) => item.path === command.path);
            const revision = (current?.revision ?? 0) + 1;
            if (current) { current.content = command.content; current.revision = revision; current.updatedAt = timestamp; }
            else state.documents.push({ path: command.path, content: command.content, revision, updatedAt: timestamp });
            objectId = command.path; receiptExtra = { documentRevision: revision }; break;
          }
          case 'knowledge.person.save': {
            const narrative = command.input.narrative;
            let person: (typeof state.knowledge.people)[number];
            if (command.operation === 'create') {
              const input = command.input;
              person = {
                id: personId, revision: 1, name: input.name, aliases: [...input.aliases], narrativePath: `people/${personId}.md`, createdAt: timestamp, updatedAt: timestamp,
                facts: [], contacts: [], sourceLinks: [],
              };
              state.knowledge.people.push(person);
            } else {
              const input = command.input;
              person = state.knowledge.people.find((item) => item.id === input.id)!;
              person.revision += 1; person.name = input.name; person.aliases = [...input.aliases]; person.updatedAt = timestamp;
            }
            const doc = state.documents.find((item) => item.path === person.narrativePath);
            if (doc) { doc.content = narrative; doc.revision += 1; doc.updatedAt = timestamp; }
            else state.documents.push({ path: person.narrativePath, content: narrative, revision: 1, updatedAt: timestamp });
            objectId = person.id; receiptExtra = { entityKind: 'person', entityRevision: person.revision }; break;
          }
          case 'knowledge.project.save': {
            const narrative = command.input.narrative;
            let project: (typeof state.knowledge.projects)[number];
            if (command.operation === 'create') {
              const input = command.input;
              project = {
                id: projectId, revision: 1, name: input.name, aliases: [...input.aliases], narrativePath: `projects/${projectId}.md`, createdAt: timestamp, updatedAt: timestamp,
                facts: [], sourceLinks: [], members: [], status: input.status, goal: input.goal,
                ...(input.startsOn ? { startsOn: input.startsOn } : {}), ...(input.targetOn ? { targetOn: input.targetOn } : {}), ...(input.dateTimeZone ? { dateTimeZone: input.dateTimeZone } : {}),
              };
              state.knowledge.projects.push(project);
            } else {
              const input = command.input;
              project = state.knowledge.projects.find((item) => item.id === input.id)!;
              project.revision += 1; project.name = input.name; project.aliases = [...input.aliases]; project.status = input.status; project.goal = input.goal; project.updatedAt = timestamp;
            }
            const doc = state.documents.find((item) => item.path === project.narrativePath);
            if (doc) { doc.content = narrative; doc.revision += 1; doc.updatedAt = timestamp; }
            else state.documents.push({ path: project.narrativePath, content: narrative, revision: 1, updatedAt: timestamp });
            objectId = project.id; receiptExtra = { entityKind: 'project', entityRevision: project.revision }; break;
          }
          case 'knowledge.entity.archive': {
            const entity = getEntity(command.entityKind, command.id)!;
            entity.revision += 1; entity.updatedAt = timestamp;
            if (command.archived) entity.archivedAt = timestamp; else delete entity.archivedAt;
            objectId = entity.id; receiptExtra = { entityKind: command.entityKind, entityRevision: entity.revision }; break;
          }
          case 'knowledge.fact.save': case 'knowledge.fact.remove': {
            const entity = getEntity(command.entityKind, command.entityId)!;
            const id = command.kind === 'knowledge.fact.remove' ? command.itemId : command.itemId ?? factId;
            if (command.kind === 'knowledge.fact.remove') entity.facts = entity.facts.filter((item) => item.id !== id);
            else {
              const existing = entity.facts.find((item) => item.id === id);
              if (existing) existing.statement = command.statement;
              else entity.facts.push({ id, provenance: 'user_authored', createdAt: timestamp, statement: command.statement });
            }
            entity.revision += 1; entity.updatedAt = timestamp; objectId = entity.id; receiptExtra = { entityKind: command.entityKind, entityRevision: entity.revision, itemId: id }; break;
          }
          case 'knowledge.contact.save': case 'knowledge.contact.remove': {
            const entity = state.knowledge.people.find((item) => item.id === command.entityId)!;
            const id = command.kind === 'knowledge.contact.remove' ? command.itemId : command.itemId ?? contactId;
            if (command.kind === 'knowledge.contact.remove') entity.contacts = entity.contacts.filter((item) => item.id !== id);
            else {
              const existing = entity.contacts.find((item) => item.id === id);
              if (existing) { existing.address = command.address; existing.label = command.label; }
              else entity.contacts.push({ id, provenance: 'user_authored', createdAt: timestamp, address: command.address, label: command.label });
            }
            entity.revision += 1; entity.updatedAt = timestamp; objectId = entity.id; receiptExtra = { entityKind: 'person', entityRevision: entity.revision, itemId: id }; break;
          }
          case 'knowledge.member.save': case 'knowledge.member.remove': {
            const entity = state.knowledge.projects.find((item) => item.id === command.entityId)!;
            const id = command.kind === 'knowledge.member.remove' ? command.itemId : command.itemId ?? memberId;
            if (command.kind === 'knowledge.member.remove') entity.members = entity.members.filter((item) => item.id !== id);
            else {
              const existing = entity.members.find((item) => item.id === id);
              if (existing && 'personId' in existing) { existing.personId = command.personId; existing.role = command.role; }
              else entity.members.push({ id, provenance: 'user_authored', createdAt: timestamp, personId: command.personId, role: command.role });
            }
            entity.revision += 1; entity.updatedAt = timestamp; objectId = entity.id; receiptExtra = { entityKind: 'project', entityRevision: entity.revision, itemId: id }; break;
          }
          default: throw new Error(`Unexpected Library command: ${command.kind}`);
        }
        const responseSnapshot = makeSnapshot();
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished',
          receipt: { schemaVersion: 1, commandId: envelope.commandId, kind: command.kind, objectId, ...receiptExtra }, snapshot: responseSnapshot }) };
      }
      throw new Error(`Unexpected Library request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={{ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' }} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Library');
      click('Create personal document');
      setTextField('Document content', 'Keep project decisions here.');
      clickTwice('Save');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands[0]).toMatchObject({ kind: 'documents.save', content: 'Keep project decisions here.', expectedRevision: null });
      expect(host.textContent).toContain('Document saved.');
      click('Back to library');
      const savedDocumentRow = [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.startsWith('Open document '));
      expect(savedDocumentRow).toBeDefined();
      act(() => savedDocumentRow!.click());
      setTextField('Document content', 'Updated project decisions.');
      clickTwice('Save');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands[1]).toMatchObject({ kind: 'documents.save', content: 'Updated project decisions.', expectedRevision: 1 });
      click('Back to library');

      click('People library section');
      click('Add person');
      setTextField('Name', 'Maya');
      setTextField('Aliases · separate with commas', 'May');
      setTextField('Notes', 'A new colleague.');
      click('Create person');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands[2]).toEqual({ kind: 'knowledge.person.save', operation: 'create', input: { name: 'Maya', aliases: ['May'], narrative: 'A new colleague.' } });
      click('Open person Maya');
      expect(host.textContent).toContain('Source links are viewable here; editing them is not connected to workspace commands yet.');
      setTextField('Add a fact', 'Prefers concise updates');
      clickTwice('Add fact');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.filter((command) => command.kind === 'knowledge.fact.save')).toHaveLength(1);
      click('Remove claim Prefers concise updates');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.filter((command) => command.kind === 'knowledge.fact.remove')).toHaveLength(1);

      setTextField('Contact address · not verified', 'maya@example.test');
      setTextField('Label', 'Work');
      click('Add contact claim');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.filter((command) => command.kind === 'knowledge.contact.save')).toHaveLength(1);
      click('Remove claim Work: maya@example.test');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.filter((command) => command.kind === 'knowledge.contact.remove')).toHaveLength(1);

      setTextField('Name', 'Maya Lee');
      click('Save changes');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.find((command) => command.kind === 'knowledge.person.save' && command.operation === 'update')).toMatchObject({ operation: 'update', input: { id: personId, expectedRevision: 5, expectedDocumentRevision: 1, name: 'Maya Lee' } });

      click('Projects library section');
      click('Add project');
      setTextField('Name', 'Still launch');
      setTextField('Notes', 'Project narrative.');
      setTextField('Goal', 'Ship the first version.');
      click('Create project');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.find((command) => command.kind === 'knowledge.project.save')).toMatchObject({ kind: 'knowledge.project.save', operation: 'create', input: { name: 'Still launch', goal: 'Ship the first version.' } });

      click('Open project Still launch');
      click('Maya Lee');
      setTextField('Role', 'Owner');
      click('Add project member');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.filter((command) => command.kind === 'knowledge.member.save')).toHaveLength(1);
      click('Remove claim Maya Lee · Owner');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.filter((command) => command.kind === 'knowledge.member.remove')).toHaveLength(1);
      click('Close knowledge editor');
      click('Archive project Still launch');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.filter((command) => command.kind === 'knowledge.entity.archive')).toHaveLength(1);

      click('People library section');
      click('Open person Existing Jordan');
      setTextField('Name', 'Jordan Updated');
      clickTwice('Save changes');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commands.find((command) => command.kind === 'knowledge.person.save' && command.operation === 'update' && command.input.id === existingPersonId)).toMatchObject({
        operation: 'update', input: { id: existingPersonId, expectedRevision: 6, expectedDocumentRevision: 4, name: 'Jordan Updated' },
      });
      expect(host.textContent).toContain('Jordan Updated');
      expect(fetcher.mock.calls.filter(([path, init]) => String(path) === '/api/workspace/commands' && init?.method === 'POST')).toHaveLength(commands.length);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['rejected request', 'late receipt'] as const)('does not publish an archive result from an old workspace after a %s', async (outcome) => {
    const oldOwner = fixture().state;
    const personId = '01234567-89ab-7def-8abc-0123456789ab';
    oldOwner.knowledge.people.push({ id: personId, revision: 1, name: 'Jordan', aliases: [], narrativePath: `people/${personId}.md`, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', facts: [], contacts: [], sourceLinks: [] } satisfies import('../src/knowledge/types').Person);
    const newOwner = createInitialWorkspaceState(() => '44444444-4444-4444-8444-444444444444');
    const firstSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => oldOwner }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const secondSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => newOwner }, { workspaceId: '99999999-9999-4999-8999-999999999999', privacyEpoch: 4, revision: 1 });
    let liveState: CloudWorkspaceSessionState = { status: 'ready', snapshot: firstSnapshot, busy: false, refreshRequired: false };
    const pending = deferred<WorkspaceCommandResponse>();
    const store = {
      getSnapshot: () => liveState,
      execute: vi.fn(() => pending.promise),
      inspect: vi.fn(async () => { throw new Error('Not used'); }),
      refresh: vi.fn(async () => secondSnapshot),
    };
    act(() => root.render(<CloudWorkspace store={store} state={liveState} onLogout={vi.fn()} />));
    click('Library');
    click('People library section');
    click('Archive person Jordan');
    expect(store.execute).toHaveBeenCalledOnce();

    liveState = { status: 'ready', snapshot: secondSnapshot, busy: false, refreshRequired: false };
    act(() => root.render(<CloudWorkspace store={store} state={liveState} onLogout={vi.fn()} />));
    await act(async () => {
      if (outcome === 'rejected request') pending.reject(new Error('Old workspace request failed'));
      else {
        const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        pending.resolve({ schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId, kind: 'knowledge.entity.archive', objectId: personId, entityKind: 'person', entityRevision: 2 } });
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('could not be confirmed');
    expect(host.textContent).not.toContain('Jordan');
  });

  it('keeps an open document draft on conflict, reloads only on request, and fences duplicate saves', async () => {
    const first = { path: 'notes/decisions.md', content: 'Saved version', revision: 1 };
    let latest = [first];
    const response = deferred<{ revision: number; snapshotUpdated: boolean }>();
    const save = vi.fn(() => response.promise);
    const renderEditor = () => <SafeAreaProvider><WorkspaceDocumentEditor visible document={first} currentDocuments={latest} busy={false}
      saveAction={{ available: true, action: save }} onClose={vi.fn()} /></SafeAreaProvider>;
    act(() => root.render(renderEditor()));
    setTextField('Document content', 'Draft I want to keep');
    latest = [{ path: first.path, content: 'Changed elsewhere', revision: 2 }];
    act(() => root.render(renderEditor()));
    expect((host.querySelector('textarea[aria-label="Document content"]') as HTMLTextAreaElement).value).toBe('Draft I want to keep');
    expect(host.textContent).toContain('The saved version changed while this document was open. Your draft is still here.');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Save'))?.disabled).toBe(true);
    click('Reload saved document');
    expect((host.querySelector('textarea[aria-label="Document content"]') as HTMLTextAreaElement).value).toBe('Changed elsewhere');
    setTextField('Document content', 'Reviewed new version');
    clickTwice('Save');
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ path: first.path, content: 'Reviewed new version', expectedRevision: 2 });
    response.resolve({ revision: 3, snapshotUpdated: true });
    await act(async () => { await response.promise; });
    expect(host.textContent).toContain('Document saved.');
  });

  it('ignores a late document save result after closing and opening a different document', async () => {
    const pending = deferred<{ revision: number; snapshotUpdated: boolean }>();
    const save = vi.fn(() => pending.promise);
    const first = { path: 'notes/one.md', content: 'First', revision: 1 };
    const second = { path: 'notes/two.md', content: 'Second', revision: 4 };
    const currentDocuments = [first, second];
    const renderEditor = (visible: boolean, document: typeof first) => <SafeAreaProvider><WorkspaceDocumentEditor key={`${visible}:${document.path}`} visible={visible} document={document}
      currentDocuments={currentDocuments} busy={false} saveAction={{ available: true, action: save }} onClose={vi.fn()} /></SafeAreaProvider>;
    act(() => root.render(renderEditor(true, first)));
    setTextField('Document content', 'First edited');
    click('Save');
    expect(save).toHaveBeenCalledOnce();
    act(() => root.render(renderEditor(true, second)));
    expect((host.querySelector('textarea[aria-label="Document content"]') as HTMLTextAreaElement).value).toBe('Second');
    pending.resolve({ revision: 2, snapshotUpdated: true });
    await act(async () => { await pending.promise; });
    expect((host.querySelector('textarea[aria-label="Document content"]') as HTMLTextAreaElement).value).toBe('Second');
    expect(host.textContent).not.toContain('Document saved.');
  });
});
