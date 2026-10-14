import type { Account, AccountCapability } from '../core';
import type { OAuthBridgeResult, StoredOAuthToken } from './index';
import type { ProviderResponseLifetime } from '../services/providerResponseLifetime';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_MAIL_PROBE = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1';
const GOOGLE_CALENDAR_PROBE = 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1';
const GRAPH_USERINFO_URL = 'https://graph.microsoft.com/oidc/userinfo';
const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
const GRAPH_MAIL_PROBE = 'https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id';
const GRAPH_CALENDAR_PROBE = 'https://graph.microsoft.com/v1.0/me/calendars?$top=1';

export interface AuthorizationCodeInput {
  authorizationCode: string;
  codeVerifier: string;
  requestedScopes: string[];
}

export interface OAuthClientConfig {
  provider: Extract<Account['provider'], 'google' | 'microsoft'>;
  clientId: string;
  redirectUri: string;
  /** Microsoft authority chosen by app configuration, never inferred from token claims. */
  authority?: string;
  requestedCapabilities: AccountCapability[];
}

export interface OAuthExchangeDependencies {
  fetcher?: typeof fetch;
  withProviderOwnership?: <T>(actual: () => Promise<T>) => Promise<T>;
  withResponseLifetime?: ProviderResponseLifetime;
  beforeStart?: () => void;
  now?: () => number;
  timeoutMs?: number;
}

function validateRedirect(config: OAuthClientConfig): string {
  const uri = config.redirectUri;
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error('OAuth redirect URI is invalid.'); }
  if (parsed.username || parsed.password || parsed.hash) throw new Error('OAuth redirect URI is not allowed.');
  if (config.provider === 'google') {
    const nativeClient = /^(\d+|[a-z0-9-]+)\.apps\.googleusercontent\.com$/i.exec(config.clientId);
    const expected = nativeClient ? `com.googleusercontent.apps.${nativeClient[1]}`.toLowerCase() : '';
    const actual = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase() ?? '';
    if (!expected || actual !== expected || parsed.protocol !== `${expected}:` || !parsed.pathname || parsed.search) throw new Error('Google code exchange requires the exact native reverse-client-ID callback. Use the iOS build for Google sign-in.');
    return uri;
  }
  if (parsed.protocol === 'https:') return uri;
  const loopback = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const registeredNative = /^com\.still\.voiceassistant(?:\.[a-z0-9-]+)+:$/i.test(parsed.protocol) && Boolean(parsed.pathname) && !parsed.search;
  if (!loopback && !registeredNative) throw new Error('Microsoft redirect must use HTTPS, a loopback development URL, or this app’s registered native scheme.');
  return uri;
}

function validateAuthority(authority: string | undefined): string {
  const value = authority ?? '';
  if (!['common', 'organizations', 'consumers'].includes(value) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Microsoft authority must be a supported alias or configured tenant UUID.');
  return value;
}

function validateInput(config: OAuthClientConfig, input: AuthorizationCodeInput): AccountCapability[] {
  if (!config.clientId || config.clientId.length > 512 || /[\r\n\0]/.test(config.clientId)) throw new Error('OAuth client ID is missing or invalid.');
  validateRedirect(config);
  if (!input.authorizationCode || input.authorizationCode.length > 4096 || /[\r\n\0]/.test(input.authorizationCode)) throw new Error('Authorization code is invalid.');
  if (input.codeVerifier.length < 43 || input.codeVerifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(input.codeVerifier)) throw new Error('PKCE code verifier is invalid.');
  if (!Array.isArray(input.requestedScopes) || input.requestedScopes.length < 1 || input.requestedScopes.length > 100 || input.requestedScopes.some((s) => !s || s.length > 300 || /[\r\n\0]/.test(s))) throw new Error('Requested OAuth scopes are invalid.');
  if (!input.requestedScopes.some((s) => s.toLowerCase() === 'openid')) throw new Error('OpenID scope is required to verify account identity.');
  const known = new Set<AccountCapability>(['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write']);
  const requested: AccountCapability[] = [...new Set<AccountCapability>(config.requestedCapabilities)];
  if (requested.some((cap) => !known.has(cap))) throw new Error('Requested app capability is invalid.');
  if (requested.includes('calendar.write') && !requested.includes('calendar.read')) throw new Error('Calendar write access requires explicit calendar read selection.');
  return requested;
}

async function fetchJson(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number,
  dependencies: OAuthExchangeDependencies): Promise<{ response: Response; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(timeoutMs, 30_000)));
  try {
    const actual = async () => {
      const consume = async (response: Response) => {
        const bytes = await response.arrayBuffer();
        const bounded = new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes,
          { status: response.status, statusText: response.statusText, headers: response.headers });
        const data = await bounded.clone().json().catch(() => ({})) as Record<string, unknown>;
        return { response: bounded, data };
      };
      const beforeStart = () => {
        if (controller.signal.aborted) throw new Error('OAuth request was cancelled before dispatch.');
        dependencies.beforeStart?.();
      };
      const lifetime = dependencies.withResponseLifetime ?? (async (input, requestInit, consumeResponse, _onCancelPending, beforeRequestStart) => {
        beforeRequestStart?.();
        return consumeResponse(await fetcher(input, requestInit));
      });
      return lifetime(url, { ...init, redirect: 'error', signal: controller.signal }, consume, undefined, beforeStart);
    };
    return dependencies.withProviderOwnership ? await dependencies.withProviderOwnership(actual) : await actual();
  } finally { clearTimeout(timer); }
}

function grantedScopes(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Provider did not return the scopes it granted.');
  const scopes = [...new Set(value.split(/\s+/).filter(Boolean))];
  if (!scopes.some((s) => s.toLowerCase() === 'openid')) throw new Error('Provider did not grant OpenID scope.');
  return scopes;
}

export function scopeGrantsCapability(provider: OAuthClientConfig['provider'], scopes: string[], capability: AccountCapability): boolean {
  const normalized = new Set(scopes.map((s) => s.toLowerCase()));
  const has = (...values: string[]) => values.some((value) => normalized.has(value.toLowerCase()));
  if (provider === 'google') {
    const broadMail = ['https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'];
    const broadCalendar = ['https://www.googleapis.com/auth/calendar'];
    switch (capability) {
      case 'mail.read': return has(...broadMail, 'https://www.googleapis.com/auth/gmail.readonly');
      case 'mail.draft': return has(...broadMail, 'https://www.googleapis.com/auth/gmail.compose');
      case 'mail.send': return has(...broadMail, 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose');
      case 'calendar.read': return has(...broadCalendar, 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.events');
      case 'calendar.write': return has(...broadCalendar, 'https://www.googleapis.com/auth/calendar.events');
    }
  }
  switch (capability) {
    case 'mail.read': return has('mail.read', 'mail.readwrite');
    case 'mail.draft': return has('mail.readwrite');
    case 'mail.send': return has('mail.send');
    case 'calendar.read': return has('calendars.read', 'calendars.readwrite');
    case 'calendar.write': return has('calendars.readwrite');
  }
}

/** Exchanges a PKCE authorization code at fixed provider endpoints and verifies the returned account identity. */
export async function exchangeAuthorizationCode(config: OAuthClientConfig, input: AuthorizationCodeInput, dependencies: OAuthExchangeDependencies = {}): Promise<{ result: OAuthBridgeResult; token: StoredOAuthToken }> {
  const requestedCapabilities = validateInput(config, input);
  const authority = config.provider === 'microsoft' ? validateAuthority(config.authority) : undefined;
  const redirectUri = validateRedirect(config);
  const fetcher = dependencies.fetcher ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? 15_000;
  const tokenUrl = config.provider === 'google' ? GOOGLE_TOKEN_URL : `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
  const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, code: input.authorizationCode, redirect_uri: redirectUri, code_verifier: input.codeVerifier });
  const { response: tokenResponse, data: tokenData } = await fetchJson(fetcher, tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }, timeoutMs, dependencies);
  if (!tokenResponse.ok) throw new Error('Provider rejected the authorization code.');
  if (typeof tokenData.access_token !== 'string' || !tokenData.access_token || !Number.isFinite(Number(tokenData.expires_in)) || Number(tokenData.expires_in) <= 0) throw new Error('Provider returned an invalid token response.');
  const scopes = grantedScopes(tokenData.scope);
  const accessToken = tokenData.access_token;
  const authorization = { authorization: `Bearer ${accessToken}` };
  const userinfoUrl = config.provider === 'google' ? GOOGLE_USERINFO_URL : GRAPH_USERINFO_URL;
  const { response: userResponse, data: user } = await fetchJson(fetcher, userinfoUrl, { method: 'GET', headers: authorization }, timeoutMs, dependencies);
  if (!userResponse.ok || typeof user.sub !== 'string' || !user.sub) throw new Error('Provider account identity could not be verified.');

  let displayName = typeof user.name === 'string' ? user.name.slice(0, 200) : '';
  let email = user.email_verified === true && typeof user.email === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(user.email) ? user.email.slice(0, 320) : undefined;
  let resourceUserId: string | undefined;
  if (config.provider === 'microsoft') {
    if (!scopes.some((s) => s.toLowerCase() === 'user.read')) throw new Error('Microsoft User.Read is required to bind the account to its Graph identity.');
    const { response: meResponse, data: me } = await fetchJson(fetcher, GRAPH_ME_URL, { method: 'GET', headers: authorization }, timeoutMs, dependencies);
    if (!meResponse.ok || typeof me.id !== 'string' || !me.id) throw new Error('Microsoft Graph account identity could not be verified.');
    resourceUserId = me.id;
    if (typeof me.displayName === 'string') displayName = me.displayName.slice(0, 200);
    const graphEmail = typeof me.mail === 'string' && me.mail.includes('@') ? me.mail : typeof me.userPrincipalName === 'string' && me.userPrincipalName.includes('@') ? me.userPrincipalName : undefined;
    if (graphEmail) email = graphEmail.slice(0, 320);
  }

  const identity: NonNullable<Account['identity']> = { providerNamespace: config.provider, clientId: config.clientId, subject: user.sub, ...(resourceUserId ? { resourceUserId } : {}) };
  const authorized = requestedCapabilities.filter((cap) => scopeGrantsCapability(config.provider, scopes, cap));
  const capabilities: AccountCapability[] = [];
  for (const cap of authorized) {
    if (cap === 'mail.read') {
      const probeUrl = config.provider === 'google' ? GOOGLE_MAIL_PROBE : GRAPH_MAIL_PROBE;
      const { response: probe } = await fetchJson(fetcher, probeUrl, { method: 'GET', headers: authorization }, timeoutMs, dependencies);
      if (probe.ok) capabilities.push(cap);
    } else if (cap === 'calendar.read') {
      const probeUrl = config.provider === 'google' ? GOOGLE_CALENDAR_PROBE : GRAPH_CALENDAR_PROBE;
      const { response: probe } = await fetchJson(fetcher, probeUrl, { method: 'GET', headers: authorization }, timeoutMs, dependencies);
      if (probe.ok) capabilities.push(cap);
    } else {
      // Scopes express provider authorization; write operations remain subject to provider acceptance.
      capabilities.push(cap);
    }
  }

  const expiresAt = (dependencies.now ?? Date.now)() + Number(tokenData.expires_in) * 1000;
  const token: StoredOAuthToken = { accessToken, ...(typeof tokenData.refresh_token === 'string' && tokenData.refresh_token ? { refreshToken: tokenData.refresh_token } : {}), expiresAt, identity };
  const result: OAuthBridgeResult = { provider: config.provider, accessToken, ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}), expiresAt,
    grantedScopes: scopes, requestedCapabilities, identity, displayName, ...(email ? { email } : {}), capabilities };
  return { result, token };
}
