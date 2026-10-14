import type { WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { WorkspaceAssistantBatchJobDisplay, WorkspaceChatConversationDisplay, WorkspaceChatTurnDisplay, WorkspaceMoreComputePlanDisplay } from '../src/ui/workspaceChatDisplayTypes';

export function chatDisplaysFromSnapshot(snapshot: WorkspaceSnapshotDTO): {
  readonly conversations: readonly WorkspaceChatConversationDisplay[];
  readonly jobs: readonly WorkspaceAssistantBatchJobDisplay[];
  readonly turns: readonly WorkspaceChatTurnDisplay[];
} {
  return {
    conversations: snapshot.state.assistantChatConversations,
    jobs: snapshot.state.assistantBatchJobs,
    turns: snapshot.state.assistantChatConversations.flatMap((conversation) => conversation.turns),
  };
}

export function checkReadonlyDisplayContracts(conversation: WorkspaceChatConversationDisplay, job: WorkspaceAssistantBatchJobDisplay,
  plan: WorkspaceMoreComputePlanDisplay): void {
  // @ts-expect-error Snapshot conversation turns are readonly.
  conversation.turns.push(conversation.turns[0]!);
  if (job.moreComputeEfforts) {
    // @ts-expect-error Nested job source rows are readonly.
    job.moreComputeEfforts.push('high');
  }
  // @ts-expect-error Review source labels are readonly.
  plan.preview.sourceLabels.push({ id: 'extra', label: 'Extra' });
  // @ts-expect-error Each source label is readonly.
  plan.preview.sourceLabels[0]!.label = 'Changed';
  void [conversation, job, plan];
}
