import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { Account, AppSettings, DeviceCalendarAccessStatus, MailboxSnapshotMessage, ProactiveCandidateSourceResult, ProactiveState } from '../core';
import type { DeviceCalendarState } from '../deviceCalendars/types';
import type { DeepReadonly } from '../cloud/workspaceDto';
import { ProactiveCandidatesSection } from './ProactiveCandidatesSection';
import { MailboxSection } from './MailboxSection';
import { WorkspaceInboxProposalList, type WorkspaceProposalCardDisplay } from './WorkspaceContent';
import { Button } from './primitives';
import { s } from './theme';
import type { WorkspaceActionCapability } from './workspaceCapabilities';

export type InboxAccountDisplay = Readonly<Pick<Account, 'id' | 'provider' | 'displayName' | 'email' | 'connected' | 'authStatus' | 'connectionGeneration'>>;
export type InboxDeviceCalendarDisplay = Readonly<{
  installationId: string; generation: number; selectionRevision: number; enabled: boolean; selectedCalendarIds: readonly string[];
  calendars: readonly Readonly<{ localId: string; title: string; timeZone?: string }>[];
  events: readonly Readonly<{ generation: number; calendarId: string; nativeEventId: string; occurrenceStart: string; cancelled: boolean; observedAt: string }>[];
  readRun?: Readonly<{ generation: number; selectionRevision: number; selectedCalendarIds: readonly string[] }>;
}>;

export function inboxAccountDisplay(account: Pick<Account, 'id' | 'provider' | 'displayName' | 'email' | 'connected' | 'authStatus' | 'connectionGeneration'>): InboxAccountDisplay {
  return { id: account.id, provider: account.provider, displayName: account.displayName, email: account.email, connected: account.connected,
    authStatus: account.authStatus, ...(account.connectionGeneration !== undefined ? { connectionGeneration: account.connectionGeneration } : {}) };
}

export function inboxDeviceCalendarDisplay(value: DeviceCalendarState): InboxDeviceCalendarDisplay {
  return { installationId: value.installationId, generation: value.generation, selectionRevision: value.selectionRevision, enabled: value.enabled,
    selectedCalendarIds: [...value.selectedCalendarIds], calendars: value.calendars.map((item) => ({ localId: item.localId, title: item.title, ...(item.timeZone ? { timeZone: item.timeZone } : {}) })),
    events: value.events.map((item) => ({ generation: item.generation, calendarId: item.calendarId, nativeEventId: item.nativeEventId, occurrenceStart: item.occurrenceStart, cancelled: item.cancelled, observedAt: item.observedAt })),
    ...(value.readRun ? { readRun: { generation: value.readRun.generation, selectionRevision: value.readRun.selectionRevision, selectedCalendarIds: [...value.readRun.selectedCalendarIds] } } : {}) };
}

/** Full shared inbox presentation. Each coordinator supplies only actions it can actually perform. */
export function InboxWorkspaceContent({ proposals, accounts, mailbox, deviceCalendars, deviceCalendarAccess, onReplyMessage, proactive, filter, setFilter, mode, onOpen, busy, onDismissCandidate, onSnoozeCandidate, onRemindCandidate, onGetCandidateSource, chatActionFilterNoteId, onClearChatFilter }:
  { proposals: readonly WorkspaceProposalCardDisplay[]; accounts: readonly DeepReadonly<InboxAccountDisplay>[]; mailbox: readonly DeepReadonly<MailboxSnapshotMessage>[]; deviceCalendars?: DeepReadonly<InboxDeviceCalendarDisplay>; deviceCalendarAccess: DeviceCalendarAccessStatus;
    onReplyMessage: WorkspaceActionCapability<(messageId: string) => void>; proactive: DeepReadonly<ProactiveState>; filter: 'pending' | 'done'; setFilter: (v: 'pending' | 'done') => void; mode: AppSettings['mode'];
    onOpen: WorkspaceActionCapability<(proposalId: string, expectedRevision: number) => void>; busy: boolean; onDismissCandidate: WorkspaceActionCapability<(candidateId: string) => void>; onSnoozeCandidate: WorkspaceActionCapability<(candidateId: string, until: string) => void>;
    onRemindCandidate: WorkspaceActionCapability<(candidateId: string) => void>; onGetCandidateSource: WorkspaceActionCapability<(candidateId: string) => Promise<ProactiveCandidateSourceResult>>;
    chatActionFilterNoteId?: string; onClearChatFilter: () => void }) {
  return <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
    {chatActionFilterNoteId ? <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}><Text style={s.sectionTitle}>Suggested actions from this chat turn</Text><Button label="View all actions" tone="quiet" onPress={onClearChatFilter} /></View> : null}
    <WorkspaceInboxProposalList proposals={proposals} accounts={accounts} filter={filter} onFilter={setFilter} preview={mode === 'preview'}
      review={onOpen.available ? { available: true, action: onOpen.action } : { available: false, reason: onOpen.reason }} />
    <ProactiveCandidatesSection proactive={proactive} accounts={accounts} deviceCalendars={deviceCalendars} deviceCalendarAccess={deviceCalendarAccess} busy={busy}
      onDismiss={onDismissCandidate} onSnooze={onSnoozeCandidate} onRemind={onRemindCandidate} onGetSource={onGetCandidateSource} />
    <MailboxSection messages={mailbox} accounts={accounts} onReply={onReplyMessage} />
  </ScrollView>;
}
