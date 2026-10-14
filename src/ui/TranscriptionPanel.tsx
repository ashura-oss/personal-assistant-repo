import React, { useRef, useState } from "react";
import { Text, View } from "react-native";
import type { Note } from "../core";
import type { TranscriptionAttempt } from "../transcription";
import { Button } from "./primitives";
import { formatProviderReportedCostUsd } from "./formatProviderReportedCostUsd";
import { C, s } from "./theme";

type Props = {
  note: Note;
  attempts: readonly TranscriptionAttempt[];
  speechProvider?: "azure" | "openrouter";
  enabled: boolean;
  configured: boolean;
  busy: boolean;
  requestRunning: boolean;
  demoMode: boolean;
  cancelingAttemptId?: string;
  requestCleanupAttemptIds?: readonly string[];
  retryingCleanupAttemptId?: string;
  onTranscribe: (expectedRevision: number) => void;
  onCancel: (attemptId: string) => void;
  onRetryRequestCleanup?: (attemptId: string) => Promise<void>;
  onOpenSettings: () => void;
};

function outcomeLabel(attempt: TranscriptionAttempt) {
  const provider = attempt.provider === "openrouter" ? "OpenRouter Speech" : "Azure Speech";
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
      if (attempt.code === "credential_missing") return `${provider} credentials need attention`;
      if (attempt.code === "stale_credential") return `${provider} credentials changed before upload`;
      if (attempt.code === "audio_invalid" || attempt.code === "preparation_interrupted") return "The recording could not be prepared";
      if (attempt.code === "provider_rejected") return `${provider} rejected the request`;
      if (attempt.code === "timeout") return "The request timed out";
      if (attempt.code === "invalid_response") return `${provider} returned an unreadable result`;
      return "Transcription did not complete";
  }
}

function attemptProviderLabel(attempt: TranscriptionAttempt) {
  return attempt.provider === "openrouter" ? "OpenRouter Speech" : "Azure Speech";
}

function openRouterUsageLines(attempt: TranscriptionAttempt) {
  if (attempt.provider !== "openrouter") return null;
  const usage = attempt.actualUsage;
  if (!usage) return attempt.outcome === "preparing" || attempt.outcome === "pending"
    ? <Text style={styles.meta}>OpenRouter usage is not available yet.</Text>
    : <Text style={styles.meta}>OpenRouter did not report usage for this request.</Text>;
  const lines: React.ReactNode[] = [];
  if (usage.seconds !== undefined && Number.isFinite(usage.seconds) && usage.seconds >= 0) {
    lines.push(<Text key="seconds" style={styles.meta}>OpenRouter-reported audio seconds · {durationLabel(usage.seconds)}</Text>);
  }
  if (usage.inputTokens !== undefined && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0) {
    lines.push(<Text key="input" style={styles.meta}>OpenRouter-reported input tokens · {usage.inputTokens.toLocaleString()}</Text>);
  }
  if (usage.outputTokens !== undefined && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0) {
    lines.push(<Text key="output" style={styles.meta}>OpenRouter-reported output tokens · {usage.outputTokens.toLocaleString()}</Text>);
  }
  if (usage.totalTokens !== undefined && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) {
    lines.push(<Text key="total" style={styles.meta}>OpenRouter-reported total tokens · {usage.totalTokens.toLocaleString()}</Text>);
  }
  if (usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
    lines.push(<Text key="cost" style={styles.meta}>OpenRouter-reported cost · {formatProviderReportedCostUsd(usage.costUsd)}</Text>);
  }
  return lines.length ? <>{lines}</> : <Text style={styles.meta}>OpenRouter did not report usage for this request.</Text>;
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
  speechProvider = "azure",
  enabled,
  configured,
  busy,
  requestRunning,
  demoMode,
  cancelingAttemptId,
  requestCleanupAttemptIds = [],
  retryingCleanupAttemptId,
  onTranscribe,
  onCancel,
  onRetryRequestCleanup,
  onOpenSettings,
}: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const [cleanupError, setCleanupError] = useState(false);
  const cleanupActionLock = useRef(false);
  const selectedProviderLabel = speechProvider === "openrouter" ? "OpenRouter Speech" : "Azure Speech";
  const recordingAttached = Boolean(note.audioUri);
  const ordered = [...attempts].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = ordered[0];
  const active = ordered.find((attempt) => attempt.outcome === "preparing" || attempt.outcome === "pending");
  const durationUnavailable = note.audioAttachment?.durationStatus === "unknown";
  const retryAfterUnknown = Boolean(latest && (latest.provider === "openrouter"
    ? latest.unknownCharge === true
    : latest.dispatchStarted && ["unknown", "failed", "cancelled", "discarded"].includes(latest.outcome)));
  const cleanupPending = new Set(requestCleanupAttemptIds);
  const hasPendingCleanup = attempts.some((attempt) => cleanupPending.has(attempt.id));
  const canStart = recordingAttached && enabled && configured && !busy && !active && !hasPendingCleanup && !durationUnavailable && !demoMode;
  const sampleCanStart = recordingAttached && enabled && configured && !busy && !active && !hasPendingCleanup && !durationUnavailable && demoMode;

  const retryCleanup = async (attemptId: string) => {
    if (!onRetryRequestCleanup || cleanupActionLock.current) return;
    cleanupActionLock.current = true;
    setCleanupError(false);
    try { await onRetryRequestCleanup(attemptId); }
    catch { setCleanupError(true); }
    finally { cleanupActionLock.current = false; }
  };

  const cleanupAttempts = ordered.filter((attempt) => cleanupPending.has(attempt.id));

  if (!recordingAttached && attempts.length === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={s.sectionTitle}>Transcription</Text>
      {demoMode ? <Text style={styles.sample}>Sample transcription · no API used</Text> : null}
      {!recordingAttached ? (
        <Text style={styles.helper}>Recording is no longer attached. Transcription history remains available.</Text>
      ) : null}
      {!enabled ? (
        <Text style={s.setupBody}>{selectedProviderLabel} transcription is off. It is separate from the AI analysis setting.</Text>
      ) : null}
      {enabled && !configured ? (
        <Text style={s.setupBody}>{speechProvider === "openrouter"
          ? "Save an OpenRouter API key in Settings before transcribing this recording. Your recording remains local until you choose Transcribe."
          : "Add an Azure Speech endpoint and key in Settings before starting a request."}</Text>
      ) : null}
      {durationUnavailable ? (
        <Text style={s.setupBody}>This recording has no verified duration and cannot be uploaded for transcription.</Text>
      ) : null}
      {speechProvider === "openrouter" && recordingAttached ? enabled ? (
        <Text style={styles.helper}>{demoMode
          ? "Sample only; no OpenRouter request is sent."
          : "This sends the saved recording to OpenRouter Speech as a separate audio request and may incur a charge. No cost is estimated; usage is shown only if OpenRouter reports it."}</Text>
      ) : null : recordingAttached && note.transcript.trim() ? (
        <Text style={styles.helper}>{demoMode
          ? "Sample run only; Azure is not contacted. A successful sample replaces the saved transcript; other outcomes preserve it."
          : "This uploads the saved recording to Azure Speech and may incur a charge. A successful result replaces the saved transcript; other outcomes preserve it."}</Text>
      ) : recordingAttached ? (
        <Text style={styles.helper}>{demoMode
          ? "Sample run only; Azure is not contacted. Your saved recording stays unchanged."
          : "This uploads the saved recording to Azure Speech and may incur a charge. It starts only when you choose it."}</Text>
      ) : null}
      {cleanupError ? <Text accessibilityRole="alert" style={styles.warning}>Local request cleanup could not be confirmed. Try again.</Text> : null}
      {latest ? (
        <View style={styles.latest}>
          <Text style={styles.outcome}>{outcomeLabel(latest)}</Text>
          <Text style={styles.meta}>{demoMode ? "Sample result" : attemptProviderLabel(latest)} · {dateLabel(latest.createdAt)}</Text>
          {originalDurationLabel(latest, note) ? <Text style={styles.meta}>Original audio duration · {originalDurationLabel(latest, note)}</Text> : null}
          {latest.provider !== "openrouter" && latest.durationMilliseconds !== undefined ? <Text style={styles.meta}>Provider-reported duration · {durationLabel(latest.durationMilliseconds / 1000)}</Text> : null}
          {latest.provider === "openrouter" ? openRouterUsageLines(latest) : null}
          {latest.provider !== "openrouter" ? <Text style={styles.meta}>Azure Speech cost is not reported here.</Text> : null}
          {retryAfterUnknown ? (
            <Text style={styles.warning}>{demoMode
              ? `Sample uncertain result. In real use, ${attemptProviderLabel(latest)} may have received the recording and charged for it; another upload starts a new request.`
              : `${attemptProviderLabel(latest)} may have received this recording and may charge for it. Upload again starts a new request.`}</Text>
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
      {cleanupAttempts.length ? (
        <View style={styles.latest}>
          <Text style={styles.outcome}>A local request still needs cleanup</Text>
          {cleanupAttempts.map((attempt) => (
            <View key={`cleanup-${attempt.id}`} style={styles.historyRow}>
              <Text style={styles.meta}>{attemptProviderLabel(attempt)} · {dateLabel(attempt.createdAt)}</Text>
              {onRetryRequestCleanup ? (
                <Button
                  label={retryingCleanupAttemptId === attempt.id ? "Finishing local request cleanup…" : "Finish local request cleanup"}
                  tone="quiet"
                  disabled={retryingCleanupAttemptId === attempt.id}
                  onPress={() => void retryCleanup(attempt.id)}
                />
              ) : null}
            </View>
          ))}
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
          label={enabled ? `Set up ${selectedProviderLabel}` : `Enable ${selectedProviderLabel} transcription`}
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
              <Text style={styles.meta}>{attemptProviderLabel(attempt)} · {dateLabel(attempt.createdAt)}</Text>
              {attempt.provider === "openrouter" ? openRouterUsageLines(attempt) : null}
              {attempt.provider !== "openrouter" ? <Text style={styles.meta}>Azure Speech cost is not reported here.</Text> : null}
              {(attempt.provider === "openrouter"
                ? attempt.unknownCharge === true
                : attempt.dispatchStarted && ["unknown", "failed", "cancelled", "discarded"].includes(attempt.outcome)) ? (
                <Text style={styles.warning}>{demoMode
                  ? `Sample only. In real use, ${attemptProviderLabel(attempt)} may have received the recording and charged for it.`
                  : attempt.provider === "openrouter" ? "OpenRouter may have received the recording and may charge for it." : "This request may have been charged."}</Text>
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
