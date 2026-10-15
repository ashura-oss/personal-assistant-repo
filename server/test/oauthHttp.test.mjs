import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundation } from '../dist/bootstrap.js';
import { startApplicationHost } from '../dist/applicationHost.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createCloudApplicationRuntimeFactory, createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { createNodeProviderResponseLifetimeOwner } from '../dist/providerResponseLifetime.node.mjs';
import { createServerOAuthProviderAdapter } from '../dist/oauthProviderAdapter.js';

const PASSWORD = 'OAuth feature fixture password';
const ORIGIN = 'http://127.0.0.1';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const MS_JWKS = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}
function staticFixture(directory) {
  const root = join(directory, 'public');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body><div id="root"></div></body></html>');
  writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(root, 'sw.js'), '');
  writeFileSync(join(root, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  return root;
}
function state() {
  return createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
    openRouterReasoningEffort: 'low', llmRequestContractVersion: 1 });
}
function closedPorts() {
  const unavailable = async () => 'unavailable';
  return {
    disposeUnattached() {},
    responseLifetimeOwner: createNodeProviderResponseLifetimeOwner({ fetcher: async () => { throw new Error('closed fixture provider'); }, createId: randomUUID }),
    providers: {
      speech: { async transcribe() { throw new Error('closed fixture provider'); }, async releaseUploadLease() {}, disposeMemory() {} },
      openAi: { async prepare() { throw new Error('closed fixture provider'); }, async analyze() { throw new Error('closed fixture provider'); },
        async generateReply() { throw new Error('closed fixture provider'); } },
    },
    integration: {
      reminderBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async listPending() { return []; }, async schedule() {}, async cancel() {}, async cancelLegacy() {}, async installForegroundHandler() {} },
      mailAlertBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; } },
      deviceCalendarBackend: { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
        async listCalendars() { return []; }, async getCalendar() { return undefined; }, async readEvents() { return []; },
        async createApprovedEvent() { throw new Error('unsupported'); }, async lookupRecord() { return undefined; } },
      async writeDocument() {}, async removeAudio() {},
      async loadRecordingRecovery() { return { async pickAndStage() { return null; }, async inspect() { throw new Error('unsupported'); }, async remove() {} }; },
      bindRecordingRecovery(service) { return service; },
    },
  };
}
function cookie(response, name) {
  const values = response.headers.getSetCookie?.() ?? [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(';', 1)[0] ?? '';
}
async function login(origin) {
  const guest = await fetch(`${origin}/auth/session`);
  const preauth = cookie(guest, '__Host-still_preauth');
  const guestDto = await guest.json();
  const response = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { Origin: origin, Cookie: preauth,
    'X-Still-CSRF': guestDto.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(response.status, 200);
  const session = cookie(response, '__Host-still_session');
  const dto = await response.json();
  return { session, csrf: dto.csrfToken };
}

async function oidcHarness() {
  const keys = {};
  const jwks = {};
  for (const provider of ['google', 'microsoft']) {
    const pair = await generateKeyPair('RS256');
    const jwk = await exportJWK(pair.publicKey);
    Object.assign(jwk, { kid: `${provider}-key`, alg: 'RS256', use: 'sig' });
    if (provider === 'microsoft') jwk.issuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    keys[provider] = pair.privateKey;
    jwks[provider] = { keys: [jwk] };
  }
  const active = new Map();
  const calls = [];
  let tokenCalls = 0;
  let gateNextGoogleToken;
  let gateNextDiscovery;
  let failNextToken = false;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input.toString());
    calls.push({ provider: active.get('provider'), url: url.href, method: init.method ?? 'GET', body: init.body });
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      if (gateNextDiscovery && gateNextDiscovery.provider === active.get('provider')) {
        const gate = gateNextDiscovery; gateNextDiscovery = undefined; gate.entered.resolve(); await gate.release.promise;
      }
      return json({
        google: { issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: GOOGLE_JWKS,
          userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo', response_types_supported: ['code'],
          subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'] },
        microsoft: { issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
          authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
          token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', jwks_uri: MS_JWKS,
          userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo', response_types_supported: ['code'],
          subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'] },
      }[active.get('provider')]);
    }
    if (url.href === GOOGLE_JWKS) return json(jwks.google);
    if (url.href === MS_JWKS) return json(jwks.microsoft);
    if (url.pathname.endsWith('/token')) {
      tokenCalls += 1;
      if (failNextToken) { failNextToken = false; return json({ error: 'temporarily_unavailable' }, 503); }
      const provider = active.get('provider');
      if (provider === 'google' && gateNextGoogleToken) { const gate = gateNextGoogleToken; gateNextGoogleToken = undefined; gate.entered.resolve(); await gate.release.promise; }
      const flow = active.get(provider);
      const issuedAt = Math.floor(Date.now() / 1000);
      const claims = provider === 'google'
        ? { iss: 'https://accounts.google.com', sub: 'google-subject', aud: 'google-client', iat: issuedAt, exp: issuedAt + 600,
          nonce: flow.nonce, email: 'google@example.test', email_verified: true, name: 'Google Fixture' }
        : { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, sub: 'ms-subject', aud: 'microsoft-client',
          iat: issuedAt, exp: issuedAt + 600, nonce: flow.nonce, tid: TENANT, name: 'Microsoft Fixture' };
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: `${provider}-key` }).sign(keys[provider]);
      const scopes = provider === 'google' ? 'openid profile email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.readonly'
        : 'openid profile email offline_access User.Read Mail.Read';
      const authHeader = new Headers(init.headers);
      assert.match(authHeader.get('content-type') ?? '', /^application\/x-www-form-urlencoded(?:;\s*charset=UTF-8)?$/i);
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('client_secret'), `synthetic-${provider}-secret`);
      return json({ access_token: `${provider}-access`, refresh_token: `${provider}-refresh`, expires_in: 3600,
        scope: scopes, token_type: 'Bearer', id_token: idToken });
    }
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ sub: 'google-subject', name: 'Google Fixture' });
    if (url.href === 'https://graph.microsoft.com/oidc/userinfo') return json({ sub: 'ms-subject' });
    if (url.href === 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName') {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer microsoft-access');
      return json({ id: 'graph-user-not-oid', displayName: 'Microsoft Fixture', mail: 'ms@example.test' });
    }
    throw new Error(`unexpected synthetic OAuth request: ${url.href}`);
  };
  function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
  return { fetcher, active, calls, tokenCount: () => tokenCalls,
    failNextTokenExchange() { failNextToken = true; },
    gateGoogleToken() { const gate = { entered: deferred(), release: deferred() }; gateNextGoogleToken = gate; return gate; },
    gateDiscovery(provider) { const gate = { provider, entered: deferred(), release: deferred() }; gateNextDiscovery = gate; return gate; } };
}

test('OAuth HTTP flow binds callback to per-start cookie, claims once, and installs Google plus Microsoft through the real runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-http-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret', STILL_MICROSOFT_CLIENT_ID: 'microsoft-client',
    STILL_MICROSOFT_CLIENT_SECRET: 'synthetic-microsoft-secret' }, { staticRoot, allowLocalHttp: true });
  let host;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: state });
    try { await foundation.auth.enrollOwner(PASSWORD, state()); } finally { foundation.close(); }
    const oidc = await oidcHarness();
    const responseOwner = createNodeProviderResponseLifetimeOwner({ fetcher: oidc.fetcher, createId: randomUUID });
    const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: origin, registrations: [
      { registrationId: 'google', provider: 'google', clientId: 'google-client', clientSecret: 'synthetic-google-secret' },
      { registrationId: 'microsoft', provider: 'microsoft', clientId: 'microsoft-client', clientSecret: 'synthetic-microsoft-secret' },
    ], responseLifetime: responseOwner.withResponseLifetimeFor('oauth') });
    const provider = adapter;
    const factory = createCloudApplicationRuntimeFactory({ workspacePortsFor: () => closedPorts(), oauth: { provider,
      responseLifetimeOwner: responseOwner, config } });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state }, createRuntime: factory });
    const auth = await login(origin);
    const authHeaders = { Cookie: auth.session };
    const initialSnapshot = await (await fetch(`${origin}/api/workspace/snapshot`, { headers: authHeaders })).json();
    let expectedRevision = initialSnapshot.revision;
    const availability = await fetch(`${origin}/api/oauth/availability`, { headers: authHeaders });
    assert.equal(availability.status, 200);
    assert.deepEqual(await availability.json(), { google: true, microsoft: true });
    assert.equal((await fetch(`${origin}/api/oauth/availability`)).status, 401);
    assert.equal((await fetch(`${origin}/api/oauth/availability`, { headers: { ...authHeaders, Origin: 'https://attacker.example.test' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/oauth/availability?extra=1`, { headers: authHeaders })).status, 400);
    const listBefore = await fetch(`${origin}/api/oauth/starts`, { headers: authHeaders });
    assert.equal(listBefore.status, 200);
    assert.deepEqual(await listBefore.json(), []);
    const unauthenticated = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { Origin: origin, 'X-Still-CSRF': auth.csrf,
      'Content-Type': 'application/json' },
      body: JSON.stringify({ startAttemptId: randomUUID(), requestedCapabilities: ['mail.read'], expectedRevision: 0, expectedPrivacyEpoch: 0 }) });
    assert.equal(unauthenticated.status, 401);

    async function start(provider, expectedRevision, extra = {}) {
      oidc.active.set('provider', provider);
      const startAttemptId = randomUUID();
      const response = await fetch(`${origin}/api/oauth/${provider}/start`, { method: 'POST', headers: { ...authHeaders, Origin: origin,
        'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId,
        requestedCapabilities: ['mail.read'], expectedRevision, expectedPrivacyEpoch: 0, ...extra }) });
      assert.equal(response.status, 201, await response.clone().text());
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['authorizationUrl', 'kind', 'status']);
      assert.equal('cookie' in body, false);
      assert.equal('cookieBinding' in body, false);
      const authorizationUrl = new URL(body.authorizationUrl);
      const cookieHeader = cookie(response, `__Host-still_oauth_${provider}_${startAttemptId}`);
      assert.ok(cookieHeader);
      oidc.active.set(provider, { nonce: authorizationUrl.searchParams.get('nonce'), scopes: authorizationUrl.searchParams.get('scope') });
      return { startAttemptId, body, authorizationUrl, cookieHeader };
    }

    const google = await start('google', expectedRevision);
    const duplicateStart = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { ...authHeaders, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId: google.startAttemptId,
      requestedCapabilities: ['mail.read'], expectedRevision, expectedPrivacyEpoch: 0 }) });
    assert.equal(duplicateStart.status, 200);
    const duplicateStartBody = await duplicateStart.json();
    assert.equal(duplicateStartBody.kind, 'existing');
    assert.equal('authorizationUrl' in duplicateStartBody, false);
    assert.equal(duplicateStart.headers.getSetCookie?.().some((value) => value.startsWith(`__Host-still_oauth_google_${google.startAttemptId}=`)), false);
    const pendingInspectionResponse = await fetch(`${origin}/api/oauth/stages/${google.body.status.attemptId}`, { headers: authHeaders });
    const pendingInspection = await pendingInspectionResponse.json();
    assert.deepEqual(Object.keys(pendingInspection), ['stage']);
    assert.equal(pendingInspection.stage.status, 'authorization_pending');
    assert.equal(oidc.tokenCount(), 0, 'metadata preview does not contact the provider');
    const googleState = google.authorizationUrl.searchParams.get('state');
    assert.ok(googleState);
    const tokenGate = oidc.gateGoogleToken();
    const googleCallbackUrl = `${origin}/api/oauth/google/callback?code=synthetic-google-code&state=${googleState}`;
    const firstCallback = fetch(googleCallbackUrl, { redirect: 'manual', headers: { Cookie: google.cookieHeader } });
    await tokenGate.entered.promise;
    const tokenCountAtClaim = oidc.tokenCount();
    const claimedRestart = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { ...authHeaders, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId: randomUUID(),
      restartOfStartAttemptId: google.startAttemptId, requestedCapabilities: ['mail.read'], expectedRevision, expectedPrivacyEpoch: 0 }) });
    assert.equal(claimedRestart.status, 409);
    const duplicateCallback = await fetch(googleCallbackUrl, { redirect: 'manual', headers: { Cookie: google.cookieHeader } });
    assert.equal(duplicateCallback.status, 303);
    assert.equal(duplicateCallback.headers.get('location')?.startsWith('/?oauth_stage='), true);
    assert.equal(oidc.tokenCount(), tokenCountAtClaim);
    tokenGate.release.resolve();
    const googleRedirect = await firstCallback;
    assert.equal(googleRedirect.status, 303);
    assert.equal(oidc.tokenCount(), 1);
    const googleStageId = new URL(googleRedirect.headers.get('location'), origin).searchParams.get('oauth_stage');
    assert.ok(googleStageId);
    assert.equal(googleRedirect.headers.getSetCookie?.().some((value) => value.startsWith(`${google.cookieHeader.split('=', 1)[0]}=`)), true);

    async function install(stageId, expectedRevision, expectedDisplayName, expectedEmail) {
      const stageStatus = await (await fetch(`${origin}/api/oauth/stages/${stageId}`, { headers: authHeaders })).json();
      assert.equal(stageStatus.stage.status, 'verified');
      assert.deepEqual(stageStatus.verifiedAccount, { displayName: expectedDisplayName, email: expectedEmail,
        requestedCapabilities: ['mail.read'], capabilities: ['mail.read'] });
      assert.deepEqual(Object.keys(stageStatus.verifiedAccount).sort(), ['capabilities', 'displayName', 'email', 'requestedCapabilities']);
      const commandId = randomUUID();
      const response = await fetch(`${origin}/api/workspace/commands`, { method: 'POST', headers: { ...authHeaders, Origin: origin,
        'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: { kind: 'accounts.installOAuth', stageId },
        commandId, expectedPrivacyEpoch: 0, expectedRevision, schemaVersion: 1 }) });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.receipt.kind, 'accounts.installOAuth');
      return result;
    }
    await install(googleStageId, expectedRevision, 'Google Fixture', 'google@example.test');
    let snapshotResponse = await fetch(`${origin}/api/workspace/snapshot`, { headers: authHeaders });
    let snapshot = await snapshotResponse.json();
    expectedRevision = snapshot.revision;
    assert.equal(snapshot.state.accounts.length, 1);
    assert.equal(snapshot.state.accounts[0].identity.subject, 'google-subject');
    assert.equal(snapshot.state.accounts[0].authStatus, 'connected');
    const consumedInspection = await (await fetch(`${origin}/api/oauth/stages/${googleStageId}`, { headers: authHeaders })).json();
    assert.equal(consumedInspection.stage.status, 'consumed');
    assert.equal('verifiedAccount' in consumedInspection, false);

    const microsoft = await start('microsoft', expectedRevision);
    const microsoftState = microsoft.authorizationUrl.searchParams.get('state');
    const microsoftCallback = await fetch(`${origin}/api/oauth/microsoft/callback?code=synthetic-ms-code&state=${microsoftState}`, {
      redirect: 'manual', headers: { Cookie: microsoft.cookieHeader } });
    assert.equal(microsoftCallback.status, 303);
    const microsoftStageId = new URL(microsoftCallback.headers.get('location'), origin).searchParams.get('oauth_stage');
    assert.ok(microsoftStageId);
    await install(microsoftStageId, expectedRevision, 'Microsoft Fixture', 'ms@example.test');
    snapshotResponse = await fetch(`${origin}/api/workspace/snapshot`, { headers: authHeaders });
    snapshot = await snapshotResponse.json();
    assert.equal(snapshot.state.accounts.length, 2);
    const msAccount = snapshot.state.accounts.find((account) => account.provider === 'microsoft');
    assert.equal(msAccount.identity.subject, 'ms-subject');
    assert.equal(msAccount.identity.resourceUserId, 'graph-user-not-oid');
    assert.equal(msAccount.authStatus, 'connected');
    assert.equal(oidc.calls.some((call) => call.method === 'POST' && String(call.body).includes('synthetic-google-secret')), true);
    assert.equal(oidc.calls.some((call) => call.method === 'POST' && String(call.body).includes('synthetic-microsoft-secret')), true);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('explicit OAuth restart supersedes only the named pending start and stale callback clears only its own cookie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-restart-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  let host;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: state });
    try { await foundation.auth.enrollOwner(PASSWORD, state()); } finally { foundation.close(); }
    const oidc = await oidcHarness();
    oidc.active.set('provider', 'google');
    const owner = createNodeProviderResponseLifetimeOwner({ fetcher: oidc.fetcher, createId: randomUUID });
    const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: origin, registrations: [{ registrationId: 'google', provider: 'google',
      clientId: 'google-client', clientSecret: 'synthetic-google-secret' }], responseLifetime: owner.withResponseLifetimeFor('oauth') });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
      createRuntime: createCloudApplicationRuntimeFactory({ workspacePortsFor: () => closedPorts(), oauth: { provider: adapter, responseLifetimeOwner: owner, config } }) });
    const auth = await login(origin);
    const unavailable = await fetch(`${origin}/api/oauth/availability`, { headers: { Cookie: auth.session } });
    assert.equal(unavailable.status, 200);
    assert.deepEqual(await unavailable.json(), { google: true, microsoft: false });
    const visibleSnapshot = await (await fetch(`${origin}/api/workspace/snapshot`, { headers: { Cookie: auth.session } })).json();
    const startRequest = async (startAttemptId, restartOfStartAttemptId) => fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: {
      Cookie: auth.session, Origin: origin, 'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId,
      requestedCapabilities: ['mail.read'], expectedRevision: visibleSnapshot.revision, expectedPrivacyEpoch: 0,
      ...(restartOfStartAttemptId ? { restartOfStartAttemptId } : {}) }) });
    const firstId = randomUUID();
    const discoveryGate = oidc.gateDiscovery('google');
    const firstPromise = startRequest(firstId);
    await discoveryGate.entered.promise;
    const restartWhileBuilding = await startRequest(randomUUID(), firstId);
    assert.equal(restartWhileBuilding.status, 409);
    discoveryGate.release.resolve();
    const first = await firstPromise;
    assert.equal(first.status, 201, await first.clone().text());
    const firstBody = await first.json();
    const oldName = `__Host-still_oauth_google_${firstId}`;
    const oldCookie = cookie(first, oldName);
    const oldState = new URL(firstBody.authorizationUrl).searchParams.get('state');
    const noExplicitRestart = await startRequest(randomUUID());
    assert.equal(noExplicitRestart.status, 409);
    const secondId = randomUUID();
    const second = await startRequest(secondId, firstId);
    assert.equal(second.status, 201, await second.clone().text());
    const secondBody = await second.json();
    const newName = `__Host-still_oauth_google_${secondId}`;
    const newCookie = cookie(second, newName);
    assert.ok(newCookie);
    assert.notEqual(newCookie, oldCookie);
    const oldCallback = await fetch(`${origin}/api/oauth/google/callback?code=stale-code&state=${oldState}`, { redirect: 'manual', headers: { Cookie: oldCookie } });
    assert.equal(oldCallback.status, 303, await oldCallback.clone().text());
    const cleared = oldCallback.headers.getSetCookie?.() ?? [];
    assert.equal(cleared.some((value) => value.startsWith(`${oldName}=`) && value.includes('Max-Age=0')), true);
    assert.equal(cleared.some((value) => value.startsWith(`${newName}=`)), false);
    const current = await fetch(`${origin}/api/oauth/google/starts/${secondId}`, { headers: { Cookie: auth.session } });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).status, 'authorization_pending');
    assert.equal(oidc.tokenCount(), 0);
    const logout = await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { Cookie: auth.session, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 200);
    const secondState = new URL(secondBody.authorizationUrl).searchParams.get('state');
    const revokedCallback = await fetch(`${origin}/api/oauth/google/callback?code=should-not-exchange&state=${secondState}`,
      { redirect: 'manual', headers: { Cookie: newCookie } });
    assert.equal(revokedCallback.status, 303);
    assert.equal(oidc.tokenCount(), 0);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('production runtime starts without OAuth registrations and reports both providers disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-disabled-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key') }, { staticRoot, allowLocalHttp: true });
  let host;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: state });
    try { await foundation.auth.enrollOwner(PASSWORD, state()); } finally { foundation.close(); }
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
      createRuntime: createProductionApplicationRuntimeFactory(config, { fetcher: async () => { throw new Error('unexpected provider call'); } }) });
    const auth = await login(origin);
    const response = await fetch(`${origin}/api/oauth/availability`, { headers: { Cookie: auth.session } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { google: false, microsoft: false });
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('an uncertain exchange requires the exact prior attempt before an explicit fresh flow and never replays old code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-unknown-restart-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  let host;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: state });
    try { await foundation.auth.enrollOwner(PASSWORD, state()); } finally { foundation.close(); }
    const oidc = await oidcHarness();
    oidc.active.set('provider', 'google');
    const owner = createNodeProviderResponseLifetimeOwner({ fetcher: oidc.fetcher, createId: randomUUID });
    const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: origin, registrations: [{ registrationId: 'google', provider: 'google',
      clientId: 'google-client', clientSecret: 'synthetic-google-secret' }], responseLifetime: owner.withResponseLifetimeFor('oauth') });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
      createRuntime: createCloudApplicationRuntimeFactory({ workspacePortsFor: () => closedPorts(), oauth: { provider: adapter, responseLifetimeOwner: owner, config } }) });
    const auth = await login(origin);
    const headers = { Cookie: auth.session };
    const visibleSnapshot = await (await fetch(`${origin}/api/workspace/snapshot`, { headers })).json();
    async function start(startAttemptId, restartOfStartAttemptId) {
      const response = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { ...headers, Origin: origin,
        'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId,
        requestedCapabilities: ['mail.read'], expectedRevision: visibleSnapshot.revision, expectedPrivacyEpoch: 0,
        ...(restartOfStartAttemptId ? { restartOfStartAttemptId } : {}) }) });
      return response;
    }
    const oldId = randomUUID();
    const oldStart = await start(oldId);
    assert.equal(oldStart.status, 201);
    const oldBody = await oldStart.json();
    const oldCookie = cookie(oldStart, `__Host-still_oauth_google_${oldId}`);
    const oldState = new URL(oldBody.authorizationUrl).searchParams.get('state');
    oidc.active.set('google', { nonce: new URL(oldBody.authorizationUrl).searchParams.get('nonce'),
      scopes: new URL(oldBody.authorizationUrl).searchParams.get('scope') });
    oidc.failNextTokenExchange();
    const callback = await fetch(`${origin}/api/oauth/google/callback?code=uncertain-code&state=${oldState}`,
      { redirect: 'manual', headers: { Cookie: oldCookie } });
    assert.equal(callback.status, 303);
    assert.equal(oidc.tokenCount(), 1);
    const oldStatus = await fetch(`${origin}/api/oauth/google/starts/${oldId}`, { headers });
    assert.equal((await oldStatus.json()).status, 'inspect_required');
    const unrelated = await start(randomUUID());
    assert.equal(unrelated.status, 409);
    const nextId = randomUUID();
    const explicitRestart = await start(nextId, oldId);
    assert.equal(explicitRestart.status, 201, await explicitRestart.clone().text());
    const nextBody = await explicitRestart.json();
    assert.ok(nextBody.authorizationUrl);
    assert.equal(oidc.tokenCount(), 1, 'the old provider code is never replayed');
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('opaque reconnect IDs and identity-less configured placeholders are preserved through explicit install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-opaque-reconnect-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const placeholderId = 'google-placeholder:配置-東京';
  const initialState = () => ({ ...state(), accounts: [{ id: placeholderId, provider: 'google', displayName: 'Google', email: '',
    connected: false, authStatus: 'configured', connectionGeneration: 0 }] });
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  let host;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: initialState });
    try { await foundation.auth.enrollOwner(PASSWORD, initialState()); } finally { foundation.close(); }
    const oidc = await oidcHarness();
    oidc.active.set('provider', 'google');
    const owner = createNodeProviderResponseLifetimeOwner({ fetcher: oidc.fetcher, createId: randomUUID });
    const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: origin, registrations: [{ registrationId: 'google', provider: 'google',
      clientId: 'google-client', clientSecret: 'synthetic-google-secret' }], responseLifetime: owner.withResponseLifetimeFor('oauth') });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: initialState },
      createRuntime: createCloudApplicationRuntimeFactory({ workspacePortsFor: () => closedPorts(), oauth: { provider: adapter, responseLifetimeOwner: owner, config } }) });
    const auth = await login(origin);
    const headers = { Cookie: auth.session };
    const snapshot = await (await fetch(`${origin}/api/workspace/snapshot`, { headers })).json();
    const startId = randomUUID();
    const started = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { ...headers, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId: startId,
      requestedCapabilities: ['mail.read'], reconnectAccountId: placeholderId, expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 }) });
    assert.equal(started.status, 201, await started.clone().text());
    const startBody = await started.json();
    const authorizationUrl = new URL(startBody.authorizationUrl);
    const stateValue = authorizationUrl.searchParams.get('state');
    oidc.active.set('google', { nonce: authorizationUrl.searchParams.get('nonce'), scopes: authorizationUrl.searchParams.get('scope') });
    const oauthCookie = cookie(started, `__Host-still_oauth_google_${startId}`);
    const callback = await fetch(`${origin}/api/oauth/google/callback?code=synthetic-placeholder-code&state=${stateValue}`,
      { redirect: 'manual', headers: { Cookie: oauthCookie } });
    assert.equal(callback.status, 303);
    const stageId = new URL(callback.headers.get('location'), origin).searchParams.get('oauth_stage');
    const preview = await (await fetch(`${origin}/api/oauth/stages/${stageId}`, { headers })).json();
    assert.deepEqual(preview.verifiedAccount, { displayName: 'Google Fixture', email: 'google@example.test',
      requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], reconnectAccountId: placeholderId });
    const install = await fetch(`${origin}/api/workspace/commands`, { method: 'POST', headers: { ...headers, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: { kind: 'accounts.installOAuth', stageId },
      commandId: randomUUID(), expectedPrivacyEpoch: 0, expectedRevision: snapshot.revision, schemaVersion: 1 }) });
    assert.equal(install.status, 200, await install.clone().text());
    const after = await (await fetch(`${origin}/api/workspace/snapshot`, { headers })).json();
    assert.equal(after.state.accounts.length, 1);
    assert.equal(after.state.accounts[0].id, placeholderId);
    assert.equal(after.state.accounts[0].identity.subject, 'google-subject');
    assert.equal(after.state.accounts[0].authStatus, 'connected');
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('session revocation during callback discovery prevents the first token POST', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-revoke-during-discovery-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  let host; let testKernel;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: state });
    try { await foundation.auth.enrollOwner(PASSWORD, state()); } finally { foundation.close(); }
    const oidc = await oidcHarness();
    oidc.active.set('provider', 'google');
    const owner = createNodeProviderResponseLifetimeOwner({ fetcher: oidc.fetcher, createId: randomUUID });
    const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: origin, registrations: [{ registrationId: 'google', provider: 'google',
      clientId: 'google-client', clientSecret: 'synthetic-google-secret' }], responseLifetime: owner.withResponseLifetimeFor('oauth') });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
      createRuntime: createCloudApplicationRuntimeFactory({ workspacePortsFor: (_context, _vault, kernel) => { testKernel = kernel; return closedPorts(); },
        oauth: { provider: adapter, responseLifetimeOwner: owner, config } }) });
    const auth = await login(origin);
    const headers = { Cookie: auth.session };
    const snapshot = await (await fetch(`${origin}/api/workspace/snapshot`, { headers })).json();
    const startId = randomUUID();
    const started = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { ...headers, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId: startId,
      requestedCapabilities: ['mail.read'], expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 }) });
    assert.equal(started.status, 201);
    const startBody = await started.json();
    const authorizationUrl = new URL(startBody.authorizationUrl);
    const callbackState = authorizationUrl.searchParams.get('state');
    oidc.active.set('google', { nonce: authorizationUrl.searchParams.get('nonce'), scopes: authorizationUrl.searchParams.get('scope') });
    const gate = oidc.gateDiscovery('google');
    const callbackPromise = fetch(`${origin}/api/oauth/google/callback?code=must-not-post&state=${callbackState}`,
      { redirect: 'manual', headers: { Cookie: cookie(started, `__Host-still_oauth_google_${startId}`) } });
    await gate.entered.promise;
    const logout = await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { ...headers, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 200);
    gate.release.resolve();
    const callback = await callbackPromise;
    assert.equal(callback.status, 303);
    assert.equal(oidc.tokenCount(), 0);
    assert.equal(testKernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM oauth_install_stages WHERE stage_id=?')
      .get(startBody.status.attemptId).status), 'inspect_required');
    const replacementSession = await login(origin);
    const replacementInspection = await fetch(`${origin}/api/oauth/stages/${startBody.status.attemptId}`,
      { headers: { Cookie: replacementSession.session } });
    assert.notEqual(replacementInspection.status, 200, 'a replacement session cannot inspect the original session-bound stage');
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('privacy epoch change during callback discovery prevents the first token POST', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-epoch-during-discovery-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  let host; let testKernel;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: state });
    try { await foundation.auth.enrollOwner(PASSWORD, state()); } finally { foundation.close(); }
    const oidc = await oidcHarness();
    oidc.active.set('provider', 'google');
    const owner = createNodeProviderResponseLifetimeOwner({ fetcher: oidc.fetcher, createId: randomUUID });
    const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: origin, registrations: [{ registrationId: 'google', provider: 'google',
      clientId: 'google-client', clientSecret: 'synthetic-google-secret' }], responseLifetime: owner.withResponseLifetimeFor('oauth') });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
      createRuntime: createCloudApplicationRuntimeFactory({ workspacePortsFor: (_context, _vault, kernel) => { testKernel = kernel; return closedPorts(); },
        oauth: { provider: adapter, responseLifetimeOwner: owner, config } }) });
    const auth = await login(origin);
    const headers = { Cookie: auth.session };
    const snapshot = await (await fetch(`${origin}/api/workspace/snapshot`, { headers })).json();
    const startId = randomUUID();
    const started = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { ...headers, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId: startId,
      requestedCapabilities: ['mail.read'], expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 }) });
    assert.equal(started.status, 201);
    const startBody = await started.json();
    const authorizationUrl = new URL(startBody.authorizationUrl);
    oidc.active.set('google', { nonce: authorizationUrl.searchParams.get('nonce'), scopes: authorizationUrl.searchParams.get('scope') });
    const gate = oidc.gateDiscovery('google');
    const callbackPromise = fetch(`${origin}/api/oauth/google/callback?code=must-not-post-after-erase&state=${authorizationUrl.searchParams.get('state')}`,
      { redirect: 'manual', headers: { Cookie: cookie(started, `__Host-still_oauth_google_${startId}`) } });
    await gate.entered.promise;
    testKernel.withTrustedDatabaseTransaction((db) => {
      db.prepare('UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=(SELECT id FROM workspaces LIMIT 1)').run();
    });
    gate.release.resolve();
    const callback = await callbackPromise;
    assert.equal(callback.status, 503);
    assert.equal(oidc.tokenCount(), 0);
  } finally {
    try { testKernel?.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE workspaces SET privacy_epoch=0').run()); } catch {}
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('expired builder metadata is terminal and an expired claimed stage can restart without a status read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-expired-restart-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  let host; let testKernel;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: state });
    try { await foundation.auth.enrollOwner(PASSWORD, state()); } finally { foundation.close(); }
    const oidc = await oidcHarness();
    oidc.active.set('provider', 'google');
    const owner = createNodeProviderResponseLifetimeOwner({ fetcher: oidc.fetcher, createId: randomUUID });
    const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: origin, registrations: [{ registrationId: 'google', provider: 'google',
      clientId: 'google-client', clientSecret: 'synthetic-google-secret' }], responseLifetime: owner.withResponseLifetimeFor('oauth') });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
      createRuntime: createCloudApplicationRuntimeFactory({ workspacePortsFor: (_context, _vault, kernel) => { testKernel = kernel; return closedPorts(); },
        oauth: { provider: adapter, responseLifetimeOwner: owner, config } }) });
    const auth = await login(origin);
    const headers = { Cookie: auth.session };
    const snapshot = await (await fetch(`${origin}/api/workspace/snapshot`, { headers })).json();
    async function start(startId, restartOfStartAttemptId) {
      return fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { ...headers, Origin: origin,
        'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId: startId,
        ...(restartOfStartAttemptId ? { restartOfStartAttemptId } : {}), requestedCapabilities: ['mail.read'],
        expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 }) });
    }
    const builderGate = oidc.gateDiscovery('google');
    const builderId = randomUUID();
    const builderPromise = start(builderId);
    await builderGate.entered.promise;
    const builderRow = testKernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT stage_id FROM oauth_connection_starts WHERE start_attempt_id=?')
      .get(builderId));
    const expiredAt = Date.now() - 1;
    const createdAt = expiredAt - 1000;
    testKernel.withTrustedDatabaseTransaction((db) => {
      db.prepare('UPDATE oauth_install_stages SET created_at=?,expires_at=? WHERE stage_id=?').run(createdAt, expiredAt, builderRow.stage_id);
      db.prepare('UPDATE oauth_connection_starts SET created_at=?,expires_at=? WHERE start_attempt_id=?').run(createdAt, expiredAt, builderId);
    });
    const builderStatus = await fetch(`${origin}/api/oauth/google/starts/${builderId}`, { headers });
    assert.equal((await builderStatus.json()).status, 'expired');
    const expiredBuilderInspection = await (await fetch(`${origin}/api/oauth/stages/${builderRow.stage_id}`, { headers })).json();
    assert.equal(expiredBuilderInspection.stage.status, 'expired');
    assert.equal('verifiedAccount' in expiredBuilderInspection, false);
    builderGate.release.resolve();
    const expiredBuilder = await builderPromise;
    assert.equal(expiredBuilder.status, 409);
    assert.equal(oidc.tokenCount(), 0);

    const oldId = randomUUID();
    const oldStart = await start(oldId);
    assert.equal(oldStart.status, 201);
    const oldStartRow = testKernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT stage_id FROM oauth_connection_starts WHERE start_attempt_id=?')
      .get(oldId));
    const claimExpiredAt = Date.now() - 1;
    testKernel.withTrustedDatabaseTransaction((db) => {
      db.prepare(`UPDATE oauth_install_stages SET status='exchange_claimed',claim_hash=?,created_at=?,expires_at=? WHERE stage_id=?`)
        .run('a'.repeat(64), claimExpiredAt - 1000, claimExpiredAt, oldStartRow.stage_id);
      db.prepare('UPDATE oauth_connection_starts SET created_at=?,expires_at=? WHERE start_attempt_id=?').run(claimExpiredAt - 1000, claimExpiredAt, oldId);
    });
    const freshId = randomUUID();
    const fresh = await start(freshId);
    assert.equal(fresh.status, 201, await fresh.clone().text());
    const expiredClaimInspection = await (await fetch(`${origin}/api/oauth/stages/${oldStartRow.stage_id}`, { headers })).json();
    assert.equal(expiredClaimInspection.stage.status, 'expired');
    assert.equal('verifiedAccount' in expiredClaimInspection, false);
    assert.equal(testKernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM oauth_install_stages WHERE stage_id=?')
      .get(oldStartRow.stage_id).status), 'expired');
    assert.equal(oidc.tokenCount(), 0, 'expired claimed stages are cleaned before any fresh flow; no old exchange is replayed');
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('corrupt verified payload inspection terminalizes safely and returns no provider data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'still-oauth-corrupt-preview-'));
  const staticRoot = staticFixture(root);
  const port = await freePort();
  const origin = `${ORIGIN}:${port}`;
  const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(root, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(root, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'google-client',
    STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  let host; let testKernel;
  try {
    const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: state });
    try { await foundation.auth.enrollOwner(PASSWORD, state()); } finally { foundation.close(); }
    const oidc = await oidcHarness();
    oidc.active.set('provider', 'google');
    const owner = createNodeProviderResponseLifetimeOwner({ fetcher: oidc.fetcher, createId: randomUUID });
    const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: origin, registrations: [{ registrationId: 'google', provider: 'google',
      clientId: 'google-client', clientSecret: 'synthetic-google-secret' }], responseLifetime: owner.withResponseLifetimeFor('oauth') });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
      createRuntime: createCloudApplicationRuntimeFactory({ workspacePortsFor: (_context, _vault, kernel) => { testKernel = kernel; return closedPorts(); },
        oauth: { provider: adapter, responseLifetimeOwner: owner, config } }) });
    const auth = await login(origin);
    const headers = { Cookie: auth.session };
    const snapshot = await (await fetch(`${origin}/api/workspace/snapshot`, { headers })).json();
    const startId = randomUUID();
    const started = await fetch(`${origin}/api/oauth/google/start`, { method: 'POST', headers: { ...headers, Origin: origin,
      'X-Still-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ startAttemptId: startId,
      requestedCapabilities: ['mail.read'], expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 }) });
    assert.equal(started.status, 201);
    const startBody = await started.json();
    const authorizationUrl = new URL(startBody.authorizationUrl);
    oidc.active.set('google', { nonce: authorizationUrl.searchParams.get('nonce'), scopes: authorizationUrl.searchParams.get('scope') });
    const callback = await fetch(`${origin}/api/oauth/google/callback?code=synthetic-corrupt-preview&state=${authorizationUrl.searchParams.get('state')}`,
      { redirect: 'manual', headers: { Cookie: cookie(started, `__Host-still_oauth_google_${startId}`) } });
    assert.equal(callback.status, 303);
    assert.equal(oidc.tokenCount(), 1);
    testKernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE oauth_install_stages SET ciphertext=? WHERE stage_id=?')
      .run(Buffer.from('corrupt-payload'), startBody.status.attemptId));
    const inspectionResponse = await fetch(`${origin}/api/oauth/stages/${startBody.status.attemptId}`, { headers });
    assert.equal(inspectionResponse.status, 200);
    const inspection = await inspectionResponse.json();
    assert.deepEqual(Object.keys(inspection), ['stage']);
    assert.equal(inspection.stage.status, 'inspect_required');
    assert.equal(JSON.stringify(inspection).includes('synthetic-google'), false);
    assert.equal(JSON.stringify(inspection).includes('google-subject'), false);
    assert.equal(oidc.tokenCount(), 1, 'stage inspection does not make another provider request');
    const persisted = testKernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status,ciphertext FROM oauth_install_stages WHERE stage_id=?')
      .get(startBody.status.attemptId));
    assert.equal(persisted.status, 'inspect_required');
    assert.equal(persisted.ciphertext, null);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
