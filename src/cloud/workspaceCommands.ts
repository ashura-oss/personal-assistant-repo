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
  | { readonly kind: 'notes.save'; readonly transcript: string }
  | { readonly kind: 'notes.capture.adopt'; readonly captureId: string; readonly captureRevision: string }
  | { readonly kind: 'accounts.installOAuth'; readonly stageId: string }
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
  | WorkspaceCommandReceiptBase<'settings.update'>
  | WorkspaceCommandReceiptBase<'notes.save'>
  | (WorkspaceCommandReceiptBase<'notes.capture.adopt'> & Readonly<{ captureId: string; captureRevision: string }>)
  | (WorkspaceCommandReceiptBase<'accounts.installOAuth'> & Readonly<{ stageId: string; accountGeneration: number }>)
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
  'notes.save': ['kind', 'transcript'], 'notes.updateTranscript': ['kind', 'noteId', 'text', 'expectedNoteRevision'],
  'notes.capture.adopt': ['kind', 'captureId', 'captureRevision'],
  'accounts.installOAuth': ['kind', 'stageId'],
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

export function parseWorkspaceCommandId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new Error('workspace_command_id_invalid');
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
  if (kind === 'notes.save') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.transcript, WORKSPACE_TEXT_COMMAND_MAX_BYTES)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, transcript: raw.transcript });
  }
  if (kind === 'notes.capture.adopt') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (typeof raw.captureId !== 'string' || !UUID_V4.test(raw.captureId) || typeof raw.captureRevision !== 'string' || !UUID_V4.test(raw.captureRevision)) {
      throw new Error('workspace_command_invalid');
    }
    return Object.freeze({ kind, captureId: raw.captureId, captureRevision: raw.captureRevision });
  }
  if (kind === 'accounts.installOAuth') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (typeof raw.stageId !== 'string' || !UUID_V4.test(raw.stageId)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, stageId: raw.stageId });
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
    if (typeof raw.jobId !== 'string' || !UUID_V4.test(raw.jobId)) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, jobId: raw.jobId });
  }
  if (kind === 'chat.submit') {
    assertExactKeys(raw, COMMAND_KEYS[kind], ['kind', 'conversationId', 'text']);
    if (typeof raw.conversationId !== 'string' || !UUID_V4.test(raw.conversationId) ||
        !boundedString(raw.text, WORKSPACE_TEXT_COMMAND_MAX_BYTES)) throw new Error('workspace_command_invalid');
    const knowledgeSelection = Object.hasOwn(raw, 'knowledgeSelection') ? parseKnowledgeSelection(raw.knowledgeSelection) : undefined;
    return Object.freeze({ kind, conversationId: raw.conversationId, text: raw.text,
      ...(knowledgeSelection ? { knowledgeSelection } : {}) });
  }
  if (kind === 'chat.refine') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (typeof raw.conversationId !== 'string' || !UUID_V4.test(raw.conversationId) ||
        typeof raw.parentTurnId !== 'string' || !UUID_V4.test(raw.parentTurnId) ||
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
    'knowledge.person.save', 'knowledge.project.save'].includes(kind)
    ? WORKSPACE_TEXT_COMMAND_MAX_BYTES : WORKSPACE_COMMAND_MAX_BYTES;
  preflightJsonBytes(value, limit);
  if (value.schemaVersion !== WORKSPACE_COMMAND_SCHEMA_VERSION || !UUID_V4.test(typeof value.commandId === 'string' ? value.commandId : '') ||
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
    'notes.save': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'notes.capture.adopt': ['captureId', 'captureRevision', 'commandId', 'kind', 'objectId', 'schemaVersion'],
    'accounts.installOAuth': ['accountGeneration', 'commandId', 'kind', 'objectId', 'schemaVersion', 'stageId'],
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
  const requiredReceiptKeys = kind === 'documents.save' ? ['commandId', 'documentRevision', 'kind', 'objectId', 'schemaVersion'] : allowedReceiptKeys;
  assertExactKeys(value, allowedReceiptKeys, requiredReceiptKeys);
  const textId = (candidate: unknown): candidate is string => boundedString(candidate, MAX_ID_BYTES, { identifier: true });
  const uuidId = (candidate: unknown): candidate is string => typeof candidate === 'string' && UUID_V4.test(candidate);
  const knowledgeId = (candidate: unknown): candidate is string => isCanonicalKnowledgeId(candidate);
  if (value.schemaVersion !== WORKSPACE_COMMAND_SCHEMA_VERSION || typeof value.commandId !== 'string' || !UUID_V4.test(value.commandId) ||
      !textId(value.objectId) || (kind === 'documents.save' && (!safeRelativeMarkdownPath(value.objectId) ||
        (isReservedKnowledgeDocumentPath(value.objectId) && !canonicalKnowledgeDocumentParent(value.objectId)))) ||
      ((kind === 'chat.create' || kind === 'assistant.batch.check' || kind === 'chat.submit' || kind === 'chat.refine') && !uuidId(value.objectId)) ||
      (kind === 'settings.update' && value.objectId !== 'workspace-settings') ||
      (Object.hasOwn(value, 'jobId') && !uuidId(value.jobId)) ||
      (Object.hasOwn(value, 'turnId') && !uuidId(value.turnId)) ||
      (Object.hasOwn(value, 'parentTurnId') && !uuidId(value.parentTurnId)) ||
      (Object.hasOwn(value, 'captureId') && !uuidId(value.captureId)) ||
      (Object.hasOwn(value, 'captureRevision') && !uuidId(value.captureRevision)) ||
      (Object.hasOwn(value, 'stageId') && !uuidId(value.stageId)) ||
      (kind === 'accounts.installOAuth' && (!Number.isSafeInteger(value.accountGeneration) || (value.accountGeneration as number) < 1)) ||
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
