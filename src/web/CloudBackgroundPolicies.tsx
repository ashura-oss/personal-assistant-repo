import React from 'react';
import { Text, View } from 'react-native';
import type { WorkspaceAccountDTO } from '../cloud/workspaceDto';
import type { BackgroundPolicyDisplay } from '../cloud/backgroundContracts';
import { Button, Field } from '../ui/primitives';
import { C, s } from '../ui/theme';
import type { CloudBackgroundPolicyCoordinator, CloudBackgroundPolicyState } from './cloudBackgroundPolicyCoordinator';

export type CloudBackgroundPolicyAccount = Readonly<Pick<WorkspaceAccountDTO, 'id' | 'provider' | 'displayName' | 'email' | 'connected' | 'authStatus' | 'connectionGeneration'>> &
  Readonly<{ capabilities?: readonly string[] }>;

export function CloudBackgroundPolicies({ coordinator, state, accounts, busy, blocked }: {
  coordinator: CloudBackgroundPolicyCoordinator;
  state: CloudBackgroundPolicyState;
  accounts: readonly CloudBackgroundPolicyAccount[];
  busy: boolean;
  blocked: boolean;
}) {
  const draft = state.draft;
  const currentAccount = (id: string) => accounts.find((item) => item.id === id);
  const selectedAccount = (id: string) => draft?.accounts.find((item) => item.accountId === id);
  const requiredCapabilities = draft?.resources.map((resource) => resource === 'mail' ? 'mail.read' : 'calendar.read') ?? [];
  const selectionCurrent = Boolean(draft && draft.accounts.length > 0 && draft.accounts.every((selection) => {
    const account = currentAccount(selection.accountId);
    return account?.connected && account.authStatus === 'connected' && account.connectionGeneration === selection.expectedConnectionGeneration &&
      requiredCapabilities.every((capability) => account.capabilities?.includes(capability));
  }));
  const intervalValid = Boolean(draft && /^\d+$/.test(draft.intervalMinutes) && Number(draft.intervalMinutes) >= 1 && Number(draft.intervalMinutes) <= 1440);
  const formValid = Boolean(draft && !blocked && !busy && !state.heldCommand && draft.accounts.length && draft.resources.length && intervalValid && selectionCurrent);
  const accountLabel = (policy: BackgroundPolicyDisplay, accountId: string) => {
    const savedLabel = policy.accounts.find((item) => item.accountId === accountId)?.label.trim();
    if (savedLabel) return savedLabel;
    const account = currentAccount(accountId);
    return account?.displayName?.trim() || account?.email?.trim() || account?.provider || 'Connected account';
  };
  const policyNeedsReload = (policyId: string) => state.reloadRequiredPolicies?.some((item) => item.policyId === policyId) ?? false;

  return <View style={styles.container}>
    <Text style={styles.section}>Background account sync</Text>
    <Text style={styles.meta}>Choose accounts, resources, and cadence. A policy is active only after you explicitly save it enabled. Account reconnects require a fresh selection.</Text>
    {state.heldCommand ? <View style={styles.card}>
      <Text style={styles.meta}>A policy request is awaiting exact receipt inspection. It will not be sent again automatically.</Text>
      <Button label="Inspect exact policy receipt" tone="quiet" disabled={busy} onPress={() => { void coordinator.inspectHeldCommand(); }} />
    </View> : null}
    {state.notice ? <Text style={styles.meta} accessibilityRole="alert">{state.notice}</Text> : null}
    <View style={styles.actions}>
      <Button label="New account sync policy" disabled={busy || blocked || Boolean(state.heldCommand)} onPress={() => coordinator.startNewDraft()} />
      <Button label={state.loading ? 'Loading policies…' : state.loaded ? 'Reload saved policies' : 'Load saved policies'} tone="quiet" disabled={busy || blocked || state.loading || Boolean(state.heldCommand)} onPress={() => { void coordinator.loadFirstPage(); }} />
    </View>
    {draft ? <View style={styles.card}>
      <Text style={styles.title}>{draft.policyId ? 'Review account sync policy' : 'New account sync policy'}</Text>
      <Text style={styles.meta}>Cadence is in minutes; the supported range is 1 to 1,440. New policies default to 5 minutes.</Text>
      <Field label="Run every (minutes)" keyboardType="numeric" value={draft.intervalMinutes} onChangeText={(value) => coordinator.setIntervalMinutes(value)} editable={!busy && !blocked && !state.heldCommand} />
      <Text style={styles.meta}>Resources</Text>
      <View style={styles.actions}>
        {(['mail', 'calendars'] as const).map((resource) => <Button key={resource} label={`${draft.resources.includes(resource) ? 'Selected' : 'Select'} ${resource}`}
          tone={draft.resources.includes(resource) ? 'light' : 'quiet'} disabled={busy || blocked || Boolean(state.heldCommand)} onPress={() => coordinator.toggleResource(resource)} />)}
      </View>
      <Text style={styles.meta}>Accounts. Every selected account must grant all selected resources.</Text>
      {accounts.filter((account) => account.provider === 'google' || account.provider === 'microsoft').map((account) => {
        const selection = selectedAccount(account.id);
        const supported = account.connected && account.authStatus === 'connected' && requiredCapabilities.every((capability) => account.capabilities?.includes(capability));
        const versionMatches = !selection || selection.expectedConnectionGeneration === account.connectionGeneration;
        const label = `${selection ? 'Remove' : 'Select'} ${account.displayName || account.provider} (${account.email || 'email unavailable'})`;
        return <View key={account.id} style={styles.account}>
          <Text style={styles.meta}>{account.displayName || account.provider} · {account.email || 'email unavailable'} · {account.connected && account.authStatus === 'connected' ? 'Connected' : account.authStatus}</Text>
          {selection && !versionMatches ? <Text style={styles.warning}>Connection changed. Remove and reselect to review the current connection before enabling this policy.</Text> : null}
          {!supported && !selection ? <Text style={styles.meta}>Unavailable for the selected resources or current connection.</Text> : null}
          <Button label={label} tone={selection ? 'quiet' : 'light'} disabled={busy || blocked || Boolean(state.heldCommand) || (!selection && !supported)}
            onPress={() => coordinator.toggleAccount(account.id)} />
        </View>;
      })}
      {!accounts.some((account) => account.connected && account.authStatus === 'connected' && requiredCapabilities.every((capability) => account.capabilities?.includes(capability)))
        ? <Text style={styles.meta}>No connected account grants all selected resources.</Text> : null}
      <View style={styles.actions}>
        <Button label="Save paused policy" tone="quiet" disabled={!formValid} onPress={() => { void coordinator.saveDraft(false); }} />
        <Button label={draft.policyId ? 'Save and enable' : 'Save and enable policy'} disabled={!formValid} onPress={() => { void coordinator.saveDraft(true); }} />
        <Button label="Cancel policy edits" tone="quiet" disabled={busy} onPress={() => coordinator.cancelDraft()} />
      </View>
    </View> : null}
    {state.loaded ? state.policies?.length ? state.policies.map((policy) => <View key={policy.policyId} style={styles.card}>
      <Text style={styles.title}>{policy.specification.kind === 'account_sync' ? 'Account sync' : `Saved ${policy.specification.kind.replaceAll('_', ' ')} policy`} · {policy.status}</Text>
      <Text style={styles.meta}>Effective {new Date(policy.effectiveFrom).toLocaleString()}</Text>
      {policy.specification.kind === 'account_sync' ? <>
        <Text style={styles.meta}>Resources · {policy.specification.resources.join(', ')} · every {policy.specification.intervalMinutes} minutes</Text>
        <Text style={styles.meta}>Accounts · {policy.specification.accounts.map((selection) => {
          const account = policy.accounts.find((item) => item.accountId === selection.accountId);
          return `${accountLabel(policy, selection.accountId)} · ${account?.connected ? 'connected' : 'disconnected'}`;
        }).join('; ')}</Text>
        {policy.status === 'suspended' ? <Text style={styles.warning}>Suspended · {policy.suspension?.replaceAll('_', ' ') ?? 'connection changed'}.</Text> : null}
        {policyNeedsReload(policy.policyId) ? <Text style={styles.warning}>This policy changed. Reload its saved revision before editing, pausing, or revoking it.</Text> : null}
        <View style={styles.actions}>
          {policy.status !== 'revoked' ? <Button label={`Review / edit ${policy.specification.accounts.map((selection) => accountLabel(policy, selection.accountId)).join(', ')}`} tone="quiet" disabled={busy || blocked || Boolean(state.heldCommand) || policyNeedsReload(policy.policyId)} onPress={() => coordinator.editPolicy(policy.policyId)} /> : null}
          {policy.status !== 'paused' && policy.status !== 'revoked' ? <Button label={`Pause ${policy.specification.accounts.map((selection) => accountLabel(policy, selection.accountId)).join(', ')}`} tone="quiet" disabled={busy || blocked || Boolean(state.heldCommand) || policyNeedsReload(policy.policyId)} onPress={() => { void coordinator.pausePolicy(policy.policyId); }} /> : null}
          {policy.status !== 'revoked' ? <Button label={`Revoke ${policy.specification.accounts.map((selection) => accountLabel(policy, selection.accountId)).join(', ')}`} tone="danger" disabled={busy || blocked || Boolean(state.heldCommand) || policyNeedsReload(policy.policyId)} onPress={() => { void coordinator.revokePolicy(policy.policyId); }} /> : null}
        </View>
      </> : <Text style={styles.meta}>This policy type is shown for reference and cannot be edited from this screen.</Text>}
    </View>) : <Text style={styles.meta}>No saved background policies.</Text> : null}
    {state.nextAfterPolicyId ? <Button label="Load more policies" tone="quiet" disabled={busy || blocked || state.loading || Boolean(state.heldCommand)} onPress={() => { void coordinator.loadMore(); }} /> : null}
  </View>;
}

const styles = {
  container: { gap: 9, marginBottom: 16 },
  section: { color: C.text, fontSize: 17, fontWeight: '700' as const, marginTop: 12 },
  card: { gap: 8, padding: 14, marginVertical: 4, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  title: { color: C.text, fontSize: 15, fontWeight: '600' as const },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  warning: { color: C.red, fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 7 },
  account: { gap: 6, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border },
};
