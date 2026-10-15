import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { WorkspaceAccountDTO } from '../cloud/workspaceDto';
import type { CloudOAuthState } from '../web/cloudOAuthCoordinator';
import type { OAuthCapability, OAuthProvider } from '../web/cloudOAuthClient';
import { Button } from './primitives';
import { C } from './theme';

export type CloudConnectionsAccount = Readonly<Omit<Pick<WorkspaceAccountDTO, 'id' | 'provider' | 'displayName' | 'email' | 'connected' | 'authStatus' | 'connectionGeneration'>, 'provider'> & {
  provider: Exclude<WorkspaceAccountDTO['provider'], 'local'>;
  capabilities?: readonly NonNullable<WorkspaceAccountDTO['capabilities']>[number][];
}>;
export type CloudConnectionsActions = Readonly<{
  open(): void | Promise<void>;
  reload(): void | Promise<void>;
  refreshWorkspace(): void | Promise<void>;
  start(provider: OAuthProvider, capabilities: readonly OAuthCapability[], reconnectAccountId?: string): void | Promise<void>;
  restart(provider: OAuthProvider, capabilities: readonly OAuthCapability[], attemptId: string, reconnectAccountId?: string): void | Promise<void>;
  inspectStart(provider: OAuthProvider, attemptId: string): void | Promise<void>;
  inspectStage(stageId: string): void | Promise<void>;
  installStage(stageId: string): void | Promise<void>;
  inspectInstall(): void | Promise<void>;
}>;
export type CloudConnectionsCapability = Readonly<{ available: true; state: CloudOAuthState; accounts: readonly CloudConnectionsAccount[]; blockedReason?: string; actions: CloudConnectionsActions }> |
  Readonly<{ available: false; reason: string }>;

const capabilityOptions: readonly Readonly<{ id: OAuthCapability; title: string; description: string }>[] = [
  { id: 'mail.read', title: 'Read mail', description: 'Read selected inbox messages.' },
  { id: 'mail.draft', title: 'Create drafts', description: 'Prepare drafts for your approval.' },
  { id: 'mail.send', title: 'Send email', description: 'Request send permission separately.' },
  { id: 'calendar.read', title: 'Read calendars', description: 'View calendars and existing events.' },
  { id: 'calendar.write', title: 'Create calendar events', description: 'Request event write permission separately.' },
];
const providerTitle = (value: OAuthProvider) => value === 'google' ? 'Google' : 'Microsoft';

function CapabilityToggle({ provider, id, title, description, checked, disabled, onToggle }: {
  provider: OAuthProvider; id: OAuthCapability; title: string; description: string; checked: boolean; disabled: boolean; onToggle(): void;
}) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={`${provider} ${title}`} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onToggle} style={styles.scopeRow}>
    <View style={[styles.checkbox, checked && styles.checkboxOn]}><Text style={styles.check}>{checked ? '✓' : ''}</Text></View>
    <View style={{ flex: 1 }}><Text style={styles.scopeTitle}>{title}</Text><Text style={styles.detail}>{description}</Text></View>
  </Pressable>;
}

export function CloudConnectionsPanel({ capability, busy }: { capability: CloudConnectionsCapability; busy: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Record<OAuthProvider, OAuthCapability[]>>({
    google: ['mail.read', 'calendar.read'], microsoft: ['mail.read', 'calendar.read'],
  });
  const [reconnect, setReconnect] = useState<Record<OAuthProvider, string | undefined>>({ google: undefined, microsoft: undefined });
  if (!capability.available) return <View style={styles.card}><Text style={styles.title}>Connections</Text><Text style={styles.meta}>{capability.reason}</Text></View>;
  const { state, accounts, actions } = capability;
  const inspectionBlocked = busy || state.loading || Boolean(state.operation);
  const blocked = inspectionBlocked || Boolean(capability.blockedReason) || Boolean(state.unknownStart) || Boolean(state.workspaceRefreshRequired);
  const setCapability = (provider: OAuthProvider, id: OAuthCapability) => {
    setSelected((current) => {
      const old = current[provider];
      let next = old.includes(id) ? old.filter((item) => item !== id) : [...old, id];
      if (id === 'calendar.write' && !old.includes(id) && !next.includes('calendar.read')) next = [...next, 'calendar.read'];
      if (id === 'calendar.read' && old.includes(id)) next = next.filter((item) => item !== 'calendar.write');
      return { ...current, [provider]: next };
    });
  };
  return <View style={styles.card}>
    <Text style={styles.title}>Connections</Text>
    <Text style={styles.meta}>Choose access for each account. A connection is added only after you review the verified account.</Text>
    {!expanded ? <Button label="Manage connections" tone="quiet" disabled={busy} onPress={() => { setExpanded(true); void actions.open(); }} /> : <>
      {state.loading ? <Text style={styles.meta}>Loading connection status…</Text> : null}
      {state.message ? <Text accessibilityRole="alert" style={styles.meta}>{state.message}</Text> : null}
      {state.workspaceRefreshRequired ? <Button label="Refresh workspace" tone="quiet" disabled={inspectionBlocked} onPress={() => void actions.refreshWorkspace()} /> : null}
      {state.installCommandId ? <Button label="Inspect exact account-install command" tone="quiet" disabled={inspectionBlocked} onPress={() => void actions.inspectInstall()} /> : null}
      {capability.blockedReason ? <Text style={styles.meta}>{capability.blockedReason}</Text> : null}
      <Button label="Refresh connection requests" tone="quiet" disabled={inspectionBlocked} onPress={() => void actions.reload()} />
      {(['google', 'microsoft'] as const).map((provider) => {
        const available = state.availability?.[provider] === true;
        const providerAccounts = accounts.filter((account) => account.provider === provider);
        return <View key={provider} style={styles.providerCard}>
          <Text style={styles.providerTitle}>{providerTitle(provider)}</Text>
          <Text style={styles.meta}>{state.availability ? available ? 'Available to connect' : 'Not configured on this server' : 'Availability has not been checked.'}</Text>
          {providerAccounts.map((account) => <View key={account.id} style={styles.account}>
            <Text style={styles.title}>{account.displayName || providerTitle(provider)}</Text>
            <Text style={styles.meta}>{account.email || 'Email not provided'} · {account.connected ? 'Connected' : account.authStatus}</Text>
            <Text style={styles.meta}>Access · {account.capabilities?.join(', ') || 'none'} · generation {account.connectionGeneration ?? 'unknown'}</Text>
            <Pressable accessibilityRole="radio" accessibilityLabel={`Reconnect ${account.displayName || providerTitle(provider)}`} accessibilityState={{ checked: reconnect[provider] === account.id }} disabled={blocked || !available} onPress={() => setReconnect((current) => ({ ...current, [provider]: current[provider] === account.id ? undefined : account.id }))} style={styles.reconnect}>
              <Text style={styles.meta}>{reconnect[provider] === account.id ? 'Selected for reconnect' : 'Select this account to reconnect'}</Text>
            </Pressable>
          </View>)}
          <Text style={styles.sectionLabel}>Requested access</Text>
          {capabilityOptions.map((option) => <CapabilityToggle key={option.id} provider={provider} {...option} checked={selected[provider].includes(option.id)} disabled={blocked || !available} onToggle={() => setCapability(provider, option.id)} />)}
          {selected[provider].includes('calendar.write') ? <Text style={styles.notice}>Calendar event creation includes read access.</Text> : null}
          <Button label={reconnect[provider] ? `Reconnect ${providerTitle(provider)} account` : `Connect ${providerTitle(provider)}`} disabled={blocked || !available || !state.availability || selected[provider].length === 0} onPress={() => void actions.start(provider, selected[provider], reconnect[provider])} />
        </View>;
      })}
      <Text style={styles.sectionLabel}>Connection requests</Text>
      {state.attempts.map((attempt) => <View key={attempt.startAttemptId} style={styles.account}>
        <Text style={styles.title}>{providerTitle(attempt.provider)} · {attempt.status.replaceAll('_', ' ')}</Text>
        <Text style={styles.meta}>Started {new Date(attempt.createdAt).toLocaleString()} · expires {new Date(attempt.expiresAt).toLocaleString()}</Text>
        <Button label="Inspect request status" tone="quiet" disabled={inspectionBlocked} onPress={() => void actions.inspectStart(attempt.provider, attempt.startAttemptId)} />
        {attempt.status === 'verified' ? <Button label="Review verified connection" tone="quiet" disabled={inspectionBlocked} onPress={() => void actions.inspectStage(attempt.stageId)} /> : null}
        {['authorization_pending', 'inspect_required', 'restart_required'].includes(attempt.status) ? <Button label={`Restart ${providerTitle(attempt.provider)} request`} tone="quiet" disabled={blocked || state.availability?.[attempt.provider] !== true || selected[attempt.provider].length === 0} onPress={() => void actions.restart(attempt.provider, selected[attempt.provider], attempt.startAttemptId, reconnect[attempt.provider])} /> : null}
      </View>)}
      {state.unknownStart ? <View style={styles.account}>
        <Text style={styles.meta}>The start result is uncertain. Inspect the original request before any restart.</Text>
        <Button label="Inspect uncertain start" tone="quiet" disabled={inspectionBlocked} onPress={() => void actions.inspectStart(state.unknownStart!.provider, state.unknownStart!.attemptId)} />
      </View> : null}
      {state.stage ? <View style={styles.account}>
        <Text style={styles.title}>{providerTitle(state.stage.provider)} · {state.stage.status.replaceAll('_', ' ')}</Text>
        <Text style={styles.meta}>Stage expires {new Date(state.stage.expiresAt).toLocaleString()}.</Text>
        {state.stage.status === 'verified' && state.verifiedAccount ? <>
          <Text style={styles.title}>{state.verifiedAccount.displayName}</Text>
          {state.verifiedAccount.email ? <Text style={styles.meta}>{state.verifiedAccount.email}</Text> : null}
          <Text style={styles.meta}>Requested access · {state.verifiedAccount.requestedCapabilities.join(', ') || 'none'}</Text>
          <Text style={styles.meta}>Granted access · {state.verifiedAccount.capabilities.join(', ') || 'none'}</Text>
          {state.verifiedAccount.reconnectAccountId ? (() => {
            const target = accounts.find((item) => item.id === state.verifiedAccount?.reconnectAccountId && item.provider === state.stage?.provider);
            return target ? <Text style={styles.meta}>Reconnect target · {target.displayName || providerTitle(target.provider)}</Text> : <Text accessibilityRole="alert" style={styles.meta}>Reconnect target is not present in saved accounts. Refresh the workspace before adding this connection.</Text>;
          })() : null}
          <Text style={styles.meta}>Review this account and access before continuing. Adding it is a separate action.</Text>
          <Button label="Add account" disabled={blocked || !state.availability?.[state.stage.provider] || Boolean(state.verifiedAccount.reconnectAccountId && !accounts.some((item) => item.id === state.verifiedAccount?.reconnectAccountId && item.provider === state.stage?.provider))} onPress={() => void actions.installStage(state.stage!.attemptId)} />
        </> : state.stage.status === 'verified' ? <Text style={styles.meta}>Verified account details are not available yet. Inspect the stage again before continuing.</Text> : null}
        {state.stage.status === 'consumed' ? <Text style={styles.meta}>This verified connection has already been used. Refresh account details; it cannot be installed again.</Text> : null}
        {state.stage.status === 'exchange_claimed' ? <Text style={styles.meta}>The provider response is still being checked. Restart is unavailable until this request reaches a terminal status.</Text> : null}
      </View> : null}
      <Button label="Close connection details" tone="quiet" disabled={Boolean(state.operation)} onPress={() => setExpanded(false)} />
    </>}
  </View>;
}

const styles = {
  card: { gap: 9, padding: 14, marginBottom: 10, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  providerCard: { gap: 8, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.border },
  providerTitle: { color: C.text, fontSize: 16, fontWeight: '700' as const },
  title: { color: C.text, fontSize: 14, fontWeight: '600' as const },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  sectionLabel: { color: C.text, fontSize: 13, fontWeight: '600' as const, marginTop: 8 },
  scopeRow: { flexDirection: 'row' as const, gap: 10, paddingVertical: 7, alignItems: 'center' as const },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: C.border, alignItems: 'center' as const, justifyContent: 'center' as const },
  checkboxOn: { backgroundColor: C.sage, borderColor: C.sage },
  check: { color: C.bg, fontSize: 14, fontWeight: '700' as const },
  scopeTitle: { color: C.text, fontSize: 13 }, detail: { color: C.muted, fontSize: 11 },
  notice: { color: C.sage, fontSize: 12 },
  account: { gap: 6, padding: 11, borderRadius: 12, backgroundColor: '#111315', borderWidth: 1, borderColor: C.border },
  reconnect: { paddingVertical: 7 },
};
