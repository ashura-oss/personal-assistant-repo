import type { SelectedMailTextSnapshot } from '../core';

export const MAX_SELECTED_MAIL_TEXT_BYTES = 16 * 1024;
export const MAIL_TEXT_FRESHNESS_MS = 15 * 60_000;

export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).length; }

export function normalizeMailText(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

export function isCanonicalUtc(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function isMailTextFresh(snapshot: Pick<SelectedMailTextSnapshot, 'checkedAt'>, now = Date.now()): boolean {
  if (!isCanonicalUtc(snapshot.checkedAt) || !Number.isFinite(now)) return false;
  const age = now - Date.parse(snapshot.checkedAt);
  return age >= 0 && age < MAIL_TEXT_FRESHNESS_MS;
}

export function validSelectedMailTextSnapshot(value: unknown): value is SelectedMailTextSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<SelectedMailTextSnapshot>;
  if (item.version !== 1 || typeof item.messageId !== 'string' || !item.messageId || item.messageId.length > 256 ||
      typeof item.accountId !== 'string' || !item.accountId || item.accountId.length > 256 ||
      typeof item.identityKey !== 'string' || !item.identityKey || item.identityKey.length > 1200 ||
      !item.identity || typeof item.identity.subject !== 'string' || !item.identity.subject ||
      !Number.isSafeInteger(item.connectionGeneration) || item.connectionGeneration! < 0 ||
      typeof item.providerMessageId !== 'string' || !item.providerMessageId || item.providerMessageId.length > 1024 ||
      !['gmail', 'graph-immutable'].includes(item.idFormat ?? '') ||
      typeof item.sourceDigest !== 'string' || !/^[a-f\d]{64}$/i.test(item.sourceDigest) ||
      (item.providerVersion !== undefined && (typeof item.providerVersion !== 'string' || item.providerVersion.length > 512)) ||
      !isCanonicalUtc(item.checkedAt) || item.extractionVersion !== 'mail-text-v1' ||
      !['plain', 'snippet', 'none'].includes(item.representation ?? '') ||
      !['complete_text', 'excerpt', 'unavailable'].includes(item.completeness ?? '') ||
      !Number.isSafeInteger(item.bytes) || item.bytes! < 0 || item.bytes! > MAX_SELECTED_MAIL_TEXT_BYTES ||
      !Array.isArray(item.omissionReasons) || item.omissionReasons.length > 16 ||
      item.omissionReasons.some((reason) => typeof reason !== 'string' || !reason || reason.length > 240)) return false;
  if (item.text !== undefined && (typeof item.text !== 'string' || utf8Bytes(item.text) > MAX_SELECTED_MAIL_TEXT_BYTES || utf8Bytes(item.text) !== item.bytes)) return false;
  if (item.textDigest !== undefined && (typeof item.textDigest !== 'string' || !/^[a-f\d]{64}$/i.test(item.textDigest))) return false;
  if (item.completeness === 'unavailable') return item.representation === 'none' && item.bytes === 0 && item.text === undefined && item.textDigest === undefined;
  return typeof item.text === 'string' && typeof item.textDigest === 'string' &&
    (item.completeness !== 'complete_text' || item.representation === 'plain');
}
