import type { AppState, NoteAssistResult, Proposal } from '../core';

export const PORTABLE_BACKUP_FORMAT = 'still-backup-v2' as const;
export const PORTABLE_BACKUP_SCHEMA_VERSION = 2 as const;

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
  format: typeof PORTABLE_BACKUP_FORMAT;
  schemaVersion: typeof PORTABLE_BACKUP_SCHEMA_VERSION;
  exportId: string;
  exportedAt: string;
  audioIncluded: false;
  notes: PortableNote[];
  tasks: PortableTask[];
  documents: PortableDocument[];
  archivedDocuments: PortableArchivedDocument[];
  history: PortableHistoryEntry[];
}

export interface ImportedBackupArchive {
  id: string;
  contentHash: string;
  fileHash: string;
  sourceFormat: typeof PORTABLE_BACKUP_FORMAT | 'voice-assistant-export-v1';
  exportedAt: string;
  importedAt: string;
  noteLinks: { sourceId: string; noteId: string }[];
  taskLinks: { sourceId: string; taskId: string }[];
  documents: (PortableDocument & { id: string; activatedPath?: string; activatedAt?: string })[];
  history: (PortableHistoryEntry & { id: string; localNoteId?: string })[];
}

export interface PortableBackupParseResult {
  backup: PortableBackupV2;
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

function normalizeV2(value: unknown): PortableBackupV2 {
  if (!isRecord(value)) fail('Backup must be a JSON object.');
  ownKeys(value, ['format', 'schemaVersion', 'exportId', 'exportedAt', 'audioIncluded', 'notes', 'tasks', 'documents', 'archivedDocuments', 'history'], 'Backup');
  if (value.format !== PORTABLE_BACKUP_FORMAT || value.schemaVersion !== PORTABLE_BACKUP_SCHEMA_VERSION) fail('Backup format or schema version is not supported.');
  if (value.audioIncluded !== false) fail('Backup audioIncluded must be false for this format.');
  const backup: PortableBackupV2 = {
    format: PORTABLE_BACKUP_FORMAT,
    schemaVersion: PORTABLE_BACKUP_SCHEMA_VERSION,
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
  let totalText = 0;
  const add = (text: string) => { totalText += utf8Length(text); if (totalText > BACKUP_LIMITS.maxRestoredTextBytes) fail('Backup text exceeds the total restore limit.'); };
  for (const note of backup.notes) { add(note.title); add(note.transcript); }
  for (const task of backup.tasks) { add(task.title); add(task.body); }
  for (const document of backup.documents) add(document.content);
  for (const document of backup.archivedDocuments) add(document.content);
  for (const entry of backup.history) { add(entry.title); add(entry.content); add(entry.status); }
  return backup;
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
  const backup: PortableBackupV2 = { format: PORTABLE_BACKUP_FORMAT, schemaVersion: PORTABLE_BACKUP_SCHEMA_VERSION,
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

/** Parse and strictly validate a v2 portable backup or adapt the exact legacy export marker. */
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
    return { ...migrated, warnings, migratedFromV1: true };
  }
  if (raw.format !== PORTABLE_BACKUP_FORMAT) fail('Backup format or schema version is not supported.');
  const backup = normalizeV2(raw);
  return { backup, warnings: [AUTHORITY_WARNING, AUDIO_WARNING], ignoredFieldCount: 0, migratedFromV1: false };
}

/** Fail-closed validator for the inert archive persisted by the controller. */
export function validateImportedBackupArchive(value: unknown): ImportedBackupArchive | undefined {
  try {
    if (!isRecord(value)) return undefined;
    ownKeys(value, ['id', 'contentHash', 'fileHash', 'sourceFormat', 'exportedAt', 'importedAt', 'noteLinks', 'taskLinks', 'documents', 'history'], 'Imported archive');
    const id = validateId(value.id, 'Imported archive ID');
    for (const key of ['contentHash', 'fileHash'] as const) if (typeof value[key] !== 'string' || !/^[a-f\d]{64}$/i.test(value[key] as string)) return undefined;
    if (value.sourceFormat !== PORTABLE_BACKUP_FORMAT && value.sourceFormat !== 'voice-assistant-export-v1') return undefined;
    const noteLinksRaw = arrayField(value.noteLinks, BACKUP_LIMITS.notes, 'Archive note links');
    const taskLinksRaw = arrayField(value.taskLinks, BACKUP_LIMITS.tasks, 'Archive task links');
    const docsRaw = arrayField(value.documents, BACKUP_LIMITS.documents, 'Archive documents');
    const historyRaw = arrayField(value.history, BACKUP_LIMITS.history, 'Archive history');
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
      const entry = normalizeV2({ format: PORTABLE_BACKUP_FORMAT, schemaVersion: 2, exportId: id, exportedAt: value.exportedAt,
        audioIncluded: false, notes: [], tasks: [], documents: [], archivedDocuments: [], history: [{
          kind: row.kind, sourceId: row.sourceId, ...(row.sourceNoteId !== undefined ? { sourceNoteId: row.sourceNoteId } : {}),
          title: row.title, content: row.content, status: row.status, ...(row.occurredAt !== undefined ? { occurredAt: row.occurredAt } : {}),
          ...(row.provider !== undefined ? { provider: row.provider } : {}), ...(row.reference !== undefined ? { reference: row.reference } : {}),
        }] }).history[0]!;
      return { ...entry, id: validateId(row.id, 'Archive history ID'), ...(row.localNoteId !== undefined ? { localNoteId: validateId(row.localNoteId, 'Archive history local note ID') } : {}) };
    });
    duplicateIds(history, 'Archive history');
    if (new Set(history.map((entry) => entry.id)).size !== history.length) fail('Archive history contains duplicate local IDs.');
    let restoredTextBytes = 0;
    for (const document of documents) restoredTextBytes += utf8Length(document.content);
    for (const entry of history) restoredTextBytes += utf8Length(entry.title) + utf8Length(entry.content) + utf8Length(entry.status);
    if (restoredTextBytes > BACKUP_LIMITS.maxRestoredTextBytes) return undefined;
    return { id, contentHash: value.contentHash as string, fileHash: value.fileHash as string,
      sourceFormat: value.sourceFormat, exportedAt: validateDate(value.exportedAt, 'Archive export time'), importedAt: validateDate(value.importedAt, 'Archive import time'),
      noteLinks, taskLinks, documents, history };
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
export function createPortableBackup(state: AppState, metadata: PortableBackupMetadata): PortableBackupV2 {
  const history: PortableHistoryEntry[] = [];
  const currentNoteIds = new Set(state.notes.map((note) => note.id));
  const backup: PortableBackupV2 = {
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
    archivedDocuments: [],
    history,
  };
  for (const note of state.notes) history.push(...analysisHistory(note));
  for (const proposal of state.proposals) history.push(proposalHistory(proposal, state.activity));
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
  }
  return normalizeV2(backup);
}

/** Canonical content string for an idempotency digest; excludes export identity and time. */
export function canonicalPortableContent(backup: PortableBackupV2): string {
  const normalized = normalizeV2(backup);
  return JSON.stringify({ format: normalized.format, schemaVersion: normalized.schemaVersion, audioIncluded: false,
    notes: [...normalized.notes].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    tasks: [...normalized.tasks].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    documents: [...normalized.documents].sort((a, b) => a.path.localeCompare(b.path)),
    archivedDocuments: [...normalized.archivedDocuments].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    history: [...normalized.history].sort((a, b) => a.sourceId.localeCompare(b.sourceId)) });
}

export interface PortableBackupPreview {
  noteCount: number; taskCount: number; documentCount: number; archivedDocumentCount: number; historyCount: number;
  missingAudioCount: number; documentConflicts: { path: string; identical: boolean }[];
}

/** Content-only preview. Current documents are read-only inputs and are never changed here. */
export function summarizePortableBackup(backup: PortableBackupV2, currentDocuments: readonly Pick<PortableDocument, 'path' | 'content'>[] = []): PortableBackupPreview {
  const current = new Map(currentDocuments.map((document) => [document.path.normalize('NFC').toLocaleLowerCase('en-US'), document]));
  const documentConflicts = backup.documents.flatMap((document) => {
    const existing = current.get(document.path.normalize('NFC').toLocaleLowerCase('en-US'));
    return existing ? [{ path: document.path, identical: existing.path === document.path && existing.content === document.content }] : [];
  });
  return { noteCount: backup.notes.length, taskCount: backup.tasks.length, documentCount: backup.documents.length + backup.archivedDocuments.length,
    archivedDocumentCount: backup.archivedDocuments.length, historyCount: backup.history.length,
    missingAudioCount: backup.notes.filter((note) => note.audioMissing).length, documentConflicts };
}
