import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { CommandJournal, ServerWorkspaceStore } from '../dist/workspaceRuntime.js';
import { PrivateAudioRepository } from '../dist/privateAudioRepository.js';

const AUDIO_PROCESS_ID = randomUUID();

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

function wavFixture() {
  const sampleRate = 8000;
  const data = Buffer.alloc(1600, 128);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36, 'ascii'); bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}

async function* byteChunks(bytes) { yield bytes.subarray(0, 13); yield bytes.subarray(13); }

function commandEnvelope(commandId, command) {
  const captureCommand = { captureId: command.captureId, captureRevision: command.captureRevision, kind: 'notes.capture.adopt' };
  const envelope = { schemaVersion: 1, commandId, expectedRevision: 0, expectedPrivacyEpoch: 0, command: captureCommand };
  return { envelope, canonicalBody: JSON.stringify({ command: captureCommand, commandId, expectedPrivacyEpoch: 0,
    expectedRevision: 0, schemaVersion: 1 }) };
}

async function makeReadyCapture(f) {
  const privateRoot = join(f.directory, 'private-audio');
  const repository = new PrivateAudioRepository({ kernel: f.kernel, actorSessionToken: f.runtimeSession, privateRoot, processId: AUDIO_PROCESS_ID, resolveAttachedMedia: () => undefined });
  const captureId = randomUUID();
  const uploadId = randomUUID();
  const bytes = wavFixture();
  const receipt = await repository.uploadCapture(byteChunks(bytes), { uploadId, captureId,
    capturedAt: '2026-10-15T00:00:00.000Z', timeZone: 'Asia/Singapore', mimeType: 'audio/wav', expectedByteLength: bytes.length });
  assert.equal(receipt.status, 'ready');
  return { repository, receipt, bytes };
}

function adoptedState(base, receipt) {
  const mediaId = receipt.media.mediaId.slice('still-media:'.length);
  const note = { id: receipt.capture.id, title: 'Audio note', transcript: '', audioUri: receipt.media.mediaId,
    durationSeconds: receipt.media.durationSeconds, createdAt: '2026-10-15T00:00:00.000Z', capturedAt: receipt.capture.capturedAt,
    captureTimeZone: receipt.capture.timeZone, status: 'recorded', revision: 1 };
  const consumption = { id: receipt.capture.id, revision: receipt.capture.revision, noteId: receipt.capture.id,
    uploadId: receipt.uploadId, mediaId, sha256: receipt.media.sha256, byteLength: receipt.media.byteLength,
    format: receipt.media.format, mimeType: receipt.media.mimeType, durationSeconds: receipt.media.durationSeconds,
    capturedAt: receipt.capture.capturedAt, captureTimeZone: receipt.capture.timeZone };
  return { state: { ...base, notes: [note] }, consumption, note };
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

test('server capture adoption binds the journal command to one ready upload and atomically stores its note, receipt, and consumed marker', async () => {
  const f = setup();
  const journal = new CommandJournal(f.kernel);
  const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession, journal });
  try {
    const base = await store.load();
    const { repository, receipt } = await makeReadyCapture(f);
    const { state, consumption, note } = adoptedState(base, receipt);
    const commandId = randomUUID();
    const { canonicalBody } = commandEnvelope(commandId, { captureId: receipt.capture.id, captureRevision: receipt.capture.revision });
    const admitted = journal.admit({ admissionSessionToken: f.runtimeSession, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: commandId, kind: 'notes.capture.adopt', canonicalBody });
    assert.equal(admitted.fresh, true);
    const operationReceipt = { schemaVersion: 1, commandId, kind: 'notes.capture.adopt', objectId: receipt.capture.id,
      captureId: receipt.capture.id, captureRevision: receipt.capture.revision };
    await journal.run(admitted.ticket, f.runtimeSession, async () => {
      await store.save(state, { consumeServerPendingCapture: consumption });
    });
    assert.deepEqual(journal.finish({ ...admitted.ticket, runtimeSessionToken: f.runtimeSession }, operationReceipt), operationReceipt);
    const persisted = f.kernel.getOwnedSnapshot(f.runtimeSession);
    assert.deepEqual(JSON.parse(JSON.stringify(persisted.snapshot.notes)), [note]);
    assert.equal(persisted.revision, 1);
    assert.equal(repository.inspectCaptureUpload(receipt.uploadId).status, 'consumed');
    assert.equal(repository.readConsumedCaptureEvidence(receipt.capture.id), true);
    const duplicate = journal.admit({ admissionSessionToken: f.runtimeSession, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: commandId, kind: 'notes.capture.adopt', canonicalBody });
    assert.equal(duplicate.fresh, false);
    assert.deepEqual(duplicate.receipt, operationReceipt);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).revision, 1, 'a duplicate command does not add another note or attachment');
  } finally { close(f); }
});

test('capture adoption rejects a ticket bound to another capture and rolls back snapshot and receipt changes on an atomic write failure', async () => {
  const f = setup();
  const journal = new CommandJournal(f.kernel);
  const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.runtimeSession, journal });
  try {
    const base = await store.load();
    const { repository, receipt } = await makeReadyCapture(f);
    const { state, consumption } = adoptedState(base, receipt);
    const wrong = { captureId: randomUUID(), captureRevision: randomUUID() };
    const wrongId = randomUUID();
    const mismatched = commandEnvelope(wrongId, wrong);
    const wrongAdmission = journal.admit({ admissionSessionToken: f.runtimeSession, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: wrongId, kind: 'notes.capture.adopt', canonicalBody: mismatched.canonicalBody });
    await assert.rejects(journal.run(wrongAdmission.ticket, f.runtimeSession, () => store.save(state, { consumeServerPendingCapture: consumption })), /binding_mismatch/);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).revision, 0);
    assert.equal(repository.inspectCaptureUpload(receipt.uploadId).status, 'ready');

    await store.load();
    const commandId = randomUUID();
    const { canonicalBody } = commandEnvelope(commandId, { captureId: receipt.capture.id, captureRevision: receipt.capture.revision });
    const admitted = journal.admit({ admissionSessionToken: f.runtimeSession, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: commandId, kind: 'notes.capture.adopt', canonicalBody });
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TRIGGER reject_capture_consumption BEFORE UPDATE OF status ON private_audio_capture_uploads
      WHEN NEW.status='consumed' BEGIN SELECT RAISE(ABORT,'injected atomic capture fault'); END`));
    await assert.rejects(journal.run(admitted.ticket, f.runtimeSession, () => store.save(state, { consumeServerPendingCapture: consumption })), /injected atomic capture fault/);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).revision, 0, 'workspace snapshot rolls back with the failed capture consume');
    assert.equal(repository.inspectCaptureUpload(receipt.uploadId).status, 'ready', 'receipt remains adoptable after rollback');
    const journalStatus = journal.inspectIfExists(f.runtimeSession, commandId);
    assert.equal(journalStatus.status, 'inspect_required', 'the failed command is not replayed automatically');
  } finally { close(f); }
});
