import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import type { DispatchReconciliation } from '../dispatch';
import type { DispatchReviewReadDto, MailReplyBatchReviewReadDto, MailReplySourceReadDto, MailReplyTextReadDto, ProposalReviewReadDto } from './mailWorkflowDtos';
import type { ReplyBatchPlanRead } from './cloudMailClient';
import { WorkspaceCommandNotStartedError, WorkspaceClientError, type WorkspaceCommandAdmission } from './workspaceClient';

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
    return !operation.busy && !operation.pending && !operation.refreshRequired && !this.operationLock;
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
      subject: proposal.email?.subject ?? '', text: proposal.email?.text ?? '', eventTitle: proposal.event?.title ?? '',
      eventDescription: proposal.event?.description ?? '', eventStart: proposal.event?.start ?? '', eventEnd: proposal.event?.end ?? '',
      eventTimeZone: proposal.event?.timeZone ?? this.workspace.readSnapshot()?.state.settings.timezone ?? 'UTC',
      eventAttendees: proposal.event?.attendees.join(', ') ?? '', eventInvite: proposal.event?.invitePolicy ?? 'none', calendarId: proposal.calendarId ?? '' });
  }

  getProposalDraft(proposalId: string): CloudProposalDraft | undefined { return this.value.proposalDrafts?.[proposalId]; }

  updateProposalDraft(proposalId: string, patch: Partial<Omit<CloudProposalDraft, 'proposalId' | 'baseRevision' | 'generation' | 'dirty'>>): void {
    const proposal = this.value.proposalReview?.proposal;
    const draft = this.getProposalDraft(proposalId);
    if (!proposal || proposal.id !== proposalId || !draft || proposal.editPolicy === 'read_only') return;
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
    return Boolean(draft && !draft.dirty && draft.baseRevision === proposal.revision && !this.value.proposalSavingId);
  }

  selectAccount(accountId: string): void {
    const account = this.account(accountId);
    if (!account) { this.publish({ ...this.value, notice: 'Choose a currently connected account from the saved workspace.' }); return; }
    this.publish({ ...this.value, selectedAccountId: accountId, notice: undefined });
  }

  private async runCommand(command: WorkspaceCommand, expectedKind: WorkspaceCommand['kind'], expectedObjectId?: string): Promise<WorkspaceCommandResponse | undefined> {
    const owner = this.owner();
    if (!this.mutationReady(owner)) { this.publish({ ...this.value, notice: 'Finish or inspect the pending workspace action, then refresh before making another change.' }); return undefined; }
    const token = this.tryLock();
    if (!token) return undefined;
    let admittedId: string | undefined;
    try {
      const response = await this.workspace.execute(command, (admission) => {
        if (this.isOwner(owner)) admittedId = admission.commandId;
      });
      if (!this.isOwner(owner)) return undefined;
      const receipt = response.receipt;
      if (response.status !== 'finished' || !receipt || receipt.kind !== expectedKind || receipt.commandId !== response.commandId ||
          (expectedObjectId !== undefined && receipt.objectId !== expectedObjectId)) {
        this.heldCommandId = admittedId ?? response.commandId;
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
        proposal.editPolicy === 'read_only' || !draft?.dirty || draft.baseRevision !== proposal.revision ||
        proposal.accountId !== accountId || !this.account(accountId, connectionGeneration) || this.value.proposalSavingId) return false;
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
    if (!proposal || proposal.id !== proposalId || !['draft', 'failed'].includes(proposal.status) || !this.proposalMutationReady(proposal)) return;
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
    if (!proposal || proposal.id !== proposalId || proposal.status !== 'approved' || !this.proposalMutationReady(proposal)) return;
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
    if (!proposal || proposal.id !== proposalId || !['draft', 'failed', 'approved'].includes(proposal.status) || !this.proposalMutationReady(proposal)) return;
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
      if (!existing || (!existing.dirty && existing.baseRevision !== review.proposal.revision)) drafts[proposalId] = this.proposalDraftFrom(review.proposal);
      this.publish({ ...this.value, proposalReview: review, proposalDrafts: drafts });
    } catch (error) {
      if (sequence === this.reviewSequence && this.isOwner(owner)) this.publish({ ...this.value, notice: error instanceof WorkspaceClientError ? error.message : 'Could not open saved action details.' });
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
