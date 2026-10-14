import { describe, expect, it, vi } from 'vitest';
import type { MailReplyBatchReviewPlan } from '../src/core';
import { MailReplyBatchOwnership, mailReplyBatchIsBlocked, mailReplyBatchReviewSourceIsBlocked, mailReplyBatchKeyIsReady, rethrowMailReplyBatchError, type MailReplyBatchBlockState } from '../src/ui/mailReplyBatchOwnership';

const reviewPlan = (planId: string, messageId: string): MailReplyBatchReviewPlan => ({
  planId, jobId: `job-${planId}`, messageId, mode: 'reply', subject: 'Subject',
  to: ['person@example.com'], cc: [], text: 'Read-only saved reply.', expiresAt: '2026-10-14T12:05:00.000Z',
});

describe('mail reply Batch ownership used by App', () => {
  it('applies the production foreground, recovery, capture, and overlay hard block while allowing its own busy action', () => {
    const ready: MailReplyBatchBlockState = {
      startupReady: true, loading: false, demo: false, previewFailed: false, privacyReviewOpen: false, privacyOutcomeUnknown: false,
      busy: false, ownActionBusy: false, audioActive: false, pendingCaptureLoading: false, pendingCapturePending: false,
      foregroundResumeRefreshing: false, foregroundCatchupComplete: true, proactiveRecoverySheetOpen: false,
      proactiveRecoveryRequiresRefresh: false, mailAlertRefreshRequired: false, assistantChatRecovery: false,
      assistantBatchRecovery: false, proactiveMailAlertRecovery: false, backupRecovery: false, knowledgeRecovery: false,
      reminderRecovery: false, competingReviewOpen: false, reminderReviewOpen: false, noteDetailOpen: false,
      documentOpen: false, recordingAttachmentOpen: false, manualChatOpen: false, settingsOpen: false,
      mailAlertTapResolutionOpen: false, mailAlertTapPending: false, chatDeleteReviewOpen: false, chatInteractionLocked: false,
    };
    expect(mailReplyBatchIsBlocked(ready)).toBe(false);
    expect(mailReplyBatchIsBlocked({ ...ready, busy: true })).toBe(true);
    expect(mailReplyBatchIsBlocked({ ...ready, busy: true, ownActionBusy: true })).toBe(false);
    expect(mailReplyBatchIsBlocked({ ...ready, audioActive: true })).toBe(true);
    expect(mailReplyBatchIsBlocked({ ...ready, pendingCapturePending: true })).toBe(true);
    expect(mailReplyBatchIsBlocked({ ...ready, foregroundCatchupComplete: false })).toBe(true);
    expect(mailReplyBatchIsBlocked({ ...ready, assistantChatRecovery: true })).toBe(true);
    expect(mailReplyBatchIsBlocked({ ...ready, competingReviewOpen: true })).toBe(true);
    expect(mailReplyBatchIsBlocked({ ...ready, settingsOpen: true })).toBe(true);
    expect(mailReplyBatchReviewSourceIsBlocked({ ...ready, competingReviewOpen: true }, true)).toBe(false);
    expect(mailReplyBatchReviewSourceIsBlocked({ ...ready, competingReviewOpen: true, settingsOpen: true }, true)).toBe(true);
    expect(mailReplyBatchReviewSourceIsBlocked({ ...ready, competingReviewOpen: true }, false)).toBe(true);
  });

  it('requires a ready credential result matching the current provider and owner', () => {
    const expected = { generation: 8, mode: 'provider', provider: 'openrouter', blocked: false };
    expect(mailReplyBatchKeyIsReady({ ...expected, ready: true }, expected)).toBe(true);
    expect(mailReplyBatchKeyIsReady({ ...expected, ready: false }, expected)).toBe(false);
    expect(mailReplyBatchKeyIsReady({ ...expected, generation: 7, ready: true }, expected)).toBe(false);
    expect(mailReplyBatchKeyIsReady({ ...expected, ready: true }, { ...expected, blocked: true })).toBe(false);
  });

  it('invalidates privacy state and preserves the same rejected controller error for the workspace', () => {
    const error = Object.assign(new Error('Workspace epoch changed.'), { code: 'stale_epoch' });
    const onPrivacyInvalidated = vi.fn();
    const isPrivacyBootstrapError = (value: unknown) => Boolean(value && typeof value === 'object' &&
      ['stale_epoch', 'cleanup_in_progress', 'unsupported_runtime', 'control_unavailable'].includes(String((value as { code?: unknown }).code)));
    try {
      rethrowMailReplyBatchError(error, isPrivacyBootstrapError, onPrivacyInvalidated);
      throw new Error('Expected the rejected controller error to propagate.');
    } catch (cause) {
      expect(cause).toBe(error);
    }
    expect(onPrivacyInvalidated).toHaveBeenCalledOnce();
  });

  it('skips paid submission if the owner closes while local credential readiness is pending', async () => {
    const ownership = new MailReplyBatchOwnership();
    const owner = ownership.publishOwner('message-a')!;
    let resolveReadiness!: (value: boolean) => void;
    const readiness = new Promise<boolean>((resolve) => { resolveReadiness = resolve; });
    const submit = vi.fn(async () => 'accepted');
    const action = ownership.runOwnedAction({ owner, readReadiness: () => readiness, action: submit });

    ownership.publishOwner(null);
    resolveReadiness(true);
    await expect(action).resolves.toEqual({ kind: 'stale' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('skips paid submission if the composer revision changes while credentials are pending', async () => {
    const ownership = new MailReplyBatchOwnership();
    const owner = ownership.publishOwner('message-a')!;
    let resolveReadiness!: (value: boolean) => void;
    const readiness = new Promise<boolean>((resolve) => { resolveReadiness = resolve; });
    let revision = 1;
    const submit = vi.fn(async () => 'accepted');
    const action = ownership.runOwnedAction({
      owner, isCurrent: () => revision === 1,
      readReadiness: () => readiness,
      action: submit,
    });

    revision = 2;
    resolveReadiness(true);
    await expect(action).resolves.toEqual({ kind: 'stale' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('accepts the child callback owner value while rejecting a captured older generation', async () => {
    const ownership = new MailReplyBatchOwnership();
    const current = ownership.publishOwner('message-a')!;
    const submit = vi.fn(async () => 'accepted');
    const currentResult = await ownership.runOwnedAction({
      owner: { messageId: current.messageId, generation: current.generation },
      readReadiness: async () => true,
      action: submit,
    });
    expect(currentResult.kind).toBe('complete');
    expect(submit).toHaveBeenCalledTimes(1);

    ownership.publishOwner(null);
    const reopened = ownership.publishOwner('message-a')!;
    const staleSubmit = vi.fn(async () => 'accepted');
    await expect(ownership.runOwnedAction({
      owner: { messageId: current.messageId, generation: current.generation },
      readReadiness: async () => true,
      action: staleSubmit,
    })).resolves.toEqual({ kind: 'stale' });
    expect(ownership.owns(reopened)).toBe(true);
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it('cancels the exact review plan that returns after its message owner changes', async () => {
    const ownership = new MailReplyBatchOwnership();
    const owner = ownership.publishOwner('message-a')!;
    let resolveReview!: (value: MailReplyBatchReviewPlan) => void;
    const pending = new Promise<MailReplyBatchReviewPlan>((resolve) => { resolveReview = resolve; });
    const cancel = vi.fn(async (_planId: string) => undefined);
    const review = ownership.prepareOwnedReview({
      owner, prepare: () => pending, cancelLatePlan: (plan) => cancel(plan.planId),
    });

    ownership.publishOwner('message-b');
    resolveReview(reviewPlan('late-review', 'message-a'));
    await expect(review).resolves.toEqual({ kind: 'stale' });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('late-review');
    expect(ownership.getPlan('late-review')).toBeUndefined();
  });

  it('keeps old review callbacks from operating on a newer plan', () => {
    const ownership = new MailReplyBatchOwnership();
    const ownerA = ownership.publishOwner('message-a')!;
    const oldPlan = reviewPlan('old-plan', 'message-a');
    expect(ownership.publishPlan(oldPlan, ownerA)).toBe(true);

    const ownerB = ownership.publishOwner('message-b')!;
    const newPlan = reviewPlan('new-plan', 'message-b');
    expect(ownership.publishPlan(newPlan, ownerB)).toBe(true);

    expect(ownership.getPlan(oldPlan.planId)).toBeUndefined();
    expect(ownership.clearPlan(oldPlan.planId)).toBeUndefined();
    expect(ownership.getPlan(newPlan.planId)).toBe(newPlan);
    expect(ownership.clearPlan(newPlan.planId)).toBe(newPlan);
    expect(ownership.getPlan(newPlan.planId)).toBeUndefined();
  });

  it('admits one synchronous action ticket and prevents late release from unlocking a newer owner action', () => {
    const ownership = new MailReplyBatchOwnership();
    const ownerA = ownership.publishOwner('message-a')!;
    const first = ownership.beginAction(ownerA)!;
    expect(ownership.beginAction(ownerA)).toBeUndefined();
    expect(ownership.actionIsCurrent(first)).toBe(true);

    const ownerB = ownership.publishOwner('message-b')!;
    const second = ownership.beginAction(ownerB)!;
    expect(ownership.finishAction(first)).toBe(false);
    expect(ownership.actionIsCurrent(second)).toBe(true);
    expect(ownership.beginAction(ownerB)).toBeUndefined();
    expect(ownership.finishAction(second)).toBe(true);
    expect(ownership.beginAction(ownerB)).toBeDefined();
  });
});
