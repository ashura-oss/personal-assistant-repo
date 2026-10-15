import type { WorkspaceCommand, WorkspaceCommandReceipt } from '../src/cloud/workspaceCommands';

const commandId = '20000000-0000-4000-8000-000000000001';
const base = { schemaVersion: 1 as const, commandId, objectId: 'safe-id' };

// @ts-expect-error Batch submission receipts must bind the persisted job.
const missingBatchJob: WorkspaceCommandReceipt = { ...base, kind: 'assistant.batch.submitNote' };
// @ts-expect-error Chat submission receipts require both the turn and Batch job.
const missingChatJob: WorkspaceCommandReceipt = { ...base, kind: 'chat.submit', turnId: commandId };
// @ts-expect-error Chat refinement receipts also bind the exact parent turn.
const missingRefinementParent: WorkspaceCommandReceipt = { ...base, kind: 'chat.refine', turnId: commandId, jobId: commandId };
// @ts-expect-error Manual reply successor receipts bind their exact parent and reviewed operation.
const missingReplySuccessorBinding: WorkspaceCommandReceipt = { ...base, kind: 'mail.reply.derive', proposalId: commandId, proposalRevision: 1 };

function requiredByDiscriminant(receipt: WorkspaceCommandReceipt): string {
  switch (receipt.kind) {
    case 'assistant.batch.submitNote': return receipt.jobId;
    case 'chat.submit': return `${receipt.turnId}:${receipt.jobId}`;
    case 'chat.refine': return `${receipt.parentTurnId}:${receipt.turnId}:${receipt.jobId}`;
    default: return receipt.objectId;
  }
}

function selectionIsImmutable(command: WorkspaceCommand): void {
  if ((command.kind === 'assistant.batch.submitNote' || command.kind === 'chat.submit') && command.knowledgeSelection) {
    // @ts-expect-error The public envelope exposes a readonly selection array.
    command.knowledgeSelection.push({ kind: 'person', id: 'new-id' });
    // @ts-expect-error Selection rows are readonly too.
    command.knowledgeSelection[0]!.id = 'changed-id';
  }
}

void [missingBatchJob, missingChatJob, missingRefinementParent, missingReplySuccessorBinding, requiredByDiscriminant, selectionIsImmutable];
