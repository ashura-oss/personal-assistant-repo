import type { JsonValue } from '../../server/src/kernel.js';
import type { WorkspaceHttpAdmission, WorkspaceHttpApi } from '../../server/src/workspaceHttp.js';
import type { KnowledgeHttpApi } from '../../server/src/knowledgeHttp.js';
import type { OwnedWorkspaceRuntime } from './ownedWorkspaceRuntime.node';
import { dispatchWorkspaceCommand, inspectWorkspaceCommand } from './workspaceCommands.node';
import type { WorkspaceCommandResponse } from './workspaceCommands';
import type { WorkspaceSnapshotDTO } from './workspaceDto';
import type { BackgroundPolicyStore } from '../../server/src/backgroundPolicies.js';

/** Binds the HTTP port only to the safe snapshot and explicit command APIs. */
export function createWorkspaceHttpApi(runtime: OwnedWorkspaceRuntime, backgroundPolicies?: BackgroundPolicyStore): WorkspaceHttpApi {
  return Object.freeze({
    async getSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue> {
      return serializeSnapshot(await runtime.getSnapshot(admission));
    },
    async refreshSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue> {
      return serializeSnapshot(await runtime.refreshSnapshot(admission));
    },
    async dispatchCommand(admission: WorkspaceHttpAdmission, envelope: unknown): Promise<JsonValue> {
      return serializeCommandResponse(await dispatchWorkspaceCommand(runtime, admission, envelope));
    },
    ...(backgroundPolicies ? {
      saveBackgroundPolicy(admission: WorkspaceHttpAdmission, envelope: unknown) {
        admission.assertCurrent();
        const receipt = backgroundPolicies.save(admission.sessionToken, envelope);
        admission.assertCurrent();
        return receipt;
      },
      pauseBackgroundPolicy(admission: WorkspaceHttpAdmission, envelope: unknown) {
        admission.assertCurrent();
        const receipt = backgroundPolicies.pause(admission.sessionToken, envelope);
        admission.assertCurrent();
        return receipt;
      },
      revokeBackgroundPolicy(admission: WorkspaceHttpAdmission, envelope: unknown) {
        admission.assertCurrent();
        const receipt = backgroundPolicies.revoke(admission.sessionToken, envelope);
        admission.assertCurrent();
        return receipt;
      },
      listBackgroundPolicies(admission: WorkspaceHttpAdmission, input: Parameters<BackgroundPolicyStore['list']>[1]) {
        admission.assertCurrent();
        const result = backgroundPolicies.list(admission.sessionToken, input);
        admission.assertCurrent();
        return result;
      },
      inspectBackgroundPolicyReceipt(admission: WorkspaceHttpAdmission, input: Parameters<BackgroundPolicyStore['inspect']>[1]) {
        admission.assertCurrent();
        const result = backgroundPolicies.inspect(admission.sessionToken, input);
        admission.assertCurrent();
        return result;
      },
    } : {}),
    async readKnowledgeSourceChoices(admission: WorkspaceHttpAdmission, input: Parameters<KnowledgeHttpApi['readKnowledgeSourceChoices']>[1]) {
      admission.assertCurrent();
      const result = await runtime.readKnowledgeSourceChoices(admission, input);
      admission.assertCurrent();
      return serializeKnowledgeRead(result);
    },
    async readKnowledgeSuggestionReview(admission: WorkspaceHttpAdmission, input: Parameters<KnowledgeHttpApi['readKnowledgeSuggestionReview']>[1]) {
      admission.assertCurrent();
      const result = await runtime.readKnowledgeSuggestionReview(admission, input);
      admission.assertCurrent();
      return serializeKnowledgeRead(result);
    },
    async readMailReplySource(admission: WorkspaceHttpAdmission, input: { messageId: string; expectedRevision: number; expectedPrivacyEpoch: number }) {
      admission.assertCurrent();
      const result = await runtime.readMailReplySource(admission, input);
      admission.assertCurrent();
      return serializeWorkflowRead({ ...readEnvelope(result), status: result.value.source.status, ...(result.value.source.source ? { source: safeMailSource(result.value.source.source) } : {}),
        ...(result.value.source.defaults ? { defaults: result.value.source.defaults } : {}), bodyCache: { status: result.value.bodyCache.status,
          ...(result.value.bodyCache.snapshot?.textDigest ? { textDigest: result.value.bodyCache.snapshot.textDigest } : {}),
          ...(result.value.bodyCache.snapshot ? { bytes: result.value.bodyCache.snapshot.bytes, completeness: result.value.bodyCache.snapshot.completeness,
            representation: result.value.bodyCache.snapshot.representation, checkedAt: result.value.bodyCache.snapshot.checkedAt } : {}) } });
    },
    async readMailReplyText(admission: WorkspaceHttpAdmission, input: { messageId: string; expectedRevision: number; expectedPrivacyEpoch: number }) {
      admission.assertCurrent();
      const result = await runtime.readMailReplyText(admission, input);
      admission.assertCurrent();
      const value = result.value.snapshot;
      return serializeWorkflowRead({ ...readEnvelope(result), status: result.value.status, ...(value ? { snapshot: {
        messageId: value.messageId, accountId: value.accountId, connectionGeneration: value.connectionGeneration, sourceDigest: value.sourceDigest,
        checkedAt: value.checkedAt, ...(value.text === undefined ? {} : { text: value.text }), ...(value.textDigest ? { textDigest: value.textDigest } : {}),
        bytes: value.bytes, extractionVersion: value.extractionVersion, representation: value.representation, completeness: value.completeness,
        omissionReasons: value.omissionReasons,
      } } : {}) });
    },
    async readProposalReview(admission: WorkspaceHttpAdmission, input: { proposalId: string; expectedRevision: number; expectedPrivacyEpoch: number }) {
      admission.assertCurrent();
      const value = await runtime.readProposalForReview(admission, input);
      admission.assertCurrent();
      return serializeWorkflowRead({ ...readEnvelope(value), ...(value.value ? { proposal: safeProposal(value.value) } : {}) });
    },
    async readDispatchReview(admission: WorkspaceHttpAdmission, input: { recordId: string; expectedRevision: number; expectedPrivacyEpoch: number }) {
      admission.assertCurrent();
      const value = await runtime.readDispatchForReview(admission, input);
      admission.assertCurrent();
      const { record, recordVersion } = value.value;
      return serializeWorkflowRead({ ...readEnvelope(value), record: { id: record.id, proposalId: record.proposalId, accountId: record.accountId,
        account: { provider: record.account.provider, displayName: record.account.displayName, email: record.account.email },
        ...(record.calendar ? { calendar: { localId: record.calendar.localId, providerId: record.calendar.providerId, name: record.calendar.name } } : {}),
        operation: record.operation, title: record.title, body: record.body,
        payload: record.payload.kind === 'email' ? { kind: 'email', to: record.payload.email.to, cc: record.payload.email.cc, bcc: record.payload.email.bcc,
          subject: record.payload.email.subject, text: record.payload.email.text, attachments: record.payload.email.attachments.map(({ fileName, mimeType, sizeBytes }) => ({ fileName, mimeType, sizeBytes })) }
          : { kind: 'event', title: record.payload.event.title, description: record.payload.event.description, start: record.payload.event.start,
            end: record.payload.event.end, timeZone: record.payload.event.timeZone, attendees: record.payload.event.attendees, invitePolicy: record.payload.event.invitePolicy },
        outcome: record.outcome, dispatchStartedAt: record.dispatchStartedAt, ...(record.outcomeAt ? { outcomeAt: record.outcomeAt } : {}),
        ...(record.remoteId ? { remoteId: record.remoteId } : {}), ...(record.rejectionCode ? { rejectionCode: record.rejectionCode } : {}),
        reconciliations: record.reconciliations.map((item) => ({ disposition: item.disposition, at: item.at, note: item.note, ...(item.remoteId ? { remoteId: item.remoteId } : {}) })) },
        recordVersion });
    },
    async readMailReplyBatchReview(admission: WorkspaceHttpAdmission, input: { planId: string; jobId: string; accountId: string; expectedConnectionGeneration: number; expectedRevision: number; expectedPrivacyEpoch: number }) {
      admission.assertCurrent();
      const value = await runtime.readMailReplyBatchReview(admission, input);
      admission.assertCurrent();
      return serializeWorkflowRead({ ...readEnvelope(value), ...(value.value ? { plan: { ...value.value.plan, accountId: value.value.accountId,
        connectionGeneration: value.value.connectionGeneration } } : {}) });
    },
    inspectCommand(admission: WorkspaceHttpAdmission, commandId: string): JsonValue {
      return serializeCommandResponse(inspectWorkspaceCommand(runtime, admission, commandId));
    },
    listCommandHistory(admission: WorkspaceHttpAdmission, cursor?: string) {
      admission.assertCurrent();
      const page = runtime.listCommandHistory(admission, cursor);
      admission.assertCurrent();
      return JSON.parse(JSON.stringify(page)) as JsonValue;
    },
    cancelTranscription(admission: WorkspaceHttpAdmission, commandId: string): JsonValue {
      const status = runtime.requestTranscriptionCancellation(admission, commandId);
      return { schemaVersion: 1, commandId, status };
    },
  });
}

function serializeKnowledgeRead(value: Awaited<ReturnType<KnowledgeHttpApi['readKnowledgeSourceChoices']>> | Awaited<ReturnType<KnowledgeHttpApi['readKnowledgeSuggestionReview']>>): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function serializeWorkflowRead(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function readEnvelope(value: { workspaceId: string; privacyEpoch: number; revision: number }) {
  return { schemaVersion: 1 as const, workspaceId: value.workspaceId, privacyEpoch: value.privacyEpoch, revision: value.revision };
}
function safeMailSource(value: import('../core').MailReplySourceSnapshot) {
  return { accountId: value.accountId, connectionGeneration: value.connectionGeneration, localMessageId: value.localMessageId,
    providerMessageId: value.providerMessageId, idFormat: value.idFormat, ...(value.threadId ? { threadId: value.threadId } : {}),
    internetMessageId: value.internetMessageId, subject: value.subject, ...(value.from ? { from: value.from } : {}),
    ...(value.senderEmail ? { senderEmail: value.senderEmail } : {}), ...(value.replyTo ? { replyTo: value.replyTo } : {}),
    ...(value.to ? { to: value.to } : {}), ...(value.cc ? { cc: value.cc } : {}), ...(value.snippet ? { snippet: value.snippet } : {}),
    observedAt: value.observedAt, sourceDigest: value.sourceDigest };
}
function safeProposal(value: import('../core').Proposal) {
  const editableStatus = (value.status === 'draft' || value.status === 'failed' || value.status === 'approved') && !value.supersededByProposalId;
  const mailReply = value.provenance?.version === 2 && value.provenance.kind === 'mail_reply' ||
    value.provenance?.version === 3 && value.provenance.kind === 'manual_mail_reply';
  const acceptedDraftLineage = value.provenance?.version === 3 && value.provenance.kind === 'manual_mail_reply' &&
    value.provenance.lineage.kind === 'accepted_draft' ? value.provenance.lineage : undefined;
  const providerNamespace = value.provenance && 'source' in value.provenance ? value.provenance.source.identity.providerNamespace : undefined;
  const provider = providerNamespace === 'google' || providerNamespace === 'microsoft' ? providerNamespace : undefined;
  const canPromoteDraft = value.kind === 'email' && value.status === 'accepted' && !value.simulated && !value.supersededByProposalId &&
    (value.provenance?.version === 2 && value.provenance.kind === 'mail_reply' || value.provenance?.version === 3 && value.provenance.kind === 'manual_mail_reply') &&
    value.email?.operation === 'draft' && value.remoteOperation === 'draft' && Boolean(value.dispatchRecordId && value.remoteId && provider);
  const editPolicy = !editableStatus ? 'read_only' : acceptedDraftLineage ? 'manual_reply_send_fields' : value.kind === 'event' ? 'event_fields' : value.kind !== 'email' ? 'read_only'
    : value.provenance?.version === 3 ? 'manual_reply_fields'
      : mailReply ? value.provenance?.version === 2 && value.provenance.batchJobId ? 'read_only' : 'source_reply_fields'
        : 'email_fields';
  return { editPolicy, canDeriveManualReply: Boolean(mailReply && !acceptedDraftLineage && editableStatus && value.email?.reply && value.sourceActionKey),
    ...(canPromoteDraft ? { draftPromotion: { draftDispatchRecordId: value.dispatchRecordId!, provider: provider! } } : {}),
    ...(acceptedDraftLineage && provider ? { acceptedDraftCopy: { parentProposalId: acceptedDraftLineage.parentProposalId,
      draftDispatchRecordId: acceptedDraftLineage.draftDispatchRecordId, provider } } : {}),
    ...(value.supersededByProposalId ? { supersededByProposalId: value.supersededByProposalId } : {}),
    id: value.id, kind: value.kind, title: value.title, body: value.body, status: value.status, revision: value.revision,
    ...(value.approvedRevision !== undefined ? { approvedRevision: value.approvedRevision } : {}), ...(value.lastError ? { lastError: value.lastError } : {}),
    ...(value.accountId ? { accountId: value.accountId } : {}), recipients: value.recipients, ...(value.calendarId ? { calendarId: value.calendarId } : {}),
    ...(value.dueAt ? { dueAt: value.dueAt } : {}), ...(value.email ? { email: { operation: value.email.operation, to: value.email.to, cc: value.email.cc,
      bcc: value.email.bcc, subject: value.email.subject, text: value.email.text, attachments: value.email.attachments.map(({ fileName, mimeType, sizeBytes }) => ({ fileName, mimeType, sizeBytes })) } } : {}),
    ...(value.event ? { event: value.event } : {}), ...(value.remoteOperation ? { remoteOperation: value.remoteOperation } : {}),
    ...(value.remoteId ? { remoteId: value.remoteId } : {}), ...(value.remoteAcceptedAt ? { remoteAcceptedAt: value.remoteAcceptedAt } : {}),
    ...(value.provenance && 'sourceDigest' in value.provenance ? { sourceDigest: value.provenance.sourceDigest } : {}) };
}

function serializeSnapshot(snapshot: WorkspaceSnapshotDTO): JsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as JsonValue;
}

function serializeCommandResponse(response: WorkspaceCommandResponse): JsonValue {
  return JSON.parse(JSON.stringify(response)) as JsonValue;
}
