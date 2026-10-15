import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { CommandJournal, composeSnapshotCommitParticipants, ServerWorkspaceStore } from '../dist/workspaceRuntime.js';

function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-snapshot-participant-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const initial = { accounts: [], marker: 'initial' };
  const workspace = kernel.createWorkspace(ownerId, initial);
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const journal = new CommandJournal(kernel);
  const store = new ServerWorkspaceStore({ kernel, sessionToken, journal, ...options });
  return { directory, kernel, ownerId, initial, workspace, sessionToken, journal, store };
}

function close(f) {
  f.kernel.close();
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function seedProbeTable(f) {
  f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => {
    context.db.exec('CREATE TABLE participant_probe (name TEXT PRIMARY KEY, snapshot_revision INTEGER NOT NULL, command_id TEXT)');
  });
}

function probeRows(f) {
  return f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) =>
    context.db.prepare('SELECT name,snapshot_revision,command_id FROM participant_probe ORDER BY name').all());
}

function admit(f, expectedRevision, idempotencyKey, body) {
  return f.journal.admit({ admissionSessionToken: f.sessionToken, expectedRevision, expectedPrivacyEpoch: 0,
    idempotencyKey, kind: 'workspace.test', canonicalBody: JSON.stringify(body) });
}

test('pre-commit receives the old snapshot, planned sequential revision, and exact command ticket', async () => {
  const seen = [];
  const f = setup({ snapshotCommitParticipant: {
    beforeCommit(context, input) {
      const owned = f.kernel.readOwnedSnapshotWithinTransaction(context);
      seen.push({ oldRevision: context.revision, ownedRevision: owned.revision, oldSnapshot: owned.snapshot, previous: input.previousSnapshot,
        next: input.nextSnapshot, planned: input.nextRevision, commandId: input.commandId });
    },
    commit() {},
  } });
  try {
    await f.store.load();
    const commandIds = [];
    for (let expectedRevision = 0; expectedRevision < 2; expectedRevision++) {
      const idempotencyKey = randomUUID();
      commandIds.push(idempotencyKey);
      const body = { marker: `revision-${expectedRevision + 1}` };
      const admission = admit(f, expectedRevision, idempotencyKey, body);
      await f.journal.run(admission.ticket, f.sessionToken, () => f.store.save({ accounts: [], marker: body.marker }));
    }
    assert.deepEqual(seen.map((item) => ({ oldRevision: item.oldRevision, planned: item.planned,
      ownedRevision: item.ownedRevision, previous: item.previous, next: item.next, commandId: item.commandId })), [
      { oldRevision: 0, ownedRevision: 0, planned: 1, previous: f.initial, next: { accounts: [], marker: 'revision-1' }, commandId: commandIds[0] },
      { oldRevision: 1, ownedRevision: 1, planned: 2, previous: { accounts: [], marker: 'revision-1' }, next: { accounts: [], marker: 'revision-2' }, commandId: commandIds[1] },
    ]);
    assert.match(seen[0].commandId, /^[0-9a-f-]{36}$/i);
    assert.match(seen[1].commandId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(seen[0].commandId, seen[1].commandId);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 2);
  } finally { close(f); }
});

test('deeply frozen hook snapshots resist caught nested mutation and keep later projections and saved bytes unchanged', async () => {
  const seen = [];
  const f = setup({ snapshotCommitParticipant: composeSnapshotCommitParticipants([
    { name: 'mutator', participant: {
      beforeCommit(_context, input) {
        seen.push(Reflect.set(input.nextSnapshot.accounts[0].identity, 'subject', 'tampered'));
        seen.push(Reflect.set(input.nextSnapshot.batchLedger.jobs[0].sourceVersions, 'doc:changed', 'bad'));
      },
      commit(_context, input) { seen.push(input.nextSnapshot.accounts[0].identity.subject); },
    } },
    { name: 'observer', participant: {
      beforeCommit(_context, input) {
        seen.push(input.nextSnapshot.accounts[0].identity.subject);
        seen.push(input.nextSnapshot.batchLedger.jobs[0].sourceVersions['doc:source']);
      },
      commit(_context, input) { seen.push(input.nextSnapshot.batchLedger.jobs[0].sourceVersions['doc:source']); },
    } },
  ]) });
  try {
    await f.store.load();
    const state = { accounts: [{ id: randomUUID(), identity: { subject: 'original' } }],
      batchLedger: { jobs: [{ sourceVersions: { 'doc:source': 'v1' } }] } };
    await f.store.save(state);
    assert.deepEqual(seen, [false, false, 'original', 'v1', 'original', 'v1']);
    assert.deepEqual(plain(f.kernel.getOwnedSnapshot(f.sessionToken).snapshot), state);
  } finally { close(f); }
});

test('an uncaught nested mutation in strict participant code rolls back prior side writes and the snapshot', async () => {
  const f = setup();
  seedProbeTable(f);
  const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken,
    snapshotCommitParticipant: {
      beforeCommit(context, input) {
        context.db.prepare('INSERT INTO participant_probe VALUES(?,?,?)').run('before', input.nextRevision, null);
        input.nextSnapshot.accounts[0].identity.subject = 'tampered';
      },
      commit() {},
    } });
  try {
    await store.load();
    await assert.rejects(store.save({ accounts: [{ id: randomUUID(), identity: { subject: 'original' } }] }), TypeError);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 0);
    assert.deepEqual(plain(f.kernel.getOwnedSnapshot(f.sessionToken).snapshot), f.initial);
    assert.deepEqual(probeRows(f), []);
  } finally { close(f); }
});

test('pre-commit and post-snapshot participant failures roll back their side writes and the snapshot', async (t) => {
  for (const failurePoint of ['beforeCommit', 'commit']) {
    await t.test(failurePoint, async () => {
      const f = setup();
      seedProbeTable(f);
      const participant = {
        beforeCommit(context, input) {
          context.db.prepare('INSERT INTO participant_probe VALUES(?,?,?)').run('before', input.nextRevision, input.commandId ?? null);
          if (failurePoint === 'beforeCommit') throw new Error('injected before-commit failure');
        },
        commit(context, input) {
          context.db.prepare('INSERT INTO participant_probe VALUES(?,?,?)').run('commit', input.nextRevision, input.commandId ?? null);
          if (failurePoint === 'commit') throw new Error('injected participant checkpoint failure');
        },
      };
      const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken,
        snapshotCommitParticipant: participant });
      try {
        await store.load();
        await assert.rejects(store.save({ accounts: [], marker: 'must-roll-back' }), /injected .* failure/i);
        assert.deepEqual(plain(f.kernel.getOwnedSnapshot(f.sessionToken).snapshot), f.initial);
        assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 0);
        assert.deepEqual(probeRows(f), []);
      } finally { close(f); }
    });
  }
});

test('journal checkpoint failure after pre-commit rolls back snapshot and participant writes', async () => {
  const f = setup();
  seedProbeTable(f);
  const originalCheckpoint = f.journal.checkpoint.bind(f.journal);
  f.journal.checkpoint = (...args) => {
    originalCheckpoint(...args);
    throw new Error('injected journal checkpoint failure');
  };
  const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken, journal: f.journal,
    snapshotCommitParticipant: {
      beforeCommit(context, input) {
        context.db.prepare('INSERT INTO participant_probe VALUES(?,?,?)').run('before', input.nextRevision, input.commandId ?? null);
      },
      commit() {},
    } });
  try {
    await store.load();
    const admission = admit(f, 0, randomUUID(), { marker: 'checkpoint-fail' });
    await assert.rejects(f.journal.run(admission.ticket, f.sessionToken, () => store.save({ accounts: [], marker: 'must-roll-back' })), /journal checkpoint failure/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 0);
    assert.deepEqual(plain(f.kernel.getOwnedSnapshot(f.sessionToken).snapshot), f.initial);
    assert.deepEqual(probeRows(f), []);
  } finally { close(f); }
});

test('composed pre-commit hooks run in order and preserve namespaced post-ack routing', async () => {
  const order = [];
  const acknowledgements = [];
  const participant = (name) => ({
    beforeCommit(_context, input) { order.push(`${name}:before:${input.nextRevision}`); },
    commit(_context, input) { order.push(`${name}:commit:${input.nextRevision}`); return [`${name}-intent`]; },
    afterAcknowledged(ids) { acknowledgements.push([name, [...ids]]); },
  });
  const f = setup({ snapshotCommitParticipant: composeSnapshotCommitParticipants([
    { name: 'first', participant: participant('first') },
    { name: 'second', participant: participant('second') },
  ]) });
  try {
    await f.store.load();
    await f.store.save({ accounts: [], marker: 'composed' });
    assert.deepEqual(order, ['first:before:1', 'second:before:1', 'first:commit:1', 'second:commit:1']);
    assert.deepEqual(acknowledgements, [['first', ['first-intent']], ['second', ['second-intent']]]);
  } finally { close(f); }
});

test('async pre-commit callbacks are rejected at installation or safely rejected if they return a thenable', async () => {
  const f = setup();
  try {
    assert.throws(() => new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken,
      snapshotCommitParticipant: { beforeCommit: async () => {}, commit() {} } }), /unavailable/);
    await f.store.load();
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken,
      snapshotCommitParticipant: { beforeCommit() { return Promise.reject(new Error('ignored async rejection')); }, commit() {} } });
    await store.load();
    await assert.rejects(store.save({ accounts: [], marker: 'no-write' }), /must_be_synchronous/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 0);
  } finally { close(f); }
});

test('lost acknowledgement keeps transactional participant work but does not run post-ack or permit another save until reload', async () => {
  let acknowledge = false;
  let afterAcknowledged = 0;
  const f = setup({ afterCommitForTesting() { if (!acknowledge) throw new Error('simulated lost acknowledgement'); },
    snapshotCommitParticipant: {
      beforeCommit(context, input) {
        context.db.prepare('INSERT INTO participant_probe VALUES(?,?,?)').run(`ack-${input.nextRevision}`, input.nextRevision, null);
      },
      commit() { return ['intent']; },
      afterAcknowledged() { afterAcknowledged++; },
    } });
  seedProbeTable(f);
  try {
    await f.store.load();
    await assert.rejects(f.store.save({ accounts: [], marker: 'durable' }), /simulated lost acknowledgement/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 1);
    assert.deepEqual(probeRows(f), [{ name: 'ack-1', snapshot_revision: 1, command_id: null }]);
    assert.equal(afterAcknowledged, 0);
    await assert.rejects(f.store.save({ accounts: [], marker: 'blocked' }), /explicitly reload/i);
    await f.store.load();
    acknowledge = true;
    await f.store.save({ accounts: [], marker: 'after-reload' });
    assert.deepEqual(probeRows(f), [
      { name: 'ack-1', snapshot_revision: 1, command_id: null },
      { name: 'ack-2', snapshot_revision: 2, command_id: null },
    ]);
    assert.equal(afterAcknowledged, 1);
  } finally { close(f); }
});
