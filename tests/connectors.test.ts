import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorClient, describeMessageWindowQuery, messageWindowQueryFingerprint, ProviderHttpError, ProviderWriteRejectedError, type ApprovedDispatch, type OAuthTokenStore, type StoredOAuthToken } from '../src/connectors';
import { exchangeAuthorizationCode } from '../src/connectors/oauth';
import type { Account, EmailProposalPayload } from '../src/core';
import type { MailReplyProvenance } from '../src/mailReply';

const tokenIdentity = { subject: 'sub-1', providerNamespace: 'google' as const, clientId: 'test-google-client', issuer: 'https://accounts.google.com' };
const account: Account = {
  id: 'google-1', provider: 'google', displayName: 'Test', email: 'me@example.test', connected: true,
  authStatus: 'connected', identity: tokenIdentity, tokenRef: 'token:google-1',
  grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  capabilities: ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'],
};
const microsoftIdentity = { subject: 'ms-subject', providerNamespace: 'microsoft' as const, clientId: 'test-ms-client', resourceUserId: 'graph-user-1', tenantId: '12345678-1234-4234-8234-123456789abc' };
const microsoftAccount: Account = { ...account, id: 'ms-1', provider: 'microsoft', email: 'ms@example.test', identity: microsoftIdentity, tokenRef: 'token:ms-1', grantedScopes: ['Mail.Read'] };
const payload: EmailProposalPayload = { to: ['to@example.test'], cc: ['cc@example.test'], bcc: ['secret@example.test'], subject: 'Résumé ✓', text: 'Hello, 世界', attachments: [] };
const envelope: ApprovedDispatch = { proposalId: 'proposal-1', revision: 1, sourceRevision: 1, operation: 'send', accountId: account.id, identity: tokenIdentity, payloadDigest: 'a'.repeat(64), title: 'Approved title', body: 'Approved body', payload };
const verifier = { verify: vi.fn(async () => true), verifyBeforeDispatch: vi.fn(() => true) };

function replyFixture(provider: 'google' | 'microsoft' = 'google', mode: 'reply' | 'reply_all' = 'reply') {
  const selectedAccount = provider === 'google' ? account : microsoftAccount;
  const identity = selectedAccount.identity!;
  const idFormat = provider === 'google' ? 'gmail' as const : 'graph-immutable' as const;
  const digest = 'd'.repeat(64);
  const source: MailReplyProvenance['source'] = {
    version: 1, accountId: selectedAccount.id, accountEmail: selectedAccount.email!, identity, connectionGeneration: selectedAccount.connectionGeneration ?? 0,
    localMessageId: 'local-message-1', providerMessageId: provider === 'google' ? 'gmail-source-id' : 'AAMk-immutable-source==', idFormat,
    ...(provider === 'google' ? { threadId: 'gmail-thread-id' } : {}), internetMessageId: '<original@example.test>', references: '<prior@example.test>',
    subject: 'Résumé ✓', from: 'Alex <alex@example.test>', senderEmail: 'alex@example.test', replyTo: ['reply@example.test'],
    to: ['me@example.test'], cc: ['colleague@example.test'], snippet: 'Earlier message', replyMetadataComplete: true,
    observedAt: new Date(Date.now()).toISOString(), sourceDigest: digest,
  };
  const replySource: MailReplyProvenance = { version: 2, kind: 'mail_reply', sourceDigest: digest, source, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const payload: EmailProposalPayload = {
    operation: 'draft', to: ['reply@example.test', ...(mode === 'reply_all' ? ['me@example.test'] : [])],
    cc: mode === 'reply_all' ? ['colleague@example.test'] : [], bcc: [], subject: source.subject, text: 'Approved reply body', attachments: [],
    reply: { mode, sourceDigest: digest, localMessageId: source.localMessageId, providerMessageId: source.providerMessageId, idFormat,
      internetMessageId: source.internetMessageId, sourceSubject: source.subject, threadId: source.threadId,
      references: '<prior@example.test> <original@example.test>', inReplyTo: source.internetMessageId },
  };
  const dispatch: ApprovedDispatch = { ...envelope, operation: 'draft', sourceRevision: undefined, accountId: selectedAccount.id, identity,
    title: 'Reply draft', body: payload.text, payload, replySource };
  return { selectedAccount, payload, dispatch, replySource };
}

function token(overrides: Partial<StoredOAuthToken> = {}): StoredOAuthToken {
  return { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 600_000, identity: tokenIdentity, ...overrides };
}

function fixture(options: { token?: StoredOAuthToken; fetcher?: typeof fetch; status?: (id: string, status: Account['authStatus']) => void } = {}) {
  let stored = options.token ?? token();
  const store: OAuthTokenStore = { get: vi.fn(async () => stored), set: vi.fn(async (_ref, next) => { stored = next; }) };
  const client = new ConnectorClient({ tokenStore: store, fetcher: options.fetcher, googleClientId: 'test-google-client', microsoftClientId: 'test-ms-client', onAuthStatus: options.status, now: Date.now });
  return { client, store, getStored: () => stored };
}

const response = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const b64url = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
function selectedHeaders() {
  return [
    { name: 'Subject', value: 'Original subject' }, { name: 'From', value: 'Alex <alex@example.test>' },
    { name: 'Reply-To', value: 'reply@example.test' }, { name: 'To', value: 'me@example.test' },
    { name: 'Cc', value: 'colleague@example.test' }, { name: 'Message-ID', value: '<selected@example.test>' },
    { name: 'References', value: '<prior@example.test>' }, { name: 'In-Reply-To', value: '<prior@example.test>' },
  ];
}
function gmailSelectedMessage(id = 'gmail-selected', text = 'Selected message body', extra: Record<string, unknown> = {}) {
  return { id, threadId: 'thread-selected', historyId: 'history-7', sizeEstimate: 1234, snippet: 'Selected snippet', internalDate: String(Date.now()), labelIds: ['INBOX'],
    payload: { mimeType: 'text/plain', headers: selectedHeaders(), body: { data: b64url(text) } }, ...extra };
}
function graphSelectedMessage(id = 'AAMk-selected==', text = 'Selected Graph body', extra: Record<string, unknown> = {}) {
  return { id, conversationId: 'conversation-selected', changeKey: 'change-7', subject: 'Original subject', body: { contentType: 'text', content: text }, bodyPreview: 'Graph snippet',
    from: { emailAddress: { address: 'alex@example.test' } }, replyTo: [{ emailAddress: { address: 'reply@example.test' } }],
    toRecipients: [{ emailAddress: { address: 'me@example.test' } }], ccRecipients: [{ emailAddress: { address: 'colleague@example.test' } }],
    internetMessageId: '<selected@example.test>', internetMessageHeaders: selectedHeaders(), isRead: false, receivedDateTime: new Date(Date.now() - 60_000).toISOString(), ...extra };
}

describe('provider connector clients', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses a canonical account, window, and page-size fingerprint for message-window cursors', async () => {
    const base = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z', pageSize: 3 };
    const descriptor = describeMessageWindowQuery(account, base);
    expect(descriptor).toEqual(describeMessageWindowQuery(account, { timeMin: '2026-10-01T08:00:00+08:00', timeMax: '2026-10-02T08:00:00+08:00', pageSize: 3.9 }));
    expect(messageWindowQueryFingerprint(account, base)).toBe(descriptor.queryFingerprint);
    expect(messageWindowQueryFingerprint({ ...account, identity: { ...tokenIdentity, subject: 'different-subject' } }, base)).not.toBe(descriptor.queryFingerprint);
    expect(messageWindowQueryFingerprint(account, { ...base, timeMax: '2026-10-03T00:00:00Z' })).not.toBe(descriptor.queryFingerprint);
    expect(messageWindowQueryFingerprint(account, { ...base, pageSize: 4 })).not.toBe(descriptor.queryFingerprint);

    const { client } = fixture({ fetcher: vi.fn(async () => response({ messages: [] })) as typeof fetch });
    const result = await client.syncMessageWindow(account, base);
    expect(result.queryFingerprint).toBe(descriptor.queryFingerprint);
    expect(result.window).toEqual(descriptor.window);
  });

  it('refreshes once for concurrent calls and preserves an omitted refresh token', async () => {
    let refreshCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/token')) { refreshCount++; await new Promise((resolve) => setTimeout(resolve, 5)); return response({ access_token: 'new-access', expires_in: 3600 }); }
      if (String(input).includes('/userinfo')) return response({ sub: tokenIdentity.subject });
      return response({ items: [] });
    }) as typeof fetch;
    const { client, store, getStored } = fixture({ token: token({ expiresAt: 0 }), fetcher });
    await Promise.all([client.listCalendars(account), client.listCalendars(account)]);
    expect(refreshCount).toBe(1);
    expect(getStored().accessToken).toBe('new-access');
    expect(getStored().refreshToken).toBe('refresh');
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('re-reads the secure store after a slow stale read before rotating a refresh token', async () => {
    let stored = token({ expiresAt: 0 });
    let reads = 0;
    let refreshCount = 0;
    const store: OAuthTokenStore = {
      get: async () => {
        const snapshot = stored;
        const call = ++reads;
        if (call === 2) await new Promise((resolve) => setTimeout(resolve, 30));
        return snapshot;
      },
      set: async (_ref, next) => { stored = next; },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/token')) { refreshCount++; return response({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600 }); }
      if (String(input).includes('/userinfo')) return response({ sub: tokenIdentity.subject });
      return response({ items: [] });
    });
    const client = new ConnectorClient({ tokenStore: store, fetcher: fetcher as typeof fetch, googleClientId: 'test-google-client' });
    await Promise.all([client.listCalendars(account), client.listCalendars(account)]);
    expect(refreshCount).toBe(1);
    expect(stored.refreshToken).toBe('rotated-refresh');
  });

  it('marks a rejected refresh token revoked and does not issue the API call', async () => {
    const onStatus = vi.fn();
    const fetcher = vi.fn(async () => response({ error: 'invalid_grant' }, 400)) as typeof fetch;
    const { client } = fixture({ token: token({ expiresAt: 0 }), fetcher, status: onStatus });
    await expect(client.listCalendars(account)).rejects.toThrow(/rejected the refresh token/i);
    expect(onStatus).toHaveBeenCalledWith(account.id, 'reauth_required');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not persist refreshed credentials unless provider userinfo confirms the same subject', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/token')) return response({ access_token: 'wrong-subject', expires_in: 3600 });
      if (String(input).includes('/userinfo')) return response({ sub: 'somebody-else' });
      return response({});
    });
    const { client, store } = fixture({ token: token({ expiresAt: 0 }), fetcher: fetcher as typeof fetch });
    await expect(client.listCalendars(account)).rejects.toThrow(/another provider identity/i);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('rejects token identity mismatch before network access', async () => {
    const fetcher = vi.fn() as typeof fetch;
    const { client } = fixture({ token: token({ identity: { ...tokenIdentity, subject: 'other-person' } }), fetcher });
    await expect(client.listCalendars(account)).rejects.toThrow(/does not match this account/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('limits sync to three pages, caps Gmail details, and returns the resumable cursor', async () => {
    const fetcherMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/messages') && url.searchParams.has('pageToken')) {
        const p = url.searchParams.get('pageToken');
        return response({ messages: [{ id: `msg-${p}` }], nextPageToken: p === 'one' ? 'two' : p === 'two' ? 'three' : 'four' });
      }
      if (url.pathname.endsWith('/messages')) return response({ messages: [{ id: 'msg-0' }], nextPageToken: 'one' });
      return response({ id: url.pathname.split('/').pop(), threadId: 'thread', snippet: 'summary', internalDate: '0', payload: { headers: [{ name: 'Subject', value: 'Subject' }] } });
    });
    const { client } = fixture({ fetcher: fetcherMock as typeof fetch });
    let guardCalls = 0;
    const persistedPages: Array<{ count: number; cursor?: string }> = [];
    const result = await client.syncMessages(account, { pageSize: 1000, query: 'from:alex', guard: () => { guardCalls++; }, onPage: (page, cursor) => { persistedPages.push({ count: page.length, cursor }); } });
    expect(result.pagesRead).toBe(3);
    expect(result.partial).toBe(true);
    expect(result.nextCursor).toContain('pageToken=three');
    expect(result.nextCursor).toContain('q=from%3Aalex');
    expect(result.items).toHaveLength(3);
    expect(fetcherMock.mock.calls.filter((call) => String(call[0]).includes('/messages/')).length).toBe(3);
    expect(String(fetcherMock.mock.calls[0][0])).toContain('maxResults=50');
    expect(String(fetcherMock.mock.calls[0][0])).toContain('q=from%3Aalex');
    expect(guardCalls).toBe(6);
    expect(persistedPages).toHaveLength(3);
    expect(persistedPages[2].cursor).toContain('pageToken=three');
  });

  it('hydrates exactly one Gmail inbox window page, filters half-open boundaries, and reports only explicit 404 gaps', async () => {
    const seen: string[] = [];
    const start = Date.parse('2026-10-01T00:00:00.250Z');
    const end = Date.parse('2026-10-02T00:00:00.250Z');
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(url.toString());
      if (url.pathname.endsWith('/messages') && !url.pathname.includes('/messages/')) {
        expect(url.searchParams.get('q')).toContain(`after:${Math.floor(start / 1000) - 1}`);
        expect(url.searchParams.get('q')).toContain(`before:${Math.ceil(end / 1000) + 1}`);
        expect(url.searchParams.get('q')).toContain('in:inbox');
        return response({ messages: [{ id: 'in-window' }, { id: 'outside-window' }, { id: 'deleted' }], nextPageToken: 'next-token' });
      }
      if (url.pathname.endsWith('/deleted')) return response({}, 404);
      const id = url.pathname.split('/').pop();
      const timestamp = id === 'outside-window' ? end : start;
      return response({ id, threadId: 'thread-1', historyId: 'history-11', sizeEstimate: 250, internalDate: String(timestamp), labelIds: ['INBOX'], snippet: 'short preview', payload: { headers: [
        { name: 'Subject', value: 'Agenda' }, { name: 'From', value: 'Alex <alex@example.test>' },
        { name: 'To', value: 'me@example.test' }, { name: 'Message-ID', value: '<message-1>' },
      ] } });
    }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const pages: Array<{ items: unknown[]; cursor?: string; count: number; metadata: { unavailableIds: string[]; window: { from: string; to: string }; queryFingerprint: string } }> = [];
    const result = await client.syncMessageWindow(account, { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), pageSize: 3, onPage: (items, cursor, count, metadata) => { pages.push({ items, cursor, count, metadata }); } });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'in-window', idFormat: 'gmail', senderEmail: 'alex@example.test', replyMetadataComplete: true, providerVersion: 'history-11', sizeEstimate: 250 });
    expect(result.unavailableIds).toEqual(['deleted']);
    expect(result.partial).toBe(true);
    expect(result.nextCursor).toContain('q=after%3A');
    expect(result.queryFingerprint).toContain('google-client');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ count: 1 });
    expect(pages[0].metadata).toMatchObject({ unavailableIds: ['deleted'], window: result.window, queryFingerprint: result.queryFingerprint });
    expect(seen).toHaveLength(4);
    expect(seen.slice(1).every((url) => url.includes('format=metadata'))).toBe(true);
    const metaUrl = new URL(seen[1]);
    expect(metaUrl.searchParams.get('fields')).toBe('id,threadId,historyId,sizeEstimate,snippet,internalDate,labelIds,payload(headers)');
  });

  it('loads a selected Gmail message once from a fresh bounded estimate and returns full-text metadata', async () => {
    const requested: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => { const url = new URL(String(input)); requested.push(url); return response(gmailSelectedMessage()); }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const result = await client.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 1234, sizeCheckedAt: new Date(Date.now() - 1000).toISOString() });
    expect(result).toMatchObject({ status: 'available', text: 'Selected message body', bytes: 21, representation: 'plain', completeness: 'complete_text', extractionVersion: 'mail-text-v2' });
    expect(result.message).toMatchObject({ id: 'gmail-selected', idFormat: 'gmail', threadId: 'thread-selected', providerVersion: 'history-7', sizeEstimate: 1234, replyMetadataComplete: true });
    expect(requested).toHaveLength(1);
    expect(requested[0].searchParams.get('format')).toBe('full');
    expect(requested[0].searchParams.get('fields')).toContain('historyId,sizeEstimate');
    expect(requested[0].searchParams.get('fields')).toContain('attachmentId');
    expect(requested[0].searchParams.get('fields')?.match(/parts\(/g)?.length).toBe(12);
  });

  it('ignores unrelated malformed or long headers while still rejecting malformed selected headers', async () => {
    const noisyMessage = gmailSelectedMessage();
    const noisyPayload = noisyMessage.payload as Record<string, unknown>;
    noisyPayload.headers = [
      ...selectedHeaders(),
      { name: 'DKIM-Signature', value: `v=1; ${'signature-data'.repeat(300)}` },
      { name: 'Received', value: `from relay ${'x'.repeat(5000)}` },
      { name: 'X-Unrelated', value: { providerExtension: true } },
    ];
    const noisyClient = fixture({ fetcher: vi.fn(async () => response(noisyMessage)) as typeof fetch }).client;
    await expect(noisyClient.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 1234, sizeCheckedAt: new Date().toISOString() }))
      .resolves.toMatchObject({ status: 'available', text: 'Selected message body' });

    const malformedMessage = gmailSelectedMessage();
    const malformedPayload = malformedMessage.payload as Record<string, unknown>;
    malformedPayload.headers = [...selectedHeaders().filter((header) => header.name !== 'Subject'), { name: 'Subject', value: 'Injected\r\nX-Evil: yes' }];
    const malformedClient = fixture({ fetcher: vi.fn(async () => response(malformedMessage)) as typeof fetch }).client;
    await expect(malformedClient.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 1234, sizeCheckedAt: new Date().toISOString() }))
      .resolves.toMatchObject({ status: 'unavailable', reasons: expect.arrayContaining(['reply_metadata_incomplete']) });
  });

  it('rejects selected-response JSON with invalid wire UTF-8 and preserves normal Unicode text', async () => {
    const prefix = new TextEncoder().encode('{"id":"gmail-selected","invalid":"');
    const suffix = new TextEncoder().encode('"}');
    const malformedBytes = new Uint8Array(prefix.length + 1 + suffix.length);
    malformedBytes.set(prefix); malformedBytes[prefix.length] = 0xff; malformedBytes.set(suffix, prefix.length + 1);
    const invalidGmailClient = fixture({ fetcher: vi.fn(async () => new Response(malformedBytes, { headers: { 'content-type': 'application/json' } })) as typeof fetch }).client;
    await expect(invalidGmailClient.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 1234, sizeCheckedAt: new Date().toISOString() }))
      .resolves.toMatchObject({ status: 'unavailable', reasons: ['invalid_selected_response_json'] });

    const unicodeGraph = graphSelectedMessage('AAMk-selected==', 'café 🙂');
    const validGraphClient = fixture({ fetcher: vi.fn(async () => response(unicodeGraph)) as typeof fetch, token: token({ identity: microsoftIdentity }) }).client;
    await expect(validGraphClient.readSelectedMessageText(microsoftAccount, 'AAMk-selected=='))
      .resolves.toMatchObject({ status: 'available', text: 'café 🙂', completeness: 'complete_text' });

    const invalidGraphClient = fixture({ fetcher: vi.fn(async () => new Response(malformedBytes, { headers: { 'content-type': 'application/json' } })) as typeof fetch, token: token({ identity: microsoftIdentity }) }).client;
    await expect(invalidGraphClient.readSelectedMessageText(microsoftAccount, 'AAMk-selected=='))
      .resolves.toMatchObject({ status: 'unavailable', reasons: ['invalid_selected_response_json'] });
  });

  it('uses one Gmail size preflight for stale estimates and stops before full retrieval above the cap', async () => {
    const requested: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); requested.push(url);
      return url.searchParams.has('format') ? response(gmailSelectedMessage()) : response({ id: 'gmail-selected', threadId: 'thread-selected', historyId: 'history-8', sizeEstimate: 300 * 1024 });
    }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const result = await client.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 12, sizeCheckedAt: new Date(Date.now() - 16 * 60_000).toISOString() });
    expect(result).toMatchObject({ status: 'unavailable', completeness: 'unavailable', representation: 'none', reasons: ['size_limit'] });
    expect(result.message).toMatchObject({ providerVersion: 'history-8', sizeEstimate: 300 * 1024 });
    expect(requested).toHaveLength(1);
    expect(requested[0].searchParams.get('fields')).toBe('id,threadId,historyId,sizeEstimate');
    expect(requested[0].searchParams.has('format')).toBe(false);
  });

  it('uses at most preflight and full GET when the Gmail size estimate is missing', async () => {
    const requested: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); requested.push(url);
      return url.searchParams.has('format') ? response(gmailSelectedMessage()) : response({ id: 'gmail-selected', threadId: 'thread-selected', historyId: 'history-8', sizeEstimate: 1234 });
    }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const result = await client.readSelectedMessageText(account, 'gmail-selected');
    expect(result.status).toBe('available');
    expect(requested).toHaveLength(2);
    expect(requested.map((url) => url.pathname)).toEqual([
      '/gmail/v1/users/me/messages/gmail-selected', '/gmail/v1/users/me/messages/gmail-selected',
    ]);
  });

  it('converts HTML Gmail content and never fetches attachment IDs', async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      const message = gmailSelectedMessage('gmail-selected', 'ignored');
      (message.payload as Record<string, unknown>) = { mimeType: 'multipart/mixed', headers: selectedHeaders(), parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>html body</p>') } },
        { mimeType: 'text/plain', body: { attachmentId: 'external-attachment' } },
      ] };
      return response(message);
    }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const result = await client.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 1234, sizeCheckedAt: new Date().toISOString() });
    expect(result).toMatchObject({ status: 'available', text: 'html body', representation: 'converted_html', completeness: 'excerpt', extractionVersion: 'mail-text-v2' });
    expect(result.reasons).toEqual(expect.arrayContaining(['html_non_rendering_conversion', 'attachment_body_unavailable']));
    expect(requested).toHaveLength(1);
    expect(requested.some((url) => url.includes('attachments'))).toBe(false);
  });

  it('returns unavailable for mismatched Gmail IDs, oversized responses, and failed resource auth without retries', async () => {
    const mismatch = fixture({ fetcher: vi.fn(async () => response(gmailSelectedMessage('different-id'))) as typeof fetch }).client;
    const mismatchResult = await mismatch.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 1234, sizeCheckedAt: new Date().toISOString() });
    expect(mismatchResult.status).toBe('unavailable');
    const oversizedFetcher = vi.fn(async () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } })) as typeof fetch;
    const oversized = fixture({ fetcher: oversizedFetcher }).client;
    expect(await oversized.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 1234, sizeCheckedAt: new Date().toISOString() })).toMatchObject({ status: 'unavailable', reasons: ['response_byte_limit'] });
    const unauthorizedFetcher = vi.fn(async () => response({ error: 'unauthorized' }, 401)) as typeof fetch;
    await expect(fixture({ fetcher: unauthorizedFetcher }).client.readSelectedMessageText(account, 'gmail-selected', { sizeEstimate: 1234, sizeCheckedAt: new Date().toISOString() })).rejects.toThrow(/401/);
    expect(oversizedFetcher).toHaveBeenCalledTimes(1);
    expect(unauthorizedFetcher).toHaveBeenCalledTimes(1);
  });

  it('reads one Graph selected message with both preferences and full-body scope, then uses explicit snippet fallback for HTML', async () => {
    let requestedUrl = '';
    let prefer = '';
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { requestedUrl = String(input); prefer = new Headers(init?.headers).get('prefer') ?? ''; return response(graphSelectedMessage()); }) as typeof fetch;
    const { client } = fixture({ fetcher, token: token({ identity: microsoftIdentity }) });
    const result = await client.readSelectedMessageText(microsoftAccount, 'AAMk-selected==');
    expect(result).toMatchObject({ status: 'available', text: 'Selected Graph body', representation: 'plain', completeness: 'complete_text', extractionVersion: 'mail-text-v2' });
    expect(result.message).toMatchObject({ id: 'AAMk-selected==', idFormat: 'graph-immutable', providerVersion: 'change-7', replyMetadataComplete: true });
    expect(requestedUrl).toContain('/me/messages/AAMk-selected%3D%3D?');
    expect(new URL(requestedUrl).searchParams.get('$select')).toBe('id,conversationId,changeKey,subject,body,bodyPreview,from,replyTo,toRecipients,ccRecipients,internetMessageId,internetMessageHeaders,isRead,receivedDateTime');
    expect(prefer).toContain('IdType="ImmutableId"');
    expect(prefer).toContain('outlook.body-content-type="text"');
    expect(fetcher).toHaveBeenCalledTimes(1);

    const htmlClient = fixture({ fetcher: vi.fn(async () => response(graphSelectedMessage('AAMk-selected==', '', { body: { contentType: 'html', content: '<p>body</p>' } }))) as typeof fetch, token: token({ identity: microsoftIdentity }) }).client;
    await expect(htmlClient.readSelectedMessageText(microsoftAccount, 'AAMk-selected==')).resolves.toMatchObject({ text: 'body', representation: 'converted_html', completeness: 'excerpt', extractionVersion: 'mail-text-v2', reasons: expect.arrayContaining(['html_non_rendering_conversion']) });

    const blankHtmlClient = fixture({ fetcher: vi.fn(async () => response(graphSelectedMessage('AAMk-selected==', '', { body: { contentType: 'html', content: '<p> &nbsp; </p>' } }))) as typeof fetch, token: token({ identity: microsoftIdentity }) }).client;
    await expect(blankHtmlClient.readSelectedMessageText(microsoftAccount, 'AAMk-selected==')).resolves.toMatchObject({ text: 'Graph snippet', representation: 'snippet', completeness: 'excerpt', extractionVersion: 'mail-text-v2', reasons: expect.arrayContaining(['html_non_rendering_conversion', 'snippet_fallback']) });
  });

  it('refuses Graph Basic-only body reads and mismatched immutable IDs before extra requests', async () => {
    const basicAccount = { ...microsoftAccount, grantedScopes: ['Mail.ReadBasic'] };
    const tokenGet = vi.fn(async () => token({ identity: microsoftIdentity }));
    const fetcher = vi.fn() as typeof fetch;
    const client = new ConnectorClient({ tokenStore: { get: tokenGet, set: async () => {} }, fetcher });
    await expect(client.readSelectedMessageText(basicAccount, 'AAMk-selected==')).rejects.toThrow(/Full message body read permission/i);
    expect(tokenGet).not.toHaveBeenCalled();
    const mismatch = fixture({ token: token({ identity: microsoftIdentity }), fetcher: vi.fn(async () => response(graphSelectedMessage('other-id'))) as typeof fetch }).client;
    await expect(mismatch.readSelectedMessageText(microsoftAccount, 'AAMk-selected==')).resolves.toMatchObject({ status: 'unavailable', reasons: ['message_id_mismatch_or_invalid_response'] });
  });

  it('does not commit a Gmail page with an invalid message date and validates window cursor query binding', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/messages') && !url.pathname.includes('/messages/')) return response({ messages: [{ id: 'bad-date' }] });
      return response({ id: 'bad-date', internalDate: 'not-a-date', payload: { headers: [] } });
    }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const onPage = vi.fn();
    await expect(client.syncMessageWindow(account, { timeMin: '2026-10-01T00:00:00.000Z', timeMax: '2026-10-02T00:00:00.000Z', onPage })).rejects.toThrow(/valid internal date/i);
    expect(onPage).not.toHaveBeenCalled();
    await expect(client.syncMessageWindow(account, { timeMin: '2026-10-01T00:00:00.000Z', timeMax: '2026-10-02T00:00:00.000Z', cursor: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=wrong&pageToken=x' })).rejects.toThrow(/exact mailbox window/i);
  });

  it('reads Microsoft inbox pages with half-open filter, immutable IDs, bounded headers, and safe continuation paths', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
      expect(url.searchParams.get('$filter')).toContain('receivedDateTime ge 2026-10-01T00:00:00.000Z and receivedDateTime lt 2026-10-02T00:00:00.000Z');
      expect(url.searchParams.get('$select')).toContain('internetMessageHeaders');
      expect(new Headers(init?.headers).get('prefer')).toContain('IdType="ImmutableId"');
      return response({ value: [{ id: 'AAMk...==', conversationId: 'thread', changeKey: 'v9', isRead: false, receivedDateTime: '2026-10-01T00:00:00Z', from: { emailAddress: { name: 'Alex', address: 'alex@example.test' } }, replyTo: [{ emailAddress: { address: 'reply@example.test' } }], toRecipients: [], ccRecipients: [], internetMessageId: '<graph-message>', internetMessageHeaders: [{ name: 'From', value: 'Alex <alex@example.test>' }] }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=opaque' });
    }) as typeof fetch;
    const { client } = fixture({ token: token({ identity: microsoftIdentity }), fetcher });
    const result = await client.syncMessageWindow(microsoftAccount, { timeMin: '2026-10-01T00:00:00.000Z', timeMax: '2026-10-02T00:00:00.000Z' });
    expect(result.items[0]).toMatchObject({ id: 'AAMk...==', idFormat: 'graph-immutable', isRead: false, senderEmail: 'alex@example.test', internetMessageId: '<graph-message>', providerVersion: 'v9', replyTo: ['reply@example.test'], to: [], cc: [], replyMetadataComplete: true });
    expect(result.nextCursor).toContain('$skiptoken=opaque');
    expect(result.partial).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.syncMessageWindow(microsoftAccount, { timeMin: '2026-10-01T00:00:00.000Z', timeMax: '2026-10-02T00:00:00.000Z', cursor: 'https://graph.microsoft.com/v1.0/me/drive/root/children' })).rejects.toThrow(/outside the allowed API/i);
  });

  it('atomically reports Gmail messages moved out of INBOX and rejects mismatched hydrated IDs', async () => {
    const pageStore: Array<{ ids: string[]; unavailable: string[] }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/messages') && !url.pathname.includes('/messages/')) return response({ messages: [{ id: 'moved' }, { id: 'unknown-labels' }] });
      if (url.pathname.endsWith('/moved')) return response({ id: 'moved', internalDate: String(Date.parse('2026-10-01T12:00:00Z')), labelIds: ['SPAM'], payload: { headers: [] } });
      return response({ id: 'unknown-labels', internalDate: String(Date.parse('2026-10-01T13:00:00Z')), payload: { headers: [{ name: 'From', value: 'alex@example.test' }] } });
    }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const result = await client.syncMessageWindow(account, {
      timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z',
      onPage: (items, _cursor, _count, metadata) => { pageStore.push({ ids: items.map(({ id }) => id), unavailable: metadata.unavailableIds }); },
    });
    expect(result.items.map(({ id }) => id)).toEqual(['unknown-labels']);
    expect(result.items[0]).toMatchObject({ isRead: undefined, replyMetadataComplete: false });
    expect(result.unavailableIds).toEqual(['moved']);
    expect(pageStore).toEqual([{ ids: ['unknown-labels'], unavailable: ['moved'] }]);

    const mismatchFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/messages') && !url.pathname.includes('/messages/')
        ? response({ messages: [{ id: 'listed-id' }] })
        : response({ id: 'different-id', internalDate: String(Date.parse('2026-10-01T12:00:00Z')) });
    }) as typeof fetch;
    const mismatchClient = fixture({ fetcher: mismatchFetcher }).client;
    const commit = vi.fn();
    await expect(mismatchClient.syncMessageWindow(account, { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z', onPage: commit })).rejects.toThrow(/does not match/i);
    expect(commit).not.toHaveBeenCalled();
  });

  it('marks Microsoft reply metadata incomplete when structured recipient arrays are absent or malformed', async () => {
    const fetcher = vi.fn(async () => response({ value: [{ id: 'opaque', changeKey: 'v1', internetMessageId: '<id>', receivedDateTime: '2026-10-01T10:00:00Z', from: { emailAddress: { address: 'alex@example.test' } }, internetMessageHeaders: [{ name: 'X-Unsupported', value: 'x' }] }] })) as typeof fetch;
    const { client } = fixture({ token: token({ identity: microsoftIdentity }), fetcher });
    const result = await client.syncMessageWindow(microsoftAccount, { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z' });
    expect(result.items[0]).toMatchObject({ replyMetadataComplete: false, internetMessageId: '<id>', providerVersion: 'v1' });
    expect(result.items[0].to).toBeUndefined();
    expect(result.items[0].headers).toEqual([]);
  });

  it('fails closed on malformed successful JSON, missing Graph values, and oversized pages without committing cursors', async () => {
    const onPage = vi.fn();
    const malformed = fixture({ fetcher: (async () => new Response('{invalid-json', { status: 200 })) as typeof fetch }).client;
    await expect(malformed.syncMessageWindow(account, { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z', onPage })).rejects.toThrow(/invalid JSON/i);
    expect(onPage).not.toHaveBeenCalled();

    const missingGraphValue = fixture({
      token: token({ identity: microsoftIdentity }), fetcher: (async () => response({ '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=1' })) as typeof fetch,
    }).client;
    await expect(missingGraphValue.syncMessageWindow(microsoftAccount, { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z', onPage })).rejects.toThrow(/invalid message page/i);
    expect(onPage).not.toHaveBeenCalled();

    const oversized = fixture({
      fetcher: (async () => response({ messages: Array.from({ length: 11 }, (_, index) => ({ id: `id-${index}` })) })) as typeof fetch,
    }).client;
    await expect(oversized.syncMessageWindow(account, { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z', pageSize: 10, onPage })).rejects.toThrow(/more messages than the requested page size/i);
    expect(onPage).not.toHaveBeenCalled();
  });

  it('classifies a malformed Gmail detail 404 as unavailable without losing the status', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/messages') && !url.pathname.includes('/messages/')
        ? response({ messages: [{ id: 'deleted' }] })
        : new Response('not-json', { status: 404 });
    }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const onPage = vi.fn();
    const result = await client.syncMessageWindow(account, { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z', onPage });
    expect(result.unavailableIds).toEqual(['deleted']);
    expect(onPage).toHaveBeenCalledWith([], undefined, 1, expect.objectContaining({ unavailableIds: ['deleted'] }));
  });

  it('distinguishes definite provider write rejection from ambiguous failures and exposes read HTTP status', async () => {
    const rejected = fixture({ fetcher: (async () => response({ error: 'bad request' }, 400)) as typeof fetch });
    await expect(rejected.client.sendEmail(account, envelope, verifier)).rejects.toBeInstanceOf(ProviderWriteRejectedError);
    try { await rejected.client.sendEmail(account, envelope, verifier); } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'provider_rejected', dispatched: true });
    }
    const unavailable = fixture({ fetcher: (async () => response({}, 404)) as typeof fetch });
    await expect(unavailable.client.listCalendars(account)).rejects.toBeInstanceOf(ProviderHttpError);
    await expect(unavailable.client.listCalendars(account)).rejects.toMatchObject({ status: 404 });
  });

  it('classifies Graph send 400 and 403 responses as definite provider rejections after one request', async () => {
    for (const status of [400, 403]) {
      const fetcher = vi.fn(async () => response({ error: 'rejected' }, status)) as typeof fetch;
      const { client } = fixture({ token: token({ identity: microsoftIdentity }), fetcher });
      await expect(client.sendEmail(microsoftAccount, { ...envelope, accountId: microsoftAccount.id, identity: microsoftIdentity }, verifier))
        .rejects.toMatchObject({ status, code: 'provider_rejected', dispatched: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects external cursors before making a request', async () => {
    const fetcher = vi.fn() as typeof fetch;
    const { client } = fixture({ fetcher });
    await expect(client.syncMessages(account, { cursor: 'https://attacker.test/steal' })).rejects.toThrow(/outside the allowed API/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a same-origin Graph continuation that escapes the mailbox path', async () => {
    const graph = { ...microsoftAccount, capabilities: ['mail.read'] as Account['capabilities'] };
    const fetcher = vi.fn() as typeof fetch;
    const { client } = fixture({ token: token({ identity: microsoftIdentity }), fetcher });
    await expect(client.syncMessages(graph, { cursor: 'https://graph.microsoft.com/v1.0/me/drive/root/children' })).rejects.toThrow(/outside the allowed API/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('pages calendar lists at most three times and persists each continuation', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      const page = new URL(url).searchParams.get('pageToken');
      return response({ items: [{ id: `cal-${page ?? 'first'}`, summary: 'Calendar', accessRole: 'writer' }], nextPageToken: page === 'two' ? 'three' : page === 'three' ? 'four' : 'two' });
    });
    const { client } = fixture({ fetcher: fetcher as typeof fetch });
    const saved: Array<{ items: number; cursor?: string; pages: number }> = [];
    const result = await client.listCalendars(account, { onPage: (items, cursor, pages) => { saved.push({ items: items.length, cursor, pages }); } });
    expect(result.pagesRead).toBe(3);
    expect(result.partial).toBe(true);
    expect(result.nextCursor).toContain('pageToken=four');
    expect(saved.map((page) => page.pages)).toEqual([1, 2, 3]);
    expect(urls).toHaveLength(3);
  });

  it('accepts opaque provider calendar IDs and scopes Graph cursors to the selected calendar', async () => {
    const graphId = 'AAMkAGI2T...opaque==';
    const encoded = encodeURIComponent(graphId);
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url.includes('/me/calendars?')) return response({ value: [{ id: graphId, name: 'Work', canEdit: true }] });
      if (url.includes('page=one')) return response({ value: [{ id: 'event-1', subject: 'One' }] });
      return response({ value: [], '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/calendars/${encoded}/calendarView?startDateTime=2026-01-01T00%3A00%3A00.000Z&endDateTime=2026-01-15T00%3A00%3A00.000Z&page=one` });
    });
    const { client } = fixture({ token: token({ identity: microsoftIdentity }), fetcher: fetcher as typeof fetch });
    const calendars = await client.listCalendars(microsoftAccount);
    expect(calendars.items[0]).toMatchObject({ id: graphId, writable: true });
    const events = await client.readCalendarEvents(microsoftAccount, graphId);
    expect(events.items).toHaveLength(1);
    expect(urls[1]).toContain(`/me/calendars/${encoded}/calendarView`);
    await expect(client.readCalendarEvents(microsoftAccount, 'different-calendar', { cursor: urls[2] })).rejects.toThrow(/outside the allowed API/i);
  });

  it('certifies only strict UTC Graph calendar dateTimes and retains the UTC preference across continuation pages', async () => {
    const urls: string[] = [];
    const prefers: Array<string | null> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      prefers.push(new Headers(init?.headers).get('prefer'));
      if (url.searchParams.has('startDateTime')) return response({ value: [
        { id: 'valid-utc', start: { dateTime: '2026-10-13T10:30:00.125', timeZone: 'UTC' }, end: { dateTime: '2026-10-13T11:30:00', timeZone: 'UTC' } },
        { id: 'wrong-zone', start: { dateTime: '2026-10-13T10:30:00', timeZone: 'Asia/Singapore' }, end: { dateTime: '2026-10-13T11:30:00', timeZone: 'UTC' } },
        { id: 'missing-zone', start: { dateTime: '2026-10-13T10:30:00' }, end: { dateTime: '2026-10-13T11:30:00', timeZone: 'UTC' } },
        { id: 'invalid-day', start: { dateTime: '2026-02-30T10:30:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-13T11:30:00Z', timeZone: 'UTC' } },
      ], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/calendar-1/calendarView?next=one' });
      return response({ value: [] });
    }) as typeof fetch;
    const { client } = fixture({ token: token({ identity: microsoftIdentity }), fetcher });
    const events = await client.readCalendarEvents(microsoftAccount, 'calendar-1');
    expect(events.items[0]).toMatchObject({ startUtcCertified: true, endUtcCertified: true });
    expect(events.items[1].startUtcCertified).toBeUndefined();
    expect(events.items[2].startUtcCertified).toBeUndefined();
    expect(events.items[3].startUtcCertified).toBeUndefined();
    expect(events.items[3].endUtcCertified).toBeUndefined();
    expect(prefers).toEqual(['outlook.timezone="UTC"', 'outlook.timezone="UTC"']);
    expect(urls).toHaveLength(2);
  });

  it('rejects malformed and oversized calendar pages before saving a continuation cursor', async () => {
    for (const value of [undefined, { nope: true }, Array.from({ length: 51 }, (_, index) => ({ id: `event-${index}` })), [{ id: '' }]]) {
      const fetcher = vi.fn(async () => response({ value, '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/calendar-1/calendarView?next=one' })) as typeof fetch;
      const { client } = fixture({ token: token({ identity: microsoftIdentity }), fetcher });
      const onPage = vi.fn();
      await expect(client.readCalendarEvents(microsoftAccount, 'calendar-1', { onPage })).rejects.toThrow(/calendar event/i);
      expect(onPage).not.toHaveBeenCalled();
    }
  });

  it('encodes Google holiday calendar IDs as opaque path segments', async () => {
    const id = 'en.usa#holiday@group.v.calendar.google.com';
    let requested = '';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => { requested = String(input); return response({ items: [] }); });
    const { client } = fixture({ fetcher: fetcher as typeof fetch });
    await client.readCalendarEvents(account, id);
    expect(requested).toContain(`/calendars/${encodeURIComponent(id)}/events`);
  });

  it('sends all approved recipients with UTF-8 MIME and rejects CRLF header injection', async () => {
    let posted: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { posted = JSON.parse(String(init?.body)); return response({ id: 'sent-1' }); }) as typeof fetch;
    const { client } = fixture({ fetcher });
    expect(await client.sendEmail(account, envelope, verifier)).toEqual({ id: 'sent-1', status: 'accepted' });
    const raw = String(posted?.raw).replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
    const mime = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    expect(mime).toContain('To: to@example.test');
    expect(mime).toContain('Cc: cc@example.test');
    expect(mime).toContain('Bcc: secret@example.test');
    expect(mime).toContain('=?UTF-8?B?');
    await expect(client.sendEmail(account, { ...envelope, payload: { ...payload, subject: 'hello\r\nBcc: injected@test.test' } }, verifier)).rejects.toThrow(/line break/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('creates a Gmail reply draft in the source thread with locked subject and RFC reply headers', async () => {
    const fixtureData = replyFixture();
    let posted: Record<string, unknown> | undefined;
    let requestedUrl = '';
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { requestedUrl = String(url); posted = JSON.parse(String(init?.body)); return response({ id: 'draft-1', message: { id: 'new-message', threadId: 'gmail-thread-id' } }); }) as typeof fetch;
    const { client } = fixture({ fetcher });
    const result = await client.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, verifier);
    expect(result).toEqual({ status: 'accepted', id: 'draft-1', replyDraftCheck: 'unverified' });
    expect(requestedUrl).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(posted?.message).toMatchObject({ threadId: 'gmail-thread-id' });
    const raw = String((posted?.message as Record<string, unknown>).raw).replace(/-/g, '+').replace(/_/g, '/');
    const mime = new TextDecoder().decode(Uint8Array.from(atob(raw + '='.repeat((4 - raw.length % 4) % 4)), (c) => c.charCodeAt(0)));
    expect(mime).toContain('To: reply@example.test');
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('In-Reply-To: <original@example.test>');
    expect(mime).toContain('References: <prior@example.test> <original@example.test>');
    expect(mime).not.toContain('Bcc:');
    expect(mime).not.toContain('Content-Disposition: attachment');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const wrongThreadFetcher = vi.fn(async () => response({ id: 'draft-2', message: { threadId: 'unexpected-thread' } })) as typeof fetch;
    const wrongThreadClient = fixture({ fetcher: wrongThreadFetcher }).client;
    await expect(wrongThreadClient.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, verifier)).resolves.toEqual({ status: 'accepted', id: 'draft-2', replyDraftCheck: 'differs' });
  });

  it('preserves the frozen Gmail References chain order when the original ID is already in the middle', async () => {
    const fixtureData = replyFixture();
    const references = '<prior@example.test> <original@example.test> <later@example.test>';
    const source = { ...fixtureData.replySource.source, references };
    const replySource = { ...fixtureData.replySource, source };
    const payload = { ...fixtureData.payload, reply: { ...fixtureData.payload.reply!, references } };
    let posted: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { posted = JSON.parse(String(init?.body)); return response({ id: 'draft-ordered', message: { threadId: 'gmail-thread-id' } }); }) as typeof fetch;
    const client = fixture({ fetcher }).client;
    await client.createDraft(fixtureData.selectedAccount, { ...fixtureData.dispatch, replySource, payload }, verifier);
    const raw = String((posted?.message as Record<string, unknown>).raw).replace(/-/g, '+').replace(/_/g, '/');
    const mime = new TextDecoder().decode(Uint8Array.from(atob(raw + '='.repeat((4 - raw.length % 4) % 4)), (c) => c.charCodeAt(0)));
    expect(mime).toContain(`References: ${references}`);
  });

  it('rejects a References physical line over 998 characters before token access', async () => {
    const fixtureData = replyFixture();
    const longId = `<${'a'.repeat(990)}@x>`;
    const references = `${longId} <original@example.test>`;
    const source = { ...fixtureData.replySource.source, references: longId };
    const replySource = { ...fixtureData.replySource, source };
    const payload = { ...fixtureData.payload, reply: { ...fixtureData.payload.reply!, references } };
    const tokenGet = vi.fn(async () => token());
    const fetcher = vi.fn() as typeof fetch;
    const client = new ConnectorClient({ tokenStore: { get: tokenGet, set: async () => {} }, fetcher });
    await expect(client.createDraft(fixtureData.selectedAccount, { ...fixtureData.dispatch, replySource, payload }, verifier)).rejects.toThrow(/RFC line limit/i);
    expect(tokenGet).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects reply sends and malformed source bindings before reading a token', async () => {
    const fixtureData = replyFixture();
    const tokenGet = vi.fn(async () => token());
    const fetcher = vi.fn() as typeof fetch;
    const client = new ConnectorClient({ tokenStore: { get: tokenGet, set: async () => {} }, fetcher });
    await expect(client.sendEmail(fixtureData.selectedAccount, { ...fixtureData.dispatch, operation: 'send', payload: { ...fixtureData.payload, operation: 'send' } }, verifier)).rejects.toThrow(/only create a draft/i);
    await expect(client.createDraft(fixtureData.selectedAccount, { ...fixtureData.dispatch, payload: { ...fixtureData.payload, subject: 'Changed subject' } }, verifier)).rejects.toThrow(/bound to the verified original/i);
    await expect(client.createDraft(fixtureData.selectedAccount, { ...fixtureData.dispatch, payload: { ...fixtureData.payload, reply: { ...fixtureData.payload.reply!, references: '<safe@example.test>\r\nBcc: injected@example.test' } } }, verifier)).rejects.toThrow();
    await expect(client.createDraft(fixtureData.selectedAccount, { ...fixtureData.dispatch, replySource: { ...fixtureData.replySource, source: { ...fixtureData.replySource.source, accountId: 'different-account' } } }, verifier)).rejects.toThrow(/current connected account/i);
    expect(tokenGet).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves an empty frozen source subject as an empty Gmail Subject header', async () => {
    const fixtureData = replyFixture();
    const source = { ...fixtureData.replySource.source, subject: '' };
    const replySource = { ...fixtureData.replySource, source };
    const payload = { ...fixtureData.payload, subject: '', reply: { ...fixtureData.payload.reply!, sourceSubject: '' } };
    let posted: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { posted = JSON.parse(String(init?.body)); return response({ id: 'empty-subject-draft', message: { threadId: 'gmail-thread-id' } }); }) as typeof fetch;
    const client = fixture({ fetcher }).client;
    await client.createDraft(fixtureData.selectedAccount, { ...fixtureData.dispatch, replySource, payload }, verifier);
    const raw = String((posted?.message as Record<string, unknown>).raw).replace(/-/g, '+').replace(/_/g, '/');
    const mime = new TextDecoder().decode(Uint8Array.from(atob(raw + '='.repeat((4 - raw.length % 4) % 4)), (c) => c.charCodeAt(0)));
    expect(mime).toContain('Subject: \r\nIn-Reply-To: <original@example.test>');
  });

  it('rechecks reply source expiry at the final pre-dispatch fence', async () => {
    const fixtureData = replyFixture();
    const replySource = { ...fixtureData.replySource, expiresAt: '2000-01-01T00:00:00.000Z' };
    const tokenGet = vi.fn(async () => token());
    const fetcher = vi.fn() as typeof fetch;
    const client = new ConnectorClient({ tokenStore: { get: tokenGet, set: async () => {} }, fetcher });
    await expect(client.createDraft(fixtureData.selectedAccount, { ...fixtureData.dispatch, replySource }, verifier)).rejects.toThrow(/source approval has expired/i);
    expect(tokenGet).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('creates a Graph reply-all draft with the immutable source ID, exact approved body and no extra fields', async () => {
    const fixtureData = replyFixture('microsoft', 'reply_all');
    let requestedUrl = '';
    let posted: Record<string, unknown> | undefined;
    let prefer = '';
    const graphDraft = { id: 'graph-draft-1', isDraft: true, subject: fixtureData.payload.subject, body: { contentType: 'Text', content: fixtureData.payload.text },
      toRecipients: fixtureData.payload.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: fixtureData.payload.cc.map((address) => ({ emailAddress: { address } })), bccRecipients: [] };
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { requestedUrl = String(url); posted = JSON.parse(String(init?.body)); prefer = new Headers(init?.headers).get('prefer') ?? ''; return response(graphDraft); }) as typeof fetch;
    const { client } = fixture({ fetcher, token: token({ identity: microsoftIdentity }) });
    const result = await client.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, verifier);
    expect(requestedUrl).toBe(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent('AAMk-immutable-source==')}/createReplyAll`);
    expect(prefer).toContain('IdType="ImmutableId"');
    expect(posted).toEqual({ message: { body: { contentType: 'Text', content: 'Approved reply body' },
      toRecipients: fixtureData.payload.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: fixtureData.payload.cc.map((address) => ({ emailAddress: { address } })), bccRecipients: [] } });
    expect(result).toEqual({ status: 'accepted', id: 'graph-draft-1', replyDraftCheck: 'matches_approved' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps Graph mismatch and incomplete draft receipts without persisting provider content', async () => {
    const fixtureData = replyFixture('microsoft');
    const base = { id: 'graph-draft-2', isDraft: true, subject: fixtureData.payload.subject, body: { contentType: 'Text', content: fixtureData.payload.text },
      toRecipients: fixtureData.payload.to.map((address) => ({ emailAddress: { address } })), ccRecipients: [], bccRecipients: [] };
    const mismatchClient = fixture({ token: token({ identity: microsoftIdentity }), fetcher: vi.fn(async () => response({ ...base, subject: 'Changed subject', body: { contentType: 'Text', content: 'provider secret response text' } })) as typeof fetch }).client;
    const mismatch = await mismatchClient.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, verifier);
    expect(mismatch).toEqual({ status: 'accepted', id: 'graph-draft-2', replyDraftCheck: 'differs' });
    expect(JSON.stringify(mismatch)).not.toContain('provider secret response text');
    const incompleteClient = fixture({ token: token({ identity: microsoftIdentity }), fetcher: vi.fn(async () => response({ id: 'graph-draft-3' })) as typeof fetch }).client;
    await expect(incompleteClient.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, verifier)).resolves.toEqual({ status: 'accepted', id: 'graph-draft-3', replyDraftCheck: 'unverified' });
    const noIdClient = fixture({ token: token({ identity: microsoftIdentity }), fetcher: vi.fn(async () => response({ subject: fixtureData.payload.subject })) as typeof fetch }).client;
    await expect(noIdClient.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, verifier)).resolves.toEqual({ status: 'unknown' });
  });

  it('classifies reply write responses safely and never retries ambiguous writes', async () => {
    const fixtureData = replyFixture();
    const badRequestFetcher = vi.fn(async () => response({ error: 'bad request' }, 400)) as typeof fetch;
    await expect(fixture({ fetcher: badRequestFetcher }).client.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, verifier)).rejects.toBeInstanceOf(ProviderWriteRejectedError);
    const serverFetcher = vi.fn(async () => response({ error: 'uncertain' }, 503)) as typeof fetch;
    await expect(fixture({ fetcher: serverFetcher }).client.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, verifier)).resolves.toEqual({ status: 'unknown' });
    expect(badRequestFetcher).toHaveBeenCalledTimes(1);
    expect(serverFetcher).toHaveBeenCalledTimes(1);
  });

  it('runs the final reply approval fence after token access and immediately before dispatch', async () => {
    const fixtureData = replyFixture();
    let approved = true;
    const tokenStore: OAuthTokenStore = { get: async () => { approved = false; return token(); }, set: async () => {} };
    const fetcher = vi.fn(async () => response({ id: 'draft-1', message: { threadId: 'gmail-thread-id' } })) as typeof fetch;
    const client = new ConnectorClient({ tokenStore, fetcher });
    const dispatchVerifier = { verify: async () => true, verifyBeforeDispatch: () => approved };
    await expect(client.createDraft(fixtureData.selectedAccount, fixtureData.dispatch, dispatchVerifier)).rejects.toThrow(/changed before provider dispatch/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a send timeout as unknown and never retries', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('network timeout'); }) as typeof fetch;
    const { client } = fixture({ fetcher });
    await expect(client.sendEmail(account, envelope, verifier)).resolves.toEqual({ status: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('checks attachment bytes against approved size and hash before dispatch', async () => {
    const bytes = new TextEncoder().encode('content');
    const loadAttachment = vi.fn(async () => bytes);
    const fetcherMock = vi.fn();
    const attachmentClient = new ConnectorClient({ tokenStore: { get: async () => token(), set: async () => {} }, fetcher: fetcherMock as typeof fetch, loadAttachment, sha256: async () => 'f'.repeat(64) });
    const attachmentPayload = { ...payload, attachments: [{ id: 'file1', fileName: 'proof.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength, sha256: 'a'.repeat(64) }] };
    await expect(attachmentClient.sendEmail(account, { ...envelope, payload: attachmentPayload }, verifier)).rejects.toThrow(/changed after approval/i);
    expect(fetcherMock).not.toHaveBeenCalled();
    expect(loadAttachment).toHaveBeenCalledWith('file1');
  });

  it('rechecks current approval after attachment preparation and immediately before write dispatch', async () => {
    const bytes = new TextEncoder().encode('content');
    let releaseAttachment!: () => void;
    let attachmentStarted!: () => void;
    const started = new Promise<void>((resolve) => { attachmentStarted = resolve; });
    const loadAttachment = async () => { attachmentStarted(); await new Promise<void>((resolve) => { releaseAttachment = resolve; }); return bytes; };
    let stillApproved = true;
    const dispatchVerifier = { verify: async () => true, verifyBeforeDispatch: () => stillApproved };
    const fetcher = vi.fn(async () => response({ id: 'draft-1' })) as typeof fetch;
    const client = new ConnectorClient({ tokenStore: { get: async () => token(), set: async () => {} }, fetcher, loadAttachment, sha256: async () => 'c'.repeat(64) });
    const attachmentPayload = { ...payload, attachments: [{ id: 'file', fileName: 'file.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength, sha256: 'c'.repeat(64) }] };
    const sending = client.createDraft(account, { ...envelope, operation: 'draft', payload: attachmentPayload }, dispatchVerifier);
    await started;
    stillApproved = false;
    releaseAttachment();
    await expect(sending).rejects.toThrow(/changed before provider dispatch/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not persist a late token refresh after the account connection is revoked', async () => {
    let current = true;
    let releaseUserInfo!: () => void;
    let userInfoStarted!: () => void;
    const started = new Promise<void>((resolve) => { userInfoStarted = resolve; });
    const tokenStore: OAuthTokenStore = { get: async () => token({ expiresAt: 0 }), set: vi.fn(async () => {}) };
    const fetcherMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/token')) return response({ access_token: 'rotated', expires_in: 3600 });
      if (String(input).includes('/userinfo')) { userInfoStarted(); await new Promise<void>((resolve) => { releaseUserInfo = resolve; }); return response({ sub: tokenIdentity.subject }); }
      return response({ items: [] });
    });
    const fetcher = fetcherMock as typeof fetch;
    const client = new ConnectorClient({ tokenStore, fetcher, googleClientId: 'test-google-client', isConnectionCurrent: () => current });
    const reading = client.listCalendars(account);
    await started;
    current = false;
    releaseUserInfo();
    await expect(reading).rejects.toThrow(/connection changed/i);
    expect(tokenStore.set).not.toHaveBeenCalled();
    expect(fetcherMock.mock.calls.some(([url]) => String(url).includes('/users/me/calendarList'))).toBe(false);
  });

  it('preserves Graph event time zone and blocks attendee invitations when policy is none', async () => {
    const fetcherMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ id: 'event-1' }));
    const { client } = fixture({ fetcher: fetcherMock as typeof fetch, token: token({ identity: microsoftIdentity }) });
    const eventPayload = { title: 'Approved meeting', description: 'Approved details', start: '2026-01-01T12:00:00Z', end: '2026-01-01T13:00:00Z', timeZone: 'Asia/Singapore', attendees: ['guest@example.test'], invitePolicy: 'send' as const };
    const eventEnvelope: ApprovedDispatch = { proposalId: 'event-1', revision: 1, sourceRevision: 1, operation: 'event', accountId: microsoftAccount.id, identity: microsoftIdentity, payloadDigest: 'b'.repeat(64), title: 'Approved meeting', body: 'Approved details', calendarId: 'calendar-1', payload: eventPayload };
    await expect(client.createEvent(microsoftAccount, 'calendar-1', { ...eventEnvelope, payload: { ...eventPayload, invitePolicy: 'none' } }, verifier, '12345678-1234-4234-8234-123456789abc')).rejects.toThrow(/cannot create an attendee event/i);
    expect(fetcherMock).not.toHaveBeenCalled();
    await client.createEvent(microsoftAccount, 'calendar-1', eventEnvelope, verifier, '12345678-1234-4234-8234-123456789abc');
    expect(String(fetcherMock.mock.calls[0][0])).toContain('graph.microsoft.com/v1.0/me/calendars/calendar-1/events');
    const init = fetcherMock.mock.calls[0][1] as RequestInit;
    const sent = JSON.parse(String(init.body));
    expect(sent.start).toEqual({ dateTime: '2026-01-01T12:00:00.000', timeZone: 'UTC' });
    expect(sent.end).toEqual({ dateTime: '2026-01-01T13:00:00.000', timeZone: 'UTC' });
    expect(sent.subject).toBe('Approved meeting');
    expect(sent.body.content).toBe('Approved details');
    expect(sent.transactionId).toBe('12345678-1234-4234-8234-123456789abc');
  });

  it('includes checked attachment bytes in Gmail MIME', async () => {
    const bytes = new TextEncoder().encode('approved attachment');
    const fetcherMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ id: 'draft-attachment' }));
    const client = new ConnectorClient({ tokenStore: { get: async () => token(), set: async () => {} }, fetcher: fetcherMock as typeof fetch,
      loadAttachment: async () => bytes, sha256: async () => 'b'.repeat(64) });
    const attachmentPayload = { ...payload, attachments: [{ id: 'file-2', fileName: 'résumé.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength, sha256: 'b'.repeat(64) }] };
    await client.createDraft(account, { ...envelope, operation: 'draft', payload: attachmentPayload }, verifier);
    const post = JSON.parse(String((fetcherMock.mock.calls[0][1] as RequestInit).body));
    const raw = String(post.message.raw).replace(/-/g, '+').replace(/_/g, '/');
    const mime = new TextDecoder().decode(Uint8Array.from(atob(raw + '='.repeat((4 - raw.length % 4) % 4)), (c) => c.charCodeAt(0)));
    expect(mime).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
    expect(mime).toContain(btoa('approved attachment'));
  });

  it('binds dispatch to the same account identity', async () => {
    const fetcher = vi.fn() as typeof fetch;
    const { client } = fixture({ fetcher });
    await expect(client.createDraft(account, { ...envelope, operation: 'draft', identity: { ...tokenIdentity, subject: 'other' } }, verifier)).rejects.toThrow(/does not match this account/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not accept a draft approval for a send operation', async () => {
    const fetcher = vi.fn() as typeof fetch;
    const { client } = fixture({ fetcher });
    await expect(client.sendEmail(account, { ...envelope, operation: 'draft' }, verifier)).rejects.toThrow(/approval does not match/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('verifies the OAuth bridge identity with fixed provider resources', async () => {
    const fetcherMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/oidc/userinfo')
      ? response({ sub: microsoftIdentity.subject })
      : response({ id: microsoftIdentity.resourceUserId }));
    const client = new ConnectorClient({ tokenStore: { get: async () => null, set: async () => {} }, fetcher: fetcherMock as typeof fetch, microsoftClientId: 'test-ms-client' });
    const refreshed = token({ accessToken: 'verified-access', identity: microsoftIdentity });
    const bridge = { provider: 'microsoft' as const, accessToken: refreshed.accessToken, refreshToken: 'refresh', expiresAt: Date.now() + 60_000,
      grantedScopes: ['openid', 'User.Read'], requestedCapabilities: [], identity: microsoftIdentity, displayName: '', capabilities: [] };
    await expect(client.verifyOAuthIdentity(bridge, refreshed)).resolves.toBe(true);
    expect(fetcherMock.mock.calls.map(([url]) => String(url))).toEqual(['https://graph.microsoft.com/oidc/userinfo', 'https://graph.microsoft.com/v1.0/me?$select=id']);
  });

  it('exchanges mocked PKCE codes only at fixed endpoints and intersects requested and granted capabilities', async () => {
    const fetcherMock = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === 'https://oauth2.googleapis.com/token') return response({ access_token: 'fresh', refresh_token: 'refresh', expires_in: 3600, scope: 'openid profile email https://www.googleapis.com/auth/gmail.compose' });
      if (path === 'https://openidconnect.googleapis.com/v1/userinfo') return response({ sub: 'stable-user', name: 'Test Person', email: 'test@example.test', email_verified: true });
      if (path === 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1') return response({ messages: [] });
      throw new Error('Unexpected endpoint');
    });
    const exchange = await exchangeAuthorizationCode({ provider: 'google', clientId: '123.apps.googleusercontent.com', redirectUri: 'com.googleusercontent.apps.123:/oauthredirect',
      requestedCapabilities: ['mail.draft'] }, { authorizationCode: 'temporary-code', codeVerifier: 'A'.repeat(43), requestedScopes: ['openid', 'profile', 'email', 'https://www.googleapis.com/auth/gmail.compose'] }, { fetcher: fetcherMock as typeof fetch });
    expect(exchange.result.capabilities).toEqual(['mail.draft']);
    expect(exchange.result.requestedCapabilities).toEqual(['mail.draft']);
    expect(exchange.result.email).toBe('test@example.test');
    expect(exchange.result.identity).toEqual({ providerNamespace: 'google', clientId: '123.apps.googleusercontent.com', subject: 'stable-user' });
    expect(fetcherMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo',
    ]);
  });

  it('fails before network access for malformed PKCE and fails closed when providers omit granted scopes', async () => {
    const fetcherMock = vi.fn(async () => response({ access_token: 'fresh', expires_in: 3600 }));
    const config = { provider: 'google' as const, clientId: '123.apps.googleusercontent.com', redirectUri: 'com.googleusercontent.apps.123:/oauthredirect', requestedCapabilities: [] };
    await expect(exchangeAuthorizationCode(config, { authorizationCode: 'code', codeVerifier: 'short', requestedScopes: ['openid'] }, { fetcher: fetcherMock as typeof fetch })).rejects.toThrow(/PKCE/i);
    expect(fetcherMock).not.toHaveBeenCalled();
    await expect(exchangeAuthorizationCode(config, { authorizationCode: 'code', codeVerifier: 'A'.repeat(43), requestedScopes: ['openid'] }, { fetcher: fetcherMock as typeof fetch })).rejects.toThrow(/scopes it granted/i);
    expect(fetcherMock).toHaveBeenCalledTimes(1);
  });

  it('allows Microsoft SPA loopback callbacks but rejects Google web callbacks before network access', async () => {
    const fetcherMock = vi.fn(async (_url: RequestInfo | URL) => response({ error: 'invalid_grant' }, 400));
    await expect(exchangeAuthorizationCode({ provider: 'google', clientId: '123.apps.googleusercontent.com', redirectUri: 'https://still.example/auth/callback', requestedCapabilities: [] },
      { authorizationCode: 'code', codeVerifier: 'A'.repeat(43), requestedScopes: ['openid'] }, { fetcher: fetcherMock as typeof fetch })).rejects.toThrow(/native reverse-client-ID/i);
    expect(fetcherMock).not.toHaveBeenCalled();

    await expect(exchangeAuthorizationCode({ provider: 'microsoft', clientId: 'ms-public-client', redirectUri: 'http://localhost:8080/auth/callback', authority: 'common', requestedCapabilities: [] },
      { authorizationCode: 'code', codeVerifier: 'A'.repeat(43), requestedScopes: ['openid'] }, { fetcher: fetcherMock as typeof fetch })).rejects.toThrow(/rejected the authorization code/i);
    expect(fetcherMock).toHaveBeenCalledTimes(1);
    expect(String(fetcherMock.mock.calls[0][0])).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
  });

  it('rejects non-loopback insecure Microsoft web callbacks', async () => {
    const fetcherMock = vi.fn(async () => response({}));
    await expect(exchangeAuthorizationCode({ provider: 'microsoft', clientId: 'ms-public-client', redirectUri: 'http://still.example/auth/callback', authority: 'common', requestedCapabilities: [] },
      { authorizationCode: 'code', codeVerifier: 'A'.repeat(43), requestedScopes: ['openid'] }, { fetcher: fetcherMock as typeof fetch })).rejects.toThrow(/HTTPS.*loopback/i);
    expect(fetcherMock).not.toHaveBeenCalled();
  });

  it('does not grant read capability when the requested scope probe is denied', async () => {
    const fetcherMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target === 'https://oauth2.googleapis.com/token') return response({ access_token: 'fresh', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/gmail.readonly' });
      if (target === 'https://openidconnect.googleapis.com/v1/userinfo') return response({ sub: 'stable-user' });
      if (target.includes('/messages?maxResults=1')) return response({ error: { message: 'denied' } }, 403);
      throw new Error('Unexpected endpoint');
    });
    const exchange = await exchangeAuthorizationCode({ provider: 'google', clientId: '123.apps.googleusercontent.com', redirectUri: 'com.googleusercontent.apps.123:/oauthredirect', requestedCapabilities: ['mail.read'] },
      { authorizationCode: 'code', codeVerifier: 'A'.repeat(43), requestedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'] }, { fetcher: fetcherMock as typeof fetch });
    expect(exchange.result.grantedScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(exchange.result.capabilities).toEqual([]);
  });

  it('binds the verified provider subject to the configured client registration', async () => {
    const fetcherMock = vi.fn(async (url: RequestInfo | URL) => String(url) === 'https://oauth2.googleapis.com/token'
      ? response({ access_token: 'fresh', expires_in: 3600, scope: 'openid' })
      : response({ sub: 'stable-user' }));
    const exchange = await exchangeAuthorizationCode({ provider: 'google', clientId: '123.apps.googleusercontent.com', redirectUri: 'com.googleusercontent.apps.123:/oauthredirect', requestedCapabilities: [] },
      { authorizationCode: 'code', codeVerifier: 'A'.repeat(43), requestedScopes: ['openid'] }, { fetcher: fetcherMock as typeof fetch });
    expect(exchange.result.identity).toEqual({ providerNamespace: 'google', clientId: '123.apps.googleusercontent.com', subject: 'stable-user' });
    expect(exchange.result.refreshToken).toBeUndefined();
    expect(exchange.token.refreshToken).toBeUndefined();
  });
});
