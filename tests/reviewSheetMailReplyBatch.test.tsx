/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal, MailReplyProvenance, MailReplyBatchSourcesRefreshResult } from '../src/core';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { ReviewSheet } from '../src/ui/ReviewSheet';
import type { DispatchRecord } from '../src/dispatch';
import { resolveLinkedDispatchRecord } from '../src/ui/reviewSheetAuthority';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, style: _style, onPress, accessibilityRole, accessibilityLabel, accessibilityState, ...props }: Record<string, unknown> & { children?: React.ReactNode; style?: unknown; onPress?: () => void; accessibilityState?: { selected?: boolean } }) => ReactModule.createElement(tag, { ...props, ...(onPress ? { onClick: onPress } : {}), ...(accessibilityRole ? { role: accessibilityRole } : {}), ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}), ...(accessibilityState ? { 'aria-checked': accessibilityState.selected } : {}) }, children);
  return { Pressable: element('button'), ScrollView: element('div'), Text: element('span'), View: element('div') };
});
vi.mock('../src/ui/DispatchHistory', () => ({ DispatchHistory: () => null }));
vi.mock('../src/ui/DeviceEventDispatchHistory', () => ({ DeviceEventDispatchHistory: () => null }));
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    Field: ({ label, value, onChangeText, multiline }: { label: string; value: string; onChangeText: (value: string) => void; multiline?: boolean }) => ReactModule.createElement('label', null, label, ReactModule.createElement(multiline ? 'textarea' : 'input', { value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChangeText(event.target.value) })),
    IconButton: ({ label, onPress }: { label: string; onPress: () => void }) => ReactModule.createElement('button', { type: 'button', onClick: onPress }, label),
  };
});
vi.mock('../src/ui/theme', () => ({ s: new Proxy({}, { get: () => ({}) }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const batchReplyProvenance: MailReplyProvenance = {
  version: 2, kind: 'mail_reply', sourceDigest: 'a'.repeat(64), expiresAt: '2099-10-14T12:00:00.000Z', batchJobId: 'mail-job',
  source: {
    version: 1, accountId: '11111111-1111-4111-8111-111111111111', accountEmail: 'me@example.com', identity: { providerNamespace: 'google', clientId: 'mail-client', subject: 'mail-subject' },
    connectionGeneration: 1, localMessageId: 'message-1', providerMessageId: 'provider-1', idFormat: 'gmail',
    internetMessageId: '<message-1@example.com>', subject: 'Original subject', replyMetadataComplete: true,
    observedAt: '2026-10-14T08:00:00.000Z', sourceDigest: 'a'.repeat(64),
  },
};
const proposal: Proposal = {
  id: '22222222-2222-4222-8222-222222222222', kind: 'email', title: 'Reply subject', body: 'Generated batch text.', status: 'draft', revision: 1,
  recipients: ['person@example.com'], evidence: [], accountId: '11111111-1111-4111-8111-111111111111', provenance: batchReplyProvenance,
  email: {
    operation: 'draft', to: ['person@example.com'], cc: ['copy@example.com'], bcc: ['hidden@example.com'], subject: 'Reply subject',
    text: 'Generated batch text.', attachments: [],
    reply: { mode: 'reply', sourceDigest: 'a'.repeat(64), localMessageId: 'message-1', providerMessageId: 'provider-1', idFormat: 'gmail', internetMessageId: '<message-1@example.com>', sourceSubject: 'Original subject' },
  },
};
function reviewProps(value: Proposal, options: { accounts?: ReturnType<typeof createInitialWorkspaceState>['accounts']; calendars?: ReturnType<typeof createInitialWorkspaceState>['calendars'];
  dispatchRecords?: DispatchRecord[]; replyAllowedOperations?: readonly ('draft' | 'send')[] } = {}) {
  const state = createInitialWorkspaceState(() => '33333333-3333-4333-8333-333333333333');
  state.settings.mode = 'provider';
  if (options.accounts) state.accounts.push(...options.accounts);
  if (options.calendars) state.calendars.push(...options.calendars);
  if (options.dispatchRecords) state.dispatchRecords.push(...options.dispatchRecords);
  state.proposals.push(value);
  const dto = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: '44444444-4444-4444-8444-444444444444', privacyEpoch: 1, revision: 1 });
  const current = resolveLinkedDispatchRecord(value, state.dispatchRecords);
  return {
    settingsMode: dto.state.settings.mode,
    accounts: dto.state.accounts.map((account) => ({ id: account.id, provider: account.provider, displayName: account.displayName, email: account.email,
      connected: account.connected && account.authStatus === 'connected', allowedEmailOperations: [
        ...(account.connected && account.authStatus === 'connected' && account.capabilities?.includes('mail.draft') ? ['draft' as const] : []),
        ...(account.connected && account.authStatus === 'connected' && account.capabilities?.includes('mail.send') ? ['send' as const] : []),
      ] })),
    calendars: dto.state.calendars.map((calendar) => {
      const account = dto.state.accounts.find((item) => item.id === calendar.accountId);
      const writable = Boolean(calendar.writable && calendar.connected && account?.connected && account.capabilities?.includes('calendar.write'));
      return { id: calendar.id, accountId: calendar.accountId, name: calendar.name, accountEmail: account?.email ?? '', writable,
        ...(!writable ? { unavailableReason: !account?.connected ? 'Account not connected' : !account.capabilities?.includes('calendar.write')
          ? 'Account does not allow calendar changes' : !calendar.connected ? 'Calendar not connected' : 'Read only' } : {}) };
    }),
    deviceCalendars: { enabled: dto.state.deviceCalendars.enabled, selectedCalendarIds: dto.state.deviceCalendars.selectedCalendarIds,
      choices: dto.state.deviceCalendars.calendars.map((calendar) => ({ localId: calendar.localId, title: calendar.title, sourceName: calendar.sourceName,
        allowsModifications: calendar.allowsModifications, selected: dto.state.deviceCalendars.selectedCalendarIds.includes(calendar.localId) })),
      accessStatus: dto.state.deviceCalendarAccess.status, writeAvailable: dto.state.deviceCalendars.enabled && dto.state.deviceCalendarAccess.status === 'full_access' },
    proposal: dto.state.proposals[0]!, dispatchRecords: dto.state.dispatchRecords,
    ...(current ? { currentDispatchRecord: dto.state.dispatchRecords.find((record) => record.id === current.id) } : {}),
    deviceEventDispatchRecords: dto.state.deviceCalendars.dispatchHistory.map((record) => ({ ...record, targetLabel: "On this iPhone", nativeReferenceRecorded: false })),
    ...(options.replyAllowedOperations ? { replyAllowedOperations: options.replyAllowedOperations } : {}),
  };
}

describe('ReviewSheet Batch reply immutability', () => {
  it('shows the exact saved message and recipients without editable fields or Save edits', () => {
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(proposal), busy: false,
      onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));

    expect(host.textContent).toContain('This reply draft came from a completed Batch request and is immutable.');
    expect(host.textContent).toContain('write a separate manual reply in the message composer');
    expect(host.textContent).toContain('person@example.com');
    expect(host.textContent).toContain('copy@example.com');
    expect(host.textContent).toContain('Generated batch text.');
    expect(host.querySelectorAll('input,textarea')).toHaveLength(0);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Save edits')).toBe(false);
  });

  it('shows a frozen Batch send proposal with mail.send capability and the Microsoft thread caveat', () => {
    const sendProposal: Proposal = {
      ...proposal,
      email: { ...proposal.email!, operation: 'send' },
      provenance: {
        ...batchReplyProvenance,
        source: { ...batchReplyProvenance.source, identity: { providerNamespace: 'microsoft', clientId: 'mail-client', subject: 'mail-subject' } },
      },
    };
    const connected = { id: '11111111-1111-4111-8111-111111111111', provider: 'microsoft' as const, displayName: 'Me', email: 'me@example.com', connected: true, authStatus: 'connected' as const,
      connectionGeneration: 1, identity: { providerNamespace: 'microsoft' as const, clientId: 'mail-client', subject: 'mail-subject' }, capabilities: ['mail.send' as const] };
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(sendProposal, { accounts: [connected], replyAllowedOperations: ['send'] }), busy: false,
      onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    expect(host.textContent).toContain('This send proposal came from a completed Batch request and is immutable.');
    expect(host.textContent).toContain('Outlook may display this reply outside the original conversation.');
    expect(host.textContent).toContain('Bcc · hidden@example.com');
    expect(host.textContent).toContain('Approve send proposal');
    expect(host.textContent).not.toContain('sent');
    expect(host.querySelectorAll('input,textarea')).toHaveLength(0);
  });

  it('keeps dispatch-recovery-retired proposals readable with their original status and no mutation actions', () => {
    const approve = vi.fn(); const execute = vi.fn(); const dismiss = vi.fn(); const edit = vi.fn();
    const retired: Proposal = { ...proposal, dispatchRecoveryRetired: true, provenance: undefined, status: 'draft' };
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(retired), busy: false,
      onClose: vi.fn(), onEdit: edit, onApprove: approve, onExecute: execute, onDismiss: dismiss,
    })));
    expect(host.textContent).toContain('RETIRED ACTION · READ ONLY');
    expect(host.textContent).toContain('ORIGINAL STATUS DRAFT');
    expect(host.textContent).toContain('permanently read-only');
    expect(host.textContent).toContain('Generated batch text.');
    expect(host.textContent).toContain('hidden@example.com');
    expect(host.textContent).toContain('Bcc · hidden@example.com');
    expect(host.querySelectorAll('input,textarea')).toHaveLength(0);
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Close review', 'Close review']);
    expect(edit).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();

    const retiredEvent: Proposal = {
      ...retired, id: '55555555-5555-4555-8555-555555555555', kind: 'event', title: 'Retired event', body: 'Event details', status: 'unknown',
      email: undefined, accountId: 'calendar-account', calendarId: 'calendar-1',
      eventDestination: { kind: 'remote_calendar', accountId: 'calendar-account', calendarId: 'calendar-1' },
      event: {
        title: 'Retired event', description: 'Event details', start: '2026-10-15T10:00:00.000Z',
        end: '2026-10-15T11:00:00.000Z', timeZone: 'UTC', attendees: ['guest@example.com'], invitePolicy: 'send',
      },
    };
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(retiredEvent), busy: false,
      onClose: vi.fn(), onEdit: edit, onApprove: approve, onExecute: execute, onDismiss: dismiss,
    })));
    expect(host.textContent).toContain('Invitation policy · send with event');
    expect(host.textContent).not.toContain('Invitations · sent');
    expect(host.textContent).toContain('ORIGINAL STATUS UNKNOWN');
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Close review', 'Close review']);
    expect(edit).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
  });

  it('refreshes and displays the fixed target plus selected subset in the immutable draft review', async () => {
    let resolveRefresh!: (result: MailReplyBatchSourcesRefreshResult) => void;
    const refresh = vi.fn((_jobId: string, _proposalId: string, _revision: number, _isCurrent: () => boolean) =>
      new Promise<MailReplyBatchSourcesRefreshResult>((resolve) => { resolveRefresh = resolve; }));
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(proposal), busy: false, mailReplyContextCount: 1,
      mailReplySourcesStatus: { status: 'refresh_required' }, onRefreshMailReplySources: refresh,
      onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    const refreshButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh fixed target and selected messages')!;
    expect(refreshButton.disabled).toBe(false);
    act(() => { refreshButton.click(); refreshButton.click(); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0].slice(0, 3)).toEqual(['mail-job', '22222222-2222-4222-8222-222222222222', 1]);
    expect(refresh.mock.calls[0][3]()).toBe(true);
    const item = { selectionId: 'opaque-target', isReplyTarget: true, subject: 'Original subject', sender: 'me@example.com', sentAt: '2026-10-14T09:00:00Z', representation: 'plain' as const, completeness: 'complete_text' as const, bytes: 100, omissionReasons: [] };
    await act(async () => { resolveRefresh({ status: 'current', jobId: 'mail-job', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), sources: [item] }); await Promise.resolve(); });
    expect(host.textContent).toContain('The fixed target and selected messages were checked again.');
    expect(host.textContent).toContain('Fixed reply target · Original subject');
    expect(host.textContent).toContain('complete text · 100 bytes');
  });

  it('does not publish a source refresh result after the proposal review closes', async () => {
    let resolveRefresh!: (result: MailReplyBatchSourcesRefreshResult) => void;
    const refresh = vi.fn((_jobId: string, _proposalId: string, _revision: number, _isCurrent: () => boolean) =>
      new Promise<MailReplyBatchSourcesRefreshResult>((resolve) => { resolveRefresh = resolve; }));
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(proposal), busy: false, mailReplyContextCount: 1,
      mailReplySourcesStatus: { status: 'refresh_required' }, onRefreshMailReplySources: refresh,
      onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh fixed target and selected messages')!.click());
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(proposal), proposal: null, onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    const item = { selectionId: 'opaque-target', isReplyTarget: true, subject: 'Original subject', representation: 'plain' as const, completeness: 'complete_text' as const, bytes: 100, omissionReasons: [] };
    await act(async () => { resolveRefresh({ status: 'current', jobId: 'mail-job', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), sources: [item] }); await Promise.resolve(); });
    expect(host.textContent).not.toContain('Fixed reply target · Original subject');
  });

  it('shows the exact linked receipt independent of history order and marks a missing link incomplete', () => {
    const receipt = (id: string) => ({ version: 1 as const, id, proposalId: proposal.id, approvedRevision: 1, payloadDigest: 'e'.repeat(64), sourceActionKey: `source-${id}`, duplicateKey: `duplicate-${id}`,
      sourceProvenance: batchReplyProvenance, operation: 'send' as const, accountId: '11111111-1111-4111-8111-111111111111',
      account: { provider: 'google' as const, identity: { providerNamespace: 'google' as const, clientId: 'mail-client', subject: 'mail-subject' }, displayName: 'Me', email: 'me@example.com' },
      title: id === '77777777-7777-4777-8777-777777777777' ? 'Earlier attempt' : 'Exact linked attempt', body: 'Immutable receipt body',
      payload: { kind: 'email' as const, email: { to: ['person@example.com'], cc: [], bcc: ['hidden@example.com'], subject: 'Reply subject', text: 'Approved receipt content', attachments: [] } },
      dispatchStartedAt: '2026-10-14T08:00:00.000Z', outcome: 'unknown' as const, reconciliations: [] });
    const linkedId = '88888888-8888-4888-8888-888888888888';
    const unknown: Proposal = { ...proposal, status: 'unknown', dispatchRecordId: linkedId };
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(unknown, { dispatchRecords: [receipt('77777777-7777-4777-8777-777777777777'), receipt(linkedId)] }),
      onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    expect(host.textContent).toContain('Exact linked attempt');
    expect(host.textContent).toContain('OUTCOME UNKNOWN');
    expect(host.textContent).not.toContain('Earlier attempt');

    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps({ ...unknown, dispatchRecordId: undefined }, { dispatchRecords: [receipt(linkedId)] }),
      onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    expect(host.textContent).toContain('Saved external action');
    expect(host.textContent).toContain('HISTORY INCOMPLETE');
    expect(host.textContent).not.toContain('Exact linked attempt');
  });

  it('rechecks the edited calendar account against its own write capability', () => {
    const accountId = '11111111-1111-4111-8111-111111111111';
    const otherAccountId = '99999999-9999-4999-8999-999999999999';
    const calendarId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherCalendarId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const accounts = [
      { id: accountId, provider: 'google' as const, displayName: 'Writable', email: 'write@example.test', connected: true, authStatus: 'connected' as const,
        identity: { providerNamespace: 'google' as const, clientId: 'one', subject: 'one' }, capabilities: ['calendar.write' as const] },
      { id: otherAccountId, provider: 'microsoft' as const, displayName: 'Read only', email: 'readonly@example.test', connected: true, authStatus: 'connected' as const,
        identity: { providerNamespace: 'microsoft' as const, clientId: 'two', subject: 'two' }, capabilities: [] },
    ];
    const calendars = [
      { id: calendarId, accountId, name: 'Writable calendar', connected: true, writable: true, providerId: 'provider-one' },
      { id: otherCalendarId, accountId: otherAccountId, name: 'Read only calendar', connected: true, writable: true, providerId: 'provider-two' },
    ];
    const eventProposal: Proposal = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'event', title: 'Planning', body: 'Agenda', status: 'approved', revision: 2,
      accountId, calendarId, eventDestination: { kind: 'remote_calendar', accountId, calendarId }, recipients: [], evidence: [],
      event: { title: 'Planning', description: 'Agenda', start: '2026-10-16T02:00:00.000Z', end: '2026-10-16T03:00:00.000Z', timeZone: 'UTC', attendees: [], invitePolicy: 'none' } };
    const edit = vi.fn();
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(eventProposal, { accounts, calendars }), onClose: vi.fn(), onEdit: edit, onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    expect(host.textContent).toContain('Writable calendar');
    act(() => [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Use online calendar account readonly@example.test')!.click());
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save edits')!.click());
    expect(edit.mock.calls[0]?.[0]).toMatchObject({ accountId: otherAccountId, calendarId: otherCalendarId });
    const persistedEdit: Proposal = { ...eventProposal, revision: 3, accountId: otherAccountId, calendarId: otherCalendarId,
      eventDestination: { kind: 'remote_calendar', accountId: otherAccountId, calendarId: otherCalendarId } };
    act(() => root.render(React.createElement(ReviewSheet, {
      ...reviewProps(persistedEdit, { accounts, calendars }), onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Create approved event')?.disabled).toBe(true);
    expect(host.textContent).toContain('Account does not allow calendar changes');
  });
});
