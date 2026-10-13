import type { AppState, NoteAssistResult, Proposal } from '../core';
import { emptyKnowledgeState, renderKnowledgeMarkdown, validateKnowledgeState, type KnowledgeState } from '../knowledge';

export const PORTABLE_BACKUP_FORMAT = 'still-backup-v3' as const;
export const PORTABLE_BACKUP_SCHEMA_VERSION = 3 as const;
const V2_FORMAT = 'still-backup-v2' as const;
const V2_SCHEMA_VERSION = 2 as const;
type PortableSourceFormat = typeof PORTABLE_BACKUP_FORMAT | typeof V2_FORMAT | 'voice-assistant-export-v1';

export const BACKUP_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxRestoredTextBytes: 24 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 400_000,
  notes: 5_000,
  tasks: 10_000,
  documents: 1_000,
  history: 20_000,
  historySourceIdChars: 1_200,
  textBytes: 256 * 1024,
  idChars: 256,
  titleChars: 512,
  pathChars: 240,
  knowledgeCohorts: 50,
  knowledgeSourceIdChars: 1_200,
});

export interface PortableNote {
  sourceId: string;
  title: string;
  transcript: string;
  durationSeconds: number;
  createdAt: string;
  capturedAt?: string;
  captureTimeZone?: string;
  originalTimeZoneUnknown?: true;
  audioMissing?: true;
}

export interface PortableTask {
  sourceId: string;
  title: string;
  body: string;
  status: 'open' | 'completed';
  createdAt: string;
  completedAt?: string;
  dueAt?: string;
  sourceNoteId?: string;
  unresolvedSourceNoteId?: string;
}

export interface PortableDocument {
  path: string;
  content: string;
  revision: number;
  updatedAt: string;
}

export interface PortableArchivedDocument extends PortableDocument { sourceId: string }

export type PortableHistoryKind =
  | 'analysis' | 'proposal' | 'dispatch' | 'mail' | 'calendar' | 'activity' | 'imported_history';

/** Inert, flattened history. Every field is display data and carries no authority. */
export interface PortableHistoryEntry {
  kind: PortableHistoryKind;
  sourceId: string;
  sourceNoteId?: string;
  title: string;
  content: string;
  status: string;
  occurredAt?: string;
  provider?: string;
  reference?: string;
}

export interface PortableBackupV2 {
  format: typeof V2_FORMAT;
  schemaVersion: typeof V2_SCHEMA_VERSION;
  exportId: string;
  exportedAt: string;
  audioIncluded: false;
  notes: PortableNote[];
  tasks: PortableTask[];
  documents: PortableDocument[];
  archivedDocuments: PortableArchivedDocument[];
  history: PortableHistoryEntry[];
}

export interface PortableKnowledgeNarrative {
  entityKind: 'person' | 'project'; entityId: string; content: string; revision: number; updatedAt: string;
}
export interface PortableKnowledge { state: KnowledgeState; narratives: PortableKnowledgeNarrative[] }
export interface PortableKnowledgeCohort { sourceId: string; knowledge: PortableKnowledge }

export interface PortableBackupV3 extends Omit<PortableBackupV2, 'format' | 'schemaVersion'> {
  format: typeof PORTABLE_BACKUP_FORMAT;
  schemaVersion: typeof PORTABLE_BACKUP_SCHEMA_VERSION;
  knowledge: PortableKnowledge;
  archivedKnowledge: PortableKnowledgeCohort[];
}

export interface KnowledgeActivationLink {
  entityKind: 'person' | 'project'; sourceEntityId: string; entityId: string; sourceDigest: string; activatedAt: string;
}
export interface ImportedArchivedKnowledgeCohort extends PortableKnowledgeCohort { id: string; activationLinks?: KnowledgeActivationLink[] }

export interface ImportedBackupArchive {
  id: string;
  contentHash: string;
  fileHash: string;
  sourceFormat: PortableSourceFormat;
  exportedAt: string;
  importedAt: string;
  noteLinks: { sourceId: string; noteId: string }[];
  taskLinks: { sourceId: string; taskId: string }[];
  documents: (PortableDocument & { id: string; activatedPath?: string; activatedAt?: string })[];
  history: (PortableHistoryEntry & { id: string; localNoteId?: string })[];
  archivedKnowledge?: ImportedArchivedKnowledgeCohort[];
}

export interface PortableBackupParseResult {
  backup: PortableBackupV3;
  sourceFormat: PortableSourceFormat;
  warnings: string[];
  ignoredFieldCount: number;
  migratedFromV1: boolean;
}

export interface PortableBackupMetadata { exportId: string; exportedAt: string }

const AUTHORITY_WARNING = 'Account connections, credentials, and executable approvals are not restored.';
const AUDIO_WARNING = 'Audio files are not included; restored notes will not contain local audio paths.';
const UNKNOWN_WARNING = 'Unrecognized legacy fields were ignored.';
const V1_TOP_LEVEL = new Set([
  'format', 'exportedAt', 'notes', 'tasks', 'documents', 'proposals', 'dispatchRecords',
  'mailbox', 'selectedMailTexts', 'calendarEvents', 'activity',
  // Known fields from the old runtime spread that are deliberately not imported.
  'accounts', 'calendars', 'settings', 'usage', 'syncStates', 'pendingCredentialCleanup',
  'dispatchRecordQuarantine', 'mailboxSchemaVersion', 'proactive',
]);

function fail(message: string): never { throw new Error(message); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function utf8Length(value: string): number { return new TextEncoder().encode(value).length; }
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function validateDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label} must be a valid date.`);
  const date = new Date(value);
  if (date.toISOString() !== value) fail(`${label} must use canonical ISO date format.`);
  return value;
}
function boundedString(value: unknown, label: string, maxBytes = BACKUP_LIMITS.textBytes): string {
  if (typeof value !== 'string') fail(`${label} must be text.`);
  if (hasUnpairedSurrogate(value)) fail(`${label} contains invalid Unicode.`);
  if (value.length > maxBytes) fail(`${label} exceeds the allowed text size.`);
  if (utf8Length(value) > maxBytes) fail(`${label} exceeds the allowed text size.`);
  return value;
}
function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || value.length < 1 || value.length > BACKUP_LIMITS.idChars || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function validateHistoryId(value: unknown): string {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || value.length < 1 || value.length > BACKUP_LIMITS.historySourceIdChars || /[\u0000-\u001f\u007f]/.test(value)) fail('History source ID is invalid.');
  return value;
}
function validateTitle(value: unknown, label: string): string {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || value.length > BACKUP_LIMITS.titleChars) fail(`${label} is invalid.`);
  return value;
}
function validateTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) fail('Note capture time zone is invalid.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); }
  catch { return fail('Note capture time zone is invalid.'); }
  return value;
}
function ownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) fail(`${label} contains an unsupported field.`);
}
function optionalDate(row: Record<string, unknown>, key: string, label: string): string | undefined {
  return row[key] === undefined ? undefined : validateDate(row[key], label);
}
function optionalId(row: Record<string, unknown>, key: string, label: string): string | undefined {
  return row[key] === undefined ? undefined : validateId(row[key], label);
}
function arrayField(value: unknown, max: number = BACKUP_LIMITS.history, label = 'Backup section'): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be a list.`);
  if (value.length > max) fail(`${label} exceeds the allowed item count.`);
  return value;
}
function duplicateIds(values: { sourceId: string }[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.sourceId)) fail(`${label} contains duplicate source IDs.`);
    seen.add(value.sourceId);
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Strict canonical Markdown namespace validation for inert portable documents. */
export function validatePortableDocumentPath(value: unknown): string {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || value.length > BACKUP_LIMITS.pathChars || !value || value.normalize('NFC') !== value) fail('Markdown path is not canonical.');
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-z][a-z\d+.-]*:/i.test(value) || value.includes('\\') || value.includes(':') || CONTROL.test(value)) fail('Markdown path must be a safe relative path.');
  if (value.includes('%')) fail('Markdown path cannot contain percent-encoded data.');
  const segments = value.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || WINDOWS_RESERVED.test(part) || /[<>"|?*]/.test(part))) fail('Markdown path contains an invalid segment.');
  if (!value.endsWith('.md')) fail('Only Markdown documents can be restored.');
  const namespace = segments[0];
  const validNamespace = namespace === 'memory' || namespace === 'notes' || namespace === 'projects' || namespace === 'people' ||
    (namespace === 'logs' && ['daily', 'weekly', 'monthly', 'yearly'].includes(segments[1] ?? ''));
  if (!validNamespace || segments.length < (namespace === 'logs' ? 3 : 2)) fail('Markdown path is outside the supported namespaces.');
  return value;
}

function baseRestoredTextBytes(backup: Pick<PortableBackupV2, 'notes' | 'tasks' | 'documents' | 'archivedDocuments' | 'history'>): number {
  let total = 0;
  const add = (value: string) => { total += utf8Length(value); };
  for (const note of backup.notes) { add(note.title); add(note.transcript); }
  for (const task of backup.tasks) { add(task.title); add(task.body); }
  for (const document of backup.documents) add(document.content);
  for (const document of backup.archivedDocuments) add(document.content);
  for (const entry of backup.history) { add(entry.title); add(entry.content); add(entry.status); }
  return total;
}

function normalizeV2(value: unknown): PortableBackupV2 {
  if (!isRecord(value)) fail('Backup must be a JSON object.');
  ownKeys(value, ['format', 'schemaVersion', 'exportId', 'exportedAt', 'audioIncluded', 'notes', 'tasks', 'documents', 'archivedDocuments', 'history'], 'Backup');
  if (value.format !== V2_FORMAT || value.schemaVersion !== V2_SCHEMA_VERSION) fail('Backup format or schema version is not supported.');
  if (value.audioIncluded !== false) fail('Backup audioIncluded must be false for this format.');
  const backup: PortableBackupV2 = {
    format: V2_FORMAT,
    schemaVersion: V2_SCHEMA_VERSION,
    exportId: validateId(value.exportId, 'Backup export ID'),
    exportedAt: validateDate(value.exportedAt, 'Backup export time'),
    audioIncluded: false,
    notes: [], tasks: [], documents: [], archivedDocuments: [], history: [],
  };
  const notes = arrayField(value.notes, BACKUP_LIMITS.notes, 'Notes');
  const tasks = arrayField(value.tasks, BACKUP_LIMITS.tasks, 'Tasks');
  const documents = arrayField(value.documents, BACKUP_LIMITS.documents, 'Documents');
  const archivedDocuments = arrayField(value.archivedDocuments, BACKUP_LIMITS.documents, 'Archived documents');
  if (documents.length + archivedDocuments.length > BACKUP_LIMITS.documents) fail('Documents exceed the allowed item count.');
  const history = arrayField(value.history, BACKUP_LIMITS.history, 'History');
  backup.notes = notes.map((item) => {
    if (!isRecord(item)) fail('Note entry must be an object.');
    ownKeys(item, ['sourceId', 'title', 'transcript', 'durationSeconds', 'createdAt', 'capturedAt', 'captureTimeZone', 'originalTimeZoneUnknown', 'audioMissing'], 'Note entry');
    const duration = item.durationSeconds;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 86_400) fail('Note duration is invalid.');
    if (item.audioMissing !== undefined && item.audioMissing !== true) fail('Note audioMissing marker is invalid.');
    if (item.originalTimeZoneUnknown !== undefined && item.originalTimeZoneUnknown !== true) fail('Note time zone provenance marker is invalid.');
    const captureTimeZone = item.captureTimeZone === undefined ? undefined : validateTimezone(item.captureTimeZone);
    if (item.originalTimeZoneUnknown === true && captureTimeZone !== undefined) fail('Unknown original time zone cannot claim a capture time zone.');
    return {
      sourceId: validateId(item.sourceId, 'Note source ID'), title: validateTitle(item.title, 'Note title'),
      transcript: boundedString(item.transcript, 'Note transcript'), durationSeconds: duration,
      createdAt: validateDate(item.createdAt, 'Note creation time'),
      ...(item.capturedAt !== undefined ? { capturedAt: validateDate(item.capturedAt, 'Note capture time') } : {}),
      ...(captureTimeZone ? { captureTimeZone } : {}), ...(item.originalTimeZoneUnknown ? { originalTimeZoneUnknown: true as const } : {}), ...(item.audioMissing ? { audioMissing: true as const } : {}),
    };
  });
  duplicateIds(backup.notes, 'Notes');
  backup.tasks = tasks.map((item) => {
    if (!isRecord(item)) fail('Task entry must be an object.');
    ownKeys(item, ['sourceId', 'title', 'body', 'status', 'createdAt', 'completedAt', 'dueAt', 'sourceNoteId', 'unresolvedSourceNoteId'], 'Task entry');
    if (item.status !== 'open' && item.status !== 'completed') fail('Task status is invalid.');
    if (item.sourceNoteId !== undefined && item.unresolvedSourceNoteId !== undefined) fail('Task source note reference cannot be both linked and unresolved.');
    return {
      sourceId: validateId(item.sourceId, 'Task source ID'), title: validateTitle(item.title, 'Task title'),
      body: boundedString(item.body, 'Task body'), status: item.status,
      createdAt: validateDate(item.createdAt, 'Task creation time'),
      ...(optionalDate(item, 'completedAt', 'Task completion time') ? { completedAt: item.completedAt as string } : {}),
      ...(optionalDate(item, 'dueAt', 'Task due time') ? { dueAt: item.dueAt as string } : {}),
      ...(optionalId(item, 'sourceNoteId', 'Task source note ID') ? { sourceNoteId: item.sourceNoteId as string } : {}),
      ...(optionalId(item, 'unresolvedSourceNoteId', 'Unresolved task source note ID') ? { unresolvedSourceNoteId: item.unresolvedSourceNoteId as string } : {}),
    };
  });
  const noteSourceIds = new Set(backup.notes.map((note) => note.sourceId));
  backup.tasks = backup.tasks.map((task) => {
    if (task.sourceNoteId && !noteSourceIds.has(task.sourceNoteId)) {
      const unresolvedSourceNoteId = task.sourceNoteId;
      const { sourceNoteId: _missingSourceNoteId, ...rest } = task;
      return { ...rest, unresolvedSourceNoteId };
    }
    return task;
  });
  duplicateIds(backup.tasks, 'Tasks');
  backup.documents = documents.map((item) => {
    if (!isRecord(item)) fail('Document entry must be an object.');
    ownKeys(item, ['path', 'content', 'revision', 'updatedAt'], 'Document entry');
    if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) fail('Document revision is invalid.');
    return { path: validatePortableDocumentPath(item.path), content: boundedString(item.content, 'Markdown document'), revision: item.revision as number,
      updatedAt: validateDate(item.updatedAt, 'Document update time') };
  });
  const documentPaths = new Set<string>();
  for (const document of backup.documents) {
    const collisionKey = document.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (documentPaths.has(collisionKey)) fail('Documents contain a duplicate or case-colliding path.');
    documentPaths.add(collisionKey);
  }
  backup.archivedDocuments = archivedDocuments.map((item) => {
    if (!isRecord(item)) fail('Archived document entry must be an object.');
    ownKeys(item, ['sourceId', 'path', 'content', 'revision', 'updatedAt'], 'Archived document entry');
    if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) fail('Archived document revision is invalid.');
    return { sourceId: validateId(item.sourceId, 'Archived document source ID'), path: validatePortableDocumentPath(item.path),
      content: boundedString(item.content, 'Archived Markdown document'), revision: item.revision as number,
      updatedAt: validateDate(item.updatedAt, 'Archived document update time') };
  });
  duplicateIds(backup.archivedDocuments, 'Archived documents');
  backup.history = history.map((item) => {
    if (!isRecord(item)) fail('History entry must be an object.');
    ownKeys(item, ['kind', 'sourceId', 'sourceNoteId', 'title', 'content', 'status', 'occurredAt', 'provider', 'reference'], 'History entry');
    if (!['analysis', 'proposal', 'dispatch', 'mail', 'calendar', 'activity', 'imported_history'].includes(String(item.kind))) fail('History kind is invalid.');
    const provider = item.provider === undefined ? undefined : boundedString(item.provider, 'History provider', 256);
    const reference = item.reference === undefined ? undefined : boundedString(item.reference, 'History reference', 2048);
    const occurredAt = optionalDate(item, 'occurredAt', 'History date');
    return {
      kind: item.kind as PortableHistoryKind, sourceId: validateHistoryId(item.sourceId),
      ...(optionalId(item, 'sourceNoteId', 'History source note ID') ? { sourceNoteId: item.sourceNoteId as string } : {}),
      title: validateTitle(item.title, 'History title'), content: boundedString(item.content, 'History content'),
      status: boundedString(item.status, 'History status', 512), ...(occurredAt ? { occurredAt } : {}),
      ...(provider !== undefined ? { provider } : {}), ...(reference !== undefined ? { reference } : {}),
    };
  });
  duplicateIds(backup.history, 'History');
  if (baseRestoredTextBytes(backup) > BACKUP_LIMITS.maxRestoredTextBytes) fail('Backup text exceeds the total restore limit.');
  return backup;
}

function redactEvidence(value: KnowledgeState['people'][number]['facts'][number]['evidence']): typeof value {
  return value?.map((item) => {
    const kind = item.sourceId.startsWith('mail:') ? 'mail' : /^calendar(?:[:\-]|$)/.test(item.sourceId) ? 'calendar'
      : item.sourceId.startsWith('device_calendar_event:') ? 'device_calendar' : undefined;
    return { ...item, ...(kind ? { sourceId: `historical:${kind}:${item.sourceVersion}` } : {}) };
  });
}
function redactReference(reference: KnowledgeState['people'][number]['sourceLinks'][number]['reference'], safeLabel: string) {
  return reference.kind === 'mail' || reference.kind === 'calendar' || reference.kind === 'device_calendar_event'
    ? { kind: 'historical' as const, label: safeLabel, originalKind: reference.kind }
    : reference;
}
function historicalReference(reference: KnowledgeState['people'][number]['sourceLinks'][number]['reference'], safeLabel: string) {
  return reference.kind === 'historical' ? reference : { kind: 'historical' as const, label: safeLabel, originalKind: reference.kind };
}
function portableChange(change: KnowledgeState['suggestions'][number]['change'], referencesUnavailable: boolean) {
  if (change.type !== 'add_source_link') return change;
  const reference = referencesUnavailable ? historicalReference(change.reference, change.label) : redactReference(change.reference, change.label);
  if (reference.kind === 'historical' && 'referenceRevision' in change) {
    const { referenceRevision: _referenceRevision, ...portable } = change;
    return { ...portable, reference };
  }
  return { ...change, reference };
}

/** Projects live knowledge into inert backup content with provider identities removed. */
export function createPortableKnowledge(
  input: KnowledgeState,
  narrativeDocuments: readonly Pick<PortableDocument, 'path' | 'content' | 'revision' | 'updatedAt'>[] = [],
  referencesUnavailable = false,
): PortableKnowledge {
  const state = validateKnowledgeState(input);
  const projected: KnowledgeState = {
    schemaVersion: 1,
    people: state.people.map((person) => { const { importOrigin: _origin, ...portablePerson } = person; return { ...portablePerson,
      facts: person.facts.map((fact) => ({ ...fact, ...(fact.evidence ? { evidence: redactEvidence(fact.evidence) } : {}) })),
      contacts: person.contacts.map((contact) => ({ ...contact, ...(contact.evidence ? { evidence: redactEvidence(contact.evidence) } : {}) })),
      sourceLinks: person.sourceLinks.map((link) => ({ ...link, reference: referencesUnavailable ? historicalReference(link.reference, link.label) : redactReference(link.reference, link.label), ...(link.evidence ? { evidence: redactEvidence(link.evidence) } : {}) })),
    }; }),
    projects: state.projects.map((project) => { const { importOrigin: _origin, ...portableProject } = project; return { ...portableProject,
      facts: project.facts.map((fact) => ({ ...fact, ...(fact.evidence ? { evidence: redactEvidence(fact.evidence) } : {}) })),
      members: project.members.map((member) => ({ ...member, ...(member.evidence ? { evidence: redactEvidence(member.evidence) } : {}) })),
      sourceLinks: project.sourceLinks.map((link) => ({ ...link, reference: referencesUnavailable ? historicalReference(link.reference, link.label) : redactReference(link.reference, link.label), ...(link.evidence ? { evidence: redactEvidence(link.evidence) } : {}) })),
    }; }),
    suggestions: state.suggestions.map((suggestion) => ({ ...suggestion, change: portableChange(suggestion.change, referencesUnavailable),
      ...(suggestion.evidence ? { evidence: redactEvidence(suggestion.evidence) } : {}),
      ...(suggestion.originalChange ? { originalChange: portableChange(suggestion.originalChange, referencesUnavailable) } : {}),
      ...(suggestion.originalEvidence ? { originalEvidence: redactEvidence(suggestion.originalEvidence) } : {}) })),
  };
  const narrativeFor = (entity: KnowledgeState['people'][number] | KnowledgeState['projects'][number], entityKind: 'person' | 'project'): PortableKnowledgeNarrative => {
    const document = narrativeDocuments.find((candidate) => candidate.path === entity.narrativePath);
    return { entityKind, entityId: entity.id, content: document?.content ?? renderKnowledgeMarkdown(projected, entityKind, entity.id),
      revision: document?.revision ?? entity.revision, updatedAt: document?.updatedAt ?? entity.updatedAt };
  };
  const narratives: PortableKnowledgeNarrative[] = [
    ...projected.people.map((entity) => narrativeFor(entity, 'person')),
    ...projected.projects.map((entity) => narrativeFor(entity, 'project')),
  ];
  return normalizePortableKnowledge({ state: projected, narratives });
}

function normalizePortableKnowledge(value: unknown): PortableKnowledge {
  if (!isRecord(value)) fail('Portable knowledge must be an object.');
  ownKeys(value, ['state', 'narratives'], 'Portable knowledge');
  if (!isRecord(value.state) || !Array.isArray(value.state.people) || !Array.isArray(value.state.projects)
    || [...value.state.people, ...value.state.projects].some((entity) => isRecord(entity) && Object.prototype.hasOwnProperty.call(entity, 'importOrigin'))) fail('Portable knowledge cannot contain runtime import authority.');
  const state = validateKnowledgeState(value.state);
  const rows = arrayField(value.narratives, BACKUP_LIMITS.knowledgeCohorts * 20, 'Knowledge narratives');
  const expected = new Map<string, { revision: number; updatedAt: string }>();
  for (const person of state.people) expected.set(`person:${person.id}`, person);
  for (const project of state.projects) expected.set(`project:${project.id}`, project);
  if (rows.length !== expected.size) fail('Portable knowledge must include one narrative for each entity.');
  const seen = new Set<string>();
  const narratives = rows.map((row) => {
    if (!isRecord(row)) fail('Knowledge narrative must be an object.');
    ownKeys(row, ['entityKind', 'entityId', 'content', 'revision', 'updatedAt'], 'Knowledge narrative');
    if (row.entityKind !== 'person' && row.entityKind !== 'project') fail('Knowledge narrative entity kind is invalid.');
    const entityId = validateKnowledgeEntityId(row.entityId);
    const key = `${row.entityKind}:${entityId}`;
    const entity = expected.get(key);
    if (!entity || seen.has(key)) fail('Knowledge narrative entity is missing or duplicated.');
    seen.add(key);
    if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1) fail('Knowledge narrative revision is invalid.');
    return { entityKind: row.entityKind as 'person' | 'project', entityId, content: boundedString(row.content, 'Knowledge narrative', 16 * 1024), revision: row.revision as number, updatedAt: validateDate(row.updatedAt, 'Knowledge narrative update time') };
  });
  return { state, narratives };
}
function validateKnowledgeEntityId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('Knowledge entity ID must be a canonical UUID.');
  return value;
}

function normalizeKnowledgeCohorts(value: unknown, label: string): PortableKnowledgeCohort[] {
  const rows = arrayField(value, BACKUP_LIMITS.knowledgeCohorts, label);
  const cohorts = rows.map((row) => {
    if (!isRecord(row)) fail(`${label} cohort must be an object.`);
    ownKeys(row, ['sourceId', 'knowledge'], `${label} cohort`);
    const sourceId = validateHistoryId(row.sourceId);
    if (sourceId.length > BACKUP_LIMITS.knowledgeSourceIdChars) fail(`${label} source ID is too long.`);
    return { sourceId, knowledge: normalizePortableKnowledge(row.knowledge) };
  });
  if (new Set(cohorts.map(({ sourceId }) => sourceId)).size !== cohorts.length) fail(`${label} contains duplicate source IDs.`);
  return cohorts;
}

function emptyPortableKnowledge(): PortableKnowledge { return { state: emptyKnowledgeState(), narratives: [] }; }
function hasKnowledge(value: PortableKnowledge): boolean {
  const { state } = value;
  return Boolean(state.people.length || state.projects.length || state.suggestions.length);
}
function normalizeV3(value: unknown): PortableBackupV3 {
  if (!isRecord(value)) fail('Backup must be a JSON object.');
  ownKeys(value, ['format', 'schemaVersion', 'exportId', 'exportedAt', 'audioIncluded', 'notes', 'tasks', 'documents', 'archivedDocuments', 'history', 'knowledge', 'archivedKnowledge'], 'Backup');
  if (value.format !== PORTABLE_BACKUP_FORMAT || value.schemaVersion !== PORTABLE_BACKUP_SCHEMA_VERSION) fail('Backup format or schema version is not supported.');
  const base = normalizeV2({ format: V2_FORMAT, schemaVersion: V2_SCHEMA_VERSION, exportId: value.exportId, exportedAt: value.exportedAt, audioIncluded: value.audioIncluded,
    notes: value.notes, tasks: value.tasks, documents: value.documents, archivedDocuments: value.archivedDocuments, history: value.history });
  const knowledge = normalizePortableKnowledge(value.knowledge);
  const archivedKnowledge = normalizeKnowledgeCohorts(value.archivedKnowledge, 'Archived knowledge');
  if (archivedKnowledge.length + (hasKnowledge(knowledge) ? 1 : 0) > BACKUP_LIMITS.knowledgeCohorts) fail('Knowledge cohorts exceed the allowed item count.');
  const totalText = baseRestoredTextBytes(base) + utf8Length(JSON.stringify(knowledge)) + archivedKnowledge.reduce((total, cohort) => total + utf8Length(JSON.stringify(cohort.knowledge)), 0);
  if (totalText > BACKUP_LIMITS.maxRestoredTextBytes) fail('Backup text exceeds the total restore limit.');
  return { ...base, format: PORTABLE_BACKUP_FORMAT, schemaVersion: PORTABLE_BACKUP_SCHEMA_VERSION, knowledge, archivedKnowledge };
}
function upgradeV2(backup: PortableBackupV2): PortableBackupV3 {
  return normalizeV3({ ...backup, format: PORTABLE_BACKUP_FORMAT, schemaVersion: PORTABLE_BACKUP_SCHEMA_VERSION,
    knowledge: emptyPortableKnowledge(), archivedKnowledge: [] });
}

function scanDepth(text: string): void {
  let depth = 0; let quoted = false; let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > BACKUP_LIMITS.maxDepth) fail('Backup nesting is too deep.');
    } else if (char === '}' || char === ']') depth -= 1;
  }
}

function scanNodes(root: unknown): void {
  const stack: unknown[] = [root]; let count = 0;
  while (stack.length) {
    const value = stack.pop(); count += 1;
    if (count > BACKUP_LIMITS.maxNodes) fail('Backup contains too many data items.');
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { for (const item of value) stack.push(item); continue; }
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail('Backup contains a forbidden object key.');
      stack.push(child);
    }
  }
}

function legacyText(value: unknown): string { return typeof value === 'string' ? value : ''; }
function legacyStringList(value: unknown): string { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ') : ''; }
function legacyDate(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  return validateDate(value, label);
}
function optionalLegacyDate(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : validateDate(value, label);
}
function legacyArray(row: Record<string, unknown>, key: string, limit: number = BACKUP_LIMITS.history): unknown[] {
  if (row[key] === undefined) return [];
  return arrayField(row[key], limit, `Legacy ${key}`);
}
function portableAnalysis(note: Record<string, unknown>, noteId: string, history: PortableHistoryEntry[]): void {
  const analysis = note.analysis;
  if (!isRecord(analysis)) return;
  const sections = [
    ['Summary', analysis.summary], ['Answer', analysis.answer],
    ['Decisions', Array.isArray(analysis.decisions) ? analysis.decisions.map((d) => isRecord(d) ? [d.text, d.quote, d.source].filter((v) => typeof v === 'string').join('\n') : '').filter(Boolean).join('\n\n') : ''],
    ['Citations', Array.isArray(analysis.citations) ? analysis.citations.map((c) => isRecord(c) ? [c.source, c.quote].filter((v) => typeof v === 'string').join('\n') : '').filter(Boolean).join('\n\n') : ''],
    ['Clarifications', Array.isArray(analysis.clarifications) ? analysis.clarifications.filter((v): v is string => typeof v === 'string').join('\n') : ''],
  ] as const;
  for (const [label, value] of sections) if (typeof value === 'string' && value) {
    const hasTime = typeof analysis.analyzedAt === 'string' && Boolean(analysis.analyzedAt);
    history.push({ kind: 'analysis', sourceId: `analysis:${noteId}:${label.toLowerCase()}`, sourceNoteId: noteId, title: `${label} — imported analysis`, content: value,
      status: `Unverified historical result${hasTime ? '' : ' — Original time unavailable'}`,
      ...(hasTime ? { occurredAt: optionalLegacyDate(analysis.analyzedAt, 'Analysis time') } : {}) });
  }
}

function migrateV1(raw: Record<string, unknown>): { backup: PortableBackupV2; ignoredFieldCount: number } {
  if (raw.format !== 'voice-assistant-export-v1') fail('Backup format or schema version is not supported.');
  if (typeof raw.exportedAt !== 'string') fail('Legacy backup export time is missing.');
  const exportedAt = legacyDate(raw.exportedAt, new Date(0).toISOString(), 'Backup export time');
  const ignoredFieldCount = Object.keys(raw).filter((key) => !V1_TOP_LEVEL.has(key)).length;
  const backup: PortableBackupV2 = { format: V2_FORMAT, schemaVersion: V2_SCHEMA_VERSION,
    exportId: 'migrated-v1', exportedAt, audioIncluded: false, notes: [], tasks: [], documents: [], archivedDocuments: [], history: [] };
  for (const item of legacyArray(raw, 'notes', BACKUP_LIMITS.notes)) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.transcript !== 'string' || typeof item.createdAt !== 'string') fail('Legacy backup contains an invalid note entry.');
    if (typeof item.durationSeconds !== 'number' || !Number.isFinite(item.durationSeconds) || item.durationSeconds < 0 || item.durationSeconds > 86_400) fail('Legacy note duration is invalid.');
    const noteId = validateId(item.id, 'Legacy note ID');
    backup.notes.push({ sourceId: noteId, title: validateTitle(item.title, 'Legacy note title'), transcript: boundedString(item.transcript, 'Legacy note transcript'),
      durationSeconds: item.durationSeconds,
      createdAt: legacyDate(item.createdAt, exportedAt, 'Legacy note creation time'),
      ...(typeof item.capturedAt === 'string' ? { capturedAt: validateDate(item.capturedAt, 'Legacy note capture time') } : {}),
      ...(item.originalTimeZoneUnknown === true ? { originalTimeZoneUnknown: true as const } : typeof item.captureTimeZone === 'string' ? { captureTimeZone: validateTimezone(item.captureTimeZone) } : {}),
      ...(typeof item.audioUri === 'string' && item.audioUri ? { audioMissing: true as const } : {}),
    });
    portableAnalysis(item, noteId, backup.history);
  }
  duplicateIds(backup.notes, 'Legacy notes');
  for (const item of legacyArray(raw, 'tasks', BACKUP_LIMITS.tasks)) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.body !== 'string' || typeof item.createdAt !== 'string') fail('Legacy backup contains an invalid task entry.');
    if (item.status !== 'open' && item.status !== 'completed') fail('Legacy task status is invalid.');
    backup.tasks.push({ sourceId: validateId(item.id, 'Legacy task ID'), title: validateTitle(item.title, 'Legacy task title'), body: boundedString(item.body, 'Legacy task body'), status: item.status,
      createdAt: validateDate(item.createdAt, 'Legacy task creation time'),
      ...(typeof item.completedAt === 'string' ? { completedAt: validateDate(item.completedAt, 'Legacy task completion time') } : {}),
      ...(typeof item.dueAt === 'string' ? { dueAt: validateDate(item.dueAt, 'Legacy task due time') } : {}),
      ...(typeof item.sourceNoteId === 'string' ? { sourceNoteId: validateId(item.sourceNoteId, 'Legacy task source note ID') } : {}),
    });
  }
  duplicateIds(backup.tasks, 'Legacy tasks');
  for (const item of legacyArray(raw, 'documents', BACKUP_LIMITS.documents)) {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.content !== 'string' || typeof item.updatedAt !== 'string') fail('Legacy backup contains an invalid Markdown document.');
    if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) fail('Legacy Markdown document revision is invalid.');
    backup.documents.push({ path: validatePortableDocumentPath(item.path), content: boundedString(item.content, 'Legacy Markdown document'),
      revision: item.revision as number,
      updatedAt: validateDate(item.updatedAt, 'Legacy document update time') });
  }
  const addHistory = (kind: PortableHistoryKind, sourceId: string, title: string, content: string, status: string, occurredAt?: string, sourceNoteId?: string, provider?: string, reference?: string) => {
    backup.history.push({ kind, sourceId: validateHistoryId(sourceId), ...(sourceNoteId ? { sourceNoteId: validateId(sourceNoteId, 'Legacy history source note ID') } : {}), title: validateTitle(title, 'Legacy history title'),
      content: boundedString(content, 'Legacy history content'), status: boundedString(status, 'Legacy history status', 512), ...(occurredAt ? { occurredAt: validateDate(occurredAt, 'Legacy history time') } : {}), ...(provider ? { provider } : {}), ...(reference ? { reference } : {}) });
  };
  for (const item of legacyArray(raw, 'proposals')) {
    if (!isRecord(item) || typeof item.id !== 'string') fail('Legacy backup contains an invalid proposal history entry.');
    if (item.dueAt !== undefined && typeof item.dueAt !== 'string') fail('Legacy proposal due time is invalid.');
    const dueAt = typeof item.dueAt === 'string' ? validateDate(item.dueAt, 'Legacy proposal due time') : undefined;
    const email = isRecord(item.email) ? item.email : undefined;
    const event = isRecord(item.event) ? item.event : undefined;
    const content = [`Title: ${legacyText(item.title)}`, `Body: ${legacyText(item.body)}`, ...(dueAt ? [`Due: ${dueAt}`] : []),
      ...(email ? [`Subject: ${legacyText(email.subject)}`, `To: ${legacyStringList(email.to)}`, `Cc: ${legacyStringList(email.cc)}`, `Bcc: ${legacyStringList(email.bcc)}`, `Email body: ${legacyText(email.text)}`] : []),
      ...(event ? [`Event: ${legacyText(event.title)}`, `Start: ${legacyText(event.start)}`, `End: ${legacyText(event.end)}`, `Time zone: ${legacyText(event.timeZone)}`, `Attendees: ${legacyStringList(event.attendees)}`, `Description: ${legacyText(event.description)}`] : [])].filter(Boolean).join('\n\n');
    addHistory('proposal', `proposal:${item.id}`, 'Saved suggestion — imported history', content, `${legacyText(item.status) || 'unknown'} (unverified imported history)${item.remoteAcceptedAt ? '' : ' — Original time unavailable'}`, optionalLegacyDate(item.remoteAcceptedAt, 'Proposal history time'), typeof item.noteId === 'string' ? item.noteId : undefined, undefined, typeof item.remoteId === 'string' ? item.remoteId : undefined);
  }
  for (const item of legacyArray(raw, 'dispatchRecords')) {
    if (!isRecord(item) || typeof item.id !== 'string') fail('Legacy backup contains an invalid dispatch history entry.');
    const payload = isRecord(item.payload) ? item.payload : undefined;
    const email = payload && isRecord(payload.email) ? payload.email : undefined;
    const event = payload && isRecord(payload.event) ? payload.event : undefined;
    const content = [`Title: ${legacyText(item.title)}`, `Body: ${legacyText(item.body)}`,
      ...(email ? [`Subject: ${legacyText(email.subject)}`, `To: ${legacyStringList(email.to)}`, `Cc: ${legacyStringList(email.cc)}`, `Bcc: ${legacyStringList(email.bcc)}`, `Email body: ${legacyText(email.text)}`] : []),
      ...(event ? [`Event: ${legacyText(event.title)}`, `Start: ${legacyText(event.start)}`, `End: ${legacyText(event.end)}`, `Time zone: ${legacyText(event.timeZone)}`, `Attendees: ${legacyStringList(event.attendees)}`, `Description: ${legacyText(event.description)}`] : [])].filter(Boolean).join('\n\n');
    const reconciliation = Array.isArray(item.reconciliations) ? item.reconciliations.filter(isRecord).map((att) => `Reconciliation (${legacyText(att.disposition)}): ${legacyText(att.note)}`).join('\n') : '';
    addHistory('dispatch', `dispatch:${item.id}`, 'External action — imported history', [legacyText(item.title), legacyText(item.body), content, reconciliation].filter(Boolean).join('\n\n'), `${legacyText(item.outcome) || 'unknown'} (unverified imported history)${item.dispatchStartedAt ? '' : ' — Original time unavailable'}`, optionalLegacyDate(item.dispatchStartedAt, 'Dispatch history time'), undefined, 'unknown provider', typeof item.remoteId === 'string' ? item.remoteId : undefined);
  }
  for (const item of legacyArray(raw, 'mailbox')) {
    if (!isRecord(item) || typeof item.id !== 'string') fail('Legacy backup contains an invalid mail history entry.');
    const content = [`Subject: ${legacyText(item.subject)}`, `From: ${legacyText(item.from)}`, `Sender: ${legacyText(item.senderEmail)}`,
      `To: ${legacyStringList(item.to)}`, `Cc: ${legacyStringList(item.cc)}`,
      `Received: ${legacyText(item.receivedAt)}`, `Snippet: ${legacyText(item.snippet)}`].filter(Boolean).join('\n');
    addHistory('mail', `mail:${item.id}`, 'Mail item — imported history', content, `Imported mailbox snapshot; unverified${item.observedAt ? '' : ' — Original time unavailable'}`, optionalLegacyDate(item.observedAt, 'Mail snapshot time'), undefined, 'unknown provider', typeof item.providerMessageId === 'string' ? item.providerMessageId : undefined);
  }
  for (const item of legacyArray(raw, 'selectedMailTexts')) {
    if (!isRecord(item) || typeof item.messageId !== 'string') fail('Legacy backup contains an invalid mail text history entry.');
    addHistory('mail', `mail-text:${item.messageId}`, 'Selected mail text — imported history', legacyText(item.text), `Imported cached text; unverified${item.checkedAt ? '' : ' — Original time unavailable'}`, optionalLegacyDate(item.checkedAt, 'Mail text time'), undefined, 'unknown provider');
  }
  for (const item of legacyArray(raw, 'calendarEvents')) {
    if (!isRecord(item) || typeof item.id !== 'string') fail('Legacy backup contains an invalid calendar history entry.');
    const content = [`Subject: ${legacyText(item.subject)}`, `Start: ${legacyText(item.start)}`, `End: ${legacyText(item.end)}`, `Time zone: ${legacyText(item.timeZone)}`,
      `Location: ${legacyText(item.location)}`, `Description: ${legacyText(item.description)}`,
      `Cancelled: ${typeof item.cancelled === 'boolean' ? (item.cancelled ? 'yes' : 'no') : typeof item.isCancelled === 'boolean' ? (item.isCancelled ? 'yes' : 'no') : item.providerDeletedAt ? 'yes' : 'unknown'}`,
      `All day: ${typeof item.allDay === 'boolean' ? (item.allDay ? 'yes' : 'no') : typeof item.isAllDay === 'boolean' ? (item.isAllDay ? 'yes' : 'no') : 'unknown'}`].filter((line) => !line.endsWith(': ')).join('\n');
    addHistory('calendar', `calendar:${item.id}`, 'Calendar event — imported history', content, `Imported calendar snapshot; unverified${item.observedAt ? '' : ' — Original time unavailable'}`, optionalLegacyDate(item.observedAt, 'Calendar snapshot time'), undefined, 'unknown provider', typeof item.providerEventId === 'string' ? item.providerEventId : undefined);
  }
  for (const item of legacyArray(raw, 'activity')) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.message !== 'string') fail('Legacy backup contains an invalid activity history entry.');
    addHistory('activity', `activity:${item.id}`, 'Activity — imported history', item.message, `${legacyText(item.type) || 'historical activity'}${item.createdAt ? '' : ' — Original time unavailable'}`, optionalLegacyDate(item.createdAt, 'Activity time'), typeof item.noteId === 'string' ? item.noteId : undefined);
  }
  duplicateIds(backup.history, 'Legacy history');
  return { backup: normalizeV2(backup), ignoredFieldCount };
}

/** Parse a v1/v2 legacy input through a strict adapter, or validate the current v3 format. */
export function parsePortableBackup(input: string | Uint8Array): PortableBackupParseResult {
  let text: string;
  if (typeof input === 'string' && input.length > BACKUP_LIMITS.maxBytes) fail('Backup file exceeds the allowed size.');
  if (input instanceof Uint8Array && input.byteLength > BACKUP_LIMITS.maxBytes) fail('Backup file exceeds the allowed size.');
  try { text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { fail('Backup is not valid UTF-8.'); }
  if (utf8Length(text) > BACKUP_LIMITS.maxBytes) fail('Backup file exceeds the allowed size.');
  scanDepth(text);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { fail('Backup is not valid JSON.'); }
  scanNodes(raw);
  if (!isRecord(raw)) fail('Backup must be a JSON object.');
  if (raw.format === 'voice-assistant-export-v1') {
    const migrated = migrateV1(raw);
    const warnings = [AUTHORITY_WARNING, AUDIO_WARNING];
    if (migrated.ignoredFieldCount) warnings.push(UNKNOWN_WARNING);
    return { backup: upgradeV2(migrated.backup), sourceFormat: 'voice-assistant-export-v1', ignoredFieldCount: migrated.ignoredFieldCount, warnings, migratedFromV1: true };
  }
  if (raw.format === V2_FORMAT) {
    const backup = upgradeV2(normalizeV2(raw));
    return { backup, sourceFormat: V2_FORMAT, warnings: [AUTHORITY_WARNING, AUDIO_WARNING], ignoredFieldCount: 0, migratedFromV1: false };
  }
  if (raw.format !== PORTABLE_BACKUP_FORMAT) fail('Backup format or schema version is not supported.');
  const backup = normalizeV3(raw);
  return { backup, sourceFormat: PORTABLE_BACKUP_FORMAT, warnings: [AUTHORITY_WARNING, AUDIO_WARNING], ignoredFieldCount: 0, migratedFromV1: false };
}

/** Fail-closed validator for the inert archive persisted by the controller. */
export function validateImportedBackupArchive(value: unknown): ImportedBackupArchive | undefined {
  try {
    if (!isRecord(value)) return undefined;
    ownKeys(value, ['id', 'contentHash', 'fileHash', 'sourceFormat', 'exportedAt', 'importedAt', 'noteLinks', 'taskLinks', 'documents', 'history', 'archivedKnowledge'], 'Imported archive');
    const id = validateId(value.id, 'Imported archive ID');
    for (const key of ['contentHash', 'fileHash'] as const) if (typeof value[key] !== 'string' || !/^[a-f\d]{64}$/i.test(value[key] as string)) return undefined;
    if (value.sourceFormat !== PORTABLE_BACKUP_FORMAT && value.sourceFormat !== V2_FORMAT && value.sourceFormat !== 'voice-assistant-export-v1') return undefined;
    const noteLinksRaw = arrayField(value.noteLinks, BACKUP_LIMITS.notes, 'Archive note links');
    const taskLinksRaw = arrayField(value.taskLinks, BACKUP_LIMITS.tasks, 'Archive task links');
    const docsRaw = arrayField(value.documents, BACKUP_LIMITS.documents, 'Archive documents');
    const historyRaw = arrayField(value.history, BACKUP_LIMITS.history, 'Archive history');
    const archivedKnowledgeRaw = value.archivedKnowledge === undefined ? [] : arrayField(value.archivedKnowledge, BACKUP_LIMITS.knowledgeCohorts, 'Archive knowledge cohorts');
    const noteLinks = noteLinksRaw.map((row) => {
      if (!isRecord(row)) fail('Archive note link is invalid.');
      ownKeys(row, ['sourceId', 'noteId'], 'Archive note link');
      return { sourceId: validateId(row.sourceId, 'Archive note source ID'), noteId: validateId(row.noteId, 'Archive note ID') };
    });
    const taskLinks = taskLinksRaw.map((row) => {
      if (!isRecord(row)) fail('Archive task link is invalid.');
      ownKeys(row, ['sourceId', 'taskId'], 'Archive task link');
      return { sourceId: validateId(row.sourceId, 'Archive task source ID'), taskId: validateId(row.taskId, 'Archive task ID') };
    });
    duplicateIds(noteLinks, 'Archive note links');
    duplicateIds(taskLinks, 'Archive task links');
    const documents = docsRaw.map((row) => {
      if (!isRecord(row)) fail('Archive document is invalid.');
      ownKeys(row, ['id', 'path', 'content', 'revision', 'updatedAt', 'activatedPath', 'activatedAt'], 'Archive document');
      if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1) fail('Archive document revision is invalid.');
      const activatedPath = row.activatedPath === undefined ? undefined : validatePortableDocumentPath(row.activatedPath);
      const activatedAt = row.activatedAt === undefined ? undefined : validateDate(row.activatedAt, 'Archive activation time');
      if ((activatedPath === undefined) !== (activatedAt === undefined)) fail('Archive activation metadata is incomplete.');
      return { id: validateId(row.id, 'Archive document ID'), path: validatePortableDocumentPath(row.path),
        content: boundedString(row.content, 'Archived Markdown document'), revision: row.revision as number,
        updatedAt: validateDate(row.updatedAt, 'Archived document update time'), ...(activatedPath ? { activatedPath, activatedAt } : {}) };
    });
    if (new Set(documents.map((document) => document.id)).size !== documents.length) fail('Archive documents contain duplicate IDs.');
    const history = historyRaw.map((row) => {
      if (!isRecord(row)) fail('Archive history entry is invalid.');
      ownKeys(row, ['id', 'kind', 'sourceId', 'sourceNoteId', 'localNoteId', 'title', 'content', 'status', 'occurredAt', 'provider', 'reference'], 'Archive history entry');
      const entry = normalizeV2({ format: V2_FORMAT, schemaVersion: V2_SCHEMA_VERSION, exportId: id, exportedAt: value.exportedAt,
        audioIncluded: false, notes: [], tasks: [], documents: [], archivedDocuments: [], history: [{
          kind: row.kind, sourceId: row.sourceId, ...(row.sourceNoteId !== undefined ? { sourceNoteId: row.sourceNoteId } : {}),
          title: row.title, content: row.content, status: row.status, ...(row.occurredAt !== undefined ? { occurredAt: row.occurredAt } : {}),
          ...(row.provider !== undefined ? { provider: row.provider } : {}), ...(row.reference !== undefined ? { reference: row.reference } : {}),
        }] }).history[0]!;
      return { ...entry, id: validateId(row.id, 'Archive history ID'), ...(row.localNoteId !== undefined ? { localNoteId: validateId(row.localNoteId, 'Archive history local note ID') } : {}) };
    });
    duplicateIds(history, 'Archive history');
    if (new Set(history.map((entry) => entry.id)).size !== history.length) fail('Archive history contains duplicate local IDs.');
    const archivedKnowledge = archivedKnowledgeRaw.map((row) => {
      if (!isRecord(row)) fail('Archive knowledge cohort is invalid.');
      ownKeys(row, ['id', 'sourceId', 'knowledge', 'activationLinks'], 'Archive knowledge cohort');
      const sourceId = validateHistoryId(row.sourceId);
      if (sourceId.length > BACKUP_LIMITS.knowledgeSourceIdChars) fail('Archive knowledge source ID is too long.');
      const activationLinks = row.activationLinks === undefined ? undefined : arrayField(row.activationLinks, 1_000, 'Knowledge activation links').map((item) => {
        if (!isRecord(item)) fail('Knowledge activation link is invalid.');
        ownKeys(item, ['entityKind', 'sourceEntityId', 'entityId', 'sourceDigest', 'activatedAt'], 'Knowledge activation link');
        if (item.entityKind !== 'person' && item.entityKind !== 'project') fail('Knowledge activation entity kind is invalid.');
        if (typeof item.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceDigest)) fail('Knowledge activation digest is invalid.');
        return { entityKind: item.entityKind as 'person' | 'project', sourceEntityId: validateKnowledgeEntityId(item.sourceEntityId), entityId: validateKnowledgeEntityId(item.entityId), sourceDigest: item.sourceDigest,
          activatedAt: validateDate(item.activatedAt, 'Knowledge activation time') };
      });
      if (activationLinks && (new Set(activationLinks.map(({ entityKind, sourceEntityId }) => `${entityKind}:${sourceEntityId}`)).size !== activationLinks.length
        || new Set(activationLinks.map(({ entityId }) => entityId)).size !== activationLinks.length)) fail('Knowledge activation links contain duplicate IDs.');
      return { id: validateId(row.id, 'Archive knowledge cohort ID'), sourceId, knowledge: normalizePortableKnowledge(row.knowledge), ...(activationLinks ? { activationLinks } : {}) };
    });
    if (new Set(archivedKnowledge.map(({ id: cohortId }) => cohortId)).size !== archivedKnowledge.length || new Set(archivedKnowledge.map(({ sourceId }) => sourceId)).size !== archivedKnowledge.length) fail('Archive knowledge cohorts contain duplicate IDs.');
    let restoredTextBytes = 0;
    for (const document of documents) restoredTextBytes += utf8Length(document.content);
    for (const entry of history) restoredTextBytes += utf8Length(entry.title) + utf8Length(entry.content) + utf8Length(entry.status);
    for (const cohort of archivedKnowledge) restoredTextBytes += utf8Length(JSON.stringify(cohort.knowledge));
    if (restoredTextBytes > BACKUP_LIMITS.maxRestoredTextBytes) return undefined;
    return { id, contentHash: value.contentHash as string, fileHash: value.fileHash as string,
      sourceFormat: value.sourceFormat, exportedAt: validateDate(value.exportedAt, 'Archive export time'), importedAt: validateDate(value.importedAt, 'Archive import time'),
      noteLinks, taskLinks, documents, history, archivedKnowledge };
  } catch { return undefined; }
}

function proposalHistory(proposal: Proposal, activity: AppState['activity']): PortableHistoryEntry {
  const activityItem = activity.find((item) => item.proposalId === proposal.id);
  const dueAt = proposal.dueAt === undefined ? undefined : validateDate(proposal.dueAt, 'Proposal due time');
  const lines = [
    `Title: ${proposal.title}`, proposal.body ? `Body: ${proposal.body}` : '', ...(dueAt ? [`Due: ${dueAt}`] : []),
    ...(proposal.email ? [`Subject: ${proposal.email.subject}`, `To: ${proposal.email.to.join(', ')}`, `Cc: ${proposal.email.cc.join(', ')}`, `Bcc: ${proposal.email.bcc.join(', ')}`, `Email body: ${proposal.email.text}`] : []),
    ...(proposal.event ? [`Event: ${proposal.event.title ?? proposal.title}`, `Start: ${proposal.event.start}`, `End: ${proposal.event.end}`, `Time zone: ${proposal.event.timeZone}`, `Attendees: ${proposal.event.attendees.join(', ')}`, `Description: ${proposal.event.description ?? ''}`] : []),
  ].filter(Boolean);
  return { kind: 'proposal', sourceId: `proposal:${proposal.id}`, ...(proposal.noteId ? { sourceNoteId: proposal.noteId } : {}),
    title: 'Saved suggestion — imported history', content: lines.join('\n\n'),
    status: `${proposal.status} (unverified imported history)${activityItem?.createdAt || proposal.remoteAcceptedAt ? '' : ' — Original time unavailable'}`,
    ...(activityItem?.createdAt || proposal.remoteAcceptedAt ? { occurredAt: activityItem?.createdAt ?? proposal.remoteAcceptedAt } : {}),
    ...(proposal.remoteId ? { reference: proposal.remoteId } : {}) };
}
function analysisHistory(note: AppState['notes'][number]): PortableHistoryEntry[] {
  const analysis: NoteAssistResult | undefined = note.analysis;
  if (!analysis) return [];
  const values: [string, string][] = [
    ['summary', analysis.summary], ['answer', analysis.answer],
    ['decisions', analysis.decisions.map((d) => `${d.text}\n${d.quote}`).join('\n\n')],
    ['citations', analysis.citations.map((c) => `${c.source}\n${c.quote}`).join('\n\n')],
    ['clarifications', analysis.clarifications.join('\n')],
  ];
  return values.filter(([, content]) => Boolean(content)).map(([section, content]) => ({ kind: 'analysis', sourceId: `analysis:${note.id}:${section}`, sourceNoteId: note.id,
    title: `${section[0].toUpperCase()}${section.slice(1)} — imported analysis`, content,
    status: `Unverified historical result${analysis.analyzedAt ? '' : ' — Original time unavailable'}`,
    ...(analysis.analyzedAt ? { occurredAt: analysis.analyzedAt } : {}) }));
}

/** Build an allowlisted DTO. Runtime-only fields and authority are deliberately not projected. */
export function createPortableBackup(state: AppState, metadata: PortableBackupMetadata): PortableBackupV3 {
  const history: PortableHistoryEntry[] = [];
  const currentNoteIds = new Set(state.notes.map((note) => note.id));
  const stateKnowledge = (state as AppState & { knowledge?: KnowledgeState }).knowledge ?? emptyKnowledgeState();
  const stateDocuments = (state as AppState & { documents: PortableDocument[] }).documents;
  const backup: PortableBackupV3 = {
    format: PORTABLE_BACKUP_FORMAT, schemaVersion: PORTABLE_BACKUP_SCHEMA_VERSION,
    exportId: validateId(metadata.exportId, 'Backup export ID'), exportedAt: validateDate(metadata.exportedAt, 'Backup export time'), audioIncluded: false,
    notes: state.notes.map((note) => {
      const importOrigin = (note as typeof note & { importOrigin?: { audioMissing?: boolean; originalTimeZoneUnknown?: boolean } }).importOrigin;
      const originalTimeZoneUnknown = importOrigin?.originalTimeZoneUnknown === true;
      return { sourceId: note.id, title: note.title, transcript: note.transcript, durationSeconds: note.durationSeconds,
        createdAt: note.createdAt, ...(note.capturedAt ? { capturedAt: note.capturedAt } : {}),
        ...(!originalTimeZoneUnknown && note.captureTimeZone ? { captureTimeZone: note.captureTimeZone } : {}),
        ...(originalTimeZoneUnknown ? { originalTimeZoneUnknown: true as const } : {}),
        ...(note.audioUri || importOrigin?.audioMissing ? { audioMissing: true as const } : {}) };
    }),
    tasks: state.tasks.map((task) => {
      const sourceNoteId = task.sourceNoteId && currentNoteIds.has(task.sourceNoteId) ? task.sourceNoteId : undefined;
      const importOrigin = task.importOrigin;
      const unresolvedSourceNoteId = sourceNoteId ? undefined : importOrigin?.originalSourceNoteId ?? task.sourceNoteId;
      return { sourceId: task.id, title: task.title, body: task.body, status: task.status, createdAt: task.createdAt,
        ...(task.completedAt ? { completedAt: task.completedAt } : {}), ...(task.dueAt ? { dueAt: task.dueAt } : {}),
        ...(sourceNoteId ? { sourceNoteId } : {}), ...(unresolvedSourceNoteId ? { unresolvedSourceNoteId } : {}) };
    }),
    documents: state.documents.map(({ path, content, revision, updatedAt }) => ({ path, content, revision, updatedAt })),
    archivedDocuments: [], knowledge: createPortableKnowledge(stateKnowledge, stateDocuments), archivedKnowledge: [],
    history,
  };
  for (const note of state.notes) history.push(...analysisHistory(note));
  for (const proposal of state.proposals) history.push(proposalHistory(proposal, state.activity));
  for (const reminder of state.reminders?.records ?? []) history.push({ kind: 'proposal', sourceId: `reminder:${reminder.id}`,
    title: 'Reminder — imported history',
    content: [`Title: ${reminder.title}`, `Details: ${reminder.body}`, `Due: ${reminder.dueAt}`, `Display time zone: ${reminder.displayTimeZone}`].join('\n'),
    status: `${reminder.status} (unverified imported history)`, ...(reminder.createdAt ? { occurredAt: reminder.createdAt } : {}) });
  for (const attempt of state.transcription?.attempts ?? []) history.push({ kind: 'activity', sourceId: `transcription:${attempt.id}`,
    ...(currentNoteIds.has(attempt.noteId) ? { sourceNoteId: attempt.noteId } : {}), title: 'Voice transcription — imported history',
    content: [attempt.durationMilliseconds ? `Provider duration: ${attempt.durationMilliseconds} ms` : '', attempt.billedEstimateSeconds ? `Estimated billed duration: ${attempt.billedEstimateSeconds} seconds` : ''].filter(Boolean).join('\n'),
    status: `${attempt.outcome} (unverified imported transcription history)`, occurredAt: attempt.terminalAt ?? attempt.createdAt });
  for (const record of state.dispatchRecords) {
    const payload = record.payload.kind === 'email'
      ? [`Subject: ${record.payload.email.subject}`, `To: ${record.payload.email.to.join(', ')}`, `Cc: ${record.payload.email.cc.join(', ')}`, `Bcc: ${record.payload.email.bcc.join(', ')}`, `Email body: ${record.payload.email.text}`]
      : [`Event: ${record.payload.event.title ?? record.title}`, `Start: ${record.payload.event.start}`, `End: ${record.payload.event.end}`, `Time zone: ${record.payload.event.timeZone}`, `Attendees: ${record.payload.event.attendees.join(', ')}`, `Description: ${record.payload.event.description ?? ''}`];
    history.push({ kind: 'dispatch', sourceId: `dispatch:${record.id}`, title: 'External action — imported history',
    content: [`Title: ${record.title}`, `Body: ${record.body}`, ...payload,
      ...record.reconciliations.map((item) => `Reconciliation (${item.disposition}): ${item.note}`)].filter(Boolean).join('\n\n'),
    status: `${record.outcome} (unverified imported history)`, occurredAt: record.dispatchStartedAt, provider: record.account.provider,
    ...(record.remoteId ? { reference: record.remoteId } : {}) });
  }
  for (const record of state.deviceCalendars.dispatchRecords) {
    history.push({ kind: 'dispatch', sourceId: `device-dispatch:${record.id}`, title: 'On-device calendar action — imported history',
      content: [`Event: ${record.payload.title}`, `Start: ${record.payload.start}`, `End: ${record.payload.end}`, `Time zone: ${record.payload.timeZone}`,
        ...(record.payload.notes ? [`Description: ${record.payload.notes}`] : []),
        ...record.reconciliations.map((item) => `Reconciliation (${item.disposition}): ${item.note}`)].join('\n\n'),
      status: `${record.outcome} (unverified imported device history)`, occurredAt: record.claimAt, provider: 'on-device calendar' });
  }
  for (const message of state.mailbox) history.push({ kind: 'mail', sourceId: `mail:${message.id}`, title: 'Mail item — imported history',
    content: [`Subject: ${message.subject ?? ''}`, `From: ${message.from ?? ''}`, `Sender: ${message.senderEmail ?? ''}`, `To: ${(message.to ?? []).join(', ')}`, `Cc: ${(message.cc ?? []).join(', ')}`, `Received: ${message.receivedAt ?? ''}`, `Snippet: ${message.snippet ?? ''}`].filter(Boolean).join('\n'), status: `Imported mailbox snapshot; unverified${message.observedAt ? '' : ' — Original time unavailable'}`,
    ...(message.observedAt ? { occurredAt: message.observedAt } : {}),
    provider: 'mail provider', reference: message.providerMessageId });
  for (const cache of state.selectedMailTexts) if (cache.text) history.push({ kind: 'mail', sourceId: `mail-text:${cache.messageId}`, title: 'Selected mail text — imported history',
    content: cache.text, status: 'Imported cached text; unverified', occurredAt: cache.checkedAt, provider: 'mail provider' });
  for (const event of state.calendarEvents) history.push({ kind: 'calendar', sourceId: `calendar:${event.id}`, title: 'Calendar event — imported history',
    content: (() => {
      const details = event as typeof event & { location?: string; description?: string; allDay?: boolean; isAllDay?: boolean; cancelled?: boolean; isCancelled?: boolean };
      return [`Subject: ${event.subject ?? ''}`, `Start: ${event.start ?? ''}`, `End: ${event.end ?? ''}`, `Time zone: ${event.timeZone ?? ''}`,
        `Location: ${details.location ?? ''}`, `Description: ${details.description ?? ''}`,
        `Cancelled: ${typeof details.cancelled === 'boolean' ? (details.cancelled ? 'yes' : 'no') : typeof details.isCancelled === 'boolean' ? (details.isCancelled ? 'yes' : 'no') : event.providerDeletedAt ? 'yes' : 'unknown'}`,
        `All day: ${typeof details.allDay === 'boolean' ? (details.allDay ? 'yes' : 'no') : typeof details.isAllDay === 'boolean' ? (details.isAllDay ? 'yes' : 'no') : 'unknown'}`].filter((line) => !line.endsWith(': ')).join('\n');
    })(),
    status: `Imported calendar snapshot; unverified${event.observedAt ? '' : ' — Original time unavailable'}`, ...(event.observedAt ? { occurredAt: event.observedAt } : {}), provider: 'calendar provider', reference: event.providerEventId });
  for (const item of state.activity) history.push({ kind: 'activity', sourceId: `activity:${item.id}`, ...(item.noteId ? { sourceNoteId: item.noteId } : {}),
    title: 'Activity — imported history', content: item.message, status: item.type, occurredAt: item.createdAt });
  const archives = (state as AppState & { importedBackups?: ImportedBackupArchive[] }).importedBackups;
  if (Array.isArray(archives)) for (const archive of archives) {
    for (const document of archive.documents) backup.archivedDocuments.push({ sourceId: `archive:${archive.id}:doc:${document.id}`, path: document.path,
      content: document.content, revision: document.revision, updatedAt: document.updatedAt });
    for (const item of archive.history) history.push({ kind: item.kind, sourceId: `archive:${archive.id}:history:${item.id}`,
      ...((item.localNoteId ?? item.sourceNoteId) ? { sourceNoteId: item.localNoteId ?? item.sourceNoteId } : {}), title: item.title, content: item.content, status: item.status,
      ...(item.occurredAt ? { occurredAt: item.occurredAt } : {}),
      ...(item.provider ? { provider: item.provider } : {}), ...(item.reference ? { reference: item.reference } : {}) });
    for (const cohort of archive.archivedKnowledge ?? []) backup.archivedKnowledge.push({ sourceId: `archive:${archive.id}:knowledge:${cohort.id}`,
      knowledge: createPortableKnowledge(cohort.knowledge.state, cohort.knowledge.narratives.map((narrative) => {
        const entity = narrative.entityKind === 'person' ? cohort.knowledge.state.people.find((person) => person.id === narrative.entityId) : cohort.knowledge.state.projects.find((project) => project.id === narrative.entityId);
        return { path: entity?.narrativePath ?? '', content: narrative.content, revision: narrative.revision, updatedAt: narrative.updatedAt };
      }), true) });
  }
  return normalizeV3(backup);
}

/** Canonical content string for an idempotency digest; excludes export identity and time. */
export function canonicalPortableContent(backup: PortableBackupV3): string {
  const normalized = normalizeV3(backup);
  return JSON.stringify({ format: normalized.format, schemaVersion: normalized.schemaVersion, audioIncluded: false,
    notes: [...normalized.notes].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    tasks: [...normalized.tasks].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    documents: [...normalized.documents].sort((a, b) => a.path.localeCompare(b.path)),
    archivedDocuments: [...normalized.archivedDocuments].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    history: [...normalized.history].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    knowledge: normalized.knowledge,
    archivedKnowledge: [...normalized.archivedKnowledge].sort((a, b) => a.sourceId.localeCompare(b.sourceId)) });
}

/** Legacy canonical bytes used only to recover content hashes written by v2 archives. */
export function legacyCanonicalPortableContentV2(backup: PortableBackupV3): string | undefined {
  const normalized = normalizeV3(backup);
  if (hasKnowledge(normalized.knowledge) || normalized.archivedKnowledge.length > 0) return undefined;
  return JSON.stringify({ format: V2_FORMAT, schemaVersion: V2_SCHEMA_VERSION, audioIncluded: false,
    notes: [...normalized.notes].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    tasks: [...normalized.tasks].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    documents: [...normalized.documents].sort((a, b) => a.path.localeCompare(b.path)),
    archivedDocuments: [...normalized.archivedDocuments].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    history: [...normalized.history].sort((a, b) => a.sourceId.localeCompare(b.sourceId)) });
}

export interface PortableBackupPreview {
  noteCount: number; taskCount: number; documentCount: number; archivedDocumentCount: number; historyCount: number;
  personCount: number; projectCount: number; knowledgeCohortCount: number;
  missingAudioCount: number; documentConflicts: { path: string; identical: boolean }[];
}

/** Content-only preview. Current documents are read-only inputs and are never changed here. */
export function summarizePortableBackup(backup: PortableBackupV3, currentDocuments: readonly Pick<PortableDocument, 'path' | 'content'>[] = []): PortableBackupPreview {
  const normalized = normalizeV3(backup);
  const current = new Map(currentDocuments.map((document) => [document.path.normalize('NFC').toLocaleLowerCase('en-US'), document]));
  const documentConflicts = normalized.documents.flatMap((document) => {
    const existing = current.get(document.path.normalize('NFC').toLocaleLowerCase('en-US'));
    return existing ? [{ path: document.path, identical: existing.path === document.path && existing.content === document.content }] : [];
  });
  return { noteCount: normalized.notes.length, taskCount: normalized.tasks.length, documentCount: normalized.documents.length + normalized.archivedDocuments.length,
    archivedDocumentCount: normalized.archivedDocuments.length, historyCount: normalized.history.length,
    personCount: normalized.knowledge.state.people.length + normalized.archivedKnowledge.reduce((total, cohort) => total + cohort.knowledge.state.people.length, 0),
    projectCount: normalized.knowledge.state.projects.length + normalized.archivedKnowledge.reduce((total, cohort) => total + cohort.knowledge.state.projects.length, 0),
    knowledgeCohortCount: normalized.archivedKnowledge.length + (hasKnowledge(normalized.knowledge) ? 1 : 0),
    missingAudioCount: normalized.notes.filter((note) => note.audioMissing).length, documentConflicts };
}
