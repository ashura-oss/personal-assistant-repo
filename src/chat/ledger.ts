import { recoveryUtf8Bytes } from '../storage/startupRecovery';
import { STATE_SNAPSHOT_READ_MAX_BYTES } from '../storage/contracts';
import type { ChatContextTurn, ChatConversation, ChatReplySnapshot, ChatTurn, ReadonlyChatLedger, SelectedChatContext } from './types';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

type Row = Record<string, unknown>;
function fail(message: string): never { throw new Error(message); }
function object(value: unknown): value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Row, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => {
    if (typeof key !== 'string' || !allowed.has(key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
  }) ||
      required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail('Chat ledger contains an unknown or missing field.');
  }
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID_V4.test(value)) fail(`${label} must be a lowercase UUIDv4.`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length !== 24 || !CANONICAL_ISO.test(value)) fail(`${label} must be canonical ISO time.`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(`${label} is invalid.`);
  return value;
}
function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || CONTROL.test(value) || hasUnpairedSurrogate(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) return true;
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function validArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  const own = Reflect.ownKeys(value);
  if (own.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) ||
      own.filter((key) => key !== 'length').length !== value.length ||
      own.some((key) => key !== 'length' && (typeof key !== 'string' || (() => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
      })()))) fail(`${label} must be a plain dense array.`);
  return value;
}
function timeZone(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || CONTROL.test(value) || hasUnpairedSurrogate(value)) {
    fail('Chat capture time zone is invalid.');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); }
  catch { fail('Chat capture time zone is invalid.'); }
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail('Chat note revision is invalid.');
  return Number(value);
}
function frozenArray<T>(items: T[]): readonly T[] { return Object.freeze(items); }

function parseReply(value: unknown): ChatReplySnapshot {
  if (!object(value)) fail('Chat reply is invalid.');
  exactKeys(value, ['summary', 'answer', 'clarifications', 'completedAt', 'requestSha256', 'requestProfileVersion']);
  const clarifications = validArray(value.clarifications, 'Chat clarifications').map((item) => text(item, 'Chat clarification'));
  if (clarifications.length > 10 || clarifications.some((item) => item.length > 1000)) fail('Chat clarifications exceed the supported structure.');
  if (value.requestProfileVersion !== 1 && value.requestProfileVersion !== 2) fail('Chat request profile is invalid.');
  if (typeof value.requestSha256 !== 'string' || value.requestSha256.length !== 64 || !SHA256.test(value.requestSha256)) fail('Chat request digest is invalid.');
  return Object.freeze({
    summary: text(value.summary, 'Chat reply summary', true),
    answer: text(value.answer, 'Chat reply answer', true),
    clarifications: frozenArray(clarifications),
    completedAt: timestamp(value.completedAt, 'Chat reply time'),
    requestSha256: value.requestSha256,
    requestProfileVersion: value.requestProfileVersion,
  });
}

function parseTurn(value: unknown): ChatTurn {
  if (!object(value)) fail('Chat turn is invalid.');
  exactKeys(value, ['id', 'noteId', 'noteRevision', 'jobId', 'userText', 'createdAt', 'captureTimeZone'], ['capturedAt', 'messageOrigin', 'operation', 'reasoningEffort', 'parentTurnId', 'reply', 'replySha256']);
  const base = {
    id: uuid(value.id, 'Chat turn ID'),
    noteId: uuid(value.noteId, 'Chat note ID'),
    noteRevision: revision(value.noteRevision),
    jobId: uuid(value.jobId, 'Chat job ID'),
    userText: text(value.userText, 'Chat message'),
    createdAt: timestamp(value.createdAt, 'Chat turn time'),
    captureTimeZone: timeZone(value.captureTimeZone),
    ...(value.capturedAt !== undefined ? { capturedAt: timestamp(value.capturedAt, 'Chat capture time') } : {}),
    ...(value.messageOrigin !== undefined ? { messageOrigin: value.messageOrigin as 'saved_transcript' } : {}),
    ...(value.operation !== undefined ? { operation: value.operation as 'chat_refinement' } : {}),
    ...(value.reasoningEffort !== undefined ? { reasoningEffort: value.reasoningEffort as 'medium' | 'high' | 'max' } : {}),
    ...(value.parentTurnId !== undefined ? { parentTurnId: uuid(value.parentTurnId, 'Chat parent turn ID') } : {}),
  };
  if (value.messageOrigin !== undefined && (value.messageOrigin !== 'saved_transcript' || value.capturedAt === undefined)) {
    fail('Saved transcript message binding is invalid.');
  }
  if (value.operation !== undefined || value.reasoningEffort !== undefined || value.parentTurnId !== undefined) {
    if (value.operation !== 'chat_refinement' || typeof value.reasoningEffort !== 'string' || !['medium', 'high', 'max'].includes(value.reasoningEffort) ||
        typeof value.parentTurnId !== 'string' || value.capturedAt === undefined) fail('Chat refinement binding is invalid.');
  }
  if (value.operation === 'chat_refinement' && value.messageOrigin !== undefined) fail('Chat refinement cannot carry a saved transcript origin marker.');
  const hasReply = Object.prototype.hasOwnProperty.call(value, 'reply');
  const hasReplyDigest = Object.prototype.hasOwnProperty.call(value, 'replySha256');
  if (hasReply !== hasReplyDigest || (hasReplyDigest && (typeof value.replySha256 !== 'string' || value.replySha256.length !== 64 || !SHA256.test(value.replySha256)))) {
    fail('Chat reply digest binding is invalid.');
  }
  return Object.freeze(hasReply
    ? { ...base, reply: parseReply(value.reply), replySha256: value.replySha256 as string }
    : base);
}

function parseConversation(value: unknown): ChatConversation {
  if (!object(value)) fail('Chat conversation is invalid.');
  exactKeys(value, ['id', 'title', 'createdAt', 'updatedAt', 'turns']);
  const id = uuid(value.id, 'Chat conversation ID');
  const title = text(value.title, 'Chat conversation title');
  if (Array.from(title).length > 160) fail('Chat conversation title is too long.');
  const createdAt = timestamp(value.createdAt, 'Chat conversation creation time');
  const updatedAt = timestamp(value.updatedAt, 'Chat conversation update time');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail('Chat conversation timestamps are not monotonic.');
  const turns = validArray(value.turns, 'Chat turns').map(parseTurn);
  if (turns.some((turn) => Date.parse(turn.createdAt) < Date.parse(createdAt) || Date.parse(turn.createdAt) > Date.parse(updatedAt))) {
    fail('Chat turn timestamps are outside the conversation.');
  }
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.reply && (Date.parse(turn.reply.completedAt) < Date.parse(turn.createdAt) || Date.parse(turn.reply.completedAt) > Date.parse(updatedAt))) {
      fail('Chat reply timestamps are outside the conversation.');
    }
    if (index > 0 && Date.parse(turn.createdAt) < Date.parse(turns[index - 1].createdAt)) fail('Chat turn timestamps are not monotonic.');
  }
  return Object.freeze({ id, title, createdAt, updatedAt, turns: frozenArray(turns) });
}

export function emptyChatLedger(): ReadonlyChatLedger {
  return Object.freeze({ version: 1, conversations: Object.freeze([]) });
}

/** Strictly clones and freezes a chat ledger; it never repairs or normalizes saved values. */
export function validateChatLedger(value: unknown): ReadonlyChatLedger {
  if (!object(value)) fail('Chat ledger is invalid.');
  exactKeys(value, ['version', 'conversations']);
  if (value.version !== 1) fail('Chat ledger version is unsupported.');
  const conversations = validArray(value.conversations, 'Chat conversations').map(parseConversation);
  const conversationIds = new Set<string>();
  const turnIds = new Set<string>();
  const noteIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const conversation of conversations) {
    if (conversationIds.has(conversation.id)) fail('Chat conversation IDs must be unique.');
    conversationIds.add(conversation.id);
    for (const turn of conversation.turns) {
      if (turnIds.has(turn.id) || noteIds.has(turn.noteId) || jobIds.has(turn.jobId)) fail('Chat turn, note, and job references must be unique.');
      turnIds.add(turn.id); noteIds.add(turn.noteId); jobIds.add(turn.jobId);
    }
    for (let index = 0; index < conversation.turns.length; index += 1) {
      const turn = conversation.turns[index];
      if (turn.operation !== 'chat_refinement') continue;
      const parentIndex = conversation.turns.findIndex((candidate) => candidate.id === turn.parentTurnId);
      const parent = conversation.turns[parentIndex];
      if (parentIndex < 0 || parentIndex >= index || parent.userText !== turn.userText ||
          (parent.capturedAt ?? parent.createdAt) !== turn.capturedAt || parent.captureTimeZone !== turn.captureTimeZone) {
        fail('Chat refinement must preserve the exact parent message and capture anchor.');
      }
    }
  }
  const ledger = Object.freeze({ version: 1 as const, conversations: frozenArray(conversations) });
  let serialized: string;
  try { serialized = JSON.stringify(ledger); }
  catch { return fail('Chat ledger cannot be serialized.'); }
  if (recoveryUtf8Bytes(serialized, STATE_SNAPSHOT_READ_MAX_BYTES) > STATE_SNAPSHOT_READ_MAX_BYTES) fail('Chat ledger exceeds the saved-data size limit.');
  return ledger;
}

/** Selects only completed, currently eligible preceding jobs for model context. */
export function selectCompletedChatContext(
  conversation: ChatConversation,
  beforeTurnId: string,
  eligibleJobIds: ReadonlySet<string>,
  maxBytes: number,
): SelectedChatContext {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('Chat context byte limit is invalid.');
  const beforeIndex = conversation.turns.findIndex((turn) => turn.id === beforeTurnId);
  if (beforeIndex < 0) fail('The current chat turn is not in this conversation.');
  const priorTurns = conversation.turns.slice(0, beforeIndex);
  const candidates = priorTurns.filter((turn) => turn.reply && eligibleJobIds.has(turn.jobId));
  const selectedNewestFirst: ChatContextTurn[] = [];
  let includedBytes = 2; // JSON array brackets.
  let omittedTurnCount = priorTurns.length - candidates.length;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const turn = candidates[index];
    const assistantParts = [turn.reply!.answer || turn.reply!.summary, ...turn.reply!.clarifications].filter(Boolean);
    const candidate = Object.freeze({ turnId: turn.id, jobId: turn.jobId, userText: turn.userText, assistantText: assistantParts.join('\n') });
    const entryBytes = recoveryUtf8Bytes(JSON.stringify(candidate));
    const separatorBytes = selectedNewestFirst.length ? 1 : 0;
    if (includedBytes + separatorBytes + entryBytes <= maxBytes) {
      selectedNewestFirst.push(candidate);
      includedBytes += separatorBytes + entryBytes;
    } else omittedTurnCount += 1;
  }
  const turns = frozenArray(selectedNewestFirst.reverse());
  return Object.freeze({ turns, omittedTurnCount, includedBytes: turns.length ? includedBytes : 0 });
}
