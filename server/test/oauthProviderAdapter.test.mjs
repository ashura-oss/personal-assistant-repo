import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createServerOAuthProviderAdapter, OAuthProviderAdapterError } from '../dist/oauthProviderAdapter.js';
import { createNodeProviderResponseLifetimeOwner } from '../dist/providerResponseLifetime.node.mjs';

const GOOGLE = 'https://accounts.google.com';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const MS = 'https://login.microsoftonline.com/common/v2.0';
const MS_JWKS = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
const CLIENT_ID_GOOGLE = 'google-client-id';
const CLIENT_ID_MS = 'microsoft-client-id';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const STATE = 's'.repeat(43);
const NONCE = 'n'.repeat(43);
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = 'c'.repeat(43);
const ORIGIN = 'https://app.example.test';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function signingFixture(provider, claimsOverride = {}, options = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  if (provider === 'microsoft') jwk.issuer = options.keyIssuer ?? 'https://login.microsoftonline.com/{tenantid}/v2.0';
  const issuedAt = Math.floor(Date.now() / 1000);
  const defaultClaims = provider === 'google'
    ? { iss: GOOGLE, sub: 'google-subject-123', aud: CLIENT_ID_GOOGLE, iat: issuedAt, exp: issuedAt + 600,
      nonce: NONCE, email: 'person@example.test', email_verified: true, name: 'Google Person' }
    : { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, sub: 'ms-subject-123', aud: CLIENT_ID_MS,
      iat: issuedAt, exp: issuedAt + 600, nonce: NONCE, tid: TENANT, name: 'Microsoft Person' };
  const token = await new SignJWT({ ...defaultClaims, ...claimsOverride }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
  return { jwks: { keys: [jwk] }, token };
}

function discoveryDocument(provider) {
  return provider === 'google'
    ? { issuer: GOOGLE, authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: GOOGLE_JWKS,
      userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'] }
    : { issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
      authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', jwks_uri: MS_JWKS,
      userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo',
      response_types_supported: ['code'], subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'] };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function harness(provider, { claims = {}, keyIssuer, scope, refreshToken = 'fresh-refresh-token', userinfoSub,
  graphId = 'graph-user-id', signalFetch, ownership } = {}) {
  const fixture = await signingFixture(provider, claims, { keyIssuer });
  const requestedScope = provider === 'google'
    ? 'openid profile email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly'
    : 'openid profile email offline_access User.Read Mail.Read Calendars.Read';
  const actualScope = scope ?? requestedScope;
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input.toString());
    calls.push({ url: url.href, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (signalFetch) return signalFetch(url, init);
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return jsonResponse(discoveryDocument(provider));
    if (url.href === (provider === 'google' ? GOOGLE_JWKS : MS_JWKS)) return jsonResponse(fixture.jwks);
    if (url.pathname.endsWith('/token')) return jsonResponse({ access_token: 'opaque-access-token', refresh_token: refreshToken,
      expires_in: 3600, scope: actualScope, token_type: 'Bearer', id_token: fixture.token });
    if (provider === 'google' && url.hostname === 'openidconnect.googleapis.com') return jsonResponse({
      sub: userinfoSub ?? (claims.sub ?? 'google-subject-123'), name: 'Verified Google User', email: 'profile@example.test',
    });
    if (provider === 'microsoft' && url.href === 'https://graph.microsoft.com/oidc/userinfo') return jsonResponse({ sub: userinfoSub ?? claims.sub ?? 'ms-subject-123' });
    if (provider === 'microsoft' && url.href === 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName') {
      assert.match(init.headers.authorization, /^Bearer opaque-access-token$/);
      return jsonResponse({ id: graphId, displayName: 'Graph Person', mail: null, userPrincipalName: 'account@example.test' });
    }
    throw new Error(`Unexpected synthetic request: ${url.href}`);
  };
  const registration = { registrationId: `${provider}-registration`, provider, clientId: provider === 'google' ? CLIENT_ID_GOOGLE : CLIENT_ID_MS,
    clientSecret: 'synthetic-client-secret' };
  let ownerId = 1;
  const responseLifetimeOwner = createNodeProviderResponseLifetimeOwner({ fetcher,
    createId: () => `00000000-0000-4000-8000-${String(ownerId++).padStart(12, '0')}` });
  const responseLifetime = responseLifetimeOwner.withResponseLifetimeFor('oauth');
  const adapter = createServerOAuthProviderAdapter({ canonicalOrigin: ORIGIN, registrations: [registration], responseLifetime,
    withProviderOwnership: ownership });
  const callbackPath = provider === 'google' ? '/api/oauth/google/callback' : '/api/oauth/microsoft/callback';
  const request = { callbackUrl: `${ORIGIN}${callbackPath}?code=synthetic-code&state=${STATE}`, state: STATE, nonce: NONCE,
    pkceVerifier: VERIFIER, requestedCapabilities: ['mail.read', 'calendar.read'] };
  return { adapter, registration, request, calls, fixture, responseLifetimeOwner };
}

test('Google authorization uses fixed callback, requested scopes, state, nonce, and S256 PKCE', async () => {
  const h = await harness('google');
  const url = await h.adapter.buildAuthorizationUrl(h.registration.registrationId, {
    state: STATE, nonce: NONCE, codeChallenge: CHALLENGE, requestedCapabilities: ['mail.read', 'calendar.read'],
  });
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/api/oauth/google/callback`);
  assert.equal(url.searchParams.get('state'), STATE);
  assert.equal(url.searchParams.get('nonce'), NONCE);
  assert.equal(url.searchParams.get('code_challenge'), CHALLENGE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.match(url.searchParams.get('scope'), /gmail\.readonly/);
  assert.match(url.searchParams.get('scope'), /calendar\.readonly/);
});

test('Microsoft read-only authorization requests no write scopes', async () => {
  const h = await harness('microsoft');
  const url = await h.adapter.buildAuthorizationUrl(h.registration.registrationId, {
    state: STATE, nonce: NONCE, codeChallenge: CHALLENGE, requestedCapabilities: ['mail.read', 'calendar.read'],
  });
  const scopes = new Set(url.searchParams.get('scope').split(/\s+/));
  assert.ok(scopes.has('Mail.Read'));
  assert.ok(scopes.has('Calendars.Read'));
  assert.equal(scopes.has('Mail.ReadWrite'), false);
  assert.equal(scopes.has('Calendars.ReadWrite'), false);
});

test('Microsoft authorization requests write scopes only when write capabilities are selected', async () => {
  const h = await harness('microsoft');
  const url = await h.adapter.buildAuthorizationUrl(h.registration.registrationId, {
    state: STATE, nonce: NONCE, codeChallenge: CHALLENGE, requestedCapabilities: ['mail.draft', 'calendar.read', 'calendar.write'],
  });
  const scopes = new Set(url.searchParams.get('scope').split(/\s+/));
  assert.ok(scopes.has('Mail.ReadWrite'));
  assert.ok(scopes.has('Calendars.ReadWrite'));
  assert.equal(scopes.has('Mail.Send'), false);
});

test('Google exchange returns verified identity, only verified email, fresh refresh token, and actual granted capabilities', async () => {
  const h = await harness('google');
  const result = await h.adapter.exchangeVerified(h.registration.registrationId, h.request);
  assert.equal(result.identity.subject, 'google-subject-123');
  assert.equal(result.identity.issuer, GOOGLE);
  assert.equal(result.email, 'person@example.test');
  assert.equal(result.displayName, 'Verified Google User');
  assert.deepEqual(result.capabilities, ['mail.read', 'calendar.read']);
  assert.equal(result.refreshToken, 'fresh-refresh-token');
  assert.ok(result.expiresAt > Date.now());
  assert.equal(h.calls.some((call) => call.url.includes('/userinfo')), true);
});

test('Google does not treat an unverified email claim as verified account email', async () => {
  const h = await harness('google', { claims: { email_verified: false } });
  const result = await h.adapter.exchangeVerified(h.registration.registrationId, h.request);
  assert.equal('email' in result, false);
});

test('Google rejects wrong nonce, audience, and a userinfo subject mismatch', async (t) => {
  for (const [name, claims, userinfoSub] of [
    ['nonce', { nonce: 'x'.repeat(43) }, undefined],
    ['audience', { aud: 'other-client' }, undefined],
    ['userinfo subject', {}, 'different-user'],
  ]) {
    await t.test(name, async () => {
      const h = await harness('google', { claims, userinfoSub });
      await assert.rejects(h.adapter.exchangeVerified(h.registration.registrationId, h.request), OAuthProviderAdapterError);
    });
  }
});

test('Microsoft exchange validates tenant-scoped signed issuer and uses Graph me identity without equating oid', async () => {
  const h = await harness('microsoft');
  const result = await h.adapter.exchangeVerified(h.registration.registrationId, h.request);
  assert.deepEqual(result.identity, { providerNamespace: 'microsoft', clientId: CLIENT_ID_MS, subject: 'ms-subject-123',
    issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, tenantId: TENANT, resourceUserId: 'graph-user-id' });
  assert.equal(result.displayName, 'Graph Person');
  assert.equal(result.email, 'account@example.test');
  const graph = h.calls.find((call) => call.url.startsWith('https://graph.microsoft.com/v1.0/me'));
  assert.equal(graph.url, 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName');
  assert.match(graph.headers.authorization, /^Bearer opaque-access-token$/);
});

test('Microsoft personal-account issuer template is tenant-bound while Graph resource ID remains independent', async () => {
  const personalTenant = '11111111-2222-4333-8444-555555555555';
  const h = await harness('microsoft', { claims: { tid: personalTenant,
    iss: `https://login.microsoftonline.com/${personalTenant}/v2.0`, sub: 'personal-account-subject' }, graphId: 'different-graph-id' });
  const result = await h.adapter.exchangeVerified(h.registration.registrationId, h.request);
  assert.equal(result.identity.subject, 'personal-account-subject');
  assert.equal(result.identity.tenantId, personalTenant);
  assert.equal(result.identity.resourceUserId, 'different-graph-id');
});

test('Microsoft rejects a userinfo subject that does not match the signed ID token subject', async () => {
  const h = await harness('microsoft', { userinfoSub: 'wrong-subject' });
  await assert.rejects(h.adapter.exchangeVerified(h.registration.registrationId, h.request), OAuthProviderAdapterError);
});

test('Microsoft requires the actual User.Read grant before calling userinfo or Graph', async () => {
  const h = await harness('microsoft', { scope: 'openid profile email offline_access Mail.Read Calendars.Read' });
  await assert.rejects(h.adapter.exchangeVerified(h.registration.registrationId, h.request), OAuthProviderAdapterError);
  assert.equal(h.calls.some((call) => call.url === 'https://graph.microsoft.com/oidc/userinfo'), false);
  assert.equal(h.calls.some((call) => call.url.startsWith('https://graph.microsoft.com/v1.0/me')), false);
});

test('Microsoft rejects invalid tenant, issuer, nonce, audience, and untrusted signing-key issuer', async (t) => {
  const cases = [
    ['tenant', { tid: 'not-a-guid', iss: 'https://login.microsoftonline.com/not-a-guid/v2.0' }, undefined],
    ['issuer', { iss: 'https://attacker.example.test/tenant/v2.0' }, undefined],
    ['nonce', { nonce: 'z'.repeat(43) }, undefined],
    ['audience', { aud: 'wrong-client' }, undefined],
    ['key issuer', {}, 'https://login.microsoftonline.com/ffffffff-1111-4111-8111-ffffffffffff/v2.0'],
  ];
  for (const [name, claims, keyIssuer] of cases) {
    await t.test(name, async () => {
      const h = await harness('microsoft', { claims, keyIssuer });
      await assert.rejects(h.adapter.exchangeVerified(h.registration.registrationId, h.request), OAuthProviderAdapterError);
    });
  }
});

test('Microsoft accepts tenant-template signing key issuer and returned scopes intersect selected capabilities', async () => {
  const h = await harness('microsoft', { scope: 'openid profile email offline_access User.Read Mail.ReadWrite' });
  const result = await h.adapter.exchangeVerified(h.registration.registrationId, h.request);
  assert.deepEqual(result.capabilities, ['mail.read']);
  assert.deepEqual(result.grantedScopes, ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.ReadWrite']);
});

test('missing fresh refresh token fails closed and denied scopes do not become capabilities', async (t) => {
  await t.test('missing refresh token', async () => {
    const h = await harness('google', { refreshToken: '' });
    await assert.rejects(h.adapter.exchangeVerified(h.registration.registrationId, h.request), OAuthProviderAdapterError);
  });
  await t.test('denied scopes', async () => {
    const h = await harness('google', { scope: 'openid profile email https://www.googleapis.com/auth/userinfo.profile' });
    const result = await h.adapter.exchangeVerified(h.registration.registrationId, h.request);
    assert.deepEqual(result.capabilities, []);
  });
});

test('callback origin, provider path, fragment, and registration are fixed before network access', async (t) => {
  const cases = [
    'https://evil.example.test/api/oauth/google/callback?code=x&state=' + STATE,
    `${ORIGIN}/api/oauth/microsoft/callback?code=x&state=${STATE}`,
    `${ORIGIN}/api/oauth/google/callback?code=x&state=${STATE}#fragment`,
    `https://user@${new URL(ORIGIN).host}/api/oauth/google/callback?code=x&state=${STATE}`,
  ];
  for (const callbackUrl of cases) {
    await t.test(callbackUrl, async () => {
      const h = await harness('google');
      await assert.rejects(h.adapter.exchangeVerified(h.registration.registrationId, { ...h.request, callbackUrl }),
        (error) => error instanceof OAuthProviderAdapterError && error.code === 'oauth_provider_invalid_input');
      assert.equal(h.calls.length, 0);
    });
  }
});

test('both public adapter methods sanitize synchronous and asynchronous ownership-port failures', async (t) => {
  const methods = [
    ['buildAuthorizationUrl', (h) => h.adapter.buildAuthorizationUrl(h.registration.registrationId, {
      state: STATE, nonce: NONCE, codeChallenge: CHALLENGE, requestedCapabilities: ['mail.read'],
    })],
    ['exchangeVerified', (h) => h.adapter.exchangeVerified(h.registration.registrationId, h.request)],
  ];
  const failures = [
    ['synchronous throw', () => { throw new Error('synthetic ownership detail'); }],
    ['asynchronous rejection', async () => { throw new Error('synthetic ownership detail'); }],
  ];
  for (const [methodName, invoke] of methods) for (const [failureName, ownership] of failures) {
    await t.test(`${methodName}: ${failureName}`, async () => {
      const h = await harness('google', { ownership });
      await assert.rejects(invoke(h), (error) => {
        assert.ok(error instanceof OAuthProviderAdapterError);
        assert.equal(error.code, 'oauth_provider_failed');
        assert.equal(error.message, 'oauth_provider_failed');
        assert.equal(error.message.includes('synthetic'), false);
        return true;
      });
      assert.equal(h.calls.length, 0);
    });
  }
});

test('ownership ports preserve typed adapter cancellation errors', async (t) => {
  const methods = [
    ['buildAuthorizationUrl', (h) => h.adapter.buildAuthorizationUrl(h.registration.registrationId, {
      state: STATE, nonce: NONCE, codeChallenge: CHALLENGE, requestedCapabilities: [],
    })],
    ['exchangeVerified', (h) => h.adapter.exchangeVerified(h.registration.registrationId, h.request)],
  ];
  for (const [methodName, invoke] of methods) {
    await t.test(methodName, async () => {
      const h = await harness('google', { ownership: async () => { throw new OAuthProviderAdapterError('oauth_provider_cancelled'); } });
      await assert.rejects(invoke(h), (error) => error instanceof OAuthProviderAdapterError &&
        error.code === 'oauth_provider_cancelled' && error.message === 'oauth_provider_cancelled');
    });
  }
});

test('a hanging provider response body is aborted and the response owner drains after cleanup completes', async () => {
  let bodyCancelled = false;
  const controller = new AbortController();
  const neverEnding = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { bodyCancelled = true; },
  });
  const h = await harness('google', {
    signalFetch: async (_url, init) => {
      assert.ok(init.signal);
      return new Response(neverEnding, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const pending = h.adapter.exchangeVerified(h.registration.registrationId, { ...h.request, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof OAuthProviderAdapterError && error.code === 'oauth_provider_cancelled');
  assert.equal(bodyCancelled, true);
  await h.responseLifetimeOwner.drain();
  assert.deepEqual(h.responseLifetimeOwner.getPending(), []);
});

test('the real response owner retains a pending cancellation until it settles', async () => {
  let markCancelStarted;
  let finishCancel;
  const cancelStarted = new Promise((resolve) => { markCancelStarted = resolve; });
  const cancelGate = new Promise((resolve) => { finishCancel = resolve; });
  const controller = new AbortController();
  const neverEnding = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { markCancelStarted(); return cancelGate; },
  });
  const h = await harness('google', {
    signalFetch: async () => new Response(neverEnding, { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  let settled = false;
  const pending = h.adapter.exchangeVerified(h.registration.registrationId, { ...h.request, signal: controller.signal })
    .finally(() => { settled = true; });
  const rejectedPromptly = assert.rejects(pending,
    (error) => error instanceof OAuthProviderAdapterError && error.code === 'oauth_provider_cancelled');
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await cancelStarted;
  assert.equal(h.responseLifetimeOwner.getPending().length, 1);
  assert.equal(h.responseLifetimeOwner.getPending()[0]?.state, 'cancelling');
  const drain = h.responseLifetimeOwner.drain();
  let drained = false;
  void drain.then(() => { drained = true; }, () => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(drained, false);
  assert.equal(settled, true);
  finishCancel();
  await rejectedPromptly;
  await drain;
  assert.deepEqual(h.responseLifetimeOwner.getPending(), []);
});

test('a rejecting response cancellation stays visible in owner pending state and blocks drain', async () => {
  let cancelCalls = 0;
  const controller = new AbortController();
  const body = new ReadableStream({ pull() {}, cancel() { cancelCalls += 1; throw new Error('synthetic cancel failure'); } });
  const h = await harness('google', { signalFetch: async () => new Response(body, { status: 200 }) });
  const pending = h.adapter.exchangeVerified(h.registration.registrationId, { ...h.request, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof OAuthProviderAdapterError && error.code === 'oauth_provider_cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  const entries = h.responseLifetimeOwner.getPending();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.state, 'cleanup_failed');
  const id = entries[0].id;
  await assert.rejects(h.responseLifetimeOwner.drain(), /synthetic cancel failure/);
  await assert.rejects(h.responseLifetimeOwner.retryCleanup(id), /synthetic cancel failure/);
  assert.equal(cancelCalls, 1);
  assert.equal(h.responseLifetimeOwner.getPending()[0]?.id, id);
});

test('the response owner retains a fetch that ignores abort until the raw fetch settles', async () => {
  const fetchGate = deferred();
  const controller = new AbortController();
  const h = await harness('google', { signalFetch: async (_url, init) => {
    assert.ok(init.signal);
    return fetchGate.promise;
  } });
  const pending = h.adapter.exchangeVerified(h.registration.registrationId, { ...h.request, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof OAuthProviderAdapterError && error.code === 'oauth_provider_cancelled');
  assert.equal(h.responseLifetimeOwner.getPending().length, 1);
  const drain = h.responseLifetimeOwner.drain();
  let drained = false;
  void drain.then(() => { drained = true; }, () => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(drained, false);
  fetchGate.resolve(jsonResponse(discoveryDocument('google')));
  await drain;
  assert.deepEqual(h.responseLifetimeOwner.getPending(), []);
});
