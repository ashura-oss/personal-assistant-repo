import { describe, expect, it, vi } from 'vitest';
import type { AppState, Proposal } from '../src/core';
import { buildOfflinePreview } from '../src/assistant';
import { createPortableBackup, parsePortableBackup } from '../src/backup';
import { createDeviceCalendarRow, createDeviceEventDispatchRecord, type DeviceCalendarBackend, type DeviceCalendarRow, type DeviceEventSnapshot } from '../src/deviceCalendars';
import { emptyKnowledgeState } from '../src/knowledge';
import { buildProactiveSources } from '../src/proactive/adapters';
import { evaluateProactive, validateProactiveSource, type ProactiveRule } from '../src/proactive';
import { emptyProactiveMailAlertState } from '../src/proactiveMailAlerts/state';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';

const calendarId = '11111111-1111-4111-8111-111111111111';
const now = Date.now();
const observedAt = new Date(now).toISOString();
const digest = 'a'.repeat(64);

class MemoryStore implements StateStore {
  value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

function calendarRow(localId = calendarId): DeviceCalendarRow {
  return createDeviceCalendarRow({ localId, dto: { nativeId: `native-${localId}`, title: 'Work', allowsModifications: true }, fingerprint: digest, observedAt });
}

function nativeEvent(overrides: Partial<DeviceEventSnapshot> = {}): DeviceEventSnapshot {
  const start = new Date(now + 60 * 60_000).toISOString();
  return {
    id: 'local-event', calendarId, nativeEventId: 'native-event', occurrenceStart: start,
    title: 'Planning meeting', notes: '', notesTruncated: false, start, end: new Date(now + 2 * 60 * 60_000).toISOString(),
    allDay: false, cancelled: false, observedAt, generation: 2, ...overrides,
  };
}

function backendFor(read: DeviceCalendarBackend['readEvents'], permission: () => Promise<'full_access' | 'denied'> = async () => 'full_access') : DeviceCalendarBackend {
  const row = calendarRow();
  return {
    platform: 'mock',
    getPermission: vi.fn(permission),
    requestFullPermission: vi.fn(async () => 'full_access' as const),
    listCalendars: vi.fn(async () => ({ calendars: [row], omitted: 0, discoveryTruncated: false })),
    getCalendar: vi.fn(async () => row),
    readEvents: read,
    createApprovedEvent: vi.fn(async () => ({ status: 'unknown' as const })),
    lookupRecord: vi.fn(async () => ({ candidates: [], partial: false, identity: 'unverified' as const })),
  };
}

async function connectedApp(read: DeviceCalendarBackend['readEvents'], permission?: () => Promise<'full_access' | 'denied'>) {
  const store = new MemoryStore();
  const backend = backendFor(read, permission);
  const app = new AppControllerImpl(store, {}, { deviceCalendarBackend: backend });
  await app.load();
  await app.connectDeviceCalendars({ expectedGeneration: app.getSnapshot().deviceCalendars.generation });
  const device = app.getSnapshot().deviceCalendars;
  await app.setDeviceCalendarSelection({ expectedGeneration: device.generation, expectedSelectionRevision: device.selectionRevision, calendarIds: [calendarId] });
  return { app, store, backend };
}

async function answer(app: AppControllerImpl, question: string) {
  const note = await app.saveNote({ transcript: 'Calendar question.' });
  return app.assistNote(note.id, { intent: 'answer', question });
}

function proactiveState(overrides: Partial<DeviceEventSnapshot>[] = []): AppState {
  const state = {
    notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [], settings: {} as AppState['settings'], usage: {} as AppState['usage'],
    mailbox: [], selectedMailTexts: [], calendarEvents: [], transcription: { schemaVersion: 1, installationUUID: '22222222-2222-4222-8222-222222222223', attempts: [], cleanupLeases: [] }, syncStates: {}, pendingCredentialCleanup: [], dispatchRecords: [], mailboxSchemaVersion: 2,
    deviceCalendars: {
      schemaVersion: 1 as const, installationId: '22222222-2222-4222-8222-222222222222', generation: 2, selectionRevision: 3, enabled: true,
      selectedCalendarIds: [calendarId], calendars: [calendarRow()], events: overrides.map((row) => nativeEvent(row)),
      readRun: { runId: '33333333-3333-4333-8333-333333333333', generation: 2, selectionRevision: 3,
        window: { timeMin: new Date(now - 86_400_000).toISOString(), timeMax: new Date(now + 14 * 86_400_000).toISOString() },
        selectedCalendarIds: [calendarId], cursor: 1, startedAt: observedAt, completedCalendarIds: [calendarId], partial: false, truncatedCalendars: 0, truncatedEvents: 0 },
      dispatchRecords: [],
    },
    deviceCalendarAccess: { status: 'full_access' as const, checkedAt: observedAt },
    proactive: { schemaVersion: 1 as const, rules: [], candidates: [], dismissals: [], snoozes: [] }, importedBackups: [],
    proactiveMailAlerts: emptyProactiveMailAlertState('44444444-4444-4444-8444-444444444444'),
    knowledge: emptyKnowledgeState(), reminders: { schemaVersion: 1 as const, installationId: '44444444-4444-4444-8444-444444444444', generation: 1, records: [], intents: [], dispatchRecords: [] },
  } as AppState;
  return state;
}

const meetingRule = (accountIds: string[] = []): ProactiveRule => ({ id: 'meeting-rule', revision: 1, enabled: true, accountIds,
  trigger: { type: 'meeting_soon', minutes: 30 } });

async function sourcesFor(state: AppState) {
  return buildProactiveSources(state, [], now, new Map(), async (value) => {
    // A deterministic test digest that changes whenever canonical content changes.
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
  });
}

describe('native calendar source boundaries', () => {
  it('uses a complete selected native snapshot for answers and never treats partial past-only coverage as empty', async () => {
    const full = await connectedApp(async (_localId, _nativeId, _window, at, generation) => ({
      events: [{ ...nativeEvent(), observedAt: at, generation }], scanned: 1, omitted: 0, duplicateRows: 0, conflicts: 0, partial: false,
    }));
    await full.app.refreshDeviceCalendars({ expectedGeneration: full.app.getSnapshot().deviceCalendars.generation,
      expectedSelectionRevision: full.app.getSnapshot().deviceCalendars.selectionRevision });
    const completeAnswer = await answer(full.app, 'What meetings are upcoming?');
    expect(completeAnswer.answer).toContain('Planning meeting');
    expect(completeAnswer.answer).toContain('on-device calendar snapshot');

    const partial = await connectedApp(async (_localId, _nativeId, _window, at, generation) => {
      const pastStart = new Date(now - 60 * 60_000).toISOString();
      return { events: [{ ...nativeEvent(), occurrenceStart: pastStart, start: pastStart, end: new Date(now - 30 * 60_000).toISOString(), observedAt: at, generation }],
        scanned: 1, omitted: 1, duplicateRows: 0, conflicts: 0, partial: true };
    });
    await partial.app.refreshDeviceCalendars({ expectedGeneration: partial.app.getSnapshot().deviceCalendars.generation,
      expectedSelectionRevision: partial.app.getSnapshot().deviceCalendars.selectionRevision });
    const partialAnswer = await answer(partial.app, 'What meetings are upcoming?');
    expect(partialAnswer.answer).not.toMatch(/No upcoming events/i);
    expect(partialAnswer.answer).toMatch(/partial|can’t confirm|cannot confirm/i);
  });

  it('does not claim an empty result after previously nonempty or empty native coverage goes stale', async () => {
    for (const priorEvents of [[nativeEvent()], []] as const) {
      let permission: 'full_access' | 'denied' = 'full_access';
      const connected = await connectedApp(async (_localId, _nativeId, _window, at, generation) => ({
        events: priorEvents.map((event) => ({ ...event, observedAt: at, generation })), scanned: priorEvents.length, omitted: 0,
        duplicateRows: 0, conflicts: 0, partial: false,
      }), async () => permission);
      await connected.app.refreshDeviceCalendars({ expectedGeneration: connected.app.getSnapshot().deviceCalendars.generation,
        expectedSelectionRevision: connected.app.getSnapshot().deviceCalendars.selectionRevision });
      permission = 'denied';
      await connected.app.checkDeviceCalendarAccess();
      const staleAnswer = await answer(connected.app, 'What meetings are upcoming?');
      expect(staleAnswer.answer).not.toMatch(/No upcoming events/i);
      expect(staleAnswer.answer).toMatch(/can’t verify current calendar events/i);
    }
  });

  it('does not infer a precise date for an all-day event whose native time zone is missing', () => {
    const preview = buildOfflinePreview({ intent: 'answer', question: 'What meetings are upcoming?', transcript: '', timeZone: 'Asia/Singapore',
      now: observedAt, deviceCalendarSnapshotAvailable: true,
      deviceCalendarEvents: [{ subject: 'Public holiday', start: `${new Date(now + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`, allDay: true }] });
    expect(preview.answer).toMatch(/can’t verify an all-day event date/i);
    expect(preview.answer).not.toContain('Public holiday at');
    expect(preview.clarifications).toContain('Check the event’s date and time zone in the device calendar.');
  });

  it('only evaluates fresh selected timed native meetings, applies account scope, and keys recurring occurrences separately', async () => {
    const occurrence = new Date(now + 10 * 60_000).toISOString();
    const state = proactiveState([
      { nativeEventId: 'same-native-id', occurrenceStart: occurrence, start: occurrence, end: new Date(now + 20 * 60_000).toISOString() },
      { id: 'second-row', nativeEventId: 'same-native-id', occurrenceStart: new Date(now + 15 * 60_000).toISOString(), start: new Date(now + 15 * 60_000).toISOString(), end: new Date(now + 25 * 60_000).toISOString() },
      { id: 'all-day', nativeEventId: 'all-day', allDay: true },
      { id: 'cancelled', nativeEventId: 'cancelled', cancelled: true },
      { id: 'stale', nativeEventId: 'stale', observedAt: new Date(now - 20 * 60_000).toISOString() },
      { id: 'unselected', nativeEventId: 'unselected', calendarId: '55555555-5555-4555-8555-555555555555' },
    ]);
    const built = await sourcesFor(state);
    const nativeMeetings = built.sources.filter((source) => source.namespace === 'device_calendar');
    const result = evaluateProactive({ nowUtc: observedAt, timeZone: 'UTC', rules: [meetingRule()], sources: built.sources });
    expect(nativeMeetings.filter((source) => source.freshness === 'fresh' && source.availability === 'available')).toHaveLength(2);
    expect(result.activeCandidates.filter((candidate) => candidate.namespace === 'device_calendar')).toHaveLength(2);
    expect(new Set(result.activeCandidates.filter((candidate) => candidate.namespace === 'device_calendar').map((candidate) => candidate.sourceId)).size).toBe(2);
    expect(evaluateProactive({ nowUtc: observedAt, timeZone: 'UTC', rules: [meetingRule(['account-1'])], sources: built.sources }).activeCandidates).toEqual([]);
    for (const source of nativeMeetings) {
      expect(source).not.toHaveProperty('accountId');
      expect(() => validateProactiveSource(source)).not.toThrow();
      if (source.kind === 'meeting') expect(source.deviceBinding).toMatchObject({ installationId: state.deviceCalendars.installationId, calendarId });
    }
  });

  it('keeps proactive source versions stable across observation refreshes and changes them with event content', async () => {
    const originalState = proactiveState([{}]);
    const first = await sourcesFor(originalState);
    const refreshedState = structuredClone(originalState);
    refreshedState.deviceCalendars.events[0]!.observedAt = new Date(now - 60_000).toISOString();
    const refreshed = await sourcesFor(refreshedState);
    const changedState = structuredClone(originalState);
    changedState.deviceCalendars.events[0]!.title = 'Changed meeting details';
    const changed = await sourcesFor(changedState);
    expect(refreshed.sources[0]?.sourceVersion).toBe(first.sources[0]?.sourceVersion);
    expect(changed.sources[0]?.sourceVersion).not.toBe(first.sources[0]?.sourceVersion);
    expect(first.sources[0]).not.toHaveProperty('accountId');
  });

  it('exports native knowledge links and device event receipts as inert history without restoring native authority', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'A local note for the export.' });
    const proposal: Proposal = {
      id: 'proposal-1', noteId: note.id, kind: 'event', title: 'Planning', body: 'Discuss launch timing.', status: 'approved', revision: 1,
      approvedRevision: 1, approvedPayloadDigest: digest, sourceActionKey: 'action-key', sourceRevision: note.revision, recipients: [], evidence: [],
      provenance: { version: 1, assistContractVersion: 'assist-v1', analysisFingerprint: 'x'.repeat(700), noteId: note.id, noteRevision: note.revision,
        capturedAt: observedAt, captureTimeZone: 'UTC', intent: 'assist', sources: [{ sourceId: 'transcript', revision: note.revision, sourceVersion: `1:${digest}` }], policySources: [], settingsFingerprint: 'settings' },
      requiresRebuild: false, event: { title: 'Planning', description: 'Discuss launch timing.', start: new Date(now + 60 * 60_000).toISOString(), end: new Date(now + 2 * 60 * 60_000).toISOString(), timeZone: 'UTC', attendees: [], invitePolicy: 'none' },
    };
    const row = calendarRow();
    const deviceRecord = createDeviceEventDispatchRecord({ id: '66666666-6666-4666-8666-666666666666', claimAt: observedAt, proposal,
      target: { installationId: '77777777-7777-4777-8777-777777777777', generation: 2, selectionRevision: 3, calendarLocalId: calendarId,
        nativeId: 'private-native-calendar-id', fingerprint: digest, title: 'Work', sourceLabel: 'iCloud' } });
    const state = structuredClone(app.getSnapshot());
    state.deviceCalendars = { schemaVersion: 1, installationId: '77777777-7777-4777-8777-777777777777', generation: 2, selectionRevision: 3,
      enabled: true, selectedCalendarIds: [calendarId], calendars: [row], events: [nativeEvent()], dispatchRecords: [deviceRecord] };
    state.deviceCalendarAccess = { status: 'full_access', checkedAt: observedAt };
    state.knowledge.people.push({ id: '88888888-8888-4888-8888-888888888888', revision: 1, name: 'Ari', aliases: [],
      narrativePath: 'people/88888888-8888-4888-8888-888888888888.md', createdAt: observedAt, updatedAt: observedAt, facts: [], contacts: [],
      sourceLinks: [{ id: '99999999-9999-4999-8999-999999999999', provenance: 'user_authored', createdAt: observedAt,
        reference: { kind: 'device_calendar_event', installationId: state.deviceCalendars.installationId, generation: 2, calendarId, eventId: 'private-native-event-id', occurrenceStart: nativeEvent().occurrenceStart },
        label: 'Planning meeting' }],
    });
    const exported = JSON.stringify(createPortableBackup(state, { exportId: 'portable-native-calendar', exportedAt: observedAt }));
    const portable = parsePortableBackup(exported).backup;
    const link = portable.knowledge.state.people[0]!.sourceLinks[0]!;
    expect(link.reference).toEqual({ kind: 'historical', label: 'Planning meeting', originalKind: 'device_calendar_event' });
    const receipt = portable.history.find((item) => item.sourceId === `device-dispatch:${deviceRecord.id}`)!;
    expect(receipt).toMatchObject({ kind: 'dispatch', provider: 'on-device calendar', status: 'pending (unverified imported device history)' });
    expect(receipt.content).toContain('Event: Planning');
    expect(exported).not.toContain('private-native-calendar-id');
    expect(exported).not.toContain('private-native-event-id');
    expect(exported).not.toContain(state.deviceCalendars.installationId);

    const destination = new AppControllerImpl(new MemoryStore());
    await destination.load();
    const preview = await destination.prepareBackupImport(exported);
    await destination.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    expect(destination.getSnapshot().deviceCalendars.selectedCalendarIds).toEqual([]);
    expect(destination.getSnapshot().deviceCalendars.calendars).toEqual([]);
    expect(destination.getSnapshot().deviceCalendars.events).toEqual([]);
    expect(destination.getSnapshot().deviceCalendars.dispatchRecords).toEqual([]);
    expect(destination.getSnapshot().deviceCalendarAccess.status).toBe('needs_check');
    expect(destination.getSnapshot().proposals).toEqual([]);
    const imported = parsePortableBackup(exported).backup;
    expect(JSON.stringify(imported)).not.toContain('private-native-calendar-id');
    expect(JSON.stringify(imported)).not.toContain('private-native-event-id');
  });
});
