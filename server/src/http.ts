import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AuthError, type AuthService } from './auth.js';
import { KernelError } from './kernel.js';
import { VaultError } from './vault.js';
import type { SafeCredentialMetadataSnapshot, ServerCredentialCommandService } from './credentialCommands.js';
import type { WorkspaceHttpAdmission, WorkspaceHttpApi } from './workspaceHttp.js';
import { KNOWLEDGE_SOURCE_CHOICES_PATH, KNOWLEDGE_SUGGESTION_REVIEW_PATH, parseKnowledgeHttpRead } from './knowledgeHttp.js';
import type { AudioHttpApi, AudioUploadCaptureHeader } from './audioHttp.js';
import type { OAuthHttpApi } from './oauthHttp.js';
import { OAuthConnectionServiceError } from './oauthConnectionService.js';
import { registerAcceptedHttpServer, trackAcceptedHttpRequest } from './httpRequestDrain.js';

const BODY_LIMIT = 16 * 1024;
const WORKSPACE_COMMAND_TEXT_BODY_LIMIT = 1024 * 1024;
const CREDENTIAL_BODY_LIMIT = 2 * 16 * 1024 * 1024 + 64 * 1024;
const COOKIE_LIMIT = 4096;
const BODY_TIMEOUT_MS = 10_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const COMMAND_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASHED_BASENAME_RE = /(?:^|[._-])[a-f\d]{8,}(?:[._-]|$)/i;
const PROTECTED_PATH_RE = /(?:^|\/)(?:api|auth|oauth|callback|audio|uploads?|secrets?|recordings?|private|state)(?:\/|$)/i;
const FIXED_PUBLIC_PATHS = new Map([
  ['/manifest.webmanifest', 'manifest.webmanifest'],
  ['/sw.js', 'sw.js'],
  ['/assets/still-icon.png', 'assets/still-icon.png'],
]);
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};

export interface StillHttpOptions {
  readonly auth: AuthService;
  readonly canonicalOrigin: string;
  readonly staticRoot: string;
  readonly allowLocalHttp?: boolean;
  readonly credentialCommands?: ServerCredentialCommandService;
  readonly workspaceApi?: WorkspaceHttpApi;
  readonly audioApi?: AudioHttpApi;
  readonly oauthApi?: OAuthHttpApi;
  /** Trusted host lifecycle fence checked at request admission and after awaited request bodies. */
  readonly admissionOpen?: () => boolean;
}

interface CookieValues { readonly session?: string; readonly preauth?: string; readonly values: ReadonlyMap<string, string> }
interface HttpProblem { readonly status: number; readonly code: string }

function problem(status: number, code: string): HttpProblem { return { status, code }; }
function isHttpProblem(error: unknown): error is HttpProblem {
  return typeof error === 'object' && error !== null && 'status' in error && 'code' in error;
}

function assertCanonicalOrigin(origin: string, allowLocalHttp: boolean): URL {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new TypeError('canonical_origin_invalid'); }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
    (parsed.protocol !== 'https:' && !(allowLocalHttp && localHttp))) throw new TypeError('canonical_origin_invalid');
  return parsed;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function safePath(rawUrl: string | undefined): { readonly pathname: string; readonly hasQuery: boolean; readonly rawQuery?: string } {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096 || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
    throw problem(400, 'bad_request');
  }
  const q = rawUrl.indexOf('?');
  const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
  if (rawPath.includes('\\') || /%(?:2f|5c)/i.test(rawPath) || /%00/i.test(rawPath)) throw problem(400, 'bad_request');
  let pathname: string;
  try { pathname = decodeURIComponent(rawPath); } catch { throw problem(400, 'bad_request'); }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.startsWith('//') ||
    pathname.split('/').some((segment) => segment === '.' || segment === '..')) throw problem(400, 'bad_request');
  return { pathname, hasQuery: q >= 0, ...(q >= 0 ? { rawQuery: rawUrl.slice(q + 1) } : {}) };
}

function uniqueHeader(request: IncomingMessage, name: string, required = false): string | undefined {
  const matches: string[] = [];
  for (let i = 0; i + 1 < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name.toLowerCase()) matches.push(request.rawHeaders[i + 1] ?? '');
  }
  if (matches.length > 1 || (required && matches.length !== 1)) throw problem(400, 'bad_request');
  const value = matches[0];
  if (value !== undefined && /[\r\n\0]/.test(value)) throw problem(400, 'bad_request');
  return value;
}

function readCookies(request: IncomingMessage): CookieValues {
  const cookieHeader = uniqueHeader(request, 'cookie');
  if (cookieHeader === undefined) return { values: new Map() };
  if (cookieHeader.length > COOKIE_LIMIT) throw problem(400, 'bad_request');
  const values = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (values.size >= 32) throw problem(400, 'bad_request');
    const separator = trimmed.indexOf('=');
    if (separator <= 0) throw problem(400, 'bad_request');
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value) || values.has(name)) {
      throw problem(400, 'bad_request');
    }
    values.set(name, value);
  }
  const session = values.get('__Host-still_session');
  const preauth = values.get('__Host-still_preauth');
  if ((session !== undefined && !TOKEN_RE.test(session)) || (preauth !== undefined && !TOKEN_RE.test(preauth))) {
    throw problem(400, 'bad_request');
  }
  return { ...(session === undefined ? {} : { session }), ...(preauth === undefined ? {} : { preauth }), values };
}

function strictQuery(raw: string | undefined, allowed: readonly string[]): Map<string, string> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) throw problem(400, 'bad_request');
  const result = new Map<string, string>();
  for (const part of raw.split('&')) {
    if (!part) throw problem(400, 'bad_request');
    const separator = part.indexOf('=');
    if (separator <= 0) throw problem(400, 'bad_request');
    let key: string; let value: string;
    try {
      key = decodeURIComponent(part.slice(0, separator).replace(/\+/g, ' '));
      value = decodeURIComponent(part.slice(separator + 1).replace(/\+/g, ' '));
    } catch { throw problem(400, 'bad_request'); }
    if (!allowed.includes(key) || result.has(key) || /[\u0000-\u001f\u007f]/.test(key + value)) throw problem(400, 'bad_request');
    result.set(key, value);
  }
  return result;
}

function callbackQuery(raw: string | undefined, provider: 'google' | 'microsoft'):
  { readonly state: string; readonly code?: string; readonly error?: string } {
  const allowed = provider === 'google'
    ? ['state', 'code', 'error', 'scope', 'authuser', 'prompt', 'error_description', 'error_uri']
    : ['state', 'code', 'error', 'session_state', 'error_description', 'error_uri'];
  const values = strictQuery(raw, allowed);
  const state = values.get('state'); const code = values.get('code'); const error = values.get('error');
  if (!state || !TOKEN_RE.test(state) || (code === undefined) === (error === undefined) ||
      code !== undefined && (!code || code.length > 4096) || error !== undefined && (!error || error.length > 256)) throw problem(400, 'bad_request');
  for (const [name, value] of values) {
    if (['state', 'code', 'error'].includes(name)) continue;
    const max = name === 'error_uri' || name === 'error_description' ? 2048 : name === 'scope' ? 4096 : 128;
    if (value.length > max) throw problem(400, 'bad_request');
  }
  return Object.freeze({ state, ...(code === undefined ? {} : { code }), ...(error === undefined ? {} : { error }) });
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}

function sendJson(response: ServerResponse, status: number, value: unknown, head = false, extraHeaders: Record<string, string | string[]> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length),
    'Cache-Control': 'no-store', Pragma: 'no-cache', ...extraHeaders });
  response.end(head ? undefined : body);
}

function sendError(response: ServerResponse, status: number, code: string): void {
  sendJson(response, status, { error: code });
}

function authStatus(error: AuthError): number {
  switch (error.code) {
    case 'origin_rejected': return 403;
    case 'csrf_rejected': return 403;
    case 'auth_throttled': return 429;
    case 'auth_busy': case 'auth_closed': return 503;
    case 'challenge_invalid': return 403;
    case 'invalid_input': case 'invalid_password': return 400;
    case 'unauthenticated': return 401;
    default: return 503;
  }
}

function jsonCookies(sessionToken: string | undefined, preauthToken: string | undefined): string[] {
  const cookies: string[] = [];
  if (sessionToken !== undefined) cookies.push(`__Host-still_session=${sessionToken}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict`);
  else cookies.push('__Host-still_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict');
  if (preauthToken !== undefined) cookies.push(`__Host-still_preauth=${preauthToken}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict`);
  else cookies.push('__Host-still_preauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict');
  return cookies;
}

async function readJsonBody(request: IncomingMessage, response: ServerResponse, maxBytes = BODY_LIMIT,
  selectValueLimit?: (value: unknown) => number): Promise<unknown> {
  const contentType = uniqueHeader(request, 'content-type', true) ?? '';
  const contentEncoding = uniqueHeader(request, 'content-encoding');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
    (contentEncoding !== undefined && contentEncoding.toLowerCase() !== 'identity')) throw problem(415, 'unsupported_media_type');
  const lengthHeader = uniqueHeader(request, 'content-length');
  if (lengthHeader !== undefined && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > maxBytes)) {
    response.setHeader('Connection', 'close');
    request.resume();
    throw problem(413, 'request_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      response.setHeader('Connection', 'close');
      failRequest(problem(408, 'request_timeout'));
      request.resume();
    }, BODY_TIMEOUT_MS);
    const cleanup = () => { clearTimeout(timeout); request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted); };
    const failRequest = (error: unknown) => { cleanup(); rejectPromise(error); };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) { response.setHeader('Connection', 'close'); failRequest(problem(413, 'request_too_large')); request.resume(); return; }
      chunks.push(bytes);
    };
    const onEnd = () => { cleanup(); resolvePromise(); };
    const onError = () => failRequest(problem(400, 'bad_request'));
    const onAborted = () => failRequest(problem(400, 'bad_request'));
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
  });
  const text = Buffer.concat(chunks, size).toString('utf8');
  if (Buffer.from(text, 'utf8').length !== size) throw problem(400, 'bad_request');
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw problem(400, 'bad_request'); }
  if (selectValueLimit && size > selectValueLimit(parsed)) throw problem(413, 'request_too_large');
  return parsed;
}

function workspaceReadAdmission(request: IncomingMessage, auth: AuthService, canonicalOrigin: URL): WorkspaceHttpAdmission {
  const cookies = readCookies(request);
  if (!cookies.session) throw problem(401, 'unauthenticated');
  const session = auth.getSession(cookies.session);
  if (!session.authenticated) throw problem(401, 'unauthenticated');
  const captured = Object.freeze({ sessionToken: cookies.session, origin: canonicalOrigin.origin, csrf: session.csrfToken });
  const assertCurrent = () => { auth.assertMutation(captured.sessionToken, captured.origin, captured.csrf); };
  assertCurrent();
  return Object.freeze({ sessionToken: captured.sessionToken, assertCurrent });
}

function workspaceMutationAdmission(request: IncomingMessage, auth: AuthService, canonicalOrigin: URL): WorkspaceHttpAdmission {
  const captured = authenticatedMutation(request, auth, canonicalOrigin);
  const assertCurrent = () => { auth.assertMutation(captured.sessionToken, captured.origin, captured.csrf); };
  assertCurrent();
  return Object.freeze({ sessionToken: captured.sessionToken, assertCurrent });
}

function workspaceFailure(error: unknown): { readonly status: number; readonly code: string } {
  if (error instanceof OAuthConnectionServiceError) {
    switch (error.code) {
      case 'oauth_invalid_input': case 'oauth_callback_invalid': return { status: 400, code: 'invalid_oauth_request' };
      case 'oauth_not_found': return { status: 404, code: 'oauth_not_found' };
      case 'oauth_conflict': case 'oauth_stale_workspace': case 'oauth_start_in_progress': return { status: 409, code: 'oauth_conflict' };
      case 'oauth_original_session_inactive': return { status: 401, code: 'unauthenticated' };
      case 'oauth_unavailable': return { status: 503, code: 'oauth_unavailable' };
      case 'oauth_exchange_unknown': return { status: 503, code: 'oauth_inspect_required' };
      default: return { status: 503, code: 'service_unavailable' };
    }
  }
  if (isHttpProblem(error)) {
    const expected = new Set(['bad_request', 'unsupported_media_type', 'request_too_large', 'request_timeout',
      'unauthenticated', 'origin_rejected', 'csrf_rejected']);
    if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 499 && expected.has(error.code)) {
      return { status: error.status, code: error.code };
    }
    return { status: 503, code: 'service_unavailable' };
  }
  if (error instanceof AuthError) return { status: authStatus(error), code: error.code };
  if (error instanceof KernelError) {
    if (error.code === 'unauthenticated') return { status: 401, code: 'unauthenticated' };
    if (error.code === 'forbidden') return { status: 403, code: 'forbidden' };
    if (['invalid_id', 'invalid_input', 'invalid_json', 'size_limit'].includes(error.code)) {
      return { status: 400, code: 'invalid_workspace_command' };
    }
    if (['stale_epoch', 'stale_account', 'idempotency_conflict'].includes(error.code)) return { status: 409, code: 'workspace_conflict' };
    return { status: 503, code: 'service_unavailable' };
  }
  if (error instanceof Error) {
    if (error.message === 'command_history_cursor_invalid') return { status: 400, code: 'bad_request' };
    if (error.message === 'audio_history_cursor_invalid') return { status: 400, code: 'bad_request' };
    if (['workspace_command_invalid', 'workspace_command_id_invalid', 'workspace_command_receipt_invalid'].includes(error.message)) {
      return { status: 400, code: 'invalid_workspace_command' };
    }
    if (error.message === 'workspace_refresh_required') return { status: 409, code: 'workspace_refresh_required' };
    if (['workspace_read_stale', 'workspace_runtime_busy'].includes(error.message)) return { status: 409, code: 'workspace_conflict' };
    if (['This command idempotency key is already bound to different ownership or request content.',
      'The workspace revision changed before command admission.', 'The workspace runtime is busy.',
      'workspace_ownership_changed', 'workspace_loaded_revision_mismatch'].includes(error.message)) {
      return { status: 409, code: 'workspace_conflict' };
    }
  }
  return { status: 503, code: 'service_unavailable' };
}

function sendWorkspaceFailure(response: ServerResponse, error: unknown): void {
  const mapped = workspaceFailure(error);
  sendError(response, mapped.status, mapped.code);
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, 'bad_request');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(object, key))) {
    throw problem(400, 'bad_request');
  }
  return object;
}

function parseAudioCaptureHeader(value: string | undefined): AudioUploadCaptureHeader {
  if (!value || value.length > 2048) throw problem(400, 'bad_request');
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw problem(400, 'bad_request'); }
  const capture = exactObject(parsed, ['id', 'capturedAt', 'timeZone']);
  if (typeof capture.id !== 'string' || !COMMAND_ID_RE.test(capture.id) ||
      typeof capture.capturedAt !== 'string' || capture.capturedAt.length > 40 ||
      !Number.isFinite(Date.parse(capture.capturedAt)) || new Date(Date.parse(capture.capturedAt)).toISOString() !== capture.capturedAt ||
      typeof capture.timeZone !== 'string' || capture.timeZone.length < 1 || capture.timeZone.length > 100 || /[\u0000-\u001f\u007f]/.test(capture.timeZone)) {
    throw problem(400, 'bad_request');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: capture.timeZone }).format(0); }
  catch { throw problem(400, 'bad_request'); }
  return Object.freeze({ id: capture.id, capturedAt: capture.capturedAt, timeZone: capture.timeZone });
}

function audioUploadLength(request: IncomingMessage): number | undefined {
  const value = uniqueHeader(request, 'content-length');
  if (value === undefined) return undefined;
  const size = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(size) || size <= 0 || size > 40 * 1024 * 1024) {
    throw problem(413, 'request_too_large');
  }
  return size;
}

function parseAudioContentType(value: string | undefined): string {
  if (typeof value !== 'string' || value.length > 128) throw problem(415, 'unsupported_media_type');
  const parts = value.split(';').map((part) => part.trim().toLowerCase());
  const base = parts[0];
  const allowedCodecs: Readonly<Record<string, readonly string[]>> = {
    'audio/mp4': ['codecs=mp4a.40.2', 'codecs="mp4a.40.2"'],
    'audio/webm': ['codecs=opus', 'codecs="opus"'],
    'audio/ogg': ['codecs=opus', 'codecs="opus"'],
  };
  if (!base || !['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg'].includes(base) ||
      parts.length > 2 || (parts.length === 2 && !allowedCodecs[base]?.includes(parts[1]!))) {
    throw problem(415, 'unsupported_media_type');
  }
  return base;
}

function assertSafeAudioHeaders(headers: Readonly<Record<string, string>>): void {
  const allowed = new Set(['accept-ranges', 'cache-control', 'content-type', 'content-disposition', 'content-length', 'content-range']);
  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name.toLowerCase()) || /[\r\n\0]/.test(value)) throw problem(503, 'service_unavailable');
  }
}

function credentialObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, 'invalid_credential_request');
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw problem(400, 'invalid_credential_request');
  }
  return object;
}

function canonicalCredentialValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalCredentialValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) target[key] = canonicalCredentialValue(source[key]);
    return target;
  }
  throw problem(400, 'invalid_credential_request');
}

function canonicalCredentialBody(value: unknown): string {
  const body = canonicalCredentialValue(value);
  try { return JSON.stringify(body); }
  catch { throw problem(400, 'invalid_credential_request'); }
}

function validateCredentialRequest(value: unknown, operation: 'put' | 'delete'): string {
  const body = credentialObject(value, operation === 'put'
    ? ['expectedPrivacyEpoch', 'expectedGenerations', 'keys']
    : ['expectedPrivacyEpoch', 'expectedGenerations', 'kinds']);
  if (!Number.isSafeInteger(body.expectedPrivacyEpoch) || (body.expectedPrivacyEpoch as number) < 0) {
    throw problem(400, 'invalid_credential_request');
  }
  const allowedKinds = ['openrouter', 'speech'];
  const requestedKinds: string[] = [];
  if (operation === 'put') {
    const keys = body.keys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw problem(400, 'invalid_credential_request');
    for (const kind of Object.keys(keys)) {
      const secret = (keys as Record<string, unknown>)[kind];
      if (!allowedKinds.includes(kind) || typeof secret !== 'string' || secret.length === 0 ||
        Buffer.from(secret, 'utf8').toString('utf8') !== secret || Buffer.byteLength(secret, 'utf8') > 16 * 1024 * 1024) {
        throw problem(400, 'invalid_credential_request');
      }
      requestedKinds.push(kind);
    }
    if (requestedKinds.length === 0) throw problem(400, 'invalid_credential_request');
  } else {
    const kinds = body.kinds;
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((kind) => typeof kind !== 'string' || !allowedKinds.includes(kind)) ||
      new Set(kinds).size !== kinds.length || kinds.some((kind, index) => kind !== [...kinds].sort()[index])) {
      throw problem(400, 'invalid_credential_request');
    }
    requestedKinds.push(...kinds as string[]);
  }
  const generations = body.expectedGenerations;
  if (!generations || typeof generations !== 'object' || Array.isArray(generations)) throw problem(400, 'invalid_credential_request');
  const generationMap = generations as Record<string, unknown>;
  if (Object.keys(generationMap).length !== requestedKinds.length || requestedKinds.some((kind) =>
    !Object.hasOwn(generationMap, kind) || !Number.isSafeInteger(generationMap[kind]) || (generationMap[kind] as number) < 0)) {
    throw problem(400, 'invalid_credential_request');
  }
  return canonicalCredentialBody(body);
}

function credentialServiceFailure(error: unknown): { readonly status: number; readonly code: string } {
  if (error instanceof AuthError) return { status: authStatus(error), code: error.code };
  if (error instanceof KernelError) {
    switch (error.code) {
      case 'unauthenticated': return { status: 401, code: 'unauthenticated' };
      case 'forbidden': return { status: 403, code: 'forbidden' };
      case 'invalid_id': case 'invalid_input': case 'invalid_json': case 'size_limit': return { status: 400, code: 'invalid_credential_request' };
      case 'stale_epoch': case 'stale_account': case 'idempotency_conflict': return { status: 409, code: 'credential_conflict' };
      default: return { status: 503, code: 'service_unavailable' };
    }
  }
  if (error instanceof VaultError) {
    if (error.code.startsWith('invalid_')) return { status: 400, code: 'invalid_credential_request' };
    if (['stale_generation', 'stale_account_generation', 'generation_overflow'].includes(error.code)) {
      return { status: 409, code: 'credential_conflict' };
    }
    return { status: 503, code: 'service_unavailable' };
  }
  if (error instanceof Error) {
    if (error.message === 'This credential command id is already bound to different content or workspace state.') {
      return { status: 409, code: 'credential_conflict' };
    }
    if (error.message === 'This credential command requires inspection and cannot be resubmitted.') {
      return { status: 409, code: 'credential_inspection_required' };
    }
  }
  return { status: 503, code: 'service_unavailable' };
}

function authenticatedMutation(request: IncomingMessage, auth: AuthService, canonicalOrigin: URL):
  { readonly sessionToken: string; readonly origin: string; readonly csrf: string } {
  const origin = uniqueHeader(request, 'origin');
  if (origin !== canonicalOrigin.origin) throw problem(403, 'origin_rejected');
  const cookies = readCookies(request);
  if (!cookies.session) throw problem(401, 'unauthenticated');
  const csrf = uniqueHeader(request, 'x-still-csrf');
  if (!csrf || !TOKEN_RE.test(csrf)) throw problem(403, 'csrf_rejected');
  return Object.freeze({ sessionToken: cookies.session, origin, csrf });
}

function assertCredentialMutation(response: ServerResponse, auth: AuthService,
  captured: { readonly sessionToken: string; readonly origin: string; readonly csrf: string }): boolean {
  try { auth.assertMutation(captured.sessionToken, captured.origin, captured.csrf); return true; }
  catch (error) {
    const mapped = credentialServiceFailure(error);
    sendError(response, mapped.status, mapped.code);
    return false;
  }
}

function credentialCommandId(request: IncomingMessage): string {
  const commandId = uniqueHeader(request, 'x-still-command');
  if (!commandId || !COMMAND_ID_RE.test(commandId)) throw problem(400, 'invalid_credential_command_id');
  return commandId;
}

function sendCredentialMetadata(response: ServerResponse, metadata: SafeCredentialMetadataSnapshot): void {
  sendJson(response, 200, metadata);
}

function staticMime(pathname: string): string {
  return MIME_TYPES[extname(pathname).toLowerCase()] ?? 'application/octet-stream';
}

function isHashedAsset(pathname: string): boolean { return HASHED_BASENAME_RE.test(pathname.slice(pathname.lastIndexOf('/') + 1)); }

function allowedExpoAsset(pathname: string): boolean {
  return /^\/_expo\/static\/js\/web\/[A-Za-z0-9._/-]+\.m?js$/i.test(pathname) &&
    !pathname.split('/').slice(1).some((segment) => !segment || segment === '.' || segment === '..') && isHashedAsset(pathname);
}

function allowedFont(pathname: string): boolean {
  return /^\/assets\/[A-Za-z0-9._@/-]+\.(?:woff2?|ttf|otf)$/i.test(pathname) &&
    !pathname.split('/').slice(1).some((segment) => !segment || segment === '.' || segment === '..') && isHashedAsset(pathname);
}

function allowedPwaRegistration(pathname: string): boolean {
  return /^\/pwa-register-[a-f\d]{16,}\.js$/i.test(pathname);
}

function collectStaticPaths(root: string): { readonly paths: Set<string>; readonly index: Buffer } {
  const indexPath = join(root, 'index.html');
  const index = readSafeFile(root, indexPath);
  if (index.length > 2 * 1024 * 1024) throw new TypeError('static_index_too_large');
  const html = index.toString('utf8');
  const paths = new Set<string>(['/', ...FIXED_PUBLIC_PATHS.keys()]);
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)];
  for (const ref of refs) {
    const value = ref[1];
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|data:|#)/i.test(value)) throw new TypeError('static_external_reference');
    const parsed = new URL(value, 'https://still.invalid/');
    if (parsed.origin !== 'https://still.invalid' || parsed.search || parsed.hash) throw new TypeError('static_reference_invalid');
    const pathname = decodeURIComponent(parsed.pathname);
    if (FIXED_PUBLIC_PATHS.has(pathname)) continue;
    if ((allowedExpoAsset(pathname) || allowedFont(pathname) || allowedPwaRegistration(pathname)) && !PROTECTED_PATH_RE.test(pathname)) { paths.add(pathname); continue; }
    throw new TypeError('static_reference_not_allowlisted');
  }
  const expoDirectory = join(root, '_expo', 'static', 'js', 'web');
  for (const path of walkAllowlisted(expoDirectory, root, allowedExpoAsset)) paths.add(path);
  const assetsDirectory = join(root, 'assets');
  for (const path of walkAllowlisted(assetsDirectory, root, allowedFont)) paths.add(path);
  for (const pathname of paths) {
    if (PROTECTED_PATH_RE.test(pathname)) throw new TypeError('static_protected_path');
    if (pathname === '/') continue;
    const file = pathname === '/index.html' ? indexPath : join(root, ...pathname.slice(1).split('/'));
    readSafeFile(root, file);
  }
  if (!html.includes('/manifest.webmanifest')) throw new TypeError('static_pwa_files_missing');
  return { paths, index };
}

function walkAllowlisted(directory: string, root: string, accepts: (pathname: string) => boolean): string[] {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  const found: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...walkAllowlisted(fullPath, root, accepts));
    else if (entry.isFile()) {
      const pathname = `/${relative(root, fullPath).split(sep).join('/')}`;
      if (accepts(pathname) && !PROTECTED_PATH_RE.test(pathname)) found.push(pathname);
    }
  }
  return found;
}

function readSafeFile(root: string, filePath: string): Buffer {
  const absolute = resolve(filePath);
  if (!inside(root, absolute)) throw new TypeError('static_path_escape');
  const rel = relative(root, absolute);
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new TypeError('static_symlink');
  }
  const info = lstatSync(absolute);
  if (!info.isFile()) throw new TypeError('static_not_file');
  const resolved = realpathSync(absolute);
  if (resolved !== absolute) throw new TypeError('static_realpath_mismatch');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(absolute, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== info.size || (opened.ino && info.ino && opened.ino !== info.ino)) throw new TypeError('static_file_changed');
    if (opened.size > 32 * 1024 * 1024) throw new TypeError('static_file_too_large');
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function cssOrHtmlCache(pathname: string, hasQuery = false): string {
  return pathname === '/' && hasQuery ? 'no-store' :
    pathname === '/' || pathname === '/sw.js' || pathname === '/manifest.webmanifest' ? 'no-cache' :
    isHashedAsset(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

function safeStaticResponse(request: IncomingMessage, response: ServerResponse, root: string, paths: Set<string>, index: Buffer,
  pathname: string, hasQuery: boolean): void {
  let servedPath = pathname;
  let bytes: Buffer | undefined;
  if (pathname === '/') bytes = index;
  else if (paths.has(pathname)) {
    const diskPath = join(root, ...pathname.slice(1).split('/'));
    bytes = readSafeFile(root, diskPath);
  } else if (!PROTECTED_PATH_RE.test(pathname) && extname(pathname) === '') {
    servedPath = '/'; bytes = index;
  }
  if (!bytes) { sendError(response, 404, 'not_found'); return; }
  response.writeHead(200, { 'Content-Type': servedPath === '/' ? 'text/html; charset=utf-8' : staticMime(servedPath),
    'Content-Length': String(bytes.length), 'Cache-Control': cssOrHtmlCache(servedPath, hasQuery) });
  response.end(request.method === 'HEAD' ? undefined : bytes);
}

export function createStillHttpServer(options: StillHttpOptions): Server {
  if (!options || typeof options !== 'object' || !options.auth) throw new TypeError('http_dependencies_invalid');
  const origin = assertCanonicalOrigin(options.canonicalOrigin, options.allowLocalHttp === true);
  if (typeof options.staticRoot !== 'string' || !isAbsolute(options.staticRoot)) throw new TypeError('static_root_invalid');
  const staticRoot = resolve(options.staticRoot);
  const rootInfo = lstatSync(staticRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new TypeError('static_root_invalid');
  const realRoot = realpathSync(staticRoot);
  if (realRoot !== staticRoot) throw new TypeError('static_root_invalid');
  const { paths, index } = collectStaticPaths(realRoot);
  let server: Server;
  server = createServer((request, response) => {
    securityHeaders(response);
    const handled = Promise.resolve().then(() => handleRequest(request, response, options.auth, origin, realRoot, paths, index, options.credentialCommands,
      options.workspaceApi, options.audioApi, options.oauthApi, options.admissionOpen)).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (isHttpProblem(error)) { sendError(response, error.status, error.code); return; }
      if (error instanceof AuthError) { sendError(response, authStatus(error), error.code); return; }
      sendError(response, 503, 'service_unavailable');
    });
    trackAcceptedHttpRequest(server, handled);
  });
  registerAcceptedHttpServer(server);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, auth: AuthService, canonicalOrigin: URL,
  staticRoot: string, staticPaths: Set<string>, index: Buffer, credentialCommands?: ServerCredentialCommandService,
  workspaceApi?: WorkspaceHttpApi, audioApi?: AudioHttpApi, oauthApi?: OAuthHttpApi, admissionOpen?: () => boolean): Promise<void> {
  if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
  const host = uniqueHeader(request, 'host', true);
  if (!host || host.toLowerCase() !== canonicalOrigin.host.toLowerCase()) throw problem(403, 'host_rejected');
  const { pathname, hasQuery, rawQuery } = safePath(request.url);
  if (pathname.startsWith('/auth/') || pathname.startsWith('/api/') || pathname === '/healthz') {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
  }
  const originHeader = uniqueHeader(request, 'origin');
  if (originHeader !== undefined && originHeader !== canonicalOrigin.origin) throw problem(403, 'origin_rejected');
  if (pathname === '/healthz') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    sendJson(response, 200, { status: 'ok' }); return;
  }
  if (pathname === '/auth/session') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    const cookies = readCookies(request);
    if (cookies.session) {
      const session = auth.getSession(cookies.session);
      if (session.authenticated) { sendJson(response, 200, session); return; }
    }
    let challenge;
    if (cookies.preauth) {
      try { challenge = auth.resumeLoginChallenge(cookies.preauth); }
      catch (error) {
        if (!(error instanceof AuthError) || error.code !== 'challenge_invalid') throw error;
      }
    }
    if (!challenge) {
      try { challenge = auth.createLoginChallenge(canonicalOrigin.origin); }
      catch (error) {
        if (error instanceof AuthError && error.code === 'not_enrolled') {
          sendJson(response, 200, { authenticated: false, setupRequired: true, csrfToken: null }, false,
            cookies.session ? { 'Set-Cookie': jsonCookies(undefined, undefined) } : {});
          return;
        }
        throw error;
      }
    }
    const replacementCookies = jsonCookies(undefined, challenge.preAuthToken);
    sendJson(response, 200, { authenticated: false, setupRequired: false, csrfToken: challenge.csrfToken }, false,
      { 'Set-Cookie': cookies.session || !cookies.preauth || challenge.preAuthToken !== cookies.preauth ? replacementCookies : [replacementCookies[1]!] });
    return;
  }
  if (pathname === '/auth/login') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw problem(405, 'method_not_allowed'); }
    if (originHeader !== canonicalOrigin.origin) throw problem(403, 'origin_rejected');
    if (hasQuery) throw problem(400, 'bad_request');
    const cookies = readCookies(request);
    if (!cookies.preauth) throw problem(401, 'challenge_required');
    const csrf = uniqueHeader(request, 'x-still-csrf', true);
    if (!csrf || !TOKEN_RE.test(csrf)) throw problem(403, 'csrf_rejected');
    const input = exactObject(await readJsonBody(request, response), ['password']);
    if (typeof input.password !== 'string') throw problem(400, 'bad_request');
    if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
    const login = await auth.login({ password: input.password, origin: originHeader, preAuthToken: cookies.preauth, csrfToken: csrf,
      ...(cookies.session === undefined ? {} : { previousSessionToken: cookies.session }) });
    sendJson(response, 200, login.session, false, { 'Set-Cookie': jsonCookies(login.sessionToken, undefined) });
    return;
  }
  if (pathname === '/auth/logout') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw problem(405, 'method_not_allowed'); }
    if (originHeader !== canonicalOrigin.origin) throw problem(403, 'origin_rejected');
    if (hasQuery) throw problem(400, 'bad_request');
    const cookies = readCookies(request);
    if (!cookies.session) throw problem(401, 'unauthenticated');
    const csrf = uniqueHeader(request, 'x-still-csrf', true);
    if (!csrf || !TOKEN_RE.test(csrf)) throw problem(403, 'csrf_rejected');
    exactObject(await readJsonBody(request, response), []);
    if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
    auth.logout(cookies.session, originHeader, csrf);
    const challenge = auth.createLoginChallenge(canonicalOrigin.origin);
    sendJson(response, 200, { authenticated: false, setupRequired: false, csrfToken: challenge.csrfToken }, false,
      { 'Set-Cookie': jsonCookies(undefined, challenge.preAuthToken) });
    return;
  }
  const oauthCallbackMatch = /^\/api\/oauth\/(google|microsoft)\/callback$/.exec(pathname);
  if (oauthCallbackMatch) {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (!oauthApi) throw problem(503, 'service_unavailable');
    const provider = oauthCallbackMatch[1] as 'google' | 'microsoft';
    const query = callbackQuery(rawQuery, provider);
    const cookies = readCookies(request);
    const expectedCookie = oauthApi.callbackCookieName(provider, query.state);
    const cookieBinding = expectedCookie ? cookies.values.get(expectedCookie) : undefined;
    if (!cookieBinding || !TOKEN_RE.test(cookieBinding)) throw problem(400, 'invalid_oauth_callback');
    try {
      const result = await oauthApi.callback(provider, { state: query.state, cookieBinding,
        ...(query.code === undefined ? {} : { code: query.code }), ...(query.error === undefined ? {} : { error: query.error }) });
      if (!result.attemptId || !COMMAND_ID_RE.test(result.attemptId)) throw problem(400, 'invalid_oauth_callback');
      response.statusCode = 303;
      response.setHeader('Location', `/?oauth_stage=${encodeURIComponent(result.attemptId)}`);
      if (result.clearCookieName && expectedCookie === result.clearCookieName) {
        response.setHeader('Set-Cookie', `${result.clearCookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
      }
      response.end();
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  const oauthStartMatch = /^\/api\/oauth\/(google|microsoft)\/start$/.exec(pathname);
  if (pathname === '/api/oauth/availability') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!oauthApi) throw problem(503, 'service_unavailable');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const result = oauthApi.availability(admission);
      admission.assertCurrent();
      sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (oauthStartMatch) {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!oauthApi) throw problem(503, 'service_unavailable');
    const admission = workspaceMutationAdmission(request, auth, canonicalOrigin);
    try {
      const input = await readJsonBody(request, response);
      admission.assertCurrent();
      if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
      const result = await oauthApi.start(admission, oauthStartMatch[1] as 'google' | 'microsoft', input);
      admission.assertCurrent();
      const publicResult = Object.freeze({ kind: result.kind, status: result.status,
        ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}) });
      const cookies: string[] = [];
      for (const name of result.clearCookieNames ?? []) {
        if (/^__Host-still_oauth_(?:google|microsoft)_[0-9a-f-]{36}$/i.test(name)) {
          cookies.push(`${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
        }
      }
      if (result.cookie) {
        if (!/^__Host-still_oauth_(?:google|microsoft)_[0-9a-f-]{36}$/i.test(result.cookie.name) || !TOKEN_RE.test(result.cookie.value)) {
          throw problem(503, 'service_unavailable');
        }
        cookies.push(`${result.cookie.name}=${result.cookie.value}; Path=/; Max-Age=${result.cookie.maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`);
      }
      sendJson(response, result.kind === 'started' ? 201 : 200, publicResult, false, cookies.length ? { 'Set-Cookie': cookies } : {});
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (pathname === '/api/oauth/starts') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (!oauthApi) throw problem(503, 'service_unavailable');
    const values = hasQuery ? strictQuery(rawQuery, ['provider']) : new Map<string, string>();
    const provider = values.get('provider');
    if (provider !== undefined && provider !== 'google' && provider !== 'microsoft') throw problem(400, 'bad_request');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const result = oauthApi.listStarts(admission, provider as 'google' | 'microsoft' | undefined);
      admission.assertCurrent();
      sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  const oauthStageMatch = /^\/api\/oauth\/stages\/([0-9a-f-]{36})$/i.exec(pathname);
  if (oauthStageMatch) {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!oauthApi) throw problem(503, 'service_unavailable');
    if (!COMMAND_ID_RE.test(oauthStageMatch[1]!)) throw problem(400, 'bad_request');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const result = oauthApi.inspectStage(admission, oauthStageMatch[1]!);
      admission.assertCurrent();
      sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  const oauthStartInspectMatch = /^\/api\/oauth\/(google|microsoft)\/starts\/([0-9a-f-]{36})$/i.exec(pathname);
  if (oauthStartInspectMatch) {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!oauthApi) throw problem(503, 'service_unavailable');
    if (!COMMAND_ID_RE.test(oauthStartInspectMatch[2]!)) throw problem(400, 'bad_request');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const result = oauthApi.inspectStart(admission, oauthStartInspectMatch[1] as 'google' | 'microsoft', oauthStartInspectMatch[2]!);
      admission.assertCurrent();
      sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (pathname === '/api/workspace/snapshot') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!workspaceApi) throw problem(503, 'service_unavailable');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const snapshot = await workspaceApi.getSnapshot(admission);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, snapshot);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (pathname === '/api/workspace/command-history') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    let cursor: string | undefined;
    if (hasQuery) {
      const match = /^cursor=([A-Za-z0-9_-]{1,2048})$/.exec(rawQuery ?? '');
      if (!match) throw problem(400, 'bad_request');
      cursor = match[1];
    }
    if (!workspaceApi) throw problem(503, 'service_unavailable');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const result = workspaceApi.listCommandHistory(admission, cursor);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (pathname === KNOWLEDGE_SOURCE_CHOICES_PATH || pathname === KNOWLEDGE_SUGGESTION_REVIEW_PATH) {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    let read;
    try { read = parseKnowledgeHttpRead(pathname, rawQuery ?? ''); }
    catch { throw problem(400, 'bad_request'); }
    if (!workspaceApi) throw problem(503, 'service_unavailable');
    if (read.kind === 'source_choices' && typeof workspaceApi.readKnowledgeSourceChoices !== 'function' ||
        read.kind === 'suggestion_review' && typeof workspaceApi.readKnowledgeSuggestionReview !== 'function') {
      throw problem(503, 'service_unavailable');
    }
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const result = read.kind === 'source_choices'
        ? await workspaceApi.readKnowledgeSourceChoices!(admission, read)
        : await workspaceApi.readKnowledgeSuggestionReview!(admission, read);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (pathname === '/api/workspace/refresh') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!workspaceApi) throw problem(503, 'service_unavailable');
    const admission = workspaceMutationAdmission(request, auth, canonicalOrigin);
    try {
      exactObject(await readJsonBody(request, response), []);
      admission.assertCurrent();
      if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
      const snapshot = await workspaceApi.refreshSnapshot(admission);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, snapshot);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (pathname === '/api/workspace/commands') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!workspaceApi) throw problem(503, 'service_unavailable');
    const admission = workspaceMutationAdmission(request, auth, canonicalOrigin);
    try {
      const envelope = await readJsonBody(request, response, WORKSPACE_COMMAND_TEXT_BODY_LIMIT, (value) => {
        const command = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).command : undefined;
        const kind = command && typeof command === 'object' && !Array.isArray(command) ? (command as Record<string, unknown>).kind : undefined;
        return typeof kind === 'string' && ['notes.save', 'notes.updateTranscript', 'assistant.batch.submitNote', 'chat.submit',
          'documents.save', 'knowledge.person.save', 'knowledge.project.save'].includes(kind)
          ? WORKSPACE_COMMAND_TEXT_BODY_LIMIT : BODY_LIMIT;
      });
      admission.assertCurrent();
      if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
      const result = await workspaceApi.dispatchCommand(admission, envelope);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  const workspaceCancelMatch = /^\/api\/workspace\/commands\/([^/]+)\/cancel-transcription$/.exec(pathname);
  if (workspaceCancelMatch) {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!workspaceApi) throw problem(503, 'service_unavailable');
    const commandId = workspaceCancelMatch[1]!;
    if (!COMMAND_ID_RE.test(commandId)) throw problem(400, 'bad_request');
    const admission = workspaceMutationAdmission(request, auth, canonicalOrigin);
    try {
      exactObject(await readJsonBody(request, response), []);
      admission.assertCurrent();
      if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
      const result = workspaceApi.cancelTranscription(admission, commandId);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  const workspaceCommandPrefix = '/api/workspace/commands/';
  if (pathname.startsWith(workspaceCommandPrefix)) {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!workspaceApi) throw problem(503, 'service_unavailable');
    const commandId = pathname.slice(workspaceCommandPrefix.length);
    if (!COMMAND_ID_RE.test(commandId)) throw problem(400, 'bad_request');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const result = workspaceApi.inspectCommand(admission, commandId);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (pathname === '/api/audio/upload-history') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    let cursor: string | undefined;
    if (hasQuery) {
      const match = /^cursor=([A-Za-z0-9_-]{1,2048})$/.exec(rawQuery ?? '');
      if (!match) throw problem(400, 'bad_request');
      cursor = match[1];
    }
    if (!audioApi) throw problem(503, 'service_unavailable');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
      const result = await audioApi.listUploads(admission, cursor);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  if (pathname === '/api/audio/uploads') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!audioApi) throw problem(503, 'service_unavailable');
    // Authenticate and verify CSRF before the server reserves metadata or reads file bytes.
    const admission = workspaceMutationAdmission(request, auth, canonicalOrigin);
    const uploadId = uniqueHeader(request, 'x-still-upload-id', true);
    if (!uploadId || !COMMAND_ID_RE.test(uploadId)) throw problem(400, 'bad_request');
    const capture = parseAudioCaptureHeader(uniqueHeader(request, 'x-still-capture', true));
    const mimeType = parseAudioContentType(uniqueHeader(request, 'content-type', true));
    const contentEncoding = uniqueHeader(request, 'content-encoding');
    if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== 'identity') throw problem(415, 'unsupported_media_type');
    const expectedByteLength = audioUploadLength(request);
    try {
      admission.assertCurrent();
      if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
      const receipt = await audioApi.upload(admission, { uploadId, capture, mimeType,
        ...(expectedByteLength === undefined ? {} : { expectedByteLength }), source: request });
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, receipt.status === 'ready' ? 201 : 202, receipt);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  const uploadInspectMatch = /^\/api\/audio\/uploads\/([0-9a-f-]{36})$/i.exec(pathname);
  if (uploadInspectMatch) {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!audioApi) throw problem(503, 'service_unavailable');
    if (!COMMAND_ID_RE.test(uploadInspectMatch[1]!)) throw problem(400, 'bad_request');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    try {
      admission.assertCurrent();
      const receipt = await audioApi.inspectUpload(admission, uploadInspectMatch[1]!);
      admission.assertCurrent();
      if (!response.destroyed) sendJson(response, 200, receipt);
    } catch (error) { if (!response.destroyed) sendWorkspaceFailure(response, error); }
    return;
  }
  const mediaMatch = /^\/api\/audio\/([0-9a-f-]{36})$/i.exec(pathname);
  if (mediaMatch) {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    if (!audioApi) throw problem(503, 'service_unavailable');
    if (!COMMAND_ID_RE.test(mediaMatch[1]!)) throw problem(400, 'bad_request');
    const admission = workspaceReadAdmission(request, auth, canonicalOrigin);
    const abort = new AbortController();
    const onClientClose = () => { if (!response.writableEnded) abort.abort(); };
    request.once('aborted', onClientClose);
    response.once('close', onClientClose);
    let openedMedia: Awaited<ReturnType<AudioHttpApi['openMedia']>> | undefined;
    try {
      admission.assertCurrent();
      const range = uniqueHeader(request, 'range');
      const media = openedMedia = await audioApi.openMedia(admission, mediaMatch[1]!, { method: request.method,
        ...(range === undefined ? {} : { range }), signal: abort.signal });
      admission.assertCurrent();
      assertSafeAudioHeaders(media.headers);
      response.writeHead(media.status, media.headers);
      if (request.method === 'HEAD' || media.status === 416 || !media.body) { response.end(); return; }
      await pipeline(media.body, response);
    } catch (error) {
      openedMedia?.body?.destroy();
      if (!response.destroyed && !response.headersSent) sendWorkspaceFailure(response, error);
      else if (!response.destroyed) response.destroy();
    }
    finally { request.off('aborted', onClientClose); response.off('close', onClientClose); }
    return;
  }
  if (pathname === '/api/credentials') {
    if (!credentialCommands) throw problem(503, 'service_unavailable');
    if (hasQuery) throw problem(400, 'bad_request');
    if (request.method === 'GET') {
      const cookies = readCookies(request);
      if (!cookies.session || !auth.getSession(cookies.session).authenticated) throw problem(401, 'unauthenticated');
      sendCredentialMetadata(response, credentialCommands.getMetadata(cookies.session));
      return;
    }
    if (request.method !== 'PUT' && request.method !== 'DELETE') {
      response.setHeader('Allow', 'GET, PUT, DELETE'); throw problem(405, 'method_not_allowed');
    }
    const captured = authenticatedMutation(request, auth, canonicalOrigin);
    if (!assertCredentialMutation(response, auth, captured)) return;
    const commandId = credentialCommandId(request);
    const bodyValue = await readJsonBody(request, response, CREDENTIAL_BODY_LIMIT);
    const canonicalBody = validateCredentialRequest(bodyValue, request.method === 'PUT' ? 'put' : 'delete');
    // The request body can take seconds to arrive. Recheck the session/CSRF fence
    // after that await, immediately before the synchronous atomic command.
    if (!assertCredentialMutation(response, auth, captured)) return;
    if (admissionOpen && !admissionOpen()) throw problem(503, 'service_unavailable');
    try {
      const metadata = request.method === 'PUT'
        ? credentialCommands.put(captured.sessionToken, commandId, canonicalBody)
        : credentialCommands.delete(captured.sessionToken, commandId, canonicalBody);
      sendCredentialMetadata(response, metadata);
    } catch (error) {
      const mapped = credentialServiceFailure(error);
      sendError(response, mapped.status, mapped.code);
    }
    return;
  }
  const commandMatch = /^\/api\/credential-commands\/([0-9a-f-]{36})$/i.exec(pathname);
  if (commandMatch) {
    if (!credentialCommands) throw problem(503, 'service_unavailable');
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw problem(405, 'method_not_allowed'); }
    if (hasQuery) throw problem(400, 'bad_request');
    const cookies = readCookies(request);
    if (!cookies.session || !auth.getSession(cookies.session).authenticated) throw problem(401, 'unauthenticated');
    if (!COMMAND_ID_RE.test(commandMatch[1]!)) throw problem(400, 'invalid_credential_command_id');
    try { sendJson(response, 200, credentialCommands.inspect(cookies.session, commandMatch[1]!)); }
    catch (error) {
      const mapped = credentialServiceFailure(error);
      sendError(response, mapped.status, mapped.code);
    }
    return;
  }
  if (pathname === '/auth' || pathname.startsWith('/auth/')) {
    response.setHeader('Allow', 'GET, POST'); throw problem(404, 'not_found');
  }
  if (pathname.startsWith('/api/') || PROTECTED_PATH_RE.test(pathname)) { sendError(response, 404, 'not_found'); return; }
  if (hasQuery && pathname !== '/') { sendError(response, 404, 'not_found'); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); throw problem(405, 'method_not_allowed'); }
  safeStaticResponse(request, response, staticRoot, staticPaths, index, pathname, hasQuery);
}
