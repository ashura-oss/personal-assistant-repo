import type { ProactiveCandidate, ProactiveMailSource, ProactiveRule, ProactiveSnooze } from '../proactive';

export type MailAlertRule = ProactiveRule & { version: number };

export type MailAlertConsentStatus = 'active' | 'revoked';
export type MailAlertRevocationReason = 'rule_disabled' | 'rule_changed' | 'time_zone_changed' | 'account_changed' | 'user_revoked';
export type MailAlertDesired = 'notify' | 'cancel';
export type MailAlertObserved = 'attempting' | 'submitted' | 'delivery_unknown' | 'cancellation_pending' | 'cancelled' | 'cancellation_unknown';
export type MailAlertCancellationResult = 'requested' | 'absent' | 'unknown';

/** Exact verified account binding. `identityKey` is the four-field provider identity projection. */
export interface MailAlertAccountBinding {
  accountId: string;
  identityKey: string;
  connectionGeneration: number;
}

/** User-approved, finite account scope for one exact revision of one mail rule. */
export interface ProactiveMailAlertConsent {
  id: string;
  ruleId: string;
  ruleVersion: number;
  ruleRevision: number;
  timeZone: string;
  activatedAt: string;
  accounts: MailAlertAccountBinding[];
  status: MailAlertConsentStatus;
  revokedAt?: string;
  revocationReason?: MailAlertRevocationReason;
}

export interface MailAlertCancellationEvidence {
  requestedAt: string;
  attemptedAt?: string;
  observedAt?: string;
  result: MailAlertCancellationResult;
}

/** No subject, sender, snippet, or quote is retained in an alert receipt. */
export interface ProactiveMailAlertReceipt {
  id: string;
  installationId: string;
  consentId: string;
  ruleId: string;
  ruleVersion: number;
  ruleRevision: number;
  timeZone: string;
  consentActivatedAt: string;
  accountId: string;
  identityKey: string;
  connectionGeneration: number;
  providerMessageId: string;
  /** Frozen source projection digest, used for final admission only (not deduplication). */
  sourceVersion: string;
  receivedAt: string;
  desired: MailAlertDesired;
  observed: MailAlertObserved;
  createdAt: string;
  updatedAt: string;
  attemptedAt?: string;
  cancellation?: MailAlertCancellationEvidence;
}

export interface ProactiveMailAlertState {
  schemaVersion: 1;
  installationId: string;
  revision: number;
  consents: ProactiveMailAlertConsent[];
  receipts: ProactiveMailAlertReceipt[];
}

/** Trusted account snapshot supplied by the controller, never reconstructed from mail rows. */
export interface MailAlertVerifiedAccount extends MailAlertAccountBinding {
  providerNamespace: 'google' | 'microsoft';
  connected: boolean;
  authStatus: 'configured' | 'connected' | 'reauth_required' | 'revoked';
  canReadMail: boolean;
}

/** One exact provider page after its mailbox metadata commit; never the whole cached mailbox. */
export interface CommittedMailAlertPage {
  accountId: string;
  providerNamespace: 'google' | 'microsoft';
  identityKey: string;
  connectionGeneration: number;
  checkedAt: string;
  sources: readonly ProactiveMailSource[];
}

export interface ProactiveMailAlertPlanInput {
  state: ProactiveMailAlertState;
  rules: readonly MailAlertRule[];
  accounts: readonly MailAlertVerifiedAccount[];
  pages: readonly CommittedMailAlertPage[];
  previousCandidates?: readonly ProactiveCandidate[];
  dismissedCandidateIds?: readonly string[];
  snoozes?: readonly ProactiveSnooze[];
  now: string;
  currentTimeZone: string;
  uuid: () => string;
}

export interface ProactiveMailAlertPlan {
  nextState: ProactiveMailAlertState;
  /** Newly persisted `attempting` receipts; caller must commit `nextState` before notifying. */
  newAttempts: ProactiveMailAlertReceipt[];
  /** Existing receipts whose desired action is cancel; cleanup does not depend on live consent. */
  cancellationReceipts: ProactiveMailAlertReceipt[];
  revokedConsentIds: string[];
  quietSkippedCount: number;
  quotaSkippedCount: number;
  receiptCapacityReached: boolean;
}

export interface ProactiveMailAlertConsentInput {
  id: string;
  rule: MailAlertRule;
  timeZone: string;
  activatedAt: string;
  accounts: readonly MailAlertVerifiedAccount[];
}

export type { ProactiveMailSource, ProactiveRule };
