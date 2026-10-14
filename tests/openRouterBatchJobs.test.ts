import { describe, expect, it } from 'vitest';
import {
  assistantBatchJobDTO, isOpenRouterBatchContentJob, tombstoneOpenRouterBatchJob,
  validateOpenRouterBatchLedger, type OpenRouterBatchJob,
} from '../src/services/openRouterBatchJobs';
import { OPENROUTER_BATCH_MODEL } from '../src/services/openRouter';
import { assistantChatRefinementSchemaV2, assistantResponseSchema, assistantResponseSchemaV2 } from '../src/assistant';

const operationId = '20000000-0000-4000-8000-000000000001';
function bodyFor(version: 1 | 2): string {
  return JSON.stringify({ model: 'openai/gpt-6-luna', messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'CANARY PRIVATE TRANSCRIPT' }],
    reasoning: { effort: 'low', exclude: true }, response_format: { type: 'json_schema', json_schema: { name: 'note_assistance', strict: true, schema: version === 1 ? assistantResponseSchema : assistantResponseSchemaV2 } }, stream: false });
}
function refinementBody(): string {
  return JSON.stringify({ model: 'openai/gpt-6-luna', messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'CANARY PRIVATE TRANSCRIPT' }],
    reasoning: { effort: 'high', exclude: true }, response_format: { type: 'json_schema', json_schema: { name: 'chat_refinement', strict: true, schema: assistantChatRefinementSchemaV2 } }, stream: false });
}
const at = '2026-10-13T10:00:00.000Z';

function contentJob(overrides: Partial<OpenRouterBatchJob> = {}): OpenRouterBatchJob {
  const requestProfileVersion: 1 | 2 = overrides.requestProfileVersion === 2 ? 2 : 1;
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

describe('private OpenRouter Batch ledger receipts', () => {
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
