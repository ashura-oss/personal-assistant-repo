import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createMailAlertTapCoordinator, type MailAlertTapBackend, type MailAlertTapKey, type MailAlertTapResolution } from '../proactiveMailAlerts/taps';
import { MailAlertTapReviewSheet } from '../ui/MailAlertTapReviewSheet';
import { Button } from '../ui/primitives';
import { C, s } from '../ui/theme';

const installationId = '11111111-1111-4111-8111-111111111111';
const validKey: MailAlertTapKey = { installationId, receiptId: '22222222-2222-4222-8222-222222222222' };
const revokedKey: MailAlertTapKey = { installationId, receiptId: '33333333-3333-4333-8333-333333333333' };
const unavailableKey: MailAlertTapKey = { installationId, receiptId: '44444444-4444-4444-8444-444444444444' };
const wrongInstallationKey: MailAlertTapKey = { installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', receiptId: '55555555-5555-4555-8555-555555555555' };
const slowKey: MailAlertTapKey = { installationId, receiptId: '66666666-6666-4666-8666-666666666666' };
const newerKey: MailAlertTapKey = { installationId, receiptId: '77777777-7777-4777-8777-777777777777' };
const blockedKey: MailAlertTapKey = { installationId, receiptId: '88888888-8888-4888-8888-888888888888' };

const fixtureResponses = new Map<string, MailAlertTapResolution>([
  [validKey.receiptId, {
    kind: 'mail', receiptId: validKey.receiptId, ruleId: 'fictional-rule', messageId: 'fictional-message',
    sourceVersion: 'fictional-version', subject: 'Revised project timeline', senderLabel: 'Morgan Lee',
    snippet: 'Could you send the revised timeline by Friday?', accountLabel: 'Sample account',
    receivedAt: '2026-10-13T09:15:00.000Z', checkedAt: '2026-10-13T09:20:00.000Z',
  }],
  [revokedKey.receiptId, { kind: 'status', receiptId: revokedKey.receiptId, reason: 'revoked', observed: 'cancelled' }],
  [unavailableKey.receiptId, { kind: 'status', receiptId: unavailableKey.receiptId, reason: 'source_unavailable', observed: 'submitted' }],
  [slowKey.receiptId, {
    kind: 'mail', receiptId: slowKey.receiptId, ruleId: 'fictional-rule', messageId: 'fictional-earlier-message',
    sourceVersion: 'fictional-version-older', subject: 'Earlier sample message', senderLabel: 'Morgan Lee',
    snippet: 'This earlier lookup should be superseded.', accountLabel: 'Sample account',
    receivedAt: '2026-10-13T09:10:00.000Z', checkedAt: '2026-10-13T09:20:00.000Z',
  }],
  [newerKey.receiptId, {
    kind: 'mail', receiptId: newerKey.receiptId, ruleId: 'fictional-rule', messageId: 'fictional-newer-message',
    sourceVersion: 'fictional-version-newer', subject: 'Newer sample message', senderLabel: 'Morgan Lee',
    snippet: 'The latest tap is reviewed after the earlier lookup settles.', accountLabel: 'Sample account',
    receivedAt: '2026-10-13T09:19:00.000Z', checkedAt: '2026-10-13T09:20:00.000Z',
  }],
]);

function makePreviewBackend(listenerRef: React.MutableRefObject<((key: MailAlertTapKey) => void) | undefined>): MailAlertTapBackend {
  return {
    async subscribe(_id, listener) {
      listenerRef.current = listener;
      return { remove() { if (listenerRef.current === listener) listenerRef.current = undefined; } };
    },
    async getLastResponse() { return validKey; },
  };
}

function guardPreview() {
  if (typeof __DEV__ === 'undefined' || !__DEV__ || Platform.OS !== 'web' ||
      process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== 'mail-alert-taps') {
    throw new Error('The isolated mail alert tap preview is unavailable.');
  }
}

export function MailAlertTapPreview() {
  guardPreview();
  const coordinatorRef = useRef<ReturnType<typeof createMailAlertTapCoordinator> | null>(null);
  const listenerRef = useRef<((key: MailAlertTapKey) => void) | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<MailAlertTapResolution | null>(null);
  const [slow, setSlow] = useState(false);
  const [sampleCaptureActive, setSampleCaptureActive] = useState(false);
  const slowRef = useRef(false);
  const releaseSlowRef = useRef<(() => void) | undefined>(undefined);
  const resolve = useCallback(async (key: MailAlertTapKey): Promise<MailAlertTapResolution> => {
    if (slowRef.current && key.receiptId === slowKey.receiptId) {
      await new Promise<void>((resolveWait) => { releaseSlowRef.current = resolveWait; });
    }
    return fixtureResponses.get(key.receiptId) ?? { kind: 'ignored' };
  }, []);

  useEffect(() => {
    const backend = makePreviewBackend(listenerRef);
    const coordinator = createMailAlertTapCoordinator(backend);
    coordinatorRef.current = coordinator;
    void coordinator.start({
      installationId,
      isReady: true,
      resolve,
      onPendingChange: setPending,
      onResolution: (_key, resolution) => {
        if (resolution.kind !== 'ignored' && resolution.kind !== 'blocked') {
          coordinator.setReady(false);
          setResult(resolution);
        }
      },
    });
    return () => { coordinator.dispose(); coordinatorRef.current = null; listenerRef.current = undefined; };
  }, [resolve]);

  useEffect(() => {
    coordinatorRef.current?.setReady(!sampleCaptureActive && !result);
  }, [result, sampleCaptureActive]);

  const emit = (key: MailAlertTapKey) => listenerRef.current?.(key);
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.viewport}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={s.kicker}>ISOLATED PREVIEW</Text>
          <Text style={s.h1Small}>Sample mail alert taps</Text>
          <Text style={s.intro}>Coordinator and UI fixture only · fictional data, no provider, notification SDK, account, or microphone access. The first sample is a cached tap; duplicate cached/live taps are ignored.</Text>
          {pending ? <Text style={styles.pending}>A sample tap is waiting for a safe review point.</Text> : null}
          <Button label="Simulate saved-mail tap" onPress={() => emit(validKey)} />
          <Button label="Simulate duplicate tap" tone="quiet" onPress={() => { emit(validKey); emit(validKey); }} />
          <Button label="Simulate revoked alert" tone="quiet" onPress={() => emit(revokedKey)} />
          <Button label="Simulate unavailable saved mail" tone="quiet" onPress={() => emit(unavailableKey)} />
          <Button label="Simulate tap from another installation (ignored)" tone="quiet" onPress={() => emit(wrongInstallationKey)} />
          <Button label="Hold an earlier sample lookup" tone="quiet" onPress={() => {
            slowRef.current = true;
            setSlow(true);
            emit(slowKey);
          }} />
          {slow ? <>
            <Button label="Tap newer sample while lookup is held" tone="quiet" onPress={() => emit(newerKey)} />
            <Button label="Finish earlier sample lookup" tone="quiet" onPress={() => { releaseSlowRef.current?.(); releaseSlowRef.current = undefined; slowRef.current = false; setSlow(false); }} />
          </> : null}
          <Button label={sampleCaptureActive ? 'Finish sample capture' : 'Start sample capture blocker'} tone="quiet" onPress={() => {
            const next = !sampleCaptureActive;
            setSampleCaptureActive(next);
            coordinatorRef.current?.setReady(!next && !result);
            if (next) emit(blockedKey);
          }} />
          {pending && !sampleCaptureActive && !result ? <Button label="Return to safe review point" onPress={() => coordinatorRef.current?.setReady(true)} /> : null}
          <Button label="Dismiss sample message" tone="danger" onPress={() => setResult(null)} />
        </ScrollView>
      </View>
      <MailAlertTapReviewSheet
        visible={Boolean(result && result.kind !== 'ignored' && result.kind !== 'blocked')}
        result={result}
        previewOnly
        onClose={() => setResult(null)}
        onOpenInbox={() => setResult(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: 24, gap: 13, justifyContent: 'center' },
  pending: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 12, color: C.muted, padding: 12, lineHeight: 20 },
});
