import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Account, AppSettings, AppState, MailboxSnapshotMessage, SelectedMailTextSnapshot } from '../core';
import { canonicalVerifiedProviderIdentity } from '../core';
import { scopeGrantsCapability } from '../connectors/oauth';
import { canonicalMailReplySource, defaultReplyRecipients, type MailReplySourceSnapshot } from '../mailReply';
import { evaluateProactive, type ProactiveMailSource } from '../proactive';
import { isMailTextFresh, validSelectedMailTextSnapshot, utf8Bytes } from '../mailText';
import { OPENROUTER_BATCH_REQUEST_PROFILE_VERSION, OpenRouterBatchRequestBuilder } from '../services/openRouter';
import { isOpenRouterMailReplyContentJob, validateOpenRouterBatchLedger, type OpenRouterBatchJob, type OpenRouterMailReplyContentJob } from '../services/openRouterBatchJobs';
import { validOpenRouterMailReplyBinding, type OpenRouterMailReplyBinding } from '../services/openRouterMailReply';
import { canonicalBackgroundJson } from '../../server/src/backgroundContracts.js';
import type { BackgroundPolicySpecification } from '../../server/src/backgroundContracts.js';
import type { BackgroundClaim, BackgroundOccurrenceStore, BackgroundPaidMailReplyInputs } from '../../server/src/backgroundOccurrences.js';
import type { BackgroundProactiveCandidateIndex, BackgroundProactivePreflightClaim } from '../../server/src/backgroundProactiveCandidates.js';
import { currentCommandTicket, type CommandJournal, type CommandTicketContext } from '../../server/src/commandJournal.js';
import type { LoadedWorkspaceStateProof, SnapshotCommitParticipant, SnapshotCommitParticipantInput } from '../../server/src/workspaceStore.js';
import type { DurableKernel, OwnedTransactionContext } from '../../server/src/kernel.js';
import { BackgroundBatchLinkStore } from '../../server/src/backgroundBatchLink.js';
import { currentSavedProactiveRule, backgroundProactiveRuleDigest } from './backgroundBindingResolver.node';
import { hasCertifiedNotSubmittedJob, readCertifiedNotSubmittedProactiveJob, recordLiveNotSubmittedProactiveJob } from './backgroundProactiveRecovery.node';

const PRIVATE_MAX = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const MAILBOX_KEYS = new Set(['id', 'accountId', 'providerMessageId', 'identityKey', 'verifiedIdentityKey', 'connectionGeneration', 'idFormat',
  'threadId', 'subject', 'from', 'senderEmail', 'receivedAt', 'snippet', 'isRead', 'replyMetadataComplete', 'internetMessageId',
  'providerVersion', 'sizeEstimate', 'sizeCheckedAt', 'replyTo', 'to', 'cc', 'references', 'inReplyTo', 'headers', 'observedAt', 'providerDeletedAt']);

interface SourceEnvelope {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly connectionGeneration: number;
  readonly messageId: string;
  readonly source: MailReplySourceSnapshot;
  readonly body: OpenRouterMailReplyBinding['body'];
}
interface RequestEnvelope {
  readonly schemaVersion: 1;
  readonly bindingVersion: 1 | 2;
  readonly mode: 'reply' | 'reply_all';
  readonly subject: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly brief: string;
  readonly policy: OpenRouterMailReplyBinding['policy'];
  readonly settingsFingerprint: string;
  readonly settingsSnapshot: string;
  readonly requestAsOf: string;
  readonly timeZone: string;
  readonly note?: unknown;
  readonly context?: unknown;
}
interface CheckpointScope {
  readonly sessionToken: string;
  readonly occurrences: BackgroundOccurrenceStore;
  readonly links: BackgroundBatchLinkStore;
  readonly claim: BackgroundClaim;
  readonly preflightIndex: BackgroundProactiveCandidateIndex;
  readonly preflightClaim: BackgroundProactivePreflightClaim;
  readonly privacyEpoch: number;
  inputs?: BackgroundPaidMailReplyInputs;
  ticketId?: string;
  linkInput?: import('../../server/src/backgroundBatchLink.js').BackgroundPaidBatchLinkInput;
  preparingJob?: OpenRouterMailReplyContentJob;
  linked: boolean;
}

const checkpointScope = new AsyncLocalStorage<CheckpointScope>();

function fail(code: string): never { throw new Error(code); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function same(left: unknown, right: unknown): boolean {
  return canonicalBackgroundJson(left, PRIVATE_MAX) === canonicalBackgroundJson(right, PRIVATE_MAX);
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  }
  return value;
}
function identityKey(account: Account): string {
  const identity = account.identity;
  if (!identity?.providerNamespace || !identity.clientId || !identity.subject ||
      (account.provider === 'microsoft' && !identity.resourceUserId)) return fail('background_mail_identity_invalid');
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}
function settingsProjection(state: AppState, proactiveEffort?: 'none' | 'low'): Record<string, unknown> {
  return { mode: proactiveEffort ? 'provider' : state.settings.mode,
    llmProvider: proactiveEffort ? 'openrouter' : state.settings.llmProvider ?? 'azure',
    openRouterModel: proactiveEffort ? 'openai/gpt-6-luna:batch' : state.settings.openRouterModel ?? 'openai/gpt-6-luna:batch',
    openRouterReasoningEffort: proactiveEffort ?? state.settings.openRouterReasoningEffort ?? 'low',
    llmRequestContractVersion: proactiveEffort ? OPENROUTER_BATCH_REQUEST_PROFILE_VERSION : state.settings.llmRequestContractVersion ?? 1,
    timezone: state.settings.timezone };
}

/** Used only by the private controller integration port before entering the paid controller path. */
export function assertBackgroundPaidMailReplyCheckpoint(kernel: DurableKernel, input: Readonly<{ policyId: string; policyRevision: number;
  occurrenceId: string; attemptId: string; accountId: string; expectedConnectionGeneration: number; messageId: string }>): string {
  const scope = checkpointScope.getStore();
  if (!scope || scope.linked || !input || scope.claim.occurrenceId !== input.occurrenceId || scope.claim.attemptId !== input.attemptId ||
      scope.claim.targetId.length === 0 || !Number.isSafeInteger(input.policyRevision) || !Number.isSafeInteger(input.expectedConnectionGeneration)) {
    return fail('background_paid_checkpoint_scope_invalid');
  }
  return kernel.withOwnedTransaction(scope.sessionToken, scope.privacyEpoch, (context) => {
    const inputs = scope.occurrences.readPaidMailReplyInputsWithinTransaction(context, scope.claim, scope.privacyEpoch);
    const source = parseSource(inputs.source);
    const request = parseRequest(inputs.request);
    if (inputs.policyId !== input.policyId || inputs.policyRevision !== input.policyRevision || inputs.accountId !== input.accountId ||
        inputs.connectionGeneration !== input.expectedConnectionGeneration || source.messageId !== input.messageId ||
        inputs.specification.kind !== 'proactive_draft' || request.note !== undefined || request.context !== undefined) {
      return fail('background_paid_checkpoint_scope_invalid');
    }
    return request.requestAsOf;
  });
}

/** Resolves only an exact private DB checkpoint; a public marker is a fail-closed hint, never authority. */
export function resolveBackgroundPaidMailReplyJobAuthority(kernel: DurableKernel, input: Readonly<{
  sessionToken: string; privacyEpoch: number; job: OpenRouterMailReplyContentJob;
  occurrences: BackgroundOccurrenceStore; links: BackgroundBatchLinkStore;
}>): Readonly<{ status: 'foreground' } | { status: 'scheduled'; effort: 'none' | 'low' } |
  { status: 'certified_not_submitted'; effort: 'none' | 'low' }> {
  if (!kernel || !input || typeof input.sessionToken !== 'string' || !Number.isSafeInteger(input.privacyEpoch) ||
      !isOpenRouterMailReplyContentJob(input.job) || !input.occurrences || !input.links) return fail('background_paid_authority_unavailable');
  const job = input.job;
  return kernel.withOwnedTransaction(input.sessionToken, input.privacyEpoch, (context) => {
    const current = kernel.readOwnedSnapshotWithinTransaction(context);
    if (current.workspaceId !== context.workspaceId || current.privacyEpoch !== input.privacyEpoch) return fail('background_paid_authority_unavailable');
    const link = input.links.readByJobWithinTransaction(context, { jobId: job.id, customId: job.customId, requestSha256: job.requestSha256 });
    if (!link) {
      if (job.proactiveMailReply) {
        if (!hasCertifiedNotSubmittedJob(context, job) || (job.effort !== 'none' && job.effort !== 'low')) {
          return fail('background_paid_authority_unavailable');
        }
        return Object.freeze({ status: 'certified_not_submitted' as const, effort: job.effort });
      }
      return Object.freeze({ status: 'foreground' as const });
    }
    if (link.jobId !== job.id || link.customId !== job.customId || link.requestSha256 !== job.requestSha256 ||
        link.commandId !== link.attemptId) return fail('background_paid_authority_unavailable');
    const authority = input.occurrences.readPaidMailReplyCheckpointAuthorityWithinTransaction(context, {
      occurrenceId: link.occurrenceId, attemptId: link.attemptId, policyId: link.policyId, policyRevision: link.policyRevision,
      policyDigest: link.policyDigest, jobId: link.jobId, customId: link.customId, requestSha256: link.requestSha256,
      sourceDigest: link.sourceDigest, ...(link.sourceVersionDigest ? { sourceVersionDigest: link.sourceVersionDigest } : {}),
      requestDigest: link.requestDigest,
    });
    const marker = job.proactiveMailReply;
    if (marker && (marker.version !== 1 || marker.policyId !== authority.policyId || marker.policyRevision !== authority.policyRevision ||
        marker.occurrenceId !== authority.occurrenceId || marker.attemptId !== authority.attemptId)) {
      return fail('background_paid_authority_unavailable');
    }
    if (job.requestProfileVersion !== 1 || job.operation !== undefined || job.effort !== authority.effort) {
      return fail('background_paid_authority_unavailable');
    }
    return Object.freeze({ status: 'scheduled' as const, effort: authority.effort });
  });
}
function parseSource(value: unknown): SourceEnvelope {
  if (!record(value) || !exact(value, ['schemaVersion', 'accountId', 'connectionGeneration', 'messageId', 'source', 'body']) ||
      value.schemaVersion !== 1 || typeof value.accountId !== 'string' || !value.accountId ||
      !Number.isSafeInteger(value.connectionGeneration) || (value.connectionGeneration as number) < 1 ||
      typeof value.messageId !== 'string' || !value.messageId || !record(value.source) || !record(value.body)) return fail('background_mail_source_invalid');
  const source = value.source as unknown as MailReplySourceSnapshot;
  const body = value.body as unknown as OpenRouterMailReplyBinding['body'];
  if (source.accountId !== value.accountId || source.connectionGeneration !== value.connectionGeneration ||
      source.localMessageId !== value.messageId || !SHA256.test(source.sourceDigest)) return fail('background_mail_source_invalid');
  return freezeJson({ schemaVersion: 1, accountId: value.accountId, connectionGeneration: value.connectionGeneration,
    messageId: value.messageId, source, body });
}
function parseRequest(value: unknown): RequestEnvelope {
  const required = ['schemaVersion', 'bindingVersion', 'mode', 'subject', 'to', 'cc', 'brief', 'policy', 'settingsFingerprint',
    'settingsSnapshot', 'requestAsOf', 'timeZone'];
  if (!record(value) || !exact(value, required, ['note', 'context']) || value.schemaVersion !== 1 ||
      (value.bindingVersion !== 1 && value.bindingVersion !== 2) || !['reply', 'reply_all'].includes(String(value.mode)) ||
      typeof value.subject !== 'string' || !Array.isArray(value.to) || !Array.isArray(value.cc) ||
      value.to.some((item) => typeof item !== 'string') || value.cc.some((item) => typeof item !== 'string') ||
      typeof value.brief !== 'string' || !Array.isArray(value.policy) || !SHA256.test(String(value.settingsFingerprint)) ||
      typeof value.settingsSnapshot !== 'string' || typeof value.requestAsOf !== 'string' ||
      !Number.isFinite(Date.parse(value.requestAsOf)) || new Date(value.requestAsOf).toISOString() !== value.requestAsOf ||
      typeof value.timeZone !== 'string') return fail('background_mail_request_invalid');
  // This tranche grants no standing consent for note or conversation context.
  if (value.note !== undefined || (value.context !== undefined && (!Array.isArray(value.context) || value.context.length !== 0)) || value.bindingVersion !== 1) {
    return fail('background_mail_request_scope_unsupported');
  }
  return freezeJson(value as unknown as RequestEnvelope);
}
function strictMailboxMessage(value: unknown): MailboxSnapshotMessage {
  if (!record(value) || Object.keys(value).some((key) => !MAILBOX_KEYS.has(key)) ||
      typeof value.id !== 'string' || !value.id || typeof value.accountId !== 'string' || !value.accountId ||
      typeof value.providerMessageId !== 'string' || !value.providerMessageId || typeof value.identityKey !== 'string' || !value.identityKey ||
      (value.verifiedIdentityKey !== undefined && typeof value.verifiedIdentityKey !== 'string') ||
      (value.connectionGeneration !== undefined && (!Number.isSafeInteger(value.connectionGeneration) || (value.connectionGeneration as number) < 0)) ||
      (value.idFormat !== undefined && value.idFormat !== 'gmail' && value.idFormat !== 'graph-immutable') ||
      ['threadId', 'subject', 'from', 'senderEmail', 'receivedAt', 'snippet', 'internetMessageId', 'providerVersion', 'references', 'inReplyTo', 'observedAt', 'providerDeletedAt']
        .some((key) => value[key] !== undefined && typeof value[key] !== 'string') ||
      (value.isRead !== undefined && typeof value.isRead !== 'boolean') ||
      (value.replyMetadataComplete !== undefined && typeof value.replyMetadataComplete !== 'boolean') ||
      (value.sizeEstimate !== undefined && (!Number.isSafeInteger(value.sizeEstimate) || (value.sizeEstimate as number) < 0)) ||
      (value.sizeCheckedAt !== undefined && typeof value.sizeCheckedAt !== 'string') ||
      ['replyTo', 'to', 'cc'].some((key) => value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== 'string'))) ||
      (value.headers !== undefined && (!Array.isArray(value.headers) || value.headers.some((item) => !record(item) || !exact(item, ['name', 'value']) ||
        typeof item.name !== 'string' || typeof item.value !== 'string')))) return fail('background_mail_snapshot_invalid');
  return value as unknown as MailboxSnapshotMessage;
}
function currentReplySource(account: Account, message: MailboxSnapshotMessage): MailReplySourceSnapshot {
  const identity = account.identity;
  if (!identity || !message.observedAt || !Number.isFinite(Date.parse(message.observedAt)) ||
      new Date(message.observedAt).toISOString() !== message.observedAt || message.providerDeletedAt !== undefined ||
      message.replyMetadataComplete !== true || !message.internetMessageId || !message.idFormat ||
      message.verifiedIdentityKey !== identityKey(account) || message.identityKey !== `${identityKey(account)}:${message.providerMessageId}` ||
      message.connectionGeneration !== account.connectionGeneration) return fail('background_mail_source_changed');
  const candidate: MailReplySourceSnapshot = { version: 1, accountId: account.id, accountEmail: account.email,
    ...(account.verifiedEmail ? { verifiedSelfEmail: account.verifiedEmail } : {}), identity,
    connectionGeneration: message.connectionGeneration!, localMessageId: message.id, providerMessageId: message.providerMessageId,
    idFormat: message.idFormat, ...(message.providerVersion ? { providerVersion: message.providerVersion } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}), internetMessageId: message.internetMessageId,
    ...(message.references ? { references: message.references } : {}), ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    subject: message.subject ?? '', ...(message.from ? { from: message.from } : {}), ...(message.senderEmail ? { senderEmail: message.senderEmail } : {}),
    ...(message.replyTo ? { replyTo: [...message.replyTo] } : {}), ...(message.to ? { to: [...message.to] } : {}),
    ...(message.cc ? { cc: [...message.cc] } : {}), ...(message.snippet !== undefined ? { snippet: message.snippet } : {}),
    replyMetadataComplete: true, observedAt: message.observedAt, sourceDigest: '0'.repeat(64) };
  const digest = sha256(canonicalMailReplySource(candidate));
  return freezeJson({ ...candidate, sourceDigest: digest });
}
function currentBody(state: AppState, account: Account, source: MailReplySourceSnapshot): SelectedMailTextSnapshot {
  const selected = state.selectedMailTexts.find((item) => item.messageId === source.localMessageId && item.accountId === source.accountId &&
    item.providerMessageId === source.providerMessageId);
  if (!selected || !validSelectedMailTextSnapshot(selected) || !isMailTextFresh(selected) || selected.sourceDigest !== source.sourceDigest ||
      selected.connectionGeneration !== source.connectionGeneration || selected.idFormat !== source.idFormat ||
      selected.identityKey !== identityKey(account) ||
      !same(selected.identity, source.identity) || !selected.text || !selected.textDigest ||
      utf8Bytes(selected.text) !== selected.bytes || sha256(selected.text) !== selected.textDigest) return fail('background_mail_body_changed');
  return selected;
}

function proactiveEffectiveSettings(state: AppState, effort: 'none' | 'low'): AppSettings {
  return { ...state.settings, mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
    openRouterReasoningEffort: effort, llmRequestContractVersion: OPENROUTER_BATCH_REQUEST_PROFILE_VERSION };
}

function proactiveSemanticSourceVersion(source: MailReplySourceSnapshot, body: Pick<SelectedMailTextSnapshot,
  'textDigest' | 'extractionVersion' | 'representation' | 'completeness'> & { readonly omissionReasons: readonly string[] },
  to: readonly string[], cc: readonly string[]): string {
  // Provider change tokens, local cache IDs, read flags, and observation time are current-source
  // fences, but they do not describe a new reply-generation request.
  return sha256(canonicalBackgroundJson({ schemaVersion: 1, accountEmail: source.accountEmail,
    verifiedSelfEmail: source.verifiedSelfEmail ?? null, identity: source.identity, providerMessageId: source.providerMessageId,
    idFormat: source.idFormat, internetMessageId: source.internetMessageId, threadId: source.threadId ?? null,
    references: source.references ?? null, inReplyTo: source.inReplyTo ?? null, subject: source.subject,
    from: source.from ?? null, senderEmail: source.senderEmail ?? null, replyTo: source.replyTo ?? null,
    to, cc, body: { textDigest: body.textDigest, extractionVersion: body.extractionVersion, representation: body.representation,
      completeness: body.completeness, omissionReasons: body.omissionReasons } }, PRIVATE_MAX));
}

/** Builds frozen inputs only from a freshly loaded, validated current AppState. */
export function prepareBackgroundProactiveMailReplyInputs(state: AppState, input: Readonly<{
  specification: BackgroundPolicySpecification; expectedAccountId: string; expectedIdentityKey: string; expectedGeneration: number;
  providerMessageId: string; localMessageId: string; now: number;
}>): Readonly<{ descriptor: Readonly<{ kind: 'proactive_draft'; accountIdentityKey: string; providerMessageId: string; sourceVersionDigest?: string }>;
  source: SourceEnvelope; request: RequestEnvelope; scheduledAt: number }> {
  const spec = input.specification;
  if (!state || !input || spec.kind !== 'proactive_draft' || !Number.isSafeInteger(input.now) || input.now < 0) return fail('background_mail_policy_changed');
  const account = state.accounts.find((item) => item.id === input.expectedAccountId);
  const messageRaw = state.mailbox.find((item) => item.id === input.localMessageId);
  if (!account || !messageRaw || !account.connected || account.authStatus !== 'connected' || !account.tokenRef ||
      account.connectionGeneration !== input.expectedGeneration || !account.identity ||
      sha256(canonicalVerifiedProviderIdentity(account)) !== input.expectedIdentityKey || messageRaw.providerMessageId !== input.providerMessageId ||
      messageRaw.accountId !== account.id || messageRaw.connectionGeneration !== account.connectionGeneration || !sourceIsFresh(messageRaw, input.now)) {
    return fail('background_mail_binding_changed');
  }
  const message = strictMailboxMessage(messageRaw);
  const source = currentReplySource(account, message);
  const body = currentBody(state, account, source);
  const rule = currentSavedProactiveRule(state, spec.ruleId);
  if (rule.revision !== spec.expectedRuleRevision || !rule.enabled ||
      (rule.accountIds.length > 0 && !rule.accountIds.includes(account.id))) return fail('background_mail_policy_changed');
  const sourceId = JSON.stringify([source.identity.providerNamespace, source.accountId, source.providerMessageId]);
  const eligibleSource: ProactiveMailSource = { kind: 'mail', sourceId, namespace: source.identity.providerNamespace!, accountId: source.accountId,
    providerId: source.providerMessageId, sourceVersion: source.sourceDigest, availability: 'available', freshness: 'fresh',
    ...(message.senderEmail ? { senderEmail: message.senderEmail } : {}), ...(message.isRead !== undefined ? { isRead: message.isRead } : {}),
    ...(message.subject !== undefined ? { subject: message.subject } : {}), ...(message.snippet !== undefined ? { snippet: message.snippet } : {}),
    ...(message.receivedAt !== undefined ? { receivedAt: message.receivedAt } : {}) };
  const timeZone = state.settings.timezone;
  const evaluation = evaluateProactive({ nowUtc: new Date(input.now).toISOString(), timeZone, rules: [rule], sources: [eligibleSource], sourceSnapshotComplete: true });
  if (!evaluation.activeCandidates.some((candidate) => candidate.ruleId === rule.id && candidate.sourceId === sourceId && candidate.sourceKind === 'mail')) {
    return fail('background_mail_rule_not_currently_eligible');
  }
  const recipients = defaultReplyRecipients(source, account.verifiedEmail, spec.replyMode);
  const documents = state.documents.filter((doc) => /^memory\/(?:RULES|ROUTINES)\.md$/i.test(doc.path));
  if (documents.length > 2) return fail('background_mail_policy_document_changed');
  const policy = documents.map((doc) => Object.freeze({ path: doc.path as OpenRouterMailReplyBinding['policy'][number]['path'],
    revision: doc.revision, content: doc.content, sha256: sha256(doc.content) }));
  const settingsSnapshot = canonicalBackgroundJson(settingsProjection(state, spec.paidConsent.effort), 16 * 1024);
  const settingsFingerprint = sha256(settingsSnapshot);
  const bodyBinding = Object.freeze({ text: body.text!, textDigest: body.textDigest!, bytes: body.bytes,
    extractionVersion: body.extractionVersion, representation: body.representation, completeness: body.completeness,
    omissionReasons: Object.freeze([...body.omissionReasons]) });
  const sourceEnvelope = parseSource({ schemaVersion: 1, accountId: account.id, connectionGeneration: account.connectionGeneration,
    messageId: message.id, source, body: bodyBinding });
  const requestEnvelope = parseRequest({ schemaVersion: 1, bindingVersion: 1, mode: spec.replyMode, subject: source.subject,
    to: recipients.to, cc: recipients.cc, brief: spec.brief, policy, settingsFingerprint, settingsSnapshot,
    requestAsOf: new Date(input.now).toISOString(), timeZone });
  const descriptor = Object.freeze({ kind: 'proactive_draft' as const, accountIdentityKey: input.expectedIdentityKey,
    providerMessageId: input.providerMessageId, ...(spec.sourceChangePolicy === 'each_changed_source'
      ? { sourceVersionDigest: proactiveSemanticSourceVersion(source, body, recipients.to, recipients.cc) } : {}) });
  return Object.freeze({ descriptor, source: sourceEnvelope, request: requestEnvelope, scheduledAt: input.now });
}
function sourceIsFresh(message: MailboxSnapshotMessage, now: number): boolean {
  if (!message.observedAt) return false;
  const at = Date.parse(message.observedAt);
  return Number.isFinite(at) && at <= now && now - at < 15 * 60_000;
}
function assertRuleMatch(state: AppState, inputs: BackgroundPaidMailReplyInputs, source: MailReplySourceSnapshot,
  message: MailboxSnapshotMessage, now: number, timeZone: string): void {
  const spec = inputs.specification;
  if (spec.kind !== 'proactive_draft') return fail('background_mail_policy_changed');
  const rule = currentSavedProactiveRule(state, spec.ruleId);
  if (rule.revision !== spec.expectedRuleRevision || !rule.enabled || backgroundProactiveRuleDigest(rule) !== inputs.ruleSpecificationDigest) {
    return fail('background_mail_policy_changed');
  }
  const sourceId = JSON.stringify([source.identity.providerNamespace, source.accountId, source.providerMessageId]);
  const candidateSource: ProactiveMailSource = { kind: 'mail', sourceId, namespace: source.identity.providerNamespace!, accountId: source.accountId,
    providerId: source.providerMessageId, sourceVersion: source.sourceDigest, availability: 'available', freshness: 'fresh',
    ...(message.senderEmail ? { senderEmail: message.senderEmail } : {}), ...(message.isRead !== undefined ? { isRead: message.isRead } : {}),
    ...(message.subject !== undefined ? { subject: message.subject } : {}), ...(message.snippet !== undefined ? { snippet: message.snippet } : {}),
    ...(message.receivedAt !== undefined ? { receivedAt: message.receivedAt } : {}) };
  const evaluation = evaluateProactive({ nowUtc: new Date(now).toISOString(), timeZone, rules: [rule], sources: [candidateSource], sourceSnapshotComplete: true });
  if (!evaluation.activeCandidates.some((candidate) => candidate.ruleId === rule.id && candidate.sourceId === sourceId && candidate.sourceKind === 'mail')) {
    return fail('background_mail_rule_not_currently_eligible');
  }
}

function parseLedger(state: AppState): ReturnType<typeof validateOpenRouterBatchLedger> {
  const raw = (state as unknown as Record<string, unknown>).openRouterBatchLedger;
  return validateOpenRouterBatchLedger(raw ?? { version: 1, jobs: [] });
}
function changedJobs(previous: ReturnType<typeof validateOpenRouterBatchLedger>, next: ReturnType<typeof validateOpenRouterBatchLedger>):
  { added: OpenRouterBatchJob[]; removed: OpenRouterBatchJob[]; changed: { before: OpenRouterBatchJob; after: OpenRouterBatchJob }[] } {
  const before = new Map(previous.jobs.map((job) => [job.id, job]));
  const after = new Map(next.jobs.map((job) => [job.id, job]));
  return { added: next.jobs.filter((job) => !before.has(job.id)), removed: previous.jobs.filter((job) => !after.has(job.id)),
    changed: previous.jobs.flatMap((job) => { const current = after.get(job.id); return current && !same(job, current) ? [{ before: job, after: current }] : []; }) };
}
function frozenJobMatches(job: OpenRouterMailReplyContentJob, inputs: BackgroundPaidMailReplyInputs, state: AppState, now: number): void {
  if (inputs.specification.kind !== 'proactive_draft') return fail('background_occurrence_policy_stale');
  const sourceEnvelope = parseSource(inputs.source);
  const request = parseRequest(inputs.request);
  const provenance = job.proactiveMailReply;
  if (!provenance || provenance.version !== 1 || provenance.policyId !== inputs.policyId || provenance.policyRevision !== inputs.policyRevision ||
      provenance.occurrenceId !== inputs.occurrenceId || provenance.attemptId !== inputs.attemptId || job.requestProfileVersion !== 1 ||
      job.operation !== undefined || job.effort !== inputs.specification.paidConsent.effort) return fail('background_paid_checkpoint_transition_invalid');
  const account = state.accounts.find((item) => item.id === inputs.accountId);
  if (!account || !account.connected || account.authStatus !== 'connected' || !account.tokenRef || account.connectionGeneration !== inputs.connectionGeneration ||
      sha256(canonicalVerifiedProviderIdentity(account)) !== inputs.accountIdentityKey ||
      inputs.sourceVersionDigest !== (inputs.specification.kind === 'proactive_draft' && inputs.specification.sourceChangePolicy === 'each_changed_source'
        ? proactiveSemanticSourceVersion(sourceEnvelope.source, sourceEnvelope.body, request.to, request.cc) : undefined)) {
    return fail('background_mail_binding_changed');
  }
  const messageRaw = state.mailbox.find((item) => item.id === sourceEnvelope.messageId);
  if (!messageRaw) return fail('background_mail_source_changed');
  const message = strictMailboxMessage(messageRaw);
  if (message.accountId !== account.id || message.providerMessageId !== inputs.providerMessageId || !sourceIsFresh(message, now)) {
    return fail('background_mail_source_changed');
  }
  const currentSource = currentReplySource(account, message);
  if (!same(currentSource, sourceEnvelope.source)) return fail('background_mail_source_changed');
  const body = currentBody(state, account, currentSource);
  if (!same({ text: body.text, textDigest: body.textDigest, bytes: body.bytes, extractionVersion: body.extractionVersion,
    representation: body.representation, completeness: body.completeness, omissionReasons: body.omissionReasons }, sourceEnvelope.body)) {
    return fail('background_mail_body_changed');
  }
  const spec = inputs.specification;
  if (!spec.accounts.some((selection) => selection.accountId === account.id &&
      selection.expectedConnectionGeneration === account.connectionGeneration) || !account.capabilities?.includes('mail.read') ||
      !account.grantedScopes || (account.provider !== 'google' && account.provider !== 'microsoft') ||
      !scopeGrantsCapability(account.provider, [...account.grantedScopes], 'mail.read') || !account.identity ||
      (account.capabilityLimits !== undefined && !account.capabilityLimits.includes('mail.read'))) return fail('background_mail_binding_changed');
  const settingsSnapshot = canonicalBackgroundJson(settingsProjection(state, spec.paidConsent.effort));
  if (request.settingsSnapshot !== settingsSnapshot || request.settingsFingerprint !== sha256(settingsSnapshot) || request.timeZone !== state.settings.timezone ||
      request.brief !== spec.brief || request.mode !== spec.replyMode) {
    return fail('background_mail_settings_changed');
  }
  const documents = state.documents;
  const policies = request.policy;
  if (policies.some((item) => !record(item) || !exact(item, ['path', 'revision', 'content', 'sha256']) ||
      typeof item.path !== 'string' || !Number.isSafeInteger(item.revision) || typeof item.content !== 'string' || item.sha256 !== sha256(item.content))) {
    return fail('background_mail_policy_document_changed');
  }
  const selectedDocs = documents.filter((doc) => /^memory\/(?:RULES|ROUTINES)\.md$/i.test(doc.path));
  const currentDocs = policies.map((item) => documents.find((doc) => doc.path === item.path));
  if (policies.length !== selectedDocs.length || currentDocs.some((doc, index) => !doc || doc.revision !== policies[index]!.revision ||
      doc.content !== policies[index]!.content || selectedDocs[index]?.path !== policies[index]!.path ||
      selectedDocs[index]?.revision !== policies[index]!.revision || selectedDocs[index]?.content !== policies[index]!.content)) {
    return fail('background_mail_policy_document_changed');
  }
  const recipients = defaultReplyRecipients(currentSource, account.verifiedEmail, request.mode);
  if (currentSource.subject !== request.subject || !same(recipients.to, request.to) || !same(recipients.cc, request.cc)) {
    return fail('background_mail_reply_facts_changed');
  }
  assertRuleMatch(state, inputs, currentSource, message, now, request.timeZone);
  const binding: OpenRouterMailReplyBinding = { version: request.bindingVersion, messageId: sourceEnvelope.messageId,
    mode: request.mode, source: currentSource, body: sourceEnvelope.body, subject: request.subject, to: request.to, cc: request.cc,
    brief: request.brief, policy: request.policy, settingsFingerprint: request.settingsFingerprint,
    settingsSnapshot: request.settingsSnapshot, requestAsOf: request.requestAsOf, timeZone: request.timeZone };
  if (!validOpenRouterMailReplyBinding(binding, 2) || !same(job.mailReplyBinding, binding) || job.id !== job.customId ||
      job.kind !== 'mail_reply' || job.operation !== undefined || job.requestProfileVersion !== OPENROUTER_BATCH_REQUEST_PROFILE_VERSION || job.inputPolicyVersion !== 2 ||
      job.outputPolicyVersion !== 2 || job.requestSha256 !== sha256(job.requestBody) || job.settingsFingerprint !== request.settingsFingerprint ||
      job.effort !== spec.paidConsent.effort || job.model !== 'openai/gpt-6-luna:batch' || job.omittedSourceCount !== 0 ||
      job.requestBytes !== utf8Bytes(job.requestBody) || Object.keys(job.sourceVersions).length !== 0) return fail('background_mail_job_binding_invalid');
  const policyContext = policies.map((item) => `### ${item.path} (revision ${item.revision})\n${item.content}`).join('\n\n');
  const expectedBody = new OpenRouterBatchRequestBuilder().prepareReply({ sourceText: body.text!, sourceRepresentation: body.representation,
    sourceCompleteness: body.completeness, subject: request.subject, to: [...request.to], cc: [...request.cc], brief: request.brief,
    policyContext, asOf: request.requestAsOf, timeZone: request.timeZone }, proactiveEffectiveSettings(state, spec.paidConsent.effort), 2).body;
  if (expectedBody !== job.requestBody) return fail('background_mail_request_body_changed');
  const expectedSourceFingerprint = sha256(canonicalBackgroundJson({ source: canonicalMailReplySource(currentSource),
    body: { textDigest: body.textDigest, representation: body.representation, completeness: body.completeness,
      extractionVersion: body.extractionVersion, omissionReasons: body.omissionReasons }, note: null, policy: policies,
    settingsFingerprint: request.settingsFingerprint, recipients: { to: request.to, cc: request.cc }, inputPolicyVersion: 2 }, PRIVATE_MAX));
  if (job.sourceFingerprint !== expectedSourceFingerprint) return fail('background_mail_source_fingerprint_changed');
}

function onlyStatusTransition(before: OpenRouterBatchJob, after: OpenRouterBatchJob): boolean {
  if (before.id !== after.id || before.customId !== after.customId || before.kind !== after.kind || before.requestSha256 !== after.requestSha256 ||
      before.requestBody !== after.requestBody || !same(before.mailReplyBinding, after.mailReplyBinding) || before.sourceFingerprint !== after.sourceFingerprint ||
      before.settingsFingerprint !== after.settingsFingerprint || before.requestProfileVersion !== after.requestProfileVersion ||
      before.inputPolicyVersion !== after.inputPolicyVersion || before.outputPolicyVersion !== after.outputPolicyVersion ||
      before.requestBytes !== after.requestBytes || before.effort !== after.effort || before.model !== after.model ||
      before.createdAt !== after.createdAt || before.omittedSourceCount !== after.omittedSourceCount || !same(before.sourceVersions, after.sourceVersions)) return false;
  const allowed = new Set(['status', 'unknownCharge', 'updatedAt', 'batchId', 'failureCode']);
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => allowed.has(key) || same(a[key], b[key]));
}
function validProviderSettlement(before: OpenRouterMailReplyContentJob, after: OpenRouterMailReplyContentJob): boolean {
  if (before.status !== 'submitting' || before.batchId !== undefined || before.unknownCharge !== true) return false;
  if (after.status === 'queued') return typeof after.batchId === 'string' && after.batchId.length > 0 && after.unknownCharge === true &&
    after.failureCode === undefined;
  if (after.status === 'submission_unknown') return after.batchId === undefined && after.unknownCharge === true && after.failureCode === undefined;
  if (after.status === 'failed') return after.batchId === undefined && after.unknownCharge === false && after.failureCode === 'not_submitted';
  return false;
}

/** Runs exactly the paid scheduled mail-reply command under a private, non-HTTP checkpoint scope. */
export function runBackgroundPaidMailReplyCheckpoint<T>(input: Readonly<{ occurrences: BackgroundOccurrenceStore; links: BackgroundBatchLinkStore;
  claim: BackgroundClaim; preflightIndex: BackgroundProactiveCandidateIndex; preflightClaim: BackgroundProactivePreflightClaim;
  privacyEpoch: number; sessionToken: string }>, operation: () => T): T {
  if (!input || checkpointScope.getStore() || !input.occurrences || !input.links || !input.claim || !input.preflightIndex || !input.preflightClaim || typeof input.sessionToken !== 'string' ||
      !Number.isSafeInteger(input.privacyEpoch) || input.privacyEpoch < 0 || typeof operation !== 'function') {
    return fail('background_paid_checkpoint_scope_invalid');
  }
  return checkpointScope.run({ ...input, linked: false }, operation);
}

/** Installed alongside other synchronous snapshot participants. It only acts inside the named trusted gateway scope. */
export function createBackgroundPaidMailReplySnapshotParticipant(kernel: DurableKernel, journal: CommandJournal,
  clock: () => number = Date.now): SnapshotCommitParticipant<AppState> {
  if (!kernel || !journal || typeof clock !== 'function') throw new TypeError('background_paid_participant_invalid');
  return Object.freeze({
    beforeCommit(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<AppState>): void {
      const scope = checkpointScope.getStore();
      if (!scope) return;
      const ticket = currentCommandTicket() as CommandTicketContext | undefined;
      if (!ticket) return fail('background_paid_command_ticket_missing');
      journal.assertPaidMailReplySubmissionWithinTransaction(context, ticket);
      const previousLedger = parseLedger(input.previousSnapshot);
      const nextLedger = parseLedger(input.nextSnapshot);
      const delta = changedJobs(previousLedger, nextLedger);
      if (delta.removed.length || delta.changed.length > 1 || delta.added.length > 1) return fail('background_paid_ledger_delta_invalid');
      const previousJob = scope.preparingJob;
      if (!previousJob) {
        const inputs = scope.occurrences.readPaidMailReplyInputsWithinTransaction(context, scope.claim, scope.privacyEpoch);
        const added = delta.added[0];
        if (!added || added.status !== 'preparing' || delta.changed.length || delta.added.length !== 1 ||
            !isOpenRouterMailReplyContentJob(added)) return fail('background_paid_prepare_transition_invalid');
        frozenJobMatches(added, inputs, input.previousSnapshot, clock());
        frozenJobMatches(added, inputs, input.nextSnapshot, clock());
        scope.inputs = inputs;
        scope.ticketId = ticket.ticketId;
        scope.preparingJob = freezeJson(added);
        return;
      }
      if (!scope.linked) {
        const changed = delta.changed[0];
        if (scope.ticketId !== ticket.ticketId || !scope.inputs || !changed || delta.added.length || delta.changed.length !== 1 ||
            changed.before.id !== previousJob.id || !same(previousJob, changed.before) || !isOpenRouterMailReplyContentJob(changed.after) ||
            !onlyStatusTransition(changed.before, changed.after)) return fail('background_paid_checkpoint_transition_invalid');
        if (changed.after.status === 'failed' && changed.after.failureCode === 'not_submitted' && changed.after.unknownCharge === false &&
            changed.after.batchId === undefined && changed.before.status === 'preparing') {
          scope.occurrences.assertPaidPreDispatchSettlementWithinTransaction(context, scope.claim, scope.privacyEpoch);
          scope.links.assertNoLinkWithinTransaction(context, scope.claim.occurrenceId, scope.claim.attemptId);
          const inputs = scope.occurrences.readPaidMailReplyInputsWithinTransaction(context, scope.claim, scope.privacyEpoch);
          scope.preflightIndex.assertPaidOccurrenceMappingWithinTransaction(context, scope.preflightClaim,
            { occurrenceId: inputs.occurrenceId, paidAttemptId: inputs.attemptId });
          if (inputs.occurrenceId !== scope.claim.occurrenceId || inputs.attemptId !== scope.claim.attemptId ||
              inputs.policyId !== changed.after.proactiveMailReply?.policyId ||
              inputs.policyRevision !== changed.after.proactiveMailReply?.policyRevision) return fail('background_paid_occurrence_changed');
          const settledAt = clock();
          recordLiveNotSubmittedProactiveJob(context, { job: changed.after, ticketId: ticket.ticketId, commandId: ticket.idempotencyKey,
            preflightAttemptId: scope.preflightClaim.attemptId, occurrenceId: inputs.occurrenceId, paidAttemptId: inputs.attemptId, createdAt: settledAt });
          const paused = context.db.prepare(`UPDATE background_policy_heads SET status='suspended',suspension='reauthorization_required',updated_at=?
            WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND current_revision=? AND status='enabled'
              AND EXISTS (SELECT 1 FROM background_policy_revisions r WHERE r.workspace_id=background_policy_heads.workspace_id
                AND r.owner_id=background_policy_heads.owner_id AND r.privacy_epoch=background_policy_heads.privacy_epoch
                AND r.policy_id=background_policy_heads.policy_id AND r.revision=background_policy_heads.current_revision
                AND r.enabled=1 AND r.policy_digest=?)`)
            .run(settledAt, context.workspaceId, context.ownerId, context.privacyEpoch, inputs.policyId, inputs.policyRevision, inputs.policyDigest);
          if (paused.changes !== 1) return fail('background_paid_policy_changed');
          scope.occurrences.settlePaidPreDispatchNotSubmittedWithinTransaction(context, scope.claim, scope.privacyEpoch,
            'live_not_submitted', settledAt);
          scope.preflightIndex.settleWithinTransaction(context, scope.preflightClaim,
            { status: 'complete', code: 'live_not_submitted' }, settledAt);
          scope.preparingJob = freezeJson(changed.after);
          return;
        }
        const inputs = scope.occurrences.readPaidMailReplyInputsWithinTransaction(context, scope.claim, scope.privacyEpoch);
        scope.preflightIndex.assertPaidOccurrenceMappingWithinTransaction(context, scope.preflightClaim,
          { occurrenceId: inputs.occurrenceId, paidAttemptId: inputs.attemptId });
        if (inputs.occurrenceId !== scope.inputs.occurrenceId || inputs.attemptId !== scope.inputs.attemptId ||
            inputs.requestDigest !== scope.inputs.requestDigest) return fail('background_paid_occurrence_changed');
        if (!changed || delta.added.length || changed.before.id !== previousJob.id || changed.after.status !== 'submitting' ||
            changed.before.status !== 'preparing' || !isOpenRouterMailReplyContentJob(changed.after) || !onlyStatusTransition(changed.before, changed.after)) {
          return fail('background_paid_checkpoint_transition_invalid');
        }
        frozenJobMatches(changed.after, inputs, input.previousSnapshot, clock());
        frozenJobMatches(changed.after, inputs, input.nextSnapshot, clock());
        const captured = scope.occurrences.beginPaidSubmissionWithinTransaction(context, scope.claim, scope.privacyEpoch, ticket, journal, changed.after.id);
        if (captured.occurrenceId !== inputs.occurrenceId || captured.requestDigest !== inputs.requestDigest) return fail('background_paid_occurrence_changed');
        const linkInput = Object.freeze({ occurrenceId: inputs.occurrenceId, attemptId: inputs.attemptId,
          commandId: ticket.idempotencyKey, ticketId: ticket.ticketId, policyId: inputs.policyId, policyRevision: inputs.policyRevision,
          policyDigest: inputs.policyDigest, jobId: changed.after.id, customId: changed.after.customId,
          requestSha256: changed.after.requestSha256, sourceDigest: sha256(canonicalBackgroundJson(inputs.source, PRIVATE_MAX)),
          ...(inputs.sourceVersionDigest ? { sourceVersionDigest: inputs.sourceVersionDigest } : {}), requestDigest: inputs.requestDigest, createdAt: clock() });
        scope.links.linkWithinTransaction(context, linkInput);
        scope.linkInput = linkInput;
        scope.linked = true;
        scope.preparingJob = freezeJson(changed.after);
        return;
      }
      if (scope.ticketId !== ticket.ticketId || !scope.inputs || !scope.linkInput || !scope.linked) return fail('background_paid_checkpoint_scope_invalid');
      scope.occurrences.assertPaidSubmissionSettlementWithinTransaction(context, scope.claim, scope.privacyEpoch, previousJob.id);
      scope.links.assertExistingLinkWithinTransaction(context, scope.linkInput);
      if (delta.added.length || delta.changed.length > 1 || (delta.changed.length === 1 &&
          (delta.changed[0]!.before.id !== previousJob.id || !onlyStatusTransition(delta.changed[0]!.before, delta.changed[0]!.after) ||
            !isOpenRouterMailReplyContentJob(delta.changed[0]!.after) || !validProviderSettlement(delta.changed[0]!.before as OpenRouterMailReplyContentJob,
              delta.changed[0]!.after as OpenRouterMailReplyContentJob)))) {
        return fail('background_paid_settlement_transition_invalid');
      }
      if (delta.changed.length === 1) scope.preparingJob = freezeJson(delta.changed[0]!.after as OpenRouterMailReplyContentJob);
    },
    commit(): void { /* The paid claim, private link, journal checkpoint and snapshot were committed in beforeCommit's same transaction. */ },
  });
}

/**
 * Synchronous post-credential / pre-POST fence for the exact already-linked scheduled job.
 * The callback is trusted Node composition only; it is not a client-supplied command hook.
 */
export function assertBackgroundPaidMailReplyDispatchAuthorized(kernel: DurableKernel, input: Readonly<{
  sessionToken: string; privacyEpoch: number; loadedStateProof: LoadedWorkspaceStateProof;
}>): void {
  const scope = checkpointScope.getStore();
  if (!scope || !scope.linked || !scope.inputs || !scope.linkInput || !input || !Number.isSafeInteger(input.privacyEpoch) ||
      input.privacyEpoch !== scope.privacyEpoch) return fail('background_paid_dispatch_scope_invalid');
  const preparedInputs = scope.inputs;
  const link = scope.linkInput;
  kernel.withOwnedTransaction(input.sessionToken, input.privacyEpoch, (context) => {
    const current = kernel.readOwnedSnapshotWithinTransaction(context);
    const loaded = input.loadedStateProof;
    const stored = context.db.prepare(`SELECT id,owner_id,revision,privacy_epoch,schema_version,snapshot_json FROM workspaces WHERE id=?`)
      .get(context.workspaceId) as { id: string; owner_id: string; revision: number; privacy_epoch: number; schema_version: number; snapshot_json: string } | undefined;
    if (!loaded || loaded.workspaceId !== current.workspaceId || loaded.ownerId !== context.ownerId ||
        loaded.revision !== current.revision || loaded.privacyEpoch !== current.privacyEpoch || loaded.schemaVersion !== current.schemaVersion ||
        !stored || stored.id !== current.workspaceId || stored.owner_id !== context.ownerId || stored.revision !== current.revision ||
        stored.privacy_epoch !== current.privacyEpoch || stored.schema_version !== current.schemaVersion || typeof stored.snapshot_json !== 'string' ||
        loaded.sha256 !== sha256(stored.snapshot_json)) {
      return fail('background_execution_stale');
    }
    const state = current.snapshot as unknown as AppState;
    const inputs = scope.occurrences.readPaidMailReplyInputsForDispatchWithinTransaction(context, scope.claim, scope.privacyEpoch, link.jobId);
    if (inputs.occurrenceId !== preparedInputs.occurrenceId || inputs.attemptId !== preparedInputs.attemptId ||
        inputs.requestDigest !== preparedInputs.requestDigest || inputs.policyId !== preparedInputs.policyId ||
        inputs.policyRevision !== preparedInputs.policyRevision || inputs.policyDigest !== preparedInputs.policyDigest) {
      return fail('background_paid_occurrence_changed');
    }
    scope.occurrences.assertPaidSubmissionDispatchAuthorizedWithinTransaction(context, scope.claim, scope.privacyEpoch, link.jobId);
    scope.links.assertExistingLinkWithinTransaction(context, link);
    const ledger = parseLedger(state);
    const job = ledger.jobs.find((item) => item.id === link.jobId);
    if (!job || !isOpenRouterMailReplyContentJob(job) || job.status !== 'submitting' || job.batchId !== undefined ||
        job.id !== link.customId || job.requestSha256 !== link.requestSha256) return fail('background_paid_dispatch_job_invalid');
    frozenJobMatches(job, inputs, state, Date.now());
  });
}
