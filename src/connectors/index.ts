import type { Account, AccountCapability, EmailProposalPayload, EventProposalPayload } from '../core';
import { scopeGrantsCapability } from './oauth';

const GOOGLE_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_CALENDAR = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 3;
const MAX_DETAILS = 10;
const MAX_PAGE_SIZE = 50;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

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
}

export interface ApprovedDispatch {
  proposalId: string;
  revision: number;
  sourceRevision: number;
  operation: 'draft' | 'send' | 'event';
  accountId: string;
  identity: NonNullable<Account['identity']>;
  payloadDigest: string;
  title: string;
  body: string;
  calendarId?: string;
  payload: EmailProposalPayload | EventProposalPayload;
}

export interface DispatchVerifier {
  verify(envelope: ApprovedDispatch): Promise<boolean>;
  /** Synchronous final check after async preparation and token refresh, immediately before dispatch. */
  verifyBeforeDispatch(envelope: ApprovedDispatch): boolean;
}

export type MutationReceipt = { status: 'accepted'; id?: string } | { status: 'unknown' };

export interface MessageSummary {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  receivedAt?: string;
  snippet?: string;
}

export interface SyncPage<T> {
  items: T[];
  nextCursor?: string;
  pagesRead: number;
  partial: boolean;
}
export type RequestGuard = () => void;
export type PageCallback<T> = (items: T[], nextCursor: string | undefined, pagesRead: number) => void | Promise<void>;

export interface CalendarSummary { id: string; name: string; writable: boolean; }
export interface CalendarEventSummary { id: string; subject?: string; start?: string; end?: string; timeZone?: string; }

const refreshLocks = new WeakMap<OAuthTokenStore, Map<string, Promise<StoredOAuthToken>>>();

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

export class ConnectorClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly deps: ConnectorDependencies) {
    this.fetcher = deps.fetcher ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private async boundedFetch(input: RequestInfo | URL, init: RequestInit, guard?: RequestGuard, onDispatched?: () => void, beforeDispatch?: () => void, outerSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeout = Math.max(1_000, Math.min(30_000, this.deps.requestTimeoutMs ?? 15_000));
    const timer = setTimeout(() => controller.abort(), timeout);
    const forwardAbort = () => controller.abort(outerSignal?.reason);
    try {
      if (outerSignal?.aborted) throw new Error('Provider request was cancelled.');
      outerSignal?.addEventListener('abort', forwardAbort, { once: true });
      guard?.();
      beforeDispatch?.();
      onDispatched?.();
      const response = await this.fetcher(input, { ...init, signal: controller.signal });
      const bytes = await response.arrayBuffer();
      return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    finally { clearTimeout(timer); outerSignal?.removeEventListener('abort', forwardAbort); }
  }

  private async token(account: Account, guard?: RequestGuard, signal?: AbortSignal): Promise<StoredOAuthToken> {
    this.assertConnectionCurrent(account);
    const identity = accountIdentity(account);
    if (account.authStatus !== 'connected') throw new Error('Account requires authentication.');
    const token = await this.deps.tokenStore.get(account.tokenRef!);
    if (!token) throw new Error('Account token is missing.');
    assertIdentity(account, token);
    if (token.expiresAt > this.now() + 60_000) return token;
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

  private async request(account: Account, rawUrl: string, kind: 'mail' | 'calendar', init: RequestInit = {}, retryAuth = true, guard?: RequestGuard, onDispatched?: () => void, signal?: AbortSignal, beforeDispatch?: () => void): Promise<Response> {
    const url = safeUrl(rawUrl, account.provider, kind);
    const token = await this.token(account, guard, signal);
    this.assertConnectionCurrent(account);
    let response: Response;
    try { response = await this.boundedFetch(url.toString(), { ...init, redirect: 'error', headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${token.accessToken}` } }, guard, onDispatched, beforeDispatch, signal); }
    catch (error) { throw error; }
    if (response.status !== 401 || !retryAuth) return response;
    // A non-idempotent request is never repeated after an ambiguous response.
    if (init.method && init.method.toUpperCase() !== 'GET') {
      await this.deps.onAuthStatus?.(account.id, 'reauth_required');
      return response;
    }
    if (!token.refreshToken) return this.reauth(account, 'reauth_required', 'Provider rejected the access token.');
    const refreshed = await this.refreshSingleflight(account, token, guard, true, signal);
    return this.requestWithToken(url, refreshed, init, guard, signal);
  }

  private async refreshSingleflight(account: Account, token: StoredOAuthToken, guard?: RequestGuard, force = false, signal?: AbortSignal): Promise<StoredOAuthToken> {
    let locks = refreshLocks.get(this.deps.tokenStore);
    if (!locks) { locks = new Map(); refreshLocks.set(this.deps.tokenStore, locks); }
    const lockKey = account.tokenRef!;
    const active = locks.get(lockKey);
    if (active) return active;
    const operation = (async () => {
      const current = await this.deps.tokenStore.get(account.tokenRef!);
      if (!current) return this.reauth(account, 'reauth_required', 'Account token is missing.');
      assertIdentity(account, current);
      const concurrentlyRotated = current.accessToken !== token.accessToken;
      if (current.expiresAt > this.now() + 60_000 && (!force || concurrentlyRotated)) return current;
      return this.refresh(account, current, accountIdentity(account), guard, signal);
    })();
    locks.set(lockKey, operation);
    try { return await operation; }
    finally { if (locks.get(lockKey) === operation) locks.delete(lockKey); }
  }

  private async requestWithToken(url: URL, token: StoredOAuthToken, init: RequestInit, guard?: RequestGuard, signal?: AbortSignal): Promise<Response> {
    return this.boundedFetch(url.toString(), { ...init, redirect: 'error', headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${token.accessToken}` } }, guard, undefined, undefined, signal);
  }

  private async json<T>(account: Account, url: string, kind: 'mail' | 'calendar', init?: RequestInit, guard?: RequestGuard, signal?: AbortSignal): Promise<T> {
    const response = await this.request(account, url, kind, init, true, guard, undefined, signal);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Provider request failed (${response.status}).`);
    return data as T;
  }

  private async writeJson(account: Account, url: string, kind: 'mail' | 'calendar', init: RequestInit, beforeDispatch: () => void): Promise<MutationReceipt> {
    let response: Response;
    let dispatched = false;
    try { response = await this.request(account, url, kind, init, true, undefined, () => { dispatched = true; }, undefined, beforeDispatch); }
    catch (error) { if (!dispatched) throw error; return { status: 'unknown' }; }
    if (response.status >= 500) return { status: 'unknown' };
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
        messages?: Array<{ id: string; threadId?: string }>;
        nextPageToken?: string;
        value?: Array<{ id: string; subject?: string; from?: { emailAddress?: { address?: string } }; receivedDateTime?: string; bodyPreview?: string }>;
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
          const detail = await this.json<{ id: string; threadId?: string; snippet?: string; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> } }>(account, `${GOOGLE_API}/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, 'mail', undefined, options.guard, options.signal);
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
        const data = await this.json<{ items?: Array<{ id: string; summary?: string; accessRole?: string }>; nextPageToken?: string }>(account, url.toString(), 'calendar', undefined, options.guard, options.signal);
        pageItems = (data.items ?? []).slice(0, 100).map((c) => ({ id: c.id, name: c.summary ?? c.id, writable: c.accessRole === 'owner' || c.accessRole === 'writer' }));
        cursor = data.nextPageToken ? `${GOOGLE_CALENDAR}/users/me/calendarList?maxResults=100&pageToken=${encodeURIComponent(data.nextPageToken)}` : undefined;
      } else {
        const data = await this.json<{ value?: Array<{ id: string; name?: string; canEdit?: boolean }>; '@odata.nextLink'?: string }>(account, url.toString(), 'calendar', undefined, options.guard, options.signal);
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
        const data = await this.json<{ items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string } }>; nextPageToken?: string }>(account, url.toString(), 'calendar', undefined, options.guard, options.signal);
        const pageItems = (data.items ?? []).slice(0, MAX_PAGE_SIZE).map((e) => ({ id: e.id, subject: e.summary, start: e.start?.dateTime, end: e.end?.dateTime, timeZone: e.start?.timeZone }));
        items.push(...pageItems);
        next = data.nextPageToken ? `${GOOGLE_CALENDAR}/calendars/${encodedCalendarId}/events?maxResults=${MAX_PAGE_SIZE}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}&pageToken=${encodeURIComponent(data.nextPageToken)}` : undefined;
        pagesRead++;
        await options.onPage?.(pageItems, next, pagesRead);
      } else {
        const data = await this.json<{ value?: Array<{ id: string; subject?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string } }>; '@odata.nextLink'?: string }>(account, url.toString(), 'calendar', { headers: { prefer: 'outlook.timezone="UTC"' } }, options.guard, options.signal);
        const pageItems = (data.value ?? []).slice(0, MAX_PAGE_SIZE).map((e) => ({ id: e.id, subject: e.subject, start: e.start?.dateTime, end: e.end?.dateTime, timeZone: e.start?.timeZone }));
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
    if (account.provider === 'google') {
      const raw = await this.gmailRaw(payload);
      return this.writeJson(account, `${GOOGLE_API}/drafts`, 'mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { raw } }) }, () => this.finalVerify(envelope, verifier));
    }
    const message = await this.graphMessage(payload);
    return this.writeJson(account, `${GRAPH_API}/me/messages`, 'mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) }, () => this.finalVerify(envelope, verifier));
  }

  async sendEmail(account: Account, envelope: ApprovedDispatch, verifier: DispatchVerifier): Promise<MutationReceipt> {
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
  }

  private async verifyDispatch(account: Account, envelope: ApprovedDispatch, verifier: DispatchVerifier, operation: ApprovedDispatch['operation']): Promise<void> {
    if (!verifier.verifyBeforeDispatch || !await verifier.verify(envelope) || envelope.operation !== operation || envelope.accountId !== account.id ||
        !sameIdentity(envelope.identity, accountIdentity(account)) || !/^[^\r\n\0]{1,160}$/.test(envelope.proposalId) ||
        !Number.isInteger(envelope.revision) || envelope.revision < 1 || !Number.isInteger(envelope.sourceRevision) || envelope.sourceRevision < 1 ||
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
    headerValue(p.subject, 'Subject');
    if (p.subject.length > 998 || p.text.length > 100_000 || p.attachments.length > 10) throw new Error('Email payload exceeds limits.');
    return p;
  }

  private async graphMessage(payload: EmailProposalPayload): Promise<object> {
    const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));
    return { subject: headerValue(payload.subject, 'Subject'), body: { contentType: 'Text', content: payload.text }, toRecipients: recipients(payload.to), ccRecipients: recipients(payload.cc), bccRecipients: recipients(payload.bcc), attachments: await this.checkedAttachments(payload) };
  }

  private async gmailRaw(payload: EmailProposalPayload): Promise<string> {
    const tos = emailList(payload.to, 'To'), ccs = emailList(payload.cc, 'Cc'), bccs = emailList(payload.bcc, 'Bcc');
    const subject = headerValue(payload.subject, 'Subject');
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

  private async checkedAttachments(payload: EmailProposalPayload): Promise<Array<{ '@odata.type': '#microsoft.graph.fileAttachment'; name: string; contentType: string; contentBytes: string }>> {
    if (!payload.attachments.length) return [];
    if (!this.deps.loadAttachment || !this.deps.sha256) throw new Error('Attachment verification is unavailable.');
    const totalBytes = payload.attachments.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (!Number.isFinite(totalBytes) || totalBytes > MAX_ATTACHMENT_BYTES) throw new Error('Email attachments exceed the 3 MB total limit.');
    const out: Array<{ '@odata.type': '#microsoft.graph.fileAttachment'; name: string; contentType: string; contentBytes: string }> = [];
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

