import type {
  Account, AccountSyncState, ActivityItem, AppController, AppSettings, AppState, Calendar, CalendarEventSnapshot,
  ContextDocument, DeviceCalendarAccessState, LocalTask, MailboxSnapshotMessage, MailReplySourceSnapshot, Note,
  NoteAssistResult, Proposal, ProposalEvidence, ProactiveState, ProactiveCandidateEntry, ProactiveDismissal,
  ProactiveSnoozeEntry, SavedProactiveRule,
} from '../core';
import type { AssistantCitation, AssistantDecision } from '../assistant';
import type { DispatchRecord } from '../dispatch';
import type { KnowledgeChange, KnowledgeEvidence, KnowledgeFact, KnowledgeReference, KnowledgeSourceLink,
  KnowledgeState, KnowledgeSuggestion, Person, Project, ProjectMember, ContactClaim } from '../knowledge/types';
import type { ProactiveMailAlertState, ProactiveMailAlertReceipt, ProactiveMailAlertConsent } from '../proactiveMailAlerts/types';
import type { ReminderIntent, ReminderRecord, ReminderState } from '../reminders/types';
import type { ProactiveCandidate, ProactiveSource } from '../proactive';
import type { ImportedBackupArchive, PortableHistoryEntry, PortableKnowledge } from '../backup';
import type { InertImportedChatConversation } from '../chat/portable';
import type { AssistantBatchJobDTO } from '../services/openRouterBatchJobs';
import type { ChatConversationDTO, ChatTurnDTO } from '../chat/types';
import type { TranscriptionAttempt, TranscriptionState } from '../transcription/types';
import type { RecoveryFormat } from '../audio/recovery.types';
import type { DeviceCalendarState, DeviceEventDispatchRecord, DeviceEventSnapshot } from '../deviceCalendars/types';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WorkspaceSnapshotMetadata {
  readonly workspaceId: string;
  readonly privacyEpoch: number;
  readonly revision: number;
}

export interface WorkspaceAudioReference {
  readonly available: boolean;
  readonly mediaId?: string;
  readonly format?: RecoveryFormat;
  readonly mimeType?: string;
  readonly byteLength?: number;
}

export type WorkspaceNoteDTO = Omit<Note, 'audioUri' | 'analysis' | 'audioAttachment' | 'processingFingerprint'> & {
  readonly audio?: WorkspaceAudioReference;
  readonly audioAttachment?: NonNullable<Note['audioAttachment']>;
  readonly analysis?: NoteAssistResult;
};

export type WorkspaceAccountDTO = Omit<Account, 'tokenRef'> & { readonly credentialConfigured: boolean };

export type WorkspaceProposalDTO = Omit<Proposal,
  'approvedPayloadDigest' | 'eventTransactionId' | 'deviceCalendarApproval' | 'deviceEventDispatchRecordId' |
  'sourceActionKey' | 'dispatchDependencyProjection' | 'dispatchRecordId'>;

export type WorkspaceDispatchRecordDTO = Omit<DispatchRecord,
  'sourceActionKey' | 'duplicateKey' | 'mailReplyBatchBinding' | 'providerIdempotencyKey'>;

export interface WorkspaceTranscriptionAttemptDTO {
  readonly id: string;
  readonly noteId: string;
  readonly sourceRevision: number;
  readonly source: Readonly<{
    durationSeconds: number;
    capturedAt: string;
    captureTimeZone: string;
    speechEnabled: boolean;
    maxAudioSeconds: number;
    provider?: 'azure' | 'openrouter';
    audioAttachment?: NonNullable<TranscriptionAttempt['source']['audioAttachment']>;
  }>;
  readonly provider?: 'azure' | 'openrouter';
  readonly profileVersion?: number;
  readonly model?: string;
  readonly locale: string;
  readonly createdAt: string;
  readonly dispatchStarted: boolean;
  readonly outcome: TranscriptionAttempt['outcome'];
  readonly costStatus: 'reported' | 'unknown';
  readonly terminalAt?: string;
  readonly code?: TranscriptionAttempt['code'];
  readonly durationMilliseconds?: number;
  readonly transcriptSha256?: string;
  readonly actualUsage?: TranscriptionAttempt['actualUsage'];
  readonly unknownCharge?: boolean;
  readonly lateObservations?: TranscriptionAttempt['lateObservations'];
}

export interface WorkspaceTranscriptionDTO {
  readonly schemaVersion: TranscriptionState['schemaVersion'];
  readonly attempts: readonly WorkspaceTranscriptionAttemptDTO[];
  readonly cleanup: Readonly<{ count: number; pendingCount: number; pendingAttemptIds: readonly string[] }>;
}

export interface WorkspaceDeviceCalendarDTO {
  readonly enabled: boolean;
  readonly calendars: readonly Readonly<{ localId: string; title: string; sourceName?: string; sourceType?: string; timeZone?: string; allowsModifications: boolean; observedAt: string }>[];
  readonly selectedCalendarIds: readonly string[];
  readonly events: readonly Readonly<Omit<DeviceEventSnapshot, 'generation'> & { readonly calendarId: string }>[];
  readonly dispatchHistory: readonly WorkspaceDeviceDispatchSummary[];
  readonly readStatus?: Readonly<{ partial: boolean; truncatedCalendars: number; truncatedEvents: number; startedAt: string }>;
}

export interface WorkspaceDeviceDispatchSummary {
  readonly id: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly sourceRevision?: number;
  readonly title: string;
  readonly body: string;
  readonly payload: DeviceEventDispatchRecord['payload'];
  readonly claimAt: string;
  readonly outcome: DeviceEventDispatchRecord['outcome'];
  readonly outcomeAt?: string;
  readonly errorCode?: DeviceEventDispatchRecord['errorCode'];
  readonly reconciliations: readonly Readonly<Pick<DeviceEventDispatchRecord['reconciliations'][number], 'disposition' | 'at' | 'note'>>[];
}

export interface WorkspaceMailAlertConsentDTO {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly ruleRevision: number;
  readonly timeZone: string;
  readonly activatedAt: string;
  readonly status: ProactiveMailAlertConsent['status'];
  readonly revokedAt?: string;
  readonly revocationReason?: ProactiveMailAlertConsent['revocationReason'];
  readonly accountIds: readonly string[];
}

export interface WorkspaceMailAlertReceiptDTO {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly ruleRevision: number;
  readonly timeZone: string;
  readonly accountId: string;
  readonly receivedAt: string;
  readonly desired: ProactiveMailAlertReceipt['desired'];
  readonly observed: ProactiveMailAlertReceipt['observed'];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attemptedAt?: string;
  readonly cancellation?: ProactiveMailAlertReceipt['cancellation'];
}

export interface WorkspaceProactiveMailAlertDTO {
  readonly schemaVersion: ProactiveMailAlertState['schemaVersion'];
  readonly revision: number;
  readonly consents: readonly WorkspaceMailAlertConsentDTO[];
  readonly receipts: readonly WorkspaceMailAlertReceiptDTO[];
}

export interface WorkspaceReminderStateDTO {
  readonly schemaVersion: ReminderState['schemaVersion'];
  readonly records: readonly (Omit<ReminderRecord, 'approvedPayloadDigest' | 'currentIntentId' | 'origin'> & Readonly<{ origin: WorkspaceReminderRecordOrigin }>)[];
  readonly intents: readonly Omit<ReminderIntent, 'identifier'>[];
  readonly legacyCancellations?: readonly Readonly<Omit<NonNullable<ReminderState['legacyCancellations']>[number], 'identifier'>>[];
}

export type WorkspaceReminderRecordOrigin =
  | Readonly<{ kind: 'manual' }>
  | Readonly<{ kind: 'note'; noteId: string; proposalId: string; proposalRevision: number; sourceRevision: number; sourceVersion: string; quote: string }>
  | Readonly<{ kind: 'proactive'; candidate: ProactiveCandidate;
      rule: { id: string; revision: number; version: number; name: string }; source: ProactiveSource; capturedAt: string; expiresAt: string }>;

export interface WorkspaceDTOState {
  readonly notes: readonly WorkspaceNoteDTO[];
  readonly proposals: readonly WorkspaceProposalDTO[];
  readonly tasks: readonly LocalTask[];
  readonly accounts: readonly WorkspaceAccountDTO[];
  readonly calendars: readonly Calendar[];
  readonly documents: readonly ContextDocument[];
  readonly activity: readonly ActivityItem[];
  readonly settings: WorkspaceSettingsDTO;
  readonly usage: WorkspaceUsageDTO;
  readonly transcription: WorkspaceTranscriptionDTO;
  readonly transcriptionRecoveryStatus?: AppState['transcriptionRecoveryStatus'];
  readonly mailbox: readonly MailboxSnapshotMessage[];
  readonly selectedMailTexts: readonly AppState['selectedMailTexts'][number][];
  readonly calendarEvents: readonly CalendarEventSnapshot[];
  readonly deviceCalendars: WorkspaceDeviceCalendarDTO;
  readonly deviceCalendarAccess: Readonly<Pick<DeviceCalendarAccessState, 'status' | 'checkedAt'>>;
  readonly deviceCalendarRecoveryStatus?: AppState['deviceCalendarRecoveryStatus'];
  readonly syncStates: Readonly<Record<string, WorkspaceSyncStateDTO>>;
  readonly credentialCleanup: Readonly<{ pendingCount: number; reasons: Readonly<Record<'replaced' | 'disconnected' | 'orphan', number>> }>;
  readonly dispatchRecords: readonly WorkspaceDispatchRecordDTO[];
  readonly dispatchRecoveryStatus?: AppState['dispatchRecoveryStatus'];
  readonly mailboxSchemaVersion: AppState['mailboxSchemaVersion'];
  readonly proactive: Readonly<ProactiveState>;
  readonly proactiveMailAlerts: WorkspaceProactiveMailAlertDTO;
  readonly proactiveMailAlertRecoveryStatus?: AppState['proactiveMailAlertRecoveryStatus'];
  readonly mailAlertRefreshRequired?: AppState['mailAlertRefreshRequired'];
  readonly assistantBatchJobs: readonly AssistantBatchJobDTO[];
  readonly assistantChatConversations: readonly ChatConversationDTO[];
  readonly assistantChatRecoveryStatus?: AppState['assistantChatRecoveryStatus'];
  readonly assistantBatchRecoveryStatus?: AppState['assistantBatchRecoveryStatus'];
  readonly importedBackups: readonly ImportedBackupArchive[];
  readonly backupRecoveryStatus?: AppState['backupRecoveryStatus'];
  readonly knowledge: Readonly<KnowledgeState>;
  readonly knowledgeRecoveryStatus?: AppState['knowledgeRecoveryStatus'];
  readonly reminders: WorkspaceReminderStateDTO;
  readonly reminderRecoveryStatus?: AppState['reminderRecoveryStatus'];
}

export interface WorkspaceSettingsDTO {
  readonly mode: AppSettings['mode'];
  readonly llmProvider: AppSettings['llmProvider'];
  readonly openRouterModel: AppSettings['openRouterModel'];
  readonly openRouterReasoningEffort: AppSettings['openRouterReasoningEffort'];
  readonly llmRequestContractVersion: AppSettings['llmRequestContractVersion'];
  readonly timezone: AppSettings['timezone'];
  readonly backgroundMailRefreshEnabled: AppSettings['backgroundMailRefreshEnabled'];
  readonly backgroundRefreshGeneration: AppSettings['backgroundRefreshGeneration'];
  readonly speechEnabled: AppSettings['speechEnabled'];
  readonly speechProvider: AppSettings['speechProvider'];
  readonly speechEndpoint?: AppSettings['speechEndpoint'];
  readonly speechRegion?: AppSettings['speechRegion'];
  readonly maxAudioSeconds: AppSettings['maxAudioSeconds'];
  readonly audioRetention: AppSettings['audioRetention'];
}

export interface WorkspaceUsageDTO {
  readonly month: AppState['usage']['month'];
  readonly day: AppState['usage']['day'];
  readonly requests: AppState['usage']['requests'];
  readonly attemptsToday: AppState['usage']['attemptsToday'];
  readonly inputTokens: AppState['usage']['inputTokens'];
  readonly outputTokens: AppState['usage']['outputTokens'];
  readonly transcriptionSeconds: AppState['usage']['transcriptionSeconds'];
  readonly attempts: AppState['usage']['attempts'];
  readonly unknownCharges: AppState['usage']['unknownCharges'];
  readonly lastRequestAt?: AppState['usage']['lastRequestAt'];
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
    : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

interface WorkspaceSnapshotDTOShape {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly privacyEpoch: number;
  readonly revision: number;
  readonly state: WorkspaceDTOState;
}
export type WorkspaceSnapshotDTO = DeepReadonly<WorkspaceSnapshotDTOShape>;

export interface WorkspaceMediaResolver {
  /** Returns an opaque server-owned UUID only when this local URI already has an owned media mapping. */
  resolveMediaId(note: Readonly<Note>, localUri: string): string | undefined;
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result: Partial<Pick<T, K>> = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
  return result as Pick<T, K>;
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(cloned);
  return cloned;
}

function assertList<T>(value: readonly T[] | undefined, label: string): readonly T[] {
  if (!Array.isArray(value)) throw new TypeError(`workspace_snapshot_invalid_${label}`);
  return value;
}

function projectCitation(value: AssistantCitation): AssistantCitation {
  return pick(value, ['sourceId', 'revision', 'sourceVersion', 'quote', 'source']) as AssistantCitation;
}
function projectDecision(value: AssistantDecision): AssistantDecision {
  return { ...projectCitation(value), text: value.text };
}
function projectAnalysis(value: NoteAssistResult): NoteAssistResult {
  return {
    noteId: value.noteId, sourceRevision: value.sourceRevision, intent: value.intent,
    ...(value.question !== undefined ? { question: value.question } : {}), fingerprint: value.fingerprint,
    analyzedAt: value.analyzedAt, capturedAt: value.capturedAt, captureTimeZone: value.captureTimeZone,
    summary: value.summary, answer: value.answer, decisions: value.decisions.map(projectDecision),
    citations: value.citations.map(projectCitation), clarifications: [...value.clarifications], proposalIds: [...value.proposalIds],
    ...(value.memorySuggestionIds ? { memorySuggestionIds: [...value.memorySuggestionIds] } : {}), source: value.source,
    includedSourceIds: [...value.includedSourceIds], includedSources: value.includedSources.map((item) => pick(item, ['id', 'title', 'excerpt'])),
    omittedSourceIds: [...value.omittedSourceIds], omittedSourceCount: value.omittedSourceCount,
    sourceVersions: { ...value.sourceVersions },
    ...(value.knowledgeSelection ? { knowledgeSelection: value.knowledgeSelection.map((item) => pick(item, ['kind', 'id'])) } : {}),
    ...(value.answeredAsOf !== undefined ? { answeredAsOf: value.answeredAsOf } : {}),
    ...(value.answerTimeZone !== undefined ? { answerTimeZone: value.answerTimeZone } : {}),
    ...(value.stale !== undefined ? { stale: value.stale } : {}),
  };
}

function projectNote(note: Note, resolver?: WorkspaceMediaResolver): WorkspaceNoteDTO {
  const audioMeta = note.audioAttachment ? pick(note.audioAttachment, ['kind', 'fileName', 'format', 'mimeType', 'byteLength', 'sha256', 'durationStatus', 'durationSeconds', 'originalMatch', 'attachedAt']) : undefined;
  let audio: WorkspaceAudioReference | undefined;
  if (note.audioUri !== undefined || audioMeta) {
    let mediaId: string | undefined;
    if (note.audioUri && resolver) {
      const candidate = resolver.resolveMediaId(note, note.audioUri);
      if (candidate && UUID_V4.test(candidate)) mediaId = candidate;
    }
    audio = {
      available: mediaId !== undefined,
      ...(mediaId ? { mediaId } : {}),
      ...(audioMeta && 'format' in audioMeta ? { format: audioMeta.format } : {}),
      ...(audioMeta && 'mimeType' in audioMeta ? { mimeType: audioMeta.mimeType } : {}),
      ...(audioMeta && 'byteLength' in audioMeta ? { byteLength: audioMeta.byteLength } : {}),
    };
  }
  return {
    id: note.id, title: note.title, transcript: note.transcript, durationSeconds: note.durationSeconds,
    createdAt: note.createdAt, ...(note.capturedAt !== undefined ? { capturedAt: note.capturedAt } : {}),
    status: note.status, ...(note.origin ? { origin: note.origin } : {}), revision: note.revision,
    ...(note.captureTimeZone !== undefined ? { captureTimeZone: note.captureTimeZone } : {}),
    ...(note.analysis ? { analysis: projectAnalysis(note.analysis) } : {}),
    ...(audioMeta ? { audioAttachment: audioMeta as NonNullable<Note['audioAttachment']> } : {}),
    ...(note.importOrigin ? { importOrigin: pick(note.importOrigin, ['kind', 'archiveId', 'sourceNoteId', 'audioMissing', 'originalTimeZoneUnknown', 'timeZoneConfirmedAt', 'originUnverified']) } : {}),
    ...(audio ? { audio } : {}),
  };
}

function projectIdentity(value: NonNullable<Account['identity']>): NonNullable<Account['identity']> {
  return pick(value, ['providerNamespace', 'clientId', 'subject', 'issuer', 'tenantId', 'resourceUserId']) as NonNullable<Account['identity']>;
}
function projectAccount(account: Account): WorkspaceAccountDTO {
  return {
    id: account.id, provider: account.provider, displayName: account.displayName, email: account.email,
    ...(account.verifiedEmail !== undefined ? { verifiedEmail: account.verifiedEmail } : {}), connected: account.connected,
    authStatus: account.authStatus, ...(account.identity ? { identity: projectIdentity(account.identity) } : {}),
    credentialConfigured: Boolean(account.tokenRef),
    ...(account.grantedScopes ? { grantedScopes: [...account.grantedScopes] } : {}),
    ...(account.capabilities ? { capabilities: [...account.capabilities] } : {}),
    ...(account.capabilityLimits ? { capabilityLimits: [...account.capabilityLimits] } : {}),
    ...(account.lastSyncedAt !== undefined ? { lastSyncedAt: account.lastSyncedAt } : {}),
    ...(account.syncStatus !== undefined ? { syncStatus: account.syncStatus } : {}),
    ...(account.configuredAt !== undefined ? { configuredAt: account.configuredAt } : {}),
    ...(account.connectionGeneration !== undefined ? { connectionGeneration: account.connectionGeneration } : {}),
  };
}

function projectMailSource(value: MailReplySourceSnapshot): MailReplySourceSnapshot {
  return {
    version: value.version, accountId: value.accountId, accountEmail: value.accountEmail,
    ...(value.verifiedSelfEmail !== undefined ? { verifiedSelfEmail: value.verifiedSelfEmail } : {}),
    identity: projectIdentity(value.identity), connectionGeneration: value.connectionGeneration,
    localMessageId: value.localMessageId, providerMessageId: value.providerMessageId, idFormat: value.idFormat,
    ...(value.providerVersion !== undefined ? { providerVersion: value.providerVersion } : {}),
    ...(value.threadId !== undefined ? { threadId: value.threadId } : {}), internetMessageId: value.internetMessageId,
    ...(value.references !== undefined ? { references: value.references } : {}), ...(value.inReplyTo !== undefined ? { inReplyTo: value.inReplyTo } : {}),
    subject: value.subject, ...(value.from !== undefined ? { from: value.from } : {}), ...(value.senderEmail !== undefined ? { senderEmail: value.senderEmail } : {}),
    ...(value.replyTo ? { replyTo: [...value.replyTo] } : {}), ...(value.to ? { to: [...value.to] } : {}), ...(value.cc ? { cc: [...value.cc] } : {}),
    ...(value.snippet !== undefined ? { snippet: value.snippet } : {}), replyMetadataComplete: value.replyMetadataComplete,
    observedAt: value.observedAt, sourceDigest: value.sourceDigest,
  };
}
function projectProvenance(value: Proposal['provenance']): Proposal['provenance'] {
  if (!value) return undefined;
  if ('kind' in value) return { version: 2, kind: 'mail_reply', sourceDigest: value.sourceDigest,
    source: projectMailSource(value.source), expiresAt: value.expiresAt, ...(value.batchJobId ? { batchJobId: value.batchJobId } : {}) };
  return {
    version: 1, assistContractVersion: value.assistContractVersion, analysisFingerprint: value.analysisFingerprint,
    noteId: value.noteId, noteRevision: value.noteRevision, capturedAt: value.capturedAt, captureTimeZone: value.captureTimeZone,
    intent: value.intent, ...(value.question !== undefined ? { question: value.question } : {}),
    ...(value.knowledgeSelection ? { knowledgeSelection: value.knowledgeSelection.map((item) => pick(item, ['kind', 'id'])) } : {}),
    sources: value.sources.map((source) => pick(source, ['sourceId', 'revision', 'sourceVersion'])),
    policySources: value.policySources.map((source) => pick(source, ['sourceId', 'revision', 'sourceVersion'])),
    settingsFingerprint: value.settingsFingerprint, ...(value.answeredAsOf ? { answeredAsOf: value.answeredAsOf } : {}),
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
  };
}

function projectProposalEvidence(value: ProposalEvidence): ProposalEvidence { return pick(value, ['quote', 'start', 'end', 'confidence', 'source']) as ProposalEvidence; }
function projectEmail(value: NonNullable<Proposal['email']>): NonNullable<Proposal['email']> {
  return { ...(value.operation ? { operation: value.operation } : {}), to: [...value.to], cc: [...value.cc], bcc: [...value.bcc],
    subject: value.subject, text: value.text, attachments: value.attachments.map((item) => pick(item, ['id', 'fileName', 'mimeType', 'sizeBytes', 'sha256'])),
    ...(value.reply ? { reply: pick(value.reply, ['mode', 'sourceDigest', 'localMessageId', 'providerMessageId', 'idFormat', 'internetMessageId', 'sourceSubject', 'threadId', 'references', 'inReplyTo']) } : {}) };
}
function projectEvent(value: NonNullable<Proposal['event']>): NonNullable<Proposal['event']> { return { ...(value.title !== undefined ? { title: value.title } : {}), ...(value.description !== undefined ? { description: value.description } : {}), start: value.start, end: value.end, timeZone: value.timeZone, attendees: [...value.attendees], invitePolicy: value.invitePolicy }; }
function projectProposal(value: Proposal): WorkspaceProposalDTO {
  return {
    id: value.id, ...(value.noteId ? { noteId: value.noteId } : {}), kind: value.kind, title: value.title, body: value.body,
    status: value.status, revision: value.revision, ...(value.approvedRevision !== undefined ? { approvedRevision: value.approvedRevision } : {}),
    ...(value.lastError !== undefined ? { lastError: value.lastError } : {}), ...(value.notificationRevision !== undefined ? { notificationRevision: value.notificationRevision } : {}),
    ...(value.reminderId ? { reminderId: value.reminderId } : {}),
    ...(value.eventDestination ? { eventDestination: value.eventDestination.kind === 'remote_calendar'
      ? { kind: 'remote_calendar' as const, accountId: value.eventDestination.accountId, calendarId: value.eventDestination.calendarId }
      : { kind: 'device_calendar' as const, calendarId: value.eventDestination.calendarId } } : {}),
    ...(value.provenance ? { provenance: projectProvenance(value.provenance) } : {}),
    ...(value.requiresRebuild !== undefined ? { requiresRebuild: value.requiresRebuild } : {}),
    ...(value.dispatchHistoryIncomplete !== undefined ? { dispatchHistoryIncomplete: value.dispatchHistoryIncomplete } : {}),
    ...(value.dispatchRecoveryRetired ? { dispatchRecoveryRetired: true } : {}),
    ...(value.accountId ? { accountId: value.accountId } : {}), recipients: [...value.recipients],
    ...(value.calendarId ? { calendarId: value.calendarId } : {}), ...(value.sourceRevision !== undefined ? { sourceRevision: value.sourceRevision } : {}),
    evidence: value.evidence.map(projectProposalEvidence), ...(value.dueAt ? { dueAt: value.dueAt } : {}),
    ...(value.email ? { email: projectEmail(value.email) } : {}), ...(value.event ? { event: projectEvent(value.event) } : {}),
    ...(value.simulated !== undefined ? { simulated: value.simulated } : {}), ...(value.remoteOperation ? { remoteOperation: value.remoteOperation } : {}),
    ...(value.remoteId ? { remoteId: value.remoteId } : {}), ...(value.remoteAcceptedAt ? { remoteAcceptedAt: value.remoteAcceptedAt } : {}),
  };
}

function projectTask(task: LocalTask): LocalTask {
  return { id: task.id, title: task.title, body: task.body, status: task.status, createdAt: task.createdAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}), ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    ...('importOrigin' in task && task.importOrigin ? { importOrigin: pick(task.importOrigin, ['kind', 'archiveId', 'sourceTaskId', 'originalSourceNoteId', 'originUnverified']) } : {}),
    ...('sourceNoteId' in task && task.sourceNoteId ? { sourceNoteId: task.sourceNoteId, sourceRevision: task.sourceRevision!, proposalId: task.proposalId! } : {}) } as LocalTask;
}

function projectDocument(value: ContextDocument): ContextDocument { return pick(value, ['path', 'content', 'revision', 'updatedAt', 'selectionPriority']) as ContextDocument; }
function projectActivity(value: ActivityItem): ActivityItem { return pick(value, ['id', 'type', 'message', 'createdAt', 'noteId', 'proposalId']) as ActivityItem; }
function projectMailbox(value: MailboxSnapshotMessage): MailboxSnapshotMessage {
  return { ...pick(value, ['id', 'accountId', 'providerMessageId', 'identityKey', 'verifiedIdentityKey', 'connectionGeneration', 'idFormat', 'threadId', 'subject', 'from', 'senderEmail', 'receivedAt', 'snippet', 'isRead', 'replyMetadataComplete', 'internetMessageId', 'providerVersion', 'sizeEstimate', 'sizeCheckedAt', 'references', 'inReplyTo', 'observedAt', 'providerDeletedAt']),
    ...(value.replyTo ? { replyTo: [...value.replyTo] } : {}), ...(value.to ? { to: [...value.to] } : {}), ...(value.cc ? { cc: [...value.cc] } : {}),
    ...(value.headers ? { headers: value.headers.map((item) => pick(item, ['name', 'value'])) } : {}) } as MailboxSnapshotMessage;
}
function projectCalendar(value: Calendar): Calendar { return pick(value, ['id', 'accountId', 'name', 'writable', 'connected', 'providerId']) as Calendar; }
function projectCalendarEvent(value: CalendarEventSnapshot): CalendarEventSnapshot { return pick(value, ['id', 'accountId', 'calendarId', 'providerEventId', 'subject', 'start', 'end', 'timeZone', 'startUtcCertified', 'endUtcCertified', 'observedAt', 'verifiedIdentityKey', 'connectionGeneration', 'providerDeletedAt']) as CalendarEventSnapshot; }
function projectSelectedMailText(value: AppState['selectedMailTexts'][number]): AppState['selectedMailTexts'][number] {
  return { ...pick(value, ['version', 'messageId', 'accountId', 'identityKey', 'connectionGeneration', 'providerMessageId', 'idFormat', 'sourceDigest', 'providerVersion', 'checkedAt', 'text', 'textDigest', 'bytes', 'extractionVersion', 'representation', 'completeness']),
    identity: projectIdentity(value.identity), omissionReasons: [...value.omissionReasons] } as AppState['selectedMailTexts'][number];
}

function projectSyncLane(value: AccountSyncState['mailHead'] | AccountSyncState['mailBackfill']): AccountSyncState['mailHead'] | AccountSyncState['mailBackfill'] {
  return {
    status: value.status, ...(value.lastAttemptAt ? { lastAttemptAt: value.lastAttemptAt } : {}),
    ...(value.lastPageCheckedAt ? { lastPageCheckedAt: value.lastPageCheckedAt } : {}), ...(value.lastPageSucceededAt ? { lastPageSucceededAt: value.lastPageSucceededAt } : {}),
    ...('lastCompletedAt' in value && value.lastCompletedAt ? { lastCompletedAt: value.lastCompletedAt } : {}),
    ...('window' in value && value.window ? { window: pick(value.window, ['from', 'through', 'pageSize', 'queryFingerprint']) } : {}),
    ...('activeWindow' in value && value.activeWindow ? { activeWindow: pick(value.activeWindow, ['from', 'through', 'pageSize', 'queryFingerprint']) } : {}),
    ...('completeWindow' in value && value.completeWindow ? { completeWindow: pick(value.completeWindow, ['from', 'through']) } : {}),
    ...('coverage' in value && value.coverage ? { coverage: pick(value.coverage, ['from', 'through']) } : {}),
    ...('coverageNeededThrough' in value && value.coverageNeededThrough ? { coverageNeededThrough: value.coverageNeededThrough } : {}),
    ...('olderHistoryNotCheckedBefore' in value && value.olderHistoryNotCheckedBefore ? { olderHistoryNotCheckedBefore: value.olderHistoryNotCheckedBefore } : {}),
    ...(value.unavailableCount !== undefined ? { unavailableCount: value.unavailableCount } : {}), ...(value.lastError ? { lastError: value.lastError } : {}),
  } as AccountSyncState['mailHead'] | AccountSyncState['mailBackfill'];
}
export interface WorkspaceSyncStateDTO {
  readonly accountId: string; readonly status: AccountSyncState['status']; readonly mailHead: AccountSyncState['mailHead'];
  readonly mailBackfill: AccountSyncState['mailBackfill']; readonly messagesPartial: boolean; readonly calendarsPartial: boolean;
  readonly lastStartedAt?: string; readonly lastSuccessAt?: string; readonly lastError?: string;
}
function projectSyncState(value: AccountSyncState): WorkspaceSyncStateDTO {
  return { accountId: value.accountId, status: value.status, mailHead: projectSyncLane(value.mailHead) as AccountSyncState['mailHead'],
    mailBackfill: projectSyncLane(value.mailBackfill) as AccountSyncState['mailBackfill'], messagesPartial: value.messagesPartial,
    calendarsPartial: value.calendarsPartial, ...(value.lastStartedAt ? { lastStartedAt: value.lastStartedAt } : {}),
    ...(value.lastSuccessAt ? { lastSuccessAt: value.lastSuccessAt } : {}), ...(value.lastError ? { lastError: value.lastError } : {}) };
}

function projectTranscriptionAttempt(value: TranscriptionAttempt): WorkspaceTranscriptionAttemptDTO {
  const source = value.source;
  return {
    id: value.id, noteId: value.noteId, sourceRevision: value.sourceRevision,
    source: { durationSeconds: source.durationSeconds, capturedAt: source.capturedAt, captureTimeZone: source.captureTimeZone,
      speechEnabled: source.speechEnabled, maxAudioSeconds: source.maxAudioSeconds, ...(source.provider ? { provider: source.provider } : {}),
      ...(source.audioAttachment ? { audioAttachment: pick(source.audioAttachment, ['fileName', 'format', 'mimeType', 'byteLength', 'sha256', 'durationStatus', 'durationSeconds']) } : {}) },
    ...(value.provider ? { provider: value.provider } : {}), ...('profileVersion' in value ? { profileVersion: value.profileVersion, model: value.model } : {}),
    locale: value.locale, createdAt: value.createdAt, dispatchStarted: value.dispatchStarted, outcome: value.outcome,
    costStatus: 'actualUsage' in value && value.actualUsage?.costUsd !== undefined ? 'reported' : 'unknown',
    ...(value.terminalAt ? { terminalAt: value.terminalAt } : {}), ...(value.code ? { code: value.code } : {}),
    ...('durationMilliseconds' in value && value.durationMilliseconds !== undefined ? { durationMilliseconds: value.durationMilliseconds } : {}),
    ...(value.transcriptSha256 ? { transcriptSha256: value.transcriptSha256 } : {}),
    ...('actualUsage' in value && value.actualUsage ? { actualUsage: pick(value.actualUsage, ['seconds', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd']) } : {}),
    ...('unknownCharge' in value && value.unknownCharge !== undefined ? { unknownCharge: value.unknownCharge } : {}),
    ...(value.lateObservations ? { lateObservations: value.lateObservations.map((item) => pick(item, ['at', 'kind', 'durationMilliseconds'])) } : {}),
  };
}
function projectTranscription(value: TranscriptionState, inFlightCleanupAttemptIds: readonly string[] = []): WorkspaceTranscriptionDTO {
  const pending = value.cleanupLeases.filter((lease) => lease.outcome === 'pending_cleanup' || lease.outcome === 'owned');
  return { schemaVersion: value.schemaVersion, attempts: value.attempts.map(projectTranscriptionAttempt),
    cleanup: { count: value.cleanupLeases.length + inFlightCleanupAttemptIds.length,
      pendingCount: new Set([...pending.map((lease) => lease.attemptId), ...inFlightCleanupAttemptIds]).size,
      pendingAttemptIds: [...new Set([...pending.map((lease) => lease.attemptId), ...inFlightCleanupAttemptIds])] } };
}

function projectDispatchRecord(value: DispatchRecord): WorkspaceDispatchRecordDTO {
  const account = value.account;
  const safeAccount = { provider: account.provider, identity: projectIdentity(account.identity), displayName: account.displayName, email: account.email };
  return {
    version: value.version, id: value.id, proposalId: value.proposalId, approvedRevision: value.approvedRevision,
    ...(value.sourceRevision !== undefined ? { sourceRevision: value.sourceRevision } : {}), payloadDigest: value.payloadDigest,
    sourceProvenance: projectProvenance(value.sourceProvenance)!, operation: value.operation, accountId: value.accountId,
    account: safeAccount, ...(value.calendar ? { calendar: pick(value.calendar, ['localId', 'providerId', 'name']) } : {}),
    title: value.title, body: value.body, payload: value.payload.kind === 'email'
      ? { kind: 'email', email: projectEmail(value.payload.email as NonNullable<Proposal['email']>) }
      : { kind: 'event', event: projectEvent(value.payload.event as NonNullable<Proposal['event']>) },
    dispatchStartedAt: value.dispatchStartedAt, outcome: value.outcome, ...(value.outcomeAt ? { outcomeAt: value.outcomeAt } : {}),
    ...(value.rejectionCode ? { rejectionCode: value.rejectionCode } : {}), ...(value.replyDraftCheck ? { replyDraftCheck: value.replyDraftCheck } : {}),
    ...(value.remoteId ? { remoteId: value.remoteId } : {}), reconciliations: value.reconciliations.map((entry) => pick(entry, ['id', 'disposition', 'at', 'note', 'remoteId'])),
  } as WorkspaceDispatchRecordDTO;
}

function projectProactiveRule(value: SavedProactiveRule): SavedProactiveRule {
  const trigger = value.trigger.type === 'unread_from' ? { type: value.trigger.type, addresses: [...value.trigger.addresses] }
    : value.trigger.type === 'keyword' ? { type: value.trigger.type, keywords: [...value.trigger.keywords], ...(value.trigger.unreadOnly !== undefined ? { unreadOnly: value.trigger.unreadOnly } : {}) }
      : { type: value.trigger.type, minutes: value.trigger.minutes };
  return { id: value.id, revision: value.revision, enabled: value.enabled, accountIds: [...value.accountIds], trigger,
    ...(value.quietHours ? { quietHours: pick(value.quietHours, ['start', 'end']) } : {}), version: value.version, name: value.name, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function projectCandidateEntry(value: ProactiveCandidateEntry): ProactiveCandidateEntry {
  return { presentation: value.presentation, candidate: pick(value.candidate, ['id', 'suppressionKey', 'ruleId', 'ruleRevision', 'sourceId', 'sourceVersion', 'sourceKind', 'namespace', 'accountId', 'providerId', 'eligibleAt', 'reasonCode', 'quote', 'quoteField']) as ProactiveCandidateEntry['candidate'] };
}
function projectProactiveSource(value: import('../proactive').ProactiveSource): import('../proactive').ProactiveSource {
  const base = pick(value, ['sourceId', 'namespace', 'accountId', 'providerId', 'sourceVersion', 'availability', 'freshness']);
  if (value.kind === 'mail') return { ...base, kind: 'mail', ...(value.senderEmail ? { senderEmail: value.senderEmail } : {}), ...(value.isRead !== undefined ? { isRead: value.isRead } : {}), ...(value.subject ? { subject: value.subject } : {}), ...(value.snippet ? { snippet: value.snippet } : {}), ...(value.receivedAt ? { receivedAt: value.receivedAt } : {}), ...(value.receivedAtUtcCertified !== undefined ? { receivedAtUtcCertified: value.receivedAtUtcCertified } : {}) };
  if (value.kind === 'task') return { ...base, kind: 'task', ...(value.title ? { title: value.title } : {}), ...(value.status ? { status: value.status } : {}), ...(value.dueAt ? { dueAt: value.dueAt } : {}), ...(value.dueAtUtcCertified !== undefined ? { dueAtUtcCertified: value.dueAtUtcCertified } : {}) };
  // Device-bound identifiers are historical display data, not install or permission authority.
  return { ...base, kind: 'meeting', ...(value.subject ? { subject: value.subject } : {}), ...(value.startAt ? { startAt: value.startAt } : {}), ...(value.startAtUtcCertified !== undefined ? { startAtUtcCertified: value.startAtUtcCertified } : {}) };
}
function projectProactive(value: ProactiveState): ProactiveState {
  return { schemaVersion: 1, rules: value.rules.map(projectProactiveRule),
    candidates: value.candidates.map(projectCandidateEntry), dismissals: value.dismissals.map((item: ProactiveDismissal) => pick(item, ['candidateId', 'ruleId', 'ruleRevision', 'sourceId', 'sourceVersion', 'dismissedAt']) as ProactiveDismissal),
    snoozes: value.snoozes.map((item: ProactiveSnoozeEntry) => pick(item, ['suppressionKey', 'until', 'snoozedAt', 'ruleId', 'sourceId']) as ProactiveSnoozeEntry),
    ...(value.lastEvaluation ? { lastEvaluation: { inputFingerprint: value.lastEvaluation.inputFingerprint, truncation: pick(value.lastEvaluation.truncation, ['rules', 'sources', 'candidates']), ...(value.lastEvaluation.nextCheckAt ? { nextCheckAt: value.lastEvaluation.nextCheckAt } : {}), asOf: value.lastEvaluation.asOf } } : {}),
    ...(value.integrityError ? { integrityError: value.integrityError } : {}) };
}

function projectMailAlertConsent(value: ProactiveMailAlertConsent): WorkspaceMailAlertConsentDTO {
  return { id: value.id, ruleId: value.ruleId, ruleVersion: value.ruleVersion, ruleRevision: value.ruleRevision, timeZone: value.timeZone,
    activatedAt: value.activatedAt, status: value.status, ...(value.revokedAt ? { revokedAt: value.revokedAt } : {}),
    ...(value.revocationReason ? { revocationReason: value.revocationReason } : {}), accountIds: value.accounts.map((item) => item.accountId) };
}
function projectMailAlertReceipt(value: ProactiveMailAlertReceipt): WorkspaceMailAlertReceiptDTO {
  return { id: value.id, ruleId: value.ruleId, ruleVersion: value.ruleVersion, ruleRevision: value.ruleRevision, timeZone: value.timeZone,
    accountId: value.accountId, receivedAt: value.receivedAt, desired: value.desired, observed: value.observed, createdAt: value.createdAt,
    updatedAt: value.updatedAt, ...(value.attemptedAt ? { attemptedAt: value.attemptedAt } : {}),
    ...(value.cancellation ? { cancellation: pick(value.cancellation, ['requestedAt', 'attemptedAt', 'observedAt', 'result']) } : {}) };
}
function projectMailAlerts(value: ProactiveMailAlertState): WorkspaceProactiveMailAlertDTO {
  return { schemaVersion: value.schemaVersion, revision: value.revision, consents: value.consents.map(projectMailAlertConsent), receipts: value.receipts.map(projectMailAlertReceipt) };
}

function projectDeviceEvent(value: DeviceEventSnapshot): WorkspaceDeviceCalendarDTO['events'][number] {
  return pick(value, ['id', 'calendarId', 'nativeEventId', 'occurrenceStart', 'title', 'notes', 'notesTruncated', 'start', 'end', 'timeZone', 'allDay', 'cancelled', 'observedAt']) as WorkspaceDeviceCalendarDTO['events'][number];
}
function projectDeviceRecord(value: DeviceEventDispatchRecord): WorkspaceDeviceDispatchSummary {
  return { id: value.id, proposalId: value.proposalId, revision: value.revision, ...(value.sourceRevision !== undefined ? { sourceRevision: value.sourceRevision } : {}),
    title: value.payload.title, body: value.payload.notes, payload: pick(value.payload, ['title', 'notes', 'start', 'end', 'timeZone', 'allDay', 'attendees', 'invitePolicy', 'alarms']),
    claimAt: value.claimAt, outcome: value.outcome, ...(value.outcomeAt ? { outcomeAt: value.outcomeAt } : {}), ...(value.errorCode ? { errorCode: value.errorCode } : {}),
    reconciliations: value.reconciliations.map((item) => pick(item, ['disposition', 'at', 'note'])) };
}
function projectDeviceCalendars(value: DeviceCalendarState): WorkspaceDeviceCalendarDTO {
  return { enabled: value.enabled, selectedCalendarIds: [...value.selectedCalendarIds],
    calendars: value.calendars.map((item) => ({ localId: item.localId, title: item.title, ...(item.sourceName ? { sourceName: item.sourceName } : {}), ...(item.sourceType ? { sourceType: item.sourceType } : {}), ...(item.timeZone ? { timeZone: item.timeZone } : {}), allowsModifications: item.allowsModifications, observedAt: item.observedAt })),
    events: value.events.map(projectDeviceEvent), dispatchHistory: value.dispatchRecords.map(projectDeviceRecord),
    ...(value.readRun ? { readStatus: { partial: value.readRun.partial, truncatedCalendars: value.readRun.truncatedCalendars, truncatedEvents: value.readRun.truncatedEvents, startedAt: value.readRun.startedAt } } : {}) };
}

function projectKnowledgeEvidence(value: KnowledgeEvidence): KnowledgeEvidence { return pick(value, ['sourceId', 'sourceVersion', 'revision', 'quote']) as KnowledgeEvidence; }
function projectReference(value: KnowledgeReference): KnowledgeReference {
  switch (value.kind) {
    case 'note': case 'task': case 'document': case 'person': case 'project': return pick(value, ['kind', 'id']) as KnowledgeReference;
    case 'mail': return pick(value, ['kind', 'id', 'identityKey', 'connectionGeneration']) as KnowledgeReference;
    case 'calendar': return pick(value, ['kind', 'id', 'calendarId', 'identityKey', 'connectionGeneration']) as KnowledgeReference;
    case 'device_calendar_event': return { kind: 'historical', label: `Device calendar event (${value.occurrenceStart})`, originalKind: 'device_calendar_event' };
    case 'historical': return pick(value, ['kind', 'label', 'originalKind']) as KnowledgeReference;
  }
}
function projectFact(value: KnowledgeFact): KnowledgeFact { return { id: value.id, provenance: value.provenance, createdAt: value.createdAt, ...(value.evidence ? { evidence: value.evidence.map(projectKnowledgeEvidence) } : {}), ...(value.suggestionId ? { suggestionId: value.suggestionId } : {}), statement: value.statement }; }
function projectContact(value: ContactClaim): ContactClaim { return { id: value.id, provenance: value.provenance, createdAt: value.createdAt, ...(value.evidence ? { evidence: value.evidence.map(projectKnowledgeEvidence) } : {}), ...(value.suggestionId ? { suggestionId: value.suggestionId } : {}), address: value.address, label: value.label }; }
function projectSourceLink(value: KnowledgeSourceLink): KnowledgeSourceLink { return { id: value.id, provenance: value.provenance, createdAt: value.createdAt, ...(value.evidence ? { evidence: value.evidence.map(projectKnowledgeEvidence) } : {}), ...(value.suggestionId ? { suggestionId: value.suggestionId } : {}), reference: projectReference(value.reference), label: value.label }; }
function projectProjectMember(value: ProjectMember): ProjectMember { return { id: value.id, provenance: value.provenance, createdAt: value.createdAt, ...(value.evidence ? { evidence: value.evidence.map(projectKnowledgeEvidence) } : {}), ...(value.suggestionId ? { suggestionId: value.suggestionId } : {}), role: value.role, ...('personId' in value ? { personId: value.personId } : { sourcePersonId: value.sourcePersonId, label: value.label }) } as ProjectMember; }
function projectKnowledgeOrigin(value: NonNullable<Person['importOrigin']>): NonNullable<Person['importOrigin']> { return pick(value, ['kind', 'archiveId', 'cohortId', 'sourceEntityId', 'sourceDigest']) as NonNullable<Person['importOrigin']>; }
function projectPerson(value: Person): Person { return { id: value.id, revision: value.revision, name: value.name, aliases: [...value.aliases], narrativePath: value.narrativePath, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.archivedAt ? { archivedAt: value.archivedAt } : {}), ...(value.importOrigin ? { importOrigin: projectKnowledgeOrigin(value.importOrigin) } : {}), facts: value.facts.map(projectFact), sourceLinks: value.sourceLinks.map(projectSourceLink), contacts: value.contacts.map(projectContact) }; }
function projectProject(value: Project): Project { return { id: value.id, revision: value.revision, name: value.name, aliases: [...value.aliases], narrativePath: value.narrativePath, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.archivedAt ? { archivedAt: value.archivedAt } : {}), ...(value.importOrigin ? { importOrigin: projectKnowledgeOrigin(value.importOrigin) } : {}), facts: value.facts.map(projectFact), sourceLinks: value.sourceLinks.map(projectSourceLink), status: value.status, goal: value.goal, ...(value.startsOn ? { startsOn: value.startsOn } : {}), ...(value.targetOn ? { targetOn: value.targetOn } : {}), ...(value.dateTimeZone ? { dateTimeZone: value.dateTimeZone } : {}), members: value.members.map(projectProjectMember) }; }
function projectKnowledgeChange(value: KnowledgeChange): KnowledgeChange {
  switch (value.type) {
    case 'add_fact': return pick(value, ['type', 'entityKind', 'entityId', 'statement']) as KnowledgeChange;
    case 'add_contact': return pick(value, ['type', 'entityKind', 'entityId', 'address', 'label']) as KnowledgeChange;
    case 'add_source_link': return { ...pick(value, ['type', 'entityKind', 'entityId', 'referenceRevision', 'label']), reference: projectReference(value.reference) } as KnowledgeChange;
    case 'add_member': return pick(value, ['type', 'entityKind', 'entityId', 'personId', 'personRevision', 'role']) as KnowledgeChange;
  }
}
function projectSuggestion(value: KnowledgeSuggestion): KnowledgeSuggestion { return { id: value.id, revision: value.revision, change: projectKnowledgeChange(value.change), targetRevision: value.targetRevision, evidence: value.evidence.map(projectKnowledgeEvidence), status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.reviewedAt ? { reviewedAt: value.reviewedAt } : {}), ...(value.originalChange ? { originalChange: projectKnowledgeChange(value.originalChange) } : {}), ...(value.originalEvidence ? { originalEvidence: value.originalEvidence.map(projectKnowledgeEvidence) } : {}), ...(value.sourceNoteId ? { sourceNoteId: value.sourceNoteId } : {}), ...(value.sourceAnalysisFingerprint ? { sourceAnalysisFingerprint: value.sourceAnalysisFingerprint } : {}), ...(value.staleReason ? { staleReason: value.staleReason } : {}) }; }
function projectKnowledge(value: KnowledgeState): KnowledgeState { return { schemaVersion: 1, people: value.people.map(projectPerson), projects: value.projects.map(projectProject), suggestions: value.suggestions.map(projectSuggestion) }; }

function projectProactiveCandidate(value: import('../proactive').ProactiveCandidate): import('../proactive').ProactiveCandidate {
  return pick(value, ['id', 'suppressionKey', 'ruleId', 'ruleRevision', 'sourceId', 'sourceVersion', 'sourceKind', 'namespace', 'accountId', 'providerId', 'eligibleAt', 'reasonCode', 'quote', 'quoteField']) as import('../proactive').ProactiveCandidate;
}

function projectReminderRecord(value: ReminderRecord): WorkspaceReminderStateDTO['records'][number] {
  const origin = value.origin.kind === 'manual' ? { kind: 'manual' as const }
    : value.origin.kind === 'note' ? { kind: 'note' as const, noteId: value.origin.noteId, proposalId: value.origin.proposalId, proposalRevision: value.origin.proposalRevision, sourceRevision: value.origin.sourceRevision, sourceVersion: value.origin.sourceVersion, quote: value.origin.quote }
      : { kind: 'proactive' as const, candidate: projectProactiveCandidate(value.origin.candidate), rule: pick(value.origin.rule, ['id', 'revision', 'version', 'name']), source: projectProactiveSource(value.origin.source), capturedAt: value.origin.capturedAt, expiresAt: value.origin.expiresAt };
  return { title: value.title, body: value.body, dueAt: value.dueAt, displayTimeZone: value.displayTimeZone, privacyMode: value.privacyMode,
    id: value.id, revision: value.revision, origin, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(value.firstSavedAt ? { firstSavedAt: value.firstSavedAt } : {}), ...(value.approvedRevision !== undefined ? { approvedRevision: value.approvedRevision } : {}) } as WorkspaceReminderStateDTO['records'][number];
}
function projectReminderState(value: ReminderState): WorkspaceReminderStateDTO {
  return { schemaVersion: value.schemaVersion, records: value.records.map(projectReminderRecord),
    intents: value.intents.map((item) => ({ id: item.id, reminderId: item.reminderId, reminderRevision: item.reminderRevision, epoch: item.epoch, payloadDigest: item.payloadDigest, ...(item.payload ? { payload: pick(item.payload, ['title', 'body', 'dueAt', 'displayTimeZone', 'privacyMode']) } : {}), desired: item.desired, observed: item.observed, createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.attemptedAt ? { attemptedAt: item.attemptedAt } : {}), ...(item.observedAt ? { observedAt: item.observedAt } : {}), ...(item.errorCode ? { errorCode: item.errorCode } : {}) })),
    ...(value.legacyCancellations ? { legacyCancellations: value.legacyCancellations.map((item) => ({ id: item.id, proposalId: item.proposalId, proposalRevision: item.proposalRevision, requestedAt: item.requestedAt, observed: item.observed, ...(item.attemptedAt ? { attemptedAt: item.attemptedAt } : {}), ...(item.observedAt ? { observedAt: item.observedAt } : {}), ...(item.errorCode ? { errorCode: item.errorCode } : {}) })) } : {}) };
}

function projectBatchJob(value: AssistantBatchJobDTO): AssistantBatchJobDTO {
  return pick(value, ['id', 'kind', 'status', 'sourceRemoved', 'canCheck', 'createdAt', 'updatedAt', 'noteId', 'noteRevision', 'model', 'effort', 'operation', 'reasoningEffort', 'parentTurnId', 'recoveryParentTurnId', 'requestBytes', 'omittedSourceCount', 'unknownCharge', 'costStatus', 'billingScope', 'providerReportedCostUsd', 'byok', 'promptTokens', 'completionTokens', 'totalTokens', 'failureCode', 'mailMessageId', 'hasMailReplyResult', 'canReviewMailReply', 'mailReplyContextCount', 'mailReplyActivationOperation', 'proposalId', 'canRecoverMoreCompute', 'moreComputeEfforts', 'pendingRecoveryChildId', 'recoveredConversationId', 'recoveredTurnId']) as AssistantBatchJobDTO;
}
function projectChatTurn(value: ChatTurnDTO): ChatTurnDTO {
  return { id: value.id, noteId: value.noteId, userText: value.userText, createdAt: value.createdAt,
    ...(value.messageOrigin ? { messageOrigin: value.messageOrigin } : {}), ...(value.capturedAt ? { capturedAt: value.capturedAt } : {}),
    ...(value.captureTimeZone ? { captureTimeZone: value.captureTimeZone } : {}), ...(value.operation ? { operation: value.operation } : {}),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}), ...(value.parentTurnId ? { parentTurnId: value.parentTurnId } : {}),
    ...(value.recoveryParentTurnId ? { recoveryParentTurnId: value.recoveryParentTurnId } : {}), ...(value.memorySuggestionIds ? { memorySuggestionIds: [...value.memorySuggestionIds] } : {}),
    ...(value.reply ? { reply: pick(value.reply, ['summary', 'answer', 'clarifications', 'completedAt']) } : {}), ...(value.job ? { job: projectBatchJob(value.job) } : {}) };
}
function projectChatConversation(value: ChatConversationDTO): ChatConversationDTO { return { id: value.id, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt, turns: value.turns.map(projectChatTurn) }; }

function projectArchive(value: ImportedBackupArchive): ImportedBackupArchive {
  return { id: value.id, contentHash: value.contentHash, fileHash: value.fileHash, sourceFormat: value.sourceFormat, exportedAt: value.exportedAt, importedAt: value.importedAt,
    noteLinks: value.noteLinks.map((item) => pick(item, ['sourceId', 'noteId'])), taskLinks: value.taskLinks.map((item) => pick(item, ['sourceId', 'taskId'])),
    documents: value.documents.map((item) => ({ ...pick(item, ['path', 'content', 'revision', 'updatedAt', 'id', 'activatedPath', 'activatedAt']) })),
    history: value.history.map((item) => ({ ...pick(item, ['kind', 'sourceId', 'sourceNoteId', 'title', 'content', 'status', 'occurredAt', 'provider', 'reference', 'id', 'localNoteId']) } as PortableHistoryEntry & { id: string; localNoteId?: string })),
    ...(value.archivedKnowledge ? { archivedKnowledge: value.archivedKnowledge.map((cohort) => ({ id: cohort.id, sourceId: cohort.sourceId, knowledge: projectPortableKnowledge(cohort.knowledge), ...(cohort.activationLinks ? { activationLinks: cohort.activationLinks.map((link) => pick(link, ['entityKind', 'sourceEntityId', 'entityId', 'sourceDigest', 'activatedAt'])) } : {}) })) } : {}),
    ...(value.chatHistory ? { chatHistory: value.chatHistory.map(projectInertChatConversation) } : {}) };
}
function projectPortableKnowledge(value: PortableKnowledge): PortableKnowledge { return { state: projectKnowledge(value.state), narratives: value.narratives.map((item) => pick(item, ['entityKind', 'entityId', 'content', 'revision', 'updatedAt'])) }; }
function projectInertChatConversation(value: InertImportedChatConversation): InertImportedChatConversation {
  return { id: value.id, origin: value.origin, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt,
    turns: value.turns.map((turn) => ({ id: turn.id, origin: turn.origin, userText: turn.userText, createdAt: turn.createdAt,
      capturedAt: turn.capturedAt, captureTimeZone: turn.captureTimeZone, ...(turn.messageOrigin ? { messageOrigin: turn.messageOrigin } : {}),
      ...(turn.operation ? { operation: turn.operation, reasoningEffort: turn.reasoningEffort } : {}), ...(turn.reply ? { reply: pick(turn.reply, ['summary', 'answer', 'clarifications', 'completedAt']) } : {}),
      ...(turn.accounting ? { accounting: pick(turn.accounting, ['costUsd', 'isByok', 'promptTokens', 'completionTokens', 'totalTokens']) } : {}) })) };
}

function projectSettings(value: AppSettings): WorkspaceSettingsDTO {
  return pick(value, ['mode', 'llmProvider', 'openRouterModel', 'openRouterReasoningEffort', 'llmRequestContractVersion', 'timezone', 'backgroundMailRefreshEnabled', 'backgroundRefreshGeneration', 'speechEnabled', 'speechProvider', 'speechEndpoint', 'speechRegion', 'maxAudioSeconds', 'audioRetention']) as WorkspaceSettingsDTO;
}

function projectUsage(value: AppState['usage']): WorkspaceUsageDTO {
  return pick(value, ['month', 'day', 'requests', 'attemptsToday', 'inputTokens', 'outputTokens', 'transcriptionSeconds', 'attempts', 'unknownCharges', 'lastRequestAt']) as WorkspaceUsageDTO;
}

function projectState(state: AppState, resolver?: WorkspaceMediaResolver): WorkspaceDTOState {
  assertList(state.notes, 'notes'); assertList(state.proposals, 'proposals'); assertList(state.accounts, 'accounts');
  assertList(state.tasks, 'tasks'); assertList(state.documents, 'documents'); assertList(state.activity, 'activity');
  const cleanupReasons = { replaced: 0, disconnected: 0, orphan: 0 };
  for (const item of state.pendingCredentialCleanup) cleanupReasons[item.reason] += 1;
  const transcription = projectTranscription(state.transcription, (state.transcriptionRequestCleanupPending ?? []).map((item) => item.attemptId));
  return {
    notes: state.notes.map((item) => projectNote(item, resolver)), proposals: state.proposals.map(projectProposal), tasks: state.tasks.map(projectTask),
    accounts: state.accounts.map(projectAccount), calendars: state.calendars.map(projectCalendar), documents: state.documents.map(projectDocument),
    activity: state.activity.map(projectActivity), settings: projectSettings(state.settings), usage: projectUsage(state.usage),
    transcription, ...(state.transcriptionRecoveryStatus ? { transcriptionRecoveryStatus: pick(state.transcriptionRecoveryStatus, ['quarantined', 'message']) as AppState['transcriptionRecoveryStatus'] } : {}),
    mailbox: state.mailbox.map(projectMailbox), selectedMailTexts: state.selectedMailTexts.map(projectSelectedMailText), calendarEvents: state.calendarEvents.map(projectCalendarEvent),
    deviceCalendars: projectDeviceCalendars(state.deviceCalendars), deviceCalendarAccess: pick(state.deviceCalendarAccess, ['status', 'checkedAt']) as DeviceCalendarAccessState,
    ...(state.deviceCalendarRecoveryStatus ? { deviceCalendarRecoveryStatus: pick(state.deviceCalendarRecoveryStatus, ['quarantined', 'message']) as AppState['deviceCalendarRecoveryStatus'] } : {}),
    syncStates: Object.fromEntries(Object.entries(state.syncStates).map(([key, value]) => [key, projectSyncState(value)])),
    credentialCleanup: { pendingCount: state.pendingCredentialCleanup.length, reasons: cleanupReasons },
    dispatchRecords: state.dispatchRecords.map(projectDispatchRecord), ...(state.dispatchRecoveryStatus ? { dispatchRecoveryStatus: pick(state.dispatchRecoveryStatus, ['quarantinedCount', 'message']) as AppState['dispatchRecoveryStatus'] } : {}),
    mailboxSchemaVersion: state.mailboxSchemaVersion, proactive: projectProactive(state.proactive), proactiveMailAlerts: projectMailAlerts(state.proactiveMailAlerts),
    ...(state.proactiveMailAlertRecoveryStatus ? { proactiveMailAlertRecoveryStatus: pick(state.proactiveMailAlertRecoveryStatus, ['quarantined', 'message']) as AppState['proactiveMailAlertRecoveryStatus'] } : {}),
    ...(state.mailAlertRefreshRequired ? { mailAlertRefreshRequired: pick(state.mailAlertRefreshRequired, ['required', 'message']) as AppState['mailAlertRefreshRequired'] } : {}),
    assistantBatchJobs: (state.assistantBatchJobs ?? []).map(projectBatchJob), assistantChatConversations: (state.assistantChatConversations ?? []).map(projectChatConversation),
    ...(state.assistantChatRecoveryStatus ? { assistantChatRecoveryStatus: pick(state.assistantChatRecoveryStatus, ['blocked', 'message']) as AppState['assistantChatRecoveryStatus'] } : {}),
    ...(state.assistantBatchRecoveryStatus ? { assistantBatchRecoveryStatus: pick(state.assistantBatchRecoveryStatus, ['blocked', 'message']) as AppState['assistantBatchRecoveryStatus'] } : {}),
    importedBackups: state.importedBackups.map(projectArchive), ...(state.backupRecoveryStatus ? { backupRecoveryStatus: pick(state.backupRecoveryStatus, ['quarantinedArchiveCount', 'message']) as AppState['backupRecoveryStatus'] } : {}),
    knowledge: projectKnowledge(state.knowledge), ...(state.knowledgeRecoveryStatus ? { knowledgeRecoveryStatus: pick(state.knowledgeRecoveryStatus, ['message']) as AppState['knowledgeRecoveryStatus'] } : {}),
    reminders: projectReminderState(state.reminders), ...(state.reminderRecoveryStatus ? { reminderRecoveryStatus: pick(state.reminderRecoveryStatus, ['quarantined', 'message']) as AppState['reminderRecoveryStatus'] } : {}),
  };
}

/** Projects only the controller's public, typed snapshot; raw kernel/persisted state is not accepted here. */
export function createWorkspaceSnapshotDTO(controller: Pick<AppController, 'getSnapshot'>, metadata: WorkspaceSnapshotMetadata,
  mediaResolver?: WorkspaceMediaResolver): WorkspaceSnapshotDTO {
  if (!controller || typeof controller.getSnapshot !== 'function') throw new TypeError('workspace_controller_snapshot_required');
  if (!metadata || typeof metadata !== 'object' || !UUID_V4.test(metadata.workspaceId) || !Number.isSafeInteger(metadata.privacyEpoch) || metadata.privacyEpoch < 0 ||
    !Number.isSafeInteger(metadata.revision) || metadata.revision < 0) throw new TypeError('workspace_snapshot_identity_invalid');
  const state = controller.getSnapshot();
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('workspace_snapshot_invalid');
  return cloneAndFreeze({ schemaVersion: 1 as const, workspaceId: metadata.workspaceId, privacyEpoch: metadata.privacyEpoch, revision: metadata.revision,
    state: projectState(state, mediaResolver) }) as WorkspaceSnapshotDTO;
}
