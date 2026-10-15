import type { AssistIntent, SavePersonInput, SaveProjectInput } from '../core';
import type { KnowledgeChange, KnowledgeEntityKind, KnowledgeEvidence } from '../knowledge/types';
import { isCanonicalKnowledgeId, KNOWLEDGE_LIMITS } from '../knowledge';
import { safeRelativeMarkdownPath } from '../privacy/eraseAdapter.shared';
import type { WorkspaceSnapshotDTO } from './workspaceDto';
import { validateAzureEndpoint } from '../services/controllerRuntimeContracts';

export const WORKSPACE_COMMAND_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_COMMAND_MAX_BYTES = 16 * 1024;
export const WORKSPACE_TEXT_COMMAND_MAX_BYTES = 1024 * 1024;
const MAX_ID_BYTES = 1024;
const MAX_NESTING_DEPTH = 32;
type PersonCreateInput = Readonly<Omit<Pick<SavePersonInput, 'name' | 'aliases' | 'narrative'>, 'aliases'> & { aliases: readonly string[] }>;
type PersonUpdateInput = Readonly<Omit<SavePersonInput, 'id' | 'expectedRevision' | 'aliases' | 'expectedDocumentRevision'> & {
  id: string; expectedRevision: number; aliases: readonly string[]; expectedDocumentRevision: number | null }>;
type ProjectCreateInput = Readonly<Omit<Pick<SaveProjectInput, 'name' | 'aliases' | 'narrative' | 'status' | 'goal' | 'startsOn' | 'targetOn' | 'dateTimeZone'>, 'aliases'> & { aliases: readonly string[] }>;
type ProjectUpdateInput = Readonly<Omit<SaveProjectInput, 'id' | 'expectedRevision' | 'aliases' | 'expectedDocumentRevision'> & {
  id: string; expectedRevision: number; aliases: readonly string[]; expectedDocumentRevision: number | null }>;

export type WorkspaceCommand =
  | { readonly kind: 'settings.update'; readonly patch: WorkspaceSettingsPatch }
  | { readonly kind: 'tasks.complete'; readonly taskId: string }
  | { readonly kind: 'tasks.reopen'; readonly taskId: string }
  | { readonly kind: 'chat.create'; readonly title?: string }
  | { readonly kind: 'chat.conversation.delete'; readonly conversationId: string }
  | { readonly kind: 'notes.confirmImportedTimeZone'; readonly noteId: string; readonly expectedNoteRevision: number; readonly timeZone: string }
  | { readonly kind: 'chat.transcript.prepare'; readonly noteId: string; readonly expectedNoteRevision: number }
  | { readonly kind: 'chat.transcript.cancel'; readonly planId: string }
  | { readonly kind: 'chat.transcript.submit'; readonly planId: string; readonly conversationId: string }
  | { readonly kind: 'notes.save'; readonly transcript: string }
  | { readonly kind: 'notes.capture.adopt'; readonly captureId: string; readonly captureRevision: string }
  | { readonly kind: 'accounts.installOAuth'; readonly stageId: string }
  | { readonly kind: 'accounts.syncCalendars'; readonly accountId: string; readonly expectedConnectionGeneration: number; readonly continue?: boolean }
  | { readonly kind: 'accounts.refreshMail' | 'accounts.continueMailBackfill' | 'accounts.disconnect'; readonly accountId: string; readonly expectedConnectionGeneration: number }
  | { readonly kind: 'mail.source.loadText'; readonly messageId: string; readonly accountId: string; readonly expectedConnectionGeneration: number; readonly sourceDigest: string }
  | { readonly kind: 'mail.reply.create'; readonly messageId: string; readonly accountId: string; readonly expectedConnectionGeneration: number;
      readonly sourceDigest: string; readonly mode: 'reply' | 'reply_all'; readonly text: string; readonly to: readonly string[]; readonly cc: readonly string[] }
  | { readonly kind: 'mail.reply.derive'; readonly parentProposalId: string; readonly expectedParentRevision: number;
      readonly accountId: string; readonly expectedConnectionGeneration: number; readonly operation: 'draft' | 'send' }
  | { readonly kind: 'mail.reply.promoteDraft'; readonly parentProposalId: string; readonly expectedParentRevision: number;
      readonly draftDispatchRecordId: string; readonly accountId: string; readonly expectedConnectionGeneration: number }
  | { readonly kind: 'proposals.edit'; readonly proposalId: string; readonly expectedProposalRevision: number; readonly accountId: string;
      readonly expectedConnectionGeneration: number; readonly edit: CloudProposalEdit }
  | { readonly kind: 'proposals.approve' | 'proposals.execute' | 'proposals.dismiss'; readonly proposalId: string; readonly expectedProposalRevision: number }
  | { readonly kind: 'dispatch.reconcile'; readonly recordId: string; readonly expectedRecordVersion: string;
      readonly disposition: import('../dispatch').DispatchReconciliation; readonly note: string; readonly remoteId?: string }
  | { readonly kind: 'mail.replyBatch.submit'; readonly messageId: string; readonly accountId: string; readonly expectedConnectionGeneration: number;
      readonly sourceDigest: string; readonly textDigest: string; readonly mode: 'reply' | 'reply_all'; readonly to: readonly string[]; readonly cc: readonly string[];
      readonly brief: string; readonly composerRevision: number; readonly noteId?: string; readonly noteRevision?: number;
      readonly contextSelectionIds?: readonly string[]; readonly contextExcerptSelectionIds?: readonly string[] }
  | { readonly kind: 'mail.replyBatch.check'; readonly jobId: string; readonly accountId: string; readonly expectedConnectionGeneration: number }
  | { readonly kind: 'mail.replyBatch.review'; readonly jobId: string; readonly accountId: string; readonly expectedConnectionGeneration: number; readonly operation: 'draft' | 'send' }
  | { readonly kind: 'mail.replyBatch.activate'; readonly planId: string; readonly jobId: string; readonly accountId: string; readonly expectedConnectionGeneration: number }
  | { readonly kind: 'documents.save'; readonly path: string; readonly content: string; readonly expectedRevision: number | null; readonly expectedEntityRevision?: number }
  | { readonly kind: 'knowledge.person.save'; readonly operation: 'create'; readonly input: Readonly<PersonCreateInput> }
  | { readonly kind: 'knowledge.person.save'; readonly operation: 'update'; readonly input: Readonly<PersonUpdateInput> }
  | { readonly kind: 'knowledge.project.save'; readonly operation: 'create'; readonly input: Readonly<ProjectCreateInput> }
  | { readonly kind: 'knowledge.project.save'; readonly operation: 'update'; readonly input: Readonly<ProjectUpdateInput> }
  | { readonly kind: 'knowledge.entity.archive'; readonly entityKind: KnowledgeEntityKind; readonly id: string; readonly expectedRevision: number; readonly archived: boolean }
  | { readonly kind: 'knowledge.fact.save'; readonly entityKind: KnowledgeEntityKind; readonly entityId: string; readonly expectedEntityRevision: number; readonly itemId?: string; readonly statement: string }
  | { readonly kind: 'knowledge.fact.remove'; readonly entityKind: KnowledgeEntityKind; readonly entityId: string; readonly expectedEntityRevision: number; readonly itemId: string }
  | { readonly kind: 'knowledge.contact.save'; readonly entityKind: 'person'; readonly entityId: string; readonly expectedEntityRevision: number; readonly itemId?: string; readonly address: string; readonly label: string }
  | { readonly kind: 'knowledge.contact.remove'; readonly entityKind: 'person'; readonly entityId: string; readonly expectedEntityRevision: number; readonly itemId: string }
  | { readonly kind: 'knowledge.member.save'; readonly entityKind: 'project'; readonly entityId: string; readonly expectedEntityRevision: number; readonly itemId?: string; readonly personId: string; readonly personRevision: number; readonly role: string }
  | { readonly kind: 'knowledge.member.remove'; readonly entityKind: 'project'; readonly entityId: string; readonly expectedEntityRevision: number; readonly itemId: string }
  | { readonly kind: 'knowledge.sourceLink.save'; readonly entityKind: KnowledgeEntityKind; readonly entityId: string; readonly expectedEntityRevision: number; readonly itemId?: string; readonly referenceChoiceId?: string; readonly label: string }
  | { readonly kind: 'knowledge.sourceLink.remove'; readonly entityKind: KnowledgeEntityKind; readonly entityId: string; readonly expectedEntityRevision: number; readonly itemId: string }
  | { readonly kind: 'knowledge.suggestion.edit'; readonly suggestionId: string; readonly expectedSuggestionRevision: number; readonly expectedTargetRevision: number; readonly expectedMemberPersonRevision?: number; readonly change: PublicKnowledgeChange; readonly evidence: readonly KnowledgeEvidence[] }
  | { readonly kind: 'knowledge.suggestion.review'; readonly suggestionId: string; readonly expectedSuggestionRevision: number; readonly decision: 'accept' | 'dismiss'; readonly targetRevision: number; readonly memberPersonRevision?: number }
  | { readonly kind: 'notes.updateTranscript'; readonly noteId: string; readonly text: string; readonly expectedNoteRevision: number }
  | { readonly kind: 'notes.transcribe'; readonly noteId: string; readonly expectedNoteRevision: number }
  | { readonly kind: 'assistant.batch.submitNote'; readonly noteId: string; readonly intent?: AssistIntent; readonly question?: string; readonly knowledgeSelection?: PublicKnowledgeSelection }
  | { readonly kind: 'assistant.batch.check'; readonly jobId: string }
  | { readonly kind: 'chat.submit'; readonly conversationId: string; readonly text: string; readonly knowledgeSelection?: PublicKnowledgeSelection }
  | { readonly kind: 'chat.refine'; readonly conversationId: string; readonly parentTurnId: string; readonly effort: 'medium' | 'high' | 'max' };

export type CloudProposalEdit =
  | Readonly<{ kind: 'email'; operation: 'draft' | 'send'; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; text: string }>
  | Readonly<{ kind: 'event'; calendarId: string; title: string; description: string; start: string; end: string; timeZone: string;
      attendees: readonly string[]; invitePolicy: 'send' | 'none' }>;

export type CloudDispatchOutcome = 'accepted' | 'unknown' | 'rejected';
export type CloudProposalExecutionResult = import('../core').ProposalExecutionForCommandResult;

export type PublicKnowledgeSelection = readonly Readonly<{ kind: 'person' | 'project'; id: string }>[];
export type PublicKnowledgeChange = Exclude<KnowledgeChange, { type: 'add_source_link' }> |
  (Omit<Extract<KnowledgeChange, { type: 'add_source_link' }>, 'reference'> & Readonly<{ referenceChoiceId: string }>);

/** Deliberately narrow public settings surface; provider credentials and request policy stay private. */
export type WorkspaceSettingsPatch = Readonly<{
  mode?: 'preview' | 'provider';
  speechEnabled?: boolean;
  speechProvider?: 'azure' | 'openrouter';
  speechEndpoint?: string;
  openRouterReasoningEffort?: 'none' | 'low';
  maxAudioSeconds?: number;
  audioRetention?: 'keep' | 'delete_after_transcription';
  timezone?: string;
}>;

export interface WorkspaceCommandEnvelope {
  readonly schemaVersion: typeof WORKSPACE_COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly expectedPrivacyEpoch: number;
  readonly command: WorkspaceCommand;
}

type WorkspaceCommandReceiptBase<K extends WorkspaceCommand['kind']> = Readonly<{
  schemaVersion: typeof WORKSPACE_COMMAND_SCHEMA_VERSION;
  commandId: string;
  kind: K;
  objectId: string;
}>;

export type WorkspaceCommandReceipt =
  | WorkspaceCommandReceiptBase<'tasks.complete'>
  | WorkspaceCommandReceiptBase<'tasks.reopen'>
  | WorkspaceCommandReceiptBase<'chat.create'>
  | (WorkspaceCommandReceiptBase<'chat.conversation.delete'> & Readonly<{ conversationId: string }>)
  | (WorkspaceCommandReceiptBase<'notes.confirmImportedTimeZone'> & Readonly<{ noteId: string; noteRevision: number; timeZone: string }>)
  | (WorkspaceCommandReceiptBase<'chat.transcript.prepare'> & Readonly<{ noteId: string; noteRevision: number; planId: string; expiresAt: string; capturedAt: string; captureTimeZone: string }>)
  | (WorkspaceCommandReceiptBase<'chat.transcript.cancel'> & Readonly<{ planId: string }>)
  | (WorkspaceCommandReceiptBase<'chat.transcript.submit'> & Readonly<{ planId: string; conversationId: string }> & (
      | Readonly<{ outcome: 'submitted'; turnId: string; jobId: string }>
      | Readonly<{ outcome: 'not_submitted'; reason: 'plan_unavailable' }>
      | Readonly<{ outcome?: undefined; turnId: string; jobId: string }>
    ))
  | WorkspaceCommandReceiptBase<'settings.update'>
  | WorkspaceCommandReceiptBase<'notes.save'>
  | (WorkspaceCommandReceiptBase<'notes.capture.adopt'> & Readonly<{ captureId: string; captureRevision: string }>)
  | (WorkspaceCommandReceiptBase<'accounts.installOAuth'> & Readonly<{ stageId: string; accountGeneration: number }>)
  | (WorkspaceCommandReceiptBase<'accounts.syncCalendars'> & Readonly<{ accountId: string; connectionGeneration: number; syncStatus: import('../core').AccountSyncState['status']; calendarsPartial: boolean }> )
  | (WorkspaceCommandReceiptBase<'accounts.refreshMail' | 'accounts.continueMailBackfill'> & Readonly<{ accountId: string; connectionGeneration: number; lane: 'head' | 'backfill'; laneStatus: import('../core').MailLaneResult['status']; syncStatus: import('../core').AccountSyncState['status'] }> )
  | (WorkspaceCommandReceiptBase<'accounts.disconnect'> & Readonly<{ accountId: string; connectionGeneration: number; connected: false; cleanup: 'complete' | 'pending' }> )
  | (WorkspaceCommandReceiptBase<'mail.source.loadText'> & Readonly<{ accountId: string; connectionGeneration: number; sourceDigest: string; loadStatus: import('../core').MailReplyTextLoadResult['status']; textDigest?: string; bytes?: number }> )
  | (WorkspaceCommandReceiptBase<'mail.reply.create'> & Readonly<{ proposalId: string; proposalRevision: number }> )
  | (WorkspaceCommandReceiptBase<'mail.reply.derive'> & Readonly<{ parentProposalId: string; proposalId: string; proposalRevision: number; operation: 'draft' | 'send' }> )
  | (WorkspaceCommandReceiptBase<'mail.reply.promoteDraft'> & Readonly<{ parentProposalId: string; draftDispatchRecordId: string;
      parentProposalRevision: number; childProposalId: string; childProposalRevision: number; accountId: string; connectionGeneration: number; operation: 'send' }> )
  | (WorkspaceCommandReceiptBase<'proposals.edit' | 'proposals.approve' | 'proposals.dismiss'> & Readonly<{ proposalId: string; proposalRevision: number; proposalStatus: import('../core').Proposal['status'] }> )
  | (WorkspaceCommandReceiptBase<'proposals.execute'> & Readonly<{ proposalId: string; proposalRevision: number; proposalStatus: import('../core').Proposal['status'];
      execution: 'accepted' | 'unknown' | 'rejected' | 'simulated' | 'executed' | 'failed' | 'invalidated'; dispatchRecordId?: string;
      operation?: 'draft' | 'send' | 'event'; outcomeAt?: string; remoteId?: string }> )
  | (WorkspaceCommandReceiptBase<'dispatch.reconcile'> & Readonly<{ recordId: string; recordVersion: string; disposition: import('../dispatch').DispatchReconciliation;
      providerOutcome: import('../dispatch').DispatchOutcome; providerOutcomeAt?: string }> )
  | (WorkspaceCommandReceiptBase<'mail.replyBatch.submit'> & Readonly<{ jobId: string; jobStatus: import('../services/openRouterBatchJobs').AssistantBatchJobDTO['status'] }> )
  | (WorkspaceCommandReceiptBase<'mail.replyBatch.check'> & Readonly<{ jobId: string; jobStatus: import('../services/openRouterBatchJobs').AssistantBatchJobDTO['status'] }> )
  | (WorkspaceCommandReceiptBase<'mail.replyBatch.review'> & Readonly<{ jobId: string; planId: string; expiresAt: string }> )
  | (WorkspaceCommandReceiptBase<'mail.replyBatch.activate'> & Readonly<{ jobId: string; proposalId: string }> )
  | (WorkspaceCommandReceiptBase<'documents.save'> & Readonly<{ documentRevision: number; entityKind?: KnowledgeEntityKind; entityId?: string; entityRevision?: number }>)
  | ((WorkspaceCommandReceiptBase<'knowledge.person.save'> | WorkspaceCommandReceiptBase<'knowledge.project.save'> |
      WorkspaceCommandReceiptBase<'knowledge.entity.archive'>) & Readonly<{ entityKind: KnowledgeEntityKind; entityRevision: number }>)
  | ((WorkspaceCommandReceiptBase<'knowledge.fact.save'> | WorkspaceCommandReceiptBase<'knowledge.fact.remove'> |
      WorkspaceCommandReceiptBase<'knowledge.contact.save'> | WorkspaceCommandReceiptBase<'knowledge.contact.remove'> |
      WorkspaceCommandReceiptBase<'knowledge.member.save'> | WorkspaceCommandReceiptBase<'knowledge.member.remove'> |
      WorkspaceCommandReceiptBase<'knowledge.sourceLink.save'> | WorkspaceCommandReceiptBase<'knowledge.sourceLink.remove'>) &
      Readonly<{ entityKind: KnowledgeEntityKind; entityRevision: number; itemId: string }>)
  | (WorkspaceCommandReceiptBase<'knowledge.suggestion.edit'> & Readonly<{ suggestionId: string; suggestionRevision: number; status: 'pending' }>)
  | (WorkspaceCommandReceiptBase<'knowledge.suggestion.review'> & Readonly<{ suggestionId: string; suggestionRevision: number; status: 'accepted' | 'dismissed' }>)
  | WorkspaceCommandReceiptBase<'notes.updateTranscript'>
  | (WorkspaceCommandReceiptBase<'notes.transcribe'> & Readonly<{ attemptId: string; sourceRevision: number; outcome: 'completed' | 'no_speech' | 'cancelled' | 'failed' | 'unknown' | 'discarded' }> )
  | (WorkspaceCommandReceiptBase<'assistant.batch.submitNote'> & Readonly<{ jobId: string }>)
  | WorkspaceCommandReceiptBase<'assistant.batch.check'>
  | (WorkspaceCommandReceiptBase<'chat.submit'> & Readonly<{ turnId: string; jobId: string }>)
  | (WorkspaceCommandReceiptBase<'chat.refine'> & Readonly<{ turnId: string; jobId: string; parentTurnId: string }>);

export type WorkspaceCommandStatus = 'finished' | 'claimed' | 'checkpointed' | 'inspect_required' | 'unverified';

export interface WorkspaceCommandResponse {
  readonly schemaVersion: typeof WORKSPACE_COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly status: WorkspaceCommandStatus;
  readonly receipt?: WorkspaceCommandReceipt;
  readonly snapshot?: WorkspaceSnapshotDTO;
}

const ENVELOPE_KEYS = ['command', 'commandId', 'expectedPrivacyEpoch', 'expectedRevision', 'schemaVersion'];
const COMMAND_KEYS: Record<WorkspaceCommand['kind'], readonly string[]> = {
  'settings.update': ['kind', 'patch'],
  'tasks.complete': ['kind', 'taskId'], 'tasks.reopen': ['kind', 'taskId'], 'chat.create': ['kind', 'title'],
  'chat.conversation.delete': ['kind', 'conversationId'],
  'notes.confirmImportedTimeZone': ['kind', 'noteId', 'expectedNoteRevision', 'timeZone'],
  'chat.transcript.prepare': ['kind', 'noteId', 'expectedNoteRevision'],
  'chat.transcript.cancel': ['kind', 'planId'],
  'chat.transcript.submit': ['kind', 'planId', 'conversationId'],
  'notes.save': ['kind', 'transcript'], 'notes.updateTranscript': ['kind', 'noteId', 'text', 'expectedNoteRevision'],
  'notes.capture.adopt': ['kind', 'captureId', 'captureRevision'],
  'accounts.installOAuth': ['kind', 'stageId'],
  'accounts.syncCalendars': ['kind', 'accountId', 'expectedConnectionGeneration', 'continue'],
  'accounts.refreshMail': ['kind', 'accountId', 'expectedConnectionGeneration'],
  'accounts.continueMailBackfill': ['kind', 'accountId', 'expectedConnectionGeneration'],
  'accounts.disconnect': ['kind', 'accountId', 'expectedConnectionGeneration'],
  'mail.source.loadText': ['kind', 'messageId', 'accountId', 'expectedConnectionGeneration', 'sourceDigest'],
  'mail.reply.create': ['kind', 'messageId', 'accountId', 'expectedConnectionGeneration', 'sourceDigest', 'mode', 'text', 'to', 'cc'],
  'mail.reply.derive': ['kind', 'parentProposalId', 'expectedParentRevision', 'accountId', 'expectedConnectionGeneration', 'operation'],
  'mail.reply.promoteDraft': ['kind', 'parentProposalId', 'expectedParentRevision', 'draftDispatchRecordId', 'accountId', 'expectedConnectionGeneration'],
  'proposals.edit': ['kind', 'proposalId', 'expectedProposalRevision', 'accountId', 'expectedConnectionGeneration', 'edit'],
  'proposals.approve': ['kind', 'proposalId', 'expectedProposalRevision'],
  'proposals.execute': ['kind', 'proposalId', 'expectedProposalRevision'],
  'proposals.dismiss': ['kind', 'proposalId', 'expectedProposalRevision'],
  'dispatch.reconcile': ['kind', 'recordId', 'expectedRecordVersion', 'disposition', 'note', 'remoteId'],
  'mail.replyBatch.submit': ['kind', 'messageId', 'accountId', 'expectedConnectionGeneration', 'sourceDigest', 'textDigest', 'mode', 'to', 'cc', 'brief', 'composerRevision', 'noteId', 'noteRevision', 'contextSelectionIds', 'contextExcerptSelectionIds'],
  'mail.replyBatch.check': ['kind', 'jobId', 'accountId', 'expectedConnectionGeneration'],
  'mail.replyBatch.review': ['kind', 'jobId', 'accountId', 'expectedConnectionGeneration', 'operation'],
  'mail.replyBatch.activate': ['kind', 'planId', 'jobId', 'accountId', 'expectedConnectionGeneration'],
  'documents.save': ['kind', 'path', 'content', 'expectedRevision', 'expectedEntityRevision'],
  'knowledge.person.save': ['kind', 'operation', 'input'], 'knowledge.project.save': ['kind', 'operation', 'input'],
  'knowledge.entity.archive': ['kind', 'entityKind', 'id', 'expectedRevision', 'archived'],
  'knowledge.fact.save': ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId', 'statement'],
  'knowledge.fact.remove': ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId'],
  'knowledge.contact.save': ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId', 'address', 'label'],
  'knowledge.contact.remove': ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId'],
  'knowledge.member.save': ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId', 'personId', 'personRevision', 'role'],
  'knowledge.member.remove': ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId'],
  'knowledge.sourceLink.save': ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId', 'referenceChoiceId', 'label'],
  'knowledge.sourceLink.remove': ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId'],
  'knowledge.suggestion.edit': ['kind', 'suggestionId', 'expectedSuggestionRevision', 'expectedTargetRevision', 'expectedMemberPersonRevision', 'change', 'evidence'],
  'knowledge.suggestion.review': ['kind', 'suggestionId', 'expectedSuggestionRevision', 'decision', 'targetRevision', 'memberPersonRevision'],
  'notes.transcribe': ['kind', 'noteId', 'expectedNoteRevision'],
  'assistant.batch.submitNote': ['kind', 'noteId', 'intent', 'question', 'knowledgeSelection'],
  'assistant.batch.check': ['kind', 'jobId'], 'chat.submit': ['kind', 'conversationId', 'text', 'knowledgeSelection'],
  'chat.refine': ['kind', 'conversationId', 'parentTurnId', 'effort'],
};
const COMMAND_KINDS = Object.keys(COMMAND_KEYS) as WorkspaceCommand['kind'][];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const isUuidV4 = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && UUID_V4.test(value);

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function parseWorkspaceCommandId(value: unknown): string {
  if (!isUuidV4(value)) throw new Error('workspace_command_id_invalid');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainDataProperties(value: Record<string, unknown>): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw new Error('workspace_command_invalid');
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('workspace_command_invalid');
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length > allowed.length ||
      keys.some((key) => !allowed.includes(key as string)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('workspace_command_invalid');
  }
  assertPlainDataProperties(value);
}

function jsonStringBytes(value: string, maxBytes: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error('workspace_command_invalid');
      bytes += 4; index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('workspace_command_invalid');
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
    if (bytes > maxBytes) throw new Error('workspace_command_invalid');
  }
  return bytes;
}

/** Descriptor-safe, incremental JSON size check before any clone or serialization. */
function preflightJsonBytes(value: unknown, maxBytes: number): number {
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > maxBytes) throw new Error('workspace_command_invalid');
  };
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_NESTING_DEPTH) throw new Error('workspace_command_invalid');
    if (candidate === null) { add(4); return; }
    if (candidate === true) { add(4); return; }
    if (candidate === false) { add(5); return; }
    if (typeof candidate === 'string') { add(jsonStringBytes(candidate, maxBytes - bytes)); return; }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('workspace_command_invalid');
      add(JSON.stringify(candidate).length); return;
    }
    if (!candidate || typeof candidate !== 'object') throw new Error('workspace_command_invalid');
    if (ancestors.has(candidate)) throw new Error('workspace_command_invalid');
    const array = Array.isArray(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('workspace_command_invalid');
    ancestors.add(candidate);
    try {
      if (array) {
        const keys = Reflect.ownKeys(candidate);
        if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) throw new Error('workspace_command_invalid');
        const list = candidate as unknown[];
        if (keys.length !== list.length + 1) throw new Error('workspace_command_invalid');
        add(2);
        for (let index = 0; index < list.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('workspace_command_invalid');
          if (index > 0) add(1);
          visit(descriptor.value, depth + 1);
        }
      } else {
        const record = candidate as Record<string, unknown>;
        const keys = Reflect.ownKeys(record);
        if (keys.some((key) => typeof key !== 'string')) throw new Error('workspace_command_invalid');
        add(2);
        let index = 0;
        for (const key of keys as string[]) {
          const descriptor = Object.getOwnPropertyDescriptor(record, key);
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('workspace_command_invalid');
          if (index++ > 0) add(1);
          add(jsonStringBytes(key, maxBytes - bytes)); add(1);
          visit(descriptor.value, depth + 1);
        }
      }
    } finally { ancestors.delete(candidate); }
  };
  visit(value, 0);
  return bytes;
}

function boundedString(value: unknown, maxBytes: number, options: { allowEmpty?: boolean; identifier?: boolean } = {}): value is string {
  return typeof value === 'string' && (options.allowEmpty || value.length > 0) &&
    (!options.identifier || !CONTROL.test(value)) && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function parseBoundedStringList(value: unknown, maxItems = 100, maxItemBytes = 4096): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error('workspace_command_invalid');
  const result = value.map((item) => {
    if (!boundedString(item, maxItemBytes) || CONTROL.test(item)) throw new Error('workspace_command_invalid');
    return item;
  });
  return Object.freeze(result);
}

function accountFence(raw: Record<string, unknown>): { accountId: string; expectedConnectionGeneration: number } {
  if (!boundedString(raw.accountId, MAX_ID_BYTES, { identifier: true }) || !Number.isSafeInteger(raw.expectedConnectionGeneration) ||
      (raw.expectedConnectionGeneration as number) < 0) throw new Error('workspace_command_invalid');
  return { accountId: raw.accountId, expectedConnectionGeneration: raw.expectedConnectionGeneration as number };
}

function parseKnowledgeSelection(value: unknown): PublicKnowledgeSelection {
  if (!Array.isArray(value)) throw new Error('workspace_command_invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) || keys.length !== value.length + 1) throw new Error('workspace_command_invalid');
  const result: { kind: 'person' | 'project'; id: string }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !isRecord(descriptor.value)) throw new Error('workspace_command_invalid');
    const row = descriptor.value;
    assertExactKeys(row, ['kind', 'id'], ['kind', 'id']);
    if ((row.kind !== 'person' && row.kind !== 'project') || !boundedString(row.id, MAX_ID_BYTES, { identifier: true })) throw new Error('workspace_command_invalid');
    const key = `${row.kind}:${row.id}`;
    if (!seen.has(key)) {
      result.push(Object.freeze({ kind: row.kind, id: row.id }));
      seen.add(key);
    }
  }
  return Object.freeze(result);
}

const SETTINGS_PATCH_KEYS = ['mode', 'speechEnabled', 'speechProvider', 'speechEndpoint', 'openRouterReasoningEffort', 'maxAudioSeconds', 'audioRetention', 'timezone'] as const;

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch { return false; }
}

function parseSettingsPatch(value: unknown): WorkspaceSettingsPatch {
  if (!isRecord(value)) throw new Error('workspace_command_invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0 || keys.some((key) => typeof key !== 'string' || !SETTINGS_PATCH_KEYS.includes(key as typeof SETTINGS_PATCH_KEYS[number]))) {
    throw new Error('workspace_command_invalid');
  }
  assertPlainDataProperties(value);
  const patch: Record<string, unknown> = {};
  for (const key of SETTINGS_PATCH_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const candidate = value[key];
    switch (key) {
      case 'mode': if (candidate !== 'preview' && candidate !== 'provider') throw new Error('workspace_command_invalid'); break;
      case 'speechEnabled': if (typeof candidate !== 'boolean') throw new Error('workspace_command_invalid'); break;
      case 'speechProvider': if (candidate !== 'azure' && candidate !== 'openrouter') throw new Error('workspace_command_invalid'); break;
      case 'speechEndpoint':
        if (typeof candidate !== 'string' || candidate.length > 2048 || CONTROL.test(candidate)) throw new Error('workspace_command_invalid');
        if (candidate.length === 0) patch[key] = '';
        else {
          try { patch[key] = validateAzureEndpoint(candidate, 'speech'); }
          catch { throw new Error('workspace_command_invalid'); }
        }
        continue;
      case 'openRouterReasoningEffort': if (candidate !== 'none' && candidate !== 'low') throw new Error('workspace_command_invalid'); break;
      case 'maxAudioSeconds': if (!Number.isSafeInteger(candidate) || (candidate as number) < 10 || (candidate as number) > 600) throw new Error('workspace_command_invalid'); break;
      case 'audioRetention': if (candidate !== 'keep' && candidate !== 'delete_after_transcription') throw new Error('workspace_command_invalid'); break;
      case 'timezone': if (typeof candidate !== 'string' || candidate.length > 128 || !validTimezone(candidate)) throw new Error('workspace_command_invalid'); break;
    }
    patch[key] = candidate;
  }
  return Object.freeze(patch) as WorkspaceSettingsPatch;
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseAliases(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_LIMITS.aliasCount) throw new Error('workspace_command_invalid');
  const aliases = value.map((alias) => {
    if (!boundedString(alias, KNOWLEDGE_LIMITS.aliasChars) || CONTROL.test(alias)) throw new Error('workspace_command_invalid');
    return alias;
  });
  return Object.freeze(aliases);
}

function parseEntitySaveInput(value: unknown, kind: 'person', operation: 'create'): PersonCreateInput;
function parseEntitySaveInput(value: unknown, kind: 'person', operation: 'update'): PersonUpdateInput;
function parseEntitySaveInput(value: unknown, kind: 'project', operation: 'create'): ProjectCreateInput;
function parseEntitySaveInput(value: unknown, kind: 'project', operation: 'update'): ProjectUpdateInput;
function parseEntitySaveInput(value: unknown, kind: KnowledgeEntityKind, operation: 'create' | 'update'):
  PersonCreateInput | PersonUpdateInput | ProjectCreateInput | ProjectUpdateInput {
  if (!isRecord(value)) throw new Error('workspace_command_invalid');
  const baseKeys = ['name', 'aliases', 'narrative'];
  const projectKeys = kind === 'project' ? ['status', 'goal', 'startsOn', 'targetOn', 'dateTimeZone'] : [];
  const updateKeys = operation === 'update' ? ['id', 'expectedRevision', 'expectedDocumentRevision'] : [];
  assertExactKeys(value, [...baseKeys, ...projectKeys, ...updateKeys], [...baseKeys, ...(kind === 'project' ? ['status', 'goal'] : []), ...updateKeys]);
  if (!boundedString(value.name, KNOWLEDGE_LIMITS.nameChars) || CONTROL.test(value.name) ||
      !boundedString(value.narrative, KNOWLEDGE_LIMITS.narrativeBytes, { allowEmpty: true }) ||
      (operation === 'update' && (!isCanonicalKnowledgeId(value.id) || !positiveRevision(value.expectedRevision) ||
        !(value.expectedDocumentRevision === null || positiveRevision(value.expectedDocumentRevision))))) throw new Error('workspace_command_invalid');
  const aliases = parseAliases(value.aliases);
  if (kind === 'person') {
    const input = { name: value.name, aliases, narrative: value.narrative };
    if (operation === 'create') return Object.freeze(input);
    return Object.freeze({ ...input, id: value.id as string,
      expectedRevision: value.expectedRevision as number, expectedDocumentRevision: value.expectedDocumentRevision as number | null });
  }
  if (!['planned', 'active', 'paused', 'completed'].includes(value.status as string) ||
      !boundedString(value.goal, KNOWLEDGE_LIMITS.goalBytes, { allowEmpty: true }) || CONTROL.test(value.goal as string)) throw new Error('workspace_command_invalid');
  const optionalDate = (candidate: unknown): candidate is string | undefined => candidate === undefined ||
    (typeof candidate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate) && Number.isFinite(Date.parse(`${candidate}T00:00:00.000Z`)) &&
      new Date(`${candidate}T00:00:00.000Z`).toISOString().slice(0, 10) === candidate);
  if (!optionalDate(value.startsOn) || !optionalDate(value.targetOn) ||
      (Object.hasOwn(value, 'dateTimeZone') && (typeof value.dateTimeZone !== 'string' || value.dateTimeZone.length > 128 || !validTimezone(value.dateTimeZone)))) throw new Error('workspace_command_invalid');
  const input = { name: value.name, aliases, narrative: value.narrative, status: value.status as ProjectCreateInput['status'], goal: value.goal as string,
    ...(value.startsOn !== undefined ? { startsOn: value.startsOn as string } : {}),
    ...(value.targetOn !== undefined ? { targetOn: value.targetOn as string } : {}),
    ...(value.dateTimeZone !== undefined ? { dateTimeZone: value.dateTimeZone as string } : {}) };
  if (operation === 'create') return Object.freeze(input);
  return Object.freeze({ ...input, id: value.id as string,
    expectedRevision: value.expectedRevision as number, expectedDocumentRevision: value.expectedDocumentRevision as number | null });
}

export function canonicalKnowledgeDocumentParent(path: string): Readonly<{ entityKind: KnowledgeEntityKind; entityId: string }> | undefined {
  const match = /^(people|projects)\/([^/]+)\.md$/.exec(path);
  return match && isCanonicalKnowledgeId(match[2])
    ? Object.freeze({ entityKind: match[1] === 'people' ? 'person' : 'project', entityId: match[2] }) : undefined;
}

function isReservedKnowledgeDocumentPath(path: string): boolean {
  return /^(people|projects)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/i.test(path);
}

function parseKnowledgeItem(raw: Record<string, unknown>, kind: 'fact' | 'contact' | 'member', operation: 'save' | 'remove'): WorkspaceCommand {
  const keys = kind === 'fact' ? ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId', ...(operation === 'save' ? ['statement'] : [])]
    : kind === 'contact' ? ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId', ...(operation === 'save' ? ['address', 'label'] : [])]
      : ['kind', 'entityKind', 'entityId', 'expectedEntityRevision', 'itemId', ...(operation === 'save' ? ['personId', 'personRevision', 'role'] : [])];
  assertExactKeys(raw, keys, keys.filter((key) => key !== 'itemId' && key !== 'kind').concat(operation === 'remove' ? ['itemId'] : []));
  if (!isCanonicalKnowledgeId(raw.entityId) || !positiveRevision(raw.expectedEntityRevision) ||
      (Object.hasOwn(raw, 'itemId') && !isCanonicalKnowledgeId(raw.itemId))) throw new Error('workspace_command_invalid');
  if ((kind === 'fact' && raw.entityKind !== 'person' && raw.entityKind !== 'project') ||
      (kind === 'contact' && raw.entityKind !== 'person') || (kind === 'member' && raw.entityKind !== 'project')) throw new Error('workspace_command_invalid');
  if (kind === 'fact') {
    if (operation === 'save' && !boundedString(raw.statement, KNOWLEDGE_LIMITS.statementBytes, { allowEmpty: true })) throw new Error('workspace_command_invalid');
    return operation === 'save' ? Object.freeze({ kind: 'knowledge.fact.save', entityKind: raw.entityKind as KnowledgeEntityKind, entityId: raw.entityId,
      expectedEntityRevision: raw.expectedEntityRevision as number, ...(Object.hasOwn(raw, 'itemId') ? { itemId: raw.itemId as string } : {}), statement: raw.statement as string })
      : Object.freeze({ kind: 'knowledge.fact.remove', entityKind: raw.entityKind as KnowledgeEntityKind, entityId: raw.entityId, expectedEntityRevision: raw.expectedEntityRevision as number, itemId: raw.itemId as string });
  }
  if (kind === 'contact') {
    if (operation === 'save' && (!boundedString(raw.address, KNOWLEDGE_LIMITS.addressChars) || !boundedString(raw.label, KNOWLEDGE_LIMITS.labelChars) || CONTROL.test(raw.address as string) || CONTROL.test(raw.label as string))) throw new Error('workspace_command_invalid');
    return operation === 'save' ? Object.freeze({ kind: 'knowledge.contact.save', entityKind: 'person', entityId: raw.entityId,
      expectedEntityRevision: raw.expectedEntityRevision as number, ...(Object.hasOwn(raw, 'itemId') ? { itemId: raw.itemId as string } : {}), address: raw.address as string, label: raw.label as string })
      : Object.freeze({ kind: 'knowledge.contact.remove', entityKind: 'person', entityId: raw.entityId, expectedEntityRevision: raw.expectedEntityRevision as number, itemId: raw.itemId as string });
  }
  if (operation === 'save' && (!isCanonicalKnowledgeId(raw.personId) || !positiveRevision(raw.personRevision) ||
      !boundedString(raw.role, KNOWLEDGE_LIMITS.labelChars) || CONTROL.test(raw.role as string))) throw new Error('workspace_command_invalid');
  return operation === 'save' ? Object.freeze({ kind: 'knowledge.member.save', entityKind: 'project', entityId: raw.entityId,
    expectedEntityRevision: raw.expectedEntityRevision as number, ...(Object.hasOwn(raw, 'itemId') ? { itemId: raw.itemId as string } : {}),
    personId: raw.personId as string, personRevision: raw.personRevision as number, role: raw.role as string })
    : Object.freeze({ kind: 'knowledge.member.remove', entityKind: 'project', entityId: raw.entityId, expectedEntityRevision: raw.expectedEntityRevision as number, itemId: raw.itemId as string });
}

function parsePublicKnowledgeChange(value: unknown): PublicKnowledgeChange {
  if (!isRecord(value)) throw new Error('workspace_command_invalid');
  const type = value.type;
  if (type === 'add_fact') {
    assertExactKeys(value, ['type', 'entityKind', 'entityId', 'statement'], ['type', 'entityKind', 'entityId', 'statement']);
    if ((value.entityKind !== 'person' && value.entityKind !== 'project') || !isCanonicalKnowledgeId(value.entityId) ||
        !boundedString(value.statement, KNOWLEDGE_LIMITS.statementBytes, { allowEmpty: true })) throw new Error('workspace_command_invalid');
    return Object.freeze({ type, entityKind: value.entityKind, entityId: value.entityId, statement: value.statement }) as PublicKnowledgeChange;
  }
  if (type === 'add_contact') {
    assertExactKeys(value, ['type', 'entityKind', 'entityId', 'address', 'label'], ['type', 'entityKind', 'entityId', 'address', 'label']);
    if (value.entityKind !== 'person' || !isCanonicalKnowledgeId(value.entityId) || !boundedString(value.address, KNOWLEDGE_LIMITS.addressChars) ||
        !boundedString(value.label, KNOWLEDGE_LIMITS.labelChars) || CONTROL.test(value.address) || CONTROL.test(value.label)) throw new Error('workspace_command_invalid');
    return Object.freeze({ type, entityKind: 'person', entityId: value.entityId, address: value.address, label: value.label }) as PublicKnowledgeChange;
  }
  if (type === 'add_member') {
    assertExactKeys(value, ['type', 'entityKind', 'entityId', 'personId', 'personRevision', 'role'], ['type', 'entityKind', 'entityId', 'personId', 'personRevision', 'role']);
    if (value.entityKind !== 'project' || !isCanonicalKnowledgeId(value.entityId) || !isCanonicalKnowledgeId(value.personId) ||
        !positiveRevision(value.personRevision) || !boundedString(value.role, KNOWLEDGE_LIMITS.labelChars) || CONTROL.test(value.role)) throw new Error('workspace_command_invalid');
    return Object.freeze({ type, entityKind: 'project', entityId: value.entityId, personId: value.personId, personRevision: value.personRevision as number, role: value.role }) as PublicKnowledgeChange;
  }
  if (type === 'add_source_link') {
    assertExactKeys(value, ['type', 'entityKind', 'entityId', 'referenceChoiceId', 'referenceRevision', 'label'], ['type', 'entityKind', 'entityId', 'referenceChoiceId', 'label']);
    if ((value.entityKind !== 'person' && value.entityKind !== 'project') || !isCanonicalKnowledgeId(value.entityId) ||
        typeof value.referenceChoiceId !== 'string' || !/^knowledge-choice-[a-f0-9]{64}$/.test(value.referenceChoiceId) ||
        (Object.hasOwn(value, 'referenceRevision') && !positiveRevision(value.referenceRevision)) ||
        !boundedString(value.label, KNOWLEDGE_LIMITS.labelChars) || CONTROL.test(value.label)) throw new Error('workspace_command_invalid');
    return Object.freeze({ type, entityKind: value.entityKind, entityId: value.entityId, referenceChoiceId: value.referenceChoiceId,
      ...(Object.hasOwn(value, 'referenceRevision') ? { referenceRevision: value.referenceRevision as number } : {}), label: value.label }) as PublicKnowledgeChange;
  }
  throw new Error('workspace_command_invalid');
}

function parseKnowledgeSuggestionEvidence(value: unknown): readonly KnowledgeEvidence[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > KNOWLEDGE_LIMITS.evidencePerItem) throw new Error('workspace_command_invalid');
  return Object.freeze(value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('workspace_command_invalid');
    assertExactKeys(candidate, ['sourceId', 'sourceVersion', 'revision', 'quote'], ['sourceId', 'sourceVersion', 'revision', 'quote']);
    if (!boundedString(candidate.sourceId, KNOWLEDGE_LIMITS.sourceIdChars) || typeof candidate.sourceVersion !== 'string' || !/^\d+:[a-f0-9]{64}$/.test(candidate.sourceVersion) ||
        !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0 || !candidate.sourceVersion.startsWith(`${candidate.revision}:`) ||
        !boundedString(candidate.quote, KNOWLEDGE_LIMITS.quoteBytes) || !candidate.quote.trim() || CONTROL.test(candidate.sourceId)) {
      throw new Error('workspace_command_invalid');
    }
    return Object.freeze({ sourceId: candidate.sourceId, sourceVersion: candidate.sourceVersion, revision: candidate.revision as number, quote: candidate.quote });
  }));
}

function freezeCommand(raw: Record<string, unknown>): WorkspaceCommand {
  const kind = raw.kind;
  if (kind === 'settings.update') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    return Object.freeze({ kind, patch: parseSettingsPatch(raw.patch) });
  }
  if (kind === 'tasks.complete' || kind === 'tasks.reopen') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.taskId, MAX_ID_BYTES, { identifier: true })) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, taskId: raw.taskId });
  }
  if (kind === 'chat.create') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind']);
    if (Object.hasOwn(raw, 'title') && !boundedString(raw.title, 4096, { allowEmpty: true })) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, ...(Object.hasOwn(raw, 'title') ? { title: raw.title as string } : {}) });
  }
  if (kind === 'chat.conversation.delete') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!isUuidV4(raw.conversationId)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, conversationId: raw.conversationId });
  }
  if (kind === 'notes.confirmImportedTimeZone') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.noteId, MAX_ID_BYTES, { identifier: true }) || !positiveRevision(raw.expectedNoteRevision) ||
        !boundedString(raw.timeZone, 128) || raw.timeZone.trim() !== raw.timeZone) throw new Error('workspace_command_invalid');
    try { new Intl.DateTimeFormat('en-US', { timeZone: raw.timeZone }); } catch { throw new Error('workspace_command_invalid'); }
    return Object.freeze({ kind, noteId: raw.noteId, expectedNoteRevision: raw.expectedNoteRevision as number, timeZone: raw.timeZone });
  }
  if (kind === 'chat.transcript.prepare') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.noteId, MAX_ID_BYTES, { identifier: true }) || !positiveRevision(raw.expectedNoteRevision)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, noteId: raw.noteId, expectedNoteRevision: raw.expectedNoteRevision as number });
  }
  if (kind === 'chat.transcript.cancel') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!isUuidV4(raw.planId)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, planId: raw.planId });
  }
  if (kind === 'chat.transcript.submit') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!isUuidV4(raw.planId) || !isUuidV4(raw.conversationId)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, planId: raw.planId, conversationId: raw.conversationId });
  }
  if (kind === 'notes.save') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.transcript, WORKSPACE_TEXT_COMMAND_MAX_BYTES)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, transcript: raw.transcript });
  }
  if (kind === 'notes.capture.adopt') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!isUuidV4(raw.captureId) || !isUuidV4(raw.captureRevision)) {
      throw new Error('workspace_command_invalid');
    }
    return Object.freeze({ kind, captureId: raw.captureId, captureRevision: raw.captureRevision });
  }
  if (kind === 'accounts.installOAuth') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!isUuidV4(raw.stageId)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, stageId: raw.stageId });
  }
  if (kind === 'accounts.syncCalendars' || kind === 'accounts.refreshMail' || kind === 'accounts.continueMailBackfill' || kind === 'accounts.disconnect') {
    assertExactKeys(raw, COMMAND_KEYS[kind], kind === 'accounts.syncCalendars' ? ['kind', 'accountId', 'expectedConnectionGeneration'] : COMMAND_KEYS[kind]);
    const fence = accountFence(raw);
    if (kind === 'accounts.syncCalendars') {
      if (Object.hasOwn(raw, 'continue') && typeof raw.continue !== 'boolean') throw new Error('workspace_command_invalid');
      return Object.freeze({ kind, ...fence, ...(Object.hasOwn(raw, 'continue') ? { continue: raw.continue as boolean } : {}) });
    }
    return Object.freeze({ kind, ...fence });
  }
  if (kind === 'mail.source.loadText') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    const fence = accountFence(raw);
    if (!boundedString(raw.messageId, MAX_ID_BYTES, { identifier: true }) || typeof raw.sourceDigest !== 'string' || !/^[a-f\d]{64}$/i.test(raw.sourceDigest)) {
      throw new Error('workspace_command_invalid');
    }
    return Object.freeze({ kind, ...fence, messageId: raw.messageId, sourceDigest: raw.sourceDigest.toLowerCase() });
  }
  if (kind === 'mail.reply.create') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    const fence = accountFence(raw);
    if (!boundedString(raw.messageId, MAX_ID_BYTES, { identifier: true }) || typeof raw.sourceDigest !== 'string' || !/^[a-f\d]{64}$/i.test(raw.sourceDigest) ||
        (raw.mode !== 'reply' && raw.mode !== 'reply_all') || !boundedString(raw.text, WORKSPACE_TEXT_COMMAND_MAX_BYTES, { allowEmpty: true })) {
      throw new Error('workspace_command_invalid');
    }
    return Object.freeze({ kind, ...fence, messageId: raw.messageId, sourceDigest: raw.sourceDigest.toLowerCase(), mode: raw.mode,
      text: raw.text, to: parseBoundedStringList(raw.to), cc: parseBoundedStringList(raw.cc) });
  }
  if (kind === 'mail.reply.derive') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    const fence = accountFence(raw);
    if (!boundedString(raw.parentProposalId, MAX_ID_BYTES, { identifier: true }) || !positiveRevision(raw.expectedParentRevision) ||
        (raw.operation !== 'draft' && raw.operation !== 'send')) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, ...fence, parentProposalId: raw.parentProposalId,
      expectedParentRevision: raw.expectedParentRevision as number, operation: raw.operation });
  }
  if (kind === 'mail.reply.promoteDraft') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    const fence = accountFence(raw);
    if (!boundedString(raw.parentProposalId, MAX_ID_BYTES, { identifier: true }) || !positiveRevision(raw.expectedParentRevision) ||
        !boundedString(raw.draftDispatchRecordId, MAX_ID_BYTES, { identifier: true })) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, ...fence, parentProposalId: raw.parentProposalId,
      expectedParentRevision: raw.expectedParentRevision as number, draftDispatchRecordId: raw.draftDispatchRecordId });
  }
  if (kind === 'proposals.edit') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    const fence = accountFence(raw);
    if (!boundedString(raw.proposalId, MAX_ID_BYTES, { identifier: true }) || !positiveRevision(raw.expectedProposalRevision) || !isRecord(raw.edit)) {
      throw new Error('workspace_command_invalid');
    }
    const edit = raw.edit;
    let parsed: CloudProposalEdit;
    if (edit.kind === 'email') {
      assertExactKeys(edit, ['kind', 'operation', 'to', 'cc', 'bcc', 'subject', 'text'], ['kind', 'operation', 'to', 'cc', 'bcc', 'subject', 'text']);
      if (edit.operation !== 'draft' && edit.operation !== 'send' || !boundedString(edit.subject, 4096, { allowEmpty: true }) || CONTROL.test(edit.subject) ||
          !boundedString(edit.text, WORKSPACE_TEXT_COMMAND_MAX_BYTES, { allowEmpty: true })) throw new Error('workspace_command_invalid');
      parsed = Object.freeze({ kind: 'email', operation: edit.operation, to: parseBoundedStringList(edit.to), cc: parseBoundedStringList(edit.cc),
        bcc: parseBoundedStringList(edit.bcc), subject: edit.subject, text: edit.text });
    } else if (edit.kind === 'event') {
      assertExactKeys(edit, ['kind', 'calendarId', 'title', 'description', 'start', 'end', 'timeZone', 'attendees', 'invitePolicy'],
        ['kind', 'calendarId', 'title', 'description', 'start', 'end', 'timeZone', 'attendees', 'invitePolicy']);
      if (!boundedString(edit.calendarId, MAX_ID_BYTES, { identifier: true }) || !boundedString(edit.title, 4096, { allowEmpty: true }) || CONTROL.test(edit.title) ||
          !boundedString(edit.description, WORKSPACE_TEXT_COMMAND_MAX_BYTES, { allowEmpty: true }) || !boundedString(edit.start, 128) || !boundedString(edit.end, 128) ||
          !boundedString(edit.timeZone, 256) || CONTROL.test(edit.timeZone) || (edit.invitePolicy !== 'send' && edit.invitePolicy !== 'none')) throw new Error('workspace_command_invalid');
      try { new Intl.DateTimeFormat('en', { timeZone: edit.timeZone }); } catch { throw new Error('workspace_command_invalid'); }
      parsed = Object.freeze({ kind: 'event', calendarId: edit.calendarId, title: edit.title, description: edit.description, start: edit.start,
        end: edit.end, timeZone: edit.timeZone, attendees: parseBoundedStringList(edit.attendees), invitePolicy: edit.invitePolicy });
    } else throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, proposalId: raw.proposalId, expectedProposalRevision: raw.expectedProposalRevision as number, ...fence, edit: parsed });
  }
  if (kind === 'proposals.approve' || kind === 'proposals.execute' || kind === 'proposals.dismiss') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.proposalId, MAX_ID_BYTES, { identifier: true }) || !positiveRevision(raw.expectedProposalRevision)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, proposalId: raw.proposalId, expectedProposalRevision: raw.expectedProposalRevision as number });
  }
  if (kind === 'dispatch.reconcile') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind', 'recordId', 'expectedRecordVersion', 'disposition', 'note']);
    if (!boundedString(raw.recordId, MAX_ID_BYTES, { identifier: true }) || typeof raw.expectedRecordVersion !== 'string' || !/^[a-f\d]{64}$/i.test(raw.expectedRecordVersion) ||
        !['confirmed_present', 'not_found', 'abandoned'].includes(raw.disposition as string) || !boundedString(raw.note, 4096, { allowEmpty: true }) || CONTROL.test(raw.note) ||
        (Object.hasOwn(raw, 'remoteId') && (!boundedString(raw.remoteId, MAX_ID_BYTES, { identifier: true }) || CONTROL.test(raw.remoteId)))) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, recordId: raw.recordId, expectedRecordVersion: raw.expectedRecordVersion.toLowerCase(),
      disposition: raw.disposition as import('../dispatch').DispatchReconciliation, note: raw.note,
      ...(Object.hasOwn(raw, 'remoteId') ? { remoteId: raw.remoteId as string } : {}) });
  }
  if (kind === 'mail.replyBatch.submit') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind', 'messageId', 'accountId', 'expectedConnectionGeneration', 'sourceDigest', 'textDigest', 'mode', 'to', 'cc', 'brief', 'composerRevision']);
    const fence = accountFence(raw);
    if (!boundedString(raw.messageId, MAX_ID_BYTES, { identifier: true }) || typeof raw.sourceDigest !== 'string' || !/^[a-f\d]{64}$/i.test(raw.sourceDigest) ||
        typeof raw.textDigest !== 'string' || !/^[a-f\d]{64}$/i.test(raw.textDigest) || (raw.mode !== 'reply' && raw.mode !== 'reply_all') ||
        !boundedString(raw.brief, WORKSPACE_TEXT_COMMAND_MAX_BYTES, { allowEmpty: true }) || !Number.isSafeInteger(raw.composerRevision) || (raw.composerRevision as number) < 0 ||
        (Object.hasOwn(raw, 'noteId') !== Object.hasOwn(raw, 'noteRevision')) || (Object.hasOwn(raw, 'noteId') && (!boundedString(raw.noteId, MAX_ID_BYTES, { identifier: true }) || !positiveRevision(raw.noteRevision)))) {
      throw new Error('workspace_command_invalid');
    }
    const contextSelectionIds = Object.hasOwn(raw, 'contextSelectionIds') ? parseBoundedStringList(raw.contextSelectionIds, 64, MAX_ID_BYTES) : undefined;
    const contextExcerptSelectionIds = Object.hasOwn(raw, 'contextExcerptSelectionIds') ? parseBoundedStringList(raw.contextExcerptSelectionIds, 64, MAX_ID_BYTES) : undefined;
    if (contextExcerptSelectionIds && (!contextSelectionIds || contextExcerptSelectionIds.some((id) => !contextSelectionIds.includes(id)))) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, ...fence, messageId: raw.messageId, sourceDigest: raw.sourceDigest.toLowerCase(), textDigest: raw.textDigest.toLowerCase(), mode: raw.mode,
      to: parseBoundedStringList(raw.to), cc: parseBoundedStringList(raw.cc), brief: raw.brief, composerRevision: raw.composerRevision as number,
      ...(Object.hasOwn(raw, 'noteId') ? { noteId: raw.noteId as string, noteRevision: raw.noteRevision as number } : {}),
      ...(contextSelectionIds ? { contextSelectionIds } : {}), ...(contextExcerptSelectionIds ? { contextExcerptSelectionIds } : {}) });
  }
  if (kind === 'mail.replyBatch.check' || kind === 'mail.replyBatch.review' || kind === 'mail.replyBatch.activate') {
    assertExactKeys(raw, COMMAND_KEYS[kind], kind === 'mail.replyBatch.review' ? ['kind', 'jobId', 'accountId', 'expectedConnectionGeneration', 'operation'] : COMMAND_KEYS[kind]);
    const fence = accountFence(raw);
    if (!boundedString(raw.jobId, MAX_ID_BYTES, { identifier: true }) ||
        (kind === 'mail.replyBatch.review' && raw.operation !== 'draft' && raw.operation !== 'send') ||
        (kind === 'mail.replyBatch.activate' && !boundedString(raw.planId, MAX_ID_BYTES, { identifier: true }))) throw new Error('workspace_command_invalid');
    if (kind === 'mail.replyBatch.review') return Object.freeze({ kind, ...fence, jobId: raw.jobId, operation: raw.operation as 'draft' | 'send' });
    if (kind === 'mail.replyBatch.activate') return Object.freeze({ kind, ...fence, jobId: raw.jobId, planId: raw.planId as string });
    return Object.freeze({ kind, ...fence, jobId: raw.jobId });
  }
  if (kind === 'documents.save') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind', 'path', 'content', 'expectedRevision']);
    if (typeof raw.path !== 'string' || !safeRelativeMarkdownPath(raw.path) ||
        !boundedString(raw.content, WORKSPACE_TEXT_COMMAND_MAX_BYTES, { allowEmpty: true }) ||
        !(raw.expectedRevision === null || positiveRevision(raw.expectedRevision))) throw new Error('workspace_command_invalid');
    const parent = canonicalKnowledgeDocumentParent(raw.path);
    if (!parent && isReservedKnowledgeDocumentPath(raw.path)) throw new Error('workspace_command_invalid');
    if (parent ? !positiveRevision(raw.expectedEntityRevision) : Object.hasOwn(raw, 'expectedEntityRevision')) throw new Error('workspace_command_invalid');
    if (parent && !boundedString(raw.content, KNOWLEDGE_LIMITS.narrativeBytes, { allowEmpty: true })) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, path: raw.path, content: raw.content, expectedRevision: raw.expectedRevision as number | null,
      ...(parent ? { expectedEntityRevision: raw.expectedEntityRevision as number } : {}) });
  }
  if (kind === 'knowledge.person.save' || kind === 'knowledge.project.save') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (raw.operation !== 'create' && raw.operation !== 'update') throw new Error('workspace_command_invalid');
    if (kind === 'knowledge.person.save') {
      return raw.operation === 'create'
        ? Object.freeze({ kind, operation: 'create', input: parseEntitySaveInput(raw.input, 'person', 'create') })
        : Object.freeze({ kind, operation: 'update', input: parseEntitySaveInput(raw.input, 'person', 'update') });
    }
    return raw.operation === 'create'
      ? Object.freeze({ kind, operation: 'create', input: parseEntitySaveInput(raw.input, 'project', 'create') })
      : Object.freeze({ kind, operation: 'update', input: parseEntitySaveInput(raw.input, 'project', 'update') });
  }
  if (kind === 'knowledge.entity.archive') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if ((raw.entityKind !== 'person' && raw.entityKind !== 'project') || !isCanonicalKnowledgeId(raw.id) ||
        !positiveRevision(raw.expectedRevision) || typeof raw.archived !== 'boolean') throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, entityKind: raw.entityKind, id: raw.id, expectedRevision: raw.expectedRevision as number, archived: raw.archived });
  }
  if (kind === 'knowledge.fact.save' || kind === 'knowledge.fact.remove') {
      assertExactKeys(raw, COMMAND_KEYS[kind], kind.endsWith('.save') ? COMMAND_KEYS[kind].filter((key) => key !== 'itemId') : COMMAND_KEYS[kind]);
    return parseKnowledgeItem(raw, 'fact', kind.endsWith('.save') ? 'save' : 'remove');
  }
  if (kind === 'knowledge.contact.save' || kind === 'knowledge.contact.remove') {
      assertExactKeys(raw, COMMAND_KEYS[kind], kind.endsWith('.save') ? COMMAND_KEYS[kind].filter((key) => key !== 'itemId') : COMMAND_KEYS[kind]);
    return parseKnowledgeItem(raw, 'contact', kind.endsWith('.save') ? 'save' : 'remove');
  }
  if (kind === 'knowledge.member.save' || kind === 'knowledge.member.remove') {
      assertExactKeys(raw, COMMAND_KEYS[kind], kind.endsWith('.save') ? COMMAND_KEYS[kind].filter((key) => key !== 'itemId') : COMMAND_KEYS[kind]);
    return parseKnowledgeItem(raw, 'member', kind.endsWith('.save') ? 'save' : 'remove');
  }
  if (kind === 'knowledge.sourceLink.save' || kind === 'knowledge.sourceLink.remove') {
    assertExactKeys(raw, COMMAND_KEYS[kind], kind === 'knowledge.sourceLink.save'
      ? COMMAND_KEYS[kind].filter((key) => key !== 'itemId' && key !== 'referenceChoiceId')
      : COMMAND_KEYS[kind]);
    if ((raw.entityKind !== 'person' && raw.entityKind !== 'project') || !isCanonicalKnowledgeId(raw.entityId) || !positiveRevision(raw.expectedEntityRevision) ||
        (Object.hasOwn(raw, 'itemId') && !isCanonicalKnowledgeId(raw.itemId))) throw new Error('workspace_command_invalid');
    if (kind === 'knowledge.sourceLink.remove') return Object.freeze({ kind, entityKind: raw.entityKind, entityId: raw.entityId,
      expectedEntityRevision: raw.expectedEntityRevision as number, itemId: raw.itemId as string });
    if ((Object.hasOwn(raw, 'referenceChoiceId') && (typeof raw.referenceChoiceId !== 'string' || !/^knowledge-choice-[a-f0-9]{64}$/.test(raw.referenceChoiceId))) ||
        (!Object.hasOwn(raw, 'itemId') && !Object.hasOwn(raw, 'referenceChoiceId')) ||
        !boundedString(raw.label, KNOWLEDGE_LIMITS.labelChars) || CONTROL.test(raw.label)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind: 'knowledge.sourceLink.save', entityKind: raw.entityKind, entityId: raw.entityId, expectedEntityRevision: raw.expectedEntityRevision as number,
      ...(Object.hasOwn(raw, 'itemId') ? { itemId: raw.itemId as string } : {}), ...(Object.hasOwn(raw, 'referenceChoiceId') ? { referenceChoiceId: raw.referenceChoiceId as string } : {}), label: raw.label });
  }
  if (kind === 'knowledge.suggestion.edit') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind', 'suggestionId', 'expectedSuggestionRevision', 'expectedTargetRevision', 'change', 'evidence']);
    if (!isCanonicalKnowledgeId(raw.suggestionId) || !positiveRevision(raw.expectedSuggestionRevision) || !positiveRevision(raw.expectedTargetRevision) ||
        (Object.hasOwn(raw, 'expectedMemberPersonRevision') && !positiveRevision(raw.expectedMemberPersonRevision))) throw new Error('workspace_command_invalid');
    const change = parsePublicKnowledgeChange(raw.change);
    if ((change.type === 'add_member') !== Object.hasOwn(raw, 'expectedMemberPersonRevision') ||
        (change.type === 'add_member' && change.personRevision !== raw.expectedMemberPersonRevision)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, suggestionId: raw.suggestionId, expectedSuggestionRevision: raw.expectedSuggestionRevision as number,
      expectedTargetRevision: raw.expectedTargetRevision as number,
      ...(Object.hasOwn(raw, 'expectedMemberPersonRevision') ? { expectedMemberPersonRevision: raw.expectedMemberPersonRevision as number } : {}),
      change, evidence: parseKnowledgeSuggestionEvidence(raw.evidence) });
  }
  if (kind === 'knowledge.suggestion.review') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind', 'suggestionId', 'expectedSuggestionRevision', 'decision', 'targetRevision']);
    if (!isCanonicalKnowledgeId(raw.suggestionId) || !positiveRevision(raw.expectedSuggestionRevision) || !positiveRevision(raw.targetRevision) ||
        (raw.decision !== 'accept' && raw.decision !== 'dismiss') ||
        (Object.hasOwn(raw, 'memberPersonRevision') && !positiveRevision(raw.memberPersonRevision))) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, suggestionId: raw.suggestionId, expectedSuggestionRevision: raw.expectedSuggestionRevision as number,
      decision: raw.decision, targetRevision: raw.targetRevision as number,
      ...(Object.hasOwn(raw, 'memberPersonRevision') ? { memberPersonRevision: raw.memberPersonRevision as number } : {}) });
  }
  if (kind === 'notes.updateTranscript') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.noteId, MAX_ID_BYTES, { identifier: true }) || !boundedString(raw.text, WORKSPACE_TEXT_COMMAND_MAX_BYTES, { allowEmpty: true }) ||
        !Number.isSafeInteger(raw.expectedNoteRevision) || (raw.expectedNoteRevision as number) < 1) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, noteId: raw.noteId, text: raw.text, expectedNoteRevision: raw.expectedNoteRevision as number });
  }
  if (kind === 'notes.transcribe') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.noteId, MAX_ID_BYTES, { identifier: true }) ||
        !Number.isSafeInteger(raw.expectedNoteRevision) || (raw.expectedNoteRevision as number) < 1) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, noteId: raw.noteId, expectedNoteRevision: raw.expectedNoteRevision as number });
  }
  if (kind === 'assistant.batch.submitNote') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind', 'noteId']);
    if (!boundedString(raw.noteId, MAX_ID_BYTES, { identifier: true }) ||
        (Object.hasOwn(raw, 'intent') && (typeof raw.intent !== 'string' || !['assist', 'summarize', 'answer', 'extract'].includes(raw.intent))) ||
        (Object.hasOwn(raw, 'question') && !boundedString(raw.question, WORKSPACE_TEXT_COMMAND_MAX_BYTES, { allowEmpty: true }))) throw new Error('workspace_command_invalid');
    const knowledgeSelection = Object.hasOwn(raw, 'knowledgeSelection') ? parseKnowledgeSelection(raw.knowledgeSelection) : undefined;
    return Object.freeze({ kind, noteId: raw.noteId,
      ...(Object.hasOwn(raw, 'intent') ? { intent: raw.intent as AssistIntent } : {}),
      ...(Object.hasOwn(raw, 'question') ? { question: raw.question as string } : {}),
      ...(knowledgeSelection ? { knowledgeSelection } : {}) });
  }
  if (kind === 'assistant.batch.check') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!isUuidV4(raw.jobId)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, jobId: raw.jobId });
  }
  if (kind === 'chat.submit') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind', 'conversationId', 'text']);
    if (!isUuidV4(raw.conversationId) ||
        !boundedString(raw.text, WORKSPACE_TEXT_COMMAND_MAX_BYTES)) throw new Error('workspace_command_invalid');
    const knowledgeSelection = Object.hasOwn(raw, 'knowledgeSelection') ? parseKnowledgeSelection(raw.knowledgeSelection) : undefined;
    return Object.freeze({ kind, conversationId: raw.conversationId, text: raw.text,
      ...(knowledgeSelection ? { knowledgeSelection } : {}) });
  }
  if (kind === 'chat.refine') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!isUuidV4(raw.conversationId) || !isUuidV4(raw.parentTurnId) ||
        (raw.effort !== 'medium' && raw.effort !== 'high' && raw.effort !== 'max')) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, conversationId: raw.conversationId, parentTurnId: raw.parentTurnId, effort: raw.effort });
  }
  throw new Error('workspace_command_invalid');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new Error('workspace_command_invalid');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** Validates and freezes the one public command envelope accepted by the Node gateway. */
export function parseWorkspaceCommandEnvelope(value: unknown): WorkspaceCommandEnvelope {
  if (!isRecord(value)) throw new Error('workspace_command_invalid');
  assertExactKeys(value, ENVELOPE_KEYS, ENVELOPE_KEYS);
  const rawCommand = value.command;
  if (!isRecord(rawCommand)) throw new Error('workspace_command_invalid');
  assertPlainDataProperties(rawCommand);
  const kind = rawCommand.kind;
  if (typeof kind !== 'string' || !COMMAND_KINDS.includes(kind as WorkspaceCommand['kind'])) throw new Error('workspace_command_invalid');
  const limit = ['notes.save', 'notes.updateTranscript', 'assistant.batch.submitNote', 'chat.submit', 'documents.save',
    'knowledge.person.save', 'knowledge.project.save', 'mail.reply.create', 'proposals.edit', 'mail.replyBatch.submit'].includes(kind)
    ? WORKSPACE_TEXT_COMMAND_MAX_BYTES : WORKSPACE_COMMAND_MAX_BYTES;
  preflightJsonBytes(value, limit);
  if (value.schemaVersion !== WORKSPACE_COMMAND_SCHEMA_VERSION || !isUuidV4(value.commandId) ||
      !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 ||
      !Number.isSafeInteger(value.expectedPrivacyEpoch) || (value.expectedPrivacyEpoch as number) < 0) throw new Error('workspace_command_invalid');
  const command = freezeCommand(rawCommand);
  return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId: parseWorkspaceCommandId(value.commandId),
    expectedRevision: value.expectedRevision as number, expectedPrivacyEpoch: value.expectedPrivacyEpoch as number, command });
}

/** Stable, sorted JSON for command-journal request binding; revision and epoch stay included. */
export function canonicalWorkspaceCommand(envelope: WorkspaceCommandEnvelope): string {
  return canonicalJson(parseWorkspaceCommandEnvelope(envelope));
}

/** Validates a stored or returned receipt before any field is projected to a caller. */
export function parseWorkspaceCommandReceipt(value: unknown, expected?: {
  readonly commandId: string;
  readonly kind?: WorkspaceCommand['kind'];
  readonly objectId?: string;
  readonly jobId?: string;
  readonly turnId?: string;
  readonly parentTurnId?: string;
  readonly captureId?: string;
  readonly captureRevision?: string;
  readonly stageId?: string;
  readonly accountGeneration?: number;
  readonly attemptId?: string;
  readonly sourceRevision?: number;
  readonly outcome?: 'completed' | 'no_speech' | 'cancelled' | 'failed' | 'unknown' | 'discarded';
  readonly entityKind?: KnowledgeEntityKind;
  readonly entityId?: string;
  readonly entityRevision?: number;
  readonly documentRevision?: number;
  readonly itemId?: string;
  readonly suggestionId?: string;
  readonly suggestionRevision?: number;
  readonly status?: 'pending' | 'accepted' | 'dismissed';
  readonly accountId?: string;
  readonly connectionGeneration?: number;
  readonly sourceDigest?: string;
  readonly proposalId?: string;
  readonly parentProposalId?: string;
  readonly parentProposalRevision?: number;
  readonly draftDispatchRecordId?: string;
  readonly operation?: 'draft' | 'send' | 'event';
  readonly recordId?: string;
  readonly jobStatus?: import('../services/openRouterBatchJobs').AssistantBatchJobDTO['status'];
  readonly noteId?: string;
  readonly noteRevision?: number;
  readonly timeZone?: string;
  readonly planId?: string;
  readonly expiresAt?: string;
  readonly capturedAt?: string;
  readonly captureTimeZone?: string;
  readonly conversationId?: string;
}): WorkspaceCommandReceipt {
  if (!isRecord(value)) throw new Error('workspace_command_receipt_invalid');
  assertPlainDataProperties(value);
  const kind = value.kind;
  if (typeof kind !== 'string' || !COMMAND_KINDS.includes(kind as WorkspaceCommand['kind'])) throw new Error('workspace_command_receipt_invalid');
  const keysByKind: Record<WorkspaceCommand['kind'], readonly string[]> = {
    'settings.update': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'tasks.complete': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'tasks.reopen': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'chat.create': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'chat.conversation.delete': ['commandId', 'conversationId', 'kind', 'objectId', 'schemaVersion'],
    'notes.confirmImportedTimeZone': ['commandId', 'kind', 'noteId', 'noteRevision', 'objectId', 'schemaVersion', 'timeZone'],
    'chat.transcript.prepare': ['capturedAt', 'captureTimeZone', 'commandId', 'expiresAt', 'kind', 'noteId', 'noteRevision', 'objectId', 'planId', 'schemaVersion'],
    'chat.transcript.cancel': ['commandId', 'kind', 'objectId', 'planId', 'schemaVersion'],
    'chat.transcript.submit': ['commandId', 'conversationId', 'jobId', 'kind', 'objectId', 'outcome', 'planId', 'reason', 'schemaVersion', 'turnId'],
    'notes.save': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'notes.capture.adopt': ['captureId', 'captureRevision', 'commandId', 'kind', 'objectId', 'schemaVersion'],
    'accounts.installOAuth': ['accountGeneration', 'commandId', 'kind', 'objectId', 'schemaVersion', 'stageId'],
    'accounts.syncCalendars': ['accountId', 'calendarsPartial', 'commandId', 'connectionGeneration', 'kind', 'objectId', 'schemaVersion', 'syncStatus'],
    'accounts.refreshMail': ['accountId', 'commandId', 'connectionGeneration', 'kind', 'lane', 'laneStatus', 'objectId', 'schemaVersion', 'syncStatus'],
    'accounts.continueMailBackfill': ['accountId', 'commandId', 'connectionGeneration', 'kind', 'lane', 'laneStatus', 'objectId', 'schemaVersion', 'syncStatus'],
    'accounts.disconnect': ['accountId', 'cleanup', 'commandId', 'connected', 'connectionGeneration', 'kind', 'objectId', 'schemaVersion'],
    'mail.source.loadText': ['accountId', 'commandId', 'connectionGeneration', 'kind', 'loadStatus', 'objectId', 'schemaVersion', 'sourceDigest', 'textDigest', 'bytes'],
    'mail.reply.create': ['commandId', 'kind', 'objectId', 'proposalId', 'proposalRevision', 'schemaVersion'],
    'mail.reply.derive': ['commandId', 'kind', 'objectId', 'parentProposalId', 'proposalId', 'proposalRevision', 'operation', 'schemaVersion'],
    'mail.reply.promoteDraft': ['accountId', 'childProposalId', 'childProposalRevision', 'commandId', 'connectionGeneration', 'draftDispatchRecordId',
      'parentProposalId', 'parentProposalRevision',
      'kind', 'objectId', 'operation', 'schemaVersion'],
    'proposals.edit': ['commandId', 'kind', 'objectId', 'proposalId', 'proposalRevision', 'proposalStatus', 'schemaVersion'],
    'proposals.approve': ['commandId', 'kind', 'objectId', 'proposalId', 'proposalRevision', 'proposalStatus', 'schemaVersion'],
    'proposals.dismiss': ['commandId', 'kind', 'objectId', 'proposalId', 'proposalRevision', 'proposalStatus', 'schemaVersion'],
    'proposals.execute': ['commandId', 'dispatchRecordId', 'execution', 'kind', 'objectId', 'operation', 'outcomeAt', 'proposalId', 'proposalRevision', 'proposalStatus', 'remoteId', 'schemaVersion'],
    'dispatch.reconcile': ['commandId', 'disposition', 'kind', 'objectId', 'providerOutcome', 'providerOutcomeAt', 'recordId', 'recordVersion', 'schemaVersion'],
    'mail.replyBatch.submit': ['commandId', 'jobId', 'jobStatus', 'kind', 'objectId', 'schemaVersion'],
    'mail.replyBatch.check': ['commandId', 'jobId', 'jobStatus', 'kind', 'objectId', 'schemaVersion'],
    'mail.replyBatch.review': ['commandId', 'expiresAt', 'jobId', 'kind', 'objectId', 'planId', 'schemaVersion'],
    'mail.replyBatch.activate': ['commandId', 'jobId', 'kind', 'objectId', 'proposalId', 'schemaVersion'],
    'documents.save': ['commandId', 'documentRevision', 'entityId', 'entityKind', 'entityRevision', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.person.save': ['commandId', 'entityKind', 'entityRevision', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.project.save': ['commandId', 'entityKind', 'entityRevision', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.entity.archive': ['commandId', 'entityKind', 'entityRevision', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.fact.save': ['commandId', 'entityKind', 'entityRevision', 'itemId', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.fact.remove': ['commandId', 'entityKind', 'entityRevision', 'itemId', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.contact.save': ['commandId', 'entityKind', 'entityRevision', 'itemId', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.contact.remove': ['commandId', 'entityKind', 'entityRevision', 'itemId', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.member.save': ['commandId', 'entityKind', 'entityRevision', 'itemId', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.member.remove': ['commandId', 'entityKind', 'entityRevision', 'itemId', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.sourceLink.save': ['commandId', 'entityKind', 'entityRevision', 'itemId', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.sourceLink.remove': ['commandId', 'entityKind', 'entityRevision', 'itemId', 'kind', 'objectId', 'schemaVersion'],
    'knowledge.suggestion.edit': ['commandId', 'kind', 'objectId', 'schemaVersion', 'suggestionId', 'suggestionRevision', 'status'],
    'knowledge.suggestion.review': ['commandId', 'kind', 'objectId', 'schemaVersion', 'suggestionId', 'suggestionRevision', 'status'],
    'notes.updateTranscript': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'notes.transcribe': ['attemptId', 'commandId', 'kind', 'objectId', 'outcome', 'schemaVersion', 'sourceRevision'],
    'assistant.batch.submitNote': ['commandId', 'jobId', 'kind', 'objectId', 'schemaVersion'],
    'assistant.batch.check': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'chat.submit': ['commandId', 'jobId', 'kind', 'objectId', 'schemaVersion', 'turnId'],
    'chat.refine': ['commandId', 'jobId', 'kind', 'objectId', 'parentTurnId', 'schemaVersion', 'turnId'],
  };
  const allowedReceiptKeys = keysByKind[kind as WorkspaceCommand['kind']];
  const optionalReceiptKeys: Partial<Record<WorkspaceCommand['kind'], readonly string[]>> = {
    'mail.source.loadText': ['textDigest', 'bytes'], 'proposals.execute': ['dispatchRecordId', 'operation', 'outcomeAt', 'remoteId'],
    'dispatch.reconcile': ['providerOutcomeAt'],
  };
  const requiredReceiptKeys = kind === 'chat.transcript.submit'
    ? value.outcome === 'submitted'
      ? ['commandId', 'conversationId', 'jobId', 'kind', 'objectId', 'outcome', 'planId', 'schemaVersion', 'turnId']
      : value.outcome === 'not_submitted'
        ? ['commandId', 'conversationId', 'kind', 'objectId', 'outcome', 'planId', 'reason', 'schemaVersion']
        : ['commandId', 'conversationId', 'jobId', 'kind', 'objectId', 'planId', 'schemaVersion', 'turnId']
    : kind === 'documents.save' ? ['commandId', 'documentRevision', 'kind', 'objectId', 'schemaVersion'] :
    allowedReceiptKeys.filter((key) => !optionalReceiptKeys[kind as WorkspaceCommand['kind']]?.includes(key));
  assertExactKeys(value, allowedReceiptKeys, requiredReceiptKeys);
  const textId = (candidate: unknown): candidate is string => boundedString(candidate, MAX_ID_BYTES, { identifier: true });
  const uuidId = isUuidV4;
  const knowledgeId = (candidate: unknown): candidate is string => isCanonicalKnowledgeId(candidate);
  if (value.schemaVersion !== WORKSPACE_COMMAND_SCHEMA_VERSION || !isUuidV4(value.commandId) ||
      !textId(value.objectId) || (kind === 'documents.save' && (!safeRelativeMarkdownPath(value.objectId) ||
        (isReservedKnowledgeDocumentPath(value.objectId) && !canonicalKnowledgeDocumentParent(value.objectId)))) ||
      ((kind === 'chat.create' || kind === 'assistant.batch.check' || kind === 'chat.submit' || kind === 'chat.refine') && !uuidId(value.objectId)) ||
      (kind === 'chat.conversation.delete' && (!uuidId(value.objectId) || !uuidId(value.conversationId) || value.objectId !== value.conversationId)) ||
      (kind === 'chat.transcript.submit' && (!uuidId(value.objectId) || !uuidId(value.conversationId) || value.objectId !== value.conversationId ||
        !uuidId(value.planId) || (value.outcome === 'submitted' && (!uuidId(value.turnId) || !uuidId(value.jobId) || Object.hasOwn(value, 'reason'))) ||
        (value.outcome === 'not_submitted' && (value.reason !== 'plan_unavailable' || Object.hasOwn(value, 'turnId') || Object.hasOwn(value, 'jobId'))) ||
        (value.outcome === undefined && (Object.hasOwn(value, 'outcome') || Object.hasOwn(value, 'reason'))) ||
        (value.outcome !== undefined && value.outcome !== 'submitted' && value.outcome !== 'not_submitted'))) ||
      (kind === 'notes.confirmImportedTimeZone' && (!textId(value.objectId) || value.noteId !== value.objectId || !positiveRevision(value.noteRevision) || !validTimeZone(value.timeZone))) ||
      (kind === 'chat.transcript.prepare' && (!textId(value.objectId) || value.noteId !== value.objectId || !positiveRevision(value.noteRevision) || !uuidId(value.planId) ||
        !validIsoDate(value.expiresAt) || !validIsoDate(value.capturedAt) || !validTimeZone(value.captureTimeZone))) ||
      (kind === 'chat.transcript.cancel' && (!uuidId(value.objectId) || !uuidId(value.planId) || value.objectId !== value.planId)) ||
      (kind === 'settings.update' && value.objectId !== 'workspace-settings') ||
      (Object.hasOwn(value, 'jobId') && !uuidId(value.jobId)) ||
      (Object.hasOwn(value, 'turnId') && !uuidId(value.turnId)) ||
      (Object.hasOwn(value, 'parentTurnId') && !uuidId(value.parentTurnId)) ||
      (Object.hasOwn(value, 'captureId') && !uuidId(value.captureId)) ||
      (Object.hasOwn(value, 'captureRevision') && !uuidId(value.captureRevision)) ||
      (Object.hasOwn(value, 'stageId') && !uuidId(value.stageId)) ||
      (kind === 'accounts.installOAuth' && (!Number.isSafeInteger(value.accountGeneration) || (value.accountGeneration as number) < 1)) ||
      (['accounts.syncCalendars', 'accounts.refreshMail', 'accounts.continueMailBackfill', 'accounts.disconnect', 'mail.source.loadText'].includes(kind) &&
        (!textId(value.accountId) || !Number.isSafeInteger(value.connectionGeneration) || (value.connectionGeneration as number) < 0)) ||
      (kind === 'accounts.syncCalendars' && (!['idle', 'syncing', 'partial', 'error'].includes(value.syncStatus as string) || typeof value.calendarsPartial !== 'boolean')) ||
      ((kind === 'accounts.refreshMail' || kind === 'accounts.continueMailBackfill') && (!['head', 'backfill'].includes(value.lane as string) ||
        !['complete', 'partial', 'error', 'idle'].includes(value.laneStatus as string) || !['idle', 'syncing', 'partial', 'error'].includes(value.syncStatus as string))) ||
      (kind === 'accounts.disconnect' && (value.connected !== false || (value.cleanup !== 'complete' && value.cleanup !== 'pending'))) ||
      (kind === 'mail.source.loadText' && (!/^[a-f\d]{64}$/.test(String(value.sourceDigest)) ||
        !['current', 'source_changed', 'stale', 'unavailable'].includes(value.loadStatus as string) ||
        (Object.hasOwn(value, 'textDigest') && !/^[a-f\d]{64}$/.test(String(value.textDigest))) ||
        (Object.hasOwn(value, 'bytes') && (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0)))) ||
      (kind === 'mail.reply.create' && (!textId(value.proposalId) || !positiveRevision(value.proposalRevision) || value.objectId !== value.proposalId)) ||
      (kind === 'mail.reply.derive' && (!textId(value.parentProposalId) || !textId(value.proposalId) || !positiveRevision(value.proposalRevision) ||
        value.objectId !== value.proposalId || value.parentProposalId === value.proposalId || !['draft', 'send'].includes(value.operation as string))) ||
      (kind === 'mail.reply.promoteDraft' && (!textId(value.parentProposalId) || !positiveRevision(value.parentProposalRevision) || !textId(value.draftDispatchRecordId) ||
        !textId(value.childProposalId) || value.childProposalId === value.parentProposalId || !positiveRevision(value.childProposalRevision) ||
        !textId(value.accountId) || !Number.isSafeInteger(value.connectionGeneration) || (value.connectionGeneration as number) < 0 ||
        value.operation !== 'send' || value.objectId !== value.childProposalId)) ||
      (['proposals.edit', 'proposals.approve', 'proposals.dismiss', 'proposals.execute'].includes(kind) &&
        (!textId(value.proposalId) || !positiveRevision(value.proposalRevision) || value.objectId !== value.proposalId ||
          !['draft', 'approved', 'dispatching', 'unknown', 'failed', 'accepted', 'simulated', 'executed', 'dismissed'].includes(value.proposalStatus as string))) ||
      (kind === 'proposals.execute' && (!['accepted', 'unknown', 'rejected', 'simulated', 'executed', 'failed', 'invalidated'].includes(value.execution as string) ||
        (Object.hasOwn(value, 'dispatchRecordId') && !textId(value.dispatchRecordId)) ||
        (Object.hasOwn(value, 'operation') && !['draft', 'send', 'event'].includes(value.operation as string)) ||
        (Object.hasOwn(value, 'outcomeAt') && (typeof value.outcomeAt !== 'string' || !Number.isFinite(Date.parse(value.outcomeAt)))) ||
        (Object.hasOwn(value, 'remoteId') && !textId(value.remoteId)))) ||
      (kind === 'dispatch.reconcile' && (!textId(value.recordId) || !/^[a-f\d]{64}$/.test(String(value.recordVersion)) ||
        !['confirmed_present', 'not_found', 'abandoned'].includes(value.disposition as string) ||
        !['pending', 'accepted', 'unknown', 'rejected'].includes(value.providerOutcome as string) ||
        (Object.hasOwn(value, 'providerOutcomeAt') && (typeof value.providerOutcomeAt !== 'string' || !Number.isFinite(Date.parse(value.providerOutcomeAt)))))) ||
      ((kind === 'mail.replyBatch.submit' || kind === 'mail.replyBatch.check') &&
        (!uuidId(value.jobId) || !['preparing', 'submitting', 'submission_unknown', 'queued', 'processing', 'completed', 'failed', 'expired', 'cancelled',
          'result_stale', 'result_invalid', 'result_truncated', 'result_not_retained', 'cleanup_pending', 'source_removed'].includes(value.jobStatus as string))) ||
      (kind === 'mail.replyBatch.review' && (!uuidId(value.jobId) || !textId(value.planId) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) ||
      (kind === 'mail.replyBatch.activate' && (!uuidId(value.jobId) || !textId(value.proposalId))) ||
      (kind === 'documents.save' && (() => {
        const parent = canonicalKnowledgeDocumentParent(value.objectId);
        const hasParent = Object.hasOwn(value, 'entityKind') || Object.hasOwn(value, 'entityId') || Object.hasOwn(value, 'entityRevision');
        return !positiveRevision(value.documentRevision) || (parent
          ? !hasParent || value.entityKind !== parent.entityKind || value.entityId !== parent.entityId || !positiveRevision(value.entityRevision)
          : hasParent);
      })()) ||
      (['knowledge.person.save', 'knowledge.project.save', 'knowledge.entity.archive'].includes(kind) &&
        ((kind === 'knowledge.person.save' && value.entityKind !== 'person') || (kind === 'knowledge.project.save' && value.entityKind !== 'project') ||
          (kind === 'knowledge.entity.archive' && value.entityKind !== 'person' && value.entityKind !== 'project') || !positiveRevision(value.entityRevision) || !knowledgeId(value.objectId))) ||
      (['knowledge.fact.save', 'knowledge.fact.remove', 'knowledge.contact.save', 'knowledge.contact.remove',
        'knowledge.member.save', 'knowledge.member.remove', 'knowledge.sourceLink.save', 'knowledge.sourceLink.remove'].includes(kind) &&
        (!knowledgeId(value.objectId) || !knowledgeId(value.itemId) || !positiveRevision(value.entityRevision) ||
          (['knowledge.contact.save', 'knowledge.contact.remove'].includes(kind) && value.entityKind !== 'person') ||
          (['knowledge.member.save', 'knowledge.member.remove'].includes(kind) && value.entityKind !== 'project') ||
          (['knowledge.fact.save', 'knowledge.fact.remove'].includes(kind) && value.entityKind !== 'person' && value.entityKind !== 'project'))) ||
      (['knowledge.suggestion.edit', 'knowledge.suggestion.review'].includes(kind) &&
        (!knowledgeId(value.objectId) || value.suggestionId !== value.objectId || !positiveRevision(value.suggestionRevision) ||
          (kind === 'knowledge.suggestion.edit' && value.status !== 'pending') ||
          (kind === 'knowledge.suggestion.review' && value.status !== 'accepted' && value.status !== 'dismissed'))) ||
      (kind === 'notes.transcribe' && (!uuidId(value.attemptId) || !Number.isSafeInteger(value.sourceRevision) || (value.sourceRevision as number) < 1 ||
        !['completed', 'no_speech', 'cancelled', 'failed', 'unknown', 'discarded'].includes(value.outcome as string))) ||
      (expected && (value.commandId !== expected.commandId || (expected.kind !== undefined && kind !== expected.kind) ||
        (expected.objectId !== undefined && value.objectId !== expected.objectId) || (expected.jobId !== undefined && value.jobId !== expected.jobId) ||
        (expected.turnId !== undefined && value.turnId !== expected.turnId) || (expected.parentTurnId !== undefined && value.parentTurnId !== expected.parentTurnId) ||
        (expected.captureId !== undefined && value.captureId !== expected.captureId) || (expected.captureRevision !== undefined && value.captureRevision !== expected.captureRevision) ||
        (expected.stageId !== undefined && value.stageId !== expected.stageId) ||
        (expected.accountGeneration !== undefined && value.accountGeneration !== expected.accountGeneration) ||
        (expected.entityKind !== undefined && value.entityKind !== expected.entityKind) ||
        (expected.entityId !== undefined && (kind === 'documents.save' ? value.entityId !== expected.entityId : value.objectId !== expected.entityId)) ||
        (expected.entityRevision !== undefined && value.entityRevision !== expected.entityRevision) ||
        (expected.documentRevision !== undefined && value.documentRevision !== expected.documentRevision) ||
        (expected.itemId !== undefined && value.itemId !== expected.itemId) ||
        (expected.suggestionId !== undefined && value.suggestionId !== expected.suggestionId) ||
        (expected.suggestionRevision !== undefined && value.suggestionRevision !== expected.suggestionRevision) ||
        (expected.status !== undefined && value.status !== expected.status) ||
        (expected.accountId !== undefined && value.accountId !== expected.accountId) ||
        (expected.connectionGeneration !== undefined && value.connectionGeneration !== expected.connectionGeneration) ||
        (expected.sourceDigest !== undefined && value.sourceDigest !== expected.sourceDigest) ||
        (expected.proposalId !== undefined && value.proposalId !== expected.proposalId) ||
        (expected.parentProposalId !== undefined && value.parentProposalId !== expected.parentProposalId) ||
        (expected.parentProposalRevision !== undefined && value.parentProposalRevision !== expected.parentProposalRevision) ||
        (expected.draftDispatchRecordId !== undefined && value.draftDispatchRecordId !== expected.draftDispatchRecordId) ||
        (expected.recordId !== undefined && value.recordId !== expected.recordId) ||
        (expected.jobStatus !== undefined && value.jobStatus !== expected.jobStatus) ||
        (expected.noteId !== undefined && value.noteId !== expected.noteId) ||
        (expected.noteRevision !== undefined && value.noteRevision !== expected.noteRevision) ||
        (expected.timeZone !== undefined && value.timeZone !== expected.timeZone) ||
        (expected.planId !== undefined && value.planId !== expected.planId) ||
        (expected.expiresAt !== undefined && value.expiresAt !== expected.expiresAt) ||
        (expected.capturedAt !== undefined && value.capturedAt !== expected.capturedAt) ||
        (expected.captureTimeZone !== undefined && value.captureTimeZone !== expected.captureTimeZone) ||
        (expected.conversationId !== undefined && value.conversationId !== expected.conversationId) ||
        (expected.attemptId !== undefined && value.attemptId !== expected.attemptId) || (expected.sourceRevision !== undefined && value.sourceRevision !== expected.sourceRevision) ||
        (expected.outcome !== undefined && value.outcome !== expected.outcome)))) {
    throw new Error('workspace_command_receipt_invalid');
  }
  const commandId = value.commandId;
  const objectId = value.objectId;
  const jobId = (candidate: unknown): string => {
    if (!uuidId(candidate)) throw new Error('workspace_command_receipt_invalid');
    return candidate;
  };
  switch (kind) {
    case 'tasks.complete': case 'tasks.reopen': case 'chat.create': case 'notes.save': case 'notes.updateTranscript':
    case 'settings.update':
    case 'assistant.batch.check':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId });
    case 'chat.conversation.delete':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, conversationId: jobId(value.conversationId) });
    case 'notes.confirmImportedTimeZone':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        noteId: textId(value.noteId) ? value.noteId : (() => { throw new Error('workspace_command_receipt_invalid'); })(), noteRevision: value.noteRevision as number, timeZone: value.timeZone as string });
    case 'chat.transcript.prepare':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        noteId: textId(value.noteId) ? value.noteId : (() => { throw new Error('workspace_command_receipt_invalid'); })(), noteRevision: value.noteRevision as number, planId: jobId(value.planId),
        expiresAt: value.expiresAt as string, capturedAt: value.capturedAt as string, captureTimeZone: value.captureTimeZone as string });
    case 'chat.transcript.cancel':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, planId: jobId(value.planId) });
    case 'chat.transcript.submit':
      if (value.outcome === 'not_submitted') return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        conversationId: jobId(value.conversationId), planId: jobId(value.planId), outcome: 'not_submitted', reason: 'plan_unavailable' });
      if (value.outcome === 'submitted') return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        conversationId: jobId(value.conversationId), planId: jobId(value.planId), outcome: 'submitted', turnId: jobId(value.turnId), jobId: jobId(value.jobId) });
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        conversationId: jobId(value.conversationId), planId: jobId(value.planId), turnId: jobId(value.turnId), jobId: jobId(value.jobId) });
    case 'notes.transcribe':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        attemptId: jobId(value.attemptId), sourceRevision: value.sourceRevision as number,
        outcome: value.outcome as 'completed' | 'no_speech' | 'cancelled' | 'failed' | 'unknown' | 'discarded' });
    case 'notes.capture.adopt':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        captureId: jobId(value.captureId), captureRevision: jobId(value.captureRevision) });
    case 'accounts.installOAuth':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        stageId: jobId(value.stageId), accountGeneration: value.accountGeneration as number });
    case 'accounts.syncCalendars':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, accountId: value.accountId as string,
        connectionGeneration: value.connectionGeneration as number, syncStatus: value.syncStatus as import('../core').AccountSyncState['status'], calendarsPartial: value.calendarsPartial as boolean });
    case 'accounts.refreshMail': case 'accounts.continueMailBackfill':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, accountId: value.accountId as string,
        connectionGeneration: value.connectionGeneration as number, lane: value.lane as 'head' | 'backfill', laneStatus: value.laneStatus as import('../core').MailLaneResult['status'],
        syncStatus: value.syncStatus as import('../core').AccountSyncState['status'] });
    case 'accounts.disconnect':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, accountId: value.accountId as string,
        connectionGeneration: value.connectionGeneration as number, connected: false, cleanup: value.cleanup as 'complete' | 'pending' });
    case 'mail.source.loadText':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, accountId: value.accountId as string,
        connectionGeneration: value.connectionGeneration as number, sourceDigest: value.sourceDigest as string,
        loadStatus: value.loadStatus as import('../core').MailReplyTextLoadResult['status'], ...(Object.hasOwn(value, 'textDigest') ? { textDigest: value.textDigest as string } : {}),
        ...(Object.hasOwn(value, 'bytes') ? { bytes: value.bytes as number } : {}) });
    case 'mail.reply.create':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, proposalId: value.proposalId as string,
        proposalRevision: value.proposalRevision as number });
    case 'mail.reply.derive':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, parentProposalId: value.parentProposalId as string,
        proposalId: value.proposalId as string, proposalRevision: value.proposalRevision as number, operation: value.operation as 'draft' | 'send' });
    case 'mail.reply.promoteDraft':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        parentProposalId: value.parentProposalId as string, draftDispatchRecordId: value.draftDispatchRecordId as string,
        parentProposalRevision: value.parentProposalRevision as number,
        childProposalId: value.childProposalId as string, childProposalRevision: value.childProposalRevision as number,
        accountId: value.accountId as string, connectionGeneration: value.connectionGeneration as number, operation: 'send' });
    case 'proposals.edit': case 'proposals.approve': case 'proposals.dismiss':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, proposalId: value.proposalId as string,
        proposalRevision: value.proposalRevision as number, proposalStatus: value.proposalStatus as import('../core').Proposal['status'] });
    case 'proposals.execute':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, proposalId: value.proposalId as string,
        proposalRevision: value.proposalRevision as number, proposalStatus: value.proposalStatus as import('../core').Proposal['status'], execution: value.execution as
          'accepted' | 'unknown' | 'rejected' | 'simulated' | 'executed' | 'failed' | 'invalidated',
        ...(Object.hasOwn(value, 'dispatchRecordId') ? { dispatchRecordId: value.dispatchRecordId as string } : {}),
        ...(Object.hasOwn(value, 'operation') ? { operation: value.operation as 'draft' | 'send' | 'event' } : {}),
        ...(Object.hasOwn(value, 'outcomeAt') ? { outcomeAt: value.outcomeAt as string } : {}), ...(Object.hasOwn(value, 'remoteId') ? { remoteId: value.remoteId as string } : {}) });
    case 'dispatch.reconcile':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, recordId: value.recordId as string,
        recordVersion: value.recordVersion as string, disposition: value.disposition as import('../dispatch').DispatchReconciliation,
        providerOutcome: value.providerOutcome as import('../dispatch').DispatchOutcome,
        ...(Object.hasOwn(value, 'providerOutcomeAt') ? { providerOutcomeAt: value.providerOutcomeAt as string } : {}) });
    case 'mail.replyBatch.submit': case 'mail.replyBatch.check':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, jobId: jobId(value.jobId),
        jobStatus: value.jobStatus as import('../services/openRouterBatchJobs').AssistantBatchJobDTO['status'] });
    case 'mail.replyBatch.review':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, jobId: jobId(value.jobId),
        planId: textId(value.planId) ? value.planId : (() => { throw new Error('workspace_command_receipt_invalid'); })(), expiresAt: value.expiresAt as string });
    case 'mail.replyBatch.activate':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, jobId: jobId(value.jobId), proposalId: value.proposalId as string });
    case 'documents.save': {
      const parent = canonicalKnowledgeDocumentParent(objectId);
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        documentRevision: value.documentRevision as number,
        ...(parent ? { entityKind: parent.entityKind, entityId: parent.entityId, entityRevision: value.entityRevision as number } : {}) });
    }
    case 'knowledge.person.save': case 'knowledge.project.save': case 'knowledge.entity.archive':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        entityKind: value.entityKind as KnowledgeEntityKind, entityRevision: value.entityRevision as number });
    case 'knowledge.fact.save': case 'knowledge.fact.remove': case 'knowledge.contact.save': case 'knowledge.contact.remove':
    case 'knowledge.member.save': case 'knowledge.member.remove': case 'knowledge.sourceLink.save': case 'knowledge.sourceLink.remove':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        entityKind: value.entityKind as KnowledgeEntityKind, entityRevision: value.entityRevision as number, itemId: value.itemId as string });
    case 'knowledge.suggestion.edit':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        suggestionId: knowledgeId(value.suggestionId) ? value.suggestionId : (() => { throw new Error('workspace_command_receipt_invalid'); })(),
        suggestionRevision: value.suggestionRevision as number, status: 'pending' });
    case 'knowledge.suggestion.review':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        suggestionId: knowledgeId(value.suggestionId) ? value.suggestionId : (() => { throw new Error('workspace_command_receipt_invalid'); })(),
        suggestionRevision: value.suggestionRevision as number, status: value.status as 'accepted' | 'dismissed' });
    case 'assistant.batch.submitNote':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId, jobId: jobId(value.jobId) });
    case 'chat.submit':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        jobId: jobId(value.jobId), turnId: jobId(value.turnId) });
    case 'chat.refine':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        jobId: jobId(value.jobId), turnId: jobId(value.turnId), parentTurnId: jobId(value.parentTurnId) });
    default: throw new Error('workspace_command_receipt_invalid');
  }
}
