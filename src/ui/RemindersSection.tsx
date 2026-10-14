import React from "react";
import { Text, View } from "react-native";
import { Button } from "./primitives";
import { C, s } from "./theme";
import type { ReminderAlertChannel, ReminderAlertDisplay, ReminderDisplayRecord } from "./reminderDisplay";

type Props = {
  records: readonly ReminderDisplayRecord[];
  alertDisplays: Readonly<Record<string, ReminderAlertDisplay>>;
  query: string;
  busy: boolean;
  alertChannel: ReminderAlertChannel;
  demoMode: boolean;
  onAdd: () => void;
  onOpen: (id: string, expectedRevision: number) => void;
  onRetry: (id: string, expectedRevision: number) => void;
  onDone: (id: string, expectedRevision: number) => void;
  onCancel: (id: string, expectedRevision: number) => void;
  onDelete: (id: string, expectedRevision: number) => void;
};

const statusLabel: Record<ReminderDisplayRecord["status"], string> = {
  draft: "Draft",
  approved: "Approved · not saved",
  saved: "Saved reminder",
  cancelled: "Cancelled",
  completed: "Done",
};

export function RemindersSection(props: Props) {
  const normalizedQuery = props.query.trim().toLocaleLowerCase();
  const records = [...props.records]
    .filter((record) => {
      if (!normalizedQuery) return true;
      const source = record.origin.kind === "proactive"
        ? [record.origin.rule.name, record.origin.candidate.quote,
          record.origin.source.kind === "task" ? record.origin.source.title : record.origin.source.subject,
          record.origin.source.kind === "mail" ? record.origin.source.senderEmail : undefined]
        : record.origin.kind === "note" ? [record.origin.quote] : ["manual reminder"];
      return [record.title, record.body, ...source].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedQuery);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <View style={{ gap: 14, marginTop: 12 }}>
      <View style={s.sectionHeader}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.sectionTitle}>Reminders</Text>
          <Text style={localStyles.meta}>Saved reminders stay yours even if their original source changes.</Text>
        </View>
        <Button label="Add reminder" tone="quiet" icon="add" disabled={props.busy} onPress={props.onAdd} />
      </View>
      {props.alertChannel === "browser_unavailable" && !props.demoMode ? <Text style={localStyles.meta}>Browser alerts are unavailable. You can still save and manage reminders here.</Text> : null}
      {props.demoMode ? <Text style={localStyles.meta}>Sample alerts are simulated in this isolated preview.</Text> : null}
      {records.length ? records.map((record) => {
        const alert = props.alertDisplays[record.id];
        const canCancel = record.status === "saved" || record.status === "approved" || record.status === "draft";
        const canDelete = record.status === "completed" || record.status === "cancelled";
        return (
          <View key={record.id} style={{ backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 15, gap: 9 }}>
            <Text style={localStyles.cardTitle}>{record.title}</Text>
            <Text style={localStyles.meta}>{new Date(record.dueAt).toLocaleString([], { timeZone: record.displayTimeZone })} · {record.displayTimeZone}</Text>
            <Text style={localStyles.meta}>{statusLabel[record.status]}</Text>
            {alert?.sectionStatus ? <Text style={localStyles.meta}>{alert.sectionStatus}</Text> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button label={record.status === "saved" || record.status === "completed" || record.status === "cancelled" ? "View reminder" : "Review reminder"} tone="quiet" disabled={props.busy} onPress={() => props.onOpen(record.id, record.revision)} />
              {record.status === "saved" && alert?.canRetry ? <Button label="Retry alert" tone="quiet" disabled={props.busy} onPress={() => props.onRetry(record.id, record.revision)} /> : null}
              {record.status === "saved" ? <Button label="Done" tone="quiet" disabled={props.busy} onPress={() => props.onDone(record.id, record.revision)} /> : null}
              {canCancel ? <Button label="Cancel reminder" tone="quiet" disabled={props.busy} onPress={() => props.onCancel(record.id, record.revision)} /> : null}
              {canDelete ? <Button label="Delete reminder" tone="danger" disabled={props.busy} onPress={() => props.onDelete(record.id, record.revision)} /> : null}
            </View>
          </View>
        );
      }) : <Text style={localStyles.meta}>{props.records.length && normalizedQuery ? "No matching reminders." : "No reminders yet. Add one when you want a local nudge."}</Text>}
    </View>
  );
}

const localStyles = {
  cardTitle: { color: C.text, fontSize: 16, fontWeight: "600" as const },
  meta: { color: C.muted, fontSize: 13, lineHeight: 19 },
};
