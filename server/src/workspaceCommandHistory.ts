/** Server-side closed journal projection. Kept within the server compiler root. */
export const WORKSPACE_COMMAND_HISTORY_PAGE_SIZE = 50;
export const WORKSPACE_COMMAND_HISTORY_KINDS = Object.freeze([
  'tasks.complete', 'tasks.reopen', 'chat.create', 'settings.update', 'notes.save', 'notes.capture.adopt',
  'notes.updateTranscript', 'assistant.batch.submitNote', 'assistant.batch.check', 'chat.submit', 'chat.refine',
  'notes.transcribe', 'accounts.installOAuth',
] as const);
export type WorkspaceCommandHistoryKind = (typeof WORKSPACE_COMMAND_HISTORY_KINDS)[number];
export type WorkspaceCommandHistoryStatus = 'claimed' | 'checkpointed' | 'finished' | 'inspect_required';
export interface WorkspaceCommandHistoryEntry {
  readonly commandId: string; readonly kind: WorkspaceCommandHistoryKind; readonly status: WorkspaceCommandHistoryStatus;
  readonly createdAt: number; readonly updatedAt: number;
}
export interface WorkspaceCommandHistoryPage {
  readonly schemaVersion: 1; readonly entries: readonly WorkspaceCommandHistoryEntry[]; readonly nextCursor?: string;
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
export function isWorkspaceCommandId(value: unknown): value is string { return typeof value === 'string' && UUID_V4.test(value); }
export function workspaceCommandKindFromJournal(value: unknown): WorkspaceCommandHistoryKind | undefined {
  return typeof value === 'string' && Object.hasOwn(JOURNAL_TO_PUBLIC, value) ? JOURNAL_TO_PUBLIC[value] : undefined;
}
export function workspaceCommandKindToJournal(value: WorkspaceCommandHistoryKind): string { return value.toLowerCase(); }
