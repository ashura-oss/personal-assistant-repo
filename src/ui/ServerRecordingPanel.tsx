import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { CloudVoiceCoordinatorState } from '../web/cloudVoiceCoordinator';
import type { CloudWorkspaceVoiceActions } from '../web/CloudWorkspaceSession';
import { Button } from './primitives';
import { C, s } from './theme';

export type ServerRecordingPresentation = Readonly<{
  voice: CloudVoiceCoordinatorState;
  actions: CloudWorkspaceVoiceActions;
  busy: boolean;
  captureError?: string;
  openNoteAvailable: boolean;
  onOpenNote: (noteId: string) => void;
  onError: (error: unknown) => void;
}>;

export function ServerRecordingPanel({ voice, actions, busy, captureError, openNoteAvailable, onOpenNote, onError }: ServerRecordingPresentation) {
  const operationLock = useRef(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const disabled = busy || operationBusy;
  const perform = (operation: () => unknown) => {
    if (operationLock.current) return;
    operationLock.current = true;
    setOperationBusy(true);
    try {
      void Promise.resolve(operation()).catch(onError).finally(() => { operationLock.current = false; setOperationBusy(false); });
    } catch (error) {
      operationLock.current = false;
      setOperationBusy(false);
      onError(error);
    }
  };
  const uploadId = voice.uploadId;
  const historyPage = voice.history;
  const body = (() => {
    switch (voice.phase) {
      case 'capture_recovery': return <>
        <Text style={s.kicker}>RECORDING RECOVERY</Text><Text style={styles.title}>This recording needs attention.</Text>
        <Text style={s.intro}>Retry Stop to resolve the current capture, or discard it before starting another.</Text>
        <View style={styles.row}>
          <Button label="Retry Stop and save" disabled={disabled} onPress={() => perform(() => actions.stopAndSave())} />
          <Button label="Discard recording" tone="danger" disabled={disabled} onPress={() => perform(() => actions.cancelCurrentRecording())} />
        </View>
      </>;
      case 'stopped': return <>
        <Text style={s.kicker}>RECORDING RECOVERY</Text><Text style={styles.title}>Recording stopped.</Text>
        <Text style={s.intro}>The temporary copy is held until the server confirms the save or you discard the local copy.</Text>
        <View style={styles.row}>
          {uploadId ? <Button label="Inspect exact upload" disabled={disabled} onPress={() => perform(() => actions.inspectUpload(uploadId))} />
            : <Button label="Continue saving this recording" disabled={disabled || !voice.localClipPresent} onPress={() => perform(() => actions.uploadStoppedClip())} />}
          {voice.localClipPresent ? <Button label="Discard local recording copy" tone="danger" disabled={disabled} onPress={() => perform(() => actions.discardLocalClip())} /> : null}
        </View>
      </>;
      case 'uploading': return <><Text style={s.kicker}>SAVING RECORDING</Text><Text style={styles.title}>Uploading the recording…</Text><Text style={s.intro}>The original upload will not be sent again automatically.</Text></>;
      case 'upload_unknown': return <>
        <Text style={s.kicker}>UPLOAD STATUS</Text><Text style={styles.title}>Check the original upload.</Text>
        <Text style={s.intro}>The result is uncertain. Inspect its exact receipt before continuing.</Text>
        {uploadId ? <Button label="Inspect exact upload" disabled={disabled} onPress={() => perform(() => actions.inspectUpload(uploadId))} /> : null}
        {voice.localClipPresent ? <Button label="Discard local recording copy" tone="danger" disabled={disabled} onPress={() => perform(() => actions.discardLocalClip())} /> : null}
      </>;
      case 'ready': return <>
        <Text style={s.kicker}>RECORDING READY</Text><Text style={styles.title}>Save this recording to notes?</Text>
        <Text style={s.intro}>Adding it creates a note. It does not start transcription or AI analysis.</Text>
        <View style={styles.row}><Button label="Save recording to notes" disabled={disabled} onPress={() => perform(() => actions.saveReady())} />
          {voice.localClipPresent ? <Button label="Discard local recording copy" tone="danger" disabled={disabled} onPress={() => perform(() => actions.discardLocalClip())} /> : null}</View>
      </>;
      case 'adopting': return <><Text style={s.kicker}>SAVING NOTE</Text><Text style={styles.title}>Adding the recording to notes…</Text></>;
      case 'adoption_unknown': return <>
        <Text style={s.kicker}>NOTE SAVE STATUS</Text><Text style={styles.title}>Check the original note save.</Text>
        <Text style={s.intro}>Inspect the exact command before taking another action.</Text>
        {voice.adoptionCommandId ? <Button label="Inspect exact note save" disabled={disabled} onPress={() => perform(() => actions.inspectAdoption(voice.adoptionCommandId))} /> : null}
        {voice.localClipPresent ? <Button label="Discard local recording copy" tone="danger" disabled={disabled} onPress={() => perform(() => actions.discardLocalClip())} /> : null}
      </>;
      case 'saved': return <>
        <Text style={s.kicker}>RECORDING SAVED</Text><Text style={styles.title}>Your recording is saved.</Text>
        <View style={styles.row}>
          {openNoteAvailable && voice.noteId ? <Button label="Open saved note" tone="quiet" onPress={() => onOpenNote(voice.noteId!)} /> : <Text style={styles.meta}>Refresh the workspace to load the saved note.</Text>}
          {voice.localClipPresent ? <Button label="Discard local recording copy" tone="danger" disabled={disabled} onPress={() => perform(() => actions.discardLocalClip())} /> : null}
          <Button label="Record another" disabled={disabled || voice.localClipPresent} onPress={() => perform(() => actions.resetAfterSave())} />
        </View>
      </>;
      case 'idle': case 'recording': case 'paused': return null;
    }
  })();

  return <View style={styles.panel}>
    {body}
    {captureError ? <Text accessibilityRole="alert" style={styles.error}>{captureError}</Text> : null}
    {voice.error ? <Text accessibilityRole="alert" style={styles.error}>{voice.error}</Text> : null}
    <View style={styles.history}>
      <Button label={historyPage ? 'Refresh recording history' : 'View saved recording history'} tone="quiet" disabled={disabled} onPress={() => perform(() => actions.listHistory())} />
      {historyPage ? <View style={styles.historyRows}>
        <Text style={s.sectionTitle}>Saved recording history</Text>
        {historyPage.entries.length ? historyPage.entries.map((entry) => <View key={entry.uploadId} style={styles.historyEntry}>
          <Text style={styles.meta}>{entry.status} · {new Date(entry.capture.capturedAt).toLocaleString(undefined, { timeZone: entry.capture.timeZone })} · {entry.capture.timeZone}</Text>
          <Button label="Inspect this saved recording" tone="quiet" disabled={disabled || (voice.phase !== 'idle' && entry.uploadId !== voice.uploadId)} onPress={() => perform(() => actions.inspectUpload(entry.uploadId))} />
        </View>) : <Text style={styles.meta}>No saved recordings were found.</Text>}
        {historyPage.nextCursor ? <Button label="Load next history page" tone="quiet" disabled={disabled} onPress={() => perform(() => actions.listHistory(historyPage.nextCursor))} /> : null}
      </View> : null}
    </View>
  </View>;
}

const styles = {
  panel: { gap: 10, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, marginBottom: 14 },
  row: { gap: 8, flexWrap: 'wrap' as const },
  title: { color: C.text, fontSize: 18, fontWeight: '600' as const },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  error: { color: C.red, fontSize: 12, lineHeight: 18 },
  history: { gap: 8 },
  historyRows: { gap: 8, paddingTop: 8 },
  historyEntry: { gap: 5, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
};
