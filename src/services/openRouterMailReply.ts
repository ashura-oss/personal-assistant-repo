import type { MailReplySourceSnapshot, SelectedMailTextSnapshot } from '../core';
import { canonicalMailReplySource } from '../mailReply';
import { utf8Bytes } from '../mailText';
import { OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_CHAT_COMPLETIONS_PATH, type OpenRouterBatchInspection } from './openRouter';

const SHA256 = /^[a-f0-9]{64}$/;
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
};

export interface OpenRouterMailReplyFrozenNote {
  readonly id: string;
  readonly revision: number;
  readonly text: string;
  readonly textSha256: string;
  readonly capturedAt: string;
  readonly captureTimeZone: string;
}

export interface OpenRouterMailReplyFrozenPolicy {
  readonly path: string;
  readonly revision: number;
  readonly content: string;
  readonly sha256: string;
}

export interface OpenRouterMailReplyBinding {
  readonly version: 1;
  readonly messageId: string;
  readonly mode: 'reply' | 'reply_all';
  readonly source: MailReplySourceSnapshot;
  readonly body: Readonly<{ text: string; textDigest: string; bytes: number; extractionVersion: SelectedMailTextSnapshot['extractionVersion'];
    representation: SelectedMailTextSnapshot['representation']; completeness: SelectedMailTextSnapshot['completeness']; omissionReasons: readonly string[] }>;
  readonly subject: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly brief: string;
  readonly note?: OpenRouterMailReplyFrozenNote;
  readonly policy: readonly OpenRouterMailReplyFrozenPolicy[];
  readonly settingsFingerprint: string;
  readonly settingsSnapshot: string;
  readonly requestAsOf: string;
  readonly timeZone: string;
}

export function validOpenRouterMailReplyBinding(value: unknown): value is OpenRouterMailReplyBinding {
  const row = object(value);
  if (!row || !exact(row, ['version', 'messageId', 'mode', 'source', 'body', 'subject', 'to', 'cc', 'brief', 'policy', 'settingsFingerprint', 'settingsSnapshot', 'requestAsOf', 'timeZone'], ['note']) ||
      row.version !== 1 || typeof row.messageId !== 'string' || !row.messageId || row.messageId.length > 256 ||
      !['reply', 'reply_all'].includes(String(row.mode)) || typeof row.subject !== 'string' || typeof row.brief !== 'string' ||
      typeof row.settingsFingerprint !== 'string' || row.settingsFingerprint.length !== 64 || !SHA256.test(row.settingsFingerprint) ||
      typeof row.settingsSnapshot !== 'string' || row.settingsSnapshot.length > 16 * 1024 ||
      typeof row.requestAsOf !== 'string' || !Number.isFinite(Date.parse(row.requestAsOf)) || new Date(row.requestAsOf).toISOString() !== row.requestAsOf ||
      typeof row.timeZone !== 'string' || !row.timeZone || row.timeZone.length > 128 ||
      !Array.isArray(row.to) || row.to.length > 100 || row.to.some((item) => typeof item !== 'string') ||
      !Array.isArray(row.cc) || row.cc.length > 100 || row.cc.some((item) => typeof item !== 'string') ||
      !Array.isArray(row.policy) || row.policy.length > 128) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: row.timeZone }).format(0);
    const sourceRow = object(row.source);
    const identity = object(sourceRow?.identity);
    if (!sourceRow || !identity || !exact(sourceRow, ['version', 'accountId', 'accountEmail', 'identity', 'connectionGeneration', 'localMessageId', 'providerMessageId', 'idFormat', 'internetMessageId', 'subject', 'replyMetadataComplete', 'observedAt', 'sourceDigest'], ['verifiedSelfEmail', 'providerVersion', 'threadId', 'references', 'inReplyTo', 'from', 'senderEmail', 'replyTo', 'to', 'cc', 'snippet']) ||
        !exact(identity, ['providerNamespace', 'clientId', 'subject'], ['issuer', 'tenantId', 'resourceUserId']) || typeof sourceRow.sourceDigest !== 'string' || sourceRow.sourceDigest.length !== 64 || !SHA256.test(sourceRow.sourceDigest)) return false;
    canonicalMailReplySource(row.source as MailReplySourceSnapshot);
  } catch { return false; }
  const source = object(row.source);
  if (!source || source.localMessageId !== row.messageId) return false;
  const body = object(row.body);
  if (!body || !exact(body, ['text', 'textDigest', 'bytes', 'extractionVersion', 'representation', 'completeness', 'omissionReasons']) ||
      typeof body.text !== 'string' || !body.text.trim() || typeof body.textDigest !== 'string' || body.textDigest.length !== 64 || !SHA256.test(body.textDigest) ||
      !Number.isSafeInteger(body.bytes) || (body.bytes as number) < 1 || (body.bytes as number) > 16 * 1024 || utf8Bytes(body.text) !== body.bytes || !validReplyText(body.text) ||
      !['mail-text-v1', 'mail-text-v2'].includes(String(body.extractionVersion)) ||
      !['plain', 'converted_html', 'snippet'].includes(String(body.representation)) ||
      !['complete_text', 'excerpt'].includes(String(body.completeness)) || !Array.isArray(body.omissionReasons) ||
      body.omissionReasons.length > 16 || body.omissionReasons.some((item) => typeof item !== 'string' || !item || item.length > 240) ||
      (body.representation === 'converted_html' && (body.extractionVersion !== 'mail-text-v2' || body.completeness !== 'excerpt')) ||
      (body.representation === 'snippet' && body.completeness !== 'excerpt') || (body.completeness === 'complete_text' && body.representation !== 'plain')) return false;
  if (row.note !== undefined) {
    const note = object(row.note);
    if (!note || !exact(note, ['id', 'revision', 'text', 'textSha256', 'capturedAt', 'captureTimeZone']) ||
        typeof note.id !== 'string' || !note.id || note.id.length > 512 || !Number.isSafeInteger(note.revision) || (note.revision as number) < 1 ||
        typeof note.text !== 'string' || !note.text.trim() || typeof note.textSha256 !== 'string' || note.textSha256.length !== 64 || !SHA256.test(note.textSha256) ||
        typeof note.capturedAt !== 'string' || !Number.isFinite(Date.parse(note.capturedAt)) || new Date(note.capturedAt).toISOString() !== note.capturedAt ||
        typeof note.captureTimeZone !== 'string' || !note.captureTimeZone || note.captureTimeZone.length > 128) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: note.captureTimeZone }).format(0); } catch { return false; }
  }
  const paths = new Set<string>();
  return row.policy.every((item) => {
    const policy = object(item);
    if (!policy || !exact(policy, ['path', 'revision', 'content', 'sha256']) ||
        typeof policy.path !== 'string' || !/^memory\/(?:RULES|ROUTINES)\.md$/i.test(policy.path) || paths.has(policy.path) ||
        !Number.isSafeInteger(policy.revision) || (policy.revision as number) < 1 || typeof policy.content !== 'string' ||
        typeof policy.sha256 !== 'string' || policy.sha256.length !== 64 || !SHA256.test(policy.sha256)) return false;
    paths.add(policy.path);
    return true;
  });
}

/** Strictly parses one inert Batch result. It never creates a proposal or performs side effects. */
export function parseOpenRouterMailReplyResult(inspection: OpenRouterBatchInspection, requestBody: string): { text: string; sha256Input: string } {
  const body = object(inspection.result?.responseBody);
  const choices = body?.choices;
  let request: Record<string, unknown> | undefined;
  try { request = object(JSON.parse(requestBody) as unknown); } catch { /* rejected below */ }
  const envelope = object(object(request?.response_format)?.json_schema);
  if (inspection.status !== 'completed' || inspection.metadataValidation !== 'valid' || inspection.resultValidation !== 'valid' ||
      inspection.endpoint !== OPENROUTER_CHAT_COMPLETIONS_PATH || inspection.model !== OPENROUTER_BATCH_BODY_MODEL ||
      !inspection.result || inspection.result.statusCode !== 200 || inspection.result.errorPresent || inspection.result.finishReason !== 'stop' ||
      !body || ![OPENROUTER_BATCH_BODY_MODEL, 'openai/gpt-6-luna-20260922'].includes(String(body.model)) ||
      envelope?.name !== 'mail_reply_body' || envelope.strict !== true || !Array.isArray(choices) || choices.length !== 1) {
    throw new Error('The mail reply Batch result was invalid.');
  }
  const choice = object(choices[0]);
  const message = object(choice?.message);
  if (!choice || choice.index !== 0 || choice.finish_reason !== 'stop' || !message || message.role !== 'assistant' ||
      message.refusal != null || typeof message.content !== 'string') throw new Error('The mail reply Batch result was invalid.');
  let parsed: unknown;
  try { parsed = JSON.parse(message.content) as unknown; } catch { throw new Error('The mail reply Batch result was invalid.'); }
  const result = object(parsed);
  if (!result || !exact(result, ['text']) || typeof result.text !== 'string' || !validReplyText(result.text)) throw new Error('The mail reply Batch result was invalid.');
  return { text: result.text, sha256Input: result.text };
}

export function validReplyText(text: string): boolean {
  if (!text.trim() || text.length > 100_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
