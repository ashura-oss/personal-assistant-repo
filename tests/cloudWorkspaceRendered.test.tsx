/** @vitest-environment jsdom */
import React, { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO, type WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { Account, LocalTask, MailboxSnapshotMessage, Note, Proposal } from '../src/core';
import { CloudWorkspaceSessionStore, type CloudWorkspaceSessionState, type CloudWorkspaceVoiceActions } from '../src/web/CloudWorkspaceSession';
import { CloudWorkspace } from '../src/web/CloudWorkspace';
import { CloudMailWorkspace } from '../src/web/CloudMailWorkspace';
import { CloudMailCoordinator, type CloudMailWorkspacePort } from '../src/web/cloudMailCoordinator';
import { CloudWorkspaceSession } from '../src/web/CloudWorkspaceSession';
import AppWeb from '../App.web';
import { ServerRecordingPanel } from '../src/ui/ServerRecordingPanel';
import { WorkspaceDocumentEditor } from '../src/ui/WorkspaceDocumentEditor';
import type { CloudVoiceCoordinatorState, CloudVoicePhase } from '../src/web/cloudVoiceCoordinator';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';
import { WorkspaceClientError } from '../src/web/workspaceClient';
import type { WorkspaceCommandAdmission } from '../src/web/workspaceClient';
import { CloudTranscriptTransferCoordinator } from '../src/web/cloudTranscriptTransferCoordinator';

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

function transcriptCoordinatorFor(store: { getSnapshot(): CloudWorkspaceSessionState;
  execute(command: WorkspaceCommand, onAdmitted?: (envelope: WorkspaceCommandAdmission) => void): Promise<WorkspaceCommandResponse>;
  inspect(commandId: string): Promise<WorkspaceCommandResponse>; refresh(): Promise<WorkspaceSnapshotDTO | undefined> }) {
  return new CloudTranscriptTransferCoordinator({
    readSnapshot: () => store.getSnapshot().snapshot,
    readOperation: () => { const current = store.getSnapshot(); return ({ busy: current.busy, pending: Boolean(current.pendingCommand), refreshRequired: current.refreshRequired,
      ...(current.pendingCommand ? { pendingCommandId: current.pendingCommand.commandId } : {}) }); },
    execute: (command, onAdmitted) => store.execute(command, (envelope) => onAdmitted?.(envelope.commandId)),
    inspect: (commandId) => store.inspect(commandId),
    refresh: () => store.refresh(),
  });
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
  it('uses saved-only reply reads in sequence and requires explicit rebinding when source metadata changes', async () => {
    const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
    const accountId = '22222222-2222-4222-8222-222222222222';
    const messageId = '66666666-6666-4666-8666-666666666666';
    state.accounts.push({ id: accountId, provider: 'google', displayName: 'Mail account', email: 'me@example.test', connected: true,
      authStatus: 'connected', identity: { providerNamespace: 'google', subject: 'fixture-subject' }, capabilities: ['mail.read', 'mail.draft'], connectionGeneration: 4 } satisfies Account);
    state.mailbox.push({ id: messageId, accountId, providerMessageId: 'provider-message', identityKey: 'safe-key', verifiedIdentityKey: 'safe-key', connectionGeneration: 4,
      idFormat: 'gmail', internetMessageId: '<saved@example.test>', replyMetadataComplete: true, subject: 'Saved subject', from: 'sender@example.test', snippet: 'Saved excerpt',
      observedAt: '2026-10-15T10:00:00.000Z', receivedAt: '2026-10-15T09:00:00.000Z' } satisfies MailboxSnapshotMessage);
    const initialSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const requests: { path: string; method: string; body?: string }[] = [];
    let sourceReads = 0;
    let commandPosts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      requests.push({ path, method, ...(init?.body ? { body: String(init.body) } : {}) });
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata() };
      if (path === '/api/workspace/snapshot' && method === 'GET') return { ok: true, status: 200, json: async () => initialSnapshot };
      if (path.startsWith('/api/workspace/mail/source?') && method === 'GET') {
        sourceReads += 1;
        const sourceDigest = sourceReads === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: 7, status: 'current',
          source: { accountId, connectionGeneration: 4, localMessageId: messageId, providerMessageId: 'provider-message', idFormat: 'gmail', internetMessageId: '<saved@example.test>',
            subject: sourceReads === 1 ? 'Saved subject' : 'Changed saved subject', from: 'sender@example.test', senderEmail: 'sender@example.test', to: ['me@example.test'], cc: [],
            observedAt: '2026-10-15T10:00:00.000Z', sourceDigest },
          defaults: { reply: { to: ['sender@example.test'], cc: [] }, reply_all: { to: ['sender@example.test', 'team@example.test'], cc: [] } },
          bodyCache: { status: 'current', textDigest: 'c'.repeat(64), bytes: 11, completeness: 'complete_text', representation: 'plain', checkedAt: '2026-10-15T10:00:00.000Z' } }) };
      }
      if (path.startsWith('/api/workspace/mail/source-text?') && method === 'GET') {
        const sourceDigest = sourceReads === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
        const text = 'Cached reply context';
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: 7, status: 'current', snapshot: {
          messageId, accountId, connectionGeneration: 4, sourceDigest, checkedAt: '2026-10-15T10:01:00.000Z', text, textDigest: 'c'.repeat(64),
          bytes: new TextEncoder().encode(text).byteLength, extractionVersion: 'mail-text-v2', representation: 'plain', completeness: 'complete_text', omissionReasons: [],
        } }) };
      }
      if (path === '/api/workspace/commands' && method === 'POST') {
        commandPosts += 1;
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: WorkspaceCommand };
        expect(envelope.command.kind).toBe('mail.reply.create');
        if (envelope.command.kind === 'mail.reply.create') expect(envelope.command).toMatchObject({ messageId, accountId, expectedConnectionGeneration: 4,
          sourceDigest: 'b'.repeat(64), to: ['sender@example.test'], text: 'Draft reply text' });
        const proposalId = '77777777-7777-4777-8777-777777777777';
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: {
          schemaVersion: 1, commandId: envelope.commandId, kind: 'mail.reply.create', objectId: proposalId, proposalId, proposalRevision: 1,
        } }) };
      }
      throw new Error(`Unexpected cloud mail request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession session={{ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'mail-csrf' }} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Mail and calendar section');
      click('Use Mail account');
      click('Reply');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(requests.filter((item) => item.method === 'GET' && item.path.includes('/api/workspace/mail/')) .map((item) => item.path.split('?')[0]))
        .toEqual(['/api/workspace/mail/source', '/api/workspace/mail/source-text']);
      setTextField('Reply text', 'Draft reply text');
      click('Close reply');
      click('Reply');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('The saved message changed since this draft was opened.');
      expect((host.querySelector('textarea[aria-label="Reply text"]') as HTMLTextAreaElement).value).toBe('Draft reply text');
      expect((host.querySelector('button') as HTMLButtonElement)).not.toBeNull();
      const saveButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Save reply for review'));
      expect(saveButton?.disabled).toBe(true);
      expect(commandPosts).toBe(0);
      click('Use current message and recipients');
      const reboundSave = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Save reply for review'));
      expect(reboundSave?.disabled).toBe(false);
      click('Save reply for review');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(commandPosts).toBe(1);
      expect(requests.filter((item) => item.method === 'POST' && item.path === '/api/workspace/commands')).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('retains proposal drafts across mail-tab unmount and preserves text typed while a confirmed save is pending', async () => {
    const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
    const accountId = '22222222-2222-4222-8222-222222222222';
    const proposalId = '77777777-7777-4777-8777-777777777777';
    state.accounts.push({ id: accountId, provider: 'google', displayName: 'Work account', email: 'me@example.test', connected: true,
      authStatus: 'connected', identity: { providerNamespace: 'google', subject: 'private-subject' }, capabilities: ['mail.read', 'mail.draft'], connectionGeneration: 4 } satisfies Account);
    const proposal: Proposal = { id: proposalId, kind: 'email', title: 'Editable proposal', body: 'Saved body', status: 'draft', revision: 1,
      accountId, recipients: ['to@example.test'], evidence: [], email: { operation: 'draft', to: ['to@example.test'], cc: [], bcc: [], subject: 'Saved subject', text: 'Original text', attachments: [] } };
    state.proposals.push(proposal);
    let revision = 7;
    const snapshot = () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision });
    const post = deferred<Awaited<ReturnType<typeof fetch>>>();
    let markPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => { markPostStarted = resolve; });
    let editCommandId = '';
    let editPosts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      if (path === '/api/workspace/snapshot' && method === 'GET') return { ok: true, status: 200, json: async () => snapshot() };
      if (path.startsWith('/api/workspace/proposals/review?') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, workspaceId, privacyEpoch: 3,
          revision: Number(new URL(path, 'http://test').searchParams.get('expectedRevision')),
          proposal: { editPolicy: 'email_fields', canDeriveManualReply: false, id: proposal.id, kind: 'email', title: proposal.title, body: proposal.body, status: proposal.status,
            revision: proposal.revision, accountId, recipients: proposal.recipients, email: { operation: proposal.email!.operation, to: proposal.email!.to, cc: proposal.email!.cc,
              bcc: proposal.email!.bcc, subject: proposal.email!.subject, text: proposal.email!.text, attachments: [] } } }) };
      }
      if (path === '/api/workspace/commands' && method === 'POST') {
        editPosts += 1;
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: WorkspaceCommand };
        editCommandId = envelope.commandId;
        if (envelope.command.kind !== 'proposals.edit' || envelope.command.edit.kind !== 'email') throw new Error(`Unexpected command ${envelope.command.kind}`);
        proposal.email = { ...proposal.email!, operation: envelope.command.edit.operation, to: [...envelope.command.edit.to], cc: [...envelope.command.edit.cc],
          bcc: [...envelope.command.edit.bcc], subject: envelope.command.edit.subject, text: envelope.command.edit.text };
        proposal.revision += 1;
        revision += 1;
        markPostStarted();
        return post.promise;
      }
      throw new Error(`Unexpected session workflow request ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const session = Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'proposal-csrf' });
    const store = new CloudWorkspaceSessionStore(session);
    const stop = store.start();
    function MailRoute() {
      const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      if (!current.snapshot) return React.createElement('div', null, current.status);
      return React.createElement(CloudMailWorkspace, { coordinator: store.getMailCoordinator(), snapshot: current.snapshot,
        busy: current.busy, blocked: current.refreshRequired || Boolean(current.pendingCommand) });
    }
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const coordinator = store.getMailCoordinator();
      expect(coordinator).toBeDefined();
      await act(async () => { await coordinator!.openProposal(proposalId); });
      await act(async () => root.render(React.createElement(MailRoute)));
      setTextField('Message', 'Submitted text');
      click('Save proposal changes');
      await postStarted;
      expect(editPosts).toBe(1);
      setTextField('Message', 'Typed while the save is waiting');

      await act(async () => root.render(React.createElement('div', null, 'Settings')));
      expect(host.textContent).toBe('Settings');
      post.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: editCommandId, status: 'finished',
        receipt: { schemaVersion: 1, commandId: editCommandId, kind: 'proposals.edit', objectId: proposalId, proposalId, proposalRevision: proposal.revision, proposalStatus: 'draft' },
        snapshot: snapshot() }) } as Awaited<ReturnType<typeof fetch>>);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      await act(async () => root.render(React.createElement(MailRoute)));
      expect((host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Typed while the save is waiting');
      expect(host.textContent).toContain('These fields have unsaved changes. Save them before approval or execution.');
      expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Approve this revision')?.disabled).toBe(true);
      expect(editPosts).toBe(1);
      expect(store.getSnapshot().snapshot?.revision).toBe(8);
    } finally { stop(); vi.unstubAllGlobals(); }
  });

  it('keeps a lost proposal edit command across a Mail/settings unmount and inspects its original ID without resending', async () => {
    const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
    const accountId = '22222222-2222-4222-8222-222222222222';
    const proposalId = '77777777-7777-4777-8777-777777777777';
    state.accounts.push({ id: accountId, provider: 'google', displayName: 'Work account', email: 'me@example.test', connected: true,
      authStatus: 'connected', identity: { providerNamespace: 'google', subject: 'private-subject' }, capabilities: ['mail.read', 'mail.draft'], connectionGeneration: 4 } satisfies Account);
    const proposal: Proposal = { id: proposalId, kind: 'email', title: 'Editable proposal', body: 'Saved body', status: 'draft', revision: 1,
      accountId, recipients: ['to@example.test'], evidence: [], email: { operation: 'draft', to: ['to@example.test'], cc: [], bcc: [], subject: 'Saved subject', text: 'Original text', attachments: [] } };
    state.proposals.push(proposal);
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    let commandId = '';
    let posts = 0;
    const inspected: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      if (path === '/api/workspace/snapshot' && method === 'GET') return { ok: true, status: 200, json: async () => snapshot };
      if (path.startsWith('/api/workspace/proposals/review?') && method === 'GET') return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, workspaceId, privacyEpoch: 3,
        revision: 7, proposal: { editPolicy: 'email_fields', canDeriveManualReply: false, id: proposal.id, kind: 'email', title: proposal.title, body: proposal.body, status: proposal.status,
          revision: proposal.revision, accountId, recipients: proposal.recipients, email: { operation: proposal.email!.operation, to: proposal.email!.to, cc: proposal.email!.cc,
            bcc: proposal.email!.bcc, subject: proposal.email!.subject, text: proposal.email!.text, attachments: [] } } }) };
      if (path === '/api/workspace/commands' && method === 'POST') {
        posts += 1;
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: WorkspaceCommand };
        commandId = envelope.commandId;
        return Promise.reject(new TypeError('connection lost after dispatch'));
      }
      if (path === `/api/workspace/commands/${commandId}` && method === 'GET') {
        inspected.push(path);
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId, status: 'finished', receipt: {
          schemaVersion: 1, commandId, kind: 'proposals.edit', objectId: proposalId, proposalId, proposalRevision: 2, proposalStatus: 'draft' } }) };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const store = new CloudWorkspaceSessionStore(Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'proposal-csrf' }));
    const stop = store.start();
    function MailRoute() {
      const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      return current.snapshot ? React.createElement(CloudMailWorkspace, { coordinator: store.getMailCoordinator(), snapshot: current.snapshot,
        busy: current.busy, blocked: current.refreshRequired || Boolean(current.pendingCommand) }) : null;
    }
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const coordinator = store.getMailCoordinator()!;
      await act(async () => { await coordinator.openProposal(proposalId); });
      await act(async () => root.render(React.createElement(MailRoute)));
      setTextField('Message', 'Changed once');
      click('Save proposal changes');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(posts).toBe(1);
      expect(store.getSnapshot().pendingCommand?.commandId).toBe(commandId);
      await act(async () => root.render(React.createElement('div', null, 'Settings')));
      await act(async () => root.render(React.createElement(MailRoute)));
      expect(host.textContent).toContain('Inspect exact mail command');
      click('Inspect exact mail command');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(inspected).toEqual([`/api/workspace/commands/${commandId}`]);
      expect(posts).toBe(1);
      expect(host.textContent).toContain('The exact receipt is confirmed. Refresh the workspace to review the saved result.');
      expect(localStorage.length).toBe(0);
    } finally { stop(); vi.unstubAllGlobals(); }
  });

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

  it('confirms an imported capture time zone against the exact saved note revision', async () => {
    const { state } = fixture();
    const note = state.notes[0]!;
    note.importOrigin = { kind: 'backup_import', archiveId: '77777777-7777-4777-8777-777777777777', sourceNoteId: 'old-note:1', audioMissing: false, originalTimeZoneUnknown: true };
    note.capturedAt = '2026-10-14T23:00:00.000Z';
    let currentSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const stateValue = { status: 'ready' as const, snapshot: currentSnapshot, busy: false, refreshRequired: false };
    const execute = vi.fn(async (command: WorkspaceCommand) => {
      expect(command).toEqual({ kind: 'notes.confirmImportedTimeZone', noteId: note.id, expectedNoteRevision: 1, timeZone: 'Asia/Singapore' });
      return { schemaVersion: 1 as const, commandId: '88888888-8888-4888-8888-888888888888', status: 'finished' as const,
        receipt: { schemaVersion: 1 as const, commandId: '88888888-8888-4888-8888-888888888888', kind: command.kind, objectId: note.id,
          noteId: note.id, noteRevision: 2, timeZone: 'Asia/Singapore' } as WorkspaceCommandResponse['receipt'] };
    });
    const store = { getSnapshot: () => stateValue, execute, inspect: vi.fn(), refresh: vi.fn(async () => currentSnapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={stateValue} onLogout={vi.fn()} />));
    click('Library'); click('Notes'); click('A saved DTO note');
    const field = host.querySelector('textarea[aria-label="IANA capture time zone"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => { setter?.call(field, 'Asia/Singapore'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    click('Confirm capture time zone');
    await act(async () => { await Promise.resolve(); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ kind: 'notes.confirmImportedTimeZone', noteId: note.id, expectedNoteRevision: 1, timeZone: 'Asia/Singapore' });
    expect(host.textContent).toContain('Capture time zone confirmed.');

    currentSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 });
    stateValue.snapshot = currentSnapshot;
  });

  it('reviews a saved transcript without a provider action and submits only after the explicit Chat button', async () => {
    const { state } = fixture();
    const note = state.notes[0]!;
    note.capturedAt = '2026-10-14T23:00:00.000Z';
    note.captureTimeZone = 'Asia/Singapore';
    state.settings.mode = 'provider'; state.settings.llmProvider = 'openrouter';
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const stateValue = { status: 'ready' as const, snapshot, busy: false, refreshRequired: false };
    const commands: WorkspaceCommand[] = [];
    let commandNumber = 0;
    const execute = vi.fn(async (command: WorkspaceCommand, admitted?: (envelope: { schemaVersion: 1; commandId: string; expectedRevision: number; expectedPrivacyEpoch: number; command: WorkspaceCommand }) => void): Promise<WorkspaceCommandResponse> => {
      commands.push(command);
      const id = `88888888-8888-4888-8888-${String(++commandNumber).padStart(12, '0')}`;
      admitted?.({ schemaVersion: 1, commandId: id, expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch, command });
      if (command.kind === 'chat.transcript.prepare') return { schemaVersion: 1, commandId: id, status: 'finished', receipt: {
        schemaVersion: 1, commandId: id, kind: command.kind, objectId: command.noteId, noteId: command.noteId, noteRevision: command.expectedNoteRevision,
        planId: '99999999-9999-4999-8999-999999999999', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        capturedAt: note.capturedAt!, captureTimeZone: note.captureTimeZone!,
      } };
      if (command.kind === 'chat.transcript.submit') return { schemaVersion: 1, commandId: id, status: 'finished', receipt: {
        schemaVersion: 1, commandId: id, kind: command.kind, objectId: command.conversationId, conversationId: command.conversationId,
        planId: command.planId, turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      } };
      throw new Error(`Unexpected command ${command.kind}`);
    });
    const store = { getSnapshot: () => stateValue, execute, inspect: vi.fn(), refresh: vi.fn(async () => snapshot) };
    const transferCoordinator = transcriptCoordinatorFor(store);
    const credentials = { presence: { openrouter: true } } as never;
    act(() => root.render(<CloudWorkspace store={store} state={stateValue} onLogout={vi.fn()} credentials={credentials} transcriptTransferCoordinator={transferCoordinator} />));
    click('Library'); click('Notes'); click('A saved DTO note');
    click('Use saved transcript in Chat');
    await act(async () => { await Promise.resolve(); });
    expect(commands).toEqual([{ kind: 'chat.transcript.prepare', noteId: note.id, expectedNoteRevision: note.revision }]);
    expect(host.textContent).toContain('Use saved transcript in Chat');
    expect(host.textContent).toContain('A saved DTO note');
    expect(host.textContent).toContain('Send saved transcript');
    expect(commands.some((command) => command.kind === 'chat.submit' || command.kind === 'chat.transcript.submit')).toBe(false);
    click('Saved conversation');
    click('Send saved transcript');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(commands.map((command) => command.kind)).toEqual(['chat.transcript.prepare', 'chat.transcript.submit']);
    expect(commands[1]).toEqual({ kind: 'chat.transcript.submit', planId: '99999999-9999-4999-8999-999999999999', conversationId: '77777777-7777-4777-8777-777777777777' });
    expect(host.textContent).toContain('The saved transcript was added to Chat.');
  });

  it('retains transcript plans and an ambiguous submit across CloudWorkspace unmount without resending', async () => {
    const { state } = fixture();
    const note = state.notes[0]!;
    note.capturedAt = '2026-10-14T23:00:00.000Z';
    note.captureTimeZone = 'Asia/Singapore';
    state.settings.mode = 'provider'; state.settings.llmProvider = 'openrouter';
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    let commandId = '';
    let submitCommandId = '';
    let preparePosts = 0;
    let submitPosts = 0;
    let exactInspections = 0;
    const commandKinds = new Map<string, string>();
    const planId = '99999999-9999-4999-8999-999999999999';
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata(true) };
      if ((path === '/api/workspace/snapshot' && method === 'GET') || (path === '/api/workspace/refresh' && method === 'POST')) return { ok: true, status: 200, json: async () => snapshot };
      if (path === '/api/workspace/commands' && method === 'POST') {
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: WorkspaceCommand };
        if (envelope.command.kind === 'chat.transcript.prepare') { preparePosts += 1; commandId = envelope.commandId; }
        else if (envelope.command.kind === 'chat.transcript.submit') { submitPosts += 1; submitCommandId = envelope.commandId; }
        else throw new Error('Only explicit transcript review and send commands should be posted.');
        commandKinds.set(envelope.commandId, envelope.command.kind);
        return Promise.reject(new TypeError('connection lost after admission'));
      }
      if ((path === `/api/workspace/commands/${commandId}` || path === `/api/workspace/commands/${submitCommandId}`) && method === 'GET') {
        exactInspections += 1;
        if (commandKinds.get(path.split('/').at(-1) ?? '') === 'chat.transcript.submit') {
          return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: submitCommandId, status: 'inspect_required' }) };
        }
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId, status: 'finished', receipt: {
          schemaVersion: 1, commandId, kind: 'chat.transcript.prepare', objectId: note.id, noteId: note.id, noteRevision: note.revision,
          planId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), capturedAt: note.capturedAt, captureTimeZone: note.captureTimeZone,
        } }) };
      }
      throw new Error(`Unexpected transcript workflow request ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const session = Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'transcript-csrf' });
    const store = new CloudWorkspaceSessionStore(session);
    const stop = store.start();
    function Route() {
      const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      if (!current.snapshot) return React.createElement('div', null, current.status);
      return React.createElement(CloudWorkspace, { store, state: current, onLogout: vi.fn(), credentials: { presence: { openrouter: true } } as never,
        transcriptTransferCoordinator: store.getTranscriptTransferCoordinator() });
    }
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      await act(async () => root.render(React.createElement(Route)));
      click('Library'); click('Notes'); click('A saved DTO note'); click('Use saved transcript in Chat');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(preparePosts).toBe(1);
      expect(store.getSnapshot().pendingCommand?.commandId).toBe(commandId);

      await act(async () => root.render(React.createElement('div', null, 'Settings')));
      await act(async () => root.render(React.createElement(Route)));
      expect(host.textContent).toContain('Inspect exact chat.transcript.prepare command');
      click('Inspect exact chat.transcript.prepare command');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(exactInspections).toBe(1);
      expect(preparePosts).toBe(1);
      expect(store.getSnapshot().transcriptTransfer?.plan?.planId).toBe(planId);
      expect(store.getSnapshot().pendingCommand).toBeUndefined();
      expect(store.getSnapshot().refreshRequired, store.getSnapshot().error).toBe(false);
      click('Library'); click('Notes'); click('A saved DTO note');
      expect(host.textContent).toContain('Send saved transcript');
      click('Saved conversation');
      expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Send saved transcript'))?.disabled).toBe(false);
      click('Send saved transcript');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(submitPosts).toBe(1);
      expect(store.getSnapshot().pendingCommand?.commandId).toBe(submitCommandId);
      await act(async () => root.render(React.createElement('div', null, 'Settings')));
      await act(async () => root.render(React.createElement(Route)));
      click('Inspect exact chat.transcript.submit command');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(exactInspections).toBe(2);
      expect(submitPosts).toBe(1);
      expect(host.textContent).toContain('not confirmed yet');
      expect(localStorage.length).toBe(0);
    } finally { stop(); vi.unstubAllGlobals(); }
  });

  it('recovers a terminal transcript receipt by exact GET and preserves it through a failed explicit refresh', async () => {
    const { state } = fixture();
    const note = state.notes[0]!;
    note.capturedAt = '2026-10-14T23:00:00.000Z'; note.captureTimeZone = 'Asia/Singapore';
    state.settings.mode = 'provider'; state.settings.llmProvider = 'openrouter';
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const session = Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'terminal-transcript-csrf' });
    const requests: { path: string; method: string }[] = [];
    const commands = new Map<string, WorkspaceCommand>();
    const prepareIds: string[] = [];
    let submitCommandId = '';
    let refreshCount = 0;
    let exactGets = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET'; requests.push({ path, method });
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata(true) };
      if (path === '/api/workspace/snapshot' && method === 'GET') return { ok: true, status: 200, json: async () => snapshot };
      if (path === '/api/workspace/refresh' && method === 'POST') {
        refreshCount += 1;
        if (refreshCount === 1) return { ok: false, status: 503, json: async () => ({ error: 'temporary refresh failure' }) };
        return { ok: true, status: 200, json: async () => snapshot };
      }
      if (path === '/api/workspace/commands' && method === 'POST') {
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: WorkspaceCommand };
        commands.set(envelope.commandId, envelope.command);
        if (envelope.command.kind === 'chat.transcript.prepare') {
          prepareIds.push(envelope.commandId);
          const planId = prepareIds.length === 1 ? '99999999-9999-4999-8999-999999999999' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
          return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: {
            schemaVersion: 1, commandId: envelope.commandId, kind: 'chat.transcript.prepare', objectId: note.id, noteId: note.id,
            noteRevision: note.revision, planId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            capturedAt: note.capturedAt, captureTimeZone: note.captureTimeZone,
          }, snapshot }) };
        }
        if (envelope.command.kind === 'chat.transcript.submit') {
          submitCommandId = envelope.commandId;
          return Promise.reject(new TypeError('connection lost after command admission'));
        }
        throw new Error(`Unexpected command ${envelope.command.kind}`);
      }
      if (path === `/api/workspace/commands/${submitCommandId}` && method === 'GET') {
        exactGets += 1;
        const command = commands.get(submitCommandId);
        if (command?.kind !== 'chat.transcript.submit') throw new Error('The exact inspection must target the submitted command.');
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: submitCommandId, status: 'finished', receipt: {
          schemaVersion: 1, commandId: submitCommandId, kind: command.kind, objectId: command.conversationId,
          conversationId: command.conversationId, planId: command.planId, outcome: 'not_submitted', reason: 'plan_unavailable',
        } }) };
      }
      throw new Error(`Unexpected transcript recovery request ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const store = new CloudWorkspaceSessionStore(session);
    const stop = store.start();
    function Route() {
      const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      if (!current.snapshot) return React.createElement('div', null, current.status);
      return React.createElement(CloudWorkspace, { store, state: current, onLogout: vi.fn(), credentials: { presence: { openrouter: true } } as never,
        transcriptTransferCoordinator: store.getTranscriptTransferCoordinator() });
    }
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      await act(async () => root.render(React.createElement(Route)));
      click('Library'); click('Notes'); click('A saved DTO note'); click('Use saved transcript in Chat');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Saved conversation'); click('Send saved transcript');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(store.getSnapshot().pendingCommand?.commandId).toBe(submitCommandId);
      click('Inspect exact chat.transcript.submit command');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(exactGets).toBe(1);
      expect(store.getSnapshot().pendingCommand).toBeUndefined();
      expect(store.getSnapshot().refreshRequired).toBe(true);
      expect(store.getSnapshot().transcriptTransfer?.notice).toBe('This command did not submit a Chat message. Review the saved transcript again.');

      click('Refresh workspace');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(refreshCount).toBe(1);
      expect(store.getSnapshot().refreshRequired).toBe(true);
      expect(store.getSnapshot().transcriptTransfer?.notice).toBe('This command did not submit a Chat message. Review the saved transcript again.');
      click('Refresh workspace');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(refreshCount).toBe(2);
      expect(store.getSnapshot().refreshRequired).toBe(false);
      click('Library'); click('Notes'); click('A saved DTO note'); click('Use saved transcript in Chat');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(prepareIds).toHaveLength(2);
      expect(requests.filter((request) => request.path === '/api/workspace/commands' && request.method === 'POST')).toHaveLength(3);
      expect(requests.filter((request) => request.path === `/api/workspace/commands/${submitCommandId}` && request.method === 'GET')).toHaveLength(1);
    } finally { stop(); vi.unstubAllGlobals(); }
  });

  it('offers a new transcript review only after a matching terminal not-submitted receipt', async () => {
    const { state } = fixture();
    const note = state.notes[0]!;
    const conversation = state.assistantChatConversations?.[0];
    if (!conversation) throw new Error('The fixture needs a saved conversation.');
    note.capturedAt = '2026-10-14T23:00:00.000Z'; note.captureTimeZone = 'Asia/Singapore';
    state.settings.mode = 'provider'; state.settings.llmProvider = 'openrouter';
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const stateValue = { status: 'ready' as const, snapshot, busy: false, refreshRequired: false };
    const commands: WorkspaceCommand[] = [];
    let sequence = 0;
    const execute = vi.fn(async (command: WorkspaceCommand, admitted?: (envelope: WorkspaceCommandAdmission) => void): Promise<WorkspaceCommandResponse> => {
      commands.push(command);
      const commandId = `88888888-8888-4888-8888-${String(++sequence).padStart(12, '0')}`;
      admitted?.({ schemaVersion: 1, commandId, expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch, command });
      if (command.kind === 'chat.transcript.prepare') return { schemaVersion: 1, commandId, status: 'finished', receipt: {
        schemaVersion: 1, commandId, kind: command.kind, objectId: command.noteId, noteId: command.noteId, noteRevision: command.expectedNoteRevision,
        planId: `99999999-9999-4999-8999-${String(sequence).padStart(12, '0')}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        capturedAt: note.capturedAt!, captureTimeZone: note.captureTimeZone!,
      } };
      if (command.kind === 'chat.transcript.submit') return { schemaVersion: 1, commandId, status: 'finished', receipt: {
        schemaVersion: 1, commandId, kind: command.kind, objectId: command.conversationId, planId: command.planId,
        conversationId: command.conversationId, outcome: 'not_submitted', reason: 'plan_unavailable',
      } };
      throw new Error(`Unexpected command ${command.kind}`);
    });
    const store = { ...stateValue, getSnapshot: () => stateValue, execute, inspect: vi.fn(), refresh: vi.fn(async () => snapshot) };
    const transferCoordinator = transcriptCoordinatorFor(store);
    act(() => root.render(<CloudWorkspace store={store} state={stateValue} onLogout={vi.fn()} credentials={{ presence: { openrouter: true } } as never} transcriptTransferCoordinator={transferCoordinator} />));
    click('Library'); click('Notes'); click('A saved DTO note'); click('Use saved transcript in Chat');
    await act(async () => { await Promise.resolve(); });
    click('Saved conversation'); click('Send saved transcript');
    await act(async () => { await Promise.resolve(); });
    expect(commands.map((command) => command.kind)).toEqual(['chat.transcript.prepare', 'chat.transcript.submit']);
    expect(transferCoordinator.getSnapshot()).toEqual({ busy: false, notice: 'This command did not submit a Chat message. Review the saved transcript again.' });
    expect(host.textContent).toContain('This command did not submit a Chat message. Review the saved transcript again.');
    click('Use saved transcript in Chat');
    await act(async () => { await Promise.resolve(); });
    expect(commands.map((command) => command.kind)).toEqual(['chat.transcript.prepare', 'chat.transcript.submit', 'chat.transcript.prepare']);
  });

  it('suppresses a transcript inspection result when the session is replaced during its deferred refresh', async () => {
    const { state } = fixture();
    const note = state.notes[0]!;
    const conversation = state.assistantChatConversations?.[0];
    if (!conversation) throw new Error('The fixture needs a saved conversation.');
    note.capturedAt = '2026-10-14T23:00:00.000Z';
    note.captureTimeZone = 'Asia/Singapore';
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const newWorkspaceId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const replacementSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: newWorkspaceId, privacyEpoch: 4, revision: 1 });
    const refreshResponse = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const refreshStarted = deferred<void>();
    const commandKinds = new Map<string, string>();
    let prepareCommandId = '';
    let submitCommandId = '';
    let snapshotReads = 0;
    const planId = '99999999-9999-4999-8999-999999999999';
    const turnId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const isReplacement = headers.get('x-still-csrf') === 'replacement-csrf';
      if (path === '/api/credentials' && method === 'GET') return { ok: true, status: 200, json: async () => credentialMetadata(true, false, isReplacement ? 4 : 3, isReplacement ? newWorkspaceId : workspaceId) };
      if (path === '/api/workspace/snapshot' && method === 'GET') {
        snapshotReads += 1;
        return { ok: true, status: 200, json: async () => snapshotReads === 1 ? snapshot : replacementSnapshot };
      }
      if (path === '/api/workspace/commands' && method === 'POST') {
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: WorkspaceCommand };
        commandKinds.set(envelope.commandId, envelope.command.kind);
        if (envelope.command.kind === 'chat.transcript.prepare') {
          prepareCommandId = envelope.commandId;
          return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: prepareCommandId, status: 'finished', receipt: {
            schemaVersion: 1, commandId: prepareCommandId, kind: 'chat.transcript.prepare', objectId: note.id, noteId: note.id, noteRevision: note.revision,
            planId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), capturedAt: note.capturedAt, captureTimeZone: note.captureTimeZone,
          }, snapshot }) };
        }
        if (envelope.command.kind === 'chat.transcript.submit') {
          submitCommandId = envelope.commandId;
          return Promise.reject(new TypeError('connection lost after command admission'));
        }
        throw new Error(`Unexpected command ${envelope.command.kind}`);
      }
      if (path === `/api/workspace/commands/${submitCommandId}` && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, commandId: submitCommandId, status: 'finished', receipt: {
          schemaVersion: 1, commandId: submitCommandId, kind: 'chat.transcript.submit', objectId: conversation.id,
          planId, conversationId: conversation.id, turnId, jobId,
        } }) };
      }
      if (path === '/api/workspace/refresh' && method === 'POST') {
        if (isReplacement) return { ok: true, status: 200, json: async () => replacementSnapshot };
        refreshStarted.resolve();
        return refreshResponse.promise;
      }
      throw new Error(`Unexpected session replacement request ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const oldStore = new CloudWorkspaceSessionStore(Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'old-csrf' }));
    const stopOld = oldStore.start();
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const transfer = oldStore.getTranscriptTransferCoordinator()!;
      await act(async () => { await transfer.prepare(note.id, note.revision); });
      expect(oldStore.getSnapshot().transcriptTransfer?.plan?.planId).toBe(planId);
      await act(async () => { await transfer.submit(planId, conversation.id); });
      expect(oldStore.getSnapshot().pendingCommand?.commandId).toBe(submitCommandId);

      const inspection = transfer.inspect(submitCommandId);
      await refreshStarted.promise;
      const replacementStore = new CloudWorkspaceSessionStore(Object.freeze({ authenticated: true, workspaceId: newWorkspaceId, privacyEpoch: 4, csrfToken: 'replacement-csrf' }));
      const stopReplacement = replacementStore.start();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
      stopOld();
      refreshResponse.resolve({ ok: true, status: 200, json: async () => snapshot });
      await act(async () => { await inspection; await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(transfer.getSnapshot()).toEqual({ busy: false });
      expect(replacementStore.getSnapshot().snapshot?.workspaceId, JSON.stringify(replacementStore.getSnapshot())).toBe(newWorkspaceId);
      expect(fetcher.mock.calls.filter(([path, init]) => String(path) === '/api/workspace/commands' && (init?.method ?? 'GET') === 'POST')).toHaveLength(2);
      stopReplacement();
    } finally { stopOld(); vi.unstubAllGlobals(); }
  });

  it('refuses chat deletion if the reviewed workspace revision changed before confirmation', async () => {
    const { state } = fixture();
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    let latest = { status: 'ready' as const, snapshot, busy: false, refreshRequired: false };
    const execute = vi.fn();
    const store = { getSnapshot: () => latest, execute, inspect: vi.fn(), refresh: vi.fn(async () => snapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={latest} onLogout={vi.fn()} />));
    click('Chat'); click('Open conversation Saved conversation'); click('Delete conversation');
    latest = { ...latest, snapshot: createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 }) };
    clickOccurrence('Delete conversation', 1);
    await act(async () => { await Promise.resolve(); });
    expect(execute).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Reopen the confirmation before trying again.');
  });

  it('does not submit a reviewed transcript after the saved note revision changes', async () => {
    const { state } = fixture();
    const note = state.notes[0]!;
    note.capturedAt = '2026-10-14T23:00:00.000Z'; note.captureTimeZone = 'Asia/Singapore';
    state.settings.mode = 'provider'; state.settings.llmProvider = 'openrouter';
    const initialSnapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const stateValue: { status: 'ready'; snapshot: typeof initialSnapshot; busy: boolean; refreshRequired: boolean } = { status: 'ready', snapshot: initialSnapshot, busy: false, refreshRequired: false };
    const commands: WorkspaceCommand[] = [];
    const execute = vi.fn(async (command: WorkspaceCommand) => {
      commands.push(command);
      if (command.kind !== 'chat.transcript.prepare') throw new Error('A stale review must not submit.');
      return { schemaVersion: 1 as const, commandId: '88888888-8888-4888-8888-888888888888', status: 'finished' as const, receipt: {
        schemaVersion: 1 as const, commandId: '88888888-8888-4888-8888-888888888888', kind: command.kind, objectId: command.noteId, noteId: command.noteId,
        noteRevision: command.expectedNoteRevision, planId: '99999999-9999-4999-8999-999999999999', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        capturedAt: note.capturedAt!, captureTimeZone: note.captureTimeZone!,
      } };
    });
    const store = { getSnapshot: () => stateValue, execute, inspect: vi.fn(), refresh: vi.fn(async () => stateValue.snapshot) };
    const transferCoordinator = transcriptCoordinatorFor(store);
    act(() => root.render(<CloudWorkspace store={store} state={stateValue} onLogout={vi.fn()} credentials={{ presence: { openrouter: true } } as never} transcriptTransferCoordinator={transferCoordinator} />));
    click('Library'); click('Notes'); click('A saved DTO note'); click('Use saved transcript in Chat');
    await act(async () => { await Promise.resolve(); });
    note.revision += 1; note.transcript = 'Changed after review';
    stateValue.snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 8 });
    act(() => root.render(<CloudWorkspace store={store} state={stateValue} onLogout={vi.fn()} credentials={{ presence: { openrouter: true } } as never} transcriptTransferCoordinator={transferCoordinator} />));
    expect(commands).toEqual([{ kind: 'chat.transcript.prepare', noteId: note.id, expectedNoteRevision: 1 }]);
    expect(host.textContent).not.toContain('Send saved transcript');
    expect(host.textContent).toContain('Use saved transcript in Chat');
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
    expect(host.textContent).toContain('Recent saved mail');
    expect(host.textContent).toContain('A proposal from the snapshot');
    click('Activity section');
    expect(host.textContent).toContain('Workspace activity');
    click('History section');
    expect(host.textContent).toContain('Saved requests');
    expect(host.textContent).toContain('Saved dispatches');
    click('Mail and calendar section');
    expect(host.textContent).toContain('Saved mail is checked only when you ask.');
    expect(host.textContent).toContain('Choose an account above to see its saved mail and calendars.');
    expect(host.textContent).not.toContain('Saved mail snapshot');
  });

  it('keeps approval unavailable while a reviewed proposal has unsaved field edits', async () => {
    const { state } = fixture();
    state.accounts[0].connectionGeneration = 4;
    for (let index = 0; index < 12; index += 1) state.mailbox.push({ id: `saved-${index}`, accountId: state.accounts[0].id,
      providerMessageId: `provider-${index}`, identityKey: `identity-${index}`, verifiedIdentityKey: `verified-${index}`, connectionGeneration: 4,
      subject: `Saved message ${index}`, observedAt: `2026-10-15T00:${String(index).padStart(2, '0')}:00.000Z` } satisfies MailboxSnapshotMessage);
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const proposalId = '55555555-5555-4555-8555-555555555555';
    const execute = vi.fn(async (): Promise<WorkspaceCommandResponse> => { throw new Error('dirty proposal must not dispatch'); });
    const port: CloudMailWorkspacePort = {
      readSnapshot: () => snapshot,
      readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
      readMailReplySource: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7, status: 'current' as const,
        source: { accountId: state.accounts[0].id, connectionGeneration: 4, localMessageId: 'saved-0', providerMessageId: 'provider-0', idFormat: 'gmail' as const,
          internetMessageId: '<saved-0@example.test>', subject: 'Saved message 0', observedAt: '2026-10-15T00:00:00.000Z', sourceDigest: 'mail-source-digest' },
        defaults: { reply: { to: ['sender@example.test'], cc: [] }, reply_all: { to: ['sender@example.test'], cc: ['team@example.test'] } },
        bodyCache: { status: 'current' as const, completeness: 'unavailable' as const, representation: 'none' as const } })),
      readMailReplyText: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7, status: 'current' as const })),
      readProposalReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7, proposal: {
        editPolicy: 'email_fields' as const, canDeriveManualReply: false, id: proposalId, kind: 'email' as const, title: 'Editable proposal', body: 'Saved body', status: 'draft' as const, revision: 1,
        accountId: '22222222-2222-4222-8222-222222222222', recipients: ['person@example.test'],
        email: { operation: 'draft' as const, to: ['person@example.test'], cc: [], bcc: [], subject: 'Saved subject', text: 'Saved text', attachments: [] },
      } })),
      readDispatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7 })),
      readReplyBatchReview: vi.fn(async (plan) => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7, plan: {
        planId: plan.planId, jobId: plan.jobId, messageId: 'saved-0', accountId: plan.accountId, connectionGeneration: plan.expectedConnectionGeneration,
        mode: 'reply_all' as const, operation: 'draft' as const, subject: 'Reviewed reply', to: ['sender@example.test'], cc: ['team@example.test'],
        text: 'A reviewed delayed result', expiresAt: '2099-01-01T00:00:00.000Z',
      } })),
      execute,
      inspect: vi.fn(async () => { throw new Error('not used'); }),
      refresh: vi.fn(async () => snapshot),
    };
    const coordinator = new CloudMailCoordinator(port);
    coordinator.selectAccount(state.accounts[0].id);
    await coordinator.openReply('saved-0');
    await coordinator.reviewBatchPlan({ planId: '99999999-9999-4999-8999-999999999999', jobId: '88888888-8888-4888-8888-888888888888',
      accountId: state.accounts[0].id, expectedConnectionGeneration: 4 });
    await act(async () => { await coordinator.openProposal(proposalId); });
    act(() => root.render(<CloudMailWorkspace coordinator={coordinator} snapshot={snapshot} busy={false} blocked={false} />));
    expect(host.textContent).toContain('Show more saved mail (2 remaining)');
    click('Show more saved mail');
    expect(host.textContent).toContain('Saved message 11');
    expect(host.textContent).toContain('Review delayed reply result');
    expect(host.textContent).toContain('A reviewed delayed result');
    const message = host.querySelector('textarea[aria-label="Message"]');
    expect(message).not.toBeNull();
    act(() => {
      const input = message as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'Edited but not saved');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const approve = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Approve this revision');
    expect(approve?.disabled).toBe(true);
    expect(host.textContent).toContain('These fields have unsaved changes. Save them before approval or execution.');
    expect(execute).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('shows the complete saved task proposal from Inbox before sending a separate approval command', async () => {
    const { state } = fixture();
    const proposalId = '99999999-9999-4999-8999-999999999999';
    const proposal: Proposal = { id: proposalId, noteId: '33333333-3333-4333-8333-333333333333', kind: 'task',
      title: 'Prepare launch checklist', body: 'Confirm owners and delivery dates before the review.', status: 'draft', revision: 2,
      recipients: [], sourceRevision: 1, dueAt: '2026-10-20T09:30:00.000Z', evidence: [{ quote: 'We should confirm the launch owners.', source: 'Planning notes' }] };
    state.proposals.splice(0, state.proposals.length, proposal);
    state.proposals.push({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'memory', title: 'Approved memory proposal',
      body: 'This still needs its separate execution step.', status: 'approved', revision: 1, recipients: [], evidence: [] },
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'memory', title: 'Dismissed memory proposal',
      body: 'This has left the review queue.', status: 'dismissed', revision: 1, recipients: [], evidence: [] });
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    let reviewStatus: 'draft' | 'approved' = 'draft';
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => {
      if (command.kind !== 'proposals.approve') throw new Error(`Unexpected command ${command.kind}`);
      reviewStatus = 'approved';
      return { schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId, kind: 'proposals.approve',
        objectId: proposalId, proposalId, proposalRevision: 2, proposalStatus: 'approved' } };
    });
    const mailCoordinator = new CloudMailCoordinator({
      readSnapshot: () => snapshot, readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
      readMailReplySource: vi.fn(async () => { throw new Error('not used'); }), readMailReplyText: vi.fn(async () => { throw new Error('not used'); }),
      readProposalReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7, proposal: {
        editPolicy: 'read_only' as const, canDeriveManualReply: false, id: proposalId, kind: 'task' as const, title: proposal.title, body: proposal.body, status: reviewStatus,
        revision: proposal.revision, recipients: [], dueAt: proposal.dueAt,
      } })),
      readDispatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7 })),
      readReplyBatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7 })),
      execute, inspect: vi.fn(async () => { throw new Error('not used'); }), refresh: vi.fn(async () => snapshot),
    });
    const store = { getSnapshot: () => ({ status: 'ready', snapshot, busy: false, refreshRequired: false } satisfies CloudWorkspaceSessionState),
      execute: vi.fn(async () => { throw new Error('workspace action should use the exact proposal capability'); }),
      inspect: vi.fn(async () => { throw new Error('not used'); }), refresh: vi.fn(async () => snapshot) };
    act(() => root.render(<CloudWorkspace store={store} state={store.getSnapshot()} onLogout={vi.fn()} mailCoordinator={mailCoordinator} />));
    click('Inbox');
    expect(host.textContent).toContain('Prepare launch checklist');
    expect(host.textContent).toContain('Approved memory proposal');
    expect(host.textContent).not.toContain('Dismissed memory proposal');
    click('Saved actions');
    expect(host.textContent).toContain('Dismissed memory proposal');
    expect(host.textContent).not.toContain('Prepare launch checklist');
    expect(host.textContent).not.toContain('Approved memory proposal');
    click('To review proposals');
    expect(host.textContent).toContain('Prepare launch checklist');
    expect(host.textContent).toContain('Approved memory proposal');
    expect(host.textContent).not.toContain('Dismissed memory proposal');
    click('Review details');
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('Confirm owners and delivery dates before the review.');
    expect(host.textContent).toContain('Due ·');
    expect(host.textContent).toContain('Source note · A saved DTO note · revision 1');
    expect(host.textContent).toContain('Saved supporting details');
    expect(host.textContent).toContain('We should confirm the launch owners. · Planning notes');
    expect(host.textContent).toContain('Approve this revision');
    expect(execute).not.toHaveBeenCalled();

    click('Approve this revision');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ kind: 'proposals.approve', proposalId, expectedProposalRevision: 2 });
    expect(execute.mock.calls[0]?.[0].kind).toBe('proposals.approve');
    expect(host.textContent).toContain('Execute approved action');
    expect(execute.mock.calls.every(([command]) => command.kind === 'proposals.approve')).toBe(true);
    mailCoordinator.dispose();
  });

  it('does not publish a saved proposal review after its real workspace session is replaced', async () => {
    const oldState = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
    const oldProposalId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    oldState.proposals.push({ id: oldProposalId, kind: 'task', title: 'Old workspace proposal', body: 'Must not appear after logout.',
      status: 'draft', revision: 1, recipients: [], evidence: [] });
    const newState = createInitialWorkspaceState(() => '22222222-2222-4222-8222-222222222222');
    const sessionA = { authenticated: true as const, workspaceId, privacyEpoch: 3, csrfToken: 'mail-owner-a' };
    const sessionB = { authenticated: true as const, workspaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', privacyEpoch: 4, csrfToken: 'mail-owner-b' };
    const delayedReview = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    let snapshotCount = 0;
    let credentialsCount = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input); const method = init?.method ?? 'GET';
      if (path === '/api/credentials' && method === 'GET') {
        const index = credentialsCount++;
        const session = index === 0 ? sessionA : sessionB;
        return { ok: true, status: 200, json: async () => credentialMetadata(false, false, session.privacyEpoch, session.workspaceId) };
      }
      if (path === '/api/workspace/snapshot' && method === 'GET') {
        const index = snapshotCount++;
        const session = index === 0 ? sessionA : sessionB;
        return { ok: true, status: 200, json: async () => createWorkspaceSnapshotDTO({ getSnapshot: () => index === 0 ? oldState : newState }, {
          workspaceId: session.workspaceId, privacyEpoch: session.privacyEpoch, revision: index === 0 ? 7 : 1,
        }) };
      }
      if (path.startsWith('/api/workspace/proposals/review?') && method === 'GET') return delayedReview.promise;
      throw new Error(`Unexpected request during review-owner test: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await act(async () => { root.render(<CloudWorkspaceSession key="mail-session-a" session={sessionA} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      click('Inbox');
      click('Review details');
      await act(async () => { await Promise.resolve(); });
      expect(fetcher.mock.calls.some(([path]) => String(path).startsWith('/api/workspace/proposals/review?'))).toBe(true);

      await act(async () => { root.render(<CloudWorkspaceSession key="mail-session-b" session={sessionB} onLogout={vi.fn()} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).not.toContain('Old workspace proposal');
      delayedReview.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, workspaceId: sessionA.workspaceId, privacyEpoch: sessionA.privacyEpoch,
        revision: 7, proposal: { editPolicy: 'read_only', id: oldProposalId, kind: 'task', title: 'Old workspace proposal',
          body: 'Must not appear after logout.', status: 'draft', revision: 1, recipients: [] } }) });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).not.toContain('Old workspace proposal');
      expect(fetcher.mock.calls.filter(([path, init]) => String(path) === '/api/workspace/commands' && init?.method === 'POST')).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it('renders an immutable saved Batch reply for review without exposing editable fields', async () => {
    const { snapshot, state } = fixture();
    const proposalId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const coordinator = new CloudMailCoordinator({
      readSnapshot: () => snapshot, readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
      readMailReplySource: vi.fn(async () => { throw new Error('not used'); }), readMailReplyText: vi.fn(async () => { throw new Error('not used'); }),
      readProposalReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7, proposal: {
        editPolicy: 'read_only' as const, canDeriveManualReply: false, id: proposalId, kind: 'email' as const, title: 'Batch reply for review', body: 'A fixed server-generated reply.',
        status: 'draft' as const, revision: 3, accountId: state.accounts[0].id, recipients: ['sender@example.test'],
        email: { operation: 'draft' as const, to: ['sender@example.test'], cc: [], bcc: [], subject: 'Re: Planning', text: 'We can meet Tuesday.',
          attachments: [{ fileName: 'agenda.pdf', mimeType: 'application/pdf', sizeBytes: 128 }] },
      } })),
      readDispatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7 })),
      readReplyBatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7 })),
      execute: vi.fn(async () => { throw new Error('reviewing a Batch reply must not dispatch a mutation'); }),
      inspect: vi.fn(async () => { throw new Error('not used'); }), refresh: vi.fn(async () => snapshot),
    });
    await act(async () => { await coordinator.openProposal(proposalId); });
    act(() => root.render(<CloudMailWorkspace coordinator={coordinator} snapshot={snapshot} busy={false} blocked={false} />));
    expect(host.textContent).toContain('This saved reply cannot be edited.');
    expect(host.textContent).toContain('Re: Planning');
    expect(host.textContent).toContain('We can meet Tuesday.');
    expect(host.textContent).toContain('Attachment · agenda.pdf · application/pdf · 128 bytes');
    expect(host.querySelector('[aria-label="Message"]')).toBeNull();
    expect(host.querySelector('[aria-label="Subject"]')).toBeNull();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Approve this revision')).toBe(true);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Execute approved action')).toBe(false);
    coordinator.dispose();
  });

  it('renders an explicit editable copy, saves To/Cc/body and reviewed send operation, then requires fresh approval', async () => {
    const { state } = fixture();
    const account = state.accounts[0]!;
    account.connectionGeneration = 4;
    account.capabilities = ['mail.read', 'mail.draft', 'mail.send'];
    const proposalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
    const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const identity = account.identity!;
    const sourceDigest = 'c'.repeat(64);
    const source = { version: 1 as const, accountId: account.id, accountEmail: account.email, identity, connectionGeneration: 4,
      localMessageId: 'saved-reply-message', providerMessageId: 'provider-reply-message', idFormat: 'gmail' as const,
      threadId: 'saved-reply-thread', internetMessageId: '<saved-reply@example.test>', subject: 'Planning', replyMetadataComplete: true as const,
      observedAt: '2026-10-15T00:00:00.000Z', sourceDigest };
    const parent: Proposal = { id: proposalId, kind: 'email', title: 'Re: Planning', body: 'Generated answer', status: 'draft', revision: 3,
      accountId: account.id, sourceActionKey: 'rendered-reply-source-action', recipients: ['sender@example.test'], evidence: [],
      email: { operation: 'draft', to: ['sender@example.test'], cc: [], bcc: [], subject: 'Planning', text: 'Generated answer', attachments: [],
        reply: { mode: 'reply', sourceDigest, localMessageId: source.localMessageId, providerMessageId: source.providerMessageId, idFormat: 'gmail',
          internetMessageId: source.internetMessageId, sourceSubject: 'Planning', threadId: 'saved-reply-thread' } },
      provenance: { version: 2, kind: 'mail_reply', sourceDigest, source, expiresAt: '2026-10-16T00:00:00.000Z', outputPolicyVersion: 2 } };
    state.proposals.push(parent);
    let workspaceRevision = 7;
    let snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: workspaceRevision });
    const commands: WorkspaceCommand[] = [];
    let commandIndex = 0;
    const refreshSnapshot = () => { workspaceRevision += 1; snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: workspaceRevision }); };
    const readProposal = (id: string, expectedRevision: number) => {
      const item = state.proposals.find((candidate) => candidate.id === id);
      if (!item || !item.email) return { schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: expectedRevision };
      const provenance = item.provenance;
      const digest = provenance && (provenance.version === 2 || provenance.version === 3) ? provenance.sourceDigest : undefined;
      return { schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: expectedRevision, proposal: {
        editPolicy: item.id === proposalId ? 'read_only' as const : 'manual_reply_fields' as const,
        canDeriveManualReply: item.id === proposalId && !item.supersededByProposalId,
        ...(item.supersededByProposalId ? { supersededByProposalId: item.supersededByProposalId } : {}),
        id: item.id, kind: 'email' as const, title: item.title, body: item.body, status: item.status, revision: item.revision,
        ...(item.approvedRevision !== undefined ? { approvedRevision: item.approvedRevision } : {}), accountId: item.accountId, recipients: item.recipients,
        ...(digest ? { sourceDigest: digest } : {}), email: { operation: item.email.operation, to: item.email.to, cc: item.email.cc, bcc: item.email.bcc,
          subject: item.email.subject, text: item.email.text, attachments: [] },
      } };
    };
    const port: CloudMailWorkspacePort = {
      readSnapshot: () => snapshot, readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
      readMailReplySource: vi.fn(async () => { throw new Error('not used'); }), readMailReplyText: vi.fn(async () => { throw new Error('not used'); }),
      readProposalReview: vi.fn(async (id, expectedRevision) => readProposal(id, expectedRevision)),
      readDispatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: workspaceRevision })),
      readReplyBatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: workspaceRevision })),
      execute: vi.fn(async (command, onAdmitted) => {
        commands.push(command);
        const commandId = `rendered-manual-command-${++commandIndex}`;
        onAdmitted?.({ schemaVersion: 1, commandId, expectedRevision: workspaceRevision, expectedPrivacyEpoch: 3,
          idempotencyKey: commandId, kind: command.kind, canonicalBody: '{}' });
        let receipt: Record<string, unknown>;
        if (command.kind === 'mail.reply.derive') {
          const child: Proposal = { ...structuredClone(parent), id: childId, revision: 1, status: 'draft', approvedRevision: undefined,
            email: { ...parent.email!, operation: command.operation }, provenance: { version: 3, kind: 'manual_mail_reply', sourceDigest,
              source: { ...source }, expiresAt: '2026-10-16T00:00:00.000Z', outputPolicyVersion: 2, operation: command.operation,
              lineage: { kind: 'derived', parentProposalId: proposalId, parentRevision: parent.revision, parentPayloadDigest: 'd'.repeat(64) } } };
          parent.supersededByProposalId = childId;
          state.proposals.unshift(child);
          receipt = { schemaVersion: 1, commandId, kind: command.kind, objectId: childId, parentProposalId: proposalId, proposalId: childId,
            proposalRevision: 1, operation: command.operation };
        } else if (command.kind === 'proposals.edit') {
          const child = state.proposals.find((item) => item.id === command.proposalId)!;
          if (command.edit.kind !== 'email') throw new Error('Expected email edit.');
          child.email = { ...child.email!, operation: command.edit.operation, to: [...command.edit.to], cc: [...command.edit.cc],
            bcc: [...command.edit.bcc], subject: command.edit.subject, text: command.edit.text };
          child.recipients = [...command.edit.to]; child.body = command.edit.text; child.revision += 1; child.status = 'draft'; child.approvedRevision = undefined;
          receipt = { schemaVersion: 1, commandId, kind: command.kind, objectId: child.id, proposalId: child.id, proposalRevision: child.revision, proposalStatus: 'draft' };
        } else if (command.kind === 'proposals.approve') {
          const child = state.proposals.find((item) => item.id === command.proposalId)!;
          child.status = 'approved'; child.approvedRevision = child.revision;
          receipt = { schemaVersion: 1, commandId, kind: command.kind, objectId: child.id, proposalId: child.id, proposalRevision: child.revision, proposalStatus: 'approved' };
        } else throw new Error(`Unexpected command ${command.kind}`);
        refreshSnapshot();
        return { schemaVersion: 1, commandId, status: 'finished', receipt } as WorkspaceCommandResponse;
      }),
      inspect: vi.fn(async () => { throw new Error('not used'); }), refresh: vi.fn(async () => snapshot),
    };
    const coordinator = new CloudMailCoordinator(port);
    await act(async () => { await coordinator.openProposal(proposalId); });
    act(() => root.render(<CloudMailWorkspace coordinator={coordinator} snapshot={snapshot} busy={false} blocked={false} />));
    expect(host.textContent).toContain('Create an editable copy');
    expect(host.querySelector('[aria-label="Message"]')).toBeNull();

    await act(async () => { click('Copy as draft'); click('Edit a copy for review'); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(commands[0]).toMatchObject({ kind: 'mail.reply.derive', parentProposalId: proposalId, expectedParentRevision: 3,
      accountId: account.id, expectedConnectionGeneration: 4, operation: 'draft' });
    expect(host.textContent).toContain('Open saved editable copy');
    expect(coordinator.getSnapshot().proposalReviewId).toBe(proposalId);

    await act(async () => { click('Open saved editable copy'); await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => root.render(<CloudMailWorkspace coordinator={coordinator} snapshot={snapshot} busy={false} blocked={false} />));
    expect(host.querySelector('[aria-label="Message"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Subject"]')).toBeNull();
    expect(host.querySelector('[aria-label="Bcc"]')).toBeNull();
    expect(host.textContent).toContain('Subject · Planning');
    click('Review as send');
    setTextField('To', 'sender@example.test, changed@example.test');
    setTextField('Cc', 'copy@example.test');
    setTextField('Message', 'Human-reviewed reply');
    expect(host.textContent).toContain('Final To · sender@example.test, changed@example.test · Cc · copy@example.test');
    click('Save proposal changes');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(commands[1]).toMatchObject({ kind: 'proposals.edit', expectedProposalRevision: 1, edit: { kind: 'email', operation: 'send',
      to: ['sender@example.test', 'changed@example.test'], cc: ['copy@example.test'], bcc: [], subject: 'Planning', text: 'Human-reviewed reply' } });
    expect(state.proposals.find((item) => item.id === childId)).toMatchObject({ revision: 2, status: 'draft', email: { operation: 'send' } });
    click('Approve this revision');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(commands[2]).toMatchObject({ kind: 'proposals.approve', expectedProposalRevision: 2 });
    expect(commands.some((command) => command.kind === 'proposals.execute')).toBe(false);
    expect((host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement | null)?.value).toBe('Human-reviewed reply');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Execute approved send')).toBe(true);
    coordinator.dispose();
  });

  it('renders provider-specific accepted draft copies with fixed send operation and locked fields', async () => {
    for (const provider of ['google', 'microsoft'] as const) {
      const { state } = fixture();
      const account = state.accounts[0]!;
      const identity = provider === 'google' ? { providerNamespace: 'google' as const, clientId: 'client', subject: 'subject' }
        : { providerNamespace: 'microsoft' as const, clientId: 'client', subject: 'subject', resourceUserId: 'resource-user' };
      account.provider = provider;
      account.identity = identity;
      account.connectionGeneration = 4;
      account.capabilities = ['mail.read', 'mail.send'];
      const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
      const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
      const sourceDigest = 'd'.repeat(64);
      const source = { version: 1 as const, accountId: account.id, accountEmail: account.email, identity, connectionGeneration: 4,
        localMessageId: 'saved-message', providerMessageId: 'provider-message', idFormat: provider === 'google' ? 'gmail' as const : 'graph-immutable' as const,
        threadId: 'saved-thread', internetMessageId: '<saved@example.test>', subject: 'Source subject', replyMetadataComplete: true as const,
        observedAt: '2026-10-15T00:00:00.000Z', sourceDigest };
      const parent: Proposal = { id: parentId, kind: 'email', title: 'Re: Source subject', body: 'Accepted contents', status: 'accepted', revision: 3,
        accountId: account.id, recipients: ['sender@example.test'], evidence: [], supersededByProposalId: childId, remoteOperation: 'draft', remoteId: 'remote-draft',
        email: { operation: 'draft', to: ['sender@example.test'], cc: [], bcc: [], subject: 'Source subject', text: 'Accepted contents', attachments: [],
          reply: { mode: 'reply', sourceDigest, localMessageId: source.localMessageId, providerMessageId: source.providerMessageId, idFormat: source.idFormat,
            internetMessageId: source.internetMessageId, sourceSubject: source.subject, threadId: source.threadId } },
        provenance: { version: 2, kind: 'mail_reply', sourceDigest, source, expiresAt: '2026-10-16T00:00:00.000Z', outputPolicyVersion: 2 } };
      const child: Proposal = { ...structuredClone(parent), id: childId, title: 'Re: Source subject', status: 'draft', revision: 1,
        email: { ...parent.email!, operation: 'send', text: 'Accepted contents' }, provenance: { version: 3, kind: 'manual_mail_reply', sourceDigest,
          source, expiresAt: '2026-10-16T00:00:00.000Z', outputPolicyVersion: 2, operation: 'send',
          lineage: { kind: 'accepted_draft', parentProposalId: parentId, parentRevision: 3, parentPayloadDigest: 'e'.repeat(64),
            draftDispatchRecordId: 'dispatch-1', draftDispatchRecordDigest: 'f'.repeat(64), remoteDraftId: 'remote-draft' } } };
      delete child.supersededByProposalId;
      state.proposals.push(parent, child);
      const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 9 });
      const review = { schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 9, proposal: {
        editPolicy: 'manual_reply_send_fields' as const, canDeriveManualReply: false,
        acceptedDraftCopy: { parentProposalId: parentId, draftDispatchRecordId: 'dispatch-1', provider },
        id: childId, kind: 'email' as const, title: child.title, body: child.body, status: 'draft' as const, revision: 1,
        accountId: account.id, recipients: child.recipients, sourceDigest,
        email: { operation: 'send' as const, to: ['sender@example.test'], cc: [], bcc: [], subject: 'Source subject', text: 'Accepted contents', attachments: [] },
      } };
      const coordinator = new CloudMailCoordinator({
        readSnapshot: () => snapshot, readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
        readMailReplySource: vi.fn(async () => { throw new Error('not used'); }), readMailReplyText: vi.fn(async () => { throw new Error('not used'); }),
        readProposalReview: vi.fn(async () => review), readDispatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 9 })),
        readReplyBatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 9 })),
        execute: vi.fn(async () => { throw new Error('render-only review must not dispatch'); }), inspect: vi.fn(async () => { throw new Error('not used'); }),
        refresh: vi.fn(async () => snapshot),
      });
      await act(async () => { await coordinator.openProposal(childId); });
      act(() => root.render(<CloudMailWorkspace coordinator={coordinator} snapshot={snapshot} busy={false} blocked={false} />));
      expect(host.textContent).toContain(provider === 'google' ? 'Send saved draft with reviewed contents' : 'Send reviewed copy; keep original draft');
      expect(host.textContent).toContain('Provider draft contents have not been rechecked.');
      expect(host.querySelector('[aria-label="Subject"]')).toBeNull();
      expect(host.querySelector('[aria-label="Bcc"]')).toBeNull();
      expect(host.querySelector('[aria-label="Attachments"]')).toBeNull();
      expect(host.textContent).not.toContain('Review as draft');
      expect(host.textContent).not.toContain('Review as send');
      setTextField('To', 'reviewed@example.test');
      setTextField('Message', 'Edited from the saved contents');
      expect(coordinator.getProposalDraft(childId)).toMatchObject({ to: 'reviewed@example.test', text: 'Edited from the saved contents', dirty: true, operation: 'send' });
      coordinator.dispose();
      act(() => root.render(null));
    }
  });

  it('offers explicit writable calendar choices for the proposal account', async () => {
    const { state } = fixture();
    state.accounts[0].connectionGeneration = 4;
    state.calendars.push({ id: 'calendar-a', accountId: state.accounts[0].id, name: 'Main calendar', connected: true, writable: true, providerId: 'provider-a' },
      { id: 'calendar-b', accountId: state.accounts[0].id, name: 'Planning calendar', connected: true, writable: true, providerId: 'provider-b' },
      { id: 'calendar-readonly', accountId: state.accounts[0].id, name: 'Read-only calendar', connected: true, writable: false, providerId: 'provider-ro' });
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
    const proposalId = '55555555-5555-4555-8555-555555555555';
    const port: CloudMailWorkspacePort = {
      readSnapshot: () => snapshot, readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
      readMailReplySource: vi.fn(async () => { throw new Error('not used'); }), readMailReplyText: vi.fn(async () => { throw new Error('not used'); }),
      readProposalReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7, proposal: {
        editPolicy: 'event_fields' as const, canDeriveManualReply: false, id: proposalId, kind: 'event' as const, title: 'Planning session', body: 'Review schedule', status: 'draft' as const, revision: 1,
        accountId: state.accounts[0].id, calendarId: 'calendar-a', recipients: [],
        event: { title: 'Planning session', description: 'Review schedule', start: '2026-10-20T10:00:00Z', end: '2026-10-20T11:00:00Z',
          timeZone: 'Asia/Singapore', attendees: [], invitePolicy: 'none' as const },
      } })),
      readDispatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7 })),
      readReplyBatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7 })),
      execute: vi.fn(async () => { throw new Error('not used'); }), inspect: vi.fn(async () => { throw new Error('not used'); }), refresh: vi.fn(async () => snapshot),
    };
    const coordinator = new CloudMailCoordinator(port);
    await act(async () => { await coordinator.openProposal(proposalId); });
    act(() => root.render(<CloudMailWorkspace coordinator={coordinator} snapshot={snapshot} busy={false} blocked={false} />));
    expect(host.textContent).toContain('Main calendar');
    expect(host.textContent).toContain('Planning calendar');
    expect(host.textContent).not.toContain('Read-only calendar');
    const alternate = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Planning calendar');
    expect(alternate?.disabled).toBe(false);
    click('Planning calendar');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Planning calendar')?.disabled).toBe(true);
    coordinator.dispose();
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
      if (path.startsWith('/api/workspace/knowledge/source-choices?') && method === 'GET') {
        const expectedRevision = Number(new URL(path, 'http://test').searchParams.get('expectedRevision'));
        return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: expectedRevision, choices: [] }) };
      }
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
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain('Add a source link');
      expect(host.textContent).toContain('No saved sources are available to link yet.');
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
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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

describe('cloud background policy session operation ownership', () => {
  it('rehydrates held policy UI state across global busy publishes', async () => {
    const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
    const initial = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 1 });
    let releaseList!: (value: readonly unknown[]) => void;
    const waitingList = new Promise<readonly unknown[]>((resolve) => { releaseList = resolve; });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/workspace/snapshot' && init?.method === 'GET') return { ok: true, status: 200, json: async () => initial };
      if (url.startsWith('/api/workspace/background/policies?') && init?.method === 'GET') return { ok: true, status: 200, json: async () => waitingList };
      throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const store = new CloudWorkspaceSessionStore({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf' });
    const stop = store.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const coordinator = store.getBackgroundPolicyCoordinator();
    expect(coordinator).toBeDefined();
    const loading = coordinator!.loadFirstPage();
    expect(store.getSnapshot().busy).toBe(true);
    expect(store.getSnapshot().backgroundPolicies?.loading).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    releaseList([]);
    await loading;
    expect(store.getSnapshot().busy).toBe(false);
    expect(store.getSnapshot().backgroundPolicies?.loaded).toBe(true);
    stop();
  });
});
