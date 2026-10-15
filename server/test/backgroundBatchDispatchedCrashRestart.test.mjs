import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { recoverInterruptedBatchObservations } from '../dist/batchObservationIndex.js';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';

const OPENROUTER_BATCH_MODEL = 'openai/gpt-6-luna:batch';
function waitUntil(read, predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = read(); } catch (error) { reject(error); return; }
      if (predicate(value)) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error(`${label}: ${JSON.stringify(value)}`)); return; }
      setTimeout(poll, 25);
    };
    poll();
  });
}
test('a crash during dispatched GET is recovered for one fresh GET without replaying the original command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-batch-dispatched-crash-'));
  mkdirSync(join(directory, 'public'), { recursive: true });
  let opened;
  let actors;
  let runtime;
  let child;
  try {
    const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
      STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') }, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
    const jobId = randomUUID();
    const batchId = 'batch-observation-crash-fixture';
    const initial = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
      openRouterModel: OPENROUTER_BATCH_MODEL, openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
    initial.openRouterBatchLedger = { version: 1, jobs: [{ id: jobId, customId: jobId, kind: 'note_assistance', status: 'source_removed',
      sourceRemoved: true, createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date(Date.now() - 120_000).toISOString(),
      model: OPENROUTER_BATCH_MODEL, effort: 'none', requestSha256: 'c'.repeat(64), unknownCharge: true,
      requestProfileVersion: 1, batchId }] };
    opened = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => initial });
    const enrolled = await opened.foundation.auth.enrollOwner('batch crash synthetic fixture password', initial);
    const { kernel, vault } = opened.privateContext;
    const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, Date.now() + 60 * 60_000);
    kernel.withOwnedTransaction(actor, 0, (context) => vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0,
      'test-only-synthetic-openrouter-key'));
    opened.foundation.close();
    opened = undefined;

    child = spawn(process.execPath, [join(process.cwd(), 'test', 'fixtures', 'batchObservationCrashWorker.mjs'), directory, 'dispatched'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let childStderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { childStderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('crash worker did not reach the dispatched GET checkpoint')); }, 15_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    child = undefined;
    assert.equal(exit.code, 73, `worker must exit abruptly after journal and dispatched-attempt admission: ${childStderr}`);
    assert.equal(exit.signal, null);

    opened = openServerFoundationInternal(config);
    const { kernel: restartedKernel, vault: restartedVault, startup } = opened.privateContext;
    startup.beginRecovery();
    recoverInterruptedBatchObservations(restartedKernel, startup.capability);
    startup.seal();
    const original = restartedKernel.withTrustedDatabaseTransaction((db) => ({
      command: db.prepare(`SELECT idempotency_key,status FROM async_command_journal WHERE command_kind='assistant.batch.check'`).get(),
      attempt: db.prepare(`SELECT status,result_code,next_due_at FROM batch_observation_attempts WHERE job_id=?`).get(jobId),
    }));
    assert.equal(original.command?.status, 'inspect_required');
    assert.equal(original.attempt?.status, 'deferred');
    assert.equal(original.attempt?.result_code, 'interrupted_get_retry');
    actors = new ProcessWorkspaceActors(restartedKernel);
    let providerGets = 0;
    runtime = await createProductionApplicationRuntimeFactory(config, { fetcher: async (input, init = {}) => {
      providerGets += 1;
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(String(input), `https://openrouter.ai/api/v1/batches/${batchId}`);
      return new Response(JSON.stringify({ id: batchId, object: 'batch', status: 'in_progress', endpoint: '/v1/chat/completions',
        model: OPENROUTER_BATCH_MODEL, completion_window: '24h', request_counts: { total: 1, completed: 0, failed: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json', 'retry-after': '7200' } });
    } })({ kernel: restartedKernel, vault: restartedVault, auth: opened.foundation.auth,
      runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
      processInstanceId: opened.privateContext.processInstanceId, createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });
    const state = await waitUntil(() => restartedKernel.withTrustedDatabaseTransaction((db) => {
      const commands = db.prepare(`SELECT idempotency_key,status FROM async_command_journal WHERE command_kind='assistant.batch.check'`).all();
      const attempts = db.prepare(`SELECT command_id,status,result_code,next_due_at FROM batch_observation_attempts WHERE job_id=?`).all(jobId);
      const job = db.prepare('SELECT state,next_due_at FROM batch_observation_jobs WHERE job_id=?').get(jobId);
      return { commands, attempts, job };
    }), (current) => {
      const replacement = current.commands.find((item) => item.idempotency_key !== original.command.idempotency_key && item.status === 'finished');
      const replacementAttempt = replacement && current.attempts.find((item) => item.command_id === replacement.idempotency_key);
      return replacementAttempt?.status === 'deferred' && replacementAttempt.result_code === 'provider_pending' &&
        replacementAttempt.next_due_at >= Date.now() + 7_100_000 && current.job?.next_due_at >= Date.now() + 7_100_000;
    }, 'restarted runtime did not settle a fresh GET observation');
    assert.equal(providerGets, 1);
    assert.equal(state.commands.length, 2);
    assert.equal(new Set(state.commands.map((item) => item.idempotency_key)).size, 2);
    assert.ok(state.commands.some((item) => item.idempotency_key === original.command.idempotency_key && item.status === 'inspect_required'));
    assert.ok(state.attempts.some((item) => item.command_id === original.command.idempotency_key && item.result_code === 'interrupted_get_retry'));
    assert.ok(state.attempts.some((item) => item.command_id !== original.command.idempotency_key && item.result_code === 'provider_pending'));
  } finally {
    if (child) child.kill();
    if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
    if (actors) await actors.closeAfterDrain(async () => {});
    if (opened) opened.foundation.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
