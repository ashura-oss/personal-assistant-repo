import type { Account, AnyProposalProvenance, Calendar, EmailProposalPayload, EventProposalPayload, ManualMailReplyProvenance, MailReplySourceSnapshot, NoteProposalProvenance, Proposal } from '../core';
import { canonicalMailReplySource, validateReplyBinding } from '../mailReply';
import type {
  CreateDispatchRecordInput, DispatchAccountSnapshot, DispatchCalendarSnapshot, DispatchIdentitySnapshot,
  DispatchOperation, DispatchOutcomeInput, DispatchPayload, DispatchRecord, DispatchReconciliationAttestation,
} from './types';
export type {
  ApprovedEmailPayload, ApprovedEventPayload, CreateDispatchRecordInput, DispatchAccountSnapshot,
  DispatchCalendarSnapshot, DispatchIdentitySnapshot, DispatchOperation, DispatchOutcome,
  DispatchOutcomeInput, DispatchPayload, DispatchRecord, DispatchReconciliation,
  DispatchReconciliationAttestation,
} from './types';

const HASH = /^[a-f0-9]{64}$/i;
const VERSION = /^(0|[1-9]\d*):[a-f0-9]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BATCH_JOB_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fail(message: string): never { throw new Error(message); }
function onlyKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(`${label} contains unsupported fields.`);
}
function cleanString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function validUnicodeScalarString(value: string): boolean {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) === value; }
  catch { return false; }
}
function contentString(value: unknown, label: string, max: number, allowEmpty = false, unlimited = false): string {
  if (typeof value !== 'string' || (!unlimited && value.length > max) || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
function email(value: unknown, label: string): string {
  const result = cleanString(value, label, 320);
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(result)) fail(`${label} is invalid.`);
  return result;
}
function canonicalTime(value: unknown, label: string): string {
  const result = cleanString(value, label, 40);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) fail(`${label} must be a canonical UTC timestamp.`);
  return result;
}
function validTimeZone(value: string, label: string): string {
  const result = cleanString(value, label, 128);
  try { new Intl.DateTimeFormat('en', { timeZone: result }).format(0); } catch { fail(`${label} is invalid.`); }
  return result;
}
function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} is invalid.`);
}

function snapshotIdentity(account: Account): DispatchIdentitySnapshot {
  const identity = account.identity;
  if (!identity?.providerNamespace || !identity.clientId || !identity.subject || identity.providerNamespace !== account.provider) {
    return fail('Dispatch account identity is incomplete or mismatched.');
  }
  if (account.provider === 'microsoft' && !identity.resourceUserId) return fail('Microsoft dispatch identity must include its Graph resource user ID.');
  const projected: DispatchIdentitySnapshot = {
    providerNamespace: identity.providerNamespace,
    clientId: cleanString(identity.clientId, 'Provider client ID', 512),
    subject: cleanString(identity.subject, 'Provider subject', 1024),
    ...(identity.issuer ? { issuer: cleanString(identity.issuer, 'Identity issuer', 2048) } : {}),
    ...(identity.tenantId ? { tenantId: cleanString(identity.tenantId, 'Identity tenant', 128) } : {}),
    ...(identity.resourceUserId ? { resourceUserId: cleanString(identity.resourceUserId, 'Resource user ID', 1024) } : {}),
  };
  return projected;
}

function identityActionKey(identity: DispatchIdentitySnapshot, sourceActionKey: string, operation: DispatchOperation): string {
  // JSON tuple encoding avoids ambiguous delimiter collisions and excludes account ID and reconnect generation.
  return JSON.stringify(['dispatch-v1', identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? '', sourceActionKey, operation]);
}

function sourceList(value: unknown, label: string, inputPolicyVersion: 1 | 2 = 1): NoteProposalProvenance['sources'] {
  if (!Array.isArray(value) || inputPolicyVersion !== 2 && value.length > 200) fail(`${label} is invalid.`);
  const result = value.map((raw) => {
    if (!raw || typeof raw !== 'object') fail(`${label} is invalid.`);
    const item = raw as Record<string, unknown>;
    onlyKeys(item, ['sourceId', 'revision', 'sourceVersion'], label);
    const sourceId = cleanString(item.sourceId, 'Provenance source ID', 512);
    assertRevision(item.revision, 'Provenance source revision');
    const sourceVersion = cleanString(item.sourceVersion, 'Provenance source version', 128);
    const match = VERSION.exec(sourceVersion);
    if (!match || Number(match[1]) !== item.revision) fail('Provenance source version does not match its revision.');
    return { sourceId, revision: item.revision, sourceVersion };
  });
  if (new Set(result.map((item) => item.sourceId)).size !== result.length) fail(`${label} source IDs must be unique.`);
  return result;
}

function knowledgeSelection(value: unknown, inputPolicyVersion: 1 | 2 = 1): NonNullable<NoteProposalProvenance['knowledgeSelection']> {
  if (!Array.isArray(value) || inputPolicyVersion !== 2 && value.length > 5) fail('Provenance knowledge selection is invalid.');
  const result = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Provenance knowledge selection is invalid.');
    const item = raw as Record<string, unknown>;
    onlyKeys(item, ['kind', 'id'], 'Provenance knowledge selection');
    if ((item.kind !== 'person' && item.kind !== 'project') || typeof item.id !== 'string' || !UUID.test(item.id)) fail('Provenance knowledge selection is invalid.');
    return { kind: item.kind, id: item.id } as { kind: 'person' | 'project'; id: string };
  });
  const keys = result.map(({ kind, id }) => `${kind}:${id}`);
  if (new Set(keys).size !== keys.length) fail('Provenance knowledge selection must be unique.');
  return result;
}

function snapshotProvenance(value: AnyProposalProvenance | undefined): AnyProposalProvenance {
  if (!value) return fail('Dispatch source provenance is missing or unsupported.');
  if (value.version === 2 && value.kind === 'mail_reply') {
    onlyKeys(value, ['version', 'kind', 'sourceDigest', 'source', 'expiresAt', 'batchJobId', 'outputPolicyVersion'], 'Mail reply provenance');
    if (value.outputPolicyVersion !== undefined && value.outputPolicyVersion !== 1 && value.outputPolicyVersion !== 2) fail('Mail reply output policy version is invalid.');
    if (value.batchJobId !== undefined && (typeof value.batchJobId !== 'string' || value.batchJobId.length !== 36 || !BATCH_JOB_UUID_V4.test(value.batchJobId))) {
      fail('Mail reply Batch job reference is invalid.');
    }
    const source = value.source;
    onlyKeys(source, ['version', 'accountId', 'accountEmail', 'verifiedSelfEmail', 'identity', 'connectionGeneration', 'localMessageId', 'providerMessageId', 'idFormat', 'providerVersion', 'threadId', 'internetMessageId', 'references', 'inReplyTo', 'subject', 'from', 'senderEmail', 'replyTo', 'to', 'cc', 'snippet', 'replyMetadataComplete', 'observedAt', 'sourceDigest'], 'Mail reply source');
    onlyKeys(source.identity, ['providerNamespace', 'clientId', 'subject', 'issuer', 'tenantId', 'resourceUserId'], 'Mail reply account identity');
    if (!HASH.test(value.sourceDigest) || source.sourceDigest.toLowerCase() !== value.sourceDigest.toLowerCase() ||
        canonicalTime(value.expiresAt, 'Mail reply expiry') !== new Date(Date.parse(source.observedAt) + 15 * 60_000).toISOString()) {
      fail('Mail reply provenance has invalid digest or expiry.');
    }
    canonicalMailReplySource(source);
    return structuredClone(value);
  }
  if (value.version === 3 && value.kind === 'manual_mail_reply') {
    onlyKeys(value, ['version', 'kind', 'sourceDigest', 'source', 'expiresAt', 'outputPolicyVersion', 'operation', 'lineage'], 'Manual mail reply provenance');
    if (value.outputPolicyVersion !== 2 || !['draft', 'send'].includes(value.operation) || !HASH.test(value.sourceDigest)) fail('Manual mail reply provenance is invalid.');
    const source = value.source;
    onlyKeys(source, ['version', 'accountId', 'accountEmail', 'verifiedSelfEmail', 'identity', 'connectionGeneration', 'localMessageId', 'providerMessageId', 'idFormat', 'providerVersion', 'threadId', 'internetMessageId', 'references', 'inReplyTo', 'subject', 'from', 'senderEmail', 'replyTo', 'to', 'cc', 'snippet', 'replyMetadataComplete', 'observedAt', 'sourceDigest'], 'Mail reply source');
    onlyKeys(source.identity, ['providerNamespace', 'clientId', 'subject', 'issuer', 'tenantId', 'resourceUserId'], 'Mail reply account identity');
    if (source.sourceDigest.toLowerCase() !== value.sourceDigest.toLowerCase() || source.replyMetadataComplete !== true ||
        canonicalTime(value.expiresAt, 'Mail reply expiry') !== new Date(Date.parse(source.observedAt) + 15 * 60_000).toISOString()) fail('Manual mail reply source digest or expiry is invalid.');
    canonicalMailReplySource(source);
    const lineage = value.lineage as ManualMailReplyProvenance['lineage'];
    if (!lineage || typeof lineage !== 'object') fail('Manual mail reply lineage is invalid.');
    if (lineage.kind === 'manual') onlyKeys(lineage, ['kind'], 'Manual mail reply lineage');
    else if (lineage.kind === 'derived') {
      onlyKeys(lineage, ['kind', 'parentProposalId', 'parentRevision', 'parentPayloadDigest', 'parentBatchResultDigest'], 'Derived mail reply lineage');
      cleanString(lineage.parentProposalId, 'Parent proposal ID', 160); assertRevision(lineage.parentRevision, 'Parent proposal revision');
      if (lineage.parentRevision < 1) fail('Parent proposal revision is invalid.');
      if (!HASH.test(lineage.parentPayloadDigest) || (lineage.parentBatchResultDigest !== undefined && !HASH.test(lineage.parentBatchResultDigest))) fail('Derived mail reply lineage digest is invalid.');
    } else if (lineage.kind === 'accepted_draft') {
      onlyKeys(lineage, ['kind', 'parentProposalId', 'parentRevision', 'parentPayloadDigest', 'draftDispatchRecordId', 'draftDispatchRecordDigest', 'remoteDraftId'], 'Accepted draft lineage');
      if (value.operation !== 'send') fail('An accepted provider draft can only be dispatched as a send.');
      cleanString(lineage.parentProposalId, 'Parent proposal ID', 160); assertRevision(lineage.parentRevision, 'Parent proposal revision');
      if (lineage.parentRevision < 1) fail('Parent proposal revision is invalid.');
      cleanString(lineage.draftDispatchRecordId, 'Draft dispatch record ID', 160);
      const remoteDraftId = cleanString(lineage.remoteDraftId, 'Remote draft ID', 1024);
      if (!validUnicodeScalarString(remoteDraftId)) fail('Remote draft ID contains invalid Unicode.');
      if (typeof lineage.parentPayloadDigest !== 'string' || typeof lineage.draftDispatchRecordDigest !== 'string' ||
          !HASH.test(lineage.parentPayloadDigest) || !HASH.test(lineage.draftDispatchRecordDigest)) fail('Accepted draft lineage digest is invalid.');
    } else fail('Manual mail reply lineage kind is unsupported.');
    return structuredClone(value);
  }
  if (value.version !== 1) return fail('Dispatch source provenance is missing or unsupported.');
  onlyKeys(value, ['version', 'assistContractVersion', 'analysisFingerprint', 'noteId', 'noteRevision', 'capturedAt', 'captureTimeZone', 'intent', 'question', 'knowledgeSelection', 'sources', 'policySources', 'settingsFingerprint', 'answeredAsOf', 'expiresAt', 'outputPolicyVersion', 'inputPolicyVersion'], 'Dispatch provenance');
  assertRevision(value.noteRevision, 'Provenance note revision');
  const intent = value.intent;
  if (!['assist', 'summarize', 'answer', 'extract'].includes(intent)) fail('Provenance intent is invalid.');
  if (value.outputPolicyVersion !== undefined && value.outputPolicyVersion !== 1 && value.outputPolicyVersion !== 2) fail('Provenance output policy version is invalid.');
  if (value.inputPolicyVersion !== undefined && value.inputPolicyVersion !== 1 && value.inputPolicyVersion !== 2) fail('Provenance input policy version is invalid.');
  const inputPolicyVersion = (value.inputPolicyVersion ?? 1) as 1 | 2;
  const sources = sourceList(value.sources, 'Provenance sources', inputPolicyVersion);
  const policySources = sourceList(value.policySources, 'Policy provenance sources', inputPolicyVersion);
  const result: NoteProposalProvenance = {
    version: 1,
    assistContractVersion: cleanString(value.assistContractVersion, 'Assist contract version', 64),
    analysisFingerprint: cleanString(value.analysisFingerprint, 'Analysis fingerprint', 1024 * 1024),
    noteId: cleanString(value.noteId, 'Provenance note ID', 160),
    noteRevision: value.noteRevision,
    capturedAt: canonicalTime(value.capturedAt, 'Provenance capture time'),
    captureTimeZone: validTimeZone(value.captureTimeZone, 'Provenance time zone'),
    intent,
    ...(value.question !== undefined ? { question: contentString(value.question, 'Provenance question', 16 * 1024, true) } : {}),
    ...(value.knowledgeSelection !== undefined ? { knowledgeSelection: knowledgeSelection(value.knowledgeSelection, inputPolicyVersion) } : {}),
    sources,
    policySources,
    settingsFingerprint: cleanString(value.settingsFingerprint, 'Settings fingerprint', 16 * 1024),
    ...(value.answeredAsOf !== undefined ? { answeredAsOf: canonicalTime(value.answeredAsOf, 'Answer snapshot time') } : {}),
    ...(value.expiresAt !== undefined ? { expiresAt: canonicalTime(value.expiresAt, 'Provenance expiry') } : {}),
    ...(value.outputPolicyVersion !== undefined ? { outputPolicyVersion: value.outputPolicyVersion as 1 | 2 } : {}),
    ...(value.inputPolicyVersion !== undefined ? { inputPolicyVersion } : {}),
  };
  if (Boolean(value.expiresAt) !== Boolean(value.answeredAsOf)) fail('Answer snapshot and expiry must be supplied together.');
  if (value.expiresAt && value.answeredAsOf && Date.parse(value.expiresAt) < Date.parse(value.answeredAsOf)) fail('Provenance expiry predates its answer snapshot.');
  return result;
}

function projectEmail(value: EmailProposalPayload, operation: 'draft' | 'send', outputPolicyVersion: 1 | 2 = 1): DispatchPayload {
  if (value.operation !== operation) fail('Approved email operation does not match its payload.');
  if (!Array.isArray(value.to) || value.to.length < 1 || value.to.length > 100 || !Array.isArray(value.cc) || value.cc.length > 100 || !Array.isArray(value.bcc) || value.bcc.length > 100) fail('Approved email recipients are invalid.');
  if (!Array.isArray(value.attachments) || value.attachments.length > 10) fail('Approved email attachments are invalid.');
  const subject = cleanString(value.subject, 'Email subject', 998, true);
  if (/[\r\n]/.test(subject)) fail('Email subject contains an invalid line break.');
  const text = contentString(value.text, 'Email body', 100_000, true, outputPolicyVersion === 2);
  const attachments = value.attachments.map((attachment) => {
    const fileName = cleanString(attachment.fileName, 'Attachment filename', 200);
    const mimeType = cleanString(attachment.mimeType, 'Attachment media type', 255);
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i.test(mimeType) || /[\\/]/.test(fileName)) fail('Approved attachment metadata is invalid.');
    if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 || !HASH.test(attachment.sha256)) fail('Approved attachment size or hash is invalid.');
    return { id: cleanString(attachment.id, 'Attachment ID', 512), fileName, mimeType, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256.toLowerCase() };
  });
  return { kind: 'email', email: {
    to: value.to.map((item) => email(item, 'To recipient')),
    cc: value.cc.map((item) => email(item, 'Cc recipient')),
    bcc: value.bcc.map((item) => email(item, 'Bcc recipient')),
    subject, text, attachments, ...(value.reply ? { reply: structuredClone(value.reply) } : {}),
  } };
}

function projectEvent(value: EventProposalPayload, outputPolicyVersion: 1 | 2 = 1): DispatchPayload {
  const start = cleanString(value.start, 'Event start', 100);
  const end = cleanString(value.end, 'Event end', 100);
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!isoDateTime.test(start) || !isoDateTime.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 366 * 86_400_000) fail('Approved event time range is invalid.');
  const timeZone = cleanString(value.timeZone, 'Event time zone', 128);
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0); } catch { fail('Approved event time zone is invalid.'); }
  if (!Array.isArray(value.attendees) || value.attendees.length > 100 || !['send', 'none'].includes(value.invitePolicy)) fail('Approved event attendees or invitation policy are invalid.');
  return { kind: 'event', event: {
    ...(value.title !== undefined ? { title: cleanString(value.title, 'Event title', outputPolicyVersion === 2 ? Number.MAX_SAFE_INTEGER : 1000, true) } : {}),
    ...(value.description !== undefined ? { description: contentString(value.description, 'Event description', 100_000, true, outputPolicyVersion === 2) } : {}),
    start, end, timeZone, attendees: value.attendees.map((item) => email(item, 'Event attendee')), invitePolicy: value.invitePolicy,
  } };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function freezeClone<T>(value: T): T { return deepFreeze(structuredClone(value)); }

/**
 * Captures only approved, allowlisted fields; credentials and unknown fields are never copied.
 * The approved digest is retained as an audit reference. Callers must independently verify the
 * exact approved digest and dispatch claim before invoking this projection; persisted receipts
 * are never authorization to execute an operation.
 */
export function createDispatchRecord(input: CreateDispatchRecordInput): DispatchRecord {
  const { proposal, account, calendar } = input;
  const id = cleanString(input.id, 'Dispatch record ID', 160);
  const dispatchStartedAt = canonicalTime(input.dispatchStartedAt, 'Dispatch start time');
  if (!proposal || (proposal.status !== 'approved' && proposal.status !== 'dispatching') || proposal.approvedRevision !== proposal.revision) fail('Only the exact approved proposal revision can be captured.');
  assertRevision(proposal.revision, 'Approved proposal revision');
  if (proposal.revision < 1) fail('Approved proposal revision is invalid.');
  if (proposal.requiresRebuild) fail('Proposal source requires a rebuild before dispatch capture.');
  const payloadDigest = cleanString(proposal.approvedPayloadDigest, 'Approved payload digest', 64);
  if (!HASH.test(payloadDigest)) fail('Approved payload digest must be a SHA-256 hex digest.');
  const sourceActionKey = cleanString(proposal.sourceActionKey, 'Source action key', 1024 * 1024);
  const sourceProvenance = snapshotProvenance(proposal.provenance);
  if (sourceProvenance.version === 1) {
    if (proposal.noteId !== sourceProvenance.noteId || proposal.sourceRevision !== sourceProvenance.noteRevision) fail('Proposal source does not match its analysis provenance.');
    const transcriptSources = sourceProvenance.sources.filter((source) => source.sourceId === 'transcript');
    if (transcriptSources.length !== 1 || transcriptSources[0].revision !== proposal.sourceRevision) fail('Dispatch provenance must contain the exact transcript source revision.');
    assertRevision(proposal.sourceRevision, 'Proposal source revision');
    if (proposal.sourceRevision < 1) fail('Approved proposal revision is invalid.');
  } else if (proposal.noteId !== undefined || proposal.sourceRevision !== undefined || proposal.kind !== 'email') {
    fail('Mail reply proposals must not use note provenance or artificial source revisions.');
  }
  if (proposal.kind === 'email' && proposal.email?.reply) {
    if (sourceProvenance.version !== 2 && sourceProvenance.version !== 3) fail('Reply draft is missing its original message provenance.');
    const expectedReplyOperation = input.mailReplyActivationOperation ?? 'draft';
    if (sourceProvenance.version === 3 && sourceProvenance.lineage.kind === 'accepted_draft' && expectedReplyOperation !== 'send') {
      fail('An accepted provider draft can only be dispatched as a send.');
    }
    if (sourceProvenance.version === 2 && expectedReplyOperation === 'send' && !sourceProvenance.batchJobId) fail('Only an activated Batch reply can be sent.');
    if (sourceProvenance.version === 3 && (sourceProvenance.operation !== expectedReplyOperation || proposal.email.operation !== sourceProvenance.operation)) fail('Manual reply operation does not match its explicit review.');
    validateReplyBinding(proposal.email, sourceProvenance, expectedReplyOperation);
  } else if (sourceProvenance.version !== 1) fail('Mail reply provenance can only be used by reply drafts.');
  if (proposal.evidence.some((item) => (item.start !== undefined && (!Number.isFinite(item.start) || item.start < 0)) ||
      (item.end !== undefined && (!Number.isFinite(item.end) || item.end < 0)) ||
      (item.start !== undefined && item.end !== undefined && item.end < item.start))) fail('Proposal evidence anchors are invalid.');
  if (!proposal.accountId || proposal.accountId !== account.id || account.authStatus !== 'connected' || !account.connected) fail('Approved proposal account is not the connected captured account.');
  const identity = snapshotIdentity(account);
  const accountSnapshot: DispatchAccountSnapshot = {
    provider: account.provider as 'google' | 'microsoft', identity,
    displayName: cleanString(account.displayName, 'Account display name', 200, true),
    email: email(account.email, 'Account email'),
  };
  const proposalId = cleanString(proposal.id, 'Proposal ID', 160);
  const outputPolicyVersion = sourceProvenance.outputPolicyVersion ?? 1;
  const title = cleanString(proposal.title, 'Approved title', outputPolicyVersion === 2 ? Number.MAX_SAFE_INTEGER : 1000);
  const body = contentString(proposal.body, 'Approved body', 100_000, true, outputPolicyVersion === 2);
  const common = { version: 1 as const, id, proposalId, approvedRevision: proposal.revision, ...(proposal.sourceRevision !== undefined ? { sourceRevision: proposal.sourceRevision } : {}), payloadDigest: payloadDigest.toLowerCase(), sourceActionKey,
    duplicateKey: '', sourceProvenance,
    ...(sourceProvenance.version === 2 && sourceProvenance.batchJobId ? { mailReplyBatchBinding: {
      jobId: sourceProvenance.batchJobId, provenanceCanonical: canonicalJson(sourceProvenance),
      ...(input.mailReplyActivationOperation === 'send' ? { activationOperation: 'send' as const } : {}),
    } } : {}), accountId: account.id, account: accountSnapshot, title, body, dispatchStartedAt,
    outcome: 'pending' as const, reconciliations: [] as DispatchReconciliationAttestation[] };
  if (proposal.kind === 'email' && proposal.email?.operation && (proposal.email.operation === 'draft' || proposal.email.operation === 'send')) {
    if (calendar) fail('Email dispatch must not contain a calendar destination.');
    const operation = proposal.email.operation;
    if ((sourceProvenance.version === 2 || sourceProvenance.version === 3) && (!proposal.email.reply || operation !== (sourceProvenance.version === 3 ? sourceProvenance.operation : input.mailReplyActivationOperation ?? 'draft') || account.provider !== sourceProvenance.source.identity.providerNamespace ||
        account.id !== sourceProvenance.source.accountId || !sameIdentitySnapshot(identity, sourceProvenance.source.identity))) {
      fail('Mail reply dispatch account does not match the frozen source identity.');
    }
    const record = { ...common, operation, payload: projectEmail(proposal.email, operation, outputPolicyVersion) };
    record.duplicateKey = identityActionKey(identity, sourceActionKey, operation);
    return freezeClone(record);
  }
  if (proposal.kind === 'event' && proposal.event) {
    if (!calendar || calendar.id !== proposal.calendarId || calendar.accountId !== account.id || !calendar.connected || !calendar.writable || !calendar.providerId) fail('Approved event destination does not match a connected writable calendar.');
    const providerId = cleanString(calendar.providerId, 'Provider calendar ID', 1024);
    const calendarSnapshot: DispatchCalendarSnapshot = { localId: cleanString(calendar.id, 'Local calendar ID', 2048), providerId, name: cleanString(calendar.name, 'Calendar name', 200, true) };
    const providerIdempotencyKey = cleanString(proposal.eventTransactionId, 'Event provider idempotency key', 64);
    if (!UUID.test(providerIdempotencyKey)) fail('Event provider idempotency key must be a UUID.');
    const operation: DispatchOperation = 'event';
    const record = { ...common, operation, calendar: calendarSnapshot, providerIdempotencyKey, payload: projectEvent(proposal.event, outputPolicyVersion) };
    record.duplicateKey = identityActionKey(identity, sourceActionKey, operation);
    return freezeClone(record);
  }
  return fail('Approved proposal does not contain a supported external operation.');
}

function sameIdentitySnapshot(a: DispatchIdentitySnapshot, b: MailReplySourceSnapshot['identity']): boolean {
  return a.providerNamespace === b.providerNamespace && a.clientId === b.clientId && a.subject === b.subject &&
    (a.issuer ?? '') === (b.issuer ?? '') && (a.tenantId ?? '') === (b.tenantId ?? '') &&
    (a.resourceUserId ?? '') === (b.resourceUserId ?? '');
}

/** A provider outcome is terminal; unknown is resolved only by an appended human attestation. */
export function recordDispatchOutcome(record: DispatchRecord, input: DispatchOutcomeInput): DispatchRecord {
  if (!record || record.version !== 1 || record.outcome !== 'pending') fail('Dispatch outcome is already terminal or the record is invalid.');
  if (!['accepted', 'unknown', 'rejected'].includes(input.outcome)) fail('Dispatch provider outcome is invalid.');
  const at = canonicalTime(input.at, 'Dispatch outcome time');
  if (Date.parse(at) < Date.parse(record.dispatchStartedAt)) fail('Dispatch outcome time predates the dispatch start.');
  const remoteId = input.remoteId === undefined ? undefined : cleanString(input.remoteId, 'Provider remote ID', 1024);
  if (input.outcome === 'rejected' && !['provider_rejected', 'precondition_failed'].includes(input.rejectionCode ?? '')) fail('A rejected dispatch requires a bounded rejection code.');
  if (input.outcome !== 'rejected' && input.rejectionCode !== undefined) fail('Only rejected dispatches may carry a rejection code.');
  if (input.outcome === 'accepted' && record.operation === 'event' && !remoteId) fail('Accepted event creation requires its provider event ID.');
  if (input.replyDraftCheck !== undefined && (record.operation !== 'draft' || (record.sourceProvenance.version !== 2 && record.sourceProvenance.version !== 3) || !['matches_approved', 'differs', 'unverified'].includes(input.replyDraftCheck))) fail('Reply draft check is only valid for mail reply drafts.');
  return freezeClone({ ...record, outcome: input.outcome, outcomeAt: at,
    ...(input.outcome === 'rejected' ? { rejectionCode: input.rejectionCode } : {}), ...(remoteId ? { remoteId } : {}),
    ...(input.outcome === 'accepted' && input.replyDraftCheck ? { replyDraftCheck: input.replyDraftCheck } : {}) });
}

/** Records a human investigation without changing provider outcome or enabling another send. */
export function appendDispatchReconciliation(record: DispatchRecord, attestation: DispatchReconciliationAttestation): DispatchRecord {
  if (!record || record.version !== 1 || record.outcome !== 'unknown') fail('Only unknown provider outcomes can be reconciled.');
  if (record.reconciliations.length >= 100) fail('Dispatch reconciliation history is full.');
  const id = cleanString(attestation.id, 'Reconciliation ID', 160);
  if (record.reconciliations.some((item) => item.id === id)) fail('Reconciliation IDs must be unique within a dispatch record.');
  if (!['confirmed_present', 'not_found', 'abandoned'].includes(attestation.disposition)) fail('Reconciliation disposition is invalid.');
  const value: DispatchReconciliationAttestation = {
    id, disposition: attestation.disposition, at: canonicalTime(attestation.at, 'Reconciliation time'),
    note: contentString(attestation.note, 'Reconciliation note', 1000, true),
    ...(attestation.remoteId ? { remoteId: cleanString(attestation.remoteId, 'Reconciliation remote ID', 1024) } : {}),
  };
  if (record.outcomeAt && Date.parse(value.at) < Date.parse(record.outcomeAt)) fail('Reconciliation time predates the provider outcome.');
  return freezeClone({ ...record, reconciliations: [...record.reconciliations, value] });
}

/** Validates persisted records before a caller places them back in application state. */
export function validateDispatchRecord(value: unknown): DispatchRecord {
  if (!value || typeof value !== 'object') fail('Dispatch record is invalid.');
  const record = value as DispatchRecord;
  onlyKeys(record, ['version', 'id', 'proposalId', 'approvedRevision', 'sourceRevision', 'payloadDigest', 'sourceActionKey', 'duplicateKey', 'sourceProvenance', 'mailReplyBatchBinding', 'operation', 'accountId', 'account', 'calendar', 'title', 'body', 'payload', 'dispatchStartedAt', 'providerIdempotencyKey', 'outcome', 'outcomeAt', 'rejectionCode', 'replyDraftCheck', 'remoteId', 'reconciliations'], 'Dispatch record');
  if (record.version !== 1 || !HASH.test(record.payloadDigest) || !['draft', 'send', 'event'].includes(record.operation) || !['pending', 'accepted', 'unknown', 'rejected'].includes(record.outcome)) fail('Dispatch record version, digest, operation, or outcome is invalid.');
  onlyKeys(record.account, ['provider', 'identity', 'displayName', 'email'], 'Dispatch account snapshot');
  onlyKeys(record.account.identity, ['providerNamespace', 'clientId', 'subject', 'issuer', 'tenantId', 'resourceUserId'], 'Dispatch identity');
  onlyKeys(record.payload, record.operation === 'event' ? ['kind', 'event'] : ['kind', 'email'], 'Dispatch payload');
  if (record.operation === 'event') {
    if (record.payload.kind !== 'event') fail('Dispatch event payload kind is invalid.');
    onlyKeys(record.payload.event, ['title', 'description', 'start', 'end', 'timeZone', 'attendees', 'invitePolicy'], 'Dispatch event payload');
    if (!record.calendar) fail('Dispatch record event destination is missing.');
    onlyKeys(record.calendar, ['localId', 'providerId', 'name'], 'Dispatch calendar snapshot');
  } else {
    if (record.payload.kind !== 'email') fail('Dispatch email payload kind is invalid.');
    onlyKeys(record.payload.email, ['to', 'cc', 'bcc', 'subject', 'text', 'attachments', 'reply'], 'Dispatch email payload');
    if (record.payload.email.reply) onlyKeys(record.payload.email.reply, ['mode', 'sourceDigest', 'localMessageId', 'providerMessageId', 'idFormat', 'internetMessageId', 'sourceSubject', 'threadId', 'references', 'inReplyTo'], 'Dispatch reply binding');
    for (const attachment of record.payload.email.attachments) onlyKeys(attachment, ['id', 'fileName', 'mimeType', 'sizeBytes', 'sha256'], 'Dispatch attachment metadata');
    if (record.calendar || record.providerIdempotencyKey) fail('Email dispatch must not contain event-only fields.');
  }
  if (!Array.isArray(record.reconciliations) || record.reconciliations.length > 100) fail('Dispatch reconciliation history is invalid.');
  for (const attestation of record.reconciliations) onlyKeys(attestation, ['id', 'disposition', 'at', 'note', 'remoteId'], 'Dispatch reconciliation');
  if (record.outcome === 'pending' && (record.outcomeAt || record.remoteId || record.rejectionCode)) fail('Pending dispatch cannot contain a provider outcome.');

  const provenance = snapshotProvenance(record.sourceProvenance);
  const requiresBatchBinding = provenance.version === 2 && Boolean(provenance.batchJobId);
  if (requiresBatchBinding) {
    const proof = record.mailReplyBatchBinding;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).some((key) => !['jobId', 'provenanceCanonical', 'activationOperation'].includes(key)) ||
        proof.jobId !== provenance.batchJobId || typeof proof.provenanceCanonical !== 'string' ||
        proof.provenanceCanonical !== canonicalJson(provenance) ||
        (proof.activationOperation !== undefined && proof.activationOperation !== 'send') ||
        record.operation !== (proof.activationOperation ?? 'draft')) fail('Dispatch Batch mail provenance consistency proof is invalid.');
  } else if (record.mailReplyBatchBinding !== undefined) fail('Dispatch Batch mail provenance proof is unsupported for this receipt.');
  const proposal: Proposal = {
    id: record.proposalId, ...(provenance.version === 1 ? { noteId: provenance.noteId } : {}), kind: record.operation === 'event' ? 'event' : 'email',
    title: record.title, body: record.body, status: 'dispatching', revision: record.approvedRevision,
    approvedRevision: record.approvedRevision, approvedPayloadDigest: record.payloadDigest, sourceActionKey: record.sourceActionKey,
    provenance, accountId: record.accountId, recipients: [], ...(record.sourceRevision !== undefined ? { sourceRevision: record.sourceRevision } : {}), evidence: [],
    ...(record.operation === 'event' && record.payload.kind === 'event' ? { event: record.payload.event, calendarId: record.calendar?.localId, eventTransactionId: record.providerIdempotencyKey } : {}),
    ...(record.operation !== 'event' && record.payload.kind === 'email' ? { email: { ...record.payload.email, operation: record.operation } } : {}),
  };
  const account: Account = {
    id: record.accountId, provider: record.account.provider, connected: true, authStatus: 'connected',
    displayName: record.account.displayName, email: record.account.email, identity: record.account.identity,
  };
  const calendar: Calendar | undefined = record.calendar ? {
    id: record.calendar.localId, accountId: record.accountId, providerId: record.calendar.providerId, name: record.calendar.name, connected: true, writable: true,
  } : undefined;
  let canonical = createDispatchRecord({ id: record.id, dispatchStartedAt: record.dispatchStartedAt, proposal, account, calendar,
    ...(record.sourceProvenance.version === 2 && record.sourceProvenance.batchJobId
      ? { mailReplyActivationOperation: record.mailReplyBatchBinding?.activationOperation ?? 'draft' }
      : record.sourceProvenance.version === 3 ? { mailReplyActivationOperation: record.sourceProvenance.operation } : {}) });
  if (canonical.duplicateKey !== record.duplicateKey) fail('Dispatch duplicate identity key is invalid.');
  if (record.outcome !== 'pending') {
    if (record.outcome === 'rejected' && !record.rejectionCode) fail('Rejected dispatch code is missing.');
    canonical = recordDispatchOutcome(canonical, {
      outcome: record.outcome, at: canonicalTime(record.outcomeAt, 'Dispatch outcome time'),
      ...(record.remoteId ? { remoteId: cleanString(record.remoteId, 'Provider remote ID', 1024) } : {}),
      ...(record.rejectionCode ? { rejectionCode: record.rejectionCode } : {}),
      ...(record.replyDraftCheck ? { replyDraftCheck: record.replyDraftCheck } : {}),
    });
  }
  for (const attestation of record.reconciliations) canonical = appendDispatchReconciliation(canonical, attestation);
  return canonical;
}
