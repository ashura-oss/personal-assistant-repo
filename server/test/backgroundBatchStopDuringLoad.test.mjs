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
import { createCloudApplicationRuntimeFactory, createProductionWorkspacePortsFor } from '../dist/applicationHost.node.mjs';

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
test('stop during cold controller construction holds the claimed Batch before journal admission or GET', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-batch-stop-load-'));
  mkdirSync(join(directory, 'public'), { recursive: true });
  let opened;
  let actors;
  let runtime;
  let releasePorts;
  let providerCalls = 0;
  let portsStarted = false;
  try {
    const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
      STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') }, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
    const jobId = randomUUID();
    const initial = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
      openRouterModel: OPENROUTER_BATCH_MODEL, openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
    initial.openRouterBatchLedger = { version: 1, jobs: [{ id: jobId, customId: jobId, kind: 'note_assistance', status: 'source_removed',
      sourceRemoved: true, createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date(Date.now() - 120_000).toISOString(),
      model: OPENROUTER_BATCH_MODEL, effort: 'none', requestSha256: 'd'.repeat(64), unknownCharge: true,
      requestProfileVersion: 1, batchId: 'batch-stop-load-fixture' }] };
    opened = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => initial });
    const enrolled = await opened.foundation.auth.enrollOwner('batch stop synthetic fixture password', initial);
    const { kernel, vault, startup } = opened.privateContext;
    const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, Date.now() + 60 * 60_000);
    kernel.withOwnedTransaction(actor, 0, (context) => vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0,
      'test-only-synthetic-openrouter-key'));
    startup.beginRecovery();
    recoverInterruptedBatchObservations(kernel, startup.capability);
    startup.seal();
    actors = new ProcessWorkspaceActors(kernel);
    let release;
    const portsGate = new Promise((resolve) => { release = resolve; });
    releasePorts = release;
    const makePorts = createProductionWorkspacePortsFor({ dataDirectory: config.dataDirectory }, { fetcher: async () => {
      providerCalls += 1;
      throw new Error('stop-before-dispatch fixture must not reach a provider');
    } });
    runtime = await createCloudApplicationRuntimeFactory({ workspacePortsFor: async (context, factoryVault, factoryKernel) => {
      portsStarted = true;
      await portsGate;
      return makePorts(context, factoryVault, factoryKernel);
    } })({ kernel, vault, auth: opened.foundation.auth,
      runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
      processInstanceId: opened.privateContext.processInstanceId, createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });
    await waitUntil(() => portsStarted, Boolean, 'cold controller construction did not begin');
    const claimed = await waitUntil(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT status FROM batch_observation_attempts
      WHERE job_id=? ORDER BY created_at DESC LIMIT 1`).get(jobId)), (row) => row?.status === 'claimed', 'Batch claim was not durable before cold load');
    assert.equal(claimed.status, 'claimed');
    const beforeStop = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM async_command_journal
      WHERE command_kind='assistant.batch.check'`).get().count);
    assert.equal(beforeStop, 0);
    runtime.stopAdmission();
    const drain = runtime.drainAndDispose();
    releasePorts();
    await drain;
    runtime = undefined;
    const final = kernel.withTrustedDatabaseTransaction((db) => ({
      journalCount: db.prepare(`SELECT COUNT(*) AS count FROM async_command_journal WHERE command_kind='assistant.batch.check'`).get().count,
      attempt: db.prepare(`SELECT status FROM batch_observation_attempts WHERE job_id=? ORDER BY created_at DESC LIMIT 1`).get(jobId),
    }));
    assert.equal(providerCalls, 0);
    assert.equal(final.journalCount, 0, 'shutdown after cold load must stop before command journal admission');
    assert.equal(final.attempt?.status, 'inspect_required', 'the durable claim is held for inspection, never replayed');
  } finally {
    releasePorts?.();
    if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
    if (actors) await actors.closeAfterDrain(async () => {});
    if (opened) opened.foundation.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
