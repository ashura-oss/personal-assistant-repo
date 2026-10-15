import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel, SecretVault } from '../dist/index.js';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';

const analysis = { summary: 'Keep the saved update concise.', answer: 'Send the short weekly update.', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] };

test('real production factory submits and checks one authenticated OpenRouter Batch through the owned fake fetch port', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-production-batch-'));
  const calls = [];
  let customId;
  let submittedBody;
  const model = 'openai/gpt-6-luna';
  const batchId = 'batch-production-fixture-1';
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', authorization: new Headers(init.headers).get('Authorization') });
    if (url === 'https://openrouter.ai/api/v1/batches' && init.method === 'POST') {
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only-synthetic-key');
      submittedBody = JSON.parse(init.body);
      customId = submittedBody.requests[0].custom_id;
      return new Response(JSON.stringify({ id: batchId, object: 'batch', status: 'validating',
        endpoint: '/v1/chat/completions', model, completion_window: '24h', request_counts: { total: 1, completed: 0, failed: 0 } }),
        { status: 202, headers: { 'content-type': 'application/json' } });
    }
    if (url === `https://openrouter.ai/api/v1/batches/${batchId}` && init.method === 'GET') {
      assert.ok(customId);
      return new Response(JSON.stringify({ id: batchId, object: 'batch', status: 'completed', endpoint: '/v1/chat/completions',
        model, completion_window: '24h', request_counts: { total: 1, completed: 1, failed: 0 },
        results: [{ custom_id: customId, response: { status_code: 200, body: { model, choices: [{ index: 0,
          finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(analysis) } }] } } }],
        usage: { cost: 0.0021, is_byok: false, prompt_tokens: 31, completion_tokens: 17, total_tokens: 48 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected synthetic provider request');
  };
  const kernel = createDurableKernel({ databasePath: join(directory, 'private', 'workspace.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const vault = new SecretVault(kernel, randomBytes(32));
  const ownerId = randomUUID();
  const initial = createInitialWorkspaceState(randomUUID);
  initial.settings.mode = 'provider';
  initial.settings.llmProvider = 'openrouter';
  initial.settings.openRouterModel = 'openai/gpt-6-luna:batch';
  const workspace = kernel.createWorkspace(ownerId, initial);
  const actors = new ProcessWorkspaceActors(kernel);
  const runtimeSessionFor = (identity) => actors.sessionForRegistry(identity);
  const runtimeSession = runtimeSessionFor({ workspaceId: workspace.workspaceId, ownerId, privacyEpoch: 0 });
  kernel.withOwnedTransaction(runtimeSession, 0, (context) => {
    vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'test-only-synthetic-key');
  });
  const browserSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const admission = { sessionToken: browserSession, assertCurrent() { kernel.getOwnedIdentity(browserSession); } };
  const runtime = createProductionApplicationRuntimeFactory({ dataDirectory: join(directory, 'private', 'data'), canonicalOrigin: 'https://app.example.test' }, { fetcher })({ kernel, vault, runtimeSessionFor });
  try {
    const initialSnapshot = await runtime.workspaceApi.getSnapshot(admission);
    const saved = await runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: randomUUID(),
      expectedRevision: initialSnapshot.revision, expectedPrivacyEpoch: initialSnapshot.privacyEpoch,
      command: { kind: 'notes.save', transcript: 'I prefer concise weekly updates.' } });
    const submitted = await runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: randomUUID(),
      expectedRevision: saved.snapshot.revision, expectedPrivacyEpoch: saved.snapshot.privacyEpoch,
      command: { kind: 'assistant.batch.submitNote', noteId: saved.receipt.objectId, intent: 'assist' } });
    assert.equal(submitted.status, 'finished');
    assert.equal(submitted.receipt.kind, 'assistant.batch.submitNote');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(submittedBody.requests[0].custom_id, submitted.receipt.jobId);

    const checked = await runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: randomUUID(),
      expectedRevision: submitted.snapshot.revision, expectedPrivacyEpoch: submitted.snapshot.privacyEpoch,
      command: { kind: 'assistant.batch.check', jobId: submitted.receipt.jobId } });
    assert.equal(checked.status, 'finished');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, 'GET');
    assert.deepEqual(calls.map((call) => call.url), [
      'https://openrouter.ai/api/v1/batches', `https://openrouter.ai/api/v1/batches/${batchId}`,
    ]);
    const job = checked.snapshot.state.assistantBatchJobs.find((row) => row.id === submitted.receipt.jobId);
    assert.equal(job.status, 'completed');
    assert.equal(checked.snapshot.state.notes.find((row) => row.id === saved.receipt.objectId).analysis.answer, analysis.answer);
    assert.equal(job.providerReportedCostUsd, 0.0021);
    assert.equal(job.unknownCharge, false);
  } finally {
    try { await runtime.drainAndDispose(); } finally {
      try { await actors.closeAfterDrain(async () => {}); } finally { vault.close(); kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  }
});
