import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationHostStartupCleanupError } from '../dist/applicationHost.js';
import { ServerFoundationStartupCleanupError } from '../dist/bootstrap.js';
import { getStillServerCleanupStatus, retryStillServerCleanup, runStillServer } from '../scripts/still-server.mjs';

const config = { canonicalOrigin: 'https://still.example.test', dataDirectory: 'C:/private/still', staticRoot: 'C:/private/static' };

 test('CLI retains a failed started-host close and retries the same owner explicitly', async () => {
  let closeAttempts = 0;
  const result = await runStillServer(['start'], { installSignalHandlers: false, parsePort: () => 8123, loadConfig: () => config,
    startApplicationHost: async () => ({ async close() { closeAttempts += 1; if (closeAttempts === 1) throw new Error('private close detail'); } }),
    writeOut() {}, writeError() {} });
  assert.equal(result, 0);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'running', heldCount: 1 });
  await assert.rejects(retryStillServerCleanup(), /private close detail/);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'cleanup_pending', heldCount: 1 });
  assert.equal(await retryStillServerCleanup(), true);
  assert.equal(closeAttempts, 2);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'idle', heldCount: 0 });
});

test('CLI retains startup cleanup capability, blocks a new start, and permits explicit retry', async () => {
  let cleanupAttempts = 0;
  const startupCleanup = new ApplicationHostStartupCleanupError(async () => {
    cleanupAttempts += 1;
    if (cleanupAttempts < 3) throw new Error('private startup cleanup detail');
  });
  const errors = [];
  const start = await runStillServer(['start'], { installSignalHandlers: false, parsePort: () => 8124,
    loadConfig: () => config, startApplicationHost: async () => { throw startupCleanup; }, writeOut() {},
    writeError(value) { errors.push(value); } });
  assert.equal(start, 1);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'cleanup_pending', heldCount: 1 });
  assert.match(errors[0], /cleanup is incomplete/);
  let secondStartCalls = 0;
  assert.equal(await runStillServer(['start'], { installSignalHandlers: false, parsePort: () => 8124, loadConfig: () => config,
    startApplicationHost: async () => { secondStartCalls += 1; throw new Error('must not start'); }, writeOut() {}, writeError() {} }), 1);
  assert.equal(secondStartCalls, 0);
  await assert.rejects(retryStillServerCleanup(), /private startup cleanup detail/);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'cleanup_pending', heldCount: 1 });
  await assert.rejects(retryStillServerCleanup(), /private startup cleanup detail/);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'cleanup_pending', heldCount: 1 });
  assert.equal(await retryStillServerCleanup(), true);
  assert.equal(cleanupAttempts, 3);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'idle', heldCount: 0 });
});

test('CLI retains compatibility foundation cleanup before assignment and blocks other commands until retry', async () => {
  let cleanupAttempts = 0;
  let laterFoundationOpens = 0;
  const errors = [];
  const startupCleanup = new ServerFoundationStartupCleanupError(() => {
    cleanupAttempts += 1;
    if (cleanupAttempts === 1) throw new Error('private foundation cleanup detail');
  });
  assert.equal(await runStillServer(['start'], { installSignalHandlers: false, parsePort: () => 8125,
    loadConfig: () => config, openFoundation: () => { throw startupCleanup; }, writeOut() {},
    writeError(value) { errors.push(value); } }), 1);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'cleanup_pending', heldCount: 1 });
  assert.match(errors[0], /cleanup is incomplete/);
  assert.equal(await runStillServer(['status'], { installSignalHandlers: false, loadConfig: () => config,
    openFoundation() { laterFoundationOpens += 1; throw new Error('must not open another foundation'); }, writeOut() {}, writeError() {} }), 1);
  assert.equal(laterFoundationOpens, 0);
  await assert.rejects(retryStillServerCleanup(), /private foundation cleanup detail/);
  assert.equal(cleanupAttempts, 1);
  assert.equal(await retryStillServerCleanup(), true);
  assert.equal(cleanupAttempts, 2);
  assert.deepEqual(getStillServerCleanupStatus(), { state: 'idle', heldCount: 0 });
});
