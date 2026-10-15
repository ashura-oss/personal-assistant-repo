import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as rawHttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createDurableKernel } from '../dist/kernel.js';
import { createStillHttpServer } from '../dist/http.js';
import { SecretVault } from '../dist/vault.js';
import { createWebPushHttpApi } from '../dist/webPushHttp.js';

async function freePort() {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-web-push-http-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  const port = await freePort();
  const canonicalOrigin = `http://127.0.0.1:${port}`;
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), now: () => now,
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const auth = new AuthService(kernel, { canonicalOrigin, allowLocalHttp: true, authSecret: randomBytes(32), now: () => now });
  const enrolled = await auth.enrollOwner('synthetic-web-push-http-password', {
    accounts: [], documents: [], tasks: [], notes: [], proposals: [], backgroundPolicies: [],
  });
  const challenge = auth.createLoginChallenge(canonicalOrigin);
  const login = await auth.login({ password: 'synthetic-web-push-http-password', origin: canonicalOrigin,
    preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
  const vault = new SecretVault(kernel, randomBytes(32));
  let eraseHeld = false;
  const assertWorkspaceAdmission = () => { if (eraseHeld) throw new Error('workspace_erase_in_progress'); };
  const webPushApi = createWebPushHttpApi(kernel, vault, assertWorkspaceAdmission);
  const workspaceApi = { assertWorkspaceAdmission };
  const server = createStillHttpServer({ auth, canonicalOrigin, allowLocalHttp: true, staticRoot, webPushApi, workspaceApi });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const cookie = `__Host-still_session=${login.sessionToken}`;
  return { directory, canonicalOrigin, kernel, auth, vault, webPushApi, server, enrolled, login, cookie,
    setEraseHeld(value) { eraseHeld = value; },
    csrf: login.session.csrfToken, request: (path, init = {}) => fetch(`${canonicalOrigin}${path}`, init),
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      auth.close(); vault.close(); kernel.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 5 });
    } };
}

function mutationHeaders(f, { cookie = f.cookie, origin = f.canonicalOrigin, csrf = f.csrf } = {}) {
  return { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}),
    ...(csrf ? { 'X-Still-CSRF': csrf } : {}), 'Content-Type': 'application/json' };
}

function subscription() {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  return { endpoint: `https://push.example.invalid/send/HTTP_ENDPOINT_SENTINEL_${randomUUID()}`,
    keys: { p256dh: receiver.getPublicKey(undefined, 'uncompressed').toString('base64url'),
      auth: randomBytes(16).toString('base64url') } };
}

test('Web Push HTTP status, explicit key provisioning, subscription registration, receipt inspection, and revoke are owner-authenticated', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/web-push/status')).status, 401);
    const initial = await f.request('/api/web-push/status', { headers: { Cookie: f.cookie } });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { schemaVersion: 1, privacyEpoch: 0, provisioned: false, subscriptionCount: 0 });
    const emptyKey = await f.request('/api/web-push/vapid-key', { headers: { Cookie: f.cookie } });
    assert.equal(emptyKey.status, 200);
    assert.deepEqual(await emptyKey.json(), { schemaVersion: 1, privacyEpoch: 0, provisioned: false });
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) =>
      db.prepare('SELECT COUNT(*) AS count FROM web_push_vapid_keys WHERE workspace_id=?').get(f.enrolled.workspaceId).count), 0,
    'GET never generates a key');

    const unauthenticated = await f.request('/api/web-push/provision', { method: 'POST', headers: mutationHeaders(f, { cookie: null }),
      body: JSON.stringify({ commandId: randomUUID(), expectedPrivacyEpoch: 0 }) });
    assert.equal(unauthenticated.status, 401);
    const missingCsrf = await f.request('/api/web-push/provision', { method: 'POST', headers: mutationHeaders(f, { csrf: null }),
      body: JSON.stringify({ commandId: randomUUID(), expectedPrivacyEpoch: 0 }) });
    assert.equal(missingCsrf.status, 403);
    const wrongOrigin = await f.request('/api/web-push/provision', { method: 'POST', headers: mutationHeaders(f, { origin: 'https://attacker.invalid' }),
      body: JSON.stringify({ commandId: randomUUID(), expectedPrivacyEpoch: 0 }) });
    assert.equal(wrongOrigin.status, 403);

    const provisionCommand = randomUUID();
    const provisionBody = JSON.stringify({ commandId: provisionCommand, expectedPrivacyEpoch: 0 });
    const provisionResponse = await f.request('/api/web-push/provision', { method: 'POST', headers: mutationHeaders(f), body: provisionBody });
    assert.equal(provisionResponse.status, 200);
    const provision = await provisionResponse.json();
    assert.equal(provision.operation, 'provision');
    assert.equal(JSON.stringify(provision).includes('privateKey'), false);
    const replay = await f.request('/api/web-push/provision', { method: 'POST', headers: mutationHeaders(f), body: provisionBody });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), provision);
    const conflict = await f.request('/api/web-push/rotate', { method: 'POST', headers: mutationHeaders(f),
      body: JSON.stringify({ commandId: provisionCommand, expectedPrivacyEpoch: 0, expectedActiveKeyId: provision.result.keyId }) });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'web_push_conflict' });

    const publicKey = await f.request('/api/web-push/vapid-key', { headers: { Cookie: f.cookie } });
    assert.equal(publicKey.status, 200);
    assert.deepEqual(await publicKey.json(), { schemaVersion: 1, privacyEpoch: 0, provisioned: true,
      keyId: provision.result.keyId, publicKey: provision.result.publicKey, createdAt: provision.result.createdAt });
    const supplied = subscription();
    const deviceId = randomUUID();
    const registerCommand = randomUUID();
    const registerBody = JSON.stringify({ commandId: registerCommand, expectedPrivacyEpoch: 0, deviceId,
      keyId: provision.result.keyId, expectedPreviousGeneration: 0, subscription: supplied });
    const registeredResponse = await f.request('/api/web-push/subscriptions/register', { method: 'POST',
      headers: mutationHeaders(f), body: registerBody });
    assert.equal(registeredResponse.status, 200);
    const registered = await registeredResponse.json();
    assert.equal(registered.result.deviceId, deviceId);
    assert.equal(registered.result.generation, 1);
    const safeJson = JSON.stringify(registered);
    assert.equal(safeJson.includes(supplied.endpoint), false);
    assert.equal(safeJson.includes(supplied.keys.p256dh), false);
    assert.equal(safeJson.includes(supplied.keys.auth), false);
    const inspected = await f.request(`/api/web-push/commands/${registerCommand}`, { headers: { Cookie: f.cookie } });
    assert.equal(inspected.status, 200);
    assert.deepEqual(await inspected.json(), registered);

    const page = await f.request('/api/web-push/subscriptions', { headers: { Cookie: f.cookie } });
    assert.equal(page.status, 200);
    assert.deepEqual((await page.json()).subscriptions, [{ deviceId, generation: 1, status: 'active',
      keyId: provision.result.keyId, updatedAt: registered.result.updatedAt }]);
    const revokeCommand = randomUUID();
    const revokedResponse = await f.request('/api/web-push/subscriptions/revoke', { method: 'POST', headers: mutationHeaders(f),
      body: JSON.stringify({ commandId: revokeCommand, expectedPrivacyEpoch: 0, deviceId, expectedGeneration: 1 }) });
    assert.equal(revokedResponse.status, 200);
    assert.equal((await revokedResponse.json()).result.status, 'revoked');
    assert.equal((await f.request(`/api/web-push/commands/${randomUUID()}`, { headers: { Cookie: f.cookie } })).status, 404);
    assert.equal((await f.request('/api/web-push/status?x=1', { headers: { Cookie: f.cookie } })).status, 400);
  } finally { await f.close(); }
});

test('logout while a Web Push mutation body is pending prevents every registry call', async () => {
  const f = await fixture();
  let calls = 0;
  const provision = f.webPushApi.provision.bind(f.webPushApi);
  f.webPushApi.provision = (...args) => { calls += 1; return provision(...args); };
  try {
    const url = new URL('/api/web-push/provision', f.canonicalOrigin);
    const commandId = randomUUID();
    const body = JSON.stringify({ commandId, expectedPrivacyEpoch: 0 });
    const result = await new Promise((resolve, reject) => {
      const request = rawHttpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'POST', headers: {
        Cookie: f.cookie, Origin: f.canonicalOrigin, 'X-Still-CSRF': f.csrf, 'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.write(body.slice(0, Math.floor(body.length / 2)));
      setTimeout(() => {
        try {
          f.auth.logout(f.login.sessionToken, f.canonicalOrigin, f.csrf);
          request.end(body.slice(Math.floor(body.length / 2)));
        } catch (error) { request.destroy(error); }
      }, 20);
    });
    assert.equal(result.status, 401);
    assert.deepEqual(JSON.parse(result.body), { error: 'unauthenticated' });
    assert.equal(calls, 0);
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) =>
      db.prepare('SELECT COUNT(*) AS count FROM web_push_vapid_keys WHERE workspace_id=?').get(f.enrolled.workspaceId).count), 0);
  } finally { await f.close(); }
});

test('an erase hold acquired while a Web Push body is pending blocks the registry commit', async () => {
  const f = await fixture();
  let calls = 0;
  const provision = f.webPushApi.provision.bind(f.webPushApi);
  f.webPushApi.provision = (...args) => { calls += 1; return provision(...args); };
  try {
    const url = new URL('/api/web-push/provision', f.canonicalOrigin);
    const commandId = randomUUID();
    const body = JSON.stringify({ commandId, expectedPrivacyEpoch: 0 });
    const result = await new Promise((resolve, reject) => {
      const request = rawHttpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'POST', headers: {
        Cookie: f.cookie, Origin: f.canonicalOrigin, 'X-Still-CSRF': f.csrf, 'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.write(body.slice(0, Math.floor(body.length / 2)));
      setTimeout(() => {
        f.setEraseHeld(true);
        request.end(body.slice(Math.floor(body.length / 2)));
      }, 20);
    });
    assert.equal(result.status, 409);
    assert.deepEqual(JSON.parse(result.body), { error: 'workspace_erase_in_progress' });
    assert.equal(calls, 0);
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) =>
      db.prepare('SELECT COUNT(*) AS count FROM web_push_vapid_keys WHERE workspace_id=?').get(f.enrolled.workspaceId).count), 0);
  } finally { await f.close(); }
});
