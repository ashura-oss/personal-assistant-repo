import type { ReplyGenerationUsage } from './azure';
import type { OpenRouterPeriodSummarySubmission } from './openRouterPeriodSummary';
import type { PeriodSummaryApplicationPlan, PeriodSummaryApplicationPreview, PeriodSummaryApplicationReceipt } from '../core';
export type { DraftAnalysis, PreparedAnalysis, ReplyGenerationInput, ReplyGenerationUsage } from './azure';

/** Private server gateway handoff. Never construct this shape from a browser command. */
export interface TrustedPeriodSummaryDispatch {
  readonly submission: OpenRouterPeriodSummarySubmission;
  /** Rechecks the owned policy/occurrence and completed UTC period immediately before POST. */
  readonly assertCurrentAuthorityBeforePost: () => void;
}

/** Private Node adapter for one-use, lineage-fenced summary document application. */
export interface PeriodSummaryApplicationPort {
  findReceiptByJob(jobId: string): Promise<PeriodSummaryApplicationReceipt | undefined>;
  findReceipt(input: Readonly<{ jobId: string; requestSha256: string; resultSha256?: string }>): Promise<PeriodSummaryApplicationReceipt | undefined>;
  prepare(input: PeriodSummaryApplicationCapture): Promise<PeriodSummaryApplicationPlan | PeriodSummaryApplicationReceipt>;
  readPreview(input: Readonly<{ planId: string; jobId: string }>): PeriodSummaryApplicationPreview | undefined;
  cancel(planId: string): void;
  invalidateJobs(jobIds: readonly string[]): void;
  invalidateAll(): void;
  apply(input: Readonly<{ planId: string; jobId: string; requestSha256: string; resultSha256: string;
    writeDocument(write: PeriodSummaryApplicationWrite): Promise<number> }>): Promise<PeriodSummaryApplicationReceipt>;
}

export type PeriodSummaryApplicationCapture = Readonly<{
  jobId: string; requestSha256: string; resultSha256: string; period: 'daily' | 'weekly' | 'monthly' | 'yearly'; timeZone: string;
  interval: Readonly<{ start: string; end: string }>; preparedAt: string; resultText: string; markdown: string; sourceReferences: readonly string[];
}>;
export type PeriodSummaryApplicationWrite = Readonly<{ path: string; content: string; expectedRevision?: number }>;

export class ReplyGenerationError extends Error {
  constructor(message: string, readonly usage?: ReplyGenerationUsage) { super(message); this.name = 'ReplyGenerationError'; }
}

export class ReplyGenerationPreDispatchError extends Error {
  readonly dispatched = false;
  constructor(message: string) { super(message); this.name = 'ReplyGenerationPreDispatchError'; }
}

export function validateAzureEndpoint(value: string, service: 'speech' | 'openai'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid Azure endpoint.'); }
  const suffixes = service === 'speech'
    ? ['.cognitiveservices.azure.com', '.api.cognitive.microsoft.com']
    : ['.openai.azure.com'];
  const host = url.hostname.toLowerCase();
  const validHost = suffixes.some((suffix) => host.endsWith(suffix) && host !== suffix.slice(1));
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash || !validHost) {
    throw new Error('Provider endpoints must use HTTPS and an Azure service hostname.');
  }
  return url.origin;
}
