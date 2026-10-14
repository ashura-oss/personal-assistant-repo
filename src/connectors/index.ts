import type { Account, AccountCapability, EmailProposalPayload, EventProposalPayload } from '../core';
import { canonicalMailReplySource, replyReferences as frozenReplyReferences, validateReplyBinding, type MailReplyProvenance } from '../mailReply';
import { boundGraphText, extractGmailMessageText, extractGraphHtmlText, type MailTextCompleteness, type MailTextRepresentation } from './mailText';
import { scopeGrantsCapability } from './oauth';

const GOOGLE_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_CALENDAR = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 3;
const MAX_DETAILS = 10;
const MAX_PAGE_SIZE = 50;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_SELECTED_MESSAGE_BYTES = 256 * 1024;
const MAX_SELECTED_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONVERSATION_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONVERSATION_PAGE_SIZE = 50;
const SELECTED_SIZE_FRESH_MS = 15 * 60 * 1000;

export interface StoredOAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  identity: NonNullable<Account['identity']>;
}

/** Result expected from an OAuth bridge after provider identity/resource verification. */
export interface OAuthBridgeResult {
  provider: Extract<Account['provider'], 'google' | 'microsoft'>;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  grantedScopes: string[];
  requestedCapabilities: AccountCapability[];
  identity: NonNullable<Account['identity']>;
  displayName: string;
  email?: string;
  capabilities: AccountCapability[];
}

export interface OAuthTokenStore {
  get(tokenRef: string): Promise<StoredOAuthToken | null>;
  set(tokenRef: string, token: StoredOAuthToken): Promise<void>;
  /** Optional for callers that own account disconnect; token erasure must use this actual store operation. */
  delete?(tokenRef: string): Promise<void>;
}

export interface ConnectorDependencies {
  fetcher?: typeof fetch;
  tokenStore: OAuthTokenStore;
  googleClientId?: string;
  microsoftClientId?: string;
  /** Authority selected during app configuration: a supported alias or verified tenant UUID. */
  microsoftAuthority?: string;
  onAuthStatus?: (accountId: string, status: Account['authStatus']) => Promise<void> | void;
  now?: () => number;
  requestTimeoutMs?: number;
  sha256?: (bytes: Uint8Array) => Promise<string>;
  loadAttachment?: (id: string) => Promise<Uint8Array>;
  isConnectionCurrent?: (account: Account) => boolean;
  /** Holds the independent privacy writer lease through the raw provider request and full response read. */
  withProviderOwnership?: <T>(actual: () => Promise<T>) => Promise<T>;
}

export interface ApprovedDispatch {
  proposalId: string;
  revision: number;
  sourceRevision?: number;
  operation: 'draft' | 'send' | 'event';
  accountId: string;
  identity: NonNullable<Account['identity']>;
  payloadDigest: string;
  title: string;
  body: string;
  calendarId?: string;
  payload: EmailProposalPayload | EventProposalPayload;
  replySource?: MailReplyProvenance;
}

export interface DispatchVerifier {
  verify(envelope: ApprovedDispatch): Promise<boolean>;
  /** Synchronous final check after async preparation and token refresh, immediately before dispatch. */
  verifyBeforeDispatch(envelope: ApprovedDispatch): boolean;
}

export type MutationReceipt = { status: 'accepted'; id?: string; replyDraftCheck?: 'matches_approved' | 'differs' | 'unverified' } | { status: 'unknown' };

/** Provider returned a definite non-success HTTP response. */
export class ProviderHttpError extends Error {
  constructor(readonly status: number, message = `Provider request failed (${status}).`) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/** A write reached the provider and received a definitive client-error rejection. */
export class ProviderWriteRejectedError extends ProviderHttpError {
  readonly code = 'provider_rejected' as const;
  readonly dispatched = true as const;
  constructor(status: number) {
    super(status, `Provider rejected the write (${status}).`);
    this.name = 'ProviderWriteRejectedError';
  }
}

/** Background read policy can skip an expired/rejected access token without refresh or auth mutation. */
export class ProviderAccessTokenUnavailableError extends Error {
  readonly code = 'provider_token_unavailable' as const;
  constructor() { super('Provider access token is unavailable.'); this.name = 'ProviderAccessTokenUnavailableError'; }
}

class ProviderResponseTooLargeError extends Error {
  constructor() { super('Provider response exceeded the selected-message response bound.'); this.name = 'ProviderResponseTooLargeError'; }
}

export interface MessageSummary {
  id: string;
  idFormat?: 'gmail' | 'graph-immutable';
  threadId?: string;
  subject?: string;
  from?: string;
  senderEmail?: string;
  isRead?: boolean;
  isDraft?: boolean;
  receivedAt?: string;
  sentAt?: string;
  snippet?: string;
  replyMetadataComplete?: boolean;
  internetMessageId?: string;
  providerVersion?: string;
  sizeEstimate?: number;
  sizeCheckedAt?: string;
  replyTo?: string[];
  to?: string[];
  cc?: string[];
  references?: string;
  inReplyTo?: string;
  headers?: { name: string; value: string }[];
}

export interface SelectedMessageTextResult {
  status: 'available' | 'unavailable';
  message?: MessageSummary;
  text?: string;
  bytes: number;
  representation: MailTextRepresentation;
  completeness: MailTextCompleteness;
  reasons: string[];
  checkedAt: string;
  extractionVersion: 'mail-text-v1' | 'mail-text-v2';
}

export interface ConversationMessagesResult {
  messages: MessageSummary[];
  nextCursor?: string;
  coverage: 'complete_metadata' | 'partial';
  omissionReasons: string[];
}

export interface MessageWindow {
  from: string;
  to: string;
}

export interface MessageWindowQueryInput {
  timeMin: string;
  timeMax: string;
  pageSize?: number;
}

export interface MessageWindowQueryDescriptor {
  window: MessageWindow;
  pageSize: number;
  queryFingerprint: string;
}

/** Canonical provider/account/window/page-size binding used for continuation cursors. */
export function describeMessageWindowQuery(account: Account, input: MessageWindowQueryInput): MessageWindowQueryDescriptor {
  const fromMs = Date.parse(input.timeMin);
  const toMs = Date.parse(input.timeMax);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > 366 * 86_400_000) {
    throw new Error('Mail sync window must be a valid range of at most one year.');
  }
  const window = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  const requestedSize = Math.floor(input.pageSize ?? 5);
  const pageSize = Number.isFinite(requestedSize) ? Math.max(1, Math.min(10, requestedSize)) : 5;
  const identity = accountIdentity(account);
  const queryFingerprint = JSON.stringify(['mail-window-v1', account.provider, identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? '', window.from, window.to, pageSize]);
  return { window, pageSize, queryFingerprint };
}

export function messageWindowQueryFingerprint(account: Account, input: MessageWindowQueryInput): string {
  return describeMessageWindowQuery(account, input).queryFingerprint;
}

export interface MessageWindowSyncResult {
  items: MessageSummary[];
  nextCursor?: string;
  partial: boolean;
  window: MessageWindow;
  queryFingerprint: string;
  unavailableIds: string[];
}

export interface MessageWindowPageMetadata {
  unavailableIds: string[];
  window: MessageWindow;
  queryFingerprint: string;
}
export type MessageWindowPageCallback = (items: MessageSummary[], nextCursor: string | undefined, pagesRead: number, metadata: MessageWindowPageMetadata) => void | Promise<void>;

export interface SyncPage<T> {
  items: T[];
  nextCursor?: string;
  pagesRead: number;
  partial: boolean;
}
export type RequestGuard = () => void;
export type PageCallback<T> = (items: T[], nextCursor: string | undefined, pagesRead: number) => void | Promise<void>;

export interface CalendarSummary { id: string; name: string; writable: boolean; }
export interface CalendarEventSummary { id: string; subject?: string; start?: string; end?: string; timeZone?: string; startUtcCertified?: boolean; endUtcCertified?: boolean; }

const refreshLocks = new WeakMap<OAuthTokenStore, Map<string, Promise<StoredOAuthToken>>>();
const credentialLocks = new WeakMap<OAuthTokenStore, Map<string, Promise<void>>>();

/** Serializes refresh, reconnect installation, and deletion for one stored provider credential. */
export async function withCredentialLock<T>(store: OAuthTokenStore, tokenRef: string, work: () => Promise<T>): Promise<T> {
  let locks = credentialLocks.get(store);
  if (!locks) { locks = new Map(); credentialLocks.set(store, locks); }
  const previous = locks.get(tokenRef) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  const queuedTail = previous.catch(() => undefined).then(() => tail);
  locks.set(tokenRef, queuedTail);
  await previous.catch(() => undefined);
  try { return await work(); }
  finally {
    release();
    if (locks.get(tokenRef) === queuedTail) locks.delete(tokenRef);
  }
}

function accountIdentity(account: Account): NonNullable<Account['identity']> {
  if (!account.tokenRef || !account.identity?.subject || account.identity.providerNamespace !== account.provider || !account.identity.clientId ||
      (account.provider === 'microsoft' && !account.identity.resourceUserId)) throw new Error('Account identity is not connected.');
  return account.identity;
}

function assertIdentity(account: Account, token: StoredOAuthToken): void {
  const expected = accountIdentity(account);
  if (!sameIdentity(token.identity, expected)) {
    throw new Error('Stored token identity does not match this account.');
  }
}

function capability(account: Account, name: AccountCapability): void {
  if (account.authStatus !== 'connected' || !account.connected) throw new Error('Account is not connected.');
  if (!account.capabilities?.includes(name)) throw new Error(`Account lacks ${name} permission.`);
}

function safeUrl(raw: string, provider: Account['provider'], kind: 'mail' | 'calendar', expectedPath?: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid provider cursor.'); }
  const base = provider === 'google' ? (kind === 'mail' ? GOOGLE_API : GOOGLE_CALENDAR) : GRAPH_API;
  const root = new URL(base);
  const expectedPathname = expectedPath ? new URL(expectedPath).pathname : undefined;
  const pathWithinApi = url.pathname === root.pathname || url.pathname.startsWith(`${root.pathname}/`);
  if (url.protocol !== 'https:' || url.origin !== root.origin || !pathWithinApi || (expectedPathname && url.pathname !== expectedPathname) || url.username || url.password || url.hash) {
    throw new Error('Provider cursor is outside the allowed API path.');
  }
  return url;
}

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function utf8b64(value: string): string { return b64(new TextEncoder().encode(value)); }
function foldBase64(value: string): string { return value.match(/.{1,76}/g)?.join('\r\n') ?? ''; }
function encodedSubject(value: string): string {
  const words: string[] = [];
  let chunk = '';
  let byteCount = 0;
  for (const character of value) {
    const bytes = new TextEncoder().encode(character);
    if (byteCount + bytes.length > 42 && chunk) { words.push(`=?UTF-8?B?${utf8b64(chunk)}?=`); chunk = ''; byteCount = 0; }
    chunk += character;
    byteCount += bytes.length;
  }
  if (chunk || !words.length) words.push(`=?UTF-8?B?${utf8b64(chunk)}?=`);
  return words.join('\r\n ');
}
function foldedHeader(name: string, value: string): string {
  const tokens = value.split(/([ \t]+)/).filter(Boolean);
  let line = `${name}:`;
  const lines: string[] = [];
  for (const token of tokens) {
    if (/^[ \t]+$/.test(token)) {
      if (line.length + token.length <= 78) line += token;
      continue;
    }
    const separator = line.endsWith(':') ? ' ' : '';
    if (line.length + separator.length + token.length > 78 && !line.endsWith(':')) {
      if (line.length > 998) throw new Error(`${name} header exceeds the RFC line limit.`);
      lines.push(line); line = ` ${token}`;
    } else line += `${separator}${token}`;
  }
  if (line.length > 998) throw new Error(`${name} header exceeds the RFC line limit.`);
  lines.push(line);
  return lines.join('\r\n');
}
function headerValue(value: string, label: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error(`${label} contains an invalid line break.`);
  if (value !== value.trim()) throw new Error(`${label} contains surrounding whitespace.`);
  return value;
}
function emailList(values: string[], label: string): string[] {
  if (values.length > 100) throw new Error(`Too many ${label} recipients.`);
  return values.map((v) => {
    const clean = headerValue(v, label);
    if (clean.length > 320 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(clean)) throw new Error(`Invalid ${label} recipient.`);
    return clean;
  });
}
function calendarKey(value: string): string {
  if (!value || value.length > 1024 || /^[.]\.?$/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid calendar identifier.');
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function strictSelectedJson(response: Response): Promise<unknown> {
  const bytes = await response.arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  return JSON.parse(text) as unknown;
}

function validateCalendarEventPage(value: unknown): asserts value is {
  id: string; subject?: string; summary?: string;
  start?: { dateTime?: string; timeZone?: string; date?: string };
  end?: { dateTime?: string; timeZone?: string; date?: string };
}[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('Provider returned an invalid calendar event page.');
  if (value.length > MAX_PAGE_SIZE) throw new Error('Provider returned more calendar events than the requested page size; page was not committed.');
  for (const event of value) {
    if (!isRecord(event) || typeof event.id !== 'string' || !event.id ||
        (event.subject !== undefined && typeof event.subject !== 'string') ||
        (event.summary !== undefined && typeof event.summary !== 'string')) {
      throw new Error('Provider returned a malformed calendar event; page was not committed.');
    }
    for (const field of ['start', 'end'] as const) {
      const time = event[field];
      if (time === undefined) continue;
      if (!isRecord(time) || (time.dateTime !== undefined && typeof time.dateTime !== 'string') ||
          (time.timeZone !== undefined && typeof time.timeZone !== 'string') || (time.date !== undefined && typeof time.date !== 'string')) {
        throw new Error('Provider returned malformed calendar event time data; page was not committed.');
      }
    }
  }
}

/** Graph's UTC preference yields offset-free timestamps; certify only strict, valid UTC wall-clock values. */
function isStrictUtcDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthDays[month - 1];
}

function graphImmutableHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  const prefer = headers.get('prefer');
  if (!prefer?.toLowerCase().includes('idtype="immutableid"')) {
    headers.set('prefer', prefer ? `${prefer}, IdType="ImmutableId"` : 'IdType="ImmutableId"');
  }
  return headers;
}

function boundedHeaders(input: unknown): { name: string; value: string }[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(['subject', 'from', 'reply-to', 'to', 'cc', 'message-id', 'references', 'in-reply-to']);
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as { name?: unknown; value?: unknown };
    if (typeof raw.name !== 'string' || typeof raw.value !== 'string') return [];
    const name = raw.name.trim().toLowerCase();
    if (!allowed.has(name) || /[\r\n\0]/.test(raw.value)) return [];
    return [{ name, value: raw.value.slice(0, 2000) }];
  }).slice(0, 8);
}

function headersAreComplete(input: unknown): boolean {
  if (!Array.isArray(input) || input.length > 9) return false;
  const allowed = new Set(['subject', 'from', 'reply-to', 'to', 'cc', 'message-id', 'references', 'in-reply-to', 'date']);
  return input.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const header = item as { name?: unknown; value?: unknown };
    return typeof header.name === 'string' && typeof header.value === 'string' && header.value.length <= 2000 &&
      !/[\r\n\0]/.test(header.value) && allowed.has(header.name.trim().toLowerCase());
  });
}

function narrowEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1000 || /[\r\n\0]/.test(value)) return undefined;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const candidate = angle?.[1] ?? (value.trim().includes(' ') ? '' : value.trim());
  return candidate.length <= 320 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(candidate) ? candidate : undefined;
}

function validAddressHeader(value: string): boolean {
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => Boolean(narrowEmail(part)));
}

function parseAddressHeader(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  const addresses = parts.map((part) => narrowEmail(part));
  return parts.length > 0 && addresses.every((address): address is string => Boolean(address)) ? addresses : undefined;
}

function validMessageId(value: string): boolean {
  return value.length <= 998 && /^<[^<>\s\u0000-\u0020\u007f]+@[^<>\s\u0000-\u0020\u007f]+>$/.test(value);
}

function graphRecipients(values: string[]): { emailAddress: { address: string } }[] {
  return emailList(values, 'reply recipient').map((address) => ({ emailAddress: { address } }));
}

function graphReplyDraftCheck(message: Record<string, unknown> | undefined, payload: EmailProposalPayload): 'matches_approved' | 'differs' | 'unverified' {
  if (!message || typeof message.isDraft !== 'boolean' || typeof message.subject !== 'string' || !isRecord(message.body) ||
      typeof message.body.content !== 'string' || typeof message.body.contentType !== 'string' || !Array.isArray(message.toRecipients) || !Array.isArray(message.ccRecipients) || !Array.isArray(message.bccRecipients)) return 'unverified';
  const to = graphAddressList(message.toRecipients); const cc = graphAddressList(message.ccRecipients); const bcc = graphAddressList(message.bccRecipients);
  if (!to.complete || !cc.complete || !bcc.complete) return 'unverified';
  const normalizeText = (value: string) => value.replace(/\r\n?/g, '\n');
  const sameAddresses = (actual: string[], expected: string[]) => actual.length === expected.length &&
    actual.map((address) => address.toLowerCase()).sort().every((address, index) => address === [...expected].map((item) => item.toLowerCase()).sort()[index]);
  const expectedSubject = payload.reply?.sourceSubject;
  if (message.isDraft !== true || message.subject !== expectedSubject || message.body.contentType.toLowerCase() !== 'text' || normalizeText(message.body.content) !== normalizeText(payload.text) ||
      !sameAddresses(to.addresses ?? [], payload.to) || !sameAddresses(cc.addresses ?? [], payload.cc) || !sameAddresses(bcc.addresses ?? [], [])) return 'differs';
  return 'matches_approved';
}

function validateReplyPayload(account: Account, payload: EmailProposalPayload, replySource: ApprovedDispatch['replySource']): void {
  const reply = payload.reply;
  if (!reply) return;
  if (!replySource) throw new Error('Reply source approval is missing.');
  validateReplyBinding(payload, replySource);
  if (replySource.source.accountId !== account.id || !sameIdentity(replySource.source.identity, accountIdentity(account)) ||
      replySource.source.connectionGeneration !== (account.connectionGeneration ?? 0) || replySource.source.identity.providerNamespace !== account.provider) {
    throw new Error('Reply source does not match the current connected account.');
  }
  if ((account.provider === 'google' && (reply.idFormat !== 'gmail' || !reply.threadId)) ||
      (account.provider === 'microsoft' && (reply.idFormat !== 'graph-immutable' || !reply.providerMessageId))) throw new Error('Reply source does not match the connected provider.');
  if (reply.providerMessageId.length > 2048 || /[\r\n\0]/.test(reply.providerMessageId)) throw new Error('Reply source identifier is invalid.');
  if (account.provider === 'microsoft' && (!reply.providerMessageId || reply.providerMessageId.length < 8)) throw new Error('Reply source immutable identifier is invalid.');
  if (account.provider === 'google' && (reply.threadId!.length > 512 || /[\r\n\0]/.test(reply.threadId!))) throw new Error('Reply thread identifier is invalid.');
  if (!validMessageId(reply.internetMessageId)) throw new Error('Reply source message ID is invalid.');
}

function graphAddressList(value: unknown): { addresses?: string[]; complete: boolean } {
  if (!Array.isArray(value)) return { complete: false };
  const addresses: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return { complete: false };
    const emailAddress = (item as { emailAddress?: unknown }).emailAddress;
    if (!emailAddress || typeof emailAddress !== 'object') return { complete: false };
    const address = (emailAddress as { address?: unknown }).address;
    const normalized = narrowEmail(address);
    if (!normalized) return { complete: false };
    addresses.push(normalized);
  }
  return { addresses, complete: true };
}

function gmailPayloadFields(depth = 0): string {
  const current = 'mimeType,filename,headers,body(data,size,attachmentId)';
  return depth >= 12 ? current : `${current},parts(${gmailPayloadFields(depth + 1)})`;
}

function safeSizeEstimate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const CONVERSATION_HEADERS = ['From', 'Sender', 'Reply-To', 'To', 'Cc', 'Subject', 'Message-ID', 'References', 'In-Reply-To', 'Date'] as const;
const CONVERSATION_HEADER_NAMES = new Set(CONVERSATION_HEADERS.map((name) => name.toLowerCase()));

function conversationTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128 || /[\r\n\0]/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function conversationHeaders(value: unknown): { headers: { name: string; value: string }[]; values: Map<string, string>; malformed: boolean } {
  const headers: { name: string; value: string }[] = [];
  const values = new Map<string, string>();
  let malformed = !Array.isArray(value);
  if (!Array.isArray(value)) return { headers, values, malformed };
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string') { malformed = true; continue; }
    const name = item.name.trim().toLowerCase();
    if (!CONVERSATION_HEADER_NAMES.has(name)) continue;
    if (typeof item.value !== 'string' || item.value.length > 2000 || /[\r\n\0]/.test(item.value) || values.has(name)) { malformed = true; continue; }
    values.set(name, item.value);
    headers.push({ name, value: item.value });
  }
  return { headers, values, malformed };
}

function sortedConversationMessages(messages: MessageSummary[]): MessageSummary[] {
  return [...messages].sort((left, right) => {
    const leftTime = left.receivedAt ? Date.parse(left.receivedAt) : NaN;
    const rightTime = right.receivedAt ? Date.parse(right.receivedAt) : NaN;
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function graphConversationCursor(raw: string, threadId: string): URL {
  const expectedFilter = `conversationId eq '${threadId.replace(/'/g, "''")}'`;
  const url = safeUrl(raw, 'microsoft', 'mail', `${GRAPH_API}/me/messages`);
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || url.searchParams.get('$filter') !== expectedFilter ||
      url.searchParams.get('$select') !== 'id,conversationId,changeKey,subject,from,sender,receivedDateTime,sentDateTime,internetMessageId,isDraft,parentFolderId' ||
      url.searchParams.get('$top') !== String(MAX_CONVERSATION_PAGE_SIZE) ||
      keys.some((key) => !['$filter', '$select', '$top', '$skiptoken', '$skip'].includes(key)) ||
      (url.searchParams.has('$skip') && url.searchParams.has('$skiptoken')) ||
      (url.searchParams.has('$skip') && !/^\d+$/.test(url.searchParams.get('$skip')!)) ||
      (url.searchParams.has('$skiptoken') && !url.searchParams.get('$skiptoken'))) {
    throw new Error('Graph conversation cursor does not match the selected conversation query.');
  }
  return url;
}

function selectedHeaderSet(value: unknown): { headers: { name: string; value: string }[]; complete: boolean } {
  const allowed = new Set(['subject', 'from', 'reply-to', 'to', 'cc', 'message-id', 'references', 'in-reply-to', 'date']);
  if (!Array.isArray(value)) return { headers: [], complete: false };
  const headers: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  let complete = true;
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string') { complete = false; continue; }
    const name = item.name.trim().toLowerCase();
    if (!allowed.has(name)) continue;
    if (typeof item.value !== 'string' || /[\r\n\0]/.test(item.value) || item.value.length > 2000) { if (name !== 'date') complete = false; continue; }
    if (seen.has(name)) { if (name !== 'date') complete = false; continue; }
    seen.add(name);
    headers.push({ name, value: item.value });
  }
  if (headers.length > 9) complete = false;
  return { headers, complete: complete && headersAreComplete(headers) };
}

function gmailSelectedSummary(value: unknown, requestedId: string, checkedAt: string): { message?: MessageSummary; payload?: unknown; snippet?: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id !== requestedId || !isRecord(value.payload)) return {};
  const headers = selectedHeaderSet(value.payload.headers);
  const get = (name: string) => headers.headers.find((header) => header.name === name)?.value;
  const subject = get('subject');
  const from = get('from');
  const senderEmail = narrowEmail(from);
  const replyTo = parseAddressHeader(get('reply-to'));
  const to = parseAddressHeader(get('to'));
  const cc = parseAddressHeader(get('cc'));
  const addressHeaders = headers.headers.filter(({ name }) => ['from', 'reply-to', 'to', 'cc'].includes(name));
  const threadId = typeof value.threadId === 'string' ? value.threadId : undefined;
  const providerVersion = typeof value.historyId === 'string' ? value.historyId : undefined;
  const sizeEstimate = safeSizeEstimate(value.sizeEstimate);
  const labelsKnown = Array.isArray(value.labelIds) && value.labelIds.every((label) => typeof label === 'string');
  const timestamp = typeof value.internalDate === 'string' && /^\d{1,16}$/.test(value.internalDate) ? Number(value.internalDate) : NaN;
  const receivedAt = Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime()) ? new Date(timestamp).toISOString() : undefined;
  const internetMessageId = get('message-id');
  const replyMetadataComplete = Boolean(threadId && subject !== undefined && senderEmail && internetMessageId && validMessageId(internetMessageId) &&
    headers.complete && labelsKnown && sizeEstimate !== undefined && receivedAt && addressHeaders.every((header) => validAddressHeader(header.value)) &&
    (get('reply-to') === undefined || replyTo !== undefined) && (get('to') === undefined || to !== undefined) && (get('cc') === undefined || cc !== undefined));
  const summary: MessageSummary = { id: requestedId, idFormat: 'gmail', threadId, subject, from: from?.slice(0, 1000), senderEmail,
    receivedAt, sentAt: conversationTimestamp(get('date')), snippet: typeof value.snippet === 'string' ? value.snippet.slice(0, 500) : undefined,
    isRead: labelsKnown ? !(value.labelIds as string[]).includes('UNREAD') : undefined,
    isDraft: labelsKnown ? (value.labelIds as string[]).includes('DRAFT') : undefined,
    replyMetadataComplete, internetMessageId, providerVersion, sizeEstimate, sizeCheckedAt: checkedAt,
    replyTo, to, cc, references: get('references'), inReplyTo: get('in-reply-to'), headers: headers.headers };
  return { message: summary, payload: value.payload, snippet: summary.snippet };
}

function graphSelectedSummary(value: unknown, requestedId: string): { message?: MessageSummary; body?: { contentType?: unknown; content?: unknown }; snippet?: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id !== requestedId) return {};
  const headers = selectedHeaderSet(value.internetMessageHeaders);
  const headerMap = new Map(headers.headers.map(({ name, value: headerValue }) => [name, headerValue]));
  const from = isRecord(value.from) && isRecord(value.from.emailAddress) && typeof value.from.emailAddress.address === 'string' ? value.from.emailAddress.address : undefined;
  const senderEmail = narrowEmail(from);
  const replyTo = graphAddressList(value.replyTo); const to = graphAddressList(value.toRecipients); const cc = graphAddressList(value.ccRecipients);
  const threadId = typeof value.conversationId === 'string' ? value.conversationId : undefined;
  const providerVersion = typeof value.changeKey === 'string' ? value.changeKey : undefined;
  const receivedAt = typeof value.receivedDateTime === 'string' && Number.isFinite(Date.parse(value.receivedDateTime)) ? new Date(value.receivedDateTime).toISOString() : undefined;
  const subject = typeof value.subject === 'string' ? value.subject : undefined;
  const internetMessageId = typeof value.internetMessageId === 'string' ? value.internetMessageId : undefined;
  const replyMetadataComplete = Boolean(threadId && providerVersion && receivedAt && subject !== undefined && senderEmail && internetMessageId && validMessageId(internetMessageId) &&
    headers.complete && replyTo.complete && to.complete && cc.complete && typeof value.isRead === 'boolean');
  const summary: MessageSummary = { id: requestedId, idFormat: 'graph-immutable', threadId, subject, from, senderEmail, isRead: typeof value.isRead === 'boolean' ? value.isRead : undefined,
    isDraft: typeof value.isDraft === 'boolean' ? value.isDraft : undefined,
    receivedAt, sentAt: conversationTimestamp(value.sentDateTime), snippet: typeof value.bodyPreview === 'string' ? value.bodyPreview.slice(0, 500) : undefined, replyMetadataComplete,
    internetMessageId, providerVersion, replyTo: replyTo.addresses, to: to.addresses, cc: cc.addresses,
    references: headerMap.get('references'), inReplyTo: headerMap.get('in-reply-to'), headers: headers.headers };
  return { message: summary, body: isRecord(value.body) ? { contentType: value.body.contentType, content: value.body.content } : undefined, snippet: summary.snippet };
}

export class ConnectorClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly deps: ConnectorDependencies) {
    this.fetcher = deps.fetcher ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private async boundedFetch(input: RequestInfo | URL, init: RequestInit, guard?: RequestGuard, onDispatched?: () => void, beforeDispatch?: () => void, outerSignal?: AbortSignal, responseByteLimit?: number): Promise<Response> {
    const actualRequest = () => this.performBoundedFetch(input, init, guard, onDispatched, beforeDispatch, outerSignal, responseByteLimit);
    return this.deps.withProviderOwnership ? this.deps.withProviderOwnership(actualRequest) : actualRequest();
  }

  private async performBoundedFetch(input: RequestInfo | URL, init: RequestInit, guard?: RequestGuard, onDispatched?: () => void, beforeDispatch?: () => void, outerSignal?: AbortSignal, responseByteLimit?: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = Math.max(1_000, Math.min(30_000, this.deps.requestTimeoutMs ?? 15_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forwardAbort = () => controller.abort(outerSignal?.reason);
    try {
      if (outerSignal?.aborted) throw new Error('Provider request was cancelled.');
      outerSignal?.addEventListener('abort', forwardAbort, { once: true });
      guard?.();
      beforeDispatch?.();
      onDispatched?.();
      if (outerSignal?.aborted) throw new Error('Provider request was cancelled.');
      timer = setTimeout(() => controller.abort(), timeout);
      const response = await this.fetcher(input, { ...init, signal: controller.signal });
      const declaredLength = response.headers.get('content-length');
      if (responseByteLimit && declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > responseByteLimit) {
        // Keep provider ownership until the response stream has actually settled its cancellation.
        try { await response.body?.cancel(); } catch { /* Cancellation rejection is still a bounded oversized response. */ }
        throw new ProviderResponseTooLargeError();
      }
      // Fetch has already buffered native response bytes when arrayBuffer resolves; this is an application parsing bound, not a network-memory cap.
      const bytes = await response.arrayBuffer();
      if (responseByteLimit && bytes.byteLength > responseByteLimit) throw new ProviderResponseTooLargeError();
      return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    finally { if (timer) clearTimeout(timer); outerSignal?.removeEventListener('abort', forwardAbort); }
  }

  private async token(account: Account, guard?: RequestGuard, signal?: AbortSignal, allowRefresh = true): Promise<StoredOAuthToken> {
    this.assertConnectionCurrent(account);
    accountIdentity(account);
    if (account.authStatus !== 'connected') throw new Error('Account requires authentication.');
    const token = await this.deps.tokenStore.get(account.tokenRef!);
    if (!token) throw new Error('Account token is missing.');
    assertIdentity(account, token);
    if (token.expiresAt > this.now() + 60_000) return token;
    if (!allowRefresh) throw new ProviderAccessTokenUnavailableError();
    return this.refreshSingleflight(account, token, guard, false, signal);
  }

  private async refresh(account: Account, previous: StoredOAuthToken, identity: NonNullable<Account['identity']>, guard?: RequestGuard, signal?: AbortSignal): Promise<StoredOAuthToken> {
    this.assertConnectionCurrent(account);
    if (!previous.refreshToken) return this.reauth(account, 'reauth_required', 'Refresh token is unavailable.');
    const clientId = account.provider === 'google' ? this.deps.googleClientId : this.deps.microsoftClientId;
    if (!clientId || identity.clientId !== clientId || identity.providerNamespace !== account.provider) return this.reauth(account, 'reauth_required', 'Provider client does not match the connected account.');
    let endpoint: string;
    try { endpoint = account.provider === 'google' ? GOOGLE_TOKEN : microsoftTokenEndpoint(this.deps.microsoftAuthority); }
    catch { return this.reauth(account, 'reauth_required', 'Microsoft authority is not configured.'); }
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: clientId });
    let response: Response;
    try { response = await this.boundedFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error' }, guard, undefined, undefined, signal); }
    catch { throw new Error('Token refresh failed; account state is unchanged.'); }
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = String(data.error ?? '');
      if (code === 'invalid_grant') return this.reauth(account, 'reauth_required', 'Provider rejected the refresh token.');
      if (code === 'interaction_required' || code === 'invalid_client') return this.reauth(account, 'reauth_required', 'Provider requires account authentication.');
      throw new Error(`Token refresh failed (${response.status}).`);
    }
    const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
    const expiresIn = Number(data.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Provider returned an invalid token response.');
    this.assertConnectionCurrent(account);
    const next: StoredOAuthToken = { ...previous, accessToken, expiresAt: this.now() + expiresIn * 1000,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previous.refreshToken,
      identity };
    if (!await this.verifyIdentity(account, next, guard, signal)) return this.reauth(account, 'reauth_required', 'Refreshed token belongs to another provider identity.');
    this.assertConnectionCurrent(account);
    await this.deps.tokenStore.set(account.tokenRef!, next);
    return next;
  }

  private async verifyIdentity(account: Account, token: StoredOAuthToken, guard?: RequestGuard, signal?: AbortSignal): Promise<boolean> {
    const identity = accountIdentity(account);
    const endpoint = account.provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/oidc/userinfo';
    const response = await this.boundedFetch(endpoint, { method: 'GET', headers: { authorization: `Bearer ${token.accessToken}` }, redirect: 'error' }, guard, undefined, undefined, signal);
    if (!response.ok) return false;
    const user = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof user.sub !== 'string' || user.sub !== identity.subject) return false;
    if (account.provider === 'microsoft') {
      const meResponse = await this.boundedFetch('https://graph.microsoft.com/v1.0/me?$select=id', { method: 'GET', headers: { authorization: `Bearer ${token.accessToken}` }, redirect: 'error' }, guard, undefined, undefined, signal);
      if (!meResponse.ok) return false;
      const me = await meResponse.json().catch(() => ({})) as Record<string, unknown>;
      if (typeof me.id !== 'string' || me.id !== identity.resourceUserId) return false;
    }
    return true;
  }

  /** Verifies provider resource identity before an OAuth result is persisted by the caller. */
  async verifyOAuthIdentity(result: OAuthBridgeResult, token: StoredOAuthToken): Promise<boolean> {
    const clientId = result.provider === 'google' ? this.deps.googleClientId : this.deps.microsoftClientId;
    const known = new Set<AccountCapability>(['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write']);
    const requested = new Set(result.requestedCapabilities);
    if (!clientId || result.identity.providerNamespace !== result.provider || result.identity.clientId !== clientId ||
        !result.identity.subject || (result.provider === 'microsoft' && !result.identity.resourceUserId) ||
        !sameIdentity(result.identity, token.identity) || result.accessToken !== token.accessToken ||
        !Number.isFinite(result.expiresAt) || result.expiresAt <= this.now() || !Array.isArray(result.grantedScopes) ||
        !Array.isArray(result.requestedCapabilities) || !Array.isArray(result.capabilities) ||
        result.requestedCapabilities.some((cap) => !known.has(cap)) || result.capabilities.some((cap) => !known.has(cap) || !requested.has(cap) || !scopeGrantsCapability(result.provider, result.grantedScopes, cap))) return false;
    if (requested.has('calendar.write') && !requested.has('calendar.read')) return false;
    const temporaryAccount: Account = { id: 'oauth-verification', provider: result.provider, displayName: '', email: '', connected: true,
      authStatus: 'connected', identity: result.identity, tokenRef: 'oauth-verification' };
    return this.verifyIdentity(temporaryAccount, token);
  }

  private async reauth(account: Account, status: Account['authStatus'], message: string): Promise<never> {
    await this.deps.onAuthStatus?.(account.id, status);
    throw new Error(message);
  }

  private assertConnectionCurrent(account: Account): void {
    if (this.deps.isConnectionCurrent && !this.deps.isConnectionCurrent(account)) throw new Error('Account connection changed during provider work; reconnect before continuing.');
  }

  private async request(account: Account, rawUrl: string, kind: 'mail' | 'calendar', init: RequestInit = {}, retryAuth = true, guard?: RequestGuard, onDispatched?: () => void, signal?: AbortSignal, beforeDispatch?: () => void, responseByteLimit?: number, allowTokenRefresh = true): Promise<Response> {
    const url = safeUrl(rawUrl, account.provider, kind);
    const token = await this.token(account, guard, signal, allowTokenRefresh);
    this.assertConnectionCurrent(account);
    let response: Response;
    const requestHeaders = account.provider === 'microsoft' && kind === 'mail' ? graphImmutableHeaders(init) : new Headers(init.headers);
    requestHeaders.set('authorization', `Bearer ${token.accessToken}`);
    try { response = await this.boundedFetch(url.toString(), { ...init, redirect: 'error', headers: requestHeaders }, guard, onDispatched, beforeDispatch, signal, responseByteLimit); }
    catch (error) { throw error; }
    if (response.status !== 401 || !retryAuth) return response;
    // A non-idempotent request is never repeated after an ambiguous response.
    if (init.method && init.method.toUpperCase() !== 'GET') {
      await this.deps.onAuthStatus?.(account.id, 'reauth_required');
      return response;
    }
    if (!allowTokenRefresh) throw new ProviderAccessTokenUnavailableError();
    if (!token.refreshToken) return this.reauth(account, 'reauth_required', 'Provider rejected the access token.');
    const refreshed = await this.refreshSingleflight(account, token, guard, true, signal);
    return this.requestWithToken(url, refreshed, init, guard, signal, account.provider === 'microsoft' && kind === 'mail', responseByteLimit);
  }

  private async refreshSingleflight(account: Account, token: StoredOAuthToken, guard?: RequestGuard, force = false, signal?: AbortSignal): Promise<StoredOAuthToken> {
    let locks = refreshLocks.get(this.deps.tokenStore);
    if (!locks) { locks = new Map(); refreshLocks.set(this.deps.tokenStore, locks); }
    const lockKey = account.tokenRef!;
    const active = locks.get(lockKey);
    if (active) return active;
    const operation = withCredentialLock(this.deps.tokenStore, lockKey, async () => {
      this.assertConnectionCurrent(account);
      const current = await this.deps.tokenStore.get(account.tokenRef!);
      if (!current) return this.reauth(account, 'reauth_required', 'Account token is missing.');
      assertIdentity(account, current);
      const concurrentlyRotated = current.accessToken !== token.accessToken;
      if (current.expiresAt > this.now() + 60_000 && (!force || concurrentlyRotated)) return current;
      return this.refresh(account, current, accountIdentity(account), guard, signal);
    });
    locks.set(lockKey, operation);
    try { return await operation; }
    finally { if (locks.get(lockKey) === operation) locks.delete(lockKey); }
  }

  private async requestWithToken(url: URL, token: StoredOAuthToken, init: RequestInit, guard?: RequestGuard, signal?: AbortSignal, immutableMailId = false, responseByteLimit?: number): Promise<Response> {
    const headers = new Headers(init.headers);
    if (immutableMailId && url.origin === new URL(GRAPH_API).origin) {
      const immutable = graphImmutableHeaders({ ...init, headers });
      immutable.set('authorization', `Bearer ${token.accessToken}`);
      return this.boundedFetch(url.toString(), { ...init, redirect: 'error', headers: immutable }, guard, undefined, undefined, signal, responseByteLimit);
    }
    headers.set('authorization', `Bearer ${token.accessToken}`);
    return this.boundedFetch(url.toString(), { ...init, redirect: 'error', headers }, guard, undefined, undefined, signal, responseByteLimit);
  }

  private async json<T>(account: Account, url: string, kind: 'mail' | 'calendar', init?: RequestInit, guard?: RequestGuard, signal?: AbortSignal, allowTokenRefresh = true): Promise<T> {
    const response = await this.request(account, url, kind, init, true, guard, undefined, signal, undefined, undefined, allowTokenRefresh);
    if (!response.ok) throw new ProviderHttpError(response.status);
    try { return await response.json() as T; }
    catch { throw new Error('Provider returned an invalid JSON response.'); }
  }

  private async boundedJson<T>(account: Account, url: string, guard?: RequestGuard, signal?: AbortSignal): Promise<T> {
    const response = await this.request(account, url, 'mail', { method: 'GET' }, true, guard, undefined, signal, undefined, MAX_CONVERSATION_RESPONSE_BYTES);
    if (!response.ok) throw new ProviderHttpError(response.status);
    try { return await response.json() as T; }
    catch { throw new Error('Provider returned an invalid conversation response.'); }
  }

  /** Reads one bounded metadata-only page of a selected conversation. Gmail returns the thread in one response. */
  async listConversationMessages(account: Account, options: {
    threadId: string; cursor?: string; guard?: RequestGuard; signal?: AbortSignal;
  }): Promise<ConversationMessagesResult> {
    capability(account, 'mail.read');
    accountIdentity(account);
    const threadId = options.threadId;
    if (typeof threadId !== 'string' || !threadId || threadId.length > 512 || /[\u0000-\u001f\u007f]/.test(threadId)) {
      throw new Error('Conversation identifier is invalid.');
    }
    let requestUrl: string;
    let graphFilter: string | undefined;
    if (account.provider === 'google') {
      if (options.cursor !== undefined) throw new Error('Gmail conversation discovery does not accept a cursor.');
      const url = new URL(`${GOOGLE_API}/threads/${encodeURIComponent(threadId)}`);
      url.searchParams.set('format', 'metadata');
      for (const header of CONVERSATION_HEADERS) url.searchParams.append('metadataHeaders', header);
      url.searchParams.set('fields', 'id,historyId,messages(id,threadId,historyId,sizeEstimate,internalDate,labelIds,snippet,payload(headers))');
      requestUrl = url.toString();
    } else {
      graphFilter = `conversationId eq '${threadId.replace(/'/g, "''")}'`;
      if (options.cursor !== undefined) { graphConversationCursor(options.cursor, threadId); requestUrl = options.cursor; }
      else {
        const url = new URL(`${GRAPH_API}/me/messages`);
        url.searchParams.set('$filter', graphFilter);
        url.searchParams.set('$select', 'id,conversationId,changeKey,subject,from,sender,receivedDateTime,sentDateTime,internetMessageId,isDraft,parentFolderId');
        url.searchParams.set('$top', String(MAX_CONVERSATION_PAGE_SIZE));
        requestUrl = url.toString();
      }
    }

    const data = await this.boundedJson<unknown>(account, requestUrl, options.guard, options.signal);
    this.assertConnectionCurrent(account);
    options.guard?.();
    const messages: MessageSummary[] = [];
    const omissionCounts = new Map<string, number>();
    const omit = (reason: string) => omissionCounts.set(reason, (omissionCounts.get(reason) ?? 0) + 1);
    const seen = new Set<string>();
    let nextCursor: string | undefined;
    let rows: unknown[];

    if (account.provider === 'google') {
      if (!isRecord(data)) throw new Error('Gmail returned an invalid conversation response.');
      if (data.id !== undefined && data.id !== threadId) throw new Error('Gmail returned a different conversation.');
      if (data.id === undefined) omit('conversation_id_unknown');
      if (!Array.isArray(data.messages)) {
        omit('messages_missing_or_invalid');
        rows = [];
      } else rows = data.messages;
    } else {
      if (!isRecord(data)) throw new Error('Graph returned an invalid conversation response.');
      if (data.value !== undefined && !Array.isArray(data.value)) throw new Error('Graph returned an invalid conversation page.');
      rows = Array.isArray(data.value) ? data.value : [];
      if (!Array.isArray(data.value)) omit('messages_missing_or_invalid');
      if (typeof data['@odata.nextLink'] === 'string') {
        graphConversationCursor(data['@odata.nextLink'], threadId);
        nextCursor = data['@odata.nextLink'];
        omit('more_messages_available');
      } else if (data['@odata.nextLink'] !== undefined) omit('invalid_continuation');
      if (rows.length > MAX_CONVERSATION_PAGE_SIZE) {
        omit(`rows_over_page_limit:${rows.length - MAX_CONVERSATION_PAGE_SIZE}`);
        rows = rows.slice(0, MAX_CONVERSATION_PAGE_SIZE);
      }
    }

    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'string' || !row.id || row.id.length > 2048 || /[\u0000-\u001f\u007f]/.test(row.id)) {
        omit('malformed_message_rows');
        continue;
      }
      if (seen.has(row.id)) throw new Error('Provider returned duplicate conversation message IDs.');
      seen.add(row.id);
      const rowThreadId = account.provider === 'google' ? row.threadId : row.conversationId;
      if (typeof rowThreadId !== 'string' || !rowThreadId) { omit('message_conversation_id_missing'); continue; }
      if (rowThreadId !== threadId) throw new Error('Provider returned a message from a different conversation.');

      let summary: MessageSummary;
      if (account.provider === 'google') {
        const payloadHeaders = isRecord(row.payload) ? row.payload.headers : undefined;
        const parsed = conversationHeaders(payloadHeaders);
        if (parsed.malformed) omit('malformed_message_headers');
        const get = (name: string) => parsed.values.get(name);
        const labelsKnown = Array.isArray(row.labelIds) && row.labelIds.every((label) => typeof label === 'string');
        if (!labelsKnown) omit('draft_state_unknown');
        const internalDate = typeof row.internalDate === 'string' && /^\d{1,16}$/.test(row.internalDate) ? Number(row.internalDate) : NaN;
        const receivedAt = Number.isFinite(internalDate) && Number.isFinite(new Date(internalDate).getTime()) ? new Date(internalDate).toISOString() : undefined;
        const from = get('from');
        const sender = get('sender');
        const labels = labelsKnown ? row.labelIds as string[] : [];
        summary = {
          id: row.id, idFormat: 'gmail', threadId, subject: get('subject')?.slice(0, 1000),
          from: from?.slice(0, 1000), senderEmail: narrowEmail(sender ?? from), isRead: labelsKnown ? !labels.includes('UNREAD') : undefined,
          isDraft: labelsKnown ? labels.includes('DRAFT') : undefined, receivedAt, sentAt: conversationTimestamp(get('date')),
          snippet: typeof row.snippet === 'string' ? row.snippet.slice(0, 500) : undefined,
          internetMessageId: get('message-id'), providerVersion: typeof row.historyId === 'string' ? row.historyId : undefined,
          sizeEstimate: safeSizeEstimate(row.sizeEstimate), replyTo: parseAddressHeader(get('reply-to')),
          to: parseAddressHeader(get('to')), cc: parseAddressHeader(get('cc')), references: get('references'), inReplyTo: get('in-reply-to'),
          headers: parsed.headers, replyMetadataComplete: false,
        };
        if (!receivedAt) omit('received_date_unknown');
        if (row.snippet !== undefined && typeof row.snippet !== 'string') omit('malformed_snippet');
        if (row.historyId !== undefined && typeof row.historyId !== 'string') omit('malformed_provider_version');
        if (row.sizeEstimate !== undefined && safeSizeEstimate(row.sizeEstimate) === undefined) omit('malformed_size_estimate');
      } else {
        if (typeof row.isDraft !== 'boolean') omit('draft_state_unknown');
        if (row.subject !== undefined && typeof row.subject !== 'string') omit('malformed_subject');
        if (row.from !== undefined && (!isRecord(row.from) || !isRecord(row.from.emailAddress) || typeof row.from.emailAddress.address !== 'string')) omit('malformed_from');
        if (row.sender !== undefined && (!isRecord(row.sender) || !isRecord(row.sender.emailAddress) || typeof row.sender.emailAddress.address !== 'string')) omit('malformed_sender');
        if (row.internetMessageId !== undefined && typeof row.internetMessageId !== 'string') omit('malformed_message_id');
        if (row.changeKey !== undefined && typeof row.changeKey !== 'string') omit('malformed_provider_version');
        const fromValue = isRecord(row.from) && isRecord(row.from.emailAddress) ? row.from.emailAddress.address : undefined;
        const senderValue = isRecord(row.sender) && isRecord(row.sender.emailAddress) ? row.sender.emailAddress.address : undefined;
        const receivedAt = conversationTimestamp(row.receivedDateTime);
        const sentAt = conversationTimestamp(row.sentDateTime);
        summary = {
          id: row.id, idFormat: 'graph-immutable', threadId, subject: typeof row.subject === 'string' ? row.subject.slice(0, 1000) : undefined,
          from: typeof fromValue === 'string' ? fromValue.slice(0, 1000) : undefined,
          senderEmail: narrowEmail(senderValue ?? fromValue), isDraft: typeof row.isDraft === 'boolean' ? row.isDraft : undefined,
          receivedAt, sentAt, internetMessageId: typeof row.internetMessageId === 'string' ? row.internetMessageId.slice(0, 998) : undefined,
          providerVersion: typeof row.changeKey === 'string' ? row.changeKey.slice(0, 512) : undefined,
          replyMetadataComplete: false,
        };
        if (!receivedAt) omit('received_date_unknown');
        if (!sentAt) omit('sent_date_unknown');
      }
      messages.push(summary);
    }

    const omissionReasons = [...omissionCounts].map(([reason, count]) => count === 1 ? reason : `${reason}:${count}`);
    return { messages: sortedConversationMessages(messages), ...(nextCursor ? { nextCursor } : {}),
      coverage: omissionReasons.length ? 'partial' : 'complete_metadata', omissionReasons };
  }

  /** Reads exactly one hydrated INBOX page for a fixed half-open time window. */
  async syncMessageWindow(account: Account, options: {
    timeMin: string; timeMax: string; cursor?: string; pageSize?: number;
    guard?: RequestGuard; signal?: AbortSignal; onPage?: MessageWindowPageCallback; allowTokenRefresh?: boolean;
  }): Promise<MessageWindowSyncResult> {
    capability(account, 'mail.read');
    const query = describeMessageWindowQuery(account, options);
    const { window, pageSize: size, queryFingerprint } = query;
    const fromMs = Date.parse(window.from);
    const toMs = Date.parse(window.to);
    const items: MessageSummary[] = [];
    const unavailableIds: string[] = [];
    const gmailQuery = `after:${Math.floor(fromMs / 1000) - 1} before:${Math.ceil(toMs / 1000) + 1} in:inbox`;
    let url: URL;
    if (options.cursor) {
      const expectedPath = account.provider === 'google' ? `${GOOGLE_API}/messages` : `${GRAPH_API}/me/mailFolders/inbox/messages`;
      url = safeUrl(options.cursor, account.provider, 'mail', expectedPath);
      if (account.provider === 'google') {
        const params = [...url.searchParams.keys()];
        if (params.some((key) => !['maxResults', 'q', 'pageToken'].includes(key)) || new Set(params).size !== params.length || url.searchParams.get('maxResults') !== String(size) || url.searchParams.get('q') !== gmailQuery || !url.searchParams.get('pageToken')) {
          throw new Error('Gmail cursor does not match this exact mailbox window.');
        }
      }
    } else if (account.provider === 'google') {
      url = new URL(`${GOOGLE_API}/messages`);
      url.searchParams.set('maxResults', String(size));
      url.searchParams.set('q', gmailQuery);
    } else {
      url = new URL(`${GRAPH_API}/me/mailFolders/inbox/messages`);
      url.searchParams.set('$top', String(size));
      url.searchParams.set('$orderby', 'receivedDateTime desc');
      url.searchParams.set('$filter', `receivedDateTime ge ${window.from} and receivedDateTime lt ${window.to}`);
      url.searchParams.set('$select', 'id,conversationId,changeKey,subject,isRead,from,receivedDateTime,bodyPreview,replyTo,toRecipients,ccRecipients,internetMessageId,internetMessageHeaders');
    }

    let nextCursor: string | undefined;
    let pageItems: MessageSummary[];
    if (account.provider === 'google') {
      const page = await this.json<{ messages?: { id?: string; threadId?: string }[]; nextPageToken?: string }>(account, url.toString(), 'mail', undefined, options.guard, options.signal, options.allowTokenRefresh ?? true);
      if (page.messages !== undefined && !Array.isArray(page.messages)) throw new Error('Gmail returned an invalid message page.');
      if ((page.messages?.length ?? 0) > size) throw new Error('Gmail returned more messages than the requested page size; page was not committed.');
      nextCursor = page.nextPageToken
        ? `${GOOGLE_API}/messages?maxResults=${size}&q=${encodeURIComponent(gmailQuery)}&pageToken=${encodeURIComponent(page.nextPageToken)}`
        : undefined;
      pageItems = [];
      const ids = page.messages ?? [];
      for (const listed of ids) {
        if (typeof listed.id !== 'string' || !listed.id) throw new Error('Gmail returned a message without an ID.');
        let detail: { id?: string; threadId?: string; historyId?: string; sizeEstimate?: number; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: { headers?: { name?: string; value?: string }[] } };
        try {
          const detailUrl = new URL(`${GOOGLE_API}/messages/${encodeURIComponent(listed.id)}`);
          detailUrl.searchParams.set('format', 'metadata');
          for (const name of ['Subject', 'From', 'Reply-To', 'To', 'Cc', 'Message-ID', 'References', 'In-Reply-To']) detailUrl.searchParams.append('metadataHeaders', name);
          detailUrl.searchParams.set('fields', 'id,threadId,historyId,sizeEstimate,snippet,internalDate,labelIds,payload(headers)');
          detail = await this.json(account, detailUrl.toString(), 'mail', undefined, options.guard, options.signal, options.allowTokenRefresh ?? true);
        } catch (error) {
          if (error instanceof ProviderHttpError && error.status === 404) { unavailableIds.push(listed.id); continue; }
          throw error;
        }
        const timestamp = typeof detail.internalDate === 'string' && /^\d{1,16}$/.test(detail.internalDate) ? Number(detail.internalDate) : NaN;
        if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) throw new Error('Gmail metadata has no valid internal date; page was not committed.');
        if (detail.id !== undefined && detail.id !== listed.id) throw new Error('Gmail metadata ID does not match the listed message; page was not committed.');
        if (Array.isArray(detail.labelIds) && !detail.labelIds.includes('INBOX')) { unavailableIds.push(listed.id); continue; }
        if (timestamp < fromMs || timestamp >= toMs) continue;
        const headers = boundedHeaders(detail.payload?.headers);
        const get = (name: string) => headers.find((header) => header.name === name)?.value;
        const from = get('from');
        const senderEmail = narrowEmail(from);
        const addressHeaderValues = headers.filter((header) => ['from', 'reply-to', 'to', 'cc'].includes(header.name));
        const replyTo = parseAddressHeader(get('reply-to'));
        const to = parseAddressHeader(get('to'));
        const cc = parseAddressHeader(get('cc'));
        const labelsKnown = Array.isArray(detail.labelIds);
        const replyMetadataComplete = Boolean(labelsKnown && senderEmail && get('message-id') && headersAreComplete(detail.payload?.headers) &&
          addressHeaderValues.every((header) => validAddressHeader(header.value)) &&
          (get('reply-to') === undefined || replyTo !== undefined) && (get('to') === undefined || to !== undefined) && (get('cc') === undefined || cc !== undefined));
        pageItems.push({ id: detail.id ?? listed.id, idFormat: 'gmail', threadId: detail.threadId ?? listed.threadId,
          subject: get('subject'), from: from?.slice(0, 1000), senderEmail, receivedAt: new Date(timestamp).toISOString(),
          snippet: detail.snippet?.slice(0, 500), isRead: labelsKnown ? !detail.labelIds!.includes('UNREAD') : undefined,
          replyMetadataComplete, to, cc, replyTo, internetMessageId: get('message-id')?.slice(0, 1000), providerVersion: detail.historyId,
          sizeEstimate: safeSizeEstimate(detail.sizeEstimate), sizeCheckedAt: new Date(this.now()).toISOString(),
          references: get('references')?.slice(0, 2000), inReplyTo: get('in-reply-to')?.slice(0, 1000), headers });
      }
    } else {
      const page = await this.json<{ value?: {
        id?: string; conversationId?: string; changeKey?: string; subject?: string; isRead?: boolean;
        from?: { emailAddress?: { name?: string; address?: string } }; receivedDateTime?: string; bodyPreview?: string;
        replyTo?: { emailAddress?: { address?: string } }[]; toRecipients?: { emailAddress?: { address?: string } }[];
        ccRecipients?: { emailAddress?: { address?: string } }[]; internetMessageId?: string;
        internetMessageHeaders?: { name?: string; value?: string }[];
      }[]; '@odata.nextLink'?: string }>(account, url.toString(), 'mail', undefined, options.guard, options.signal, options.allowTokenRefresh ?? true);
      if (!Array.isArray(page.value)) throw new Error('Microsoft returned an invalid message page.');
      if (page.value.length > size) throw new Error('Microsoft returned more messages than the requested page size; page was not committed.');
      nextCursor = page['@odata.nextLink'];
      if (nextCursor) safeUrl(nextCursor, account.provider, 'mail', `${GRAPH_API}/me/mailFolders/inbox/messages`);
      pageItems = page.value.flatMap((message) => {
        if (!message.id || typeof message.receivedDateTime !== 'string' || !Number.isFinite(Date.parse(message.receivedDateTime))) throw new Error('Microsoft metadata has no valid message ID or received date; page was not committed.');
        const timestamp = Date.parse(message.receivedDateTime);
        if (timestamp < fromMs || timestamp >= toMs) return [];
        const from = message.from?.emailAddress?.address;
        const senderEmail = narrowEmail(from);
        const headers = boundedHeaders(message.internetMessageHeaders);
        const replyTo = graphAddressList(message.replyTo);
        const to = graphAddressList(message.toRecipients);
        const cc = graphAddressList(message.ccRecipients);
        const rawHeaders = message.internetMessageHeaders;
        const headerMap = new Map(headers.map(({ name, value }) => [name, value]));
        const replyMetadataComplete = Boolean(senderEmail && message.internetMessageId && message.changeKey && rawHeaders && headersAreComplete(rawHeaders) &&
          replyTo.complete && to.complete && cc.complete);
        return [{ id: message.id, idFormat: 'graph-immutable' as const, threadId: message.conversationId,
          subject: message.subject?.slice(0, 1000), from: from?.slice(0, 1000), senderEmail, isRead: typeof message.isRead === 'boolean' ? message.isRead : undefined,
          receivedAt: new Date(timestamp).toISOString(), snippet: message.bodyPreview?.slice(0, 500), replyMetadataComplete,
          internetMessageId: message.internetMessageId?.slice(0, 1000), providerVersion: message.changeKey?.slice(0, 1000),
          replyTo: replyTo.addresses, to: to.addresses, cc: cc.addresses,
          references: headerMap.get('references')?.slice(0, 2000), inReplyTo: headerMap.get('in-reply-to')?.slice(0, 1000), headers }];
      });
    }
    items.push(...pageItems);
    await options.onPage?.(pageItems, nextCursor, 1, { unavailableIds: [...unavailableIds], window, queryFingerprint });
    return { items, nextCursor, partial: Boolean(nextCursor), window, queryFingerprint, unavailableIds };
  }

  async readSelectedMessageText(account: Account, providerMessageId: string, options: {
    sizeEstimate?: number; sizeCheckedAt?: string; guard?: RequestGuard; signal?: AbortSignal;
  } = {}): Promise<SelectedMessageTextResult> {
    capability(account, 'mail.read');
    if ((account.provider !== 'google' && account.provider !== 'microsoft') || !account.grantedScopes ||
        !scopeGrantsCapability(account.provider, account.grantedScopes, 'mail.read')) throw new Error('Full message body read permission is required.');
    if (!providerMessageId || providerMessageId.length > 2048 || /[\r\n\0]/.test(providerMessageId)) throw new Error('Selected message identifier is invalid.');
    const idFormat = account.provider === 'google' ? 'gmail' as const : 'graph-immutable' as const;
    const initialMessage: MessageSummary = { id: providerMessageId, idFormat };
    let sizeEstimate: number | undefined;
    let providerVersion: string | undefined;
    let checkedAt = new Date(this.now()).toISOString();
    const unavailable = (reasons: string[], message?: MessageSummary): SelectedMessageTextResult => ({ status: 'unavailable', ...(message ? { message } : {}),
      bytes: 0, representation: 'none', completeness: 'unavailable', reasons: reasons.slice(0, 16), checkedAt, extractionVersion: 'mail-text-v2' });

    if (account.provider === 'google') {
      const suppliedEstimate = safeSizeEstimate(options.sizeEstimate);
      const checkedMs = typeof options.sizeCheckedAt === 'string' ? Date.parse(options.sizeCheckedAt) : NaN;
      const estimateIsFresh = suppliedEstimate !== undefined && Number.isFinite(checkedMs) && checkedMs <= this.now() && this.now() - checkedMs <= SELECTED_SIZE_FRESH_MS;
      if (estimateIsFresh) sizeEstimate = suppliedEstimate;
      else {
        const preflightUrl = new URL(`${GOOGLE_API}/messages/${encodeURIComponent(providerMessageId)}`);
        preflightUrl.searchParams.set('fields', 'id,threadId,historyId,sizeEstimate');
        let preflight: Response;
        try { preflight = await this.request(account, preflightUrl.toString(), 'mail', { method: 'GET' }, false, options.guard, undefined, options.signal, undefined, MAX_SELECTED_RESPONSE_BYTES); }
        catch (error) {
          if (error instanceof ProviderResponseTooLargeError) return unavailable(['response_byte_limit'], initialMessage);
          throw error;
        }
        if (!preflight.ok) throw new ProviderHttpError(preflight.status);
        let metadata: unknown;
        try { metadata = await strictSelectedJson(preflight); }
        catch { return unavailable(['invalid_selected_response_json'], initialMessage); }
        if (!isRecord(metadata) || metadata.id !== providerMessageId) return unavailable(['preflight_id_mismatch'], initialMessage);
        sizeEstimate = safeSizeEstimate(metadata.sizeEstimate);
        providerVersion = typeof metadata.historyId === 'string' ? metadata.historyId : undefined;
        const threadId = typeof metadata.threadId === 'string' ? metadata.threadId : undefined;
        if (sizeEstimate === undefined) return unavailable(['size_estimate_unavailable'], { ...initialMessage, threadId, providerVersion });
        if (sizeEstimate > MAX_SELECTED_MESSAGE_BYTES) return unavailable(['size_limit'], { ...initialMessage, threadId, providerVersion, sizeEstimate, sizeCheckedAt: new Date(this.now()).toISOString() });
      }
      if (sizeEstimate !== undefined && sizeEstimate > MAX_SELECTED_MESSAGE_BYTES) return unavailable(['size_limit'], { ...initialMessage, sizeEstimate, sizeCheckedAt: new Date(this.now()).toISOString() });

      const fullUrl = new URL(`${GOOGLE_API}/messages/${encodeURIComponent(providerMessageId)}`);
      fullUrl.searchParams.set('format', 'full');
      fullUrl.searchParams.set('fields', `id,threadId,historyId,sizeEstimate,snippet,internalDate,labelIds,payload(${gmailPayloadFields()})`);
      let response: Response;
      try { response = await this.request(account, fullUrl.toString(), 'mail', { method: 'GET' }, false, options.guard, undefined, options.signal, undefined, MAX_SELECTED_RESPONSE_BYTES); }
      catch (error) {
        if (error instanceof ProviderResponseTooLargeError) return unavailable(['response_byte_limit'], { ...initialMessage, sizeEstimate });
        throw error;
      }
      if (!response.ok) throw new ProviderHttpError(response.status);
      let data: unknown;
      try { data = await strictSelectedJson(response); }
      catch { return unavailable(['invalid_selected_response_json'], { ...initialMessage, sizeEstimate }); }
      checkedAt = new Date(this.now()).toISOString();
      const selected = gmailSelectedSummary(data, providerMessageId, checkedAt);
      if (!selected.message) return unavailable(['message_id_mismatch_or_invalid_response'], initialMessage);
      const actualEstimate = selected.message.sizeEstimate;
      if (actualEstimate !== undefined && actualEstimate > MAX_SELECTED_MESSAGE_BYTES) return unavailable(['size_limit'], selected.message);
      const extracted = extractGmailMessageText(selected.payload, selected.snippet);
      const reasons = [...extracted.reasons];
      if (!selected.message.replyMetadataComplete) reasons.push('reply_metadata_incomplete');
      return { status: selected.message.replyMetadataComplete && extracted.text !== undefined ? 'available' : 'unavailable', message: selected.message,
        ...(extracted.text !== undefined ? { text: extracted.text } : {}), bytes: extracted.bytes, representation: extracted.representation,
        completeness: extracted.completeness, reasons: reasons.slice(0, 16), checkedAt, extractionVersion: 'mail-text-v2' };
    }

    const graphUrl = new URL(`${GRAPH_API}/me/messages/${encodeURIComponent(providerMessageId)}`);
    graphUrl.searchParams.set('$select', 'id,conversationId,changeKey,subject,body,bodyPreview,from,replyTo,toRecipients,ccRecipients,internetMessageId,internetMessageHeaders,isRead,receivedDateTime,isDraft,sentDateTime');
    let graphResponse: Response;
    try {
      graphResponse = await this.request(account, graphUrl.toString(), 'mail', { method: 'GET', headers: { prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } }, false,
        options.guard, undefined, options.signal, undefined, MAX_SELECTED_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ProviderResponseTooLargeError) return unavailable(['response_byte_limit'], initialMessage);
      throw error;
    }
    if (!graphResponse.ok) throw new ProviderHttpError(graphResponse.status);
    let graphData: unknown;
    try { graphData = await strictSelectedJson(graphResponse); }
    catch { return unavailable(['invalid_selected_response_json'], initialMessage); }
    checkedAt = new Date(this.now()).toISOString();
    const selected = graphSelectedSummary(graphData, providerMessageId);
    if (!selected.message) return unavailable(['message_id_mismatch_or_invalid_response'], initialMessage);
    const contentType = typeof selected.body?.contentType === 'string' ? selected.body.contentType.toLowerCase() : '';
    let extracted;
    if (contentType === 'text' && typeof selected.body?.content === 'string') extracted = boundGraphText(selected.body.content);
    else if (contentType === 'html' && typeof selected.body?.content === 'string') {
      extracted = extractGraphHtmlText(selected.body.content);
      if (extracted.text === undefined) {
        const fallback = extractGmailMessageText(undefined, selected.snippet);
        extracted = { ...fallback, reasons: [...extracted.reasons, ...fallback.reasons].slice(0, 16) };
      }
    } else {
      extracted = extractGmailMessageText(undefined, selected.snippet);
      extracted.reasons = [...extracted.reasons, 'plain_body_unavailable'].slice(0, 16);
    }
    const reasons = [...extracted.reasons];
    if (!selected.message.replyMetadataComplete) reasons.push('reply_metadata_incomplete');
    return { status: selected.message.replyMetadataComplete && extracted.text !== undefined ? 'available' : 'unavailable', message: selected.message,
      ...(extracted.text !== undefined ? { text: extracted.text } : {}), bytes: extracted.bytes, representation: extracted.representation,
      completeness: extracted.completeness, reasons: reasons.slice(0, 16), checkedAt, extractionVersion: 'mail-text-v2' };
  }

  private async writeJson(account: Account, url: string, kind: 'mail' | 'calendar', init: RequestInit, beforeDispatch: () => void): Promise<MutationReceipt> {
    let response: Response;
    let dispatched = false;
    try { response = await this.request(account, url, kind, init, true, undefined, () => { dispatched = true; }, undefined, beforeDispatch); }
    catch (error) { if (!dispatched) throw error; return { status: 'unknown' }; }
    if (response.status >= 500) return { status: 'unknown' };
    if (response.status >= 400 && response.status < 500) throw new ProviderWriteRejectedError(response.status);
    if (!response.ok) throw new Error(`Provider request failed (${response.status}).`);
    const data = await response.json().catch(() => ({})) as { id?: unknown };
    return typeof data.id === 'string' && data.id ? { status: 'accepted', id: data.id } : { status: 'unknown' };
  }

  async syncMessages(account: Account, options: { query?: string; cursor?: string; pageSize?: number; timeMin?: string; guard?: RequestGuard; signal?: AbortSignal; onPage?: PageCallback<MessageSummary> } = {}): Promise<SyncPage<MessageSummary>> {
    capability(account, 'mail.read');
    const requestedPageSize = Math.floor(options.pageSize ?? 25);
    const size = Number.isFinite(requestedPageSize) ? Math.max(1, Math.min(MAX_PAGE_SIZE, requestedPageSize)) : 25;
    const timeMin = options.timeMin ?? new Date(this.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    if (!Number.isFinite(Date.parse(timeMin)) || Date.parse(timeMin) > this.now()) throw new Error('Mail sync start time is invalid.');
    const gmailQuery = [options.query?.slice(0, 500), `after:${Math.floor(Date.parse(timeMin) / 1000)}`].filter(Boolean).join(' ');
    const items: MessageSummary[] = [];
    let cursor = options.cursor;
    let pagesRead = 0;
    let detailCount = 0;
    while (pagesRead < MAX_PAGES) {
      let url: URL;
      if (cursor) url = safeUrl(cursor, account.provider, 'mail', account.provider === 'google' ? `${GOOGLE_API}/messages` : `${GRAPH_API}/me/messages`);
      else if (account.provider === 'google') {
        url = new URL(`${GOOGLE_API}/messages`); url.searchParams.set('maxResults', String(size));
        url.searchParams.set('q', gmailQuery);
      } else {
        url = new URL(`${GRAPH_API}/me/messages`); url.searchParams.set('$top', String(size));
        url.searchParams.set('$select', 'id,subject,from,receivedDateTime,bodyPreview');
        url.searchParams.set('$filter', `receivedDateTime ge ${timeMin}`);
        if (options.query) url.searchParams.set('$search', `"${options.query.slice(0, 200).replace(/["\\]/g, '')}"`);
      }
      const page = await this.json<{
        messages?: { id: string; threadId?: string }[];
        nextPageToken?: string;
        value?: { id: string; subject?: string; from?: { emailAddress?: { address?: string } }; receivedDateTime?: string; bodyPreview?: string }[];
        '@odata.nextLink'?: string;
      }>(account, url.toString(), 'mail', options.query && account.provider === 'microsoft' ? { headers: { ConsistencyLevel: 'eventual' } } : undefined, options.guard, options.signal);
      pagesRead++;
      let pageItems: MessageSummary[];
      if (account.provider === 'google') {
        pageItems = (page.messages ?? []).slice(0, size).map((m) => ({ id: m.id, threadId: m.threadId }));
        const query = `&q=${encodeURIComponent(gmailQuery)}`;
        cursor = page.nextPageToken ? `${GOOGLE_API}/messages?maxResults=${size}${query}&pageToken=${encodeURIComponent(page.nextPageToken)}` : undefined;
      } else {
        pageItems = (page.value ?? []).slice(0, size).map((m) => ({ id: m.id, subject: m.subject, from: m.from?.emailAddress?.address, receivedAt: m.receivedDateTime, snippet: m.bodyPreview?.slice(0, 500) }));
        cursor = page['@odata.nextLink'];
        if (cursor) safeUrl(cursor, account.provider, 'mail', `${GRAPH_API}/me/messages`);
      }
      // Gmail lists identifiers only; fetch a maximum of ten metadata records, serially.
      if (account.provider === 'google' && detailCount < MAX_DETAILS) {
        for (let i = 0; i < pageItems.length && detailCount < MAX_DETAILS; i++, detailCount++) {
          const item = pageItems[i];
          const detail = await this.json<{ id: string; threadId?: string; snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }>(account, `${GOOGLE_API}/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, 'mail', undefined, options.guard, options.signal);
          const header = (name: string) => detail.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
          pageItems[i] = { id: detail.id, threadId: detail.threadId, subject: header('Subject'), from: header('From'), receivedAt: detail.internalDate ? new Date(Number(detail.internalDate)).toISOString() : undefined, snippet: detail.snippet?.slice(0, 500) };
        }
      }
      items.push(...pageItems);
      await options.onPage?.(pageItems, cursor, pagesRead);
      if (!cursor) break;
    }
    const partial = Boolean(cursor);
    return { items, nextCursor: cursor, pagesRead, partial };
  }

  async listCalendars(account: Account, options: { cursor?: string; guard?: RequestGuard; signal?: AbortSignal; onPage?: PageCallback<CalendarSummary> } = {}): Promise<SyncPage<CalendarSummary>> {
    capability(account, 'calendar.read');
    const items: CalendarSummary[] = [];
    let cursor = options.cursor;
    let pagesRead = 0;
    while (pagesRead < MAX_PAGES) {
      const url = account.provider === 'google'
        ? cursor ? safeUrl(cursor, account.provider, 'calendar', `${GOOGLE_CALENDAR}/users/me/calendarList`) : new URL(`${GOOGLE_CALENDAR}/users/me/calendarList?maxResults=100`)
        : cursor ? safeUrl(cursor, account.provider, 'calendar', `${GRAPH_API}/me/calendars`) : new URL(`${GRAPH_API}/me/calendars?$top=100`);
      let pageItems: CalendarSummary[];
      if (account.provider === 'google') {
        const data = await this.json<{ items?: { id: string; summary?: string; accessRole?: string }[]; nextPageToken?: string }>(account, url.toString(), 'calendar', undefined, options.guard, options.signal);
        pageItems = (data.items ?? []).slice(0, 100).map((c) => ({ id: c.id, name: c.summary ?? c.id, writable: c.accessRole === 'owner' || c.accessRole === 'writer' }));
        cursor = data.nextPageToken ? `${GOOGLE_CALENDAR}/users/me/calendarList?maxResults=100&pageToken=${encodeURIComponent(data.nextPageToken)}` : undefined;
      } else {
        const data = await this.json<{ value?: { id: string; name?: string; canEdit?: boolean }[]; '@odata.nextLink'?: string }>(account, url.toString(), 'calendar', undefined, options.guard, options.signal);
        pageItems = (data.value ?? []).slice(0, 100).map((c) => ({ id: c.id, name: c.name ?? c.id, writable: Boolean(c.canEdit) }));
        cursor = data['@odata.nextLink'];
        if (cursor) safeUrl(cursor, account.provider, 'calendar', `${GRAPH_API}/me/calendars`);
      }
      pagesRead++;
      items.push(...pageItems);
      await options.onPage?.(pageItems, cursor, pagesRead);
      if (!cursor) break;
    }
    return { items, nextCursor: cursor, pagesRead, partial: Boolean(cursor) };
  }

  async readCalendarEvents(account: Account, calendarId: string, options: { cursor?: string; timeMin?: string; timeMax?: string; guard?: RequestGuard; signal?: AbortSignal; onPage?: PageCallback<CalendarEventSummary> } = {}): Promise<SyncPage<CalendarEventSummary>> {
    capability(account, 'calendar.read');
    const encodedCalendarId = calendarKey(calendarId);
    const min = options.timeMin ?? new Date(this.now()).toISOString();
    const max = options.timeMax ?? new Date(this.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    if (!Number.isFinite(Date.parse(min)) || !Number.isFinite(Date.parse(max)) || Date.parse(max) <= Date.parse(min) || Date.parse(max) - Date.parse(min) > 90 * 24 * 60 * 60 * 1000) throw new Error('Calendar read window must be within 90 days.');
    let next = options.cursor;
    const items: CalendarEventSummary[] = [];
    let pagesRead = 0;
    while (pagesRead < MAX_PAGES) {
      const expectedPath = account.provider === 'google'
        ? `${GOOGLE_CALENDAR}/calendars/${encodedCalendarId}/events`
        : `${GRAPH_API}/me/calendars/${encodedCalendarId}/calendarView`;
      const url = next ? safeUrl(next, account.provider, 'calendar', expectedPath) : account.provider === 'google'
        ? new URL(`${GOOGLE_CALENDAR}/calendars/${encodedCalendarId}/events?maxResults=${MAX_PAGE_SIZE}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}`)
        : new URL(`${GRAPH_API}/me/calendars/${encodedCalendarId}/calendarView?startDateTime=${encodeURIComponent(min)}&endDateTime=${encodeURIComponent(max)}&$top=${MAX_PAGE_SIZE}&$select=id,subject,start,end`);
      if (account.provider === 'google') {
        const data = await this.json<{ items?: unknown; nextPageToken?: string }>(account, url.toString(), 'calendar', undefined, options.guard, options.signal);
        validateCalendarEventPage(data.items);
        const pageItems = (data.items ?? []).map((e) => ({ id: e.id, subject: e.summary, start: e.start?.dateTime, end: e.end?.dateTime, timeZone: e.start?.timeZone }));
        items.push(...pageItems);
        next = data.nextPageToken ? `${GOOGLE_CALENDAR}/calendars/${encodedCalendarId}/events?maxResults=${MAX_PAGE_SIZE}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}&pageToken=${encodeURIComponent(data.nextPageToken)}` : undefined;
        pagesRead++;
        await options.onPage?.(pageItems, next, pagesRead);
      } else {
        const data = await this.json<{ value?: unknown; '@odata.nextLink'?: string }>(account, url.toString(), 'calendar', { headers: { prefer: 'outlook.timezone="UTC"' } }, options.guard, options.signal);
        if (!Array.isArray(data.value)) throw new Error('Microsoft returned an invalid calendar event page.');
        validateCalendarEventPage(data.value);
        const pageItems = (data.value ?? []).map((e) => ({ id: e.id, subject: e.subject, start: e.start?.dateTime, end: e.end?.dateTime, timeZone: e.start?.timeZone,
          startUtcCertified: e.start?.timeZone === 'UTC' && isStrictUtcDateTime(e.start?.dateTime) ? true : undefined,
          endUtcCertified: e.end?.timeZone === 'UTC' && isStrictUtcDateTime(e.end?.dateTime) ? true : undefined }));
        items.push(...pageItems);
        next = data['@odata.nextLink']; if (next) safeUrl(next, account.provider, 'calendar', expectedPath);
        pagesRead++;
        await options.onPage?.(pageItems, next, pagesRead);
      }
      if (!next) break;
    }
    return { items, nextCursor: next, pagesRead, partial: Boolean(next) };
  }

  async createDraft(account: Account, envelope: ApprovedDispatch, verifier: DispatchVerifier): Promise<MutationReceipt> {
    capability(account, 'mail.draft');
    const payload = await this.verifiedEmail(account, envelope, verifier, 'draft');
    if (payload.reply) return this.createReplyDraft(account, envelope, verifier, payload);
    if (account.provider === 'google') {
      const raw = await this.gmailRaw(payload);
      return this.writeJson(account, `${GOOGLE_API}/drafts`, 'mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { raw } }) }, () => this.finalVerify(envelope, verifier));
    }
    const message = await this.graphMessage(payload);
    return this.writeJson(account, `${GRAPH_API}/me/messages`, 'mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) }, () => this.finalVerify(envelope, verifier));
  }

  async sendEmail(account: Account, envelope: ApprovedDispatch, verifier: DispatchVerifier): Promise<MutationReceipt> {
    if (isRecord(envelope.payload) && 'reply' in envelope.payload && envelope.payload.reply) throw new Error('Reply proposals can only create a draft.');
    capability(account, 'mail.send');
    const payload = await this.verifiedEmail(account, envelope, verifier, 'send');
    if (account.provider === 'google') {
      const raw = await this.gmailRaw(payload);
      return this.writeJson(account, `${GOOGLE_API}/messages/send`, 'mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }) }, () => this.finalVerify(envelope, verifier));
    }
    const message = await this.graphMessage(payload);
    let response: Response;
    let dispatched = false;
    try { response = await this.request(account, `${GRAPH_API}/me/sendMail`, 'mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }) }, true, undefined, () => { dispatched = true; }, undefined, () => this.finalVerify(envelope, verifier)); }
    catch (error) { if (dispatched) return { status: 'unknown' }; throw error; }
    if (response.status === 202 || response.ok) return { status: 'accepted' };
    if (response.status >= 500) return { status: 'unknown' };
    if (response.status >= 400 && response.status < 500) throw new ProviderWriteRejectedError(response.status);
    throw new Error(`Provider send failed (${response.status}).`);
  }

  async createEvent(account: Account, calendarId: string, envelope: ApprovedDispatch, verifier: DispatchVerifier, transactionId: string): Promise<MutationReceipt> {
    capability(account, 'calendar.write');
    const encodedCalendarId = calendarKey(calendarId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) throw new Error('Invalid calendar or idempotency identifier.');
    await this.verifyDispatch(account, envelope, verifier, 'event');
    if (envelope.calendarId !== calendarId || !('start' in envelope.payload)) throw new Error('Dispatch approval does not match this calendar and event.');
    const event = envelope.payload as EventProposalPayload;
    validateEvent(event);
    if (account.provider === 'microsoft' && event.invitePolicy === 'none' && event.attendees.length) throw new Error('Microsoft Graph cannot create an attendee event without sending invitations.');
    if (account.provider === 'google') {
      const body = { id: transactionId.replace(/-/g, '').toLowerCase(), summary: event.title ?? envelope.title, description: event.description ?? envelope.body, start: { dateTime: event.start, timeZone: event.timeZone }, end: { dateTime: event.end, timeZone: event.timeZone }, attendees: event.attendees.map((email) => ({ email })) };
      return this.writeJson(account, `${GOOGLE_CALENDAR}/calendars/${encodedCalendarId}/events?sendUpdates=${event.invitePolicy === 'send' ? 'all' : 'none'}`, 'calendar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, () => this.finalVerify(envelope, verifier));
    }
    const body = { subject: event.title ?? envelope.title, body: { contentType: 'Text', content: event.description ?? envelope.body }, start: { dateTime: new Date(Date.parse(event.start)).toISOString().replace(/Z$/, ''), timeZone: 'UTC' }, end: { dateTime: new Date(Date.parse(event.end)).toISOString().replace(/Z$/, ''), timeZone: 'UTC' }, attendees: event.attendees.map((email) => ({ emailAddress: { address: email }, type: 'required' })), transactionId };
    return this.writeJson(account, `${GRAPH_API}/me/calendars/${encodedCalendarId}/events`, 'calendar', { method: 'POST', headers: { 'content-type': 'application/json', prefer: 'outlook.timezone="UTC"' }, body: JSON.stringify(body) }, () => this.finalVerify(envelope, verifier));
  }

  private finalVerify(envelope: ApprovedDispatch, verifier: DispatchVerifier): void {
    if (!verifier.verifyBeforeDispatch(envelope)) throw new Error('Approved action changed before provider dispatch. Review and approve it again.');
    if (envelope.replySource) {
      try { canonicalMailReplySource(envelope.replySource.source); }
      catch { throw new Error('Reply source approval is invalid. Review the source and approve the reply again.'); }
      const now = this.now();
      const observedAt = Date.parse(envelope.replySource.source.observedAt);
      const expiresAt = Date.parse(envelope.replySource.expiresAt);
      if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > SELECTED_SIZE_FRESH_MS || !Number.isFinite(expiresAt) || expiresAt <= now) {
        throw new Error('Reply source approval has expired. Review the source and approve the reply again.');
      }
    }
  }

  private async verifyDispatch(account: Account, envelope: ApprovedDispatch, verifier: DispatchVerifier, operation: ApprovedDispatch['operation']): Promise<void> {
    if (!verifier.verifyBeforeDispatch || !await verifier.verify(envelope) || envelope.operation !== operation || envelope.accountId !== account.id ||
        !sameIdentity(envelope.identity, accountIdentity(account)) || !/^[^\r\n\0]{1,160}$/.test(envelope.proposalId) ||
        !Number.isInteger(envelope.revision) || envelope.revision < 1 ||
        (envelope.replySource ? envelope.sourceRevision !== undefined : !Number.isInteger(envelope.sourceRevision) || envelope.sourceRevision! < 1) ||
        !/^[a-f0-9]{64}$/i.test(envelope.payloadDigest) || !envelope.title || envelope.title.length > 1000 || envelope.body.length > 100_000 || /[\r\n\0]/.test(envelope.title)) {
      throw new Error('Dispatch approval does not match this account and operation.');
    }
  }

  private async verifiedEmail(account: Account, envelope: ApprovedDispatch, verifier: DispatchVerifier, operation: 'draft' | 'send'): Promise<EmailProposalPayload> {
    await this.verifyDispatch(account, envelope, verifier, operation);
    if (!('to' in envelope.payload)) throw new Error('Dispatch approval does not contain an email payload.');
    const p = envelope.payload as EmailProposalPayload;
    if (p.to.length === 0) throw new Error('Email needs at least one To recipient.');
    emailList(p.to, 'To'); emailList(p.cc, 'Cc'); emailList(p.bcc, 'Bcc');
    if (p.reply) {
      if (p.subject.length > 998 || /[\r\n\0]/.test(p.subject) || p.subject !== p.subject.trim()) throw new Error('Reply subject contains an invalid header value.');
    } else headerValue(p.subject, 'Subject');
    if (p.subject.length > 998 || p.text.length > 100_000 || p.attachments.length > 10) throw new Error('Email payload exceeds limits.');
    if (p.reply) {
      if (operation !== 'draft' || envelope.operation !== 'draft') throw new Error('Reply proposals can only create a draft.');
      validateReplyPayload(account, p, envelope.replySource);
    }
    return p;
  }

  private async createReplyDraft(account: Account, envelope: ApprovedDispatch, verifier: DispatchVerifier, payload: EmailProposalPayload): Promise<MutationReceipt> {
    const reply = payload.reply!;
    if (account.provider === 'google') {
      const raw = await this.gmailReplyRaw(payload, envelope.replySource!.source);
      return this.writeReplyJson(account, `${GOOGLE_API}/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { raw, threadId: reply.threadId } }) }, () => this.finalVerify(envelope, verifier), 'gmail', reply.threadId);
    }
    const action = reply.mode === 'reply_all' ? 'createReplyAll' : 'createReply';
    const url = `${GRAPH_API}/me/messages/${encodeURIComponent(reply.providerMessageId)}/${action}`;
    const body = { message: { body: { contentType: 'Text', content: payload.text }, toRecipients: graphRecipients(payload.to), ccRecipients: graphRecipients(payload.cc), bccRecipients: [] } };
    return this.writeReplyJson(account, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, () => this.finalVerify(envelope, verifier), 'graph', undefined, payload);
  }

  private async writeReplyJson(account: Account, url: string, init: RequestInit, beforeDispatch: () => void, provider: 'gmail' | 'graph', expectedThreadId?: string, payload?: EmailProposalPayload): Promise<MutationReceipt> {
    let response: Response;
    let dispatched = false;
    try { response = await this.request(account, url, 'mail', init, false, undefined, () => { dispatched = true; }, undefined, beforeDispatch); }
    catch (error) { if (!dispatched) throw error; return { status: 'unknown' }; }
    if (response.status >= 500) return { status: 'unknown' };
    if (response.status >= 400 && response.status < 500) throw new ProviderWriteRejectedError(response.status);
    if (!response.ok) return { status: 'unknown' };
    const data = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (provider === 'gmail') {
      const id = data && typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 2048 ? data.id : undefined;
      if (!id) return { status: 'unknown' };
      const message = data && isRecord(data.message) ? data.message : undefined;
      const threadId = message && typeof message.threadId === 'string' && message.threadId.length > 0 ? message.threadId : undefined;
      return { status: 'accepted', id, replyDraftCheck: threadId && threadId !== expectedThreadId ? 'differs' : 'unverified' };
    }
    const message = data;
    const id = message && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 2048 ? message.id : undefined;
    if (!id) return { status: 'unknown' };
    return { status: 'accepted', id, replyDraftCheck: graphReplyDraftCheck(message, payload!) };
  }

  private async graphMessage(payload: EmailProposalPayload): Promise<object> {
    const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));
    return { subject: headerValue(payload.subject, 'Subject'), body: { contentType: 'Text', content: payload.text }, toRecipients: recipients(payload.to), ccRecipients: recipients(payload.cc), bccRecipients: recipients(payload.bcc), attachments: await this.checkedAttachments(payload) };
  }

  private async gmailRaw(payload: EmailProposalPayload): Promise<string> {
    const tos = emailList(payload.to, 'To'), ccs = emailList(payload.cc, 'Cc'), bccs = emailList(payload.bcc, 'Bcc');
    const subject = payload.subject === '' ? '' : headerValue(payload.subject, 'Subject');
    const attachments = await this.checkedAttachments(payload);
    let message: string;
    if (!attachments.length) {
      const headers = [`To: ${tos.join(', ')}`, ...(ccs.length ? [`Cc: ${ccs.join(', ')}`] : []), ...(bccs.length ? [`Bcc: ${bccs.join(', ')}`] : []), `Subject: ${encodedSubject(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
      message = `${headers.join('\r\n')}\r\n\r\n${foldBase64(utf8b64(payload.text))}`;
    } else {
      const boundary = `still-${this.now()}-${Math.random().toString(36).slice(2)}`;
      const headers = [`To: ${tos.join(', ')}`, ...(ccs.length ? [`Cc: ${ccs.join(', ')}`] : []), ...(bccs.length ? [`Bcc: ${bccs.join(', ')}`] : []), `Subject: ${encodedSubject(subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`];
      const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(utf8b64(payload.text))}`];
      for (const a of attachments) {
        const fileName = String(a.name).replace(/[^\x20-\x7e]|["\\]/g, '_');
        parts.push(`--${boundary}\r\nContent-Type: ${a.contentType}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(a.name)}\r\n\r\n${foldBase64(a.contentBytes)}`);
      }
      parts.push(`--${boundary}--`);
      message = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
    }
    return b64(new TextEncoder().encode(message)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private async gmailReplyRaw(payload: EmailProposalPayload, source: MailReplyProvenance['source']): Promise<string> {
    const reply = payload.reply!;
    const tos = emailList(payload.to, 'To'), ccs = emailList(payload.cc, 'Cc');
    const subject = headerValue(payload.subject, 'Subject');
    if (reply.internetMessageId.length + 'In-Reply-To: '.length > 998) throw new Error('In-Reply-To header exceeds the RFC line limit.');
    const headers = [foldedHeader('To', tos.join(', ')), ...(ccs.length ? [foldedHeader('Cc', ccs.join(', '))] : []), subject === '' ? 'Subject: ' : `Subject: ${encodedSubject(subject)}`,
      `In-Reply-To: ${reply.internetMessageId}`, foldedHeader('References', frozenReplyReferences(source) ?? reply.internetMessageId),
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
    const message = `${headers.join('\r\n')}\r\n\r\n${foldBase64(utf8b64(payload.text))}`;
    return b64(new TextEncoder().encode(message)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private async checkedAttachments(payload: EmailProposalPayload): Promise<{ '@odata.type': '#microsoft.graph.fileAttachment'; name: string; contentType: string; contentBytes: string }[]> {
    if (!payload.attachments.length) return [];
    if (!this.deps.loadAttachment || !this.deps.sha256) throw new Error('Attachment verification is unavailable.');
    const totalBytes = payload.attachments.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (!Number.isFinite(totalBytes) || totalBytes > MAX_ATTACHMENT_BYTES) throw new Error('Email attachments exceed the 3 MB total limit.');
    const out: { '@odata.type': '#microsoft.graph.fileAttachment'; name: string; contentType: string; contentBytes: string }[] = [];
    for (const attachment of payload.attachments) {
      if (!attachment.id || attachment.fileName.length > 200 || attachment.mimeType.length > 255 || !Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 || attachment.sizeBytes > MAX_ATTACHMENT_BYTES || !/^[a-f0-9]{64}$/i.test(attachment.sha256) || /[\r\n\0]/.test(attachment.fileName) || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i.test(attachment.mimeType)) throw new Error('Invalid attachment metadata.');
      const bytes = await this.deps.loadAttachment(attachment.id);
      if (bytes.byteLength !== attachment.sizeBytes || bytes.byteLength > MAX_ATTACHMENT_BYTES || (await this.deps.sha256(bytes)).toLowerCase() !== attachment.sha256.toLowerCase()) throw new Error('Attachment changed after approval.');
      out.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: attachment.fileName, contentType: attachment.mimeType, contentBytes: b64(bytes) });
    }
    return out;
  }
}

function sameIdentity(a: NonNullable<Account['identity']>, b: NonNullable<Account['identity']>): boolean {
  return a.subject === b.subject && a.providerNamespace === b.providerNamespace && a.clientId === b.clientId &&
    a.resourceUserId === b.resourceUserId && a.issuer === b.issuer && a.tenantId === b.tenantId;
}

function microsoftTokenEndpoint(authority = ''): string {
  if (!['common', 'organizations', 'consumers'].includes(authority) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(authority)) throw new Error('Microsoft authority is not an allowed configured authority.');
  return `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
}

function validateEvent(event: EventProposalPayload): void {
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!isoDateTime.test(event.start) || !isoDateTime.test(event.end)) throw new Error('Event times must be ISO date-times with an explicit offset.');
  const start = Date.parse(event.start), end = Date.parse(event.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 24 * 60 * 60 * 1000) throw new Error('Invalid event time range.');
  if (!event.timeZone || event.timeZone.length > 100 || /[\r\n]/.test(event.timeZone)) throw new Error('Invalid event time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone: event.timeZone }).format(0); } catch { throw new Error('Invalid event time zone.'); }
  if (event.title !== undefined && (!event.title || event.title.length > 1000 || /[\r\n\0]/.test(event.title))) throw new Error('Invalid event title.');
  if (event.description !== undefined && event.description.length > 100_000) throw new Error('Event description is too long.');
  emailList(event.attendees, 'attendee');
  if (!['send', 'none'].includes(event.invitePolicy)) throw new Error('Invalid invite policy.');
}

