import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReminderPayload } from '../reminders';
import { resolveReminderLocalDateTime } from '../reminders/time';
import type { ReminderDisplayRecord } from '../ui/reminderDisplay';
import { Button, Field } from '../ui/primitives';
import { C, s } from '../ui/theme';
import type { WebPushBrowserState } from './webPushBrowser';
import type { CloudReminderCoordinator, CloudReminderState } from './cloudReminderCoordinator';

function localDateTimeFor(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
  } catch { return ''; }
}

function DateTimeLocalField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 6, color: C.text, fontSize: 13 }}>
    <span>Reminder date and time</span>
    {React.createElement('input', { type: 'datetime-local', value, disabled, 'aria-label': 'Reminder date and time',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value),
      style: { color: C.text, colorScheme: 'dark', background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
        padding: '10px 12px', font: 'inherit', fontSize: 16, minHeight: 44, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' } })}
  </label>;
}

type CloudReminderPanelProps = {
  records: readonly ReminderDisplayRecord[];
  webPush?: WebPushBrowserState;
  coordinator?: CloudReminderCoordinator;
  state?: CloudReminderState;
  blocked: boolean;
};

export function CloudReminderPanel(props: CloudReminderPanelProps) {
  const [ownerKey, setOwnerKey] = useState(() => ({ coordinator: props.coordinator, generation: 0 }));
  if (ownerKey.coordinator !== props.coordinator) {
    setOwnerKey({ coordinator: props.coordinator, generation: ownerKey.generation + 1 });
  }
  return <CloudReminderPanelSession key={ownerKey.generation} {...props} />;
}

function CloudReminderPanelSession({ records, webPush, coordinator, state, blocked }: CloudReminderPanelProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ReminderDisplayRecord>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [localDue, setLocalDue] = useState('');
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [showZoneField, setShowZoneField] = useState(false);
  const [fold, setFold] = useState<0 | 1>();
  const [preservedDue, setPreservedDue] = useState<{ localDue: string; zone: string; dueAt: string }>();
  const [deleteTarget, setDeleteTarget] = useState<ReminderDisplayRecord>();
  const [localError, setLocalError] = useState<string>();
  const formCommandId = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const activeCoordinator = useRef(coordinator);
  const formGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; formGeneration.current += 1; };
  }, []);
  const mutationDisabled = Boolean(state?.busy || state?.pending || blocked || !coordinator);
  const inspectDisabled = Boolean(state?.busy || blocked || !coordinator);
  const resolutions = useMemo(() => resolveReminderLocalDateTime(localDue, zone), [localDue, zone]);
  const selectedDue = preservedDue && preservedDue.localDue === localDue && preservedDue.zone === zone
    ? preservedDue.dueAt : resolutions.length === 1 ? resolutions[0] : resolutions.length === 2 && fold !== undefined ? resolutions[fold] : undefined;
  const exactDeviceReady = webPush?.phase === 'enabled' && Boolean(webPush.deviceId) && Number.isSafeInteger(webPush.generation);
  const allDevicesReady = webPush?.phase === 'enabled' && (webPush.subscriptionCount ?? 0) > 0;
  const isCurrent = (owner: CloudReminderCoordinator | undefined, generation: number) =>
    mounted.current && activeCoordinator.current === owner && formGeneration.current === generation;
  const safeRun = async (operation: (isStillCurrent: () => boolean) => Promise<unknown>, owner = coordinator) => {
    const generation = formGeneration.current;
    const isStillCurrent = () => isCurrent(owner, generation);
    if (!isStillCurrent()) return;
    setLocalError(undefined);
    try { await operation(isStillCurrent); }
    catch (error) {
      if (isStillCurrent()) setLocalError(error instanceof Error ? error.message : 'The reminder action could not be confirmed.');
    }
  };
  const openCreate = () => {
    formGeneration.current += 1;
    formCommandId.current = undefined;
    setEditing(undefined); setTitle(''); setBody(''); setLocalDue(''); setFold(undefined); setPreservedDue(undefined);
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); setShowZoneField(false); setFormOpen(true); setLocalError(undefined);
  };
  const openEdit = (record: ReminderDisplayRecord) => {
    formGeneration.current += 1;
    formCommandId.current = undefined;
    const originalLocal = localDateTimeFor(record.dueAt, record.displayTimeZone);
    const originalResolutions = resolveReminderLocalDateTime(originalLocal, record.displayTimeZone);
    const recordMinute = Math.floor(Date.parse(record.dueAt) / 60_000);
    const originalFold = originalResolutions.length === 2
      ? originalResolutions.findIndex((instant) => Math.floor(Date.parse(instant) / 60_000) === recordMinute) as 0 | 1
      : undefined;
    setEditing(record); setTitle(record.title); setBody(record.body); setZone(record.displayTimeZone);
    setLocalDue(originalLocal); setFold(originalFold); setPreservedDue({ localDue: originalLocal, zone: record.displayTimeZone, dueAt: record.dueAt });
    setShowZoneField(true); setFormOpen(true); setLocalError(undefined);
  };
  const closeForm = () => { formGeneration.current += 1; setFormOpen(false); setEditing(undefined); setPreservedDue(undefined); setLocalError(undefined); };
  const submitForm = () => {
    if (!coordinator || !title.trim() || !selectedDue || Date.parse(selectedDue) <= Date.now()) {
      setLocalError('Enter a title and choose a future time that occurs once in this time zone.');
      return;
    }
    const payload: ReminderPayload = { title: title.trim(), body, dueAt: selectedDue, displayTimeZone: zone, privacyMode: 'private' };
    const owner = coordinator;
    void safeRun(async (isStillCurrent) => {
      try {
        const response = editing
          ? await owner!.editDraft(editing.id, editing.revision, payload)
          : await owner!.createDraft(payload);
        if (!isStillCurrent()) return;
        if (response.status === 'finished') { formCommandId.current = undefined; closeForm(); }
        else formCommandId.current = response.commandId;
      } catch (error) {
        if (isStillCurrent()) {
          const pending = owner!.getSnapshot().pending;
          if (pending) formCommandId.current = pending.commandId;
        }
        throw error;
      }
    }, owner);
  };
  const inspect = () => { if (coordinator) {
    const owner = coordinator;
    void safeRun(async (isStillCurrent) => {
    const response = await owner.inspectPending();
    if (!isStillCurrent()) return;
    if (response?.status === 'finished' && response.commandId === formCommandId.current) {
      formCommandId.current = undefined;
      closeForm();
    }
    return response;
  }, owner); } };

  return <View style={{ gap: 14, marginTop: 12 }}>
    <View style={{ backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 15, gap: 8 }}>
      <Text style={localStyles.title}>Reminders</Text>
      <Text style={localStyles.meta}>A saved reminder uses a generic notification: “You have a reminder.” Opening Still shows the reminder details. Choose a device when you save.</Text>
      {!coordinator ? <Text style={localStyles.meta}>Reminder changes are unavailable in this workspace session.</Text> : null}
      {webPush?.phase !== 'enabled' ? <Text style={localStyles.meta}>Enable browser notifications in Settings before saving a server reminder.</Text> : null}
      {state?.pending ? <View style={{ gap: 8 }}>
        <Text accessibilityRole="alert" style={localStyles.meta}>{state.message ?? 'A reminder change needs its exact status checked.'}</Text>
        <Button label="Check status" tone="quiet" disabled={inspectDisabled} onPress={inspect} />
      </View> : null}
      {state?.message && !state.pending ? <Text style={localStyles.meta}>{state.message}</Text> : null}
      {formOpen ? <View style={{ gap: 9 }}>
        <Field label="Reminder title" value={title} onChangeText={setTitle} placeholder="A short title" editable={!mutationDisabled} />
        <Field label="Reminder details" value={body} onChangeText={setBody} placeholder="What should Still remind you about?" multiline editable={!mutationDisabled} />
        <DateTimeLocalField value={localDue} disabled={mutationDisabled} onChange={(value) => { setLocalDue(value); setFold(undefined); setPreservedDue(undefined); }} />
        <Text style={localStyles.meta}>Time zone: {zone}</Text>
        {showZoneField ? <Field label="Change time zone · IANA name" value={zone} onChangeText={(value) => { setZone(value); setFold(undefined); setPreservedDue(undefined); }} placeholder="Asia/Singapore" editable={!mutationDisabled} /> :
          <Button label="Change time zone" tone="quiet" disabled={mutationDisabled} onPress={() => setShowZoneField(true)} />}
        {localDue && resolutions.length === 0 ? <Text accessibilityRole="alert" style={localStyles.meta}>That local time does not exist in this time zone, or the time zone is invalid.</Text> : null}
        {resolutions.length === 2 ? <View style={{ gap: 8 }}>
          <Text style={localStyles.meta}>This clock time occurs twice. Choose the intended occurrence.</Text>
          <Button label={fold === 0 ? 'First occurrence · selected' : 'First occurrence'} tone={fold === 0 ? 'light' : 'quiet'} disabled={mutationDisabled} onPress={() => { setFold(0); setPreservedDue(undefined); }} />
          <Button label={fold === 1 ? 'Second occurrence · selected' : 'Second occurrence'} tone={fold === 1 ? 'light' : 'quiet'} disabled={mutationDisabled} onPress={() => { setFold(1); setPreservedDue(undefined); }} />
        </View> : null}
        {editing && editing.status !== 'draft' ? <Text style={localStyles.meta}>Saving changes returns this reminder to draft. Approve it and choose devices again to schedule notifications.</Text> : null}
        <Text style={localStyles.meta}>Your reminder details stay in the workspace. Notifications contain no title or reminder text.</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label={editing ? editing.status === 'draft' ? 'Save changes' : 'Save as draft' : 'Create draft'} disabled={mutationDisabled || !title.trim() || !selectedDue} onPress={submitForm} />
          <Button label="Close" tone="quiet" disabled={mutationDisabled} onPress={closeForm} />
        </View>
      </View> : <Button label="New reminder" disabled={mutationDisabled} onPress={openCreate} />}
      {localError ? <Text accessibilityRole="alert" style={s.errorText}>{localError}</Text> : null}
    </View>
    {records.map((record) => {
      const busy = mutationDisabled;
      const exactSelection = exactDeviceReady && webPush?.deviceId && Number.isSafeInteger(webPush.generation)
        ? { subscriptions: [{ subscriptionId: webPush.deviceId, generation: webPush.generation! }] } as const : undefined;
      const editable = record.status === 'draft' || record.status === 'approved' || record.status === 'saved';
      const cancellable = editable;
      const completable = record.status === 'approved' || record.status === 'saved';
      return <View key={record.id} style={{ backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 15, gap: 8 }}>
        <Text style={localStyles.title}>{record.title}</Text>
        <Text style={localStyles.meta}>{new Date(record.dueAt).toLocaleString([], { timeZone: record.displayTimeZone })} · {record.displayTimeZone}</Text>
        <Text style={localStyles.meta}>{record.status === 'draft' ? 'Draft · review before approval' : record.status === 'approved' ? 'Approved · choose devices to save' : record.status === 'saved' ? 'Saved' : record.status === 'completed' ? 'Done' : 'Cancelled'}</Text>
        {record.status === 'draft' ? <Button label="Approve this reminder" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.approve(record.id, record.revision)); }} /> : null}
        {editable ? <Button label="Edit reminder" tone="quiet" disabled={busy} onPress={() => openEdit(record)} /> : null}
        {record.status === 'approved' ? <View style={{ gap: 8 }}>
          {exactSelection ? <Button label="Save on this device" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.save(record.id, record.revision, exactSelection)); }} /> : null}
          <Button label="All devices enabled when this reminder is due" tone="quiet"
            disabled={busy || !allDevicesReady} onPress={() => { if (coordinator) void safeRun(() => coordinator.save(record.id, record.revision, 'all_current')); }} />
          <Text style={localStyles.meta}>This choice is evaluated once when the reminder is due. “Save on this device” selects this browser’s current subscription generation.</Text>
          {!exactSelection && !allDevicesReady ? <Text style={localStyles.meta}>Enable at least one browser device in Settings to save this reminder.</Text> : null}
        </View> : null}
        {completable ? <Button label="Mark done" tone="quiet" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.complete(record.id, record.revision)); }} /> : null}
        {cancellable ? <Button label="Cancel reminder" tone="quiet" disabled={busy} onPress={() => { if (coordinator) void safeRun(() => coordinator.cancel(record.id, record.revision)); }} /> : null}
        {deleteTarget?.id === record.id ? <View style={{ gap: 8 }}>
          {deleteTarget.revision === record.revision ? <Text accessibilityRole="alert" style={localStyles.meta}>Delete “{record.title}” permanently? This cannot be undone.</Text> :
            <Text accessibilityRole="alert" style={localStyles.meta}>This reminder changed after you opened the delete confirmation. Review the updated reminder before deleting it.</Text>}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {deleteTarget.revision === record.revision ? <Button label="Delete permanently" tone="danger" disabled={busy} onPress={() => {
              if (!coordinator || !deleteTarget) return;
              if (record.id !== deleteTarget.id || record.revision !== deleteTarget.revision) { setDeleteTarget(undefined); setLocalError('This reminder changed. Review it again before deleting.'); return; }
              const target = deleteTarget;
              const owner = coordinator;
              void safeRun(async (isStillCurrent) => {
                const response = await owner.delete(target.id, target.revision);
                if (isStillCurrent() && response.status === 'finished' && deleteTarget?.id === target.id && deleteTarget.revision === target.revision) setDeleteTarget(undefined);
              }, owner);
            }} /> : <Button label="Review deletion" tone="danger" disabled={busy} onPress={() => setDeleteTarget(record)} />}
            <Button label="Keep reminder" tone="quiet" disabled={busy} onPress={() => setDeleteTarget(undefined)} />
          </View>
        </View> : <Button label="Delete reminder" tone="danger" disabled={busy} onPress={() => setDeleteTarget(record)} />}
      </View>;
    })}
  </View>;
}

const localStyles = {
  title: { color: C.text, fontSize: 16, fontWeight: '600' as const },
  meta: { color: C.muted, fontSize: 13, lineHeight: 19 },
};
