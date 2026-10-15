/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeriodSummaryApplicationPlan, PeriodSummaryApplicationPreview, PeriodSummaryApplicationReceipt } from '../src/core';
import type { AssistantBatchJobDTO } from '../src/services/openRouterBatchJobs';
import { PeriodSummaryWorkflow, type PeriodSummaryWorkflowActions } from '../src/ui/PeriodSummaryWorkflow';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    ReactModule.createElement(tag, props, children);
  return {
    Text: view('span'), View: view('div'), ScrollView: view('div'),
    Modal: ({ visible, onRequestClose, children }: { visible: boolean; onRequestClose: () => void; children?: React.ReactNode }) => visible
      ? ReactModule.createElement('section', { 'data-testid': 'modal' },
        ReactModule.createElement('button', { type: 'button', 'aria-label': 'native-close', onClick: onRequestClose }, 'Native close'), children)
      : null,
  };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
    ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9' }, s: { sectionTitle: {} } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const job = { id: 'bdb51402-7b76-47a6-9a1a-24e022d36bb0', kind: 'period_summary', status: 'completed', canCheck: false,
  createdAt: '2026-10-14T12:00:00.000Z', updatedAt: '2026-10-14T12:00:00.000Z', model: 'openai/gpt-6-luna:batch', effort: 'low',
  unknownCharge: false, costStatus: 'reported', billingScope: 'openrouter_reported', periodSummary: { period: 'daily', timeZone: 'UTC',
    localInterval: { start: '2026-10-13', end: '2026-10-14' } } } as AssistantBatchJobDTO;
const plan: PeriodSummaryApplicationPlan = Object.freeze({ planId: 'e8a3f7c7-8ced-4433-978f-3972eac68310', jobId: job.id,
  kind: 'period_summary_application', period: 'daily', timeZone: 'UTC', interval: { start: '2026-10-13', end: '2026-10-14' },
  preparedAt: '2026-10-14T02:00:00.000Z', destinationPath: 'memory/summaries/daily/2026-10-13.md', destinationExists: false,
  expiresAt: new Date(Date.now() + 60_000).toISOString() });
const preview: PeriodSummaryApplicationPreview = Object.freeze({ planId: plan.planId, jobId: job.id, period: 'daily', timeZone: 'UTC',
  interval: plan.interval, preparedAt: plan.preparedAt, markdown: '# Reviewed exact text', sourceReferences: ['note · 2026-10-13'] });
const receipt: PeriodSummaryApplicationReceipt = Object.freeze({ kind: 'applied', jobId: job.id, path: plan.destinationPath,
  documentRevision: 1, appliedAt: '2026-10-14T02:05:00.000Z' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function actions(overrides: Partial<PeriodSummaryWorkflowActions> = {}): PeriodSummaryWorkflowActions {
  return { ownerKey: `workspace:epoch:${job.id}`, blocked: false, onPrepare: async () => { throw new Error('unused'); },
    onSubmit: async () => ({ jobStatus: 'queued' }), onCancel: vi.fn(), onRead: async () => undefined,
    onPrepareApplication: async () => plan, onCancelApplication: vi.fn(), onApplyApplication: async () => receipt,
    onReadApplicationPreview: async () => preview, ...overrides };
}

describe('period summary application review UI', () => {
  it('keeps native close from cancelling an in-flight apply and shows the receipt after acknowledgement', async () => {
    const applying = deferred<PeriodSummaryApplicationReceipt>();
    const workflow = actions({ onApplyApplication: vi.fn(() => applying.promise) });
    await act(async () => { root.render(React.createElement(PeriodSummaryWorkflow, { job, actions: workflow })); });
    await act(async () => { host.querySelectorAll('button')[1]!.click(); await Promise.resolve(); });
    expect(host.textContent).toContain('# Reviewed exact text');
    expect(host.textContent).toContain('Review summary save');
    const applyButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save this summary')!;
    act(() => { applyButton.click(); });
    const closeButton = host.querySelector<HTMLButtonElement>('button[aria-label="native-close"]')!;
    act(() => { closeButton.click(); });
    expect(workflow.onCancelApplication).not.toHaveBeenCalled();
    expect(host.textContent).toContain('# Reviewed exact text');
    await act(async () => { applying.resolve(receipt); await applying.promise; });
    expect(host.textContent).toContain(`Summary saved to ${receipt.path} at document revision 1.`);
  });

  it('invalidates a deferred prepare on unmount and cancels its late one-use plan', async () => {
    const prepared = deferred<PeriodSummaryApplicationPlan | PeriodSummaryApplicationReceipt>();
    const onCancelApplication = vi.fn();
    const workflow = actions({ onPrepareApplication: vi.fn(() => prepared.promise), onCancelApplication });
    await act(async () => { root.render(React.createElement(PeriodSummaryWorkflow, { job, actions: workflow })); });
    act(() => { host.querySelectorAll('button')[1]!.click(); });
    expect(workflow.onPrepareApplication).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    await act(async () => { prepared.resolve(plan); await prepared.promise; await Promise.resolve(); });
    expect(onCancelApplication).toHaveBeenCalledWith(plan.planId);
    expect(host.textContent).toBe('');
  });
});
