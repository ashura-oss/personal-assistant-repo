/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { Account, LocalTask, MailboxSnapshotMessage, Note, Proposal } from '../src/core';
import type { CloudWorkspaceSessionState } from '../src/web/CloudWorkspaceSession';
import { CloudWorkspace } from '../src/web/CloudWorkspace';
import { CloudWorkspaceSession } from '../src/web/CloudWorkspaceSession';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';
import { WorkspaceClientError } from '../src/web/workspaceClient';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, onPress, onChangeText, style: _style, accessibilityRole: _role, accessibilityState: _state, ...props }: Record<string, unknown> & { children?: React.ReactNode; onPress?: () => void; onChangeText?: (value: string) => void }) => ReactModule.createElement(tag, {
    ...props,
    ...(onPress ? { onClick: onPress } : {}),
    ...(onChangeText ? { onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.target.value) } : {}),
  }, children);
  return { ActivityIndicator: () => ReactModule.createElement('span', null, 'loading'), KeyboardAvoidingView: element('div'), Modal: element('div'), View: element('div'), Text: element('span'), Pressable: element('button'), ScrollView: element('div'), TextInput: element('textarea'), Switch: ({ value, disabled, accessibilityLabel, onValueChange }: { value: boolean; disabled?: boolean; accessibilityLabel: string; onValueChange: (value: boolean) => void }) => ReactModule.createElement('input', { type: 'checkbox', checked: value, disabled, 'aria-label': accessibilityLabel, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onValueChange(event.target.checked) }), StyleSheet: { create: (value: unknown) => value }, Platform: { OS: 'web' } };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  return { SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children), SafeAreaView: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children) };
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

function setTextField(label: string, value: string) {
  const field = host.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement | null;
  if (!field) throw new Error(`Field not found: ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => { setter?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('CloudWorkspace safe DTO presentation', () => {
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

  it('keeps unimplemented shared library actions disabled and explains their current capability', () => {
    const { snapshot, store } = fixture();
    act(() => root.render(<CloudWorkspace store={store} state={{ status: 'ready', snapshot, busy: false, refreshRequired: false }} onLogout={vi.fn()} />));
    click('Library');
    click('Reminders');
    expect(host.textContent).toContain('Reminder creation and management are not connected to server commands yet.');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Add reminder'))?.disabled).toBe(true);
    click('People');
    expect(host.textContent).toContain('People and project editing are not connected to server commands yet.');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Add person'))?.disabled).toBe(true);
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
});
