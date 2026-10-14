import React, { useLayoutEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { MailReplyContextSelection, MailReplyConversationContextDiscovery } from '../core';
import type { MailReplyBatchOwner } from './mailReplyBatchOwnership';
import { Button } from './primitives';
import { C, s } from './theme';

type Selected = { value: MailReplyContextSelection; included: boolean; excerptConsent: boolean };

type Props = {
  visible: boolean;
  messageId: string;
  sourceDigest: string;
  ownerGeneration: number;
  blocked: boolean;
  busy: boolean;
  onChange: (selectionIds: readonly string[], excerptIds: readonly string[]) => void;
  onDiscover?: (input: { messageId: string; sourceDigest: string }, owner: MailReplyBatchOwner, isCurrent: () => boolean) => Promise<MailReplyConversationContextDiscovery | undefined>;
  onContinue?: (sessionId: string, owner: MailReplyBatchOwner, isCurrent: () => boolean) => Promise<MailReplyConversationContextDiscovery | undefined>;
  onLoadMessage?: (sessionId: string, rowId: string, owner: MailReplyBatchOwner, isCurrent: () => boolean) => Promise<MailReplyContextSelection | undefined>;
  onCancel?: (sessionId: string, owner: MailReplyBatchOwner) => void;
};

const dateLabel = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unknown';

export function MailReplyConversationContext({ visible, messageId, sourceDigest, ownerGeneration, blocked, busy,
  onChange, onDiscover, onContinue, onLoadMessage, onCancel }: Props) {
  const [discovery, setDiscovery] = useState<MailReplyConversationContextDiscovery>();
  const [selected, setSelected] = useState<Record<string, Selected>>({});
  const [loadingRow, setLoadingRow] = useState<string>();
  const [action, setAction] = useState<'discover' | 'continue' | undefined>();
  const [actionOwnerKey, setActionOwnerKey] = useState<string>();
  const [notice, setNotice] = useState('');
  const discoveryRef = useRef<MailReplyConversationContextDiscovery | undefined>(undefined);
  const selectedRef = useRef<Record<string, Selected>>({});
  const contextOwner = useRef<MailReplyBatchOwner>({ messageId, generation: ownerGeneration });
  const contextDigest = useRef(sourceDigest);
  const blockedRef = useRef(blocked);
  const activeRef = useRef<{ id: number } | undefined>(undefined);
  const actionSequence = useRef(0);
  const currentRef = useRef({ visible, messageId, sourceDigest, ownerGeneration });
  const onCancelRef = useRef(onCancel);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    currentRef.current = { visible, messageId, sourceDigest, ownerGeneration };
    blockedRef.current = blocked;
    onCancelRef.current = onCancel;
    onChangeRef.current = onChange;
  }, [blocked, busy, messageId, onCancel, onChange, ownerGeneration, sourceDigest, visible]);

  const publishSelected = React.useCallback((next: Record<string, Selected>) => {
    selectedRef.current = next;
    setSelected(next);
    const rows = Object.values(next).filter((entry) => entry.included);
    onChange(rows.map((entry) => entry.value.selectionId), rows.filter((entry) => entry.excerptConsent).map((entry) => entry.value.selectionId));
  }, [onChange]);
  const cancelSession = React.useCallback((value = discoveryRef.current, owner = contextOwner.current) => {
    if (!value) return;
    discoveryRef.current = undefined;
    setDiscovery(undefined);
    onCancel?.(value.sessionId, owner);
  }, [onCancel]);
  const visibleOwnerKey = JSON.stringify([messageId, ownerGeneration, sourceDigest, visible, blocked]);
  const [resetContextKey, setResetContextKey] = useState(visibleOwnerKey);
  if (resetContextKey !== visibleOwnerKey) {
    setResetContextKey(visibleOwnerKey);
    setActionOwnerKey(undefined);
    setAction(undefined);
    setLoadingRow(undefined);
  }
  const invalidateActive = React.useCallback(() => {
    actionSequence.current += 1;
    activeRef.current = undefined;
  }, []);
  useLayoutEffect(() => {
    const changed = contextOwner.current.messageId !== messageId || contextOwner.current.generation !== ownerGeneration || contextDigest.current !== sourceDigest;
    if (changed) {
      cancelSession();
      contextOwner.current = { messageId, generation: ownerGeneration };
      contextDigest.current = sourceDigest;
      publishSelected({});
      setNotice('');
      invalidateActive();
    }
    if (!visible || blocked) {
      cancelSession();
      if (Object.keys(selectedRef.current).length) publishSelected({});
      invalidateActive();
    }
  }, [blocked, cancelSession, invalidateActive, messageId, ownerGeneration, publishSelected, sourceDigest, visible]);
  useLayoutEffect(() => () => {
    const value = discoveryRef.current;
    if (value) onCancelRef.current?.(value.sessionId, contextOwner.current);
    if (Object.values(selectedRef.current).some((entry) => entry.included)) {
      selectedRef.current = {};
      onChangeRef.current([], []);
    }
    currentRef.current.visible = false;
    activeRef.current = undefined;
    actionSequence.current += 1;
  }, []);

  const isCurrent = (owner: MailReplyBatchOwner, sequence: number, digest: string, expectedSession?: string) => {
    const live = currentRef.current;
    return sequence === actionSequence.current && activeRef.current?.id === sequence &&
      live.visible && live.messageId === owner.messageId && live.ownerGeneration === owner.generation && live.sourceDigest === digest &&
      !blockedRef.current && (!expectedSession || discoveryRef.current?.sessionId === expectedSession);
  };
  const begin = () => {
    if (!visible || blocked || busy || activeRef.current) return undefined;
    const id = ++actionSequence.current;
    activeRef.current = { id };
    setActionOwnerKey(JSON.stringify([messageId, ownerGeneration, sourceDigest, visible, blocked]));
    setAction(undefined);
    setNotice('');
    return id;
  };
  const finish = (id: number) => {
    if (activeRef.current?.id !== id) return;
    activeRef.current = undefined;
    setAction(undefined);
    setLoadingRow(undefined);
  };
  const actionVisible = visible && !blocked && actionOwnerKey === visibleOwnerKey;
  const visibleAction = actionVisible ? action : undefined;
  const visibleLoadingRow = actionVisible ? loadingRow : undefined;

  const discover = async () => {
    if (!onDiscover || !sourceDigest) return;
    const sequence = begin();
    if (sequence === undefined) return;
    const owner = { messageId, generation: ownerGeneration };
    setAction('discover');
    publishSelected({});
    cancelSession();
    const current = () => isCurrent(owner, sequence, sourceDigest);
    try {
      const result = await onDiscover({ messageId, sourceDigest }, owner, current);
      if (!result) return;
      if (!current() || result.targetMessageId !== messageId) {
        onCancel?.(result.sessionId, owner);
        return;
      }
      discoveryRef.current = result;
      setDiscovery(result);
    } catch (cause) {
      if (current()) setNotice(cause instanceof Error ? cause.message : 'Conversation metadata could not be loaded.');
    } finally { finish(sequence); }
  };
  const continueDiscovery = async () => {
    const currentDiscovery = discoveryRef.current;
    if (!currentDiscovery || !onContinue) return;
    const sequence = begin();
    if (sequence === undefined) return;
    const owner = contextOwner.current;
    setAction('continue');
    const current = () => isCurrent(owner, sequence, sourceDigest, currentDiscovery.sessionId);
    try {
      const result = await onContinue(currentDiscovery.sessionId, owner, current);
      if (!result) return;
      if (!current() || result.sessionId !== currentDiscovery.sessionId || result.targetMessageId !== messageId) return;
      discoveryRef.current = result;
      setDiscovery(result);
    } catch (cause) {
      if (current()) setNotice(cause instanceof Error ? cause.message : 'The next conversation page could not be loaded.');
    } finally { finish(sequence); }
  };
  const loadMessage = async (rowId: string) => {
    const currentDiscovery = discoveryRef.current;
    if (!currentDiscovery || !onLoadMessage) return;
    const row = currentDiscovery.rows.find((item) => item.rowId === rowId);
    if (!row || row.isDraft !== false) return;
    const sequence = begin();
    if (sequence === undefined) return;
    const owner = contextOwner.current;
    setLoadingRow(rowId);
    const current = () => isCurrent(owner, sequence, sourceDigest, currentDiscovery.sessionId);
    try {
      const result = await onLoadMessage(currentDiscovery.sessionId, rowId, owner, current);
      if (!result || !current()) return;
      const next = { ...selectedRef.current, [rowId]: { value: result, included: false, excerptConsent: false } };
      publishSelected(next);
      setNotice(`Loaded “${result.subject}” for review. Include it explicitly to use it as context.`);
    } catch (cause) {
      if (current()) setNotice(cause instanceof Error ? cause.message : 'This message text could not be loaded.');
    } finally { finish(sequence); }
  };

  const toggleIncluded = (rowId: string) => {
    if (blocked || busy || activeRef.current) return;
    const current = selectedRef.current[rowId];
    if (!current) return;
    const next = { ...selectedRef.current, [rowId]: { ...current, included: !current.included, excerptConsent: current.included ? false : current.excerptConsent } };
    publishSelected(next);
    setNotice('Selected conversation context changed. Review again before submitting.');
  };
  const consentExcerpt = (rowId: string) => {
    if (blocked || busy || activeRef.current) return;
    const current = selectedRef.current[rowId];
    if (!current?.included || current.value.completeness !== 'excerpt') return;
    publishSelected({ ...selectedRef.current, [rowId]: { ...current, excerptConsent: true } });
    setNotice('Excerpt selected. Review its content and omissions before submitting.');
  };

  const loadedByRow = selected;
  return (
    <View style={styles.section}>
      <Text style={s.label}>Conversation context (optional)</Text>
      <Text style={styles.copy}>The reply target stays fixed. Only messages you load and select are included; the conversation may contain other or newer messages. This context is used only for OpenRouter Batch requests.</Text>
      <Button label={visibleAction === 'discover' ? 'Loading conversation metadata…' : discovery ? 'Reload conversation metadata' : 'Load conversation metadata'} tone="quiet" disabled={!visible || !sourceDigest || blocked || busy || Boolean(visibleAction) || !onDiscover} onPress={() => void discover()} />
      {discovery ? <>
        <Text style={styles.meta}>{discovery.coverage === 'partial' ? 'Partial metadata' : 'Conversation metadata'} · {discovery.rows.length} conversation messages · expires {dateLabel(discovery.expiresAt)}</Text>
        {discovery.omissionReasons.map((reason, index) => <Text key={`${reason}-${index}`} style={styles.meta}>Not shown · {reason.replaceAll('_', ' ')}</Text>)}
        {discovery.rows.map((row) => {
          const loaded = loadedByRow[row.rowId];
          const draftLabel = row.isDraft === true ? 'Draft · cannot select' : row.isDraft === false ? 'Sent message' : 'Draft status unknown · cannot select';
          const timestamp = row.sentAt ? `Sent ${dateLabel(row.sentAt)}` : row.receivedAt ? `Received ${dateLabel(row.receivedAt)}` : 'Time unknown';
          return <View key={row.rowId} style={styles.row}>
            <Text style={styles.subject}>{row.subject || '(no subject)'}</Text>
            <Text style={styles.meta}>{row.sender || 'Sender unknown'} · {timestamp}</Text>
            <Text style={styles.meta}>{draftLabel}</Text>
            {row.isDraft === false ? <Button label={visibleAction && visibleLoadingRow === row.rowId ? 'Loading message text…' : loaded ? 'Reload message text' : 'Load this message text'} tone="quiet" disabled={blocked || busy || Boolean(visibleAction)} onPress={() => void loadMessage(row.rowId)} /> : null}
            {loaded ? <View style={styles.loaded}>
              <Text style={styles.meta}>{loaded.value.representation.replaceAll('_', ' ')} · {loaded.value.completeness.replaceAll('_', ' ')} · {loaded.value.bytes.toLocaleString()} bytes</Text>
              <Text selectable style={styles.body}>{loaded.value.text}</Text>
              {loaded.value.omissionReasons.map((reason, index) => <Text key={`${reason}-${index}`} style={styles.meta}>Omitted · {reason.replaceAll('_', ' ')}</Text>)}
              <Pressable accessibilityRole="checkbox" accessibilityLabel={`Include ${row.subject || 'selected message'} as context`} accessibilityState={{ checked: loaded.included, disabled: blocked || busy || Boolean(visibleAction) }} disabled={blocked || busy || Boolean(visibleAction)} onPress={() => toggleIncluded(row.rowId)} style={styles.checkRow}>
                <View style={[styles.check, loaded.included && styles.checkOn]}><Text style={styles.checkMark}>{loaded.included ? '✓' : ''}</Text></View>
                <Text style={styles.copy}>Include this message as context</Text>
              </Pressable>
              {loaded.included && loaded.value.completeness === 'excerpt' ? <>
                <Text style={styles.warning}>This message is an excerpt with omissions. Review it before consenting to use it.</Text>
                <Button label={loaded.excerptConsent ? 'Excerpt consent recorded' : 'Use this excerpt'} tone="quiet" disabled={blocked || busy || Boolean(visibleAction) || loaded.excerptConsent} onPress={() => consentExcerpt(row.rowId)} />
              </> : null}
            </View> : null}
          </View>;
        })}
        {discovery.hasMore ? <Button label={visibleAction === 'continue' ? 'Loading next page…' : 'Continue to next page'} tone="quiet" disabled={blocked || busy || Boolean(visibleAction)} onPress={() => void continueDiscovery()} /> : null}
      </> : null}
      {blocked ? <Text style={styles.meta}>Conversation context is unavailable while another workspace action is active.</Text> : notice ? <Text style={styles.meta}>{notice}</Text> : null}
    </View>
  );
}

const styles = {
  section: { marginTop: 16, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  copy: { color: C.text, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  meta: { color: C.muted, fontSize: 12, lineHeight: 17, marginTop: 5 },
  row: { marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  subject: { color: C.text, fontSize: 15, fontWeight: '700' as const },
  loaded: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
  body: { color: C.text, fontSize: 13, lineHeight: 18, marginVertical: 8 },
  checkRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, paddingVertical: 8 },
  check: { width: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: C.muted, alignItems: 'center' as const, justifyContent: 'center' as const },
  checkOn: { backgroundColor: C.sage, borderColor: C.sage },
  checkMark: { color: C.bg, fontSize: 14, fontWeight: '800' as const },
  warning: { color: C.red, fontSize: 12, lineHeight: 17, marginTop: 6 },
};
