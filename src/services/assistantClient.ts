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

/** Settings router for immediate providers. OpenRouter is deliberately batch-only and cannot use this path. */
export class AssistantClientRouter implements AssistantModelClient {
  constructor(private readonly azure: AssistantModelClient) {}

  private select(settings: AppSettings): AssistantModelClient {
    if (settings.llmProvider === 'openrouter') {
      throw new Error('OpenRouter replies are delivered through the Batch workflow and cannot run as an immediate request.');
    }
    return this.azure;
  }

  prepare(note: Note, docs: ContextDocument[], settings: AppSettings, request: AnalysisRequest = {}): Promise<PreparedAnalysis> {
    return this.select(settings).prepare(note, docs, settings, request);
  }

  analyze(note: Note, docs: ContextDocument[], settings: AppSettings, signal?: AbortSignal, onAttempt?: () => Promise<void>, request: AnalysisRequest = {}, prepared?: PreparedAnalysis): Promise<DraftAnalysis> {
    return this.select(settings).analyze(note, docs, settings, signal, onAttempt, request, prepared);
  }

  generateReply(input: ReplyGenerationInput, settings: AppSettings, onAttempt?: () => Promise<void>, beforeDispatch?: () => void): Promise<ReplyGenerationResult> {
    return this.select(settings).generateReply(input, settings, onAttempt, beforeDispatch);
  }
}
