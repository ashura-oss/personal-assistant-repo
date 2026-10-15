import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import { Button } from './primitives';
import { C, s } from './theme';
import { WorkspaceSettingsPreferences, type WorkspaceSettingsDraft, type WorkspaceSettingsPreferenceSave, type WorkspaceSettingsPreferenceUpdate } from './WorkspaceSettingsPreferences';
import type { CloudCredentialController } from '../web/useCloudCredentials';
import { CloudCredentialsPanel } from './CloudCredentialsPanel';
import { CloudConnectionsPanel, type CloudConnectionsCapability } from './CloudConnectionsPanel';

export type WorkspaceSettingsDisplay = WorkspaceSnapshotDTO['state'];
export type WorkspaceSettingsAction = Readonly<{ available: true; action: () => void | Promise<void> }> | Readonly<{ available: false; reason: string }>;
export type WorkspaceSettingsActions = Readonly<{
  preferences: Readonly<{ update: WorkspaceSettingsPreferenceUpdate; save: WorkspaceSettingsPreferenceSave }>;
  accounts: WorkspaceSettingsAction;
  calendars: WorkspaceSettingsAction;
  connections: WorkspaceSettingsAction;
  recovery: WorkspaceSettingsAction;
}>;
export type WorkspaceSettingsCredentialCapability = Readonly<{ available: true; controller: CloudCredentialController }> | Readonly<{ available: false; reason: string }>;
export type WorkspaceSettingsConnectionCapability = CloudConnectionsCapability;

function Unavailable({ capability }: { capability: WorkspaceSettingsAction }) {
  return capability.available ? null : <Text style={styles.meta}>{capability.reason}</Text>;
}

function CapabilityButton({ label, capability, busy }: { label: string; capability: WorkspaceSettingsAction; busy: boolean }) {
  return capability.available
    ? <Button label={label} disabled={busy} onPress={() => void capability.action()} />
    : <Unavailable capability={capability} />;
}

export function WorkspaceSettingsScreen({ display, actions, busy, onClose, preferencesDraft, preferencesMessage, onReloadPreferences, credentials, connectionCapability }: { display: WorkspaceSettingsDisplay; actions: WorkspaceSettingsActions; busy: boolean; onClose: () => void; preferencesDraft?: WorkspaceSettingsDraft; preferencesMessage?: string; onReloadPreferences?: () => void; credentials?: WorkspaceSettingsCredentialCapability; connectionCapability?: WorkspaceSettingsConnectionCapability }) {
  const settings = display.settings;
  const activeRules = display.proactive.rules.filter((rule) => rule.enabled).length;
  const pendingSuggestions = display.knowledge.suggestions.filter((suggestion) => suggestion.status === 'pending').length;
  const pendingReminders = display.reminders.records.filter((record) => record.status === 'draft' || record.status === 'approved').length;
  const runningJobs = display.assistantBatchJobs.filter((job) => job.status === 'preparing' || job.status === 'submitting' || job.status === 'submission_unknown' || job.status === 'queued' || job.status === 'processing').length;
  return <ScrollView contentContainerStyle={s.scroll}>
    <View style={s.modalHeader}>
      <Button label="Close settings" tone="quiet" disabled={busy} onPress={onClose} />
      <Text style={s.modalTitle}>Settings</Text>
      <View style={{ width: 46 }} />
    </View>
    <Text style={s.intro}>Saved workspace preferences and connected account details.</Text>
    <WorkspaceSettingsPreferences
      draft={preferencesDraft ?? { providerEnabled: settings.mode === 'provider', speechEnabled: settings.speechEnabled === true, speechProvider: settings.speechProvider ?? 'azure', speechEndpoint: settings.speechEndpoint ?? '', effort: settings.openRouterReasoningEffort ?? 'low', maxAudioSeconds: String(settings.maxAudioSeconds), retention: settings.audioRetention }}
      update={actions.preferences.update}
      save={actions.preferences.save}
      busy={busy}
      demoMode={false}
      description={settings.llmProvider !== 'openrouter' ? 'Legacy text-provider settings are inactive. Saving explicitly switches new text requests to OpenRouter Batch.' : undefined}
    />
    {preferencesMessage ? <View style={styles.card}><Text accessibilityRole="alert" style={styles.meta}>{preferencesMessage}</Text>{onReloadPreferences ? <Button label="Reload saved settings" tone="quiet" disabled={busy} onPress={onReloadPreferences} /> : null}</View> : null}
    {credentials?.available ? <View style={styles.credentials}><CloudCredentialsPanel controller={credentials.controller} /></View>
      : credentials ? <Text style={styles.meta}>{credentials.reason}</Text> : null}
    <View style={styles.card}>
      <Text style={styles.title}>Workspace</Text>
      <Text style={styles.meta}>Mode · {settings.mode}</Text>
      <Text style={styles.meta}>Text provider · {settings.llmProvider ?? 'not configured'} · {settings.openRouterModel ?? 'model not selected'}</Text>
      <Text style={styles.meta}>Reasoning effort · {settings.openRouterReasoningEffort ?? 'not set'}</Text>
      <Text style={styles.meta}>Time zone · {settings.timezone}</Text>
      <Text style={styles.meta}>Background mail refresh · {settings.backgroundMailRefreshEnabled ? 'on' : 'off'}</Text>
      <Text style={styles.meta}>Audio retention · {settings.audioRetention}</Text>
      <Text style={styles.meta}>Speech · {settings.speechEnabled ? 'enabled' : 'disabled'} · {settings.speechProvider ?? 'not configured'}</Text>
      <Text style={styles.meta}>Maximum audio · {settings.maxAudioSeconds} seconds</Text>
    </View>
    <View style={styles.card}>
      <Text style={styles.title}>Usage</Text>
      <Text style={styles.meta}>Provider-reported token counts are not billing estimates.</Text>
      <Text style={styles.meta}>{display.usage.inputTokens} input tokens · {display.usage.outputTokens} output tokens · {display.usage.transcriptionSeconds} transcription seconds · {display.usage.unknownCharges} unknown charges</Text>
      <Text style={styles.meta}>{display.usage.requests} requests · {display.usage.attemptsToday} attempts today · {display.usage.attempts} recorded attempts</Text>
    </View>
    <Text style={s.sectionTitle}>Connections</Text>
    {connectionCapability ? <CloudConnectionsPanel capability={connectionCapability} busy={busy} /> : <>
    {display.accounts.map((account) => <View key={account.id} style={styles.card}>
      <Text style={styles.title}>{account.displayName}</Text>
      <Text style={styles.meta}>{account.provider} · {account.email}</Text>
      <Text style={styles.meta}>{account.connected ? 'Connected' : 'Disconnected'} · {account.authStatus}</Text>
      <Text style={styles.meta}>{account.credentialConfigured ? 'Credentials configured' : 'Credentials not configured'} · {account.lastSyncedAt ? `Last synced ${new Date(account.lastSyncedAt).toLocaleString()}` : 'Not synced yet'}</Text>
      <Text style={styles.meta}>Sync · {display.syncStates[account.id]?.status ?? 'not started'}</Text>
    </View>)}
    {display.accounts.length === 0 ? <Text style={styles.meta}>No accounts are saved.</Text> : null}
    <CapabilityButton label="Manage connections" capability={actions.connections} busy={busy} />
    </>}
    <Text style={s.sectionTitle}>Calendars</Text>
    {display.calendars.map((calendar) => <View key={calendar.id} style={styles.card}>
      <Text style={styles.title}>{calendar.name}</Text>
      <Text style={styles.meta}>{calendar.connected ? 'Connected' : 'Disconnected'} · {calendar.writable ? 'Writable' : 'Read only'}</Text>
    </View>)}
    <Text style={s.sectionTitle}>Saved events</Text>
    {display.calendarEvents.map((event) => <View key={event.id} style={styles.card}>
      <Text style={styles.title}>{event.subject || 'Untitled event'}</Text>
      <Text style={styles.meta}>{event.start || 'Start unavailable'} · {event.timeZone || 'Time zone unavailable'}</Text>
    </View>)}
    <View style={styles.card}>
      <Text style={styles.title}>Device calendars</Text>
      <Text style={styles.meta}>Access · {display.deviceCalendarAccess.status}{display.deviceCalendarAccess.checkedAt ? ` · checked ${new Date(display.deviceCalendarAccess.checkedAt).toLocaleString()}` : ''}</Text>
      <Text style={styles.meta}>{display.deviceCalendars.calendars.length} calendars saved · {display.deviceCalendars.selectedCalendarIds.length} selected</Text>
      <Text style={styles.meta}>Calendar snapshot · {display.deviceCalendars.readStatus ? `${display.deviceCalendars.readStatus.partial ? 'partial' : 'complete'} · ${new Date(display.deviceCalendars.readStatus.startedAt).toLocaleString()}` : 'not available'}</Text>
      <Unavailable capability={actions.calendars} />
    </View>
    <Text style={s.sectionTitle}>Attention and reminders</Text>
    <View style={styles.card}>
      <Text style={styles.title}>Proactive review</Text>
      <Text style={styles.meta}>{activeRules} enabled rules · {display.proactive.candidates.length} saved candidates</Text>
      <Text style={styles.meta}>{display.proactiveMailAlerts.consents.length} alert consents · {display.proactiveMailAlerts.receipts.length} delivery receipts</Text>
      {display.proactive.integrityError ? <Text style={styles.meta}>{display.proactive.integrityError}</Text> : null}
      {display.proactiveMailAlertRecoveryStatus?.message ? <Text style={styles.meta}>{display.proactiveMailAlertRecoveryStatus.message}</Text> : null}
    </View>
    <View style={styles.card}>
      <Text style={styles.title}>Saved reminders</Text>
      <Text style={styles.meta}>{display.reminders.records.length} records · {pendingReminders} awaiting review · {display.reminders.intents.length} alert intents</Text>
      {display.reminderRecoveryStatus?.message ? <Text style={styles.meta}>{display.reminderRecoveryStatus.message}</Text> : null}
    </View>
    <View style={styles.card}>
      <Text style={styles.title}>Batch history</Text>
      <Text style={styles.meta}>{display.assistantBatchJobs.length} saved requests · {runningJobs} still checking</Text>
      {display.assistantBatchRecoveryStatus?.message ? <Text style={styles.meta}>{display.assistantBatchRecoveryStatus.message}</Text> : null}
    </View>
    <Text style={s.sectionTitle}>Knowledge, documents, and backups</Text>
    <View style={styles.card}>
      <Text style={styles.title}>Knowledge review</Text>
      <Text style={styles.meta}>{display.knowledge.people.length} people · {display.knowledge.projects.length} projects · {pendingSuggestions} suggestions awaiting review</Text>
      {display.knowledgeRecoveryStatus?.message ? <Text style={styles.meta}>{display.knowledgeRecoveryStatus.message}</Text> : null}
    </View>
    <View style={styles.card}>
      <Text style={styles.title}>Documents and backups</Text>
      <Text style={styles.meta}>{display.documents.length} saved documents · {display.importedBackups.length} imported backups</Text>
      {display.backupRecoveryStatus?.message ? <Text style={styles.meta}>{display.backupRecoveryStatus.message}</Text> : null}
    </View>
    <View style={styles.card}>
      <Text style={styles.title}>Local and device recovery</Text>
      <Text style={styles.meta}>Pending credential cleanup · {display.credentialCleanup.pendingCount}</Text>
      <Text style={styles.meta}>Transcription attempts · {display.transcription.attempts.length}</Text>
      {display.transcriptionRecoveryStatus?.message ? <Text style={styles.meta}>{display.transcriptionRecoveryStatus.message}</Text> : null}
      {display.dispatchRecoveryStatus?.message ? <Text style={styles.meta}>{display.dispatchRecoveryStatus.message}</Text> : null}
      {display.deviceCalendarRecoveryStatus?.message ? <Text style={styles.meta}>{display.deviceCalendarRecoveryStatus.message}</Text> : null}
      {display.assistantChatRecoveryStatus?.message ? <Text style={styles.meta}>{display.assistantChatRecoveryStatus.message}</Text> : null}
      {display.credentialCleanup.pendingCount > 0 ? <Text style={styles.meta}>Cleanup by reason · {Object.entries(display.credentialCleanup.reasons).map(([reason, count]) => `${reason}: ${count}`).join(' · ')}</Text> : null}
    </View>
    <CapabilityButton label="Review and recover saved data" capability={actions.recovery} busy={busy} />
    <Unavailable capability={actions.accounts} />
    <Text style={styles.meta}>This view shows saved account, calendar, reminder, recovery, and usage status. Browser actions remain available only when a matching server capability is provided.</Text>
  </ScrollView>;
}

const styles = {
  card: { gap: 7, padding: 14, marginBottom: 10, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  title: { color: C.text, fontSize: 15, fontWeight: '600' as const },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  credentials: { marginBottom: 10 },
};
