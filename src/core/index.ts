/** Stable application contracts shared by the UI, services, and storage. */
import type { AssistantCitation, AssistantDecision } from '../assistant';
import type { AudioRecoveryMetadata } from '../audio/recovery.types';
import type { KnowledgeState, KnowledgeEntityKind, KnowledgeFact, ContactClaim, KnowledgeSourceLink, ProjectMember, KnowledgeSuggestion, KnowledgeChange, KnowledgeEvidence } from '../knowledge/types';
import type { ReminderRecord, ReminderState, ReminderPayload } from '../reminders';

export type NoteStatus = 'recorded' | 'processed' | 'error';
export type ProposalKind = 'task' | 'reminder' | 'email' | 'event' | 'memory';
export type ProposalStatus = 'draft' | 'approved' | 'dispatching' | 'unknown' | 'failed' | 'accepted' | 'simulated' | 'executed' | 'dismissed';
export type AssistIntent = 'assist' | 'summarize' | 'answer' | 'extract';

export type AssistCitation = AssistantCitation;
export type AssistDecision = AssistantDecision;

export interface NoteAssistResult {
  noteId: string;
  sourceRevision: number;
  intent: AssistIntent;
  question?: string;
  fingerprint: string;
  analyzedAt: string;
  capturedAt: string;
  captureTimeZone: string;
  summary: string;
  answer: string;
  decisions: AssistDecision[];
  citations: AssistCitation[];
  clarifications: string[];
  proposalIds: string[];
  memorySuggestionIds?: string[];
  source: 'provider' | 'offline_preview';
  includedSourceIds: string[];
  includedSources: { id: string; title: string; excerpt?: string }[];
  omittedSourceIds: string[];
  omittedSourceCount: number;
  sourceVersions: Record<string, string>;
  knowledgeSelection?: { kind: KnowledgeEntityKind; id: string }[];
  answeredAsOf?: string;
  answerTimeZone?: string;
  stale?: boolean;
}

export interface ImportedTaskOrigin {
  kind: 'backup_import';
  archiveId: string;
  sourceTaskId: string;
  originalSourceNoteId?: string;
  originUnverified?: true;
}

interface LocalTaskFields {
  id: string;
  title: string;
  body: string;
  status: 'open' | 'completed';
  createdAt: string;
  completedAt?: string;
  dueAt?: string;
}

export type LocalTask = LocalTaskFields & (
  { importOrigin?: undefined; sourceNoteId: string; sourceRevision: number; proposalId: string } |
  { importOrigin: ImportedTaskOrigin; sourceNoteId?: string; sourceRevision?: never; proposalId?: never }
);

export interface Note {
  id: string;
  title: string;
  transcript: string;
  audioUri?: string;
  durationSeconds: number;
  createdAt: string;
  capturedAt?: string;
  status: NoteStatus;
  /** Increments whenever transcript or attached recording changes; approvals bind to this source revision. */
  revision: number;
  /** Persisted identity of the last analysis inputs, so retries/reloads do not repeat paid calls. */
  processingFingerprint?: string;
  captureTimeZone?: string;
  analysis?: NoteAssistResult;
  audioAttachment?: AudioRecoveryMetadata & { kind: 'user_selected_replacement'; originalMatch: 'unverified'; attachedAt: string };
  importOrigin?: { kind: 'backup_import'; archiveId: string; sourceNoteId: string; audioMissing: boolean; originalTimeZoneUnknown?: true; timeZoneConfirmedAt?: string; originUnverified?: true };
}

export interface ProposalEvidence {
  quote: string;
  start?: number;
  end?: number;
  confidence?: number;
  source?: string;
}

export interface ProposalSourceProvenance {
  sourceId: string;
  revision: number;
  sourceVersion: string;
}

/** Immutable analysis dependencies captured when this individual proposal was created. */
export interface NoteProposalProvenance {
  version: 1;
  assistContractVersion: string;
  analysisFingerprint: string;
  noteId: string;
  noteRevision: number;
  capturedAt: string;
  captureTimeZone: string;
  intent: AssistIntent;
  question?: string;
  knowledgeSelection?: { kind: KnowledgeEntityKind; id: string }[];
  sources: ProposalSourceProvenance[];
  policySources: ProposalSourceProvenance[];
  settingsFingerprint: string;
  answeredAsOf?: string;
  expiresAt?: string;
}

export interface MailReplySourceSnapshot {
  version: 1;
  accountId: string;
  accountEmail: string;
  verifiedSelfEmail?: string;
  identity: NonNullable<Account['identity']>;
  connectionGeneration: number;
  localMessageId: string;
  providerMessageId: string;
  idFormat: 'gmail' | 'graph-immutable';
  providerVersion?: string;
  threadId?: string;
  internetMessageId: string;
  references?: string;
  inReplyTo?: string;
  subject: string;
  from?: string;
  senderEmail?: string;
  replyTo?: string[];
  to?: string[];
  cc?: string[];
  snippet?: string;
  replyMetadataComplete: true;
  observedAt: string;
  sourceDigest: string;
}

export interface MailReplyProvenance {
  version: 2;
  kind: 'mail_reply';
  sourceDigest: string;
  source: MailReplySourceSnapshot;
  expiresAt: string;
}

/** Backward-compatible name for note-derived provenance; new proposals use the explicit union. */
export type ProposalProvenance = NoteProposalProvenance;
export type AnyProposalProvenance = NoteProposalProvenance | MailReplyProvenance;

export interface Proposal {
  id: string;
  noteId?: string;
  kind: ProposalKind;
  title: string;
  body: string;
  status: ProposalStatus;
  revision: number;
  approvedRevision?: number;
  approvedPayloadDigest?: string;
  lastError?: string;
  notificationId?: string;
  notificationRevision?: number;
  /** Link to the shared local reminder ledger created when this approved proposal is executed. */
  reminderId?: string;
  /** Stable idempotency key for provider event creation, persisted before dispatch. */
  eventTransactionId?: string;
  eventDestination?: EventProposalDestination;
  deviceCalendarApproval?: DeviceCalendarEventApproval;
  deviceEventDispatchRecordId?: string;
  /** Stable same-source action identity used to prevent reprocessing from resurrecting consumed suggestions. */
  sourceActionKey?: string;
  provenance?: AnyProposalProvenance;
  requiresRebuild?: boolean;
  /** Synchronous canonical dependency snapshot rechecked after connector preparation and before fetch. */
  dispatchDependencyProjection?: string;
  dispatchRecordId?: string;
  /** Legacy terminal external action lacks an exact credential-free frozen receipt. */
  dispatchHistoryIncomplete?: boolean;
  accountId?: string;
  recipients: string[];
  calendarId?: string;
  sourceRevision?: number;
  evidence: ProposalEvidence[];
  dueAt?: string;
  email?: EmailProposalPayload;
  event?: EventProposalPayload;
  simulated?: boolean;
  remoteOperation?: 'draft' | 'send' | 'event';
  remoteId?: string;
  remoteAcceptedAt?: string;
}

export interface EmailProposalPayload {
  /** Required at approval time; omitted on legacy proposals until the user selects an action. */
  operation?: 'draft' | 'send';
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: { id: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string }[];
  /** Present only for a metadata-bound reply draft. */
  reply?: {
    mode: 'reply' | 'reply_all';
    sourceDigest: string;
    localMessageId: string;
    providerMessageId: string;
    idFormat: 'gmail' | 'graph-immutable';
    internetMessageId: string;
    sourceSubject: string;
    threadId?: string;
    references?: string;
    inReplyTo?: string;
  };
}

export interface EventProposalPayload {
  title?: string;
  description?: string;
  start: string;
  end: string;
  timeZone: string;
  attendees: string[];
  invitePolicy: 'send' | 'none';
}

export type EventProposalDestination =
  | { kind: 'remote_calendar'; accountId: string; calendarId: string }
  | { kind: 'device_calendar'; calendarId: string };

/** Controller-created local permission/source snapshot used only for native event approval. */
export interface DeviceCalendarEventApproval {
  version: 1;
  installationId: string;
  generation: number;
  selectionRevision: number;
  calendarId: string;
  nativeCalendarId: string;
  calendarFingerprint: string;
  payloadDigest: string;
  dependencyProjection: string;
  approvedAt: string;
}

export type DeviceCalendarAccessStatus = 'needs_check' | 'full_access' | 'write_only' | 'denied' | 'undetermined' | 'unavailable';
export interface DeviceCalendarAccessState { status: DeviceCalendarAccessStatus; checkedAt?: string }

export type AccountAuthStatus = 'configured' | 'connected' | 'reauth_required' | 'revoked';
export type AccountCapability = 'mail.read' | 'mail.draft' | 'mail.send' | 'calendar.read' | 'calendar.write';

export interface Account {
  id: string;
  provider: 'google' | 'microsoft' | 'local';
  displayName: string;
  email: string;
  /** Address returned by the verified provider identity flow, if available. */
  verifiedEmail?: string;
  connected: boolean;
  authStatus: AccountAuthStatus;
  identity?: {
    /** Optional only for migration; unnamespaced identities are never considered connected. */
    providerNamespace?: 'google' | 'microsoft';
    clientId?: string;
    subject: string;
    /** Persist only when supplied by a validated OIDC response; do not infer it from JWTs. */
    issuer?: string;
    tenantId?: string;
    /** Resource-backed user ID (for example Microsoft Graph /me). */
    resourceUserId?: string;
  };
  tokenRef?: string;
  grantedScopes?: string[];
  capabilities?: AccountCapability[];
  /** User-selected maximum permissions; effective capabilities are intersected with verified grants. */
  capabilityLimits?: AccountCapability[];
  lastSyncedAt?: string;
  syncStatus?: 'idle' | 'partial' | 'error';
  configuredAt?: string;
  /** Local generation fence used to reject late OAuth refresh and sync results. */
  connectionGeneration?: number;
}

/** OAuth result supplied by the trusted auth bridge after provider identity verification. */
export interface OAuthInstallResult {
  provider: Extract<Account['provider'], 'google' | 'microsoft'>;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  grantedScopes: string[];
  identity: NonNullable<Account['identity']>;
  requestedCapabilities: AccountCapability[];
  capabilities: AccountCapability[];
  displayName: string;
  email?: string;
}

export interface Calendar {
  id: string;
  accountId: string;
  name: string;
  writable: boolean;
  connected: boolean;
  /** Provider calendar ID is retained separately from this app's stable local ID. */
  providerId?: string;
}

export interface MailboxSnapshotMessage {
  id: string;
  accountId: string;
  providerMessageId: string;
  identityKey: string;
  verifiedIdentityKey?: string;
  connectionGeneration?: number;
  idFormat?: 'gmail' | 'graph-immutable';
  threadId?: string;
  subject?: string;
  from?: string;
  senderEmail?: string;
  receivedAt?: string;
  snippet?: string;
  isRead?: boolean;
  replyMetadataComplete?: boolean;
  internetMessageId?: string;
  providerVersion?: string;
  sizeEstimate?: number;
  sizeCheckedAt?: string;
  replyTo?: string[];
  to?: string[];
  cc?: string[];
  references?: string;
  inReplyTo?: string;
  headers?: { name: string; value: string }[];
  observedAt?: string;
  providerDeletedAt?: string;
}

export interface CalendarEventSnapshot {
  id: string;
  accountId: string;
  calendarId: string;
  providerEventId: string;
  subject?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  startUtcCertified?: boolean;
  endUtcCertified?: boolean;
  observedAt?: string;
  verifiedIdentityKey?: string;
  connectionGeneration?: number;
  providerDeletedAt?: string;
}

export interface MailSyncWindow {
  from: string;
  through: string;
  pageSize: number;
  queryFingerprint: string;
  cursor?: string;
}

export interface MailCoverageInterval {
  from: string;
  through: string;
}

export interface MailHeadLaneState {
  status: 'idle' | 'syncing' | 'partial' | 'error';
  lastAttemptAt?: string;
  lastPageCheckedAt?: string;
  lastPageSucceededAt?: string;
  window?: MailSyncWindow;
  completeWindow?: MailCoverageInterval;
  unavailableCount?: number;
  lastError?: string;
}

export interface MailBackfillLaneState {
  status: 'idle' | 'syncing' | 'partial' | 'error';
  activeWindow?: MailSyncWindow;
  coverage?: MailCoverageInterval;
  coverageNeededThrough?: string;
  olderHistoryNotCheckedBefore?: string;
  lastAttemptAt?: string;
  lastPageCheckedAt?: string;
  lastPageSucceededAt?: string;
  lastCompletedAt?: string;
  unavailableCount?: number;
  lastError?: string;
}

export interface MailLaneResult {
  accountId: string;
  lane: 'head' | 'backfill';
  status: 'complete' | 'partial' | 'error' | 'idle';
  state: AccountSyncState;
  message?: string;
}

export interface ForegroundMailRefreshResult {
  attempted: string[];
  skipped: { accountId: string; reason: string }[];
  results: MailLaneResult[];
}

export interface AccountSyncState {
  accountId: string;
  status: 'idle' | 'syncing' | 'partial' | 'error';
  mailHead: MailHeadLaneState;
  mailBackfill: MailBackfillLaneState;
  messagesCursor?: string;
  messagesCompletedAt?: string;
  messagesPartial: boolean;
  calendarsCursor?: string;
  calendarsCompletedAt?: string;
  calendarsPartial: boolean;
  eventCursors: Record<string, string>;
  eventsCompletedAt: Record<string, string>;
  lastStartedAt?: string;
  /** Stable query window reused when a partial run is explicitly continued. */
  messagesTimeMin?: string;
  eventsTimeMin?: string;
  eventsTimeMax?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface ContextDocument {
  path: string;
  content: string;
  revision: number;
  updatedAt: string;
  selectionPriority?: 0 | 1 | 2;
}

export interface ActivityItem {
  id: string;
  type: 'note_saved' | 'proposal_created' | 'proposal_approved' | 'local_action' | 'simulation' | 'error';
  message: string;
  createdAt: string;
  noteId?: string;
  proposalId?: string;
}

export interface AppSettings {
  mode: 'preview' | 'provider';
  timezone: string;
  /** Speech transcription is an explicit, independent provider opt-in. */
  speechEnabled?: boolean;
  speechEndpoint?: string;
  speechRegion?: string;
  openAiEndpoint?: string;
  openAiDeployment?: string;
  model?: string;
  maxContextTokens: number;
  /** Hard serialized request-body size limit in UTF-8 bytes; token counts remain estimates. */
  maxRequestBytes: number;
  maxOutputTokens: number;
  monthlyBudgetUsd: number;
  reasoningEffort: 'none' | 'low';
  maxAttempts: number;
  maxCallsPerDay: number;
  maxAudioSeconds: number;
  audioRetention: 'keep' | 'delete_after_transcription';
  /** Rates are omitted until the provider publishes a confirmed rate card. */
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  speechUsdPerMinute?: number;
}

export interface UsageLedger {
  month: string;
  day: string;
  requests: number;
  attemptsToday: number;
  inputTokens: number;
  outputTokens: number;
  transcriptionSeconds: number;
  attempts: number;
  unknownCharges: number;
  reservedUsd: number;
  priceKnown: boolean;
  estimatedCostUsd: number;
  lastRequestAt?: string;
}

export type SavedProactiveRule = import('../proactive').ProactiveRule & {
  /** Optimistic concurrency token; advances for every persisted edit. */
  version: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export interface ProactiveCandidateEntry {
  candidate: import('../proactive').ProactiveCandidate;
  presentation: 'active' | 'deferred' | 'uncertain';
}

export interface ProactiveDismissal {
  candidateId: string;
  ruleId: string;
  ruleRevision: number;
  sourceId: string;
  sourceVersion: string;
  dismissedAt: string;
}

export type ProactiveSnoozeEntry = import('../proactive').ProactiveSnooze & {
  ruleId: string;
  sourceId: string;
  snoozedAt: string;
};

export interface ProactiveState {
  schemaVersion: 1;
  rules: SavedProactiveRule[];
  candidates: ProactiveCandidateEntry[];
  dismissals: ProactiveDismissal[];
  snoozes: ProactiveSnoozeEntry[];
  lastEvaluation?: {
    inputFingerprint: string;
    truncation: import('../proactive').ProactiveEvaluation['truncation'];
    nextCheckAt?: string;
    asOf: string;
  };
  /** Fixed user-safe message; never contains persisted source or quarantine data. */
  integrityError?: string;
}

export interface ProactiveCandidateSourceResult {
  status: 'current' | 'stale' | 'unavailable' | 'missing';
  candidate?: import('../proactive').ProactiveCandidate;
  source?: import('../proactive').ProactiveSource;
}

export interface MailReplySourceResult {
  status: 'current' | 'stale' | 'unavailable' | 'missing';
  source?: MailReplySourceSnapshot;
  defaults?: { reply: { to: string[]; cc: string[] }; reply_all: { to: string[]; cc: string[] } };
}

/** Bounded, selected-message body cache; it is separate from mailbox metadata and never contains credentials. */
export interface SelectedMailTextSnapshot {
  version: 1;
  messageId: string;
  accountId: string;
  identityKey: string;
  identity: NonNullable<Account['identity']>;
  connectionGeneration: number;
  providerMessageId: string;
  idFormat: 'gmail' | 'graph-immutable';
  sourceDigest: string;
  providerVersion?: string;
  checkedAt: string;
  text?: string;
  textDigest?: string;
  bytes: number;
  extractionVersion: 'mail-text-v1' | 'mail-text-v2';
  representation: 'plain' | 'converted_html' | 'snippet' | 'none';
  completeness: 'complete_text' | 'excerpt' | 'unavailable';
  omissionReasons: string[];
}

export interface MailReplyTextLoadResult {
  status: 'current' | 'source_changed' | 'stale' | 'unavailable';
  snapshot?: SelectedMailTextSnapshot;
}

export interface MailReplyTextCacheResult {
  status: 'current' | 'stale' | 'missing' | 'unavailable';
  snapshot?: SelectedMailTextSnapshot;
}

export interface MailReplyTextGenerationInput {
  messageId: string;
  sourceDigest: string;
  textDigest: string;
  mode: 'reply' | 'reply_all';
  to: string[];
  cc: string[];
  /** Optional user-authored request, kept distinct from a selected note transcript. */
  brief: string;
  composerRevision: number;
  noteId?: string;
  noteRevision?: number;
  forceRefresh?: boolean;
}

export interface MailReplyTextGenerationResult {
  status: 'current' | 'stale' | 'source_changed' | 'unavailable';
  text?: string;
  requestFingerprint: string;
  composerRevision: number;
  generatedAt?: string;
  fromCache: boolean;
  submittedContext?: {
    bytes: number; representation: 'plain' | 'converted_html' | 'snippet' | 'none'; completeness: 'complete_text' | 'excerpt' | 'unavailable';
    omissionReasons: string[]; requestBytes: number; briefBytes: number; policyDocuments: string[];
  };
}

export interface AppState {
  notes: Note[];
  proposals: Proposal[];
  tasks: LocalTask[];
  accounts: Account[];
  calendars: Calendar[];
  documents: ContextDocument[];
  activity: ActivityItem[];
  settings: AppSettings;
  usage: UsageLedger;
  transcription: import('../transcription').TranscriptionState;
  transcriptionRecoveryStatus?: { quarantined: true; message: 'Some speech-transcription history could not be validated and is held privately. New cloud transcription is disabled until recovery.' };
  mailbox: MailboxSnapshotMessage[];
  selectedMailTexts: SelectedMailTextSnapshot[];
  calendarEvents: CalendarEventSnapshot[];
  /** Native calendars are installation-scoped; persisted permission is never trusted on load. */
  deviceCalendars: import('../deviceCalendars/types').DeviceCalendarState;
  deviceCalendarAccess: DeviceCalendarAccessState;
  deviceCalendarRecoveryStatus?: { quarantined: true; message: 'Some device calendar history could not be validated and is held privately. New device calendar writes are disabled until recovery.' };
  syncStates: Record<string, AccountSyncState>;
  /** Opaque refs only; internal cleanup bookkeeping excluded from user export. */
  pendingCredentialCleanup: { tokenRef: string; reason: 'replaced' | 'disconnected' | 'orphan'; createdAt: string; lastError?: string }[];
  /** Immutable credential-free audit records for external writes. */
  dispatchRecords: import('../dispatch').DispatchRecord[];
  /**
   * Private recovery data. Never display `raw` or include it in portable export/model context.
   * Any entry blocks new external writes until receipt history is repaired.
   */
  dispatchRecordQuarantine: { reason: 'invalid_persisted_receipt'; quarantinedAt: string; raw: unknown }[];
  /** Versioned current mailbox metadata cache; this is independent of immutable dispatch history. */
  mailboxSchemaVersion: 2;
  proactive: ProactiveState;
  /** Imported material is inert archive data; it is never assistant context or live authority. */
  importedBackups: import('../backup').ImportedBackupArchive[];
  backupRecoveryStatus?: { quarantinedArchiveCount: number; message: 'Some imported backup archive data could not be validated and is held privately.' };
  /** Current, explicitly reviewed structured knowledge; imported archives remain inert. */
  knowledge: KnowledgeState;
  knowledgeRecoveryStatus?: { message: 'Some saved knowledge could not be validated and is held privately.' };
  /** User-owned local reminders and notification reconciliation intents. */
  reminders: ReminderState;
  /** Fixed, non-sensitive notice; malformed reminder rows are retained privately. */
  reminderRecoveryStatus?: { quarantined: true; message: 'Some reminder data could not be validated and is held privately. New reminders are disabled until recovery.' };
}

export type ReminderDraftInput = Partial<ReminderPayload> & { candidateId?: string };
export type ReminderDraftPatch = Partial<ReminderPayload> & { expectedRevision: number };

export interface BackupImportPreview {
  sessionId: string;
  fileHash: string;
  contentHash: string;
  planHash: string;
  sourceFormat: import('../backup').ImportedBackupArchive['sourceFormat'];
  exportedAt: string;
  noteCount: number;
  taskCount: number;
  documentCount: number;
  historyCount: number;
  personCount: number;
  projectCount: number;
  knowledgeCohortCount: number;
  missingAudioCount: number;
  /** Items absent from their verified local links and eligible for restoration from this archive. */
  missingNoteCount: number;
  missingTaskCount: number;
  missingNoteLabels: string[];
  missingTaskLabels: string[];
  /** Existing imported tasks whose source link can be safely repaired to a note restored by this plan. */
  taskLinkRepairCount: number;
  taskLinkRepairLabels: string[];
  documentConflicts: import('../backup').PortableBackupPreview['documentConflicts'];
  warnings: string[];
  ignoredFieldCount: number;
  alreadyImported: boolean;
}

export interface ImportedKnowledgeActivationPreview {
  sessionId: string;
  planHash: string;
  expiresAt: string;
  archiveId: string;
  cohortId: string;
  kind: KnowledgeEntityKind;
  sourceEntityId: string;
  sourceName: string;
  sourceEntity: import('../knowledge/types').Person | import('../knowledge/types').Project;
  alreadyActivated: boolean;
  targetId: string;
  narrativePath: string;
  narrativeContent: string;
  factCount: number;
  contactCount: number;
  sourceLinkCount: number;
  memberCount: number;
  unavailableProviderReferenceCount: number;
  unresolvedMemberCount: number;
}

export type KnowledgeSelection = { kind: KnowledgeEntityKind; id: string }[];

/** Safe UI disclosure for a staged file; deliberately excludes the private staged URI. */
export type RecordingAttachmentPreview = AudioRecoveryMetadata & {
  sessionId: string;
  planHash: string;
  noteId: string;
  expectedRevision: number;
};

export interface SaveNoteInput {
  transcript: string;
  audioUri?: string;
  durationSeconds?: number;
  /** Recording start timestamp when available; otherwise the note save time is used. */
  capturedAt?: string;
  captureTimeZone?: string;
}

export type ProposalPatch = Partial<Pick<Proposal,
  'title' | 'body' | 'accountId' | 'recipients' | 'calendarId' | 'eventDestination' | 'dueAt' | 'email' | 'event'
>>;

export interface AccountConfig {
  id?: string;
  provider: Account['provider'];
  displayName: string;
  email: string;
  connected?: boolean;
}

export interface CalendarConfig {
  id?: string;
  accountId: string;
  name: string;
  writable?: boolean;
  connected?: boolean;
}

export type SettingsPatch = Partial<AppSettings>;

export interface SavePersonInput {
  id?: string;
  expectedRevision?: number;
  expectedDocumentRevision?: number;
  name: string;
  aliases: string[];
  narrative: string;
}

export interface SaveProjectInput extends SavePersonInput {
  status: import('../knowledge/types').Project['status'];
  goal: string;
  startsOn?: string;
  targetOn?: string;
  dateTimeZone?: string;
}

export interface KnowledgeItemCommand {
  entityKind: KnowledgeEntityKind;
  entityId: string;
  expectedEntityRevision: number;
  itemId?: string;
}

export interface KnowledgeSuggestionInput { targetKind: KnowledgeEntityKind; targetId: string; change: KnowledgeChange; evidence: KnowledgeEvidence[] }

export interface SaveKnowledgeFactInput extends KnowledgeItemCommand { statement: string }
export interface SaveKnowledgeContactInput extends Omit<KnowledgeItemCommand, 'entityKind'> { entityKind: 'person'; address: string; label: string }
export interface SaveKnowledgeSourceLinkInput extends KnowledgeItemCommand { reference: import('../knowledge/types').KnowledgeReference; label: string }
export interface SaveKnowledgeMemberInput extends Omit<KnowledgeItemCommand, 'entityKind'> { entityKind: 'project'; personId: string; personRevision: number; role: string }

export interface ReviewKnowledgeSuggestionInput {
  expectedRevision: number;
  decision: 'accept' | 'dismiss';
  targetRevision?: number;
  memberPersonRevision?: number;
}

export interface EditKnowledgeSuggestionInput {
  expectedRevision: number;
  change: KnowledgeChange;
  evidence: KnowledgeEvidence[];
}

export interface AppController {
  getSnapshot(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  load(): Promise<void>;
  saveNote(input: SaveNoteInput): Promise<Note>;
  confirmImportedNoteTimeZone(noteId: string, input: { timeZone: string; expectedRevision: number }): Promise<Note>;
  prepareRecordingAttachment(noteId: string, input: { expectedRevision: number }): Promise<RecordingAttachmentPreview | null>;
  attachRecording(input: { sessionId: string; planHash: string }): Promise<Note>;
  cancelRecordingAttachment(sessionId: string): Promise<void>;
  updateTranscript(id: string, text: string): Promise<Note>;
  processNote(id: string): Promise<Proposal[]>;
  assistNote(id: string, options?: { intent?: AssistIntent; question?: string; forceRefresh?: boolean; knowledgeSelection?: KnowledgeSelection }): Promise<NoteAssistResult>;
  refreshAnalysisStatus(noteId: string): Promise<NoteAssistResult | undefined>;
  checkProposalFreshness(id: string): Promise<{ current: boolean; reason?: string }>;
  reconcileDispatch(recordId: string, input: { disposition: import('../dispatch').DispatchReconciliation; note: string; remoteId?: string }): Promise<import('../dispatch').DispatchRecord>;
  transcribeNote(id: string, options?: { expectedRevision: number }): Promise<Note>;
  cancelTranscription(noteId: string, input?: { attemptId?: string }): Promise<{ status: 'cancelled' | 'already_terminal' | 'not_running' }>;
  editProposal(id: string, patch: ProposalPatch, options?: { expectedRevision: number }): Promise<Proposal>;
  approveProposal(id: string, options?: { expectedRevision: number }): Promise<Proposal>;
  executeProposal(id: string, options?: { expectedRevision: number }): Promise<Proposal>;
  connectDeviceCalendars(input: { expectedGeneration: number }): Promise<DeviceCalendarAccessState>;
  disconnectDeviceCalendars(input: { expectedGeneration: number }): Promise<import('../deviceCalendars/types').DeviceCalendarState>;
  checkDeviceCalendarAccess(): Promise<DeviceCalendarAccessState>;
  setDeviceCalendarSelection(input: { expectedGeneration: number; expectedSelectionRevision: number; calendarIds: string[] }): Promise<import('../deviceCalendars/types').DeviceCalendarState>;
  refreshDeviceCalendars(input: { expectedGeneration: number; expectedSelectionRevision: number; continueRunId?: string }): Promise<import('../deviceCalendars/types').DeviceCalendarState>;
  inspectDeviceEventDispatch(recordId: string): Promise<{ record: import('../deviceCalendars/types').DeviceEventDispatchRecord; lookup: import('../deviceCalendars/types').DeviceEventLookupResult }>;
  reconcileDeviceEventDispatch(recordId: string, input: { disposition: import('../deviceCalendars/types').DeviceEventReconciliation; note: string; nativeEventId?: string }): Promise<import('../deviceCalendars/types').DeviceEventDispatchRecord>;
  dismissProposal(id: string): Promise<Proposal>;
  completeTask(id: string): Promise<LocalTask>;
  reopenTask(id: string): Promise<LocalTask>;
  savePerson(input: SavePersonInput): Promise<import('../knowledge/types').Person>;
  saveProject(input: SaveProjectInput): Promise<import('../knowledge/types').Project>;
  setKnowledgeEntityArchived(input: { kind: KnowledgeEntityKind; id: string; expectedRevision: number; archived: boolean }): Promise<import('../knowledge/types').Person | import('../knowledge/types').Project>;
  saveKnowledgeFact(input: SaveKnowledgeFactInput): Promise<KnowledgeFact>;
  removeKnowledgeFact(input: KnowledgeItemCommand): Promise<void>;
  saveKnowledgeContact(input: SaveKnowledgeContactInput): Promise<ContactClaim>;
  removeKnowledgeContact(input: KnowledgeItemCommand & { entityKind: 'person' }): Promise<void>;
  saveKnowledgeSourceLink(input: SaveKnowledgeSourceLinkInput): Promise<KnowledgeSourceLink>;
  removeKnowledgeSourceLink(input: KnowledgeItemCommand): Promise<void>;
  saveKnowledgeMember(input: SaveKnowledgeMemberInput): Promise<ProjectMember>;
  removeKnowledgeMember(input: KnowledgeItemCommand & { entityKind: 'project' }): Promise<void>;
  createKnowledgeSuggestionFromNote(input: { noteId: string; sourceId: string; quote: string; targetKind: KnowledgeEntityKind; targetId: string; change: import('../knowledge/types').KnowledgeChange }): Promise<KnowledgeSuggestion>;
  editKnowledgeSuggestion(id: string, input: EditKnowledgeSuggestionInput): Promise<KnowledgeSuggestion>;
  reviewKnowledgeSuggestion(id: string, input: ReviewKnowledgeSuggestionInput): Promise<KnowledgeSuggestion>;
  saveDocument(path: string, content: string, options?: { expectedRevision?: number; expectedEntityRevision?: number }): Promise<ContextDocument>;
  prepareImportedKnowledgeActivation(input: { archiveId: string; cohortId: string; kind: KnowledgeEntityKind; entityId: string }): Promise<ImportedKnowledgeActivationPreview>;
  activateImportedKnowledgeEntity(input: { sessionId: string; planHash: string; expectedDocumentRevision?: number }): Promise<{ entity: import('../knowledge/types').Person | import('../knowledge/types').Project; document: ContextDocument }>;
  saveSettings(patch: SettingsPatch): Promise<AppSettings>;
  saveAccount(config: AccountConfig): Promise<Account>;
  installVerifiedAccount(config: AccountConfig, result: OAuthInstallResult): Promise<Account>;
  retryCredentialCleanup(): Promise<void>;
  disconnectAccount(id: string): Promise<Account>;
  saveCalendar(config: CalendarConfig): Promise<Calendar>;
  syncAccount(id: string, options?: { continue?: boolean }): Promise<AccountSyncState>;
  refreshMailHead(accountId: string, options?: { reason?: 'manual' | 'foreground' }): Promise<MailLaneResult>;
  continueMailBackfill(accountId: string): Promise<MailLaneResult>;
  refreshForegroundMail(): Promise<ForegroundMailRefreshResult>;
  saveProactiveRule(input: {
    id?: string; expectedVersion?: number; name: string; enabled: boolean; accountIds: string[];
    trigger: import('../proactive').ProactiveTrigger; quietHours?: import('../proactive').QuietHours;
  }): Promise<SavedProactiveRule>;
  deleteProactiveRule(id: string, expectedVersion: number): Promise<void>;
  evaluateLocalCandidates(): Promise<ProactiveState>;
  dismissProactiveCandidate(candidateId: string): Promise<ProactiveCandidateEntry>;
  snoozeProactiveCandidate(candidateId: string, until: string): Promise<ProactiveCandidateEntry>;
  getProactiveCandidateSource(candidateId: string): Promise<ProactiveCandidateSourceResult>;
  createReminderDraft(input?: ReminderDraftInput): Promise<ReminderRecord>;
  updateReminderDraft(id: string, input: ReminderDraftPatch): Promise<ReminderRecord>;
  refreshReminderSource(id: string, input: { expectedRevision: number }): Promise<ReminderRecord>;
  approveReminder(id: string, input: { expectedRevision: number }): Promise<ReminderRecord>;
  saveApprovedReminder(id: string, input: { expectedRevision: number }): Promise<ReminderRecord>;
  retryReminderAlert(id: string, input: { expectedRevision: number }): Promise<ReminderRecord>;
  cancelReminder(id: string, input: { expectedRevision: number }): Promise<ReminderRecord>;
  completeReminder(id: string, input: { expectedRevision: number }): Promise<ReminderRecord>;
  deleteReminder(id: string, input: { expectedRevision: number }): Promise<void>;
  reconcileReminderAlerts(): Promise<void>;
  exportData(): Promise<string>;
  prepareBackupImport(input: string | Uint8Array): Promise<BackupImportPreview>;
  applyBackupImport(input: { sessionId: string; planHash: string }): Promise<import('../backup').ImportedBackupArchive>;
  activateImportedDocument(input: {
    archiveId: string; documentId: string; destinationPath: string; contentDigest: string;
    expectedCurrentRevision?: number; replaceConfirmed: boolean;
  }): Promise<{ status: 'activated' | 'unchanged'; document: ContextDocument; mirrorPending: boolean }>;
  deleteNote(id: string): Promise<void>;
  getMailReplySource(messageId: string): Promise<MailReplySourceResult>;
  createMailReplyProposal(input: { messageId: string; mode: 'reply' | 'reply_all'; sourceDigest: string; text: string; to?: string[]; cc?: string[] }): Promise<Proposal>;
  loadMailReplyText(input: { messageId: string; sourceDigest: string }): Promise<MailReplyTextLoadResult>;
  getMailReplyText(messageId: string): Promise<MailReplyTextCacheResult>;
  generateMailReplyText(input: MailReplyTextGenerationInput): Promise<MailReplyTextGenerationResult>;
}
