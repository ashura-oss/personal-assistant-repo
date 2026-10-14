import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { request as rawHttpRequest } from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import { AuthService } from '../dist/auth.js';
import { createStillHttpServer } from '../dist/http.js';
import { createDurableKernel } from '../dist/kernel.js';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 31));

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-http-'));
  const staticRoot = join(directory, 'public');
  const dataDirectory = join(directory, 'private');
  mkdirSync(join(staticRoot, '_expo', 'static', 'js', 'web'), { recursive: true });
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  mkdirSync(dataDirectory);
  const bundle = '/_expo/static/js/web/index-abcdef0123456789.js';
  const registration = '/pwa-register-0123456789abcdef.js';
  const index = `<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/assets/still-icon.png"><style>body{margin:0}</style><script src="${registration}" defer></script></head><body><div id="root"></div><script src="${bundle}" defer></script></body></html>`;
  writeFileSync(join(staticRoot, 'index.html'), index);
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(staticRoot, registration.slice(1)), '/* registration */');
  writeFileSync(join(staticRoot, bundle.slice(1)), '/* public app bundle */');
  writeFileSync(join(staticRoot, 'metadata.json'), '{"private":"must not serve"}');
  const port = await freePort();
  const canonicalOrigin = `http://127.0.0.1:${port}`;
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(dataDirectory, 'still.sqlite'), validateSnapshot: (value) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  }, now: () => now });
  const auth = new AuthService(kernel, { canonicalOrigin, allowLocalHttp: true, authSecret, now: () => now });
  const server = createStillHttpServer({ auth, canonicalOrigin, allowLocalHttp: true, staticRoot });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const base = canonicalOrigin;
  return {
    directory, staticRoot, kernel, auth, server, base, canonicalOrigin,
    request: (path, init = {}) => fetch(`${base}${path}`, init),
    rawRequest: (path, headers = {}) => new Promise((resolve, reject) => {
      const request = rawHttpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject); request.end();
    }),
    setTime: (value) => { now = value; },
    close: async () => {
      auth.close(); kernel.close();
      await new Promise((resolve) => server.close(() => resolve()));
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    },
  };
}

function cookies(response) { return response.headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []); }
function cookieValue(response, name) {
  const line = cookies(response).find((value) => value.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(';', 1)[0] ?? '';
}
function cookieHeader(name, value) { return `${name}=${value}`; }

async function guest(f) {
  const response = await f.request('/auth/session');
  return { response, body: await response.json(), preauth: cookieValue(response, '__Host-still_preauth') };
}

async function enroll(f) {
  await f.auth.enrollOwner('correct horse battery staple', { note: 'private' });
}

test('health is fixed and static hosting serves only the generated public shell assets', async () => {
  const f = await fixture();
  try {
    const health = await f.request('/healthz');
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.deepEqual(healthBody, { status: 'ok' });
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.match(health.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(health.headers.get('content-security-policy'), /media-src 'self' blob:/);
    assert.match(health.headers.get('permissions-policy'), /microphone=\(self\)/);
    assert.doesNotMatch(JSON.stringify(healthBody), /owner|account|workspace/i);

    const shell = await f.request('/');
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-type'), /^text\/html/);
    assert.match(await shell.text(), /<div id="root"><\/div>/);
    assert.equal((await f.request('/manifest.webmanifest')).status, 200);
    assert.equal((await f.request('/sw.js')).status, 200);
    assert.equal((await f.request('/assets/still-icon.png')).status, 200);
    assert.equal((await f.request('/pwa-register-0123456789abcdef.js')).status, 200);
    assert.equal((await f.request('/_expo/static/js/web/index-abcdef0123456789.js')).status, 200);
    assert.equal((await f.request('/metadata.json')).status, 404);
    assert.equal((await f.request('/private')).status, 404);
    assert.equal((await f.request('/auth/unknown')).status, 404);
    assert.equal((await f.request('/api/private')).status, 404);
    assert.equal((await f.rawRequest('/%2e%2e/private/still.sqlite')).status, 400);
    assert.equal((await f.rawRequest('/_expo%2fstatic/private.js')).status, 400);
  } finally { await f.close(); }
});

test('guest session GET reuses its one-use preauth cookie and emits no-store CSRF state', async () => {
  const f = await fixture();
  try {
    await enroll(f);
    const first = await guest(f);
    assert.equal(first.response.status, 200);
    assert.equal(first.body.authenticated, false);
    assert.equal(first.body.setupRequired, false);
    assert.match(first.body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(first.response.headers.get('cache-control'), /no-store/);
    const preauthCookie = cookies(first.response).find((value) => value.startsWith('__Host-still_preauth='));
    assert.match(preauthCookie, /HttpOnly/);
    assert.match(preauthCookie, /Secure/);
    assert.match(preauthCookie, /SameSite=Strict/);
    assert.match(preauthCookie, /Path=\//);
    const db = new Database(join(f.directory, 'private', 'still.sqlite'));
    const rowsBefore = db.prepare('SELECT count(*) AS count FROM auth_challenges WHERE consumed_at IS NULL').get().count;
    for (let i = 0; i < 6; i += 1) {
      const resumed = await f.request('/auth/session', { headers: { Cookie: cookieHeader('__Host-still_preauth', first.preauth) } });
      const result = await resumed.json();
      assert.equal(result.csrfToken, first.body.csrfToken);
      assert.equal(cookieValue(resumed, '__Host-still_preauth'), first.preauth);
    }
    assert.equal(db.prepare('SELECT count(*) AS count FROM auth_challenges WHERE consumed_at IS NULL').get().count, rowsBefore);
    db.close();
  } finally { await f.close(); }
});

test('login rejects missing origin, invalid CSRF and extra JSON keys; session token exists only in HttpOnly cookie', async () => {
  const f = await fixture();
  try {
    await enroll(f);
    const initial = await guest(f);
    const preauth = cookieHeader('__Host-still_preauth', initial.preauth);
    const body = JSON.stringify({ password: 'correct horse battery staple' });
    const missingOrigin = await f.request('/auth/login', { method: 'POST', headers: { Cookie: preauth, 'X-Still-CSRF': initial.body.csrfToken,
      'Content-Type': 'application/json' }, body });
    assert.equal(missingOrigin.status, 403);
    const wrongOrigin = await f.request('/auth/login', { method: 'POST', headers: { Cookie: preauth, Origin: 'https://attacker.example',
      'X-Still-CSRF': initial.body.csrfToken, 'Content-Type': 'application/json' }, body });
    assert.equal(wrongOrigin.status, 403);
    const wrongCsrf = await f.request('/auth/login', { method: 'POST', headers: { Cookie: preauth, Origin: f.canonicalOrigin,
      'X-Still-CSRF': 'A'.repeat(43), 'Content-Type': 'application/json' }, body });
    assert.equal(wrongCsrf.status, 403);
    const extraKey = await f.request('/auth/login', { method: 'POST', headers: { Cookie: preauth, Origin: f.canonicalOrigin,
      'X-Still-CSRF': initial.body.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple', workspaceId: randomUUID() }) });
    assert.equal(extraKey.status, 400);
    const login = await f.request('/auth/login', { method: 'POST', headers: { Cookie: preauth, Origin: f.canonicalOrigin,
      'X-Still-CSRF': initial.body.csrfToken, 'Content-Type': 'application/json' }, body });
    assert.equal(login.status, 200);
    const responseBody = await login.json();
    assert.equal(responseBody.authenticated, true);
    assert.equal(Object.hasOwn(responseBody, 'sessionToken'), false);
    const sessionCookie = cookies(login).find((value) => value.startsWith('__Host-still_session='));
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /Secure/);
    assert.match(sessionCookie, /SameSite=Strict/);
    assert.match(sessionCookie, /Max-Age=2592000/);
    assert.match(sessionCookie, /Path=\//);
    assert.doesNotMatch(sessionCookie, /Domain=/i);
    const sessionToken = cookieValue(login, '__Host-still_session');
    assert.match(sessionToken, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(JSON.stringify(responseBody), new RegExp(sessionToken));
    const state = await f.request('/auth/session', { headers: { Cookie: cookieHeader('__Host-still_session', sessionToken) } });
    assert.deepEqual(await state.json(), responseBody);
  } finally { await f.close(); }
});

test('successful HTTP login revokes the exact presented session and ignores a stale presented token safely', async () => {
  const f = await fixture();
  try {
    await enroll(f);
    const firstGuest = await guest(f);
    const firstLogin = await f.request('/auth/login', { method: 'POST', headers: {
      Cookie: cookieHeader('__Host-still_preauth', firstGuest.preauth), Origin: f.canonicalOrigin,
      'X-Still-CSRF': firstGuest.body.csrfToken, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    const oldToken = cookieValue(firstLogin, '__Host-still_session');
    const nextChallenge = f.auth.createLoginChallenge(f.canonicalOrigin);
    const rotated = await f.request('/auth/login', { method: 'POST', headers: {
      Cookie: `${cookieHeader('__Host-still_session', oldToken)}; ${cookieHeader('__Host-still_preauth', nextChallenge.preAuthToken)}`,
      Origin: f.canonicalOrigin, 'X-Still-CSRF': nextChallenge.csrfToken, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    assert.equal(rotated.status, 200);
    const oldSession = await f.request('/auth/session', { headers: { Cookie: cookieHeader('__Host-still_session', oldToken) } });
    assert.equal((await oldSession.json()).authenticated, false);

    const staleGuest = await guest(f);
    const stale = await f.request('/auth/login', { method: 'POST', headers: {
      Cookie: `${cookieHeader('__Host-still_session', 'A'.repeat(43))}; ${cookieHeader('__Host-still_preauth', staleGuest.preauth)}`,
      Origin: f.canonicalOrigin, 'X-Still-CSRF': staleGuest.body.csrfToken, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    assert.equal(stale.status, 200, 'a well-shaped but stale previous session does not disclose its validity or block login');
  } finally { await f.close(); }
});

test('logout is CSRF protected and a manual session GET resolves an unobserved logout response', async () => {
  const f = await fixture();
  try {
    await enroll(f);
    const initial = await guest(f);
    const login = await f.request('/auth/login', { method: 'POST', headers: { Cookie: cookieHeader('__Host-still_preauth', initial.preauth),
      Origin: f.canonicalOrigin, 'X-Still-CSRF': initial.body.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }) });
    const session = await login.json();
    const token = cookieValue(login, '__Host-still_session');
    const bad = await f.request('/auth/logout', { method: 'POST', headers: { Cookie: cookieHeader('__Host-still_session', token),
      Origin: f.canonicalOrigin, 'X-Still-CSRF': 'A'.repeat(43), 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 403);
    const logout = await f.request('/auth/logout', { method: 'POST', headers: { Cookie: cookieHeader('__Host-still_session', token),
      Origin: f.canonicalOrigin, 'X-Still-CSRF': session.csrfToken, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 200);
    const returnedGuest = await logout.json();
    assert.equal(returnedGuest.authenticated, false);
    assert.match(cookieValue(logout, '__Host-still_preauth'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(cookies(logout).find((value) => value.startsWith('__Host-still_session=')), /Max-Age=0/);

    const manualRefresh = await f.request('/auth/session', { headers: { Cookie: cookieHeader('__Host-still_session', token) } });
    const refreshedGuest = await manualRefresh.json();
    assert.equal(refreshedGuest.authenticated, false);
    assert.equal(refreshedGuest.setupRequired, false);
    assert.match(refreshedGuest.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  } finally { await f.close(); }
});

test('body limits, content type, cookies, host binding and method gates fail closed', async () => {
  const f = await fixture();
  try {
    await enroll(f);
    const guestState = await guest(f);
    const login = await f.request('/auth/login', { method: 'POST', headers: { Cookie: cookieHeader('__Host-still_preauth', guestState.preauth),
      Origin: f.canonicalOrigin, 'X-Still-CSRF': guestState.body.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }) });
    const loggedIn = await login.json();
    const session = cookieHeader('__Host-still_session', cookieValue(login, '__Host-still_session'));
    const request = (headers, body = '{}') => f.request('/auth/logout', { method: 'POST', headers: { Cookie: session,
      Origin: f.canonicalOrigin, 'X-Still-CSRF': loggedIn.csrfToken, ...headers }, body });
    assert.equal((await request({ 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await request({ 'Content-Type': 'application/json' }, JSON.stringify({ ignored: 'x'.repeat(16 * 1024) }))).status, 413);
    assert.equal((await request({ 'Content-Type': 'application/json' }, '{')).status, 400);
    const duplicateCookie = await f.request('/auth/session', { headers: { Cookie: `${session}; ${session}` } });
    assert.equal(duplicateCookie.status, 400);
    const method = await f.request('/healthz', { method: 'POST' });
    assert.equal(method.status, 405);
    const forgedForwardedHost = await f.request('/healthz', { headers: { 'X-Forwarded-Host': 'attacker.example' } });
    assert.equal(forgedForwardedHost.status, 200, 'forwarded host headers do not affect canonical host checks');
    const badHost = await f.rawRequest('/healthz', { Host: 'attacker.example' });
    assert.equal(badHost.status, 403);
  } finally { await f.close(); }
});

test('body timeout closes the connection and returns a fixed error', async () => {
  const f = await fixture();
  try {
    await enroll(f);
    const state = await guest(f);
    const result = await new Promise((resolvePromise, rejectPromise) => {
      const request = rawHttpRequest({ hostname: '127.0.0.1', port: Number(new URL(f.base).port), path: '/auth/login', method: 'POST', headers: {
        Host: new URL(f.base).host, Origin: f.canonicalOrigin, Cookie: cookieHeader('__Host-still_preauth', state.preauth),
        'X-Still-CSRF': state.body.csrfToken, 'Content-Type': 'application/json', 'Content-Length': '2',
      } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolvePromise({ status: response.statusCode, headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', rejectPromise);
      request.flushHeaders();
    });
    assert.equal(result.status, 408);
    assert.equal(result.headers.connection, 'close');
    assert.deepEqual(JSON.parse(result.body), { error: 'request_timeout' });
  } finally { await f.close(); }
});

test('static symlinks and unsafe server paths are not exposed', async (t) => {
  const f = await fixture();
  try {
    const privateFile = join(f.directory, 'private-sentinel.txt');
    writeFileSync(privateFile, 'private sentinel');
    const malicious = join(f.staticRoot, '_expo', 'static', 'js', 'web', 'leak-aaaaaaaaaaaaaaaa.js');
    try { symlinkSync(privateFile, malicious); } catch { t.skip('symlink creation is unavailable in this environment'); return; }
    const response = await f.request('/_expo/static/js/web/leak-aaaaaaaaaaaaaaaa.js');
    assert.equal(response.status, 404);
    assert.doesNotMatch(await (await f.request('/')).text(), /private sentinel/);
  } finally { await f.close(); }
});

test('the current generated Expo web shell is accepted by the public-only static policy', async () => {
  const f = await fixture();
  try {
    const server = createStillHttpServer({ auth: f.auth, canonicalOrigin: f.canonicalOrigin, allowLocalHttp: true,
      staticRoot: resolve('..', 'dist-web') });
    assert.equal(server.listening, false, 'factory construction does not start a listener');
  } finally { await f.close(); }
});
