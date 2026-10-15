import { describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';
import type { Proposal } from '../src/core';
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
      editPolicy: 'email_fields', canDeriveManualReply: false, id: proposalId, kind: 'email', title: 'Reply', body: 'Saved reply', status: proposalStatus, revision: 2, accountId, recipients: ['to@example.test'],
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

function makeManualReplyCoordinator(options: { loseDeriveAck?: boolean; changeAccountDuringChildReview?: boolean; blockedBeforeAdmission?: boolean;
  failRefreshOnce?: boolean; failChildReviewOnce?: boolean; mismatchedResponseCommandId?: boolean } = {}) {
  const state = createInitialWorkspaceState(() => '66666666-6666-4666-8666-666666666666');
  const identity = { providerNamespace: 'google' as const, clientId: 'manual-client', subject: 'manual-subject' };
  state.accounts.push({ id: accountId, provider: 'google', displayName: 'Work', email: 'me@example.test', connected: true, authStatus: 'connected',
    identity, capabilities: ['mail.read', 'mail.draft', 'mail.send'], connectionGeneration: 4 });
  const sourceDigest = 'a'.repeat(64);
  const source = { version: 1 as const, accountId, accountEmail: 'me@example.test', identity, connectionGeneration: 4, localMessageId: 'message-1',
    providerMessageId: 'provider-message-1', idFormat: 'gmail' as const, threadId: 'thread-1', internetMessageId: '<message-1@example.test>',
    subject: 'Source subject', replyMetadataComplete: true as const, observedAt: '2026-10-15T00:00:00.000Z', sourceDigest };
  const parent: Proposal = { id: proposalId, kind: 'email', title: 'Re: Source subject', body: 'Generated reply', status: 'draft', revision: 2,
    accountId, recipients: ['to@example.test'], evidence: [], sourceActionKey: 'manual-source-action',
    email: { operation: 'draft', to: ['to@example.test'], cc: [], bcc: [], subject: 'Source subject', text: 'Generated reply', attachments: [],
      reply: { mode: 'reply', sourceDigest, localMessageId: 'message-1', providerMessageId: 'provider-message-1', idFormat: 'gmail',
        internetMessageId: '<message-1@example.test>', sourceSubject: 'Source subject', threadId: 'thread-1' } },
    provenance: { version: 2, kind: 'mail_reply', sourceDigest, source, expiresAt: '2026-10-16T00:00:00.000Z', outputPolicyVersion: 2 } };
  state.proposals.push(parent);
  let revision = 7;
  let snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision });
  const childProposalId = '99999999-9999-4999-8999-999999999999';
  const commands: WorkspaceCommand[] = [];
  const proposalReviews = vi.fn(async (id: string, expectedRevision: number): Promise<ProposalReviewReadDto> => {
    if (options.failChildReviewOnce && id === childProposalId) {
      options.failChildReviewOnce = false;
      throw new TypeError('review response unavailable');
    }
    if (options.changeAccountDuringChildReview && id === childProposalId) {
      const account = state.accounts.find((item) => item.id === accountId)!;
      account.connectionGeneration = 5;
      revision += 1;
      snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision });
    }
    const item = state.proposals.find((proposal) => proposal.id === id);
    const provenance = item?.provenance;
    return { schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: expectedRevision, proposal: item ? {
      editPolicy: item.id === proposalId ? 'read_only' : 'manual_reply_fields', canDeriveManualReply: item.id === proposalId && !item.supersededByProposalId,
      ...(item.supersededByProposalId ? { supersededByProposalId: item.supersededByProposalId } : {}), id: item.id, kind: 'email', title: item.title,
      body: item.body, status: item.status, revision: item.revision, ...(item.approvedRevision !== undefined ? { approvedRevision: item.approvedRevision } : {}),
      accountId: item.accountId, recipients: item.recipients, sourceDigest: provenance && (provenance.version === 2 || provenance.version === 3) ? provenance.sourceDigest : undefined,
      email: item.email ? { operation: item.email.operation, to: item.email.to, cc: item.email.cc, bcc: item.email.bcc, subject: item.email.subject,
        text: item.email.text, attachments: [] } : undefined,
    } : undefined };
  });
  let lastResponse: WorkspaceCommandResponse | undefined;
  let refreshFailed = false;
  let refreshRequired = false;
  let commandCounter = 0;
  const workspace: CloudMailWorkspacePort = {
    readSnapshot: () => snapshot,
    readOperation: () => ({ busy: Boolean(options.blockedBeforeAdmission), pending: false, refreshRequired }),
    readMailReplySource: vi.fn(async () => { throw new Error('not used'); }),
    readMailReplyText: vi.fn(async () => { throw new Error('not used'); }),
    readProposalReview: proposalReviews,
    readDispatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision })),
    readReplyBatchReview: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId, privacyEpoch: 3, revision })),
    execute: vi.fn(async (command, onAdmitted) => {
      commands.push(command);
      const commandId = `manual-command-${++commandCounter}`;
      onAdmitted?.({ schemaVersion: 1, commandId, expectedRevision: revision, expectedPrivacyEpoch: 3,
        idempotencyKey: commandId, kind: command.kind, canonicalBody: '{}' } as never);
      if (command.kind === 'mail.reply.derive') {
        refreshRequired = true;
        const currentParent = state.proposals.find((item) => item.id === command.parentProposalId)!;
        const child: Proposal = { ...structuredClone(currentParent), id: childProposalId, revision: 1, status: 'draft', approvedRevision: undefined,
          email: { ...currentParent.email!, operation: command.operation }, provenance: { version: 3, kind: 'manual_mail_reply', sourceDigest,
            source: { ...source }, expiresAt: '2026-10-16T00:00:00.000Z', outputPolicyVersion: 2, operation: command.operation,
            lineage: { kind: 'derived', parentProposalId: currentParent.id, parentRevision: currentParent.revision, parentPayloadDigest: 'b'.repeat(64) } } };
        delete child.supersededByProposalId;
        currentParent.supersededByProposalId = childProposalId;
        state.proposals.unshift(child);
      } else if (command.kind === 'proposals.edit') {
        const current = state.proposals.find((item) => item.id === command.proposalId)!;
        if (command.edit.kind === 'email') {
          current.email = { ...current.email!, operation: command.edit.operation, to: [...command.edit.to], cc: [...command.edit.cc],
            bcc: [...command.edit.bcc], subject: command.edit.subject, text: command.edit.text };
          if (current.provenance?.version === 3 && current.provenance.kind === 'manual_mail_reply') {
            current.provenance = { ...current.provenance, operation: command.edit.operation };
          }
          current.body = command.edit.text;
          current.recipients = [...command.edit.to];
          current.revision += 1;
          current.status = 'draft';
          current.approvedRevision = undefined;
        }
      } else if (command.kind === 'proposals.approve') {
        const current = state.proposals.find((item) => item.id === command.proposalId)!;
        current.status = 'approved';
        current.approvedRevision = current.revision;
      }
      revision += 1;
      snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision });
      const receipt = command.kind === 'mail.reply.derive' ? { schemaVersion: 1, commandId, kind: command.kind, objectId: childProposalId,
        parentProposalId: command.parentProposalId, proposalId: childProposalId, proposalRevision: 1, operation: command.operation }
        : command.kind === 'proposals.edit' ? { schemaVersion: 1, commandId, kind: command.kind, objectId: command.proposalId,
          proposalId: command.proposalId, proposalRevision: state.proposals.find((item) => item.id === command.proposalId)!.revision, proposalStatus: 'draft' }
        : { schemaVersion: 1, commandId, kind: command.kind, objectId: command.proposalId, proposalId: command.proposalId,
          proposalRevision: command.expectedProposalRevision, proposalStatus: 'approved' };
      const responseCommandId = command.kind === 'mail.reply.derive' && options.mismatchedResponseCommandId ? 'untrusted-response-id' : commandId;
      lastResponse = { schemaVersion: 1, commandId: responseCommandId, status: 'finished', receipt: { ...receipt, commandId: responseCommandId } } as WorkspaceCommandResponse;
      if (command.kind === 'mail.reply.derive' && options.loseDeriveAck) throw new TypeError('connection lost after admitted derive');
      return lastResponse;
    }),
    inspect: vi.fn(async (commandId) => {
      if (lastResponse && commandId === lastResponse.commandId) return lastResponse;
      return { schemaVersion: 1 as const, commandId, status: 'inspect_required' as const } as WorkspaceCommandResponse;
    }),
    refresh: vi.fn(async () => {
      if (options.failRefreshOnce && !refreshFailed) { refreshFailed = true; throw new TypeError('refresh temporarily unavailable'); }
      refreshRequired = false;
      return snapshot;
    }),
  };
  return { coordinator: new CloudMailCoordinator(workspace), commands, workspace, state, getSnapshot: () => snapshot,
    refreshSnapshot: () => { snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision }); }, childProposalId };
}

describe('CloudMailCoordinator command receipts', () => {
  it('derives an explicit draft or send copy, verifies it, and waits for user navigation', async () => {
    const { coordinator, commands, workspace, childProposalId } = makeManualReplyCoordinator();
    await coordinator.openProposal(proposalId);
    coordinator.setManualReplyDeriveOperation(proposalId, 'send');
    await coordinator.deriveManualReply(proposalId);
    expect(commands).toEqual([{ kind: 'mail.reply.derive', parentProposalId: proposalId, expectedParentRevision: 2,
      accountId, expectedConnectionGeneration: 4, operation: 'send' }]);
    expect(vi.mocked(workspace.readProposalReview)).toHaveBeenCalledWith(childProposalId, 8);
    expect(coordinator.getSnapshot().manualReplySuccessor).toEqual({ parentProposalId: proposalId, parentRevision: 2,
      childProposalId, confirmedChildRevision: 1 });
    expect(coordinator.getSnapshot().proposalReviewId).toBe(proposalId);
    expect(coordinator.getSnapshot().notice).toContain('no approval or send');

    await coordinator.openManualReplySuccessor();
    expect(coordinator.getSnapshot().proposalReviewId).toBe(childProposalId);
    expect(coordinator.getSnapshot().proposalReview?.proposal).toMatchObject({ editPolicy: 'manual_reply_fields',
      email: { operation: 'send', subject: 'Source subject' } });
    expect(commands).toHaveLength(1);
  });

  it('inspects a lost derive acknowledgement by its original command ID without replaying or navigating automatically', async () => {
    const { coordinator, commands, workspace, childProposalId } = makeManualReplyCoordinator({ loseDeriveAck: true });
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    expect(commands).toHaveLength(1);
    expect(coordinator.getSnapshot().replyHeldCommand).toBe('manual-command-1');
    expect(coordinator.getSnapshot().manualReplySuccessor).toBeUndefined();
    await coordinator.inspectHeldCommand();
    expect(vi.mocked(workspace.inspect)).toHaveBeenCalledWith('manual-command-1');
    expect(commands).toHaveLength(1);
    expect(coordinator.getSnapshot().manualReplySuccessor?.childProposalId).toBe(childProposalId);
    expect(coordinator.getSnapshot().proposalReviewId).toBe(proposalId);
  });

  it('does not publish a derivation context when the command is blocked before admission', async () => {
    const { coordinator, commands, workspace } = makeManualReplyCoordinator({ blockedBeforeAdmission: true });
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    expect(commands).toHaveLength(0);
    expect(coordinator.getSnapshot().manualReplyDerivation).toBeUndefined();
    expect(coordinator.getSnapshot().replyHeldCommand).toBeUndefined();
    expect(vi.mocked(workspace.execute)).not.toHaveBeenCalled();
  });

  it.each(['refresh', 'child review'] as const)('retains the admitted ID when finished derivation verification fails during %s and recovers by exact inspection', async (failure) => {
    const options = failure === 'refresh' ? { failRefreshOnce: true } : { failChildReviewOnce: true };
    const { coordinator, commands, workspace, childProposalId } = makeManualReplyCoordinator(options);
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    expect(commands).toHaveLength(1);
    expect(coordinator.getSnapshot().manualReplyDerivation?.commandId).toBe('manual-command-1');
    expect(coordinator.getSnapshot().replyHeldCommand).toBe('manual-command-1');
    expect(coordinator.getSnapshot().manualReplySuccessor).toBeUndefined();

    await coordinator.inspectHeldCommand();
    expect(vi.mocked(workspace.inspect)).toHaveBeenCalledWith('manual-command-1');
    expect(commands).toHaveLength(1);
    expect(coordinator.getSnapshot().manualReplySuccessor?.childProposalId).toBe(childProposalId);
  });

  it('never substitutes an untrusted response command ID for the admitted derive ID', async () => {
    const { coordinator, commands, workspace } = makeManualReplyCoordinator({ mismatchedResponseCommandId: true });
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    expect(commands).toHaveLength(1);
    expect(coordinator.getSnapshot().replyHeldCommand).toBe('manual-command-1');
    expect(coordinator.getSnapshot().manualReplyDerivation?.commandId).toBe('manual-command-1');
    await coordinator.inspectHeldCommand();
    expect(vi.mocked(workspace.inspect)).toHaveBeenCalledWith('manual-command-1');
    expect(commands).toHaveLength(1);
    expect(coordinator.getSnapshot().manualReplySuccessor).toBeUndefined();
  });

  it('does not open a derived copy if the account reconnects while its child review is loading', async () => {
    const { coordinator, commands, childProposalId } = makeManualReplyCoordinator({ changeAccountDuringChildReview: true });
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    expect(commands).toHaveLength(1);
    expect(coordinator.getSnapshot().manualReplySuccessor).toBeUndefined();
    expect(coordinator.getSnapshot().proposalReviewId).toBe(proposalId);
    expect(coordinator.getSnapshot().replyHeldCommand).toBe('manual-command-1');
    expect(childProposalId).not.toBe(coordinator.getSnapshot().proposalReviewId);
  });

  it('marks manual To, Cc, body, and operation edits dirty, then saves before fresh approval', async () => {
    const { coordinator, commands, childProposalId } = makeManualReplyCoordinator();
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    await coordinator.openManualReplySuccessor();
    await coordinator.approveProposal(childProposalId);
    expect(coordinator.getSnapshot().proposalReview?.proposal?.status).toBe('approved');
    coordinator.updateProposalDraft(childProposalId, { to: 'person@example.test', cc: 'copy@example.test', text: 'Human-edited body.', operation: 'send' });
    expect(coordinator.getSnapshot().proposalDrafts?.[childProposalId]).toMatchObject({ dirty: true, operation: 'send',
      to: 'person@example.test', cc: 'copy@example.test', text: 'Human-edited body.' });
    const saved = await coordinator.editProposal(childProposalId, accountId, 4, { kind: 'email', operation: 'send', to: ['person@example.test'],
      cc: ['copy@example.test'], bcc: [], subject: 'Source subject', text: 'Human-edited body.' });
    expect(saved).toBe(true);
    expect(commands[1]).toMatchObject({ kind: 'proposals.approve', expectedProposalRevision: 1 });
    expect(commands[2]).toMatchObject({ kind: 'proposals.edit', expectedProposalRevision: 1, edit: { kind: 'email', operation: 'send',
      subject: 'Source subject', to: ['person@example.test'], cc: ['copy@example.test'], bcc: [], text: 'Human-edited body.' } });
    expect(coordinator.getSnapshot().proposalDrafts?.[childProposalId]).toMatchObject({ dirty: false, baseRevision: 2, operation: 'send' });
    expect(coordinator.getSnapshot().proposalReview?.proposal).toMatchObject({ status: 'draft', revision: 2,
      email: { operation: 'send', text: 'Human-edited body.' } });
    expect(coordinator.getSnapshot().proposalReview?.proposal).not.toHaveProperty('approvedRevision');
    await coordinator.approveProposal(childProposalId);
    expect(commands[3]).toMatchObject({ kind: 'proposals.approve', expectedProposalRevision: 2 });
    expect(coordinator.getSnapshot().proposalReview?.proposal?.status).toBe('approved');
  });

  it('preserves a dirty child draft when the user explicitly reopens its saved copy', async () => {
    const { coordinator, childProposalId } = makeManualReplyCoordinator();
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    await coordinator.openManualReplySuccessor();
    coordinator.updateProposalDraft(childProposalId, { to: 'unsaved@example.test', text: 'Keep these unsaved edits.' });
    await coordinator.openManualReplySuccessor();
    expect(coordinator.getSnapshot().proposalDrafts?.[childProposalId]).toMatchObject({ dirty: true,
      to: 'unsaved@example.test', text: 'Keep these unsaved edits.' });
  });

  it('reopens the current edited child revision and operation from its superseded parent', async () => {
    const { coordinator, commands, childProposalId } = makeManualReplyCoordinator();
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    await coordinator.openManualReplySuccessor();
    coordinator.updateProposalDraft(childProposalId, { operation: 'send', text: 'Saved send copy.' });
    expect(await coordinator.editProposal(childProposalId, accountId, 4, { kind: 'email', operation: 'send', to: ['to@example.test'],
      cc: [], bcc: [], subject: 'Source subject', text: 'Saved send copy.' })).toBe(true);
    expect(coordinator.getSnapshot().proposalReview?.proposal).toMatchObject({ revision: 2, email: { operation: 'send' } });

    await coordinator.openProposal(proposalId);
    await coordinator.openManualReplySuccessor();
    expect(coordinator.getSnapshot().proposalReviewId).toBe(childProposalId);
    expect(coordinator.getSnapshot().proposalReview?.proposal).toMatchObject({ revision: 2, editPolicy: 'manual_reply_fields',
      status: 'draft', email: { operation: 'send', text: 'Saved send copy.' } });
    expect(commands.map((command) => command.kind)).toEqual(['mail.reply.derive', 'proposals.edit']);
  });

  it.each(['lineage', 'account'] as const)('rejects reopening when the current child %s binding is tampered', async (tamper) => {
    const { coordinator, childProposalId, state, workspace, refreshSnapshot } = makeManualReplyCoordinator();
    await coordinator.openProposal(proposalId);
    await coordinator.deriveManualReply(proposalId);
    const child = state.proposals.find((item) => item.id === childProposalId)!;
    if (tamper === 'lineage' && child.provenance?.version === 3) child.provenance = { ...child.provenance, lineage: { kind: 'derived', parentProposalId: jobId,
      parentRevision: 2, parentPayloadDigest: 'c'.repeat(64) } };
    if (tamper === 'account') child.accountId = jobId;
    refreshSnapshot();
    await coordinator.openManualReplySuccessor();
    expect(coordinator.getSnapshot().proposalReviewId).toBe(proposalId);
    expect(coordinator.getSnapshot().notice).toContain('saved copy changed');
    expect(vi.mocked(workspace.readProposalReview)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(workspace.readProposalReview)).toHaveBeenNthCalledWith(2, childProposalId, 8);
  });

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
