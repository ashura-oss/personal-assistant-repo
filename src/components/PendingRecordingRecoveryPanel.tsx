import React from 'react';
import { Text, View } from 'react-native';
import type { PendingCaptureReceipt, PendingCaptureSafeStatus } from '../audio/pendingCaptureService.types';
import { Button } from '../ui/primitives';
import { C, s } from '../ui/theme';

type Props = {
  status: PendingCaptureSafeStatus | null;
  loading?: boolean;
  busy?: boolean;
  sampleMode?: boolean;
  error?: string;
  onRefresh: () => void;
  onInspect: (receipt: PendingCaptureReceipt) => void;
  onSave: (receipt: PendingCaptureReceipt) => void;
  onExport: (receipt: PendingCaptureReceipt) => void;
  onDiscard: (receipt?: PendingCaptureReceipt) => void;
  onRetryCleanup: () => void;
};

const card = { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 18, padding: 18, gap: 11 } as const;
const title = { color: C.text, fontSize: 17, fontWeight: '700' as const };
const body = { color: C.muted, fontSize: 14, lineHeight: 20 };

export function PendingRecordingRecoveryPanel({
  status, loading = false, busy = false, sampleMode = false, error, onRefresh, onInspect, onSave, onExport, onDiscard, onRetryCleanup,
}: Props) {
  if (!loading && status?.kind === 'empty') return null;
  const sampleLabel = sampleMode ? 'SAMPLE · NO FILE OR DEVICE ACCESS' : undefined;
  const button = (label: string, callback: () => void, tone: 'light' | 'quiet' | 'danger' = 'quiet') => (
    <Button key={label} label={label} tone={tone} onPress={callback} disabled={busy} />
  );
  return (
    <View style={card}>
      {sampleLabel ? <Text style={s.kicker}>{sampleLabel}</Text> : null}
      {loading || !status ? (
        <>
          <Text style={title}>Checking interrupted audio…</Text>
          <Text style={body}>Recording stays unavailable until its local status is checked.</Text>
        </>
      ) : status.kind === 'empty' ? null : status.kind === 'blocked' ? (
        <>
          <Text style={title}>{status.reason === 'cleanup_required' ? 'Audio cleanup needs a retry' : 'Recording status unavailable'}</Text>
          <Text style={body}>
            {status.reason === 'cleanup_required'
              ? 'Local audio cleanup must finish before another recording can be checked.'
              : status.reason === 'unsupported'
                ? 'Interrupted recording recovery is unavailable in this app build.'
                : 'The local recording status could not be read. No new recording will start until it is checked.'}
          </Text>
          {status.reason === 'cleanup_required'
          ? button(busy ? 'Retrying cleanup…' : 'Retry audio cleanup', onRetryCleanup, 'light')
            : button(busy ? 'Checking…' : 'Retry status check', onRefresh, 'light')}
        </>
      ) : status.replacementOverflow && status.phase === 'discarding' ? (
        <>
          <Text style={title}>Interrupted files need cleanup</Text>
          <Text style={body}>Some interrupted files could not be tracked. Use local-data cleanup in Settings to finish. Tracked files may still be discarded below.</Text>
          {status.canDiscard ? button(busy ? 'Discarding…' : 'Retry discard', () => onDiscard(status.receipt), 'danger') : null}
        </>
      ) : status.phase === 'discarding' ? (
        <>
          <Text style={title}>Discard incomplete</Text>
          <Text style={body}>The original recording is still being removed. Retry discard to finish.</Text>
          {status.canDiscard ? button(busy ? 'Discarding…' : 'Retry discard', () => onDiscard(status.receipt), 'danger') : null}
        </>
      ) : status.replacementOverflow ? (
        <>
          <Text style={title}>Interrupted files need cleanup</Text>
          <Text style={body}>Export the original, then use local-data cleanup in Settings to remove the remaining files.</Text>
          {status.canExport ? button('Export original recording', () => onExport(status.receipt)) : null}
          {status.canDiscard ? button('Discard recording', () => onDiscard(status.receipt), 'danger') : null}
        </>
      ) : status.inspection === 'not_checked' ? (
        <>
          <Text style={title}>Unfinished recording</Text>
          <Text style={body}>Inspect the local audio before deciding whether to save or discard it.</Text>
          {button(busy ? 'Inspecting…' : 'Inspect recording', () => onInspect(status.receipt), 'light')}
          {status.canExport ? button('Export original recording', () => onExport(status.receipt)) : null}
          {status.canDiscard ? button('Discard recording', () => onDiscard(status.receipt), 'danger') : null}
        </>
      ) : status.inspection === 'known' && status.durationSeconds !== undefined && status.durationSeconds > 600 ? (
        <>
          <Text style={title}>Recording exceeds 10 minutes</Text>
          <Text style={body}>This recording cannot be saved as a note. You can recheck it, export the original, or discard it.</Text>
          {button(busy ? 'Inspecting…' : 'Retry inspection', () => onInspect(status.receipt), 'light')}
          {status.canExport ? button('Export original recording', () => onExport(status.receipt)) : null}
          {status.canDiscard ? button('Discard recording', () => onDiscard(status.receipt), 'danger') : null}
        </>
      ) : status.inspection === 'known' && status.canSave && status.durationSeconds !== undefined ? (
        <>
          <Text style={title}>Recording ready to save</Text>
          <Text style={body}>Measured duration · {formatDuration(status.durationSeconds)}</Text>
          <Text style={body}>The audio is preserved on this device. Review it before saving.</Text>
          {button(busy ? 'Saving…' : 'Save recording', () => onSave(status.receipt), 'light')}
          {status.canExport ? button('Export original recording', () => onExport(status.receipt)) : null}
          {status.canDiscard ? button('Discard recording', () => onDiscard(status.receipt), 'danger') : null}
        </>
      ) : status.inspection === 'missing' ? (
        <>
          <Text style={title}>Recording unavailable</Text>
          <Text style={body}>The original audio could not be found. Retry inspection or discard its recovery record.</Text>
          {button(busy ? 'Inspecting…' : 'Retry inspection', () => onInspect(status.receipt), 'light')}
          {status.canDiscard ? button('Discard recovery record', () => onDiscard(status.receipt), 'danger') : null}
        </>
      ) : (
        <>
          <Text style={title}>Duration couldn’t be confirmed</Text>
          <Text style={body}>The original audio is preserved. Review its status before saving; its duration will not be guessed.</Text>
          {button(busy ? 'Inspecting…' : 'Retry inspection', () => onInspect(status.receipt), 'light')}
          {status.canExport ? button('Export original recording', () => onExport(status.receipt)) : null}
          {status.canDiscard ? button('Discard recording', () => onDiscard(status.receipt), 'danger') : null}
        </>
      )}
      {error ? <Text accessibilityRole="alert" style={[body, { color: C.red }]}>{error}</Text> : null}
    </View>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unavailable';
  const value = `${Number(seconds.toFixed(3))} seconds`;
  return value;
}
