import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Account, SavedProactiveRule } from '../core';
import type { ProactiveMailAlertConsent, ProactiveMailAlertReceipt, ProactiveMailAlertState } from '../proactiveMailAlerts/types';
import { ProactiveMailAlertsSection } from '../ui/ProactiveMailAlertsSection';
import type { EnableProactiveMailAlertsInput } from '../ui/ProactiveMailAlertsSection';
import { C, s } from '../ui/theme';

type Scenario = 'available' | 'missing-account' | 'permission-denied' | 'outcome-unknown' | 'cleanup-pending';
const scenarioLabels: Record<Scenario, string> = {
  available: 'Available accounts',
  'missing-account': 'Missing account',
  'permission-denied': 'Permission denied',
  'outcome-unknown': 'Outcome unknown',
  'cleanup-pending': 'Cleanup pending',
};

const RULE_ID = 'sample-unread-rule';
const ACTIVE_RULE: SavedProactiveRule = {
  id: RULE_ID, revision: 3, version: 2, enabled: true, name: 'Priority mail', accountIds: [],
  trigger: { type: 'unread_from', addresses: ['team@example.test'] }, createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z',
};

const SAMPLE_ACCOUNTS: Account[] = [
  {
    id: 'sample-google-account', provider: 'google', displayName: 'Sample Google', email: 'alex@example.test', connected: true, authStatus: 'connected',
    identity: { providerNamespace: 'google', clientId: 'sample-google-client', subject: 'sample-google-subject', issuer: 'https://accounts.example.test', tenantId: 'sample-google-tenant' }, tokenRef: 'sample-google-token-ref',
    capabilities: ['mail.read'], connectionGeneration: 1,
  },
  {
    id: 'sample-microsoft-account', provider: 'microsoft', displayName: 'Sample Microsoft', email: 'alex@sample.example.test', connected: true, authStatus: 'connected',
    identity: { providerNamespace: 'microsoft', clientId: 'sample-ms-client', subject: 'sample-ms-subject', resourceUserId: 'sample-ms-resource', issuer: 'https://login.example.test', tenantId: 'sample-ms-tenant' }, tokenRef: 'sample-ms-token-ref',
    capabilities: ['mail.read'], connectionGeneration: 2,
  },
];

function identityKey(account: Account): string {
  const identity = account.identity!;
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}

function consentFor(accountIds: string[], status: ProactiveMailAlertConsent['status'] = 'active'): ProactiveMailAlertConsent {
  const accounts = SAMPLE_ACCOUNTS.filter((account) => accountIds.includes(account.id));
  return {
    id: '10000000-0000-4000-8000-000000000001', ruleId: RULE_ID, ruleVersion: ACTIVE_RULE.version, ruleRevision: ACTIVE_RULE.revision,
    timeZone: 'Asia/Singapore', activatedAt: '2026-10-10T03:00:00.000Z',
    accounts: accounts.map((account) => ({ accountId: account.id, identityKey: identityKey(account), connectionGeneration: account.connectionGeneration! })),
    status, ...(status === 'revoked' ? { revokedAt: '2026-10-10T04:00:00.000Z', revocationReason: 'user_revoked' as const } : {}),
  };
}

function sampleReceipt(observed: ProactiveMailAlertReceipt['observed']): ProactiveMailAlertReceipt {
  const cancel = observed === 'cancellation_pending'
    ? { requestedAt: '2026-10-11T03:00:00.000Z', result: 'requested' as const }
    : observed === 'cancelled'
      ? { requestedAt: '2026-10-11T03:00:00.000Z', attemptedAt: '2026-10-11T03:01:00.000Z', observedAt: '2026-10-11T03:02:00.000Z', result: 'absent' as const }
      : undefined;
  const desired = cancel ? 'cancel' : 'notify';
  return {
    id: '20000000-0000-4000-8000-000000000001', installationId: '30000000-0000-4000-8000-000000000001',
    consentId: '10000000-0000-4000-8000-000000000001', ruleId: RULE_ID, ruleVersion: ACTIVE_RULE.version, ruleRevision: ACTIVE_RULE.revision,
    timeZone: 'Asia/Singapore', consentActivatedAt: '2026-10-10T03:00:00.000Z', accountId: SAMPLE_ACCOUNTS[0].id,
    identityKey: identityKey(SAMPLE_ACCOUNTS[0]), connectionGeneration: 1, providerMessageId: 'sample-provider-message',
    sourceVersion: 'sample-source-version', receivedAt: '2026-10-10T05:00:00.000Z', desired, observed,
    createdAt: '2026-10-10T05:01:00.000Z', updatedAt: '2026-10-11T03:02:00.000Z', attemptedAt: '2026-10-10T05:01:00.000Z',
    ...(cancel ? { cancellation: cancel } : {}),
  };
}

function stateFor(scenario: Scenario): ProactiveMailAlertState {
  const state: ProactiveMailAlertState = { schemaVersion: 1, installationId: '30000000-0000-4000-8000-000000000001', revision: 1, consents: [], receipts: [] };
  if (scenario === 'outcome-unknown') {
    state.consents = [consentFor([SAMPLE_ACCOUNTS[0].id])];
    state.receipts = [sampleReceipt('delivery_unknown')];
  }
  if (scenario === 'cleanup-pending') {
    state.consents = [consentFor([SAMPLE_ACCOUNTS[0].id], 'revoked')];
    state.receipts = [sampleReceipt('cancellation_pending')];
  }
  return state;
}

/** Closed, fictional preview. It only updates local React state and never uses app services. */
export function MailAlertPreview() {
  const [scenario, setScenario] = useState<Scenario>('available');
  const [ledger, setLedger] = useState(() => stateFor('available'));
  const [calls, setCalls] = useState<string[]>([]);
  const accounts = scenario === 'missing-account' ? [] : SAMPLE_ACCOUNTS;
  const sampleRule = ACTIVE_RULE;
  const recoveryStatus = scenario === 'outcome-unknown'
    ? undefined
    : undefined;

  const chooseScenario = (next: Scenario) => {
    setScenario(next);
    setLedger(stateFor(next));
    setCalls([]);
  };
  const enable = async (input: EnableProactiveMailAlertsInput) => {
    setCalls((old) => [...old, `Enable called for ${input.accountIds.length} sample account${input.accountIds.length === 1 ? '' : 's'}.`]);
    if (scenario === 'permission-denied') throw new Error('Simulated permission denial; no OS prompt was requested.');
    const activeConsent = consentFor(input.accountIds);
    setLedger((old) => ({ ...old, revision: old.revision + 1, consents: [activeConsent], receipts: [] }));
  };
  const revoke = async () => {
    setCalls((old) => [...old, 'Disable called for the sample rule.']);
    setLedger((old) => ({ ...old, revision: old.revision + 1, consents: [consentFor([SAMPLE_ACCOUNTS[0].id], 'revoked')], receipts: [sampleReceipt('cancellation_pending')] }));
  };
  const reconcile = async () => {
    setCalls((old) => [...old, 'Cleanup retry called for the sample ledger.']);
    setLedger((old) => ({ ...old, revision: old.revision + 1, receipts: old.receipts.map((receipt) => receipt.observed === 'cancellation_pending' ? { ...receipt, observed: 'cancelled', cancellation: { requestedAt: '2026-10-11T03:00:00.000Z', attemptedAt: '2026-10-13T04:00:00.000Z', observedAt: '2026-10-13T04:00:01.000Z', result: 'absent' } } : receipt) }));
  };
  const refresh = async () => setCalls((old) => [...old, 'Refresh called for the sample workspace.']);

  return <ScrollView style={s.safe} contentContainerStyle={styles.container}>
    <View style={styles.previewLabel}><Text style={styles.previewLabelText}>SAMPLE · FICTIONAL DATA</Text></View>
    <Text style={s.h1Small}>Mail alert preview</Text>
    <Text style={s.intro}>This closed preview uses only fictional in-memory rules, accounts, and receipt states. Buttons update this preview and never contact providers or request notification permission.</Text>
    <Text style={styles.label}>Sample cases</Text>
    <View style={styles.scenarios}>
      {(Object.keys(scenarioLabels) as Scenario[]).map((key) => <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: scenario === key }} onPress={() => chooseScenario(key)} style={({ pressed }) => [styles.scenario, scenario === key && styles.scenarioActive, pressed && s.pressed]}><Text style={[styles.scenarioText, scenario === key && styles.scenarioTextActive]}>{scenarioLabels[key]}</Text></Pressable>)}
    </View>
    {scenario === 'permission-denied' ? <Text style={s.disclaimer}>Sample only: Enable simulates a denied permission result. No real iOS permission API is called.</Text> : null}
    {scenario === 'outcome-unknown' ? <Text style={s.disclaimer}>Sample receipt: submission outcome is unknown; the preview does not claim that iOS showed a notification.</Text> : null}
    {scenario === 'cleanup-pending' ? <Text style={s.disclaimer}>Sample receipt: cancellation is pending. Retry cleanup updates this sample ledger only.</Text> : null}
    <ProactiveMailAlertsSection
      rules={[sampleRule]} accounts={accounts} ledger={ledger} timeZone="Asia/Singapore"
      recoveryStatus={recoveryStatus} busy={false} captureAdmissionBlocked={false} previewOnly
      onEnable={enable} onRevoke={revoke} onReconcile={reconcile} onRefresh={refresh}
    />
    {calls.length > 0 ? <View style={styles.calls}><Text style={styles.label}>Sample callback activity</Text>{calls.slice(-4).map((call, index) => <Text key={`${index}-${call}`} style={styles.callText}>{call}</Text>)}</View> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({
  container: { maxWidth: 620, width: '100%', alignSelf: 'center', paddingHorizontal: 22, paddingTop: 22, paddingBottom: 38, gap: 12 },
  previewLabel: { alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', paddingHorizontal: 11, borderRadius: 18, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  previewLabelText: { color: C.sage, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  label: { color: C.muted, fontSize: 12 },
  scenarios: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  scenario: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 11, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  scenarioActive: { borderColor: C.sage, backgroundColor: '#202522' },
  scenarioText: { color: C.muted, fontSize: 11 },
  scenarioTextActive: { color: C.text, fontWeight: '600' },
  calls: { padding: 13, borderWidth: 1, borderColor: C.border, borderRadius: 13, backgroundColor: C.card, gap: 6 },
  callText: { color: C.muted, fontSize: 12, lineHeight: 18 },
});
