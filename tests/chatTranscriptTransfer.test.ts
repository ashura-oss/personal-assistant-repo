import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AzureSpeechClient } from '../src/services/azure';
import type { PreparedSpeechAudio } from '../src/audio/speechUpload.types';
import { parsePortableBackup } from '../src/backup';
import { AppControllerImpl } from '../src/services/controller';
import { OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_CHAT_COMPLETIONS_PATH, type OpenRouterBatchClient } from '../src/services/openRouter';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';

class MemoryStore implements StateStore {
  value?: AppState;
  failAfterCommit = false;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.value = structuredClone(state);
    if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('fixture lost the save acknowledgement'); }
  }
  async clear() { this.value = undefined; }
}

class RetentionFailureStore extends MemoryStore {
  failDetachForTranscript?: string;
  async save(state: AppState) {
    if (this.failDetachForTranscript && state.notes.some((note) => note.transcript === this.failDetachForTranscript && !note.audioUri)) {
      this.failDetachForTranscript = undefined;
      throw new Error('fixture retention detach save failed');
    }
    await super.save(state);
  }
}

function batchClient(bodies: Record<string, unknown>[], dispatches: string[] = []) {
  return {
    submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
      await before();
      assert();
      dispatches.push(input.operationId);
      bodies.push(JSON.parse(input.requestBody) as Record<string, unknown>);
      return { batchId: `batch_transfer_${dispatches.length}`, status: 'validating' as const,
        endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL,
        completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
    },
  } as unknown as OpenRouterBatchClient;
}

function completingBatchClient(bodies: Record<string, unknown>[]) {
  let count = 0;
  return {
    submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
      await before(); assert();
      count += 1;
      bodies.push(JSON.parse(input.requestBody) as Record<string, unknown>);
      return { batchId: `batch_transfer_complete_${count}`, status: 'validating' as const,
        endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL,
        completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
    },
    inspect: async (batchId: string, customId: string) => ({
      batchId, status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL,
      completionWindow: '24h', total: 1, completed: 1, failed: 0, metadataValidation: 'valid', resultValidation: 'valid',
      usage: { cost: 0.001, promptTokens: 12, completionTokens: 5, totalTokens: 17 },
      result: { customId, statusCode: 200, finishReason: 'stop', responseBody: { model: OPENROUTER_BATCH_BODY_MODEL,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
          summary: 'A saved transcript summary.', answer: 'A useful response.', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
        }) } }] } },
    }),
  } as unknown as OpenRouterBatchClient;
}

describe('saved transcript to Chat transfer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('keeps the captured anchor, accepts a local conversation created after review, and copies the transcript once', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const dispatches: string[] = [];
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies, dispatches) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'VOICE_TRANSCRIPT_CANARY: bring the blue folder.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    expect(plan).toMatchObject({ noteId: original.id, noteRevision: original.revision, transcript: original.transcript,
      capturedAt: original.capturedAt, captureTimeZone: original.captureTimeZone });

    // Local navigation/setup after preview does not invalidate an unchanged source.
    const conversation = await app.createChatConversation('From a note');
    const accepted = await app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    expect(accepted.kind).toBe('accepted');
    expect(dispatches).toHaveLength(1);
    const persisted = store.value as AppState & {
      assistantChatLedger: { conversations: { turns: { id: string; noteId: string; userText: string; createdAt: string; capturedAt?: string; captureTimeZone: string; messageOrigin?: string }[] }[] };
      openRouterBatchLedger: { jobs: { id: string; requestBody: string; chatBinding?: { transcriptSource?: { noteId: string; noteRevision: number; transcriptSha256: string } } }[] };
    };
    const turn = persisted.assistantChatLedger.conversations[0]?.turns[0];
    const job = persisted.openRouterBatchLedger.jobs.find((item) => item.id === accepted.jobId);
    expect(turn).toMatchObject({ userText: original.transcript, capturedAt: original.capturedAt,
      captureTimeZone: original.captureTimeZone, messageOrigin: 'saved_transcript' });
    expect(Date.parse(turn!.createdAt)).toBeGreaterThan(Date.parse(original.capturedAt!));
    expect(job?.chatBinding?.transcriptSource).toMatchObject({ noteId: original.id, noteRevision: original.revision });
    const wire = JSON.stringify(bodies[0]);
    expect(wire.match(/VOICE_TRANSCRIPT_CANARY/g)).toHaveLength(1);
    expect(wire).not.toContain('Respond to the current user message.\nVOICE_TRANSCRIPT_CANARY');
    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns[0]).toMatchObject({ messageOrigin: 'saved_transcript', capturedAt: original.capturedAt });
    await expect(app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id })).rejects.toThrow(/review expired/i);
    expect(dispatches).toHaveLength(1);
  });

  it('rejects saved-transcript Chat dispatch if settings change while the journal mirror is waiting', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const dispatches: string[] = [];
    let markMirrorStarted!: () => void;
    let releaseMirror!: () => void;
    const mirrorStarted = new Promise<void>((resolve) => { markMirrorStarted = resolve; });
    const mirrorGate = new Promise<void>((resolve) => { releaseMirror = resolve; });
    const app = new AppControllerImpl(store, {}, {
      openRouterBatchClient: batchClient(bodies, dispatches),
      writeDocument: async (_path, content) => {
        if (content.includes('saved-chat:')) { markMirrorStarted(); await mirrorGate; }
      },
    });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'A stable saved transcript.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const conversation = await app.createChatConversation('Transfer mirror race');

    const submission = app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    await mirrorStarted;
    await app.saveSettings({ mode: 'preview' });
    releaseMirror();

    await expect(submission).resolves.toMatchObject({ kind: 'accepted' });
    expect(dispatches).toHaveLength(0);
    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.userText).toBe(original.transcript);
  });

  it('retires a pending saved-transcript Chat candidate when its original note changes, preserving the copied user message', async () => {
    const store = new MemoryStore();
    let personId = '';
    let targetRevision = 1;
    const client = {
      submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert();
        return { batchId: 'voice-memory-batch', status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string) => {
        const job = (store.value as (AppState & { openRouterBatchLedger?: { jobs: { id: string; sourceVersions: Record<string, string> }[] } }) | undefined)
          ?.openRouterBatchLedger?.jobs.find((item) => item.id === customId);
        const content = JSON.stringify({ summary: 'A saved transcript preference.', answer: 'I will remember this preference.',
          decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [{
            targetSourceId: `knowledge:person:${personId}`, targetRevision, type: 'add_fact', statement: 'Prefers short summaries.',
            address: null, label: null, relatedSourceId: null, role: null,
            evidence: [{ sourceId: 'transcript', revision: 1, sourceVersion: job?.sourceVersions.transcript, quote: 'Maya prefers short summaries.' }],
          }] });
        return { batchId, status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL,
          completionWindow: '24h', total: 1, completed: 1, failed: 0, metadataValidation: 'valid', resultValidation: 'valid',
          usage: { cost: 0.001, promptTokens: 8, completionTokens: 8, totalTokens: 16 },
          result: { customId, statusCode: 200, finishReason: 'stop', responseBody: { model: OPENROUTER_BATCH_BODY_MODEL,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] } } };
      },
    } as unknown as OpenRouterBatchClient;
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: client });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'Maya prefers short summaries.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: '' });
    personId = person.id;
    await app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision,
      reference: { kind: 'note', id: original.id }, label: 'Transcript context' });
    targetRevision = app.getSnapshot().knowledge.people.find((item) => item.id === person.id)!.revision;
    const conversation = await app.createChatConversation('Voice memory source');
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const accepted = await app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    await app.refreshAssistantBatch(accepted.jobId);
    const suggestion = app.getSnapshot().knowledge.suggestions.find((item) => item.status === 'pending')!;
    const copiedText = app.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.userText;
    expect(suggestion).toBeTruthy();
    expect(await app.prepareKnowledgeSuggestionReview(suggestion.id, { expectedRevision: suggestion.revision })).toMatchObject({ canAccept: true });

    await app.updateTranscript(original.id, 'The saved transcript was corrected.');

    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.userText).toBe(copiedText);
    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.userText).toBe(original.transcript);
    expect(app.getSnapshot().knowledge.suggestions.find((item) => item.id === suggestion.id)?.status).not.toBe('pending');
    await expect(app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision }))
      .rejects.toThrow();
  });

  it('exports live saved-transcript provenance through strict import and re-export without source authority', async () => {
    const sourceStore = new MemoryStore();
    const sourceBodies: Record<string, unknown>[] = [];
    const sourceApp = new AppControllerImpl(sourceStore, {}, { openRouterBatchClient: completingBatchClient(sourceBodies) });
    await sourceApp.load();
    await sourceApp.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await sourceApp.saveNote({ transcript: 'Source identity must stay private.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await sourceApp.createChatConversation('Portable provenance');
    const plan = await sourceApp.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const accepted = await sourceApp.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    await sourceApp.refreshAssistantBatch(accepted.jobId);
    expect(sourceApp.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.messageOrigin).toBe('saved_transcript');

    const liveExport = await sourceApp.exportData();
    const parsedLiveBackup = parsePortableBackup(liveExport);
    const strictLiveBackup = parsedLiveBackup.backup;
    expect(parsedLiveBackup.sourceFormat).toBe('still-backup-v5');
    expect(strictLiveBackup.chatHistory.version).toBe(2);
    const liveHistory = JSON.stringify(strictLiveBackup.chatHistory);
    expect(strictLiveBackup.chatHistory.conversations[0]?.turns[0]?.messageOrigin).toBe('saved_transcript');
    expect(liveHistory).not.toContain(original.id);
    expect(liveHistory).not.toContain(conversation.id);
    expect(liveHistory).not.toContain(accepted.turnId);
    expect(liveHistory).not.toContain(accepted.jobId);
    expect(liveHistory).not.toContain('transcriptSource');

    const importedStore = new MemoryStore();
    const importedApp = new AppControllerImpl(importedStore);
    await importedApp.load();
    const preview = await importedApp.prepareBackupImport(liveExport);
    const archive = await importedApp.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    expect(archive.chatHistory).toHaveLength(1);
    const importedHistory = importedApp.getSnapshot().importedBackups.find((item) => item.id === archive.id)?.chatHistory;
    expect(importedHistory?.[0]?.turns[0]).toMatchObject({ messageOrigin: 'saved_transcript', origin: 'portable_backup_unverified' });
    expect(importedHistory?.[0]?.turns[0]).not.toHaveProperty('noteId');
    expect(importedHistory?.[0]?.turns[0]).not.toHaveProperty('jobId');

    const reExport = await importedApp.exportData();
    const strictReExport = parsePortableBackup(reExport).backup;
    const reExportHistory = JSON.stringify(strictReExport.chatHistory);
    expect(strictReExport.chatHistory.conversations[0]?.turns[0]?.messageOrigin).toBe('saved_transcript');
    expect(reExportHistory).not.toContain(original.id);
    expect(reExportHistory).not.toContain(conversation.id);
    expect(reExportHistory).not.toContain(accepted.turnId);
    expect(reExportHistory).not.toContain(accepted.jobId);
    expect(reExportHistory).not.toContain('noteId');
    expect(reExportHistory).not.toContain('jobId');
  });

  it('consumes a review when the original note changes and never submits stale or unknown-timezone imports', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const dispatches: string[] = [];
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies, dispatches) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'The original words.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Review changes');
    const changedPlan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    await app.updateTranscript(original.id, 'Revised words.');
    await expect(app.submitChatFromTranscript({ planId: changedPlan.planId, conversationId: conversation.id })).rejects.toThrow(/changed/i);
    await expect(app.submitChatFromTranscript({ planId: changedPlan.planId, conversationId: conversation.id })).rejects.toThrow(/review expired/i);
    expect(dispatches).toHaveLength(0);
    expect(store.value?.notes.some((note) => note.origin === 'assistant_chat')).toBe(false);

    const imported = await app.saveNote({ transcript: 'Unknown original zone.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const importedRow = store.value!.notes.find((note) => note.id === imported.id)!;
    importedRow.importOrigin = { kind: 'backup_import', archiveId: 'archive-local', sourceNoteId: 'source-local', audioMissing: true, originalTimeZoneUnknown: true };
    const reloaded = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies, dispatches) });
    await reloaded.load();
    await expect(reloaded.prepareChatFromTranscript({ noteId: imported.id, expectedRevision: imported.revision })).rejects.toThrow(/confirmed capture time zone/i);
    expect(dispatches).toHaveLength(0);
  });

  it('source edits redact the generated request while preserving the user-authored Chat copy', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'Keep this copied message.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Retain the copy');
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const accepted = await app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    await app.updateTranscript(original.id, 'The source was changed after copying.');
    const persisted = store.value as AppState & {
      assistantChatLedger: { conversations: { turns: { userText: string; reply?: unknown }[] }[] };
      openRouterBatchLedger: { jobs: { id: string; status: string; requestBody?: string; chatBinding?: unknown }[] };
    };
    expect(persisted.assistantChatLedger.conversations[0]?.turns[0]?.userText).toBe('Keep this copied message.');
    expect(persisted.openRouterBatchLedger.jobs.find((job) => job.id === accepted.jobId)).toMatchObject({ status: 'source_removed' });
    expect(persisted.openRouterBatchLedger.jobs.find((job) => job.id === accepted.jobId)).not.toHaveProperty('requestBody');
    expect(persisted.openRouterBatchLedger.jobs.find((job) => job.id === accepted.jobId)).not.toHaveProperty('chatBinding');
    expect(persisted.assistantChatLedger.conversations[0]?.turns[0]?.reply).toBeUndefined();
  });

  it('expires and consumes plans after clock rollback without dispatching', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const dispatches: string[] = [];
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies, dispatches) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'Clock bound transcript.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Clock review');

    const rollbackPlan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    vi.setSystemTime(new Date('2026-10-13T23:59:59.999Z'));
    await expect(app.submitChatFromTranscript({ planId: rollbackPlan.planId, conversationId: conversation.id })).rejects.toThrow(/expired/i);
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
    await expect(app.submitChatFromTranscript({ planId: rollbackPlan.planId, conversationId: conversation.id })).rejects.toThrow(/expired/i);

    const expiryPlan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    vi.setSystemTime(new Date('2026-10-14T00:05:00.000Z'));
    await expect(app.submitChatFromTranscript({ planId: expiryPlan.planId, conversationId: conversation.id })).rejects.toThrow(/expired/i);
    expect(dispatches).toHaveLength(0);
    expect(bodies).toHaveLength(0);
    expect(store.value?.notes.some((note) => note.origin === 'assistant_chat')).toBe(false);
  });

  it('cancels and supersedes local plans, and never restores them across restart', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const dispatches: string[] = [];
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies, dispatches) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'Plan lifecycle transcript.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Plan lifecycle');
    const cancelled = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    await app.cancelChatFromTranscript(cancelled.planId);
    await expect(app.submitChatFromTranscript({ planId: cancelled.planId, conversationId: conversation.id })).rejects.toThrow(/expired/i);

    const superseded = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const current = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    await expect(app.submitChatFromTranscript({ planId: superseded.planId, conversationId: conversation.id })).rejects.toThrow(/expired/i);
    const reloaded = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies, dispatches) });
    await reloaded.load();
    await expect(reloaded.submitChatFromTranscript({ planId: current.planId, conversationId: conversation.id })).rejects.toThrow(/expired/i);
    expect(dispatches).toHaveLength(0);
    expect(bodies).toHaveLength(0);
  });

  it('does not replay a plan after an uncertain local save acknowledgement', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const dispatches: string[] = [];
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies, dispatches) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'Uncertain transfer save.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Uncertain transfer');
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    store.failAfterCommit = true;
    await expect(app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id })).rejects.toThrow(/acknowledgement/i);
    await expect(app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id })).rejects.toThrow(/expired/i);
    expect(dispatches).toHaveLength(0);
    expect(bodies).toHaveLength(0);
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().assistantChatRecoveryStatus?.blocked).not.toBe(true);
    expect(reloaded.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.userText).toBe('Uncertain transfer save.');
  });

  it('consumes a plan when privacy admission fails and never posts it', async () => {
    let privacyBlocked = false;
    const privacySession = { epoch: 'fixture-epoch', assertCurrent: async () => {
      if (privacyBlocked) throw new Error('The privacy session was invalidated.');
    } };
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const dispatches: string[] = [];
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batchClient(bodies, dispatches), privacySession });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'Privacy-bound transfer.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Privacy transfer');
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    privacyBlocked = true;
    await expect(app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id })).rejects.toThrow(/privacy session was invalidated/i);
    await expect(app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id })).rejects.toThrow(/expired/i);
    expect(dispatches).toHaveLength(0);
    expect(bodies).toHaveLength(0);
    expect(store.value?.notes.some((note) => note.origin === 'assistant_chat')).toBe(false);
  });

  it('removing a transcript redacts its Chat refinement descendants and keeps the copied user text', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: completingBatchClient(bodies) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const original = await app.saveNote({ transcript: 'Keep the user-authored copy.', capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Transcript lineage');
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const accepted = await app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    await app.refreshAssistantBatch(accepted.jobId);
    const refined = await app.refineChatTurn({ conversationId: conversation.id, parentTurnId: accepted.turnId, effort: 'high' });
    await app.refreshAssistantBatch(refined.jobId);

    await app.deleteNote(original.id);
    const persisted = store.value as AppState & {
      assistantChatLedger: { conversations: { turns: { id: string; userText: string; reply?: unknown }[] }[] };
      openRouterBatchLedger: { jobs: { id: string; status: string; requestBody?: string; chatBinding?: unknown }[] };
    };
    expect(persisted.assistantChatLedger.conversations[0]?.turns.map((turn) => turn.userText)).toEqual([
      'Keep the user-authored copy.', 'Keep the user-authored copy.',
    ]);
    for (const turn of persisted.assistantChatLedger.conversations[0]?.turns ?? []) expect(turn.reply).toBeUndefined();
    for (const jobId of [accepted.jobId, refined.jobId]) {
      expect(persisted.openRouterBatchLedger.jobs.find((job) => job.id === jobId)).toMatchObject({ status: 'source_removed' });
      expect(persisted.openRouterBatchLedger.jobs.find((job) => job.id === jobId)).not.toHaveProperty('requestBody');
      expect(persisted.openRouterBatchLedger.jobs.find((job) => job.id === jobId)).not.toHaveProperty('chatBinding');
    }
  });

  it('re-transcription invalidates transcript-backed replies and descendants without quarantining Chat on reload', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    const speech = {
      transcribe: async (_note: unknown, _settings: unknown, _signal: AbortSignal | undefined,
        onAttempt: (value: PreparedSpeechAudio) => Promise<void>, beforeDispatch: (value: PreparedSpeechAudio) => void,
        onPrepared: (value: PreparedSpeechAudio) => Promise<void>, leaseId: string) => {
        const prepared = { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
          sha256: 'f'.repeat(64), durationSeconds: 8, upload: { blob: new Blob(['voice']), fileName: 'note.wav' } } as PreparedSpeechAudio;
        await onPrepared(prepared);
        await onAttempt(prepared);
        beforeDispatch(prepared);
        return { transcript: 'A revised transcription.', durationMilliseconds: 8_000, durationSeconds: 8,
          billedEstimateSeconds: 8, attempts: 1 as const, cleanupPromise: Promise.resolve() };
      },
      releaseUploadLease: async () => undefined,
    } as unknown as AzureSpeechClient;
    const app = new AppControllerImpl(store, { speech }, { openRouterBatchClient: completingBatchClient(bodies) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
      speechEnabled: true, speechEndpoint: 'https://example.cognitiveservices.azure.com' });
    const original = await app.saveNote({ transcript: 'Original saved words.', audioUri: 'file:///private/voice.m4a', durationSeconds: 8,
      capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Re-transcription lineage');
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const accepted = await app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    await app.refreshAssistantBatch(accepted.jobId);
    const refined = await app.refineChatTurn({ conversationId: conversation.id, parentTurnId: accepted.turnId, effort: 'high' });
    await app.refreshAssistantBatch(refined.jobId);

    await app.transcribeNote(original.id, { expectedRevision: original.revision });
    const persisted = store.value as AppState & {
      assistantChatLedger: { conversations: { turns: { id: string; userText: string; reply?: unknown }[] }[] };
      openRouterBatchLedger: { jobs: { id: string; status: string; accounting?: unknown; requestBody?: string; chatBinding?: unknown }[] };
    };
    expect(persisted.notes.find((note) => note.id === original.id)?.transcript).toBe('A revised transcription.');
    expect(persisted.assistantChatLedger.conversations[0]?.turns.map((turn) => turn.userText)).toEqual([
      'Original saved words.', 'Original saved words.',
    ]);
    for (const turn of persisted.assistantChatLedger.conversations[0]?.turns ?? []) expect(turn.reply).toBeUndefined();
    for (const jobId of [accepted.jobId, refined.jobId]) {
      const job = persisted.openRouterBatchLedger.jobs.find((item) => item.id === jobId);
      expect(job).toMatchObject({ status: 'source_removed', accounting: { providerReportedCostUsd: 0.001 } });
      expect(job).not.toHaveProperty('requestBody');
      expect(job).not.toHaveProperty('chatBinding');
    }
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().assistantChatRecoveryStatus?.blocked).not.toBe(true);
    expect(reloaded.getSnapshot().assistantChatConversations?.[0]?.turns.map((turn) => turn.userText)).toEqual([
      'Original saved words.', 'Original saved words.',
    ]);
    expect(reloaded.getSnapshot().assistantChatConversations?.[0]?.turns.every((turn) => !turn.reply)).toBe(true);
  });

  it('keeps the Chat lineage and speech receipt when cancellation wins before transcript application', async () => {
    const store = new MemoryStore();
    const bodies: Record<string, unknown>[] = [];
    let startTranscription!: () => void;
    let finishTranscription!: () => void;
    const started = new Promise<void>((resolve) => { startTranscription = resolve; });
    const finish = new Promise<void>((resolve) => { finishTranscription = resolve; });
    const speech = {
      transcribe: async (_note: unknown, _settings: unknown, _signal: AbortSignal | undefined,
        onAttempt: (value: PreparedSpeechAudio) => Promise<void>, beforeDispatch: (value: PreparedSpeechAudio) => void,
        onPrepared: (value: PreparedSpeechAudio) => Promise<void>, leaseId: string) => {
        const prepared = { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
          sha256: 'a'.repeat(64), durationSeconds: 8, upload: { blob: new Blob(['voice']), fileName: 'note.wav' } } as PreparedSpeechAudio;
        await onPrepared(prepared); await onAttempt(prepared); beforeDispatch(prepared);
        startTranscription(); await finish;
        return { transcript: 'Cancelled generated text.', durationMilliseconds: 8_000, durationSeconds: 8,
          billedEstimateSeconds: 8, attempts: 1 as const, cleanupPromise: Promise.resolve() };
      },
      releaseUploadLease: async () => undefined,
    } as unknown as AzureSpeechClient;
    const app = new AppControllerImpl(store, { speech }, { openRouterBatchClient: completingBatchClient(bodies) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
      speechEnabled: true, speechEndpoint: 'https://example.cognitiveservices.azure.com' });
    const original = await app.saveNote({ transcript: 'Words that must stay.', audioUri: 'file:///private/voice.m4a', durationSeconds: 8,
      capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Cancellation lineage');
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const accepted = await app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    await app.refreshAssistantBatch(accepted.jobId);

    const request = app.transcribeNote(original.id, { expectedRevision: original.revision });
    await started;
    expect((await app.cancelTranscription(original.id)).status).toBe('cancelled');
    finishTranscription();
    await expect(request).rejects.toThrow(/valid provider result was recorded/i);
    expect(app.getSnapshot().notes.find((note) => note.id === original.id)).toMatchObject({ transcript: original.transcript, revision: original.revision });
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'cancelled', durationMilliseconds: 8_000 });
    expect(app.getSnapshot().usage.transcriptionSeconds).toBe(8);
    const persisted = store.value as AppState & { assistantChatLedger: { conversations: { turns: { userText: string; reply?: unknown }[] }[] } };
    expect(persisted.assistantChatLedger.conversations[0]?.turns[0]).toMatchObject({ userText: original.transcript, reply: { answer: 'A useful response.' } });
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().assistantChatRecoveryStatus?.blocked).not.toBe(true);
    expect(reloaded.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.reply?.answer).toBe('A useful response.');
  });

  it('keeps transcript, speech accounting, and Chat redaction when retention detach persistence fails', async () => {
    const store = new RetentionFailureStore();
    const bodies: Record<string, unknown>[] = [];
    const speech = {
      transcribe: async (_note: unknown, _settings: unknown, _signal: AbortSignal | undefined,
        onAttempt: (value: PreparedSpeechAudio) => Promise<void>, beforeDispatch: (value: PreparedSpeechAudio) => void,
        onPrepared: (value: PreparedSpeechAudio) => Promise<void>, leaseId: string) => {
        const prepared = { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
          sha256: 'b'.repeat(64), durationSeconds: 8, upload: { blob: new Blob(['voice']), fileName: 'note.wav' } } as PreparedSpeechAudio;
        await onPrepared(prepared); await onAttempt(prepared); beforeDispatch(prepared);
        return { transcript: 'Saved transcript before failed detach.', durationMilliseconds: 8_000, durationSeconds: 8,
          billedEstimateSeconds: 8, attempts: 1 as const, cleanupPromise: Promise.resolve() };
      },
      releaseUploadLease: async () => undefined,
    } as unknown as AzureSpeechClient;
    const app = new AppControllerImpl(store, { speech }, { openRouterBatchClient: completingBatchClient(bodies) });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
      speechEnabled: true, speechEndpoint: 'https://example.cognitiveservices.azure.com', audioRetention: 'delete_after_transcription' });
    const original = await app.saveNote({ transcript: 'Original words before failed detach.', audioUri: 'file:///private/retention.m4a', durationSeconds: 8,
      capturedAt: '2026-10-13T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
    const conversation = await app.createChatConversation('Retention failure lineage');
    const plan = await app.prepareChatFromTranscript({ noteId: original.id, expectedRevision: original.revision });
    const accepted = await app.submitChatFromTranscript({ planId: plan.planId, conversationId: conversation.id });
    await app.refreshAssistantBatch(accepted.jobId);

    store.failDetachForTranscript = 'Saved transcript before failed detach.';
    await app.transcribeNote(original.id, { expectedRevision: original.revision });
    expect(app.getSnapshot().notes.find((note) => note.id === original.id)).toMatchObject({
      transcript: 'Saved transcript before failed detach.', audioUri: 'file:///private/retention.m4a',
    });
    expect(app.getSnapshot().transcription.attempts.at(-1)).toMatchObject({ outcome: 'completed', durationMilliseconds: 8_000 });
    expect(app.getSnapshot().usage.transcriptionSeconds).toBe(8);
    const persisted = store.value as AppState & { assistantChatLedger: { conversations: { turns: { reply?: unknown; userText: string }[] }[] } };
    expect(persisted.assistantChatLedger.conversations[0]?.turns[0]).toMatchObject({ userText: original.transcript });
    expect(persisted.assistantChatLedger.conversations[0]?.turns[0]?.reply).toBeUndefined();
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().assistantChatRecoveryStatus?.blocked).not.toBe(true);
    expect(reloaded.getSnapshot().assistantChatConversations?.[0]?.turns[0]?.reply).toBeUndefined();
  });
});
