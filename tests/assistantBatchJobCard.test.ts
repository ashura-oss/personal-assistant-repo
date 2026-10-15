/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantBatchJobDTO } from '../src/services/openRouterBatchJobs';
import { AssistantBatchJobCard } from '../src/ui/AssistantBatchJobCard';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    ReactModule.createElement(tag, props, children);
  return { Text: view('span'), View: view('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
      ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
  };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9' }, s: { sectionTitle: {} } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const queuedJob = (overrides: Partial<AssistantBatchJobDTO> = {}): AssistantBatchJobDTO => ({
  id: 'local-job-id', kind: 'note_assistance', status: 'queued', canCheck: true,
  createdAt: '2026-10-13T12:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z',
  noteId: 'note-1', noteRevision: 2, model: 'openai/gpt-6-luna:batch', effort: 'low',
  requestBytes: 123, omittedSourceCount: 0, unknownCharge: false, costStatus: 'waiting', billingScope: 'openrouter_reported',
  ...overrides,
});

describe('AssistantBatchJobCard action ownership', () => {
  it('uses workspace-owned storage copy for server-backed batch results and keeps native copy by default', () => {
    const completed = queuedJob({ status: 'completed', canCheck: false });
    act(() => root.render(React.createElement(AssistantBatchJobCard, { job: completed })));
    expect(host.textContent).toContain('The validated reply was saved on this device.');
    act(() => root.render(React.createElement(AssistantBatchJobCard, { job: completed, storageLocation: 'server' })));
    expect(host.textContent).toContain('The validated reply was saved in this workspace.');
    expect(host.textContent).not.toContain('saved on this device');

    act(() => root.render(React.createElement(AssistantBatchJobCard, { job: queuedJob({ kind: 'mail_reply', status: 'completed', canCheck: false, hasMailReplyResult: true }), storageLocation: 'server' })));
    expect(host.textContent).toContain('A completed reply is saved in this workspace.');
    act(() => root.render(React.createElement(AssistantBatchJobCard, { job: queuedJob({ status: 'result_not_retained', canCheck: false }), storageLocation: 'server' })));
    expect(host.textContent).toContain('The reply did not fit in saved workspace data.');
  });

  it('shows terminal cutoff and no-higher-effort copy without offering another paid action', () => {
    act(() => root.render(React.createElement(AssistantBatchJobCard, { job: queuedJob({
      status: 'result_truncated', canCheck: false, effort: 'max', canRecoverMoreCompute: false, moreComputeEfforts: [],
    }) })));
    expect(host.textContent).toContain('Provider response was cut off; no output applied');
    expect(host.textContent).toContain('No higher supported reasoning setting is available');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Review higher'))).toBe(false);
  });

  it('does not describe an active higher-effort child as unavailable', () => {
    act(() => root.render(React.createElement(AssistantBatchJobCard, { job: queuedJob({
      status: 'result_truncated', canCheck: false, effort: 'low', canRecoverMoreCompute: false,
      moreComputeEfforts: ['medium'], pendingRecoveryChildId: 'child-job',
    }) })));
    expect(host.textContent).toContain('A higher-reasoning request is already saved. Check its status in Batch history.');
    expect(host.textContent).not.toContain('No higher supported reasoning setting is available');
  });

  it('allows explicit cleanup while a status check is still pending', async () => {
    let resolveCheck!: () => void;
    const check = new Promise<void>((resolve) => { resolveCheck = resolve; });
    const onCheck = vi.fn(() => check);
    const onRetryCleanup = vi.fn(async () => undefined);
    const render = (job: AssistantBatchJobDTO) => act(() => root.render(React.createElement(AssistantBatchJobCard, {
      job, onCheck, onRetryCleanup,
    })));

    render(queuedJob());
    const checkButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check for reply')!;
    act(() => { checkButton.click(); });
    expect(onCheck).toHaveBeenCalledTimes(1);

    render(queuedJob({ status: 'cleanup_pending', canCheck: false }));
    const cleanupButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Finish local cleanup')!;
    expect(cleanupButton.disabled).toBe(false);
    await act(async () => { cleanupButton.click(); await Promise.resolve(); });
    expect(onRetryCleanup).toHaveBeenCalledTimes(1);
    expect(onRetryCleanup).toHaveBeenCalledWith('local-job-id');

    await act(async () => { resolveCheck(); await check; });
  });
});
