import type { AssistIntent } from '../core';
import type { WorkspaceSnapshotDTO } from './workspaceDto';

export const WORKSPACE_COMMAND_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_COMMAND_MAX_BYTES = 16 * 1024;
export const WORKSPACE_TEXT_COMMAND_MAX_BYTES = 1024 * 1024;
const MAX_ID_BYTES = 1024;
const MAX_NESTING_DEPTH = 32;

export type WorkspaceCommand =
  | { readonly kind: 'tasks.complete'; readonly taskId: string }
  | { readonly kind: 'tasks.reopen'; readonly taskId: string }
  | { readonly kind: 'chat.create'; readonly title?: string }
  | { readonly kind: 'notes.save'; readonly transcript: string }
  | { readonly kind: 'notes.capture.adopt'; readonly captureId: string; readonly captureRevision: string }
  | { readonly kind: 'notes.updateTranscript'; readonly noteId: string; readonly text: string; readonly expectedNoteRevision: number }
  | { readonly kind: 'assistant.batch.submitNote'; readonly noteId: string; readonly intent?: AssistIntent; readonly question?: string; readonly knowledgeSelection?: PublicKnowledgeSelection }
  | { readonly kind: 'assistant.batch.check'; readonly jobId: string }
  | { readonly kind: 'chat.submit'; readonly conversationId: string; readonly text: string; readonly knowledgeSelection?: PublicKnowledgeSelection }
  | { readonly kind: 'chat.refine'; readonly conversationId: string; readonly parentTurnId: string; readonly effort: 'medium' | 'high' | 'max' };

export type PublicKnowledgeSelection = readonly Readonly<{ kind: 'person' | 'project'; id: string }>[];

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
  | WorkspaceCommandReceiptBase<'notes.save'>
  | (WorkspaceCommandReceiptBase<'notes.capture.adopt'> & Readonly<{ captureId: string; captureRevision: string }>)
  | WorkspaceCommandReceiptBase<'notes.updateTranscript'>
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
  'tasks.complete': ['kind', 'taskId'], 'tasks.reopen': ['kind', 'taskId'], 'chat.create': ['kind', 'title'],
  'notes.save': ['kind', 'transcript'], 'notes.updateTranscript': ['kind', 'noteId', 'text', 'expectedNoteRevision'],
  'notes.capture.adopt': ['kind', 'captureId', 'captureRevision'],
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

function freezeCommand(raw: Record<string, unknown>): WorkspaceCommand {
  const kind = raw.kind;
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
  if (kind === 'notes.updateTranscript') {
    assertExactKeys(raw, COMMAND_KEYS[kind], COMMAND_KEYS[kind]);
    if (!boundedString(raw.noteId, MAX_ID_BYTES, { identifier: true }) || !boundedString(raw.text, WORKSPACE_TEXT_COMMAND_MAX_BYTES, { allowEmpty: true }) ||
        !Number.isSafeInteger(raw.expectedNoteRevision) || (raw.expectedNoteRevision as number) < 1) throw new Error('workspace_command_invalid');
    return Object.freeze({ kind, noteId: raw.noteId, text: raw.text, expectedNoteRevision: raw.expectedNoteRevision as number });
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
  const limit = ['notes.save', 'notes.updateTranscript', 'assistant.batch.submitNote', 'chat.submit'].includes(kind)
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
}): WorkspaceCommandReceipt {
  if (!isRecord(value)) throw new Error('workspace_command_receipt_invalid');
  assertPlainDataProperties(value);
  const kind = value.kind;
  if (typeof kind !== 'string' || !COMMAND_KINDS.includes(kind as WorkspaceCommand['kind'])) throw new Error('workspace_command_receipt_invalid');
  const keysByKind: Record<WorkspaceCommand['kind'], readonly string[]> = {
    'tasks.complete': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'tasks.reopen': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'chat.create': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'notes.save': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'notes.capture.adopt': ['captureId', 'captureRevision', 'commandId', 'kind', 'objectId', 'schemaVersion'],
    'notes.updateTranscript': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'assistant.batch.submitNote': ['commandId', 'jobId', 'kind', 'objectId', 'schemaVersion'],
    'assistant.batch.check': ['commandId', 'kind', 'objectId', 'schemaVersion'],
    'chat.submit': ['commandId', 'jobId', 'kind', 'objectId', 'schemaVersion', 'turnId'],
    'chat.refine': ['commandId', 'jobId', 'kind', 'objectId', 'parentTurnId', 'schemaVersion', 'turnId'],
  };
  assertExactKeys(value, keysByKind[kind as WorkspaceCommand['kind']], keysByKind[kind as WorkspaceCommand['kind']]);
  const textId = (candidate: unknown): candidate is string => boundedString(candidate, MAX_ID_BYTES, { identifier: true });
  const uuidId = (candidate: unknown): candidate is string => typeof candidate === 'string' && UUID_V4.test(candidate);
  if (value.schemaVersion !== WORKSPACE_COMMAND_SCHEMA_VERSION || typeof value.commandId !== 'string' || !UUID_V4.test(value.commandId) ||
      !textId(value.objectId) || ((kind === 'chat.create' || kind === 'assistant.batch.check' || kind === 'chat.submit' || kind === 'chat.refine') && !uuidId(value.objectId)) ||
      (Object.hasOwn(value, 'jobId') && !uuidId(value.jobId)) ||
      (Object.hasOwn(value, 'turnId') && !uuidId(value.turnId)) ||
      (Object.hasOwn(value, 'parentTurnId') && !uuidId(value.parentTurnId)) ||
      (Object.hasOwn(value, 'captureId') && !uuidId(value.captureId)) ||
      (Object.hasOwn(value, 'captureRevision') && !uuidId(value.captureRevision)) ||
      (expected && (value.commandId !== expected.commandId || (expected.kind !== undefined && kind !== expected.kind) ||
        (expected.objectId !== undefined && value.objectId !== expected.objectId) || (expected.jobId !== undefined && value.jobId !== expected.jobId) ||
        (expected.turnId !== undefined && value.turnId !== expected.turnId) || (expected.parentTurnId !== undefined && value.parentTurnId !== expected.parentTurnId) ||
        (expected.captureId !== undefined && value.captureId !== expected.captureId) || (expected.captureRevision !== undefined && value.captureRevision !== expected.captureRevision)))) {
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
    case 'assistant.batch.check':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId });
    case 'notes.capture.adopt':
      return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId, kind, objectId,
        captureId: jobId(value.captureId), captureRevision: jobId(value.captureRevision) });
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
