import { describe, expect, it, vi } from 'vitest';
import * as Crypto from 'expo-crypto';
import { assistantResponseSchema } from '../src/assistant';
import { AppControllerImpl } from '../src/services/controller';
import { validateDispatchRecord } from '../src/dispatch';
import { ConnectorClient, ProviderHttpError, describeMessageWindowQuery, type MessageSummary, type MessageWindowPageMetadata } from '../src/connectors';
import { OpenRouterBatchClient, OpenRouterBatchDispatchError, OpenRouterBatchRequestBuilder, OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_CHAT_COMPLETIONS_PATH, type OpenRouterBatchInspection } from '../src/services/openRouter';
import { parseOpenRouterMailReplyResult, validOpenRouterMailReplyBinding } from '../src/services/openRouterMailReply';
import type { AppState, SelectedMailTextSnapshot } from '../src/core';
import type { StateStore } from '../src/storage/contracts';
import { STATE_SNAPSHOT_READ_MAX_BYTES } from '../src/storage/contracts';

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
  async readCurrentSnapshot() { return this.value ? { raw: JSON.stringify(this.value), schemaVersion: 1 } : undefined; }
  async assertCurrent() {}
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

async function mailFixture(fakeClient: OpenRouterBatchClient, connector: Record<string, unknown> = {}) {
  const text = 'Selected message body for a controlled mail Batch controller fixture.';
  const identity = { providerNamespace: 'google' as const, clientId: 'mail-fixture-client', subject: 'mail-fixture-subject' };
  const identityKey = 'google:mail-fixture-client:mail-fixture-subject:';
  const store = new MemoryStore();
  const integration = { openRouterBatchClient: fakeClient,
    tokenStore: { async get() { return { accessToken: 'fixture-token', expiresAt: Date.now() + 600_000, identity }; }, async set() {} },
    connectorFactory: () => connector as never };
  let app = new AppControllerImpl(store, {}, integration);
  await app.load();
  const state = structuredClone(app.getSnapshot());
  const observedAt = new Date().toISOString();
  const account = { id: 'mail-fixture-account', provider: 'google' as const, displayName: 'Mail', email: 'me@example.test', verifiedEmail: 'me@example.test',
    connected: true, authStatus: 'connected' as const, identity, tokenRef: 'fixture-token-ref', capabilities: ['mail.read' as const],
    grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'], connectionGeneration: 2 };
  const message = { id: 'mail-fixture-local', accountId: account.id, providerMessageId: 'mail-fixture-provider', identityKey: `${identityKey}:mail-fixture-provider`,
    verifiedIdentityKey: identityKey, connectionGeneration: 2, idFormat: 'gmail' as const, threadId: 'mail-fixture-thread', subject: 'Fixture subject',
    from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt, replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [],
    internetMessageId: '<mail-fixture@example.test>', replyMetadataComplete: true, observedAt };
  state.accounts.push(account); state.mailbox.push(message);
  state.settings = { ...state.settings, mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' };
  await store.save(state);
  app = new AppControllerImpl(store, {}, integration);
  await app.load();
  const connectedGeneration = app.getSnapshot().accounts.find((item) => item.id === account.id)!.connectionGeneration ?? 0;
  await (app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
    const current = draft.accounts.find((item) => item.id === account.id)!;
    current.connected = true; current.authStatus = 'connected'; current.capabilities = ['mail.read'];
    current.grantedScopes = ['openid', 'https://www.googleapis.com/auth/gmail.readonly']; current.connectionGeneration = connectedGeneration;
    const row = draft.mailbox.find((item) => item.id === message.id)!;
    row.connectionGeneration = connectedGeneration; row.verifiedIdentityKey = identityKey; row.identityKey = `${identityKey}:${message.providerMessageId}`;
  });
  const source = await app.getMailReplySource(message.id);
  const textDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });
  const selected: SelectedMailTextSnapshot = { version: 1, messageId: message.id, accountId: account.id, identityKey, identity,
    connectionGeneration: connectedGeneration, providerMessageId: message.providerMessageId, idFormat: 'gmail', sourceDigest: source.source!.sourceDigest,
    checkedAt: observedAt, text, textDigest, bytes: new TextEncoder().encode(text).length, extractionVersion: 'mail-text-v1',
    representation: 'plain', completeness: 'complete_text', omissionReasons: [] };
  await (app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => { draft.selectedMailTexts = [selected]; });
  return { app, store, integration, account, message, source, text, textDigest, identity, identityKey };
}

function conversationContextConnector(options: { contextText?: string; contextDraft?: boolean } = {}) {
  const contextText = options.contextText ?? 'Prior thread context body with one useful detail.';
  const reads: string[] = [];
  const contextSummary = { id: 'context-provider-message', idFormat: 'gmail' as const, threadId: 'mail-fixture-thread', subject: 'Earlier detail',
    from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: new Date().toISOString(), sentAt: new Date().toISOString(),
    isDraft: options.contextDraft ?? false, replyMetadataComplete: false, internetMessageId: '<context-fixture@example.test>', providerVersion: 'history-context',
    replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [] as string[] };
  const targetSummary = { id: 'mail-fixture-provider', idFormat: 'gmail' as const, threadId: 'mail-fixture-thread', subject: 'Fixture subject',
    from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: '2026-10-14T00:00:00.000Z', isDraft: false, replyMetadataComplete: true,
    internetMessageId: '<mail-fixture@example.test>', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [] as string[] };
  return { reads, connector: {
    async listConversationMessages() { return { messages: [targetSummary, contextSummary], coverage: 'complete_metadata' as const, omissionReasons: [] }; },
    async readSelectedMessageText(_account: unknown, id: string) {
      reads.push(id);
      const isTarget = id === targetSummary.id;
      const message = isTarget ? targetSummary : { ...contextSummary, replyMetadataComplete: true };
      const text = isTarget ? 'Selected message body for a controlled mail Batch controller fixture.' : contextText;
      return { status: 'available' as const, message, text, bytes: new TextEncoder().encode(text).length,
        representation: isTarget ? 'plain' as const : (options.contextDraft ? 'plain' as const : 'snippet' as const),
        completeness: isTarget ? 'complete_text' as const : 'excerpt' as const,
        reasons: isTarget ? [] : ['provider_excerpt'], checkedAt: new Date().toISOString(), extractionVersion: 'mail-text-v1' as const };
    },
  } };
}

async function completedContextFixture(connector: Record<string, unknown>, complete = true) {
  const inspections: string[] = [];
  const fakeClient = {
    submit: async (_input: unknown, before: () => Promise<void>, assert: () => void) => {
      await before(); assert();
      return { batchId: 'batch_context_observation', status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
        model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
    },
    inspect: async (batchId: string, customId: string) => { inspections.push(customId); return { ...completedInspection(customId, JSON.stringify({ text: 'A careful reviewed reply.' })), batchId }; },
  } as unknown as OpenRouterBatchClient;
  const fixture = await mailFixture(fakeClient, connector);
  const discovery = await fixture.app.discoverMailReplyContext({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest });
  const selected = await fixture.app.loadMailReplyContextMessage({ sessionId: discovery.sessionId, rowId: discovery.rows[0]!.rowId });
  const queued = await fixture.app.submitMailReplyBatch({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest,
    textDigest: fixture.textDigest, mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Reply briefly.', composerRevision: 1,
    contextSelectionIds: [selected.selectionId], contextExcerptSelectionIds: [selected.selectionId] });
  if (complete) await fixture.app.refreshAssistantBatch(queued.id);
  return { ...fixture, queued, inspections };
}

function completedInspection(customId: string, content = JSON.stringify({
  summary: 'A concise summary.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
}), refusal?: unknown): OpenRouterBatchInspection {
  const message = { role: 'assistant', content, ...(refusal === undefined ? {} : { refusal }) };
  return {
    batchId: 'batch_completed_fixture', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0,
    metadataValidation: 'valid', resultValidation: 'valid',
    usage: { cost: 0.001, promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    result: { customId, statusCode: 200, finishReason: 'stop', responseBody: {
      model: OPENROUTER_BATCH_BODY_MODEL,
      choices: [{ index: 0, finish_reason: 'stop', message }],
    } },
  };
}

describe('OpenRouter Batch controller lifecycle', () => {
  it('submits only opaque, explicitly consented conversation excerpts and refreshes every frozen source before activation', async () => {
    const posted: { operationId: string; requestBody: string }[] = [];
    const fakeClient = {
      submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert(); posted.push(input);
        return { batchId: 'batch_context_fixture', status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({ text: 'A careful reviewed reply.' })), batchId }),
    } as unknown as OpenRouterBatchClient;
    const connector = conversationContextConnector();
    const fixture = await mailFixture(fakeClient, connector.connector);
    const discovery = await fixture.app.discoverMailReplyContext({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest });
    expect(discovery.rows).toHaveLength(1);
    expect(discovery.rows[0]?.rowId).not.toBe('context-provider-message');
    expect(JSON.stringify(discovery)).not.toContain('context-provider-message');
    const selected = await fixture.app.loadMailReplyContextMessage({ sessionId: discovery.sessionId, rowId: discovery.rows[0]!.rowId });
    expect(selected).toMatchObject({ completeness: 'excerpt', representation: 'snippet', text: 'Prior thread context body with one useful detail.' });
    const submit = { messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest, textDigest: fixture.textDigest,
      mode: 'reply' as const, to: ['sam@example.test'], cc: [], brief: 'Reply briefly.', composerRevision: 1,
      contextSelectionIds: [selected.selectionId] };
    await expect(fixture.app.submitMailReplyBatch(submit)).rejects.toThrow(/excerpt consent/i);
    expect(posted).toHaveLength(0);
    const queued = await fixture.app.submitMailReplyBatch({ ...submit, contextExcerptSelectionIds: [selected.selectionId] });
    expect(queued.operation).toBe('mail_reply_context');
    expect((await fixture.app.refreshAssistantBatch(queued.id)).status).toBe('completed');
    const stored = fixture.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; operation?: string; requestProfileVersion?: number; mailReplyBinding?: { version: number; context?: { body: { text: string } }[] }; requestBody?: string }[] } };
    const storedJob = stored.openRouterBatchLedger.jobs.find((item) => item.id === queued.id)!;
    expect(storedJob).toMatchObject({ operation: 'mail_reply_context', requestProfileVersion: 3, mailReplyBinding: { version: 2,
      context: [{ body: { text: 'Prior thread context body with one useful detail.' } }] } });
    expect(JSON.parse(storedJob.requestBody!).response_format.json_schema.name).toBe('mail_reply_body');
    expect(validOpenRouterMailReplyBinding({ ...storedJob.mailReplyBinding, version: 1, context: undefined,
      policy: [{ path: 'memory/UNTRUSTED.md', revision: 1, content: 'policy', sha256: 'a'.repeat(64) }] })).toBe(false);
    const evicted = fixture.store.value as AppState;
    evicted.mailbox = evicted.mailbox.filter((item) => item.id !== fixture.message.id);
    evicted.selectedMailTexts = evicted.selectedMailTexts.filter((item) => item.messageId !== fixture.message.id);
    await fixture.store.save(evicted);
    fixture.app = new AppControllerImpl(fixture.store, {}, fixture.integration);
    await fixture.app.load();
    expect(fixture.app.getMailReplyBatchSourcesStatus(queued.id).status).toBe('refresh_required');
    const plan = await fixture.app.reviewMailReplyBatch(queued.id);
    expect(plan.contextMessages).toHaveLength(1);
    expect(fixture.app.getMailReplyBatchSourcesStatus(queued.id).status).toBe('current');
    const readsAfterReview = connector.reads.length;
    const activated = await fixture.app.activateMailReplyBatch({ planId: plan.planId });
    expect(activated.kind).toBe('created');
    expect(connector.reads).toHaveLength(readsAfterReview);
    const restarted = new AppControllerImpl(fixture.store, {}, fixture.integration);
    await restarted.load();
    expect(restarted.getMailReplyBatchSourcesStatus(queued.id).status).toBe('refresh_required');
    await expect(restarted.refreshMailReplyBatchSources(queued.id)).resolves.toMatchObject({ status: 'current', jobId: queued.id });
  });

  it('rejects selected context that becomes a draft during refresh and installs no freshness proof', async () => {
    const fakeClient = {
      submit: async (_input: unknown, before: () => Promise<void>, assert: () => void) => {
        await before(); assert();
        return { batchId: 'batch_context_changed', status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({ text: 'A careful reviewed reply.' })), batchId }),
    } as unknown as OpenRouterBatchClient;
    let contextDraft = false;
    const connector = conversationContextConnector();
    const fixture = await mailFixture(fakeClient, {
      ...connector.connector,
      async readSelectedMessageText(account: unknown, id: string) {
        const result = await connector.connector.readSelectedMessageText(account, id);
        if (id === 'context-provider-message' && contextDraft) result.message.isDraft = true;
        return result;
      },
    });
    const discovery = await fixture.app.discoverMailReplyContext({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest });
    const selected = await fixture.app.loadMailReplyContextMessage({ sessionId: discovery.sessionId, rowId: discovery.rows[0]!.rowId });
    const queued = await fixture.app.submitMailReplyBatch({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest,
      textDigest: fixture.textDigest, mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Reply briefly.', composerRevision: 1,
      contextSelectionIds: [selected.selectionId], contextExcerptSelectionIds: [selected.selectionId] });
    expect((await fixture.app.refreshAssistantBatch(queued.id)).status).toBe('completed');
    contextDraft = true;
    await expect(fixture.app.reviewMailReplyBatch(queued.id)).rejects.toThrow(/draft|changed|source/i);
    expect(fixture.app.getMailReplyBatchSourcesStatus(queued.id).status).toBe('missing');
  });

  it('treats partial target and selected-member inbox observations as unknown when the refreshed provider facts still match', async () => {
    const base = conversationContextConnector();
    const fixture = await completedContextFixture(base.connector);
    const state = fixture.store.value as AppState;
    state.mailbox = state.mailbox.filter((row) => row.providerMessageId !== fixture.message.providerMessageId);
    state.mailbox.push({ id: 'new-partial-target-row', accountId: fixture.account.id, providerMessageId: fixture.message.providerMessageId,
      identityKey: `${fixture.identityKey}:${fixture.message.providerMessageId}`, verifiedIdentityKey: fixture.identityKey,
      connectionGeneration: fixture.account.connectionGeneration, idFormat: 'gmail', threadId: fixture.message.threadId,
      subject: fixture.message.subject, replyMetadataComplete: false, observedAt: new Date().toISOString() });
    state.mailbox.push({ id: 'new-partial-context-row', accountId: fixture.account.id, providerMessageId: 'context-provider-message',
      identityKey: `${fixture.identityKey}:context-provider-message`, verifiedIdentityKey: fixture.identityKey,
      connectionGeneration: fixture.account.connectionGeneration, idFormat: 'gmail', threadId: fixture.message.threadId,
      subject: 'Earlier detail', replyMetadataComplete: false, observedAt: new Date().toISOString() });
    await fixture.store.save(state);
    const reopened = new AppControllerImpl(fixture.store, {}, fixture.integration);
    await reopened.load();
    await expect(reopened.refreshMailReplyBatchSources(fixture.queued.id)).resolves.toMatchObject({ status: 'current' });
  });

  it('invalidates dependent proposals and Batch content when an explicit selected-source read confirms changed content', async () => {
    let contextText = 'Prior thread context body with one useful detail.';
    const base = conversationContextConnector();
    const connector = { ...base.connector, async readSelectedMessageText(account: unknown, id: string) {
      const result = await base.connector.readSelectedMessageText(account, id);
      return id === 'context-provider-message' ? { ...result, text: contextText, bytes: new TextEncoder().encode(contextText).length } : result;
    } };
    const fixture = await completedContextFixture(connector);
    const plan = await fixture.app.reviewMailReplyBatch(fixture.queued.id);
    const activated = await fixture.app.activateMailReplyBatch({ planId: plan.planId });
    const before = fixture.app.getSnapshot().proposals.find((item) => item.id === activated.proposalId)!;
    expect(before.status).toBe('draft');
    contextText = 'The selected context body has changed at the provider.';
    await expect(fixture.app.refreshMailReplyBatchSources(fixture.queued.id)).rejects.toThrow(/changed/i);
    const after = fixture.app.getSnapshot().proposals.find((item) => item.id === activated.proposalId)!;
    expect(after).toMatchObject({ status: 'draft', requiresRebuild: true, approvedPayloadDigest: undefined });
    const savedJob = (fixture.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; mailReplyBinding?: unknown; resultText?: string }[] } })
      .openRouterBatchLedger.jobs.find((item) => item.id === fixture.queued.id)!;
    expect(savedJob).toMatchObject({ status: 'source_removed', sourceRemoved: true,
      accounting: { totalTokens: 17, providerReportedCostUsd: 0.001 } });
    expect(savedJob).not.toHaveProperty('mailReplyBinding');
    expect(savedJob).not.toHaveProperty('resultText');
  });

  it('invalidates dependent replies when an explicit selected-source read confirms provider deletion', async () => {
    let deleted = false;
    const base = conversationContextConnector();
    const connector = { ...base.connector, async readSelectedMessageText(account: unknown, id: string) {
      if (deleted && id === 'context-provider-message') throw new ProviderHttpError(404);
      return base.connector.readSelectedMessageText(account, id);
    } };
    const fixture = await completedContextFixture(connector);
    const plan = await fixture.app.reviewMailReplyBatch(fixture.queued.id);
    const activated = await fixture.app.activateMailReplyBatch({ planId: plan.planId });
    deleted = true;
    await expect(fixture.app.refreshMailReplyBatchSources(fixture.queued.id)).rejects.toThrow(/404|provider request failed/i);
    expect(fixture.app.getSnapshot().proposals.find((item) => item.id === activated.proposalId)).toMatchObject({
      status: 'draft', requiresRebuild: true,
    });
    const savedJob = (fixture.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; status: string; sourceRemoved?: boolean }[] } })
      .openRouterBatchLedger.jobs.find((item) => item.id === fixture.queued.id)!;
    expect(savedJob).toMatchObject({ status: 'source_removed', sourceRemoved: true });
  });

  it('accepts more than twenty short context messages when the frozen request stays within its physical bound', async () => {
    const posted: { operationId: string; requestBody: string }[] = [];
    const fakeClient = {
      submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert(); posted.push(input);
        return { batchId: 'batch_context_many', status: 'validating' as const, endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
      },
    } as unknown as OpenRouterBatchClient;
    const target = { id: 'mail-fixture-provider', idFormat: 'gmail' as const, threadId: 'mail-fixture-thread', subject: 'Fixture subject',
      from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: '2026-10-14T00:00:00.000Z', isDraft: false,
      replyMetadataComplete: true, internetMessageId: '<mail-fixture@example.test>', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [] as string[] };
    const messages = Array.from({ length: 21 }, (_, index) => ({ id: `short-context-${index}`, idFormat: 'gmail' as const,
      threadId: target.threadId, subject: `Earlier ${index}`, from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test',
      receivedAt: new Date(Date.parse(target.receivedAt) - (index + 1) * 60_000).toISOString(), isDraft: false, replyMetadataComplete: false,
      internetMessageId: `<short-context-${index}@example.test>`, providerVersion: `short-${index}`, replyTo: ['sam@example.test'],
      to: ['me@example.test'], cc: [] as string[] }));
    const connector = {
      async listConversationMessages() { return { messages: [target, ...messages], coverage: 'complete_metadata' as const, omissionReasons: [] }; },
      async readSelectedMessageText(_account: unknown, id: string) {
        const message = id === target.id ? target : { ...messages.find((item) => item.id === id)!, replyMetadataComplete: true };
        const text = id === target.id ? 'Selected message body for a controlled mail Batch controller fixture.' : `Short context ${id}.`;
        return { status: 'available' as const, message, text, bytes: new TextEncoder().encode(text).length, representation: 'plain' as const,
          completeness: 'complete_text' as const, reasons: [], checkedAt: new Date().toISOString(), extractionVersion: 'mail-text-v1' as const };
      },
    };
    const fixture = await mailFixture(fakeClient, connector);
    const discovery = await fixture.app.discoverMailReplyContext({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest });
    expect(discovery.rows).toHaveLength(21);
    const selected = [];
    for (const row of discovery.rows) selected.push(await fixture.app.loadMailReplyContextMessage({ sessionId: discovery.sessionId, rowId: row.rowId }));
    const queued = await fixture.app.submitMailReplyBatch({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest,
      textDigest: fixture.textDigest, mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Reply briefly.', composerRevision: 1,
      contextSelectionIds: selected.map((item) => item.selectionId) });
    expect(queued.mailReplyContextCount).toBe(21);
    expect(posted).toHaveLength(1);
  });

  it('ignores a first inbox observation of an unselected message but retires a changed first observation of a selected member', async () => {
    const createSyncConnector = (id: string, subject: string) => {
      const base = conversationContextConnector();
      const summary = { id, idFormat: 'gmail' as const, threadId: 'mail-fixture-thread', subject, from: 'Sam <sam@example.test>',
        senderEmail: 'sam@example.test', receivedAt: '2026-10-14T00:00:00.000Z', isDraft: false, replyMetadataComplete: true,
        internetMessageId: `<${id}@example.test>`, providerVersion: 'inbox-observation', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [] as string[] };
      return { ...base.connector, async syncMessageWindow(_account: unknown, options: { timeMin: string; timeMax: string; pageSize: number;
        onPage?: (items: MessageSummary[], cursor: string | undefined, count: number, metadata: MessageWindowPageMetadata) => void | Promise<void> }) {
        const descriptor = describeMessageWindowQuery(_account as never, { timeMin: options.timeMin, timeMax: options.timeMax, pageSize: options.pageSize });
        const metadata = { unavailableIds: [], window: { from: descriptor.window.from, to: descriptor.window.to }, queryFingerprint: descriptor.queryFingerprint };
        await options.onPage?.([summary], undefined, 1, metadata);
        return { items: [summary] as MessageSummary[], pagesRead: 1, partial: false, window: descriptor.window, queryFingerprint: descriptor.queryFingerprint, unavailableIds: [] };
      } } as unknown as Record<string, unknown>;
    };

    const unrelated = await completedContextFixture(createSyncConnector('unselected-first-observation', 'Unselected subject'));
    await unrelated.app.refreshMailHead(unrelated.account.id, { reason: 'manual' });
    const unrelatedJob = (unrelated.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; mailReplyBinding?: unknown }[] } })
      .openRouterBatchLedger.jobs.find((item) => item.id === unrelated.queued.id)!;
    expect(unrelatedJob.mailReplyBinding).toBeTruthy();

    const selected = await completedContextFixture(createSyncConnector('context-provider-message', 'Changed selected subject'));
    await selected.app.refreshMailHead(selected.account.id, { reason: 'manual' });
    const selectedJob = (selected.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; mailReplyBinding?: unknown }[] } })
      .openRouterBatchLedger.jobs.find((item) => item.id === selected.queued.id)!;
    expect(selectedJob.mailReplyBinding).toBeUndefined();

    const target = await completedContextFixture(createSyncConnector('mail-fixture-provider', 'Changed target subject'));
    await (target.app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
      draft.mailbox = draft.mailbox.filter((row) => row.id !== target.message.id);
    });
    await target.app.refreshMailHead(target.account.id, { reason: 'manual' });
    const targetJob = (target.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; mailReplyBinding?: unknown }[] } })
      .openRouterBatchLedger.jobs.find((item) => item.id === target.queued.id)!;
    expect(targetJob.mailReplyBinding).toBeUndefined();
  });

  it('rejects a tampered frozen context digest before reading Batch results', async () => {
    const base = conversationContextConnector();
    const fixture = await completedContextFixture(base.connector, false);
    const stored = fixture.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; mailReplyBinding?: { context?: { body: { textDigest: string } }[] } }[] } };
    const job = stored.openRouterBatchLedger.jobs.find((item) => item.id === fixture.queued.id)!;
    job.mailReplyBinding!.context![0]!.body.textDigest = 'f'.repeat(64);
    await fixture.store.save(stored);
    const restarted = new AppControllerImpl(fixture.store, {}, fixture.integration);
    await restarted.load();
    await expect(restarted.refreshAssistantBatch(fixture.queued.id)).resolves.toMatchObject({ status: 'result_invalid', unknownCharge: true });
    expect(fixture.inspections).toHaveLength(0);
  });

  it('does not let a stale refresh release a newer refresh ticket after privacy bootstrap', async () => {
    const base = conversationContextConnector();
    const read = base.connector.readSelectedMessageText as unknown as (account: unknown, id: string, options?: { guard?: () => void }) => Promise<{
      status: 'available'; message: Record<string, unknown>; text: string; bytes: number; representation: 'plain' | 'snippet';
      completeness: 'complete_text' | 'excerpt'; reasons: string[]; checkedAt: string; extractionVersion: 'mail-text-v1';
    }>;
    const gates = [0, 1].map(() => {
      let release: () => void = () => {};
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release };
    });
    let armed = false;
    let targetReads = 0;
    const connector = { ...base.connector, async readSelectedMessageText(account: unknown, id: string, options?: { guard?: () => void }) {
      if (armed && id === 'mail-fixture-provider' && targetReads < gates.length) {
        const gateIndex = targetReads++;
        const gate = gates[gateIndex];
        await gate.promise;
        if (gateIndex === 0) throw new ProviderHttpError(404);
        options?.guard?.();
      }
      return read(account, id, options);
    } };
    const fixture = await completedContextFixture(connector as unknown as Record<string, unknown>);
    armed = true;
    const first = fixture.app.refreshMailReplyBatchSources(fixture.queued.id);
    await vi.waitFor(() => expect(targetReads).toBe(1));
    await fixture.app.disposeForPrivacy();
    await fixture.app.load();
    const second = fixture.app.refreshMailReplyBatchSources(fixture.queued.id);
    await vi.waitFor(() => expect(targetReads).toBe(2));
    gates[0]!.release();
    await expect(first).rejects.toThrow(/changed|refresh|workspace/i);
    const stillOwned = (fixture.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; mailReplyBinding?: unknown }[] } })
      .openRouterBatchLedger.jobs.find((item) => item.id === fixture.queued.id)!;
    expect(stillOwned.mailReplyBinding).toBeTruthy();
    await expect(fixture.app.refreshMailReplyBatchSources(fixture.queued.id)).rejects.toThrow(/already running/i);
    gates[1]!.release();
    await expect(second).resolves.toMatchObject({ status: 'current', jobId: fixture.queued.id });
  });

  it('reviews and executes an aged context reply through the actual connector without changing its frozen observation window', async () => {
    const base = conversationContextConnector();
    const fixture = await completedContextFixture(base.connector);
    const accountIdentity = fixture.account.identity!;
    const writePaths: string[] = [];
    const actualConnector = new ConnectorClient({
      tokenStore: { async get() { return { accessToken: 'fixture-access', expiresAt: Date.now() + 60 * 60_000, identity: accountIdentity }; }, async set() {} },
      googleClientId: accountIdentity.clientId,
      fetcher: async (input: RequestInfo | URL) => {
        const url = new URL(String(input)); writePaths.push(url.pathname);
        return new Response(JSON.stringify({ id: 'fixture-created-draft', message: { id: 'fixture-message', threadId: fixture.message.threadId } }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    Object.assign(base.connector, { createDraft: (account: Parameters<ConnectorClient['createDraft']>[0], envelope: Parameters<ConnectorClient['createDraft']>[1], verifier: Parameters<ConnectorClient['createDraft']>[2]) =>
      actualConnector.createDraft(account, envelope, verifier) });
    await (fixture.app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
      const account = draft.accounts.find((item) => item.id === fixture.account.id)!;
      account.capabilities = ['mail.read', 'mail.draft'];
      account.grantedScopes = ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
    });
    const stored = fixture.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; mailReplyBinding: { source: { observedAt: string } } }[] } };
    const frozenJob = stored.openRouterBatchLedger.jobs.find((item) => item.id === fixture.queued.id)!;
    const originalObservedAt = frozenJob.mailReplyBinding.source.observedAt;
    const originalExpiresAt = new Date(Date.parse(originalObservedAt) + 15 * 60_000).toISOString();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.parse(originalObservedAt) + 16 * 60_000));
      const plan = await fixture.app.reviewMailReplyBatch(fixture.queued.id);
      const activated = await fixture.app.activateMailReplyBatch({ planId: plan.planId });
      const proposal = fixture.app.getSnapshot().proposals.find((item) => item.id === activated.proposalId)!;
      expect(proposal.provenance).toMatchObject({ version: 2, source: { observedAt: originalObservedAt }, expiresAt: originalExpiresAt });
      const approved = await fixture.app.approveProposal(proposal.id, { expectedRevision: proposal.revision });
      expect(approved.status).toBe('approved');
      vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
      await expect(fixture.app.executeProposal(approved.id, { expectedRevision: approved.revision })).rejects.toThrow(/refresh.*approve/i);
      const expired = fixture.app.getSnapshot().proposals.find((item) => item.id === approved.id)!;
      expect(expired).toMatchObject({ status: 'draft', requiresRebuild: false, approvedRevision: undefined, approvedPayloadDigest: undefined });
      expect(writePaths.filter((path) => path.endsWith('/drafts'))).toHaveLength(0);
      expect(fixture.app.getMailReplyBatchSourcesStatus(fixture.queued.id).status).toBe('refresh_required');
      await fixture.app.refreshMailReplyBatchSources(fixture.queued.id);
      const reapproved = await fixture.app.approveProposal(expired.id, { expectedRevision: expired.revision });
      const executed = await fixture.app.executeProposal(reapproved.id, { expectedRevision: reapproved.revision });
      expect(reapproved.status).toBe('approved');
      expect(executed).toMatchObject({ status: 'accepted', remoteId: 'fixture-created-draft' });
      expect(writePaths.filter((path) => path.endsWith('/drafts'))).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('keeps a retired reply source fenced after proposal deletion and same-identity reconnect', async () => {
    const fixture = await mailFixture(client());
    const { app, store, integration, message, source, identityKey } = fixture;
    const recoveryIntegration = { ...integration, privacySession: { epoch: 'mail-recovery-test', async assertCurrent() {}, async getStatus() {
      return { phase: 'ready' as const, epoch: 'mail-recovery-test', activeWriterCount: 0, pendingCleanupCount: 0, failedCleanupCount: 0,
        limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096, writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 },
        coverage: 'tracked_with_legacy_limits' as const };
    } } };
    const draft = await app.createMailReplyProposal({ messageId: message.id, mode: 'reply', sourceDigest: source.source!.sourceDigest, text: 'Draft reply.' });
    const send = await app.createMailReplyProposal({ messageId: message.id, mode: 'reply_all', sourceDigest: source.source!.sourceDigest, text: 'Send reply.' });

    const raw = store.value as AppState & { dispatchRecordQuarantine?: unknown; dispatchRecords: unknown[] };
    raw.proposals.find((item) => item.id === send.id)!.email!.operation = 'send';
    raw.dispatchRecords = [{ id: 'bad-mail-receipt', raw: 'private' }] as never;
    raw.dispatchRecordQuarantine = { opaque: 'uncertain provider receipt' };
    await store.save(raw);
    const recovery = new AppControllerImpl(store, {}, recoveryIntegration);
    await recovery.load();
    const plan = await recovery.prepareDispatchRecovery();
    await recovery.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' });

    // The action tombstone outlives both generated proposal rows and the local
    // connection generation, while the provider identity remains the same.
    const reconnected = store.value as AppState;
    reconnected.proposals = reconnected.proposals.filter((item) => item.id !== draft.id && item.id !== send.id);
    const savedAccount = reconnected.accounts.find((item) => item.id === message.accountId)!;
    savedAccount.connectionGeneration = (savedAccount.connectionGeneration ?? 0) + 1;
    reconnected.mailbox.find((item) => item.id === message.id)!.connectionGeneration = savedAccount.connectionGeneration;
    await store.save(reconnected);
    const reopened = new AppControllerImpl(store, {}, recoveryIntegration);
    await reopened.load();
    const currentSource = await reopened.getMailReplySource(message.id);
    expect(currentSource.status).toBe('current');
    expect(identityKey).toBe('google:mail-fixture-client:mail-fixture-subject:');
    await expect(reopened.createMailReplyProposal({ messageId: message.id, mode: 'reply', sourceDigest: currentSource.source!.sourceDigest, text: 'Another draft.' }))
      .rejects.toThrow(/retired during dispatch recovery/);
    await expect(reopened.createMailReplyProposal({ messageId: message.id, mode: 'reply_all', sourceDigest: currentSource.source!.sourceDigest, text: 'Another send.' }))
      .rejects.toThrow(/retired during dispatch recovery/);

    const freshMessage = { ...message, id: 'fresh-after-recovery', providerMessageId: 'fresh-after-recovery-provider',
      identityKey: `${identityKey}:fresh-after-recovery-provider`, subject: 'Independent message',
      internetMessageId: '<fresh-after-recovery@example.test>', connectionGeneration: savedAccount.connectionGeneration };
    reconnected.mailbox.push(freshMessage);
    await store.save(reconnected);
    const freshApp = new AppControllerImpl(store, {}, recoveryIntegration);
    await freshApp.load();
    const freshSource = await freshApp.getMailReplySource(freshMessage.id);
    expect(freshSource.status).toBe('current');
    await expect(freshApp.createMailReplyProposal({ messageId: freshMessage.id, mode: 'reply', sourceDigest: freshSource.source!.sourceDigest,
      text: 'A new message has an independent action.' })).resolves.toMatchObject({ status: 'draft' });
  });

  it('commits a fresh mailbox observation while archived uncertainty retains the linked Batch context', async () => {
    let connectorAccount: Parameters<typeof describeMessageWindowQuery>[0] | undefined;
    const connector = { async syncMessageWindow(account: Parameters<typeof describeMessageWindowQuery>[0], options: {
      timeMin: string; timeMax: string; pageSize?: number;
      onPage?: (items: unknown[], cursor: undefined, pages: number, metadata: { unavailableIds: string[]; window: { from: string; to: string }; queryFingerprint: string }) => unknown;
    }) {
      connectorAccount = account;
      const descriptor = describeMessageWindowQuery(account, { timeMin: options.timeMin, timeMax: options.timeMax, pageSize: options.pageSize });
      const summary = { id: 'mail-fixture-provider', idFormat: 'gmail' as const, subject: 'Freshly observed subject',
        receivedAt: '2026-10-14T02:00:00.000Z', senderEmail: 'sam@example.test', isRead: false,
        replyMetadataComplete: true, internetMessageId: '<mail-fixture@example.test>', to: ['me@example.test'] };
      await options.onPage?.([summary], undefined, 1, { unavailableIds: [], window: descriptor.window, queryFingerprint: descriptor.queryFingerprint });
      return { items: [summary], nextCursor: undefined, pagesRead: 1, partial: false, window: descriptor.window,
        queryFingerprint: descriptor.queryFingerprint, unavailableIds: [] };
    } };
    const fixture = await mailFixture(client(), connector);
    const { app, store, integration, message, source, textDigest, account } = fixture;
    const job = await app.submitMailReplyBatch({ messageId: message.id, sourceDigest: source.source!.sourceDigest, textDigest,
      mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Preserve this pending request during source observation.', composerRevision: 1 });
    const raw = store.value as AppState & { dispatchRecordQuarantine?: unknown; dispatchRecords: unknown[] };
    raw.dispatchRecords = [{ id: 'bad-observation-receipt', raw: 'opaque' }] as never;
    raw.dispatchRecordQuarantine = { sentinel: 'unresolved-observation-receipt' };
    await store.save(raw);
    const privacySession = { epoch: 'mail-observation-recovery', async assertCurrent() {}, async getStatus() {
      return { phase: 'ready' as const, epoch: 'mail-observation-recovery', activeWriterCount: 0, pendingCleanupCount: 0, failedCleanupCount: 0,
        limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096, writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 },
        coverage: 'tracked_with_legacy_limits' as const };
    } };
    const recoveryIntegration = { ...integration, privacySession };
    const recovering = new AppControllerImpl(store, {}, recoveryIntegration);
    await recovering.load();
    const plan = await recovering.prepareDispatchRecovery();
    await recovering.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' });

    const before = store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
    const retainedBefore = before.openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
    expect(retainedBefore).toHaveProperty('requestBody');
    const observed = await recovering.refreshMailHead(account.id);
    expect(observed).toMatchObject({ status: 'complete', lane: 'head' });
    expect(connectorAccount?.id).toBe(account.id);
    expect(recovering.getSnapshot().mailbox.find((item) => item.id === message.id)?.subject).toBe('Freshly observed subject');
    const after = store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
    expect(after.openRouterBatchLedger.jobs.find((item) => item.id === job.id)).toEqual(retainedBefore);
    expect(recovering.getDispatchRecoveryStatus().unresolvedReceiptCount).toBeGreaterThan(0);
  });

  it('fails closed for simulated-flag mail proposals that could still be approved or remotely executed', async () => {
    let providerWrites = 0;
    const connector = { async createDraft() { providerWrites += 1; return { status: 'accepted' as const, id: 'draft-accepted' }; },
      async sendEmail() { providerWrites += 1; return { status: 'accepted' as const, id: 'message-accepted' }; } };
    const fixture = await mailFixture(client(), connector);
    const { app, store, integration, message, source, identity } = fixture;
    const draft = await app.createMailReplyProposal({ messageId: message.id, mode: 'reply', sourceDigest: source.source!.sourceDigest, text: 'Review this draft.' });
    const approved = await app.createMailReplyProposal({ messageId: message.id, mode: 'reply_all', sourceDigest: source.source!.sourceDigest, text: 'Review this send.' });
    await (app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> }).mutate((state) => {
      const account = state.accounts.find((item) => item.id === message.accountId)!;
      account.capabilities = ['mail.read', 'mail.draft', 'mail.send'];
      account.grantedScopes = ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify'];
    });
    await app.approveProposal(approved.id);
    const raw = store.value as AppState & { dispatchRecoveryArchives?: unknown };
    raw.proposals.find((item) => item.id === draft.id)!.simulated = true;
    raw.proposals.find((item) => item.id === approved.id)!.simulated = true;
    raw.dispatchRecoveryArchives = { version: 1, entries: [{ operationId: 'malformed-archive' }] };
    await store.save(raw);
    const privacySession = { epoch: 'simulated-guard-test', async assertCurrent() {}, async getStatus() {
      return { phase: 'ready' as const, epoch: 'simulated-guard-test', activeWriterCount: 0, pendingCleanupCount: 0, failedCleanupCount: 0,
        limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096, writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 },
        coverage: 'tracked_with_legacy_limits' as const };
    } };
    const guarded = new AppControllerImpl(store, {}, { ...integration, privacySession });
    await guarded.load();
    await expect(guarded.approveProposal(draft.id)).rejects.toThrow(/integrity validation|archive_invalid/i);
    await expect(guarded.executeProposal(approved.id)).rejects.toThrow(/integrity validation|archive_invalid/i);
    expect(providerWrites).toBe(0);
    expect(identity.providerNamespace).toBe('google');

    const previewFixture = await mailFixture(client());
    const previewDraft = await previewFixture.app.createMailReplyProposal({ messageId: previewFixture.message.id, mode: 'reply',
      sourceDigest: previewFixture.source.source!.sourceDigest, text: 'Preview-only source action.' });
    await (previewFixture.app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> }).mutate((state) => {
      const account = state.accounts.find((item) => item.id === previewFixture.message.accountId)!;
      account.capabilities = ['mail.read', 'mail.draft'];
      account.grantedScopes = ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
    });
    const previewState = previewFixture.store.value as AppState;
    previewState.proposals.find((item) => item.id === previewDraft.id)!.simulated = true;
    await previewFixture.store.save(previewState);
    const previewApp = new AppControllerImpl(previewFixture.store, {}, previewFixture.integration);
    await previewApp.load();
    await expect(previewApp.approveProposal(previewDraft.id)).resolves.toMatchObject({ status: 'approved' });
  });

  it('preserves mail Batch history across account revocation and safely attaches a late owned POST acknowledgement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T03:00:00.000Z'));
    try {
      let releaseBeforePersist!: () => void;
      let beforePersistEntered!: () => void;
      const beforePersistGate = new Promise<void>((resolve) => { releaseBeforePersist = resolve; });
      const beforePersistStarted = new Promise<void>((resolve) => { beforePersistEntered = resolve; });
      let prePostCalls = 0;
      const prePostClient = {
        submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
          beforePersistEntered(); await beforePersistGate;
          try { await before(); } catch { throw new OpenRouterBatchDispatchError('pre_dispatch', 'The saved note changed before Batch submission.'); }
          assert(); prePostCalls += 1;
          return { batchId: 'must-not-post', status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
            model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
        },
      } as unknown as OpenRouterBatchClient;
      const prePost = await mailFixture(prePostClient);
      const beforePostAttempt = prePost.app.submitMailReplyBatch({ messageId: prePost.message.id, sourceDigest: prePost.source.source!.sourceDigest,
        textDigest: prePost.textDigest, mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Before POST revocation.', composerRevision: 1 });
      await beforePersistStarted;
      const revokedBeforePost = await prePost.app.disconnectAccount(prePost.account.id);
      expect(revokedBeforePost.connected).toBe(false);
      releaseBeforePersist();
      await expect(beforePostAttempt).rejects.toThrow(/changed before Batch submission/i);
      expect(prePostCalls).toBe(0);
      const prePostJob = prePost.app.getSnapshot().assistantBatchJobs?.[0];
      expect(prePostJob).toMatchObject({ status: 'failed', failureCode: 'not_submitted', unknownCharge: false });
      const prePostReload = new AppControllerImpl(prePost.store, {}, prePost.integration);
      await prePostReload.load();
      expect(prePostReload.getSnapshot().assistantBatchJobs?.[0]).toMatchObject({ status: 'failed', failureCode: 'not_submitted', unknownCharge: false });

      let releasePost!: () => void;
      let postStarted!: () => void;
      const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
      const postHasStarted = new Promise<void>((resolve) => { postStarted = resolve; });
      let postCalls = 0;
      let inspectCalls = 0;
      const lateAckClient = {
        submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
          await before(); assert(); postCalls += 1; postStarted(); await postGate;
          return { batchId: 'mail_late_ack', status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
            model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
        },
        inspect: async (_batchId: string, customId: string) => {
          inspectCalls += 1;
          return { ...completedInspection(customId, JSON.stringify({ text: 'Saved after the late acknowledgement.' }), null), batchId: 'mail_late_ack' };
        },
      } as unknown as OpenRouterBatchClient;
      const late = await mailFixture(lateAckClient);
      const pending = late.app.submitMailReplyBatch({ messageId: late.message.id, sourceDigest: late.source.source!.sourceDigest,
        textDigest: late.textDigest, mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'POST already started.', composerRevision: 1 });
      await postHasStarted;
      const revoked = await late.app.disconnectAccount(late.account.id);
      expect(revoked).toMatchObject({ connected: false, connectionGeneration: expect.any(Number) });
      const submitting = late.app.getSnapshot().assistantBatchJobs?.find((item) => item.status === 'submitting');
      expect(submitting).toBeDefined();
      releasePost();
      const queued = await pending;
      expect(queued).toMatchObject({ status: 'queued', unknownCharge: true });
      const lateLedger = (late.store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; status: string; batchId?: string; unknownCharge: boolean }[] } }).openRouterBatchLedger;
      expect(lateLedger.jobs.find((item) => item.id === queued.id)).toMatchObject({ status: 'queued', batchId: 'mail_late_ack', unknownCharge: true });
      expect(postCalls).toBe(1);
      expect(late.store.value?.accounts.find((item) => item.id === late.account.id)?.connected).toBe(false);
      expect(late.store.value?.accounts.find((item) => item.id === late.account.id)?.connectionGeneration).toBeGreaterThan(late.account.connectionGeneration ?? 0);
      expect(late.app.getSnapshot().assistantBatchJobs?.find((item) => item.id === queued.id)).toMatchObject({ status: 'queued' });
      const check = await late.app.refreshAssistantBatch(queued.id);
      expect(check).toMatchObject({ status: 'completed', providerReportedCostUsd: 0.001 });
      expect(inspectCalls).toBe(1);
      const restarted = new AppControllerImpl(late.store, {}, late.integration);
      await restarted.load();
      expect(restarted.getSnapshot().assistantBatchJobs?.find((item) => item.id === queued.id)).toMatchObject({ status: 'completed', providerReportedCostUsd: 0.001 });
      await expect(restarted.reviewMailReplyBatch(queued.id)).rejects.toThrow(/changed|unavailable/i);

      let releaseUnknown!: () => void;
      let unknownPostStarted!: () => void;
      let unknownInspectCalls = 0;
      const unknownGate = new Promise<void>((resolve) => { releaseUnknown = resolve; });
      const unknownStarted = new Promise<void>((resolve) => { unknownPostStarted = resolve; });
      const unknownClient = {
        submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
          await before(); assert(); unknownPostStarted(); await unknownGate;
          throw new OpenRouterBatchDispatchError('unknown', 'The provider POST outcome is unknown.');
        },
        inspect: async () => { unknownInspectCalls += 1; throw new Error('No provider inspection is allowed without a saved batch ID.'); },
      } as unknown as OpenRouterBatchClient;
      const unknown = await mailFixture(unknownClient);
      const unknownPending = unknown.app.submitMailReplyBatch({ messageId: unknown.message.id, sourceDigest: unknown.source.source!.sourceDigest,
        textDigest: unknown.textDigest, mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Unknown POST outcome.', composerRevision: 1 });
      await unknownStarted;
      await unknown.app.disconnectAccount(unknown.account.id);
      releaseUnknown();
      await expect(unknownPending).rejects.toThrow(/outcome is unknown/i);
      const unknownJob = (unknown.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
      expect(unknownJob).toMatchObject({ status: 'submission_unknown', unknownCharge: true });
      expect(unknownJob).not.toHaveProperty('batchId');
      const unknownReload = new AppControllerImpl(unknown.store, {}, unknown.integration);
      await unknownReload.load();
      expect(unknownReload.getSnapshot().assistantBatchJobs?.[0]).toMatchObject({ status: 'submission_unknown', unknownCharge: true });
      expect(await unknownReload.refreshAssistantBatch(unknownJob.id as string)).toMatchObject({ status: 'submission_unknown', unknownCharge: true });
      expect(unknownInspectCalls).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('captures mail submission inputs before awaiting and admits only one POST per selected message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T02:00:00.000Z'));
    try {
      let submitStarted!: () => void;
      let releaseSubmit!: () => void;
      const started = new Promise<void>((resolve) => { submitStarted = resolve; });
      const postGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
      const bodies: Record<string, unknown>[] = [];
      const text = 'The selected message body is frozen for this explicit request.';
      let providerVersion: string | undefined;
      let providerDeletionObserved = false;
      let selectedTextReads = 0;
      const connector = { async readSelectedMessageText(_account: unknown, providerMessageId: string) {
        selectedTextReads += 1;
        return { status: 'available', message: { id: providerMessageId, idFormat: 'gmail' as const, threadId: 'batch-mail-thread', subject: 'Frozen subject',
          from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: new Date().toISOString(), replyMetadataComplete: true,
          internetMessageId: '<batch-mail@example.test>', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [], ...(providerVersion ? { providerVersion } : {}) }, text,
          bytes: new TextEncoder().encode(text).length, representation: 'plain' as const, completeness: 'complete_text' as const,
          reasons: [], checkedAt: new Date().toISOString(), extractionVersion: 'mail-text-v1' as const };
      }, async createDraft(_account: unknown, envelope: Record<string, unknown>, verifier: { verify(value: never): Promise<boolean>; verifyBeforeDispatch(value: never): boolean }) {
        expect(envelope.replySource).toMatchObject({ version: 2, kind: 'mail_reply' });
        expect(await verifier.verify(envelope as never)).toBe(true);
        expect(verifier.verifyBeforeDispatch(envelope as never)).toBe(true);
        return { status: 'unknown' as const };
      }, async syncMessageWindow(account: Parameters<typeof describeMessageWindowQuery>[0], options: Record<string, unknown>) {
        const query = describeMessageWindowQuery(account, { timeMin: options.timeMin as string, timeMax: options.timeMax as string, pageSize: options.pageSize as number });
        const existing = { id: 'batch-mail-provider', idFormat: 'gmail' as const, threadId: 'batch-mail-thread', subject: 'Frozen subject',
          from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: new Date().toISOString(), replyMetadataComplete: true,
          internetMessageId: '<batch-mail@example.test>', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [], providerVersion: 'mail-page-version' };
        const unrelated = { ...existing, id: 'batch-mail-unrelated-provider', threadId: 'unrelated-thread', subject: 'Unrelated new message',
          internetMessageId: '<unrelated@example.test>' };
        const onPage = options.onPage as (items: unknown[], cursor: string | undefined, pagesRead: number, metadata: unknown) => Promise<void>;
        const metadata = { unavailableIds: providerDeletionObserved ? ['batch-mail-provider'] : [], window: query.window, queryFingerprint: query.queryFingerprint };
        const firstPage = providerDeletionObserved ? [unrelated] : [existing, unrelated];
        await onPage(firstPage, 'next-page-cursor', 1, metadata);
        await onPage(providerDeletionObserved ? [unrelated] : [existing], undefined, 2, metadata);
        return { items: firstPage, nextCursor: undefined, partial: false, window: query.window,
          queryFingerprint: query.queryFingerprint, unavailableIds: metadata.unavailableIds };
      } };
      const fakeClient = {
        submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
          await before(); assert(); bodies.push(JSON.parse(input.requestBody) as Record<string, unknown>); submitStarted(); await postGate;
          return { batchId: 'mail_batch_once', status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
            model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
        },
        inspect: async (_batchId: string, customId: string) => ({ batchId: 'mail_batch_once', status: 'completed', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 1, failed: 0, metadataValidation: 'valid', resultValidation: 'valid',
          usage: { cost: 0.001, promptTokens: 10, completionTokens: 4, totalTokens: 14 }, result: { customId, statusCode: 200, finishReason: 'stop',
            responseBody: { model: 'openai/gpt-6-luna-20260922', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', refusal: null, content: JSON.stringify({ text: 'Draft for explicit review.' }) } }] } } }),
      } as unknown as OpenRouterBatchClient;
      const integration = { openRouterBatchClient: fakeClient,
        tokenStore: { async get() { return { accessToken: 'fixture-token', expiresAt: Date.now() + 600_000,
          identity: { providerNamespace: 'google' as const, clientId: 'batch-mail-client', subject: 'batch-mail-subject' } }; }, async set() {} },
        connectorFactory: () => connector as never };
      const store = new MemoryStore();
      let app = new AppControllerImpl(store, {}, integration);
      await app.load();
      const identity = { providerNamespace: 'google' as const, clientId: 'batch-mail-client', subject: 'batch-mail-subject' };
      Object.assign(identity, { issuer: undefined, tenantId: undefined, resourceUserId: undefined });
      const identityKey = 'google:batch-mail-client:batch-mail-subject:';
      const textDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });
      const observedAt = new Date().toISOString();
      const state = structuredClone(app.getSnapshot());
      const account = { id: 'batch-mail-account', provider: 'google' as const, displayName: 'Mail', email: 'me@example.test', verifiedEmail: 'me@example.test',
        connected: true, authStatus: 'connected' as const, identity, tokenRef: 'fixture-token-ref', capabilities: ['mail.read' as const],
        grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'], connectionGeneration: 2 };
      const message = { id: 'batch-mail-local', accountId: account.id, providerMessageId: 'batch-mail-provider', identityKey: `${identityKey}:batch-mail-provider`,
        verifiedIdentityKey: identityKey, connectionGeneration: 2, idFormat: 'gmail' as const, threadId: 'batch-mail-thread', subject: 'Frozen subject',
        from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt, replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [],
        internetMessageId: '<batch-mail@example.test>', replyMetadataComplete: true, observedAt };
      state.accounts.push(account);
      state.mailbox.push(message);
      state.settings = { ...state.settings, mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' };
      await store.save(state);
      app = new AppControllerImpl(store, {}, integration);
      await app.load();
      await (app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
        Object.assign(draft.accounts.find((item) => item.id === account.id)!.identity!, { issuer: undefined, tenantId: undefined, resourceUserId: undefined });
      });
      const loadedAccount = app.getSnapshot().accounts.find((item) => item.id === account.id)!;
      const connectedGeneration = loadedAccount.connectionGeneration ?? 0;
      await (app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
        const current = draft.accounts.find((item) => item.id === account.id)!;
        current.connected = true; current.authStatus = 'connected'; current.capabilities = ['mail.read', 'mail.draft'];
        current.grantedScopes = ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
        current.connectionGeneration = connectedGeneration;
        const row = draft.mailbox.find((item) => item.id === message.id)!;
        row.connectionGeneration = connectedGeneration; row.verifiedIdentityKey = identityKey;
        row.identityKey = `${identityKey}:${message.providerMessageId}`;
      });
      const source = await app.getMailReplySource(message.id);
      expect(source.status).toBe('current');
      const selected: SelectedMailTextSnapshot = { version: 1, messageId: message.id, accountId: account.id, identityKey, identity,
        connectionGeneration: connectedGeneration, providerMessageId: message.providerMessageId, idFormat: 'gmail', sourceDigest: source.source!.sourceDigest,
        checkedAt: observedAt, text, textDigest, bytes: new TextEncoder().encode(text).length, extractionVersion: 'mail-text-v1',
        representation: 'plain', completeness: 'complete_text', omissionReasons: [] };
      const internal = app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> };
      await internal.mutate((draft) => { draft.selectedMailTexts = [selected]; });
      const mutableInput = { messageId: message.id, sourceDigest: source.source!.sourceDigest, textDigest, mode: 'reply' as const,
        to: ['sam@example.test'], cc: [] as string[], brief: 'Keep the frozen brief.', composerRevision: 1 };
      const pending = app.submitMailReplyBatch(mutableInput);
      mutableInput.brief = 'Mutated after the call began.';
      mutableInput.to[0] = 'changed@example.test';
      await started;
      await expect(app.submitMailReplyBatch({ ...mutableInput })).rejects.toThrow(/still settling/i);
      expect(JSON.stringify(bodies[0])).toContain('Keep the frozen brief.');
      expect(JSON.stringify(bodies[0])).toContain('sam@example.test');
      expect(JSON.stringify(bodies[0])).not.toContain('Mutated after the call began.');
      expect(JSON.stringify(bodies[0])).not.toContain('changed@example.test');
      releaseSubmit();
      const job = await pending;
      expect(job).toMatchObject({ status: 'queued', mailMessageId: message.id });
      expect(bodies).toHaveLength(1);
      const nullRefusal = completedInspection(job.id, JSON.stringify({ text: 'Strict mail reply body.' }), null);
      expect(parseOpenRouterMailReplyResult(nullRefusal, JSON.stringify(bodies[0])).text).toBe('Strict mail reply body.');
      const nonNullRefusal = { ...nullRefusal, result: { ...nullRefusal.result!, responseBody: { ...nullRefusal.result!.responseBody as Record<string, unknown>,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', refusal: '', content: JSON.stringify({ text: 'Must reject.' }) } }] } } };
      expect(() => parseOpenRouterMailReplyResult(nonNullRefusal, JSON.stringify(bodies[0]))).toThrow(/invalid/i);
      const readsBeforeInertCheck = selectedTextReads;
      const checked = await app.refreshAssistantBatch(job.id);
      expect(selectedTextReads).toBe(readsBeforeInertCheck);
      expect(checked).toMatchObject({ status: 'completed', providerReportedCostUsd: 0.001, hasMailReplyResult: true });
      expect(app.getSnapshot().proposals).toHaveLength(0);
      expect(JSON.stringify(app.getSnapshot().assistantBatchJobs?.[0])).not.toContain('Draft for explicit review.');

      const tamperedRequestStore = new MemoryStore();
      tamperedRequestStore.value = structuredClone(store.value!);
      const tamperedLedger = (tamperedRequestStore.value as AppState & { openRouterBatchLedger: { jobs: { id: string; requestBody: string; requestBytes: number }[] } }).openRouterBatchLedger;
      const tamperedJob = tamperedLedger.jobs.find((item) => item.id === job.id)!;
      tamperedJob.requestBody = tamperedJob.requestBody.replace('Keep the frozen brief.', 'A different frozen brief.');
      tamperedJob.requestBytes = new TextEncoder().encode(tamperedJob.requestBody).length;
      const tamperedApp = new AppControllerImpl(tamperedRequestStore, {}, integration);
      await tamperedApp.load();
      const readsBeforeTamperedReview = selectedTextReads;
      await expect(tamperedApp.reviewMailReplyBatch(job.id)).rejects.toThrow(/integrity/i);
      expect(selectedTextReads).toBe(readsBeforeTamperedReview);

      const changedDuringReviewStore = new MemoryStore();
      changedDuringReviewStore.value = structuredClone(store.value!);
      const changedDuringReviewApp = new AppControllerImpl(changedDuringReviewStore, {}, integration);
      await changedDuringReviewApp.load();
      const oldSource = await changedDuringReviewApp.getMailReplySource(message.id);
      const ordinaryDraft = await changedDuringReviewApp.createMailReplyProposal({ messageId: message.id, mode: 'reply',
        sourceDigest: oldSource.source!.sourceDigest, text: 'Ordinary draft tied to the older message.' });
      providerVersion = 'changed-during-explicit-review';
      const readsBeforeChangedReview = selectedTextReads;
      await expect(changedDuringReviewApp.reviewMailReplyBatch(job.id)).rejects.toThrow(/refreshed for review/i);
      expect(selectedTextReads).toBe(readsBeforeChangedReview + 1);
      const reviewRemovedJob = (changedDuringReviewStore.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(reviewRemovedJob).toMatchObject({ status: 'source_removed', unknownCharge: false, accounting: { providerReportedCostUsd: 0.001 } });
      expect(reviewRemovedJob).not.toHaveProperty('requestBody');
      expect(reviewRemovedJob).not.toHaveProperty('mailReplyBinding');
      expect(reviewRemovedJob).not.toHaveProperty('resultText');
      expect(changedDuringReviewApp.getSnapshot().proposals.find((item) => item.id === ordinaryDraft.id)).toMatchObject({ status: 'draft', requiresRebuild: true });
      providerVersion = undefined;

      vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
      const readsBeforeDelayedReview = selectedTextReads;
      const cancelledPlan = await app.reviewMailReplyBatch(job.id);
      expect(selectedTextReads).toBe(readsBeforeDelayedReview + 1);
      expect(cancelledPlan).toMatchObject({ jobId: job.id, messageId: message.id, text: 'Draft for explicit review.' });
      await app.cancelMailReplyBatchReview(cancelledPlan.planId);
      await expect(app.activateMailReplyBatch({ planId: cancelledPlan.planId })).rejects.toThrow(/expired|review/i);
      const expiredPlan = await app.reviewMailReplyBatch(job.id);
      vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
      await expect(app.activateMailReplyBatch({ planId: expiredPlan.planId })).rejects.toThrow(/expired/i);
      const plan = await app.reviewMailReplyBatch(job.id);
      expect(plan.text).toBe('Draft for explicit review.');
      const readsBeforeActivation = selectedTextReads;
      store.failAfterCommit = true;
      await expect(app.activateMailReplyBatch({ planId: plan.planId })).rejects.toThrow(/lost the save acknowledgement/i);
      expect(selectedTextReads).toBe(readsBeforeActivation);
      app = new AppControllerImpl(store, {}, integration);
      await app.load();
      await expect(app.activateMailReplyBatch({ planId: plan.planId })).rejects.toThrow(/expired|review/i);
      expect(app.getSnapshot().proposals).toHaveLength(1);
      const linked = app.getSnapshot().assistantBatchJobs?.find((item) => item.id === job.id);
      expect(linked?.proposalId).toBe(app.getSnapshot().proposals[0]?.id);
      const proposal = app.getSnapshot().proposals[0]!;
      expect(proposal).toMatchObject({ kind: 'email', status: 'draft', provenance: { version: 2, batchJobId: job.id }, email: { text: 'Draft for explicit review.' } });
      await expect(app.editProposal(proposal.id, { email: { ...proposal.email!, text: 'Changed after activation.' } })).rejects.toThrow(/immutable/i);
      const portableText = await app.exportData();
      expect(portableText).not.toContain('batchJobId');
      const importedPortableStore = new MemoryStore();
      const importedPortableApp = new AppControllerImpl(importedPortableStore);
      await importedPortableApp.load();
      const portablePreview = await importedPortableApp.prepareBackupImport(portableText);
      await importedPortableApp.applyBackupImport({ sessionId: portablePreview.sessionId, planHash: portablePreview.planHash });
      expect(importedPortableApp.getSnapshot().assistantBatchJobs).toEqual([]);
      expect(importedPortableApp.getSnapshot().proposals.some((item) => item.provenance?.version === 2 && item.provenance.batchJobId)).toBe(false);
      expect((await app.approveProposal(proposal.id)).status).toBe('approved');
      const corruptedStore = new MemoryStore();
      corruptedStore.value = structuredClone(store.value!);
      const corruptedLedger = (corruptedStore.value as AppState & { openRouterBatchLedger: { jobs: { id: string; resultText?: string }[] } }).openRouterBatchLedger;
      corruptedLedger.jobs.find((item) => item.id === job.id)!.resultText = 'Tampered after approval.';
      const corruptedApp = new AppControllerImpl(corruptedStore, {}, integration);
      await corruptedApp.load();
      await expect(corruptedApp.executeProposal(proposal.id)).rejects.toThrow(/integrity|changed|source/i);

      const sourceChangedStore = new MemoryStore();
      sourceChangedStore.value = structuredClone(store.value!);
      const sourceChangedApp = new AppControllerImpl(sourceChangedStore, {}, integration);
      await sourceChangedApp.load();
      providerVersion = 'changed-provider-version';
      const refreshed = await sourceChangedApp.loadMailReplyText({ messageId: message.id, sourceDigest: source.source!.sourceDigest });
      expect(refreshed.status).toBe('source_changed');
      const sourceRemoved = (sourceChangedStore.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(sourceRemoved).toMatchObject({ status: 'source_removed', unknownCharge: false, accounting: { providerReportedCostUsd: 0.001 }, proposalId: proposal.id });
      expect(sourceRemoved).not.toHaveProperty('requestBody');
      expect(sourceChangedApp.getSnapshot().proposals.find((item) => item.id === proposal.id)).toMatchObject({ status: 'draft', requiresRebuild: true });
      providerVersion = undefined;

      const deletableStore = new MemoryStore();
      deletableStore.value = structuredClone(store.value!);
      const deletableApp = new AppControllerImpl(deletableStore, {}, integration);
      await deletableApp.load();
      await deletableApp.deleteMailReplyBatch(job.id);
      const deletedJob = deletableApp.getSnapshot().assistantBatchJobs?.find((item) => item.id === job.id);
      expect(deletedJob).toMatchObject({ proposalId: proposal.id, providerReportedCostUsd: 0.001 });
      expect(deletedJob).not.toHaveProperty('hasMailReplyResult', true);
      expect(deletableApp.getSnapshot().proposals.find((item) => item.id === proposal.id)).toMatchObject({ status: 'draft', requiresRebuild: true });
      const deletedLedgerJob = (deletableStore.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(deletedLedgerJob).not.toHaveProperty('requestBody');
      expect(deletedLedgerJob).not.toHaveProperty('mailReplyBinding');
      expect(deletedLedgerJob).not.toHaveProperty('resultText');

      expect(await app.executeProposal(proposal.id)).toMatchObject({ status: 'unknown' });
      const mailReceipt = app.getSnapshot().dispatchRecords[0]!;
      expect(mailReceipt).toMatchObject({ outcome: 'unknown', sourceProvenance: { version: 2, batchJobId: job.id },
        mailReplyBatchBinding: { jobId: job.id } });
      if (mailReceipt.sourceProvenance.version === 2) {
        expect(mailReceipt.sourceProvenance.source.identity).toHaveProperty('issuer', undefined);
        expect(mailReceipt.sourceProvenance.source.identity).toHaveProperty('tenantId', undefined);
        expect(mailReceipt.sourceProvenance.source.identity).toHaveProperty('resourceUserId', undefined);
      }
      const persistedMailReceipt = JSON.parse(JSON.stringify(mailReceipt)) as typeof mailReceipt;
      expect(validateDispatchRecord(persistedMailReceipt)).toMatchObject({ sourceProvenance: { version: 2, batchJobId: job.id },
        mailReplyBatchBinding: { jobId: job.id } });
      if (persistedMailReceipt.sourceProvenance.version === 2) {
        expect(persistedMailReceipt.sourceProvenance.source.identity).not.toHaveProperty('issuer');
        expect(persistedMailReceipt.sourceProvenance.source.identity).not.toHaveProperty('tenantId');
        expect(persistedMailReceipt.sourceProvenance.source.identity).not.toHaveProperty('resourceUserId');
      }
      const changedReceiptProvenance = structuredClone(mailReceipt);
      if (changedReceiptProvenance.sourceProvenance.version === 2) changedReceiptProvenance.sourceProvenance.batchJobId = '00000000-0000-4000-8000-000000000099';
      expect(() => validateDispatchRecord(changedReceiptProvenance)).toThrow(/consistency proof/i);
      const strippedReceiptProof = structuredClone(mailReceipt) as typeof mailReceipt & { mailReplyBatchBinding?: unknown };
      delete strippedReceiptProof.mailReplyBatchBinding;
      expect(() => validateDispatchRecord(strippedReceiptProof)).toThrow(/consistency proof/i);
      const changedReceiptProof = structuredClone(mailReceipt);
      changedReceiptProof.mailReplyBatchBinding!.jobId = '00000000-0000-4000-8000-000000000099';
      expect(() => validateDispatchRecord(changedReceiptProof)).toThrow(/consistency proof/i);

      const uncertainStore = new MemoryStore();
      uncertainStore.value = structuredClone(store.value!);
      uncertainStore.value!.proposals = uncertainStore.value!.proposals.filter((item) => item.id !== proposal.id);
      const uncertainApp = new AppControllerImpl(uncertainStore, {}, integration);
      await uncertainApp.load();
      const quarantinedStore = new MemoryStore();
      quarantinedStore.value = structuredClone(uncertainStore.value!);
      Object.assign(quarantinedStore.value, { dispatchRecordQuarantine: [{ reason: 'invalid_persisted_receipt', quarantinedAt: new Date().toISOString(), raw: { id: 'private-corrupt-receipt' } }] });
      const quarantinedApp = new AppControllerImpl(quarantinedStore, {}, integration);
      await quarantinedApp.load();
      providerVersion = 'changed-during-quarantined-observation';
      const quarantinedSource = await quarantinedApp.getMailReplySource(message.id);
      const quarantineObserved = await quarantinedApp.loadMailReplyText({ messageId: message.id, sourceDigest: quarantinedSource.source!.sourceDigest });
      expect(quarantineObserved.status).toBe('source_changed');
      const quarantinedJob = (quarantinedStore.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(quarantinedJob).toMatchObject({ status: 'completed', proposalId: proposal.id, accounting: { providerReportedCostUsd: 0.001 } });
      expect(quarantinedJob).toHaveProperty('requestBody');
      expect(quarantinedJob).toHaveProperty('resultText', 'Draft for explicit review.');
      await expect(quarantinedApp.deleteMailReplyBatch(job.id)).rejects.toThrow(/uncertain or pending|dispatch history failed integrity/i);
      const quarantineOnlyStore = new MemoryStore();
      quarantineOnlyStore.value = structuredClone(uncertainStore.value!);
      quarantineOnlyStore.value!.proposals = [];
      quarantineOnlyStore.value!.dispatchRecords = [];
      Object.assign(quarantineOnlyStore.value, { dispatchRecordQuarantine: [{ reason: 'invalid_persisted_receipt', quarantinedAt: new Date().toISOString(), raw: { id: 'orphan-private-receipt' } }] });
      const quarantineOnlyApp = new AppControllerImpl(quarantineOnlyStore, {}, integration);
      await quarantineOnlyApp.load();
      await expect(quarantineOnlyApp.deleteMailReplyBatch(job.id)).rejects.toThrow(/dispatch history failed integrity/i);
      const quarantineOnlyJob = (quarantineOnlyStore.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(quarantineOnlyJob).toHaveProperty('requestBody');
      expect(quarantineOnlyJob).toHaveProperty('resultText', 'Draft for explicit review.');
      providerVersion = 'changed-during-uncertain-observation';
      const changedSource = await uncertainApp.loadMailReplyText({ messageId: message.id, sourceDigest: source.source!.sourceDigest });
      expect(changedSource.status).toBe('source_changed');
      let observedJob = (uncertainStore.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(observedJob).toMatchObject({ status: 'completed', proposalId: proposal.id, accounting: { providerReportedCostUsd: 0.001 } });
      expect(observedJob).toHaveProperty('requestBody');
      providerVersion = 'changed-during-mail-page';
      await expect(uncertainApp.refreshMailHead(account.id)).resolves.toMatchObject({ status: 'complete' });
      expect(uncertainApp.getSnapshot().mailbox.some((item) => item.providerMessageId === 'batch-mail-unrelated-provider')).toBe(true);
      expect(uncertainApp.getSnapshot().syncStates[account.id]?.mailHead.lastPageSucceededAt).toBeDefined();
      observedJob = (uncertainStore.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(observedJob).toMatchObject({ status: 'completed', proposalId: proposal.id, accounting: { providerReportedCostUsd: 0.001 } });
      expect(observedJob).toHaveProperty('resultText', 'Draft for explicit review.');
      providerDeletionObserved = true;
      await expect(uncertainApp.refreshMailHead(account.id)).resolves.toMatchObject({ status: 'complete' });
      expect(uncertainApp.getSnapshot().mailbox.find((item) => item.id === message.id)?.providerDeletedAt).toBeDefined();
      observedJob = (uncertainStore.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(observedJob).toMatchObject({ status: 'completed', proposalId: proposal.id, accounting: { providerReportedCostUsd: 0.001 } });
      expect(observedJob).toHaveProperty('resultText', 'Draft for explicit review.');
      providerVersion = undefined;
      await expect(uncertainApp.disconnectAccount(account.id)).resolves.toMatchObject({ connected: false });
      expect(uncertainStore.value?.accounts.find((item) => item.id === account.id)?.connected).toBe(false);
      expect(uncertainStore.value?.dispatchRecords[0]).toMatchObject({ proposalId: proposal.id, outcome: 'unknown' });
      expect((uncertainStore.value as AppState & { openRouterBatchLedger: { jobs: { id: string; status: string }[] } }).openRouterBatchLedger.jobs
        .find((item) => item.id === job.id)?.status).toBe('completed');
      await expect(uncertainApp.deleteMailReplyBatch(job.id)).rejects.toThrow(/uncertain or pending/i);
      expect((uncertainStore.value as AppState & { openRouterBatchLedger: { jobs: { id: string; status: string }[] } }).openRouterBatchLedger.jobs
        .find((item) => item.id === job.id)?.status).toBe('completed');

    } finally { vi.useRealTimers(); }
  });

  it('does not attach a late mail Batch acknowledgement after privacy, bootstrap, or durable-job changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T05:00:00.000Z'));
    try {
      for (const scenario of ['privacy', 'bootstrap', 'job_removed'] as const) {
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const posted = new Promise<void>((resolve) => { started = resolve; });
        const fakeClient = {
          submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
            await before(); assert(); started(); await gate;
            return { batchId: `late_${scenario}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
              model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h' as const, total: 1, completed: 0, failed: 0 };
          },
        } as unknown as OpenRouterBatchClient;
        const fixture = await mailFixture(fakeClient);
        let epoch = 'privacy-epoch-before';
        (fixture.integration as unknown as { privacySession?: { epoch: string; assertCurrent(): Promise<void> } }).privacySession = {
          get epoch() { return epoch; }, async assertCurrent() {},
        };
        const pending = fixture.app.submitMailReplyBatch({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest,
          textDigest: fixture.textDigest, mode: 'reply', to: ['sam@example.test'], cc: [], brief: `Fence ${scenario}.`, composerRevision: 1 });
        await posted;
        if (scenario === 'privacy') epoch = 'privacy-epoch-after';
        if (scenario === 'bootstrap') await fixture.app.refreshPersistedWorkspace();
        if (scenario === 'job_removed') {
          const saved = fixture.store.value as AppState & { openRouterBatchLedger: { version: 1; jobs: unknown[] } };
          saved.openRouterBatchLedger.jobs = [];
          await fixture.app.refreshPersistedWorkspace();
        }
        release();
        await expect(pending).rejects.toThrow(/earlier (privacy or )?workspace session|safely retained|saved Batch request/i);
        const jobs = (fixture.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs;
        expect(jobs.some((item) => item.batchId === `late_${scenario}`)).toBe(false);
        if (scenario === 'job_removed') expect(jobs).toHaveLength(0);
        else expect(jobs[0]).toMatchObject({ status: scenario === 'bootstrap' ? 'submission_unknown' : 'submitting', unknownCharge: true });
      }
    } finally { vi.useRealTimers(); }
  });

  it('rechecks privacy epoch after the queued mail dispatch settlement store fence', async () => {
    let epoch = 'settlement-epoch-before';
    const fakeClient = {
      submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert(); throw new OpenRouterBatchDispatchError('pre_dispatch', 'Fixture rejected before POST.');
      },
    } as unknown as OpenRouterBatchClient;
    const fixture = await mailFixture(fakeClient);
    (fixture.integration as unknown as { privacySession?: { epoch: string; assertCurrent(): Promise<void> } }).privacySession = {
      get epoch() { return epoch; }, async assertCurrent() {},
    };
    Object.assign(fixture.store, { async assertCurrent() { epoch = 'settlement-epoch-after'; } });
    await expect(fixture.app.submitMailReplyBatch({ messageId: fixture.message.id, sourceDigest: fixture.source.source!.sourceDigest,
      textDigest: fixture.textDigest, mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Settlement epoch race.', composerRevision: 1 }))
      .rejects.toThrow(/rejected before POST/i);
    expect(fixture.store.value?.accounts.find((item) => item.id === fixture.account.id)?.connected).toBe(true);
    const job = (fixture.store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } }).openRouterBatchLedger.jobs[0]!;
    expect(job).toMatchObject({ status: 'submitting', unknownCharge: true });
    expect(job).not.toHaveProperty('batchId');
  });

  it('accepts an explicit null refusal field on strict structured output', async () => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_null_refusal', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({
        summary: 'Ready.', answer: 'READY', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      }), null), batchId: 'batch_null_refusal' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six structured null refusal' });
    const job = await app.submitNoteBatch(note.id, { intent: 'answer', question: 'Return READY.' });

    const result = await app.refreshAssistantBatch(job.id);
    expect(result).toMatchObject({ status: 'completed', providerReportedCostUsd: 0.001 });
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.answer).toBe('READY');
    expect(app.getSnapshot().proposals).toHaveLength(0);
  });

  it.each(['', {}])('rejects a non-null refusal field and retains accounting without actions: %j', async (refusal) => {
    const fakeClient = {
      submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('batch_nonnull_refusal', input, before, assert),
      inspect: async (_batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({
        summary: 'Must not apply.', answer: 'MUST_NOT_APPLY', decisions: [], citations: [], clarifications: [], proposals: [{
          kind: 'task', title: 'Must not be created', body: 'Invalid refusal response.', recipients: [], dueAt: null, evidence: ['MUST_NOT_APPLY'],
        }], memorySuggestions: [],
      }), refusal), batchId: 'batch_nonnull_refusal' }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: 'one two three four five six non-null refusal' });
    const job = await app.submitNoteBatch(note.id, { intent: 'answer', question: 'Return READY.' });

    const result = await app.refreshAssistantBatch(job.id);
    expect(result).toMatchObject({ status: 'result_invalid', providerReportedCostUsd: 0.001, costStatus: 'reported' });
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.analysis).toBeUndefined();
    expect(app.getSnapshot().proposals).toHaveLength(0);
    expect(app.getSnapshot().tasks).toHaveLength(0);
  });

  it('retains accounting when a mail result pushes an otherwise valid saved state over 16 MiB', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T04:00:00.000Z'));
    try {
      const fakeClient = {
        submit: (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => fakeSubmit('mail_batch_overflow', input, before, assert),
        inspect: async (_batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({ text: 'r'.repeat(8_000) }), null), batchId: 'mail_batch_overflow' }),
      } as unknown as OpenRouterBatchClient;
      const text = 'Selected message body for the mail Batch storage overflow regression.';
      const identity = { providerNamespace: 'google' as const, clientId: 'overflow-client', subject: 'overflow-subject' };
      const identityKey = 'google:overflow-client:overflow-subject:';
      const store = new MemoryStore();
      let app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
      await app.load();
      const state = structuredClone(app.getSnapshot());
      const account = { id: 'overflow-account', provider: 'google' as const, displayName: 'Mail', email: 'me@example.test', verifiedEmail: 'me@example.test',
        connected: true, authStatus: 'connected' as const, identity, tokenRef: 'overflow-token', capabilities: ['mail.read' as const],
        grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'], connectionGeneration: 2 };
      const observedAt = new Date().toISOString();
      const message = { id: 'overflow-local', accountId: account.id, providerMessageId: 'overflow-provider', identityKey: `${identityKey}:overflow-provider`,
        verifiedIdentityKey: identityKey, connectionGeneration: 2, idFormat: 'gmail' as const, threadId: 'overflow-thread', subject: 'Overflow subject',
        from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt, replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [],
        internetMessageId: '<overflow@example.test>', replyMetadataComplete: true, observedAt };
      state.accounts.push(account); state.mailbox.push(message);
      state.settings = { ...state.settings, mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' };
      await store.save(state);
      app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
      await app.load();
      const connectedGeneration = app.getSnapshot().accounts.find((item) => item.id === account.id)!.connectionGeneration ?? 0;
      await (app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
        const current = draft.accounts.find((item) => item.id === account.id)!;
        current.connected = true; current.authStatus = 'connected'; current.capabilities = ['mail.read'];
        current.grantedScopes = ['openid', 'https://www.googleapis.com/auth/gmail.readonly']; current.connectionGeneration = connectedGeneration;
        const row = draft.mailbox.find((item) => item.id === message.id)!;
        row.connectionGeneration = connectedGeneration; row.verifiedIdentityKey = identityKey; row.identityKey = `${identityKey}:${message.providerMessageId}`;
      });
      const source = await app.getMailReplySource(message.id);
      const textDigest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });
      const selected: SelectedMailTextSnapshot = { version: 1, messageId: message.id, accountId: account.id, identityKey, identity,
        connectionGeneration: connectedGeneration, providerMessageId: message.providerMessageId, idFormat: 'gmail', sourceDigest: source.source!.sourceDigest,
        checkedAt: observedAt, text, textDigest, bytes: new TextEncoder().encode(text).length, extractionVersion: 'mail-text-v1',
        representation: 'plain', completeness: 'complete_text', omissionReasons: [] };
      await (app as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => { draft.selectedMailTexts = [selected]; });
      const job = await app.submitMailReplyBatch({ messageId: message.id, sourceDigest: source.source!.sourceDigest, textDigest,
        mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Short storage fixture.', composerRevision: 1 });

      const fullState = store.value!;
      const overflowNoteIndex = fullState.notes.length;
      fullState.notes.push({ id: 'overflow-fixture-note', title: 'Overflow fixture', transcript: '', durationSeconds: 0, createdAt: observedAt,
        capturedAt: observedAt, captureTimeZone: 'UTC', status: 'recorded', revision: 1 });
      const emptyBytes = new TextEncoder().encode(JSON.stringify(fullState)).length;
      fullState.notes[overflowNoteIndex]!.transcript = 'x'.repeat(Math.max(0, STATE_SNAPSHOT_READ_MAX_BYTES - emptyBytes - 4_000));
      expect(new TextEncoder().encode(JSON.stringify(fullState)).length).toBeLessThanOrEqual(STATE_SNAPSHOT_READ_MAX_BYTES);
      await store.save(fullState);
      app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
      await app.load();
      expect(app.getSnapshot().notes.find((item) => item.id === 'overflow-fixture-note')?.transcript.length).toBeGreaterThan(1_000_000);
      const result = await app.refreshAssistantBatch(job.id);
      expect(result).toMatchObject({ status: 'result_not_retained', failureCode: 'result_not_retained', providerReportedCostUsd: 0.001, unknownCharge: false });
      const saved = store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
      const savedJob = saved.openRouterBatchLedger.jobs.find((item) => item.id === job.id)!;
      expect(savedJob).toMatchObject({ status: 'result_not_retained', failureCode: 'result_not_retained', accounting: { providerReportedCostUsd: 0.001 } });
      expect(savedJob).not.toHaveProperty('resultText');
    } finally { vi.useRealTimers(); }
  });

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

  it('refines a completed answer with its exact inherited context and rebuilds nested refinements identically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00.000Z'));
    try {
      const postedBodies: { body: Record<string, unknown>; operationId: string }[] = [];
      const fakeClient = {
        submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
          await before();
          assert();
          postedBodies.push({ body: JSON.parse(input.requestBody) as Record<string, unknown>, operationId: input.operationId });
          return { batchId: `batch_refinement_${postedBodies.length}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
            model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
        },
        inspect: async (batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({
          summary: 'A compact summary of the prior answer.', answer: 'The complete prior answer contains useful details.', decisions: [], citations: [], clarifications: [],
          proposals: batchId === 'batch_refinement_2' ? [{ kind: 'task', title: 'Prepare an outline', body: 'Bring a concise outline.', recipients: [], dueAt: null,
            evidence: ['Please prepare a concise outline.'] }] : [], memorySuggestions: [],
        })), batchId }),
      } as unknown as OpenRouterBatchClient;
      const store = new MemoryStore();
      const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
      await app.load();
      await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
      const conversation = await app.createChatConversation('Refinement');
      const first = await app.submitChatTurn({ conversationId: conversation.id, text: 'Earlier context.' });
      await app.refreshAssistantBatch(first.jobId);
      const parent = await app.submitChatTurn({ conversationId: conversation.id, text: 'Please prepare a concise outline.' });
      await app.refreshAssistantBatch(parent.jobId);
      const parentProposal = app.getSnapshot().proposals.find((proposal) => proposal.kind === 'task');
      expect(parentProposal).toBeDefined();
      const approvedParentProposal = await app.approveProposal(parentProposal!.id, { expectedRevision: parentProposal!.revision });
      expect(approvedParentProposal.status).toBe('approved');
      const executedParentProposal = await app.executeProposal(approvedParentProposal.id, { expectedRevision: approvedParentProposal.revision });
      expect(executedParentProposal.status).toBe('executed');
      const beforeRefine = store.value as AppState & {
        assistantChatLedger: { conversations: { turns: { id: string; noteId: string }[] }[] };
        openRouterBatchLedger: { jobs: { id: string; requestBody: string; chatBinding?: { context: unknown[] } }[] };
      };
      const originalParentJob = beforeRefine.openRouterBatchLedger.jobs.find((job) => job.id === parent.jobId)!;
      const originalParentNote = structuredClone(beforeRefine.notes.find((note) => note.id === beforeRefine.assistantChatLedger.conversations[0]?.turns.find((turn) => turn.id === parent.turnId)?.noteId));
      const originalParentProposal = structuredClone(beforeRefine.proposals.find((proposal) => proposal.id === parentProposal!.id));
      const originalTasks = structuredClone(beforeRefine.tasks);
      const originalDispatchRecords = structuredClone(beforeRefine.dispatchRecords);

      vi.setSystemTime(new Date('2026-10-13T10:05:00.000Z'));

      const refined = await app.refineChatTurn({ conversationId: conversation.id, parentTurnId: parent.turnId, effort: 'high' });
      const afterSubmit = store.value as AppState & { assistantChatLedger: { conversations: { turns: { id: string; parentTurnId?: string; operation?: string; capturedAt?: string; createdAt: string; reply?: unknown }[] }[] }; openRouterBatchLedger: { jobs: { id: string; operation?: string; effort: string; reasoningEffort?: string; requestProfileVersion: number; requestBody: string; knowledgeSelection?: unknown[]; parentTurnId?: string; chatBinding?: { context: unknown[]; refinementParent?: { turnId: string } } }[] } };
      const childTurn = afterSubmit.assistantChatLedger.conversations[0]?.turns.find((turn) => turn.id === refined.turnId)!;
      const childJob = afterSubmit.openRouterBatchLedger.jobs.find((job) => job.id === refined.jobId)!;
      expect(childTurn).toMatchObject({ parentTurnId: parent.turnId, operation: 'chat_refinement', capturedAt: '2026-10-13T10:00:00.000Z' });
      expect(childTurn.createdAt).toBe('2026-10-13T10:05:00.000Z');
      expect(childTurn.capturedAt).not.toBe(childTurn.createdAt);
      expect(childJob).toMatchObject({ operation: 'chat_refinement', effort: 'high', reasoningEffort: 'high', requestProfileVersion: 2, parentTurnId: parent.turnId });
      expect(childJob.chatBinding?.context).toEqual(originalParentJob.chatBinding?.context);
      const childWire = postedBodies.at(-1)?.body as { reasoning: { effort: string }; response_format: { json_schema: { name: string } }; messages: { content: string }[] };
      expect(childWire.reasoning.effort).toBe('high');
      expect(childWire.response_format.json_schema.name).toBe('chat_refinement');
      expect(childWire.messages.some((message) => message.content.includes('Earlier context.'))).toBe(true);
      expect(childWire.messages.some((message) => message.content.includes('A compact summary of the prior answer.'))).toBe(true);
      expect(childWire.messages.some((message) => message.content.includes('The complete prior answer contains useful details.'))).toBe(true);
      await app.refreshAssistantBatch(refined.jobId);
      expect(app.getSnapshot().assistantChatConversations?.[0]?.turns.find((turn) => turn.id === refined.turnId)?.reply?.answer)
        .toBe('The complete prior answer contains useful details.');

      vi.setSystemTime(new Date('2026-10-13T10:07:00.000Z'));
      const nested = await app.refineChatTurn({ conversationId: conversation.id, parentTurnId: refined.turnId, effort: 'max' });
      const nestedPersisted = store.value as typeof afterSubmit;
      const nestedJob = nestedPersisted.openRouterBatchLedger.jobs.find((job) => job.id === nested.jobId)!;
      expect(nestedJob).toMatchObject({ operation: 'chat_refinement', effort: 'max', reasoningEffort: 'max', parentTurnId: refined.turnId });
      expect(nestedJob.chatBinding?.context).toEqual(childJob.chatBinding?.context);
      expect(nestedJob.chatBinding?.refinementParent?.turnId).toBe(refined.turnId);
      const nestedTurn = nestedPersisted.assistantChatLedger.conversations[0]?.turns.find((turn) => turn.id === nested.turnId)!;
      expect(nestedTurn.capturedAt).toBe('2026-10-13T10:00:00.000Z');
      expect(nestedTurn.createdAt).toBe('2026-10-13T10:07:00.000Z');
      expect(nestedTurn.createdAt).not.toBe(nestedTurn.capturedAt);
      const nestedWire = postedBodies.at(-1)?.body as { messages: { content: string }[] };
      expect(nestedWire.messages.some((message) => message.content.includes('Earlier context.'))).toBe(true);
      expect(nestedWire.messages.some((message) => message.content.includes('The complete prior answer contains useful details.'))).toBe(true);
      await app.refreshAssistantBatch(nested.jobId);
      expect(app.getSnapshot().assistantChatConversations?.[0]?.turns.find((turn) => turn.id === nested.turnId)?.reply?.answer)
        .toBe('The complete prior answer contains useful details.');
      const restored = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
      await restored.load();
      expect(restored.getSnapshot().assistantBatchRecoveryStatus?.blocked).not.toBe(true);
      expect(restored.getSnapshot().assistantChatConversations?.[0]?.turns.find((turn) => turn.id === nested.turnId)?.reply?.answer)
        .toBe('The complete prior answer contains useful details.');
      const finalState = store.value as typeof afterSubmit;
      expect(finalState.openRouterBatchLedger.jobs.find((job) => job.id === parent.jobId)?.requestBody).toBe(originalParentJob.requestBody);
      expect(finalState.notes.find((note) => note.id === originalParentNote?.id)).toEqual(originalParentNote);
      expect(finalState.proposals.find((proposal) => proposal.id === parentProposal!.id)).toEqual(originalParentProposal);
      expect(finalState.tasks).toEqual(originalTasks);
      expect(finalState.dispatchRecords).toEqual(originalDispatchRecords);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the captured refinement choices and releases only the originally locked conversation', async () => {
    const posted: Record<string, unknown>[] = [];
    const fakeClient = {
      submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert(); posted.push(JSON.parse(input.requestBody) as Record<string, unknown>);
        return { batchId: `batch_mutable_${posted.length}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string) => ({ ...completedInspection(customId), batchId }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const originalConversation = await app.createChatConversation('Captured inputs');
    const otherConversation = await app.createChatConversation('Other conversation');
    const parent = await app.submitChatTurn({ conversationId: originalConversation.id, text: 'Retain this message.' });
    await app.refreshAssistantBatch(parent.jobId);

    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    let releaseDigest!: () => void;
    let reachedDigest!: () => void;
    const digestStarted = new Promise<void>((resolve) => { reachedDigest = resolve; });
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    let holdFirstDigest = true;
    const spy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (...args) => {
      if (holdFirstDigest) { holdFirstDigest = false; reachedDigest(); await digestGate; }
      return originalDigest(...args);
    });
    const mutableInput: { conversationId: string; parentTurnId: string; effort: 'medium' | 'high' | 'max' } = {
      conversationId: originalConversation.id, parentTurnId: parent.turnId, effort: 'high',
    };
    try {
      const refining = app.refineChatTurn(mutableInput);
      await digestStarted;
      mutableInput.conversationId = otherConversation.id;
      mutableInput.parentTurnId = '00000000-0000-4000-8000-000000000001';
      mutableInput.effort = 'max';
      releaseDigest();
      const accepted = await refining;
      expect(accepted.conversationId).toBe(originalConversation.id);
      expect((posted.at(-1)?.reasoning as { effort: string }).effort).toBe('high');
      await expect(app.submitChatTurn({ conversationId: originalConversation.id, text: 'Original lock is released.' })).resolves.toMatchObject({ kind: 'accepted' });
      await expect(app.submitChatTurn({ conversationId: otherConversation.id, text: 'Other conversation remains usable.' })).resolves.toMatchObject({ kind: 'accepted' });
    } finally { releaseDigest(); spy.mockRestore(); }
  });

  it('refuses a required parent source that cannot fit before saving or posting a child request', async () => {
    let posts = 0;
    const hugeAnswer = 'P'.repeat(1_100_000);
    const fakeClient = {
      submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert(); posts += 1;
        return { batchId: `batch_parent_capacity_${posts}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({
        summary: 'A full answer.', answer: hugeAnswer, decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      })), batchId }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const conversation = await app.createChatConversation('Required parent capacity');
    const parent = await app.submitChatTurn({ conversationId: conversation.id, text: 'Keep the entire parent answer.' });
    expect((await app.refreshAssistantBatch(parent.jobId)).status).toBe('completed');
    const savesBeforeChild = store.saves;
    const beforeChild = store.value as AppState & { assistantChatLedger: { conversations: { turns: unknown[] }[] } };
    const turnsBeforeChild = beforeChild.assistantChatLedger.conversations[0]?.turns.length;
    await expect(app.refineChatTurn({ conversationId: conversation.id, parentTurnId: parent.turnId, effort: 'high' }))
      .rejects.toThrow(/request|context|source|too large|limit|fit/i);
    expect(posts).toBe(1);
    expect(store.saves).toBe(savesBeforeChild);
    expect((store.value as typeof beforeChild).assistantChatLedger.conversations[0]?.turns).toHaveLength(turnsBeforeChild);
  });

  it('tombstones refinements when their required parent source is removed', async () => {
    let postCount = 0;
    const fakeClient = {
      submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
        await before(); assert(); postCount += 1;
        return { batchId: `batch_removed_parent_${postCount}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
      },
      inspect: async (batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({
        summary: `Summary ${batchId}.`, answer: `Answer ${batchId}.`, decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      })), batchId }),
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: 'A private parent source.' });
    const conversation = await app.createChatConversation('Removed refinement source');
    const parent = await app.submitChatTurn({ conversationId: conversation.id, text: 'Summarize this person.', knowledgeSelection: [{ kind: 'person', id: person.id }] });
    await app.refreshAssistantBatch(parent.jobId);
    const child = await app.refineChatTurn({ conversationId: conversation.id, parentTurnId: parent.turnId, effort: 'high' });
    await app.refreshAssistantBatch(child.jobId);
    expect(app.getSnapshot().assistantChatConversations?.[0]?.turns.find((turn) => turn.id === child.turnId)?.reply).toBeDefined();

    const currentPerson = app.getSnapshot().knowledge.people.find((item) => item.id === person.id)!;
    const narrative = app.getSnapshot().documents.find((item) => item.path === person.narrativePath)!;
    await app.savePerson({ id: person.id, expectedRevision: currentPerson.revision, expectedDocumentRevision: narrative.revision,
      name: 'Maya', aliases: [], narrative: 'The parent source has been removed.' });
    const persisted = store.value as AppState & {
      assistantChatLedger: { conversations: { turns: { id: string; reply?: unknown; replySha256?: string }[] }[] };
      openRouterBatchLedger: { jobs: { id: string; status: string; requestBody?: string; chatBinding?: unknown }[] };
    };
    for (const turnId of [parent.turnId, child.turnId]) {
      const turn = persisted.assistantChatLedger.conversations[0]?.turns.find((item) => item.id === turnId);
      expect(turn?.reply).toBeUndefined();
      expect(turn?.replySha256).toBeUndefined();
    }
    for (const jobId of [parent.jobId, child.jobId]) {
      const job = persisted.openRouterBatchLedger.jobs.find((item) => item.id === jobId);
      expect(job).toMatchObject({ status: 'source_removed' });
      expect(job).not.toHaveProperty('requestBody');
      expect(job).not.toHaveProperty('chatBinding');
    }
    expect(JSON.stringify(persisted)).not.toContain('A private parent source.');
  });

  it('rebuilds refinement requests with the parent context omission count unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00.000Z'));
    try {
      const longAnswer = 'C'.repeat(30_000);
      const fakeClient = {
        submit: async (input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
          await before(); assert();
          return { batchId: `batch_omission_${input.operationId.slice(0, 8)}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
            model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
        },
        inspect: async (batchId: string, customId: string) => ({ ...completedInspection(customId, JSON.stringify({
          summary: 'Prior summary.', answer: longAnswer, decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
        })), batchId }),
      } as unknown as OpenRouterBatchClient;
      const store = new MemoryStore();
      const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
      await app.load();
      await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
      const conversation = await app.createChatConversation('Omitted history');
      const first = await app.submitChatTurn({ conversationId: conversation.id, text: 'First history item.' });
      await app.refreshAssistantBatch(first.jobId);
      const second = await app.submitChatTurn({ conversationId: conversation.id, text: 'Second history item.' });
      await app.refreshAssistantBatch(second.jobId);
      const parent = await app.submitChatTurn({ conversationId: conversation.id, text: 'Refine the recent context.' });
      await app.refreshAssistantBatch(parent.jobId);
      const before = store.value as AppState & { openRouterBatchLedger: { jobs: { id: string; omittedSourceCount: number; chatBinding?: { omittedTurnCount: number; context: unknown[] } }[] } };
      const parentJob = before.openRouterBatchLedger.jobs.find((job) => job.id === parent.jobId)!;
      expect(parentJob.chatBinding?.omittedTurnCount).toBe(1);
      expect(parentJob.chatBinding?.context).toHaveLength(1);
      const child = await app.refineChatTurn({ conversationId: conversation.id, parentTurnId: parent.turnId, effort: 'medium' });
      const after = store.value as typeof before;
      const childJob = after.openRouterBatchLedger.jobs.find((job) => job.id === child.jobId)!;
      expect(childJob.chatBinding?.omittedTurnCount).toBe(1);
      expect(childJob.chatBinding?.context).toEqual(parentJob.chatBinding?.context);
      await app.refreshAssistantBatch(child.jobId);
      expect(app.getSnapshot().assistantBatchJobs?.find((job) => job.id === child.jobId)?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains paid accounting but rejects action-bearing refinement output', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00.000Z'));
    try {
      let batchCount = 0;
      const normal = JSON.stringify({ summary: 'Original summary.', answer: 'Original answer.', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] });
      const actionBearing = JSON.stringify({ summary: 'Refined summary.', answer: 'Refined answer.', decisions: [], citations: [], clarifications: [],
        proposals: [{ kind: 'task', title: 'Should be rejected', body: 'No action from a refinement.', recipients: [], dueAt: null, evidence: ['Please refine this.'] }], memorySuggestions: [] });
      const fakeClient = {
        submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>, assert: () => void) => {
          await before(); assert(); batchCount += 1;
          return { batchId: `batch_action_${batchCount}`, status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
            model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
        },
        inspect: async (batchId: string, customId: string) => completedInspection(customId, batchId === 'batch_action_2' ? actionBearing : normal),
      } as unknown as OpenRouterBatchClient;
      const store = new MemoryStore();
      const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient });
      await app.load();
      await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
      const conversation = await app.createChatConversation('Answer only');
      const parent = await app.submitChatTurn({ conversationId: conversation.id, text: 'Please refine this.' });
      await app.refreshAssistantBatch(parent.jobId);
      const child = await app.refineChatTurn({ conversationId: conversation.id, parentTurnId: parent.turnId, effort: 'medium' });
      const result = await app.refreshAssistantBatch(child.jobId);
      expect(result.status).toBe('result_invalid');
      expect(result.unknownCharge).toBe(false);
      expect(result.providerReportedCostUsd).toBe(0.001);
      expect(app.getSnapshot().assistantChatConversations?.[0]?.turns.find((turn) => turn.id === child.turnId)?.reply).toBeUndefined();
      expect(app.getSnapshot().proposals).toHaveLength(0);
      expect(app.getSnapshot().assistantBatchJobs?.find((job) => job.id === child.jobId)?.status).toBe('result_invalid');
    } finally {
      vi.useRealTimers();
    }
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

  it('does not return an accepted Chat DTO when privacy admission fails after the staged save', async () => {
    let privacyBlocked = false;
    let postCalls = 0;
    const privacySession = { epoch: 'fixture-epoch', assertCurrent: async () => {
      if (privacyBlocked) throw new Error('The privacy session was invalidated.');
    } };
    const fakeClient = {
      submit: async (_input: { operationId: string; requestBody: string }, before: () => Promise<void>) => {
        privacyBlocked = true;
        await before();
        postCalls += 1;
        return { batchId: 'batch_should_not_exist', status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
          model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 };
      },
    } as unknown as OpenRouterBatchClient;
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: fakeClient, privacySession });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const conversation = await app.createChatConversation('Privacy admission');
    await expect(app.submitChatTurn({ conversationId: conversation.id, text: 'Do not dispatch after invalidation.' }))
      .rejects.toThrow(/privacy session was invalidated/i);
    expect(postCalls).toBe(0);
    const persisted = store.value as AppState & { openRouterBatchLedger: { jobs: { status: string; batchId?: string }[] } };
    expect(persisted.openRouterBatchLedger.jobs).toHaveLength(1);
    expect(persisted.openRouterBatchLedger.jobs[0]).toMatchObject({ status: 'preparing' });
    expect(persisted.openRouterBatchLedger.jobs[0]).not.toHaveProperty('batchId');
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
