import { Platform } from 'react-native';
import type { Proposal } from '../core';

export type ReminderAlertResult = { status: 'scheduled'; notificationId: string } | { status: 'disabled' | 'unavailable' | 'blocked' | 'expired' };
export const reminderNotificationId = (proposal: Pick<Proposal, 'id' | 'revision'>) => `reminder-${proposal.id}-${proposal.revision}`;

interface NotificationBridge {
  SchedulableTriggerInputTypes: { DATE: unknown };
  requestPermissionsAsync(): Promise<{ status: string }>;
  getAllScheduledNotificationsAsync(): Promise<{ identifier: string }[]>;
  scheduleNotificationAsync(input: { identifier: string; content: { title: string; body: string; data: Record<string, string | number> }; trigger: unknown }): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
}

/** Cancel only an alert owned by this app's proposal/revision pair. */
export async function cancelReminderNotification(
  proposal: Pick<Proposal, 'id' | 'revision'>,
  platform: string = Platform.OS,
  loadBridge: () => Promise<NotificationBridge> = async () => await import('expo-notifications') as unknown as NotificationBridge,
): Promise<void> {
  if (platform === 'web') return;
  try {
    const Notifications = await loadBridge();
    const identifier = reminderNotificationId(proposal);
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    if (existing.some((item) => item.identifier === identifier)) await Notifications.cancelScheduledNotificationAsync(identifier);
  } catch { /* Local note deletion/edit remains successful if alerts are unavailable. */ }
}

/** Called only from the user's explicit Execute action. Browser alerts are never promised after closing the tab. */
export async function requestReminderNotification(
  proposal: Proposal,
  platform: string = Platform.OS,
  loadBridge: () => Promise<NotificationBridge> = async () => await import('expo-notifications') as unknown as NotificationBridge,
  guard: () => boolean = () => true,
): Promise<ReminderAlertResult> {
  if (platform === 'web') return { status: 'unavailable' };
  if (!proposal.dueAt || !Number.isFinite(Date.parse(proposal.dueAt))) return { status: 'disabled' };
  try {
    const Notifications = await loadBridge();
    const permission = await Notifications.requestPermissionsAsync();
    if (permission.status !== 'granted') return { status: 'disabled' };
    if (!guard()) return { status: 'blocked' };
    if (Date.parse(proposal.dueAt) <= Date.now()) return { status: 'expired' };
    const identifier = reminderNotificationId(proposal);
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    const prior = existing.find((item) => item.identifier === identifier);
    if (!guard()) return { status: 'blocked' };
    if (Date.parse(proposal.dueAt) <= Date.now()) return { status: 'expired' };
    if (prior) return { status: 'scheduled', notificationId: prior.identifier };
    const notificationId = await Notifications.scheduleNotificationAsync({
      identifier,
      content: { title: proposal.title || 'Reminder', body: proposal.body, data: { proposalId: proposal.id, proposalRevision: proposal.revision } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(proposal.dueAt) },
    });
    return { status: 'scheduled', notificationId };
  } catch {
    return { status: 'disabled' };
  }
}
