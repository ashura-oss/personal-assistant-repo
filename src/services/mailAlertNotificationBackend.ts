import { Platform } from 'react-native';

export type MailAlertNotificationPermission = 'authorized' | 'provisional' | 'denied' | 'undetermined' | 'unavailable';
export type MailAlertPresentationResult = 'submitted' | 'not_admitted' | 'permission_denied' | 'unavailable' | 'delivery_unknown';
export type MailAlertCancellationResult = 'absent' | 'cancelled' | 'not_admitted' | 'cancellation_unknown';
export interface MailAlertNotificationContent {
  identifier: string;
  title: 'New mail alert';
  body: 'A saved mail rule matched a new message.';
  data: { kind: 'proactive_mail_alert'; installationId: string; receiptId: string };
  sound: false;
  interruptionLevel: 'active';
}

export interface MailAlertNotificationBridge {
  getPermissionsAsync(): Promise<unknown>;
  requestPermissionsAsync(): Promise<unknown>;
  scheduleNotificationAsync(request: unknown): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
  getAllScheduledNotificationsAsync(): Promise<unknown>;
  getPresentedNotificationsAsync(): Promise<unknown>;
  dismissNotificationAsync(identifier: string): Promise<void>;
}

/**
 * Immediate, privacy-minimal notification seam. It never requests permission and never installs
 * a foreground handler; the app's shared handler owns presentation policy.
 */
export interface MailAlertNotificationBackend {
  readonly platform: 'ios' | 'android' | 'web' | 'mock';
  getPermission(): Promise<MailAlertNotificationPermission>;
  /** Called only from an explicit consent action; automatic refresh paths must never call it. */
  requestPermission(): Promise<MailAlertNotificationPermission>;
  present(input: { installationId: string; receiptId: string }, beforePresent: () => Promise<boolean>): Promise<MailAlertPresentationResult>;
  cancel(input: { installationId: string; receiptId: string }, beforeCancel: () => Promise<boolean>): Promise<MailAlertCancellationResult>;
}

export class MailAlertNotificationBackendError extends Error {
  readonly code: 'unavailable' | 'invalid_request';
  constructor(code: MailAlertNotificationBackendError['code']) {
    super(`Mail alert notification ${code.replaceAll('_', ' ')}.`);
    this.name = 'MailAlertNotificationBackendError';
    this.code = code;
  }
}

type RecordLike = Record<string, unknown>;
function isRecord(value: unknown): value is RecordLike { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function proactiveMailAlertNotificationIdentifier(installationId: string, receiptId: string): string {
  if (!UUID.test(installationId) || !UUID.test(receiptId)) throw new MailAlertNotificationBackendError('invalid_request');
  return `still-mail-alert:${installationId.toLowerCase()}:${receiptId.toLowerCase()}`;
}

function localPlatform(): MailAlertNotificationBackend['platform'] {
  return Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? Platform.OS : 'mock';
}
function permission(value: unknown, platform: MailAlertNotificationBackend['platform']): MailAlertNotificationPermission {
  if (!isRecord(value)) return 'unavailable';
  const ios = isRecord(value.ios) ? value.ios : undefined;
  if (platform === 'ios' && ios?.status === 3) return 'provisional';
  if (platform === 'ios' && (ios?.status === 2 || ios?.status === 4)) return 'authorized';
  if (value.status === 'granted' || value.granted === true) return 'authorized';
  if (value.status === 'denied') return 'denied';
  if (value.status === 'undetermined') return 'undetermined';
  return 'unavailable';
}
function requestIdentifier(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.identifier === 'string') return value.identifier;
  if (isRecord(value.request) && typeof value.request.identifier === 'string') return value.request.identifier;
  return undefined;
}

function hasExactMailAlertData(value: unknown, installationId: string, receiptId: string): boolean {
  if (!isRecord(value)) return false;
  const notification = isRecord(value.request) ? value.request : value;
  if (!isRecord(notification) || !isRecord(notification.content) || !isRecord(notification.content.data)) return false;
  const data = notification.content.data;
  return Object.keys(data).length === 3 && data.kind === 'proactive_mail_alert' &&
    data.installationId === installationId.toLowerCase() && data.receiptId === receiptId.toLowerCase();
}

/** Single fixed projection also used by the shared foreground handler for exact allowlisting. */
export function proactiveMailAlertNotificationContent(input: { installationId: string; receiptId: string }): MailAlertNotificationContent {
  return {
    identifier: proactiveMailAlertNotificationIdentifier(input.installationId, input.receiptId),
    title: 'New mail alert', body: 'A saved mail rule matched a new message.',
    data: { kind: 'proactive_mail_alert', installationId: input.installationId.toLowerCase(), receiptId: input.receiptId.toLowerCase() },
    sound: false, interruptionLevel: 'active',
  };
}

export function isMatchingProactiveMailAlertNotification(
  input: { installationId: string; receiptId: string },
  value: unknown,
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

function normalizeList(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length > 5000) return undefined;
  for (const row of value) if (!requestIdentifier(row)) return undefined;
  return value;
}

export function createMailAlertNotificationBackend(
  platform: MailAlertNotificationBackend['platform'] = localPlatform(),
  loadBridge: () => Promise<MailAlertNotificationBridge> = async () => await import('expo-notifications') as unknown as MailAlertNotificationBridge,
): MailAlertNotificationBackend {
  const unavailable = platform === 'web';
  const bridge = async () => {
    if (unavailable) throw new MailAlertNotificationBackendError('unavailable');
    try { return await loadBridge(); }
    catch { throw new MailAlertNotificationBackendError('unavailable'); }
  };
  return {
    platform,
    async getPermission() {
      if (unavailable) return 'unavailable';
      try { return permission(await (await bridge()).getPermissionsAsync(), platform); }
      catch { return 'unavailable'; }
    },
    async requestPermission() {
      if (unavailable) return 'unavailable';
      try { return permission(await (await bridge()).requestPermissionsAsync(), platform); }
      catch { return 'unavailable'; }
    },
    async present(input, beforePresent) {
      const frozenInput = { installationId: input.installationId, receiptId: input.receiptId };
      let identifier: string;
      try { identifier = proactiveMailAlertNotificationIdentifier(frozenInput.installationId, frozenInput.receiptId); }
      catch { return 'not_admitted'; }
      if (unavailable) return 'unavailable';
      let api: MailAlertNotificationBridge;
      try { api = await bridge(); } catch { return 'unavailable'; }
      let permissionState: MailAlertNotificationPermission;
      try { permissionState = permission(await api.getPermissionsAsync(), platform); } catch { return 'unavailable'; }
      if (permissionState === 'denied' || permissionState === 'undetermined') return 'permission_denied';
      if (permissionState === 'unavailable') return 'unavailable';
      try { if (await beforePresent() !== true) return 'not_admitted'; }
      catch { return 'not_admitted'; }
      try {
        const { identifier: requestId, title, body, data, sound, interruptionLevel } = proactiveMailAlertNotificationContent(frozenInput);
        const scheduled = await api.scheduleNotificationAsync({ identifier: requestId,
          content: { title, body, data, sound, interruptionLevel }, trigger: null });
        return scheduled === identifier ? 'submitted' : 'delivery_unknown';
      } catch { return 'delivery_unknown'; }
    },
    async cancel(input, beforeCancel) {
      const frozenInput = { installationId: input.installationId, receiptId: input.receiptId };
      let identifier: string;
      try { identifier = proactiveMailAlertNotificationIdentifier(frozenInput.installationId, frozenInput.receiptId); }
      catch { return 'not_admitted'; }
      if (unavailable) return 'cancellation_unknown';
      let api: MailAlertNotificationBridge;
      try { api = await bridge(); } catch { return 'cancellation_unknown'; }
      try { if (await beforeCancel() !== true) return 'not_admitted'; }
      catch { return 'not_admitted'; }
      const list = async (): Promise<{ scheduled: unknown[]; presented: unknown[] }> => {
        // Start each native read independently and drain both actual promises even when one
        // rejects synchronously or asynchronously. Releasing the writer while its sibling read
        // is still active would make the snapshot incomplete and allow unsafe absence proof.
        const results = await Promise.allSettled([
          Promise.resolve().then(() => api.getAllScheduledNotificationsAsync()),
          Promise.resolve().then(() => api.getPresentedNotificationsAsync()),
        ]);
        const scheduledResult = results[0];
        const presentedResult = results[1];
        if (scheduledResult.status !== 'fulfilled' || presentedResult.status !== 'fulfilled') {
          throw new Error('notification_snapshot_unavailable');
        }
        const scheduled = scheduledResult.value;
        const presented = presentedResult.value;
        const normalizedScheduled = normalizeList(scheduled);
        const normalizedPresented = normalizeList(presented);
        if (!normalizedScheduled || !normalizedPresented) throw new Error('invalid_notification_snapshot');
        return { scheduled: normalizedScheduled, presented: normalizedPresented };
      };
      try {
        const initial = await list();
        const unexpectedOwned = (rows: unknown[]) => rows.some((row) =>
          hasExactMailAlertData(row, frozenInput.installationId, frozenInput.receiptId) && requestIdentifier(row) !== identifier);
        if (unexpectedOwned(initial.scheduled) || unexpectedOwned(initial.presented)) return 'cancellation_unknown';
        const scheduled = initial.scheduled.some((row) => requestIdentifier(row) === identifier);
        const presented = initial.presented.some((row) => requestIdentifier(row) === identifier);
        if (!scheduled && !presented) return 'absent';
        if (scheduled) await api.cancelScheduledNotificationAsync(identifier);
        if (presented) await api.dismissNotificationAsync(identifier);
        const after = await list();
        if (unexpectedOwned(after.scheduled) || unexpectedOwned(after.presented)) return 'cancellation_unknown';
        const remains = after.scheduled.some((row) => requestIdentifier(row) === identifier) ||
          after.presented.some((row) => requestIdentifier(row) === identifier);
        return remains ? 'cancellation_unknown' : 'cancelled';
      } catch { return 'cancellation_unknown'; }
    },
  };
}
