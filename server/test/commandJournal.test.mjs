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
