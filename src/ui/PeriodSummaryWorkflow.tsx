import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';
import type { PeriodSummaryApplicationPlan, PeriodSummaryApplicationPreview, PeriodSummaryApplicationReceipt,
  PeriodSummaryMoreComputePlan, PeriodSummaryResultReview } from '../core';
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
  readonly onPrepareApplication: (jobId: string) => Promise<PeriodSummaryApplicationPlan | PeriodSummaryApplicationReceipt>;
  readonly onCancelApplication: (planId: string) => void;
  readonly onApplyApplication: (planId: string, jobId: string) => Promise<PeriodSummaryApplicationReceipt>;
  readonly onReadApplicationPreview: (planId: string, jobId: string) => Promise<PeriodSummaryApplicationPreview | undefined>;
};

type Props = { readonly job: AssistantBatchJobDTO; readonly actions: PeriodSummaryWorkflowActions };

const effortOrder: readonly Effort[] = ['low', 'medium', 'high', 'max'];
const formatEffort = (effort: string) => effort === 'max' ? 'Max' : effort.charAt(0).toUpperCase() + effort.slice(1);
const isExpiredAtNow = (expiresAt: string) => Date.parse(expiresAt) <= Date.now();

export function PeriodSummaryWorkflow({ job, actions }: Props) {
  const { ownerKey, blocked, onPrepare, onSubmit, onCancel, onRead, onPrepareApplication, onCancelApplication,
    onApplyApplication, onReadApplicationPreview } = actions;
  const [plan, setPlan] = useState<PeriodSummaryMoreComputePlan>();
  const [applicationPlan, setApplicationPlan] = useState<PeriodSummaryApplicationPlan>();
  const [applicationPreview, setApplicationPreview] = useState<PeriodSummaryApplicationPreview>();
  const [result, setResult] = useState<PeriodSummaryResultReview>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const lock = useRef(false);
  const mounted = useRef(true);
  const owner = useRef(ownerKey);
  const cleanup = useRef({ plan, applicationPlan, onCancel, onCancelApplication });
  cleanup.current = { plan, applicationPlan, onCancel, onCancelApplication };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      if (!lock.current) {
        if (cleanup.current.plan) cleanup.current.onCancel(cleanup.current.plan.planId);
        if (cleanup.current.applicationPlan) cleanup.current.onCancelApplication(cleanup.current.applicationPlan.planId);
      }
    };
  }, []);
  useEffect(() => {
    if (owner.current === ownerKey) return;
    generation.current += 1;
    if (plan) onCancel(plan.planId);
    if (applicationPlan) onCancelApplication(applicationPlan.planId);
    setPlan(undefined); setApplicationPlan(undefined); setApplicationPreview(undefined); setResult(undefined); setBusy(false); setNotice(''); lock.current = false;
    owner.current = ownerKey;
  }, [ownerKey, onCancel, onCancelApplication, plan, applicationPlan]);

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
      if (!mounted.current || ticket !== generation.current || currentOwner !== owner.current || prepared.jobId !== job.id ||
          prepared.requestedEffort !== effort || isExpiredAtNow(prepared.expiresAt)) {
        onCancel(prepared.planId); return;
      }
      setPlan(prepared);
    } catch { if (ticket === generation.current) setNotice('Could not prepare a current review. Refresh the workspace and try again.'); }
    finally { if (ticket === generation.current) { setBusy(false); lock.current = false; } }
  };

  const cancel = () => {
    if (lock.current) return;
    generation.current += 1;
    if (plan) onCancel(plan.planId);
    if (applicationPlan) onCancelApplication(applicationPlan.planId);
    setPlan(undefined); setApplicationPlan(undefined); setApplicationPreview(undefined); setResult(undefined); setNotice('');
  };
  const requestClose = () => { if (!lock.current) cancel(); };

  const prepareApplication = async () => {
    if (lock.current || blocked) return;
    lock.current = true;
    const ticket = ++generation.current;
    const currentOwner = owner.current;
    setBusy(true); setNotice('');
    try {
      const prepared = await onPrepareApplication(job.id);
      if (!mounted.current || ticket !== generation.current || currentOwner !== owner.current || currentOwner !== ownerKey) {
        if ('planId' in prepared) onCancelApplication(prepared.planId);
        return;
      }
      if ('kind' in prepared && prepared.kind === 'applied') {
        setNotice(`This summary was already applied to ${prepared.path} at document revision ${prepared.documentRevision}.`);
        return;
      }
      if (prepared.jobId !== job.id || isExpiredAtNow(prepared.expiresAt)) {
        onCancelApplication(prepared.planId);
        setNotice('This review expired. Prepare a fresh review before saving.');
        return;
      }
      setApplicationPlan(prepared);
      const preview = await onReadApplicationPreview(prepared.planId, job.id);
      if (!mounted.current || ticket !== generation.current || currentOwner !== owner.current || currentOwner !== ownerKey) return;
      if (!preview || preview.planId !== prepared.planId || preview.jobId !== job.id) {
        onCancelApplication(prepared.planId);
        setApplicationPlan(undefined);
        setNotice('The exact saved summary preview is no longer available. Refresh and prepare a new review.');
        return;
      }
      setApplicationPreview(preview);
    } catch {
      if (ticket === generation.current) setNotice('Could not prepare this summary review. Refresh saved request history and try again.');
    } finally { if (ticket === generation.current) { setBusy(false); lock.current = false; } }
  };

  const applyApplication = async () => {
    const captured = applicationPlan;
    if (!captured || !applicationPreview || lock.current || blocked || isExpiredAtNow(captured.expiresAt)) return;
    lock.current = true;
    const ticket = ++generation.current;
    const currentOwner = owner.current;
    setBusy(true); setNotice('');
    try {
      const applied = await onApplyApplication(captured.planId, job.id);
      if (mounted.current && ticket === generation.current && owner.current === currentOwner && currentOwner === ownerKey) {
        setApplicationPlan(undefined); setApplicationPreview(undefined);
        setNotice(`Summary saved to ${applied.path} at document revision ${applied.documentRevision}.`);
      }
    } catch {
      if (ticket === generation.current) setNotice('The save outcome could not be confirmed. Inspect this saved request before preparing another review.');
    } finally { if (ticket === generation.current) { setBusy(false); lock.current = false; } }
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
      if (mounted.current && ticket === generation.current && owner.current === currentOwner && currentOwner === ownerKey) {
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
      if (mounted.current && ticket === generation.current && owner.current === currentOwner && currentOwner === ownerKey) {
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
    {job.status === 'completed' ? <View style={styles.actions}>
      <Button label={busy ? 'Loading saved summary…' : 'Review saved summary'} tone="quiet" disabled={busy || blocked} onPress={() => void read()} />
      <Button label={busy ? 'Preparing review…' : 'Save summary as document'} tone="quiet" disabled={busy || blocked} onPress={() => void prepareApplication()} />
    </View> : null}
    {job.status === 'result_truncated' && job.canRecoverMoreCompute ? <View style={styles.actions}>
      {efforts.map((effort) => <Button key={effort} label={busy ? 'Preparing review…' : `Review higher ${formatEffort(effort)}`} tone="quiet"
        disabled={busy || blocked} onPress={() => void prepare(effort)} />)}
    </View> : null}
    {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
    <Modal visible={Boolean(plan)} transparent animationType="fade" onRequestClose={requestClose}>
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
    <Modal visible={Boolean(applicationPlan && applicationPreview)} transparent animationType="fade" onRequestClose={requestClose}>
      <View style={styles.scrim}><View style={styles.sheet}>
        {applicationPlan && applicationPreview ? <ScrollView contentContainerStyle={styles.content}>
          <Text style={s.sectionTitle}>Review summary save</Text>
          <Text style={styles.meta}>{applicationPreview.period} · {applicationPreview.interval.start} through {applicationPreview.interval.end} · {applicationPreview.timeZone}</Text>
          <Text style={styles.meta}>Summary prepared · {applicationPreview.preparedAt}</Text>
          <Text style={styles.meta}>Destination · {applicationPlan.destinationPath}</Text>
          <Text style={styles.meta}>{applicationPlan.destinationExists
            ? `This will replace the current document at revision ${applicationPlan.destinationRevision}.`
            : 'This will create a new document.'}</Text>
          <Text selectable style={styles.markdown}>{applicationPreview.markdown}</Text>
          {applicationPreview.sourceReferences.length ? <View><Text style={styles.meta}>Referenced sources</Text>{applicationPreview.sourceReferences.map((label, index) =>
            <Text key={`${index}-${label}`} style={styles.copy}>{label}</Text>)}</View> : null}
          <View style={styles.actions}>
            <Button label={busy ? 'Saving…' : 'Save this summary'} disabled={busy || blocked || isExpiredAtNow(applicationPlan.expiresAt)} onPress={() => void applyApplication()} />
            <Button label="Cancel" tone="quiet" disabled={busy} onPress={cancel} />
          </View>
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
