import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { openServerFoundation } from '../../dist/bootstrap.js';
import { loadServerConfig } from '../../dist/config.js';
import { startApplicationHost } from '../../dist/applicationHost.js';
import { createInitialWorkspaceState } from '../../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../../dist/applicationHost.node.mjs';

const PASSWORD = 'closed application host fixture password';

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function state() {
  return createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
    openRouterModel: 'openai/gpt-6-luna:batch', openRouterReasoningEffort: 'low', llmRequestContractVersion: 1 });
}

function writeStaticFiles(directory) {
  const root = join(directory, 'public');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body><div id="root"></div></body></html>');
  writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(root, 'sw.js'), '');
  writeFileSync(join(root, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  return root;
}

function setCookie(response, name) {
  return (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith(`${name}=`))?.split(';', 1)[0] ?? '';
}
function request(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

export async function verifyLocalHttpReminderUnavailable(hostname) {
  const directory = mkdtempSync(join(tmpdir(), 'still-local-http-reminder-host-'));
  const staticRoot = writeStaticFiles(directory);
  const port = await freePort();
  const config = loadServerConfig({ STILL_ORIGIN: `http://${hostname}:${port}`,
    STILL_DATA_DIR: join(directory, 'private', 'data'), STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') },
  { staticRoot, allowLocalHttp: true });
  const initial = state();
  const enrollment = openServerFoundation(config, { initialWorkspaceSnapshot: state });
  try { await enrollment.auth.enrollOwner(PASSWORD, initial); }
  finally { enrollment.close(); }

  let host;
  let kernel;
  try {
    const productionFactory = createProductionApplicationRuntimeFactory(config, { fetcher: async () => {
      throw new Error('provider access is closed in this fixture');
    } });
    host = await startApplicationHost({ config, port, foundation: { initialWorkspaceSnapshot: state },
      createRuntime(context) { kernel = context.kernel; return productionFactory(context); } });

    assert.equal((await request(`${config.canonicalOrigin}/healthz`)).status, 200);
    const push = await request(`${config.canonicalOrigin}/api/web-push/status`);
    assert.equal(push.status, 503);
    assert.deepEqual(await push.json(), { error: 'web_push_requires_https' });

    const guest = await request(`${config.canonicalOrigin}/auth/session`);
    const guestDto = await guest.json();
    const login = await request(`${config.canonicalOrigin}/auth/login`, { method: 'POST', headers: {
      Origin: config.canonicalOrigin, Cookie: setCookie(guest, '__Host-still_preauth'),
      'X-Still-CSRF': guestDto.csrfToken, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(login.status, 200);
    const session = setCookie(login, '__Host-still_session');
    const loginDto = await login.json();
    const sendCommand = (envelope) => request(`${config.canonicalOrigin}/api/workspace/commands`, { method: 'POST', headers: {
      Origin: config.canonicalOrigin, Cookie: session, 'X-Still-CSRF': loginDto.csrfToken, 'Content-Type': 'application/json',
    }, body: JSON.stringify(envelope) });
    const readSnapshot = async () => {
      const response = await request(`${config.canonicalOrigin}/api/workspace/snapshot`, { headers: { Cookie: session } });
      assert.equal(response.status, 200);
      return response.json();
    };
    let snapshot = await readSnapshot();
    const payload = { title: 'Local reminder', body: 'Private note', dueAt: '2099-11-02T09:30:00.000Z',
      displayTimeZone: 'Asia/Singapore', privacyMode: 'private' };
    const create = await sendCommand({ schemaVersion: 1, commandId: randomUUID(), expectedRevision: snapshot.revision,
      expectedPrivacyEpoch: snapshot.privacyEpoch, command: { kind: 'reminders.createDraft', payload } });
    assert.equal(create.status, 200);
    const reminderId = (await create.json()).receipt.reminderId;
    snapshot = await readSnapshot();
    const approve = await sendCommand({ schemaVersion: 1, commandId: randomUUID(), expectedRevision: snapshot.revision,
      expectedPrivacyEpoch: snapshot.privacyEpoch, command: { kind: 'reminders.approve', reminderId, expectedReminderRevision: 1 } });
    assert.equal(approve.status, 200);

    const beforeSave = await readSnapshot();
    const beforeCounts = kernel.withTrustedDatabaseTransaction((db) => ({
      policies: db.prepare('SELECT COUNT(*) AS count FROM background_policy_heads').get().count,
      occurrences: db.prepare('SELECT COUNT(*) AS count FROM background_occurrences').get().count,
    }));
    const save = await sendCommand({ schemaVersion: 1, commandId: randomUUID(), expectedRevision: beforeSave.revision,
      expectedPrivacyEpoch: beforeSave.privacyEpoch, command: { kind: 'reminders.serverSave', reminderId,
        expectedReminderRevision: 1, deviceSelection: 'all_current' } });
    assert.equal(save.status, 503);
    assert.deepEqual(await save.json(), { error: 'web_push_requires_https' });
    const afterSave = await readSnapshot();
    assert.equal(afterSave.revision, beforeSave.revision);
    assert.equal(afterSave.state.reminders.records.find((record) => record.id === reminderId).status, 'approved');
    const afterCounts = kernel.withTrustedDatabaseTransaction((db) => ({
      policies: db.prepare('SELECT COUNT(*) AS count FROM background_policy_heads').get().count,
      occurrences: db.prepare('SELECT COUNT(*) AS count FROM background_occurrences').get().count,
    }));
    assert.deepEqual(afterCounts, beforeCounts);
  } finally {
    try { if (host) await host.close(); }
    finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
}
