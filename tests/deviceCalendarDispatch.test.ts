import { describe, expect, it, vi } from 'vitest';
import type { AppState, Proposal } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import {
  createDeviceCalendarRow,
  type DeviceCalendarBackend,
  type DeviceCalendarReadResult,
  type DeviceCalendarRow,
  type DeviceEventCreateResult,
} from '../src/deviceCalendars';

const calendarId = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const observedAt = '2026-10-13T00:00:00.000Z';
const fingerprint = 'a'.repeat(64);

class MemoryStore implements StateStore {
  value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeRows(count: number): DeviceCalendarRow[] {
  return Array.from({ length: count }, (_, index) => createDeviceCalendarRow({
    localId: calendarId(index + 1),
    dto: { nativeId: `native-calendar-${index + 1}`, title: `Calendar ${index + 1}`, sourceName: 'Local account', allowsModifications: true, timeZone: 'Asia/Singapore' },
    fingerprint, observedAt,
  }));
}

function emptyRead(observed: string, generation: number): DeviceCalendarReadResult {
  return { events: [], scanned: 0, omitted: 0, duplicateRows: 0, conflicts: 0, partial: false };
}

function makeBackend(rows: DeviceCalendarRow[], overrides: Partial<DeviceCalendarBackend> = {}) {
  let permission: 'full_access' | 'denied' = 'full_access';
  const backend: DeviceCalendarBackend = {
    platform: 'mock',
    getPermission: vi.fn(async () => permission),
    requestFullPermission: vi.fn(async () => 'full_access' as const),
    listCalendars: vi.fn(async () => ({ calendars: rows, omitted: 0, discoveryTruncated: false })),
    getCalendar: vi.fn(async (nativeId: string) => {
      const row = rows.find((item) => item.nativeId === nativeId);
      if (!row) throw new Error('Calendar missing');
      return row;
    }),
    readEvents: vi.fn(async (_localId, _nativeId, _window, at, generation) => emptyRead(at, generation)),
    createApprovedEvent: vi.fn(async (_record, beforeCreate) => {
      if (!beforeCreate()) throw new Error('Pre-create guard rejected this event.');
      return { status: 'saved', nativeEventId: 'saved-native-event' } as DeviceEventCreateResult;
    }),
    lookupRecord: vi.fn(async () => ({ candidates: [], partial: false, identity: 'unverified' as const })),
    ...overrides,
  };
  return { backend, setPermission: (value: 'full_access' | 'denied') => { permission = value; } };
}

async function setup(count = 1) {
  const rows = makeRows(count);
  const store = new MemoryStore();
  const { backend, setPermission } = makeBackend(rows);
  const app = new AppControllerImpl(store, {}, { deviceCalendarBackend: backend });
  await app.load();
  await app.saveSettings({ mode: 'preview', timezone: 'Asia/Singapore' });
  await app.connectDeviceCalendars({ expectedGeneration: app.getSnapshot().deviceCalendars.generation });
  const connected = app.getSnapshot().deviceCalendars;
  await app.setDeviceCalendarSelection({ expectedGeneration: connected.generation, expectedSelectionRevision: connected.selectionRevision,
    calendarIds: rows.map((row) => row.localId) });
  const note = await app.saveNote({
    transcript: 'Schedule a meeting with Morgan on November 3, 2026 from 10:00 AM to 10:30 AM to review the launch timeline.',
    capturedAt: observedAt, captureTimeZone: 'Asia/Singapore',
  });
  const generated = await app.processNote(note.id);
  const event = generated.find((proposal) => proposal.kind === 'event');
  if (!event?.provenance || event.provenance.version !== 1) throw new Error('Expected a note-derived event proposal with verifiable provenance.');
  const proposal = await app.editProposal(event.id, {
    title: 'Review the launch timeline with Morgan', body: 'Confirm the next milestones.',
    eventDestination: { kind: 'device_calendar', calendarId: rows[0]!.localId },
    event: { title: 'Review the launch timeline with Morgan', description: 'Confirm the next milestones.',
      start: '2026-11-03T02:00:00.000Z', end: '2026-11-03T02:30:00.000Z', timeZone: 'Asia/Singapore', attendees: [], invitePolicy: 'none' },
  }, { expectedRevision: event.revision });
  return { app, store, backend, rows, note, proposal, setPermission };
}

async function approve(app: AppControllerImpl, proposal: Proposal) {
  return app.approveProposal(proposal.id, { expectedRevision: proposal.revision });
}

describe('device calendar dispatch races and durable receipts', () => {
  it('keeps approval calendar preflight outside the mutation lock and rejects its stale result', async () => {
    const { app, backend, rows, proposal } = await setup();
    const preflightStarted = deferred<void>();
    const releasePreflight = deferred<DeviceCalendarRow>();
    vi.mocked(backend.getCalendar).mockImplementationOnce(async () => {
      preflightStarted.resolve();
      return releasePreflight.promise;
    });

    const approval = approve(app, proposal);
    await preflightStarted.promise;
    const edited = await app.editProposal(proposal.id, {
      title: 'Updated meeting title', body: 'Updated details.',
      event: { ...proposal.event!, title: 'Updated meeting title', description: 'Updated details.' },
    }, { expectedRevision: proposal.revision });
    expect(edited.revision).toBeGreaterThan(proposal.revision);
    releasePreflight.resolve(rows[0]!);
    await expect(approval).rejects.toThrow(/changed|review|approve/i);
    expect(app.getSnapshot().proposals.find((item) => item.id === proposal.id)?.status).toBe('draft');
  });

  it('keeps execution calendar preflight outside the mutation lock and rejects access revoked during it', async () => {
    const { app, backend, rows, proposal } = await setup();
    const approved = await approve(app, proposal);
    const preflightStarted = deferred<void>();
    const releasePreflight = deferred<DeviceCalendarRow>();
    vi.mocked(backend.getCalendar).mockImplementationOnce(async () => {
      preflightStarted.resolve();
      return releasePreflight.promise;
    });

    const execution = app.executeProposal(approved.id, { expectedRevision: approved.revision });
    await preflightStarted.promise;
    const before = app.getSnapshot().deviceCalendars;
    await app.disconnectDeviceCalendars({ expectedGeneration: before.generation });
    releasePreflight.resolve(rows[0]!);
    await expect(execution).rejects.toThrow(/access|changed|current/i);
    expect(backend.createApprovedEvent).not.toHaveBeenCalled();
  });

  it('rejects stale edit, approval, and execution revisions', async () => {
    const { app, proposal } = await setup();
    const oldRevision = proposal.revision;
    const edited = await app.editProposal(proposal.id, { body: 'A revised description.' }, { expectedRevision: oldRevision });
    await expect(app.editProposal(proposal.id, { body: 'Lost update.' }, { expectedRevision: oldRevision })).rejects.toThrow(/changed/i);
    await expect(app.approveProposal(proposal.id, { expectedRevision: oldRevision })).rejects.toThrow(/changed/i);
    const approved = await approve(app, edited);
    await expect(app.executeProposal(approved.id, { expectedRevision: oldRevision })).rejects.toThrow(/changed/i);
    expect(app.getSnapshot().deviceCalendars.dispatchRecords).toHaveLength(0);
  });

  it('persists an exact attendee-free pending claim before native I/O and rechecks the guard after a disconnect', async () => {
    const { app, store, backend, proposal } = await setup();
    const nativeEntry = deferred<void>();
    const releaseNative = deferred<void>();
    let nativeCreates = 0;
    vi.mocked(backend.createApprovedEvent).mockImplementationOnce(async (claim, beforeCreate) => {
      nativeEntry.resolve();
      await releaseNative.promise;
      if (!beforeCreate()) throw new Error('The native pre-create check rejected a stale claim.');
      nativeCreates += 1;
      return { status: 'saved', nativeEventId: 'should-not-exist' };
    });
    const approved = await approve(app, proposal);
    const execution = app.executeProposal(approved.id, { expectedRevision: approved.revision });
    await nativeEntry.promise;

    const persisted = await store.load();
    const claim = persisted?.deviceCalendars.dispatchRecords[0];
    expect(claim).toMatchObject({ outcome: 'pending', proposalId: proposal.id, payload: {
      title: 'Review the launch timeline with Morgan', notes: 'Confirm the next milestones.',
      attendees: [], invitePolicy: 'none', allDay: false, alarms: [],
    } });
    expect(Object.isFrozen(app.getSnapshot().deviceCalendars.dispatchRecords[0])).toBe(true);
    expect(claim?.sourceProvenance).toMatchObject({ version: 1, noteId: (await store.load())?.notes[0]?.id });

    const before = app.getSnapshot().deviceCalendars;
    await app.disconnectDeviceCalendars({ expectedGeneration: before.generation });
    releaseNative.resolve();
    await execution;
    expect(nativeCreates).toBe(0);
    expect(backend.createApprovedEvent).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().deviceCalendars.dispatchRecords[0]?.outcome).toBe('rejected');
  });

  it('rejects a stale source dependency at the final create guard', async () => {
    const { app, backend, note, proposal } = await setup();
    const nativeEntry = deferred<void>();
    const releaseNative = deferred<void>();
    let nativeCreates = 0;
    vi.mocked(backend.createApprovedEvent).mockImplementationOnce(async (_claim, beforeCreate) => {
      nativeEntry.resolve();
      await releaseNative.promise;
      if (!beforeCreate()) throw new Error('The native pre-create check rejected changed source data.');
      nativeCreates += 1;
      return { status: 'saved', nativeEventId: 'must-not-be-created' };
    });
    const approved = await approve(app, proposal);
    const execution = app.executeProposal(approved.id, { expectedRevision: approved.revision });
    await nativeEntry.promise;
    await app.updateTranscript(note.id, 'The meeting details changed after approval.');
    releaseNative.resolve();
    await execution;
    expect(nativeCreates).toBe(0);
    expect(app.getSnapshot().deviceCalendars.dispatchRecords[0]?.outcome).toBe('rejected');
  });

  it('marks a 30-second timeout unknown, preserves the timeout observation, and accepts a late saved callback after disconnect', async () => {
    const { app, backend, proposal } = await setup();
    const nativeEntry = deferred<void>();
    const nativeResult = deferred<DeviceEventCreateResult>();
    vi.mocked(backend.createApprovedEvent).mockImplementationOnce(async () => {
      nativeEntry.resolve();
      return nativeResult.promise;
    });
    const approved = await approve(app, proposal);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(observedAt));
      const execution = app.executeProposal(approved.id, { expectedRevision: approved.revision });
      await nativeEntry.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      await execution;
      const timedOut = app.getSnapshot().deviceCalendars.dispatchRecords[0]!;
      expect(timedOut.outcome).toBe('unknown');
      expect(timedOut.nativeOutcomeObservations).toMatchObject([{ outcome: 'unknown', source: 'timeout' }]);

      await app.disconnectDeviceCalendars({ expectedGeneration: app.getSnapshot().deviceCalendars.generation });
      nativeResult.resolve({ status: 'saved', nativeEventId: 'late-saved-id' });
      await vi.waitFor(() => expect(app.getSnapshot().deviceCalendars.dispatchRecords[0]?.outcome).toBe('saved'));
      const saved = app.getSnapshot().deviceCalendars.dispatchRecords[0]!;
      expect(saved.nativeEventId).toBe('late-saved-id');
      expect(saved.nativeOutcomeObservations).toMatchObject([
        { outcome: 'unknown', source: 'timeout' },
        { outcome: 'saved', source: 'native_callback', nativeEventId: 'late-saved-id' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a late unknown native ID safely without converting it to a saved receipt', async () => {
    const { app, backend, proposal } = await setup();
    const nativeEntry = deferred<void>();
    const nativeResult = deferred<DeviceEventCreateResult>();
    vi.mocked(backend.createApprovedEvent).mockImplementationOnce(async () => {
      nativeEntry.resolve();
      return nativeResult.promise;
    });
    const approved = await approve(app, proposal);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(observedAt));
      const execution = app.executeProposal(approved.id, { expectedRevision: approved.revision });
      await nativeEntry.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      await execution;
      nativeResult.resolve({ status: 'unknown', nativeEventId: 'late-unverified-id' });
      await vi.waitFor(() => expect(app.getSnapshot().deviceCalendars.dispatchRecords[0]?.nativeOutcomeObservations?.length).toBe(2));
      const record = app.getSnapshot().deviceCalendars.dispatchRecords[0]!;
      expect(record.outcome).toBe('unknown');
      expect(record.nativeEventId).toBe('late-unverified-id');
      expect(record.nativeOutcomeObservations).toMatchObject([
        { outcome: 'unknown', source: 'timeout' },
        { outcome: 'unknown', source: 'native_callback', nativeEventId: 'late-unverified-id' },
      ]);
      await expect(app.executeProposal(approved.id, { expectedRevision: approved.revision })).rejects.toThrow(/approve|cannot|again|receipt|unknown/i);
      expect(backend.createApprovedEvent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('converts a persisted pending claim to unknown on restart without another native call', async () => {
    const { app, store, backend, proposal } = await setup();
    const nativeEntry = deferred<void>();
    const nativeResult = deferred<DeviceEventCreateResult>();
    vi.mocked(backend.createApprovedEvent).mockImplementationOnce(async () => {
      nativeEntry.resolve();
      return nativeResult.promise;
    });
    const approved = await approve(app, proposal);
    const originalExecution = app.executeProposal(approved.id, { expectedRevision: approved.revision });
    await nativeEntry.promise;
    expect((await store.load())?.deviceCalendars.dispatchRecords[0]?.outcome).toBe('pending');

    const recovered = new AppControllerImpl(store, {}, { deviceCalendarBackend: backend });
    await recovered.load();
    expect(recovered.getSnapshot().deviceCalendars.dispatchRecords[0]).toMatchObject({
      outcome: 'unknown', nativeOutcomeObservations: [{ outcome: 'unknown', source: 'restart_recovery' }],
    });
    expect((await store.load())?.deviceCalendars.dispatchRecords[0]).toMatchObject({
      outcome: 'unknown', nativeOutcomeObservations: [{ outcome: 'unknown', source: 'restart_recovery' }],
    });
    await expect(recovered.executeProposal(approved.id, { expectedRevision: approved.revision })).rejects.toThrow();
    expect(backend.createApprovedEvent).toHaveBeenCalledTimes(1);
    nativeResult.resolve({ status: 'unknown' });
    await originalExecution;
  });

  it('keeps a saved receipt terminal after human attestation and never creates again', async () => {
    const { app, backend, proposal } = await setup();
    const approved = await approve(app, proposal);
    const executed = await app.executeProposal(approved.id, { expectedRevision: approved.revision });
    expect(executed.status).toBe('accepted');
    const original = app.getSnapshot().deviceCalendars.dispatchRecords[0]!;
    expect(original.outcome).toBe('saved');
    const attested = await app.reconcileDeviceEventDispatch(original.id, {
      disposition: 'confirmed_present', note: 'I verified the event in the local calendar.', nativeEventId: 'saved-native-event',
    });
    expect(attested.outcome).toBe('saved');
    expect(attested.nativeEventId).toBe('saved-native-event');
    expect(attested.reconciliations).toHaveLength(1);
    await expect(app.executeProposal(approved.id, { expectedRevision: approved.revision })).rejects.toThrow(/approve|cannot|again|receipt|already/i);
    expect(backend.createApprovedEvent).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().deviceCalendars.dispatchRecords[0]?.outcome).toBe('saved');
  });
});

describe('device calendar bounded refresh dispatch', () => {
  it('reads at most four selected calendars per call and continues with the same fixed window', async () => {
    const rows = makeRows(5);
    const store = new MemoryStore();
    const { backend } = makeBackend(rows);
    const app = new AppControllerImpl(store, {}, { deviceCalendarBackend: backend });
    await app.load();
    await app.connectDeviceCalendars({ expectedGeneration: app.getSnapshot().deviceCalendars.generation });
    let state = app.getSnapshot().deviceCalendars;
    await app.setDeviceCalendarSelection({ expectedGeneration: state.generation, expectedSelectionRevision: state.selectionRevision, calendarIds: rows.map((row) => row.localId) });
    state = app.getSnapshot().deviceCalendars;

    const first = await app.refreshDeviceCalendars({ expectedGeneration: state.generation, expectedSelectionRevision: state.selectionRevision });
    expect(backend.readEvents).toHaveBeenCalledTimes(4);
    expect(first.readRun?.cursor).toBe(4);
    const firstWindows = vi.mocked(backend.readEvents).mock.calls.map((call) => call[2]);
    const completed = await app.refreshDeviceCalendars({ expectedGeneration: state.generation, expectedSelectionRevision: state.selectionRevision,
      continueRunId: first.readRun!.runId });
    expect(backend.readEvents).toHaveBeenCalledTimes(5);
    expect(completed.readRun?.cursor).toBe(5);
    expect(completed.readRun?.completedCalendarIds).toEqual(rows.map((row) => row.localId));
    expect(vi.mocked(backend.readEvents).mock.calls[4]?.[2]).toEqual(firstWindows[0]);
  });

  it('discards a page if calendar metadata changes during its read', async () => {
    const rows = makeRows(1);
    const store = new MemoryStore();
    const readStarted = deferred<void>();
    const releaseRead = deferred<DeviceCalendarReadResult>();
    const { backend } = makeBackend(rows, {
      readEvents: vi.fn(async (_localId, _nativeId, _window, at, generation) => {
        readStarted.resolve();
        return releaseRead.promise;
      }),
    });
    const app = new AppControllerImpl(store, {}, { deviceCalendarBackend: backend });
    await app.load();
    await app.connectDeviceCalendars({ expectedGeneration: app.getSnapshot().deviceCalendars.generation });
    let state = app.getSnapshot().deviceCalendars;
    await app.setDeviceCalendarSelection({ expectedGeneration: state.generation, expectedSelectionRevision: state.selectionRevision, calendarIds: [rows[0]!.localId] });
    state = app.getSnapshot().deviceCalendars;
    vi.mocked(backend.getCalendar).mockImplementationOnce(async (_nativeId, previous) => previous!);
    const refresh = app.refreshDeviceCalendars({ expectedGeneration: state.generation, expectedSelectionRevision: state.selectionRevision });
    await readStarted.promise;
    vi.mocked(backend.getCalendar).mockImplementationOnce(async (_nativeId, previous) => createDeviceCalendarRow({
      localId: previous!.localId, dto: { nativeId: previous!.nativeId, title: 'Renamed while reading', allowsModifications: true, timeZone: 'Asia/Singapore' },
      fingerprint: 'b'.repeat(64), observedAt,
    }));
    releaseRead.resolve(emptyRead(observedAt, state.generation));
    await expect(refresh).rejects.toThrow(/changed|discarded/i);
    expect(app.getSnapshot().deviceCalendars.events).toEqual([]);
    expect(app.getSnapshot().deviceCalendars.selectionRevision).toBeGreaterThan(state.selectionRevision);
  });

  it('discards a page and revokes the selection when access is lost during its read', async () => {
    const rows = makeRows(1);
    const store = new MemoryStore();
    const readStarted = deferred<void>();
    const releaseRead = deferred<DeviceCalendarReadResult>();
    let permission: 'full_access' | 'denied' = 'full_access';
    const { backend } = makeBackend(rows, {
      getPermission: vi.fn(async () => permission),
      readEvents: vi.fn(async (_localId, _nativeId, _window, at, generation) => {
        readStarted.resolve();
        return releaseRead.promise;
      }),
    });
    const app = new AppControllerImpl(store, {}, { deviceCalendarBackend: backend });
    await app.load();
    await app.connectDeviceCalendars({ expectedGeneration: app.getSnapshot().deviceCalendars.generation });
    let state = app.getSnapshot().deviceCalendars;
    await app.setDeviceCalendarSelection({ expectedGeneration: state.generation, expectedSelectionRevision: state.selectionRevision, calendarIds: [rows[0]!.localId] });
    state = app.getSnapshot().deviceCalendars;
    const refresh = app.refreshDeviceCalendars({ expectedGeneration: state.generation, expectedSelectionRevision: state.selectionRevision });
    await readStarted.promise;
    permission = 'denied';
    releaseRead.resolve(emptyRead(observedAt, state.generation));
    await expect(refresh).rejects.toThrow(/access|selection|changed|refresh/i);
    expect(app.getSnapshot().deviceCalendars.events).toEqual([]);
    expect(app.getSnapshot().deviceCalendars.selectedCalendarIds).toEqual([]);
    expect(app.getSnapshot().deviceCalendarAccess.status).toBe('denied');
  });
});
