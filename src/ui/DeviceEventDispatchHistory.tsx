import React, { useState } from "react";
import { Text, View } from "react-native";
import type { WorkspaceSnapshotDTO } from "../cloud/workspaceDto";
import type { DeviceEventReconciliation } from "../deviceCalendars/types";
import { Button, Field } from "./primitives";
import { C, s } from "./theme";

type Inspection = Readonly<{ lookup: Readonly<{
  candidates: readonly Readonly<{ title: string; start: string; timeZone?: string }>[];
  partial: boolean;
  identity: "unverified" | "native_id_match";
}> }>;
type DeviceEventHistoryDTO = WorkspaceSnapshotDTO["state"]["deviceCalendars"]["dispatchHistory"][number];
export type DeviceEventHistoryDisplay = Omit<DeviceEventHistoryDTO, "reconciliations"> & Readonly<{
  targetLabel: string;
  reconciliations: readonly (DeviceEventHistoryDTO["reconciliations"][number] & Readonly<{ nativeReferenceRecorded?: boolean }>)[];
}>;
type Props = {
  record: DeviceEventHistoryDisplay;
  busy: boolean;
  demoMode?: boolean;
  unavailableReason?: string;
  onInspect?: (recordId: string) => Promise<Inspection>;
  onReconcile?: (recordId: string, input: { disposition: DeviceEventReconciliation; note: string }) => Promise<unknown>;
};

function localTime(value: string, zone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "shortOffset",
    }).format(new Date(value));
  } catch { return `${value} · ${zone}`; }
}

export function DeviceEventDispatchHistory({ record, busy, demoMode = false, unavailableReason, onInspect, onReconcile }: Props) {
  const [inspection, setInspection] = useState<Inspection>();
  const [checkBusy, setCheckBusy] = useState(false);
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState<DeviceEventReconciliation>();
  const [error, setError] = useState("");
  const terminal = record.outcome !== "unknown";
  const check = async () => {
    if (!onInspect || checkBusy || busy) return;
    setCheckBusy(true); setError("");
    try { setInspection(await onInspect(record.id)); }
    catch (value) { setError(value instanceof Error ? value.message : "Calendar check failed."); }
    finally { setCheckBusy(false); }
  };
  const saveCheck = async () => {
    if (!onReconcile || !choice || !note.trim() || busy) return;
    setError("");
    try {
      await onReconcile(record.id, { disposition: choice, note: note.trim() });
      setChoice(undefined); setNote("");
    } catch (value) { setError(value instanceof Error ? value.message : "The calendar check could not be saved."); }
  };
  const status = record.outcome === "saved" ? (demoMode ? "Simulated save" : "Saved on this iPhone") : record.outcome === "unknown" ? "Outcome unknown" : record.outcome === "rejected" ? "Action stopped" : "In progress";
  return (
    <View style={styles.card}>
      <Text style={s.label}>{demoMode ? "SAMPLE DEVICE EVENT · SIMULATED" : "APPROVED DEVICE EVENT"}</Text>
      <Text style={styles.title}>{record.payload.title}</Text>
      <Text style={styles.meta}>{status} · {record.targetLabel}</Text>
      {demoMode ? <Text style={styles.meta}>No iPhone calendar was changed.</Text> : null}
      {record.outcomeAt ? <Text style={styles.meta}>Outcome recorded · {localTime(record.outcomeAt, record.payload.timeZone)}</Text> : null}
      <Text style={styles.meta}>{localTime(record.payload.start, record.payload.timeZone)} – {localTime(record.payload.end, record.payload.timeZone)}</Text>
      <Text style={styles.body}>{record.payload.notes || "No event notes."}</Text>
      {record.reconciliations.map((entry, index) => (
        <View key={`${entry.at}-${index}`} style={styles.attestation}>
          <Text style={styles.meta}>{entry.disposition === "confirmed_present" ? "You found the event" : entry.disposition === "not_found" ? "You could not find it" : "You stopped checking"} · {new Date(entry.at).toLocaleString()}</Text>
          {entry.note ? <Text style={styles.body}>{entry.note}</Text> : null}
          {entry.nativeReferenceRecorded ? <Text style={styles.meta}>Native event reference recorded</Text> : null}
        </View>
      ))}
      {record.outcome === "unknown" ? (
        <>
          <Text style={styles.meta}>Check Calendar on this iPhone before recording what you found. This does not create the event again.</Text>
          <Button label={checkBusy ? "Checking calendar…" : "Check this iPhone calendar"} tone="quiet" disabled={busy || checkBusy || !onInspect} onPress={() => void check()} />
          {!onInspect || !onReconcile ? <Text style={styles.meta}>{unavailableReason ?? "Calendar check actions are unavailable here. Review the saved event directly in Calendar."}</Text> : null}
          {inspection?.lookup ? (
            <View style={styles.attestation}>
              <Text style={styles.meta}>{inspection.lookup.candidates.length ? `${inspection.lookup.candidates.length} possible match${inspection.lookup.candidates.length === 1 ? "" : "es"}; review them in Calendar.` : inspection.lookup.partial ? "The check was incomplete; inspect Calendar manually." : "No possible match was found in the checked calendar."}</Text>
              <Text style={styles.meta}>{inspection.lookup.identity === "native_id_match" ? "The saved event reference matches. Review the event in Calendar before recording your check." : "Details only; these possible matches are unverified. Review them in Calendar before recording your check."}</Text>
              {inspection.lookup.candidates.slice(0, 5).map((event, index) => <Text key={`${event.start}-${index}`} style={styles.body}>{event.title} · {localTime(event.start, event.timeZone || record.payload.timeZone)}</Text>)}
            </View>
          ) : null}
          <View style={styles.choices}>
            {(["confirmed_present", "not_found", "abandoned"] as const).map((item) => {
              const label = item === "confirmed_present" ? "I found the event" : item === "not_found" ? "I could not find it" : "Stop checking";
              return <Button key={item} label={label} tone={choice === item ? "light" : "quiet"} disabled={busy || !onReconcile} onPress={() => setChoice(item)} />;
            })}
          </View>
          {choice && onReconcile ? <>
            <Field label="What did you check?" value={note} onChangeText={setNote} multiline placeholder="Add a short note" />
            <Text style={styles.meta}>This records your check. It does not resend the action or confirm delivery.</Text>
            <Button label="Save check result" disabled={busy || !note.trim()} onPress={() => void saveCheck()} />
          </> : null}
        </>
      ) : null}
      {terminal ? <Text style={styles.meta}>This approved record is read-only. A check does not change or repeat the event action.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = {
  card: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 16, padding: 14, gap: 10, marginTop: 10 },
  title: { color: C.text, fontSize: 16, fontWeight: "600" as const },
  meta: { color: C.muted, fontSize: 12, lineHeight: 17 },
  body: { color: C.text, fontSize: 14, lineHeight: 20 },
  attestation: { borderTopWidth: 1, borderTopColor: C.border, paddingTop: 10, gap: 6 },
  choices: { gap: 8 },
  error: { color: C.red, fontSize: 13 },
};
