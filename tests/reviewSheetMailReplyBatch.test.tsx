/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal, MailReplyProvenance, MailReplyBatchSourcesRefreshResult } from '../src/core';
import { ReviewSheet } from '../src/ui/ReviewSheet';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, style: _style, ...props }: Record<string, unknown> & { children?: React.ReactNode; style?: unknown }) => ReactModule.createElement(tag, props, children);
  return { Pressable: element('button'), ScrollView: element('div'), Text: element('span'), View: element('div') };
});
vi.mock('../src/services/controller', () => ({ controller: { getSnapshot: () => ({}) } }));
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
    version: 1, accountId: 'account-1', accountEmail: 'me@example.com', identity: {} as MailReplyProvenance['source']['identity'],
    connectionGeneration: 1, localMessageId: 'message-1', providerMessageId: 'provider-1', idFormat: 'gmail',
    internetMessageId: '<message-1@example.com>', subject: 'Original subject', replyMetadataComplete: true,
    observedAt: '2026-10-14T08:00:00.000Z', sourceDigest: 'a'.repeat(64),
  },
};
const proposal: Proposal = {
  id: 'proposal-1', kind: 'email', title: 'Reply subject', body: 'Generated batch text.', status: 'draft', revision: 1,
  recipients: ['person@example.com'], evidence: [], accountId: 'account-1', provenance: batchReplyProvenance,
  email: {
    operation: 'draft', to: ['person@example.com'], cc: ['copy@example.com'], bcc: ['hidden@example.com'], subject: 'Reply subject',
    text: 'Generated batch text.', attachments: [],
    reply: { mode: 'reply', sourceDigest: 'a'.repeat(64), localMessageId: 'message-1', providerMessageId: 'provider-1', idFormat: 'gmail', internetMessageId: '<message-1@example.com>', sourceSubject: 'Original subject' },
  },
};
const state = {
  settings: { mode: 'provider' }, accounts: [], calendars: [], dispatchRecords: [],
  deviceCalendars: { enabled: false, calendars: [], selectedCalendarIds: [] },
  deviceCalendarAccess: { status: 'unavailable' },
} as never;

describe('ReviewSheet Batch reply immutability', () => {
  it('shows the exact saved message and recipients without editable fields or Save edits', () => {
    act(() => root.render(React.createElement(ReviewSheet, {
      state, proposal, dispatchRecords: [], busy: false,
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

  it('keeps dispatch-recovery-retired proposals readable with their original status and no mutation actions', () => {
    const approve = vi.fn(); const execute = vi.fn(); const dismiss = vi.fn(); const edit = vi.fn();
    const retired: Proposal = { ...proposal, dispatchRecoveryRetired: true, provenance: undefined, status: 'draft' };
    act(() => root.render(React.createElement(ReviewSheet, {
      state, proposal: retired, dispatchRecords: [], busy: false,
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
      ...retired, id: 'event-retired', kind: 'event', title: 'Retired event', body: 'Event details', status: 'unknown',
      email: undefined, accountId: 'calendar-account', calendarId: 'calendar-1',
      eventDestination: { kind: 'remote_calendar', accountId: 'calendar-account', calendarId: 'calendar-1' },
      event: {
        title: 'Retired event', description: 'Event details', start: '2026-10-15T10:00:00.000Z',
        end: '2026-10-15T11:00:00.000Z', timeZone: 'UTC', attendees: ['guest@example.com'], invitePolicy: 'send',
      },
    };
    act(() => root.render(React.createElement(ReviewSheet, {
      state, proposal: retiredEvent, dispatchRecords: [], busy: false,
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
      state, proposal, dispatchRecords: [], busy: false, mailReplyContextCount: 1,
      mailReplySourcesStatus: { status: 'refresh_required' }, onRefreshMailReplySources: refresh,
      onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    const refreshButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh fixed target and selected messages')!;
    expect(refreshButton.disabled).toBe(false);
    act(() => { refreshButton.click(); refreshButton.click(); });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0].slice(0, 3)).toEqual(['mail-job', 'proposal-1', 1]);
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
      state, proposal, dispatchRecords: [], busy: false, mailReplyContextCount: 1,
      mailReplySourcesStatus: { status: 'refresh_required' }, onRefreshMailReplySources: refresh,
      onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh fixed target and selected messages')!.click());
    act(() => root.render(React.createElement(ReviewSheet, {
      state, proposal: null, dispatchRecords: [], onClose: vi.fn(), onEdit: vi.fn(), onApprove: vi.fn(), onExecute: vi.fn(), onDismiss: vi.fn(),
    })));
    const item = { selectionId: 'opaque-target', isReplyTarget: true, subject: 'Original subject', representation: 'plain' as const, completeness: 'complete_text' as const, bytes: 100, omissionReasons: [] };
    await act(async () => { resolveRefresh({ status: 'current', jobId: 'mail-job', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), sources: [item] }); await Promise.resolve(); });
    expect(host.textContent).not.toContain('Fixed reply target · Original subject');
  });
});
