import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runOpenRouterAssistantBatchSmoke } from '../scripts/openrouterAssistantBatchSmoke';

const directories: string[] = [];
const id = '10000000-0000-4000-8000-000000000001';
const batchId = 'batch_null_refusal_test';

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkRefusal(refusal: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-batch-null-refusal-'));
  directories.push(directory);
  const key = join(directory, 'fictional-key.txt');
  const journal = join(directory, 'journal.json');
  await writeFile(key, 'fictional-closed-test-key\n', { mode: 0o600 });
  const now = () => new Date('2026-10-14T00:00:00.000Z');
  const uuid = () => id;
  const env = {
    STILL_OPENROUTER_ASSISTANT_BATCH_SMOKE: 'RUN_ONCE',
    STILL_OPENROUTER_ASSISTANT_BATCH_CONFIG: 'scripts/vitest.openrouter-assistant-batch.config.ts',
    STILL_OPENROUTER_ASSISTANT_BATCH_PROFILE: '2',
  };
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({
      id: batchId, object: 'batch', status: 'validating', endpoint: '/v1/chat/completions', model: 'openai/gpt-6-luna',
      completion_window: '24h', request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 });
    const message = { role: 'assistant', content: JSON.stringify({
      summary: 'Readiness check.', answer: 'READY', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
    }), refusal };
    return new Response(JSON.stringify({
      id: batchId, object: 'batch', endpoint: '/v1/chat/completions', model: 'openai/gpt-6-luna', completion_window: '24h',
      status: 'completed', request_counts: { total: 1, completed: 1, failed: 0 }, usage: { cost: 0.0001, prompt_tokens: 10, completion_tokens: 2 },
      results: [{ custom_id: id, response: { status_code: 200, body: { model: 'openai/gpt-6-luna',
        choices: [{ index: 0, finish_reason: 'stop', message }] } }, error: null }],
    }), { status: 200 });
  };
  const deps = { mode: 'submit' as const, paths: { key, journal }, now, uuid, env, fetcher, output: () => undefined };
  const submitted = await runOpenRouterAssistantBatchSmoke(deps);
  if (submitted.status !== 'validating') throw new Error(JSON.stringify(submitted));
  return runOpenRouterAssistantBatchSmoke({ ...deps, mode: 'check' });
}

describe('closed assistant Batch smoke response validation', () => {
  it('accepts refusal: null while validating the strict structured result', async () => {
    const result = await checkRefusal(null);
    expect(result).toMatchObject({ status: 'completed', modelValidated: true, strictSchemaValidated: true,
      assistantResultValidated: true, intendedReplyMatched: true });
  });

  it.each(['', {}])('rejects a non-null refusal value: %j', async (refusal) => {
    const result = await checkRefusal(refusal);
    expect(result).toMatchObject({ status: 'completed', modelValidated: true, strictSchemaValidated: false,
      assistantResultValidated: false, intendedReplyMatched: false });
  });
});
