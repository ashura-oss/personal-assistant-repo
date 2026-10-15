import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppControllerImpl } from '../src/services/controller';
import { OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_CHAT_COMPLETIONS_PATH, OpenRouterBatchDispatchError, type OpenRouterBatchInspection } from '../src/services/openRouter';
import { buildOpenRouterPeriodSummaryRequest, createOpenRouterPeriodSummaryBinding } from '../src/services/openRouterPeriodSummary';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';
import { tombstoneOpenRouterBatchJob, validateOpenRouterBatchLedger } from '../src/services/openRouterBatchJobs';

const digest = async (value: string): Promise<string> => createHash('sha256').update(value, 'utf8').digest('hex');

class MemoryStore implements StateStore {
  value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
  async readCurrentSnapshot() { return this.value ? { raw: JSON.stringify(this.value), schemaVersion: 1 } : undefined; }
  async assertCurrent() {}
}

async function makeBinding() {
  const content = 'A completed event in the selected period.';
  return createOpenRouterPeriodSummaryBinding({ version: 1, requestProfileVersion: 6, operation: 'period_summary',
    policyId: '11111111-1111-4111-8111-111111111111', policyRevision: 1, policyDigest: 'a'.repeat(64),
    occurrenceId: randomUUID(), period: 'daily', timeZone: 'UTC', localInterval: { start: '2026-07-01', end: '2026-07-02' },
    startUtc: '2026-07-01T00:00:00.000Z', endUtc: '2026-07-02T00:00:00.000Z', preparedAt: '2026-07-02T01:00:00.000Z',
    sources: [{ id: 'event-1', role: 'event', kind: 'note', revision: 1, content, contentSha256: await digest(content),
      effectiveAt: '2026-07-01T10:00:00.000Z', observedAt: '2026-07-01T11:00:00.000Z' }],
    destination: { kind: 'absent', documentId: null, path: 'memory/summaries/daily/2026-07-01.md', expectedRevision: null, expectedAbsenceGeneration: 0 },
    instructions: 'Summarize the period and cite supplied source IDs.', effort: 'low' }, digest);
}

async function fixture(result: OpenRouterBatchInspection, beforeStart?: (store: MemoryStore) => void, authorityCheck: () => void = () => undefined, skipSubmit = false) {
  const store = new MemoryStore();
  let submitted: unknown;
  let posts = 0;
  let currentInspection = result;
  const fakeClient = {
    async submit(input: unknown, before: () => Promise<void>, assert: () => void) {
      submitted = structuredClone(input);
      await before();
      try { assert(); } catch (error) {
        throw new OpenRouterBatchDispatchError('pre_dispatch', error instanceof Error ? error.message : 'authority_rejected');
      }
      beforeStart?.(store);
      posts += 1;
      return { batchId: 'summary_batch_fixture', status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
        model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
    },
    async inspect(batchId: string, customId: string) { return { ...currentInspection, batchId, result: currentInspection.result && { ...currentInspection.result, customId } }; },
  };
  const integration: Record<string, unknown> = { openRouterBatchClient: fakeClient as never };
  const app = new AppControllerImpl(store, {}, integration as never);
  await app.load();
  const binding = await makeBinding();
  const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
  const operationId = randomUUID();
  const dto = skipSubmit ? undefined : await (app as unknown as { submitPreparedPeriodSummary(input: unknown): Promise<{ id: string; status: string }> })
    .submitPreparedPeriodSummary({ submission: { operationId, requestProfileVersion: 6, operation: 'period_summary', requestBody: prepared.body,
      requestSha256: await digest(prepared.body), summaryBinding: prepared.binding }, assertCurrentAuthorityBeforePost: authorityCheck });
  return { app, store, dto, submitted, binding, operationId, integration, setInspection(value: OpenRouterBatchInspection) { currentInspection = value; }, get posts() { return posts; } };
}

function inspection(content: string, validation: 'valid' | 'truncated' = 'valid', includeAccounting = true): OpenRouterBatchInspection {
  return { batchId: 'summary_batch_fixture', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0,
    metadataValidation: 'valid', resultValidation: validation,
    ...(includeAccounting ? { usage: { cost: 0.001, promptTokens: 40, completionTokens: 8, totalTokens: 48 } } : {}),
    result: { customId: 'placeholder', statusCode: 200, finishReason: validation === 'valid' ? 'stop' : 'length', responseBody: {
      model: OPENROUTER_BATCH_BODY_MODEL, choices: [{ index: 0, finish_reason: validation === 'valid' ? 'stop' : 'length',
        message: { role: 'assistant', content } }],
    } } };
}

describe('period summary controller lifecycle', () => {
  it('submits only the frozen profile-6 wire, then retains strict Markdown without note or proposal mutation', async () => {
    const raw = JSON.stringify({ markdown: '# Daily summary\nOne completed item.', sourceReferences: ['event-1'] });
    let assertionSawSubmitting = false;
    const f = await fixture(inspection(raw), (store) => {
      assertionSawSubmitting = (store.value as AppState & { openRouterBatchLedger: { jobs: { status: string }[] } })
        .openRouterBatchLedger.jobs.some((job) => job.status === 'submitting');
    });
    expect(assertionSawSubmitting).toBe(true);
    expect(f.submitted).toMatchObject({ operationId: f.operationId, requestProfileVersion: 6, operation: 'period_summary',
      requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/), summaryBinding: { occurrenceId: f.binding.occurrenceId } });
    expect(f.dto!).toMatchObject({ kind: 'period_summary', status: 'queued' });
    const before = structuredClone(f.store.value!);
    const observed = await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    expect(observed.job).toMatchObject({ kind: 'period_summary', status: 'completed', periodSummary: { period: 'daily' } });
    expect(observed.job).not.toHaveProperty('resultText');
    const ledger = (f.store.value as AppState & { openRouterBatchLedger: { jobs: { resultText?: string; resultSha256?: string; kind: string; status: string }[] } })
      .openRouterBatchLedger.jobs[0]!;
    expect(ledger).toMatchObject({ kind: 'period_summary', status: 'completed', resultText: raw, resultSha256: await digest(raw) });
    expect((f.store.value as AppState).notes).toEqual(before.notes);
    expect((f.store.value as AppState).proposals).toEqual(before.proposals);
  });

  it('retains bounded cutoff bytes under distinct fields and never projects them as a completed result', async () => {
    const partial = '{"markdown":"unfinished';
    const f = await fixture(inspection(partial, 'truncated'));
    const observed = await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    expect(observed.job).toMatchObject({ kind: 'period_summary', status: 'result_truncated', canRecoverMoreCompute: true,
      failureCode: 'result_truncated', providerReportedCostUsd: 0.001 });
    expect(observed.job).not.toHaveProperty('resultText');
    const stored = (f.store.value as AppState & { openRouterBatchLedger: { jobs: { status: string; resultText?: string; truncatedResultText?: string; truncatedResultSha256?: string }[] } })
      .openRouterBatchLedger.jobs[0]!;
    expect(stored).toMatchObject({ status: 'result_truncated', truncatedResultText: partial, truncatedResultSha256: await digest(partial) });
    expect(stored).not.toHaveProperty('resultText');
  });

  it('falls back to a content-free billing receipt when a completed summary exceeds workspace capacity', async () => {
    const raw = JSON.stringify({ markdown: 'x'.repeat(16 * 1024 * 1024 - 512), sourceReferences: ['event-1'] });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
    const f = await fixture(inspection(raw));
    const observed = await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    expect(observed.job).toMatchObject({ status: 'result_not_retained', failureCode: 'result_not_retained', providerReportedCostUsd: 0.001 });
    expect(observed.job).not.toHaveProperty('resultText');
    const receipt = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, any>[] } }).openRouterBatchLedger.jobs[0]!;
    expect(receipt).toMatchObject({ requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/), providerObservation: { resultSha256: await digest(raw) },
      accounting: { providerReportedCostUsd: 0.001 } });
    expect(receipt).not.toHaveProperty('resultText');
    expect(receipt).not.toHaveProperty('resultSha256');
  });

  it('falls back to a content-free billing receipt when a retained cutoff exceeds workspace capacity', async () => {
    const partial = 'x'.repeat(16 * 1024 * 1024 - 512);
    const f = await fixture(inspection(partial, 'truncated'));
    const observed = await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    expect(observed.job).toMatchObject({ status: 'result_not_retained', failureCode: 'result_not_retained', providerReportedCostUsd: 0.001 });
    expect(observed.job).not.toHaveProperty('truncatedResultText');
    const receipt = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, any>[] } }).openRouterBatchLedger.jobs[0]!;
    expect(receipt).toMatchObject({ requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/), accounting: { providerReportedCostUsd: 0.001 } });
    expect(receipt).not.toHaveProperty('truncatedResultText');
    expect(receipt).not.toHaveProperty('truncatedResultSha256');
  });

  it('keeps the frozen historical summary when source content changes before GET observation', async () => {
    const raw = JSON.stringify({ markdown: 'Historical summary.', sourceReferences: ['event-1'] });
    const f = await fixture(inspection(raw));
    await (f.app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
      draft.notes.push({ id: randomUUID(), title: 'Later note', revision: 1, transcript: 'An unrelated later note edit.', durationSeconds: 0,
        createdAt: '2026-07-03T00:00:00.000Z', status: 'recorded' });
    });
    const observed = await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    expect(observed.job.status).toBe('completed');
    expect((f.store.value as AppState & { openRouterBatchLedger: { jobs: { resultText?: string }[] } }).openRouterBatchLedger.jobs[0]!.resultText).toBe(raw);
  });

  it('captures the authority callback before asynchronous validation and aborts if it is replaced', async () => {
    const input: { submission?: unknown; assertCurrentAuthorityBeforePost?: () => void } = {};
    const binding = await makeBinding();
    const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
    input.submission = { operationId: randomUUID(), requestProfileVersion: 6, operation: 'period_summary', requestBody: prepared.body,
      requestSha256: await digest(prepared.body), summaryBinding: prepared.binding };
    input.assertCurrentAuthorityBeforePost = () => { throw new Error('captured_authority_rejected'); };
    const f = await fixture(inspection('{}'), undefined, undefined, true);
    const submit = (f.app as unknown as { submitPreparedPeriodSummary(value: unknown): Promise<unknown> }).submitPreparedPeriodSummary.bind(f.app);
    const pending = submit(input);
    input.assertCurrentAuthorityBeforePost = () => undefined;
    await expect(pending).rejects.toThrow('captured_authority_rejected');
    expect(f.posts).toBe(0);
    expect((f.store.value as AppState & { openRouterBatchLedger: { jobs: { status: string }[] } }).openRouterBatchLedger.jobs)
      .toMatchObject([{ status: 'failed' }]);
  });

  it('rejects lifecycle changes during blocked digest validation before staging or POST', async () => {
    const f = await fixture(inspection('{}'), undefined, undefined, true);
    const crypto = (f.app as unknown as { crypto: { sha256(value: string | Uint8Array): Promise<string> } }).crypto;
    const originalDigest = crypto.sha256.bind(crypto);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    let first = true;
    crypto.sha256 = async (value) => {
      if (first) { first = false; await gate; }
      return originalDigest(value);
    };
    const binding = await makeBinding();
    const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
    const input = { submission: { operationId: randomUUID(), requestProfileVersion: 6, operation: 'period_summary', requestBody: prepared.body,
      requestSha256: await digest(prepared.body), summaryBinding: prepared.binding }, assertCurrentAuthorityBeforePost: () => undefined };
    const pending = (f.app as unknown as { submitPreparedPeriodSummary(value: unknown): Promise<unknown> }).submitPreparedPeriodSummary(input);
    (f.app as unknown as { bootstrapGeneration: number }).bootstrapGeneration += 1;
    f.integration.privacySession = { epoch: 'changed' };
    unblock();
    await expect(pending).rejects.toThrow(/earlier workspace session/);
    crypto.sha256 = originalDigest;
    expect(f.posts).toBe(0);
    expect((f.store.value as AppState & { openRouterBatchLedger?: { jobs: unknown[] } }).openRouterBatchLedger?.jobs ?? []).toHaveLength(0);
  });

  it('does not allow a second job for an occurrence already completed or explicitly tombstoned', async () => {
    const raw = JSON.stringify({ markdown: 'Historical summary.', sourceReferences: ['event-1'] });
    const f = await fixture(inspection(raw));
    const repeat = async () => {
      const prepared = await buildOpenRouterPeriodSummaryRequest(f.binding, digest);
      return (f.app as unknown as { submitPreparedPeriodSummary(input: unknown): Promise<unknown> }).submitPreparedPeriodSummary({
        submission: { operationId: randomUUID(), requestProfileVersion: 6, operation: 'period_summary', requestBody: prepared.body,
          requestSha256: await digest(prepared.body), summaryBinding: prepared.binding }, assertCurrentAuthorityBeforePost: () => undefined });
    };
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    await expect(repeat()).rejects.toThrow(/already has a retained summary request/);
    const ledger = (f.app as unknown as { assistantBatchLedger: { version: 1; jobs: any[] } }).assistantBatchLedger;
    const removed = tombstoneOpenRouterBatchJob(ledger.jobs[0]!, new Date().toISOString());
    const tombstone = validateOpenRouterBatchLedger({ version: 1, jobs: [removed] });
    await (f.app as unknown as { mutate(operation: () => undefined, options: undefined, ledger: () => typeof tombstone): Promise<void> })
      .mutate(() => undefined, undefined, () => tombstone);
    await expect(repeat()).rejects.toThrow(/already has a retained summary request/);
  });

  it('preserves an observed completed result when a later GET reports different bytes', async () => {
    const first = JSON.stringify({ markdown: 'First result.', sourceReferences: ['event-1'] });
    const f = await fixture(inspection(first, 'valid', false));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const before = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    f.setInspection(inspection(JSON.stringify({ markdown: 'Different result.', sourceReferences: ['event-1'] }), 'valid', false));
    const returned = await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const after = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    expect(returned.job.status).toBe('completed');
    expect(after).toEqual(before);
    expect(after).toMatchObject({ resultText: first, resultSha256: await digest(first) });
  });

  it('preserves a partially committed observation checkpoint when a retry returns conflicting bytes', async () => {
    const first = JSON.stringify({ markdown: 'First result.', sourceReferences: ['event-1'] });
    const f = await fixture(inspection(first, 'valid', false));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const completed = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, any>[] } }).openRouterBatchLedger.jobs[0]!;
    const { resultText: _resultText, resultSha256: _resultSha256, ...rest } = completed;
    const partial = validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...rest, status: 'processing' }] });
    await (f.app as unknown as { mutate(operation: () => undefined, options: undefined, ledger: () => typeof partial): Promise<void> })
      .mutate(() => undefined, undefined, () => partial);
    const before = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    f.setInspection(inspection(JSON.stringify({ markdown: 'Conflicting retry.', sourceReferences: ['event-1'] }), 'valid', false));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const after = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: 'processing', providerObservation: { resultSha256: await digest(first) } });
  });
});
