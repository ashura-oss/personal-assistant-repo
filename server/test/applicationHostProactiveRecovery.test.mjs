import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { ApplicationHostStartError, startApplicationHost } from '../dist/applicationHost.js';
import { applicationStartupPhaseForTesting } from '../dist/applicationStartup.js';
import { createCloudApplicationRuntimeFactory, createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-recovery-hook-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  return { directory, staticRoot };
}

function configFor(state, port) {
  return loadServerConfig({ STILL_ORIGIN: `http://127.0.0.1:${port}`,
    STILL_DATA_DIR: join(state.directory, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(state.directory, 'private', 'keys', 'root.key') },
  { staticRoot: state.staticRoot, allowLocalHttp: true });
}

function minimalRuntime() {
  return { workspaceApi: { async getSnapshot() { return {}; }, async refreshSnapshot() { return {}; },
    async dispatchCommand() { return {}; }, inspectCommand() { return {}; } },
  stopAdmission() {}, async drainAndDispose() {} };
}

test('host invokes the immutable proactive recovery hook during cold recovery before runtime creation', async () => {
  const state = fixture();
  let host;
  try {
    const port = await freePort();
    const config = configFor(state, port);
    const hookCalls = [];
    const createRuntime = () => {
      assert.equal(hookCalls.length, 1);
      assert.ok(hookCalls[0].markerPresent);
      return minimalRuntime();
    };
    const hook = ({ kernel, startupCapability }) => {
      assert.equal(applicationStartupPhaseForTesting(kernel), 'recovering');
      const markerPresent = kernel.withColdStartDatabaseTransaction(startupCapability, (db) => {
        db.exec('CREATE TABLE proactive_recovery_order_marker (value INTEGER NOT NULL)');
        db.exec('INSERT INTO proactive_recovery_order_marker(value) VALUES(1)');
        return db.prepare('SELECT value FROM proactive_recovery_order_marker').get().value === 1;
      });
      hookCalls.push({ markerPresent });
    };
    Object.defineProperty(createRuntime, 'recoverProactivePreflights', { value: hook, writable: false, configurable: false });
    host = await startApplicationHost({ config, port, createRuntime });
    assert.deepEqual(hookCalls, [{ markerPresent: true }]);
    await host.close();
    host = undefined;
  } finally {
    if (host) await host.close().catch(() => {});
    rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('cloud and production wrappers retain the same frozen startup recovery hook', () => {
  const cloud = createCloudApplicationRuntimeFactory({ workspacePortsFor() { throw new Error('not invoked'); } });
  const production = createProductionApplicationRuntimeFactory({ dataDirectory: 'unused-test-path', canonicalOrigin: 'https://example.test' }, {
    fetcher: async () => { throw new Error('not invoked'); },
  });
  for (const factory of [cloud, production]) {
    const descriptor = Object.getOwnPropertyDescriptor(factory, 'recoverProactivePreflights');
    assert.ok(descriptor);
    assert.equal(typeof descriptor.value, 'function');
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.equal(Object.isFrozen(factory), true);
  }
  assert.equal(cloud.recoverProactivePreflights, production.recoverProactivePreflights);
});

test('production recovery hook validates its real startup capability and accepts a clean empty index', () => {
  const state = fixture();
  let opened;
  try {
    const port = 31_001;
    const config = configFor(state, port);
    opened = openServerFoundationInternal(config);
    opened.privateContext.startup.beginRecovery();
    const factory = createProductionApplicationRuntimeFactory(config, { fetcher: async () => {
      throw new Error('provider access is closed in this fixture');
    } });
    factory.recoverProactivePreflights({ kernel: opened.privateContext.kernel,
      startupCapability: opened.privateContext.startup.capability });
    assert.throws(() => factory.recoverProactivePreflights({ kernel: opened.privateContext.kernel,
      startupCapability: Object.freeze({}) }), /application_startup_capability_invalid/);
  } finally {
    if (opened) {
      opened.privateContext.startup.seal();
      opened.foundation.close();
    }
    rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('host fails closed when proactive metadata exists but factory has no cold recovery hook', async () => {
  const state = fixture();
  let host;
  try {
    const port = await freePort();
    const config = configFor(state, port);
    const seed = () => {
      const factory = () => minimalRuntime();
      Object.defineProperty(factory, 'recoverProactivePreflights', { value: ({ kernel, startupCapability }) => {
        kernel.withColdStartDatabaseTransaction(startupCapability, (db) => {
          db.exec('CREATE TABLE background_proactive_fixture_history (id TEXT PRIMARY KEY)');
        });
      }, writable: false, configurable: false });
      return factory;
    };
    host = await startApplicationHost({ config, port, createRuntime: seed() });
    await host.close();
    host = undefined;

    let runtimeCalls = 0;
    await assert.rejects(startApplicationHost({ config, port, createRuntime() { runtimeCalls += 1; return minimalRuntime(); } }),
      (error) => error instanceof ApplicationHostStartError);
    assert.equal(runtimeCalls, 0);
  } finally {
    if (host) await host.close().catch(() => {});
    rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('async or mutable recovery hooks are rejected before runtime composition', async () => {
  const state = fixture();
  try {
    const port = await freePort();
    const config = configFor(state, port);
    let asyncCalls = 0;
    const asyncHook = async () => { asyncCalls += 1; };
    let thenableCalls = 0;
    const thenableHook = () => Promise.resolve().then(() => { thenableCalls += 1; });
    for (const hook of [asyncHook, thenableHook]) {
      let runtimeCalls = 0;
      const createRuntime = () => { runtimeCalls += 1; return minimalRuntime(); };
      Object.defineProperty(createRuntime, 'recoverProactivePreflights', { value: hook, writable: false, configurable: false });
      await assert.rejects(startApplicationHost({ config, port, createRuntime }), (error) => error instanceof ApplicationHostStartError);
      assert.equal(runtimeCalls, 0);
    }
    assert.equal(asyncCalls, 0, 'declared async hooks are rejected without invocation');
    assert.equal(thenableCalls, 1, 'returned thenables are settled before startup fails');
    let runtimeCalls = 0;
    const mutable = () => { runtimeCalls += 1; return minimalRuntime(); };
    let mutableHookCalls = 0;
    Object.defineProperty(mutable, 'recoverProactivePreflights', { value: () => { mutableHookCalls += 1; }, writable: true, configurable: false });
    await assert.rejects(startApplicationHost({ config, port, createRuntime: mutable }), (error) => error instanceof ApplicationHostStartError);
    assert.equal(runtimeCalls, 0);
    assert.equal(mutableHookCalls, 0, 'mutable hook descriptors are rejected before invocation');
  } finally {
    rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
