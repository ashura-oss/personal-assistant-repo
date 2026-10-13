export type AssistantIntent = 'assist' | 'summarize' | 'answer' | 'extract';
export type AssistantSourceKind = 'note' | 'document' | 'task' | 'calendar' | 'mail' | 'knowledge' | 'device_calendar' | 'device_calendar_event';

/** Content is the captured local snapshot; source IDs must not contain mutable display names. */
export interface AssistantSourceInput {
  id: string;
  revision: number;
  text: string;
  /** Optional local-only fingerprint material for aggregate sources; never sent or quoted. */
  versionMaterial?: string;
  required: boolean;
  kind?: AssistantSourceKind;
  title?: string;
  updatedAt?: string;
  /** Local deterministic selection hint; it is never included in provider context. */
  selectionPriority?: 0 | 1 | 2;
}

export interface LocalContextSnapshotInput {
  transcript: { revision: number; text: string };
  query?: string;
  intent?: AssistantIntent;
  documents?: Array<{ path: string; revision: number; content: string; updatedAt?: string; selectionPriority?: 0 | 1 | 2 }>;
  knowledge?: AssistantSourceInput[];
  notes?: { id: string; title: string; revision: number; transcript: string; updatedAt?: string; selectionPriority?: 0 | 1 | 2 }[];
  tasks?: Array<{ id: string; title: string; body: string; status: string; dueAt?: string; updatedAt?: string; selectionPriority?: 0 | 1 | 2 }>;
  calendars?: Array<{ id: string; accountId: string; identityKey?: string; providerId?: string; name: string; writable: boolean; connected: boolean }>;
  calendarEvents?: Array<{ id: string; accountId: string; calendarId: string; providerEventId: string; identityKey?: string; subject?: string; start?: string; end?: string; timeZone?: string; selectionPriority?: 0 | 1 | 2 }>;
  mailbox?: Array<{ id: string; accountId: string; providerMessageId: string; identityKey: string; subject?: string; from?: string; receivedAt?: string; snippet?: string; selectionPriority?: 0 | 1 | 2 }>;
  calendarSnapshot?: {
    identityKey: string;
    timeMin: string;
    timeMax: string;
    asOf: string;
    partial: boolean;
    events: Array<{ providerEventId: string; subject?: string; start?: string; end?: string; timeZone?: string }>;
  };
  deviceCalendarSnapshot?: {
    installationId: string;
    generation: number;
    selectionRevision: number;
    selectedCalendarIds: string[];
    timeMin: string;
    timeMax: string;
    asOf: string;
    partial: boolean;
    omittedEvents: number;
    events: { calendarId: string; nativeEventId: string; occurrenceStart: string; title: string; notes: string; notesTruncated: boolean; start: string; end: string; timeZone?: string; allDay: boolean; cancelled: boolean; selectionPriority?: 0 | 1 | 2 }[];
  };
}

export interface BoundedLocalSourceSet {
  sources: AssistantSourceInput[];
  omittedSourceCount: number;
  omittedSourceIds: string[];
}

export interface AssistantSource extends AssistantSourceInput {
  /** Hash of the complete captured text, independent of the provider request excerpt. */
  contentHash: string;
  version: string;
}

export interface SourceCatalog {
  readonly sources: readonly AssistantSource[];
  readonly byId: ReadonlyMap<string, AssistantSource>;
}

export interface AssistantCitation {
  sourceId: string;
  revision: number;
  sourceVersion: string;
  quote: string;
  source: string;
}

export interface AssistantDecision extends AssistantCitation { text: string; }

export interface AssistantProposal {
  kind: 'task' | 'reminder' | 'email' | 'event' | 'memory';
  title: string;
  body: string;
  recipients: string[];
  dueAt: string | null;
  evidence: string[];
}

export interface AssistantMemorySuggestion {
  targetSourceId: string;
  targetRevision: number;
  type: 'add_fact' | 'add_contact' | 'add_source_link' | 'add_member';
  statement: string | null;
  address: string | null;
  label: string | null;
  relatedSourceId: string | null;
  role: string | null;
  evidence: AssistantCitation[];
}

export interface AssistantResponse {
  summary: string;
  answer: string;
  decisions: AssistantDecision[];
  citations: AssistantCitation[];
  clarifications: string[];
  proposals: AssistantProposal[];
  memorySuggestions: AssistantMemorySuggestion[];
}

export interface ContextSelection {
  context: string;
  includedSourceIds: string[];
  omittedSourceIds: string[];
  omittedSourceCount: number;
  excerpts: Readonly<Record<string, string>>;
}

export interface OfflinePreviewInput {
  intent: AssistantIntent;
  transcript: string;
  question?: string;
  timeZone: string;
  now: string | Date;
  transcriptRevision?: number;
  transcriptSourceVersion?: string;
  tasks?: Array<{ title: string; status: string; dueAt?: string }>;
  calendarEvents?: Array<{ subject?: string; start?: string; timeZone?: string }>;
  calendarSnapshotAvailable?: boolean;
  deviceCalendarSnapshotAvailable?: boolean;
  deviceCalendarSnapshotPartial?: boolean;
  deviceCalendarEvents?: { subject?: string; start?: string; end?: string; timeZone?: string; allDay?: boolean; notes?: string; notesTruncated?: boolean }[];
}
