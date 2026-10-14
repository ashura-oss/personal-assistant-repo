import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AuthError, type AuthService } from './auth.js';

const BODY_LIMIT = 16 * 1024;
const COOKIE_LIMIT = 4096;
const BODY_TIMEOUT_MS = 10_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
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
}

interface CookieValues { readonly session?: string; readonly preauth?: string }
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

function safePath(rawUrl: string | undefined): { readonly pathname: string; readonly hasQuery: boolean } {
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
  return { pathname, hasQuery: q >= 0 };
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
  if (cookieHeader === undefined) return {};
  if (cookieHeader.length > COOKIE_LIMIT) throw problem(400, 'bad_request');
  const values = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
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
  return { ...(session === undefined ? {} : { session }), ...(preauth === undefined ? {} : { preauth }) };
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

async function readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  const contentType = uniqueHeader(request, 'content-type', true) ?? '';
  const contentEncoding = uniqueHeader(request, 'content-encoding');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
    (contentEncoding !== undefined && contentEncoding.toLowerCase() !== 'identity')) throw problem(415, 'unsupported_media_type');
  const lengthHeader = uniqueHeader(request, 'content-length');
  if (lengthHeader !== undefined && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > BODY_LIMIT)) {
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
      if (size > BODY_LIMIT) { failRequest(problem(413, 'request_too_large')); request.resume(); return; }
      chunks.push(bytes);
    };
    const onEnd = () => { cleanup(); resolvePromise(); };
    const onError = () => failRequest(problem(400, 'bad_request'));
    const onAborted = () => failRequest(problem(400, 'bad_request'));
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
  });
  const text = Buffer.concat(chunks, size).toString('utf8');
  if (Buffer.from(text, 'utf8').length !== size) throw problem(400, 'bad_request');
  try { return JSON.parse(text) as unknown; } catch { throw problem(400, 'bad_request'); }
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, 'bad_request');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(object, key))) {
    throw problem(400, 'bad_request');
  }
  return object;
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
  return /^\/assets\/[A-Za-z0-9._/-]+\.(?:woff2?|ttf|otf)$/i.test(pathname) &&
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

function cssOrHtmlCache(pathname: string): string {
  return pathname === '/' || pathname === '/sw.js' || pathname === '/manifest.webmanifest' ? 'no-cache' :
    isHashedAsset(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

function safeStaticResponse(request: IncomingMessage, response: ServerResponse, root: string, paths: Set<string>, index: Buffer,
  pathname: string): void {
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
    'Content-Length': String(bytes.length), 'Cache-Control': cssOrHtmlCache(servedPath) });
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
  const server = createServer((request, response) => {
    securityHeaders(response);
    void handleRequest(request, response, options.auth, origin, realRoot, paths, index).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (isHttpProblem(error)) { sendError(response, error.status, error.code); return; }
      if (error instanceof AuthError) { sendError(response, authStatus(error), error.code); return; }
      sendError(response, 503, 'service_unavailable');
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, auth: AuthService, canonicalOrigin: URL,
  staticRoot: string, staticPaths: Set<string>, index: Buffer): Promise<void> {
  const host = uniqueHeader(request, 'host', true);
  if (!host || host.toLowerCase() !== canonicalOrigin.host.toLowerCase()) throw problem(403, 'host_rejected');
  const { pathname, hasQuery } = safePath(request.url);
  if (pathname.startsWith('/auth/') || pathname === '/healthz') {
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
    auth.logout(cookies.session, originHeader, csrf);
    const challenge = auth.createLoginChallenge(canonicalOrigin.origin);
    sendJson(response, 200, { authenticated: false, setupRequired: false, csrfToken: challenge.csrfToken }, false,
      { 'Set-Cookie': jsonCookies(undefined, challenge.preAuthToken) });
    return;
  }
  if (pathname === '/auth' || pathname.startsWith('/auth/')) {
    response.setHeader('Allow', 'GET, POST'); throw problem(404, 'not_found');
  }
  if (pathname.startsWith('/api/') || PROTECTED_PATH_RE.test(pathname)) { sendError(response, 404, 'not_found'); return; }
  if (hasQuery && pathname !== '/') { sendError(response, 404, 'not_found'); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); throw problem(405, 'method_not_allowed'); }
  safeStaticResponse(request, response, staticRoot, staticPaths, index, pathname);
}
