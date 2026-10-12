import { Platform } from 'react-native';
import {
  legacyReminderIdentifier, notificationContentForIntent, reminderNotificationIdentifier,
  validateLegacyReminderCancellation, validateReminderIntent,
} from '../reminders';
import type { LegacyReminderCancellation, ReminderIntent } from '../reminders';

export type NotificationPlatform = 'ios' | 'android' | 'web' | 'mock';
export type NotificationPermission = 'authorized' | 'provisional' | 'denied' | 'undetermined' | 'unavailable';

export interface NormalizedNotificationTrigger { dueAt?: string; repeats: boolean; verifiable: boolean }
export interface PendingNotificationRequest {
  identifier: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  trigger: NormalizedNotificationTrigger;
  extraContentSafe: boolean;
}

export interface ForegroundNotificationProjection {
  identifier?: string;
  content: { title?: unknown; body?: unknown; data?: unknown };
}

export interface ExpoNotificationBridge {
  getPermissionsAsync(): Promise<unknown>;
  requestPermissionsAsync(): Promise<unknown>;
  getAllScheduledNotificationsAsync(): Promise<unknown>;
  scheduleNotificationAsync(input: unknown): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
  setNotificationHandler?(handler: { handleNotification(notification: ExpoForegroundNotification): Promise<unknown> }): void;
}

export interface ExpoForegroundNotification {
  request?: { identifier?: string; content?: unknown; trigger?: unknown };
  date?: unknown;
}

export class NotificationBackendError extends Error {
  readonly code: 'permission_denied' | 'permission_unavailable' | 'listing_failed' | 'schedule_failed' | 'cancel_failed' | 'invalid_request' | 'unverifiable' | 'unavailable';
  constructor(code: NotificationBackendError['code']) { super(`Reminder notification ${code.replaceAll('_', ' ')}.`); this.name = 'NotificationBackendError'; this.code = code; }
}

export interface NotificationBackend {
  readonly platform: NotificationPlatform;
  getPermission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  listPending(): Promise<PendingNotificationRequest[]>;
  schedule(intent: ReminderIntent, installationId?: string, beforeSchedule?: () => boolean): Promise<string>;
  cancel(identifier: string): Promise<void>;
  cancelLegacy(cancellation: LegacyReminderCancellation, pending: PendingNotificationRequest): Promise<void>;
  installForegroundHandler(isAllowedByCachedLedger: (notification: ForegroundNotificationProjection) => boolean): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;
function object(value: unknown): value is UnknownRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exactData(data: unknown, expected: Record<string, unknown>): boolean {
  if (!object(data)) return false;
  const keys = Object.keys(data);
  return keys.length === Object.keys(expected).length && keys.every((key) => Object.prototype.hasOwnProperty.call(expected, key) && data[key] === expected[key]);
}

function zeroOffsetZone(value: unknown): value is string {
  return typeof value === 'string' && ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT', 'Etc/GMT0', 'GMT0', 'UCT', 'Universal', 'Zulu', 'Greenwich'].includes(value);
}
function componentDate(components: unknown): { dueAt?: string; verifiable: boolean } {
  if (!object(components)) return { verifiable: false };
  const values = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) => components[key]);
  if (values.some((value) => !Number.isInteger(value))) return { verifiable: false };
  if (!zeroOffsetZone(components.timeZone ?? components.timezone)) return { verifiable: false };
  if (components.calendar !== undefined && components.calendar !== 'gregorian' && components.calendar !== 'iso8601') return { verifiable: false };
  if ((components.isLeapMonth !== undefined && components.isLeapMonth !== false) ||
      (components.isRepeatedDay !== undefined && components.isRepeatedDay !== false)) return { verifiable: false };
  for (const [key, allowed] of Object.entries({ era: 1, weekday: 0, weekdayOrdinal: 0, quarter: 0, weekOfMonth: 0, weekOfYear: 0, yearForWeekOfYear: 0, nanosecond: 0 })) {
    const value = components[key];
    if (value !== undefined && value !== null && value !== allowed) return { verifiable: false };
  }
  const [year, month, day, hour, minute, second] = values as number[];
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || day! > 31 || hour! > 23 || minute! > 59 || second! > 59) return { verifiable: false };
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, 0));
  if (!Number.isFinite(date.valueOf()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return { verifiable: false };
  return { dueAt: date.toISOString(), verifiable: true };
}

function normalizeTrigger(trigger: unknown, platform: NotificationPlatform): NormalizedNotificationTrigger {
  if (!object(trigger)) return { repeats: false, verifiable: false };
  if (trigger.type === 'calendar') {
    const parsed = componentDate(trigger.dateComponents);
    return { ...(parsed.dueAt ? { dueAt: parsed.dueAt } : {}), repeats: trigger.repeats === true, verifiable: parsed.verifiable && trigger.repeats === false };
  }
  // Expo's DATE input is time-interval based on iOS. It lacks an absolute calendar date after restart.
  if (trigger.type === 'date' && platform === 'android') {
    const date = trigger.date instanceof Date ? trigger.date : typeof trigger.date === 'number' ? new Date(trigger.date) : undefined;
    if (!date || !Number.isFinite(date.valueOf())) return { repeats: false, verifiable: false };
    const dueAt = date.toISOString();
    return { dueAt, repeats: false, verifiable: true };
  }
  return { repeats: trigger.repeats === true, verifiable: false };
}

function extraContentSafe(content: UnknownRecord): boolean {
  const noValue = (value: unknown) => value === undefined || value === null || value === '';
  const emptyAttachments = content.attachments === undefined || content.attachments === null || Array.isArray(content.attachments) && content.attachments.length === 0;
  return (content.sound === undefined || content.sound === null || content.sound === false) && noValue(content.badge) && noValue(content.subtitle) && emptyAttachments &&
    noValue(content.categoryIdentifier) && noValue(content.launchImageName) && noValue(content.threadIdentifier) && noValue(content.summaryArgument) &&
    content.interruptionLevel === 'active' && noValue(content.color) && content.sticky !== true;
}

function normalizeRequest(value: unknown, platform: NotificationPlatform): PendingNotificationRequest | undefined {
  if (!object(value) || typeof value.identifier !== 'string') return undefined;
  const content = object(value.content) ? value.content : {};
  return {
    identifier: value.identifier,
    ...(typeof content.title === 'string' ? { title: content.title } : content.title == null ? { title: '' } : {}),
    ...(typeof content.body === 'string' ? { body: content.body } : content.body == null ? { body: '' } : {}),
    ...(object(content.data) ? { data: { ...content.data } } : {}),
    trigger: normalizeTrigger(value.trigger, platform), extraContentSafe: extraContentSafe(content),
  };
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

function permission(value: unknown, platform: NotificationPlatform): NotificationPermission {
  if (!object(value)) return 'unavailable';
  const ios = object(value.ios) ? value.ios : undefined;
  if (platform === 'ios' && ios?.status === 3) return 'provisional';
  if (platform === 'ios' && (ios?.status === 2 || ios?.status === 4)) return 'authorized';
  if (value.status === 'granted' || value.granted === true) return 'authorized';
  if (value.status === 'denied') return 'denied';
  if (value.status === 'undetermined') return 'undetermined';
  return 'unavailable';
}

function localPlatform(): NotificationPlatform {
  return Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? Platform.OS : 'mock';
}

function intentInstallationId(intent: ReminderIntent): string | undefined {
  const match = /^still-reminder:([0-9a-f-]{36}):[0-9a-f-]{36}:[1-9]\d{0,8}$/.exec(intent.identifier);
  return match?.[1];
}

export function createNotificationBackend(
  platform: NotificationPlatform = localPlatform(),
  loadBridge: () => Promise<ExpoNotificationBridge> = async () => await import('expo-notifications') as unknown as ExpoNotificationBridge,
): NotificationBackend {
  const isUnavailable = platform === 'web';
  const bridge = async () => {
    if (isUnavailable) throw new NotificationBackendError('unavailable');
    try { return await loadBridge(); } catch { throw new NotificationBackendError('unavailable'); }
  };
  const cancelNative = async (identifier: string, legacy = false) => {
    const owned = legacy ? /^reminder-[^\u0000-\u001f\u007f]{1,256}-[1-9]\d{0,8}$/.test(identifier) : /^still-reminder:[0-9a-f-]{36}:[0-9a-f-]{36}:[1-9]\d{0,8}$/.test(identifier);
    if (!owned) throw new NotificationBackendError('invalid_request');
    try { await (await bridge()).cancelScheduledNotificationAsync(identifier); }
    catch (error) { if (error instanceof NotificationBackendError) throw error; throw new NotificationBackendError('cancel_failed'); }
  };
  return {
    platform,
    async getPermission() {
      if (isUnavailable) return 'unavailable';
      try { return permission(await (await bridge()).getPermissionsAsync(), platform); } catch { return 'unavailable'; }
    },
    async requestPermission() {
      if (isUnavailable) return 'unavailable';
      try { return permission(await (await bridge()).requestPermissionsAsync(), platform); } catch { return 'unavailable'; }
    },
    async listPending() {
      if (isUnavailable) return [];
      try {
        const value = await (await bridge()).getAllScheduledNotificationsAsync();
        if (!Array.isArray(value)) throw new Error('bad_shape');
        return value.map((item) => normalizeRequest(item, platform)).filter((item): item is PendingNotificationRequest => Boolean(item));
      } catch (error) { if (error instanceof NotificationBackendError) throw error; throw new NotificationBackendError('listing_failed'); }
    },
    async schedule(intent, explicitInstallationId, beforeSchedule) {
      const installationId = explicitInstallationId ?? intentInstallationId(intent);
      if (!installationId) throw new NotificationBackendError('invalid_request');
      const valid = validateReminderIntent(intent, installationId);
      if (valid.desired !== 'scheduled') throw new NotificationBackendError('invalid_request');
      if (!valid.payload) throw new NotificationBackendError('invalid_request');
      if (isUnavailable) throw new NotificationBackendError('unavailable');
      const permissionState = await this.getPermission();
      if (permissionState === 'denied' || permissionState === 'undetermined') throw new NotificationBackendError('permission_denied');
      if (permissionState === 'unavailable') throw new NotificationBackendError('permission_unavailable');
      const content = notificationContentForIntent(valid, installationId);
      const due = new Date(valid.payload.dueAt);
      const trigger = platform === 'ios'
        ? { type: 'calendar', repeats: false, timezone: 'UTC', year: due.getUTCFullYear(), month: due.getUTCMonth() + 1,
          day: due.getUTCDate(), hour: due.getUTCHours(), minute: due.getUTCMinutes(), second: due.getUTCSeconds() }
        : { type: 'date', date: due };
      try {
        const api = await bridge();
        let allowed = true;
        try { allowed = beforeSchedule?.() !== false; } catch { allowed = false; }
        if (!allowed) throw new NotificationBackendError('invalid_request');
        const identifier = await api.scheduleNotificationAsync({ identifier: valid.identifier,
          content: { title: content.title, body: content.body, data: content.data, sound: false, interruptionLevel: 'active' }, trigger });
        if (identifier !== valid.identifier) throw new Error('unexpected_identifier');
        return identifier;
      } catch (error) { if (error instanceof NotificationBackendError) throw error; throw new NotificationBackendError('schedule_failed'); }
    },
    async cancel(identifier) { await cancelNative(identifier); },
    async cancelLegacy(cancellation, pending) {
      if (!isOwnedLegacyReminderCancellation(cancellation, pending)) throw new NotificationBackendError('invalid_request');
      await cancelNative(cancellation.identifier, true);
    },
    async installForegroundHandler(isAllowedByCachedLedger) {
      if (isUnavailable) return;
      let api: ExpoNotificationBridge;
      try { api = await bridge(); } catch (error) { throw error; }
      if (!api.setNotificationHandler) throw new NotificationBackendError('unavailable');
      api.setNotificationHandler({ handleNotification: async (notification) => {
        let allowed = false;
        try {
          const request = object(notification) && object(notification.request) ? notification.request : undefined;
          const content = request && object(request.content) ? request.content : undefined;
          if (request && content) {
            const projection: ForegroundNotificationProjection = {
              ...(typeof request.identifier === 'string' ? { identifier: request.identifier } : {}),
              content: { title: content.title, body: content.body, data: content.data },
            };
            allowed = isAllowedByCachedLedger(projection) === true;
          }
        } catch { allowed = false; }
        return { shouldShowBanner: allowed, shouldShowList: allowed, shouldPlaySound: false, shouldSetBadge: false };
      } });
    },
  };
}
