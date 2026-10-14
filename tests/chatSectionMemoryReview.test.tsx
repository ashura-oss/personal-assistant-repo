/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { AssistantBatchJobDTO } from '../src/services/openRouterBatchJobs';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import type { ChatConversationDTO, ChatTurnDTO } from '../src/chat/types';
import { ChatSection } from '../src/ui/ChatSection';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, onPress, style: _style, accessibilityRole: _role, accessibilityState: _state, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement(tag, { ...props, ...(onPress ? { onClick: onPress } : {}) }, children);
  return { KeyboardAvoidingView: element('div'), Modal: element('div'), Platform: { OS: 'web' }, Pressable: element('button'), ScrollView: element('div'), Text: element('span'), TextInput: element('textarea'), View: element('div') };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  return { SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children), SafeAreaView: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children) };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00', input: '#111' }, s: new Proxy({}, { get: () => ({}) }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const ordinary = (overrides: Partial<ChatTurnDTO> = {}): ChatTurnDTO => ({ id: 'turn-1', noteId: 'note-1', userText: 'Question', createdAt: '2026-10-14T08:00:00Z', ...overrides });
const conversation = (turns: readonly ChatTurnDTO[]): ChatConversationDTO => ({ id: 'conv-1', title: 'Planning', createdAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:00:00Z', turns });

describe('Chat memory review affordance', () => {
  it('routes each exact ordinary pending suggestion ID and excludes refinement/import-like records without public Chat IDs', () => {
    const turns = [
      ordinary({ id: 'turn-a', memorySuggestionIds: ['memory-a', 'memory-b'] }),
      ordinary({ id: 'turn-refinement', operation: 'chat_refinement', memorySuggestionIds: ['refinement-id'] }),
      ordinary({ id: 'turn-no-memory' }),
    ];
    const onReviewMemorySuggestion = vi.fn();
    const chat = conversation(turns);
    act(() => root.render(React.createElement(ChatSection, {
      conversations: [chat], selectedConversationId: chat.id, turns, busy: false, enabled: false,
      onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(async () => undefined), onOpenActions: vi.fn(),
      onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onReviewMemorySuggestion,
    })));
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.filter((item) => item.textContent?.startsWith('Review memory')).map((item) => item.textContent)).toEqual([
      'Review memory suggestion 1', 'Review memory suggestion 2',
    ]);
    act(() => buttons.find((item) => item.textContent === 'Review memory suggestion 2')?.click());
    expect(onReviewMemorySuggestion).toHaveBeenCalledExactlyOnceWith('memory-b', chat, turns[0]);
  });

  it('renders deeply frozen snapshot chat and nested Batch DTOs and returns the exact readonly memory view', () => {
    const stamp = '2026-10-14T08:00:00.000Z';
    const job: AssistantBatchJobDTO = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'note_assistance', status: 'submission_unknown', canCheck: false,
      createdAt: stamp, updatedAt: stamp, noteId: 'note-1', noteRevision: 2, model: 'openai/gpt-6-luna:batch', effort: 'low',
      requestBytes: 150, omittedSourceCount: 0, unknownCharge: true, costStatus: 'waiting', billingScope: 'openrouter_reported',
      promptTokens: 0, moreComputeEfforts: ['high'],
    };
    const turn: ChatTurnDTO = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', noteId: 'note-1', userText: 'Keep the original message.', createdAt: stamp,
      memorySuggestionIds: ['memory-safe-id'], job,
    };
    const conversation: ChatConversationDTO = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Planning', createdAt: stamp, updatedAt: stamp, turns: [turn],
    };
    const state = createInitialWorkspaceState(() => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    state.assistantBatchJobs = [job];
    state.assistantChatConversations = [conversation];
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, {
      workspaceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', privacyEpoch: 1, revision: 9,
    });
    const readonlyConversation = snapshot.state.assistantChatConversations[0]!;
    const readonlyTurn = readonlyConversation.turns[0]!;
    expect(Object.isFrozen(readonlyConversation.turns)).toBe(true);
    expect(Object.isFrozen(readonlyTurn.job)).toBe(true);
    expect(Object.isFrozen(readonlyTurn.job?.moreComputeEfforts)).toBe(true);

    const onReview = vi.fn();
    act(() => root.render(React.createElement(ChatSection, {
      conversations: snapshot.state.assistantChatConversations,
      selectedConversationId: readonlyConversation.id,
      turns: readonlyConversation.turns,
      busy: false,
      enabled: false,
      onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(async () => undefined),
      onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onReviewMemorySuggestion: onReview,
    })));
    expect(host.textContent).toContain('Submission status uncertain');
    expect(host.textContent).toContain('Provider-reported usage is not available yet.');
    expect(host.textContent).toContain('0 prompt');
    act(() => [...host.querySelectorAll('button')].find((item) => item.textContent === 'Review memory')?.click());
    expect(onReview).toHaveBeenCalledExactlyOnceWith('memory-safe-id', readonlyConversation, readonlyTurn);
  });
});
