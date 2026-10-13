import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { ChatConversationDTO, ChatTurnDTO } from '../chat/types';
import { AssistantBatchJobCard } from './AssistantBatchJobCard';
import { Button } from './primitives';
import { isAcceptedChatSubmission } from './chatSubmission';
import { C, s } from './theme';

export type ChatConversation = ChatConversationDTO;
export type ChatTurn = ChatTurnDTO;
type ChatRefinementEffort = 'medium' | 'high' | 'max';
type ChatRefinementRequest = Readonly<{
  conversationId: string;
  parentTurnId: string;
  parentJobId: string;
  effort: ChatRefinementEffort;
}>;
type ChatRefinementReview = ChatRefinementRequest & Readonly<{ generation: number }>;

export type ChatSectionProps = {
  conversations: readonly ChatConversation[];
  selectedConversationId?: string;
  turns: readonly ChatTurn[];
  busy: boolean;
  enabled: boolean;
  reviewBlocked?: boolean;
  recoveryMessage?: string;
  disabledReason?: string;
  samplePreview?: boolean;
  onDeleteReviewChange?: (open: boolean) => void;
  onInteractionLockChange?: (active: boolean) => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation?: (conversationId: string) => Promise<unknown> | unknown;
  onCreateConversation: () => void;
  onSend: (text: string) => Promise<unknown>;
  onOpenActions: (noteId: string) => void;
  onCheckJob: (jobId: string) => Promise<unknown> | unknown;
  onRetryJobCleanup: (jobId: string) => Promise<unknown> | unknown;
  onRefineTurn?: (request: ChatRefinementRequest) => Promise<unknown>;
};

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Time unavailable';
}

function ConversationButton({
  conversation,
  selected,
  disabled,
  sendLock,
  deleteLock,
  refinementLock,
  onSelect,
}: {
  conversation: ChatConversation;
  selected: boolean;
  disabled: boolean;
  sendLock: React.RefObject<boolean>;
  deleteLock: React.RefObject<boolean>;
  refinementLock: React.RefObject<boolean>;
  onSelect: (conversationId: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Open conversation ${conversation.title}`}
      disabled={disabled}
      onPress={() => { if (!disabled && !sendLock.current && !deleteLock.current && !refinementLock.current) onSelect(conversation.id); }}
      style={[styles.conversation, selected && styles.conversationSelected]}
    >
      <Text numberOfLines={2} style={styles.conversationTitle}>{conversation.title}</Text>
      <Text style={styles.meta}>{dateLabel(conversation.createdAt)}</Text>
    </Pressable>
  );
}

function SuggestedActionsButton({
  noteId,
  disabled,
  sendLock,
  deleteLock,
  refinementLock,
  onOpenActions,
}: {
  noteId: string;
  disabled: boolean;
  sendLock: React.RefObject<boolean>;
  deleteLock: React.RefObject<boolean>;
  refinementLock: React.RefObject<boolean>;
  onOpenActions: (noteId: string) => void;
}) {
  return (
    <Button
      label="Review suggested actions"
      tone="quiet"
      disabled={disabled}
      onPress={() => { if (!disabled && !sendLock.current && !deleteLock.current && !refinementLock.current) onOpenActions(noteId); }}
    />
  );
}

export function ChatSection({
  conversations,
  selectedConversationId,
  turns,
  busy,
  enabled,
  reviewBlocked = false,
  recoveryMessage,
  disabledReason,
  samplePreview = false,
  onDeleteReviewChange,
  onInteractionLockChange,
  onSelectConversation,
  onDeleteConversation,
  onCreateConversation,
  onSend,
  onOpenActions,
  onCheckJob,
  onRetryJobCleanup,
  onRefineTurn,
}: ChatSectionProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [deleteReviewOpen, setDeleteReviewOpen] = useState(false);
  const [deleteReviewConversationId, setDeleteReviewConversationId] = useState<string>();
  const [refinementReview, setRefinementReview] = useState<ChatRefinementReview>();
  const [refinementEffort, setRefinementEffort] = useState<ChatRefinementEffort>('medium');
  const [refining, setRefining] = useState(false);
  const [refinementError, setRefinementError] = useState<string>();
  const [refinementNotice, setRefinementNotice] = useState<string>();
  const sendLock = useRef(false);
  const deleteLock = useRef(false);
  const deleteOperationLock = useRef(false);
  const refinementLock = useRef(false);
  const refinementReviewLock = useRef(false);
  const refinementReviewRef = useRef<ChatRefinementReview | undefined>(undefined);
  const refinementGeneration = useRef(0);
  const mounted = useRef(true);
  const deleteReviewOpenRef = useRef(false);
  const interactionLock = useRef(false);
  const callbacks = useRef({ onDeleteReviewChange, onInteractionLockChange });
  const trimmedDraft = draft.trim();
  const navigationBlocked = busy || sending || deleting || refining || deleteReviewOpen || Boolean(refinementReview) || reviewBlocked || Boolean(recoveryMessage);
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId);
  const reviewedParent = refinementReview && conversations.find((conversation) => conversation.id === refinementReview.conversationId)
    ?.turns.find((turn) => turn.id === refinementReview.parentTurnId);
  const refinementContextRef = useRef({ conversations, selectedConversationId, reviewBlocked, recoveryMessage, enabled });
  useLayoutEffect(() => {
    refinementContextRef.current = { conversations, selectedConversationId, reviewBlocked, recoveryMessage, enabled };
  }, [conversations, recoveryMessage, reviewBlocked, selectedConversationId, enabled]);
  const isRefinementCurrentNow = useCallback((review: ChatRefinementReview) => {
    const context = refinementContextRef.current;
    const parent = context.conversations.find((conversation) => conversation.id === review.conversationId)
      ?.turns.find((turn) => turn.id === review.parentTurnId);
    return Boolean(parent && context.selectedConversationId === review.conversationId && parent.job?.id === review.parentJobId &&
      parent.job.status === 'completed' && parent.reply && context.enabled && !context.reviewBlocked && !context.recoveryMessage);
  }, []);
  const refinementReviewVisible = Boolean(refinementReview && reviewedParent && selectedConversationId === refinementReview.conversationId &&
    reviewedParent.job?.id === refinementReview.parentJobId && reviewedParent.job.status === 'completed' && reviewedParent.reply &&
    enabled && !reviewBlocked && !recoveryMessage);

  const notifyReview = (open: boolean) => callbacks.current.onDeleteReviewChange?.(open);
  const notifyInteractionLock = useCallback((active: boolean) => {
    if (interactionLock.current === active) return;
    interactionLock.current = active;
    callbacks.current.onInteractionLockChange?.(active);
  }, []);
  const changeRefinementReview = useCallback((next: ChatRefinementReview | undefined) => {
    refinementReviewRef.current = next;
    refinementReviewLock.current = Boolean(next);
    setRefinementReview(next);
  }, []);
  const invalidateRefinementReview = useCallback(() => {
    if (!refinementReviewLock.current) return;
    refinementGeneration.current += 1;
    changeRefinementReview(undefined);
    setRefinementError(undefined);
    setRefinementEffort('medium');
    if (!refinementLock.current) setRefining(false);
    notifyInteractionLock(false);
  }, [changeRefinementReview, notifyInteractionLock]);

  useEffect(() => {
    callbacks.current = { onDeleteReviewChange, onInteractionLockChange };
  }, [onDeleteReviewChange, onInteractionLockChange]);

  useEffect(() => {
    if (!deleteReviewOpen) return;
    const reviewConversationStillExists = deleteReviewConversationId &&
      conversations.some((conversation) => conversation.id === deleteReviewConversationId);
    if (!reviewConversationStillExists || selectedConversationId !== deleteReviewConversationId || recoveryMessage || reviewBlocked) {
      let active = true;
      const reviewedId = deleteReviewConversationId;
      void Promise.resolve().then(() => {
        if (!active || !deleteReviewOpenRef.current || deleteReviewConversationId !== reviewedId) return;
        deleteReviewOpenRef.current = false;
        setDeleteReviewOpen(false);
        setDeleteReviewConversationId(undefined);
        notifyReview(false);
        if (!deleting) {
          deleteLock.current = false;
          notifyInteractionLock(false);
        }
      });
      return () => { active = false; };
    }
  }, [conversations, deleteReviewConversationId, deleteReviewOpen, deleting, recoveryMessage, reviewBlocked, selectedConversationId, notifyInteractionLock]);

  useEffect(() => {
    if (!refinementReview) return;
    if (isRefinementCurrentNow(refinementReview)) return;
    invalidateRefinementReview();
  }, [conversations, enabled, refinementReview, recoveryMessage, reviewBlocked, selectedConversationId, invalidateRefinementReview, isRefinementCurrentNow, notifyInteractionLock]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refinementGeneration.current += 1;
      refinementReviewRef.current = undefined;
      refinementReviewLock.current = false;
      deleteReviewOpenRef.current = false;
      callbacks.current.onDeleteReviewChange?.(false);
      if (interactionLock.current) {
        interactionLock.current = false;
        callbacks.current.onInteractionLockChange?.(false);
      }
    };
  }, []);

  const openRefinementReview = (parentTurn: ChatTurn) => {
    if (!enabled || !onRefineTurn || !selectedConversation || !parentTurn.reply || !parentTurn.job?.id || parentTurn.job.status !== 'completed' ||
        busy || reviewBlocked || recoveryMessage ||
        deleteReviewOpen || sendLock.current || deleteLock.current || refinementLock.current || refinementReviewLock.current) return;
    const generation = refinementGeneration.current + 1;
    refinementGeneration.current = generation;
    setRefinementEffort('medium');
    setRefinementError(undefined);
    setRefinementNotice(undefined);
    changeRefinementReview({ conversationId: selectedConversation.id, parentTurnId: parentTurn.id, parentJobId: parentTurn.job.id, effort: 'medium', generation });
    notifyInteractionLock(true);
  };

  const closeRefinementReview = () => {
    if (refinementLock.current) return;
    invalidateRefinementReview();
  };

  const submitRefinement = async () => {
    const review = refinementReview;
    const parent = conversations.find((conversation) => conversation.id === review?.conversationId)
      ?.turns.find((turn) => turn.id === review?.parentTurnId);
    if (!review || refinementReviewRef.current !== review || !parent || selectedConversationId !== review.conversationId || parent.job?.id !== review.parentJobId || parent.job.status !== 'completed' ||
        !parent.reply || !enabled || !onRefineTurn || busy || reviewBlocked ||
        recoveryMessage || refining || refinementLock.current || deleteReviewOpen || sendLock.current || deleteLock.current) return;
    refinementLock.current = true;
    setRefining(true);
    setRefinementError(undefined);
    const generation = review.generation;
    try {
      const result = await onRefineTurn({
        conversationId: review.conversationId,
        parentTurnId: review.parentTurnId,
        parentJobId: review.parentJobId,
        effort: refinementEffort,
      });
      if (!isAcceptedChatSubmission(result) || result.conversationId !== review.conversationId) throw new Error('Refinement was not accepted.');
      if (!mounted.current || generation !== refinementGeneration.current || refinementReviewRef.current !== review || !isRefinementCurrentNow(review)) return;
      changeRefinementReview(undefined);
      setRefinementEffort('medium');
      setRefinementNotice('Refinement request saved. Its request status is shown below.');
      notifyInteractionLock(false);
    } catch {
      if (mounted.current && generation === refinementGeneration.current && refinementReviewRef.current === review && isRefinementCurrentNow(review)) {
        setRefinementError('Could not confirm refinement. Check the conversation request status before trying again.');
      }
    } finally {
      refinementLock.current = false;
      if (mounted.current) setRefining(false);
    }
  };

  const send = async () => {
    if (!enabled || !selectedConversation || busy || reviewBlocked || Boolean(recoveryMessage) || sendLock.current || deleteLock.current || refinementReviewLock.current || refinementLock.current || !trimmedDraft) return;
    sendLock.current = true;
    setSending(true);
    notifyInteractionLock(true);
    setSendError(undefined);
    try {
      const result = await onSend(trimmedDraft);
      if (!isAcceptedChatSubmission(result) || result.conversationId !== selectedConversation.id) {
        throw new Error('Submission was not explicitly accepted.');
      }
      setDraft('');
    } catch {
      setSendError('Could not confirm submission. Check saved messages and request status before sending again. Your draft is still here.');
    } finally {
      setSending(false);
      sendLock.current = false;
      notifyInteractionLock(false);
    }
  };

  const openDeleteReview = () => {
    if (!selectedConversation || !onDeleteConversation || busy || reviewBlocked || Boolean(recoveryMessage) || sendLock.current || deleteLock.current || refinementReviewLock.current || refinementLock.current) return;
    deleteLock.current = true;
    deleteReviewOpenRef.current = true;
    setDeleteReviewConversationId(selectedConversation.id);
    setDeleteReviewOpen(true);
    notifyReview(true);
    notifyInteractionLock(true);
  };

  const closeDeleteReview = () => {
    if (!deleteReviewOpenRef.current || deleting) return;
    deleteReviewOpenRef.current = false;
    deleteLock.current = false;
    setDeleteReviewOpen(false);
    setDeleteReviewConversationId(undefined);
    notifyReview(false);
    notifyInteractionLock(false);
  };

  const confirmDeleteSelectedConversation = async () => {
    const reviewConversation = conversations.find((conversation) => conversation.id === deleteReviewConversationId);
    if (!reviewConversation || selectedConversationId !== deleteReviewConversationId || !onDeleteConversation || busy || reviewBlocked || Boolean(recoveryMessage) || sendLock.current || refinementReviewLock.current || refinementLock.current || deleting || deleteOperationLock.current || !deleteLock.current || !deleteReviewOpenRef.current) return;
    deleteLock.current = true;
    deleteOperationLock.current = true;
    setDeleting(true);
    setSendError(undefined);
    let deleted = false;
    try {
      await onDeleteConversation(reviewConversation.id);
      deleted = true;
      deleteReviewOpenRef.current = false;
      setDeleteReviewOpen(false);
      setDeleteReviewConversationId(undefined);
      notifyReview(false);
    } catch {
      setSendError('Could not confirm conversation removal. Check saved messages and request status.');
    } finally {
      deleteOperationLock.current = false;
      setDeleting(false);
      if (deleted || !deleteReviewOpenRef.current) {
        deleteLock.current = false;
        notifyInteractionLock(false);
      } else {
        // A failed removal keeps the review actionable for an explicit retry or Cancel.
        deleteLock.current = true;
        notifyInteractionLock(true);
      }
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.heading}>
          <View style={{ flex: 1 }}>
            <Text style={s.kicker}>STILL</Text>
            <Text style={s.h1Small}>Queued chat</Text>
            <Text style={styles.copy}>Messages are submitted as Batch requests. Replies may be delayed; nothing checks or resubmits in the background.</Text>
          </View>
          <Button label="New conversation" tone="quiet" disabled={navigationBlocked} onPress={() => { if (!busy && !sending && !deleting && !recoveryMessage && !sendLock.current && !deleteLock.current && !refinementReviewLock.current && !refinementLock.current) onCreateConversation(); }} />
        </View>

        {samplePreview ? <Text style={styles.sampleBadge}>SAMPLE · Simulated Batch requests and replies. No provider or external service is contacted.</Text> : null}
        {!enabled && disabledReason ? <Text style={styles.notice}>{disabledReason}</Text> : null}
        {recoveryMessage ? <Text accessibilityRole="alert" style={styles.warning}>{recoveryMessage}</Text> : null}
        {refinementNotice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{refinementNotice}</Text> : null}

        {conversations.length ? (
          <View style={styles.conversationList} accessibilityLabel="Conversations">
            {conversations.map((conversation) => (
              <ConversationButton
                key={conversation.id}
                conversation={conversation}
                selected={conversation.id === selectedConversationId}
                disabled={navigationBlocked}
                sendLock={sendLock}
                deleteLock={deleteLock}
                refinementLock={refinementReviewLock}
                onSelect={onSelectConversation}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.notice}>Start a conversation with a question or request.</Text>
        )}
        {selectedConversation ? null : conversations.length ? <Text style={styles.notice}>Select a conversation to continue, or create a new one.</Text> : null}
        {selectedConversation && onDeleteConversation ? (
          <Button
            label={deleting ? 'Deleting conversation…' : 'Delete conversation'}
            tone="quiet"
            disabled={busy || sending || deleting || deleteReviewOpen || Boolean(recoveryMessage)}
            onPress={openDeleteReview}
          />
        ) : null}

        <View style={styles.turnList} accessibilityLabel="Conversation messages">
          {turns.map((turn) => (
            <View key={turn.id} style={styles.turnGroup}>
              {turn.operation === 'chat_refinement' ? (
                <Text style={[styles.meta, styles.refinementContext]}>Refinement of an earlier message</Text>
              ) : (
                <View style={styles.userBubble}>
                  <Text style={styles.userText}>{turn.userText}</Text>
                  <Text style={styles.meta}>{dateLabel(turn.createdAt)}</Text>
                </View>
              )}
              {turn.reply ? (
                <View style={styles.replyBubble}>
                  <Text style={styles.replyLabel}>{turn.operation === 'chat_refinement'
                    ? `Refined answer · ${turn.reasoningEffort ?? 'medium'}`
                    : 'Reply'}</Text>
                  {turn.reply.answer || turn.reply.summary ? (
                    <Text style={styles.replyText}>{turn.reply.answer || turn.reply.summary}</Text>
                  ) : null}
                  {turn.reply.clarifications?.map((question, index) => (
                    <View key={`${turn.id}-clarification-${index}`} style={styles.clarification}>
                      <Text style={styles.meta}>Clarification</Text>
                      <Text style={styles.replyText}>{question}</Text>
                    </View>
                  ))}
                  <Text style={styles.meta}>{dateLabel(turn.reply.completedAt)}</Text>
                </View>
              ) : null}
              {turn.job ? (
                <AssistantBatchJobCard
                  job={turn.job}
                  busy={busy}
                  blocked={Boolean(recoveryMessage)}
                  onCheck={onCheckJob}
                  onRetryCleanup={onRetryJobCleanup}
                />
              ) : null}
              {turn.noteId && turn.operation !== 'chat_refinement' ? (
                <SuggestedActionsButton
                  noteId={turn.noteId}
                  disabled={navigationBlocked}
                  sendLock={sendLock}
                  deleteLock={deleteLock}
                  refinementLock={refinementReviewLock}
                  onOpenActions={onOpenActions}
                />
              ) : null}
              {turn.reply && turn.job?.id && turn.job.status === 'completed' && onRefineTurn ? (
                <Button label={turn.operation === 'chat_refinement' ? `Think more · ${(turn.reasoningEffort ?? 'medium').toUpperCase()}` : 'Think more'} tone="quiet" disabled={navigationBlocked || !enabled} onPress={() => openRefinementReview(turn)} />
              ) : null}
            </View>
          ))}
        </View>

        <View style={styles.composer}>
          <Text style={styles.composerLabel}>Message</Text>
          <TextInput
            accessibilityLabel="Chat message"
            accessibilityHint="Write a message, then choose Send."
            value={draft}
            onChangeText={(value) => { setDraft(value); setSendError(undefined); }}
            placeholder="Ask a question or describe what you need…"
            placeholderTextColor={C.muted}
            multiline
            editable={!busy && !sending && !deleting && !deleteReviewOpen && !reviewBlocked && !recoveryMessage}
            textAlignVertical="top"
            style={styles.input}
          />
          {sendError ? <Text accessibilityRole="alert" style={styles.warning}>{sendError}</Text> : null}
          <Button
            label={sending ? 'Submitting…' : 'Send'}
            disabled={!enabled || !selectedConversation || busy || sending || deleting || deleteReviewOpen || reviewBlocked || Boolean(recoveryMessage) || !trimmedDraft}
            onPress={() => { void send(); }}
          />
        </View>
      </ScrollView>
      <Modal visible={deleteReviewOpen} transparent animationType="fade" onRequestClose={closeDeleteReview}>
        <SafeAreaProvider>
          <SafeAreaView style={styles.reviewSafe}>
            <View style={styles.reviewCard}>
              <Text style={styles.reviewTitle}>Delete this conversation?</Text>
              <Text style={styles.reviewCopy}>This removes its messages and local request content. Small billing and submission receipts remain. OpenRouter may retain requests already submitted to its service.</Text>
              {sendError ? <Text accessibilityRole="alert" style={styles.warning}>{sendError}</Text> : null}
              <Button label={deleting ? 'Deleting…' : 'Delete conversation'} tone="danger" disabled={deleting || busy || reviewBlocked || Boolean(recoveryMessage) || selectedConversationId !== deleteReviewConversationId} onPress={() => { void confirmDeleteSelectedConversation(); }} />
              <Button label="Cancel" tone="quiet" disabled={deleting} onPress={closeDeleteReview} />
            </View>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
      <Modal visible={refinementReviewVisible} transparent animationType="fade" onRequestClose={closeRefinementReview}>
        <SafeAreaProvider>
          <SafeAreaView style={styles.reviewSafe}>
            <View style={styles.reviewCard}>
              <Text style={styles.reviewTitle}>Think more</Text>
              <Text style={styles.reviewCopy}>This creates a separate paid Batch request. Replies may take up to 24 hours. It refines the saved answer only; it does not change the original message or its actions. Actual cost appears when the provider reports it.</Text>
              <Text style={styles.composerLabel}>Reasoning effort</Text>
              {(['medium', 'high', 'max'] as const).map((effort) => (
                <Button key={effort} label={`${effort === 'medium' ? 'Medium' : effort === 'high' ? 'High' : 'Max'}${refinementEffort === effort ? ' · Selected' : ''}`} tone="quiet" disabled={!enabled || refining || reviewBlocked || Boolean(recoveryMessage)} onPress={() => setRefinementEffort(effort)} />
              ))}
              {refinementError ? <Text accessibilityRole="alert" style={styles.warning}>{refinementError}</Text> : null}
              <Button label={refining ? 'Submitting refinement…' : 'Refine answer'} tone="quiet" disabled={!enabled || refining || busy || reviewBlocked || Boolean(recoveryMessage) || !refinementReview} onPress={() => { void submitRefinement(); }} />
              <Button label="Cancel" tone="quiet" disabled={refining} onPress={closeRefinementReview} />
            </View>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = {
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32, gap: 16 },
  heading: { gap: 10, alignItems: 'flex-start' as const },
  copy: { color: C.muted, fontSize: 13, lineHeight: 19, maxWidth: 470, marginTop: 7 },
  notice: { color: C.muted, backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 13, fontSize: 13, lineHeight: 19 },
  warning: { color: C.sage, backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 12, fontSize: 13, lineHeight: 19 },
  conversationList: { gap: 8 },
  conversation: { minHeight: 50, justifyContent: 'center' as const, padding: 11, borderWidth: 1, borderColor: C.border, borderRadius: 13, backgroundColor: C.card },
  conversationSelected: { borderColor: C.sage },
  conversationTitle: { color: C.text, fontSize: 14, fontWeight: '600' as const },
  turnList: { gap: 13 },
  turnGroup: { gap: 9 },
  userBubble: { alignSelf: 'flex-end' as const, maxWidth: '90%' as const, padding: 13, gap: 7, borderRadius: 16, backgroundColor: '#24272A' },
  userText: { color: C.text, fontSize: 15, lineHeight: 22 },
  replyBubble: { alignSelf: 'stretch' as const, padding: 14, gap: 8, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  replyLabel: { color: C.sage, fontSize: 11, fontWeight: '700' as const, letterSpacing: 0.8, textTransform: 'uppercase' as const },
  replyText: { color: C.text, fontSize: 15, lineHeight: 22 },
  clarification: { gap: 4, borderTopWidth: 1, borderTopColor: C.border, paddingTop: 8 },
  meta: { color: C.muted, fontSize: 11, lineHeight: 16 },
  composer: { padding: 13, gap: 9, borderWidth: 1, borderColor: C.border, borderRadius: 17, backgroundColor: C.card },
  composerLabel: { color: C.text, fontSize: 13, fontWeight: '600' as const },
  input: { minHeight: 96, maxHeight: 220, padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: 12, color: C.text, backgroundColor: C.input, fontSize: 15, lineHeight: 22 },
  sampleBadge: { color: C.sage, backgroundColor: C.card, borderColor: C.sage, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 12, lineHeight: 18, fontWeight: '700' as const },
  reviewSafe: { flex: 1, justifyContent: 'center' as const, padding: 20, backgroundColor: 'rgba(0,0,0,0.72)' },
  reviewCard: { width: '100%' as const, maxWidth: 460, alignSelf: 'center' as const, gap: 14, padding: 20, borderRadius: 18, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  reviewTitle: { color: C.text, fontSize: 20, fontWeight: '700' as const },
  reviewCopy: { color: C.muted, fontSize: 14, lineHeight: 21 },
  refinementContext: { alignSelf: 'flex-end' as const, paddingHorizontal: 5 },
};
