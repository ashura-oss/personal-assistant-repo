/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceErasePlan, WorkspaceEraseReceipt, WorkspaceEraseStatus } from '../src/cloud/workspaceEraseContracts';
import { WorkspaceErasePanel, type WorkspaceEraseActions } from '../src/web/WorkspaceErasePanel';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    ReactModule.createElement(tag, props, children);
  return { Text: view('span'), View: view('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
    ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', red: '#f66' } }));

const commandId = 'e53e7c18-4128-4e80-a55e-331db010a447';
const plan = (status: 'prepared' | 'confirmed' = 'prepared', revision = 12): WorkspaceErasePlan => ({ schemaVersion: 1,
  commandId, status, expectedRevision: revision, expectedPrivacyEpoch: 4, expiresAt: '2026-10-15T12:00:00.000Z',
  counts: { notes: 2, documents: 1, accounts: 1, proposals: 3, audioUploads: 4, backgroundPolicies: 1 } });
const pendingReceipt: WorkspaceEraseReceipt = { schemaVersion: 1, commandId, status: 'cleanup_pending', erasedPrivacyEpoch: 4,
  currentPrivacyEpoch: 5, createdAt: '2026-10-15T11:00:00.000Z' };
const complete: WorkspaceEraseStatus = { schemaVersion: 1, status: 'complete', receipt: { ...pendingReceipt, status: 'complete' } };
const prepared: WorkspaceEraseStatus = { schemaVersion: 1, status: 'prepared', plan: plan() };
const confirmed: WorkspaceEraseStatus = { schemaVersion: 1, status: 'confirmed', plan: plan('confirmed') };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
const actionSet = (overrides: Partial<WorkspaceEraseActions> = {}): WorkspaceEraseActions => ({
  refresh: vi.fn(async () => undefined), prepare: vi.fn(async () => plan()), confirm: vi.fn(async () => plan('confirmed')),
  execute: vi.fn(async () => pendingReceipt), cancel: vi.fn(async () => undefined), retryReview: vi.fn(async () => plan()),
  retryCleanup: vi.fn(async () => pendingReceipt), ...overrides,
});
const render = (status: WorkspaceEraseStatus | undefined, actions: WorkspaceEraseActions, ownerKey = 'workspace-a:4') =>
  act(() => root.render(<WorkspaceErasePanel status={status} busy={false} actions={actions} ownerKey={ownerKey} />));

describe('workspace erasure browser recovery', () => {
  it('requires a second final review and sends the owner through fresh login before receipt discovery', async () => {
    const actions = actionSet();
    render(prepared, actions);
    expect(host.textContent).toContain('2 notes');
    await act(async () => { button('Confirm erasure').click(); await Promise.resolve(); });
    render(confirmed, actions);
    act(() => { button('Review final erasure confirmation').click(); });
    expect(host.textContent).toContain('Erase workspace now');
    await act(async () => { button('Erase workspace now').click(); await Promise.resolve(); });
    expect(actions.execute).toHaveBeenCalledTimes(1);

    render(complete, actionSet());
    expect(host.textContent).toContain('Workspace erasure is complete');
    expect(host.textContent).toContain('Your owner login remains available');
  });

  it('resets final confirmation when the reviewed plan changes', () => {
    const actions = actionSet();
    render(confirmed, actions);
    act(() => { button('Review final erasure confirmation').click(); });
    render({ ...confirmed, plan: plan('confirmed', 13) }, actions);
    expect([...host.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Erase workspace now')).toBe(false);
    expect(host.textContent).toContain('Review final erasure confirmation');
  });

  it('does not retry execution after a lost acknowledgement and requires fresh login to discover outcome', async () => {
    const execute = vi.fn(async () => { throw new TypeError('network disconnected'); });
    const actions = actionSet({ execute });
    render(confirmed, actions);
    act(() => { button('Review final erasure confirmation').click(); });
    await act(async () => { button('Erase workspace now').click(); await Promise.resolve(); });
    expect(execute).toHaveBeenCalledTimes(1);

    render({ schemaVersion: 1, status: 'cleanup_pending', receipt: pendingReceipt }, actions);
    expect(host.textContent).toContain('active workspace has been cleared');
    expect([...host.querySelectorAll('button')].some((candidate) => candidate.textContent?.includes('Erase workspace now'))).toBe(false);
  });

  it('does not send a stale execute completion or logout callback into a replacement owner', async () => {
    let rejectExecute!: (cause: Error) => void;
    const execute = vi.fn(() => new Promise<WorkspaceEraseReceipt>((_resolve, reject) => { rejectExecute = reject; }));
    const actions = actionSet({ execute });
    let resolveReplacementPrepare!: (value: WorkspaceErasePlan) => void;
    const replacementActions = actionSet({ prepare: vi.fn(() => new Promise<WorkspaceErasePlan>((resolve) => { resolveReplacementPrepare = resolve; })) });
    render(confirmed, actions, 'workspace-a:4');
    act(() => { button('Review final erasure confirmation').click(); });
    await act(async () => { button('Erase workspace now').click(); await Promise.resolve(); });
    render({ schemaVersion: 1, status: 'none' }, replacementActions, 'workspace-b:1');
    expect(button('Review erasure').disabled).toBe(false);
    await act(async () => { button('Review erasure').click(); await Promise.resolve(); });
    expect(button('Pausing and reviewing…').disabled).toBe(true);
    await act(async () => { rejectExecute(new TypeError('late network failure')); await Promise.resolve(); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Erase this workspace');
    expect(host.textContent).not.toContain('late network failure');
    expect(button('Pausing and reviewing…').disabled).toBe(true);
    await act(async () => { resolveReplacementPrepare(plan()); await Promise.resolve(); });
    expect(button('Review erasure').disabled).toBe(false);
  });
});
