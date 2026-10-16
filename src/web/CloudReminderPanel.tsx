import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReminderPayload } from '../reminders';
import { resolveReminderLocalDateTime } from '../reminders/time';
import type { ReminderDisplayRecord } from '../ui/reminderDisplay';
import { Button, Field } from '../ui/primitives';
import { C, s } from '../ui/theme';
import type { WebPushBrowserState } from './webPushBrowser';
import type { CloudReminderCoordinator, CloudReminderState } from './cloudReminderCoordinator';

export function CloudReminderPanel({ records, webPush, coordinator, state, blocked }: {
  records: readonly ReminderDisplayRecord[];
  webPush?: WebPushBrowserState;
  coordinator?: CloudReminderCoordinator;
  state?: CloudReminderState;
  blocked: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [localDue, setLocalDue] = useState('');
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [fold, setFold] = useState<0 | 1>();
  const [localError, setLocalError] = useState<string>();
  const operationBusy = Boolean(state?.busy || blocked);
  const resolutions = useMemo(() => resolveReminderLocalDateTime(localDue, zone), [localDue, zone]);
  const selectedDue = resolutions.length === 1 ? resolutions[0] : resolutions.length === 2 && fold !== undefined ? resolutions[fold] : undefined;
  const exactDeviceReady = webPush?.phase === 'enabled' && Boolean(webPush.deviceId) && Number.isSafeInteger(webPush.generation);
  const allDevicesReady = webPush?.phase === 'enabled' && (webPush.subscriptionCount ?? 0) > 0;
  const safeRun = async (operation: () => Promise<unknown>) => {
    setLocalError(undefined);
    try { await operation(); }
    catch (error) { setLocalError(error instanceof Error ? error.message : 'The reminder action could not be confirmed.'); }
  };
  const createDraft = () => {
    if (!coordinator || !title.trim() || !selectedDue || Date.parse(selectedDue) <= Date.now()) {
      setLocalError('Enter a title and choose a future time that occurs once in this time zone.');
      return;
    }
    const payload: ReminderPayload = { title: title.trim(), body, dueAt: selectedDue, displayTimeZone: zone, privacyMode: 'private' };
    void safeRun(async () => {
      const response = await coordinator.createDraft(payload);
      if (response.status === 'finished') { setTitle(''); setBody(''); setLocalDue(''); setFold(undefined); setCreating(false); }
    });
  };
  const inspect = () => { if (coordinator) void safeRun(() => coordinator.inspectPending()); };

  return <View style={{ gap: 14, marginTop: 12 }}>
    <View style={{ backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 15, gap: 8 }}>
      <Text style={localStyles.title}>Server reminders</Text>
      <Text style={localStyles.meta}>A saved reminder uses a generic notification: “You have a reminder.” Opening Still shows the reminder details. Choose a device when you save.</Text>
      {!coordinator ? <Text style={localStyles.meta}>Reminder changes are unavailable in this workspace session.</Text> : null}
      {webPush?.phase !== 'enabled' ? <Text style={localStyles.meta}>Enable browser notifications in Settings before saving a server reminder.</Text> : null}
      {state?.pending ? <View style={{ gap: 8 }}>
        <Text accessibilityRole="alert" style={localStyles.meta}>{state.message ?? 'A reminder command needs its exact receipt checked.'}</Text>
        <Button label="Inspect pending reminder command" tone="quiet" disabled={operationBusy} onPress={inspect} />
      </View> : null}
      {state?.message && !state.pending ? <Text style={localStyles.meta}>{state.message}</Text> : null}
      {creating ? <View style={{ gap: 9 }}>
        <Field label="Reminder title" value={title} onChangeText={setTitle} placeholder="A short title" editable={!operationBusy} />
        <Field label="Reminder details" value={body} onChangeText={setBody} placeholder="What should Still remind you about?" multiline editable={!operationBusy} />
        <Field label="Local date and time · YYYY-MM-DDTHH:mm" value={localDue} onChangeText={(value) => { setLocalDue(value); setFold(undefined); }} placeholder="2026-10-20T09:30" editable={!operationBusy} />
        <Field label="IANA time zone" value={zone} onChangeText={(value) => { setZone(value); setFold(undefined); }} placeholder="Asia/Singapore" editable={!operationBusy} />
        {localDue && resolutions.length === 0 ? <Text style={localStyles.meta}>That local time does not exist in this time zone.</Text> : null}
        {resolutions.length === 2 ? <View style={{ gap: 8 }}>
          <Text style={localStyles.meta}>This clock time occurs twice. Choose the intended occurrence.</Text>
          <Button label={fold === 0 ? 'First occurrence · selected' : 'First occurrence'} tone={fold === 0 ? 'light' : 'quiet'} disabled={operationBusy} onPress={() => setFold(0)} />
          <Button label={fold === 1 ? 'Second occurrence · selected' : 'Second occurrence'} tone={fold === 1 ? 'light' : 'quiet'} disabled={operationBusy} onPress={() => setFold(1)} />
        </View> : null}
        <Text style={localStyles.meta}>Your reminder details stay in the workspace. Notifications contain no title or reminder text.</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label="Create draft" disabled={operationBusy || !title.trim() || !selectedDue} onPress={createDraft} />
          <Button label="Close" tone="quiet" disabled={operationBusy} onPress={() => setCreating(false)} />
        </View>
      </View> : <Button label="Create server reminder" disabled={operationBusy || !coordinator} onPress={() => { setCreating(true); setLocalError(undefined); }} />}
      {localError ? <Text accessibilityRole="alert" style={s.errorText}>{localError}</Text> : null}
    </View>
    {records.map((record) => {
      const busy = operationBusy || !coordinator;
      const exactSelection = exactDeviceReady && webPush?.deviceId && Number.isSafeInteger(webPush.generation)
        ? { subscriptions: [{ subscriptionId: webPush.deviceId, generation: webPush.generation! }] } as const : undefined;
      return <View key={record.id} style={{ backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 15, gap: 8 }}>
        <Text style={localStyles.title}>{record.title}</Text>
        <Text style={localStyles.meta}>{new Date(record.dueAt).toLocaleString([], { timeZone: record.displayTimeZone })} · {record.displayTimeZone}</Text>
        <Text style={localStyles.meta}>{record.status === 'draft' ? 'Draft · review before approval' : record.status === 'approved' ? 'Approved · choose devices to save' : record.status === 'saved' ? 'Saved for server delivery' : record.status === 'completed' ? 'Done' : 'Cancelled'}</Text>
        {record.status === 'draft' ? <Button label="Approve this reminder" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.approve(record.id, record.revision)); }} /> : null}
        {record.status === 'approved' ? <View style={{ gap: 8 }}>
          {exactSelection ? <Button label="Save on this device" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.save(record.id, record.revision, exactSelection)); }} /> : null}
          <Button label="All devices enabled when this reminder is due" tone="quiet"
            disabled={busy || !allDevicesReady} onPress={() => { if (coordinator) void safeRun(() => coordinator.save(record.id, record.revision, 'all_current')); }} />
          <Text style={localStyles.meta}>This choice is evaluated once when the reminder is due. “Save on this device” selects this browser’s current subscription generation.</Text>
          {!exactSelection && !allDevicesReady ? <Text style={localStyles.meta}>Enable at least one browser device in Settings to save this reminder.</Text> : null}
        </View> : null}
        {record.status === 'saved' ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button label="Mark done" tone="quiet" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.complete(record.id, record.revision)); }} />
          <Button label="Cancel reminder" tone="quiet" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.cancel(record.id, record.revision)); }} />
        </View> : null}
        {(record.status === 'cancelled' || record.status === 'completed') ? <Button label="Delete reminder" tone="danger" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.delete(record.id, record.revision)); }} /> : null}
      </View>;
    })}
  </View>;
}

const localStyles = {
  title: { color: C.text, fontSize: 16, fontWeight: '600' as const },
  meta: { color: C.muted, fontSize: 13, lineHeight: 19 },
};
