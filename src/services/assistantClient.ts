import type { AppSettings, AssistIntent, ContextDocument, Note } from '../core';
import type { AssistantSourceInput } from '../assistant';
import { AzureOpenAIClient, type DraftAnalysis, type PreparedAnalysis, type ReplyGenerationInput, type ReplyGenerationResult } from './azure';

type AnalysisRequest = {
  intent?: AssistIntent;
  question?: string;
  queryTimeAnchor?: string;
  queryTimeZone?: string;
  additionalSources?: AssistantSourceInput[];
  preselection?: { omittedSourceCount: number; omittedSourceIds: readonly string[] };
};

/** Structural contract keeps existing isolated Azure test clients injectable. */
export type AssistantModelClient = Pick<AzureOpenAIClient, 'prepare' | 'analyze' | 'generateReply'>;

/** Keeps legacy pure request preparation available, but paid text runs use Batch only. */
export class AssistantClientRouter implements AssistantModelClient {
  constructor(private readonly azure: AssistantModelClient) {}

  private immediatePaidTextError(_settings: AppSettings): Error {
    return new Error('Paid text requests are delivered through the explicit Batch workflow and cannot run immediately.');
  }

  prepare(note: Note, docs: ContextDocument[], settings: AppSettings, request: AnalysisRequest = {}): Promise<PreparedAnalysis> {
    return this.azure.prepare(note, docs, settings, request);
  }

  analyze(note: Note, docs: ContextDocument[], settings: AppSettings, signal?: AbortSignal, onAttempt?: () => Promise<void>, request: AnalysisRequest = {}, prepared?: PreparedAnalysis): Promise<DraftAnalysis> {
    return Promise.reject(this.immediatePaidTextError(settings));
  }

  generateReply(input: ReplyGenerationInput, settings: AppSettings, onAttempt?: () => Promise<void>, beforeDispatch?: () => void): Promise<ReplyGenerationResult> {
    return Promise.reject(this.immediatePaidTextError(settings));
  }
}
