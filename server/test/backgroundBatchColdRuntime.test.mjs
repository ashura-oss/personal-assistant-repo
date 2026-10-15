import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
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
test('production runtime observes a cold known Batch without browser sessions or any Batch POST', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-batch-observation-'));
  mkdirSync(join(directory, 'public'), { recursive: true });
  let opened;
  let actors;
  let runtime;
  const batchId = 'batch-observation-cold-fixture';
  const jobId = randomUUID();
  const providerCalls = [];
  let readCount = 0;
  let pendingResponseAt;
  try {
    const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
      STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') }, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
    const initial = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
      openRouterModel: OPENROUTER_BATCH_MODEL, openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
    initial.openRouterBatchLedger = { version: 1, jobs: [{ id: jobId, customId: jobId, kind: 'note_assistance', status: 'source_removed',
      sourceRemoved: true, createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date(Date.now() - 120_000).toISOString(),
      model: OPENROUTER_BATCH_MODEL, effort: 'none', requestSha256: 'a'.repeat(64), unknownCharge: true,
      requestProfileVersion: 1, batchId }] };
    opened = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => initial });
    const enrolled = await opened.foundation.auth.enrollOwner('batch observation synthetic fixture password', initial);
    const { kernel, vault } = opened.privateContext;
    const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, Date.now() + 60 * 60_000);
    kernel.withOwnedTransaction(actor, 0, (context) => vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0,
      'test-only-synthetic-openrouter-key'));
    opened.privateContext.startup.beginRecovery();
    opened.privateContext.startup.seal();
    actors = new ProcessWorkspaceActors(kernel);
    const runtimeSessionFor = (identity) => actors.sessionForRegistry(identity);
    const factory = createProductionApplicationRuntimeFactory(config, { fetcher: async (input, init = {}) => {
      const url = String(input);
      providerCalls.push({ method: init.method ?? 'GET', url });
      assert.equal(init.method ?? 'GET', 'GET', 'automatic observation must never submit a Batch');
      assert.equal(url, `https://openrouter.ai/api/v1/batches/${batchId}`);
      readCount += 1;
      if (readCount === 1) return new Response(JSON.stringify({ error: { message: 'rate limited' } }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
      pendingResponseAt = Date.now();
      return new Response(JSON.stringify({ id: batchId, object: 'batch', status: 'in_progress', endpoint: '/v1/chat/completions',
        model: OPENROUTER_BATCH_MODEL, completion_window: '24h', request_counts: { total: 1, completed: 0, failed: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json', 'retry-after': '7200' } });
    } });
    runtime = factory({ kernel, vault, auth: opened.foundation.auth, runtimeSessionFor,
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit), processInstanceId: opened.privateContext.processInstanceId });
    const readJournal = () => kernel.withTrustedDatabaseTransaction((db) => {
      const entries = db.prepare(`SELECT workspace_id,owner_id,privacy_epoch,command_kind,status,idempotency_key FROM async_command_journal
        WHERE command_kind='assistant.batch.check' ORDER BY created_at,idempotency_key`).all();
      const indexExists = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='batch_observation_attempts'").get();
      return indexExists ? { entries, attempts: db.prepare('SELECT status,result_code,next_due_at,command_id FROM batch_observation_attempts WHERE job_id=? ORDER BY created_at').all(jobId),
        job: db.prepare('SELECT state,next_due_at FROM batch_observation_jobs WHERE job_id=?').get(jobId) } : { entries, attempts: [], job: null };
    });
    const diagnostic = await waitUntil(readJournal, (state) => {
      if (state.entries.length < 2 || state.entries.at(-1)?.status !== 'finished' || pendingResponseAt === undefined) return false;
      const finalCommandId = state.entries.at(-1).idempotency_key;
      const finalAttempt = state.attempts.find((attempt) => attempt.command_id === finalCommandId);
      return finalAttempt?.status === 'deferred' && finalAttempt.result_code === 'provider_pending' &&
        finalAttempt.next_due_at >= pendingResponseAt + 7_200_000 && state.job?.state === 'due' &&
        state.job.next_due_at >= pendingResponseAt + 7_200_000;
    },
      'scheduler did not retry transient Batch GET as a new exact command');
    const entries = diagnostic.entries;
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.command_kind === 'assistant.batch.check' && entry.privacy_epoch === 0));
    assert.equal(entries[0].status, 'inspect_required', 'the failed original command is never replayed');
    assert.equal(entries[1].status, 'finished');
    assert.notEqual(entries[0].idempotency_key, entries[1].idempotency_key);
    assert.equal(providerCalls.length, 2);
    assert.ok(providerCalls.every((call) => call.method === 'GET'));
    const attempts = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT status,result_code,command_id FROM batch_observation_attempts
      WHERE job_id=? ORDER BY created_at`).all(jobId));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].status, 'deferred');
    assert.equal(attempts[0].command_id, entries[0].idempotency_key);
    assert.equal(attempts[1].command_id, entries[1].idempotency_key);
    assert.ok(attempts.every((attempt) => /^[0-9a-f-]{36}$/.test(attempt.command_id) && attempt.status === 'deferred'));
    assert.equal(attempts[0].result_code, 'provider_get_retry');
    assert.equal(attempts[1].result_code, 'provider_pending');
    const persistedPending = diagnostic.attempts.find((attempt) => attempt.command_id === entries[1].idempotency_key);
    assert.ok(persistedPending && persistedPending.next_due_at >= pendingResponseAt + 7_200_000,
      `successful in-progress GET must persist provider Retry-After: due=${persistedPending?.next_due_at}, response=${pendingResponseAt}`);
  } finally {
    if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
    if (actors) await actors.closeAfterDrain(async () => {});
    if (opened) opened.foundation.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
