import { afterEach, describe, expect, it } from 'vitest';

describe('closed OpenRouter Chat preview', () => {
  const priorScenario = process.env.EXPO_PUBLIC_PREVIEW_SCENARIO;
  const priorDev = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');

  afterEach(() => {
    if (priorScenario === undefined) delete process.env.EXPO_PUBLIC_PREVIEW_SCENARIO;
    else process.env.EXPO_PUBLIC_PREVIEW_SCENARIO = priorScenario;
    if (priorDev) Object.defineProperty(globalThis, '__DEV__', priorDev);
    else delete (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__;
  });

  it('uses completed context only and tolerates replies completing out of submission order', async () => {
    process.env.EXPO_PUBLIC_PREVIEW_SCENARIO = 'openrouter-chat';
    Object.defineProperty(globalThis, '__DEV__', { value: true, configurable: true });
    const { createOpenRouterChatPreview } = await import('../src/dev/openRouterBatchPreview');
    const fixture = await createOpenRouterChatPreview();
    const firstConversation = await fixture.controller.createChatConversation('Sample conversation');
    const first = await fixture.controller.submitChatTurn({ conversationId: firstConversation.id, text: 'What should I prepare?' });
    const second = await fixture.controller.submitChatTurn({ conversationId: firstConversation.id, text: 'What happens next?' });

    expect(first.kind).toBe('accepted');
    expect(second.kind).toBe('accepted');
    expect(first.jobId).not.toBe(second.jobId);
    expect(fixture.controller.getSnapshot().assistantChatConversations?.[0].turns).toHaveLength(2);
    expect(fixture.getMetrics()).toEqual({ postCount: 2, getCount: 0 });

    expect((await fixture.controller.refreshAssistantBatch(first.jobId)).status).toBe('processing');
    expect((await fixture.controller.refreshAssistantBatch(second.jobId)).status).toBe('processing');
    expect((await fixture.controller.refreshAssistantBatch(second.jobId)).status).toBe('completed');
    expect(fixture.controller.getSnapshot().assistantChatConversations?.[0].turns[1].reply?.answer).toBe('This is a simulated Batch reply.');

    const third = await fixture.controller.submitChatTurn({ conversationId: firstConversation.id, text: 'Use only an eligible earlier answer.' });
    expect(third.kind).toBe('accepted');
    const thirdMessages = JSON.stringify(fixture.getSubmittedMessages()[2]);
    expect(thirdMessages).toContain('What happens next?');
    expect(thirdMessages).toContain('This is a simulated Batch reply.');
    expect(thirdMessages).not.toContain('What should I prepare?');

    expect((await fixture.controller.refreshAssistantBatch(first.jobId)).status).toBe('completed');
    const fourth = await fixture.controller.submitChatTurn({ conversationId: firstConversation.id, text: 'Now use both completed replies.' });
    expect(fourth.kind).toBe('accepted');
    const fourthMessages = JSON.stringify(fixture.getSubmittedMessages()[3]);
    expect(fourthMessages.indexOf('What should I prepare?')).toBeGreaterThanOrEqual(0);
    expect(fourthMessages.indexOf('What should I prepare?')).toBeLessThan(fourthMessages.indexOf('What happens next?'));
    expect(fixture.getMetrics()).toEqual({ postCount: 4, getCount: 4 });
  });

  it('runs one simulated Think more Batch request after an explicitly checked completed answer', async () => {
    process.env.EXPO_PUBLIC_PREVIEW_SCENARIO = 'openrouter-chat';
    Object.defineProperty(globalThis, '__DEV__', { value: true, configurable: true });
    const { createOpenRouterChatPreview } = await import('../src/dev/openRouterBatchPreview');
    const fixture = await createOpenRouterChatPreview();
    const conversation = await fixture.controller.createChatConversation('Sample refinement');
    const original = await fixture.controller.submitChatTurn({ conversationId: conversation.id, text: 'Give a fictional concise answer.' });
    expect((await fixture.controller.refreshAssistantBatch(original.jobId)).status).toBe('processing');
    expect((await fixture.controller.refreshAssistantBatch(original.jobId)).status).toBe('completed');

    const parent = fixture.controller.getSnapshot().assistantChatConversations?.[0].turns[0];
    expect(parent?.reply?.answer).toBe('This is a simulated Batch reply.');
    const refinement = await fixture.controller.refineChatTurn({
      conversationId: conversation.id,
      parentTurnId: original.turnId,
      effort: 'high',
    });
    expect(refinement.kind).toBe('accepted');
    expect((await fixture.controller.refreshAssistantBatch(refinement.jobId)).status).toBe('processing');
    expect((await fixture.controller.refreshAssistantBatch(refinement.jobId)).status).toBe('completed');

    const turns = fixture.controller.getSnapshot().assistantChatConversations?.[0].turns;
    expect(turns).toHaveLength(2);
    expect(turns?.[1]).toMatchObject({
      operation: 'chat_refinement',
      reasoningEffort: 'high',
      parentTurnId: original.turnId,
      userText: 'Give a fictional concise answer.',
      reply: { answer: 'This is a simulated Batch reply.' },
      job: { costStatus: 'reported', providerReportedCostUsd: 0, promptTokens: 41, completionTokens: 12 },
    });
    expect(fixture.getMetrics()).toEqual({ postCount: 2, getCount: 4 });
    expect(fixture.getSubmittedMessages()).toHaveLength(2);
  });
});
