import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { CommandJournal, ServerWorkspaceStore } from '../dist/workspaceRuntime.js';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-command-journal-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const validateSnapshot = (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const kernel = createDurableKernel({ databasePath, validateSnapshot });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { accounts: [], notes: [], marker: 'initial' });
  const expires = Date.now() + 60 * 60_000;
  const admissionSessionA = kernel.createSession(workspace.workspaceId, ownerId, expires);
  const admissionSessionB = kernel.createSession(workspace.workspaceId, ownerId, expires);
  const runtimeSession = kernel.createSession(workspace.workspaceId, ownerId, expires);
  const journal = new CommandJournal(kernel);
  return { directory, databasePath, kernel, journal, workspace, ownerId, admissionSessionA, admissionSessionB, runtimeSession, validateSnapshot };
}

function close(fixture, ...extraKernels) {
  for (const kernel of [fixture.kernel, ...extraKernels]) kernel.close();
  rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function admission(f, { key = 'cmd:test:one', body = '{"text":"same"}', session = f.admissionSessionA } = {}) {
  return f.journal.admit({ admissionSessionToken: session, expectedRevision: 0, expectedPrivacyEpoch: 0,
    idempotencyKey: key, kind: 'test.operation', canonicalBody: body });
}

test('admission binds canonical body, rejects changed content, and returns terminal receipts without rerunning', async () => {
  const f = setup();
  try {
    const claimed = admission(f);
    assert.equal(claimed.fresh, true);
    assert.equal(claimed.status, 'claimed');
    const duplicate = admission(f, { session: f.admissionSessionB });
    assert.equal(duplicate.fresh, false);
    assert.equal(duplicate.status, 'claimed');
    assert.equal(duplicate.ticket, undefined, 'duplicates never receive execution capability');
    assert.throws(() => admission(f, { body: '{"text":"changed"}' }), /bound to different/i);
    await f.journal.run(claimed.ticket, f.runtimeSession, async () => 'done');
    const ticket = { ...claimed.ticket, runtimeSessionToken: f.runtimeSession };
    assert.deepEqual({ ...f.journal.finish(ticket, { kind: 'test.result', ok: true }) }, { kind: 'test.result', ok: true });
    const replay = admission(f, { session: f.admissionSessionB });
    assert.equal(replay.fresh, false);
    assert.equal(replay.status, 'finished');
    assert.deepEqual({ ...replay.receipt }, { kind: 'test.result', ok: true });
    assert.deepEqual({ ...f.journal.inspect(f.admissionSessionB, 'cmd:test:one').receipt }, { kind: 'test.result', ok: true });
  } finally { close(f); }
});

test('admission token revocation does not cancel already-owned runtime work; new login can inspect without rerun', async () => {
  const f = setup();
  try {
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession, journal: f.journal });
    await store.load();
    const claimed = admission(f);
    f.kernel.revokeSession(f.admissionSessionA);
    let executions = 0;
    const result = await f.journal.run(claimed.ticket, f.runtimeSession, async () => {
      executions += 1;
      await store.save({ accounts: [], notes: [], marker: 'checkpointed after browser logout' });
      return { value: 'committed' };
    });
    f.journal.finish({ ...claimed.ticket, runtimeSessionToken: f.runtimeSession }, result);
    assert.equal(executions, 1);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.marker, 'checkpointed after browser logout');
    const inspect = f.journal.admit({ admissionSessionToken: f.admissionSessionB, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: 'cmd:test:one', kind: 'test.operation', canonicalBody: '{"text":"same"}' });
    assert.equal(inspect.fresh, false);
    assert.equal(inspect.status, 'finished');
    assert.deepEqual({ ...inspect.receipt }, { value: 'committed' });
    assert.equal(executions, 1, 'a new authorized session observes the prior result and never invokes the operation again');
  } finally { close(f); }
});

test('a stale loaded revision cannot overwrite a newer snapshot through a command ticket', async () => {
  const f = setup();
  try {
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession, journal: f.journal });
    await store.load();
    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: 'external-update', type: 'workspace.snapshot.write', canonicalRequest: '{"source":"other-runtime"}' }, () => ({
      snapshot: { accounts: [], notes: [], marker: 'newer external state' },
      receipt: { kind: 'test.external' },
    }));
    const claimed = f.journal.admit({ admissionSessionToken: f.admissionSessionA, expectedRevision: 1, expectedPrivacyEpoch: 0,
      idempotencyKey: 'cmd:stale-checkpoint', kind: 'test.operation', canonicalBody: '{"text":"stale"}' });
    await assert.rejects(f.journal.run(claimed.ticket, f.runtimeSession, async () => {
      await store.save({ accounts: [], notes: [], marker: 'must not overwrite newer state' });
    }), /changed|reload|revision/i);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.marker, 'newer external state');
    assert.equal(f.journal.inspect(f.admissionSessionA, 'cmd:stale-checkpoint').status, 'inspect_required');
  } finally { close(f); }
});

test('runtime checkpoints and receipts reject cross-workspace ticket use', async () => {
  const f = setup();
  try {
    const otherOwner = randomUUID();
    const otherWorkspace = f.kernel.createWorkspace(otherOwner, { accounts: [], notes: [], marker: 'other' });
    const otherRuntime = f.kernel.createSession(otherWorkspace.workspaceId, otherOwner, Date.now() + 60 * 60_000);
    const claimed = admission(f);
    const ticket = { ...claimed.ticket, runtimeSessionToken: otherRuntime };
    assert.throws(() => f.journal.finish(ticket, null), /does not own this ticket workspace/i);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.marker, 'initial');
    assert.equal(f.journal.inspect(f.admissionSessionA, 'cmd:test:one').status, 'claimed');
  } finally { close(f); }
});

test('opening another journal does not invalidate live claims; interrupted recovery requires verified exclusivity', () => {
  const f = setup();
  try {
    admission(f);
    const secondJournal = new CommandJournal(f.kernel);
    assert.equal(secondJournal.inspect(f.admissionSessionA, 'cmd:test:one').status, 'claimed');
    assert.throws(() => secondJournal.recoverInterrupted(() => false), /verified exclusive process ownership/i);
    assert.equal(f.journal.inspect(f.admissionSessionA, 'cmd:test:one').status, 'claimed');
    assert.equal(secondJournal.recoverInterrupted(() => true), 1);
    assert.equal(f.journal.inspect(f.admissionSessionB, 'cmd:test:one').status, 'inspect_required');
  } finally { close(f); }
});

test('history pages use a stable tied cursor, re-evaluate status, and filter private/internal rows before pagination', () => {
  const f = setup();
  try {
    const ids = Array.from({ length: 52 }, () => randomUUID());
    const internalId = randomUUID();
    f.kernel.withTrustedDatabaseTransaction((db) => {
      const insert = db.prepare(`INSERT INTO async_command_journal(workspace_id,idempotency_key,owner_id,session_digest,request_digest,command_kind,
        privacy_epoch,ticket_id,ticket_digest,status,created_at,updated_at,checkpoint_revision,snapshot_digest,owned_object_ids_json,receipt_json)
        VALUES(?,?,?,?,?,?,0,?,?,'claimed',1000,1000,NULL,NULL,NULL,NULL)`);
      ids.forEach((id, index) => insert.run(f.workspace.workspaceId, id, f.ownerId, 's'.repeat(64), 'r'.repeat(64),
        index % 2 ? 'chat.create' : 'notes.save', randomUUID(), 't'.repeat(64)));
      insert.run(f.workspace.workspaceId, internalId, f.ownerId, 's'.repeat(64), 'r'.repeat(64), 'workspace.snapshot.write', randomUUID(), 't'.repeat(64));
      insert.run(f.workspace.workspaceId, 'not-a-uuid-command', f.ownerId, 's'.repeat(64), 'r'.repeat(64), 'notes.save', randomUUID(), 't'.repeat(64));
    });
    const first = f.journal.historyPage(f.admissionSessionA);
    assert.equal(first.entries.length, 50);
    assert.ok(first.nextCursor);
    assert.deepEqual(first.entries.map((entry) => entry.commandId), [...ids].sort().reverse().slice(0, 50));
    const second = f.journal.historyPage(f.admissionSessionA, first.nextCursor);
    assert.equal(second.entries.length, 2);
    assert.equal(second.nextCursor, undefined);
    assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.commandId)).size, 52);

    const dbCursor = Buffer.from(first.nextCursor, 'base64url').toString('utf8');
    const cursor = JSON.parse(dbCursor);
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare(`INSERT INTO async_command_journal(workspace_id,idempotency_key,owner_id,session_digest,request_digest,command_kind,
        privacy_epoch,ticket_id,ticket_digest,status,created_at,updated_at,checkpoint_revision,snapshot_digest,owned_object_ids_json,receipt_json)
        VALUES(?,?,?,?,?,?,0,?,?,'claimed',2000,2000,NULL,NULL,NULL,NULL)`)
        .run(f.workspace.workspaceId, randomUUID(), f.ownerId, 's'.repeat(64), 'r'.repeat(64), 'notes.save', randomUUID(), 't'.repeat(64));
      db.prepare(`UPDATE async_command_journal SET status='inspect_required',updated_at=1200
        WHERE workspace_id=? AND idempotency_key=?`).run(f.workspace.workspaceId, second.entries[0].commandId);
    });
    const afterChange = f.journal.historyPage(f.admissionSessionA, first.nextCursor);
    assert.equal(afterChange.entries.length, 2, 'rows inserted ahead of the cursor do not duplicate prior results');
    assert.equal(afterChange.entries.find((entry) => entry.commandId === second.entries[0].commandId).status, 'inspect_required');
    assert.equal(cursor.createdAt, 1000);

    const otherOwner = randomUUID();
    const otherWorkspace = f.kernel.createWorkspace(otherOwner, { accounts: [], notes: [] });
    const otherSession = f.kernel.createSession(otherWorkspace.workspaceId, otherOwner, Date.now() + 60 * 60_000);
    assert.throws(() => f.journal.historyPage(otherSession, first.nextCursor), /cursor_invalid/);
    for (const badCursor of ['', `${first.nextCursor}=`, Buffer.from(JSON.stringify({ ...cursor, extra: true })).toString('base64url'),
      Buffer.from(JSON.stringify({ ...cursor, createdAt: cursor.createdAt + 1 })).toString('base64url'),
      Buffer.from(JSON.stringify({ ...cursor, commandId: internalId })).toString('base64url')]) {
      assert.throws(() => f.journal.historyPage(f.admissionSessionA, badCursor), /cursor_invalid/);
    }
    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: randomUUID(), type: 'workspace.erase', canonicalRequest: '{}' }, () => ({
      snapshot: { accounts: [], notes: [] }, receipt: { kind: 'erase' }, privacyEpoch: 1,
    }));
    const newEpochSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    assert.throws(() => f.journal.historyPage(newEpochSession, first.nextCursor), /cursor_invalid/);
    assert.throws(() => f.journal.historyPage(f.admissionSessionA), /session|auth/i);
  } finally { close(f); }
});

test('journal schema v1 migrates in place and preserves prior rows', () => {
  const f = setup();
  try {
    const id = randomUUID();
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare(`INSERT INTO async_command_journal(workspace_id,idempotency_key,owner_id,session_digest,request_digest,command_kind,
        privacy_epoch,ticket_id,ticket_digest,status,created_at,updated_at,checkpoint_revision,snapshot_digest,owned_object_ids_json,receipt_json)
        VALUES(?,?,?,?,?,?,0,?,?,'claimed',10,10,NULL,NULL,NULL,NULL)`)
        .run(f.workspace.workspaceId, id, f.ownerId, 's'.repeat(64), 'r'.repeat(64), 'notes.save', randomUUID(), 't'.repeat(64));
      db.prepare('DROP INDEX async_command_journal_history_idx').run();
      db.prepare('UPDATE command_journal_schema SET version=1 WHERE singleton=1').run();
    });
    new CommandJournal(f.kernel);
    const version = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT version FROM command_journal_schema WHERE singleton=1').get());
    assert.equal(version.version, 2);
    assert.equal(f.journal.historyPage(f.admissionSessionA).entries[0].commandId, id);
  } finally { close(f); }
});

test('a checkpointed command recovered after restart becomes inspection-only and is never replayed', async () => {
  const f = setup();
  let restartedKernel;
  try {
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession, journal: f.journal });
    await store.load();
    const claimed = admission(f, { key: 'cmd:crash-after-checkpoint' });
    let executions = 0;
    await f.journal.run(claimed.ticket, f.runtimeSession, async () => {
      executions += 1;
      await store.save({ accounts: [], notes: [], marker: 'committed checkpoint' });
    });
    assert.equal(f.journal.inspect(f.admissionSessionA, 'cmd:crash-after-checkpoint').status, 'checkpointed');
    f.kernel.close();
    restartedKernel = createDurableKernel({ databasePath: f.databasePath,
      validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
    const restartedJournal = new CommandJournal(restartedKernel);
    assert.throws(() => restartedJournal.recoverInterrupted(() => false), /verified exclusive process ownership/i);
    assert.equal(restartedJournal.recoverInterrupted(() => true), 1);
    assert.equal(restartedJournal.inspect(f.admissionSessionB, 'cmd:crash-after-checkpoint').status, 'inspect_required');
    assert.equal(restartedKernel.getOwnedSnapshot(f.runtimeSession).snapshot.marker, 'committed checkpoint');
    const duplicate = restartedJournal.admit({ admissionSessionToken: f.admissionSessionB, expectedRevision: 1, expectedPrivacyEpoch: 0,
      idempotencyKey: 'cmd:crash-after-checkpoint', kind: 'test.operation', canonicalBody: '{"text":"same"}' });
    assert.equal(duplicate.fresh, false);
    assert.equal(duplicate.status, 'inspect_required');
    assert.equal(executions, 1, 'recovery and duplicate admission never rerun the operation');
  } finally {
    if (restartedKernel) restartedKernel.close();
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
