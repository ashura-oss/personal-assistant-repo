/** Stable application contracts shared by the UI, services, and storage. */
import type { AssistantCitation, AssistantDecision } from '../assistant';
import type { AudioRecoveryMetadata } from '../audio/recovery.types';
import type { KnowledgeState, KnowledgeEntityKind, KnowledgeFact, ContactClaim, KnowledgeSourceLink, ProjectMember, KnowledgeSuggestion, KnowledgeSuggestionReview, KnowledgeChange, KnowledgeEvidence } from '../knowledge/types';
import type { ReminderRecord, ReminderState, ReminderPayload } from '../reminders';
import type { StartupRecoveryInspection, StartupRecoveryPlan, StartupRecoveryReceipt, StartupRecoveryCommitInput } from '../storage/startupRecovery';
import type { PendingCaptureReceipt, PendingCaptureSafeStatus } from '../audio/pendingCaptureService.types';
import type { ProactiveMailAlertState } from '../proactiveMailAlerts/types';
import type { MailAlertTapKey, MailAlertTapResolution } from '../proactiveMailAlerts/taps';
import type { ProactiveRecoveryPlan, ProactiveRecoveryReceiptInspection, ProactiveRecoveryResult, ProactiveRecoveryStatus } from '../proactive/recovery';
import type { DispatchRecoveryPlan, DispatchRecoveryReceiptInspection, DispatchRecoveryResult, DispatchRecoveryStatus } from '../dispatch/recovery';
import type { ChatTranscriptTransferPlan } from '../chat/types';

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
  /** Local conversation-owned synthetic note; generic note actions must not mutate it. */
  origin?: 'assistant_chat';
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
  /** Present only when this immutable reply text came from a retained Batch result. */
  batchJobId?: string;
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
  /** This proposal predates dispatch recovery and is permanently read-only, even if its source is later edited. */
  dispatchRecoveryRetired?: true;
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
  /** Selects the provider independently from local Preview mode; missing legacy values remain Azure. */
  llmProvider?: 'azure' | 'openrouter';
  /** Fixed OpenRouter model slug for the versioned request profile. */
  openRouterModel?: 'openai/gpt-6-luna:batch';
  /** OpenRouter keeps its own selected effort when the Azure profile is changed. */
  openRouterReasoningEffort?: 'none' | 'low';
  /** Controlled profile version; changed request construction invalidates captured analysis fingerprints. */
  llmRequestContractVersion?: 1;
  timezone: string;
  /** OS background mail refresh is an explicit opt-in and is disabled for legacy snapshots. */
  backgroundMailRefreshEnabled?: boolean;
  /** Advances when the user changes background mail-refresh consent. */
  backgroundRefreshGeneration?: number;
  /** Speech transcription is an explicit, independent provider opt-in. */
  speechEnabled?: boolean;
  /** Missing values preserve the legacy Azure Speech provider. */
  speechProvider?: 'azure' | 'openrouter';
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
  /** Opaque IDs from explicit conversation-context discovery; omitted/empty retains the legacy request path exactly. */
  contextSelectionIds?: readonly string[];
  /** Explicit user consent for selected context bodies that are excerpts rather than complete messages. */
  contextExcerptSelectionIds?: readonly string[];
  forceRefresh?: boolean;
}

export interface MailReplyConversationContextRow {
  readonly rowId: string;
  readonly subject: string;
  readonly sender?: string;
  readonly receivedAt?: string;
  readonly sentAt?: string;
  readonly isDraft?: boolean;
}

export interface MailReplyConversationContextDiscovery {
  readonly sessionId: string;
  readonly targetMessageId: string;
  readonly rows: readonly MailReplyConversationContextRow[];
  readonly coverage: 'complete_metadata' | 'partial';
  readonly omissionReasons: readonly string[];
  readonly hasMore: boolean;
  readonly expiresAt: string;
}

export interface MailReplyContextSelection {
  readonly selectionId: string;
  readonly subject: string;
  readonly sender?: string;
  readonly receivedAt?: string;
  readonly sentAt?: string;
  readonly text: string;
  readonly bytes: number;
  readonly representation: SelectedMailTextSnapshot['representation'];
  readonly completeness: SelectedMailTextSnapshot['completeness'];
  readonly omissionReasons: readonly string[];
}

export interface MailReplyBatchContextReviewItem extends Omit<MailReplyConversationContextRow, 'rowId'> {
  readonly selectionId: string;
  readonly isReplyTarget?: boolean;
  readonly representation: SelectedMailTextSnapshot['representation'];
  readonly completeness: SelectedMailTextSnapshot['completeness'];
  readonly bytes: number;
  readonly omissionReasons: readonly string[];
}

export interface MailReplyBatchSourcesRefreshResult {
  readonly status: 'current';
  readonly jobId: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly sources: readonly MailReplyBatchContextReviewItem[];
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

export interface MailReplyBatchReviewPlan {
  readonly planId: string;
  readonly jobId: string;
  readonly messageId: string;
  readonly mode: 'reply' | 'reply_all';
  readonly subject: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly text: string;
  readonly contextMessages?: readonly MailReplyBatchContextReviewItem[];
  readonly expiresAt: string;
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
  /** Transient, local cancellation state; never persisted or exported. */
  transcriptionRequestCleanupPending?: { attemptId: string }[];
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
  /** Fixed, display-safe recovery summary; malformed receipt data is retained privately by the controller. */
  dispatchRecoveryStatus?: {
    quarantinedCount: number;
    message: 'Some saved dispatch receipts could not be validated and are held privately. New external writes are disabled until recovery.';
  };
  /** Versioned current mailbox metadata cache; this is independent of immutable dispatch history. */
  mailboxSchemaVersion: 2;
  proactive: ProactiveState;
  /** Separate, explicitly consented private notification ledger; never imported as authority. */
  proactiveMailAlerts: ProactiveMailAlertState;
  /** Fixed public notice; malformed mail-alert state remains in the controller's private quarantine. */
  proactiveMailAlertRecoveryStatus?: { quarantined: true; message: 'Some saved mail alert settings could not be validated and are held privately. New mail alerts are disabled until recovery.' };
  /** Fixed in-memory gate if scoped alert settlement detects unrelated workspace changes. */
  mailAlertRefreshRequired?: { required: true; message: 'Saved data changed. Refresh local data before continuing.' };
  /** Safe Batch job summaries only; raw request/result material remains in a private controller sidecar. */
  assistantBatchJobs?: import('../services/openRouterBatchJobs').AssistantBatchJobDTO[];
  /** Safe local chat snapshots. The provider request/job bindings remain private. */
  assistantChatConversations?: import('../chat/types').ChatConversationDTO[];
  /** Fixed notice; malformed chat state is retained privately and blocks chat operations. */
  assistantChatRecoveryStatus?: { blocked: true; message: 'Saved chat history could not be validated and is held privately. Chat actions are disabled until local data is refreshed.' };
  /** Fixed notice for an invalid private Batch ledger. */
  assistantBatchRecoveryStatus?: { blocked: true; message: 'Saved Batch history could not be validated and is held privately. Batch actions are disabled until local data is refreshed.' };
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
  chatConversationCount: number;
  chatTurnCount: number;
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

export type SettingsPatch = Partial<Omit<AppSettings, 'backgroundRefreshGeneration'>>;

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
  /** Called only after local privacy cleanup is durably complete. */
  disposeForPrivacy?(): Promise<void>;
  load(): Promise<void>;
  refreshPersistedWorkspace(): Promise<void>;
  getStartupRecoveryStatus(): Promise<StartupRecoveryStatus>;
  prepareStartupRecovery(): Promise<StartupRecoveryPlan>;
  commitStartupRecovery(input: StartupRecoveryCommitInput): Promise<StartupRecoveryReceipt>;
  cancelStartupRecovery(): Promise<void>;
  retryStartup(): Promise<void>;
  getPendingCaptureStatus(): Promise<PendingCaptureSafeStatus>;
  inspectPendingCapture(receipt: PendingCaptureReceipt): Promise<PendingCaptureSafeStatus>;
  exportPendingCapture(receipt: PendingCaptureReceipt): Promise<void>;
  discardPendingCapture(receipt: PendingCaptureReceipt): Promise<PendingCaptureSafeStatus>;
  retryPendingCaptureSourceRelease(): Promise<PendingCaptureSafeStatus>;
  savePendingCapture(receipt: PendingCaptureReceipt): Promise<Note>;
  saveNote(input: SaveNoteInput): Promise<Note>;
  confirmImportedNoteTimeZone(noteId: string, input: { timeZone: string; expectedRevision: number }): Promise<Note>;
  prepareRecordingAttachment(noteId: string, input: { expectedRevision: number }): Promise<RecordingAttachmentPreview | null>;
  attachRecording(input: { sessionId: string; planHash: string }): Promise<Note>;
  cancelRecordingAttachment(sessionId: string): Promise<void>;
  updateTranscript(id: string, text: string): Promise<Note>;
  processNote(id: string): Promise<Proposal[]>;
  assistNote(id: string, options?: { intent?: AssistIntent; question?: string; forceRefresh?: boolean; knowledgeSelection?: KnowledgeSelection }): Promise<NoteAssistResult>;
  submitNoteBatch(noteId: string, options?: { intent?: AssistIntent; question?: string; knowledgeSelection?: KnowledgeSelection }): Promise<import('../services/openRouterBatchJobs').AssistantBatchJobDTO>;
  createChatConversation(title?: string): Promise<import('../chat/types').ChatConversationDTO>;
  submitChatTurn(input: { conversationId: string; text: string; knowledgeSelection?: KnowledgeSelection }): Promise<{ kind: 'accepted'; conversationId: string; turnId: string; jobId: string }>;
  refineChatTurn(input: { conversationId: string; parentTurnId: string; effort: 'medium' | 'high' | 'max' }): Promise<{ kind: 'accepted'; conversationId: string; turnId: string; jobId: string }>;
  prepareChatFromTranscript(input: { noteId: string; expectedRevision: number }): Promise<ChatTranscriptTransferPlan>;
  cancelChatFromTranscript(planId: string): Promise<void>;
  submitChatFromTranscript(input: { planId: string; conversationId: string }): Promise<{ kind: 'accepted'; conversationId: string; turnId: string; jobId: string }>;
  deleteChatConversation(id: string): Promise<void>;
  refreshAssistantBatch(jobId: string): Promise<import('../services/openRouterBatchJobs').AssistantBatchJobDTO>;
  submitMailReplyBatch(input: Omit<MailReplyTextGenerationInput, 'forceRefresh'>): Promise<import('../services/openRouterBatchJobs').AssistantBatchJobDTO>;
  reviewMailReplyBatch(jobId: string): Promise<MailReplyBatchReviewPlan>;
  activateMailReplyBatch(input: { planId: string }): Promise<{ kind: 'created'; jobId: string; proposalId: string }>;
  cancelMailReplyBatchReview(planId: string): Promise<void>;
  deleteMailReplyBatch(jobId: string): Promise<void>;
  retryAssistantBatchCleanup(jobId: string): Promise<import('../services/openRouterBatchJobs').AssistantBatchJobDTO>;
  refreshAnalysisStatus(noteId: string): Promise<NoteAssistResult | undefined>;
  checkProposalFreshness(id: string): Promise<{ current: boolean; reason?: string }>;
  reconcileDispatch(recordId: string, input: { disposition: import('../dispatch').DispatchReconciliation; note: string; remoteId?: string }): Promise<import('../dispatch').DispatchRecord>;
  transcribeNote(id: string, options?: { expectedRevision: number }): Promise<Note>;
  cancelTranscription(noteId: string, input?: { attemptId?: string }): Promise<{ status: 'cancelled' | 'already_terminal' | 'not_running' }>;
  retryTranscriptionRequestCleanup(attemptId: string): Promise<void>;
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
  prepareKnowledgeSuggestionReview(id: string, input: { expectedRevision: number }): Promise<KnowledgeSuggestionReview>;
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
  enableProactiveMailAlerts(input: { ruleId: string; expectedRuleVersion: number; expectedRuleRevision: number; timeZone: string; accountIds: string[] }): Promise<void>;
  revokeProactiveMailAlerts(ruleId: string): Promise<void>;
  reconcileProactiveMailAlerts(): Promise<void>;
  resolveProactiveMailAlertTap(key: MailAlertTapKey): Promise<MailAlertTapResolution>;
  getProactiveRecoveryStatus(): ProactiveRecoveryStatus;
  prepareProactiveRecovery(): Promise<ProactiveRecoveryPlan>;
  cancelProactiveRecovery(operationId: string): Promise<void>;
  confirmProactiveRecovery(input: { operationId: string; confirmation: 'RESET RULES' }): Promise<ProactiveRecoveryResult>;
  inspectProactiveRecoveryReceipt(operationId: string): Promise<ProactiveRecoveryReceiptInspection>;
  getDispatchRecoveryStatus(): DispatchRecoveryStatus;
  prepareDispatchRecovery(): Promise<DispatchRecoveryPlan>;
  cancelDispatchRecovery(operationId: string): Promise<void>;
  confirmDispatchRecovery(input: { operationId: string; confirmation: 'RETIRE ACTIONS' }): Promise<DispatchRecoveryResult>;
  inspectDispatchRecoveryReceipt(operationId: string): Promise<DispatchRecoveryReceiptInspection>;
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
  deleteImportedChatConversation(input: { archiveId: string; conversationId: string }): Promise<void>;
  activateImportedDocument(input: {
    archiveId: string; documentId: string; destinationPath: string; contentDigest: string;
    expectedCurrentRevision?: number; replaceConfirmed: boolean;
  }): Promise<{ status: 'activated' | 'unchanged'; document: ContextDocument; mirrorPending: boolean }>;
  deleteNote(id: string): Promise<void>;
  getMailReplySource(messageId: string): Promise<MailReplySourceResult>;
  discoverMailReplyContext(input: { messageId: string; sourceDigest: string }): Promise<MailReplyConversationContextDiscovery>;
  continueMailReplyContextDiscovery(input: { sessionId: string }): Promise<MailReplyConversationContextDiscovery>;
  loadMailReplyContextMessage(input: { sessionId: string; rowId: string }): Promise<MailReplyContextSelection>;
  cancelMailReplyContextDiscovery(sessionId: string): Promise<void>;
  refreshMailReplyBatchSources(jobId: string): Promise<MailReplyBatchSourcesRefreshResult>;
  getMailReplyBatchSourcesStatus(jobId: string): { readonly status: 'missing' | 'refresh_required' | 'current' | 'invalid'; readonly expiresAt?: string };
  createMailReplyProposal(input: { messageId: string; mode: 'reply' | 'reply_all'; sourceDigest: string; text: string; to?: string[]; cc?: string[] }): Promise<Proposal>;
  loadMailReplyText(input: { messageId: string; sourceDigest: string }): Promise<MailReplyTextLoadResult>;
  getMailReplyText(messageId: string): Promise<MailReplyTextCacheResult>;
  generateMailReplyText(input: MailReplyTextGenerationInput): Promise<MailReplyTextGenerationResult>;
}

export type { PrivacyWorkspaceSession } from '../privacy/service';

export type StartupRecoveryPhase = 'ready' | 'failed' | 'prepared' | 'committing' | 'committed_opening' | 'unavailable';
export interface StartupRecoveryStatus {
  phase: StartupRecoveryPhase;
  inspection?: StartupRecoveryInspection;
}
