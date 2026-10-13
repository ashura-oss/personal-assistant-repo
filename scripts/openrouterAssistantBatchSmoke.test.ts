import { describe, expect, it } from 'vitest';
import { ASSISTANT_BATCH_SMOKE_TEST_NAME, DEFAULT_ASSISTANT_BATCH_SMOKE_JOURNAL_PATH, isAssistantBatchSmokeOptedIn, runOpenRouterAssistantBatchSmoke, type AssistantBatchSmokeFileHandle, type AssistantBatchSmokeFileSystem } from './openrouterAssistantBatchSmoke';
import { OPENROUTER_BATCH_MODEL, OpenRouterBatchRequestBuilder } from '../src/services/openRouter';
import type { Note } from '../src/core';

const ENV = {
  STILL_OPENROUTER_ASSISTANT_BATCH_SMOKE: 'RUN_ONCE',
  STILL_OPENROUTER_ASSISTANT_BATCH_CONFIG: 'scripts/vitest.openrouter-assistant-batch.config.ts',
  STILL_OPENROUTER_ASSISTANT_BATCH_PROFILE: '2',
};
const IDS = ['ad73e82d-8b22-4f9c-a3df-800000000001', 'ad73e82d-8b22-4f9c-a3df-800000000002', 'ad73e82d-8b22-4f9c-a3df-800000000003'];
const PATHS = { key: 'C:\\private-fixture\\api-key.txt', journal: 'C:\\private-fixture\\assistant-batch.json' };
const CREATED = '2026-10-14T09:00:00.000Z';
const TIMEZONE = 'Asia/Singapore';
const BATCH_ID = 'batch-fixture_01';

class MemoryFs implements AssistantBatchSmokeFileSystem {
  files = new Map<string, Uint8Array>();
  keyReads = 0;
  async readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
    if (path === PATHS.key) this.keyReads++;
    const bytes = this.files.get(path);
    if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return encoding === 'utf8' ? new TextDecoder().decode(bytes) : new Uint8Array(bytes);
  }
  async open(path: string, flags: string): Promise<AssistantBatchSmokeFileHandle> {
    if (flags === 'wx' && this.files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    let value = new Uint8Array();
    return {
      writeFile: async (text) => { value = new TextEncoder().encode(text); },
      sync: async () => { this.files.set(path, value); },
      close: async () => { if (!this.files.has(path)) this.files.set(path, value); },
    };
  }
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    this.files.set(to, value); this.files.delete(from);
  }
  async unlink(path: string): Promise<void> { this.files.delete(path); }
  async mkdir(): Promise<void> {}
  async stat(path: string): Promise<{ size?: number; isFile(): boolean }> {
    const value = this.files.get(path);
    if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { size: value.byteLength, isFile: () => true };
  }
  setJson(path: string, value: unknown): void { this.files.set(path, new TextEncoder().encode(JSON.stringify(value))); }
  json(path = PATHS.journal): Record<string, unknown> { return JSON.parse(new TextDecoder().decode(this.files.get(path)!)) as Record<string, unknown>; }
}

function note(): Note {
  return { id: '7c62e5ad-cdb4-4a1d-994e-6fd8fdc8dc61', title: 'Chat message', transcript: 'This is a fictional local readiness message. Set the answer field to the exact string READY. Return empty proposals, decisions, citations, clarifications, and memory suggestions.', durationSeconds: 0, createdAt: CREATED, capturedAt: CREATED, captureTimeZone: TIMEZONE, origin: 'assistant_chat', status: 'recorded', revision: 1 };
}
async function preparedBody() {
  const settings = { mode: 'provider' as const, llmProvider: 'openrouter' as const, openRouterModel: OPENROUTER_BATCH_MODEL, openRouterReasoningEffort: 'low' as const, llmRequestContractVersion: 1 as const, timezone: TIMEZONE, maxContextTokens: 1000, maxRequestBytes: 64 * 1024, maxOutputTokens: 512, monthlyBudgetUsd: 0, reasoningEffort: 'low' as const, maxAttempts: 1, maxCallsPerDay: 1, maxAudioSeconds: 600, audioRetention: 'keep' as const };
  const prepared = await new OpenRouterBatchRequestBuilder().prepareAnalysis(note(), [], settings, { intent: 'answer', question: 'Respond to the current user message.', chatMode: true }, 2);
  return prepared.body;
}
function ack(): Response {
  return new Response(JSON.stringify({ object: 'batch', id: BATCH_ID, endpoint: '/v1/chat/completions', model: 'openai/gpt-6-luna', completion_window: '24h', status: 'validating', request_counts: { total: 1, completed: 0, failed: 0 } }), { status: 202 });
}
function completed(usage?: Record<string, unknown>): Response {
  const content = JSON.stringify({ summary: 'READY', answer: 'READY', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] });
  return new Response(JSON.stringify({
    object: 'batch', id: BATCH_ID, endpoint: '/v1/chat/completions', model: 'openai/gpt-6-luna', completion_window: '24h', status: 'completed', request_counts: { total: 1, completed: 1, failed: 0 },
    results: [{ custom_id: IDS[0], response: { status_code: 200, body: { model: 'openai/gpt-6-luna', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] } } }],
    ...(usage ? { usage } : {}),
  }), { status: 200 });
}
function deps(fs: MemoryFs, mode: 'submit' | 'check', fetcher: typeof fetch, uuidIndex = 0, output: string[] = []) {
  return {
    mode, fs, fetcher, output: (line: string) => output.push(line), paths: PATHS, env: ENV, testName: ASSISTANT_BATCH_SMOKE_TEST_NAME,
    now: () => new Date(CREATED), uuid: () => IDS[uuidIndex++ % IDS.length],
  };
}

describe('OpenRouter assistant Batch smoke safety', () => {
  it('requires all exact acknowledgements and the dedicated live test name', () => {
    expect(isAssistantBatchSmokeOptedIn(ENV, ASSISTANT_BATCH_SMOKE_TEST_NAME)).toBe(true);
    expect(isAssistantBatchSmokeOptedIn({ ...ENV, STILL_OPENROUTER_ASSISTANT_BATCH_PROFILE: '1' }, ASSISTANT_BATCH_SMOKE_TEST_NAME)).toBe(false);
    expect(isAssistantBatchSmokeOptedIn({ STILL_OPENROUTER_ASSISTANT_BATCH_SMOKE: 'RUN_ONCE', STILL_OPENROUTER_ASSISTANT_BATCH_PROFILE: '2' }, ASSISTANT_BATCH_SMOKE_TEST_NAME)).toBe(false);
    expect(isAssistantBatchSmokeOptedIn(ENV, 'another test')).toBe(false);
  });

  it('refuses any existing or malformed intent before reading credentials or making a request', async () => {
    const fs = new MemoryFs(); fs.files.set(PATHS.key, new TextEncoder().encode('FAKE_KEY_CANARY'));
    fs.setJson(PATHS.journal, { version: 1, status: 'submission_unknown' });
    let requests = 0;
    const result = await runOpenRouterAssistantBatchSmoke(deps(fs, 'submit', async () => { requests++; return ack(); }));
    expect(result.status).toBe('existing_intent'); expect(fs.keyReads).toBe(0); expect(requests).toBe(0);
    expect(DEFAULT_ASSISTANT_BATCH_SMOKE_JOURNAL_PATH).toMatch(/openrouter-assistant-v2-smoke\.json$/);
  });

  it('writes a durable unknown intent before the one POST and never auto-inspects or replays', async () => {
    const fs = new MemoryFs(); fs.files.set(PATHS.key, new TextEncoder().encode('FAKE_KEY_CANARY'));
    const calls: string[] = [];
    const result = await runOpenRouterAssistantBatchSmoke(deps(fs, 'submit', async (input, init) => {
      calls.push(String(input));
      const outer = JSON.parse(String(init?.body));
      expect(outer.requests).toHaveLength(1);
      const body = outer.requests[0].body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'reasoning', 'response_format', 'stream']);
      expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens');
      expect(fs.json().status).toBe('submission_unknown');
      return ack();
    }));
    expect(result.status).toBe('validating'); expect(calls).toHaveLength(1);
    const journal = fs.json();
    expect(journal.batchId).toBe(BATCH_ID); expect(journal.requestProfileVersion).toBe(2);
    expect(JSON.stringify(journal)).not.toContain('FAKE_KEY_CANARY');
    const blocked = await runOpenRouterAssistantBatchSmoke(deps(fs, 'submit', async () => { calls.push('replay'); return ack(); }));
    expect(blocked.status).toBe('existing_intent'); expect(calls).toHaveLength(1);
  });

  it('checks one confirmed batch once and validates the strict assistant result with actual zero accounting', async () => {
    const fs = new MemoryFs(); fs.files.set(PATHS.key, new TextEncoder().encode('FAKE_KEY_CANARY'));
    const body = await preparedBody();
    const { createHash } = await import('node:crypto');
    fs.setJson(PATHS.journal, { version: 1, status: 'validating', createdAt: CREATED, requestProfileVersion: 2, model: OPENROUTER_BATCH_MODEL, endpoint: '/v1/chat/completions', requestCount: 1, customId: IDS[0], requestSha256: createHash('sha256').update(body).digest('hex'), timezone: TIMEZONE, batchId: BATCH_ID });
    let gets = 0;
    const result = await runOpenRouterAssistantBatchSmoke(deps(fs, 'check', async (input) => { gets++; expect(String(input)).toContain(encodeURIComponent(BATCH_ID)); return completed({ cost: 0, prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, is_byok: true }); }));
    expect(gets).toBe(1); expect(result.status).toBe('completed'); expect(result.modelValidated).toBe(true); expect(result.strictSchemaValidated).toBe(true); expect(result.assistantResultValidated).toBe(true); expect(result.intendedReplyMatched).toBe(true);
    expect(result.usage).toEqual({ cost: 0, isByok: true, promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(fs.json().usage).toEqual(result.usage);
  });

  it('keeps missing accounting absent and rejects invalid assistant output without leaking it', async () => {
    const fs = new MemoryFs(); fs.files.set(PATHS.key, new TextEncoder().encode('FAKE_KEY_CANARY'));
    const body = await preparedBody(); const { createHash } = await import('node:crypto');
    fs.setJson(PATHS.journal, { version: 1, status: 'validating', createdAt: CREATED, requestProfileVersion: 2, model: OPENROUTER_BATCH_MODEL, endpoint: '/v1/chat/completions', requestCount: 1, customId: IDS[0], requestSha256: createHash('sha256').update(body).digest('hex'), timezone: TIMEZONE, batchId: BATCH_ID });
    const bad = JSON.parse(await completed().text()) as { results: { response: { body: { choices: { message: { content: string } }[] } } }[] };
    const answer = JSON.parse(bad.results[0].response.body.choices[0].message.content) as Record<string, unknown>;
    bad.results[0].response.body.choices[0].message.content = JSON.stringify({ ...answer, FAKE_RESPONSE_CANARY: 'not allowed' });
    const output: string[] = [];
    const result = await runOpenRouterAssistantBatchSmoke(deps(fs, 'check', async () => new Response(JSON.stringify({
      object: 'batch', id: BATCH_ID, endpoint: '/v1/chat/completions', model: 'openai/gpt-6-luna', completion_window: '24h', status: 'completed', request_counts: { total: 1, completed: 1, failed: 0 },
      results: [{ custom_id: IDS[0], response: { status_code: 200, body: { model: 'openai/gpt-6-luna', choices: [{ index: 0, message: { role: 'assistant', content: bad.results[0].response.body.choices[0].message.content }, finish_reason: 'stop' }] } } }],
    }), { status: 200 }), 0, output));
    expect(result.status).toBe('completed'); expect(result.assistantResultValidated).toBe(false); expect(result.usage).toBeUndefined();
    expect(output.join('\n')).not.toContain('FAKE_RESPONSE_CANARY'); expect(output.join('\n')).not.toContain('FAKE_KEY_CANARY');
  });

  it('separates schema validity from the intended READY reply', async () => {
    const fs = new MemoryFs(); fs.files.set(PATHS.key, new TextEncoder().encode('FAKE_KEY_CANARY'));
    const body = await preparedBody(); const { createHash } = await import('node:crypto');
    fs.setJson(PATHS.journal, { version: 1, status: 'validating', createdAt: CREATED, requestProfileVersion: 2, model: OPENROUTER_BATCH_MODEL, endpoint: '/v1/chat/completions', requestCount: 1, customId: IDS[0], requestSha256: createHash('sha256').update(body).digest('hex'), timezone: TIMEZONE, batchId: BATCH_ID });
    const fixture = JSON.parse(await completed().text()) as { results: { response: { body: { choices: { message: { content: string } }[] } } }[] };
    const answer = JSON.parse(fixture.results[0].response.body.choices[0].message.content) as Record<string, unknown>;
    answer.answer = 'A different but structurally valid answer';
    fixture.results[0].response.body.choices[0].message.content = JSON.stringify(answer);
    const result = await runOpenRouterAssistantBatchSmoke(deps(fs, 'check', async () => new Response(JSON.stringify(fixture), { status: 200 })));
    expect(result.strictSchemaValidated).toBe(true); expect(result.assistantResultValidated).toBe(true); expect(result.intendedReplyMatched).toBe(false);
  });

  it('does not validate an unexpected outer model, refusal, or mismatched result custom ID', async () => {
    const fs = new MemoryFs(); fs.files.set(PATHS.key, new TextEncoder().encode('FAKE_KEY_CANARY'));
    const body = await preparedBody(); const { createHash } = await import('node:crypto');
    fs.setJson(PATHS.journal, { version: 1, status: 'validating', createdAt: CREATED, requestProfileVersion: 2, model: OPENROUTER_BATCH_MODEL, endpoint: '/v1/chat/completions', requestCount: 1, customId: IDS[0], requestSha256: createHash('sha256').update(body).digest('hex'), timezone: TIMEZONE, batchId: BATCH_ID });
    const response = JSON.parse(await completed().text()) as Record<string, any>;
    response.model = 'unexpected-model';
    const outerInvalid = await runOpenRouterAssistantBatchSmoke(deps(fs, 'check', async () => new Response(JSON.stringify(response), { status: 200 })));
    expect(outerInvalid.modelValidated).toBe(false); expect(outerInvalid.assistantResultValidated).toBe(false);

    response.model = 'openai/gpt-6-luna';
    response.results[0].response.body.choices[0].message.refusal = 'private refusal text';
    const refusal = await runOpenRouterAssistantBatchSmoke(deps(fs, 'check', async () => new Response(JSON.stringify(response), { status: 200 })));
    expect(refusal.assistantResultValidated).toBe(false); expect(refusal.intendedReplyMatched).toBe(false);
    response.results[0].response.body.choices[0].message.refusal = undefined;
    response.results[0].custom_id = IDS[1];
    const mismatched = await runOpenRouterAssistantBatchSmoke(deps(fs, 'check', async () => new Response(JSON.stringify(response), { status: 200 })));
    expect(mismatched.status).toBe('precondition_unavailable'); expect(mismatched.assistantResultValidated).toBeUndefined();
  });

  it('retains submission_unknown without an ID after transport loss and check performs no GET', async () => {
    const fs = new MemoryFs(); fs.files.set(PATHS.key, new TextEncoder().encode('FAKE_KEY_CANARY'));
    const result = await runOpenRouterAssistantBatchSmoke(deps(fs, 'submit', async () => { throw new Error('secret response body'); }));
    expect(result.status).toBe('submission_unknown'); expect(fs.json().status).toBe('submission_unknown'); expect(fs.json().batchId).toBeUndefined();
    let calls = 0;
    const readsBeforeCheck = fs.keyReads;
    const check = await runOpenRouterAssistantBatchSmoke(deps(fs, 'check', async () => { calls++; return completed(); }));
    expect(check.status).toBe('submission_unknown'); expect(calls).toBe(0); expect(fs.keyReads).toBe(readsBeforeCheck);
  });

  it('records a provider failed result without claiming a validated assistant answer', async () => {
    const fs = new MemoryFs(); fs.files.set(PATHS.key, new TextEncoder().encode('FAKE_KEY_CANARY'));
    const body = await preparedBody(); const { createHash } = await import('node:crypto');
    fs.setJson(PATHS.journal, { version: 1, status: 'in_progress', createdAt: CREATED, requestProfileVersion: 2, model: OPENROUTER_BATCH_MODEL, endpoint: '/v1/chat/completions', requestCount: 1, customId: IDS[0], requestSha256: createHash('sha256').update(body).digest('hex'), timezone: TIMEZONE, batchId: BATCH_ID });
    const result = await runOpenRouterAssistantBatchSmoke(deps(fs, 'check', async () => new Response(JSON.stringify({
      object: 'batch', id: BATCH_ID, endpoint: '/v1/chat/completions', model: 'openai/gpt-6-luna', completion_window: '24h', status: 'failed', request_counts: { total: 1, completed: 0, failed: 1 },
    }), { status: 200 })));
    expect(result.status).toBe('failed'); expect(result.assistantResultValidated).toBe(false); expect(result.usage).toBeUndefined();
  });

  it('is not a live test unless exact opt-ins are explicitly present', async () => {
    const result = await runOpenRouterAssistantBatchSmoke({ mode: 'submit', env: {}, testName: ASSISTANT_BATCH_SMOKE_TEST_NAME, output: () => undefined, fs: new MemoryFs() });
    expect(result.status).toBe('gated');
    const invalidMode = await runOpenRouterAssistantBatchSmoke({ mode: 'invalid' as never, env: ENV, testName: ASSISTANT_BATCH_SMOKE_TEST_NAME, output: () => undefined, fs: new MemoryFs() });
    expect(invalidMode.status).toBe('gated'); expect(invalidMode.code).toBe('invalid_mode');
  });
});

if (isAssistantBatchSmokeOptedIn(process.env, ASSISTANT_BATCH_SMOKE_TEST_NAME) && ['submit', 'check'].includes(process.env.STILL_OPENROUTER_ASSISTANT_BATCH_MODE ?? '')) {
  it(ASSISTANT_BATCH_SMOKE_TEST_NAME, async () => {
    const mode = process.env.STILL_OPENROUTER_ASSISTANT_BATCH_MODE as 'submit' | 'check';
    const result = await runOpenRouterAssistantBatchSmoke({ mode, testName: ASSISTANT_BATCH_SMOKE_TEST_NAME });
    if (mode === 'submit') expect(result.status).toBe('validating');
    else {
      expect(result.status).toBe('completed');
      expect(result.modelValidated).toBe(true); expect(result.strictSchemaValidated).toBe(true);
      expect(result.assistantResultValidated).toBe(true); expect(result.intendedReplyMatched).toBe(true);
    }
  }, 150_000);
}
