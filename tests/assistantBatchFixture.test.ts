import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { completeNoteBatch, createCompletedAssistantBatchClient } from './helpers/assistantBatchFixture';

class MemoryStore implements StateStore {
  value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

async function setup(responseForRequest?: Parameters<typeof createCompletedAssistantBatchClient>[0]) {
  const store = new MemoryStore();
  const transport = createCompletedAssistantBatchClient(responseForRequest);
  const app = new AppControllerImpl(store, {}, { openRouterBatchClient: transport.client });
  await app.load();
  await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter' });
  const note = await app.saveNote({ transcript: 'Keep the batch request local to this test.' });
  return { app, note, calls: transport.calls };
}

describe('paid text Batch fixture', () => {
  it('uses one real Batch-client POST and one GET, then persists a validated result through the public controller flow', async () => {
    const { app, note, calls } = await setup();
    const { job, analysis } = await completeNoteBatch(app, note.id);
    expect(job.status).toBe('completed');
    expect(analysis.summary).toBe('A concise local Batch result.');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });

  it('keeps invalid raw model output on the normal rejection path after the same single POST and GET', async () => {
    const { app, note, calls } = await setup(() => ({ summary: 12 } as never));
    const queued = await app.submitNoteBatch(note.id);
    const completed = await app.refreshAssistantBatch(queued.id);
    expect(completed.status).toBe('result_invalid');
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.analysis).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });
});
