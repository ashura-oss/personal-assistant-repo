/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversationDTO, ChatTranscriptTransferPlan } from '../src/chat/types';
import { VoiceChatTransferReview } from '../src/ui/VoiceChatTransferReview';
import { canUseSavedTranscriptInChat } from '../src/ui/NoteDetail';
import type { Note } from '../src/core';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, onPress, style: _style, numberOfLines: _lines, accessibilityLabel, accessibilityRole: _role, accessibilityState: _state,
    contentContainerStyle: _contentStyle, selectable: _selectable, showsVerticalScrollIndicator: _scroll, ...props }: Record<string, unknown> & { children?: React.ReactNode; onPress?: () => void; accessibilityLabel?: string }) =>
    ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}), ...(onPress ? { onClick: onPress } : {}) }, children);
  return {
    Modal: ({ visible, children }: { visible: boolean; children?: React.ReactNode }) => visible ? ReactModule.createElement('div', { role: 'dialog' }, children) : null,
    Pressable: view('button'), ScrollView: view('div'), Text: view('span'), View: view('div'),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  const Safe = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children);
  return { SafeAreaProvider: Safe, SafeAreaView: Safe };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { card: '#222', border: '#333', text: '#fff', muted: '#aaa', input: '#111', sage: '#9a9', red: '#d66' }, s: {} }));

const plan: ChatTranscriptTransferPlan = {
  planId: 'plan-1', noteId: 'note-1', noteRevision: 3, transcript: 'A saved fictional transcript.',
  capturedAt: '2026-10-14T01:00:00.000Z', captureTimeZone: 'Asia/Singapore', expiresAt: '2026-10-14T02:00:00.000Z',
};
const conversation: ChatConversationDTO = { id: 'conversation-1', title: 'Ideas', createdAt: plan.capturedAt, updatedAt: plan.capturedAt, turns: [] };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function button(label: string) { return [...host.querySelectorAll('button')].find((item) => item.textContent === label); }
function render(overrides: Partial<React.ComponentProps<typeof VoiceChatTransferReview>> = {}) {
  const props: React.ComponentProps<typeof VoiceChatTransferReview> = {
    plan, conversations: [conversation], selectedConversationId: conversation.id, blocked: false, busy: false, providerReady: true,
    onSelectConversation: vi.fn(), onCreateConversation: vi.fn(async () => conversation), onSend: vi.fn(async () => ({ kind: 'accepted', conversationId: conversation.id, turnId: 'turn-1', jobId: 'job-1' })), onCancel: vi.fn(),
    ...overrides,
  };
  act(() => root.render(React.createElement(VoiceChatTransferReview, props)));
  return props;
}

describe('VoiceChatTransferReview', () => {
  it('offers transfer only for the unchanged saved transcript with a known valid capture zone', () => {
    const note: Note = {
      id: 'note-1', title: 'Saved note', transcript: plan.transcript, durationSeconds: 0,
      createdAt: plan.capturedAt, capturedAt: plan.capturedAt, captureTimeZone: plan.captureTimeZone,
      status: 'recorded', revision: 3,
    };
    expect(canUseSavedTranscriptInChat(note, note.transcript, false, false)).toBe(true);
    expect(canUseSavedTranscriptInChat(note, `${note.transcript} edited`, false, false)).toBe(false);
    expect(canUseSavedTranscriptInChat(note, note.transcript, true, false)).toBe(false);
    expect(canUseSavedTranscriptInChat(note, note.transcript, false, true)).toBe(false);
    expect(canUseSavedTranscriptInChat({ ...note, captureTimeZone: undefined }, note.transcript, false, false)).toBe(false);
    const importedNote = { ...note, importOrigin: { kind: 'backup_import' as const, archiveId: 'a', sourceNoteId: 'b', audioMissing: true, originalTimeZoneUnknown: true as const } };
    expect(canUseSavedTranscriptInChat(importedNote, note.transcript, false, false)).toBe(false);
  });

  it('shows the immutable saved transcript and capture zone, with send unavailable until provider readiness', () => {
    render({ providerReady: false });
    expect(host.textContent).toContain(plan.transcript);
    expect(host.textContent).toContain('Asia/Singapore');
    expect(host.textContent).toContain('Deleting the recording note won’t delete that message.');
    expect(button('Send saved transcript')?.disabled).toBe(true);
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('creates a local conversation explicitly and sends only after selection', async () => {
    const onCreateConversation = vi.fn(async () => conversation);
    const onSend = vi.fn(async () => ({ kind: 'accepted', conversationId: conversation.id, turnId: 'turn-1', jobId: 'job-1' }));
    render({ conversations: [], selectedConversationId: undefined, onCreateConversation, onSend });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { button('Create new conversation')?.click(); await Promise.resolve(); });
    expect(onCreateConversation).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    render({ conversations: [conversation], selectedConversationId: conversation.id, onCreateConversation, onSend });
    await act(async () => { button('Send saved transcript')?.click(); await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledWith(plan.planId, conversation.id);
  });

  it('rejects nonaccepted or wrong-conversation outcomes and leaves cancel available', async () => {
    const onSend = vi.fn(async () => undefined);
    const onCancel = vi.fn();
    render({ onSend, onCancel });
    await act(async () => { button('Send saved transcript')?.click(); await Promise.resolve(); });
    expect(onCancel).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Could not confirm the Chat message. Check the conversation request status before trying again.');
    await act(async () => { button('Cancel')?.click(); });
    expect(onCancel).toHaveBeenCalledWith(plan.planId);
  });

  it('does not treat an accepted result for a different conversation as transfer success', async () => {
    const onSend = vi.fn(async () => ({ kind: 'accepted', conversationId: 'other-conversation', turnId: 'turn-1', jobId: 'job-1' }));
    render({ onSend });
    await act(async () => { button('Send saved transcript')?.click(); await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Could not confirm the Chat message. Check the conversation request status before trying again.');
  });
});
