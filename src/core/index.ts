/** Stable application contracts shared by the UI, services, and storage. */

export type NoteStatus = 'recorded' | 'processed' | 'error';
export type ProposalKind = 'task' | 'reminder' | 'email' | 'event' | 'memory';
export type ProposalStatus = 'draft' | 'approved' | 'dispatching' | 'unknown' | 'failed' | 'accepted' | 'simulated' | 'executed' | 'dismissed';

export interface Note {
  id: string;
  title: string;
  transcript: string;
  audioUri?: string;
  durationSeconds: number;
  createdAt: string;
  status: NoteStatus;
  /** Increments whenever the transcript changes; approvals bind to this source revision. */
  revision: number;
  /** Persisted identity of the last analysis inputs, so retries/reloads do not repeat paid calls. */
  processingFingerprint?: string;
}

export interface ProposalEvidence {
  quote: string;
  start?: number;
  end?: number;
  confidence?: number;
  source?: string;
}

export interface Proposal {
  id: string;
  noteId: string;
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
  /** Stable idempotency key for provider event creation, persisted before dispatch. */
  eventTransactionId?: string;
  accountId?: string;
  recipients: string[];
  calendarId?: string;
  sourceRevision: number;
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

export type AccountAuthStatus = 'configured' | 'connected' | 'reauth_required' | 'revoked';
export type AccountCapability = 'mail.read' | 'mail.draft' | 'mail.send' | 'calendar.read' | 'calendar.write';

export interface Account {
  id: string;
  provider: 'google' | 'microsoft' | 'local';
  displayName: string;
  email: string;
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
  threadId?: string;
  subject?: string;
  from?: string;
  receivedAt?: string;
  snippet?: string;
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
  providerDeletedAt?: string;
}

export interface AccountSyncState {
  accountId: string;
  status: 'idle' | 'syncing' | 'partial' | 'error';
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
  speechEndpoint?: string;
  speechRegion?: string;
  openAiEndpoint?: string;
  openAiDeployment?: string;
  model?: string;
  maxContextTokens: number;
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

export interface AppState {
  notes: Note[];
  proposals: Proposal[];
  accounts: Account[];
  calendars: Calendar[];
  documents: ContextDocument[];
  activity: ActivityItem[];
  settings: AppSettings;
  usage: UsageLedger;
  mailbox: MailboxSnapshotMessage[];
  calendarEvents: CalendarEventSnapshot[];
  syncStates: Record<string, AccountSyncState>;
}

export interface SaveNoteInput {
  transcript: string;
  audioUri?: string;
  durationSeconds?: number;
}

export type ProposalPatch = Partial<Pick<Proposal,
  'title' | 'body' | 'accountId' | 'recipients' | 'calendarId' | 'dueAt' | 'email' | 'event'
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

export interface AppController {
  getSnapshot(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  load(): Promise<void>;
  saveNote(input: SaveNoteInput): Promise<Note>;
  updateTranscript(id: string, text: string): Promise<Note>;
  processNote(id: string): Promise<Proposal[]>;
  transcribeNote(id: string): Promise<Note>;
  editProposal(id: string, patch: ProposalPatch): Promise<Proposal>;
  approveProposal(id: string): Promise<Proposal>;
  executeProposal(id: string): Promise<Proposal>;
  dismissProposal(id: string): Promise<Proposal>;
  saveDocument(path: string, content: string): Promise<ContextDocument>;
  saveSettings(patch: SettingsPatch): Promise<AppSettings>;
  saveAccount(config: AccountConfig): Promise<Account>;
  installVerifiedAccount(config: AccountConfig, result: OAuthInstallResult, tokenRef: string): Promise<Account>;
  disconnectAccount(id: string): Promise<Account>;
  saveCalendar(config: CalendarConfig): Promise<Calendar>;
  syncAccount(id: string, options?: { continue?: boolean }): Promise<AccountSyncState>;
  exportData(): Promise<string>;
  deleteNote(id: string): Promise<void>;
}
