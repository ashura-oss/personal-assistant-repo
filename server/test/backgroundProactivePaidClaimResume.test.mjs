import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

const worker = join(process.cwd(), 'test', 'fixtures', 'proactivePaidClaimCrashWorker.mjs');
const password = 'paid reply synthetic fixture password';
const batchId = 'batch-after-mapped-no-job-recovery';

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

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-paidclaim-resume-'));
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

async function crashAtPaidClaim(state) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, state.directory], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('paidclaim crash worker timed out')); }, 20_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 73 || signal !== null) return reject(new Error(`paidclaim crash worker exited ${code}/${signal}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`paidclaim crash receipt invalid: ${stderr}`)); }
    });
  });
}

test('a mapped no-job paid claim cold-recovers, reuses its exact occurrence bytes, and submits exactly once', async () => {
  const state = makeFixture();
  const realDate = globalThis.Date;
  let opened;
  let actors;
  let runtime;
  let posts = 0;
  try {
    const child = await crashAtPaidClaim(state);
    assert.equal(child.preflight.status, 'reading');
    assert.ok(child.preflight.paid_occurrence_id);
    assert.ok(child.preflight.paid_attempt_id);
    assert.equal(child.paid.status, 'claimed');
    assert.equal(child.journalPresent, false);
    assert.equal(child.linkPresent, false);
    assert.equal(child.matchingJob, false);
    assert.match(child.requestAsOf, /^\d{4}-\d\d-\d\dT/);

    opened = openServerFoundationInternal(state.config);
    opened.privateContext.startup.beginRecovery();
    createProductionApplicationRuntimeFactory(state.config, { fetcher: async () => {
      throw new Error('provider fetch is forbidden during cold recovery');
    } }).recoverProactivePreflights({ kernel: opened.privateContext.kernel,
      startupCapability: opened.privateContext.startup.capability });
    const recovered = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => ({
      preflight: db.prepare(`SELECT status,result_code,paid_occurrence_id,paid_attempt_id FROM background_proactive_preflight_attempts
        WHERE workspace_id=? AND attempt_id=?`).get(child.workspaceId, child.preflight.attempt_id),
      occurrence: db.prepare(`SELECT status,scheduled_at FROM background_occurrences WHERE workspace_id=? AND occurrence_id=?`)
        .get(child.workspaceId, child.preflight.paid_occurrence_id),
      paid: db.prepare(`SELECT status,result_code FROM background_occurrence_attempts WHERE workspace_id=? AND attempt_id=?`)
        .get(child.workspaceId, child.preflight.paid_attempt_id),
    }));
    assert.equal(recovered.preflight.status, 'deferred');
    assert.equal(recovered.preflight.result_code, 'startup_before_submit_recovered');
    assert.deepEqual(recovered.occurrence, { status: 'scheduled', scheduled_at: recovered.occurrence.scheduled_at });
    assert.deepEqual(recovered.paid, { status: 'skipped', result_code: 'startup_before_submit_recovered' });

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
        posts += 1;
        return new Response(JSON.stringify({ id: batchId, object: 'batch', status: 'validating', endpoint: '/v1/chat/completions',
          model: 'openai/gpt-6-luna', completion_window: '24h', request_counts: { total: 1, completed: 0, failed: 0 } }),
        { status: 202, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected provider request ${init.method ?? 'GET'} ${new URL(url).pathname}`);
    } })({ kernel: opened.privateContext.kernel, vault: opened.privateContext.vault, auth: opened.foundation.auth,
      runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
      processInstanceId: opened.privateContext.processInstanceId, createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });

    const completed = await waitUntil(() => opened.privateContext.kernel.withTrustedDatabaseTransaction((db) => {
      const workspace = db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(child.workspaceId);
      const jobs = JSON.parse(workspace.snapshot_json).openRouterBatchLedger.jobs.filter((job) => job.kind === 'mail_reply');
      const preflights = db.prepare(`SELECT attempt_number,status,result_code,paid_occurrence_id,paid_attempt_id FROM background_proactive_preflight_attempts
        WHERE workspace_id=? AND policy_id=? ORDER BY attempt_number`).all(child.workspaceId, child.policyId);
      const linkTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_paid_batch_links'").get());
      const links = linkTable ? db.prepare(`SELECT occurrence_id,attempt_id,command_id,job_id,request_sha256 FROM background_paid_batch_links
        WHERE workspace_id=? AND policy_id=?`).all(child.workspaceId, child.policyId) : [];
      const occurrences = db.prepare(`SELECT occurrence_id,status,request_json FROM background_occurrences WHERE workspace_id=?`).all(child.workspaceId);
      return { jobs, preflights, links, occurrences };
    }), (value) => value.preflights.at(-1)?.status === 'complete' && value.links.length === 1 &&
      value.jobs.some((job) => job.status === 'queued' && job.batchId === batchId),
    'mapped no-job recovery did not complete a fresh scheduled submission');
    assert.equal(posts, 1);
    assert.equal(completed.preflights.length, 2);
    assert.equal(completed.preflights[0].status, 'deferred');
    assert.equal(completed.preflights[1].status, 'complete');
    assert.equal(completed.preflights[1].paid_occurrence_id, child.preflight.paid_occurrence_id);
    assert.notEqual(completed.preflights[1].paid_attempt_id, child.preflight.paid_attempt_id);
    assert.equal(completed.links[0].occurrence_id, child.preflight.paid_occurrence_id);
    assert.equal(completed.links[0].attempt_id, completed.preflights[1].paid_attempt_id);
    assert.equal(completed.links[0].command_id, completed.links[0].attempt_id);
    const newJob = completed.jobs.find((job) => job.status === 'queued' && job.batchId === batchId);
    assert.ok(newJob);
    assert.equal(newJob.proactiveMailReply.occurrenceId, child.preflight.paid_occurrence_id);
    assert.equal(completed.occurrences[0].request_json && JSON.parse(completed.occurrences[0].request_json).requestAsOf, child.requestAsOf,
      'the recovered occurrence retains the exact original request timestamp');
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
