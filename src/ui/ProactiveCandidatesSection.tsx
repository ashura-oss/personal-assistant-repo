import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type {
  ProactiveCandidateEntry,
  ProactiveCandidateSourceResult,
  ProactiveState,
} from "../core";
import type { DeviceCalendarAccessStatus } from "../deviceCalendars/types";
import type { ProactiveSource } from "../proactive";
import type { DeepReadonly } from "../cloud/workspaceDto";
import type { WorkspaceActionCapability } from "./workspaceCapabilities";
import type { InboxAccountDisplay, InboxDeviceCalendarDisplay } from "./InboxWorkspaceContent";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button } from "./primitives";
import { C, s } from "./theme";

type Props = {
  proactive: DeepReadonly<ProactiveState>;
  accounts: readonly DeepReadonly<InboxAccountDisplay>[];
  deviceCalendars?: DeepReadonly<InboxDeviceCalendarDisplay>;
  deviceCalendarAccess: DeviceCalendarAccessStatus;
  busy: boolean;
  onDismiss: WorkspaceActionCapability<(candidateId: string) => void>;
  onSnooze: WorkspaceActionCapability<(candidateId: string, until: string) => void>;
  onRemind: WorkspaceActionCapability<(candidateId: string) => void>;
  onGetSource: WorkspaceActionCapability<(candidateId: string) => Promise<ProactiveCandidateSourceResult>>;
};

const reasonLabel = (entry: ProactiveCandidateEntry) => {
  switch (entry.candidate.reasonCode) {
    case "unread_sender":
      return "Unread message from a followed sender";
    case "keyword":
      return "Keyword found in saved mail";
    case "meeting_soon":
      return "Meeting coming up";
    case "task_due":
      return "Task due";
  }
};

const localTime = (value?: string) => {
  if (!value) return "Time unavailable";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString()
    : "Time unavailable";
};

function timestampInLocalTime(value?: string, utcCertified = false) {
  if (!value) return "Time unavailable";
  const zoned =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i.exec(
      value,
    );
  if (zoned) {
    const fraction = zoned[2] ? `.${zoned[2].slice(0, 3).padEnd(3, "0")}` : "";
    return localTime(`${zoned[1]}${fraction}${zoned[3]}`);
  }
  const naive =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(
      value,
    );
  if (!naive) return localTime(value);
  if (!utcCertified) return "Time zone not verified";
  const fraction = naive[3] ? `.${naive[3].slice(0, 3).padEnd(3, "0")}` : "";
  const seconds = naive[2] ? `:${naive[2]}` : ":00";
  return localTime(`${naive[1]}${seconds}${fraction}Z`);
}

function sourceTitle(source: ProactiveSource) {
  if (source.kind === "mail")
    return source.subject || source.senderEmail || "Saved message";
  if (source.kind === "meeting") return source.subject || "Calendar event";
  return source.title || "Local task";
}

function sourceTime(source: ProactiveSource) {
  if (source.kind === "mail")
    return timestampInLocalTime(
      source.receivedAt,
      source.receivedAtUtcCertified,
    );
  if (source.kind === "meeting")
    return timestampInLocalTime(source.startAt, source.startAtUtcCertified);
  return timestampInLocalTime(source.dueAt, source.dueAtUtcCertified);
}

type DeviceSourcePresentation = { calendarTitle: string; timeZone?: string };

function parseDeviceProviderId(value: string) {
  if (value.length > 1024) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some((part) => typeof part !== "string" || !part || part.length > 512)) return undefined;
    const [installationId, calendarId, nativeEventId, occurrenceStart] = parsed as string[];
    return { installationId, calendarId, nativeEventId, occurrenceStart };
  } catch { return undefined; }
}

function resolveDeviceSourcePresentation(
  binding: { installationId: string; generation: number; calendarId: string; nativeEventId: string; occurrenceStart: string } | undefined,
  device: DeepReadonly<InboxDeviceCalendarDisplay>,
  access: DeviceCalendarAccessStatus,
): DeviceSourcePresentation | undefined {
  if (!binding || access !== "full_access" || !device.enabled || device.installationId !== binding.installationId || device.generation !== binding.generation || !device.selectedCalendarIds.includes(binding.calendarId)) return undefined;
  const run = device.readRun;
  if (!run || run.generation !== device.generation || run.selectionRevision !== device.selectionRevision || !run.selectedCalendarIds.includes(binding.calendarId)) return undefined;
  const event = device.events.find((item) => item.generation === device.generation && item.calendarId === binding.calendarId && item.nativeEventId === binding.nativeEventId && item.occurrenceStart === binding.occurrenceStart && !item.cancelled);
  if (!event) return undefined;
  const observedAt = Date.parse(event.observedAt);
  const age = Date.now() - observedAt;
  if (!Number.isFinite(observedAt) || age < 0 || age >= 15 * 60_000) return undefined;
  const calendar = device.calendars.find((item) => item.localId === binding.calendarId);
  return calendar ? { calendarTitle: calendar.title || "Calendar", ...(calendar.timeZone ? { timeZone: calendar.timeZone } : {}) } : undefined;
}

function sourceTimeInDeviceZone(value: string | undefined, utcCertified: boolean | undefined, timeZone?: string) {
  if (!timeZone || !value || !utcCertified) return timestampInLocalTime(value, utcCertified);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset",
    }).format(date);
  } catch { return timestampInLocalTime(value, utcCertified); }
}

export function ProactiveCandidatesSection({
  proactive,
  accounts,
  deviceCalendars,
  deviceCalendarAccess,
  busy,
  onDismiss,
  onSnooze,
  onRemind,
  onGetSource,
}: Props) {
  const [showWaiting, setShowWaiting] = useState(false);
  const [opened, setOpened] = useState<ProactiveCandidateEntry | undefined>();
  const [sourceResult, setSourceResult] = useState<
    ProactiveCandidateSourceResult | undefined
  >();
  const [loadingSource, setLoadingSource] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const sourceRequest = useRef(0);
  const [openedOwner, setOpenedOwner] = useState<Readonly<{ proactive: DeepReadonly<ProactiveState>; accounts: readonly DeepReadonly<InboxAccountDisplay>[]; candidateId: string; sourceVersion: string }>>();
  const closeSource = () => {
    sourceRequest.current += 1;
    setOpened(undefined);
    setOpenedOwner(undefined);
    setSourceResult(undefined);
    setSourceError("");
    setLoadingSource(false);
  };
  useEffect(() => () => { sourceRequest.current += 1; }, []);
  useEffect(() => {
    sourceRequest.current += 1;
  }, [proactive, accounts]);
  const enabledRules = proactive.rules.filter((rule) => rule.enabled);
  const active = (
    enabledRules.length
      ? proactive.candidates.filter((entry) => entry.presentation === "active")
      : []
  ).slice(0, 20);
  const waiting = proactive.candidates.filter(
    (entry) => entry.presentation !== "active",
  );
  const ruleName = (id: string) =>
    proactive.rules.find((rule) => rule.id === id)?.name ?? "Saved rule";
  const accountName = (id?: string) => {
    if (!id) return "Local task";
    const account = accounts.find((item) => item.id === id);
    return account
      ? account.displayName || account.email
      : "Account unavailable";
  };
  const entrySourceLabel = (entry: ProactiveCandidateEntry) => {
    if (entry.presentation === "uncertain") return "Saved source · needs recheck";
    if (entry.candidate.namespace === "device_calendar") {
      const tuple = parseDeviceProviderId(entry.candidate.providerId);
      const binding = tuple && deviceCalendars ? { ...tuple, generation: deviceCalendars.generation } : undefined;
      const source = deviceCalendars ? resolveDeviceSourcePresentation(binding, deviceCalendars, deviceCalendarAccess) : undefined;
      return source ? `${source.calendarTitle} · On this iPhone` : "On this iPhone · original calendar unavailable";
    }
    return accountName(entry.candidate.accountId);
  };

  const openSource = async (entry: ProactiveCandidateEntry) => {
    const request = ++sourceRequest.current;
    setOpenedOwner({ proactive, accounts, candidateId: entry.candidate.id, sourceVersion: entry.candidate.sourceVersion });
    setOpened(entry);
    setSourceResult(undefined);
    setSourceError("");
    setLoadingSource(true);
    try {
      if (!onGetSource.available) return;
      const result = await onGetSource.action(entry.candidate.id);
      if (sourceRequest.current !== request) return;
      setSourceResult(result);
    } catch (error) {
      if (sourceRequest.current !== request) return;
      setSourceError(
        error instanceof Error
          ? error.message
          : "The saved source could not be checked.",
      );
    } finally {
      if (sourceRequest.current === request) setLoadingSource(false);
    }
  };

  const sourceStatus = (entry: ProactiveCandidateEntry) => {
    if (entry.presentation === "uncertain") return "Needs a recheck";
    if (entry.presentation === "deferred") return "Waiting";
    return "Saved match · source checked";
  };

  if (!proactive.rules.length && !proactive.integrityError) return null;
  const latestOpenedEntry = opened
    ? proactive.candidates.find(
        (entry) => entry.candidate.id === opened.candidate.id,
      )
    : undefined;
  const openedOwnerIsCurrent = Boolean(opened && openedOwner?.proactive === proactive && openedOwner.accounts === accounts &&
    openedOwner.candidateId === opened.candidate.id && latestOpenedEntry?.candidate.sourceVersion === openedOwner.sourceVersion);
  const openedNeedsRecheck = Boolean(
    opened &&
    (!openedOwnerIsCurrent || !latestOpenedEntry || latestOpenedEntry.presentation === "uncertain" || latestOpenedEntry.candidate.sourceVersion !== opened.candidate.sourceVersion),
  );

  return (
    <View style={styles.sectionCard}>
      <Text style={s.sectionTitle}>For your attention</Text>
      <Text style={s.disclaimer}>
        Local matches from saved sources. These are not AI-generated or sent
        anywhere.
      </Text>
      {proactive.integrityError ? (
        <>
          <Text style={s.disclaimer}>Attention rules are paused.</Text>
          <Text accessibilityRole="alert" style={s.errorText}>
            {proactive.integrityError}
          </Text>
        </>
      ) : null}
      {!proactive.integrityError && !enabledRules.length ? (
        <Text style={s.disclaimer}>Attention rules are paused.</Text>
      ) : null}
      {!proactive.integrityError &&
      enabledRules.length > 0 &&
      !active.length ? (
        <Text style={s.emptyText}>No fresh matches right now.</Text>
      ) : null}
      {proactive.lastEvaluation?.truncation &&
      Object.values(proactive.lastEvaluation.truncation).some(
        (count) => count > 0,
      ) ? (
        <Text style={s.disclaimer}>
          Some items were left for a later local check.
        </Text>
      ) : null}
      {active.length
        ? active.map((entry) => (
            <View key={entry.candidate.id} style={styles.candidateCard}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={s.accountName}>{reasonLabel(entry)}</Text>
                  <Text style={s.accountSub}>
                    {ruleName(entry.candidate.ruleId)} ·{" "}
                    {entrySourceLabel(entry)}
                  </Text>
                </View>
                <Text style={styles.status}>{sourceStatus(entry)}</Text>
              </View>
              <Text style={styles.quote} numberOfLines={3}>
                “{entry.candidate.quote}”
              </Text>
              <Text style={s.accountSub}>
                Matched locally {localTime(proactive.lastEvaluation?.asOf)}
              </Text>
              <View style={styles.actions}>
                <Button
                  label="Open saved source"
                  tone="quiet"
                  onPress={() => void openSource(entry)}
                  disabled={busy || !onGetSource.available}
                />
                {!onGetSource.available ? <Text style={s.accountSub}>{onGetSource.reason}</Text> : null}
                <Button
                  label="Remind me"
                  tone="quiet"
                  onPress={() => { if (onRemind.available) onRemind.action(entry.candidate.id); }}
                  disabled={busy || !onRemind.available}
                />
                <Button
                  label="Dismiss"
                  tone="quiet"
                  onPress={() => { if (onDismiss.available) onDismiss.action(entry.candidate.id); }}
                  disabled={busy || !onDismiss.available}
                />
              </View>
              <View style={styles.actions}>
                <Button
                  label="Snooze 1 hour"
                  tone="quiet"
                  onPress={() =>
                    onSnooze.available && onSnooze.action(
                      entry.candidate.id,
                      new Date(Date.now() + 60 * 60_000).toISOString(),
                    )
                  }
                  disabled={busy || !onSnooze.available}
                />
                <Button
                  label="Snooze 1 day"
                  tone="quiet"
                  onPress={() =>
                    onSnooze.available && onSnooze.action(
                      entry.candidate.id,
                      new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
                    )
                  }
                  disabled={busy || !onSnooze.available}
                />
              </View>
            </View>
          ))
        : null}
      {waiting.length ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${showWaiting ? "Hide" : "Show"} waiting and needs recheck items`}
            onPress={() => setShowWaiting((value) => !value)}
            style={styles.waitingToggle}
          >
            <Text style={s.accountName}>
              Waiting / needs recheck · {waiting.length}
            </Text>
            <Ionicons
              accessible={false}
              name={showWaiting ? "chevron-up" : "chevron-down"}
              size={18}
              color={C.muted}
            />
          </Pressable>
          {showWaiting
            ? waiting.map((entry) => (
                <View key={entry.candidate.id} style={styles.waitingCard}>
                  <Text style={s.accountName}>{reasonLabel(entry)}</Text>
                  <Text style={s.accountSub}>
                    {ruleName(entry.candidate.ruleId)} ·{" "}
                    {entrySourceLabel(entry)} ·{" "}
                    {entry.presentation === "uncertain"
                      ? "Needs a recheck"
                      : "Waiting"}
                  </Text>
                  <Text style={styles.quote}>“{entry.candidate.quote}”</Text>
                  <View style={styles.actions}>
                    <Button
                      label="Check saved source"
                      tone="quiet"
                      onPress={() => void openSource(entry)}
                      disabled={busy || !onGetSource.available}
                    />
                    {!onGetSource.available ? <Text style={s.accountSub}>{onGetSource.reason}</Text> : null}
                    <Button
                      label="Dismiss"
                      tone="quiet"
                      onPress={() => { if (onDismiss.available) onDismiss.action(entry.candidate.id); }}
                      disabled={busy || !onDismiss.available}
                    />
                  </View>
                </View>
              ))
            : null}
        </>
      ) : null}
      {opened && openedOwnerIsCurrent ? <Modal
        visible={Boolean(opened)}
        animationType="slide"
        transparent
        onRequestClose={closeSource}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.cardTop}>
              <Text style={s.sectionTitle}>Saved source</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close source details"
                onPress={closeSource}
                style={styles.closeButton}
              >
                <Ionicons
                  accessible={false}
                  name="close"
                  size={22}
                  color={C.text}
                />
              </Pressable>
            </View>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ gap: 12 }}
            >
              {opened ? (
                <>
                  <Text style={s.accountName}>{reasonLabel(opened)}</Text>
                  <Text style={s.accountSub}>
                    {ruleName(opened.candidate.ruleId)} ·{" "}
                    {!openedNeedsRecheck && sourceResult?.status === "current"
                      ? entrySourceLabel(opened)
                      : "Saved source · needs recheck"}
                  </Text>
                  <View style={styles.sourceQuote}>
                    <Text style={s.kicker}>SAVED MATCH</Text>
                    <Text style={styles.quote}>“{opened.candidate.quote}”</Text>
                  </View>
                  {loadingSource ? (
                    <Text style={s.disclaimer}>Checking the saved source…</Text>
                  ) : null}
                  {sourceError ? (
                    <Text accessibilityRole="alert" style={s.errorText}>
                      {sourceError}
                    </Text>
                  ) : null}
                  {sourceResult ? (
                    <>
                      {openedNeedsRecheck ? (
                        <Text style={styles.stale}>
                          This match changed while open. Check the source again.
                        </Text>
                      ) : (
                        <Text
                          style={
                            sourceResult.status === "current"
                              ? styles.current
                              : styles.stale
                          }
                        >
                          {sourceResult.status === "current"
                            ? "Source was current when opened"
                            : sourceResult.status === "stale"
                              ? "This saved match may be out of date."
                              : sourceResult.status === "unavailable"
                                ? "The source is unavailable right now."
                                : "The saved source is no longer available."}
                        </Text>
                      )}
                      {sourceResult.status !== "current" ? (
                        <Text style={s.disclaimer}>
                          The quote above is historical and may not reflect the
                          current source.
                        </Text>
                      ) : null}
                      {sourceResult.source ? (
                        <SourceDetails
                          source={sourceResult.source}
                          deviceSourcePresentation={sourceResult.source.kind === "meeting"
                            && deviceCalendars ? resolveDeviceSourcePresentation(sourceResult.source.deviceBinding, deviceCalendars, deviceCalendarAccess)
                            : undefined}
                        />
                      ) : null}
                    </>
                  ) : null}
                  <Text style={s.accountSub}>
                    Checked at open. The saved source may change afterward.
                  </Text>
                </>
              ) : null}
            </ScrollView>
            <Button
              label="Close"
              tone="quiet"
              onPress={closeSource}
            />
          </View>
        </View>
      </Modal> : null}
    </View>
  );
}

function SourceDetails({ source, deviceSourcePresentation }: { source: ProactiveSource; deviceSourcePresentation?: DeviceSourcePresentation }) {
  return (
    <View style={styles.sourceDetails}>
      <Text style={s.accountName}>{sourceTitle(source)}</Text>
      {source.namespace === "device_calendar" ? <Text style={s.accountSub}>{deviceSourcePresentation ? `${deviceSourcePresentation.calendarTitle} · On this iPhone` : "On this iPhone · original calendar unavailable"}</Text> : null}
      {source.kind === "mail" && source.senderEmail ? (
        <Text style={s.accountSub}>From {source.senderEmail}</Text>
      ) : null}
      {source.kind === "mail" && source.isRead !== undefined ? (
        <Text style={s.accountSub}>{source.isRead ? "Read" : "Unread"}</Text>
      ) : null}
      <Text style={s.accountSub}>
        {source.kind === "mail"
          ? "Received"
          : source.kind === "meeting"
            ? "Starts"
            : "Due"}{" "}
        {source.kind === "meeting" && source.namespace === "device_calendar"
          ? sourceTimeInDeviceZone(source.startAt, source.startAtUtcCertified, deviceSourcePresentation?.timeZone)
          : sourceTime(source)}
      </Text>
      {source.kind === "mail" && source.snippet ? (
        <Text style={styles.detailText}>{source.snippet}</Text>
      ) : null}
      {source.kind === "task" && source.status ? (
        <Text style={s.accountSub}>
          {source.status === "open" ? "Open task" : "Completed task"}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionCard: {
    backgroundColor: C.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    gap: 12,
  },
  candidateCard: {
    backgroundColor: C.input,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    padding: 15,
    gap: 9,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  status: {
    color: C.sage,
    fontSize: 11,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
  },
  quote: { color: C.text, fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  waitingToggle: {
    minHeight: 48,
    borderTopWidth: 1,
    borderTopColor: C.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
  },
  waitingCard: {
    backgroundColor: C.input,
    borderRadius: 16,
    padding: 14,
    gap: 8,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    justifyContent: "flex-end",
    padding: 12,
  },
  modalCard: {
    maxHeight: "84%",
    backgroundColor: C.card,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.border,
    padding: 20,
    gap: 14,
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  sourceQuote: {
    backgroundColor: C.input,
    borderRadius: 15,
    padding: 14,
    gap: 8,
  },
  current: { color: C.sage, fontSize: 14, fontWeight: "600" },
  stale: { color: C.red, fontSize: 14, fontWeight: "600" },
  sourceDetails: {
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 12,
    gap: 8,
  },
  detailText: { color: C.text, fontSize: 14, lineHeight: 21 },
});
