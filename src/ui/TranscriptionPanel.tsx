import React, { useState } from "react";
import { Text, View } from "react-native";
import type { Note } from "../core";
import type { TranscriptionAttempt } from "../transcription";
import { Button } from "./primitives";
import { C, s } from "./theme";

type Props = {
  note: Note;
  attempts: readonly TranscriptionAttempt[];
  enabled: boolean;
  configured: boolean;
  busy: boolean;
  requestRunning: boolean;
  demoMode: boolean;
  cancelingAttemptId?: string;
  onTranscribe: (expectedRevision: number) => void;
  onCancel: (attemptId: string) => void;
  onOpenSettings: () => void;
};

function outcomeLabel(attempt: TranscriptionAttempt) {
  switch (attempt.outcome) {
    case "preparing":
      return "Preparing the saved recording";
    case "pending":
      return "Transcription request in progress";
    case "completed":
      return "Transcript saved";
    case "no_speech":
      return "No speech was detected";
    case "unknown":
      return "Result uncertain";
    case "discarded":
      return "Result was not applied because the note changed";
    case "cancelled":
      return "Transcription cancelled";
    case "failed":
      if (attempt.code === "credential_missing") return "Azure Speech credentials need attention";
      if (attempt.code === "stale_credential") return "Azure Speech credentials changed before upload";
      if (attempt.code === "audio_invalid" || attempt.code === "preparation_interrupted") return "The recording could not be prepared";
      if (attempt.code === "provider_rejected") return "Azure Speech rejected the request";
      if (attempt.code === "timeout") return "The request timed out";
      if (attempt.code === "invalid_response") return "Azure Speech returned an unreadable result";
      return "Transcription did not complete";
  }
}

function durationLabel(seconds: number) {
  const formatted = seconds.toFixed(3)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
  return `${formatted} seconds`;
}

function originalDurationLabel(attempt: TranscriptionAttempt, note: Note) {
  const seconds = attempt.source.durationSeconds || note.durationSeconds || attempt.prepared?.durationSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? durationLabel(seconds)
    : undefined;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Time unavailable";
}

export function TranscriptionPanel({
  note,
  attempts,
  enabled,
  configured,
  busy,
  requestRunning,
  demoMode,
  cancelingAttemptId,
  onTranscribe,
  onCancel,
  onOpenSettings,
}: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const recordingAttached = Boolean(note.audioUri);
  const ordered = [...attempts].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = ordered[0];
  const active = ordered.find((attempt) => attempt.outcome === "preparing" || attempt.outcome === "pending");
  const durationUnavailable = note.audioAttachment?.durationStatus === "unknown";
  const retryAfterUnknown = Boolean(latest && latest.dispatchStarted && ["unknown", "failed", "cancelled", "discarded"].includes(latest.outcome));
  const canStart = recordingAttached && enabled && configured && !busy && !active && !durationUnavailable && !demoMode;
  const sampleCanStart = recordingAttached && enabled && configured && !busy && !active && !durationUnavailable && demoMode;

  if (!recordingAttached && attempts.length === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={s.sectionTitle}>Transcription</Text>
      {demoMode ? <Text style={styles.sample}>Sample transcription · no API used</Text> : null}
      {!recordingAttached ? (
        <Text style={styles.helper}>Recording is no longer attached. Transcription history remains available.</Text>
      ) : null}
      {!enabled ? (
        <Text style={s.setupBody}>Azure transcription is off. It is separate from the AI analysis setting.</Text>
      ) : null}
      {enabled && !configured ? (
        <Text style={s.setupBody}>Add an Azure Speech endpoint and key in Settings before starting a request.</Text>
      ) : null}
      {durationUnavailable ? (
        <Text style={s.setupBody}>This recording has no verified duration and cannot be uploaded for transcription.</Text>
      ) : null}
      {recordingAttached && note.transcript.trim() ? (
        <Text style={styles.helper}>{demoMode
          ? "Sample run only; Azure is not contacted. A successful sample replaces the saved transcript; other outcomes preserve it."
          : "This uploads the saved recording to Azure Speech and may incur a charge. A successful result replaces the saved transcript; other outcomes preserve it."}</Text>
      ) : recordingAttached ? (
        <Text style={styles.helper}>{demoMode
          ? "Sample run only; Azure is not contacted. Your saved recording stays unchanged."
          : "This uploads the saved recording to Azure Speech and may incur a charge. It starts only when you choose it."}</Text>
      ) : null}
      {latest ? (
        <View style={styles.latest}>
          <Text style={styles.outcome}>{outcomeLabel(latest)}</Text>
          <Text style={styles.meta}>{demoMode ? "Sample result" : "Azure Speech"} · {dateLabel(latest.createdAt)}</Text>
          {originalDurationLabel(latest, note) ? <Text style={styles.meta}>Original audio duration · {originalDurationLabel(latest, note)}</Text> : null}
          {latest.durationMilliseconds !== undefined ? <Text style={styles.meta}>Provider-reported duration · {durationLabel(latest.durationMilliseconds / 1000)}</Text> : null}
          {latest.billedEstimateSeconds !== undefined ? (
            <Text style={styles.meta}>Provider billing duration estimate · {durationLabel(latest.billedEstimateSeconds)}</Text>
          ) : null}
          {retryAfterUnknown ? (
            <Text style={styles.warning}>{demoMode
              ? "Sample uncertain result. In real use, Azure may have received the recording and charged for it; another upload starts a new request."
              : "Azure may have received this recording and may charge for it. Upload again starts a new request."}</Text>
          ) : null}
          {latest.outcome === "no_speech" ? (
            <Text style={styles.helper}>The saved recording and transcript were left unchanged.</Text>
          ) : null}
          {active ? (
            <Button
              label={cancelingAttemptId === active.id ? "Resolving transcription…" : requestRunning ? "Cancel transcription" : "Recover interrupted transcription"}
              tone="quiet"
              disabled={cancelingAttemptId === active.id}
              onPress={() => onCancel(active.id)}
            />
          ) : null}
        </View>
      ) : null}
      {recordingAttached && enabled && configured && !durationUnavailable ? (
        <Button
          label={demoMode
            ? retryAfterUnknown ? "Run sample upload again" : "Run sample transcription"
            : retryAfterUnknown ? "Upload again" : note.transcript.trim() ? "Replace transcript" : "Transcribe recording"}
          disabled={!(canStart || sampleCanStart)}
          onPress={() => onTranscribe(note.revision)}
        />
      ) : recordingAttached ? (
        <Button
          label={enabled ? "Set up Azure Speech" : "Enable Azure transcription"}
          tone="quiet"
          disabled={demoMode || busy || durationUnavailable}
          onPress={onOpenSettings}
        />
      ) : null}
      {ordered.length > 1 ? (
        <>
          <Button
            label={showHistory ? "Hide transcription history" : `View transcription history (${ordered.length - 1} earlier)`}
            tone="quiet"
            onPress={() => setShowHistory((value) => !value)}
          />
          {showHistory ? ordered.slice(1, 6).map((attempt) => (
            <View key={attempt.id} style={styles.historyRow}>
              <Text style={styles.outcome}>{outcomeLabel(attempt)}</Text>
              <Text style={styles.meta}>{dateLabel(attempt.createdAt)}</Text>
              {attempt.dispatchStarted && ["unknown", "failed", "cancelled", "discarded"].includes(attempt.outcome) ? (
                <Text style={styles.warning}>{demoMode
                  ? "Sample only. In real use, Azure may have received the recording and charged for it."
                  : "This request may have been charged."}</Text>
              ) : null}
            </View>
          )) : null}
          {showHistory && ordered.length > 6 ? <Text style={styles.meta}>Showing the five most recent earlier attempts.</Text> : null}
        </>
      ) : null}
    </View>
  );
}

const styles = {
  card: { gap: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  helper: { color: C.muted, fontSize: 12, lineHeight: 18 },
  warning: { color: C.sage, fontSize: 12, lineHeight: 18 },
  sample: { color: C.sage, fontSize: 12, lineHeight: 18, fontWeight: "600" as const },
  latest: { gap: 4, paddingTop: 8 },
  outcome: { color: C.text, fontSize: 13, fontWeight: "600" as const },
  meta: { color: C.muted, fontSize: 11, lineHeight: 16 },
  historyRow: { gap: 3, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
};
