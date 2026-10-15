import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundation, parseStillPort, startStillHttp, validatePhysicalWorkspaceSnapshot } from '../dist/bootstrap.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { randomUUID } from 'node:crypto';

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function writeSyntheticStaticFixture(staticRoot) {
  const bundle = '/_expo/static/js/web/index-abcdef0123456789.js';
  const registration = '/pwa-register-0123456789abcdef.js';
  mkdirSync(join(staticRoot, '_expo', 'static', 'js', 'web'), { recursive: true });
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), `<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"><script src="${registration}" defer></script></head><body><div id="root"></div><script src="${bundle}" defer></script></body></html>`);
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(staticRoot, registration.slice(1)), '/* registration */');
  writeFileSync(join(staticRoot, bundle.slice(1)), '/* public app bundle */');
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-bootstrap-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(staticRoot);
  const env = {
    STILL_ORIGIN: 'https://still.example.test',
    STILL_DATA_DIR: join(directory, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'vault-root.key'),
  };
  return { directory, config: loadServerConfig(env, { staticRoot }), env };
}

test('physical initial snapshots are JSON object roots only', () => {
  assert.doesNotThrow(() => validatePhysicalWorkspaceSnapshot({ notes: [] }));
  for (const value of [null, [], 'state', 3, new Date()]) assert.throws(() => validatePhysicalWorkspaceSnapshot(value));
});

test('foundation claims vault writes across close and reopen and exposes status metadata only', async () => {
  const f = fixture();
  const snapshot = { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] };
  const password = 'bootstrap test password';
  const commandId = randomUUID();
  const body = '{"expectedGenerations":{"speech":0},"expectedPrivacyEpoch":0,"keys":{"speech":"bootstrap-vault-sentinel"}}';
  try {
    const first = openServerFoundation(f.config, { initialWorkspaceSnapshot: () => snapshot });
    assert.deepEqual(first.readStatus(), { enrolled: false });
    const enrolled = await first.auth.enrollOwner(password, snapshot);
    assert.match(enrolled.workspaceId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(first.readStatus(), { enrolled: true });
    assert.deepEqual(Object.keys(first.readStatus()), ['enrolled']);
    const challenge = first.auth.createLoginChallenge(f.config.canonicalOrigin);
    const login = await first.auth.login({ password, origin: f.config.canonicalOrigin,
      preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
    const firstReceipt = first.credentialCommands.put(login.sessionToken, commandId, body);
    assert.equal(firstReceipt.credentials.speech.configured, true);
    assert.equal(firstReceipt.credentials.speech.generation, 1);
    first.close();
    first.close();

    const reopened = openServerFoundation(f.config, { initialWorkspaceSnapshot: () => snapshot });
    assert.deepEqual(reopened.readStatus(), { enrolled: true });
    assert.deepEqual(reopened.credentialCommands.getMetadata(login.sessionToken), firstReceipt);
    assert.deepEqual(reopened.credentialCommands.inspect(login.sessionToken, commandId), { status: 'finished', metadata: firstReceipt });
    assert.deepEqual(reopened.credentialCommands.put(login.sessionToken, commandId, body), firstReceipt);
    reopened.close();

    unlinkSync(f.config.vaultKeyFile);
    assert.throws(() => openServerFoundation(f.config), (error) => error?.code === 'missing_key_existing_database');
  } finally {
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('failed auth construction releases the opened kernel for a later valid open', () => {
  const f = fixture();
  try {
    const invalid = { ...f.config, canonicalOrigin: 'https://bad.example.test/path' };
    assert.throws(() => openServerFoundation(invalid));
    const recovered = openServerFoundation(f.config, { initialWorkspaceSnapshot: () => ({ fresh: true }) });
    assert.deepEqual(recovered.readStatus(), { enrolled: false });
    recovered.close();
  } finally {
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('production enrollment snapshot comes from the pure bundled initial-state factory', async () => {
  const f = fixture();
  try {
    const foundation = openServerFoundation(f.config);
    const initial = foundation.initialWorkspaceSnapshot();
    assert.ok(initial && typeof initial === 'object' && !Array.isArray(initial));
    assert.ok(Array.isArray(initial.notes));
    assert.ok(Array.isArray(initial.tasks));
    assert.ok(initial.reminders && typeof initial.reminders === 'object');
    assert.deepEqual({ mode: initial.settings.mode, llmProvider: initial.settings.llmProvider,
      openRouterModel: initial.settings.openRouterModel, openRouterReasoningEffort: initial.settings.openRouterReasoningEffort,
      llmRequestContractVersion: initial.settings.llmRequestContractVersion }, {
      mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
      openRouterReasoningEffort: 'low', llmRequestContractVersion: 1,
    });
    assert.equal(initial.settings.speechEnabled, false);
    const next = foundation.initialWorkspaceSnapshot();
    assert.notEqual(next, initial);
    assert.notEqual(next.settings, initial.settings);
    assert.notEqual(next.notes, initial.notes);
    foundation.close();
  } finally {
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('the shared one-argument initial-state factory preserves its legacy defaults', () => {
  const initial = createInitialWorkspaceState(randomUUID);
  assert.equal(initial.settings.mode, 'preview');
  assert.equal(initial.settings.llmProvider, 'azure');
  assert.equal(initial.settings.speechEnabled, false);
});

test('start binds the real HTTP server over an allowlisted generated static fixture and drains on close', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-bootstrap-http-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(staticRoot);
  writeSyntheticStaticFixture(staticRoot);
  const port = await freePort();
  const config = loadServerConfig({ STILL_ORIGIN: `http://127.0.0.1:${port}`,
    STILL_DATA_DIR: join(directory, 'private', 'data'), STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') },
  { staticRoot, allowLocalHttp: true });
  const foundation = openServerFoundation(config);
  let started;
  try {
    started = await startStillHttp(config, foundation, port);
    const health = await fetch(`${config.canonicalOrigin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const shell = await fetch(config.canonicalOrigin);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /<div id="root"><\/div>/);
    await started.close();
    assert.equal(started.server.listening, false);
    assert.throws(() => foundation.readStatus());
  } finally {
    if (started?.server.listening) await started.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('HTTP construction failure closes the foundation', async () => {
  const f = fixture();
  let closed = 0;
  try {
    await assert.rejects(startStillHttp(f.config, { auth: {}, credentialCommands: {}, close() { closed += 1; } }, 8080));
    assert.equal(closed, 1);
  } finally {
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('HTTP close promise settles when foundation cleanup throws', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-bootstrap-close-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(staticRoot);
  writeSyntheticStaticFixture(staticRoot);
  const port = await freePort();
  const config = loadServerConfig({ STILL_ORIGIN: `http://127.0.0.1:${port}`,
    STILL_DATA_DIR: join(directory, 'private', 'data'), STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') },
  { staticRoot, allowLocalHttp: true });
  let closed = 0;
  const started = await startStillHttp(config, { auth: {}, credentialCommands: {}, close() {
    closed += 1;
    if (closed === 1) throw new Error('foundation-close-sentinel');
  } }, port);
  try {
    await assert.rejects(started.close(), /foundation-close-sentinel/);
    assert.equal(started.server.listening, false);
    assert.equal(closed, 1);
    await started.close();
    assert.equal(closed, 2);
    await started.close();
    assert.equal(closed, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('port parser accepts the default and bounded numeric ports only', () => {
  assert.equal(parseStillPort(undefined), 8080);
  assert.equal(parseStillPort('443'), 443);
  for (const value of ['', '0', '65536', '8080x', ' 8080', '1.5', '999999']) {
    assert.throws(() => parseStillPort(value), /invalid_port/);
  }
});

test('executable module import is inert and startup failures do not disclose error details', async () => {
  const { runStillServer } = await import('../scripts/still-server.mjs');
  const out = [];
  const errors = [];
  let opened = 0;
  assert.equal(await runStillServer(['unknown'], { writeOut: (value) => out.push(value), writeError: (value) => errors.push(value),
    openFoundation: () => { opened += 1; throw new Error('root-key-secret-detail'); } }), 2);
  assert.equal(opened, 0);
  assert.match(errors.join(''), /Usage:/);

  out.length = 0; errors.length = 0;
  assert.equal(await runStillServer(['start'], { parsePort: () => 8080, loadConfig: () => ({ canonicalOrigin: 'https://still.example.test' }),
    openFoundation: () => { opened += 1; throw new Error('root-key-secret-detail'); }, writeOut: (value) => out.push(value), writeError: (value) => errors.push(value),
    installSignalHandlers: false }), 1);
  assert.equal(opened, 1);
  assert.equal(out.join(''), '');
  assert.doesNotMatch(errors.join(''), /root-key-secret-detail/);

  out.length = 0; errors.length = 0;
  assert.equal(await runStillServer(['start'], { parsePort: () => 8080, loadConfig: () => ({ canonicalOrigin: 'https://still.example.test' }),
    openFoundation: () => ({ close() { throw new Error('private-cleanup-detail'); } }),
    startHttp: async () => { throw new Error('private-startup-detail'); },
    writeOut: (value) => out.push(value), writeError: (value) => errors.push(value), installSignalHandlers: false }), 1);
  assert.equal(out.join(''), '');
  assert.deepEqual(errors, ['still-server: startup failed and cleanup is incomplete; the retained owner can be retried in this process.\n']);
});
