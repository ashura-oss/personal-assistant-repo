import { describe, expect, it, vi } from 'vitest';
import { AzureOpenAIClient, validateAzureEndpoint } from '../src/services/azure';
import type { AppSettings, Note } from '../src/core';

const settings: AppSettings = {
  mode: 'provider', timezone: 'Asia/Singapore', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna', model: 'gpt-6-luna',
  maxContextTokens: 4096, maxOutputTokens: 64, monthlyBudgetUsd: 3, reasoningEffort: 'none', maxAttempts: 1,
  maxCallsPerDay: 2, maxAudioSeconds: 600, audioRetention: 'keep',
};
const note: Note = { id: 'n1', title: 'Note', transcript: 'I need to call Alex tomorrow.', durationSeconds: 0, createdAt: new Date().toISOString(), status: 'recorded', revision: 1 };

describe('Azure endpoint and Responses request', () => {
  it('rejects insecure and lookalike Azure hosts', () => {
    expect(() => validateAzureEndpoint('http://example.openai.azure.com', 'openai')).toThrow();
    expect(() => validateAzureEndpoint('https://openai.azure.com.attacker.test', 'openai')).toThrow();
    expect(() => validateAzureEndpoint('https://example.openai.azure.com/?key=secret', 'openai')).toThrow();
    expect(validateAzureEndpoint('https://example.openai.azure.com', 'openai')).toBe('https://example.openai.azure.com');
  });

  it('uses store:false, strict JSON schema, bounded input, no tools, and keeps provider usage', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(init?.redirect).toBe('error');
      expect(body.store).toBe(false);
      expect(body.tools).toEqual([]);
      expect(body.text.format.strict).toBe(true);
      expect(body.input.map((message: { role: string }) => message.role)).toEqual(['developer', 'user']);
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ proposals: [{ kind: 'task', title: 'Call Alex', body: 'Call Alex tomorrow', recipients: [], dueAt: null, evidence: ['I need to call Alex tomorrow.'] }] }) }] }],
        usage: { input_tokens: 123456, output_tokens: 65432 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new AzureOpenAIClient(fetcher as typeof fetch, async () => 'fake-test-key');
    const result = await client.analyze(note, [], settings);
    expect(result.proposals).toHaveLength(1);
    expect(result.inputTokens).toBe(123456);
    expect(result.outputTokens).toBe(65432);
    expect(result.usageEstimated).toBe(false);
  });

  it('bounds a very large CJK transcript before any network request', async () => {
    const fetcher = vi.fn();
    const readKey = vi.fn(async () => 'fake-test-key');
    const onAttempt = vi.fn(async () => {});
    const client = new AzureOpenAIClient(fetcher as typeof fetch, readKey);
    await expect(client.analyze({ ...note, transcript: '界'.repeat(5000) }, [], settings, undefined, onAttempt)).rejects.toThrow(/configured .* budget/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
  });

  it('uses a clearly estimated full-request byte count when provider usage is invalid', async () => {
    let requestBody = '';
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ proposals: [] }) }] }],
        usage: { input_tokens: null, output_tokens: -1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new AzureOpenAIClient(fetcher as typeof fetch, async () => 'fake-test-key');
    const result = await client.analyze(note, [], settings);
    expect(result.usageEstimated).toBe(true);
    expect(result.inputTokens).toBe(new TextEncoder().encode(requestBody).length + 256);
  });
});
