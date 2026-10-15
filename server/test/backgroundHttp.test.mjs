import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { parseWorkspaceCommandReceipt } from '../dist/workspaceCommands.node.mjs';

const PASSWORD = 'background HTTP fixture password';
const CLIENT_ID = 'test-google-client';
const ACCOUNT_ID = 'google:account-1';
const CONNECTION_IDENTITY = Object.freeze({ providerNamespace: 'google', clientId: CLIENT_ID, subject: 'subject-1',
  issuer: 'https://accounts.google.com' });

function state() {
  const value = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
    openRouterModel: 'openai/gpt-6-luna:batch', openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
  value.accounts.push({ id: ACCOUNT_ID, provider: 'google', displayName: 'Fixture mailbox', email: 'fixture@example.test',
    connected: true, authStatus: 'connected', identity: { ...CONNECTION_IDENTITY }, tokenRef: 'fixture-oauth-token',
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

test('browser account-sync consent reaches the real controller gateway and exposes its exact public command receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-http-'));
  let host;
  let ownedKernel;
  let providerReads = 0;
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
      STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret' },
      { staticRoot: publicRoot, allowLocalHttp: true });
    const enrollment = openServerFoundationInternal(config, { initialWorkspaceSnapshot: state });
    try {
      const enrolled = await enrollment.foundation.auth.enrollOwner(PASSWORD, state());
      const { kernel, vault } = enrollment.privateContext;
      const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, Date.now() + 3_600_000);
      kernel.recordAccountGeneration(actor, ACCOUNT_ID, 1);
      const bindings = new ServerOAuthTokenBindings(kernel);
      const token = JSON.stringify({ accessToken: 'fixture-access-token', expiresAt: Date.now() + 3_600_000,
        identity: { ...CONNECTION_IDENTITY } });
      kernel.withOwnedTransaction(actor, 0, (context) => {
        const credential = vault.setSecretWithinTransaction(context, { type: 'account', accountId: ACCOUNT_ID,
          expectedAccountGeneration: 1 }, 'googleOAuth', 0, token);
        bindings.writeExistingCredentialBindingWithinTransaction(context, { tokenRef: 'fixture-oauth-token', accountId: ACCOUNT_ID,
          provider: 'google', accountGeneration: 1, credentialGeneration: credential.generation });
      });
      enrollment.privateContext.startup.beginRecovery();
      enrollment.privateContext.startup.seal();
    } finally { enrollment.foundation.close(); }

    const fetcher = async (input) => {
      const url = String(input);
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages')) {
        providerReads += 1;
        return new Response(JSON.stringify({ messages: [], resultSizeEstimate: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fixture request: ${new URL(url).origin}`);
    };
    const productionFactory = createProductionApplicationRuntimeFactory(config, { fetcher });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
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
    const unauthenticatedRead = await fetch(`${policiesUrl}?expectedPrivacyEpoch=0`);
    assert.equal(unauthenticatedRead.status, 401);
    const unauthenticatedWrite = await fetch(policiesUrl, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}' });
    assert.equal(unauthenticatedWrite.status, 401);
    const wrongOrigin = await fetch(policiesUrl, { method: 'POST', headers: { ...headers, Origin: 'https://wrong.example.test' }, body: '{}' });
    assert.equal(wrongOrigin.status, 403);
    const wrongCsrf = await fetch(policiesUrl, { method: 'POST', headers: { ...headers, 'X-Still-CSRF': 'A'.repeat(43) }, body: '{}' });
    assert.equal(wrongCsrf.status, 403);
    const unknownQuery = await fetch(`${policiesUrl}?expectedPrivacyEpoch=0&unexpected=1`, { headers: { Cookie: session } });
    assert.equal(unknownQuery.status, 400);
    const duplicateQuery = await fetch(`${policiesUrl}?expectedPrivacyEpoch=0&expectedPrivacyEpoch=0`, { headers: { Cookie: session } });
    assert.equal(duplicateQuery.status, 400);
    const saveEnvelope = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0,
      enabled: true, specification: { kind: 'account_sync', accounts: [{ accountId: ACCOUNT_ID, expectedConnectionGeneration: 1 }],
        resources: ['mail'], intervalMinutes: 1 } };
    const unknownPayload = await fetch(policiesUrl, { method: 'POST', headers,
      body: JSON.stringify({ ...saveEnvelope, unrecognized: true }) });
    assert.equal(unknownPayload.status, 400);
    const response = await fetch(policiesUrl, { method: 'POST', headers, body: JSON.stringify(saveEnvelope) });
    assert.equal(response.status, 200, await response.clone().text());
    const savedReceipt = await response.json();
    const duplicateSave = await fetch(policiesUrl, { method: 'POST', headers, body: JSON.stringify(saveEnvelope) });
    assert.equal(duplicateSave.status, 200, await duplicateSave.clone().text());
    assert.deepEqual(await duplicateSave.json(), savedReceipt, 'retry after a lost response returns the exact receipt without creating another policy revision');

    let commandId;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const history = await fetch(`${origin}/api/workspace/command-history`, { headers: { Cookie: session } });
      assert.equal(history.status, 200);
      const page = await history.json();
      const entry = page.entries.find((item) => item.kind === 'accounts.refreshMail');
      if (entry) { commandId = entry.commandId; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const debug = commandId ? undefined : ownedKernel.withTrustedDatabaseTransaction((db) => ({
      policyHeads: db.prepare('SELECT status,current_revision FROM background_policy_heads').all(),
      occurrences: db.prepare('SELECT status,count(*) AS count FROM background_occurrences GROUP BY status').all(),
      targets: db.prepare('SELECT status,count(*) AS count FROM background_occurrence_targets GROUP BY status').all(),
      attempts: db.prepare('SELECT status,result_code,count(*) AS count FROM background_occurrence_attempts GROUP BY status,result_code').all(),
      journal: db.prepare('SELECT command_kind,status,count(*) AS count FROM async_command_journal GROUP BY command_kind,status').all(),
    }));
    assert.ok(commandId, `the scheduled work should use the existing command journal; sanitized durable state: ${JSON.stringify(debug)}`);
    const inspected = await fetch(`${origin}/api/workspace/commands/${commandId}`, { headers: { Cookie: session } });
    assert.equal(inspected.status, 200, await inspected.clone().text());
    const result = await inspected.json();
    assert.equal(result.status, 'finished');
    assert.deepEqual(parseWorkspaceCommandReceipt(result.receipt, { commandId, kind: 'accounts.refreshMail', objectId: ACCOUNT_ID,
      accountId: ACCOUNT_ID, connectionGeneration: 1 }), result.receipt);
    assert.equal(result.receipt.lane, 'head');
    assert.equal(result.receipt.laneStatus, 'complete');
    assert.equal(providerReads, 1);
  } finally {
    if (host) await host.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
