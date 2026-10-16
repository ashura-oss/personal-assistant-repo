import type { ReminderPayload } from '../reminders';
import { validateReminderPayload } from '../reminders';
import type { WorkspaceCommand, WorkspaceCommandResponse, ReminderDeviceSelection } from '../cloud/workspaceCommands';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import { WorkspaceClientError } from './workspaceClient';

export type CloudReminderState = Readonly<{
  busy: boolean;
  pending?: Readonly<{ commandId: string; kind: WorkspaceCommand['kind'] }>;
  message?: string;
}>;

export interface CloudReminderCoordinator {
  readonly getSnapshot: () => CloudReminderState;
  readonly subscribe: (listener: () => void) => () => void;
  createDraft(payload: ReminderPayload): Promise<WorkspaceCommandResponse>;
  editDraft(reminderId: string, expectedRevision: number, payload: ReminderPayload): Promise<WorkspaceCommandResponse>;
  approve(reminderId: string, expectedRevision: number): Promise<WorkspaceCommandResponse>;
  save(reminderId: string, expectedRevision: number, selection: ReminderDeviceSelection): Promise<WorkspaceCommandResponse>;
  cancel(reminderId: string, expectedRevision: number): Promise<WorkspaceCommandResponse>;
  complete(reminderId: string, expectedRevision: number): Promise<WorkspaceCommandResponse>;
  delete(reminderId: string, expectedRevision: number): Promise<WorkspaceCommandResponse>;
  inspectPending(): Promise<WorkspaceCommandResponse | undefined>;
  dispose(): void;
}

export type CloudReminderCoordinatorOptions = Readonly<{
  readSnapshot: () => WorkspaceSnapshotDTO | undefined;
  execute: (command: WorkspaceCommand, onAdmitted?: (commandId: string) => void) => Promise<WorkspaceCommandResponse>;
  inspect: (commandId: string) => Promise<WorkspaceCommandResponse>;
  assertCurrent: () => void;
}>;

const INITIAL: CloudReminderState = Object.freeze({ busy: false });

export function createCloudReminderCoordinator(options: CloudReminderCoordinatorOptions): CloudReminderCoordinator {
  let current = true;
  let busy = false;
  let value = INITIAL;
  let operation = 0;
  let pending: CloudReminderState['pending'];
  const listeners = new Set<() => void>();
  const publish = (message?: string) => {
    if (!current) return;
    value = Object.freeze({ busy, ...(pending ? { pending } : {}), ...(message ? { message } : {}) });
    for (const listener of listeners) listener();
  };
  const ownerSnapshot = () => {
    options.assertCurrent();
    const snapshot = options.readSnapshot();
    if (!snapshot) throw new WorkspaceClientError('stale', 'Load the workspace before changing a reminder.');
    return snapshot;
  };
  const findReminder = (id: string, revision: number) => {
    const snapshot = ownerSnapshot();
    const reminder = snapshot.state.reminders.records.find((item) => item.id === id);
    if (!reminder || reminder.revision !== revision) throw new WorkspaceClientError('stale', 'This reminder changed. Refresh it before continuing.');
    return { snapshot, reminder };
  };
  const run = async (command: WorkspaceCommand, check?: () => void): Promise<WorkspaceCommandResponse> => {
    options.assertCurrent();
    if (!current) throw new WorkspaceClientError('disposed', 'This reminder workspace is no longer active.');
    if (busy || pending) throw new WorkspaceClientError('busy', 'Inspect the pending reminder command before continuing.');
    check?.();
    busy = true;
    const ticket = ++operation;
    let admittedCommandId: string | undefined;
    publish();
    try {
      const response = await options.execute(command, (id) => {
        options.assertCurrent();
        admittedCommandId = id;
      });
      options.assertCurrent();
      if (!current || operation !== ticket) throw new WorkspaceClientError('stale', 'The reminder workspace changed.');
      if (response.status !== 'finished') {
        pending = Object.freeze({ commandId: response.commandId, kind: command.kind });
        publish('The reminder change is unresolved. Inspect this exact command before taking another action.');
      } else publish('Reminder updated in this workspace.');
      return response;
    } catch (error) {
      options.assertCurrent();
      if (current && operation === ticket && admittedCommandId) {
        pending = Object.freeze({ commandId: admittedCommandId, kind: command.kind });
        publish('The reminder result is unresolved. Inspect this exact command; do not submit it again.');
      } else if (current && operation === ticket) publish(error instanceof Error ? error.message : 'The reminder change could not be started.');
      throw error;
    } finally {
      if (operation === ticket) {
        busy = false;
        publish(value.message);
      }
    }
  };
  const revisionCommand = (kind: 'reminders.approve' | 'reminders.cancel' | 'reminders.complete' | 'reminders.delete', reminderId: string,
    expectedReminderRevision: number): WorkspaceCommand => ({ kind, reminderId, expectedReminderRevision });
  return Object.freeze({
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    createDraft: (payload: ReminderPayload) => run({ kind: 'reminders.createDraft', payload: validateReminderPayload(payload) }),
    editDraft: (reminderId: string, expectedReminderRevision: number, payload: ReminderPayload) => run({ kind: 'reminders.editDraft', reminderId,
      expectedReminderRevision, payload: validateReminderPayload(payload) }, () => { findReminder(reminderId, expectedReminderRevision); }),
    approve: (reminderId: string, expectedReminderRevision: number) => run(revisionCommand('reminders.approve', reminderId, expectedReminderRevision),
      () => { findReminder(reminderId, expectedReminderRevision); }),
    save: (reminderId: string, expectedReminderRevision: number, selection: ReminderDeviceSelection) => run({ kind: 'reminders.serverSave', reminderId,
      expectedReminderRevision, deviceSelection: selection }, () => {
        const { reminder } = findReminder(reminderId, expectedReminderRevision);
        if (reminder.status !== 'approved' || reminder.approvedRevision !== expectedReminderRevision) {
          throw new WorkspaceClientError('stale', 'Approve the current reminder version before saving it.');
        }
      }),
    cancel: (reminderId: string, expectedReminderRevision: number) => run(revisionCommand('reminders.cancel', reminderId, expectedReminderRevision),
      () => { findReminder(reminderId, expectedReminderRevision); }),
    complete: (reminderId: string, expectedReminderRevision: number) => run(revisionCommand('reminders.complete', reminderId, expectedReminderRevision),
      () => { findReminder(reminderId, expectedReminderRevision); }),
    delete: (reminderId: string, expectedReminderRevision: number) => run(revisionCommand('reminders.delete', reminderId, expectedReminderRevision),
      () => { findReminder(reminderId, expectedReminderRevision); }),
    inspectPending: async () => {
      options.assertCurrent();
      const commandId = pending?.commandId;
      if (!current || busy || !commandId) return undefined;
      busy = true;
      const ticket = ++operation;
      publish();
      try {
        const response = await options.inspect(commandId);
        options.assertCurrent();
        if (!current || operation !== ticket || pending?.commandId !== commandId) return undefined;
        if (response.status === 'finished' && response.commandId === commandId) {
          pending = undefined;
          publish('The reminder command receipt is confirmed. Refresh the workspace if its latest card is not visible.');
        } else publish('The exact reminder command is still unresolved. No new command was submitted.');
        return response;
      } catch (error) {
        options.assertCurrent();
        if (current && operation === ticket) publish(error instanceof Error ? error.message : 'The reminder receipt could not be inspected.');
        throw error;
      } finally {
        if (operation === ticket) { busy = false; publish(value.message); }
      }
    },
    dispose: () => { current = false; operation += 1; pending = undefined; busy = false; listeners.clear(); value = INITIAL; },
  });
}
