import React, { useEffect, useLayoutEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { WorkspaceEraseCounts, WorkspaceErasePlan, WorkspaceEraseStatus } from '../cloud/workspaceEraseContracts';
import { Button } from '../ui/primitives';
import { C } from '../ui/theme';

export type WorkspaceEraseActions = Readonly<{
  refresh: () => Promise<unknown>;
  prepare: () => Promise<WorkspaceErasePlan>;
  confirm: () => Promise<WorkspaceErasePlan>;
  execute: () => Promise<unknown>;
  cancel: () => Promise<unknown>;
  retryReview: () => Promise<WorkspaceErasePlan>;
  retryCleanup: () => Promise<unknown>;
}>;

function counts(counts: WorkspaceEraseCounts) {
  return [`${counts.notes} notes`, `${counts.documents} documents`, `${counts.accounts} connections`, `${counts.proposals} proposals`,
    `${counts.audioUploads} audio uploads`, `${counts.backgroundPolicies} background policies`];
}

function statusCopy(status: WorkspaceEraseStatus | undefined): string {
  if (!status || status.status === 'none') {
    const hold = status?.hold;
    if (!hold) return 'Review erasure to pause workspace activity and see the final saved-item counts before you confirm.';
    if (hold.status === 'draining') return 'Workspace activity is still settling. Refresh status before retrying review or cancelling.';
    if (hold.status === 'drain_failed') return 'Some active work could not be stopped yet. You can retry the pause and review, or cancel this attempt.';
    return 'The workspace is paused. Retry review to see the final counts, or cancel this attempt.';
  }
  if (status.status === 'prepared') return 'Review the saved-item counts below. This plan expires at ' + new Date(status.plan.expiresAt).toLocaleString() + '.';
  if (status.status === 'confirmed') return 'The reviewed plan is confirmed. Erasure has not started yet.';
  if (status.status === 'cleanup_pending') return 'The active workspace has been cleared. Private file cleanup is still pending; retry it to finish.';
  if (status.status === 'complete') return 'Workspace erasure is complete. Your owner login remains available.';
  return 'The previous erasure review was cancelled. Your workspace remains available.';
}

export function WorkspaceErasePanel({ status, busy, error, actions, ownerKey }: {
  status?: WorkspaceEraseStatus; busy: boolean; error?: string; actions: WorkspaceEraseActions;
  ownerKey: string;
}) {
  const [message, setMessage] = useState<Readonly<{ scope: string; text: string }>>();
  const [finalReviewScope, setFinalReviewScope] = useState<string>();
  const [activeAction, setActiveAction] = useState<Readonly<{ ownerKey: string; id: number; name: 'prepare' | 'confirm' | 'execute' | 'cancel' | 'retry' | 'refresh' }>>();
  const actionSequence = React.useRef(0);
  const activeActionRef = React.useRef<typeof activeAction>(undefined);
  const mounted = React.useRef(true);
  const currentOwnerKey = React.useRef(ownerKey);
  const working = activeAction?.ownerKey === ownerKey;
  const action = working ? activeAction?.name : undefined;
  const locked = busy || working;
  const plan = status?.status === 'prepared' || status?.status === 'confirmed' ? status.plan : undefined;
  const planOwner = plan ? `${plan.commandId}:${plan.expectedPrivacyEpoch}:${plan.expectedRevision}` : '';
  const reviewScope = `${ownerKey}|${planOwner}`;
  const run = async (name: NonNullable<typeof action>, operation: () => Promise<unknown>) => {
    if (locked) return;
    const requestOwnerKey = currentOwnerKey.current;
    const requestAction = { ownerKey: requestOwnerKey, id: ++actionSequence.current, name } as const;
    activeActionRef.current = requestAction;
    setActiveAction(requestAction); setMessage(undefined);
    try {
      await operation();
      if (!mounted.current || currentOwnerKey.current !== requestOwnerKey) return;
    }
    catch (cause) {
      if (!mounted.current || currentOwnerKey.current !== requestOwnerKey) return;
      setMessage({ scope: reviewScope, text: cause instanceof Error ? cause.message : 'The workspace erasure request could not be confirmed.' });
      if (name === 'prepare' || name === 'confirm') {
        try { await actions.refresh(); } catch { /* The owner can retry status discovery explicitly. */ }
      }
    } finally {
      if (activeActionRef.current?.id === requestAction.id) {
        activeActionRef.current = undefined;
        if (mounted.current && currentOwnerKey.current === requestOwnerKey) setActiveAction(undefined);
      }
    }
  };
  const hold = status && 'hold' in status ? status.hold : undefined;
  const canStart = !status || status.status === 'none' && !hold || status.status === 'cancelled' || status.status === 'complete';
  const showCancel = Boolean(plan || hold);

  useLayoutEffect(() => { currentOwnerKey.current = ownerKey; }, [ownerKey]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const shownMessage = message?.scope === reviewScope ? message.text : undefined;

  return <View style={styles.card}>
      <Text style={styles.title}>Erase this workspace</Text>
      <Text style={styles.body}>This clears the active server workspace, its private audio and document files, and saved connections. You cannot undo this. Your owner login remains.</Text>
      <Text style={styles.body}>Existing backups and provider-side copies are not removed. Already-submitted provider jobs remain active and may incur charges.</Text>
      {status ? <Text style={styles.status}>{statusCopy(status)}</Text> : null}
      {plan ? <View accessibilityLabel="Reviewed erasure counts" style={styles.counts}>
        {counts(plan.counts).map((item) => <Text key={item} style={styles.body}>{item}</Text>)}
      </View> : null}
      {status?.status === 'cleanup_pending' ? <Button label={working ? 'Finishing cleanup…' : 'Retry private-file cleanup'} tone="danger" disabled={locked}
        onPress={() => { void run('retry', actions.retryCleanup); }} /> : null}
      {status?.status === 'none' && hold ? <>
        <Button label={action === 'refresh' ? 'Checking status…' : 'Check pause status'} tone="quiet" disabled={locked}
          onPress={() => { void run('refresh', actions.refresh); }} />
        {hold.status !== 'draining' ? <Button label={action === 'retry' ? 'Reviewing…' : 'Retry review'} disabled={locked}
          onPress={() => { void run('retry', actions.retryReview); }} /> : null}
      </> : null}
      {status?.status === 'prepared' ? <Button label={action === 'confirm' ? 'Confirming…' : 'Confirm erasure'} tone="danger" disabled={locked}
        onPress={() => { void run('confirm', actions.confirm); }} /> : null}
      {status?.status === 'confirmed' ? <>
        {finalReviewScope !== reviewScope ? <Button label="Review final erasure confirmation" tone="danger" disabled={locked} onPress={() => setFinalReviewScope(reviewScope)} /> : <>
          <Text style={styles.confirm}>Confirm clearing the active server workspace, its private files, and saved connections. You cannot undo this. Existing backups, provider copies, and submitted jobs remain; your owner login stays.</Text>
          {plan ? <View style={styles.counts}>{counts(plan.counts).map((item) => <Text key={`final-${item}`} style={styles.body}>{item}</Text>)}</View> : null}
          <View style={styles.actions}><Button label="Go back" tone="quiet" disabled={locked} onPress={() => setFinalReviewScope(undefined)} />
            <Button label={action === 'execute' ? 'Erasing…' : 'Erase workspace now'} tone="danger" disabled={locked}
              onPress={() => { void run('execute', actions.execute); }} /></View>
        </>}
      </> : null}
      {showCancel ? <Button label={action === 'cancel' ? 'Cancelling…' : 'Cancel erasure'} tone="quiet" disabled={locked}
        onPress={() => { void run('cancel', actions.cancel); }} /> : null}
      {canStart ? <Button label={action === 'prepare' ? 'Pausing and reviewing…' : 'Review erasure'} tone="danger" disabled={locked}
        onPress={() => { void run('prepare', actions.prepare); }} /> : null}
      {shownMessage || error ? <Text accessibilityRole="alert" style={styles.error}>{shownMessage ?? error}</Text> : null}
  </View>;
}

const styles = {
  card: { gap: 12, paddingHorizontal: 20, paddingVertical: 18, marginHorizontal: 25, marginTop: 10, marginBottom: 24,
    borderRadius: 18, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  title: { color: C.text, fontSize: 18, fontWeight: '700' as const },
  body: { color: C.muted, fontSize: 13, lineHeight: 19 },
  status: { color: C.text, fontSize: 13, lineHeight: 19 },
  counts: { padding: 12, gap: 5, borderWidth: 1, borderColor: C.border, borderRadius: 12 },
  confirm: { color: C.text, fontSize: 14, lineHeight: 21, fontWeight: '600' as const },
  actions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
};
