import type { DeepReadonly, WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { AssistantBatchMoreComputePlan, KnowledgeSelection } from '../core';
import type { KnowledgeEntityKind } from '../knowledge/types';

type WorkspaceDisplayState = WorkspaceSnapshotDTO['state'];

export type WorkspaceChatConversationDisplay = WorkspaceDisplayState['assistantChatConversations'][number];
export type WorkspaceChatTurnDisplay = WorkspaceChatConversationDisplay['turns'][number];
export type WorkspaceAssistantBatchJobDisplay = WorkspaceDisplayState['assistantBatchJobs'][number];
export type WorkspaceMoreComputePlanDisplay = DeepReadonly<AssistantBatchMoreComputePlan>;
type WorkspaceKnowledge = WorkspaceSnapshotDTO['state']['knowledge'];
export type ChatKnowledgeChoiceDisplay = Readonly<{
  kind: KnowledgeEntityKind;
  id: string;
  name: string;
  revision: number;
  archivedAt?: string;
}>;
export type ChatKnowledgeSelectionBinding = Readonly<Pick<KnowledgeSelection[number], 'kind' | 'id'> & { revision: number }>;

export function projectChatKnowledgeChoices(knowledge: WorkspaceKnowledge): readonly ChatKnowledgeChoiceDisplay[] {
  return [
    ...knowledge.people.map((item) => ({ kind: 'person' as const, id: item.id, name: item.name, revision: item.revision, ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}) })),
    ...knowledge.projects.map((item) => ({ kind: 'project' as const, id: item.id, name: item.name, revision: item.revision, ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}) })),
  ];
}
