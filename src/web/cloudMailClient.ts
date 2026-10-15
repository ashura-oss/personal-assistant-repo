/** Pure URL helpers for safe saved-mail reads. Fetch ownership stays in WorkspaceClient. */

import type {
  DispatchReviewReadDto,
  MailReplyBatchReviewReadDto,
  MailReplySourceReadDto,
  MailReplyTextSnapshotDto,
  MailReplyTextReadDto,
  ProposalReviewReadDto,
  WorkflowProposalReviewDto,
} from './mailWorkflowDtos';

export type MailWorkflowReadOwner = Readonly<{
  expectedRevision: number;
  expectedPrivacyEpoch: number;
}>;

export type ReplyBatchPlanRead = Readonly<{
  planId: string;
  jobId: string;
  accountId: string;
  expectedConnectionGeneration: number;
}>;

export type ExpectedRead = Readonly<{ workspaceId: string; privacyEpoch: number; revision: number }>;

const SOURCE_STATUSES = ['current', 'stale', 'missing', 'unavailable'] as const;
const PROPOSAL_STATUSES = new Set(['draft', 'approved', 'dispatching', 'unknown', 'failed', 'accepted', 'simulated', 'executed', 'dismissed']);
const WORKFLOW_KINDS = new Set(['email', 'event', 'task', 'memory', 'reminder']);
const RECONCILIATION_DISPOSITIONS = new Set(['confirmed_present', 'not_found', 'abandoned']);
type MailBatchReviewContext = NonNullable<MailReplyBatchReviewReadDto['plan']>['contextMessages'];
type MailBatchReviewContextItem = NonNullable<MailBatchReviewContext>[number];

function row(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mail_workflow_response_invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('mail_workflow_response_invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('mail_workflow_response_invalid');
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('mail_workflow_response_invalid');
  }
  return value as Record<string, unknown>;
}

const boundedText = (value: unknown, max = 16_384, allowEmpty = true): value is string => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown, limit: number, maxEach = 2048): value is readonly string[] =>
  Array.isArray(value) && value.length <= limit && value.every((item) => boundedText(item, maxEach, false));

function envelope(value: unknown, expected: ExpectedRead, extra: readonly string[], requiredExtra: readonly string[]): Record<string, unknown> {
  const record = row(value, ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision', ...extra],
    ['schemaVersion', 'workspaceId', 'privacyEpoch', 'revision', ...requiredExtra]);
  if (record.schemaVersion !== 1 || record.workspaceId !== expected.workspaceId || record.privacyEpoch !== expected.privacyEpoch || record.revision !== expected.revision) {
    throw new Error('mail_workflow_response_stale');
  }
  return record;
}

function parseSource(value: unknown): MailReplySourceReadDto['source'] {
  if (value === undefined) return undefined;
  const source = row(value,
    ['accountId', 'connectionGeneration', 'localMessageId', 'providerMessageId', 'idFormat', 'threadId', 'internetMessageId', 'subject', 'from', 'senderEmail', 'replyTo', 'to', 'cc', 'snippet', 'observedAt', 'sourceDigest'],
    ['accountId', 'connectionGeneration', 'localMessageId', 'providerMessageId', 'idFormat', 'internetMessageId', 'subject', 'observedAt', 'sourceDigest']);
  try {
    opaqueIdentifier(source.accountId as string, 'account_id');
    opaqueIdentifier(source.localMessageId as string, 'message_id');
    opaqueIdentifier(source.providerMessageId as string, 'provider_message_id');
    if (Object.hasOwn(source, 'threadId')) opaqueIdentifier(source.threadId as string, 'thread_id');
  } catch { throw new Error('mail_workflow_response_invalid'); }
  if (typeof source.accountId !== 'string' || !integer(source.connectionGeneration) || typeof source.localMessageId !== 'string' ||
      typeof source.providerMessageId !== 'string' || (source.idFormat !== 'gmail' && source.idFormat !== 'graph-immutable') ||
      !boundedText(source.internetMessageId, 2048) || !boundedText(source.subject, 4096) || !boundedText(source.observedAt, 128, false) ||
      typeof source.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceDigest)) throw new Error('mail_workflow_response_invalid');
  for (const key of ['threadId', 'from', 'senderEmail', 'snippet'] as const) {
    if (Object.hasOwn(source, key) && !boundedText(source[key], key === 'snippet' ? 4096 : 2048)) throw new Error('mail_workflow_response_invalid');
  }
  for (const key of ['replyTo', 'to', 'cc'] as const) {
    if (Object.hasOwn(source, key) && !strings(source[key], 100)) throw new Error('mail_workflow_response_invalid');
  }
  return Object.freeze({
    accountId: source.accountId as string,
    connectionGeneration: source.connectionGeneration as number,
    localMessageId: source.localMessageId as string,
    providerMessageId: source.providerMessageId as string,
    idFormat: source.idFormat as 'gmail' | 'graph-immutable',
    ...(Object.hasOwn(source, 'threadId') ? { threadId: source.threadId as string } : {}),
    internetMessageId: source.internetMessageId as string,
    subject: source.subject as string,
    ...(Object.hasOwn(source, 'from') ? { from: source.from as string } : {}),
    ...(Object.hasOwn(source, 'senderEmail') ? { senderEmail: source.senderEmail as string } : {}),
    ...(Object.hasOwn(source, 'replyTo') ? { replyTo: Object.freeze([...(source.replyTo as string[])]) } : {}),
    ...(Object.hasOwn(source, 'to') ? { to: Object.freeze([...(source.to as string[])]) } : {}),
    ...(Object.hasOwn(source, 'cc') ? { cc: Object.freeze([...(source.cc as string[])]) } : {}),
    ...(Object.hasOwn(source, 'snippet') ? { snippet: source.snippet as string } : {}),
    observedAt: source.observedAt as string,
    sourceDigest: source.sourceDigest as string,
  });
}

function parseDefaults(value: unknown): MailReplySourceReadDto['defaults'] {
  if (value === undefined) return undefined;
  const defaults = row(value, ['reply', 'reply_all'], ['reply', 'reply_all']);
  const mode = (item: unknown) => {
    const recipients = row(item, ['to', 'cc'], ['to', 'cc']);
    if (!strings(recipients.to, 100) || !strings(recipients.cc, 100)) throw new Error('mail_workflow_response_invalid');
    return Object.freeze({ to: Object.freeze([...(recipients.to as string[])]), cc: Object.freeze([...(recipients.cc as string[])]) });
  };
  return Object.freeze({ reply: mode(defaults.reply), reply_all: mode(defaults.reply_all) });
}

function parseBodyCache(value: unknown): MailReplySourceReadDto['bodyCache'] {
  const cache = row(value, ['status', 'textDigest', 'bytes', 'completeness', 'representation', 'checkedAt'], ['status']);
  if (!(SOURCE_STATUSES as readonly unknown[]).includes(cache.status) ||
      (Object.hasOwn(cache, 'textDigest') && (typeof cache.textDigest !== 'string' || !/^[a-f0-9]{64}$/.test(cache.textDigest))) ||
      (Object.hasOwn(cache, 'bytes') && !integer(cache.bytes)) ||
      (Object.hasOwn(cache, 'completeness') && (typeof cache.completeness !== 'string' || !['complete_text', 'excerpt', 'unavailable'].includes(cache.completeness))) ||
      (Object.hasOwn(cache, 'representation') && (typeof cache.representation !== 'string' || !['plain', 'converted_html', 'snippet', 'none'].includes(cache.representation))) ||
      (Object.hasOwn(cache, 'checkedAt') && !boundedText(cache.checkedAt, 128, false))) throw new Error('mail_workflow_response_invalid');
  return Object.freeze({ status: cache.status as MailReplySourceReadDto['bodyCache']['status'],
    ...(Object.hasOwn(cache, 'textDigest') ? { textDigest: cache.textDigest as string } : {}), ...(Object.hasOwn(cache, 'bytes') ? { bytes: cache.bytes as number } : {}),
    ...(Object.hasOwn(cache, 'completeness') ? { completeness: cache.completeness as MailReplySourceReadDto['bodyCache']['completeness'] } : {}),
    ...(Object.hasOwn(cache, 'representation') ? { representation: cache.representation as MailReplySourceReadDto['bodyCache']['representation'] } : {}),
    ...(Object.hasOwn(cache, 'checkedAt') ? { checkedAt: cache.checkedAt as string } : {}) });
}

function stringArray(value: unknown, label: string, limit = 500): readonly string[] {
  if (!strings(value, limit)) throw new Error('mail_workflow_response_invalid');
  return Object.freeze([...(value as string[])]);
}

function parseAttachments(value: unknown): NonNullable<WorkflowProposalReviewDto['email']>['attachments'] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('mail_workflow_response_invalid');
  return Object.freeze(value.map((raw) => {
    const item = row(raw, ['fileName', 'mimeType', 'sizeBytes'], ['fileName', 'mimeType', 'sizeBytes']);
    if (!boundedText(item.fileName, 512, false) || !boundedText(item.mimeType, 256, false) || !integer(item.sizeBytes)) throw new Error('mail_workflow_response_invalid');
    return Object.freeze({ fileName: item.fileName as string, mimeType: item.mimeType as string, sizeBytes: item.sizeBytes as number });
  }));
}

function parseProposal(value: unknown): WorkflowProposalReviewDto {
  const proposal = row(value,
    ['editPolicy', 'id', 'kind', 'title', 'body', 'status', 'revision', 'approvedRevision', 'lastError', 'accountId', 'recipients', 'calendarId', 'dueAt', 'email', 'event', 'remoteOperation', 'remoteId', 'remoteAcceptedAt', 'sourceDigest'],
    ['editPolicy', 'id', 'kind', 'title', 'body', 'status', 'revision', 'recipients']);
  if (typeof proposal.editPolicy !== 'string' || !['email_fields', 'source_reply_fields', 'event_fields', 'read_only'].includes(proposal.editPolicy) ||
      !boundedText(proposal.id, 1024, false) || typeof proposal.kind !== 'string' || !WORKFLOW_KINDS.has(proposal.kind) || !boundedText(proposal.title, 4096) ||
      !boundedText(proposal.body, 100_000) || typeof proposal.status !== 'string' || !PROPOSAL_STATUSES.has(proposal.status) || !integer(proposal.revision) ||
      (Object.hasOwn(proposal, 'approvedRevision') && !integer(proposal.approvedRevision)) || !strings(proposal.recipients, 200) ||
      (Object.hasOwn(proposal, 'accountId') && !boundedText(proposal.accountId, 1024, false)) ||
      (Object.hasOwn(proposal, 'calendarId') && !boundedText(proposal.calendarId, 1024, false)) ||
      (Object.hasOwn(proposal, 'dueAt') && !boundedText(proposal.dueAt, 128, false)) ||
      (Object.hasOwn(proposal, 'lastError') && !boundedText(proposal.lastError, 4096)) ||
      (Object.hasOwn(proposal, 'remoteOperation') && (typeof proposal.remoteOperation !== 'string' || !['draft', 'send', 'event'].includes(proposal.remoteOperation))) ||
      (Object.hasOwn(proposal, 'remoteId') && !boundedText(proposal.remoteId, 1024, false)) ||
      (Object.hasOwn(proposal, 'remoteAcceptedAt') && !boundedText(proposal.remoteAcceptedAt, 128, false)) ||
      (Object.hasOwn(proposal, 'sourceDigest') && (typeof proposal.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(proposal.sourceDigest)))) throw new Error('mail_workflow_response_invalid');

  let email: WorkflowProposalReviewDto['email'];
  if (proposal.email !== undefined) {
    const item = row(proposal.email, ['operation', 'to', 'cc', 'bcc', 'subject', 'text', 'attachments'], ['to', 'cc', 'bcc', 'subject', 'text', 'attachments']);
    if ((Object.hasOwn(item, 'operation') && item.operation !== 'draft' && item.operation !== 'send') ||
        !strings(item.to, 100) || !strings(item.cc, 100) || !strings(item.bcc, 100) || !boundedText(item.subject, 4096) || !boundedText(item.text, 100_000)) {
      throw new Error('mail_workflow_response_invalid');
    }
    email = Object.freeze({ ...(Object.hasOwn(item, 'operation') ? { operation: item.operation as 'draft' | 'send' } : {}),
      to: stringArray(item.to, 'to', 100), cc: stringArray(item.cc, 'cc', 100), bcc: stringArray(item.bcc, 'bcc', 100),
      subject: item.subject as string, text: item.text as string, attachments: parseAttachments(item.attachments) });
  }

  let event: WorkflowProposalReviewDto['event'];
  if (proposal.event !== undefined) {
    const item = row(proposal.event, ['title', 'description', 'start', 'end', 'timeZone', 'attendees', 'invitePolicy'], ['start', 'end', 'timeZone', 'attendees', 'invitePolicy']);
    if ((Object.hasOwn(item, 'title') && !boundedText(item.title, 4096)) || (Object.hasOwn(item, 'description') && !boundedText(item.description, 100_000)) ||
        !boundedText(item.start, 128, false) || !boundedText(item.end, 128, false) || !boundedText(item.timeZone, 256, false) || !strings(item.attendees, 100) ||
        (item.invitePolicy !== 'send' && item.invitePolicy !== 'none')) throw new Error('mail_workflow_response_invalid');
    event = Object.freeze({ ...(Object.hasOwn(item, 'title') ? { title: item.title as string } : {}), ...(Object.hasOwn(item, 'description') ? { description: item.description as string } : {}),
      start: item.start as string, end: item.end as string, timeZone: item.timeZone as string, attendees: stringArray(item.attendees, 'attendees', 100), invitePolicy: item.invitePolicy });
  }
  if ((proposal.kind === 'email' && !email) || (proposal.kind === 'event' && !event) || (email && event)) throw new Error('mail_workflow_response_invalid');
  return Object.freeze({ editPolicy: proposal.editPolicy as WorkflowProposalReviewDto['editPolicy'], id: proposal.id as string, kind: proposal.kind as WorkflowProposalReviewDto['kind'], title: proposal.title as string, body: proposal.body as string,
    status: proposal.status as WorkflowProposalReviewDto['status'], revision: proposal.revision as number,
    ...(Object.hasOwn(proposal, 'approvedRevision') ? { approvedRevision: proposal.approvedRevision as number } : {}),
    ...(Object.hasOwn(proposal, 'lastError') ? { lastError: proposal.lastError as string } : {}),
    ...(Object.hasOwn(proposal, 'accountId') ? { accountId: proposal.accountId as string } : {}), recipients: stringArray(proposal.recipients, 'recipients', 200),
    ...(Object.hasOwn(proposal, 'calendarId') ? { calendarId: proposal.calendarId as string } : {}), ...(Object.hasOwn(proposal, 'dueAt') ? { dueAt: proposal.dueAt as string } : {}),
    ...(email ? { email } : {}), ...(event ? { event } : {}), ...(Object.hasOwn(proposal, 'remoteOperation') ? { remoteOperation: proposal.remoteOperation as 'draft' | 'send' | 'event' } : {}),
    ...(Object.hasOwn(proposal, 'remoteId') ? { remoteId: proposal.remoteId as string } : {}), ...(Object.hasOwn(proposal, 'remoteAcceptedAt') ? { remoteAcceptedAt: proposal.remoteAcceptedAt as string } : {}),
    ...(Object.hasOwn(proposal, 'sourceDigest') ? { sourceDigest: proposal.sourceDigest as string } : {}) });
}

export function parseCloudProposalReview(value: unknown, expected: ExpectedRead, proposalId: string): ProposalReviewReadDto {
  const read = envelope(value, expected, ['proposal'], []);
  const proposal = read.proposal === undefined ? undefined : parseProposal(read.proposal);
  if (proposal && (proposal.id !== proposalId || proposal.revision < 1)) throw new Error('mail_workflow_response_object_mismatch');
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision,
    ...(proposal ? { proposal } : {}) });
}

export function parseCloudDispatchReview(value: unknown, expected: ExpectedRead, recordId: string): DispatchReviewReadDto {
  const read = envelope(value, expected, ['record', 'recordVersion'], []);
  if (read.record === undefined) return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision });
  const record = row(read.record, ['id', 'proposalId', 'accountId', 'account', 'calendar', 'operation', 'title', 'body', 'payload', 'outcome', 'dispatchStartedAt', 'outcomeAt', 'remoteId', 'rejectionCode', 'reconciliations'],
    ['id', 'proposalId', 'accountId', 'account', 'operation', 'title', 'body', 'payload', 'outcome', 'dispatchStartedAt', 'reconciliations']);
  const account = row(record.account, ['provider', 'displayName', 'email'], ['provider', 'displayName', 'email']);
  if (!boundedText(account.displayName, 2048) || !boundedText(account.email, 2048) || typeof account.provider !== 'string' || !['google', 'microsoft'].includes(account.provider)) throw new Error('mail_workflow_response_invalid');
  let calendar: Readonly<{ localId: string; providerId: string; name: string }> | undefined;
  if (record.calendar !== undefined) {
    const item = row(record.calendar, ['localId', 'providerId', 'name'], ['localId', 'providerId', 'name']);
    if (!boundedText(item.localId, 1024, false) || !boundedText(item.providerId, 1024, false) || !boundedText(item.name, 2048)) throw new Error('mail_workflow_response_invalid');
    calendar = Object.freeze({ localId: item.localId as string, providerId: item.providerId as string, name: item.name as string });
  }
  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) throw new Error('mail_workflow_response_invalid');
  const rawPayload = record.payload as Record<string, unknown>;
  const payload = rawPayload.kind === 'email'
    ? row(rawPayload, ['kind', 'to', 'cc', 'bcc', 'subject', 'text', 'attachments'], ['kind', 'to', 'cc', 'bcc', 'subject', 'text', 'attachments'])
    : rawPayload.kind === 'event'
      ? row(rawPayload, ['kind', 'title', 'description', 'start', 'end', 'timeZone', 'attendees', 'invitePolicy'], ['kind', 'start', 'end', 'timeZone', 'attendees', 'invitePolicy'])
      : (() => { throw new Error('mail_workflow_response_invalid'); })();
  let parsedPayload: NonNullable<DispatchReviewReadDto['record']>['payload'];
  if (payload.kind === 'email') {
    if (!strings(payload.to, 100) || !strings(payload.cc, 100) || !strings(payload.bcc, 100) || !boundedText(payload.subject, 4096) || !boundedText(payload.text, 100_000)) throw new Error('mail_workflow_response_invalid');
    parsedPayload = Object.freeze({ kind: 'email', to: stringArray(payload.to, 'to', 100), cc: stringArray(payload.cc, 'cc', 100), bcc: stringArray(payload.bcc, 'bcc', 100),
      subject: payload.subject as string, text: payload.text as string, attachments: parseAttachments(payload.attachments) });
  } else if (payload.kind === 'event') {
    if ((Object.hasOwn(payload, 'title') && !boundedText(payload.title, 4096)) || (Object.hasOwn(payload, 'description') && !boundedText(payload.description, 100_000)) ||
        !boundedText(payload.start, 128, false) || !boundedText(payload.end, 128, false) || !boundedText(payload.timeZone, 256, false) || !strings(payload.attendees, 100) ||
        (payload.invitePolicy !== 'send' && payload.invitePolicy !== 'none')) throw new Error('mail_workflow_response_invalid');
    parsedPayload = Object.freeze({ kind: 'event', ...(Object.hasOwn(payload, 'title') ? { title: payload.title as string } : {}),
      ...(Object.hasOwn(payload, 'description') ? { description: payload.description as string } : {}), start: payload.start as string, end: payload.end as string,
      timeZone: payload.timeZone as string, attendees: stringArray(payload.attendees, 'attendees', 100), invitePolicy: payload.invitePolicy });
  } else throw new Error('mail_workflow_response_invalid');

  if (record.id !== recordId || !boundedText(record.proposalId, 1024, false) || !boundedText(record.accountId, 1024, false) ||
      typeof record.operation !== 'string' || !['draft', 'send', 'event'].includes(record.operation) || !boundedText(record.title, 4096) || !boundedText(record.body, 100_000) ||
      typeof record.outcome !== 'string' || !['pending', 'accepted', 'unknown', 'rejected'].includes(record.outcome) || !boundedText(record.dispatchStartedAt, 128, false) ||
      (Object.hasOwn(record, 'outcomeAt') && !boundedText(record.outcomeAt, 128, false)) || (Object.hasOwn(record, 'remoteId') && !boundedText(record.remoteId, 1024, false)) ||
      (Object.hasOwn(record, 'rejectionCode') && !boundedText(record.rejectionCode, 256, false)) || !Array.isArray(record.reconciliations) || record.reconciliations.length > 100) {
    throw new Error('mail_workflow_response_invalid');
  }
  const reconciliations = record.reconciliations.map((value) => {
    const item = row(value, ['disposition', 'at', 'note', 'remoteId'], ['disposition', 'at', 'note']);
    if (typeof item.disposition !== 'string' || !RECONCILIATION_DISPOSITIONS.has(item.disposition) || !boundedText(item.at, 128, false) || !boundedText(item.note, 4096) ||
        (Object.hasOwn(item, 'remoteId') && !boundedText(item.remoteId, 1024, false))) throw new Error('mail_workflow_response_invalid');
    return Object.freeze({ disposition: item.disposition as 'confirmed_present' | 'not_found' | 'abandoned', at: item.at as string, note: item.note as string,
      ...(Object.hasOwn(item, 'remoteId') ? { remoteId: item.remoteId as string } : {}) });
  });
  if (typeof read.recordVersion !== 'string' || !/^[a-f0-9]{64}$/.test(read.recordVersion) ||
      ((record.operation === 'event') !== (payload.kind === 'event'))) throw new Error('mail_workflow_response_invalid');
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision, recordVersion: read.recordVersion as string,
    record: Object.freeze({ id: record.id as string, proposalId: record.proposalId as string, accountId: record.accountId as string,
      account: Object.freeze({ provider: account.provider as 'google' | 'microsoft', displayName: account.displayName as string, email: account.email as string }),
      ...(calendar ? { calendar } : {}), operation: record.operation as 'draft' | 'send' | 'event', title: record.title as string, body: record.body as string, payload: parsedPayload,
      outcome: record.outcome as 'pending' | 'accepted' | 'unknown' | 'rejected', dispatchStartedAt: record.dispatchStartedAt as string,
      ...(Object.hasOwn(record, 'outcomeAt') ? { outcomeAt: record.outcomeAt as string } : {}), ...(Object.hasOwn(record, 'remoteId') ? { remoteId: record.remoteId as string } : {}),
      ...(Object.hasOwn(record, 'rejectionCode') ? { rejectionCode: record.rejectionCode as string } : {}), reconciliations: Object.freeze(reconciliations) }) });
}

export function parseCloudReplyBatchReview(value: unknown, expected: ExpectedRead, requested: ReplyBatchPlanRead): MailReplyBatchReviewReadDto {
  const read = envelope(value, expected, ['plan'], []);
  if (read.plan === undefined) return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision });
  const plan = row(read.plan, ['planId', 'jobId', 'messageId', 'accountId', 'connectionGeneration', 'mode', 'operation', 'subject', 'to', 'cc', 'text', 'expiresAt', 'contextMessages'],
    ['planId', 'jobId', 'messageId', 'accountId', 'connectionGeneration', 'mode', 'operation', 'subject', 'to', 'cc', 'text', 'expiresAt']);
  if (plan.planId !== requested.planId || plan.jobId !== requested.jobId || plan.accountId !== requested.accountId || plan.connectionGeneration !== requested.expectedConnectionGeneration ||
      !boundedText(plan.messageId, 1024, false) || (plan.mode !== 'reply' && plan.mode !== 'reply_all') || (plan.operation !== 'draft' && plan.operation !== 'send') ||
      !boundedText(plan.subject, 4096) || !strings(plan.to, 100) || !strings(plan.cc, 100) || !boundedText(plan.text, 100_000) || !boundedText(plan.expiresAt, 128, false)) {
    throw new Error('mail_workflow_response_object_mismatch');
  }
  let contextMessages: MailBatchReviewContext;
  if (plan.contextMessages !== undefined) {
    if (!Array.isArray(plan.contextMessages) || plan.contextMessages.length > 100) throw new Error('mail_workflow_response_invalid');
    contextMessages = Object.freeze(plan.contextMessages.map((raw) => {
      const context = row(raw, ['selectionId', 'subject', 'sender', 'receivedAt', 'sentAt', 'representation', 'completeness', 'bytes', 'omissionReasons'],
        ['selectionId', 'subject', 'representation', 'completeness', 'bytes', 'omissionReasons']);
      if (!boundedText(context.selectionId, 1024, false) || !boundedText(context.subject, 4096) || (Object.hasOwn(context, 'sender') && !boundedText(context.sender, 2048)) ||
          (Object.hasOwn(context, 'receivedAt') && !boundedText(context.receivedAt, 128, false)) || (Object.hasOwn(context, 'sentAt') && !boundedText(context.sentAt, 128, false)) ||
          typeof context.representation !== 'string' || !['plain', 'converted_html', 'snippet', 'none'].includes(context.representation) ||
          typeof context.completeness !== 'string' || !['complete_text', 'excerpt', 'unavailable'].includes(context.completeness) ||
          !integer(context.bytes) || !Array.isArray(context.omissionReasons) || context.omissionReasons.length > 16 ||
          context.omissionReasons.some((reason) => !boundedText(reason, 240, false))) throw new Error('mail_workflow_response_invalid');
      return Object.freeze({ selectionId: context.selectionId as string, subject: context.subject as string, ...(Object.hasOwn(context, 'sender') ? { sender: context.sender as string } : {}),
        ...(Object.hasOwn(context, 'receivedAt') ? { receivedAt: context.receivedAt as string } : {}), ...(Object.hasOwn(context, 'sentAt') ? { sentAt: context.sentAt as string } : {}),
        representation: context.representation as MailBatchReviewContextItem['representation'],
        completeness: context.completeness as MailBatchReviewContextItem['completeness'],
        bytes: context.bytes as number, omissionReasons: Object.freeze([...(context.omissionReasons as string[])]) });
    }));
  }
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision, plan: Object.freeze({
    planId: plan.planId as string, jobId: plan.jobId as string, messageId: plan.messageId as string, accountId: plan.accountId as string, connectionGeneration: plan.connectionGeneration as number,
    mode: plan.mode as 'reply' | 'reply_all', operation: plan.operation as 'draft' | 'send', subject: plan.subject as string,
    to: stringArray(plan.to, 'to', 100), cc: stringArray(plan.cc, 'cc', 100), text: plan.text as string, expiresAt: plan.expiresAt as string,
    ...(contextMessages ? { contextMessages } : {}) }) });
}

export function parseCloudMailReplySource(value: unknown, expected: ExpectedRead, requestedMessageId: string): MailReplySourceReadDto {
  const read = envelope(value, expected, ['status', 'source', 'defaults', 'bodyCache'], ['status', 'bodyCache']);
  if (!(SOURCE_STATUSES as readonly unknown[]).includes(read.status)) throw new Error('mail_workflow_response_invalid');
  const source = parseSource(read.source);
  if (source && source.localMessageId !== requestedMessageId) throw new Error('mail_workflow_response_object_mismatch');
  const bodyCache = parseBodyCache(read.bodyCache);
  const defaults = parseDefaults(read.defaults);
  if (read.status === 'current' && (!source || !defaults)) throw new Error('mail_workflow_response_invalid');
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision,
    status: read.status as MailReplySourceReadDto['status'], ...(source ? { source } : {}), ...(defaults ? { defaults } : {}), bodyCache });
}

export function parseCloudMailReplyText(value: unknown, expected: ExpectedRead, requestedMessageId: string,
  source: NonNullable<MailReplySourceReadDto['source']>): MailReplyTextReadDto {
  const read = envelope(value, expected, ['status', 'snapshot'], ['status']);
  if (!(SOURCE_STATUSES as readonly unknown[]).includes(read.status)) throw new Error('mail_workflow_response_invalid');
  let snapshot: MailReplyTextSnapshotDto | undefined;
  if (read.snapshot !== undefined) {
    const item = row(read.snapshot, ['messageId', 'accountId', 'connectionGeneration', 'sourceDigest', 'checkedAt', 'text', 'textDigest', 'bytes', 'extractionVersion', 'representation', 'completeness', 'omissionReasons'],
      ['messageId', 'accountId', 'connectionGeneration', 'sourceDigest', 'checkedAt', 'bytes', 'extractionVersion', 'representation', 'completeness', 'omissionReasons']);
    if (!boundedText(item.messageId, 1024, false) || item.messageId !== requestedMessageId || item.accountId !== source.accountId || item.connectionGeneration !== source.connectionGeneration ||
        typeof item.sourceDigest !== 'string' || item.sourceDigest !== source.sourceDigest || !boundedText(item.checkedAt, 128, false) ||
        (Object.hasOwn(item, 'text') && !boundedText(item.text, 256 * 1024)) ||
        (Object.hasOwn(item, 'textDigest') && (typeof item.textDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.textDigest))) || !integer(item.bytes) || item.bytes > 256 * 1024 ||
        (Object.hasOwn(item, 'text') && new TextEncoder().encode(item.text as string).byteLength !== item.bytes) ||
        (item.extractionVersion !== 'mail-text-v1' && item.extractionVersion !== 'mail-text-v2') ||
        typeof item.representation !== 'string' || !['plain', 'converted_html', 'snippet', 'none'].includes(item.representation) ||
        typeof item.completeness !== 'string' || !['complete_text', 'excerpt', 'unavailable'].includes(item.completeness) ||
        !Array.isArray(item.omissionReasons) || item.omissionReasons.length > 16 || item.omissionReasons.some((reason) => !boundedText(reason, 240, false))) {
      throw new Error('mail_workflow_response_invalid');
    }
    snapshot = Object.freeze({ messageId: item.messageId as string, accountId: item.accountId as string, connectionGeneration: item.connectionGeneration as number,
      sourceDigest: item.sourceDigest as string, checkedAt: item.checkedAt as string, ...(Object.hasOwn(item, 'text') ? { text: item.text as string } : {}),
      ...(Object.hasOwn(item, 'textDigest') ? { textDigest: item.textDigest as string } : {}), bytes: item.bytes as number,
      extractionVersion: item.extractionVersion as MailReplyTextSnapshotDto['extractionVersion'], representation: item.representation as MailReplyTextSnapshotDto['representation'],
      completeness: item.completeness as MailReplyTextSnapshotDto['completeness'],
      omissionReasons: Object.freeze([...(item.omissionReasons as string[])]) });
  }
  if (read.status === 'current' && !snapshot) throw new Error('mail_workflow_response_invalid');
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision,
    status: read.status as MailReplyTextReadDto['status'], ...(snapshot ? { snapshot } : {}) });
}

function queryPath(path: string, values: Readonly<Record<string, string | number>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) query.set(key, String(value));
  return `${path}?${query.toString()}`;
}

function ownerValues(owner: MailWorkflowReadOwner): Readonly<Record<string, number>> {
  if (!Number.isSafeInteger(owner.expectedRevision) || owner.expectedRevision < 0 ||
      !Number.isSafeInteger(owner.expectedPrivacyEpoch) || owner.expectedPrivacyEpoch < 0) {
    throw new Error('mail_read_owner_invalid');
  }
  return { expectedRevision: owner.expectedRevision, expectedPrivacyEpoch: owner.expectedPrivacyEpoch };
}

function opaqueIdentifier(value: string, field: string): string {
  if (!boundedText(value, 1024, false) || /[\u0000-\u001f\u007f]/u.test(value) || new TextEncoder().encode(value).byteLength > 1024) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

/** Build an exact saved-only read URL. URLSearchParams performs the sole encoding pass. */
export function cloudMailReadPath(
  kind: 'source' | 'source-text',
  messageId: string,
  owner: MailWorkflowReadOwner,
): string {
  const path = kind === 'source' ? '/api/workspace/mail/source' : '/api/workspace/mail/source-text';
  return queryPath(path, { messageId: opaqueIdentifier(messageId, 'message_id'), ...ownerValues(owner) });
}

export function cloudProposalReviewPath(proposalId: string, owner: MailWorkflowReadOwner): string {
  return queryPath('/api/workspace/proposals/review', { proposalId: opaqueIdentifier(proposalId, 'proposal_id'), ...ownerValues(owner) });
}

export function cloudDispatchReviewPath(recordId: string, owner: MailWorkflowReadOwner): string {
  return queryPath('/api/workspace/dispatch/review', { recordId: opaqueIdentifier(recordId, 'record_id'), ...ownerValues(owner) });
}

export function cloudReplyBatchReviewPath(plan: ReplyBatchPlanRead, owner: MailWorkflowReadOwner): string {
  if (!Number.isSafeInteger(plan.expectedConnectionGeneration) || plan.expectedConnectionGeneration < 0) {
    throw new Error('connection_generation_invalid');
  }
  return queryPath('/api/workspace/mail/reply-batch/review', {
    planId: opaqueIdentifier(plan.planId, 'plan_id'),
    jobId: opaqueIdentifier(plan.jobId, 'job_id'),
    accountId: opaqueIdentifier(plan.accountId, 'account_id'),
    expectedConnectionGeneration: plan.expectedConnectionGeneration,
    ...ownerValues(owner),
  });
}
