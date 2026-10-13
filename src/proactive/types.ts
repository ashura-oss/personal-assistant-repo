export type ProactiveTrigger =
  | { type: 'unread_from'; addresses: string[] }
  | { type: 'keyword'; keywords: string[]; unreadOnly?: boolean }
  | { type: 'meeting_soon'; minutes: number }
  | { type: 'task_due'; minutes: number };

export interface QuietHours {
  start: string;
  end: string;
}

export interface ProactiveRule {
  id: string;
  revision: number;
  enabled: boolean;
  /** Exact account IDs; an empty list includes every applicable source, including local tasks. */
  accountIds: string[];
  trigger: ProactiveTrigger;
  quietHours?: QuietHours;
}

interface SourceBase {
  /** JSON tuple `[namespace, accountId, providerId]`. */
  sourceId: string;
  namespace: string;
  accountId?: string;
  providerId: string;
  /** Stable source version supplied from canonical provider/local fields, never fetch time. */
  sourceVersion: string;
  availability: 'available' | 'unavailable';
  freshness: 'fresh' | 'stale' | 'unknown';
}

export interface ProactiveMailSource extends SourceBase {
  kind: 'mail';
  senderEmail?: string;
  isRead?: boolean;
  subject?: string;
  snippet?: string;
  receivedAt?: string;
  receivedAtUtcCertified?: boolean;
}

export interface ProactiveMeetingSource extends SourceBase {
  kind: 'meeting';
  subject?: string;
  startAt?: string;
  startAtUtcCertified?: boolean;
  /** Installation-scoped native event identity; absent for OAuth calendar rows. */
  deviceBinding?: { installationId: string; generation: number; calendarId: string; nativeEventId: string; occurrenceStart: string };
}

export interface ProactiveTaskSource extends SourceBase {
  kind: 'task';
  title?: string;
  status?: 'open' | 'completed';
  dueAt?: string;
  dueAtUtcCertified?: boolean;
}

export type ProactiveSource = ProactiveMailSource | ProactiveMeetingSource | ProactiveTaskSource;

export type ProactiveReasonCode = 'unread_sender' | 'keyword' | 'meeting_soon' | 'task_due';

export interface ProactiveCandidate {
  id: string;
  suppressionKey: string;
  ruleId: string;
  ruleRevision: number;
  sourceId: string;
  sourceVersion: string;
  sourceKind: ProactiveSource['kind'];
  namespace: string;
  accountId?: string;
  providerId: string;
  eligibleAt: string;
  reasonCode: ProactiveReasonCode;
  quote: string;
  quoteField: 'senderEmail' | 'subject' | 'snippet' | 'startAt' | 'dueAt' | 'title';
}

export interface ProactiveSnooze {
  suppressionKey: string;
  until: string;
  /** Canonical UTC creation-time proof used to keep the seven-day limit stable across clock rollback. */
  snoozedAt?: string;
}

export interface EvaluateProactiveInput {
  nowUtc: string;
  timeZone: string;
  rules: ProactiveRule[];
  sources: ProactiveSource[];
  previousCandidates?: ProactiveCandidate[];
  dismissedCandidateIds?: string[];
  snoozes?: ProactiveSnooze[];
  /** Only a complete provider snapshot permits invalidation by absence. */
  sourceSnapshotComplete?: boolean;
}

export interface ProactiveEvaluation {
  activeCandidates: ProactiveCandidate[];
  deferredCandidates: ProactiveCandidate[];
  invalidatedIds: string[];
  deferredIds: string[];
  unevaluatedIds: string[];
  truncation: { rules: number; sources: number; candidates: number };
}
