import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { AssistantBatchJobDTO } from '../services/openRouterBatchJobs';
import { Button } from './primitives';
import { C, s } from './theme';
import {
  assistantBatchStatusLabel,
  batchCheckLabel,
  batchJobTokenSummary,
  canCheckBatchJob,
  canRetryBatchJobCleanup,
  formatReportedBatchCost,
} from './assistantBatchJobPresentation';

type Props = {
  job: AssistantBatchJobDTO;
  busy?: boolean;
  blocked?: boolean;
  onCheck?: (jobId: string) => Promise<unknown> | unknown;
  onRetryCleanup?: (jobId: string) => Promise<unknown> | unknown;
};

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Time unavailable';
}

export function AssistantBatchJobCard({ job, busy = false, blocked = false, onCheck, onRetryCleanup }: Props) {
  const [checking, setChecking] = useState(false);
  const [retryingCleanup, setRetryingCleanup] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const checkLock = useRef(false);
  const cleanupLock = useRef(false);
  const tokenSummary = batchJobTokenSummary(job);
  const reportedCost = job.costStatus === 'reported'
    ? formatReportedBatchCost(job.providerReportedCostUsd)
    : undefined;

  const runAction = async (kind: 'check' | 'cleanup') => {
    const callback = kind === 'check' ? onCheck : onRetryCleanup;
    const actionLock = kind === 'check' ? checkLock : cleanupLock;
    if (!callback || actionLock.current) return;
    actionLock.current = true;
    setActionError(undefined);
    if (kind === 'check') setChecking(true);
    else setRetryingCleanup(true);
    try {
      await callback(job.id);
    } catch {
      setActionError(kind === 'check'
        ? 'Could not check for a reply. Try again.'
        : 'Local cleanup could not be confirmed. Try again.');
    } finally {
      if (kind === 'check') setChecking(false);
      else setRetryingCleanup(false);
      actionLock.current = false;
    }
  };

  return (
    <View style={styles.card}>
      <Text style={s.sectionTitle}>OpenRouter Batch</Text>
      <Text style={styles.status}>{assistantBatchStatusLabel(job.status)}</Text>
      <Text style={styles.meta}>Added {dateLabel(job.createdAt)} · Luna Batch · {job.effort} reasoning</Text>
      {job.status === 'queued' || job.status === 'processing' ? (
        <Text style={styles.helper}>Batch replies may take up to 24 hours. Checks happen only when you ask.</Text>
      ) : null}
      {job.status === 'submission_unknown' ? (
        <Text style={styles.warning}>This request may have been charged. Checking never submits it again.</Text>
      ) : null}
      {job.failureCode === 'not_submitted' ? (
        <Text style={styles.helper}>The request was not submitted.</Text>
      ) : null}
      {job.status === 'completed' ? (
        <Text style={styles.helper}>The validated reply was saved to this note.</Text>
      ) : null}
      {job.status === 'cleanup_pending' ? (
        <Text style={styles.helper}>Finish closing this local request. This does not submit another request.</Text>
      ) : null}
      {job.status === 'source_removed' || job.sourceRemoved ? (
        <Text style={styles.helper}>The request content was removed. This small receipt is retained as history.</Text>
      ) : null}
      {(job.omittedSourceCount ?? 0) > 0 ? (
        <Text style={styles.meta}>{job.omittedSourceCount} context source{job.omittedSourceCount === 1 ? '' : 's'} omitted from the request.</Text>
      ) : null}
      {reportedCost !== undefined ? (
        <Text style={styles.meta}>
          {job.billingScope === 'byok_fee_only' ? 'OpenRouter-reported BYOK fee' : 'OpenRouter-reported cost'} · {reportedCost}
        </Text>
      ) : job.costStatus === 'waiting' ? (
        <Text style={styles.meta}>Provider-reported usage is not available yet.</Text>
      ) : job.costStatus === 'unavailable' ? (
        <Text style={styles.meta}>The provider did not report a cost for this job.</Text>
      ) : null}
      {tokenSummary ? <Text style={styles.meta}>Provider-reported tokens · {tokenSummary}</Text> : null}
      {actionError ? <Text accessibilityRole="alert" style={styles.warning}>{actionError}</Text> : null}
      {canCheckBatchJob(job) && onCheck ? (
        <Button
          label={checking ? 'Checking status…' : batchCheckLabel(job)}
          tone="quiet"
          disabled={checking || busy || blocked}
          onPress={() => void runAction('check')}
        />
      ) : null}
      {canRetryBatchJobCleanup(job) && onRetryCleanup ? (
        <Button
          label={retryingCleanup ? 'Finishing local cleanup…' : 'Finish local cleanup'}
          tone="quiet"
          disabled={retryingCleanup || blocked}
          onPress={() => void runAction('cleanup')}
        />
      ) : null}
    </View>
  );
}

const styles = {
  card: { gap: 8, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  status: { color: C.text, fontSize: 14, fontWeight: '600' as const },
  helper: { color: C.muted, fontSize: 12, lineHeight: 18 },
  warning: { color: C.sage, fontSize: 12, lineHeight: 18 },
  meta: { color: C.muted, fontSize: 11, lineHeight: 16 },
};
