import type { AnyProposalProvenance, NoteProposalProvenance } from '../core';
import type {
  CreateDeviceEventDispatchRecordInput, DeviceCalendarDto, DeviceCalendarReadWindow, DeviceCalendarRow,
  DeviceCalendarState, DeviceEventDispatchRecord, DeviceEventErrorCode, DeviceEventOutcome,
  DeviceEventReconciliationAttestation, DeviceEventNativeOutcomeObservation,
} from './types';
export type {
  CreateDeviceEventDispatchRecordInput, DeviceCalendarBackendErrorCode, DeviceCalendarBackendErrorShape,
  DeviceCalendarAccessStatus, DeviceCalendarDiscoveryResult, DeviceCalendarDto, DeviceCalendarPermission, DeviceCalendarPlatform,
  DeviceCalendarReadResult, DeviceCalendarReadRun, DeviceCalendarReadWindow, DeviceCalendarRow,
  DeviceCalendarState, DeviceEventCreateResult, DeviceEventDispatchRecord, DeviceEventErrorCode,
  DeviceEventLookupResult, DeviceEventOutcome, DeviceEventPayloadSnapshot, DeviceEventReconciliation,
  DeviceEventReconciliationAttestation, DeviceEventSnapshot, DeviceEventTargetSnapshot,
} from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const ERROR_CODES: DeviceEventErrorCode[] = ['precondition_failed', 'permission_denied', 'permission_unavailable', 'calendar_missing', 'calendar_changed', 'calendar_readonly', 'unsupported_payload', 'unavailable', 'lookup_failed'];

function fail(message: string): never { throw new Error(message); }
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function boundedText(value: unknown, label: string, maxChars: number, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || !isWellFormedUnicode(value) || value.length > maxChars || utf8Bytes(value) > maxBytes || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID.`);
  return value.toLowerCase();
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label} must be a positive integer.`);
  return Number(value);
}
function nonnegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a nonnegative integer.`);
  return Number(value);
}
function canonicalTime(value: unknown, label: string): string {
  const text = boundedText(value, label, 40, 40);
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== text) fail(`${label} must be a canonical UTC ISO timestamp.`);
  return text;
}
function timeZone(value: unknown): string {
  const zone = boundedText(value, 'Calendar time zone', 128, 128);
  if (zone !== 'UTC' && zone !== 'GMT' && !zone.includes('/')) fail('Calendar time zone must be an IANA zone identifier.');
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0); } catch { fail('Calendar time zone is invalid.'); }
  return zone;
}
export function normalizeDeviceTimeZone(value: unknown): string | undefined {
  try { return timeZone(value); } catch { return undefined; }
}
function onlyKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(`${label} contains unsupported fields.`);
}
function clonedFrozen<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone;
}

function normalizeLabel(value: unknown, label: string, maxChars: number, maxBytes: number): { value?: string; omitted: boolean } {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) return { omitted: true };
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned.length > maxChars || utf8Bytes(cleaned) > maxBytes) return { omitted: true };
  return { value: boundedText(cleaned, label, maxChars, maxBytes), omitted: false };
}

export function canonicalDeviceCalendarFingerprintInput(calendar: DeviceCalendarDto): string {
  const value = validateDeviceCalendarDto(calendar);
  return JSON.stringify({ nativeId: value.nativeId, title: value.title, sourceId: value.sourceId ?? null,
    sourceName: value.sourceName ?? null, sourceType: value.sourceType ?? null, timeZone: value.timeZone ?? null,
    allowsModifications: value.allowsModifications, titleOmitted: value.titleOmitted ?? false, sourceOmitted: value.sourceOmitted ?? false });
}

export async function fingerprintDeviceCalendar(calendar: DeviceCalendarDto, sha256Hex: (canonical: string) => Promise<string>): Promise<string> {
  const digest = await sha256Hex(canonicalDeviceCalendarFingerprintInput(calendar));
  if (typeof digest !== 'string' || !SHA256.test(digest)) fail('Calendar fingerprint digest is invalid.');
  return digest.toLowerCase();
}

export function validateDeviceCalendarDto(value: unknown): DeviceCalendarDto {
  onlyKeys(value, ['nativeId', 'title', 'sourceId', 'sourceName', 'sourceType', 'timeZone', 'allowsModifications', 'titleOmitted', 'sourceOmitted'], 'Device calendar');
  const nativeId = boundedText(value.nativeId, 'Native calendar ID', 1024, 1024);
  const title = boundedText(value.title, 'Calendar title', 512, 2048, true);
  for (const flag of ['titleOmitted', 'sourceOmitted'] as const) if (value[flag] !== undefined && typeof value[flag] !== 'boolean') fail(`Calendar ${flag} flag is invalid.`);
  const result: DeviceCalendarDto = { nativeId, title, allowsModifications: value.allowsModifications === true,
    ...(value.sourceId !== undefined ? { sourceId: boundedText(value.sourceId, 'Calendar source ID', 1024, 1024) } : {}),
    ...(value.sourceName !== undefined ? { sourceName: boundedText(value.sourceName, 'Calendar source name', 512, 1024, true) } : {}),
    ...(value.sourceType !== undefined ? { sourceType: boundedText(value.sourceType, 'Calendar source type', 128, 256, true) } : {}),
    ...(value.timeZone !== undefined ? { timeZone: timeZone(value.timeZone) } : {}),
    ...(value.titleOmitted ? { titleOmitted: true } : {}), ...(value.sourceOmitted ? { sourceOmitted: true } : {}) };
  if (typeof value.allowsModifications !== 'boolean') fail('Calendar write capability is invalid.');
  return result;
}

export function normalizeDeviceCalendar(value: unknown): Omit<DeviceCalendarDto, 'titleOmitted' | 'sourceOmitted'> & { titleOmitted: boolean; sourceOmitted: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Native calendar row is invalid.');
  const row = value as Record<string, unknown>;
  const source = row.source && typeof row.source === 'object' ? row.source as Record<string, unknown> : {};
  const title = normalizeLabel(row.title, 'Calendar title', 512, 2048);
  const sourceId = normalizeLabel(source.id, 'Calendar source ID', 1024, 1024);
  const sourceName = normalizeLabel(source.name, 'Calendar source name', 512, 1024);
  const sourceType = normalizeLabel(source.type, 'Calendar source type', 128, 256);
  const nativeId = boundedText(row.id, 'Native calendar ID', 1024, 1024);
  const nativeZone = normalizeDeviceTimeZone(row.timeZone);
  const dto = validateDeviceCalendarDto({ nativeId, title: title.value ?? '', allowsModifications: row.allowsModifications === true,
    ...(sourceId.value ? { sourceId: sourceId.value } : {}), ...(sourceName.value ? { sourceName: sourceName.value } : {}),
    ...(sourceType.value ? { sourceType: sourceType.value } : {}), ...(nativeZone ? { timeZone: nativeZone } : {}),
    titleOmitted: title.omitted, sourceOmitted: sourceId.omitted || sourceName.omitted || sourceType.omitted });
  return { ...dto, titleOmitted: dto.titleOmitted === true, sourceOmitted: dto.sourceOmitted === true };
}

export function createDeviceCalendarRow(input: { localId: string; dto: DeviceCalendarDto; fingerprint: string; observedAt: string }): DeviceCalendarRow {
  const dto = validateDeviceCalendarDto(input.dto);
  const localId = uuid(input.localId, 'Local calendar ID');
  const fingerprint = boundedText(input.fingerprint, 'Calendar fingerprint', 64, 64);
  if (!SHA256.test(fingerprint)) fail('Calendar fingerprint must be a SHA-256 hex digest.');
  return clonedFrozen({ ...dto, localId, fingerprint: fingerprint.toLowerCase(), observedAt: canonicalTime(input.observedAt, 'Calendar observation time') });
}

function snapshotNoteProvenance(value: AnyProposalProvenance | undefined): NoteProposalProvenance {
  if (!value || value.version !== 1) fail('Device event requires note-derived proposal provenance.');
  onlyKeys(value, ['version', 'assistContractVersion', 'analysisFingerprint', 'noteId', 'noteRevision', 'capturedAt', 'captureTimeZone', 'intent', 'question', 'knowledgeSelection', 'sources', 'policySources', 'settingsFingerprint', 'answeredAsOf', 'expiresAt'], 'Proposal provenance');
  const p = value as NoteProposalProvenance;
  if (!['assist', 'summarize', 'answer', 'extract'].includes(p.intent)) fail('Proposal provenance intent is invalid.');
  const sources = (items: NoteProposalProvenance['sources']) => {
    if (!Array.isArray(items) || items.length > 200) fail('Proposal provenance source list is invalid.');
    return items.map((item) => {
      onlyKeys(item, ['sourceId', 'revision', 'sourceVersion'], 'Provenance source');
      return { sourceId: boundedText(item.sourceId, 'Provenance source ID', 512, 1024), revision: nonnegative(item.revision, 'Provenance source revision'), sourceVersion: boundedText(item.sourceVersion, 'Provenance source version', 512, 1024) };
    });
  };
  const knowledge = p.knowledgeSelection?.map((item) => {
    onlyKeys(item, ['kind', 'id'], 'Knowledge source');
    if (item.kind !== 'person' && item.kind !== 'project') fail('Provenance knowledge source is invalid.');
    return { kind: item.kind, id: uuid(item.id, 'Knowledge source ID') };
  });
  return {
    version: 1, assistContractVersion: boundedText(p.assistContractVersion, 'Assist contract version', 128, 256),
    analysisFingerprint: boundedText(p.analysisFingerprint, 'Analysis fingerprint', 1024 * 1024, 1024 * 1024),
    noteId: uuid(p.noteId, 'Source note ID'), noteRevision: positive(p.noteRevision, 'Source note revision'),
    capturedAt: canonicalTime(p.capturedAt, 'Provenance capture time'), captureTimeZone: timeZone(p.captureTimeZone), intent: p.intent,
    ...(p.question !== undefined ? { question: boundedText(p.question, 'Provenance question', 16_384, 16_384, true) } : {}),
    ...(knowledge ? { knowledgeSelection: knowledge } : {}), sources: sources(p.sources), policySources: sources(p.policySources),
    settingsFingerprint: boundedText(p.settingsFingerprint, 'Settings fingerprint', 16_384, 16_384),
    ...(p.answeredAsOf !== undefined ? { answeredAsOf: canonicalTime(p.answeredAsOf, 'Provenance answer time') } : {}),
    ...(p.expiresAt !== undefined ? { expiresAt: canonicalTime(p.expiresAt, 'Provenance expiry') } : {}),
  };
}

function validateDispatchRecord(value: unknown): DeviceEventDispatchRecord {
  const keys = ['version', 'id', 'proposalId', 'revision', 'sourceRevision', 'sourceProvenance', 'sourceActionKey', 'duplicateKey', 'payloadDigest', 'target', 'payload', 'claimAt', 'outcome', 'outcomeAt', 'errorCode', 'nativeEventId', 'reconciliations', 'nativeOutcomeObservations'];
  onlyKeys(value, keys, 'Device event dispatch record');
  const record = value as unknown as DeviceEventDispatchRecord;
  if (record.version !== 1) fail('Device event dispatch record version is invalid.');
  const target = validateTarget(record.target);
  const payload = validatePayload(record.payload);
  if (!['pending', 'saved', 'unknown', 'rejected'].includes(record.outcome)) fail('Device event outcome is invalid.');
  const sourceProvenance = snapshotNoteProvenance(record.sourceProvenance);
  const expectedDuplicateKey = JSON.stringify(['device-calendar-v1', target.installationId, target.nativeId, record.sourceActionKey, 'event']);
  if (record.duplicateKey !== expectedDuplicateKey) fail('Device event duplicate key does not match its frozen destination and action.');
  const outcomeAt = record.outcomeAt === undefined ? undefined : canonicalTime(record.outcomeAt, 'Device event outcome time');
  if (record.outcome === 'pending' && (outcomeAt !== undefined || record.nativeEventId !== undefined || record.errorCode !== undefined)) fail('Pending device event has terminal outcome fields.');
  if (record.outcome !== 'pending' && (!outcomeAt || Date.parse(outcomeAt) < Date.parse(record.claimAt))) fail('Device event outcome time precedes its claim.');
  const errorCode = record.errorCode;
  if (errorCode !== undefined && !ERROR_CODES.includes(errorCode)) fail('Device event error code is invalid.');
  if (record.outcome === 'saved' && !record.nativeEventId) fail('Saved device event is missing its native ID.');
  if ((record.outcome === 'pending' || record.outcome === 'rejected') && record.nativeEventId !== undefined) fail('Pending or rejected device event contains a native ID.');
  if (record.outcome === 'rejected' && !errorCode) fail('Rejected device event is missing a fixed error code.');
  if (record.outcome !== 'rejected' && errorCode) fail('Non-rejected device event has an error code.');
  if (!Array.isArray(record.reconciliations) || record.reconciliations.length > 100) fail('Device event reconciliation history is invalid.');
  const reconciliations = record.reconciliations.map(validateReconciliation);
  const nativeOutcomeObservations = record.nativeOutcomeObservations === undefined ? undefined : validateNativeOutcomeObservations(record.nativeOutcomeObservations, record.outcome, record.claimAt, record.nativeEventId);
  return clonedFrozen({ version: 1, id: uuid(record.id, 'Dispatch record ID'), proposalId: boundedText(record.proposalId, 'Proposal ID', 160, 320),
    revision: positive(record.revision, 'Approved revision'), ...(record.sourceRevision !== undefined ? { sourceRevision: positive(record.sourceRevision, 'Source revision') } : {}),
    sourceProvenance, sourceActionKey: boundedText(record.sourceActionKey, 'Source action key', 1024 * 1024, 1024 * 1024),
    duplicateKey: boundedText(record.duplicateKey, 'Duplicate key', 1024 * 1024, 1024 * 1024),
    payloadDigest: digest(record.payloadDigest, 'Payload digest'), target, payload, claimAt: canonicalTime(record.claimAt, 'Dispatch claim time'), outcome: record.outcome,
    ...(outcomeAt ? { outcomeAt } : {}), ...(errorCode ? { errorCode } : {}), ...(record.nativeEventId ? { nativeEventId: boundedText(record.nativeEventId, 'Native event ID', 1024, 1024) } : {}), reconciliations,
    ...(nativeOutcomeObservations ? { nativeOutcomeObservations } : {}) });
}

function validateNativeOutcomeObservations(value: unknown, finalOutcome: DeviceEventOutcome, claimAt: string, recordNativeEventId?: string): DeviceEventNativeOutcomeObservation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) fail('Native outcome observation history is invalid.');
  let previousAt = Date.parse(claimAt);
  const observations = value.map((item) => {
    onlyKeys(item, ['outcome', 'at', 'source', 'nativeEventId'], 'Native outcome observation');
    const observation = item as unknown as DeviceEventNativeOutcomeObservation;
    if (!['unknown', 'saved', 'rejected'].includes(observation.outcome) || !['timeout', 'native_callback', 'restart_recovery'].includes(observation.source)) fail('Native outcome observation is invalid.');
    if (observation.source !== 'native_callback' && (observation.outcome !== 'unknown' || observation.nativeEventId !== undefined)) fail('Only native callbacks can report saved outcomes or native IDs.');
    const at = canonicalTime(observation.at, 'Native outcome observation time');
    if (Date.parse(at) < previousAt) fail('Native outcome observations must be time ordered.');
    previousAt = Date.parse(at);
    if (observation.nativeEventId !== undefined) {
      if (observation.outcome === 'rejected' || observation.source !== 'native_callback') fail('Native outcome observation ID is inconsistent.');
      return { outcome: observation.outcome, at, source: observation.source, nativeEventId: boundedText(observation.nativeEventId, 'Observed native event ID', 1024, 1024) };
    }
    return { outcome: observation.outcome, at, source: observation.source };
  });
  if (observations[observations.length - 1]?.outcome !== finalOutcome) fail('Native outcome observation does not match the record outcome.');
  const last = observations[observations.length - 1]!;
  if ((finalOutcome === 'saved' || finalOutcome === 'unknown') && last.nativeEventId !== recordNativeEventId) fail('Native outcome observation ID is inconsistent with the record.');
  return observations;
}

function digest(value: unknown, label: string): string {
  const result = boundedText(value, label, 64, 64);
  if (!SHA256.test(result)) fail(`${label} must be a SHA-256 hex digest.`);
  return result.toLowerCase();
}
function validateTarget(value: unknown): DeviceEventDispatchRecord['target'] {
  onlyKeys(value, ['installationId', 'generation', 'selectionRevision', 'calendarLocalId', 'nativeId', 'fingerprint', 'title', 'sourceLabel'], 'Device event target');
  const target = value as unknown as DeviceEventDispatchRecord['target'];
  return { installationId: uuid(target.installationId, 'Installation ID'), generation: positive(target.generation, 'Device generation'),
    selectionRevision: positive(target.selectionRevision, 'Calendar selection revision'), calendarLocalId: uuid(target.calendarLocalId, 'Local calendar ID'),
    nativeId: boundedText(target.nativeId, 'Native calendar ID', 1024, 1024), fingerprint: digest(target.fingerprint, 'Calendar fingerprint'),
    title: boundedText(target.title, 'Calendar title', 512, 2048, true), sourceLabel: boundedText(target.sourceLabel, 'Calendar source label', 512, 1024, true) };
}
function validatePayload(value: unknown): DeviceEventDispatchRecord['payload'] {
  onlyKeys(value, ['title', 'notes', 'start', 'end', 'timeZone', 'allDay', 'attendees', 'invitePolicy', 'alarms'], 'Device event payload');
  const p = value as unknown as DeviceEventDispatchRecord['payload'];
  const title = boundedText(p.title, 'Event title', 512, 2048, true);
  const notes = boundedText(p.notes, 'Event notes', 8192, 8192, true);
  if (p.allDay !== false || p.invitePolicy !== 'none' || !Array.isArray(p.attendees) || p.attendees.length !== 0 || !Array.isArray(p.alarms) || p.alarms.length !== 0) fail('Device calendar only supports timed, attendee-free events without alarms.');
  const start = canonicalTime(p.start, 'Event start'), end = canonicalTime(p.end, 'Event end');
  if (Date.parse(end) <= Date.parse(start)) fail('Event end must follow its start.');
  return { title, notes, start, end, timeZone: timeZone(p.timeZone), allDay: false, attendees: [], invitePolicy: 'none', alarms: [] };
}
function validateReconciliation(value: unknown): DeviceEventReconciliationAttestation {
  onlyKeys(value, ['id', 'disposition', 'at', 'note', 'nativeEventId'], 'Device event reconciliation');
  const item = value as unknown as DeviceEventReconciliationAttestation;
  if (!['confirmed_present', 'not_found', 'abandoned'].includes(item.disposition)) fail('Device event reconciliation disposition is invalid.');
  return { id: uuid(item.id, 'Reconciliation ID'), disposition: item.disposition, at: canonicalTime(item.at, 'Reconciliation time'),
    note: boundedText(item.note, 'Reconciliation note', 2000, 4000, true), ...(item.nativeEventId ? { nativeEventId: boundedText(item.nativeEventId, 'Reconciled native event ID', 1024, 1024) } : {}) };
}

export function createDeviceEventDispatchRecord(input: CreateDeviceEventDispatchRecordInput): DeviceEventDispatchRecord {
  const proposal = input.proposal;
  if (!proposal || (proposal.status !== 'approved' && proposal.status !== 'dispatching') || proposal.approvedRevision !== proposal.revision || proposal.requiresRebuild || proposal.kind !== 'event' || !proposal.event) fail('Only the exact approved device event revision can be captured.');
  if (!proposal.sourceActionKey || !proposal.approvedPayloadDigest || !proposal.provenance || proposal.provenance.version !== 1 || proposal.noteId !== proposal.provenance.noteId || proposal.sourceRevision !== proposal.provenance.noteRevision) fail('Approved event source proof is incomplete.');
  const provenance = snapshotNoteProvenance(proposal.provenance);
  const transcript = provenance.sources.find((source) => source.sourceId === 'transcript');
  if (!transcript || transcript.revision !== proposal.sourceRevision) fail('Approved event provenance lacks the exact transcript revision.');
  onlyKeys(proposal.event, ['title', 'description', 'start', 'end', 'timeZone', 'attendees', 'invitePolicy'], 'Approved event payload');
  const event = proposal.event;
  if (event.invitePolicy !== 'none' || !Array.isArray(event.attendees) || event.attendees.length !== 0) fail('Device calendar dispatch does not support attendees or invitations.');
  const target = validateTarget(input.target);
  const payload = validatePayload({ title: event.title ?? proposal.title, notes: event.description ?? proposal.body, start: event.start, end: event.end,
    timeZone: event.timeZone, allDay: false, attendees: [], invitePolicy: 'none', alarms: [] });
  const sourceActionKey = boundedText(proposal.sourceActionKey, 'Source action key', 1024 * 1024, 1024 * 1024);
  const duplicateKey = JSON.stringify(['device-calendar-v1', target.installationId, target.nativeId, sourceActionKey, 'event']);
  return validateDispatchRecord({ version: 1, id: input.id, proposalId: proposal.id, revision: proposal.revision, sourceRevision: proposal.sourceRevision,
    sourceProvenance: provenance, sourceActionKey, duplicateKey, payloadDigest: proposal.approvedPayloadDigest, target, payload,
    claimAt: input.claimAt, outcome: 'pending', reconciliations: [] });
}

export function validateDeviceEventDispatchRecord(value: unknown): DeviceEventDispatchRecord { return validateDispatchRecord(value); }

export function recordDeviceEventOutcome(record: DeviceEventDispatchRecord, input: { outcome: Exclude<DeviceEventOutcome, 'pending'>; at: string; nativeEventId?: string; errorCode?: DeviceEventErrorCode; observationSource?: 'timeout' | 'native_callback' | 'restart_recovery'; allowLateNativeCompletion?: true; allowLateNativeObservation?: true }): DeviceEventDispatchRecord {
  const valid = validateDispatchRecord(record);
  const at = canonicalTime(input.at, 'Device event outcome time');
  if (Date.parse(at) < Date.parse(valid.claimAt)) fail('Device event outcome time precedes its claim.');
  const lateCompletion = valid.outcome === 'unknown' && input.outcome === 'saved' && input.allowLateNativeCompletion === true;
  const lateUnknownObservation = valid.outcome === 'unknown' && input.outcome === 'unknown' && input.allowLateNativeObservation === true;
  if (valid.outcome !== 'pending' && !lateCompletion && !lateUnknownObservation) fail('Terminal device event outcomes are immutable without a reconciliation attestation.');
  if (valid.outcome === 'unknown' && !lateCompletion && !lateUnknownObservation) fail('Unknown device event outcomes can only be resolved by the same in-flight native completion.');
  if (input.allowLateNativeCompletion === true && !lateCompletion) fail('Late native completion is only valid for an unknown-to-saved outcome.');
  if (input.allowLateNativeObservation === true && !lateUnknownObservation) fail('Late native observations can only append another unknown callback.');
  if (input.outcome === 'unknown' && input.observationSource === undefined) fail('Unknown outcomes must record their source.');
  if ((lateCompletion || lateUnknownObservation) && valid.nativeEventId !== undefined && input.nativeEventId !== valid.nativeEventId) fail('Late callback ID differs from the recorded native operation.');
  if ((lateCompletion || lateUnknownObservation) && valid.nativeOutcomeObservations?.at(-1)?.source !== 'timeout') fail('Late native callbacks require a timeout observation for the same in-flight operation.');
  if (input.observationSource !== undefined && input.observationSource !== 'native_callback' && (input.outcome !== 'unknown' || input.nativeEventId !== undefined)) fail('Timeout/restart observations can only record unknown outcomes without IDs.');
  if (input.outcome === 'rejected' && input.nativeEventId !== undefined) fail('Rejected device event cannot claim a native event ID.');
  if ((lateCompletion || lateUnknownObservation) && input.observationSource !== 'native_callback') fail('Late native callbacks must be recorded as native callbacks.');
  if (lateUnknownObservation && input.errorCode !== undefined) fail('Late unknown callbacks cannot add an error code.');
  const observedNativeId = input.nativeEventId ?? (lateUnknownObservation ? valid.nativeEventId : undefined);
  const observations = input.outcome === 'saved' || input.outcome === 'unknown' || input.outcome === 'rejected'
    ? [...(valid.nativeOutcomeObservations ?? []), { outcome: input.outcome, at, source: input.observationSource ?? 'native_callback', ...(observedNativeId !== undefined ? { nativeEventId: observedNativeId } : {}) }]
    : valid.nativeOutcomeObservations;
  if (observations && observations.length > 4) fail('Native outcome observation history is full.');
  const updated = { ...valid, outcome: input.outcome, outcomeAt: lateUnknownObservation ? valid.outcomeAt : at,
    ...(input.outcome === 'saved' ? { nativeEventId: boundedText(input.nativeEventId, 'Native event ID', 1024, 1024) } : input.outcome === 'unknown' && observedNativeId !== undefined ? { nativeEventId: boundedText(observedNativeId, 'Native event ID', 1024, 1024) } : {}),
    ...(input.outcome === 'rejected' ? { errorCode: input.errorCode } : {}), ...(observations ? { nativeOutcomeObservations: observations } : {}) };
  return validateDispatchRecord(updated);
}

export function appendDeviceEventReconciliation(record: DeviceEventDispatchRecord, input: DeviceEventReconciliationAttestation): DeviceEventDispatchRecord {
  const valid = validateDispatchRecord(record);
  if (valid.outcome === 'pending') fail('A pending device event cannot be reconciled.');
  if (valid.reconciliations.length >= 100) fail('Device event reconciliation history is full.');
  const attestation = validateReconciliation(input);
  if (Date.parse(attestation.at) < Date.parse(valid.outcomeAt!)) fail('Reconciliation time precedes the recorded outcome.');
  return validateDispatchRecord({ ...valid, reconciliations: [...valid.reconciliations, attestation] });
}


export function validateDeviceCalendarState(value: unknown): DeviceCalendarState {
  onlyKeys(value, ['schemaVersion', 'installationId', 'generation', 'selectionRevision', 'enabled', 'selectedCalendarIds', 'calendars', 'events', 'readRun', 'dispatchRecords'], 'Device calendar state');
  const state = value as unknown as DeviceCalendarState;
  if (state.schemaVersion !== 1 || typeof state.enabled !== 'boolean') fail('Device calendar state version or enabled flag is invalid.');
  const installationId = uuid(state.installationId, 'Installation ID');
  const generation = positive(state.generation, 'Device generation');
  const selectionRevision = positive(state.selectionRevision, 'Calendar selection revision');
  if (!Array.isArray(state.selectedCalendarIds) || state.selectedCalendarIds.length > 20 || !Array.isArray(state.calendars) || state.calendars.length > 100 || !Array.isArray(state.events) || state.events.length > 500 || !Array.isArray(state.dispatchRecords) || state.dispatchRecords.length > 1000) fail('Device calendar state exceeds its bounded shape.');
  const calendars = state.calendars.map((row) => {
    onlyKeys(row, ['nativeId', 'title', 'sourceId', 'sourceName', 'sourceType', 'timeZone', 'allowsModifications', 'titleOmitted', 'sourceOmitted', 'localId', 'fingerprint', 'observedAt'], 'Device calendar row');
    const { localId, fingerprint, observedAt, ...dto } = row;
    return createDeviceCalendarRow({ localId, dto, fingerprint, observedAt });
  });
  if (new Set(calendars.map((row) => row.localId)).size !== calendars.length || new Set(calendars.map((row) => row.nativeId)).size !== calendars.length) fail('Device calendars must have unique local and native IDs.');
  const selectedCalendarIds = state.selectedCalendarIds.map((id) => uuid(id, 'Selected calendar ID'));
  const calendarIds = new Set(calendars.map((calendar) => calendar.localId));
  if (new Set(selectedCalendarIds).size !== selectedCalendarIds.length || selectedCalendarIds.some((id) => !calendarIds.has(id))) fail('Selected calendars must belong to the installed calendar list.');
  const events = state.events.map(validateDeviceEventSnapshot);
  if (events.some((event) => !calendarIds.has(event.calendarId) || event.generation !== generation)) fail('Cached event calendar or generation relationship is invalid.');
  const eventKeys = events.map((event) => JSON.stringify([event.calendarId, event.nativeEventId, event.occurrenceStart]));
  if (new Set(eventKeys).size !== eventKeys.length) fail('Cached device event identities must be unique.');
  const dispatchRecords = state.dispatchRecords.map(validateDispatchRecord);
  if (new Set(dispatchRecords.map((record) => record.id)).size !== dispatchRecords.length || new Set(dispatchRecords.map((record) => record.duplicateKey)).size !== dispatchRecords.length) fail('Device dispatch records must have unique IDs and source-action keys.');
  const readRun = state.readRun === undefined ? undefined : validateReadRun(state.readRun, generation, selectionRevision, calendarIds, selectedCalendarIds);
  return clonedFrozen({ schemaVersion: 1, installationId, generation, selectionRevision, enabled: state.enabled, selectedCalendarIds, calendars, events,
    ...(readRun ? { readRun } : {}), dispatchRecords });
}

export function validateDeviceEventSnapshot(value: unknown): DeviceCalendarState['events'][number] {
  onlyKeys(value, ['id', 'calendarId', 'nativeEventId', 'occurrenceStart', 'title', 'notes', 'notesTruncated', 'start', 'end', 'timeZone', 'allDay', 'cancelled', 'observedAt', 'generation'], 'Device event snapshot');
  const event = value as unknown as DeviceCalendarState['events'][number];
  if (typeof event.notesTruncated !== 'boolean' || typeof event.allDay !== 'boolean' || typeof event.cancelled !== 'boolean') fail('Device event flags are invalid.');
  const start = canonicalTime(event.start, 'Event start'), end = canonicalTime(event.end, 'Event end');
  if (Date.parse(end) <= Date.parse(start)) fail('Event end must follow its start.');
  return clonedFrozen({ id: uuid(event.id, 'Event local ID'), calendarId: uuid(event.calendarId, 'Event calendar ID'), nativeEventId: boundedText(event.nativeEventId, 'Native event ID', 1024, 1024),
    occurrenceStart: canonicalTime(event.occurrenceStart, 'Event occurrence start'), title: boundedText(event.title, 'Event title', 512, 2048, true),
    notes: boundedText(event.notes, 'Event notes', 2048, 2048, true), notesTruncated: event.notesTruncated, start, end,
    ...(event.timeZone !== undefined ? { timeZone: timeZone(event.timeZone) } : {}), allDay: event.allDay, cancelled: event.cancelled,
    observedAt: canonicalTime(event.observedAt, 'Event observation time'), generation: positive(event.generation, 'Event generation') });
}

function validateReadRun(value: unknown, generation: number, selectionRevision: number, calendarIds: Set<string>, stateSelection: string[]): DeviceCalendarState['readRun'] {
  onlyKeys(value, ['runId', 'generation', 'selectionRevision', 'window', 'selectedCalendarIds', 'cursor', 'startedAt', 'completedCalendarIds', 'partial', 'truncatedCalendars', 'truncatedEvents'], 'Device calendar read run');
  const run = value as unknown as NonNullable<DeviceCalendarState['readRun']>;
  if (run.generation !== generation || run.selectionRevision !== selectionRevision || !Number.isSafeInteger(run.cursor) || run.cursor < 0 || typeof run.partial !== 'boolean' ||
      !Number.isSafeInteger(run.truncatedCalendars) || run.truncatedCalendars < 0 || !Number.isSafeInteger(run.truncatedEvents) || run.truncatedEvents < 0 || !Array.isArray(run.selectedCalendarIds) || run.selectedCalendarIds.length > 20 || !Array.isArray(run.completedCalendarIds)) fail('Device calendar read run is invalid.');
  const window = validateReadWindow(run.window, 15);
  const selectedCalendarIds = run.selectedCalendarIds.map((id) => uuid(id, 'Read-run selected calendar ID'));
  const completedCalendarIds = run.completedCalendarIds.map((id) => uuid(id, 'Completed calendar ID'));
  if ([...selectedCalendarIds, ...completedCalendarIds].some((id) => !calendarIds.has(id)) ||
      new Set(selectedCalendarIds).size !== selectedCalendarIds.length || new Set(completedCalendarIds).size !== completedCalendarIds.length ||
      selectedCalendarIds.length !== stateSelection.length || selectedCalendarIds.some((id, index) => id !== stateSelection[index]) ||
      run.cursor !== completedCalendarIds.length || run.cursor > selectedCalendarIds.length ||
      completedCalendarIds.some((id, index) => id !== selectedCalendarIds[index])) fail('Read-run calendar references or cursor are invalid.');
  return clonedFrozen({ runId: uuid(run.runId, 'Read-run ID'), generation, selectionRevision, window, selectedCalendarIds, cursor: run.cursor,
    startedAt: canonicalTime(run.startedAt, 'Read-run start'), completedCalendarIds, partial: run.partial, truncatedCalendars: run.truncatedCalendars, truncatedEvents: run.truncatedEvents });
}

export function validateDeviceCalendarReadWindow(value: unknown, maxDays = 15): DeviceCalendarReadWindow { return validateReadWindow(value, maxDays); }
function validateReadWindow(value: unknown, maxDays: number): DeviceCalendarReadWindow {
  onlyKeys(value, ['timeMin', 'timeMax'], 'Device calendar read window');
  const window = value as unknown as DeviceCalendarReadWindow;
  const timeMin = canonicalTime(window.timeMin, 'Read-window start'), timeMax = canonicalTime(window.timeMax, 'Read-window end');
  const duration = Date.parse(timeMax) - Date.parse(timeMin);
  if (duration <= 0 || duration > maxDays * 86_400_000) fail(`Device calendar read window must be within ${maxDays} days.`);
  return { timeMin, timeMax };
}

export function sanitizeNativeNotes(value: unknown): { notes: string; notesTruncated: boolean } {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) fail('Native event notes are malformed Unicode.');
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (utf8Bytes(cleaned) <= 2048) return { notes: cleaned, notesTruncated: false };
  let notes = '';
  for (const point of cleaned) {
    if (utf8Bytes(notes + point) > 2048) break;
    notes += point;
  }
  return { notes, notesTruncated: true };
}
