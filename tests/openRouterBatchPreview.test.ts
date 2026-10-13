import { afterEach, describe, expect, it, vi } from 'vitest';

describe('closed OpenRouter Batch preview fixture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('boots the real controller and counts one explicit submission plus explicit checks', async () => {
    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_PREVIEW_SCENARIO', 'openrouter-batch');
    const { createOpenRouterBatchPreview } = await import('../src/dev/openRouterBatchPreview');
    const fixture = await createOpenRouterBatchPreview();
    const initial = fixture.controller.getSnapshot();
    const note = initial.notes[0];
    expect(note).toBeDefined();

    const queued = await fixture.controller.submitNoteBatch(note.id);
    expect(queued.status).toBe('queued');
    expect(fixture.getMetrics()).toEqual({ postCount: 1, getCount: 0 });

    const processing = await fixture.controller.refreshAssistantBatch(queued.id);
    expect(processing.status).toBe('processing');
    const completed = await fixture.controller.refreshAssistantBatch(queued.id);
    expect(completed.status).toBe('completed');
    expect(completed.providerReportedCostUsd).toBe(0);
    expect(completed.promptTokens).toBe(41);
    expect(completed.completionTokens).toBe(12);
    expect(fixture.getMetrics()).toEqual({ postCount: 1, getCount: 2 });
  });
});
