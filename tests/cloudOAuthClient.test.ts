import { describe, expect, it, vi } from 'vitest';
import { createCloudOAuthClient } from '../src/web/cloudOAuthClient';

const session = Object.freeze({ authenticated: true as const, workspaceId: 'workspace-a', privacyEpoch: 8, csrfToken: 'c'.repeat(43) });
const cid = '11111111-1111-4111-8111-111111111111';
const stageId = '22222222-2222-4222-8222-222222222222';
const stage = (attemptId = stageId, extra: Record<string, unknown> = {}) => ({ attemptId, registrationId: 'google-web', provider: 'google', status: 'authorization_pending', payloadGeneration: 1, createdAt: 1_800_000_000_000, expiresAt: 1_800_000_600_000, ...extra });
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('server-backed OAuth transport', () => {
  it('keeps the browser start CID distinct from the server stage ID and navigates only a validated URL', async () => {
    const fetcher = vi.fn(async (_path: string, _init: RequestInit) => response({ kind: 'started', status: stage(), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=private' }));
    const client = createCloudOAuthClient(session, { fetcher });
    const result = await client.start('google', { startAttemptId: cid, requestedCapabilities: ['mail.read', 'calendar.read'], expectedRevision: 11, expectedPrivacyEpoch: 8 });
    expect(result.status.attemptId).toBe(stageId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe('/api/oauth/google/start');
    expect(JSON.parse(String(init?.body))).toMatchObject({ startAttemptId: cid, expectedRevision: 11, expectedPrivacyEpoch: 8 });
    expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect((init?.headers as Record<string, string>)['X-Still-CSRF']).toBe(session.csrfToken);
    client.dispose();
  });

  it('accepts long valid Unicode opaque account IDs and rejects malformed IDs or cross-origin authorization URLs', async () => {
    const longId = '🧭'.repeat(200);
    const consumed = { startAttemptId: cid, provider: 'google', status: 'consumed', stageId, createdAt: 1_800_000_000_000, expiresAt: 1_800_000_600_000,
      consumption: { commandId: '33333333-3333-4333-8333-333333333333', accountId: longId, accountGeneration: 1 } };
    const client = createCloudOAuthClient(session, { fetcher: vi.fn(async () => response(consumed)) });
    await expect(client.inspectStart('google', cid)).resolves.toMatchObject({ consumption: { accountId: longId } });
    client.dispose();

    const overLimit = createCloudOAuthClient(session, { fetcher: vi.fn(async () => response({ ...consumed, consumption: { ...consumed.consumption, accountId: '🧭'.repeat(257) } })) });
    await expect(overLimit.inspectStart('google', cid)).rejects.toMatchObject({ kind: 'malformed' });
    overLimit.dispose();

    const wrongPort = createCloudOAuthClient(session, { fetcher: vi.fn(async () => response({ kind: 'started', status: stage(), authorizationUrl: 'https://accounts.google.com:444/o/oauth2/v2/auth?state=x' })) });
    await expect(wrongPort.start('google', { startAttemptId: cid, requestedCapabilities: ['mail.read'], expectedRevision: 1, expectedPrivacyEpoch: 8 })).rejects.toMatchObject({ kind: 'malformed' });
    wrongPort.dispose();

    const noFallbackCid = createCloudOAuthClient(session, { fetcher: vi.fn(async () => response({})) });
    await expect(noFallbackCid.start('google', { startAttemptId: '', requestedCapabilities: ['mail.read'], expectedRevision: 1, expectedPrivacyEpoch: 8 })).rejects.toMatchObject({ kind: 'not_started' });
    noFallbackCid.dispose();
  });

  it('requires stage inspections to return the exact requested stage ID', async () => {
    const client = createCloudOAuthClient(session, { fetcher: vi.fn(async () => response({ stage: stage('44444444-4444-4444-8444-444444444444') })) });
    await expect(client.inspectStage(stageId)).rejects.toMatchObject({ kind: 'malformed' });
    client.dispose();
  });

  it('classifies only the exact pre-admission 409 envelope and performs no POST for local CID validation errors', async () => {
    const exact = vi.fn(async () => response({ error: 'oauth_start_not_admitted' }, 409));
    const client = createCloudOAuthClient(session, { fetcher: exact });
    await expect(client.start('google', { startAttemptId: cid, requestedCapabilities: ['mail.read'], expectedRevision: 1, expectedPrivacyEpoch: 8 }))
      .rejects.toMatchObject({ kind: 'not_admitted' });
    expect(exact).toHaveBeenCalledTimes(1);
    client.dispose();

    for (const body of [{ error: 'other' }, { error: 'oauth_start_not_admitted', extra: true }]) {
      const generic = vi.fn(async () => response(body, 409));
      const genericClient = createCloudOAuthClient(session, { fetcher: generic });
      await expect(genericClient.start('google', { startAttemptId: cid, requestedCapabilities: ['mail.read'], expectedRevision: 1, expectedPrivacyEpoch: 8 }))
        .rejects.toMatchObject({ kind: 'http', status: 409 });
      expect(generic).toHaveBeenCalledTimes(1);
      genericClient.dispose();
    }

    const noPost = vi.fn(async () => response({}));
    const invalidClient = createCloudOAuthClient(session, { fetcher: noPost });
    await expect(invalidClient.start('google', { startAttemptId: '', requestedCapabilities: ['mail.read'], expectedRevision: 1, expectedPrivacyEpoch: 8 }))
      .rejects.toMatchObject({ kind: 'not_started' });
    expect(noPost).not.toHaveBeenCalled();
    invalidClient.dispose();
  });
});
