import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Field } from './primitives';
import { C } from './theme';

export type PrivacyEraseCategory =
  | 'notes_context'
  | 'action_history_recovery'
  | 'recordings_caches'
  | 'credentials'
  | 'notifications';

export type PrivacyEraseReviewPhase =
  | 'prepare'
  | 'preparing'
  | 'ready'
  | 'error'
  | 'unavailable'
  | 'committing';

export type PrivacyEraseErrorKind =
  | 'prepare_failed'
  | 'review_expired'
  | 'confirm_failed'
  | 'runtime_unavailable';

export type PrivacyEraseReviewProps = {
  open: boolean;
  phase: PrivacyEraseReviewPhase;
  /** Supply only complete, safely known aggregate totals; omit unknown categories. */
  categoryCounts?: Partial<Record<PrivacyEraseCategory, number>>;
  reviewExpiresAt?: string;
  errorKind?: PrivacyEraseErrorKind;
  /** Safe capability explanation selected from fixed product copy, never a raw exception. */
  unavailableReason?: 'dedicated_ios_build_required' | 'secure_context_and_web_locks_required' | 'active_work' | 'full_restart_required';
  /** Opaque UI key; never displayed. Changing it clears typed confirmation. */
  planKey?: string;
  samplePreview?: boolean;
  onPrepare: () => void;
  onConfirm: () => void;
  onCancelReview: () => void;
  onClose: () => void;
};

const categories: { key: PrivacyEraseCategory; label: string }[] = [
  { key: 'notes_context', label: 'Notes, context, and saved documents' },
  { key: 'action_history_recovery', label: 'Action history and private recovery copies' },
  { key: 'recordings_caches', label: 'Recordings and SDK-managed cache copies' },
  { key: 'credentials', label: 'Locally stored account and provider credentials' },
  { key: 'notifications', label: 'Pending and delivered Still notifications' },
];

const errorCopy: Record<PrivacyEraseErrorKind, string> = {
  prepare_failed: 'A deletion review could not be prepared. Your workspace has not been changed.',
  review_expired: 'This review expired. Prepare a new review before confirming deletion.',
  confirm_failed: 'Deletion could not be confirmed. Check the status before trying again.',
  runtime_unavailable: 'Full local deletion is unavailable in this app runtime.',
};

function unavailableCopy(reason?: PrivacyEraseReviewProps['unavailableReason']): string {
  if (reason === 'secure_context_and_web_locks_required') {
    return 'Full deletion requires a secure browser context and Web Locks. Your data is unchanged.';
  }
  if (reason === 'active_work') {
    return 'Finish or stop active app work before preparing a deletion review. Your data is unchanged.';
  }
  if (reason === 'full_restart_required') {
    return 'A cleanup operation is still held by this app process. Fully quit and restart Still before trying again.';
  }
  return 'Full deletion is available only in the dedicated Still iOS app. Expo Go and other runtimes cannot verify the required cleanup controls.';
}

function formatExpiry(value?: string): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function PrivacyEraseReview(props: PrivacyEraseReviewProps) {
  const resetKey = `${props.open ? 'open' : 'closed'}:${props.planKey ?? 'unprepared'}`;
  return <PrivacyEraseReviewContent key={resetKey} {...props} />;
}

function PrivacyEraseReviewContent({
  open,
  phase,
  categoryCounts,
  reviewExpiresAt,
  errorKind,
  unavailableReason,
  samplePreview = false,
  onPrepare,
  onConfirm,
  onCancelReview,
  onClose,
}: PrivacyEraseReviewProps) {
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const reviewReady = phase === 'ready';
  const busy = phase === 'preparing' || phase === 'committing';
  const expiry = formatExpiry(reviewExpiresAt);

  const closeWithoutMutation = () => {
    if (busy) return;
    setTypedConfirmation('');
    if (reviewReady || phase === 'error') onCancelReview();
    onClose();
  };

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeWithoutMutation}>
      <View style={styles.safe}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.kicker}>STILL · PRIVACY</Text>
          {samplePreview ? <Text style={styles.coverage}>Sample cleanup · in-memory only · no external access</Text> : null}
          <Text style={styles.title}>Delete local app data?</Text>
          <Text style={styles.body}>
            Review the tracked categories, type DELETE, then confirm in a separate step. Nothing is deleted by opening or canceling this review.
          </Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Tracked categories</Text>
            {categories.map(({ key, label }) => (
              <View key={key} style={styles.categoryRow}>
                <Text style={styles.categoryLabel}>{label}</Text>
                {Number.isSafeInteger(categoryCounts?.[key]) && (categoryCounts?.[key] ?? -1) >= 0 ? (
                  <Text style={styles.count}>{categoryCounts?.[key]}</Text>
                ) : null}
              </View>
            ))}
            <Text style={styles.coverage}>
              Coverage is tracked data with legacy limits. Some historical OAuth keys may not be enumerable.
            </Text>
          </View>

          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>What remains outside this deletion</Text>
            <Text style={styles.body}>
              Exported, iCloud, shared, or other copied files remain. Email or calendar events already sent or saved, and data already submitted to providers, cannot be withdrawn here. Physical-media and operating-system-backup erasure cannot be guaranteed.
            </Text>
          </View>

          {phase === 'unavailable' ? (
            <Text accessibilityRole="alert" style={styles.error}>{unavailableCopy(unavailableReason)}</Text>
          ) : null}
          {errorKind ? <Text accessibilityRole="alert" style={styles.error}>{errorCopy[errorKind]}</Text> : null}

          {reviewReady ? (
            <View style={styles.confirmSection}>
              <Text style={styles.cardTitle}>Confirm deletion</Text>
              <Text style={styles.body}>
                This private review expires in five minutes{expiry ? ` (at ${expiry})` : ''}. Confirmation starts durable cleanup and closes the workspace.
              </Text>
              <Field
                label="Type DELETE to continue"
                value={typedConfirmation}
                onChangeText={setTypedConfirmation}
                placeholder="DELETE"
                editable={!busy}
              />
              <Button
                label="Confirm deletion"
                tone="danger"
                onPress={onConfirm}
                disabled={busy || typedConfirmation !== 'DELETE'}
              />
            </View>
          ) : null}

          <View style={styles.actions}>
            {!reviewReady && phase !== 'unavailable' ? (
              <Button
                label={phase === 'preparing' ? 'Preparing private review…' : phase === 'committing' ? 'Starting cleanup…' : 'Review deletion'}
                onPress={onPrepare}
                disabled={busy}
              />
            ) : null}
            <Button
              label={phase === 'unavailable' ? 'Close' : 'Cancel · keep this workspace'}
              tone="quiet"
              onPress={closeWithoutMutation}
              disabled={busy}
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  content: { flexGrow: 1, width: '100%', maxWidth: 620, alignSelf: 'center', padding: 24, paddingBottom: 36, gap: 16 },
  kicker: { color: C.sage, fontSize: 10, fontWeight: '700', letterSpacing: 1.6 },
  title: { color: C.text, fontSize: 31, lineHeight: 37, fontWeight: '500', letterSpacing: -0.8 },
  body: { color: C.muted, fontSize: 14, lineHeight: 21 },
  card: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '600' },
  categoryRow: { minHeight: 39, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  categoryLabel: { color: C.text, fontSize: 13, lineHeight: 19, flex: 1 },
  count: { color: C.muted, fontSize: 13, fontVariant: ['tabular-nums'] },
  coverage: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  notice: { backgroundColor: '#201E1B', borderRadius: 15, padding: 14, gap: 7 },
  noticeTitle: { color: C.text, fontSize: 13, fontWeight: '600' },
  confirmSection: { gap: 8, paddingTop: 3 },
  actions: { gap: 7, paddingTop: 2 },
  error: { color: C.red, fontSize: 13, lineHeight: 19, backgroundColor: '#241819', borderRadius: 12, padding: 12 },
});
