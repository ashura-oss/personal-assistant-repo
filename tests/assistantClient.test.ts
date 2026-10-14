import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../src/core';
import { AssistantClientRouter } from '../src/services/assistantClient';

describe('immediate assistant client routing', () => {
  it.each(['azure', 'openrouter', 'unknown', undefined])('never falls back to an immediate paid provider for llmProvider=%s', async (llmProvider) => {
    const prepare = vi.fn(async () => ({}));
    const analyze = vi.fn(async () => ({}));
    const generateReply = vi.fn(async () => ({}));
    const router = new AssistantClientRouter({ prepare, analyze, generateReply } as never);
    const settings = { mode: 'provider', llmProvider } as AppSettings;

    await expect(router.analyze({} as never, [], settings)).rejects.toThrow(/explicit Batch workflow/i);
    await expect(router.generateReply({} as never, settings)).rejects.toThrow(/explicit Batch workflow/i);
    await expect(router.prepare({} as never, [], settings)).resolves.toEqual({});
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(analyze).not.toHaveBeenCalled();
    expect(generateReply).not.toHaveBeenCalled();
  });
});
