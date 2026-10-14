/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppController, MailReplySourceSnapshot, SelectedMailTextSnapshot } from '../src/core';
import type { AssistantBatchJobDTO } from '../src/services/openRouterBatchJobs';
import { MailReplyComposer } from '../src/ui/MailReplyComposer';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, style: _style, ...props }: Record<string, unknown> & { children?: React.ReactNode; style?: unknown }) => ReactModule.createElement(tag, props, children);
  return { KeyboardAvoidingView: view('div'), Modal: view('div'), Pressable: view('button'), ScrollView: view('div'), Text: view('span'), View: view('div'), Platform: { OS: 'web' } };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  const View = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children);
  return { SafeAreaView: View };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    Field: ({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) => ReactModule.createElement('label', null, label, ReactModule.createElement('input', { value, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value) })),
    IconButton: ({ label, onPress }: { label: string; onPress: () => void }) => ReactModule.createElement('button', { type: 'button', onClick: onPress }, label),
  };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00', bg: '#000' }, s: { sectionTitle: {}, label: {}, kicker: {}, h1Small: {}, disclaimer: {} } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const source: MailReplySourceSnapshot = {
  version: 1, accountId: 'account-1', accountEmail: 'me@example.com', identity: {} as MailReplySourceSnapshot['identity'],
  connectionGeneration: 1, localMessageId: 'message-a', providerMessageId: 'provider-a', idFormat: 'gmail',
  internetMessageId: '<message-a@example.com>', subject: 'Saved subject', replyMetadataComplete: true,
  observedAt: '2026-10-14T08:00:00.000Z', sourceDigest: 'a'.repeat(64),
};
const snapshot: SelectedMailTextSnapshot = {
  version: 1, messageId: 'message-a', accountId: 'account-1', identityKey: 'identity-1', identity: {} as SelectedMailTextSnapshot['identity'],
  connectionGeneration: 1, providerMessageId: 'provider-a', idFormat: 'gmail', sourceDigest: source.sourceDigest,
  checkedAt: '2026-10-14T08:00:00.000Z', text: 'Selected saved message text.', textDigest: 'b'.repeat(64), bytes: 28,
  extractionVersion: 'mail-text-v2', representation: 'plain', completeness: 'complete_text', omissionReasons: [],
};
const mailJob: AssistantBatchJobDTO = {
  id: 'mail-job', kind: 'mail_reply', status: 'queued', canCheck: true, mailMessageId: 'message-a',
  createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', model: 'openai/gpt-6-luna:batch', effort: 'low',
  unknownCharge: false, costStatus: 'waiting', billingScope: 'openrouter_reported',
};

function mockController(provider: 'openrouter' | 'azure'): AppController {
  const settings = { mode: 'provider' as const, llmProvider: provider, openAiEndpoint: 'https://example.test', openAiDeployment: 'test', timezone: 'UTC', maxContextTokens: 1000, maxRequestBytes: 10000, maxOutputTokens: 500, monthlyBudgetUsd: 20 };
  return {
    getSnapshot: () => ({ settings } as never),
    getMailReplySource: vi.fn(async () => ({ status: 'current', source, defaults: { reply: { to: ['person@example.com'], cc: [] }, reply_all: { to: ['person@example.com'], cc: [] } } })),
    getMailReplyText: vi.fn(async () => ({ status: 'current', snapshot })),
    generateMailReplyText: vi.fn(), submitMailReplyBatch: vi.fn(),
  } as unknown as AppController;
}

function render(controller: AppController, jobs: readonly AssistantBatchJobDTO[] = [mailJob], batchEnabled = false) {
  act(() => root.render(React.createElement(MailReplyComposer, {
    visible: true, messageId: 'message-a', controller, busy: false, notes: [], documents: [], batchJobs: jobs,
    batchEnabled, batchBlocked: false, ownerGeneration: 1, onClose: vi.fn(), onSave: vi.fn(async () => undefined),
    onSubmitBatch: vi.fn(async () => mailJob), onCheckBatch: vi.fn(async () => undefined),
    onReviewBatch: vi.fn(async () => undefined), onActivateBatch: vi.fn(async () => undefined),
    onCancelBatchReview: vi.fn(), onDeleteBatch: vi.fn(async () => undefined),
  })));
}

describe('MailReplyComposer Batch mode', () => {
  it('shows local mail history without a key and never falls through to Azure Generate', async () => {
    const controller = mockController('openrouter');
    render(controller, [mailJob], false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(host.textContent).toContain('OpenRouter Batch requests for this message');
    expect(host.textContent).toContain('Waiting for provider reply');
    expect(host.textContent).toContain('Save an OpenRouter API key in Settings');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Generate reply')).toBe(false);
    const submit = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Submit reply request')!;
    expect(submit.disabled).toBe(true);
  });

  it('keeps the Azure Generate action for Azure settings', async () => {
    render(mockController('azure'), [], false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Generate reply')).toBe(true);
    expect(host.textContent).not.toContain('OpenRouter Batch requests for this message');
  });
});
