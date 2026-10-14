/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
