/** Closed browser-safe read models for the explicit mail/proposal review workflow. */
import type { Proposal } from '../core';
export type MailWorkflowReadStatus = 'current' | 'stale' | 'missing' | 'unavailable';
export interface WorkspaceReadEnvelope { readonly schemaVersion: 1; readonly workspaceId: string; readonly privacyEpoch: number; readonly revision: number }

export interface MailReplySourceDto {
  readonly accountId: string;
  readonly connectionGeneration: number;
  readonly localMessageId: string;
  readonly providerMessageId: string;
  readonly idFormat: 'gmail' | 'graph-immutable';
  readonly threadId?: string;
  readonly internetMessageId: string;
  readonly subject: string;
  readonly from?: string;
  readonly senderEmail?: string;
  readonly replyTo?: readonly string[];
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly snippet?: string;
  readonly observedAt: string;
  readonly sourceDigest: string;
}

export interface MailReplySourceReadDto extends WorkspaceReadEnvelope {
  readonly status: MailWorkflowReadStatus;
  readonly source?: MailReplySourceDto;
  readonly defaults?: Readonly<{ reply: Readonly<{ to: readonly string[]; cc: readonly string[] }>; reply_all: Readonly<{ to: readonly string[]; cc: readonly string[] }> }>;
  readonly bodyCache: Readonly<{ status: MailWorkflowReadStatus; textDigest?: string; bytes?: number; completeness?: 'complete_text' | 'excerpt' | 'unavailable';
    representation?: 'plain' | 'converted_html' | 'snippet' | 'none'; checkedAt?: string }>;
}

export interface MailReplyTextSnapshotDto {
  readonly messageId: string;
  readonly accountId: string;
  readonly connectionGeneration: number;
  readonly sourceDigest: string;
  readonly checkedAt: string;
  readonly text?: string;
  readonly textDigest?: string;
  readonly bytes: number;
  readonly extractionVersion: 'mail-text-v1' | 'mail-text-v2';
  readonly representation: 'plain' | 'converted_html' | 'snippet' | 'none';
  readonly completeness: 'complete_text' | 'excerpt' | 'unavailable';
  readonly omissionReasons: readonly string[];
}

export interface MailReplyTextReadDto extends WorkspaceReadEnvelope {
  readonly status: MailWorkflowReadStatus;
  readonly snapshot?: MailReplyTextSnapshotDto;
}

export interface WorkflowProposalReviewDto {
  readonly editPolicy: 'email_fields' | 'source_reply_fields' | 'manual_reply_fields' | 'manual_reply_send_fields' | 'event_fields' | 'read_only';
  readonly canDeriveManualReply: boolean;
  readonly draftPromotion?: Readonly<{ draftDispatchRecordId: string; provider: 'google' | 'microsoft' }>;
  readonly acceptedDraftCopy?: Readonly<{ parentProposalId: string; draftDispatchRecordId: string; provider: 'google' | 'microsoft' }>;
  readonly supersededByProposalId?: string;
  readonly id: string;
  readonly kind: 'email' | 'event' | 'task' | 'memory' | 'reminder';
  readonly title: string;
  readonly body: string;
  readonly status: Proposal['status'];
  readonly revision: number;
  readonly approvedRevision?: number;
  readonly lastError?: string;
  readonly accountId?: string;
  readonly recipients: readonly string[];
  readonly calendarId?: string;
  readonly dueAt?: string;
  readonly email?: Readonly<{ operation?: 'draft' | 'send'; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; text: string;
    attachments: readonly Readonly<{ fileName: string; mimeType: string; sizeBytes: number }>[] }>;
  readonly event?: Readonly<{ title?: string; description?: string; start: string; end: string; timeZone: string; attendees: readonly string[]; invitePolicy: 'send' | 'none' }>;
  readonly remoteOperation?: 'draft' | 'send' | 'event';
  readonly remoteId?: string;
  readonly remoteAcceptedAt?: string;
  readonly sourceDigest?: string;
}

export interface ProposalReviewReadDto extends WorkspaceReadEnvelope {
  readonly proposal?: WorkflowProposalReviewDto;
}

export interface DispatchReviewReadDto extends WorkspaceReadEnvelope {
  readonly record?: Readonly<{ id: string; proposalId: string; accountId: string; account: Readonly<{ provider: 'google' | 'microsoft'; displayName: string; email: string }>;
    calendar?: Readonly<{ localId: string; providerId: string; name: string }>; operation: 'draft' | 'send' | 'event'; title: string; body: string;
    payload: Readonly<{ kind: 'email'; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; text: string;
      attachments: readonly Readonly<{ fileName: string; mimeType: string; sizeBytes: number }>[] }> |
      Readonly<{ kind: 'event'; title?: string; description?: string; start: string; end: string; timeZone: string; attendees: readonly string[]; invitePolicy: 'send' | 'none' }>;
    outcome: 'pending' | 'accepted' | 'unknown' | 'rejected';
    dispatchStartedAt: string; outcomeAt?: string; remoteId?: string; rejectionCode?: string;
    reconciliations: readonly Readonly<{ disposition: 'confirmed_present' | 'not_found' | 'abandoned'; at: string; note: string; remoteId?: string }>[] }>;
  readonly recordVersion?: string;
}

export interface MailReplyBatchReviewReadDto extends WorkspaceReadEnvelope {
  readonly plan?: Readonly<{ planId: string; jobId: string; messageId: string; accountId: string; connectionGeneration: number; mode: 'reply' | 'reply_all'; operation: 'draft' | 'send';
    subject: string; to: readonly string[]; cc: readonly string[]; text: string; expiresAt: string;
    contextMessages?: readonly Readonly<{ selectionId: string; subject: string; sender?: string; receivedAt?: string; sentAt?: string;
      representation: 'plain' | 'converted_html' | 'snippet' | 'none'; completeness: 'complete_text' | 'excerpt' | 'unavailable'; bytes: number; omissionReasons: readonly string[] }>[] }>;
}
