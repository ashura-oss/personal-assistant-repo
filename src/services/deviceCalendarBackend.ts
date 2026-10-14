import { Platform } from 'react-native';
import type {
  DeviceCalendarBackendErrorCode, DeviceCalendarDiscoveryResult, DeviceCalendarDto,
  DeviceCalendarPermission, DeviceCalendarPlatform, DeviceCalendarReadResult,
  DeviceCalendarReadWindow, DeviceCalendarRow, DeviceEventCreateResult,
  DeviceEventDispatchRecord, DeviceEventLookupResult, DeviceEventSnapshot,
} from '../deviceCalendars';
import { DeviceCalendarBackendError } from './controllerRuntimeErrors';
export { DeviceCalendarBackendError } from './controllerRuntimeErrors';

type ExpoCalendarModule = typeof import('expo-calendar');
type PermissionResponse = { status?: string; granted?: boolean; canAskAgain?: boolean };
type NativeCalendar = {
  id: string; title: string; source?: { id?: string; name?: string; type?: string };
  timeZone?: string; allowsModifications?: boolean;
};
type NativeEvent = {
  id: string; calendarId: string; title: string; notes?: string | null; startDate: string | Date;
  endDate: string | Date; originalStartDate?: string | Date | null; timeZone?: string | null;
  allDay?: boolean; status?: unknown;
};

export interface DeviceCalendarBackend {
  readonly platform: DeviceCalendarPlatform;
  getPermission(): Promise<DeviceCalendarPermission>;
  requestFullPermission(): Promise<DeviceCalendarPermission>;
  listCalendars(previous?: readonly DeviceCalendarRow[]): Promise<DeviceCalendarDiscoveryResult>;
  getCalendar(nativeId: string, previous?: DeviceCalendarRow): Promise<DeviceCalendarRow>;
  readEvents(calendarLocalId: string, nativeCalendarId: string, window: DeviceCalendarReadWindow, observedAt: string, generation: number): Promise<DeviceCalendarReadResult>;
  createApprovedEvent(record: DeviceEventDispatchRecord, beforeCreate: () => boolean): Promise<DeviceEventCreateResult>;
  lookupRecord(record: DeviceEventDispatchRecord): Promise<DeviceEventLookupResult>;
}

export interface DeviceCalendarBackendOptions {
  platform?: DeviceCalendarPlatform;
  loadCalendarModule?: () => Promise<ExpoCalendarModule>;
  idFactory?: () => string;
  sha256Hex?: (canonical: string) => Promise<string>;
  now?: () => Date;
}

function asDate(value: unknown): Date | undefined {
  const result = value instanceof Date ? new Date(value.valueOf()) : typeof value === 'string' ? new Date(value) : undefined;
  return result && Number.isFinite(result.valueOf()) ? result : undefined;
}
function isoDate(value: unknown): string | undefined { return asDate(value)?.toISOString(); }
function defaultId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function nativePermission(response: PermissionResponse | undefined): DeviceCalendarPermission {
  if (!response) return 'unavailable';
  if (response.granted === true || response.status === 'granted') return 'full_access';
  if (response.status === 'undetermined') return 'undetermined';
  return 'denied';
}
function nativeEventStatusIsCancelled(status: unknown): boolean {
  return status === 'canceled' || status === 'cancelled' || status === 3;
}
function eventContentKey(event: DeviceEventSnapshot): string {
  return JSON.stringify([event.title, event.notes, event.start, event.end, event.timeZone ?? null, event.allDay, event.cancelled]);
}
function safeNativeEventId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return undefined;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined;
  }
  return value;
}

export function createDeviceCalendarBackend(options: DeviceCalendarBackendOptions = {}): DeviceCalendarBackend {
  const platform = options.platform ?? (Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web');
  const idFactory = options.idFactory ?? defaultId;
  const now = options.now ?? (() => new Date());
  const ioTimeoutMs = 10_000;
  const domain = () => import('../deviceCalendars');
  async function bounded<T>(operation: Promise<T>, code: DeviceCalendarBackendErrorCode): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new DeviceCalendarBackendError(code)), ioTimeoutMs);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  let modulePromise: Promise<ExpoCalendarModule> | undefined;
  const loadModule = async (): Promise<ExpoCalendarModule> => {
    if (platform !== 'ios') throw new DeviceCalendarBackendError('unavailable');
    modulePromise ??= (options.loadCalendarModule ?? (() => import('expo-calendar')))();
    try { return await modulePromise; } catch { modulePromise = undefined; throw new DeviceCalendarBackendError('unavailable'); }
  };
  const requireFullAccess = async (module: ExpoCalendarModule): Promise<void> => {
    try {
      const permission = await bounded(module.getCalendarPermissions(false), 'permission_unavailable');
      if (nativePermission(permission) === 'full_access') return;
      const write = await bounded(module.getCalendarPermissions(true), 'permission_unavailable');
      if (nativePermission(write) === 'full_access') throw new DeviceCalendarBackendError('permission_denied');
      throw new DeviceCalendarBackendError(permission?.status === 'undetermined' ? 'permission_unavailable' : 'permission_denied');
    } catch (error) {
      if (error instanceof DeviceCalendarBackendError) throw error;
      throw new DeviceCalendarBackendError('permission_unavailable');
    }
  };
  const makeRow = async (calendar: unknown, previous?: DeviceCalendarRow): Promise<DeviceCalendarRow> => {
    const api = await domain();
    let dto: DeviceCalendarDto;
    try { dto = api.normalizeDeviceCalendar(calendar); } catch { throw new DeviceCalendarBackendError('calendar_list_failed'); }
    const localId = previous?.nativeId === dto.nativeId ? previous.localId : idFactory();
    let fingerprint: string;
    try {
      fingerprint = await api.fingerprintDeviceCalendar(dto, options.sha256Hex ?? (async (value) => {
        const crypto = await import('expo-crypto');
        return crypto.digestStringAsync(crypto.CryptoDigestAlgorithm.SHA256, value);
      }));
      return api.createDeviceCalendarRow({ localId, dto, fingerprint, observedAt: now().toISOString() });
    } catch { throw new DeviceCalendarBackendError('calendar_list_failed'); }
  };
  const ensureTarget = async (record: DeviceEventDispatchRecord): Promise<{ row: DeviceCalendarRow; calendar: import('expo-calendar').ExpoCalendar; module: ExpoCalendarModule }> => {
    const api = await domain();
    const module = await loadModule();
    await requireFullAccess(module);
    let native: NativeCalendar;
    try { native = await bounded(module.ExpoCalendar.get(record.target.nativeId) as unknown as Promise<NativeCalendar>, 'unavailable'); }
    catch (error) { if (error instanceof DeviceCalendarBackendError) throw error; throw new DeviceCalendarBackendError('calendar_missing'); }
    let fresh: DeviceCalendarRow;
    try {
      const dto = api.normalizeDeviceCalendar(native);
      fresh = api.createDeviceCalendarRow({ localId: record.target.calendarLocalId, dto,
        fingerprint: await api.fingerprintDeviceCalendar(dto, options.sha256Hex ?? (async (value) => {
          const crypto = await import('expo-crypto');
          return crypto.digestStringAsync(crypto.CryptoDigestAlgorithm.SHA256, value);
        })), observedAt: now().toISOString() });
    } catch { throw new DeviceCalendarBackendError('calendar_changed'); }
    if (fresh.nativeId !== record.target.nativeId || fresh.fingerprint !== record.target.fingerprint) throw new DeviceCalendarBackendError('calendar_changed');
    if (!fresh.allowsModifications) throw new DeviceCalendarBackendError('calendar_readonly');
    return { row: fresh, calendar: native as unknown as import('expo-calendar').ExpoCalendar, module };
  };

  const backend: DeviceCalendarBackend = {
    platform,
    async getPermission() {
      if (platform !== 'ios') return 'unavailable';
      try {
        const module = await loadModule();
        const full = await bounded(module.getCalendarPermissions(false), 'permission_unavailable');
        if (nativePermission(full) === 'full_access') return 'full_access';
        const write = await bounded(module.getCalendarPermissions(true), 'permission_unavailable');
        if (nativePermission(write) === 'full_access') return 'write_only';
        return full?.status === 'undetermined' ? 'undetermined' : 'denied';
      } catch { return 'unavailable'; }
    },
    async requestFullPermission() {
      if (platform !== 'ios') return 'unavailable';
      try {
        const module = await loadModule();
        const requested = await module.requestCalendarPermissions(false);
        if (nativePermission(requested) === 'full_access') return 'full_access';
        const write = await bounded(module.getCalendarPermissions(true), 'permission_unavailable');
        if (nativePermission(write) === 'full_access') return 'write_only';
        return requested?.status === 'undetermined' ? 'undetermined' : 'denied';
      } catch { return 'unavailable'; }
    },
    async listCalendars(previous = []) {
      const module = await loadModule();
      await requireFullAccess(module);
      let rows: NativeCalendar[];
      try { rows = await bounded(module.getCalendars(module.EntityTypes.EVENT) as unknown as Promise<NativeCalendar[]>, 'calendar_list_failed'); }
      catch { throw new DeviceCalendarBackendError('calendar_list_failed'); }
      if (!Array.isArray(rows)) throw new DeviceCalendarBackendError('calendar_list_failed');
      const oldByNative = new Map(previous.map((item) => [item.nativeId, item]));
      const calendars: DeviceCalendarRow[] = [];
      let omitted = 0;
      const seenIds = new Set<string>();
      omitted += Math.max(0, rows.length - 2000);
      for (const native of rows.slice(0, 2000)) {
        try {
          const normalized = await domain().then(({ normalizeDeviceCalendar }) => normalizeDeviceCalendar(native));
          if (seenIds.has(normalized.nativeId)) { omitted++; continue; }
          seenIds.add(normalized.nativeId);
          if (calendars.length >= 100) { omitted++; continue; }
          calendars.push(await makeRow(native, oldByNative.get(normalized.nativeId)));
        } catch { omitted++; }
      }
      return { calendars, omitted, discoveryTruncated: omitted > 0 };
    },
    async getCalendar(nativeId, previous) {
      if (typeof nativeId !== 'string' || !nativeId || new TextEncoder().encode(nativeId).length > 1024) throw new DeviceCalendarBackendError('invalid_request');
      const module = await loadModule();
      await requireFullAccess(module);
      let calendar: NativeCalendar;
      try { calendar = await bounded(module.ExpoCalendar.get(nativeId) as unknown as Promise<NativeCalendar>, 'calendar_list_failed'); }
      catch (error) { if (error instanceof DeviceCalendarBackendError) throw error; throw new DeviceCalendarBackendError('calendar_missing'); }
      if (calendar.id !== nativeId) throw new DeviceCalendarBackendError('calendar_changed');
      return makeRow(calendar, previous);
    },
    async readEvents(calendarLocalId, nativeCalendarId, window, observedAt, generation) {
      const { validateDeviceCalendarReadWindow, sanitizeNativeNotes, validateDeviceEventSnapshot, normalizeDeviceTimeZone } = await domain();
      const validatedWindow = validateDeviceCalendarReadWindow(window, 15);
      if (typeof calendarLocalId !== 'string' || !calendarLocalId || typeof nativeCalendarId !== 'string' || !nativeCalendarId || !Number.isSafeInteger(generation) || generation < 1) throw new DeviceCalendarBackendError('invalid_request');
      const module = await loadModule();
      await requireFullAccess(module);
      let calendar: NativeCalendar;
      try { calendar = await bounded(module.ExpoCalendar.get(nativeCalendarId) as unknown as Promise<NativeCalendar>, 'calendar_read_failed'); }
      catch (error) { if (error instanceof DeviceCalendarBackendError) throw error; throw new DeviceCalendarBackendError('calendar_missing'); }
      if (calendar.id !== nativeCalendarId) throw new DeviceCalendarBackendError('calendar_changed');
      let nativeEvents: NativeEvent[];
      try { nativeEvents = await bounded(module.listEvents([nativeCalendarId], new Date(validatedWindow.timeMin), new Date(validatedWindow.timeMax)) as unknown as Promise<NativeEvent[]>, 'calendar_read_failed'); }
      catch { throw new DeviceCalendarBackendError('calendar_read_failed'); }
      if (!Array.isArray(nativeEvents)) throw new DeviceCalendarBackendError('calendar_read_failed');
      const scanned = nativeEvents.length;
      const capped = nativeEvents.slice(0, 2000);
      const mapped: DeviceEventSnapshot[] = [];
      let omitted = Math.max(0, scanned - capped.length);
      let conflicts = 0;
      let duplicateRows = 0;
      for (const native of capped) {
        try {
          const start = isoDate(native.startDate), end = isoDate(native.endDate);
          const id = native.id;
          if (!start || !end || Date.parse(end) <= Date.parse(start) || typeof id !== 'string' || !id || native.calendarId !== nativeCalendarId) { omitted++; continue; }
          if (Date.parse(end) <= Date.parse(validatedWindow.timeMin) || Date.parse(start) >= Date.parse(validatedWindow.timeMax)) { omitted++; continue; }
          const occurrenceStart = isoDate(native.originalStartDate) ?? start;
          const notes = sanitizeNativeNotes(native.notes ?? '');
          const normalizedZone = normalizeDeviceTimeZone(native.timeZone);
          mapped.push(validateDeviceEventSnapshot({ id: idFactory(), calendarId: calendarLocalId, nativeEventId: id, occurrenceStart,
            title: typeof native.title === 'string' ? native.title : '', notes: notes.notes, notesTruncated: notes.notesTruncated,
            start, end, ...(normalizedZone ? { timeZone: normalizedZone } : {}),
            allDay: native.allDay === true, cancelled: nativeEventStatusIsCancelled(native.status), observedAt, generation }));
        } catch { omitted++; }
      }
      const deduped = new Map<string, DeviceEventSnapshot>();
      const conflictKeys = new Set<string>();
      for (const event of mapped) {
        const key = JSON.stringify([event.calendarId, event.nativeEventId, event.occurrenceStart]);
        if (conflictKeys.has(key)) { omitted++; continue; }
        const existing = deduped.get(key);
        if (!existing) deduped.set(key, event);
        else if (eventContentKey(existing) !== eventContentKey(event)) { conflicts++; omitted += 2; conflictKeys.add(key); deduped.delete(key); }
        else { duplicateRows++; omitted++; }
      }
      const events = [...deduped.values()];
      events.sort((left, right) => left.start.localeCompare(right.start) || left.nativeEventId.localeCompare(right.nativeEventId));
      if (events.length > 200) { omitted += events.length - 200; events.length = 200; }
      return { events, scanned, omitted, duplicateRows, conflicts, partial: omitted > 0 || conflicts > 0 };
    },
    async createApprovedEvent(record, beforeCreate) {
      const valid = await domain().then(({ validateDeviceEventDispatchRecord }) => validateDeviceEventDispatchRecord(record));
      if (valid.outcome !== 'pending' || typeof beforeCreate !== 'function') throw new DeviceCalendarBackendError('precondition_failed');
      const { row, calendar, module } = await ensureTarget(valid);
      await requireFullAccess(module);
      if (calendar.id !== row.nativeId) throw new DeviceCalendarBackendError('calendar_changed');
      // The callback is deliberately synchronous and immediately precedes the one non-idempotent native write.
      let allowed = false;
      try { allowed = beforeCreate() === true; } catch { throw new DeviceCalendarBackendError('precondition_failed'); }
      if (!allowed) throw new DeviceCalendarBackendError('precondition_failed');
      let created: NativeEvent;
      try {
        created = await calendar.createEvent({
          title: valid.payload.title, notes: valid.payload.notes, startDate: new Date(valid.payload.start), endDate: new Date(valid.payload.end),
          timeZone: valid.payload.timeZone, allDay: false, alarms: [], recurrenceRule: null,
        }) as unknown as NativeEvent;
      } catch { return { status: 'unknown' }; }
      let correlationId: string | undefined;
      try {
        try { correlationId = safeNativeEventId(created?.id); } catch { /* Keep any safe ID obtained before a native shared-object getter failed. */ }
        const nativeEventId = correlationId;
        if (!created || !nativeEventId) return { status: 'unknown' };
        const start = isoDate(created.startDate), end = isoDate(created.endDate);
        const title = created.title;
        const notesValue = created.notes ?? '';
        const calendarId = created.calendarId;
        const allDay = created.allDay;
        const status = created.status;
        if (calendarId !== valid.target.nativeId || start !== valid.payload.start || end !== valid.payload.end || title !== valid.payload.title ||
            notesValue !== valid.payload.notes || allDay !== false) return { status: 'unknown', nativeEventId };
        const notes = (await domain()).sanitizeNativeNotes(notesValue);
        const event: DeviceEventSnapshot = (await domain()).validateDeviceEventSnapshot({
          id: idFactory(), calendarId: valid.target.calendarLocalId, nativeEventId, occurrenceStart: start,
          title, notes: notes.notes, notesTruncated: notes.notesTruncated, start, end,
          timeZone: valid.payload.timeZone,
          allDay: false, cancelled: nativeEventStatusIsCancelled(status), observedAt: now().toISOString(), generation: valid.target.generation,
        });
        return { status: 'saved', nativeEventId, event };
      } catch {
        return correlationId ? { status: 'unknown', nativeEventId: correlationId } : { status: 'unknown' };
      }
    },
    async lookupRecord(record) {
      const valid = await domain().then(({ validateDeviceEventDispatchRecord }) => validateDeviceEventDispatchRecord(record));
      const start = new Date(Date.parse(valid.payload.start) - 86_400_000);
      const end = new Date(Date.parse(valid.payload.start) + 86_400_000);
      const window = { timeMin: start.toISOString(), timeMax: end.toISOString() };
      const result = await backend.readEvents(valid.target.calendarLocalId, valid.target.nativeId, window, now().toISOString(), valid.target.generation);
      const candidates = valid.nativeEventId
        ? result.events.filter((event) => event.nativeEventId === valid.nativeEventId && event.calendarId === valid.target.calendarLocalId && event.occurrenceStart === valid.payload.start)
        : result.events.filter((event) => event.start === valid.payload.start && event.title === valid.payload.title);
      return { candidates, partial: result.partial, identity: valid.nativeEventId && candidates.length > 0 ? 'native_id_match' : 'unverified' };
    },
  };
  return backend;
}

let defaultBackend: DeviceCalendarBackend | undefined;
/** Lazily constructs the backend; Expo Calendar itself is not loaded unless an iOS method needs it. */
export function getDeviceCalendarBackend(): DeviceCalendarBackend {
  defaultBackend ??= createDeviceCalendarBackend();
  return defaultBackend;
}

export function resetDeviceCalendarBackendForTests(): void { defaultBackend = undefined; }
