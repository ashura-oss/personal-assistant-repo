import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { CommandJournal } from '../dist/workspaceRuntime.js';
import { OwnedWorkspaceRuntime } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { RUNTIME_ACTOR_EXPIRES_AT } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import {
  canonicalWorkspaceCommand,
  dispatchWorkspaceCommand,
  inspectWorkspaceCommand,
  parseWorkspaceCommandEnvelope,
} from '../dist/workspaceCommands.node.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-workspace-commands-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const state = createInitialWorkspaceState(randomUUID);
  state.tasks.push({ id: 'legacy task: 1', title: 'A task', body: '', status: 'open', createdAt: '2026-10-14T00:00:00.000Z',
    importOrigin: { kind: 'backup_import', archiveId: randomUUID(), sourceTaskId: 'legacy task: 1' } });
  const workspace = kernel.createWorkspace(ownerId, state);
  const admissionSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const runtimeSession = kernel.createSession(workspace.workspaceId, ownerId, RUNTIME_ACTOR_EXPIRES_AT);
  const unavailable = async () => 'unavailable';
  const runtime = new OwnedWorkspaceRuntime({ kernel, runtimeSessionFor: () => runtimeSession,
    crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    providers: { speech: { async transcribe() { throw new Error('provider must not run'); }, async releaseUploadLease() {}, disposeMemory() {} },
      openAi: { async prepare() { throw new Error('provider must not run'); }, async analyze() { throw new Error('provider must not run'); }, async generateReply() { throw new Error('provider must not run'); } } },
    integration: {
      reminderBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async listPending() { return []; }, async schedule() {}, async cancel() {}, async cancelLegacy() {}, async installForegroundHandler() {} },
      mailAlertBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; } },
      deviceCalendarBackend: { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
        async listCalendars() { return []; }, async getCalendar() { return undefined; }, async readEvents() { return []; },
        async createApprovedEvent() { throw new Error('unsupported'); }, async lookupRecord() { return undefined; } },
      async writeDocument() {}, async removeAudio() {},
      async loadRecordingRecovery() { return { async pickAndStage() { return null; }, async inspect() { throw new Error('unsupported'); }, async remove() {} }; },
      bindRecordingRecovery(service) { return service; },
    } });
  const admission = { sessionToken: admissionSession, assertCurrent() { kernel.getOwnedIdentity(admissionSession); } };
  return { directory, kernel, ownerId, workspace, admissionSession, runtimeSession, runtime, admission };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function envelope(command, expectedRevision = 0, expectedPrivacyEpoch = 0, commandId = randomUUID()) {
  return { schemaVersion: 1, commandId, expectedRevision, expectedPrivacyEpoch, command };
}

test('shared command envelope enforces exact keys, UUIDs, revision fences, and physical text bounds', () => {
  const valid = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' });
  assert.deepEqual(parseWorkspaceCommandEnvelope(valid), valid);
  const reordered = { command: valid.command, expectedPrivacyEpoch: 0, commandId: valid.commandId,
    schemaVersion: 1, expectedRevision: 0 };
  assert.equal(canonicalWorkspaceCommand(valid), canonicalWorkspaceCommand(reordered));
  assert.throws(() => parseWorkspaceCommandEnvelope({ ...valid, extra: true }), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope({ ...valid, command: { ...valid.command, extra: 'ignored?' } }), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope({ ...valid, commandId: 'not-a-uuid' }), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope({ ...valid, expectedRevision: -1 }), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'chat.create', title: 'x'.repeat(5000) })), /workspace_command_invalid/);
  let getterRuns = 0;
  const accessorCommand = { kind: 'chat.create' };
  Object.defineProperty(accessorCommand, 'title', { enumerable: true, get() { getterRuns += 1; return 'unsafe'; } });
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope(accessorCommand)), /workspace_command_invalid/);
  assert.equal(getterRuns, 0, 'accessor payloads are rejected without executing caller code');
  const accessorDiscriminator = {};
  Object.defineProperty(accessorDiscriminator, 'kind', { enumerable: true, get() { getterRuns += 1; return 'chat.create'; } });
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope(accessorDiscriminator)), /workspace_command_invalid/);
  assert.equal(getterRuns, 0, 'the command discriminator is never read before payload descriptors are checked');
  assert.equal(parseWorkspaceCommandEnvelope(envelope({ kind: 'chat.create', title: 'x'.repeat(4096) })).command.title.length, 4096,
    'the maximum allowed title remains below the independent 16 KiB envelope physical bound');
});

test('explicit dispatcher calls only the task/chat allowlist and returns safe durable receipts', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' }, initial.revision, initial.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.deepEqual(Object.keys(first).sort(), ['commandId', 'receipt', 'schemaVersion', 'snapshot', 'status']);
    assert.deepEqual(first.receipt, { schemaVersion: 1, commandId: command.commandId, kind: 'tasks.complete', objectId: 'legacy task: 1' });
    assert.equal(first.status, 'finished');
    assert.equal(first.snapshot.state.tasks[0].status, 'completed');
    assert.equal('ticket' in first, false);
    assert.equal('result' in first, false);

    const replay = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(replay.status, 'finished');
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(replay.snapshot.revision, first.snapshot.revision);
    assert.equal(replay.snapshot.state.activity.filter((item) => item.message === 'Task completed: A task.').length, 1,
      'finished duplicate returns the original receipt without invoking the controller again');

    const chatCommand = envelope({ kind: 'chat.create', title: 'No model call' }, replay.snapshot.revision, replay.snapshot.privacyEpoch);
    const chat = await dispatchWorkspaceCommand(f.runtime, f.admission, chatCommand);
    assert.equal(chat.status, 'finished');
    assert.equal(chat.receipt.kind, 'chat.create');
    assert.ok(chat.snapshot.state.assistantChatConversations.some((item) => item.id === chat.receipt.objectId));
    const changed = { ...command, command: { kind: 'tasks.reopen', taskId: 'legacy task: 1' } };
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, changed), /already bound to different/);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a finished journal receipt with the right command ID but a different allowed kind is rejected without replay', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' }, initial.revision, initial.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(first.status, 'finished');

    const corruptedReceipt = { ...first.receipt, kind: 'tasks.reopen' };
    const db = new Database(join(f.directory, 'workspace.sqlite'));
    try {
      db.prepare(`UPDATE async_command_journal SET receipt_json=? WHERE workspace_id=? AND idempotency_key=?`)
        .run(JSON.stringify(corruptedReceipt), f.workspace.workspaceId, command.commandId);
    } finally { db.close(); }

    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, command), /workspace_command_receipt_invalid/);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, command.commandId).status, 'finished');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, command.commandId).receipt.kind, 'tasks.reopen',
      'the invalid durable receipt is not silently repaired or replaced');
    const snapshot = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(snapshot.state.activity.filter((item) => item.message === 'Task completed: A task.').length, 1,
      'the controller operation remains applied exactly once despite the invalid duplicate receipt');
    assert.equal(snapshot.state.tasks[0].status, 'completed');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a task receipt with the right command ID and kind but a different task ID is rejected without replay', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' }, initial.revision, initial.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(first.status, 'finished');

    const corruptedReceipt = { ...first.receipt, objectId: 'another task' };
    const db = new Database(join(f.directory, 'workspace.sqlite'));
    try {
      db.prepare(`UPDATE async_command_journal SET receipt_json=? WHERE workspace_id=? AND idempotency_key=?`)
        .run(JSON.stringify(corruptedReceipt), f.workspace.workspaceId, command.commandId);
    } finally { db.close(); }

    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, command), /workspace_command_receipt_invalid/);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, command.commandId).receipt.objectId, 'another task',
      'the invalid durable receipt remains inspectable as invalid source data, not silently repaired');
    const snapshot = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(snapshot.state.activity.filter((item) => item.message === 'Task completed: A task.').length, 1,
      'the original task operation was not replayed');
    assert.equal(snapshot.state.tasks[0].status, 'completed');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('read-only receipt inspection distinguishes missing, pending, finished and unknown outcomes during refresh-required state', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const journal = new CommandJournal(f.kernel);
    const finished = envelope({ kind: 'chat.create', title: 'finished' }, initial.revision, initial.privacyEpoch);
    const created = await dispatchWorkspaceCommand(f.runtime, f.admission, finished);
    const entered = deferred();
    const hold = deferred();
    const busyCommand = f.runtime.executeCommand({ ...f.admission, expectedRevision: created.snapshot.revision,
      expectedPrivacyEpoch: created.snapshot.privacyEpoch, idempotencyKey: randomUUID(), kind: 'test.wait', canonicalBody: '{}' }, async () => {
      entered.resolve();
      await hold.promise;
      return 'done';
    }, () => ({ kind: 'test.wait' }));
    await entered.promise;
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, finished.commandId).status, 'finished',
      'read-only receipt inspection remains available while another owned command is busy');
    hold.resolve();
    await busyCommand;

    const pending = envelope({ kind: 'tasks.reopen', taskId: 'legacy task: 1' }, created.snapshot.revision, created.snapshot.privacyEpoch);
    journal.admit({ admissionSessionToken: f.admissionSession, expectedRevision: created.snapshot.revision,
      expectedPrivacyEpoch: created.snapshot.privacyEpoch, idempotencyKey: pending.commandId, kind: pending.command.kind,
      canonicalBody: canonicalWorkspaceCommand(pending) });
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, pending.commandId).status, 'claimed');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, randomUUID()).status, 'unverified');

    let sideEffects = 0;
    const uncertain = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' }, created.snapshot.revision, created.snapshot.privacyEpoch);
    await assert.rejects(f.runtime.executeCommand({ ...f.admission, expectedRevision: uncertain.expectedRevision,
      expectedPrivacyEpoch: uncertain.expectedPrivacyEpoch, idempotencyKey: uncertain.commandId, kind: uncertain.command.kind,
      canonicalBody: canonicalWorkspaceCommand(uncertain) }, async (controller) => {
      sideEffects += 1;
      return controller.completeTask('legacy task: 1');
    }, () => { throw new Error('lost receipt acknowledgement'); }), /lost receipt acknowledgement/);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, finished.commandId).status, 'finished');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, finished.commandId).snapshot, undefined,
      'receipt inspection returns no cached or unfenced workspace snapshot');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, uncertain.commandId).status, 'inspect_required');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, randomUUID()).status, 'unverified');
    await assert.rejects(f.runtime.getSnapshot(f.admission), /workspace_refresh_required/);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, uncertain), /workspace_refresh_required/);
    assert.equal(sideEffects, 1, 'inspection during uncertainty never replays an operation');
    const refreshed = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(refreshed.revision, f.kernel.getOwnedIdentity(f.admissionSession).revision);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('receipt inspection still checks owner, privacy epoch, and caller authorization', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'chat.create' }, initial.revision, initial.privacyEpoch);
    await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    const otherOwnerId = randomUUID();
    const otherOwner = f.kernel.createWorkspace(otherOwnerId, createInitialWorkspaceState(randomUUID));
    const otherSession = f.kernel.createSession(otherOwner.workspaceId, otherOwnerId, Date.now() + 60 * 60_000);
    assert.equal(inspectWorkspaceCommand(f.runtime, { sessionToken: otherSession,
      assertCurrent() { f.kernel.getOwnedIdentity(otherSession); } }, command.commandId).status, 'unverified',
    'a command in another owner workspace is indistinguishable from an unverified ID');
    let allowed = true;
    assert.equal(inspectWorkspaceCommand(f.runtime, { ...f.admission, assertCurrent() {
      if (!allowed) throw new Error('inspection authorization revoked');
      f.kernel.getOwnedIdentity(f.admissionSession);
    } }, randomUUID()).status, 'unverified');
    allowed = false;
    assert.throws(() => inspectWorkspaceCommand(f.runtime, { ...f.admission, assertCurrent() {
      if (!allowed) throw new Error('inspection authorization revoked');
      f.kernel.getOwnedIdentity(f.admissionSession);
    } }, command.commandId), /inspection authorization revoked/);
    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: f.kernel.getOwnedIdentity(f.runtimeSession).revision,
      expectedPrivacyEpoch: 0, idempotencyKey: randomUUID(), type: 'workspace.erase', canonicalRequest: '{}' }, () => ({
      snapshot: createInitialWorkspaceState(randomUUID), receipt: { kind: 'erase' }, privacyEpoch: 1,
    }));
    const newSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    assert.throws(() => inspectWorkspaceCommand(f.runtime, { sessionToken: newSession,
      assertCurrent() { f.kernel.getOwnedIdentity(newSession); } }, command.commandId), /another workspace or privacy epoch/);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
