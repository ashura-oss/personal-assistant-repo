import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { BackgroundPolicyDisplay, BackgroundPolicyReceipt, SaveBackgroundPolicyEnvelope } from '../src/cloud/backgroundContracts';
import { CloudBackgroundPolicyCoordinator, type CloudBackgroundPolicyPort } from '../src/web/cloudBackgroundPolicyCoordinator';
import { WorkspaceCommandUnknownError } from '../src/web/workspaceClient';

const accountId = 'ab31b707-9582-41bb-8cbb-a4a1c26df667';
const policyId = '290db061-0372-4c77-89a6-af6d40ef3f02';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function snapshot(privacyEpoch = 3): WorkspaceSnapshotDTO {
  return { workspaceId: uuid(90), privacyEpoch, revision: 1, state: { accounts: [{ id: accountId, provider: 'google', displayName: 'Work', email: 'work@example.com',
    connected: true, authStatus: 'connected', connectionGeneration: 7, capabilities: ['mail.read'] }] } } as unknown as WorkspaceSnapshotDTO;
}

function display(id = policyId, revision = 1, status: BackgroundPolicyDisplay['status'] = 'paused'): BackgroundPolicyDisplay {
  return { schemaVersion: 1, policyId: id, revision, status, enabled: status === 'enabled',
    specification: { kind: 'account_sync', accounts: [{ accountId, expectedConnectionGeneration: 7 }], resources: ['mail'], intervalMinutes: 5 },
    accounts: [{ accountId, provider: 'google', label: 'Work', connectionGeneration: 7, connected: true }], effectiveFrom: 1, updatedAt: 2 };
}

function receipt(input: { commandId: string; operation: 'save' | 'pause' | 'revoke'; policyId: string; policyRevision: number; status: 'enabled' | 'paused' | 'revoked' }): BackgroundPolicyReceipt {
  return { schemaVersion: 1, ...input, effectiveFrom: 10 };
}

function setup(overrides: Partial<CloudBackgroundPolicyPort> = {}) {
  let current = snapshot();
  const port: CloudBackgroundPolicyPort = {
    readSnapshot: () => current,
    readOperation: () => ({ busy: false, pending: false, refreshRequired: false }),
    list: vi.fn(async () => []),
    save: vi.fn(async (request) => receipt({ commandId: request.commandId, operation: 'save', policyId: request.policyId,
      policyRevision: request.expectedPolicyRevision + 1, status: request.enabled ? 'enabled' : 'paused' })),
    pause: vi.fn(async (request) => receipt({ commandId: request.commandId, operation: 'pause', policyId: request.policyId,
      policyRevision: request.expectedPolicyRevision + 1, status: 'paused' })),
    revoke: vi.fn(async (request) => receipt({ commandId: request.commandId, operation: 'revoke', policyId: request.policyId,
      policyRevision: request.expectedPolicyRevision + 1, status: 'revoked' })),
    inspect: vi.fn(async () => undefined),
    ...overrides,
  };
  return { port, coordinator: new CloudBackgroundPolicyCoordinator(port), replaceSnapshot: (next: WorkspaceSnapshotDTO) => { current = next; } };
}

describe('cloud background policy coordinator', () => {
  it('holds an uncertain exact save and leaves a missing receipt inspect-only', async () => {
    const { coordinator, port } = setup({ save: vi.fn(async () => { throw new WorkspaceCommandUnknownError(uuid(1), 'network'); }) });
    coordinator.startNewDraft();
    coordinator.toggleAccount(accountId);
    await coordinator.saveDraft(true);
    const held = coordinator.getSnapshot().heldCommand;
    expect(held).toMatchObject({ operation: 'save', expectedPolicyRevision: 0, expectedStatus: 'enabled' });
    expect(held?.canonicalRequest).toContain(held?.commandId);
    await coordinator.inspectHeldCommand();
    expect(coordinator.getSnapshot().heldCommand?.commandId).toBe(held?.commandId);
    expect(port.save).toHaveBeenCalledTimes(1);
    expect(port.inspect).toHaveBeenCalledWith(held?.commandId, 3);
  });

  it('accepts only an exact receipt and does not replay after settlement', async () => {
    const { coordinator, port } = setup();
    coordinator.startNewDraft();
    coordinator.toggleAccount(accountId);
    await coordinator.saveDraft(true);
    expect(coordinator.getSnapshot().heldCommand).toBeUndefined();
    expect(coordinator.getSnapshot().lastReceipt).toMatchObject({ operation: 'save', policyId: expect.any(String), policyRevision: 1, status: 'enabled' });
    expect(port.save).toHaveBeenCalledTimes(1);
  });

  it('settles an uncertain accepted save on inspection so saving again cannot create a duplicate', async () => {
    const save = vi.fn(async (_request: SaveBackgroundPolicyEnvelope) => { throw new WorkspaceCommandUnknownError(uuid(1), 'network'); });
    const inspect = vi.fn(async (id: string) => {
      const request = save.mock.calls[0]?.[0];
      return request ? receipt({ commandId: id, operation: 'save', policyId: request.policyId, policyRevision: 1, status: 'enabled' }) : undefined;
    });
    const { coordinator, port } = setup({ save, inspect });
    coordinator.startNewDraft();
    coordinator.toggleAccount(accountId);
    await coordinator.saveDraft(true);
    await coordinator.inspectHeldCommand();
    expect(coordinator.getSnapshot().draft).toBeUndefined();
    await coordinator.saveDraft(true);
    expect(port.save).toHaveBeenCalledTimes(1);
  });

  it('preserves a form edited while an uncertain save was held and rebases it to the accepted revision', async () => {
    const save = vi.fn(async (_request: SaveBackgroundPolicyEnvelope) => { throw new WorkspaceCommandUnknownError(uuid(1), 'network'); });
    const inspect = vi.fn(async (id: string) => {
      const request = save.mock.calls[0]?.[0];
      return request ? receipt({ commandId: id, operation: 'save', policyId: request.policyId, policyRevision: 1, status: 'enabled' }) : undefined;
    });
    const { coordinator } = setup({ save, inspect });
    coordinator.startNewDraft();
    coordinator.toggleAccount(accountId);
    await coordinator.saveDraft(true);
    coordinator.setIntervalMinutes('7');
    const savedPolicyId = coordinator.getSnapshot().heldCommand?.policyId;
    await coordinator.inspectHeldCommand();
    expect(coordinator.getSnapshot().draft).toMatchObject({ policyId: savedPolicyId, expectedPolicyRevision: 1, intervalMinutes: '7', dirty: true });
  });

  it('retains a dirty form when starting or opening another saved policy', () => {
    const { coordinator } = setup({ list: vi.fn(async () => [display()]) });
    coordinator.startNewDraft();
    coordinator.toggleAccount(accountId);
    coordinator.startNewDraft();
    expect(coordinator.getSnapshot().draft?.accounts).toHaveLength(1);
    coordinator.editPolicy(policyId);
    expect(coordinator.getSnapshot().draft?.policyId).toBeUndefined();
    expect(coordinator.getSnapshot().notice).toMatch(/Save or cancel/);
  });

  it('rejects duplicate IDs across keyset pages and preserves the prior page', async () => {
    const { coordinator, port } = setup({ list: vi.fn().mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => display(uuid(i + 1))))
      .mockResolvedValueOnce([display(uuid(101)), display(uuid(101))]) });
    await coordinator.loadFirstPage();
    expect(coordinator.getSnapshot().nextAfterPolicyId).toBe(uuid(100));
    await coordinator.loadMore();
    expect(coordinator.getSnapshot().policies).toHaveLength(100);
    expect(coordinator.getSnapshot().notice).toMatch(/page repeated an ID/);
    expect(port.list).toHaveBeenNthCalledWith(2, 3, uuid(100));
  });

  it('rejects a page whose IDs do not advance beyond the raw cursor', async () => {
    const { coordinator } = setup({ list: vi.fn().mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => display(uuid(i + 1))))
      .mockResolvedValueOnce([display(uuid(0))]) });
    await coordinator.loadFirstPage();
    await coordinator.loadMore();
    expect(coordinator.getSnapshot().policies).toHaveLength(100);
    expect(coordinator.getSnapshot().notice).toMatch(/did not follow the saved ID cursor/);
  });

  it('reloads a first page without losing later cached pages and merges newer revisions', async () => {
    const firstPage = () => Array.from({ length: 100 }, (_, i) => display(uuid(i + 1)));
    const secondPage = () => Array.from({ length: 100 }, (_, i) => display(uuid(i + 101)));
    const refreshedFirst = firstPage().map((item) => item.policyId === uuid(50) ? display(uuid(50), 2) : item);
    const refreshedSecond = secondPage().map((item) => item.policyId === uuid(150) ? display(uuid(150), 2) : item);
    const { coordinator } = setup({ list: vi.fn().mockResolvedValueOnce(firstPage()).mockResolvedValueOnce(secondPage())
      .mockResolvedValueOnce(refreshedFirst).mockResolvedValueOnce(refreshedSecond) });
    await coordinator.loadFirstPage();
    await coordinator.loadMore();
    await coordinator.loadFirstPage();
    await coordinator.loadMore();
    expect(coordinator.getSnapshot().policies).toHaveLength(200);
    expect(coordinator.getSnapshot().policies?.find((item) => item.policyId === uuid(50))?.revision).toBe(2);
    expect(coordinator.getSnapshot().policies?.find((item) => item.policyId === uuid(150))?.revision).toBe(2);
    expect(coordinator.getSnapshot().notice).toBeUndefined();
  });

  it('blocks a second mutation after pause until the fresh revision is reloaded', async () => {
    const { coordinator, port } = setup({ list: vi.fn().mockResolvedValueOnce([display(policyId, 1, 'enabled')])
      .mockResolvedValueOnce([display(policyId, 2, 'paused')]) });
    await coordinator.loadFirstPage();
    await coordinator.pausePolicy(policyId);
    expect(coordinator.getSnapshot().reloadRequiredPolicies).toContainEqual({ policyId, minimumRevision: 2 });
    await coordinator.revokePolicy(policyId);
    expect(port.revoke).not.toHaveBeenCalled();
    await coordinator.loadFirstPage();
    expect(coordinator.getSnapshot().reloadRequiredPolicies).toEqual([]);
    await coordinator.revokePolicy(policyId);
    expect(port.revoke).toHaveBeenCalledWith(expect.objectContaining({ policyId, expectedPolicyRevision: 2 }));
  });

  it('does not publish a page fetched for a replaced epoch', async () => {
    let release!: (value: readonly BackgroundPolicyDisplay[]) => void;
    const waiting = new Promise<readonly BackgroundPolicyDisplay[]>((resolve) => { release = resolve; });
    const { coordinator, replaceSnapshot } = setup({ list: vi.fn(() => waiting) });
    const loading = coordinator.loadFirstPage();
    replaceSnapshot(snapshot(4));
    release([display()]);
    await loading;
    expect(coordinator.getSnapshot().policies).toBeUndefined();
    expect(coordinator.getSnapshot().loaded).toBeUndefined();
    expect(coordinator.getSnapshot().loading).toBe(false);
    expect(coordinator.getSnapshot().notice).toMatch(/workspace changed/);
  });
});
