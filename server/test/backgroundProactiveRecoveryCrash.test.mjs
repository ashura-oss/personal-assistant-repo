import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';

const crashWorker = join(process.cwd(), 'test', 'fixtures', 'proactivePreflightCrashWorker.mjs');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-cold-recovery-'));
  const staticRoot = join(directory, 'public');
  const dataDirectory = join(directory, 'private', 'data');
  const keyFile = join(directory, 'private', 'keys', 'root.key');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  const config = loadServerConfig({ STILL_ORIGIN: 'https://app.example.test', STILL_DATA_DIR: dataDirectory,
    STILL_VAULT_KEY_FILE: keyFile }, { staticRoot });
  return { directory, staticRoot, dataDirectory, keyFile, config };
}

async function waitUntil(read, predicate, label, timeoutMs = 8_000) {
  const deadline = performance.now() + timeoutMs;
  return await new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = read(); } catch (error) { reject(error); return; }
      if (predicate(value)) { resolve(value); return; }
      if (performance.now() >= deadline) { reject(new Error(`${label}: ${JSON.stringify(value)}`)); return; }
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function runCrashWorker(state, mode = 'unmapped') {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [crashWorker, state.dataDirectory, state.keyFile, state.staticRoot, mode],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('proactive_crash_fixture_timeout')); }, 15_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 73 || signal !== null) return reject(new Error(`proactive_crash_fixture_exit:${code}:${signal}:${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`proactive_crash_fixture_output_invalid:${stderr}`)); }
    });
  });
}

test('real child-process crash while reading preflight is deferred by the exact production cold-start hook', async () => {
  const state = fixture();
  let opened;
  try {
    const childReceipt = await runCrashWorker(state);
    // The child has exited with an unhandled process exit before closing its kernel.
    opened = openServerFoundationInternal(state.config);
    opened.privateContext.startup.beginRecovery();
    const hook = createProductionApplicationRuntimeFactory(state.config, { fetcher: async () => {
      throw new Error('provider access is closed in this fixture');
    } }).recoverProactivePreflights;
    hook({ kernel: opened.privateContext.kernel, startupCapability: opened.privateContext.startup.capability });

    const recovered = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => {
      const workspace = db.prepare('SELECT revision,privacy_epoch FROM workspaces WHERE id=? AND owner_id=?').get(childReceipt.workspaceId, childReceipt.ownerId);
      const attempt = db.prepare(`SELECT status,result_code,recovery_protocol_version,paid_occurrence_id,paid_attempt_id
        FROM background_proactive_preflight_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND attempt_id=?`)
        .get(childReceipt.workspaceId, childReceipt.ownerId, childReceipt.attemptId);
      const certificateCount = db.prepare(`SELECT count(*) AS count FROM background_proactive_not_submitted_certificates
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`).get(childReceipt.workspaceId, childReceipt.ownerId).count;
      return { workspace, attempt, certificateCount };
    });
    assert.deepEqual(recovered.workspace, { revision: 0, privacy_epoch: 0 }, 'recovery does not rewrite the canonical snapshot');
    assert.deepEqual(recovered.attempt, { status: 'deferred', result_code: 'startup_unmapped_preflight', recovery_protocol_version: 1,
      paid_occurrence_id: null, paid_attempt_id: null });
    assert.equal(recovered.certificateCount, 0, 'unmapped preflight recovery does not mint a paid-work certificate');
  } finally {
    if (opened) {
      opened.privateContext.startup.seal();
      opened.foundation.close();
    }
    rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('real child-process crash after a mapped paid claim but before preparing-job save requeues only the exact unsubmitted attempt', async () => {
  const state = fixture();
  const realDate = globalThis.Date;
  let opened;
  let actors;
  let runtime;
  let providerCalls = 0;
  try {
    const childReceipt = await runCrashWorker(state, 'mapped');
    assert.ok(childReceipt.paidOccurrenceId);
    assert.ok(childReceipt.paidAttemptId);
    opened = openServerFoundationInternal(state.config);
    opened.privateContext.startup.beginRecovery();
    const recovery = createProductionApplicationRuntimeFactory(state.config, { fetcher: async () => {
      throw new Error('provider access is closed in this fixture');
    } }).recoverProactivePreflights;
    recovery({ kernel: opened.privateContext.kernel, startupCapability: opened.privateContext.startup.capability });

    const recovered = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => {
      const preflight = db.prepare(`SELECT status,result_code,paid_occurrence_id,paid_attempt_id,recovery_protocol_version
        FROM background_proactive_preflight_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND attempt_id=?`)
        .get(childReceipt.workspaceId, childReceipt.ownerId, childReceipt.attemptId);
      const occurrence = db.prepare(`SELECT o.status AS occurrence_status,o.batch_job_id,a.status AS attempt_status,a.result_code,
          a.accounting_json,t.status AS target_status,t.attempt_id AS target_attempt_id
        FROM background_occurrences o JOIN background_occurrence_attempts a ON a.workspace_id=o.workspace_id AND a.owner_id=o.owner_id
          AND a.privacy_epoch=o.privacy_epoch AND a.occurrence_id=o.occurrence_id
        JOIN background_occurrence_targets t ON t.workspace_id=a.workspace_id AND t.owner_id=a.owner_id AND t.privacy_epoch=a.privacy_epoch
          AND t.occurrence_id=a.occurrence_id AND t.target_id=a.target_id AND t.target_generation=a.target_generation
        WHERE o.workspace_id=? AND o.owner_id=? AND o.privacy_epoch=0 AND o.occurrence_id=? AND a.attempt_id=?`)
        .get(childReceipt.workspaceId, childReceipt.ownerId, childReceipt.paidOccurrenceId, childReceipt.paidAttemptId);
      const certificateCount = db.prepare(`SELECT count(*) AS count FROM background_proactive_not_submitted_certificates
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`).get(childReceipt.workspaceId, childReceipt.ownerId).count;
      const journalExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='async_command_journal'").get());
      const journalCount = journalExists
        ? db.prepare(`SELECT count(*) AS count FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`)
          .get(childReceipt.workspaceId, childReceipt.paidAttemptId).count
        : 0;
      return { preflight, occurrence, certificateCount, journalCount };
    });
    assert.deepEqual(recovered.preflight, { status: 'deferred', result_code: 'startup_before_submit_recovered',
      paid_occurrence_id: childReceipt.paidOccurrenceId, paid_attempt_id: childReceipt.paidAttemptId, recovery_protocol_version: 1 });
    assert.deepEqual(recovered.occurrence, { occurrence_status: 'scheduled', batch_job_id: null, attempt_status: 'skipped',
      result_code: 'startup_before_submit_recovered', accounting_json: '{"status":"not_applicable"}',
      target_status: 'pending', target_attempt_id: null });
    assert.equal(recovered.certificateCount, 0, 'no preparing Batch job exists to certify');
    assert.equal(recovered.journalCount, 0, 'the pre-submit claim never created a command admission');

    // Move the controlled wall clock forward only after recovery has durably
    // scheduled the exact retry. No due-row is manually edited.
    const resumedAt = realDate.now() + 61_000;
    globalThis.Date = class RecoveryClock extends realDate {
      constructor(...args) { super(...(args.length ? args : [resumedAt])); }
      static now() { return resumedAt; }
    };
    opened.privateContext.startup.seal();
    actors = new ProcessWorkspaceActors(opened.privateContext.kernel);
    runtime = await createProductionApplicationRuntimeFactory(state.config, { fetcher: async (_input, init = {}) => {
      providerCalls += 1;
      assert.notEqual(init.method, 'POST', 'recovery may resume a source read but may not repeat paid submission');
      throw new Error('synthetic source read is unavailable without an OAuth credential');
    } })({ kernel: opened.privateContext.kernel, vault: opened.privateContext.vault, auth: opened.foundation.auth,
      runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
      processInstanceId: opened.privateContext.processInstanceId, createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });
    const resumed = await waitUntil(() => opened.privateContext.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`
      SELECT attempt_number,status,result_code FROM background_proactive_preflight_attempts
      WHERE workspace_id=? AND owner_id=? AND candidate_id=? AND policy_id=? ORDER BY attempt_number DESC LIMIT 1`)
      .get(childReceipt.workspaceId, childReceipt.ownerId, childReceipt.candidateId, childReceipt.policyId)),
    (row) => row?.attempt_number === 2 && ['deferred', 'inspect_required'].includes(row.status),
    'restarted production timer did not create a fresh preflight attempt');
    assert.equal(resumed.attempt_number, 2);
    assert.equal(providerCalls, 0, 'the missing OAuth credential prevents any provider request');
    const paidHistory = opened.privateContext.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`
      SELECT status,paid_occurrence_id,paid_attempt_id FROM background_proactive_preflight_attempts
      WHERE workspace_id=? AND owner_id=? AND candidate_id=? AND policy_id=? ORDER BY attempt_number`)
      .all(childReceipt.workspaceId, childReceipt.ownerId, childReceipt.candidateId, childReceipt.policyId));
    assert.equal(paidHistory.length, 2);
    assert.equal(paidHistory[0].status, 'deferred');
    assert.equal(paidHistory[1].paid_occurrence_id, null, 'fresh preflight runs before another paid occurrence can be claimed');
    assert.equal(paidHistory[1].paid_attempt_id, null);
  } finally {
    globalThis.Date = realDate;
    if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
    if (actors) await actors.closeAfterDrain(async () => {});
    if (opened) {
      try { opened.privateContext.startup.seal(); } catch {}
      opened.foundation.close();
    }
    rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
