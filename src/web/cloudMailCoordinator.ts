import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import type { DispatchReconciliation } from '../dispatch';
import type { DispatchReviewReadDto, MailReplyBatchReviewReadDto, MailReplySourceReadDto, MailReplyTextReadDto, ProposalReviewReadDto } from './mailWorkflowDtos';
import type { ReplyBatchPlanRead } from './cloudMailClient';
import { WorkspaceCommandNotStartedError, WorkspaceClientError, type WorkspaceCommandAdmission } from './workspaceClient';

type MailIdentityFields = Readonly<{ providerNamespace?: string; clientId?: string; subject: string; issuer?: string; tenantId?: string; resourceUserId?: string }>;
function sameMailAccountIdentity(a: MailIdentityFields | undefined, b: MailIdentityFields | undefined): boolean {
  return Boolean(a && b && a.providerNamespace && b.providerNamespace && a.providerNamespace === b.providerNamespace && (a.clientId ?? '') === (b.clientId ?? '') &&
    a.subject === b.subject && (a.issuer ?? '') === (b.issuer ?? '') && (a.tenantId ?? '') === (b.tenantId ?? '') &&
    (a.resourceUserId ?? '') === (b.resourceUserId ?? ''));
}

export type CloudMailDraft = Readonly<{
  messageId: string;
  accountId: string;
  connectionGeneration: number;
  sourceDigest: string;
  mode: 'reply' | 'reply_all';
  to: string;
  cc: string;
  text: string;
  brief: string;
  composerRevision: number;
  useSavedText: boolean;
}>;

type AcceptedDraftPromotionContext = Readonly<{ parentProposalId: string; parentRevision: number; draftDispatchRecordId: string;
  accountId: string; connectionGeneration: number; provider: 'google' | 'microsoft'; remoteDraftId: string;
  sourceDigest: string; commandId?: string }>;

export type CloudProposalDraft = Readonly<{
  proposalId: string;
  baseRevision: number;
  generation: number;
  dirty: boolean;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  operation: 'draft' | 'send';
  eventTitle: string;
  eventDescription: string;
  eventStart: string;
  eventEnd: string;
  eventTimeZone: string;
  eventAttendees: string;
  eventInvite: 'send' | 'none';
  calendarId: string;
}>;

export type CloudMailCoordinatorState = Readonly<{
  selectedAccountId?: string;
  replyDraft?: CloudMailDraft;
  replySource?: MailReplySourceReadDto;
  replyText?: MailReplyTextReadDto;
  replyBusy?: 'opening' | 'loading_text' | 'saving' | 'batch';
  replyNeedsRebind?: boolean;
  replyHeldCommand?: string;
  replyHeldKind?: WorkspaceCommand['kind'];
  proposalReview?: ProposalReviewReadDto;
  proposalReviewId?: string;
  proposalDrafts?: Readonly<Record<string, CloudProposalDraft>>;
  proposalSavingId?: string;
  proposalSavingGeneration?: number;
  manualReplyDeriveOperations?: Readonly<Record<string, 'draft' | 'send'>>;
  manualReplyDerivation?: Readonly<{ parentProposalId: string; parentRevision: number; accountId: string; connectionGeneration: number;
    sourceDigest: string; operation: 'draft' | 'send'; commandId?: string }>;
  manualReplySuccessor?: Readonly<{ parentProposalId: string; parentRevision: number; childProposalId: string; confirmedChildRevision: number }>;
  acceptedDraftPromotion?: AcceptedDraftPromotionContext;
  acceptedDraftSuccessor?: Readonly<{ parentProposalId: string; parentRevision: number; draftDispatchRecordId: string; accountId: string;
    connectionGeneration: number; provider: 'google' | 'microsoft'; sourceDigest: string; childProposalId: string; confirmedChildRevision: number }>;
  dispatchReview?: DispatchReviewReadDto;
  dispatchReviewId?: string;
  batchReview?: MailReplyBatchReviewReadDto;
  batchReviewKey?: ReplyBatchPlanRead;
  notice?: string;
}>;

export type CloudMailWorkspacePort = Readonly<{
  readSnapshot: () => WorkspaceSnapshotDTO | undefined;
  readOperation: () => Readonly<{ busy: boolean; pending: boolean; refreshRequired: boolean; pendingCommandId?: string }>;
  readMailReplySource: (messageId: string, expectedRevision: number) => Promise<MailReplySourceReadDto>;
  readMailReplyText: (messageId: string, expectedRevision: number, source: NonNullable<MailReplySourceReadDto['source']>) => Promise<MailReplyTextReadDto>;
  readProposalReview: (proposalId: string, expectedRevision: number) => Promise<ProposalReviewReadDto>;
  readDispatchReview: (recordId: string, expectedRevision: number) => Promise<DispatchReviewReadDto>;
  readReplyBatchReview: (plan: ReplyBatchPlanRead, expectedRevision: number) => Promise<MailReplyBatchReviewReadDto>;
  execute: (command: WorkspaceCommand, onAdmitted?: (envelope: WorkspaceCommandAdmission) => void) => Promise<WorkspaceCommandResponse>;
  inspect: (commandId: string) => Promise<WorkspaceCommandResponse>;
  refresh: () => Promise<WorkspaceSnapshotDTO | undefined>;
}>;

export class CloudMailCoordinator {
  private value: CloudMailCoordinatorState = Object.freeze({});
  private readonly listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private operationLock?: object;
  private replySequence = 0;
  private reviewSequence = 0;
  private dispatchSequence = 0;
  private batchSequence = 0;
  private heldCommandId?: string;
  private proposalGeneration = 0;

  constructor(private readonly workspace: CloudMailWorkspacePort) {}

  readonly getSnapshot = (): CloudMailCoordinatorState => this.value;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  private publish(next: CloudMailCoordinatorState): void {
    if (!this.active) return;
    this.value = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }

  private owner() {
    const snapshot = this.workspace.readSnapshot();
    if (!this.active || !snapshot) throw new WorkspaceClientError('snapshot_required', 'Refresh the workspace before continuing.');
    return Object.freeze({ workspaceId: snapshot.workspaceId, privacyEpoch: snapshot.privacyEpoch, revision: snapshot.revision, generation: this.generation });
  }

  private isOwner(owner: ReturnType<CloudMailCoordinator['owner']>): boolean {
    const latest = this.workspace.readSnapshot();
    return this.active && owner.generation === this.generation && latest?.workspaceId === owner.workspaceId && latest.privacyEpoch === owner.privacyEpoch;
  }

  private mutationReady(owner: ReturnType<CloudMailCoordinator['owner']>): boolean {
    if (!this.isOwner(owner)) return false;
    const operation = this.workspace.readOperation();
    return !operation.busy && !operation.pending && !operation.refreshRequired && !this.operationLock && !this.heldCommandId &&
      !this.value.manualReplyDerivation && !this.value.acceptedDraftPromotion;
  }

  private tryLock(): object | undefined {
    if (!this.active || this.operationLock) return undefined;
    const token = {};
    this.operationLock = token;
    return token;
  }

  private unlock(token: object): void { if (this.operationLock === token) this.operationLock = undefined; }

  private account(accountId: string, connectionGeneration?: number) {
    const snapshot = this.workspace.readSnapshot();
    const account = snapshot?.state.accounts.find((entry) => entry.id === accountId);
    if (!account || !account.connected || account.authStatus !== 'connected' ||
        (connectionGeneration !== undefined && account.connectionGeneration !== connectionGeneration)) return undefined;
    return account;
  }

  private proposalDraftFrom(proposal: NonNullable<ProposalReviewReadDto['proposal']>): CloudProposalDraft {
    return Object.freeze({ proposalId: proposal.id, baseRevision: proposal.revision, generation: ++this.proposalGeneration, dirty: false,
      to: proposal.email?.to.join(', ') ?? '', cc: proposal.email?.cc.join(', ') ?? '', bcc: proposal.email?.bcc.join(', ') ?? '',
      subject: proposal.email?.subject ?? '', text: proposal.email?.text ?? '', operation: proposal.email?.operation ?? 'draft', eventTitle: proposal.event?.title ?? '',
      eventDescription: proposal.event?.description ?? '', eventStart: proposal.event?.start ?? '', eventEnd: proposal.event?.end ?? '',
      eventTimeZone: proposal.event?.timeZone ?? this.workspace.readSnapshot()?.state.settings.timezone ?? 'UTC',
      eventAttendees: proposal.event?.attendees.join(', ') ?? '', eventInvite: proposal.event?.invitePolicy ?? 'none', calendarId: proposal.calendarId ?? '' });
  }

  getProposalDraft(proposalId: string): CloudProposalDraft | undefined { return this.value.proposalDrafts?.[proposalId]; }

  updateProposalDraft(proposalId: string, patch: Partial<Omit<CloudProposalDraft, 'proposalId' | 'baseRevision' | 'generation' | 'dirty'>>): void {
    const proposal = this.value.proposalReview?.proposal;
    const draft = this.getProposalDraft(proposalId);
    if (!proposal || proposal.id !== proposalId || !draft || proposal.supersededByProposalId || !['draft', 'failed', 'approved'].includes(proposal.status) ||
        proposal.editPolicy === 'read_only') return;
    const keys = Object.keys(patch);
    if (proposal.editPolicy === 'manual_reply_fields' && keys.some((key) => !['to', 'cc', 'text', 'operation'].includes(key))) return;
    if (proposal.editPolicy === 'manual_reply_send_fields' && keys.some((key) => !['to', 'cc', 'text'].includes(key))) return;
    if (proposal.editPolicy === 'source_reply_fields' && keys.some((key) => !['to', 'cc', 'text'].includes(key))) return;
    if (patch.operation && patch.operation !== 'draft' && patch.operation !== 'send') return;
    if (patch.operation === 'send' && (!proposal.accountId || !this.account(proposal.accountId)?.capabilities?.includes('mail.send'))) {
      this.publish({ ...this.value, notice: 'Send permission is not available for this connected account.' });
      return;
    }
    if (proposal.editPolicy === 'manual_reply_fields' && patch.operation === 'draft' &&
        (!proposal.accountId || !this.account(proposal.accountId)?.capabilities?.includes('mail.draft'))) {
      this.publish({ ...this.value, notice: 'Draft permission is not available for this connected account.' });
      return;
    }
    const generation = ++this.proposalGeneration;
    this.publish({ ...this.value, proposalDrafts: { ...this.value.proposalDrafts, [proposalId]: Object.freeze({ ...draft, ...patch, generation, dirty: true }) } });
  }

  reloadProposalDraft(proposalId: string): void {
    const proposal = this.value.proposalReview?.proposal;
    if (!proposal || proposal.id !== proposalId) return;
    this.publish({ ...this.value, proposalDrafts: { ...this.value.proposalDrafts, [proposalId]: this.proposalDraftFrom(proposal) }, notice: undefined });
  }

  private proposalMutationReady(proposal: NonNullable<ProposalReviewReadDto['proposal']>): boolean {
    const draft = this.getProposalDraft(proposal.id);
    return Boolean(!proposal.supersededByProposalId && draft && !draft.dirty && draft.baseRevision === proposal.revision && !this.value.proposalSavingId);
  }

  setManualReplyDeriveOperation(proposalId: string, operation: 'draft' | 'send'): void {
    const proposal = this.value.proposalReview?.proposal;
    if (!proposal || proposal.id !== proposalId || !proposal.canDeriveManualReply || proposal.supersededByProposalId) return;
    if (operation === 'draft' && (!proposal.accountId || !this.account(proposal.accountId)?.capabilities?.includes('mail.draft'))) {
      this.publish({ ...this.value, notice: 'Draft permission is not available for this connected account.' });
      return;
    }
    if (operation === 'send' && (!proposal.accountId || !this.account(proposal.accountId)?.capabilities?.includes('mail.send'))) {
      this.publish({ ...this.value, notice: 'Send permission is not available for this connected account.' });
      return;
    }
    this.publish({ ...this.value, manualReplyDeriveOperations: { ...this.value.manualReplyDeriveOperations, [proposalId]: operation }, notice: undefined });
  }

  async promoteAcceptedDraft(proposalId: string): Promise<void> {
    const proposal = this.value.proposalReview?.proposal;
    const metadata = proposal?.draftPromotion;
    const owner = this.owner();
    const snapshot = this.workspace.readSnapshot();
    const parent = snapshot?.state.proposals.find((item) => item.id === proposalId);
    const account = proposal?.accountId ? this.account(proposal.accountId) : undefined;
    const record = metadata ? snapshot?.state.dispatchRecords.find((item) => item.id === metadata.draftDispatchRecordId) : undefined;
    if (!proposal || proposal.id !== proposalId || proposal.kind !== 'email' || !proposal.email || !metadata || !snapshot || !parent ||
        proposal.revision !== parent.revision || proposal.status !== 'accepted' || proposal.supersededByProposalId || parent.supersededByProposalId ||
        parent.simulated || parent.status !== 'accepted' || parent.remoteOperation !== 'draft' || parent.email?.operation !== 'draft' ||
        !parent.remoteId || proposal.remoteId !== parent.remoteId || proposal.remoteOperation !== 'draft' || !proposal.sourceDigest ||
        !account || account.provider !== metadata.provider || !Number.isSafeInteger(account.connectionGeneration) ||
        !account.capabilities?.includes('mail.send') || !record || record.id !== metadata.draftDispatchRecordId || record.proposalId !== parent.id ||
        record.accountId !== account.id || record.operation !== 'draft' || record.outcome !== 'accepted' || record.remoteId !== parent.remoteId ||
        !this.proposalMutationReady(proposal) || this.value.acceptedDraftPromotion || this.heldCommandId) {
      this.publish({ ...this.value, notice: 'This saved draft or its account binding changed. Refresh and review the current saved proposal before promoting it.' });
      return;
    }
    let context: AcceptedDraftPromotionContext | undefined;
    let admittedCommandId: string | undefined;
    try {
      const response = await this.runCommand({ kind: 'mail.reply.promoteDraft', parentProposalId: proposalId,
        expectedParentRevision: proposal.revision, draftDispatchRecordId: metadata.draftDispatchRecordId, accountId: account.id,
        expectedConnectionGeneration: account.connectionGeneration! }, 'mail.reply.promoteDraft', undefined, {
          strictAdmissionIdentity: true, onAdmitted: (commandId) => {
            admittedCommandId = commandId;
            const admittedSnapshot = this.workspace.readSnapshot();
            const admittedParent = admittedSnapshot?.state.proposals.find((item) => item.id === proposalId);
            const admittedReview = this.value.proposalReview?.proposal;
            const admittedAccount = this.account(account.id, account.connectionGeneration);
            const admittedRecord = admittedSnapshot?.state.dispatchRecords.find((item) => item.id === metadata.draftDispatchRecordId);
            if (admittedParent && admittedReview?.id === proposalId && admittedReview.revision === proposal.revision &&
                admittedReview.draftPromotion?.draftDispatchRecordId === metadata.draftDispatchRecordId &&
                admittedReview.draftPromotion.provider === metadata.provider && admittedReview.remoteId === parent.remoteId &&
                admittedReview.sourceDigest === proposal.sourceDigest && admittedParent.revision === proposal.revision &&
                admittedParent.remoteId === parent.remoteId && admittedParent.status === 'accepted' && admittedParent.supersededByProposalId === undefined &&
                admittedAccount?.provider === metadata.provider && admittedAccount.connectionGeneration === account.connectionGeneration &&
                admittedRecord?.id === metadata.draftDispatchRecordId && admittedRecord.proposalId === proposalId &&
                admittedRecord.outcome === 'accepted' && admittedRecord.remoteId === parent.remoteId) {
              context = Object.freeze({ parentProposalId: proposalId, parentRevision: proposal.revision, draftDispatchRecordId: metadata.draftDispatchRecordId,
                accountId: admittedAccount.id, connectionGeneration: admittedAccount.connectionGeneration!, provider: metadata.provider,
                remoteDraftId: admittedReview.remoteId!, sourceDigest: admittedReview.sourceDigest!, commandId });
              if (this.isOwner(owner)) this.publish({ ...this.value, acceptedDraftPromotion: context,
                notice: 'Creating a reviewed send copy from the accepted provider draft. Its saved contents are unverified and it has not been sent.' });
            }
          },
        });
      if (!response || !this.isOwner(owner)) return;
      this.heldCommandId = admittedCommandId;
      const receipt = response.receipt;
      if (!context || response.commandId !== admittedCommandId || response.status !== 'finished' || !receipt || receipt.commandId !== admittedCommandId ||
          receipt.kind !== 'mail.reply.promoteDraft' || receipt.parentProposalId !== proposalId || receipt.parentProposalRevision !== proposal.revision ||
          receipt.draftDispatchRecordId !== metadata.draftDispatchRecordId || receipt.accountId !== account.id ||
          receipt.connectionGeneration !== account.connectionGeneration || receipt.operation !== 'send' || !receipt.childProposalId ||
          receipt.objectId !== receipt.childProposalId || !Number.isSafeInteger(receipt.childProposalRevision)) {
        this.holdAcceptedDraftPromotion(context, admittedCommandId, 'The promotion did not return its exact parent, draft, account, and child receipt. Inspect it before continuing.');
        return;
      }
      const confirmed = await this.confirmAcceptedDraftSuccessor(context, response, owner, false);
      if (!confirmed && this.isOwner(owner)) this.holdAcceptedDraftPromotion(context, admittedCommandId,
        'The promotion was admitted, but its saved result could not be verified. Inspect the exact receipt before continuing.');
    } catch (error) {
      if (!this.isOwner(owner)) return;
      if (error instanceof WorkspaceCommandNotStartedError && !admittedCommandId) {
        this.publish({ ...this.value, acceptedDraftPromotion: undefined, notice: error.message });
      } else this.holdAcceptedDraftPromotion(context, admittedCommandId,
        error instanceof WorkspaceClientError ? error.message : 'The promotion could not be confirmed. Inspect its exact receipt; it will not be retried automatically.');
    }
  }

  private holdAcceptedDraftPromotion(context: AcceptedDraftPromotionContext | undefined, commandId: string | undefined, notice: string): void {
    this.heldCommandId = commandId;
    this.publish({ ...this.value, ...(context ? { acceptedDraftPromotion: Object.freeze({ ...context, ...(commandId ? { commandId } : {}) }) } : {}),
      replyHeldCommand: commandId, replyHeldKind: 'mail.reply.promoteDraft', notice });
  }

  private async confirmAcceptedDraftSuccessor(context: AcceptedDraftPromotionContext, response: WorkspaceCommandResponse,
    owner: ReturnType<CloudMailCoordinator['owner']>, forceRefresh: boolean): Promise<boolean> {
    const receipt = response.receipt;
    if (response.status !== 'finished' || !receipt || receipt.kind !== 'mail.reply.promoteDraft' || receipt.commandId !== response.commandId ||
        receipt.parentProposalId !== context.parentProposalId || receipt.parentProposalRevision !== context.parentRevision ||
        receipt.draftDispatchRecordId !== context.draftDispatchRecordId || receipt.accountId !== context.accountId ||
        receipt.connectionGeneration !== context.connectionGeneration || receipt.operation !== 'send' || !receipt.childProposalId ||
        receipt.objectId !== receipt.childProposalId || !Number.isSafeInteger(receipt.childProposalRevision)) return false;
    const refreshed = forceRefresh ? await this.workspace.refresh() : await this.refreshAfterReceipt(owner);
    if (!refreshed || !this.isOwner(owner)) return false;
    const parent = refreshed.state.proposals.find((item) => item.id === context.parentProposalId);
    const child = refreshed.state.proposals.find((item) => item.id === receipt.childProposalId);
    const account = refreshed.state.accounts.find((item) => item.id === context.accountId);
    const record = refreshed.state.dispatchRecords.find((item) => item.id === context.draftDispatchRecordId);
    if (!parent || parent.revision !== context.parentRevision || parent.supersededByProposalId !== child?.id || parent.status !== 'accepted' ||
        parent.remoteOperation !== 'draft' || parent.remoteId !== context.remoteDraftId ||
        parent.simulated || !child || child.revision < receipt.childProposalRevision || child.accountId !== context.accountId || child.status !== 'draft' ||
        child.email?.operation !== 'send' ||
        !record || record.proposalId !== parent.id || record.accountId !== context.accountId || record.operation !== 'draft' ||
        record.outcome !== 'accepted' || record.remoteId !== context.remoteDraftId || !account?.connected || account.authStatus !== 'connected' ||
        account.connectionGeneration !== context.connectionGeneration || account.provider !== context.provider || !account.capabilities?.includes('mail.send')) {
      this.holdAcceptedDraftPromotion(context, response.commandId, 'The saved send copy or its original accepted draft binding could not be verified. Refresh before continuing.');
      return false;
    }
    const review = await this.workspace.readProposalReview(child.id, refreshed.revision);
    if (!this.isOwner(owner)) return false;
    const latest = this.workspace.readSnapshot();
    if (!latest || latest.workspaceId !== owner.workspaceId || latest.privacyEpoch !== owner.privacyEpoch || latest.revision !== refreshed.revision ||
        review.revision !== refreshed.revision || review.proposal?.id !== child.id || review.proposal.revision !== child.revision ||
        review.proposal.editPolicy !== 'manual_reply_send_fields' || review.proposal.email?.operation !== 'send' || review.proposal.sourceDigest !== context.sourceDigest ||
        review.proposal.canDeriveManualReply || review.proposal.acceptedDraftCopy?.parentProposalId !== context.parentProposalId ||
        review.proposal.acceptedDraftCopy.draftDispatchRecordId !== context.draftDispatchRecordId || review.proposal.acceptedDraftCopy.provider !== context.provider) {
      this.holdAcceptedDraftPromotion(context, response.commandId, 'The send copy was saved, but its current review could not be confirmed. Refresh before opening or continuing.');
      return false;
    }
    this.heldCommandId = undefined;
    this.publish({ ...this.value, acceptedDraftPromotion: undefined, replyHeldCommand: undefined, replyHeldKind: undefined,
      acceptedDraftSuccessor: { parentProposalId: context.parentProposalId, parentRevision: context.parentRevision,
        draftDispatchRecordId: context.draftDispatchRecordId, accountId: context.accountId, connectionGeneration: context.connectionGeneration,
        provider: context.provider, sourceDigest: context.sourceDigest, childProposalId: child.id, confirmedChildRevision: child.revision },
      notice: 'Reviewed send copy saved. Review its contents and approve it separately before execution.' });
    return true;
  }

  async deriveManualReply(proposalId: string): Promise<void> {
    const proposal = this.value.proposalReview?.proposal;
    if (!proposal || proposal.id !== proposalId || !proposal.canDeriveManualReply || proposal.supersededByProposalId ||
        proposal.kind !== 'email' || !proposal.accountId || !proposal.email || this.value.manualReplyDerivation || this.heldCommandId) return;
    const snapshot = this.workspace.readSnapshot();
    const savedParent = snapshot?.state.proposals.find((item) => item.id === proposalId);
    const savedParentProvenance = savedParent?.provenance;
    const savedSourceDigest = savedParentProvenance && (savedParentProvenance.version === 2 || savedParentProvenance.version === 3)
      ? savedParentProvenance.sourceDigest : undefined;
    const account = this.account(proposal.accountId);
    const operation = this.value.manualReplyDeriveOperations?.[proposalId] ?? 'draft';
    const draft = this.getProposalDraft(proposalId);
    if (!savedParent || savedParent.revision !== proposal.revision || savedParent.supersededByProposalId ||
        !savedSourceDigest || savedSourceDigest !== proposal.sourceDigest || !account || !Number.isSafeInteger(account.connectionGeneration) ||
        !draft || draft.dirty || draft.baseRevision !== proposal.revision || !account.capabilities?.includes(operation === 'draft' ? 'mail.draft' : 'mail.send')) {
      this.publish({ ...this.value, notice: 'This reply or its account permission changed. Refresh and review the saved source before creating a copy.' });
      return;
    }
    const context = Object.freeze({ parentProposalId: proposalId, parentRevision: proposal.revision, accountId: account.id,
      connectionGeneration: account.connectionGeneration!, sourceDigest: savedSourceDigest, operation });
    const owner = this.owner();
    let admittedCommandId: string | undefined;
    try {
      const response = await this.runCommand({ kind: 'mail.reply.derive', parentProposalId: proposalId, expectedParentRevision: proposal.revision,
        accountId: account.id, expectedConnectionGeneration: account.connectionGeneration!, operation }, 'mail.reply.derive', undefined,
        { strictAdmissionIdentity: true, onAdmitted: (commandId) => {
          admittedCommandId = commandId;
          if (this.isOwner(owner)) this.publish({ ...this.value, manualReplyDerivation: { ...context, commandId }, notice: 'Creating an editable copy from the saved reply. No model request will be made.' });
        } });
      if (!response || !this.isOwner(owner)) return;
      this.heldCommandId = admittedCommandId;
      this.publish({ ...this.value, manualReplyDerivation: { ...context, ...(admittedCommandId ? { commandId: admittedCommandId } : {}) } });
      const receipt = response.receipt;
      if (response.commandId !== admittedCommandId || response.status !== 'finished' || !receipt || receipt.commandId !== admittedCommandId ||
          receipt.kind !== 'mail.reply.derive' || receipt.parentProposalId !== proposalId ||
          receipt.operation !== operation || !receipt.proposalId || receipt.objectId !== receipt.proposalId || !Number.isSafeInteger(receipt.proposalRevision)) {
        this.holdManualReplyDerivation(context, admittedCommandId, 'The copy command did not return its exact parent, operation, and child receipt. Inspect it before continuing.');
        return;
      }
      const confirmed = await this.confirmManualReplySuccessor(context, response, owner, false);
      if (!confirmed && this.isOwner(owner)) this.holdManualReplyDerivation(context, admittedCommandId,
        'The copy command was admitted, but its saved result could not be verified. Inspect the exact command before continuing.');
    } catch (error) {
      if (!this.isOwner(owner)) return;
      if (error instanceof WorkspaceCommandNotStartedError && !admittedCommandId) {
        this.publish({ ...this.value, manualReplyDerivation: undefined, notice: error.message });
      } else {
        this.holdManualReplyDerivation(context, admittedCommandId, error instanceof WorkspaceClientError ? error.message : 'The copy command could not be confirmed. Inspect its exact receipt; it will not be retried automatically.');
      }
    }
  }

  private holdManualReplyDerivation(context: NonNullable<CloudMailCoordinatorState['manualReplyDerivation']>, commandId: string | undefined, notice: string): void {
    this.heldCommandId = commandId;
    this.publish({ ...this.value, manualReplyDerivation: { ...context, ...(commandId ? { commandId } : {}) }, replyHeldCommand: commandId,
      replyHeldKind: 'mail.reply.derive', notice });
  }

  private async confirmManualReplySuccessor(context: NonNullable<CloudMailCoordinatorState['manualReplyDerivation']>, response: WorkspaceCommandResponse,
    owner: ReturnType<CloudMailCoordinator['owner']>, forceRefresh: boolean): Promise<boolean> {
    const receipt = response.receipt;
    if (response.status !== 'finished' || !receipt || receipt.kind !== 'mail.reply.derive' || receipt.commandId !== response.commandId ||
        receipt.parentProposalId !== context.parentProposalId || receipt.operation !== context.operation || !receipt.proposalId ||
        receipt.objectId !== receipt.proposalId || !Number.isSafeInteger(receipt.proposalRevision)) return false;
    const refreshed = forceRefresh ? await this.workspace.refresh() : await this.refreshAfterReceipt(owner);
    if (!refreshed || !this.isOwner(owner)) return false;
    const parent = refreshed.state.proposals.find((item) => item.id === context.parentProposalId);
    const child = refreshed.state.proposals.find((item) => item.id === receipt.proposalId);
    const account = refreshed.state.accounts.find((item) => item.id === context.accountId);
    const parentProvenance = parent?.provenance && (parent.provenance.version === 2 || parent.provenance.version === 3) ? parent.provenance : undefined;
    const childProvenance = child?.provenance;
    if (!parent || parent.revision !== context.parentRevision || parent.supersededByProposalId !== receipt.proposalId ||
        !parentProvenance || parentProvenance.sourceDigest !== context.sourceDigest || !child || child.revision !== receipt.proposalRevision || child.accountId !== context.accountId ||
        !parent.provenance || !childProvenance || childProvenance.version !== 3 || childProvenance.kind !== 'manual_mail_reply' ||
        childProvenance.operation !== context.operation || childProvenance.sourceDigest !== parentProvenance.sourceDigest ||
        childProvenance.source.accountId !== context.accountId || childProvenance.source.connectionGeneration !== context.connectionGeneration ||
        !sameMailAccountIdentity(account?.identity, childProvenance.source.identity) ||
        childProvenance.lineage.kind !== 'derived' || childProvenance.lineage.parentProposalId !== context.parentProposalId ||
        childProvenance.lineage.parentRevision !== context.parentRevision || !account?.connected || account.authStatus !== 'connected' ||
        account.connectionGeneration !== context.connectionGeneration) {
      this.holdManualReplyDerivation(context, response.commandId, 'The copy receipt is saved, but its current source and account binding could not be verified. Refresh before opening or continuing.');
      return false;
    }
    const review = await this.workspace.readProposalReview(child.id, refreshed.revision);
    if (!this.isOwner(owner)) return false;
    const latest = this.workspace.readSnapshot();
    if (!latest || latest.workspaceId !== owner.workspaceId || latest.privacyEpoch !== owner.privacyEpoch || latest.revision !== refreshed.revision ||
        review.revision !== refreshed.revision || review.proposal?.id !== child.id || review.proposal.revision !== child.revision ||
        review.proposal.editPolicy !== 'manual_reply_fields' || review.proposal.accountId !== context.accountId ||
        review.proposal.sourceDigest !== childProvenance.sourceDigest || review.proposal.email?.operation !== context.operation) {
      this.holdManualReplyDerivation(context, response.commandId, 'The copy was saved, but its current review could not be confirmed. Refresh before opening or continuing.');
      return false;
    }
    this.heldCommandId = undefined;
    this.publish({ ...this.value, manualReplyDerivation: undefined, replyHeldCommand: undefined, replyHeldKind: undefined,
      manualReplySuccessor: { parentProposalId: context.parentProposalId, parentRevision: context.parentRevision,
        childProposalId: child.id, confirmedChildRevision: child.revision },
      notice: 'Editable copy saved. Open it to review the recipients and message; no approval or send was performed.' });
    return true;
  }

  async openManualReplySuccessor(): Promise<void> {
    const successor = this.value.manualReplySuccessor;
    if (!successor) return;
    const owner = this.owner();
    const snapshot = this.workspace.readSnapshot();
    const parent = snapshot?.state.proposals.find((item) => item.id === successor.parentProposalId);
    const child = snapshot?.state.proposals.find((item) => item.id === successor.childProposalId);
    const parentProvenance = parent?.provenance && (parent.provenance.version === 2 || parent.provenance.version === 3) ? parent.provenance : undefined;
    const childAccount = child?.accountId ? snapshot?.state.accounts.find((item) => item.id === child.accountId) : undefined;
    if (!snapshot || !parent || parent.revision !== successor.parentRevision || parent.supersededByProposalId !== successor.childProposalId ||
        !parentProvenance || !child || child.revision < successor.confirmedChildRevision || child.accountId !== parent.accountId ||
        child.provenance?.version !== 3 || child.provenance.kind !== 'manual_mail_reply' || child.provenance.operation !== child.email?.operation ||
        (child.provenance.operation !== 'draft' && child.provenance.operation !== 'send') || child.provenance.lineage.kind !== 'derived' ||
        child.provenance.lineage.parentProposalId !== successor.parentProposalId || child.provenance.lineage.parentRevision !== successor.parentRevision ||
        child.provenance.sourceDigest !== parentProvenance.sourceDigest || child.provenance.source.accountId !== parent.accountId ||
        !childAccount?.connected || childAccount.authStatus !== 'connected' || childAccount.connectionGeneration !== child.provenance.source.connectionGeneration ||
        !sameMailAccountIdentity(childAccount.identity, child.provenance.source.identity)) {
      this.publish({ ...this.value, notice: 'The saved copy changed. Refresh the workspace before opening it.' });
      return;
    }
    const sequence = ++this.reviewSequence;
    try {
      const currentChildRevision = child.revision;
      const review = await this.workspace.readProposalReview(child.id, snapshot.revision);
      if (sequence !== this.reviewSequence || !this.isOwner(owner)) return;
      const latest = this.workspace.readSnapshot();
      const latestParent = latest?.state.proposals.find((item) => item.id === parent.id);
      const latestChild = latest?.state.proposals.find((item) => item.id === child.id);
      const latestAccount = latest?.state.accounts.find((item) => item.id === child.accountId);
      if (!latest || latest.revision !== snapshot.revision || review.revision !== snapshot.revision || review.proposal?.id !== child.id ||
          review.proposal.revision !== currentChildRevision || review.proposal.editPolicy !== 'manual_reply_fields' ||
          review.proposal.email?.operation !== latestChild?.email?.operation || review.proposal.sourceDigest !== child.provenance.sourceDigest ||
          latestParent?.revision !== successor.parentRevision || latestParent.supersededByProposalId !== child.id ||
          latestChild?.revision !== currentChildRevision || latestChild.accountId !== parent.accountId ||
          latestChild.provenance?.version !== 3 || latestChild.provenance.kind !== 'manual_mail_reply' ||
          latestChild.provenance.operation !== latestChild.email?.operation || latestChild.provenance.operation !== review.proposal.email?.operation ||
          latestChild.provenance.lineage.kind !== 'derived' || latestChild.provenance.lineage.parentProposalId !== parent.id ||
          latestChild.provenance.lineage.parentRevision !== successor.parentRevision || latestChild.provenance.sourceDigest !== parentProvenance.sourceDigest ||
          latestChild.provenance.source.accountId !== parent.accountId ||
          latestAccount?.connectionGeneration !== latestChild.provenance.source.connectionGeneration || !latestAccount.connected ||
          !sameMailAccountIdentity(latestAccount.identity, latestChild.provenance.source.identity)) {
        this.publish({ ...this.value, notice: 'The saved copy changed while opening it. Refresh and review the current workspace.' });
        return;
      }
      const drafts = { ...this.value.proposalDrafts };
      const existingDraft = drafts[child.id];
      if (!existingDraft || (!existingDraft.dirty && existingDraft.baseRevision !== review.proposal.revision)) drafts[child.id] = this.proposalDraftFrom(review.proposal);
      const hasDirtyRevisionConflict = Boolean(existingDraft?.dirty && existingDraft.baseRevision !== review.proposal.revision);
      this.publish({ ...this.value, proposalReviewId: child.id, proposalReview: review, proposalDrafts: drafts,
        notice: hasDirtyRevisionConflict ? 'The saved copy changed while you had unsaved edits. Your edits are preserved; review the current saved version before saving.' : undefined });
    } catch (error) {
      if (sequence === this.reviewSequence && this.isOwner(owner)) this.publish({ ...this.value,
        notice: error instanceof WorkspaceClientError ? error.message : 'Could not open the saved editable copy.' });
    }
  }

  selectAccount(accountId: string): void {
    const account = this.account(accountId);
    if (!account) { this.publish({ ...this.value, notice: 'Choose a currently connected account from the saved workspace.' }); return; }
    this.publish({ ...this.value, selectedAccountId: accountId, notice: undefined });
  }

  private async runCommand(command: WorkspaceCommand, expectedKind: WorkspaceCommand['kind'], expectedObjectId?: string,
    options: Readonly<{ strictAdmissionIdentity?: boolean; onAdmitted?: (commandId: string) => void }> = {}): Promise<WorkspaceCommandResponse | undefined> {
    const owner = this.owner();
    if (!this.mutationReady(owner)) { this.publish({ ...this.value, notice: 'Finish or inspect the pending workspace action, then refresh before making another change.' }); return undefined; }
    const token = this.tryLock();
    if (!token) return undefined;
    let admittedId: string | undefined;
    try {
      const response = await this.workspace.execute(command, (admission) => {
        if (this.isOwner(owner)) { admittedId = admission.commandId; options.onAdmitted?.(admission.commandId); }
      });
      if (!this.isOwner(owner)) return undefined;
      const receipt = response.receipt;
      if (response.status !== 'finished' || !receipt || receipt.kind !== expectedKind || receipt.commandId !== response.commandId ||
          (expectedObjectId !== undefined && receipt.objectId !== expectedObjectId)) {
        this.heldCommandId = options.strictAdmissionIdentity ? admittedId : admittedId ?? response.commandId;
        this.publish({ ...this.value, replyHeldCommand: this.heldCommandId, replyHeldKind: expectedKind, notice: 'The action is awaiting its exact receipt. Inspect it before continuing; it will not be sent again.' });
        return response;
      }
      return response;
    } catch (error) {
      if (!this.isOwner(owner)) return undefined;
      if (!(error instanceof WorkspaceCommandNotStartedError)) {
        this.heldCommandId = admittedId;
        this.publish({ ...this.value, replyHeldCommand: this.heldCommandId, replyHeldKind: expectedKind, notice: error instanceof WorkspaceClientError ? error.message : 'The action could not be confirmed. Inspect its exact receipt before continuing.' });
      } else this.publish({ ...this.value, notice: error.message });
      throw error;
    } finally { this.unlock(token); }
  }

  async runAccountAction(accountId: string, kind: 'accounts.refreshMail' | 'accounts.continueMailBackfill' | 'accounts.syncCalendars' | 'accounts.disconnect') {
    const account = this.account(accountId);
    const owner = this.owner();
    if (!account || !Number.isSafeInteger(account.connectionGeneration)) {
      this.publish({ ...this.value, notice: 'This account connection changed. Refresh the workspace before continuing.' });
      return;
    }
    const sync = this.workspace.readSnapshot()?.state.syncStates[accountId];
    const command: WorkspaceCommand = kind === 'accounts.syncCalendars'
      ? { kind, accountId, expectedConnectionGeneration: account.connectionGeneration!, ...(sync?.calendarsPartial ? { continue: true } : {}) }
      : { kind, accountId, expectedConnectionGeneration: account.connectionGeneration! };
    try {
      const response = await this.runCommand(command, kind, accountId);
      if (!response || !this.isOwner(owner)) return;
      this.publish({ ...this.value, notice: response.status === 'finished'
        ? 'The account action is confirmed. Refresh the workspace to review saved mail and calendar updates.'
        : 'The account action is awaiting its exact receipt.' });
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'The account action could not be confirmed.' });
    }
  }

  async openReply(messageId: string): Promise<void> {
    const owner = this.owner();
    const sequence = ++this.replySequence;
    this.publish({ ...this.value, replyBusy: 'opening', notice: undefined, replySource: undefined, replyText: undefined });
    try {
      const sourceRead = await this.workspace.readMailReplySource(messageId, owner.revision);
      if (sequence !== this.replySequence || !this.isOwner(owner)) return;
      const source = sourceRead.source;
      if (sourceRead.status !== 'current' || !source || !this.account(source.accountId, source.connectionGeneration)) {
        this.publish({ ...this.value, replyBusy: undefined, replySource: sourceRead, notice: sourceRead.status === 'stale'
          ? 'This saved message changed. Refresh and check its reply details again.'
          : 'Reply details are not current for a connected account.' });
        return;
      }
      const existing = this.value.replyDraft;
      const keepDraft = existing?.messageId === messageId && existing.accountId === source.accountId && existing.connectionGeneration === source.connectionGeneration;
      const changedSource = keepDraft && existing.sourceDigest !== source.sourceDigest;
      const mode = existing?.mode ?? 'reply';
      const defaults = sourceRead.defaults?.[mode];
      const draft: CloudMailDraft = keepDraft
        ? Object.freeze({ ...existing, composerRevision: changedSource ? existing.composerRevision + 1 : existing.composerRevision,
            ...(changedSource ? { useSavedText: false } : {}) })
        : Object.freeze({ messageId, accountId: source.accountId, connectionGeneration: source.connectionGeneration, sourceDigest: source.sourceDigest,
            mode, to: defaults?.to.join(', ') ?? '', cc: defaults?.cc.join(', ') ?? '', text: '', brief: '', composerRevision: 0, useSavedText: false });
      this.publish({ ...this.value, selectedAccountId: source.accountId, replyDraft: draft, replySource: sourceRead, replyBusy: 'opening',
        replyNeedsRebind: Boolean(changedSource),
        notice: changedSource ? 'The saved message changed. Your reply was kept; review the current recipients before continuing.' : undefined });
      // This is a saved-only cache read. It does not contact a mail provider.
      const textRead = await this.workspace.readMailReplyText(messageId, owner.revision, source);
      if (sequence !== this.replySequence || !this.isOwner(owner)) return;
      if (textRead.snapshot && textRead.snapshot.sourceDigest !== source.sourceDigest) throw new WorkspaceClientError('malformed', 'Saved message text did not match the checked source.');
      this.publish({ ...this.value, replyText: textRead, replyBusy: undefined });
    } catch (error) {
      if (sequence !== this.replySequence || !this.isOwner(owner)) return;
      this.publish({ ...this.value, replyBusy: undefined, notice: error instanceof WorkspaceClientError ? error.message : 'Could not open the saved reply details.' });
    }
  }

  updateReplyDraft(patch: Partial<Pick<CloudMailDraft, 'mode' | 'to' | 'cc' | 'text' | 'brief' | 'useSavedText'>>): void {
    const draft = this.value.replyDraft;
    if (!draft) return;
    this.publish({ ...this.value, replyDraft: Object.freeze({ ...draft, ...patch, composerRevision: draft.composerRevision + 1 }), notice: undefined });
  }

  updateReplyMode(mode: CloudMailDraft['mode']): void {
    const draft = this.value.replyDraft;
    const defaults = this.value.replySource?.defaults?.[mode];
    if (!draft || !defaults) return;
    this.updateReplyDraft({ mode, to: defaults.to.join(', '), cc: defaults.cc.join(', '), useSavedText: false });
  }

  confirmReplyRebind(): void {
    const draft = this.value.replyDraft;
    const source = this.value.replySource?.source;
    if (!draft || !source || !this.account(source.accountId, source.connectionGeneration)) return;
    const defaults = this.value.replySource?.defaults?.[draft.mode];
    this.publish({ ...this.value, replyDraft: Object.freeze({ ...draft, sourceDigest: source.sourceDigest,
      ...(defaults ? { to: defaults.to.join(', '), cc: defaults.cc.join(', ') } : {}), useSavedText: false, composerRevision: draft.composerRevision + 1 }),
      replyNeedsRebind: false, notice: 'The reply is now bound to the current saved message and recipients. Review it before saving.' });
  }

  closeReply(): void {
    this.replySequence += 1;
    this.publish({ ...this.value, replyBusy: undefined, replySource: undefined, replyText: undefined, replyNeedsRebind: false });
  }

  async loadMessageText(): Promise<void> {
    const draft = this.value.replyDraft;
    const source = this.value.replySource?.source;
    if (!draft || !source || !this.account(draft.accountId, draft.connectionGeneration)) return;
    const owner = this.owner();
    if (!this.mutationReady(owner)) { this.publish({ ...this.value, notice: 'Resolve any pending workspace action before requesting message text.' }); return; }
    const sequence = ++this.replySequence;
    this.publish({ ...this.value, replyBusy: 'loading_text', notice: undefined });
    try {
      const response = await this.runCommand({ kind: 'mail.source.loadText', messageId: draft.messageId, accountId: draft.accountId,
        expectedConnectionGeneration: draft.connectionGeneration, sourceDigest: draft.sourceDigest }, 'mail.source.loadText', draft.messageId);
      if (!response || !this.isOwner(owner) || sequence !== this.replySequence) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'mail.source.loadText' || response.receipt.sourceDigest !== draft.sourceDigest ||
          response.receipt.connectionGeneration !== draft.connectionGeneration || response.receipt.accountId !== draft.accountId) return;
      const latest = this.workspace.readSnapshot();
      if (!latest || latest.workspaceId !== owner.workspaceId || latest.privacyEpoch !== owner.privacyEpoch) return;
      const refreshed = await this.workspace.refresh();
      if (!refreshed || sequence !== this.replySequence || !this.isOwner(owner)) return;
      const text = await this.workspace.readMailReplyText(draft.messageId, refreshed.revision, source);
      if (sequence !== this.replySequence || !this.isOwner(owner)) return;
      this.publish({ ...this.value, replyText: text, replyBusy: undefined,
        notice: response.receipt.loadStatus === 'current' && text.snapshot ? 'Saved message text loaded for review.' : 'The saved message text is not available. You can still write a reply manually.' });
    } catch (error) {
      if (sequence === this.replySequence && this.isOwner(owner)) this.publish({ ...this.value, replyBusy: undefined,
        notice: error instanceof WorkspaceClientError ? error.message : 'Could not load saved message text.' });
    }
  }

  async saveReply(): Promise<void> {
    const draft = this.value.replyDraft;
    const source = this.value.replySource?.source;
    if (!draft || this.value.replyNeedsRebind || !source || source.sourceDigest !== draft.sourceDigest || !this.account(draft.accountId, draft.connectionGeneration) || !draft.text.trim()) return;
    const owner = this.owner();
    const to = draft.to.split(/[\n,;]/).map((part) => part.trim()).filter(Boolean);
    const cc = draft.cc.split(/[\n,;]/).map((part) => part.trim()).filter(Boolean);
    if (!to.length) { this.publish({ ...this.value, notice: 'Add at least one recipient before saving this reply.' }); return; }
    this.publish({ ...this.value, replyBusy: 'saving', notice: undefined });
    try {
      const response = await this.runCommand({ kind: 'mail.reply.create', messageId: draft.messageId, accountId: draft.accountId,
        expectedConnectionGeneration: draft.connectionGeneration, sourceDigest: draft.sourceDigest, mode: draft.mode, text: draft.text, to, cc }, 'mail.reply.create');
      if (!response || !this.isOwner(owner)) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'mail.reply.create' ||
          !response.receipt.proposalId || !Number.isSafeInteger(response.receipt.proposalRevision)) {
        this.publish({ ...this.value, replyBusy: undefined });
        return;
      }
      const proposalId = response.receipt.proposalId;
      this.closeReply();
      this.publish({ ...this.value, notice: 'Reply saved for separate review. It has not been sent.' });
      const refreshed = await this.refreshAfterReceipt(owner);
      if (!refreshed || !this.isOwner(owner)) {
        if (this.isOwner(owner)) this.publish({ ...this.value, notice: 'Reply saved for review. Refresh the workspace before opening its current details.' });
        return;
      }
      await this.openProposal(proposalId);
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, replyBusy: undefined, notice: error instanceof WorkspaceClientError ? error.message : 'Could not save this reply for review.' });
    }
  }

  private async refreshAfterReceipt(owner: ReturnType<CloudMailCoordinator['owner']>): Promise<WorkspaceSnapshotDTO | undefined> {
    if (!this.isOwner(owner)) return undefined;
    const existing = this.workspace.readSnapshot();
    // A command may already have returned its full snapshot. The store owns the latest copy.
    if (existing && !this.workspace.readOperation().refreshRequired) return existing;
    return this.workspace.refresh();
  }

  async editProposal(proposalId: string, accountId: string, connectionGeneration: number, edit: Extract<WorkspaceCommand, { kind: 'proposals.edit' }>['edit']): Promise<boolean> {
    const proposal = this.value.proposalReview?.proposal;
    const draft = this.getProposalDraft(proposalId);
    if (!proposal || proposal.id !== proposalId || !['draft', 'failed', 'approved'].includes(proposal.status) ||
        proposal.supersededByProposalId || proposal.editPolicy === 'read_only' || !draft?.dirty || draft.baseRevision !== proposal.revision ||
        proposal.accountId !== accountId || !this.account(accountId, connectionGeneration) || this.value.proposalSavingId) return false;
    if (proposal.editPolicy === 'manual_reply_fields' && (edit.kind !== 'email' || !proposal.email || edit.subject !== proposal.email.subject ||
        edit.bcc.length !== 0 || (edit.operation === 'send' && !this.account(accountId, connectionGeneration)?.capabilities?.includes('mail.send')) ||
        (edit.operation === 'draft' && !this.account(accountId, connectionGeneration)?.capabilities?.includes('mail.draft')))) return false;
    if (proposal.editPolicy === 'manual_reply_send_fields' && (edit.kind !== 'email' || !proposal.email || edit.operation !== 'send' ||
        edit.subject !== proposal.email.subject || edit.bcc.length !== 0 || proposal.email.attachments.length !== 0 ||
        !this.account(accountId, connectionGeneration)?.capabilities?.includes('mail.send'))) return false;
    if (proposal.editPolicy === 'source_reply_fields' && (edit.kind !== 'email' || edit.operation !== 'draft')) return false;
    const owner = this.owner();
    const generation = draft.generation;
    this.publish({ ...this.value, proposalSavingId: proposalId, proposalSavingGeneration: generation, notice: undefined });
    try {
      const response = await this.runCommand({ kind: 'proposals.edit', proposalId, expectedProposalRevision: proposal.revision, accountId,
        expectedConnectionGeneration: connectionGeneration, edit }, 'proposals.edit', proposalId);
      if (!response || !this.isOwner(owner)) return false;
      if (response.status !== 'finished' || response.receipt?.kind !== 'proposals.edit' || response.receipt.proposalId !== proposalId || response.receipt.proposalRevision <= proposal.revision) return false;
      const refreshed = await this.refreshAfterReceipt(owner);
      if (!refreshed || !this.isOwner(owner)) return false;
      const review = await this.workspace.readProposalReview(proposalId, refreshed.revision);
      if (!this.isOwner(owner) || review.proposal?.id !== proposalId || review.proposal.revision !== response.receipt.proposalRevision) return false;
      const currentDraft = this.getProposalDraft(proposalId);
      const savedDraft = this.proposalDraftFrom(review.proposal);
      const proposalDrafts = { ...this.value.proposalDrafts };
      if (currentDraft?.generation === generation) proposalDrafts[proposalId] = savedDraft;
      else if (currentDraft) proposalDrafts[proposalId] = Object.freeze({ ...currentDraft, baseRevision: review.proposal.revision, dirty: true });
      const shouldReplaceReview = this.value.proposalReviewId === proposalId;
      this.publish({ ...this.value, proposalDrafts, ...(shouldReplaceReview ? { proposalReview: review } : {}), notice: undefined });
      return true;
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'The action update could not be confirmed.' });
      return false;
    } finally {
      if (this.isOwner(owner) && this.value.proposalSavingId === proposalId && this.value.proposalSavingGeneration === generation) {
        this.publish({ ...this.value, proposalSavingId: undefined, proposalSavingGeneration: undefined });
      }
    }
  }

  async approveProposal(proposalId: string): Promise<void> {
    const proposal = this.value.proposalReview?.proposal;
    if (!proposal || proposal.id !== proposalId || proposal.supersededByProposalId || !['draft', 'failed'].includes(proposal.status) || !this.proposalMutationReady(proposal)) return;
    if (['manual_reply_fields', 'manual_reply_send_fields'].includes(proposal.editPolicy) && (!proposal.accountId || !proposal.email?.operation ||
        !this.account(proposal.accountId)?.capabilities?.includes(proposal.email.operation === 'send' ? 'mail.send' : 'mail.draft'))) return;
    const owner = this.owner();
    try {
      const response = await this.runCommand({ kind: 'proposals.approve', proposalId, expectedProposalRevision: proposal.revision }, 'proposals.approve', proposalId);
      if (!response || !this.isOwner(owner)) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'proposals.approve' || response.receipt.proposalId !== proposalId ||
          response.receipt.proposalRevision !== proposal.revision || response.receipt.proposalStatus !== 'approved') return;
      await this.refreshAfterReceipt(owner);
      if (this.isOwner(owner)) await this.openProposal(proposalId);
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Approval could not be confirmed.' });
    }
  }

  async executeProposal(proposalId: string): Promise<void> {
    const proposal = this.value.proposalReview?.proposal;
    if (!proposal || proposal.id !== proposalId || proposal.supersededByProposalId || proposal.status !== 'approved' || !this.proposalMutationReady(proposal)) return;
    if (['manual_reply_fields', 'manual_reply_send_fields'].includes(proposal.editPolicy) && (!proposal.accountId || !proposal.email?.operation ||
        !this.account(proposal.accountId)?.capabilities?.includes(proposal.email.operation === 'send' ? 'mail.send' : 'mail.draft'))) return;
    const owner = this.owner();
    try {
      const response = await this.runCommand({ kind: 'proposals.execute', proposalId, expectedProposalRevision: proposal.revision }, 'proposals.execute', proposalId);
      if (!response || !this.isOwner(owner)) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'proposals.execute' || response.receipt.proposalId !== proposalId ||
          !Number.isSafeInteger(response.receipt.proposalRevision)) return;
      const receipt = response.receipt;
      await this.refreshAfterReceipt(owner);
      if (!this.isOwner(owner)) return;
      const executionNotice = receipt.execution === 'unknown'
        ? 'The delivery outcome is unknown. Open the saved dispatch record and reconcile it explicitly; nothing will be sent again automatically.'
        : receipt.execution === 'accepted'
          ? 'The provider accepted the request. Delivery is not confirmed yet; review the saved dispatch record.'
          : receipt.execution === 'simulated'
            ? 'This action was simulated in preview mode. No message or calendar change was made.'
            : receipt.execution === 'executed'
              ? 'The action completed. Review the saved dispatch record.'
              : 'The action did not complete. Review the saved dispatch record and its saved outcome.';
      if (receipt.dispatchRecordId || receipt.execution !== 'executed') this.publish({ ...this.value, notice: executionNotice });
      await this.openProposal(proposalId);
      if (this.isOwner(owner) && (receipt.dispatchRecordId || receipt.execution !== 'executed')) this.publish({ ...this.value, notice: executionNotice });
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Execution could not be confirmed.' });
    }
  }

  async dismissProposal(proposalId: string): Promise<void> {
    const proposal = this.value.proposalReview?.proposal;
    if (!proposal || proposal.id !== proposalId || proposal.supersededByProposalId || !['draft', 'failed', 'approved'].includes(proposal.status) || !this.proposalMutationReady(proposal)) return;
    const owner = this.owner();
    try {
      const response = await this.runCommand({ kind: 'proposals.dismiss', proposalId, expectedProposalRevision: proposal.revision }, 'proposals.dismiss', proposalId);
      if (!response || !this.isOwner(owner)) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'proposals.dismiss' || response.receipt.proposalId !== proposalId ||
          response.receipt.proposalRevision !== proposal.revision || response.receipt.proposalStatus !== 'dismissed') return;
      await this.refreshAfterReceipt(owner);
      if (this.isOwner(owner)) await this.openProposal(proposalId);
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Dismissal could not be confirmed.' });
    }
  }

  async reconcileDispatch(recordId: string, input: Readonly<{ disposition: DispatchReconciliation; note: string; remoteId?: string }>): Promise<void> {
    const review = this.value.dispatchReview;
    const record = review?.record;
    if (!review || !record || record.id !== recordId || !review.recordVersion) return;
    const owner = this.owner();
    try {
      const response = await this.runCommand({ kind: 'dispatch.reconcile', recordId, expectedRecordVersion: review.recordVersion, ...input }, 'dispatch.reconcile', recordId);
      if (!response || !this.isOwner(owner)) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'dispatch.reconcile' || response.receipt.recordId !== recordId || response.receipt.recordVersion === review.recordVersion) return;
      await this.refreshAfterReceipt(owner);
      if (this.isOwner(owner)) await this.openDispatch(recordId);
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Reconciliation could not be confirmed.' });
    }
  }

  async submitReplyBatch(): Promise<void> {
    const draft = this.value.replyDraft;
    const source = this.value.replySource?.source;
    const text = this.value.replyText?.snapshot;
    if (!draft || this.value.replyNeedsRebind || !source || !text || text.sourceDigest !== draft.sourceDigest || !draft.useSavedText || !this.account(draft.accountId, draft.connectionGeneration)) return;
    const owner = this.owner();
    try {
      const response = await this.runCommand({ kind: 'mail.replyBatch.submit', messageId: draft.messageId, accountId: draft.accountId,
        expectedConnectionGeneration: draft.connectionGeneration, sourceDigest: draft.sourceDigest, textDigest: text.textDigest ?? '', mode: draft.mode,
        to: draft.to.split(/[\n,;]/).map((part) => part.trim()).filter(Boolean), cc: draft.cc.split(/[\n,;]/).map((part) => part.trim()).filter(Boolean),
        brief: draft.brief, composerRevision: draft.composerRevision }, 'mail.replyBatch.submit');
      if (!response || !this.isOwner(owner)) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'mail.replyBatch.submit' || !response.receipt.jobId) return;
      this.publish({ ...this.value, replyBusy: undefined, notice: 'Reply request queued. Check it only when you choose; its reported usage and cost may not be available yet.' });
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, replyBusy: undefined, notice: error instanceof WorkspaceClientError ? error.message : 'Reply request status could not be confirmed.' });
    }
  }

  async checkReplyBatch(jobId: string): Promise<void> {
    const draft = this.value.replyDraft;
    if (!draft || !this.account(draft.accountId, draft.connectionGeneration)) return;
    const owner = this.owner();
    try {
      const response = await this.runCommand({ kind: 'mail.replyBatch.check', jobId, accountId: draft.accountId, expectedConnectionGeneration: draft.connectionGeneration },
        'mail.replyBatch.check', jobId);
      if (response?.status === 'finished' && this.isOwner(owner)) this.publish({ ...this.value, notice: 'Reply request checked. Review its saved result before preparing a proposal.' });
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Reply request status could not be confirmed.' });
    }
  }

  async prepareReplyBatchReview(jobId: string, operation: 'draft' | 'send'): Promise<void> {
    const draft = this.value.replyDraft;
    if (!draft || !this.account(draft.accountId, draft.connectionGeneration)) return;
    const owner = this.owner();
    try {
      const response = await this.runCommand({ kind: 'mail.replyBatch.review', jobId, accountId: draft.accountId,
        expectedConnectionGeneration: draft.connectionGeneration, operation }, 'mail.replyBatch.review', jobId);
      if (!response || !this.isOwner(owner)) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'mail.replyBatch.review' || !response.receipt.planId) return;
      const refreshed = await this.refreshAfterReceipt(owner);
      if (!refreshed || !this.isOwner(owner)) return;
      await this.reviewBatchPlan({ planId: response.receipt.planId, jobId, accountId: draft.accountId, expectedConnectionGeneration: draft.connectionGeneration });
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Reply review could not be prepared.' });
    }
  }

  async activateReplyBatch(): Promise<void> {
    const plan = this.value.batchReview?.plan;
    const key = this.value.batchReviewKey;
    if (!plan || !key || plan.planId !== key.planId || plan.jobId !== key.jobId || plan.accountId !== key.accountId ||
        plan.connectionGeneration !== key.expectedConnectionGeneration) return;
    if (Date.parse(plan.expiresAt) <= Date.now()) {
      this.publish({ ...this.value, notice: 'This saved reply review has expired. Check and prepare a new review before continuing.' });
      return;
    }
    const owner = this.owner();
    try {
      const response = await this.runCommand({ kind: 'mail.replyBatch.activate', planId: plan.planId, jobId: plan.jobId, accountId: plan.accountId,
        expectedConnectionGeneration: plan.connectionGeneration }, 'mail.replyBatch.activate');
      if (!response || !this.isOwner(owner)) return;
      if (response.status !== 'finished' || response.receipt?.kind !== 'mail.replyBatch.activate' || response.receipt.jobId !== plan.jobId ||
          !response.receipt.proposalId || response.receipt.objectId !== response.receipt.proposalId) return;
      await this.refreshAfterReceipt(owner);
      if (this.isOwner(owner)) await this.openProposal(response.receipt.proposalId);
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'The reviewed reply could not be activated.' });
    }
  }

  async openProposal(proposalId: string): Promise<void> {
    const owner = this.owner();
    const sequence = ++this.reviewSequence;
    this.publish({ ...this.value, proposalReviewId: proposalId, proposalReview: undefined, notice: undefined });
    try {
      const review = await this.workspace.readProposalReview(proposalId, owner.revision);
      if (sequence !== this.reviewSequence || !this.isOwner(owner)) return;
      if (!review.proposal || review.proposal.id !== proposalId) {
        this.publish({ ...this.value, proposalReview: review, notice: 'This saved action is no longer available.' });
        return;
      }
      const drafts = { ...this.value.proposalDrafts };
      const existing = drafts[proposalId];
      if (!existing || review.proposal.supersededByProposalId || (!existing.dirty && existing.baseRevision !== review.proposal.revision)) drafts[proposalId] = this.proposalDraftFrom(review.proposal);
      this.publish({ ...this.value, proposalReview: review, proposalDrafts: drafts });
    } catch (error) {
      if (sequence === this.reviewSequence && this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Could not open saved action details.' });
    }
  }

  async openAcceptedDraftSuccessor(): Promise<void> {
    const successor = this.value.acceptedDraftSuccessor;
    if (!successor) return;
    const snapshot = this.workspace.readSnapshot();
    const parent = snapshot?.state.proposals.find((item) => item.id === successor.parentProposalId);
    const child = snapshot?.state.proposals.find((item) => item.id === successor.childProposalId);
    const account = snapshot?.state.accounts.find((item) => item.id === successor.accountId);
    const record = snapshot?.state.dispatchRecords.find((item) => item.id === successor.draftDispatchRecordId);
    if (!snapshot || !parent || parent.revision !== successor.parentRevision || parent.status !== 'accepted' ||
        parent.supersededByProposalId !== successor.childProposalId || parent.remoteOperation !== 'draft' ||
        !child || child.revision < successor.confirmedChildRevision || child.accountId !== successor.accountId || child.email?.operation !== 'send' ||
        !account?.connected || account.authStatus !== 'connected' ||
        account.connectionGeneration !== successor.connectionGeneration || account.provider !== successor.provider || !record ||
        record.proposalId !== parent.id || record.accountId !== successor.accountId || record.operation !== 'draft' || record.outcome !== 'accepted' ||
        record.remoteId !== parent.remoteId) {
      this.publish({ ...this.value, notice: 'The reviewed send copy changed. Refresh the workspace before opening it.' });
      return;
    }
    const owner = this.owner();
    const sequence = ++this.reviewSequence;
    try {
      const review = await this.workspace.readProposalReview(child.id, snapshot.revision);
      if (sequence !== this.reviewSequence || !this.isOwner(owner)) return;
      const latest = this.workspace.readSnapshot();
      const latestParent = latest?.state.proposals.find((item) => item.id === parent.id);
      const latestChild = latest?.state.proposals.find((item) => item.id === child.id);
      const reviewedChild = review.proposal;
      const acceptedDraftCopy = reviewedChild?.acceptedDraftCopy;
      const expectedEditPolicy = reviewedChild && ['draft', 'failed', 'approved'].includes(reviewedChild.status) ? 'manual_reply_send_fields' : 'read_only';
      if (!latest || latest.revision !== snapshot.revision || review.revision !== snapshot.revision || !reviewedChild || reviewedChild.id !== child.id ||
          reviewedChild.revision !== child.revision || reviewedChild.status !== child.status || reviewedChild.editPolicy !== expectedEditPolicy ||
          reviewedChild.email?.operation !== 'send' || reviewedChild.canDeriveManualReply || reviewedChild.sourceDigest !== successor.sourceDigest ||
          acceptedDraftCopy?.parentProposalId !== parent.id || acceptedDraftCopy.draftDispatchRecordId !== successor.draftDispatchRecordId ||
          acceptedDraftCopy.provider !== successor.provider || !latestParent || latestParent.revision !== successor.parentRevision ||
          latestParent.status !== 'accepted' || latestParent.supersededByProposalId !== child.id || !latestChild || latestChild.revision !== child.revision) {
        this.publish({ ...this.value, notice: 'The send copy changed while opening it. Refresh and review the current workspace.' });
        return;
      }
      const drafts = { ...this.value.proposalDrafts };
      const existingDraft = drafts[child.id];
      if (!existingDraft || (!existingDraft.dirty && existingDraft.baseRevision !== child.revision)) drafts[child.id] = this.proposalDraftFrom(review.proposal);
      const hasDirtyRevisionConflict = Boolean(existingDraft?.dirty && existingDraft.baseRevision !== child.revision);
      this.publish({ ...this.value, proposalReviewId: child.id, proposalReview: review, proposalDrafts: drafts,
        notice: hasDirtyRevisionConflict ? 'The saved send copy changed while you had unsaved edits. Your edits are preserved; review the current saved version before saving.' : undefined });
    } catch (error) {
      if (sequence === this.reviewSequence && this.isOwner(owner)) this.publish({ ...this.value,
        notice: error instanceof WorkspaceClientError ? error.message : 'Could not open the reviewed send copy.' });
    }
  }

  closeProposal(): void { this.reviewSequence += 1; this.publish({ ...this.value, proposalReviewId: undefined, proposalReview: undefined }); }

  async openDispatch(recordId: string): Promise<void> {
    const owner = this.owner();
    const sequence = ++this.dispatchSequence;
    this.publish({ ...this.value, dispatchReviewId: recordId, dispatchReview: undefined, notice: undefined });
    try {
      const review = await this.workspace.readDispatchReview(recordId, owner.revision);
      if (sequence !== this.dispatchSequence || !this.isOwner(owner)) return;
      if (!review.record || review.record.id !== recordId) {
        this.publish({ ...this.value, dispatchReview: review, notice: 'This saved dispatch record is no longer available.' });
        return;
      }
      this.publish({ ...this.value, dispatchReview: review });
    } catch (error) {
      if (sequence === this.dispatchSequence && this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Could not open the saved dispatch record.' });
    }
  }

  closeDispatch(): void { this.dispatchSequence += 1; this.publish({ ...this.value, dispatchReviewId: undefined, dispatchReview: undefined }); }

  async reviewBatchPlan(plan: ReplyBatchPlanRead): Promise<void> {
    const owner = this.owner();
    const sequence = ++this.batchSequence;
    this.publish({ ...this.value, batchReviewKey: plan, batchReview: undefined, notice: undefined });
    try {
      const review = await this.workspace.readReplyBatchReview(plan, owner.revision);
      if (sequence !== this.batchSequence || !this.isOwner(owner)) return;
      this.publish({ ...this.value, batchReview: review, notice: review.plan ? undefined : 'This saved reply review has expired or is no longer available.' });
    } catch (error) {
      if (sequence === this.batchSequence && this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Could not open the saved reply review.' });
    }
  }

  async inspectHeldCommand(): Promise<void> {
    const commandId = this.heldCommandId ?? this.workspace.readOperation().pendingCommandId;
    if (!commandId) return;
    const owner = this.owner();
    try {
      const response = await this.workspace.inspect(commandId);
      if (!this.isOwner(owner)) return;
      const derivation = this.value.manualReplyDerivation;
      const promotion = this.value.acceptedDraftPromotion;
      if (promotion && this.value.replyHeldKind === 'mail.reply.promoteDraft') {
        const exactPromotionReceipt = response.commandId === commandId && response.status === 'finished' && response.receipt?.commandId === commandId &&
          response.receipt.kind === 'mail.reply.promoteDraft' && response.receipt.parentProposalId === promotion.parentProposalId &&
          response.receipt.parentProposalRevision === promotion.parentRevision && response.receipt.draftDispatchRecordId === promotion.draftDispatchRecordId &&
          response.receipt.accountId === promotion.accountId && response.receipt.connectionGeneration === promotion.connectionGeneration &&
          response.receipt.operation === 'send';
        if (!exactPromotionReceipt) {
          this.publish({ ...this.value, notice: 'The exact promotion receipt is not confirmed yet. It remains inspect-only and will not be retried.' });
          return;
        }
        await this.confirmAcceptedDraftSuccessor(promotion, response, owner, true);
        return;
      }
      if (derivation && this.value.replyHeldKind === 'mail.reply.derive') {
        const exactDeriveReceipt = response.commandId === commandId && response.status === 'finished' && response.receipt?.commandId === commandId &&
          response.receipt.kind === 'mail.reply.derive' && response.receipt.parentProposalId === derivation.parentProposalId &&
          response.receipt.operation === derivation.operation;
        if (!exactDeriveReceipt) {
          this.publish({ ...this.value, notice: 'The exact copy command is not confirmed yet. It remains inspect-only and will not be retried.' });
          return;
        }
        await this.confirmManualReplySuccessor(derivation, response, owner, true);
        return;
      }
      const exactReceipt = response.commandId === commandId && response.status === 'finished' && response.receipt?.commandId === commandId &&
        response.receipt.kind === this.value.replyHeldKind;
      if (exactReceipt) {
        this.heldCommandId = undefined;
        this.publish({ ...this.value, replyHeldCommand: undefined, replyHeldKind: undefined,
          notice: 'The exact receipt is confirmed. Refresh the workspace to review the saved result.' });
      } else if (response.status === 'finished' && !response.snapshot) {
        this.publish({ ...this.value, notice: 'The exact receipt is confirmed. Refresh the workspace to load the saved result.' });
      } else this.publish({ ...this.value, notice: 'The exact command receipt was checked. Review the refreshed saved workspace before continuing.' });
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'The exact command receipt could not be checked.' });
    }
  }

  dispose(): void {
    this.active = false;
    this.generation += 1;
    this.replySequence += 1;
    this.reviewSequence += 1;
    this.dispatchSequence += 1;
    this.batchSequence += 1;
    this.operationLock = undefined;
    this.heldCommandId = undefined;
    this.value = Object.freeze({});
    this.listeners.clear();
  }
}
