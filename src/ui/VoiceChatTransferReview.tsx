import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { ChatConversationDTO, ChatTranscriptTransferPlan } from '../chat/types';
import { isAcceptedChatSubmission } from './chatSubmission';
import { Button } from './primitives';
import { C } from './theme';

export type { ChatTranscriptTransferPlan } from '../chat/types';

type Props = {
  plan?: ChatTranscriptTransferPlan;
  conversations: readonly ChatConversationDTO[];
  selectedConversationId?: string;
  blocked: boolean;
  busy: boolean;
  providerReady: boolean;
  onSelectConversation: (conversationId: string) => void;
  onCreateConversation: (expectedPlanId: string) => Promise<ChatConversationDTO | undefined>;
  onSend: (expectedPlanId: string, conversationId: string) => Promise<unknown>;
  onCancel: (expectedPlanId: string) => void;
};

function capturedLabel(capturedAt: string, timeZone: string) {
  const date = new Date(capturedAt);
  if (!Number.isFinite(date.getTime())) return 'Capture time unavailable';
  try {
    return `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date)} · ${timeZone}`;
  } catch {
    return 'Capture time unavailable';
  }
}

export function VoiceChatTransferReview({
  plan,
  conversations,
  selectedConversationId,
  blocked,
  busy,
  providerReady,
  onSelectConversation,
  onCreateConversation,
  onSend,
  onCancel,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorState, setErrorState] = useState<{ planId: string; message: string } | null>(null);
  const error = plan && errorState?.planId === plan.planId ? errorState.message : '';
  const setError = (message: string) => setErrorState(plan && message ? { planId: plan.planId, message } : null);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const close = () => {
    if (actionLock.current || blocked) return;
    setError('');
    if (plan) onCancel(plan.planId);
  };

  const createConversation = async () => {
    if (!plan || blocked || busy || actionLock.current) return;
    const expectedPlanId = plan.planId;
    actionLock.current = true;
    setCreating(true);
    setError('');
    try {
      const conversation = await onCreateConversation(expectedPlanId);
      if (!conversation || !conversation.id) throw new Error('not_confirmed');
      if (mounted.current) onSelectConversation(conversation.id);
    } catch {
      if (mounted.current) setError('Could not confirm the new conversation. Refresh local data before continuing.');
    } finally {
      actionLock.current = false;
      if (mounted.current) setCreating(false);
    }
  };

  const send = async () => {
    if (!plan || !selectedConversationId || blocked || busy || !providerReady || actionLock.current) return;
    const expectedPlanId = plan.planId;
    const conversationId = selectedConversationId;
    actionLock.current = true;
    setSending(true);
    setError('');
    try {
      const result = await onSend(expectedPlanId, conversationId);
      if (!isAcceptedChatSubmission(result) || result.conversationId !== conversationId) throw new Error('not_confirmed');
    } catch {
      if (mounted.current) setError('Could not confirm the Chat message. Check the conversation request status before trying again.');
    } finally {
      actionLock.current = false;
      if (mounted.current) setSending(false);
    }
  };

  if (!plan) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.safe}>
          <View style={styles.card}>
            <Text style={styles.title}>Use saved transcript in Chat</Text>
            <Text style={styles.copy}>Creates a saved Chat message. Deleting the recording note won’t delete that message.</Text>
            <Text style={styles.meta}>{capturedLabel(plan.capturedAt, plan.captureTimeZone)}</Text>
            <ScrollView style={styles.transcriptBox} contentContainerStyle={styles.transcriptContent}>
              <Text selectable style={styles.transcript}>{plan.transcript}</Text>
            </ScrollView>
            <Text style={styles.sectionTitle}>Choose a conversation</Text>
            <ScrollView style={styles.conversations} contentContainerStyle={styles.conversationList}>
              {conversations.map((conversation) => (
                <Pressable
                  key={conversation.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selectedConversationId === conversation.id }}
                  disabled={blocked || busy || creating || sending}
                  onPress={() => { if (!blocked && !busy && !actionLock.current) onSelectConversation(conversation.id); }}
                  style={[styles.conversation, selectedConversationId === conversation.id && styles.selected]}
                >
                  <Text numberOfLines={2} style={styles.conversationTitle}>{conversation.title}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Button label={creating ? 'Creating conversation…' : 'Create new conversation'} tone="quiet" disabled={blocked || busy || creating || sending} onPress={() => { void createConversation(); }} />
            {!providerReady ? <Text style={styles.meta}>Choose OpenRouter in Provider mode and save its key before sending.</Text> : null}
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Button label={sending ? 'Sending…' : 'Send saved transcript'} disabled={blocked || busy || creating || sending || !providerReady || !selectedConversationId} onPress={() => { void send(); }} />
            <Button label="Cancel" tone="quiet" disabled={blocked || creating || sending} onPress={close} />
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = {
  safe: { flex: 1, justifyContent: 'center' as const, padding: 18, backgroundColor: 'rgba(0,0,0,0.74)' },
  card: { width: '100%' as const, maxWidth: 520, maxHeight: '94%' as const, alignSelf: 'center' as const, gap: 12, padding: 18, borderRadius: 18, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  title: { color: C.text, fontSize: 20, fontWeight: '700' as const },
  copy: { color: C.muted, fontSize: 14, lineHeight: 21 },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  transcriptBox: { maxHeight: 230, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.input },
  transcriptContent: { padding: 12 },
  transcript: { color: C.text, fontSize: 14, lineHeight: 21 },
  sectionTitle: { color: C.text, fontSize: 14, fontWeight: '600' as const },
  conversations: { maxHeight: 125 },
  conversationList: { gap: 7 },
  conversation: { minHeight: 46, justifyContent: 'center' as const, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: C.border, backgroundColor: C.input },
  selected: { borderColor: C.sage },
  conversationTitle: { color: C.text, fontSize: 14 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
};
