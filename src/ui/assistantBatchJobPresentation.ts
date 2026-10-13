import type { AssistantBatchJobDTO } from '../services/openRouterBatchJobs';

export function assistantBatchStatusLabel(status: AssistantBatchJobDTO['status']): string {
  switch (status) {
    case 'preparing': return 'Preparing request';
    case 'submitting': return 'Submitting request';
    case 'submission_unknown': return 'Submission status uncertain';
    case 'queued': return 'Queued with OpenRouter';
    case 'processing': return 'Processing with OpenRouter';
    case 'completed': return 'Batch request completed';
    case 'failed': return 'Request failed';
    case 'expired': return 'Request expired';
    case 'cancelled': return 'Request cancelled';
    case 'result_stale': return 'Reply was not applied because the note or sources changed';
    case 'result_invalid': return 'Reply could not be validated';
    case 'cleanup_pending': return 'Local cleanup needs attention';
    case 'source_removed': return 'Request content removed';
    default: return 'Batch job status unavailable';
  }
}

/** Provider-reported values only; this deliberately does not estimate cost. */
export function formatReportedBatchCost(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return `US$${value.toFixed(8)}`;
}

export function batchJobTokenSummary(job: AssistantBatchJobDTO): string | undefined {
  const parts = [
    job.promptTokens !== undefined ? `${job.promptTokens.toLocaleString()} prompt` : undefined,
    job.completionTokens !== undefined ? `${job.completionTokens.toLocaleString()} completion` : undefined,
    job.totalTokens !== undefined ? `${job.totalTokens.toLocaleString()} total` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(' · ') : undefined;
}

export function canCheckBatchJob(job: AssistantBatchJobDTO): boolean {
  return job.canCheck;
}

export function batchCheckLabel(job: AssistantBatchJobDTO): 'Check for reply' | 'Check provider usage' {
  return job.status === 'queued' || job.status === 'processing'
    ? 'Check for reply'
    : 'Check provider usage';
}

export function canRetryBatchJobCleanup(job: AssistantBatchJobDTO): boolean {
  return job.status === 'cleanup_pending';
}
