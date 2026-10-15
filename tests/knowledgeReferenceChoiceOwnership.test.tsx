/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../src/core';
import type { Person } from '../src/knowledge/types';
import type { KnowledgePersonDisplay, KnowledgeReferenceDisplay } from '../src/ui/knowledgeDisplayTypes';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { KnowledgeEntitySheet } from '../src/ui/KnowledgeEntitySheet';
import { KnowledgeReferenceChoiceOwnership, resolveKnowledgeSourceLinkReference, type KnowledgeReferenceChoiceOption } from '../src/ui/knowledgeReferenceChoiceOwnership';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, visible, onPress, onRequestClose, accessibilityLabel, style: _style, accessibilityRole: _role, accessibilityState: _state, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
    if (tag === 'div' && visible === false) return null;
    return ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}), ...(onPress ? { onClick: onPress } : {}), ...(onRequestClose ? { onKeyDown: onRequestClose } : {}) }, children);
  };
  return { KeyboardAvoidingView: element('div'), Modal: element('div'), Platform: { OS: 'web' }, Pressable: element('button'), ScrollView: element('div'), Text: element('span'), View: element('div') };
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

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('knowledge source choice ownership', () => {
  it('rejects a removed token and allocates a fresh token if that exact source returns later', () => {
    const ownership = new KnowledgeReferenceChoiceOwnership();
    const option: KnowledgeReferenceChoiceOption = { reference: { kind: 'note', id: 'note-a' }, label: 'Note · A', binding: 'private-note-snapshot-a' };
    const toDisplay = (reference: KnowledgeReferenceChoiceOption['reference']): KnowledgeReferenceDisplay => reference.kind === 'device_calendar_event'
      ? { kind: 'historical', label: `Device calendar event (${reference.occurrenceStart})`, originalKind: 'device_calendar_event' }
      : reference;
    const oldToken = ownership.project([option], toDisplay)[0]!.id;
    ownership.project([], toDisplay);
    expect(ownership.resolve(oldToken, [option])).toBeUndefined();
    const reintroducedToken = ownership.project([option], toDisplay)[0]!.id;
    expect(reintroducedToken).not.toBe(oldToken);
  });

  it('rejects an explicit stale choice while editing an existing link, and preserves it only when the choice is omitted', () => {
    const ownership = new KnowledgeReferenceChoiceOwnership();
    const option: KnowledgeReferenceChoiceOption = { reference: { kind: 'note', id: 'note-current' }, label: 'Note · Current', binding: 'current-note-snapshot' };
    const toDisplay = (reference: KnowledgeReferenceChoiceOption['reference']): KnowledgeReferenceDisplay => reference.kind === 'device_calendar_event'
      ? { kind: 'historical', label: `Device calendar event (${reference.occurrenceStart})`, originalKind: 'device_calendar_event' }
      : reference;
    const choiceId = ownership.project([option], toDisplay)[0]!.id;
    const existingReference = { kind: 'task' as const, id: 'existing-link' };
    expect(resolveKnowledgeSourceLinkReference(ownership, 'removed-token', [option], existingReference)).toBeUndefined();
    expect(resolveKnowledgeSourceLinkReference(ownership, '', [option], existingReference)).toBeUndefined();
    expect(resolveKnowledgeSourceLinkReference(ownership, choiceId, [option], existingReference)).toEqual(option.reference);
    expect(resolveKnowledgeSourceLinkReference(ownership, undefined, [option], existingReference)).toEqual(existingReference);
  });

  it('keeps a mounted leaf selection bound to the original note when an unrelated source is inserted before it', async () => {
    const state = createInitialWorkspaceState(() => '33333333-3333-4333-8333-333333333333');
    const savedAt = '2026-10-14T08:00:00.000Z';
    const person: Person = { id: 'person-a', revision: 1, name: 'Morgan Lee', aliases: [], narrativePath: 'people/morgan.md', createdAt: savedAt, updatedAt: savedAt, facts: [], contacts: [], sourceLinks: [] };
    const note: Note = { id: 'note-original', title: 'Original note', transcript: 'Original source content', durationSeconds: 5, createdAt: savedAt, status: 'processed', revision: 2, audioUri: 'file:///private-recording.m4a' };
    state.knowledge.people.push(person);
    state.documents.push({ path: person.narrativePath, content: 'Morgan notes', revision: 1, updatedAt: savedAt });
    state.notes.push(note);
    const dto = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', privacyEpoch: 1, revision: 1 });
    const toDisplayReference = (reference: (typeof dto.state.knowledge.people)[number]['sourceLinks'][number]['reference']): KnowledgeReferenceDisplay => reference.kind === 'device_calendar_event'
      ? { kind: 'historical', label: `Device calendar event (${reference.occurrenceStart})`, originalKind: 'device_calendar_event' }
      : reference;
    const people: KnowledgePersonDisplay[] = dto.state.knowledge.people.map((item) => ({ ...item, sourceLinks: item.sourceLinks.map((link) => ({ ...link, reference: toDisplayReference(link.reference) })) }));
    const entity = people[0]!;
    const noteDisplay = dto.state.notes.find((item) => item.id === note.id)!;
    expect(noteDisplay).not.toHaveProperty('audioUri');

    const noteOption: KnowledgeReferenceChoiceOption = { reference: { kind: 'note', id: noteDisplay.id }, label: `Note · ${noteDisplay.transcript}`, binding: JSON.stringify(['note', note]) };
    const otherNote: Note = { ...note, id: 'note-inserted', title: 'Inserted note', transcript: 'Inserted unrelated source' };
    const otherOption: KnowledgeReferenceChoiceOption = { reference: { kind: 'note', id: otherNote.id }, label: `Note · ${otherNote.transcript}`, binding: JSON.stringify(['note', otherNote]) };
    const options = [noteOption];
    const ownership = new KnowledgeReferenceChoiceOwnership();
    const display = () => ownership.project(options, toDisplayReference);
    const originalChoice = display()[0]!;
    expect(originalChoice).not.toHaveProperty('binding');
    expect(JSON.stringify(originalChoice)).not.toContain('private-recording');
    const selectedReferences: unknown[] = [];
    const onSaveSourceLink = vi.fn(async (input: { referenceChoiceId?: string }) => {
      const selected = ownership.resolve(input.referenceChoiceId, options);
      if (!selected) return undefined;
      selectedReferences.push(selected);
      return true;
    });
    const render = (references = display()) => act(() => root.render(<KnowledgeEntitySheet
      visible kind="person" entity={entity} people={people} documents={dto.state.documents} references={references} busy={false}
      onClose={() => undefined} onSavePerson={async () => true} onSaveProject={async () => true}
      onSaveFact={async () => true} onRemoveFact={async () => true} onSaveContact={async () => true} onRemoveContact={async () => true}
      sourceLinks={{ available: true, action: { save: onSaveSourceLink, remove: async () => true } }} onSaveMember={async () => true} onRemoveMember={async () => true}
    />));
    render();
    act(() => [...host.querySelectorAll('button')].find((item) => item.textContent === noteOption.label)!.click());
    const field = [...host.querySelectorAll('input')].find((input) => input.parentElement?.textContent?.includes('Why is this relevant?'))!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Supports this memory');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });

    options.unshift(otherOption);
    render();
    await act(async () => {
      [...host.querySelectorAll('button')].find((item) => item.textContent === 'Save source link')!.click();
      await Promise.resolve();
    });
    expect(onSaveSourceLink).toHaveBeenCalledTimes(1);
    expect(selectedReferences).toEqual([{ kind: 'note', id: 'note-original' }]);
    expect(selectedReferences).not.toContainEqual({ kind: 'note', id: 'note-inserted' });
    expect(ownership.resolve(originalChoice.id, [{ ...noteOption, binding: JSON.stringify(['note', { ...note, revision: 3 }]) }])).toBeUndefined();
  });
});
