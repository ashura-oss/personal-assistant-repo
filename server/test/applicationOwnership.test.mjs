import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { acquireApplicationOwnership } from '../dist/applicationOwnership.js';
import { loadServerConfig } from '../dist/config.js';
import { startApplicationHost } from '../dist/applicationHost.js';
import { openServerFoundation, startStillHttp } from '../dist/bootstrap.js';
import { createDurableKernel } from '../dist/kernel.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validateSnapshot = (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-app-owner-'));
  const databasePath = join(directory, 'data', 'still.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  return { directory, databasePath };
}

function cleanup(f) {
  try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  catch (error) { if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error; }
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function staticFixture(root) {
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(root, 'sw.js'), '');
  writeFileSync(join(root, 'manifest.webmanifest'), '{}');
  writeFileSync(join(root, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
}

function spawnOwner(databasePath, staticRoot, port, keyPath) {
  const applicationHostPath = JSON.stringify(pathToFileURL(join(SERVER_ROOT, 'dist', 'applicationHost.js')).href);
  const configPath = JSON.stringify(pathToFileURL(join(SERVER_ROOT, 'dist', 'config.js')).href);
  const code = `const {startApplicationHost}=await import(${applicationHostPath});const {loadServerConfig}=await import(${configPath});const config=loadServerConfig({STILL_ORIGIN:"http://127.0.0.1:${port}",STILL_DATA_DIR:${JSON.stringify(dirname(databasePath))},STILL_VAULT_KEY_FILE:${JSON.stringify(keyPath)}},{staticRoot:${JSON.stringify(staticRoot)},allowLocalHttp:true});await startApplicationHost({config,port:${port},createRuntime:()=>({workspaceApi:{},stopAdmission(){},async drainAndDispose(){}})});process.stdout.write("owner-ready\\n");setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: SERVER_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveChild, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`owner child timed out: ${stderr}`)); }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('owner-ready\n')) { clearTimeout(timer); resolveChild({ child, stderr: () => stderr }); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (codeValue) => {
      if (!stdout.includes('owner-ready\n')) { clearTimeout(timer); reject(new Error(`owner child exited early (${codeValue}): ${stderr}`)); }
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

test('persistent kernels contend through a durable sidecar while trusted in-process kernels may share one handle', () => {
  const f = fixture();
  let owner;
  let first;
  let second;
  try {
    owner = acquireApplicationOwnership(f.databasePath);
    first = createDurableKernel({ databasePath: f.databasePath, validateSnapshot, applicationOwnership: owner });
    second = createDurableKernel({ databasePath: f.databasePath, validateSnapshot, applicationOwnership: owner });
    assert.throws(() => acquireApplicationOwnership(f.databasePath), (error) => error?.code === 'application_owner_busy');
    const sidecar = owner.lockDatabasePath;
    const identity = statSync(sidecar);
    second.close(); second = undefined;
    first.close(); first = undefined;
    owner.release(); owner = undefined;
    assert.equal(statSync(sidecar).ino, identity.ino);
    assert.equal(statSync(sidecar).dev, identity.dev);
    const reopened = createDurableKernel({ databasePath: f.databasePath, validateSnapshot });
    reopened.close();
  } finally {
    second?.close(); first?.close(); owner?.release(); cleanup(f);
  }
});

test('a persistent kernel stops authorizing reads after its shared ownership handle is released', () => {
  const f = fixture();
  let owner;
  let kernel;
  try {
    owner = acquireApplicationOwnership(f.databasePath);
    kernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot, applicationOwnership: owner });
    const workspace = kernel.createWorkspace('2e3a8ad9-2e8c-4ef8-8442-b20ba9373ba2', {});
    owner.release();
    owner = undefined;
    assert.throws(() => kernel.getOwnedSnapshot('invalid-session'), (error) => error?.code === 'application_owner_path_unsafe');
    assert.throws(() => kernel.createWorkspace('2e3a8ad9-2e8c-4ef8-8442-b20ba9373ba2', {}),
      (error) => error?.code === 'application_owner_path_unsafe');
    assert.throws(() => kernel.createSession(workspace.workspaceId, '2e3a8ad9-2e8c-4ef8-8442-b20ba9373ba2', Date.now() + 60_000),
      (error) => error?.code === 'application_owner_path_unsafe');
    const replacement = createDurableKernel({ databasePath: f.databasePath, validateSnapshot });
    try {
      assert.throws(() => kernel.createWorkspace('2e3a8ad9-2e8c-4ef8-8442-b20ba9373ba2', {}),
        (error) => error?.code === 'application_owner_path_unsafe');
    } finally { replacement.close(); }
  } finally { kernel?.close(); owner?.release(); cleanup(f); }
});

test('child-process owner never expires; process death releases SQLite lock without deleting sidecar', async () => {
  const f = fixture();
  const staticRoot = join(f.directory, 'public');
  staticFixture(staticRoot);
  const keyPath = join(f.directory, 'keys', 'root.key');
  const firstPort = await freePort();
  let secondPort = await freePort();
  if (secondPort === firstPort) secondPort = await freePort();
  let child;
  try {
    const held = await spawnOwner(f.databasePath, staticRoot, firstPort, keyPath);
    child = held.child;
    const sidecar = `${f.databasePath}.owner.sqlite`;
    const before = statSync(sidecar);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_250));
    const competingConfig = loadServerConfig({ STILL_ORIGIN: `http://127.0.0.1:${secondPort}`, STILL_DATA_DIR: dirname(f.databasePath),
      STILL_VAULT_KEY_FILE: keyPath }, { staticRoot, allowLocalHttp: true });
    await assert.rejects(startApplicationHost({ config: competingConfig, port: secondPort,
      createRuntime: () => ({ workspaceApi: {}, stopAdmission() {}, async drainAndDispose() {} }) }),
    (error) => error?.code === 'application_owner_busy');
    assert.throws(() => createDurableKernel({ databasePath: f.databasePath, validateSnapshot }),
      (error) => error?.code === 'application_owner_busy');
    child.kill('SIGTERM');
    await waitForExit(child);
    child = undefined;
    const afterCrash = statSync(sidecar);
    assert.equal(afterCrash.ino, before.ino);
    assert.equal(afterCrash.dev, before.dev);
    const recovered = createDurableKernel({ databasePath: f.databasePath, validateSnapshot });
    recovered.close();
  } finally {
    if (child) { child.kill('SIGTERM'); await waitForExit(child); }
    cleanup(f);
  }
});

test('CLI status participates in ownership before key creation', async () => {
  const f = fixture();
  let owner;
  try {
    const keyPath = join(f.directory, 'keys', 'vault-root.key');
    owner = acquireApplicationOwnership(f.databasePath);
    const cli = spawn(process.execPath, [join(SERVER_ROOT, 'scripts', 'still-server.mjs'), 'status'], {
      cwd: SERVER_ROOT,
      env: { ...process.env, STILL_ORIGIN: 'https://still.example.test', STILL_DATA_DIR: dirname(f.databasePath), STILL_VAULT_KEY_FILE: keyPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    cli.stdout.setEncoding('utf8'); cli.stderr.setEncoding('utf8');
    cli.stdout.on('data', (chunk) => { stdout += chunk; });
    cli.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolveExit, reject) => {
      cli.once('error', reject);
      cli.once('exit', resolveExit);
    });
    assert.equal(code, 1, `${stdout}\n${stderr}`);
    assert.match(stderr, /operation_failed/);
    assert.equal(existsSync(keyPath), false, 'ownership rejection must happen before creating the vault key');
  } finally { owner?.release(); cleanup(f); }
});

test('foundation startup failure after ownership acquisition releases the guard safely', () => {
  const f = fixture();
  const staticRoot = join(f.directory, 'public');
  mkdirSync(staticRoot);
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{}');
  const config = loadServerConfig({ STILL_ORIGIN: 'https://still.example.test', STILL_DATA_DIR: dirname(f.databasePath),
    STILL_VAULT_KEY_FILE: join(f.directory, 'keys', 'missing.key') }, { staticRoot });
  let kernel;
  try {
    kernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot });
    kernel.close();
    kernel = undefined;
    assert.throws(() => openServerFoundation(config), (error) => error?.code === 'missing_key_existing_database');
    kernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot });
    assert.ok(kernel);
  } finally { kernel?.close(); cleanup(f); }
});

test('host drain failure retains ownership until the exact close is retried successfully', async () => {
  const f = fixture();
  const staticRoot = join(f.directory, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{}');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  let drains = 0;
  let failNextDrain = false;
  let host;
  let port = 0;
  const net = await import('node:net');
  const probe = net.createServer();
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  const actualConfig = loadServerConfig({ STILL_ORIGIN: `http://127.0.0.1:${port}`, STILL_DATA_DIR: dirname(f.databasePath),
    STILL_VAULT_KEY_FILE: join(f.directory, 'keys', 'root.key') }, { staticRoot, allowLocalHttp: true });
  try {
    const foundationCheck = openServerFoundation(actualConfig);
    const listenerCheck = await startStillHttp(actualConfig, foundationCheck, port);
    await listenerCheck.close();
    host = await startApplicationHost({ config: actualConfig, port, createRuntime: () => ({
      workspaceApi: {}, stopAdmission() {}, async drainAndDispose() { drains += 1; if (failNextDrain) { failNextDrain = false; throw new Error('synthetic_drain_failure'); } },
    }) });
    failNextDrain = true;
    await assert.rejects(host.close(), /synthetic_drain_failure/);
    assert.throws(() => createDurableKernel({ databasePath: f.databasePath, validateSnapshot }),
      (error) => error?.code === 'application_owner_busy');
    await host.close();
    host = undefined;
    const recovered = createDurableKernel({ databasePath: f.databasePath, validateSnapshot });
    recovered.close();
    assert.equal(drains, 2);
  } finally { if (host) await host.close().catch(() => {}); cleanup(f); }
});

test('acquisition cleanup retains the exact SQLite guard when close fails and can be explicitly retried', () => {
  const f = fixture();
  const originalExec = Database.prototype.exec;
  const originalClose = Database.prototype.close;
  let failAfterBegin = true;
  let failCloseOnce = true;
  Database.prototype.exec = function exec(sql) {
    const result = originalExec.call(this, sql);
    if (sql === 'BEGIN EXCLUSIVE' && failAfterBegin) { failAfterBegin = false; throw new Error('injected_after_begin'); }
    return result;
  };
  Database.prototype.close = function close(...args) {
    if (failCloseOnce) { failCloseOnce = false; throw new Error('injected_close_failure'); }
    return originalClose.apply(this, args);
  };
  try {
    let cleanupError;
    try { acquireApplicationOwnership(f.databasePath); }
    catch (error) { cleanupError = error; }
    assert.equal(cleanupError?.name, 'ApplicationOwnershipStartupCleanupError');
    assert.throws(() => acquireApplicationOwnership(f.databasePath), (error) => error?.code === 'application_owner_busy');
    cleanupError.retryClose();
    const owner = acquireApplicationOwnership(f.databasePath);
    owner.release();
  } finally {
    Database.prototype.exec = originalExec;
    Database.prototype.close = originalClose;
    cleanup(f);
  }
});

test('persistent database rejects symlink and hard-link aliases while memory kernels remain independent', (t) => {
  const f = fixture();
  let first;
  try {
    first = createDurableKernel({ databasePath: f.databasePath, validateSnapshot });
    const alias = join(f.directory, 'alias.sqlite');
    try { linkSync(f.databasePath, alias); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('Hard links are unavailable in this environment.'); else throw error; }
    assert.throws(() => createDurableKernel({ databasePath: alias, validateSnapshot }),
      (error) => error?.code === 'application_owner_path_unsafe');
    const memoryA = createDurableKernel({ databasePath: ':memory:', validateSnapshot });
    const memoryB = createDurableKernel({ databasePath: ':memory:', validateSnapshot });
    assert.equal(memoryA.withTrustedDatabaseTransaction((db) => db.pragma('foreign_keys', { simple: true })), 1);
    memoryA.close(); memoryB.close();
    first.close(); first = undefined;
    const linkPath = join(f.directory, 'linked-dir');
    try { symlinkSync(dirname(f.databasePath), linkPath, 'junction'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('Directory symlinks are unavailable in this environment.'); else throw error; }
    assert.throws(() => createDurableKernel({ databasePath: join(linkPath, 'still.sqlite'), validateSnapshot }),
      (error) => error?.code === 'application_owner_path_unsafe');
  } finally { first?.close(); cleanup(f); }
});
