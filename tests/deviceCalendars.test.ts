import { describe, expect, it } from 'vitest';
import {
  appendDeviceEventReconciliation, createDeviceCalendarRow, createDeviceEventDispatchRecord,
  fingerprintDeviceCalendar, normalizeDeviceCalendar, recordDeviceEventOutcome,
  validateDeviceCalendarReadWindow, validateDeviceCalendarState, validateDeviceEventDispatchRecord,
} from '../src/deviceCalendars';
import type { Proposal } from '../src/core';

const id = '123e4567-e89b-42d3-a456-426614174000';
const noteId = '123e4567-e89b-42d3-a456-426614174001';
const calendarId = '123e4567-e89b-42d3-a456-426614174002';
const at = '2026-10-12T01:02:03.000Z';
const digest = 'a'.repeat(64);

function eventProposal(overrides: Partial<Proposal> = {}): Proposal {
  const provenance = {
    version: 1 as const, assistContractVersion: 'assist-v1', analysisFingerprint: 'x'.repeat(700), noteId, noteRevision: 3,
    capturedAt: at, captureTimeZone: 'Asia/Singapore', intent: 'assist' as const,
    sources: [{ sourceId: 'transcript', revision: 3, sourceVersion: `3:${digest}` }, { sourceId: 'device-calendar:planning', revision: 0, sourceVersion: `0:${digest}` }],
    policySources: [], settingsFingerprint: 'settings',
  };
  return {
    id: 'proposal-event', noteId, kind: 'event', title: 'Planning', body: 'Discuss launch timing.', status: 'approved', revision: 2,
    approvedRevision: 2, approvedPayloadDigest: digest, sourceActionKey: 'action-key', provenance, requiresRebuild: false,
    sourceRevision: 3, recipients: [], evidence: [{ quote: 'Plan a launch meeting.' }],
    event: { title: 'Planning', description: 'Discuss launch timing.', start: '2026-10-14T01:00:00.000Z', end: '2026-10-14T02:00:00.000Z', timeZone: 'UTC', attendees: [], invitePolicy: 'none' },
    ...overrides,
  };
}

const target = { installationId: id, generation: 2, selectionRevision: 4, calendarLocalId: calendarId, nativeId: 'native-calendar', fingerprint: digest, title: 'Personal', sourceLabel: 'iCloud' };

describe('device calendar domain contracts', () => {
  it('normalizes malformed native labels without guessing and hashes canonical calendar identity fields', async () => {
    const dto = normalizeDeviceCalendar({ id: 'native-calendar', title: '  Personal\u0000 ', source: { id: 'source', name: 'iCloud', type: 'local' }, allowsModifications: true });
    expect(dto).toMatchObject({ nativeId: 'native-calendar', title: 'Personal', sourceName: 'iCloud', allowsModifications: true, titleOmitted: false });
    const row = createDeviceCalendarRow({ localId: calendarId, dto, fingerprint: digest, observedAt: at });
    expect(Object.isFrozen(row)).toBe(true);
    expect(await fingerprintDeviceCalendar(dto, async () => digest)).toBe(digest);
    expect(normalizeDeviceCalendar({ id: 'native-short-zone', title: 'Travel', timeZone: 'GMT+8', allowsModifications: true })).not.toHaveProperty('timeZone');
  });

  it('keeps the exact approved event payload frozen and rejects invitations or unsupported fields', () => {
    const record = createDeviceEventDispatchRecord({ id, claimAt: at, proposal: eventProposal(), target });
    expect(record.payload).toMatchObject({ title: 'Planning', notes: 'Discuss launch timing.', allDay: false, invitePolicy: 'none', attendees: [], alarms: [] });
    expect(Object.isFrozen(record.payload)).toBe(true);
    expect(() => createDeviceEventDispatchRecord({ id, claimAt: at, proposal: eventProposal({ event: { ...eventProposal().event!, attendees: ['guest@example.test'], invitePolicy: 'send' } }), target })).toThrow(/attendees|invitations/i);
    expect(() => createDeviceEventDispatchRecord({ id, claimAt: at, proposal: eventProposal({ event: { ...eventProposal().event!, location: 'room 1' } as never }), target })).toThrow(/unsupported fields/i);
  });

  it('preserves terminal outcomes through append-only reconciliation and rejects oversized windows', () => {
    const record = createDeviceEventDispatchRecord({ id, claimAt: at, proposal: eventProposal(), target });
    const unknown = recordDeviceEventOutcome(record, { outcome: 'unknown', at: '2026-10-12T01:03:03.000Z', observationSource: 'native_callback' });
    const reconciled = appendDeviceEventReconciliation(unknown, { id: calendarId, disposition: 'not_found', at: '2026-10-12T01:04:03.000Z', note: 'Reviewed manually.' });
    expect(reconciled.outcome).toBe('unknown');
    expect(() => recordDeviceEventOutcome(reconciled, { outcome: 'rejected', at: '2026-10-12T01:05:03.000Z', errorCode: 'precondition_failed' })).toThrow(/immutable/i);
    expect(() => validateDeviceEventDispatchRecord({ ...record, target: { ...record.target, nativeId: 'x'.repeat(1025) } })).toThrow(/invalid/i);
    expect(() => validateDeviceCalendarReadWindow({ timeMin: at, timeMax: '2026-10-28T01:02:03.000Z' }, 15)).toThrow(/15 days/i);
  });

  it('records a timeout then permits only the same in-flight native acknowledgement to resolve unknown as saved', () => {
    const record = createDeviceEventDispatchRecord({ id, claimAt: at, proposal: eventProposal(), target });
    const unknown = recordDeviceEventOutcome(record, { outcome: 'unknown', at: '2026-10-12T01:03:03.000Z', observationSource: 'timeout' });
    expect(unknown.nativeOutcomeObservations).toEqual([{ outcome: 'unknown', at: '2026-10-12T01:03:03.000Z', source: 'timeout' }]);
    const saved = recordDeviceEventOutcome(unknown, { outcome: 'saved', at: '2026-10-12T01:04:03.000Z', nativeEventId: 'native-event', allowLateNativeCompletion: true, observationSource: 'native_callback' });
    expect(saved.outcome).toBe('saved');
    expect(saved.nativeOutcomeObservations?.map((item) => item.outcome)).toEqual(['unknown', 'saved']);
    const lateUnknown = recordDeviceEventOutcome(unknown, { outcome: 'unknown', at: '2026-10-12T01:03:04.000Z', observationSource: 'native_callback', nativeEventId: 'late-id', allowLateNativeObservation: true });
    expect(lateUnknown.outcome).toBe('unknown');
    expect(lateUnknown.nativeEventId).toBe('late-id');
    expect(lateUnknown.nativeOutcomeObservations).toHaveLength(2);
    expect(() => recordDeviceEventOutcome(lateUnknown, { outcome: 'saved', at: '2026-10-12T01:04:03.000Z', nativeEventId: 'different-event', allowLateNativeCompletion: true })).toThrow(/ID differs/i);
    const correlatedUnknown = recordDeviceEventOutcome(record, { outcome: 'unknown', at: '2026-10-12T01:03:04.000Z', observationSource: 'native_callback', nativeEventId: 'known-event-id' });
    expect(() => recordDeviceEventOutcome(correlatedUnknown, { outcome: 'saved', at: '2026-10-12T01:04:03.000Z', nativeEventId: 'different-event', allowLateNativeCompletion: true })).toThrow(/ID differs/i);
    expect(() => recordDeviceEventOutcome(unknown, { outcome: 'rejected', at: '2026-10-12T01:04:03.000Z', errorCode: 'precondition_failed' })).toThrow(/terminal/i);
  });

  it('round-trips calendar rows and binds duplicate keys to the exact native destination', () => {
    const record = createDeviceEventDispatchRecord({ id, claimAt: at, proposal: eventProposal(), target });
    const row = createDeviceCalendarRow({ localId: calendarId, dto: { nativeId: 'native-calendar', title: 'Personal', allowsModifications: true }, fingerprint: digest, observedAt: at });
    const state = validateDeviceCalendarState({ schemaVersion: 1, installationId: id, generation: 2, selectionRevision: 4,
      enabled: true, selectedCalendarIds: [calendarId], calendars: [row], events: [], dispatchRecords: [record] });
    expect(state.calendars[0]).toMatchObject({ localId: calendarId, fingerprint: digest, observedAt: at });
    const reconnected = createDeviceEventDispatchRecord({ id: calendarId, claimAt: at, proposal: eventProposal(), target: { ...target, generation: 8, selectionRevision: 9 } });
    const otherDestination = createDeviceEventDispatchRecord({ id: calendarId, claimAt: at, proposal: eventProposal(), target: { ...target, nativeId: 'other-calendar' } });
    expect(reconnected.duplicateKey).toBe(record.duplicateKey);
    expect(otherDestination.duplicateKey).not.toBe(record.duplicateKey);
    expect(() => validateDeviceEventDispatchRecord({ ...record, duplicateKey: 'forged-key' })).toThrow(/duplicate key/i);
  });

  it('rejects read-run cursors that overstate durable coverage or differ from current selection', () => {
    const row = createDeviceCalendarRow({ localId: calendarId, dto: { nativeId: 'native-calendar', title: 'Personal', allowsModifications: true }, fingerprint: digest, observedAt: at });
    const readRun = { runId: id, generation: 2, selectionRevision: 4, window: { timeMin: '2026-10-13T00:00:00.000Z', timeMax: '2026-10-14T00:00:00.000Z' },
      selectedCalendarIds: [calendarId], cursor: 0, startedAt: at, completedCalendarIds: [], partial: true, truncatedCalendars: 0, truncatedEvents: 0 };
    const base = { schemaVersion: 1, installationId: id, generation: 2, selectionRevision: 4, enabled: true,
      selectedCalendarIds: [calendarId], calendars: [row], events: [], dispatchRecords: [] };
    expect(validateDeviceCalendarState({ ...base, readRun })).toMatchObject({ readRun: { cursor: 0, completedCalendarIds: [] } });
    expect(() => validateDeviceCalendarState({ ...base, readRun: { ...readRun, selectedCalendarIds: [calendarId, calendarId] } })).toThrow(/cursor|references/i);
    expect(() => validateDeviceCalendarState({ ...base, readRun: { ...readRun, cursor: 1 } })).toThrow(/cursor|references/i);
    expect(() => validateDeviceCalendarState({ ...base, readRun: { ...readRun, cursor: 2 } })).toThrow(/cursor|references/i);
    expect(() => validateDeviceCalendarState({ ...base, readRun: { ...readRun, selectedCalendarIds: [] } })).toThrow(/cursor|references/i);
  });
});
