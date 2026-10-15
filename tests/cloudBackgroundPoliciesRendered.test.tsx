/** @vitest-environment jsdom */
import React, { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { BackgroundPolicyReceipt } from '../src/cloud/backgroundContracts';
import { CloudBackgroundPolicies } from '../src/web/CloudBackgroundPolicies';
import { CloudBackgroundPolicyCoordinator, type CloudBackgroundPolicyPort } from '../src/web/cloudBackgroundPolicyCoordinator';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, onPress, accessibilityRole: _role, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    ReactModule.createElement(tag, { ...props, ...(onPress ? { onClick: onPress } : {}) }, children);
  return { Text: element('span'), View: element('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
    Field: ({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) => ReactModule.createElement('label', null, label,
      ReactModule.createElement('input', { value, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value) })),
  };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00' }, s: new Proxy({}, { get: () => ({}) }) }));

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const accountId = 'ab31b707-9582-41bb-8cbb-a4a1c26df667';
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('background account sync settings UI', () => {
  it('requires explicit account selection and enable consent, then shows the exact saved result', async () => {
    const snapshot = { workspaceId, privacyEpoch: 3, revision: 1, state: { accounts: [{ id: accountId, provider: 'google', displayName: 'Work', email: 'work@example.com',
      connected: true, authStatus: 'connected', connectionGeneration: 7, capabilities: ['mail.read'] }] } } as unknown as WorkspaceSnapshotDTO;
    let savedPolicyId: string | undefined;
    const requestPromise = (request: { commandId: string; policyId: string; expectedPolicyRevision: number; enabled: boolean }) => {
      savedPolicyId = request.policyId;
      return Promise.resolve<BackgroundPolicyReceipt>({ schemaVersion: 1, commandId: request.commandId, operation: 'save', policyId: request.policyId,
        policyRevision: request.expectedPolicyRevision + 1, status: request.enabled ? 'enabled' : 'paused', effectiveFrom: 99 });
    };
    const port: CloudBackgroundPolicyPort = { readSnapshot: () => snapshot, readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
      list: vi.fn(async () => savedPolicyId ? [{ schemaVersion: 1 as const, policyId: savedPolicyId, revision: 1, status: 'enabled' as const, enabled: true,
        specification: { kind: 'account_sync' as const, accounts: [{ accountId, expectedConnectionGeneration: 7 }], resources: ['mail' as const], intervalMinutes: 5 },
        accounts: [{ accountId, provider: 'google' as const, label: 'Work', connectionGeneration: 7, connected: true }], effectiveFrom: 99, updatedAt: 100 }] : []),
      save: vi.fn(requestPromise), pause: vi.fn(async () => { throw new Error('unexpected pause'); }),
      revoke: vi.fn(async () => { throw new Error('unexpected revoke'); }), inspect: vi.fn(async () => undefined) };
    const coordinator = new CloudBackgroundPolicyCoordinator(port);
    function Panel() {
      const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
      return <CloudBackgroundPolicies coordinator={coordinator} state={state} accounts={snapshot.state.accounts as never} busy={false} blocked={false} />;
    }
    await act(async () => root.render(<Panel />));
    expect(host.textContent).toContain('Choose accounts, resources, and cadence');
    expect(port.save).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLButtonElement>('button')?.click(); });
    const selectAccount = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Select Work'));
    expect(selectAccount).toBeDefined();
    await act(async () => { selectAccount?.click(); });
    const enable = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save and enable policy');
    expect(enable?.disabled).toBe(false);
    await act(async () => { enable?.click(); });
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ commandId: expect.any(String), expectedPrivacyEpoch: 3,
      expectedPolicyRevision: 0, enabled: true, specification: { kind: 'account_sync', accounts: [{ accountId, expectedConnectionGeneration: 7 }], resources: ['mail'], intervalMinutes: 5 } }));
    expect(host.textContent).toContain('Policy enabled.');
    expect(coordinator.getSnapshot().heldCommand).toBeUndefined();
    const reload = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load saved policies');
    await act(async () => { reload?.click(); });
    expect(host.textContent).toContain('Account sync · enabled');
    expect(host.textContent).toContain('Work · connected');
    expect(host.textContent).toContain('Review / edit Work');
    expect(host.textContent).not.toContain(savedPolicyId!);
    expect(host.textContent).not.toContain('revision');
    expect(host.textContent).not.toContain('generation');
  });

  it('uses a neutral account label when saved labels and current accounts are unavailable', async () => {
    const snapshot = { workspaceId, privacyEpoch: 3, revision: 1, state: { accounts: [] } } as unknown as WorkspaceSnapshotDTO;
    const savedId = '398fbff1-829f-4e4d-87ec-c41be72886a2';
    const port: CloudBackgroundPolicyPort = { readSnapshot: () => snapshot, readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
      list: vi.fn(async () => [{ schemaVersion: 1 as const, policyId: savedId, revision: 1, status: 'paused' as const, enabled: false,
        specification: { kind: 'account_sync' as const, accounts: [{ accountId, expectedConnectionGeneration: 7 }], resources: ['mail' as const], intervalMinutes: 5 },
        accounts: [{ accountId, provider: 'google' as const, label: '', connectionGeneration: 7, connected: false }], effectiveFrom: 99, updatedAt: 100 }]),
      save: vi.fn(async () => { throw new Error('unexpected save'); }), pause: vi.fn(async () => { throw new Error('unexpected pause'); }),
      revoke: vi.fn(async () => { throw new Error('unexpected revoke'); }), inspect: vi.fn(async () => undefined) };
    const coordinator = new CloudBackgroundPolicyCoordinator(port);
    function Panel() {
      const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
      return <CloudBackgroundPolicies coordinator={coordinator} state={state} accounts={[]} busy={false} blocked={false} />;
    }
    await act(async () => root.render(<Panel />));
    const load = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load saved policies');
    await act(async () => { load?.click(); });
    expect(host.textContent).toContain('Connected account · disconnected');
    expect(host.textContent).toContain('Review / edit Connected account');
    expect(host.textContent).not.toContain(accountId);
    expect(host.textContent).not.toContain(savedId);
  });

});
