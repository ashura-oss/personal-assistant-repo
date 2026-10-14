import { legacyReminderIdentifier, notificationContentForIntent, reminderNotificationIdentifier, validateLegacyReminderCancellation, validateReminderIntent } from '../reminders';
import type { LegacyReminderCancellation, ReminderIntent } from '../reminders';
import type { PendingNotificationRequest } from './notificationBackend';

function exactData(data: unknown, expected: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const row = data as Record<string, unknown>;
  const keys = Object.keys(row);
  return keys.length === Object.keys(expected).length && keys.every((key) => Object.prototype.hasOwnProperty.call(expected, key) && row[key] === expected[key]);
}

export function isMatchingPending(intent: ReminderIntent, pending: PendingNotificationRequest, installationId: string): boolean {
  try {
    const valid = validateReminderIntent(intent, installationId);
    const projection = notificationContentForIntent(valid, installationId);
    return valid.desired === 'scheduled' && pending.identifier === reminderNotificationIdentifier(installationId, valid.reminderId, valid.epoch) &&
      pending.title === projection.title && pending.body === projection.body && exactData(pending.data, projection.data) && pending.extraContentSafe &&
      pending.trigger.verifiable && pending.trigger.repeats === false && Boolean(valid.payload) && pending.trigger.dueAt === valid.payload!.dueAt;
  } catch { return false; }
}

export function isOwnedLegacyReminderCancellation(cancellation: LegacyReminderCancellation, pending: PendingNotificationRequest): boolean {
  try {
    const valid = validateLegacyReminderCancellation(cancellation);
    return pending.identifier === legacyReminderIdentifier(valid.proposalId, valid.proposalRevision) && pending.identifier === valid.identifier &&
      pending.data?.proposalId === valid.proposalId && pending.data?.proposalRevision === valid.proposalRevision;
  } catch { return false; }
}
