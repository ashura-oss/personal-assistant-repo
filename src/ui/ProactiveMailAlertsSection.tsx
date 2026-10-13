import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Account, AppState, SavedProactiveRule } from '../core';
import type { ProactiveMailAlertConsent, ProactiveMailAlertReceipt, ProactiveMailAlertState } from '../proactiveMailAlerts/types';
import { Button, IconButton } from './primitives';
import { C, s } from './theme';

export type EnableProactiveMailAlertsInput = {
  ruleId: string;
  expectedRuleVersion: number;
  expectedRuleRevision: number;
  timeZone: string;
  accountIds: string[];
};

export type ProactiveMailAlertsSectionProps = {
  rules: SavedProactiveRule[];
  accounts: Account[];
  ledger: ProactiveMailAlertState;
  timeZone: string;
  recoveryStatus?: AppState['proactiveMailAlertRecoveryStatus'];
  refreshRequired?: AppState['mailAlertRefreshRequired'];
  busy: boolean;
  captureAdmissionBlocked: boolean;
  refreshAdmissionBlocked?: boolean;
  previewOnly?: boolean;
  onEnable: (input: EnableProactiveMailAlertsInput) => Promise<void>;
  onRevoke: (ruleId: string) => Promise<void>;
  onReconcile: () => Promise<void>;
  onRefresh: () => Promise<void>;
};

type MailRule = SavedProactiveRule & {
  trigger: Extract<SavedProactiveRule['trigger'], { type: 'unread_from' | 'keyword' }>;
};

const safeActionError = 'That change could not be confirmed. Review the current status and try again.';

function isMailRule(rule: SavedProactiveRule): rule is MailRule {
  return rule.enabled && (rule.trigger.type === 'unread_from' || rule.trigger.type === 'keyword');
}

function eligibleAccount(account: Account): boolean {
  return (account.provider === 'google' || account.provider === 'microsoft') &&
    account.connected && account.authStatus === 'connected' &&
    account.identity?.providerNamespace === account.provider && Boolean(account.identity.clientId && account.identity.subject) &&
    (account.provider !== 'microsoft' || Boolean(account.identity.resourceUserId)) && Boolean(account.tokenRef) &&
    Number.isSafeInteger(account.connectionGeneration) && Number(account.connectionGeneration) >= 0 &&
    account.capabilities?.includes('mail.read') === true;
}

function accountIdentityKey(account: Account): string | undefined {
  const identity = account.identity;
  if (!identity?.providerNamespace || !identity.clientId || !identity.subject) return undefined;
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}

function consentForRule(ledger: ProactiveMailAlertState, ruleId: string): ProactiveMailAlertConsent | undefined {
  return ledger.consents.find((consent) => consent.ruleId === ruleId && consent.status === 'active');
}

function receiptsForRule(ledger: ProactiveMailAlertState, ruleId: string): ProactiveMailAlertReceipt[] {
  return ledger.receipts.filter((receipt) => receipt.ruleId === ruleId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function receiptStatus(receipt: ProactiveMailAlertReceipt): string {
  if (receipt.desired === 'cancel' && receipt.observed !== 'cancelled') {
    return receipt.observed === 'cancellation_unknown' ? 'Alert cleanup status is unknown. Retry cleanup.' : 'Alert cleanup is pending. Retry cleanup.';
  }
  switch (receipt.observed) {
    case 'attempting': return 'Alert request saved; submission is pending.';
    case 'submitted': return 'Submitted to iOS. Delivery is not confirmed.';
    case 'delivery_unknown': return 'Submission status is unknown.';
    case 'cancellation_pending': return 'Alert cleanup was requested.';
    case 'cancellation_unknown': return 'Alert cleanup status is unknown. Retry cleanup.';
    case 'cancelled': return receipt.cancellation?.result === 'absent' ? 'Verified absent from iOS notifications.' : 'Cancellation was confirmed.';
  }
}

function ruleDescription(rule: MailRule): string {
  if (rule.trigger.type === 'unread_from') return `Unread mail from ${rule.trigger.addresses.join(', ')}`;
  return rule.trigger.unreadOnly === false
    ? `Mail matching ${rule.trigger.keywords.join(', ')}`
    : `Unread mail matching ${rule.trigger.keywords.join(', ')}`;
}

export function ProactiveMailAlertsSection({
  rules, accounts, ledger, timeZone, recoveryStatus, refreshRequired, busy, captureAdmissionBlocked, refreshAdmissionBlocked = captureAdmissionBlocked,
  previewOnly = false, onEnable, onRevoke, onReconcile, onRefresh,
}: ProactiveMailAlertsSectionProps) {
  const [panelRuleId, setPanelRuleId] = useState<string | undefined>();
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const formTokenRef = useRef(0);
  const inFlightTokenRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const blocked = busy || captureAdmissionBlocked || actionBusy;
  const refreshBlocked = busy || refreshAdmissionBlocked || actionBusy;
  const mailRules = rules.filter(isMailRule);
  const eligibleAccounts = useMemo(() => accounts.filter(eligibleAccount), [accounts]);
  const panelRule = mailRules.find((rule) => rule.id === panelRuleId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      formTokenRef.current += 1;
      inFlightTokenRef.current = undefined;
    };
  }, []);

  const openPanel = (rule: MailRule) => {
    formTokenRef.current += 1;
    inFlightTokenRef.current = undefined;
    setPanelRuleId(rule.id);
    setSelectedAccountIds([]);
    setActionBusy(false);
    setActionError('');
    setActionNotice('');
  };
  const closePanel = () => {
    formTokenRef.current += 1;
    inFlightTokenRef.current = undefined;
    setPanelRuleId(undefined);
    setSelectedAccountIds([]);
    setActionBusy(false);
    setActionError('');
    setActionNotice('');
  };
  const scopedEligibleAccounts = panelRule
    ? eligibleAccounts.filter((account) => panelRule.accountIds.length === 0 || panelRule.accountIds.includes(account.id))
    : [];
  const activeConsent = panelRule ? consentForRule(ledger, panelRule.id) : undefined;
  const currentConsentAccounts = activeConsent
    ? activeConsent.accounts.filter((binding) => eligibleAccounts.some((account) => account.id === binding.accountId && account.connectionGeneration === binding.connectionGeneration && accountIdentityKey(account) === binding.identityKey))
    : [];
  const consentIsCurrent = Boolean(activeConsent && panelRule && activeConsent.ruleVersion === panelRule.version &&
    activeConsent.ruleRevision === panelRule.revision && activeConsent.timeZone === timeZone &&
    currentConsentAccounts.length === activeConsent.accounts.length && currentConsentAccounts.every((binding) => panelRule.accountIds.length === 0 || panelRule.accountIds.includes(binding.accountId)));
  const panelReceipts = panelRule ? receiptsForRule(ledger, panelRule.id) : [];
  const runAction = async (kind: 'enable' | 'revoke' | 'reconcile' | 'refresh') => {
    if ((kind === 'refresh' ? refreshBlocked : blocked) || inFlightTokenRef.current !== undefined) return;
    if (kind === 'enable' && selectedAccountIds.length === 0) {
      setActionError('Choose at least one account to continue.');
      return;
    }
    const invokedFor = formTokenRef.current;
    inFlightTokenRef.current = invokedFor;
    setActionBusy(true);
    setActionError('');
    setActionNotice('');
    try {
      if (kind === 'enable' && panelRule) {
        await onEnable({ ruleId: panelRule.id, expectedRuleVersion: panelRule.version, expectedRuleRevision: panelRule.revision, timeZone, accountIds: [...selectedAccountIds] });
      } else if (kind === 'revoke' && panelRule) await onRevoke(panelRule.id);
      else if (kind === 'reconcile') await onReconcile();
      else if (kind === 'refresh') await onRefresh();
      if (mountedRef.current && formTokenRef.current === invokedFor) {
        if (kind === 'revoke') setSelectedAccountIds([]);
        setActionNotice(kind === 'enable' ? 'Mail alerts enabled.' : kind === 'revoke' ? 'Mail alerts off. Check cleanup status below.' : kind === 'reconcile' ? 'Cleanup checked.' : 'Workspace refresh finished. Review the updated status below.');
      }
    } catch {
      if (mountedRef.current && formTokenRef.current === invokedFor) setActionError(safeActionError);
    } finally {
      if (inFlightTokenRef.current === invokedFor) inFlightTokenRef.current = undefined;
      if (mountedRef.current && formTokenRef.current === invokedFor) setActionBusy(false);
    }
  };

  return <View style={styles.section}>
    <View style={styles.sectionHeader}>
      <View style={{ flex: 1 }}>
        <Text style={s.sectionTitle}>Private mail alerts</Text>
        <Text style={s.disclaimer}>Opt in separately for each mail rule. New matching mail only.</Text>
      </View>
      {ledger.receipts.some((receipt) => receipt.desired === 'cancel' && receipt.observed !== 'cancelled') ?
        <Pressable accessibilityRole="button" accessibilityLabel="Retry alert cleanup" disabled={busy || captureAdmissionBlocked || actionBusy} onPress={() => void runAction('reconcile')} style={({ pressed }) => [styles.smallAction, pressed && s.pressed, (busy || captureAdmissionBlocked || actionBusy) && s.disabled]}>
          <Text style={styles.actionText}>Retry cleanup</Text>
        </Pressable> : null}
    </View>
    {recoveryStatus ? <Text accessibilityRole="alert" style={s.errorText}>{recoveryStatus.message}</Text> : null}
    {refreshRequired ? <View style={styles.notice}><Text style={styles.noticeText}>Saved data changed. Refresh local data before continuing.</Text><Button label="Refresh workspace" tone="quiet" onPress={() => void runAction('refresh')} disabled={refreshBlocked} /></View> : null}
    {mailRules.length === 0 ? <Text style={s.disclaimer}>Enable an unread mail rule to review its alert settings.</Text> : mailRules.map((rule) => {
      const consent = consentForRule(ledger, rule.id);
      const latest = receiptsForRule(ledger, rule.id)[0];
      return <View key={rule.id} style={styles.ruleRow}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.ruleName}>{rule.name}</Text>
          <Text style={styles.ruleDescription} numberOfLines={2}>{ruleDescription(rule)}</Text>
          {consent ? <Text style={styles.ruleDescription}>{consent.accounts.length} account{consent.accounts.length === 1 ? '' : 's'} · {consent.timeZone}</Text> : null}
          {latest ? <Text style={styles.statusText}>{receiptStatus(latest)}</Text> : <Text style={styles.statusText}>{consent ? 'Enabled for new matching mail.' : 'Off'}</Text>}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Review mail alerts for ${rule.name}`} disabled={busy || captureAdmissionBlocked} onPress={() => openPanel(rule)} style={({ pressed }) => [styles.reviewButton, pressed && s.pressed, (busy || captureAdmissionBlocked) && s.disabled]}>
          <Text style={styles.actionText}>Review mail alerts</Text>
        </Pressable>
      </View>;
    })}

    <Modal visible={Boolean(panelRule)} animationType="slide" presentationStyle="pageSheet" onRequestClose={closePanel}>
      <SafeAreaProvider>
      <SafeAreaView style={s.modalSafe} edges={['top', 'bottom']}>
        <View style={s.modalHeader}>
          <IconButton name="close" label="Close mail alert settings" onPress={closePanel} />
          <Text style={s.modalTitle}>Mail alert settings</Text>
          <View style={{ width: 46, height: 46 }} />
        </View>
        <ScrollView contentContainerStyle={styles.panelContent}>
          {panelRule ? <>
            {previewOnly ? <View style={s.previewBadge}><Text style={s.previewText}>SAMPLE · SIMULATED</Text></View> : null}
            <Text style={s.kicker}>PRIVATE NOTIFICATIONS</Text>
            <Text style={s.h1Small}>{panelRule.name}</Text>
            <Text style={s.intro}>{ruleDescription(panelRule)}. Alerts apply only to new mail arriving after you enable them. Quiet hours are respected, and iOS decides when to present a notification.</Text>
            <View style={styles.fixedCopy}><Text style={styles.fixedCopyTitle}>Fixed notification text</Text><Text style={styles.fixedCopyBody}>New mail alert</Text><Text style={styles.fixedCopyBody}>A saved mail rule matched a new message.</Text><Text style={styles.fixedCopyFoot}>No sender, subject, snippet, or message text appears in the notification.</Text></View>

            {recoveryStatus ? <Text accessibilityRole="alert" style={s.errorText}>{recoveryStatus.message}</Text> : null}
            {refreshRequired ? <View style={styles.notice}><Text style={styles.noticeText}>Saved data changed. Refresh local data before continuing.</Text><Button label="Refresh workspace" tone="quiet" onPress={() => void runAction('refresh')} disabled={refreshBlocked} /></View> : null}
            {consentIsCurrent && activeConsent ? <>
              <View style={styles.consentCard}>
                <Text style={styles.cardTitle}>Enabled for new matching mail</Text>
                <Text style={styles.statusText}>{activeConsent.accounts.length} approved account{activeConsent.accounts.length === 1 ? '' : 's'} · {activeConsent.timeZone}</Text>
                <Text style={s.disclaimer}>Rule edits, time zone changes, or account changes require you to enable alerts again.</Text>
              </View>
              <Button label="Disable mail alerts" tone="danger" onPress={() => void runAction('revoke')} disabled={blocked} />
            </> : activeConsent ? <View style={styles.notice}><Text style={styles.noticeText}>These alerts no longer match the current rule or connected accounts. Refresh local data before enabling again.</Text><Button label="Refresh local data" tone="quiet" onPress={() => void runAction('refresh')} disabled={refreshBlocked} /></View> : <>
              <Text style={s.sectionTitle}>Choose accounts</Text>
              <Text style={s.disclaimer}>Selection starts empty. Choose at least one connected Google or Microsoft account with verified mail read access.</Text>
              {scopedEligibleAccounts.length === 0 ? <View style={styles.emptyCard}><Text style={styles.statusText}>No eligible connected accounts are available for this rule.</Text><Text style={s.disclaimer}>Connect or refresh an account, then review alerts again.</Text></View> : scopedEligibleAccounts.map((account) => {
                const selected = selectedAccountIds.includes(account.id);
                return <Pressable key={account.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`${account.displayName || account.email}, ${account.email}`} disabled={blocked || Boolean(recoveryStatus) || Boolean(refreshRequired)} onPress={() => setSelectedAccountIds((value) => selected ? value.filter((id) => id !== account.id) : [...value, account.id])} style={({ pressed }) => [styles.accountRow, selected && styles.accountSelected, pressed && s.pressed, (blocked || recoveryStatus || refreshRequired) && s.disabled]}>
                  <View style={[styles.checkbox, selected && styles.checkboxSelected]}><Text style={styles.checkmark}>{selected ? '✓' : ''}</Text></View>
                  <View style={{ flex: 1 }}><Text style={styles.accountName}>{account.displayName || account.email}</Text><Text style={styles.accountEmail}>{account.email}</Text></View>
                  <Text style={styles.provider}>{account.provider === 'google' ? 'Google' : 'Microsoft'}</Text>
                </Pressable>;
              })}
              {panelReceipts.slice(0, 3).map((receipt) => <Text key={receipt.id} style={styles.statusText}>{receiptStatus(receipt)}</Text>)}
              <Button label="Enable private mail alerts" onPress={() => void runAction('enable')} disabled={blocked || selectedAccountIds.length === 0 || Boolean(recoveryStatus) || Boolean(refreshRequired)} />
            </>}

            {panelReceipts.length > 0 ? <View style={styles.receiptCard}>
              <Text style={styles.cardTitle}>Recent alert status</Text>
              {panelReceipts.slice(0, 5).map((receipt) => <Text key={receipt.id} style={styles.statusText}>{receiptStatus(receipt)}</Text>)}
            </View> : null}
            {panelRule && panelReceipts.some((receipt) => receipt.desired === 'cancel' && receipt.observed !== 'cancelled') ? <Pressable accessibilityRole="button" accessibilityLabel={`Retry cleanup for ${panelRule.name}`} disabled={busy || captureAdmissionBlocked || actionBusy} onPress={() => void runAction('reconcile')} style={({ pressed }) => [styles.panelRetry, pressed && s.pressed, (busy || captureAdmissionBlocked || actionBusy) && s.disabled]}><Text style={styles.actionText}>Retry alert cleanup</Text></Pressable> : null}
            {actionError ? <Text accessibilityRole="alert" style={s.errorText}>{actionError}</Text> : null}
            {actionNotice ? <Text accessibilityLiveRegion="polite" style={styles.statusText}>{actionNotice}</Text> : null}
            <Text style={s.disclaimer}>iOS submission does not confirm that a notification was shown or delivered.</Text>
          </> : null}
        </ScrollView>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  section: { backgroundColor: C.card, borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 16, gap: 11 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: C.border, paddingVertical: 11 },
  ruleName: { color: C.text, fontSize: 14, fontWeight: '600' },
  ruleDescription: { color: C.muted, fontSize: 11, lineHeight: 16 },
  statusText: { color: C.sage, fontSize: 12, lineHeight: 18 },
  actionText: { color: C.text, fontSize: 12, fontWeight: '600' },
  smallAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  panelRetry: { minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 13, borderWidth: 1, borderColor: C.border, borderRadius: 13, backgroundColor: C.card },
  reviewButton: { minHeight: 44, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: 7 },
  panelContent: { paddingHorizontal: 24, paddingBottom: 38, gap: 13 },
  fixedCopy: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 15, padding: 14, gap: 6 },
  fixedCopyTitle: { color: C.text, fontSize: 13, fontWeight: '600' },
  fixedCopyBody: { color: C.text, fontSize: 13 },
  fixedCopyFoot: { color: C.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  accountRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: C.border, borderRadius: 13, backgroundColor: C.card, paddingHorizontal: 12, paddingVertical: 7 },
  accountSelected: { borderColor: C.sage, backgroundColor: '#202522' },
  checkbox: { width: 23, height: 23, borderRadius: 7, borderWidth: 1, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { borderColor: C.sage, backgroundColor: C.sage },
  checkmark: { color: C.bg, fontSize: 15, fontWeight: '700' },
  accountName: { color: C.text, fontSize: 13, fontWeight: '500' },
  accountEmail: { color: C.muted, fontSize: 11, marginTop: 2 },
  provider: { color: C.muted, fontSize: 10 },
  emptyCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 14, gap: 5 },
  consentCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 14, gap: 7 },
  receiptCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 14, gap: 7 },
  cardTitle: { color: C.text, fontSize: 14, fontWeight: '600' },
  notice: { backgroundColor: '#211F1A', borderColor: '#494435', borderWidth: 1, borderRadius: 13, padding: 12, gap: 7 },
  noticeText: { color: C.text, fontSize: 12, lineHeight: 18 },
});
