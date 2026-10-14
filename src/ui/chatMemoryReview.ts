import type { ChatConversationDTO, ChatTurnDTO } from '../chat/types';

export function chatMemoryReviewSuggestionIds(turn: ChatTurnDTO): readonly string[] {
  return turn.operation === 'chat_refinement' ? [] : [...new Set(turn.memorySuggestionIds ?? [])];
}

/** Labels Chat note evidence from the public conversation/message DTO only. */
export function safeChatMemoryEvidenceLabels(conversations: readonly ChatConversationDTO[]): Record<string, string> {
  const labels: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const conversation of conversations) {
    const title = conversation.title.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled conversation';
    for (const turn of conversation.turns) {
      if (turn.operation === 'chat_refinement') continue;
      const timestamp = new Date(turn.createdAt);
      const messageTime = Number.isFinite(timestamp.getTime())
        ? timestamp.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : 'time unavailable';
      labels[`note:${encodeURIComponent(turn.noteId)}`] = `Chat · ${title} · message ${messageTime}`;
    }
  }
  return labels;
}
