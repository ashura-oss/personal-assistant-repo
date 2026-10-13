import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { BackgroundTaskBackend, BackgroundTaskStatus } from '../background/backend.types';
import { Button } from '../ui/primitives';
import { C, s } from '../ui/theme';

export type BackgroundRefreshActionResult = { status?: BackgroundTaskStatus; error?: 'refresh' | 'preference' | 'registration' };

type Props = {
  open: boolean;
  desiredEnabled: boolean;
  backend?: BackgroundTaskBackend;
  busy: boolean;
  sampleMode?: boolean;
  refreshKey?: number;
  blockedReason?: string;
  onSetDesired: (enabled: boolean) => Promise<BackgroundRefreshActionResult | undefined>;
  onRetry: () => Promise<BackgroundRefreshActionResult | undefined>;
};

const panel = { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 } as const;
const title = { color: C.text, fontSize: 16, fontWeight: '700' as const };
const body = { color: C.muted, fontSize: 13, lineHeight: 19 };

export function BackgroundRefreshSection({
  open, desiredEnabled, backend, busy, sampleMode = false, refreshKey = 0, blockedReason, onSetDesired, onRetry,
}: Props) {
  const [status, setStatus] = useState<BackgroundTaskStatus>();
  const [statusCheckedKey, setStatusCheckedKey] = useState<number>();
  const [actionBusy, setActionBusy] = useState(false);
  const [statusError, setStatusError] = useState<{ key: number; message: string }>();
  const error = statusError?.key === refreshKey ? statusError.message : '';
  const checking = open && Boolean(backend) && statusCheckedKey !== refreshKey && !error;

  useEffect(() => {
    if (!open || !backend) return;
    let active = true;
    void backend.getStatus().then((next) => {
      if (active) { setStatus(next); setStatusError(undefined); setStatusCheckedKey(refreshKey); }
    }).catch(() => {
      if (active) {
        setStatus(undefined);
        setStatusError({ key: refreshKey, message: 'Background task status could not be checked. Retry to check the saved setting.' });
      }
    });
    return () => { active = false; };
  }, [backend, open, refreshKey]);

  const perform = async (action: () => Promise<BackgroundRefreshActionResult | undefined>) => {
    setActionBusy(true);
    setStatusError(undefined);
    try {
      const result = await action();
      if (!result) {
        setStatus(undefined);
        setStatusError({ key: refreshKey, message: 'The saved preference could not be confirmed. Retry to check the current setting.' });
        return;
      }
      setStatus(result.status);
      if (result.error === 'refresh') setStatusError({ key: refreshKey, message: 'Local data could not be refreshed, so the background task was not changed. Retry when other work has finished.' });
      else if (result.error === 'preference') setStatusError({ key: refreshKey, message: 'The background refresh preference could not be saved. Try again.' });
      else if (result.error === 'registration') setStatusError({ key: refreshKey, message: 'The preference is saved, but task registration could not be confirmed. Retry to reconcile it.' });
    } catch {
      setStatus(undefined);
      setStatusError({ key: refreshKey, message: 'Background refresh could not be updated. Retry to check the saved setting.' });
    } finally { setActionBusy(false); }
  };

  const unavailableMessage = !backend
    ? 'Background refresh is unavailable in this sample or app build. Use a custom iOS build to configure it.'
    : status?.state === 'unsupported'
      ? 'Background refresh is available only in a supported iOS app build.'
      : status?.state === 'restricted'
        ? 'Background refresh is restricted on this device or build.'
        : status?.state === 'unavailable'
          ? 'Background refresh is unavailable on this device or build.'
          : undefined;
  const statusUnavailable = status?.state === 'unavailable' || status?.state === 'unsupported';
  const mismatch = Boolean(backend && status && status.registered !== desiredEnabled);
  const retryLabel = desiredEnabled ? 'Retry enabling background refresh' : 'Retry disabling background refresh';

  return (
    <View style={panel}>
      {sampleMode ? <Text style={s.kicker}>SAMPLE · SIMULATED TASK STATUS</Text> : null}
      <Text style={title}>Background mail refresh</Text>
      <Text style={body}>iOS chooses when a background check runs; it may not run after force quit. Checks can pause while your phone is locked. You can check recent mail manually in Inbox.</Text>
      {blockedReason ? <Text style={body}>{blockedReason}</Text> : null}
      {checking ? <Text style={body}>Checking current task status…</Text> : null}
      {!checking && status ? (statusUnavailable ? (
        <Text style={body}>{desiredEnabled ? 'Enabled in Settings · device setup could not be checked.' : 'Off in Settings · device setup could not be checked.'}</Text>
      ) : (
        <Text style={body}>
          {desiredEnabled
            ? status.registered ? 'Enabled · task registered.' : 'Setup needed · enabled in Settings, but no task is registered.'
            : status.registered ? 'Off · a task is still registered.' : 'Off · no background task is registered.'}
        </Text>
      )) : null}
      {!checking && unavailableMessage ? <Text style={body}>{unavailableMessage}</Text> : null}
      <Button
        label={desiredEnabled ? 'Disable background refresh' : 'Enable background refresh'}
        tone={desiredEnabled ? 'quiet' : 'light'}
        disabled={busy || Boolean(blockedReason) || actionBusy || checking || !backend || (Boolean(unavailableMessage) && !desiredEnabled)}
        onPress={() => void perform(() => onSetDesired(!desiredEnabled))}
      />
      {mismatch || error ? (
        <Button label={actionBusy ? 'Checking task setup…' : retryLabel} tone="light" disabled={busy || Boolean(blockedReason) || actionBusy || checking || !backend} onPress={() => void perform(onRetry)} />
      ) : null}
      {error ? <Text accessibilityRole="alert" style={[body, { color: C.red }]}>{error}</Text> : null}
    </View>
  );
}
