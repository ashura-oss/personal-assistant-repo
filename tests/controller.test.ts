import { describe, expect, it, vi } from 'vitest';
import type { AppState, MailReplyTextGenerationInput, Note, Proposal } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import { extractPreviewProposals as extractSharedPreviewProposals } from '../src/services/controller.shared';
import type { StateStore } from '../src/storage/contracts';
import { AzureOpenAIClient } from '../src/services/azure';
import { cancelReminderNotification, reminderNotificationId, requestReminderNotification } from '../src/services/notifications';
import { ConnectorClient, describeMessageWindowQuery, withCredentialLock, type OAuthBridgeResult, type StoredOAuthToken } from '../src/connectors';
import * as Crypto from 'expo-crypto';
import { completeNoteBatch, createCompletedAssistantBatchClient } from './helpers/assistantBatchFixture';

class MemoryStore implements StateStore {
  value?: AppState;
  failNext = false;
  saves = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.saves += 1;
    if (this.failNext) { this.failNext = false; throw new Error('disk full'); }
    this.value = structuredClone(state);
  }
  async clear() { this.value = undefined; }
}

function canonicalTestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTestValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonicalTestValue(child)]));
  return value;
}

class CanonicalizingMemoryStore extends MemoryStore {
  override async save(state: AppState) {
    this.saves += 1;
    if (this.failNext) { this.failNext = false; throw new Error('disk full'); }
    this.value = canonicalTestValue(JSON.parse(JSON.stringify(state))) as AppState;
  }
}

async function legacyProposalApprovalDigest(proposal: Proposal, state: AppState): Promise<string> {
  const account = state.accounts.find((item) => item.id === proposal.accountId);
  const calendar = proposal.eventDestination?.kind === 'remote_calendar' ? state.calendars.find((item) => item.id === proposal.eventDestination?.calendarId) : undefined;
  const payload = JSON.stringify({ id: proposal.id, revision: proposal.revision, noteId: proposal.noteId, sourceRevision: proposal.sourceRevision,
    provenance: proposal.provenance ?? null, requiresRebuild: proposal.requiresRebuild ?? false, kind: proposal.kind, title: proposal.title, body: proposal.body,
    accountId: proposal.accountId ?? null, accountIdentity: account ? { provider: account.provider, email: account.email, authStatus: account.authStatus,
      identity: account.identity ? { providerNamespace: account.identity.providerNamespace ?? null, clientId: account.identity.clientId ?? null,
        subject: account.identity.subject, issuer: account.identity.issuer ?? null, tenantId: account.identity.tenantId ?? null,
        resourceUserId: account.identity.resourceUserId ?? null } : null, scopes: account.grantedScopes ?? [], capabilities: account.capabilities ?? [],
      capabilityLimits: account.capabilityLimits ?? [] } : null, recipients: [...proposal.recipients], calendarId: proposal.calendarId ?? null,
    eventDestination: proposal.eventDestination ?? null, deviceCalendarApproval: proposal.deviceCalendarApproval ?? null,
    calendarDestination: calendar ? { accountId: calendar.accountId, providerId: calendar.providerId ?? null, name: calendar.name,
      writable: calendar.writable, connected: calendar.connected } : null, dueAt: proposal.dueAt ?? null,
    email: proposal.email ?? null, event: proposal.event ?? null, evidence: proposal.evidence });
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload);
}

async function saveDocumentCurrent(app: AppControllerImpl, path: string, content: string) {
  const revision = app.getSnapshot().documents.find((item) => item.path === path)?.revision;
  return app.saveDocument(path, content, { expectedRevision: revision });
}

describe('application state controller', () => {
  it('keeps v2 approval hashes stable across canonical key ordering and undefined-field removal', async () => {
    const store = new CanonicalizingMemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'Email Alex the agenda.' });
    const [proposal] = await app.processNote(note.id);
    const account = await app.saveAccount({ provider: 'google', displayName: 'Work', email: 'me@example.com' });
    await app.editProposal(proposal.id, { accountId: account.id, recipients: ['alex@example.com'], email: {
      operation: 'draft', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Agenda', text: 'Here is the agenda.', attachments: [],
    } });
    const approved = await app.approveProposal(proposal.id);
    expect(approved.approvedPayloadDigestVersion).toBe(2);
    const digest = approved.approvedPayloadDigest;
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().proposals.find((item) => item.id === proposal.id)).toMatchObject({
      status: 'approved', approvedPayloadDigestVersion: 2, approvedPayloadDigest: digest,
    });
  });

  it('preserves reproducible legacy approvals, demotes only unverifiable pending approvals, and rejects unknown digest versions', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'Email Alex the agenda.' });
    const [proposal] = await app.processNote(note.id);
    const account = await app.saveAccount({ provider: 'google', displayName: 'Work', email: 'me@example.com' });
    await app.editProposal(proposal.id, { accountId: account.id, recipients: ['alex@example.com'], email: {
      operation: 'draft', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Agenda', text: 'Here is the agenda.', attachments: [],
    } });
    await app.approveProposal(proposal.id);
    const saved = store.value!;
    const legacy = saved.proposals.find((item) => item.id === proposal.id)!;
    delete legacy.approvedPayloadDigestVersion;
    legacy.approvedPayloadDigest = await legacyProposalApprovalDigest(legacy, saved);
    const legacyDigest = legacy.approvedPayloadDigest;
    saved.proposals.push({ ...structuredClone(legacy), id: 'accepted-legacy-history', status: 'accepted' });
    saved.proposals.push({ ...structuredClone(legacy), id: 'unknown-legacy-history', status: 'unknown' });
    const legacyReload = new AppControllerImpl(store);
    await legacyReload.load();
    expect(legacyReload.getSnapshot().proposals.find((item) => item.id === proposal.id)).toMatchObject({
      status: 'approved', approvedPayloadDigest: legacyDigest,
    });
    expect(legacyReload.getSnapshot().proposals.find((item) => item.id === 'accepted-legacy-history')?.status).toBe('accepted');
    expect(legacyReload.getSnapshot().proposals.find((item) => item.id === 'unknown-legacy-history')?.status).toBe('unknown');

    const changedStore = new MemoryStore();
    changedStore.value = structuredClone(saved);
    const changed = changedStore.value!.proposals.find((item) => item.id === proposal.id)!;
    changed.title += ' tampered after approval';
    const reloaded = new AppControllerImpl(changedStore);
    await reloaded.load();
    expect(reloaded.getSnapshot().proposals.find((item) => item.id === proposal.id)).toMatchObject({ status: 'draft' });
    expect(reloaded.getSnapshot().proposals.find((item) => item.id === proposal.id)?.approvedPayloadDigest).toBeUndefined();

    const unknownStore = new MemoryStore();
    unknownStore.value = structuredClone(saved);
    const unknown = unknownStore.value!.proposals.find((item) => item.id === proposal.id)!;
    (unknown as unknown as Record<string, unknown>).approvedPayloadDigestVersion = 99;
    const unknownReload = new AppControllerImpl(unknownStore);
    await unknownReload.load();
    expect(unknownReload.getSnapshot().proposals.find((item) => item.id === proposal.id)).toMatchObject({ status: 'draft' });
    await expect(unknownReload.executeProposal(proposal.id)).rejects.toThrow(/approve this exact version/i);
  });

  it('uses the injected UUID port for shared preview proposal IDs', () => {
    const note = { id: 'note-1', transcript: 'Please send the update.', revision: 3 } as Note;
    const ids = ['node-uuid-1', 'node-uuid-2'];
    const proposals = extractSharedPreviewProposals(note, () => ids.shift()!);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: 'node-uuid-1', noteId: 'note-1', kind: 'email', sourceRevision: 3 });
    expect(ids).toEqual(['node-uuid-2']);
  });

  it('uses native defaults without mutating a frozen integration object', async () => {
    const store = new MemoryStore();
    const integration = Object.freeze({ writeDocument: vi.fn(async () => {}), privacySession: { epoch: 'frozen-port', assertCurrent: vi.fn(async () => {}) } });
    let app = new AppControllerImpl(store, {}, integration);

    await app.load();
    const note = await app.saveNote({ transcript: 'Frozen integration stays caller-owned.' });

    expect(note.transcript).toBe('Frozen integration stays caller-owned.');
    expect(Object.keys(integration)).toEqual(['writeDocument', 'privacySession']);
    expect(integration.privacySession.assertCurrent).toHaveBeenCalled();
    expect(Object.isFrozen(integration)).toBe(true);
  });

  it('rejects immediate paid text before preparation, source lookup, cache access, or usage reservation', async () => {
    const store = new MemoryStore();
    const prepare = vi.fn(async () => ({}));
    const analyze = vi.fn(async () => ({}));
    const generateReply = vi.fn(async () => ({}));
    const client = { prepare, analyze, generateReply } as never;
    const app = new AppControllerImpl(store, { openAi: client });
    await app.load();
    const note = await app.saveNote({ transcript: 'A private note that must stay local.' });
    await app.saveSettings({ mode: 'provider', llmProvider: 'azure' });
    const saveCount = store.saves;

    await expect(app.assistNote(note.id, { forceRefresh: true })).rejects.toThrow(/explicit Batch workflow/i);
    await expect((app as unknown as { runAssistNote(id: string): Promise<unknown> }).runAssistNote(note.id)).rejects.toThrow(/explicit Batch workflow/i);
    await expect(app.generateMailReplyText({ messageId: 'missing', sourceDigest: 'missing', textDigest: 'missing', mode: 'reply',
      to: [], cc: [], brief: '', composerRevision: 1 } satisfies MailReplyTextGenerationInput)).rejects.toThrow(/explicit Batch workflow/i);

    expect(prepare).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(generateReply).not.toHaveBeenCalled();
    expect(store.saves).toBe(saveCount);
    expect(app.getSnapshot().usage).toMatchObject({ attempts: 0, attemptsToday: 0, requests: 0, unknownCharges: 0, reservedUsd: 0 });
  });

  it('does not retry Azure OpenAI on a successful HTTP response with malformed JSON', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna', maxAttempts: 2 });
    const note = await app.saveNote({ transcript: 'Prepare a short summary.' });
    const fetcher = vi.fn(async () => new Response('{malformed', { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key');
    const settings = app.getSnapshot().settings;
    const prepared = await client.prepare(note, [], settings);
    await expect(client.analyze(note, [], settings, undefined, undefined, {}, prepared)).rejects.toThrow(/malformed JSON/i);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const replyFetcher = vi.fn(async () => new Response('{malformed', { status: 200, headers: { 'content-type': 'application/json' } }));
    const replyClient = new AzureOpenAIClient(replyFetcher as typeof fetch, async () => 'test-key');
    await expect(replyClient.generateReply({
      sourceText: 'Please review the notes.', sourceRepresentation: 'plain', sourceCompleteness: 'complete_text',
      subject: 'Notes', to: ['sam@example.test'], cc: [], brief: 'Acknowledge the update.', policyContext: '',
      asOf: new Date().toISOString(), timeZone: 'UTC',
    }, settings)).rejects.toThrow(/unreadable|invalid JSON/i);
    expect(replyFetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps background mailbox refresh consent disabled for malformed legacy state and owns its generation', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    expect(app.getSnapshot().settings).toMatchObject({ backgroundMailRefreshEnabled: false, backgroundRefreshGeneration: 0 });
    await app.saveSettings({ backgroundMailRefreshEnabled: true });
    expect(app.getSnapshot().settings).toMatchObject({ backgroundMailRefreshEnabled: true, backgroundRefreshGeneration: 1 });
    await app.saveSettings({ backgroundMailRefreshEnabled: true });
    expect(app.getSnapshot().settings.backgroundRefreshGeneration).toBe(1);
    await app.saveSettings({ backgroundMailRefreshEnabled: false });
    expect(app.getSnapshot().settings).toMatchObject({ backgroundMailRefreshEnabled: false, backgroundRefreshGeneration: 2 });
    await expect(app.saveSettings({ backgroundRefreshGeneration: 80 } as never)).rejects.toThrow(/managed by this app/i);

    const malformed = structuredClone(store.value!);
    malformed.settings = { ...malformed.settings, backgroundMailRefreshEnabled: true, backgroundRefreshGeneration: '4' } as never;
    await store.save(malformed);
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().settings).toMatchObject({ backgroundMailRefreshEnabled: false, backgroundRefreshGeneration: 0 });
  });

  it('creates a mail-origin reply from a fresh verified mailbox snapshot without a synthetic note', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const state = structuredClone(app.getSnapshot());
    const observedAt = new Date().toISOString();
    const account = {
      id: 'mail-account', provider: 'google' as const, displayName: 'Work', email: 'display@example.test', verifiedEmail: 'me@example.test',
      connected: true, authStatus: 'connected' as const, identity: { providerNamespace: 'google' as const, clientId: 'client-1', subject: 'subject-1' },
      tokenRef: 'test-token-ref', capabilities: ['mail.read' as const, 'mail.draft' as const, 'mail.send' as const], connectionGeneration: 3,
    };
    state.accounts.push(account);
    state.mailbox.push({
      id: 'local-message-1', accountId: account.id, providerMessageId: 'provider-message-1', identityKey: 'google:client-1:subject-1:',
      verifiedIdentityKey: 'google:client-1:subject-1:', connectionGeneration: 3, idFormat: 'gmail', threadId: 'thread-1',
      subject: 'Project update', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt,
      replyTo: ['sam@example.test'], to: ['me@example.test', 'alex@example.test'], cc: ['alex@example.test', 'casey@example.test'],
      internetMessageId: '<message-1@example.test>', references: '<parent@example.test>', inReplyTo: '<message-1@example.test>',
      replyMetadataComplete: true, observedAt,
    });
    await store.save(state);
    const storedToken = { accessToken: 'reply-test-token', expiresAt: Date.now() + 60_000, identity: account.identity };
    const restored = new AppControllerImpl(store, {}, { tokenStore: { async get() { return structuredClone(storedToken); }, async set() {} } });
    await restored.load();
    const sourceResult = await restored.getMailReplySource('local-message-1');
    expect(sourceResult.status).toBe('current');
    expect(sourceResult.defaults?.reply).toEqual({ to: ['sam@example.test'], cc: [] });
    expect(sourceResult.defaults?.reply_all).toEqual({ to: ['sam@example.test', 'alex@example.test'], cc: ['casey@example.test'] });
    const proposal = await restored.createMailReplyProposal({
      messageId: 'local-message-1', mode: 'reply_all', sourceDigest: sourceResult.source!.sourceDigest, text: 'Thanks for the update.',
    });
    expect(proposal).toMatchObject({ kind: 'email', status: 'draft', provenance: { version: 3, kind: 'manual_mail_reply', operation: 'draft', lineage: { kind: 'manual' } } });
    expect(proposal).not.toHaveProperty('noteId');
    expect(proposal).not.toHaveProperty('sourceRevision');
    expect(restored.getSnapshot().notes).toEqual([]);
    expect(proposal.email).toMatchObject({ operation: 'draft', subject: 'Project update', bcc: [], attachments: [], to: ['sam@example.test', 'alex@example.test'], cc: ['casey@example.test'] });
    const edited = await restored.editProposal(proposal.id, { title: proposal.title, body: 'Revised without another AI request.', recipients: ['new-recipient@example.test'],
      email: { ...proposal.email!, operation: 'draft', to: ['new-recipient@example.test'], cc: ['copy@example.test'], text: 'Revised without another AI request.' } },
    { expectedRevision: proposal.revision, accountId: account.id, expectedConnectionGeneration: 3 });
    expect(edited).toMatchObject({ status: 'draft', revision: proposal.revision + 1, body: 'Revised without another AI request.', recipients: ['new-recipient@example.test'],
      email: { operation: 'draft', to: ['new-recipient@example.test'], cc: ['copy@example.test'] }, provenance: { operation: 'draft' } });
    expect(edited.provenance?.version === 3 && edited.provenance.source).toEqual(proposal.provenance?.version === 3 ? proposal.provenance.source : undefined);
    const approved = await restored.approveProposal(proposal.id, { expectedRevision: edited.revision });
    expect(approved.status).toBe('approved');
    expect(approved.sourceRevision).toBeUndefined();
    const switched = await restored.editProposal(proposal.id, { title: edited.title, body: 'Reviewed as a send.', recipients: ['new-recipient@example.test'],
      email: { ...edited.email!, operation: 'send', text: 'Reviewed as a send.' } },
    { expectedRevision: approved.revision, accountId: account.id, expectedConnectionGeneration: 3 });
    expect(switched).toMatchObject({ status: 'draft', approvedRevision: undefined, approvedPayloadDigest: undefined,
      email: { operation: 'send', text: 'Reviewed as a send.' }, provenance: { operation: 'send' } });
    const sendApproved = await restored.approveProposal(proposal.id, { expectedRevision: switched.revision });
    expect(sendApproved).toMatchObject({ status: 'approved', email: { operation: 'send' }, provenance: { version: 3, operation: 'send' } });
    const another = await restored.createMailReplyProposal({
      messageId: 'local-message-1', mode: 'reply', sourceDigest: sourceResult.source!.sourceDigest, text: 'A second draft for review.',
    });
    const expiryTampered = store.value!.proposals.find((item) => item.id === another.id)!;
    (expiryTampered.provenance as { expiresAt: string }).expiresAt = new Date(Date.parse(observedAt) + 16 * 60_000).toISOString();
    await store.save(store.value!);
    const badExpiry = new AppControllerImpl(store, {}, { tokenStore: { async get() { return structuredClone(storedToken); }, async set() {} } });
    await badExpiry.load();
    await expect(badExpiry.approveProposal(another.id)).rejects.toThrow();

    const sourceChangeDraft = await restored.createMailReplyProposal({
      messageId: 'local-message-1', mode: 'reply', sourceDigest: sourceResult.source!.sourceDigest, text: 'Recheck the source version.',
    });
    store.value!.mailbox[0].providerVersion = 'etag-changed';
    const afterSourceChange = new AppControllerImpl(store, {}, { tokenStore: { async get() { return structuredClone(storedToken); }, async set() {} } });
    await afterSourceChange.load();
    await expect(afterSourceChange.approveProposal(sourceChangeDraft.id)).rejects.toThrow(/source message changed/i);
  });

  it('returns stale when the reply-source hash finishes after the mailbox snapshot changes', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const state = structuredClone(app.getSnapshot());
    const observedAt = new Date().toISOString();
    const account = {
      id: 'mail-account', provider: 'google' as const, displayName: 'Work', email: 'display@example.test', verifiedEmail: 'me@example.test',
      connected: true, authStatus: 'connected' as const, identity: { providerNamespace: 'google' as const, clientId: 'client-1', subject: 'subject-1' },
      tokenRef: 'test-token-ref', capabilities: ['mail.read' as const], connectionGeneration: 3,
    };
    state.accounts.push(account);
    state.mailbox.push({
      id: 'gated-message', accountId: account.id, providerMessageId: 'provider-gated', identityKey: 'google:client-1:subject-1:',
      verifiedIdentityKey: 'google:client-1:subject-1:', connectionGeneration: 3, idFormat: 'gmail', threadId: 'thread-gated',
      subject: 'Snapshot race', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt,
      internetMessageId: '<gated@example.test>', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [],
      replyMetadataComplete: true, observedAt,
    });
    await store.save(state);
    const token: StoredOAuthToken = { accessToken: 'gated-access', expiresAt: Date.now() + 600_000, identity: account.identity };
    const gated = new AppControllerImpl(store, {}, { tokenStore: { async get() { return structuredClone(token); }, async set() {} } });
    await gated.load();
    expect((await gated.getMailReplySource('gated-message')).status).toBe('current');

    const realDigest = Crypto.digestStringAsync.bind(Crypto);
    let digestCalls = 0;
    let beginDigest!: () => void;
    let releaseDigest!: () => void;
    const digestStarted = new Promise<void>((resolve) => { beginDigest = resolve; });
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const digestSpy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (...args) => {
      digestCalls += 1;
      if (digestCalls === 1) {
        beginDigest();
        await digestGate;
      }
      return realDigest(...args);
    });
    try {
      const pending = gated.getMailReplySource('gated-message');
      await Promise.race([digestStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('digest did not start')), 500))]);
      let unsubscribe: () => void = () => undefined;
      const snapshotChanged = new Promise<void>((resolve) => {
        unsubscribe = gated.subscribe(() => { unsubscribe(); resolve(); });
      });
      const mutation = gated.saveSettings({ timezone: 'Asia/Singapore' });
      await Promise.race([snapshotChanged, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('mutation did not commit')), 500))]);
      releaseDigest();
      await mutation;
      await expect(pending).resolves.toMatchObject({ status: 'stale' });
      expect(digestCalls).toBe(1);
    } finally {
      releaseDigest();
      digestSpy.mockRestore();
    }
  });

  it('derives one manual successor from a stale historical reply using the latest saved source observation', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const state = structuredClone(app.getSnapshot());
    const observedAt = new Date().toISOString();
    const account = {
      id: 'derive-account', provider: 'google' as const, displayName: 'Work', email: 'display@example.test', verifiedEmail: 'me@example.test',
      connected: true, authStatus: 'connected' as const, identity: { providerNamespace: 'google' as const, clientId: 'derive-client', subject: 'derive-subject' },
      tokenRef: 'derive-token-ref', capabilities: ['mail.read' as const, 'mail.draft' as const], connectionGeneration: 5,
    };
    state.accounts.push(account);
    state.mailbox.push({ id: 'derive-message', accountId: account.id, providerMessageId: 'derive-provider-message', identityKey: 'google:derive-client:derive-subject:',
      verifiedIdentityKey: 'google:derive-client:derive-subject:', connectionGeneration: 5, idFormat: 'gmail', threadId: 'derive-thread',
      subject: 'Delayed reply', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt, replyTo: ['sam@example.test'],
      to: ['me@example.test'], cc: [], internetMessageId: '<derive@example.test>', references: '<parent@example.test>', inReplyTo: '<derive@example.test>',
      replyMetadataComplete: true, observedAt });
    await store.save(state);
    const token: StoredOAuthToken = { accessToken: 'derive-token', expiresAt: Date.now() + 600_000, identity: account.identity };
    const tokenStore = { async get() { return structuredClone(token); }, async set() {} };
    const connected = new AppControllerImpl(store, {}, { tokenStore });
    await connected.load();
    const source = await connected.getMailReplySource('derive-message');
    const created = await connected.createMailReplyProposal({ messageId: 'derive-message', mode: 'reply', sourceDigest: source.source!.sourceDigest, text: 'The historical generated reply.' });

    // Model a completed legacy reply whose source observation aged while the result was waiting for review.
    const historical = store.value!.proposals.find((item) => item.id === created.id)!;
    if (historical.provenance?.version !== 3) throw new Error('Expected the new manual reply provenance.');
    const oldObservedAt = new Date(Date.parse(observedAt) - 30 * 60_000).toISOString();
    historical.provenance = { version: 2, kind: 'mail_reply', sourceDigest: historical.provenance.sourceDigest,
      source: { ...historical.provenance.source, observedAt: oldObservedAt }, expiresAt: new Date(Date.parse(oldObservedAt) + 15 * 60_000).toISOString(),
      outputPolicyVersion: 2 };
    await store.save(store.value!);
    const restored = new AppControllerImpl(store, {}, { tokenStore });
    await restored.load();

    const input = { parentProposalId: created.id, expectedParentRevision: created.revision, accountId: account.id,
      expectedConnectionGeneration: account.connectionGeneration, operation: 'draft' as const };
    const results = await Promise.allSettled([restored.deriveManualMailReplyForCommand(input), restored.deriveManualMailReplyForCommand(input)]);
    const children = results.filter((result): result is PromiseFulfilledResult<Proposal> => result.status === 'fulfilled').map((result) => result.value);
    expect(children).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const child = children[0]!;
    expect(child).toMatchObject({ status: 'draft', revision: 1, sourceActionKey: created.sourceActionKey,
      provenance: { version: 3, kind: 'manual_mail_reply', operation: 'draft', source: { observedAt },
        lineage: { kind: 'derived', parentProposalId: created.id, parentRevision: created.revision, parentPayloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    const parent = restored.getSnapshot().proposals.find((item) => item.id === created.id)!;
    expect(parent).toMatchObject({ status: 'draft', revision: created.revision, supersededByProposalId: child.id,
      provenance: { version: 2, source: { observedAt: oldObservedAt } } });
    await expect(restored.editProposal(parent.id, { body: 'Cannot edit a superseded source.' }, { expectedRevision: parent.revision }))
      .rejects.toThrow(/superseded/i);
    const edited = await restored.editProposal(child.id, { title: child.title, body: 'Edited after the delayed result.', recipients: ['new@example.test'],
      email: { ...child.email!, operation: 'draft', to: ['new@example.test'], text: 'Edited after the delayed result.' } },
    { expectedRevision: child.revision, accountId: account.id, expectedConnectionGeneration: account.connectionGeneration });
    await expect(restored.approveProposal(edited.id, { expectedRevision: edited.revision })).resolves.toMatchObject({ status: 'approved', revision: edited.revision });
  });

  it.each(['google', 'microsoft'] as const)('promotes and sends an accepted %s provider draft through ConnectorClient', async (provider) => {
    const store = new MemoryStore();
    const identity = provider === 'google'
      ? { providerNamespace: 'google' as const, clientId: 'connector-promote-client', subject: 'connector-promote-subject' }
      : { providerNamespace: 'microsoft' as const, clientId: 'connector-promote-client', subject: 'connector-promote-subject', resourceUserId: 'connector-promote-resource' };
    const tokenValues = new Map<string, StoredOAuthToken>();
    const requests: { url: string; method: string; body?: string }[] = [];
    let expectedGraphDraft: { subject: string; text: string; to: string[]; cc: string[] } | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      requests.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.endsWith('/v1/userinfo') || url.endsWith('/oidc/userinfo')) return new Response(JSON.stringify({ sub: identity.subject, email: 'me@example.test' }), { status: 200 });
      if (provider === 'microsoft' && url.includes('/v1.0/me?$select=id')) return new Response(JSON.stringify({ id: identity.resourceUserId }), { status: 200 });
      if (provider === 'google' && url.endsWith('/gmail/v1/users/me/drafts')) {
        return new Response(JSON.stringify({ id: 'gmail-accepted-draft-id', message: { threadId: 'connector-promote-thread' } }), { status: 200 });
      }
      if (provider === 'microsoft' && url.endsWith('/createReply')) return new Response(JSON.stringify({ id: 'graph-accepted-draft-id', isDraft: true,
        subject: expectedGraphDraft!.subject, body: { contentType: 'text', content: expectedGraphDraft!.text },
        toRecipients: expectedGraphDraft!.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: expectedGraphDraft!.cc.map((address) => ({ emailAddress: { address } })), bccRecipients: [] }), { status: 201 });
      if (provider === 'google' && url.endsWith('/gmail/v1/users/me/drafts/send')) {
        return new Response(JSON.stringify({ id: 'gmail-new-sent-message-id', threadId: 'connector-promote-thread' }), { status: 200 });
      }
      if (provider === 'microsoft' && url.endsWith('/me/sendMail')) return new Response(null, { status: 202 });
      throw new Error(`Unexpected fake provider request: ${method} ${url}`);
    }) as typeof fetch;
    const tokenStore = { async get(ref: string) { const value = tokenValues.get(ref); return value ? structuredClone(value) : null; },
      async set(ref: string, value: StoredOAuthToken) { tokenValues.set(ref, structuredClone(value)); } };
    const client = new ConnectorClient({ tokenStore, fetcher, googleClientId: identity.clientId, microsoftClientId: identity.clientId });
    const integration = { tokenStore, deleteToken: async () => undefined, clientIds: { google: identity.clientId, microsoft: identity.clientId },
      verifyOAuthResult: async () => true, connectorFactory: () => client as never };
    const app = new AppControllerImpl(store, {}, integration);
    await app.load();
    const grantedScopes = provider === 'google'
      ? ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send']
      : ['openid', 'Mail.ReadWrite', 'Mail.Send'];
    const oauth: OAuthBridgeResult = { provider, accessToken: `${provider}-connector-token`, expiresAt: Date.now() + 600_000, grantedScopes,
      requestedCapabilities: ['mail.read', 'mail.draft', 'mail.send'], capabilities: ['mail.read', 'mail.draft', 'mail.send'], identity,
      displayName: 'Connector promotion account', email: 'me@example.test' };
    tokenValues.set(oauth.accessToken, { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt, identity });
    const account = await app.installVerifiedAccount({ provider, displayName: '', email: '' }, oauth);
    const observedAt = new Date().toISOString();
    const message = { id: `${provider}-connector-message`, accountId: account.id, providerMessageId: `${provider}-connector-provider-message`,
      identityKey: provider === 'google' ? 'google:connector-promote-client:connector-promote-subject:'
        : 'microsoft:connector-promote-client:connector-promote-subject:connector-promote-resource',
      verifiedIdentityKey: provider === 'google' ? 'google:connector-promote-client:connector-promote-subject:'
        : 'microsoft:connector-promote-client:connector-promote-subject:connector-promote-resource',
      connectionGeneration: account.connectionGeneration, idFormat: provider === 'google' ? 'gmail' as const : 'graph-immutable' as const,
      threadId: 'connector-promote-thread', subject: 'Connector promotion', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test',
      internetMessageId: '<connector-promote@example.test>', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [],
      replyMetadataComplete: true, observedAt };
    store.value!.mailbox.push(message);
    await store.save(store.value!);
    const refreshed = new AppControllerImpl(store, {}, integration);
    await refreshed.load();
    await refreshed.saveSettings({ mode: 'provider' });
    const source = await refreshed.getMailReplySource(message.id);
    expect(source.status).toBe('current');
    const parentDraft = await refreshed.createMailReplyProposal({ messageId: message.id, mode: 'reply', sourceDigest: source.source!.sourceDigest,
      text: 'Approved provider draft text.' });
    expectedGraphDraft = { subject: parentDraft.email!.reply!.sourceSubject, text: parentDraft.email!.text,
      to: parentDraft.email!.to, cc: parentDraft.email!.cc };
    await refreshed.approveProposal(parentDraft.id);
    const acceptedParent = await refreshed.executeProposal(parentDraft.id);
    expect(acceptedParent).toMatchObject({ status: 'accepted', remoteOperation: 'draft',
      remoteId: provider === 'google' ? 'gmail-accepted-draft-id' : 'graph-accepted-draft-id' });
    const parentBeforePromotion = structuredClone(refreshed.getSnapshot().proposals.find((item) => item.id === parentDraft.id)!);
    const parentReceipt = refreshed.getSnapshot().dispatchRecords.find((item) => item.id === parentBeforePromotion.dispatchRecordId)!;
    expect(parentReceipt.replyDraftCheck).toBe(provider === 'google' ? 'unverified' : 'matches_approved');
    const originalLimits = [...refreshed.getSnapshot().accounts.find((item) => item.id === account.id)!.capabilityLimits!];
    await (refreshed as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
      draft.accounts.find((item) => item.id === account.id)!.capabilityLimits = originalLimits.filter((capability) => capability !== (provider === 'google' ? 'mail.draft' : 'mail.send'));
    });
    await expect(refreshed.promoteAcceptedMailReplyDraftForCommand({ parentProposalId: parentDraft.id,
      expectedParentRevision: parentBeforePromotion.revision, draftDispatchRecordId: parentReceipt.id, accountId: account.id,
      expectedConnectionGeneration: account.connectionGeneration! })).rejects.toThrow(/permission|capability|scope/i);
    await (refreshed as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
      draft.accounts.find((item) => item.id === account.id)!.capabilityLimits = originalLimits;
    });
    const child = await refreshed.promoteAcceptedMailReplyDraftForCommand({ parentProposalId: parentDraft.id,
      expectedParentRevision: parentBeforePromotion.revision, draftDispatchRecordId: parentReceipt.id, accountId: account.id,
      expectedConnectionGeneration: account.connectionGeneration! });
    expect(child.provenance).toMatchObject({ version: 3, operation: 'send', lineage: { kind: 'accepted_draft',
      parentProposalId: parentDraft.id, remoteDraftId: parentReceipt.remoteId } });
    await refreshed.approveProposal(child.id, { expectedRevision: child.revision });
    const sent = await refreshed.executeProposal(child.id);
    expect(sent).toMatchObject({ status: 'accepted', remoteOperation: 'send' });
    expect(refreshed.getSnapshot().proposals.find((item) => item.id === parentDraft.id)).toEqual({ ...parentBeforePromotion,
      supersededByProposalId: child.id });
    expect(refreshed.getSnapshot().dispatchRecords.find((item) => item.id === parentReceipt.id)).toEqual(parentReceipt);
    expect(requests.filter((request) => request.method === 'POST').map((request) => request.url)).toEqual(provider === 'google'
      ? ['https://gmail.googleapis.com/gmail/v1/users/me/drafts', 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send']
      : ['https://graph.microsoft.com/v1.0/me/messages/microsoft-connector-provider-message/createReply', 'https://graph.microsoft.com/v1.0/me/sendMail']);
    if (provider === 'google') expect(sent.remoteId).toBe('gmail-new-sent-message-id');
    else expect(sent.remoteId).toBeUndefined();
  });

  it('promotes an accepted v2 mail reply through its exact historical draft receipt into a fresh send copy', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'promote-client', subject: 'promote-subject' };
    const tokenValues = new Map<string, StoredOAuthToken>();
    let providerWrites = 0;
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async createDraft(_account: unknown, envelope: Record<string, unknown>, verifier: { verify(value: never): Promise<boolean>; verifyBeforeDispatch(value: never): boolean }) {
        expect(await verifier.verify(envelope as never)).toBe(true);
        expect(verifier.verifyBeforeDispatch(envelope as never)).toBe(true);
        providerWrites += 1;
        return { status: 'accepted' as const, id: 'opaque-provider-draft:α-1', replyDraftCheck: 'matches_approved' as const };
      },
    };
    const integration = { tokenStore: { async get(ref: string) { const value = tokenValues.get(ref); return value ? structuredClone(value) : null; },
      async set(ref: string, value: StoredOAuthToken) { tokenValues.set(ref, structuredClone(value)); } }, deleteToken: async () => undefined,
      clientIds: { google: 'promote-client' }, verifyOAuthResult: async () => true, connectorFactory: () => connector as never };
    let app = new AppControllerImpl(store, {}, integration);
    await app.load();
    const oauth: OAuthBridgeResult = { provider: 'google', accessToken: 'promote-token', expiresAt: Date.now() + 600_000,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send'],
      requestedCapabilities: ['mail.read', 'mail.draft', 'mail.send'], capabilities: ['mail.read', 'mail.draft', 'mail.send'], identity,
      displayName: 'Promotion account', email: 'me@example.test' };
    tokenValues.set('promote-token', { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt, identity });
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, oauth);
    const observedAt = new Date().toISOString();
    const message = { id: 'promote-message', accountId: account.id, providerMessageId: 'promote-provider-message',
      identityKey: 'google:promote-client:promote-subject:', verifiedIdentityKey: 'google:promote-client:promote-subject:',
      connectionGeneration: account.connectionGeneration, idFormat: 'gmail' as const, threadId: 'promote-thread', subject: 'Review this reply',
      from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', internetMessageId: '<promote@example.test>', replyTo: ['sam@example.test'],
      to: ['me@example.test'], cc: [], replyMetadataComplete: true, observedAt };
    store.value!.mailbox.push(message);
    await store.save(store.value!);
    app = new AppControllerImpl(store, {}, integration);
    await app.load();
    await app.saveSettings({ mode: 'provider' });
    const source = await app.getMailReplySource(message.id);
    expect(source).toMatchObject({ status: 'current' });
    const parentDraft = await app.createMailReplyProposal({ messageId: message.id, mode: 'reply', sourceDigest: source.source!.sourceDigest, text: 'Reviewed batch reply.' });
    const historical = store.value!.proposals.find((item) => item.id === parentDraft.id)!;
    const v3 = historical.provenance!;
    if (v3.version !== 3) throw new Error('Expected a current manual mail reply before the legacy fixture conversion.');
    historical.provenance = { version: 2, kind: 'mail_reply', sourceDigest: v3.sourceDigest, source: v3.source,
      expiresAt: v3.expiresAt, outputPolicyVersion: 2 };
    await store.save(store.value!);
    let restored = new AppControllerImpl(store, {}, integration);
    await restored.load();
    await restored.approveProposal(parentDraft.id);
    const accepted = await restored.executeProposal(parentDraft.id);
    expect(accepted).toMatchObject({ status: 'accepted', remoteOperation: 'draft', remoteId: 'opaque-provider-draft:α-1' });
    const acceptedParentBefore = structuredClone(restored.getSnapshot().proposals.find((item) => item.id === parentDraft.id)!);
    const draftRecord = restored.getSnapshot().dispatchRecords.find((record) => record.id === acceptedParentBefore.dispatchRecordId)!;
    const promotion = { parentProposalId: parentDraft.id,
      expectedParentRevision: acceptedParentBefore.revision, draftDispatchRecordId: draftRecord.id, accountId: account.id,
      expectedConnectionGeneration: account.connectionGeneration! };
    const firstPromotions = await Promise.allSettled([restored.promoteAcceptedMailReplyDraftForCommand(promotion),
      restored.promoteAcceptedMailReplyDraftForCommand(promotion)]);
    const children = firstPromotions.filter((result): result is PromiseFulfilledResult<Proposal> => result.status === 'fulfilled').map((result) => result.value);
    expect(children).toHaveLength(1);
    expect(firstPromotions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const child = children[0]!;
    expect(child).toMatchObject({ status: 'draft', revision: 1, accountId: account.id, sourceActionKey: acceptedParentBefore.sourceActionKey,
      email: { operation: 'send' }, provenance: { version: 3, kind: 'manual_mail_reply', operation: 'send',
        lineage: { kind: 'accepted_draft', parentProposalId: parentDraft.id, parentRevision: acceptedParentBefore.revision,
          draftDispatchRecordId: draftRecord.id, remoteDraftId: 'opaque-provider-draft:α-1' } } });
    expect(providerWrites).toBe(1);
    const acceptedParentAfter = restored.getSnapshot().proposals.find((item) => item.id === parentDraft.id)!;
    expect(acceptedParentAfter).toEqual({ ...acceptedParentBefore, supersededByProposalId: child.id });
    expect(acceptedParentAfter).toMatchObject({ status: 'accepted', approvedRevision: acceptedParentBefore.approvedRevision,
      approvedPayloadDigest: acceptedParentBefore.approvedPayloadDigest, remoteId: 'opaque-provider-draft:α-1' });
    await expect(restored.editProposal(child.id, { email: { ...child.email!, operation: 'draft' } }, { expectedRevision: child.revision,
      accountId: account.id, expectedConnectionGeneration: account.connectionGeneration! })).rejects.toThrow(/send/i);
    await expect(restored.deriveManualMailReplyForCommand({ parentProposalId: child.id, expectedParentRevision: child.revision,
      accountId: account.id, expectedConnectionGeneration: account.connectionGeneration!, operation: 'draft' })).rejects.toThrow(/accepted provider draft/i);
    restored = new AppControllerImpl(store, {}, integration);
    await restored.load();
    expect(restored.getSnapshot().proposals.find((item) => item.id === child.id)?.provenance).toMatchObject({ version: 3, operation: 'send',
      lineage: { kind: 'accepted_draft', parentProposalId: parentDraft.id, draftDispatchRecordId: draftRecord.id } });
  });

  it('executes frozen mail replies without notes, preserves unknown receipts, and blocks a changed connection before the write', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'reply-client', subject: 'reply-subject' };
    const tokens = new Map<string, StoredOAuthToken>();
    const tokenStore = {
      async get(ref: string) { const value = tokens.get(ref); return value ? structuredClone(value) : null; },
      async set(ref: string, value: StoredOAuthToken) { tokens.set(ref, structuredClone(value)); },
    };
    const oauth: OAuthBridgeResult = {
      provider: 'google', accessToken: 'reply-access', expiresAt: Date.now() + 600_000,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
      requestedCapabilities: ['mail.read', 'mail.draft'], capabilities: ['mail.read', 'mail.draft'], identity,
      displayName: 'Reply account', email: 'me@example.test',
    };
    let prepareStarted!: () => void;
    let releasePrepare!: () => void;
    let pauseNext = false;
    let attemptedDrafts = 0;
    let completedProviderWrites = 0;
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async createDraft(_account: unknown, envelope: Record<string, unknown>, verifier: { verify(value: never): Promise<boolean>; verifyBeforeDispatch(value: never): boolean }) {
        expect(envelope.replySource).toMatchObject({ version: 3, kind: 'manual_mail_reply', operation: 'draft' });
        expect(envelope.sourceRevision).toBeUndefined();
        expect(await verifier.verify(envelope as never)).toBe(true);
        attemptedDrafts += 1;
        if (pauseNext) {
          pauseNext = false;
          prepareStarted();
          await new Promise<void>((resolve) => { releasePrepare = resolve; });
        }
        if (!verifier.verifyBeforeDispatch(envelope as never)) throw new Error('Approved action changed before provider dispatch.');
        completedProviderWrites += 1;
        if (attemptedDrafts === 1) return { status: 'accepted' as const, id: 'provider-draft-1', replyDraftCheck: 'matches_approved' as const };
        if (attemptedDrafts === 2) return { status: 'unknown' as const };
        return { status: 'accepted' as const, id: 'unexpected' };
      },
    };
    const integration = {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'reply-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    };
    const seed = new AppControllerImpl(store, {}, integration);
    await seed.load();
    const account = await seed.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, oauth);
    const observedAt = new Date().toISOString();
    const message = {
      id: 'reply-local-1', accountId: account.id, providerMessageId: 'reply-provider-1', identityKey: 'google:reply-client:reply-subject:',
      verifiedIdentityKey: 'google:reply-client:reply-subject:', connectionGeneration: account.connectionGeneration, idFormat: 'gmail' as const,
      threadId: 'reply-thread-1', subject: 'Quarterly update', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test',
      internetMessageId: '<reply-1@example.test>', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [],
      replyMetadataComplete: true, observedAt,
    };
    store.value!.mailbox.push(message);
    await store.save(store.value!);
    let app = new AppControllerImpl(store, {}, integration);
    await app.load();
    await app.saveSettings({ mode: 'provider' });

    const source = await app.getMailReplySource(message.id);
    expect(source.status).toBe('current');
    const acceptedDraft = await app.createMailReplyProposal({ messageId: message.id, mode: 'reply', sourceDigest: source.source!.sourceDigest, text: 'Thanks.' });
    await app.approveProposal(acceptedDraft.id);
    const accepted = await app.executeProposal(acceptedDraft.id);
    expect(accepted).toMatchObject({ status: 'accepted', remoteOperation: 'draft', remoteId: 'provider-draft-1' });
    expect(app.getSnapshot().dispatchRecords[0]).toMatchObject({
      operation: 'draft', outcome: 'accepted', replyDraftCheck: 'matches_approved',
      sourceProvenance: { version: 3, source: { localMessageId: message.id } },
    });
    expect(app.getSnapshot().dispatchRecords[0]).not.toHaveProperty('sourceRevision');
    expect(app.getSnapshot().notes).toEqual([]);

    app = new AppControllerImpl(store, {}, integration);
    await app.load();
    expect(app.getSnapshot().dispatchRecords[0].sourceProvenance.version).toBe(3);
    const unknownDraft = await app.createMailReplyProposal({ messageId: message.id, mode: 'reply_all', sourceDigest: source.source!.sourceDigest, text: 'Another response.' });
    const unknownApproved = await app.approveProposal(unknownDraft.id);
    const unknownExecution = await app.executeProposalForCommand(unknownDraft.id, { expectedRevision: unknownApproved.revision });
    expect(unknownExecution.kind).toBe('settled');
    if (unknownExecution.kind !== 'settled') throw new Error('Expected a settled execution result.');
    expect(unknownExecution.proposal.status).toBe('unknown');
    expect(unknownExecution.dispatch?.outcome).toBe('unknown');
    expect(unknownExecution.proposal.status).toBe(app.getSnapshot().proposals.find((item) => item.id === unknownDraft.id)?.status);
    const afterUnknown = new AppControllerImpl(store, {}, integration);
    await afterUnknown.load();
    expect(afterUnknown.getSnapshot().dispatchRecords[0]).toMatchObject({ outcome: 'unknown', operation: 'draft' });
    await expect(afterUnknown.createMailReplyProposal({ messageId: message.id, mode: 'reply_all', sourceDigest: source.source!.sourceDigest, text: 'Different body cannot bypass the guard.' })).rejects.toThrow(/already exists/i);
    await expect(afterUnknown.executeProposal(unknownDraft.id)).rejects.toThrow(/approve this exact version/i);

    const secondMessage = { ...message, id: 'reply-local-2', providerMessageId: 'reply-provider-2', threadId: 'reply-thread-2', internetMessageId: '<reply-2@example.test>' };
    store.value!.mailbox.push(secondMessage);
    await store.save(store.value!);
    app = new AppControllerImpl(store, {}, integration);
    await app.load();
    const secondSource = await app.getMailReplySource(secondMessage.id);
    const fencedDraft = await app.createMailReplyProposal({ messageId: secondMessage.id, mode: 'reply', sourceDigest: secondSource.source!.sourceDigest, text: 'This should be blocked before write.' });
    await app.approveProposal(fencedDraft.id);
    pauseNext = true;
    const prepared = new Promise<void>((resolve) => { prepareStarted = resolve; });
    const pending = app.executeProposal(fencedDraft.id);
    await prepared;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(secondMessage.observedAt) - 1);
    try {
      releasePrepare();
      const blockedByClock = await pending;
      expect(blockedByClock).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/changed before provider dispatch/i) });
    } finally {
      clock.mockRestore();
    }
    expect(completedProviderWrites).toBe(2);
    expect(app.getSnapshot().dispatchRecords.find((record) => record.proposalId === fencedDraft.id)).toMatchObject({ outcome: 'rejected', rejectionCode: 'precondition_failed' });

    const thirdMessage = { ...message, id: 'reply-local-3', providerMessageId: 'reply-provider-3', threadId: 'reply-thread-3', internetMessageId: '<reply-3@example.test>' };
    store.value!.mailbox.push(thirdMessage);
    await store.save(store.value!);
    app = new AppControllerImpl(store, {}, integration);
    await app.load();
    const thirdSource = await app.getMailReplySource(thirdMessage.id);
    const disconnectDraft = await app.createMailReplyProposal({ messageId: thirdMessage.id, mode: 'reply', sourceDigest: thirdSource.source!.sourceDigest, text: 'This should be blocked before write.' });
    await app.approveProposal(disconnectDraft.id);
    pauseNext = true;
    const disconnectPrepared = new Promise<void>((resolve) => { prepareStarted = resolve; });
    const disconnectPending = app.executeProposal(disconnectDraft.id);
    await disconnectPrepared;
    await app.disconnectAccount(account.id);
    releasePrepare();
    const blocked = await disconnectPending;
    expect(blocked).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/changed before provider dispatch/i) });
    expect(completedProviderWrites).toBe(2);
    expect(app.getSnapshot().dispatchRecords.find((record) => record.proposalId === disconnectDraft.id)).toMatchObject({ outcome: 'rejected', rejectionCode: 'precondition_failed' });
  });

  it('loads bounded selected mail text but requires the explicit Batch workflow for paid generation', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'text-client', subject: 'text-subject' };
    const observedAt = new Date().toISOString();
    const tokenExpiry = Date.now() + 600_000;
    const text = 'Thanks, I will review the notes.\r\nI prefer concise replies.';
    let providerCalls = 0;
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async readSelectedMessageText(_account: unknown, providerMessageId: string) {
        return { status: 'available', message: { id: providerMessageId, idFormat: 'gmail' as const, threadId: 'text-thread', subject: 'Review notes',
          from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt, snippet: 'Please review.', replyMetadataComplete: true,
          internetMessageId: '<text-1@example.test>', providerVersion: 'history-1', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [] },
          text, bytes: new TextEncoder().encode(text).length, representation: 'plain', completeness: 'complete_text', reasons: [], checkedAt: observedAt, extractionVersion: 'mail-text-v1' };
      },
    };
    const tokenStore = { async get() { return { accessToken: 'access', expiresAt: tokenExpiry, identity }; }, async set() {} };
    const app = new AppControllerImpl(store, { openAi: new AzureOpenAIClient(async () => { providerCalls += 1; return new Response('{}'); }, async () => 'fixture-key') }, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'text-client' }, verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: 'Mail', email: '' }, {
      provider: 'google', accessToken: 'access', expiresAt: tokenExpiry, grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], identity, displayName: 'Mail', email: 'me@example.test',
    });
    const message = { id: 'text-local', accountId: account.id, providerMessageId: 'text-provider', identityKey: 'google:text-client:text-subject:',
      verifiedIdentityKey: 'google:text-client:text-subject:', connectionGeneration: account.connectionGeneration, idFormat: 'gmail' as const,
      threadId: 'text-thread', subject: 'Review notes', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt,
      snippet: 'Please review.', replyMetadataComplete: true, internetMessageId: '<text-1@example.test>', providerVersion: 'history-1',
      replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [], observedAt };
    store.value!.mailbox.push(message);
    await store.save(store.value!);
    const reloaded = new AppControllerImpl(store, { openAi: new AzureOpenAIClient(async () => { providerCalls += 1; return new Response('{}'); }, async () => 'fixture-key') }, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'text-client' }, verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    });
    await reloaded.load();
    await reloaded.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const source = await reloaded.getMailReplySource(message.id);
    const loaded = await reloaded.loadMailReplyText({ messageId: message.id, sourceDigest: source.source!.sourceDigest });
    expect(loaded).toMatchObject({ status: 'current', snapshot: { representation: 'plain', completeness: 'complete_text' } });
    expect(loaded.snapshot?.text).toBe('Thanks, I will review the notes.\nI prefer concise replies.');
    await expect(reloaded.generateMailReplyText({ messageId: message.id, sourceDigest: loaded.snapshot!.sourceDigest, textDigest: loaded.snapshot!.textDigest!,
      mode: 'reply', to: ['sam@example.test'], cc: [], brief: 'Acknowledge the notes.', composerRevision: 1 })).rejects.toThrow(/explicit Batch workflow/i);
    expect(providerCalls).toBe(0);
    expect(reloaded.getSnapshot().usage.attemptsToday).toBe(0);
  });
  it('invalidates approval after an edit and keeps source revisions tied to the original note', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'I need to finish the report tomorrow.' });
    const [draft] = await app.processNote(note.id);
    const approved = await app.approveProposal(draft.id);
    expect(approved.status).toBe('approved');
    const edited = await app.editProposal(draft.id, { title: 'Send the revised report' }, { expectedRevision: draft.revision });
    expect(app.getSnapshot().proposals[0].status).toBe('draft');
    await expect(app.approveProposal(draft.id, { expectedRevision: draft.revision })).rejects.toThrow(/changed/i);
    await expect(app.executeProposal(draft.id, { expectedRevision: draft.revision })).rejects.toThrow(/changed/i);
    await app.approveProposal(draft.id, { expectedRevision: edited.revision });
    await app.updateTranscript(note.id, 'I need to finish the revised report today.');
    const sourceInvalidated = app.getSnapshot().proposals.find((item) => item.id === draft.id)!;
    await expect(app.approveProposal(draft.id, { expectedRevision: sourceInvalidated.revision })).rejects.toThrow(/source transcript changed/i);
    const [fresh] = await app.processNote(note.id);
    expect(fresh.sourceRevision).toBe(app.getSnapshot().notes[0].revision);
  });

  it('checks an optional transcript revision inside the mutation before changing the note', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'A transcript that is still current.' });
    const current = app.getSnapshot().notes.find((item) => item.id === note.id)!;
    const edited = await app.updateTranscript(note.id, 'The expected revision update.', { expectedRevision: current.revision });
    expect(edited.transcript).toBe('The expected revision update.');
    const stateBeforeStaleWrite = app.getSnapshot();
    await expect(app.updateTranscript(note.id, 'A stale overwrite.', { expectedRevision: current.revision })).rejects.toThrow(/note changed/i);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)).toEqual(stateBeforeStaleWrite.notes.find((item) => item.id === note.id));
  });

  it('rechecks a proposal’s own provenance before review and persists invalidation only when it changes', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'I need to buy groceries tomorrow.' });
    const [proposal] = await app.processNote(note.id);
    await app.approveProposal(proposal.id);
    await saveDocumentCurrent(app, 'memory/RULES.md', 'Never create reminders without a time.');
    const stale = await app.checkProposalFreshness(proposal.id);
    expect(stale).toMatchObject({ current: false });
    expect(app.getSnapshot().proposals.find((item) => item.id === proposal.id)).toMatchObject({
      status: 'draft', requiresRebuild: true, approvedPayloadDigest: undefined,
    });
    const saveCount = store.saves;
    const repeated = await app.checkProposalFreshness(proposal.id);
    expect(repeated.current).toBe(false);
    expect(store.saves).toBe(saveCount);
    await expect(app.approveProposal(proposal.id)).rejects.toThrow(/run assist again/i);
  });

  it('persists locally and reloads a saved note', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    const note = await first.saveNote({ transcript: 'Remember to call Sam.' });
    const second = new AppControllerImpl(store);
    await second.load();
    expect(second.getSnapshot().notes[0]).toMatchObject({ id: note.id, transcript: 'Remember to call Sam.' });
  });

  it('quarantines invalid dispatch receipts privately and omits them from portable exports', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    await first.saveNote({ transcript: 'Keep the appointment notes.' });
    store.value!.dispatchRecords = [{ id: 'invalid-receipt', secret: 'private-corrupt-data' }] as never;
    Object.assign(store.value!, { dispatchRecordQuarantine: [{ reason: 'invalid_persisted_receipt', quarantinedAt: new Date().toISOString(), raw: { detail: 'legacy-private-sentinel' } }] });
    const recovered = new AppControllerImpl(store);
    const observedSnapshots: string[] = [];
    recovered.subscribe((state) => observedSnapshots.push(JSON.stringify(state)));
    await recovered.load();
    expect(recovered.getSnapshot().dispatchRecords).toEqual([]);
    expect(recovered.getSnapshot().dispatchRecoveryStatus).toMatchObject({ quarantinedCount: 2 });
    expect(JSON.stringify(recovered.getSnapshot())).not.toContain('private-corrupt-data');
    expect(JSON.stringify(recovered.getSnapshot())).not.toContain('legacy-private-sentinel');
    expect(observedSnapshots.join('\n')).not.toContain('legacy-private-sentinel');
    const persistedQuarantine = (store.value as unknown as { dispatchRecordQuarantine?: unknown[] }).dispatchRecordQuarantine;
    expect(persistedQuarantine).toHaveLength(2);
    expect(JSON.stringify(persistedQuarantine)).toContain('legacy-private-sentinel');
    await recovered.saveNote({ transcript: 'An unrelated ordinary mutation.' });
    expect(JSON.stringify((store.value as unknown as { dispatchRecordQuarantine?: unknown[] }).dispatchRecordQuarantine)).toContain('legacy-private-sentinel');
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().dispatchRecoveryStatus).toMatchObject({ quarantinedCount: 2 });
    expect(JSON.stringify(reloaded.getSnapshot())).not.toContain('legacy-private-sentinel');
    const exported = await recovered.exportData();
    expect(exported).not.toContain('dispatchRecordQuarantine');
    expect(exported).not.toContain('private-corrupt-data');
    expect(exported).not.toContain('legacy-private-sentinel');
  });

  it('blocks a real provider dispatch while corrupt receipts remain privately quarantined', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'quarantine-client', subject: 'quarantine-subject' };
    const token = { accessToken: 'quarantine-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get() { return structuredClone(token); }, async set() {} };
    const oauth: OAuthBridgeResult = {
      provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
      requestedCapabilities: ['mail.read', 'mail.draft'], capabilities: ['mail.read', 'mail.draft'], identity,
      displayName: 'Quarantine test', email: 'me@example.test',
    };
    const providerWrite = vi.fn(async () => ({ status: 'accepted' as const, id: 'must-not-write' }));
    const integration = {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: identity.clientId },
      verifyOAuthResult: async () => true,
      connectorFactory: () => ({ createDraft: providerWrite, verifyOAuthIdentity: async () => true }) as never,
    };
    const seed = new AppControllerImpl(store, {}, integration);
    await seed.load();
    const account = await seed.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, oauth);
    const observedAt = new Date().toISOString();
    const message = {
      id: 'quarantine-mail', accountId: account.id, providerMessageId: 'provider-quarantine-mail', identityKey: 'google:quarantine-client:quarantine-subject:',
      verifiedIdentityKey: 'google:quarantine-client:quarantine-subject:', connectionGeneration: account.connectionGeneration, idFormat: 'gmail' as const,
      threadId: 'quarantine-thread', subject: 'Receipt quarantine fence', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test',
      internetMessageId: '<quarantine@example.test>', replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [],
      replyMetadataComplete: true, observedAt,
    };
    store.value!.mailbox.push(message);
    await store.save(store.value!);
    const ready = new AppControllerImpl(store, {}, integration);
    await ready.load();
    await ready.saveSettings({ mode: 'provider' });
    const source = await ready.getMailReplySource(message.id);
    const proposal = await ready.createMailReplyProposal({ messageId: message.id, mode: 'reply', sourceDigest: source.source!.sourceDigest, text: 'Thanks.' });
    await ready.approveProposal(proposal.id);

    store.value!.dispatchRecords = [{ id: 'invalid-private-receipt', secret: 'dispatch-quarantine-write-sentinel' }] as never;
    const blocked = new AppControllerImpl(store, {}, integration);
    await blocked.load();
    expect(blocked.getSnapshot().dispatchRecoveryStatus).toMatchObject({ quarantinedCount: 1 });
    await expect(blocked.executeProposal(proposal.id)).rejects.toThrow(/Dispatch history failed integrity validation/i);
    expect(providerWrite).not.toHaveBeenCalled();
    expect(blocked.getSnapshot().dispatchRecords).toEqual([]);
    expect(JSON.stringify(blocked.getSnapshot())).not.toContain('dispatch-quarantine-write-sentinel');
  });

  it('retains a non-array legacy dispatch quarantine envelope privately across mutation and reload', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    const privateRaw = { marker: 'scalar-envelope-sentinel', nested: ['do-not-expose'] };
    Object.assign(store.value!, { dispatchRecordQuarantine: privateRaw });
    const recovered = new AppControllerImpl(store);
    await recovered.load();
    expect(recovered.getSnapshot().dispatchRecoveryStatus).toMatchObject({ quarantinedCount: 1 });
    expect(JSON.stringify(recovered.getSnapshot())).not.toContain('scalar-envelope-sentinel');
    await recovered.saveSettings({ timezone: 'Asia/Singapore' });
    expect(JSON.stringify((store.value as unknown as { dispatchRecordQuarantine?: unknown }).dispatchRecordQuarantine)).toContain('scalar-envelope-sentinel');
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().dispatchRecoveryStatus).toMatchObject({ quarantinedCount: 1 });
    expect(JSON.stringify(reloaded.getSnapshot())).not.toContain('scalar-envelope-sentinel');
  });

  it('uses the dedicated mailbox head and backfill lanes with hydrated metadata and persisted cursors', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'provider-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get() { return structuredClone(token); }, async set() {} };
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], identity,
      displayName: 'Verified User', email: 'user@example.com',
    };
    let backfillCalls = 0;
    let mailboxCalls = 0;
    let resumedCursor: string | undefined;
    let legacyMailCalls = 0;
    let lastCursor: string | undefined;
    let lastRequestedRange: { from: string; through: string } | undefined;
    let failNextMail = false;
    let nextLane: 'head' | 'backfill' = 'head';
    let summary = { id: 'provider-message', idFormat: 'gmail' as const, subject: 'Meeting', receivedAt: '2026-10-12T01:00:00Z', senderEmail: 'sam@example.com', isRead: false, replyMetadataComplete: true, internetMessageId: '<msg@example.com>', to: ['me@example.com'] };
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async syncMessages() { legacyMailCalls++; throw new Error('Legacy mailbox sync must not be used.'); },
      async syncMessageWindow(_account: unknown, options: { timeMin: string; timeMax: string; cursor?: string; pageSize?: number; onPage?: (items: unknown[], cursor: string | undefined, pages: number, metadata: { unavailableIds: string[]; window: { from: string; to: string }; queryFingerprint: string }) => unknown }) {
        if (failNextMail) { failNextMail = false; throw new Error('provider unavailable'); }
        expect(options.pageSize).toBe(5);
        const descriptor = describeMessageWindowQuery(account, { timeMin: options.timeMin, timeMax: options.timeMax, pageSize: options.pageSize });
        lastRequestedRange = { from: options.timeMin, through: options.timeMax };
        const isBackfill = nextLane === 'backfill';
        mailboxCalls++;
        const cursor = isBackfill && backfillCalls === 0 ? 'saved-backfill-cursor' : undefined;
        if (isBackfill) { resumedCursor = options.cursor; backfillCalls++; }
        lastCursor = options.cursor;
        await options.onPage?.([summary], cursor, 1, { unavailableIds: [], window: { from: descriptor.window.from, to: descriptor.window.to }, queryFingerprint: descriptor.queryFingerprint });
        return { items: [summary], nextCursor: cursor, pagesRead: 1, partial: Boolean(cursor), window: descriptor.window, queryFingerprint: descriptor.queryFingerprint, unavailableIds: [] };
      },
      async listCalendars() { throw new Error('A mailbox-only account should not list calendars.'); },
      async readCalendarEvents() { throw new Error('A mailbox-only account should not read calendar events.'); },
    };
    let app = new AppControllerImpl(store, {}, {
      tokenStore,
      deleteToken: async () => undefined,
      clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true,
      connectorFactory: () => connector as never,
    });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: 'Ignored label', email: 'other@example.com' }, result);
    expect(account).toMatchObject({ connected: true, authStatus: 'connected', email: 'user@example.com', capabilities: ['mail.read'] });
    await expect(app.syncAccount(account.id)).rejects.toThrow(/Refresh inbox or Continue backfill/);
    nextLane = 'head';
    const head = await app.refreshMailHead(account.id);
    expect(head).toMatchObject({ status: 'complete', lane: 'head' });
    expect(app.getSnapshot().mailbox).toHaveLength(1);
    expect(app.getSnapshot().mailbox[0]).toMatchObject({ idFormat: 'gmail', senderEmail: 'sam@example.com', isRead: false, replyMetadataComplete: true, to: ['me@example.com'] });
    const note = await app.saveNote({ transcript: 'Please review the Meeting message from provider-message.' });
    const sourceId = `mail:${encodeURIComponent('google:google-client:provider-subject:')}:${encodeURIComponent('provider-message')}`;
    const storedNote = store.value!.notes.find((item) => item.id === note.id)!;
    storedNote.analysis = { stale: false, sourceVersions: { [sourceId]: `0:${'a'.repeat(64)}` } } as never;
    app = new AppControllerImpl(store, {}, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    });
    await app.load();
    nextLane = 'head';
    await app.refreshMailHead(account.id);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.stale).toBe(false);
    summary = { ...summary, subject: 'Changed meeting title' };
    nextLane = 'head';
    await app.refreshMailHead(account.id);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.stale).toBe(true);
    const coverageBeforeBackfill = app.getSnapshot().syncStates[account.id].mailBackfill.coverage;
    nextLane = 'backfill';
    const partial = await app.continueMailBackfill(account.id);
    expect(partial).toMatchObject({ status: 'partial', state: { mailBackfill: { status: 'partial', activeWindow: { cursor: 'saved-backfill-cursor' } } } });
    expect(partial.state.mailBackfill.coverage?.through).toBe(coverageBeforeBackfill?.through);
    expect(Date.parse(partial.state.mailBackfill.coverage!.from)).toBeGreaterThanOrEqual(Date.parse(coverageBeforeBackfill!.from));
    const capturedPartialWindow = partial.state.mailBackfill.activeWindow;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(capturedPartialWindow!.through) + 2 * 86_400_000));
    nextLane = 'backfill';
    let complete;
    try {
      complete = await app.continueMailBackfill(account.id);
    } finally {
      vi.useRealTimers();
    }
    expect(resumedCursor).toBe('saved-backfill-cursor');
    expect(lastRequestedRange).toEqual({ from: capturedPartialWindow!.from, through: capturedPartialWindow!.through });
    expect(complete).toMatchObject({ status: 'complete', state: { mailBackfill: { status: 'idle', coverage: { from: expect.any(String), through: expect.any(String) } } } });
    expect(app.getSnapshot().mailbox).toHaveLength(1);
    expect(legacyMailCalls).toBe(0);
    const callsBeforeCooldown = mailboxCalls;
    const foreground = await app.refreshForegroundMail();
    expect(foreground).toMatchObject({ attempted: [], skipped: [{ accountId: account.id }] });
    expect(mailboxCalls).toBe(callsBeforeCooldown);
    nextLane = 'head';
    await app.refreshMailHead(account.id, { reason: 'manual' });
    expect(mailboxCalls).toBe(callsBeforeCooldown + 1);
    expect(lastCursor).toBeUndefined();
    const lastGoodCheck = app.getSnapshot().syncStates[account.id].mailHead.lastPageCheckedAt;
    failNextMail = true;
    nextLane = 'head';
    const failed = await app.refreshMailHead(account.id);
    expect(failed).toMatchObject({ status: 'error', message: 'provider unavailable' });
    expect(failed.state.mailHead.lastPageCheckedAt).toBe(lastGoodCheck);
    expect(failed.state.mailHead.lastAttemptAt).toEqual(expect.any(String));

    const persisted = store.value!;
    persisted.syncStates[account.id].mailBackfill = {
      status: 'partial', activeWindow: {
        from: '2026-09-20T00:00:00.000Z', through: '2026-09-21T00:00:00.000Z', pageSize: 5,
        queryFingerprint: 'stale-identity-or-window', cursor: 'saved-cursor',
      },
    };
    await store.save(persisted);
    const restored = new AppControllerImpl(store, {}, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    });
    await restored.load();
    const callsBeforeInvalidCursor = mailboxCalls;
    nextLane = 'backfill';
    const invalid = await restored.continueMailBackfill(account.id);
    expect(invalid.status).toBe('complete');
    expect(mailboxCalls).toBe(callsBeforeInvalidCursor + 1);
    expect(restored.getSnapshot().syncStates[account.id].mailBackfill.activeWindow).toBeUndefined();
    expect(restored.getSnapshot().syncStates[account.id].mailBackfill.olderHistoryNotCheckedBefore).toBe(lastRequestedRange!.from);

    const oldCoverage = structuredClone(store.value!);
    oldCoverage.syncStates[account.id].mailBackfill = {
      status: 'idle', coverage: { from: '2024-01-01T00:00:00.000Z', through: '2024-01-14T00:00:00.000Z' },
      coverageNeededThrough: '2024-03-01T00:00:00.000Z',
    };
    await store.save(oldCoverage);
    const longAbsence = new AppControllerImpl(store, {}, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    });
    await longAbsence.load();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2028-11-01T00:00:00.000Z'));
    nextLane = 'backfill';
    let recovered;
    try {
      recovered = await longAbsence.continueMailBackfill(account.id);
    } finally {
      vi.useRealTimers();
    }
    expect(recovered.status).toBe('complete');
    expect(Date.parse(lastRequestedRange!.through) - Date.parse(lastRequestedRange!.from)).toBeLessThanOrEqual(14 * 86_400_000);
    expect(recovered.state.mailBackfill.olderHistoryNotCheckedBefore).toBe(lastRequestedRange!.from);
  });

  it('limits foreground mailbox refresh to two accounts and excludes another active lane', async () => {
    const store = new MemoryStore();
    const tokens = new Map<string, StoredOAuthToken>();
    const tokenStore = {
      async get(ref: string) { return tokens.get(ref) ? structuredClone(tokens.get(ref)!) : null; },
      async set(ref: string, value: StoredOAuthToken) { tokens.set(ref, structuredClone(value)); },
    };
    let calls = 0;
    let entered: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async syncMessageWindow(account: Parameters<typeof describeMessageWindowQuery>[0], options: { timeMin: string; timeMax: string; pageSize?: number; onPage?: (items: unknown[], cursor: undefined, pages: number, metadata: { unavailableIds: string[]; window: { from: string; to: string }; queryFingerprint: string }) => unknown }) {
        calls++;
        const descriptor = describeMessageWindowQuery(account, options);
        await options.onPage?.([], undefined, 1, { unavailableIds: [], window: descriptor.window, queryFingerprint: descriptor.queryFingerprint });
        if (calls === 1) { entered?.(); await gate; }
        return { items: [], pagesRead: 1, partial: false, window: descriptor.window, queryFingerprint: descriptor.queryFingerprint, unavailableIds: [] };
      },
      async syncMessages() { throw new Error('Legacy mailbox API must not run.'); },
      async listCalendars() { return { items: [], pagesRead: 1, partial: false }; },
      async readCalendarEvents() { throw new Error('No calendar reads expected.'); },
    };
    const app = new AppControllerImpl(store, {}, {
      tokenStore,
      deleteToken: async () => undefined,
      clientIds: { google: 'google-client' }, verifyOAuthResult: async () => true,
      connectorFactory: () => connector as never,
    });
    await app.load();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: `subject-${index}` };
      const installed = await app.installVerifiedAccount({ provider: 'google', displayName: `Account ${index}`, email: `a${index}@example.com` }, {
        provider: 'google', accessToken: `access-${index}`, expiresAt: Date.now() + 600_000,
        grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'], requestedCapabilities: ['mail.read'], capabilities: ['mail.read'],
        identity, displayName: `Account ${index}`, email: `a${index}@example.com`,
      });
      ids.push(installed.id);
    }
    const first = app.refreshMailHead(ids[0]);
    await entry;
    await expect(app.continueMailBackfill(ids[0])).rejects.toThrow(/Another sync lane/);
    const foregroundWhileBusy = await app.refreshForegroundMail();
    expect(foregroundWhileBusy.attempted).toEqual(ids.slice(1));
    expect(foregroundWhileBusy.skipped).toContainEqual({ accountId: ids[0], reason: 'another sync lane is active for this account' });
    expect(foregroundWhileBusy.results).toHaveLength(2);
    const sameLane = app.refreshMailHead(ids[0]);
    finish?.();
    await Promise.all([first, sameLane]);
    expect(calls).toBe(3);
  });

  it('migrates legacy Microsoft mailbox cursors and marks dependent analysis stale once', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const account = await app.saveAccount({ provider: 'microsoft', displayName: 'Outlook', email: 'user@example.com' });
    const note = await app.saveNote({ transcript: 'Reply to the supplier.' });
    const legacy = structuredClone(app.getSnapshot()) as unknown as Omit<AppState, 'mailboxSchemaVersion'> & { mailboxSchemaVersion: number };
    (legacy.notes.find((item) => item.id === note.id) as unknown as { analysis: { stale: boolean; sourceVersions: Record<string, string> } }).analysis = {
      stale: false, sourceVersions: { 'mail:legacy-user:old-message': '0:abc' },
    };
    legacy.mailboxSchemaVersion = 1;
    legacy.mailbox = [{ id: 'old', accountId: account.id, providerMessageId: 'mutable-graph-id', identityKey: 'legacy-user:mutable-graph-id', subject: 'Legacy', receivedAt: '2026-10-10T00:00:00Z' }];
    legacy.syncStates[account.id] ??= {
      accountId: account.id, status: 'idle', mailHead: { status: 'idle' }, mailBackfill: { status: 'idle' },
      messagesPartial: false, calendarsPartial: false, eventCursors: {}, eventsCompletedAt: {},
    };
    legacy.syncStates[account.id].messagesCursor = 'old-cursor';
    legacy.syncStates[account.id].messagesPartial = true;
    store.value = legacy as AppState;
    const migrated = new AppControllerImpl(store);
    await migrated.load();
    expect(migrated.getSnapshot().mailbox).toEqual([]);
    expect(migrated.getSnapshot().syncStates[account.id]).toMatchObject({ messagesCursor: undefined, messagesPartial: false });
    expect(migrated.getSnapshot().notes[0].analysis?.stale).toBe(true);
    expect(migrated.getSnapshot().mailboxSchemaVersion).toBe(2);

    store.value!.mailbox = [{ id: 'new', accountId: account.id, providerMessageId: 'new-immutable-id', identityKey: 'verified-user:new-immutable-id' }];
    const afterMigration = new AppControllerImpl(store);
    await afterMigration.load();
    expect(afterMigration.getSnapshot().mailbox).toHaveLength(1);
  });

  it('discards a mailbox page that returns after its verified connection is disconnected', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'disconnect-race' };
    const token: StoredOAuthToken = { accessToken: 'race-access', expiresAt: Date.now() + 600_000, identity };
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async syncMessageWindow(account: Parameters<typeof describeMessageWindowQuery>[0], options: { timeMin: string; timeMax: string; pageSize?: number; onPage?: (items: unknown[], cursor: undefined, pages: number, metadata: { unavailableIds: string[]; window: { from: string; to: string }; queryFingerprint: string }) => unknown }) {
        entered?.(); await gate;
        const descriptor = describeMessageWindowQuery(account, options);
        await options.onPage?.([{ id: 'late-message', idFormat: 'gmail', subject: 'Late page', replyMetadataComplete: true }], undefined, 1, { unavailableIds: [], window: descriptor.window, queryFingerprint: descriptor.queryFingerprint });
        return { items: [], pagesRead: 1, partial: false, window: descriptor.window, queryFingerprint: descriptor.queryFingerprint, unavailableIds: [] };
      },
      async listCalendars() { throw new Error('No calendar sync expected.'); },
      async readCalendarEvents() { throw new Error('No calendar sync expected.'); },
    };
    const app = new AppControllerImpl(store, {}, {
      tokenStore: { async get() { return structuredClone(token); }, async set() {} },
      deleteToken: async () => undefined, clientIds: { google: 'google-client' }, verifyOAuthResult: async () => true,
      connectorFactory: () => connector as never,
    });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: 'Race', email: 'race@example.com' }, {
      provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'], requestedCapabilities: ['mail.read'], capabilities: ['mail.read'],
      identity, displayName: 'Race', email: 'race@example.com',
    });
    const pending = app.refreshMailHead(account.id);
    await enteredPromise;
    await app.disconnectAccount(account.id);
    release?.();
    await expect(pending).rejects.toThrow(/connection changed/i);
    expect(app.getSnapshot().mailbox).toEqual([]);
    expect(app.getSnapshot().syncStates[account.id].mailHead).toMatchObject({ status: 'error' });
  });

  it('stages OAuth credentials in the controller and durably replaces the prior token only after verification', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'staged-subject' };
    const tokens = new Map<string, StoredOAuthToken>();
    const deleted: string[] = [];
    let failDelete = true;
    let verificationGate: Promise<void> | undefined;
    let verificationEntered: (() => void) | undefined;
    const tokenStore = {
      async get(ref: string) { return tokens.get(ref) ? structuredClone(tokens.get(ref)!) : null; },
      async set(ref: string, token: StoredOAuthToken) { tokens.set(ref, structuredClone(token)); },
    };
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: 'first-access', refreshToken: 'long-lived-refresh', expiresAt: Date.now() + 600_000,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], identity, displayName: 'Staged User', email: 'staged@example.com',
    };
    const app = new AppControllerImpl(store, {}, {
      tokenStore, deleteToken: async (ref) => {
        if (failDelete) { failDelete = false; throw new Error('secure store unavailable'); }
        deleted.push(ref); tokens.delete(ref);
      },
      clientIds: { google: 'google-client' }, verifyOAuthResult: async () => {
        if (verificationGate) { verificationEntered?.(); await verificationGate; verificationGate = undefined; }
        return true;
      },
      connectorFactory: () => ({ async verifyOAuthIdentity() { return true; } }) as never,
    });
    await app.load();
    const first = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result);
    const oldRef = first.tokenRef!;
    expect(tokens.get(oldRef)?.refreshToken).toBe('long-lived-refresh');

    let refreshLockEntered!: () => void;
    let releaseRefreshLock!: () => void;
    const refreshLocked = new Promise<void>((resolve) => { refreshLockEntered = resolve; });
    const releaseLock = new Promise<void>((resolve) => { releaseRefreshLock = resolve; });
    const simulatedRefresh = withCredentialLock(tokenStore, oldRef, async () => {
      const old = tokens.get(oldRef)!;
      tokens.set(oldRef, { ...old, refreshToken: 'rotated-refresh' });
      refreshLockEntered();
      await releaseLock;
    });
    await refreshLocked;
    let verifyEntered!: () => void;
    let releaseVerification!: () => void;
    const verificationWaiting = new Promise<void>((resolve) => { verifyEntered = resolve; });
    verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const reauth = { ...result, accessToken: 'second-access', refreshToken: undefined, expiresAt: Date.now() + 900_000 };
    verificationEntered = verifyEntered;
    const installing = app.installVerifiedAccount({ id: first.id, provider: 'google', displayName: '', email: '' }, reauth);
    await verificationWaiting;
    releaseVerification();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseRefreshLock();
    await simulatedRefresh;
    const second = await installing;
    expect(second.tokenRef).not.toBe(oldRef);
    expect(tokens.get(second.tokenRef!)?.refreshToken).toBe('rotated-refresh');
    expect(deleted).toEqual([]);
    expect(tokens.has(oldRef)).toBe(true);
    expect(app.getSnapshot().pendingCredentialCleanup).toMatchObject([{ tokenRef: oldRef, reason: 'replaced', lastError: expect.any(String) }]);
    expect(app.getSnapshot().accounts[0]).toMatchObject({ connected: true, tokenRef: second.tokenRef });
    await app.retryCredentialCleanup();
    expect(deleted).toEqual([oldRef]);
    expect(tokens.has(oldRef)).toBe(false);
    expect(app.getSnapshot().pendingCredentialCleanup).toEqual([]);
  });

  it('rejects a stale OAuth install intent after workspace load before staging credentials', async () => {
    const store = new MemoryStore();
    const tokenSets = vi.fn();
    const verify = vi.fn(async () => true);
    const app = new AppControllerImpl(store, {}, {
      tokenStore: { async get() { return null; }, async set() { tokenSets(); } },
      clientIds: { google: 'google-client' }, verifyOAuthResult: verify,
      connectorFactory: () => ({ async verifyOAuthIdentity() { return true; } }) as never,
    });
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: 'intent-access', refreshToken: 'intent-refresh', expiresAt: Date.now() + 600_000,
      grantedScopes: ['openid'], requestedCapabilities: [], capabilities: [],
      identity: { providerNamespace: 'google', clientId: 'google-client', subject: 'intent-subject' }, displayName: 'Intent', email: 'intent@example.test',
    };
    let checks = 0;
    await expect(app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result, {
      assertCurrent() { checks += 1; if (checks === 2) throw new Error('OAuth install intent is stale.'); },
    })).rejects.toThrow(/intent is stale/i);
    expect(tokenSets).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(app.getSnapshot().accounts).toEqual([]);
    expect(app.getSnapshot().pendingCredentialCleanup).toEqual([]);
  });

  it('cleans a staged OAuth token when the install intent expires during the secure-store write', async () => {
    const store = new MemoryStore();
    const tokens = new Map<string, StoredOAuthToken>();
    const deleted: string[] = [];
    let setEntered!: () => void;
    let releaseSet!: () => void;
    const entered = new Promise<void>((resolve) => { setEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSet = resolve; });
    const verify = vi.fn(async () => true);
    const app = new AppControllerImpl(store, {}, {
      tokenStore: {
        async get(ref: string) { return tokens.get(ref) ? structuredClone(tokens.get(ref)!) : null; },
        async set(ref: string, token: StoredOAuthToken) { tokens.set(ref, structuredClone(token)); setEntered(); await gate; },
      },
      deleteToken: async (ref) => { deleted.push(ref); tokens.delete(ref); },
      clientIds: { google: 'google-client' }, verifyOAuthResult: verify,
      connectorFactory: () => ({ async verifyOAuthIdentity() { return true; } }) as never,
    });
    await app.load();
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: 'intent-access', refreshToken: 'intent-refresh', expiresAt: Date.now() + 600_000,
      grantedScopes: ['openid'], requestedCapabilities: [], capabilities: [],
      identity: { providerNamespace: 'google', clientId: 'google-client', subject: 'intent-subject' }, displayName: 'Intent', email: 'intent@example.test',
    };
    let current = true;
    const pending = app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result, { assertCurrent() { if (!current) throw new Error('OAuth install intent is stale.'); } });
    await entered;
    current = false;
    releaseSet();
    await expect(pending).rejects.toThrow(/intent is stale/i);
    expect(verify).not.toHaveBeenCalled();
    expect(deleted).toHaveLength(1);
    expect(tokens).toEqual(new Map());
    expect(app.getSnapshot().accounts).toEqual([]);
    expect(app.getSnapshot().pendingCredentialCleanup).toEqual([]);
  });

  it('does not classify its own successful add or reconnect as a stale install intent', async () => {
    const store = new MemoryStore();
    const tokens = new Map<string, StoredOAuthToken>();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'commit-subject' };
    const app = new AppControllerImpl(store, {}, {
      tokenStore: {
        async get(ref: string) { return tokens.get(ref) ? structuredClone(tokens.get(ref)!) : null; },
        async set(ref: string, token: StoredOAuthToken) { tokens.set(ref, structuredClone(token)); },
      },
      deleteToken: async (ref) => { tokens.delete(ref); },
      clientIds: { google: 'google-client' }, verifyOAuthResult: async () => true,
      connectorFactory: () => ({ async verifyOAuthIdentity() { return true; } }) as never,
    });
    await app.load();
    let expectedTokenRef: string | undefined;
    const assertCapturedAccount = () => {
      expect(app.getSnapshot().accounts.find((account) => account.identity?.subject === identity.subject)?.tokenRef).toBe(expectedTokenRef);
    };
    const makeResult = (accessToken: string): OAuthBridgeResult => ({
      provider: 'google', accessToken, refreshToken: `${accessToken}-refresh`, expiresAt: Date.now() + 600_000,
      grantedScopes: ['openid'], requestedCapabilities: [], capabilities: [], identity, displayName: 'Commit', email: 'commit@example.test',
    });
    const added = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, makeResult('first-access'), { assertCurrent: assertCapturedAccount });
    expect(added.connected).toBe(true);
    expect(tokens.has(added.tokenRef!)).toBe(true);
    expectedTokenRef = added.tokenRef;
    const reconnected = await app.installVerifiedAccount({ id: added.id, provider: 'google', displayName: '', email: '' }, makeResult('second-access'), { assertCurrent: assertCapturedAccount });
    expect(reconnected.connected).toBe(true);
    expect(reconnected.tokenRef).not.toBe(expectedTokenRef);
    expect(tokens.has(reconnected.tokenRef!)).toBe(true);
    expect(app.getSnapshot().pendingCredentialCleanup).toEqual([]);
  });

  it('includes mailbox facts only when their stored composite identity matches the verified account', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'mail-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const setup = new AppControllerImpl(store);
    await setup.load();
    const account = await setup.saveAccount({ provider: 'google', displayName: 'Mail', email: 'mail@example.com' });
    const note = await setup.saveNote({ transcript: 'Check the latest email.' });
    const persisted = store.value!;
    Object.assign(persisted.accounts[0], { connected: true, authStatus: 'connected', identity, tokenRef: 'mail-token', capabilities: ['mail.read'], capabilityLimits: ['mail.read'] });
    const accountIdentity = 'google:google-client:mail-subject:';
    persisted.mailbox = [
      { id: 'valid-row', accountId: account.id, providerMessageId: 'provider-message', identityKey: `${accountIdentity}:provider-message`, verifiedIdentityKey: accountIdentity, connectionGeneration: account.connectionGeneration ?? 0, subject: 'Shipment update', from: 'store@example.com', receivedAt: '2026-10-12T01:00:00Z', snippet: 'Your package is arriving today.', replyMetadataComplete: true },
      { id: 'wrong-row', accountId: account.id, providerMessageId: 'other-message', identityKey: 'different-account:other-message', subject: 'Private', snippet: 'Must not be included.' },
    ];
    const batch = createCompletedAssistantBatchClient();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client,
      tokenStore: { async get(ref) { return ref === 'mail-token' ? structuredClone(token) : null; }, async set() {} },
      connectorFactory: () => ({}) as never,
    });
    await app.load();
    expect(app.getSnapshot().accounts[0].connected).toBe(true);
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    await completeNoteBatch(app, note.id, { intent: 'answer', question: 'What does the shipment update email say?' });
    const submitted = batch.calls.find((call) => call.method === 'POST')?.requestBody ?? '';
    expect(submitted).toContain('Shipment update');
    expect(submitted).not.toContain('Must not be included');
    expect(batch.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('binds knowledge calendar references to both provider calendar and event IDs', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const account = await app.saveAccount({ provider: 'google', displayName: 'Calendar', email: 'calendar@example.test' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: '' });
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'calendar-subject' };
    const identityValue = 'google:google-client:calendar-subject:';
    const internal = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> };
    await internal.mutate((state) => {
      const storedAccount = state.accounts.find((item) => item.id === account.id)!;
      Object.assign(storedAccount, { connected: true, authStatus: 'connected', identity, connectionGeneration: 4, capabilities: ['calendar.read'] });
      state.calendars.push(
        { id: 'local-cal-a', accountId: account.id, name: 'First', writable: false, connected: true, providerId: 'provider-cal-a' },
        { id: 'local-cal-b', accountId: account.id, name: 'Second', writable: false, connected: true, providerId: 'provider-cal-b' },
      );
      state.calendarEvents.push(
        { id: 'event-row-a', accountId: account.id, calendarId: 'local-cal-a', providerEventId: 'same-event', subject: 'First calendar event', observedAt: new Date().toISOString(), verifiedIdentityKey: identityValue, connectionGeneration: 4 },
        { id: 'event-row-b', accountId: account.id, calendarId: 'local-cal-b', providerEventId: 'same-event', subject: 'Second calendar event', observedAt: new Date().toISOString(), verifiedIdentityKey: identityValue, connectionGeneration: 4 },
      );
    });
    const linked = await app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision,
      reference: { kind: 'calendar', id: 'same-event', calendarId: 'provider-cal-b', identityKey: identityValue, connectionGeneration: 4 }, label: 'Second calendar' });
    expect(linked.reference).toMatchObject({ kind: 'calendar', id: 'same-event', calendarId: 'provider-cal-b' });
    await expect(app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision + 1,
      reference: { kind: 'calendar', id: 'same-event', calendarId: 'provider-cal-mismatch', identityKey: identityValue, connectionGeneration: 4 }, label: 'Wrong calendar' }))
      .rejects.toThrow(/no longer available/i);
  });

  it('reuses a configured same-provider account entry when installing its verified identity', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'provider-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], identity,
      displayName: 'Verified User', email: 'user@example.com',
    };
    const app = new AppControllerImpl(store, {}, {
      tokenStore: { async get() { return structuredClone(token); }, async set() {} },
      deleteToken: async () => undefined,
      clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true,
      connectorFactory: () => ({ async verifyOAuthIdentity() { return true; } }) as never,
    });
    await app.load();
    const placeholder = await app.saveAccount({ provider: 'google', displayName: 'Personal Google', email: 'placeholder@example.com' });
    const installed = await app.installVerifiedAccount({ id: placeholder.id, provider: 'google', displayName: '', email: '' }, result);
    expect(installed.id).toBe(placeholder.id);
    expect(installed).toMatchObject({ connected: true, authStatus: 'connected', identity });
    expect(app.getSnapshot().accounts).toHaveLength(1);
  });

  it('continues a sync without repeating completed calendars when the per-run request cap is reached', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'provider-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get() { return structuredClone(token); }, async set() {} };
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/calendar.readonly'],
      requestedCapabilities: ['calendar.read'], capabilities: ['calendar.read'], identity, displayName: 'Calendar User', email: 'user@example.com',
    };
    const calendarItems = Array.from({ length: 21 }, (_, index) => ({ id: `calendar-${index}`, name: `Calendar ${index}`, writable: false }));
    let calendarLists = 0;
    let eventReads = 0;
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async syncMessages() { throw new Error('Mailbox read was not granted.'); },
      async listCalendars(_account: unknown, options: { guard?: () => void; onPage?: (items: typeof calendarItems, cursor?: string, pages?: number) => unknown }) {
        calendarLists++; options.guard?.(); await options.onPage?.(calendarItems, undefined, 1);
        return { items: calendarItems, pagesRead: 1, partial: false };
      },
      async readCalendarEvents(_account: unknown, _id: string, options: { guard?: () => void; onPage?: (items: never[], cursor?: string, pages?: number) => unknown }) {
        options.guard?.(); eventReads++; await options.onPage?.([], undefined, 1);
        return { items: [], pagesRead: 1, partial: false };
      },
    };
    const app = new AppControllerImpl(store, {}, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' }, verifyOAuthResult: async () => true,
      connectorFactory: () => connector as never,
    });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result);
    const partial = await app.syncAccount(account.id);
    expect(partial.status).toBe('partial');
    expect(eventReads).toBe(19);
    const completedCursors = app.getSnapshot().syncStates[account.id].eventsCompletedAt;
    expect(Object.keys(completedCursors)).toHaveLength(19);
    const complete = await app.syncAccount(account.id, { continue: true });
    expect(complete.status).toBe('idle');
    expect(calendarLists).toBe(1);
    expect(eventReads).toBe(21);
  });

  it('binds remote execution to the exact approved operation and records provider acceptance honestly', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'provider-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get() { return structuredClone(token); }, async set() {} };
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.send'],
      requestedCapabilities: ['mail.send'], capabilities: ['mail.send'], identity, displayName: 'Verified', email: 'user@example.com',
    };
    let verifiedEnvelope = false;
    let externalWrites = 0;
    let providerBody = '';
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async sendEmail(_account: unknown, envelope: unknown, verifier: { verify(value: never): Promise<boolean>; verifyBeforeDispatch(value: never): boolean }) {
        verifiedEnvelope = await verifier.verify(envelope as never);
        if (!verifier.verifyBeforeDispatch(envelope as never)) throw new Error('Approved action changed before provider dispatch.');
        externalWrites++;
        return { status: 'accepted' as const, id: 'provider-reference' };
      },
    };
    const transcript = 'Email Alex about the meeting.';
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
    let generatedMeetingReply = 0;
    const batch = createCompletedAssistantBatchClient(({ requestBody }) => {
      providerBody = requestBody;
      generatedMeetingReply += 1;
      const body = generatedMeetingReply === 1 ? 'Let us meet tomorrow.' : generatedMeetingReply === 2 ? 'Let us meet next week.' : 'Please send an updated agenda.';
      return {
      summary: 'Email Alex about the meeting.', answer: '', decisions: [],
      citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: transcript }], clarifications: [],
      proposals: [{ kind: 'email', title: 'Meeting', body, recipients: ['alex@example.com'], dueAt: null, evidence: [transcript] }], memorySuggestions: [],
      };
    });
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client,
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never, writeDocument: async () => undefined,
    });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result);
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const person = await app.savePerson({ name: 'Alex', aliases: [], narrative: 'Project contact.' });
    const note = await app.saveNote({ transcript });
    const { analysis } = await completeNoteBatch(app, note.id, { intent: 'assist', knowledgeSelection: [{ kind: 'person', id: person.id }] });
    const draft = app.getSnapshot().proposals.find((proposal) => proposal.id === analysis.proposalIds[0])!;
    expect(providerBody).toContain(`knowledge:person:${person.id}`);
    expect(draft.provenance?.version === 1 && draft.provenance.knowledgeSelection).toEqual([{ kind: 'person', id: person.id }]);
    await app.editProposal(draft.id, { accountId: account.id, email: {
      operation: 'send', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Meeting', text: 'Let us meet tomorrow.', attachments: [],
    } });
    const approved = await app.approveProposal(draft.id);
    const commandExecution = await app.executeProposalForCommand(draft.id, { expectedRevision: approved.revision });
    expect(commandExecution.kind).toBe('settled');
    if (commandExecution.kind !== 'settled') throw new Error('Expected a settled execution result.');
    const executed = commandExecution.proposal;
    expect(verifiedEnvelope).toBe(true);
    expect(externalWrites).toBe(1);
    expect(executed).toMatchObject({ status: 'accepted', remoteOperation: 'send', remoteId: 'provider-reference', simulated: false });
    expect(executed.status).toBe(app.getSnapshot().proposals.find((item) => item.id === draft.id)?.status);
    expect(commandExecution.dispatch).toMatchObject({ outcome: 'accepted' });
    expect(executed.dispatchRecordId).toBeTruthy();
    expect(app.getSnapshot().dispatchRecords[0]).toMatchObject({
      proposalId: draft.id, operation: 'send', outcome: 'accepted', remoteId: 'provider-reference',
      account: { displayName: 'Verified', email: 'user@example.com' },
      payload: { kind: 'email', email: { to: ['alex@example.com'], subject: 'Meeting', text: 'Let us meet tomorrow.' } },
      sourceProvenance: { version: 1, knowledgeSelection: [{ kind: 'person', id: person.id }] },
    });
    expect(executed.lastError).toBeUndefined();
    expect(app.getSnapshot().activity.some((item) => /Completion or delivery is not confirmed/.test(item.message))).toBe(true);

    // A reconnect must not erase the source-action duplicate guard. Rehydrate a
    // second candidate for the already accepted source action while its context is current.
    const accepted = app.getSnapshot().proposals.find((item) => item.status === 'accepted')!;
    const duplicate = structuredClone(accepted);
    duplicate.id = 'reconnected-duplicate-candidate';
    duplicate.status = 'draft';
    delete duplicate.approvedRevision;
    delete duplicate.approvedPayloadDigest;
    delete duplicate.dispatchRecordId;
    delete duplicate.remoteId;
    delete duplicate.remoteOperation;
    delete duplicate.remoteAcceptedAt;
    const persisted = structuredClone(store.value!);
    persisted.proposals.unshift(duplicate);
    const savedAccount = persisted.accounts.find((item) => item.id === account.id)!;
    savedAccount.connected = false;
    savedAccount.authStatus = 'configured';
    savedAccount.tokenRef = undefined;
    savedAccount.capabilities = [];
    savedAccount.connectionGeneration = (savedAccount.connectionGeneration ?? 0) + 1;
    store.value = persisted;
    const reconnected = new AppControllerImpl(store, {}, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    });
    await reconnected.load();
    await reconnected.installVerifiedAccount({ id: account.id, provider: 'google', displayName: '', email: '' }, result);
    const duplicateApproved = await reconnected.approveProposal(duplicate.id);
    expect(duplicateApproved.status).toBe('approved');
    const recordCountBeforeDuplicate = reconnected.getSnapshot().dispatchRecords.length;
    await expect(reconnected.executeProposal(duplicate.id)).rejects.toThrow(/already has a pending, accepted, or unknown/i);
    expect(reconnected.getSnapshot().dispatchRecords).toHaveLength(recordCountBeforeDuplicate);
    await reconnected.saveAccount({ id: account.id, provider: 'google', displayName: 'Renamed account', email: 'receipt@example.com' });
    expect(reconnected.getSnapshot().accounts.find((item) => item.id === account.id)?.displayName).toBe('Renamed account');
    expect(reconnected.getSnapshot().dispatchRecords[0].account.displayName).toBe('Verified');

    // Old terminal remote proposals without a frozen receipt remain readable,
    // but are explicitly marked as incomplete history after migration.
    const legacyStore = new MemoryStore();
    legacyStore.value = structuredClone(reconnected.getSnapshot());
    legacyStore.value.dispatchRecords = [];
    const legacyAccepted = legacyStore.value.proposals.find((item) => item.status === 'accepted')!;
    delete legacyAccepted.dispatchRecordId;
    const legacy = new AppControllerImpl(legacyStore, {});
    await legacy.load();
    expect(legacy.getSnapshot().proposals.find((item) => item.id === legacyAccepted.id)).toMatchObject({
      status: 'accepted', dispatchHistoryIncomplete: true,
    });
    expect(legacy.getSnapshot().dispatchRecords).toEqual([]);

  });

  it('keeps dispatch receipts independent of disconnect and turns an interrupted record unknown on reload', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'receipt-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get() { return structuredClone(token); }, async set() {} };
    const oauth: OAuthBridgeResult = {
      provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.send'], requestedCapabilities: ['mail.send'],
      capabilities: ['mail.send'], identity, displayName: 'Receipt Account', email: 'receipt@example.com',
    };
    let writeStarted!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async sendEmail(_account: unknown, envelope: unknown, verifier: { verify(value: never): Promise<boolean>; verifyBeforeDispatch(value: never): boolean }) {
        if (!await verifier.verify(envelope as never) || !verifier.verifyBeforeDispatch(envelope as never)) throw new Error('Final fence denied dispatch.');
        writeStarted();
        await writeGate;
        return { status: 'accepted' as const, id: 'late-provider-id' };
      },
    };
    const transcript = 'Send Jordan the final notes.';
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
    const batch = createCompletedAssistantBatchClient(() => ({
      summary: 'Send Jordan the final notes.', answer: '', decisions: [], citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: transcript }],
      clarifications: [], proposals: [{ kind: 'email', title: 'Final notes', body: 'Here are the final notes.', recipients: ['jordan@example.com'], dueAt: null, evidence: [transcript] }], memorySuggestions: [],
    }));
    const integration = { tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' }, verifyOAuthResult: async () => true, connectorFactory: () => connector as never };
    const app = new AppControllerImpl(store, {}, { ...integration, openRouterBatchClient: batch.client });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, oauth);
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript });
    await completeNoteBatch(app, note.id);
    const draft = app.getSnapshot().proposals.find((proposal) => proposal.id === app.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.proposalIds[0])!;
    await app.editProposal(draft.id, { accountId: account.id, email: { operation: 'send', to: ['jordan@example.com'], cc: [], bcc: [], subject: 'Final notes', text: 'Here are the final notes.', attachments: [] } });
    await app.approveProposal(draft.id);
    const executing = app.executeProposal(draft.id);
    await started;
    const pendingRecord = app.getSnapshot().dispatchRecords[0];
    expect(pendingRecord).toMatchObject({ outcome: 'pending', account: { displayName: 'Receipt Account' } });

    const crashStore = new MemoryStore();
    crashStore.value = structuredClone(store.value!);
    const restarted = new AppControllerImpl(crashStore, {}, {
      tokenStore: { async get() { return null; }, async set() {} }, deleteToken: async () => undefined,
    });
    await restarted.load();
    expect(restarted.getSnapshot().dispatchRecords[0]).toMatchObject({ id: pendingRecord.id, outcome: 'unknown' });
    expect(crashStore.value?.dispatchRecords[0]).toMatchObject({ id: pendingRecord.id, outcome: 'unknown' });
    expect(restarted.getSnapshot().proposals.find((item) => item.id === draft.id)).toMatchObject({ status: 'unknown', dispatchRecordId: pendingRecord.id });
    await restarted.reconcileDispatch(pendingRecord.id, { disposition: 'not_found', note: 'Checked the destination manually.' });
    expect(restarted.getSnapshot().dispatchRecords[0]).toMatchObject({ outcome: 'unknown', reconciliations: [{ disposition: 'not_found' }] });
    await restarted.disconnectAccount(account.id);
    await expect(restarted.executeProposal(draft.id)).rejects.toThrow(/approve this exact version/i);

    await app.disconnectAccount(account.id);
    releaseWrite();
    const late = await executing;
    expect(late).toMatchObject({ status: 'accepted', remoteId: 'late-provider-id' });
    expect(app.getSnapshot().accounts[0]).toMatchObject({ connected: false, tokenRef: undefined });
    expect(app.getSnapshot().dispatchRecords[0]).toMatchObject({ id: pendingRecord.id, outcome: 'accepted', remoteId: 'late-provider-id' });
  });

  it('marks volatile or missing credentials for reauthentication after reload and clears approvals before disconnect', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'provider-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get() { return structuredClone(token); }, async set() {} };
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], identity,
      displayName: 'Verified User', email: 'user@example.com',
    };
    const connector = { async verifyOAuthIdentity() { return true; } };
    let deleted = '';
    const integration = {
      tokenStore, deleteToken: async (ref: string) => { deleted = ref; }, clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    };
    const app = new AppControllerImpl(store, {}, integration);
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result);
    const note = await app.saveNote({ transcript: 'Email Alex the meeting notes.' });
    const [proposal] = await app.processNote(note.id);
    await app.editProposal(proposal.id, { accountId: account.id, email: {
      operation: 'draft', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Notes', text: 'Meeting notes.', attachments: [],
    } });
    await app.approveProposal(proposal.id);
    const reloaded = new AppControllerImpl(store, {}, { ...integration, tokenStore: { async get() { return null; }, async set() {} } });
    await reloaded.load();
    expect(reloaded.getSnapshot().accounts[0]).toMatchObject({ connected: false, authStatus: 'reauth_required', capabilities: [] });
    expect(reloaded.getSnapshot().proposals[0]).toMatchObject({ status: 'draft', approvedPayloadDigest: undefined });
    await reloaded.disconnectAccount(account.id);
    expect(deleted).toBe(account.tokenRef);
    const stillStored = store.value!.accounts[0];
    expect(stillStored).toMatchObject({ connected: false, authStatus: 'configured', tokenRef: undefined });
  });

  it('waits for hydration before accepting a save, without losing it to a late load', async () => {
    const store = new MemoryStore();
    let releaseLoad!: () => void;
    const originalLoad = store.load.bind(store);
    store.load = async () => {
      await new Promise<void>((resolve) => { releaseLoad = resolve; });
      return originalLoad();
    };
    const app = new AppControllerImpl(store);
    const loading = app.load();
    const saving = app.saveNote({ transcript: 'This save races with hydration.' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseLoad();
    await loading;
    const note = await saving;
    expect(app.getSnapshot().notes.map((item) => item.id)).toEqual([note.id]);
    expect(store.value?.notes.map((item) => item.id)).toEqual([note.id]);
  });

  it('rolls back a failed transaction without contaminating the next save', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    store.failNext = true;
    await expect(app.saveNote({ transcript: 'This write must fail.' })).rejects.toThrow('disk full');
    expect(app.getSnapshot().notes).toHaveLength(0);
    await app.refreshPersistedWorkspace();
    const saved = await app.saveNote({ transcript: 'This write succeeds.' });
    expect(store.value?.notes.map((note) => note.id)).toEqual([saved.id]);
  });

  it('serializes concurrent execution and remote email remains clearly simulated', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'Email Alex about the meeting.' });
    const [draft] = await app.processNote(note.id);
    const account = await app.saveAccount({ provider: 'google', displayName: 'Work', email: 'me@example.com' });
    expect(account.connected).toBe(false);
    await app.editProposal(draft.id, { accountId: account.id, recipients: ['alex@example.com'], email: { operation: 'draft', to: ['alex@example.com'], cc: [], bcc: [], subject: draft.title, text: draft.body, attachments: [] } });
    const approved = await app.approveProposal(draft.id);
    const commandResult = await app.executeProposalForCommand(draft.id, { expectedRevision: approved.revision });
    expect(commandResult.kind).toBe('settled');
    if (commandResult.kind !== 'settled') throw new Error('Expected a settled execution result.');
    expect(commandResult.proposal).toMatchObject({ status: 'simulated', simulated: true });
    expect(commandResult.proposal.status).toBe(app.getSnapshot().proposals.find((item) => item.id === draft.id)?.status);
    expect(app.getSnapshot().activity.some((item) => /not sent/.test(item.message))).toBe(true);
  });

  it('returns stable immutable snapshots and cloned records', async () => {
    const app = new AppControllerImpl(new MemoryStore());
    await app.load();
    const firstSnapshot = app.getSnapshot();
    const note = await app.saveNote({ transcript: 'A local note.' });
    note.transcript = 'mutated by caller';
    expect(app.getSnapshot()).not.toBe(firstSnapshot);
    expect(app.getSnapshot().notes[0].transcript).toBe('A local note.');
    expect(Object.isFrozen(app.getSnapshot().notes[0])).toBe(true);
  });

  it('preserves decimal prices and rolls daily and monthly budgets in the configured timezone', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    await first.saveSettings({ monthlyBudgetUsd: 0.1, speechUsdPerMinute: 0.02, inputUsdPerMillionTokens: 0.15 });
    expect(first.getSnapshot().settings.monthlyBudgetUsd).toBe(0.1);
    expect(first.getSnapshot().settings.speechUsdPerMinute).toBe(0.02);
    store.value!.usage.month = '1999-01';
    store.value!.usage.day = '1999-01-01';
    store.value!.usage.attemptsToday = 19;
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    await reloaded.saveSettings({ timezone: 'Asia/Singapore' });
    const expectedDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
    expect(reloaded.getSnapshot().usage.day).toBe(expectedDay);
    expect(reloaded.getSnapshot().usage.month).toBe(expectedDay.slice(0, 7));
    expect(reloaded.getSnapshot().usage.attemptsToday).toBe(0);
    expect(reloaded.getSnapshot().usage.estimatedCostUsd).toBe(0);
  });

  it('serializes concurrent memory appends so neither accepted item is lost', async () => {
    const app = new AppControllerImpl(new MemoryStore());
    await app.load();
    const a = await app.saveNote({ transcript: 'Remember that Sam prefers calls.' });
    const b = await app.saveNote({ transcript: 'Remember that Lee prefers email.' });
    const [pa] = await app.processNote(a.id);
    const [pb] = await app.processNote(b.id);
    const approvedA = await app.approveProposal(pa.id);
    await app.approveProposal(pb.id);
    const resultA = await app.executeProposalForCommand(pa.id, { expectedRevision: approvedA.revision });
    expect(resultA.kind).toBe('settled');
    if (resultA.kind !== 'settled') throw new Error('Expected a settled execution result.');
    expect(resultA.localOutcome).toBe('executed');
    expect(resultA.proposal.status).toBe(app.getSnapshot().proposals.find((item) => item.id === pa.id)?.status);
    await app.executeProposal(pb.id);
    const profile = app.getSnapshot().documents.find((doc) => doc.path === 'memory/PROFILE.md')?.content ?? '';
    expect(profile).toContain('Sam prefers calls');
    expect(profile).toContain('Lee prefers email');
  });

  it('creates one independent local task, supports completion and reopening, and migrates legacy executed tasks', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'I need to finish the report.' });
    const [proposal] = await app.processNote(note.id);
    expect(proposal.kind).toBe('task');
    await app.approveProposal(proposal.id);
    await app.executeProposal(proposal.id);
    expect(app.getSnapshot().tasks).toHaveLength(1);
    expect(app.getSnapshot().tasks[0]).toMatchObject({ id: proposal.id, status: 'open', sourceNoteId: note.id });
    await app.completeTask(proposal.id);
    expect(app.getSnapshot().tasks[0].status).toBe('completed');
    await app.reopenTask(proposal.id);
    expect(app.getSnapshot().tasks[0].status).toBe('open');
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().tasks).toHaveLength(1);

    const legacy = new MemoryStore();
    legacy.value = structuredClone(store.value!);
    legacy.value!.tasks = [];
    legacy.value!.proposals[0].status = 'executed';
    const migrated = new AppControllerImpl(legacy);
    await migrated.load();
    expect(migrated.getSnapshot().tasks).toHaveLength(1);
    expect(migrated.getSnapshot().tasks[0]).toMatchObject({ id: proposal.id, status: 'open' });
  });

  it('submits answer requests through explicit Batch and preserves captured source timing', async () => {
    vi.useFakeTimers();
    try {
      const requestTime = '2026-10-12T23:14:00.000Z';
      vi.setSystemTime(new Date(requestTime));
      const transcript = 'The review call is tomorrow at ten.';
      const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
      const batch = createCompletedAssistantBatchClient(() => ({
        summary: 'A review call is planned.', answer: 'Tomorrow at ten in the recording timezone.', decisions: [],
        citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: 'tomorrow at ten' }],
        clarifications: [], proposals: [], memorySuggestions: [],
      }));
      const store = new MemoryStore();
      const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
      await app.load();
      await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
      const note = await app.saveNote({ transcript, capturedAt: '2026-10-12T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
      const { analysis } = await completeNoteBatch(app, note.id, { intent: 'answer', question: 'When is the review call?' });
      expect(analysis).toMatchObject({ intent: 'answer', question: 'When is the review call?', capturedAt: '2026-10-12T01:00:00.000Z', captureTimeZone: 'Asia/Singapore', answeredAsOf: requestTime, source: 'provider' });
      expect(batch.calls[0].requestBody).toContain(`anchored separately to ${requestTime}`);

      const reloaded = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
      await reloaded.load();
      vi.setSystemTime(new Date('2026-10-12T23:15:00.000Z'));
      const second = await completeNoteBatch(reloaded, note.id, { intent: 'answer', question: 'When is the review call?' });
      expect(second.analysis.answeredAsOf).toBe('2026-10-12T23:15:00.000Z');
      expect(batch.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('preserves saved assistance on load and misses cache after the assist contract version changes', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    const note = await first.saveNote({ transcript: 'I decided to call Sam.' });
    const original = await first.assistNote(note.id, { intent: 'summarize' });
    const oldFingerprint = JSON.parse(original.fingerprint) as Record<string, unknown>;
    oldFingerprint.contractVersion = 'older-contract';
    store.value!.notes.find((item) => item.id === note.id)!.analysis!.fingerprint = JSON.stringify(oldFingerprint);

    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.fingerprint).toBe(JSON.stringify(oldFingerprint));
    const checked = await reloaded.refreshAnalysisStatus(note.id);
    expect(checked?.stale).toBe(true);

    const refreshed = await reloaded.assistNote(note.id, { intent: 'summarize' });
    expect(refreshed.fingerprint).not.toBe(JSON.stringify(oldFingerprint));
    expect((JSON.parse(refreshed.fingerprint) as { contractVersion: string }).contractVersion).toBe('assist-v3');
  });

  it('keeps retired immediate text billing inert while Batch reports actual provider accounting', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch', inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 });
    const note = await app.saveNote({ transcript: 'I need to call Sam tomorrow.' });
    await expect(app.assistNote(note.id, { forceRefresh: true })).rejects.toThrow(/explicit Batch workflow/i);
    expect(app.getSnapshot().usage).toMatchObject({ attempts: 0, attemptsToday: 0, requests: 0, reservedUsd: 0, unknownCharges: 0 });

    const batch = createCompletedAssistantBatchClient();
    const explicit = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
    await explicit.load();
    const { job } = await completeNoteBatch(explicit, note.id);
    expect(batch.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(job).toMatchObject({ status: 'completed', providerReportedCostUsd: 0.001, promptTokens: 20, completionTokens: 8 });
  });
  it('rejects overlapping immediate paid text requests before usage reservations', async () => {
    const app = new AppControllerImpl(new MemoryStore());
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const first = await app.saveNote({ transcript: 'October request transcript.' });
    const second = await app.saveNote({ transcript: 'November request transcript.' });
    const results = await Promise.allSettled([app.assistNote(first.id), app.assistNote(second.id)]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(app.getSnapshot().usage).toMatchObject({ attempts: 0, requests: 0, unknownCharges: 0, reservedUsd: 0 });
  });
  it('does not treat identical immediate provider calls as a paid cache path', async () => {
    const app = new AppControllerImpl(new MemoryStore());
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const first = await app.saveNote({ transcript: 'Two identical notes should use explicit Batch.' });
    const second = await app.saveNote({ transcript: 'Two identical notes should use explicit Batch.' });
    const results = await Promise.allSettled([app.assistNote(first.id), app.assistNote(second.id)]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(app.getSnapshot().usage).toMatchObject({ attempts: 0, requests: 0, unknownCharges: 0, reservedUsd: 0 });
  });
  it('rejects immediate paid mail replies before reading mail or reserving usage', async () => {
    let reads = 0;
    const app = new AppControllerImpl(new MemoryStore(), {}, { connectorFactory: () => ({ async readSelectedMessageText() { reads += 1; throw new Error('must not read'); } }) as never });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const result = app.generateMailReplyText({ messageId: 'selected-message', sourceDigest: 'source', textDigest: 'text', mode: 'reply', to: [], cc: [], brief: '', composerRevision: 1 });
    await expect(result).rejects.toThrow(/explicit Batch workflow/i);
    expect(reads).toBe(0);
    expect(app.getSnapshot().usage).toMatchObject({ attempts: 0, requests: 0, unknownCharges: 0, reservedUsd: 0 });
  });
  it('rechecks current context for each explicit Batch analysis after profile edits', async () => {
    const transcript = 'I need to call Sam tomorrow.';
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
    const batch = createCompletedAssistantBatchClient(() => ({
      summary: 'Call Sam tomorrow.', answer: '', decisions: [],
      citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: transcript }], clarifications: [],
      proposals: [{ kind: 'task', title: 'Call Sam', body: 'Call Sam tomorrow', recipients: [], dueAt: null, evidence: [transcript] }], memorySuggestions: [],
    }));
    const store = new MemoryStore();
    const first = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
    await first.load();
    await first.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await first.saveNote({ transcript });
    const initial = await completeNoteBatch(first, note.id);
    expect(initial.analysis.proposalIds.length).toBeGreaterThan(0);

    const persisted = store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
    const matchingV2Job = persisted.openRouterBatchLedger.jobs.find((job) => job.noteId === note.id)!;
    const legacyDuplicateId = '00000000-0000-4000-8000-000000000001';
    const matchingLegacyJob = structuredClone(matchingV2Job);
    matchingLegacyJob.id = legacyDuplicateId;
    matchingLegacyJob.customId = legacyDuplicateId;
    delete matchingLegacyJob.inputPolicyVersion;
    persisted.openRouterBatchLedger.jobs.unshift(matchingLegacyJob);

    const reloaded = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
    await reloaded.load();
    expect(reloaded.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.fingerprint).toBe(initial.analysis.fingerprint);
    expect(reloaded.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.inputPolicyVersion).toBe(2);
    const observedPolicies: unknown[] = [];
    const testController = reloaded as unknown as { createOpenRouterBatchRequestBuilder: () => { prepareAnalysis: (...args: unknown[]) => Promise<{ sourceVersions: Record<string, string> }> } };
    const originalBuilderFactory = testController.createOpenRouterBatchRequestBuilder.bind(reloaded);
    testController.createOpenRouterBatchRequestBuilder = () => ({
      prepareAnalysis: async (...args) => {
        observedPolicies.push(args[5]);
        return { sourceVersions: initial.analysis.sourceVersions };
      },
    });
    expect((await reloaded.refreshAnalysisStatus(note.id))?.stale).toBeUndefined();
    expect(observedPolicies).toEqual([2]);
    testController.createOpenRouterBatchRequestBuilder = originalBuilderFactory;
    await (reloaded as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
      draft.notes.find((item) => item.id === note.id)!.analysis!.inputPolicyVersion = 1;
    });
    expect((await reloaded.refreshAnalysisStatus(note.id))?.stale).toBe(true);
    await (reloaded as unknown as { mutate(operation: (draft: AppState) => void): Promise<void> }).mutate((draft) => {
      draft.notes.find((item) => item.id === note.id)!.analysis!.inputPolicyVersion = 2;
    });
    expect((await reloaded.refreshAnalysisStatus(note.id))?.stale).toBe(false);
    await saveDocumentCurrent(reloaded, 'memory/PROFILE.md', '# Profile\n\nSam prefers email.\n');
    expect((await reloaded.refreshAnalysisStatus(note.id))?.stale).toBe(true);
    await completeNoteBatch(reloaded, note.id);
    expect(batch.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
  it('approves a policy-2 proposal with >256 KiB rules despite an earlier matching legacy job', async () => {
    const quote = 'I need to call Sam tomorrow.';
    const transcript = quote;
    const rules = `# Rules\n\n${'A saved rule for this workspace. '.repeat(10_000)}`;
    expect(new TextEncoder().encode(rules).length).toBeGreaterThan(256 * 1024);
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
    const batch = createCompletedAssistantBatchClient(() => ({
      summary: 'Call Sam tomorrow.', answer: '', decisions: [],
      citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote }], clarifications: [],
      proposals: [{ kind: 'task', title: 'Call Sam', body: 'Call Sam tomorrow', recipients: [], dueAt: null, evidence: [quote] }], memorySuggestions: [],
    }));
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    await saveDocumentCurrent(app, 'memory/RULES.md', rules);
    const note = await app.saveNote({ transcript });
    const queued = await app.submitNoteBatch(note.id);
    const completion = await app.refreshAssistantBatch(queued.id);
    expect(completion, JSON.stringify(completion)).toMatchObject({ status: 'completed' });
    const completed = { analysis: app.getSnapshot().notes.find((item) => item.id === note.id)!.analysis!, job: completion };
    expect(completed.analysis.inputPolicyVersion).toBe(2);
    const proposalId = completed.analysis.proposalIds[0]!;
    const proposal = app.getSnapshot().proposals.find((item) => item.id === proposalId)!;
    expect(proposal.provenance?.version).toBe(1);
    expect(JSON.parse((proposal.provenance as Extract<NonNullable<Proposal['provenance']>, { version: 1 }>).analysisFingerprint)).toMatchObject({ inputPolicyVersion: 2 });

    const persisted = store.value as AppState & { openRouterBatchLedger: { jobs: Record<string, unknown>[] } };
    const matchingV2Job = persisted.openRouterBatchLedger.jobs.find((job) => job.noteId === note.id)!;
    const legacyDuplicateId = '00000000-0000-4000-8000-000000000002';
    const matchingLegacyJob = structuredClone(matchingV2Job);
    matchingLegacyJob.id = legacyDuplicateId;
    matchingLegacyJob.customId = legacyDuplicateId;
    delete matchingLegacyJob.inputPolicyVersion;
    persisted.openRouterBatchLedger.jobs.unshift(matchingLegacyJob);
    const reloaded = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
    await reloaded.load();
    await expect(reloaded.approveProposal(proposalId)).resolves.toMatchObject({ status: 'approved' });
  });
  it('persists an empty Batch result across reloads without hidden resubmission', async () => {
    const batch = createCompletedAssistantBatchClient(() => ({ summary: 'No actions.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] }));
    const store = new MemoryStore();
    const first = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
    await first.load();
    await first.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await first.saveNote({ transcript: 'A thought with no action.' });
    const initial = await completeNoteBatch(first, note.id);
    expect(initial.analysis.proposalIds).toEqual([]);
    const reloaded = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
    await reloaded.load();
    expect(reloaded.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.fingerprint).toBe(initial.analysis.fingerprint);
    expect(batch.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('does not resurrect an edited and executed task when context changes for the same transcript sentence', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'I need to buy groceries tomorrow. I need to call Sam tomorrow. I prefer short replies.' });
    const first = await app.processNote(note.id);
    const groceries = first.find((proposal) => proposal.kind === 'task' && /groceries/i.test(proposal.title));
    expect(groceries).toBeDefined();
    await app.editProposal(groceries!.id, { title: 'Buy groceries after work' });
    await app.approveProposal(groceries!.id);
    await app.executeProposal(groceries!.id);

    await saveDocumentCurrent(app, 'memory/PROFILE.md', '# Profile\n\nI prefer detailed planning.\n');
    const refreshed = await app.processNote(note.id);
    expect(refreshed.some((proposal) => proposal.id === groceries!.id)).toBe(false);
    expect(app.getSnapshot().proposals.filter((proposal) => proposal.kind === 'task' && proposal.sourceRevision === note.revision && /groceries/i.test(proposal.title)).map(({ id, title, status, sourceActionKey }) => ({ id, title, status, sourceActionKey }))).toHaveLength(1);
    expect(app.getSnapshot().tasks.filter((task) => task.sourceNoteId === note.id && /groceries/i.test(task.title))).toHaveLength(1);
    expect(refreshed.some((proposal) => proposal.kind === 'task' && /call Sam/i.test(proposal.title))).toBe(true);
    expect(app.getSnapshot().proposals.filter((proposal) => proposal.kind === 'memory' && /short replies/i.test(proposal.body))).toHaveLength(1);
  });

  it('stores an explicit Batch result as stale when its selected source context changes in flight', async () => {
    let release!: () => void;
    let requestStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const text = 'I need to call Alex tomorrow.';
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text.normalize('NFC'))}`;
    const batch = createCompletedAssistantBatchClient(async () => {
      requestStarted();
      await held;
      return {
        summary: 'Call Alex.', answer: '', decisions: [],
        citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: text }], clarifications: [],
        proposals: [{ kind: 'task', title: 'Call Alex', body: 'Call Alex tomorrow.', recipients: [], dueAt: null, evidence: [text] }], memorySuggestions: [],
      };
    });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript: text });
    const queued = await app.submitNoteBatch(note.id);
    const refresh = app.refreshAssistantBatch(queued.id);
    await started;
    await expect(saveDocumentCurrent(app, 'memory/PROFILE.md', '# Profile\n\nChanged while the result was being checked.\n'))
      .rejects.toThrow(/Batch request is still using saved context/i);
    release();
    const result = await refresh;
    expect(result.status).toBe('completed');
    expect(app.getSnapshot().proposals).toHaveLength(1);
    expect(batch.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it('marks a saved answer stale after a task used in its snapshot is completed', async () => {
    const app = new AppControllerImpl(new MemoryStore());
    await app.load();
    const taskNote = await app.saveNote({ transcript: 'I need to buy groceries.' });
    const [taskProposal] = await app.processNote(taskNote.id);
    await app.approveProposal(taskProposal.id);
    await app.executeProposal(taskProposal.id);
    const questionNote = await app.saveNote({ transcript: 'How many open tasks are there?' });
    const analysis = await app.assistNote(questionNote.id, { intent: 'answer', question: 'How many open tasks are there?' });
    expect(Object.keys(analysis.sourceVersions).some((id) => id.startsWith('task:'))).toBe(true);
    const task = app.getSnapshot().tasks.find((item) => item.id === taskProposal.id)!;
    await app.completeTask(task.id);
    const refreshed = await app.refreshAnalysisStatus(questionNote.id);
    expect(refreshed?.stale).toBe(true);
  });

  it('does not persist an unchanged freshness check and cannot apply it over a newer analysis', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'I decided to call Alex tomorrow.' });
    const original = await app.assistNote(note.id);
    const savesBeforeCheck = store.saves;
    const unchanged = await app.refreshAnalysisStatus(note.id);
    expect(unchanged?.stale).toBeFalsy();
    expect(store.saves).toBe(savesBeforeCheck);

    const statusCheck = app.refreshAnalysisStatus(note.id);
    const latest = await app.assistNote(note.id, { intent: 'summarize', forceRefresh: true });
    await statusCheck;
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.fingerprint).toBe(latest.fingerprint);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.analysis?.fingerprint).not.toBe(original.fingerprint);
  });

  it('migrates account configuration without trusting UI connection flags and validates structured remote payloads', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'Email Alex the agenda.' });
    const [draft] = await app.processNote(note.id);
    const account = await app.saveAccount({ provider: 'google', displayName: 'Work', email: 'me@example.com', connected: true });
    expect(account).toMatchObject({ connected: false, authStatus: 'configured', capabilities: [] });
    await app.editProposal(draft.id, { accountId: account.id, recipients: ['alex@example.com'], email: {
      operation: 'draft', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Agenda', text: 'Here is the agenda.', attachments: [],
    } });
    await app.approveProposal(draft.id);
    const edited = await app.editProposal(draft.id, { email: {
      operation: 'draft', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Agenda\r\nBcc: attacker@example.com', text: 'Here is the agenda.', attachments: [],
    } });
    await expect(app.approveProposal(edited.id)).rejects.toThrow(/line breaks/i);
    await app.editProposal(edited.id, { email: {
      operation: 'draft', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Agenda', text: 'Here is the agenda.', attachments: [],
    } });
    await app.approveProposal(edited.id);
    store.value!.proposals.find((proposal) => proposal.id === edited.id)!.email!.subject = 'Tampered agenda';
    Object.assign(store.value!.accounts[0], {
      connected: true, authStatus: 'connected', tokenRef: 'legacy-token-reference',
      identity: { subject: 'legacy-subject', issuer: 'unverified-issuer' },
    });
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().accounts[0]).toMatchObject({ connected: false, authStatus: 'reauth_required' });
    await expect(reloaded.executeProposal(edited.id)).rejects.toThrow(/approve this exact version/i);
  });

  it('rejects malformed structured event times and zones before approval', async () => {
    const app = new AppControllerImpl(new MemoryStore());
    await app.load();
    const note = await app.saveNote({ transcript: 'Schedule a team meeting.' });
    const [draft] = await app.processNote(note.id);
    const account = await app.saveAccount({ provider: 'google', displayName: 'Work', email: 'me@example.com' });
    const calendar = await app.saveCalendar({ accountId: account.id, name: 'Primary' });
    const edited = await app.editProposal(draft.id, { accountId: account.id, calendarId: calendar.id, event: {
      start: '2026-10-15T10:00:00+08:00', end: '2026-10-15T09:00:00+08:00', timeZone: 'Not/AZone', attendees: ['alex@example.com'], invitePolicy: 'send',
    } });
    await expect(app.approveProposal(edited.id)).rejects.toThrow(/end must be later/i);
    await app.editProposal(edited.id, { event: {
      start: '2026-10-15T09:00:00+08:00', end: '2026-10-15T10:00:00+08:00', timeZone: 'Not/AZone', attendees: ['alex@example.com'], invitePolicy: 'none',
    } });
    await expect(app.approveProposal(edited.id)).rejects.toThrow(/valid event time zone/i);
    await app.editProposal(edited.id, { event: {
      start: '2026-10-15T09:00:00+08:00', end: '2026-10-15T10:00:00+08:00', timeZone: 'Asia/Singapore', attendees: ['alex@example.com'], invitePolicy: 'none',
    } });
    const approved = await app.approveProposal(edited.id);
    expect(approved.event).toMatchObject({ title: approved.title, description: approved.body });
  });

  it('uses a deterministic revision-bound reminder identifier and finds an existing scheduled alert', async () => {
    const scheduled = new Map<string, { identifier: string }>();
    let scheduleCalls = 0;
    const bridge = {
      SchedulableTriggerInputTypes: { DATE: 'date' },
      requestPermissionsAsync: async () => ({ status: 'granted' }),
      getAllScheduledNotificationsAsync: async () => [...scheduled.values()],
      cancelScheduledNotificationAsync: async (identifier: string) => { scheduled.delete(identifier); },
      scheduleNotificationAsync: async ({ identifier }: { identifier: string }) => {
        scheduleCalls += 1;
        scheduled.set(identifier, { identifier });
        return identifier;
      },
    };
    const proposal: Proposal = {
      id: 'p-1', noteId: 'n-1', revision: 3, sourceRevision: 1, approvedRevision: undefined,
      dueAt: new Date(Date.now() + 60_000).toISOString(), title: 'Call Sam', body: 'Call Sam',
      kind: 'reminder', status: 'approved', recipients: [], evidence: [],
    };
    const first = await requestReminderNotification(proposal, 'ios', async () => bridge);
    const second = await requestReminderNotification(proposal, 'ios', async () => bridge);
    expect(reminderNotificationId(proposal)).toBe('reminder-p-1-3');
    expect(first).toEqual({ status: 'scheduled', notificationId: 'reminder-p-1-3' });
    expect(second).toEqual(first);
    expect(scheduleCalls).toBe(1);
    await cancelReminderNotification(proposal, 'ios', async () => bridge);
    expect(scheduled.has(reminderNotificationId(proposal))).toBe(false);
  });
});
