import type { DeepReadonly, WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { AssistantBatchMoreComputePlan } from '../core';

type WorkspaceDisplayState = WorkspaceSnapshotDTO['state'];

export type WorkspaceChatConversationDisplay = WorkspaceDisplayState['assistantChatConversations'][number];
export type WorkspaceChatTurnDisplay = WorkspaceChatConversationDisplay['turns'][number];
export type WorkspaceAssistantBatchJobDisplay = WorkspaceDisplayState['assistantBatchJobs'][number];
export type WorkspaceMoreComputePlanDisplay = DeepReadonly<AssistantBatchMoreComputePlan>;
