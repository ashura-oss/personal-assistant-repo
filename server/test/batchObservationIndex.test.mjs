import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AuthService, createDurableKernel } from '../dist/index.js';
import { BatchObservationIndex } from '../dist/batchObservationIndex.js';
import { recoverInterruptedBatchObservations } from '../dist/batchObservationIndex.js';
import { acquireApplicationOwnership, reserveApplicationStartup } from '../dist/applicationOwnership.js';
import { registerApplicationStartup } from '../dist/applicationStartup.js';

const ORIGIN = 'https://still.example';
const AUTH_SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-batch-observation-index-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'data.sqlite'), validateSnapshot(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  const auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, authSecret: AUTH_SECRET });
  const enrolled = await auth.enrollOwner('test only password', { notes: [] });
  const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, Date.now() + 60_000);
  return { directory, kernel, auth, actor, index: new BatchObservationIndex(), identity: kernel.getOwnedIdentity(actor) };
}

function projection(status = 'queued', overrides = {}) {
  return { schemaVersion: 1, valid: true, jobs: [{ jobId: randomUUID(), customId: randomUUID(), batchId: 'batch_fixture_1',
    requestSha256: 'a'.repeat(64), status, terminalObserved: false, ...overrides }] };
}

function cleanup(f) {
  try { f.auth.close(); } catch {}
  try { f.kernel.close(); } catch {}
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test('Batch observation index admits one exact GET attempt and persists deferred retry without replacing its journal identity', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const p = projection();
    const jobId = p.jobs[0].jobId;
    const reconcile = (value, at) => f.kernel.withOwnedTransaction(f.actor, f.identity.privacyEpoch, (context) => {
      f.index.reconcile(context, value, at);
    });
    reconcile(p, now);
    const claim = f.kernel.withOwnedTransaction(f.actor, f.identity.privacyEpoch, (context) => f.index.claim(context, 0, jobId, now));
    assert.ok(claim);
    assert.equal(claim.commandId, claim.attemptId);
    assert.equal(f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.claim(context, 0, jobId, now)), undefined);
    const retryAt = now + 90_000;
    const firstFinal = { kind: 'deferred', code: 'provider_pending', nextDueAt: retryAt, terminal: false };
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => {
      f.index.markDispatched(context, claim, now);
      f.index.settle(context, claim, firstFinal, now);
      f.index.settle(context, claim, firstFinal, now);
      assert.throws(() => f.index.settle(context, claim, { ...firstFinal, code: 'changed_result' }, now), /batch_observation_finalization_conflict/);
      assert.equal(f.index.readNextDueAt(context, 0), retryAt);
      assert.deepEqual(f.index.listDue(context, 0, retryAt - 1), []);
    });
    const retry = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.claim(context, 0, jobId, retryAt));
    assert.ok(retry);
    assert.notEqual(retry.attemptId, claim.attemptId);
    assert.notEqual(retry.commandId, claim.commandId);
    const laterRetryAt = retryAt + 3_600_000;
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => {
      f.index.markDispatched(context, retry, retryAt);
      f.index.settle(context, retry, { kind: 'deferred', code: 'provider_retry_after', nextDueAt: laterRetryAt, terminal: false }, retryAt);
      f.index.reconcile(context, p, retryAt + 30_000);
      assert.equal(f.index.readNextDueAt(context, 0), laterRetryAt);
      assert.deepEqual(f.index.listDue(context, 0, retryAt + 30_000), []);
    });
  } finally { cleanup(f); }
});

test('missing provider ID stays held, malformed projection quarantines only this workspace, and terminal proof stops automatic work', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const held = projection('submission_unknown', { batchId: undefined });
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => {
      f.index.reconcile(context, held, now);
      assert.equal(f.index.readNextDueAt(context, 0), null);
      f.index.reconcile(context, { schemaVersion: 1, valid: false, jobs: [] }, now + 1);
      assert.equal(f.index.readNextDueAt(context, 0), null);
      assert.throws(() => f.index.reconcile(context, { schemaVersion: 1, valid: true, jobs: [{ jobId: 'bad', customId: 'bad',
        batchId: 'batch_fixture_1', requestSha256: 'bad', status: 'queued', terminalObserved: false }] }, now + 2), /batch_observation_projection_invalid/);
      const terminal = projection('source_removed', { terminalObserved: true });
      f.index.reconcile(context, terminal, now + 3);
      assert.equal(f.index.readNextDueAt(context, 0), null);
      const malformedId = projection('queued', { jobId: 'not-a-uuid' });
      assert.throws(() => f.index.reconcile(context, malformedId, now + 4), /batch_observation_projection_invalid/);
      const malformedStatus = projection('queued', { status: ['queued'] });
      assert.throws(() => f.index.reconcile(context, malformedStatus, now + 5), /batch_observation_projection_invalid/);
    });
  } finally { cleanup(f); }
});

test('source-removed jobs remain GET-observable only while the exact provider pair is nonterminal', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const sourceRemoved = projection('source_removed');
    const jobId = sourceRemoved.jobs[0].jobId;
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.reconcile(context, sourceRemoved, now));
    const claim = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.claim(context, 0, jobId, now));
    assert.ok(claim);
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => {
      f.index.assertClaimMatchesCurrentLedger(context, claim, sourceRemoved);
      f.index.markDispatched(context, claim, now);
      f.index.settle(context, claim, { kind: 'completed', code: 'provider_terminal', nextDueAt: Number.MAX_SAFE_INTEGER, terminal: true }, now);
      f.index.reconcile(context, sourceRemoved, now + 1);
      assert.equal(f.index.readNextDueAt(context, 0), null);
    });
  } finally { cleanup(f); }
});

test('corrupt ledger recovery is scoped and a weakened partial unique index fails before schema repair writes', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const p = projection();
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.reconcile(context, p, now));
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare('DROP INDEX batch_observation_one_live_attempt').run();
      db.exec(`CREATE UNIQUE INDEX batch_observation_one_live_attempt ON batch_observation_attempts(workspace_id,owner_id,privacy_epoch,job_id) WHERE 0`);
    });
    assert.throws(() => f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.reconcile(context, p, now + 1)), /batch_observation_schema_invalid/);
    const predicate = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='batch_observation_one_live_attempt'").get().sql);
    assert.match(predicate, /WHERE 0$/i, 'the invalid index remains untouched instead of being silently recreated');
  } finally { cleanup(f); }
});

test('only one-use cold-start capability retires interrupted GET attempts for a fresh observation', async () => {
  const f = await fixture();
  let owner;
  let kernel;
  let startup;
  try {
    const now = Date.now();
    const p = projection();
    const jobId = p.jobs[0].jobId;
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.reconcile(context, p, now));
    const attempt = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.claim(context, 0, jobId, now));
    assert.ok(attempt);
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.markDispatched(context, attempt, now));
    f.auth.close();
    f.kernel.close();

    const databasePath = join(f.directory, 'data.sqlite');
    owner = acquireApplicationOwnership(databasePath);
    const reservation = reserveApplicationStartup(owner);
    kernel = createDurableKernel({ databasePath, applicationOwnership: owner, startupReservation: reservation,
      validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
    startup = registerApplicationStartup(kernel, owner, databasePath, randomUUID());
    startup.beginRecovery();
    const count = recoverInterruptedBatchObservations(kernel, startup.capability, now + 100);
    assert.equal(count, 1);
    assert.throws(() => recoverInterruptedBatchObservations(kernel, startup.capability, now + 101), /batch_observation_startup_recovery_invalid/);
    const rows = kernel.withColdStartDatabaseTransaction(startup.capability, (db) => ({
      attempt: db.prepare(`SELECT status,result_code,command_id,finalization_request_json FROM batch_observation_attempts WHERE attempt_id=?`).get(attempt.attemptId),
      job: db.prepare(`SELECT state,next_due_at FROM batch_observation_jobs WHERE job_id=?`).get(jobId),
    }));
    assert.equal(rows.attempt.status, 'deferred');
    assert.equal(rows.attempt.result_code, 'interrupted_get_retry');
    assert.equal(rows.attempt.command_id, attempt.commandId, 'the old async-journal identity is retained');
    assert.ok(rows.attempt.finalization_request_json);
    assert.deepEqual(rows.job, { state: 'due', next_due_at: now + 100 });
    startup.seal();
    assert.throws(() => recoverInterruptedBatchObservations(kernel, startup.capability, now + 102), /batch_observation_startup_recovery_invalid/);
  } finally {
    try { startup?.seal(); } catch {}
    try { f.auth.close(); } catch {}
    try { f.kernel.close(); } catch {}
    try { kernel?.close(); } catch {}
    try { owner?.release(); } catch {}
    cleanup(f);
  }
});

test('cold recovery rolls back when an active observation command links to another owner', async () => {
  const f = await fixture();
  let owner;
  let kernel;
  let startup;
  try {
    const now = Date.now();
    const p = projection();
    const jobId = p.jobs[0].jobId;
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.reconcile(context, p, now));
    const attempt = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.claim(context, 0, jobId, now));
    assert.ok(attempt);
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.markDispatched(context, attempt, now));
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.exec(`CREATE TABLE command_journal_schema(singleton INTEGER PRIMARY KEY,version INTEGER NOT NULL);
        INSERT INTO command_journal_schema(singleton,version) VALUES(1,3);
        CREATE TABLE async_command_journal(workspace_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,owner_id TEXT NOT NULL,
          privacy_epoch INTEGER NOT NULL,command_kind TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL,
          PRIMARY KEY(workspace_id,idempotency_key));`);
      db.prepare(`INSERT INTO async_command_journal(workspace_id,idempotency_key,owner_id,privacy_epoch,command_kind,status,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(f.identity.workspaceId, attempt.commandId, randomUUID(), 0, 'assistant.batch.check', 'claimed', now);
    });
    f.auth.close();
    f.kernel.close();

    const databasePath = join(f.directory, 'data.sqlite');
    owner = acquireApplicationOwnership(databasePath);
    const reservation = reserveApplicationStartup(owner);
    kernel = createDurableKernel({ databasePath, applicationOwnership: owner, startupReservation: reservation,
      validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
    startup = registerApplicationStartup(kernel, owner, databasePath, randomUUID());
    startup.beginRecovery();
    assert.throws(() => recoverInterruptedBatchObservations(kernel, startup.capability, now + 100), /batch_observation_journal_link_invalid/);
    const rows = kernel.withColdStartDatabaseTransaction(startup.capability, (db) => ({
      attempt: db.prepare('SELECT status,result_code FROM batch_observation_attempts WHERE attempt_id=?').get(attempt.attemptId),
      job: db.prepare('SELECT state,next_due_at FROM batch_observation_jobs WHERE job_id=?').get(jobId),
      journal: db.prepare('SELECT owner_id,status FROM async_command_journal WHERE idempotency_key=?').get(attempt.commandId),
    }));
    assert.deepEqual(rows.attempt, { status: 'dispatched', result_code: null });
    assert.deepEqual(rows.job, { state: 'due', next_due_at: Number.MAX_SAFE_INTEGER });
    assert.equal(rows.journal.status, 'claimed');
    assert.notEqual(rows.journal.owner_id, f.identity.ownerId);
  } finally {
    try { startup?.seal(); } catch {}
    try { f.auth.close(); } catch {}
    try { f.kernel.close(); } catch {}
    try { kernel?.close(); } catch {}
    try { owner?.release(); } catch {}
    cleanup(f);
  }
});

test('cold recovery ignores the same journal key in a different workspace', async () => {
  const f = await fixture();
  let owner;
  let kernel;
  let startup;
  try {
    const now = Date.now();
    const p = projection();
    const jobId = p.jobs[0].jobId;
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.reconcile(context, p, now));
    const attempt = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.claim(context, 0, jobId, now));
    assert.ok(attempt);
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.index.markDispatched(context, attempt, now));
    const otherWorkspaceId = randomUUID();
    const otherOwnerId = randomUUID();
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.exec(`CREATE TABLE command_journal_schema(singleton INTEGER PRIMARY KEY,version INTEGER NOT NULL);
        INSERT INTO command_journal_schema(singleton,version) VALUES(1,3);
        CREATE TABLE async_command_journal(workspace_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,owner_id TEXT NOT NULL,
          privacy_epoch INTEGER NOT NULL,command_kind TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL,
          PRIMARY KEY(workspace_id,idempotency_key));`);
      db.prepare(`INSERT INTO async_command_journal(workspace_id,idempotency_key,owner_id,privacy_epoch,command_kind,status,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(otherWorkspaceId, attempt.commandId, otherOwnerId, 0, 'assistant.batch.check', 'claimed', now);
    });
    f.auth.close();
    f.kernel.close();

    const databasePath = join(f.directory, 'data.sqlite');
    owner = acquireApplicationOwnership(databasePath);
    const reservation = reserveApplicationStartup(owner);
    kernel = createDurableKernel({ databasePath, applicationOwnership: owner, startupReservation: reservation,
      validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
    startup = registerApplicationStartup(kernel, owner, databasePath, randomUUID());
    startup.beginRecovery();
    assert.equal(recoverInterruptedBatchObservations(kernel, startup.capability, now + 100), 1);
    const rows = kernel.withColdStartDatabaseTransaction(startup.capability, (db) => ({
      attempt: db.prepare('SELECT status,result_code FROM batch_observation_attempts WHERE attempt_id=?').get(attempt.attemptId),
      otherJournal: db.prepare('SELECT workspace_id,owner_id,status FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?')
        .get(otherWorkspaceId, attempt.commandId),
    }));
    assert.deepEqual(rows.attempt, { status: 'deferred', result_code: 'interrupted_get_retry' });
    assert.deepEqual(rows.otherJournal, { workspace_id: otherWorkspaceId, owner_id: otherOwnerId, status: 'claimed' });
  } finally {
    try { startup?.seal(); } catch {}
    try { f.auth.close(); } catch {}
    try { f.kernel.close(); } catch {}
    try { kernel?.close(); } catch {}
    try { owner?.release(); } catch {}
    cleanup(f);
  }
});
