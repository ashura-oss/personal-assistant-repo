import React from "react";
import { Text, View } from "react-native";
import type { ReminderIntent, ReminderRecord } from "../reminders";
import { Button } from "./primitives";
import { C, s } from "./theme";

type Props = {
  records: ReminderRecord[];
  intents: ReminderIntent[];
  query: string;
  busy: boolean;
  isWeb: boolean;
  demoMode: boolean;
  onAdd: () => void;
  onOpen: (record: ReminderRecord) => void;
  onRetry: (record: ReminderRecord) => void;
  onDone: (record: ReminderRecord) => void;
  onCancel: (record: ReminderRecord) => void;
  onDelete: (record: ReminderRecord) => void;
};

const statusLabel: Record<ReminderRecord["status"], string> = {
  draft: "Draft",
  approved: "Approved · not saved",
  saved: "Saved reminder",
  cancelled: "Cancelled",
  completed: "Done",
};

function alertStatus(record: ReminderRecord, intents: ReminderIntent[], isWeb: boolean, demoMode: boolean) {
  const intent = intents.find((item) => item.id === record.currentIntentId);
  if (demoMode && record.status === "saved") return intent?.observed === "pending" ? "Sample alert · simulated" : "Sample alert · not scheduled";
  if (record.status !== "saved") {
    const cancellations = intents.filter((item) => item.reminderId === record.id && item.desired === "cancelled");
    if (cancellations.length) {
      if (cancellations.every((item) => item.observed === "absent")) return "Alert cancellation confirmed.";
      if (cancellations.some((item) => item.observed === "error" || item.observed === "unavailable")) return "Alert cancellation could not be confirmed.";
      return "Alert cancellation is still being checked.";
    }
    return undefined;
  }
  if (isWeb) return "Device alerts are unavailable in the browser.";
  if (!intent) return "Alert status could not be confirmed.";
  if (intent.observed === "pending") return "Device alert request is pending.";
  if (intent.observed === "blocked" || intent.observed === "unavailable") return "Device alerts are unavailable. The reminder is still saved here.";
  if (intent.observed === "error") return "The alert could not be scheduled.";
  if (intent.observed === "delivery_unknown") return "Alert outcome needs checking.";
  return "Alert status could not be confirmed.";
}

function canRetryAlert(record: ReminderRecord, intents: ReminderIntent[], demoMode: boolean) {
  if (record.status !== "saved") return false;
  const intent = intents.find((item) => item.id === record.currentIntentId);
  return Boolean(intent && (demoMode || ["absent", "blocked", "unavailable", "delivery_unknown", "error"].includes(intent.observed)));
}

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
      {props.isWeb && !props.demoMode ? <Text style={localStyles.meta}>Browser alerts are unavailable. You can still save and manage reminders here.</Text> : null}
      {props.demoMode ? <Text style={localStyles.meta}>Sample alerts are simulated in this isolated preview.</Text> : null}
      {records.length ? records.map((record) => {
        const alert = alertStatus(record, props.intents, props.isWeb, props.demoMode);
        const canCancel = record.status === "saved" || record.status === "approved" || record.status === "draft";
        const canDelete = record.status === "completed" || record.status === "cancelled";
        return (
          <View key={record.id} style={{ backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 15, gap: 9 }}>
            <Text style={localStyles.cardTitle}>{record.title}</Text>
            <Text style={localStyles.meta}>{new Date(record.dueAt).toLocaleString([], { timeZone: record.displayTimeZone })} · {record.displayTimeZone}</Text>
            <Text style={localStyles.meta}>{statusLabel[record.status]}</Text>
            {alert ? <Text style={localStyles.meta}>{alert}</Text> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button label={record.status === "saved" || record.status === "completed" || record.status === "cancelled" ? "View reminder" : "Review reminder"} tone="quiet" disabled={props.busy} onPress={() => props.onOpen(record)} />
              {record.status === "saved" && canRetryAlert(record, props.intents, props.demoMode) ? <Button label="Retry alert" tone="quiet" disabled={props.busy} onPress={() => props.onRetry(record)} /> : null}
              {record.status === "saved" ? <Button label="Done" tone="quiet" disabled={props.busy} onPress={() => props.onDone(record)} /> : null}
              {canCancel ? <Button label="Cancel reminder" tone="quiet" disabled={props.busy} onPress={() => props.onCancel(record)} /> : null}
              {canDelete ? <Button label="Delete reminder" tone="danger" disabled={props.busy} onPress={() => props.onDelete(record)} /> : null}
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
