import { describe, expect, it } from 'vitest';
import {
  assistantBatchJobDTO, isOpenRouterBatchContentJob, tombstoneOpenRouterBatchJob,
  validateOpenRouterBatchLedger, type OpenRouterBatchJob,
} from '../src/services/openRouterBatchJobs';
import { OPENROUTER_BATCH_MODEL } from '../src/services/openRouter';

const operationId = '20000000-0000-4000-8000-000000000001';
const body = JSON.stringify({ prompt: 'CANARY PRIVATE TRANSCRIPT', question: 'CANARY PRIVATE QUESTION' });
const at = '2026-10-13T10:00:00.000Z';

function contentJob(overrides: Partial<OpenRouterBatchJob> = {}): OpenRouterBatchJob {
  return {
    id: operationId, customId: operationId, kind: 'note_assistance', status: 'queued', createdAt: at, updatedAt: at,
    noteId: 'local-note-id', noteRevision: 2, intent: 'answer', question: 'CANARY PRIVATE QUESTION', knowledgeSelection: [],
    capturedAt: at, captureTimeZone: 'Asia/Singapore', answeredAsOf: at,
    settingsFingerprint: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), requestProfileVersion: 1,
    model: OPENROUTER_BATCH_MODEL, effort: 'low', requestBytes: new TextEncoder().encode(body).byteLength,
    omittedSourceCount: 0, requestBody: body, requestSha256: 'c'.repeat(64), sourceVersions: { transcript: 'd'.repeat(64) },
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
});
