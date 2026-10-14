/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import type { KnowledgeChangeDisplay, KnowledgePersonDisplay, KnowledgeReferenceDisplay, KnowledgeSuggestionDisplay, KnowledgeSuggestionReviewDisplay } from '../src/ui/knowledgeDisplayTypes';
import { KnowledgeSuggestionSheet } from '../src/ui/KnowledgeSuggestionSheet';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, visible, onPress, onRequestClose, accessibilityLabel, style: _style, accessibilityRole: _role, accessibilityState: _state, numberOfLines: _lines, presentationStyle: _presentation, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
    if (tag === 'div' && visible === false) return null;
    return ReactModule.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
      ...(onPress ? { onClick: onPress } : {}),
      ...(onRequestClose ? { onKeyDown: onRequestClose } : {}),
    }, children);
  };
  return { Modal: element('div'), Pressable: element('button'), ScrollView: element('div'), Text: element('span'), View: element('div') };
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

type Suggestion = AppState['knowledge']['suggestions'][number];
type Person = AppState['knowledge']['people'][number];
const makeSnapshot = (suggestionItem: Suggestion, personItem: Person) => {
  const state = createInitialWorkspaceState(() => '33333333-3333-4333-8333-333333333333');
  state.knowledge.suggestions.push(suggestionItem);
  state.knowledge.people.push(personItem);
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', privacyEpoch: 1, revision: 1 });
};
const displayReference = (reference: ReturnType<typeof createWorkspaceSnapshotDTO>['state']['knowledge']['people'][number]['sourceLinks'][number]['reference']): KnowledgeReferenceDisplay => {
  if (reference.kind === 'device_calendar_event') return { kind: 'historical', label: `Device calendar event (${reference.occurrenceStart})`, originalKind: 'device_calendar_event' };
  return reference;
};
const displayChange = (change: ReturnType<typeof createWorkspaceSnapshotDTO>['state']['knowledge']['suggestions'][number]['change']): KnowledgeChangeDisplay => {
  if (change.type === 'add_source_link') return { ...change, reference: displayReference(change.reference) };
  return change;
};
const displaySuggestion = (item: ReturnType<typeof createWorkspaceSnapshotDTO>['state']['knowledge']['suggestions'][number]): KnowledgeSuggestionDisplay => {
  const { change, originalChange, ...rest } = item;
  return { ...rest, change: displayChange(change), ...(originalChange ? { originalChange: displayChange(originalChange) } : {}) };
};
const displayPerson = (item: ReturnType<typeof createWorkspaceSnapshotDTO>['state']['knowledge']['people'][number]): KnowledgePersonDisplay => ({
  ...item, sourceLinks: item.sourceLinks.map((link) => ({ ...link, reference: displayReference(link.reference) })),
});
const suggestion = (revision = 1): KnowledgeSuggestionDisplay => {
  const item: Suggestion = {
    id: 'suggestion-a', revision, change: { type: 'add_fact', entityKind: 'person', entityId: 'person-a', statement: revision === 1 ? 'First fact' : 'Edited fact' },
    targetRevision: 1, evidence: [{ sourceId: 'note:chat-note', sourceVersion: 'v1', revision: 1, quote: 'A safe quote' }],
    status: 'pending', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z',
  };
  const p: Person = { id: 'person-a', revision: 1, name: 'Person A', aliases: [], narrativePath: 'people/person-a.md', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', facts: [], contacts: [], sourceLinks: [] };
  return displaySuggestion(makeSnapshot(item, p).state.knowledge.suggestions[0]!);
};
const person = (revision = 1): KnowledgePersonDisplay => {
  const p: Person = { id: 'person-a', revision, name: 'Person A', aliases: [], narrativePath: 'people/person-a.md', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', facts: [], contacts: [], sourceLinks: [] };
  return displayPerson(makeSnapshot({
    id: 'suggestion-a', revision: 1, change: { type: 'add_fact', entityKind: 'person', entityId: 'person-a', statement: 'First fact' }, targetRevision: 1,
    evidence: [{ sourceId: 'note:chat-note', sourceVersion: 'v1', revision: 1, quote: 'A safe quote' }], status: 'pending', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z',
  }, p).state.knowledge.people[0]!);
};
const review = (item: KnowledgeSuggestionDisplay, overrides: Partial<KnowledgeSuggestionReviewDisplay> = {}): KnowledgeSuggestionReviewDisplay => ({ suggestion: item, canEdit: true, canAccept: true, ...overrides });

const render = (props: Partial<React.ComponentProps<typeof KnowledgeSuggestionSheet>> = {}) => act(() => root.render(React.createElement(KnowledgeSuggestionSheet, {
  suggestions: [suggestion()], people: [person()], projects: [], sourceLabels: {}, busy: false, blocked: false,
  onPrepareReview: vi.fn(async (_id: string, input: { expectedRevision: number }) => review(suggestion(input.expectedRevision))),
  onReview: vi.fn(async () => true), onEdit: vi.fn(async () => undefined), ...props,
})));
const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
const suggestionRow = () => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Add a fact'))!;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('KnowledgeSuggestionSheet preflight and ownership', () => {
  it('keeps Edit and Accept disabled until the exact source preflight completes, then leaves Dismiss available when it is stale', async () => {
    let resolve!: (value: KnowledgeSuggestionReviewDisplay) => void;
    const onPrepareReview = vi.fn((_id: string, _input: { expectedRevision: number }) => new Promise<KnowledgeSuggestionReviewDisplay>((accept) => { resolve = accept; }));
    const onReview = vi.fn(async () => true);
    render({ onPrepareReview, onReview });
    await act(async () => { suggestionRow().click(); await flush(); });
    expect(button('Edit suggestion').disabled).toBe(true);
    expect(button('Save this suggestion').disabled).toBe(true);
    await act(async () => { resolve(review(suggestion(), { canEdit: false, canAccept: false, reason: 'The Chat source changed.' })); await flush(); });
    expect(host.textContent).toContain('The Chat source changed.');
    expect(button('Edit suggestion').disabled).toBe(true);
    expect(button('Save this suggestion').disabled).toBe(true);
    expect(button('Dismiss suggestion').disabled).toBe(false);
    await act(async () => { button('Dismiss suggestion').click(); await flush(); });
    expect(onPrepareReview).toHaveBeenCalledExactlyOnceWith('suggestion-a', { expectedRevision: 1 });
    expect(onReview).toHaveBeenCalledExactlyOnceWith('suggestion-a', { expectedRevision: 1, decision: 'dismiss' });
  });

  it('allows dismiss when only the target revision changed, while keeping edit and accept fenced', async () => {
    render();
    await act(async () => { suggestionRow().click(); await flush(); });
    expect(button('Edit suggestion').disabled).toBe(false);
    render({ people: [person(2)] });
    expect(button('Edit suggestion').disabled).toBe(true);
    expect(button('Save this suggestion').disabled).toBe(true);
    expect(button('Dismiss suggestion').disabled).toBe(false);
  });

  it('ignores an old preflight after close and reopen of the same ID and revision', async () => {
    const resolves: ((value: KnowledgeSuggestionReviewDisplay) => void)[] = [];
    const onPrepareReview = vi.fn((_id: string, _input: { expectedRevision: number }) => new Promise<KnowledgeSuggestionReviewDisplay>((accept) => { resolves.push(accept); }));
    render({ onPrepareReview });
    await act(async () => { suggestionRow().click(); await flush(); });
    await act(async () => { button('Close suggestion review').click(); });
    await act(async () => { suggestionRow().click(); await flush(); });
    expect(onPrepareReview).toHaveBeenCalledTimes(2);
    await act(async () => { resolves[0](review(suggestion())); await flush(); });
    expect(button('Edit suggestion').disabled).toBe(true);
    await act(async () => { resolves[1](review(suggestion())); await flush(); });
    expect(button('Edit suggestion').disabled).toBe(false);
  });

  it('requires a fresh preflight for the exact returned edit revision before another edit or accept', async () => {
    const edited = suggestion(2);
    let resolveSecond!: (value: KnowledgeSuggestionReviewDisplay) => void;
    const onPrepareReview = vi.fn((_id: string, input: { expectedRevision: number }) => input.expectedRevision === 1
      ? Promise.resolve(review(suggestion()))
      : new Promise<KnowledgeSuggestionReviewDisplay>((accept) => { resolveSecond = accept; }));
    const onEdit = vi.fn(async () => edited);
    render({ onPrepareReview, onEdit });
    await act(async () => { suggestionRow().click(); await flush(); });
    await act(async () => { button('Edit suggestion').click(); });
    const input = host.querySelector('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Edited fact'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { button('Save as a new suggestion revision').click(); await flush(); });
    expect(onEdit).toHaveBeenCalledExactlyOnceWith('suggestion-a', expect.objectContaining({ expectedRevision: 1 }));
    expect(button('Save this suggestion').disabled).toBe(true);
    expect(onPrepareReview).toHaveBeenCalledTimes(1);
    render({ suggestions: [edited], onPrepareReview, onEdit });
    await act(async () => { await flush(); });
    expect(onPrepareReview).toHaveBeenLastCalledWith('suggestion-a', { expectedRevision: 2 });
    expect(button('Edit suggestion').disabled).toBe(true);
    await act(async () => { resolveSecond(review(edited)); await flush(); });
    expect(button('Save this suggestion').disabled).toBe(false);
    await act(async () => { button('Save this suggestion').click(); await flush(); });
  });

  it('does not let a late edit callback replace the review opened after the old review was closed', async () => {
    const first = suggestion();
    const other: KnowledgeSuggestionDisplay = { ...suggestion(), id: 'suggestion-b', change: { type: 'add_contact', entityKind: 'person', entityId: 'person-a', address: 'other@example.com', label: 'Other contact' } };
    let resolveEdit!: (value: KnowledgeSuggestionDisplay | undefined) => void;
    const onEdit = vi.fn(() => new Promise<KnowledgeSuggestionDisplay | undefined>((resolve) => { resolveEdit = resolve; }));
    render({ suggestions: [first, other], onEdit });
    await act(async () => { suggestionRow().click(); await flush(); });
    await act(async () => { button('Edit suggestion').click(); });
    const input = host.querySelector('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'New fact'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { button('Save as a new suggestion revision').click(); });
    await act(async () => { button('Close suggestion review').click(); });
    const otherRow = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Add a contact claim'))!;
    expect(otherRow).toBeTruthy();
    await act(async () => { otherRow.click(); await flush(); });
    resolveEdit({ ...first, revision: 2, change: { type: 'add_fact', entityKind: 'person', entityId: 'person-a', statement: 'Late old fact' } });
    await act(async () => { await flush(); });
    expect(host.textContent).not.toContain('The original remains in review history. This edit is a new suggestion revision.');
    expect(host.textContent).toContain('Other contact');
  });

  it('clears the review owner during a hard block and does not resurrect it when the block clears', async () => {
    let resolve!: (value: KnowledgeSuggestionReviewDisplay) => void;
    const onPrepareReview = vi.fn(() => new Promise<KnowledgeSuggestionReviewDisplay>((accept) => { resolve = accept; }));
    render({ onPrepareReview });
    await act(async () => { suggestionRow().click(); await flush(); });
    render({ onPrepareReview, blocked: true });
    await act(async () => { await flush(); });
    render({ onPrepareReview, blocked: false });
    await act(async () => { resolve(review(suggestion())); await flush(); });
    expect(host.textContent).not.toContain('Memory suggestion');
    expect(host.textContent).not.toContain('Save this suggestion');
  });
});
