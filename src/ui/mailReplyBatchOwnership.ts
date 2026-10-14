import type { MailReplyBatchReviewPlan } from '../core';

export type MailReplyBatchOwner = Readonly<{ messageId: string; generation: number }>;
export type MailReplyActionTicket = Readonly<{ id: number; owner: MailReplyBatchOwner }>;
export type MailReplyBatchKeyStatus = Readonly<{ generation: number; mode: string; provider: string; ready: boolean }>;

/** New Batch reviews must keep the user's explicit operation all the way to activation. */
export function mailReplyBatchPlanMatchesOperation(
  plan: Pick<MailReplyBatchReviewPlan, 'operation'>,
  expected: 'draft' | 'send',
): boolean {
  return plan.operation === expected;
}

/** Missing operation is accepted only for legacy, already-activated draft history. */
export function mailReplyBatchActivationMatchesOperation(
  proposalOperation: 'draft' | 'send' | undefined,
  jobOperation: 'draft' | 'send' | undefined,
  expected: 'draft' | 'send',
  legacyActivated: boolean,
  linkedToSameProposal: boolean,
): boolean {
  if (!linkedToSameProposal) return false;
  const proposalMatches = proposalOperation === expected || (legacyActivated && expected === 'draft' && proposalOperation === undefined);
  const jobMatches = jobOperation === expected || (legacyActivated && expected === 'draft' && jobOperation === undefined);
  return proposalMatches && jobMatches;
}

export type MailReplyBatchBlockState = Readonly<{
  startupReady: boolean;
  loading: boolean;
  demo: boolean;
  previewFailed: boolean;
  privacyReviewOpen: boolean;
  privacyOutcomeUnknown: boolean;
  busy: boolean;
  ownActionBusy: boolean;
  audioActive: boolean;
  pendingCaptureLoading: boolean;
  pendingCapturePending: boolean;
  foregroundResumeRefreshing: boolean;
  foregroundCatchupComplete: boolean;
  proactiveRecoverySheetOpen: boolean;
  proactiveRecoveryRequiresRefresh: boolean;
  mailAlertRefreshRequired: boolean;
  assistantChatRecovery: boolean;
  assistantBatchRecovery: boolean;
  proactiveMailAlertRecovery: boolean;
  backupRecovery: boolean;
  knowledgeRecovery: boolean;
  reminderRecovery: boolean;
  competingReviewOpen: boolean;
  reminderReviewOpen: boolean;
  noteDetailOpen: boolean;
  documentOpen: boolean;
  recordingAttachmentOpen: boolean;
  manualChatOpen: boolean;
  settingsOpen: boolean;
  mailAlertTapResolutionOpen: boolean;
  mailAlertTapPending: boolean;
  chatDeleteReviewOpen: boolean;
  chatInteractionLocked: boolean;
}>;

/** Mirrors the foreground, recovery, capture, and competing-overlay gate used by transcript transfer. */
export function mailReplyBatchIsBlocked(state: MailReplyBatchBlockState): boolean {
  return !state.startupReady || state.loading || state.demo || state.previewFailed || state.privacyReviewOpen || state.privacyOutcomeUnknown ||
    (state.busy && !state.ownActionBusy) || state.audioActive || state.pendingCaptureLoading || state.pendingCapturePending ||
    state.foregroundResumeRefreshing || !state.foregroundCatchupComplete || state.proactiveRecoverySheetOpen || state.proactiveRecoveryRequiresRefresh ||
    state.mailAlertRefreshRequired || state.assistantChatRecovery || state.assistantBatchRecovery || state.proactiveMailAlertRecovery ||
    state.backupRecovery || state.knowledgeRecovery || state.reminderRecovery || state.competingReviewOpen || state.reminderReviewOpen ||
    state.noteDetailOpen || state.documentOpen || state.recordingAttachmentOpen || state.manualChatOpen || state.settingsOpen ||
    state.mailAlertTapResolutionOpen || state.mailAlertTapPending || state.chatDeleteReviewOpen || state.chatInteractionLocked;
}

/** Keeps unrelated workspace gates active while allowing a mail-source read in its own exact review. */
export function mailReplyBatchReviewSourceIsBlocked(
  state: MailReplyBatchBlockState,
  ownsExactReview: boolean,
): boolean {
  return mailReplyBatchIsBlocked({ ...state, competingReviewOpen: state.competingReviewOpen && !ownsExactReview });
}

export function mailReplyBatchKeyIsReady(
  status: MailReplyBatchKeyStatus | null,
  expected: Readonly<{ generation: number; mode: string; provider: string; blocked: boolean }>,
): boolean {
  return Boolean(status?.ready && !expected.blocked && expected.mode === 'provider' && expected.provider === 'openrouter' &&
    status.generation === expected.generation && status.mode === expected.mode && status.provider === expected.provider);
}

export function rethrowMailReplyBatchError<TError>(
  error: TError,
  isPrivacyBootstrapError: (value: unknown) => boolean,
  onPrivacyInvalidated: () => void,
): never {
  if (isPrivacyBootstrapError(error)) onPrivacyInvalidated();
  throw error;
}

/** Synchronous owner and exact-plan gate for delayed mail Batch callbacks. */
export class MailReplyBatchOwnership {
  private owner: MailReplyBatchOwner | undefined;
  private plan: { value: MailReplyBatchReviewPlan; owner: MailReplyBatchOwner } | undefined;
  private generation = 0;
  private actionSequence = 0;
  private actionTicket: MailReplyActionTicket | undefined;

  publishOwner(messageId: string | null): MailReplyBatchOwner | undefined {
    const nextGeneration = ++this.generation;
    this.plan = undefined;
    this.actionTicket = undefined;
    this.owner = messageId ? Object.freeze({ messageId, generation: nextGeneration }) : undefined;
    return this.owner;
  }

  get currentGeneration(): number { return this.generation; }

  captureOwner(messageId: string): MailReplyBatchOwner | undefined {
    return this.owner?.messageId === messageId ? this.owner : undefined;
  }

  owns(owner: MailReplyBatchOwner): boolean {
    return this.owner?.messageId === owner.messageId && this.owner.generation === owner.generation;
  }

  beginAction(owner: MailReplyBatchOwner): MailReplyActionTicket | undefined {
    if (!this.owns(owner) || this.actionTicket) return undefined;
    const ticket = Object.freeze({ id: ++this.actionSequence, owner });
    this.actionTicket = ticket;
    return ticket;
  }

  actionIsCurrent(ticket: MailReplyActionTicket): boolean {
    return this.actionTicket === ticket && this.owns(ticket.owner);
  }

  finishAction(ticket: MailReplyActionTicket): boolean {
    if (this.actionTicket !== ticket) return false;
    this.actionTicket = undefined;
    return true;
  }

  currentAction(): MailReplyActionTicket | undefined { return this.actionTicket; }

  async runOwnedAction<TReady, TValue>(input: {
    owner: MailReplyBatchOwner;
    isCurrent?: () => boolean;
    readReadiness: () => Promise<TReady>;
    action: (readiness: TReady) => Promise<TValue>;
    cancelLateValue?: (value: TValue) => Promise<unknown> | unknown;
  }): Promise<{ kind: 'stale' } | { kind: 'complete'; readiness: TReady; value: TValue }> {
    if (!this.owns(input.owner) || input.isCurrent?.() === false) return { kind: 'stale' };
    const readiness = await input.readReadiness();
    if (!this.owns(input.owner) || input.isCurrent?.() === false) return { kind: 'stale' };
    const value = await input.action(readiness);
    if (!this.owns(input.owner) || input.isCurrent?.() === false) {
      if (input.cancelLateValue) await Promise.resolve(input.cancelLateValue(value)).catch(() => undefined);
      return { kind: 'stale' };
    }
    return { kind: 'complete', readiness, value };
  }

  async prepareOwnedReview(input: {
    owner: MailReplyBatchOwner;
    isCurrent?: () => boolean;
    prepare: () => Promise<MailReplyBatchReviewPlan>;
    cancelLatePlan: (plan: MailReplyBatchReviewPlan) => Promise<unknown> | unknown;
  }): Promise<{ kind: 'stale' } | { kind: 'prepared'; plan: MailReplyBatchReviewPlan }> {
    if (!this.owns(input.owner) || input.isCurrent?.() === false) return { kind: 'stale' };
    const plan = await input.prepare();
    if (!this.owns(input.owner) || input.isCurrent?.() === false) {
      await Promise.resolve(input.cancelLatePlan(plan)).catch(() => undefined);
      return { kind: 'stale' };
    }
    return { kind: 'prepared', plan };
  }

  publishPlan(plan: MailReplyBatchReviewPlan, owner: MailReplyBatchOwner): boolean {
    if (!this.owns(owner) || plan.messageId !== owner.messageId) return false;
    this.plan = { value: plan, owner };
    return true;
  }

  getPlan(expectedPlanId: string): MailReplyBatchReviewPlan | undefined {
    const live = this.plan;
    return live?.value.planId === expectedPlanId && this.owns(live.owner) ? live.value : undefined;
  }

  currentPlan(): MailReplyBatchReviewPlan | undefined {
    const live = this.plan;
    return live && this.owns(live.owner) ? live.value : undefined;
  }

  clearPlan(expectedPlanId: string): MailReplyBatchReviewPlan | undefined {
    const live = this.plan;
    if (!live || live.value.planId !== expectedPlanId || !this.owns(live.owner)) return undefined;
    this.plan = undefined;
    return live.value;
  }
}
