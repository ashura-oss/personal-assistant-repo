import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { ServerWorkspaceStore } from '../dist/workspaceRuntime.js';

function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-workspace-store-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const validateSnapshot = (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const kernel = createDurableKernel({ databasePath, validateSnapshot });
  const ownerId = randomUUID();
  const initial = { accounts: [], notes: [], privateReceipt: { requestBody: 'retained' }, backupImportQuarantine: [{ raw: 'retained' }] };
  const workspace = kernel.createWorkspace(ownerId, initial);
  const runtimeSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const store = new ServerWorkspaceStore({ kernel, sessionToken: runtimeSession, ...options });
  return { directory, kernel, ownerId, initial, workspace, runtimeSession, store, validateSnapshot };
}

function close(fixture, ...extraKernels) {
  for (const kernel of [fixture.kernel, ...extraKernels]) kernel.close();
  rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('loads the exact private snapshot, exposes bounded snapshot reads, and uses revision CAS', async () => {
  const f = setup();
  try {
    const loaded = await f.store.load();
    assert.deepEqual(loaded, f.initial);
    const current = await f.store.readCurrentSnapshot();
    assert.equal(current.schemaVersion, 1);
    assert.deepEqual(JSON.parse(current.raw), f.initial);

    const second = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession });
    await second.load();
    await f.store.save({ ...f.initial, marker: 'committed' });
    await assert.rejects(second.assertCurrent(), /changed in another runtime/i);
    await assert.rejects(second.save({ ...f.initial, marker: 'stale overwrite' }), /stale_revision|revision changed/i);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.marker, 'committed');
  } finally { close(f); }
});

test('lost save acknowledgement blocks writes until an explicit reload', async () => {
  let loseAcknowledgement = true;
  const f = setup({ afterCommitForTesting: () => {
    if (loseAcknowledgement) throw new Error('simulated acknowledgement loss after commit');
  } });
  try {
    await f.store.load();
    await assert.rejects(f.store.save({ ...f.initial, marker: 'durably committed' }), /acknowledgement loss/);
    await assert.rejects(f.store.save({ ...f.initial, marker: 'must not overwrite' }), /explicitly reload/i);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.marker, 'durably committed');
    loseAcknowledgement = false;
    const loaded = await f.store.load();
    assert.equal(loaded.marker, 'durably committed');
    await f.store.save({ ...loaded, marker: 'after reload' });
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.marker, 'after reload');
  } finally { close(f); }
});

test('account generations are monotonic, mirrored and retained as tombstones', async () => {
  const f = setup();
  const accountId = randomUUID();
  try {
    await f.store.load();
    const account = { id: accountId, connectionGeneration: 5 };
    await f.store.save({ ...f.initial, accounts: [account] });
    let snapshot = f.kernel.getOwnedSnapshot(f.runtimeSession);
    assert.equal(snapshot.revision, 1);
    assert.doesNotThrow(() => f.kernel.withOwnedTransaction(f.runtimeSession, snapshot.privacyEpoch, (context) => {
      assert.equal(context.db.prepare('SELECT generation FROM account_generations WHERE workspace_id=? AND account_id=?').get(snapshot.workspaceId, accountId).generation, 5);
    }));
    await assert.rejects(f.store.save({ ...f.initial, accounts: [{ id: accountId, connectionGeneration: 4 }] }), /cannot move backwards|generation/i);
    snapshot = f.kernel.getOwnedSnapshot(f.runtimeSession);
    assert.equal(snapshot.revision, 1, 'invalid generation rollback also rolls back the state write');
    await f.store.load();
    await f.store.save({ ...f.initial, accounts: [] });
    await f.store.save({ ...f.initial, accounts: [{ id: accountId, connectionGeneration: 5 }] });
    snapshot = f.kernel.getOwnedSnapshot(f.runtimeSession);
    assert.equal(snapshot.revision, 3);
    await assert.rejects(f.store.save({ ...f.initial, accounts: [{ id: accountId, connectionGeneration: -1 }] }), /invalid/i);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).revision, 3);
  } finally { close(f); }
});

test('enforces the existing 16 MiB physical snapshot bound and explicit erase boundary', async () => {
  const f = setup();
  try {
    await f.store.load();
    await assert.rejects(f.store.save({ ...f.initial, large: 'x'.repeat(16 * 1024 * 1024) }), /16 MiB/i);
    await assert.rejects(f.store.clear(), /explicit privacy erase/i);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).revision, 0);
  } finally { close(f); }
});
