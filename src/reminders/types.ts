import type { ProactiveCandidate, ProactiveSource } from '../proactive';

export type ReminderPrivacyMode = 'private' | 'full';
export type ReminderStatus = 'draft' | 'approved' | 'saved' | 'cancelled' | 'completed';
export type ReminderIntentDesired = 'scheduled' | 'cancelled';
export type ReminderIntentObserved = 'unconfirmed' | 'pending' | 'absent' | 'blocked' | 'unavailable' | 'delivery_unknown' | 'error';
export type ReminderIntentErrorCode = 'permission_denied' | 'permission_unavailable' | 'listing_failed' | 'schedule_failed' | 'cancel_failed' | 'invalid_request' | 'unverifiable' | 'unavailable';

export interface ReminderPayload {
  title: string;
  body: string;
  dueAt: string;
  displayTimeZone: string;
  privacyMode: ReminderPrivacyMode;
}

export interface ManualReminderOrigin { kind: 'manual' }
export interface NoteReminderOrigin {
  kind: 'note';
  noteId: string;
  proposalId: string;
  proposalRevision: number;
  sourceRevision: number;
  sourceVersion: string;
  quote: string;
}

export interface ProactiveReminderBinding {
  accountId: string;
  namespace: string;
  identityKey: string;
  connectionGeneration: number;
}

export interface ProactiveReminderOrigin {
  kind: 'proactive';
  candidate: ProactiveCandidate;
  rule: { id: string; revision: number; version: number; name: string };
  source: ProactiveSource;
  binding?: ProactiveReminderBinding;
  capturedAt: string;
  expiresAt: string;
}

export type ReminderOrigin = ManualReminderOrigin | NoteReminderOrigin | ProactiveReminderOrigin;

export interface ReminderRecord extends ReminderPayload {
  id: string;
  revision: number;
  origin: ReminderOrigin;
  status: ReminderStatus;
  createdAt: string;
  updatedAt: string;
  firstSavedAt?: string;
  approvedRevision?: number;
  approvedPayloadDigest?: string;
  currentIntentId?: string;
}

export interface ReminderIntent {
  id: string;
  reminderId: string;
  reminderRevision: number;
  epoch: number;
  identifier: string;
  payloadDigest: string;
  payload?: ReminderPayload;
  desired: ReminderIntentDesired;
  observed: ReminderIntentObserved;
  createdAt: string;
  updatedAt: string;
  attemptedAt?: string;
  observedAt?: string;
  errorCode?: ReminderIntentErrorCode;
}

export interface LegacyReminderCancellation {
  id: string;
  proposalId: string;
  proposalRevision: number;
  identifier: string;
  requestedAt: string;
  observed: 'unconfirmed' | 'absent' | 'error';
  attemptedAt?: string;
  observedAt?: string;
  errorCode?: 'listing_failed' | 'cancel_failed' | 'unverifiable';
}

export interface ReminderState {
  schemaVersion: 1;
  installationId: string;
  records: ReminderRecord[];
  intents: ReminderIntent[];
  legacyCancellations?: LegacyReminderCancellation[];
}
