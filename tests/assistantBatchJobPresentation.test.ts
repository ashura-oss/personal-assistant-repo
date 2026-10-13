import { describe, expect, it } from 'vitest';
import type { AssistantBatchJobDTO } from '../src/services/openRouterBatchJobs';
import {
  assistantBatchStatusLabel,
  batchCheckLabel,
  batchJobTokenSummary,
  canCheckBatchJob,
  canRetryBatchJobCleanup,
  formatReportedBatchCost,
} from '../src/ui/assistantBatchJobPresentation';

const job = (overrides: Partial<AssistantBatchJobDTO> = {}): AssistantBatchJobDTO => ({
  id: 'local-job-id',
  kind: 'note_assistance',
  status: 'queued',
  canCheck: true,
  createdAt: '2026-10-13T12:00:00.000Z',
  updatedAt: '2026-10-13T12:00:00.000Z',
  noteId: 'note-1',
  noteRevision: 2,
  model: 'openai/gpt-6-luna:batch',
  effort: 'low',
  requestBytes: 123,
  omittedSourceCount: 0,
  unknownCharge: false,
  costStatus: 'waiting',
  billingScope: 'openrouter_reported',
  ...overrides,
});

describe('assistant Batch job presentation', () => {
  it('shows zero and small provider-reported costs without estimating', () => {
    expect(formatReportedBatchCost(0)).toBe('US$0.00000000');
    expect(formatReportedBatchCost(0.00000725)).toBe('US$0.00000725');
    expect(formatReportedBatchCost(undefined)).toBeUndefined();
    expect(formatReportedBatchCost(Number.NaN)).toBeUndefined();
  });

  it('shows only token counts the provider actually reported', () => {
    expect(batchJobTokenSummary(job({ promptTokens: 75, completionTokens: 14, totalTokens: 89 })))
      .toBe('75 prompt · 14 completion · 89 total');
    expect(batchJobTokenSummary(job({ promptTokens: 0 }))).toBe('0 prompt');
    expect(batchJobTokenSummary(job())).toBeUndefined();
  });

  it('keeps status checks and cleanup retries explicit and distinct', () => {
    expect(canCheckBatchJob(job({ status: 'queued' }))).toBe(true);
    expect(canCheckBatchJob(job({ status: 'processing' }))).toBe(true);
    expect(canCheckBatchJob(job({ status: 'source_removed', sourceRemoved: true, canCheck: false }))).toBe(false);
    expect(canCheckBatchJob(job({ status: 'source_removed', sourceRemoved: true, canCheck: true }))).toBe(true);
    expect(canCheckBatchJob(job({ status: 'submission_unknown', canCheck: false }))).toBe(false);
    expect(canCheckBatchJob(job({ status: 'result_stale' }))).toBe(true);
    expect(batchCheckLabel(job({ status: 'queued' }))).toBe('Check for reply');
    expect(batchCheckLabel(job({ status: 'result_invalid' }))).toBe('Check provider usage');
    expect(canRetryBatchJobCleanup(job({ status: 'cleanup_pending' }))).toBe(true);
    expect(canRetryBatchJobCleanup(job({ status: 'queued' }))).toBe(false);
    expect(assistantBatchStatusLabel('submission_unknown')).toBe('Submission status uncertain');
    expect(assistantBatchStatusLabel('result_stale')).toContain('not applied');
    expect(assistantBatchStatusLabel('source_removed')).toBe('Request content removed');
  });
});
