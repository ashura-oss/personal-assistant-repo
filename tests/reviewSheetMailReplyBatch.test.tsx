/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal, MailReplyProvenance } from '../src/core';
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
    operation: 'draft', to: ['person@example.com'], cc: ['copy@example.com'], bcc: [], subject: 'Reply subject',
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
});
