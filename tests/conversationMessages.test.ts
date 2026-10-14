import { describe, expect, it, vi } from 'vitest';
import { ConnectorClient, type OAuthTokenStore, type StoredOAuthToken } from '../src/connectors';
import type { Account } from '../src/core';

const googleIdentity = { subject: 'google-subject', providerNamespace: 'google' as const, clientId: 'google-client' };
const microsoftIdentity = { subject: 'ms-subject', providerNamespace: 'microsoft' as const, clientId: 'ms-client', resourceUserId: 'graph-user' };
const googleAccount: Account = {
  id: 'google-account', provider: 'google', displayName: 'Google', email: 'me@example.test', connected: true, authStatus: 'connected',
  identity: googleIdentity, tokenRef: 'google-token', grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], capabilities: ['mail.read'],
};
const graphAccount: Account = {
  ...googleAccount, id: 'graph-account', provider: 'microsoft', identity: microsoftIdentity, tokenRef: 'graph-token',
  grantedScopes: ['Mail.Read'],
};

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers).entries()) } });
}

function token(identity: StoredOAuthToken['identity']): StoredOAuthToken {
  return { accessToken: 'test-access-token', expiresAt: Date.now() + 10 * 60_000, identity };
}

function client(fetcher: typeof fetch, options: { selected?: Account; tokenIdentity?: StoredOAuthToken['identity']; current?: boolean } = {}) {
  const selected = options.selected ?? googleAccount;
  const store: OAuthTokenStore = {
    get: vi.fn(async () => token(options.tokenIdentity ?? selected.identity!)),
    set: vi.fn(async () => undefined),
  };
  return new ConnectorClient({ fetcher, tokenStore: store, googleClientId: 'google-client', microsoftClientId: 'ms-client',
    isConnectionCurrent: () => options.current ?? true });
}

function gmailRow(id: string, threadId = 'thread-1', internalDate = '1760000000000', labelIds: string[] = ['INBOX']) {
  return { id, threadId, historyId: 'h1', sizeEstimate: 321, internalDate, labelIds, snippet: `${id} snippet`, payload: { headers: [
    { name: 'From', value: 'Alex <alex@example.test>' }, { name: 'Sender', value: 'Alex <alex@example.test>' },
    { name: 'Reply-To', value: 'reply@example.test' }, { name: 'To', value: 'me@example.test' }, { name: 'Cc', value: 'copy@example.test' },
    { name: 'Subject', value: `Subject ${id}` }, { name: 'Message-ID', value: `<${id}@example.test>` },
    { name: 'References', value: '<prior@example.test>' }, { name: 'In-Reply-To', value: '<prior@example.test>' },
    { name: 'Date', value: 'Thu, 09 Oct 2025 08:53:20 +0000' },
  ] } };
}

function graphRow(id: string, conversationId = 'conv-1', receivedDateTime = '2025-10-09T08:53:20Z', extra: Record<string, unknown> = {}) {
  return { id, conversationId, changeKey: 'ck1', subject: `Subject ${id}`, from: { emailAddress: { address: 'alex@example.test' } },
    sender: { emailAddress: { address: 'sender@example.test' } }, receivedDateTime, sentDateTime: '2025-10-09T08:50:00Z',
    internetMessageId: `<${id}@example.test>`, isDraft: false, parentFolderId: 'inbox', ...extra };
}

describe('metadata-only conversation discovery', () => {
  it('reads a Gmail thread with one metadata request, no body fetch or pagination, and reports draft/time metadata', async () => {
    let requestedUrl = '';
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input); requestInit = init;
      return response({ id: 'thread-1', historyId: 'h1', messages: [gmailRow('newer', 'thread-1', '1760000001000', ['INBOX', 'DRAFT']), gmailRow('older')] });
    }) as typeof fetch;
    const api = client(fetcher);
    const result = await api.listConversationMessages(googleAccount, { threadId: 'thread-1' });
    const parsed = new URL(requestedUrl);
    expect(parsed.pathname).toBe('/gmail/v1/users/me/threads/thread-1');
    expect(parsed.searchParams.get('format')).toBe('metadata');
    expect(parsed.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Sender', 'Reply-To', 'To', 'Cc', 'Subject', 'Message-ID', 'References', 'In-Reply-To', 'Date']);
    expect(parsed.searchParams.get('fields')).toBe('id,historyId,messages(id,threadId,historyId,sizeEstimate,internalDate,labelIds,snippet,payload(headers))');
    expect(new Request(requestedUrl, requestInit).method).toBe('GET');
    expect(requestedUrl).not.toContain('/messages/');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ coverage: 'complete_metadata', omissionReasons: [], messages: [
      { id: 'older', threadId: 'thread-1', isDraft: false, replyMetadataComplete: false },
      { id: 'newer', threadId: 'thread-1', isDraft: true, replyMetadataComplete: false },
    ] });
    expect(result.messages[0].receivedAt).toBe('2025-10-09T08:53:20.000Z');
    expect(result.messages[0].sentAt).toBe('2025-10-09T08:53:20.000Z');
    expect(result.nextCursor).toBeUndefined();
  });

  it('escapes the Graph filter, asks for one immutable-ID page, and returns the original continuation unchanged', async () => {
    const continuation = 'https://graph.microsoft.com/v1.0/me/messages?$filter=conversationId%20eq%20%27team%27%27s%20thread%27&$select=id,conversationId,changeKey,subject,from,sender,receivedDateTime,sentDateTime,internetMessageId,isDraft,parentFolderId&$top=50&$skiptoken=a%2Bb%3D';
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      expect(new Headers(init?.headers).get('prefer')).toContain('IdType="ImmutableId"');
      return response(urls.length === 1 ? { value: [graphRow('AAMk-one==', "team's thread")], '@odata.nextLink': continuation } : { value: [graphRow('AAMk-two==', "team's thread", '2025-10-10T08:00:00Z')] });
    }) as typeof fetch;
    const api = client(fetcher, { selected: graphAccount });
    const first = await api.listConversationMessages(graphAccount, { threadId: "team's thread" });
    const requested = new URL(urls[0]);
    expect(requested.pathname).toBe('/v1.0/me/messages');
    expect(requested.searchParams.get('$filter')).toBe("conversationId eq 'team''s thread'");
    expect(requested.searchParams.get('$top')).toBe('50');
    expect(requested.searchParams.get('$select')).toBe('id,conversationId,changeKey,subject,from,sender,receivedDateTime,sentDateTime,internetMessageId,isDraft,parentFolderId');
    expect(first.nextCursor).toBe(continuation);
    expect(first.coverage).toBe('partial');
    expect(first.omissionReasons).toContain('more_messages_available');
    await api.listConversationMessages(graphAccount, { threadId: "team's thread", cursor: first.nextCursor });
    expect(urls[1]).toBe(continuation);
  });

  it('rejects Graph cursor origin, path, filter, select, top, duplicate keys, and Gmail cursors before network access', async () => {
    const fetcher = vi.fn() as typeof fetch;
    const api = client(fetcher, { selected: graphAccount });
    const base = 'https://graph.microsoft.com/v1.0/me/messages?$filter=conversationId%20eq%20%27conv-1%27&$select=id,conversationId,changeKey,subject,from,sender,receivedDateTime,sentDateTime,internetMessageId,isDraft,parentFolderId&$top=50&$skiptoken=opaque';
    for (const cursor of [
      base.replace('https://graph.microsoft.com', 'https://attacker.test'),
      base.replace('/me/messages?', '/me/drive/root/children?'),
      base.replace("conv-1", 'other'),
      base.replace('$top=50', '$top=49'),
      base.replace('$select=id,', '$select=body,'),
      `${base}&$filter=conversationId%20eq%20%27other%27`,
    ]) await expect(api.listConversationMessages(graphAccount, { threadId: 'conv-1', cursor })).rejects.toThrow(/cursor/i);
    await expect(client(fetcher).listConversationMessages(googleAccount, { threadId: 'thread-1', cursor: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1' })).rejects.toThrow(/does not accept a cursor/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('isolates malformed rows as partial coverage, preserves unknown dates, and sorts known timestamps before unknown ones', async () => {
    const fetcher = vi.fn(async () => response({ id: 'thread-1', messages: [
      gmailRow('b', 'thread-1', '1760000000000'), gmailRow('a', 'thread-1', '1760000000000'),
      { threadId: 'thread-1', labelIds: ['INBOX'] }, gmailRow('unknown', 'thread-1', 'invalid'),
    ] })) as typeof fetch;
    const result = await client(fetcher).listConversationMessages(googleAccount, { threadId: 'thread-1' });
    expect(result.messages.map((message) => message.id)).toEqual(['a', 'b', 'unknown']);
    expect(result.messages[2].receivedAt).toBeUndefined();
    expect(result.messages[2].sentAt).toBe('2025-10-09T08:53:20.000Z');
    expect(result.coverage).toBe('partial');
    expect(result.omissionReasons).toContain('malformed_message_rows');
    expect(result.omissionReasons).toContain('received_date_unknown');
    expect(result.messages.every((message) => message.replyMetadataComplete === false)).toBe(true);
  });

  it('rejects a cross-thread row and duplicate message IDs instead of returning ambiguous results', async () => {
    const mismatch = client((async () => response({ id: 'thread-1', messages: [gmailRow('wrong', 'other-thread')] })) as typeof fetch);
    await expect(mismatch.listConversationMessages(googleAccount, { threadId: 'thread-1' })).rejects.toThrow(/different conversation/i);
    const duplicate = client((async () => response({ id: 'thread-1', messages: [gmailRow('same'), gmailRow('same')] })) as typeof fetch);
    await expect(duplicate.listConversationMessages(googleAccount, { threadId: 'thread-1' })).rejects.toThrow(/duplicate/i);
  });

  it('enforces the 1 MiB response bound, account identity, current connection, abort, and request guard', async () => {
    const oversizedFetch = vi.fn(async () => response({}, 200, { 'content-length': String(1024 * 1024 + 1) })) as typeof fetch;
    await expect(client(oversizedFetch).listConversationMessages(googleAccount, { threadId: 'thread-1' })).rejects.toThrow(/response bound/i);
    const wrongIdentity = client(vi.fn() as typeof fetch, { tokenIdentity: { ...googleIdentity, subject: 'wrong' } });
    await expect(wrongIdentity.listConversationMessages(googleAccount, { threadId: 'thread-1' })).rejects.toThrow(/identity/i);
    const changedConnection = client(vi.fn() as typeof fetch, { current: false });
    await expect(changedConnection.listConversationMessages(googleAccount, { threadId: 'thread-1' })).rejects.toThrow(/connection changed/i);
    const guardedFetch = vi.fn() as typeof fetch;
    const guarded = client(guardedFetch);
    await expect(guarded.listConversationMessages(googleAccount, { threadId: 'thread-1', guard: () => { throw new Error('stale generation'); } })).rejects.toThrow(/stale generation/i);
    expect(guardedFetch).not.toHaveBeenCalled();
    const abortFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return response({});
    }) as typeof fetch;
    const abortApi = client(abortFetch);
    const abort = new AbortController();
    const pending = abortApi.listConversationMessages(googleAccount, { threadId: 'thread-1', signal: abort.signal });
    await vi.waitFor(() => expect(abortFetch).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(pending).rejects.toThrow(/aborted|cancelled/i);
  });

  it('returns explicit partial coverage for malformed Graph rows and missing draft state', async () => {
    const fetcher = vi.fn(async () => response({ value: [graphRow('AAMk-valid==', 'conv-1'), { id: 'AAMk-unknown==', conversationId: 'conv-1' }, { id: 7 }] })) as typeof fetch;
    const result = await client(fetcher, { selected: graphAccount }).listConversationMessages(graphAccount, { threadId: 'conv-1' });
    expect(result.messages.map(({ id }) => id)).toEqual(['AAMk-valid==', 'AAMk-unknown==']);
    expect(result.messages[1].isDraft).toBeUndefined();
    expect(result.coverage).toBe('partial');
    expect(result.omissionReasons).toContain('draft_state_unknown');
    expect(result.omissionReasons).toContain('malformed_message_rows');
  });
});
