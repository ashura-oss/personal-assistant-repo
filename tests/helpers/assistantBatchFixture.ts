import type { KnowledgeSelection, NoteAssistResult } from '../../src/core';
import { OpenRouterBatchClient, OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_BATCH_ENDPOINT, OPENROUTER_CHAT_COMPLETIONS_PATH } from '../../src/services/openRouter';
import type { AssistantBatchJobDTO } from '../../src/services/openRouterBatchJobs';
import type { AppControllerImpl } from '../../src/services/controller';

export type AssistantBatchResponse = Readonly<{
  summary: string;
  answer: string;
  decisions: readonly unknown[];
  citations: readonly unknown[];
  clarifications: readonly unknown[];
  proposals: readonly unknown[];
  memorySuggestions: readonly unknown[];
}>;

const DEFAULT_RESPONSE: AssistantBatchResponse = Object.freeze({
  summary: 'A concise local Batch result.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
});

/** Local fake HTTP boundary; the real Batch client still validates POST, GET, and raw result envelopes. */
export function createCompletedAssistantBatchClient(
  responseForRequest: (input: { operationId: string; requestBody: string }) => AssistantBatchResponse | Promise<AssistantBatchResponse> = () => DEFAULT_RESPONSE,
): { client: OpenRouterBatchClient; calls: { url: string; method: string; requestBody?: string }[] } {
  const requests = new Map<string, { batchId: string; operationId: string; requestBody: string }>();
  const calls: { url: string; method: string; requestBody?: string }[] = [];
  const client = new OpenRouterBatchClient({
    withRequestOwnership: async (request) => request(),
    readCredentialSnapshot: async () => ({ key: 'fixture-only', generation: 1 }),
    assertCredentialGeneration: (generation) => { if (generation !== 1) throw new Error('Fixture credential generation changed.'); },
    assertBeforeStart: () => undefined,
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { requestBody: init.body } : {}) });
      if (url === OPENROUTER_BATCH_ENDPOINT && method === 'POST') {
        const payload = JSON.parse(String(init?.body ?? '')) as { requests?: { custom_id?: string; body?: unknown }[] };
        const row = payload.requests?.[0];
        if (!row || typeof row.custom_id !== 'string') throw new Error('Unexpected Batch POST payload.');
        const batchId = `batch_test_${row.custom_id}`;
        requests.set(batchId, { batchId, operationId: row.custom_id, requestBody: JSON.stringify(row.body) });
        return new Response(JSON.stringify({ id: batchId, object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'validating', request_counts: { total: 1, completed: 0, failed: 0 } }), { status: 202 });
      }
      if (url.startsWith(`${OPENROUTER_BATCH_ENDPOINT}/`) && method === 'GET') {
        const batchId = decodeURIComponent(url.slice(`${OPENROUTER_BATCH_ENDPOINT}/`.length));
        const request = requests.get(batchId);
        if (!request) throw new Error('Batch GET arrived before the fixture POST.');
        const rawOutput = await responseForRequest(request);
        return new Response(JSON.stringify({ id: request.batchId, object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'completed',
          request_counts: { total: 1, completed: 1, failed: 0 }, usage: { cost: 0.001, prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          results: [{ custom_id: request.operationId, response: { status_code: 200, body: { model: OPENROUTER_BATCH_BODY_MODEL,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(rawOutput) } }] } } }] }), { status: 200 });
      }
      throw new Error(`Unexpected fixture URL or method: ${method} ${url}`);
    },
  });
  return { client, calls };
}

/** Runs the normal persisted Batch workflow without bypassing controller guards. */
export async function completeNoteBatch(
  app: AppControllerImpl,
  noteId: string,
  options: { intent?: 'assist' | 'summarize' | 'answer' | 'extract'; question?: string; knowledgeSelection?: KnowledgeSelection } = {},
): Promise<{ job: AssistantBatchJobDTO; analysis: NoteAssistResult }> {
  const queued = await app.submitNoteBatch(noteId, options);
  const completed = await app.refreshAssistantBatch(queued.id);
  if (completed.status !== 'completed') throw new Error(`The fake assistant Batch did not complete: ${completed.status}.`);
  const analysis = app.getSnapshot().notes.find((note) => note.id === noteId)?.analysis;
  if (!analysis) throw new Error('The completed fake Batch did not persist its analysis.');
  return { job: completed, analysis };
}
