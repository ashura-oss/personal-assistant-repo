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
  Field: ({ label, value, onChangeText, editable = true }: { label: string; value: string; onChangeText: (value: string) => void; editable?: boolean }) =>
    ReactModule.createElement('label', null, label, ReactModule.createElement('input', { value, disabled: !editable, 'aria-label': label,
      onChange: (event: Event) => onChangeText((event.target as HTMLInputElement).value) })) };
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
  if (button.disabled) throw new Error(`Button ${label} is disabled`);
  act(() => button.click());
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => { setter?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

function record(status: ReminderDisplayRecord['status'], overrides: Partial<ReminderDisplayRecord> = {}): ReminderDisplayRecord {
  return { id: REMINDER_ID, revision: 4, status, approvedRevision: status === 'approved' ? 4 : undefined, title: 'Dentist', body: 'details',
    dueAt: '2099-10-20T01:00:00.000Z', displayTimeZone: 'UTC', createdAt: '2099-10-18T00:00:00.000Z',
    updatedAt: '2099-10-19T00:00:00.000Z', privacyMode: 'private',
    origin: { kind: 'manual' }, approvedPayloadDigest: status === 'approved' ? 'a'.repeat(64) : undefined, ...overrides } as ReminderDisplayRecord;
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

  it('preserves the exact original due instant when only the title changes', async () => {
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const coordinator = makeCoordinator(execute, 'saved');
    const saved = record('saved', { dueAt: '2099-10-20T01:00:45.000Z' });
    await act(async () => { root.render(<CloudReminderPanel records={[saved]} coordinator={coordinator} state={coordinator.getSnapshot()} blocked={false} />); });
    click('Edit reminder');
    expect(host.querySelector('input[type="datetime-local"]')).toBeTruthy();
    const title = host.querySelector<HTMLInputElement>('input[aria-label="Reminder title"]')!;
    expect(title.value).toBe('Dentist');
    changeInput(title, 'Dentist follow-up');
    expect(title.value).toBe('Dentist follow-up');
    expect(host.textContent).toContain('Saving changes returns this reminder to draft. Approve it and choose devices again to schedule notifications.');
    click('Save as draft');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ kind: 'reminders.editDraft', reminderId: REMINDER_ID, expectedReminderRevision: 4,
      payload: { title: 'Dentist follow-up', dueAt: '2099-10-20T01:00:45.000Z', displayTimeZone: 'UTC' } });
    coordinator.dispose();
  });

  it('preselects and preserves the original DST fold when editing only the title', async () => {
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const coordinator = makeCoordinator(execute, 'saved');
    const saved = record('saved', { dueAt: '2026-11-01T06:30:45.000Z', displayTimeZone: 'America/New_York' });
    await act(async () => { root.render(<CloudReminderPanel records={[saved]} coordinator={coordinator} state={coordinator.getSnapshot()} blocked={false} />); });
    click('Edit reminder');
    expect(host.textContent).toContain('Second occurrence · selected');
    const title = host.querySelector<HTMLInputElement>('input[aria-label="Reminder title"]')!;
    changeInput(title, 'Dentist follow-up');
    expect(title.value).toBe('Dentist follow-up');
    click('Save as draft');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ kind: 'reminders.editDraft', expectedReminderRevision: 4,
      payload: { title: 'Dentist follow-up', dueAt: '2026-11-01T06:30:45.000Z', displayTimeZone: 'America/New_York' } });
    coordinator.dispose();
  });

  it('offers cancel, delete confirmation, and completion while approved or saved', async () => {
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const coordinator = makeCoordinator(execute, 'approved');
    await act(async () => { root.render(<CloudReminderPanel records={[record('approved')]} coordinator={coordinator} state={coordinator.getSnapshot()} blocked={false} />); });
    expect(host.querySelectorAll('button').length).toBeGreaterThan(0);
    click('Mark done');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(execute.mock.calls[0]?.[0]).toEqual({ kind: 'reminders.complete', reminderId: REMINDER_ID, expectedReminderRevision: 4 });
    coordinator.dispose();

    const savedExecute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const savedCoordinator = makeCoordinator(savedExecute, 'saved');
    await act(async () => { root.render(<CloudReminderPanel records={[record('saved')]} coordinator={savedCoordinator} state={savedCoordinator.getSnapshot()} blocked={false} />); });
    click('Cancel reminder');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(savedExecute.mock.calls[0]?.[0]).toEqual({ kind: 'reminders.cancel', reminderId: REMINDER_ID, expectedReminderRevision: 4 });
    click('Delete reminder');
    expect(host.textContent).toContain('This cannot be undone.');
    expect(savedExecute).toHaveBeenCalledTimes(1);
    click('Delete permanently');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(savedExecute.mock.calls[1]?.[0]).toEqual({ kind: 'reminders.delete', reminderId: REMINDER_ID, expectedReminderRevision: 4 });
    savedCoordinator.dispose();
  });

  it('requires a fresh delete confirmation when the record revision changes', async () => {
    let currentRecord = record('saved');
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const coordinator = createCloudReminderCoordinator({ readSnapshot: () => ({ workspaceId: 'cdf24ad9-ae4a-4dbb-a86a-872fae4a18a4', revision: 3,
      privacyEpoch: 0, schemaVersion: 1, state: { reminders: { records: [currentRecord] } } } as unknown as WorkspaceSnapshotDTO),
      execute: execute as never, inspect: vi.fn(), assertCurrent: () => undefined });
    await act(async () => { root.render(<CloudReminderPanel records={[currentRecord]} coordinator={coordinator} state={coordinator.getSnapshot()} blocked={false} />); });
    click('Delete reminder');
    currentRecord = record('saved', { revision: 5, title: 'Dentist changed' });
    await act(async () => { root.render(<CloudReminderPanel records={[currentRecord]} coordinator={coordinator} state={coordinator.getSnapshot()} blocked={false} />); });
    expect(host.textContent).toContain('changed after you opened the delete confirmation');
    click('Review deletion');
    click('Delete permanently');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(execute.mock.calls[0]?.[0]).toEqual({ kind: 'reminders.delete', reminderId: REMINDER_ID, expectedReminderRevision: 5 });
    coordinator.dispose();
  });

  it('keeps exact status inspection available during an unresolved command and disables mutations', async () => {
    const execute = vi.fn(async (_command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const coordinator = makeCoordinator(execute, 'draft');
    await act(async () => { root.render(<CloudReminderPanel records={[record('draft')]} coordinator={coordinator}
      state={{ busy: false, pending: { commandId: COMMAND_ID, kind: 'reminders.createDraft' } }} blocked={false} />); });
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Check status')?.disabled).toBe(false);
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'New reminder')?.disabled).toBe(true);
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Approve this reminder')?.disabled).toBe(true);
    coordinator.dispose();
  });

  it('keeps submitted form values while unresolved and clears them only after that exact receipt finishes', async () => {
    const execute = vi.fn(async (_command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => ({
      schemaVersion: 1, commandId: COMMAND_ID, status: 'inspect_required',
    }));
    const inspect = vi.fn(async (id: string): Promise<WorkspaceCommandResponse> => finished(id));
    const coordinator = createCloudReminderCoordinator({ readSnapshot: () => undefined, execute, inspect, assertCurrent: () => undefined });
    await act(async () => { root.render(<CloudReminderPanel records={[]} coordinator={coordinator} state={coordinator.getSnapshot()} blocked={false} />); });
    click('New reminder');
    const title = host.querySelector<HTMLInputElement>('input[aria-label="Reminder title"]')!;
    const due = host.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    changeInput(title, 'Checkup');
    changeInput(due, '2099-10-20T09:30');
    click('Create draft');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Reminder title"]')?.value).toBe('Checkup');
    expect(host.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.value).toBe('2099-10-20T09:30');
    await act(async () => { root.render(<CloudReminderPanel records={[]} coordinator={coordinator} state={coordinator.getSnapshot()} blocked={false} />); });
    click('Check status');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(inspect).toHaveBeenCalledWith(COMMAND_ID);
    expect(host.querySelector('input[aria-label="Reminder title"]')).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('ignores a late result from a replaced coordinator so it cannot clear a new session form', async () => {
    let release!: (response: WorkspaceCommandResponse) => void;
    let firstSession = true;
    const oldCoordinator = createCloudReminderCoordinator({ readSnapshot: () => undefined,
      execute: vi.fn(() => new Promise<WorkspaceCommandResponse>((resolve) => { release = resolve; })) as never,
      inspect: vi.fn(), assertCurrent: () => { if (!firstSession) throw new Error('session changed'); } });
    await act(async () => { root.render(<CloudReminderPanel records={[]} coordinator={oldCoordinator} state={oldCoordinator.getSnapshot()} blocked={false} />); });
    click('New reminder');
    const oldTitle = host.querySelector<HTMLInputElement>('input[aria-label="Reminder title"]')!;
    const oldDue = host.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    changeInput(oldTitle, 'Old session'); changeInput(oldDue, '2099-10-20T09:30'); click('Create draft');
    await act(async () => { await Promise.resolve(); });

    firstSession = false;
    const newCoordinator = makeCoordinator(vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID)), 'draft');
    await act(async () => { root.render(<CloudReminderPanel records={[]} coordinator={newCoordinator} state={newCoordinator.getSnapshot()} blocked={false} />); });
    click('New reminder');
    const newTitle = host.querySelector<HTMLInputElement>('input[aria-label="Reminder title"]')!;
    changeInput(newTitle, 'New session');
    await act(async () => { release(finished(COMMAND_ID)); await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Reminder title"]')?.value).toBe('New session');
    oldCoordinator.dispose(); newCoordinator.dispose();
  });

  it('shows a gap error and asks for a fold choice only when a local time is ambiguous', async () => {
    const execute = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceCommandResponse> => finished(COMMAND_ID));
    const coordinator = makeCoordinator(execute, 'draft');
    await act(async () => { root.render(<CloudReminderPanel records={[]} coordinator={coordinator} state={coordinator.getSnapshot()} blocked={false} />); });
    click('New reminder');
    const zone = host.querySelector<HTMLInputElement>('input[aria-label="IANA time zone"]');
    expect(zone).toBeNull();
    click('Change time zone');
    const zoneInput = host.querySelector<HTMLInputElement>('input[aria-label="Change time zone · IANA name"]')!;
    changeInput(zoneInput, 'America/New_York');
    const due = host.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    changeInput(due, '2026-03-08T02:30');
    expect(host.textContent).toContain('That local time does not exist in this time zone');
    expect(host.textContent).not.toContain('First occurrence');
    changeInput(due, '2026-11-01T01:30');
    expect(host.textContent).toContain('First occurrence');
    expect(host.textContent).toContain('Second occurrence');
    coordinator.dispose();
  });
});
