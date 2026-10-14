import type { WorkspaceAssistantBatchJobDisplay } from './workspaceChatDisplayTypes';
import { formatProviderReportedCostUsd } from './formatProviderReportedCostUsd';

export function assistantBatchStatusLabel(status: WorkspaceAssistantBatchJobDisplay['status'], kind: WorkspaceAssistantBatchJobDisplay['kind'] = 'note_assistance'): string {
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
    case 'result_stale': return kind === 'mail_reply' ? 'Reply was not applied because the saved message changed' : 'Reply was not applied because the note or sources changed';
    case 'result_invalid': return 'Reply could not be validated';
    case 'result_truncated': return 'Provider response was cut off; no output applied';
    case 'result_not_retained': return 'Reply could not be saved';
    case 'cleanup_pending': return 'Local cleanup needs attention';
    case 'source_removed': return 'Request content removed';
    default: return 'Batch job status unavailable';
  }
}

/** Provider-reported values only; this deliberately does not estimate cost. */
export function formatReportedBatchCost(value: number | undefined): string | undefined {
  return formatProviderReportedCostUsd(value);
}

export function batchJobTokenSummary(job: WorkspaceAssistantBatchJobDisplay): string | undefined {
  const parts = [
    job.promptTokens !== undefined ? `${job.promptTokens.toLocaleString()} prompt` : undefined,
    job.completionTokens !== undefined ? `${job.completionTokens.toLocaleString()} completion` : undefined,
    job.totalTokens !== undefined ? `${job.totalTokens.toLocaleString()} total` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(' · ') : undefined;
}

export function canCheckBatchJob(job: WorkspaceAssistantBatchJobDisplay): boolean {
  return job.canCheck;
}

export function batchCheckLabel(job: WorkspaceAssistantBatchJobDisplay): 'Check for reply' | 'Check provider usage' {
  return job.status === 'queued' || job.status === 'processing'
    ? 'Check for reply'
    : 'Check provider usage';
}

export function canRetryBatchJobCleanup(job: WorkspaceAssistantBatchJobDisplay): boolean {
  return job.status === 'cleanup_pending';
}

export function hasNoHigherSupportedReasoning(job: WorkspaceAssistantBatchJobDisplay): boolean {
  return job.pendingRecoveryChildId === undefined &&
    (job.effort === 'max' || job.moreComputeEfforts !== undefined && job.moreComputeEfforts.length === 0);
}
