/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudReminderPanel } from '../src/web/CloudReminderPanel';
import { createCloudReminderCoordinator } from '../src/web/cloudReminderCoordinator';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';
import type { WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { ReminderDisplayRecord } from '../src/ui/reminderDisplay';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return { Text: ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => ReactModule.createElement('span', { role: accessibilityRole }, children),
    View: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children) };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) =>
    ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label),
  Field: ({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) =>
    ReactModule.createElement('label', null, label, ReactModule.createElement('input', { value, onChange: (event: Event) => onChangeText((event.target as HTMLInputElement).value) })) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333' }, s: { errorText: {} } }));

const REMINDER_ID = '4164d451-86c8-4bae-8254-45e11cbfc0ca';
const DEVICE_ID = 'c8da91ad-26a6-4fe0-9f7e-a19cd593a8dd';
const COMMAND_ID = '833d8b86-f31e-44c9-a9ca-e8b93110b252';
let host: HTMLDivElement;
let root: Root;

function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Missing button ${label}`);
  act(() => button.click());
}

function record(status: ReminderDisplayRecord['status']): ReminderDisplayRecord {
  return { id: REMINDER_ID, revision: 4, status, approvedRevision: status === 'approved' ? 4 : undefined, title: 'Dentist', body: 'details',
    dueAt: '2099-10-20T01:00:00.000Z', displayTimeZone: 'UTC', createdAt: '2099-10-18T00:00:00.000Z',
    updatedAt: '2099-10-19T00:00:00.000Z', privacyMode: 'private',
    origin: { kind: 'manual' }, approvedPayloadDigest: status === 'approved' ? 'a'.repeat(64) : undefined } as ReminderDisplayRecord;
}

function makeCoordinator(command: ReturnType<typeof vi.fn>, status: ReminderDisplayRecord['status']) {
  const snapshot = { workspaceId: 'cdf24ad9-ae4a-4dbb-a86a-872fae4a18a4', revision: 3, privacyEpoch: 0, schemaVersion: 1,
    state: { reminders: { records: [record(status)] } } } as unknown as WorkspaceSnapshotDTO;
  return createCloudReminderCoordinator({ readSnapshot: () => snapshot, execute: command as never, inspect: vi.fn(), assertCurrent: () => undefined });
}

function finished(id: string): WorkspaceCommandResponse { return { schemaVersion: 1, commandId: id, status: 'finished' }; }

describe('cloud reminder panel', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

  it('requires an explicit all-current choice and binds the exact button to the local device generation', async () => {
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const coordinator = makeCoordinator(execute, 'approved');
    const webPush = { phase: 'enabled', busy: false, permission: 'granted', deviceId: DEVICE_ID, generation: 7, subscriptionCount: 2 } as const;
    await act(async () => { root.render(<CloudReminderPanel records={[record('approved')]} webPush={webPush} coordinator={coordinator}
      state={coordinator.getSnapshot()} blocked={false} />); });
    expect(host.textContent).not.toContain(DEVICE_ID);
    click('Save on this device');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(execute.mock.calls[0]?.[0]).toEqual({ kind: 'reminders.serverSave', reminderId: REMINDER_ID,
      expectedReminderRevision: 4, deviceSelection: { subscriptions: [{ subscriptionId: DEVICE_ID, generation: 7 }] } });
    coordinator.dispose();
  });

  it('explains due-time all-device selection without implying a saved device-count snapshot', async () => {
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const coordinator = makeCoordinator(execute, 'approved');
    const webPush = { phase: 'enabled', busy: false, permission: 'granted', deviceId: DEVICE_ID, generation: 7, subscriptionCount: 2 } as const;
    await act(async () => { root.render(<CloudReminderPanel records={[record('approved')]} webPush={webPush} coordinator={coordinator}
      state={coordinator.getSnapshot()} blocked={false} />); });
    expect(host.textContent).toContain('All devices enabled when this reminder is due');
    expect(host.textContent).toContain('This choice is evaluated once when the reminder is due. “Save on this device” selects this browser’s current subscription generation.');
    expect(host.textContent).not.toContain('(2)');
    click('All devices enabled when this reminder is due');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(execute.mock.calls[0]?.[0]).toEqual({ kind: 'reminders.serverSave', reminderId: REMINDER_ID,
      expectedReminderRevision: 4, deviceSelection: 'all_current' });
    coordinator.dispose();
  });
});
