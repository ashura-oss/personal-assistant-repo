import type { AnyProposalProvenance, Proposal } from '../core';

export type DeviceCalendarPlatform = 'ios' | 'android' | 'web' | 'mock';
export type DeviceCalendarPermission = 'full_access' | 'write_only' | 'denied' | 'undetermined' | 'unavailable';
export type DeviceCalendarAccessStatus = 'needs_check' | DeviceCalendarPermission;

export interface DeviceCalendarDto {
  nativeId: string;
  title: string;
  sourceId?: string;
  sourceName?: string;
  sourceType?: string;
  timeZone?: string;
  allowsModifications: boolean;
  titleOmitted?: boolean;
  sourceOmitted?: boolean;
}

export interface DeviceCalendarRow extends DeviceCalendarDto {
  localId: string;
  fingerprint: string;
  observedAt: string;
}

export interface DeviceEventSnapshot {
  id: string;
  calendarId: string;
  nativeEventId: string;
  occurrenceStart: string;
  title: string;
  notes: string;
  notesTruncated: boolean;
  start: string;
  end: string;
  timeZone?: string;
  allDay: boolean;
  cancelled: boolean;
  observedAt: string;
  generation: number;
}

export interface DeviceCalendarReadWindow { timeMin: string; timeMax: string }

export interface DeviceCalendarReadResult {
  events: DeviceEventSnapshot[];
  scanned: number;
  omitted: number;
  duplicateRows: number;
  conflicts: number;
  partial: boolean;
}

export interface DeviceCalendarDiscoveryResult {
  calendars: DeviceCalendarRow[];
  omitted: number;
  discoveryTruncated: boolean;
}

export interface DeviceCalendarReadRun {
  runId: string;
  generation: number;
  selectionRevision: number;
  window: DeviceCalendarReadWindow;
  selectedCalendarIds: string[];
  cursor: number;
  startedAt: string;
  completedCalendarIds: string[];
  partial: boolean;
  truncatedCalendars: number;
  truncatedEvents: number;
}

export type DeviceEventOutcome = 'pending' | 'saved' | 'unknown' | 'rejected';
export type DeviceEventErrorCode = 'precondition_failed' | 'permission_denied' | 'permission_unavailable' | 'calendar_missing' | 'calendar_changed' | 'calendar_readonly' | 'unsupported_payload' | 'unavailable' | 'lookup_failed';
export type DeviceEventReconciliation = 'confirmed_present' | 'not_found' | 'abandoned';

export interface DeviceEventTargetSnapshot {
  installationId: string;
  generation: number;
  selectionRevision: number;
  calendarLocalId: string;
  nativeId: string;
  fingerprint: string;
  title: string;
  sourceLabel: string;
}

export interface DeviceEventPayloadSnapshot {
  title: string;
  notes: string;
  start: string;
  end: string;
  timeZone: string;
  allDay: false;
  attendees: [];
  invitePolicy: 'none';
  alarms: [];
}

export interface DeviceEventReconciliationAttestation {
  id: string;
  disposition: DeviceEventReconciliation;
  at: string;
  note: string;
  nativeEventId?: string;
}

export interface DeviceEventNativeOutcomeObservation {
  outcome: 'unknown' | 'saved' | 'rejected';
  at: string;
  source: 'timeout' | 'native_callback' | 'restart_recovery';
  nativeEventId?: string;
}

/** Immutable, credential-free snapshot. Its approved digest is an audit reference; it cannot authorize execution. */
export interface DeviceEventDispatchRecord {
  version: 1;
  id: string;
  proposalId: string;
  revision: number;
  sourceRevision?: number;
  sourceProvenance: AnyProposalProvenance;
  sourceActionKey: string;
  duplicateKey: string;
  payloadDigest: string;
  target: DeviceEventTargetSnapshot;
  payload: DeviceEventPayloadSnapshot;
  claimAt: string;
  outcome: DeviceEventOutcome;
  outcomeAt?: string;
  errorCode?: DeviceEventErrorCode;
  nativeEventId?: string;
  reconciliations: readonly DeviceEventReconciliationAttestation[];
  nativeOutcomeObservations?: readonly DeviceEventNativeOutcomeObservation[];
}

export interface DeviceCalendarState {
  schemaVersion: 1;
  installationId: string;
  generation: number;
  selectionRevision: number;
  enabled: boolean;
  selectedCalendarIds: string[];
  calendars: DeviceCalendarRow[];
  events: DeviceEventSnapshot[];
  readRun?: DeviceCalendarReadRun;
  dispatchRecords: DeviceEventDispatchRecord[];
}

export interface CreateDeviceEventDispatchRecordInput {
  id: string;
  claimAt: string;
  proposal: Proposal;
  target: DeviceEventTargetSnapshot;
}

export type DeviceCalendarBackendErrorCode =
  | 'unavailable' | 'permission_denied' | 'permission_unavailable' | 'calendar_list_failed'
  | 'calendar_read_failed' | 'calendar_missing' | 'calendar_changed' | 'calendar_readonly'
  | 'precondition_failed' | 'unsupported_payload' | 'create_unknown' | 'lookup_failed' | 'invalid_request';

export interface DeviceCalendarBackendErrorShape { code: DeviceCalendarBackendErrorCode }

export interface DeviceEventCreateResult {
  status: 'saved' | 'unknown';
  nativeEventId?: string;
  event?: DeviceEventSnapshot;
}

export interface DeviceEventLookupResult {
  candidates: DeviceEventSnapshot[];
  partial: boolean;
  identity: 'unverified' | 'native_id_match';
}
