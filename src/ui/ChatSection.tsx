import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AssistantBatchJobCard } from './AssistantBatchJobCard';
import { Button } from './primitives';
import { ChatSubmissionNotStartedError, isAcceptedChatSubmission, type ChatSendAttempt, type ChatSendInspectionResult } from './chatSubmission';
import { chatMemoryReviewSuggestionIds } from './chatMemoryReview';
import { C, s } from './theme';
import type { MoreComputeReviewActions } from './MoreComputeReview';
import type { ChatKnowledgeChoiceDisplay, ChatKnowledgeSelectionBinding, WorkspaceChatConversationDisplay, WorkspaceChatTurnDisplay } from './workspaceChatDisplayTypes';

export type ChatConversation = WorkspaceChatConversationDisplay;
export type ChatTurn = WorkspaceChatTurnDisplay;
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
  focusTurnId?: string;
  turns: readonly ChatTurn[];
  busy: boolean;
  enabled: boolean;
  reviewBlocked?: boolean;
  recoveryMessage?: string;
  disabledReason?: string;
  samplePreview?: boolean;
  knowledgeChoices?: readonly ChatKnowledgeChoiceDisplay[];
  onDeleteReviewChange?: (open: boolean) => void;
  onInteractionLockChange?: (active: boolean) => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation?: (conversationId: string) => Promise<unknown> | unknown;
  onCreateConversation: () => void;
  onSend: (text: string, knowledgeSelection?: readonly ChatKnowledgeSelectionBinding[]) => Promise<unknown>;
  onInspectUnconfirmedSend?: (attempt: ChatSendAttempt) => Promise<ChatSendInspectionResult>;
  onOpenActions: (noteId: string) => void;
  onCheckJob: (jobId: string) => Promise<unknown> | unknown;
  onRetryJobCleanup: (jobId: string) => Promise<unknown> | unknown;
  onRefineTurn?: (request: ChatRefinementRequest) => Promise<unknown>;
  onReviewMemorySuggestion?: (suggestionId: string, conversation: ChatConversation, turn: ChatTurn) => void;
  moreComputeActions?: MoreComputeReviewActions;
};

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Time unavailable';
}

function captureDateLabel(value: string, timeZone: string | undefined) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'time unavailable';
  if (!timeZone) return dateLabel(value);
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
  } catch {
    return 'time unavailable';
  }
}

function ConversationButton({
  conversation,
  selected,
  disabled,
  sendLock,
  unconfirmedSendRef,
  deleteLock,
  refinementLock,
  onSelect,
}: {
  conversation: ChatConversation;
  selected: boolean;
  disabled: boolean;
  sendLock: React.RefObject<boolean>;
  unconfirmedSendRef: React.RefObject<ChatSendAttempt | undefined>;
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
      onPress={() => { if (!disabled && !unconfirmedSendRef.current && !sendLock.current && !deleteLock.current && !refinementLock.current) onSelect(conversation.id); }}
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
  focusTurnId,
  turns,
  busy,
  enabled,
  reviewBlocked = false,
  recoveryMessage,
  disabledReason,
  samplePreview = false,
  knowledgeChoices = [],
  onDeleteReviewChange,
  onInteractionLockChange,
  onSelectConversation,
  onDeleteConversation,
  onCreateConversation,
  onSend,
  onInspectUnconfirmedSend,
  onOpenActions,
  onCheckJob,
  onRetryJobCleanup,
  onRefineTurn,
  onReviewMemorySuggestion,
  moreComputeActions,
}: ChatSectionProps) {
  const [draft, setDraft] = useState('');
  const [selectedKnowledge, setSelectedKnowledge] = useState<readonly ChatKnowledgeSelectionBinding[]>([]);
  const selectedKnowledgeRef = useRef<readonly ChatKnowledgeSelectionBinding[]>([]);
  const [knowledgeNotice, setKnowledgeNotice] = useState<string>();
  const [sending, setSending] = useState(false);
  const [unconfirmedSend, setUnconfirmedSend] = useState<ChatSendAttempt | undefined>(undefined);
  const [inspectingSend, setInspectingSend] = useState(false);
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
  const unconfirmedSendRef = useRef<ChatSendAttempt | undefined>(undefined);
  const inspectLock = useRef(false);
  const sendAttemptSequence = useRef(0);
  const sendOwnerRef = useRef({ conversationId: selectedConversationId, generation: 0 });
  const deleteLock = useRef(false);
  const deleteOperationLock = useRef(false);
  const refinementLock = useRef(false);
  const refinementReviewLock = useRef(false);
  const messagesScrollRef = useRef<ScrollView | null>(null);
  const refinementReviewRef = useRef<ChatRefinementReview | undefined>(undefined);
  const refinementGeneration = useRef(0);
  const mounted = useRef(true);
  const deleteReviewOpenRef = useRef(false);
  const interactionLock = useRef(false);
  const callbacks = useRef({ onDeleteReviewChange, onInteractionLockChange });
  const trimmedDraft = draft.trim();
  const navigationBlocked = busy || sending || Boolean(unconfirmedSend) || deleting || refining || deleteReviewOpen || Boolean(refinementReview) || reviewBlocked || Boolean(recoveryMessage);
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId);
  useLayoutEffect(() => {
    const owner = sendOwnerRef.current;
    const conversationChanged = owner.conversationId !== selectedConversationId;
    const choiceInvalidated = selectedKnowledgeRef.current.some((binding) => {
      const choice = knowledgeChoices.find((item) => item.kind === binding.kind && item.id === binding.id);
      return !choice || Boolean(choice.archivedAt) || choice.revision !== binding.revision;
    });
    let generation = owner.generation;
    if (conversationChanged) generation += 1;
    if (conversationChanged || choiceInvalidated) {
      if (!unconfirmedSendRef.current) {
        selectedKnowledgeRef.current = [];
        setSelectedKnowledge([]);
        setKnowledgeNotice(undefined);
      }
      setSendError(undefined);
    }
    sendOwnerRef.current = { conversationId: selectedConversationId, generation };
  }, [knowledgeChoices, selectedConversationId]);
  useEffect(() => {
    if (focusTurnId && turns.some((turn) => turn.id === focusTurnId)) messagesScrollRef.current?.scrollToEnd({ animated: true });
  }, [focusTurnId, turns]);
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
        busy || reviewBlocked || recoveryMessage || unconfirmedSendRef.current ||
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
        recoveryMessage || refining || refinementLock.current || deleteReviewOpen || unconfirmedSendRef.current || sendLock.current || deleteLock.current) return;
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
    if (!enabled || !selectedConversation || busy || reviewBlocked || Boolean(recoveryMessage) || unconfirmedSendRef.current || sendLock.current || deleteLock.current || refinementReviewLock.current || refinementLock.current || !trimmedDraft) return;
    const sendOwner = sendOwnerRef.current;
    if (sendOwner.conversationId !== selectedConversation.id) return;
    const capturedKnowledge = Object.freeze(selectedKnowledgeRef.current.map((binding) => Object.freeze({ kind: binding.kind, id: binding.id, revision: binding.revision })));
    const available = new Map(knowledgeChoices.filter((choice) => !choice.archivedAt).map((choice) => [`${choice.kind}:${choice.id}`, choice.revision] as const));
    if (capturedKnowledge.some((binding) => available.get(`${binding.kind}:${binding.id}`) !== binding.revision)) {
      selectedKnowledgeRef.current = [];
      setSelectedKnowledge([]);
      setKnowledgeNotice(undefined);
      setSendError('A selected person or project changed. Review the current context before sending again.');
      sendOwnerRef.current = { ...sendOwner, generation: sendOwner.generation + 1 };
      return;
    }
    const attempt: ChatSendAttempt = Object.freeze({
      attemptId: ++sendAttemptSequence.current,
      conversationId: selectedConversation.id,
      ownerGeneration: sendOwner.generation,
      text: trimmedDraft,
      knowledgeSelection: capturedKnowledge,
    });
    sendLock.current = true;
    setSending(true);
    notifyInteractionLock(true);
    setSendError(undefined);
    try {
      const result = capturedKnowledge.length ? await onSend(trimmedDraft, capturedKnowledge) : await onSend(trimmedDraft);
      if (!isAcceptedChatSubmission(result) || result.conversationId !== selectedConversation.id) {
        throw new Error('Submission was not explicitly accepted.');
      }
      const currentOwner = sendOwnerRef.current;
      if (currentOwner.generation !== sendOwner.generation || currentOwner.conversationId !== selectedConversation.id) {
        throw new Error('The conversation or selected context changed while sending.');
      }
      setDraft('');
      if (capturedKnowledge.length) {
        selectedKnowledgeRef.current = [];
        setSelectedKnowledge([]);
        setKnowledgeNotice(attempt.knowledgeSelection.length ? 'Selected people and projects context was sent with this message.' : undefined);
        sendOwnerRef.current = { ...currentOwner, generation: currentOwner.generation + 1 };
      }
    } catch (error) {
      if (error instanceof ChatSubmissionNotStartedError) {
        setSendError(`${error.message} Your draft and selected context are still here.`);
      } else {
        unconfirmedSendRef.current = attempt;
        setUnconfirmedSend(attempt);
        selectedKnowledgeRef.current = attempt.knowledgeSelection;
        setSelectedKnowledge(attempt.knowledgeSelection);
        setSendError('The submission outcome is unknown. Your original draft and context are held here. Inspect this exact request or check saved history before sending again.');
      }
    } finally {
      setSending(false);
      sendLock.current = false;
      if (!unconfirmedSendRef.current) notifyInteractionLock(false);
    }
  };

  const inspectUnconfirmedSend = async () => {
    const attempt = unconfirmedSendRef.current;
    if (!attempt || !onInspectUnconfirmedSend || inspectLock.current) return;
    inspectLock.current = true;
    setInspectingSend(true);
    try {
      const result = await onInspectUnconfirmedSend(attempt);
      if (unconfirmedSendRef.current !== attempt || !mounted.current) return;
      const currentOwner = sendOwnerRef.current;
      const sameOwner = selectedConversationId === attempt.conversationId && currentOwner.conversationId === attempt.conversationId && currentOwner.generation === attempt.ownerGeneration;
      if (result?.kind === 'not_started' && sameOwner) {
        unconfirmedSendRef.current = undefined;
        setUnconfirmedSend(undefined);
        setSendError('The original request did not start. Your draft and context are ready for an explicit retry.');
        notifyInteractionLock(false);
      } else if (result?.kind === 'accepted' && isAcceptedChatSubmission(result.submission) && result.submission.conversationId === attempt.conversationId && sameOwner) {
        unconfirmedSendRef.current = undefined;
        setUnconfirmedSend(undefined);
        setDraft((current) => current.trim() === attempt.text ? '' : current);
        selectedKnowledgeRef.current = [];
        setSelectedKnowledge([]);
        setKnowledgeNotice('Selected people and projects context was sent with this message.');
        sendOwnerRef.current = { ...currentOwner, generation: currentOwner.generation + 1 };
        setSendError(undefined);
        notifyInteractionLock(false);
      } else {
        setSendError('The exact submission is still unresolved. Your draft and context remain held; check saved history or refresh the workspace before sending again.');
      }
    } catch {
      if (unconfirmedSendRef.current === attempt && mounted.current) setSendError('Could not verify the exact submission. Your draft and context remain held; check saved history or refresh the workspace before sending again.');
    } finally {
      inspectLock.current = false;
      if (mounted.current) setInspectingSend(false);
    }
  };

  const openDeleteReview = () => {
    if (!selectedConversation || !onDeleteConversation || busy || reviewBlocked || Boolean(recoveryMessage) || unconfirmedSendRef.current || sendLock.current || deleteLock.current || refinementReviewLock.current || refinementLock.current) return;
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
    if (!reviewConversation || selectedConversationId !== deleteReviewConversationId || !onDeleteConversation || busy || reviewBlocked || Boolean(recoveryMessage) || unconfirmedSendRef.current || sendLock.current || refinementReviewLock.current || refinementLock.current || deleting || deleteOperationLock.current || !deleteLock.current || !deleteReviewOpenRef.current) return;
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
      <ScrollView ref={messagesScrollRef} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.heading}>
          <View style={{ flex: 1 }}>
            <Text style={s.kicker}>STILL</Text>
            <Text style={s.h1Small}>Queued chat</Text>
            <Text style={styles.copy}>Messages are submitted as Batch requests. Replies may be delayed; nothing checks or resubmits in the background.</Text>
          </View>
          <Button label="New conversation" tone="quiet" disabled={navigationBlocked} onPress={() => { if (!busy && !sending && !unconfirmedSendRef.current && !deleting && !recoveryMessage && !sendLock.current && !deleteLock.current && !refinementReviewLock.current && !refinementLock.current) onCreateConversation(); }} />
        </View>

        {samplePreview ? <Text style={styles.sampleBadge}>SAMPLE · Simulated Batch requests and replies. No provider or external service is contacted.</Text> : null}
        {!enabled && disabledReason ? <Text style={styles.notice}>{disabledReason}</Text> : null}
        {recoveryMessage ? <Text accessibilityRole="alert" style={styles.warning}>{recoveryMessage}</Text> : null}
        {unconfirmedSend ? <View style={styles.warning}>
          <Text style={styles.warning}>This exact message may already have been accepted. Sending, editing, and switching conversations are paused until its outcome is known.</Text>
          {onInspectUnconfirmedSend ? <Button label={inspectingSend ? 'Checking exact submission…' : 'Check submission status'} tone="quiet" disabled={inspectingSend} onPress={() => { void inspectUnconfirmedSend(); }} />
            : <Text style={styles.meta}>Check saved history or refresh the workspace to verify this request. The original draft and selected context are held here.</Text>}
        </View> : null}
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
                unconfirmedSendRef={unconfirmedSendRef}
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
            disabled={navigationBlocked || deleting}
            onPress={openDeleteReview}
          />
        ) : null}

        {knowledgeChoices.some((choice) => !choice.archivedAt) ? (
          <View style={styles.knowledgeContext}>
            <Text style={styles.composerLabel}>Optional context · People and projects</Text>
            <Text style={styles.meta}>Choose saved context to send with this message only. It does not change the conversation history.</Text>
            {knowledgeChoices.filter((choice) => !choice.archivedAt).map((choice) => {
              const selected = selectedKnowledge.some((item) => item.kind === choice.kind && item.id === choice.id && item.revision === choice.revision);
              return <Pressable key={`${choice.kind}:${choice.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Include ${choice.kind} ${choice.name} in this message`} disabled={navigationBlocked}
                onPress={() => {
                  if (navigationBlocked || unconfirmedSendRef.current) return;
                  const current = selectedKnowledgeRef.current;
                  const exists = current.some((item) => item.kind === choice.kind && item.id === choice.id);
                  const next = exists ? current.filter((item) => item.kind !== choice.kind || item.id !== choice.id)
                    : [...current, { kind: choice.kind, id: choice.id, revision: choice.revision }];
                  selectedKnowledgeRef.current = next;
                  setSelectedKnowledge(next);
                  setKnowledgeNotice(undefined);
                  setSendError(undefined);
                }} style={[styles.knowledgeChoice, selected && styles.knowledgeChoiceSelected]}>
                <Text style={styles.meta}>{choice.kind === 'person' ? 'Person' : 'Project'} · {choice.name}{selected ? ' · Selected' : ''}</Text>
              </Pressable>;
            })}
            {selectedKnowledge.length ? <Text style={styles.meta}>{selectedKnowledge.length} selected context item{selectedKnowledge.length === 1 ? '' : 's'} will be sent with this message only.</Text> : null}
            {knowledgeNotice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{knowledgeNotice}</Text> : null}
          </View>
        ) : null}

        <View style={styles.turnList} accessibilityLabel="Conversation messages">
          {turns.map((turn) => (
            <View key={turn.id} style={styles.turnGroup}>
              {turn.operation === 'chat_refinement' ? (
                <Text style={[styles.meta, styles.refinementContext]}>Refinement of an earlier message</Text>
              ) : (
                <View style={styles.userBubble}>
                  <Text style={styles.userText}>{turn.userText}</Text>
                  {turn.messageOrigin === 'saved_transcript' ? (
                    <>
                      <Text style={styles.meta}>From saved transcript · captured {turn.capturedAt ? captureDateLabel(turn.capturedAt, turn.captureTimeZone) : 'time unavailable'} · {turn.captureTimeZone ?? 'time zone unavailable'}</Text>
                      <Text style={styles.meta}>Added to Chat {dateLabel(turn.createdAt)}</Text>
                    </>
                  ) : <Text style={styles.meta}>{dateLabel(turn.createdAt)}</Text>}
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
                  chatContext={turn.operation === 'chat_refinement' ? 'refinement' : 'chat'}
                  busy={busy}
                  blocked={Boolean(recoveryMessage)}
                  onCheck={onCheckJob}
                  onRetryCleanup={onRetryJobCleanup}
                  moreCompute={moreComputeActions && selectedConversation ? { ...moreComputeActions, ownerKey: JSON.stringify(['chat', selectedConversation.id, turn.id, turn.job.id, turn.job.updatedAt, turn.job.status, moreComputeActions.ownerKey]) } : undefined}
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
              {selectedConversation && onReviewMemorySuggestion &&
                chatMemoryReviewSuggestionIds(turn).map((suggestionId, index, ids) => (
                  <Button
                    key={`${turn.id}-memory-${suggestionId}`}
                    label={index === 0 && ids.length === 1 ? 'Review memory' : `Review memory suggestion ${index + 1}`}
                    tone="quiet"
                    disabled={navigationBlocked}
                    onPress={() => {
                      if (!navigationBlocked && !sendLock.current && !deleteLock.current && !refinementReviewLock.current && !refinementLock.current) {
                        onReviewMemorySuggestion(suggestionId, selectedConversation, turn);
                      }
                    }}
                  />
                ))}
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
                    onChangeText={(value) => { if (unconfirmedSendRef.current) return; setDraft(value); setSendError(undefined); }}
            placeholder="Ask a question or describe what you need…"
            placeholderTextColor={C.muted}
            multiline
            editable={!busy && !sending && !unconfirmedSend && !deleting && !deleteReviewOpen && !reviewBlocked && !recoveryMessage}
            textAlignVertical="top"
            style={styles.input}
          />
          {sendError ? <Text accessibilityRole="alert" style={styles.warning}>{sendError}</Text> : null}
          <Button
            label={sending ? 'Submitting…' : 'Send'}
            disabled={!enabled || !selectedConversation || busy || sending || Boolean(unconfirmedSend) || deleting || deleteReviewOpen || reviewBlocked || Boolean(recoveryMessage) || !trimmedDraft}
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
  knowledgeContext: { padding: 13, gap: 8, borderWidth: 1, borderColor: C.border, borderRadius: 15, backgroundColor: C.card },
  knowledgeChoice: { padding: 10, borderWidth: 1, borderColor: C.border, borderRadius: 11 },
  knowledgeChoiceSelected: { borderColor: C.sage },
  composerLabel: { color: C.text, fontSize: 13, fontWeight: '600' as const },
  input: { minHeight: 96, maxHeight: 220, padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: 12, color: C.text, backgroundColor: C.input, fontSize: 15, lineHeight: 22 },
  sampleBadge: { color: C.sage, backgroundColor: C.card, borderColor: C.sage, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 12, lineHeight: 18, fontWeight: '700' as const },
  reviewSafe: { flex: 1, justifyContent: 'center' as const, padding: 20, backgroundColor: 'rgba(0,0,0,0.72)' },
  reviewCard: { width: '100%' as const, maxWidth: 460, alignSelf: 'center' as const, gap: 14, padding: 20, borderRadius: 18, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  reviewTitle: { color: C.text, fontSize: 20, fontWeight: '700' as const },
  reviewCopy: { color: C.muted, fontSize: 14, lineHeight: 21 },
  refinementContext: { alignSelf: 'flex-end' as const, paddingHorizontal: 5 },
};
