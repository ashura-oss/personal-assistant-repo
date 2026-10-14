import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { MailReplyBatchReviewPlan } from '../core';
import type { AssistantBatchJobDTO } from '../services/openRouterBatchJobs';
import { Button } from './primitives';
import { batchCheckLabel, batchJobTokenSummary, formatReportedBatchCost } from './assistantBatchJobPresentation';
import { C, s } from './theme';

type Owner = { messageId: string; generation: number };
const isExpired = (expiresAt: string) => Date.parse(expiresAt) <= Date.now();

type Props = {
  jobs: readonly AssistantBatchJobDTO[];
  messageId: string;
  ownerGeneration: number;
  composerRevision: number;
  blocked: boolean;
  busy: boolean;
  submitting: boolean;
  checkReady: boolean;
  onCheck: (jobId: string, owner: Owner) => Promise<unknown>;
  onReview: (jobId: string, owner: Owner, isComposerCurrent: () => boolean) => Promise<MailReplyBatchReviewPlan | undefined>;
  onActivate: (planId: string, jobId: string, owner: Owner, isComposerCurrent: () => boolean) => Promise<unknown>;
  onCancel: (planId: string, owner: Owner) => void;
  onDelete: (jobId: string, owner: Owner) => Promise<unknown>;
  registerReviewInvalidator?: (invalidate: () => void) => () => void;
};

export function MailReplyBatchSection({
  jobs, messageId, ownerGeneration, composerRevision, blocked, busy, submitting, checkReady,
  onCheck, onReview, onActivate, onCancel, onDelete, registerReviewInvalidator,
}: Props) {
  const [checkingId, setCheckingId] = useState<string>();
  const [reviewingId, setReviewingId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<string>();
  const [activating, setActivating] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [plan, setPlan] = useState<MailReplyBatchReviewPlan>();
  const [notice, setNotice] = useState('');
  const actionLock = useRef(false);
  const planRef = useRef<MailReplyBatchReviewPlan | undefined>(undefined);
  const planOwnerRef = useRef<Owner | undefined>(undefined);
  const planRevisionRef = useRef(-1);
  const revisionRef = useRef(composerRevision);
  const ownerRef = useRef<Owner>({ messageId, generation: ownerGeneration });
  const stillOwns = (owner: Owner) => ownerRef.current.messageId === owner.messageId && ownerRef.current.generation === owner.generation;
  const owner = { messageId, generation: ownerGeneration };
  useLayoutEffect(() => {
    ownerRef.current = { messageId, generation: ownerGeneration };
    revisionRef.current = composerRevision;
  }, [composerRevision, messageId, ownerGeneration]);
  const invalidateReview = useCallback(() => {
    const current = planRef.current;
    if (!current) return;
    planRef.current = undefined;
    const planOwner = planOwnerRef.current;
    planOwnerRef.current = undefined;
    setPlan(undefined);
    setNotice('The reply details changed. Prepare a fresh review before creating a draft.');
    onCancel(current.planId, planOwner ?? { messageId: current.messageId, generation: ownerGeneration });
  }, [onCancel, ownerGeneration]);
  useEffect(() => {
    const unregister = registerReviewInvalidator?.(invalidateReview);
    return () => { invalidateReview(); unregister?.(); };
  }, [registerReviewInvalidator, invalidateReview]);
  useEffect(() => {
    const current = planRef.current;
    if (current && current.messageId !== messageId) {
      planRef.current = undefined;
      const planOwner = planOwnerRef.current;
      planOwnerRef.current = undefined;
      setPlan(undefined);
      onCancel(current.planId, planOwner ?? { messageId: current.messageId, generation: ownerGeneration });
    }
  }, [messageId, onCancel, ownerGeneration]);
  useEffect(() => {
    if (plan && blocked) {
      invalidateReview();
      return;
    }
    if (plan) {
      const job = jobs.find((item) => item.kind === 'mail_reply' && item.id === plan.jobId && item.mailMessageId === messageId);
      if (!job || job.sourceRemoved || job.status !== 'completed' || !job.hasMailReplyResult || job.proposalId) {
        invalidateReview();
      }
    }
  }, [blocked, invalidateReview, jobs, messageId, plan]);
  useEffect(() => {
    if (!plan) return;
    const delay = Date.parse(plan.expiresAt) - Date.now();
    const timer = setTimeout(() => {
      if (planRef.current?.planId !== plan.planId) return;
      invalidateReview();
      setNotice('This review expired. Check the message and prepare a fresh review.');
    }, Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [invalidateReview, plan]);

  const messageJobs = jobs.filter((job) => job.kind === 'mail_reply' && job.mailMessageId === messageId)
    .slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const check = async (jobId: string) => {
    if (actionLock.current || blocked || busy) return;
    actionLock.current = true;
    setActionPending(true);
    setCheckingId(jobId);
    setNotice('');
    try { await onCheck(jobId, owner); }
    catch { if (stillOwns(owner)) setNotice('Request status is uncertain. Check again when you are ready; this never submits another request.'); }
    finally { if (stillOwns(owner)) setCheckingId(undefined); actionLock.current = false; setActionPending(false); }
  };

  const review = async (jobId: string) => {
    if (actionLock.current || blocked || busy) return;
    actionLock.current = true;
    setActionPending(true);
    setReviewingId(jobId);
    setNotice('');
    const revision = revisionRef.current;
    const isComposerCurrent = () => stillOwns(owner) && revisionRef.current === revision;
    try {
      const next = await onReview(jobId, owner, isComposerCurrent);
      if (!next) return;
      const expiry = Date.parse(next.expiresAt);
      if (!isComposerCurrent() || next.jobId !== jobId || next.messageId !== owner.messageId || !Number.isFinite(expiry) || isExpired(next.expiresAt)) {
        onCancel(next.planId, owner);
        if (stillOwns(owner)) setNotice('The source or review changed. Check the message and prepare a fresh review.');
        return;
      }
      planRef.current = next;
      planOwnerRef.current = owner;
      planRevisionRef.current = revision;
      setPlan(next);
    } catch {
      if (stillOwns(owner)) setNotice('The completed reply could not be reviewed. Check the saved message, then try again.');
    } finally { if (stillOwns(owner)) setReviewingId(undefined); actionLock.current = false; setActionPending(false); }
  };

  const cancelReview = () => {
    const current = planRef.current;
    if (!current) return;
    planRef.current = undefined;
    const planOwner = planOwnerRef.current;
    planOwnerRef.current = undefined;
    setPlan(undefined);
    setNotice('Review cancelled.');
    onCancel(current.planId, planOwner ?? { messageId: current.messageId, generation: owner.generation });
  };

  const activate = async () => {
    const captured = planRef.current;
    if (!captured || actionLock.current || blocked || busy) return;
    const capturedOwner = planOwnerRef.current ?? { messageId: captured.messageId, generation: owner.generation };
    if (isExpired(captured.expiresAt)) { cancelReview(); setNotice('This review expired. Check the message and prepare a fresh review.'); return; }
    const revision = planRevisionRef.current;
    const isComposerCurrent = () => stillOwns(capturedOwner) && revisionRef.current === revision;
    if (!isComposerCurrent()) { invalidateReview(); return; }
    actionLock.current = true;
    setActionPending(true);
    setActivating(true);
    planRef.current = undefined;
    planOwnerRef.current = undefined;
    setPlan(undefined);
    setNotice('');
    try {
      await onActivate(captured.planId, captured.jobId, capturedOwner, isComposerCurrent);
    } catch {
      if (stillOwns(capturedOwner)) setNotice('Draft creation could not be confirmed. Check saved request status before taking another action.');
    } finally { if (stillOwns(capturedOwner)) setActivating(false); actionLock.current = false; setActionPending(false); }
  };

  const remove = async (jobId: string) => {
    if (actionLock.current || blocked || busy) return;
    const deletedJob = messageJobs.find((item) => item.id === jobId);
    actionLock.current = true;
    setActionPending(true);
    setDeletingId(jobId);
    setNotice('');
    try {
      const outcome = await onDelete(jobId, owner);
      if (stillOwns(owner) && outcome !== undefined) {
        setDeleteTarget(undefined);
        setNotice(`Saved request context and Batch result removed. Its accounting receipt remains in request history.${deletedJob?.proposalId ? ' Any saved draft remains as an invalidated copy.' : ''}`);
      }
    }
    catch { if (stillOwns(owner)) setNotice('The content removal outcome is uncertain. Check the request receipt before taking another action.'); }
    finally { if (stillOwns(owner)) setDeletingId(undefined); actionLock.current = false; setActionPending(false); }
  };

  return (
    <View style={styles.section}>
      <Text style={s.sectionTitle}>OpenRouter Batch requests for this message</Text>
      <Text style={styles.copy}>Replies may be delayed. Checks happen only when you ask. Nothing checks, retries, or resubmits in the background.</Text>
      {/* eslint-disable-next-line react-hooks/refs -- This callback only creates UI handlers; the captured refs are read when a user taps them. */}
      {messageJobs.length ? messageJobs.map((job) => {
        const cost = job.costStatus === 'reported' ? formatReportedBatchCost(job.providerReportedCostUsd) : undefined;
        const tokens = batchJobTokenSummary(job);
        return (
          <View key={job.id} style={styles.job}>
            <Text style={styles.status}>{statusLabel(job.status)}</Text>
            <Text style={styles.meta}>Added {dateLabel(job.createdAt)} · {job.model} · {job.effort} reasoning</Text>
            {job.status === 'submission_unknown' ? <Text style={styles.warning}>The request may have been charged. Checking never submits it again.</Text> : null}
            {job.status === 'completed' ? <Text style={styles.copy}>{job.proposalId ? 'A draft for review was created from this reply.' : job.hasMailReplyResult ? 'A completed reply is saved on this device. Review its current source before creating a draft.' : 'The completed reply is unavailable for review.'}</Text> : null}
            {job.sourceRemoved ? <Text style={styles.copy}>Request content was removed. This receipt remains for history.</Text> : null}
            {cost !== undefined ? <Text style={styles.meta}>{job.billingScope === 'byok_fee_only' ? 'OpenRouter-reported BYOK fee' : 'OpenRouter-reported cost'} · {cost}</Text> : job.costStatus === 'waiting' ? <Text style={styles.meta}>Provider-reported usage is not available yet.</Text> : job.costStatus === 'unavailable' ? <Text style={styles.meta}>The provider did not report a cost for this request.</Text> : null}
            {tokens ? <Text style={styles.meta}>Provider-reported tokens · {tokens}</Text> : null}
            {job.canCheck ? <Button label={checkingId === job.id ? 'Checking request…' : batchCheckLabel(job)} tone="quiet" disabled={blocked || busy || !checkReady || actionPending} onPress={() => void check(job.id)} /> : null}
            {job.canReviewMailReply ? <Button label={reviewingId === job.id ? 'Reviewing reply…' : 'Review completed reply'} tone="quiet" disabled={blocked || busy || actionPending} onPress={() => void review(job.id)} /> : null}
            {!job.sourceRemoved ? <Button label={deletingId === job.id ? 'Removing request content…' : 'Remove request content'} tone="quiet" disabled={blocked || busy || actionPending} onPress={() => setDeleteTarget(job.id)} /> : null}
            {deleteTarget === job.id ? (
              <View style={styles.review}>
                <Text style={styles.copy}>Remove the saved request and reply content for this job? A small accounting receipt remains.{job.proposalId ? ' A draft created from this reply will also be invalidated.' : ''} If the outcome is uncertain, check the receipt before taking another action.</Text>
                <Button label={deletingId === job.id ? 'Removing content…' : 'Confirm removal'} disabled={blocked || busy || actionLock.current} onPress={() => void remove(job.id)} />
                <Button label="Keep request" tone="quiet" disabled={deletingId === job.id} onPress={() => setDeleteTarget(undefined)} />
              </View>
            ) : null}
          </View>
        );
      }) : <Text style={styles.copy}>No Batch requests are saved for this message.</Text>}
      {submitting ? <Text style={styles.meta}>Submitting this paid request…</Text> : null}
      {notice ? <Text accessibilityRole="alert" style={styles.warning}>{notice}</Text> : null}
      {plan ? (
        <View style={styles.review}>
          <Text style={s.sectionTitle}>Review completed reply</Text>
          <Text style={styles.meta}>To · {plan.to.join(', ') || 'None'}</Text>
          {plan.cc.length ? <Text style={styles.meta}>Cc · {plan.cc.join(', ')}</Text> : null}
          <Text style={styles.meta}>Subject · {plan.subject}</Text>
          <Text selectable style={styles.result}>{plan.text}</Text>
          <Text style={styles.copy}>This reply is read-only. Creating a draft is separate from approving or sending it.</Text>
          <Button label={activating ? 'Creating draft…' : 'Create draft'} disabled={blocked || busy || activating} onPress={() => void activate()} />
          <Button label="Cancel review" tone="quiet" disabled={activating} onPress={cancelReview} />
        </View>
      ) : null}
    </View>
  );
}

function statusLabel(status: AssistantBatchJobDTO['status']) {
  if (status === 'queued' || status === 'processing') return 'Waiting for provider reply';
  if (status === 'submission_unknown') return 'Submission status uncertain';
  if (status === 'source_removed') return 'Request content removed';
  if (status === 'result_stale') return 'Reply is stale';
  if (status === 'result_invalid') return 'Reply could not be validated';
  if (status === 'result_not_retained') return 'Reply could not be saved';
  if (status === 'completed') return 'Request completed';
  if (status === 'failed' || status === 'expired' || status === 'cancelled') return `Request ${status}`;
  return 'Request status';
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable';
}

const styles = {
  section: { gap: 10, padding: 14, borderWidth: 1, borderColor: C.border, borderRadius: 16, backgroundColor: C.card },
  job: { gap: 7, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  review: { gap: 9, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border },
  status: { color: C.text, fontSize: 13, fontWeight: '600' as const },
  copy: { color: C.muted, fontSize: 11, lineHeight: 17 },
  meta: { color: C.sage, fontSize: 11, lineHeight: 16 },
  warning: { color: C.red, fontSize: 12, lineHeight: 18 },
  result: { color: C.text, fontSize: 13, lineHeight: 20, padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: 12 },
};
