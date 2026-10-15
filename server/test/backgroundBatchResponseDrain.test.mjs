import assert from 'node:assert/strict';
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
test('runtime drain retains an owned Batch response until its body cleanup completes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-batch-response-drain-'));
  mkdirSync(join(directory, 'public'), { recursive: true });
  let opened;
  let actors;
  let runtime;
  let releaseCleanup;
  let cleanupStarted = false;
  let providerGets = 0;
  let drainFinished = false;
  try {
    const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
      STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') }, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
    const jobId = randomUUID();
    const batchId = 'batch-response-drain-fixture';
    const initial = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
      openRouterModel: OPENROUTER_BATCH_MODEL, openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
    initial.openRouterBatchLedger = { version: 1, jobs: [{ id: jobId, customId: jobId, kind: 'note_assistance', status: 'source_removed',
      sourceRemoved: true, createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date(Date.now() - 120_000).toISOString(),
      model: OPENROUTER_BATCH_MODEL, effort: 'none', requestSha256: 'e'.repeat(64), unknownCharge: true,
      requestProfileVersion: 1, batchId }] };
    opened = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => initial });
    const enrolled = await opened.foundation.auth.enrollOwner('batch response synthetic fixture password', initial);
    const { kernel, vault, startup } = opened.privateContext;
    const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, Date.now() + 60 * 60_000);
    kernel.withOwnedTransaction(actor, 0, (context) => vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0,
      'test-only-synthetic-openrouter-key'));
    startup.beginRecovery();
    recoverInterruptedBatchObservations(kernel, startup.capability);
    startup.seal();
    actors = new ProcessWorkspaceActors(kernel);
    let release;
    const cleanupGate = new Promise((resolve) => { release = resolve; });
    releaseCleanup = release;
    runtime = await createProductionApplicationRuntimeFactory(config, { fetcher: async (input, init = {}) => {
      providerGets += 1;
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(String(input), `https://openrouter.ai/api/v1/batches/${batchId}`);
      const body = new ReadableStream({ cancel() {
        cleanupStarted = true;
        return cleanupGate;
      } });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'retry-after': '7200' } });
    } })({ kernel, vault, auth: opened.foundation.auth,
      runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
      processInstanceId: opened.privateContext.processInstanceId, createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });
    await waitUntil(() => providerGets, (count) => count === 1, 'the held Batch response did not start');
    runtime.stopAdmission();
    const drain = runtime.drainAndDispose().then(() => { drainFinished = true; });
    await waitUntil(() => cleanupStarted, Boolean, 'response cleanup did not become owned during shutdown');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(drainFinished, false, 'drain must retain request and workspace ownership until response cancellation is acknowledged');
    releaseCleanup();
    await drain;
    runtime = undefined;
    assert.equal(providerGets, 1);
    const final = kernel.withTrustedDatabaseTransaction((db) => ({
      journal: db.prepare(`SELECT status FROM async_command_journal WHERE command_kind='assistant.batch.check'`).get(),
      attempt: db.prepare(`SELECT status,result_code FROM batch_observation_attempts WHERE job_id=?`).get(jobId),
    }));
    assert.equal(final.journal?.status, 'inspect_required');
    assert.equal(final.attempt?.status, 'inspect_required');
    assert.equal(final.attempt?.result_code, 'batch_observation_failed', 'an interrupted GET body remains held for a later safe inspection');
  } finally {
    releaseCleanup?.();
    if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
    if (actors) await actors.closeAfterDrain(async () => {});
    if (opened) opened.foundation.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
