import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { CommandJournal, composeSnapshotCommitParticipants, ServerWorkspaceStore } from '../dist/workspaceRuntime.js';
import { DocumentLineage } from '../dist/documentLineage.js';

const PATH = 'memory/summary-source.md';
const STAMP = '2026-10-15T00:00:00.000Z';

function document(path, content, revision = 1) { return { path, content, revision, updatedAt: STAMP }; }
function saved(documents, extra = {}) { return { accounts: [], documents, ...extra }; }

function setup(initial = { documents: [] }, options = {}) {
  initial = { accounts: [], ...initial };
  const directory = mkdtempSync(join(tmpdir(), 'still-document-lineage-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, initial);
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const lineage = new DocumentLineage(kernel, sessionToken);
  const journal = new CommandJournal(kernel);
  const participants = [];
  if (options.replacement) participants.push({ name: 'replacement', participant: {
    beforeCommit(context, input) {
      const proof = options.replacement(input);
      if (proof) lineage.authorizeReplacementWithinTransaction(context, proof.path, proof.documentId, proof.revision);
    }, commit() {},
  } });
  participants.push({ name: 'lineage', participant: lineage.createSnapshotCommitParticipant() });
  if (options.afterLineageCommit) participants.push({ name: 'summary_application', participant: {
    commit(context, input) { options.afterLineageCommit(context, input, lineage); },
  } });
  const store = new ServerWorkspaceStore({ kernel, sessionToken, journal,
    snapshotCommitParticipant: composeSnapshotCommitParticipants(participants), ...options.storeOptions });
  return { directory, kernel, ownerId, workspace, sessionToken, lineage, store };
}

function close(f) {
  f.kernel.close();
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function capture(f, path = PATH) {
  return f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => f.lineage.captureDestination(context, path));
}

function assertCaptured(f, expected) {
  return f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => f.lineage.assertDestination(context, expected));
}

test('lazy backfill binds an existing document and ordinary edits preserve its incarnation', async () => {
  const f = setup({ documents: [document(PATH, 'before', 4)] });
  try {
    await f.store.load();
    const captured = capture(f);
    assert.equal(captured.expectedRevision, 4);
    assert.match(captured.documentId, /^[0-9a-f-]{36}$/i);
    await f.store.save(saved([document(PATH, 'after', 5)]));
    assert.equal(capture(f).documentId, captured.documentId);
    assert.throws(() => assertCaptured(f, captured), /destination_stale/);
  } finally { close(f); }
});

test('create, delete, and recreate advance absence generation and issue a fresh ID', async () => {
  const f = setup();
  try {
    await f.store.load();
    const absent = capture(f);
    assert.equal(absent.documentId, null);
    assert.equal(absent.expectedAbsenceGeneration, 0);
    await f.store.save(saved([document(PATH, 'first')]));
    const first = capture(f);
    assert.notEqual(first.documentId, absent.documentId);
    assert.throws(() => assertCaptured(f, absent), /destination_stale/);
    await f.store.save(saved([]));
    const deleted = capture(f);
    assert.equal(deleted.expectedAbsenceGeneration, 1);
    await f.store.save(saved([document(PATH, 'second')]));
    const recreated = capture(f);
    assert.notEqual(recreated.documentId, first.documentId);
    assert.throws(() => assertCaptured(f, first), /destination_stale/);
    assert.throws(() => assertCaptured(f, deleted), /destination_stale/);
  } finally { close(f); }
});

test('delete and identical-byte/revision recreation cannot reuse an old incarnation', async () => {
  const f = setup({ documents: [document(PATH, 'same bytes', 1)] });
  try {
    await f.store.load();
    const first = capture(f);
    await f.store.save(saved([]));
    await f.store.save(saved([document(PATH, 'same bytes', 1)]));
    const recreated = capture(f);
    assert.notEqual(recreated.documentId, first.documentId);
    assert.throws(() => assertCaptured(f, first), /destination_stale/);
  } finally { close(f); }
});

test('unrelated snapshot edits do not invalidate a document destination', async () => {
  const f = setup({ documents: [document(PATH, 'steady', 2)], marker: 0 });
  try {
    await f.store.load();
    const captured = capture(f);
    await f.store.save(saved([document(PATH, 'steady', 2)], { marker: 1 }));
    assert.equal(assertCaptured(f, captured), undefined);
  } finally { close(f); }
});

test('reads the resulting private incarnation only after the lineage participant commits', async () => {
  let committed;
  const f = setup({ documents: [] }, { afterLineageCommit(context, input, lineage) {
    committed = lineage.readCommittedDestinationWithinTransaction(context, PATH, input.nextRevision);
  } });
  try {
    await f.store.load();
    await f.store.save(saved([document(PATH, 'summary content')]));
    assert.equal(committed.path, PATH);
    assert.equal(committed.expectedRevision, 1);
    assert.match(committed.documentId, /^[0-9a-f-]{36}$/i);
    assert.equal(committed.expectedAbsenceGeneration, null);
    assert.deepEqual(capture(f), committed);
  } finally { close(f); }
});

test('committed-incarnation read rejects precommit, wrong revision, foreign, and expired transaction contexts', async () => {
  const f = setup({ documents: [] });
  try {
    await f.store.load();
    let expired;
    f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => {
      expired = context;
      assert.throws(() => f.lineage.readCommittedDestinationWithinTransaction(context, PATH, context.revision + 1), /committed_snapshot_mismatch/);
      assert.throws(() => f.lineage.readCommittedDestinationWithinTransaction(context, PATH, context.revision + 2), /context_rejected/);
    });
    assert.throws(() => f.lineage.readCommittedDestinationWithinTransaction(expired, PATH, expired.revision + 1), /active owned transaction/);

    const foreignWorkspace = f.kernel.createWorkspace(f.ownerId, { accounts: [], documents: [document(PATH, 'foreign')] });
    const foreignSession = f.kernel.createSession(foreignWorkspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    assert.throws(() => f.kernel.withOwnedTransaction(foreignSession, 0, (context) =>
      f.lineage.readCommittedDestinationWithinTransaction(context, PATH, context.revision + 1)), /context_rejected/);
  } finally { close(f); }
});

test('an initialized scope with a missing head fails closed', async () => {
  const f = setup({ documents: [document(PATH, 'source')] });
  try {
    await f.store.load();
    capture(f);
    f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => {
      context.db.prepare(`UPDATE document_lineage_heads SET document_revision=99 WHERE workspace_id=? AND path=?`).run(context.workspaceId, PATH);
    });
    assert.throws(() => capture(f), /head_invalid/);
  } finally { close(f); }
});

test('explicit replacement requires an exact same-transaction identity proof', async () => {
  let authorized = false;
  let currentId;
  const f = setup({ documents: [document(PATH, 'identical', 4)] }, {
    replacement: () => authorized ? { path: PATH, documentId: currentId, revision: 4 } : undefined,
  });
  try {
    await f.store.load();
    currentId = capture(f).documentId;
    authorized = true;
    await f.store.save(saved([document(PATH, 'replacement bytes', 3)]));
    const replaced = capture(f);
    assert.notEqual(replaced.documentId, currentId);
    assert.throws(() => assertCaptured(f, { ...replaced, documentId: currentId, expectedRevision: 4 }), /destination_stale/);
  } finally { close(f); }
});

test('changed bytes at a reused revision and revision regressions fail unless replacement is authorized', async () => {
  const f = setup({ documents: [document(PATH, 'original', 4)] });
  try {
    await f.store.load();
    const captured = capture(f);
    await assert.rejects(() => f.store.save(saved([document(PATH, 'changed', 4)])), /revision_reused/);
    await f.store.load();
    assert.equal(capture(f).documentId, captured.documentId);
    await assert.rejects(() => f.store.save(saved([document(PATH, 'older', 3)])), /revision_regression/);
    await f.store.load();
    assert.equal(capture(f).documentId, captured.documentId);
    await f.store.save(saved([document(PATH, 'next version', 5)]));
    assert.equal(capture(f).documentId, captured.documentId);
    assert.equal(capture(f).expectedRevision, 5);
  } finally { close(f); }
});

test('document content rejects malformed surrogate text while preserving valid Unicode', async () => {
  const f = setup({ documents: [document(PATH, 'emoji 😀', 1)] });
  try {
    await f.store.load();
    const captured = capture(f);
    assert.match(captured.documentId, /^[0-9a-f-]{36}$/i);
    await assert.rejects(() => f.store.save(saved([document(PATH, '\ud800', 2)])), /snapshot_invalid/);
    await f.store.load();
    assert.equal(capture(f).documentId, captured.documentId);
  } finally { close(f); }
});

test('mismatched and unused replacement proofs fail closed and roll back', async () => {
  let proof;
  const f = setup({ documents: [document(PATH, 'before', 1)] }, { replacement: () => proof });
  try {
    await f.store.load();
    const captured = capture(f);
    proof = { path: PATH, documentId: randomUUID(), revision: 1 };
    await assert.rejects(() => f.store.save(saved([document(PATH, 'after', 2)])), /replacement_stale/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 0);
    assert.equal(capture(f).documentId, captured.documentId);
    await f.store.load();
    proof = { path: PATH, documentId: captured.documentId, revision: 1 };
    await assert.rejects(() => f.store.save(saved([])), /replacement_proof_mismatch/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 0);
    assert.equal(capture(f).documentId, captured.documentId);
  } finally { close(f); }
});

test('failed later participant rolls back snapshot and all lineage changes', async () => {
  const f = setup({ documents: [document(PATH, 'before', 1)] });
  try {
    await f.store.load();
    const captured = capture(f);
    const failingStore = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken,
      snapshotCommitParticipant: composeSnapshotCommitParticipants([
        { name: 'lineage', participant: f.lineage.createSnapshotCommitParticipant() },
        { name: 'failure', participant: { commit() { throw new Error('forced_commit_failure'); } } },
      ]) });
    await failingStore.load();
    await assert.rejects(() => failingStore.save(saved([document(PATH, 'after', 2)])), /forced_commit_failure/);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).revision, 0);
    assert.equal(capture(f).documentId, captured.documentId);
    assert.equal(capture(f).expectedRevision, 1);
  } finally { close(f); }
});

test('lost acknowledgement blocks speculative saves until reload and keeps committed lineage', async () => {
  let loseAck = true;
  const f = setup({ documents: [document(PATH, 'before', 1)] }, { storeOptions: {
    afterCommitForTesting: () => { if (loseAck) throw new Error('lost_ack'); },
  } });
  try {
    await f.store.load();
    const before = capture(f);
    await assert.rejects(() => f.store.save(saved([document(PATH, 'after', 2)])), /lost_ack/);
    await assert.rejects(() => f.store.save(saved([document(PATH, 'speculative', 3)])), /reload/i);
    const committed = capture(f);
    assert.equal(committed.documentId, before.documentId);
    assert.equal(committed.expectedRevision, 2);
    loseAck = false;
    await f.store.load();
    await f.store.save(saved([document(PATH, 'final', 3)]));
    assert.equal(capture(f).documentId, before.documentId);
  } finally { close(f); }
});

test('duplicate or malformed snapshot paths reject without normalization', async () => {
  const f = setup({ documents: [document(PATH, 'one'), document(PATH, 'two')] });
  try {
    await f.store.load();
    assert.throws(() => capture(f), /duplicate_path/);
  } finally { close(f); }
});

test('foreign and expired transaction contexts cannot capture destinations', async () => {
  const f = setup();
  try {
    let expired;
    f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => { expired = context; });
    assert.throws(() => f.lineage.captureDestination(expired, PATH), /no longer active/);
    const otherOwner = randomUUID();
    const other = f.kernel.createWorkspace(otherOwner, { documents: [] });
    const foreignSession = f.kernel.createSession(other.workspaceId, otherOwner, Date.now() + 60 * 60_000);
    f.kernel.withOwnedTransaction(foreignSession, 0, (context) => {
      assert.throws(() => f.lineage.captureDestination(context, PATH), /context_rejected/);
    });
  } finally { close(f); }
});

test('unsupported lineage schema fails before it can be used', () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-document-lineage-schema-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { documents: [] });
  const session = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  try {
    kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TABLE document_lineage_schema(singleton INTEGER PRIMARY KEY,version INTEGER NOT NULL);
      INSERT INTO document_lineage_schema VALUES(1,99);`));
    assert.throws(() => new DocumentLineage(kernel, session), /schema_invalid|schema_unsupported/);
    const tables = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'document_lineage_%' ORDER BY name`).all());
    assert.deepEqual(tables.map((row) => row.name), ['document_lineage_schema']);
  } finally {
    kernel.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('v2 lineage trigger migration preserves heads and keeps deletes denied without a live erase grant', () => {
  const f = setup({ documents: [document(PATH, 'preserve this lineage', 7)] });
  try {
    const before = capture(f);
    f.kernel.withTrustedDatabaseTransaction((db) => {
      // Recreate the exact v2 trigger shape to exercise the on-disk upgrade path.
      db.exec(`DROP TRIGGER document_lineage_heads_no_delete;
        DROP TRIGGER document_lineage_scopes_no_delete;
        CREATE TRIGGER document_lineage_heads_no_delete BEFORE DELETE ON document_lineage_heads
          BEGIN SELECT RAISE(ABORT,'document_lineage_tombstones_are_durable'); END;
        CREATE TRIGGER document_lineage_scopes_no_delete BEFORE DELETE ON document_lineage_scopes
          BEGIN SELECT RAISE(ABORT,'document_lineage_scopes_are_durable'); END;
        UPDATE document_lineage_schema SET version=2 WHERE singleton=1;`);
    });

    const upgraded = new DocumentLineage(f.kernel, f.sessionToken);
    const after = f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => upgraded.captureDestination(context, PATH));
    assert.equal(after.documentId, before.documentId);
    assert.equal(after.expectedRevision, before.expectedRevision);
    f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => {
      assert.throws(() => context.db.prepare('DELETE FROM document_lineage_heads WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?')
        .run(context.workspaceId, context.ownerId, context.privacyEpoch), /document_lineage_tombstones_are_durable/);
    });
    const marker = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT version FROM document_lineage_schema WHERE singleton=1').get());
    assert.equal(marker.version, 3);
  } finally { close(f); }
});
