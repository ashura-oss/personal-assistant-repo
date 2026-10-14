import type { DeviceCalendarBackendErrorCode } from '../deviceCalendars/types';

export class NotificationBackendError extends Error {
  readonly code: 'permission_denied' | 'permission_unavailable' | 'listing_failed' | 'schedule_failed' | 'cancel_failed' | 'invalid_request' | 'unverifiable' | 'unavailable';
  constructor(code: NotificationBackendError['code']) { super(`Reminder notification ${code.replaceAll('_', ' ')}.`); this.name = 'NotificationBackendError'; this.code = code; }
}

export class DeviceCalendarBackendError extends Error {
  readonly code: DeviceCalendarBackendErrorCode;
  constructor(code: DeviceCalendarBackendErrorCode) {
    super(`Device calendar ${code.replaceAll('_', ' ')}.`);
    this.name = 'DeviceCalendarBackendError';
    this.code = code;
  }
}
