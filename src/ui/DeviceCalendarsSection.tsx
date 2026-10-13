import React from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { AppState } from "../core";
import type { DeviceCalendarState } from "../deviceCalendars/types";
import { Button } from "./primitives";
import { C, s } from "./theme";

type Props = {
  state: Pick<AppState, "deviceCalendars" | "deviceCalendarAccess" | "deviceCalendarRecoveryStatus">;
  busy: boolean;
  demoMode: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onCheckAccess: () => void;
  onSelection: (calendarIds: string[]) => void;
  onRefresh: (continueRunId?: string) => void;
};

function formattedTime(value: string, timeZone?: string, eventZoneUnavailable = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timeZone || undefined,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date) + (timeZone ? ` · ${timeZone}` : eventZoneUnavailable ? " · event time zone unavailable" : " · device time");
  } catch {
    return `${date.toISOString()} · time zone unavailable`;
  }
}

function runDescription(state: DeviceCalendarState) {
  const run = state.readRun;
  if (!run) return "No calendars checked yet.";
  const checked = run.completedCalendarIds.length;
  const total = run.selectedCalendarIds.length;
  const start = new Date(run.window.timeMin);
  const end = new Date(run.window.timeMax);
  const range = Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())
    ? ` · Checked range ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} UTC`
    : "";
  return `${run.partial ? "Scan incomplete" : "Calendar check complete"} · ${checked} of ${total} selected calendars${range} · ${formattedTime(run.startedAt)}`;
}

export function DeviceCalendarsSection({
  state,
  busy,
  demoMode,
  onConnect,
  onDisconnect,
  onCheckAccess,
  onSelection,
  onRefresh,
}: Props) {
  const calendars = state.deviceCalendars.calendars;
  const selected = state.deviceCalendars.selectedCalendarIds;
  const run = state.deviceCalendars.readRun;
  const runIsCurrent = Boolean(
    run &&
    run.generation === state.deviceCalendars.generation &&
    run.selectionRevision === state.deviceCalendars.selectionRevision,
  );
  const canContinue = Boolean(
    run?.partial && run.runId && run.cursor < run.selectedCalendarIds.length &&
    run.generation === state.deviceCalendars.generation &&
    run.selectionRevision === state.deviceCalendars.selectionRevision,
  );
  const connected = state.deviceCalendars.enabled;
  const access = state.deviceCalendarAccess.status;
  const canWrite = access === "full_access";
  const windowStart = runIsCurrent ? Date.parse(run!.window.timeMin) : Number.NaN;
  const windowEnd = runIsCurrent ? Date.parse(run!.window.timeMax) : Number.NaN;
  const eventsInCheckedWindow = runIsCurrent && Number.isFinite(windowStart) && Number.isFinite(windowEnd)
    ? state.deviceCalendars.events
        .filter((event) =>
          selected.includes(event.calendarId) &&
          run!.completedCalendarIds.includes(event.calendarId) &&
          event.generation === run!.generation &&
          Date.parse(event.observedAt) >= Date.parse(run!.startedAt) &&
          Date.parse(event.start) < windowEnd &&
          Date.parse(event.end) > windowStart &&
          !event.cancelled,
        )
        .sort((a, b) => a.start.localeCompare(b.start))
    : [];
  const eventSnapshotAt = eventsInCheckedWindow.reduce(
    (latest, event) => Math.max(latest, Date.parse(event.observedAt)),
    runIsCurrent ? Date.parse(run!.startedAt) : Number.NaN,
  );

  return (
    <View style={styles.container}>
      <Text style={s.sectionTitle}>On this iPhone calendars</Text>
      <Text style={styles.copy}>
        Device calendars are separate from Google and Microsoft. Reading and creating an event on this iPhone are separate choices.
      </Text>
      {Platform.OS === "web" && !demoMode ? (
        <Text style={styles.notice}>Device calendars are available in the iOS app, not in a browser.</Text>
      ) : null}
      {demoMode ? (
        <Text style={styles.notice}>Sample device calendar · simulated native access and events</Text>
      ) : null}
      {state.deviceCalendarRecoveryStatus ? (
        <Text style={styles.error}>{state.deviceCalendarRecoveryStatus.message}</Text>
      ) : null}
      <View style={styles.statusCard}>
        <Text style={styles.statusTitle}>
          {connected ? `Access · ${access.replaceAll("_", " ")}` : "Not connected"}
        </Text>
        <Text style={styles.copy}>
          {connected
            ? canWrite
              ? "Full access is available. Only selected, writable calendars can receive an approved event."
              : "Calendars may be read, but event creation needs full access."
            : "Still will not request access until you choose Connect."}
        </Text>
        {state.deviceCalendarAccess.checkedAt ? (
          <Text style={styles.meta}>Access checked · {formattedTime(state.deviceCalendarAccess.checkedAt)}</Text>
        ) : null}
      </View>
      {!connected ? (
        <Button label={demoMode ? "Connect sample calendars" : "Connect device calendars"} disabled={busy || (Platform.OS === "web" && !demoMode)} onPress={onConnect} />
      ) : (
        <View style={styles.actions}>
          <Button label="Check calendar access" tone="quiet" disabled={busy} onPress={onCheckAccess} />
          <Button label="Disconnect device calendars" tone="quiet" disabled={busy} onPress={onDisconnect} />
        </View>
      )}
      {connected ? (
        <View style={{ gap: 6 }}>
          <Button label="Reload calendar list" tone="quiet" disabled={busy || (Platform.OS === "web" && !demoMode)} onPress={onConnect} />
          <Text style={styles.meta}>Reloading clears the selection. Choose calendars again.</Text>
        </View>
      ) : null}

      {connected ? (
        <>
          <View style={styles.sectionHead}>
            <Text style={styles.label}>Choose calendars to read</Text>
            <Text style={styles.meta}>{selected.length} of 20 selected · {calendars.length} discovered</Text>
          </View>
          {calendars.length ? calendars.slice(0, 100).map((calendar) => {
            const checked = selected.includes(calendar.localId);
            const selectionFull = selected.length >= 20 && !checked;
            return (
              <Pressable
                key={calendar.localId}
                accessibilityRole="checkbox"
                accessibilityLabel={`${calendar.title || "Untitled calendar"}, ${calendar.allowsModifications ? "writable" : "read only"}`}
                accessibilityState={{ checked, disabled: busy || selectionFull }}
                disabled={busy || selectionFull}
                onPress={() => onSelection(checked ? selected.filter((id) => id !== calendar.localId) : [...selected, calendar.localId])}
                style={[styles.calendarChoice, checked && styles.calendarChoiceSelected, (busy || selectionFull) && styles.disabled]}
              >
                <View style={[styles.check, checked && styles.checkSelected]}>
                  {checked ? <Text style={styles.checkmark}>✓</Text> : null}
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.calendarTitle}>{calendar.title || "Untitled calendar"}</Text>
                  <Text style={styles.meta}>
                    {calendar.sourceName ? `${calendar.sourceName} · ` : ""}{calendar.allowsModifications ? "Writable" : "Read only"}
                    {calendar.timeZone ? ` · ${calendar.timeZone}` : " · time zone unavailable"}
                  </Text>
                </View>
              </Pressable>
            );
          }) : <Text style={styles.meta}>No calendars were discovered.</Text>}
          {calendars.length > 100 ? <Text style={styles.meta}>Showing the first 100 discovered calendars.</Text> : null}
          <Button
            label="Refresh selected calendars"
            disabled={busy || selected.length === 0}
            onPress={() => onRefresh()}
          />
          {canContinue ? (
            <Button label="Continue calendar scan" tone="quiet" disabled={busy} onPress={() => onRefresh(run?.runId)} />
          ) : null}
          <Text style={styles.meta}>{runDescription(state.deviceCalendars)}</Text>
          {canContinue ? <Text style={styles.notice}>Some selected calendars remain unchecked. Continue the scan to finish this bounded pass.</Text> : null}
          {run?.partial && !canContinue ? <Text style={styles.notice}>This bounded read omitted some results. No selected calendars remain to continue in this pass.</Text> : null}
          {run && (run.truncatedCalendars > 0 || run.truncatedEvents > 0) ? (
            <Text style={styles.notice}>The native calendar result was capped. {run.truncatedCalendars} calendar lists and {run.truncatedEvents} events were truncated.</Text>
          ) : null}
          <View style={styles.eventsHead}>
            <Text style={styles.label}>Saved calendar events</Text>
            <Text style={styles.meta}>
              {runIsCurrent
                ? `${eventsInCheckedWindow.length} events in the checked window${Number.isFinite(eventSnapshotAt) ? ` · saved as of ${formattedTime(new Date(eventSnapshotAt).toISOString())}` : ""}`
                : "No current checked snapshot."}
            </Text>
          </View>
          {eventsInCheckedWindow.length ? (
            eventsInCheckedWindow
              .slice(0, 30)
              .map((event) => {
                const calendar = state.deviceCalendars.calendars.find((item) => item.localId === event.calendarId);
                return (
                  <View key={event.id} style={styles.eventRow}>
                    <Text style={styles.calendarTitle}>{event.title || "Untitled event"}</Text>
                    <Text style={styles.meta}>{calendar?.title || "Calendar unavailable"}{calendar?.sourceName ? ` · ${calendar.sourceName}` : " · On this iPhone"}</Text>
                    <Text style={styles.meta}>{event.allDay ? "All day · original date zone unavailable" : formattedTime(event.start, event.timeZone, !event.timeZone)}</Text>
                    {event.notes ? <Text style={styles.copy}>{event.notes}{event.notesTruncated ? " …" : ""}</Text> : null}
                  </View>
                );
              })
          ) : (
            <Text style={styles.meta}>{runIsCurrent ? "No saved events in the current checked window." : "Refresh selected calendars to check for saved events."}</Text>
          )}
          {eventsInCheckedWindow.length > 30 ? <Text style={styles.meta}>Showing 30 of {eventsInCheckedWindow.length} saved events in this checked window.</Text> : null}
          {canWrite ? null : <Text style={styles.notice}>Event creation is unavailable until iOS grants full calendar access.</Text>}
        </>
      ) : null}
    </View>
  );
}

const styles = {
  container: { gap: 11, marginTop: 24, paddingTop: 22, borderTopWidth: 1, borderTopColor: C.border },
  copy: { color: C.muted, fontSize: 13, lineHeight: 19 },
  notice: { color: C.sage, fontSize: 12, lineHeight: 18 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
  statusCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 16, padding: 14, gap: 7 },
  statusTitle: { color: C.text, fontSize: 14, fontWeight: "600" as const, textTransform: "capitalize" as const },
  meta: { color: C.muted, fontSize: 11, lineHeight: 16 },
  label: { color: C.muted, fontSize: 10, letterSpacing: 1, fontWeight: "700" as const, textTransform: "uppercase" as const },
  sectionHead: { marginTop: 8, gap: 4 },
  calendarChoice: { minHeight: 58, padding: 12, borderRadius: 14, borderColor: C.border, borderWidth: 1, backgroundColor: C.card, flexDirection: "row" as const, alignItems: "center" as const, gap: 11 },
  calendarChoiceSelected: { borderColor: C.sage },
  disabled: { opacity: 0.55 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: C.muted, alignItems: "center" as const, justifyContent: "center" as const },
  checkSelected: { backgroundColor: C.sage, borderColor: C.sage },
  checkmark: { color: C.bg, fontSize: 14, fontWeight: "700" as const },
  calendarTitle: { color: C.text, fontSize: 14, fontWeight: "500" as const },
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
  eventsHead: { marginTop: 10, gap: 4 },
  eventRow: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 12, gap: 5 },
};
