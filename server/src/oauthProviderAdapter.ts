import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientSecretPost,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  fetchUserInfo,
  type Configuration,
  type CustomFetch,
} from 'openid-client';
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import type { OAuthStageCapability, OAuthStageProvider } from './oauthInstallStages.js';
import type { OAuthVerifiedPayload } from './oauthInstallStages.js';
import { Buffer } from 'node:buffer';

const PROVIDERS = Object.freeze({
  google: Object.freeze({ issuer: 'https://accounts.google.com', metadataIssuer: 'https://accounts.google.com', callbackPath: '/api/oauth/google/callback' }),
  microsoft: Object.freeze({ issuer: 'https://login.microsoftonline.com/common/v2.0',
    metadataIssuer: 'https://login.microsoftonline.com/{tenantid}/v2.0', callbackPath: '/api/oauth/microsoft/callback' }),
});
const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
const GOOGLE_SCOPES: Readonly<Record<OAuthStageCapability, readonly string[]>> = Object.freeze({
  'mail.read': ['https://www.googleapis.com/auth/gmail.readonly'],
  'mail.draft': ['https://www.googleapis.com/auth/gmail.compose'],
  'mail.send': ['https://www.googleapis.com/auth/gmail.send'],
  'calendar.read': ['https://www.googleapis.com/auth/calendar.readonly'],
  'calendar.write': ['https://www.googleapis.com/auth/calendar.events'],
});
const MICROSOFT_REQUEST_SCOPES: Readonly<Record<OAuthStageCapability, readonly string[]>> = Object.freeze({
  'mail.read': ['Mail.Read'],
  'mail.draft': ['Mail.ReadWrite'],
  'mail.send': ['Mail.Send'],
  'calendar.read': ['Calendars.Read'],
  'calendar.write': ['Calendars.ReadWrite'],
});
const MICROSOFT_GRANTED_SCOPES: Readonly<Record<OAuthStageCapability, readonly string[]>> = Object.freeze({
  'mail.read': ['Mail.Read', 'Mail.ReadWrite'],
  'mail.draft': ['Mail.ReadWrite'],
  'mail.send': ['Mail.Send'],
  'calendar.read': ['Calendars.Read', 'Calendars.ReadWrite'],
  'calendar.write': ['Calendars.ReadWrite'],
});
const VALID_CAPABILITIES = new Set<OAuthStageCapability>([
  'mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write',
]);
const TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const DISPLAY_NAME_MAX = 256;
const TOKEN_MAX = 16_384;
const GOOGLE_HOSTS = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'openidconnect.googleapis.com']);

export interface OAuthProviderRegistration {
  readonly registrationId: string;
  readonly provider: OAuthStageProvider;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface CreateServerOAuthProviderAdapterOptions {
  readonly canonicalOrigin: string;
  readonly registrations: readonly OAuthProviderRegistration[];
  readonly responseLifetime: OAuthResponseLifetime;
  readonly now?: () => number;
  readonly withProviderOwnership?: <T>(provider: OAuthStageProvider, operation: () => Promise<T>) => Promise<T>;
}

export interface OAuthResponseLifetimeRetry {
  (): Promise<void>;
  readonly subscribeSettled?: (listener: () => void) => () => void;
}

/** Structural Node ownership port; the adapter never implements raw-response cleanup itself. */
export type OAuthResponseLifetime = <T>(
  input: string | URL | Request,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  onCancelPending?: (retry: OAuthResponseLifetimeRetry) => void,
  beforeStart?: () => void,
) => Promise<T>;

export interface OAuthAuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly requestedCapabilities: readonly OAuthStageCapability[];
}

export interface OAuthExchangeRequest {
  readonly callbackUrl: string;
  readonly state: string;
  readonly nonce: string;
  readonly pkceVerifier: string;
  readonly requestedCapabilities: readonly OAuthStageCapability[];
  readonly signal?: AbortSignal;
  readonly assertCurrent?: () => void;
}

export interface ServerOAuthProviderAdapter {
  buildAuthorizationUrl(registrationId: string, request: OAuthAuthorizationRequest): Promise<URL>;
  exchangeVerified(registrationId: string, request: OAuthExchangeRequest): Promise<OAuthVerifiedPayload>;
}

export class OAuthProviderAdapterError extends Error {
  constructor(readonly code: 'oauth_provider_invalid_input' | 'oauth_provider_failed' | 'oauth_provider_cancelled') {
    super(code);
    this.name = 'OAuthProviderAdapterError';
  }
}

interface Registration extends OAuthProviderRegistration {
  readonly callbackUrl: string;
  readonly issuer: string;
}

interface TokenFields {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
  readonly id_token?: unknown;
}

function invalidInput(): never { throw new OAuthProviderAdapterError('oauth_provider_invalid_input'); }
function providerFailure(): never { throw new OAuthProviderAdapterError('oauth_provider_failed'); }

function canonicalOrigin(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return invalidInput(); }
  const loopbackHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !loopbackHttp) || parsed.origin !== value || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      parsed.username || parsed.password) return invalidInput();
  return parsed;
}

function validRegistration(value: OAuthProviderRegistration): boolean {
  return typeof value.registrationId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value.registrationId) &&
    (value.provider === 'google' || value.provider === 'microsoft') &&
    boundedString(value.clientId, 256) &&
    typeof value.clientSecret === 'string' && value.clientSecret.length > 0 && value.clientSecret.length <= TOKEN_MAX &&
    !/[\u0000-\u001f\u007f]/.test(value.clientSecret);
}

function normalizeCapabilities(value: readonly OAuthStageCapability[]): readonly OAuthStageCapability[] {
  if (!Array.isArray(value) || value.length > 5 || value.some((item) => !VALID_CAPABILITIES.has(item)) ||
      new Set(value).size !== value.length || value.includes('calendar.write') && !value.includes('calendar.read')) return invalidInput();
  return Object.freeze([...value]);
}

function validateProof(value: string): boolean { return typeof value === 'string' && BASE64URL_43.test(value); }

function trustedCallback(input: string, origin: URL, provider: OAuthStageProvider): URL {
  if (input.length > 8192) return invalidInput();
  let parsed: URL;
  try { parsed = new URL(input); } catch { return invalidInput(); }
  if (parsed.origin !== origin.origin || parsed.pathname !== PROVIDERS[provider].callbackPath || parsed.hash ||
      parsed.username || parsed.password || parsed.protocol !== origin.protocol) return invalidInput();
  return parsed;
}

function endpointUrl(value: unknown, provider: OAuthStageProvider): URL {
  if (typeof value !== 'string') return providerFailure();
  let url: URL;
  try { url = new URL(value); } catch { return providerFailure(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !isTrustedProviderHost(url.hostname, provider)) {
    return providerFailure();
  }
  return url;
}

function isTrustedProviderHost(host: string, provider: OAuthStageProvider): boolean {
  const hostname = host.toLowerCase();
  return provider === 'google'
    ? GOOGLE_HOSTS.has(hostname)
    : hostname === 'login.microsoftonline.com' || hostname === 'graph.microsoft.com';
}

function capabilityScopes(provider: OAuthStageProvider, capability: OAuthStageCapability): readonly string[] {
  return provider === 'google' ? GOOGLE_SCOPES[capability] : MICROSOFT_REQUEST_SCOPES[capability];
}

function capabilityGrantScopes(provider: OAuthStageProvider, capability: OAuthStageCapability): readonly string[] {
  if (provider === 'microsoft') return MICROSOFT_GRANTED_SCOPES[capability];
  switch (capability) {
    case 'mail.read': return ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'];
    case 'mail.draft': return ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'];
    case 'mail.send': return ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'];
    case 'calendar.read': return ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.events'];
    case 'calendar.write': return ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'];
  }
}

function requestedScopes(provider: OAuthStageProvider, capabilities: readonly OAuthStageCapability[]): string[] {
  const scopes = provider === 'google' ? ['openid', 'profile', 'email'] : ['openid', 'profile', 'email', 'offline_access', 'User.Read'];
  for (const capability of capabilities) for (const scope of capabilityScopes(provider, capability)) {
    if (!scopes.some((existing) => existing.toLowerCase() === scope.toLowerCase())) scopes.push(scope);
  }
  if (provider === 'google') scopes.push('https://www.googleapis.com/auth/userinfo.profile');
  return scopes;
}

function parseGrantedScopes(value: unknown): readonly string[] {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    return providerFailure();
  }
  const scopes = value.split(/\s+/).filter(Boolean);
  if (!scopes.length || scopes.length > 64 || scopes.some((scope) => !boundedString(scope, 256)) || new Set(scopes).size !== scopes.length) {
    return providerFailure();
  }
  return Object.freeze(scopes);
}

function grantedCapabilities(provider: OAuthStageProvider, requested: readonly OAuthStageCapability[], scopes: readonly string[]): readonly OAuthStageCapability[] {
  const granted = new Set(scopes.map((scope) => scope.toLowerCase()));
  return Object.freeze(requested.filter((capability) => capabilityGrantScopes(provider, capability)
    .some((scope) => granted.has(scope.toLowerCase()))));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) &&
    Buffer.from(value, 'utf8').toString('utf8') === value;
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OAuthProviderAdapterError('oauth_provider_cancelled');
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedBody(response: Response, signal: AbortSignal, limit: number): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    providerFailure();
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let abortListener: (() => void) | undefined;
  let activeRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let activeReadSettled = true;
  let releaseWhenSettled = false;
  const releaseReader = () => { try { reader.releaseLock(); } catch { /* A pending read owns the lock until it settles. */ } };
  const abort = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new OAuthProviderAdapterError('oauth_provider_cancelled'));
    else {
      abortListener = () => reject(new OAuthProviderAdapterError('oauth_provider_cancelled'));
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  try {
    while (true) {
      activeReadSettled = false;
      activeRead = reader.read();
      void activeRead.then(() => {
        activeReadSettled = true;
        if (releaseWhenSettled) releaseReader();
      }, () => {
        activeReadSettled = true;
        if (releaseWhenSettled) releaseReader();
      });
      const result = await Promise.race([activeRead, abort]);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) providerFailure();
      chunks.push(result.value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return combined;
  } catch (error) {
    if (signal.aborted) throw new OAuthProviderAdapterError('oauth_provider_cancelled');
    throw error;
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (activeReadSettled) releaseReader();
    else releaseWhenSettled = true;
  }
}

function makeFetch(provider: OAuthStageProvider, responseLifetime: OAuthResponseLifetime, outerSignal?: AbortSignal): CustomFetch {
  return async (resource, init) => {
    checkSignal(outerSignal);
    let url: URL;
    try { url = new URL(resource); } catch { return providerFailure(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !isTrustedProviderHost(url.hostname, provider)) {
      return providerFailure();
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
    const signals = [deadline.signal, ...(init.signal ? [init.signal] : []), ...(outerSignal ? [outerSignal] : [])];
    const signal = AbortSignal.any(signals);
    const lifetimePromise = responseLifetime<Response>(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body as BodyInit | null } : {}),
      signal,
      redirect: 'error',
      ...(init.duplex ? { duplex: init.duplex } : {}),
    }, async (response) => {
      if (response.status >= 300 && response.status < 400) providerFailure();
      const body = await readBoundedBody(response, signal, MAX_RESPONSE_BYTES);
      const detached = new Response(body === null ? null : Buffer.from(body), {
        status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers),
      });
      for (const key of ['url', 'redirected', 'type'] as const) {
        try { Object.defineProperty(detached, key, { configurable: true, value: response[key] }); } catch { /* Native metadata can be non-configurable. */ }
      }
      return detached;
    }, undefined, () => checkSignal(outerSignal));
    void lifetimePromise.catch(() => undefined);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new OAuthProviderAdapterError('oauth_provider_cancelled'));
      else {
        abortListener = () => reject(new OAuthProviderAdapterError('oauth_provider_cancelled'));
        signal.addEventListener('abort', abortListener, { once: true });
      }
    });
    try {
      return await Promise.race([lifetimePromise, aborted]);
    } catch (error) {
      if (outerSignal?.aborted) throw new OAuthProviderAdapterError('oauth_provider_cancelled');
      if (deadline.signal.aborted) throw new OAuthProviderAdapterError('oauth_provider_failed');
      if (error instanceof OAuthProviderAdapterError) throw error;
      throw new OAuthProviderAdapterError('oauth_provider_failed');
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
      clearTimeout(timer);
    }
  };
}

async function parseResponseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) return providerFailure();
  let parsed: unknown;
  try { parsed = await response.json(); } catch { return providerFailure(); }
  return jsonObject(parsed) ? parsed : providerFailure();
}

function validatedMetadata(config: Configuration, provider: OAuthStageProvider): Readonly<Record<string, string>> {
  const metadata = config.serverMetadata();
  if (metadata.issuer !== PROVIDERS[provider].metadataIssuer) return providerFailure();
  const result: Record<string, string> = {};
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    result[key] = endpointUrl(metadata[key], provider).href;
  }
  if (provider === 'google') result.userinfo_endpoint = endpointUrl(metadata.userinfo_endpoint, provider).href;
  return Object.freeze(result);
}

async function discover(registration: Registration, responseLifetime: OAuthResponseLifetime, signal?: AbortSignal): Promise<Configuration> {
  const config = await discovery(new URL(registration.issuer), registration.clientId, { redirect_uris: [registration.callbackUrl],
    token_endpoint_auth_method: 'client_secret_post' }, ClientSecretPost(registration.clientSecret), {
    timeout: REQUEST_TIMEOUT_MS / 1000, [customFetch]: makeFetch(registration.provider, responseLifetime, signal),
    execute: [enableNonRepudiationChecks],
  });
  validatedMetadata(config, registration.provider);
  return config;
}

function normalizeTokenFields(value: unknown, now: number): { accessToken: string; refreshToken: string; expiresAt: number; scopes: readonly string[] } {
  if (!jsonObject(value)) return providerFailure();
  const token = value as TokenFields;
  if (!boundedString(token.access_token, TOKEN_MAX) || !boundedString(token.refresh_token, TOKEN_MAX) ||
      typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || token.expires_in > 31_536_000 ||
      !Number.isSafeInteger(now) || now < 0) return providerFailure();
  const expiresAt = now + Math.floor(token.expires_in * 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return providerFailure();
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt,
    scopes: parseGrantedScopes(token.scope) };
}

function responseHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  result.delete('content-length');
  result.delete('content-encoding');
  return result;
}

function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  return parseResponseJson(response);
}

async function verifyMicrosoftIdToken(input: { token: string; config: Configuration; fetch: CustomFetch; clientId: string;
  now: number; tenantId: string }): Promise<Record<string, unknown>> {
  const metadata = validatedMetadata(input.config, 'microsoft');
  const jwksUrl = metadata.jwks_uri;
  if (!jwksUrl || !/\/common\/discovery\/v2\.0\/keys(?:\?|$)/.test(new URL(jwksUrl).pathname + new URL(jwksUrl).search)) return providerFailure();
  const response = await input.fetch(jwksUrl, { method: 'GET', headers: {}, body: null, redirect: 'manual' });
  const body = await jsonResponse(response);
  if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 256) return providerFailure();
  const issuer = `https://login.microsoftonline.com/${input.tenantId}/v2.0`;
  const templateIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
  const keys = body.keys.filter((key): key is JWK & { issuer: string } => jsonObject(key) &&
    (key.issuer === issuer || key.issuer === templateIssuer) && typeof key.issuer === 'string');
  if (!keys.length) return providerFailure();
  const verified = await jwtVerify(input.token, createLocalJWKSet({ keys }), {
    issuer, audience: input.clientId, algorithms: ['RS256'], currentDate: new Date(input.now),
  });
  if (verified.payload.tid !== input.tenantId || typeof verified.payload.sub !== 'string' ||
      !boundedString(verified.payload.sub, 1024)) return providerFailure();
  return verified.payload;
}

export function createServerOAuthProviderAdapter(options: CreateServerOAuthProviderAdapterOptions): ServerOAuthProviderAdapter {
  if (!options || typeof options.responseLifetime !== 'function' || !Array.isArray(options.registrations) ||
      options.registrations.length < 1 || options.registrations.length > 16) invalidInput();
  const origin = canonicalOrigin(options.canonicalOrigin);
  const responseLifetime = options.responseLifetime;
  const now = options.now ?? Date.now;
  const registrations = new Map<string, Registration>();
  const providerRegistrations = new Set<OAuthStageProvider>();
  for (const raw of options.registrations) {
    if (!validRegistration(raw) || registrations.has(raw.registrationId) || providerRegistrations.has(raw.provider)) invalidInput();
    const provider = raw.provider as OAuthStageProvider;
    providerRegistrations.add(provider);
    registrations.set(raw.registrationId, Object.freeze({ ...raw,
      callbackUrl: new URL(PROVIDERS[provider].callbackPath, origin).href, issuer: PROVIDERS[provider].issuer }));
  }
  const own = async <T>(provider: OAuthStageProvider, operation: () => Promise<T>): Promise<T> => {
    try {
      return await (options.withProviderOwnership ? options.withProviderOwnership(provider, operation) : operation());
    } catch (error) {
      if (error instanceof OAuthProviderAdapterError) throw error;
      throw new OAuthProviderAdapterError('oauth_provider_failed');
    }
  };
  const getRegistration = (id: string): Registration => {
    const value = registrations.get(id);
    if (!value) return invalidInput();
    return value;
  };

  return Object.freeze({
    buildAuthorizationUrl: async (registrationId: string, request: OAuthAuthorizationRequest): Promise<URL> => {
      const registration = getRegistration(registrationId);
      const requested = normalizeCapabilities(request?.requestedCapabilities);
      if (!validateProof(request.state) || !validateProof(request.nonce) || !validateProof(request.codeChallenge)) invalidInput();
      return own(registration.provider, async () => {
        try {
          const config = await discover(registration, responseLifetime);
          const metadata = validatedMetadata(config, registration.provider);
          const params = {
            redirect_uri: registration.callbackUrl,
            response_type: 'code',
            scope: requestedScopes(registration.provider, requested).join(' '),
            state: request.state,
            nonce: request.nonce,
            code_challenge: request.codeChallenge,
            code_challenge_method: 'S256',
            ...(registration.provider === 'google' ? { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' } : {}),
          };
          const url = buildAuthorizationUrl(config, params);
          if (url.origin !== new URL(metadata['authorization_endpoint']!).origin) providerFailure();
          return url;
        } catch (error) {
          if (error instanceof OAuthProviderAdapterError) throw error;
          throw new OAuthProviderAdapterError('oauth_provider_failed');
        }
      });
    },
    exchangeVerified: async (registrationId: string, request: OAuthExchangeRequest): Promise<OAuthVerifiedPayload> => {
      const registration = getRegistration(registrationId);
      const provider = registration.provider;
      const requested = normalizeCapabilities(request?.requestedCapabilities);
      if (!validateProof(request.state) || !validateProof(request.nonce) || !validateProof(request.pkceVerifier) ||
          typeof request.callbackUrl !== 'string') invalidInput();
      const callback = trustedCallback(request.callbackUrl, origin, provider);
      const assertCurrent = () => { checkSignal(request.signal); request.assertCurrent?.(); };
      return own(provider, async () => {
        try {
          assertCurrent();
          const config = await discover(registration, responseLifetime, request.signal);
          assertCurrent();
          validatedMetadata(config, provider);
          const idTokenResponse = await authorizationCodeGrant(config, callback, {
            expectedState: request.state, expectedNonce: request.nonce,
            pkceCodeVerifier: request.pkceVerifier, idTokenExpected: true,
          });
          assertCurrent();
          const tokens = normalizeTokenFields(idTokenResponse, now());
          const idToken = idTokenResponse.id_token;
          if (!boundedString(idToken, TOKEN_MAX)) providerFailure();
          const claims = idTokenResponse.claims();
          if (!claims || typeof claims.sub !== 'string' || !boundedString(claims.sub, 1024)) providerFailure();
          if (provider === 'google') {
            if (claims.iss !== 'https://accounts.google.com') providerFailure();
            const user = await fetchUserInfo(config, tokens.accessToken, claims.sub);
            assertCurrent();
            if (!jsonObject(user) || user.sub !== claims.sub) providerFailure();
            const displayName = boundedString(user.name, DISPLAY_NAME_MAX) ? user.name :
              (boundedString(claims.name, DISPLAY_NAME_MAX) ? claims.name : 'Google account');
            const email = claims.email_verified === true && boundedString(claims.email, 320) ? claims.email : undefined;
            return Object.freeze({ provider, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt, grantedScopes: tokens.scopes, requestedCapabilities: requested,
              capabilities: grantedCapabilities(provider, requested, tokens.scopes),
              identity: Object.freeze({ providerNamespace: provider, clientId: registration.clientId, subject: claims.sub,
                issuer: 'https://accounts.google.com' }),
              displayName, ...(email ? { email } : {}) });
          }

          const tenantId = claims.tid;
          if (typeof tenantId !== 'string' || !TENANT_GUID.test(tenantId) ||
              claims.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0`) providerFailure();
          const verifiedClaims = await verifyMicrosoftIdToken({ token: idToken, config, fetch: makeFetch(provider, responseLifetime, request.signal),
            clientId: registration.clientId, now: now(), tenantId });
          assertCurrent();
          if (verifiedClaims.nonce !== request.nonce || verifiedClaims.sub !== claims.sub || verifiedClaims.iss !== claims.iss) providerFailure();
          if (!tokens.scopes.some((scope) => scope.toLowerCase() === 'user.read')) providerFailure();
          const microsoftUser = await fetchUserInfo(config, tokens.accessToken, claims.sub);
          assertCurrent();
          if (!jsonObject(microsoftUser) || microsoftUser.sub !== claims.sub) providerFailure();
          const graphResponse = await makeFetch(provider, responseLifetime, request.signal)(GRAPH_ME, {
            method: 'GET', headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' }, body: null, redirect: 'manual',
          });
          const graph = await jsonResponse(graphResponse);
          assertCurrent();
          if (!boundedString(graph.id, 512)) providerFailure();
          const displayName = boundedString(graph.displayName, DISPLAY_NAME_MAX) ? graph.displayName : 'Microsoft account';
          const emailCandidate = boundedString(graph.mail, 320) ? graph.mail :
            (boundedString(graph.userPrincipalName, 320) ? graph.userPrincipalName : undefined);
          return Object.freeze({ provider, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt, grantedScopes: tokens.scopes, requestedCapabilities: requested,
            capabilities: grantedCapabilities(provider, requested, tokens.scopes),
            identity: Object.freeze({ providerNamespace: provider, clientId: registration.clientId, subject: claims.sub,
              issuer: claims.iss, tenantId, resourceUserId: graph.id }),
            displayName, ...(emailCandidate ? { email: emailCandidate } : {}) });
        } catch (error) {
          if (error instanceof OAuthProviderAdapterError) throw error;
          if (request.signal?.aborted) throw new OAuthProviderAdapterError('oauth_provider_cancelled');
          throw new OAuthProviderAdapterError('oauth_provider_failed');
        }
      }).catch((error: unknown) => {
        if (error instanceof OAuthProviderAdapterError) throw error;
        if (request.signal?.aborted) throw new OAuthProviderAdapterError('oauth_provider_cancelled');
        throw new OAuthProviderAdapterError('oauth_provider_failed');
      });
    },
  });
}
