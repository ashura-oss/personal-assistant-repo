import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as rawHttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService, createDurableKernel, createStillHttpServer, SecretVault, ServerCredentialCommandService } from '../dist/index.js';

async function freePort() {
  const net = await import('node:net');
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-http-credentials-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body><div id="root"></div></body></html>');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  const port = await freePort();
  const canonicalOrigin = `http://127.0.0.1:${port}`;
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), now: () => now,
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const auth = new AuthService(kernel, { canonicalOrigin, allowLocalHttp: true, authSecret: randomBytes(32), now: () => now });
  await auth.enrollOwner('correct horse battery staple', { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] });
  const challenge = auth.createLoginChallenge(canonicalOrigin);
  const login = await auth.login({ password: 'correct horse battery staple', origin: canonicalOrigin,
    preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
  const vault = new SecretVault(kernel, randomBytes(32));
  const credentialCommands = new ServerCredentialCommandService(kernel, vault, { now: () => now });
  const server = createStillHttpServer({ auth, canonicalOrigin, allowLocalHttp: true, staticRoot, credentialCommands });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const cookie = `__Host-still_session=${login.sessionToken}`;
  const request = (path, init = {}) => fetch(`${canonicalOrigin}${path}`, init);
  return {
    directory, canonicalOrigin, kernel, auth, vault, credentialCommands, server, cookie, csrf: login.session.csrfToken, request,
    sessionToken: login.sessionToken,
    setTime(value) { now = value; },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      auth.close(); vault.close(); kernel.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function commandHeaders(f, commandId, { csrf = f.csrf, origin = f.canonicalOrigin, cookie = f.cookie } = {}) {
  return { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(csrf ? { 'X-Still-CSRF': csrf } : {}),
    'X-Still-Command': commandId, 'Content-Type': 'application/json' };
}

test('credential HTTP routes expose metadata only and canonicalize ordinary unsorted JSON before durable command replay', async () => {
  const f = await fixture();
  try {
    const unauthenticated = await f.request('/api/credentials');
    assert.equal(unauthenticated.status, 401);
    const initialResponse = await f.request('/api/credentials', { headers: { Cookie: f.cookie } });
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.privacyEpoch, 0);
    assert.deepEqual(initial.credentials, { speech: { configured: false, generation: 0 }, openrouter: { configured: false, generation: 0 } });
    assert.equal(initialResponse.headers.get('cache-control'), 'no-store');

    const commandId = randomUUID();
    const sentinels = { speech: 'SPEECH_HTTP_SECRET_NEVER_RETURN', openrouter: 'OPENROUTER_HTTP_SECRET_NEVER_RETURN' };
    // Deliberately unsorted object keys: the browser sends ordinary JSON, while
    // the HTTP boundary supplies canonical object encoding to the command service.
    const body = '{"expectedGenerations":{"speech":0,"openrouter":0},"keys":{"speech":"SPEECH_HTTP_SECRET_NEVER_RETURN","openrouter":"OPENROUTER_HTTP_SECRET_NEVER_RETURN"},"expectedPrivacyEpoch":0}';
    const before = f.auth.assertMutation.bind(f.auth);
    let mutationChecks = 0;
    f.auth.assertMutation = (...args) => { mutationChecks += 1; return before(...args); };
    const updatedResponse = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, commandId), body });
    assert.equal(mutationChecks, 2, 'mutation authority is rechecked after body parsing before the atomic call');
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json();
    assert.equal(updated.credentials.speech.generation, 1);
    assert.equal(updated.credentials.openrouter.generation, 1);
    assert.equal(JSON.stringify(updated).includes(sentinels.speech), false);
    assert.equal(JSON.stringify(updated).includes(sentinels.openrouter), false);

    const replay = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, commandId),
      body: '{"keys":{"openrouter":"OPENROUTER_HTTP_SECRET_NEVER_RETURN","speech":"SPEECH_HTTP_SECRET_NEVER_RETURN"},"expectedPrivacyEpoch":0,"expectedGenerations":{"openrouter":0,"speech":0}}' });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), updated, 'same semantic JSON replays its metadata receipt despite input key ordering');

    const largerThanAuthLimit = 'K'.repeat(20_000);
    const largeCredential = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, randomUUID()),
      body: JSON.stringify({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 1 }, keys: { speech: largerThanAuthLimit } }) });
    assert.equal(largeCredential.status, 200, 'credential writes use the bounded credential limit, not the 16 KiB auth JSON limit');
    assert.equal(JSON.stringify(await largeCredential.json()).includes(largerThanAuthLimit), false);

    const conflict = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, commandId),
      body: '{"expectedPrivacyEpoch":0,"expectedGenerations":{"speech":0},"keys":{"speech":"DIFFERENT_SECRET"}}' });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'credential_conflict' });
    assert.equal(JSON.stringify(await (await f.request(`/api/credential-commands/${commandId}`, { headers: { Cookie: f.cookie } })).json()).includes('SECRET'), false);
  } finally { await f.close(); }
});

test('credential mutations enforce exact origin, CSRF, UUID, typed bodies and sorted clear-all scopes', async () => {
  const f = await fixture();
  try {
    const requestBody = JSON.stringify({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0 }, keys: { speech: 'PRIVATE_SENTINEL' } });
    const noOrigin = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, randomUUID(), { origin: null }), body: requestBody });
    assert.equal(noOrigin.status, 403);
    const wrongOrigin = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, randomUUID(), { origin: 'https://attacker.invalid' }), body: requestBody });
    assert.equal(wrongOrigin.status, 403);
    const wrongCsrf = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, randomUUID(), { csrf: 'A'.repeat(43) }), body: requestBody });
    assert.equal(wrongCsrf.status, 403);
    const noSession = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, randomUUID(), { cookie: null }), body: requestBody });
    assert.equal(noSession.status, 401);
    const badId = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, 'not-a-uuid'), body: requestBody });
    assert.equal(badId.status, 400);
    const extra = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, randomUUID()),
      body: JSON.stringify({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0 }, keys: { speech: 'PRIVATE_SENTINEL' }, workspaceId: randomUUID() }) });
    assert.equal(extra.status, 400);
    const staleEpoch = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, randomUUID()),
      body: JSON.stringify({ expectedPrivacyEpoch: 9, expectedGenerations: { speech: 0 }, keys: { speech: 'PRIVATE_SENTINEL' } }) });
    assert.equal(staleEpoch.status, 409);

    const badOrder = await f.request('/api/credentials', { method: 'DELETE', headers: commandHeaders(f, randomUUID()),
      body: JSON.stringify({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0, openrouter: 0 }, kinds: ['speech', 'openrouter'] }) });
    assert.equal(badOrder.status, 400);
    const put = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, randomUUID()), body: requestBody });
    assert.equal(put.status, 200);
    const deleteId = randomUUID();
    const deletedResponse = await f.request('/api/credentials', { method: 'DELETE', headers: commandHeaders(f, deleteId),
      body: '{"kinds":["openrouter","speech"],"expectedGenerations":{"speech":1,"openrouter":0},"expectedPrivacyEpoch":0}' });
    assert.equal(deletedResponse.status, 200);
    const deleted = await deletedResponse.json();
    assert.deepEqual(deleted.credentials, { speech: { configured: false, generation: 2 }, openrouter: { configured: false, generation: 1 } });
    assert.deepEqual(await (await f.request(`/api/credential-commands/${deleteId}`, { headers: { Cookie: f.cookie } })).json(),
      { status: 'finished', metadata: deleted });
    const unknown = await f.request(`/api/credential-commands/${randomUUID()}`, { headers: { Cookie: f.cookie } });
    assert.deepEqual(await unknown.json(), { status: 'inspect_required' });
    assert.equal((await f.request(`/api/credential-commands/${deleteId}`, { headers: { Cookie: `__Host-still_session=${'A'.repeat(43)}` } })).status, 401);
    assert.equal((await f.request(`/api/credential-commands/${deleteId}?private=1`, { headers: { Cookie: f.cookie } })).status, 400);
    assert.equal(JSON.stringify(deleted).includes('PRIVATE_SENTINEL'), false);
  } finally { await f.close(); }
});

test('a command replay with changed clear scope or generation is a conflict, not a second credential write', async () => {
  const f = await fixture();
  try {
    const commandId = randomUUID();
    const body = JSON.stringify({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0 }, keys: { speech: 'ONLY_IN_VAULT' } });
    const first = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, commandId), body });
    assert.equal(first.status, 200);
    const conflict = await f.request('/api/credentials', { method: 'PUT', headers: commandHeaders(f, commandId),
      body: JSON.stringify({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 1 }, keys: { speech: 'SECOND_SECRET' } }) });
    assert.equal(conflict.status, 409);
    assert.deepEqual((await (await f.request('/api/credentials', { headers: { Cookie: f.cookie } })).json()).credentials.speech,
      { configured: true, generation: 1 });
    assert.equal((await f.request('/api/credentials', { method: 'POST', headers: commandHeaders(f, randomUUID()), body: '{}' })).status, 405);
    assert.equal((await f.request('/api/credentials?workspace=1', { headers: { Cookie: f.cookie } })).status, 400);
  } finally { await f.close(); }
});

test('session revocation while a credential body is still arriving prevents the synchronous command', async () => {
  const f = await fixture();
  try {
    let putCalls = 0;
    const put = f.credentialCommands.put.bind(f.credentialCommands);
    f.credentialCommands.put = (...args) => { putCalls += 1; return put(...args); };
    const commandId = randomUUID();
    const body = JSON.stringify({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0 }, keys: { speech: 'RACE_SECRET' } });
    const url = new URL('/api/credentials', f.canonicalOrigin);
    const result = await new Promise((resolve, reject) => {
      const req = rawHttpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'PUT', headers: {
        Cookie: f.cookie, Origin: f.canonicalOrigin, 'X-Still-CSRF': f.csrf, 'X-Still-Command': commandId,
        'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
      } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.write(body.slice(0, Math.floor(body.length / 2)));
      setTimeout(() => {
        try {
          f.auth.logout(f.sessionToken, f.canonicalOrigin, f.csrf);
          req.end(body.slice(Math.floor(body.length / 2)));
        } catch (error) { req.destroy(error); }
      }, 25);
    });
    assert.equal(result.status, 401);
    assert.deepEqual(JSON.parse(result.body), { error: 'unauthenticated' });
    assert.equal(putCalls, 0);
  } finally { await f.close(); }
});
