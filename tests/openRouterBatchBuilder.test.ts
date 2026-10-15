import { describe, expect, it } from 'vitest';
import * as Crypto from 'expo-crypto';
import type { AppSettings, Note } from '../src/core';
import { OpenRouterBatchRequestBuilder, OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_BATCH_MODEL } from '../src/services/openRouter';
import { assistantChatRefinementSchemaV2, assistantResponseSchema, assistantResponseSchemaV2 } from '../src/assistant';

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
    // Golden SHA captured by running this same fixture against the pre-refinement
    // builder at commit 11f6371; ordinary note requests remain byte-identical.
    await expect(Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, prepared.body, { encoding: Crypto.CryptoEncoding.HEX }))
      .resolves.toBe('99963f9ccd1f4ec1e2d7a7d3ca111e422b9fe3b92de062f6df46a9ab99356c14');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.includedSourceIds)).toBe(true);
  });

  it('rebuilds the exact legacy v1 response schema when an existing job names profile 1', async () => {
    const prepared = await new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, {}, 1);
    const body = JSON.parse(prepared.body) as { response_format: { json_schema: { schema: unknown } } };
    expect(prepared.requestProfileVersion).toBe(1);
    expect(body.response_format.json_schema.schema).toEqual(assistantResponseSchema);
  });

  it('rejects a policy-v2 aggregate request that exceeds the serialized physical request bound', async () => {
    await expect(new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, {
      intent: 'answer', question: 'Review the selected source.', inputPolicyVersion: 2,
      additionalSources: [{ id: 'large-required-source', revision: 1, text: 'x'.repeat(1024 * 1024), required: true }],
    }, undefined, 2)).rejects.toThrow(/request limit|serialized request limit/i);
  });

  it('builds explicit answer-only refinements with strict empty action arrays and request-local effort', async () => {
    const prepared = await new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, {
      intent: 'answer', question: 'Respond to the current user message.', chatMode: true, chatRefinement: true,
      operation: 'chat_refinement', reasoningEffortOverride: 'high',
      additionalSources: [{ id: 'chat_refinement_parent:parent', revision: 1, text: 'Frozen parent reply.', required: true, kind: 'note' }],
    }, 2);
    const body = JSON.parse(prepared.body) as { reasoning: { effort: string }; response_format: { json_schema: { name: string; schema: typeof assistantChatRefinementSchemaV2 } }; messages: { content: string }[] };
    expect(body.reasoning.effort).toBe('high');
    expect(body.response_format.json_schema.name).toBe('chat_refinement');
    expect(body.response_format.json_schema.schema).toEqual(assistantChatRefinementSchemaV2);
    expect(assistantChatRefinementSchemaV2.properties.decisions.maxItems).toBe(0);
    expect(assistantChatRefinementSchemaV2.properties.decisions.items).toEqual(assistantResponseSchemaV2.properties.decisions.items);
    expect(assistantChatRefinementSchemaV2.properties.proposals.items).toEqual(assistantResponseSchemaV2.properties.proposals.items);
    expect(body.messages[0]?.content).toContain('Set decisions, proposals, and memorySuggestions to empty arrays');
    expect(prepared.includedSourceIds).toContain('chat_refinement_parent:parent');
    await expect(new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, {
      intent: 'answer', chatMode: true, operation: 'chat_refinement', chatRefinement: true,
    }, 2)).rejects.toThrow(/explicit request profile and reasoning effort/i);
    await expect(new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, {
      intent: 'answer', reasoningEffortOverride: 'high',
    }, 2)).rejects.toThrow(/reserved for explicit chat refinement/i);
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

  it('accepts uncapped v2 mail input while retaining the same physical request limit', () => {
    const longBody = 'email '.repeat(3_000);
    const brief = 'brief '.repeat(1_000);
    const noteContext = 'note '.repeat(1_000);
    const policyContext = 'guidance '.repeat(1_000);
    const prepared = new OpenRouterBatchRequestBuilder().prepareReply({
      sourceText: longBody, sourceRepresentation: 'plain', sourceCompleteness: 'complete_text',
      subject: 'Schedule', to: ['alex@example.test'], cc: [], brief, noteContext, policyContext,
      asOf: '2026-10-13T10:00:00.000Z', timeZone: 'Asia/Singapore',
    }, settings, 2);
    const body = JSON.parse(prepared.body) as { messages: { content: string }[] };
    expect(body.messages[1]?.content).toContain(longBody);
    expect(body.messages[1]?.content).toContain(brief);
    expect(body.messages[1]?.content).toContain(noteContext);
    expect(body.messages[0]?.content).toContain(policyContext);
    expect(prepared.requestBytes).toBeLessThan(1024 * 1024 - 4096);
    expect(() => new OpenRouterBatchRequestBuilder().prepareReply({
      sourceText: longBody, sourceRepresentation: 'plain', sourceCompleteness: 'complete_text',
      subject: 'Schedule', to: ['alex@example.test'], cc: [], brief: 'Reply.', noteContext: '', policyContext: '',
      asOf: '2026-10-13T10:00:00.000Z', timeZone: 'Asia/Singapore',
    }, settings)).toThrow(/16 KiB/i);
  });
});
