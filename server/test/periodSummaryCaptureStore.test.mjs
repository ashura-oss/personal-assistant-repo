import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/kernel.js';
import { PeriodSummaryCaptureStore } from '../dist/periodSummaryCaptureStore.js';
import { canonicalBackgroundJson } from '../dist/backgroundContracts.js';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-summary-capture-store-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { accounts: [], documents: [] });
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const store = new PeriodSummaryCaptureStore(kernel, sessionToken);
  return { directory, kernel, workspace, ownerId, sessionToken, store, close() {
    kernel.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  } };
}

function evidence(f) {
  const sourceProofs = Object.freeze([{ kind: 'note', locator: randomUUID(), version: 'r1', contentSha256: 'a'.repeat(64) }]);
  return Object.freeze({ schemaVersion: 1, workspaceId: f.workspace.workspaceId, ownerId: f.ownerId, privacyEpoch: 0,
    policyId: randomUUID(), policyRevision: 1, policyDigest: 'b'.repeat(64), executionOptionsDigest: 'c'.repeat(64),
    occurrenceSourceDigest: '1'.repeat(64), occurrenceRequestDigest: '2'.repeat(64), occurrenceSourceVersionDigest: null,
    occurrenceId: randomUUID(), attemptId: randomUUID(), commandId: randomUUID(), ticketId: randomUUID(), jobId: randomUUID(), customId: '',
    requestSha256: 'd'.repeat(64), linkCreatedAt: Date.now(), sourceManifestSha256: 'e'.repeat(64),
    sourceProofSha256: sha(canonicalBackgroundJson(sourceProofs)), sourceProofs,
    period: 'daily', timeZone: 'UTC', localInterval: { start: '2026-10-14', end: '2026-10-15' },
    utcInterval: { start: '2026-10-14T00:00:00.000Z', endExclusive: '2026-10-15T00:00:00.000Z' },
    preparedAt: '2026-10-15T01:00:00.000Z', destination: { path: 'memory/summaries/daily/2026-10-14.md', documentId: null,
      expectedRevision: null, expectedAbsenceGeneration: 0 } });
}

function withTx(f, callback) {
  return f.kernel.withOwnedTransaction(f.sessionToken, 0, callback);
}

test('capture evidence is immutable, scoped, and phase transitions require exact expected state', () => {
  const f = setup();
  try {
    const row = evidence(f);
    const complete = Object.freeze({ ...row, customId: row.jobId });
    withTx(f, (context) => {
      f.store.insertPreparingWithinTransaction(context, complete);
      assert.deepEqual(f.store.readEvidenceWithinTransaction(context, complete.jobId), complete);
      assert.equal(f.store.readPhaseWithinTransaction(context, complete.jobId).phase, 'preparing');
    });
    withTx(f, (context) => {
      f.store.transitionWithinTransaction(context, complete.jobId, complete.requestSha256, 'preparing', 'submitting');
      assert.equal(f.store.readPhaseWithinTransaction(context, complete.jobId).phase, 'submitting');
      assert.throws(() => f.store.transitionWithinTransaction(context, complete.jobId, complete.requestSha256, 'preparing', 'submitting'),
        /period_summary_capture_phase_stale/);
    });
    assert.throws(() => withTx(f, (context) => f.store.transitionWithinTransaction(context, complete.jobId,
      complete.requestSha256, 'submitting', 'submitted')), /period_summary_capture_phase_transition_invalid/);
    withTx(f, (context) => {
      f.store.transitionWithinTransaction(context, complete.jobId, complete.requestSha256, 'submitting', 'submitted', { batchId: 'batch-1', status: 'queued' });
      assert.deepEqual(f.store.readPhaseWithinTransaction(context, complete.jobId), { jobId: complete.jobId, requestSha256: complete.requestSha256,
        phase: 'submitted', batchId: 'batch-1', status: 'queued', updatedAt: context.now });
      assert.throws(() => context.db.prepare('UPDATE period_summary_capture_evidence SET request_sha256=? WHERE job_id=?')
        .run('f'.repeat(64), complete.jobId), /immutable/);
    });
  } finally { f.close(); }
});

test('capture evidence and its mutable phase roll back with the surrounding workspace transaction', () => {
  const f = setup();
  try {
    const row = evidence(f);
    const complete = Object.freeze({ ...row, customId: row.jobId });
    assert.throws(() => withTx(f, (context) => {
      f.store.insertPreparingWithinTransaction(context, complete);
      throw new Error('synthetic checkpoint fault');
    }), /synthetic checkpoint fault/);
    withTx(f, (context) => {
      assert.equal(f.store.readEvidenceWithinTransaction(context, complete.jobId), undefined);
      assert.equal(f.store.readPhaseWithinTransaction(context, complete.jobId), undefined);
    });
  } finally { f.close(); }
});

test('capture evidence rejects forged scope, altered proof digest, duplicate occurrence and malformed schema', () => {
  const f = setup();
  try {
    const row = evidence(f); const complete = Object.freeze({ ...row, customId: row.jobId });
    assert.throws(() => withTx(f, (context) => f.store.insertPreparingWithinTransaction(context,
      Object.freeze({ ...complete, ownerId: randomUUID() }))), /period_summary_capture_scope_changed/);
    assert.throws(() => withTx(f, (context) => f.store.insertPreparingWithinTransaction(context,
      Object.freeze({ ...complete, sourceProofSha256: '0'.repeat(64) }))), /period_summary_capture_evidence_invalid/);
    withTx(f, (context) => f.store.insertPreparingWithinTransaction(context, complete));
    const duplicate = Object.freeze({ ...evidence(f), customId: '' });
    const conflict = Object.freeze({ ...duplicate, customId: duplicate.jobId, occurrenceId: complete.occurrenceId });
    assert.throws(() => withTx(f, (context) => f.store.insertPreparingWithinTransaction(context, conflict)), (error) =>
      typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT'));
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec(`DROP TRIGGER period_summary_capture_evidence_no_update;
      CREATE TRIGGER period_summary_capture_evidence_no_update BEFORE UPDATE ON period_summary_capture_evidence
      BEGIN SELECT 1; END;`));
    assert.throws(() => new PeriodSummaryCaptureStore(f.kernel, f.sessionToken), /period_summary_capture_schema_invalid/);
  } finally { f.close(); }
});
