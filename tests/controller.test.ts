import { describe, expect, it } from 'vitest';
import type { AppState, Proposal } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { AzureOpenAIClient } from '../src/services/azure';
import { cancelReminderNotification, reminderNotificationId, requestReminderNotification } from '../src/services/notifications';
import type { OAuthBridgeResult, StoredOAuthToken } from '../src/connectors';

class MemoryStore implements StateStore {
  value?: AppState;
  failNext = false;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
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

  it('persists locally and reloads a saved note', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    const note = await first.saveNote({ transcript: 'Remember to call Sam.' });
    const second = new AppControllerImpl(store);
    await second.load();
    expect(second.getSnapshot().notes[0]).toMatchObject({ id: note.id, transcript: 'Remember to call Sam.' });
  });

  it('installs only verifier-approved OAuth identity and resumes sync from persisted page cursors', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'provider-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get(ref: string) { return ref === 'secure-ref' ? structuredClone(token) : null; }, async set() {} };
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
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: 'Ignored label', email: 'other@example.com' }, result, 'secure-ref');
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
    const installed = await app.installVerifiedAccount({ id: placeholder.id, provider: 'google', displayName: '', email: '' }, result, 'secure-ref');
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
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result, 'secure-ref');
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
    const connector = {
      async verifyOAuthIdentity() { return true; },
      async sendEmail(_account: unknown, envelope: unknown, verifier: { verify(value: never): Promise<boolean> }) {
        verifiedEnvelope = await verifier.verify(envelope as never);
        return { status: 'accepted' as const, id: 'provider-reference' };
      },
    };
    const app = new AppControllerImpl(store, {}, {
      tokenStore, deleteToken: async () => undefined, clientIds: { google: 'google-client' },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never,
    });
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result, 'secure-ref');
    const note = await app.saveNote({ transcript: 'Email Alex about the meeting.' });
    const [draft] = await app.processNote(note.id);
    await app.saveSettings({ mode: 'provider' });
    await app.editProposal(draft.id, { accountId: account.id, email: {
      operation: 'send', to: ['alex@example.com'], cc: [], bcc: [], subject: 'Meeting', text: 'Let us meet tomorrow.', attachments: [],
    } });
    await app.approveProposal(draft.id);
    const executed = await app.executeProposal(draft.id);
    expect(verifiedEnvelope).toBe(true);
    expect(executed).toMatchObject({ status: 'accepted', remoteOperation: 'send', remoteId: 'provider-reference', simulated: false });
    expect(executed.lastError).toBeUndefined();
    expect(app.getSnapshot().activity.some((item) => /Completion or delivery is not confirmed/.test(item.message))).toBe(true);
  });

  it('marks volatile or missing credentials for reauthentication after reload and clears approvals before disconnect', async () => {
    const store = new MemoryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'provider-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get(ref: string) { return ref === 'secure-ref' ? structuredClone(token) : null; }, async set() {} };
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
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result, 'secure-ref');
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
    expect(deleted).toBe('secure-ref');
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

  it('retains uncertain prior retry charges and actual estimates after a later provider success', async () => {
    let fail = true;
    const fetcher = async () => {
      if (fail) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ proposals: [{ kind: 'task', title: 'Call Sam', body: 'Call Sam tomorrow', recipients: [], dueAt: null, evidence: ['I need to call Sam tomorrow.'] }] }) }] }],
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
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ proposals: [{ kind: 'task', title: 'Call Sam', body: 'Call Sam tomorrow', recipients: [], dueAt: null, evidence: ['I need to call Sam tomorrow.'] }] }) }] }],
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
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ proposals: [] }) }] }],
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
