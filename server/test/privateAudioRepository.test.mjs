import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { PrivateAudioRepository } from '../dist/privateAudioRepository.js';

const HOST_PROCESS_ID = randomUUID();

function wavFixture() {
  const sampleRate = 8000;
  const data = Buffer.alloc(1600, 128); // 0.1 s mono 8-bit PCM
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}
function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-private-audio-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), validateSnapshot(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { notes: [] });
  const actorSessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const privateRoot = join(directory, 'private-audio');
  const processId = options.processId ?? HOST_PROCESS_ID;
  let attached;
  const repository = new PrivateAudioRepository({ kernel, actorSessionToken, privateRoot,
    processId,
    resolveAttachedMedia: ({ noteId, noteRevision }) => attached && attached.noteId === noteId && attached.noteRevision === noteRevision ? attached : undefined,
    ...options });
  return { directory, kernel, ownerId, workspace, actorSessionToken, privateRoot, processId, repository, setAttached(value) { attached = value; } };
}
function cleanup(f) { try { f.kernel.close(); } catch {} rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
async function* chunks(bytes) { yield bytes.subarray(0, 13); yield bytes.subarray(13, 511); yield bytes.subarray(511); }

test('streams and verifies a private WAV, binds speech lease to current note revision, serves a range, and drains reader before erase', async () => {
  const f = setup();
  try {
    const bytes = wavFixture();
    const digest = createHash('sha256').update(bytes).digest('hex');
    const record = await f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav', expectedByteLength: bytes.length, expectedSha256: digest });
    assert.equal(record.status, 'ready');
    assert.equal(record.byteLength, bytes.length);
    assert.equal(record.sha256, digest);
    assert.equal(record.durationSeconds, 0.2);
    const noteId = 'legacy-note-id:local-42';
    f.setAttached({ mediaId: record.mediaId, noteId, noteRevision: 4, sha256: digest, byteLength: bytes.length });
    const lease = await f.repository.createSpeechLease({ noteId, noteRevision: 4 });
    const read = await f.repository.readSpeechLease(lease.leaseId);
    assert.deepEqual(read.bytes, bytes);
    assert.equal(read.metadata.sha256, digest);
    await f.repository.releaseSpeechLease(lease.leaseId);
    await assert.rejects(f.repository.createSpeechLease({ noteId, noteRevision: 5 }), /attached|unavailable/i);

    const range = await f.repository.openAttachedMedia({ noteId, noteRevision: 4, range: 'bytes=0-11' });
    assert.equal(range.status, 206);
    assert.equal(range.headers['Content-Range'], `bytes 0-11/${bytes.length}`);
    const head = await f.repository.openAttachedMedia({ noteId, noteRevision: 4, method: 'HEAD', range: 'bytes=2-4' });
    assert.equal(head.status, 206);
    assert.equal(head.headers['Content-Length'], '3');
    assert.equal(head.body, undefined);
    const multiple = await f.repository.openAttachedMedia({ noteId, noteRevision: 4, range: 'bytes=0-1,3-4' });
    assert.equal(multiple.status, 416);
    assert.equal(multiple.headers['Content-Range'], `bytes */${bytes.length}`);
    const deleting = f.repository.deleteAttachedMedia({ noteId, noteRevision: 4 });
    const received = [];
    for await (const part of range.body) received.push(part);
    assert.deepEqual(Buffer.concat(received), bytes.subarray(0, 12));
    assert.equal((await deleting).status, 'unavailable');
  } finally { cleanup(f); }
});

test('rename-before-ready crash is reconciled from verified bytes without treating missing data as empty success', async () => {
  let crash = true;
  const f = setup({ afterRenameBeforeReady() { if (crash) { crash = false; throw new Error('simulated process stop'); } } });
  try {
    const bytes = wavFixture();
    await assert.rejects(f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav' }), /simulated process stop/);
    const reconciled = await f.repository.reconcile();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].status, 'ready');
    const mediaId = reconciled[0].mediaId;
    const audioDirectory = join(f.privateRoot, f.workspace.workspaceId);
    const finalFile = readdirSync(audioDirectory).find((name) => name.endsWith('.audio'));
    assert.ok(finalFile);
    unlinkSync(join(audioDirectory, finalFile));
    assert.equal((await f.repository.reconcile())[0].status, 'unavailable');
    assert.equal(f.repository.getRecord(mediaId).status, 'unavailable');
  } finally { cleanup(f); }
});

test('rejects non-WAV when codec tools are not configured, hash mismatch, ranges that are not single byte ranges, and unattached media access', async () => {
  const f = setup();
  try {
    await assert.rejects(f.repository.ingest(chunks(Buffer.from('ID3'.padEnd(12, '\0'))), { fileName: 'clip.mp3', mimeType: 'audio/mpeg' }), /codec_unavailable/);
    const bytes = wavFixture();
    await assert.rejects(f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav', expectedSha256: '0'.repeat(64) }), /hash_mismatch/);
    const record = await f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav' });
    await assert.rejects(f.repository.openAttachedMedia({ noteId: randomUUID(), noteRevision: 0 }), /attached/i);
    assert.equal((await f.repository.getRecord(record.mediaId)).status, 'ready');
    const foreignOwner = randomUUID();
    const foreignWorkspace = f.kernel.createWorkspace(foreignOwner, { notes: [] });
    const foreignSession = f.kernel.createSession(foreignWorkspace.workspaceId, foreignOwner, Date.now() + 60 * 60_000);
    const foreignRepository = new PrivateAudioRepository({ kernel: f.kernel, actorSessionToken: foreignSession, privateRoot: f.privateRoot, processId: f.processId,
      resolveAttachedMedia: () => undefined });
    assert.throws(() => foreignRepository.getRecord(record.mediaId), /unavailable/i);
  } finally { cleanup(f); }
});

test('speech lease is revalidated against the immutable disk source before dispatch', async () => {
  const f = setup();
  try {
    const bytes = wavFixture();
    const record = await f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav' });
    const noteId = randomUUID();
    f.setAttached({ mediaId: record.mediaId, noteId, noteRevision: 2, sha256: record.sha256, byteLength: record.byteLength });
    const lease = await f.repository.createSpeechLease({ noteId, noteRevision: 2 });
    const audioDirectory = join(f.privateRoot, f.workspace.workspaceId);
    const finalFile = readdirSync(audioDirectory).find((name) => name.endsWith('.audio'));
    assert.ok(finalFile);
    const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(audioDirectory, finalFile), corrupted, { mode: 0o600 });
    await assert.rejects(f.repository.verifySpeechLease(lease.leaseId), /changed|invalid/i);
    await f.repository.releaseSpeechLease(lease.leaseId);
    assert.equal((await f.repository.reconcile())[0].status, 'unavailable');
  } finally { cleanup(f); }
});

test('deletion closes admission before draining speech leases and readers, and reconciliation preserves live uploads', async () => {
  const f = setup();
  try {
    const bytes = wavFixture();
    const record = await f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav' });
    const noteId = 'legacy note id / still accepted';
    f.setAttached({ mediaId: record.mediaId, noteId, noteRevision: 8, sha256: record.sha256, byteLength: record.byteLength });
    const lease = await f.repository.createSpeechLease({ noteId, noteRevision: 8 });
    const reader = await f.repository.openAttachedMedia({ noteId, noteRevision: 8 });

    const deleting = f.repository.deleteAttachedMedia({ noteId, noteRevision: 8 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.repository.getRecord(record.mediaId).status, 'deletion_pending');
    await assert.rejects(f.repository.createSpeechLease({ noteId, noteRevision: 8 }), /unavailable/i);
    await assert.rejects(f.repository.openAttachedMedia({ noteId, noteRevision: 8 }), /unavailable/i);
    await f.repository.releaseSpeechLease(lease.leaseId);
    reader.body.on('error', () => undefined);
    reader.body.emit('error', new Error('simulated premature stream error'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.repository.getRecord(record.mediaId).status, 'deletion_pending');
    const streamClosed = new Promise((resolve) => reader.body.once('close', resolve));
    reader.body.destroy();
    await streamClosed;
    assert.equal((await deleting).status, 'unavailable');

    let continueUpload;
    let uploadStarted;
    const started = new Promise((resolve) => { uploadStarted = resolve; });
    const hold = new Promise((resolve) => { continueUpload = resolve; });
    async function* delayedUpload() { uploadStarted(); yield bytes.subarray(0, 20); await hold; yield bytes.subarray(20); }
    const uploading = f.repository.ingest(delayedUpload(), { fileName: 'clip.wav', mimeType: 'audio/wav' });
    await started;
    const siblingRepository = new PrivateAudioRepository({ kernel: f.kernel, actorSessionToken: f.actorSessionToken, privateRoot: f.privateRoot,
      processId: f.processId, resolveAttachedMedia: () => undefined });
    const observed = await siblingRepository.reconcile();
    assert.equal(observed.some((item) => item.status === 'receiving'), true);
    continueUpload();
    assert.equal((await uploading).status, 'ready');
  } finally { cleanup(f); }
});

test('private audio schema refuses unsupported versions and a corrupted table shape', async () => {
  const f = setup();
  try {
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE private_audio_schema SET version=99 WHERE singleton=1').run());
    assert.throws(() => new PrivateAudioRepository({ kernel: f.kernel, actorSessionToken: f.actorSessionToken, privateRoot: f.privateRoot,
      processId: f.processId, resolveAttachedMedia: () => undefined }), /audio_schema_unsupported/);
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare('UPDATE private_audio_schema SET version=1 WHERE singleton=1').run();
      db.exec('ALTER TABLE private_audio_readers RENAME COLUMN process_id TO process_owner');
    });
    assert.throws(() => new PrivateAudioRepository({ kernel: f.kernel, actorSessionToken: f.actorSessionToken, privateRoot: f.privateRoot,
      processId: f.processId, resolveAttachedMedia: () => undefined }), /audio_schema_invalid/);
  } finally { cleanup(f); }
});

test('constructing another workspace repository never deletes a live reader owned by a different process', async () => {
  const f = setup();
  try {
    const otherOwner = randomUUID();
    const otherWorkspace = f.kernel.createWorkspace(otherOwner, { notes: [] });
    const otherSession = f.kernel.createSession(otherWorkspace.workspaceId, otherOwner, Date.now() + 60 * 60_000);
    const otherProcessId = HOST_PROCESS_ID;
    let attached;
    const otherRepository = new PrivateAudioRepository({ kernel: f.kernel, actorSessionToken: otherSession, privateRoot: f.privateRoot,
      processId: otherProcessId, resolveAttachedMedia: ({ noteId, noteRevision }) => attached?.noteId === noteId && attached.noteRevision === noteRevision ? attached : undefined });
    const bytes = wavFixture();
    const record = await otherRepository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav' });
    attached = { mediaId: record.mediaId, noteId: 'other workspace note:17', noteRevision: 1 };
    const reader = await otherRepository.openAttachedMedia({ noteId: attached.noteId, noteRevision: attached.noteRevision });

    // Model a still-live reader owned by another process and workspace. Construction does not
    // sweep it; only an explicit exclusive-restart operation may clear stale ownership rows.
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE private_audio_readers SET process_id=? WHERE media_id=?')
      .run(randomUUID(), record.mediaId));
    new PrivateAudioRepository({ kernel: f.kernel, actorSessionToken: f.actorSessionToken, privateRoot: f.privateRoot,
      processId: f.processId, resolveAttachedMedia: () => undefined });
    const readerCount = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE media_id=?')
      .get(record.mediaId).count);
    assert.equal(readerCount, 1);
    const closed = new Promise((resolve) => reader.body.once('close', resolve));
    reader.body.destroy();
    await closed;
  } finally { cleanup(f); }
});

test('failed close-event row deletion is contained and an exact explicit retry drains the waiting erase', async () => {
  const f = setup();
  try {
    const bytes = wavFixture();
    const record = await f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav' });
    const noteId = 'retry-reader-note';
    f.setAttached({ mediaId: record.mediaId, noteId, noteRevision: 2 });
    const response = await f.repository.openAttachedMedia({ noteId, noteRevision: 2 });
    assert.equal(response.readerId, undefined);
    assert.equal(Object.keys(response.headers).some((name) => /reader|cleanup/i.test(name)), false);
    const readerId = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT reader_id FROM private_audio_readers WHERE media_id=?')
      .get(record.mediaId).reader_id);
    const unrelatedReaderId = randomUUID();
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare('INSERT INTO private_audio_readers (reader_id,media_id,workspace_id,owner_id,privacy_epoch,process_id,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(unrelatedReaderId, randomUUID(), 'unrelated-workspace', randomUUID(), 0, f.processId, Date.now());
      db.exec("CREATE TRIGGER block_audio_reader_delete BEFORE DELETE ON private_audio_readers BEGIN SELECT RAISE(ABORT,'temporary database fault'); END");
    });

    const deleting = f.repository.deleteAttachedMedia({ noteId, noteRevision: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    const streamClosed = new Promise((resolve) => response.body.once('close', resolve));
    response.body.destroy();
    await streamClosed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.repository.getRecord(record.mediaId).status, 'deletion_pending');
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE reader_id=?')
      .get(readerId).count), 1);

    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.exec('DROP TRIGGER block_audio_reader_delete');
      db.exec('CREATE TABLE reader_delete_audit (reader_id TEXT NOT NULL) STRICT');
      db.exec('CREATE TRIGGER count_audio_reader_delete AFTER DELETE ON private_audio_readers BEGIN INSERT INTO reader_delete_audit(reader_id) VALUES (OLD.reader_id); END');
    });
    await Promise.all([f.repository.retryReaderCleanup(readerId), f.repository.retryReaderCleanup(readerId)]);
    assert.equal((await deleting).status, 'unavailable');
    const counts = f.kernel.withTrustedDatabaseTransaction((db) => ({
      own: db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE reader_id=?').get(readerId).count,
      unrelated: db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE reader_id=?').get(unrelatedReaderId).count,
      deletes: db.prepare('SELECT count(*) AS count FROM reader_delete_audit WHERE reader_id=?').get(readerId).count,
    }));
    assert.deepEqual(counts, { own: 0, unrelated: 1, deletes: 1 });
    await assert.rejects(f.repository.retryReaderCleanup(readerId), /cleanup_unavailable/);
  } finally { cleanup(f); }
});

test('stream creation failure retains the exact opened handle until an explicit close retry succeeds', async () => {
  const f = setup();
  try {
    const bytes = wavFixture();
    const record = await f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav' });
    const noteId = 'stream-create-failure-note';
    f.setAttached({ mediaId: record.mediaId, noteId, noteRevision: 3 });
    let closeAttempts = 0;
    let openedHandle;
    const responseRepository = new PrivateAudioRepository({ kernel: f.kernel, actorSessionToken: f.actorSessionToken,
      privateRoot: f.privateRoot, processId: f.processId, resolveAttachedMedia: ({ noteId: candidate, noteRevision }) =>
        candidate === noteId && noteRevision === 3 ? { mediaId: record.mediaId, noteId, noteRevision: 3 } : undefined,
      createReaderStream(handle) { openedHandle = handle; throw new Error('stream creation failed'); },
      async closeReaderHandle(handle) {
        assert.equal(handle, openedHandle);
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error('close acknowledgement failed');
        await handle.close();
      } });
    await assert.rejects(responseRepository.openAttachedMedia({ noteId, noteRevision: 3 }), /stream creation failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeAttempts, 1);
    const readerId = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT reader_id FROM private_audio_readers WHERE media_id=?')
      .get(record.mediaId).reader_id);
    const unrelatedReaderId = randomUUID();
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare('INSERT INTO private_audio_readers (reader_id,media_id,workspace_id,owner_id,privacy_epoch,process_id,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(unrelatedReaderId, randomUUID(), 'another-workspace', randomUUID(), 1, f.processId, Date.now());
      db.exec('CREATE TABLE reader_close_retry_audit (reader_id TEXT NOT NULL) STRICT');
      db.exec('CREATE TRIGGER count_reader_close_retry AFTER DELETE ON private_audio_readers BEGIN INSERT INTO reader_close_retry_audit(reader_id) VALUES (OLD.reader_id); END');
    });

    const deleting = f.repository.deleteAttachedMedia({ noteId, noteRevision: 3 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.repository.getRecord(record.mediaId).status, 'deletion_pending');
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE reader_id=?')
      .get(readerId).count), 1);

    await responseRepository.retryReaderCleanup(readerId);
    assert.equal((await deleting).status, 'unavailable');
    const outcome = f.kernel.withTrustedDatabaseTransaction((db) => ({
      ownRows: db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE reader_id=?').get(readerId).count,
      unrelatedRows: db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE reader_id=?').get(unrelatedReaderId).count,
      deletes: db.prepare('SELECT count(*) AS count FROM reader_close_retry_audit WHERE reader_id=?').get(readerId).count,
    }));
    assert.deepEqual(outcome, { ownRows: 0, unrelatedRows: 1, deletes: 1 });
    assert.equal(closeAttempts, 2);
    await assert.rejects(responseRepository.retryReaderCleanup(readerId), /cleanup_unavailable/);
  } finally { cleanup(f); }
});

test('an explicit reader cleanup retry cannot close or release a healthy active playback stream', async () => {
  const f = setup();
  try {
    const bytes = wavFixture();
    const record = await f.repository.ingest(chunks(bytes), { fileName: 'clip.wav', mimeType: 'audio/wav' });
    const noteId = 'active-reader-retry-note';
    f.setAttached({ mediaId: record.mediaId, noteId, noteRevision: 4 });
    const response = await f.repository.openAttachedMedia({ noteId, noteRevision: 4 });
    const readerId = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT reader_id FROM private_audio_readers WHERE media_id=?')
      .get(record.mediaId).reader_id);
    await assert.rejects(f.repository.retryReaderCleanup(readerId), /cleanup_unavailable/);
    assert.equal(response.body.destroyed, false);
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE reader_id=?')
      .get(readerId).count), 1);

    const closed = new Promise((resolve) => response.body.once('close', resolve));
    const received = [];
    for await (const part of response.body) received.push(part);
    await closed;
    assert.deepEqual(Buffer.concat(received), bytes);
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE reader_id=?')
      .get(readerId).count), 0);
  } finally { cleanup(f); }
});
