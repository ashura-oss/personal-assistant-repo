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
import type {
  AppController,
  ContextDocument,
  MailReplySourceSnapshot,
  MailReplyTextGenerationResult,
  Note,
  Proposal,
  SelectedMailTextSnapshot,
} from "../core";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Field, IconButton } from "./primitives";
import { C, s } from "./theme";

type ReplyMode = "reply" | "reply_all";
const BRIEF_LIMIT = 4 * 1024;
const TEXT_LIMIT = 16 * 1024;

export function MailReplyComposer({
  visible,
  messageId,
  controller,
  busy,
  demoMode = false,
  notes,
  documents,
  onClose,
  onSave,
}: {
  visible: boolean;
  messageId: string | null;
  controller: AppController;
  busy: boolean;
  demoMode?: boolean;
  notes: Note[];
  documents: ContextDocument[];
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
  const [brief, setBrief] = useState("");
  const [checking, setChecking] = useState(false);
  const [loadingText, setLoadingText] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [bodySnapshot, setBodySnapshot] =
    useState<SelectedMailTextSnapshot | null>(null);
  const [showFullBody, setShowFullBody] = useState(false);
  const [bodyStatus, setBodyStatus] = useState("");
  const [useSavedExcerpt, setUseSavedExcerpt] = useState(false);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [notePicker, setNotePicker] = useState(false);
  const [error, setError] = useState("");
  const [generationNotice, setGenerationNotice] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");
  const requestSequence = useRef(0);
  const bodyLoadSequence = useRef(0);
  const generationSequence = useRef(0);
  const composerRevision = useRef(0);
  const sourceRef = useRef<MailReplySourceSnapshot | null>(null);
  const modeRef = useRef<ReplyMode>("reply");
  const visibleRef = useRef(visible);
  const activeMessageId = useRef(messageId);

  const invalidatePendingGeneration = useCallback(() => {
    composerRevision.current += 1;
    generationSequence.current += 1;
    setGenerationNotice("");
    setGeneratedAt("");
  }, []);

  const applySource = useCallback(
    async (nextMode: ReplyMode, initial: boolean, deliberateRebind = false) => {
      if (!messageId) return;
      const sequence = ++requestSequence.current;
      setChecking(true);
      setError("");
      setBodyStatus("");
      if (initial) {
        setText("");
        setBrief("");
        setSelectedNote(null);
        setMode("reply");
      }
      if (deliberateRebind) {
        invalidatePendingGeneration();
        setBodySnapshot(null);
        setShowFullBody(false);
        setUseSavedExcerpt(false);
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
        const previousSourceDigest = sourceRef.current?.sourceDigest;
        const previousMode = modeRef.current;
        sourceRef.current = result.source;
        setSource(result.source);
        const defaults = result.defaults?.[nextMode];
        modeRef.current = nextMode;
        setMode(nextMode);
        setTo((defaults?.to ?? []).join(", "));
        setCc((defaults?.cc ?? []).join(", "));
        if (!initial && previousSourceDigest !== result.source.sourceDigest) {
          setBodySnapshot(null);
          setShowFullBody(false);
          setUseSavedExcerpt(false);
          setBodyStatus("The source changed. Load its text again before generating.");
        } else if (deliberateRebind) {
          setBodyStatus("Updated recipients from the checked message. Your typed reply was kept.");
        }
        if (nextMode !== previousMode) invalidatePendingGeneration();
        const cached = await controller.getMailReplyText(messageId);
        if (sequence !== requestSequence.current) return;
        if (
          cached.status === "current" &&
          cached.snapshot?.sourceDigest === result.source.sourceDigest
        ) {
          setBodySnapshot(cached.snapshot);
          setShowFullBody(false);
          setUseSavedExcerpt(cached.snapshot.completeness === "complete_text");
          setBodyStatus(
            cached.snapshot.completeness === "complete_text"
              ? "Previously loaded message text is ready to use."
              : "A saved excerpt is available. Choose it explicitly before generating.",
          );
        } else {
          setBodySnapshot(null);
          setUseSavedExcerpt(false);
          if (cached.status === "stale" || cached.status === "unavailable") {
            setBodyStatus("The saved text needs a fresh check before it can be used.");
          }
        }
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
    [controller, invalidatePendingGeneration, messageId],
  );

  useEffect(() => {
    visibleRef.current = visible;
    activeMessageId.current = messageId;
    if (visible && messageId) {
      const timer = setTimeout(() => void applySource("reply", true), 0);
      return () => {
        clearTimeout(timer);
        requestSequence.current += 1;
        bodyLoadSequence.current += 1;
        generationSequence.current += 1;
        setLoadingText(false);
      };
    }
    requestSequence.current += 1;
    bodyLoadSequence.current += 1;
    generationSequence.current += 1;
  }, [applySource, messageId, visible]);

  const changeMode = (nextMode: ReplyMode) => {
    if (nextMode !== mode && !checking && !busy && !generating) {
      void applySource(nextMode, false);
    }
  };

  const loadMessageText = async () => {
    if (!messageId || !source || loadingText || busy) return;
    const requestedMessageId = messageId;
    const requestedSourceDigest = source.sourceDigest;
    const sequence = ++bodyLoadSequence.current;
    setLoadingText(true);
    setError("");
    setBodyStatus("");
    setBodySnapshot(null);
    setShowFullBody(false);
    setUseSavedExcerpt(false);
    invalidatePendingGeneration();
    try {
      const result = await controller.loadMailReplyText({
        messageId: requestedMessageId,
        sourceDigest: requestedSourceDigest,
      });
      if (sequence !== bodyLoadSequence.current || !visibleRef.current || activeMessageId.current !== requestedMessageId) return;
      if (sourceRef.current?.sourceDigest !== requestedSourceDigest) {
        setBodyStatus("The saved message changed. Check the updated message before loading text.");
        return;
      }
      if (result.status === "source_changed") {
        setBodySnapshot(null);
        setUseSavedExcerpt(false);
        setBodyStatus("The saved message changed. Check the updated message before loading text.");
        return;
      }
      if (result.status !== "current" || !result.snapshot) {
        setBodySnapshot(null);
        setUseSavedExcerpt(false);
        setBodyStatus(
          result.status === "stale"
            ? "This message needs a fresh mail check before its text can be loaded."
            : "Message text is unavailable. You can still write a reply manually.",
        );
        return;
      }
      if (result.snapshot.messageId !== requestedMessageId || result.snapshot.sourceDigest !== requestedSourceDigest) {
        setBodyStatus("The saved message changed. Check the updated message before loading text.");
        return;
      }
      setBodySnapshot(result.snapshot);
      setShowFullBody(false);
      const complete = result.snapshot.completeness === "complete_text";
      setUseSavedExcerpt(complete);
      setBodyStatus(
        complete
          ? "Message text loaded. Review the exact text below before generating."
          : result.snapshot.completeness === "excerpt"
            ? "Only an excerpt is available. Choose it explicitly before generating."
            : "No usable message text was returned. You can still write a reply manually.",
      );
    } catch (cause) {
      if (sequence === bodyLoadSequence.current && visibleRef.current && activeMessageId.current === requestedMessageId) {
        setBodyStatus(messageOf(cause, "Could not load message text."));
      }
    } finally {
      if (sequence === bodyLoadSequence.current) setLoadingText(false);
    }
  };

  const sourceChanged = async () => {
    if (checking || !messageId) return;
    await applySource(mode, false, true);
  };

  const generate = async () => {
    if (!source || !bodySnapshot || !messageId || generating || busy) return;
    if (bodySnapshot.completeness === "excerpt" && !useSavedExcerpt) {
      setError("Choose “Use saved excerpt” before generating from this text.");
      return;
    }
    if (!bodySnapshot.textDigest || !bodySnapshot.text) {
      setError("There is no checked message text to use. You can still write manually.");
      return;
    }
    const combinedBriefBytes = utf8Bytes(brief.trim()) + (selectedNote ? utf8Bytes(selectedNote.transcript) : 0);
    if (combinedBriefBytes > BRIEF_LIMIT) {
      setError("The reply brief and selected note together must stay under 4 KB.");
      return;
    }
    const revision = composerRevision.current;
    const sequence = ++generationSequence.current;
    setGenerating(true);
    setError("");
    setGenerationNotice("");
    try {
      const result: MailReplyTextGenerationResult =
        await controller.generateMailReplyText({
          messageId,
          sourceDigest: source.sourceDigest,
          textDigest: bodySnapshot.textDigest,
          mode,
          to: parseAddresses(to),
          cc: parseAddresses(cc),
          brief: brief.trim(),
          composerRevision: revision,
          ...(selectedNote
            ? { noteId: selectedNote.id, noteRevision: selectedNote.revision }
            : {}),
        });
      if (sequence !== generationSequence.current || revision !== composerRevision.current || result.composerRevision !== revision) {
        setGenerationNotice("Reply wasn’t applied because the source or reply details changed.");
        return;
      }
      if (result.status !== "current" || !result.text) {
        setGenerationNotice(
          result.status === "source_changed"
            ? "The saved message changed. Check the updated message, then generate again."
            : result.status === "stale"
              ? "The checked message text is stale. Load it again before generating."
              : "Reply generation is unavailable. Your manually written text is unchanged.",
        );
        return;
      }
      setText(result.text);
      composerRevision.current += 1;
      generationSequence.current += 1;
      setGeneratedAt(result.generatedAt ?? "");
      setGenerationNotice(
        result.fromCache
          ? demoMode
            ? "Using saved sample reply · no API used. Review and edit this text before saving."
            : "Using saved reply · no new API call. Review and edit this text before saving."
          : demoMode
            ? "Sample AI reply · no API used. Review and edit this text before saving."
            : "Generated once from the selected text and context. Review and edit before saving.",
      );
    } catch (cause) {
      if (sequence === generationSequence.current) {
        setGenerationNotice(messageOf(cause, "Reply generation failed. Your typed text was kept."));
      }
    } finally {
      setGenerating(false);
    }
  };

  const sourceAt = source?.observedAt
    ? new Date(source.observedAt).toLocaleString()
    : "Unavailable";
  const parsedTo = parseAddresses(to);
  const parsedCc = parseAddresses(cc);
  const combinedBriefBytes = utf8Bytes(brief.trim()) + (selectedNote ? utf8Bytes(selectedNote.transcript) : 0);
  const includedGuidance = documents.filter((doc) => /^memory\/(?:RULES|ROUTINES)\.md$/i.test(doc.path));
  const aiReady =
    controller.getSnapshot().settings.mode === "provider" &&
    Boolean(controller.getSnapshot().settings.openAiEndpoint) &&
    Boolean(controller.getSnapshot().settings.openAiDeployment);
  const selectedTextUsable = Boolean(
    bodySnapshot?.text &&
      bodySnapshot.textDigest &&
      bodySnapshot.bytes <= TEXT_LIMIT &&
      (bodySnapshot.completeness === "complete_text" || useSavedExcerpt),
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.top}>
            <IconButton name="chevron-back" label="Close reply composer" onPress={onClose} />
            <Text style={styles.topTitle}>Reply draft</Text>
            <View style={styles.topSpacer} />
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={s.kicker}>SAVED MAIL</Text>
            <Text style={s.h1Small}>{source?.subject || "Message"}</Text>
            {source ? (
              <View style={styles.sourceCard}>
                <Text style={styles.sourceLine}>From {source.from || source.senderEmail || "Sender unavailable"}</Text>
                <Text style={styles.sourceLine}>Account · {source.accountEmail}</Text>
                <Text style={styles.sourceLine}>Source last checked · {sourceAt}</Text>
                <Text style={styles.excerptLabel}>SAVED EXCERPT</Text>
                <Text style={styles.excerpt}>{source.snippet || "No message excerpt was saved."}</Text>
                <Text style={styles.disclaimer}>This reply uses saved message details and selected text only. It does not load the full conversation.</Text>
              </View>
            ) : null}

            <Text style={s.label}>Reply type</Text>
            <View style={styles.modeRow}>
              {([ ["reply", "Reply"], ["reply_all", "Reply all"] ] as const).map(([value, label]) => (
                <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected: mode === value, disabled: checking || busy || generating }} disabled={checking || busy || generating} onPress={() => changeMode(value)} style={[styles.mode, mode === value && styles.modeSelected]}>
                  <Text style={[styles.modeText, mode === value && styles.modeTextSelected]}>{label}</Text>
                </Pressable>
              ))}
            </View>
            {source?.identity && !source.verifiedSelfEmail ? <Text style={styles.warning}>Check recipients — your own address could not be verified.</Text> : null}
            <Field label="To" value={to} onChangeText={(value) => { invalidatePendingGeneration(); setTo(value); }} placeholder="name@example.com" keyboardType="email-address" />
            <Field label="Cc" value={cc} onChangeText={(value) => { invalidatePendingGeneration(); setCc(value); }} placeholder="Optional" keyboardType="email-address" />

            <View style={styles.sectionHeading}>
              <Text style={s.label}>Message context</Text>
              <Text style={styles.limitText}>Selected text is capped at 16 KB</Text>
            </View>
            <Button label={loadingText ? "Loading message text…" : "Load message text"} disabled={!source || checking || loadingText || busy || generating} tone="quiet" onPress={() => void loadMessageText()} />
            {bodySnapshot ? <Text style={styles.contextMeta}>{bodySnapshot.representation === "plain" ? "Plain message text" : bodySnapshot.representation === "snippet" ? "Saved excerpt" : "Unavailable"} · {bodySnapshot.completeness.replaceAll("_", " ")} · {bodySnapshot.bytes.toLocaleString()} bytes · checked {new Date(bodySnapshot.checkedAt).toLocaleString()}</Text> : null}
            {bodySnapshot?.text ? <Text selectable numberOfLines={showFullBody ? undefined : 8} style={styles.contextText}>{bodySnapshot.text}</Text> : null}
            {bodySnapshot?.text && bodySnapshot.bytes > 1200 ? <Button label={showFullBody ? "Show less selected text" : "Show full selected text"} tone="quiet" onPress={() => setShowFullBody((current) => !current)} /> : null}
            {bodySnapshot?.omissionReasons.length ? <Text style={styles.disclaimer}>Not included: {bodySnapshot.omissionReasons.join(", ")}</Text> : null}
            {bodySnapshot?.completeness === "excerpt" && !useSavedExcerpt ? <Button label="Use this excerpt" tone="quiet" disabled={busy || generating} onPress={() => { invalidatePendingGeneration(); setUseSavedExcerpt(true); setBodyStatus("Excerpt selected. Review it before generating."); }} /> : null}
            {bodyStatus ? <Text style={styles.disclaimer}>{bodyStatus}</Text> : null}

            <Field label="What should the reply say?" value={brief} onChangeText={(value) => { if (utf8Bytes(value.trim()) + (selectedNote ? utf8Bytes(selectedNote.transcript) : 0) <= BRIEF_LIMIT) { invalidatePendingGeneration(); setBrief(value); setError(""); } else setError("The reply brief and selected note together must stay under 4 KB."); }} placeholder="Optional guidance for the reply" multiline />
            <Text style={styles.limitText}>{combinedBriefBytes.toLocaleString()} / 4,096 combined bytes</Text>
            <Button label={selectedNote ? `Source note · ${selectedNote.title}` : "Choose a saved note"} tone="quiet" disabled={busy || generating} onPress={() => setNotePicker(true)} />
            {selectedNote ? <View style={styles.contextCard}><Text style={styles.sourceLine}>Selected transcript · current version {selectedNote.revision}</Text><Text selectable style={styles.contextText}>{selectedNote.transcript}</Text><Button label="Remove selected note" tone="quiet" onPress={() => { invalidatePendingGeneration(); setSelectedNote(null); }} /></View> : <Text style={styles.disclaimer}>No note is included unless you choose one.</Text>}
            <View style={styles.contextCard}>
              <Text style={styles.sourceLine}>Saved guidance included · {includedGuidance.length ? includedGuidance.map((doc) => doc.path).join(", ") : "none"}</Text>
              {includedGuidance.map((doc) => <View key={doc.path} style={styles.guidanceItem}><Text style={styles.contextMeta}>{doc.path} · version {doc.revision}</Text><Text selectable style={styles.contextText}>{doc.content}</Text></View>)}
            </View>
            <Text style={styles.disclaimer}>Before Generate, the request uses the checked text shown above, recipients, this brief, the note you selected, and the saved guidance shown here. The brief and selected note together are limited to 4 KB; message text is limited to 16 KB, within the app&apos;s request byte limit.</Text>

            {demoMode ? <Text style={styles.demoBadge}>SAMPLE AI REPLY · NO API USED</Text> : null}
            <Button label={generating ? "Generating reply…" : "Generate reply"} disabled={busy || checking || loadingText || generating || !selectedTextUsable || !source || !parsedTo.length || combinedBriefBytes > BRIEF_LIMIT || (!demoMode && !aiReady)} onPress={() => void generate()} />
            {!demoMode && !aiReady ? <Text style={styles.disclaimer}>Set provider mode, an Azure OpenAI endpoint, and a deployment in Settings to enable generation.</Text> : null}
            {!selectedTextUsable && !demoMode ? <Text style={styles.disclaimer}>Load checked message text and select any excerpt explicitly before generating.</Text> : null}
            {generatedAt ? <Text style={styles.contextMeta}>Generated · {new Date(generatedAt).toLocaleString()}</Text> : null}
            {generationNotice ? <Text style={styles.disclaimer}>{generationNotice}</Text> : null}

            <Field label="Your reply" value={text} onChangeText={(value) => { invalidatePendingGeneration(); setText(value); }} placeholder="Write or generate a reply…" multiline />
            {checking ? <Text style={s.disclaimer}>Checking saved message…</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {(!source || bodyStatus.toLowerCase().includes("changed") || generationNotice.toLowerCase().includes("message changed")) && !checking && messageId ? <Button label="Check updated message" tone="quiet" disabled={busy} onPress={() => void sourceChanged()} /> : null}
            <Button label="Save for review" disabled={busy || checking || generating || !source || !text.trim() || !parsedTo.length} onPress={async () => {
              if (!source || !messageId) return;
              setError("");
              try {
                const proposal = await onSave({ messageId, mode, sourceDigest: source.sourceDigest, text, to: parsedTo, cc: parsedCc });
                if (proposal) onClose();
                else setError("Another action is in progress. Try saving this reply again.");
              } catch (cause) { setError(messageOf(cause, "Could not save this reply for review.")); }
            }} />
            <Button label="Cancel" tone="quiet" disabled={busy || generating} onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
      <NotePicker visible={notePicker} notes={notes} selectedId={selectedNote?.id} onClose={() => setNotePicker(false)} onChoose={(note) => { if (utf8Bytes(brief.trim()) + utf8Bytes(note.transcript) > BRIEF_LIMIT) { setError("The selected note leaves less than the current brief needs. Shorten the brief first."); return; } invalidatePendingGeneration(); setSelectedNote(note); setNotePicker(false); }} />
    </Modal>
  );
}

function NotePicker({ visible, notes, selectedId, onClose, onChoose }: { visible: boolean; notes: Note[]; selectedId?: string; onClose: () => void; onChoose: (note: Note) => void }) {
  const eligible = notes.filter((note) => note.transcript.trim() && utf8Bytes(note.transcript) <= BRIEF_LIMIT);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.pickerBackdrop}>
        <View style={styles.pickerCard}>
          <Text style={styles.pickerTitle}>Choose one saved note</Text>
          <Text style={styles.disclaimer}>Only the selected current transcript is included with a later Generate request.</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {eligible.length ? eligible.map((note) => <Pressable key={note.id} accessibilityRole="button" accessibilityLabel={`Choose note ${note.title}`} accessibilityState={{ selected: selectedId === note.id }} onPress={() => onChoose(note)} style={styles.noteOption}>
              <Text style={styles.noteTitle}>{note.title}</Text><Text style={styles.noteExcerpt} numberOfLines={3}>{note.transcript}</Text>
            </Pressable>) : <Text style={styles.disclaimer}>No saved transcript under 4 KB is available.</Text>}
          </ScrollView>
          <Button label="Cancel" tone="quiet" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function parseAddresses(value: string) {
  return value.split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).length;
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const styles = {
  safe: { flex: 1, backgroundColor: C.bg },
  safeArea: { flex: 1, backgroundColor: C.bg },
  top: { paddingHorizontal: 18, paddingVertical: 8, flexDirection: "row" as const, alignItems: "center" as const, borderBottomColor: C.border, borderBottomWidth: 1 },
  topTitle: { color: C.text, fontSize: 16, fontWeight: "600" as const },
  topSpacer: { width: 46 },
  content: { paddingHorizontal: 24, paddingTop: 22, paddingBottom: 36, gap: 13, width: "100%" as const, maxWidth: 620, alignSelf: "center" as const },
  sourceCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 16, padding: 15, gap: 7 },
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
  sectionHeading: { gap: 3 },
  limitText: { color: C.muted, fontSize: 10, lineHeight: 15 },
  contextMeta: { color: C.sage, fontSize: 11, lineHeight: 17 },
  contextText: { color: C.text, fontSize: 12, lineHeight: 18, backgroundColor: C.card, borderRadius: 12, padding: 12, borderColor: C.border, borderWidth: 1 },
  contextCard: { gap: 8, padding: 12, backgroundColor: C.card, borderRadius: 12, borderColor: C.border, borderWidth: 1 },
  guidanceItem: { gap: 6 },
  demoBadge: { color: C.sage, fontSize: 10, fontWeight: "700" as const, letterSpacing: 1, textAlign: "center" as const, paddingVertical: 8 },
  pickerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.64)", justifyContent: "flex-end" as const },
  pickerCard: { backgroundColor: C.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderColor: C.border, borderWidth: 1, padding: 20, gap: 12, maxHeight: "80%" as const },
  pickerTitle: { color: C.text, fontSize: 20, lineHeight: 26, fontWeight: "600" as const },
  noteOption: { minHeight: 64, justifyContent: "center" as const, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 4 },
  noteTitle: { color: C.text, fontSize: 14, fontWeight: "600" as const },
  noteExcerpt: { color: C.muted, fontSize: 12, lineHeight: 18 },
};
