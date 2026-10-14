import type { AnyProposalProvenance, EmailProposalPayload, EventProposalPayload, Proposal } from '../core';

export type DispatchOperation = 'draft' | 'send' | 'event';
export type DispatchOutcome = 'pending' | 'accepted' | 'unknown' | 'rejected';
export type DispatchReconciliation = 'confirmed_present' | 'not_found' | 'abandoned';

export interface DispatchIdentitySnapshot {
  providerNamespace: 'google' | 'microsoft';
  clientId: string;
  subject: string;
  issuer?: string;
  tenantId?: string;
  resourceUserId?: string;
}

export interface DispatchAccountSnapshot {
  provider: 'google' | 'microsoft';
  identity: DispatchIdentitySnapshot;
  displayName: string;
  email: string;
}

export interface DispatchCalendarSnapshot {
  localId: string;
  providerId: string;
  name: string;
}

export type DispatchPayload =
  | { kind: 'email'; email: Omit<EmailProposalPayload, 'operation'> }
  | { kind: 'event'; event: EventProposalPayload };

export interface DispatchReconciliationAttestation {
  id: string;
  disposition: DispatchReconciliation;
  at: string;
  note: string;
  remoteId?: string;
}

/** Durable, credential-free immutable snapshot of one approved external operation. */
export interface DispatchRecord {
  version: 1;
  id: string;
  proposalId: string;
  approvedRevision: number;
  sourceRevision?: number;
  payloadDigest: string;
  sourceActionKey: string;
  /** Stable across reconnect generations; derived from immutable identity + action + operation. */
  duplicateKey: string;
  sourceProvenance: AnyProposalProvenance;
  /** Private historical consistency proof for a reviewed Batch mail reply. */
  mailReplyBatchBinding?: { jobId: string; provenanceCanonical: string };
  operation: DispatchOperation;
  accountId: string;
  account: DispatchAccountSnapshot;
  calendar?: DispatchCalendarSnapshot;
  title: string;
  body: string;
  payload: DispatchPayload;
  dispatchStartedAt: string;
  providerIdempotencyKey?: string;
  outcome: DispatchOutcome;
  outcomeAt?: string;
  rejectionCode?: 'provider_rejected' | 'precondition_failed';
  replyDraftCheck?: 'matches_approved' | 'differs' | 'unverified';
  remoteId?: string;
  reconciliations: readonly DispatchReconciliationAttestation[];
}

export interface CreateDispatchRecordInput {
  id: string;
  dispatchStartedAt: string;
  proposal: Proposal;
  account: import('../core').Account;
  calendar?: import('../core').Calendar;
}

export interface DispatchOutcomeInput {
  outcome: Exclude<DispatchOutcome, 'pending'>;
  at: string;
  remoteId?: string;
  rejectionCode?: 'provider_rejected' | 'precondition_failed';
  replyDraftCheck?: 'matches_approved' | 'differs' | 'unverified';
}

export type ApprovedEmailPayload = EmailProposalPayload;
export type ApprovedEventPayload = EventProposalPayload;
