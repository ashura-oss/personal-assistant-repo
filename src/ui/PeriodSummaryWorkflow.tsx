import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import type { PeriodSummaryMoreComputePlan, PeriodSummaryResultReview } from '../core';
import type { AssistantBatchJobDTO } from '../services/openRouterBatchJobs';
import { Button } from './primitives';
import { formatReportedBatchCost } from './assistantBatchJobPresentation';
import { C, s } from './theme';

type Effort = 'low' | 'medium' | 'high' | 'max';

export type PeriodSummaryWorkflowActions = {
  readonly ownerKey: string;
  readonly blocked: boolean;
  readonly onPrepare: (jobId: string, effort: Effort) => Promise<PeriodSummaryMoreComputePlan>;
  readonly onSubmit: (planId: string, jobId: string) => Promise<Readonly<{ jobStatus: AssistantBatchJobDTO['status'] }>>;
  readonly onCancel: (planId: string) => void;
  readonly onRead: (jobId: string) => Promise<PeriodSummaryResultReview | undefined>;
};

type Props = { readonly job: AssistantBatchJobDTO; readonly actions: PeriodSummaryWorkflowActions };

const effortOrder: readonly Effort[] = ['low', 'medium', 'high', 'max'];
const formatEffort = (effort: string) => effort === 'max' ? 'Max' : effort.charAt(0).toUpperCase() + effort.slice(1);
const isExpiredAtNow = (expiresAt: string) => Date.parse(expiresAt) <= Date.now();

export function PeriodSummaryWorkflow({ job, actions }: Props) {
  const { ownerKey, blocked, onPrepare, onSubmit, onCancel, onRead } = actions;
  const [plan, setPlan] = useState<PeriodSummaryMoreComputePlan>();
  const [result, setResult] = useState<PeriodSummaryResultReview>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const lock = useRef(false);
  const owner = useRef(ownerKey);
  useEffect(() => {
    if (owner.current === ownerKey) return;
    generation.current += 1;
    if (plan) onCancel(plan.planId);
    setPlan(undefined); setResult(undefined); setBusy(false); setNotice(''); lock.current = false;
    owner.current = ownerKey;
  }, [ownerKey, onCancel, plan]);

  const efforts = (job.moreComputeEfforts ?? []).filter((value): value is Effort => effortOrder.includes(value as Effort) &&
    effortOrder.indexOf(value as Effort) > effortOrder.indexOf(job.effort as Effort));

  const prepare = async (effort: Effort) => {
    if (lock.current || blocked) return;
    lock.current = true;
    const ticket = ++generation.current;
    const currentOwner = owner.current;
    setBusy(true); setNotice('');
    try {
      const prepared = await onPrepare(job.id, effort);
      if (ticket !== generation.current || currentOwner !== owner.current || prepared.jobId !== job.id ||
          prepared.requestedEffort !== effort || isExpiredAtNow(prepared.expiresAt)) {
        onCancel(prepared.planId); return;
      }
      setPlan(prepared);
    } catch { if (ticket === generation.current) setNotice('Could not prepare a current review. Refresh the workspace and try again.'); }
    finally { if (ticket === generation.current) { setBusy(false); lock.current = false; } }
  };

  const cancel = () => {
    generation.current += 1;
    if (plan) onCancel(plan.planId);
    setPlan(undefined); setResult(undefined); setNotice('');
  };

  const submit = async () => {
    const captured = plan;
    if (!captured || lock.current || blocked || isExpiredAtNow(captured.expiresAt)) return;
    lock.current = true;
    const ticket = ++generation.current;
    const currentOwner = owner.current;
    setBusy(true); setPlan(undefined); setNotice('');
    try {
      const submitted = await onSubmit(captured.planId, job.id);
      if (ticket === generation.current && owner.current === currentOwner && currentOwner === ownerKey) {
        setNotice(submitted.jobStatus === 'submission_unknown'
          ? 'The new request status is uncertain. Check that saved request before taking another action.'
          : 'The higher-effort request is saved in request history. Check its status when you choose.');
      }
    } catch { if (ticket === generation.current) setNotice('The new request outcome could not be confirmed. Check saved request history before trying again.'); }
    finally { if (ticket === generation.current) { setBusy(false); lock.current = false; } }
  };

  const read = async () => {
    if (lock.current || blocked) return;
    lock.current = true;
    const ticket = ++generation.current;
    const currentOwner = owner.current;
    setBusy(true); setNotice('');
    try {
      const reviewed = await onRead(job.id);
      if (ticket === generation.current && owner.current === currentOwner && currentOwner === ownerKey) {
        if (!reviewed) setNotice('The completed summary is no longer available. Refresh saved request history.');
        else setResult(reviewed);
      }
    } catch { if (ticket === generation.current) setNotice('The saved summary could not be validated. Refresh saved request history.'); }
    finally { if (ticket === generation.current) { setBusy(false); lock.current = false; } }
  };

  if (job.kind !== 'period_summary') return null;
  const priorCost = plan?.priorAccounting.costStatus === 'reported'
    ? formatReportedBatchCost(plan.priorAccounting.providerReportedCostUsd) : undefined;

  return <View style={styles.wrap}>
    {job.status === 'completed' ? <Button label={busy ? 'Loading saved summary…' : 'Review saved summary'} tone="quiet" disabled={busy || blocked} onPress={() => void read()} /> : null}
    {job.status === 'result_truncated' && job.canRecoverMoreCompute ? <View style={styles.actions}>
      {efforts.map((effort) => <Button key={effort} label={busy ? 'Preparing review…' : `Review higher ${formatEffort(effort)}`} tone="quiet"
        disabled={busy || blocked} onPress={() => void prepare(effort)} />)}
    </View> : null}
    {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
    <Modal visible={Boolean(plan)} transparent animationType="fade" onRequestClose={cancel}>
      <View style={styles.scrim}><View style={styles.sheet}>
        {plan ? <ScrollView contentContainerStyle={styles.content}>
          <Text style={s.sectionTitle}>Review higher-effort summary</Text>
          <Text style={styles.meta}>Request · {formatEffort(plan.priorEffort)} → {formatEffort(plan.requestedEffort)}</Text>
          <Text style={styles.meta}>{plan.period} · {plan.interval.start} through {plan.interval.end} · {plan.timeZone}</Text>
          <Text style={styles.meta}>Frozen source snapshot prepared · {plan.preparedAt}</Text>
          <Text style={styles.meta}>Destination · {plan.destinationPath}</Text>
          <Text style={styles.meta}>Frozen sources · {plan.sourceCount}</Text>
          {plan.sourceLabels.map((label, index) => <Text key={`${index}-${label}`} style={styles.copy}>{label}</Text>)}
          <Text style={styles.meta}>Previously reported provider cost · {priorCost ?? 'unavailable'}</Text>
          <Text style={styles.copy}>{plan.priorAccounting.unknownCharge ? 'The previous request may have incurred an unreported charge.' : 'No additional previous charge is known.'}</Text>
          <Text style={styles.warning}>{plan.warning}</Text>
          <View style={styles.actions}>
            <Button label={busy ? 'Submitting…' : 'Submit higher-effort request'} disabled={busy || blocked} onPress={() => void submit()} />
            <Button label="Cancel" tone="quiet" disabled={busy} onPress={cancel} />
          </View>
        </ScrollView> : null}
      </View></View>
    </Modal>
    <Modal visible={Boolean(result)} transparent animationType="fade" onRequestClose={() => setResult(undefined)}>
      <View style={styles.scrim}><View style={styles.sheet}>
        {result ? <ScrollView contentContainerStyle={styles.content}>
          <Text style={s.sectionTitle}>Saved {result.period} summary</Text>
          <Text style={styles.meta}>{result.interval.start} through {result.interval.end}</Text>
          <Text selectable style={styles.markdown}>{result.markdown}</Text>
          {result.sourceReferences.length ? <View><Text style={styles.meta}>Referenced sources</Text>{result.sourceReferences.map((label, index) =>
            <Text key={`${index}-${label}`} style={styles.copy}>{label}</Text>)}</View> : null}
          <Button label="Close" tone="quiet" onPress={() => setResult(undefined)} />
        </ScrollView> : null}
      </View></View>
    </Modal>
  </View>;
}

const styles = {
  wrap: { gap: 8 },
  actions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8 },
  scrim: { flex: 1, justifyContent: 'center' as const, padding: 18, backgroundColor: '#000a' },
  sheet: { maxHeight: '88%' as const, borderRadius: 18, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, padding: 16 },
  content: { gap: 12 },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  copy: { color: C.text, fontSize: 13, lineHeight: 20 },
  markdown: { color: C.text, fontSize: 14, lineHeight: 22, padding: 10, borderRadius: 10, backgroundColor: '#101113' },
  warning: { color: C.sage, fontSize: 12, lineHeight: 19 },
  notice: { color: C.sage, fontSize: 12, lineHeight: 18 },
};
