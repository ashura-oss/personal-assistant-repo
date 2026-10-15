import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { startApplicationHost } from '../dist/applicationHost.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { ServerOAuthTokenBindings } from '../dist/oauthTokenBindings.js';

const PASSWORD = 'background refresh pause fixture password';
const CLIENT_ID = 'background-refresh-pause-client';
const ACCOUNT_ID = 'google:refresh-pause';
const IDENTITY = Object.freeze({ providerNamespace: 'google', clientId: CLIENT_ID, subject: 'refresh-pause-subject',
  issuer: 'https://accounts.google.com' });

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function waitFor(promise, label, milliseconds = 9_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function snapshot() {
  const value = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
    openRouterModel: 'openai/gpt-6-luna:batch', openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
  value.accounts.push({ id: ACCOUNT_ID, provider: 'google', displayName: 'Refresh pause fixture', email: 'pause@example.test',
    connected: true, authStatus: 'connected', identity: { ...IDENTITY }, tokenRef: 'refresh-pause-token',
    grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], capabilities: ['mail.read'], capabilityLimits: ['mail.read'],
    connectionGeneration: 1, syncStatus: 'idle' });
  return value;
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function cookie(response, name) {
  return (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith(`${name}=`))?.split(';', 1)[0] ?? '';
}

test('pausing during OAuth refresh prevents subsequent identity and mailbox provider reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-refresh-pause-'));
  let host;
  let ownedKernel;
  const refreshEntered = deferred();
  const releaseRefresh = deferred();
  let identityReads = 0;
  let mailboxReads = 0;
  try {
    const publicRoot = join(directory, 'public');
    const appBundle = '/_expo/static/js/web/index-abcdef0123456789.js';
    const registration = '/pwa-register-0123456789abcdef.js';
    mkdirSync(join(publicRoot, '_expo', 'static', 'js', 'web'), { recursive: true });
    mkdirSync(join(publicRoot, 'assets'), { recursive: true });
    writeFileSync(join(publicRoot, 'index.html'), `<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/assets/still-icon.png"><script src="${registration}" defer></script></head><body><div id="root"></div><script src="${appBundle}" defer></script></body></html>`);
    writeFileSync(join(publicRoot, 'manifest.webmanifest'), '{"name":"Still"}');
    writeFileSync(join(publicRoot, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
    writeFileSync(join(publicRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(publicRoot, registration.slice(1)), '/* registration fixture */');
    writeFileSync(join(publicRoot, appBundle.slice(1)), '/* app fixture */');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: join(directory, 'private', 'data'),
      STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: CLIENT_ID,
      STILL_GOOGLE_CLIENT_SECRET: 'synthetic-refresh-pause-client-secret' }, { staticRoot: publicRoot, allowLocalHttp: true });
    const initial = snapshot();
    const enrollment = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => initial });
    try {
      const enrolled = await enrollment.foundation.auth.enrollOwner(PASSWORD, initial);
      const { kernel, vault } = enrollment.privateContext;
      const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, Date.now() + 3_600_000);
      kernel.recordAccountGeneration(actor, ACCOUNT_ID, 1);
      kernel.withOwnedTransaction(actor, 0, (context) => {
        const credential = vault.setSecretWithinTransaction(context, { type: 'account', accountId: ACCOUNT_ID,
          expectedAccountGeneration: 1 }, 'googleOAuth', 0, JSON.stringify({ accessToken: 'synthetic-expired-access',
          refreshToken: 'synthetic-refresh-token', expiresAt: Date.now() - 1_000, identity: { ...IDENTITY } }));
        new ServerOAuthTokenBindings(kernel).writeExistingCredentialBindingWithinTransaction(context, { tokenRef: 'refresh-pause-token',
          accountId: ACCOUNT_ID, provider: 'google', accountGeneration: 1, credentialGeneration: credential.generation });
      });
      enrollment.privateContext.startup.beginRecovery();
      enrollment.privateContext.startup.seal();
    } finally { enrollment.foundation.close(); }

    const fetcher = async (input) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        refreshEntered.resolve();
        await releaseRefresh.promise;
        return new Response(JSON.stringify({ access_token: 'synthetic-refreshed-access', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        identityReads += 1;
        return new Response(JSON.stringify({ sub: IDENTITY.subject }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages')) {
        mailboxReads += 1;
        return new Response(JSON.stringify({ messages: [], resultSizeEstimate: 0 }), { status: 200,
          headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected refresh-pause fixture request: ${new URL(url).origin}`);
    };
    const productionFactory = createProductionApplicationRuntimeFactory(config, { fetcher });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: snapshot },
      createRuntime: (context) => { ownedKernel = context.kernel; return productionFactory(context); } });

    const guest = await fetch(`${origin}/auth/session`);
    const preauth = cookie(guest, '__Host-still_preauth');
    const guestDto = await guest.json();
    const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { Origin: origin, Cookie: preauth,
      'X-Still-CSRF': guestDto.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(login.status, 200, await login.clone().text());
    const session = cookie(login, '__Host-still_session');
    const authDto = await login.json();
    const headers = { Origin: origin, Cookie: session, 'X-Still-CSRF': authDto.csrfToken, 'Content-Type': 'application/json' };
    const policiesUrl = `${origin}/api/workspace/background/policies`;
    const policyId = randomUUID();
    const save = await fetch(policiesUrl, { method: 'POST', headers, body: JSON.stringify({ commandId: randomUUID(),
      expectedPrivacyEpoch: 0, policyId, expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'account_sync', accounts: [{ accountId: ACCOUNT_ID, expectedConnectionGeneration: 1 }],
        resources: ['mail'], intervalMinutes: 1 } }) });
    assert.equal(save.status, 200, await save.clone().text());
    const receipt = await save.json();
    await waitFor(refreshEntered.promise, 'OAuth refresh did not reach the synthetic barrier');
    assert.equal(identityReads, 0);
    assert.equal(mailboxReads, 0);
    const paused = await fetch(`${origin}/api/workspace/background/policies/pause`, { method: 'POST', headers,
      body: JSON.stringify({ commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId,
        expectedPolicyRevision: receipt.policyRevision }) });
    assert.equal(paused.status, 200, await paused.clone().text());
    assert.equal((await paused.json()).status, 'paused');
    releaseRefresh.resolve();

    const deadline = Date.now() + 8_000;
    let attempts = [];
    while (Date.now() < deadline) {
      attempts = ownedKernel.withTrustedDatabaseTransaction((db) => db.prepare(
        'SELECT status,result_code FROM background_occurrence_attempts ORDER BY claimed_at').all());
      if (attempts.some((item) => item.status === 'inspect_required')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(attempts.some((item) => item.status === 'inspect_required'), `paused refresh should hold the claim: ${JSON.stringify(attempts)}`);
    assert.equal(identityReads, 0, 'the post-refresh identity request must be fenced after pause');
    assert.equal(mailboxReads, 0, 'the mailbox read must be fenced after pause');
  } finally {
    releaseRefresh.resolve();
    if (host) await host.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
