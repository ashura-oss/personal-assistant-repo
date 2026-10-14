import type { MailAlertNotificationContent } from './mailAlertNotificationBackend';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

export function proactiveMailAlertNotificationIdentifier(installationId: string, receiptId: string): string {
  if (!UUID.test(installationId) || !UUID.test(receiptId)) throw new Error('Mail alert notification invalid request.');
  return `still-mail-alert:${installationId.toLowerCase()}:${receiptId.toLowerCase()}`;
}

export function proactiveMailAlertNotificationContent(input: { installationId: string; receiptId: string }): MailAlertNotificationContent {
  return {
    identifier: proactiveMailAlertNotificationIdentifier(input.installationId, input.receiptId),
    title: 'New mail alert', body: 'A saved mail rule matched a new message.',
    data: { kind: 'proactive_mail_alert', installationId: input.installationId.toLowerCase(), receiptId: input.receiptId.toLowerCase() },
    sound: false, interruptionLevel: 'active',
  };
}

export function isMatchingProactiveMailAlertNotification(
  input: { installationId: string; receiptId: string }, value: unknown,
): boolean {
  try {
    const expected = proactiveMailAlertNotificationContent(input);
    if (!isRecord(value)) return false;
    const notification = isRecord(value.request) ? value.request : value;
    if (!isRecord(notification) || notification.identifier !== expected.identifier || !isRecord(notification.content)) return false;
    const content = notification.content;
    const noValue = (item: unknown) => item === undefined || item === null || item === '';
    const emptyAttachments = content.attachments === undefined || content.attachments === null || Array.isArray(content.attachments) && content.attachments.length === 0;
    const allowedKeys = new Set(['title', 'body', 'data', 'sound', 'interruptionLevel', 'attachments', 'badge', 'subtitle', 'categoryIdentifier', 'launchImageName', 'threadIdentifier', 'summaryArgument', 'color', 'sticky']);
    const safeExtras = (content.sound === undefined || content.sound === null || content.sound === false) && noValue(content.badge) &&
      noValue(content.subtitle) && emptyAttachments && noValue(content.categoryIdentifier) && noValue(content.launchImageName) &&
      noValue(content.threadIdentifier) && noValue(content.summaryArgument) && noValue(content.color) && content.sticky !== true;
    if (Object.keys(content).some((key) => !allowedKeys.has(key)) || !safeExtras || content.title !== expected.title || content.body !== expected.body ||
        content.interruptionLevel !== 'active' || !isRecord(content.data)) return false;
    const data = content.data;
    return Object.keys(data).length === 3 && data.kind === expected.data.kind && data.installationId === expected.data.installationId && data.receiptId === expected.data.receiptId;
  } catch { return false; }
}
