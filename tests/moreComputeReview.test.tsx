/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantBatchMoreComputePlan } from '../src/core';
import type { AssistantBatchJobDTO } from '../src/services/openRouterBatchJobs';
import { AssistantBatchJobCard } from '../src/ui/AssistantBatchJobCard';
import { MoreComputeReview, type MoreComputeReviewActions } from '../src/ui/MoreComputeReview';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement(tag, props, children);
  return { Modal: ({ visible, children }: { visible: boolean; children?: React.ReactNode }) => visible ? ReactModule.createElement('div', { role: 'dialog' }, children) : null, ScrollView: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement('div', { ...props, 'data-scrollview': 'true' }, children), Text: view('span'), View: view('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', input: '#111' }, s: { sectionTitle: {} } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const job = (overrides: Partial<AssistantBatchJobDTO> = {}): AssistantBatchJobDTO => ({
  id: 'parent-job', kind: 'note_assistance', status: 'result_not_retained', canCheck: false,
  createdAt: '2026-10-14T01:00:00.000Z', updatedAt: '2026-10-14T01:00:00.000Z',
  noteId: 'note-1', noteRevision: 2, model: 'openai/gpt-6-luna:batch', effort: 'medium',
  requestBytes: 120, omittedSourceCount: 0, unknownCharge: true, costStatus: 'unavailable', billingScope: 'openrouter_reported',
  canRecoverMoreCompute: true, moreComputeEfforts: ['high', 'max'], ...overrides,
});

const plan = (overrides: Partial<AssistantBatchMoreComputePlan> = {}): AssistantBatchMoreComputePlan => ({
  planId: 'plan-exact-1', jobId: 'parent-job', kind: 'note_assistance', parentProfile: 2,
  priorEffort: 'medium', requestedEffort: 'high', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  priorAccounting: { costStatus: 'reported', providerReportedCostUsd: 0.0123, byok: true, promptTokens: 200, completionTokens: 40, totalTokens: 240, unknownCharge: false },
  warning: 'Submitting creates a new paid Batch request. The incomplete response is not reused, and higher effort does not guarantee a complete result.',
  preview: { userText: 'Please explain the saved note.', sourceLabels: [{ id: 'private-source-1', label: 'Project note', text: 'Full selected source body.' }], omittedSourceCount: 0, capturedAt: '2026-10-13T12:00:00Z', captureTimeZone: 'Asia/Singapore', asOf: '2026-10-13T12:00:00Z' },
  ...overrides,
});

const render = (actions: MoreComputeReviewActions, selectedJob = job()) => act(() => root.render(React.createElement(MoreComputeReview, { job: selectedJob, ...actions })));

describe('mounted More Compute review', () => {
  it('reviews structured request context without a key and submits only the exact reviewed plan after readiness', async () => {
    const prepared = plan();
    const onPrepare = vi.fn(async () => prepared);
    const onSubmit = vi.fn(async () => ({ id: 'child-job', status: 'queued' }));
    const onCancel = vi.fn();
    const onSubmitted = vi.fn();
    const actions: MoreComputeReviewActions = { ownerKey: 'note-owner', blocked: false, submitReady: false, onPrepare, onSubmit, onCancel, onSubmitted };
    render(actions);
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toContain('Review higher High');
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toContain('Review higher Max');
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Review higher Medium');
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve(); });
    expect(onPrepare).toHaveBeenCalledWith('parent-job', 'high', 'note-owner', expect.any(Function));
    expect(host.textContent).toContain('Please explain the saved note.');
    expect(host.textContent).toContain('Full selected source body.');
    expect(host.textContent).toContain('Previously reported provider cost');
    expect(host.textContent).toContain('Submitting creates a new paid Batch request.');
    const submit = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Submit new paid request')!;
    expect(submit.disabled).toBe(true);
    render({ ...actions, submitReady: true });
    const enabledSubmit = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Submit new paid request')!;
    expect(enabledSubmit.disabled).toBe(false);
    await act(async () => { enabledSubmit.click(); enabledSubmit.click(); await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('plan-exact-1', 'parent-job', 'note-owner', expect.any(Function));
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('The new Batch request is saved in request history.');
  });

  it('shows the complete fixed-mail target disclosure and BYOK fee scope inside the scrollable review', async () => {
    const mailPlan = plan({
      kind: 'mail_reply',
      requestedEffort: 'max',
      preview: {
        userText: 'Draft a concise response.',
        sourceLabels: [{ id: 'target', label: 'Fixed target message', text: 'Target body text' }],
        omittedSourceCount: 1,
        mail: {
          messageId: 'message-1', mode: 'reply', subject: 'Question', to: ['person@example.com'], cc: [], brief: 'Answer kindly.',
          targetMessage: { text: 'Target body text', sender: 'sender@example.com', representation: 'plain_text', completeness: 'partial', omissionReasons: ['body_truncated'] },
          contextMessages: [{ text: 'Selected body', subject: 'Earlier', representation: 'converted_html', completeness: 'partial', omissionReasons: ['body_truncated'] }],
        },
      },
    });
    const actions: MoreComputeReviewActions = { ownerKey: 'mail-owner', blocked: false, submitReady: true, onPrepare: vi.fn(async () => mailPlan), onSubmit: vi.fn(), onCancel: vi.fn() };
    render(actions, job({ kind: 'mail_reply', effort: 'high', moreComputeEfforts: ['max'] }));
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('OpenRouter BYOK fee only; provider charges not included.');
    expect(dialog.textContent).toContain('Target body · plain text · partial');
    expect(dialog.textContent).toContain('Target omission · body truncated');
    expect(dialog.textContent).toContain('converted html · partial');
    expect(dialog.textContent).toContain('Omitted · body truncated');
    expect(dialog.textContent).toContain('1 source context item(s) were omitted from the request.');
    const scroll = dialog.querySelector('[data-scrollview="true"]')!;
    expect(scroll.textContent).toContain('Target body text');
    expect([...dialog.querySelectorAll('button')].map((button) => button.textContent)).toContain('Submit new paid request');
    expect([...dialog.querySelectorAll('button')].map((button) => button.textContent)).toContain('Cancel review');
  });

  it('cancels the exact late plan when owner changes during prepare and never opens the old review', async () => {
    let finish!: (value: AssistantBatchMoreComputePlan) => void;
    const onPrepare = vi.fn(() => new Promise<AssistantBatchMoreComputePlan>((resolve) => { finish = resolve; }));
    const onCancel = vi.fn();
    const actions: MoreComputeReviewActions = { ownerKey: 'old-owner', blocked: false, submitReady: false, onPrepare, onSubmit: vi.fn(), onCancel };
    render(actions);
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve(); });
    render({ ...actions, ownerKey: 'new-owner' });
    await act(async () => { finish(plan()); await Promise.resolve(); });
    expect(onCancel).toHaveBeenCalledWith('plan-exact-1', 'old-owner');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('cancels preparation locally and cancels the exact plan if it arrives afterward', async () => {
    let finish!: (value: AssistantBatchMoreComputePlan) => void;
    const onPrepare = vi.fn(() => new Promise<AssistantBatchMoreComputePlan>((resolve) => { finish = resolve; }));
    const onCancel = vi.fn();
    render({ ownerKey: 'owner', blocked: false, submitReady: false, onPrepare, onSubmit: vi.fn(), onCancel });
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve(); });
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Cancel preparation')!.click(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { finish(plan()); await Promise.resolve(); });
    expect(onCancel).toHaveBeenCalledWith('plan-exact-1', 'owner');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('clears a prepared review on a hard block and requires a new prepare after unblocking', async () => {
    const onCancel = vi.fn();
    const actions: MoreComputeReviewActions = { ownerKey: 'owner', blocked: false, submitReady: true, onPrepare: vi.fn(async () => plan()), onSubmit: vi.fn(), onCancel };
    const renderCard = (blocked: boolean) => act(() => root.render(React.createElement(AssistantBatchJobCard, { job: job(), blocked, moreCompute: actions })));
    renderCard(false);
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve(); });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    renderCard(true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(onCancel).toHaveBeenCalledWith('plan-exact-1', 'owner');
    renderCard(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not offer recovery on a job that lacks the controller eligibility flag', () => {
    render({ ownerKey: 'owner', blocked: false, submitReady: true, onPrepare: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn() }, job({ canRecoverMoreCompute: false }));
    expect(host.textContent).toBe('');
  });
});
