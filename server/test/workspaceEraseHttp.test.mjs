import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import Database from 'better-sqlite3';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundation } from '../dist/bootstrap.js';
import { startApplicationHost } from '../dist/applicationHost.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';

const PASSWORD = 'Workspace erase synthetic fixture password';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function startRestartHost(origin, dataDirectory, vaultKeyFile, staticRoot) {
  const worker = fileURLToPath(new URL('./fixtures/workspaceEraseRestartWorker.mjs', import.meta.url));
  const child = spawn(process.execPath, [worker, origin, dataDirectory, vaultKeyFile, staticRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`restart worker readiness timeout: ${errors}`)); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('READY\n')) { clearTimeout(timer); resolve(child); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!output.includes('READY\n')) reject(new Error(`restart worker exited ${code}: ${errors}`));
    });
  });
}
async function stopRestartHost(child) {
  if (!child || child.exitCode !== null) return;
  child.stdin.end('stop\n');
  await once(child, 'exit');
}
function wavFixture() {
  const data = Buffer.alloc(1600, 128);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36, 'ascii'); bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}
function cookie(response, name) {
  const values = response.headers.getSetCookie?.() ?? [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(';', 1)[0] ?? '';
}
async function login(origin) {
  const guest = await fetch(`${origin}/auth/session`, { headers: { Connection: 'close' } });
  const preauth = cookie(guest, '__Host-still_preauth');
  const guestDto = await guest.json();
  const response = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { Origin: origin, Cookie: preauth, Connection: 'close',
    'X-Still-CSRF': guestDto.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(response.status, 200, await response.clone().text());
  const dto = await response.json();
  return { session: cookie(response, '__Host-still_session'), csrf: dto.csrfToken };
}
function authHeaders(auth) { return { Cookie: auth.session, Connection: 'close' }; }
function mutationHeaders(origin, auth, extra = {}) {
  return { Cookie: auth.session, Origin: origin, 'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json', Connection: 'close', ...extra };
}
function json(value) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }); }
async function oidcFixture() {
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'erase-google-key', alg: 'RS256', use: 'sig' });
  const gate = deferred();
  let tokenEntered = false;
  let nonce = '';
  const fetcher = async (input, init = {}) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return json({ issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: GOOGLE_JWKS, userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo', response_types_supported: ['code'],
      subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
    if (url.href === GOOGLE_JWKS) return json({ keys: [jwk] });
    if (url.pathname === '/token') {
      assert.equal(init.method, 'POST');
      tokenEntered = true;
      gate.resolve();
      await gateRelease.promise;
      const issuedAt = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ iss: 'https://accounts.google.com', sub: 'erase-synthetic-subject', aud: 'google-client',
        iat: issuedAt, exp: issuedAt + 600, nonce, email: 'erase@example.test', email_verified: true, name: 'Erase Fixture' })
        .setProtectedHeader({ alg: 'RS256', kid: 'erase-google-key' }).sign(pair.privateKey);
      return json({ access_token: 'synthetic-erase-access', refresh_token: 'synthetic-erase-refresh', expires_in: 3600,
        scope: 'openid profile email https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer', id_token: idToken });
    }
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ sub: 'erase-synthetic-subject', name: 'Erase Fixture' });
    throw new Error(`unexpected synthetic OAuth request: ${url.href}`);
  };
  const gateRelease = deferred();
  return { fetcher, setNonce(value) { nonce = value; }, gate, release() { gateRelease.resolve(); }, tokenWasEntered: () => tokenEntered };
}

test('production HTTP erase fences the real runtime and removes real private audio and document files before receipt completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-workspace-erase-http-'));
  const staticRoot = join(root, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  const makeState = () => createInitialWorkspaceState(randomUUID);
  const enrollment = openServerFoundation(config, { initialWorkspaceSnapshot: makeState });
  let enrolled;
  try { enrolled = await enrollment.auth.enrollOwner(PASSWORD, makeState()); } finally { enrollment.close(); }
  const oidc = await oidcFixture();
  let host;
  let restartChild;
  try {
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: makeState },
      createRuntime: createProductionApplicationRuntimeFactory(config, { fetcher: oidc.fetcher }) });
    const original = await login(origin);
    const originalHeaders = authHeaders(original);
    const snapshotResponse = await fetch(`${origin}/api/workspace/snapshot`, { headers: originalHeaders });
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200, JSON.stringify(snapshot));
    assert.equal(snapshot.privacyEpoch, 0, JSON.stringify(snapshot));
    const workspaceId = enrolled.workspaceId;
    const ownerId = enrolled.ownerId;

    const docsRoot = join(config.dataDirectory, 'private-documents', ownerId, workspaceId);
    mkdirSync(docsRoot, { recursive: true });
    const docPath = join(docsRoot, 'private.md');
    writeFileSync(docPath, 'synthetic private document');
    const uploadId = randomUUID();
    const upload = await fetch(`${origin}/api/audio/uploads`, { method: 'POST', headers: mutationHeaders(origin, original, {
      'X-Still-Upload-ID': uploadId, 'X-Still-Capture': JSON.stringify({ id: randomUUID(), capturedAt: new Date().toISOString(), timeZone: 'UTC' }),
      'Content-Type': 'audio/wav' }), body: wavFixture() });
    assert.equal(upload.status, 201, await upload.clone().text());
    const uploaded = await upload.json();
    const audioRoot = join(config.dataDirectory, 'private-audio', workspaceId);
    assert.ok(existsSync(audioRoot));

    const startAttemptId = randomUUID();
    const oauthStart = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: mutationHeaders(origin, original),
      body: JSON.stringify({ startAttemptId, requestedCapabilities: ['mail.read'], expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 }) });
    assert.equal(oauthStart.status, 201, await oauthStart.clone().text());
    const oauthStartDto = await oauthStart.json();
    const authorizationUrl = new URL(oauthStartDto.authorizationUrl);
    const oauthState = authorizationUrl.searchParams.get('state');
    oidc.setNonce(authorizationUrl.searchParams.get('nonce'));
    assert.ok(oauthState);
    const oauthCookie = cookie(oauthStart, `__Host-still_oauth_google_${startAttemptId}`);
    assert.ok(oauthCookie);

    const callbackUrl = `${origin}/api/oauth/google/callback?code=synthetic-code&state=${encodeURIComponent(oauthState)}`;
    const callbackPending = fetch(callbackUrl, { redirect: 'manual', headers: { Cookie: oauthCookie, Connection: 'close' } });
    await oidc.gate.promise;
    assert.equal(oidc.tokenWasEntered(), true);

    const commandId = randomUUID();
    const planRequest = { commandId, expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 };
    const prepare = await fetch(`${origin}/api/workspace/erase/prepare`, { method: 'POST', headers: mutationHeaders(origin, original),
      body: JSON.stringify(planRequest) });
    assert.equal(prepare.status, 200, await prepare.clone().text());
    const plan = await prepare.json();
    assert.deepEqual(Object.keys(plan.counts).sort(), ['accounts', 'audioUploads', 'backgroundPolicies', 'documents', 'notes', 'proposals']);
    assert.equal(plan.counts.audioUploads, 1);

    const heldSnapshot = await fetch(`${origin}/api/workspace/snapshot`, { headers: originalHeaders });
    assert.equal(heldSnapshot.status, 409, await heldSnapshot.clone().text());
    const fresh = await login(origin);
    const freshSnapshot = await fetch(`${origin}/api/workspace/snapshot`, { headers: authHeaders(fresh) });
    assert.equal(freshSnapshot.status, 409, 'a fresh login cannot read the held workspace');
    const credentialWrite = await fetch(`${origin}/api/credentials`, { method: 'PUT', headers: mutationHeaders(origin, fresh,
      { 'X-Still-Command': randomUUID() }), body: JSON.stringify({ expectedPrivacyEpoch: 0,
        expectedGenerations: { openrouter: 0, speech: 0 }, keys: { openrouter: 'synthetic-secret-during-erase' } }) });
    assert.equal(credentialWrite.status, 409);
    const uploadWhileHeld = await fetch(`${origin}/api/audio/uploads`, { method: 'POST', headers: mutationHeaders(origin, fresh,
      { 'X-Still-Upload-ID': randomUUID(), 'X-Still-Capture': JSON.stringify({ id: randomUUID(), capturedAt: new Date().toISOString(), timeZone: 'UTC' }),
        'Content-Type': 'audio/wav' }), body: wavFixture() });
    assert.equal(uploadWhileHeld.status, 409);
    const oauthWhileHeld = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: mutationHeaders(origin, fresh),
      body: JSON.stringify({ startAttemptId: randomUUID(), requestedCapabilities: ['mail.read'], expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 }) });
    assert.equal(oauthWhileHeld.status, 409);

    oidc.release();
    const callback = await callbackPending;
    assert.equal(callback.status, 303);
    const stageId = new URL(callback.headers.get('location'), origin).searchParams.get('oauth_stage');
    assert.ok(stageId);
    const oauthDb = new Database(config.databasePath, { readonly: true });
    try {
      const stage = oauthDb.prepare(`SELECT status,payload_kind,nonce,tag,ciphertext FROM oauth_install_stages
        WHERE stage_id=? AND workspace_id=? AND owner_id=?`).get(stageId, workspaceId, ownerId);
      assert.deepEqual(stage, { status: 'inspect_required', payload_kind: 'authorization', nonce: null, tag: null, ciphertext: null },
        'the post-await erase fence must reject the stage without persisting verified OAuth material');
      assert.equal(oauthDb.prepare('SELECT count(*) AS count FROM server_oauth_token_bindings WHERE workspace_id=?').get(workspaceId).count, 0,
        'the callback cannot create a usable token binding');
      assert.equal(oauthDb.prepare('SELECT count(*) AS count FROM vault_ciphertexts WHERE workspace_id=?').get(workspaceId).count, 0,
        'the callback cannot write OAuth token material to the vault');
    } finally { oauthDb.close(); }
    const heldStage = await fetch(`${origin}/api/oauth/stages/${stageId}`, { headers: originalHeaders });
    assert.equal(heldStage.status, 409, 'verified OAuth content is inaccessible while the workspace is held');

    const docsOwnerRoot = join(config.dataDirectory, 'private-documents', ownerId);
    const parkedDocsOwner = `${docsOwnerRoot}-parked`;
    const outsideDocs = join(root, 'outside-documents');
    const outsideMarker = join(outsideDocs, 'keep.txt');
    mkdirSync(outsideDocs, { recursive: true });
    writeFileSync(outsideMarker, 'preserve through failed cleanup');
    renameSync(docsOwnerRoot, parkedDocsOwner);
    let symlinkAvailable = true;
    try { symlinkSync(outsideDocs, docsOwnerRoot, 'junction'); }
    catch (error) {
      symlinkAvailable = false;
      renameSync(parkedDocsOwner, docsOwnerRoot);
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
    }

    const confirm = await fetch(`${origin}/api/workspace/erase/confirm`, { method: 'POST', headers: mutationHeaders(origin, original),
      body: JSON.stringify({ commandId, expectedRevision: plan.expectedRevision, expectedPrivacyEpoch: plan.expectedPrivacyEpoch }) });
    assert.equal(confirm.status, 200, await confirm.clone().text());
    const execute = await fetch(`${origin}/api/workspace/erase/execute`, { method: 'POST', headers: mutationHeaders(origin, original),
      body: JSON.stringify({ commandId, expectedRevision: plan.expectedRevision, expectedPrivacyEpoch: plan.expectedPrivacyEpoch }) });
    assert.equal(execute.status, 200, await execute.clone().text());
    const receipt = await execute.json();
    assert.equal(receipt.status, symlinkAvailable ? 'cleanup_pending' : 'complete');
    assert.equal(existsSync(audioRoot), false, 'production audio file tree is removed before complete');
    if (!symlinkAvailable) assert.equal(existsSync(docsRoot), false, 'production document tree is removed before complete');
    assert.equal((await fetch(`${origin}/api/audio/uploads/${uploadId}`, { headers: originalHeaders })).status, 401,
      'the pre-erase session is revoked by the epoch update');
    const postEraseLogin = await login(origin);
    const freshStatus = await fetch(`${origin}/api/workspace/erase/status`, { headers: authHeaders(postEraseLogin) });
    assert.equal(freshStatus.status, 200, await freshStatus.clone().text());
    const status = await freshStatus.json();
    assert.equal(status.status, symlinkAvailable ? 'cleanup_pending' : 'complete');
    assert.equal(status.receipt.commandId, commandId);
    assert.equal(status.receipt.currentPrivacyEpoch, 1);
    if (symlinkAvailable) {
      assert.equal(existsSync(docsOwnerRoot), true, 'status inspection does not remove the symlink or write completion');
      assert.equal(existsSync(outsideMarker), true);
      const receiptRead = await fetch(`${origin}/api/workspace/erase/receipts/${commandId}`, { headers: authHeaders(postEraseLogin) });
      assert.equal(receiptRead.status, 200);
      assert.equal((await receiptRead.json()).status, 'cleanup_pending');
      unlinkSync(docsOwnerRoot);
      renameSync(parkedDocsOwner, docsOwnerRoot);
      const retryCleanup = await fetch(`${origin}/api/workspace/erase/retry-cleanup`, { method: 'POST',
        headers: mutationHeaders(origin, postEraseLogin), body: JSON.stringify({ commandId, expectedPrivacyEpoch: 1 }) });
      assert.equal(retryCleanup.status, 200, await retryCleanup.clone().text());
      const retriedReceipt = await retryCleanup.json();
      assert.equal(retriedReceipt.status, 'complete');
      assert.equal(existsSync(docsRoot), false);
      assert.equal(existsSync(audioRoot), false);
      assert.equal(existsSync(outsideMarker), true, 'cleanup never follows a symlink outside the private document root');
      const completedStatus = await fetch(`${origin}/api/workspace/erase/status`, { headers: authHeaders(postEraseLogin) });
      assert.equal(completedStatus.status, 200);
      assert.equal((await completedStatus.json()).receipt.status, 'complete');
      const replayReceipt = await fetch(`${origin}/api/workspace/erase/receipts/${commandId}`, { headers: authHeaders(postEraseLogin) });
      assert.equal(replayReceipt.status, 200);
      assert.equal((await replayReceipt.json()).status, 'complete');
    }

    await host.close();
    host = undefined;
    restartChild = await startRestartHost(origin, config.dataDirectory, config.vaultKeyFile, staticRoot);
    const afterErase = await login(origin);
    const afterEraseSnapshotResponse = await fetch(`${origin}/api/workspace/snapshot`, { headers: authHeaders(afterErase) });
    const afterEraseSnapshot = await afterEraseSnapshotResponse.json();
    assert.equal(afterEraseSnapshotResponse.status, 200, JSON.stringify(afterEraseSnapshot));
    const pausedCommandId = randomUUID();
    const pausedInput = { commandId: pausedCommandId, expectedRevision: afterEraseSnapshot.revision, expectedPrivacyEpoch: 1 };
    const pausedPrepare = await fetch(`${origin}/api/workspace/erase/prepare`, { method: 'POST', headers: mutationHeaders(origin, afterErase),
      body: JSON.stringify(pausedInput) });
    assert.equal(pausedPrepare.status, 200, await pausedPrepare.clone().text());
    await stopRestartHost(restartChild);
    restartChild = await startRestartHost(origin, config.dataDirectory, config.vaultKeyFile, staticRoot);
    const db = new Database(config.databasePath);
    try {
      const expired = db.prepare('UPDATE workspace_erase_plans SET expires_at=? WHERE command_id=?').run(Date.now() - 1, pausedCommandId);
      assert.equal(expired.changes, 1);
    } finally { db.close(); }
    await stopRestartHost(restartChild);
    restartChild = await startRestartHost(origin, config.dataDirectory, config.vaultKeyFile, staticRoot);
    const recovered = await login(origin);
    const recoveredStatus = await fetch(`${origin}/api/workspace/erase/status`, { headers: authHeaders(recovered) });
    assert.equal(recoveredStatus.status, 200, await recoveredStatus.clone().text());
    const recoveredDto = await recoveredStatus.json();
    assert.equal(recoveredDto.status, 'prepared');
    assert.equal(recoveredDto.plan.commandId, pausedCommandId);
    const recoveredSnapshot = await fetch(`${origin}/api/workspace/snapshot`, { headers: authHeaders(recovered) });
    assert.equal(recoveredSnapshot.status, 409);
    const cancellationBody = { commandId: pausedCommandId, expectedRevision: pausedInput.expectedRevision, expectedPrivacyEpoch: 1 };
    const cancellation = await fetch(`${origin}/api/workspace/erase/cancel`, { method: 'POST', headers: mutationHeaders(origin, recovered),
      body: JSON.stringify(cancellationBody) });
    assert.equal(cancellation.status, 200, await cancellation.clone().text());
    assert.equal((await cancellation.json()).status, 'cancelled');
    const duplicateCancellation = await fetch(`${origin}/api/workspace/erase/cancel`, { method: 'POST', headers: mutationHeaders(origin, recovered),
      body: JSON.stringify(cancellationBody) });
    assert.equal(duplicateCancellation.status, 200, await duplicateCancellation.clone().text());
    assert.equal((await duplicateCancellation.json()).status, 'cancelled');
  } finally {
    await host?.close();
    await stopRestartHost(restartChild);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
