import { describe, expect, it, vi } from 'vitest';
import type { AppState, Proposal } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { AzureOpenAIClient } from '../src/services/azure';
import { cancelReminderNotification, reminderNotificationId, requestReminderNotification } from '../src/services/notifications';
import { ProviderWriteRejectedError, withCredentialLock, type OAuthBridgeResult, type StoredOAuthToken } from '../src/connectors';
import * as Crypto from 'expo-crypto';

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

describe('application state controller', () => {
  it('invalidates approval after an edit and keeps source revisions tied to the original note', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'I need to finish the report tomorrow.' });
    const [draft] = await app.processNote(note.id);
    const approved = await app.approveProposal(draft.id);
    expect(approved.status).toBe('approved');
    await app.editProposal(draft.id, { title: 'Send the revised report' });
    expect(app.getSnapshot().proposals[0].status).toBe('draft');
    await expect(app.executeProposal(draft.id)).rejects.toThrow(/Approve this exact version/);
    await app.updateTranscript(note.id, 'I need to finish the revised report today.');
    await expect(app.approveProposal(draft.id)).rejects.toThrow(/source transcript changed/i);
    const [fresh] = await app.processNote(note.id);
    expect(fresh.sourceRevision).toBe(app.getSnapshot().notes[0].revision);
  });

  it('rechecks a proposal’s own provenance before review and persists invalidation only when it changes', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const note = await app.saveNote({ transcript: 'I need to buy groceries tomorrow.' });
    const [proposal] = await app.processNote(note.id);
    await app.approveProposal(proposal.id);
    await app.saveDocument('memory/RULES.md', 'Never create reminders without a time.');
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
    const recovered = new AppControllerImpl(store);
    await recovered.load();
    expect(recovered.getSnapshot().dispatchRecords).toEqual([]);
    expect(recovered.getSnapshot().dispatchRecordQuarantine).toMatchObject([{ reason: 'invalid_persisted_receipt', raw: { id: 'invalid-receipt' } }]);
    const exported = await recovered.exportData();
    expect(exported).not.toContain('dispatchRecordQuarantine');
    expect(exported).not.toContain('private-corrupt-data');
  });

  it('installs only verifier-approved OAuth identity and resumes sync from persisted page cursors', async () => {
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
    let page = 0;
    let resumedCursor: string | undefined;
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async syncMessages(_account: unknown, options: { cursor?: string; onPage?: (items: unknown[], cursor?: string, pages?: number) => unknown }) {
        resumedCursor = options.cursor;
        page++;
        const cursor = page === 1 ? 'saved-cursor' : undefined;
        await options.onPage?.([{ id: 'provider-message', subject: 'Meeting', receivedAt: '2026-10-12T01:00:00Z' }], cursor, 1);
        return { items: [], nextCursor: cursor, pagesRead: 1, partial: Boolean(cursor) };
      },
      async listCalendars() { return { items: [], pagesRead: 1, partial: false }; },
      async readCalendarEvents() { throw new Error('No calendars should be requested.'); },
    };
    const app = new AppControllerImpl(store, {}, {
      tokenStore,
      deleteToken: async () => undefined,
      clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true,
      connectorFactory: () => connector as never,
    });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: 'Ignored label', email: 'other@example.com' }, result);
    expect(account).toMatchObject({ connected: true, authStatus: 'connected', email: 'user@example.com', capabilities: ['mail.read'] });
    const partial = await app.syncAccount(account.id);
    expect(partial).toMatchObject({ status: 'partial', messagesCursor: 'saved-cursor', messagesPartial: true });
    expect(app.getSnapshot().mailbox).toHaveLength(1);
    await expect(app.syncAccount(account.id)).rejects.toThrow(/Choose Continue/);
    const complete = await app.syncAccount(account.id, { continue: true });
    expect(resumedCursor).toBe('saved-cursor');
    expect(complete).toMatchObject({ status: 'idle', messagesPartial: false });
    expect(app.getSnapshot().mailbox).toHaveLength(1);
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
      { id: 'valid-row', accountId: account.id, providerMessageId: 'provider-message', identityKey: `${accountIdentity}:provider-message`, subject: 'Shipment update', from: 'store@example.com', receivedAt: '2026-10-12T01:00:00Z', snippet: 'Your package is arriving today.' },
      { id: 'wrong-row', accountId: account.id, providerMessageId: 'other-message', identityKey: 'different-account:other-message', subject: 'Private', snippet: 'Must not be included.' },
    ];
    const fetcher = async () => new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      summary: 'The shipment update says the package is arriving today.', answer: 'It is arriving today.', decisions: [], citations: [], clarifications: [], proposals: [],
    }) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const app = new AppControllerImpl(store, { openAi: new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key') }, {
      tokenStore: { async get(ref) { return ref === 'mail-token' ? structuredClone(token) : null; }, async set() {} },
      connectorFactory: () => ({}) as never,
    });
    await app.load();
    expect(app.getSnapshot().accounts[0].connected).toBe(true);
    await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const analysis = await app.assistNote(note.id, { intent: 'answer', question: 'What does the shipment update email say?' });
    expect(Object.keys(analysis.sourceVersions)).toContain(`mail:${encodeURIComponent(accountIdentity)}:${encodeURIComponent('provider-message')}`);
    expect(Object.keys(analysis.sourceVersions).some((sourceId) => sourceId.includes('wrong-row') || sourceId.includes('other-message'))).toBe(false);
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
    let rejectNextWrite = false;
    let pauseWrite = false;
    let releaseWrite: (() => void) | undefined;
    let writeStarted: (() => void) | undefined;
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async sendEmail(_account: unknown, envelope: unknown, verifier: { verify(value: never): Promise<boolean>; verifyBeforeDispatch(value: never): boolean }) {
        verifiedEnvelope = await verifier.verify(envelope as never);
        if (pauseWrite) {
          pauseWrite = false;
          writeStarted?.();
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
        }
        if (!verifier.verifyBeforeDispatch(envelope as never)) throw new Error('Approved action changed before provider dispatch.');
        externalWrites++;
        if (rejectNextWrite) {
          rejectNextWrite = false;
          throw new ProviderWriteRejectedError(400);
        }
        return { status: 'accepted' as const, id: 'provider-reference' };
      },
    };
    const transcript = 'Email Alex about the meeting.';
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
    const fetcher = async () => new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      summary: 'Email Alex about the meeting.', answer: '', decisions: [],
      citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: transcript }], clarifications: [],
      proposals: [{ kind: 'email', title: 'Meeting', body: 'Let us meet tomorrow.', recipients: ['alex@example.com'], dueAt: null, evidence: [transcript] }],
    }) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const app = new AppControllerImpl(store, { openAi: new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key') }, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result);
    await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const note = await app.saveNote({ transcript });
    const [draft] = await app.processNote(note.id);
    await app.editProposal(draft.id, { accountId: account.id, email: {
      operation: 'send', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Meeting', text: 'Let us meet tomorrow.', attachments: [],
    } });
    await app.approveProposal(draft.id);
    const executed = await app.executeProposal(draft.id);
    expect(verifiedEnvelope).toBe(true);
    expect(executed).toMatchObject({ status: 'accepted', remoteOperation: 'send', remoteId: 'provider-reference', simulated: false });
    expect(executed.dispatchRecordId).toBeTruthy();
    expect(app.getSnapshot().dispatchRecords[0]).toMatchObject({
      proposalId: draft.id, operation: 'send', outcome: 'accepted', remoteId: 'provider-reference',
      account: { displayName: 'Verified', email: 'user@example.com' },
      payload: { kind: 'email', email: { to: ['alex@example.com'], subject: 'Meeting', text: 'Let us meet tomorrow.' } },
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

    const secondNote = await app.saveNote({ transcript });
    const [secondDraft] = await app.processNote(secondNote.id);
    expect(app.getSnapshot().dispatchRecords).toHaveLength(1);
    expect(app.getSnapshot().dispatchRecords[0].sourceActionKey).not.toBe(secondDraft.sourceActionKey);
    await app.editProposal(secondDraft.id, { accountId: account.id, email: {
      operation: 'send', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Meeting', text: 'Let us meet tomorrow.', attachments: [],
    } });
    await app.approveProposal(secondDraft.id);
    pauseWrite = true;
    const writeBegan = new Promise<void>((resolve) => { writeStarted = resolve; });
    const pendingExecution = app.executeProposal(secondDraft.id);
    await writeBegan;
    await app.saveDocument('memory/RULES.md', '# Rules\n\nDo not send meeting emails.\n');
    releaseWrite?.();
    const blocked = await pendingExecution;
    expect(blocked).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/changed before provider dispatch/i) });
    expect(externalWrites).toBe(1);
    expect(app.getSnapshot().dispatchRecords).toHaveLength(2);
    expect(app.getSnapshot().dispatchRecords[0]).toMatchObject({ outcome: 'rejected', rejectionCode: 'precondition_failed' });
    expect(app.getSnapshot().dispatchRecords[1]).toMatchObject({ outcome: 'accepted' });

    const rejectedNote = await app.saveNote({ transcript });
    const [rejectedDraft] = await app.processNote(rejectedNote.id);
    await app.editProposal(rejectedDraft.id, { accountId: account.id, email: {
      operation: 'send', to: ['jamie@example.com'], cc: [], bcc: [], subject: 'Updated agenda', text: 'Here is the revised agenda.', attachments: [],
    } });
    await app.approveProposal(rejectedDraft.id);
    rejectNextWrite = true;
    const providerRejected = await app.executeProposal(rejectedDraft.id);
    expect(providerRejected.status).toBe('failed');
    expect(app.getSnapshot().dispatchRecords[0]).toMatchObject({ outcome: 'rejected', rejectionCode: 'provider_rejected' });

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
    const fetcher = async () => new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      summary: 'Send Jordan the final notes.', answer: '', decisions: [], citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: transcript }],
      clarifications: [], proposals: [{ kind: 'email', title: 'Final notes', body: 'Here are the final notes.', recipients: ['jordan@example.com'], dueAt: null, evidence: [transcript] }],
    }) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const integration = { tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' }, verifyOAuthResult: async () => true, connectorFactory: () => connector as never };
    const app = new AppControllerImpl(store, { openAi: new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key') }, integration);
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, oauth);
    await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const note = await app.saveNote({ transcript });
    const [draft] = await app.processNote(note.id);
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
    await app.approveProposal(draft.id);
    const outcomes = await Promise.allSettled([app.executeProposal(draft.id), app.executeProposal(draft.id)]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(app.getSnapshot().proposals.find((item) => item.id === draft.id)).toMatchObject({ status: 'simulated', simulated: true });
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
    await app.approveProposal(pa.id);
    await app.approveProposal(pb.id);
    await Promise.all([app.executeProposal(pa.id), app.executeProposal(pb.id)]);
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

  it('persists answer-mode assistance with stable capture time and reuses it after reload', async () => {
    vi.useFakeTimers();
    try {
      const requestTime = '2026-10-12T23:14:00.000Z';
      vi.setSystemTime(new Date(requestTime));
      let calls = 0;
      const requestBodies: string[] = [];
      const transcript = 'The review call is tomorrow at ten.';
      const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
      const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        requestBodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({
          output: [{ content: [{ type: 'output_text', text: JSON.stringify({
            summary: 'A review call is planned.', answer: 'Tomorrow at ten in the recording timezone.',
            decisions: [], citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: 'tomorrow at ten' }],
            clarifications: [], proposals: [],
          }) }] }], usage: { input_tokens: 10, output_tokens: 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const store = new MemoryStore();
      const createProvider = () => new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key');
      const app = new AppControllerImpl(store, { openAi: createProvider() });
      await app.load();
      await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
      const note = await app.saveNote({ transcript, capturedAt: '2026-10-12T01:00:00.000Z', captureTimeZone: 'Asia/Singapore' });
      const analysis = await app.assistNote(note.id, { intent: 'answer', question: 'When is the review call?' });
      expect(analysis).toMatchObject({ intent: 'answer', question: 'When is the review call?', capturedAt: '2026-10-12T01:00:00.000Z', captureTimeZone: 'Asia/Singapore', answeredAsOf: requestTime, source: 'provider' });
      expect(requestBodies[0]).toContain(`anchored separately to ${requestTime}`);
      expect(app.getSnapshot().notes[0].analysis?.answer).toMatch(/tomorrow at ten/i);

      const reloaded = new AppControllerImpl(store, { openAi: createProvider() });
      await reloaded.load();
      vi.setSystemTime(new Date('2026-10-12T23:14:59.000Z'));
      const cached = await reloaded.assistNote(note.id, { intent: 'answer', question: 'When is the review call?' });
      expect(cached.fingerprint).toBe(analysis.fingerprint);
      expect(cached.answeredAsOf).toBe(requestTime);
      expect(calls).toBe(1);

      const nextBucketTime = '2026-10-12T23:15:00.000Z';
      vi.setSystemTime(new Date(nextBucketTime));
      const refreshed = await reloaded.assistNote(note.id, { intent: 'answer', question: 'When is the review call?' });
      expect(refreshed.answeredAsOf).toBe(nextBucketTime);
      expect(refreshed.fingerprint).not.toBe(analysis.fingerprint);
      expect(calls).toBe(2);
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
    expect((JSON.parse(refreshed.fingerprint) as { contractVersion: string }).contractVersion).toBe('assist-v2');
  });

  it('retains uncertain prior retry charges and actual estimates after a later provider success', async () => {
    let fail = true;
    const fetcher = async () => {
      if (fail) return new Response('unauthorized', { status: 401 });
      const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, 'I need to call Sam tomorrow.')}`;
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Call Sam tomorrow.', answer: '', decisions: [], citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: 'I need to call Sam tomorrow.' }], clarifications: [], proposals: [{ kind: 'task', title: 'Call Sam', body: 'Call Sam tomorrow', recipients: [], dueAt: null, evidence: ['I need to call Sam tomorrow.'] }] }) }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const app = new AppControllerImpl(new MemoryStore(), { openAi: new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key') });
    await app.load();
    await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna', inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 });
    const note = await app.saveNote({ transcript: 'I need to call Sam tomorrow.' });
    await expect(app.processNote(note.id)).rejects.toThrow(/HTTP 401/);
    fail = false;
    await app.processNote(note.id);
    expect(app.getSnapshot().usage.attemptsToday).toBe(2);
    expect(app.getSnapshot().usage.unknownCharges).toBe(1);
    expect(app.getSnapshot().usage.priceKnown).toBe(false);
    expect(app.getSnapshot().usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('reuses persisted provider analysis for unchanged source and context, then refreshes after profile edits', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, 'I need to call Sam tomorrow.')}`;
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Call Sam tomorrow.', answer: '', decisions: [], citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: 'I need to call Sam tomorrow.' }], clarifications: [], proposals: [{ kind: 'task', title: 'Call Sam', body: 'Call Sam tomorrow', recipients: [], dueAt: null, evidence: ['I need to call Sam tomorrow.'] }] }) }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const store = new MemoryStore();
    const createProvider = () => new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key');
    const first = new AppControllerImpl(store, { openAi: createProvider() });
    await first.load();
    await first.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const note = await first.saveNote({ transcript: 'I need to call Sam tomorrow.' });
    const initial = await first.processNote(note.id);
    const repeated = await first.processNote(note.id);
    expect(calls).toBe(1);
    expect(repeated.map((proposal) => proposal.id)).toEqual(initial.map((proposal) => proposal.id));

    const reloaded = new AppControllerImpl(store, { openAi: createProvider() });
    await reloaded.load();
    const afterReload = await reloaded.processNote(note.id);
    expect(calls).toBe(1);
    expect(afterReload.map((proposal) => proposal.id)).toEqual(initial.map((proposal) => proposal.id));
    await reloaded.saveDocument('memory/PROFILE.md', '# Profile\n\nSam prefers email.\n');
    await reloaded.processNote(note.id);
    expect(calls).toBe(2);
  });

  it('persists an empty provider result fingerprint across reloads', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: 'No actions.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [] }) }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const store = new MemoryStore();
    const createProvider = () => new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key');
    const first = new AppControllerImpl(store, { openAi: createProvider() });
    await first.load();
    await first.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const note = await first.saveNote({ transcript: 'A thought with no action.' });
    expect(await first.processNote(note.id)).toEqual([]);
    const reloaded = new AppControllerImpl(store, { openAi: createProvider() });
    await reloaded.load();
    expect(await reloaded.processNote(note.id)).toEqual([]);
    expect(calls).toBe(1);
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

    await app.saveDocument('memory/PROFILE.md', '# Profile\n\nI prefer detailed planning.\n');
    const refreshed = await app.processNote(note.id);
    expect(refreshed.some((proposal) => proposal.id === groceries!.id)).toBe(false);
    expect(app.getSnapshot().proposals.filter((proposal) => proposal.kind === 'task' && proposal.sourceRevision === note.revision && /groceries/i.test(proposal.title)).map(({ id, title, status, sourceActionKey }) => ({ id, title, status, sourceActionKey }))).toHaveLength(1);
    expect(app.getSnapshot().tasks.filter((task) => task.sourceNoteId === note.id && /groceries/i.test(task.title))).toHaveLength(1);
    expect(refreshed.some((proposal) => proposal.kind === 'task' && /call Sam/i.test(proposal.title))).toBe(true);
    expect(app.getSnapshot().proposals.filter((proposal) => proposal.kind === 'memory' && /short replies/i.test(proposal.body))).toHaveLength(1);
  });

  it('stores a provider response as stale and creates no proposals when a selected source changes in flight', async () => {
    let release!: () => void;
    let requestStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const text = 'I need to call Alex tomorrow.';
    const fetcher = vi.fn(async () => {
      requestStarted();
      await held;
      const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text.normalize('NFC'))}`;
      return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
        summary: 'Call Alex.', answer: '', decisions: [],
        citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: text }], clarifications: [],
        proposals: [{ kind: 'task', title: 'Call Alex', body: 'Call Alex tomorrow.', recipients: [], dueAt: null, evidence: [text] }],
      }) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, { openAi: new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key') });
    await app.load();
    await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const note = await app.saveNote({ transcript: text });
    const assist = app.assistNote(note.id);
    await started;
    await app.saveDocument('memory/PROFILE.md', '# Profile\n\nChanged while the response was pending.\n');
    release();
    const result = await assist;
    expect(result.stale).toBe(true);
    expect(result.clarifications.at(-1)).toMatch(/context changed/i);
    expect(app.getSnapshot().proposals).toHaveLength(0);
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
    await expect(reloaded.executeProposal(edited.id)).rejects.toThrow(/content or destination changed/i);
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
