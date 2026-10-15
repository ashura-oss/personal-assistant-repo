import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppControllerImpl } from '../src/services/controller';
import { OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_CHAT_COMPLETIONS_PATH, OpenRouterBatchDispatchError, type OpenRouterBatchInspection } from '../src/services/openRouter';
import { buildOpenRouterPeriodSummaryRequest, createOpenRouterPeriodSummaryBinding, type OpenRouterPeriodSummarySource } from '../src/services/openRouterPeriodSummary';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';
import { tombstoneOpenRouterBatchJob, validateOpenRouterBatchLedger } from '../src/services/openRouterBatchJobs';

const digest = async (value: string): Promise<string> => createHash('sha256').update(value, 'utf8').digest('hex');
const SOURCE_NOTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceNoteRef = `note:${encodeURIComponent(SOURCE_NOTE_ID)}`;

class MemoryStore implements StateStore {
  value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
  async readCurrentSnapshot() { return this.value ? { raw: JSON.stringify(this.value), schemaVersion: 1 } : undefined; }
  async assertCurrent() {}
}

async function makeBinding(sourceOverride?: OpenRouterPeriodSummarySource) {
  const content = sourceOverride?.content ?? 'A completed event in the selected period.';
  const noteSource: OpenRouterPeriodSummarySource = { id: sourceNoteRef, role: 'event', kind: 'note', revision: 1, content: 'A completed event in the selected period.',
    contentSha256: await digest('A completed event in the selected period.'), effectiveAt: '2026-07-01T10:00:00.000Z', observedAt: '2026-07-01T11:00:00.000Z' };
  const source: OpenRouterPeriodSummarySource = sourceOverride ?? { id: sourceNoteRef, role: 'event', kind: 'note', revision: 1, content,
    contentSha256: await digest(content), effectiveAt: '2026-07-01T10:00:00.000Z', observedAt: '2026-07-01T11:00:00.000Z' };
  return createOpenRouterPeriodSummaryBinding({ version: 1, requestProfileVersion: 6, operation: 'period_summary',
    policyId: '11111111-1111-4111-8111-111111111111', policyRevision: 1, policyDigest: 'a'.repeat(64),
    occurrenceId: randomUUID(), period: 'daily', timeZone: 'UTC', localInterval: { start: '2026-07-01', end: '2026-07-02' },
    startUtc: '2026-07-01T00:00:00.000Z', endUtc: '2026-07-02T00:00:00.000Z', preparedAt: '2026-07-02T01:00:00.000Z',
    sources: sourceOverride ? [source, noteSource].sort((left, right) => left.id.localeCompare(right.id)) : [source],
    destination: { kind: 'absent', documentId: null, path: 'memory/summaries/daily/2026-07-01.md', expectedRevision: null, expectedAbsenceGeneration: 0 },
    instructions: 'Summarize the period and cite supplied source IDs.', effort: 'low' }, digest);
}

async function fixture(result: OpenRouterBatchInspection, beforeStart?: (store: MemoryStore) => void, authorityCheck: () => void = () => undefined, skipSubmit = false,
  bindingOverride?: Awaited<ReturnType<typeof makeBinding>>) {
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
  await (app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
    draft.notes.push({ id: SOURCE_NOTE_ID, title: 'Period source', revision: 1, transcript: 'A completed event in the selected period.',
      durationSeconds: 0, createdAt: '2026-07-01T10:00:00.000Z', status: 'recorded' });
    if (bindingOverride?.sources[0]?.kind === 'person') {
      const id = bindingOverride.sources[0].id.slice('knowledge:person:'.length);
      draft.knowledge.people.push({ id, revision: 1, name: 'Summary subject', aliases: [], narrativePath: `people/${id}.md`,
        createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T10:00:00.000Z',
        facts: [{ id: 'fact-to-remove', provenance: 'user_authored', createdAt: '2026-07-01T10:00:00.000Z', statement: 'Sensitive captured fact.' }],
        contacts: [], sourceLinks: [] });
    }
  });
  const binding = bindingOverride ?? await makeBinding();
  const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
  const operationId = randomUUID();
  const dto = skipSubmit ? undefined : await (app as unknown as { submitPreparedPeriodSummary(input: unknown): Promise<{ id: string; status: string }> })
    .submitPreparedPeriodSummary({ submission: { operationId, requestProfileVersion: 6, operation: 'period_summary', requestBody: prepared.body,
      requestSha256: await digest(prepared.body), summaryBinding: prepared.binding }, assertCurrentAuthorityBeforePost: authorityCheck });
  return { app, store, dto, get submitted() { return submitted; }, binding, operationId, integration,
    setInspection(value: OpenRouterBatchInspection) { currentInspection = value; }, get posts() { return posts; } };
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
    const raw = JSON.stringify({ markdown: '# Daily summary\nOne completed item.', sourceReferences: [sourceNoteRef] });
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

  it('prepares and submits a one-use higher-effort summary child from the frozen source and cutoff hash only', async () => {
    const partial = '{"markdown":"partial cutoff that must not enter the request"';
    const f = await fixture(inspection(partial, 'truncated'));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const parent = (f.app as unknown as { assistantBatchLedger: { jobs: Record<string, any>[] } }).assistantBatchLedger.jobs[0]!;
    await expect((f.app as any).preparePeriodSummaryMoreCompute({ jobId: parent.id, effort: 'low' }))
      .rejects.toThrow(/strictly higher/i);
    const plan = await (f.app as any).preparePeriodSummaryMoreCompute({ jobId: parent.id, effort: 'medium' });
    expect(plan).toMatchObject({ kind: 'period_summary', jobId: parent.id, priorEffort: 'low', requestedEffort: 'medium', sourceCount: 1,
      period: 'daily', destinationPath: f.binding.destination.path, priorAccounting: { costStatus: 'reported', providerReportedCostUsd: 0.001 } });
    expect(JSON.stringify(plan)).not.toContain(SOURCE_NOTE_ID);
    expect(JSON.stringify(plan)).not.toContain(partial);

    await expect((f.app as any).submitPeriodSummaryMoreCompute({ planId: plan.planId, jobId: parent.id }))
      .resolves.toMatchObject({ kind: 'period_summary', status: 'queued', effort: 'medium' });
    const ledger = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, any>[] } }).openRouterBatchLedger.jobs;
    expect(ledger).toHaveLength(2);
    const child = ledger.find((job) => job.id !== parent.id)!;
    expect(child).toMatchObject({ status: 'queued', summaryRecoveryBinding: { parentJobId: parent.id,
      truncatedResultSha256: await digest(partial), rootJobId: parent.id, effort: 'medium' }, summaryBinding: { sources: [{ content: 'A completed event in the selected period.' }] } });
    expect(child.requestBody).not.toContain(partial);
    expect(f.submitted).toMatchObject({ operation: 'period_summary', summaryRecoveryBinding: { parentJobId: parent.id } });
    await expect((f.app as any).submitPeriodSummaryMoreCompute({ planId: plan.planId, jobId: parent.id })).rejects.toThrow(/review is no longer current/i);
  });

  it('scrubs a deleted captured note and blocks new recovery before another paid POST', async () => {
    const f = await fixture(inspection('{"markdown":"partial"', 'truncated'));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    await f.app.deleteNote(SOURCE_NOTE_ID);
    const parent = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, any>[] } }).openRouterBatchLedger.jobs[0]!;
    expect(parent).toMatchObject({ status: 'source_removed', sourceRemoved: true, accounting: { providerReportedCostUsd: 0.001 } });
    for (const field of ['requestBody', 'summaryBinding', 'truncatedResultText', 'truncatedResultSha256', 'resultText', 'resultSha256']) {
      expect(parent).not.toHaveProperty(field);
    }
    await expect((f.app as any).preparePeriodSummaryMoreCompute({ jobId: f.dto!.id, effort: 'medium' }))
      .rejects.toThrow(/not available|captured source/i);
    expect(f.posts).toBe(1);
  });

  it('invalidates a prepared recovery plan and tombstones its submitted descendants when the captured note is deleted', async () => {
    const f = await fixture(inspection('{"markdown":"partial"', 'truncated'));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const plan = await (f.app as any).preparePeriodSummaryMoreCompute({ jobId: f.dto!.id, effort: 'medium' });
    const child = await (f.app as any).submitPeriodSummaryMoreCompute({ planId: plan.planId, jobId: f.dto!.id });
    await f.app.refreshAssistantBatchForObservation(child.id);
    const descendantPlan = await (f.app as any).preparePeriodSummaryMoreCompute({ jobId: child.id, effort: 'high' });
    const grandchild = await (f.app as any).submitPeriodSummaryMoreCompute({ planId: descendantPlan.planId, jobId: child.id });
    await f.app.refreshAssistantBatchForObservation(grandchild.id);
    const pendingPlan = await (f.app as any).preparePeriodSummaryMoreCompute({ jobId: grandchild.id, effort: 'max' });
    await f.app.deleteNote(SOURCE_NOTE_ID);
    expect((f.app as any).periodSummaryMoreComputePlans.size).toBe(0);
    await expect((f.app as any).submitPeriodSummaryMoreCompute({ planId: pendingPlan.planId, jobId: grandchild.id }))
      .rejects.toThrow(/review is no longer current/i);
    const jobs = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, any>[] } }).openRouterBatchLedger.jobs;
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.status)).toEqual(['source_removed', 'source_removed', 'source_removed']);
    for (const job of jobs) {
      expect(job).toMatchObject({ sourceRemoved: true, accounting: expect.any(Object) });
      for (const field of ['requestBody', 'summaryBinding', 'summaryRecoveryBinding', 'truncatedResultText', 'truncatedResultSha256', 'resultText', 'resultSha256']) {
        expect(job).not.toHaveProperty(field);
      }
    }
    expect(f.posts).toBe(3);
    await expect((f.app as any).preparePeriodSummaryMoreCompute({ jobId: f.dto!.id, effort: 'high' }))
      .rejects.toThrow(/not available|captured source/i);
    expect(f.posts).toBe(3);
    expect(jobs.map((job) => job.id)).toEqual([f.dto!.id, child.id, grandchild.id]);
  });

  it('scrubs person-fact summary descendants and pending plans only when the fact is explicitly removed', async () => {
    const personId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const personSourceId = `knowledge:person:${personId}`;
    const content = 'Summary subject: Sensitive captured fact.';
    const binding = await makeBinding({ id: personSourceId, role: 'context', kind: 'person', revision: 1, content,
      contentSha256: await digest(content), effectiveAt: '2026-07-01T10:00:00.000Z', observedAt: '2026-07-01T11:00:00.000Z' });
    const f = await fixture(inspection(JSON.stringify({ markdown: 'partial parent', sourceReferences: [personSourceId] }), 'truncated'), undefined, undefined, false, binding);
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const parentPlan = await (f.app as any).preparePeriodSummaryMoreCompute({ jobId: f.dto!.id, effort: 'medium' });
    const child = await (f.app as any).submitPeriodSummaryMoreCompute({ planId: parentPlan.planId, jobId: f.dto!.id });
    await f.app.refreshAssistantBatchForObservation(child.id);
    const childPlan = await (f.app as any).preparePeriodSummaryMoreCompute({ jobId: child.id, effort: 'high' });
    const grandchild = await (f.app as any).submitPeriodSummaryMoreCompute({ planId: childPlan.planId, jobId: child.id });
    await f.app.refreshAssistantBatchForObservation(grandchild.id);
    const pendingPlan = await (f.app as any).preparePeriodSummaryMoreCompute({ jobId: grandchild.id, effort: 'max' });

    await f.app.removeKnowledgeFact({ entityKind: 'person', entityId: personId, expectedEntityRevision: 1, itemId: 'fact-to-remove' });

    expect((f.app as any).periodSummaryMoreComputePlans.size).toBe(0);
    await expect((f.app as any).submitPeriodSummaryMoreCompute({ planId: pendingPlan.planId, jobId: grandchild.id }))
      .rejects.toThrow(/review is no longer current/i);
    const jobs = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, any>[] } }).openRouterBatchLedger.jobs;
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.status)).toEqual(['source_removed', 'source_removed', 'source_removed']);
    for (const job of jobs) {
      expect(job).toMatchObject({ sourceRemoved: true, accounting: { providerReportedCostUsd: 0.001 } });
      for (const field of ['requestBody', 'summaryBinding', 'summaryRecoveryBinding', 'truncatedResultText', 'truncatedResultSha256', 'resultText', 'resultSha256']) {
        expect(job).not.toHaveProperty(field);
      }
    }
    expect(jobs.map((job) => job.id)).toEqual([f.dto!.id, child.id, grandchild.id]);
    expect(f.posts).toBe(3);
    await expect((f.app as any).preparePeriodSummaryMoreCompute({ jobId: f.dto!.id, effort: 'high' }))
      .rejects.toThrow(/not available|captured source/i);
    expect(f.posts).toBe(3);
  });

  it('captures MoreCompute IDs and effort before delayed validation and rejects lifecycle changes before staging', async () => {
    const f = await fixture(inspection('{"markdown":"partial"', 'truncated'));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const crypto = (f.app as unknown as { crypto: { sha256(value: string | Uint8Array): Promise<string> } }).crypto;
    const originalDigest = crypto.sha256.bind(crypto);
    let entered!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    let first = true;
    crypto.sha256 = async (value) => {
      if (first) { first = false; entered(); await gate; }
      return originalDigest(value);
    };
    const input: { jobId: string; effort: 'low' | 'medium' | 'high' | 'max' } = { jobId: f.dto!.id, effort: 'medium' };
    const pending = (f.app as any).preparePeriodSummaryMoreCompute(input);
    await started;
    input.jobId = randomUUID();
    input.effort = 'high';
    unblock();
    const plan = await pending;
    crypto.sha256 = originalDigest;
    expect(plan).toMatchObject({ jobId: f.dto!.id, requestedEffort: 'medium' });

    let enteredAgain!: () => void;
    let unblockAgain!: () => void;
    const startedAgain = new Promise<void>((resolve) => { enteredAgain = resolve; });
    const gateAgain = new Promise<void>((resolve) => { unblockAgain = resolve; });
    first = true;
    crypto.sha256 = async (value) => {
      if (first) { first = false; enteredAgain(); await gateAgain; }
      return originalDigest(value);
    };
    const stale = (f.app as any).preparePeriodSummaryMoreCompute({ jobId: f.dto!.id, effort: 'high' });
    await startedAgain;
    (f.app as unknown as { bootstrapGeneration: number }).bootstrapGeneration += 1;
    f.integration.privacySession = { epoch: 'changed-during-summary-recovery', assertCurrent: async () => undefined };
    unblockAgain();
    await expect(stale).rejects.toThrow(/workspace changed/i);
    crypto.sha256 = originalDigest;
    expect(f.posts).toBe(1);
    expect((f.app as any).periodSummaryMoreComputePlans.size).toBe(0);
  });

  it('returns only validated inert Markdown and human source labels for a retained summary', async () => {
    const raw = JSON.stringify({ markdown: '# Saved summary\nOne event.', sourceReferences: [sourceNoteRef] });
    const f = await fixture(inspection(raw));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const review = await (f.app as any).readPeriodSummaryResult(f.dto!.id);
    expect(review).toEqual({ jobId: f.dto!.id, period: 'daily', timeZone: 'UTC', interval: { start: '2026-07-01', end: '2026-07-02' },
      preparedAt: '2026-07-02T01:00:00.000Z',
      markdown: '# Saved summary\nOne event.', sourceReferences: ['note · 2026-07-01'] });
    expect(JSON.stringify(review)).not.toContain(sourceNoteRef);
    expect(JSON.stringify(review)).not.toContain(await digest(raw));
    const ledger = (f.app as unknown as { assistantBatchLedger: { version: 1; jobs: Record<string, any>[] } }).assistantBatchLedger;
    (f.app as any).assistantBatchLedger = validateOpenRouterBatchLedger({ ...ledger, jobs: [{ ...ledger.jobs[0]!, resultSha256: '0'.repeat(64) }] });
    await expect((f.app as any).readPeriodSummaryResult(f.dto!.id)).rejects.toThrow(/integrity validation/i);
  });

  it('falls back to a content-free billing receipt when a completed summary exceeds workspace capacity', async () => {
    const raw = JSON.stringify({ markdown: 'x'.repeat(16 * 1024 * 1024 - 512), sourceReferences: [sourceNoteRef] });
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
    const raw = JSON.stringify({ markdown: 'Historical summary.', sourceReferences: [sourceNoteRef] });
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
    f.integration.privacySession = { epoch: 'changed', assertCurrent: async () => undefined };
    unblock();
    await expect(pending).rejects.toThrow(/earlier workspace session/);
    crypto.sha256 = originalDigest;
    expect(f.posts).toBe(0);
    expect((f.store.value as AppState & { openRouterBatchLedger?: { jobs: unknown[] } }).openRouterBatchLedger?.jobs ?? []).toHaveLength(0);
  });

  it('does not allow a second job for an occurrence already completed or explicitly tombstoned', async () => {
    const raw = JSON.stringify({ markdown: 'Historical summary.', sourceReferences: [sourceNoteRef] });
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
    const first = JSON.stringify({ markdown: 'First result.', sourceReferences: [sourceNoteRef] });
    const f = await fixture(inspection(first, 'valid', false));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const before = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    f.setInspection(inspection(JSON.stringify({ markdown: 'Different result.', sourceReferences: [sourceNoteRef] }), 'valid', false));
    const returned = await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const after = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    expect(returned.job.status).toBe('completed');
    expect(after).toEqual(before);
    expect(after).toMatchObject({ resultText: first, resultSha256: await digest(first) });
  });

  it('preserves a partially committed observation checkpoint when a retry returns conflicting bytes', async () => {
    const first = JSON.stringify({ markdown: 'First result.', sourceReferences: [sourceNoteRef] });
    const f = await fixture(inspection(first, 'valid', false));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const completed = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, any>[] } }).openRouterBatchLedger.jobs[0]!;
    const { resultText: _resultText, resultSha256: _resultSha256, ...rest } = completed;
    const partial = validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...rest, status: 'processing' }] });
    await (f.app as unknown as { mutate(operation: () => undefined, options: undefined, ledger: () => typeof partial): Promise<void> })
      .mutate(() => undefined, undefined, () => partial);
    const before = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    f.setInspection(inspection(JSON.stringify({ markdown: 'Conflicting retry.', sourceReferences: [sourceNoteRef] }), 'valid', false));
    await f.app.refreshAssistantBatchForObservation(f.dto!.id);
    const after = (f.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: 'processing', providerObservation: { resultSha256: await digest(first) } });
  });
});
