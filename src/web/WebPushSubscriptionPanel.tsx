import React from 'react';
import { Text, View } from 'react-native';
import { Button } from '../ui/primitives';
import { C } from '../ui/theme';
import type { WebPushBrowserCoordinator, WebPushBrowserState } from './webPushBrowser';

export function WebPushSubscriptionPanel({ coordinator, state, blocked }: {
  coordinator: WebPushBrowserCoordinator; state: WebPushBrowserState; blocked: boolean;
}) {
  const disabled = blocked || state.busy || state.phase === 'loading';
  const message = state.message ?? (state.phase === 'loading' ? 'Checking this browser’s notification support and saved registration…' : undefined);
  const controls = () => {
    if (state.phase === 'unsupported') return null;
    if (state.phase === 'registration_unknown' || state.phase === 'disable_unknown' || state.pending) {
      return <Button label="Check exact notification receipt" tone="quiet" disabled={disabled} onPress={() => { void coordinator.inspectPending(); }} />;
    }
    if (state.phase === 'unprovisioned') return <Button label="Set up workspace notification key" disabled={disabled} onPress={() => { void coordinator.provision(); }} />;
    if (state.phase === 'unresolved_local') return <Button label="Clear this browser subscription locally" tone="danger" disabled={disabled} onPress={() => { void coordinator.clearLocalSubscription(); }} />;
    if (state.phase === 'local_cleanup_pending') return <Button label="Finish local notification cleanup" tone="danger" disabled={disabled} onPress={() => { void coordinator.clearLocalSubscription(); }} />;
    if (state.phase === 'unmatched_local') return <Button label="Disable saved device registration" tone="danger" disabled={disabled} onPress={() => { void coordinator.disable(); }} />;
    if (state.phase === 'server_active_local_missing') return <Button label="Disable saved device registration" tone="danger" disabled={disabled} onPress={() => { void coordinator.disable(); }} />;
    if (state.phase === 'enabled') return <Button label="Disable notifications on this device" tone="danger" disabled={disabled} onPress={() => { void coordinator.disable(); }} />;
    if (state.phase === 'error') return <Button label="Check notification status" tone="quiet" disabled={disabled} onPress={() => { void coordinator.start(); }} />;
    if (state.phase === 'disabled') {
      if (state.permission === 'denied') return <Button label="Check notification permission" tone="quiet" disabled={disabled} onPress={() => { void coordinator.start(); }} />;
      return <Button label="Enable notifications on this device" disabled={disabled} onPress={() => { void coordinator.enable(); }} />;
    }
    return null;
  };
  return <View style={styles.card}>
    <Text style={styles.title}>Browser notifications</Text>
    {message ? <Text accessibilityRole="alert" style={styles.meta}>{message}</Text> : null}
    {state.phase !== 'unsupported' ? <Text style={styles.meta}>Notifications use a generic reminder message. They stay enabled after sign out until you disable this device.</Text> : null}
    {state.phase === 'enabled' ? <Text style={styles.meta}>This browser is registered for generic reminders.</Text> : null}
    {state.busy ? <Text style={styles.busy}>Working…</Text> : null}
    <View style={styles.actions}>{controls()}</View>
  </View>;
}

const styles = {
  card: { gap: 8, padding: 14, marginBottom: 10, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  title: { color: C.text, fontSize: 15, fontWeight: '600' as const },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  busy: { color: C.sage, fontSize: 12 },
  actions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 7 },
};
