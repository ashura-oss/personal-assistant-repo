import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import type { OpenRouterChatRefinementEffort } from '../services/openRouter';
import { Button } from './primitives';
import { formatReportedBatchCost } from './assistantBatchJobPresentation';
import { C, s } from './theme';
import type { WorkspaceAssistantBatchJobDisplay, WorkspaceMoreComputePlanDisplay } from './workspaceChatDisplayTypes';

const isExpiredAtNow = (value: string) => Date.parse(value) <= Date.now();

type Effort = Extract<OpenRouterChatRefinementEffort, 'medium' | 'high' | 'max'>;

export type MoreComputeReviewActions = {
  ownerKey: string;
  blocked: boolean;
  prepareReady?: boolean;
  submitReady: boolean;
  onPrepare: (jobId: string, effort: Effort, ownerKey: string, isOwnerCurrent: () => boolean) => Promise<WorkspaceMoreComputePlanDisplay | undefined>;
  onSubmit: (planId: string, jobId: string, ownerKey: string, isOwnerCurrent: () => boolean) => Promise<WorkspaceAssistantBatchJobDisplay | undefined>;
  onCancel: (planId: string, ownerKey: string) => void;
  onSubmitted?: (result: WorkspaceAssistantBatchJobDisplay, ownerKey: string) => void;
};

type Props = MoreComputeReviewActions & { job: WorkspaceAssistantBatchJobDisplay };

function validEfforts(job: WorkspaceAssistantBatchJobDisplay): Effort[] {
  const order: Effort[] = ['medium', 'high', 'max'];
  const current = order.indexOf(job.effort as Effort);
  return (job.moreComputeEfforts ?? []).filter((value): value is Effort => {
    const index = order.indexOf(value as Effort);
    return index >= 0 && index > current;
  }).sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

function readableEffort(value: string): string {
  return value === 'max' ? 'Max' : value.charAt(0).toUpperCase() + value.slice(1);
}

export function MoreComputeReview({ job, ownerKey, blocked, prepareReady = true, submitReady, onPrepare, onSubmit, onCancel, onSubmitted }: Props) {
  const [plan, setPlan] = useState<WorkspaceMoreComputePlanDisplay>();
  const [effort, setEffort] = useState<Effort>();
  const [pending, setPending] = useState<'prepare' | 'submit' | undefined>();
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const alive = useRef(true);
  const planRef = useRef<WorkspaceMoreComputePlanDisplay | undefined>(undefined);
  const ownerRef = useRef(ownerKey);
  const observedRef = useRef({ ownerKey, jobId: job.id });
  const lock = useRef(false);
  const cleanupOwnerKey = ownerKey;

  const cancelExact = React.useCallback((captured: WorkspaceMoreComputePlanDisplay, capturedOwner: string) => {
    onCancel(captured.planId, capturedOwner);
  }, [onCancel]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current += 1;
      const current = planRef.current;
      planRef.current = undefined;
      if (current) cancelExact(current, cleanupOwnerKey);
    };
  }, [cancelExact, cleanupOwnerKey]);

  useEffect(() => {
    const current = planRef.current;
    if (!current) return;
    const timer = setTimeout(() => {
      if (planRef.current?.planId !== current.planId) return;
      planRef.current = undefined;
      setPlan(undefined);
      setNotice('This review expired. Prepare a fresh review.');
      cancelExact(current, ownerRef.current);
    }, Math.max(0, Date.parse(current.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [cancelExact, plan]);

  const prepare = async (nextEffort: Effort) => {
    if (blocked || !prepareReady || lock.current || !job.canRecoverMoreCompute || !validEfforts(job).includes(nextEffort)) return;
    lock.current = true;
    const ticket = ++sequence.current;
    const capturedOwner = ownerRef.current;
    setEffort(nextEffort);
    setPending('prepare');
    setNotice('');
    try {
      const isOwnerCurrent = () => alive.current && ownerRef.current === capturedOwner && observedRef.current.jobId === job.id && !blocked;
      const next = await onPrepare(job.id, nextEffort, capturedOwner, isOwnerCurrent);
      if (!next) return;
      const isCurrent = alive.current && sequence.current === ticket && ownerRef.current === capturedOwner && !blocked;
      if (!isCurrent || next.jobId !== job.id || next.requestedEffort !== nextEffort || !next.planId || isExpiredAtNow(next.expiresAt)) {
        cancelExact(next, capturedOwner);
        if (isCurrent) setNotice('The request changed. Prepare a fresh review.');
        return;
      }
      planRef.current = next;
      setPlan(next);
    } catch {
      if (alive.current && sequence.current === ticket && ownerRef.current === capturedOwner) setNotice('The incomplete request could not be reviewed. Check its status and try again.');
    } finally {
      if (alive.current && sequence.current === ticket && ownerRef.current === capturedOwner) {
        lock.current = false;
        setPending(undefined);
      }
    }
  };

  const submit = async () => {
    const captured = planRef.current;
    if (!captured || blocked || !submitReady || lock.current || ownerRef.current !== ownerKey || captured.jobId !== job.id) return;
    if (isExpiredAtNow(captured.expiresAt)) {
      planRef.current = undefined;
      setPlan(undefined);
      cancelExact(captured, ownerRef.current);
      setNotice('This review expired. Prepare a fresh review.');
      return;
    }
    lock.current = true;
    const ticket = ++sequence.current;
    const capturedOwner = ownerRef.current;
    planRef.current = undefined;
    setPlan(undefined);
    setPending('submit');
    setNotice('');
    try {
      const isOwnerCurrent = () => alive.current && ownerRef.current === capturedOwner && observedRef.current.jobId === captured.jobId && !blocked;
      const result = await onSubmit(captured.planId, captured.jobId, capturedOwner, isOwnerCurrent);
      if (alive.current && sequence.current === ticket && ownerRef.current === capturedOwner) {
        if (!result) {
          setNotice('No request status was confirmed. Check the existing request history before taking another action.');
          return;
        }
        onSubmitted?.(result, capturedOwner);
        setNotice(result.status === 'submission_unknown' || result.status === 'cleanup_pending'
          ? 'The new request status is uncertain. Check this saved request before taking another action.'
          : 'The new Batch request is saved in request history. Check its status when you choose.');
      }
    } catch (error) {
      if (alive.current && sequence.current === ticket && ownerRef.current === capturedOwner) {
        const message = error instanceof Error && (error.message === 'Save an OpenRouter API key in Settings before submitting this paid request.' || error.message === 'Choose OpenRouter in Provider mode before submitting this paid request.' || error.message === 'Workspace or OpenRouter settings changed. Prepare a fresh review.')
          ? error.message
          : 'Submission outcome could not be confirmed. Check the existing request history before taking another action.';
        setNotice(message);
      }
    } finally {
      if (alive.current && sequence.current === ticket && ownerRef.current === capturedOwner) {
        lock.current = false;
        setPending(undefined);
      }
    }
  };

  const cancelReview = () => {
    if (pending === 'submit') return;
    sequence.current += 1;
    const current = planRef.current;
    planRef.current = undefined;
    lock.current = false;
    setPlan(undefined);
    setEffort(undefined);
    setPending(undefined);
    setNotice('Review cancelled.');
    if (current) cancelExact(current, ownerRef.current);
  };

  const efforts = validEfforts(job);
  if (!job.canRecoverMoreCompute || efforts.length === 0) return null;
  const activePlan = plan;
  const visiblePending = pending;
  const priorCost = activePlan?.priorAccounting.costStatus === 'reported'
    ? formatReportedBatchCost(activePlan.priorAccounting.providerReportedCostUsd)
    : undefined;
  const tokenParts = activePlan ? [
    activePlan.priorAccounting.promptTokens !== undefined ? `${activePlan.priorAccounting.promptTokens.toLocaleString()} prompt` : undefined,
    activePlan.priorAccounting.completionTokens !== undefined ? `${activePlan.priorAccounting.completionTokens.toLocaleString()} completion` : undefined,
    activePlan.priorAccounting.totalTokens !== undefined ? `${activePlan.priorAccounting.totalTokens.toLocaleString()} total` : undefined,
  ].filter(Boolean) : [];

  return <View style={styles.wrap}>
    {!activePlan ? <View style={styles.efforts}>
      {efforts.map((item) => <Button key={item} tone="quiet" label={visiblePending === 'prepare' && effort === item ? 'Preparing review…' : `Review higher ${readableEffort(item)}`} disabled={blocked || !prepareReady || visiblePending !== undefined} onPress={() => void prepare(item)} />)}
      {visiblePending === 'prepare' ? <Button label="Cancel preparation" tone="quiet" onPress={cancelReview} /> : null}
    </View> : null}
    {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
    <Modal visible={Boolean(activePlan)} transparent animationType="fade" onRequestClose={cancelReview}>
      <View style={styles.scrim}><View style={styles.sheet}>
        <Text style={s.sectionTitle}>Review higher reasoning request</Text>
        {activePlan ? <>
          <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewContent}>
            <Text style={styles.meta}>Request · {readableEffort(activePlan.priorEffort)} → {readableEffort(activePlan.requestedEffort)}</Text>
            {activePlan.requestedEffort === 'max' ? <Text style={styles.copy}>Max is the highest supported reasoning setting. No higher setting is available.</Text> : null}
            {activePlan.preview.capturedAt ? <Text style={styles.meta}>Captured · {activePlan.preview.capturedAt}{activePlan.preview.captureTimeZone ? ` · ${activePlan.preview.captureTimeZone}` : ''}</Text> : null}
            {activePlan.preview.asOf ? <Text style={styles.meta}>As of · {activePlan.preview.asOf}</Text> : null}
            {activePlan.preview.mail ? <View style={styles.context}>
              <Text style={styles.meta}>Fixed reply target · {activePlan.preview.mail.subject || '(no subject)'}</Text>
              <Text style={styles.copy}>To · {activePlan.preview.mail.to.join(', ') || 'None'}</Text>
              {activePlan.preview.mail.cc.length ? <Text style={styles.copy}>Cc · {activePlan.preview.mail.cc.join(', ')}</Text> : null}
            </View> : null}
            {activePlan.preview.sourceLabels.length ? <View style={styles.context}><Text style={styles.meta}>Included sources</Text>{activePlan.preview.sourceLabels.map((source, index) => <Text key={`${source.id}-${index}`} style={styles.copy}>{source.label}</Text>)}</View> : null}
            <Text style={styles.meta}>{priorCost ? `Previously reported provider cost · ${priorCost}` : 'Previously reported provider cost · unavailable'}</Text>
            {activePlan.priorAccounting.byok !== undefined ? <Text style={styles.copy}>{activePlan.priorAccounting.byok ? 'OpenRouter BYOK fee only; provider charges not included.' : 'Prior request did not use BYOK.'}</Text> : null}
            <Text style={styles.copy}>Previously reported tokens · {tokenParts.length ? tokenParts.join(' · ') : 'unavailable'}</Text>
            {activePlan.priorAccounting.unknownCharge ? <Text style={styles.warning}>The previous request may have incurred a charge that was not reported.</Text> : null}
            <Text style={styles.meta}>Complete frozen request and selected context</Text>
            <Text selectable style={styles.input}>{activePlan.preview.userText}</Text>
            {activePlan.preview.sourceLabels.map((source, index) => <View key={`${source.id}-${index}`} style={styles.sourceContext}>
              <Text style={styles.meta}>{source.label}</Text>
              {source.text !== undefined ? <Text selectable style={styles.input}>{source.text}</Text> : null}
            </View>)}
            {activePlan.preview.omittedSourceCount > 0 ? <Text style={styles.warning}>{activePlan.preview.omittedSourceCount} source context item(s) were omitted from the request.</Text> : null}
            {activePlan.preview.chat ? <View style={styles.context}>
              <Text style={styles.meta}>Selected conversation context</Text>
              {activePlan.preview.chat.selectedContext.map((item, index) => <View key={`chat-context-${index}`} style={styles.sourceContext}>
                <Text style={styles.copy}>User · {item.completedAt}</Text><Text selectable style={styles.input}>{item.userText}</Text>
                <Text style={styles.copy}>Assistant</Text><Text selectable style={styles.input}>{item.assistantText}</Text>
              </View>)}
              {activePlan.preview.chat.completedRefinementParent ? <View style={styles.sourceContext}>
                <Text style={styles.meta}>Completed refinement parent · {activePlan.preview.chat.completedRefinementParent.completedAt}</Text>
                {activePlan.preview.chat.completedRefinementParent.summary ? <Text selectable style={styles.input}>{activePlan.preview.chat.completedRefinementParent.summary}</Text> : null}
                {activePlan.preview.chat.completedRefinementParent.answer ? <Text selectable style={styles.input}>{activePlan.preview.chat.completedRefinementParent.answer}</Text> : null}
              </View> : null}
            </View> : null}
            {activePlan.preview.mail ? <View style={styles.context}>
              <Text style={styles.meta}>Fixed target message · {activePlan.preview.mail.subject || '(no subject)'}</Text>
              <Text style={styles.copy}>{activePlan.preview.mail.targetMessage.sender ?? 'Sender unknown'} · {activePlan.preview.mail.targetMessage.sentAt ?? activePlan.preview.mail.targetMessage.receivedAt ?? 'Time unknown'}</Text>
              <Text style={styles.copy}>Target body · {activePlan.preview.mail.targetMessage.representation.replaceAll('_', ' ')} · {activePlan.preview.mail.targetMessage.completeness.replaceAll('_', ' ')}</Text>
              {activePlan.preview.mail.targetMessage.omissionReasons.map((reason, index) => <Text key={`target-omission-${index}`} style={styles.warning}>Target omission · {reason.replaceAll('_', ' ')}</Text>)}
              <Text selectable style={styles.input}>{activePlan.preview.mail.targetMessage.text}</Text>
              <Text style={styles.meta}>Reply brief</Text><Text selectable style={styles.input}>{activePlan.preview.mail.brief || 'No brief'}</Text>
              {activePlan.preview.mail.selectedNoteContext ? <View><Text style={styles.meta}>Selected note context</Text><Text selectable style={styles.input}>{activePlan.preview.mail.selectedNoteContext}</Text></View> : null}
              {activePlan.preview.mail.contextMessages.map((item, index) => <View key={`mail-context-${index}`} style={styles.sourceContext}>
                <Text style={styles.meta}>{item.subject || '(no subject)'}</Text>
                <Text style={styles.copy}>{item.sender ?? 'Sender unknown'} · {item.sentAt ?? item.receivedAt ?? 'Time unknown'}</Text>
                <Text style={styles.copy}>Message body · {item.representation.replaceAll('_', ' ')} · {item.completeness.replaceAll('_', ' ')}</Text>
                <Text selectable style={styles.input}>{item.text}</Text>
                {item.omissionReasons.map((reason, reasonIndex) => <Text key={`${index}-${reasonIndex}`} style={styles.warning}>Omitted · {reason.replaceAll('_', ' ')}</Text>)}
              </View>)}
            </View> : null}
          </ScrollView>
          <View style={styles.footer}>
            <Text style={styles.warning}>{activePlan.warning}</Text>
            <Button label={visiblePending === 'submit' ? 'Submitting…' : 'Submit new paid request'} disabled={blocked || !submitReady || visiblePending !== undefined} onPress={() => void submit()} />
            {!submitReady ? <Text style={styles.copy}>Configure OpenRouter before submitting. Review is available without a model key.</Text> : null}
            <Button label="Cancel review" tone="quiet" disabled={visiblePending !== undefined} onPress={cancelReview} />
          </View>
        </> : null}
      </View></View>
    </Modal>
  </View>;
}

const styles = {
  wrap: { gap: 6, paddingTop: 4 },
  efforts: { gap: 6 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.76)', justifyContent: 'center' as const, padding: 18 },
  sheet: { flex: 1, maxHeight: '92%' as const, minHeight: 0, gap: 9, padding: 16, borderRadius: 18, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  previewScroll: { flexShrink: 1, minHeight: 96, borderWidth: 1, borderColor: C.border, borderRadius: 10, backgroundColor: C.input },
  previewContent: { padding: 10, gap: 6 },
  footer: { flexShrink: 0, gap: 7, paddingTop: 4 },
  context: { gap: 4, paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.border },
  sourceContext: { gap: 4, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border },
  input: { color: C.text, fontSize: 12, lineHeight: 18 },
  meta: { color: C.sage, fontSize: 11, lineHeight: 16 },
  copy: { color: C.muted, fontSize: 12, lineHeight: 17 },
  warning: { color: '#E4B17F', fontSize: 12, lineHeight: 18 },
  notice: { color: C.muted, fontSize: 11, lineHeight: 16 },
};
