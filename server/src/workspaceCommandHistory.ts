/** Server-side closed journal projection. Kept within the server compiler root. */
export const WORKSPACE_COMMAND_HISTORY_PAGE_SIZE = 50;
export const WORKSPACE_COMMAND_HISTORY_KINDS = Object.freeze([
  'tasks.complete', 'tasks.reopen', 'chat.create', 'settings.update', 'notes.save', 'notes.capture.adopt',
  'notes.updateTranscript', 'assistant.batch.submitNote', 'assistant.batch.check', 'chat.submit', 'chat.refine',
  'notes.transcribe', 'accounts.installOAuth', 'accounts.syncCalendars', 'accounts.refreshMail', 'accounts.continueMailBackfill', 'accounts.disconnect',
  'mail.source.loadText', 'mail.reply.create', 'proposals.edit', 'proposals.approve', 'proposals.execute', 'proposals.dismiss', 'dispatch.reconcile',
  'mail.replyBatch.submit', 'mail.replyBatch.check', 'mail.replyBatch.review', 'mail.replyBatch.activate',
  'documents.save', 'knowledge.person.save', 'knowledge.project.save',
  'knowledge.entity.archive', 'knowledge.fact.save', 'knowledge.fact.remove', 'knowledge.contact.save', 'knowledge.contact.remove',
  'knowledge.member.save', 'knowledge.member.remove',
  'knowledge.sourceLink.save', 'knowledge.sourceLink.remove', 'knowledge.suggestion.edit', 'knowledge.suggestion.review',
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
  'accounts.synccalendars': 'accounts.syncCalendars', 'accounts.refreshmail': 'accounts.refreshMail',
  'accounts.continuemailbackfill': 'accounts.continueMailBackfill', 'accounts.disconnect': 'accounts.disconnect',
  'mail.source.loadtext': 'mail.source.loadText', 'mail.reply.create': 'mail.reply.create',
  'proposals.edit': 'proposals.edit', 'proposals.approve': 'proposals.approve', 'proposals.execute': 'proposals.execute', 'proposals.dismiss': 'proposals.dismiss',
  'dispatch.reconcile': 'dispatch.reconcile', 'mail.replybatch.submit': 'mail.replyBatch.submit', 'mail.replybatch.check': 'mail.replyBatch.check',
  'mail.replybatch.review': 'mail.replyBatch.review', 'mail.replybatch.activate': 'mail.replyBatch.activate',
  'documents.save': 'documents.save', 'knowledge.person.save': 'knowledge.person.save', 'knowledge.project.save': 'knowledge.project.save',
  'knowledge.entity.archive': 'knowledge.entity.archive', 'knowledge.fact.save': 'knowledge.fact.save', 'knowledge.fact.remove': 'knowledge.fact.remove',
  'knowledge.contact.save': 'knowledge.contact.save', 'knowledge.contact.remove': 'knowledge.contact.remove',
  'knowledge.member.save': 'knowledge.member.save', 'knowledge.member.remove': 'knowledge.member.remove',
  'knowledge.sourcelink.save': 'knowledge.sourceLink.save', 'knowledge.sourcelink.remove': 'knowledge.sourceLink.remove',
  'knowledge.suggestion.edit': 'knowledge.suggestion.edit', 'knowledge.suggestion.review': 'knowledge.suggestion.review',
});
export function isWorkspaceCommandId(value: unknown): value is string { return typeof value === 'string' && UUID_V4.test(value); }
export function workspaceCommandKindFromJournal(value: unknown): WorkspaceCommandHistoryKind | undefined {
  return typeof value === 'string' && Object.hasOwn(JOURNAL_TO_PUBLIC, value) ? JOURNAL_TO_PUBLIC[value] : undefined;
}
export function workspaceCommandKindToJournal(value: WorkspaceCommandHistoryKind): string { return value.toLowerCase(); }
