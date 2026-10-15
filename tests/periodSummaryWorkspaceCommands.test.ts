import { describe, expect, it } from 'vitest';
import { parseWorkspaceCommandEnvelope, parseWorkspaceCommandReceipt } from '../src/cloud/workspaceCommands';
import { parsePeriodSummaryReadEnvelope } from '../src/cloud/periodSummaryHttpContracts';
import { OPENROUTER_BATCH_RESPONSE_MAX_BYTES } from '../src/services/openRouter';

const jobId = '30000000-0000-4000-8000-000000000001';
const commandId = '40000000-0000-4000-8000-000000000001';
const planId = '50000000-0000-4000-8000-000000000001';

describe('period summary MoreCompute commands', () => {
  it('accepts only bounded plan/execute/cancel inputs with IDs and effort, never prompt or destination data', () => {
    expect(parseWorkspaceCommandEnvelope({ schemaVersion: 1, commandId, expectedRevision: 4, expectedPrivacyEpoch: 2,
      command: { kind: 'assistant.periodSummary.moreCompute.prepare', jobId, effort: 'low' } }).command)
      .toEqual({ kind: 'assistant.periodSummary.moreCompute.prepare', jobId, effort: 'low' });
    expect(parseWorkspaceCommandEnvelope({ schemaVersion: 1, commandId, expectedRevision: 4, expectedPrivacyEpoch: 2,
      command: { kind: 'assistant.periodSummary.moreCompute.submit', jobId, planId } }).command)
      .toEqual({ kind: 'assistant.periodSummary.moreCompute.submit', jobId, planId });
    expect(parseWorkspaceCommandEnvelope({ schemaVersion: 1, commandId, expectedRevision: 4, expectedPrivacyEpoch: 2,
      command: { kind: 'assistant.periodSummary.moreCompute.cancel', planId } }).command)
      .toEqual({ kind: 'assistant.periodSummary.moreCompute.cancel', planId });
    expect(() => parseWorkspaceCommandEnvelope({ schemaVersion: 1, commandId, expectedRevision: 4, expectedPrivacyEpoch: 2,
      command: { kind: 'assistant.periodSummary.moreCompute.prepare', jobId, effort: 'max', markdown: 'forged', path: 'arbitrary.md' } }))
      .toThrow(/workspace_command_invalid/);
  });

  it('round-trips only safe plan preview fields in the command receipt', () => {
    const plan = { planId, jobId, kind: 'period_summary', period: 'daily', timeZone: 'UTC', interval: { start: '2026-07-01', end: '2026-07-02' },
      preparedAt: '2026-07-02T01:00:00.000Z',
      destinationPath: 'memory/summaries/daily/2026-07-01.md', priorEffort: 'none', requestedEffort: 'low', expiresAt: '2026-07-02T02:00:00.000Z',
      sourceCount: 1, sourceLabels: ['event · note · 2026-07-01'], priorAccounting: { costStatus: 'unavailable', unknownCharge: false },
      warning: 'Submitting creates a new paid Batch request using the original frozen sources. The saved partial output is evidence only and is not included.' } as const;
    const receipt = parseWorkspaceCommandReceipt({ schemaVersion: 1, commandId, kind: 'assistant.periodSummary.moreCompute.prepare',
      objectId: jobId, jobId, plan }, { commandId, kind: 'assistant.periodSummary.moreCompute.prepare', objectId: jobId, jobId });
    expect(receipt).toMatchObject({ jobId, plan: { planId, requestedEffort: 'low', sourceCount: 1 } });
    expect(JSON.stringify(receipt)).not.toMatch(/sourceManifest|requestSha|truncatedResult|content|documentId|absenceGeneration/);
    expect(() => parseWorkspaceCommandReceipt({ schemaVersion: 1, commandId, kind: 'assistant.periodSummary.moreCompute.prepare',
      objectId: jobId, jobId, plan: { ...plan, sourceManifestSha256: 'a'.repeat(64) } }))
      .toThrow(/workspace_command_invalid|workspace_command_receipt_invalid/);
  });
});

describe('named period summary review contract', () => {
  const expected = { workspaceId: 'workspace-1', privacyEpoch: 2, revision: 4, jobId };
  const envelopeOwner = { schemaVersion: 1, workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision };
  const review = { jobId, period: 'daily', timeZone: 'America/Los_Angeles', interval: { start: '2026-07-01', end: '2026-07-02' },
    preparedAt: '2026-07-02T08:00:00.000Z', markdown: '# Summary', sourceReferences: ['note · 2026-07-01'] };

  it('keeps only inert Markdown and human references with the captured date context', () => {
    expect(parsePeriodSummaryReadEnvelope({ ...envelopeOwner, review }, expected).review).toEqual(review);
    expect(() => parsePeriodSummaryReadEnvelope({ ...envelopeOwner,
      review: { ...review, occurrenceId: 'private-id' } }, expected)).toThrow(/period_summary_response_invalid/);
    expect(() => parsePeriodSummaryReadEnvelope({ ...envelopeOwner,
      review: { ...review, preparedAt: undefined } }, expected)).toThrow(/period_summary_response_invalid/);
  });

  it('round-trips retained Markdown up to the provider response bound', () => {
    const markdown = `# Summary\n${'x'.repeat(1024 * 1024 + 32)}`;
    expect(new TextEncoder().encode(markdown).byteLength).toBeLessThan(OPENROUTER_BATCH_RESPONSE_MAX_BYTES);
    expect(parsePeriodSummaryReadEnvelope({ ...envelopeOwner, review: { ...review, markdown } }, expected).review.markdown).toBe(markdown);
  });

  it('does not impose a separate reference count quota on a physically bounded retained result', () => {
    const sourceReferences = Array.from({ length: 600 }, (_, index) => `note · 2026-07-${String(index % 28 + 1).padStart(2, '0')}`);
    expect(parsePeriodSummaryReadEnvelope({ ...envelopeOwner, review: { ...review, sourceReferences } }, expected).review.sourceReferences).toHaveLength(600);
  });
});
