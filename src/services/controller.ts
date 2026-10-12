import * as Crypto from 'expo-crypto';
import type {
  Account, AccountConfig, AccountSyncState, AccountCapability, ActivityItem, AppController, AppSettings, AppState,
  ForegroundMailRefreshResult, MailCoverageInterval, MailLaneResult, MailSyncWindow,
  BackupImportPreview, Calendar, CalendarConfig, ContextDocument, Note, NoteAssistResult, AssistIntent, LocalTask, Proposal, ProposalPatch,
  ProposalProvenance, SaveNoteInput, SettingsPatch, MailboxSnapshotMessage, CalendarEventSnapshot, OAuthInstallResult,
  NoteProposalProvenance, MailReplyProvenance, MailReplySourceSnapshot, MailReplySourceResult,
  SelectedMailTextSnapshot, MailReplyTextLoadResult, MailReplyTextCacheResult, MailReplyTextGenerationInput, MailReplyTextGenerationResult,
  ProactiveCandidateEntry, ProactiveCandidateSourceResult,
  ProactiveState, SavedProactiveRule, RecordingAttachmentPreview,
} from '../core';
import { stateStore } from '../storage/platformStorage';
import type { StateStore } from '../storage/contracts';
import { writePrivateDocument } from '../storage/documents';
import { AzureOpenAIClient, AzureSpeechClient, ReplyGenerationError, ReplyGenerationPreDispatchError, validateAzureEndpoint, type DraftAnalysis, type ReplyGenerationUsage } from './azure';
import { cancelReminderNotification, requestReminderNotification } from './notifications';
import { removeAudio } from '../audio/readAudio';
import type { AudioRecoveryMetadata, RecordingRecoveryService, StagedRecording } from '../audio/recovery.types';
import { MAX_DURATION_SECONDS, MAX_RECOVERY_BYTES, RECOVERY_FORMATS, safeAudioFileName } from '../audio/formats';
import type {
  ApprovedDispatch, DispatchVerifier, OAuthBridgeResult, StoredOAuthToken, OAuthTokenStore,
  MessageSummary, SelectedMessageTextResult, RequestGuard, MessageWindowPageMetadata, CalendarSummary, SyncPage, MutationReceipt,
} from '../connectors';
import { ConnectorClient, ProviderWriteRejectedError, describeMessageWindowQuery, withCredentialLock } from '../connectors';
import { scopeGrantsCapability } from '../connectors/oauth';
import { oauthTokenStore, deleteOAuthToken } from '../auth/tokenStore';
import { Platform } from 'react-native';
import { buildLocalSourceSet, buildOfflinePreview, createSourceCatalog, type AssistantSourceInput } from '../assistant';
import { isMailTextFresh, normalizeMailText, utf8Bytes, validSelectedMailTextSnapshot, MAX_SELECTED_MAIL_TEXT_BYTES, MAIL_TEXT_FRESHNESS_MS } from '../mailText';
import { appendDispatchReconciliation, createDispatchRecord, recordDispatchOutcome, validateDispatchRecord } from '../dispatch';
import type { DispatchOutcome, DispatchRecord, DispatchReconciliation } from '../dispatch';
import { evaluateProactive, type ProactiveTrigger, type QuietHours } from '../proactive';
import { computeProactiveNextCheckAt } from '../proactive/boundaries';
import { buildProactiveSources, proactiveStableValue, type ProactiveSourceHashMemo } from '../proactive/adapters';
import { emptyProactiveState, normalizeProactiveData, PROACTIVE_INTEGRITY_ERROR, uncertainOnLoad, type ProactiveQuarantine } from '../proactive/state';
import { canonicalMailReplySource, createMailReplySource, defaultReplyRecipients, replyReferences, validateMailReplySource, validateReplyBinding } from '../mailReply';
import { BACKUP_LIMITS, canonicalPortableContent, createPortableBackup, parsePortableBackup, summarizePortableBackup, validatePortableDocumentPath, validateImportedBackupArchive } from '../backup';
import type { ImportedBackupArchive, PortableBackupV2 } from '../backup';

const now = () => new Date().toISOString();
const ASSIST_CONTRACT_VERSION = 'assist-v2';
let fallbackUuidCounter = 0;
const newId = () => Crypto.randomUUID?.() ?? globalThis.crypto?.randomUUID?.() ??
  `00000000-0000-4000-8000-${String(++fallbackUuidCounter).padStart(12, '0')}`;
function validTimezone(value?: string): string {
  const candidate = value?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore';
  try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(); return candidate; }
  catch { return 'Asia/Singapore'; }
}
function localDate(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: validTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (key: string) => parts.find((part) => part.type === key)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function isoWeek(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const weekYear = value.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((value.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}
const clone = <T,>(value: T): T => structuredClone(value);
function stateEntityIds(state: AppState): Set<string> {
  return new Set([
    ...state.notes.map((item) => item.id), ...state.tasks.map((item) => item.id),
    ...state.proposals.map((item) => item.id), ...state.activity.map((item) => item.id),
    ...state.accounts.map((item) => item.id), ...state.calendars.map((item) => item.id),
    ...state.mailbox.map((item) => item.id), ...state.calendarEvents.map((item) => item.id),
    ...state.dispatchRecords.map((item) => item.id), ...state.importedBackups.flatMap((item) => [
      item.id, ...item.noteLinks.map((link) => link.noteId), ...item.taskLinks.map((link) => link.taskId),
      ...item.documents.map((document) => document.id), ...item.history.map((entry) => entry.id),
    ]),
  ]);
}
function allocateFreshId(usedIds: Set<string>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newId();
    if (!usedIds.has(id)) { usedIds.add(id); return id; }
  }
  throw new Error('Could not allocate a fresh local ID for this backup operation. Try again.');
}
function validateRecoveryMetadata(value: unknown, maxDurationSeconds: number): AudioRecoveryMetadata {
  if (!isRecord(value)) throw new Error('The staged recording metadata is invalid. Select the file again.');
  const allowed = new Set(['fileName', 'format', 'mimeType', 'byteLength', 'sha256', 'durationStatus', 'durationSeconds']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('The staged recording metadata contains unsupported fields. Select the file again.');
  const format = value.format;
  if (typeof format !== 'string' || !Object.hasOwn(RECOVERY_FORMATS, format)) throw new Error('The staged recording format is unsupported.');
  const recoveryFormat = format as keyof typeof RECOVERY_FORMATS;
  if (typeof value.fileName !== 'string' || !value.fileName || value.fileName.length > 160 || safeAudioFileName(value.fileName, recoveryFormat) !== value.fileName ||
      typeof value.mimeType !== 'string' || !RECOVERY_FORMATS[recoveryFormat].mimeAliases.includes(value.mimeType.toLowerCase()) || value.mimeType !== value.mimeType.trim() ||
      !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) <= 0 || (value.byteLength as number) > MAX_RECOVERY_BYTES ||
      typeof value.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(value.sha256)) {
    throw new Error('The staged recording details are invalid. Select a supported audio file again.');
  }
  if (value.durationStatus === 'known') {
    if (typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > Math.min(MAX_DURATION_SECONDS, maxDurationSeconds)) {
      throw new Error(`Choose a recording no longer than ${Math.min(MAX_DURATION_SECONDS, maxDurationSeconds)} seconds.`);
    }
    return { fileName: value.fileName, format: recoveryFormat, mimeType: value.mimeType, byteLength: value.byteLength as number,
      sha256: value.sha256.toLowerCase(), durationStatus: 'known', durationSeconds: value.durationSeconds };
  }
  if (value.durationStatus === 'unknown' && value.durationSeconds === undefined) {
    return { fileName: value.fileName, format: recoveryFormat, mimeType: value.mimeType, byteLength: value.byteLength as number,
      sha256: value.sha256.toLowerCase(), durationStatus: 'unknown' };
  }
  throw new Error('The staged recording duration details are invalid. Select the file again.');
}

function validAudioAttachment(value: unknown): Note['audioAttachment'] | undefined {
  if (!isRecord(value) || value.kind !== 'user_selected_replacement' || value.originalMatch !== 'unverified' ||
      typeof value.attachedAt !== 'string' || !Number.isFinite(Date.parse(value.attachedAt)) || new Date(Date.parse(value.attachedAt)).toISOString() !== value.attachedAt) return undefined;
  try {
    const metadata = validateRecoveryMetadata({ fileName: value.fileName, format: value.format, mimeType: value.mimeType,
      byteLength: value.byteLength, sha256: value.sha256, durationStatus: value.durationStatus, durationSeconds: value.durationSeconds }, MAX_DURATION_SECONDS);
    return { kind: 'user_selected_replacement', originalMatch: 'unverified', ...metadata, attachedAt: value.attachedAt };
  } catch { return undefined; }
}
function assertPortableBackupFits(state: AppState): void {
  const backup = createPortableBackup(state, { exportId: newId(), exportedAt: now() });
  if (new TextEncoder().encode(JSON.stringify(backup)).length > BACKUP_LIMITS.maxBytes) {
    throw new Error('The resulting backup would exceed the portable backup size limit. No imported data was saved.');
  }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const DEFAULT_SETTINGS: AppSettings = {
  mode: 'preview', timezone: validTimezone(), maxContextTokens: 6000, maxRequestBytes: 24000, maxOutputTokens: 1200, monthlyBudgetUsd: 5,
  reasoningEffort: 'none', maxAttempts: 2, maxCallsPerDay: 20, maxAudioSeconds: 600, audioRetention: 'keep',
};

function initialState(): AppState {
  const day = localDate(DEFAULT_SETTINGS.timezone);
  return {
    notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [],
    settings: { ...DEFAULT_SETTINGS },
    usage: { month: day.slice(0, 7), day, requests: 0, attemptsToday: 0, inputTokens: 0, outputTokens: 0, transcriptionSeconds: 0, attempts: 0, unknownCharges: 0, reservedUsd: 0, priceKnown: false, estimatedCostUsd: 0 },
    mailbox: [], selectedMailTexts: [], calendarEvents: [], syncStates: {}, pendingCredentialCleanup: [], dispatchRecords: [], dispatchRecordQuarantine: [], mailboxSchemaVersion: 2,
    proactive: emptyProactiveState(), importedBackups: [],
  };
}

function emptySyncState(accountId: string): AccountSyncState {
  return {
    accountId, status: 'idle', mailHead: { status: 'idle' }, mailBackfill: { status: 'idle' },
    messagesPartial: false, calendarsPartial: false, eventCursors: {}, eventsCompletedAt: {},
  };
}

function interruptMailLanes(sync: AccountSyncState, message: string): void {
  if (sync.mailHead.status === 'syncing') { sync.mailHead.status = 'error'; sync.mailHead.lastError = message; }
  if (sync.mailBackfill.status === 'syncing') { sync.mailBackfill.status = 'error'; sync.mailBackfill.lastError = message; }
}

function mergeCoverage(current: MailCoverageInterval | undefined, incoming: MailCoverageInterval): MailCoverageInterval | undefined {
  const from = Date.parse(incoming.from);
  const through = Date.parse(incoming.through);
  if (!Number.isFinite(from) || !Number.isFinite(through) || through <= from) return current;
  if (!current) return { from: incoming.from, through: incoming.through };
  const oldFrom = Date.parse(current.from);
  const oldThrough = Date.parse(current.through);
  if (!Number.isFinite(oldFrom) || !Number.isFinite(oldThrough) || oldThrough <= oldFrom) return { from: incoming.from, through: incoming.through };
  if (from > oldThrough || through < oldFrom) return current;
  return { from: new Date(Math.min(from, oldFrom)).toISOString(), through: new Date(Math.max(through, oldThrough)).toISOString() };
}

function canonicalMailboxContent(message: Pick<MailboxSnapshotMessage,
  'providerMessageId' | 'verifiedIdentityKey' | 'connectionGeneration' | 'idFormat' | 'threadId' | 'subject' | 'from' | 'senderEmail' |
  'receivedAt' | 'snippet' | 'isRead' | 'replyMetadataComplete' | 'internetMessageId' | 'providerVersion' | 'replyTo' | 'to' | 'cc' |
  'references' | 'inReplyTo' | 'headers' | 'providerDeletedAt'>): string {
  const {
    connectionGeneration: _generation, observedAt: _observedAt, id: _id, accountId: _accountId,
    identityKey: _identityKey, ...content
  } = message as MailboxSnapshotMessage;
  return stableJson(content);
}

function addActivity(state: AppState, type: ActivityItem['type'], message: string, refs: Partial<ActivityItem> = {}): void {
  state.activity.unshift({ id: newId(), type, message, createdAt: now(), ...refs });
  state.activity = state.activity.slice(0, 250);
}

function markAnalysesStale(state: AppState, sourceIds: string[], prefixes: string[] = []): void {
  for (const note of state.notes) {
    const versions = note.analysis?.sourceVersions;
    if (!versions) continue;
    if (sourceIds.some((id) => id in versions) || Object.keys(versions).some((id) => prefixes.some((prefix) => id.startsWith(prefix)))) note.analysis!.stale = true;
  }
}

function markTaskAnalysesStale(state: AppState, taskId?: string): void {
  markAnalysesStale(state, taskId ? [`task:${encodeURIComponent(taskId)}`] : []);
  for (const note of state.notes) {
    if (note.analysis?.intent === 'answer' && /\btask|todo|to-do|action item/i.test(note.analysis.question ?? '')) note.analysis.stale = true;
  }
}

function upsertDocument(state: AppState, path: string, content: string): ContextDocument {
  const existing = state.documents.find((item) => item.path === path);
  const document: ContextDocument = { path, content, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
  if (existing) Object.assign(existing, document); else state.documents.unshift(document);
  return document;
}

function ensureMemoryDocuments(state: AppState): ContextDocument[] {
  const defaults: Record<string, string> = {
    'memory/PROFILE.md': '# Profile\n\nUser-confirmed facts and preferences.\n',
    'memory/RULES.md': '# Rules\n\nUser-authored rules. Assistant suggestions do not modify this file.\n',
    'memory/ROUTINES.md': '# Routines\n\nUser-confirmed recurring routines.\n',
    'memory/DECISIONS.md': '# Decisions\n\nUser-approved decisions and actions.\n',
    'memory/INFERENCES.md': '# Inferences\n\nUnverified suggestions are labeled and linked to their source note.\n',
  };
  const created: ContextDocument[] = [];
  for (const [path, content] of Object.entries(defaults)) if (!state.documents.some((item) => item.path === path)) created.push(upsertDocument(state, path, content));
  return created;
}

function recordJournal(state: AppState, marker: string, text: string): ContextDocument[] {
  const day = localDate(state.settings.timezone);
  const paths = [
    `logs/daily/${day}.md`, `logs/weekly/${isoWeek(day)}.md`,
    `logs/monthly/${day.slice(0, 7)}.md`, `logs/yearly/${day.slice(0, 4)}.md`,
  ];
  const written: ContextDocument[] = [];
  for (const path of paths) {
    const existing = state.documents.find((item) => item.path === path);
    const tag = `<!-- ${marker} -->`;
    if (existing?.content.includes(tag)) continue;
    const content = `${existing?.content?.trim() || `# ${path.split('/').at(-1)?.replace('.md', '')}\n`}\n${tag}\n- ${text}\n`;
    written.push(upsertDocument(state, path, content));
  }
  return written;
}

function appendDecision(state: AppState, proposal: Proposal): ContextDocument {
  const path = 'memory/DECISIONS.md';
  const existing = state.documents.find((item) => item.path === path);
  const marker = `<!-- approved:${proposal.id}:r${proposal.revision} -->`;
  if (existing?.content.includes(marker)) return existing;
  return upsertDocument(state, path, `${existing?.content?.trim() || '# Decisions'}\n${marker}\n- Approved ${proposal.kind}: ${proposal.title}. Source note ${proposal.noteId}, revision ${proposal.sourceRevision}.\n`);
}

function ensurePeriodDocuments(state: AppState): ContextDocument[] {
  const day = localDate(state.settings.timezone);
  const paths = [
    `logs/daily/${day}.md`, `logs/weekly/${isoWeek(day)}.md`,
    `logs/monthly/${day.slice(0, 7)}.md`, `logs/yearly/${day.slice(0, 4)}.md`,
  ];
  return paths.filter((path) => !state.documents.some((doc) => doc.path === path))
    .map((path) => upsertDocument(state, path, `# ${path.split('/').at(-1)?.replace('.md', '')}\n`));
}

function appendInference(state: AppState, proposal: Proposal, mode: AppSettings['mode']): ContextDocument {
  const path = 'memory/INFERENCES.md';
  const existing = state.documents.find((item) => item.path === path);
  const marker = `<!-- suggestion:${proposal.id}:r${proposal.sourceRevision} -->`;
  if (existing?.content.includes(marker)) return existing;
  const evidence = proposal.evidence.map((item) => `“${item.quote}”`).join('; ');
  const label = mode === 'provider' ? 'Unverified provider suggestion' : 'Offline rule-based preview';
  return upsertDocument(state, path, `${existing?.content?.trim() || '# Inferences'}\n${marker}\n- ${label}: ${proposal.title}. Source note ${proposal.noteId}: ${evidence}\n`);
}

function finiteClamp(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return Math.min(max, Math.max(min, Math.floor(value)));
}
function finiteRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return Math.min(max, Math.max(min, value));
}

function validEmail(value: string): boolean {
  return !/[\r\n]/.test(value) && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

function sameAccountIdentity(a: Account['identity'], b: Account['identity']): boolean {
  return Boolean(a && b && a.providerNamespace === b.providerNamespace && a.clientId === b.clientId &&
    a.subject === b.subject && a.resourceUserId === b.resourceUserId && a.issuer === b.issuer && a.tenantId === b.tenantId);
}

function dispatchIdentityMatches(record: DispatchRecord, account: Account): boolean {
  const identity = account.identity;
  return Boolean(identity && record.account.identity.providerNamespace === identity.providerNamespace &&
    record.account.identity.clientId === identity.clientId && record.account.identity.subject === identity.subject &&
    (record.account.identity.resourceUserId ?? '') === (identity.resourceUserId ?? ''));
}

function assertNoDuplicateDispatch(state: AppState, candidate: DispatchRecord): void {
  const sameSourceIdentity = (record: DispatchRecord) => record.sourceActionKey === candidate.sourceActionKey &&
    record.account.identity.providerNamespace === candidate.account.identity.providerNamespace &&
    record.account.identity.clientId === candidate.account.identity.clientId &&
    record.account.identity.subject === candidate.account.identity.subject &&
    (record.account.identity.resourceUserId ?? '') === (candidate.account.identity.resourceUserId ?? '');
  const candidateMail = candidate.operation === 'draft' || candidate.operation === 'send';
  const recordDuplicate = state.dispatchRecords.some((record) => {
    if (!['pending', 'accepted', 'unknown'].includes(record.outcome)) return false;
    if (record.duplicateKey === candidate.duplicateKey) return true;
    return record.outcome === 'unknown' && candidateMail && (record.operation === 'draft' || record.operation === 'send') && sameSourceIdentity(record);
  });
  if (recordDuplicate) throw new Error('This source action already has a pending, accepted, or unknown provider attempt. Review its dispatch history; it will not be sent again.');

  const recordedProposalIds = new Set(state.dispatchRecords.map((record) => record.proposalId));
  const legacyDuplicate = state.proposals.some((proposal) => {
    if (proposal.id === candidate.proposalId || recordedProposalIds.has(proposal.id) || !['accepted', 'unknown', 'dispatching'].includes(proposal.status) || proposal.simulated) return false;
    const operation = proposal.remoteOperation ?? (proposal.kind === 'email' ? proposal.email?.operation : proposal.kind === 'event' ? 'event' : undefined);
    const proposalMail = proposal.kind === 'email';
    const identity = proposal.accountId ? state.accounts.find((account) => account.id === proposal.accountId) : undefined;
    const sameAccount = proposal.accountId === candidate.accountId || Boolean(identity && dispatchIdentityMatches(candidate, identity));
    const sameSource = proposal.sourceActionKey
      ? proposal.sourceActionKey === candidate.sourceActionKey
      : candidate.sourceProvenance.version === 1
        ? proposal.noteId === candidate.sourceProvenance.noteId && proposal.sourceRevision === candidate.sourceRevision && proposal.kind === (candidate.operation === 'event' ? 'event' : 'email')
        : proposal.kind === 'email' && proposal.provenance?.version === 2 && proposal.provenance.source.sourceDigest === candidate.sourceProvenance.sourceDigest;
    if (!sameAccount || !sameSource) return false;
    if (proposalMail && candidateMail && !operation) return true;
    if (proposal.status === 'unknown' && proposalMail && candidateMail) return true;
    return operation === candidate.operation;
  });
  if (legacyDuplicate) throw new Error('A legacy provider action for this source already exists. Its historical payload was not captured, so this action is blocked from duplicate dispatch.');
}

function identityKey(account: Account): string {
  const identity = account.identity;
  if (!identity?.providerNamespace || !identity.clientId || !identity.subject ||
      (account.provider === 'microsoft' && !identity.resourceUserId)) throw new Error('Verified account identity is incomplete.');
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validMailboxCacheRow(value: unknown): value is MailboxSnapshotMessage {
  if (!isRecord(value)) return false;
  return typeof value.accountId === 'string' && value.accountId.length > 0 && value.accountId.length <= 256 &&
    typeof value.providerMessageId === 'string' && value.providerMessageId.length > 0 && value.providerMessageId.length <= 1024;
}

function validCalendarCacheRow(value: unknown): value is CalendarEventSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.accountId === 'string' && value.accountId.length > 0 && value.accountId.length <= 256 &&
    typeof value.calendarId === 'string' && value.calendarId.length > 0 && value.calendarId.length <= 256 &&
    typeof value.providerEventId === 'string' && value.providerEventId.length > 0 && value.providerEventId.length <= 1024;
}

function assistContext(state: AppState, note: Note, intent: AssistIntent, question?: string): { documents: ContextDocument[]; additionalSources: AssistantSourceInput[]; omittedSourceCount: number; omittedSourceIds: string[] } {
  const allDocuments = state.documents.filter(({ path }) => !path.startsWith('logs/') && path !== 'memory/INFERENCES.md' && path !== 'memory/DECISIONS.md');
  const taskQuery = intent === 'answer' && /\b(task|tasks|task count|how many|todo|to-do|action item)\b/i.test(question ?? '');
  const built = buildLocalSourceSet({
    transcript: { revision: note.revision, text: note.transcript },
    query: `${question ?? ''}\n${note.transcript}`,
    intent,
    documents: allDocuments.map((doc) => ({ path: doc.path, revision: doc.revision, content: doc.content, updatedAt: doc.updatedAt })),
    tasks: taskQuery ? state.tasks.map((task) => ({ id: task.id, title: task.title, body: task.body, status: task.status, dueAt: task.dueAt, updatedAt: task.completedAt ?? task.createdAt })) : [],
    calendars: state.calendars.flatMap((calendar) => {
      const account = state.accounts.find((item) => item.id === calendar.accountId);
      return account?.connected && account.authStatus === 'connected'
        ? [{ id: calendar.id, accountId: calendar.accountId, identityKey: identityKey(account), providerId: calendar.providerId, name: calendar.name, writable: calendar.writable, connected: calendar.connected }]
        : [];
    }),
    calendarEvents: state.calendarEvents.flatMap((event) => {
      const account = state.accounts.find((item) => item.id === event.accountId);
      return account?.connected && account.authStatus === 'connected' ? [{ ...event, identityKey: identityKey(account) }] : [];
    }),
    mailbox: state.mailbox.flatMap((message) => {
      const account = state.accounts.find((item) => item.id === message.accountId);
      if (!account?.connected || account.authStatus !== 'connected' || !message.providerMessageId || message.providerDeletedAt || message.replyMetadataComplete !== true) return [];
      const accountIdentity = identityKey(account);
      return message.identityKey === `${accountIdentity}:${message.providerMessageId}` &&
        (!message.verifiedIdentityKey || message.verifiedIdentityKey === accountIdentity)
        ? [{ ...message, identityKey: accountIdentity }]
        : [];
    }),
  });
  const documentByPath = new Map(allDocuments.map((document) => [document.path, document]));
  return {
    documents: built.sources.filter((source) => source.id.startsWith('doc:')).flatMap((source) => {
      const document = documentByPath.get(source.id.slice('doc:'.length));
      return document ? [document] : [];
    }),
    additionalSources: built.sources.filter((source) => source.id !== 'transcript' && !source.id.startsWith('doc:') && (taskQuery || !source.id.startsWith('task:'))),
    omittedSourceCount: built.omittedSourceCount,
    omittedSourceIds: built.omittedSourceIds,
  };
}

function sameSourceVersions(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftIds = Object.keys(left).sort();
  const rightIds = Object.keys(right).sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index] && left[id] === right[id]);
}

function offlineAssistInputs(note: Note, intent: AssistIntent, question: string | undefined, additionalSources: AssistantSourceInput[], calendarAvailable: boolean): AssistantSourceInput[] {
  const taskQuestion = intent === 'answer' && /\b(task|tasks|todo|to-do|action item)\b/i.test(question ?? '');
  const calendarQuestion = intent === 'answer' && /\b(calendar|meeting|event|upcoming|tomorrow|today|next)\b/i.test(question ?? '') && calendarAvailable;
  return [
    { id: 'transcript', revision: note.revision, text: note.transcript, required: true, kind: 'note' },
    ...additionalSources.filter((source) => taskQuestion && source.id.startsWith('task:') || calendarQuestion && source.id.startsWith('calendar')),
  ];
}

function grantedCapabilities(provider: Account['provider'], scopes: string[]): AccountCapability[] {
  const values = new Set(scopes.map((scope) => scope.toLowerCase()));
  const has = (...candidates: string[]) => candidates.some((candidate) => values.has(candidate.toLowerCase()));
  const result: AccountCapability[] = [];
  if (provider === 'google') {
    if (has('https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.metadata', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/')) result.push('mail.read');
    if (has('https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/')) result.push('mail.draft');
    if (has('https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://mail.google.com/')) result.push('mail.send');
    if (has('https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.events')) result.push('calendar.read');
    if (has('https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events')) result.push('calendar.write');
  } else if (provider === 'microsoft') {
    if (has('mail.read', 'mail.readbasic', 'mail.readwrite')) result.push('mail.read');
    if (has('mail.readwrite')) result.push('mail.draft');
    if (has('mail.send')) result.push('mail.send');
    if (has('calendars.read', 'calendars.readwrite')) result.push('calendar.read');
    if (has('calendars.readwrite')) result.push('calendar.write');
  }
  return result;
}

function intersectCapabilities(...groups: AccountCapability[][]): AccountCapability[] {
  const first = groups[0] ?? [];
  return first.filter((capability) => groups.every((group) => group.includes(capability)));
}

async function approvedDigest(proposal: Proposal, state: AppState): Promise<string> {
  const account = state.accounts.find((item) => item.id === proposal.accountId);
  const calendar = state.calendars.find((item) => item.id === proposal.calendarId);
  const payload = JSON.stringify({
    id: proposal.id, revision: proposal.revision, noteId: proposal.noteId, sourceRevision: proposal.sourceRevision,
    provenance: proposal.provenance ?? null, requiresRebuild: proposal.requiresRebuild ?? false,
    kind: proposal.kind, title: proposal.title, body: proposal.body,
    accountId: proposal.accountId ?? null, accountIdentity: account ? {
      provider: account.provider, email: account.email, authStatus: account.authStatus,
      identity: account.identity ? {
        providerNamespace: account.identity.providerNamespace ?? null, clientId: account.identity.clientId ?? null,
        subject: account.identity.subject, issuer: account.identity.issuer ?? null, tenantId: account.identity.tenantId ?? null,
        resourceUserId: account.identity.resourceUserId ?? null,
      } : null,
      scopes: account.grantedScopes ?? [], capabilities: account.capabilities ?? [], capabilityLimits: account.capabilityLimits ?? [],
    } : null,
    recipients: [...proposal.recipients], calendarId: proposal.calendarId ?? null,
    calendarDestination: calendar ? { accountId: calendar.accountId, providerId: calendar.providerId ?? null, name: calendar.name, writable: calendar.writable, connected: calendar.connected } : null,
    dueAt: proposal.dueAt ?? null, email: proposal.email ?? null, event: proposal.event ?? null, evidence: proposal.evidence,
  });
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload, { encoding: Crypto.CryptoEncoding.HEX });
}

export function extractPreviewProposals(note: Note): Proposal[] {
  const sentences = note.transcript.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const proposals: Proposal[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    let kind: Proposal['kind'] | undefined;
    if (/\b(remember|keep in mind|my preference is|i prefer)\b/.test(lower)) kind = 'memory';
    else if (/\b(email|e-mail|send|reply to|message)\b/.test(lower)) kind = 'email';
    else if (/\b(meeting|schedule|calendar|appointment|event)\b/.test(lower)) kind = 'event';
    else if (/\b(remind me|reminder|don't forget|due (today|tomorrow|on))\b/.test(lower)) kind = 'reminder';
    else if (/\b(need to|todo|to-do|i should|i must|action item|follow up|follow-up)\b/.test(lower)) kind = 'task';
    if (!kind) continue;
    proposals.push({
      id: newId(), noteId: note.id, kind, title: sentence.replace(/^[\s.!?]+|[.!?]+$/g, '').slice(0, 88) || 'Suggested action',
      body: sentence, status: 'draft', revision: 1, recipients: [], sourceRevision: note.revision,
      evidence: [{ quote: sentence, source: 'transcript' }],
    });
  }
  return proposals;
}

function normalizeActionEvidence(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function sourceActionKey(note: Note, kind: Proposal['kind'], evidence: Proposal['evidence']): string {
  const sentences = note.transcript.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  const anchors = [...new Set(evidence.map(({ quote }) => {
    const normalizedQuote = normalizeActionEvidence(quote);
    const sentence = sentences.find((candidate) => normalizeActionEvidence(candidate).includes(normalizedQuote));
    return normalizeActionEvidence(sentence ?? quote);
  }).filter(Boolean))].sort();
  return JSON.stringify([note.id, note.revision, kind, anchors]);
}

function createProposalProvenance(input: {
  analysisFingerprint: string; note: Note; intent: AssistIntent; question?: string;
  sourceVersions: Record<string, string>; policySources: ProposalProvenance['policySources']; settings: AppSettings; answeredAsOf?: string;
}): ProposalProvenance | undefined {
  const sources = Object.entries(input.sourceVersions).map(([sourceId, sourceVersion]) => {
    const match = /^(\d+):([a-f0-9]{64})$/i.exec(sourceVersion);
    if (!match) return undefined;
    return { sourceId, revision: Number(match[1]), sourceVersion };
  });
  if (sources.some((source) => !source)) return undefined;
  const expiresAt = input.answeredAsOf
    ? new Date((Math.floor(Date.parse(input.answeredAsOf) / 900_000) + 1) * 900_000).toISOString()
    : undefined;
  return {
    version: 1, assistContractVersion: ASSIST_CONTRACT_VERSION, analysisFingerprint: input.analysisFingerprint,
    noteId: input.note.id, noteRevision: input.note.revision, capturedAt: input.note.capturedAt ?? input.note.createdAt,
    captureTimeZone: input.note.captureTimeZone || input.settings.timezone,
    intent: input.intent, ...(input.question ? { question: input.question } : {}),
    sources: sources as NonNullable<typeof sources[number]>[], policySources: input.policySources,
    settingsFingerprint: JSON.stringify(input.settings),
    ...(input.answeredAsOf ? { answeredAsOf: input.answeredAsOf, expiresAt } : {}),
  };
}

function normalizeLoadedState(value: unknown): AppState & { backupImportQuarantine?: unknown[] } {
  const defaults = initialState();
  if (!value || typeof value !== 'object') throw new Error('Saved app data is not a valid state snapshot. It was preserved for recovery.');
  const raw = value as Partial<AppState>;
  if (!Array.isArray(raw.notes) || !Array.isArray(raw.proposals) || !Array.isArray(raw.accounts) ||
      !Array.isArray(raw.calendars) || !Array.isArray(raw.documents) || !Array.isArray(raw.activity)) {
    throw new Error('Saved app data is incomplete. It was preserved for recovery.');
  }
  const rawSettings: Partial<AppSettings> = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const maxRequestBytes = Number.isFinite(rawSettings.maxRequestBytes) ? Math.max(4000, Math.min(96000, Math.floor(rawSettings.maxRequestBytes!))) : DEFAULT_SETTINGS.maxRequestBytes;
  const rawArchives = (raw as Partial<AppState> & { importedBackups?: unknown }).importedBackups;
  const backupImportQuarantine: unknown[] = [];
  const retainedBackupQuarantine = (value as { backupImportQuarantine?: unknown }).backupImportQuarantine;
  if (Array.isArray(retainedBackupQuarantine)) backupImportQuarantine.push(...retainedBackupQuarantine);
  else if (retainedBackupQuarantine !== undefined) backupImportQuarantine.push(retainedBackupQuarantine);
  const importedBackups: ImportedBackupArchive[] = [];
  if (Array.isArray(rawArchives)) {
    if (rawArchives.length > 50) backupImportQuarantine.push(...rawArchives);
    else for (const candidate of rawArchives) {
      const validated = validateImportedBackupArchive(candidate);
      if (validated) importedBackups.push(validated); else backupImportQuarantine.push(candidate);
    }
  } else if (rawArchives !== undefined) backupImportQuarantine.push(rawArchives);
  const notes = raw.notes.map((note) => {
    const analysis = note.analysis ? {
      ...note.analysis,
      includedSources: Array.isArray(note.analysis.includedSources) ? note.analysis.includedSources : (note.analysis.includedSourceIds ?? []).map((id) => ({ id, title: id })),
      omittedSourceCount: Number.isFinite(note.analysis.omittedSourceCount) ? note.analysis.omittedSourceCount : (note.analysis.omittedSourceIds ?? []).length,
    } : undefined;
    const audioAttachment = validAudioAttachment(note.audioAttachment);
    const normalized: Note = { ...note, revision: Number.isFinite(note.revision) ? note.revision : 1, capturedAt: note.capturedAt ?? note.createdAt,
      captureTimeZone: note.importOrigin?.originalTimeZoneUnknown === true ? 'UTC' : validTimezone(note.captureTimeZone ?? rawSettings.timezone), analysis };
    if (audioAttachment && note.audioUri && note.importOrigin?.kind === 'backup_import') normalized.audioAttachment = audioAttachment;
    else if (note.audioAttachment !== undefined || note.importOrigin?.kind === 'backup_import' && Boolean(note.audioUri) && !audioAttachment) {
      // Never trust an attached file path after discarding its integrity metadata.
      delete normalized.audioUri;
      delete normalized.audioAttachment;
      if (note.importOrigin?.kind === 'backup_import') normalized.importOrigin = { ...note.importOrigin, audioMissing: true };
    }
    return normalized;
  });
  if (raw.mailboxSchemaVersion !== 2) {
    const hasLegacyMicrosoftMailbox = raw.accounts!.some((account) => account.provider === 'microsoft');
    if (hasLegacyMicrosoftMailbox) for (const note of notes) {
      if (Object.keys(note.analysis?.sourceVersions ?? {}).some((sourceId) => sourceId.startsWith('mail:'))) note.analysis!.stale = true;
    }
  }
  const proposals = raw.proposals.map((proposal) => {
    const source = notes.find((note) => note.id === proposal.noteId);
    const validProvenanceList = (items: unknown): boolean => {
      if (!Array.isArray(items)) return false;
      const ids = new Set<string>();
      return items.every((item) => {
        if (!item || typeof item.sourceId !== 'string' || !item.sourceId || ids.has(item.sourceId) ||
            !Number.isSafeInteger(item.revision) || item.revision < 0 || typeof item.sourceVersion !== 'string') return false;
        const match = /^(\d+):([a-f0-9]{64})$/i.exec(item.sourceVersion);
        if (!match || Number(match[1]) !== item.revision) return false;
        ids.add(item.sourceId);
        return true;
      });
    };
    const candidateProvenance = proposal.provenance;
    const noteProvenance = candidateProvenance && candidateProvenance.version === 1 &&
      candidateProvenance.assistContractVersion === ASSIST_CONTRACT_VERSION &&
      typeof candidateProvenance.analysisFingerprint === 'string' && typeof candidateProvenance.noteId === 'string' &&
      Number.isSafeInteger(candidateProvenance.noteRevision) && typeof candidateProvenance.capturedAt === 'string' &&
      Number.isFinite(Date.parse(candidateProvenance.capturedAt)) && typeof candidateProvenance.captureTimeZone === 'string' &&
      ['assist', 'summarize', 'answer', 'extract'].includes(candidateProvenance.intent) &&
      typeof candidateProvenance.settingsFingerprint === 'string' && validProvenanceList(candidateProvenance.sources) &&
      candidateProvenance.sources.some((item) => item.sourceId === 'transcript') && validProvenanceList(candidateProvenance.policySources) &&
      (!candidateProvenance.answeredAsOf || Number.isFinite(Date.parse(candidateProvenance.answeredAsOf))) &&
      (!candidateProvenance.expiresAt || Number.isFinite(Date.parse(candidateProvenance.expiresAt)))
      ? candidateProvenance : undefined;
    const mailProvenance = candidateProvenance && candidateProvenance.version === 2 && candidateProvenance.kind === 'mail_reply' &&
      typeof candidateProvenance.sourceDigest === 'string' && /^[a-f\d]{64}$/i.test(candidateProvenance.sourceDigest) &&
      candidateProvenance.source?.version === 1 && candidateProvenance.source.sourceDigest === candidateProvenance.sourceDigest &&
      typeof candidateProvenance.source.observedAt === 'string' && Number.isFinite(Date.parse(candidateProvenance.source.observedAt)) &&
      new Date(Date.parse(candidateProvenance.source.observedAt)).toISOString() === candidateProvenance.source.observedAt &&
      typeof candidateProvenance.expiresAt === 'string' && Number.isFinite(Date.parse(candidateProvenance.expiresAt)) &&
      candidateProvenance.expiresAt === new Date(Date.parse(candidateProvenance.source.observedAt) + 15 * 60_000).toISOString()
      ? candidateProvenance : undefined;
    const provenance = noteProvenance ?? mailProvenance;
    const pending = ['draft', 'approved', 'failed'].includes(proposal.status);
    const requiresRebuild = Boolean(proposal.requiresRebuild || (pending && !provenance));
    return {
      ...proposal, recipients: Array.isArray(proposal.recipients) ? proposal.recipients : [],
      evidence: Array.isArray(proposal.evidence) ? proposal.evidence : [],
      revision: Number.isFinite(proposal.revision) ? proposal.revision : 1,
      ...(provenance?.version === 2 ? {} : { sourceRevision: Number.isFinite(proposal.sourceRevision) ? proposal.sourceRevision : source?.revision ?? 1 }),
      provenance, requiresRebuild,
      ...(requiresRebuild && proposal.status === 'approved' ? { status: 'draft' as const, approvedRevision: undefined, approvedPayloadDigest: undefined } : {}),
      sourceActionKey: proposal.sourceActionKey ?? (source && Array.isArray(proposal.evidence)
        ? sourceActionKey({ ...source, revision: Number.isFinite(proposal.sourceRevision) ? proposal.sourceRevision! : source.revision }, proposal.kind, proposal.evidence)
        : undefined),
    };
  });
  const migratedTasks: LocalTask[] = proposals.filter((proposal) => proposal.kind === 'task' && ['executed', 'accepted'].includes(proposal.status) && Boolean(proposal.noteId) && Number.isSafeInteger(proposal.sourceRevision))
    .map((proposal) => ({ id: proposal.id, title: proposal.title, body: proposal.body, status: 'open', createdAt: proposal.remoteAcceptedAt ?? now(), dueAt: proposal.dueAt, sourceNoteId: proposal.noteId!, sourceRevision: proposal.sourceRevision!, proposalId: proposal.id }));
  for (const note of notes) {
    const origin: unknown = note.importOrigin;
    if (origin === undefined) continue;
    if (!isRecord(origin) || origin.kind !== 'backup_import' || typeof origin.archiveId !== 'string' || typeof origin.sourceNoteId !== 'string' || typeof origin.audioMissing !== 'boolean' ||
        (origin.originalTimeZoneUnknown !== undefined && origin.originalTimeZoneUnknown !== true) || (origin.originUnverified !== undefined && origin.originUnverified !== true)) { delete note.importOrigin; continue; }
    const archive = importedBackups.find((item) => item.id === origin.archiveId);
    const linked = Boolean(archive?.noteLinks.some((link) => link.noteId === note.id && link.sourceId === origin.sourceNoteId));
    const timeZoneConfirmedAt = origin.originalTimeZoneUnknown !== true && typeof origin.timeZoneConfirmedAt === 'string' && Number.isFinite(Date.parse(origin.timeZoneConfirmedAt)) && new Date(Date.parse(origin.timeZoneConfirmedAt)).toISOString() === origin.timeZoneConfirmedAt
      ? origin.timeZoneConfirmedAt : undefined;
    note.importOrigin = { kind: 'backup_import', archiveId: origin.archiveId, sourceNoteId: origin.sourceNoteId, audioMissing: origin.audioMissing,
      ...(origin.originalTimeZoneUnknown === true && !timeZoneConfirmedAt ? { originalTimeZoneUnknown: true } : {}),
      ...(timeZoneConfirmedAt ? { timeZoneConfirmedAt } : {}), ...(!linked || origin.originUnverified === true ? { originUnverified: true } : {}) };
  }
  const savedTasks: LocalTask[] = [];
  for (const candidate of (Array.isArray(raw.tasks) ? raw.tasks : []) as unknown[]) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || typeof candidate.body !== 'string' || !['open', 'completed'].includes(String(candidate.status)) || typeof candidate.createdAt !== 'string') continue;
    const origin = candidate.importOrigin;
    if (isRecord(origin) && origin.kind === 'backup_import') {
      const archive = importedBackups.find((item) => item.id === origin.archiveId);
      if (typeof origin.archiveId !== 'string' || typeof origin.sourceTaskId !== 'string') continue;
      const linkedTask = Boolean(archive?.taskLinks.some((link) => link.sourceId === origin.sourceTaskId && link.taskId === candidate.id));
      const noteSource = typeof origin.originalSourceNoteId === 'string' ? origin.originalSourceNoteId : undefined;
      const linkedNote = noteSource ? archive?.noteLinks.find((link) => link.sourceId === noteSource) : undefined;
      if (typeof candidate.sourceNoteId === 'string' && (!linkedNote || linkedNote.noteId !== candidate.sourceNoteId)) delete candidate.sourceNoteId;
      savedTasks.push({ id: candidate.id, title: candidate.title, body: candidate.body, status: candidate.status as 'open' | 'completed', createdAt: candidate.createdAt,
        ...(typeof candidate.completedAt === 'string' ? { completedAt: candidate.completedAt } : {}), ...(typeof candidate.dueAt === 'string' ? { dueAt: candidate.dueAt } : {}),
        ...(typeof candidate.sourceNoteId === 'string' ? { sourceNoteId: candidate.sourceNoteId } : {}),
        importOrigin: { kind: 'backup_import', archiveId: origin.archiveId, sourceTaskId: origin.sourceTaskId,
          ...(noteSource ? { originalSourceNoteId: noteSource } : {}), ...(!linkedTask || origin.originUnverified === true ? { originUnverified: true as const } : {}) } });
      continue;
    }
    if (typeof candidate.sourceNoteId !== 'string' || !Number.isSafeInteger(candidate.sourceRevision) || typeof candidate.proposalId !== 'string') continue;
    savedTasks.push({ id: candidate.id, title: candidate.title, body: candidate.body, status: candidate.status as 'open' | 'completed', createdAt: candidate.createdAt,
      ...(typeof candidate.completedAt === 'string' ? { completedAt: candidate.completedAt } : {}), ...(typeof candidate.dueAt === 'string' ? { dueAt: candidate.dueAt } : {}),
      sourceNoteId: candidate.sourceNoteId, sourceRevision: candidate.sourceRevision as number, proposalId: candidate.proposalId });
  }
  const tasks = [...savedTasks, ...migratedTasks.filter((task) => !savedTasks.some((saved) => saved.id === task.id))];
  const settings = { ...DEFAULT_SETTINGS, ...rawSettings, timezone: validTimezone(rawSettings.timezone), maxRequestBytes };
  const dispatchRecords: DispatchRecord[] = [];
  const dispatchRecordQuarantine: AppState['dispatchRecordQuarantine'] = Array.isArray(raw.dispatchRecordQuarantine)
    ? raw.dispatchRecordQuarantine.map((item) => item && typeof item === 'object' && 'raw' in item && 'quarantinedAt' in item
      ? { reason: 'invalid_persisted_receipt' as const, quarantinedAt: typeof item.quarantinedAt === 'string' ? item.quarantinedAt : now(), raw: item.raw }
      : { reason: 'invalid_persisted_receipt' as const, quarantinedAt: now(), raw: item })
    : [];
  if (Array.isArray(raw.dispatchRecords)) {
    for (const value of raw.dispatchRecords) {
      try { dispatchRecords.push(validateDispatchRecord(value)); }
      catch { dispatchRecordQuarantine.push({ reason: 'invalid_persisted_receipt', quarantinedAt: now(), raw: value }); }
    }
  }
  const recordIds = new Set(dispatchRecords.map((record) => record.id));
  for (const proposal of proposals) {
    if (proposal.dispatchRecordId && !recordIds.has(proposal.dispatchRecordId)) proposal.dispatchRecordId = undefined;
    if ((proposal.kind === 'email' || proposal.kind === 'event') && ['accepted', 'unknown'].includes(proposal.status) && !proposal.dispatchRecordId) {
      proposal.dispatchHistoryIncomplete = true;
    }
  }
  return {
    ...defaults, ...raw, notes, proposals, tasks, importedBackups,
    ...(backupImportQuarantine.length ? { backupImportQuarantine } : {}),
    backupRecoveryStatus: backupImportQuarantine.length
      ? { quarantinedArchiveCount: backupImportQuarantine.length, message: 'Some imported backup archive data could not be validated and is held privately.' as const }
      : undefined,
    selectedMailTexts: Array.isArray(raw.selectedMailTexts)
      ? raw.selectedMailTexts.filter(validSelectedMailTextSnapshot).slice(0, 20)
      : [],
    proactive: emptyProactiveState(),
    dispatchRecords, dispatchRecordQuarantine,
    pendingCredentialCleanup: Array.isArray(raw.pendingCredentialCleanup) ? raw.pendingCredentialCleanup.filter((item) =>
      item && typeof item.tokenRef === 'string' && item.tokenRef.length > 0 && ['replaced', 'disconnected', 'orphan'].includes(item.reason) && typeof item.createdAt === 'string') : [],
    // Account configuration is not authentication and cannot restore an OAuth connection.
    accounts: raw.accounts.map((account) => {
      const authStatus = ['configured', 'connected', 'reauth_required', 'revoked'].includes(account.authStatus) ? account.authStatus : 'configured';
      const identity = account.identity && typeof account.identity.subject === 'string'
        ? {
          ...(account.identity.providerNamespace === 'google' || account.identity.providerNamespace === 'microsoft' ? { providerNamespace: account.identity.providerNamespace } : {}),
          ...(typeof account.identity.clientId === 'string' ? { clientId: account.identity.clientId } : {}),
          subject: account.identity.subject,
          ...(typeof account.identity.issuer === 'string' ? { issuer: account.identity.issuer } : {}),
          ...(typeof account.identity.tenantId === 'string' ? { tenantId: account.identity.tenantId } : {}),
          ...(typeof account.identity.resourceUserId === 'string' ? { resourceUserId: account.identity.resourceUserId } : {}),
        }
        : undefined;
      const tokenRef = typeof account.tokenRef === 'string' ? account.tokenRef : undefined;
      const verified = authStatus === 'connected' && Boolean(identity?.providerNamespace && identity.clientId && identity.subject && tokenRef) &&
        (identity?.providerNamespace !== 'microsoft' || Boolean(identity.resourceUserId)) && identity?.providerNamespace === account.provider;
      if (!verified && identity) delete identity.tenantId;
      return {
        ...account, authStatus: authStatus === 'connected' && !verified ? 'reauth_required' : authStatus, identity, tokenRef, connected: verified,
        grantedScopes: Array.isArray(account.grantedScopes) ? account.grantedScopes.filter((scope): scope is string => typeof scope === 'string') : [],
        capabilities: Array.isArray(account.capabilities) ? account.capabilities.filter((capability) => ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'].includes(capability)) : [],
        capabilityLimits: Array.isArray(account.capabilityLimits) ? account.capabilityLimits.filter((capability): capability is AccountCapability => ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'].includes(capability)) : [],
        connectionGeneration: Number.isInteger(account.connectionGeneration) && account.connectionGeneration! >= 0 ? account.connectionGeneration : 0,
        syncStatus: ['idle', 'partial', 'error'].includes(String(account.syncStatus)) ? account.syncStatus : 'idle',
      };
    }),
    calendars: raw.calendars.map((calendar) => ({ ...calendar, connected: false, writable: false })),
    settings,
    usage: { ...defaults.usage, ...raw.usage },
    mailbox: Array.isArray(raw.mailbox) ? raw.mailbox.filter((message): message is MailboxSnapshotMessage => validMailboxCacheRow(message) &&
      (raw.mailboxSchemaVersion === 2 || !raw.accounts!.some((account) => account.id === message.accountId && account.provider === 'microsoft'))) : [],
    calendarEvents: Array.isArray(raw.calendarEvents) ? raw.calendarEvents.filter(validCalendarCacheRow) : [],
    syncStates: Object.fromEntries(raw.accounts!.map((account) => {
      const previous = raw.syncStates?.[account.id] as AccountSyncState | undefined;
      const base = emptySyncState(account.id);
      const normalized: AccountSyncState = {
        ...base, ...(previous && typeof previous === 'object' ? previous : {}), accountId: account.id,
        mailHead: {
          ...base.mailHead, ...(previous?.mailHead ?? {}),
          status: previous?.mailHead?.status === 'syncing' ? 'error' : (['idle', 'partial', 'error'].includes(previous?.mailHead?.status ?? '') ? previous!.mailHead!.status : 'idle'),
          ...(previous?.mailHead?.status === 'syncing' ? { lastError: 'App closed during this mailbox refresh. Run Refresh inbox to try again.' } : {}),
        },
        mailBackfill: {
          ...base.mailBackfill, ...(previous?.mailBackfill ?? {}),
          status: previous?.mailBackfill?.status === 'syncing' ? 'error' : (['idle', 'partial', 'error'].includes(previous?.mailBackfill?.status ?? '') ? previous!.mailBackfill!.status : 'idle'),
          ...(previous?.mailBackfill?.status === 'syncing' ? { lastError: 'App closed during this backfill page. Continue to retry the saved window.' } : {}),
        },
        eventCursors: previous?.eventCursors && typeof previous.eventCursors === 'object' ? previous.eventCursors : {},
        eventsCompletedAt: previous?.eventsCompletedAt && typeof previous.eventsCompletedAt === 'object' ? previous.eventsCompletedAt : {},
      };
      if (raw.mailboxSchemaVersion !== 2) {
        normalized.messagesCursor = undefined; normalized.messagesCompletedAt = undefined; normalized.messagesPartial = false; normalized.messagesTimeMin = undefined;
      }
      return [account.id, normalized];
    })),
    mailboxSchemaVersion: 2,
  };
}

export interface ControllerIntegrationDependencies {
  tokenStore?: OAuthTokenStore;
  deleteToken?: (tokenRef: string) => Promise<void>;
  verifyOAuthResult?: (result: OAuthBridgeResult, stored: StoredOAuthToken) => Promise<boolean>;
  clientIds?: Partial<Record<'google' | 'microsoft', string>>;
  connectorFactory?: (
    tokenStore: OAuthTokenStore,
    onAuthStatus: (accountId: string, status: Account['authStatus']) => Promise<void>,
  ) => ConnectorClient;
  recordingRecovery?: RecordingRecoveryService;
}

interface BackupImportSession {
  preview: BackupImportPreview;
  backup: PortableBackupV2;
  capturedState: AppState;
  capturedStateJson: string;
  preparedAtMs: number;
  archiveId: string;
  existingArchiveId?: string;
  noteIds: Record<string, string>;
  taskIds: Record<string, string>;
  taskLinkRepairs: Record<string, { sourceNoteId: string; oldNoteId?: string }>;
  missingNoteSourceIds: string[];
  missingTaskSourceIds: string[];
  documentIds: Record<string, string>;
  historyIds: Record<string, string>;
  appliedArchiveId?: string;
}

interface RecordingAttachmentSession {
  preview: RecordingAttachmentPreview;
  staged: StagedRecording;
  preparedAtMs: number;
  status: 'ready' | 'applying' | 'canceling';
}

interface RecordingAttachmentReceipt {
  planHash: string;
  noteId: string;
  uri: string;
  sha256: string;
}

export class AppControllerImpl implements AppController {
  private state = initialState();
  private snapshot = deepFreeze(clone(this.state));
  private listeners = new Set<(state: AppState) => void>();
  private transactionQueue = Promise.resolve();
  private loadPromise?: Promise<void>;
  private loaded = false;
  private processJobs = new Map<string, Promise<Proposal[]>>();
  private assistJobs = new Map<string, Promise<NoteAssistResult>>();
  private analysisCache = new Map<string, DraftAnalysis>();
  private mirrorDirty = new Set<string>();
  private readonly speechClient: AzureSpeechClient;
  private readonly openAiClient: AzureOpenAIClient;
  private readonly connector?: ConnectorClient;
  private activeSyncCount = 0;
  private syncQueue: (() => void)[] = [];
  private syncJobs = new Map<string, Promise<AccountSyncState>>();
  private mailLaneJobs = new Map<string, Promise<MailLaneResult>>();
  private foregroundMailJob?: Promise<ForegroundMailRefreshResult>;
  private busySyncAccounts = new Set<string>();
  private syncGeneration = new Map<string, number>();
  private syncAbortControllers = new Map<string, AbortController>();
  private credentialCleanupJob?: Promise<void>;
  private installingTokenRefs = new Set<string>();
  private proactiveQuarantine?: ProactiveQuarantine;
  private backupImportQuarantine: unknown[] = [];
  private proactiveSourceHashMemo: ProactiveSourceHashMemo = new Map();
  private mailReplyGenerations = new Map<string, { messageId: string; promise: Promise<MailReplyTextGenerationResult> }>();
  private mailReplyGenerationCache = new Map<string, MailReplyTextGenerationResult>();
  private backupImportSessions = new Map<string, BackupImportSession>();
  private recordingAttachmentSessions = new Map<string, RecordingAttachmentSession>();
  private recordingAttachmentJobs = new Map<string, Promise<Note>>();
  private recordingAttachmentReceipts = new Map<string, RecordingAttachmentReceipt>();
  private recordingRecoveryPromise?: Promise<RecordingRecoveryService>;

  constructor(
    private readonly store: StateStore = stateStore,
    providers: { speech?: AzureSpeechClient; openAi?: AzureOpenAIClient } = {},
    private readonly integration: ControllerIntegrationDependencies = {},
  ) {
    this.speechClient = providers.speech ?? new AzureSpeechClient({});
    this.openAiClient = providers.openAi ?? new AzureOpenAIClient();
    this.connector = integration.tokenStore && integration.connectorFactory
      ? integration.connectorFactory(integration.tokenStore, (accountId, status) => this.handleConnectorAuthStatus(accountId, status))
      : undefined;
  }

  private async getRecordingRecoveryService(): Promise<RecordingRecoveryService> {
    if (this.integration.recordingRecovery) return this.integration.recordingRecovery;
    this.recordingRecoveryPromise ??= import('../audio/recovery').then((module) => module.recordingRecoveryService)
      .catch((error) => { this.recordingRecoveryPromise = undefined; throw error; });
    return this.recordingRecoveryPromise;
  }

  getSnapshot(): AppState { return this.snapshot; }
  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(this.snapshot); } catch { /* A view callback cannot roll back or reject a durable state commit. */ }
    }
  }

  private persistedState(state: AppState): AppState {
    const result = { ...state } as AppState & { proactiveQuarantine?: unknown; backupImportQuarantine?: unknown[] };
    if (this.proactiveQuarantine) result.proactiveQuarantine = clone(this.proactiveQuarantine);
    if (this.backupImportQuarantine.length) result.backupImportQuarantine = clone(this.backupImportQuarantine);
    return result;
  }

  private publicState(state: AppState): AppState {
    const result = clone(state) as AppState & { proactiveQuarantine?: unknown; backupImportQuarantine?: unknown };
    delete result.proactiveQuarantine;
    delete result.backupImportQuarantine;
    return result;
  }

  private async evaluateProactiveDraft(state: AppState): Promise<boolean> {
    if (this.proactiveQuarantine || state.proactive.integrityError) return false;
    const before = proactiveStableValue(state.proactive);
    const helperRules = state.proactive.rules.map(({ name: _name, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...rule }) => rule);
    const byRule = new Map(state.proactive.rules.map((rule) => [rule.id, rule]));
    const enabledRules = helperRules.filter((rule) => rule.enabled);
    if (enabledRules.length === 0) {
      state.proactive.candidates = state.proactive.candidates.filter((entry) => byRule.get(entry.candidate.ruleId)?.enabled === true);
      state.proactive.dismissals = state.proactive.dismissals.filter((item) => {
        const rule = byRule.get(item.ruleId);
        return Boolean(rule && item.ruleRevision >= rule.revision);
      });
      state.proactive.snoozes = state.proactive.snoozes.filter((item) => Date.parse(item.until) > Date.now() && byRule.has(item.ruleId));
      delete state.proactive.lastEvaluation;
      return before !== proactiveStableValue(state.proactive);
    }
    const nowDate = new Date();
    const nowUtc = nowDate.toISOString();
    const previousCandidates = state.proactive.candidates.map((entry) => entry.candidate);
    const builtSources = await buildProactiveSources(
      state,
      previousCandidates,
      nowDate.getTime(),
      this.proactiveSourceHashMemo,
      (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, { encoding: Crypto.CryptoEncoding.HEX }),
    );
    const sources = builtSources.sources;
    const result = evaluateProactive({
      nowUtc, timeZone: state.settings.timezone, rules: helperRules, sources, previousCandidates,
      dismissedCandidateIds: state.proactive.dismissals.map((item) => item.candidateId),
      snoozes: state.proactive.snoozes.map(({ suppressionKey, until, snoozedAt }) => ({ suppressionKey, until, snoozedAt })),
      sourceSnapshotComplete: false,
    });
    const active = result.activeCandidates.map((candidate) => ({ candidate, presentation: 'active' as const }));
    const deferred = result.deferredCandidates.map((candidate) => ({ candidate, presentation: 'deferred' as const }));
    const dismissed = new Set(state.proactive.dismissals.map((item) => item.candidateId));
    const invalidated = new Set(result.invalidatedIds);
    const unevaluated = new Set(result.unevaluatedIds);
    const retainedIds = new Set([...active, ...deferred].map((entry) => entry.candidate.id));
    const uncertain: ProactiveCandidateEntry[] = [];
    for (const old of state.proactive.candidates) {
      const id = old.candidate.id;
      if (retainedIds.has(id) || dismissed.has(id) || invalidated.has(id) || !unevaluated.has(id)) continue;
      uncertain.push({ candidate: old.candidate, presentation: 'uncertain' });
    }
    const priority = { active: 0, deferred: 1, uncertain: 2 } as const;
    const candidates = [...active, ...deferred, ...uncertain].sort((a, b) => priority[a.presentation] - priority[b.presentation] ||
      a.candidate.eligibleAt.localeCompare(b.candidate.eligibleAt) || a.candidate.id.localeCompare(b.candidate.id));
    const prunedCandidates = Math.max(0, candidates.length - 200);
    state.proactive.candidates = candidates.slice(0, 200);

    state.proactive.dismissals = state.proactive.dismissals.filter((item) => {
      const rule = byRule.get(item.ruleId);
      return Boolean(rule && item.ruleRevision >= rule.revision);
    });
    state.proactive.snoozes = state.proactive.snoozes.filter((item) => Date.parse(item.until) > nowDate.getTime() && byRule.has(item.ruleId));

    const observations = [
      ...state.mailbox.filter(validMailboxCacheRow).map((item) => ['mail', item.accountId, item.providerMessageId, item.observedAt ?? null, item.verifiedIdentityKey ?? null, item.connectionGeneration ?? null]),
      ...state.calendarEvents.filter(validCalendarCacheRow).map((item) => ['calendar', item.accountId, item.calendarId, item.providerEventId, item.observedAt ?? null, item.verifiedIdentityKey ?? null, item.connectionGeneration ?? null]),
    ].sort((a, b) => proactiveStableValue(a).localeCompare(proactiveStableValue(b)));
    const accountState = state.accounts.map((account) => ({
      id: account.id, connected: account.connected, authStatus: account.authStatus,
      identity: account.identity ? [account.identity.providerNamespace, account.identity.clientId, account.identity.subject, account.identity.resourceUserId] : null,
      capabilities: [...(account.capabilities ?? [])].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const semanticInput = proactiveStableValue({
      rules: helperRules,
      timeZone: state.settings.timezone,
      sources: sources.map((source) => [source.sourceId, source.sourceVersion, source.availability, source.freshness]),
      observations, accountState,
      dismissals: state.proactive.dismissals.map((item) => [item.candidateId, item.dismissedAt]),
      snoozes: state.proactive.snoozes.map((item) => [item.suppressionKey, item.until]),
      output: {
        active: active.map((entry) => entry.candidate.id), deferred: deferred.map((entry) => entry.candidate.id),
        invalidated: result.invalidatedIds, unevaluated: result.unevaluatedIds,
        truncation: { ...result.truncation, sources: result.truncation.sources + builtSources.omittedSourceCount, candidates: result.truncation.candidates + prunedCandidates },
      },
    });
    const inputFingerprint = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, semanticInput, { encoding: Crypto.CryptoEncoding.HEX });
    const freshnessObservedAt = sources.flatMap((source) => {
      if (source.freshness !== 'fresh' || source.namespace === 'local' || !source.accountId) return [];
      const canMatch = enabledRules.some((rule) =>
        (rule.accountIds.length === 0 || rule.accountIds.includes(source.accountId!)) &&
        ((source.kind === 'mail' && (rule.trigger.type === 'unread_from' || rule.trigger.type === 'keyword')) ||
          (source.kind === 'meeting' && rule.trigger.type === 'meeting_soon')));
      if (!canMatch) return [];
      if (source.kind === 'mail') return state.mailbox.filter((item) => item.accountId === source.accountId && item.providerMessageId === source.providerId).map((item) => item.observedAt);
      try {
        const [calendarProviderId, eventId] = JSON.parse(source.providerId) as [string, string];
        return state.calendarEvents.filter((event) => event.accountId === source.accountId && event.providerEventId === eventId &&
          state.calendars.some((calendar) => calendar.id === event.calendarId && (calendar.providerId ?? calendar.id) === calendarProviderId)).map((event) => event.observedAt);
      } catch { return []; }
    });
    const freshnessExpiresAt = freshnessObservedAt.flatMap((observedAt) => {
      const time = Date.parse(observedAt ?? '');
      const expiresAt = time + 15 * 60_000;
      return Number.isFinite(time) && expiresAt > nowDate.getTime() ? [new Date(expiresAt).toISOString()] : [];
    });
    const nextCheckAt = computeProactiveNextCheckAt({
      nowUtc, timeZone: state.settings.timezone, rules: helperRules, sources,
      snoozes: state.proactive.snoozes.map(({ suppressionKey, until, snoozedAt }) => ({ suppressionKey, until, snoozedAt })), freshnessExpiresAt,
    }) ?? undefined;
    const asOf = state.proactive.lastEvaluation?.inputFingerprint === inputFingerprint ? state.proactive.lastEvaluation.asOf : nowUtc;
    state.proactive.lastEvaluation = {
      inputFingerprint,
      truncation: { ...result.truncation, sources: result.truncation.sources + builtSources.omittedSourceCount, candidates: result.truncation.candidates + prunedCandidates },
      ...(nextCheckAt ? { nextCheckAt } : {}), asOf,
    };
    return before !== proactiveStableValue(state.proactive);
  }

  /** Serialize the complete read-modify-write operation; failed writes never mutate committed state. */
  private mutate<T>(operation: (draft: AppState) => T | Promise<T>): Promise<T> {
    const run = this.transactionQueue.then(async () => {
      if (!this.loaded) await this.load();
      if (this.loadPromise) await this.loadPromise;
      const draft = clone(this.state);
      const result = await operation(draft);
      await this.evaluateProactiveDraft(draft);
      await this.store.save(this.persistedState(draft));
      this.state = draft;
      this.snapshot = deepFreeze(this.publicState(draft));
      this.emit();
      return clone(result);
    });
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** A serialized local read/check that only commits when it actually changes state. */
  private mutateIfChanged<T>(operation: (draft: AppState) => Promise<{ changed: boolean; result: T }> | { changed: boolean; result: T }): Promise<T> {
    const run = this.transactionQueue.then(async () => {
      if (!this.loaded) await this.load();
      if (this.loadPromise) await this.loadPromise;
      const draft = clone(this.state);
      const { changed, result } = await operation(draft);
      if (changed) {
        await this.evaluateProactiveDraft(draft);
        await this.store.save(this.persistedState(draft));
        this.state = draft;
        this.snapshot = deepFreeze(this.publicState(draft));
        this.emit();
      }
      return clone(result);
    });
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async queueCredentialCleanup(tokenRef: string, reason: 'replaced' | 'disconnected' | 'orphan'): Promise<void> {
    if (!tokenRef) return;
    await this.mutate((state) => {
      if (state.accounts.some((account) => account.tokenRef === tokenRef)) return;
      if (!state.pendingCredentialCleanup.some((item) => item.tokenRef === tokenRef)) {
        state.pendingCredentialCleanup.push({ tokenRef, reason, createdAt: now() });
      }
    });
  }

  async retryCredentialCleanup(): Promise<void> {
    await this.load();
    if (this.credentialCleanupJob) return this.credentialCleanupJob;
    const job = (async () => {
      for (const queued of [...this.snapshot.pendingCredentialCleanup]) {
        if (this.installingTokenRefs.has(queued.tokenRef)) continue;
        if (this.snapshot.accounts.some((account) => account.tokenRef === queued.tokenRef)) {
          await this.mutate((state) => { state.pendingCredentialCleanup = state.pendingCredentialCleanup.filter((item) => item.tokenRef !== queued.tokenRef); });
          continue;
        }
        if (!this.integration.deleteToken) continue;
        try {
          const deleteCredential = async () => {
            if (this.installingTokenRefs.has(queued.tokenRef) || this.snapshot.accounts.some((account) => account.tokenRef === queued.tokenRef)) return false;
            await this.integration.deleteToken!(queued.tokenRef);
            return true;
          };
          const deleted = this.integration.tokenStore
            ? await withCredentialLock(this.integration.tokenStore, queued.tokenRef, deleteCredential)
            : await deleteCredential();
          if (!deleted) continue;
          await this.mutate((state) => {
            if (!state.accounts.some((account) => account.tokenRef === queued.tokenRef)) {
              state.pendingCredentialCleanup = state.pendingCredentialCleanup.filter((item) => item.tokenRef !== queued.tokenRef);
            }
          });
        } catch {
          await this.mutate((state) => {
            const item = state.pendingCredentialCleanup.find((entry) => entry.tokenRef === queued.tokenRef);
            if (item) item.lastError = 'Secure credential cleanup will be retried.';
          });
        }
      }
    })();
    this.credentialCleanupJob = job;
    try { await job; }
    finally { if (this.credentialCleanupJob === job) this.credentialCleanupJob = undefined; }
  }

  private note(state: AppState, id: string): Note {
    const value = state.notes.find((item) => item.id === id);
    if (!value) throw new Error('Note was not found.');
    return value;
  }
  private proposal(state: AppState, id: string): Proposal {
    const value = state.proposals.find((item) => item.id === id);
    if (!value) throw new Error('Proposal was not found.');
    return value;
  }
  private proposalDependencyInputs(state: AppState, proposal: Proposal): { note: Note; provenance: NoteProposalProvenance; inputs: AssistantSourceInput[]; policyInputs: AssistantSourceInput[] } {
    const provenance = proposal.provenance;
    if (!provenance || proposal.requiresRebuild) throw new Error('This saved suggestion has no verifiable source history. Run Assist again before approving it.');
    if (provenance.version !== 1) throw new Error('Mail reply provenance cannot be used as note provenance.');
    if (provenance.assistContractVersion !== ASSIST_CONTRACT_VERSION ||
        !provenance.analysisFingerprint || !provenance.capturedAt || !provenance.captureTimeZone ||
        !provenance.settingsFingerprint || !Array.isArray(provenance.sources) || !Array.isArray(provenance.policySources) ||
        !provenance.sources.some((source) => source.sourceId === 'transcript')) {
      throw new Error('This suggestion uses an older or invalid source contract. Run Assist again before approving it.');
    }
    const validSources = (items: ProposalProvenance['sources']) => {
      const ids = new Set<string>();
      return items.every((item) => {
        const parsed = /^(\d+):([a-f0-9]{64})$/i.exec(item.sourceVersion);
        if (!item.sourceId || ids.has(item.sourceId) || !Number.isSafeInteger(item.revision) || item.revision < 0 ||
            !parsed || Number(parsed[1]) !== item.revision) return false;
        ids.add(item.sourceId);
        return true;
      });
    };
    if (!validSources(provenance.sources) || !validSources(provenance.policySources)) throw new Error('This suggestion has malformed source fingerprints. Run Assist again before approving it.');
    if (!proposal.noteId) throw new Error('This suggestion has no source note.');
    const note = this.note(state, proposal.noteId);
    if (provenance.noteId !== proposal.noteId || provenance.noteRevision !== proposal.sourceRevision || note.revision !== proposal.sourceRevision) {
      throw new Error('The source transcript changed. Run Assist again before approving or continuing this action.');
    }
    if (provenance.capturedAt !== (note.capturedAt ?? note.createdAt) || provenance.captureTimeZone !== (note.captureTimeZone || state.settings.timezone)) {
      throw new Error('The recording time anchor changed. Run Assist again before approving or continuing this action.');
    }
    if (provenance.settingsFingerprint !== JSON.stringify(state.settings)) throw new Error('Assistant settings changed. Run Assist again before approving or continuing this action.');
    if (provenance.answeredAsOf && !Number.isFinite(Date.parse(provenance.answeredAsOf))) throw new Error('This suggestion has an invalid question-time anchor. Run Assist again before approving it.');
    if (provenance.expiresAt && (!Number.isFinite(Date.parse(provenance.expiresAt)) || Date.now() >= Date.parse(provenance.expiresAt))) throw new Error('This answer-based suggestion expired at the next question-time window. Run Assist again before approving or continuing it.');
    const { documents, additionalSources } = assistContext(state, note, provenance.intent, provenance.question);
    const inputs: AssistantSourceInput[] = [
      { id: 'transcript', revision: note.revision, text: note.transcript, required: true, kind: 'note', title: 'Recorded transcript' },
      ...documents.map((document) => ({ id: `doc:${document.path}`, revision: document.revision, text: document.content, required: true, kind: 'document' as const, title: document.path, updatedAt: document.updatedAt })),
      ...additionalSources,
    ];
    const byId = new Map(inputs.map((source) => [source.id, source]));
    const selected = provenance.sources.map((expected) => {
      const source = byId.get(expected.sourceId);
      if (!source) throw new Error(`The source ${expected.sourceId} is no longer available. Run Assist again before approving this action.`);
      if (source.revision !== expected.revision) throw new Error(`The source ${expected.sourceId} changed. Run Assist again before approving this action.`);
      return source;
    });
    const policyInputs = state.documents.filter((document) => /^memory\/(RULES|ROUTINES)\.md$/i.test(document.path)).map((document) => ({
      id: `doc:${document.path}`, revision: document.revision, text: document.content, required: true, kind: 'document' as const,
      title: document.path, updatedAt: document.updatedAt,
    }));
    return { note, provenance, inputs: selected, policyInputs };
  }
  private proposalDependencyProjection(state: AppState, proposal: Proposal): string | undefined {
    try {
      if (proposal.provenance?.version === 2) return this.mailReplyDependencyProjection(state, proposal, proposal.provenance);
      const { note, provenance, inputs, policyInputs } = this.proposalDependencyInputs(state, proposal);
      return JSON.stringify({
        contractVersion: ASSIST_CONTRACT_VERSION, analysisFingerprint: provenance.analysisFingerprint,
        note: { id: note.id, revision: note.revision, capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: note.captureTimeZone },
        settings: state.settings, answeredAsOf: provenance.answeredAsOf ?? null,
        sources: inputs.map((source) => ({ id: source.id, revision: source.revision, text: source.text,
          versionMaterial: source.versionMaterial ?? null, required: source.required, kind: source.kind ?? null, title: source.title ?? null, updatedAt: source.updatedAt ?? null })),
        policySources: policyInputs.map((source) => ({ id: source.id, revision: source.revision, text: source.text, updatedAt: source.updatedAt ?? null })),
      });
    } catch { return undefined; }
  }
  private async validateProposalProvenance(state: AppState, proposal: Proposal): Promise<string> {
    if (proposal.provenance?.version === 2) {
      const provenance = proposal.provenance;
      if (proposal.requiresRebuild || proposal.kind !== 'email' || !proposal.email?.reply || proposal.email.operation !== 'draft') throw new Error('This mail reply needs a fresh, explicitly reviewed source before approval.');
      const account = state.accounts.find((item) => item.id === proposal.accountId);
      const message = state.mailbox.find((item) => item.id === provenance.source.localMessageId && item.accountId === provenance.source.accountId);
      if (!account || account.id !== provenance.source.accountId || account.provider !== provenance.source.identity.providerNamespace ||
          !account.connected || account.authStatus !== 'connected' || !account.capabilities?.includes('mail.read') ||
          (account.connectionGeneration ?? 0) !== provenance.source.connectionGeneration || !sameAccountIdentity(account.identity, provenance.source.identity) ||
          !message || message.providerDeletedAt || !message.replyMetadataComplete || message.verifiedIdentityKey !== identityKey(account) ||
          message.connectionGeneration !== account.connectionGeneration) throw new Error('The source message or verified mailbox connection is no longer available. Refresh the inbox and create a new reply draft.');
      const age = Date.now() - Date.parse(provenance.source.observedAt);
      const expiry = Date.parse(provenance.expiresAt);
      if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== provenance.expiresAt ||
          expiry !== Date.parse(provenance.source.observedAt) + 15 * 60_000 || !Number.isFinite(age) || age < 0 || age >= 15 * 60_000 || Date.now() >= expiry) {
        throw new Error('This reply source is stale. Refresh the inbox and create a new reply draft.');
      }
      if (!await validateMailReplySource(provenance.source, async (canonical) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical, { encoding: Crypto.CryptoEncoding.HEX }))) {
        throw new Error('This reply has an invalid frozen source digest. Create a new reply draft.');
      }
      const current = this.mailReplySourceFromRow(message, account, provenance.source.observedAt);
      if (canonicalMailReplySource(current) !== canonicalMailReplySource(provenance.source)) throw new Error('The source message changed. Refresh it and create a new reply draft.');
      validateReplyBinding(proposal.email, provenance);
      return this.mailReplyDependencyProjection(state, proposal, provenance);
    }
    const { inputs, policyInputs, provenance } = this.proposalDependencyInputs(state, proposal);
    const catalog = await createSourceCatalog(inputs, async (bytes) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
    const current = Object.fromEntries(catalog.sources.map((source) => [source.id, source.version]));
    const expected = Object.fromEntries(provenance.sources.map((source) => [source.sourceId, source.sourceVersion]));
    if (!sameSourceVersions(expected, current)) throw new Error('The source or selected context changed. Run Assist again before approving or continuing this action.');
    const policyCatalog = await createSourceCatalog(policyInputs, async (bytes) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
    const currentPolicy = Object.fromEntries(policyCatalog.sources.map((source) => [source.id, source.version]));
    const expectedPolicy = Object.fromEntries(provenance.policySources.map((source) => [source.sourceId, source.sourceVersion]));
    if (!sameSourceVersions(expectedPolicy, currentPolicy)) throw new Error('Rules or routines changed. Run Assist again before approving or continuing this action.');
    const projection = this.proposalDependencyProjection(state, proposal);
    if (!projection) throw new Error('The source context could not be verified. Run Assist again before approving this action.');
    return projection;
  }

  private mailReplySourceFromRow(message: MailboxSnapshotMessage, account: Account, observedAt = message.observedAt ?? ''): MailReplySourceSnapshot {
    if (!account.identity || !message.idFormat || !message.internetMessageId || !message.replyMetadataComplete) throw new Error('The source message is missing complete reply metadata.');
    return {
      version: 1, accountId: account.id, accountEmail: account.email,
      ...(account.verifiedEmail ? { verifiedSelfEmail: account.verifiedEmail } : {}),
      identity: clone(account.identity), connectionGeneration: account.connectionGeneration ?? 0,
      localMessageId: message.id, providerMessageId: message.providerMessageId, idFormat: message.idFormat,
      ...(message.providerVersion ? { providerVersion: message.providerVersion } : {}),
      ...(message.threadId ? { threadId: message.threadId } : {}), internetMessageId: message.internetMessageId,
      ...(message.references !== undefined ? { references: message.references } : {}),
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}), subject: message.subject ?? '',
      ...(message.from ? { from: message.from } : {}), ...(message.senderEmail ? { senderEmail: message.senderEmail } : {}),
      ...(message.replyTo ? { replyTo: [...message.replyTo] } : {}), ...(message.to ? { to: [...message.to] } : {}),
      ...(message.cc ? { cc: [...message.cc] } : {}), ...(message.snippet !== undefined ? { snippet: message.snippet } : {}),
      replyMetadataComplete: true, observedAt, sourceDigest: '0'.repeat(64),
    };
  }

  private mailReplyDependencyProjection(state: AppState, proposal: Proposal, provenance: MailReplyProvenance): string {
    const account = state.accounts.find((item) => item.id === provenance.source.accountId);
    const message = state.mailbox.find((item) => item.id === provenance.source.localMessageId && item.accountId === provenance.source.accountId);
    if (!account || !message || !account.connected || account.authStatus !== 'connected' || !account.capabilities?.includes('mail.read') ||
        account.connectionGeneration !== provenance.source.connectionGeneration || !sameAccountIdentity(account.identity, provenance.source.identity) ||
        message.providerDeletedAt || !message.replyMetadataComplete || message.verifiedIdentityKey !== identityKey(account) ||
        message.connectionGeneration !== account.connectionGeneration) throw new Error('The source message or verified connection is no longer current.');
    const expiry = Date.parse(provenance.expiresAt);
    const sourceObserved = Date.parse(provenance.source.observedAt);
    const age = Date.now() - sourceObserved;
    if (!Number.isFinite(expiry) || !Number.isFinite(sourceObserved) || new Date(expiry).toISOString() !== provenance.expiresAt ||
        expiry !== sourceObserved + 15 * 60_000 || !Number.isFinite(age) || age < 0 || age >= 15 * 60_000 || Date.now() >= expiry) {
      throw new Error('The original message observation has expired.');
    }
    const current = this.mailReplySourceFromRow(message, account, provenance.source.observedAt);
    if (!proposal.email) throw new Error('Reply payload is missing.');
    validateReplyBinding(proposal.email, provenance);
    return stableJson({ source: canonicalMailReplySource(current), sourceDigest: provenance.sourceDigest,
      expiry: provenance.expiresAt, accountGeneration: account.connectionGeneration ?? 0,
      payload: proposal.email?.reply ?? null, recipients: { to: proposal.email?.to ?? [], cc: proposal.email?.cc ?? [] } });
  }

  private async currentMailReplySource(state: AppState, messageId: string): Promise<MailReplySourceResult> {
    const row = state.mailbox.find((item) => item.id === messageId);
    if (!row) return { status: 'missing' };
    const account = state.accounts.find((item) => item.id === row.accountId);
    if (!account || !account.connected || account.authStatus !== 'connected' || !account.capabilities?.includes('mail.read') ||
        account.provider === 'local' || !account.identity || row.providerDeletedAt || row.verifiedIdentityKey !== identityKey(account) ||
        row.connectionGeneration !== account.connectionGeneration) return { status: 'unavailable' };
    let source: MailReplySourceSnapshot;
    try {
      source = await createMailReplySource(this.mailReplySourceFromRow(row, account), async (canonical) =>
        Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical, { encoding: Crypto.CryptoEncoding.HEX }));
    } catch { return { status: 'unavailable' }; }
    const age = Date.now() - Date.parse(source.observedAt);
    if (!Number.isFinite(age) || age < 0 || age >= 15 * 60_000) return { status: 'stale', source };
    let reply = { to: [] as string[], cc: [] as string[] };
    let replyAll = { to: [] as string[], cc: [] as string[] };
    try { reply = defaultReplyRecipients(source, source.verifiedSelfEmail, 'reply'); } catch { /* The user may still choose Reply all. */ }
    try { replyAll = defaultReplyRecipients(source, source.verifiedSelfEmail, 'reply_all'); } catch { /* The user may still choose Reply. */ }
    const defaults: NonNullable<MailReplySourceResult['defaults']> = { reply, reply_all: replyAll };
    return { status: 'current', source, defaults };
  }
  private invalidate(proposal: Proposal): void {
    proposal.revision += 1;
    proposal.approvedRevision = undefined;
    proposal.approvedPayloadDigest = undefined;
    proposal.lastError = undefined;
    if (proposal.status === 'approved' || proposal.status === 'failed') proposal.status = 'draft';
  }

  async checkProposalFreshness(id: string): Promise<{ current: boolean; reason?: string }> {
    let issue: string | undefined;
    return this.mutateIfChanged<{ current: boolean; reason?: string }>(async (state) => {
      const proposal = this.proposal(state, id);
      if (['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'].includes(proposal.status)) {
        return { changed: false, result: { current: true } };
      }
      try {
        await this.validateProposalProvenance(state, proposal);
        if (proposal.requiresRebuild) {
          proposal.requiresRebuild = false;
          issue = undefined;
          return { changed: true, result: { current: true } };
        }
        return { changed: false, result: { current: true } };
      } catch (error) {
        issue = error instanceof Error ? error.message : 'The saved suggestion source could not be verified.';
        const changed = proposal.status !== 'draft' || !proposal.requiresRebuild || Boolean(proposal.approvedPayloadDigest || proposal.approvedRevision !== undefined);
        if (!changed) return { changed: false, result: { current: false, reason: issue } };
        proposal.status = 'draft';
        proposal.requiresRebuild = true;
        proposal.approvedRevision = undefined;
        proposal.approvedPayloadDigest = undefined;
        proposal.dispatchDependencyProjection = undefined;
        proposal.lastError = issue;
        return { changed: true, result: { current: false, reason: issue } };
      }
    });
  }

  private rollUsage(state: AppState): void {
    const day = localDate(state.settings.timezone);
    if (state.usage.day !== day) { state.usage.day = day; state.usage.attemptsToday = 0; }
    const month = day.slice(0, 7);
    if (state.usage.month !== month) {
      state.usage.month = month; state.usage.requests = 0; state.usage.inputTokens = 0;
      state.usage.outputTokens = 0; state.usage.transcriptionSeconds = 0;
      state.usage.estimatedCostUsd = 0; state.usage.unknownCharges = 0; state.usage.reservedUsd = 0; state.usage.priceKnown = false;
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadInternal();
    try { await this.loadPromise; }
    finally { this.loadPromise = undefined; }
    if (this.state.pendingCredentialCleanup.length) void this.retryCredentialCleanup().catch(() => undefined);
  }

  private async loadInternal(): Promise<void> {
    const loaded = await this.store.load();
    const normalized = loaded ? normalizeLoadedState(loaded) : initialState();
    this.backupImportQuarantine = clone((normalized as AppState & { backupImportQuarantine?: unknown[] }).backupImportQuarantine ?? []);
    delete (normalized as AppState & { backupImportQuarantine?: unknown[] }).backupImportQuarantine;
    this.state = normalized;
    const persisted = loaded as (AppState & { proactiveQuarantine?: unknown }) | undefined;
    const proactive = normalizeProactiveData(persisted?.proactive, persisted?.proactiveQuarantine);
    this.proactiveQuarantine = proactive.quarantine;
    this.state.proactive = uncertainOnLoad(proactive.state);
    delete (this.state as AppState & { proactiveQuarantine?: unknown }).proactiveQuarantine;
    for (const account of this.state.accounts) {
      this.state.syncStates[account.id] ??= emptySyncState(account.id);
      if (account.authStatus !== 'connected' || account.provider === 'local') continue;
      let token: StoredOAuthToken | null = null;
      try { token = account.tokenRef ? await this.integration.tokenStore?.get(account.tokenRef) ?? null : null; }
      catch { token = null; }
      if (!token || !sameAccountIdentity(token.identity, account.identity)) {
        account.authStatus = 'reauth_required';
        account.connected = false;
        account.connectionGeneration = (account.connectionGeneration ?? 0) + 1;
        account.syncStatus = 'error';
        account.capabilities = [];
        for (const calendar of this.state.calendars.filter((item) => item.accountId === account.id)) { calendar.connected = false; calendar.writable = false; }
        for (const proposal of this.state.proposals.filter((item) => item.accountId === account.id && ['draft', 'approved', 'failed'].includes(item.status))) {
          this.invalidate(proposal);
          proposal.status = 'draft';
        }
        addActivity(this.state, 'error', `${account.displayName || account.email} needs to reconnect before account actions can continue.`);
      }
    }
    for (const record of this.state.dispatchRecords) {
      if (record.outcome === 'pending') {
        try {
          const unknownAt = new Date(Math.max(Date.now(), Date.parse(record.dispatchStartedAt))).toISOString();
          const unknown = recordDispatchOutcome(record, { outcome: 'unknown', at: unknownAt });
          this.state.dispatchRecords[this.state.dispatchRecords.findIndex((item) => item.id === record.id)] = unknown;
        } catch { /* Keep malformed history read-only; never infer an accepted result. */ }
      }
    }
    for (const proposal of this.state.proposals) {
      if (proposal.dispatchRecordId) {
        const record = this.state.dispatchRecords.find((item) => item.id === proposal.dispatchRecordId);
        if (record && proposal.status === 'dispatching') {
          proposal.status = record.outcome === 'accepted' ? 'accepted' : record.outcome === 'rejected' ? 'failed' : 'unknown';
          proposal.remoteOperation = record.operation;
          proposal.remoteId = record.remoteId;
          if (record.outcome === 'accepted') proposal.remoteAcceptedAt = record.outcomeAt;
          proposal.lastError = record.outcome === 'unknown' ? 'App closed while this external action was in progress. Check the destination manually; this action will not be retried.' : undefined;
        }
      } else if (proposal.status === 'dispatching') {
        const remote = proposal.kind === 'email' || proposal.kind === 'event';
        proposal.status = remote ? 'unknown' : 'failed';
        proposal.dispatchHistoryIncomplete = remote;
        proposal.approvedPayloadDigest = undefined;
        proposal.lastError = remote
          ? 'App closed while this legacy external action was in progress. Its exact provider payload was not captured; do not retry automatically.'
          : 'App closed before this local action was confirmed. Review before trying again.';
      }
    }
    ensureMemoryDocuments(this.state);
    ensurePeriodDocuments(this.state);
    await this.evaluateProactiveDraft(this.state);
    const stateToSave = this.persistedState(this.state);
    if (!loaded || JSON.stringify(stateToSave) !== JSON.stringify(loaded)) await this.store.save(stateToSave);
    this.snapshot = deepFreeze(this.publicState(this.state));
    this.loaded = true;
    this.emit();
    for (const document of this.state.documents) this.mirrorDirty.add(document.path);
    await this.retryDocumentMirrors();
  }

  async saveNote(input: SaveNoteInput): Promise<Note> {
    const transcript = input.transcript.trim();
    if (!transcript && !input.audioUri) throw new Error('Add a transcript or an audio recording first.');
    const result = await this.mutate((state) => {
      const capturedDate = input.capturedAt ? new Date(input.capturedAt) : new Date();
      if (!Number.isFinite(capturedDate.getTime())) throw new Error('Recording start time is invalid.');
      const note: Note = {
        id: newId(), title: transcript ? transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72) : 'Audio note',
        transcript, ...(input.audioUri ? { audioUri: input.audioUri } : {}),
        durationSeconds: Math.max(0, Math.round(input.durationSeconds ?? 0)), createdAt: now(), capturedAt: capturedDate.toISOString(), captureTimeZone: validTimezone(input.captureTimeZone ?? state.settings.timezone), status: 'recorded', revision: 1,
      };
      state.notes.unshift(note);
      addActivity(state, 'note_saved', transcript ? 'Transcript saved on this device.' : 'Audio saved. No transcript has been created yet.', { noteId: note.id });
      const docs = [...ensureMemoryDocuments(state), ...recordJournal(state, `note:${note.id}:r${note.revision}`, `Saved note ${note.title} (note ID ${note.id}, transcript revision ${note.revision}).`), ...ensurePeriodDocuments(state)];
      return { note, docs };
    });
    await Promise.all(result.docs.map((document) => this.mirrorDocument(document)));
    return result.note;
  }

  async updateTranscript(id: string, text: string): Promise<Note> {
    const result = await this.mutate((state) => {
      const note = this.note(state, id);
      note.transcript = text.trim();
      note.title = note.transcript ? note.transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72) : 'Audio note';
      note.revision += 1;
      delete note.processingFingerprint;
      note.status = 'recorded';
      for (const proposal of state.proposals.filter((item) => item.noteId === id)) {
        if (['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'].includes(proposal.status)) continue;
        this.invalidate(proposal);
        proposal.status = 'draft';
        // Keep sourceRevision unchanged. This intentionally blocks approval until reprocessing.
      }
      if (note.analysis) note.analysis.stale = true;
      addActivity(state, 'note_saved', 'Transcript edited. Earlier approvals were cleared.', { noteId: id });
      return note;
    });
    return result;
  }

  async prepareRecordingAttachment(noteId: string, input: { expectedRevision: number }): Promise<RecordingAttachmentPreview | null> {
    await this.load();
    if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('Recording recovery confirmation is invalid.');
    const initial = this.snapshot;
    const note = initial.notes.find((item) => item.id === noteId);
    if (!note) throw new Error('Note was not found.');
    if (note.revision !== input.expectedRevision) throw new Error('The note changed before file selection. Review the current note and try again.');
    if (note.importOrigin?.kind !== 'backup_import' || note.importOrigin.audioMissing !== true || note.audioUri) {
      throw new Error('Only an imported note with missing audio can receive a selected replacement recording.');
    }
    const maxDurationSeconds = Math.min(MAX_DURATION_SECONDS, initial.settings.maxAudioSeconds);
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) throw new Error('The recording duration limit is invalid in Settings.');
    const service = await this.getRecordingRecoveryService();
    const beforePick = this.snapshot.notes.find((item) => item.id === noteId);
    if (beforePick?.revision !== input.expectedRevision || beforePick.importOrigin?.kind !== 'backup_import' || beforePick.importOrigin.audioMissing !== true || beforePick.audioUri ||
        this.snapshot.settings.maxAudioSeconds !== initial.settings.maxAudioSeconds) {
      throw new Error('The note or recording limit changed before file selection. Reopen recording recovery and try again.');
    }
    const staged = await service.pickAndStage({ maxDurationSeconds });
    if (!staged) return null;
    const cleanupStage = async () => { try { await service.remove(staged); } catch { /* The platform may retain an unreferenced private staging file. */ } };
    try {
      if (!staged || typeof staged.uri !== 'string' || !staged.uri || /[\u0000-\u001f\u007f]/.test(staged.uri)) throw new Error('The selected recording could not be staged safely.');
      const metadata = validateRecoveryMetadata(staged.metadata, maxDurationSeconds);
      const stagedHandle: StagedRecording = { uri: staged.uri, metadata: clone(metadata) };
      const current = this.snapshot.notes.find((item) => item.id === noteId);
      if (current?.revision !== input.expectedRevision || current.importOrigin?.kind !== 'backup_import' || current.importOrigin.audioMissing !== true || current.audioUri ||
          this.snapshot.settings.maxAudioSeconds !== initial.settings.maxAudioSeconds) {
        throw new Error('The note or recording limit changed during file selection. Reopen recording recovery and try again.');
      }
      const preparedAtMs = Date.now();
      const sessionId = newId();
      const planHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
        stableJson({ sessionId, noteId, expectedRevision: input.expectedRevision, metadata, preparedAtMs }), { encoding: Crypto.CryptoEncoding.HEX });
      const afterHash = this.snapshot.notes.find((item) => item.id === noteId);
      if (afterHash?.revision !== input.expectedRevision || afterHash.importOrigin?.kind !== 'backup_import' || afterHash.importOrigin.audioMissing !== true || afterHash.audioUri ||
          this.snapshot.settings.maxAudioSeconds !== initial.settings.maxAudioSeconds) {
        throw new Error('The note or recording limit changed while the attachment preview was being prepared.');
      }
      for (const [id, session] of this.recordingAttachmentSessions) {
        if (session.status === 'ready' && (preparedAtMs < session.preparedAtMs || preparedAtMs - session.preparedAtMs >= 15 * 60_000)) {
          this.recordingAttachmentSessions.delete(id);
          void service.remove(session.staged).catch(() => undefined);
        }
      }
      while ([...this.recordingAttachmentSessions.values()].filter((session) => session.status === 'ready').length >= 2) {
        const oldest = [...this.recordingAttachmentSessions.entries()].find(([, session]) => session.status === 'ready');
        if (!oldest) break;
        this.recordingAttachmentSessions.delete(oldest[0]);
        void service.remove(oldest[1].staged).catch(() => undefined);
      }
      const preview: RecordingAttachmentPreview = { ...metadata, sessionId, planHash, noteId, expectedRevision: input.expectedRevision };
      this.recordingAttachmentSessions.set(sessionId, { preview, staged: stagedHandle, preparedAtMs, status: 'ready' });
      return clone(preview);
    } catch (error) {
      await cleanupStage();
      throw error;
    }
  }

  async attachRecording(input: { sessionId: string; planHash: string }): Promise<Note> {
    if (!input || typeof input.sessionId !== 'string' || !/^[a-f\d]{64}$/i.test(input.planHash)) throw new Error('Recording attachment confirmation is invalid.');
    const session = this.recordingAttachmentSessions.get(input.sessionId);
    if (!session) {
      const receipt = this.recordingAttachmentReceipts.get(input.sessionId);
      if (receipt && receipt.planHash === input.planHash) {
        const current = this.snapshot.notes.find((item) => item.id === receipt.noteId);
        if (current?.audioUri === receipt.uri && current.audioAttachment?.sha256 === receipt.sha256) return clone(current);
        throw new Error('The recording attachment is no longer present on this note. Prepare a new selection.');
      }
      throw new Error('Recording preview is missing or no longer matches. Select the file again.');
    }
    if (session.preview.planHash !== input.planHash) throw new Error('Recording preview is missing or no longer matches. Select the file again.');
    const existingJob = this.recordingAttachmentJobs.get(input.sessionId);
    if (existingJob) return existingJob;
    if (session.status !== 'ready') throw new Error('Recording attachment is already being saved or canceled.');
    // Claim synchronously, before the async worker awaits load or storage. A concurrent
    // prepare can then only evict ready previews, never the stage this request owns.
    session.status = 'applying';
    const job = this.attachRecordingInternal(input);
    this.recordingAttachmentJobs.set(input.sessionId, job);
    void job.then(() => this.recordingAttachmentJobs.delete(input.sessionId), () => this.recordingAttachmentJobs.delete(input.sessionId));
    return job;
  }

  private async attachRecordingInternal(input: { sessionId: string; planHash: string }): Promise<Note> {
    await this.load();
    const session = this.recordingAttachmentSessions.get(input.sessionId);
    if (!session || session.status !== 'applying' || session.preview.planHash !== input.planHash) throw new Error('Recording preview is missing or no longer matches. Select the file again.');
    const atStart = Date.now();
    if (atStart < session.preparedAtMs || atStart - session.preparedAtMs >= 15 * 60_000) {
      this.recordingAttachmentSessions.delete(input.sessionId);
      await (await this.getRecordingRecoveryService()).remove(session.staged).catch(() => undefined);
      throw new Error('Recording preview expired. Select the file again.');
    }
    let committed = false;
    try {
      const service = await this.getRecordingRecoveryService();
      const maxDurationSeconds = Math.min(MAX_DURATION_SECONDS, this.snapshot.settings.maxAudioSeconds);
      const beforeInspect = this.snapshot.notes.find((item) => item.id === session.preview.noteId);
      if (beforeInspect?.revision !== session.preview.expectedRevision || beforeInspect.importOrigin?.kind !== 'backup_import' || beforeInspect.importOrigin.audioMissing !== true || beforeInspect.audioUri) {
        throw new Error('The note changed before the staged recording could be verified. Select the file again.');
      }
      const inspected = validateRecoveryMetadata(await service.inspect(session.staged, { maxDurationSeconds }), maxDurationSeconds);
      const { sessionId: _sessionId, planHash: _planHash, noteId: _noteId, expectedRevision: _revision, ...previewMetadata } = session.preview;
      if (stableJson(inspected) !== stableJson(previewMetadata)) throw new Error('The staged recording changed after preview. Select it again.');
      if (session.status !== 'applying') throw new Error('Recording attachment was canceled before it could be saved.');
      const saved = await this.mutate((state) => {
        const attachTime = Date.now();
        if (attachTime < session.preparedAtMs || attachTime - session.preparedAtMs >= 15 * 60_000) throw new Error('Recording preview expired. Select the file again.');
        if (Math.min(MAX_DURATION_SECONDS, state.settings.maxAudioSeconds) !== maxDurationSeconds) throw new Error('The recording duration limit changed. Select the file again.');
        const note = state.notes.find((item) => item.id === session.preview.noteId);
        if (!note || note.revision !== session.preview.expectedRevision || note.importOrigin?.kind !== 'backup_import' || note.importOrigin.audioMissing !== true || note.audioUri) {
          throw new Error('The note changed before the recording was attached. Review it and select the file again.');
        }
        note.audioUri = session.staged.uri;
        note.audioAttachment = { kind: 'user_selected_replacement', originalMatch: 'unverified', ...inspected, attachedAt: now() };
        note.durationSeconds = inspected.durationStatus === 'known' ? inspected.durationSeconds! : 0;
        note.importOrigin = { ...note.importOrigin, audioMissing: false };
        note.revision += 1;
        delete note.processingFingerprint;
        if (note.analysis) note.analysis.stale = true;
        for (const proposal of state.proposals.filter((item) => item.noteId === note.id && ['draft', 'approved', 'failed'].includes(item.status))) {
          this.invalidate(proposal);
          proposal.status = 'draft';
        }
        addActivity(state, 'local_action', `A user-selected recording was attached to imported note “${note.title}”. It is not verified as the original file.`, { noteId: note.id });
        return note;
      });
      committed = true;
      this.recordingAttachmentReceipts.set(input.sessionId, { planHash: input.planHash, noteId: saved.id, uri: session.staged.uri, sha256: inspected.sha256 });
      while (this.recordingAttachmentReceipts.size > 2) {
        const oldest = this.recordingAttachmentReceipts.keys().next().value as string | undefined;
        if (!oldest) break;
        this.recordingAttachmentReceipts.delete(oldest);
      }
      this.recordingAttachmentSessions.delete(input.sessionId);
      return saved;
    } catch (error) {
      if (!committed) {
        this.recordingAttachmentSessions.delete(input.sessionId);
        await (await this.getRecordingRecoveryService()).remove(session.staged).catch(() => undefined);
      }
      throw error;
    }
  }

  async cancelRecordingAttachment(sessionId: string): Promise<void> {
    const session = this.recordingAttachmentSessions.get(sessionId);
    if (!session || this.recordingAttachmentReceipts.has(sessionId)) return;
    if (session.status !== 'ready' || this.recordingAttachmentJobs.has(sessionId)) throw new Error('Recording attachment is already being saved and cannot be canceled.');
    session.status = 'canceling';
    this.recordingAttachmentSessions.delete(sessionId);
    await (await this.getRecordingRecoveryService()).remove(session.staged);
  }

  async confirmImportedNoteTimeZone(noteId: string, input: { timeZone: string; expectedRevision: number }): Promise<Note> {
    await this.load();
    if (!input || typeof input.timeZone !== 'string' || input.timeZone.length > 128 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error('Time zone confirmation is invalid. Choose a valid IANA time zone and the current note revision.');
    }
    const timeZone = input.timeZone.trim();
    if (!timeZone || timeZone !== input.timeZone) throw new Error('Enter a canonical IANA time zone name.');
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0)); }
    catch { throw new Error('Enter a valid IANA time zone, such as Asia/Singapore or America/Los_Angeles.'); }
    return this.mutate((state) => {
      const note = state.notes.find((item) => item.id === noteId);
      if (!note) throw new Error('Note was not found.');
      if (note.revision !== input.expectedRevision) throw new Error('The note changed before time zone confirmation. Review its current revision and try again.');
      if (note.importOrigin?.kind !== 'backup_import' || note.importOrigin.originalTimeZoneUnknown !== true) {
        throw new Error('This note does not need an original time zone confirmation.');
      }
      note.captureTimeZone = timeZone;
      note.revision += 1;
      note.processingFingerprint = undefined;
      const { originalTimeZoneUnknown: _unknownZone, ...confirmedOrigin } = note.importOrigin;
      note.importOrigin = { ...confirmedOrigin, timeZoneConfirmedAt: now() };
      if (note.analysis) note.analysis.stale = true;
      for (const proposal of state.proposals.filter((item) => item.noteId === note.id && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      addActivity(state, 'local_action', `Confirmed the capture time zone for imported note “${note.title}”.`, { noteId: note.id });
      return note;
    });
  }

  async processNote(id: string): Promise<Proposal[]> {
    await this.load();
    const note = this.snapshot.notes.find((item) => item.id === id);
    if (!note) throw new Error('Note was not found.');
    this.requireConfirmedCaptureTimeZone(note);
    const existing = this.processJobs.get(id);
    if (existing) return existing;
    const job = this.assistNote(id, { intent: 'assist' }).then((analysis) => {
      const state = this.snapshot;
      const known = new Set(analysis.proposalIds);
      return state.proposals.filter((proposal) => known.has(proposal.id) && proposal.status === 'draft');
    }).finally(() => this.processJobs.delete(id));
    this.processJobs.set(id, job);
    return job;
  }

  async refreshAnalysisStatus(noteId: string): Promise<NoteAssistResult | undefined> {
    await this.load();
    return this.mutateIfChanged(async (state) => {
      const note = state.notes.find((item) => item.id === noteId);
      if (!note?.analysis) return { changed: false, result: undefined };
      const analysis = note.analysis;
      const boundFingerprint = analysis.fingerprint;
      const boundSourceRevision = analysis.sourceRevision;
      const { documents, additionalSources, omittedSourceCount, omittedSourceIds } = assistContext(state, note, analysis.intent, analysis.question);
      const request = {
        intent: analysis.intent, question: analysis.question,
        ...(analysis.answeredAsOf ? { queryTimeAnchor: analysis.answeredAsOf, queryTimeZone: analysis.answerTimeZone ?? state.settings.timezone } : {}),
        additionalSources, preselection: { omittedSourceCount, omittedSourceIds },
      };
      let currentVersions: Record<string, string>;
      if (state.settings.mode === 'provider' && analysis.source === 'provider') {
        currentVersions = (await this.openAiClient.prepare(note, documents, state.settings, request)).sourceVersions;
      } else {
        const calendarAvailable = state.calendars.some((calendar) => {
          const account = state.accounts.find((item) => item.id === calendar.accountId);
          const sync = state.syncStates[calendar.accountId];
          return Boolean(account?.connected && account.authStatus === 'connected' && calendar.connected && sync?.calendarsCompletedAt && sync.eventsCompletedAt[calendar.id]);
        });
        const offlineInputs = offlineAssistInputs(note, analysis.intent, analysis.question, additionalSources, calendarAvailable);
        const catalog = await createSourceCatalog(
          offlineInputs,
          async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)),
        );
        currentVersions = Object.fromEntries(catalog.sources.map((source) => [source.id, source.version]));
      }
      // The serialized transaction binds this result to the exact analysis whose sources were hashed.
      if (note.analysis?.fingerprint !== boundFingerprint || note.analysis?.sourceRevision !== boundSourceRevision) {
        return { changed: false, result: note.analysis };
      }
      let priorFingerprint: { settings?: AppSettings; contractVersion?: string } | undefined;
      try { priorFingerprint = JSON.parse(analysis.fingerprint) as { settings?: AppSettings; contractVersion?: string }; } catch { priorFingerprint = undefined; }
      const settingsChanged = !priorFingerprint?.settings || JSON.stringify(priorFingerprint.settings) !== JSON.stringify(state.settings) ||
        priorFingerprint.contractVersion !== ASSIST_CONTRACT_VERSION ||
        (analysis.source === 'provider') !== (state.settings.mode === 'provider');
      const answerWindowExpired = Boolean(analysis.answeredAsOf &&
        Math.floor(Date.now() / 900_000) !== Math.floor(Date.parse(analysis.answeredAsOf) / 900_000));
      const stale = analysis.sourceRevision !== note.revision || settingsChanged || answerWindowExpired || !sameSourceVersions(analysis.sourceVersions, currentVersions);
      if (Boolean(analysis.stale) === stale) return { changed: false, result: analysis };
      analysis.stale = stale;
      return { changed: true, result: analysis };
    });
  }

  async assistNote(id: string, options: { intent?: AssistIntent; question?: string; forceRefresh?: boolean } = {}): Promise<NoteAssistResult> {
    const intent = options.intent ?? 'assist';
    const question = options.question?.trim() || undefined;
    const requestedAt = new Date();
    const queryBucket = intent === 'answer' && question ? Math.floor(requestedAt.getTime() / 900_000) : '';
    const key = JSON.stringify([id, intent, question, queryBucket, Boolean(options.forceRefresh)]);
    const existing = this.assistJobs.get(key);
    if (existing) return existing;
    const job = this.runAssistNote(id, { ...options, intent, question }, requestedAt).finally(() => this.assistJobs.delete(key));
    this.assistJobs.set(key, job);
    return job;
  }

  private async runAssistNote(id: string, options: { intent?: AssistIntent; question?: string; forceRefresh?: boolean } = {}, requestedAt = new Date()): Promise<NoteAssistResult> {
    const intent = options.intent ?? 'assist';
    const question = options.question?.trim() || undefined;
    if (!['assist', 'summarize', 'answer', 'extract'].includes(intent)) throw new Error('Choose a supported assist action.');
    if (intent === 'answer' && !question) throw new Error('Add a question before asking about this note.');
    const state = this.snapshot;
    const note = state.notes.find((item) => item.id === id);
    if (!note) throw new Error('Note was not found.');
    this.requireConfirmedCaptureTimeZone(note);
    if (!note.transcript.trim()) throw new Error('This audio note has no transcript. Enter text or connect the speech provider before processing.');
    const sourceRevision = note.revision;
    const { documents: contextDocs, additionalSources: localSources, omittedSourceCount, omittedSourceIds } = assistContext(state, note, intent, question);
    const capturedAt = note.capturedAt ?? note.createdAt;
    const answeredAsOf = intent === 'answer' && question ? requestedAt.toISOString() : undefined;
    const queryBucket = answeredAsOf ? Math.floor(requestedAt.getTime() / 900_000) : undefined;
    const request = { intent, question, ...(answeredAsOf ? { queryTimeAnchor: answeredAsOf, queryTimeZone: state.settings.timezone } : {}), additionalSources: localSources, preselection: { omittedSourceCount, omittedSourceIds } };
    const prepared = state.settings.mode === 'provider' ? await this.openAiClient.prepare(note, contextDocs, state.settings, request) : undefined;
    const transcriptVersion = `${note.revision}:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, note.transcript.replace(/\r\n?/g, '\n').normalize('NFC'))}`;
    const hasCompleteCalendar = state.calendars.some((calendar) => {
      const account = state.accounts.find((item) => item.id === calendar.accountId);
      const sync = state.syncStates[calendar.accountId];
      return Boolean(account?.connected && account.authStatus === 'connected' && calendar.connected && sync?.calendarsCompletedAt && sync.eventsCompletedAt[calendar.id]);
    });
    const verifiedEvents = state.calendarEvents.filter((event) => {
      const calendar = state.calendars.find((item) => item.id === event.calendarId);
      const account = state.accounts.find((item) => item.id === event.accountId);
      return Boolean(calendar?.connected && account?.connected && account.authStatus === 'connected' && identityKey(account));
    });
    const offlineInputs = offlineAssistInputs(note, intent, question, localSources, hasCompleteCalendar);
    const offlineCatalog = state.settings.mode === 'preview' ? await createSourceCatalog(offlineInputs,
      async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes))) : undefined;
    const sourceVersions = prepared?.sourceVersions ?? Object.fromEntries(offlineCatalog?.sources.map((source) => [source.id, source.version]) ?? [['transcript', transcriptVersion]]);
    const processingFingerprint = JSON.stringify({ contractVersion: ASSIST_CONTRACT_VERSION, transcript: note.transcript, sourceRevision, sources: sourceVersions, settings: state.settings, intent, question,
      capturedAt, captureTimeZone: note.captureTimeZone || state.settings.timezone,
      ...(answeredAsOf ? { queryBucket, queryTimeZone: state.settings.timezone } : {}),
    });
    if (!options.forceRefresh && note.analysis?.fingerprint === processingFingerprint) return clone(note.analysis);
    let generated: DraftAnalysis;
    if (state.settings.mode === 'provider') {
      generated = (options.forceRefresh ? undefined : this.analysisCache.get(processingFingerprint)) ?? await this.openAiClient.analyze(note, contextDocs, state.settings, undefined, async () => { await this.recordProviderAttempt('model', state.settings); }, request, prepared);
      if (options.forceRefresh || !this.analysisCache.has(processingFingerprint)) {
        await this.settleModelUsage(generated, state.settings);
        this.analysisCache.set(processingFingerprint, generated);
      }
      if (this.snapshot.notes.find((item) => item.id === id)?.revision !== sourceRevision) throw new Error('The transcript changed during processing. The provider result was discarded.');
    } else {
      const proposals = extractPreviewProposals(note);
      const preview = buildOfflinePreview({ intent, transcript: note.transcript, question, timeZone: answeredAsOf ? state.settings.timezone : note.captureTimeZone || state.settings.timezone, now: answeredAsOf ?? capturedAt, transcriptRevision: note.revision, transcriptSourceVersion: transcriptVersion,
        ...(intent === 'answer' ? { tasks: state.tasks.map(({ title, status, dueAt }) => ({ title, status, dueAt })), calendarEvents: verifiedEvents.map(({ subject, start, timeZone }) => ({ subject, start, timeZone })), calendarSnapshotAvailable: hasCompleteCalendar } : {}),
      });
      const offlineIncludedIds = offlineInputs.map((source) => source.id);
      generated = {
        summary: preview.summary, answer: preview.answer, decisions: preview.decisions, citations: preview.citations,
        clarifications: preview.clarifications, proposals: proposals.map(({ kind, title, body, recipients, dueAt, evidence }) => ({ kind, title, body, recipients, dueAt, evidence })),
        includedSourceIds: offlineIncludedIds,
        includedSources: offlineIncludedIds.map((sourceId) => {
          const input = sourceId === 'transcript' ? { title: 'Recorded transcript', text: note.transcript } : localSources.find((source) => source.id === sourceId)!;
          return { id: sourceId, title: input.title ?? sourceId, excerpt: input.text };
        }),
        omittedSourceIds: [], omittedSourceCount: 0, sourceVersions, inputTokens: 0, outputTokens: 0, attempts: 0, usageEstimated: true,
      };
    }
    const policyInputs = state.documents.filter((document) => /^memory\/(RULES|ROUTINES)\.md$/i.test(document.path)).map((document) => ({
      id: `doc:${document.path}`, revision: document.revision, text: document.content, required: true, kind: 'document' as const,
      title: document.path, updatedAt: document.updatedAt,
    }));
    const policyCatalog = await createSourceCatalog(policyInputs, async (bytes) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
    const policySources = policyCatalog.sources.map((source) => ({ sourceId: source.id, revision: source.revision, sourceVersion: source.version }));
    const created: Proposal[] = generated.proposals.map((draft) => ({
      id: newId(), noteId: note.id, ...draft, status: 'draft', revision: 1,
      recipients: [...draft.recipients], sourceRevision: note.revision, evidence: draft.evidence.map((item) => ({ ...item })),
      sourceActionKey: sourceActionKey(note, draft.kind, draft.evidence),
      provenance: createProposalProvenance({ analysisFingerprint: processingFingerprint, note, intent, question, sourceVersions: generated.sourceVersions, policySources, settings: state.settings, answeredAsOf }),
      requiresRebuild: false,
    }));

    const result = await this.mutate(async (draft) => {
      const current = this.note(draft, id);
      if (current.revision !== sourceRevision) throw new Error('The transcript changed during processing. Process the updated note again.');
      let stale = JSON.stringify(draft.settings) !== JSON.stringify(state.settings);
      try {
        const currentContext = assistContext(draft, current, intent, question);
        let currentVersions: Record<string, string>;
        if (draft.settings.mode === 'provider') {
          const currentRequest = { intent, question, ...(answeredAsOf ? { queryTimeAnchor: answeredAsOf, queryTimeZone: state.settings.timezone } : {}), additionalSources: currentContext.additionalSources, preselection: { omittedSourceCount: currentContext.omittedSourceCount, omittedSourceIds: currentContext.omittedSourceIds } };
          currentVersions = (await this.openAiClient.prepare(current, currentContext.documents, draft.settings, currentRequest)).sourceVersions;
        } else {
          const calendarAvailable = draft.calendars.some((calendar) => {
            const account = draft.accounts.find((item) => item.id === calendar.accountId);
            const sync = draft.syncStates[calendar.accountId];
            return Boolean(account?.connected && account.authStatus === 'connected' && calendar.connected && sync?.calendarsCompletedAt && sync.eventsCompletedAt[calendar.id]);
          });
          const localInputs = offlineAssistInputs(current, intent, question, currentContext.additionalSources, calendarAvailable);
          const catalog = await createSourceCatalog(localInputs, async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
          currentVersions = Object.fromEntries(catalog.sources.map((source) => [source.id, source.version]));
        }
        stale ||= !sameSourceVersions(generated.sourceVersions, currentVersions);
      } catch {
        stale = true;
      }
      if (stale) {
        const analysis: NoteAssistResult = {
          noteId: id, sourceRevision, intent, ...(question ? { question } : {}), fingerprint: processingFingerprint,
          analyzedAt: now(), capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: note.captureTimeZone || state.settings.timezone,
          ...(answeredAsOf ? { answeredAsOf, answerTimeZone: state.settings.timezone } : {}),
          summary: generated.summary, answer: generated.answer, decisions: generated.decisions, citations: generated.citations,
          clarifications: [...generated.clarifications, 'Local context changed while this response was being prepared. Refresh the analysis to use the current sources.'],
          proposalIds: [], source: state.settings.mode === 'provider' ? 'provider' : 'offline_preview',
          includedSourceIds: generated.includedSourceIds, includedSources: generated.includedSources, omittedSourceIds: generated.omittedSourceIds, omittedSourceCount: generated.omittedSourceCount,
          sourceVersions: generated.sourceVersions, stale: true,
        };
        current.status = 'processed'; current.processingFingerprint = processingFingerprint; current.analysis = analysis;
        addActivity(draft, 'error', 'Assist response retained as stale because local context changed during processing. No proposals were created.', { noteId: id });
        return { proposals: [] as Proposal[], analysis, docs: [] as ContextDocument[] };
      }
      const existingByAction = new Map(draft.proposals.filter((proposal) => proposal.noteId === id && proposal.sourceActionKey)
        .map((proposal) => [proposal.sourceActionKey!, proposal]));
      const selected: Proposal[] = [];
      const terminalStatuses = ['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'];
      for (const proposal of created) {
        const existing = existingByAction.get(proposal.sourceActionKey!);
        if (!existing || terminalStatuses.includes(existing.status)) {
          selected.push(existing ?? proposal);
        } else if (!existing.requiresRebuild && existing.provenance?.version === 1 && existing.provenance.analysisFingerprint === processingFingerprint) {
          selected.push(existing);
        } else {
          selected.push({ ...proposal, id: existing.id, revision: existing.revision + 1,
            approvedRevision: undefined, approvedPayloadDigest: undefined, lastError: undefined });
        }
      }
      const selectedIds = new Set(selected.map((proposal) => proposal.id));
      draft.proposals = [
        ...selected,
        ...draft.proposals.filter((proposal) => proposal.noteId !== id || (!selectedIds.has(proposal.id) && proposal.status !== 'draft')),
      ];
      current.status = 'processed';
      current.processingFingerprint = processingFingerprint;
      const analysis: NoteAssistResult = {
        noteId: id, sourceRevision, intent, ...(question ? { question } : {}), fingerprint: processingFingerprint,
        analyzedAt: now(), capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: note.captureTimeZone || state.settings.timezone, ...(answeredAsOf ? { answeredAsOf, answerTimeZone: state.settings.timezone } : {}),
        summary: generated.summary, answer: generated.answer, decisions: generated.decisions, citations: generated.citations,
        clarifications: generated.clarifications, proposalIds: selected.map((proposal) => proposal.id),
        source: state.settings.mode === 'provider' ? 'provider' : 'offline_preview',
        includedSourceIds: generated.includedSourceIds, includedSources: generated.includedSources, omittedSourceIds: generated.omittedSourceIds, omittedSourceCount: generated.omittedSourceCount, sourceVersions: generated.sourceVersions,
      };
      current.analysis = analysis;
      const docs = [
        ...recordJournal(draft, `processed:${id}:r${sourceRevision}`, `Processed note ${current.title}; ${created.length} review suggestion(s) created.`),
        ...created.filter((proposal) => !existingByAction.has(proposal.sourceActionKey!)).map((proposal) => appendInference(draft, proposal, state.settings.mode)),
      ];
      addActivity(draft, 'proposal_created', state.settings.mode === 'provider'
        ? `Azure OpenAI assisted with this recorded note and drafted ${created.length} review suggestion${created.length === 1 ? '' : 's'}.`
        : `Preview mode extracted ${created.length} suggestion${created.length === 1 ? '' : 's'} from your transcript. No provider was contacted.`, { noteId: id });
      return { proposals: selected, analysis, docs };
    });
    await Promise.all(result.docs.map((document) => this.mirrorDocument(document)));
    return result.analysis;
  }

  private providerReserve(settings: AppSettings, kind: 'model' | 'speech'): number {
    if (kind === 'model') {
      if (settings.inputUsdPerMillionTokens === undefined || settings.outputUsdPerMillionTokens === undefined) return 0;
      return (settings.maxRequestBytes + 256) * settings.inputUsdPerMillionTokens / 1_000_000 + settings.maxOutputTokens * settings.outputUsdPerMillionTokens / 1_000_000;
    }
    if (settings.speechUsdPerMinute === undefined) return 0;
    return settings.maxAudioSeconds / 60 * settings.speechUsdPerMinute;
  }

  private async recordProviderAttempt(kind: 'model' | 'speech', requestSettings: AppSettings, guard?: (state: AppState) => void): Promise<{ month: string; day: string; reserve: number }> {
    return this.mutate((state) => {
      this.rollUsage(state);
      guard?.(state);
      if (state.usage.attemptsToday >= state.settings.maxCallsPerDay) throw new Error('Daily provider call limit reached. Try again tomorrow or adjust the limit in Settings.');
      const reserve = this.providerReserve(requestSettings, kind);
      const knownRates = kind === 'model'
        ? requestSettings.inputUsdPerMillionTokens !== undefined && requestSettings.outputUsdPerMillionTokens !== undefined
        : requestSettings.speechUsdPerMinute !== undefined;
      if (knownRates && (state.settings.monthlyBudgetUsd === 0 || state.usage.estimatedCostUsd + state.usage.reservedUsd + reserve > state.settings.monthlyBudgetUsd)) throw new Error('The configured monthly estimate limit does not have room for this bounded provider request.');
      state.usage.reservedUsd += reserve;
      state.usage.attemptsToday += 1;
      state.usage.attempts += 1;
      state.usage.unknownCharges += 1;
      state.usage.lastRequestAt = now();
      return { month: state.usage.month, day: state.usage.day, reserve };
    });
  }

  private async rollbackUnsentProviderAttempt(reservation: { month: string; day: string; reserve: number }): Promise<void> {
    await this.mutate((state) => {
      if (state.usage.month === reservation.month) {
        state.usage.unknownCharges = Math.max(0, state.usage.unknownCharges - 1);
        state.usage.reservedUsd = Math.max(0, state.usage.reservedUsd - reservation.reserve);
      }
      if (state.usage.day === reservation.day) state.usage.attemptsToday = Math.max(0, state.usage.attemptsToday - 1);
      state.usage.attempts = Math.max(0, state.usage.attempts - 1);
      state.usage.priceKnown = state.usage.unknownCharges === 0 && state.settings.inputUsdPerMillionTokens !== undefined && state.settings.outputUsdPerMillionTokens !== undefined;
    });
  }

  private async settleModelUsage(usage: Pick<ReplyGenerationUsage, 'inputTokens' | 'outputTokens' | 'usageEstimated'>, requestSettings: AppSettings): Promise<void> {
    await this.mutate((state) => {
      this.rollUsage(state);
      state.usage.requests += 1;
      state.usage.inputTokens += usage.inputTokens;
      state.usage.outputTokens += usage.outputTokens;
      state.usage.lastRequestAt = now();
      const ratesKnown = !usage.usageEstimated && requestSettings.inputUsdPerMillionTokens !== undefined && requestSettings.outputUsdPerMillionTokens !== undefined;
      if (ratesKnown) {
        state.usage.reservedUsd = Math.max(0, state.usage.reservedUsd - this.providerReserve(requestSettings, 'model'));
        state.usage.estimatedCostUsd += usage.inputTokens * requestSettings.inputUsdPerMillionTokens! / 1_000_000 + usage.outputTokens * requestSettings.outputUsdPerMillionTokens! / 1_000_000;
        // Settle only the final successful attempt; earlier retry attempts remain unknown charges.
        state.usage.unknownCharges = Math.max(0, state.usage.unknownCharges - 1);
      }
      state.usage.priceKnown = state.usage.unknownCharges === 0 && ratesKnown;
    });
  }

  private async settleSpeechUsage(seconds: number, requestSettings: AppSettings): Promise<void> {
    await this.mutate((state) => {
      this.rollUsage(state);
      state.usage.requests += 1;
      state.usage.transcriptionSeconds += seconds;
      state.usage.lastRequestAt = now();
      const rate = requestSettings.speechUsdPerMinute;
      if (rate !== undefined) {
        state.usage.reservedUsd = Math.max(0, state.usage.reservedUsd - this.providerReserve(requestSettings, 'speech'));
        state.usage.estimatedCostUsd += seconds / 60 * rate;
        state.usage.unknownCharges = Math.max(0, state.usage.unknownCharges - 1);
      }
      state.usage.priceKnown = state.usage.unknownCharges === 0 && rate !== undefined;
    });
  }

  async transcribeNote(id: string): Promise<Note> {
    const state = this.snapshot;
    const note = state.notes.find((item) => item.id === id);
    if (!note) throw new Error('Note was not found.');
    if (note.audioAttachment?.durationStatus === 'unknown') throw new Error('This replacement recording has no verified duration. It cannot be sent for transcription.');
    const sourceRevision = note.revision;
    if (state.settings.mode !== 'provider') throw new Error('Select Provider mode and configure Azure Speech before transcribing.');
    if (state.usage.priceKnown && state.usage.estimatedCostUsd >= state.settings.monthlyBudgetUsd) throw new Error('The configured monthly estimate limit has been reached.');
    const result = await this.speechClient.transcribe(note, state.settings, undefined, async () => { await this.recordProviderAttempt('speech', state.settings); });
    await this.settleSpeechUsage(result.durationSeconds, state.settings);
    const updated = await this.mutate(async (draft) => {
      const current = this.note(draft, id);
      if (current.revision !== sourceRevision) throw new Error('The transcript changed during transcription. The provider result was discarded.');
      current.transcript = result.transcript;
      current.title = result.transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72);
      current.revision += 1;
      current.durationSeconds = result.durationSeconds;
      current.status = 'recorded';
      for (const proposal of draft.proposals.filter((item) => item.noteId === id)) {
        if (['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'].includes(proposal.status)) continue;
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      addActivity(draft, 'local_action', 'Audio transcribed by Azure Speech and saved to the note.', { noteId: id });
      return current;
    });
    if (state.settings.audioRetention === 'delete_after_transcription' && note.audioUri) {
      try {
        const retentionUri = note.audioUri;
        const detach = await this.mutate((draft) => {
          const current = this.note(draft, id);
          if (current.revision !== updated.revision || current.audioUri !== retentionUri) return { note: current, detached: false };
          delete current.audioUri;
          delete current.audioAttachment;
          if (current.importOrigin?.kind === 'backup_import') current.importOrigin = { ...current.importOrigin, audioMissing: true };
          current.revision += 1;
          delete current.processingFingerprint;
          if (current.analysis) current.analysis.stale = true;
          for (const proposal of draft.proposals.filter((item) => item.noteId === id && ['draft', 'approved', 'failed'].includes(item.status))) {
            this.invalidate(proposal);
            proposal.status = 'draft';
          }
          addActivity(draft, 'local_action', 'Original recording detached after transcription, as configured.', { noteId: id });
          return { note: current, detached: true };
        });
        if (detach.detached) {
          try { await removeAudio(retentionUri); } catch { /* The canonical note no longer references this private clip. */ }
        }
        return detach.note;
      } catch {
        return updated;
      }
    }
    return updated;
  }

  async editProposal(id: string, patch: ProposalPatch): Promise<Proposal> {
    const priorReminder = this.snapshot.proposals.find((item) => item.id === id);
    const result = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (['executed', 'accepted', 'simulated', 'dispatching', 'unknown', 'dismissed'].includes(proposal.status)) throw new Error('This proposal can no longer be edited.');
      if (proposal.provenance?.version === 2) {
        const locked = proposal.email?.reply;
        if (!locked || proposal.email?.operation !== 'draft' || (patch.accountId !== undefined && patch.accountId !== proposal.accountId) ||
            (patch.email && ((patch.email.operation !== undefined && patch.email.operation !== 'draft') || patch.email.subject !== proposal.provenance.source.subject ||
              patch.email.bcc.length > 0 || patch.email.attachments.length > 0 || (patch.email.reply && stableJson(patch.email.reply) !== stableJson(locked))))) {
          throw new Error('Reply source, subject, account, draft operation, Bcc, and attachments are locked. Only reply text and recipients can be edited.');
        }
        const updatedEmail = patch.email ? { ...patch.email, operation: 'draft' as const, reply: clone(locked), subject: proposal.provenance.source.subject } : undefined;
        Object.assign(proposal, patch);
        if (updatedEmail) proposal.email = updatedEmail;
        else if (proposal.email) proposal.email.reply = clone(locked);
        await this.validateProposalProvenance(state, proposal);
      } else Object.assign(proposal, patch);
      proposal.recipients = [...new Set((proposal.recipients ?? []).map((recipient) => recipient.trim()).filter(Boolean))];
      this.invalidate(proposal);
      proposal.status = 'draft';
      addActivity(state, 'proposal_created', 'Suggestion edited. Review and approve the updated details.', { proposalId: id, noteId: proposal.noteId });
      return proposal;
    });
    if (priorReminder?.kind === 'reminder') {
      await cancelReminderNotification({ id, revision: priorReminder.notificationRevision ?? priorReminder.revision });
    }
    return result;
  }

  async approveProposal(id: string): Promise<Proposal> {
    const result = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (proposal.status !== 'draft' && proposal.status !== 'failed') throw new Error('Only a draft or safely failed proposal can be approved.');
      if (proposal.provenance?.version === 1) {
        if (!proposal.noteId) throw new Error('The source note is missing. Run Assist again before approving.');
        const note = this.note(state, proposal.noteId);
        if (proposal.sourceRevision !== note.revision) throw new Error('The source transcript changed. Process the note again before approving.');
      } else if (proposal.provenance?.version !== 2) throw new Error('This proposal has no verifiable source. Create it again before approving.');
      await this.validateProposalProvenance(state, proposal);
      if (!proposal.title.trim() || (!proposal.body.trim() && proposal.provenance.version !== 2)) throw new Error('A title and proposed content are required.');
      if (proposal.kind === 'email') {
        if (!proposal.accountId || !(proposal.email?.to.length || proposal.recipients.length)) throw new Error('Choose an account and at least one recipient before approving this email.');
        if (!proposal.email?.operation) throw new Error('Choose Draft in mailbox or Send email before approving this email.');
        if (!state.accounts.some((item) => item.id === proposal.accountId)) throw new Error('The selected account configuration was not found.');
        const email = proposal.email ?? { to: proposal.recipients, cc: [], bcc: [], subject: proposal.title, text: proposal.body, attachments: [] };
        const addresses = [...email.to, ...email.cc, ...email.bcc];
        if (!addresses.length || addresses.some((recipient) => !validEmail(recipient))) throw new Error('Check each recipient email address.');
        if (/[\r\n]/.test(email.subject)) throw new Error('Email subject cannot contain line breaks.');
        for (const attachment of email.attachments) {
          if (!attachment.id.trim() || /[\r\n]/.test(attachment.id) || !attachment.fileName.trim() || /[\r\n]/.test(attachment.fileName) || !/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) || !Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes <= 0 || !/^[a-f\d]{64}$/i.test(attachment.sha256)) {
            throw new Error('Email attachment metadata is incomplete or invalid.');
          }
        }
      }
      if (proposal.kind === 'event') {
        if (!proposal.calendarId) throw new Error('Choose a calendar before approving this event.');
        const calendar = state.calendars.find((item) => item.id === proposal.calendarId);
        if (!calendar || calendar.accountId !== proposal.accountId) throw new Error('The selected calendar does not belong to the selected account.');
        if (!proposal.event) throw new Error('Complete the event date, time zone, attendees, and invite policy before approving.');
        if (proposal.event) {
          const start = Date.parse(proposal.event.start);
          const end = Date.parse(proposal.event.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Event end must be later than its start.');
          try { new Intl.DateTimeFormat('en-US', { timeZone: proposal.event.timeZone }).format(); }
          catch { throw new Error('Choose a valid event time zone.'); }
          if (!['send', 'none'].includes(proposal.event.invitePolicy) || proposal.event.attendees.some((attendee) => !validEmail(attendee))) throw new Error('Check the event invite policy and attendee addresses.');
          const title = proposal.event.title?.trim() || proposal.title;
          if (!title || /[\r\n]/.test(title)) throw new Error('Event title is required and cannot contain line breaks.');
          proposal.event = { ...proposal.event, title, description: proposal.event.description ?? proposal.body };
        }
      }
      if (proposal.kind === 'reminder' && proposal.dueAt && !Number.isFinite(Date.parse(proposal.dueAt))) throw new Error('Enter a valid reminder date and time.');
      proposal.status = 'approved';
      proposal.approvedRevision = proposal.revision;
      proposal.approvedPayloadDigest = await approvedDigest(proposal, state);
      const decision = proposal.provenance.version === 1 ? appendDecision(state, proposal) : undefined;
      addActivity(state, 'proposal_approved', 'Suggestion approved with its current source, content, account, and destination details.', { proposalId: id, noteId: proposal.noteId });
      return { proposal, decision };
    });
    if (result.decision) await this.mirrorDocument(result.decision);
    return result.proposal;
  }

  async executeProposal(id: string): Promise<Proposal> {
    const claim = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (proposal.status !== 'approved' || proposal.approvedRevision !== proposal.revision || !proposal.approvedPayloadDigest) throw new Error('Approve this exact version before continuing.');
      let dependencyProjection: string;
      try { dependencyProjection = await this.validateProposalProvenance(state, proposal); }
      catch (error) {
        this.invalidate(proposal);
        proposal.status = 'draft';
        proposal.requiresRebuild = true;
        addActivity(state, 'error', 'An approved suggestion was invalidated because its source context changed. Run Assist again before reviewing it.', { proposalId: proposal.id, noteId: proposal.noteId });
        return { proposal, dependencyProjection: '', invalidated: error instanceof Error ? error.message : 'The source context changed.' };
      }
      if (proposal.kind === 'reminder') {
        if (!proposal.dueAt) throw new Error('Add a date and time before saving this reminder.');
        if (Date.parse(proposal.dueAt) <= Date.now()) throw new Error('Reminder time must be in the future.');
      }
      if (await approvedDigest(proposal, state) !== proposal.approvedPayloadDigest) throw new Error('The approved content or destination changed. Review and approve it again.');
      if (proposal.kind === 'event' && !proposal.eventTransactionId) proposal.eventTransactionId = newId();
      const operation = proposal.kind === 'email' ? proposal.email?.operation : proposal.kind === 'event' ? 'event' : undefined;
      const account = proposal.accountId ? state.accounts.find((item) => item.id === proposal.accountId) : undefined;
      const capability = operation === 'draft' ? 'mail.draft' : operation === 'send' ? 'mail.send' : operation === 'event' ? 'calendar.write' : undefined;
      const calendar = proposal.kind === 'event' ? state.calendars.find((item) => item.id === proposal.calendarId) : undefined;
      const canDispatch = (proposal.kind === 'email' || proposal.kind === 'event') && state.settings.mode === 'provider' && Boolean(this.connector && account && account.connected && account.authStatus === 'connected' && capability && account.capabilities?.includes(capability)) &&
        (proposal.kind !== 'event' || Boolean(calendar && calendar.accountId === account?.id && calendar.connected && calendar.writable && calendar.providerId));
      proposal.status = 'dispatching';
      let dispatchRecord: DispatchRecord | undefined;
      if (canDispatch && account) {
        if (state.dispatchRecordQuarantine.length) throw new Error('Dispatch history failed integrity validation. External writes are disabled until the receipt history is repaired.');
        dispatchRecord = createDispatchRecord({ id: newId(), dispatchStartedAt: now(), proposal, account, calendar });
        assertNoDuplicateDispatch(state, dispatchRecord);
        state.dispatchRecords.unshift(dispatchRecord);
        proposal.dispatchRecordId = dispatchRecord.id;
      }
      return { proposal, dependencyProjection, dispatchRecord, capturedAccount: canDispatch && account ? account : undefined };
    });
    if ('invalidated' in claim) throw new Error(claim.invalidated);
    const claimed = claim.proposal;
    const approvedDependencyProjection = claim.dependencyProjection;
    const frozenRecord = claim.dispatchRecord;

    let result: ProposalStatusOutcome;
    if (claimed.kind === 'reminder') {
      const alert = await requestReminderNotification(claimed, undefined, undefined, () =>
        this.proposalDependencyProjection(this.snapshot, claimed) === approvedDependencyProjection);
      result = alert.status === 'blocked' || alert.status === 'expired'
        ? { status: 'failed', message: alert.status === 'expired' ? 'Reminder time passed while alert permission was being checked. Review and approve a future time.' : 'The reminder source context changed before scheduling. Run Assist again and review the suggestion.' }
        : { status: 'executed', notificationId: alert.status === 'scheduled' ? alert.notificationId : undefined, message: alert.status === 'scheduled'
          ? 'Reminder saved locally and an alert was scheduled on this device.'
          : alert.status === 'unavailable'
            ? 'Reminder saved locally. This browser does not provide alerts after its tab is closed.'
            : 'Reminder saved locally; alerts are disabled on this device.' };
    } else if (claimed.kind === 'task') {
      result = { status: 'executed', message: 'Task saved locally on this device.' };
    } else if (claimed.kind === 'memory') {
      try {
        const document = await this.mutate((state) => {
          if (this.proposalDependencyProjection(state, claimed) !== approvedDependencyProjection) throw new Error('The memory source context changed before it was saved. Run Assist again and review the suggestion.');
          const path = 'memory/PROFILE.md';
          const existing = state.documents.find((doc) => doc.path === path);
          const marker = `<!-- proposal:${claimed.id} -->`;
          if (existing?.content.includes(marker)) return existing;
          const content = `${existing?.content?.trim() ?? '# Profile\n'}\n${marker}\n- ${claimed.body.trim()}\n`;
          const next = upsertDocument(state, path, content);
          return next;
        });
        await this.mirrorDocument(document);
        result = { status: 'executed', message: 'Memory saved to the local profile documents.' };
      } catch (error) {
        result = { status: 'failed', message: error instanceof Error ? error.message : 'Could not write the local memory.' };
      }
    } else {
      if (!frozenRecord || !this.connector || !claim.capturedAccount) {
        result = { status: 'simulated', message: `Simulation only: this ${claimed.kind === 'email' ? 'email' : 'calendar event'} was not sent or created in an external account because provider mode, verified identity, and the selected permission are required.` };
      } else {
        const account = claim.capturedAccount;
        const record = frozenRecord;
        const operation = record.operation;
        const envelope: ApprovedDispatch = {
          proposalId: record.proposalId, revision: record.approvedRevision, sourceRevision: record.sourceRevision, operation,
          accountId: record.accountId, identity: clone(record.account.identity), payloadDigest: record.payloadDigest,
          title: record.title, body: record.body, calendarId: record.calendar?.providerId,
          ...(record.sourceProvenance.version === 2 ? { replySource: clone(record.sourceProvenance) } : {}),
          payload: record.payload.kind === 'email'
            ? { ...clone(record.payload.email), operation: record.operation === 'draft' || record.operation === 'send' ? record.operation : undefined }
            : clone(record.payload.event),
        };
        const matchesFrozenPayload = (proposal: Proposal) => stableJson(proposal.kind === 'email'
          ? proposal.email
          : proposal.kind === 'event'
            ? { ...proposal.event, title: proposal.event?.title ?? proposal.title, description: proposal.event?.description ?? proposal.body }
            : null) === stableJson(envelope.payload);
        const recordIsCurrent = (state: AppState, proposal: Proposal) => {
          const persisted = state.dispatchRecords.find((item) => item.id === record.id);
          return persisted?.outcome === 'pending' && proposal.dispatchRecordId === record.id && persisted.payloadDigest === record.payloadDigest;
        };
        const verifier: DispatchVerifier = { verify: async (candidate) => {
          const currentState = this.snapshot;
          const current = currentState.proposals.find((item) => item.id === id);
          const currentAccount = currentState.accounts.find((item) => item.id === record.accountId);
          if (!current || !currentAccount || !recordIsCurrent(currentState, current) || current.status !== 'dispatching' ||
              current.revision !== record.approvedRevision || current.approvedRevision !== record.approvedRevision ||
              current.approvedPayloadDigest !== record.payloadDigest || current.sourceRevision !== record.sourceRevision ||
              current.accountId !== record.accountId || !sameAccountIdentity(currentAccount.identity, record.account.identity) ||
              await approvedDigest(current, currentState) !== record.payloadDigest || !matchesFrozenPayload(current)) return false;
          if (await this.validateProposalProvenance(currentState, current) !== approvedDependencyProjection) return false;
          return stableJson(candidate) === stableJson(envelope);
        }, verifyBeforeDispatch: (candidate) => {
          const currentState = this.snapshot;
          const current = currentState.proposals.find((item) => item.id === id);
          const currentNote = current?.provenance?.version === 1 && current.noteId
            ? currentState.notes.find((item) => item.id === current.noteId) : undefined;
          const currentAccount = currentState.accounts.find((item) => item.id === record.accountId);
          const expectedCapability = operation === 'draft' ? 'mail.draft' : operation === 'send' ? 'mail.send' : 'calendar.write';
          if (!current || (current.provenance?.version === 1 && !currentNote) || !currentAccount || currentState.settings.mode !== 'provider' || !recordIsCurrent(currentState, current) ||
              current.status !== 'dispatching' || current.approvedRevision !== record.approvedRevision || current.revision !== record.approvedRevision ||
              current.approvedPayloadDigest !== record.payloadDigest ||
              (current.provenance?.version === 1 && (current.sourceRevision !== currentNote?.revision || current.sourceRevision !== record.sourceRevision)) ||
              (record.sourceProvenance.version === 2 && (current.provenance?.version !== 2 || current.provenance.sourceDigest !== record.sourceProvenance.sourceDigest)) ||
              current.accountId !== record.accountId || currentAccount.authStatus !== 'connected' || !currentAccount.connected ||
              currentAccount.connectionGeneration !== account.connectionGeneration || !currentAccount.capabilities?.includes(expectedCapability) ||
              !sameAccountIdentity(currentAccount.identity, record.account.identity) || !matchesFrozenPayload(current) ||
              this.proposalDependencyProjection(currentState, current) !== approvedDependencyProjection ||
              stableJson(candidate) !== stableJson(envelope)) return false;
          if (operation === 'event') {
            const target = currentState.calendars.find((item) => item.id === current.calendarId);
            if (!target || !target.connected || !target.writable || target.accountId !== currentAccount.id || target.providerId !== record.calendar?.providerId) return false;
          }
          return true;
        } };
        try {
          const receipt: MutationReceipt = operation === 'draft'
            ? await this.connector.createDraft(account, envelope, verifier)
            : operation === 'send'
              ? await this.connector.sendEmail(account, envelope, verifier)
              : await this.connector.createEvent(account, record.calendar!.providerId, envelope, verifier, record.providerIdempotencyKey!);
          result = receipt.status === 'unknown'
            ? { status: 'unknown', operation, dispatchOutcome: 'unknown', message: 'The provider outcome is unknown. Check the destination manually; this action will not be retried.' }
            : { status: 'accepted', operation, dispatchOutcome: 'accepted', remoteId: receipt.id, replyDraftCheck: receipt.replyDraftCheck, message: `The provider accepted the ${operation} request${receipt.id ? ` (reference ${receipt.id})` : ''}. Completion or delivery is not confirmed.` };
        } catch (error) {
          const providerRejected = error instanceof ProviderWriteRejectedError;
          result = {
            status: 'failed', dispatchOutcome: 'rejected',
            rejectionCode: providerRejected ? 'provider_rejected' : 'precondition_failed',
            message: providerRejected
              ? `The provider rejected the ${operation} request (HTTP ${error.status}). Review the destination and approve a fresh attempt if needed.`
              : error instanceof Error ? error.message : 'The approved action was rejected before transmission.',
          };
        }
      }
    }

    let cancelReminder = false;
    let committed: Proposal | undefined;
    try {
      committed = await this.mutate((state) => {
        let persistedRecord: DispatchRecord | undefined;
        if (frozenRecord) {
          const recordIndex = state.dispatchRecords.findIndex((item) => item.id === frozenRecord.id);
          const record = state.dispatchRecords[recordIndex];
          if (!record) throw new Error('The frozen dispatch receipt disappeared before its result could be saved.');
          if (record.outcome === 'pending') {
            const outcome = result.dispatchOutcome ?? (result.status === 'accepted' ? 'accepted' : result.status === 'unknown' ? 'unknown' : 'rejected');
            persistedRecord = recordDispatchOutcome(record, {
              outcome, at: new Date(Math.max(Date.now(), Date.parse(record.dispatchStartedAt))).toISOString(),
              ...(result.remoteId ? { remoteId: result.remoteId } : {}),
              ...(result.replyDraftCheck ? { replyDraftCheck: result.replyDraftCheck } : {}),
              ...(outcome === 'rejected' ? { rejectionCode: result.rejectionCode ?? 'precondition_failed' } : {}),
            });
            state.dispatchRecords[recordIndex] = persistedRecord;
          } else {
            persistedRecord = record;
          }
          result.status = persistedRecord.outcome === 'accepted' ? 'accepted' : persistedRecord.outcome === 'unknown' ? 'unknown' : 'failed';
          result.dispatchOutcome = persistedRecord.outcome === 'pending' ? undefined : persistedRecord.outcome;
          result.operation = persistedRecord.operation;
          result.remoteId = persistedRecord.remoteId;
          result.rejectionCode = persistedRecord.rejectionCode;
          if (persistedRecord.outcome === 'unknown') result.message = 'The provider outcome is unknown. Check the destination manually; this action will not be retried.';
          if (persistedRecord.outcome === 'accepted') result.message = `The provider accepted the ${persistedRecord.operation} request${persistedRecord.remoteId ? ` (reference ${persistedRecord.remoteId})` : ''}. Completion or delivery is not confirmed.`;
          if (persistedRecord.outcome === 'rejected' && persistedRecord.rejectionCode === 'provider_rejected') result.message = `The provider rejected the ${persistedRecord.operation} request. Review the destination and approve a fresh attempt if needed.`;
        }
        const proposal = state.proposals.find((item) => item.id === id);
        if (!proposal) {
          if (!persistedRecord) throw new Error('The action was removed before completion.');
          addActivity(state, result.status === 'failed' || result.status === 'unknown' ? 'error' : 'local_action',
            `Dispatch receipt saved after the proposal was removed: ${result.message}`, { proposalId: frozenRecord!.proposalId });
          return undefined;
        }
        if (proposal.status !== 'dispatching') {
          if (!persistedRecord) throw new Error('Action state changed while execution was in progress.');
          addActivity(state, 'error', `Dispatch receipt saved while preserving the proposal’s newer state: ${result.message}`, { proposalId: frozenRecord!.proposalId, noteId: proposal.noteId });
          return proposal;
        }
        if ((proposal.kind === 'task' || proposal.kind === 'reminder') && result.status === 'executed' &&
            this.proposalDependencyProjection(state, proposal) !== approvedDependencyProjection) {
          cancelReminder = proposal.kind === 'reminder';
          result = { status: 'failed', message: 'The source context changed before this local action was committed. Run Assist again and review the suggestion.' };
        }
        proposal.status = result.status;
        proposal.simulated = result.status === 'simulated';
        proposal.lastError = result.status === 'failed' || result.status === 'unknown' ? result.message : undefined;
        if ('operation' in result && result.operation) proposal.remoteOperation = result.operation;
        if ('remoteId' in result && result.remoteId) proposal.remoteId = result.remoteId;
        if (result.status === 'accepted') proposal.remoteAcceptedAt = now();
        if (result.notificationId && result.status === 'executed') {
          proposal.notificationId = result.notificationId;
          proposal.notificationRevision = proposal.revision;
        }
        if (proposal.kind === 'task' && result.status === 'executed' && !state.tasks.some((task) => task.id === proposal.id) && proposal.noteId && Number.isSafeInteger(proposal.sourceRevision)) {
          state.tasks.unshift({ id: proposal.id, title: proposal.title, body: proposal.body, status: 'open', createdAt: now(), dueAt: proposal.dueAt, sourceNoteId: proposal.noteId, sourceRevision: proposal.sourceRevision!, proposalId: proposal.id });
          markTaskAnalysesStale(state, proposal.id);
        }
        addActivity(state, result.status === 'simulated' ? 'simulation' : result.status === 'failed' || result.status === 'unknown' ? 'error' : 'local_action', result.message, { proposalId: id, noteId: proposal.noteId });
        return proposal;
      });
    } catch (error) {
      if (claimed.kind === 'reminder') await cancelReminderNotification(claimed);
      throw error;
    }
    if (cancelReminder) await cancelReminderNotification(claimed);
    if (!committed && frozenRecord) {
      // Preserve a truthful result for the caller even if the local proposal was removed;
      // the durable dispatch history remains the canonical receipt.
      return {
        ...claimed, status: result.status, dispatchRecordId: frozenRecord.id,
        remoteOperation: frozenRecord.operation, remoteId: result.remoteId,
        remoteAcceptedAt: result.status === 'accepted' ? frozenRecord.outcomeAt : undefined,
        lastError: result.status === 'failed' || result.status === 'unknown' ? result.message : undefined,
      };
    }
    if (!committed) throw new Error('The action was removed before completion.');
    return committed;
  }

  async dismissProposal(id: string): Promise<Proposal> {
    return this.mutate((state) => {
      const proposal = this.proposal(state, id);
      if (['dispatching', 'unknown', 'executed', 'accepted', 'simulated'].includes(proposal.status)) throw new Error('This proposal cannot be dismissed while or after execution.');
      proposal.status = 'dismissed';
      proposal.approvedRevision = undefined;
      proposal.approvedPayloadDigest = undefined;
      addActivity(state, 'proposal_created', 'Suggestion dismissed.', { proposalId: id, noteId: proposal.noteId });
      return proposal;
    });
  }

  async reconcileDispatch(recordId: string, input: { disposition: DispatchReconciliation; note: string; remoteId?: string }): Promise<DispatchRecord> {
    return this.mutate((state) => {
      const index = state.dispatchRecords.findIndex((record) => record.id === recordId);
      if (index < 0) throw new Error('Dispatch history record was not found.');
      const current = state.dispatchRecords[index];
      const updated = appendDispatchReconciliation(current, {
        id: newId(), disposition: input.disposition,
        at: new Date(Math.max(Date.now(), current.outcomeAt ? Date.parse(current.outcomeAt) : 0)).toISOString(),
        note: input.note, ...(input.remoteId ? { remoteId: input.remoteId } : {}),
      });
      state.dispatchRecords[index] = updated;
      addActivity(state, 'local_action', 'Added a local reconciliation note. Provider outcome remains unchanged.', { proposalId: current.proposalId });
      return updated;
    });
  }

  async completeTask(id: string): Promise<LocalTask> {
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error('Task was not found.');
      if (task.status !== 'completed') { task.status = 'completed'; task.completedAt = now(); }
      markTaskAnalysesStale(state, id);
      addActivity(state, 'local_action', `Task completed: ${task.title}.`, { noteId: task.sourceNoteId, proposalId: task.proposalId });
      return task;
    });
  }

  async reopenTask(id: string): Promise<LocalTask> {
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error('Task was not found.');
      task.status = 'open'; delete task.completedAt;
      markTaskAnalysesStale(state, id);
      addActivity(state, 'local_action', `Task reopened: ${task.title}.`, { noteId: task.sourceNoteId, proposalId: task.proposalId });
      return task;
    });
  }

  async saveProactiveRule(input: {
    id?: string; expectedVersion?: number; name: string; enabled: boolean; accountIds: string[];
    trigger: ProactiveTrigger; quietHours?: QuietHours;
  }): Promise<SavedProactiveRule> {
    if (this.proactiveQuarantine) throw new Error(PROACTIVE_INTEGRITY_ERROR);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Rule name must contain 1 to 80 printable characters.');
    if (typeof input.enabled !== 'boolean') throw new Error('Rule enabled must be a boolean.');
    if (!Array.isArray(input.accountIds) || input.accountIds.length > 64 || input.accountIds.some((id) => typeof id !== 'string' || !id) || new Set(input.accountIds).size !== input.accountIds.length) {
      throw new Error('Choose up to 64 unique configured accounts.');
    }
    const accountIds = [...input.accountIds].sort();
    if (input.trigger?.type === 'task_due' && accountIds.length) throw new Error('Task due rules apply to local tasks only; leave the account filter empty.');
    const ruleId = input.id ?? newId();
    const trigger = clone(input.trigger);
    const quietHours = input.quietHours ? clone(input.quietHours) : undefined;
    const writeTime = now();
    return this.mutateIfChanged((state) => {
      if (state.proactive.integrityError) throw new Error(PROACTIVE_INTEGRITY_ERROR);
      if (accountIds.some((accountId) => !state.accounts.some((account) => account.id === accountId))) {
        throw new Error('Rule account filters must reference saved account configurations.');
      }
      const prior = state.proactive.rules.find((rule) => rule.id === ruleId);
      if (input.id) {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion! < 1) throw new Error('Editing a rule requires its current version.');
        if (!prior) throw new Error('Proactive rule was not found.');
        if (prior.version !== input.expectedVersion) throw new Error('This proactive rule changed elsewhere. Reload it before saving.');
      } else if (input.expectedVersion !== undefined) throw new Error('A new proactive rule cannot include an expected version.');
      const candidate: SavedProactiveRule = {
        id: ruleId, revision: prior?.revision ?? 1, version: prior?.version ?? 1, name, enabled: input.enabled, accountIds, trigger,
        ...(quietHours ? { quietHours } : {}), createdAt: prior?.createdAt ?? writeTime, updatedAt: prior?.updatedAt ?? writeTime,
      };
      if (prior) {
        const eligibilityBefore = proactiveStableValue({ enabled: prior.enabled, accountIds: prior.accountIds, trigger: prior.trigger, quietHours: prior.quietHours ?? null });
        const eligibilityAfter = proactiveStableValue({ enabled: candidate.enabled, accountIds: candidate.accountIds, trigger: candidate.trigger, quietHours: candidate.quietHours ?? null });
        const changed = eligibilityBefore !== eligibilityAfter || prior.name !== candidate.name;
        if (!changed) return { changed: false, result: prior };
        candidate.revision = prior.revision + Number(eligibilityBefore !== eligibilityAfter);
        candidate.version = prior.version + 1;
        candidate.updatedAt = writeTime;
      }
      evaluateProactive({ nowUtc: new Date().toISOString(), timeZone: state.settings.timezone, rules: [candidate], sources: [] });
      if (prior) {
        const priorIndex = state.proactive.rules.findIndex((rule) => rule.id === prior.id);
        state.proactive.rules[priorIndex] = candidate;
      } else {
        if (state.proactive.rules.length >= 64) throw new Error('A maximum of 64 proactive rules can be saved.');
        state.proactive.rules.push(candidate);
      }
      return { changed: true, result: candidate };
    });
  }

  async deleteProactiveRule(id: string, expectedVersion: number): Promise<void> {
    if (this.proactiveQuarantine) throw new Error(PROACTIVE_INTEGRITY_ERROR);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('Deleting a rule requires its current version.');
    await this.mutateIfChanged((state) => {
      if (state.proactive.integrityError) throw new Error(PROACTIVE_INTEGRITY_ERROR);
      const index = state.proactive.rules.findIndex((rule) => rule.id === id);
      if (index < 0) throw new Error('Proactive rule was not found.');
      if (state.proactive.rules[index].version !== expectedVersion) throw new Error('This proactive rule changed elsewhere. Reload it before deleting.');
      state.proactive.rules.splice(index, 1);
      return { changed: true, result: undefined };
    });
  }

  async evaluateLocalCandidates(): Promise<ProactiveState> {
    await this.load();
    return this.mutateIfChanged(async (state) => {
      if (this.proactiveQuarantine || state.proactive.integrityError) return { changed: false, result: state.proactive };
      const changed = await this.evaluateProactiveDraft(state);
      return { changed, result: state.proactive };
    });
  }

  async dismissProactiveCandidate(candidateId: string): Promise<ProactiveCandidateEntry> {
    if (this.proactiveQuarantine) throw new Error(PROACTIVE_INTEGRITY_ERROR);
    return this.mutateIfChanged(async (state) => {
      if (state.proactive.integrityError) throw new Error(PROACTIVE_INTEGRITY_ERROR);
      await this.evaluateProactiveDraft(state);
      const entry = state.proactive.candidates.find((candidate) => candidate.candidate.id === candidateId);
      if (!entry) throw new Error('This proactive candidate is no longer retained. Refresh the local list.');
      const candidate = entry.candidate;
      if (!state.proactive.dismissals.some((item) => item.candidateId === candidate.id)) {
        if (state.proactive.dismissals.length >= 2000) throw new Error('Dismissal history is full. Remove old rules before dismissing another candidate.');
        state.proactive.dismissals.push({
          candidateId: candidate.id, ruleId: candidate.ruleId, ruleRevision: candidate.ruleRevision,
          sourceId: candidate.sourceId, sourceVersion: candidate.sourceVersion, dismissedAt: now(),
        });
      }
      return { changed: true, result: entry };
    });
  }

  async snoozeProactiveCandidate(candidateId: string, until: string): Promise<ProactiveCandidateEntry> {
    if (this.proactiveQuarantine) throw new Error(PROACTIVE_INTEGRITY_ERROR);
    const requestedAt = Date.now();
    const parsedUntil = new Date(until);
    if (!Number.isFinite(parsedUntil.getTime()) || parsedUntil.toISOString() !== until || parsedUntil.getTime() <= requestedAt || parsedUntil.getTime() > requestedAt + 7 * 86_400_000) {
      throw new Error('Snooze must end at a future time within the next seven days.');
    }
    return this.mutateIfChanged(async (state) => {
      if (state.proactive.integrityError) throw new Error(PROACTIVE_INTEGRITY_ERROR);
      await this.evaluateProactiveDraft(state);
      const entry = state.proactive.candidates.find((candidate) => candidate.candidate.id === candidateId);
      if (!entry) throw new Error('This proactive candidate is no longer retained. Refresh the local list.');
      const candidate = entry.candidate;
      const snoozedAt = now();
      const createdAtMs = Date.parse(snoozedAt);
      const untilMs = Date.parse(until);
      if (!Number.isFinite(untilMs) || untilMs <= createdAtMs || untilMs - createdAtMs > 7 * 86_400_000) {
        throw new Error('Snooze must end at a future time within the next seven days.');
      }
      const prior = state.proactive.snoozes.find((item) => item.suppressionKey === candidate.suppressionKey);
      if (!prior && state.proactive.snoozes.length >= 2000) throw new Error('Snooze history is full. Wait for an existing snooze to expire.');
      if (prior) { prior.until = until; prior.snoozedAt = snoozedAt; }
      else state.proactive.snoozes.push({ suppressionKey: candidate.suppressionKey, ruleId: candidate.ruleId, sourceId: candidate.sourceId, until, snoozedAt });
      return { changed: true, result: entry };
    });
  }

  async getProactiveCandidateSource(candidateId: string): Promise<ProactiveCandidateSourceResult> {
    await this.load();
    const boundSnapshot = this.snapshot;
    const entry = boundSnapshot.proactive.candidates.find((candidate) => candidate.candidate.id === candidateId);
    if (!entry) return { status: 'missing' };
    if (this.proactiveQuarantine || boundSnapshot.proactive.integrityError) return { status: 'stale', candidate: entry.candidate };
    const builtSources = await buildProactiveSources(
      boundSnapshot,
      boundSnapshot.proactive.candidates.map((candidate) => candidate.candidate),
      Date.now(), this.proactiveSourceHashMemo,
      (value) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, { encoding: Crypto.CryptoEncoding.HEX }),
    );
    if (this.snapshot !== boundSnapshot) return { status: 'stale', candidate: entry.candidate };
    const current = builtSources.sources.find((source) => source.sourceId === entry.candidate.sourceId);
    if (!current && builtSources.omittedSourceCount > 0) return { status: 'stale', candidate: entry.candidate };
    if (!current) return { status: 'missing', candidate: entry.candidate };
    if (current.availability === 'unavailable') return { status: 'unavailable', candidate: entry.candidate };
    if (current.freshness !== 'fresh' || current.sourceVersion !== entry.candidate.sourceVersion) return { status: 'stale', candidate: entry.candidate };
    return { status: 'current', candidate: entry.candidate, source: current };
  }

  async saveDocument(path: string, content: string): Promise<ContextDocument> {
    const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || cleanPath.split('/').some((part) => part === '.' || part === '..')) throw new Error('Document path must stay inside the app documents folder.');
    const document = await this.mutate((state) => {
      const existing = state.documents.find((item) => item.path === cleanPath);
      if (existing?.content === content) return existing;
      const changed = existing?.content !== content;
      const next: ContextDocument = { path: cleanPath, content, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
      if (existing) Object.assign(existing, next); else state.documents.unshift(next);
      if (changed) markAnalysesStale(state, [`doc:${cleanPath}`]);
      return next;
    });
    await this.mirrorDocument(document);
    return document;
  }

  private async mirrorDocument(document: ContextDocument): Promise<void> {
    try { await writePrivateDocument(document.path, document.content); this.mirrorDirty.delete(document.path); }
    catch (error) {
      this.mirrorDirty.add(document.path);
      await this.mutate((state) => addActivity(state, 'error', `Local document mirror for ${document.path} will retry on next launch: ${error instanceof Error ? error.message : 'write failed'}.`));
    }
  }

  private async retryDocumentMirrors(): Promise<void> {
    for (const path of [...this.mirrorDirty]) {
      const document = this.snapshot.documents.find((item) => item.path === path);
      if (!document) { this.mirrorDirty.delete(path); continue; }
      try { await writePrivateDocument(document.path, document.content); this.mirrorDirty.delete(path); }
      catch { /* canonical SQLite/IndexedDB document remains available and will retry next launch */ }
    }
  }

  async saveSettings(patch: SettingsPatch): Promise<AppSettings> {
    const sanitized: SettingsPatch = { ...patch };
    if ('speechEndpoint' in sanitized) sanitized.speechEndpoint = sanitized.speechEndpoint ? validateAzureEndpoint(sanitized.speechEndpoint, 'speech') : undefined;
    if ('openAiEndpoint' in sanitized) sanitized.openAiEndpoint = sanitized.openAiEndpoint ? validateAzureEndpoint(sanitized.openAiEndpoint, 'openai') : undefined;
    if (sanitized.model && sanitized.model !== 'gpt-6-luna') throw new Error('This app is configured for GPT-6 Luna only.');
    if (sanitized.reasoningEffort && !['none', 'low'].includes(sanitized.reasoningEffort)) throw new Error('Reasoning effort must be none or low.');
    if (sanitized.mode && !['preview', 'provider'].includes(sanitized.mode)) throw new Error('Choose Preview or Provider mode.');
    if (sanitized.timezone !== undefined) sanitized.timezone = validTimezone(sanitized.timezone);
    if (sanitized.audioRetention && !['keep', 'delete_after_transcription'].includes(sanitized.audioRetention)) throw new Error('Choose a supported audio retention policy.');
    if (sanitized.maxContextTokens !== undefined) sanitized.maxContextTokens = finiteClamp(sanitized.maxContextTokens, 256, 6000, 'Context token limit');
    if (sanitized.maxRequestBytes !== undefined) sanitized.maxRequestBytes = finiteClamp(sanitized.maxRequestBytes, 4000, 96000, 'Request byte limit');
    if (sanitized.maxOutputTokens !== undefined) sanitized.maxOutputTokens = finiteClamp(sanitized.maxOutputTokens, 64, 2400, 'Output token limit');
    if (sanitized.monthlyBudgetUsd !== undefined) sanitized.monthlyBudgetUsd = finiteRange(sanitized.monthlyBudgetUsd, 0, 100, 'Monthly budget');
    if (sanitized.maxAttempts !== undefined) sanitized.maxAttempts = finiteClamp(sanitized.maxAttempts, 1, 2, 'Maximum attempts');
    if (sanitized.maxCallsPerDay !== undefined) sanitized.maxCallsPerDay = finiteClamp(sanitized.maxCallsPerDay, 1, 100, 'Daily provider call limit');
    if (sanitized.maxAudioSeconds !== undefined) sanitized.maxAudioSeconds = finiteClamp(sanitized.maxAudioSeconds, 10, 600, 'Maximum audio length');
    for (const rate of ['inputUsdPerMillionTokens', 'outputUsdPerMillionTokens', 'speechUsdPerMinute'] as const) {
      if (sanitized[rate] !== undefined) sanitized[rate] = finiteRange(sanitized[rate]!, 0, 10000, 'Provider rate');
    }
    return this.mutate((state) => {
      this.rollUsage(state);
      Object.assign(state.settings, sanitized);
      this.rollUsage(state);
      addActivity(state, 'local_action', 'Settings saved locally.');
      return state.settings;
    });
  }

  async saveAccount(config: AccountConfig): Promise<Account> {
    const email = config.email.trim().toLowerCase();
    if (!email.includes('@') || /[\s<>]/.test(email)) throw new Error('Enter a valid account email address.');
    return this.mutate((state) => {
      const id = config.id ?? newId();
      const prior = state.accounts.find((item) => item.id === id);
      if (prior?.identity && prior.provider !== config.provider) throw new Error('A saved provider identity cannot be moved to a different provider. Create a separate account entry.');
      if (prior?.identity && state.proposals.some((item) => item.accountId === id && item.status === 'dispatching')) throw new Error('Wait for the current provider operation to finish before editing this account.');
      const oldTokenRef = prior?.tokenRef;
      const account: Account = { id, provider: config.provider, displayName: config.displayName.trim(), email, connected: false, authStatus: 'configured', identity: prior?.identity, tokenRef: undefined, grantedScopes: [], capabilities: [], syncStatus: 'idle', connectionGeneration: (prior?.connectionGeneration ?? 0) + 1 };
      if (prior) { Object.assign(prior, account); delete prior.verifiedEmail; } else state.accounts.push(account);
      if (oldTokenRef && !state.pendingCredentialCleanup.some((item) => item.tokenRef === oldTokenRef)) {
        state.pendingCredentialCleanup.push({ tokenRef: oldTokenRef, reason: 'disconnected', createdAt: now() });
      }
      for (const proposal of state.proposals.filter((item) => item.accountId === id && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      addActivity(state, 'local_action', `${account.displayName || account.email} saved as an unconnected account configuration.`);
      return account;
    });
  }

  private async handleConnectorAuthStatus(accountId: string, status: Account['authStatus']): Promise<void> {
    if (status !== 'reauth_required' && status !== 'revoked') return;
    this.syncGeneration.set(accountId, (this.syncGeneration.get(accountId) ?? 0) + 1);
    this.syncAbortControllers.get(accountId)?.abort();
    await this.mutate((state) => {
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account) return;
      if (account.identity) {
        const priorIdentity = encodeURIComponent(identityKey(account));
        markAnalysesStale(state, [], [`mail:${priorIdentity}:`, `calendar:${priorIdentity}:`, `calendar-event:${priorIdentity}:`]);
      }
      account.authStatus = status;
      account.connected = false;
      account.capabilities = [];
      account.syncStatus = 'error';
      for (const calendar of state.calendars.filter((item) => item.accountId === accountId)) { calendar.connected = false; calendar.writable = false; }
      for (const proposal of state.proposals.filter((item) => item.accountId === accountId && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      const sync = state.syncStates[accountId] ?? emptySyncState(accountId);
      sync.status = 'error'; sync.lastError = 'Account authentication needs attention.';
      interruptMailLanes(sync, 'Account authentication changed during mail sync. Reconnect and continue explicitly.');
      state.syncStates[accountId] = sync;
      addActivity(state, 'error', `${account.displayName || account.email} needs to reconnect.`);
    });
  }

  async installVerifiedAccount(config: AccountConfig, result: OAuthInstallResult): Promise<Account> {
    const tokenStore = this.integration.tokenStore;
    if (!tokenStore || !this.integration.verifyOAuthResult || !this.connector) throw new Error('Verified account connection is unavailable until the OAuth and connector services are configured.');
    await this.load();
    if (result.provider !== config.provider || !['google', 'microsoft'].includes(result.provider)) throw new Error('The verified sign-in does not match this account configuration.');
    const expectedClientId = this.integration.clientIds?.[result.provider];
    if (!expectedClientId || result.identity.providerNamespace !== result.provider || result.identity.clientId !== expectedClientId ||
        !result.identity.subject || (result.provider === 'microsoft' && !result.identity.resourceUserId) ||
        !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || !result.accessToken) throw new Error('The provider identity or token is incomplete or expired.');
    const tokenRef = `oauth-${newId()}`;
    this.installingTokenRefs.add(tokenRef);
    // Capture lifecycle state before asynchronous keychain/provider verification; commit uses CAS.
    const initial = this.snapshot;
    const initialExisting = initial.accounts.find((account) => sameAccountIdentity(account.identity, result.identity)) ??
      (config.id ? initial.accounts.find((account) => account.id === config.id) : undefined);
    const expectedLifecycle = initialExisting ? {
      id: initialExisting.id, generation: initialExisting.connectionGeneration ?? 0,
      tokenRef: initialExisting.tokenRef, identity: clone(initialExisting.identity), authStatus: initialExisting.authStatus, connected: initialExisting.connected,
    } : undefined;
    let staged = false;
    try {
      // Register before writing so a crash or verification failure leaves a durable orphan cleanup record.
      await this.queueCredentialCleanup(tokenRef, 'orphan');
      await tokenStore.set(tokenRef, { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt, identity: result.identity });
      staged = true;
      let stored = await tokenStore.get(tokenRef);
      if (!stored || stored.accessToken !== result.accessToken || stored.expiresAt !== result.expiresAt || !sameAccountIdentity(stored.identity, result.identity)) {
        throw new Error('The staged token does not match the verified sign-in result.');
      }
      if (stored.refreshToken !== result.refreshToken) throw new Error('The staged refresh credential does not match the verified sign-in result.');
      if (!await this.integration.verifyOAuthResult(result as OAuthBridgeResult, stored) || !await this.connector.verifyOAuthIdentity(result as OAuthBridgeResult, stored)) {
        throw new Error('The provider could not verify this account identity and granted access.');
      }
      const email = (result.email || config.email).trim().toLowerCase();
      if (!validEmail(email)) throw new Error('The verified account did not provide a valid email address.');
      const scopeCapabilities = grantedCapabilities(result.provider, result.grantedScopes);
      const effectiveCapabilities = intersectCapabilities(result.requestedCapabilities, result.capabilities, scopeCapabilities);
      const commitInstall = async (): Promise<Account> => {
        let expectedRefreshToken = result.refreshToken;
        if (expectedLifecycle?.tokenRef && expectedLifecycle.connected && expectedLifecycle.authStatus === 'connected' &&
            expectedLifecycle.identity && sameAccountIdentity(expectedLifecycle.identity, result.identity) && !result.refreshToken) {
          const priorForRefresh = await tokenStore.get(expectedLifecycle.tokenRef);
          if (priorForRefresh && sameAccountIdentity(priorForRefresh.identity, result.identity) && priorForRefresh.refreshToken) {
            expectedRefreshToken = priorForRefresh.refreshToken;
            await tokenStore.set(tokenRef, { accessToken: result.accessToken, refreshToken: expectedRefreshToken, expiresAt: result.expiresAt, identity: result.identity });
          }
        }
        const verifiedReadback = await tokenStore.get(tokenRef);
        if (!verifiedReadback || verifiedReadback.accessToken !== result.accessToken || verifiedReadback.refreshToken !== expectedRefreshToken ||
            verifiedReadback.expiresAt !== result.expiresAt || !sameAccountIdentity(verifiedReadback.identity, result.identity)) {
        throw new Error('The secure account credential could not be verified after storage.');
        }
        return this.mutate((state) => {
        const existing = state.accounts.find((account) => sameAccountIdentity(account.identity, result.identity));
        const configured = config.id ? state.accounts.find((account) => account.id === config.id) : undefined;
        if (config.id) {
          const reusablePlaceholder = configured && configured.provider === result.provider && !configured.identity && configured.authStatus === 'configured' && !configured.tokenRef;
          if (configured && !sameAccountIdentity(configured.identity, result.identity) && !reusablePlaceholder) throw new Error('Choose a new account entry for a different provider identity.');
          if (existing && existing.id !== config.id) throw new Error('This provider identity is already connected under another account entry.');
        }
        const prior = existing ?? configured;
        if (expectedLifecycle) {
          const current = state.accounts.find((account) => account.id === expectedLifecycle.id);
          if (!current || current.connectionGeneration !== expectedLifecycle.generation || current.tokenRef !== expectedLifecycle.tokenRef ||
              JSON.stringify(current.identity ?? null) !== JSON.stringify(expectedLifecycle.identity ?? null) || current.authStatus !== expectedLifecycle.authStatus ||
              current.connected !== expectedLifecycle.connected) {
            throw new Error('The account changed while reconnecting. Restart sign-in to protect the active connection.');
          }
        } else if (prior) throw new Error('The account was connected or changed while sign-in was being verified. Restart sign-in.');
        const oldTokenRef = prior?.tokenRef;
        const account: Account = {
          id: prior?.id ?? config.id ?? newId(), provider: result.provider,
          displayName: (result.displayName || config.displayName).trim(), email,
          ...(result.email ? { verifiedEmail: email } : {}),
          connected: true, authStatus: 'connected', identity: clone(result.identity), tokenRef,
          grantedScopes: [...new Set(result.grantedScopes)], capabilities: effectiveCapabilities,
          capabilityLimits: [...result.requestedCapabilities], syncStatus: 'idle', configuredAt: prior?.configuredAt ?? now(),
          connectionGeneration: (prior?.connectionGeneration ?? 0) + 1,
        };
        if (state.accounts.some((candidate) => candidate.id === account.id && candidate !== prior)) throw new Error('Account identifier is already in use.');
        if (prior?.identity && prior.connected) {
          const priorIdentity = encodeURIComponent(identityKey(prior));
          markAnalysesStale(state, [], [`mail:${priorIdentity}:`, `calendar:${priorIdentity}:`, `calendar-event:${priorIdentity}:`]);
        }
        for (const proposal of state.proposals.filter((item) => item.accountId === account.id && ['draft', 'approved', 'failed'].includes(item.status))) {
          this.invalidate(proposal); proposal.status = 'draft';
        }
        if (prior) { Object.assign(prior, account); if (!result.email) delete prior.verifiedEmail; } else state.accounts.push(account);
        state.pendingCredentialCleanup = state.pendingCredentialCleanup.filter((item) => item.tokenRef !== tokenRef);
        if (oldTokenRef && oldTokenRef !== tokenRef && !state.pendingCredentialCleanup.some((item) => item.tokenRef === oldTokenRef)) {
          state.pendingCredentialCleanup.push({ tokenRef: oldTokenRef, reason: 'replaced', createdAt: now() });
        }
        for (const calendar of state.calendars.filter((item) => item.accountId === account.id)) { calendar.connected = false; calendar.writable = false; }
        state.syncStates[account.id] ??= emptySyncState(account.id);
        interruptMailLanes(state.syncStates[account.id], 'Account identity changed during mail sync. Refresh the inbox or continue backfill explicitly.');
        addActivity(state, 'local_action', `${account.displayName || account.email} was connected after provider identity verification.`);
        return account;
        });
      };
      const priorRef = expectedLifecycle?.tokenRef;
      const installed = priorRef
        ? await withCredentialLock(tokenStore, priorRef, commitInstall)
        : await commitInstall();
      this.syncGeneration.set(installed.id, installed.connectionGeneration ?? 0);
      this.syncAbortControllers.get(installed.id)?.abort();
      this.installingTokenRefs.delete(tokenRef);
      await this.retryCredentialCleanup().catch(() => undefined);
      return installed;
    } catch (error) {
      if (staged) await this.queueCredentialCleanup(tokenRef, 'orphan').catch(() => undefined);
      this.installingTokenRefs.delete(tokenRef);
      await this.retryCredentialCleanup().catch(() => undefined);
      throw error;
    } finally {
      this.installingTokenRefs.delete(tokenRef);
    }
  }

  async disconnectAccount(id: string): Promise<Account> {
    this.syncGeneration.set(id, (this.syncGeneration.get(id) ?? 0) + 1);
    this.syncAbortControllers.get(id)?.abort();
    const account = await this.mutate((state) => {
      const current = state.accounts.find((item) => item.id === id);
      if (!current) throw new Error('Account was not found.');
      if (current.identity) {
        const priorIdentity = encodeURIComponent(identityKey(current));
        markAnalysesStale(state, [], [`mail:${priorIdentity}:`, `calendar:${priorIdentity}:`, `calendar-event:${priorIdentity}:`]);
      }
      const oldTokenRef = current.tokenRef;
      current.authStatus = 'configured'; current.connected = false; current.capabilities = []; current.grantedScopes = []; current.syncStatus = 'idle';
      delete current.verifiedEmail;
      current.tokenRef = undefined;
      current.connectionGeneration = (current.connectionGeneration ?? 0) + 1;
      if (oldTokenRef && !state.pendingCredentialCleanup.some((item) => item.tokenRef === oldTokenRef)) {
        state.pendingCredentialCleanup.push({ tokenRef: oldTokenRef, reason: 'disconnected', createdAt: now() });
      }
      for (const calendar of state.calendars.filter((item) => item.accountId === id)) { calendar.connected = false; calendar.writable = false; }
      for (const proposal of state.proposals.filter((item) => item.accountId === id && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal); proposal.status = 'draft';
      }
      const sync = state.syncStates[id] ?? emptySyncState(id);
      sync.status = sync.lastStartedAt ? 'partial' : 'idle';
      interruptMailLanes(sync, 'Account was disconnected during mail sync. Reconnect and continue explicitly.');
      state.syncStates[id] = sync;
      addActivity(state, 'local_action', `${current.displayName || current.email} was disconnected. Pending approvals were cleared.`);
      return current;
    });
    await this.retryCredentialCleanup();
    return account;
  }

  async syncAccount(id: string, options: { continue?: boolean } = {}): Promise<AccountSyncState> {
    const active = this.syncJobs.get(id);
    if (active) return active;
    await this.load();
    const configured = this.snapshot.accounts.find((item) => item.id === id);
    if (configured?.capabilities?.includes('mail.read') && !configured.capabilities.includes('calendar.read')) {
      throw new Error('This account has mailbox access. Use Refresh inbox or Continue backfill; this control only syncs calendars.');
    }
    if (this.busySyncAccounts.has(id)) throw new Error('Another sync lane is already active for this account. Finish it before starting calendar sync.');
    this.busySyncAccounts.add(id);
    const job = this.runSyncAccount(id, options).finally(() => { this.syncJobs.delete(id); this.busySyncAccounts.delete(id); });
    this.syncJobs.set(id, job);
    return job;
  }

  private requireConfirmedCaptureTimeZone(note: Note): void {
    if (note.importOrigin?.originalTimeZoneUnknown === true) {
      throw new Error('Confirm this imported note’s original time zone before running Assist or using it as reply context. The displayed UTC value is only a fallback.');
    }
  }

  async getMailReplySource(messageId: string): Promise<MailReplySourceResult> {
    await this.load();
    const captured = this.snapshot;
    const result = await this.currentMailReplySource(captured, messageId);
    if (captured !== this.snapshot) return { status: 'stale', ...(result.source ? { source: result.source } : {}) };
    return clone(result);
  }

  async createMailReplyProposal(input: { messageId: string; mode: 'reply' | 'reply_all'; sourceDigest: string; text: string; to?: string[]; cc?: string[] }): Promise<Proposal> {
    return this.mutate(async (state) => {
      if (!input || !['reply', 'reply_all'].includes(input.mode) || typeof input.sourceDigest !== 'string' || !/^[a-f\d]{64}$/i.test(input.sourceDigest)) throw new Error('Reply mode or source digest is invalid. Reopen the message and try again.');
      const result = await this.currentMailReplySource(state, input.messageId);
      if (result.status !== 'current' || !result.source || !result.defaults) throw new Error('Refresh this message before creating a reply draft.');
      if (result.source.sourceDigest.toLowerCase() !== input.sourceDigest.toLowerCase()) throw new Error('The source message changed. Reopen the reply composer and review its current recipients.');
      if (typeof input.text !== 'string' || input.text.length > 100_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) throw new Error('Reply text is invalid or too long.');
      const source = result.source;
      const account = state.accounts.find((item) => item.id === source.accountId);
      if (!account) throw new Error('The verified mail account is no longer available.');
      const defaults = result.defaults[input.mode];
      const to = input.to ? [...input.to] : [...defaults.to];
      const cc = input.cc ? [...input.cc] : [...defaults.cc];
      const provenance: MailReplyProvenance = {
        version: 2, kind: 'mail_reply', sourceDigest: source.sourceDigest, source,
        expiresAt: new Date(Date.parse(source.observedAt) + 15 * 60_000).toISOString(),
      };
      const reply = {
        mode: input.mode, sourceDigest: source.sourceDigest, localMessageId: source.localMessageId,
        providerMessageId: source.providerMessageId, idFormat: source.idFormat,
        internetMessageId: source.internetMessageId, sourceSubject: source.subject,
        ...(source.threadId ? { threadId: source.threadId } : {}),
        ...(replyReferences(source) ? { references: replyReferences(source) } : {}),
        inReplyTo: source.internetMessageId,
      } as const;
      const email = { operation: 'draft' as const, to, cc, bcc: [], subject: source.subject, text: input.text, attachments: [], reply };
      validateReplyBinding(email, provenance);
      const sourceActionKey = JSON.stringify(['mail-reply-v1', identityKey(account), source.providerMessageId, input.mode]);
      const duplicate = state.proposals.some((proposal) => proposal.sourceActionKey === sourceActionKey && ['accepted', 'unknown', 'dispatching'].includes(proposal.status) && !proposal.simulated) ||
        state.dispatchRecords.some((record) => record.sourceActionKey === sourceActionKey && ['pending', 'accepted', 'unknown'].includes(record.outcome));
      if (duplicate) throw new Error('A reply draft attempt for this message and mode already exists. Review its history before creating another.');
      const proposal: Proposal = {
        id: newId(), kind: 'email', title: source.subject ? `Re: ${source.subject}` : 'Reply draft', body: input.text,
        status: 'draft', revision: 1, accountId: account.id, recipients: [...to], evidence: [], sourceActionKey,
        provenance, email,
      };
      state.proposals.unshift(proposal);
      addActivity(state, 'proposal_created', 'Reply draft prepared from the selected mailbox message.', { proposalId: proposal.id });
      return proposal;
    });
  }

  private selectedMailFence(state: AppState, messageId: string): string | undefined {
    const message = state.mailbox.find((item) => item.id === messageId);
    if (!message) return undefined;
    const account = state.accounts.find((item) => item.id === message.accountId);
    if (!account) return undefined;
    return stableJson({
      accountId: account.id, provider: account.provider, connected: account.connected, authStatus: account.authStatus,
      tokenRef: account.tokenRef, identity: account.identity, connectionGeneration: account.connectionGeneration,
      capabilities: account.capabilities, grantedScopes: account.grantedScopes,
      metadata: canonicalMailboxContent(message),
    });
  }

  private selectedMailTextUnavailable(
    message: MailboxSnapshotMessage, account: Account, sourceDigest: string, reason: string, checkedAt = now(),
    extractionVersion: SelectedMailTextSnapshot['extractionVersion'] = 'mail-text-v2',
    reasons?: string[],
  ): SelectedMailTextSnapshot {
    const boundedReasons = (reasons ?? [reason]).filter((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 240).slice(0, 16);
    return {
      version: 1, messageId: message.id, accountId: account.id, identityKey: identityKey(account),
      identity: clone(account.identity!), connectionGeneration: account.connectionGeneration ?? 0,
      providerMessageId: message.providerMessageId, idFormat: message.idFormat!, sourceDigest,
      ...(message.providerVersion ? { providerVersion: message.providerVersion } : {}), checkedAt,
      bytes: 0, extractionVersion, representation: 'none', completeness: 'unavailable', omissionReasons: boundedReasons.length ? boundedReasons : [reason],
    };
  }

  private async validateCachedMailText(messageId: string): Promise<MailReplyTextCacheResult> {
    await this.load();
    const captured = this.snapshot;
    const saved = captured.selectedMailTexts.find((item) => item.messageId === messageId);
    if (!saved) return { status: 'missing' };
    const message = captured.mailbox.find((item) => item.id === messageId);
    const account = message && captured.accounts.find((item) => item.id === message.accountId);
    if (!message || !account || !account.connected || account.authStatus !== 'connected' || account.provider === 'local' ||
        !account.capabilities?.includes('mail.read') || !account.grantedScopes || !scopeGrantsCapability(account.provider, account.grantedScopes, 'mail.read') ||
        message.providerDeletedAt || message.verifiedIdentityKey !== identityKey(account) || message.connectionGeneration !== account.connectionGeneration ||
        saved.accountId !== account.id || saved.providerMessageId !== message.providerMessageId || saved.idFormat !== message.idFormat ||
        saved.connectionGeneration !== account.connectionGeneration || saved.identityKey !== identityKey(account) || !sameAccountIdentity(saved.identity, account.identity)) {
      if (captured !== this.snapshot) return { status: 'stale' };
      return { status: 'unavailable' };
    }
    let metadata: MailReplySourceResult;
    try { metadata = await this.currentMailReplySource(captured, messageId); }
    catch { return { status: 'unavailable' }; }
    if (captured !== this.snapshot) return { status: 'stale' };
    if (metadata.status !== 'current' || !metadata.source || metadata.source.sourceDigest !== saved.sourceDigest) {
      return { status: metadata.status === 'unavailable' ? 'unavailable' : 'stale' };
    }
    if (!isMailTextFresh(saved) || !isMailTextFresh({ checkedAt: message.observedAt ?? '' })) return { status: 'stale' };
    if (saved.completeness === 'unavailable' || !saved.text || !saved.textDigest) return { status: 'unavailable', snapshot: clone(saved) };
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, saved.text);
    if (captured !== this.snapshot) return { status: 'stale' };
    if (digest.toLowerCase() !== saved.textDigest.toLowerCase() || utf8Bytes(saved.text) !== saved.bytes) return { status: 'unavailable' };
    return { status: 'current', snapshot: clone(saved) };
  }

  async getMailReplyText(messageId: string): Promise<MailReplyTextCacheResult> {
    return this.validateCachedMailText(messageId);
  }

  async loadMailReplyText(input: { messageId: string; sourceDigest: string }): Promise<MailReplyTextLoadResult> {
    await this.load();
    if (!input || typeof input.messageId !== 'string' || !/^[a-f\d]{64}$/i.test(input.sourceDigest)) return { status: 'unavailable' };
    const captured = this.snapshot;
    const original = captured.mailbox.find((item) => item.id === input.messageId);
    const account = original && captured.accounts.find((item) => item.id === original.accountId);
    if (!original || !account) return { status: 'unavailable' };
    if (!account.connected || account.authStatus !== 'connected' || account.provider === 'local' || !account.identity ||
        !account.capabilities?.includes('mail.read') || !account.grantedScopes || !scopeGrantsCapability(account.provider, account.grantedScopes, 'mail.read') ||
        !original.idFormat || original.providerDeletedAt || original.verifiedIdentityKey !== identityKey(account) || original.connectionGeneration !== account.connectionGeneration) return { status: 'unavailable' };
    const before = await this.currentMailReplySource(captured, input.messageId);
    if (captured !== this.snapshot) return { status: 'stale' };
    if (!before.source || before.status === 'unavailable') return { status: 'unavailable' };
    if (before.source.sourceDigest.toLowerCase() !== input.sourceDigest.toLowerCase()) return { status: 'source_changed' };
    if (!this.connector?.readSelectedMessageText) return { status: 'unavailable' };
    const expectedFence = this.selectedMailFence(captured, input.messageId);
    if (!expectedFence) return { status: 'unavailable' };
    const ensureCurrent: RequestGuard = () => {
      if (this.selectedMailFence(this.snapshot, input.messageId) !== expectedFence) throw new Error('Selected message or connection changed during text loading.');
    };
    ensureCurrent();
    let result: SelectedMessageTextResult;
    try {
      result = await this.connector.readSelectedMessageText(clone(account), original.providerMessageId, {
        sizeEstimate: original.sizeEstimate, sizeCheckedAt: original.sizeCheckedAt, guard: ensureCurrent,
      });
    } catch (error) {
      if (this.selectedMailFence(this.snapshot, input.messageId) !== expectedFence) return { status: 'stale' };
      throw error;
    }
    if (this.selectedMailFence(this.snapshot, input.messageId) !== expectedFence) return { status: 'stale' };

    const checkedAt = now();
    let updatedMessage: MailboxSnapshotMessage | undefined;
    let updatedSource: MailReplySourceSnapshot | undefined;
    const returned = result.message;
    if (returned && returned.id === original.providerMessageId && returned.idFormat === original.idFormat && returned.replyMetadataComplete === true) {
      updatedMessage = {
        ...original, providerMessageId: returned.id, idFormat: returned.idFormat,
        threadId: returned.threadId, subject: returned.subject ?? '', from: returned.from, senderEmail: returned.senderEmail,
        receivedAt: returned.receivedAt, snippet: returned.snippet, isRead: returned.isRead,
        replyMetadataComplete: returned.replyMetadataComplete, internetMessageId: returned.internetMessageId,
        providerVersion: returned.providerVersion, replyTo: returned.replyTo, to: returned.to, cc: returned.cc,
        references: returned.references, inReplyTo: returned.inReplyTo, headers: returned.headers,
        sizeEstimate: returned.sizeEstimate ?? original.sizeEstimate, sizeCheckedAt: checkedAt,
        observedAt: checkedAt,
      };
      try {
        updatedSource = await createMailReplySource(this.mailReplySourceFromRow(updatedMessage, account, checkedAt), async (canonical) =>
          Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical, { encoding: Crypto.CryptoEncoding.HEX }));
      } catch { updatedMessage = undefined; }
    }
    if (this.selectedMailFence(this.snapshot, input.messageId) !== expectedFence) return { status: 'stale' };

    let text: string | undefined;
    let textDigest: string | undefined;
    let bytes = 0;
    let representation: SelectedMailTextSnapshot['representation'] = 'none';
    let completeness: SelectedMailTextSnapshot['completeness'] = 'unavailable';
    let extractionVersion: SelectedMailTextSnapshot['extractionVersion'] = 'mail-text-v2';
    const omissionReasons = [...(result.reasons ?? [])].filter((reason) => typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 240).slice(0, 16);
    const receivedVersion: unknown = result.extractionVersion;
    const receivedRepresentation: unknown = result.representation;
    const receivedCompleteness: unknown = result.completeness;
    const recognizedExtractionVersion = receivedVersion === 'mail-text-v1' || receivedVersion === 'mail-text-v2';
    const allowedRepresentation = receivedVersion === 'mail-text-v1'
      ? ['plain', 'snippet', 'none'].includes(receivedRepresentation as string)
      : recognizedExtractionVersion && ['plain', 'converted_html', 'snippet', 'none'].includes(receivedRepresentation as string);
    const validExtractionPair = allowedRepresentation && ['complete_text', 'excerpt'].includes(receivedCompleteness as string) &&
      (receivedCompleteness !== 'complete_text' || receivedRepresentation === 'plain') &&
      (receivedRepresentation !== 'converted_html' || (receivedVersion === 'mail-text-v2' && receivedCompleteness === 'excerpt'));
    const validUnavailablePair = allowedRepresentation && receivedRepresentation === 'none' && receivedCompleteness === 'unavailable' &&
      result.status === 'unavailable' && result.bytes === 0 && result.text === undefined;
    if (result.status === 'available' && updatedMessage && updatedSource && recognizedExtractionVersion && validExtractionPair && typeof result.text === 'string' && receivedRepresentation !== 'none') {
      const rawBytes = utf8Bytes(result.text);
      const normalized = normalizeMailText(result.text);
      bytes = utf8Bytes(normalized);
      if (rawBytes === result.bytes && rawBytes <= MAX_SELECTED_MAIL_TEXT_BYTES && bytes <= MAX_SELECTED_MAIL_TEXT_BYTES) {
        text = normalized;
        textDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, normalized);
        representation = receivedRepresentation as SelectedMailTextSnapshot['representation'];
        completeness = receivedCompleteness as SelectedMailTextSnapshot['completeness'];
        extractionVersion = receivedVersion as SelectedMailTextSnapshot['extractionVersion'];
      } else {
        omissionReasons.push('text_byte_limit_or_length_mismatch');
      }
    } else if (validUnavailablePair && recognizedExtractionVersion) {
      extractionVersion = receivedVersion as SelectedMailTextSnapshot['extractionVersion'];
    } else if (!recognizedExtractionVersion || !validExtractionPair) omissionReasons.push('invalid_extraction_result');
    if (this.selectedMailFence(this.snapshot, input.messageId) !== expectedFence) return { status: 'stale' };
    const sourceForCache = updatedSource ?? before.source;
    const baseMessage = updatedMessage ?? original;
    const bodySnapshot: SelectedMailTextSnapshot = text && textDigest ? {
      version: 1, messageId: original.id, accountId: account.id, identityKey: identityKey(account), identity: clone(account.identity),
      connectionGeneration: account.connectionGeneration ?? 0, providerMessageId: original.providerMessageId, idFormat: original.idFormat,
      sourceDigest: sourceForCache.sourceDigest, ...(baseMessage.providerVersion ? { providerVersion: baseMessage.providerVersion } : {}),
      checkedAt, text, textDigest, bytes, extractionVersion, representation, completeness, omissionReasons,
    } : this.selectedMailTextUnavailable(baseMessage, account, sourceForCache.sourceDigest, omissionReasons[0] ?? 'text_unavailable', checkedAt,
      validUnavailablePair ? extractionVersion : 'mail-text-v2', validUnavailablePair ? omissionReasons : undefined);
    await this.mutate((state) => {
      if (this.selectedMailFence(state, input.messageId) !== expectedFence) throw new Error('Selected message changed while text was being saved.');
      const messageIndex = state.mailbox.findIndex((item) => item.id === input.messageId);
      const selectedIndex = state.selectedMailTexts.findIndex((item) => item.messageId === input.messageId);
      if (updatedMessage) state.mailbox[messageIndex] = updatedMessage;
      if (selectedIndex >= 0) state.selectedMailTexts.splice(selectedIndex, 1);
      state.selectedMailTexts.unshift(bodySnapshot);
      state.selectedMailTexts = state.selectedMailTexts.slice(0, 20);
      if (updatedSource && updatedSource.sourceDigest !== input.sourceDigest) {
        for (const proposal of state.proposals.filter((item) => item.provenance?.version === 2 && item.provenance.source.localMessageId === input.messageId && ['draft', 'approved', 'failed'].includes(item.status))) {
          this.invalidate(proposal); proposal.requiresRebuild = true;
        }
      }
    });
    return {
      status: updatedSource && updatedSource.sourceDigest !== input.sourceDigest ? 'source_changed' : text ? 'current' : 'unavailable',
      snapshot: clone(bodySnapshot),
    };
  }

  private mailReplyGenerationProjection(
    state: AppState,
    messageId: string,
    sourceDigest: string,
    textDigest: string,
    noteId: string | undefined,
    noteRevision: number | undefined,
  ): string | undefined {
    const message = state.mailbox.find((item) => item.id === messageId);
    const account = message && state.accounts.find((item) => item.id === message.accountId);
    const body = state.selectedMailTexts.find((item) => item.messageId === messageId);
    if (!message || !account || !body || !account.connected || account.authStatus !== 'connected' || account.provider === 'local' ||
        !account.capabilities?.includes('mail.read') || !account.grantedScopes || !scopeGrantsCapability(account.provider, account.grantedScopes, 'mail.read') ||
        message.providerDeletedAt || message.verifiedIdentityKey !== identityKey(account) || message.connectionGeneration !== (account.connectionGeneration ?? 0) ||
        body.accountId !== account.id || body.connectionGeneration !== (account.connectionGeneration ?? 0) || body.identityKey !== identityKey(account) ||
        !sameAccountIdentity(body.identity, account.identity) || body.sourceDigest !== sourceDigest || body.textDigest !== textDigest ||
        !body.text || !isMailTextFresh(body) || !isMailTextFresh({ checkedAt: message.observedAt ?? '' })) return undefined;
    const observed = Date.parse(message.observedAt ?? '');
    if (!Number.isFinite(observed) || Date.now() - observed < 0 || Date.now() - observed >= MAIL_TEXT_FRESHNESS_MS) return undefined;
    const note = noteId ? state.notes.find((item) => item.id === noteId) : undefined;
    if (noteId ? !note || note.revision !== noteRevision : noteRevision !== undefined) return undefined;
    const policy = state.documents.filter((doc) => /^memory\/(?:RULES|ROUTINES)\.md$/i.test(doc.path))
      .map((doc) => ({ path: doc.path, revision: doc.revision, content: doc.content }));
    return stableJson({
      fence: this.selectedMailFence(state, messageId), metadata: canonicalMailboxContent(message), observedAt: message.observedAt,
      body: { sourceDigest: body.sourceDigest, textDigest: body.textDigest, text: body.text, checkedAt: body.checkedAt, bytes: body.bytes, extractionVersion: body.extractionVersion, representation: body.representation, completeness: body.completeness, omissionReasons: body.omissionReasons },
      account: { identity: account.identity, generation: account.connectionGeneration ?? 0, tokenRef: account.tokenRef, capabilities: account.capabilities, grantedScopes: account.grantedScopes },
      settings: state.settings, policy, note: note ? { id: note.id, revision: note.revision, transcript: note.transcript, capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: note.captureTimeZone ?? state.settings.timezone } : null,
    });
  }

  async generateMailReplyText(input: MailReplyTextGenerationInput): Promise<MailReplyTextGenerationResult> {
    await this.load();
    if (!input || !Number.isSafeInteger(input.composerRevision) || input.composerRevision < 0 || !['reply', 'reply_all'].includes(input.mode)) throw new Error('Reply composer version or mode is invalid.');
    const validationSnapshot = this.snapshot;
    const source = await this.currentMailReplySource(validationSnapshot, input.messageId);
    if (this.snapshot !== validationSnapshot) return { status: 'stale', requestFingerprint: '', composerRevision: input.composerRevision, fromCache: false };
    if (source.status !== 'current' || !source.source || source.source.sourceDigest !== input.sourceDigest) return { status: source.status === 'stale' ? 'stale' : 'source_changed', requestFingerprint: '', composerRevision: input.composerRevision, fromCache: false };
    const cachedBody = await this.getMailReplyText(input.messageId);
    if (this.snapshot !== validationSnapshot) return { status: 'stale', requestFingerprint: '', composerRevision: input.composerRevision, fromCache: false };
    if (cachedBody.status !== 'current' || !cachedBody.snapshot || cachedBody.snapshot.textDigest !== input.textDigest || cachedBody.snapshot.sourceDigest !== input.sourceDigest) return { status: cachedBody.status === 'stale' ? 'stale' : 'source_changed', requestFingerprint: '', composerRevision: input.composerRevision, fromCache: false };
    const state = validationSnapshot;
    const account = state.accounts.find((item) => item.id === source.source!.accountId);
    if (!account || account.provider === 'local' || !account.connected || account.authStatus !== 'connected' || !account.capabilities?.includes('mail.read') || !account.grantedScopes || !scopeGrantsCapability(account.provider, account.grantedScopes, 'mail.read')) return { status: 'unavailable', requestFingerprint: '', composerRevision: input.composerRevision, fromCache: false };
    if (state.settings.mode !== 'provider') throw new Error('Switch to Provider mode to generate a reply.');
    if (!Array.isArray(input.to) || !Array.isArray(input.cc)) throw new Error('Review the locked recipient list before generating.');
    const reply = {
      mode: input.mode, sourceDigest: source.source.sourceDigest, localMessageId: source.source.localMessageId,
      providerMessageId: source.source.providerMessageId, idFormat: source.source.idFormat,
      internetMessageId: source.source.internetMessageId, sourceSubject: source.source.subject,
      ...(source.source.threadId ? { threadId: source.source.threadId } : {}),
      ...(replyReferences(source.source) ? { references: replyReferences(source.source) } : {}), inReplyTo: source.source.internetMessageId,
    };
    validateReplyBinding({ operation: 'draft', to: input.to, cc: input.cc, bcc: [], subject: source.source.subject, text: 'generation-placeholder', attachments: [], reply }, {
      version: 2, kind: 'mail_reply', sourceDigest: source.source.sourceDigest, source: source.source,
      expiresAt: new Date(Date.parse(source.source.observedAt) + 15 * 60_000).toISOString(),
    });
    const brief = input.brief;
    let noteContext: string | undefined;
    let noteCapture: { capturedAt: string; timeZone: string } | undefined;
    if (input.noteId) {
      const selectedNote = state.notes.find((item) => item.id === input.noteId);
      if (!selectedNote || selectedNote.revision !== input.noteRevision || !selectedNote.transcript.trim()) throw new Error('The selected note changed or has no transcript. Reopen the picker and select it again.');
      this.requireConfirmedCaptureTimeZone(selectedNote);
      noteContext = selectedNote.transcript;
      noteCapture = { capturedAt: selectedNote.capturedAt ?? selectedNote.createdAt, timeZone: selectedNote.captureTimeZone ?? state.settings.timezone };
    } else if (input.noteRevision !== undefined) throw new Error('A note revision was supplied without a selected note.');
    if (utf8Bytes(brief) + utf8Bytes(noteContext ?? '') > 4 * 1024) throw new Error('The reply brief and selected note context exceed 4 KiB combined. Shorten the brief or select a shorter note before generating.');
    const policies = state.documents.filter((doc) => /^memory\/(?:RULES|ROUTINES)\.md$/i.test(doc.path));
    const policyContext = policies.map((doc) => `### ${doc.path} (revision ${doc.revision})\n${doc.content}`).join('\n\n');
    if (utf8Bytes(policyContext) > 4 * 1024) throw new Error('RULES.md and ROUTINES.md exceed the 4 KiB guidance limit. Edit them before generating.');
    const message = state.mailbox.find((item) => item.id === input.messageId);
    if (!message || !cachedBody.snapshot.text) return { status: 'unavailable', requestFingerprint: '', composerRevision: input.composerRevision, fromCache: false };
    const capturedProjection = this.mailReplyGenerationProjection(state, input.messageId, input.sourceDigest, input.textDigest, input.noteId, input.noteRevision);
    if (!capturedProjection) return { status: 'stale', requestFingerprint: '', composerRevision: input.composerRevision, fromCache: false };
    const settingsFingerprint = stableJson(state.settings);
    const requestAsOf = new Date().toISOString();
    const sourceAndText = {
      sourceDigest: input.sourceDigest, textDigest: input.textDigest, mode: input.mode, to: input.to, cc: input.cc, subject: source.source.subject,
      extractionVersion: cachedBody.snapshot.extractionVersion, representation: cachedBody.snapshot.representation,
      completeness: cachedBody.snapshot.completeness, omissionReasons: cachedBody.snapshot.omissionReasons,
      brief, noteId: input.noteId ?? null, noteRevision: input.noteRevision ?? null,
      noteDigest: noteContext === undefined ? null : await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, noteContext),
      noteCapture: noteCapture ?? null, accountIdentity: source.source.identity, connectionGeneration: source.source.connectionGeneration,
      policy: policies.map((doc) => ({ path: doc.path, revision: doc.revision, content: doc.content })),
      settingsFingerprint, queryBucket: Math.floor(Date.parse(requestAsOf) / (15 * 60_000)),
    };
    const requestFingerprint = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, stableJson(sourceAndText));
    const currentProjection = () => this.mailReplyGenerationProjection(this.snapshot, input.messageId, input.sourceDigest, input.textDigest, input.noteId, input.noteRevision);
    const disclosure = {
      bytes: cachedBody.snapshot.bytes, representation: cachedBody.snapshot.representation, completeness: cachedBody.snapshot.completeness,
      omissionReasons: [...cachedBody.snapshot.omissionReasons], briefBytes: utf8Bytes(brief) + utf8Bytes(noteContext ?? ''), policyDocuments: policies.map((doc) => doc.path), requestBytes: 0,
    };
    if (!input.forceRefresh) {
      const saved = this.mailReplyGenerationCache.get(requestFingerprint);
      if (saved && saved.generatedAt && Date.now() - Date.parse(saved.generatedAt) >= 0 && Date.now() - Date.parse(saved.generatedAt) < 15 * 60_000) {
        if (currentProjection() !== capturedProjection) return { status: 'stale', requestFingerprint, composerRevision: input.composerRevision, fromCache: false };
        return { ...clone(saved), composerRevision: input.composerRevision, fromCache: true };
      }
    }
    const inflight = this.mailReplyGenerations.get(requestFingerprint);
    if (inflight) {
      const joined = await inflight.promise;
      if (currentProjection() !== capturedProjection) return { status: 'stale', requestFingerprint, composerRevision: input.composerRevision, fromCache: false };
      return { ...joined, composerRevision: input.composerRevision, fromCache: true };
    }
    if ([...this.mailReplyGenerations.values()].some((item) => item.messageId === input.messageId)) throw new Error('Another Generate request for this message is still running. Wait for it to finish.');
    const capturedSettings = clone(state.settings);
    const generation = (async (): Promise<MailReplyTextGenerationResult> => {
      let generated: Awaited<ReturnType<AzureOpenAIClient['generateReply']>>;
      let reservation: { month: string; day: string; reserve: number } | undefined;
      const assertProjection = (current: AppState = this.snapshot) => {
        if (this.mailReplyGenerationProjection(current, input.messageId, input.sourceDigest, input.textDigest, input.noteId, input.noteRevision) !== capturedProjection) {
          throw new ReplyGenerationPreDispatchError('Selected message, note, settings, or guidance changed before generation. Review the context and try again.');
        }
      };
      try {
        generated = await this.openAiClient.generateReply({
          sourceText: cachedBody.snapshot!.text!, sourceRepresentation: cachedBody.snapshot!.representation,
          sourceCompleteness: cachedBody.snapshot!.completeness, subject: source.source!.subject,
          to: [...input.to], cc: [...input.cc], brief, noteContext, policyContext, asOf: requestAsOf, timeZone: capturedSettings.timezone,
          ...(noteCapture ? { noteCapture } : {}),
        }, capturedSettings, async () => {
          reservation = await this.recordProviderAttempt('model', capturedSettings, (current) => assertProjection(current));
        }, () => assertProjection());
      } catch (error) {
        if (error instanceof ReplyGenerationError && error.usage) await this.settleModelUsage(error.usage, capturedSettings);
        if (error instanceof ReplyGenerationPreDispatchError) {
          if (reservation) await this.rollbackUnsentProviderAttempt(reservation);
          return { status: 'stale', requestFingerprint, composerRevision: input.composerRevision, fromCache: false };
        }
        throw error;
      }
      await this.settleModelUsage(generated, capturedSettings);
      if (currentProjection() !== capturedProjection) {
        return { status: 'stale', requestFingerprint, composerRevision: input.composerRevision, fromCache: false, submittedContext: { ...disclosure, requestBytes: generated.requestBytes } };
      }
      const output: MailReplyTextGenerationResult = {
        status: 'current', text: generated.text, requestFingerprint, composerRevision: input.composerRevision,
        generatedAt: now(), fromCache: false,
        submittedContext: { ...disclosure, requestBytes: generated.requestBytes },
      };
      this.mailReplyGenerationCache.set(requestFingerprint, clone(output));
      while (this.mailReplyGenerationCache.size > 10) this.mailReplyGenerationCache.delete(this.mailReplyGenerationCache.keys().next().value!);
      return output;
    })();
    this.mailReplyGenerations.set(requestFingerprint, { messageId: input.messageId, promise: generation });
    try { return await generation; }
    finally { if (this.mailReplyGenerations.get(requestFingerprint)?.promise === generation) this.mailReplyGenerations.delete(requestFingerprint); }
  }

  private async acquireSyncSlot(): Promise<() => void> {
    if (this.activeSyncCount < 2) { this.activeSyncCount++; return () => {
      const next = this.syncQueue.shift();
      if (next) next(); else this.activeSyncCount--;
    }; }
    await new Promise<void>((resolve) => this.syncQueue.push(resolve));
    return () => {
      const next = this.syncQueue.shift();
      if (next) next(); else this.activeSyncCount--;
    };
  }

  private tryAcquireSyncSlot(): (() => void) | undefined {
    if (this.activeSyncCount >= 2) return undefined;
    this.activeSyncCount++;
    return () => {
      const next = this.syncQueue.shift();
      if (next) next(); else this.activeSyncCount--;
    };
  }

  async refreshMailHead(accountId: string, options: { reason?: 'manual' | 'foreground' } = {}): Promise<MailLaneResult> {
    return this.startMailLane(accountId, 'head', options.reason ?? 'manual');
  }

  async continueMailBackfill(accountId: string): Promise<MailLaneResult> {
    return this.startMailLane(accountId, 'backfill', 'manual');
  }

  refreshForegroundMail(): Promise<ForegroundMailRefreshResult> {
    if (this.foregroundMailJob) return this.foregroundMailJob;
    const job = this.runForegroundMail().finally(() => { if (this.foregroundMailJob === job) this.foregroundMailJob = undefined; });
    this.foregroundMailJob = job;
    return job;
  }

  private async runForegroundMail(): Promise<ForegroundMailRefreshResult> {
    await this.load();
    const eligible = this.snapshot.accounts
      .filter((account) => account.connected && account.authStatus === 'connected' && account.capabilities?.includes('mail.read'))
      .sort((left, right) => (Date.parse(this.snapshot.syncStates[left.id]?.mailHead.lastAttemptAt ?? '') || 0) - (Date.parse(this.snapshot.syncStates[right.id]?.mailHead.lastAttemptAt ?? '') || 0));
    const attempted: string[] = [];
    const skipped: ForegroundMailRefreshResult['skipped'] = [];
    const results: MailLaneResult[] = [];
    const currentTime = Date.now();
    for (const account of eligible) {
      if (this.busySyncAccounts.has(account.id)) { skipped.push({ accountId: account.id, reason: 'another sync lane is active for this account' }); continue; }
      const lastAttempt = Date.parse(this.snapshot.syncStates[account.id]?.mailHead.lastAttemptAt ?? '');
      if (Number.isFinite(lastAttempt) && currentTime - lastAttempt < 15 * 60_000) {
        skipped.push({ accountId: account.id, reason: 'refreshed within the last 15 minutes' }); continue;
      }
      if (attempted.length >= 2) { skipped.push({ accountId: account.id, reason: 'foreground run limit reached' }); continue; }
      const available = this.activeSyncCount < 2;
      if (!available) { skipped.push({ accountId: account.id, reason: 'both sync slots are busy' }); continue; }
      attempted.push(account.id);
      try { results.push(await this.startMailLane(account.id, 'head', 'foreground', true)); }
      catch (error) { skipped.push({ accountId: account.id, reason: error instanceof Error ? error.message : 'mail refresh was skipped' }); }
    }
    return { attempted, skipped, results };
  }

  private startMailLane(accountId: string, lane: 'head' | 'backfill', reason: 'manual' | 'foreground', doNotQueue = false): Promise<MailLaneResult> {
    const key = `${accountId}:${lane}`;
    const sameLane = this.mailLaneJobs.get(key);
    if (sameLane) return sameLane;
    if (this.busySyncAccounts.has(accountId)) return Promise.reject(new Error('Another sync lane is already active for this account.'));
    this.busySyncAccounts.add(accountId);
    const job = this.runMailLane(accountId, lane, reason, doNotQueue)
      .finally(() => { this.mailLaneJobs.delete(key); this.busySyncAccounts.delete(accountId); });
    this.mailLaneJobs.set(key, job);
    return job;
  }

  private async runMailLane(accountId: string, lane: 'head' | 'backfill', reason: 'manual' | 'foreground', doNotQueue: boolean): Promise<MailLaneResult> {
    if (!this.connector) throw new Error('Provider mail sync is not configured.');
    const release = doNotQueue ? this.tryAcquireSyncSlot() : await this.acquireSyncSlot();
    if (!release) throw new Error('Both sync slots are busy.');
    const abortController = new AbortController();
    this.syncAbortControllers.set(accountId, abortController);
    const deadlineTimer = setTimeout(() => abortController.abort(new Error('Mail sync reached its 30 second deadline.')), 30_000);
    let account: Account | undefined;
    let generation = -1;
    let window: MailSyncWindow | undefined;
    let startedAt = now();
    try {
      let requests = 0;
      const started = Date.now();
      const guard = () => {
        if (abortController.signal.aborted) throw new Error('Mail sync was cancelled or reached its 30 second deadline.');
        if (Date.now() - started >= 30_000) throw new Error('Mail sync reached its 30 second deadline.');
        if (++requests > 20) throw new Error('Mail sync reached its 20 request limit.');
      };
      const prepared = await this.mutate((state) => {
        const currentAccount = state.accounts.find((item) => item.id === accountId);
        if (!currentAccount || currentAccount.authStatus !== 'connected' || !currentAccount.connected || !currentAccount.capabilities?.includes('mail.read')) {
          throw new Error('Reconnect this account with mailbox read access before syncing.');
        }
        const currentSync = state.syncStates[accountId] ?? emptySyncState(accountId);
        startedAt = now();
        const rangeThrough = new Date().toISOString();
        const rangeFloor = new Date(Date.parse(rangeThrough) - 14 * 86_400_000).toISOString();
        const backfill = currentSync.mailBackfill;
        const normalizeCoverage = () => {
          const coverage = backfill.coverage;
          if (coverage) {
            const coverageFrom = Date.parse(coverage.from);
            const coverageThrough = Date.parse(coverage.through);
            const floorTime = Date.parse(rangeFloor);
            if (!Number.isFinite(coverageFrom) || !Number.isFinite(coverageThrough) || coverageThrough <= floorTime) {
              backfill.coverage = undefined;
              backfill.olderHistoryNotCheckedBefore = rangeFloor;
            } else if (coverageFrom < floorTime) {
              backfill.coverage = { from: rangeFloor, through: coverage.through };
              backfill.olderHistoryNotCheckedBefore = rangeFloor;
            }
          }
          const needed = Date.parse(backfill.coverageNeededThrough ?? '');
          if (Number.isFinite(needed) && needed > Date.parse(rangeThrough)) backfill.coverageNeededThrough = rangeThrough;
          if (backfill.coverage && backfill.coverageNeededThrough && Date.parse(backfill.coverageNeededThrough) <= Date.parse(backfill.coverage.through)) {
            backfill.coverageNeededThrough = undefined;
          }
        };
        const makeCurrentWindow = () => {
          const descriptor = describeMessageWindowQuery(currentAccount, { timeMin: rangeFloor, timeMax: rangeThrough, pageSize: 5 });
          return { from: descriptor.window.from, through: descriptor.window.to, pageSize: descriptor.pageSize, queryFingerprint: descriptor.queryFingerprint } satisfies MailSyncWindow;
        };
        if (reason === 'foreground') {
          const lastAttempt = Date.parse(currentSync.mailHead.lastAttemptAt ?? '');
          if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 15 * 60_000) {
            throw new Error('This mailbox was refreshed within the last 15 minutes.');
          }
        }
        if (lane === 'head') {
          normalizeCoverage();
          window = makeCurrentWindow();
          currentSync.mailHead = { ...currentSync.mailHead, status: 'syncing', lastAttemptAt: startedAt, window, lastError: undefined };
          if (currentSync.mailBackfill.activeWindow || currentSync.mailBackfill.coverage) {
            currentSync.mailBackfill.coverageNeededThrough = this.maxIso(currentSync.mailBackfill.coverageNeededThrough, window.through);
          }
        } else {
          normalizeCoverage();
          if (backfill.activeWindow) {
            const active = backfill.activeWindow;
            let matchesCapturedQuery = false;
            const activeFrom = Date.parse(active.from);
            const activeThrough = Date.parse(active.through);
            const activeWidth = activeThrough - activeFrom;
            const activeExpired = Number.isFinite(activeThrough) && activeThrough <= Date.parse(rangeFloor);
            const activeOutOfRange = !Number.isFinite(activeFrom) || !Number.isFinite(activeThrough) || activeWidth <= 0 || activeWidth > 14 * 86_400_000;
            if (activeExpired || activeOutOfRange) {
              backfill.activeWindow = undefined;
              backfill.olderHistoryNotCheckedBefore = rangeFloor;
              window = makeCurrentWindow();
            }
            const retiredActiveWindow = !backfill.activeWindow;
            if (!retiredActiveWindow) {
              const validStoredCursor = active.cursor === undefined || typeof active.cursor === 'string' && active.cursor.length > 0 && active.cursor.length <= 8192;
              if (validStoredCursor && typeof active.from === 'string' && typeof active.through === 'string' &&
                  typeof active.queryFingerprint === 'string' && Number.isSafeInteger(active.pageSize)) {
                try {
                  const expected = describeMessageWindowQuery(currentAccount, { timeMin: active.from, timeMax: active.through, pageSize: active.pageSize });
                  matchesCapturedQuery = expected.window.from === active.from && expected.window.to === active.through && expected.pageSize === active.pageSize && expected.queryFingerprint === active.queryFingerprint;
                } catch { /* Malformed persisted windows fail closed and require a fresh explicit backfill. */ }
              }
              if (!matchesCapturedQuery) {
                backfill.activeWindow = undefined;
                backfill.olderHistoryNotCheckedBefore = rangeFloor;
                window = makeCurrentWindow();
              } else {
                window = { ...active };
              }
            }
          }
          if (!window) {
            let from: string;
            let through: string;
            if (backfill.coverage && backfill.coverageNeededThrough && Date.parse(backfill.coverageNeededThrough) > Date.parse(backfill.coverage.through)) {
              from = new Date(Math.max(Date.parse(backfill.coverage.through), Date.parse(rangeFloor))).toISOString();
              const latestAllowed = Math.min(Date.parse(rangeThrough), Date.parse(from) + 14 * 86_400_000);
              through = new Date(Math.min(Date.parse(backfill.coverageNeededThrough), latestAllowed)).toISOString();
            } else {
              from = rangeFloor; through = rangeThrough;
            }
            const descriptor = describeMessageWindowQuery(currentAccount, { timeMin: from, timeMax: through, pageSize: 5 });
            window = { from: descriptor.window.from, through: descriptor.window.to, pageSize: descriptor.pageSize, queryFingerprint: descriptor.queryFingerprint };
          }
          currentSync.mailBackfill = {
            ...currentSync.mailBackfill, status: 'syncing', activeWindow: window,
            lastAttemptAt: startedAt, lastError: undefined,
            ...(currentSync.mailBackfill.coverageNeededThrough ? {} : { coverageNeededThrough: window.through }),
          };
        }
        state.syncStates[accountId] = currentSync;
        account = clone(currentAccount);
        generation = currentAccount.connectionGeneration ?? 0;
        this.syncGeneration.set(accountId, generation);
        return { account, sync: currentSync };
      });
      account = prepared.account;
      const immutableAccount = account;
      const immutableWindow = window!;
      const ensureCurrent = (state: AppState = this.snapshot) => {
        const current = state.accounts.find((item) => item.id === accountId);
        if (abortController.signal.aborted || this.syncGeneration.get(accountId) !== generation || !current || !current.connected || current.authStatus !== 'connected' ||
            current.connectionGeneration !== immutableAccount.connectionGeneration || current.tokenRef !== immutableAccount.tokenRef || !sameAccountIdentity(current.identity, immutableAccount.identity)) {
          throw new Error('Account connection changed during mail sync; stale pages were discarded.');
        }
      };
      const persistPage = async (items: MessageSummary[], cursor: string | undefined, metadata: MessageWindowPageMetadata) => this.mutate((state) => {
        ensureCurrent(state);
        if (metadata.window.from !== immutableWindow.from || metadata.window.to !== immutableWindow.through || metadata.queryFingerprint !== immutableWindow.queryFingerprint) {
          throw new Error('Provider mail page did not match the captured window and identity.');
        }
        const sync = state.syncStates[accountId] ?? emptySyncState(accountId);
        const key = identityKey(immutableAccount);
        const timestamp = now();
        for (const item of items) {
          if (!item.id) continue;
          const identityKeyValue = `${key}:${item.id}`;
          const prior = state.mailbox.find((entry) => entry.accountId === accountId && entry.identityKey === identityKeyValue);
          const value: MailboxSnapshotMessage = {
            id: prior?.id ?? newId(), accountId, providerMessageId: item.id, identityKey: identityKeyValue,
            verifiedIdentityKey: key, connectionGeneration: generation, idFormat: item.idFormat,
            threadId: item.threadId, subject: item.subject, from: item.from, senderEmail: item.senderEmail,
            receivedAt: item.receivedAt, snippet: item.snippet, isRead: item.isRead,
            replyMetadataComplete: item.replyMetadataComplete, internetMessageId: item.internetMessageId,
            providerVersion: item.providerVersion, sizeEstimate: item.sizeEstimate, sizeCheckedAt: item.sizeCheckedAt,
            replyTo: item.replyTo, to: item.to, cc: item.cc,
            references: item.references, inReplyTo: item.inReplyTo, headers: item.headers,
            observedAt: timestamp,
          };
          const changed = !prior || canonicalMailboxContent(prior) !== canonicalMailboxContent(value);
          if (prior) { Object.assign(prior, value); delete prior.providerDeletedAt; } else state.mailbox.push(value);
          if (changed) markAnalysesStale(state, [`mail:${encodeURIComponent(key)}:${encodeURIComponent(item.id)}`]);
        }
        let unavailableCount = 0;
        for (const id of metadata.unavailableIds) {
          if (!id) continue;
          const identityKeyValue = `${key}:${id}`;
          const prior = state.mailbox.find((entry) => entry.accountId === accountId && entry.identityKey === identityKeyValue);
          const deletedAt = prior?.providerDeletedAt ?? timestamp;
          const tombstone: MailboxSnapshotMessage = {
            id: prior?.id ?? newId(), accountId, providerMessageId: id, identityKey: identityKeyValue,
            verifiedIdentityKey: key, connectionGeneration: generation, idFormat: immutableAccount.provider === 'microsoft' ? 'graph-immutable' : 'gmail',
            providerDeletedAt: deletedAt, observedAt: timestamp,
          };
          if (!prior || !prior.providerDeletedAt) markAnalysesStale(state, [`mail:${encodeURIComponent(key)}:${encodeURIComponent(id)}`]);
          if (prior) Object.assign(prior, tombstone); else state.mailbox.push(tombstone);
          unavailableCount++;
        }
        const accountMessages = state.mailbox.filter((entry) => entry.accountId === accountId)
          .sort((left, right) => (right.receivedAt ?? right.observedAt ?? '').localeCompare(left.receivedAt ?? left.observedAt ?? '')).slice(0, 200);
        state.mailbox = [...state.mailbox.filter((entry) => entry.accountId !== accountId), ...accountMessages];
        if (lane === 'head') {
          sync.mailHead.lastPageCheckedAt = timestamp; sync.mailHead.lastPageSucceededAt = timestamp;
          sync.mailHead.window = { ...immutableWindow, cursor };
          sync.mailHead.unavailableCount = (sync.mailHead.unavailableCount ?? 0) + unavailableCount;
        } else {
          sync.mailBackfill.lastPageCheckedAt = timestamp; sync.mailBackfill.lastPageSucceededAt = timestamp;
          sync.mailBackfill.activeWindow = { ...immutableWindow, cursor };
          sync.mailBackfill.unavailableCount = (sync.mailBackfill.unavailableCount ?? 0) + unavailableCount;
        }
        state.syncStates[accountId] = sync;
      });
      const page = await this.connector.syncMessageWindow(immutableAccount, {
        timeMin: immutableWindow.from, timeMax: immutableWindow.through, cursor: immutableWindow.cursor,
        pageSize: immutableWindow.pageSize, guard, signal: abortController.signal,
        onPage: (items, cursor, _pagesRead, metadata) => persistPage(items, cursor, metadata),
      });
      ensureCurrent();
      if (page.window.from !== immutableWindow.from || page.window.to !== immutableWindow.through || page.queryFingerprint !== immutableWindow.queryFingerprint) {
        throw new Error('Provider returned a different mailbox query window.');
      }
      const completedAt = now();
      return await this.mutate((state) => {
        ensureCurrent(state);
        const sync = state.syncStates[accountId] ?? emptySyncState(accountId);
        if (lane === 'head') {
          sync.mailHead.status = page.partial ? 'partial' : 'idle';
          sync.mailHead.window = { ...immutableWindow, cursor: page.nextCursor };
          sync.mailHead.lastPageCheckedAt = completedAt;
          sync.mailHead.lastPageSucceededAt = completedAt;
          sync.mailHead.lastError = undefined;
          if (!page.partial) {
            sync.mailHead.completeWindow = { from: immutableWindow.from, through: immutableWindow.through };
            sync.mailBackfill.coverage = mergeCoverage(sync.mailBackfill.coverage, { from: immutableWindow.from, through: immutableWindow.through });
            if (sync.mailBackfill.coverageNeededThrough && Date.parse(sync.mailBackfill.coverageNeededThrough) <= Date.parse(sync.mailBackfill.coverage?.through ?? '')) {
              sync.mailBackfill.coverageNeededThrough = undefined;
            }
          }
        } else {
          sync.mailBackfill.lastPageCheckedAt = completedAt; sync.mailBackfill.lastPageSucceededAt = completedAt;
          sync.mailBackfill.lastError = undefined;
          if (page.partial) {
            sync.mailBackfill.status = 'partial'; sync.mailBackfill.activeWindow = { ...immutableWindow, cursor: page.nextCursor };
          } else {
            sync.mailBackfill.coverage = mergeCoverage(sync.mailBackfill.coverage, { from: immutableWindow.from, through: immutableWindow.through });
            sync.mailBackfill.activeWindow = undefined; sync.mailBackfill.status = 'idle'; sync.mailBackfill.lastCompletedAt = completedAt;
            if (sync.mailBackfill.coverageNeededThrough && Date.parse(sync.mailBackfill.coverageNeededThrough) <= Date.parse(sync.mailBackfill.coverage?.through ?? '')) {
              sync.mailBackfill.coverageNeededThrough = undefined;
            }
          }
        }
        state.syncStates[accountId] = sync;
        const resultStatus = page.partial ? 'partial' : 'complete';
        return { accountId, lane, status: resultStatus, state: sync } satisfies MailLaneResult;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mail sync failed.';
      const connectionStillCurrent = account && this.snapshot.accounts.some((item) => item.id === accountId && item.connected && item.connectionGeneration === generation && sameAccountIdentity(item.identity, account!.identity));
      if (!connectionStillCurrent) throw error;
      return await this.mutate((state) => {
        const sync = state.syncStates[accountId] ?? emptySyncState(accountId);
        if (lane === 'head') { sync.mailHead.status = 'error'; sync.mailHead.lastError = message; }
        else { sync.mailBackfill.status = 'error'; sync.mailBackfill.lastError = message; }
        state.syncStates[accountId] = sync;
        return { accountId, lane, status: 'error', state: sync, message } satisfies MailLaneResult;
      });
    } finally {
      clearTimeout(deadlineTimer);
      if (this.syncAbortControllers.get(accountId) === abortController) this.syncAbortControllers.delete(accountId);
      release();
    }
  }

  private maxIso(left: string | undefined, right: string): string {
    if (!left || !Number.isFinite(Date.parse(left)) || Date.parse(right) > Date.parse(left)) return right;
    return left;
  }

  private async runSyncAccount(id: string, options: { continue?: boolean }): Promise<AccountSyncState> {
    if (!this.connector) throw new Error('Provider sync is not configured.');
    const release = await this.acquireSyncSlot();
    const abortController = new AbortController();
    this.syncAbortControllers.set(id, abortController);
    const deadlineTimer = setTimeout(() => abortController.abort(new Error('Sync reached its 30 second deadline.')), 30_000);
    try {
      const started = Date.now();
      let requests = 0;
      const guard = () => {
        if (abortController.signal.aborted) throw new Error('Sync was cancelled or reached its 30 second deadline. Continue manually when the account is available.');
        if (Date.now() - started > 30_000) throw new Error('Sync stopped at its 30 second run limit. Continue manually to resume.');
        if (++requests > 20) throw new Error('Sync stopped at its 20 request run limit. Continue manually to resume.');
      };
      const { account, sync } = await this.mutate((state) => {
        const account = state.accounts.find((item) => item.id === id);
        if (!account || account.authStatus !== 'connected' || !account.connected) throw new Error('Reconnect this account before syncing.');
        const sync = state.syncStates[id] ?? emptySyncState(id);
        if (sync.status === 'partial' && !options.continue) throw new Error('This sync is partial. Choose Continue to resume saved cursors.');
        if (options.continue && sync.status !== 'partial') throw new Error('There is no partial sync to continue. Start a fresh sync instead.');
        if (!options.continue) {
          const anchor = new Date().toISOString();
          sync.lastStartedAt = anchor;
          sync.eventsTimeMin = anchor;
          sync.eventsTimeMax = new Date(Date.parse(anchor) + 14 * 24 * 60 * 60 * 1000).toISOString();
          sync.calendarsCursor = undefined; sync.calendarsCompletedAt = undefined; sync.calendarsPartial = false;
          sync.eventCursors = {}; sync.eventsCompletedAt = {};
        }
        sync.status = 'syncing'; sync.lastError = undefined;
        state.syncStates[id] = sync; account.syncStatus = 'idle';
        return { account, sync };
      });
      const generation = this.syncGeneration.get(id) ?? account.connectionGeneration ?? 0;
      this.syncGeneration.set(id, generation);
      const tokenRef = account.tokenRef;
      const canCalendar = account.capabilities?.includes('calendar.read') === true;
      const currentConnection = (state: AppState = this.snapshot) => {
        const current = state.accounts.find((item) => item.id === id);
        if (abortController.signal.aborted || this.syncGeneration.get(id) !== generation || !current || !current.connected ||
            current.authStatus !== 'connected' || current.tokenRef !== tokenRef || current.connectionGeneration !== account.connectionGeneration ||
            !sameAccountIdentity(current.identity, account.identity)) throw new Error('Account connection changed while syncing; stale pages were discarded.');
      };
      const persist = <T,>(operation: (state: AppState) => T): Promise<T> => this.mutate((state) => {
        currentConnection(state);
        return operation(state);
      });
      const completedThisRun = (at?: string) => Boolean(at && sync.lastStartedAt && Date.parse(at) >= Date.parse(sync.lastStartedAt));
      try {
        if (!canCalendar) throw new Error(account.capabilities?.includes('mail.read')
          ? 'This account has mailbox access. Use Refresh inbox or Continue backfill; this control only syncs calendars.'
          : 'This account has no calendar read permission to sync.');
        currentConnection();
        const calendarsComplete = !canCalendar || completedThisRun(sync.calendarsCompletedAt);
        const calendarPage: SyncPage<CalendarSummary> = canCalendar && !calendarsComplete ? await this.connector.listCalendars(account, {
          cursor: sync.calendarsCursor, guard, signal: abortController.signal,
          onPage: async (items, cursor) => persist((state) => {
            for (const item of items) {
              let calendar = state.calendars.find((entry) => entry.accountId === id && entry.providerId === item.id);
              const localId = calendar?.id ?? `${id}:${item.id}`;
              if (!calendar) { calendar = { id: localId, providerId: item.id, accountId: id, name: item.name, writable: item.writable && account.capabilities?.includes('calendar.write') === true, connected: true }; state.calendars.push(calendar); }
              else { calendar.name = item.name; calendar.connected = true; calendar.writable = item.writable && account.capabilities?.includes('calendar.write') === true; }
              markAnalysesStale(state, [`calendar:${encodeURIComponent(identityKey(account))}:${encodeURIComponent(item.id)}`]);
            }
            const current = state.syncStates[id] ?? emptySyncState(id); current.calendarsCursor = cursor; current.calendarsPartial = Boolean(cursor); state.syncStates[id] = current;
          }),
        }) : { items: [], pagesRead: 0, partial: sync.calendarsPartial, nextCursor: sync.calendarsCursor };
        if (canCalendar && !calendarsComplete) await persist((state) => {
          const current = state.syncStates[id] ?? emptySyncState(id); current.calendarsCursor = calendarPage.nextCursor; current.calendarsPartial = calendarPage.partial;
          if (!calendarPage.partial) { current.calendarsCursor = undefined; current.calendarsCompletedAt = now(); }
          state.syncStates[id] = current;
        });
        const calendars = canCalendar ? this.snapshot.calendars.filter((calendar) => calendar.accountId === id && calendar.providerId) : [];
        let anyEventPartial = false;
        for (const calendar of calendars) {
          if (completedThisRun(sync.eventsCompletedAt[calendar.id])) continue;
          currentConnection();
          const eventPage = await this.connector.readCalendarEvents(account, calendar.providerId!, {
            cursor: sync.eventCursors[calendar.id] || undefined, timeMin: sync.eventsTimeMin ?? now(), timeMax: sync.eventsTimeMax ?? new Date(Date.now() + 14 * 86400000).toISOString(), guard, signal: abortController.signal,
            onPage: (items, cursor, pagesRead) => persist((state) => {
              for (const item of items) {
                if (!item.id) continue;
                let event = state.calendarEvents.find((entry) => entry.calendarId === calendar.id && entry.providerEventId === item.id);
                const mapped: CalendarEventSnapshot = {
                  id: event?.id ?? newId(), accountId: id, calendarId: calendar.id, providerEventId: item.id,
                  subject: item.subject, start: item.start, end: item.end, timeZone: item.timeZone,
                  startUtcCertified: item.startUtcCertified === true, endUtcCertified: item.endUtcCertified === true,
                  observedAt: now(), verifiedIdentityKey: identityKey(account), connectionGeneration: account.connectionGeneration,
                };
                const changed = !event || stableJson([event.subject, event.start, event.end, event.timeZone, event.startUtcCertified, event.endUtcCertified]) !==
                  stableJson([mapped.subject, mapped.start, mapped.end, mapped.timeZone, mapped.startUtcCertified, mapped.endUtcCertified]);
                if (event) Object.assign(event, mapped); else state.calendarEvents.push(mapped);
                if (changed) markAnalysesStale(state, [`calendar-event:${encodeURIComponent(identityKey(account))}:${encodeURIComponent(calendar.providerId!)}:${encodeURIComponent(item.id)}`]);
              }
              const current = state.syncStates[id] ?? emptySyncState(id); current.eventCursors[calendar.id] = cursor ?? '';
              if (!cursor) { delete current.eventCursors[calendar.id]; current.eventsCompletedAt[calendar.id] = now(); }
              state.syncStates[id] = current;
            }),
          });
          anyEventPartial ||= eventPage.partial;
          if (eventPage.partial) break;
        }
        const complete = !calendarPage.partial && !anyEventPartial;
        currentConnection();
        return persist((state) => {
          const current = state.syncStates[id] ?? emptySyncState(id);
          current.status = complete ? 'idle' : 'partial';
          current.lastSuccessAt = complete ? now() : current.lastSuccessAt;
          current.lastError = undefined;
          const owner = state.accounts.find((item) => item.id === id);
          if (owner) { owner.syncStatus = complete ? 'idle' : 'partial'; owner.lastSyncedAt = complete ? current.lastSuccessAt : owner.lastSyncedAt; }
          state.syncStates[id] = current; return current;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sync failed.';
        if (this.syncGeneration.get(id) !== generation || abortController.signal.aborted && !this.snapshot.accounts.some((item) => item.id === id && item.connected && item.connectionGeneration === account.connectionGeneration)) throw error;
        return persist((state) => {
          const current = state.syncStates[id] ?? emptySyncState(id); current.status = 'partial'; current.lastError = message;
          if (canCalendar && !completedThisRun(current.calendarsCompletedAt)) current.calendarsPartial = true;
          const account = state.accounts.find((item) => item.id === id); if (account) account.syncStatus = current.status === 'partial' ? 'partial' : 'error';
          state.syncStates[id] = current; return current;
        });
      }
    } finally {
      clearTimeout(deadlineTimer);
      if (this.syncAbortControllers.get(id) === abortController) this.syncAbortControllers.delete(id);
      release();
    }
  }

  async saveCalendar(config: CalendarConfig): Promise<Calendar> {
    return this.mutate((state) => {
      const owner = state.accounts.find((item) => item.id === config.accountId);
      if (!owner) throw new Error('Select an account that already exists.');
      const id = config.id ?? newId();
      if (state.proposals.some((item) => item.calendarId === id && ['dispatching', 'unknown'].includes(item.status))) throw new Error('This calendar is part of an action whose result must be checked before changing it.');
      const calendar: Calendar = { id, accountId: owner.id, name: config.name.trim(), writable: false, connected: false };
      const prior = state.calendars.find((item) => item.id === id);
      if (prior) Object.assign(prior, calendar); else state.calendars.push(calendar);
      for (const proposal of state.proposals.filter((item) => item.calendarId === id && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      addActivity(state, 'local_action', `${calendar.name || 'Calendar'} saved as an unconnected calendar configuration.`);
      return calendar;
    });
  }

  async exportData(): Promise<string> {
    const backup = createPortableBackup(this.snapshot, { exportId: newId(), exportedAt: now() });
    const serialized = JSON.stringify(backup);
    if (new TextEncoder().encode(serialized).length > BACKUP_LIMITS.maxBytes) throw new Error('The portable backup exceeds the supported file size. No data was exported.');
    return serialized;
  }

  async prepareBackupImport(input: string | Uint8Array): Promise<BackupImportPreview> {
    if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new Error('Choose a supported backup file.');
    if ((typeof input === 'string' && input.length > BACKUP_LIMITS.maxBytes) ||
        (input instanceof Uint8Array && input.byteLength > BACKUP_LIMITS.maxBytes)) {
      throw new Error('Backup file exceeds the allowed size.');
    }
    const frozenInput: string | Uint8Array = typeof input === 'string' ? input : new Uint8Array(input);
    const parsed = parsePortableBackup(frozenInput);
    const fileText = typeof frozenInput === 'string' ? frozenInput : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(frozenInput);
    await this.load();
    const capturedSnapshot = this.snapshot;
    const capturedStateJson = stableJson(capturedSnapshot);
    const backup = parsed.backup;
    const summary = summarizePortableBackup(backup, capturedSnapshot.documents);
    const hash = async (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, { encoding: Crypto.CryptoEncoding.HEX });
    const fileHash = await hash(fileText);
    const contentHash = await hash(canonicalPortableContent(backup));
    const usedIds = stateEntityIds(capturedSnapshot);
    const allocateId = () => allocateFreshId(usedIds);
    const existingArchive = capturedSnapshot.importedBackups.find((item) => item.contentHash === contentHash);
    const noteIds = Object.create(null) as Record<string, string>;
    const missingNotes = backup.notes.filter((item) => {
      const link = existingArchive?.noteLinks.find((candidate) => candidate.sourceId === item.sourceId);
      const note = link && capturedSnapshot.notes.find((candidate) => candidate.id === link.noteId);
      const present = Boolean(note && note.importOrigin?.kind === 'backup_import' &&
        note.importOrigin.archiveId === existingArchive?.id && note.importOrigin.sourceNoteId === item.sourceId);
      if (present) noteIds[item.sourceId] = link!.noteId;
      else noteIds[item.sourceId] = allocateId();
      return !present;
    });
    const missingNoteSourceIds = new Set(missingNotes.map((item) => item.sourceId));
    const taskIds = Object.create(null) as Record<string, string>;
    const missingTasks = backup.tasks.filter((item) => {
      const link = existingArchive?.taskLinks.find((candidate) => candidate.sourceId === item.sourceId);
      const task = link && capturedSnapshot.tasks.find((candidate) => candidate.id === link.taskId);
      const present = Boolean(task && task.importOrigin?.kind === 'backup_import' &&
        task.importOrigin.archiveId === existingArchive?.id && task.importOrigin.sourceTaskId === item.sourceId);
      if (present) taskIds[item.sourceId] = link!.taskId;
      else taskIds[item.sourceId] = allocateId();
      return !present;
    });
    const taskLinkRepairs = Object.create(null) as Record<string, { sourceNoteId: string; oldNoteId?: string }>;
    const taskLinkRepairLabels: string[] = [];
    if (existingArchive) for (const item of backup.tasks) {
      if (!item.sourceNoteId || !missingNoteSourceIds.has(item.sourceNoteId) || taskIds[item.sourceId] !== existingArchive.taskLinks.find((link) => link.sourceId === item.sourceId)?.taskId) continue;
      const task = capturedSnapshot.tasks.find((candidate) => candidate.id === taskIds[item.sourceId]);
      if (!task || task.importOrigin?.kind !== 'backup_import' || task.importOrigin.archiveId !== existingArchive.id || task.importOrigin.sourceTaskId !== item.sourceId) continue;
      const oldNoteLink = existingArchive.noteLinks.find((link) => link.sourceId === item.sourceNoteId);
      const oldNoteStillExists = oldNoteLink && capturedSnapshot.notes.some((note) => note.id === oldNoteLink.noteId);
      if (task.sourceNoteId === undefined || (oldNoteLink && task.sourceNoteId === oldNoteLink.noteId && !oldNoteStillExists)) {
        taskLinkRepairs[item.sourceId] = { sourceNoteId: item.sourceNoteId, ...(oldNoteLink ? { oldNoteId: oldNoteLink.noteId } : {}) };
        taskLinkRepairLabels.push(item.title);
      }
    }
    const archiveId = existingArchive?.id ?? allocateId();
    const documentIds = existingArchive ? {} : Object.fromEntries([
      ...backup.documents.map((item) => [`document:${item.path}`, allocateId()] as const),
      ...backup.archivedDocuments.map((item) => [`archived:${item.sourceId}`, allocateId()] as const),
    ]);
    const historyIds = Object.create(null) as Record<string, string>;
    if (!existingArchive) for (const item of backup.history) historyIds[item.sourceId] = allocateId();
    const sessionId = allocateId();
    const planFields = {
      fileHash, contentHash, sourceFormat: parsed.migratedFromV1 ? 'voice-assistant-export-v1' : backup.format,
      archiveId, existingArchiveId: existingArchive?.id, noteIds, taskIds, taskLinkRepairs, documentIds, historyIds, capturedStateJson,
      missingNoteSourceIds: missingNotes.map((item) => item.sourceId), missingTaskSourceIds: missingTasks.map((item) => item.sourceId),
      documentConflicts: summary.documentConflicts,
    };
    const planHash = await hash(stableJson(planFields));
    if (this.snapshot !== capturedSnapshot || stableJson(this.snapshot) !== capturedStateJson) {
      throw new Error('App data changed while the backup preview was being prepared. Open a fresh preview.');
    }
    const preparedAtMs = Date.now();
    for (const [id, session] of this.backupImportSessions) {
      if (preparedAtMs < session.preparedAtMs || preparedAtMs - session.preparedAtMs > 15 * 60_000) this.backupImportSessions.delete(id);
    }
    while (this.backupImportSessions.size >= 2) {
      const oldest = this.backupImportSessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.backupImportSessions.delete(oldest);
    }
    const preview: BackupImportPreview = {
      sessionId, fileHash, contentHash, planHash,
      sourceFormat: parsed.migratedFromV1 ? 'voice-assistant-export-v1' : backup.format,
      exportedAt: backup.exportedAt, ...summary, warnings: [...parsed.warnings], ignoredFieldCount: parsed.ignoredFieldCount,
      missingNoteCount: missingNotes.length, missingTaskCount: missingTasks.length,
      missingNoteLabels: missingNotes.map((item) => item.title || 'Untitled note'),
      missingTaskLabels: missingTasks.map((item) => item.title || 'Untitled task'),
      taskLinkRepairCount: taskLinkRepairLabels.length, taskLinkRepairLabels,
      alreadyImported: Boolean(existingArchive),
    };
    this.backupImportSessions.set(sessionId, {
      preview, backup, capturedState: capturedSnapshot, capturedStateJson, preparedAtMs, archiveId,
      existingArchiveId: existingArchive?.id, noteIds, taskIds, taskLinkRepairs,
      missingNoteSourceIds: missingNotes.map((item) => item.sourceId), missingTaskSourceIds: missingTasks.map((item) => item.sourceId),
      documentIds, historyIds,
    });
    return clone(preview);
  }

  async applyBackupImport(input: { sessionId: string; planHash: string }): Promise<ImportedBackupArchive> {
    await this.load();
    if (!input || typeof input.sessionId !== 'string' || !/^[a-f\d]{64}$/i.test(input.planHash)) throw new Error('Backup preview confirmation is invalid.');
    const session = this.backupImportSessions.get(input.sessionId);
    if (!session || session.preview.planHash !== input.planHash) throw new Error('Backup preview is missing or no longer matches. Prepare a new preview.');
    const time = Date.now();
    if (time < session.preparedAtMs || time - session.preparedAtMs >= 15 * 60_000) throw new Error('Backup preview expired. Prepare a new preview.');
    const archive = await this.mutateIfChanged((state) => {
      const applyTime = Date.now();
      if (applyTime < session.preparedAtMs || applyTime - session.preparedAtMs >= 15 * 60_000) throw new Error('Backup preview expired. Prepare a new preview.');
      const alreadyImported = state.importedBackups.find((item) => item.contentHash === session.preview.contentHash);
      // A second click on the same plan (or an equivalent preview) is an idempotent no-op
      // once every linked item is again present with its matching import origin.
      const complete = Boolean(alreadyImported && session.backup.notes.every((item) => {
        const link = alreadyImported.noteLinks.find((candidate) => candidate.sourceId === item.sourceId);
        const note = link && state.notes.find((candidate) => candidate.id === link.noteId);
        return Boolean(note && note.importOrigin?.kind === 'backup_import' && note.importOrigin.archiveId === alreadyImported.id && note.importOrigin.sourceNoteId === item.sourceId);
      }) && session.backup.tasks.every((item) => {
        const link = alreadyImported.taskLinks.find((candidate) => candidate.sourceId === item.sourceId);
        const task = link && state.tasks.find((candidate) => candidate.id === link.taskId);
        return Boolean(task && task.importOrigin?.kind === 'backup_import' && task.importOrigin.archiveId === alreadyImported.id && task.importOrigin.sourceTaskId === item.sourceId);
      }));
      if (complete) return { changed: false, result: alreadyImported! };
      if (stableJson(this.publicState(state)) !== session.capturedStateJson) throw new Error('App data changed after the backup preview. Prepare a new preview before restoring.');
      if (this.snapshot !== session.capturedState) throw new Error('App data changed after the backup preview. Prepare a new preview before restoring.');
      if (!alreadyImported && state.importedBackups.length + this.backupImportQuarantine.length >= 50) throw new Error('The imported archive limit is 50. Export your existing backups or resolve the backup recovery issue before importing another.');
      const backup = session.backup;
      const currentArchive = alreadyImported;
      const noteLinks = currentArchive ? [...currentArchive.noteLinks] : [];
      for (const item of backup.notes) if (!noteLinks.some((link) => link.sourceId === item.sourceId)) noteLinks.push({ sourceId: item.sourceId, noteId: session.noteIds[item.sourceId] });
      for (const item of backup.notes) {
        const existingLink = noteLinks.find((link) => link.sourceId === item.sourceId)!;
        if (session.missingNoteSourceIds.includes(item.sourceId)) existingLink.noteId = session.noteIds[item.sourceId];
      }
      const noteIdMap = new Map(noteLinks.map((link) => [link.sourceId, link.noteId]));
      const notes: Note[] = backup.notes.filter((item) => session.missingNoteSourceIds.includes(item.sourceId)).map((item) => {
        const originalTimeZoneUnknown = item.originalTimeZoneUnknown === true || !item.captureTimeZone;
        return {
          id: session.noteIds[item.sourceId], title: item.title, transcript: item.transcript, durationSeconds: item.durationSeconds,
          createdAt: item.createdAt, capturedAt: item.capturedAt ?? item.createdAt,
          captureTimeZone: item.captureTimeZone ?? 'UTC', status: 'recorded', revision: 1,
          importOrigin: { kind: 'backup_import', archiveId: session.archiveId, sourceNoteId: item.sourceId,
            audioMissing: item.audioMissing === true, ...(originalTimeZoneUnknown ? { originalTimeZoneUnknown: true as const } : {}) },
        };
      });
      const taskLinks = currentArchive ? [...currentArchive.taskLinks] : [];
      for (const item of backup.tasks) if (!taskLinks.some((link) => link.sourceId === item.sourceId)) taskLinks.push({ sourceId: item.sourceId, taskId: session.taskIds[item.sourceId] });
      for (const item of backup.tasks) if (session.missingTaskSourceIds.includes(item.sourceId)) {
        taskLinks.find((link) => link.sourceId === item.sourceId)!.taskId = session.taskIds[item.sourceId];
      }
      const tasks: LocalTask[] = backup.tasks.filter((item) => session.missingTaskSourceIds.includes(item.sourceId)).map((item) => ({
        id: session.taskIds[item.sourceId], title: item.title, body: item.body, status: item.status, createdAt: item.createdAt,
        ...(item.completedAt ? { completedAt: item.completedAt } : {}), ...(item.dueAt ? { dueAt: item.dueAt } : {}),
          ...(item.sourceNoteId && noteIdMap.has(item.sourceNoteId) ? { sourceNoteId: noteIdMap.get(item.sourceNoteId)! } : {}),
        importOrigin: { kind: 'backup_import', archiveId: session.archiveId, sourceTaskId: item.sourceId,
          ...(item.unresolvedSourceNoteId || item.sourceNoteId ? { originalSourceNoteId: item.unresolvedSourceNoteId ?? item.sourceNoteId } : {}) },
      }));
      const documents = [
        ...backup.documents.map((item) => ({ ...item, id: session.documentIds[`document:${item.path}`] })),
        ...backup.archivedDocuments.map((item) => ({ path: item.path, content: item.content, revision: item.revision, updatedAt: item.updatedAt, id: session.documentIds[`archived:${item.sourceId}`] })),
      ];
      const history: ImportedBackupArchive['history'] = backup.history.map((item) => ({
        ...item, id: session.historyIds[item.sourceId], ...(item.sourceNoteId && noteIdMap.has(item.sourceNoteId) ? { localNoteId: noteIdMap.get(item.sourceNoteId)! } : {}),
      }));
      const created: ImportedBackupArchive = currentArchive ?? {
        id: session.archiveId, contentHash: session.preview.contentHash, fileHash: session.preview.fileHash,
        sourceFormat: session.preview.sourceFormat, exportedAt: backup.exportedAt, importedAt: now(),
        noteLinks: [], taskLinks: [], documents: [], history: [],
      };
      if (currentArchive) {
        currentArchive.noteLinks = noteLinks;
        currentArchive.taskLinks = taskLinks;
      } else {
        created.noteLinks = noteLinks;
        created.taskLinks = taskLinks;
        created.documents = documents;
        created.history = history;
      }
      const restoredNoteIds = new Set(notes.map((note) => note.id));
      for (const [sourceTaskId, repair] of Object.entries(session.taskLinkRepairs)) {
        const item = backup.tasks.find((candidate) => candidate.sourceId === sourceTaskId);
        const taskLink = taskLinks.find((candidate) => candidate.sourceId === sourceTaskId);
        const task = taskLink && state.tasks.find((candidate) => candidate.id === taskLink.taskId);
        const restoredNoteId = noteIdMap.get(repair.sourceNoteId);
        if (!item || item.sourceNoteId !== repair.sourceNoteId || !task || task.importOrigin?.kind !== 'backup_import' ||
            task.importOrigin.archiveId !== created.id || task.importOrigin.sourceTaskId !== sourceTaskId || !restoredNoteId || !restoredNoteIds.has(restoredNoteId)) continue;
        const repairStillSafe = task.sourceNoteId === undefined || (repair.oldNoteId === task.sourceNoteId && !state.notes.some((note) => note.id === repair.oldNoteId));
        if (repairStillSafe) task.sourceNoteId = restoredNoteId;
      }
      state.notes.unshift(...notes);
      state.tasks.unshift(...tasks);
      if (!currentArchive) state.importedBackups.push(created);
      if (notes.length || tasks.length || Object.keys(session.taskLinkRepairs).length) {
        addActivity(state, 'local_action', `Restored ${notes.length} note${notes.length === 1 ? '' : 's'} and ${tasks.length} task${tasks.length === 1 ? '' : 's'} from an imported backup.`);
      }
      assertPortableBackupFits(state);
      return { changed: true, result: created };
    });
    session.appliedArchiveId = archive.id;
    return archive;
  }

  async activateImportedDocument(input: {
    archiveId: string; documentId: string; destinationPath: string; contentDigest: string;
    expectedCurrentRevision?: number; replaceConfirmed: boolean;
  }): Promise<{ status: 'activated' | 'unchanged'; document: ContextDocument; mirrorPending: boolean }> {
    await this.load();
    if (!input || typeof input.archiveId !== 'string' || typeof input.documentId !== 'string' ||
        typeof input.replaceConfirmed !== 'boolean' || !/^[a-f\d]{64}$/i.test(input.contentDigest) ||
        (input.expectedCurrentRevision !== undefined && (!Number.isSafeInteger(input.expectedCurrentRevision) || input.expectedCurrentRevision < 1))) {
      throw new Error('Document activation confirmation is invalid.');
    }
    const destinationPath = validatePortableDocumentPath(input.destinationPath);
    const captured = this.snapshot;
    const archive = captured.importedBackups.find((item) => item.id === input.archiveId);
    const archived = archive?.documents.find((item) => item.id === input.documentId);
    if (!archive || !archived) throw new Error('The archived document is no longer available.');
    const contentDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, archived.content, { encoding: Crypto.CryptoEncoding.HEX });
    if (contentDigest.toLowerCase() !== input.contentDigest.toLowerCase()) throw new Error('The archived document content changed. Reopen the preview before activating it.');
    if (captured !== this.snapshot) throw new Error('App data changed during document verification. Reopen the archive and try again.');
    const result = await this.mutate((state) => {
      if (this.snapshot !== captured || stableJson(this.publicState(state)) !== stableJson(captured)) throw new Error('App data changed before document activation. Reopen the archive and try again.');
      const currentArchive = state.importedBackups.find((item) => item.id === input.archiveId);
      const current = currentArchive?.documents.find((item) => item.id === input.documentId);
      if (!currentArchive || !current || current.content !== archived.content || current.path !== archived.path) throw new Error('The archived document changed before activation.');
      const existing = state.documents.find((item) => item.path.toLocaleLowerCase('en-US') === destinationPath.toLocaleLowerCase('en-US'));
      if (existing && existing.path !== destinationPath) throw new Error('A case-colliding document path already exists. Choose its exact path or a different destination.');
      if (existing?.content === current.content) {
        if (input.expectedCurrentRevision !== undefined && input.expectedCurrentRevision !== existing.revision) {
          throw new Error('The destination document changed since the preview. Reopen the archive and try again.');
        }
        if (input.expectedCurrentRevision === undefined && current.activatedPath !== destinationPath) {
          throw new Error('Review the existing destination revision before confirming activation.');
        }
        current.activatedPath = destinationPath;
        current.activatedAt ??= now();
        return { status: 'unchanged' as const, document: existing };
      }
      if (existing) {
        if (!input.replaceConfirmed || input.expectedCurrentRevision !== existing.revision) throw new Error('This document changed or needs explicit replacement confirmation. Review the current content and try again.');
        if (currentArchive.documents.length >= 1000) throw new Error('The archive has reached its document preservation limit. Export it before replacing this document.');
        currentArchive.documents.push({ id: allocateFreshId(stateEntityIds(state)), path: existing.path, content: existing.content, revision: existing.revision, updatedAt: existing.updatedAt });
      } else if (input.expectedCurrentRevision !== undefined) {
        throw new Error('The destination document no longer exists at the revision shown. Reopen the archive and try again.');
      }
      const document: ContextDocument = { path: destinationPath, content: current.content, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
      if (existing) Object.assign(existing, document); else state.documents.unshift(document);
      current.activatedPath = destinationPath;
      current.activatedAt = now();
      markAnalysesStale(state, [`doc:${destinationPath}`]);
      assertPortableBackupFits(state);
      return { status: 'activated' as const, document };
    });
    await this.mirrorDocument(result.document);
    return { ...result, mirrorPending: this.mirrorDirty.has(result.document.path) };
  }

  async deleteNote(id: string): Promise<void> {
    const audioUri = this.snapshot.notes.find((note) => note.id === id)?.audioUri;
    const reminderIds = this.snapshot.proposals.filter((proposal) => proposal.noteId === id && proposal.kind === 'reminder')
      .flatMap((proposal) => [...new Set([proposal.revision, proposal.notificationRevision].filter((revision): revision is number => typeof revision === 'number'))]
        .map((revision) => ({ id: proposal.id, revision })));
    await this.mutate((state) => {
      if (state.proposals.some((proposal) => proposal.noteId === id && ['dispatching', 'unknown'].includes(proposal.status))) throw new Error('Wait for the in-progress action result before deleting this note.');
      state.notes = state.notes.filter((item) => item.id !== id);
      state.proposals = state.proposals.filter((item) => item.noteId !== id);
      state.activity = state.activity.filter((item) => item.noteId !== id);
    });
    await Promise.all(reminderIds.map((proposal) => cancelReminderNotification(proposal)));
    if (audioUri) {
      try { await removeAudio(audioUri); }
      catch { /* Note deletion is canonical; a broken or missing clip is harmless. */ }
    }
  }
}

type ProposalStatusOutcome = { status: 'executed' | 'simulated' | 'failed' | 'accepted' | 'unknown'; message: string; notificationId?: string; operation?: ApprovedDispatch['operation']; remoteId?: string; replyDraftCheck?: 'matches_approved' | 'differs' | 'unverified'; dispatchOutcome?: Exclude<DispatchOutcome, 'pending'>; rejectionCode?: 'provider_rejected' | 'precondition_failed' };

const googleClientId = (Platform.OS === 'web' ? process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID : process.env.EXPO_PUBLIC_GOOGLE_NATIVE_CLIENT_ID)?.trim() ?? '';
const microsoftClientId = (Platform.OS === 'web' ? process.env.EXPO_PUBLIC_MICROSOFT_WEB_CLIENT_ID : process.env.EXPO_PUBLIC_MICROSOFT_NATIVE_CLIENT_ID)?.trim() ?? '';
const microsoftAuthority = process.env.EXPO_PUBLIC_MICROSOFT_AUTHORITY?.trim() || 'common';
let defaultConnector: ConnectorClient | undefined;
let defaultController: AppControllerImpl | undefined;
const defaultIntegration: ControllerIntegrationDependencies = {
  tokenStore: oauthTokenStore,
  deleteToken: deleteOAuthToken,
  clientIds: { google: googleClientId, microsoft: microsoftClientId },
  connectorFactory: (tokenStore, onAuthStatus) => {
    defaultConnector = new ConnectorClient({ tokenStore, googleClientId, microsoftClientId, microsoftAuthority, onAuthStatus,
      isConnectionCurrent: (account) => {
        const current = defaultController?.getSnapshot().accounts.find((item) => item.id === account.id);
        return Boolean(current && current.connected && current.authStatus === 'connected' && current.tokenRef === account.tokenRef &&
          current.connectionGeneration === account.connectionGeneration && sameAccountIdentity(current.identity, account.identity));
      },
    });
    return defaultConnector;
  },
  verifyOAuthResult: async (result, stored) => {
    if (!defaultConnector || !await defaultConnector.verifyOAuthIdentity(result, stored)) return false;
    const known: AccountCapability[] = ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'];
    if (result.requestedCapabilities.some((item) => !known.includes(item)) || result.capabilities.some((item) => !result.requestedCapabilities.includes(item))) return false;
    if (result.requestedCapabilities.includes('calendar.write') && !result.requestedCapabilities.includes('calendar.read')) return false;
    return result.capabilities.every((item) => scopeGrantsCapability(result.provider, result.grantedScopes, item));
  },
};

defaultController = new AppControllerImpl(undefined, {}, defaultIntegration);
export const controller: AppController = defaultController;
export default controller;
