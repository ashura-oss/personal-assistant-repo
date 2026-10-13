import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { MailAlertTapResolution } from '../proactiveMailAlerts/taps';
import { Button, IconButton } from './primitives';
import { C, s } from './theme';

export type MailAlertTapStatusReason = Extract<MailAlertTapResolution, { kind: 'status' }>['reason'];
export type MailAlertTapStatus = Extract<MailAlertTapResolution, { kind: 'status' }>;

const STATUS_COPY: Record<MailAlertTapStatusReason, string> = {
  revoked: 'This alert is no longer enabled.',
  changed: 'The saved mail or alert rule has changed.',
  source_unavailable: 'The saved mail is no longer available.',
  refresh_required: 'Refresh local data before reviewing this alert.',
};

function observedCopy(observed: string | undefined): string | undefined {
  switch (observed) {
    case 'attempting': return 'Submission has not been confirmed.';
    case 'submitted': return 'Submission to iOS was recorded; delivery is not confirmed.';
    case 'delivery_unknown': return 'Alert submission status is unknown.';
    case 'cancellation_pending': return 'Removal has not been confirmed.';
    case 'cancellation_unknown': return 'Alert removal status is unknown.';
    case 'cancelled': return 'Alert removal or absence was confirmed.';
    default: return undefined;
  }
}

function readableTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(date);
  } catch { return date.toISOString(); }
}

export function MailAlertTapStatusCard({ status }: { status: MailAlertTapStatus }) {
  return (
    <View style={styles.statusCard}>
      <Text style={s.sectionTitle}>Mail alert</Text>
      <Text style={s.accountSub}>{STATUS_COPY[status.reason]}</Text>
      {observedCopy(status.observed) ? <Text style={s.accountSub}>{observedCopy(status.observed)}</Text> : null}
    </View>
  );
}

export function MailAlertTapReviewSheet({
  visible,
  result,
  busy = false,
  previewOnly = false,
  onClose,
  onOpenInbox,
}: {
  visible: boolean;
  result: MailAlertTapResolution | null;
  busy?: boolean;
  previewOnly?: boolean;
  onClose: () => void;
  onOpenInbox?: () => void;
}) {
  if (!result || result.kind === 'ignored' || result.kind === 'blocked') return null;
  const isMail = result.kind === 'mail';
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView style={s.modalSafe}>
          <View style={s.modalHeader}>
            <IconButton name="chevron-back" label="Close mail alert" onPress={onClose} />
            <Text style={s.modalTitle}>Mail alert</Text>
            <View style={styles.headerSpacer} />
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            {previewOnly ? <View style={s.previewBadge}><Text style={s.previewText}>SAMPLE · SIMULATED</Text></View> : null}
            {isMail ? (
              <>
                <Text style={s.kicker}>SAVED MAIL PREVIEW</Text>
                <Text style={s.h1Small}>{result.subject || '(No subject)'}</Text>
                <Text style={s.accountSub}>From {result.senderLabel || 'Sender unavailable'}</Text>
                <Text style={s.accountSub}>Account: {result.accountLabel}</Text>
                {result.snippet ? <Text selectable style={styles.snippet}>{result.snippet}</Text> : <Text style={s.accountSub}>No saved preview text.</Text>}
                <View style={styles.times}>
                  <Text style={s.accountSub}>Received {readableTime(result.receivedAt)}</Text>
                  <Text style={s.accountSub}>Checked {readableTime(result.checkedAt)}</Text>
                </View>
                <Text style={styles.disclosure}>This is a short preview saved on this device. Open Inbox to review the message and choose what to do.</Text>
                {onOpenInbox ? <Button label="Open Inbox" onPress={onOpenInbox} /> : null}
              </>
            ) : (
              <>
                <Text style={s.kicker}>ALERT STATUS</Text>
                <Text style={s.h1Small}>This mail alert needs review.</Text>
                <Text style={s.intro}>{STATUS_COPY[result.reason]}</Text>
                {observedCopy(result.observed) ? <Text style={s.accountSub}>{observedCopy(result.observed)}</Text> : null}
                {onOpenInbox ? <Button label="Open Inbox" tone="quiet" onPress={onOpenInbox} /> : null}
              </>
            )}
            <Button label="Close" tone="quiet" disabled={busy} onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingVertical: 18, gap: 14 },
  snippet: { color: C.text, fontSize: 16, lineHeight: 24, backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 16 },
  times: { gap: 5, marginTop: 3 },
  disclosure: { color: C.muted, fontSize: 13, lineHeight: 20, marginTop: 5 },
  headerSpacer: { width: 46 },
  statusCard: { gap: 9, padding: 15, borderRadius: 16, backgroundColor: C.card, borderColor: C.border, borderWidth: 1 },
});
