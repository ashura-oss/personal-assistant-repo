import type { ReplyGenerationUsage } from './azure';
import type { OpenRouterPeriodSummarySubmission } from './openRouterPeriodSummary';
export type { DraftAnalysis, PreparedAnalysis, ReplyGenerationInput, ReplyGenerationUsage } from './azure';

/** Private server gateway handoff. Never construct this shape from a browser command. */
export interface TrustedPeriodSummaryDispatch {
  readonly submission: OpenRouterPeriodSummarySubmission;
  /** Rechecks the owned policy/occurrence and completed UTC period immediately before POST. */
  readonly assertCurrentAuthorityBeforePost: () => void;
}

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
