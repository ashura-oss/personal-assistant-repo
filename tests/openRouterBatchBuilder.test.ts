import { describe, expect, it } from 'vitest';
import type { AppSettings, Note } from '../src/core';
import { OpenRouterBatchRequestBuilder, OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_BATCH_MODEL } from '../src/services/openRouter';
import { assistantResponseSchema, assistantResponseSchemaV2 } from '../src/assistant';

const settings: AppSettings = {
  mode: 'provider', llmProvider: 'openrouter', openRouterModel: OPENROUTER_BATCH_MODEL,
  openRouterReasoningEffort: 'low', llmRequestContractVersion: 1,
  timezone: 'Asia/Singapore', openAiEndpoint: undefined, openAiDeployment: undefined,
  maxContextTokens: 4096, maxRequestBytes: 1024, maxOutputTokens: 64, monthlyBudgetUsd: 3,
  reasoningEffort: 'none', maxAttempts: 1, maxCallsPerDay: 2, maxAudioSeconds: 600, audioRetention: 'keep',
};
const note: Note = { id: 'note-1', title: 'Visit plan', transcript: 'Call Alex tomorrow about the visit.', durationSeconds: 4.125, createdAt: '2026-10-13T10:00:00.000Z', capturedAt: '2026-10-13T10:00:00.000Z', captureTimeZone: 'Asia/Singapore', status: 'recorded', revision: 3 };

describe('OpenRouter Batch local request builder', () => {
  it('reuses exact assistant prompts, source fingerprints, and strict schema without Azure configuration or legacy request caps', async () => {
    const prepared = await new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, { intent: 'answer', question: 'When should I call?' });
    const body = JSON.parse(prepared.body) as Record<string, unknown>;
    expect(prepared.endpoint).toBe('/v1/chat/completions');
    expect(prepared.includedSourceIds).toContain('transcript');
    expect(prepared.sourceVersions.transcript).toMatch(/^3:[0-9a-f]{64}$/);
    expect(prepared.includedSources[0]?.excerpt).toContain(note.transcript);
    expect(body.model).toBe(OPENROUTER_BATCH_BODY_MODEL);
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('usage');
    expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'note_assistance', strict: true } });
    expect(prepared.requestProfileVersion).toBe(2);
    expect((body.response_format as { json_schema: { schema: typeof assistantResponseSchemaV2 } }).json_schema.schema).toEqual(assistantResponseSchemaV2);
    expect(assistantResponseSchemaV2.properties.summary).not.toHaveProperty('maxLength');
    expect(assistantResponseSchemaV2.properties.answer).not.toHaveProperty('maxLength');
    const messages = body.messages as { role: string; content: string }[];
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toContain('recording start 2026-10-13T10:00:00.000Z in IANA timezone Asia/Singapore');
    expect(messages[1]?.content).toContain('When should I call?');
    expect(new TextEncoder().encode(prepared.body).length).toBeLessThan(1024 * 1024);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.includedSourceIds)).toBe(true);
  });

  it('rebuilds the exact legacy v1 response schema when an existing job names profile 1', async () => {
    const prepared = await new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, {}, 1);
    const body = JSON.parse(prepared.body) as { response_format: { json_schema: { schema: unknown } } };
    expect(prepared.requestProfileVersion).toBe(1);
    expect(body.response_format.json_schema.schema).toEqual(assistantResponseSchema);
  });

  it('builds a separate strict reply request with locked metadata and no artificial output cap', () => {
    const prepared = new OpenRouterBatchRequestBuilder().prepareReply({
      sourceText: 'Can you confirm Tuesday?', sourceRepresentation: 'plain', sourceCompleteness: 'complete_text',
      subject: 'Schedule', to: ['alex@example.test'], cc: [], brief: 'Say that I will confirm.',
      noteContext: 'Keep replies short.', policyContext: '', asOf: '2026-10-13T10:00:00.000Z', timeZone: 'Asia/Singapore',
    }, settings);
    const body = JSON.parse(prepared.body) as Record<string, unknown>;
    expect(body.model).toBe(OPENROUTER_BATCH_BODY_MODEL);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
    const messages = body.messages as { content: string }[];
    expect(messages[1]?.content).toContain('LOCKED TO:\nalex@example.test');
    expect(messages[1]?.content).toContain('USER BRIEF:\nSay that I will confirm.');
    expect(prepared.requestBytes).toBe(new TextEncoder().encode(prepared.body).length);
  });
});
