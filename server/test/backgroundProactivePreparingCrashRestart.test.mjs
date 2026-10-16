import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';

const worker = join(process.cwd(), 'test', 'fixtures', 'proactivePreparingJobCrashWorker.mjs');
const password = 'paid reply synthetic fixture password';
const batchId = 'batch-after-certified-recovery';

function waitUntil(read, predicate, label, timeoutMs = 12_000) {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = read(); } catch (error) { reject(error); return; }
      if (predicate(value)) { resolve(value); return; }
      if (performance.now() >= deadline) { reject(new Error(`${label}: ${JSON.stringify(value)}`)); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-preparing-restart-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'paid-reply-client',
    STILL_GOOGLE_CLIENT_SECRET: 'test-only-synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  return { directory, staticRoot, config };
}

async function crashDuringPreparing(state, status = 'preparing', lostProviderAck = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, state.directory, status, String(lostProviderAck)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('preparing crash worker timed out')); }, 20_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 73 || signal !== null) return reject(new Error(`preparing crash worker exited ${code}/${signal}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`preparing crash receipt invalid: ${stderr}`)); }
    });
  });
}

test('a real child crash after preparing save is certified, normalized, then safely resumed by the production timer', async () => {
  const state = fixture();
  const realDate = globalThis.Date;
  let opened;
  let actors;
  let runtime;
  let providerPosts = 0;
  try {
    const child = await crashDuringPreparing(state);
    assert.equal(child.recoveryEvidence.job.status, 'preparing');
    assert.equal(child.recoveryEvidence.preflight.status, 'reading');
    assert.equal(child.recoveryEvidence.journal.status, 'checkpointed');
    assert.ok(Number.isSafeInteger(child.recoveryEvidence.journal.checkpoint_revision));
    assert.match(child.recoveryEvidence.journal.snapshot_digest, /^[a-f0-9]{64}$/);

    opened = openServerFoundationInternal(state.config);
    opened.privateContext.startup.beginRecovery();
    const checkpointProof = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => ({
      workspace: db.prepare('SELECT revision,snapshot_json FROM workspaces WHERE id=?').get(child.workspaceId),
    }));
    assert.equal(checkpointProof.workspace.revision, child.recoveryEvidence.journal.checkpoint_revision);
    assert.equal(createHash('sha256').update(checkpointProof.workspace.snapshot_json, 'utf8').digest('hex'),
      child.recoveryEvidence.journal.snapshot_digest);
    const recovery = createProductionApplicationRuntimeFactory(state.config, { fetcher: async () => {
      throw new Error('provider fetch is forbidden during cold recovery');
    } }).recoverProactivePreflights;
    recovery({ kernel: opened.privateContext.kernel, startupCapability: opened.privateContext.startup.capability });
    const certificate = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => ({
      count: db.prepare(`SELECT count(*) AS count FROM background_proactive_not_submitted_certificates WHERE workspace_id=? AND owner_id=?`)
        .get(child.workspaceId, child.ownerId).count,
      preflight: db.prepare(`SELECT status,result_code,paid_occurrence_id,paid_attempt_id FROM background_proactive_preflight_attempts
        WHERE workspace_id=? AND policy_id=? ORDER BY attempt_number DESC LIMIT 1`).get(child.workspaceId, child.policyId),
      journal: db.prepare(`SELECT status,checkpoint_revision,snapshot_digest FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`)
        .get(child.workspaceId, child.recoveryEvidence.journal.idempotency_key),
    }));
    assert.equal(certificate.count, 1);
    assert.equal(certificate.preflight.status, 'deferred');
    assert.equal(certificate.preflight.result_code, 'startup_not_submitted_recovered');
    assert.equal(certificate.journal.status, 'inspect_required');
    assert.equal(certificate.journal.checkpoint_revision, child.recoveryEvidence.journal.checkpoint_revision);
    assert.equal(certificate.journal.snapshot_digest, child.recoveryEvidence.journal.snapshot_digest);

    const resumedAt = realDate.now() + 61_000;
    globalThis.Date = class RecoveryClock extends realDate {
      constructor(...args) { super(...(args.length ? args : [resumedAt])); }
      static now() { return resumedAt; }
    };
    opened.privateContext.startup.seal();
    actors = new ProcessWorkspaceActors(opened.privateContext.kernel);
    runtime = await createProductionApplicationRuntimeFactory(state.config, { fetcher: async (input, init = {}) => {
      const url = String(input);
      if (init.method === 'POST' && url === 'https://openrouter.ai/api/v1/batches') {
        providerPosts += 1;
        return new Response(JSON.stringify({ id: batchId, object: 'batch', status: 'validating', endpoint: '/v1/chat/completions',
          model: 'openai/gpt-6-luna', completion_window: '24h', request_counts: { total: 1, completed: 0, failed: 0 } }),
        { status: 202, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected provider request ${init.method ?? 'GET'} ${new URL(url).pathname}`);
    } })({ kernel: opened.privateContext.kernel, vault: opened.privateContext.vault, auth: opened.foundation.auth,
      runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
      processInstanceId: opened.privateContext.processInstanceId, createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });

    const final = await waitUntil(() => opened.privateContext.kernel.withTrustedDatabaseTransaction((db) => {
      const workspace = db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(child.workspaceId);
      const jobs = JSON.parse(workspace.snapshot_json).openRouterBatchLedger.jobs.filter((job) => job.kind === 'mail_reply');
      const attempts = db.prepare(`SELECT attempt_number,status,result_code,next_due_at,paid_occurrence_id,paid_attempt_id FROM background_proactive_preflight_attempts
        WHERE workspace_id=? AND policy_id=? ORDER BY attempt_number`).all(child.workspaceId, child.policyId);
      const occurrences = db.prepare(`SELECT o.occurrence_id,o.status AS occurrence_status,a.status AS paid_status,t.status AS target_status,t.attempt_id AS target_attempt_id FROM background_occurrences o
        JOIN background_occurrence_attempts a USING(workspace_id,owner_id,privacy_epoch,occurrence_id)
        JOIN background_occurrence_targets t USING(workspace_id,owner_id,privacy_epoch,occurrence_id,target_id,target_generation)
        WHERE o.workspace_id=?`).all(child.workspaceId);
      return { jobs, attempts, occurrences };
    }), (value) => value.jobs.some((job) => job.status === 'failed' && job.failureCode === 'not_submitted') &&
      value.jobs.some((job) => job.status === 'queued' && job.batchId === batchId) && value.attempts.at(-1)?.status === 'complete',
    'certified preparing job did not normalize and safely resume');
    assert.equal(providerPosts, 1, 'only the recovered, certified-not-submitted job gets one fresh provider POST');
    assert.equal(final.jobs.length, 2);
    assert.equal(final.jobs.filter((job) => job.status === 'failed' && job.failureCode === 'not_submitted').length, 1);
    assert.equal(final.jobs.filter((job) => job.status === 'queued' && job.batchId === batchId).length, 1);
    assert.deepEqual(final.attempts.map((attempt) => attempt.attempt_number), [1, 2]);
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
