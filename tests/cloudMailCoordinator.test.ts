import { describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';
import type { ProposalReviewReadDto } from '../src/web/mailWorkflowDtos';
import { CloudMailCoordinator, type CloudMailWorkspacePort } from '../src/web/cloudMailCoordinator';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';
const planId = '55555555-5555-4555-8555-555555555555';

function makeCoordinator(initialProposalStatus: NonNullable<ProposalReviewReadDto['proposal']>['status'] = 'draft') {
  const state = createInitialWorkspaceState(() => '66666666-6666-4666-8666-666666666666');
  state.accounts.push({ id: accountId, provider: 'google', displayName: 'Work', email: 'me@example.test', connected: true, authStatus: 'connected',
    identity: { providerNamespace: 'google', subject: 'private' }, capabilities: ['mail.read', 'mail.draft'], connectionGeneration: 4 });
  const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
  let proposalStatus: NonNullable<ProposalReviewReadDto['proposal']>['status'] = initialProposalStatus;
  const commands: WorkspaceCommand[] = [];
  let commandCounter = 0;
  const response = (command: WorkspaceCommand): WorkspaceCommandResponse => {
    const commandId = `77777777-7777-4777-8777-${String(++commandCounter).padStart(12, '0')}`;
    commands.push(command);
    if (command.kind === 'proposals.approve') {
      proposalStatus = 'approved';
      return { schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId, kind: command.kind, objectId: proposalId,
        proposalId, proposalRevision: 2, proposalStatus: 'approved' } };
    }
    if (command.kind === 'proposals.execute') {
      proposalStatus = 'unknown';
      return { schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId, kind: command.kind, objectId: proposalId,
        proposalId, proposalRevision: 2, proposalStatus: 'unknown', execution: 'unknown', dispatchRecordId: '88888888-8888-4888-8888-888888888888' } };
    }
    if (command.kind === 'proposals.dismiss') {
      proposalStatus = 'dismissed';
      return { schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId, kind: command.kind, objectId: proposalId,
        proposalId, proposalRevision: 2, proposalStatus: 'dismissed' } };
    }
    if (command.kind === 'mail.replyBatch.activate') {
      return { schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId, kind: command.kind, objectId: proposalId, jobId, proposalId } };
    }
    throw new Error(`unexpected command ${command.kind}`);
  };
  const workspace: CloudMailWorkspacePort = {
    readSnapshot: () => snapshot,
    readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
    readMailReplySource: vi.fn(async () => { throw new Error('not used'); }),
    readMailReplyText: vi.fn(async () => { throw new Error('not used'); }),
    readProposalReview: vi.fn(async (): Promise<ProposalReviewReadDto> => ({ schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: 7, proposal: {
      editPolicy: 'email_fields', id: proposalId, kind: 'email', title: 'Reply', body: 'Saved reply', status: proposalStatus, revision: 2, accountId, recipients: ['to@example.test'],
      email: { operation: 'draft', to: ['to@example.test'], cc: [], bcc: [], subject: 'Reply subject', text: 'Saved reply', attachments: [] },
    } })),
    readDispatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7 })),
    readReplyBatchReview: vi.fn(async (plan: { planId: string; jobId: string; accountId: string; expectedConnectionGeneration: number }) => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision: 7, plan: {
      planId: plan.planId, jobId: plan.jobId, messageId: 'message-1', accountId: plan.accountId, connectionGeneration: plan.expectedConnectionGeneration,
      mode: 'reply' as const, operation: 'draft' as const, subject: 'Reply', to: ['to@example.test'], cc: [], text: 'Generated', expiresAt: '2099-01-01T00:00:00.000Z',
    } })),
    execute: vi.fn(async (command) => response(command)),
    inspect: vi.fn(async () => { throw new Error('not used'); }),
    refresh: vi.fn(async () => snapshot),
  };
  return { coordinator: new CloudMailCoordinator(workspace), commands, workspace };
}

describe('CloudMailCoordinator command receipts', () => {
  it('accepts same-revision approval and dismissal receipts, and preserves unknown execute semantics', async () => {
    const { coordinator, commands } = makeCoordinator();
    await coordinator.openProposal(proposalId);
    await coordinator.approveProposal(proposalId);
    expect(commands[0]).toMatchObject({ kind: 'proposals.approve', proposalId, expectedProposalRevision: 2 });
    expect(coordinator.getSnapshot().proposalReview?.proposal?.status).toBe('approved');

    await coordinator.executeProposal(proposalId);
    expect(commands[1]).toMatchObject({ kind: 'proposals.execute', proposalId, expectedProposalRevision: 2 });
    expect(coordinator.getSnapshot().notice).toContain('delivery outcome is unknown');
    expect(coordinator.getSnapshot().notice).toContain('nothing will be sent again automatically');
    expect(coordinator.getSnapshot().proposalReview?.proposal?.status).toBe('unknown');

    const edit = { kind: 'email' as const, operation: 'draft' as const, to: ['to@example.test'], cc: [], bcc: [], subject: 'Changed', text: 'Changed' };
    await expect(coordinator.editProposal(proposalId, accountId, 4, edit)).resolves.toBe(false);
    await coordinator.executeProposal(proposalId);
    await coordinator.dismissProposal(proposalId);
    expect(commands).toHaveLength(2);
    expect(coordinator.getSnapshot().proposalReview?.proposal?.status).toBe('unknown');

    const fresh = makeCoordinator();
    await fresh.coordinator.openProposal(proposalId);
    await fresh.coordinator.dismissProposal(proposalId);
    expect(fresh.commands).toEqual([{ kind: 'proposals.dismiss', proposalId, expectedProposalRevision: 2 }]);
    expect(fresh.coordinator.getSnapshot().proposalReview?.proposal?.status).toBe('dismissed');
  });

  it('applies the checked recipient defaults when changing reply mode', async () => {
    const { coordinator, workspace } = makeCoordinator();
    vi.mocked(workspace.readMailReplySource).mockResolvedValue({ schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: 7, status: 'current',
      source: { accountId, connectionGeneration: 4, localMessageId: 'message-1', providerMessageId: 'provider-message', idFormat: 'gmail',
        internetMessageId: '<message@example.test>', subject: 'Original', observedAt: '2026-10-15T00:00:00.000Z', sourceDigest: 'source-v1' },
      defaults: { reply: { to: ['sender@example.test'], cc: [] }, reply_all: { to: ['sender@example.test'], cc: ['team@example.test'] } },
      bodyCache: { status: 'current', completeness: 'complete_text', representation: 'plain' } });
    vi.mocked(workspace.readMailReplyText).mockResolvedValue({ schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: 7, status: 'current' });
    await coordinator.openReply('message-1');
    coordinator.updateReplyDraft({ to: 'manual@example.test', cc: 'other@example.test' });
    coordinator.updateReplyMode('reply_all');
    expect(coordinator.getSnapshot().replyDraft).toMatchObject({ mode: 'reply_all', to: 'sender@example.test', cc: 'team@example.test' });
  });

  it('binds delayed reply activation to the exact plan and created proposal receipt object', async () => {
    const { coordinator, commands } = makeCoordinator();
    const plan = { planId, jobId, accountId, expectedConnectionGeneration: 4 } as const;
    await coordinator.reviewBatchPlan(plan);
    await coordinator.activateReplyBatch();
    expect(commands).toEqual([{ kind: 'mail.replyBatch.activate', planId, jobId, accountId, expectedConnectionGeneration: 4 }]);
    expect(coordinator.getSnapshot().proposalReviewId).toBe(proposalId);
  });
});
