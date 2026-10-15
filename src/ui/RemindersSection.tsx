import React from "react";
import { Text, View } from "react-native";
import { Button } from "./primitives";
import { C, s } from "./theme";
import type { ReminderAlertChannel, ReminderAlertDisplay, ReminderDisplayRecord } from "./reminderDisplay";
import type { WorkspaceActionCapability } from "./workspaceCapabilities";

type ReminderActions = Readonly<{
  create: () => void;
  open: (id: string, expectedRevision: number) => void;
  retry: (id: string, expectedRevision: number) => Promise<unknown>;
  done: (id: string, expectedRevision: number) => Promise<unknown>;
  cancel: (id: string, expectedRevision: number) => Promise<unknown>;
  delete: (id: string, expectedRevision: number) => Promise<unknown>;
}>;

type Props = {
  records: readonly ReminderDisplayRecord[];
  alertDisplays: Readonly<Record<string, ReminderAlertDisplay>>;
  query: string;
  busy: boolean;
  alertChannel: ReminderAlertChannel;
  demoMode: boolean;
  actions: WorkspaceActionCapability<ReminderActions>;
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
        <Button label="Add reminder" tone="quiet" icon="add" disabled={props.busy || !props.actions.available} onPress={() => { if (props.actions.available) props.actions.action.create(); }} />
      </View>
      {!props.actions.available ? <Text style={localStyles.meta}>{props.actions.reason}</Text> : null}
      {props.alertChannel === "browser_unavailable" && !props.demoMode ? <Text style={localStyles.meta}>{props.actions.available
        ? "Browser alerts are unavailable. You can still save and manage reminders here."
        : "Browser alerts are unavailable. Saved reminders remain visible; management actions are unavailable here."}</Text> : null}
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
              <Button label={record.status === "saved" || record.status === "completed" || record.status === "cancelled" ? "View reminder" : "Review reminder"} tone="quiet" disabled={props.busy || !props.actions.available} onPress={() => { if (props.actions.available) props.actions.action.open(record.id, record.revision); }} />
              {record.status === "saved" && alert?.canRetry ? <Button label="Retry alert" tone="quiet" disabled={props.busy || !props.actions.available} onPress={() => { if (props.actions.available) void props.actions.action.retry(record.id, record.revision); }} /> : null}
              {record.status === "saved" ? <Button label="Done" tone="quiet" disabled={props.busy || !props.actions.available} onPress={() => { if (props.actions.available) void props.actions.action.done(record.id, record.revision); }} /> : null}
              {canCancel ? <Button label="Cancel reminder" tone="quiet" disabled={props.busy || !props.actions.available} onPress={() => { if (props.actions.available) void props.actions.action.cancel(record.id, record.revision); }} /> : null}
              {canDelete ? <Button label="Delete reminder" tone="danger" disabled={props.busy || !props.actions.available} onPress={() => { if (props.actions.available) void props.actions.action.delete(record.id, record.revision); }} /> : null}
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
