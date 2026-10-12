import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { AppController, MailReplySourceSnapshot, Proposal } from "../core";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Field, IconButton } from "./primitives";
import { C, s } from "./theme";

type ReplyMode = "reply" | "reply_all";

export function MailReplyComposer({
  visible,
  messageId,
  controller,
  busy,
  onClose,
  onSave,
}: {
  visible: boolean;
  messageId: string | null;
  controller: AppController;
  busy: boolean;
  onClose: () => void;
  onSave: (input: {
    messageId: string;
    mode: ReplyMode;
    sourceDigest: string;
    text: string;
    to?: string[];
    cc?: string[];
  }) => Promise<Proposal | undefined>;
}) {
  const [source, setSource] = useState<MailReplySourceSnapshot | null>(null);
  const [mode, setMode] = useState<ReplyMode>("reply");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);

  const applySource = useCallback(
    async (nextMode: ReplyMode, initial: boolean) => {
      if (!messageId) return;
      const sequence = ++requestSequence.current;
      setChecking(true);
      setError("");
      setSource(null);
      if (initial) {
        setText("");
        setMode("reply");
      }
      try {
        const result = await controller.getMailReplySource(messageId);
        if (sequence !== requestSequence.current) return;
        if (result.status !== "current" || !result.source) {
          setSource(null);
          setError(
            result.status === "stale"
              ? "This saved message needs a fresh mail check before you can reply."
              : result.status === "unavailable"
                ? "Reply details are not available for this saved message."
                : "This message is no longer in the saved mail list.",
          );
          return;
        }
        setSource(result.source);
        const defaults = result.defaults?.[nextMode];
        setMode(nextMode);
        setTo((defaults?.to ?? []).join(", "));
        setCc((defaults?.cc ?? []).join(", "));
        if (initial) setText("");
      } catch (cause) {
        if (sequence !== requestSequence.current) return;
        setSource(null);
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not check the saved mail source.",
        );
      } finally {
        if (sequence === requestSequence.current) setChecking(false);
      }
    },
    [controller, messageId],
  );

  useEffect(() => {
    if (visible && messageId) {
      const timer = setTimeout(() => void applySource("reply", true), 0);
      return () => {
        clearTimeout(timer);
        requestSequence.current += 1;
      };
    }
    requestSequence.current += 1;
  }, [applySource, messageId, visible]);

  const changeMode = (nextMode: ReplyMode) => {
    if (nextMode !== mode && !checking && !busy) void applySource(nextMode, false);
  };
  const sourceAt = source?.observedAt
    ? new Date(source.observedAt).toLocaleString()
    : "Unavailable";
  const parsedTo = parseAddresses(to);
  const parsedCc = parseAddresses(cc);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
    >
      <KeyboardAvoidingView
        style={styles.safe}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.top}>
            <IconButton name="chevron-back" label="Close reply composer" onPress={onClose} />
            <Text style={styles.topTitle}>Reply draft</Text>
            <View style={styles.topSpacer} />
          </View>
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
          <Text style={s.kicker}>SAVED MAIL</Text>
          <Text style={s.h1Small}>{source?.subject || "Message"}</Text>
          {source ? (
            <View style={styles.sourceCard}>
              <Text style={styles.sourceLine}>
                From {source.from || source.senderEmail || "Sender unavailable"}
              </Text>
              <Text style={styles.sourceLine}>
                Account · {source.accountEmail}
              </Text>
              <Text style={styles.sourceLine}>Source last checked · {sourceAt}</Text>
              <Text style={styles.excerptLabel}>SAVED EXCERPT</Text>
              <Text style={styles.excerpt}>
                {source.snippet || "No message excerpt was saved."}
              </Text>
              <Text style={styles.disclaimer}>
                This reply uses saved message details and excerpt only. The full message body is not available here.
              </Text>
            </View>
          ) : null}

          <Text style={s.label}>Reply type</Text>
          <View style={styles.modeRow}>
            {([
              ["reply", "Reply"],
              ["reply_all", "Reply all"],
            ] as const).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityState={{ selected: mode === value, disabled: checking || busy }}
                disabled={checking || busy}
                onPress={() => changeMode(value)}
                style={[styles.mode, mode === value && styles.modeSelected]}
              >
                <Text style={[styles.modeText, mode === value && styles.modeTextSelected]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>

          {!source?.identity ? null : !source.verifiedSelfEmail ? (
            <Text style={styles.warning}>
              Check recipients — your own address could not be verified.
            </Text>
          ) : null}
          <Field
            label="To"
            value={to}
            onChangeText={setTo}
            placeholder="name@example.com"
            keyboardType="email-address"
          />
          <Field
            label="Cc"
            value={cc}
            onChangeText={setCc}
            placeholder="Optional"
            keyboardType="email-address"
          />
          <Field
            label="Your reply"
            value={text}
            onChangeText={setText}
            placeholder="Write a reply…"
            multiline
          />
          {checking ? <Text style={s.disclaimer}>Checking saved message…</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            label="Save for review"
            disabled={
              busy || checking || !source || !text.trim() || !parsedTo.length
            }
            onPress={async () => {
              if (!source || !messageId) return;
              setError("");
              try {
                const proposal = await onSave({
                  messageId,
                  mode,
                  sourceDigest: source.sourceDigest,
                  text,
                  to: parsedTo,
                  cc: parsedCc,
                });
                if (proposal) onClose();
                else setError("Another action is in progress. Try saving this reply again.");
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not save this reply for review.",
                );
              }
            }}
          />
          <Button label="Cancel" tone="quiet" disabled={busy} onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function parseAddresses(value: string) {
  return value
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const styles = {
  safe: { flex: 1, backgroundColor: C.bg },
  safeArea: { flex: 1, backgroundColor: C.bg },
  top: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    borderBottomColor: C.border,
    borderBottomWidth: 1,
  },
  topTitle: { color: C.text, fontSize: 16, fontWeight: "600" as const },
  topSpacer: { width: 46 },
  content: { paddingHorizontal: 24, paddingTop: 22, paddingBottom: 36, gap: 13, width: "100%" as const, maxWidth: 620, alignSelf: "center" as const },
  sourceCard: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 15,
    gap: 7,
  },
  sourceLine: { color: C.muted, fontSize: 12, lineHeight: 18 },
  excerptLabel: { color: C.sage, fontSize: 10, fontWeight: "700" as const, letterSpacing: 1.1, marginTop: 5 },
  excerpt: { color: C.text, fontSize: 13, lineHeight: 20 },
  disclaimer: { color: C.muted, fontSize: 11, lineHeight: 17 },
  warning: { color: C.sage, fontSize: 12, lineHeight: 18 },
  modeRow: { flexDirection: "row" as const, gap: 8 },
  mode: { minHeight: 44, minWidth: 100, paddingHorizontal: 14, borderWidth: 1, borderColor: C.border, borderRadius: 12, justifyContent: "center" as const, alignItems: "center" as const, backgroundColor: C.card },
  modeSelected: { backgroundColor: C.text, borderColor: C.text },
  modeText: { color: C.muted, fontSize: 12, fontWeight: "600" as const },
  modeTextSelected: { color: C.bg },
  error: { color: C.red, fontSize: 12, lineHeight: 18 },
};
