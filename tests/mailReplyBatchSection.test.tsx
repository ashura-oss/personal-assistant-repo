/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailReplyBatchReviewPlan } from '../src/core';
import type { AssistantBatchJobDTO } from '../src/services/openRouterBatchJobs';
import { MailReplyBatchSection } from '../src/ui/MailReplyBatchSection';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement(tag, props, children);
  return { Text: view('span'), View: view('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00' }, s: { sectionTitle: {} } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const job = (id: string, mailMessageId: string, overrides: Partial<AssistantBatchJobDTO> = {}): AssistantBatchJobDTO => ({
  id, kind: 'mail_reply', status: 'queued', canCheck: true, mailMessageId,
  createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z',
  model: 'openai/gpt-6-luna:batch', effort: 'low', unknownCharge: false,
  costStatus: 'waiting', billingScope: 'openrouter_reported', ...overrides,
});
const plan: MailReplyBatchReviewPlan = {
  planId: 'plan-1', jobId: 'job-a', messageId: 'message-a', mode: 'reply', subject: 'Hello',
  to: ['person@example.com'], cc: [], text: 'A generated answer.', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};
const render = (props: Partial<React.ComponentProps<typeof MailReplyBatchSection>> = {}) => act(() => root.render(React.createElement(MailReplyBatchSection, {
  jobs: [job('job-a', 'message-a'), job('other-job', 'message-b')], messageId: 'message-a', ownerGeneration: 1,
  composerRevision: 1, blocked: false, busy: false, submitting: false, checkReady: true,
  onCheck: vi.fn(async () => undefined), onReview: vi.fn(async () => plan), onActivate: vi.fn(async () => undefined),
  onCancel: vi.fn(), onDelete: vi.fn(async () => undefined), ...props,
})));

describe('MailReplyBatchSection', () => {
  it('shows only the selected message jobs and binds explicit Check to that job id', async () => {
    const onCheck = vi.fn(async () => undefined);
    render({ onCheck });
    expect(host.textContent).not.toContain('other-job');
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Check for reply')!;
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(onCheck).toHaveBeenCalledExactlyOnceWith('job-a', { messageId: 'message-a', generation: 1 });
  });

  it('keeps a completed result read-only and passes the exact plan id to Create draft', async () => {
    const onReview = vi.fn(async () => plan);
    const onActivate = vi.fn(async (_planId: string, _jobId: string, _owner: { messageId: string; generation: number }, _isCurrent: () => boolean) => undefined);
    render({
      jobs: [job('job-a', 'message-a', { status: 'completed', canCheck: false, hasMailReplyResult: true, canReviewMailReply: true })],
      onReview, onActivate,
    });
    const review = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Review completed reply')!;
    await act(async () => { review.click(); await Promise.resolve(); });
    expect(host.textContent).toContain('A generated answer.');
    expect(host.textContent).toContain('person@example.com');
    expect(host.textContent).toContain('Creating a draft is separate from approving or sending it.');
    const create = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Create draft')!;
    await act(async () => { create.click(); await Promise.resolve(); });
    expect(onActivate).toHaveBeenCalledOnce();
    expect(onActivate.mock.calls[0].slice(0, 3)).toEqual(['plan-1', 'job-a', { messageId: 'message-a', generation: 1 }]);
    expect(onActivate.mock.calls[0][3]).toEqual(expect.any(Function));
  });

  it('requires a separate confirmation before content removal', async () => {
    const onDelete = vi.fn(async () => undefined);
    render({ onDelete });
    const remove = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Remove request content')!;
    act(() => remove.click());
    expect(onDelete).not.toHaveBeenCalled();
    const confirm = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Confirm removal')!;
    await act(async () => { confirm.click(); await Promise.resolve(); });
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('job-a', { messageId: 'message-a', generation: 1 });
  });

  it('cancels local review without implying that no Batch request was sent', async () => {
    const onCancel = vi.fn();
    render({
      jobs: [job('job-a', 'message-a', { status: 'completed', canCheck: false, hasMailReplyResult: true, canReviewMailReply: true })],
      onCancel,
    });
    const review = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Review completed reply')!;
    await act(async () => { review.click(); await Promise.resolve(); });
    const cancel = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Cancel review')!;
    act(() => cancel.click());
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('plan-1', { messageId: 'message-a', generation: 1 });
    expect(host.textContent).toContain('Review cancelled.');
    expect(host.textContent).not.toContain('No request was sent.');
  });
});
