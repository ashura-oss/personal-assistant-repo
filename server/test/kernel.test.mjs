import assert from 'node:assert/strict';
import { createHash as sha256 } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createDurableKernel, KernelError } from '../dist/index.js';
import { acquireApplicationOwnership } from '../dist/applicationOwnership.js';

const hash = (text) => sha256('sha256').update(text).digest('hex');

function setup() {
  const directory = mkdtempSync(join(process.cwd(), '.test-data-'));
  const databasePath = join(directory, 'kernel.sqlite');
  let time = 1_800_000_000_000;
  const now = () => time;
  const ownerId = randomUUID();
  const accountId = randomUUID();
  const validateSnapshot = (snapshot) => {
    assert.ok(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot));
    assert.ok(Number.isSafeInteger(snapshot.count));
  };
  const applicationOwnership = acquireApplicationOwnership(databasePath);
  const kernel = createDurableKernel({ databasePath, validateSnapshot, now, applicationOwnership });
  const workspace = kernel.createWorkspace(ownerId, { count: 0, label: 'private' });
  const session = kernel.createSession(workspace.workspaceId, ownerId, now() + 600_000);
  return { directory, databasePath, now, advance: (milliseconds) => { time += milliseconds; }, ownerId, accountId,
    validateSnapshot, applicationOwnership, kernel, workspace, session };
}

function command(kernel, session, snapshot, { key = randomUUID(), expectedRevision = snapshot.revision,
  expectedPrivacyEpoch = snapshot.privacyEpoch, request = { add: 1 }, mutate = undefined } = {}) {
  const canonicalRequest = JSON.stringify(request);
  return kernel.runLocalCommand(session, { expectedRevision, expectedPrivacyEpoch, idempotencyKey: key, type: 'counter.increment', canonicalRequest },
    ({ snapshot: current }) => mutate ? mutate(current) : ({ snapshot: { count: current.count + request.add, label: current.label }, receipt: { count: current.count + request.add } }));
}

function closeAndRemove(fixture, ...kernels) {
  for (const kernel of kernels) kernel.close();
  fixture.applicationOwnership.release();
  try { rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error; }
}

test('separate SQLite handles racing the same revision allow one commit and roll back a failed mutator', async () => {
  const f = setup();
  const second = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now,
    applicationOwnership: f.applicationOwnership });
  try {
    const snapshotA = f.kernel.getOwnedSnapshot(f.session);
    const snapshotB = second.getOwnedSnapshot(f.session);
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => command(f.kernel, f.session, snapshotA)),
      Promise.resolve().then(() => command(second, f.session, snapshotB)),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason?.code === 'stale_revision').length, 1);
    assert.equal(f.kernel.getOwnedSnapshot(f.session).snapshot.count, 1);

    const current = f.kernel.getOwnedSnapshot(f.session);
    assert.throws(() => command(f.kernel, f.session, current, { key: randomUUID(), mutate: () => { throw new Error('fixture rollback'); } }), /fixture rollback/);
    assert.equal(f.kernel.getOwnedSnapshot(f.session).revision, 1);
    assert.equal(f.kernel.getOwnedSnapshot(f.session).snapshot.count, 1);
  } finally { closeAndRemove(f, second); }
});

test('owner-scoped session denies another workspace and cannot be rebound by request data', () => {
  const f = setup();
  try {
    const otherOwner = randomUUID();
    const otherWorkspace = f.kernel.createWorkspace(otherOwner, { count: 40, label: 'other' });
    assert.throws(() => f.kernel.createSession(otherWorkspace.workspaceId, f.ownerId, f.now() + 60_000),
      (error) => error instanceof KernelError && error.code === 'forbidden');
    const before = f.kernel.getOwnedSnapshot(f.session);
    const receipt = command(f.kernel, f.session, before, { request: { add: 1, workspaceId: otherWorkspace.workspaceId } });
    assert.equal(receipt.revision, 1);
    assert.deepEqual({ ...f.kernel.getOwnedSnapshot(f.session).snapshot }, { count: 1, label: 'private' });
  } finally { closeAndRemove(f); }
});

test('session expiry and explicit revocation deny every subsequent read or write', () => {
  const f = setup();
  try {
    f.advance(600_000);
    assert.throws(() => f.kernel.getOwnedSnapshot(f.session), (error) => error instanceof KernelError && error.code === 'unauthenticated');
    const replacement = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, f.now() + 60_000);
    f.kernel.revokeSession(replacement);
    assert.throws(() => f.kernel.getOwnedSnapshot(replacement), (error) => error instanceof KernelError && error.code === 'unauthenticated');
  } finally { closeAndRemove(f); }
});

test('same idempotency key replays the saved receipt after restart before checking revision, changed body is rejected', () => {
  const f = setup();
  let reopened;
  try {
    const before = f.kernel.getOwnedSnapshot(f.session);
    const key = randomUUID();
    const committed = command(f.kernel, f.session, before, { key });
    f.kernel.close();
    reopened = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now,
      applicationOwnership: f.applicationOwnership });
    const replay = command(reopened, f.session, { ...before, revision: 0 }, { key });
    assert.deepEqual(replay, { ...committed, replayed: true });
    assert.throws(() => command(reopened, f.session, before, { key, request: { add: 2 } }),
      (error) => error instanceof KernelError && error.code === 'idempotency_conflict');
    assert.equal(reopened.getOwnedSnapshot(f.session).snapshot.count, 1);
  } finally { closeAndRemove(f, ...(reopened ? [reopened] : [])); }
});

test('one-use plans survive restart, bind server account generation and source hash, and consume only once', () => {
  const f = setup();
  let reopened;
  try {
    f.kernel.recordAccountGeneration(f.session, f.accountId, 7);
    const current = f.kernel.getOwnedSnapshot(f.session);
    const sourceHash = hash('selected-source');
    const plan = f.kernel.createOneUsePlan(f.session, { expectedRevision: current.revision, expectedPrivacyEpoch: current.privacyEpoch,
      accountId: f.accountId, sourceHash });
    f.kernel.close();
    reopened = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now,
      applicationOwnership: f.applicationOwnership });
    assert.equal(reopened.consumeOneUsePlan(f.session, plan.planId, sourceHash).planId, plan.planId);
    assert.throws(() => reopened.consumeOneUsePlan(f.session, plan.planId, sourceHash),
      (error) => error instanceof KernelError && error.code === 'plan_consumed');
  } finally { closeAndRemove(f, ...(reopened ? [reopened] : [])); }
});

test('expired plans and plans fenced by revision, privacy epoch, or account generation cannot be consumed', () => {
  const f = setup();
  try {
    f.kernel.recordAccountGeneration(f.session, f.accountId, 1);
    const create = () => {
      const current = f.kernel.getOwnedSnapshot(f.session);
      return f.kernel.createOneUsePlan(f.session, { expectedRevision: current.revision, expectedPrivacyEpoch: current.privacyEpoch,
        accountId: f.accountId, sourceHash: hash('bound-source') });
    };
    const expired = create();
    f.advance(5 * 60 * 1000);
    assert.throws(() => f.kernel.consumeOneUsePlan(f.session, expired.planId, expired.sourceHash),
      (error) => error instanceof KernelError && error.code === 'plan_expired');

    const staleRevision = create();
    const before = f.kernel.getOwnedSnapshot(f.session);
    command(f.kernel, f.session, before);
    assert.throws(() => f.kernel.consumeOneUsePlan(f.session, staleRevision.planId, staleRevision.sourceHash),
      (error) => error instanceof KernelError && error.code === 'stale_revision');
  } finally { closeAndRemove(f); }
});

test('account generation changes invalidate plans and wall-clock rollback is rejected', () => {
  const f = setup();
  try {
    f.kernel.recordAccountGeneration(f.session, f.accountId, 3);
    const current = f.kernel.getOwnedSnapshot(f.session);
    const plan = f.kernel.createOneUsePlan(f.session, { expectedRevision: current.revision, expectedPrivacyEpoch: current.privacyEpoch,
      accountId: f.accountId, sourceHash: hash('bound-source') });
    f.kernel.recordAccountGeneration(f.session, f.accountId, 4);
    assert.throws(() => f.kernel.consumeOneUsePlan(f.session, plan.planId, plan.sourceHash),
      (error) => error instanceof KernelError && error.code === 'stale_account');

    const currentAgain = f.kernel.getOwnedSnapshot(f.session);
    const rollbackPlan = f.kernel.createOneUsePlan(f.session, { expectedRevision: currentAgain.revision, expectedPrivacyEpoch: currentAgain.privacyEpoch,
      accountId: f.accountId, sourceHash: hash('bound-source') });
    f.advance(-1);
    assert.throws(() => f.kernel.consumeOneUsePlan(f.session, rollbackPlan.planId, rollbackPlan.sourceHash),
      (error) => error instanceof KernelError && error.code === 'clock_rollback');
  } finally { closeAndRemove(f); }
});

test('external attempts are claimed once, remain pending after restart, and settle immutably', () => {
  const f = setup();
  let reopened;
  try {
    f.kernel.recordAccountGeneration(f.session, f.accountId, 2);
    const current = f.kernel.getOwnedSnapshot(f.session);
    const plan = f.kernel.createOneUsePlan(f.session, { expectedRevision: current.revision, expectedPrivacyEpoch: current.privacyEpoch,
      accountId: f.accountId, sourceHash: hash('source') });
    const input = { planId: plan.planId, idempotencyKey: randomUUID(), payloadHash: hash('immutable-external-payload') };
    const claimed = f.kernel.claimExternalAttempt(f.session, input);
    assert.equal(claimed.status, 'pending');
    assert.equal(claimed.permission, 'perform_once');
    f.kernel.close();
    reopened = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now,
      applicationOwnership: f.applicationOwnership });
    const duplicate = reopened.claimExternalAttempt(f.session, input);
    assert.equal(duplicate.status, 'pending');
    assert.equal(duplicate.replayed, true);
    assert.equal('permission' in duplicate, false);
    assert.throws(() => reopened.claimExternalAttempt(f.session, { ...input, payloadHash: hash('different') }),
      (error) => error instanceof KernelError && error.code === 'idempotency_conflict');
    const settled = reopened.settleExternalAttempt(f.session, claimed.attemptId, 'unknown', { providerAccepted: 'unconfirmed' });
    assert.equal(settled.status, 'unknown');
    assert.deepEqual(reopened.settleExternalAttempt(f.session, claimed.attemptId, 'unknown', { providerAccepted: 'unconfirmed' }),
      { ...settled, replayed: true });
    assert.throws(() => reopened.settleExternalAttempt(f.session, claimed.attemptId, 'known', { providerAccepted: true }),
      (error) => error instanceof KernelError && error.code === 'attempt_settled');
    assert.equal(reopened.claimExternalAttempt(f.session, input).status, 'unknown');
  } finally { closeAndRemove(f, ...(reopened ? [reopened] : [])); }
});

test('privacy epoch advancement atomically revokes old sessions and preserves stored revision and state', () => {
  const f = setup();
  try {
    const before = f.kernel.getOwnedSnapshot(f.session);
    const result = command(f.kernel, f.session, before, { mutate: (snapshot) => ({
      snapshot: { count: snapshot.count + 1, label: snapshot.label }, receipt: { reset: true }, privacyEpoch: 1,
    }) });
    assert.equal(result.privacyEpoch, 1);
    assert.throws(() => f.kernel.getOwnedSnapshot(f.session), (error) => error instanceof KernelError && error.code === 'unauthenticated');
    const freshSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, f.now() + 60_000);
    const restored = f.kernel.getOwnedSnapshot(freshSession);
    assert.equal(restored.workspaceId, f.workspace.workspaceId);
    assert.equal(restored.revision, 1);
    assert.equal(restored.privacyEpoch, 1);
    assert.equal(restored.schemaVersion, 1);
    assert.deepEqual({ ...restored.snapshot }, { count: 1, label: 'private' });
  } finally { closeAndRemove(f); }
});

test('trusted snapshot replacement validation requires this kernel active transaction and its strict validator', () => {
  const f = setup();
  const second = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now,
    applicationOwnership: f.applicationOwnership });
  try {
    let expiredContext;
    const result = f.kernel.withOwnedTransaction(f.session, 0, (context) => {
      expiredContext = context;
      return f.kernel.validateOwnedSnapshotReplacement(context, { count: 0, label: 'replacement' });
    });
    assert.deepEqual(JSON.parse(result.canonicalJson), { count: 0, label: 'replacement' });
    assert.equal(result.schemaVersion, 1);
    assert.equal(f.kernel.getOwnedSnapshot(f.session).revision, 0, 'validation does not write a snapshot or revision');
    assert.throws(() => f.kernel.validateOwnedSnapshotReplacement(expiredContext, { count: 0, label: 'replacement' }),
      (error) => error instanceof KernelError && error.code === 'transaction_context_expired');
    second.withOwnedTransaction(f.session, 0, (foreignContext) => {
      assert.throws(() => f.kernel.validateOwnedSnapshotReplacement(foreignContext, { count: 0, label: 'replacement' }),
        (error) => error instanceof KernelError && error.code === 'transaction_context_expired');
    });
    f.kernel.withOwnedTransaction(f.session, 0, (context) => {
      assert.throws(() => f.kernel.validateOwnedSnapshotReplacement(context, { count: 'invalid', label: 'replacement' }));
    });
    assert.throws(() => f.kernel.validateOwnedSnapshotReplacement({ workspaceId: f.workspace.workspaceId }, { count: 0, label: 'replacement' }),
      (error) => error instanceof KernelError && error.code === 'transaction_context_expired');
    assert.equal(f.kernel.getOwnedSnapshot(f.session).revision, 0);
  } finally { closeAndRemove(f, second); }
});

test('newer schemas and corrupt database files fail closed rather than being rewritten', () => {
  const f = setup();
  try {
    const inspect = new Database(f.databasePath);
    inspect.pragma('user_version = 999');
    inspect.close();
    f.kernel.close();
    assert.throws(() => createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now,
      applicationOwnership: f.applicationOwnership }),
      (error) => error instanceof KernelError && error.code === 'newer_schema');
    const brokenPath = join(f.directory, 'broken.sqlite');
    writeFileSync(brokenPath, 'not a SQLite database');
    assert.throws(() => createDurableKernel({ databasePath: brokenPath, validateSnapshot: f.validateSnapshot, now: f.now }));
  } finally {
    f.applicationOwnership.release();
    try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error; }
  }
});
