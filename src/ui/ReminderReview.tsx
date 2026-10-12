import React, { useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, Text, View } from "react-native";
import type { ReminderPayload, ReminderRecord } from "../reminders";
import { resolveReminderLocalDateTime } from "../reminders/time";
import { Button, Field, IconButton } from "./primitives";
import { C, s } from "./theme";

type Props = {
  visible: boolean;
  record: ReminderRecord;
  busy: boolean;
  isWeb: boolean;
  demoMode: boolean;
  sourceAccountLabel?: string;
  alertStatus?: string;
  canRetry?: boolean;
  onClose: () => void;
  onUpdate: (id: string, payload: ReminderPayload, expectedRevision: number) => Promise<ReminderRecord | undefined>;
  onRefreshSource: (record: ReminderRecord) => Promise<ReminderRecord | undefined>;
  onApprove: (record: ReminderRecord) => Promise<ReminderRecord | undefined>;
  onSave: (record: ReminderRecord) => Promise<ReminderRecord | undefined>;
  onRetry?: (record: ReminderRecord) => Promise<ReminderRecord | undefined>;
  onDone?: (record: ReminderRecord) => Promise<ReminderRecord | undefined>;
  onCancel?: (record: ReminderRecord) => Promise<ReminderRecord | undefined>;
  error?: string;
};

function localParts(iso: string, zone: string) {
  try {
    const values = new Map(new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
    return { date: `${values.get("year")}-${values.get("month")}-${values.get("day")}`, time: `${values.get("hour")}:${values.get("minute")}` };
  } catch { return { date: "", time: "" }; }
}

function explicitLocalInstant(iso: string, zone: string) {
  try {
    const local = new Intl.DateTimeFormat(undefined, {
      timeZone: zone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset",
    }).format(new Date(iso));
    return `${local} (${new Date(iso).toISOString()} UTC)`;
  } catch {
    return `${new Date(iso).toISOString()} · ${zone}`;
  }
}

function originCopy(record: ReminderRecord) {
  if (record.origin.kind === "manual") return { heading: "Manual reminder", quote: "You created this reminder directly." };
  if (record.origin.kind === "note") return { heading: "Saved note", quote: record.origin.quote };
  const source = record.origin.source;
  const heading = source.kind === "mail" ? source.subject || "Saved message" : source.kind === "meeting" ? source.subject || "Calendar event" : source.title || "Local task";
  const sourceName = source.namespace === "local" || source.kind === "task" ? "Local source" : `${source.namespace} account`;
  const quoteLabel = record.origin.candidate.quoteField.replaceAll("_", " ");
  return { heading: `${record.origin.rule.name} · ${heading}`, quote: record.origin.candidate.quote, sourceName, quoteLabel, capturedAt: record.origin.capturedAt };
}

export function ReminderReview(props: Props) {
  const [record, setRecord] = useState(props.record);
  const baseline = localParts(record.dueAt, record.displayTimeZone);
  const [title, setTitle] = useState(props.record.title);
  const [body, setBody] = useState(props.record.body);
  const [date, setDate] = useState(() => localParts(props.record.dueAt, props.record.displayTimeZone).date);
  const [time, setTime] = useState(() => localParts(props.record.dueAt, props.record.displayTimeZone).time);
  const [zone, setZone] = useState(props.record.displayTimeZone);
  const [privacy, setPrivacy] = useState(props.record.privacyMode);
  const [foldChoice, setFoldChoice] = useState<0 | 1 | undefined>();
  const [localError, setLocalError] = useState("");
  const source = originCopy(record);
  const resolutions = useMemo(() => resolveReminderLocalDateTime(`${date}T${time}`, zone), [date, time, zone]);
  const wallTimeChanged = date !== baseline.date || time !== baseline.time || zone !== record.displayTimeZone;
  const dirty = title !== record.title || body !== record.body || wallTimeChanged || privacy !== record.privacyMode;
  const dueAt = !wallTimeChanged ? record.dueAt : resolutions.length === 1 ? resolutions[0] : resolutions.length === 2 && foldChoice !== undefined ? resolutions[foldChoice] : undefined;
  const terminal = record.status === "completed" || record.status === "cancelled";
  const editable = !terminal;

  const payload: ReminderPayload = { title: title.trim(), body, dueAt: dueAt ?? record.dueAt, displayTimeZone: zone.trim(), privacyMode: privacy };
  const saveChanges = async () => {
    setLocalError("");
    if (!dueAt) { setLocalError(resolutions.length === 0 ? "That local time does not exist in this time zone. Choose another time." : "Choose which occurrence you mean for this repeated clock time."); return; }
    const saved = await props.onUpdate(record.id, payload, record.revision);
    if (saved) {
      setRecord(saved);
      const normalized = localParts(saved.dueAt, saved.displayTimeZone);
      setTitle(saved.title); setBody(saved.body); setDate(normalized.date); setTime(normalized.time);
      setZone(saved.displayTimeZone); setPrivacy(saved.privacyMode); setFoldChoice(undefined); setLocalError("");
    }
    else setLocalError("Changes were not saved. Check the message above and try again.");
  };
  const runAction = async (action: (record: ReminderRecord) => Promise<ReminderRecord | undefined>) => {
    setLocalError("");
    const updated = await action(record);
    if (updated) setRecord(updated);
    else setLocalError("The reminder changed before this action completed. Reopen it and try again.");
  };
  const canApprove = record.status === "draft" && !dirty && Boolean(dueAt);
  const canSave = record.status === "approved" && !dirty;
  const canEditSaved = record.status === "saved";

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={[s.scroll, { paddingTop: 12 }]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={s.modalHeader}>
            <IconButton name="chevron-back" label="Close reminder" onPress={props.onClose} />
            <Text style={s.modalTitle}>{terminal ? "Reminder details" : "Review reminder"}</Text>
            <View style={{ width: 46 }} />
          </View>
          <Text style={s.kicker}>LOCAL REMINDER</Text>
          <Text style={s.h1Small}>{record.status === "draft" || record.status === "approved" ? "Choose when it should reach you." : record.status === "saved" ? "Your reminder." : "Reminder details."}</Text>
          <View style={{ backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14, gap: 7 }}>
            <Text style={s.label}>SOURCE</Text>
            <Text style={localStyles.cardTitle}>{source.heading}</Text>
            {record.origin.kind === "proactive" ? <Text style={localStyles.meta}>{props.sourceAccountLabel ?? source.sourceName} · {source.quoteLabel} · captured {new Date(record.origin.capturedAt).toLocaleString()}</Text> : null}
            <Text style={localStyles.meta}>{source.quote}</Text>
            {record.origin.kind === "proactive" ? <Text style={localStyles.meta}>This source was checked when the reminder was created. A saved reminder stays yours if it later changes.</Text> : null}
            {record.origin.kind === "note" ? <Text style={localStyles.meta}>Saved note evidence</Text> : null}
          </View>

          <Text style={localStyles.meta}>Reminder time: {explicitLocalInstant(record.dueAt, record.displayTimeZone)} · {record.displayTimeZone}</Text>
          <Field label="Reminder title" value={title} onChangeText={setTitle} placeholder="A short title" editable={editable} />
          <Field label="Reminder details" value={body} onChangeText={setBody} multiline placeholder="What should Still remind you about?" editable={editable} />
          <Field label="Date · YYYY-MM-DD" value={date} onChangeText={(value) => { setDate(value); setFoldChoice(undefined); }} placeholder="2026-10-14" editable={editable} />
          <Field label="Time · HH:mm" value={time} onChangeText={(value) => { setTime(value); setFoldChoice(undefined); }} placeholder="09:30" editable={editable} />
          <Field label="IANA time zone" value={zone} onChangeText={(value) => { setZone(value); setFoldChoice(undefined); }} placeholder="Asia/Singapore" editable={editable} />
          {resolutions.length === 0 ? <Text style={s.errorText}>This local time is invalid or falls in a daylight-saving gap.</Text> : null}
          {wallTimeChanged && resolutions.length === 2 ? <View style={{ gap: 8 }}>
            <Text style={localStyles.meta}>This clock time happens twice. Choose the occurrence you intend.</Text>
            <Button label={foldChoice === 0 ? "First occurrence · selected" : "First occurrence"} tone={foldChoice === 0 ? "light" : "quiet"} disabled={!editable} onPress={() => setFoldChoice(0)} />
            <Text style={localStyles.meta}>{explicitLocalInstant(resolutions[0]!, zone)}</Text>
            <Button label={foldChoice === 1 ? "Second occurrence · selected" : "Second occurrence"} tone={foldChoice === 1 ? "light" : "quiet"} disabled={!editable} onPress={() => setFoldChoice(1)} />
            <Text style={localStyles.meta}>{explicitLocalInstant(resolutions[1]!, zone)}</Text>
          </View> : null}
          <Text style={s.label}>NOTIFICATION PREVIEW</Text>
          <View style={{ backgroundColor: C.card, borderRadius: 16, padding: 14, gap: 4 }}>
            <Text style={localStyles.cardTitle}>{privacy === "private" ? "Still reminder" : title || "Reminder"}</Text>
            {privacy === "private" ? <Text style={localStyles.meta}>Open Still to view</Text> : body ? <Text style={localStyles.meta}>{body}</Text> : null}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button label="Private preview" tone={privacy === "private" ? "light" : "quiet"} disabled={!editable} onPress={() => setPrivacy("private")} />
            <Button label="Show reminder text" tone={privacy === "full" ? "light" : "quiet"} disabled={!editable} onPress={() => setPrivacy("full")} />
          </View>
          {dirty && editable ? <Button label={canEditSaved ? "Save edits for approval" : "Save changes"} disabled={props.busy || !dueAt || !title.trim()} onPress={() => void saveChanges()} /> : null}
          {record.status === "draft" ? <Button label="Approve reminder" disabled={props.busy || !canApprove || !title.trim()} onPress={() => void runAction(props.onApprove)} /> : null}
          {record.status === "approved" ? <Button label="Save reminder" disabled={props.busy || !canSave} onPress={() => void runAction(props.onSave)} /> : null}
          {record.status === "saved" && props.onRetry && props.canRetry ? <Button label="Retry device alert" tone="quiet" disabled={props.busy} onPress={() => void runAction(props.onRetry!)} /> : null}
          {record.status === "saved" && props.onDone ? <Button label="Mark done" tone="quiet" disabled={props.busy} onPress={() => void runAction(props.onDone!)} /> : null}
          {record.status === "saved" && props.onCancel ? <Button label="Cancel reminder" tone="quiet" disabled={props.busy} onPress={() => void runAction(props.onCancel!)} /> : null}
          {record.origin.kind === "proactive" && (record.status === "draft" || record.status === "approved") && props.onRefreshSource ? <Button label="Refresh saved source" tone="quiet" disabled={props.busy} onPress={() => void runAction(props.onRefreshSource)} /> : null}
          {props.alertStatus ? <Text style={localStyles.meta}>{props.alertStatus}</Text> : null}
          {props.isWeb && record.status === "saved" ? <Text style={localStyles.meta}>Browser notifications are unavailable; the reminder remains saved in this library.</Text> : null}
          {localError ? <Text accessibilityRole="alert" style={s.errorText}>{localError}</Text> : null}
          {props.error ? <Text accessibilityRole="alert" style={s.errorText}>{props.error}</Text> : null}
          <Text style={localStyles.meta}>Approval and saving are separate. Saving requests a local device alert where supported; it does not guarantee delivery.</Text>
          <Button label="Close" tone="quiet" onPress={props.onClose} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const localStyles = {
  cardTitle: { color: C.text, fontSize: 15, fontWeight: "600" as const },
  meta: { color: C.muted, fontSize: 13, lineHeight: 19 },
};
