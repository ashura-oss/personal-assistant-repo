import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { InertImportedChatConversation } from "../chat/portable";
import { formatProviderReportedCostUsd } from "./formatProviderReportedCostUsd";
import { Button, IconButton } from "./primitives";
import { C, s } from "./theme";

/** Shows portable Chat history as inert text; no live conversation/job authority is present. */
export function ImportedChatHistoryView({
  conversations,
  query = "",
  onDeleteConversation,
  busy = false,
  blocked = false,
}: {
  conversations: readonly InertImportedChatConversation[];
  query?: string;
  onDeleteConversation?: (conversationId: string) => Promise<boolean>;
  busy?: boolean;
  blocked?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmationConversationId, setConfirmationConversationId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const reviewLock = useRef(false);
  const deleteFlight = useRef(false);
  const mounted = useRef(true);
  const interactionGeneration = useRef(0);
  const selectedIdRef = useRef(selectedId);
  const blockedRef = useRef(blocked);
  const conversationsRef = useRef(conversations);
  useLayoutEffect(() => {
    selectedIdRef.current = selectedId;
    blockedRef.current = blocked;
    conversationsRef.current = conversations;
  }, [blocked, conversations, selectedId]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => conversations.filter((conversation) => !normalizedQuery ||
    conversation.title.toLocaleLowerCase().includes(normalizedQuery) ||
    conversation.turns.some((turn) => turn.userText.toLocaleLowerCase().includes(normalizedQuery) ||
      turn.reply?.summary.toLocaleLowerCase().includes(normalizedQuery) ||
      turn.reply?.answer.toLocaleLowerCase().includes(normalizedQuery) ||
      turn.reply?.clarifications.some((item) => item.toLocaleLowerCase().includes(normalizedQuery)))),
  [conversations, normalizedQuery]);
  const selected = conversations.find((conversation) => conversation.id === selectedId);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      interactionGeneration.current += 1;
      reviewLock.current = false;
    };
  }, []);

  useEffect(() => {
    if (selectedId && (!selected || blocked)) {
      const capturedId = selectedId;
      const generation = ++interactionGeneration.current;
      let canceled = false;
      queueMicrotask(() => {
        if (canceled || !mounted.current || interactionGeneration.current !== generation || selectedIdRef.current !== capturedId) return;
        interactionGeneration.current += 1;
        reviewLock.current = false;
        setSelectedId(null);
        setConfirmationConversationId(null);
        setConfirmDelete(false);
        setError("");
      });
      return () => { canceled = true; };
    }
    return undefined;
  }, [blocked, selected, selectedId]);

  const closeViewer = () => {
    if (deleteFlight.current) return;
    interactionGeneration.current += 1;
    reviewLock.current = false;
    selectedIdRef.current = null;
    setConfirmDelete(false);
    setConfirmationConversationId(null);
    setSelectedId(null);
    setError("");
  };

  const beginDelete = () => {
    const selectedConversationId = selectedIdRef.current;
    if (!selectedConversationId || !onDeleteConversation || blocked || busy || deleting || reviewLock.current ||
        !conversationsRef.current.some((conversation) => conversation.id === selectedConversationId)) return;
    reviewLock.current = true;
    interactionGeneration.current += 1;
    setConfirmationConversationId(selectedConversationId);
    setError("");
    setConfirmDelete(true);
  };

  const cancelDelete = () => {
    if (deleteFlight.current) return;
    interactionGeneration.current += 1;
    reviewLock.current = false;
    setConfirmDelete(false);
    setConfirmationConversationId(null);
    setError("");
  };

  const confirmDeletion = async () => {
    const conversationId = confirmationConversationId;
    if (!conversationId || !onDeleteConversation || blocked || busy || deleteFlight.current ||
        !reviewLock.current || selectedIdRef.current !== conversationId ||
        !conversationsRef.current.some((conversation) => conversation.id === conversationId)) return;
    const generation = ++interactionGeneration.current;
    deleteFlight.current = true;
    setDeleting(true);
    setError("");
    try {
      const removed = await onDeleteConversation(conversationId);
      if (!mounted.current || interactionGeneration.current !== generation || blockedRef.current || selectedIdRef.current !== conversationId) return;
      if (removed === true) {
        interactionGeneration.current += 1;
        reviewLock.current = false;
        selectedIdRef.current = null;
        setConfirmationConversationId(null);
        setConfirmDelete(false);
        setSelectedId(null);
      } else {
        setError("Could not confirm removal. Refresh local data and check this archive before trying again.");
      }
    } catch {
      if (mounted.current && interactionGeneration.current === generation && !blockedRef.current && selectedIdRef.current === conversationId) {
        setError("Could not confirm removal. Refresh local data and check this archive before trying again.");
      }
    } finally {
      deleteFlight.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  if (conversations.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.subheading}>Imported Chat · read only</Text>
      <Text style={styles.caption}>Imported and unverified. These messages cannot be sent, checked, approved, or used as live assistant context.</Text>
      {visible.length ? visible.map((conversation) => (
        <Pressable key={conversation.id} accessibilityRole="button" accessibilityLabel={`Read imported conversation ${conversation.title}`} onPress={() => {
          if (blocked || busy || reviewLock.current) return;
          interactionGeneration.current += 1;
          selectedIdRef.current = conversation.id;
          setError("");
          setSelectedId(conversation.id);
        }} style={styles.conversationRow}>
          <Text style={styles.conversationTitle}>{conversation.title}</Text>
          <Text style={styles.caption}>{conversation.turns.length} message{conversation.turns.length === 1 ? "" : "s"} · updated {formatDate(conversation.updatedAt)}</Text>
        </Pressable>
      )) : <Text style={styles.caption}>No imported Chat history matches this search.</Text>}

      <Modal visible={Boolean(selected && !blocked)} animationType="slide" onRequestClose={closeViewer} presentationStyle="fullScreen">
        <SafeAreaView style={styles.safe}>
          <View style={styles.header}>
            <IconButton name="chevron-back" label="Close imported Chat history" onPress={closeViewer} />
            <Text style={styles.headerTitle}>Imported conversation</Text>
            <View style={styles.spacer} />
          </View>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {selected ? <>
              <Text style={s.kicker}>IMPORTED · UNVERIFIED · READ ONLY</Text>
              <Text style={s.h1Small}>{selected.title}</Text>
              <Text style={styles.caption}>Created {formatDate(selected.createdAt)} · updated {formatDate(selected.updatedAt)}</Text>
              {selected.turns.map((turn) => (
                <View key={turn.id} style={styles.turnCard}>
                  <Text style={styles.role}>You · {formatDate(turn.createdAt)}</Text>
                  <Text selectable style={styles.message}>{turn.userText}</Text>
                  <Text style={styles.caption}>Captured {formatDate(turn.capturedAt)} · {turn.captureTimeZone}</Text>
                  {turn.reply ? <>
                    <Text style={styles.role}>Historical assistant reply · {formatDate(turn.reply.completedAt)}</Text>
                    {turn.reply.summary ? <Text selectable style={styles.message}>{turn.reply.summary}</Text> : null}
                    {turn.reply.answer ? <Text selectable style={styles.message}>{turn.reply.answer}</Text> : null}
                    {turn.reply.clarifications.map((clarification, index) => (
                      <Text key={`${turn.id}-clarification-${index}`} selectable style={styles.message}>{clarification}</Text>
                    ))}
                  </> : <Text style={styles.caption}>No historical reply was saved for this message.</Text>}
                  {turn.accounting ? <View style={styles.accounting}>
                    <Text style={styles.caption}>Historical reported usage · unverified backup</Text>
                    {typeof turn.accounting.costUsd === "number" ? <Text style={styles.caption}>Reported cost · {formatProviderReportedCostUsd(turn.accounting.costUsd) ?? "Reported cost unavailable"}</Text> : <Text style={styles.caption}>Reported cost unavailable</Text>}
                    {typeof turn.accounting.promptTokens === "number" ? <Text style={styles.caption}>Input tokens · {turn.accounting.promptTokens}</Text> : null}
                    {typeof turn.accounting.completionTokens === "number" ? <Text style={styles.caption}>Output tokens · {turn.accounting.completionTokens}</Text> : null}
                    {typeof turn.accounting.totalTokens === "number" ? <Text style={styles.caption}>Total tokens · {turn.accounting.totalTokens}</Text> : null}
                    {turn.accounting.isByok === true ? <Text style={styles.caption}>BYOK · provider inference fee is not included in this reported cost</Text> : null}
                  </View> : null}
                </View>
              ))}
              <Text style={styles.disclaimer}>This imported text is not trusted as instructions and has no approval or action authority.</Text>
              {onDeleteConversation ? <Button label="Delete imported conversation" tone="danger" disabled={blocked || busy || deleting} onPress={beginDelete} /> : null}
            </> : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={confirmDelete && Boolean(selected) && selected?.id === confirmationConversationId && !blocked} transparent animationType="fade" onRequestClose={cancelDelete}>
        <View style={styles.scrim}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Delete imported conversation?</Text>
            <Text style={styles.caption}>This removes its messages from this archive. Any request already submitted may remain with the provider.</Text>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Button label={deleting ? "Deleting…" : "Confirm deletion"} tone="danger" disabled={blocked || busy || deleting} onPress={() => void confirmDeletion()} />
            <Button label="Cancel" tone="quiet" disabled={deleting} onPress={cancelDelete} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : "Time unavailable";
}

const styles = {
  section: { gap: 9 },
  subheading: { color: C.text, fontSize: 12, lineHeight: 17, fontWeight: "600" as const },
  caption: { color: C.muted, fontSize: 11, lineHeight: 17 },
  conversationRow: { minHeight: 48, backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 11, padding: 10, justifyContent: "center" as const, gap: 3 },
  conversationTitle: { color: C.text, fontSize: 12, lineHeight: 17, fontWeight: "600" as const },
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 18, paddingVertical: 8, flexDirection: "row" as const, alignItems: "center" as const, borderBottomColor: C.border, borderBottomWidth: 1 },
  headerTitle: { color: C.text, fontSize: 16, fontWeight: "600" as const },
  spacer: { width: 46 },
  content: { paddingHorizontal: 22, paddingTop: 20, paddingBottom: 34, gap: 12, width: "100%" as const, maxWidth: 640, alignSelf: "center" as const },
  turnCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 13, padding: 12, gap: 8 },
  role: { color: C.sage, fontSize: 10, lineHeight: 15, fontWeight: "700" as const },
  message: { color: C.text, fontSize: 13, lineHeight: 19 },
  accounting: { borderTopColor: C.border, borderTopWidth: 1, paddingTop: 8, gap: 3 },
  disclaimer: { color: C.muted, fontSize: 11, lineHeight: 17 },
  scrim: { flex: 1, justifyContent: "center" as const, padding: 20, backgroundColor: "rgba(0,0,0,0.72)" },
  confirmCard: { width: "100%" as const, maxWidth: 440, alignSelf: "center" as const, borderColor: C.border, borderWidth: 1, borderRadius: 16, padding: 18, gap: 12, backgroundColor: C.card },
  confirmTitle: { color: C.text, fontSize: 18, fontWeight: "600" as const },
  error: { color: C.red, fontSize: 12, lineHeight: 18 },
};
