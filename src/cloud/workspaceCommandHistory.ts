/** Closed public projection of durable workspace command history. */
export const WORKSPACE_COMMAND_HISTORY_PAGE_SIZE = 50;

export const WORKSPACE_COMMAND_HISTORY_KINDS = Object.freeze([
  'tasks.complete', 'tasks.reopen', 'chat.create', 'settings.update', 'notes.save', 'notes.capture.adopt',
  'notes.updateTranscript', 'assistant.batch.submitNote', 'assistant.batch.check', 'chat.submit', 'chat.refine',
  'notes.transcribe', 'accounts.installOAuth',
] as const);

export type WorkspaceCommandHistoryKind = (typeof WORKSPACE_COMMAND_HISTORY_KINDS)[number];
export type WorkspaceCommandHistoryStatus = 'claimed' | 'checkpointed' | 'finished' | 'inspect_required';

export interface WorkspaceCommandHistoryEntry {
  readonly commandId: string;
  readonly kind: WorkspaceCommandHistoryKind;
  readonly status: WorkspaceCommandHistoryStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkspaceCommandHistoryPage {
  readonly schemaVersion: 1;
  readonly entries: readonly WorkspaceCommandHistoryEntry[];
  readonly nextCursor?: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOURNAL_TO_PUBLIC: Readonly<Record<string, WorkspaceCommandHistoryKind>> = Object.freeze({
  'tasks.complete': 'tasks.complete', 'tasks.reopen': 'tasks.reopen', 'chat.create': 'chat.create', 'settings.update': 'settings.update', 'notes.save': 'notes.save',
  'notes.capture.adopt': 'notes.capture.adopt', 'notes.updatetranscript': 'notes.updateTranscript',
  'assistant.batch.submitnote': 'assistant.batch.submitNote', 'assistant.batch.check': 'assistant.batch.check',
  'chat.submit': 'chat.submit', 'chat.refine': 'chat.refine',
  'notes.transcribe': 'notes.transcribe',
  'accounts.installoauth': 'accounts.installOAuth',
});

function readPlainDataRecord(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('command_history_invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('command_history_invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('command_history_invalid');
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('command_history_invalid');
  }
  return value as Record<string, unknown>;
}

export function isWorkspaceCommandId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function workspaceCommandKindFromJournal(value: unknown): WorkspaceCommandHistoryKind | undefined {
  return typeof value === 'string' && Object.hasOwn(JOURNAL_TO_PUBLIC, value) ? JOURNAL_TO_PUBLIC[value] : undefined;
}

export function workspaceCommandKindToJournal(value: WorkspaceCommandHistoryKind): string {
  return value.toLowerCase();
}

export function parseWorkspaceCommandHistoryPage(value: unknown): WorkspaceCommandHistoryPage {
  const record = readPlainDataRecord(value, ['schemaVersion', 'entries', 'nextCursor'], ['schemaVersion', 'entries']);
  if (record.schemaVersion !== 1 || !Array.isArray(record.entries) || record.entries.length > WORKSPACE_COMMAND_HISTORY_PAGE_SIZE ||
      (Object.hasOwn(record, 'nextCursor') && (typeof record.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(record.nextCursor)))) {
    throw new Error('command_history_invalid');
  }
  if (Reflect.ownKeys(record.entries).some((key) => typeof key !== 'string' ||
      (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) || Object.keys(record.entries).length !== record.entries.length) {
    throw new Error('command_history_invalid');
  }
  const seen = new Set<string>();
  const entries: WorkspaceCommandHistoryEntry[] = [];
  for (let index = 0; index < record.entries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(record.entries, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('command_history_invalid');
    const row = readPlainDataRecord(descriptor.value, ['commandId', 'kind', 'status', 'createdAt', 'updatedAt'],
      ['commandId', 'kind', 'status', 'createdAt', 'updatedAt']);
    if (
        !isWorkspaceCommandId(row.commandId) || seen.has(row.commandId) ||
        !WORKSPACE_COMMAND_HISTORY_KINDS.includes(row.kind as WorkspaceCommandHistoryKind) ||
        !['claimed', 'checkpointed', 'finished', 'inspect_required'].includes(row.status as string) ||
        !Number.isSafeInteger(row.createdAt) || (row.createdAt as number) < 0 ||
        !Number.isSafeInteger(row.updatedAt) || (row.updatedAt as number) < 0) throw new Error('command_history_invalid');
    seen.add(row.commandId);
    const entry = Object.freeze({ commandId: row.commandId, kind: row.kind as WorkspaceCommandHistoryKind,
      status: row.status as WorkspaceCommandHistoryStatus, createdAt: row.createdAt as number, updatedAt: row.updatedAt as number });
    entries.push(entry);
  }
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries),
    ...(Object.hasOwn(record, 'nextCursor') ? { nextCursor: record.nextCursor as string } : {}) });
}
