import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { CommandJournal, ServerWorkspaceStore, withCommandTicket } from '../dist/workspaceRuntime.js';
import { SpeechCleanupChildren } from '../dist/speechCleanupChildren.js';

function initialSnapshot() {
  const makeAttempt = (id, leaseId, noteId, provider = 'azure') => ({
    id, leaseId, noteId, provider, outcome: 'unknown', dispatchStarted: true,
    sourceRevision: 4, createdAt: '2026-10-15T01:02:03.000Z', endpoint: provider === 'azure' ? 'https://speech.example.invalid' : 'https://openrouter.ai/api/v1/audio/transcriptions',
    source: { audioUri: 'file:///private/audio', durationSeconds: 3, capturedAt: '2026-10-15T01:00:00.000Z', captureTimeZone: 'Asia/Singapore', speechEnabled: true, maxAudioSeconds: 600, provider },
  });
  const attemptA = randomUUID(); const leaseA = randomUUID(); const noteA = randomUUID();
  const attemptB = randomUUID(); const leaseB = randomUUID(); const noteB = randomUUID();
  return {
    accounts: [],
    notes: [{ id: noteA, transcript: 'copy stays unchanged' }, { id: noteB, transcript: 'other clip stays unchanged' }],
    task: { id: 'task-opaque', title: 'unrelated workspace field' },
    transcription: { schemaVersion: 1, installationUUID: randomUUID(), attempts: [
      makeAttempt(attemptA, leaseA, noteA), makeAttempt(attemptB, leaseB, noteB, 'openrouter'),
    ], cleanupLeases: [
      { attemptId: attemptA, leaseId: leaseA, createdAt: '2026-10-15T01:02:04.000Z', outcome: 'owned' },
      { attemptId: attemptB, leaseId: leaseB, createdAt: '2026-10-15T01:02:05.000Z', outcome: 'owned' },
    ] },
  };
}

function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-speech-cleanup-child-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const kernel = createDurableKernel({ databasePath, validateSnapshot: (value) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  const ownerId = randomUUID();
  const snapshot = initialSnapshot();
  const workspace = kernel.createWorkspace(ownerId, snapshot);
  const expires = Date.now() + 60 * 60_000;
  const browserSession = kernel.createSession(workspace.workspaceId, ownerId, expires);
  const runtimeSession = kernel.createSession(workspace.workspaceId, ownerId, expires);
  const journal = new CommandJournal(kernel);
  const processInstanceId = randomUUID();
  const service = new SpeechCleanupChildren({ kernel, journal, runtimeSessionToken: runtimeSession,
    processInstanceId, ...options });
  return { directory, databasePath, kernel, ownerId, workspace, snapshot, browserSession, runtimeSession,
    journal, processInstanceId, service };
}

function cleanup(f, ...extra) {
  for (const kernel of [f.kernel, ...extra.map((item) => item.kernel).filter(Boolean)]) {
    try { kernel.close(); } catch { /* fixture cleanup */ }
  }
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function ids(f, which = 'A') {
  const index = which === 'A' ? 0 : 1;
  const attempt = f.snapshot.transcription.attempts[index];
  return { attemptId: attempt.id, leaseId: attempt.leaseId, noteId: attempt.noteId, provider: attempt.provider };
}

function admitParent(f, key = 'cmd:speech:parent') {
  const identity = f.kernel.getOwnedIdentity(f.browserSession);
  return f.journal.admit({ admissionSessionToken: f.browserSession, expectedRevision: identity.revision,
    expectedPrivacyEpoch: identity.privacyEpoch, idempotencyKey: key, kind: 'notes.transcribe', canonicalBody: '{"note":"voice"}' });
}

async function registerUnderParent(f, input = ids(f), key = 'cmd:speech:parent') {
  const admitted = admitParent(f, key);
  let registration;
  await f.journal.run(admitted.ticket, f.runtimeSession, async () => {
    registration = f.service.registerCurrentChild(input);
  });
  return { admitted, registration, ticketContext: { ...admitted.ticket, runtimeSessionToken: f.runtimeSession } };
}

test('registration is bound to the active parent and exact persisted attempt/lease; duplicates reuse one child', async () => {
  const f = setup();
  try {
    const admitted = admitParent(f);
    let first; let duplicate;
    await f.journal.run(admitted.ticket, f.runtimeSession, async () => {
      first = f.service.registerCurrentChild(ids(f));
      duplicate = f.service.registerCurrentChild(ids(f));
      assert.equal(first.childId, duplicate.childId);
      assert.equal(first.handle, duplicate.handle);
      assert.throws(() => f.service.registerCurrentChild({ ...ids(f), noteId: randomUUID() }), /match|binding|different|note/i);
    });
    assert.equal(first.status, 'owned');
    assert.ok(first.handle);
    const exactRows = f.kernel.withOwnedTransaction(f.runtimeSession, 0, (context) =>
      context.db.prepare('SELECT COUNT(*) AS count FROM speech_cleanup_children WHERE workspace_id=?').get(f.workspace.workspaceId).count);
    assert.equal(exactRows, 1);
    assert.equal(JSON.stringify(f.service.inspect(first.childId)).includes(f.runtimeSession), false);
    const ticketContext = { ...admitted.ticket, runtimeSessionToken: f.runtimeSession };
    f.journal.finish(ticketContext, { kind: 'transcription.done' });
    await assert.rejects(withCommandTicket(ticketContext, async () => f.service.registerCurrentChild(ids(f))), /active command parent/i);
  } finally { cleanup(f); }
});

test('an unrelated active command cannot register a speech cleanup child', async () => {
  const f = setup();
  try {
    const admitted = f.journal.admit({ admissionSessionToken: f.browserSession, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: 'cmd:unrelated', kind: 'notes.update', canonicalBody: '{"note":"edit"}' });
    await assert.rejects(f.journal.run(admitted.ticket, f.runtimeSession, async () => f.service.registerCurrentChild(ids(f))), /named transcription/i);
    const count = f.kernel.withOwnedTransaction(f.runtimeSession, 0, (context) =>
      context.db.prepare('SELECT COUNT(*) AS count FROM speech_cleanup_children').get().count);
    assert.equal(count, 0);
  } finally { cleanup(f); }
});

test('private runtime actor can settle after browser logout; only the named lease changes and finished parent cannot checkpoint', async () => {
  const f = setup();
  try {
    const { admitted, registration, ticketContext } = await registerUnderParent(f);
    f.journal.finish(ticketContext, { kind: 'transcription.done' });
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession, journal: f.journal });
    await store.load();
    await assert.rejects(withCommandTicket(ticketContext, () => store.save({ ...f.snapshot, marker: 'must not write' })), /active|checkpoint|finished/i);

    f.kernel.revokeSession(f.browserSession);
    const pending = f.service.settle(registration.handle, 'pending_cleanup');
    assert.equal(pending.outcome, 'pending_cleanup');
    assert.equal(pending.revision, 1);
    const afterPending = f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot;
    assert.equal(afterPending.transcription.cleanupLeases[0].outcome, 'pending_cleanup');
    assert.equal(afterPending.transcription.cleanupLeases[1].outcome, 'owned');
    assert.equal(canonical(afterPending.notes), canonical(f.snapshot.notes));
    assert.equal(canonical(afterPending.transcription.attempts), canonical(f.snapshot.transcription.attempts));
    assert.equal(canonical(afterPending.task), canonical(f.snapshot.task));

    const released = f.service.settle(registration.handle, 'released');
    assert.equal(released.revision, 2);
    assert.equal(released.outcome, 'released');
    const afterRelease = f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot;
    assert.equal(afterRelease.transcription.cleanupLeases[0].outcome, 'released');
    assert.equal(afterRelease.transcription.cleanupLeases[1].outcome, 'owned');

    // Exact duplicate receipts return their original revision without parsing the current snapshot.
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE workspaces SET snapshot_json=? WHERE id=?').run('{', f.workspace.workspaceId));
    assert.deepEqual(f.service.settle(registration.handle, 'pending_cleanup'), {
      childId: registration.childId, outcome: 'pending_cleanup', revision: 1, replayed: true,
    });
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE workspaces SET snapshot_json=? WHERE id=?').run(canonical(f.snapshot), f.workspace.workspaceId));
    assert.equal(admitted.status, 'claimed');
  } finally { cleanup(f); }
});

test('settlement never regresses a released lease or claims an unrelated clip', async () => {
  const f = setup();
  try {
    const { registration } = await registerUnderParent(f);
    assert.equal(f.service.settle(registration.handle, 'released').outcome, 'released');
    assert.throws(() => f.service.settle(registration.handle, 'pending_cleanup'), /transition|state|bound/i);
    const state = f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot;
    assert.equal(state.transcription.cleanupLeases[0].outcome, 'released');
    assert.equal(state.transcription.cleanupLeases[1].outcome, 'owned');
  } finally { cleanup(f); }
});

test('restart preserves child evidence but does not restore an owned cleanup handle', async () => {
  const f = setup();
  let restartedKernel;
  try {
    const { admitted, registration, ticketContext } = await registerUnderParent(f);
    const sameProcessRecreation = new SpeechCleanupChildren({ kernel: f.kernel, journal: f.journal,
      runtimeSessionToken: f.runtimeSession, processInstanceId: f.processInstanceId });
    const duplicateWithoutRestoredCapability = await withCommandTicket(ticketContext, async () => sameProcessRecreation.registerCurrentChild(ids(f)));
    assert.equal(duplicateWithoutRestoredCapability.childId, registration.childId);
    assert.equal(duplicateWithoutRestoredCapability.handle, undefined);
    f.kernel.close();
    restartedKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: (value) => {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    } });
    const journal = new CommandJournal(restartedKernel);
    const restarted = new SpeechCleanupChildren({ kernel: restartedKernel, journal, runtimeSessionToken: f.runtimeSession,
      processInstanceId: randomUUID() });
    const inspected = restarted.inspect(registration.childId);
    assert.equal(inspected.status, 'inspect_required');
    assert.equal(inspected.parentTicketId, admitted.ticket.ticketId);
    assert.throws(() => restarted.settle({ childId: registration.childId }, 'released'), /handle|active/i);
    const duplicate = await withCommandTicket(ticketContext, async () => restarted.registerCurrentChild(ids(f)));
    assert.equal(duplicate.childId, registration.childId);
    assert.equal(duplicate.status, 'inspect_required');
    assert.equal(duplicate.handle, undefined);
  } finally { cleanup(f, ...(restartedKernel ? [{ kernel: restartedKernel }] : [])); }
});

test('a service instance cannot invalidate another live child, including another workspace', async () => {
  const f = setup();
  try {
    const { registration: first } = await registerUnderParent(f);
    const otherSnapshot = initialSnapshot();
    const otherWorkspace = f.kernel.createWorkspace(f.ownerId, otherSnapshot);
    const otherBrowser = f.kernel.createSession(otherWorkspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    const otherRuntime = f.kernel.createSession(otherWorkspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    const otherAdmitted = f.journal.admit({ admissionSessionToken: otherBrowser, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: 'cmd:speech:other-workspace', kind: 'notes.transcribe', canonicalBody: '{"note":"other"}' });
    const otherService = new SpeechCleanupChildren({ kernel: f.kernel, journal: f.journal,
      runtimeSessionToken: otherRuntime, processInstanceId: f.processInstanceId });
    let second;
    await f.journal.run(otherAdmitted.ticket, otherRuntime, async () => { second = otherService.registerCurrentChild(ids({ snapshot: otherSnapshot })); });

    const newProcessService = new SpeechCleanupChildren({ kernel: f.kernel, journal: f.journal,
      runtimeSessionToken: f.runtimeSession, processInstanceId: randomUUID() });
    assert.equal(newProcessService.inspect(first.childId).status, 'inspect_required');
    assert.equal(f.service.inspect(first.childId).status, 'owned');
    assert.equal(otherService.inspect(second.childId).status, 'owned');
    assert.equal(f.service.settle(first.handle, 'pending_cleanup').outcome, 'pending_cleanup');
    assert.equal(otherService.settle(second.handle, 'released').outcome, 'released');
  } finally { cleanup(f); }
});

test('privacy epoch changes invalidate both child inspection and settlement authority', async () => {
  const f = setup();
  try {
    const { registration } = await registerUnderParent(f);
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE workspaces SET privacy_epoch=1 WHERE id=?').run(f.workspace.workspaceId));
    assert.throws(() => f.service.settle(registration.handle, 'released'), /epoch|session|privacy/i);
    assert.throws(() => f.service.inspect(registration.childId), /epoch|session|privacy/i);
  } finally { cleanup(f); }
});

test('each settlement write failure rolls back all prior writes and preserves the exact handle for retry', async (t) => {
  const boundaries = [
    ['workspace snapshot update', `CREATE TRIGGER fail_workspace_update BEFORE UPDATE OF snapshot_json ON workspaces
      BEGIN SELECT RAISE(ABORT,'test workspace update failure'); END;`, 'DROP TRIGGER fail_workspace_update', /test workspace update failure/i],
    ['command receipt insert', `CREATE TRIGGER fail_command_insert BEFORE INSERT ON commands WHEN NEW.command_type='${'speech.cleanup.child.settle'}'
      BEGIN SELECT RAISE(ABORT,'test command insert failure'); END;`, 'DROP TRIGGER fail_command_insert', /test command insert failure/i],
    ['child status update', `CREATE TRIGGER fail_child_update BEFORE UPDATE ON speech_cleanup_children
      BEGIN SELECT RAISE(ABORT,'test child update failure'); END;`, 'DROP TRIGGER fail_child_update', /test child update failure/i],
  ];
  for (const [label, createTrigger, dropTrigger, expectedError] of boundaries) await t.test(label, async () => {
    const f = setup();
    try {
      const { registration } = await registerUnderParent(f);
      f.kernel.withTrustedDatabaseTransaction((db) => db.exec(createTrigger));
      assert.throws(() => f.service.settle(registration.handle, 'pending_cleanup'), expectedError);
      const snapshot = f.kernel.getOwnedSnapshot(f.runtimeSession);
      assert.equal(snapshot.revision, 0);
      assert.equal(canonical(snapshot.snapshot), canonical(f.snapshot));
      const persisted = f.kernel.withOwnedTransaction(f.runtimeSession, 0, (context) => ({
        commands: context.db.prepare("SELECT COUNT(*) AS count FROM commands WHERE command_type='speech.cleanup.child.settle'").get().count,
        child: context.db.prepare('SELECT status FROM speech_cleanup_children WHERE child_id=?').get(registration.childId).status,
      }));
      assert.deepEqual(persisted, { commands: 0, child: 'owned' });
      f.kernel.withTrustedDatabaseTransaction((db) => db.exec(dropTrigger));
      assert.equal(f.service.settle(registration.handle, 'pending_cleanup').revision, 1);
    } finally { cleanup(f); }
  });
});

test('settlement revalidates the current attempt, note, provider and lease before any write', async (t) => {
  const tamper = [
    ['provider changed', (snapshot) => { snapshot.transcription.attempts[0].provider = 'openrouter'; }],
    ['note removed', (snapshot) => { snapshot.notes = snapshot.notes.filter((note) => note.id !== snapshot.transcription.attempts[0].noteId); }],
    ['attempt removed', (snapshot) => { snapshot.transcription.attempts = snapshot.transcription.attempts.slice(1); }],
  ];
  for (const [label, alter] of tamper) await t.test(label, async () => {
    const f = setup();
    try {
      const { registration } = await registerUnderParent(f);
      const changed = structuredClone(f.snapshot);
      alter(changed);
      f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE workspaces SET snapshot_json=? WHERE id=?')
        .run(canonical(changed), f.workspace.workspaceId));
      assert.throws(() => f.service.settle(registration.handle, 'pending_cleanup'), /attempt|note|cleanup child binding|speech attempt|persisted speech/i);
      const row = f.kernel.withOwnedTransaction(f.runtimeSession, 0, (context) => ({
        commands: context.db.prepare("SELECT COUNT(*) AS count FROM commands WHERE command_type='speech.cleanup.child.settle'").get().count,
        child: context.db.prepare('SELECT status FROM speech_cleanup_children WHERE child_id=?').get(registration.childId).status,
        snapshot: context.db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(f.workspace.workspaceId).snapshot_json,
      }));
      assert.equal(row.commands, 0);
      assert.equal(row.child, 'owned');
      assert.equal(row.snapshot, canonical(changed));
    } finally { cleanup(f); }
  });
});

test('lost settlement acknowledgement requires inspection and cannot replay from the same handle', async () => {
  const f = setup({ afterCommitForTesting: () => { throw new Error('simulated lost acknowledgement'); } });
  try {
    const { registration } = await registerUnderParent(f);
    assert.throws(() => f.service.settle(registration.handle, 'pending_cleanup'), /lost acknowledgement/i);
    const inspection = f.service.inspect(registration.childId);
    assert.equal(inspection.status, 'pending_cleanup');
    assert.equal(inspection.refreshRequired, true);
    assert.deepEqual(inspection.lastSettlement, {
      outcome: 'pending_cleanup', revision: 1, idempotencyKey: `speech-cleanup:${registration.childId}:pending_cleanup`,
    });
    assert.throws(() => f.service.settle(registration.handle, 'pending_cleanup'), /refresh/i);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).revision, 1);
  } finally { cleanup(f); }
});

test('lost settlement ACK clears only after explicit controller load proves exact child receipt and adopted bytes', async () => {
  const f = setup({ afterCommitForTesting: () => { throw new Error('simulated lost acknowledgement'); } });
  try {
    const { registration } = await registerUnderParent(f);
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession, journal: f.journal });
    await store.load();
    const staleProof = store.getLoadedStateProof();
    assert.throws(() => f.service.settle(registration.handle, 'pending_cleanup'), /lost acknowledgement/i);
    const inspection = f.service.inspect(registration.childId);
    const expected = { childId: registration.childId, outcome: 'pending_cleanup',
      idempotencyKey: inspection.lastSettlement.idempotencyKey, revision: inspection.lastSettlement.revision };
    assert.throws(() => f.service.acknowledgeAfterRefresh(registration.handle, staleProof, expected), /proof|current|refresh/i);
    assert.equal(f.service.inspect(registration.childId).refreshRequired, true);

    await store.load(); // Explicit controller refresh adopts the committed settlement snapshot.
    const adoptedProof = store.getLoadedStateProof();
    assert.equal(adoptedProof.revision, expected.revision);
    f.service.acknowledgeAfterRefresh(registration.handle, adoptedProof, expected);
    assert.equal(f.service.inspect(registration.childId).refreshRequired, undefined);
    assert.throws(() => f.service.acknowledgeAfterRefresh(registration.handle, adoptedProof, expected), /does not require refresh/i);
  } finally { cleanup(f); }
});

test('lost settlement ACK accepts a newer adopted head only when it still contains the exact receipt outcome', async () => {
  const f = setup({ afterCommitForTesting: () => { throw new Error('simulated lost acknowledgement'); } });
  try {
    const { registration } = await registerUnderParent(f);
    assert.throws(() => f.service.settle(registration.handle, 'pending_cleanup'), /lost acknowledgement/i);
    const inspection = f.service.inspect(registration.childId);
    const expected = { childId: registration.childId, outcome: 'pending_cleanup',
      idempotencyKey: inspection.lastSettlement.idempotencyKey, revision: inspection.lastSettlement.revision };
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession, journal: f.journal });
    await store.load();
    const later = structuredClone(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot);
    later.task.title = 'an unrelated later command';
    await store.save(later);
    await store.load();
    const adoptedProof = store.getLoadedStateProof();
    assert.ok(adoptedProof.revision > expected.revision);
    f.service.acknowledgeAfterRefresh(registration.handle, adoptedProof, expected);
    assert.equal(f.service.inspect(registration.childId).refreshRequired, undefined);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.transcription.cleanupLeases[0].outcome, 'pending_cleanup');
  } finally { cleanup(f); }
});

test('a lost settlement acknowledgement is inspection-only after a process restart', async () => {
  const f = setup({ afterCommitForTesting: () => { throw new Error('simulated lost acknowledgement'); } });
  let restartedKernel;
  try {
    const { registration } = await registerUnderParent(f);
    assert.throws(() => f.service.settle(registration.handle, 'pending_cleanup'), /lost acknowledgement/i);
    f.kernel.close();
    restartedKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: (value) => {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    } });
    const restarted = new SpeechCleanupChildren({ kernel: restartedKernel, journal: new CommandJournal(restartedKernel),
      runtimeSessionToken: f.runtimeSession, processInstanceId: randomUUID() });
    const inspection = restarted.inspect(registration.childId);
    assert.equal(inspection.status, 'inspect_required');
    assert.deepEqual(inspection.lastSettlement, {
      outcome: 'pending_cleanup', revision: 1, idempotencyKey: `speech-cleanup:${registration.childId}:pending_cleanup`,
    });
    assert.throws(() => restarted.settle(registration.handle, 'released'), /handle|active/i);
  } finally { cleanup(f, ...(restartedKernel ? [{ kernel: restartedKernel }] : [])); }
});

function canonical(value) {
  const stable = (item) => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(stable);
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])]));
  };
  return JSON.stringify(stable(value));
}
