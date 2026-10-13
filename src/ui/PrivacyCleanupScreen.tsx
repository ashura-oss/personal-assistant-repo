import React from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from './primitives';
import { C } from './theme';
import type { PrivacyEraseCategory } from './PrivacyEraseReview';

export type PrivacyCleanupPhase = 'unavailable' | 'running' | 'paused' | 'failed' | 'complete';
export type PrivacyCleanupStepState = 'pending' | 'working' | 'verified' | 'paused' | 'failed';
export type PrivacyCleanupUnavailableReason =
  | 'dedicated_ios_build_required'
  | 'secure_context_and_web_locks_required'
  | 'active_work'
  | 'full_restart_required'
  | 'storage_unavailable';
export type PrivacyCleanupFailureKind = 'storage_unavailable' | 'lease_lost' | 'verification_incomplete';

export type PrivacyCleanupScreenProps = {
  phase: PrivacyCleanupPhase;
  steps?: Partial<Record<PrivacyEraseCategory, PrivacyCleanupStepState>>;
  unavailableReason?: PrivacyCleanupUnavailableReason;
  failureKind?: PrivacyCleanupFailureKind;
  busy?: boolean;
  samplePreview?: boolean;
  /** Optional timestamp only; no identifiers or personal data are accepted by this screen. */
  completedAt?: string;
  onRetry: () => void;
  onOpenFreshWorkspace: () => void;
};

const categories: { key: PrivacyEraseCategory; label: string }[] = [
  { key: 'notes_context', label: 'Notes, context, and saved documents' },
  { key: 'action_history_recovery', label: 'Action history and private recovery copies' },
  { key: 'recordings_caches', label: 'Recordings and SDK-managed cache copies' },
  { key: 'credentials', label: 'Locally stored account and provider credentials' },
  { key: 'notifications', label: 'Still notifications' },
];

const stateLabel: Record<PrivacyCleanupStepState, string> = {
  pending: 'Waiting',
  working: 'Working',
  verified: 'Verified removed',
  paused: 'Paused',
  failed: 'Needs retry',
};

const failureCopy: Record<PrivacyCleanupFailureKind, string> = {
  storage_unavailable: 'A local storage step could not be verified. Keep this screen open and retry cleanup.',
  lease_lost: 'Cleanup lost its safe local-operation lock. It has not opened the workspace.',
  verification_incomplete: 'Some tracked items could not be verified as removed. The workspace remains closed.',
};

function unavailableCopy(reason?: PrivacyCleanupUnavailableReason): string {
  if (reason === 'secure_context_and_web_locks_required') {
    return 'Cleanup requires a secure browser context and Web Locks. No unsafe lock takeover is available.';
  }
  if (reason === 'active_work') {
    return 'Privacy controls found active local work. Finish or stop it, then check again. If nothing is running, fully quit and restart Still.';
  }
  if (reason === 'full_restart_required') {
    return 'This app process still holds a cleanup operation. Fully quit and restart Still before continuing.';
  }
  if (reason === 'storage_unavailable') {
    return 'Local privacy controls could not be opened. The workspace stayed closed and no data cleanup was started.';
  }
  return 'Verified cleanup requires the dedicated Still iOS app. Expo Go and other runtimes cannot prove all required local steps.';
}

function titleForPhase(phase: PrivacyCleanupPhase): string {
  if (phase === 'complete') return 'Deletion complete.';
  if (phase === 'running') return 'Cleaning up local data.';
  if (phase === 'paused') return 'Cleanup is paused.';
  if (phase === 'failed') return 'Cleanup needs attention.';
  return 'Cleanup is unavailable.';
}

export function PrivacyCleanupScreen({
  phase,
  steps,
  unavailableReason,
  failureKind,
  busy = false,
  samplePreview = false,
  completedAt,
  onRetry,
  onOpenFreshWorkspace,
}: PrivacyCleanupScreenProps) {
  const complete = phase === 'complete';
  const canRetry = phase === 'paused' || phase === 'failed';

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.kicker}>STILL · PRIVACY</Text>
          {samplePreview ? <Text style={styles.meta}>Sample cleanup · in-memory only · no external access</Text> : null}
          <Text style={styles.title}>{titleForPhase(phase)}</Text>
          <Text style={styles.body}>
            {complete
              ? 'All known tracked cleanup steps were verified. Only a minimal nonpersonal completion record remains.'
              : 'The normal workspace stays closed until every known cleanup step is verified.'}
          </Text>

          {phase === 'unavailable' ? (
            <Text accessibilityRole="alert" style={styles.error}>{unavailableCopy(unavailableReason)}</Text>
          ) : null}
          {failureKind ? <Text accessibilityRole="alert" style={styles.error}>{failureCopy[failureKind]}</Text> : null}

          {!complete && phase !== 'unavailable' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Cleanup progress</Text>
              {categories.map(({ key, label }) => {
                const state = steps?.[key] ?? 'pending';
                return (
                  <View key={key} style={styles.stepRow}>
                    <Text style={styles.stepName}>{label}</Text>
                    <Text style={[styles.stepState, state === 'verified' && styles.verified]}>{stateLabel[state]}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}

          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>Deletion limits</Text>
            <Text style={styles.body}>
              Exported, iCloud, shared, or other copied files remain. Already sent email/calendar events and provider-submitted data cannot be withdrawn. Physical-media and operating-system-backup erasure cannot be guaranteed.
            </Text>
            <Text style={styles.body}>
              Coverage is tracked data with legacy limits; some historical OAuth keys may not be enumerable. Previously scheduled reminders may still appear until their removal is verified.
            </Text>
          </View>

          {complete ? (
            <View style={styles.actions}>
              {completedAt ? <Text style={styles.meta}>Completed {completedAt}</Text> : null}
              <Button label="Open fresh workspace" onPress={onOpenFreshWorkspace} disabled={busy} />
            </View>
          ) : canRetry ? (
            <View style={styles.actions}>
              <Button label={busy ? 'Retrying cleanup…' : 'Retry cleanup'} onPress={onRetry} disabled={busy} />
            </View>
          ) : phase === 'unavailable' ? (
            <View style={styles.actions}>
              <Button label="Check again" onPress={onRetry} disabled={busy} />
            </View>
          ) : phase === 'running' ? (
            <Text style={styles.meta}>Cleanup continues only through verified local steps. The workspace will remain closed if a step pauses.</Text>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  content: { flexGrow: 1, width: '100%', maxWidth: 600, alignSelf: 'center', justifyContent: 'center', padding: 26, paddingBottom: 40, gap: 17 },
  kicker: { color: C.sage, fontSize: 10, fontWeight: '700', letterSpacing: 1.6 },
  title: { color: C.text, fontSize: 31, lineHeight: 37, fontWeight: '500', letterSpacing: -0.8 },
  body: { color: C.muted, fontSize: 14, lineHeight: 21 },
  card: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 18, padding: 16, gap: 2 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '600', marginBottom: 6 },
  stepRow: { minHeight: 43, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: C.border, gap: 12 },
  stepName: { color: C.text, fontSize: 13, lineHeight: 18, flex: 1 },
  stepState: { color: C.muted, fontSize: 11, minWidth: 82, textAlign: 'right' },
  verified: { color: C.sage },
  notice: { backgroundColor: '#201E1B', borderRadius: 15, padding: 14, gap: 8 },
  noticeTitle: { color: C.text, fontSize: 13, fontWeight: '600' },
  actions: { gap: 10, paddingTop: 2 },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  error: { color: C.red, fontSize: 13, lineHeight: 19, backgroundColor: '#241819', borderRadius: 12, padding: 12 },
});
