/** @vitest-environment jsdom */
import React, { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { projectKnowledgeDisplay, projectKnowledgeEntityDisplay } from '../src/ui/libraryDisplay';
import { KnowledgeEntitySheet } from '../src/ui/KnowledgeEntitySheet';
import { KnowledgeSuggestionSheet } from '../src/ui/KnowledgeSuggestionSheet';
import { projectKnowledgeSuggestionForHttp } from '../src/cloud/knowledgeHttpContracts';
import { CloudWorkspaceSessionStore } from '../src/web/CloudWorkspaceSession';
import { createCloudKnowledgeActions } from '../src/web/cloudKnowledgeActions';
import type { AuthenticatedSession } from '../src/web/authClient';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, visible, onPress, onRequestClose, accessibilityLabel, style: _style, accessibilityRole: _role, accessibilityState: _state, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
    if (tag === 'div' && visible === false) return null;
    return ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}), ...(onPress ? { onClick: onPress } : {}), ...(onRequestClose ? { onKeyDown: onRequestClose } : {}) }, children);
  };
  return { Modal: element('div'), Pressable: element('button'), ScrollView: element('div'), Text: element('span'), View: element('div'), KeyboardAvoidingView: element('div'), Platform: { OS: 'web' } };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    Field: ({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) => ReactModule.createElement('label', null, label, ReactModule.createElement('input', { value, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value) })),
    IconButton: ({ label, onPress }: { label: string; onPress: () => void }) => ReactModule.createElement('button', { type: 'button', onClick: onPress }, label),
  };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00' }, s: new Proxy({}, { get: () => ({}) }) }));
vi.mock('@expo/vector-icons/Ionicons', async () => {
  const ReactModule = await import('react');
  return { default: ({ name }: { name: string }) => ReactModule.createElement('span', null, name) };
});
vi.mock('../src/web/CloudWorkspace', () => ({ CloudWorkspace: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: { children: unknown }) => children, SafeAreaView: ({ children }: { children: unknown }) => children }));

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const privacyEpoch = 3;
const session: AuthenticatedSession = Object.freeze({ authenticated: true, workspaceId, privacyEpoch, csrfToken: 'csrf-test' });
const personId = '01234567-89ab-4def-8123-0123456789ab';
const referenceChoiceId = `knowledge-choice-${'a'.repeat(64)}`;
const sourceLinkId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const body = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

let host: HTMLDivElement;
let root: Root;
let cleanup: (() => void) | undefined;
let store: CloudWorkspaceSessionStore;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { cleanup?.(); cleanup = undefined; act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('cloud knowledge rendered session flow', () => {
  it('loads safe source choices and saves only the opaque choice ID through the session command path', async () => {
    const state = createInitialWorkspaceState(() => '33333333-3333-4333-8333-333333333333');
    const timestamp = '2026-10-14T08:00:00.000Z';
    const person: import('../src/knowledge/types').Person = { id: personId, revision: 1, name: 'Maya', aliases: [], narrativePath: `people/${personId}.md`, createdAt: timestamp, updatedAt: timestamp, facts: [], contacts: [], sourceLinks: [] };
    state.knowledge.people.push(person);
    state.documents.push({ path: person.narrativePath, content: 'Maya notes.', revision: 1, updatedAt: timestamp });
    state.documents.push({ path: 'research/launch-plan.md', content: 'Saved planning source.', revision: 2, updatedAt: timestamp });
    let workspaceRevision = 1;
    const snapshot = () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch, revision: workspaceRevision });
    const commands: Record<string, unknown>[] = [];
    let sourceChoiceReads = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if (url === '/api/workspace/snapshot' && method === 'GET') return body(snapshot());
      if (url.startsWith('/api/workspace/knowledge/source-choices?') && method === 'GET') {
        sourceChoiceReads += 1;
        const expectedRevision = Number(new URL(url, 'http://test').searchParams.get('expectedRevision'));
        return body({ schemaVersion: 1, workspaceId, privacyEpoch, revision: expectedRevision,
          choices: [{ id: referenceChoiceId, label: 'Document · launch plan', reference: { kind: 'document', id: 'research/launch-plan.md' } }] });
      }
      if (url === '/api/workspace/commands' && method === 'POST') {
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: Record<string, unknown> };
        const command = envelope.command; commands.push(command);
        if (command.kind !== 'knowledge.sourceLink.save') throw new Error(`Unexpected command ${String(command.kind)}`);
        expect(command).toEqual({ kind: 'knowledge.sourceLink.save', entityKind: 'person', entityId: personId, expectedEntityRevision: 1, referenceChoiceId, label: 'Project decisions' });
        expect(command).not.toHaveProperty('reference');
        person.sourceLinks.push({ id: sourceLinkId, provenance: 'user_authored', createdAt: timestamp, reference: { kind: 'document', id: 'research/launch-plan.md' }, label: 'Project decisions' });
        person.revision += 1; person.updatedAt = timestamp; workspaceRevision += 1;
        const current = snapshot();
        return body({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished',
          receipt: { schemaVersion: 1, commandId: envelope.commandId, kind: command.kind, objectId: personId, entityKind: 'person', entityRevision: person.revision, itemId: sourceLinkId }, snapshot: current });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    store = new CloudWorkspaceSessionStore(session);
    cleanup = store.start();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const actions = createCloudKnowledgeActions(store, { workspaceId, privacyEpoch });
    if (!actions.entities.available || !actions.suggestions.available) throw new Error('Knowledge actions unavailable');
    const entityActions = actions.entities.action;
    function SubscribedEntitySheet() {
      const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const latest = current.snapshot!;
      const knowledge = projectKnowledgeDisplay(latest.state.knowledge);
      const displayPerson = projectKnowledgeEntityDisplay(latest.state.knowledge.people[0]!);
      return React.createElement(KnowledgeEntitySheet, {
        visible: true, kind: 'person', entity: displayPerson, people: knowledge.people, documents: latest.state.documents, references: [],
        workspaceRevision: latest.revision, busy: current.busy, onClose: vi.fn(), onSavePerson: entityActions.savePerson, onSaveProject: entityActions.saveProject,
        onSaveFact: entityActions.saveFact, onRemoveFact: entityActions.removeFact, onSaveContact: entityActions.saveContact, onRemoveContact: entityActions.removeContact,
        sourceLinks: entityActions.sourceLinks, onSaveMember: entityActions.saveMember, onRemoveMember: entityActions.removeMember,
      });
    }
    await act(async () => root.render(React.createElement(SubscribedEntitySheet)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Document · launch plan');
    expect(sourceChoiceReads).toBe(1);
    const sourceChoice = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Document · launch plan');
    expect(sourceChoice).toBeDefined();
    await act(async () => sourceChoice!.click());
    const label = [...host.querySelectorAll('input')].find((input) => input.parentElement?.textContent?.includes('Why is this relevant?'))!;
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(label, 'Project decisions'); label.dispatchEvent(new Event('input', { bubbles: true })); label.dispatchEvent(new Event('change', { bubbles: true })); });
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save source link')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(commands).toHaveLength(1);
    expect(store.getSnapshot().snapshot?.state.knowledge.people[0]?.sourceLinks[0]?.reference).toEqual({ kind: 'document', id: 'research/launch-plan.md' });
    expect(sourceChoiceReads).toBe(1);
    const reload = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reload source choices')!;
    await act(async () => { reload.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(sourceChoiceReads).toBe(2);
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('/api/workspace/knowledge/source-choices?expectedRevision=1&expectedPrivacyEpoch=3'))).toBe(true);
  });

  it('keeps an admitted suggestion edit mounted and binds a newly selected live member revision before accepting', async () => {
    const state = createInitialWorkspaceState(() => '33333333-3333-4333-8333-333333333333');
    const timestamp = '2026-10-14T08:00:00.000Z';
    const firstPersonId = '01234567-89ab-4def-8123-0123456789ab';
    const selectedPersonId = '11234567-89ab-4def-8123-0123456789ab';
    const projectId = '21234567-89ab-4def-8123-0123456789ab';
    const suggestionId = '31234567-89ab-4def-8123-0123456789ab';
    const firstPerson: import('../src/knowledge/types').Person = { id: firstPersonId, revision: 1, name: 'First person', aliases: [], narrativePath: `people/${firstPersonId}.md`, createdAt: timestamp, updatedAt: timestamp, facts: [], contacts: [], sourceLinks: [] };
    const selectedPerson: import('../src/knowledge/types').Person = { id: selectedPersonId, revision: 2, name: 'Selected person', aliases: [], narrativePath: `people/${selectedPersonId}.md`, createdAt: timestamp, updatedAt: timestamp, facts: [], contacts: [], sourceLinks: [] };
    const project: import('../src/knowledge/types').Project = { id: projectId, revision: 1, name: 'Launch', aliases: [], narrativePath: `projects/${projectId}.md`, createdAt: timestamp, updatedAt: timestamp, facts: [], sourceLinks: [], members: [], status: 'active', goal: 'Launch safely' };
    const suggestion: import('../src/knowledge/types').KnowledgeSuggestion = { id: suggestionId, revision: 1,
      change: { type: 'add_member', entityKind: 'project', entityId: projectId, personId: firstPersonId, personRevision: 1, role: 'Reviewer' }, targetRevision: 1,
      evidence: [{ sourceId: 'note:chat-note', sourceVersion: `1:${'a'.repeat(64)}`, revision: 1, quote: 'Maya will review the launch.' }], status: 'pending', createdAt: timestamp, updatedAt: timestamp };
    state.knowledge.people.push(firstPerson, selectedPerson); state.knowledge.projects.push(project); state.knowledge.suggestions.push(suggestion);
    state.documents.push({ path: firstPerson.narrativePath, content: '', revision: 1, updatedAt: timestamp }, { path: selectedPerson.narrativePath, content: '', revision: 1, updatedAt: timestamp }, { path: project.narrativePath, content: '', revision: 1, updatedAt: timestamp });
    let workspaceRevision = 1;
    const snapshot = () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch, revision: workspaceRevision });
    const commands: Record<string, unknown>[] = [];
    let releaseEditResponse: (() => void) | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if (url === '/api/workspace/snapshot' && method === 'GET') return body(snapshot());
      if (url.startsWith('/api/workspace/knowledge/suggestion-review?') && method === 'GET') return body({ schemaVersion: 1, workspaceId, privacyEpoch, revision: workspaceRevision,
        review: { suggestion: projectKnowledgeSuggestionForHttp(suggestion), canEdit: true, canAccept: true } });
      if (url === '/api/workspace/commands' && method === 'POST') {
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: Record<string, unknown> };
        const command = envelope.command; commands.push(command);
        if (command.kind === 'knowledge.suggestion.edit') {
          expect(command).toMatchObject({ expectedTargetRevision: 1, expectedMemberPersonRevision: 2, change: { type: 'add_member', personId: selectedPersonId, personRevision: 2 } });
          return new Promise((resolve) => {
            releaseEditResponse = () => {
              suggestion.originalChange ??= { ...suggestion.change };
              suggestion.change = command.change as typeof suggestion.change; suggestion.revision += 1; suggestion.updatedAt = timestamp; workspaceRevision += 1;
              const current = snapshot();
              resolve(body({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: { schemaVersion: 1, commandId: envelope.commandId, kind: command.kind,
                objectId: suggestionId, suggestionId, suggestionRevision: suggestion.revision, status: 'pending' }, snapshot: current }));
            };
          });
        }
        if (command.kind === 'knowledge.suggestion.review') {
          expect(command).toMatchObject({ expectedSuggestionRevision: 2, decision: 'accept', targetRevision: 1, memberPersonRevision: 2 });
          suggestion.status = 'accepted'; suggestion.revision += 1; suggestion.reviewedAt = timestamp; suggestion.updatedAt = timestamp; workspaceRevision += 1;
          const current = snapshot();
          return body({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: { schemaVersion: 1, commandId: envelope.commandId, kind: command.kind,
            objectId: suggestionId, suggestionId, suggestionRevision: suggestion.revision, status: 'accepted' }, snapshot: current });
        }
        throw new Error(`Unexpected command ${String(command.kind)}`);
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    store = new CloudWorkspaceSessionStore(session); cleanup = store.start();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const actions = createCloudKnowledgeActions(store, { workspaceId, privacyEpoch });
    if (!actions.suggestions.available) throw new Error('Suggestion actions unavailable');
    const suggestionActions = actions.suggestions.action;
    function SubscribedSuggestionSheet() {
      const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const latest = current.snapshot!; const knowledge = projectKnowledgeDisplay(latest.state.knowledge);
      return React.createElement(KnowledgeSuggestionSheet, { suggestions: knowledge.suggestions, people: knowledge.people, projects: knowledge.projects, sourceLabels: {},
        busy: current.busy, blocked: Boolean(current.pendingCommand) || current.refreshRequired, workspaceRevision: latest.revision,
        onPrepareReview: suggestionActions.prepare, onReview: suggestionActions.review, onEdit: suggestionActions.edit });
    }
    await act(async () => root.render(React.createElement(SubscribedSuggestionSheet)));
    const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
    const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); };
    const row = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Add a project member'))!;
    await act(async () => { row.click(); await flush(); });
    expect(button('Edit suggestion').disabled).toBe(false);
    await act(async () => button('Edit suggestion').click());
    const selectedPersonButton = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Selected person')!;
    await act(async () => selectedPersonButton.click());
    const saveEdit = button('Save as a new suggestion revision');
    await act(async () => { saveEdit.click(); await Promise.resolve(); });
    expect(store.getSnapshot().pendingCommand?.kind).toBe('knowledge.suggestion.edit');
    expect(host.textContent).toContain('Save as a new suggestion revision');
    await act(async () => { releaseEditResponse?.(); await flush(); });
    expect(host.textContent).toContain('The original remains in review history. This edit is a new suggestion revision.');
    expect(store.getSnapshot().snapshot?.state.knowledge.suggestions[0]?.change).toMatchObject({ personId: selectedPersonId, personRevision: 2 });
    await act(async () => { await flush(); });
    expect(button('Save this suggestion').disabled).toBe(false);
    await act(async () => { button('Save this suggestion').click(); await flush(); });
    expect(commands.map((command) => command.kind)).toEqual(['knowledge.suggestion.edit', 'knowledge.suggestion.review']);
    expect(store.getSnapshot().snapshot?.state.knowledge.suggestions[0]?.status).toBe('accepted');
  });

  it('allows dismissing a pending suggestion for an archived target through the real session command path', async () => {
    const state = createInitialWorkspaceState(() => '33333333-3333-4333-8333-333333333333');
    const timestamp = '2026-10-14T08:00:00.000Z';
    const targetId = '41234567-89ab-4def-8123-0123456789ab';
    const suggestionId = '51234567-89ab-4def-8123-0123456789ab';
    const person: import('../src/knowledge/types').Person = { id: targetId, revision: 1, name: 'Archived target', aliases: [], narrativePath: `people/${targetId}.md`, createdAt: timestamp, updatedAt: timestamp, archivedAt: timestamp, facts: [], contacts: [], sourceLinks: [] };
    const suggestion: import('../src/knowledge/types').KnowledgeSuggestion = { id: suggestionId, revision: 1,
      change: { type: 'add_fact', entityKind: 'person', entityId: targetId, statement: 'Keep this fact' }, targetRevision: 1,
      evidence: [{ sourceId: 'note:chat-note', sourceVersion: `1:${'b'.repeat(64)}`, revision: 1, quote: 'The fact was mentioned.' }], status: 'pending', createdAt: timestamp, updatedAt: timestamp };
    state.knowledge.people.push(person); state.knowledge.suggestions.push(suggestion);
    state.documents.push({ path: person.narrativePath, content: '', revision: 1, updatedAt: timestamp });
    let workspaceRevision = 1;
    const snapshot = () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch, revision: workspaceRevision });
    const commands: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if ((url === '/api/workspace/snapshot' || url === '/api/workspace/refresh') && (method === 'GET' || method === 'POST')) return body(snapshot());
      if (url.startsWith('/api/workspace/knowledge/suggestion-review?') && method === 'GET') return body({ schemaVersion: 1, workspaceId, privacyEpoch, revision: workspaceRevision,
        review: { suggestion: projectKnowledgeSuggestionForHttp(suggestion), canEdit: false, canAccept: false, reason: 'The target is archived.' } });
      if (url === '/api/workspace/commands' && method === 'POST') {
        const envelope = JSON.parse(String(init?.body)) as { commandId: string; command: Record<string, unknown> };
        commands.push(envelope.command);
        expect(envelope.command).toMatchObject({ kind: 'knowledge.suggestion.review', suggestionId, expectedSuggestionRevision: 1, decision: 'dismiss', targetRevision: 1 });
        suggestion.status = 'dismissed'; suggestion.revision += 1; suggestion.reviewedAt = timestamp; suggestion.updatedAt = timestamp; workspaceRevision += 1;
        return body({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: { schemaVersion: 1, commandId: envelope.commandId,
          kind: envelope.command.kind, objectId: suggestionId, suggestionId, suggestionRevision: suggestion.revision, status: 'dismissed' }, snapshot: snapshot() });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetcher); store = new CloudWorkspaceSessionStore(session); cleanup = store.start();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const actions = createCloudKnowledgeActions(store, { workspaceId, privacyEpoch });
    if (!actions.suggestions.available) throw new Error('Suggestion actions unavailable');
    await expect(actions.suggestions.action.review(suggestionId, { expectedRevision: 1, decision: 'dismiss' })).resolves.toBe(true);
    expect(commands).toHaveLength(1);
    expect(store.getSnapshot().snapshot?.state.knowledge.suggestions[0]?.status).toBe('dismissed');
  });

  it('rejects an edit opened on an older target revision when the session store has advanced ahead of the editor', async () => {
    const state = createInitialWorkspaceState(() => '33333333-3333-4333-8333-333333333333');
    const timestamp = '2026-10-14T08:00:00.000Z';
    const targetId = '61234567-89ab-4def-8123-0123456789ab';
    const suggestionId = '71234567-89ab-4def-8123-0123456789ab';
    const person: import('../src/knowledge/types').Person = { id: targetId, revision: 1, name: 'Target', aliases: [], narrativePath: `people/${targetId}.md`, createdAt: timestamp, updatedAt: timestamp, facts: [], contacts: [], sourceLinks: [] };
    const suggestion: import('../src/knowledge/types').KnowledgeSuggestion = { id: suggestionId, revision: 1,
      change: { type: 'add_fact', entityKind: 'person', entityId: targetId, statement: 'Keep this fact' }, targetRevision: 1,
      evidence: [{ sourceId: 'note:chat-note', sourceVersion: `1:${'c'.repeat(64)}`, revision: 1, quote: 'The fact was mentioned.' }], status: 'pending', createdAt: timestamp, updatedAt: timestamp };
    state.knowledge.people.push(person); state.knowledge.suggestions.push(suggestion);
    state.documents.push({ path: person.narrativePath, content: '', revision: 1, updatedAt: timestamp });
    let workspaceRevision = 1;
    const snapshot = () => createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch, revision: workspaceRevision });
    const commands: unknown[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if ((url === '/api/workspace/snapshot' && method === 'GET') || (url === '/api/workspace/refresh' && method === 'POST')) return body(snapshot());
      if (url === '/api/workspace/commands' && method === 'POST') { commands.push(JSON.parse(String(init?.body))); throw new Error('Unexpected command should not be sent'); }
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetcher); store = new CloudWorkspaceSessionStore(session); cleanup = store.start();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    person.revision = 2; person.updatedAt = '2026-10-15T08:00:00.000Z'; workspaceRevision = 2;
    await act(async () => { await store.refresh(); });
    const actions = createCloudKnowledgeActions(store, { workspaceId, privacyEpoch });
    if (!actions.suggestions.available) throw new Error('Suggestion actions unavailable');
    await expect(actions.suggestions.action.edit(suggestionId, { expectedRevision: 1, targetRevision: 1,
      change: { type: 'add_fact', entityKind: 'person', entityId: targetId, statement: 'Edited fact' }, evidence: suggestion.evidence })).rejects.toThrow('The target changed or is archived.');
    expect(commands).toHaveLength(0);
  });
});
