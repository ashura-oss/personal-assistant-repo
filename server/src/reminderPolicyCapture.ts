import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentCommandTicket, type CommandTicketContext } from './commandJournal.js';
import type { OwnedTransactionContext } from './kernel.js';
import { canonicalBackgroundJson, parseBackgroundSpecification, type BackgroundReminderDevices } from './backgroundContracts.js';

type ExactReminderDevices = Exclude<BackgroundReminderDevices, 'all_current' | { readonly subscriptionIds: readonly string[] }>;

interface Capture {
  readonly ticket: CommandTicketContext;
  readonly commandId: string;
  readonly reminderId: string;
  readonly reminderRevision: number;
  readonly policyId: string;
  readonly devices: 'all_current' | ExactReminderDevices;
  consumed: boolean;
}

const activeCapture = new AsyncLocalStorage<Capture>();

function fail(): never { throw new Error('background_reminder_command_capture_invalid'); }

/** Only the validated workspace-command gateway should scope this one-use policy input. */
export async function withReminderSavePolicyCapture<T>(input: Readonly<{
  canonicalCommandBody: string;
  commandId: string;
  reminderId: string;
  expectedReminderRevision: number;
  deviceSelection: unknown;
}>, operation: () => Promise<T>): Promise<T> {
  const ticket = currentCommandTicket();
  if (!ticket || ticket.kind !== 'reminders.serversave' || ticket.idempotencyKey !== input.commandId ||
      !Number.isSafeInteger(input.expectedReminderRevision) || input.expectedReminderRevision < 1 ||
      typeof input.canonicalCommandBody !== 'string' ||
      createHash('sha256').update(`${ticket.kind}\0${input.canonicalCommandBody}`, 'utf8').digest('hex') !== ticket.requestDigest ||
      activeCapture.getStore()) return fail();

  let specification;
  try {
    specification = parseBackgroundSpecification({ kind: 'approved_reminder_delivery', reminderId: input.reminderId,
      expectedReminderRevision: input.expectedReminderRevision, channel: 'web_push', devices: input.deviceSelection });
  } catch { return fail(); }
  if (specification.kind !== 'approved_reminder_delivery' ||
      (specification.devices !== 'all_current' && !('subscriptions' in specification.devices))) return fail();
  let body: unknown;
  try { body = JSON.parse(input.canonicalCommandBody); } catch { return fail(); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype ||
      Object.keys(body).sort().join(',') !== 'command,commandId,expectedPrivacyEpoch,expectedRevision,schemaVersion') return fail();
  const envelope = body as Record<string, unknown>;
  const command = envelope.command;
  if (envelope.schemaVersion !== 1 || envelope.commandId !== input.commandId ||
      !Number.isSafeInteger(envelope.expectedRevision) || (envelope.expectedRevision as number) < 0 ||
      !Number.isSafeInteger(envelope.expectedPrivacyEpoch) || (envelope.expectedPrivacyEpoch as number) < 0 ||
      !command || typeof command !== 'object' || Array.isArray(command) || Object.getPrototypeOf(command) !== Object.prototype ||
      Object.keys(command).sort().join(',') !== 'deviceSelection,expectedReminderRevision,kind,reminderId') return fail();
  const commandRow = command as Record<string, unknown>;
  if (commandRow.kind !== 'reminders.serverSave' || commandRow.reminderId !== specification.reminderId ||
      commandRow.expectedReminderRevision !== specification.expectedReminderRevision ||
      canonicalBackgroundJson(commandRow.deviceSelection) !== canonicalBackgroundJson(specification.devices)) return fail();

  const capture: Capture = {
    ticket,
    commandId: input.commandId,
    reminderId: specification.reminderId,
    reminderRevision: specification.expectedReminderRevision,
    policyId: randomUUID(),
    devices: specification.devices,
    consumed: false,
  };
  return activeCapture.run(capture, operation);
}

/** Private participant proof; the capture is consumed only inside the exact active owned transaction. */
export function consumeReminderSavePolicyCapture(context: OwnedTransactionContext, input: Readonly<{
  commandId: string;
  reminderId: string;
  reminderRevision: number;
}>): Readonly<{ commandId: string; reminderId: string; reminderRevision: number; policyId: string;
  devices: 'all_current' | ExactReminderDevices }> {
  const capture = activeCapture.getStore();
  const ticket = currentCommandTicket();
  if (!capture || capture.consumed || !context || !ticket || ticket !== capture.ticket || ticket.kind !== 'reminders.serversave' ||
      ticket.idempotencyKey !== input.commandId || capture.commandId !== input.commandId ||
      capture.reminderId !== input.reminderId || capture.reminderRevision !== input.reminderRevision ||
      context.workspaceId !== ticket.workspaceId || context.ownerId !== ticket.ownerId || context.privacyEpoch !== ticket.privacyEpoch) return fail();
  context.assertActive();
  capture.consumed = true;
  return Object.freeze({ commandId: capture.commandId, reminderId: capture.reminderId,
    reminderRevision: capture.reminderRevision, policyId: capture.policyId, devices: capture.devices });
}

export function readReminderSavePolicyCapture(context: OwnedTransactionContext, commandId: string): Readonly<{
  commandId: string; reminderId: string; reminderRevision: number;
}> {
  const capture = activeCapture.getStore();
  const ticket = currentCommandTicket();
  if (!capture || capture.consumed || !context || !ticket || ticket !== capture.ticket || ticket.kind !== 'reminders.serversave' ||
      ticket.idempotencyKey !== commandId || capture.commandId !== commandId || context.workspaceId !== ticket.workspaceId ||
      context.ownerId !== ticket.ownerId || context.privacyEpoch !== ticket.privacyEpoch) return fail();
  context.assertActive();
  return Object.freeze({ commandId: capture.commandId, reminderId: capture.reminderId, reminderRevision: capture.reminderRevision });
}
