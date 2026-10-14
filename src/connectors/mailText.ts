import { convertHtmlToText } from './htmlText';

export type MailTextRepresentation = 'plain' | 'converted_html' | 'snippet' | 'none';
export type MailTextCompleteness = 'complete_text' | 'excerpt' | 'unavailable';

export interface MailTextExtraction {
  text?: string;
  bytes: number;
  representation: MailTextRepresentation;
  completeness: MailTextCompleteness;
  reasons: string[];
}

const MAX_TEXT_BYTES = 16 * 1024;
const MAX_ALLOWED_TEXT_BYTES = 256 * 1024;
const MAX_MIME_DEPTH = 12;
const MAX_MIME_PARTS = 128;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function boundedText(value: string, maxBytes = MAX_TEXT_BYTES): { text: string; truncated: boolean } {
  let text = '';
  let bytes = 0;
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > maxBytes) return { text, truncated: true };
    text += character;
    bytes += size;
  }
  return { text, truncated: false };
}

function decodeBase64Url(value: string): Uint8Array {
  if (value === '') return new Uint8Array(0);
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error('malformed_base64');
  const split = value.indexOf('=');
  const raw = split < 0 ? value : value.slice(0, split);
  const suppliedPadding = split < 0 ? 0 : value.length - split;
  if (raw.length % 4 === 1) throw new Error('malformed_base64');
  const requiredPadding = (4 - raw.length % 4) % 4;
  if (suppliedPadding && suppliedPadding !== requiredPadding) throw new Error('malformed_base64');
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(requiredPadding);
  let binary: string;
  try { binary = atob(normalized); } catch { throw new Error('malformed_base64'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  const normalized = (charset ?? 'utf-8').trim().toLowerCase().replace(/^['"]|['"]$/g, '');
  if (!['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(normalized)) throw new Error('unsupported_charset');
  if (normalized === 'us-ascii' || normalized === 'ascii') {
    if (bytes.some((byte) => byte > 0x7f)) throw new Error('invalid_ascii');
  }
  try { return new TextDecoder(normalized === 'utf8' ? 'utf-8' : normalized, { fatal: true }).decode(bytes); }
  catch { throw new Error('malformed_text'); }
}

function charsetFor(part: Record<string, unknown>): string | undefined {
  if (!Array.isArray(part.headers)) return undefined;
  for (const raw of part.headers) {
    if (!record(raw) || typeof raw.name !== 'string' || typeof raw.value !== 'string' || raw.name.toLowerCase() !== 'content-type') continue;
    const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(raw.value);
    return match?.[1] ?? match?.[2] ?? match?.[3];
  }
  return undefined;
}

function disposition(part: Record<string, unknown>): string {
  if (!Array.isArray(part.headers)) return '';
  const header = part.headers.find((raw) => record(raw) && typeof raw.name === 'string' && raw.name.toLowerCase() === 'content-disposition');
  return record(header) && typeof header.value === 'string' ? header.value.toLowerCase() : '';
}

interface Candidate { text?: string; representation: 'plain' | 'converted_html'; htmlData?: string; htmlCharset?: string; }
interface VisitResult { candidate?: Candidate; reasons: Set<string>; incomplete: boolean; }

/** Extracts bounded selected-message text with deferred HTML conversion; attachments are never fetched and HTML is never rendered. */
export function extractGmailMessageText(payload: unknown, snippet?: string, maxTextBytes = MAX_TEXT_BYTES): MailTextExtraction {
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > MAX_ALLOWED_TEXT_BYTES) throw new Error('Mail text output bound is invalid.');
  const limitReasons = new Set<string>();
  let visited = 0;
  let limitHit = false;

  const emptyResult = (): VisitResult => ({ reasons: new Set(), incomplete: false });
  const convertHtmlCandidate = (candidate: Candidate): VisitResult => {
    if (candidate.htmlData === undefined) return { candidate, reasons: new Set(), incomplete: false };
    try {
      const html = decodeText(decodeBase64Url(candidate.htmlData), candidate.htmlCharset);
      const converted = convertHtmlToText(html, maxTextBytes);
      return { candidate: converted.text.trim() ? { text: converted.text, representation: 'converted_html' } : undefined,
        reasons: new Set(converted.reasons), incomplete: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'malformed_text';
      return { reasons: new Set([reason]), incomplete: true };
    }
  };

  const visit = (value: unknown, depth: number): VisitResult => {
    if (depth > MAX_MIME_DEPTH) { limitReasons.add('mime_depth_limit'); limitHit = true; return emptyResult(); }
    visited++;
    if (visited > MAX_MIME_PARTS) { limitReasons.add('mime_part_limit'); limitHit = true; return emptyResult(); }
    if (!record(value)) return { reasons: new Set(['malformed_mime_part']), incomplete: true };
    const part = value;
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const filename = typeof part.filename === 'string' ? part.filename : '';
    const body = record(part.body) ? part.body : {};
    if (mimeType === 'message/rfc822') return { reasons: new Set(['embedded_message_omitted']), incomplete: false };
    const contentDisposition = disposition(part);
    if (filename || /(?:^|;)\s*attachment(?:;|$)/i.test(contentDisposition) || /(?:^|;)\s*filename\*?\s*=/i.test(contentDisposition)) {
      return { reasons: new Set(['attachment_omitted']), incomplete: false };
    }
    if (typeof body.attachmentId === 'string' && body.attachmentId) {
      return { reasons: new Set(['attachment_body_unavailable']), incomplete: mimeType === 'text/plain' || mimeType === 'text/html' };
    }

    if (mimeType.startsWith('multipart/')) {
      if (!Array.isArray(part.parts)) return { reasons: new Set(['malformed_mime_parts']), incomplete: true };
      const results: VisitResult[] = [];
      for (const child of part.parts) {
        if (limitHit) break;
        results.push(visit(child, depth + 1));
      }
      const candidates = results.map((result, index) => ({ result, index })).filter(({ result }) => result.candidate !== undefined);
      const plain = candidates.filter(({ result }) => result.candidate?.representation === 'plain');
      const nonblankPlain = plain.find(({ result }) => Boolean(result.candidate?.text?.trim()));
      const html = candidates.find(({ result }) => result.candidate?.representation === 'converted_html');
      const mergeReasons = (selected: VisitResult, includeSiblings: boolean): VisitResult => {
        const merged = new Set(selected.reasons);
        let incomplete = selected.incomplete;
        if (includeSiblings) {
          for (const result of results) {
            if (result === selected) continue;
            for (const reason of result.reasons) merged.add(reason);
            incomplete ||= result.incomplete;
          }
        }
        return { ...selected, reasons: merged, incomplete };
      };
      if (mimeType === 'multipart/alternative') {
        if (nonblankPlain) {
          const selected = mergeReasons(nonblankPlain.result, false);
          if (plain.some((branch) => branch !== nonblankPlain)) { selected.reasons.add('additional_text_part_omitted'); selected.incomplete = true; }
          return selected;
        }
        if (html) {
          const selected = mergeReasons(html.result, false);
          if (plain.length) { selected.reasons.add('additional_text_part_omitted'); selected.incomplete = true; }
          return selected;
        }
        const firstPlain = plain[0];
        if (firstPlain) {
          const selected = mergeReasons(firstPlain.result, false);
          if (plain.length > 1) { selected.reasons.add('additional_text_part_omitted'); selected.incomplete = true; }
          return selected;
        }
        const failed = emptyResult();
        for (const result of results) { for (const reason of result.reasons) failed.reasons.add(reason); failed.incomplete ||= result.incomplete; }
        return failed;
      }
      const selected = nonblankPlain ?? html ?? plain[0];
      if (selected) {
        const merged = mergeReasons(selected.result, true);
        if (candidates.length > 1) { merged.reasons.add('additional_text_part_omitted'); merged.incomplete = true; }
        return merged;
      }
      const failed = emptyResult();
      for (const result of results) { for (const reason of result.reasons) failed.reasons.add(reason); failed.incomplete ||= result.incomplete; }
      return failed;
    }
    if (mimeType === 'text/html') {
      if (typeof body.data !== 'string') return { reasons: new Set(['html_data_missing']), incomplete: true };
      return { candidate: { representation: 'converted_html', htmlData: body.data, htmlCharset: charsetFor(part) }, reasons: new Set(), incomplete: false };
    }
    if (mimeType !== 'text/plain') return emptyResult();
    if (typeof body.data !== 'string') return { reasons: new Set(['plain_text_data_missing']), incomplete: true };
    try {
      const decoded = decodeText(decodeBase64Url(body.data), charsetFor(part));
      return { candidate: { text: decoded, representation: 'plain' }, reasons: new Set(), incomplete: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'malformed_text';
      return { reasons: new Set([reason]), incomplete: true };
    }
  };

  let result = visit(payload, 0);
  if (result.candidate?.representation === 'converted_html') {
    const converted = convertHtmlCandidate(result.candidate);
    result = { candidate: converted.candidate, reasons: new Set([...result.reasons, ...converted.reasons]), incomplete: result.incomplete || converted.incomplete };
  }
  const reasons = new Set([...limitReasons, ...result.reasons]);
  const candidate = result.candidate;
  let text = candidate?.text;
  let representation: MailTextRepresentation = candidate?.representation ?? 'plain';
  let completeness: MailTextCompleteness = candidate?.representation === 'converted_html' ? 'excerpt' : 'complete_text';
  if (text === undefined || (!text.trim() && typeof snippet === 'string' && snippet.trim())) {
    if (typeof snippet === 'string' && snippet.trim()) {
      const bounded = boundedText(snippet, maxTextBytes);
      text = bounded.text;
      representation = 'snippet';
      completeness = 'excerpt';
      reasons.add('snippet_fallback');
      if (bounded.truncated) reasons.add('text_byte_limit');
    } else {
      return { bytes: 0, representation: 'none', completeness: 'unavailable', reasons: [...reasons].slice(0, 16) };
    }
  } else {
    const bounded = boundedText(text, maxTextBytes);
    text = bounded.text;
    if (bounded.truncated) { completeness = 'excerpt'; reasons.add('text_byte_limit'); }
    if (limitHit || result.incomplete) completeness = 'excerpt';
  }
  const bytes = utf8Bytes(text);
  return { text, bytes, representation, completeness, reasons: [...reasons].slice(0, 16) };
}

export function boundGraphText(text: string, maxTextBytes = MAX_TEXT_BYTES): MailTextExtraction {
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > MAX_ALLOWED_TEXT_BYTES) throw new Error('Mail text output bound is invalid.');
  const bounded = boundedText(text, maxTextBytes);
  return { text: bounded.text, bytes: utf8Bytes(bounded.text), representation: 'plain',
    completeness: bounded.truncated ? 'excerpt' : 'complete_text', reasons: bounded.truncated ? ['text_byte_limit'] : [] };
}

export function extractGraphHtmlText(html: string, maxTextBytes = MAX_TEXT_BYTES): MailTextExtraction {
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > MAX_ALLOWED_TEXT_BYTES) throw new Error('Mail text output bound is invalid.');
  const converted = convertHtmlToText(html, maxTextBytes);
  if (!converted.text.trim()) return { bytes: 0, representation: 'none', completeness: 'unavailable', reasons: converted.reasons };
  const bounded = boundedText(converted.text, maxTextBytes);
  const reasons = [...converted.reasons];
  if (bounded.truncated) reasons.push('text_byte_limit');
  return { text: bounded.text, bytes: utf8Bytes(bounded.text), representation: 'converted_html', completeness: 'excerpt', reasons: reasons.slice(0, 16) };
}
