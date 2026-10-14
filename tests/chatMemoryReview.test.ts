import { describe, expect, it } from 'vitest';
import type { ChatConversationDTO, ChatTurnDTO } from '../src/chat/types';
import { chatMemoryReviewSuggestionIds, safeChatMemoryEvidenceLabels } from '../src/ui/chatMemoryReview';

const turn = (overrides: Partial<ChatTurnDTO> = {}): ChatTurnDTO => ({
  id: 'turn-1', noteId: 'chat-note/1', userText: 'A private user question', createdAt: '2026-10-14T08:30:00.000Z',
  ...overrides,
});

describe('Chat memory review presentation', () => {
  it('offers only exact pending IDs from ordinary Chat turns, never refinement IDs or imported Library suggestions', () => {
    expect(chatMemoryReviewSuggestionIds(turn({ memorySuggestionIds: ['suggestion-a', 'suggestion-a', 'suggestion-b'] })))
      .toEqual(['suggestion-a', 'suggestion-b']);
    expect(chatMemoryReviewSuggestionIds(turn({ operation: 'chat_refinement', memorySuggestionIds: ['refinement-id'] }))).toEqual([]);
    expect(chatMemoryReviewSuggestionIds(turn())).toEqual([]);
  });

  it('labels pending and accepted-history Chat evidence from public conversation/message fields without quoting message text', () => {
    const conversations: ChatConversationDTO[] = [{
      id: 'conversation-1', title: '  Project   planning  ', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:30:00.000Z',
      turns: [
        turn({ memorySuggestionIds: ['pending-id'] }),
        turn({ id: 'turn-accepted', noteId: 'accepted-note', memorySuggestionIds: undefined }),
        turn({ id: 'turn-refined', noteId: 'refined-note', operation: 'chat_refinement' }),
      ],
    }];
    const labels = safeChatMemoryEvidenceLabels(conversations);
    expect(labels['note:chat-note%2F1']).toContain('Chat · Project planning · message');
    expect(labels['note:accepted-note']).toContain('Chat · Project planning · message');
    expect(labels['note:refined-note']).toBeUndefined();
    expect(JSON.stringify(labels)).not.toContain('A private user question');
    expect(labels['note:accepted-note']).not.toContain('accepted-id');
  });
});
