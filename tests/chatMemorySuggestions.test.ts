import { describe, expect, it } from 'vitest';
import { AppControllerImpl } from '../src/services/controller';
import { parsePortableBackup } from '../src/backup';
import { OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_CHAT_COMPLETIONS_PATH, type OpenRouterBatchInspection } from '../src/services/openRouter';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';

type PersistedAppState = AppState & {
  openRouterBatchLedger?: { jobs: { id: string; status: string; requestSha256?: string; accounting?: { providerReportedCostUsd?: number };
    sourceVersions?: Record<string, string>;
    chatBinding?: { context: { turnId: string }[] } }[] };
  assistantChatLedger?: { conversations: { turns: { id: string; noteId: string }[] }[] };
};

class MemoryStore implements StateStore {
  value?: PersistedAppState;
  saves = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.saves += 1; this.value = structuredClone(state) as PersistedAppState; }
  async clear() { this.value = undefined; }
}

describe('Chat memory suggestion review', () => {
  it('does not initialize or save during a preflight when local startup is not ready', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { writeDocument: async () => undefined });
    await expect(app.prepareKnowledgeSuggestionReview('missing', { expectedRevision: 1 })).rejects.toThrow(/startup/i);
    expect(store.saves).toBe(0);
  });

  it('rejects ordinary Chat dispatch if settings change while the saved-chat journal mirror is waiting', async () => {
    const store = new MemoryStore();
    let releaseMirror!: () => void;
    let markMirrorStarted!: () => void;
    const mirrorStarted = new Promise<void>((resolve) => { markMirrorStarted = resolve; });
    const mirrorGate = new Promise<void>((resolve) => { releaseMirror = resolve; });
    let dispatches = 0;
    const batchClient = {
      submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before();
        assert();
        dispatches += 1;
        return { batchId: 'should-not-dispatch', status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
      },
    } as never;
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient, writeDocument: async (_path, content) => {
      if (content.includes('saved-chat:')) { markMirrorStarted(); await mirrorGate; }
    } });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const conversation = await app.createChatConversation('Mirror race');

    const submission = app.submitChatTurn({ conversationId: conversation.id, text: 'Use the provider request captured at staging.' });
    await mirrorStarted;
    await app.saveSettings({ mode: 'preview' });
    releaseMirror();

    await expect(submission).resolves.toMatchObject({ kind: 'accepted' });
    expect(dispatches).toBe(0);
    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.userText).toBe('Use the provider request captured at staging.');
  });

  it('preflights without saving, then accepts only the current frozen transcript suggestion and retains accepted user facts', async () => {
    const store = new MemoryStore();
    let personId = '';
    const fakeClient = {
      submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert();
        return { batchId: 'chat-memory-batch', status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string): Promise<OpenRouterBatchInspection> => {
        const job = store.value?.openRouterBatchLedger?.jobs.find((item) => item.id === customId);
        const sourceVersion = job?.sourceVersions?.transcript;
        const mixedAssistantEvidence = job?.chatBinding?.context?.length
          ? [{ sourceId: `chat_turn:${job.chatBinding.context[0]!.turnId}`, revision: 1,
              sourceVersion: job.sourceVersions?.[`chat_turn:${job.chatBinding.context[0]!.turnId}`], quote: 'Maya prefers concise weekly updates.' }]
          : [];
        const content = JSON.stringify({ summary: 'Maya likes a concise weekly update.', answer: 'Maya prefers concise weekly updates.',
          decisions: [], citations: [], clarifications: [], proposals: [],
          memorySuggestions: [{ targetSourceId: `knowledge:person:${personId}`, targetRevision: 1, type: 'add_fact',
            statement: job?.chatBinding?.context?.length ? 'Must not learn from earlier assistant content.' : 'Prefers concise weekly updates.',
            address: null, label: null, relatedSourceId: null, role: null,
            evidence: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: 'I like cafe\u0301.' }, ...mixedAssistantEvidence] }] });
        return { batchId, status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL,
          completionWindow: '24h', total: 1, completed: 1, failed: 0, metadataValidation: 'valid', resultValidation: 'valid',
          usage: { cost: 0.001, promptTokens: 8, completionTokens: 8, totalTokens: 16 },
          result: { customId, statusCode: 200, finishReason: 'stop', responseBody: { model: OPENROUTER_BATCH_BODY_MODEL,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] } } };
      },
    } as never;
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient, writeDocument: async () => undefined });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: '' });
    personId = person.id;
    const conversation = await app.createChatConversation('Memory review');
    const sent = await app.submitChatTurn({ conversationId: conversation.id, text: 'I prefer concise weekly updates.\r\nI like cafe\u0301.', knowledgeSelection: [{ kind: 'person', id: person.id }] });
    const staged = store.value!;
    const savedChatLog = staged.documents.filter((item) => /^logs\/(daily|weekly|monthly|yearly)\//.test(item.path));
    expect(savedChatLog.some((item) => item.content.includes(`saved-chat:${sent.turnId}:${sent.jobId}`))).toBe(true);

    await app.refreshAssistantBatch(sent.jobId);
    expect(store.value?.openRouterBatchLedger?.jobs.find((item) => item.id === sent.jobId)).toMatchObject({ status: 'completed' });
    const suggestion = app.getSnapshot().knowledge.suggestions.find((item) => item.status === 'pending')!;
    expect(suggestion.evidence).toEqual([{ sourceId: `note:${app.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.noteId}`,
      revision: 1, sourceVersion: expect.stringMatching(/^1:[0-9a-f]{64}$/), quote: 'I like cafe\u0301.' }]);
    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.memorySuggestionIds).toEqual([suggestion.id]);
    const inferenceDoc = store.value?.documents.find((item) => item.path === 'memory/INFERENCES.md');
    expect(inferenceDoc?.content).toContain(`knowledge-suggestion:${suggestion.id}:r1:created`);
    expect(inferenceDoc?.content).not.toContain('Maya prefers concise weekly updates.');
    const requestSha256 = store.value?.openRouterBatchLedger?.jobs.find((item) => item.id === sent.jobId)?.requestSha256;
    await app.refreshAssistantBatch(sent.jobId);
    expect(app.getSnapshot().knowledge.suggestions.filter((item) => item.status === 'pending')).toHaveLength(1);
    const processedLogs = store.value?.documents.filter((item) => item.path.startsWith('logs/') && item.content.includes(`processed:chat:${sent.turnId}:${sent.jobId}`)) ?? [];
    expect(processedLogs.length).toBeGreaterThan(0);
    expect(processedLogs.every((item) => item.content.split(`processed:chat:${sent.turnId}:${sent.jobId}`).length - 1 === 1)).toBe(true);
    expect(store.value?.openRouterBatchLedger?.jobs.find((item) => item.id === sent.jobId)?.requestSha256).toBe(requestSha256);

    const saveCount = store.saves;
    const review = await app.prepareKnowledgeSuggestionReview(suggestion.id, { expectedRevision: suggestion.revision });
    expect(review).toMatchObject({ canEdit: true, canAccept: true, suggestion: { id: suggestion.id } });
    expect(store.saves).toBe(saveCount);

    const mixedEvidence = [...suggestion.evidence, { ...suggestion.evidence[0]!, sourceId: 'chat_turn:another-assistant-turn' }];
    await expect(app.editKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision,
      change: suggestion.change, evidence: mixedEvidence })).rejects.toThrow(/source chat|transcript changed/i);
    const normalizedQuote = [{ ...suggestion.evidence[0]!, quote: 'I like café.' }];
    await expect(app.editKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision,
      change: suggestion.change, evidence: normalizedQuote })).rejects.toThrow(/source chat|transcript changed/i);
    const anotherChat = await app.submitChatTurn({ conversationId: conversation.id, text: 'I like cafe\u0301. A different assistant message.', knowledgeSelection: [{ kind: 'person', id: person.id }] });
    await app.refreshAssistantBatch(anotherChat.jobId);
    expect(app.getSnapshot().knowledge.suggestions.filter((item) => item.status === 'pending')).toHaveLength(1);
    expect(app.getSnapshot().knowledge.suggestions.some((item) => item.change.type === 'add_fact' && item.change.statement === 'Must not learn from earlier assistant content.')).toBe(false);
    expect(store.value?.openRouterBatchLedger?.jobs.find((item) => item.id === anotherChat.jobId)?.status).toBe('completed');
    expect(store.value?.openRouterBatchLedger?.jobs.find((item) => item.id === anotherChat.jobId)?.accounting?.providerReportedCostUsd).toBe(0.001);
    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns[1]?.reply?.answer).toBe('Maya prefers concise weekly updates.');
    const anotherNoteId = store.value?.assistantChatLedger?.conversations[0]?.turns.find((item) => item.id === anotherChat.turnId)?.noteId;
    expect(anotherNoteId).toBeTruthy();
    await expect(app.editKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision,
      change: { type: 'add_source_link', entityKind: 'person', entityId: person.id, reference: { kind: 'note', id: anotherNoteId! }, label: 'Related chat' },
      evidence: suggestion.evidence })).rejects.toThrow(/source chat|transcript changed/i);

    const edited = await app.editKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision,
      change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Prefers concise weekly updates.' }, evidence: suggestion.evidence });
    expect((await app.prepareKnowledgeSuggestionReview(edited.id, { expectedRevision: edited.revision })).canAccept).toBe(true);
    const accepted = await app.reviewKnowledgeSuggestion(edited.id, { expectedRevision: edited.revision, decision: 'accept', targetRevision: person.revision });
    expect(accepted.status).toBe('accepted');
    expect(app.getSnapshot().knowledge.people.find((item) => item.id === person.id)?.facts.map((item) => item.statement)).toContain('Prefers concise weekly updates.');
    const final = store.value!;
    expect(final.notes.find((item) => item.id === suggestion.sourceNoteId)?.transcript).toBe('I prefer concise weekly updates.\r\nI like cafe\u0301.');
    expect(final.openRouterBatchLedger?.jobs.find((item) => item.id === sent.jobId)?.status).toBe('source_removed');
    const history = await app.prepareKnowledgeSuggestionReview(accepted.id, { expectedRevision: accepted.revision });
    expect(history).toMatchObject({ canEdit: false, canAccept: false });

    store.value = JSON.parse(JSON.stringify(store.value)) as PersistedAppState;
    const restarted = new AppControllerImpl(store, {}, { writeDocument: async () => undefined });
    await restarted.load();
    expect(restarted.getSnapshot().knowledge.people.find((item) => item.id === person.id)?.facts.map((item) => item.statement)).toContain('Prefers concise weekly updates.');
    expect(restarted.getSnapshot().knowledge.suggestions.find((item) => item.id === accepted.id)?.status).toBe('accepted');
    await restarted.deleteChatConversation(conversation.id);
    expect(restarted.getSnapshot().knowledge.people.find((item) => item.id === person.id)?.facts.map((item) => item.statement)).toContain('Prefers concise weekly updates.');
    expect(restarted.getSnapshot().knowledge.suggestions.find((item) => item.id === accepted.id)?.status).toBe('accepted');

    const portable = parsePortableBackup(await restarted.exportData()).backup;
    const importedStore = new MemoryStore();
    const collisionSeed = new AppControllerImpl(importedStore, {}, { writeDocument: async () => undefined });
    await collisionSeed.load();
    const collisionState = structuredClone(collisionSeed.getSnapshot());
    collisionState.notes.push({ id: suggestion.sourceNoteId!, title: 'Unrelated collision', transcript: 'A colliding unrelated local note.',
      durationSeconds: 0, createdAt: '2026-10-14T00:00:00.000Z', status: 'recorded', revision: 1 });
    await importedStore.save(collisionState);
    const imported = new AppControllerImpl(importedStore, {}, { writeDocument: async () => undefined });
    await imported.load();
    const importPlan = await imported.prepareBackupImport(JSON.stringify(portable));
    const archive = await imported.applyBackupImport({ sessionId: importPlan.sessionId, planHash: importPlan.planHash });
    const cohort = archive.archivedKnowledge?.[0];
    expect(cohort).toBeTruthy();
    const activation = await imported.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort!.id, kind: 'person', entityId: person.id });
    const activated = await imported.activateImportedKnowledgeEntity({ sessionId: activation.sessionId, planHash: activation.planHash });
    expect(activated.entity.facts.map((fact) => fact.statement)).toContain('Prefers concise weekly updates.');
    expect(activated.entity.facts.find((fact) => fact.statement === 'Prefers concise weekly updates.')?.evidence?.[0]?.sourceId)
      .toMatch(/^historical:imported:/);
    const reexported = parsePortableBackup(await imported.exportData()).backup;
    expect(JSON.stringify(reexported.knowledge.state)).toContain('Prefers concise weekly updates.');
    expect(JSON.stringify(reexported.knowledge.state)).not.toContain(suggestion.sourceNoteId!);
  });

  it('blocks edit and acceptance when its source Chat is deleted after preflight', async () => {
    const store = new MemoryStore();
    let personId = '';
    const fakeClient = {
      submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert();
        return { batchId: 'chat-memory-stale-batch', status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string): Promise<OpenRouterBatchInspection> => {
        const job = store.value?.openRouterBatchLedger?.jobs.find((item) => item.id === customId);
        const sourceVersion = job?.sourceVersions?.transcript;
        const content = JSON.stringify({ summary: 'A current preference.', answer: 'I will remember that.', decisions: [], citations: [], clarifications: [], proposals: [],
          memorySuggestions: [{ targetSourceId: `knowledge:person:${personId}`, targetRevision: 1, type: 'add_fact', statement: 'Prefers email summaries.',
            address: null, label: null, relatedSourceId: null, role: null,
            evidence: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: 'I prefer email summaries.' }] }] });
        return { batchId, status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL,
          completionWindow: '24h', total: 1, completed: 1, failed: 0, metadataValidation: 'valid', resultValidation: 'valid',
          usage: { cost: 0.001, promptTokens: 8, completionTokens: 8, totalTokens: 16 },
          result: { customId, statusCode: 200, finishReason: 'stop', responseBody: { model: OPENROUTER_BATCH_BODY_MODEL,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] } } };
      },
    } as never;
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient, writeDocument: async () => undefined });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: '' });
    personId = person.id;
    const conversation = await app.createChatConversation('Source invalidation');
    const sent = await app.submitChatTurn({ conversationId: conversation.id, text: 'I prefer email summaries.', knowledgeSelection: [{ kind: 'person', id: person.id }] });
    await app.refreshAssistantBatch(sent.jobId);
    const suggestion = app.getSnapshot().knowledge.suggestions.find((item) => item.status === 'pending')!;
    const turn = app.getSnapshot().assistantChatConversations?.[0]?.turns[0];
    const preflight = await app.prepareKnowledgeSuggestionReview(suggestion.id, { expectedRevision: suggestion.revision });
    expect(preflight.canAccept).toBe(true);

    await app.deleteChatConversation(conversation.id);

    expect(turn?.userText).toBe('I prefer email summaries.');
    expect(app.getSnapshot().knowledge.suggestions.find((item) => item.id === suggestion.id)?.status).not.toBe('pending');
    await expect(app.editKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision,
      change: suggestion.change, evidence: suggestion.evidence })).rejects.toThrow();
    await expect(app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision: person.revision }))
      .rejects.toThrow();
  });
});
