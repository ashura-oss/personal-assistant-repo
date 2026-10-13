import { describe, expect, it, vi } from 'vitest';
import * as Crypto from 'expo-crypto';
import { assistantResponseSchema } from '../src/assistant';
import { AppControllerImpl } from '../src/services/controller';
import { OpenRouterBatchClient, OpenRouterBatchRequestBuilder, OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_CHAT_COMPLETIONS_PATH, type OpenRouterBatchInspection } from '../src/services/openRouter';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';

class MemoryStore implements StateStore {
  value?: AppState;
  saves = 0;
  failAfterCommit = false;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.saves += 1;
    this.value = structuredClone(state);
    if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('fixture lost the save acknowledgement'); }
  }
  async clear() { this.value = undefined; }
}

function client() {
  return new OpenRouterBatchClient({
    withRequestOwnership: async (actual) => actual(),
    fetcher: async () => new Response(JSON.stringify({
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'validating',
      request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 }),
    readCredentialSnapshot: async () => ({ key: 'fixture-only', generation: 1 }),
    assertCredentialGeneration: () => undefined,
    assertBeforeStart: () => undefined,
  });
}

function acceptedBatch(id: string) {
  return new Response(JSON.stringify({ id, object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'validating',
    request_counts: { total: 1, completed: 0, failed: 0 } }), { status: 202 });
}

async function fakeSubmit(
  batchId: string,
  _input: { operationId: string; requestBody: string },
  onBeforeDispatch: () => Promise<void>,
  assertBeforeStart: () => void,
) {
  await onBeforeDispatch();
  assertBeforeStart();
  return { batchId, status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
}

function completedInspection(customId: string, content = JSON.stringify({
  summary: 'A concise summary.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
})): OpenRouterBatchInspection {
  return {
    batchId: 'batch_completed_fixture', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0,
    metadataValidation: 'valid', resultValidation: 'valid',
    usage: { cost: 0.001, promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    result: { customId, statusCode: 200, finishReason: 'stop', responseBody: {
      model: OPENROUTER_BATCH_BODY_MODEL,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    } },
  };
}

describe('OpenRouter Batch controller lifecycle', () => {
  it('freezes Chat replies by reply digest, reuses only the saved prior context, and deletes its content-free receipts', async () => {
    const postedBodies: Record<string, unknown>[] = [];
    const fakeClient = {
      submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before();
        assert();
        postedBodies.push(JSON.parse(input.requestBody) as Record<string, unknown>);
        return { batchId: `batch_chat_${postedBodies.length}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({
        summary: 'Bring the draft outline.', answer: 'Bring the outline and a question for the team.', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      })), batchId }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const conversation = await app.createChatConversation('Planning');
    const first = await app.submitChatTurn({ conversationId: conversation.id, text: 'What should I bring?' });
    const outOfOrder = await app.submitChatTurn({ conversationId: conversation.id, text: 'What is the follow-up?' });
    let persisted = store.value as AppState & { assistantChatLedger: { conversations: { turns: { replySha256: string; reply: { requestSha256: string } }[] }[] }; openRouterBatchLedger: { jobs: { id: string; requestSha256: string; chatBinding?: { context: { replySha256: string }[] } }[] } };
    const outOfOrderJob = persisted.openRouterBatchLedger.jobs.find((job) => job.id === outOfOrder.jobId);
    expect(outOfOrderJob?.chatBinding?.context).toHaveLength(0);
    expect(JSON.stringify(postedBodies[1])).not.toContain('What should I bring?');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 20 * 60_000));
    const firstResult = await app.refreshAssistantBatch(first.jobId);
    expect(firstResult.status).toBe('completed');
    vi.useRealTimers();

    persisted = store.value as typeof persisted;
    const firstTurn = persisted.assistantChatLedger.conversations[0]?.turns[0];
    expect(firstTurn?.replySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(firstTurn?.replySha256).not.toBe(firstTurn?.reply.requestSha256);

    const second = await app.submitChatTurn({ conversationId: conversation.id, text: 'Anything else?' });
    persisted = store.value as typeof persisted;
    const secondJob = persisted.openRouterBatchLedger.jobs.find((job) => job.id === second.jobId);
    expect(secondJob?.chatBinding?.context).toHaveLength(1);
    expect(secondJob?.chatBinding?.context[0]?.replySha256).toBe(firstTurn?.replySha256);
    const secondMessages = (postedBodies[2]?.messages as { content: string }[] | undefined) ?? [];
    expect(secondMessages.some((message) => message.content.includes('What should I bring?'))).toBe(true);
    expect(secondMessages.some((message) => message.content.includes('Bring the outline and a question for the team.'))).toBe(true);
    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.reply).not.toHaveProperty('requestSha256');

    await app.deleteChatConversation(conversation.id);
    const deleted = store.value as AppState & { assistantChatLedger: { conversations: unknown[] }; openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
    expect(deleted.assistantChatLedger.conversations).toHaveLength(0);
    expect(deleted.notes.filter((note) => note.origin === 'assistant_chat')).toHaveLength(0);
    expect(deleted.openRouterBatchLedger.jobs.every((job) => job.status === 'source_removed' && !('requestBody' in job) && !('chatBinding' in job))).toBe(true);
    expect(JSON.stringify(deleted)).not.toContain('What should I bring?');
    expect(JSON.stringify(deleted)).not.toContain('Bring the outline and a question for the team.');
  });

  it('does not claim an ambiguously acknowledged Chat save or send again after reload', async () => {
    let posts = 0;
    const fakeClient = { submit: async () => { posts += 1; throw new Error('unexpected dispatch'); } } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const conversation = await app.createChatConversation('Uncertain save');
    store.failAfterCommit = true;
    await expect(app.submitChatTurn({ conversationId: conversation.id, text: 'CANARY durable turn' })).rejects.toThrow(/acknowledgement/i);
    expect(posts).toBe(0);

    const reloaded = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await reloaded.load();
    expect(reloaded.getSnapshot().assistantChatConversations?.[0]?.turns).toHaveLength(1);
    expect(reloaded.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.job?.status).toBe('failed');
    expect(posts).toBe(0);
  });

  it('quarantines a malformed Chat ledger and hides its synthetic notes', async () => {
    const store = new MemoryStore();
    const seed = new AppControllerImpl(store, {});
    await seed.load();
    store.value = {
      ...store.value!,
      notes: [{ id: '20000000-0000-4000-8000-000000000010', title: 'Chat message', transcript: 'CANARY hidden chat', durationSeconds: 0,
        createdAt: '2026-10-13T10:00:00.000Z', capturedAt: '2026-10-13T10:00:00.000Z', captureTimeZone: 'UTC', status: 'recorded', revision: 1, origin: 'assistant_chat' }],
      assistantChatLedger: { version: 1, conversations: [], unexpected: 'private malformed data' },
    } as AppState;
    const app = new AppControllerImpl(store, {});
    await app.load();
    expect(app.getSnapshot().notes.some((note) => note.origin === 'assistant_chat')).toBe(false);
    expect(app.getSnapshot().assistantChatConversations).toEqual([]);
    expect(app.getSnapshot().assistantChatRecoveryStatus?.blocked).toBe(true);
    await expect(app.createChatConversation('Blocked')).rejects.toThrow(/validated/i);
  });

  it('recomputes immutable Chat reply digests on reload and preserves tampered raw history privately', async () => {
    const store = new MemoryStore();
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_chat_digest', input, before, assert),
      inspect: async (_batchId: string, customId: string) => completedInspection(customId, JSON.stringify({
        summary: 'Verified summary.', answer: 'VERIFIED_CHAT_REPLY', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      })),
    } as unknown as OpenRouterBatchClient;
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const conversation = await app.createChatConversation('Digest check');
    const accepted = await app.submitChatTurn({ conversationId: conversation.id, text: 'Summarize this.' });
    await app.refreshAssistantBatch(accepted.jobId);

    const intact = new AppControllerImpl(store);
    await intact.load();
    expect(intact.getSnapshot().assistantChatRecoveryStatus?.blocked).not.toBe(true);
    expect(intact.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.reply?.answer).toBe('VERIFIED_CHAT_REPLY');

    const persisted = store.value as AppState & { assistantChatLedger: { conversations: { turns: { reply: { answer: string }; replySha256: string }[] }[] } };
    persisted.assistantChatLedger.conversations[0]!.turns[0]!.reply.answer = 'TAMPERED_CHAT_REPLY';
    store.value = structuredClone(persisted);
    const tampered = new AppControllerImpl(store);
    await tampered.load();
    expect(tampered.getSnapshot().assistantChatRecoveryStatus?.blocked).toBe(true);
    expect(tampered.getSnapshot().assistantChatConversations).toEqual([]);
    expect(tampered.getSnapshot().notes.some((note) => note.origin === 'assistant_chat')).toBe(false);
    const preserved = store.value as typeof persisted;
    expect(preserved.assistantChatLedger.conversations[0]?.turns[0]?.reply.answer).toBe('TAMPERED_CHAT_REPLY');
    expect(preserved.assistantChatLedger.conversations[0]?.turns[0]?.replySha256).toBe(persisted.assistantChatLedger.conversations[0]?.turns[0]?.replySha256);
  });

  it('does not let a rejected old reply digest quarantine or publish into a replacement workspace', async () => {
    const store = new MemoryStore();
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_chat_stale_digest', input, before, assert),
      inspect: async (_batchId: string, customId: string) => completedInspection(customId, JSON.stringify({
        summary: 'Stable summary.', answer: 'DEFERRED_DIGEST_REPLY', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      })),
    } as unknown as OpenRouterBatchClient;
    const seed = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await seed.load();
    await seed.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const conversation = await seed.createChatConversation('Stale digest load');
    const accepted = await seed.submitChatTurn({ conversationId: conversation.id, text: 'Keep the current workspace.' });
    await seed.refreshAssistantBatch(accepted.jobId);

    const replacement = new AppControllerImpl(store);
    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    let releaseDigest!: () => void;
    let reachedDigest!: () => void;
    const digestStarted = new Promise<void>((resolve) => { reachedDigest = resolve; });
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const spy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (algorithm, value, options) => {
      if (typeof value === 'string' && value.includes('DEFERRED_DIGEST_REPLY')) {
        reachedDigest();
        await digestGate;
        throw new Error('digest failed after workspace disposal');
      }
      return originalDigest(algorithm, value, options);
    });
    try {
      const loading = replacement.load();
      await digestStarted;
      await replacement.disposeForPrivacy();
      releaseDigest();
      await expect(loading).rejects.toThrow(/workspace changed|privacy/i);
      expect(replacement.getSnapshot().notes).toHaveLength(0);
      expect(replacement.getSnapshot().assistantChatRecoveryStatus?.blocked).not.toBe(true);
      expect(replacement.getSnapshot().assistantChatConversations ?? []).toHaveLength(0);
    } finally {
      releaseDigest();
      spy.mockRestore();
    }
  });

  it('keeps a grounded Chat task proposal actionable after a delayed Batch reply', async () => {
    const store = new MemoryStore();
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_chat_delayed_action', input, before, assert),
      inspect: async (_batchId: string, customId: string) => completedInspection(customId, JSON.stringify({
        summary: 'Prepare the outline.', answer: 'Prepare a short outline before the meeting.', decisions: [], citations: [], clarifications: [],
        proposals: [{ kind: 'task', title: 'Prepare the outline', body: 'Bring a short outline to the meeting.', recipients: [], dueAt: null,
          evidence: ['Please prepare a short outline.'] }], memorySuggestions: [],
      })),
    } as unknown as OpenRouterBatchClient;
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const conversation = await app.createChatConversation('Delayed action');
    const accepted = await app.submitChatTurn({ conversationId: conversation.id, text: 'Please prepare a short outline.' });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 20 * 60_000));
    try {
      expect((await app.refreshAssistantBatch(accepted.jobId)).status).toBe('completed');
      const proposal = app.getSnapshot().proposals.find((item) => item.kind === 'task');
      expect(proposal).toBeDefined();
      expect(proposal?.provenance).toMatchObject({ capturedAt: app.getSnapshot().notes.find((note) => note.id === proposal?.noteId)?.capturedAt });
      expect(proposal?.provenance).not.toHaveProperty('answeredAsOf');
      expect(proposal?.provenance).not.toHaveProperty('expiresAt');
      const approved = await app.approveProposal(proposal!.id, { expectedRevision: proposal!.revision });
      expect(approved.status).toBe('approved');
      const executed = await app.executeProposal(approved.id, { expectedRevision: approved.revision });
      expect(executed.status).toBe('executed');
      expect(app.getSnapshot().tasks.some((task) => task.title === 'Prepare the outline')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a Chat child task when an ancestor source changes without an explicit analysis refresh', async () => {
    let inspectionNumber = 0;
    const store = new MemoryStore();
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit(`batch_chat_ancestor_${input.operationId}`, input, before, assert),
      inspect: async (_batchId: string, customId: string) => {
        inspectionNumber += 1;
        const response = inspectionNumber === 1
          ? { summary: 'Source summary.', answer: 'The source describes a planning checklist.', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] }
          : { summary: 'A task was suggested.', answer: 'Prepare a short outline.', decisions: [], citations: [], clarifications: [],
              proposals: [{ kind: 'task', title: 'Prepare a short outline', body: 'Bring the outline.', recipients: [], dueAt: null,
                evidence: ['Please prepare an outline.'] }], memorySuggestions: [] };
        return completedInspection(customId, JSON.stringify(response));
      },
    } as unknown as OpenRouterBatchClient;
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: 'Current planning source details.' });
    const conversation = await app.createChatConversation('Ancestor validation');
    const first = await app.submitChatTurn({ conversationId: conversation.id, text: 'Summarize this source.', knowledgeSelection: [{ kind: 'person', id: person.id }] });
    expect((await app.refreshAssistantBatch(first.jobId)).status).toBe('completed');
    const child = await app.submitChatTurn({ conversationId: conversation.id, text: 'Please prepare an outline.' });
    expect((await app.refreshAssistantBatch(child.jobId)).status).toBe('completed');
    const proposal = app.getSnapshot().proposals.find((item) => item.kind === 'task');
    expect(proposal).toBeDefined();

    const currentPerson = app.getSnapshot().knowledge.people.find((item) => item.id === person.id)!;
    await app.setKnowledgeEntityArchived({ kind: 'person', id: person.id, expectedRevision: currentPerson.revision, archived: true });
    await expect(app.approveProposal(proposal!.id, { expectedRevision: proposal!.revision })).rejects.toThrow(/source|context|selection/i);
  });

  it('saves a one-time job before POST, then strips removed note/request text in the same deletion save', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client() });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven CANARY_PRIVATE_TRANSCRIPT' });

    const queued = await app.submitNoteBatch(note.id, { intent: 'answer', question: 'CANARY_PRIVATE_QUESTION' });
    expect(queued).toMatchObject({ status: 'queued', kind: 'note_assistance', noteId: note.id });
    expect(queued.id).toMatch(/^[0-9a-f-]{36}$/);
    const beforeDelete = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(beforeDelete.openRouterBatchLedger.jobs[0]).toMatchObject({ customId: queued.id, batchId: 'batch_fixture_1' });
    expect(String(beforeDelete.openRouterBatchLedger.jobs[0]?.requestBody)).toContain('CANARY_PRIVATE_QUESTION');

    await app.deleteNote(note.id);
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.notes.some((row) => row.id === note.id)).toBe(false);
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ id: queued.id, customId: queued.id, batchId: 'batch_fixture_1', sourceRemoved: true, status: 'source_removed' });
    expect(saved.openRouterBatchLedger.jobs[0]).not.toHaveProperty('requestBody');
    expect(saved.openRouterBatchLedger.jobs[0]).not.toHaveProperty('question');
    expect(JSON.stringify(saved)).not.toContain('CANARY_PRIVATE_TRANSCRIPT');
    expect(JSON.stringify(saved)).not.toContain('CANARY_PRIVATE_QUESTION');
    expect(app.getSnapshot().assistantBatchJobs?.[0]).toMatchObject({ status: 'source_removed', sourceRemoved: true });
  });

  it('does not allow source deletion while a submitted provider operation still owns its request', async () => {
    let finishResponse!: (response: Response) => void;
    const requestResponse = new Promise<Response>((resolve) => { finishResponse = resolve; });
    const pendingClient = new OpenRouterBatchClient({
      withRequestOwnership: async (actual) => actual(),
      fetcher: async () => requestResponse,
      readCredentialSnapshot: async () => ({ key: 'fixture-only', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: pendingClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven ACTIVE_PRIVATE_SOURCE' });
    const queued = app.submitNoteBatch(note.id);
    await expect(app.deleteNote(note.id)).rejects.toThrow(/still using this note/i);
    finishResponse(new Response(JSON.stringify({
      id: 'batch_fixture_2', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'validating',
      request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 }));
    await queued;
    await app.deleteNote(note.id);
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'source_removed', sourceRemoved: true });
    expect(JSON.stringify(saved)).not.toContain('ACTIVE_PRIVATE_SOURCE');
  });

  it('keeps a pre-dispatch failure terminal and does not block a later explicit attempt', async () => {
    const fetcher = vi.fn(async () => new Response('unused', { status: 500 }));
    const noKey = new OpenRouterBatchClient({
      withRequestOwnership: async (actual) => actual(),
      fetcher: fetcher as unknown as typeof fetch,
      readCredentialSnapshot: async () => ({ key: null, generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: noKey });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven safe preflight' });

    await expect(app.submitNoteBatch(note.id)).rejects.toThrow(/configure an OpenRouter API key/i);
    const afterFailure = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(afterFailure.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'failed', failureCode: 'not_submitted', unknownCharge: false });
    expect(afterFailure.openRouterBatchLedger.jobs[0]).not.toHaveProperty('batchId');
    await expect(app.submitNoteBatch(note.id)).rejects.toThrow(/configure an OpenRouter API key/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: unknown[] } })).openRouterBatchLedger.jobs).toHaveLength(2);
  });

  it('does not replay a one-POST submission after an ambiguous acknowledgement and reload', async () => {
    const firstFetch = vi.fn(async () => new Response('ambiguous acknowledgement', { status: 202 }));
    const lostAckClient = new OpenRouterBatchClient({
      withRequestOwnership: async (actual) => actual(),
      fetcher: firstFetch as unknown as typeof fetch,
      readCredentialSnapshot: async () => ({ key: 'fictional-key', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: lostAckClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven ambiguous acknowledgement' });
    await expect(app.submitNoteBatch(note.id)).rejects.toThrow(/outcome is unknown/i);
    expect(firstFetch).toHaveBeenCalledOnce();
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } })).openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'submission_unknown', unknownCharge: true });

    const replayFetch = vi.fn(async () => acceptedBatch('must_not_be_replayed'));
    const replayClient = new OpenRouterBatchClient({
      withRequestOwnership: async (actual) => actual(),
      fetcher: replayFetch as unknown as typeof fetch,
      readCredentialSnapshot: async () => ({ key: 'fictional-key', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const restarted = new AppControllerImpl(store, {}, { openRouterBatchClient: replayClient });
    await restarted.load();
    await expect(restarted.submitNoteBatch(note.id)).rejects.toThrow(/unfinished Batch job/i);
    expect(replayFetch).not.toHaveBeenCalled();
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: unknown[] } })).openRouterBatchLedger.jobs).toHaveLength(1);
  });

  it('shows the provider in-progress state as processing', async () => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_in_progress', input, before, assert),
      inspect: async () => ({ batchId: 'batch_in_progress', status: 'in_progress', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
        model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0,
        metadataValidation: 'valid', resultValidation: 'unavailable' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven provider still working' });
    const job = await app.submitNoteBatch(note.id);
    expect((await app.refreshAssistantBatch(job.id)).status).toBe('processing');
  });

  it('applies one valid completed result and makes repeated checks idempotent', async () => {
    let inspectCalls = 0;
    const longSummary = 's'.repeat(3001);
    const longAnswer = 'a'.repeat(6001);
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_completed_fixture', input, before, assert),
      inspect: async (_batchId: string, customId: string) => { inspectCalls += 1; return completedInspection(customId, JSON.stringify({ summary: longSummary, answer: longAnswer, decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] })); },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven apply this completed result' });
    const job = await app.submitNoteBatch(note.id);

    const first = await app.refreshAssistantBatch(job.id);
    const firstSaved = structuredClone(store.value!) as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
    const appliedNote = firstSaved.notes.find((row) => row.id === note.id)!;
    expect(first).toMatchObject({ status: 'completed', providerReportedCostUsd: 0.001, promptTokens: 12, completionTokens: 5 });
    expect(appliedNote.analysis?.summary).toBe(longSummary);
    expect(appliedNote.analysis?.answer).toBe(longAnswer);
    expect(firstSaved.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'completed', appliedNoteRevision: appliedNote.revision, accounting: { providerReportedCostUsd: 0.001 } });

    const second = await app.refreshAssistantBatch(job.id);
    expect(second).toEqual(first);
    expect(inspectCalls).toBe(1);
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: unknown[] } })).openRouterBatchLedger.jobs).toHaveLength(1);
  });

  it.each([
    ['incomplete JSON', '{"summary":'],
    ['finish reason length', JSON.stringify({ summary: 'partial', answer: 'partial', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] })],
  ])('does not apply %s from a completed provider row', async (caseName, content) => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit(`batch_invalid_${caseName.replace(/\W/g, '')}`, input, before, assert),
      inspect: async (_batchId: string, customId: string) => {
        const result = completedInspection(customId, content);
        return caseName === 'finish reason length' ? {
          ...result, result: { ...result.result!, finishReason: 'length', responseBody: { model: OPENROUTER_BATCH_BODY_MODEL,
            choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content } }] } },
        } : result;
      },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: `one two three four five six seven ${caseName}` });
    const job = await app.submitNoteBatch(note.id);
    expect((await app.refreshAssistantBatch(job.id)).status).toBe('result_invalid');
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
  });

  it('restores and applies a saved profile-1 request using its original bounded schema', async () => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_v1_restore', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...completedInspection(customId), batchId: 'batch_v1_restore' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const first = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await first.load();
    await first.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await first.saveNote({ transcript: 'one two three four five six seven restore legacy profile' });
    const queued = await first.submitNoteBatch(note.id);
    const persisted = store.value as AppState & { openRouterBatchLedger: { version: 1; jobs: Record<string, unknown>[] } };
    const job = persisted.openRouterBatchLedger.jobs[0]!;
    const legacyBody = JSON.parse(String(job.requestBody)) as { response_format: { json_schema: { schema: unknown } } };
    legacyBody.response_format.json_schema.schema = assistantResponseSchema;
    const requestBody = JSON.stringify(legacyBody);
    Object.assign(job, {
      requestProfileVersion: 1, requestBody, requestBytes: new TextEncoder().encode(requestBody).byteLength,
      requestSha256: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, requestBody, { encoding: Crypto.CryptoEncoding.HEX }),
    });

    const restored = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await restored.load();
    expect(restored.getSnapshot().assistantBatchJobs?.[0]).toMatchObject({ id: queued.id, status: 'queued' });
    expect((await restored.refreshAssistantBatch(queued.id)).status).toBe('completed');
    expect(store.value?.notes.find((item) => item.id === note.id)?.analysis?.summary).toBe('A concise summary.');
  });

  it('keeps only the paid accounting receipt when the complete applied snapshot would exceed 16 MiB', async () => {
    let inspectCalls = 0;
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_oversized_reply', input, before, assert),
      inspect: async (_batchId: string, customId: string) => {
        inspectCalls += 1;
        const content = JSON.stringify({ summary: 's'.repeat(3001), answer: 'a'.repeat(16_770_000), decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] });
        return { ...completedInspection(customId, content), batchId: 'batch_oversized_reply' };
      },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven paid oversized result' });
    const job = await app.submitNoteBatch(note.id);

    const result = await app.refreshAssistantBatch(job.id);
    const saved = store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
    expect(result).toMatchObject({ status: 'result_not_retained', failureCode: 'result_not_retained', providerReportedCostUsd: 0.001, unknownCharge: false, canCheck: false });
    expect(saved.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'result_not_retained', failureCode: 'result_not_retained', accounting: { providerReportedCostUsd: 0.001 } });
    expect(JSON.stringify(saved)).not.toContain('a'.repeat(4096));
    expect(await app.refreshAssistantBatch(job.id)).toEqual(result);
    expect(inspectCalls).toBe(1);
  });

  it('does not settle or apply a completed result after the workspace changes during source hashing', async () => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_hash_race', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...completedInspection(customId), batchId: 'batch_hash_race' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven deferred source hash' });
    const job = await app.submitNoteBatch(note.id);

    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    let releaseDigest!: () => void;
    let reachedDigest!: () => void;
    const digestStarted = new Promise<void>((resolve) => { reachedDigest = resolve; });
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    let firstDigest = true;
    const spy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (...args) => {
      if (firstDigest) {
        firstDigest = false;
        reachedDigest();
        await digestGate;
      }
      return originalDigest(...args);
    });
    try {
      const settling = app.refreshAssistantBatch(job.id);
      await digestStarted;
      await app.saveSettings({ openRouterReasoningEffort: 'none' });
      releaseDigest();
      await expect(settling).rejects.toThrow(/earlier workspace session|changed during inspection/i);
    } finally {
      releaseDigest();
      spy.mockRestore();
    }
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect((store.value as AppState & { openRouterBatchLedger: { jobs: { status: string }[] } }).openRouterBatchLedger.jobs[0]?.status).toBe('queued');
  });

  it('does not enter result application when the workspace changes during the exact source-version digest', async () => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_source_hash_race', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...completedInspection(customId), batchId: 'batch_source_hash_race' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven source version digest race' });
    const job = await app.submitNoteBatch(note.id);
    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    let changedDuringSourceDigest = false;
    const spy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (algorithm, value, options) => {
      if (!changedDuringSourceDigest && typeof value === 'string' && value.includes('"transcript"')) {
        changedDuringSourceDigest = true;
        await app.saveSettings({ openRouterReasoningEffort: 'none' });
      }
      return originalDigest(algorithm, value, options);
    });
    try {
      await expect(app.refreshAssistantBatch(job.id)).rejects.toThrow(/earlier workspace session|changed during inspection/i);
    } finally {
      spy.mockRestore();
    }
    expect(changedDuringSourceDigest).toBe(true);
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect((store.value as AppState & { openRouterBatchLedger: { jobs: { status: string }[] } }).openRouterBatchLedger.jobs[0]?.status).toBe('queued');
  });

  it('retains actual usage when structured output is invalid and never applies it', async () => {
    let inspectCalls = 0;
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_invalid_fixture', input, before, assert),
      inspect: async (_batchId: string, customId: string) => { inspectCalls += 1; return { ...completedInspection(customId, '{"unexpected":"shape"}'), batchId: 'batch_invalid_fixture' }; },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven invalid structured response' });
    const job = await app.submitNoteBatch(note.id);

    const result = await app.refreshAssistantBatch(job.id);
    expect(result).toMatchObject({ status: 'result_invalid', providerReportedCostUsd: 0.001, costStatus: 'reported' });
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect(inspectCalls).toBe(1);
    expect((await app.refreshAssistantBatch(job.id))).toEqual(result);
    expect(inspectCalls).toBe(1);
  });

  it('allows a later explicit usage check for a terminal invalid result without applying it', async () => {
    let inspectCalls = 0;
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_delayed_usage', input, before, assert),
      inspect: async (_batchId: string, customId: string) => {
        inspectCalls += 1;
        const inspection = completedInspection(customId, '{"not":"assistant output"}');
        return { ...inspection, batchId: 'batch_delayed_usage', usage: inspectCalls === 1 ? undefined : { cost: 0.003 } };
      },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven delayed accounting' });
    const job = await app.submitNoteBatch(note.id);

    const invalid = await app.refreshAssistantBatch(job.id);
    expect(invalid).toMatchObject({ status: 'result_invalid', costStatus: 'unavailable', canCheck: true });
    const accounting = await app.refreshAssistantBatch(job.id);
    expect(accounting).toMatchObject({ status: 'result_invalid', providerReportedCostUsd: 0.003, costStatus: 'reported', canCheck: false });
    expect(inspectCalls).toBe(2);
    expect(store.value?.notes.find((row) => row.id === note.id)?.analysis).toBeUndefined();
    expect((store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } })).openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'result_invalid', accounting: { providerReportedCostUsd: 0.003 } });
  });

  it.each([
    ['unrelated Azure setting', { openAiEndpoint: 'https://other.openai.azure.com' }, 'completed'],
    ['OpenRouter request profile', { openRouterReasoningEffort: 'none' as const }, 'result_stale'],
  ] as const)('uses only the captured OpenRouter profile when settling after %s changes', async (_label, settingsPatch, expectedStatus) => {
    const usage = { cost: 0.002, prompt_tokens: 22, completion_tokens: 8, total_tokens: 30 };
    const responseBody = {
      model: OPENROUTER_BATCH_BODY_MODEL,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        summary: 'A concise summary.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      }) } }],
    };
    const inspection: OpenRouterBatchInspection = {
      batchId: 'batch_inspection_1', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0,
      metadataValidation: 'valid', resultValidation: 'valid', usage,
      result: { customId: '', statusCode: 200, finishReason: 'stop', responseBody },
    };
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_inspection_1', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...inspection, result: { ...inspection.result!, customId } }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven captured note' });
    const job = await app.submitNoteBatch(note.id);
    await app.saveSettings(settingsPatch);

    const settled = await app.refreshAssistantBatch(job.id);
    expect(settled.status).toBe(expectedStatus);
    expect(settled.providerReportedCostUsd).toBe(usage.cost);
    if (expectedStatus === 'completed') {
      const refreshed = await app.refreshAnalysisStatus(note.id);
      expect(refreshed?.stale).not.toBe(true);
    }
  });

  it('does not delete source content when the private Batch ledger is malformed', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'preserve this source when its job receipt is corrupt' });
    const corrupted = structuredClone(store.value!) as AppState & { openRouterBatchLedger: unknown };
    corrupted.openRouterBatchLedger = { version: 1, jobs: [{ requestBody: 'PRIVATE_BATCH_CANARY' }] };
    store.value = corrupted;
    const restarted = new AppControllerImpl(store);
    await restarted.load();

    await expect(restarted.deleteNote(note.id)).rejects.toThrow(/batch history is invalid/i);
    expect(store.value?.notes.some((candidate) => candidate.id === note.id)).toBe(true);
    expect(JSON.stringify(store.value)).toContain('PRIVATE_BATCH_CANARY');
  });

  it('atomically removes captured knowledge narrative text when that narrative is replaced', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client() });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: 'PRIVATE_KNOWLEDGE_NARRATIVE' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven context selection' });
    const queued = await app.submitNoteBatch(note.id, { knowledgeSelection: [{ kind: 'person', id: person.id }] });
    const savedPerson = app.getSnapshot().knowledge.people.find((row) => row.id === person.id)!;
    const narrative = app.getSnapshot().documents.find((row) => row.path === person.narrativePath)!;

    await app.savePerson({ id: person.id, expectedRevision: savedPerson.revision, expectedDocumentRevision: narrative.revision,
      name: 'Maya', aliases: [], narrative: 'Updated local narrative.' });
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ id: queued.id, status: 'source_removed', requestProfileVersion: 2 });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_KNOWLEDGE_NARRATIVE');
  });

  it('atomically tombstones a job whose captured document is replaced', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client() });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const document = await app.saveDocument('research/visit.md', 'Project Phoenix uses PRIVATE_DOCUMENT_CANARY for visit coordination.');
    const note = await app.saveNote({ transcript: 'Discuss Project Phoenix visit coordination with the team.' });
    const queued = await app.submitNoteBatch(note.id, { intent: 'answer', question: 'What identifier does Project Phoenix use for visit coordination?' });
    const storedBefore = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    const versions = storedBefore.openRouterBatchLedger.jobs[0]?.sourceVersions as Record<string, string> | undefined;
    expect(versions?.['doc:research/visit.md']).toBeDefined();

    await app.saveDocument(document.path, 'Project Phoenix identifier was removed.', { expectedRevision: document.revision });
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ id: queued.id, status: 'source_removed', requestProfileVersion: 2 });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_DOCUMENT_CANARY');
  });

  it('redacts only source-dependent Chat replies and descendants when a captured document changes', async () => {
    const posted: string[] = [];
    let submitted = 0;
    const fakeClient = {
      submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert(); posted.push(input.requestBody); submitted += 1;
        return { batchId: `batch_chat_redaction_${submitted}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
      },
      inspect: async (_batchId: string, customId: string) => completedInspection(customId, JSON.stringify({
        summary: 'Private summary.', answer: 'PRIVATE_CHAT_REPLY_CANARY', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      })),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: 'PRIVATE_CHAT_SOURCE_CANARY' });
    const conversation = await app.createChatConversation('Source dependent');
    const first = await app.submitChatTurn({ conversationId: conversation.id, text: 'What does this source say?', knowledgeSelection: [{ kind: 'person', id: person.id }] });
    expect(posted[0]).toContain('PRIVATE_CHAT_SOURCE_CANARY');
    const independent = await app.submitChatTurn({ conversationId: conversation.id, text: 'A separate question before the first reply.' });
    expect(posted[1]).not.toContain('PRIVATE_CHAT_SOURCE_CANARY');
    expect(posted[1]).not.toContain('PRIVATE_CHAT_REPLY_CANARY');
    expect((await app.refreshAssistantBatch(first.jobId)).status).toBe('completed');
    const second = await app.submitChatTurn({ conversationId: conversation.id, text: 'What did you say before?' });
    expect(posted[2]).toContain('PRIVATE_CHAT_REPLY_CANARY');
    expect((await app.refreshAssistantBatch(second.jobId)).status).toBe('completed');
    const rebuildSpy = vi.spyOn(OpenRouterBatchRequestBuilder.prototype, 'prepareAnalysis');
    const descendant = await app.submitChatTurn({ conversationId: conversation.id, text: 'Continue from those answers.' });
    // Two eligible prior roots rebuild once each, plus one build for this request.
    expect(rebuildSpy).toHaveBeenCalledTimes(3);
    rebuildSpy.mockRestore();

    const savedPerson = app.getSnapshot().knowledge.people.find((row) => row.id === person.id)!;
    const narrative = app.getSnapshot().documents.find((row) => row.path === person.narrativePath)!;
    await app.savePerson({ id: person.id, expectedRevision: savedPerson.revision, expectedDocumentRevision: narrative.revision,
      name: 'Maya', aliases: [], narrative: 'The source was removed.' });

    const persisted = store.value as AppState & {
      assistantChatLedger: { conversations: { turns: { jobId: string; reply?: unknown; replySha256?: string }[] }[] };
      openRouterBatchLedger: { jobs: Record<string, unknown>[] };
    };
    const turns = persisted.assistantChatLedger.conversations[0]?.turns ?? [];
    expect(turns).toHaveLength(4);
    expect([turns[0], turns[2], turns[3]].every((turn) => !turn.reply && !turn.replySha256)).toBe(true);
    expect(turns[1]?.reply).toBeUndefined();
    const jobs = persisted.openRouterBatchLedger.jobs.filter((job) => [first.jobId, second.jobId, descendant.jobId].includes(String(job.id)));
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.status === 'source_removed' && !('requestBody' in job) && !('chatBinding' in job))).toBe(true);
    const independentJob = persisted.openRouterBatchLedger.jobs.find((job) => job.id === independent.jobId);
    expect(independentJob).toMatchObject({ id: independent.jobId, status: 'queued' });
    expect(independentJob).toHaveProperty('requestBody');
    expect(persisted.notes.filter((note) => note.origin === 'assistant_chat')).toHaveLength(4);
    expect(persisted.notes.filter((note) => note.origin === 'assistant_chat').every((note) => !note.analysis && !note.processingFingerprint)).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain('PRIVATE_CHAT_SOURCE_CANARY');
    expect(JSON.stringify(persisted)).not.toContain('PRIVATE_CHAT_REPLY_CANARY');

    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().assistantChatRecoveryStatus?.blocked).not.toBe(true);
    const restoredTurns = reloaded.getSnapshot().assistantChatConversations?.[0]?.turns ?? [];
    expect(restoredTurns).toHaveLength(4);
    expect(restoredTurns[0]?.reply).toBeUndefined();
    expect(restoredTurns[1]?.reply).toBeUndefined();
    expect(restoredTurns[1]?.job?.status).toBe('queued');
    expect(restoredTurns[2]?.reply).toBeUndefined();
    expect(restoredTurns[3]?.reply).toBeUndefined();
  });

  it('tombstones captured knowledge content when a reviewed suggestion changes the entity', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client() });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Alex', aliases: [], narrative: 'PRIVATE_KNOWLEDGE_BEFORE_REVIEW' });
    const note = await app.saveNote({ transcript: 'I prefer concise project updates.' });
    const job = await app.submitNoteBatch(note.id, { knowledgeSelection: [{ kind: 'person', id: person.id }] });
    const suggestion = await app.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript',
      quote: 'I prefer concise project updates.', targetKind: 'person', targetId: person.id,
      change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Prefers concise updates.' } });

    await app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision: person.revision });
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ id: job.id, status: 'source_removed', requestProfileVersion: 2 });
    expect(saved.openRouterBatchLedger.jobs[0]).not.toHaveProperty('requestBody');
    expect(JSON.stringify(saved.openRouterBatchLedger)).not.toContain('PRIVATE_KNOWLEDGE_BEFORE_REVIEW');
  });

  it('lets a removed-source receipt read metadata once without retaining result content', async () => {
    let inspectCalls = 0;
    let finishInspection!: (inspection: OpenRouterBatchInspection) => void;
    const inspection: OpenRouterBatchInspection = {
      batchId: 'batch_metadata_only', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0,
      metadataValidation: 'valid', resultValidation: 'valid', usage: { cost: 0.0005 },
      result: { customId: '', statusCode: 200, finishReason: 'stop', responseBody: { privateResultCanary: 'PRIVATE_RESULT_BODY' } },
    };
    const metadataOnlyClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_metadata_only', input, before, assert),
      inspect: async (_batchId: string, customId: string) => { inspectCalls += 1; return new Promise<OpenRouterBatchInspection>((resolve) => { finishInspection = (value) => resolve({ ...value, result: { ...value.result!, customId } }); }); },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: metadataOnlyClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six seven temporary source' });
    const queued = await app.submitNoteBatch(note.id);
    await app.deleteNote(note.id);

    const pending = app.refreshAssistantBatch(queued.id);
    await vi.waitFor(() => expect(inspectCalls).toBe(1));
    await expect(app.refreshAssistantBatch(queued.id)).rejects.toThrow(/already settling/i);
    finishInspection(inspection);
    const result = await pending;
    expect(inspectCalls).toBe(1);
    expect(result).toMatchObject({ status: 'source_removed', providerReportedCostUsd: 0.0005, canCheck: false });
    const saved = store.value as (AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } });
    expect(saved.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'source_removed', accounting: { providerReportedCostUsd: 0.0005 } });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_RESULT_BODY');
    expect(saved.openRouterBatchLedger.jobs[0]).not.toHaveProperty('requestBody');
  });
});
