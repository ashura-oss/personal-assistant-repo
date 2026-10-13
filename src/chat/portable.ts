import { validateChatLedger } from './ledger';
import type { ChatReplySnapshot, ReadonlyChatLedger } from './types';
import { validateOpenRouterBatchLedger } from '../services/openRouterBatchJobs';
import type { OpenRouterBatchLedger, OpenRouterBatchJob } from '../services/openRouterBatchJobs';

export const PORTABLE_CHAT_HISTORY_VERSION = 1 as const;
export const PORTABLE_CHAT_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
export const IMPORTED_CHAT_HISTORY_ORIGIN = 'portable_backup_unverified' as const;

export type PortableChatAccounting = Readonly<{
  costUsd?: number;
  isByok?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}>;

export type PortableChatReply = Readonly<{
  summary: string;
  answer: string;
  clarifications: readonly string[];
  completedAt: string;
}>;

export type PortableChatTurn = Readonly<{
  userText: string;
  createdAt: string;
  capturedAt: string;
  captureTimeZone: string;
  reply?: PortableChatReply;
  accounting?: PortableChatAccounting;
}>;

export type PortableChatConversation = Readonly<{
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: readonly PortableChatTurn[];
}>;

/** Content-only history. It deliberately contains no local source or execution identifiers. */
export type PortableChatHistory = Readonly<{
  version: typeof PORTABLE_CHAT_HISTORY_VERSION;
  conversations: readonly PortableChatConversation[];
}>;

export type InertImportedChatTurn = PortableChatTurn & Readonly<{
  id: string;
  origin: typeof IMPORTED_CHAT_HISTORY_ORIGIN;
}>;

export type InertImportedChatConversation = Readonly<{
  id: string;
  origin: typeof IMPORTED_CHAT_HISTORY_ORIGIN;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: readonly InertImportedChatTurn[];
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const ACCOUNTING_KEYS = ['costUsd', 'isByok', 'promptTokens', 'completionTokens', 'totalTokens'] as const;

function fail(message: string): never { throw new Error(message); }
function object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => {
    if (typeof key !== 'string' || !allowed.has(key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
  }) || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) fail('Portable Chat history contains an unknown or missing field.');
}
function denseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain array.`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) ||
      keys.filter((key) => key !== 'length').length !== value.length ||
      keys.some((key) => key !== 'length' && (typeof key !== 'string' || (() => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
      })()))) fail(`${label} must be a plain dense array.`);
  return value;
}
function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || CONTROL.test(value) || hasUnpairedSurrogate(value)) fail(`${label} is invalid.`);
  return value;
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length !== 24 || !CANONICAL_ISO.test(value)) fail(`${label} must be canonical ISO time.`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(`${label} is invalid.`);
  return value;
}
function zone(value: unknown): string {
  const result = text(value, 'Chat capture time zone');
  if (result.length > 128) fail('Chat capture time zone is too long.');
  try { new Intl.DateTimeFormat('en', { timeZone: result }).format(0); }
  catch { fail('Chat capture time zone is invalid.'); }
  return result;
}
function tokens(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} is invalid.`);
  return Number(value);
}
function accounting(value: unknown): PortableChatAccounting {
  if (!object(value)) fail('Portable Chat accounting is invalid.');
  exactKeys(value, [], ACCOUNTING_KEYS);
  const result: { costUsd?: number; isByok?: boolean; promptTokens?: number; completionTokens?: number; totalTokens?: number } = {};
  if (Object.prototype.hasOwnProperty.call(value, 'costUsd')) {
    if (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0) fail('Portable Chat cost is invalid.');
    result.costUsd = value.costUsd;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'isByok')) {
    if (typeof value.isByok !== 'boolean') fail('Portable Chat BYOK flag is invalid.');
    result.isByok = value.isByok;
  }
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = tokens(value[key], `Portable Chat ${key}`);
  }
  return Object.freeze(result);
}
function parseReply(value: unknown): PortableChatReply {
  if (!object(value)) fail('Portable Chat reply is invalid.');
  exactKeys(value, ['summary', 'answer', 'clarifications', 'completedAt']);
  const clarifications = denseArray(value.clarifications, 'Portable Chat clarifications').map((item) => text(item, 'Portable Chat clarification'));
  if (clarifications.length > 10 || clarifications.some((item) => item.length > 1000)) fail('Portable Chat clarifications exceed the supported structure.');
  return Object.freeze({ summary: text(value.summary, 'Portable Chat summary', true), answer: text(value.answer, 'Portable Chat answer', true),
    clarifications: Object.freeze(clarifications), completedAt: timestamp(value.completedAt, 'Portable Chat reply time') });
}
function parseTurn(value: unknown, conversationCreated: string, conversationUpdated: string): PortableChatTurn {
  if (!object(value)) fail('Portable Chat turn is invalid.');
  exactKeys(value, ['userText', 'createdAt', 'capturedAt', 'captureTimeZone'], ['reply', 'accounting']);
  const createdAt = timestamp(value.createdAt, 'Portable Chat turn time');
  const capturedAt = timestamp(value.capturedAt, 'Portable Chat capture time');
  if (Date.parse(createdAt) < Date.parse(conversationCreated) || Date.parse(createdAt) > Date.parse(conversationUpdated) || Date.parse(capturedAt) > Date.parse(createdAt)) {
    fail('Portable Chat turn times are outside their conversation.');
  }
  const reply = value.reply === undefined ? undefined : parseReply(value.reply);
  if (reply && (Date.parse(reply.completedAt) < Date.parse(createdAt) || Date.parse(reply.completedAt) > Date.parse(conversationUpdated))) fail('Portable Chat reply time is outside its conversation.');
  return Object.freeze({ userText: text(value.userText, 'Portable Chat message'), createdAt, capturedAt, captureTimeZone: zone(value.captureTimeZone),
    ...(reply ? { reply } : {}), ...(value.accounting !== undefined ? { accounting: accounting(value.accounting) } : {}) });
}

/** Validates and returns an inert content-only Chat backup value. No field is repaired or truncated. */
export function validatePortableChatHistory(value: unknown, maxBytes = PORTABLE_CHAT_HISTORY_MAX_BYTES): PortableChatHistory {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('Portable Chat byte limit is invalid.');
  if (!object(value)) fail('Portable Chat history must be an object.');
  exactKeys(value, ['version', 'conversations']);
  if (value.version !== PORTABLE_CHAT_HISTORY_VERSION) fail('Portable Chat history version is unsupported.');
  const conversations = denseArray(value.conversations, 'Portable Chat conversations').map((entry) => {
    if (!object(entry)) fail('Portable Chat conversation is invalid.');
    exactKeys(entry, ['title', 'createdAt', 'updatedAt', 'turns']);
    const createdAt = timestamp(entry.createdAt, 'Portable Chat conversation time');
    const updatedAt = timestamp(entry.updatedAt, 'Portable Chat update time');
    if (Date.parse(updatedAt) < Date.parse(createdAt)) fail('Portable Chat conversation times are not monotonic.');
    const turns = denseArray(entry.turns, 'Portable Chat turns').map((turn) => parseTurn(turn, createdAt, updatedAt));
    for (let index = 1; index < turns.length; index += 1) {
      if (Date.parse(turns[index]!.createdAt) < Date.parse(turns[index - 1]!.createdAt)) fail('Portable Chat turns are not chronological.');
    }
    return Object.freeze({ title: text(entry.title, 'Portable Chat title'), createdAt, updatedAt, turns: Object.freeze(turns) });
  });
  const result: PortableChatHistory = Object.freeze({ version: PORTABLE_CHAT_HISTORY_VERSION, conversations: Object.freeze(conversations) });
  let serialized: string;
  try { serialized = JSON.stringify(result); } catch { fail('Portable Chat history cannot be serialized.'); }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) fail('Portable Chat history exceeds the file size limit.');
  return result;
}

export function serializePortableChatHistory(value: unknown, maxBytes = PORTABLE_CHAT_HISTORY_MAX_BYTES): string {
  return JSON.stringify(validatePortableChatHistory(value, maxBytes));
}

function projectedAccounting(job: OpenRouterBatchJob): PortableChatAccounting | undefined {
  const source = job.accounting;
  if (!source) return undefined;
  const result: { costUsd?: number; isByok?: boolean; promptTokens?: number; completionTokens?: number; totalTokens?: number } = {};
  if (source.providerReportedCostUsd !== undefined) result.costUsd = source.providerReportedCostUsd;
  if (source.byok !== undefined) result.isByok = source.byok;
  if (source.promptTokens !== undefined) result.promptTokens = source.promptTokens;
  if (source.completionTokens !== undefined) result.completionTokens = source.completionTokens;
  if (source.totalTokens !== undefined) result.totalTokens = source.totalTokens;
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}

/**
 * Projects validated private ledgers to content-only history. The caller supplies the
 * digest verifier so this module never owns crypto or trusts public Chat DTOs.
 */
export async function createPortableChatHistory(
  ledgerValue: ReadonlyChatLedger,
  batchLedgerValue: OpenRouterBatchLedger,
  verifyReplyDigest: (reply: ChatReplySnapshot, digest: string) => Promise<boolean>,
): Promise<PortableChatHistory> {
  if (typeof verifyReplyDigest !== 'function') fail('Chat reply verification is required for export.');
  const ledger = validateChatLedger(ledgerValue);
  const batchLedger = validateOpenRouterBatchLedger(batchLedgerValue);
  const jobs = new Map(batchLedger.jobs.map((job) => [job.id, job]));
  const verified = new Map<string, Promise<boolean>>();
  const verifyTurn = (turn: ReadonlyChatLedger['conversations'][number]['turns'][number]): Promise<boolean> => {
    if (!turn.reply || !turn.replySha256) return Promise.resolve(false);
    let check = verified.get(turn.id);
    if (!check) {
      check = Promise.resolve().then(() => verifyReplyDigest(turn.reply!, turn.replySha256!));
      verified.set(turn.id, check);
    }
    return check;
  };
  const conversations: PortableChatConversation[] = [];
  for (const conversation of ledger.conversations) {
    const turns: PortableChatTurn[] = [];
    const turnById = new Map(conversation.turns.map((turn) => [turn.id, turn]));
    for (const turn of conversation.turns) {
      const job = jobs.get(turn.jobId);
      if (!job || job.kind !== 'note_assistance' || job.sourceRemoved && turn.reply) fail('Chat history could not be linked to its validated job receipt.');
      if (job.sourceRemoved !== true && (!job.chatBinding || job.chatBinding.conversationId !== conversation.id || job.chatBinding.turnId !== turn.id ||
          job.noteId !== turn.noteId || job.noteRevision !== turn.noteRevision || job.capturedAt !== turn.createdAt || job.captureTimeZone !== turn.captureTimeZone)) {
        fail('Chat history could not be linked to its validated request.');
      }
      if (turn.reply) {
        if (job.status !== 'completed' || job.sourceRemoved || job.requestSha256 !== turn.reply.requestSha256 || job.requestProfileVersion !== turn.reply.requestProfileVersion ||
            !(await verifyTurn(turn))) fail('A Chat reply did not pass its immutable digest check.');
      }
      if (job.chatBinding) {
        let priorIndex = -1;
        for (const reference of job.chatBinding.context) {
          const index = conversation.turns.findIndex((candidate) => candidate.id === reference.turnId);
          const prior = turnById.get(reference.turnId);
          const priorJob = prior && jobs.get(prior.jobId);
          if (index < 0 || index <= priorIndex || index >= conversation.turns.indexOf(turn) || !prior?.reply || !priorJob || priorJob.status !== 'completed' || priorJob.sourceRemoved ||
              prior.jobId !== reference.jobId || prior.noteId !== reference.noteId || prior.noteRevision !== reference.noteRevision || prior.replySha256 !== reference.replySha256 ||
              prior.reply.requestProfileVersion !== reference.replyProfileVersion || priorJob.requestSha256 !== prior.reply.requestSha256 || !(await verifyTurn(prior))) {
            fail('Chat history contains an unverifiable frozen context reference.');
          }
          priorIndex = index;
        }
      }
      const reply = turn.reply ? Object.freeze({ summary: turn.reply.summary, answer: turn.reply.answer,
        clarifications: Object.freeze([...turn.reply.clarifications]), completedAt: turn.reply.completedAt }) : undefined;
      const receipt = projectedAccounting(job);
      turns.push(Object.freeze({ userText: turn.userText, createdAt: turn.createdAt, capturedAt: turn.createdAt, captureTimeZone: turn.captureTimeZone,
        ...(reply ? { reply } : {}), ...(receipt ? { accounting: receipt } : {}) }));
    }
    conversations.push(Object.freeze({ title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, turns: Object.freeze(turns) }));
  }
  return validatePortableChatHistory({ version: PORTABLE_CHAT_HISTORY_VERSION, conversations });
}

/** Materializes inert, read-only archive DTOs with fresh local IDs and no execution links. */
export function materializeInertChatHistory(
  value: unknown,
  createId: () => string,
  existingIds: ReadonlySet<string> = new Set(),
  maxBytes = PORTABLE_CHAT_HISTORY_MAX_BYTES,
): readonly InertImportedChatConversation[] {
  if (typeof createId !== 'function') fail('A local ID factory is required.');
  const payload = validatePortableChatHistory(value, maxBytes);
  const used = new Set(existingIds);
  const freshId = (): string => {
    const id = createId();
    if (typeof id !== 'string' || id.length !== 36 || !UUID_V4.test(id) || used.has(id)) fail('Imported Chat history ID allocation collided.');
    used.add(id);
    return id;
  };
  return Object.freeze(payload.conversations.map((conversation) => Object.freeze({
    id: freshId(), origin: IMPORTED_CHAT_HISTORY_ORIGIN, title: conversation.title,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    turns: Object.freeze(conversation.turns.map((turn) => Object.freeze({ ...turn, id: freshId(), origin: IMPORTED_CHAT_HISTORY_ORIGIN }))),
  })));
}
