import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assistantBatchJobDTO, isOpenRouterBatchContentJob, tombstoneOpenRouterBatchJob,
  validateOpenRouterBatchLedger, type OpenRouterBatchJob,
} from '../src/services/openRouterBatchJobs';
import { OPENROUTER_BATCH_MODEL } from '../src/services/openRouter';
import { assistantChatRefinementSchemaV2, assistantResponseSchema, assistantResponseSchemaV2, assistantResponseSchemaV3 } from '../src/assistant';
import { buildOpenRouterPeriodSummaryRequest, createOpenRouterPeriodSummaryBinding } from '../src/services/openRouterPeriodSummary';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { decodeWorkspaceSnapshotDTO } from '../src/cloud/workspaceSnapshotCodec';

const operationId = '20000000-0000-4000-8000-000000000001';
function bodyFor(version: 1 | 2 | 5): string {
  return JSON.stringify({ model: 'openai/gpt-6-luna', messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'CANARY PRIVATE TRANSCRIPT' }],
    reasoning: { effort: 'low', exclude: true }, response_format: { type: 'json_schema', json_schema: { name: 'note_assistance', strict: true, schema: version === 1 ? assistantResponseSchema : version === 2 ? assistantResponseSchemaV2 : assistantResponseSchemaV3 } }, stream: false });
}
function refinementBody(): string {
  return JSON.stringify({ model: 'openai/gpt-6-luna', messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'CANARY PRIVATE TRANSCRIPT' }],
    reasoning: { effort: 'high', exclude: true }, response_format: { type: 'json_schema', json_schema: { name: 'chat_refinement', strict: true, schema: assistantChatRefinementSchemaV2 } }, stream: false });
}
const at = '2026-10-13T10:00:00.000Z';

function contentJob(overrides: Partial<OpenRouterBatchJob> = {}): OpenRouterBatchJob {
  const requestProfileVersion: 1 | 2 | 5 = overrides.requestProfileVersion === 2 ? 2 : overrides.requestProfileVersion === 5 ? 5 : 1;
  const requestBody = overrides.requestBody ?? bodyFor(requestProfileVersion);
  return {
    id: operationId, customId: operationId, kind: 'note_assistance', status: 'queued', createdAt: at, updatedAt: at,
    noteId: 'local-note-id', noteRevision: 2, intent: 'answer', question: 'CANARY PRIVATE QUESTION', knowledgeSelection: [],
    capturedAt: at, captureTimeZone: 'Asia/Singapore', answeredAsOf: at,
    settingsFingerprint: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), requestProfileVersion,
    model: OPENROUTER_BATCH_MODEL, effort: 'low', requestBytes: new TextEncoder().encode(requestBody).byteLength,
    omittedSourceCount: 0, requestBody, requestSha256: 'c'.repeat(64), sourceVersions: { transcript: 'd'.repeat(64) },
    batchId: 'batch_fixture_1', unknownCharge: true, ...overrides,
  };
}

async function summaryJob(): Promise<OpenRouterBatchJob> {
  const digest = async (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const sourceText = 'Private source content for the ledger contract test.';
  const binding = await createOpenRouterPeriodSummaryBinding({
    version: 1, requestProfileVersion: 6, operation: 'period_summary', policyId: '11111111-1111-4111-8111-111111111111',
    policyRevision: 1, policyDigest: 'a'.repeat(64), occurrenceId: '22222222-2222-4222-8222-222222222222',
    period: 'daily', timeZone: 'UTC', localInterval: { start: '2026-06-30', end: '2026-07-01' },
    startUtc: '2026-06-30T00:00:00.000Z', endUtc: '2026-07-01T00:00:00.000Z', preparedAt: '2026-07-01T01:00:00.000Z',
    sources: [{ id: 'event-1', role: 'event', kind: 'note', revision: 1, content: sourceText, contentSha256: await digest(sourceText),
      effectiveAt: '2026-06-30T12:00:00.000Z', observedAt: '2026-07-01T01:00:00.000Z' }],
    destination: { kind: 'absent', documentId: null, path: 'reports/daily.md', expectedRevision: null, expectedAbsenceGeneration: 0 },
    instructions: 'Summarize supplied events.', effort: 'low',
  }, digest);
  const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
  const id = '30000000-0000-4000-8000-000000000001';
  return { id, customId: id, kind: 'period_summary', status: 'queued', createdAt: at, updatedAt: at, model: OPENROUTER_BATCH_MODEL,
    effort: 'low', requestSha256: await digest(prepared.body), unknownCharge: true, batchId: 'batch_summary_fixture', operation: 'period_summary',
    requestProfileVersion: 6, inputPolicyVersion: 2, outputPolicyVersion: 2, requestBytes: prepared.requestBytes,
    requestBody: prepared.body, summaryBinding: binding };
}

describe('private OpenRouter Batch ledger receipts', () => {
  it('retains profile-6 summary lineage privately and exposes only period metadata through DTO and tombstone', async () => {
    const job = await summaryJob();
    const validated = validateOpenRouterBatchLedger({ version: 1, jobs: [job] });
    expect(validated.jobs[0]).toMatchObject({ kind: 'period_summary', requestProfileVersion: 6, inputPolicyVersion: 2, outputPolicyVersion: 2, operation: 'period_summary' });
    const dto = assistantBatchJobDTO(validated.jobs[0]!);
    expect(dto).toMatchObject({ kind: 'period_summary', periodSummary: { period: 'daily', timeZone: 'UTC' } });
    expect(JSON.stringify(dto)).not.toContain('Private source content');
    expect(JSON.stringify(dto)).not.toContain('sourceManifestSha256');

    const removed = tombstoneOpenRouterBatchJob(validated.jobs[0]!, at);
    const roundTrip = validateOpenRouterBatchLedger({ version: 1, jobs: [removed] });
    expect(roundTrip.jobs[0]).toMatchObject({ kind: 'period_summary', status: 'source_removed', requestProfileVersion: 6,
      inputPolicyVersion: 2, outputPolicyVersion: 2, operation: 'period_summary' });
    expect(roundTrip.jobs[0]).not.toHaveProperty('requestBody');
    expect(roundTrip.jobs[0]).not.toHaveProperty('summaryBinding');
    expect(JSON.stringify(roundTrip)).not.toContain('Private source content');

    const tombstoneDto = assistantBatchJobDTO(roundTrip.jobs[0]!);
    expect(tombstoneDto.periodSummary).toEqual({ period: 'daily', timeZone: 'UTC', localInterval: { start: '2026-06-30', end: '2026-07-01' } });
    expect(tombstoneDto.periodSummary).not.toHaveProperty('occurrenceId');
    const state = createInitialWorkspaceState(() => operationId);
    state.assistantBatchJobs = [tombstoneDto];
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state },
      { workspaceId: '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', privacyEpoch: 2, revision: 9 });
    const decoded = decodeWorkspaceSnapshotDTO(JSON.parse(JSON.stringify(snapshot)) as unknown);
    expect(decoded.state.assistantBatchJobs[0]?.periodSummary).toEqual(tombstoneDto.periodSummary);
    expect(JSON.stringify(decoded.state.assistantBatchJobs[0])).not.toContain('occurrenceId');
  });

  it('requires the exact deterministic profile-6 body and Unicode-safe frozen source content', async () => {
    const job = await summaryJob();
    const alteredBody = JSON.parse(job.requestBody!) as Record<string, any>;
    alteredBody.messages[1].content = 'A different prompt with the same schema and effort.';
    const requestBody = JSON.stringify(alteredBody);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...job, requestBody,
      requestBytes: new TextEncoder().encode(requestBody).byteLength }] })).toThrow(/integrity validation/i);

    const binding = JSON.parse(JSON.stringify(job.summaryBinding)) as Record<string, any>;
    binding.sources[0].content = '\ud800';
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...job, summaryBinding: binding }] })).toThrow(/integrity validation/i);
  });

  it('retains cutoff bytes only in a separate bounded pair and scrubs them on explicit source removal', async () => {
    const job = await summaryJob();
    const partial = '{"markdown":"incomplete';
    const truncated = { ...job, status: 'result_truncated' as const, failureCode: 'result_truncated' as const,
      truncatedResultText: partial, truncatedResultSha256: 'd'.repeat(64), accounting: { providerReportedCostUsd: 0.002 } };
    const validated = validateOpenRouterBatchLedger({ version: 1, jobs: [truncated] }).jobs[0]!;
    expect(validated).toMatchObject({ status: 'result_truncated', truncatedResultText: partial, truncatedResultSha256: 'd'.repeat(64) });
    expect(validated).not.toHaveProperty('resultText');
    expect(JSON.stringify(assistantBatchJobDTO(validated))).not.toContain(partial);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...truncated, resultText: partial, resultSha256: 'e'.repeat(64) }] }))
      .toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...truncated, truncatedResultText: '\ud800' }] }))
      .toThrow(/integrity validation/i);

    const removed = tombstoneOpenRouterBatchJob(validated, at);
    const receipt = validateOpenRouterBatchLedger({ version: 1, jobs: [removed] }).jobs[0]!;
    expect(receipt).toMatchObject({ status: 'source_removed', batchId: 'batch_summary_fixture', accounting: { providerReportedCostUsd: 0.002 } });
    expect(receipt).not.toHaveProperty('truncatedResultText');
    expect(receipt).not.toHaveProperty('truncatedResultSha256');
    expect(JSON.stringify(receipt)).not.toContain('incomplete');
  });

  it('replaces deleted source content with a verifiable content-free billing receipt', () => {
    const job = contentJob();
    const tombstone = tombstoneOpenRouterBatchJob(job, at) as OpenRouterBatchJob;
    const validated = validateOpenRouterBatchLedger({ version: 1, jobs: [tombstone] });

    expect(isOpenRouterBatchContentJob(validated.jobs[0]!)).toBe(false);
    expect(JSON.stringify(validated)).not.toContain('CANARY PRIVATE');
    expect(validated.jobs[0]).toMatchObject({ id: operationId, customId: operationId, batchId: 'batch_fixture_1', status: 'source_removed', sourceRemoved: true, requestProfileVersion: 1 });
    expect(validated.jobs[0]).not.toHaveProperty('noteId');
    expect(validated.jobs[0]).not.toHaveProperty('requestBody');
    expect(validated.jobs[0]).not.toHaveProperty('question');
    expect(assistantBatchJobDTO(validated.jobs[0]!)).toMatchObject({ id: operationId, status: 'source_removed', sourceRemoved: true });
    expect(assistantBatchJobDTO(validated.jobs[0]!)).not.toHaveProperty('noteId');
  });

  it('exposes Check only when a saved provider ID can be explicitly inspected', () => {
    expect(assistantBatchJobDTO(contentJob({ status: 'queued' })).canCheck).toBe(true);
    expect(assistantBatchJobDTO(contentJob({ status: 'queued', accounting: { providerReportedCostUsd: 0.01 } })).canCheck).toBe(true);
    expect(assistantBatchJobDTO(contentJob({ status: 'processing', accounting: { providerReportedCostUsd: 0.01 } })).canCheck).toBe(true);
    expect(assistantBatchJobDTO(contentJob({ status: 'completed' })).canCheck).toBe(true);
    expect(assistantBatchJobDTO(contentJob({ status: 'completed', accounting: { providerReportedCostUsd: 0 } })).canCheck).toBe(false);
    expect(assistantBatchJobDTO(contentJob({ status: 'source_removed', sourceRemoved: true, batchId: undefined })).canCheck).toBe(false);
    expect(assistantBatchJobDTO(contentJob({ status: 'source_removed', sourceRemoved: true })).canCheck).toBe(true);
    expect(assistantBatchJobDTO(contentJob({ status: 'queued' }), true).canCheck).toBe(false);
  });

  it('keeps an observed provider result as a private, reloadable processing checkpoint', () => {
    const observedAt = '2026-10-13T10:03:00.000Z';
    const observation = { version: 1 as const, observedAt, resultSha256: 'e'.repeat(64) };
    const validated = validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ status: 'processing', providerObservation: observation,
      accounting: { providerReportedCostUsd: 0.002, totalTokens: 42 }, unknownCharge: false })] });
    expect(validated.jobs[0]).toMatchObject({ status: 'processing', providerObservation: observation, accounting: { providerReportedCostUsd: 0.002 } });
    expect(assistantBatchJobDTO(validated.jobs[0]!)).toMatchObject({ status: 'processing', resultObservedAt: observedAt, costStatus: 'reported', providerReportedCostUsd: 0.002 });
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ providerObservation: observation, status: 'queued' })] })).toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ providerObservation: { ...observation, resultSha256: 'E'.repeat(64) }, status: 'processing' })] })).toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ providerObservation: { ...observation, resultSha256: `${'e'.repeat(64)}\n` }, status: 'processing' })] })).toThrow(/integrity validation/i);
  });

  it('preserves policy 2 on source-removal receipts and rejects tampered profile-policy combinations', () => {
    const job = contentJob({ requestProfileVersion: 5, outputPolicyVersion: 2, requestBody: bodyFor(5) });
    const tombstone = tombstoneOpenRouterBatchJob(job, at);
    expect(validateOpenRouterBatchLedger({ version: 1, jobs: [tombstone] }).jobs[0]).toMatchObject({ requestProfileVersion: 5, outputPolicyVersion: 2 });
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...tombstone, outputPolicyVersion: undefined }] })).toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...tombstone, requestProfileVersion: 2 }] })).toThrow(/integrity validation/i);
  });

  it('rejects UUID, opaque provider ID, and digest fields with a trailing newline', () => {
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ id: `${operationId}\n`, customId: `${operationId}\n` })] })).toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ batchId: 'batch_fixture_1\n' })] })).toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ requestSha256: `${'c'.repeat(63)}\n` })] })).toThrow(/integrity validation/i);
  });

  it('retains v1 and v2 wire profiles immutably and rejects a claimed-version/schema mismatch', () => {
    const legacy = validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ requestProfileVersion: 1 })] });
    const current = validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ requestProfileVersion: 2 })] });
    expect(legacy.jobs[0]?.requestProfileVersion).toBe(1);
    expect(current.jobs[0]?.requestProfileVersion).toBe(2);
    expect(tombstoneOpenRouterBatchJob(current.jobs[0]!, at).requestProfileVersion).toBe(2);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ requestProfileVersion: 2, requestBody: bodyFor(1) })] })).toThrow(/integrity validation/i);
  });

  it('persists an explicit input-policy version privately and preserves it in a content-free tombstone', () => {
    const current = validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ inputPolicyVersion: 2 })] });
    expect(current.jobs[0]?.inputPolicyVersion).toBe(2);
    const removed = tombstoneOpenRouterBatchJob(current.jobs[0]!, at);
    expect(removed.inputPolicyVersion).toBe(2);
    expect(validateOpenRouterBatchLedger({ version: 1, jobs: [removed] }).jobs[0]?.inputPolicyVersion).toBe(2);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ inputPolicyVersion: 3 as 1 | 2 })] })).toThrow(/integrity validation/i);
  });

  it('keeps legacy five-source selection validation while accepting policy-2 Batch history without a selection-count ceiling', () => {
    const knowledgeSelection = Array.from({ length: 6 }, (_, index) => ({ kind: 'person' as const, id: `person-${index}` }));
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ knowledgeSelection })] })).toThrow(/integrity validation/i);
    const current = validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ inputPolicyVersion: 2, knowledgeSelection })] });
    expect(current.jobs[0]?.knowledgeSelection).toHaveLength(6);
  });

  it('preserves the legacy question bound while allowing policy-2 questions within the physical envelope limit', () => {
    const question = 'q'.repeat(20_000);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ question })] })).toThrow(/integrity validation/i);
    const current = validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ question, inputPolicyVersion: 2 })] });
    expect(current.jobs[0]?.question).toBe(question);
    const oversizedUnicode = '界'.repeat(Math.floor((1024 * 1024) / 3) + 1);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [contentJob({ question: oversizedUnicode, inputPolicyVersion: 2 })] })).toThrow(/integrity validation/i);
  });

  it('requires every recovery edge to come from an intact cutoff and use strictly higher effort', () => {
    const parentId = '20000000-0000-4000-8000-000000000011';
    const childId = '20000000-0000-4000-8000-000000000012';
    const parent = contentJob({ id: parentId, customId: parentId, status: 'result_truncated', failureCode: 'result_truncated', effort: 'low' });
    const childBody = JSON.stringify({ ...JSON.parse(bodyFor(1)), reasoning: { effort: 'medium', exclude: true } });
    const child: OpenRouterBatchJob = contentJob({ id: childId, customId: childId, effort: 'medium', status: 'queued',
      requestProfileVersion: 4, requestBody: childBody, requestBytes: new TextEncoder().encode(childBody).byteLength,
      requestSha256: 'f'.repeat(64), recoveryBinding: { version: 1, parentJobId: parentId, parentKind: 'note_assistance',
        parentRequestProfileVersion: 1, parentEffort: 'low', parentRequestSha256: parent.requestSha256!, parentSourceFingerprint: parent.sourceFingerprint!,
        baseRequestProfileVersion: 1, baseOperation: 'note_assistance', baseRequestSha256: parent.requestSha256!,
        baseSourceFingerprint: parent.sourceFingerprint! } });
    expect(validateOpenRouterBatchLedger({ version: 1, jobs: [parent, child] }).jobs).toHaveLength(2);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...parent, status: 'queued', failureCode: undefined }, child] })).toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [parent, { ...child, effort: 'low', requestBody: bodyFor(1),
      requestProfileVersion: 4, requestBytes: new TextEncoder().encode(bodyFor(1)).byteLength }] })).toThrow(/integrity validation/i);
  });

  it('requires chat refinements to retain the exact profile-2 effort pair even after content is tombstoned', () => {
    const parentId = '20000000-0000-4000-8000-000000000006';
    const chatBinding = { conversationId: operationId, turnId: '20000000-0000-4000-8000-000000000005', context: [], omittedTurnCount: 0,
      refinementParent: { turnId: parentId, jobId: '20000000-0000-4000-8000-000000000007', noteId: '20000000-0000-4000-8000-000000000008',
        noteRevision: 1, replySha256: 'e'.repeat(64), replyProfileVersion: 2 as const } };
    const body = refinementBody();
    const refinement = contentJob({ operation: 'chat_refinement', reasoningEffort: 'high', parentTurnId: parentId, effort: 'high',
      requestProfileVersion: 2, requestBody: body, requestBytes: new TextEncoder().encode(body).byteLength,
      chatBinding });
    expect(validateOpenRouterBatchLedger({ version: 1, jobs: [refinement] }).jobs).toHaveLength(1);
    const stripped = tombstoneOpenRouterBatchJob(refinement, at, true);
    expect(validateOpenRouterBatchLedger({ version: 1, jobs: [stripped] }).jobs[0]).not.toHaveProperty('parentTurnId');
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...stripped, requestProfileVersion: 1 }] })).toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...refinement, effort: 'low' }] })).toThrow(/integrity validation/i);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...refinement, reasoningEffort: ['high'] }] })).toThrow(/integrity validation/i);
  });

  it('requires dense, unique, plain Chat context bindings', () => {
    const context = { turnId: '20000000-0000-4000-8000-000000000002', jobId: '20000000-0000-4000-8000-000000000003',
      noteId: '20000000-0000-4000-8000-000000000004', noteRevision: 1, replySha256: 'e'.repeat(64), replyProfileVersion: 2 as const };
    const valid = contentJob({ chatBinding: { conversationId: operationId, turnId: '20000000-0000-4000-8000-000000000005', context: [context], omittedTurnCount: 0 } });
    expect(validateOpenRouterBatchLedger({ version: 1, jobs: [valid] }).jobs).toHaveLength(1);
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...valid, chatBinding: { ...valid.chatBinding!, context: [context, context] } }] })).toThrow(/integrity validation/i);
    const sparse = new Array(2) as unknown[];
    sparse[1] = context;
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...valid, chatBinding: { ...valid.chatBinding!, context: sparse } }] })).toThrow(/integrity validation/i);
    const symbolic = [context] as unknown[] & { [key: symbol]: string };
    symbolic[Symbol('hidden')] = 'not JSON-safe';
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...valid, chatBinding: { ...valid.chatBinding!, context: symbolic } }] })).toThrow(/integrity validation/i);
    let getterInvoked = false;
    const accessor = [] as unknown[];
    Object.defineProperty(accessor, '0', { enumerable: true, configurable: true, get: () => { getterInvoked = true; return context; } });
    accessor.length = 1;
    expect(() => validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...valid, chatBinding: { ...valid.chatBinding!, context: accessor } }] })).toThrow(/integrity validation/i);
    expect(getterInvoked).toBe(false);
  });
});
