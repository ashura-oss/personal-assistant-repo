import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { constants, closeSync, openSync } from 'node:fs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireApplicationOwnership, reserveApplicationStartup } from '../dist/applicationOwnership.js';
import { createApplicationStartupCursor, createApplicationStartupIntentCursor, registerApplicationStartup } from '../dist/applicationStartup.js';
import { AudioColdStartRecovery } from '../dist/audioColdStartRecovery.js';
import { createDurableKernel } from '../dist/kernel.js';
import { CommandJournal } from '../dist/commandJournal.js';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-cold-audio-'));
  const databasePath = join(directory, 'workspace.sqlite');
  createAudioSchema(databasePath);
  const ownership = acquireApplicationOwnership(databasePath);
  const startupReservation = reserveApplicationStartup(ownership);
  const kernel = createDurableKernel({ databasePath, applicationOwnership: ownership, startupReservation, validateSnapshot(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  new CommandJournal(kernel);
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { notes: [] });
  const privateRoot = join(directory, 'private-audio');
  const processInstanceId = randomUUID();
  const startup = registerApplicationStartup(kernel, ownership, databasePath, processInstanceId);
  startup.beginRecovery();
  const capability = startup.capability;
  const workspaceDirectory = join(privateRoot, workspace.workspaceId);
  mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
  return { directory, databasePath, ownership, kernel, ownerId, workspace, privateRoot, workspaceDirectory, processInstanceId, startup, capability };
}
function createAudioSchema(databasePath) {
  const db = new Database(databasePath);
  try {
    db.exec(`CREATE TABLE private_audio_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL) STRICT;
      INSERT INTO private_audio_schema VALUES (1,4);
      CREATE TABLE private_audio_uploads (upload_id TEXT PRIMARY KEY,media_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,
        privacy_epoch INTEGER NOT NULL,status TEXT NOT NULL,temp_name TEXT NOT NULL,final_name TEXT NOT NULL,file_name TEXT NOT NULL,format TEXT NOT NULL,
        mime_type TEXT NOT NULL,expected_bytes INTEGER,sha256 TEXT,byte_length INTEGER,duration_seconds REAL,process_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE private_audio_speech_leases (lease_id TEXT PRIMARY KEY,upload_id TEXT NOT NULL,media_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL,note_id TEXT NOT NULL,note_revision INTEGER NOT NULL,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,
        duration_seconds REAL NOT NULL,process_id TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(upload_id) REFERENCES private_audio_uploads(upload_id)) STRICT;
      CREATE TABLE private_audio_readers (reader_id TEXT PRIMARY KEY,media_id TEXT NOT NULL,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,
        privacy_epoch INTEGER NOT NULL,process_id TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE private_audio_capture_uploads (upload_id TEXT PRIMARY KEY,capture_id TEXT NOT NULL UNIQUE,capture_revision TEXT NOT NULL,workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL,captured_at TEXT NOT NULL,time_zone TEXT NOT NULL,mime_type TEXT NOT NULL,expected_bytes INTEGER,
        media_id TEXT NOT NULL,format TEXT NOT NULL,sha256 TEXT,byte_length INTEGER,duration_seconds REAL,status TEXT NOT NULL,failure_code TEXT,
        consumed_command_id TEXT,note_id TEXT,note_revision INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE private_audio_cleanup_intents (intent_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL,
        media_id TEXT NOT NULL,source_note_id TEXT NOT NULL,snapshot_revision INTEGER NOT NULL,command_id TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        UNIQUE(workspace_id,owner_id,privacy_epoch,media_id),FOREIGN KEY(media_id) REFERENCES private_audio_uploads(media_id)) STRICT;
      CREATE INDEX private_audio_cleanup_intents_pending ON private_audio_cleanup_intents(workspace_id,owner_id,privacy_epoch,status,created_at,intent_id);
      CREATE INDEX private_audio_reader_media ON private_audio_readers(media_id);`);
  } finally { db.close(); }
}
function insertPending(f, id = randomUUID(), { commandId = null, commandEpoch = 0 } = {}) {
  const uploadId = randomUUID();
  const mediaId = randomUUID();
  const now = Date.now();
  const tempName = `${uploadId}.part`;
  const finalName = `${uploadId}.audio`;
  f.kernel.withColdStartDatabaseTransaction(f.capability, (db) => {
    db.prepare('UPDATE workspaces SET revision=1 WHERE id=?').run(f.workspace.workspaceId);
    db.prepare(`INSERT INTO private_audio_uploads (upload_id,media_id,workspace_id,owner_id,privacy_epoch,status,temp_name,final_name,file_name,format,mime_type,
      expected_bytes,sha256,byte_length,duration_seconds,process_id,created_at,updated_at)
      VALUES (?,?,?,?,0,'deletion_pending',?,?, 'recording.wav','wav','audio/wav',NULL,NULL,NULL,NULL,?,?,?)`)
      .run(uploadId, mediaId, f.workspace.workspaceId, f.ownerId, tempName, finalName, f.processInstanceId, now, now);
    db.prepare(`INSERT INTO private_audio_cleanup_intents (intent_id,workspace_id,owner_id,privacy_epoch,media_id,source_note_id,snapshot_revision,command_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,? ,1,?,'pending',?,?)`).run(id, f.workspace.workspaceId, f.ownerId, 0, mediaId, `note-${id}`, commandId, now, now);
    if (commandId) db.prepare(`INSERT INTO async_command_journal (workspace_id,idempotency_key,owner_id,session_digest,initiating_session_binding,request_digest,
      command_kind,privacy_epoch,ticket_id,ticket_digest,status,created_at,updated_at,checkpoint_revision,snapshot_digest,owned_object_ids_json,receipt_json)
      VALUES (?,?,?,?,NULL,?,'notes.delete',?,?,?, 'checkpointed',?,?,1,?,'{"notes":[]}',NULL)`)
      .run(f.workspace.workspaceId, commandId, f.ownerId, 'b'.repeat(64), 'a'.repeat(64), commandEpoch,
        randomUUID(), 'c'.repeat(64), now, now, 'd'.repeat(64));
  });
  writeFileSync(join(f.workspaceDirectory, tempName), Buffer.from('temporary'), { mode: 0o600 });
  writeFileSync(join(f.workspaceDirectory, finalName), Buffer.from('audio'), { mode: 0o600 });
  return { id, uploadId, mediaId, tempName, finalName };
}
function close(f) {
  try { f.startup.close(); } catch {}
  try { f.kernel.close(); } catch {}
  try { f.ownership.release(); } catch {}
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
}

test('cold startup binds process identity and pages pending intents before unlinking exact files', async () => {
  const f = setup();
  try {
    const rows = [insertPending(f), insertPending(f), insertPending(f)];
    const first = f.kernel.listColdStartIntentPage(f.capability, f.workspace.workspaceId,
      createApplicationStartupIntentCursor(f.capability, f.workspace.workspaceId), 1);
    assert.equal(first.entries.length, 1);
    assert.ok(first.nextCursor);
    const second = f.kernel.listColdStartIntentPage(f.capability, f.workspace.workspaceId, first.nextCursor, 1);
    assert.equal(second.entries.length, 1);
    assert.ok(second.nextCursor);
    const third = f.kernel.listColdStartIntentPage(f.capability, f.workspace.workspaceId, second.nextCursor, 1);
    assert.equal(third.entries.length, 1);
    assert.equal(third.nextCursor, undefined);
    assert.throws(() => new AudioColdStartRecovery({ kernel: f.kernel, capability: f.capability, privateRoot: f.privateRoot,
      processInstanceId: randomUUID() }), /capability_invalid/);
    const recovery = new AudioColdStartRecovery({ kernel: f.kernel, capability: f.capability, privateRoot: f.privateRoot,
      processInstanceId: f.processInstanceId });
    const outcomes = await recovery.run();
    assert.equal(outcomes.filter((item) => item.status === 'complete').length, 3);
    assert.equal(outcomes.some((item) => item.status === 'inspection_required'), false);
    for (const row of rows) {
      assert.equal(existsSync(join(f.workspaceDirectory, row.tempName)), false);
      assert.equal(existsSync(join(f.workspaceDirectory, row.finalName)), false);
    }
  } finally { close(f); }
});

test('cold recovery accepts exact committed cleanup lineage and holds a mismatched command epoch', async () => {
  const f = setup();
  try {
    const valid = insertPending(f, randomUUID(), { commandId: randomUUID(), commandEpoch: 0 });
    const invalid = insertPending(f, randomUUID(), { commandId: randomUUID(), commandEpoch: 1 });
    const recovery = new AudioColdStartRecovery({ kernel: f.kernel, capability: f.capability, privateRoot: f.privateRoot,
      processInstanceId: f.processInstanceId });
    const outcomes = await recovery.run();
    assert.equal(outcomes.find((item) => item.intentId === valid.id)?.status, 'complete');
    assert.equal(outcomes.find((item) => item.intentId === invalid.id)?.status, 'inspection_required');
    assert.equal(outcomes.find((item) => item.intentId === invalid.id)?.reason, 'lineage_invalid');
    assert.equal(existsSync(join(f.workspaceDirectory, valid.tempName)), false);
    assert.equal(existsSync(join(f.workspaceDirectory, valid.finalName)), false);
    assert.equal(existsSync(join(f.workspaceDirectory, invalid.tempName)), true);
    assert.equal(existsSync(join(f.workspaceDirectory, invalid.finalName)), true);
  } finally { close(f); }
});

test('a fresh process retires an old-epoch pending capture after the prior process exits abruptly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-cold-child-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const privateRoot = join(directory, 'private-audio');
  createAudioSchema(databasePath);
  const ownerModule = new URL('../dist/applicationOwnership.js', import.meta.url).href;
  const startupModule = new URL('../dist/applicationStartup.js', import.meta.url).href;
  const kernelModule = new URL('../dist/kernel.js', import.meta.url).href;
  const child = `
    import { randomUUID } from 'node:crypto';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { acquireApplicationOwnership, reserveApplicationStartup } from ${JSON.stringify(ownerModule)};
    import { registerApplicationStartup } from ${JSON.stringify(startupModule)};
    import { createDurableKernel } from ${JSON.stringify(kernelModule)};
    const databasePath = ${JSON.stringify(databasePath)};
    const privateRoot = ${JSON.stringify(privateRoot)};
    const ownership = acquireApplicationOwnership(databasePath);
    const reservation = reserveApplicationStartup(ownership);
    const kernel = createDurableKernel({ databasePath, applicationOwnership: ownership, startupReservation: reservation, validateSnapshot() {} });
    const ownerId = randomUUID();
    const workspace = kernel.createWorkspace(ownerId, { notes: [] });
    const processId = randomUUID();
    const startup = registerApplicationStartup(kernel, ownership, databasePath, processId);
    startup.beginRecovery();
    const capability = startup.capability;
    const uploadId = randomUUID();
    const mediaId = randomUUID();
    const intentId = randomUUID();
    const now = Date.now();
    const tempName = uploadId + '.part';
    const finalName = uploadId + '.audio';
    kernel.withColdStartDatabaseTransaction(capability, (db) => {
      db.prepare('UPDATE workspaces SET revision=1 WHERE id=?').run(workspace.workspaceId);
      db.prepare("INSERT INTO private_audio_uploads (upload_id,media_id,workspace_id,owner_id,privacy_epoch,status,temp_name,final_name,file_name,format,mime_type,expected_bytes,sha256,byte_length,duration_seconds,process_id,created_at,updated_at) VALUES (?,?,?,?,0,'deletion_pending',?,?, 'recording.wav','wav','audio/wav',NULL,NULL,NULL,NULL,?,?,?)")
        .run(uploadId, mediaId, workspace.workspaceId, ownerId, tempName, finalName, processId, now, now);
      db.prepare("INSERT INTO private_audio_cleanup_intents (intent_id,workspace_id,owner_id,privacy_epoch,media_id,source_note_id,snapshot_revision,command_id,status,created_at,updated_at) VALUES (?,?,?,?,?,? ,1,NULL,'pending',?,?)").run(intentId, workspace.workspaceId, ownerId, 0, mediaId, 'old-epoch-note', now, now);
    });
    const workspaceDirectory = join(privateRoot, workspace.workspaceId);
    mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspaceDirectory, tempName), 'temporary', { mode: 0o600 });
    writeFileSync(join(workspaceDirectory, finalName), 'audio', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ownerId, workspaceId: workspace.workspaceId, tempName, finalName }));
    process.exit(0);
  `;
  try {
    const exited = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(exited.status, 0, exited.stderr || exited.error?.message);
    const prior = JSON.parse(exited.stdout);
    const ownership = acquireApplicationOwnership(databasePath);
    const startupReservation = reserveApplicationStartup(ownership);
    const kernel = createDurableKernel({ databasePath, applicationOwnership: ownership, startupReservation, validateSnapshot() {} });
    const processInstanceId = randomUUID();
    const startup = registerApplicationStartup(kernel, ownership, databasePath, processInstanceId);
    startup.beginRecovery();
    const capability = startup.capability;
    try {
      kernel.withColdStartDatabaseTransaction(capability, (db) => {
        db.prepare('UPDATE workspaces SET privacy_epoch=1 WHERE id=? AND owner_id=?').run(prior.workspaceId, prior.ownerId);
      });
      const results = await new AudioColdStartRecovery({ kernel, capability, privateRoot, processInstanceId }).run();
      assert.equal(results.length, 1);
      assert.equal(results[0]?.status, 'complete');
      assert.equal(results[0]?.workspaceId, prior.workspaceId);
      assert.equal(existsSync(join(privateRoot, prior.workspaceId, prior.tempName)), false);
      assert.equal(existsSync(join(privateRoot, prior.workspaceId, prior.finalName)), false);
    } finally {
      startup.close();
      kernel.close();
      ownership.release();
    }
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); }
});

test('production runtime capture adoption and note deletion produce cold-recovery lineage in the actual async journal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-cold-runtime-lineage-'));
  const databasePath = join(directory, 'private', 'workspace.sqlite');
  const dataDirectory = join(directory, 'private', 'data');
  const privateRoot = join(dataDirectory, 'private-audio');
  const kernelModule = new URL('../dist/kernel.js', import.meta.url).href;
  const vaultModule = new URL('../dist/vault.js', import.meta.url).href;
  const actorsModule = new URL('../dist/runtimeActors.js', import.meta.url).href;
  const appHostModule = new URL('../dist/applicationHost.node.mjs', import.meta.url).href;
  const runtimeModule = new URL('../dist/ownedWorkspaceRuntime.node.mjs', import.meta.url).href;
  const httpModule = new URL('../dist/workspaceHttp.node.mjs', import.meta.url).href;
  const stateModule = new URL('../dist/sharedControllerNode.mjs', import.meta.url).href;
  const child = `
    import { createHash, randomBytes, randomUUID } from 'node:crypto';
    import { writeSync } from 'node:fs';
    import { Buffer } from 'node:buffer';
    import { createDurableKernel } from ${JSON.stringify(kernelModule)};
    import { SecretVault } from ${JSON.stringify(vaultModule)};
    import { ProcessWorkspaceActors } from ${JSON.stringify(actorsModule)};
    import { createProductionWorkspacePortsFor } from ${JSON.stringify(appHostModule)};
    import { OwnedWorkspaceRuntime } from ${JSON.stringify(runtimeModule)};
    import { createWorkspaceHttpApi } from ${JSON.stringify(httpModule)};
    import { createInitialWorkspaceState } from ${JSON.stringify(stateModule)};
    const databasePath = ${JSON.stringify(databasePath)};
    const dataDirectory = ${JSON.stringify(dataDirectory)};
    const privateRoot = ${JSON.stringify(privateRoot)};
    const kernel = createDurableKernel({ databasePath, validateSnapshot(value) { if (!value || typeof value !== 'object') throw new Error('snapshot_invalid'); } });
    const ownerId = randomUUID();
    const workspace = kernel.createWorkspace(ownerId, createInitialWorkspaceState(randomUUID));
    const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 3600000);
    const actors = new ProcessWorkspaceActors(kernel);
    const vault = new SecretVault(kernel, randomBytes(32));
    const processInstanceId = randomUUID();
    const portsFor = createProductionWorkspacePortsFor({ dataDirectory }, {
      fetcher: async () => { throw new Error('provider access forbidden in this test'); },
      beforePrivateAudioCleanupCompleteForTesting(intentId) { writeSync(1, 'cleanup-window:' + intentId + '\\n'); throw new Error('injected process-exit cleanup window'); },
    });
    const runtime = new OwnedWorkspaceRuntime({ kernel, processInstanceId,
      runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
      crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
      workspacePortsFor: (context) => portsFor(context, vault, kernel),
    });
    const workspaceApi = createWorkspaceHttpApi(runtime);
    const audioApi = runtime.createAudioHttpApi();
    const admission = { sessionToken, assertCurrent: () => kernel.getOwnedIdentity(sessionToken) };
    const audioData = Buffer.alloc(1600, 128);
    const wav = Buffer.alloc(44 + audioData.length);
    wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8, 'ascii');
    wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
    wav.write('data', 36, 'ascii'); wav.writeUInt32LE(audioData.length, 40); audioData.copy(wav, 44);
    async function* chunks() { yield wav.subarray(0, 13); yield wav.subarray(13, 511); yield wav.subarray(511); }
    const uploadId = randomUUID();
    const captureId = randomUUID();
    const uploaded = await audioApi.upload(admission, { uploadId,
      capture: { id: captureId, capturedAt: '2026-10-15T00:00:00.000Z', timeZone: 'Asia/Singapore' },
      mimeType: 'audio/wav', expectedByteLength: wav.byteLength, source: chunks() });
    const snapshot = await workspaceApi.getSnapshot(admission);
    const adoptionId = randomUUID();
    const adopted = await workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: adoptionId,
      expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch,
      command: { kind: 'notes.capture.adopt', captureId, captureRevision: uploaded.capture.revision } });
    const deleteCommandId = randomUUID();
    const identity = kernel.getOwnedIdentity(sessionToken);
    const deleted = await runtime.executeCommand({ sessionToken, assertCurrent: admission.assertCurrent,
      expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch,
      idempotencyKey: deleteCommandId, kind: 'notes.delete', canonicalBody: JSON.stringify({ noteId: captureId }),
    }, async (controller) => { await controller.deleteNote(captureId); return { noteId: captureId }; },
    (result) => ({ kind: 'notes.delete', noteId: result.noteId }));
    const journal = kernel.withTrustedDatabaseTransaction((db) => ({
      adoption: db.prepare('SELECT command_kind,status,owner_id,privacy_epoch,receipt_json FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?')
        .get(workspace.workspaceId, adoptionId),
      deletion: db.prepare('SELECT command_kind,status,owner_id,privacy_epoch,checkpoint_revision,receipt_json FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?')
        .get(workspace.workspaceId, deleteCommandId),
      intent: db.prepare('SELECT command_id,status,snapshot_revision FROM private_audio_cleanup_intents WHERE workspace_id=? AND media_id=?')
        .get(workspace.workspaceId, uploaded.media.mediaId.slice('still-media:'.length)),
      capture: db.prepare('SELECT consumed_command_id,note_id,note_revision,status FROM private_audio_capture_uploads WHERE upload_id=?').get(uploadId),
    }));
    if (journal.adoption?.status !== 'finished' || journal.deletion?.status !== 'finished' ||
        journal.intent?.command_id !== deleteCommandId || journal.capture?.consumed_command_id !== adoptionId ||
        deleted.admission.status !== 'claimed' || adopted.status !== 'finished') throw new Error(JSON.stringify({
          failure: 'expected_actual_async_journal_lineage_missing', adoptionAdmission: adopted.status,
          deleteAdmission: deleted.admission.status, adoptionJournal: journal.adoption,
          deleteJournal: journal.deletion, intent: journal.intent,
          capture: journal.capture && { ...journal.capture },
        }));
    writeSync(1, JSON.stringify({ ownerId, workspaceId: workspace.workspaceId, privateRoot,
      mediaId: uploaded.media.mediaId.slice('still-media:'.length), adoptionId, deleteCommandId, intentStatus: journal.intent.status,
      captureCommandId: journal.capture.consumed_command_id, deleteStatus: journal.deletion.status }) + '\\n');
    process.exit(0);
  `;
  try {
    const exited = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(exited.status, 0, exited.stderr || exited.error?.message || exited.stdout);
    const marker = exited.stdout.split(/\r?\n/).filter((line) => line.startsWith('{')).at(-1);
    assert.ok(marker, exited.stdout);
    const prior = JSON.parse(marker);
    assert.equal(prior.intentStatus, 'pending');
    assert.equal(prior.captureCommandId, prior.adoptionId);
    assert.equal(prior.deleteStatus, 'finished');
    const ownership = acquireApplicationOwnership(databasePath);
    const startupReservation = reserveApplicationStartup(ownership);
    const kernel = createDurableKernel({ databasePath, applicationOwnership: ownership, startupReservation,
      validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
    const processInstanceId = randomUUID();
    const startup = registerApplicationStartup(kernel, ownership, databasePath, processInstanceId);
    startup.beginRecovery();
    const capability = startup.capability;
    try {
      kernel.withColdStartDatabaseTransaction(capability, (db) => {
        db.prepare('UPDATE workspaces SET privacy_epoch=1 WHERE id=? AND owner_id=?').run(prior.workspaceId, prior.ownerId);
      });
      const outcomes = await new AudioColdStartRecovery({ kernel, capability, privateRoot, processInstanceId }).run();
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.status, 'complete');
      assert.equal(outcomes[0]?.workspaceId, prior.workspaceId);
      const rows = kernel.withColdStartDatabaseTransaction(capability, (db) => ({
        intent: db.prepare('SELECT status,command_id FROM private_audio_cleanup_intents WHERE workspace_id=? AND media_id=?')
          .get(prior.workspaceId, prior.mediaId),
        audio: db.prepare('SELECT status FROM private_audio_uploads WHERE workspace_id=? AND media_id=?')
          .get(prior.workspaceId, prior.mediaId),
      }));
      assert.deepEqual(rows, { intent: { status: 'complete', command_id: prior.deleteCommandId }, audio: { status: 'unavailable' } });
    } finally {
      startup.close(); kernel.close(); ownership.release();
    }
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('a second kernel sharing the startup owner cannot bypass the owner-wide seal', () => {
  const f = setup();
  try {
    assert.throws(() => createDurableKernel({ databasePath: f.databasePath, applicationOwnership: f.ownership, validateSnapshot() {} }),
      (error) => error.code === 'application_owner_unavailable');
    assert.throws(() => registerApplicationStartup(f.kernel, f.ownership, f.databasePath, randomUUID()),
      (error) => error.code === 'application_owner_path_unsafe');
    f.startup.seal();
    f.kernel.assertRuntimeStartupSealed();
    assert.throws(() => f.kernel.listColdStartWorkspacePage(f.capability,
      createApplicationStartupCursor(f.capability), 1), /capability_invalid/);
  } finally { close(f); }
});

test('a direct kernel permanently consumes cold-start startup reservation before it is returned', () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-direct-kernel-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const ownership = acquireApplicationOwnership(databasePath);
  let kernel;
  let reopened;
  try {
    kernel = createDurableKernel({ databasePath, applicationOwnership: ownership, validateSnapshot() {} });
    kernel.assertRuntimeStartupSealed();
    assert.throws(() => registerApplicationStartup(kernel, ownership, databasePath, randomUUID()),
      (error) => error?.code === 'application_owner_path_unsafe');
    kernel.close();
    reopened = createDurableKernel({ databasePath, applicationOwnership: ownership, validateSnapshot() {} });
    reopened.assertRuntimeStartupSealed();
    assert.throws(() => registerApplicationStartup(reopened, ownership, databasePath, randomUUID()),
      (error) => error?.code === 'application_owner_path_unsafe', 'standalone close/reopen never remints cold-start authority');
  } finally {
    try { reopened?.close(); } catch {}
    try { kernel?.close(); } catch {}
    ownership.release();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

test('an unconfirmed close retains the exact descriptor and blocks owner release until retry succeeds', async () => {
  const f = setup();
  let failCloses = 2;
  const closed = [];
  try {
    insertPending(f);
    const recovery = new AudioColdStartRecovery({ kernel: f.kernel, capability: f.capability, privateRoot: f.privateRoot,
      processInstanceId: f.processInstanceId, fileOperations: {
        syncDirectory(path, closeDescriptor) {
          const file = join(path, '.descriptor-close-fixture');
          writeFileSync(file, 'fixture', { mode: 0o600 });
          closeDescriptor(openSync(file, constants.O_RDONLY));
        },
        closeDescriptor(fd) {
          closed.push(fd);
          if (failCloses > 0) { failCloses -= 1; throw new Error('injected close failure'); }
          closeSync(fd);
        },
      } });
    await assert.rejects(recovery.run(), /still owns a physical cleanup descriptor/);
    assert.equal(closed.length, 2);
    assert.equal(closed[0], closed[1]);
    assert.throws(() => f.ownership.release(), (error) => error?.code === 'application_owner_unavailable');
    await recovery.retryCloseOwnedDescriptors();
    assert.equal(closed.length, 3);
    assert.equal(closed[0], closed[2]);
    f.startup.seal();
    f.startup.close();
    f.kernel.close();
    f.ownership.release();
  } finally { close(f); }
});
