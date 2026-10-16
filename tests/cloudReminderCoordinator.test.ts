import { describe, expect, it, vi } from 'vitest';
import { createCloudReminderCoordinator } from '../src/web/cloudReminderCoordinator';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';
import type { WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';

const REMINDER_ID = '4164d451-86c8-4bae-8254-45e11cbfc0ca';
const DEVICE_ID = 'c8da91ad-26a6-4fe0-9f7e-a19cd593a8dd';
const COMMAND_ID = '833d8b86-f31e-44c9-a9ca-e8b93110b252';

function snapshot(record?: Record<string, unknown>) {
  return { workspaceId: 'cdf24ad9-ae4a-4dbb-a86a-872fae4a18a4', revision: 3, privacyEpoch: 0, schemaVersion: 1,
    state: { reminders: { records: record ? [record] : [] } } } as unknown as WorkspaceSnapshotDTO;
}

function response(commandId: string, status: WorkspaceCommandResponse['status']): WorkspaceCommandResponse {
  return { schemaVersion: 1, commandId, status };
}

describe('cloud reminder coordinator', () => {
  it('binds save to the reviewed reminder revision and exact selected device generation', async () => {
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => response(COMMAND_ID, 'finished'));
    let reminderStatus: 'approved' | 'draft' = 'approved';
    const coordinator = createCloudReminderCoordinator({ readSnapshot: () => snapshot({ id: REMINDER_ID, revision: 4, status: reminderStatus,
      approvedRevision: reminderStatus === 'approved' ? 4 : undefined }),
      execute, inspect: vi.fn(), assertCurrent: () => undefined });
    await coordinator.save(REMINDER_ID, 4, { subscriptions: [{ subscriptionId: DEVICE_ID, generation: 8 }] });
    expect(execute).toHaveBeenCalledWith({ kind: 'reminders.serverSave', reminderId: REMINDER_ID, expectedReminderRevision: 4,
      deviceSelection: { subscriptions: [{ subscriptionId: DEVICE_ID, generation: 8 }] } }, expect.any(Function));
    await expect(coordinator.save(REMINDER_ID, 3, 'all_current')).rejects.toThrow(/changed/);
    reminderStatus = 'draft';
    await expect(coordinator.save(REMINDER_ID, 4, 'all_current')).rejects.toThrow(/Approve the current/);
    coordinator.dispose();
  });

  it('records unknown command identity and inspects it without submitting another mutation', async () => {
    const execute = vi.fn(async (_command: WorkspaceCommand, admitted?: (id: string) => void) => {
      admitted?.(COMMAND_ID);
      return response(COMMAND_ID, 'inspect_required');
    });
    const inspect = vi.fn(async (id: string) => response(id, 'finished'));
    const coordinator = createCloudReminderCoordinator({ readSnapshot: () => snapshot(), execute, inspect, assertCurrent: () => undefined });
    const result = await coordinator.createDraft({ title: 'Dentist', body: '', dueAt: '2026-10-20T01:00:00.000Z',
      displayTimeZone: 'UTC', privacyMode: 'private' });
    expect(result.status).toBe('inspect_required');
    expect(coordinator.getSnapshot().pending).toEqual({ commandId: COMMAND_ID, kind: 'reminders.createDraft' });
    await expect(coordinator.cancel(REMINDER_ID, 1)).rejects.toThrow(/Inspect the pending/);
    await coordinator.inspectPending();
    expect(inspect).toHaveBeenCalledWith(COMMAND_ID);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().pending).toBeUndefined();
    coordinator.dispose();
  });

  it('does not publish or keep a deferred result after the owner changes', async () => {
    let live = true;
    let release!: (value: WorkspaceCommandResponse) => void;
    const execute = vi.fn(() => new Promise<WorkspaceCommandResponse>((resolve) => { release = resolve; }));
    const coordinator = createCloudReminderCoordinator({ readSnapshot: () => snapshot(), execute, inspect: vi.fn(),
      assertCurrent: () => { if (!live) throw new Error('workspace owner changed'); } });
    const operation = coordinator.createDraft({ title: 'Dentist', body: '', dueAt: '2026-10-20T01:00:00.000Z',
      displayTimeZone: 'UTC', privacyMode: 'private' });
    live = false;
    release(response(COMMAND_ID, 'finished'));
    await expect(operation).rejects.toThrow(/owner changed/);
    expect(coordinator.getSnapshot().pending).toBeUndefined();
    coordinator.dispose();
  });
});
