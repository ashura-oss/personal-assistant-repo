import { describe, expect, it, vi } from 'vitest';
import * as Crypto from 'expo-crypto';
import { AppControllerImpl } from '../src/services/controller';
import { OpenRouterBatchClient, OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_CHAT_COMPLETIONS_PATH, type OpenRouterBatchInspection } from '../src/services/openRouter';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';

class MemoryStore implements StateStore {
  value?: AppState;
  saves = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.saves += 1; this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

function client() {
  return new OpenRouterBatchClient({
    withRequestOwnership: async (actual) => actual(),
    fetcher: async () => new Response(JSON.stringify({
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'validating',
      request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 }),
    readCredentialSnapshot: async () => ({ key: 'fixture-only', generation: 1 }),
    assertCredentialGeneration: () => undefined,
    assertBeforeStart: () => undefined,
  });
}

function acceptedBatch(id: string) {
  return new Response(JSON.stringify({ id, object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'validating',
    request_counts: { total: 1, completed: 0, failed: 0 } }), { status: 202 });
}

async function fakeSubmit(
  batchId: string,
  _input: { operationId: string; requestBody: string },
  onBeforeDispatch: () => Promise<void>,
  assertBeforeStart: () => void,
) {
  await onBeforeDispatch();
  assertBeforeStart();
  return { batchId, status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
}

function completedInspection(customId: string, content = JSON.stringify({
  summary: 'A concise summary.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
})): OpenRouterBatchInspection {
  return {
    batchId: 'batch_completed_fixture', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0,
    metadataValidation: 'valid', resultValidation: 'valid',
    usage: { cost: 0.001, promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    result: { customId, statusCode: 200, finishReason: 'stop', responseBody: {
      model: OPENROUTER_BATCH_BODY_MODEL,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    } },
  };
}

describe('OpenRouter Batch controller lifecycle', () => {
  it('saves a one-time job before POST, then strips removed note/request text in the same deletion save', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client() });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven CANARY_PRIVATE_TRANSCRIPT' });

    const queued = await app.submitNoteBatch(note.id, { intent: 'answer', question: 'CANARY_PRIVATE_QUESTION' });
    expect(queued).toMatchObject({ status: 'queued', kind: 'note_assistance', noteId: note.id });
    expect(queued.id).toMatch(/^[0-9a-f-]{36}$/);
    const beforeDelete = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(beforeDelete.openRouterBatchLedger.jobs[0]).toMatchObject({ customId: queued.id, batchId: 'batch_fixture_1' });
    expect(String(beforeDelete.openRouterBatchLedger.jobs[0]?.requestBody)).toContain('CANARY_PRIVATE_QUESTION');

    await app.deleteNote(note.id);
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.notes.some((row) => row.id === note.id)).toBe(false);
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ id: queued.id, customId: queued.id, batchId: 'batch_fixture_1', sourceRemoved: true, status: 'source_removed' });
    expect(saved.openRouterBatchLedger.jobs[0]).not.toHaveProperty('requestBody');
    expect(saved.openRouterBatchLedger.jobs[0]).not.toHaveProperty('question');
    expect(JSON.stringify(saved)).not.toContain('CANARY_PRIVATE_TRANSCRIPT');
    expect(JSON.stringify(saved)).not.toContain('CANARY_PRIVATE_QUESTION');
    expect(app.getSnapshot().assistantBatchJobs?.[0]).toMatchObject({ status: 'source_removed', sourceRemoved: true });
  });

  it('does not allow source deletion while a submitted provider operation still owns its request', async () => {
    let finishResponse!: (response: Response) => void;
    const requestResponse = new Promise<Response>((resolve) => { finishResponse = resolve; });
    const pendingClient = new OpenRouterBatchClient({
      withRequestOwnership: async (actual) => actual(),
      fetcher: async () => requestResponse,
      readCredentialSnapshot: async () => ({ key: 'fixture-only', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: pendingClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven ACTIVE_PRIVATE_SOURCE' });
    const queued = app.submitNoteBatch(note.id);
    await expect(app.deleteNote(note.id)).rejects.toThrow(/still using this note/i);
    finishResponse(new Response(JSON.stringify({
      id: 'batch_fixture_2', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'validating',
      request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 }));
    await queued;
    await app.deleteNote(note.id);
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'source_removed', sourceRemoved: true });
    expect(JSON.stringify(saved)).not.toContain('ACTIVE_PRIVATE_SOURCE');
  });

  it('keeps a pre-dispatch failure terminal and does not block a later explicit attempt', async () => {
    const fetcher = vi.fn(async () => new Response('unused', { status: 500 }));
    const noKey = new OpenRouterBatchClient({
      withRequestOwnership: async (actual) => actual(),
      fetcher: fetcher as unknown as typeof fetch,
      readCredentialSnapshot: async () => ({ key: null, generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: noKey });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven safe preflight' });

    await expect(app.submitNoteBatch(note.id)).rejects.toThrow(/configure an OpenRouter API key/i);
    const afterFailure = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(afterFailure.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'failed', failureCode: 'not_submitted', unknownCharge: false });
    expect(afterFailure.openRouterBatchLedger.jobs[0]).not.toHaveProperty('batchId');
    await expect(app.submitNoteBatch(note.id)).rejects.toThrow(/configure an OpenRouter API key/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: unknown[] } })).openRouterBatchLedger.jobs).toHaveLength(2);
  });

  it('does not replay a one-POST submission after an ambiguous acknowledgement and reload', async () => {
    const firstFetch = vi.fn(async () => new Response('ambiguous acknowledgement', { status: 202 }));
    const lostAckClient = new OpenRouterBatchClient({
      withRequestOwnership: async (actual) => actual(),
      fetcher: firstFetch as unknown as typeof fetch,
      readCredentialSnapshot: async () => ({ key: 'fictional-key', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: lostAckClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven ambiguous acknowledgement' });
    await expect(app.submitNoteBatch(note.id)).rejects.toThrow(/outcome is unknown/i);
    expect(firstFetch).toHaveBeenCalledOnce();
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } })).openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'submission_unknown', unknownCharge: true });

    const replayFetch = vi.fn(async () => acceptedBatch('must_not_be_replayed'));
    const replayClient = new OpenRouterBatchClient({
      withRequestOwnership: async (actual) => actual(),
      fetcher: replayFetch as unknown as typeof fetch,
      readCredentialSnapshot: async () => ({ key: 'fictional-key', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const restarted = new AppControllerImpl(store, {}, { openRouterBatchClient: replayClient });
    await restarted.load();
    await expect(restarted.submitNoteBatch(note.id)).rejects.toThrow(/unfinished Batch job/i);
    expect(replayFetch).not.toHaveBeenCalled();
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: unknown[] } })).openRouterBatchLedger.jobs).toHaveLength(1);
  });

  it('shows the provider in-progress state as processing', async () => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_in_progress', input, before, assert),
      inspect: async () => ({ batchId: 'batch_in_progress', status: 'in_progress', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
        model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0,
        metadataValidation: 'valid', resultValidation: 'unavailable' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven provider still working' });
    const job = await app.submitNoteBatch(note.id);
    expect((await app.refreshAssistantBatch(job.id)).status).toBe('processing');
  });

  it('applies one valid completed result and makes repeated checks idempotent', async () => {
    let inspectCalls = 0;
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_completed_fixture', input, before, assert),
      inspect: async (_batchId: string, customId: string) => { inspectCalls += 1; return completedInspection(customId); },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven apply this completed result' });
    const job = await app.submitNoteBatch(note.id);

    const first = await app.refreshAssistantBatch(job.id);
    const firstSaved = structuredClone(store.value!) as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
    const appliedNote = firstSaved.notes.find((row) => row.id === note.id)!;
    expect(first).toMatchObject({ status: 'completed', providerReportedCostUsd: 0.001, promptTokens: 12, completionTokens: 5 });
    expect(appliedNote.analysis?.summary).toBe('A concise summary.');
    expect(firstSaved.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'completed', appliedNoteRevision: appliedNote.revision, accounting: { providerReportedCostUsd: 0.001 } });

    const second = await app.refreshAssistantBatch(job.id);
    expect(second).toEqual(first);
    expect(inspectCalls).toBe(1);
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: unknown[] } })).openRouterBatchLedger.jobs).toHaveLength(1);
  });

  it('does not settle or apply a completed result after the workspace changes during source hashing', async () => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_hash_race', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...completedInspection(customId), batchId: 'batch_hash_race' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven deferred source hash' });
    const job = await app.submitNoteBatch(note.id);

    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    let releaseDigest!: () => void;
    let reachedDigest!: () => void;
    const digestStarted = new Promise<void>((resolve) => { reachedDigest = resolve; });
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    let firstDigest = true;
    const spy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (...args) => {
      if (firstDigest) {
        firstDigest = false;
        reachedDigest();
        await digestGate;
      }
      return originalDigest(...args);
    });
    try {
      const settling = app.refreshAssistantBatch(job.id);
      await digestStarted;
      await app.saveSettings({ openRouterReasoningEffort: 'none' });
      releaseDigest();
      await expect(settling).rejects.toThrow(/earlier workspace session|changed during inspection/i);
    } finally {
      releaseDigest();
      spy.mockRestore();
    }
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect((store.value as AppState & { openRouterBatchLedger: { jobs: { status: string }[] } }).openRouterBatchLedger.jobs[0]?.status).toBe('queued');
  });

  it('does not enter result application when the workspace changes during the exact source-version digest', async () => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_source_hash_race', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...completedInspection(customId), batchId: 'batch_source_hash_race' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven source version digest race' });
    const job = await app.submitNoteBatch(note.id);
    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    let changedDuringSourceDigest = false;
    const spy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (algorithm, value, options) => {
      if (!changedDuringSourceDigest && typeof value === 'string' && value.includes('"transcript"')) {
        changedDuringSourceDigest = true;
        await app.saveSettings({ openRouterReasoningEffort: 'none' });
      }
      return originalDigest(algorithm, value, options);
    });
    try {
      await expect(app.refreshAssistantBatch(job.id)).rejects.toThrow(/earlier workspace session|changed during inspection/i);
    } finally {
      spy.mockRestore();
    }
    expect(changedDuringSourceDigest).toBe(true);
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect((store.value as AppState & { openRouterBatchLedger: { jobs: { status: string }[] } }).openRouterBatchLedger.jobs[0]?.status).toBe('queued');
  });

  it('retains actual usage when structured output is invalid and never applies it', async () => {
    let inspectCalls = 0;
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_invalid_fixture', input, before, assert),
      inspect: async (_batchId: string, customId: string) => { inspectCalls += 1; return { ...completedInspection(customId, '{"unexpected":"shape"}'), batchId: 'batch_invalid_fixture' }; },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven invalid structured response' });
    const job = await app.submitNoteBatch(note.id);

    const result = await app.refreshAssistantBatch(job.id);
    expect(result).toMatchObject({ status: 'result_invalid', providerReportedCostUsd: 0.001, costStatus: 'reported' });
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect(inspectCalls).toBe(1);
    expect((await app.refreshAssistantBatch(job.id))).toEqual(result);
    expect(inspectCalls).toBe(1);
  });

  it('allows a later explicit usage check for a terminal invalid result without applying it', async () => {
    let inspectCalls = 0;
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_delayed_usage', input, before, assert),
      inspect: async (_batchId: string, customId: string) => {
        inspectCalls += 1;
        const inspection = completedInspection(customId, '{"not":"assistant output"}');
        return { ...inspection, batchId: 'batch_delayed_usage', usage: inspectCalls === 1 ? undefined : { cost: 0.003 } };
      },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven delayed accounting' });
    const job = await app.submitNoteBatch(note.id);

    const invalid = await app.refreshAssistantBatch(job.id);
    expect(invalid).toMatchObject({ status: 'result_invalid', costStatus: 'unavailable', canCheck: true });
    const accounting = await app.refreshAssistantBatch(job.id);
    expect(accounting).toMatchObject({ status: 'result_invalid', providerReportedCostUsd: 0.003, costStatus: 'reported', canCheck: false });
    expect(inspectCalls).toBe(2);
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } })).openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'result_invalid', accounting: { providerReportedCostUsd: 0.003 } });
  });

  it.each([
    ['unrelated Azure setting', { openAiEndpoint: 'https://other.openai.azure.com' }, 'completed'],
    ['OpenRouter request profile', { openRouterReasoningEffort: 'none' as const }, 'result_stale'],
  ] as const)('uses only the captured OpenRouter profile when settling after %s changes', async (_label, settingsPatch, expectedStatus) => {
    const usage = { cost: 0.002, prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 };
    const responseBody = {
      model: OPENROUTER_BATCH_BODY_MODEL,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        summary: 'A concise summary.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      }) } }],
    };
    const inspection: OpenRouterBatchInspection = {
      batchId: 'batch_inspection_1', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0,
      metadataValidation: 'valid', resultValidation: 'valid', usage,
      result: { customId: '', statusCode: 200, finishReason: 'stop', responseBody },
    };
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_inspection_1', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...inspection, result: { ...inspection.result!, customId } }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven captured note' });
    const job = await app.submitNoteBatch(note.id);
    await app.saveSettings(settingsPatch);

    const settled = await app.refreshAssistantBatch(job.id);
    expect(settled.status).toBe(expectedStatus);
    expect(settled.providerReportedCostUsd).toBe(usage.cost);
    if (expectedStatus === 'completed') {
      const refreshed = await app.refreshAnalysisStatus(note.id);
      expect(refreshed?.stale).not.toBe(true);
    }
  });

  it('does not delete source content when the private Batch ledger is malformed', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'preserve this source when its job receipt is corrupt' });
    const corrupted = structuredClone(store.value!) as AppState & { openRouterBatchLedger: unknown };
    corrupted.openRouterBatchLedger = { version: 1, jobs: [{ requestBody: 'PRIVATE_BATCH_CANARY' }] };
    store.value = corrupted;
    const restarted = new AppControllerImpl(store);
    await restarted.load();

    await expect(restarted.deleteNote(note.id)).rejects.toThrow(/batch history is invalid/i);
    expect(store.value?.notes.some((candidate) => candidate.id === note.id)).toBe(true);
    expect(JSON.stringify(store.value)).toContain('PRIVATE_BATCH_CANARY');
  });

  it('atomically removes captured knowledge narrative text when that narrative is replaced', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client() });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: 'PRIVATE_KNOWLEDGE_NARRATIVE' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven context selection' });
    const queued = await app.submitNoteBatch(note.id, { knowledgeSelection: [{ kind: 'person', id: person.id }] });
    const savedPerson = app.getSnapshot().knowledge.people.find((row) => row.id === person.id)!;
    const narrative = app.getSnapshot().documents.find((row) => row.path === person.narrativePath)!;

    await app.savePerson({ id: person.id, expectedRevision: savedPerson.revision, expectedDocumentRevision: narrative.revision,
      name: 'Maya', aliases: [], narrative: 'Updated local narrative.' });
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ id: queued.id, status: 'source_removed', requestProfileVersion: 1 });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_KNOWLEDGE_NARRATIVE');
  });

  it('atomically tombstones a job whose captured document is replaced', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client() });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const document = await app.saveDocument('research/visit.md', 'Project Phoenix uses PRIVATE_DOCUMENT_CANARY for visit coordination.');
    const note = await app.saveNote({ transcript: 'Discuss Project Phoenix visit coordination with the team.' });
    const queued = await app.submitNoteBatch(note.id, { intent: 'answer', question: 'What identifier does Project Phoenix use for visit coordination?' });
    const storedBefore = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    const versions = storedBefore.openRouterBatchLedger.jobs[0]?.sourceVersions as Record<string, string> | undefined;
    expect(versions?.['doc:research/visit.md']).toBeDefined();

    await app.saveDocument(document.path, 'Project Phoenix identifier was removed.', { expectedRevision: document.revision });
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ id: queued.id, status: 'source_removed', requestProfileVersion: 1 });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_DOCUMENT_CANARY');
  });

  it('tombstones captured knowledge content when a reviewed suggestion changes the entity', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client() });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Alex', aliases: [], narrative: 'PRIVATE_KNOWLEDGE_BEFORE_REVIEW' });
    const note = await app.saveNote({ transcript: 'I prefer concise project updates.' });
    const job = await app.submitNoteBatch(note.id, { knowledgeSelection: [{ kind: 'person', id: person.id }] });
    const suggestion = await app.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript',
      quote: 'I prefer concise project updates.', targetKind: 'person', targetId: person.id,
      change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Prefers concise updates.' } });

    await app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision: person.revision });
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ id: job.id, status: 'source_removed', requestProfileVersion: 1 });
    expect(saved.openRouterBatchLedger.jobs[0]).not.toHaveProperty('requestBody');
    expect(JSON.stringify(saved.openRouterBatchLedger)).not.toContain('PRIVATE_KNOWLEDGE_BEFORE_REVIEW');
  });

  it('lets a removed-source receipt read metadata once without retaining result content', async () => {
    let inspectCalls = 0;
    let finishInspection!: (inspection: OpenRouterBatchInspection) => void;
    const inspection: OpenRouterBatchInspection = {
      batchId: 'batch_metadata_only', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0,
      metadataValidation: 'valid', resultValidation: 'valid', usage: { cost: 0.0005 },
      result: { customId: '', statusCode: 200, finishReason: 'stop', responseBody: { privateResultCanary: 'PRIVATE_RESULT_BODY' } },
    };
    const metadataOnlyClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_metadata_only', input, before, assert),
      inspect: async (_batchId: string, customId: string) => { inspectCalls += 1; return new Promise<OpenRouterBatchInspection>((resolve) => { finishInspection = (value) => resolve({ ...value, result: { ...value.result!, customId } }); }); },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: metadataOnlyClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven temporary source' });
    const queued = await app.submitNoteBatch(note.id);
    await app.deleteNote(note.id);

    const pending = app.refreshAssistantBatch(queued.id);
    await vi.waitFor(() => expect(inspectCalls).toBe(1));
    await expect(app.refreshAssistantBatch(queued.id)).rejects.toThrow(/already settling/i);
    finishInspection(inspection);
    const result = await pending;
    expect(inspectCalls).toBe(1);
    expect(result).toMatchObject({ status: 'source_removed', providerReportedCostUsd: 0.0005, canCheck: false });
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'source_removed', accounting: { providerReportedCostUsd: 0.0005 } });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_RESULT_BODY');
    expect(saved.openRouterBatchLedger.jobs[0]).not.toHaveProperty('requestBody');
  });
});
