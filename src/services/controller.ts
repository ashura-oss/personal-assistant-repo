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
  DeviceCalendarAccessState, StartupRecoveryStatus,
  SavePersonInput, SaveProjectInput, KnowledgeItemCommand, SaveKnowledgeFactInput, SaveKnowledgeContactInput,
  SaveKnowledgeSourceLinkInput, SaveKnowledgeMemberInput, ReviewKnowledgeSuggestionInput, EditKnowledgeSuggestionInput, KnowledgeSelection,
} from '../core';
import { createPlatformStateStore, stateStore } from '../storage/platformStorage';
import type { StateStore } from '../storage/contracts';
import { STARTUP_RECOVERY_SESSION_MS, validateRecoveryId, validateRecoveryIso, validateRecoveryReceipt, validateReplacementSnapshot, type StartupRecoveryInspection, type StartupRecoveryPlan, type StartupRecoveryReceipt, type StartupRecoveryCommitInput } from '../storage/startupRecovery';
import { writePrivateDocument } from '../storage/documents';
import { AzureOpenAIClient, AzureSpeechClient, ReplyGenerationError, ReplyGenerationPreDispatchError, validateAzureEndpoint, type DraftAnalysis, type ReplyGenerationUsage } from './azure';
import {
  createNotificationBackend, isMatchingPending, isOwnedLegacyReminderCancellation, NotificationBackendError,
} from './notificationBackend';
import {
  emptyReminderState, legacyReminderIdentifier, notificationContentForIntent, reminderNotificationIdentifier,
  reminderPayloadForDigest, validateReminderPayload, validateReminderRecord, validateReminderState,
} from '../reminders';
import type { LegacyReminderCancellation, ReminderIntent, ReminderPayload, ReminderRecord, ReminderState } from '../reminders';
import type { NotificationBackend, PendingNotificationRequest } from './notificationBackend';
import type { DeviceCalendarState } from '../deviceCalendars/types';
import {
  appendDeviceEventReconciliation, createDeviceEventDispatchRecord, getDeviceCalendarBackend,
  validateDeviceCalendarReadWindow,
  recordDeviceEventOutcome, validateDeviceCalendarState,
} from '../deviceCalendars';
import type { DeviceCalendarBackend, DeviceEventDispatchRecord, DeviceCalendarRow } from '../deviceCalendars';
import { DeviceCalendarBackendError } from './deviceCalendarBackend';
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
import { evaluateProactive, type ProactiveMailSource, type ProactiveTrigger, type QuietHours } from '../proactive';
import { computeProactiveNextCheckAt } from '../proactive/boundaries';
import { buildProactiveMailSources, buildProactiveSources, proactiveStableValue, type ProactiveSourceHashMemo } from '../proactive/adapters';
import { emptyProactiveState, normalizeProactiveData, PROACTIVE_INTEGRITY_ERROR, uncertainOnLoad, validateProactiveState, type ProactiveQuarantine } from '../proactive/state';
import { emptyProactiveMailAlertState, validateProactiveMailAlertState } from '../proactiveMailAlerts/state';
import { createProactiveMailAlertConsent, planProactiveMailAlerts, replaceProactiveMailAlertConsent, revokeProactiveMailAlertConsent } from '../proactiveMailAlerts/planner';
import { executeRequestedMailAlertCancellations, executeReservedMailAlertAttempts, type ProactiveMailAlertEngineDependencies } from '../proactiveMailAlerts/engine';
import type { CommittedMailAlertPage, ProactiveMailAlertReceipt } from '../proactiveMailAlerts/types';
import type { MailAlertTapKey, MailAlertTapResolution, MailAlertTapBackend } from '../proactiveMailAlerts/taps';
import { committedMailAlertPageForWorkspace, isMailAlertAttemptCurrentForWorkspace, mailAlertAccountsForWorkspace } from '../proactiveMailAlerts/workspace';
import { createMailAlertNotificationBackend, isMatchingProactiveMailAlertNotification, type MailAlertNotificationBackend } from './mailAlertNotificationBackend';
import { createMailAlertTapBackend } from './mailAlertTapBackend';
import { canonicalMailReplySource, createMailReplySource, defaultReplyRecipients, replyReferences, validateMailReplySource, validateReplyBinding } from '../mailReply';
import { emptyKnowledgeState, getKnowledgeEntity, knowledgeContextSources, validateKnowledgeState, validateKnowledgeSuggestion } from '../knowledge';
import type { ContactClaim, KnowledgeChange, KnowledgeEntityKind, KnowledgeEvidence, KnowledgeFact, KnowledgeReference, KnowledgeSourceLink, KnowledgeSuggestion, Person, Project, ProjectMember } from '../knowledge';
import { BACKUP_LIMITS, canonicalPortableContent, legacyCanonicalPortableContentV2, createPortableBackup, parsePortableBackup, summarizePortableBackup, validatePortableDocumentPath, validateImportedBackupArchive } from '../backup';
import type { ImportedBackupArchive, PortableBackupV3, PortableKnowledgeCohort } from '../backup';
import { SpeechTranscriptionError, validateTranscriptionState, validateSpeechAudioSnapshot } from '../transcription';
import type { SpeechAudioSnapshot, SpeechAttemptCode, SpeechTranscriptionResult, TranscriptionAttempt, TranscriptionState } from '../transcription';
import type { PreparedSpeechAudio, SpeechAudioService } from '../audio/speechUpload.types';
import { getDefaultPrivacyService, type PrivacyService, type PrivacyWorkspaceSession } from '../privacy/service';
import { createPrivacyBoundController } from '../privacy/controllerBoundary';
import { bindExistingWorkspaceWriter, bindWorkspaceStorage, type ExistingWorkspaceWriterStore } from '../privacy/workspaceStorage';
import type { PrivacyWriterScope } from '../privacy/types';
import { createPendingCaptureService } from '../audio/pendingCaptureService';
import type { PendingCaptureControllerPort, PendingCaptureJournalPort, PendingCaptureReceipt, PendingCaptureSafeStatus } from '../audio/pendingCaptureService.types';
import type { PendingCaptureNativeIO } from '../audio/pendingCaptureNativeIO.types';
import { createPrivacyResourceBoundary, type PrivacyResourceBoundary } from '../privacy/resourceBoundary';
import { createPrivacyAudioBoundary, createPrivacyBoundRecordingRecoveryService, createPrivacyBoundSpeechAudioService, type PrivacyAudioBoundary } from '../privacy/audioBoundary';
import { createProviderCredentialService, type ProviderCredentialService } from './credentials';
import { credentialStore } from '../storage/credentials';
import type { BackgroundTaskBackend } from '../background/backend.types';

const now = () => new Date().toISOString();
const ASSIST_CONTRACT_VERSION = 'assist-v3';
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
function boundedReminderTitle(value: string | undefined): string {
  const safe = value?.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safe) return 'Reminder';
  let result = '';
  let bytes = 0;
  let characters = 0;
  for (const point of safe) {
    const pointBytes = new TextEncoder().encode(point).length;
    if (characters >= 200 || bytes + pointBytes > 512) break;
    result += point;
    bytes += pointBytes;
    characters += 1;
  }
  return result.trim() || 'Reminder';
}
function stateEntityIds(state: AppState): Set<string> {
  return new Set([
    ...state.notes.map((item) => item.id), ...state.tasks.map((item) => item.id),
    ...state.proposals.map((item) => item.id), ...state.activity.map((item) => item.id),
    ...state.accounts.map((item) => item.id), ...state.calendars.map((item) => item.id),
    ...state.mailbox.map((item) => item.id), ...state.calendarEvents.map((item) => item.id),
    ...state.reminders.records.map((item) => item.id), ...state.reminders.intents.map((item) => item.id),
    ...state.dispatchRecords.map((item) => item.id), ...state.importedBackups.flatMap((item) => [
      item.id, ...item.noteLinks.map((link) => link.noteId), ...item.taskLinks.map((link) => link.taskId),
      ...item.documents.map((document) => document.id), ...item.history.map((entry) => entry.id),
    ]),
    ...state.knowledge.people.flatMap((item) => [item.id, ...item.facts.map((row) => row.id), ...item.contacts.map((row) => row.id), ...item.sourceLinks.map((row) => row.id)]),
    ...state.knowledge.projects.flatMap((item) => [item.id, ...item.facts.map((row) => row.id), ...item.members.map((row) => row.id), ...item.sourceLinks.map((row) => row.id)]),
    ...state.knowledge.suggestions.map((item) => item.id),
    ...state.importedBackups.flatMap((archive) => (archive.archivedKnowledge ?? []).flatMap((cohort) => [
      cohort.id, ...(cohort.activationLinks ?? []).map((link) => link.entityId),
      ...cohort.knowledge.state.people.flatMap((item) => [item.id, ...item.facts.map((row) => row.id), ...item.contacts.map((row) => row.id), ...item.sourceLinks.map((row) => row.id)]),
      ...cohort.knowledge.state.projects.flatMap((item) => [item.id, ...item.facts.map((row) => row.id), ...item.members.map((row) => row.id), ...item.sourceLinks.map((row) => row.id)]),
      ...cohort.knowledge.state.suggestions.map((item) => item.id),
    ])),
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

function transcriptionSourceProjection(note: Note, settings: AppSettings): TranscriptionAttempt['source'] {
  const attachment = note.audioAttachment;
  return {
    audioUri: note.audioUri ?? '', durationSeconds: note.durationSeconds,
    capturedAt: new Date(note.capturedAt ?? note.createdAt).toISOString(),
    captureTimeZone: validTimezone(note.captureTimeZone ?? settings.timezone),
    speechEnabled: settings.speechEnabled === true, maxAudioSeconds: settings.maxAudioSeconds,
    ...(attachment ? { audioAttachment: {
      fileName: attachment.fileName, format: attachment.format, mimeType: attachment.mimeType,
      byteLength: attachment.byteLength, sha256: attachment.sha256, durationStatus: attachment.durationStatus,
      ...(attachment.durationSeconds !== undefined ? { durationSeconds: attachment.durationSeconds } : {}),
    } } : {}),
  };
}

function speechSettingsProjection(settings: AppSettings): string {
  return stableJson({
    speechEnabled: settings.speechEnabled === true,
    speechEndpoint: settings.speechEndpoint ?? '',
    maxAudioSeconds: settings.maxAudioSeconds,
    speechUsdPerMinute: settings.speechUsdPerMinute ?? null,
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
    maxCallsPerDay: settings.maxCallsPerDay,
  });
}

function speechErrorCode(error: unknown): SpeechAttemptCode {
  if (!(error instanceof SpeechTranscriptionError)) return 'audio_invalid';
  switch (error.code) {
    case 'unsupported_format': case 'invalid_audio': case 'audio_changed': return 'audio_invalid';
    case 'credential_missing': return 'credential_missing';
    case 'stale_credential': return 'stale_credential';
    case 'cancelled': return 'cancelled';
    case 'timeout': return 'timeout';
    case 'provider_rejected': return 'provider_rejected';
    case 'provider_unknown': return 'provider_unknown';
    case 'invalid_response': return 'invalid_response';
    case 'no_speech': return 'no_speech';
    default: return 'audio_invalid';
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const DEFAULT_SETTINGS: AppSettings = {
  mode: 'preview', timezone: validTimezone(), speechEnabled: false, backgroundMailRefreshEnabled: false, backgroundRefreshGeneration: 0, maxContextTokens: 6000, maxRequestBytes: 24000, maxOutputTokens: 1200, monthlyBudgetUsd: 5,
  reasoningEffort: 'none', maxAttempts: 2, maxCallsPerDay: 20, maxAudioSeconds: 600, audioRetention: 'keep',
};

function initialState(): AppState {
  const day = localDate(DEFAULT_SETTINGS.timezone);
  return {
    notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [],
    settings: { ...DEFAULT_SETTINGS },
    usage: { month: day.slice(0, 7), day, requests: 0, attemptsToday: 0, inputTokens: 0, outputTokens: 0, transcriptionSeconds: 0, attempts: 0, unknownCharges: 0, reservedUsd: 0, priceKnown: false, estimatedCostUsd: 0 },
    transcription: { schemaVersion: 1, installationUUID: newId(), attempts: [], cleanupLeases: [] },
    mailbox: [], selectedMailTexts: [], calendarEvents: [], syncStates: {}, pendingCredentialCleanup: [], dispatchRecords: [], mailboxSchemaVersion: 2,
    deviceCalendars: emptyDeviceCalendarState(), deviceCalendarAccess: { status: 'needs_check' },
    proactive: emptyProactiveState(), proactiveMailAlerts: emptyProactiveMailAlertState(newId()),
    importedBackups: [], knowledge: emptyKnowledgeState(), reminders: emptyReminderState(newId()),
  };
}

function emptyDeviceCalendarState(installationId = newId()): DeviceCalendarState {
  return { schemaVersion: 1, installationId, generation: 1, selectionRevision: 1, enabled: false, selectedCalendarIds: [], calendars: [], events: [], dispatchRecords: [] };
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

function normalizeKnowledgeSelection(value: unknown): KnowledgeSelection {
  if (!Array.isArray(value) || value.length > 5) throw new Error('Select no more than five people or projects for this Assist request.');
  const result: KnowledgeSelection = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!isRecord(row) || (row.kind !== 'person' && row.kind !== 'project') || typeof row.id !== 'string' || !row.id) throw new Error('The selected knowledge source is invalid.');
    const key = `${row.kind}:${row.id}`;
    if (!seen.has(key)) { result.push({ kind: row.kind, id: row.id }); seen.add(key); }
  }
  return result;
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

function currentDeviceCalendarSnapshotAvailable(state: AppState, at = Date.now()): boolean {
  const device = state.deviceCalendars, run = device.readRun;
  if (state.deviceCalendarAccess.status !== 'full_access' || !device.enabled || !device.selectedCalendarIds.length || !run ||
      run.generation !== device.generation || run.selectionRevision !== device.selectionRevision ||
      stableJson(run.selectedCalendarIds) !== stableJson(device.selectedCalendarIds)) return false;
  const age = at - Date.parse(run.startedAt);
  if (!Number.isFinite(age) || age < 0 || age >= 15 * 60_000 || run.partial || run.completedCalendarIds.length !== run.selectedCalendarIds.length) return false;
  const inWindow = device.events.filter((event) => event.generation === device.generation && device.selectedCalendarIds.includes(event.calendarId) &&
    Date.parse(event.end) > Date.parse(run.window.timeMin) && Date.parse(event.start) < Date.parse(run.window.timeMax));
  return inWindow.every((event) => {
    if (event.cancelled) return true;
    const observedAt = Date.parse(event.observedAt);
    const eventAge = at - observedAt;
    return Number.isFinite(eventAge) && eventAge >= 0 && eventAge < 15 * 60_000;
  });
}

function usableDeviceCalendarSnapshot(state: AppState, at = Date.now()): boolean {
  const device = state.deviceCalendars, run = device.readRun;
  if (state.deviceCalendarAccess.status !== 'full_access' || !device.enabled || !device.selectedCalendarIds.length || !run ||
      run.generation !== device.generation || run.selectionRevision !== device.selectionRevision ||
      stableJson(run.selectedCalendarIds) !== stableJson(device.selectedCalendarIds)) return false;
  const age = at - Date.parse(run.startedAt);
  return Number.isFinite(age) && age >= 0 && age < 15 * 60_000;
}

function deviceReminderSourceProjection(state: AppState, binding: NonNullable<Extract<ReminderRecord['origin'], { kind: 'proactive' }>['deviceBinding']>): string | undefined {
  const device = state.deviceCalendars;
  const calendar = device.calendars.find((item) => item.localId === binding.calendarId);
  const event = device.events.find((item) => item.calendarId === binding.calendarId && item.nativeEventId === binding.nativeEventId &&
    item.occurrenceStart === binding.occurrenceStart && item.generation === binding.generation && !item.cancelled);
  if (!calendar || !event || state.deviceCalendarAccess.status !== 'full_access' || !device.enabled || device.installationId !== binding.installationId ||
      device.generation !== binding.generation || !device.selectedCalendarIds.includes(binding.calendarId)) return undefined;
  const age = Date.now() - Date.parse(event.observedAt);
  if (!Number.isFinite(age) || age < 0 || age >= 15 * 60_000) return undefined;
  return stableJson({ installationId: device.installationId, generation: device.generation, selectionRevision: device.selectionRevision,
    calendarId: calendar.localId, nativeCalendarId: calendar.nativeId, calendarFingerprint: calendar.fingerprint,
    event: { nativeEventId: event.nativeEventId, occurrenceStart: event.occurrenceStart, title: event.title, notes: event.notes,
      notesTruncated: event.notesTruncated, start: event.start, end: event.end, timeZone: event.timeZone ?? null, allDay: event.allDay, cancelled: event.cancelled } });
}

function assistContext(state: AppState, note: Note, intent: AssistIntent, question?: string, knowledgeSelection: KnowledgeSelection = []): { documents: ContextDocument[]; additionalSources: AssistantSourceInput[]; omittedSourceCount: number; omittedSourceIds: string[] } {
  const entityNarrativePaths = new Set([
    ...state.knowledge.people.map((entity) => entity.narrativePath),
    ...state.knowledge.projects.map((entity) => entity.narrativePath),
  ]);
  const allDocuments = state.documents.filter(({ path }) => !path.startsWith('logs/') && path !== 'memory/INFERENCES.md' && path !== 'memory/DECISIONS.md' &&
    !entityNarrativePaths.has(path));
  const taskQuery = intent === 'answer' && /\b(task|tasks|task count|how many|todo|to-do|action item)\b/i.test(question ?? '');
  const selectedKnowledge = new Set(knowledgeSelection.map((item) => `${item.kind}:${item.id}`));
  const acceptedKnowledge = [
    ...state.knowledge.people.map((entity) => ({ kind: 'person' as const, entity })),
    ...state.knowledge.projects.map((entity) => ({ kind: 'project' as const, entity })),
  ].filter(({ entity }) => !entity.archivedAt && entity.sourceLinks.some((link) =>
    link.reference.kind === 'note' && 'id' in link.reference && link.reference.id === note.id));
  const anchorKnowledgeKeys = new Set([
    ...acceptedKnowledge.map(({ kind, entity }) => `${kind}:${entity.id}`),
    ...knowledgeSelection.map(({ kind, id }) => `${kind}:${id}`),
  ]);
  const anchorEntities = [
    ...state.knowledge.people.map((entity) => ({ kind: 'person' as const, entity })),
    ...state.knowledge.projects.map((entity) => ({ kind: 'project' as const, entity })),
  ].filter(({ kind, entity }) => anchorKnowledgeKeys.has(`${kind}:${entity.id}`));
  const linkedEntityKeys = new Set<string>(), linkedTaskIds = new Set<string>(), linkedNoteIds = new Set<string>(), linkedDocumentPaths = new Set<string>();
  const linkedMailKeys = new Set<string>(), linkedCalendarKeys = new Set<string>(), linkedDeviceEventKeys = new Set<string>();
  for (const { entity } of anchorEntities) {
    for (const { reference } of entity.sourceLinks) {
      if (reference.kind === 'person' || reference.kind === 'project') linkedEntityKeys.add(`${reference.kind}:${reference.id}`);
      else if (reference.kind === 'task') linkedTaskIds.add(reference.id);
      else if (reference.kind === 'note') linkedNoteIds.add(reference.id);
      else if (reference.kind === 'document') linkedDocumentPaths.add(reference.id);
      else if (reference.kind === 'mail') linkedMailKeys.add(`${reference.identityKey}:${reference.id}`);
      else if (reference.kind === 'calendar') linkedCalendarKeys.add(`${reference.identityKey}:${reference.calendarId}:${reference.id}`);
      else if (reference.kind === 'device_calendar_event') linkedDeviceEventKeys.add(`device_calendar_event:${encodeURIComponent(reference.installationId)}:${encodeURIComponent(reference.calendarId)}:${encodeURIComponent(reference.eventId)}:${encodeURIComponent(reference.occurrenceStart)}`);
    }
    if ('members' in entity) for (const member of entity.members) if ('personId' in member) linkedEntityKeys.add(`person:${member.personId}`);
  }
  const relatedKnowledgeKeys = new Set([...anchorKnowledgeKeys, ...[...linkedEntityKeys].filter((key) => {
    const [kind, id] = key.split(':') as [KnowledgeEntityKind, string];
    const entity = getKnowledgeEntity(state.knowledge, kind, id);
    return Boolean(entity && (!entity.archivedAt || knowledgeSelection.some((selected) => selected.kind === kind && selected.id === id)));
  })]);
  const knowledgeSources = knowledgeContextSources(state.knowledge,
    state.documents.map((document) => ({ path: document.path, content: document.content })),
    knowledgeSelection.map(({ kind, id }) => ({ kind, id }))).map((source) => ({
      ...source,
      selectionPriority: (selectedKnowledge.has(source.id.replace(/^knowledge:/, '')) ? 2
        : relatedKnowledgeKeys.has(source.id.replace(/^knowledge:/, '')) ? 1 : 0) as 0 | 1 | 2,
    }));
  const linkedTaskSourceIds = new Set([...linkedTaskIds].map((id) => `task:${encodeURIComponent(id)}`));
  const built = buildLocalSourceSet({
    transcript: { revision: note.revision, text: note.transcript },
    query: `${question ?? ''}\n${note.transcript}`,
    intent,
    documents: allDocuments.map((doc) => ({ path: doc.path, revision: doc.revision, content: doc.content, updatedAt: doc.updatedAt, selectionPriority: linkedDocumentPaths.has(doc.path) ? 1 as const : 0 as const })),
    notes: state.notes.filter((item) => linkedNoteIds.has(item.id) && item.id !== note.id).map((item) => ({ id: item.id, title: item.title, revision: item.revision, transcript: item.transcript, updatedAt: item.capturedAt ?? item.createdAt, selectionPriority: 1 as const })),
    knowledge: knowledgeSources,
    tasks: taskQuery || linkedTaskIds.size ? state.tasks.filter((task) => taskQuery || linkedTaskIds.has(task.id)).map((task) => ({ id: task.id, title: task.title, body: task.body, status: task.status, dueAt: task.dueAt, updatedAt: task.completedAt ?? task.createdAt, selectionPriority: (linkedTaskIds.has(task.id) ? 1 : 0) as 0 | 1 })) : [],
    calendars: state.calendars.flatMap((calendar) => {
      const account = state.accounts.find((item) => item.id === calendar.accountId);
      return account?.connected && account.authStatus === 'connected'
        ? [{ id: calendar.id, accountId: calendar.accountId, identityKey: identityKey(account), providerId: calendar.providerId, name: calendar.name, writable: calendar.writable, connected: calendar.connected }]
        : [];
    }),
    calendarEvents: state.calendarEvents.flatMap((event) => {
      const account = state.accounts.find((item) => item.id === event.accountId);
      const identity = account && identityKey(account);
      const calendar = state.calendars.find((item) => item.id === event.calendarId && item.accountId === event.accountId && item.connected);
      if (!identity || !calendar || !account?.connected || account.authStatus !== 'connected' || event.verifiedIdentityKey !== identity ||
        (event.connectionGeneration ?? 0) !== (account.connectionGeneration ?? 0)) return [];
      return [{ ...event, identityKey: identity, selectionPriority: linkedCalendarKeys.has(`${identity}:${calendar.providerId ?? calendar.id}:${event.providerEventId}`) ? 1 as const : 0 as const }];
    }),
    mailbox: state.mailbox.flatMap((message) => {
      const account = state.accounts.find((item) => item.id === message.accountId);
      if (!account?.connected || account.authStatus !== 'connected' || !message.providerMessageId || message.providerDeletedAt || message.replyMetadataComplete !== true) return [];
      const accountIdentity = identityKey(account);
      return message.identityKey === `${accountIdentity}:${message.providerMessageId}` &&
        message.verifiedIdentityKey === accountIdentity && (message.connectionGeneration ?? 0) === (account.connectionGeneration ?? 0)
        ? [{ ...message, identityKey: accountIdentity, selectionPriority: linkedMailKeys.has(`${accountIdentity}:${message.providerMessageId}`) ? 1 as const : 0 as const }]
        : [];
    }),
    deviceCalendarSnapshot: (() => {
      const device = state.deviceCalendars;
      const run = device.readRun;
      if (state.deviceCalendarAccess.status !== 'full_access' || !device.enabled || !device.selectedCalendarIds.length || !run ||
          run.generation !== device.generation || run.selectionRevision !== device.selectionRevision ||
          stableJson(run.selectedCalendarIds) !== stableJson(device.selectedCalendarIds)) return undefined;
      const inWindow = device.events.filter((event) => event.generation === device.generation && device.selectedCalendarIds.includes(event.calendarId) &&
        !event.cancelled && Date.parse(event.end) > Date.parse(run.window.timeMin) && Date.parse(event.start) < Date.parse(run.window.timeMax));
      const events = device.events.filter((event) => event.generation === device.generation && device.selectedCalendarIds.includes(event.calendarId) &&
        !event.cancelled && Number.isFinite(Date.parse(event.observedAt)) && Date.now() - Date.parse(event.observedAt) >= 0 &&
        Date.now() - Date.parse(event.observedAt) < 15 * 60_000 && Date.parse(event.end) > Date.parse(run.window.timeMin) &&
        Date.parse(event.start) < Date.parse(run.window.timeMax));
      const freshAsOf = events.reduce<string | undefined>((latest, event) => !latest || Date.parse(event.observedAt) > Date.parse(latest) ? event.observedAt : latest, undefined);
      const runAge = Date.now() - Date.parse(run.startedAt);
      const staleCount = inWindow.length - events.length;
      return {
        installationId: device.installationId, generation: device.generation, selectionRevision: device.selectionRevision,
        selectedCalendarIds: [...device.selectedCalendarIds], timeMin: run.window.timeMin, timeMax: run.window.timeMax,
        asOf: freshAsOf ?? run.startedAt,
        partial: run.partial || run.completedCalendarIds.length !== run.selectedCalendarIds.length || staleCount > 0 || !Number.isFinite(runAge) || runAge < 0 || runAge >= 15 * 60_000,
        omittedEvents: run.truncatedEvents + staleCount, events: events.map((event) => ({ calendarId: event.calendarId,
          nativeEventId: event.nativeEventId, occurrenceStart: event.occurrenceStart, title: event.title, notes: event.notes,
          notesTruncated: event.notesTruncated, start: event.start, end: event.end, timeZone: event.timeZone,
          allDay: event.allDay, cancelled: event.cancelled,
          selectionPriority: linkedDeviceEventKeys.has(`device_calendar_event:${encodeURIComponent(device.installationId)}:${encodeURIComponent(event.calendarId)}:${encodeURIComponent(event.nativeEventId)}:${encodeURIComponent(event.occurrenceStart)}`) ? 1 as const : 0 as const })),
      };
    })(),
  });
  const documentByPath = new Map(allDocuments.map((document) => [document.path, document]));
  return {
    documents: built.sources.filter((source) => source.id.startsWith('doc:')).flatMap((source) => {
      const document = documentByPath.get(source.id.slice('doc:'.length));
      return document ? [{ ...document, selectionPriority: source.selectionPriority }] : [];
    }),
    additionalSources: [
      ...built.sources.filter((source) => source.id !== 'transcript' && !source.id.startsWith('doc:') &&
        (!source.id.startsWith('task:') || taskQuery || linkedTaskSourceIds.has(source.id))),
    ],
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
    ...additionalSources.filter((source) => taskQuestion && source.id.startsWith('task:') || calendarQuestion && (source.id.startsWith('calendar') || source.id.startsWith('device_calendar'))),
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
  const calendar = proposal.eventDestination?.kind === 'remote_calendar' ? state.calendars.find((item) => item.id === proposal.eventDestination?.calendarId) : undefined;
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
    eventDestination: proposal.eventDestination ?? null, deviceCalendarApproval: proposal.deviceCalendarApproval ?? null,
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
  sourceVersions: Record<string, string>; policySources: ProposalProvenance['policySources']; settings: AppSettings; answeredAsOf?: string; knowledgeSelection?: KnowledgeSelection;
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
    knowledgeSelection: clone(input.knowledgeSelection ?? []),
    sources: sources as NonNullable<typeof sources[number]>[], policySources: input.policySources,
    settingsFingerprint: JSON.stringify(input.settings),
    ...(input.answeredAsOf ? { answeredAsOf: input.answeredAsOf, expiresAt } : {}),
  };
}

type DispatchRecordQuarantineEntry = { reason: 'invalid_persisted_receipt'; quarantinedAt: string; raw: unknown };
type NormalizedLoadedState = AppState & {
  dispatchRecordQuarantine?: DispatchRecordQuarantineEntry[];
  backupImportQuarantine?: unknown[];
  knowledgeQuarantine?: unknown[];
  reminderQuarantine?: unknown[];
  deviceCalendarQuarantine?: unknown[];
  transcriptionQuarantine?: unknown[];
  proactiveMailAlertQuarantine?: unknown[];
};

function normalizeLoadedState(value: unknown): NormalizedLoadedState {
  const defaults = initialState();
  if (!value || typeof value !== 'object') throw new Error('Saved app data is not a valid state snapshot. It was preserved for recovery.');
  const raw = value as Partial<AppState> & { dispatchRecordQuarantine?: unknown; proactiveMailAlertQuarantine?: unknown };
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
  const knowledgeQuarantine: unknown[] = [];
  const retainedKnowledgeQuarantine = (value as { knowledgeQuarantine?: unknown }).knowledgeQuarantine;
  if (Array.isArray(retainedKnowledgeQuarantine)) knowledgeQuarantine.push(...retainedKnowledgeQuarantine);
  else if (retainedKnowledgeQuarantine !== undefined) knowledgeQuarantine.push(retainedKnowledgeQuarantine);
  let knowledge = emptyKnowledgeState();
  if (raw.knowledge !== undefined) {
    try { knowledge = validateKnowledgeState(raw.knowledge); }
    catch { knowledgeQuarantine.push(raw.knowledge); }
  }
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
  const backgroundRefreshGenerationValid = Number.isSafeInteger(rawSettings.backgroundRefreshGeneration) && Number(rawSettings.backgroundRefreshGeneration) >= 0;
  const backgroundRefreshGeneration = backgroundRefreshGenerationValid ? Number(rawSettings.backgroundRefreshGeneration) : 0;
  const settings = { ...DEFAULT_SETTINGS, ...rawSettings, speechEnabled: rawSettings.speechEnabled === true,
    backgroundMailRefreshEnabled: rawSettings.backgroundMailRefreshEnabled === true && backgroundRefreshGenerationValid, backgroundRefreshGeneration,
    timezone: validTimezone(rawSettings.timezone), maxRequestBytes };
  const retainedTranscriptionQuarantine = (value as { transcriptionQuarantine?: unknown }).transcriptionQuarantine;
  const transcriptionQuarantine: unknown[] = Array.isArray(retainedTranscriptionQuarantine)
    ? clone(retainedTranscriptionQuarantine) : retainedTranscriptionQuarantine === undefined ? [] : [retainedTranscriptionQuarantine];
  let transcription: TranscriptionState;
  if (raw.transcription === undefined) transcription = defaults.transcription;
  else {
    try { transcription = clone(validateTranscriptionState(raw.transcription)); }
    catch { transcription = defaults.transcription; transcriptionQuarantine.push(raw.transcription); }
  }
  let reminders: ReminderState;
  const retainedReminderQuarantine = (value as { reminderQuarantine?: unknown }).reminderQuarantine;
  const reminderQuarantine: unknown[] = Array.isArray(retainedReminderQuarantine) ? clone(retainedReminderQuarantine) : retainedReminderQuarantine === undefined ? [] : [retainedReminderQuarantine];
  if (raw.reminders === undefined) reminders = emptyReminderState(newId());
  else {
    try { reminders = validateReminderState(raw.reminders); }
    catch { reminders = emptyReminderState(newId()); reminderQuarantine.push(raw.reminders); }
  }
  const retainedMailAlertQuarantine = raw.proactiveMailAlertQuarantine;
  const proactiveMailAlertQuarantine: unknown[] = Array.isArray(retainedMailAlertQuarantine)
    ? clone(retainedMailAlertQuarantine) : retainedMailAlertQuarantine === undefined ? [] : [retainedMailAlertQuarantine];
  let proactiveMailAlerts = emptyProactiveMailAlertState(newId());
  if (raw.proactiveMailAlerts !== undefined) {
    try {
      proactiveMailAlerts = validateProactiveMailAlertState(raw.proactiveMailAlerts);
    }
    catch { proactiveMailAlerts = emptyProactiveMailAlertState(newId()); proactiveMailAlertQuarantine.push(raw.proactiveMailAlerts); }
  }
  const retainedDeviceCalendarQuarantine = (value as { deviceCalendarQuarantine?: unknown }).deviceCalendarQuarantine;
  const deviceCalendarQuarantine: unknown[] = Array.isArray(retainedDeviceCalendarQuarantine)
    ? clone(retainedDeviceCalendarQuarantine) : retainedDeviceCalendarQuarantine === undefined ? [] : [retainedDeviceCalendarQuarantine];
  let deviceCalendars: DeviceCalendarState;
  if (raw.deviceCalendars === undefined) deviceCalendars = defaults.deviceCalendars;
  else {
    try { deviceCalendars = clone(validateDeviceCalendarState(raw.deviceCalendars)); }
    catch { deviceCalendars = defaults.deviceCalendars; deviceCalendarQuarantine.push(raw.deviceCalendars); }
  }
  const dispatchRecords: DispatchRecord[] = [];
  const persistedDispatchQuarantine = raw.dispatchRecordQuarantine;
  const dispatchRecordQuarantine: DispatchRecordQuarantineEntry[] = Array.isArray(persistedDispatchQuarantine)
    ? persistedDispatchQuarantine.map((item) => item && typeof item === 'object' && 'raw' in item && 'quarantinedAt' in item
      ? { reason: 'invalid_persisted_receipt' as const, quarantinedAt: typeof item.quarantinedAt === 'string' ? item.quarantinedAt : now(), raw: item.raw }
      : { reason: 'invalid_persisted_receipt' as const, quarantinedAt: now(), raw: item })
    : persistedDispatchQuarantine === undefined ? [] : [{ reason: 'invalid_persisted_receipt', quarantinedAt: now(), raw: persistedDispatchQuarantine }];
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
    knowledge,
    ...(knowledgeQuarantine.length ? { knowledgeQuarantine } : {}),
    knowledgeRecoveryStatus: knowledgeQuarantine.length
      ? { message: 'Some saved knowledge could not be validated and is held privately.' as const }
      : undefined,
    reminders,
    ...(reminderQuarantine.length ? { reminderQuarantine } : {}),
    reminderRecoveryStatus: reminderQuarantine.length
      ? { quarantined: true as const, message: 'Some reminder data could not be validated and is held privately. New reminders are disabled until recovery.' as const }
      : undefined,
    proactiveMailAlerts,
    proactiveMailAlertQuarantine,
    proactiveMailAlertRecoveryStatus: proactiveMailAlertQuarantine.length
      ? { quarantined: true as const, message: 'Some saved mail alert settings could not be validated and are held privately. New mail alerts are disabled until recovery.' as const }
      : undefined,
    deviceCalendars,
    transcription,
    ...(transcriptionQuarantine.length ? { transcriptionQuarantine } : {}),
    transcriptionRecoveryStatus: transcriptionQuarantine.length
      ? { quarantined: true as const, message: 'Some speech-transcription history could not be validated and is held privately. New cloud transcription is disabled until recovery.' as const }
      : undefined,
    // Permission state in persisted JSON is informational only. The OS is checked on explicit action/foreground.
    deviceCalendarAccess: { status: 'needs_check' },
    ...(deviceCalendarQuarantine.length ? { deviceCalendarQuarantine } : {}),
    deviceCalendarRecoveryStatus: deviceCalendarQuarantine.length
      ? { quarantined: true as const, message: 'Some device calendar history could not be validated and is held privately. New device calendar writes are disabled until recovery.' as const }
      : undefined,
    ...(backupImportQuarantine.length ? { backupImportQuarantine } : {}),
    backupRecoveryStatus: backupImportQuarantine.length
      ? { quarantinedArchiveCount: backupImportQuarantine.length, message: 'Some imported backup archive data could not be validated and is held privately.' as const }
      : undefined,
    selectedMailTexts: Array.isArray(raw.selectedMailTexts)
      ? raw.selectedMailTexts.filter(validSelectedMailTextSnapshot).slice(0, 20)
      : [],
    proactive: emptyProactiveState(),
    dispatchRecords,
    dispatchRecordQuarantine,
    ...(dispatchRecordQuarantine.length ? { dispatchRecoveryStatus: {
      quarantinedCount: dispatchRecordQuarantine.length,
      message: 'Some saved dispatch receipts could not be validated and are held privately. New external writes are disabled until recovery.' as const,
    } } : { dispatchRecoveryStatus: undefined }),
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
  privacySession?: { epoch: string; assertCurrent(): Promise<void>; getStatus?(): Promise<import('../privacy/types').PrivacyPublicStatus> };
  credentials?: ProviderCredentialService;
  writeDocument?: (path: string, content: string) => Promise<void>;
  tokenStore?: OAuthTokenStore;
  deleteToken?: (tokenRef: string) => Promise<void>;
  verifyOAuthResult?: (result: OAuthBridgeResult, stored: StoredOAuthToken) => Promise<boolean>;
  clientIds?: Partial<Record<'google' | 'microsoft', string>>;
  connectorFactory?: (
    tokenStore: OAuthTokenStore,
    onAuthStatus: (accountId: string, status: Account['authStatus']) => Promise<void>,
    withProviderOwnership?: <T>(actual: () => Promise<T>) => Promise<T>,
  ) => ConnectorClient;
  recordingRecovery?: RecordingRecoveryService;
  speechAudioService?: SpeechAudioService;
  audioBoundary?: PrivacyAudioBoundary;
  removeAudio?: (uri: string) => Promise<void>;
  disposePrivacyResources?: () => void;
  reminderBackend?: NotificationBackend;
  deviceCalendarBackend?: DeviceCalendarBackend;
  backgroundTasks?: BackgroundTaskBackend;
  mailAlertBackend?: MailAlertNotificationBackend;
  mailAlertTapBackend?: MailAlertTapBackend;
  withMailAlertNotificationWriter?: <T>(actual: (scope: PrivacyWriterScope, store: ExistingWorkspaceWriterStore) => Promise<T>) => Promise<T>;
}

interface BackupImportSession {
  preview: BackupImportPreview;
  backup: PortableBackupV3;
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
  knowledgeCohortIds: Record<string, string>;
  knowledgeCohorts: PortableKnowledgeCohort[];
  appliedArchiveId?: string;
}

interface KnowledgeActivationSession {
  preview: import('../core').ImportedKnowledgeActivationPreview;
  stateJson: string;
  preparedAtMs: number;
  entity: Person | Project;
  narrativeContent: string;
  archiveId: string;
  cohortId: string;
  sourceDigest: string;
  targetId: string;
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
  private bootstrapGeneration = 0;
  private startupRecoveryPhase: StartupRecoveryStatus['phase'] = 'ready';
  private startupRecoveryPlan?: StartupRecoveryPlan;
  private startupRecoveryReceipt?: StartupRecoveryReceipt;
  private startupRecoveryInspection?: StartupRecoveryInspection;
  private startupRecoveryBusy = false;
  private mailAlertRefreshRequired = false;
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
  private proactiveMailAlertQuarantine: unknown[] = [];
  private backupImportQuarantine: unknown[] = [];
  private knowledgeQuarantine: unknown[] = [];
  private reminderQuarantine: unknown[] = [];
  private proactiveSourceHashMemo: ProactiveSourceHashMemo = new Map();
  private mailReplyGenerations = new Map<string, { messageId: string; promise: Promise<MailReplyTextGenerationResult> }>();
  private mailReplyGenerationCache = new Map<string, MailReplyTextGenerationResult>();
  private backupImportSessions = new Map<string, BackupImportSession>();
  private knowledgeActivationSessions = new Map<string, KnowledgeActivationSession>();
  private recordingAttachmentSessions = new Map<string, RecordingAttachmentSession>();
  private recordingAttachmentJobs = new Map<string, Promise<Note>>();
  private recordingAttachmentReceipts = new Map<string, RecordingAttachmentReceipt>();
  private recordingRecoveryPromise?: Promise<RecordingRecoveryService>;
  private transcriptionCleanupPromises = new Set<string>();
  private transcriptionQuarantine: unknown[] = [];
  private transcriptionJobs = new Map<string, { attemptId: string; sourceRevision: number; leaseId: string; controller: AbortController; promise: Promise<Note> }>();
  private transcriptionCleanupJob?: Promise<void>;
  private readonly reminderBackend: NotificationBackend;
  private readonly mailAlertBackend: MailAlertNotificationBackend;
  private reminderReconcileJob?: Promise<void>;
  private reminderReconcileAgain = false;
  private readonly verifiedReminderForeground = new Map<string, string>();
  private reminderJobs = new Map<string, Promise<ReminderRecord>>();
  private reminderLegacyJobs = new Map<string, Promise<void>>();
  private draftAllocatedIds = new WeakMap<AppState, Set<string>>();
  private deviceEventQuarantine: unknown[] = [];
  private dispatchRecordQuarantine: DispatchRecordQuarantineEntry[] = [];
  private verifiedDeviceCalendarGeneration?: number;
  private deviceCalendarJob?: Promise<DeviceCalendarState>;
  private deviceEventJobs = new Map<string, Promise<Proposal>>();
  private deviceEventCreateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private deviceEventLateResults = new Map<string, Promise<void>>();
  private readonly deviceCalendarBackend: DeviceCalendarBackend;

  constructor(
    private readonly store: StateStore = stateStore,
    providers: { speech?: AzureSpeechClient; openAi?: AzureOpenAIClient } = {},
    private readonly integration: ControllerIntegrationDependencies = {},
    private readonly pendingCapture?: PendingCaptureControllerPort,
  ) {
    const credentials = integration.credentials;
    this.speechClient = providers.speech ?? new AzureSpeechClient({
      audio: integration.speechAudioService,
      ...(credentials ? {
        readKeySnapshot: () => credentials.readSpeechCredentialSnapshot(),
        currentCredentialGeneration: () => credentials.currentSpeechCredentialGeneration(),
        assertCredentialGeneration: (generation: number) => credentials.assertSpeechCredentialGeneration(generation),
      } : {}),
    });
    this.openAiClient = providers.openAi ?? new AzureOpenAIClient(fetch, credentials ? () => credentials.readProviderCredential('openai') : undefined);
    this.connector = integration.tokenStore && integration.connectorFactory
      ? integration.connectorFactory(integration.tokenStore, (accountId, status) => this.handleConnectorAuthStatus(accountId, status))
      : undefined;
    this.reminderBackend = integration.reminderBackend ?? createNotificationBackend();
    this.mailAlertBackend = integration.mailAlertBackend ?? createMailAlertNotificationBackend();
    this.deviceCalendarBackend = integration.deviceCalendarBackend ?? getDeviceCalendarBackend();
  }

  async disposeForPrivacy(): Promise<void> {
    this.bootstrapGeneration += 1;
    this.speechClient.disposeMemory();
    for (const controller of this.syncAbortControllers.values()) controller.abort();
    for (const job of this.transcriptionJobs.values()) job.controller.abort();
    for (const timer of this.deviceEventCreateTimers.values()) clearTimeout(timer);
    this.deviceEventCreateTimers.clear();
    this.syncAbortControllers.clear();
    this.processJobs.clear();
    this.assistJobs.clear();
    this.syncJobs.clear();
    this.mailLaneJobs.clear();
    this.mailReplyGenerations.clear();
    this.mailReplyGenerationCache.clear();
    this.backupImportSessions.clear();
    this.knowledgeActivationSessions.clear();
    this.recordingAttachmentSessions.clear();
    this.recordingAttachmentJobs.clear();
    this.recordingAttachmentReceipts.clear();
    this.transcriptionJobs.clear();
    this.deviceEventJobs.clear();
    this.deviceEventLateResults.clear();
    this.reminderJobs.clear();
    this.reminderLegacyJobs.clear();
    this.listeners.clear();
    this.state = initialState();
    this.snapshot = deepFreeze(this.publicState(this.state));
    this.loaded = false;
    this.loadPromise = undefined;
    this.transactionQueue = Promise.resolve();
    this.proactiveQuarantine = undefined;
    this.proactiveMailAlertQuarantine = [];
    this.backupImportQuarantine = [];
    this.knowledgeQuarantine = [];
    this.reminderQuarantine = [];
    this.deviceEventQuarantine = [];
    this.dispatchRecordQuarantine = [];
    this.transcriptionQuarantine = [];
    this.analysisCache.clear();
    this.proactiveSourceHashMemo.clear();
    this.verifiedReminderForeground.clear();
    this.verifiedDeviceCalendarGeneration = undefined;
    this.integration.disposePrivacyResources?.();
  }

  private async assertPrivacySessionCurrent(allowMailAlertRefresh = false): Promise<void> {
    if (this.mailAlertRefreshRequired && !allowMailAlertRefresh) {
      throw new Error('Saved data changed. Refresh local data before continuing.');
    }
    await this.integration.privacySession?.assertCurrent();
  }

  private setMailAlertRefreshRequired(): void {
    if (this.mailAlertRefreshRequired) return;
    this.mailAlertRefreshRequired = true;
    // These plans are pure previews; none owns an external resource or staged
    // file. A storage rebase invalidates their captured snapshot, so drop them
    // to keep an explicit refresh available. Recording attachment sessions
    // are deliberately retained until their stage owner completes cleanup.
    this.backupImportSessions.clear();
    this.knowledgeActivationSessions.clear();
    // Stop new provider-side admissions while retaining jobs and their leases
    // until each underlying request actually settles.
    for (const job of this.transcriptionJobs.values()) job.controller.abort();
    for (const job of this.syncAbortControllers.values()) job.abort();
    this.snapshot = deepFreeze(this.publicState(this.state));
    this.emit();
  }

  private clearMailAlertRefreshRequired(): void {
    if (!this.mailAlertRefreshRequired) return;
    this.mailAlertRefreshRequired = false;
    this.snapshot = deepFreeze(this.publicState(this.state));
    this.emit();
  }

  private withMailAlertTransactionSlot<T>(work: () => Promise<T>): Promise<T> {
    const capturedBootstrapGeneration = this.bootstrapGeneration;
    const run = this.transactionQueue.then(async () => {
      await this.assertPrivacySessionCurrent();
      if (capturedBootstrapGeneration !== this.bootstrapGeneration) throw new Error('The app workspace changed while this action was waiting.');
      if (this.startupRecoveryPhase !== 'ready') throw new Error('App startup is not ready.');
      if (!this.loaded) await this.load();
      if (this.loadPromise) await this.loadPromise;
      await this.assertPrivacySessionCurrent();
      if (capturedBootstrapGeneration !== this.bootstrapGeneration || this.startupRecoveryPhase !== 'ready') throw new Error('The app workspace changed while this action was waiting.');
      return await work();
    });
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async commitMailAlertDraft(draft: AppState): Promise<void> {
    draft.proactiveMailAlerts = validateProactiveMailAlertState(draft.proactiveMailAlerts);
    try {
      await this.assertPrivacySessionCurrent();
      await this.store.save(this.persistedState(draft));
      await this.assertPrivacySessionCurrent();
      this.state = draft;
      this.snapshot = deepFreeze(this.publicState(draft));
      this.emit();
    } catch (error) {
      // Save may have committed before acknowledgement failed; do not let the
      // stale controller overwrite it until an explicit reload succeeds.
      this.setMailAlertRefreshRequired();
      throw error;
    }
  }

  private nonAlertPersistedProjection(state: AppState, alreadyPersisted = false): Record<string, unknown> {
    const source = alreadyPersisted ? state : this.persistedState(state);
    // Match production JSON stores: undefined object members are omitted and
    // undefined array slots become null before canonical key ordering.
    const serialized = JSON.stringify(source);
    if (serialized === undefined) throw new Error('Workspace snapshot cannot be serialized.');
    const persisted = JSON.parse(serialized) as Record<string, unknown>;
    delete persisted.proactiveMailAlerts;
    delete persisted.mailAlertRefreshRequired;
    return persisted;
  }

  private checkedScopedMailAlertState(value: AppState | undefined): AppState {
    try {
      if (!value || stableJson(this.nonAlertPersistedProjection(value, true)) !== stableJson(this.nonAlertPersistedProjection(this.state))) {
        throw new Error('Workspace state changed during scoped mail alert settlement.');
      }
      const alerts = validateProactiveMailAlertState(value.proactiveMailAlerts);
      return { ...value, proactiveMailAlerts: alerts };
    } catch {
      this.setMailAlertRefreshRequired();
      throw new Error('Saved data changed. Refresh local data before continuing.');
    }
  }

  private adoptScopedMailAlertState(value: AppState | undefined): AppState {
    const checked = this.checkedScopedMailAlertState(value);
    try {
      const alerts = validateProactiveMailAlertState(checked.proactiveMailAlerts);
      this.state = { ...this.state, proactiveMailAlerts: alerts };
      this.snapshot = deepFreeze(this.publicState(this.state));
      this.emit();
      return { ...checked, proactiveMailAlerts: alerts };
    } catch {
      this.setMailAlertRefreshRequired();
      throw new Error('Saved data changed. Refresh local data before continuing.');
    }
  }

  private mailAlertScopedStore(_scope: PrivacyWriterScope, store: ExistingWorkspaceWriterStore) {
    const controller = this;
    return Object.freeze({
      async load(): Promise<AppState | undefined> {
        try { return controller.adoptScopedMailAlertState(await store.load()); }
        catch (error) { controller.setMailAlertRefreshRequired(); throw error; }
      },
      async save(value: AppState): Promise<void> {
        try {
          const checked = controller.checkedScopedMailAlertState(value);
          await store.save(checked);
          controller.adoptScopedMailAlertState(checked);
        } catch (error) {
          controller.setMailAlertRefreshRequired();
          throw error;
        }
      },
      async assertCurrent(): Promise<void> {
        try { await store.assertCurrent(); }
        catch (error) { controller.setMailAlertRefreshRequired(); throw error; }
      },
    });
  }

  private revokeStaleMailAlertConsent(state: AppState): boolean {
    if (this.proactiveMailAlertQuarantine.length) return false;
    const before = stableJson(state.proactiveMailAlerts);
    try {
      const plan = planProactiveMailAlerts({
        state: state.proactiveMailAlerts,
        rules: state.proactive.rules,
        accounts: mailAlertAccountsForWorkspace(state),
        pages: [],
        previousCandidates: state.proactive.candidates.map((entry) => entry.candidate),
        dismissedCandidateIds: state.proactive.dismissals.map((item) => item.candidateId),
        snoozes: state.proactive.snoozes,
        now: now(), currentTimeZone: state.settings.timezone, uuid: newId,
      });
      state.proactiveMailAlerts = plan.nextState;
      return before !== stableJson(state.proactiveMailAlerts);
    } catch {
      this.setMailAlertRefreshRequired();
      throw new Error('Saved mail alert settings could not be safely checked. Refresh the workspace before continuing.');
    }
  }

  private newlyRequestedMailAlertCancellations(before: AppState, after: AppState): ProactiveMailAlertReceipt[] {
    const previous = new Map(before.proactiveMailAlerts.receipts.map((receipt) => [receipt.id, receipt]));
    return after.proactiveMailAlerts.receipts.filter((receipt) => {
      if (receipt.desired !== 'cancel' || receipt.observed === 'cancelled' || !receipt.cancellation) return false;
      const prior = previous.get(receipt.id);
      return !prior || prior.desired !== 'cancel' || prior.cancellation?.requestedAt !== receipt.cancellation.requestedAt;
    });
  }

  /**
   * Reconcile only cancellation intents created by this committed mutation.
   * The caller already owns the controller queue slot, so this never re-enters it.
   */
  private async cancelNewMailAlertIntents(receipts: readonly ProactiveMailAlertReceipt[]): Promise<void> {
    if (!receipts.length) return;
    try {
      await executeRequestedMailAlertCancellations(this.mailAlertEngineDependencies([]), {
        publishScoped: (saved) => { this.adoptScopedMailAlertState(saved); },
      }, receipts);
    } catch {
      // The intent is durable already. Keep the successful primary mutation successful;
      // the local reconcile action can retry this bounded cleanup later.
    }
  }

  private mailAlertPolicyOptions() {
    return { now: () => new Date(), digest: (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, { encoding: Crypto.CryptoEncoding.HEX }) };
  }

  async resolveProactiveMailAlertTap(key: MailAlertTapKey): Promise<MailAlertTapResolution> {
    const validUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    if (!key || !validUuid(key.installationId) || !validUuid(key.receiptId)) return { kind: 'ignored' };
    const tapped = Object.freeze({ installationId: key.installationId.toLowerCase(), receiptId: key.receiptId.toLowerCase() });
    try { await this.integration.privacySession?.assertCurrent(); }
    catch { return { kind: 'ignored' }; }
    if (!this.loaded || this.startupRecoveryPhase !== 'ready') return { kind: 'blocked' };

    const capturedBootstrapGeneration = this.bootstrapGeneration;
    const run = this.transactionQueue.then(async (): Promise<MailAlertTapResolution> => {
      if (!this.loaded || this.startupRecoveryPhase !== 'ready' || capturedBootstrapGeneration !== this.bootstrapGeneration) return { kind: 'blocked' };
      try { await this.integration.privacySession?.assertCurrent(); }
      catch { return { kind: 'ignored' }; }
      const capturedState = this.state;
      const statusForKnownReceipt = (receipt: ProactiveMailAlertReceipt, reason: 'revoked' | 'changed' | 'source_unavailable' | 'refresh_required' = 'refresh_required'): MailAlertTapResolution => {
        const currentInstallationId: unknown = this.state?.proactiveMailAlerts?.installationId;
        if (typeof currentInstallationId !== 'string' || tapped.installationId !== currentInstallationId.toLowerCase()) return { kind: 'ignored' };
        return { kind: 'status', receiptId: tapped.receiptId, ...(receipt ? { ruleId: receipt.ruleId, observed: receipt.observed } : {}), reason };
      };
      const statusOnlyIfWorkspaceCurrent = async (receipt: ProactiveMailAlertReceipt, reason: 'revoked' | 'changed' | 'source_unavailable' | 'refresh_required' = 'refresh_required'): Promise<MailAlertTapResolution> => {
        try { await this.integration.privacySession?.assertCurrent(); }
        catch { return { kind: 'ignored' }; }
        if (this.state !== capturedState || capturedBootstrapGeneration !== this.bootstrapGeneration || !this.loaded || this.startupRecoveryPhase !== 'ready') return { kind: 'blocked' };
        return statusForKnownReceipt(receipt, reason);
      };
      const refreshRequiredOnlyIfWorkspaceCurrent = async (receipt: ProactiveMailAlertReceipt): Promise<MailAlertTapResolution> => {
        const guarded = await statusOnlyIfWorkspaceCurrent(receipt, 'refresh_required');
        if (guarded.kind !== 'status') return guarded;
        if (this.state !== capturedState || capturedBootstrapGeneration !== this.bootstrapGeneration || !this.loaded || this.startupRecoveryPhase !== 'ready') return { kind: 'blocked' };
        this.setMailAlertRefreshRequired();
        return guarded;
      };
      if (this.proactiveMailAlertQuarantine.length) return { kind: 'ignored' };

      let alertState;
      let proactiveState;
      try { alertState = validateProactiveMailAlertState(this.state.proactiveMailAlerts); }
      catch { return { kind: 'ignored' }; }
      if (tapped.installationId !== alertState.installationId.toLowerCase()) return { kind: 'ignored' };
      const receipt = alertState.receipts.find((item) => item.id.toLowerCase() === tapped.receiptId);
      if (!receipt) return { kind: 'ignored' };
      const busy = Boolean(this.loadPromise || this.processJobs.size || this.assistJobs.size || this.activeSyncCount || this.syncJobs.size ||
        this.mailLaneJobs.size || this.foregroundMailJob || this.syncAbortControllers.size || this.credentialCleanupJob ||
        this.installingTokenRefs.size || this.mailReplyGenerations.size || this.transcriptionJobs.size || this.transcriptionCleanupJob ||
        this.transcriptionCleanupPromises.size || this.deviceCalendarJob || this.deviceEventJobs.size || this.deviceEventLateResults.size ||
        this.deviceEventCreateTimers.size || this.reminderJobs.size || this.reminderLegacyJobs.size || this.reminderReconcileJob ||
        this.recordingAttachmentJobs.size || this.recordingAttachmentSessions.size);
      if (busy) return { kind: 'blocked' };
      try {
        const privacyStatus = await this.integration.privacySession?.getStatus?.();
        await this.integration.privacySession?.assertCurrent();
        if (this.state !== capturedState || capturedBootstrapGeneration !== this.bootstrapGeneration) return { kind: 'blocked' };
        if (privacyStatus && (privacyStatus.phase !== 'ready' || privacyStatus.activeWriterCount !== 0 ||
            privacyStatus.pendingCleanupCount !== 0 || privacyStatus.failedCleanupCount !== 0)) return { kind: 'blocked' };
      } catch { return { kind: 'blocked' }; }
      if (this.mailAlertRefreshRequired) return statusForKnownReceipt(receipt, 'refresh_required');
      if (this.proactiveQuarantine) return statusForKnownReceipt(receipt, 'refresh_required');
      try { proactiveState = validateProactiveState(this.state.proactive); }
      catch { return statusForKnownReceipt(receipt, 'refresh_required'); }
      if (proactiveState.integrityError) return statusForKnownReceipt(receipt, 'refresh_required');
      const consent = alertState.consents.find((item) => item.id === receipt.consentId);
      if (receipt.desired === 'cancel' || ['cancellation_pending', 'cancelled', 'cancellation_unknown'].includes(receipt.observed) || !consent || consent.status !== 'active') {
        return statusForKnownReceipt(receipt, 'revoked');
      }
      const rule = proactiveState.rules.find((item) => item.id === receipt.ruleId);
      const account = mailAlertAccountsForWorkspace(this.state).find((item) => item.accountId === receipt.accountId);
      if (!rule || !rule.enabled || rule.version !== receipt.ruleVersion || rule.revision !== receipt.ruleRevision ||
          rule.accountIds.length > 0 && !rule.accountIds.includes(receipt.accountId) ||
          consent.ruleId !== receipt.ruleId || consent.ruleVersion !== receipt.ruleVersion || consent.ruleRevision !== receipt.ruleRevision ||
          consent.activatedAt !== receipt.consentActivatedAt || consent.timeZone !== receipt.timeZone || this.state.settings.timezone !== receipt.timeZone ||
          !account || !account.connected || account.authStatus !== 'connected' || !account.canReadMail || account.identityKey !== receipt.identityKey ||
          account.connectionGeneration !== receipt.connectionGeneration ||
          !consent.accounts.some((binding) => binding.accountId === receipt.accountId && binding.identityKey === receipt.identityKey && binding.connectionGeneration === receipt.connectionGeneration)) {
        return statusForKnownReceipt(receipt, 'changed');
      }
      const accountRows = this.state.accounts.filter((item) => item.id === receipt.accountId);
      const rows = this.state.mailbox.filter((item) => item.accountId === receipt.accountId && item.providerMessageId === receipt.providerMessageId &&
        item.verifiedIdentityKey === receipt.identityKey && item.connectionGeneration === receipt.connectionGeneration && !item.providerDeletedAt);
      if (accountRows.length !== 1 || rows.length !== 1) return statusForKnownReceipt(receipt, 'source_unavailable');
      const observedAt = rows[0].observedAt;
      const observedMs = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
      const beforeHashMs = Date.now();
      if (!Number.isFinite(observedMs) || observedMs > beforeHashMs || beforeHashMs - observedMs > 15 * 60_000) return statusForKnownReceipt(receipt, 'refresh_required');
      try { await this.integration.privacySession?.assertCurrent(); }
      catch { return { kind: 'ignored' }; }
      try {
        if (!this.store.assertCurrent) throw new Error('Workspace generation cannot be verified.');
        await this.store.assertCurrent();
      } catch {
        return refreshRequiredOnlyIfWorkspaceCurrent(receipt);
      }
      let source: ProactiveMailSource | undefined;
      try {
        const built = await buildProactiveMailSources(accountRows, rows, Date.now(), new Map(), this.mailAlertPolicyOptions().digest);
        source = built.find((item): item is ProactiveMailSource => item.kind === 'mail' && item.accountId === receipt.accountId && item.providerId === receipt.providerMessageId);
      } catch {
        try {
          if (!this.store.assertCurrent) throw new Error('Workspace generation cannot be verified.');
          await this.store.assertCurrent();
        } catch {
          return refreshRequiredOnlyIfWorkspaceCurrent(receipt);
        }
        try { await this.integration.privacySession?.assertCurrent(); }
        catch { return { kind: 'ignored' }; }
        if (this.state !== capturedState || capturedBootstrapGeneration !== this.bootstrapGeneration) return { kind: 'blocked' };
        return statusForKnownReceipt(receipt, 'source_unavailable');
      }
      try {
        if (!this.store.assertCurrent) throw new Error('Workspace generation cannot be verified.');
        await this.store.assertCurrent();
      } catch {
        return refreshRequiredOnlyIfWorkspaceCurrent(receipt);
      }
      try { await this.integration.privacySession?.assertCurrent(); }
      catch { return { kind: 'ignored' }; }
      if (capturedBootstrapGeneration !== this.bootstrapGeneration || this.state !== capturedState || !this.loaded ||
          this.startupRecoveryPhase !== 'ready' || this.mailAlertRefreshRequired || this.proactiveMailAlertQuarantine.length ||
          this.proactiveQuarantine || this.state.proactiveMailAlerts.installationId !== tapped.installationId) {
        return statusForKnownReceipt(receipt, 'refresh_required');
      }
      if (!source || source.availability !== 'available' || source.freshness !== 'fresh' || source.sourceVersion !== receipt.sourceVersion ||
          typeof source.receivedAt !== 'string' || Date.parse(source.receivedAt) !== Date.parse(receipt.receivedAt)) return statusForKnownReceipt(receipt, 'changed');
      const finalObserved = Date.parse(rows[0].observedAt ?? '');
      const nowMs = Date.now();
      if (!Number.isFinite(finalObserved) || finalObserved > nowMs || nowMs - finalObserved > 15 * 60_000) return statusForKnownReceipt(receipt, 'refresh_required');
      const bounded = (value: unknown, max: number): string | undefined => typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || undefined : undefined;
      const received = new Date(Date.parse(source.receivedAt)).toISOString();
      const checkedAt = new Date(finalObserved).toISOString();
      const accountRow = accountRows[0];
      return {
        kind: 'mail', receiptId: receipt.id, ruleId: receipt.ruleId, messageId: rows[0].id,
        sourceVersion: receipt.sourceVersion, subject: bounded(source.subject, 200) ?? 'Saved mail alert',
        ...(bounded(source.senderEmail, 160) ? { senderLabel: bounded(source.senderEmail, 160) } : {}),
        ...(bounded(source.snippet, 280) ? { snippet: bounded(source.snippet, 280) } : {}),
        accountLabel: bounded(accountRow.verifiedEmail ?? accountRow.email ?? accountRow.displayName, 100) ?? 'Connected account',
        receivedAt: received, checkedAt,
      };
    });
    this.transactionQueue = run.then(() => undefined, () => undefined);
    try { return await run; }
    catch { return { kind: 'blocked' }; }
  }

  private async commitMailAlertPlan(pages: readonly CommittedMailAlertPage[]): Promise<void> {
    if (this.proactiveMailAlertQuarantine.length) return;
    const draft = clone(this.state);
    const plan = planProactiveMailAlerts({
      state: draft.proactiveMailAlerts,
      rules: draft.proactive.rules,
      accounts: mailAlertAccountsForWorkspace(draft),
      pages,
      previousCandidates: draft.proactive.candidates.map((entry) => entry.candidate),
      dismissedCandidateIds: draft.proactive.dismissals.map((item) => item.candidateId),
      snoozes: draft.proactive.snoozes,
      now: now(), currentTimeZone: draft.settings.timezone, uuid: newId,
    });
    const changed = stableJson(draft.proactiveMailAlerts) !== stableJson(plan.nextState);
    if (changed) {
      draft.proactiveMailAlerts = plan.nextState;
      await this.commitMailAlertDraft(draft);
    }
    if (!plan.cancellationReceipts.length && !plan.newAttempts.length) return;
    const dependencies = this.mailAlertEngineDependencies(pages);
    const queueSlot = { publishScoped: (saved: AppState) => { this.adoptScopedMailAlertState(saved); } };
    if (plan.cancellationReceipts.length) await executeRequestedMailAlertCancellations(dependencies, queueSlot, plan.cancellationReceipts);
    if (plan.newAttempts.length) await executeReservedMailAlertAttempts(dependencies, queueSlot, plan.newAttempts);
  }

  private mailAlertEngineDependencies(pages: readonly CommittedMailAlertPage[]): ProactiveMailAlertEngineDependencies<AppState> {
    const writer = this.integration.withMailAlertNotificationWriter;
    const sessionEpoch = this.integration.privacySession?.epoch ?? '';
    return {
      backend: this.mailAlertBackend,
      sessionEpoch,
      getPrivacyStatus: async () => {
        const status = await this.integration.privacySession?.getStatus?.();
        if (!status) throw new Error('Mail alert privacy ownership is unavailable.');
        return status;
      },
      isDispatchGateOpen: () => !this.mailAlertRefreshRequired && this.loaded && this.startupRecoveryPhase === 'ready' && this.proactiveMailAlertQuarantine.length === 0,
      notificationWriter: {
        withNotificationWriter: async <T>(work: (scope: PrivacyWriterScope, store: import('../proactiveMailAlerts/engine').MailAlertScopedStore<AppState>) => Promise<T>) => {
          if (!writer) throw new Error('Mail alert notification ownership is unavailable.');
          return writer((scope, store) => work(scope, this.mailAlertScopedStore(scope, store)));
        },
      },
      isAttemptCurrent: (state, receipt) => isMailAlertAttemptCurrentForWorkspace(state, pages, receipt, this.mailAlertPolicyOptions()),
    };
  }

  async enableProactiveMailAlerts(input: { ruleId: string; expectedRuleVersion: number; expectedRuleRevision: number; timeZone: string; accountIds: string[] }): Promise<void> {
    await this.withMailAlertTransactionSlot(async () => {
      if (this.proactiveMailAlertQuarantine.length) throw new Error('Saved mail alert settings are held privately until recovery.');
      if (!Array.isArray(input.accountIds) || input.accountIds.length < 1 || input.accountIds.length > 64 || new Set(input.accountIds).size !== input.accountIds.length) {
        throw new Error('Choose between 1 and 64 verified accounts for mail alerts.');
      }
      const rule = this.state.proactive.rules.find((item) => item.id === input.ruleId);
      if (!rule || rule.version !== input.expectedRuleVersion || rule.revision !== input.expectedRuleRevision) throw new Error('This saved rule changed. Review it again before enabling alerts.');
      if (input.timeZone !== this.state.settings.timezone) throw new Error('The selected time zone changed. Review the current settings before enabling alerts.');
      const verified = mailAlertAccountsForWorkspace(this.state);
      const selected = input.accountIds.map((id) => {
        const account = verified.find((item) => item.accountId === id);
        if (!account || !account.connected || account.authStatus !== 'connected' || !account.canReadMail) throw new Error('Every selected account must be currently connected with verified mailbox access.');
        return account;
      });
      if (rule.accountIds.length && selected.some((account) => !rule.accountIds.includes(account.accountId))) throw new Error('Selected accounts must also be allowed by the saved rule.');
      const writer = this.integration.withMailAlertNotificationWriter;
      if (!writer) throw new Error('Mail alert permission is unavailable on this installation.');
      const permission = await writer(() => this.mailAlertBackend.requestPermission());
      if (permission !== 'authorized' && permission !== 'provisional') throw new Error('Notification permission was not granted. The saved alert settings were not changed.');
      const activatedAt = now();
      const consent = createProactiveMailAlertConsent({ id: newId(), rule, timeZone: input.timeZone, activatedAt, accounts: selected });
      const draft = clone(this.state);
      draft.proactiveMailAlerts = replaceProactiveMailAlertConsent(draft.proactiveMailAlerts, {
        id: consent.id, rule, timeZone: consent.timeZone, activatedAt, accounts: selected,
      });
      await this.commitMailAlertDraft(draft);
      const plan = planProactiveMailAlerts({ state: draft.proactiveMailAlerts, rules: draft.proactive.rules, accounts: mailAlertAccountsForWorkspace(draft), pages: [],
        previousCandidates: draft.proactive.candidates.map((entry) => entry.candidate), dismissedCandidateIds: draft.proactive.dismissals.map((item) => item.candidateId),
        snoozes: draft.proactive.snoozes, now: activatedAt, currentTimeZone: draft.settings.timezone, uuid: newId });
      if (plan.cancellationReceipts.length) {
        await executeRequestedMailAlertCancellations(this.mailAlertEngineDependencies([]),
          { publishScoped: (saved) => { this.adoptScopedMailAlertState(saved); } }, plan.cancellationReceipts);
      }
    });
  }

  async revokeProactiveMailAlerts(ruleId: string): Promise<void> {
    await this.withMailAlertTransactionSlot(async () => {
      if (this.proactiveMailAlertQuarantine.length) throw new Error('Saved mail alert settings are held privately until recovery.');
      const draft = clone(this.state);
      draft.proactiveMailAlerts = revokeProactiveMailAlertConsent(draft.proactiveMailAlerts, ruleId, now());
      await this.commitMailAlertDraft(draft);
      const plan = planProactiveMailAlerts({ state: draft.proactiveMailAlerts, rules: draft.proactive.rules, accounts: mailAlertAccountsForWorkspace(draft), pages: [],
        previousCandidates: draft.proactive.candidates.map((entry) => entry.candidate), dismissedCandidateIds: draft.proactive.dismissals.map((item) => item.candidateId),
        snoozes: draft.proactive.snoozes, now: now(), currentTimeZone: draft.settings.timezone, uuid: newId });
      if (plan.cancellationReceipts.length) await executeRequestedMailAlertCancellations(this.mailAlertEngineDependencies([]),
        { publishScoped: (saved) => { this.adoptScopedMailAlertState(saved); } }, plan.cancellationReceipts);
    });
  }

  async reconcileProactiveMailAlerts(): Promise<void> {
    await this.withMailAlertTransactionSlot(() => this.commitMailAlertPlan([]));
  }

  private async getRecordingRecoveryService(): Promise<RecordingRecoveryService> {
    if (this.integration.recordingRecovery && !this.integration.audioBoundary) return this.integration.recordingRecovery;
    this.recordingRecoveryPromise ??= (this.integration.recordingRecovery
      ? Promise.resolve(this.integration.recordingRecovery)
      : import('../audio/recovery').then((module) => module.recordingRecoveryService))
      .then((service) => this.integration.audioBoundary
        ? createPrivacyBoundRecordingRecoveryService(service, this.integration.audioBoundary)
        : service)
      .catch((error) => { this.recordingRecoveryPromise = undefined; throw error; });
    return this.recordingRecoveryPromise;
  }

  private async retryTranscriptionCleanup(): Promise<void> {
    if (this.transcriptionCleanupJob) return this.transcriptionCleanupJob;
    const job = (async () => {
      const activeLeaseIds = new Set([...this.transcriptionJobs.values()].map((item) => item.leaseId));
      for (const leaseId of this.transcriptionCleanupPromises) activeLeaseIds.add(leaseId);
      for (const lease of this.snapshot.transcription.cleanupLeases.filter((item) => item.outcome === 'pending_cleanup' && !activeLeaseIds.has(item.leaseId)).slice(0, 8)) {
        try {
          await this.speechClient.releaseUploadLease(lease.leaseId);
          await this.mutate((state) => {
            const current = state.transcription.cleanupLeases.find((item) => item.leaseId === lease.leaseId && item.attemptId === lease.attemptId);
            if (current?.outcome === 'pending_cleanup') current.outcome = 'released';
          });
        } catch { /* Keep the bounded lease obligation for the next explicit or startup cleanup pass. */ }
      }
    })();
    this.transcriptionCleanupJob = job;
    try { await job; } finally { if (this.transcriptionCleanupJob === job) this.transcriptionCleanupJob = undefined; }
  }

  private markTranscriptionCleanupPending(leaseId: string): void {
    const lease = this.snapshot.transcription.cleanupLeases.find((item) => item.leaseId === leaseId);
    if (lease && lease.outcome !== 'released' && ![...this.transcriptionJobs.values()].some((job) => job.leaseId === leaseId)) {
      void this.mutate((state) => {
        const current = state.transcription.cleanupLeases.find((item) => item.leaseId === leaseId);
        if (current && current.outcome !== 'released') current.outcome = 'pending_cleanup';
      }).then(() => this.retryTranscriptionCleanup()).catch(() => undefined);
    }
  }

  private trackTranscriptionCleanup(leaseId: string, cleanup: Promise<void>): void {
    this.transcriptionCleanupPromises.add(leaseId);
    void cleanup.catch(() => undefined).finally(() => {
      this.transcriptionCleanupPromises.delete(leaseId);
      this.markTranscriptionCleanupPending(leaseId);
    });
  }

  private addTranscriptionAttempt(state: AppState, attempt: TranscriptionAttempt): void {
    const max = 500;
    while (state.transcription.attempts.length >= max) {
      const index = state.transcription.attempts.findIndex((item) => ['completed', 'no_speech', 'failed', 'discarded'].includes(item.outcome) || item.outcome === 'cancelled' && !item.dispatchStarted && !item.reservation);
      if (index < 0) throw new Error('Speech history is full of unresolved attempts. Resolve an existing attempt before starting another transcription.');
      const [removed] = state.transcription.attempts.splice(index, 1);
      const leases = state.transcription.cleanupLeases.filter((lease) => lease.attemptId === removed.id);
      if (leases.some((lease) => lease.outcome !== 'released')) throw new Error('Speech cleanup is still pending. Retry cleanup before starting another transcription.');
      state.transcription.cleanupLeases = state.transcription.cleanupLeases.filter((lease) => lease.attemptId !== removed.id);
    }
    if (state.transcription.cleanupLeases.length >= 500) {
      const index = state.transcription.cleanupLeases.findIndex((lease) => lease.outcome === 'released');
      if (index < 0) throw new Error('Speech cleanup history is full of unresolved leases. Retry cleanup before starting another transcription.');
      state.transcription.cleanupLeases.splice(index, 1);
    }
    state.transcription.attempts.push(attempt);
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
    const result = { ...state } as AppState & { dispatchRecordQuarantine?: DispatchRecordQuarantineEntry[]; proactiveQuarantine?: unknown; proactiveMailAlertQuarantine?: unknown[]; backupImportQuarantine?: unknown[]; knowledgeQuarantine?: unknown[]; reminderQuarantine?: unknown[]; deviceCalendarQuarantine?: unknown[]; transcriptionQuarantine?: unknown[] };
    if (this.dispatchRecordQuarantine.length) result.dispatchRecordQuarantine = clone(this.dispatchRecordQuarantine);
    else delete result.dispatchRecordQuarantine;
    if (this.dispatchRecordQuarantine.length) result.dispatchRecoveryStatus = {
      quarantinedCount: this.dispatchRecordQuarantine.length,
      message: 'Some saved dispatch receipts could not be validated and are held privately. New external writes are disabled until recovery.',
    };
    else delete result.dispatchRecoveryStatus;
    if (this.proactiveQuarantine) result.proactiveQuarantine = clone(this.proactiveQuarantine);
    if (this.proactiveMailAlertQuarantine.length) result.proactiveMailAlertQuarantine = clone(this.proactiveMailAlertQuarantine);
    else delete result.proactiveMailAlertQuarantine;
    if (this.proactiveMailAlertQuarantine.length) result.proactiveMailAlertRecoveryStatus = {
      quarantined: true,
      message: 'Some saved mail alert settings could not be validated and are held privately. New mail alerts are disabled until recovery.',
    };
    else delete result.proactiveMailAlertRecoveryStatus;
    if (this.backupImportQuarantine.length) result.backupImportQuarantine = clone(this.backupImportQuarantine);
    if (this.knowledgeQuarantine.length) result.knowledgeQuarantine = clone(this.knowledgeQuarantine);
    if (this.reminderQuarantine.length) result.reminderQuarantine = clone(this.reminderQuarantine);
    if (this.deviceEventQuarantine.length) result.deviceCalendarQuarantine = clone(this.deviceEventQuarantine);
    if (this.transcriptionQuarantine.length) result.transcriptionQuarantine = clone(this.transcriptionQuarantine);
    delete result.mailAlertRefreshRequired;
    return result;
  }

  private publicState(state: AppState): AppState {
    const result = clone(state) as AppState & { dispatchRecordQuarantine?: unknown; proactiveQuarantine?: unknown; proactiveMailAlertQuarantine?: unknown; backupImportQuarantine?: unknown; knowledgeQuarantine?: unknown; reminderQuarantine?: unknown; deviceCalendarQuarantine?: unknown; transcriptionQuarantine?: unknown };
    delete result.dispatchRecordQuarantine;
    if (this.dispatchRecordQuarantine.length) result.dispatchRecoveryStatus = {
      quarantinedCount: this.dispatchRecordQuarantine.length,
      message: 'Some saved dispatch receipts could not be validated and are held privately. New external writes are disabled until recovery.',
    };
    else delete result.dispatchRecoveryStatus;
    delete result.proactiveQuarantine;
    delete result.proactiveMailAlertQuarantine;
    if (this.proactiveMailAlertQuarantine.length) result.proactiveMailAlertRecoveryStatus = {
      quarantined: true,
      message: 'Some saved mail alert settings could not be validated and are held privately. New mail alerts are disabled until recovery.',
    };
    else delete result.proactiveMailAlertRecoveryStatus;
    delete result.backupImportQuarantine;
    delete result.knowledgeQuarantine;
    delete result.reminderQuarantine;
    delete result.deviceCalendarQuarantine;
    delete result.transcriptionQuarantine;
    if (this.mailAlertRefreshRequired) result.mailAlertRefreshRequired = {
      required: true,
      message: 'Saved data changed. Refresh local data before continuing.',
    };
    else delete result.mailAlertRefreshRequired;
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
  private async mutate<T>(
    operation: (draft: AppState) => T | Promise<T>,
    saveOptions?: (draft: AppState, result: T) => Parameters<StateStore['save']>[1],
  ): Promise<T> {
    await this.assertPrivacySessionCurrent();
    const capturedBootstrapGeneration = this.bootstrapGeneration;
    const run = this.transactionQueue.then(async () => {
      if (capturedBootstrapGeneration !== this.bootstrapGeneration) throw new Error('The app restarted while this action was waiting. Review the current state and try again.');
      if (this.startupRecoveryPhase !== 'ready') throw new Error('App startup is not ready. Retry startup or complete the recovery flow first.');
      if (!this.loaded) await this.load();
      if (this.loadPromise) await this.loadPromise;
      await this.assertPrivacySessionCurrent();
      if (capturedBootstrapGeneration !== this.bootstrapGeneration || this.startupRecoveryPhase !== 'ready') throw new Error('App startup changed while this action was waiting. Review the current state and try again.');
      const before = clone(this.state);
      const draft = clone(before);
      const result = await operation(draft);
      await this.assertPrivacySessionCurrent();
      this.revokeStaleMailAlertConsent(draft);
      const newCancellationIntents = this.newlyRequestedMailAlertCancellations(before, draft);
      await this.evaluateProactiveDraft(draft);
      draft.reminders = validateReminderState(draft.reminders);
      draft.transcription = clone(validateTranscriptionState(draft.transcription));
      await this.assertPrivacySessionCurrent();
      try {
        await this.store.save(this.persistedState(draft), saveOptions?.(draft, result));
        await this.assertPrivacySessionCurrent();
        if (capturedBootstrapGeneration !== this.bootstrapGeneration || this.startupRecoveryPhase !== 'ready') {
          throw new Error('The app workspace changed while the update was being saved. Reopen the app before continuing.');
        }
        this.state = draft;
        this.snapshot = deepFreeze(this.publicState(draft));
        this.emit();
      } catch (error) {
        // A storage write can commit before save/ownership acknowledgement fails.
        // Require an explicit reload before this instance can write again.
        this.setMailAlertRefreshRequired();
        throw error;
      }
      await this.cancelNewMailAlertIntents(newCancellationIntents);
      return clone(result);
    });
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** A serialized local read/check that only commits when it actually changes state. */
  private async mutateIfChanged<T>(operation: (draft: AppState) => Promise<{ changed: boolean; result: T }> | { changed: boolean; result: T }): Promise<T> {
    await this.assertPrivacySessionCurrent();
    const capturedBootstrapGeneration = this.bootstrapGeneration;
    const run = this.transactionQueue.then(async () => {
      if (capturedBootstrapGeneration !== this.bootstrapGeneration) throw new Error('The app restarted while this action was waiting. Review the current state and try again.');
      if (this.startupRecoveryPhase !== 'ready') throw new Error('App startup is not ready. Retry startup or complete the recovery flow first.');
      if (!this.loaded) await this.load();
      if (this.loadPromise) await this.loadPromise;
      await this.assertPrivacySessionCurrent();
      if (capturedBootstrapGeneration !== this.bootstrapGeneration || this.startupRecoveryPhase !== 'ready') throw new Error('App startup changed while this action was waiting. Review the current state and try again.');
      const before = clone(this.state);
      const draft = clone(before);
      const { changed, result } = await operation(draft);
      const mailAlertsChanged = this.revokeStaleMailAlertConsent(draft);
      const newCancellationIntents = this.newlyRequestedMailAlertCancellations(before, draft);
      await this.assertPrivacySessionCurrent();
      if (changed || mailAlertsChanged) {
        await this.evaluateProactiveDraft(draft);
        draft.reminders = validateReminderState(draft.reminders);
        draft.transcription = clone(validateTranscriptionState(draft.transcription));
        await this.assertPrivacySessionCurrent();
        try {
          await this.store.save(this.persistedState(draft));
          await this.assertPrivacySessionCurrent();
          if (capturedBootstrapGeneration !== this.bootstrapGeneration || this.startupRecoveryPhase !== 'ready') {
            throw new Error('The app workspace changed while the update was being saved. Reopen the app before continuing.');
          }
          this.state = draft;
          this.snapshot = deepFreeze(this.publicState(draft));
          this.emit();
        } catch (error) {
          this.setMailAlertRefreshRequired();
          throw error;
        }
        await this.cancelNewMailAlertIntents(newCancellationIntents);
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
    if (!Array.isArray(provenance.knowledgeSelection)) throw new Error('This suggestion has no saved knowledge selection. Run Assist again before approving it.');
    const { documents, additionalSources } = assistContext(state, note, provenance.intent, provenance.question, provenance.knowledgeSelection);
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
        settings: state.settings, answeredAsOf: provenance.answeredAsOf ?? null, knowledgeSelection: provenance.knowledgeSelection ?? [],
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
    proposal.deviceCalendarApproval = undefined;
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
    await this.assertPrivacySessionCurrent();
    if (['failed', 'prepared', 'committing', 'committed_opening', 'unavailable'].includes(this.startupRecoveryPhase)) {
      throw new Error(this.startupRecoveryPhase === 'committed_opening'
        ? 'Fresh app data is committed. Retry startup to finish opening it.'
        : 'App startup failed. Use the explicit retry or recovery flow before continuing.');
    }
    return this.openStartupData();
  }

  /** Refreshes the UI cache after a headless worker changed the durable workspace. */
  async refreshPersistedWorkspace(): Promise<void> {
    await this.assertPrivacySessionCurrent(true);
    const recoveringMailAlertGate = this.mailAlertRefreshRequired;
    if ((!this.loaded || this.startupRecoveryPhase !== 'ready') && !recoveringMailAlertGate) {
      throw new Error('Workspace refresh is available only after startup is ready.');
    }
    const busy = () => Boolean(this.loadPromise ||
      this.processJobs.size || this.assistJobs.size || this.activeSyncCount || this.syncJobs.size ||
      this.mailLaneJobs.size || this.foregroundMailJob || this.syncAbortControllers.size ||
      this.credentialCleanupJob || this.installingTokenRefs.size || this.mailReplyGenerations.size ||
      this.backupImportSessions.size || this.knowledgeActivationSessions.size ||
      this.recordingAttachmentSessions.size || this.recordingAttachmentJobs.size ||
      this.transcriptionJobs.size || this.transcriptionCleanupJob || this.transcriptionCleanupPromises.size ||
      this.deviceCalendarJob || this.deviceEventJobs.size || this.deviceEventLateResults.size || this.deviceEventCreateTimers.size ||
      this.reminderJobs.size || this.reminderLegacyJobs.size || this.reminderReconcileJob
    );
    if (busy()) throw new Error('The workspace is busy. Try refreshing after current actions finish.');
    const capturedGeneration = this.bootstrapGeneration;
    const refresh = this.transactionQueue.then(async () => {
      await this.assertPrivacySessionCurrent(true);
      if (capturedGeneration !== this.bootstrapGeneration ||
          ((!this.loaded || this.startupRecoveryPhase !== 'ready') && !this.mailAlertRefreshRequired)) {
        throw new Error('The workspace changed before it could be refreshed. Reopen the app and try again.');
      }
      if (busy()) throw new Error('The workspace is busy. Try refreshing after current actions finish.');
      const privacyStatus = await this.integration.privacySession?.getStatus?.();
      await this.assertPrivacySessionCurrent(true);
      if (privacyStatus && (privacyStatus.phase !== 'ready' || privacyStatus.activeWriterCount !== 0 ||
          privacyStatus.pendingCleanupCount !== 0 || privacyStatus.failedCleanupCount !== 0)) {
        throw new Error('Workspace storage is still in use. Try refreshing after current actions finish.');
      }
      this.bootstrapGeneration += 1;
      this.loaded = false;
      this.loadPromise = undefined;
      await this.openStartupData(true);
      this.clearMailAlertRefreshRequired();
    });
    this.transactionQueue = refresh.then(() => undefined, () => undefined);
    await refresh;
  }

  private async openStartupData(allowMailAlertRefresh = false): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadInternal(allowMailAlertRefresh);
    try {
      await this.loadPromise;
      await this.discoverPendingStartupReceipt();
      if (this.startupRecoveryReceipt) await this.acknowledgeStartupRecoveryReceipt();
      else this.startupRecoveryPhase = 'ready';
    } catch (error) {
      await this.discoverPendingStartupReceipt();
      this.startupRecoveryPhase = this.startupRecoveryReceipt ? 'committed_opening' : 'failed';
      throw error;
    } finally { this.loadPromise = undefined; }
    if (this.state.pendingCredentialCleanup.length) void this.retryCredentialCleanup().catch(() => undefined);
  }

  private async discoverPendingStartupReceipt(): Promise<void> {
    if (this.startupRecoveryReceipt || !this.store.recovery) return;
    try {
      const inspection = await this.store.recovery.inspect();
      this.startupRecoveryInspection = inspection;
      if (inspection.pendingReceipt) this.startupRecoveryReceipt = validateRecoveryReceipt(inspection.pendingReceipt);
    } catch { /* Recovery inspection is optional and never changes ordinary startup data. */ }
  }

  private async acknowledgeStartupRecoveryReceipt(): Promise<void> {
    const receipt = this.startupRecoveryReceipt;
    if (!receipt) { this.startupRecoveryPhase = 'ready'; return; }
    const backend = this.store.recovery;
    if (!backend) { this.startupRecoveryPhase = 'committed_opening'; return; }
    try {
      await backend.acknowledgeOpened(receipt.operationId);
      this.startupRecoveryReceipt = undefined;
      this.startupRecoveryPlan = undefined;
      if (this.startupRecoveryInspection?.pendingReceipt?.operationId === receipt.operationId) {
        const inspection = { ...this.startupRecoveryInspection };
        delete inspection.pendingReceipt;
        this.startupRecoveryInspection = inspection;
      }
      this.startupRecoveryPhase = 'ready';
    } catch { this.startupRecoveryPhase = 'committed_opening'; }
  }

  async getStartupRecoveryStatus(): Promise<StartupRecoveryStatus> {
    if (this.startupRecoveryPhase !== 'failed') return { phase: this.startupRecoveryPhase, ...(this.startupRecoveryInspection ? { inspection: this.startupRecoveryInspection } : {}) };
    const backend = this.store.recovery;
    if (!backend) return { phase: 'unavailable' };
    const generation = this.bootstrapGeneration;
    try {
      const inspection = await backend.inspect();
      if (generation !== this.bootstrapGeneration || this.startupRecoveryPhase !== 'failed' || this.loaded) {
        return { phase: this.startupRecoveryPhase, ...(this.startupRecoveryInspection ? { inspection: this.startupRecoveryInspection } : {}) };
      }
      this.startupRecoveryInspection = inspection;
      if (inspection.pendingReceipt) {
        this.startupRecoveryReceipt = validateRecoveryReceipt(inspection.pendingReceipt);
        this.startupRecoveryPhase = 'committed_opening';
        return { phase: 'committed_opening', inspection };
      }
      return { phase: inspection.status === 'available' ? 'failed' : 'unavailable', inspection };
    } catch { return { phase: 'unavailable' }; }
  }

  async prepareStartupRecovery(): Promise<StartupRecoveryPlan> {
    if (this.startupRecoveryBusy) throw new Error('Another startup recovery action is already in progress.');
    if (this.loaded || this.startupRecoveryPhase !== 'failed') throw new Error('Recovery is available only after core startup fails.');
    const backend = this.store.recovery;
    if (!backend) { this.startupRecoveryPhase = 'unavailable'; throw new Error('This storage platform does not support startup recovery.'); }
    const generation = this.bootstrapGeneration;
    this.startupRecoveryBusy = true;
    try {
      const inspection = await backend.inspect();
      this.startupRecoveryInspection = inspection;
      if (generation !== this.bootstrapGeneration || this.startupRecoveryPhase !== 'failed' || this.loaded) throw new Error('Startup changed while recovery was being checked. Retry the status check.');
      if (inspection.status !== 'available' || inspection.pendingReceipt) throw new Error('Saved data is not eligible for archive-and-start-fresh recovery.');
      const plan = await backend.prepare();
      const expiresAt = validateRecoveryIso(plan.expiresAt, 'Recovery plan expiry');
      validateRecoveryId(plan.sessionId, 'Recovery session');
      validateRecoveryId(plan.planHash, 'Recovery plan');
      if (plan.operation !== 'archive_and_start_fresh' || Date.parse(expiresAt) <= Date.now() ||
          Date.parse(expiresAt) > Date.now() + STARTUP_RECOVERY_SESSION_MS + 5_000 || !Number.isSafeInteger(plan.evidenceBytes) || plan.evidenceBytes < 0 ||
          !Number.isSafeInteger(plan.archiveCount) || plan.archiveCount < 0 || generation !== this.bootstrapGeneration || this.startupRecoveryPhase !== 'failed' || this.loaded) {
        throw new Error('The startup recovery plan is invalid or expired. Check recovery status and prepare again.');
      }
      this.startupRecoveryPlan = Object.freeze({ ...plan });
      this.startupRecoveryPhase = 'prepared';
      return this.startupRecoveryPlan;
    } finally { this.startupRecoveryBusy = false; }
  }

  async cancelStartupRecovery(): Promise<void> {
    if (this.startupRecoveryBusy || this.startupRecoveryPhase === 'committing') throw new Error('Startup recovery is already committing and cannot be cancelled.');
    if (this.startupRecoveryPhase !== 'prepared') return;
    this.startupRecoveryPlan = undefined;
    this.startupRecoveryPhase = 'failed';
  }

  async commitStartupRecovery(input: StartupRecoveryCommitInput): Promise<StartupRecoveryReceipt> {
    if (this.startupRecoveryBusy) throw new Error('Another startup recovery action is already in progress.');
    const plan = this.startupRecoveryPlan;
    const backend = this.store.recovery;
    if (!backend || this.loaded || this.startupRecoveryPhase !== 'prepared' || !plan || input.sessionId !== plan.sessionId || input.planHash !== plan.planHash) {
      throw new Error('The startup recovery plan is not current. Prepare a new recovery plan.');
    }
    if (Date.parse(plan.expiresAt) <= Date.now()) { this.startupRecoveryPhase = 'failed'; this.startupRecoveryPlan = undefined; throw new Error('The startup recovery plan expired. Prepare a new one.'); }
    this.startupRecoveryBusy = true;
    this.startupRecoveryPhase = 'committing';
    this.bootstrapGeneration += 1;
    try {
      const replacement = initialState();
      validateReplacementSnapshot(replacement);
      let receipt: StartupRecoveryReceipt;
      try {
        receipt = validateRecoveryReceipt(await backend.commit(input, replacement));
        if (receipt.operationId !== input.sessionId) throw new Error('The recovery receipt does not match this confirmation session.');
      }
      catch (error) {
        // A backend may have durably committed before its response was lost.
        // Inspect its receipt before allowing another archive operation.
        let pending: StartupRecoveryReceipt | undefined;
        try {
          const inspection = await backend.inspect();
          this.startupRecoveryInspection = inspection;
          if (inspection.pendingReceipt) pending = validateRecoveryReceipt(inspection.pendingReceipt);
        }
        catch { /* Preserve the prepared plan if receipt status cannot yet be read. */ }
        if (pending) {
          if (pending.operationId !== input.sessionId) {
            this.startupRecoveryReceipt = pending;
            this.startupRecoveryPhase = 'committed_opening';
            throw new Error('A different recovery already committed and needs startup confirmation. Retry startup before continuing.');
          }
          receipt = pending;
        } else {
          this.startupRecoveryPhase = 'prepared';
          throw error;
        }
      }
      this.startupRecoveryReceipt = receipt;
      this.startupRecoveryInspection = {
        status: 'available', evidenceBytes: receipt.evidenceBytes,
        archiveCount: plan.archiveCount + (receipt.alreadyCommitted ? 0 : 1),
        pendingReceipt: { ...receipt, alreadyCommitted: true },
      };
      this.startupRecoveryPhase = 'committed_opening';
      this.resetRuntimeForFreshStartup();
      try { await this.openStartupData(); }
      catch { /* The archive-and-replace is durable; leave the receipt for an explicit startup retry. */ }
      return receipt;
    } finally { this.startupRecoveryBusy = false; }
  }

  async retryStartup(): Promise<void> {
    if (this.startupRecoveryBusy) throw new Error('Another startup recovery action is already in progress.');
    if (!['failed', 'prepared', 'unavailable', 'committed_opening'].includes(this.startupRecoveryPhase)) throw new Error('There is no failed startup to retry.');
    this.startupRecoveryBusy = true;
    this.bootstrapGeneration += 1;
    try {
      if (this.startupRecoveryPhase === 'committed_opening' && this.loaded && this.startupRecoveryReceipt) {
        await this.acknowledgeStartupRecoveryReceipt();
        if (this.startupRecoveryPhase === 'committed_opening') throw new Error('Fresh app data is open, but its recovery receipt could not be acknowledged. Retry startup again.');
        return;
      }
      this.startupRecoveryPlan = undefined;
      if (this.startupRecoveryPhase !== 'committed_opening') this.startupRecoveryPhase = 'failed';
      this.loaded = false;
      this.loadPromise = undefined;
      await this.openStartupData();
      if (this.startupRecoveryPhase === 'committed_opening') {
        await this.acknowledgeStartupRecoveryReceipt();
        if (this.startupRecoveryPhase === 'committed_opening') throw new Error('Fresh app data opened, but its recovery receipt could not be acknowledged. Retry startup again.');
      }
    } finally {
      this.startupRecoveryBusy = false;
    }
  }

  private resetRuntimeForFreshStartup(): void {
    this.state = initialState();
    this.loaded = false;
    this.loadPromise = undefined;
    this.proactiveQuarantine = undefined;
    this.backupImportQuarantine = [];
    this.knowledgeQuarantine = [];
    this.reminderQuarantine = [];
    this.deviceEventQuarantine = [];
    this.transcriptionQuarantine = [];
    this.dispatchRecordQuarantine = [];
    this.proactiveSourceHashMemo = new Map();
    this.analysisCache.clear();
    this.verifiedReminderForeground.clear();
    this.verifiedDeviceCalendarGeneration = undefined;
    this.snapshot = deepFreeze(this.publicState(this.state));
    this.emit();
  }

  private async loadInternal(allowMailAlertRefresh = false): Promise<void> {
    const capturedBootstrapGeneration = this.bootstrapGeneration;
    await this.assertPrivacySessionCurrent(allowMailAlertRefresh);
    this.verifiedReminderForeground.clear();
    this.verifiedDeviceCalendarGeneration = undefined;
    const loaded = await this.store.load();
    await this.assertPrivacySessionCurrent(allowMailAlertRefresh);
    if (capturedBootstrapGeneration !== this.bootstrapGeneration) throw new Error('The app workspace changed while startup was loading. Reopen the app before continuing.');
    const normalized: NormalizedLoadedState = loaded ? normalizeLoadedState(loaded) : initialState();
    this.dispatchRecordQuarantine = clone(normalized.dispatchRecordQuarantine ?? []);
    delete normalized.dispatchRecordQuarantine;
    this.backupImportQuarantine = clone((normalized as AppState & { backupImportQuarantine?: unknown[] }).backupImportQuarantine ?? []);
    delete (normalized as AppState & { backupImportQuarantine?: unknown[] }).backupImportQuarantine;
    this.knowledgeQuarantine = clone((normalized as AppState & { knowledgeQuarantine?: unknown[] }).knowledgeQuarantine ?? []);
    delete (normalized as AppState & { knowledgeQuarantine?: unknown[] }).knowledgeQuarantine;
    this.reminderQuarantine = clone((normalized as AppState & { reminderQuarantine?: unknown[] }).reminderQuarantine ?? []);
    delete (normalized as AppState & { reminderQuarantine?: unknown[] }).reminderQuarantine;
    this.transcriptionQuarantine = clone((normalized as AppState & { transcriptionQuarantine?: unknown[] }).transcriptionQuarantine ?? []);
    delete (normalized as AppState & { transcriptionQuarantine?: unknown[] }).transcriptionQuarantine;
    this.deviceEventQuarantine = clone((normalized as AppState & { deviceCalendarQuarantine?: unknown[] }).deviceCalendarQuarantine ?? []);
    delete (normalized as AppState & { deviceCalendarQuarantine?: unknown[] }).deviceCalendarQuarantine;
    this.state = normalized;
    this.state.transcription = clone(normalized.transcription);
    const persisted = loaded as (AppState & { proactiveQuarantine?: unknown }) | undefined;
    const proactive = normalizeProactiveData(persisted?.proactive, persisted?.proactiveQuarantine);
    this.proactiveQuarantine = proactive.quarantine;
    this.state.proactive = uncertainOnLoad(proactive.state);
    delete (this.state as AppState & { proactiveQuarantine?: unknown }).proactiveQuarantine;
    this.proactiveMailAlertQuarantine = clone((normalized as AppState & { proactiveMailAlertQuarantine?: unknown[] }).proactiveMailAlertQuarantine ?? []);
    delete (this.state as AppState & { proactiveMailAlertQuarantine?: unknown[] }).proactiveMailAlertQuarantine;
    for (const account of this.state.accounts) {
      this.state.syncStates[account.id] ??= emptySyncState(account.id);
      if (account.authStatus !== 'connected' || account.provider === 'local') continue;
      let token: StoredOAuthToken | null = null;
      try { token = account.tokenRef ? await this.integration.tokenStore?.get(account.tokenRef) ?? null : null; }
      catch { token = null; }
      await this.assertPrivacySessionCurrent(allowMailAlertRefresh);
      if (capturedBootstrapGeneration !== this.bootstrapGeneration) throw new Error('The app workspace changed while startup was loading. Reopen the app before continuing.');
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
    for (const record of this.state.deviceCalendars.dispatchRecords) {
      if (record.outcome !== 'pending') continue;
      try {
        const outcomeAt = new Date(Math.max(Date.now(), Date.parse(record.claimAt))).toISOString();
        const unknown = recordDeviceEventOutcome(record, { outcome: 'unknown', at: outcomeAt, observationSource: 'restart_recovery' });
        this.state.deviceCalendars.dispatchRecords[this.state.deviceCalendars.dispatchRecords.findIndex((item) => item.id === record.id)] = unknown;
      } catch { /* Invalid history is retained privately by normalization and never becomes authorization. */ }
    }
    const recoveredSpeech = this.state.transcription.attempts.map((attempt) => {
      if (attempt.outcome !== 'preparing' && attempt.outcome !== 'pending') return attempt;
      const terminalAt = new Date(Math.max(Date.now(), Date.parse(attempt.createdAt))).toISOString();
      return attempt.outcome === 'preparing'
        ? { ...attempt, outcome: 'failed' as const, code: 'preparation_interrupted' as const, terminalAt }
        : { ...attempt, outcome: 'unknown' as const, code: 'provider_unknown' as const, terminalAt };
    });
    this.state.transcription = {
      ...this.state.transcription,
      attempts: recoveredSpeech,
      cleanupLeases: this.state.transcription.cleanupLeases.map((lease) => lease.outcome === 'owned' ? { ...lease, outcome: 'pending_cleanup' as const } : lease),
    };
    for (const proposal of this.state.proposals) {
      if (proposal.deviceEventDispatchRecordId && proposal.status === 'dispatching') {
        const record = this.state.deviceCalendars.dispatchRecords.find((item) => item.id === proposal.deviceEventDispatchRecordId);
        proposal.status = record?.outcome === 'saved' ? 'accepted' : record?.outcome === 'rejected' ? 'failed' : 'unknown';
        proposal.deviceEventDispatchRecordId = record?.id;
        proposal.remoteId = record?.nativeEventId;
        proposal.remoteAcceptedAt = record?.outcomeAt;
        proposal.lastError = record?.outcome === 'unknown' || !record
          ? 'App closed while this on-device calendar action was in progress. Check the calendar manually; the event will not be created again.' : undefined;
      }
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
    this.revokeStaleMailAlertConsent(this.state);
    await this.evaluateProactiveDraft(this.state);
    const stateToSave = this.persistedState(this.state);
    await this.assertPrivacySessionCurrent(allowMailAlertRefresh);
    if (!loaded || JSON.stringify(stateToSave) !== JSON.stringify(loaded)) await this.store.save(stateToSave);
    await this.store.assertCurrent?.();
    await this.assertPrivacySessionCurrent(allowMailAlertRefresh);
    if (capturedBootstrapGeneration !== this.bootstrapGeneration) throw new Error('The app workspace changed while startup was loading. Reopen the app before continuing.');
    this.snapshot = deepFreeze(this.publicState(this.state));
    this.loaded = true;
    this.emit();
    if (this.state.transcription.cleanupLeases.some((lease) => lease.outcome === 'pending_cleanup')) void this.retryTranscriptionCleanup().catch(() => undefined);
    for (const document of this.state.documents) this.mirrorDirty.add(document.path);
    await this.retryDocumentMirrors();
  }

  async saveNote(input: SaveNoteInput): Promise<Note> {
    const transcript = input.transcript.trim();
    if (!transcript && !input.audioUri) throw new Error('Add a transcript or an audio recording first.');
    const durationSeconds = input.durationSeconds ?? 0;
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > MAX_DURATION_SECONDS) {
      throw new Error(`Recording duration must be between zero and ${MAX_DURATION_SECONDS} seconds.`);
    }
    const result = await this.mutate(async (state) => {
      const capturedDate = input.capturedAt ? new Date(input.capturedAt) : new Date();
      if (!Number.isFinite(capturedDate.getTime())) throw new Error('Recording start time is invalid.');
      const note: Note = {
        id: newId(), title: transcript ? transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72) : 'Audio note',
        transcript, ...(input.audioUri ? { audioUri: input.audioUri } : {}),
        durationSeconds, createdAt: now(), capturedAt: capturedDate.toISOString(), captureTimeZone: validTimezone(input.captureTimeZone ?? state.settings.timezone), status: 'recorded', revision: 1,
      };
      state.notes.unshift(note);
      addActivity(state, 'note_saved', transcript ? 'Transcript saved on this device.' : 'Audio saved. No transcript has been created yet.', { noteId: note.id });
      const docs = [...ensureMemoryDocuments(state), ...recordJournal(state, `note:${note.id}:r${note.revision}`, `Saved note ${note.title} (note ID ${note.id}, transcript revision ${note.revision}).`), ...ensurePeriodDocuments(state)];
      return { note, docs };
    });
    await Promise.all(result.docs.map((document) => this.mirrorDocument(document)));
    return result.note;
  }

  private async assertPendingCaptureWorkspaceAvailable(): Promise<void> {
    if (this.mailAlertRefreshRequired) {
      await this.assertPrivacySessionCurrent(true);
      if (!this.loaded || this.startupRecoveryPhase !== 'ready') throw new Error('Pending recording status is unavailable until workspace startup completes.');
      return;
    }
    await this.load();
  }

  async getPendingCaptureStatus(): Promise<PendingCaptureSafeStatus> {
    await this.assertPendingCaptureWorkspaceAvailable();
    return this.pendingCapture ? await this.pendingCapture.getStatus() : Object.freeze({ kind: 'blocked', reason: 'unsupported' });
  }

  async inspectPendingCapture(receipt: PendingCaptureReceipt): Promise<PendingCaptureSafeStatus> {
    await this.assertPendingCaptureWorkspaceAvailable();
    if (!this.pendingCapture) throw new Error('Pending recording recovery is unavailable on this platform.');
    return this.pendingCapture.inspect(Object.freeze({ ...receipt }));
  }

  async exportPendingCapture(receipt: PendingCaptureReceipt): Promise<void> {
    await this.assertPendingCaptureWorkspaceAvailable();
    if (!this.pendingCapture) throw new Error('Pending recording export is unavailable on this platform.');
    return this.pendingCapture.export(Object.freeze({ ...receipt }));
  }

  async discardPendingCapture(receipt: PendingCaptureReceipt): Promise<PendingCaptureSafeStatus> {
    await this.assertPendingCaptureWorkspaceAvailable();
    if (!this.pendingCapture) throw new Error('Pending recording discard is unavailable on this platform.');
    return this.pendingCapture.discard(Object.freeze({ ...receipt }));
  }

  async retryPendingCaptureSourceRelease(): Promise<PendingCaptureSafeStatus> {
    await this.assertPendingCaptureWorkspaceAvailable();
    if (!this.pendingCapture) throw new Error('Pending recording cleanup is unavailable on this platform.');
    return this.pendingCapture.retryPendingCaptureSourceRelease();
  }

  private async reconcileConsumedPendingCapture(receipt: PendingCaptureReceipt, expectedDraft: AppState, expectedJson: string): Promise<Note> {
    const capturedBootstrapGeneration = this.bootstrapGeneration;
    const reconcile = this.transactionQueue.then(async () => {
      await this.assertPrivacySessionCurrent(true);
      if (capturedBootstrapGeneration !== this.bootstrapGeneration || !this.loaded || this.startupRecoveryPhase !== 'ready' || !this.mailAlertRefreshRequired || !this.pendingCapture) {
        throw new Error('Pending recording recovery is not available. Refresh local data before continuing.');
      }
      const raw = await this.store.load();
      if (capturedBootstrapGeneration !== this.bootstrapGeneration || !this.mailAlertRefreshRequired || !raw || JSON.stringify(raw) !== expectedJson) {
        throw new Error('The pending recording save could not be verified. Refresh local data before continuing.');
      }
      const expectedNote = expectedDraft.notes.find((item) => item.id === receipt.id);
      const rawNote = raw.notes.find((item) => item.id === receipt.id);
      if (!expectedNote || !rawNote || !this.validConsumedPendingNote(rawNote, receipt.id) ||
          stableJson(rawNote) !== stableJson(expectedNote) || !await this.pendingCapture.readConsumedEvidence(receipt.id)) {
        throw new Error('The pending recording save could not be verified. Refresh local data before continuing.');
      }
      if (capturedBootstrapGeneration !== this.bootstrapGeneration || !this.store.assertCurrent) {
        throw new Error('The pending recording save could not be verified. Refresh local data before continuing.');
      }
      await this.store.assertCurrent();
      await this.assertPrivacySessionCurrent(true);
      if (capturedBootstrapGeneration !== this.bootstrapGeneration || !this.mailAlertRefreshRequired) {
        throw new Error('The pending recording save could not be verified. Refresh local data before continuing.');
      }

      // Only this exact atomic consume transaction may recover its own lost
      // acknowledgement. No normalization or replacement save is performed.
      const adoptedState = clone(expectedDraft);
      this.mailAlertRefreshRequired = false;
      let nextSnapshot: AppState;
      try { nextSnapshot = deepFreeze(this.publicState(adoptedState)); }
      catch (error) { this.mailAlertRefreshRequired = true; throw error; }
      this.state = adoptedState;
      this.snapshot = nextSnapshot;
      this.loaded = true;
      this.emit();
      return clone(expectedNote);
    });
    this.transactionQueue = reconcile.then(() => undefined, () => undefined);
    return reconcile;
  }

  private validConsumedPendingNote(note: Note | undefined, captureId: string): note is Note {
    if (!note || note.id !== captureId || note.status !== 'recorded' || note.revision !== 1 || note.transcript !== '' ||
        typeof note.audioUri !== 'string' || !/^file:\/\/[^\u0000-\u0020?#]+\/ExpoAudio\/recording-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.m4a$/i.test(note.audioUri) ||
        !Number.isFinite(note.durationSeconds) || note.durationSeconds <= 0 || note.durationSeconds > 600) return false;
    if (typeof note.capturedAt !== 'string') return false;
    const capturedAt = Date.parse(note.capturedAt);
    if (!Number.isFinite(capturedAt) || new Date(capturedAt).toISOString() !== note.capturedAt) return false;
    if (typeof note.captureTimeZone !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: note.captureTimeZone }).format(0); }
    catch { return false; }
    return true;
  }

  async savePendingCapture(receiptValue: PendingCaptureReceipt): Promise<Note> {
    const receipt = Object.freeze({ id: receiptValue.id, revision: receiptValue.revision });
    await this.load();
    if (!this.pendingCapture) throw new Error('Pending recording save is unavailable on this platform.');
    let adoption: Awaited<ReturnType<PendingCaptureControllerPort['readForAdoption']>> | undefined;
    let consumeWriteStarted = false;
    let consumedDraft: AppState | undefined;
    let consumedJson: string | undefined;
    try {
      const result = await this.mutate(async (state) => {
        adoption = await this.pendingCapture!.readForAdoption(receipt);
        const capture = adoption.capture;
        if (state.notes.some((note) => note.id === capture.id)) throw new Error('This recording is already in saved data.');
        const durationSeconds = capture.inspection?.outcome === 'known' ? capture.inspection.durationSeconds : undefined;
        if (durationSeconds === undefined || durationSeconds <= 0 || durationSeconds > 600) throw new Error('This recording is not eligible to save. Inspect it first.');
        const note: Note = {
          id: capture.id, title: 'Audio note', transcript: '', audioUri: adoption.uri, durationSeconds,
          createdAt: now(), capturedAt: capture.capturedAt, captureTimeZone: capture.captureTimeZone,
          status: 'recorded', revision: 1,
        };
        state.notes.unshift(note);
        addActivity(state, 'note_saved', 'Audio saved. No transcript has been created yet.', { noteId: note.id });
        const docs = [...ensureMemoryDocuments(state), ...recordJournal(state, `note:${note.id}:r${note.revision}`, `Saved note ${note.title} (note ID ${note.id}, transcript revision ${note.revision}).`), ...ensurePeriodDocuments(state)];
        return { note, docs };
      }, (draft) => {
        consumeWriteStarted = true;
        // Capture the precise validated candidate before the storage call. The
        // recovery path below may adopt it only if the consumed slot and the
        // complete persisted snapshot both prove that exact commit.
        consumedDraft = clone(draft);
        consumedJson = JSON.stringify(this.persistedState(draft));
        if (!consumedJson) throw new Error('The pending recording save could not be verified.');
        return { consumePendingCapture: { id: receipt.id, revision: receipt.revision, noteId: receipt.id } };
      });
      await Promise.all(result.docs.map((document) => this.mirrorDocument(document)));
      return result.note;
    } catch {
      if (!consumeWriteStarted) {
        const existing = this.state.notes.find((item) => item.id === receipt.id);
        if (existing && this.validConsumedPendingNote(existing, receipt.id)) {
          try {
            if (await this.pendingCapture.readConsumedEvidence(receipt.id)) return clone(existing);
          } catch { /* A held source-cleanup lease fails fast; it is not a reason to reload workspace state. */ }
        }
        throw new Error('The pending recording could not be saved. Check its status before trying again.');
      }
      // A process may lose the acknowledgement after the storage transaction committed.
      // Reload the exact persisted slot/snapshot before deciding whether adoption won.
      try {
        if (consumedDraft && consumedJson) return await this.reconcileConsumedPendingCapture(receipt, consumedDraft, consumedJson);
      } catch { /* Keep the hard gate unless this exact consumed transaction is proven. */ }
      throw new Error('The pending recording could not be saved. Check its status before trying again.');
    }
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

  private sourceReference(state: AppState, sourceId: string, note: Note): KnowledgeReference | undefined {
    if (sourceId === 'transcript') return { kind: 'note', id: note.id };
    if (sourceId.startsWith('note:')) {
      try { const id = decodeURIComponent(sourceId.slice(5)); return state.notes.some((item) => item.id === id) ? { kind: 'note', id } : undefined; }
      catch { return undefined; }
    }
    const knowledgeMatch = /^knowledge:(person|project):([0-9a-f-]+)$/.exec(sourceId);
    if (knowledgeMatch) {
      const kind = knowledgeMatch[1] as KnowledgeEntityKind, entityId = knowledgeMatch[2];
      const entity = getKnowledgeEntity(state.knowledge, kind, entityId);
      return entity && !entity.archivedAt ? { kind, id: entity.id } : undefined;
    }
    if (sourceId.startsWith('doc:')) { const id = sourceId.slice(4); return state.documents.some((item) => item.path === id) ? { kind: 'document', id } : undefined; }
    if (sourceId.startsWith('task:')) { try { const id = decodeURIComponent(sourceId.slice(5)); return state.tasks.some((item) => item.id === id) ? { kind: 'task', id } : undefined; } catch { return undefined; } }
    if (sourceId.startsWith('mail:')) {
      const parts = sourceId.slice(5).split(':'); if (parts.length !== 2) return undefined;
      try {
        const identity = decodeURIComponent(parts[0]), providerId = decodeURIComponent(parts[1]);
        const matches = state.mailbox.filter((item) => item.providerMessageId === providerId && item.verifiedIdentityKey === identity && item.identityKey === `${identity}:${providerId}` && !item.providerDeletedAt);
        if (matches.length !== 1) return undefined;
        const message = matches[0];
        const account = state.accounts.find((item) => item.id === message.accountId && item.connected && item.authStatus === 'connected' && identityKey(item) === identity && (item.connectionGeneration ?? 0) === (message.connectionGeneration ?? 0) && (item.capabilities ?? []).includes('mail.read'));
        return account ? { kind: 'mail', id: providerId, identityKey: identity, connectionGeneration: account.connectionGeneration ?? 0 } : undefined;
      } catch { return undefined; }
    }
    if (sourceId.startsWith('calendar-event:')) {
      const parts = sourceId.slice('calendar-event:'.length).split(':'); if (parts.length !== 3) return undefined;
      try {
        const identity = decodeURIComponent(parts[0]), calendarProviderId = decodeURIComponent(parts[1]), providerId = decodeURIComponent(parts[2]);
        const matches = state.calendarEvents.filter((item) => item.providerEventId === providerId && item.verifiedIdentityKey === identity && !item.providerDeletedAt &&
          state.calendars.some((calendar) => calendar.id === item.calendarId && (calendar.providerId ?? calendar.id) === calendarProviderId && calendar.accountId === item.accountId && calendar.connected));
        if (matches.length !== 1) return undefined;
        const event = matches[0];
        const account = state.accounts.find((item) => item.id === event.accountId && item.connected && item.authStatus === 'connected' && identityKey(item) === identity &&
          (item.connectionGeneration ?? 0) === (event.connectionGeneration ?? 0) && (item.capabilities ?? []).includes('calendar.read'));
        return account ? { kind: 'calendar', id: providerId, calendarId: calendarProviderId, identityKey: identity, connectionGeneration: account.connectionGeneration ?? 0 } : undefined;
      } catch { return undefined; }
    }
    if (sourceId.startsWith('device_calendar_event:')) {
      const parts = sourceId.slice('device_calendar_event:'.length).split(':');
      if (parts.length !== 4) return undefined;
      try {
        const [installationId, calendarId, eventId, occurrenceStart] = parts.map((part) => decodeURIComponent(part));
        const device = state.deviceCalendars;
        const matches = device.events.filter((event) => event.calendarId === calendarId && event.nativeEventId === eventId && event.occurrenceStart === occurrenceStart && !event.cancelled);
        if (matches.length !== 1 || matches[0].generation !== device.generation || !device.selectedCalendarIds.includes(calendarId) ||
            !this.deviceCalendarGenerationIsCurrent(state, device.generation, installationId)) return undefined;
        const age = Date.now() - Date.parse(matches[0].observedAt);
        return Number.isFinite(age) && age >= 0 && age < 15 * 60_000
          ? { kind: 'device_calendar_event', installationId, generation: device.generation, calendarId, eventId, occurrenceStart } : undefined;
      } catch { return undefined; }
    }
    return undefined;
  }

  private materializeAssistantMemorySuggestions(state: AppState, rows: DraftAnalysis['memorySuggestions'], note: Note, fingerprint: string): string[] {
    if (this.knowledgeQuarantine.length || !rows.length) return [];
    const ids: string[] = [];
    for (const row of rows.slice(0, 4)) {
      const match = /^knowledge:(person|project):([0-9a-f-]+)$/.exec(row.targetSourceId);
      if (!match) continue;
      const entityKind = match[1] as KnowledgeEntityKind, entityId = match[2];
      const target = getKnowledgeEntity(state.knowledge, entityKind, entityId);
      if (!target || target.archivedAt || target.revision !== row.targetRevision) continue;
      const evidence = row.evidence.map(({ sourceId, revision, sourceVersion, quote }) => ({
        sourceId: sourceId === 'transcript' ? `note:${note.id}` : sourceId, revision, sourceVersion, quote,
      }));
      let change: KnowledgeChange;
      if (row.type === 'add_fact' && row.statement) change = { type: 'add_fact', entityKind, entityId, statement: row.statement };
      else if (row.type === 'add_contact' && entityKind === 'person' && row.address && row.label !== null) change = { type: 'add_contact', entityKind: 'person', entityId, address: row.address, label: row.label };
      else if (row.type === 'add_source_link' && row.relatedSourceId && row.label !== null) {
        const reference = this.sourceReference(state, row.relatedSourceId, note); if (!reference) continue;
        try { this.assertKnowledgeReferenceExists(state, reference); } catch { continue; }
        change = { type: 'add_source_link', entityKind, entityId, reference,
          ...((reference.kind === 'person' || reference.kind === 'project') ? { referenceRevision: getKnowledgeEntity(state.knowledge, reference.kind, reference.id)!.revision } : {}), label: row.label };
      } else if (row.type === 'add_member' && entityKind === 'project' && row.relatedSourceId && row.role) {
        const personMatch = /^knowledge:person:([0-9a-f-]+)$/.exec(row.relatedSourceId);
        const person = personMatch && state.knowledge.people.find((item) => item.id === personMatch[1]);
        if (!person || person.archivedAt) continue;
        change = { type: 'add_member', entityKind: 'project', entityId, personId: person.id, personRevision: person.revision, role: row.role };
      } else continue;
      if (state.knowledge.suggestions.some((item) => ['pending', 'accepted'].includes(item.status) && stableJson(item.change) === stableJson(change))) continue;
      if (state.knowledge.suggestions.filter((item) => item.status === 'pending').length >= 200) break;
      const suggestion = validateKnowledgeSuggestion({ id: this.freshStateId(state), revision: 1, change, targetRevision: target.revision, evidence, status: 'pending', createdAt: now(), updatedAt: now(), sourceNoteId: note.id, sourceAnalysisFingerprint: fingerprint });
      state.knowledge.suggestions.push(suggestion); ids.push(suggestion.id);
      this.journalKnowledgeReview(state, 'created', suggestion, target.name);
    }
    state.knowledge = validateKnowledgeState(state.knowledge);
    return ids;
  }

  async refreshAnalysisStatus(noteId: string): Promise<NoteAssistResult | undefined> {
    await this.load();
    return this.mutateIfChanged(async (state) => {
      const note = state.notes.find((item) => item.id === noteId);
      if (!note?.analysis) return { changed: false, result: undefined };
      const analysis = note.analysis;
      const boundFingerprint = analysis.fingerprint;
      const boundSourceRevision = analysis.sourceRevision;
      const { documents, additionalSources, omittedSourceCount, omittedSourceIds } = assistContext(state, note, analysis.intent, analysis.question, analysis.knowledgeSelection ?? []);
      const request = {
        intent: analysis.intent, question: analysis.question,
        ...(analysis.answeredAsOf ? { queryTimeAnchor: analysis.answeredAsOf, queryTimeZone: analysis.answerTimeZone ?? state.settings.timezone } : {}),
        additionalSources, preselection: { omittedSourceCount, omittedSourceIds },
      };
      let currentVersions: Record<string, string>;
      if (state.settings.mode === 'provider' && analysis.source === 'provider') {
        currentVersions = (await this.openAiClient.prepare(note, documents, state.settings, request)).sourceVersions;
      } else {
        const calendarAvailable = usableDeviceCalendarSnapshot(state) || state.calendars.some((calendar) => {
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

  async assistNote(id: string, options: { intent?: AssistIntent; question?: string; forceRefresh?: boolean; knowledgeSelection?: KnowledgeSelection } = {}): Promise<NoteAssistResult> {
    const intent = options.intent ?? 'assist';
    const question = options.question?.trim() || undefined;
    const requestedAt = new Date();
    const queryBucket = intent === 'answer' && question ? Math.floor(requestedAt.getTime() / 900_000) : '';
    const knowledgeSelection = normalizeKnowledgeSelection(options.knowledgeSelection ?? []);
    const key = JSON.stringify([id, intent, question, queryBucket, knowledgeSelection, Boolean(options.forceRefresh)]);
    const existing = this.assistJobs.get(key);
    if (existing) return existing;
    const job = this.runAssistNote(id, { ...options, intent, question, knowledgeSelection }, requestedAt).finally(() => this.assistJobs.delete(key));
    this.assistJobs.set(key, job);
    return job;
  }

  private async runAssistNote(id: string, options: { intent?: AssistIntent; question?: string; forceRefresh?: boolean; knowledgeSelection?: KnowledgeSelection } = {}, requestedAt = new Date()): Promise<NoteAssistResult> {
    const intent = options.intent ?? 'assist';
    const question = options.question?.trim() || undefined;
    if (!['assist', 'summarize', 'answer', 'extract'].includes(intent)) throw new Error('Choose a supported assist action.');
    if (intent === 'answer' && !question) throw new Error('Add a question before asking about this note.');
    const state = this.snapshot;
    const note = state.notes.find((item) => item.id === id);
    if (!note) throw new Error('Note was not found.');
    this.requireConfirmedCaptureTimeZone(note);
    if (!note.transcript.trim()) throw new Error('This audio note has no transcript. Enter text or connect the speech provider before processing.');
    const knowledgeSelection = normalizeKnowledgeSelection(options.knowledgeSelection ?? []);
    for (const selected of knowledgeSelection) if (!getKnowledgeEntity(state.knowledge, selected.kind, selected.id)) throw new Error('One of the selected people or projects no longer exists. Refresh the selection and try again.');
    const sourceRevision = note.revision;
    const { documents: contextDocs, additionalSources: localSources, omittedSourceCount, omittedSourceIds } = assistContext(state, note, intent, question, knowledgeSelection);
    const capturedAt = note.capturedAt ?? note.createdAt;
    const answeredAsOf = intent === 'answer' && question ? requestedAt.toISOString() : undefined;
    const queryBucket = answeredAsOf ? Math.floor(requestedAt.getTime() / 900_000) : undefined;
    const request = { intent, question, ...(answeredAsOf ? { queryTimeAnchor: answeredAsOf, queryTimeZone: state.settings.timezone } : {}), additionalSources: localSources, preselection: { omittedSourceCount, omittedSourceIds } };
    const prepared = state.settings.mode === 'provider' ? await this.openAiClient.prepare(note, contextDocs, state.settings, request) : undefined;
    const transcriptVersion = `${note.revision}:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, note.transcript.replace(/\r\n?/g, '\n').normalize('NFC'))}`;
    const hasCompleteRemoteCalendar = state.calendars.some((calendar) => {
      const account = state.accounts.find((item) => item.id === calendar.accountId);
      const sync = state.syncStates[calendar.accountId];
      return Boolean(account?.connected && account.authStatus === 'connected' && calendar.connected && sync?.calendarsCompletedAt && sync.eventsCompletedAt[calendar.id]);
    });
    const hasCompleteDeviceCalendar = currentDeviceCalendarSnapshotAvailable(state);
    const hasUsableDeviceCalendar = usableDeviceCalendarSnapshot(state);
    const verifiedEvents = state.calendarEvents.filter((event) => {
      const calendar = state.calendars.find((item) => item.id === event.calendarId);
      const account = state.accounts.find((item) => item.id === event.accountId);
      return Boolean(calendar?.connected && account?.connected && account.authStatus === 'connected' && identityKey(account));
    });
    const offlineInputs = offlineAssistInputs(note, intent, question, localSources, hasCompleteRemoteCalendar || hasUsableDeviceCalendar);
    const offlineCatalog = state.settings.mode === 'preview' ? await createSourceCatalog(offlineInputs,
      async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes))) : undefined;
    const sourceVersions = prepared?.sourceVersions ?? Object.fromEntries(offlineCatalog?.sources.map((source) => [source.id, source.version]) ?? [['transcript', transcriptVersion]]);
    const processingFingerprint = JSON.stringify({ contractVersion: ASSIST_CONTRACT_VERSION, transcript: note.transcript, sourceRevision, sources: sourceVersions, settings: state.settings, intent, question, knowledgeSelection,
      capturedAt, captureTimeZone: note.captureTimeZone || state.settings.timezone,
      ...(answeredAsOf ? { queryBucket, queryTimeZone: state.settings.timezone } : {}),
    });
    if (!options.forceRefresh && note.analysis?.fingerprint === processingFingerprint) return clone(note.analysis);
    let generated: DraftAnalysis;
    if (state.settings.mode === 'provider') {
      const cached = options.forceRefresh ? undefined : this.analysisCache.get(processingFingerprint);
      if (cached) {
        generated = cached;
      } else {
        let reservation: { month: string; day: string; reserve: number } | undefined;
        generated = await this.openAiClient.analyze(note, contextDocs, state.settings, undefined, async () => { reservation = await this.recordProviderAttempt('model', state.settings); }, request, prepared);
        await this.settleModelUsage(generated, state.settings, reservation);
        this.analysisCache.set(processingFingerprint, generated);
      }
      if (this.snapshot.notes.find((item) => item.id === id)?.revision !== sourceRevision) throw new Error('The transcript changed during processing. The provider result was discarded.');
    } else {
      const proposals = extractPreviewProposals(note);
      const device = state.deviceCalendars, deviceRun = device.readRun;
      const deviceEvents = usableDeviceCalendarSnapshot(state) && deviceRun
        ? device.events.filter((event) => event.generation === device.generation && device.selectedCalendarIds.includes(event.calendarId) && !event.cancelled &&
          Date.now() - Date.parse(event.observedAt) >= 0 && Date.now() - Date.parse(event.observedAt) < 15 * 60_000 &&
          Date.parse(event.end) > Date.parse(deviceRun.window.timeMin) && Date.parse(event.start) < Date.parse(deviceRun.window.timeMax))
          .map(({ title, start, end, timeZone, allDay, notes, notesTruncated }) => ({ subject: title, start, end, timeZone, allDay, notes, notesTruncated })) : [];
      const preview = buildOfflinePreview({ intent, transcript: note.transcript, question, timeZone: answeredAsOf ? state.settings.timezone : note.captureTimeZone || state.settings.timezone, now: answeredAsOf ?? capturedAt, transcriptRevision: note.revision, transcriptSourceVersion: transcriptVersion,
        ...(intent === 'answer' ? { tasks: state.tasks.map(({ title, status, dueAt }) => ({ title, status, dueAt })), calendarEvents: verifiedEvents.map(({ subject, start, timeZone }) => ({ subject, start, timeZone })),
          deviceCalendarEvents: deviceEvents, deviceCalendarSnapshotAvailable: hasCompleteDeviceCalendar,
          deviceCalendarSnapshotPartial: hasUsableDeviceCalendar && !hasCompleteDeviceCalendar,
          calendarSnapshotAvailable: hasCompleteRemoteCalendar } : {}),
      });
      const offlineIncludedIds = offlineInputs.map((source) => source.id);
      generated = {
        summary: preview.summary, answer: preview.answer, decisions: preview.decisions, citations: preview.citations,
        clarifications: preview.clarifications, proposals: proposals.map(({ kind, title, body, recipients, dueAt, evidence }) => ({ kind, title, body, recipients, dueAt, evidence })),
        memorySuggestions: [],
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
    const memorySuggestionFingerprint = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, processingFingerprint, { encoding: Crypto.CryptoEncoding.HEX });
    const created: Proposal[] = generated.proposals.map((draft) => ({
      id: newId(), noteId: note.id, ...draft,
      ...(draft.kind === 'reminder' && draft.dueAt && Number.isFinite(Date.parse(draft.dueAt))
        ? { dueAt: new Date(Math.floor(Date.parse(draft.dueAt) / 1000) * 1000).toISOString() } : {}),
      status: 'draft', revision: 1,
      recipients: [...draft.recipients], sourceRevision: note.revision, evidence: draft.evidence.map((item) => ({ ...item })),
      sourceActionKey: sourceActionKey(note, draft.kind, draft.evidence),
      provenance: createProposalProvenance({ analysisFingerprint: processingFingerprint, note, intent, question, knowledgeSelection, sourceVersions: generated.sourceVersions, policySources, settings: state.settings, answeredAsOf }),
      requiresRebuild: false,
    }));

    const result = await this.mutate(async (draft) => {
      const current = this.note(draft, id);
      if (current.revision !== sourceRevision) throw new Error('The transcript changed during processing. Process the updated note again.');
      let stale = JSON.stringify(draft.settings) !== JSON.stringify(state.settings);
      try {
        const currentContext = assistContext(draft, current, intent, question, knowledgeSelection);
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
          sourceVersions: generated.sourceVersions, knowledgeSelection, stale: true,
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
      const memorySuggestionIds = this.materializeAssistantMemorySuggestions(draft, generated.memorySuggestions, current, memorySuggestionFingerprint);
      if (memorySuggestionIds.length) this.validateKnowledgeAndBackup(draft);
      const analysis: NoteAssistResult = {
        noteId: id, sourceRevision, intent, ...(question ? { question } : {}), fingerprint: processingFingerprint,
        analyzedAt: now(), capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: note.captureTimeZone || state.settings.timezone, ...(answeredAsOf ? { answeredAsOf, answerTimeZone: state.settings.timezone } : {}),
        summary: generated.summary, answer: generated.answer, decisions: generated.decisions, citations: generated.citations,
        clarifications: generated.clarifications, proposalIds: selected.map((proposal) => proposal.id), memorySuggestionIds,
        source: state.settings.mode === 'provider' ? 'provider' : 'offline_preview',
        includedSourceIds: generated.includedSourceIds, includedSources: generated.includedSources, omittedSourceIds: generated.omittedSourceIds, omittedSourceCount: generated.omittedSourceCount, sourceVersions: generated.sourceVersions, knowledgeSelection,
      };
      current.analysis = analysis;
      const docs = [
        ...recordJournal(draft, `processed:${id}:r${sourceRevision}`, `Processed note ${current.title}; ${created.length} review suggestion(s) created.`),
        ...created.filter((proposal) => !existingByAction.has(proposal.sourceActionKey!)).map((proposal) => appendInference(draft, proposal, state.settings.mode)),
        ...memorySuggestionIds.flatMap(() => draft.documents.filter((document) => document.path === 'memory/INFERENCES.md')),
      ];
      addActivity(draft, 'proposal_created', state.settings.mode === 'provider'
        ? `Azure OpenAI assisted with this recorded note and drafted ${created.length} review suggestion${created.length === 1 ? '' : 's'}.`
        : `Preview mode extracted ${created.length} suggestion${created.length === 1 ? '' : 's'} from your transcript. No provider was contacted.`, { noteId: id });
      if (memorySuggestionIds.length) this.validateKnowledgeAndBackup(draft);
      return { proposals: selected, analysis, docs: [...new Map(docs.map((document) => [document.path, document])).values()] };
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

  private reserveProviderAttemptDraft(state: AppState, kind: 'model' | 'speech', requestSettings: AppSettings, guard?: (state: AppState) => void): { month: string; day: string; reserve: number } {
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
  }

  private async recordProviderAttempt(kind: 'model' | 'speech', requestSettings: AppSettings, guard?: (state: AppState) => void): Promise<{ month: string; day: string; reserve: number }> {
    return this.mutate((state) => this.reserveProviderAttemptDraft(state, kind, requestSettings, guard));
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

  private async settleModelUsage(usage: Pick<ReplyGenerationUsage, 'inputTokens' | 'outputTokens' | 'usageEstimated'>, requestSettings: AppSettings, reservation: { month: string; day: string; reserve: number } | undefined): Promise<void> {
    // Mock providers and cache-only paths can return usage without a real dispatch claim.
    // They must not manufacture ledger charges.
    if (!reservation) return;
    await this.mutate((state) => {
      // A response belongs to the month in which its own dispatch was reserved.
      // A rollover since then must not charge or settle a newer month's request.
      if (state.usage.month !== reservation.month) return;
      state.usage.requests += 1;
      state.usage.inputTokens += usage.inputTokens;
      state.usage.outputTokens += usage.outputTokens;
      state.usage.lastRequestAt = now();
      const ratesKnown = !usage.usageEstimated && requestSettings.inputUsdPerMillionTokens !== undefined && requestSettings.outputUsdPerMillionTokens !== undefined;
      if (ratesKnown) {
        state.usage.reservedUsd = Math.max(0, state.usage.reservedUsd - reservation.reserve);
        state.usage.estimatedCostUsd += usage.inputTokens * requestSettings.inputUsdPerMillionTokens! / 1_000_000 + usage.outputTokens * requestSettings.outputUsdPerMillionTokens! / 1_000_000;
        // Settle only the final successful attempt; earlier retry attempts remain unknown charges.
        state.usage.unknownCharges = Math.max(0, state.usage.unknownCharges - 1);
      }
      state.usage.priceKnown = state.usage.unknownCharges === 0 && ratesKnown;
    });
  }

  private settleSpeechUsageDraft(state: AppState, seconds: number, requestSettings: AppSettings, reservation: { month: string; day: string; reserve: number }): void {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Provider duration is invalid.');
    if (state.usage.month !== reservation.month) return;
    state.usage.requests += 1;
    state.usage.transcriptionSeconds += seconds;
    state.usage.lastRequestAt = now();
    const rate = requestSettings.speechUsdPerMinute;
    if (rate !== undefined) {
      state.usage.reservedUsd = Math.max(0, state.usage.reservedUsd - reservation.reserve);
      state.usage.estimatedCostUsd += seconds / 60 * rate;
      state.usage.unknownCharges = Math.max(0, state.usage.unknownCharges - 1);
    }
    state.usage.priceKnown = state.usage.unknownCharges === 0 && rate !== undefined;
  }

  private finishTranscriptionReservationDraft(state: AppState, reservation: { month: string; day: string; reserve: number }): void {
    if (state.usage.month === reservation.month) {
      state.usage.unknownCharges = Math.max(0, state.usage.unknownCharges - 1);
      state.usage.reservedUsd = Math.max(0, state.usage.reservedUsd - reservation.reserve);
    }
    if (state.usage.day === reservation.day) state.usage.attemptsToday = Math.max(0, state.usage.attemptsToday - 1);
    state.usage.attempts = Math.max(0, state.usage.attempts - 1);
    state.usage.priceKnown = state.usage.unknownCharges === 0 && state.settings.speechUsdPerMinute !== undefined;
  }

  private async recoverOrphanedTranscriptions(noteId: string, excludeAttemptId?: string): Promise<number> {
    let recovered = 0;
    if (!this.snapshot.transcription.attempts.some((item) => item.noteId === noteId && item.id !== excludeAttemptId && (item.outcome === 'preparing' || item.outcome === 'pending'))) return 0;
    await this.mutate((state) => {
      const activeIds = new Set([...this.transcriptionJobs.values()].map((job) => job.attemptId));
      const candidates = state.transcription.attempts.filter((item) => item.noteId === noteId && item.id !== excludeAttemptId && !activeIds.has(item.id) && (item.outcome === 'preparing' || item.outcome === 'pending')).slice(-8);
      for (const attempt of candidates) {
        const terminalAt = new Date(Math.max(Date.now(), Date.parse(attempt.createdAt))).toISOString();
        attempt.outcome = attempt.outcome === 'preparing' ? 'failed' : 'unknown';
        attempt.code = attempt.outcome === 'failed' ? 'preparation_interrupted' : 'provider_unknown';
        attempt.terminalAt = terminalAt;
        const lease = state.transcription.cleanupLeases.find((item) => item.leaseId === attempt.leaseId);
        if (lease && lease.outcome !== 'released') lease.outcome = 'pending_cleanup';
        recovered += 1;
      }
    });
    return recovered;
  }

  transcribeNote(id: string, options?: { expectedRevision: number }): Promise<Note> {
    const requestedRevision = options?.expectedRevision ?? this.snapshot.notes.find((item) => item.id === id)?.revision ?? -1;
    const existing = this.transcriptionJobs.get(id);
    if (existing) {
      if (existing.sourceRevision !== requestedRevision) return Promise.reject(new Error('A transcription is already running for a different note revision.'));
      return existing.promise;
    }
    const controller = new AbortController();
    const attemptId = newId();
    const job: { attemptId: string; sourceRevision: number; leaseId: string; controller: AbortController; promise: Promise<Note> } = {
      attemptId, sourceRevision: requestedRevision, leaseId: newId(), controller, promise: Promise.resolve(undefined as unknown as Note),
    };
    const promise = this.transcribeNoteInternal(id, requestedRevision, attemptId, controller, job)
      .finally(() => {
        if (this.transcriptionJobs.get(id) === job) this.transcriptionJobs.delete(id);
        this.markTranscriptionCleanupPending(job.leaseId);
      });
    job.promise = promise;
    this.transcriptionJobs.set(id, job);
    return promise;
  }

  private async transcribeNoteInternal(id: string, requestedRevision: number, attemptId: string, controller: AbortController,
    job: { attemptId: string; sourceRevision: number; leaseId: string; controller: AbortController; promise: Promise<Note> }): Promise<Note> {
    await this.load();
    if (this.transcriptionQuarantine.length) throw new Error('Speech-transcription history failed integrity validation. New cloud transcription is disabled until recovery.');
    if (await this.recoverOrphanedTranscriptions(id, attemptId)) {
      void this.retryTranscriptionCleanup().catch(() => undefined);
      throw new Error('An earlier transcription was recovered as interrupted or uncertain. Review its status before starting a new transcription.');
    }
    const initial = this.snapshot;
    const note = initial.notes.find((item) => item.id === id);
    if (!note) throw new Error('Note was not found.');
    if (requestedRevision >= 0 && note.revision !== requestedRevision) throw new Error('The note changed before transcription. Review the current note and try again.');
    if (!note.audioUri) throw new Error('This note has no audio to transcribe.');
    if (note.audioAttachment?.durationStatus === 'unknown') throw new Error('This replacement recording has no verified duration. It cannot be sent for transcription.');
    if (!Number.isFinite(note.durationSeconds) || note.durationSeconds <= 0 || note.durationSeconds > initial.settings.maxAudioSeconds) throw new Error('The recording duration is outside the configured transcription limit.');
    if (!initial.settings.speechEnabled) throw new Error('Enable Azure Speech transcription in Settings before transcribing.');
    const speechEndpoint = initial.settings.speechEndpoint;
    if (!speechEndpoint) throw new Error('Add an Azure Speech endpoint before transcribing.');
    const sourceRevision = note.revision;
    const source = transcriptionSourceProjection(note, initial.settings);
    const settings = clone(initial.settings);
    const settingsProjection = speechSettingsProjection(settings);
    job.sourceRevision = sourceRevision;
    const attempt: TranscriptionAttempt = {
      id: attemptId, leaseId: job.leaseId, noteId: id, sourceRevision, source, endpoint: validateAzureEndpoint(speechEndpoint, 'speech'),
      locale: 'en-US', createdAt: now(), dispatchStarted: false, outcome: 'preparing',
    };
    await this.mutate((state) => {
      if (this.transcriptionQuarantine.length) throw new Error('Speech-transcription history failed integrity validation.');
      const current = state.notes.find((item) => item.id === id);
      if (!current || current.revision !== sourceRevision || stableJson(transcriptionSourceProjection(current, state.settings)) !== stableJson(source) || speechSettingsProjection(state.settings) !== settingsProjection) {
        throw new Error('The note or transcription settings changed before preparation. Review the current note and try again.');
      }
      this.addTranscriptionAttempt(state, attempt);
      if (state.transcription.cleanupLeases.length >= 500) throw new Error('Speech cleanup history is full. Retry cleanup before transcribing.');
      state.transcription.cleanupLeases.push({ leaseId: job.leaseId, attemptId, createdAt: now(), outcome: 'owned' });
    });

    const leaseId = job.leaseId;
    let preparedSnapshot: SpeechAudioSnapshot | undefined;
    const ensureCurrent = (state: AppState, outcome: 'preparing' | 'pending') => {
      const current = state.notes.find((item) => item.id === id);
      const savedAttempt = state.transcription.attempts.find((item) => item.id === attemptId);
      if (controller.signal.aborted) throw new Error('Transcription was cancelled.');
      if (this.transcriptionQuarantine.length || !state.settings.speechEnabled || speechSettingsProjection(state.settings) !== settingsProjection ||
          !current || current.revision !== sourceRevision || stableJson(transcriptionSourceProjection(current, state.settings)) !== stableJson(source)) throw new Error('The note or transcription settings changed. The transcription request was stopped.');
      if (!savedAttempt || savedAttempt.sourceRevision !== sourceRevision || savedAttempt.outcome !== outcome) throw new Error('The transcription attempt is no longer active.');
      return savedAttempt;
    };
    const onPrepared = async (prepared: PreparedSpeechAudio) => {
      const snapshot = validateSpeechAudioSnapshot(prepared);
      if (snapshot.leaseId !== leaseId) throw new Error('Prepared audio lease does not match this request.');
      await this.mutate((state) => {
        const savedAttempt = ensureCurrent(state, 'preparing');
        savedAttempt.prepared = snapshot;
        preparedSnapshot = snapshot;
      });
    };
    const onAttempt = async (prepared: PreparedSpeechAudio) => {
      const snapshot = validateSpeechAudioSnapshot(prepared);
      if (!preparedSnapshot || stableJson(snapshot) !== stableJson(preparedSnapshot)) throw new Error('Prepared audio changed before dispatch.');
      await this.mutate((state) => {
        const savedAttempt = ensureCurrent(state, 'preparing');
        const claim = this.reserveProviderAttemptDraft(state, 'speech', settings);
        savedAttempt.reservation = claim;
        savedAttempt.dispatchStarted = true;
        savedAttempt.outcome = 'pending';
      });
    };
    const beforeDispatch = (prepared: PreparedSpeechAudio) => {
      const snapshot = validateSpeechAudioSnapshot(prepared);
      const current = this.snapshot;
      const currentNote = current.notes.find((item) => item.id === id);
      const currentAttempt = current.transcription.attempts.find((item) => item.id === attemptId);
      if (controller.signal.aborted || this.mailAlertRefreshRequired || this.transcriptionQuarantine.length || !current.settings.speechEnabled || speechSettingsProjection(current.settings) !== settingsProjection ||
          !currentNote || currentNote.revision !== sourceRevision || stableJson(transcriptionSourceProjection(currentNote, current.settings)) !== stableJson(source) ||
          currentAttempt?.outcome !== 'pending' || !currentAttempt.reservation || stableJson(currentAttempt.prepared) !== stableJson(preparedSnapshot) || stableJson(snapshot) !== stableJson(preparedSnapshot)) {
        throw new Error('The note, audio, settings, or transcription claim changed before upload. No audio was sent.');
      }
    };

    let providerCleanup: Promise<void> | undefined;
    let providerResult: SpeechTranscriptionResult | undefined;
    try {
      const result = await this.speechClient.transcribe(note, settings, controller.signal, onAttempt, beforeDispatch, onPrepared, leaseId);
      providerResult = result;
      providerCleanup = result.cleanupPromise;
      if (!Number.isSafeInteger(result.durationMilliseconds) || result.durationMilliseconds <= 0 || result.durationMilliseconds > 600_000 ||
          !Number.isSafeInteger(result.billedEstimateSeconds) || result.billedEstimateSeconds !== Math.ceil(result.durationMilliseconds / 1000)) {
        throw new SpeechTranscriptionError('Speech duration could not be verified; provider charge status is unknown.', 'provider_unknown', true);
      }
      const transcriptHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, result.transcript);
      const savedNote = await this.mutate((state) => {
        const savedAttempt = state.transcription.attempts.find((item) => item.id === attemptId);
        if (!savedAttempt?.dispatchStarted || !savedAttempt.reservation) throw new Error('The dispatched transcription receipt was not found.');
        this.settleSpeechUsageDraft(state, result.billedEstimateSeconds, settings, savedAttempt.reservation);
        const current = state.notes.find((item) => item.id === id);
        const matches = Boolean(!controller.signal.aborted && current && current.revision === sourceRevision && stableJson(transcriptionSourceProjection(current, state.settings)) === stableJson(source));
        savedAttempt.outcome = controller.signal.aborted ? 'cancelled' : matches ? 'completed' : 'discarded';
        if (controller.signal.aborted) savedAttempt.code = 'cancelled';
        else if (!matches) savedAttempt.code = 'discarded';
        savedAttempt.terminalAt = now();
        savedAttempt.durationMilliseconds = result.durationMilliseconds;
        savedAttempt.billedEstimateSeconds = result.billedEstimateSeconds;
        savedAttempt.rateEstimated = settings.speechUsdPerMinute === undefined;
        savedAttempt.transcriptSha256 = transcriptHash.toLowerCase();
        const lease = state.transcription.cleanupLeases.find((item) => item.leaseId === leaseId);
        if (lease) lease.outcome = 'pending_cleanup';
        if (!matches || !current) return { note: current, discarded: true };
        current.transcript = result.transcript;
        current.title = result.transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72);
        current.revision += 1;
        current.status = 'recorded';
        delete current.processingFingerprint;
        if (current.analysis) current.analysis.stale = true;
        for (const proposal of state.proposals.filter((item) => item.noteId === id)) {
          if (['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'].includes(proposal.status)) continue;
          this.invalidate(proposal); proposal.status = 'draft';
        }
        addActivity(state, 'local_action', 'Audio transcribed by Azure Speech and saved to the note.', { noteId: id });
        return { note: current, discarded: false };
      });
      if (savedNote.discarded || !savedNote.note) throw new Error('The note changed while transcription was in progress. The valid provider result was recorded but not applied.');
      let updated = clone(savedNote.note);
      const terminal = this.snapshot.transcription.attempts.find((item) => item.id === attemptId);
      if (terminal?.outcome === 'completed' && this.snapshot.settings.audioRetention === 'delete_after_transcription' && source.audioUri) {
        const retentionUri = source.audioUri;
        try {
          const detach = await this.mutate((draft) => {
            const current = draft.notes.find((item) => item.id === id);
            if (!current || current.revision !== updated.revision || current.audioUri !== retentionUri || draft.settings.audioRetention !== 'delete_after_transcription' || draft.notes.some((other) => other.id !== id && other.audioUri === retentionUri)) return { note: current, detached: false };
            delete current.audioUri; delete current.audioAttachment;
            if (current.importOrigin?.kind === 'backup_import') current.importOrigin = { ...current.importOrigin, audioMissing: true };
            current.revision += 1; delete current.processingFingerprint; if (current.analysis) current.analysis.stale = true;
            for (const proposal of draft.proposals.filter((item) => item.noteId === id && ['draft', 'approved', 'failed'].includes(item.status))) { this.invalidate(proposal); proposal.status = 'draft'; }
            addActivity(draft, 'local_action', 'Original recording detached after transcription, as configured.', { noteId: id });
            return { note: current, detached: true };
          });
          if (detach.detached && detach.note) { try { await (this.integration.removeAudio?.(retentionUri) ?? removeAudio(retentionUri, this.integration.audioBoundary)); } catch { /* The note no longer references this private clip. */ } updated = clone(detach.note); }
        } catch { /* Durable transcript stays committed if clip cleanup fails. */ }
      }
      this.markTranscriptionCleanupPending(leaseId);
      if (providerCleanup) this.trackTranscriptionCleanup(leaseId, providerCleanup);
      return updated;
    } catch (error) {
      const typed = error instanceof SpeechTranscriptionError ? error : undefined;
      const cleanup = typed?.cleanupPromise ?? providerCleanup;
      // Register actual cleanup before any terminal journal write. If the
      // journal is hard-gated or its save fails, the provider promise still
      // remains tracked until its real I/O has settled.
      if (cleanup) this.trackTranscriptionCleanup(leaseId, cleanup);
      try {
        await this.mutate((state) => {
          const savedAttempt = state.transcription.attempts.find((item) => item.id === attemptId);
          if (!savedAttempt || ['completed', 'no_speech', 'failed', 'unknown', 'discarded', 'cancelled'].includes(savedAttempt.outcome)) return;
          const dispatched = typed ? typed.dispatched : savedAttempt.dispatchStarted;
          if (!dispatched && savedAttempt.reservation) {
            this.finishTranscriptionReservationDraft(state, savedAttempt.reservation);
            delete savedAttempt.reservation;
            savedAttempt.dispatchStarted = false;
          }
          const duration = typed?.durationMilliseconds ?? providerResult?.durationMilliseconds;
          if (dispatched && Number.isSafeInteger(duration) && duration! > 0 && duration! <= 600_000 && savedAttempt.reservation) {
            const billed = Math.ceil(duration! / 1000);
            this.settleSpeechUsageDraft(state, billed, settings, savedAttempt.reservation);
            savedAttempt.durationMilliseconds = duration;
            savedAttempt.billedEstimateSeconds = billed;
            savedAttempt.rateEstimated = settings.speechUsdPerMinute === undefined;
          }
          const code: SpeechAttemptCode = typed ? speechErrorCode(error) : dispatched ? 'provider_unknown' : speechErrorCode(error);
          savedAttempt.code = code; savedAttempt.terminalAt = now();
          savedAttempt.outcome = dispatched ? code === 'no_speech' ? 'no_speech' : code === 'provider_rejected' ? 'failed' : code === 'cancelled' ? 'cancelled' : 'unknown' : code === 'cancelled' ? 'cancelled' : 'failed';
          const lease = state.transcription.cleanupLeases.find((item) => item.leaseId === leaseId);
          if (lease) lease.outcome = 'pending_cleanup';
        });
      } catch (terminalError) {
        if (this.mailAlertRefreshRequired) {
          throw new Error('Transcription status could not be saved. Refresh local data and review the attempt before uploading again.');
        }
        throw terminalError;
      }
      throw error;
    }
  }

  async cancelTranscription(noteId: string, input?: { attemptId?: string }): Promise<{ status: 'cancelled' | 'already_terminal' | 'not_running' }> {
    const job = this.transcriptionJobs.get(noteId);
    if (job && (!input?.attemptId || input.attemptId === job.attemptId)) {
      job.controller.abort(new Error('Transcription cancelled by the user.'));
      return { status: 'cancelled' };
    }
    await this.load();
    const attempt = this.snapshot.transcription.attempts.filter((item) => item.noteId === noteId).at(-1);
    if (attempt && (attempt.outcome === 'preparing' || attempt.outcome === 'pending') && (!input?.attemptId || input.attemptId === attempt.id)) {
      await this.recoverOrphanedTranscriptions(noteId);
      this.markTranscriptionCleanupPending(attempt.leaseId);
      return { status: 'already_terminal' };
    }
    return attempt && ['completed', 'no_speech', 'failed', 'unknown', 'discarded', 'cancelled'].includes(attempt.outcome)
      ? { status: 'already_terminal' } : { status: 'not_running' };
  }

  private assertDeviceCalendarWritable(state: AppState): void {
    if (this.deviceEventQuarantine.length || state.deviceCalendarRecoveryStatus?.quarantined) {
      throw new Error('Device calendar history failed integrity validation. New device calendar actions are disabled until recovery.');
    }
  }

  private invalidatePendingDeviceEvents(state: AppState, reason: string): void {
    for (const proposal of state.proposals.filter((item) => item.eventDestination?.kind === 'device_calendar' && ['draft', 'approved', 'failed'].includes(item.status))) {
      this.invalidate(proposal);
      proposal.status = 'draft';
      proposal.lastError = reason;
    }
  }

  private deviceCalendarGenerationIsCurrent(state: AppState, generation: number, installationId = state.deviceCalendars.installationId): boolean {
    return !this.deviceEventQuarantine.length && state.deviceCalendars.installationId === installationId &&
      state.deviceCalendars.generation === generation && this.verifiedDeviceCalendarGeneration === generation &&
      state.deviceCalendarAccess.status === 'full_access';
  }

  private deviceEventProjection(state: AppState, proposal: Proposal, row?: DeviceCalendarRow): string | undefined {
    const approval = proposal.deviceCalendarApproval;
    const destination = proposal.eventDestination;
    if (proposal.kind !== 'event' || destination?.kind !== 'device_calendar' || !proposal.event || !approval) return undefined;
    const target = row ?? state.deviceCalendars.calendars.find((item) => item.localId === destination.calendarId);
    if (!target) return undefined;
    return JSON.stringify({ installationId: state.deviceCalendars.installationId, generation: state.deviceCalendars.generation,
      selectionRevision: state.deviceCalendars.selectionRevision, calendarId: target.localId, nativeId: target.nativeId,
      fingerprint: target.fingerprint, event: { title: proposal.event.title ?? proposal.title, notes: proposal.event.description ?? proposal.body,
        start: proposal.event.start, end: proposal.event.end, timeZone: proposal.event.timeZone, attendees: proposal.event.attendees, invitePolicy: proposal.event.invitePolicy } });
  }

  async checkDeviceCalendarAccess(): Promise<DeviceCalendarAccessState> {
    await this.load();
    const captured = this.snapshot.deviceCalendars;
    const permission = await this.deviceCalendarBackend.getPermission();
    return this.mutate((state) => {
      if (state.deviceCalendars.installationId !== captured.installationId || state.deviceCalendars.generation !== captured.generation) {
        throw new Error('Device calendar connection changed while permission was checked. Check access again.');
      }
      const next: DeviceCalendarAccessState = { status: permission, checkedAt: now() };
      if (permission !== 'full_access') {
        this.verifiedDeviceCalendarGeneration = undefined;
        state.deviceCalendars = { ...state.deviceCalendars, generation: state.deviceCalendars.generation + 1, enabled: false,
          selectedCalendarIds: [], events: [], readRun: undefined };
        this.invalidatePendingDeviceEvents(state, 'Device calendar access changed. Check access and review this event again.');
      } else this.verifiedDeviceCalendarGeneration = state.deviceCalendars.generation;
      state.deviceCalendarAccess = next;
      return next;
    });
  }

  async connectDeviceCalendars(input: { expectedGeneration: number }): Promise<DeviceCalendarAccessState> {
    await this.load();
    this.assertDeviceCalendarWritable(this.snapshot);
    const captured = this.snapshot.deviceCalendars;
    if (captured.generation !== input.expectedGeneration) throw new Error('Device calendar connection changed. Refresh before connecting.');
    const permission = await this.deviceCalendarBackend.requestFullPermission();
    if (permission !== 'full_access') {
      return this.mutate((state) => {
        if (state.deviceCalendars.generation !== captured.generation || state.deviceCalendars.installationId !== captured.installationId) throw new Error('Device calendar connection changed while permission was requested.');
        this.verifiedDeviceCalendarGeneration = undefined;
        state.deviceCalendarAccess = { status: permission, checkedAt: now() };
        state.deviceCalendars = { ...state.deviceCalendars, generation: state.deviceCalendars.generation + 1, enabled: false, selectedCalendarIds: [], events: [], readRun: undefined };
        this.invalidatePendingDeviceEvents(state, 'Device calendar access changed. Review this event again after reconnecting.');
        return state.deviceCalendarAccess;
      });
    }
    const discovery = await this.deviceCalendarBackend.listCalendars(captured.calendars);
    const result = await this.mutate((state) => {
      if (state.deviceCalendars.generation !== captured.generation || state.deviceCalendars.installationId !== captured.installationId) throw new Error('Device calendar connection changed while calendars were listed.');
      const generation = state.deviceCalendars.generation + 1;
      state.deviceCalendars = { ...state.deviceCalendars, generation, selectionRevision: state.deviceCalendars.selectionRevision + 1,
        enabled: true, calendars: discovery.calendars.slice(0, 100), selectedCalendarIds: [], events: [], readRun: undefined };
      state.deviceCalendarAccess = { status: 'full_access', checkedAt: now() };
      this.verifiedDeviceCalendarGeneration = generation;
      this.invalidatePendingDeviceEvents(state, 'Device calendar connection changed. Review this event again after selecting a calendar.');
      return state.deviceCalendarAccess;
    });
    return result;
  }

  async disconnectDeviceCalendars(input: { expectedGeneration: number }): Promise<DeviceCalendarState> {
    return this.mutate((state) => {
      this.assertDeviceCalendarWritable(state);
      const device = state.deviceCalendars;
      if (device.generation !== input.expectedGeneration) throw new Error('Device calendar connection changed. Refresh before disconnecting.');
      device.generation += 1;
      device.selectionRevision += 1;
      device.enabled = false;
      device.selectedCalendarIds = [];
      device.events = [];
      device.readRun = undefined;
      this.verifiedDeviceCalendarGeneration = undefined;
      state.deviceCalendarAccess = { status: 'needs_check' };
      this.invalidatePendingDeviceEvents(state, 'Device calendar access changed. Review this event again after reconnecting.');
      return device;
    });
  }

  async setDeviceCalendarSelection(input: { expectedGeneration: number; expectedSelectionRevision: number; calendarIds: string[] }): Promise<DeviceCalendarState> {
    return this.mutate((state) => {
      this.assertDeviceCalendarWritable(state);
      const device = state.deviceCalendars;
      if (!this.deviceCalendarGenerationIsCurrent(state, input.expectedGeneration) || device.selectionRevision !== input.expectedSelectionRevision) throw new Error('Device calendar access or selection changed. Refresh before selecting calendars.');
      if (!Array.isArray(input.calendarIds) || input.calendarIds.length > 20 || new Set(input.calendarIds).size !== input.calendarIds.length || input.calendarIds.some((id) => !device.calendars.some((row) => row.localId === id))) throw new Error('Choose up to 20 calendars from the current device calendar list.');
      device.selectedCalendarIds = [...input.calendarIds];
      device.selectionRevision += 1;
      device.readRun = undefined;
      this.invalidatePendingDeviceEvents(state, 'Device calendar selection changed. Review this event again.');
      return device;
    });
  }

  async refreshDeviceCalendars(input: { expectedGeneration: number; expectedSelectionRevision: number; continueRunId?: string }): Promise<DeviceCalendarState> {
    if (this.deviceCalendarJob) return this.deviceCalendarJob;
    const job = this.refreshDeviceCalendarsInternal(input);
    this.deviceCalendarJob = job;
    try { return await job; } finally { if (this.deviceCalendarJob === job) this.deviceCalendarJob = undefined; }
  }

  private async refreshDeviceCalendarsInternal(input: { expectedGeneration: number; expectedSelectionRevision: number; continueRunId?: string }): Promise<DeviceCalendarState> {
    await this.load();
    this.assertDeviceCalendarWritable(this.snapshot);
    const captured = clone(this.snapshot.deviceCalendars);
    if (!this.deviceCalendarGenerationIsCurrent(this.snapshot, input.expectedGeneration) || captured.selectionRevision !== input.expectedSelectionRevision || !captured.enabled) throw new Error('Connect device calendars and choose a current selection before refreshing.');
    let run = captured.readRun;
    if (input.continueRunId) {
      if (!run || run.runId !== input.continueRunId || run.generation !== captured.generation || run.selectionRevision !== captured.selectionRevision) throw new Error('This device calendar refresh continuation is no longer current. Start a fresh refresh.');
    } else {
      const at = Date.now();
      const selected = [...captured.selectedCalendarIds];
      run = { runId: newId(), generation: captured.generation, selectionRevision: captured.selectionRevision,
        window: { timeMin: new Date(at - 86_400_000).toISOString(), timeMax: new Date(at + 14 * 86_400_000).toISOString() },
        selectedCalendarIds: selected, cursor: 0, startedAt: new Date(at).toISOString(), completedCalendarIds: [], partial: false, truncatedCalendars: 0, truncatedEvents: 0 };
      validateDeviceCalendarReadWindow(run.window, 15);
      await this.mutate((state) => {
        if (!this.deviceCalendarGenerationIsCurrent(state, captured.generation, captured.installationId) || state.deviceCalendars.selectionRevision !== captured.selectionRevision) throw new Error('Device calendar access or selection changed before refresh.');
        state.deviceCalendars.readRun = run;
      });
    }
    const pageRun = clone(run);
    for (let count = 0; count < 4 && pageRun.cursor < pageRun.selectedCalendarIds.length; count++) {
      const calendarId = pageRun.selectedCalendarIds[pageRun.cursor];
      const capturedRow = pageRun && captured.calendars.find((row) => row.localId === calendarId);
      if (!capturedRow) throw new Error('A selected device calendar is no longer available.');
      const row = await this.deviceCalendarBackend.getCalendar(capturedRow.nativeId, capturedRow);
      if (row.fingerprint !== capturedRow.fingerprint) throw new Error('A selected device calendar changed. Refresh the calendar list and select it again.');
      if (!this.deviceCalendarGenerationIsCurrent(this.snapshot, captured.generation, captured.installationId) ||
          this.snapshot.deviceCalendars.selectionRevision !== captured.selectionRevision) throw new Error('Device calendar access or selection changed before the event read.');
      const read = await this.deviceCalendarBackend.readEvents(calendarId, row.nativeId, pageRun.window, now(), captured.generation);
      const permissionAfterRead = await this.deviceCalendarBackend.getPermission();
      if (permissionAfterRead !== 'full_access') {
        await this.mutate((state) => {
          if (state.deviceCalendars.generation !== captured.generation || state.deviceCalendars.installationId !== captured.installationId) return;
          this.verifiedDeviceCalendarGeneration = undefined;
          state.deviceCalendarAccess = { status: permissionAfterRead, checkedAt: now() };
          state.deviceCalendars = { ...state.deviceCalendars, generation: state.deviceCalendars.generation + 1, selectionRevision: state.deviceCalendars.selectionRevision + 1,
            enabled: false, selectedCalendarIds: [], events: [], readRun: undefined };
          this.invalidatePendingDeviceEvents(state, 'Device calendar access changed while events were read. Check access and review this event again.');
        });
        throw new Error('Device calendar access changed while events were read. The page was discarded.');
      }
      const freshAfterRead = await this.deviceCalendarBackend.getCalendar(row.nativeId, row);
      if (freshAfterRead.localId !== row.localId || freshAfterRead.nativeId !== row.nativeId || freshAfterRead.fingerprint !== row.fingerprint ||
          !this.deviceCalendarGenerationIsCurrent(this.snapshot, captured.generation, captured.installationId) ||
          this.snapshot.deviceCalendars.selectionRevision !== captured.selectionRevision || !this.snapshot.deviceCalendars.selectedCalendarIds.includes(calendarId)) {
        await this.mutate((state) => {
          if (state.deviceCalendars.generation !== captured.generation || state.deviceCalendars.installationId !== captured.installationId ||
              state.deviceCalendars.selectionRevision !== captured.selectionRevision) return;
          state.deviceCalendars = { ...state.deviceCalendars, selectionRevision: state.deviceCalendars.selectionRevision + 1,
            enabled: false, selectedCalendarIds: [], events: [], readRun: undefined };
          this.invalidatePendingDeviceEvents(state, 'A selected device calendar changed while events were read. Refresh and review this event again.');
        });
        throw new Error('A selected device calendar changed while events were read. The page was discarded.');
      }
      await this.mutate((state) => {
        if (!this.deviceCalendarGenerationIsCurrent(state, captured.generation, captured.installationId) || state.deviceCalendars.selectionRevision !== captured.selectionRevision || state.deviceCalendars.readRun?.runId !== pageRun.runId) throw new Error('Device calendar access, selection, or refresh changed while events were read. The page was discarded.');
        const currentRun = state.deviceCalendars.readRun!;
        if (currentRun.cursor !== pageRun.cursor || currentRun.selectedCalendarIds[currentRun.cursor] !== calendarId) throw new Error('Device calendar refresh page is out of order.');
        const windowStart = Date.parse(pageRun.window.timeMin), windowEnd = Date.parse(pageRun.window.timeMax);
        // Backend reads events that overlap the query window, including events
        // which began before its lower bound. Replace by overlap to keep one
        // canonical snapshot row when the same spanning event is refreshed.
        const keep = state.deviceCalendars.events.filter((event) => !(event.calendarId === calendarId &&
          Date.parse(event.end) > windowStart && Date.parse(event.start) < windowEnd));
        const room = Math.max(0, 500 - keep.length);
        const pageEvents = read.events.slice(0, room);
        state.deviceCalendars.events = [...keep, ...pageEvents];
        currentRun.cursor += 1;
        currentRun.completedCalendarIds = [...currentRun.completedCalendarIds, calendarId];
        currentRun.partial ||= read.partial || read.omitted > 0 || read.scanned > 2000 || pageEvents.length < read.events.length;
        if (read.partial || read.omitted) currentRun.truncatedCalendars += 1;
        currentRun.truncatedEvents += Math.max(read.omitted, read.events.length - pageEvents.length);
      });
      pageRun.cursor += 1;
    }
    return this.snapshot.deviceCalendars;
  }

  async inspectDeviceEventDispatch(recordId: string): Promise<{ record: DeviceEventDispatchRecord; lookup: import('../deviceCalendars').DeviceEventLookupResult }> {
    await this.load();
    const record = this.snapshot.deviceCalendars.dispatchRecords.find((item) => item.id === recordId);
    if (!record || record.outcome === 'pending') throw new Error('A terminal device event receipt is required before lookup.');
    const lookup = await this.deviceCalendarBackend.lookupRecord(record);
    return { record: clone(record), lookup: clone(lookup) };
  }

  async reconcileDeviceEventDispatch(recordId: string, input: { disposition: import('../deviceCalendars').DeviceEventReconciliation; note: string; nativeEventId?: string }): Promise<DeviceEventDispatchRecord> {
    return this.mutate((state) => {
      const index = state.deviceCalendars.dispatchRecords.findIndex((item) => item.id === recordId);
      if (index < 0) throw new Error('Device event receipt was not found.');
      const record = appendDeviceEventReconciliation(state.deviceCalendars.dispatchRecords[index], { id: newId(), disposition: input.disposition, at: now(), note: input.note, ...(input.nativeEventId ? { nativeEventId: input.nativeEventId } : {}) });
      state.deviceCalendars.dispatchRecords[index] = record;
      return record;
    });
  }

  async editProposal(id: string, patch: ProposalPatch, options?: { expectedRevision: number }): Promise<Proposal> {
    const result = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (options && proposal.revision !== options.expectedRevision) throw new Error('This proposal changed. Reopen the current version before editing.');
      if (['executed', 'accepted', 'simulated', 'dispatching', 'unknown', 'dismissed'].includes(proposal.status)) throw new Error('This proposal can no longer be edited.');
      if (proposal.kind === 'reminder') {
        const revision = proposal.notificationRevision ?? proposal.revision;
        await this.enqueueLegacyReminderCancellation(state, proposal.id, revision);
      }
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
      if (patch.eventDestination) {
        proposal.eventDestination = clone(patch.eventDestination);
        if (patch.eventDestination.kind === 'device_calendar') {
          proposal.accountId = undefined;
          proposal.calendarId = patch.eventDestination.calendarId;
        } else {
          proposal.accountId = patch.eventDestination.accountId;
          proposal.calendarId = patch.eventDestination.calendarId;
        }
        proposal.deviceCalendarApproval = undefined;
      }
      if (proposal.kind === 'event' && proposal.eventDestination?.kind === 'device_calendar' && proposal.event && (proposal.event.attendees.length || proposal.event.invitePolicy !== 'none')) {
        throw new Error('On-device events cannot include guests or invitations.');
      }
      proposal.recipients = [...new Set((proposal.recipients ?? []).map((recipient) => recipient.trim()).filter(Boolean))];
      this.invalidate(proposal);
      proposal.status = 'draft';
      addActivity(state, 'proposal_created', 'Suggestion edited. Review and approve the updated details.', { proposalId: id, noteId: proposal.noteId });
      return proposal;
    });
    if (result.kind === 'reminder') await this.reconcileReminderAlerts();
    return result;
  }

  async approveProposal(id: string, options?: { expectedRevision: number }): Promise<Proposal> {
    await this.load();
    const beforeApproval = this.snapshot.proposals.find((item) => item.id === id);
    if (options && beforeApproval?.revision !== options.expectedRevision) throw new Error('This proposal changed. Reopen the current version before approving.');
    let deviceApprovalPreflight: { revision: number; generation: number; selectionRevision: number; localId: string; row: DeviceCalendarRow } | undefined;
    if (beforeApproval?.kind === 'event' && beforeApproval.eventDestination?.kind === 'device_calendar') {
      const snapshot = this.snapshot;
      const device = snapshot.deviceCalendars;
      const row = device.calendars.find((item) => item.localId === beforeApproval.eventDestination!.calendarId);
      if (!row || !this.deviceCalendarGenerationIsCurrent(snapshot, device.generation) || !device.enabled || !device.selectedCalendarIds.includes(row.localId)) throw new Error('Connect device calendars, select this calendar, and check access before approving.');
      const fresh = await this.deviceCalendarBackend.getCalendar(row.nativeId, row);
      if (fresh.localId !== row.localId || fresh.fingerprint !== row.fingerprint || !fresh.allowsModifications) throw new Error('The selected device calendar changed. Refresh calendars and review this event again.');
      deviceApprovalPreflight = { revision: beforeApproval.revision, generation: device.generation, selectionRevision: device.selectionRevision, localId: row.localId, row: fresh };
    }
    const result = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (options && proposal.revision !== options.expectedRevision) throw new Error('This proposal changed while approval was checked. Reopen the current version before approving.');
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
        if (!proposal.event) throw new Error('Complete the event date, time zone, attendees, and invite policy before approving.');
        if (proposal.event) {
          const start = Date.parse(proposal.event.start);
          const end = Date.parse(proposal.event.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Event end must be later than its start.');
          try { new Intl.DateTimeFormat('en-US', { timeZone: proposal.event.timeZone }).format(); }
          catch { throw new Error('Choose a valid event time zone.'); }
          const title = proposal.event.title?.trim() || proposal.title;
          if (!title || /[\r\n]/.test(title)) throw new Error('Event title is required and cannot contain line breaks.');
          if (proposal.eventDestination?.kind === 'device_calendar') {
            if (proposal.event.invitePolicy !== 'none' || proposal.event.attendees.length !== 0) throw new Error('On-device events cannot include guests or invitations.');
            this.assertDeviceCalendarWritable(state);
            const device = state.deviceCalendars;
            if (!deviceApprovalPreflight || proposal.revision !== deviceApprovalPreflight.revision || device.generation !== deviceApprovalPreflight.generation ||
                device.selectionRevision !== deviceApprovalPreflight.selectionRevision || !this.deviceCalendarGenerationIsCurrent(state, device.generation) || !device.enabled || !device.selectedCalendarIds.includes(proposal.eventDestination.calendarId)) throw new Error('Device calendar access changed while approval was checked. Review this event again.');
            const row = device.calendars.find((item) => item.localId === proposal.eventDestination!.calendarId);
            const fresh = deviceApprovalPreflight.row;
            if (!row || !row.allowsModifications || row.localId !== fresh.localId || row.fingerprint !== fresh.fingerprint) throw new Error('Choose a writable selected device calendar.');
            if (fresh.localId !== row.localId || fresh.fingerprint !== row.fingerprint || !fresh.allowsModifications || !this.deviceCalendarGenerationIsCurrent(state, device.generation) || state.deviceCalendars.selectionRevision !== device.selectionRevision) throw new Error('The selected device calendar changed. Refresh calendars and review this event again.');
            proposal.accountId = undefined;
            proposal.calendarId = row.localId;
            proposal.event = { ...proposal.event, title, description: proposal.event.description ?? proposal.body, attendees: [], invitePolicy: 'none' };
            const dependencyProjection = JSON.stringify({ installationId: device.installationId, generation: device.generation, selectionRevision: device.selectionRevision,
              calendarId: row.localId, nativeId: row.nativeId, fingerprint: row.fingerprint,
              event: { title, notes: proposal.event.description ?? proposal.body, start: proposal.event.start, end: proposal.event.end, timeZone: proposal.event.timeZone,
                attendees: proposal.event.attendees, invitePolicy: proposal.event.invitePolicy } });
            const payloadDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, dependencyProjection);
            proposal.deviceCalendarApproval = { version: 1, installationId: device.installationId, generation: device.generation, selectionRevision: device.selectionRevision,
              calendarId: row.localId, nativeCalendarId: row.nativeId, calendarFingerprint: row.fingerprint, payloadDigest, dependencyProjection, approvedAt: now() };
          } else {
            const destination = proposal.eventDestination?.kind === 'remote_calendar'
              ? proposal.eventDestination : proposal.accountId && proposal.calendarId
                ? { kind: 'remote_calendar' as const, accountId: proposal.accountId, calendarId: proposal.calendarId } : undefined;
            if (!destination) throw new Error('Choose either a verified account calendar or selected device calendar.');
            const calendar = state.calendars.find((item) => item.id === destination.calendarId);
            if (!calendar || calendar.accountId !== destination.accountId) throw new Error('The selected calendar does not belong to the selected account.');
            if (!['send', 'none'].includes(proposal.event.invitePolicy) || proposal.event.attendees.some((attendee) => !validEmail(attendee))) throw new Error('Check the event invite policy and attendee addresses.');
            proposal.eventDestination = destination;
            proposal.accountId = destination.accountId;
            proposal.calendarId = destination.calendarId;
            proposal.deviceCalendarApproval = undefined;
            proposal.event = { ...proposal.event, title, description: proposal.event.description ?? proposal.body };
          }
        }
      }
      if (proposal.kind === 'reminder' && proposal.dueAt) {
        if (!Number.isFinite(Date.parse(proposal.dueAt))) throw new Error('Enter a valid reminder date and time.');
        if (new Date(proposal.dueAt).toISOString() !== proposal.dueAt || !proposal.dueAt.endsWith('.000Z')) {
          throw new Error('Edit this reminder time to whole seconds, then approve it again.');
        }
      }
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

  async executeProposal(id: string, options?: { expectedRevision: number }): Promise<Proposal> {
    await this.load();
    const beforeExecute = this.snapshot.proposals.find((item) => item.id === id);
    if (options && beforeExecute?.revision !== options.expectedRevision) throw new Error('This proposal changed. Reopen the current version before continuing.');
    let deviceEventPreflight: { revision: number; generation: number; selectionRevision: number; row: DeviceCalendarRow } | undefined;
    if (beforeExecute?.kind === 'event' && beforeExecute.eventDestination?.kind === 'device_calendar') {
      const snapshot = this.snapshot;
      const device = snapshot.deviceCalendars;
      const row = device.calendars.find((item) => item.localId === beforeExecute.eventDestination!.calendarId);
      if (!row || !this.deviceCalendarGenerationIsCurrent(snapshot, device.generation) || !device.enabled || !device.selectedCalendarIds.includes(row.localId)) throw new Error('Device calendar access or selection is no longer current.');
      const fresh = await this.deviceCalendarBackend.getCalendar(row.nativeId, row);
      if (fresh.fingerprint !== row.fingerprint || !fresh.allowsModifications) throw new Error('The selected device calendar changed. Refresh and approve the event again.');
      deviceEventPreflight = { revision: beforeExecute.revision, generation: device.generation, selectionRevision: device.selectionRevision, row: fresh };
    }
    const claim = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (options && proposal.revision !== options.expectedRevision) throw new Error('This proposal changed while execution was checked. Reopen the current version before continuing.');
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
        if (new Date(proposal.dueAt).toISOString() !== proposal.dueAt || !proposal.dueAt.endsWith('.000Z')) throw new Error('This older reminder uses an unverified fractional time. Edit its time and approve it again.');
        if (proposal.provenance?.version !== 1 || !proposal.noteId || !Number.isSafeInteger(proposal.sourceRevision)) throw new Error('This reminder has no verifiable source note. Run Assist again before saving it.');
        const note = state.notes.find((item) => item.id === proposal.noteId);
        const transcriptVersion = proposal.provenance.sources.find((source) => source.sourceId === 'transcript')?.sourceVersion;
        const quote = proposal.evidence.find((item) => item.quote)?.quote;
        if (!note || !transcriptVersion || !quote) throw new Error('The reminder source evidence is incomplete. Run Assist again before saving it.');
        let reminder = state.reminders.records.find((item) => item.origin.kind === 'note' && item.origin.proposalId === proposal.id && item.status !== 'cancelled');
        if (!reminder) {
          if (state.reminders.records.length >= 500) throw new Error('Reminder storage is full. Export or delete an old reminder first.');
          const time = now();
          const payload = validateReminderPayload({ title: proposal.title, body: proposal.body, dueAt: proposal.dueAt,
            displayTimeZone: state.settings.timezone, privacyMode: 'private' });
          const origin: ReminderRecord['origin'] = { kind: 'note', noteId: note.id, proposalId: proposal.id, proposalRevision: proposal.revision,
            sourceRevision: proposal.sourceRevision!, sourceVersion: transcriptVersion, quote };
          const approvedBase = { ...payload, id: this.freshStateId(state), revision: 1, origin, status: 'approved' as const,
            createdAt: time, updatedAt: time, approvedRevision: 1 };
          reminder = validateReminderRecord({ ...approvedBase, approvedPayloadDigest: await this.reminderApprovalDigest(approvedBase as ReminderRecord) });
          state.reminders.records.unshift(reminder);
        }
        proposal.reminderId = reminder.id;
      }
      if (await approvedDigest(proposal, state) !== proposal.approvedPayloadDigest) throw new Error('The approved content or destination changed. Review and approve it again.');
      let deviceEventRecord: DeviceEventDispatchRecord | undefined;
      if (proposal.kind === 'event' && proposal.eventDestination?.kind === 'device_calendar') {
        this.assertDeviceCalendarWritable(state);
        if (proposal.event?.attendees.length || proposal.event?.invitePolicy !== 'none') throw new Error('On-device events cannot include guests or invitations.');
        const approval = proposal.deviceCalendarApproval;
        const device = state.deviceCalendars;
        const row = device.calendars.find((item) => item.localId === proposal.eventDestination!.calendarId);
        if (!approval || !row || !device.selectedCalendarIds.includes(row.localId) || !row.allowsModifications ||
            !this.deviceCalendarGenerationIsCurrent(state, approval.generation, approval.installationId) || approval.calendarId !== row.localId ||
            approval.nativeCalendarId !== row.nativeId || approval.calendarFingerprint !== row.fingerprint || approval.selectionRevision !== device.selectionRevision ||
            approval.dependencyProjection !== this.deviceEventProjection(state, proposal, row)) {
          throw new Error('Device calendar, selection, or approved source changed. Refresh and approve this event again.');
        }
        const fresh = deviceEventPreflight?.row;
        if (!deviceEventPreflight || deviceEventPreflight.revision !== proposal.revision || deviceEventPreflight.generation !== approval.generation ||
            deviceEventPreflight.selectionRevision !== approval.selectionRevision || !fresh || fresh.fingerprint !== row.fingerprint || !fresh.allowsModifications ||
            !this.deviceCalendarGenerationIsCurrent(state, approval.generation, approval.installationId)) throw new Error('Device calendar access or details changed. Refresh and approve this event again.');
        if (device.dispatchRecords.length >= 1000) throw new Error('Device event receipt history is full. Export or reconcile old history before creating another event.');
        proposal.status = 'dispatching';
        const sourceActionKey = proposal.sourceActionKey ?? JSON.stringify([proposal.noteId, proposal.sourceRevision, 'event', proposal.evidence.map((item) => item.quote)]);
        proposal.sourceActionKey = sourceActionKey;
        deviceEventRecord = createDeviceEventDispatchRecord({ id: newId(), claimAt: now(), proposal,
          target: { installationId: device.installationId, generation: device.generation, selectionRevision: device.selectionRevision,
            calendarLocalId: row.localId, nativeId: row.nativeId, fingerprint: row.fingerprint, title: row.title,
            sourceLabel: row.sourceName ?? row.sourceType ?? 'On-device calendar' } });
        if (device.dispatchRecords.some((record) => record.duplicateKey === deviceEventRecord!.duplicateKey)) throw new Error('This source action already has a device-calendar receipt. Inspect or reconcile that receipt; it will not be created again.');
        device.dispatchRecords.unshift(deviceEventRecord);
        proposal.deviceEventDispatchRecordId = deviceEventRecord.id;
        return { proposal, dependencyProjection, deviceEventRecord, capturedDeviceGeneration: device.generation };
      }
      if (proposal.kind === 'event' && !proposal.eventTransactionId) proposal.eventTransactionId = newId();
      const operation = proposal.kind === 'email' ? proposal.email?.operation : proposal.kind === 'event' ? 'event' : undefined;
      const account = proposal.accountId ? state.accounts.find((item) => item.id === proposal.accountId) : undefined;
      const capability = operation === 'draft' ? 'mail.draft' : operation === 'send' ? 'mail.send' : operation === 'event' ? 'calendar.write' : undefined;
      const calendar = proposal.kind === 'event' ? state.calendars.find((item) => item.id === proposal.calendarId) : undefined;
      const canDispatch = (proposal.kind === 'email' || proposal.kind === 'event') && state.settings.mode === 'provider' && Boolean(this.connector && account && account.connected && account.authStatus === 'connected' && capability && account.capabilities?.includes(capability)) &&
        (proposal.kind !== 'event' || proposal.eventDestination?.kind !== 'device_calendar') &&
        (proposal.kind !== 'event' || Boolean(calendar && calendar.accountId === account?.id && calendar.connected && calendar.writable && calendar.providerId));
      proposal.status = 'dispatching';
      let dispatchRecord: DispatchRecord | undefined;
      if (canDispatch && account) {
        if (this.dispatchRecordQuarantine.length) throw new Error('Dispatch history failed integrity validation. External writes are disabled until the receipt history is repaired.');
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
    const frozenDeviceRecord = 'deviceEventRecord' in claim ? claim.deviceEventRecord : undefined;

    let result: ProposalStatusOutcome;
    if (claimed.kind === 'reminder') {
      try {
        const reminder = this.snapshot.reminders.records.find((item) => item.id === claimed.reminderId);
        if (!reminder) throw new Error('The reminder ledger record was not saved.');
        const saved = await this.saveApprovedReminder(reminder.id, { expectedRevision: reminder.revision });
        const intent = saved.currentIntentId ? this.snapshot.reminders.intents.find((item) => item.id === saved.currentIntentId) : undefined;
        result = { status: 'executed', notificationId: intent?.observed === 'pending' ? intent.identifier : undefined,
          message: intent?.observed === 'pending' ? 'Reminder saved locally and the alert is pending on this device.'
            : intent?.observed === 'unavailable' ? 'Reminder saved locally. This platform does not provide background alerts.'
              : intent?.observed === 'delivery_unknown' ? 'Reminder saved locally, but its alert outcome is unknown.'
                : 'Reminder saved locally; alerts are blocked or could not be verified.' };
      } catch (error) {
        result = { status: 'failed', message: error instanceof Error ? error.message : 'Could not save the reminder.' };
      }
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
    } else if (frozenDeviceRecord) {
      const createPromise = this.deviceCalendarBackend.createApprovedEvent(frozenDeviceRecord, () => {
        const latest = this.snapshot;
        if (this.mailAlertRefreshRequired) return false;
        const current = latest.proposals.find((item) => item.id === frozenDeviceRecord.proposalId);
        const record = latest.deviceCalendars.dispatchRecords.find((item) => item.id === frozenDeviceRecord.id);
        const approval = current?.deviceCalendarApproval;
        const row = latest.deviceCalendars.calendars.find((item) => item.localId === frozenDeviceRecord.target.calendarLocalId);
        return Boolean(current && row && record?.outcome === 'pending' && current.deviceEventDispatchRecordId === frozenDeviceRecord.id &&
          current.status === 'dispatching' && current.revision === frozenDeviceRecord.revision && current.approvedRevision === frozenDeviceRecord.revision &&
          current.approvedPayloadDigest === frozenDeviceRecord.payloadDigest && approval &&
          approval.installationId === frozenDeviceRecord.target.installationId && approval.generation === frozenDeviceRecord.target.generation &&
          approval.selectionRevision === frozenDeviceRecord.target.selectionRevision && row.fingerprint === frozenDeviceRecord.target.fingerprint &&
          row.nativeId === frozenDeviceRecord.target.nativeId && row.allowsModifications && latest.deviceCalendars.selectedCalendarIds.includes(row.localId) &&
          this.deviceCalendarGenerationIsCurrent(latest, frozenDeviceRecord.target.generation, frozenDeviceRecord.target.installationId) &&
          this.proposalDependencyProjection(latest, current) === approvedDependencyProjection &&
          approval.dependencyProjection === this.deviceEventProjection(latest, current, row) &&
          stableJson(current.event) === stableJson({ ...current.event, title: frozenDeviceRecord.payload.title, description: frozenDeviceRecord.payload.notes }));
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ status: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), 30_000); });
      const resultPromise = createPromise.then((value) => ({ status: 'result' as const, value }), (error: unknown) => ({ status: 'error' as const, error }));
      const nativeResult = await Promise.race([resultPromise, timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (nativeResult.status === 'timeout') {
        result = { status: 'unknown', message: 'The on-device calendar did not confirm whether it saved the event before the wait limit. Check the calendar manually; it will not be created again.' };
        await this.commitDeviceEventReceipt(frozenDeviceRecord, { outcome: 'unknown', at: now(), observationSource: 'timeout' });
        let late: Promise<void>;
        late = resultPromise.then(async (lateResult) => {
          if (lateResult.status === 'result' && lateResult.value.status === 'saved' && lateResult.value.nativeEventId) {
            await this.commitDeviceEventReceipt(frozenDeviceRecord, { outcome: 'saved', nativeEventId: lateResult.value.nativeEventId, at: now(), late: true });
          } else if (lateResult.status === 'result' && lateResult.value.status === 'unknown' && lateResult.value.nativeEventId) {
            await this.commitDeviceEventReceipt(frozenDeviceRecord, { outcome: 'unknown', nativeEventId: lateResult.value.nativeEventId, at: now(), observationSource: 'native_callback', lateObservation: true });
          }
        }).catch(() => undefined).finally(() => {
          if (this.deviceEventLateResults.get(frozenDeviceRecord.id) === late) this.deviceEventLateResults.delete(frozenDeviceRecord.id);
        });
        this.deviceEventLateResults.set(frozenDeviceRecord.id, late);
      } else if (nativeResult.status === 'result' && nativeResult.value.status === 'saved' && nativeResult.value.nativeEventId) {
        await this.commitDeviceEventReceipt(frozenDeviceRecord, { outcome: 'saved', nativeEventId: nativeResult.value.nativeEventId, at: now() });
        result = { status: 'accepted', message: 'The event was saved to this device calendar. This confirms a local save, not cloud synchronization.' };
      } else if (nativeResult.status === 'result') {
        await this.commitDeviceEventReceipt(frozenDeviceRecord, { outcome: 'unknown', at: now(), ...(nativeResult.value.nativeEventId ? { nativeEventId: nativeResult.value.nativeEventId } : {}), observationSource: 'native_callback' });
        result = { status: 'unknown', message: 'The native calendar could not verify whether the event was saved. Check the calendar manually; it will not be created again.' };
      } else {
        const error = nativeResult.error;
        const code = error instanceof DeviceCalendarBackendError ? error.code : 'precondition_failed';
        if (code === 'create_unknown') result = { status: 'unknown', message: 'The native calendar outcome is unknown. Check the calendar manually; this event will not be retried.' };
        else {
          const mapped: import('../deviceCalendars').DeviceEventErrorCode = code === 'permission_denied' ? 'permission_denied' : code === 'permission_unavailable' ? 'permission_unavailable'
            : code === 'calendar_missing' ? 'calendar_missing' : code === 'calendar_changed' ? 'calendar_changed' : code === 'calendar_readonly' ? 'calendar_readonly'
              : code === 'unsupported_payload' ? 'unsupported_payload' : code === 'unavailable' ? 'unavailable' : 'precondition_failed';
          await this.commitDeviceEventReceipt(frozenDeviceRecord, { outcome: 'rejected', errorCode: mapped, at: now() });
          result = { status: 'failed', message: error instanceof Error ? error.message : 'Device calendar rejected this event before saving.' };
        }
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
          if (this.mailAlertRefreshRequired || !current || !currentAccount || !recordIsCurrent(currentState, current) || current.status !== 'dispatching' ||
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
          if (this.mailAlertRefreshRequired || !current || (current.provenance?.version === 1 && !currentNote) || !currentAccount || currentState.settings.mode !== 'provider' || !recordIsCurrent(currentState, current) ||
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

    if (frozenDeviceRecord) {
      if (result.status !== 'accepted' || this.snapshot.deviceCalendars.dispatchRecords.find((item) => item.id === frozenDeviceRecord.id)?.outcome === 'pending') {
        await this.commitDeviceEventReceipt(frozenDeviceRecord, {
          outcome: result.status === 'failed' ? 'rejected' : 'unknown', at: now(),
          ...(result.status === 'failed' ? { errorCode: 'precondition_failed' as const } : {}),
        });
      }
      return this.snapshot.proposals.find((item) => item.id === frozenDeviceRecord.proposalId) ?? claimed;
    }

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
        if (proposal.kind === 'task' && result.status === 'executed' &&
            this.proposalDependencyProjection(state, proposal) !== approvedDependencyProjection) {
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
    } catch (error) { throw error; }
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

  private async commitDeviceEventReceipt(record: DeviceEventDispatchRecord, input: {
    outcome: 'saved' | 'unknown' | 'rejected'; at: string; nativeEventId?: string;
    errorCode?: import('../deviceCalendars').DeviceEventErrorCode; late?: boolean; lateObservation?: boolean; observationSource?: 'timeout' | 'native_callback' | 'restart_recovery';
  }): Promise<void> {
    await this.mutate((state) => {
      const index = state.deviceCalendars.dispatchRecords.findIndex((item) => item.id === record.id);
      if (index < 0) return;
      const current = state.deviceCalendars.dispatchRecords[index];
      if (this.deviceDispatchClaimProjection(current) !== this.deviceDispatchClaimProjection(record)) return;
      let changed = false;
      if (current.outcome === 'pending' || current.outcome === 'unknown' && (input.late && input.outcome === 'saved' || input.lateObservation && input.outcome === 'unknown')) {
        state.deviceCalendars.dispatchRecords[index] = recordDeviceEventOutcome(current, {
          outcome: input.outcome, at: new Date(Math.max(Date.parse(input.at), Date.parse(current.claimAt), current.outcomeAt ? Date.parse(current.outcomeAt) : 0)).toISOString(),
          ...(input.nativeEventId ? { nativeEventId: input.nativeEventId } : {}), ...(input.errorCode ? { errorCode: input.errorCode } : {}),
          ...(input.observationSource ? { observationSource: input.observationSource } : input.late ? { observationSource: 'native_callback' as const } : {}),
          ...(input.late ? { allowLateNativeCompletion: true as const } : {}),
          ...(input.lateObservation ? { allowLateNativeObservation: true as const } : {}),
        });
        changed = true;
      }
      const settled = state.deviceCalendars.dispatchRecords[index];
      const proposal = state.proposals.find((item) => item.id === settled.proposalId);
      if (proposal?.deviceEventDispatchRecordId === settled.id) {
        proposal.status = settled.outcome === 'saved' ? 'accepted' : settled.outcome === 'rejected' ? 'failed' : 'unknown';
        proposal.remoteId = settled.nativeEventId;
        proposal.remoteAcceptedAt = settled.outcome === 'saved' ? settled.outcomeAt : undefined;
        proposal.lastError = settled.outcome === 'unknown' ? 'The device-calendar outcome is unknown. Check the calendar manually; this event will not be created again.' : undefined;
      }
      if (changed && settled.outcome === 'saved') addActivity(state, 'local_action', 'Event saved to the selected on-device calendar. Cloud synchronization is not confirmed.', { proposalId: settled.proposalId });
    });
  }

  private deviceDispatchClaimProjection(record: DeviceEventDispatchRecord): string {
    return stableJson({ version: record.version, id: record.id, proposalId: record.proposalId, revision: record.revision,
      sourceRevision: record.sourceRevision, sourceProvenance: record.sourceProvenance, sourceActionKey: record.sourceActionKey,
      duplicateKey: record.duplicateKey, payloadDigest: record.payloadDigest, target: record.target, payload: record.payload, claimAt: record.claimAt });
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

  private assertReminderWritable(): void {
    if (this.reminderQuarantine.length) throw new Error('Saved reminder data is held for recovery. New reminder changes are disabled until it is repaired.');
  }

  private reminder(state: AppState, id: string): ReminderRecord {
    const record = state.reminders.records.find((item) => item.id === id);
    if (!record) throw new Error('Reminder was not found.');
    return record;
  }

  private assertReminderOriginCurrent(state: AppState, origin: ReminderRecord['origin'], allowSaved = false, expectedDeviceProjection?: string): void {
    if (allowSaved) return;
    if (origin.kind === 'manual') return;
    if (origin.kind === 'note') {
      const note = state.notes.find((item) => item.id === origin.noteId);
      if (!note || note.revision !== origin.sourceRevision || !note.analysis || note.analysis.sourceRevision !== origin.sourceRevision || note.analysis.stale) {
        throw new Error('The source note changed. Refresh the reminder source before approving or saving it.');
      }
      const version = note.analysis.sourceVersions.transcript;
      if (version !== origin.sourceVersion || !note.transcript.includes(origin.quote)) throw new Error('The source note evidence is no longer current. Refresh the reminder source.');
      return;
    }
    const record = state.reminders.records.find((item) => item.origin.kind === 'proactive' && item.origin.candidate.id === origin.candidate.id);
    const candidate = state.proactive.candidates.find((item) => item.candidate.id === origin.candidate.id);
    const rule = state.proactive.rules.find((item) => item.id === origin.rule.id);
    if (!allowSaved && (!candidate || candidate.presentation !== 'active' || !rule?.enabled || rule.revision !== origin.rule.revision || rule.version !== origin.rule.version || Date.parse(origin.expiresAt) <= Date.now())) {
      throw new Error('This proactive suggestion is no longer current. Refresh its source before approving or saving it.');
    }
    if (!allowSaved && candidate?.candidate.sourceVersion !== origin.candidate.sourceVersion) throw new Error('The proactive source changed. Refresh it before approving or saving.');
    if (record && record.id === '') throw new Error('Reminder source could not be verified.');
    if (origin.binding) {
      const account = state.accounts.find((item) => item.id === origin.binding!.accountId);
      if (!allowSaved && (!account || !account.connected || account.authStatus !== 'connected' || identityKey(account) !== origin.binding.identityKey || (account.connectionGeneration ?? 0) !== origin.binding.connectionGeneration)) {
        throw new Error('The source account changed. Refresh the reminder source before approving or saving it.');
      }
    }
    if (origin.deviceBinding && !allowSaved) {
      const binding = origin.deviceBinding;
      const device = state.deviceCalendars;
      const calendar = device.calendars.find((item) => item.localId === binding.calendarId);
      const event = device.events.find((item) => item.calendarId === binding.calendarId && item.nativeEventId === binding.nativeEventId && item.occurrenceStart === binding.occurrenceStart && item.generation === binding.generation && !item.cancelled);
      const age = event ? Date.now() - Date.parse(event.observedAt) : Number.POSITIVE_INFINITY;
      if (!calendar || !event || state.deviceCalendarAccess.status !== 'full_access' || !device.enabled || device.installationId !== binding.installationId ||
          device.generation !== binding.generation || !device.selectedCalendarIds.includes(binding.calendarId) || !Number.isFinite(age) || age < 0 || age >= 15 * 60_000 ||
          origin.source.kind !== 'meeting' || origin.source.deviceBinding === undefined || stableJson(origin.source.deviceBinding) !== stableJson(binding) ||
          (expectedDeviceProjection !== undefined && deviceReminderSourceProjection(state, binding) !== expectedDeviceProjection)) {
        throw new Error('The on-device calendar source changed. Refresh the reminder source before approving or saving it.');
      }
    }
  }

  private async verifyProactiveReminderOrigin(origin: Extract<ReminderRecord['origin'], { kind: 'proactive' }>): Promise<string | undefined> {
    if (origin.deviceBinding) {
      const access = await this.checkDeviceCalendarAccess();
      if (access.status !== 'full_access') throw new Error('Check on-device calendar access and refresh this reminder source before approving or saving it.');
    }
    await this.evaluateLocalCandidates();
    const captured = this.snapshot;
    const entry = captured.proactive.candidates.find((item) => item.candidate.id === origin.candidate.id);
    const rule = captured.proactive.rules.find((item) => item.id === origin.rule.id);
    if (!entry || entry.presentation !== 'active' || !rule?.enabled || rule.revision !== origin.rule.revision || rule.version !== origin.rule.version || Date.parse(origin.expiresAt) <= Date.now()) {
      throw new Error('This proactive suggestion is no longer current. Refresh its source before approving or saving it.');
    }
    const fresh = await this.getProactiveCandidateSource(origin.candidate.id);
    if (this.snapshot !== captured || fresh.status !== 'current' || fresh.source?.sourceVersion !== origin.candidate.sourceVersion ||
        stableJson(fresh.source) !== stableJson(origin.source)) throw new Error('The proactive source changed. Refresh it before approving or saving.');
    const deviceProjection = origin.deviceBinding ? deviceReminderSourceProjection(captured, origin.deviceBinding) : undefined;
    if (origin.deviceBinding && !deviceProjection) throw new Error('The on-device calendar source changed. Refresh it before approving or saving.');
    if (origin.binding) {
      const account = captured.accounts.find((item) => item.id === origin.binding!.accountId);
      if (!account || !account.connected || account.authStatus !== 'connected' || identityKey(account) !== origin.binding.identityKey || (account.connectionGeneration ?? 0) !== origin.binding.connectionGeneration) {
        throw new Error('The source account changed. Refresh the reminder source before approving or saving it.');
      }
    }
    if (origin.deviceBinding) this.assertReminderOriginCurrent(captured, origin);
    return deviceProjection;
  }

  private async reminderApprovalDigest(record: ReminderRecord): Promise<string> {
    const payload = { title: record.title, body: record.body, dueAt: record.dueAt, displayTimeZone: record.displayTimeZone, privacyMode: record.privacyMode };
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
      JSON.stringify({ id: record.id, revision: record.revision, payload: reminderPayloadForDigest(payload), origin: record.origin }),
      { encoding: Crypto.CryptoEncoding.HEX });
  }

  private async setReminderIntent(state: AppState, record: ReminderRecord, desired: 'scheduled' | 'cancelled', observed: ReminderIntent['observed'] = 'unconfirmed'): Promise<ReminderIntent> {
    const prior = state.reminders.intents.filter((item) => item.reminderId === record.id);
    const epoch = prior.reduce((maximum, item) => Math.max(maximum, item.epoch), 0) + 1;
    const payload: ReminderPayload = validateReminderPayload({ title: record.title, body: record.body, dueAt: record.dueAt,
      displayTimeZone: record.displayTimeZone, privacyMode: record.privacyMode });
    const payloadDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, reminderPayloadForDigest(payload), { encoding: Crypto.CryptoEncoding.HEX });
    const time = now();
    const intent: ReminderIntent = {
      id: this.freshStateId(state), reminderId: record.id, reminderRevision: record.revision, epoch,
      identifier: reminderNotificationIdentifier(state.reminders.installationId, record.id, epoch), payloadDigest,
      payload, desired, observed, createdAt: time, updatedAt: time,
    };
    state.reminders.intents.unshift(intent);
    record.currentIntentId = intent.id;
    return intent;
  }

  private cancellationForCurrentIntent(state: AppState, record: ReminderRecord): void {
    const intent = record.currentIntentId ? state.reminders.intents.find((item) => item.id === record.currentIntentId) : undefined;
    if (intent?.desired === 'scheduled') {
      intent.desired = 'cancelled'; intent.observed = 'unconfirmed'; intent.updatedAt = now(); delete intent.errorCode;
    }
  }

  async createReminderDraft(input: import('../core').ReminderDraftInput = {}): Promise<ReminderRecord> {
    await this.load();
    let candidateOrigin: ReminderRecord['origin'] = { kind: 'manual' };
    if (input.candidateId) {
      const source = await this.getProactiveCandidateSource(input.candidateId);
      if (source.status !== 'current' || !source.candidate || !source.source) throw new Error('This proactive suggestion is no longer current. Refresh candidates before creating a reminder.');
      const captured = this.snapshot;
      const rule = captured.proactive.rules.find((item) => item.id === source.candidate!.ruleId);
      if (!rule?.enabled) throw new Error('The proactive rule is no longer enabled.');
      const account = source.source.accountId ? captured.accounts.find((item) => item.id === source.source!.accountId) : undefined;
      candidateOrigin = {
        kind: 'proactive', candidate: clone(source.candidate), rule: { id: rule.id, revision: rule.revision, version: rule.version, name: rule.name },
        source: clone(source.source), ...(account ? { binding: { accountId: account.id, namespace: account.provider, identityKey: identityKey(account), connectionGeneration: account.connectionGeneration ?? 0 } } : {}),
        ...(source.source.kind === 'meeting' && source.source.deviceBinding ? { deviceBinding: clone(source.source.deviceBinding) } : {}),
        capturedAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
    }
    const dueAt = input.dueAt ?? new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const capturedDeviceProjection = candidateOrigin.kind === 'proactive' && candidateOrigin.deviceBinding
      ? deviceReminderSourceProjection(this.snapshot, candidateOrigin.deviceBinding) : undefined;
    const sourceTitle = candidateOrigin.kind === 'proactive'
      ? candidateOrigin.source.kind === 'task' ? candidateOrigin.source.title
        : candidateOrigin.source.subject
      : undefined;
    const payload = validateReminderPayload({ title: input.title ?? (candidateOrigin.kind === 'proactive' ? boundedReminderTitle(sourceTitle) : 'Reminder'),
      body: input.body ?? '', dueAt, displayTimeZone: input.displayTimeZone ?? validTimezone(this.snapshot.settings.timezone), privacyMode: input.privacyMode ?? 'private' });
    return this.mutate((state) => {
      this.assertReminderWritable();
      if (candidateOrigin.kind === 'proactive') {
        const existing = state.reminders.records.find((item) => item.origin.kind === 'proactive' && item.origin.candidate.id === candidateOrigin.candidate.id && ['draft', 'approved', 'saved'].includes(item.status));
        if (existing) return existing;
        this.assertReminderOriginCurrent(state, candidateOrigin, false, capturedDeviceProjection);
      }
      if (state.reminders.records.length >= 500) throw new Error('Reminder storage is full. Export or delete an old reminder first.');
      const time = now();
      const record = validateReminderRecord({ ...payload, id: this.freshStateId(state), revision: 1, origin: candidateOrigin, status: 'draft', createdAt: time, updatedAt: time });
      state.reminders.records.unshift(record);
      addActivity(state, 'local_action', 'Reminder draft created on this device.');
      return record;
    });
  }

  async updateReminderDraft(id: string, input: import('../core').ReminderDraftPatch): Promise<ReminderRecord> {
    const result = await this.mutate(async (state) => {
      this.assertReminderWritable();
      const record = this.reminder(state, id);
      if (record.revision !== input.expectedRevision) throw new Error('This reminder changed. Reopen it before editing.');
      if (record.status !== 'draft' && record.status !== 'approved' && record.status !== 'saved') throw new Error('This reminder can no longer be edited.');
      const wasSaved = record.status === 'saved';
      if (wasSaved) this.cancellationForCurrentIntent(state, record);
      const payload = validateReminderPayload({ title: input.title ?? record.title, body: input.body ?? record.body, dueAt: input.dueAt ?? record.dueAt,
        displayTimeZone: input.displayTimeZone ?? record.displayTimeZone, privacyMode: input.privacyMode ?? record.privacyMode });
      Object.assign(record, payload, { revision: record.revision + 1, status: 'draft' as const, updatedAt: now() });
      delete record.approvedRevision; delete record.approvedPayloadDigest; delete record.currentIntentId;
      addActivity(state, 'local_action', 'Reminder edited. Approve the updated version before saving it.');
      return { record, wasSaved };
    });
    if (result.wasSaved) await this.reconcileReminderAlerts();
    return this.reminder(this.snapshot, result.record.id);
  }

  async refreshReminderSource(id: string, input: { expectedRevision: number }): Promise<ReminderRecord> {
    const record = this.snapshot.reminders.records.find((item) => item.id === id);
    if (!record || record.revision !== input.expectedRevision) throw new Error('This reminder changed. Reopen it before refreshing its source.');
    if (record.origin.kind !== 'proactive') throw new Error('Only proactive reminders have a refreshable source.');
    const oldOrigin = record.origin;
    await this.evaluateLocalCandidates();
    const refreshedSnapshot = this.snapshot;
    const refreshedEntry = refreshedSnapshot.proactive.candidates.find((item) => item.candidate.ruleId === oldOrigin.candidate.ruleId && item.candidate.sourceId === oldOrigin.candidate.sourceId && item.presentation === 'active');
    if (!refreshedEntry) throw new Error('The proactive source is not currently available.');
    const refreshed = await this.getProactiveCandidateSource(refreshedEntry.candidate.id);
    if (this.snapshot !== refreshedSnapshot || refreshed.status !== 'current' || !refreshed.candidate || !refreshed.source) throw new Error('The proactive source changed while it was refreshing.');
    const bound = this.snapshot;
    const rule = bound.proactive.rules.find((item) => item.id === refreshed.candidate!.ruleId);
    if (!rule?.enabled) throw new Error('The proactive rule is no longer enabled.');
    const account = refreshed.source.accountId ? bound.accounts.find((item) => item.id === refreshed.source!.accountId) : undefined;
    const origin: ReminderRecord['origin'] = { kind: 'proactive', candidate: clone(refreshed.candidate), rule: { id: rule.id, revision: rule.revision, version: rule.version, name: rule.name },
      source: clone(refreshed.source), ...(account ? { binding: { accountId: account.id, namespace: account.provider, identityKey: identityKey(account), connectionGeneration: account.connectionGeneration ?? 0 } } : {}),
      ...(refreshed.source.kind === 'meeting' && refreshed.source.deviceBinding ? { deviceBinding: clone(refreshed.source.deviceBinding) } : {}),
      capturedAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    const refreshedDeviceProjection = origin.kind === 'proactive' && origin.deviceBinding ? deviceReminderSourceProjection(bound, origin.deviceBinding) : undefined;
    const result = await this.mutate((state) => {
      this.assertReminderWritable();
      const current = this.reminder(state, id);
      if (current.revision !== input.expectedRevision || current.origin.kind !== 'proactive') throw new Error('This reminder changed while its source was refreshing.');
      this.assertReminderOriginCurrent(state, origin, false, refreshedDeviceProjection);
      const wasSaved = current.status === 'saved';
      if (wasSaved) this.cancellationForCurrentIntent(state, current);
      current.origin = origin; current.revision += 1; current.status = 'draft'; current.updatedAt = now();
      delete current.approvedRevision; delete current.approvedPayloadDigest; delete current.currentIntentId;
      return { record: current, wasSaved };
    });
    if (result.wasSaved) await this.reconcileReminderAlerts();
    return this.reminder(this.snapshot, result.record.id);
  }

  async approveReminder(id: string, input: { expectedRevision: number }): Promise<ReminderRecord> {
    await this.load();
    const before = this.reminder(this.snapshot, id);
    if (before.revision !== input.expectedRevision) throw new Error('This reminder changed. Reopen it before approving.');
    const verifiedDeviceProjection = before.origin.kind === 'proactive' && !before.firstSavedAt ? await this.verifyProactiveReminderOrigin(before.origin) : undefined;
    return this.mutate(async (state) => {
      this.assertReminderWritable();
      const record = this.reminder(state, id);
      if (record.revision !== input.expectedRevision || record.status !== 'draft') throw new Error('Reopen the current reminder draft before approving it.');
      this.assertReminderOriginCurrent(state, record.origin, Boolean(record.firstSavedAt), verifiedDeviceProjection);
      this.validateReminderDue(record);
      const approvedPayloadDigest = await this.reminderApprovalDigest(record);
      record.status = 'approved'; record.approvedRevision = record.revision; record.approvedPayloadDigest = approvedPayloadDigest; record.updatedAt = now();
      return record;
    });
  }

  private validateReminderDue(record: ReminderRecord): void {
    const payload = validateReminderPayload({ title: record.title, body: record.body, dueAt: record.dueAt, displayTimeZone: record.displayTimeZone, privacyMode: record.privacyMode });
    if (Date.parse(payload.dueAt) <= Date.now()) throw new Error('Choose a future reminder time before approving or saving.');
  }

  async saveApprovedReminder(id: string, input: { expectedRevision: number }): Promise<ReminderRecord> {
    const jobKey = `${id}:${input.expectedRevision}`;
    const running = this.reminderJobs.get(jobKey);
    if (running) return running;
    const job = this.saveApprovedReminderInternal(id, input.expectedRevision);
    this.reminderJobs.set(jobKey, job);
    try { return await job; } finally { if (this.reminderJobs.get(jobKey) === job) this.reminderJobs.delete(jobKey); }
  }

  private async saveApprovedReminderInternal(id: string, expectedRevision: number): Promise<ReminderRecord> {
    await this.load(); this.assertReminderWritable();
    const before = this.reminder(this.snapshot, id);
    if (before.revision !== expectedRevision || before.status !== 'approved' || before.approvedRevision !== expectedRevision) throw new Error('Approve the current reminder version before saving it.');
    let verifiedDeviceProjection = before.origin.kind === 'proactive' && !before.firstSavedAt ? await this.verifyProactiveReminderOrigin(before.origin) : undefined;
    const permission = await this.reminderBackend.getPermission();
    const resolved = permission === 'undetermined' ? await this.reminderBackend.requestPermission() : permission;
    // Permission UI can remain open while the source changes. Rebuild the source projection
    // after that await; the serialized mutation below then compares it with the committed rule,
    // candidate, identity, and generation before saving the user's intent.
    if (before.origin.kind === 'proactive' && !before.firstSavedAt) verifiedDeviceProjection = await this.verifyProactiveReminderOrigin(before.origin);
    const saved = await this.mutate(async (state) => {
      this.assertReminderWritable();
      const record = this.reminder(state, id);
      if (record.revision !== expectedRevision || record.status !== 'approved' || record.approvedRevision !== expectedRevision || !record.approvedPayloadDigest) throw new Error('This reminder changed while notification permission was checked. Review and approve it again.');
      this.assertReminderOriginCurrent(state, record.origin, Boolean(record.firstSavedAt), verifiedDeviceProjection);
      if (record.origin.kind === 'proactive' && !record.firstSavedAt && stableJson(record.origin) !== stableJson(before.origin)) throw new Error('The proactive source changed while notification permission was checked.');
      if (record.origin.kind === 'note' && !record.firstSavedAt) {
        const sourceProposalId = record.origin.proposalId;
        const sourceProposal = state.proposals.find((item) => item.id === sourceProposalId);
        if (!sourceProposal || sourceProposal.status !== 'dispatching' && sourceProposal.status !== 'approved') throw new Error('The source proposal is no longer available for this reminder save.');
        await this.validateProposalProvenance(state, sourceProposal);
      }
      this.validateReminderDue(record);
      if (await this.reminderApprovalDigest(record) !== record.approvedPayloadDigest) throw new Error('The approved reminder payload changed. Review and approve it again.');
      const observed: ReminderIntent['observed'] = resolved === 'authorized' || resolved === 'provisional' ? 'unconfirmed' : resolved === 'unavailable' ? 'unavailable' : 'blocked';
      const intent = await this.setReminderIntent(state, record, 'scheduled', observed);
      record.status = 'saved'; record.currentIntentId = intent.id; record.updatedAt = now();
      record.firstSavedAt ??= record.updatedAt;
      addActivity(state, 'local_action', 'Approved reminder saved on this device.');
      return record;
    });
    await this.reconcileReminderAlerts();
    return this.reminder(this.snapshot, saved.id);
  }

  async retryReminderAlert(id: string, input: { expectedRevision: number }): Promise<ReminderRecord> {
    await this.load(); this.assertReminderWritable();
    const before = this.reminder(this.snapshot, id);
    if (before.status !== 'saved' || before.revision !== input.expectedRevision) throw new Error('Only the current saved reminder can retry its alert.');
    const permission = await this.reminderBackend.getPermission();
    if (permission === 'undetermined') await this.reminderBackend.requestPermission();
    const stateIntent = await this.mutate((state) => {
      this.assertReminderWritable();
      const record = this.reminder(state, id);
      if (record.status !== 'saved' || record.revision !== input.expectedRevision || !record.currentIntentId) throw new Error('This reminder changed while notification permission was checked.');
      const intent = state.reminders.intents.find((item) => item.id === record.currentIntentId);
      if (!intent || intent.desired !== 'scheduled') throw new Error('The saved alert intent is unavailable.');
      intent.observed = 'unconfirmed'; intent.updatedAt = now(); delete intent.errorCode;
      return intent;
    });
    await this.reconcileReminderAlerts();
    return this.reminder(this.snapshot, stateIntent.reminderId);
  }

  async cancelReminder(id: string, input: { expectedRevision: number }): Promise<ReminderRecord> {
    const updated = await this.mutate((state) => {
      this.assertReminderWritable();
      const record = this.reminder(state, id);
      if (record.revision !== input.expectedRevision) throw new Error('This reminder changed. Reopen it before cancelling.');
      if (record.status === 'cancelled' || record.status === 'completed') return record;
      this.cancellationForCurrentIntent(state, record);
      record.revision += 1; record.status = 'cancelled'; record.updatedAt = now(); delete record.currentIntentId;
      return record;
    });
    await this.reconcileReminderAlerts();
    return this.reminder(this.snapshot, updated.id);
  }

  async completeReminder(id: string, input: { expectedRevision: number }): Promise<ReminderRecord> {
    const result = await this.mutate((state) => {
      this.assertReminderWritable();
      const record = this.reminder(state, id);
      if (record.revision !== input.expectedRevision) throw new Error('This reminder changed. Reopen it before marking it done.');
      if (record.status === 'completed') return record;
      if (record.status !== 'saved' && record.status !== 'approved') throw new Error('Only an approved or saved reminder can be marked done.');
      this.cancellationForCurrentIntent(state, record);
      record.revision += 1; record.status = 'completed'; record.updatedAt = now(); delete record.currentIntentId;
      return record;
    });
    await this.reconcileReminderAlerts();
    return this.reminder(this.snapshot, result.id);
  }

  async deleteReminder(id: string, input: { expectedRevision: number }): Promise<void> {
    await this.mutate(async (state) => {
      this.assertReminderWritable();
      const record = this.reminder(state, id);
      if (record.revision !== input.expectedRevision) throw new Error('This reminder changed. Reopen it before deleting.');
      this.cancellationForCurrentIntent(state, record);
      state.reminders.records = state.reminders.records.filter((item) => item.id !== id);
      addActivity(state, 'local_action', 'Reminder deleted from this device.');
    });
    await this.reconcileReminderAlerts();
  }

  async reconcileReminderAlerts(): Promise<void> {
    await this.load();
    if (this.reminderQuarantine.length) return;
    if (this.reminderReconcileJob) { this.reminderReconcileAgain = true; return this.reminderReconcileJob; }
    const job = (async () => {
      await this.reconcileReminderAlertsInternal();
      if (this.reminderReconcileAgain) {
        this.reminderReconcileAgain = false;
        await this.reconcileReminderAlertsInternal();
      }
    })();
    this.reminderReconcileJob = job;
    try {
      await job;
    } finally { if (this.reminderReconcileJob === job) this.reminderReconcileJob = undefined; }
  }

  private async reconcileReminderAlertsInternal(): Promise<void> {
    const installationId = this.snapshot.reminders.installationId;
    try { await this.reminderBackend.installForegroundHandler((notification) => this.isForegroundReminderAllowed(notification)); }
    catch { /* Foreground delivery is suppressed unless the synchronous ledger projection approves it. */ }
    let pending: PendingNotificationRequest[];
    try { pending = await this.reminderBackend.listPending(); }
    catch { await this.markReminderListFailure(); return; }
    let listReads = 1;
    let operations = 0; let canceledAny = false; let scheduledAny = false;
    const canceledIntentIds: string[] = []; const canceledLegacyIds: string[] = [];
    for (const item of [...this.snapshot.reminders.intents].filter((intent) => intent.desired === 'cancelled' && intent.observed !== 'absent')) {
      if (operations >= 16) break;
      const current = this.snapshot.reminders.intents.find((intent) => intent.id === item.id);
      if (!current || current.desired !== 'cancelled') continue;
      const found = pending.find((request) => request.identifier === current.identifier);
      if (!found) { await this.observeReminderIntent(current.id, 'absent', undefined, 'cancelled'); continue; }
      const markerIntent = { ...current, desired: 'scheduled' as const };
      if (!isMatchingPending(markerIntent, found, installationId)) { await this.observeReminderIntent(current.id, 'error', 'unverifiable', 'cancelled'); continue; }
      await this.markReminderAttempt(current.id); operations += 1;
      try { await this.reminderBackend.cancel(current.identifier); canceledIntentIds.push(current.id); canceledAny = true; }
      catch (error) { await this.observeReminderIntent(current.id, 'error', this.reminderErrorCode(error, 'cancel_failed'), 'cancelled'); }
    }
    for (const item of [...(this.snapshot.reminders.legacyCancellations ?? [])]) {
      if (operations >= 16) break;
      const current = this.snapshot.reminders.legacyCancellations?.find((row) => row.id === item.id);
      if (!current || current.observed === 'absent') continue;
      const found = pending.find((request) => request.identifier === current.identifier);
      if (!found) { await this.observeLegacyReminder(current.id, 'absent'); continue; }
      if (!isOwnedLegacyReminderCancellation(current, found)) { await this.observeLegacyReminder(current.id, 'error', 'unverifiable'); continue; }
      await this.markLegacyReminderAttempt(current.id); operations += 1;
      try { await this.reminderBackend.cancelLegacy(current, found); canceledLegacyIds.push(current.id); canceledAny = true; }
      catch (error) {
        const code = this.reminderErrorCode(error, 'cancel_failed');
        await this.observeLegacyReminder(current.id, 'error', code === 'listing_failed' || code === 'cancel_failed' || code === 'unverifiable' ? code : 'cancel_failed');
      }
    }
    if (canceledAny) {
      try {
        pending = await this.reminderBackend.listPending();
        listReads += 1;
        for (const id of canceledIntentIds) {
          const intent = this.snapshot.reminders.intents.find((item) => item.id === id);
          if (!intent) continue;
          await this.observeReminderIntent(id, pending.some((item) => item.identifier === intent.identifier) ? 'unconfirmed' : 'absent', undefined, 'cancelled');
        }
        for (const id of canceledLegacyIds) {
          const item = this.snapshot.reminders.legacyCancellations?.find((row) => row.id === id);
          if (item) await this.observeLegacyReminder(id, pending.some((row) => row.identifier === item.identifier) ? 'unconfirmed' : 'absent');
        }
      } catch { await this.markReminderListFailure(); return; }
    }
    const permission = await this.reminderBackend.getPermission();
    for (const item of [...this.snapshot.reminders.intents].filter((intent) => intent.desired === 'scheduled')) {
      // Keep half of the per-pass native-operation budget for cancellation if Done/Delete
      // races a schedule that has already entered the platform bridge.
      if (operations >= 8) break;
      const current = this.snapshot.reminders.intents.find((intent) => intent.id === item.id);
      if (!current || current.desired !== 'scheduled' || !current.payload) continue;
      const record = this.snapshot.reminders.records.find((candidate) => candidate.id === current.reminderId);
      if (!record || record.status !== 'saved' || record.currentIntentId !== current.id || record.revision !== current.reminderRevision ||
          stableJson({ title: record.title, body: record.body, dueAt: record.dueAt, displayTimeZone: record.displayTimeZone, privacyMode: record.privacyMode }) !==
            stableJson({ title: current.payload.title, body: current.payload.body, dueAt: current.payload.dueAt, displayTimeZone: current.payload.displayTimeZone, privacyMode: current.payload.privacyMode })) continue;
      const blockedByCancellation = this.snapshot.reminders.intents.some((prior) => prior.reminderId === current.reminderId && prior.epoch < current.epoch && prior.desired === 'cancelled' && prior.observed !== 'absent');
      if (blockedByCancellation) continue;
      // Persisted shape and ownership are not authorization. Recompute both digests before
      // trusting a restored intent, and fence the async hash against concurrent state changes.
      const checkedSnapshot = this.snapshot;
      let integrityValid = false;
      try {
        const payloadDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, reminderPayloadForDigest(current.payload), { encoding: Crypto.CryptoEncoding.HEX });
        const approvalDigest = await this.reminderApprovalDigest(record);
        integrityValid = payloadDigest === current.payloadDigest && approvalDigest === record.approvedPayloadDigest;
      } catch { integrityValid = false; }
      if (!integrityValid || this.snapshot !== checkedSnapshot ||
          this.snapshot.reminders.intents.find((intent) => intent.id === current.id)?.desired !== 'scheduled' ||
          this.snapshot.reminders.records.find((candidate) => candidate.id === record.id)?.approvedPayloadDigest !== record.approvedPayloadDigest) {
        await this.observeReminderIntent(current.id, 'error', 'unverifiable', 'scheduled');
        continue;
      }
      this.verifiedReminderForeground.set(current.id, this.reminderForegroundFingerprint(record, current));
      const found = pending.find((request) => request.identifier === current.identifier);
      if (found) {
        if (isMatchingPending(current, found, installationId)) await this.observeReminderIntent(current.id, 'pending', undefined, 'scheduled');
        else await this.observeReminderIntent(current.id, 'error', 'unverifiable', 'scheduled');
        continue;
      }
      if (Date.parse(current.payload.dueAt) <= Date.now()) { await this.observeReminderIntent(current.id, 'delivery_unknown', undefined, 'scheduled'); continue; }
      if (permission === 'unavailable' || this.reminderBackend.platform === 'web') { await this.observeReminderIntent(current.id, 'unavailable', 'permission_unavailable', 'scheduled'); continue; }
      if (permission === 'denied' || permission === 'undetermined') { await this.observeReminderIntent(current.id, 'blocked', 'permission_denied', 'scheduled'); continue; }
      await this.markReminderAttempt(current.id); operations += 1;
      const guard = () => {
        if (this.mailAlertRefreshRequired) return false;
        const latest = this.snapshot.reminders.intents.find((intent) => intent.id === current.id);
        const owner = this.snapshot.reminders.records.find((candidate) => candidate.id === current.reminderId);
        return Boolean(latest && latest.payload && latest.payloadDigest === current.payloadDigest && latest.desired === 'scheduled' && latest.epoch === current.epoch && owner?.status === 'saved' &&
          owner.currentIntentId === latest.id && owner.revision === latest.reminderRevision && owner.approvedPayloadDigest === record.approvedPayloadDigest &&
          stableJson(reminderPayloadForDigest({ title: owner.title, body: owner.body, dueAt: owner.dueAt, displayTimeZone: owner.displayTimeZone, privacyMode: owner.privacyMode })) ===
          stableJson(reminderPayloadForDigest(latest.payload)));
      };
      try {
        const latest = this.snapshot.reminders.intents.find((intent) => intent.id === current.id);
        if (!latest || !guard()) continue;
        await this.reminderBackend.schedule(latest, installationId, guard);
        scheduledAny = true;
        if (this.snapshot.reminders.intents.find((intent) => intent.id === current.id)?.desired === 'cancelled') {
          if (operations < 16) {
            await this.markReminderAttempt(current.id);
            operations += 1;
            try { await this.reminderBackend.cancel(current.identifier); canceledIntentIds.push(current.id); canceledAny = true; }
            catch { await this.observeReminderIntent(current.id, 'error', 'cancel_failed', 'cancelled'); }
          }
        } else await this.observeReminderIntent(current.id, 'pending', undefined, 'scheduled');
      } catch (error) {
        if (guard()) await this.observeReminderIntent(current.id, 'error', this.reminderErrorCode(error, 'schedule_failed'), 'scheduled');
      }
    }
    if (scheduledAny || this.reminderReconcileAgain) {
      try {
        pending = await this.reminderBackend.listPending();
        listReads += 1;
        for (const id of canceledIntentIds) {
          const intent = this.snapshot.reminders.intents.find((item) => item.id === id);
          if (intent?.desired === 'cancelled') await this.observeReminderIntent(id, pending.some((row) => row.identifier === intent.identifier) ? 'unconfirmed' : 'absent', undefined, 'cancelled');
        }
        // A different reminder can be deleted while an awaited schedule is in flight.
        // Sweep every now-cancelled owned intent here, not only the intent whose schedule
        // just returned, using the cancellation budget reserved by the schedule cap above.
        const lateCancelledIds: string[] = [];
        const lateCancelledLegacyIds: string[] = [];
        for (const item of [...this.snapshot.reminders.intents].filter((intent) => intent.desired === 'cancelled' && intent.observed !== 'absent')) {
          if (operations >= 16) break;
          const current = this.snapshot.reminders.intents.find((intent) => intent.id === item.id);
          if (!current || current.desired !== 'cancelled') continue;
          const found = pending.find((request) => request.identifier === current.identifier);
          if (!found) {
            await this.observeReminderIntent(current.id, 'absent', undefined, 'cancelled');
            continue;
          }
          const markerIntent = { ...current, desired: 'scheduled' as const };
          if (!isMatchingPending(markerIntent, found, installationId)) {
            await this.observeReminderIntent(current.id, 'error', 'unverifiable', 'cancelled');
            continue;
          }
          await this.markReminderAttempt(current.id);
          operations += 1;
          try {
            await this.reminderBackend.cancel(current.identifier);
            lateCancelledIds.push(current.id);
            canceledAny = true;
          } catch (error) {
            await this.observeReminderIntent(current.id, 'error', this.reminderErrorCode(error, 'cancel_failed'), 'cancelled');
          }
        }
        for (const item of [...(this.snapshot.reminders.legacyCancellations ?? [])].filter((entry) => entry.observed !== 'absent')) {
          if (operations >= 16) break;
          const current = this.snapshot.reminders.legacyCancellations?.find((entry) => entry.id === item.id);
          if (!current || current.observed === 'absent') continue;
          const found = pending.find((request) => request.identifier === current.identifier);
          if (!found) {
            await this.observeLegacyReminder(current.id, 'absent');
            continue;
          }
          if (!isOwnedLegacyReminderCancellation(current, found)) {
            await this.observeLegacyReminder(current.id, 'error', 'unverifiable');
            continue;
          }
          await this.markLegacyReminderAttempt(current.id);
          operations += 1;
          try {
            await this.reminderBackend.cancelLegacy(current, found);
            lateCancelledLegacyIds.push(current.id);
          } catch (error) {
            const code = this.reminderErrorCode(error, 'cancel_failed');
            await this.observeLegacyReminder(current.id, 'error', code === 'listing_failed' || code === 'cancel_failed' || code === 'unverifiable' ? code : 'cancel_failed');
          }
        }
        if (lateCancelledIds.length || lateCancelledLegacyIds.length) {
          if (listReads < 3) {
            pending = await this.reminderBackend.listPending();
            listReads += 1;
            for (const id of lateCancelledIds) {
              const intent = this.snapshot.reminders.intents.find((item) => item.id === id);
              if (intent?.desired === 'cancelled') await this.observeReminderIntent(id,
                pending.some((row) => row.identifier === intent.identifier) ? 'unconfirmed' : 'absent', undefined, 'cancelled');
            }
            for (const id of lateCancelledLegacyIds) {
              const cancellation = this.snapshot.reminders.legacyCancellations?.find((item) => item.id === id);
              if (cancellation) await this.observeLegacyReminder(id,
                pending.some((row) => row.identifier === cancellation.identifier) ? 'unconfirmed' : 'absent');
            }
          } else {
            for (const id of lateCancelledIds) await this.observeReminderIntent(id, 'unconfirmed', undefined, 'cancelled');
            for (const id of lateCancelledLegacyIds) await this.observeLegacyReminder(id, 'unconfirmed');
          }
        }
        for (const item of [...this.snapshot.reminders.intents].filter((intent) => intent.desired === 'scheduled' && intent.observed === 'pending')) {
          const found = pending.find((request) => request.identifier === item.identifier);
          if (!found) await this.observeReminderIntent(item.id, Date.parse(item.payload?.dueAt ?? '') <= Date.now() ? 'delivery_unknown' : 'unconfirmed', undefined, 'scheduled');
          else if (!isMatchingPending(item, found, installationId)) await this.observeReminderIntent(item.id, 'error', 'unverifiable', 'scheduled');
        }
      } catch { await this.markReminderListFailure(); }
    }
  }

  private isForegroundReminderAllowed(notification: { identifier?: string; content: { title?: unknown; body?: unknown; data?: unknown; [key: string]: unknown } }): boolean {
    if (this.mailAlertRefreshRequired) return false;
    if (isMatchingProactiveMailAlertNotification({ installationId: this.state.proactiveMailAlerts.installationId,
      receiptId: this.notificationMailAlertReceiptId(notification) }, { identifier: notification.identifier, content: notification.content })) {
      if (this.proactiveMailAlertQuarantine.length) return false;
      const receiptId = this.notificationMailAlertReceiptId(notification);
      const receipt = this.state.proactiveMailAlerts.receipts.find((item) => item.id === receiptId);
      if (!receipt || receipt.installationId !== this.state.proactiveMailAlerts.installationId || receipt.desired !== 'notify' ||
          !['attempting', 'submitted'].includes(receipt.observed)) return false;
      const consent = this.state.proactiveMailAlerts.consents.find((item) => item.id === receipt.consentId);
      const rule = this.state.proactive.rules.find((item) => item.id === receipt.ruleId);
      const account = mailAlertAccountsForWorkspace(this.state).find((item) => item.accountId === receipt.accountId);
      return Boolean(consent && consent.status === 'active' && consent.ruleId === receipt.ruleId &&
        consent.ruleVersion === receipt.ruleVersion && consent.ruleRevision === receipt.ruleRevision &&
        consent.activatedAt === receipt.consentActivatedAt && consent.timeZone === receipt.timeZone &&
        this.state.settings.timezone === receipt.timeZone &&
        rule && rule.enabled && rule.version === receipt.ruleVersion && rule.revision === receipt.ruleRevision &&
        (rule.accountIds.length === 0 || rule.accountIds.includes(receipt.accountId)) &&
        account && account.connected && account.authStatus === 'connected' && account.canReadMail &&
        account.identityKey === receipt.identityKey && account.connectionGeneration === receipt.connectionGeneration &&
        consent.accounts.some((binding) => binding.accountId === receipt.accountId && binding.identityKey === receipt.identityKey &&
          binding.connectionGeneration === receipt.connectionGeneration));
    }
    if (this.reminderQuarantine.length || !notification.identifier || !notification.content.data || typeof notification.content.data !== 'object') return false;
    const data = notification.content.data as Record<string, unknown>;
    const intent = this.snapshot.reminders.intents.find((item) => item.identifier === notification.identifier && item.desired === 'scheduled' && item.observed === 'pending');
    if (!intent || intent.identifier !== reminderNotificationIdentifier(this.snapshot.reminders.installationId, intent.reminderId, intent.epoch)) return false;
    const owner = this.snapshot.reminders.records.find((record) => record.id === intent.reminderId);
    if (!owner || owner.status !== 'saved' || owner.currentIntentId !== intent.id || owner.revision !== intent.reminderRevision ||
        owner.approvedRevision !== owner.revision || !owner.approvedPayloadDigest || !intent.payload ||
        stableJson(reminderPayloadForDigest({ title: owner.title, body: owner.body, dueAt: owner.dueAt, displayTimeZone: owner.displayTimeZone, privacyMode: owner.privacyMode })) !==
          stableJson(reminderPayloadForDigest(intent.payload))) return false;
    if (this.verifiedReminderForeground.get(intent.id) !== this.reminderForegroundFingerprint(owner, intent)) return false;
    const projection = notificationContentForIntent(intent, this.snapshot.reminders.installationId);
    const expected = projection.data;
    return (notification.content.title ?? '') === projection.title && (notification.content.body ?? '') === projection.body &&
      Object.keys(data).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => data[key] === value);
  }

  private notificationMailAlertReceiptId(notification: { content: { data?: unknown } }): string {
    const data = notification.content.data;
    return isRecord(data) && data.kind === 'proactive_mail_alert' && typeof data.receiptId === 'string' ? data.receiptId : '';
  }

  private reminderForegroundFingerprint(record: ReminderRecord, intent: ReminderIntent): string {
    return stableJson({ reminderId: record.id, revision: record.revision, approval: record.approvedPayloadDigest,
      intentId: intent.id, epoch: intent.epoch, identifier: intent.identifier, payloadDigest: intent.payloadDigest,
      payload: intent.payload });
  }

  private async observeReminderIntent(id: string, observed: ReminderIntent['observed'], errorCode?: ReminderIntent['errorCode'], expectedDesired?: ReminderIntent['desired']): Promise<void> {
    await this.mutate((state) => {
      const intent = state.reminders.intents.find((item) => item.id === id); if (!intent) return;
      if (expectedDesired && intent.desired !== expectedDesired) return;
      intent.observed = observed; intent.updatedAt = now(); intent.observedAt = intent.updatedAt;
      if (intent.desired === 'cancelled' && observed === 'absent') delete intent.payload;
      if (errorCode) intent.errorCode = errorCode; else delete intent.errorCode;
    });
  }

  private async markReminderAttempt(id: string): Promise<void> {
    await this.mutate((state) => {
      const intent = state.reminders.intents.find((item) => item.id === id); if (!intent) throw new Error('Reminder intent was removed before the native operation.');
      if (intent.desired === 'cancelled' && !state.reminders.records.some((item) => item.id === intent.reminderId)) { /* deletion cancellation is still owned */ }
      intent.attemptedAt = now(); intent.updatedAt = intent.attemptedAt;
    });
  }

  private async observeLegacyReminder(id: string, observed: LegacyReminderCancellation['observed'], errorCode?: LegacyReminderCancellation['errorCode']): Promise<void> {
    await this.mutate((state) => {
      const item = state.reminders.legacyCancellations?.find((row) => row.id === id); if (!item) return;
      item.observed = observed; item.observedAt = now(); if (errorCode) item.errorCode = errorCode; else delete item.errorCode;
    });
  }

  private async markLegacyReminderAttempt(id: string): Promise<void> {
    await this.mutate((state) => { const item = state.reminders.legacyCancellations?.find((row) => row.id === id); if (item) item.attemptedAt = now(); });
  }

  private async markReminderListFailure(): Promise<void> {
    await this.mutate((state) => {
      for (const intent of state.reminders.intents) if (intent.observed === 'unconfirmed') { intent.observed = 'error'; intent.errorCode = 'listing_failed'; intent.updatedAt = now(); }
      for (const item of state.reminders.legacyCancellations ?? []) if (item.observed === 'unconfirmed') { item.observed = 'error'; item.errorCode = 'listing_failed'; item.observedAt = now(); }
    });
  }

  private reminderErrorCode(error: unknown, fallback: ReminderIntent['errorCode']): ReminderIntent['errorCode'] {
    return error instanceof NotificationBackendError ? error.code : fallback;
  }

  private async enqueueLegacyReminderCancellation(state: AppState, proposalId: string, revision: number): Promise<void> {
    const cancellations = state.reminders.legacyCancellations ?? (state.reminders.legacyCancellations = []);
    if (cancellations.some((item) => item.proposalId === proposalId && item.proposalRevision === revision)) return;
    if (state.reminders.intents.length + cancellations.length >= 1_000) throw new Error('Reminder recovery history is full. Reconcile or export reminder history before continuing.');
    cancellations.unshift({ id: this.freshStateId(state), proposalId, proposalRevision: revision,
      identifier: legacyReminderIdentifier(proposalId, revision), requestedAt: now(), observed: 'unconfirmed' });
  }

  private assertKnowledgeWritable(): void {
    if (this.knowledgeQuarantine.length) throw new Error('Saved knowledge is held for recovery. Export other data or repair the saved knowledge before editing it.');
  }

  private findKnowledgeEntity(state: AppState, kind: KnowledgeEntityKind, id: string): Person | Project {
    const entity = getKnowledgeEntity(state.knowledge, kind, id);
    if (!entity) throw new Error('Person or project was not found.');
    return entity;
  }

  private freshStateId(state: AppState): string {
    let used = this.draftAllocatedIds.get(state);
    if (!used) { used = stateEntityIds(state); this.draftAllocatedIds.set(state, used); }
    return allocateFreshId(used);
  }

  private assertKnowledgeReferenceExists(state: AppState, reference: KnowledgeReference): void {
    if (reference.kind === 'note' && !state.notes.some((item) => item.id === reference.id)) throw new Error('Choose a note that still exists in this library.');
    if (reference.kind === 'task' && !state.tasks.some((item) => item.id === reference.id)) throw new Error('Choose a task that still exists in this library.');
    if (reference.kind === 'document' && !state.documents.some((item) => item.path === reference.id)) throw new Error('Choose a document that still exists in this library.');
    if (reference.kind === 'person' || reference.kind === 'project') {
      const related = getKnowledgeEntity(state.knowledge, reference.kind, reference.id);
      if (!related || related.archivedAt) throw new Error('Choose a current, active person or project.');
      return;
    }
    if (reference.kind === 'mail') {
      const accounts = state.accounts.filter((item) => item.connected && item.authStatus === 'connected' && identityKey(item) === reference.identityKey &&
        (item.connectionGeneration ?? 0) === reference.connectionGeneration && (item.capabilities ?? []).includes('mail.read'));
      const account = accounts.length === 1 ? accounts[0] : undefined;
      const messages = account && state.mailbox.filter((item) => item.accountId === account.id && item.providerMessageId === reference.id &&
        item.identityKey === `${reference.identityKey}:${reference.id}` && item.verifiedIdentityKey === reference.identityKey &&
        (item.connectionGeneration ?? 0) === reference.connectionGeneration && !item.providerDeletedAt);
      const message = messages?.length === 1 ? messages[0] : undefined;
      if (!account || !message) throw new Error('The referenced mailbox message is no longer available from this verified account.');
      return;
    }
    if (reference.kind === 'calendar') {
      const events = state.calendarEvents.filter((item) => item.providerEventId === reference.id && item.verifiedIdentityKey === reference.identityKey &&
        (item.connectionGeneration ?? 0) === reference.connectionGeneration && !item.providerDeletedAt &&
        state.calendars.some((calendar) => calendar.id === item.calendarId && calendar.accountId === item.accountId && calendar.connected &&
          (calendar.providerId ?? calendar.id) === reference.calendarId));
      const event = events.length === 1 ? events[0] : undefined;
      const account = event && state.accounts.find((item) => item.id === event.accountId && item.connected && item.authStatus === 'connected' &&
        identityKey(item) === reference.identityKey && (item.connectionGeneration ?? 0) === reference.connectionGeneration && (item.capabilities ?? []).includes('calendar.read'));
      if (!event || !account) throw new Error('The referenced calendar event is no longer available from this verified account.');
      return;
    }
    if (reference.kind === 'device_calendar_event') {
      const device = state.deviceCalendars;
      const matches = device.events.filter((event) => event.calendarId === reference.calendarId && event.nativeEventId === reference.eventId &&
        event.occurrenceStart === reference.occurrenceStart && event.generation === reference.generation && !event.cancelled);
      const event = matches.length === 1 ? matches[0] : undefined;
      const age = event ? Date.now() - Date.parse(event.observedAt) : Number.POSITIVE_INFINITY;
      if (!event || !this.deviceCalendarGenerationIsCurrent(state, reference.generation, reference.installationId) ||
          !device.enabled || !device.selectedCalendarIds.includes(reference.calendarId) || !Number.isFinite(age) || age < 0 || age >= 15 * 60_000) {
        throw new Error('The referenced on-device event is no longer current in the selected calendar.');
      }
    }
  }

  private journalKnowledgeReview(state: AppState, action: 'created' | 'edited' | 'accepted' | 'dismissed', suggestion: KnowledgeSuggestion, targetName: string): void {
    const marker = `knowledge-suggestion:${suggestion.id}:r${suggestion.revision}:${action}`;
    const inference = state.documents.find((item) => item.path === 'memory/INFERENCES.md');
    const inferenceText = `${inference?.content?.trim() || '# Inferences'}\n<!-- ${marker} -->\n- ${action === 'accepted' ? 'Accepted inference' : action === 'dismissed' ? 'Dismissed suggestion' : action === 'edited' ? 'Edited suggestion' : 'Pending suggestion'} for ${targetName}: ${suggestion.change.type}.\n`;
    upsertDocument(state, 'memory/INFERENCES.md', inferenceText);
    if (action === 'accepted') {
      const decisions = state.documents.find((item) => item.path === 'memory/DECISIONS.md');
      upsertDocument(state, 'memory/DECISIONS.md', `${decisions?.content?.trim() || '# Decisions'}\n<!-- ${marker} -->\n- User accepted a reviewed ${suggestion.change.type} for ${targetName}. It remains an unverified inference.\n`);
    }
  }

  private async mirrorKnowledgeJournals(): Promise<void> {
    for (const path of ['memory/INFERENCES.md', 'memory/DECISIONS.md']) {
      const document = this.snapshot.documents.find((item) => item.path === path);
      if (document) await this.mirrorDocument(document);
    }
  }

  private validateKnowledgeAndBackup(state: AppState): void {
    state.knowledge = validateKnowledgeState(state.knowledge);
    assertPortableBackupFits(state);
  }

  private async saveKnowledgeEntity(kind: KnowledgeEntityKind, input: SavePersonInput | SaveProjectInput): Promise<Person | Project> {
    this.assertKnowledgeWritable();
    if (new TextEncoder().encode(input.narrative).length > 16 * 1024) throw new Error('Knowledge narrative is limited to 16 KiB.');
    const saved = await this.mutate((state) => {
      this.assertKnowledgeWritable();
      const id = input.id ?? this.freshStateId(state);
      const path = `${kind === 'person' ? 'people' : 'projects'}/${id}.md`;
      const collection = kind === 'person' ? state.knowledge.people : state.knowledge.projects;
      const existing = collection.find((item) => item.id === id);
      if (existing && input.expectedRevision !== existing.revision) throw new Error('This knowledge entry changed. Refresh it before saving.');
      if (!existing && input.id) throw new Error('Person or project was not found.');
      if (!existing && stateEntityIds(state).has(id)) throw new Error('The requested person or project ID is already in use.');
      const document = state.documents.find((item) => item.path === path);
      if (document && input.expectedDocumentRevision !== document.revision) throw new Error('This narrative changed. Refresh it before saving.');
      if (!document && input.expectedDocumentRevision !== undefined) throw new Error('This narrative was removed. Refresh it before saving.');
      const timestamp = now();
      const base = {
        id, revision: (existing?.revision ?? 0) + 1, name: input.name.trim(), aliases: [...input.aliases], narrativePath: path,
        createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, facts: existing?.facts ?? [], sourceLinks: existing?.sourceLinks ?? [],
        ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}), ...(existing?.importOrigin ? { importOrigin: existing.importOrigin } : {}),
      };
      const entity: Person | Project = kind === 'person'
        ? { ...base, contacts: (existing as Person | undefined)?.contacts ?? [] }
        : { ...base, status: (input as SaveProjectInput).status, goal: (input as SaveProjectInput).goal, startsOn: (input as SaveProjectInput).startsOn,
          targetOn: (input as SaveProjectInput).targetOn, dateTimeZone: (input as SaveProjectInput).dateTimeZone, members: (existing as Project | undefined)?.members ?? [] };
      const candidate = kind === 'person'
        ? { ...state.knowledge, people: [...state.knowledge.people.filter((item) => item.id !== id), entity as Person] }
        : { ...state.knowledge, projects: [...state.knowledge.projects.filter((item) => item.id !== id), entity as Project] };
      state.knowledge = validateKnowledgeState(candidate);
      const content = input.narrative;
      const nextDocument: ContextDocument = { path, content, revision: (document?.revision ?? 0) + 1, updatedAt: timestamp };
      if (document) Object.assign(document, nextDocument); else state.documents.unshift(nextDocument);
      markAnalysesStale(state, [`knowledge:${kind}:${id}`, `doc:${path}`]);
      this.validateKnowledgeAndBackup(state);
      const savedEntity = getKnowledgeEntity(state.knowledge, kind, id)!;
      return { entity: savedEntity as Person | Project, document: nextDocument };
    });
    await this.mirrorDocument(saved.document);
    await this.mirrorKnowledgeJournals();
    return saved.entity;
  }

  async savePerson(input: SavePersonInput): Promise<Person> { return await this.saveKnowledgeEntity('person', input) as Person; }
  async saveProject(input: SaveProjectInput): Promise<Project> { return await this.saveKnowledgeEntity('project', input) as Project; }

  async setKnowledgeEntityArchived(input: { kind: KnowledgeEntityKind; id: string; expectedRevision: number; archived: boolean }): Promise<Person | Project> {
    this.assertKnowledgeWritable();
    return this.mutate((state) => {
      this.assertKnowledgeWritable();
      const entity = this.findKnowledgeEntity(state, input.kind, input.id);
      if (entity.revision !== input.expectedRevision) throw new Error('This knowledge entry changed. Refresh it before saving.');
      const timestamp = now();
      if (input.archived === Boolean(entity.archivedAt)) return entity;
      if (input.kind === 'person') {
        const item = state.knowledge.people.find((row) => row.id === input.id)!;
        item.revision += 1; item.updatedAt = timestamp; if (input.archived) item.archivedAt = timestamp; else delete item.archivedAt;
      } else {
        const item = state.knowledge.projects.find((row) => row.id === input.id)!;
        item.revision += 1; item.updatedAt = timestamp; if (input.archived) item.archivedAt = timestamp; else delete item.archivedAt;
      }
      markAnalysesStale(state, [`knowledge:${input.kind}:${input.id}`]);
      this.validateKnowledgeAndBackup(state);
      return this.findKnowledgeEntity(state, input.kind, input.id);
    });
  }

  private updateKnowledgeItem<T>(command: KnowledgeItemCommand, update: (entity: Person | Project, state: AppState) => T): Promise<T> {
    this.assertKnowledgeWritable();
    return this.mutate((state) => {
      this.assertKnowledgeWritable();
      const entity = this.findKnowledgeEntity(state, command.entityKind, command.entityId);
      if (entity.revision !== command.expectedEntityRevision) throw new Error('This knowledge entry changed. Refresh it before saving.');
      const result = update(entity, state);
      entity.revision += 1; entity.updatedAt = now();
      markAnalysesStale(state, [`knowledge:${command.entityKind}:${command.entityId}`]);
      this.validateKnowledgeAndBackup(state);
      return result;
    });
  }

  async saveKnowledgeFact(input: SaveKnowledgeFactInput): Promise<KnowledgeFact> {
    return this.updateKnowledgeItem(input, (entity, state) => {
      const rows = entity.facts; const found = input.itemId ? rows.find((item) => item.id === input.itemId) : undefined;
      if (input.itemId && !found) throw new Error('Fact was not found.');
      const item: KnowledgeFact = { id: found?.id ?? this.freshStateId(state), provenance: 'user_authored', createdAt: found?.createdAt ?? now(), statement: input.statement.trim() };
      const index = found ? rows.indexOf(found) : -1; if (index >= 0) rows[index] = item; else rows.push(item); return item;
    });
  }
  async removeKnowledgeFact(input: KnowledgeItemCommand): Promise<void> {
    await this.updateKnowledgeItem(input, (entity) => { const index = entity.facts.findIndex((item) => item.id === input.itemId); if (index < 0) throw new Error('Fact was not found.'); entity.facts.splice(index, 1); });
  }
  async saveKnowledgeContact(input: SaveKnowledgeContactInput): Promise<ContactClaim> {
    return this.updateKnowledgeItem(input, (entity, state) => {
      if (!('contacts' in entity)) throw new Error('Contacts can only be added to a person.');
      const found = input.itemId ? entity.contacts.find((item) => item.id === input.itemId) : undefined;
      if (input.itemId && !found) throw new Error('Contact was not found.');
      const item: ContactClaim = { id: found?.id ?? this.freshStateId(state), provenance: 'user_authored', createdAt: found?.createdAt ?? now(), address: input.address.trim(), label: input.label.trim() };
      const index = found ? entity.contacts.indexOf(found) : -1; if (index >= 0) entity.contacts[index] = item; else entity.contacts.push(item); return item;
    });
  }
  async removeKnowledgeContact(input: KnowledgeItemCommand & { entityKind: 'person' }): Promise<void> {
    await this.updateKnowledgeItem(input, (entity) => { if (!('contacts' in entity)) throw new Error('Person was not found.'); const index = entity.contacts.findIndex((item) => item.id === input.itemId); if (index < 0) throw new Error('Contact was not found.'); entity.contacts.splice(index, 1); });
  }
  async saveKnowledgeSourceLink(input: SaveKnowledgeSourceLinkInput): Promise<KnowledgeSourceLink> {
    return this.updateKnowledgeItem(input, (entity, state) => {
      this.assertKnowledgeReferenceExists(state, input.reference);
      const found = input.itemId ? entity.sourceLinks.find((item) => item.id === input.itemId) : undefined;
      if (input.itemId && !found) throw new Error('Source link was not found.');
      const item: KnowledgeSourceLink = { id: found?.id ?? this.freshStateId(state), provenance: 'user_authored', createdAt: found?.createdAt ?? now(), reference: clone(input.reference), label: input.label.trim() };
      const index = found ? entity.sourceLinks.indexOf(found) : -1; if (index >= 0) entity.sourceLinks[index] = item; else entity.sourceLinks.push(item); return item;
    });
  }
  async removeKnowledgeSourceLink(input: KnowledgeItemCommand): Promise<void> {
    await this.updateKnowledgeItem(input, (entity) => { const index = entity.sourceLinks.findIndex((item) => item.id === input.itemId); if (index < 0) throw new Error('Source link was not found.'); entity.sourceLinks.splice(index, 1); });
  }
  async saveKnowledgeMember(input: SaveKnowledgeMemberInput): Promise<ProjectMember> {
    return this.updateKnowledgeItem(input, (entity, state) => {
      if (!('members' in entity)) throw new Error('Members can only be added to a project.');
      const person = state.knowledge.people.find((row) => row.id === input.personId);
      if (!person || person.revision !== input.personRevision || person.archivedAt) throw new Error('Choose a current, active person before adding a project member.');
      const found = input.itemId ? entity.members.find((item) => item.id === input.itemId) : undefined;
      if (input.itemId && !found) throw new Error('Project member was not found.');
      const item: ProjectMember = { id: found?.id ?? this.freshStateId(state), provenance: 'user_authored', createdAt: found?.createdAt ?? now(), personId: input.personId, role: input.role.trim() };
      const index = found ? entity.members.indexOf(found) : -1; if (index >= 0) entity.members[index] = item; else entity.members.push(item); return item;
    });
  }
  async removeKnowledgeMember(input: KnowledgeItemCommand & { entityKind: 'project' }): Promise<void> {
    await this.updateKnowledgeItem(input, (entity) => { if (!('members' in entity)) throw new Error('Project was not found.'); const index = entity.members.findIndex((item) => item.id === input.itemId); if (index < 0) throw new Error('Project member was not found.'); entity.members.splice(index, 1); });
  }

  async createKnowledgeSuggestionFromNote(input: { noteId: string; sourceId: string; quote: string; targetKind: KnowledgeEntityKind; targetId: string; change: KnowledgeChange }): Promise<KnowledgeSuggestion> {
    this.assertKnowledgeWritable();
    const result = await this.mutate(async (state) => {
      this.assertKnowledgeWritable();
      const note = this.note(state, input.noteId);
      const quote = input.quote.trim();
      if (!quote || !note.transcript.includes(quote)) throw new Error('Evidence must be an exact quote from the saved note transcript.');
      if (input.sourceId !== 'transcript' && input.sourceId !== note.id) throw new Error('Manual note evidence must come from the selected note transcript.');
      const target = this.findKnowledgeEntity(state, input.targetKind, input.targetId);
      if (target.archivedAt) throw new Error('Unarchive the person or project before creating a suggestion.');
      const transcriptSource = { id: `note:${note.id}`, revision: note.revision, text: note.transcript, required: true, kind: 'note' as const };
      const catalog = await createSourceCatalog([transcriptSource], async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
      const source = catalog.byId.get(`note:${note.id}`)!;
      let change = { ...clone(input.change), entityKind: input.targetKind, entityId: input.targetId } as KnowledgeChange;
      if (change.type === 'add_source_link') {
        this.assertKnowledgeReferenceExists(state, change.reference);
        if (change.reference.kind === 'person' || change.reference.kind === 'project') {
          const related = this.findKnowledgeEntity(state, change.reference.kind, change.reference.id);
          if (change.referenceRevision !== undefined && change.referenceRevision !== related.revision) throw new Error('The related person or project changed. Refresh before creating this suggestion.');
          change = { ...change, referenceRevision: related.revision };
        }
      }
      if (change.type === 'add_member') {
        const person = state.knowledge.people.find((item) => item.id === change.personId);
        if (!person || person.archivedAt || person.revision !== change.personRevision) throw new Error('Choose a current, active person before creating this member suggestion.');
      }
      if (state.knowledge.suggestions.some((item) => ['pending', 'accepted'].includes(item.status) && stableJson(item.change) === stableJson(change))) {
        throw new Error('An equivalent pending or accepted suggestion already exists.');
      }
      const suggestion = validateKnowledgeSuggestion({
        id: this.freshStateId(state), revision: 1, change, targetRevision: target.revision,
        evidence: [{ sourceId: `note:${note.id}`, revision: source.revision, sourceVersion: source.version, quote }],
        status: 'pending', createdAt: now(), updatedAt: now(), sourceNoteId: note.id,
      });
      state.knowledge.suggestions.push(suggestion);
      this.journalKnowledgeReview(state, 'created', suggestion, target.name);
      addActivity(state, 'local_action', `A memory suggestion was saved for ${target.name}.`, { noteId: note.id });
      this.validateKnowledgeAndBackup(state);
      return suggestion;
    });
    await this.mirrorKnowledgeJournals();
    return result;
  }

  async editKnowledgeSuggestion(id: string, input: EditKnowledgeSuggestionInput): Promise<KnowledgeSuggestion> {
    this.assertKnowledgeWritable();
    const result = await this.mutate((state) => {
      this.assertKnowledgeWritable();
      const suggestion = state.knowledge.suggestions.find((item) => item.id === id);
      if (!suggestion) throw new Error('Memory suggestion was not found.');
      if (suggestion.revision !== input.expectedRevision || suggestion.status !== 'pending') throw new Error('This memory suggestion changed or is no longer pending.');
      let editedChange = input.change;
      const target = this.findKnowledgeEntity(state, editedChange.entityKind, editedChange.entityId);
      if (target.archivedAt) throw new Error('Unarchive the person or project before editing its suggestion.');
      if (editedChange.type === 'add_source_link') {
        this.assertKnowledgeReferenceExists(state, editedChange.reference);
        if (editedChange.reference.kind === 'person' || editedChange.reference.kind === 'project') {
          const related = this.findKnowledgeEntity(state, editedChange.reference.kind, editedChange.reference.id);
          if (editedChange.referenceRevision !== undefined && editedChange.referenceRevision !== related.revision) throw new Error('The related person or project changed. Refresh before editing this suggestion.');
          editedChange = { ...editedChange, referenceRevision: related.revision };
        }
      }
      if (editedChange.type === 'add_member') {
        const person = state.knowledge.people.find((item) => item.id === editedChange.personId);
        if (!person || person.archivedAt || person.revision !== editedChange.personRevision) throw new Error('Choose a current, active person before editing this member suggestion.');
      }
      if (state.knowledge.suggestions.some((item) => item.id !== id && ['pending', 'accepted'].includes(item.status) && stableJson(item.change) === stableJson(editedChange))) {
        throw new Error('An equivalent pending or accepted suggestion already exists.');
      }
      const next = validateKnowledgeSuggestion({
        ...suggestion, revision: suggestion.revision + 1, targetRevision: target.revision,
        originalChange: suggestion.originalChange ?? suggestion.change,
        originalEvidence: suggestion.originalEvidence ?? suggestion.evidence,
        change: clone(editedChange), evidence: clone(input.evidence), updatedAt: now(), reviewedAt: undefined, status: 'pending',
      });
      Object.assign(suggestion, next);
      this.journalKnowledgeReview(state, 'edited', suggestion, target.name);
      this.validateKnowledgeAndBackup(state);
      return suggestion;
    });
    await this.mirrorKnowledgeJournals();
    return result;
  }

  private async currentKnowledgeSourceVersions(state: AppState, suggestion: KnowledgeSuggestion): Promise<Map<string, { revision: number; version: string; text: string }>> {
    const requiredIds = new Set(suggestion.evidence.map((item) => item.sourceId === 'transcript' && suggestion.sourceNoteId
      ? `note:${suggestion.sourceNoteId}` : item.sourceId));
    const sources: AssistantSourceInput[] = [];
    const noteId = suggestion.sourceNoteId;
    const note = noteId ? state.notes.find((item) => item.id === noteId) : undefined;
    for (const sourceId of requiredIds) {
      if (sourceId.startsWith('note:')) {
        let citedNoteId: string;
        try { citedNoteId = decodeURIComponent(sourceId.slice(5)); } catch { continue; }
        const citedNote = state.notes.find((item) => item.id === citedNoteId);
        if (!citedNote) continue;
        if (noteId && citedNote.id === noteId) sources.push({ id: sourceId, revision: citedNote.revision, text: citedNote.transcript, required: true, kind: 'note', title: citedNote.title, updatedAt: citedNote.capturedAt ?? citedNote.createdAt });
        else {
          const built = buildLocalSourceSet({ transcript: { revision: 0, text: '' }, notes: [{ id: citedNote.id, title: citedNote.title, revision: citedNote.revision, transcript: citedNote.transcript,
            updatedAt: citedNote.capturedAt ?? citedNote.createdAt, selectionPriority: 1 }] });
          sources.push(...built.sources.filter((item) => item.id === sourceId));
        }
        continue;
      }
      if (sourceId.startsWith('doc:')) {
        const path = sourceId.slice(4), document = state.documents.find((item) => item.path === path);
        if (document) sources.push({ id: sourceId, revision: document.revision, text: document.content, required: false, kind: 'document' });
        continue;
      }
      if (sourceId.startsWith('task:')) {
        let taskId: string;
        try { taskId = decodeURIComponent(sourceId.slice(5)); } catch { continue; }
        const task = state.tasks.find((item) => item.id === taskId);
        if (task) {
          const built = buildLocalSourceSet({ transcript: { revision: 0, text: '' }, tasks: [{ id: task.id, title: task.title, body: task.body, status: task.status, dueAt: task.dueAt, updatedAt: task.completedAt ?? task.createdAt, selectionPriority: 1 }] });
          sources.push(...built.sources.filter((item) => item.id === sourceId));
        }
        continue;
      }
      const knowledgeMatch = /^knowledge:(person|project):([0-9a-f-]+)$/.exec(sourceId);
      if (knowledgeMatch) {
        const entityKind = knowledgeMatch[1] as KnowledgeEntityKind, entityId = knowledgeMatch[2];
        const entity = getKnowledgeEntity(state.knowledge, entityKind, entityId);
        if (entity) sources.push(...knowledgeContextSources(state.knowledge,
          state.documents.map((item) => ({ path: item.path, content: item.content })), [{ kind: entityKind, id: entityId }]).filter((item) => item.id === sourceId));
        continue;
      }
      if (sourceId.startsWith('mail:')) {
        const parts = sourceId.slice(5).split(':');
        if (parts.length !== 2) continue;
        try {
          const identity = decodeURIComponent(parts[0]), providerMessageId = decodeURIComponent(parts[1]);
          const message = state.mailbox.find((item) => item.providerMessageId === providerMessageId && item.identityKey === `${identity}:${providerMessageId}` && item.verifiedIdentityKey === identity && !item.providerDeletedAt);
          const account = message && state.accounts.find((item) => item.id === message.accountId && item.connected && item.authStatus === 'connected' && identityKey(item) === identity &&
            (item.connectionGeneration ?? 0) === (message.connectionGeneration ?? 0) && item.capabilities?.includes('mail.read'));
          if (message && account) {
            const built = buildLocalSourceSet({ transcript: { revision: 0, text: '' }, mailbox: [{ id: message.id, accountId: account.id, providerMessageId, identityKey: identity, subject: message.subject, from: message.from, receivedAt: message.receivedAt, snippet: message.snippet }] });
            sources.push(...built.sources.filter((item) => item.id === sourceId));
          }
        } catch { /* malformed provider source IDs fail closed */ }
        continue;
      }
      if (sourceId.startsWith('calendar-event:')) {
        const parts = sourceId.slice('calendar-event:'.length).split(':');
        if (parts.length !== 3) continue;
        try {
          const identity = decodeURIComponent(parts[0]), providerCalendarId = decodeURIComponent(parts[1]), providerEventId = decodeURIComponent(parts[2]);
          const matches = state.calendarEvents.flatMap((item) => {
            if (item.providerEventId !== providerEventId || item.verifiedIdentityKey !== identity || item.providerDeletedAt) return [];
            const calendar = state.calendars.find((candidate) => candidate.id === item.calendarId && candidate.accountId === item.accountId && candidate.connected && (candidate.providerId ?? candidate.id) === providerCalendarId);
            const account = calendar && state.accounts.find((candidate) => candidate.id === calendar.accountId && candidate.connected && candidate.authStatus === 'connected' && identityKey(candidate) === identity &&
              (candidate.connectionGeneration ?? 0) === (item.connectionGeneration ?? 0) && candidate.capabilities?.includes('calendar.read'));
            return calendar && account ? [{ event: item, calendar, account }] : [];
          });
          const { event, calendar, account } = matches.length === 1 ? matches[0] : {} as { event: CalendarEventSnapshot; calendar: Calendar; account: Account };
          if (event && calendar && account) {
            const built = buildLocalSourceSet({ transcript: { revision: 0, text: '' }, calendars: [{ id: calendar.id, accountId: account.id, identityKey: identity, providerId: calendar.providerId, name: calendar.name, writable: calendar.writable, connected: true }],
              calendarEvents: [{ ...event, identityKey: identity }] });
            sources.push(...built.sources.filter((item) => item.id === sourceId));
          }
        } catch { /* malformed provider source IDs fail closed */ }
        continue;
      }
      if (sourceId.startsWith('device_calendar_event:')) {
        const parts = sourceId.slice('device_calendar_event:'.length).split(':');
        if (parts.length !== 4) continue;
        try {
          const [installationId, calendarId, nativeEventId, occurrenceStart] = parts.map((part) => decodeURIComponent(part));
          const device = state.deviceCalendars;
          const matches = device.events.filter((item) => item.calendarId === calendarId && item.nativeEventId === nativeEventId &&
            item.occurrenceStart === occurrenceStart && item.generation === device.generation && !item.cancelled);
          const event = matches.length === 1 ? matches[0] : undefined;
          const age = event ? Date.now() - Date.parse(event.observedAt) : Number.POSITIVE_INFINITY;
          if (!event || !device.enabled || state.deviceCalendarAccess.status !== 'full_access' ||
              !device.selectedCalendarIds.includes(calendarId) || !this.deviceCalendarGenerationIsCurrent(state, device.generation, installationId) ||
              !Number.isFinite(age) || age < 0 || age >= 15 * 60_000) continue;
          const start = Date.parse(event.start);
          const built = buildLocalSourceSet({ transcript: { revision: 0, text: '' }, deviceCalendarSnapshot: {
            installationId, generation: device.generation, selectionRevision: device.selectionRevision,
            selectedCalendarIds: [calendarId], timeMin: new Date(start - 60_000).toISOString(), timeMax: new Date(start + 60_000).toISOString(),
            asOf: event.observedAt, partial: false, omittedEvents: 0,
            events: [{ calendarId, nativeEventId, occurrenceStart, title: event.title, notes: event.notes,
              notesTruncated: event.notesTruncated, start: event.start, end: event.end, timeZone: event.timeZone,
              allDay: event.allDay, cancelled: event.cancelled }],
          } });
          sources.push(...built.sources.filter((item) => item.id === sourceId));
        } catch { /* malformed or stale on-device source IDs fail closed */ }
      }
    }
    const catalog = await createSourceCatalog([...new Map(sources.map((source) => [source.id, source])).values()],
      async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
    const versions = new Map(catalog.sources.map((source) => [source.id, { revision: source.revision, version: source.version, text: source.text }]));
    if (note && suggestion.evidence.some((item) => item.sourceId === 'transcript')) {
      const transcript = versions.get(`note:${note.id}`);
      if (transcript) versions.set('transcript', transcript);
    }
    return versions;
  }

  async reviewKnowledgeSuggestion(id: string, input: ReviewKnowledgeSuggestionInput): Promise<KnowledgeSuggestion> {
    this.assertKnowledgeWritable();
    const result = await this.mutate(async (state) => {
      this.assertKnowledgeWritable();
      const suggestion = state.knowledge.suggestions.find((item) => item.id === id);
      if (!suggestion) throw new Error('Memory suggestion was not found.');
      if (suggestion.status !== 'pending' || suggestion.revision !== input.expectedRevision) throw new Error('This memory suggestion changed or is no longer pending.');
      if (input.decision === 'dismiss') {
        suggestion.status = 'dismissed'; suggestion.reviewedAt = now(); suggestion.updatedAt = suggestion.reviewedAt; suggestion.revision += 1;
        const target = this.findKnowledgeEntity(state, suggestion.change.entityKind, suggestion.change.entityId);
        this.journalKnowledgeReview(state, 'dismissed', suggestion, target.name);
        addActivity(state, 'local_action', 'A memory suggestion was dismissed.', { noteId: suggestion.sourceNoteId });
        this.validateKnowledgeAndBackup(state);
        return suggestion;
      }
      const target = this.findKnowledgeEntity(state, suggestion.change.entityKind, suggestion.change.entityId);
      if (target.archivedAt || target.revision !== suggestion.targetRevision || (input.targetRevision !== undefined && input.targetRevision !== target.revision)) throw new Error('The target person or project changed. Refresh the suggestion before accepting it.');
      if (suggestion.change.type === 'add_source_link') {
        this.assertKnowledgeReferenceExists(state, suggestion.change.reference);
        if (suggestion.change.reference.kind === 'person' || suggestion.change.reference.kind === 'project') {
          const related = this.findKnowledgeEntity(state, suggestion.change.reference.kind, suggestion.change.reference.id);
          if (related.archivedAt || related.revision !== suggestion.change.referenceRevision) throw new Error('The related person or project changed. Refresh the suggestion before accepting it.');
        }
      }
      const versions = await this.currentKnowledgeSourceVersions(state, suggestion);
      for (const evidence of suggestion.evidence) {
        const current = versions.get(evidence.sourceId);
        if (!current || current.revision !== evidence.revision || current.version !== evidence.sourceVersion || !current.text.includes(evidence.quote)) throw new Error('The cited source changed or is no longer available. Review the evidence and create a fresh suggestion.');
      }
      if (suggestion.change.type === 'add_member') {
        const memberChange = suggestion.change;
        const person = state.knowledge.people.find((item) => item.id === memberChange.personId);
        if (!person || person.archivedAt || person.revision !== memberChange.personRevision || (input.memberPersonRevision !== undefined && input.memberPersonRevision !== person.revision)) throw new Error('The selected project member changed. Refresh the suggestion before accepting it.');
      }
      const evidence = clone(suggestion.evidence);
      const itemBase = { id: this.freshStateId(state), provenance: 'accepted_inference' as const, createdAt: now(), evidence, suggestionId: suggestion.id };
      const change = suggestion.change;
      if (change.type === 'add_fact') target.facts.push({ ...itemBase, statement: change.statement });
      else if (change.type === 'add_contact') {
        if (!('contacts' in target)) throw new Error('A contact suggestion must target a person.');
        target.contacts.push({ ...itemBase, address: change.address, label: change.label });
      } else if (change.type === 'add_source_link') {
        this.assertKnowledgeReferenceExists(state, change.reference);
        target.sourceLinks.push({ ...itemBase, reference: clone(change.reference), label: change.label });
      }
      else {
        if (!('members' in target)) throw new Error('A member suggestion must target a project.');
        target.members.push({ ...itemBase, personId: change.personId, role: change.role });
      }
      target.revision += 1; target.updatedAt = now();
      suggestion.status = 'accepted'; suggestion.reviewedAt = now(); suggestion.updatedAt = suggestion.reviewedAt; suggestion.revision += 1;
      this.journalKnowledgeReview(state, 'accepted', suggestion, target.name);
      markAnalysesStale(state, [`knowledge:${change.entityKind}:${change.entityId}`]);
      addActivity(state, 'local_action', `A reviewed memory suggestion was added to ${target.name}.`, { noteId: suggestion.sourceNoteId });
      this.validateKnowledgeAndBackup(state);
      return suggestion;
    });
    await this.mirrorKnowledgeJournals();
    return result;
  }

  async saveDocument(path: string, content: string, options: { expectedRevision?: number; expectedEntityRevision?: number } = {}): Promise<ContextDocument> {
    const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || cleanPath.split('/').some((part) => part === '.' || part === '..')) throw new Error('Document path must stay inside the app documents folder.');
    const entityPath = /^people\/[0-9a-f-]+\.md$/.test(cleanPath) || /^projects\/[0-9a-f-]+\.md$/.test(cleanPath);
    if (entityPath) this.assertKnowledgeWritable();
    if (entityPath && new TextEncoder().encode(content).length > 16 * 1024) throw new Error('Knowledge narrative is limited to 16 KiB.');
    const document = await this.mutate((state) => {
      if (entityPath) this.assertKnowledgeWritable();
      const existing = state.documents.find((item) => item.path === cleanPath);
      if (existing && options.expectedRevision !== existing.revision) throw new Error('This document changed. Refresh it before saving.');
      if (!existing && options.expectedRevision !== undefined) throw new Error('This document was removed. Refresh it before saving.');
      const entityMatch = /^people\/([0-9a-f-]+)\.md$/.exec(cleanPath) ?? /^projects\/([0-9a-f-]+)\.md$/.exec(cleanPath);
      if (entityMatch) {
        const kind: KnowledgeEntityKind = cleanPath.startsWith('people/') ? 'person' : 'project';
        const entity = state.knowledge[kind === 'person' ? 'people' : 'projects'].find((item) => item.id === entityMatch[1]);
        if (entity && options.expectedEntityRevision !== entity.revision) throw new Error('This person or project changed. Refresh it before saving its narrative.');
        if (!entity && options.expectedEntityRevision !== undefined) throw new Error('This person or project was removed.');
        if (!entity) throw new Error('Create the person or project before saving its canonical narrative.');
      }
      if (existing?.content === content) return existing;
      const changed = existing?.content !== content;
      const next: ContextDocument = { path: cleanPath, content, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
      if (existing) Object.assign(existing, next); else state.documents.unshift(next);
      if (entityMatch) {
        const kind: KnowledgeEntityKind = cleanPath.startsWith('people/') ? 'person' : 'project';
        const entity = state.knowledge[kind === 'person' ? 'people' : 'projects'].find((item) => item.id === entityMatch[1]);
        if (entity) { entity.revision += 1; entity.updatedAt = next.updatedAt; markAnalysesStale(state, [`knowledge:${kind}:${entity.id}`]); }
      }
      if (changed) markAnalysesStale(state, [`doc:${cleanPath}`]);
      if (entityMatch) this.validateKnowledgeAndBackup(state);
      return next;
    });
    await this.mirrorDocument(document);
    return document;
  }

  private async mirrorDocument(document: ContextDocument): Promise<void> {
    try { await (this.integration.writeDocument ?? writePrivateDocument)(document.path, document.content); this.mirrorDirty.delete(document.path); }
    catch (error) {
      this.mirrorDirty.add(document.path);
      await this.mutate((state) => addActivity(state, 'error', `Local document mirror for ${document.path} will retry on next launch: ${error instanceof Error ? error.message : 'write failed'}.`));
    }
  }

  private async retryDocumentMirrors(): Promise<void> {
    for (const path of [...this.mirrorDirty]) {
      const document = this.snapshot.documents.find((item) => item.path === path);
      if (!document) { this.mirrorDirty.delete(path); continue; }
      try { await (this.integration.writeDocument ?? writePrivateDocument)(document.path, document.content); this.mirrorDirty.delete(path); }
      catch { /* canonical SQLite/IndexedDB document remains available and will retry next launch */ }
    }
  }

  async saveSettings(patch: SettingsPatch): Promise<AppSettings> {
    if ('backgroundRefreshGeneration' in (patch as object)) throw new Error('Background refresh generation is managed by this app.');
    const sanitized: SettingsPatch = { ...patch };
    if ('speechEnabled' in sanitized && typeof sanitized.speechEnabled !== 'boolean') throw new Error('Choose whether cloud transcription is enabled.');
    if ('backgroundMailRefreshEnabled' in sanitized && typeof sanitized.backgroundMailRefreshEnabled !== 'boolean') throw new Error('Choose whether background mailbox refresh is enabled.');
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
      const backgroundChanged = 'backgroundMailRefreshEnabled' in sanitized &&
        sanitized.backgroundMailRefreshEnabled !== (state.settings.backgroundMailRefreshEnabled === true);
      if (backgroundChanged) {
        const generation = state.settings.backgroundRefreshGeneration ?? 0;
        if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) throw new Error('Background refresh settings cannot be updated.');
        state.settings.backgroundRefreshGeneration = generation + 1;
      }
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
    const currentProjection = () => this.mailAlertRefreshRequired ? undefined :
      this.mailReplyGenerationProjection(this.snapshot, input.messageId, input.sourceDigest, input.textDigest, input.noteId, input.noteRevision);
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
        if (this.mailAlertRefreshRequired || this.mailReplyGenerationProjection(current, input.messageId, input.sourceDigest, input.textDigest, input.noteId, input.noteRevision) !== capturedProjection) {
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
        if (error instanceof ReplyGenerationError && error.usage) await this.settleModelUsage(error.usage, capturedSettings, reservation);
        if (error instanceof ReplyGenerationPreDispatchError) {
          if (reservation) await this.rollbackUnsentProviderAttempt(reservation);
          return { status: 'stale', requestFingerprint, composerRevision: input.composerRevision, fromCache: false };
        }
        throw error;
      }
      await this.settleModelUsage(generated, capturedSettings, reservation);
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
    const pages = new Map<string, CommittedMailAlertPage>();
    const result = await this.startMailLane(accountId, 'head', options.reason ?? 'manual', false, pages);
    if (result.status === 'complete' || result.status === 'partial') {
      await this.withMailAlertTransactionSlot(() => this.commitMailAlertPlan([...pages.values()]));
    }
    return result;
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
    const committedPages = new Map<string, CommittedMailAlertPage>();
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
      try { results.push(await this.startMailLane(account.id, 'head', 'foreground', true, committedPages)); }
      catch (error) { skipped.push({ accountId: account.id, reason: error instanceof Error ? error.message : 'mail refresh was skipped' }); }
    }
    if (committedPages.size) {
      try { await this.withMailAlertTransactionSlot(() => this.commitMailAlertPlan([...committedPages.values()])); }
      catch { /* Mail page commits remain valid even when the separate notification ledger needs repair. */ }
    } else {
      try { await this.withMailAlertTransactionSlot(() => this.commitMailAlertPlan([])); }
      catch { /* A failed alert cleanup never rolls back already completed mailbox work. */ }
    }
    return { attempted, skipped, results };
  }

  private startMailLane(accountId: string, lane: 'head' | 'backfill', reason: 'manual' | 'foreground', doNotQueue = false, committedPages?: Map<string, CommittedMailAlertPage>): Promise<MailLaneResult> {
    const key = `${accountId}:${lane}`;
    const sameLane = this.mailLaneJobs.get(key);
    if (sameLane) return sameLane;
    if (this.busySyncAccounts.has(accountId)) return Promise.reject(new Error('Another sync lane is already active for this account.'));
    this.busySyncAccounts.add(accountId);
    const job = this.runMailLane(accountId, lane, reason, doNotQueue, committedPages)
      .finally(() => { this.mailLaneJobs.delete(key); this.busySyncAccounts.delete(accountId); });
    this.mailLaneJobs.set(key, job);
    return job;
  }

  private async runMailLane(accountId: string, lane: 'head' | 'backfill', reason: 'manual' | 'foreground', doNotQueue: boolean, committedPages?: Map<string, CommittedMailAlertPage>): Promise<MailLaneResult> {
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
        return timestamp;
      });
      const page = await this.connector.syncMessageWindow(immutableAccount, {
        timeMin: immutableWindow.from, timeMax: immutableWindow.through, cursor: immutableWindow.cursor,
        pageSize: immutableWindow.pageSize, guard, signal: abortController.signal,
        onPage: async (items, cursor, _pagesRead, metadata) => {
          const checkedAt = await persistPage(items, cursor, metadata);
          if (lane !== 'head' || !committedPages || !account) return;
          const pageProof = await committedMailAlertPageForWorkspace(this.state, immutableAccount,
            items.flatMap((item) => typeof item.id === 'string' ? [item.id] : []), checkedAt, this.mailAlertPolicyOptions());
          if (!pageProof) return;
          const prior = committedPages.get(accountId);
          committedPages.set(accountId, prior ? {
            ...pageProof,
            checkedAt: Date.parse(pageProof.checkedAt) >= Date.parse(prior.checkedAt) ? pageProof.checkedAt : prior.checkedAt,
            sources: [...prior.sources, ...pageProof.sources].filter((source, index, all) => all.findIndex((item) => item.sourceId === source.sourceId) === index),
          } : pageProof);
        },
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

  async prepareImportedKnowledgeActivation(input: { archiveId: string; cohortId: string; kind: KnowledgeEntityKind; entityId: string }): Promise<import('../core').ImportedKnowledgeActivationPreview> {
    await this.load();
    this.assertKnowledgeWritable();
    const snapshot = this.snapshot;
    const snapshotJson = stableJson(snapshot);
    const archive = snapshot.importedBackups.find((item) => item.id === input.archiveId);
    const cohort = archive?.archivedKnowledge?.find((item) => item.id === input.cohortId);
    if (!archive || !cohort) throw new Error('Imported knowledge archive was not found.');
    const entity = getKnowledgeEntity(cohort.knowledge.state, input.kind, input.entityId);
    if (!entity) throw new Error('Imported person or project was not found.');
    const narrative = cohort.knowledge.narratives.find((item) => item.entityKind === input.kind && item.entityId === input.entityId);
    const narrativeContent = narrative?.content ?? '';
    const sourceDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, stableJson({ kind: input.kind, entity, narrativeContent }), { encoding: Crypto.CryptoEncoding.HEX });
    if (this.snapshot !== snapshot || stableJson(this.snapshot) !== snapshotJson) throw new Error('App data changed while this activation preview was being prepared. Open a fresh preview.');
    const link = cohort.activationLinks?.find((item) => item.entityKind === input.kind && item.sourceEntityId === input.entityId);
    const linkedEntity = link && getKnowledgeEntity(snapshot.knowledge, input.kind, link.entityId);
    const alreadyActivated = Boolean(link && linkedEntity?.importOrigin?.kind === 'backup_knowledge' &&
      linkedEntity.importOrigin.archiveId === archive.id && linkedEntity.importOrigin.cohortId === cohort.id &&
      linkedEntity.importOrigin.sourceEntityId === input.entityId && linkedEntity.importOrigin.sourceDigest === sourceDigest &&
      link.sourceDigest === sourceDigest && snapshot.documents.some((document) => document.path === linkedEntity.narrativePath));
    if (link && !alreadyActivated) throw new Error('The saved activation mapping cannot be verified. It is kept for recovery and will not be reused.');
    const targetId = alreadyActivated ? link!.entityId : allocateFreshId(stateEntityIds(snapshot));
    const sessionId = newId(), createdAt = Date.now(), expiresAt = new Date(createdAt + 15 * 60_000).toISOString();
    const project = entity as Project;
    const projectMembers = input.kind === 'project' ? project.members : [];
    const unresolvedMemberCount = projectMembers.filter((member) => {
      const sourcePersonId = 'sourcePersonId' in member ? member.sourcePersonId : member.personId;
      const activated = cohort.activationLinks?.find((item) => item.entityKind === 'person' && item.sourceEntityId === sourcePersonId);
      const active = activated && snapshot.knowledge.people.find((person) => person.id === activated.entityId);
      return !active || active.importOrigin?.kind !== 'backup_knowledge' || active.importOrigin.archiveId !== archive.id || active.importOrigin.cohortId !== cohort.id || active.importOrigin.sourceEntityId !== sourcePersonId || active.importOrigin.sourceDigest !== activated.sourceDigest;
    }).length;
    const preview = {
      sessionId, planHash: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, stableJson({ snapshotJson, archiveId: archive.id, cohortId: cohort.id, kind: input.kind, entityId: input.entityId, sourceDigest, targetId }), { encoding: Crypto.CryptoEncoding.HEX }),
      expiresAt, archiveId: archive.id, cohortId: cohort.id, kind: input.kind, sourceEntityId: input.entityId, sourceName: entity.name, sourceEntity: clone(entity), alreadyActivated, targetId,
      narrativePath: `${input.kind === 'person' ? 'people' : 'projects'}/${targetId}.md`, narrativeContent,
      factCount: entity.facts.length, contactCount: input.kind === 'person' ? (entity as Person).contacts.length : 0,
      sourceLinkCount: entity.sourceLinks.length, memberCount: projectMembers.length,
      unavailableProviderReferenceCount: entity.sourceLinks.filter((item) => item.reference.kind === 'historical' || item.reference.kind === 'mail' || item.reference.kind === 'calendar').length,
      unresolvedMemberCount,
    };
    for (const [id, session] of this.knowledgeActivationSessions) if (createdAt < session.preparedAtMs || createdAt - session.preparedAtMs > 15 * 60_000) this.knowledgeActivationSessions.delete(id);
    while (this.knowledgeActivationSessions.size >= 2) this.knowledgeActivationSessions.delete(this.knowledgeActivationSessions.keys().next().value!);
    this.knowledgeActivationSessions.set(sessionId, { preview, stateJson: snapshotJson, preparedAtMs: createdAt, entity: clone(entity), narrativeContent, archiveId: archive.id, cohortId: cohort.id, sourceDigest, targetId });
    return clone(preview);
  }

  async activateImportedKnowledgeEntity(input: { sessionId: string; planHash: string; expectedDocumentRevision?: number }): Promise<{ entity: Person | Project; document: ContextDocument }> {
    this.assertKnowledgeWritable();
    const session = this.knowledgeActivationSessions.get(input.sessionId);
    if (!session || session.preview.planHash !== input.planHash) throw new Error('This activation preview is missing or changed. Prepare it again.');
    const age = Date.now() - session.preparedAtMs;
    if (age < 0 || age > 15 * 60_000) { this.knowledgeActivationSessions.delete(input.sessionId); throw new Error('This activation preview expired. Prepare it again.'); }
    const result = await this.mutate(async (state) => {
      this.assertKnowledgeWritable();
      const queuedAge = Date.now() - session.preparedAtMs;
      if (queuedAge < 0 || queuedAge > 15 * 60_000) throw new Error('This activation preview expired while waiting to save. Prepare it again.');
      if (stableJson(this.publicState(state)) !== session.stateJson) throw new Error('App data changed after this preview. Prepare a fresh activation preview.');
      const archive = state.importedBackups.find((item) => item.id === session.archiveId);
      const cohort = archive?.archivedKnowledge?.find((item) => item.id === session.cohortId);
      if (!archive || !cohort) throw new Error('Imported knowledge archive is no longer available.');
      const currentSource = getKnowledgeEntity(cohort.knowledge.state, session.preview.kind, session.preview.sourceEntityId);
      if (!currentSource) throw new Error('Imported source entity is no longer available.');
      const sourceNarrative = cohort.knowledge.narratives.find((item) => item.entityKind === session.preview.kind && item.entityId === session.preview.sourceEntityId)?.content ?? '';
      const currentDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, stableJson({ kind: session.preview.kind, entity: currentSource, narrativeContent: sourceNarrative }), { encoding: Crypto.CryptoEncoding.HEX });
      const verifiedAge = Date.now() - session.preparedAtMs;
      if (verifiedAge < 0 || verifiedAge > 15 * 60_000) throw new Error('This activation preview expired while its source was being checked. Prepare it again.');
      if (currentDigest !== session.sourceDigest) throw new Error('Imported source changed after this preview. Prepare a fresh activation preview.');
      const existingLink = cohort.activationLinks?.find((item) => item.entityKind === session.preview.kind && item.sourceEntityId === session.preview.sourceEntityId);
      if (existingLink) {
        const active = getKnowledgeEntity(state.knowledge, session.preview.kind, existingLink.entityId);
        if (!active || active.importOrigin?.kind !== 'backup_knowledge' || active.importOrigin.archiveId !== archive.id || active.importOrigin.cohortId !== cohort.id || active.importOrigin.sourceEntityId !== session.preview.sourceEntityId || active.importOrigin.sourceDigest !== existingLink.sourceDigest) throw new Error('The saved activation link cannot be verified. No data was changed.');
        const document = state.documents.find((item) => item.path === active.narrativePath);
        if (!document) throw new Error('The activated narrative document is missing.');
        return { entity: active, document };
      }
      const id = session.targetId;
      if (state.knowledge.people.some((item) => item.id === id) || state.knowledge.projects.some((item) => item.id === id)) throw new Error('The planned person or project ID is already in use. Prepare a fresh preview.');
      const path = session.preview.narrativePath;
      const oldDoc = state.documents.find((item) => item.path === path);
      if (oldDoc || session.preview.narrativePath !== `${session.preview.kind === 'person' ? 'people' : 'projects'}/${id}.md` || session.preview.targetId !== id) throw new Error('The planned narrative destination is no longer available.');
      if (input.expectedDocumentRevision !== undefined) throw new Error('This narrative destination was expected to be new. Refresh the preview.');
      const timestamp = now();
      const origin = { kind: 'backup_knowledge' as const, archiveId: archive.id, cohortId: cohort.id, sourceEntityId: currentSource.id, sourceDigest: session.sourceDigest };
      const cleanEvidence = (evidence?: KnowledgeEvidence[]) => evidence?.map((entry) => {
        const sourceKind = /^(knowledge|note|doc|task|mail|calendar-event|calendar):/.exec(entry.sourceId)?.[1] ?? 'source';
        return { ...entry, sourceId: `historical:imported:${entry.sourceVersion}:${sourceKind}` };
      });
      const facts = currentSource.facts.map((item) => ({ id: this.freshStateId(state), provenance: item.provenance, createdAt: item.createdAt, ...(cleanEvidence(item.evidence) ? { evidence: cleanEvidence(item.evidence) } : {}), statement: item.statement }));
      const sourceLinks: KnowledgeSourceLink[] = currentSource.sourceLinks.map((item) => {
        let reference: KnowledgeReference = clone(item.reference);
        if (reference.kind === 'mail' || reference.kind === 'calendar') reference = { kind: 'historical', label: item.label || reference.kind, originalKind: reference.kind };
        else if (reference.kind === 'note') {
          const sourceId = reference.id; const mapped = archive.noteLinks.find((link) => link.sourceId === sourceId);
          const note = mapped && state.notes.find((candidate) => candidate.id === mapped.noteId);
          const verified = Boolean(mapped && note?.importOrigin?.kind === 'backup_import' && note.importOrigin.archiveId === archive.id && note.importOrigin.sourceNoteId === sourceId);
          reference = verified && mapped ? { kind: 'note', id: mapped.noteId } : { kind: 'historical', label: item.label, originalKind: 'note' };
        } else if (reference.kind === 'task') {
          const sourceId = reference.id; const mapped = archive.taskLinks.find((link) => link.sourceId === sourceId);
          const task = mapped && state.tasks.find((candidate) => candidate.id === mapped.taskId);
          const verified = Boolean(mapped && task?.importOrigin?.kind === 'backup_import' && task.importOrigin.archiveId === archive.id && task.importOrigin.sourceTaskId === sourceId);
          reference = verified && mapped ? { kind: 'task', id: mapped.taskId } : { kind: 'historical', label: item.label, originalKind: 'task' };
        } else if (reference.kind === 'document') {
          const sourceId = reference.id; const mapped = archive.documents.find((doc) => doc.path === sourceId && doc.activatedPath);
          const active = mapped && state.documents.find((doc) => doc.path === mapped.activatedPath);
          reference = mapped && active ? { kind: 'document', id: active.path } : { kind: 'historical', label: item.label, originalKind: 'document' };
        } else if (reference.kind === 'person' || reference.kind === 'project') {
          const mapped = cohort.activationLinks?.find((entry) => entry.entityKind === reference.kind && entry.sourceEntityId === reference.id);
          const active = mapped && getKnowledgeEntity(state.knowledge, reference.kind, mapped.entityId);
          const verified = Boolean(mapped && active?.importOrigin?.kind === 'backup_knowledge' && active.importOrigin.archiveId === archive.id &&
            active.importOrigin.cohortId === cohort.id && active.importOrigin.sourceEntityId === reference.id && active.importOrigin.sourceDigest === mapped.sourceDigest);
          reference = verified && mapped ? { kind: reference.kind, id: mapped.entityId } : { kind: 'historical', label: item.label, originalKind: reference.kind };
        }
        return { id: this.freshStateId(state), provenance: item.provenance, createdAt: item.createdAt, ...(cleanEvidence(item.evidence) ? { evidence: cleanEvidence(item.evidence) } : {}), reference, label: item.label };
      });
      let entity: Person | Project;
      if (session.preview.kind === 'person') {
        const source = currentSource as Person;
        entity = { id, revision: 1, name: source.name, aliases: [...source.aliases], narrativePath: path, createdAt: timestamp, updatedAt: timestamp, facts, sourceLinks,
          contacts: source.contacts.map((item) => ({ id: this.freshStateId(state), provenance: item.provenance, createdAt: item.createdAt, ...(cleanEvidence(item.evidence) ? { evidence: cleanEvidence(item.evidence) } : {}), address: item.address, label: item.label })), importOrigin: origin };
        state.knowledge.people.push(entity);
      } else {
        const source = currentSource as Project;
        const members: ProjectMember[] = source.members.map((member) => {
          const sourcePersonId = ('sourcePersonId' in member ? member.sourcePersonId : member.personId) ?? '';
          const activated = cohort.activationLinks?.find((link) => link.entityKind === 'person' && link.sourceEntityId === sourcePersonId);
          const activePerson = activated && state.knowledge.people.find((person) => person.id === activated.entityId);
          const verified = Boolean(activePerson && activePerson.importOrigin?.kind === 'backup_knowledge' && activePerson.importOrigin.archiveId === archive.id && activePerson.importOrigin.cohortId === cohort.id && activePerson.importOrigin.sourceEntityId === sourcePersonId && activePerson.importOrigin.sourceDigest === activated?.sourceDigest);
          const base = { id: this.freshStateId(state), provenance: member.provenance, createdAt: member.createdAt, ...(cleanEvidence(member.evidence) ? { evidence: cleanEvidence(member.evidence) } : {}), role: member.role };
          return verified && activePerson ? { ...base, personId: activePerson.id } : { ...base, sourcePersonId, label: 'Unavailable imported person' };
        });
        entity = { id, revision: 1, name: source.name, aliases: [...source.aliases], narrativePath: path, createdAt: timestamp, updatedAt: timestamp, facts, sourceLinks, status: source.status, goal: source.goal, startsOn: source.startsOn, targetOn: source.targetOn, dateTimeZone: source.dateTimeZone, members, importOrigin: origin };
        state.knowledge.projects.push(entity);
      }
      state.knowledge = validateKnowledgeState(state.knowledge);
      const document: ContextDocument = { path, content: session.narrativeContent, revision: 1, updatedAt: timestamp };
      state.documents.unshift(document);
      cohort.activationLinks ??= [];
      cohort.activationLinks.push({ entityKind: session.preview.kind, sourceEntityId: currentSource.id, entityId: id, sourceDigest: session.sourceDigest, activatedAt: timestamp });
      const verifiedArchive = validateImportedBackupArchive(archive);
      if (!verifiedArchive) throw new Error('Imported activation metadata did not validate. No data was changed.');
      state.importedBackups[state.importedBackups.findIndex((item) => item.id === archive.id)] = verifiedArchive;
      addActivity(state, 'local_action', `Imported ${session.preview.kind} “${entity.name}” was activated as a new local entry.`, {});
      this.validateKnowledgeAndBackup(state);
      return { entity: getKnowledgeEntity(state.knowledge, session.preview.kind, id)!, document };
    });
    this.knowledgeActivationSessions.delete(input.sessionId);
    await this.mirrorDocument(result.document);
    return result;
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
    const activeKnowledgePresent = backup.knowledge.state.people.length || backup.knowledge.state.projects.length || backup.knowledge.state.suggestions.length;
    const activeSourceHash = activeKnowledgePresent ? await hash(stableJson(backup.knowledge)) : undefined;
    let activeSourceId = activeSourceHash ? `active:${activeSourceHash}` : undefined;
    const archivedSourceIds = new Set(backup.archivedKnowledge.map((cohort) => cohort.sourceId));
    while (activeSourceId && archivedSourceIds.has(activeSourceId)) activeSourceId += ':active';
    const knowledgeCohorts: PortableKnowledgeCohort[] = [
      ...(activeSourceId ? [{ sourceId: activeSourceId, knowledge: backup.knowledge }] : []),
      ...backup.archivedKnowledge,
    ];
    const legacyV2Content = legacyCanonicalPortableContentV2(backup);
    const legacyV2Hash = legacyV2Content ? await hash(legacyV2Content) : undefined;
    const usedIds = stateEntityIds(capturedSnapshot);
    const allocateId = () => allocateFreshId(usedIds);
    const existingArchive = capturedSnapshot.importedBackups.find((item) => item.contentHash === contentHash || (legacyV2Hash && item.contentHash === legacyV2Hash));
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
    const knowledgeCohortIds = Object.create(null) as Record<string, string>;
    for (const cohort of knowledgeCohorts) {
      const existing = existingArchive?.archivedKnowledge?.find((item) => item.sourceId === cohort.sourceId);
      knowledgeCohortIds[cohort.sourceId] = existing?.id ?? allocateId();
    }
    const sessionId = allocateId();
    const planFields = {
      fileHash, contentHash, sourceFormat: parsed.sourceFormat,
      archiveId, existingArchiveId: existingArchive?.id, noteIds, taskIds, taskLinkRepairs, documentIds, historyIds, knowledgeCohortIds, capturedStateJson,
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
      sourceFormat: parsed.sourceFormat,
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
      knowledgeCohortIds, knowledgeCohorts,
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
      const alreadyImported = (session.existingArchiveId ? state.importedBackups.find((item) => item.id === session.existingArchiveId) : undefined) ?? state.importedBackups.find((item) => item.contentHash === session.preview.contentHash);
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
      }) && session.knowledgeCohorts.every((cohort) => alreadyImported.archivedKnowledge?.some((item) => item.sourceId === cohort.sourceId)));
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
      created.archivedKnowledge ??= [];
      for (const cohort of session.knowledgeCohorts) if (!created.archivedKnowledge.some((item) => item.sourceId === cohort.sourceId)) {
        created.archivedKnowledge.push({ id: session.knowledgeCohortIds[cohort.sourceId], sourceId: cohort.sourceId, knowledge: clone(cohort.knowledge) });
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
      if (notes.length || tasks.length || Object.keys(session.taskLinkRepairs).length || session.knowledgeCohorts.length) {
        addActivity(state, 'local_action', `Restored ${notes.length} note${notes.length === 1 ? '' : 's'} and ${tasks.length} task${tasks.length === 1 ? '' : 's'} from an imported backup; knowledge entries remain in the inert archive until activated.`);
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
    await this.mutate(async (state) => {
      if (state.proposals.some((proposal) => proposal.noteId === id && (proposal.kind !== 'reminder' && ['dispatching', 'unknown'].includes(proposal.status)))) throw new Error('Wait for the in-progress external action result before deleting this note.');
      for (const proposal of state.proposals.filter((item) => item.noteId === id && item.kind === 'reminder')) {
        const revisions = new Set([proposal.notificationRevision ?? proposal.revision]);
        for (const revision of revisions) await this.enqueueLegacyReminderCancellation(state, proposal.id, revision);
      }
      for (const reminder of state.reminders.records.filter((item) => item.origin.kind === 'note' && item.origin.noteId === id && item.status !== 'cancelled' && item.status !== 'completed')) {
        this.cancellationForCurrentIntent(state, reminder);
        reminder.revision += 1; reminder.status = 'cancelled'; reminder.updatedAt = now(); delete reminder.currentIntentId;
      }
      state.notes = state.notes.filter((item) => item.id !== id);
      state.proposals = state.proposals.filter((item) => item.noteId !== id);
      state.activity = state.activity.filter((item) => item.noteId !== id);
    });
    await this.reconcileReminderAlerts();
    if (audioUri) {
      try { await (this.integration.removeAudio?.(audioUri) ?? removeAudio(audioUri, this.integration.audioBoundary)); }
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
        return Boolean(!defaultController?.getSnapshot().mailAlertRefreshRequired && current && current.connected && current.authStatus === 'connected' && current.tokenRef === account.tokenRef &&
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

/**
 * Constructs the production workspace only after the independent privacy journal
 * confirms that no erase is active. Callers should use this factory at the app
 * bootstrap boundary before rendering or invoking data-bearing controller APIs.
 */
export interface ProductionWorkspaceOptions {
  privacy?: PrivacyService;
  session?: PrivacyWorkspaceSession;
  resources?: PrivacyResourceBoundary;
  audioBoundary?: PrivacyAudioBoundary;
  credentials?: ProviderCredentialService;
  store?: StateStore;
  providers?: { speech?: AzureSpeechClient; openAi?: AzureOpenAIClient };
  integration?: ControllerIntegrationDependencies;
  pendingCaptureNativeIO?: PendingCaptureNativeIO;
}

export async function createProductionWorkspace(options: ProductionWorkspaceOptions = {}): Promise<{ controller: AppController; backgroundTasks: BackgroundTaskBackend; mailAlertTaps: MailAlertTapBackend; captureJournal?: PendingCaptureJournalPort }> {
  const privacy = options.privacy ?? options.resources?.privacy ?? await getDefaultPrivacyService();
  if (options.resources && options.resources.privacy !== privacy) throw new Error('Privacy resource boundary belongs to a different control service.');
  const requestedSession = options.session ?? options.resources?.session;
  const capturedRequestedSession = requestedSession
    ? Object.freeze({ epoch: requestedSession.epoch, runtimeId: requestedSession.runtimeId })
    : undefined;
  const openedSession = await privacy.openWorkspace();
  const session: PrivacyWorkspaceSession = capturedRequestedSession ?? Object.freeze({ epoch: openedSession.epoch, runtimeId: openedSession.runtimeId });
  if (session.epoch !== openedSession.epoch || session.runtimeId !== openedSession.runtimeId) {
    throw new Error('The supplied privacy workspace session is no longer current.');
  }
  if (options.resources && (options.resources.session.epoch !== session.epoch || options.resources.session.runtimeId !== session.runtimeId)) {
    throw new Error('Privacy resource boundary belongs to a different workspace session.');
  }
  if (options.audioBoundary && (options.audioBoundary.binding.privacy !== privacy ||
      options.audioBoundary.binding.session.epoch !== session.epoch || options.audioBoundary.binding.session.runtimeId !== session.runtimeId)) {
    throw new Error('Privacy audio boundary belongs to a different workspace session.');
  }
  const audioBoundary = options.audioBoundary ?? createPrivacyAudioBoundary({
    privacy, session, captureNamespace: Platform.OS === 'web' ? 'browser_audio' : 'native_recordings',
  });
  const resources = options.resources ?? createPrivacyResourceBoundary({ privacy, session });
  let implementation: AppControllerImpl | undefined;
  const rawStore = options.store ?? createPlatformStateStore();
  const boundStore = bindWorkspaceStorage(rawStore, privacy, session);
  let captureJournal: PendingCaptureJournalPort | undefined;
  let pendingCaptureController: PendingCaptureControllerPort | undefined;
  if (Platform.OS === 'ios' && rawStore.pendingCapture) {
    let nativeIO = options.pendingCaptureNativeIO;
    if (!nativeIO) {
      const native = await import('../audio/pendingCaptureNativeIO.native');
      nativeIO = native.pendingCaptureNativeIO;
    }
    const service = createPendingCaptureService({ backend: rawStore.pendingCapture, privacy, session, nativeIO });
    captureJournal = service.journal;
    pendingCaptureController = service.controller;
  }
  const rawTokenStore = options.integration?.tokenStore ?? oauthTokenStore;
  const tokenStore = resources.oauthTokenStore(rawTokenStore);
  const providerCredentials = options.credentials ?? options.integration?.credentials ?? createProviderCredentialService(resources.credentialStore(credentialStore));
  const rawWriteDocument = options.integration?.writeDocument ?? writePrivateDocument;
  const configuredConnectorFactory = options.integration?.connectorFactory;
  let factoryConnector: ConnectorClient | undefined;
  const boundNotifications = resources.notificationBackend(options.integration?.reminderBackend ?? createNotificationBackend());
  const boundDeviceCalendars = resources.deviceCalendarBackend(options.integration?.deviceCalendarBackend ?? getDeviceCalendarBackend());
  const rawBackgroundTasks = options.integration?.backgroundTasks ?? (await import('../background/backend')).backgroundTaskBackend;
  const boundBackgroundTasks = resources.backgroundTaskBackend(rawBackgroundTasks);
  const mailAlertTaps = options.integration?.mailAlertTapBackend ?? createMailAlertTapBackend({
    withNotificationOwnership: (actual) => resources.withMailAlertNotificationWriter(() => actual()),
  });
  const integration: ControllerIntegrationDependencies = {
    ...defaultIntegration,
    ...options.integration,
    credentials: providerCredentials,
    audioBoundary,
    speechAudioService: options.integration?.speechAudioService ?? createPrivacyBoundSpeechAudioService(audioBoundary),
    removeAudio: async (uri) => audioBoundary.withAudioWrite(() => options.integration?.removeAudio
      ? options.integration.removeAudio(uri)
      : removeAudio(uri)),
    reminderBackend: boundNotifications.backend,
    mailAlertBackend: options.integration?.mailAlertBackend ?? createMailAlertNotificationBackend(),
    withMailAlertNotificationWriter: options.integration?.withMailAlertNotificationWriter ?? ((actual) => resources.withMailAlertNotificationWriter((scope) =>
      actual(scope, bindExistingWorkspaceWriter(rawStore, privacy, session, scope)))),
    deviceCalendarBackend: boundDeviceCalendars.backend,
    disposePrivacyResources: () => { boundNotifications.dispose(); boundDeviceCalendars.dispose(); boundBackgroundTasks.dispose(); },
    privacySession: {
      epoch: session.epoch,
      assertCurrent: () => privacy.assertWorkspaceEpoch(session.epoch),
      getStatus: () => privacy.getStatus(),
    },
    writeDocument: async (path, content) => {
      await privacy.withWriter(session.epoch, { kind: 'markdown_mirror', namespace: 'markdown_mirrors', legacyMarkdownPath: path }, () => rawWriteDocument(path, content));
    },
    tokenStore,
    deleteToken: tokenStore.delete,
    connectorFactory: (store, onAuthStatus) => {
      const connector = configuredConnectorFactory?.(store, onAuthStatus, resources.withProviderOwnership) ?? new ConnectorClient({
        tokenStore: store, googleClientId, microsoftClientId, microsoftAuthority, onAuthStatus,
        withProviderOwnership: resources.withProviderOwnership,
        isConnectionCurrent: (account) => {
          const current = implementation?.getSnapshot().accounts.find((item) => item.id === account.id);
          return Boolean(!implementation?.getSnapshot().mailAlertRefreshRequired && current && current.connected && current.authStatus === 'connected' && current.tokenRef === account.tokenRef &&
            current.connectionGeneration === account.connectionGeneration && sameAccountIdentity(current.identity, account.identity));
        },
      });
      if (connector instanceof ConnectorClient) factoryConnector = connector;
      return connector;
    },
    verifyOAuthResult: options.integration?.verifyOAuthResult ?? (async (result, stored) => {
      if (!factoryConnector || !await factoryConnector.verifyOAuthIdentity(result, stored)) return false;
      const known: AccountCapability[] = ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'];
      if (result.requestedCapabilities.some((item) => !known.includes(item)) || result.capabilities.some((item) => !result.requestedCapabilities.includes(item))) return false;
      if (result.requestedCapabilities.includes('calendar.write') && !result.requestedCapabilities.includes('calendar.read')) return false;
      return result.capabilities.every((item) => scopeGrantsCapability(result.provider, result.grantedScopes, item));
    }),
  };
  const providers = {
    speech: options.providers?.speech ?? new AzureSpeechClient({
      audio: integration.speechAudioService,
      readKeySnapshot: () => providerCredentials.readSpeechCredentialSnapshot(),
      currentCredentialGeneration: () => providerCredentials.currentSpeechCredentialGeneration(),
      assertCredentialGeneration: (generation) => providerCredentials.assertSpeechCredentialGeneration(generation),
      withRequestOwnership: (actualRequest) => privacy.withWriter(session.epoch, { kind: 'speech_upload', namespace: 'speech_staging' }, actualRequest),
    }),
    openAi: options.providers?.openAi ?? new AzureOpenAIClient(fetch, () => providerCredentials.readProviderCredential('openai'), resources.withProviderOwnership),
  };
  implementation = new AppControllerImpl(boundStore, providers, integration, pendingCaptureController);
  return { controller: createPrivacyBoundController(implementation, privacy, session), backgroundTasks: boundBackgroundTasks.backend, mailAlertTaps, ...(captureJournal ? { captureJournal } : {}) };
}

export async function createProductionController(options: ProductionWorkspaceOptions = {}): Promise<AppController> {
  return (await createProductionWorkspace(options)).controller;
}
