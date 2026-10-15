import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { PrivateAudioRepository } from '../dist/privateAudioRepository.js';
import { readAudioUploadHistory } from '../dist/audioUploadHistory.js';

const HOST_PROCESS_ID = randomUUID();

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-audio-history-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), validateSnapshot(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { notes: [] });
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const repository = new PrivateAudioRepository({ kernel, actorSessionToken: sessionToken, privateRoot: join(directory, 'private-audio'),
    processId: HOST_PROCESS_ID, resolveAttachedMedia: () => undefined });
  return { directory, kernel, ownerId, workspace, sessionToken, repository };
}
function cleanup(f) { try { f.kernel.close(); } catch {} rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
function insertUpload(db, { uploadId = randomUUID(), captureId = randomUUID(), captureRevision = randomUUID(), workspaceId,
  ownerId, epoch, createdAt, updatedAt = createdAt, status = 'failed' }) {
  const ready = ['ready', 'consumed'].includes(status);
  const consumed = status === 'consumed';
  db.prepare(`INSERT INTO private_audio_capture_uploads (upload_id,capture_id,capture_revision,workspace_id,owner_id,privacy_epoch,
    captured_at,time_zone,mime_type,expected_bytes,media_id,format,sha256,byte_length,duration_seconds,status,failure_code,
    consumed_command_id,note_id,note_revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uploadId, captureId, captureRevision, workspaceId, ownerId, epoch,
      '2026-10-15T02:03:04.000Z', 'Asia/Singapore', 'audio/mp4', null, randomUUID(), 'm4a', ready ? 'a'.repeat(64) : null,
      ready ? 2048 : null, ready ? 1.25 : null, status, status === 'failed' ? 'audio_invalid' : null,
      consumed ? randomUUID() : null, consumed ? randomUUID() : null, consumed ? 1 : null, createdAt, updatedAt);
  return { uploadId, captureId, captureRevision, createdAt, updatedAt, status };
}

test('history is owner and epoch scoped, stable across tied pages and excludes sensitive receipt fields without writes', () => {
  const f = setup();
  try {
    const identity = f.kernel.getOwnedIdentity(f.sessionToken);
    const foreignOwner = randomUUID();
    const foreignWorkspace = f.kernel.createWorkspace(foreignOwner, { notes: [] });
    const rows = f.kernel.withTrustedDatabaseTransaction((db) => {
      const result = [];
      const statuses = ['receiving', 'ready', 'failed', 'inspect_required', 'consumed', 'discarded'];
      for (let index = 0; index < 60; index += 1) insertUpload(db, { uploadId: `invalid-${index}`, workspaceId: identity.workspaceId,
        ownerId: identity.ownerId, epoch: identity.privacyEpoch, createdAt: 3000 });
      for (let index = 0; index < 55; index += 1) result.push(insertUpload(db, { uploadId: index === 0 ? randomUUID().toUpperCase() : randomUUID(),
        workspaceId: identity.workspaceId, ownerId: identity.ownerId, epoch: identity.privacyEpoch, createdAt: 1000, status: statuses[index % statuses.length] }));
      result.push(insertUpload(db, { workspaceId: identity.workspaceId, ownerId: identity.ownerId, epoch: identity.privacyEpoch + 1, createdAt: 1000 }));
      result.push(insertUpload(db, { workspaceId: foreignWorkspace.workspaceId, ownerId: foreignOwner, epoch: 0, createdAt: 1000 }));
      db.exec('DROP INDEX private_audio_capture_upload_history');
      db.prepare('UPDATE private_audio_schema SET version=2 WHERE singleton=1').run();
      result.push(insertUpload(db, { workspaceId: identity.workspaceId, ownerId: identity.ownerId, epoch: identity.privacyEpoch + 1, createdAt: 1000 }));
      db.exec(`CREATE TABLE history_read_audit (writes INTEGER NOT NULL) STRICT;
        CREATE TRIGGER history_read_no_insert AFTER INSERT ON private_audio_capture_uploads BEGIN INSERT INTO history_read_audit VALUES (1); END;
        CREATE TRIGGER history_read_no_update AFTER UPDATE ON private_audio_capture_uploads BEGIN INSERT INTO history_read_audit VALUES (1); END;
        CREATE TRIGGER history_read_no_delete AFTER DELETE ON private_audio_capture_uploads BEGIN INSERT INTO history_read_audit VALUES (1); END;
        CREATE TRIGGER history_read_schema_no_update AFTER UPDATE ON private_audio_schema BEGIN INSERT INTO history_read_audit VALUES (1); END;`);
      return result;
    });
    const first = readAudioUploadHistory(f.kernel, f.sessionToken);
    const auditCountBefore = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM history_read_audit').get().count);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.entries.length, 50);
    assert.ok(first.nextCursor);
    assert.equal(first.entries.every((entry) => Object.keys(entry).sort().join(',') === 'capture,createdAt,status,updatedAt,uploadId'), true);
    assert.equal(Object.keys(first.entries[0].capture).sort().join(','), 'capturedAt,id,revision,timeZone');
    const second = readAudioUploadHistory(f.kernel, f.sessionToken, first.nextCursor);
    assert.equal(second.entries.length, 5);
    assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.uploadId)).size, 55);
    assert.deepEqual([...first.entries, ...second.entries].map((entry) => entry.uploadId),
      [...rows.slice(0, 55)].sort((a, b) => a.uploadId === b.uploadId ? 0 : a.uploadId < b.uploadId ? 1 : -1).map((row) => row.uploadId));
    assert.equal(auditCountBefore, 0);
    const statusChanging = first.entries.find((entry) => entry.status === 'failed');
    assert.ok(statusChanging);
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare("UPDATE private_audio_capture_uploads SET status='discarded',updated_at=2000 WHERE upload_id=?").run(statusChanging.uploadId);
      insertUpload(db, { workspaceId: identity.workspaceId, ownerId: identity.ownerId, epoch: identity.privacyEpoch, createdAt: 2000 });
    });
    const afterMutation = readAudioUploadHistory(f.kernel, f.sessionToken, first.nextCursor);
    assert.equal(afterMutation.entries.length, 5);
    assert.equal(afterMutation.entries.some((entry) => first.entries.some((prior) => prior.uploadId === entry.uploadId)), false);
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM history_read_audit').get().count), 2);
    assert.deepEqual(f.kernel.withTrustedDatabaseTransaction((db) => ({
      version: db.prepare('SELECT version FROM private_audio_schema WHERE singleton=1').get().version,
      indexCount: db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name='private_audio_capture_upload_history'").get().count,
    })), { version: 2, indexCount: 0 });
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
    assert.throws(() => readAudioUploadHistory(f.kernel, f.sessionToken, Buffer.from(JSON.stringify({ ...decoded, scope: '0'.repeat(64) })).toString('base64url')), /cursor_invalid/);
    assert.throws(() => readAudioUploadHistory(f.kernel, f.sessionToken, Buffer.from(JSON.stringify({ ...decoded,
      uploadId: rows[55].uploadId })).toString('base64url')), /cursor_invalid/);
  } finally { cleanup(f); }
});

test('history reads schema 4 metadata without changing the database', () => {
  const f = setup();
  try {
    const version = f.kernel.withTrustedDatabaseTransaction((db) =>
      db.prepare('SELECT version FROM private_audio_schema WHERE singleton=1').get().version);
    assert.equal(version, 4);
    const changesBefore = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT total_changes() AS count').get().count);
    const page = readAudioUploadHistory(f.kernel, f.sessionToken);
    const changesAfter = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT total_changes() AS count').get().count);
    assert.deepEqual(page, { schemaVersion: 1, entries: [] });
    assert.equal(changesAfter, changesBefore, 'schema 4 history read performs no SQLite writes');
  } finally { cleanup(f); }
});

test('history safely reads a workspace without an audio table and fails closed on incomplete or future schemas', () => {
  const f = setup();
  const freshDirectory = mkdtempSync(join(tmpdir(), 'still-audio-history-fresh-'));
  const freshKernel = createDurableKernel({ databasePath: join(freshDirectory, 'workspace.sqlite'), validateSnapshot(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  try {
    const freshOwner = randomUUID();
    const freshWorkspace = freshKernel.createWorkspace(freshOwner, { notes: [] });
    const freshSession = freshKernel.createSession(freshWorkspace.workspaceId, freshOwner, Date.now() + 60 * 60_000);
    assert.deepEqual(readAudioUploadHistory(freshKernel, freshSession), { schemaVersion: 1, entries: [] });
    const emptyScope = createHash('sha256').update(JSON.stringify({ ownerId: freshOwner, workspaceId: freshWorkspace.workspaceId, privacyEpoch: 0 })).digest('hex');
    const emptyCursor = Buffer.from(JSON.stringify({ v: 1, scope: emptyScope, createdAt: 1, uploadId: randomUUID() })).toString('base64url');
    assert.throws(() => readAudioUploadHistory(freshKernel, freshSession, emptyCursor), /cursor_invalid/);
    const owner = randomUUID();
    const workspace = f.kernel.createWorkspace(owner, { notes: [] });
    const session = f.kernel.createSession(workspace.workspaceId, owner, Date.now() + 60 * 60_000);
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare('UPDATE private_audio_schema SET version=5 WHERE singleton=1').run();
    });
    assert.throws(() => readAudioUploadHistory(f.kernel, f.sessionToken), /schema_unsupported/);
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.exec('DROP TRIGGER private_audio_consumed_capture_immutable; DROP TABLE private_audio_capture_uploads;');
      db.prepare('UPDATE private_audio_schema SET version=3 WHERE singleton=1').run();
      db.exec('CREATE TABLE private_audio_capture_uploads (upload_id TEXT NOT NULL) STRICT;');
    });
    assert.throws(() => readAudioUploadHistory(f.kernel, f.sessionToken), /schema_invalid/);
  } finally { cleanup(f); try { freshKernel.close(); } catch {} rmSync(freshDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
