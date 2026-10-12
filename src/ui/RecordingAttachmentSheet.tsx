import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  ScrollView,
  Text,
  View,
} from "react-native";
import type {
  Note,
  RecordingAttachmentPreview,
} from "../core";
import { Button, IconButton } from "./primitives";
import { s } from "./theme";

type Props = {
  visible: boolean;
  note: Note;
  demoMode: boolean;
  onPrepare: (
    noteId: string,
    input: { expectedRevision: number },
  ) => Promise<RecordingAttachmentPreview | null>;
  onAttach: (input: { sessionId: string; planHash: string }) => Promise<Note>;
  onCancelSession: (sessionId: string) => Promise<void>;
  onAttached: (note: Note) => void;
  onClose: () => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (seconds > 0 && seconds < 1) {
    return `${Number(seconds.toPrecision(3))} seconds`;
  }
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

export function RecordingAttachmentSheet({
  visible,
  note,
  demoMode,
  onPrepare,
  onAttach,
  onCancelSession,
  onAttached,
  onClose,
}: Props) {
  const sequence = useRef(0);
  const alive = useRef(true);
  const cancelSession = useRef(onCancelSession);
  const session = useRef<RecordingAttachmentPreview | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [preview, setPreview] = useState<RecordingAttachmentPreview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    cancelSession.current = onCancelSession;
  }, [onCancelSession]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current += 1;
      const staged = session.current;
      session.current = null;
      if (staged) void cancelSession.current(staged.sessionId).catch(() => undefined);
    };
  }, []);

  const clearPreview = () => {
    const staged = session.current;
    session.current = null;
    setPreview(null);
    if (staged) void onCancelSession(staged.sessionId).catch(() => undefined);
  };

  const close = () => {
    if (attaching) return;
    sequence.current += 1;
    setSelecting(false);
    clearPreview();
    setError("");
    onClose();
  };

  const chooseFile = async () => {
    if (selecting || attaching) return;
    const request = ++sequence.current;
    clearPreview();
    setError("");
    setSelecting(true);
    try {
      const result = await onPrepare(note.id, {
        expectedRevision: note.revision,
      });
      if (!result) {
        if (alive.current && request === sequence.current) setSelecting(false);
        return;
      }
      if (!alive.current || request !== sequence.current || !visible) {
        await onCancelSession(result.sessionId).catch(() => undefined);
        return;
      }
      session.current = result;
      setPreview(result);
    } catch (cause) {
      if (alive.current && request === sequence.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Still could not prepare this recording. Choose the file again.",
        );
      }
    } finally {
      if (alive.current && request === sequence.current) setSelecting(false);
    }
  };

  const cancelSelection = () => {
    sequence.current += 1;
    setSelecting(false);
    setError("File selection canceled. No changes were made.");
  };

  const attach = async () => {
    const staged = session.current;
    if (
      !staged ||
      staged.noteId !== note.id ||
      staged.expectedRevision !== note.revision ||
      attaching
    ) {
      return;
    }
    const request = sequence.current;
    setAttaching(true);
    setError("");
    try {
      const updated = await onAttach({
        sessionId: staged.sessionId,
        planHash: staged.planHash,
      });
      if (!alive.current || request !== sequence.current) return;
      session.current = null;
      setPreview(null);
      onAttached(updated);
      onClose();
    } catch (cause) {
      if (alive.current && request === sequence.current) {
        session.current = null;
        setPreview(null);
        setError(
          cause instanceof Error
            ? `${cause.message} Choose the file again to retry.`
            : "Still could not attach this recording. Review the file and try again.",
        );
      }
    } finally {
      if (alive.current && request === sequence.current) setAttaching(false);
    }
  };

  const stalePreview = Boolean(
    preview &&
      (preview.noteId !== note.id || preview.expectedRevision !== note.revision),
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={close}
    >
      <View style={s.modalSafe}>
        <View style={s.modalHeader}>
          <IconButton
            name="chevron-back"
            label={attaching ? "Attaching recording" : "Close recording attachment"}
            onPress={close}
          />
          <Text style={s.modalTitle}>Attach a recording</Text>
          <View style={{ width: 44 }} />
        </View>
        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.kicker}>IMPORTED NOTE</Text>
          <Text style={s.h1Small}>Choose a recording.</Text>
          <Text style={s.setupBody}>
            Select an audio file saved on this device. Still checks its format,
            size, and duration before you choose to attach it.
          </Text>
          {demoMode ? (
            <Text style={s.disclaimer}>
              Sample preview · the selected file stays in memory and is not a production recording.
            </Text>
          ) : null}
          <View style={s.setupCard}>
            <Text style={s.setupTitle}>Replacement recording</Text>
            <Text style={s.setupBody}>
              The backup did not include the original audio. Still cannot verify
              that a selected recording is the original.
            </Text>
          </View>

          {!preview || stalePreview ? (
            <Button
              label={selecting ? "Waiting for file selection…" : "Choose recording"}
              icon="document-attach-outline"
              disabled={selecting || attaching || stalePreview}
              onPress={() => void chooseFile()}
            />
          ) : null}
          {selecting ? (
            <Button
              label="Cancel file selection"
              tone="quiet"
              onPress={cancelSelection}
            />
          ) : null}

          {preview ? (
            <View style={s.assistCard}>
              <Text style={s.sectionTitle}>Review selected file</Text>
              <Text style={s.analysisText}>{preview.fileName}</Text>
              <Text style={s.analysisSource}>
                {preview.format.toUpperCase()} · {formatBytes(preview.byteLength)}
              </Text>
              <Text style={s.analysisSource}>
                {preview.durationStatus === "known" &&
                typeof preview.durationSeconds === "number"
                  ? `${formatDuration(preview.durationSeconds)} measured duration`
                  : demoMode
                    ? "Duration unavailable. This sample keeps the file in memory; playback and transcription are disabled."
                    : "Duration unavailable. This file can be kept for local playback; transcription stays disabled."}
              </Text>
              <Text style={s.disclaimer}>
                Original match unverified · transcript and capture time are kept.
              </Text>
              {stalePreview ? (
                <Text style={s.errorText}>
                  This note changed after the file was selected. Close this
                  review and choose the file again.
                </Text>
              ) : null}
              <Button
                label={attaching ? "Attaching…" : "Attach recording"}
                disabled={attaching || stalePreview}
                onPress={() => void attach()}
              />
              {!attaching ? (
                <Button
                  label="Choose a different file"
                  tone="quiet"
                  onPress={() => void chooseFile()}
                />
              ) : null}
            </View>
          ) : null}
          {error ? (
            <View style={s.analysisStale}>
              <Text style={s.analysisText}>{error}</Text>
            </View>
          ) : null}
          <Text style={s.disclaimer}>
            {preview?.durationStatus === "unknown"
              ? "Attaching does not transcribe or send the recording. Transcription stays disabled for this file."
              : "Attaching does not transcribe or send the recording. You can review playback and choose transcription separately after it is attached."}
          </Text>
          {attaching ? (
            <Text style={s.analysisSource}>
              Keep this screen open until attachment finishes.
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
