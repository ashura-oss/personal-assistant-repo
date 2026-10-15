import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { isUnsupportedDirectorySyncError, PrivateAudioRepository } from '../dist/privateAudioRepository.js';
import { CommandJournal, ServerWorkspaceStore } from '../dist/workspaceRuntime.js';

const HOST_PROCESS_ID = randomUUID();

function wavFixture() {
  const sampleRate = 8000;
  const data = Buffer.alloc(1600, 128);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}
async function* chunks(bytes) { yield bytes.subarray(0, 13); yield bytes.subarray(13, 511); yield bytes.subarray(511); }

async function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-snapshot-audio-cleanup-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const kernel = createDurableKernel({ databasePath, validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { accounts: [], notes: [] });
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const privateRoot = join(directory, 'private-audio');
  let noteIds = options.noteIds ?? ['source-note'];
  let attached;
  const repository = new PrivateAudioRepository({ kernel, actorSessionToken: sessionToken, privateRoot, processId: HOST_PROCESS_ID,
    resolveAttachedMedia: ({ workspaceId, ownerId: attachedOwnerId, privacyEpoch, noteId, noteRevision }) =>
      attached && workspaceId === workspace.workspaceId && attachedOwnerId === ownerId && privacyEpoch === 0 &&
      attached.noteIds.includes(noteId) && attached.noteRevision === noteRevision
        ? { mediaId: attached.mediaId, noteId, noteRevision, sha256: attached.sha256, byteLength: attached.byteLength } : undefined,
    ...options.repositoryOptions });
  const record = await repository.ingest(chunks(wavFixture()), { fileName: 'source.wav', mimeType: 'audio/wav' });
  const initialSnapshot = { accounts: [], notes: noteIds.map((id) => ({ id, revision: 1, audioUri: `still-media:${record.mediaId}` })) };
  kernel.runLocalCommand(sessionToken, { expectedRevision: 0, expectedPrivacyEpoch: 0, idempotencyKey: randomUUID(),
    type: 'workspace.snapshot.write', canonicalRequest: '{"fixture":"attach-ready-audio"}' }, () => ({
    snapshot: initialSnapshot, receipt: { kind: 'fixture_seed' }, accountGenerations: {},
  }));
  attached = { mediaId: record.mediaId, noteIds: [...noteIds], noteRevision: 1, sha256: record.sha256, byteLength: record.byteLength };
  const journal = new CommandJournal(kernel);
  const participant = repository.createSnapshotCommitParticipant();
  const store = new ServerWorkspaceStore({ kernel, sessionToken, journal, snapshotCommitParticipant: participant,
    ...(options.afterCommitForTesting ? { afterCommitForTesting: options.afterCommitForTesting } : {}) });
  await store.load();
  return { directory, databasePath, privateRoot, kernel, ownerId, workspace, sessionToken, record, repository, journal, store, attached };
}
async function close(f) {
  try { await f.repository.drain(); } catch { /* A failed cleanup remains durable for the next owned runtime. */ }
  try { f.kernel.close(); } catch {}
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
function intentFor(f) {
  return f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT intent_id,status,media_id,source_note_id,snapshot_revision,command_id
    FROM private_audio_cleanup_intents WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`).get(f.workspace.workspaceId, f.ownerId));
}
function nextSnapshot(notes) { return { accounts: [], notes }; }
function runCrashChild(databasePath, privateRoot) {
  const childPath = fileURLToPath(new URL('./fixtures/snapshotCleanupCrashChild.mjs', import.meta.url));
  const child = spawn(process.execPath, [childPath, databasePath, privateRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`cleanup crash fixture timed out: ${stderr}`)); }, 15_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 73) reject(new Error(`cleanup crash fixture exited ${code}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`cleanup crash fixture returned invalid metadata: ${stderr}`)); }
      }
    });
  });
}
function replacementFor(f) {
  const before = f.kernel.getOwnedSnapshot(f.sessionToken);
  f.kernel.runLocalCommand(f.sessionToken, { expectedRevision: before.revision, expectedPrivacyEpoch: before.privacyEpoch,
    idempotencyKey: randomUUID(), type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
    snapshot: before.snapshot, receipt: { kind: 'privacy_erased' }, privacyEpoch: before.privacyEpoch + 1,
  }));
  const token = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
  return { identity: f.kernel.getOwnedIdentity(token), admissionSessionToken: token };
}

test('snapshot and deletion intent roll back together when the async checkpoint participant fails', async () => {
  const f = await setup();
  try {
    const base = f.repository.createSnapshotCommitParticipant();
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken, journal: f.journal,
      snapshotCommitParticipant: { commit(context, input) {
        base.commit(context, input);
        throw new Error('injected failure after intent write');
      } } });
    await store.load();
    const claim = f.journal.admit({ admissionSessionToken: f.sessionToken, expectedRevision: 1, expectedPrivacyEpoch: 0,
      idempotencyKey: randomUUID(), kind: 'notes.delete', canonicalBody: '{"noteId":"source-note"}' });
    await assert.rejects(f.journal.run(claim.ticket, f.sessionToken, () => store.save(nextSnapshot([]))), /after intent write/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 1);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).snapshot.notes.length, 1);
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'ready');
    assert.equal(intentFor(f), undefined);
  } finally { await close(f); }
});

test('lost snapshot acknowledgement leaves a durable pending intent, denies new reads, and startup retry completes it', async () => {
  let loseAck = true;
  const f = await setup({ afterCommitForTesting() { if (loseAck) { loseAck = false; throw new Error('simulated lost snapshot acknowledgement'); } } });
  try {
    await assert.rejects(f.store.save(nextSnapshot([])), /lost snapshot acknowledgement/);
    const persisted = f.kernel.getOwnedSnapshot(f.sessionToken);
    assert.equal(persisted.revision, 2);
    assert.equal(persisted.snapshot.notes.length, 0);
    const intent = intentFor(f);
    assert.ok(intent?.intent_id);
    assert.equal(intent.status, 'pending');
    assert.equal(intent.media_id, f.record.mediaId);
    assert.equal(intent.source_note_id, 'source-note');
    assert.equal(intent.snapshot_revision, 2);
    assert.equal(intent.command_id, null);
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'deletion_pending');
    await assert.rejects(f.repository.openAttachedMedia({ noteId: 'source-note', noteRevision: 1 }), /audio_unavailable/);
    await assert.rejects(f.repository.createSpeechLease({ noteId: 'source-note', noteRevision: 1 }), /audio_unavailable/);
    assert.equal(existsSync(join(f.privateRoot, f.workspace.workspaceId, `${f.record.uploadId}.audio`)), true,
      'logical detach is committed before physical unlink begins after acknowledgement');
    await f.store.load();
    await f.repository.resumePendingSnapshotCleanup({ exclusiveOwnerStartup: true });
    assert.equal(f.repository.inspectCleanupIntent(intent.intent_id).status, 'complete');
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'unavailable');
    assert.equal(existsSync(join(f.privateRoot, f.workspace.workspaceId, `${f.record.uploadId}.audio`)), false);
  } finally { await close(f); }
});

test('abrupt child exit preserves a committed cleanup intent for startup retry after real process death', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-snapshot-audio-crash-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const privateRoot = join(directory, 'private-audio');
  let kernel;
  let repository;
  try {
    const child = await runCrashChild(databasePath, privateRoot);
    assert.equal(existsSync(join(privateRoot, child.workspaceId, `${child.uploadId}.audio`)), true);
    kernel = createDurableKernel({ databasePath, validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
    const sessionToken = kernel.createSession(child.workspaceId, child.ownerId, Date.now() + 60 * 60_000);
    const current = kernel.getOwnedSnapshot(sessionToken);
    assert.equal(current.snapshot.notes.length, 0, 'the committed note removal survived process death');
    repository = new PrivateAudioRepository({ kernel, actorSessionToken: sessionToken, privateRoot, processId: HOST_PROCESS_ID,
      resolveAttachedMedia: () => undefined });
    const intent = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT intent_id,status,media_id FROM private_audio_cleanup_intents
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`).get(child.workspaceId, child.ownerId));
    assert.ok(intent?.intent_id);
    assert.equal(intent.status, 'pending');
    assert.equal(intent.media_id, child.mediaId);
    await repository.resumePendingSnapshotCleanup({ exclusiveOwnerStartup: true });
    assert.equal(repository.inspectCleanupIntent(intent.intent_id).status, 'complete');
    assert.equal(existsSync(join(privateRoot, child.workspaceId, `${child.uploadId}.audio`)), false);
  } finally {
    try { await repository?.drain(); } catch { /* Keep failed recovery evidence until the fixture is removed. */ }
    try { kernel?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('detaching one shared media reference keeps the source; removing its final reference creates one intent', async () => {
  const f = await setup({ noteIds: ['source-note-a', 'source-note-b'] });
  try {
    await f.store.save(nextSnapshot([{ id: 'source-note-b', revision: 1, audioUri: `still-media:${f.record.mediaId}` }]));
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'ready');
    assert.equal(intentFor(f), undefined);
    await f.store.save(nextSnapshot([]));
    const intent = intentFor(f);
    assert.ok(intent?.intent_id);
    assert.equal(intent.source_note_id, 'source-note-b');
    await f.repository.cleanupCommittedMedia(f.record.mediaId);
    assert.equal(f.repository.inspectCleanupIntent(intent.intent_id).status, 'complete');
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'unavailable');
  } finally { await close(f); }
});

test('malformed candidate snapshots roll back without creating an intent or marking media', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.store.save(nextSnapshot([{ id: 'source-note', revision: 1, audioUri: 'still-media:not-a-uuid' }])), /snapshot_invalid/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 1);
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'ready');
    assert.equal(intentFor(f), undefined);
    await f.store.load();
    await assert.rejects(f.store.save({ accounts: [] }), /snapshot_invalid/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 1);
    assert.equal(intentFor(f), undefined);
    await f.store.load();
    const newlineUri = `still-media:${f.record.mediaId}\n`;
    await assert.rejects(f.store.save(nextSnapshot([{ id: 'source-note', revision: 1, audioUri: newlineUri }])), /snapshot_invalid/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 1);
    assert.equal(intentFor(f), undefined);
  } finally { await close(f); }
});

test('removing the final reference to unavailable media creates a pending intent for its retained file', async () => {
  let failOnce = true;
  let reachedUnlink;
  const unlinked = new Promise((resolve) => { reachedUnlink = resolve; });
  const f = await setup({ repositoryOptions: { afterCleanupUnlinkForTesting(intentId) {
    reachedUnlink(intentId);
    if (failOnce) { failOnce = false; throw new Error('injected post-unlink failure'); }
  } } });
  try {
    const path = join(f.privateRoot, f.workspace.workspaceId, `${f.record.uploadId}.audio`);
    assert.equal(existsSync(path), true);
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`UPDATE private_audio_uploads SET status='unavailable' WHERE media_id=? AND status='ready'`).run(f.record.mediaId));
    await f.store.save(nextSnapshot([]));
    const intentId = await unlinked;
    assert.equal(f.repository.inspectCleanupIntent(intentId).status, 'pending');
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'deletion_pending');
    await assert.rejects(f.repository.openAttachedMedia({ noteId: 'source-note', noteRevision: 1 }), /audio_unavailable/);
    assert.equal(existsSync(path), false);
    assert.equal((await f.repository.retryCleanupIntent(intentId)).status, 'complete');
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'unavailable');
  } finally { await close(f); }
});

test('a complete intent with a contradictory ready row rejects the detach instead of claiming cleanup', async () => {
  const f = await setup();
  try {
    await f.store.save(nextSnapshot([]));
    await f.repository.cleanupCommittedMedia(f.record.mediaId);
    assert.equal(intentFor(f).status, 'complete');
    const current = f.kernel.getOwnedSnapshot(f.sessionToken);
    f.kernel.runLocalCommand(f.sessionToken, { expectedRevision: current.revision, expectedPrivacyEpoch: current.privacyEpoch,
      idempotencyKey: randomUUID(), type: 'workspace.snapshot.write', canonicalRequest: '{"fixture":"restore-inconsistent-reference"}' }, () => ({
      snapshot: nextSnapshot([{ id: 'source-note', revision: 1, audioUri: `still-media:${f.record.mediaId}` }]),
      receipt: { kind: 'fixture_inconsistent_restore' }, accountGenerations: {},
    }));
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`UPDATE private_audio_uploads SET status='ready' WHERE media_id=?`).run(f.record.mediaId));
    await f.store.load();
    await assert.rejects(f.store.save(nextSnapshot([])), /audio_cleanup_record_changed/);
    const persisted = f.kernel.getOwnedSnapshot(f.sessionToken);
    assert.equal(persisted.snapshot.notes.length, 1);
    assert.equal(f.repository.inspectCleanupIntent(intentFor(f).intent_id).status, 'complete');
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM private_audio_uploads WHERE media_id=?').get(f.record.mediaId)).status, 'ready');
  } finally { await close(f); }
});

test('newer owner proof retries an old-epoch pending intent after exact playback closure', async () => {
  let failOnce = true;
  const f = await setup({ repositoryOptions: { afterCleanupUnlinkForTesting() {
    if (failOnce) { failOnce = false; throw new Error('injected old-epoch unlink acknowledgement failure'); }
  } } });
  let response;
  try {
    response = await f.repository.openAttachedMedia({ noteId: 'source-note', noteRevision: 1 });
    const closed = new Promise((resolve) => response.body.once('close', resolve));
    await f.store.save(nextSnapshot([]));
    const intent = intentFor(f);
    assert.equal(intent.status, 'pending');
    const replacement = replacementFor(f);
    const draining = f.repository.drain(replacement);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.repository.inspectCleanupIntent(intent.intent_id).status, 'pending', 'open playback prevents completion');
    response.body.destroy();
    await closed;
    await draining;
    assert.equal(f.repository.inspectCleanupIntent(intent.intent_id).status, 'complete');
    const audio = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM private_audio_uploads WHERE media_id=? AND privacy_epoch=0').get(f.record.mediaId));
    assert.equal(audio.status, 'unavailable');
    const holder = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE media_id=?').get(f.record.mediaId));
    assert.equal(holder.count, 0, 'the exact closed reader row is retired after its descriptor closes');
  } finally { response?.body?.destroy(); await close(f); }
});

test('speech descriptor close failure blocks old-epoch intent until exact close retry', async () => {
  let failClose = true;
  let cleanupId;
  let closeAttempts = 0;
  const f = await setup({ repositoryOptions: {
    afterSpeechFileHandleOpenForTesting(id) { cleanupId = id; },
    async closeSpeechLeaseHandle(handle) {
      closeAttempts += 1;
      if (failClose) { failClose = false; throw new Error('injected speech descriptor close failure'); }
      await handle.close();
    },
  } });
  try {
    const lease = await f.repository.createSpeechLease({ noteId: 'source-note', noteRevision: 1 });
    await assert.rejects(f.repository.readSpeechLease(lease.leaseId), /close failure/);
    await f.store.save(nextSnapshot([]));
    await new Promise((resolve) => setImmediate(resolve));
    const intent = intentFor(f);
    assert.equal(intent.status, 'pending');
    const replacement = replacementFor(f);
    await assert.rejects(f.repository.drain(replacement), /audio_cleanup_required/);
    assert.equal(f.repository.inspectCleanupIntent(intent.intent_id).status, 'pending');
    await f.repository.retryPrivateFileClose(cleanupId);
    await f.repository.drain(replacement);
    assert.equal(f.repository.inspectCleanupIntent(intent.intent_id).status, 'complete');
    assert.equal(closeAttempts, 2);
    const holder = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM private_audio_speech_leases WHERE lease_id=?').get(lease.leaseId));
    assert.equal(holder.count, 0, 'the exact closed lease is released only for its committed media intent');
  } finally { await close(f); }
});

for (const [failurePoint, optionName] of [
  ['unlink acknowledgement', 'afterCleanupUnlinkForTesting'],
  ['directory sync acknowledgement', 'afterCleanupDirectorySyncForTesting'],
  ['completion commit preparation', 'beforeCleanupCompleteForTesting'],
]) {
  test(`physical cleanup failure at ${failurePoint} stays pending and exact retry completes`, async () => {
    let failOnce = true;
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const f = await setup({ repositoryOptions: { [optionName](intentId) {
      if (failOnce) { failOnce = false; enteredResolve(intentId); throw new Error('injected physical cleanup failure'); }
    } } });
    try {
      await f.store.save(nextSnapshot([]));
      const intentId = await entered;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.repository.inspectCleanupIntent(intentId).status, 'pending');
      assert.equal(f.repository.getRecord(f.record.mediaId).status, 'deletion_pending');
      const retried = await f.repository.retryCleanupIntent(intentId);
      assert.equal(retried.status, 'complete');
      assert.equal(f.repository.getRecord(f.record.mediaId).status, 'unavailable');
    } finally { await close(f); }
  });
}

test('completion database failure does not lose the durable intent', async () => {
  const f = await setup();
  try {
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TRIGGER block_cleanup_complete BEFORE UPDATE OF status ON private_audio_cleanup_intents
      WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'injected completion database failure'); END`));
    await f.store.save(nextSnapshot([]));
    const intentId = intentFor(f).intent_id;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.repository.inspectCleanupIntent(intentId).status, 'pending');
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'deletion_pending');
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec('DROP TRIGGER block_cleanup_complete'));
    assert.equal((await f.repository.retryCleanupIntent(intentId)).status, 'complete');
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'unavailable');
  } finally { await close(f); }
});

test('active playback blocks deletion completion and new media reads until its exact reader closes', async () => {
  const f = await setup();
  let response;
  try {
    response = await f.repository.openAttachedMedia({ noteId: 'source-note', noteRevision: 1 });
    const closed = new Promise((resolve) => response.body.once('close', resolve));
    await f.store.save(nextSnapshot([]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.repository.getRecord(f.record.mediaId).status, 'deletion_pending');
    await assert.rejects(f.repository.openAttachedMedia({ noteId: 'source-note', noteRevision: 1 }), /audio_unavailable/);
    const intent = intentFor(f);
    assert.equal(intent.status, 'pending');
    response.body.destroy();
    await closed;
    const retry = f.repository.retryCleanupIntent(intent.intent_id);
    response.body.destroy();
    await closed;
    await retry;
    assert.equal(f.repository.inspectCleanupIntent(intent.intent_id).status, 'complete');
  } finally { response?.body?.destroy(); await close(f); }
});

test('a runtime participant cannot be installed after load or use an async commit callback', async () => {
  const f = await setup();
  try {
    assert.throws(() => f.store.installSnapshotCommitParticipant(f.repository.createSnapshotCommitParticipant()), /unavailable/);
    assert.throws(() => new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken,
      snapshotCommitParticipant: { async commit() { return []; } } }), /unavailable/);
  } finally { await close(f); }
});

test('directory sync fallback is limited to explicitly unsupported Windows errors', () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES']) {
    assert.equal(isUnsupportedDirectorySyncError('win32', code), true, `${code} is the Windows unsupported-directory fallback`);
    assert.equal(isUnsupportedDirectorySyncError('linux', code), false, `${code} remains an error on Linux`);
  }
  assert.equal(isUnsupportedDirectorySyncError('win32', 'EIO'), false);
  assert.equal(isUnsupportedDirectorySyncError('linux', 'EIO'), false);
});
