/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRecord } from '../src/dispatch';
import type { Account } from '../src/core';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { ConnectionsSection } from '../src/ui/ConnectionsSection';
import { DispatchHistory } from '../src/ui/DispatchHistory';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, style: _style, onPress, accessibilityRole, accessibilityLabel, accessibilityState, ...props }: Record<string, unknown> & { children?: React.ReactNode; onPress?: () => void }) => ReactModule.createElement(tag, { ...props, ...(onPress ? { onClick: onPress } : {}), ...(accessibilityRole ? { role: accessibilityRole } : {}), ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}) }, children);
  return { Pressable: element('button'), Text: element('span'), View: element('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    Field: ({ label, value, onChangeText, multiline }: { label: string; value: string; onChangeText: (value: string) => void; multiline?: boolean }) => ReactModule.createElement('label', null, label, ReactModule.createElement(multiline ? 'textarea' : 'input', { value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChangeText(event.target.value) })),
  };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', border: '#333', red: '#f00' }, s: new Proxy({}, { get: () => ({}) }) }));

const accountId = '11111111-1111-4111-8111-111111111111';
const noteId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';

function snapshot() {
  const state = createInitialWorkspaceState(() => '33333333-3333-4333-8333-333333333333');
  const account: Account = {
    id: accountId, provider: 'google', displayName: 'Sample Owner', email: 'owner@example.test', connected: true,
    authStatus: 'connected', tokenRef: 'private-account-token-reference', capabilities: ['mail.read'],
    lastSyncedAt: '2026-10-14T08:00:00.000Z', syncStatus: 'partial',
  };
  state.accounts.push(account);
  state.syncStates[accountId] = {
    accountId, status: 'partial',
    mailHead: { status: 'partial', lastPageCheckedAt: '2026-10-14T08:00:00.000Z' },
    mailBackfill: {
      status: 'partial', coverage: { from: '2026-09-01T00:00:00.000Z', through: '2026-10-01T00:00:00.000Z' },
      coverageNeededThrough: '2026-10-02T00:00:00.000Z', activeWindow: { from: '2026-09-01T00:00:00.000Z', through: '2026-10-01T00:00:00.000Z', pageSize: 25, queryFingerprint: 'private-query-fingerprint', cursor: 'private-cursor' },
      lastCompletedAt: '2026-10-14T08:00:00.000Z', olderHistoryNotCheckedBefore: '2026-09-01T00:00:00.000Z',
    },
    messagesCursor: 'private-account-cursor', messagesPartial: true, calendarsPartial: false,
    eventCursors: { 'private-calendar': 'private-event-cursor' }, eventsCompletedAt: {},
  };
  const record: DispatchRecord = {
    version: 1, id: 'dispatch-history-id', proposalId: 'proposal-id', approvedRevision: 4, sourceRevision: 3,
    payloadDigest: 'a'.repeat(64), sourceActionKey: 'private-source-action-key', duplicateKey: 'private-duplicate-key',
    sourceProvenance: {
      version: 1, assistContractVersion: 'assist-v1', analysisFingerprint: 'b'.repeat(64), noteId, noteRevision: 3,
      capturedAt: '2026-10-14T07:00:00.000Z', captureTimeZone: 'Asia/Singapore', intent: 'assist', sources: [], policySources: [], settingsFingerprint: 'c'.repeat(64),
    },
    operation: 'send', accountId, account: { provider: 'google', identity: { providerNamespace: 'google', clientId: 'public-client-id', subject: 'provider-subject' }, displayName: 'Sample Owner', email: 'owner@example.test' },
    mailReplyBatchBinding: { jobId: 'private-batch-id', provenanceCanonical: 'private-batch-binding', activationOperation: 'send' },
    providerIdempotencyKey: 'private-provider-key',
    title: 'Send approved follow-up', body: 'The approved message body.',
    payload: { kind: 'email', email: { to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Approved subject', text: 'Frozen approved message body', attachments: [] } },
    dispatchStartedAt: '2026-10-14T08:05:00.000Z', outcome: 'unknown', reconciliations: [],
  };
  state.dispatchRecords.push(record);
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 1, revision: 7 });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('safe DTO display leaves', () => {
  it('renders a real account and mail sync DTO without private cursor or credential references', () => {
    const dto = snapshot();
    const connect = vi.fn(async () => undefined);
    act(() => root.render(<ConnectionsSection
      accounts={dto.state.accounts} syncStates={dto.state.syncStates} busy={false} demoMode={false} isWeb={false}
      getProviderSetup={() => ({ clientId: 'public-client-id', nativeRedirectUri: 'still://oauth/callback', webRedirectUri: '', scopes: ['mail.read'] })}
      onConnect={connect} onDisconnect={async () => undefined} onSync={async () => undefined}
      onRefreshMail={() => undefined} onContinueMail={() => undefined}
    />));

    expect(dto.state.accounts[0]).not.toHaveProperty('tokenRef');
    expect(host.textContent).toContain('owner@example.test');
    expect(host.textContent).toContain('Recent page checked');
    expect(host.textContent).toContain('Mail checked from');
    expect(host.textContent).toContain('Continue mail scan');
    expect(host.textContent).not.toContain('private-account-cursor');
    expect(host.textContent).not.toContain('private-query-fingerprint');
    expect(host.textContent).not.toContain('private-account-token-reference');
  });

  it('renders a frozen approved payload and unknown outcome, then sends only explicit reconciliation input', async () => {
    const dto = snapshot();
    const record = dto.state.dispatchRecords[0]!;
    const onReconcile = vi.fn(async (_recordId: string, _input: { disposition: string; note: string; remoteId?: string }) => true);
    act(() => root.render(<DispatchHistory records={dto.state.dispatchRecords} onReconcile={onReconcile} />));

    expect(Object.isFrozen(record)).toBe(true);
    expect(record).not.toHaveProperty('sourceActionKey');
    expect(record).not.toHaveProperty('duplicateKey');
    expect(record).not.toHaveProperty('providerIdempotencyKey');
    expect(record).not.toHaveProperty('mailReplyBatchBinding');
    expect(host.textContent).toContain('Outcome unknown');
    expect(host.textContent).toContain('Approved subject');
    expect(host.textContent).toContain('Frozen approved message body');
    expect(host.textContent).not.toContain('private-batch-binding');

    const confirmed = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Confirmed in provider')!;
    const noteField = host.querySelector('textarea')!;
    const referenceField = [...host.querySelectorAll('input')].find((input) => input.getAttribute('value') === '')!;
    act(() => confirmed.click());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(noteField, 'Provider record checked');
      noteField.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(referenceField, 'provider-ref-7');
      referenceField.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save check result')!.click();
      await Promise.resolve();
    });
    expect(onReconcile).toHaveBeenCalledWith('dispatch-history-id', { disposition: 'confirmed_present', note: 'Provider record checked', remoteId: 'provider-ref-7' });
  });
});
