import { describe, expect, it, vi } from 'vitest';
import { createDeviceCalendarBackend, DeviceCalendarBackendError } from '../src/deviceCalendars';
import type { Proposal } from '../src/core';

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const localCalendarId = '123e4567-e89b-42d3-a456-426614174001';
const at = '2026-10-12T01:02:03.000Z';
const digest = 'b'.repeat(64);

function proposal(): Proposal {
  return {
    id: 'event-1', noteId: uuid, kind: 'event', title: 'Review', body: 'Discuss the launch.', status: 'approved', revision: 1,
    approvedRevision: 1, approvedPayloadDigest: digest, sourceActionKey: 'source-action',
    provenance: { version: 1, assistContractVersion: 'v1', analysisFingerprint: 'analysis', noteId: uuid, noteRevision: 2,
      capturedAt: at, captureTimeZone: 'UTC', intent: 'assist', sources: [{ sourceId: 'transcript', revision: 2, sourceVersion: `2:${digest}` }], policySources: [], settingsFingerprint: 'settings' },
    sourceRevision: 2, recipients: [], evidence: [{ quote: 'Schedule a review.' }],
    event: { title: 'Review', description: 'Discuss the launch.', start: '2026-10-14T09:00:00.000Z', end: '2026-10-14T10:00:00.000Z', timeZone: 'UTC', attendees: [], invitePolicy: 'none' },
  };
}

function expoModule(overrides: Record<string, unknown> = {}) {
  const event = { id: 'native-event', calendarId: 'native-calendar', title: 'Review', notes: 'Discuss the launch.', startDate: new Date('2026-10-14T09:00:00.000Z'), endDate: new Date('2026-10-14T10:00:00.000Z'), timeZone: 'UTC', allDay: false, status: 'confirmed' };
  const calendar = { id: 'native-calendar', title: 'Personal', source: { id: 'icloud', name: 'iCloud', type: 'local' }, allowsModifications: true, createEvent: vi.fn(async () => event) };
  return {
    EntityTypes: { EVENT: 'event' },
    getCalendarPermissions: vi.fn(async (writeOnly = false) => ({ status: writeOnly ? 'granted' : 'granted', granted: true, canAskAgain: true })),
    requestCalendarPermissions: vi.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true })),
    getCalendars: vi.fn(async () => [calendar]),
    listEvents: vi.fn(async () => []),
    ExpoCalendar: { get: vi.fn(async () => calendar) },
    __calendar: calendar,
    __event: event,
    ...overrides,
  };
}

const make = (module: unknown, platform: 'ios' | 'android' = 'ios') => createDeviceCalendarBackend({
  platform, loadCalendarModule: async () => module as never, sha256Hex: async () => 'c'.repeat(64),
  idFactory: () => uuid, now: () => new Date(at),
});

describe('lazy Expo device calendar backend', () => {
  it('does not load the native calendar module on unsupported platforms', async () => {
    const load = vi.fn(async () => expoModule() as never);
    const backend = createDeviceCalendarBackend({ platform: 'android', loadCalendarModule: load });
    expect(await backend.getPermission()).toBe('unavailable');
    expect(await backend.requestFullPermission()).toBe('unavailable');
    await expect(backend.listCalendars()).rejects.toMatchObject({ code: 'unavailable' });
    expect(load).not.toHaveBeenCalled();
  });

  it('distinguishes full, write-only, and denied access without inferring read access from listing', async () => {
    const module = expoModule({ getCalendarPermissions: vi.fn(async (writeOnly = false) => ({ status: writeOnly ? 'granted' : 'denied', granted: writeOnly, canAskAgain: false })) });
    const backend = make(module);
    expect(await backend.getPermission()).toBe('write_only');
    await expect(backend.listCalendars()).rejects.toMatchObject({ code: 'permission_denied' });
    expect(module.getCalendars).not.toHaveBeenCalled();
  });

  it('returns plain, bounded calendar/event snapshots from SDK methods', async () => {
    const module = expoModule({
      listEvents: vi.fn(async () => [
        { id: 'event-1', calendarId: 'native-calendar', title: 'Planning', notes: 'notes', startDate: '2026-10-14T09:00:00Z', endDate: '2026-10-14T10:00:00Z', allDay: false, status: 'confirmed' },
      ]),
    });
    const backend = make(module);
    const calendars = await backend.listCalendars();
    expect(calendars.calendars).toHaveLength(1);
    expect(calendars.calendars[0]).not.toHaveProperty('createEvent');
    const result = await backend.readEvents(localCalendarId, 'native-calendar', { timeMin: '2026-10-13T00:00:00.000Z', timeMax: '2026-10-15T00:00:00.000Z' }, at, 3);
    expect(result.events[0]).toMatchObject({ nativeEventId: 'event-1', calendarId: localCalendarId, start: '2026-10-14T09:00:00.000Z', generation: 3 });
    expect(module.listEvents).toHaveBeenCalledWith(['native-calendar'], new Date('2026-10-13T00:00:00.000Z'), new Date('2026-10-15T00:00:00.000Z'));
  });

  it('caps calendar discovery work and reports every omitted native row', async () => {
    const calendars = Array.from({ length: 2001 }, (_, index) => ({
      id: `calendar-${index}`, title: `Calendar ${index}`, source: { id: 'source', name: 'Local', type: 'local' }, allowsModifications: true,
    }));
    const module = expoModule({ getCalendars: vi.fn(async () => calendars) });
    let nextId = 0;
    const backend = createDeviceCalendarBackend({ platform: 'ios', loadCalendarModule: async () => module as never,
      sha256Hex: async () => 'c'.repeat(64), idFactory: () => `123e4567-e89b-42d3-a456-${String(nextId++).padStart(12, '0')}`, now: () => new Date(at) });
    const result = await backend.listCalendars();
    expect(result).toMatchObject({ omitted: 1901, discoveryTruncated: true });
    expect(result.calendars).toHaveLength(100);
  });

  it('keeps exact duplicate rows separate from conflicting recurring instances and never claims title/time lookup identity', async () => {
    const event = { id: 'same-event', calendarId: 'native-calendar', title: 'Review', notes: '', startDate: '2026-10-14T09:00:00Z', endDate: '2026-10-14T10:00:00Z', originalStartDate: '2026-10-14T08:00:00Z', allDay: false, status: 'confirmed' };
    const module = expoModule({ listEvents: vi.fn(async () => [event, { ...event }]) });
    const backend = make(module);
    const read = await backend.readEvents(localCalendarId, 'native-calendar', { timeMin: '2026-10-13T00:00:00.000Z', timeMax: '2026-10-15T00:00:00.000Z' }, at, 2);
    expect(read).toMatchObject({ duplicateRows: 1, conflicts: 0, omitted: 1, partial: true });
    const { createDeviceEventDispatchRecord, recordDeviceEventOutcome } = await import('../src/deviceCalendars');
    const pending = createDeviceEventDispatchRecord({ id: uuid, claimAt: at, proposal: proposal(), target: {
      installationId: uuid, generation: 2, selectionRevision: 3, calendarLocalId: localCalendarId,
      nativeId: 'native-calendar', fingerprint: 'c'.repeat(64), title: 'Personal', sourceLabel: 'iCloud',
    } });
    const saved = recordDeviceEventOutcome(pending, { outcome: 'saved', at: '2026-10-12T01:04:00.000Z', nativeEventId: 'same-event' });
    const lookup = await backend.lookupRecord(saved);
    expect(lookup).toMatchObject({ candidates: [], identity: 'unverified' });
  });

  it('runs the final synchronous guard after awaits and makes at most one native create call', async () => {
    const module = expoModule();
    const backend = make(module);
    const record = (await import('../src/deviceCalendars')).createDeviceEventDispatchRecord({
      id: uuid, claimAt: at, proposal: proposal(), target: { installationId: uuid, generation: 2, selectionRevision: 3,
        calendarLocalId: localCalendarId, nativeId: 'native-calendar', fingerprint: 'c'.repeat(64), title: 'Personal', sourceLabel: 'iCloud' },
    });
    const guard = vi.fn(() => true);
    const result = await backend.createApprovedEvent(record, guard);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(module.__calendar.createEvent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'saved', nativeEventId: 'native-event' });

    const blocked = await backend.createApprovedEvent(record, () => false).catch((error) => error);
    expect(blocked).toBeInstanceOf(DeviceCalendarBackendError);
    expect((blocked as DeviceCalendarBackendError).code).toBe('precondition_failed');
    expect(module.__calendar.createEvent).toHaveBeenCalledTimes(1);
  });

  it('rechecks full access after resolving the target and rejects a changed calendar fingerprint before creating', async () => {
    const module = expoModule();
    let checks = 0;
    module.getCalendarPermissions = vi.fn(async (writeOnly = false) => {
      checks++;
      const granted = checks === 1;
      return { status: granted ? 'granted' : 'denied', granted, canAskAgain: false };
    });
    const backend = make(module);
    const { createDeviceEventDispatchRecord } = await import('../src/deviceCalendars');
    const record = createDeviceEventDispatchRecord({ id: uuid, claimAt: at, proposal: proposal(), target: {
      installationId: uuid, generation: 2, selectionRevision: 3, calendarLocalId: localCalendarId,
      nativeId: 'native-calendar', fingerprint: 'c'.repeat(64), title: 'Personal', sourceLabel: 'iCloud',
    } });
    await expect(backend.createApprovedEvent(record, () => true)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(module.__calendar.createEvent).not.toHaveBeenCalled();

    const changedModule = expoModule({ ExpoCalendar: { get: vi.fn(async () => ({ ...module.__calendar, title: 'Changed' })) } });
    const changedBackend = createDeviceCalendarBackend({ platform: 'ios', loadCalendarModule: async () => changedModule as never,
      sha256Hex: async (canonical) => canonical.includes('Changed') ? 'd'.repeat(64) : 'c'.repeat(64), idFactory: () => uuid, now: () => new Date(at) });
    await expect(changedBackend.createApprovedEvent(record, () => true)).rejects.toMatchObject({ code: 'calendar_changed' });
    expect(changedModule.__calendar.createEvent).not.toHaveBeenCalled();
  });

  it('classifies a native exception after the create invocation as unknown, never retryable', async () => {
    const module = expoModule();
    module.__calendar.createEvent.mockRejectedValueOnce(new Error('native platform failure'));
    const backend = make(module);
    const record = (await import('../src/deviceCalendars')).createDeviceEventDispatchRecord({ id: uuid, claimAt: at, proposal: proposal(), target: {
      installationId: uuid, generation: 2, selectionRevision: 3, calendarLocalId: localCalendarId, nativeId: 'native-calendar', fingerprint: 'c'.repeat(64), title: 'Personal', sourceLabel: 'iCloud',
    } });
    expect(await backend.createApprovedEvent(record, () => true)).toEqual({ status: 'unknown' });
    expect(module.__calendar.createEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps the approved IANA zone despite localized SDK output and retains a safe ID after a shared-object getter fails', async () => {
    const module = expoModule();
    module.__calendar.createEvent.mockResolvedValueOnce({ ...module.__event, notes: null, timeZone: 'GMT+8' } as never);
    const backend = make(module);
    const { createDeviceEventDispatchRecord } = await import('../src/deviceCalendars');
    const emptyNotesProposal = proposal();
    emptyNotesProposal.body = '';
    emptyNotesProposal.event!.description = '';
    const record = createDeviceEventDispatchRecord({ id: uuid, claimAt: at, proposal: emptyNotesProposal, target: {
      installationId: uuid, generation: 2, selectionRevision: 3, calendarLocalId: localCalendarId,
      nativeId: 'native-calendar', fingerprint: 'c'.repeat(64), title: 'Personal', sourceLabel: 'iCloud',
    } });
    expect(await backend.createApprovedEvent(record, () => true)).toMatchObject({ status: 'saved', event: { notes: '', timeZone: 'UTC' } });

    const getterErrorEvent = { id: 'known-native-id', title: 'Review', notes: '', startDate: new Date('2026-10-14T09:00:00.000Z'), endDate: new Date('2026-10-14T10:00:00.000Z'), timeZone: 'UTC', allDay: false };
    Object.defineProperty(getterErrorEvent, 'calendarId', { get() { throw new Error('native getter failed'); } });
    module.__calendar.createEvent.mockResolvedValueOnce(getterErrorEvent as never);
    const timed = createDeviceEventDispatchRecord({ id: '123e4567-e89b-42d3-a456-426614174009', claimAt: at, proposal: proposal(), target: {
      installationId: uuid, generation: 2, selectionRevision: 3, calendarLocalId: localCalendarId,
      nativeId: 'native-calendar', fingerprint: 'c'.repeat(64), title: 'Personal', sourceLabel: 'iCloud',
    } });
    expect(await backend.createApprovedEvent(timed, () => true)).toEqual({ status: 'unknown', nativeEventId: 'known-native-id' });
  });

  it('reports recurring identity conflicts and caps retained events without hiding truncation', async () => {
    const conflict = { id: 'same-event', calendarId: 'native-calendar', title: 'Changed', notes: '', startDate: '2026-10-14T09:00:00Z', endDate: '2026-10-14T10:00:00Z', originalStartDate: '2026-10-14T09:00:00Z', allDay: false, status: 'confirmed' };
    const repeated = { ...conflict, title: 'Original' };
    const module = expoModule({ listEvents: vi.fn(async () => [repeated, conflict]) });
    const backend = make(module);
    const result = await backend.readEvents(localCalendarId, 'native-calendar', { timeMin: '2026-10-13T00:00:00.000Z', timeMax: '2026-10-15T00:00:00.000Z' }, at, 1);
    expect(result).toMatchObject({ events: [], conflicts: 1, omitted: 2, partial: true, duplicateRows: 0 });

    const many = Array.from({ length: 201 }, (_, index) => {
      const startDate = new Date(Date.parse('2026-10-14T09:00:00Z') + index * 60_000);
      return { ...repeated, id: `event-${index}`, startDate, endDate: new Date(startDate.valueOf() + 60_000) };
    });
    const manyModule = expoModule({ listEvents: vi.fn(async () => many) });
    const manyBackend = make(manyModule);
    const truncated = await manyBackend.readEvents(localCalendarId, 'native-calendar', { timeMin: '2026-10-13T00:00:00.000Z', timeMax: '2026-10-15T00:00:00.000Z' }, at, 1);
    expect(truncated).toMatchObject({ scanned: 201, omitted: 1, partial: true });
    expect(truncated.events).toHaveLength(200);
  });

  it('keeps a valid native event whose SDK timezone is an untrusted abbreviation but omits the timezone claim', async () => {
    const module = expoModule({ listEvents: vi.fn(async () => [{
      id: 'event-est', calendarId: 'native-calendar', title: 'Travel', notes: '', startDate: '2026-10-14T09:00:00Z',
      endDate: '2026-10-14T10:00:00Z', timeZone: 'EST', allDay: false, status: 'confirmed',
    }]) });
    const backend = make(module);
    const result = await backend.readEvents(localCalendarId, 'native-calendar', { timeMin: '2026-10-13T00:00:00.000Z', timeMax: '2026-10-15T00:00:00.000Z' }, at, 1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).not.toHaveProperty('timeZone');
  });
});
