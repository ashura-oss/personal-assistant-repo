import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { createDeviceCalendarRow, type DeviceCalendarBackend, type DeviceEventSnapshot } from '../src/deviceCalendars';
import type { NotificationBackend } from '../src/services/notificationBackend';

class Store implements StateStore {
  value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

describe('device calendar controller', () => {
  it('replaces an overlapping spanning event on refresh and keeps one row after reload', async () => {
    const store = new Store();
    const calendarLocalId = '11111111-1111-4111-8111-111111111111';
    const eventLocalId = '22222222-2222-4222-8222-222222222222';
    const row = createDeviceCalendarRow({
      localId: calendarLocalId,
      dto: { nativeId: 'native-calendar-1', title: 'Work', allowsModifications: true },
      fingerprint: 'a'.repeat(64), observedAt: new Date().toISOString(),
    });
    let firstWindowStart = 0;
    let reads = 0;
    const event: DeviceEventSnapshot = {
      id: eventLocalId, calendarId: calendarLocalId, nativeEventId: 'native-event-1',
      occurrenceStart: new Date(Date.now() - 86_400_000 - 60_000).toISOString(), title: 'Spanning event', notes: '', notesTruncated: false,
      start: new Date(Date.now() - 86_400_000 - 60_000).toISOString(), end: new Date(Date.now() - 86_400_000 + 60 * 60_000).toISOString(),
      allDay: false, cancelled: false, observedAt: new Date().toISOString(), generation: 2,
    };
    const backend: DeviceCalendarBackend = {
      platform: 'mock',
      getPermission: vi.fn(async () => 'full_access' as const),
      requestFullPermission: vi.fn(async () => 'full_access' as const),
      listCalendars: vi.fn(async () => ({ calendars: [row], omitted: 0, discoveryTruncated: false })),
      getCalendar: vi.fn(async () => row),
      readEvents: vi.fn(async (_localId, _nativeId, window, observedAt, generation) => {
        reads += 1;
        if (reads === 1) firstWindowStart = Date.parse(window.timeMin);
        return { events: [{ ...event, start: new Date(firstWindowStart - 60_000).toISOString(),
          occurrenceStart: new Date(firstWindowStart - 60_000).toISOString(), end: new Date(firstWindowStart + 60 * 60_000).toISOString(),
          observedAt, generation }], scanned: 1, omitted: 0, duplicateRows: 0, conflicts: 0, partial: false };
      }),
      createApprovedEvent: vi.fn(async () => ({ status: 'unknown' as const })),
      lookupRecord: vi.fn(async () => ({ candidates: [], partial: false, identity: 'unverified' as const })),
    };
    const app = new AppControllerImpl(store, {}, { deviceCalendarBackend: backend });
    await app.load();
    await app.connectDeviceCalendars({ expectedGeneration: app.getSnapshot().deviceCalendars.generation });
    const connected = app.getSnapshot().deviceCalendars;
    await app.setDeviceCalendarSelection({ expectedGeneration: connected.generation, expectedSelectionRevision: connected.selectionRevision, calendarIds: [calendarLocalId] });
    const selected = app.getSnapshot().deviceCalendars;
    await app.refreshDeviceCalendars({ expectedGeneration: selected.generation, expectedSelectionRevision: selected.selectionRevision });
    await app.refreshDeviceCalendars({ expectedGeneration: selected.generation, expectedSelectionRevision: selected.selectionRevision });
    expect(reads).toBe(2);
    expect(app.getSnapshot().deviceCalendars.events).toHaveLength(1);
    expect(app.getSnapshot().deviceCalendars.events[0].nativeEventId).toBe('native-event-1');

    const restored = new AppControllerImpl(store, {}, { deviceCalendarBackend: backend });
    await restored.load();
    expect(restored.getSnapshot().deviceCalendars.events).toHaveLength(1);
    expect(restored.getSnapshot().deviceCalendarAccess.status).toBe('needs_check');
  });

  it('rejects first-saving a native-calendar reminder when event semantics change during permission UI', async () => {
    const store = new Store();
    const calendarLocalId = '33333333-3333-4333-8333-333333333333';
    const eventLocalId = '44444444-4444-4444-8444-444444444444';
    const row = createDeviceCalendarRow({ localId: calendarLocalId,
      dto: { nativeId: 'native-calendar-reminder', title: 'Personal', allowsModifications: true },
      fingerprint: 'b'.repeat(64), observedAt: new Date().toISOString() });
    let notes = 'Original private notes';
    let appRef: AppControllerImpl | undefined;
    const start = new Date(Date.now() + 30 * 60_000).toISOString();
    const end = new Date(Date.parse(start) + 60 * 60_000).toISOString();
    const nativeBackend: DeviceCalendarBackend = {
      platform: 'mock', getPermission: vi.fn(async () => 'full_access' as const),
      requestFullPermission: vi.fn(async () => 'full_access' as const),
      listCalendars: vi.fn(async () => ({ calendars: [row], omitted: 0, discoveryTruncated: false })),
      getCalendar: vi.fn(async () => row),
      readEvents: vi.fn(async (_localId, _nativeId, _window, observedAt, generation) => ({
        events: [{ id: eventLocalId, calendarId: calendarLocalId, nativeEventId: 'native-reminder-event', occurrenceStart: start,
          title: 'Planning meeting', notes, notesTruncated: false, start, end, timeZone: 'UTC', allDay: false, cancelled: false, observedAt, generation }],
        scanned: 1, omitted: 0, duplicateRows: 0, conflicts: 0, partial: false,
      })),
      createApprovedEvent: vi.fn(async () => ({ status: 'unknown' as const })),
      lookupRecord: vi.fn(async () => ({ candidates: [], partial: false, identity: 'unverified' as const })),
    };
    const notificationBackend: NotificationBackend = {
      platform: 'mock', getPermission: vi.fn(async () => 'undetermined' as const),
      requestPermission: vi.fn(async () => {
        notes = 'Changed notes while permission was open';
        const device = appRef!.getSnapshot().deviceCalendars;
        await appRef!.refreshDeviceCalendars({ expectedGeneration: device.generation, expectedSelectionRevision: device.selectionRevision });
        return 'authorized' as const;
      }),
      listPending: vi.fn(async () => []), schedule: vi.fn(async () => 'unexpected-schedule'), cancel: vi.fn(async () => undefined),
      cancelLegacy: vi.fn(async () => undefined), installForegroundHandler: vi.fn(async () => undefined),
    };
    const app = new AppControllerImpl(store, {}, { deviceCalendarBackend: nativeBackend, reminderBackend: notificationBackend });
    appRef = app;
    await app.load();
    await app.connectDeviceCalendars({ expectedGeneration: app.getSnapshot().deviceCalendars.generation });
    let device = app.getSnapshot().deviceCalendars;
    await app.setDeviceCalendarSelection({ expectedGeneration: device.generation, expectedSelectionRevision: device.selectionRevision, calendarIds: [calendarLocalId] });
    device = app.getSnapshot().deviceCalendars;
    await app.refreshDeviceCalendars({ expectedGeneration: device.generation, expectedSelectionRevision: device.selectionRevision });
    await app.saveProactiveRule({ name: 'Upcoming device meeting', enabled: true, accountIds: [], trigger: { type: 'meeting_soon', minutes: 60 } });
    const candidate = app.getSnapshot().proactive.candidates.find((entry) => entry.candidate.sourceId.includes('native-reminder-event'))?.candidate;
    expect(candidate).toBeDefined();
    const draft = await app.createReminderDraft({ candidateId: candidate!.id });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });

    await expect(app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision })).rejects.toThrow(/source changed|no longer current/i);
    expect(notificationBackend.schedule).not.toHaveBeenCalled();
    expect(app.getSnapshot().reminders.records.find((item) => item.id === approved.id)?.status).toBe('approved');
  });
});
