import React from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StartupRecoveryInspection, StartupRecoveryPlan, StartupRecoveryReceipt } from '../storage/startupRecovery';
import { Button } from './primitives';
import { C } from './theme';

export type StartupRecoveryPhase = 'failed' | 'prepared' | 'committing' | 'committed_opening' | 'unavailable';

type Props = {
  phase: StartupRecoveryPhase;
  inspection?: StartupRecoveryInspection;
  plan?: StartupRecoveryPlan;
  receipt?: StartupRecoveryReceipt;
  message?: string;
  busy?: boolean;
  samplePreview?: boolean;
  onRetry: () => void;
  onPrepare: () => void;
  onCommit: () => void;
  onCancel: () => void;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function inspectionMessage(inspection?: StartupRecoveryInspection): string {
  if (!inspection) return 'Still could not open its saved data. Your original data has not been changed.';
  switch (inspection.status) {
    case 'available': return 'A preserved copy can be made before starting with fresh local data.';
    case 'empty': return 'There is no saved snapshot available to archive. Retry opening to try again.';
    case 'too_large': return 'The saved data is larger than this recovery flow can safely archive. Your original data remains in place.';
    case 'newer_version': return 'This saved data belongs to a newer app version. Update the app before trying again.';
    case 'archive_full': return 'The local recovery archive is full. Your original data remains in place.';
    default: return 'Recovery details are unavailable. Your original data remains in place.';
  }
}

export function StartupRecoveryScreen({ phase, inspection, plan, receipt, message, busy = false, samplePreview = false, onRetry, onPrepare, onCommit, onCancel }: Props) {
  const reviewReady = (phase === 'prepared' || phase === 'committing') && Boolean(plan);
  const isPostCommit = phase === 'committed_opening';
  const canPrepare = phase === 'failed' && inspection?.status === 'available' && !inspection.pendingReceipt;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.kicker}>STILL · LOCAL RECOVERY</Text>
          {samplePreview ? <Text style={styles.footnote}>Sample recovery · in-memory only · no external access</Text> : null}
          <Text style={styles.title}>{reviewReady ? 'Review your recovery plan' : 'Still could not open.'}</Text>
          <Text style={styles.body} accessibilityRole="alert">
            {reviewReady
              ? 'A fresh local starting point will be created only after you confirm below.'
              : isPostCommit
                ? 'Your original data was preserved. The fresh startup needs another try.'
                : phase === 'unavailable' && !inspection
                  ? 'Recovery is not available right now. Your saved data has not been changed.'
                  : inspectionMessage(inspection)}
          </Text>
          {message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null}

          {isPostCommit && receipt ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Recovery copy recorded</Text>
              <Text style={styles.row}>Preserved data: {formatBytes(receipt.evidenceBytes)}</Text>
              <Text style={styles.body}>Retry opening to finish with the fresh local data. The preserved copy will remain available.</Text>
            </View>
          ) : inspection?.pendingReceipt ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>A recovery was already recorded</Text>
              <Text style={styles.row}>Preserved data: {formatBytes(inspection.pendingReceipt.evidenceBytes)}</Text>
              <Text style={styles.body}>Retry opening to finish safely. The original archived copy is retained.</Text>
            </View>
          ) : null}

          {reviewReady && plan ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>What will be preserved</Text>
              <Text style={styles.row}>Saved data: {formatBytes(plan.evidenceBytes)}</Text>
              <Text style={styles.row}>Existing recovery copies: {plan.archiveCount}</Text>
              <Text style={styles.body}>This creates an archive and starts with fresh app data. It does not erase the preserved copy or reconcile external actions.</Text>
              <Text style={styles.body}>Existing recordings, credentials, and reminders are retained. Previously scheduled reminders may still appear.</Text>
            </View>
          ) : !isPostCommit && inspection?.status === 'available' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Saved data available</Text>
              <Text style={styles.row}>Saved data: {formatBytes(inspection.evidenceBytes)}</Text>
              <Text style={styles.row}>Existing recovery copies: {inspection.archiveCount}</Text>
              <Text style={styles.body}>Reviewing a plan does not change your saved data.</Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            {reviewReady ? (
              <>
                <Button label={busy ? 'Preserving data…' : 'Preserve and start fresh'} onPress={onCommit} disabled={busy} />
                <Button label="Cancel review" tone="quiet" onPress={onCancel} disabled={busy} />
              </>
            ) : (
              <>
                <Button label={busy ? 'Retrying…' : 'Retry opening'} onPress={onRetry} disabled={busy} />
                {canPrepare ? <Button label={busy ? 'Preparing plan…' : 'Review fresh-start plan'} tone="quiet" onPress={onPrepare} disabled={busy} /> : null}
              </>
            )}
          </View>
          {phase === 'committing' ? <Text style={styles.footnote}>Saving the preserved copy and fresh local snapshot…</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  content: { flexGrow: 1, width: '100%', maxWidth: 560, alignSelf: 'center', justifyContent: 'center', padding: 26, gap: 16 },
  kicker: { color: C.sage, fontSize: 10, fontWeight: '700', letterSpacing: 1.6 },
  title: { color: C.text, fontSize: 32, fontWeight: '500', letterSpacing: -0.8 },
  body: { color: C.muted, fontSize: 15, lineHeight: 23 },
  card: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 20, padding: 18, gap: 11 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '600' },
  row: { color: C.text, fontSize: 14, lineHeight: 21 },
  actions: { gap: 8, marginTop: 4 },
  footnote: { color: C.muted, fontSize: 12, lineHeight: 18 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
});
