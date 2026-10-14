import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { request as httpRequest, Server } from 'node:http';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundation } from '../dist/bootstrap.js';
import { ApplicationHostStartError, ApplicationHostStartupCleanupError, startApplicationHost } from '../dist/applicationHost.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createCloudApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';

const PASSWORD = 'closed application host fixture password';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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

function fixtureState() {
  const state = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
    openRouterModel: 'openai/gpt-6-luna:batch', openRouterReasoningEffort: 'low', llmRequestContractVersion: 1 });
  state.tasks.push({ id: 'legacy task id', title: 'Host lifecycle task', body: '', status: 'open', createdAt: '2026-10-14T00:00:00.000Z',
    importOrigin: { kind: 'backup_import', archiveId: randomUUID(), sourceTaskId: 'legacy task id' } });
  return state;
}

function closedPorts() {
  const unavailable = async () => 'unavailable';
  return {
    disposeUnattached() {},
    providers: {
      speech: { async transcribe() { throw new Error('provider access is closed in this fixture'); }, async releaseUploadLease() {}, disposeMemory() {} },
      openAi: { async prepare() { throw new Error('provider access is closed in this fixture'); },
        async analyze() { throw new Error('provider access is closed in this fixture'); },
        async generateReply() { throw new Error('provider access is closed in this fixture'); } },
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

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-application-host-'));
  const staticRoot = staticFixture(directory);
  const portPromise = freePort();
  return { directory, staticRoot, portPromise };
}

function configFor(f, port) {
  return loadServerConfig({ STILL_ORIGIN: `http://127.0.0.1:${port}`,
    STILL_DATA_DIR: join(f.directory, 'private', 'data'), STILL_VAULT_KEY_FILE: join(f.directory, 'private', 'keys', 'root.key') },
  { staticRoot: f.staticRoot, allowLocalHttp: true });
}

function cookie(response, name) {
  const values = response.headers.getSetCookie?.() ?? [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(';', 1)[0] ?? '';
}

async function enroll(config) {
  const foundation = openServerFoundation(config, { initialWorkspaceSnapshot: fixtureState });
  try { await foundation.auth.enrollOwner(PASSWORD, fixtureState()); }
  finally { foundation.close(); }
}

test('host serves authenticated workspace and credential APIs through required per-workspace runtime composition', async () => {
  const f = setup();
  let host;
  try {
    const port = await f.portPromise;
    const config = configFor(f, port);
    await enroll(config);
    let factoryCalls = 0;
    const createRuntime = createCloudApplicationRuntimeFactory({ workspacePortsFor(context, vault) {
      factoryCalls += 1;
      assert.ok(context.identity.workspaceId);
      assert.ok(context.runtimeSessionToken);
      assert.ok(vault);
      return closedPorts();
    } });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState }, createRuntime });
    assert.deepEqual(Object.keys(host).sort(), ['close', 'readStatus', 'server']);
    assert.deepEqual(Object.keys(host.server).sort(), ['address', 'isListening']);
    assert.equal('auth' in host, false);
    assert.equal('kernel' in host, false);
    assert.deepEqual(host.readStatus(), { enrolled: true });
    const origin = config.canonicalOrigin;
    const guest = await fetch(`${origin}/auth/session`);
    const preauth = cookie(guest, '__Host-still_preauth');
    const guestDto = await guest.json();
    const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { Origin: origin,
      Cookie: preauth, 'X-Still-CSRF': guestDto.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(login.status, 200);
    const session = cookie(login, '__Host-still_session');
    const authDto = await login.json();
    assert.equal(JSON.stringify(authDto).includes(session), false);
    const cookieHeader = session;
    const snapshotResponse = await fetch(`${origin}/api/workspace/snapshot`, { headers: { Cookie: cookieHeader } });
    assert.equal(snapshotResponse.status, 200, await snapshotResponse.clone().text());
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.state.tasks[0].id, 'legacy task id');
    const credentials = await fetch(`${origin}/api/credentials`, { headers: { Cookie: cookieHeader } });
    assert.equal(credentials.status, 200);
    assert.equal((await credentials.json()).credentials.openrouter.configured, false);

    const commandId = randomUUID();
    const command = { schemaVersion: 1, commandId, expectedRevision: snapshot.revision,
      expectedPrivacyEpoch: snapshot.privacyEpoch, command: { kind: 'tasks.complete', taskId: 'legacy task id' } };
    const completed = await fetch(`${origin}/api/workspace/commands`, { method: 'POST', headers: { Origin: origin,
      Cookie: cookieHeader, 'X-Still-CSRF': authDto.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).snapshot.state.tasks[0].status, 'completed');
    assert.equal(factoryCalls, 1);
    await host.close();
    host = undefined;
  } finally {
    if (host) await host.close().catch(() => {});
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('an owned listener with no accepted requests drains and closes cleanly', async () => {
  const f = setup();
  let host;
  let drained = 0;
  try {
    const port = await f.portPromise;
    const config = configFor(f, port);
    await enroll(config);
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState },
      createRuntime() { return { workspaceApi: { async getSnapshot() { return {}; }, async refreshSnapshot() { return {}; },
        async dispatchCommand() { return {}; }, inspectCommand() { return {}; } }, stopAdmission() {},
      async drainAndDispose() { drained += 1; } }; } });
    assert.equal(host.server.isListening(), true);
    assert.deepEqual(host.readStatus(), { enrolled: true });
    await host.close();
    assert.equal(host.server.isListening(), false);
    assert.equal(drained, 1);
    host = undefined;
  } finally {
    if (host) await host.close().catch(() => {});
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('listener shutdown and runtime drain start together and retain a pre-close HTTP request', async () => {
  const f = setup();
  let host;
  const started = deferred();
  const resultGate = deferred();
  const requestFinished = deferred();
  let calls = 0;
  try {
    const port = await f.portPromise;
    const config = configFor(f, port);
    await enroll(config);
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState },
      createRuntime() {
        return { workspaceApi: { async getSnapshot() {
          calls += 1;
          started.resolve();
          try { return await resultGate.promise; }
          finally { requestFinished.resolve(); }
        }, async refreshSnapshot() { return {}; }, async dispatchCommand() { return {}; }, inspectCommand() { return {}; } },
        stopAdmission() {}, async drainAndDispose() { await requestFinished.promise; } };
      } });
    const origin = config.canonicalOrigin;
    const guest = await fetch(`${origin}/auth/session`);
    const preauth = cookie(guest, '__Host-still_preauth');
    const guestDto = await guest.json();
    const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { Origin: origin,
      Cookie: preauth, 'X-Still-CSRF': guestDto.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const session = cookie(login, '__Host-still_session');
    const responsePromise = fetch(`${origin}/api/workspace/snapshot`, { headers: { Cookie: session } });
    await started.promise;
    const closing = host.close();
    assert.equal(host.server.isListening(), false);
    await assert.rejects(fetch(`${origin}/api/workspace/snapshot`, { headers: { Cookie: session } }));
    assert.equal(calls, 1);
    resultGate.resolve({ schemaVersion: 1, workspaceId: randomUUID(), privacyEpoch: 0, revision: 0, state: {} });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    await closing;
    host = undefined;
  } finally {
    resultGate.resolve({});
    if (host) await host.close().catch(() => {});
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('listener close waits for an accepted handler after its client disconnects', async () => {
  const f = setup();
  let host;
  const started = deferred();
  const resultGate = deferred();
  let kernel;
  let disposed = 0;
  const originalClose = Server.prototype.close;
  const closeMock = test.mock.method(Server.prototype, 'close', function(callback) {
    return originalClose.call(this, (error) => callback?.(error ?? new Error('synthetic close callback error')));
  });
  try {
    const port = await f.portPromise;
    const config = configFor(f, port);
    await enroll(config);
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState },
      createRuntime(context) {
        kernel = context.kernel;
        return { workspaceApi: { async getSnapshot() { started.resolve(); return resultGate.promise; },
          async refreshSnapshot() { return {}; }, async dispatchCommand() { return {}; }, inspectCommand() { return {}; } },
        stopAdmission() {}, async drainAndDispose() { disposed += 1; } };
      } });
    const origin = config.canonicalOrigin;
    const guest = await fetch(`${origin}/auth/session`);
    const guestDto = await guest.json();
    const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { Origin: origin,
      Cookie: cookie(guest, '__Host-still_preauth'), 'X-Still-CSRF': guestDto.csrfToken,
      'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const session = cookie(login, '__Host-still_session');
    const address = host.server.address();
    assert.ok(address && typeof address === 'object');
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/workspace/snapshot', method: 'GET',
      headers: { Cookie: session } });
    request.on('error', () => undefined);
    request.end();
    await started.promise;
    request.destroy();

    await assert.rejects(host.close(), /synthetic close callback error/);
    assert.equal(host.server.isListening(), false);
    assert.equal(disposed, 1);
    assert.ok(kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));

    let closeSettled = false;
    const closing = host.close().finally(() => { closeSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);
    assert.ok(kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
    resultGate.resolve({ schemaVersion: 1, workspaceId: randomUUID(), privacyEpoch: 0, revision: 0, state: {} });
    await closing;
    host = undefined;
    assert.equal(closeSettled, true);
    assert.throws(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
  } finally {
    closeMock.mock.restore();
    resultGate.resolve({});
    if (host) await host.close().catch(() => {});
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('host close shares concurrent attempts and preserves foundation authority after a failed runtime drain for explicit retry', async () => {
  const f = setup();
  let host;
  let kernel;
  let drains = 0;
  let stops = 0;
  try {
    const port = await f.portPromise;
    const config = configFor(f, port);
    await enroll(config);
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState },
      createRuntime(context) {
        kernel = context.kernel;
        return { workspaceApi: { async getSnapshot() { return {}; }, async refreshSnapshot() { return {}; },
          async dispatchCommand() { return {}; }, inspectCommand() { return {}; } },
        stopAdmission() { stops += 1; }, async drainAndDispose() { drains += 1; if (drains === 1) throw new Error('private drain detail'); } };
      } });
    const first = host.close();
    const concurrent = host.close();
    assert.equal(first, concurrent);
    await assert.rejects(first, /private drain detail/);
    assert.equal(stops, 1);
    assert.equal(drains, 1);
    assert.deepEqual(host.readStatus(), { enrolled: true });
    assert.ok(kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
    await host.close();
    assert.equal(drains, 2);
    assert.throws(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
    host = undefined;
  } finally {
    if (host) await host.close().catch(() => {});
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('runtime admission-stop failure is asynchronous, closes HTTP admission, and retries before draining', async () => {
  const f = setup();
  let host;
  let kernel;
  let stops = 0;
  let drains = 0;
  try {
    const port = await f.portPromise;
    const config = configFor(f, port);
    await enroll(config);
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState },
      createRuntime(context) {
        kernel = context.kernel;
        return { workspaceApi: { async getSnapshot() { return {}; }, async refreshSnapshot() { return {}; },
          async dispatchCommand() { return {}; }, inspectCommand() { return {}; } },
        stopAdmission() { stops += 1; if (stops === 1) throw new Error('private stop detail'); },
        async drainAndDispose() { drains += 1; } };
      } });
    const first = host.close();
    await assert.rejects(first, /private stop detail/);
    assert.equal(host.server.isListening(), false);
    assert.equal(drains, 0);
    assert.deepEqual(host.readStatus(), { enrolled: true });
    assert.ok(kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
    await host.close();
    assert.equal(stops, 2);
    assert.equal(drains, 1);
    assert.throws(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
    host = undefined;
  } finally {
    if (host) await host.close().catch(() => {});
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('actor revocation failure retains the private owner and retries only unfinished shutdown stages', async () => {
  const f = setup();
  let host;
  let kernel;
  let runtimeSessionFor;
  let disposeCalls = 0;
  let revokeCalls = 0;
  try {
    const port = await f.portPromise;
    const config = configFor(f, port);
    await enroll(config);
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState },
      createRuntime(context) {
        kernel = context.kernel;
        runtimeSessionFor = context.runtimeSessionFor;
        const revoke = kernel.revokeSession.bind(kernel);
        kernel.revokeSession = (token) => { revokeCalls += 1; if (revokeCalls === 1) throw new Error('private revoke detail'); return revoke(token); };
        return { workspaceApi: { async getSnapshot(admission) { return {}; }, async refreshSnapshot() { return {}; },
          async dispatchCommand() { return {}; }, inspectCommand() { return {}; } },
        stopAdmission() {}, async drainAndDispose() { disposeCalls += 1; } };
      } });
    const response = await fetch(`${config.canonicalOrigin}/api/workspace/snapshot`);
    assert.equal(response.status, 401);
    // Load a workspace through the real actor path before exercising revocation.
    const guest = await fetch(`${config.canonicalOrigin}/auth/session`);
    const preauth = cookie(guest, '__Host-still_preauth');
    const guestDto = await guest.json();
    const login = await fetch(`${config.canonicalOrigin}/auth/login`, { method: 'POST', headers: { Origin: config.canonicalOrigin,
      Cookie: preauth, 'X-Still-CSRF': guestDto.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const session = cookie(login, '__Host-still_session');
    runtimeSessionFor(kernel.getOwnedIdentity(session.slice(session.indexOf('=') + 1)));
    await assert.rejects(host.close(), /private revoke detail/);
    assert.equal(disposeCalls, 1);
    assert.ok(kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
    await host.close();
    assert.equal(disposeCalls, 1);
    assert.equal(revokeCalls, 2);
    host = undefined;
  } finally {
    if (host) await host.close().catch(() => {});
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('bind failure uses staged host cleanup and exposes a private retry capability if cleanup fails', async () => {
  const f = setup();
  const port = await f.portPromise;
  const config = configFor(f, port);
  await enroll(config);
  const blocker = createNetServer();
  await new Promise((resolve, reject) => blocker.listen(port, config.host, (error) => error ? reject(error) : resolve()));
  let kernel;
  let drains = 0;
  try {
    let startupError;
    try { await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState },
      createRuntime(context) {
        kernel = context.kernel;
        return { workspaceApi: { async getSnapshot() { return {}; }, async refreshSnapshot() { return {}; },
          async dispatchCommand() { return {}; }, inspectCommand() { return {}; } }, stopAdmission() {},
        async drainAndDispose() { drains += 1; if (drains === 1) throw new Error('private bind cleanup detail'); } };
      } }); } catch (error) { startupError = error; }
    assert.ok(startupError instanceof ApplicationHostStartupCleanupError);
    assert.equal(drains, 1);
    assert.ok(kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
    await startupError.retryClose();
    assert.equal(drains, 2);
    assert.throws(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
  } finally {
    await new Promise((resolve) => blocker.close(() => resolve()));
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('cloud runtime factory requires a real per-workspace ports factory', () => {
  assert.throws(() => createCloudApplicationRuntimeFactory(undefined), /application_workspace_ports_factory_required/);
  assert.throws(() => createCloudApplicationRuntimeFactory({ workspacePortsFor: null }), /application_workspace_ports_factory_required/);
});

test('startup failures with successful cleanup return only a fixed error', async () => {
  const f = setup();
  let kernel;
  try {
    const port = await f.portPromise;
    const config = configFor(f, port);
    await enroll(config);
    await assert.rejects(startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: fixtureState },
      async createRuntime(context) { kernel = context.kernel; throw new Error('secret startup detail'); } }),
    (error) => error instanceof ApplicationHostStartError &&
      !JSON.stringify({ message: error.message, name: error.name }).includes('secret startup detail'));
    assert.throws(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT 1').get()));
  } finally {
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
