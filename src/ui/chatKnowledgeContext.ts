import type { KnowledgeSelection } from '../core';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { ChatKnowledgeSelectionBinding } from './workspaceChatDisplayTypes';

export type ChatSubmissionRuntime = Readonly<{
  controller: object;
  selectedConversationId?: string;
  workspaceGeneration: number;
  privacyOwner: object | null;
  ready: boolean;
  blocked: boolean;
  mounted: boolean;
}>;

export type ChatSubmissionOwner = Readonly<{
  controller: object;
  conversationId: string;
  workspaceGeneration: number;
  privacyOwner: object | null;
}>;

export type ChatTurnCommand = Readonly<{ conversationId: string; text: string; knowledgeSelection?: readonly KnowledgeSelection[number][] }>;

export function captureChatSubmissionOwner(runtime: ChatSubmissionRuntime): ChatSubmissionOwner | undefined {
  if (!runtime.mounted || !runtime.ready || runtime.blocked || !runtime.selectedConversationId) return undefined;
  return { controller: runtime.controller, conversationId: runtime.selectedConversationId, workspaceGeneration: runtime.workspaceGeneration, privacyOwner: runtime.privacyOwner };
}

export function chatSubmissionOwnerIsCurrent(owner: ChatSubmissionOwner, runtime: ChatSubmissionRuntime): boolean {
  return runtime.mounted && runtime.ready && !runtime.blocked && runtime.controller === owner.controller && runtime.selectedConversationId === owner.conversationId &&
    runtime.workspaceGeneration === owner.workspaceGeneration && runtime.privacyOwner === owner.privacyOwner;
}

/** Validates exact user-selected revisions before and after credential lookup, then strips UI-only revision fields. */
export function resolveChatKnowledgeSelection(knowledge: Pick<WorkspaceSnapshotDTO['state']['knowledge'], 'people' | 'projects'>, bindings: readonly ChatKnowledgeSelectionBinding[]): readonly KnowledgeSelection[number][] {
  const selected: KnowledgeSelection[number][] = [];
  const seen = new Map<string, number>();
  for (const binding of bindings) {
    if (!binding || (binding.kind !== 'person' && binding.kind !== 'project') || typeof binding.id !== 'string' || !binding.id || !Number.isSafeInteger(binding.revision)) {
      throw new Error('A selected person or project changed. Review the current context before sending again.');
    }
    const key = `${binding.kind}:${binding.id}`;
    const previousRevision = seen.get(key);
    if (previousRevision !== undefined) {
      if (previousRevision !== binding.revision) throw new Error('A selected person or project changed. Review the current context before sending again.');
      continue;
    }
    seen.set(key, binding.revision);
    const entity = binding.kind === 'person'
      ? knowledge.people.find((item) => item.id === binding.id)
      : knowledge.projects.find((item) => item.id === binding.id);
    if (!entity || entity.archivedAt || entity.revision !== binding.revision) {
      throw new Error('A selected person or project changed. Review the current context before sending again.');
    }
    selected.push({ kind: binding.kind, id: binding.id });
  }
  return selected;
}

/** Parent-side final gate immediately before submitChatTurn, after asynchronous credential lookup. */
export function buildCurrentChatTurnCommand(owner: ChatSubmissionOwner, runtime: ChatSubmissionRuntime, state: Readonly<{ knowledge: WorkspaceSnapshotDTO['state']['knowledge']; assistantChatConversations?: WorkspaceSnapshotDTO['state']['assistantChatConversations'] }>, text: string, bindings: readonly ChatKnowledgeSelectionBinding[]): ChatTurnCommand {
  if (!chatSubmissionOwnerIsCurrent(owner, runtime) || !(state.assistantChatConversations ?? []).some((item) => item.id === owner.conversationId)) {
    throw new Error('The conversation changed while checking Chat access. Review the conversation and try again.');
  }
  const knowledgeSelection = resolveChatKnowledgeSelection(state.knowledge, bindings);
  return { conversationId: owner.conversationId, text, ...(knowledgeSelection.length ? { knowledgeSelection } : {}) };
}
