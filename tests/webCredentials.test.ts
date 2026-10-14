import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerCredentialCommandService } from '../server/src/credentialCommands.js';
import { createDurableKernel } from '../server/src/kernel.js';
import { SecretVault } from '../server/src/vault.js';
import {
  CREDENTIAL_REQUEST_TIMEOUT_MS,
  CredentialCommandUnknownError,
  createWebProviderCredentialService,
  type WebCredentialMetadata,
} from '../src/web/credentialClient';
import type { AuthenticatedSession } from '../src/web/authClient';

const session: AuthenticatedSession = Object.freeze({
  authenticated: true,
  workspaceId: 'workspace-1',
  privacyEpoch: 4,
  csrfToken: 'session-csrf',
});

const metadata = (
  speech: { configured: boolean; generation: number } = { configured: false, generation: 0 },
  openrouter: { configured: boolean; generation: number } = { configured: false, generation: 0 },
): WebCredentialMetadata => ({ workspaceId: 'workspace-1', privacyEpoch: 4, credentials: { speech, openrouter } });

const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('web provider credential facade', () => {
  it('exposes configured flags only and rejects every browser key read', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      ...metadata({ configured: true, generation: 2 }, { configured: false, generation: 8 }),
      speechKey: 'must-not-escape', openrouterKey: 'also-private',
    }));
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'session-csrf');

    await expect(service.getCredentials()).resolves.toEqual({
      speechConfigured: true, openAiConfigured: false, openRouterConfigured: false,
    });
    await expect(service.readProviderCredential('speech')).rejects.toThrow('Credentials are server-owned');
    await expect(service.readProviderCredential('openrouter')).rejects.toThrow('Credentials are server-owned');
    await expect(service.readProviderCredential('openai')).rejects.toThrow('Credentials are server-owned');
    await expect(service.readProviderCredentialSnapshot('speech')).rejects.toThrow('Credentials are server-owned');
    await expect(service.readProviderCredentialSnapshot('openrouter')).rejects.toThrow('Credentials are server-owned');
    await expect(service.readSpeechCredentialSnapshot()).rejects.toThrow('Credentials are server-owned');
    expect(service.currentSpeechCredentialGeneration()).toBe(2);
    expect(service.currentProviderCredentialGeneration('openrouter')).toBe(8);
    expect(service.currentProviderCredentialGeneration('openai')).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('validates workspace, privacy epoch, and monotonic generations before updating the cache', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata({ configured: true, generation: 3 }, { configured: false, generation: 5 })))
      .mockResolvedValueOnce(response({ ...metadata(), workspaceId: 'another-workspace' }))
      .mockResolvedValueOnce(response(metadata({ configured: true, generation: 2 }, { configured: false, generation: 5 })));
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'session-csrf');
    await service.getCredentials();
    await expect(service.getCredentials()).rejects.toMatchObject({ kind: 'malformed' });
    await expect(service.getCredentials()).rejects.toMatchObject({ kind: 'generation' });
    expect(service.currentSpeechCredentialGeneration()).toBe(3);
    service.dispose();
  });

  it('sends one atomic multi-key write with command and CSRF headers, then returns metadata only', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata()))
      .mockResolvedValueOnce(response(metadata({ configured: true, generation: 1 }, { configured: true, generation: 1 })));
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'fresh-csrf');
    await expect(service.setCredentials({ speechSubscriptionKey: 'speech-secret', openRouterApiKey: 'router-secret' })).resolves.toEqual({
      speechConfigured: true, openAiConfigured: false, openRouterConfigured: true,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/credentials', '/api/credentials']);
    const [path, init] = fetch.mock.calls[1];
    expect(path).toBe('/api/credentials');
    expect(init).toMatchObject({ method: 'PUT', cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Still-CSRF': 'fresh-csrf' });
    expect(init.headers).toHaveProperty('X-Still-Command', expect.stringMatching(/^[0-9a-f-]{36}$/i));
    expect(JSON.parse(String(init.body))).toEqual({
      expectedPrivacyEpoch: 4,
      expectedGenerations: { speech: 0, openrouter: 0 },
      keys: { speech: 'speech-secret', openrouter: 'router-secret' },
    });
    service.dispose();
  });

  it('rejects Azure OpenAI configuration for browser batch mode without a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    await expect(service.setCredentials({ openAiApiKey: 'openai-secret' })).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(service.deleteCredentials('openai')).rejects.toMatchObject({ kind: 'unsupported' });
    expect(fetch).not.toHaveBeenCalled();
    service.dispose();
  });

  it('makes deletes atomic, including the all-supported-credentials operation', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata({ configured: true, generation: 2 }, { configured: true, generation: 7 })))
      .mockResolvedValueOnce(response(metadata({ configured: false, generation: 3 }, { configured: false, generation: 8 })))
      .mockResolvedValueOnce(response(metadata({ configured: false, generation: 4 }, { configured: false, generation: 8 })));
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    await service.getCredentials();
    await service.deleteCredentials();
    await service.deleteCredentials('speech');
    expect(fetch.mock.calls.slice(1).map(([, init]) => init.method)).toEqual(['DELETE', 'DELETE']);
    expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toEqual({
      expectedPrivacyEpoch: 4,
      expectedGenerations: { openrouter: 7, speech: 2 },
      kinds: ['openrouter', 'speech'],
    });
    expect(JSON.parse(String(fetch.mock.calls[2][1].body))).toEqual({
      expectedPrivacyEpoch: 4,
      expectedGenerations: { speech: 3 },
      kinds: ['speech'],
    });
    for (const [, init] of fetch.mock.calls.slice(1)) {
      expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      expect(init.headers).toHaveProperty('X-Still-Command', expect.stringMatching(/^[0-9a-f-]{36}$/i));
      expect(init.headers).toHaveProperty('X-Still-CSRF', 'csrf');
    }
    service.dispose();
  });

  it('passes the actual client clear-all body through the server command parser', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'still-web-credential-contract-'));
    const kernel = createDurableKernel({
      databasePath: join(directory, 'workspace.sqlite'),
      validateSnapshot: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fixture snapshot');
      },
    });
    const ownerId = randomUUID();
    const workspace = kernel.createWorkspace(ownerId, { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] });
    const serverSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
    const vault = new SecretVault(kernel, randomBytes(32));
    const commands = new ServerCredentialCommandService(kernel, vault);
    const clientSession: AuthenticatedSession = Object.freeze({
      authenticated: true, workspaceId: workspace.workspaceId, privacyEpoch: 0, csrfToken: 'session-csrf',
    });
    const fetch = vi.fn(async (path: string, init: RequestInit) => {
      if (path !== '/api/credentials') throw new Error('Unexpected endpoint');
      if (init.method === 'GET') return response(commands.getMetadata(serverSession));
      if (init.method === 'DELETE') {
        const headers = new Headers(init.headers);
        return response(commands.delete(serverSession, headers.get('X-Still-Command') ?? '', String(init.body)));
      }
      throw new Error('Unexpected method');
    });
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(clientSession, () => 'session-csrf');
    try {
      await expect(service.deleteCredentials()).resolves.toEqual({
        speechConfigured: false, openAiConfigured: false, openRouterConfigured: false,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][1].body).toBe('{"expectedGenerations":{"openrouter":0,"speech":0},"expectedPrivacyEpoch":0,"kinds":["openrouter","speech"]}');
      expect(commands.getMetadata(serverSession).credentials).toMatchObject({
        speech: { configured: false, generation: 1 },
        openrouter: { configured: false, generation: 1 },
      });
    } finally {
      service.dispose();
      vault.close();
      kernel.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('rejects a concurrent mutation without aborting the first and never auto-retries', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata()))
      .mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    await service.getCredentials();
    const first = service.setCredentials({ speechSubscriptionKey: 'speech-secret' });
    const signal = fetch.mock.calls[1][1].signal as AbortSignal;
    await expect(service.setCredentials({ openRouterApiKey: 'router-secret' })).rejects.toMatchObject({ kind: 'busy' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    pending.resolve(response(metadata({ configured: true, generation: 1 }, { configured: false, generation: 0 })));
    await first;
    expect(fetch).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('reports uncertain acknowledgement with command ID and checks its receipt only on explicit request', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata()))
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(response({ status: 'finished', metadata: metadata({ configured: true, generation: 0 }) }))
      .mockResolvedValueOnce(response(metadata({ configured: true, generation: 1 })));
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    const error = await service.setCredentials({ speechSubscriptionKey: 'secret-key' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialCommandUnknownError);
    const commandId = (error as CredentialCommandUnknownError).commandId;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers).toHaveProperty('X-Still-Command', commandId);
    expect((error as Error).message).not.toContain('secret-key');

    await expect(service.checkCredentialCommand(commandId)).resolves.toMatchObject({ status: 'finished' });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2][0]).toBe(`/api/credential-commands/${commandId}`);
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    expect(fetch.mock.calls[3][0]).toBe('/api/credentials');
    expect(service.currentSpeechCredentialGeneration()).toBe(1);
    service.dispose();
  });

  it('holds writes after unknown outcome until the exact command is finished and fresh metadata is read', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata()))
      .mockRejectedValueOnce(new TypeError('lost acknowledgement'))
      .mockResolvedValueOnce(response(metadata({ configured: false, generation: 1 })))
      .mockResolvedValueOnce(response({ status: 'claimed' }))
      .mockResolvedValueOnce(response({ status: 'finished', metadata: metadata({ configured: true, generation: 0 }) }))
      .mockResolvedValueOnce(response(metadata({ configured: true, generation: 2 })))
      .mockResolvedValueOnce(response(metadata({ configured: true, generation: 3 })));
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    const unknown = await service.setCredentials({ speechSubscriptionKey: 'first-secret' }).catch((error: unknown) => error) as CredentialCommandUnknownError;

    await expect(service.checkCredentialCommand('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toMatchObject({ kind: 'busy' });
    await service.getCredentials();
    await service.checkCredentialCommand(unknown.commandId);
    await expect(service.setCredentials({ openRouterApiKey: 'second-secret' })).rejects.toMatchObject({ kind: 'busy' });
    await expect(service.deleteCredentials()).rejects.toMatchObject({ kind: 'busy' });
    expect(fetch).toHaveBeenCalledTimes(4);

    const finished = service.checkCredentialCommand(unknown.commandId);
    await expect(finished).resolves.toMatchObject({ status: 'finished', metadata: metadata({ configured: true, generation: 2 }) });
    expect(fetch).toHaveBeenCalledTimes(6);
    await service.setCredentials({ speechSubscriptionKey: 'next-secret' });
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(JSON.parse(String(fetch.mock.calls[6][1].body))).toMatchObject({ expectedGenerations: { speech: 2 } });
    service.dispose();
  });

  it('fences metadata-free command status when the cached generation changes during its body read', async () => {
    const pendingStatus = deferred<unknown>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata({ configured: false, generation: 1 })))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => pendingStatus.promise })
      .mockResolvedValueOnce(response(metadata({ configured: true, generation: 2 })));
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    await service.getCredentials();
    const check = service.checkCredentialCommand('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await service.getCredentials();
    pendingStatus.resolve({ status: 'claimed' });
    await expect(check).rejects.toMatchObject({ kind: 'generation' });
    expect(service.currentSpeechCredentialGeneration()).toBe(2);
    service.dispose();
  });

  it('uses fixed errors for malformed or rejected metadata and ignores server error text', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ error: 'secret-key', details: 'server trace' }, 503))
      .mockResolvedValueOnce(response({ workspaceId: 'workspace-1', privacyEpoch: 4, credentials: { speech: { configured: true, generation: -1 }, openrouter: { configured: false, generation: 0 } } }));
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    const rejected = await service.getCredentials().catch((error: unknown) => error);
    expect(rejected).toMatchObject({ kind: 'http', status: 503 });
    expect((rejected as Error).message).not.toContain('secret-key');
    await expect(service.getCredentials()).rejects.toMatchObject({ kind: 'malformed' });
    service.dispose();
  });

  it('aborts owned metadata reads on disposal and rejects later calls locally', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    const read = service.getCredentials().catch((error: unknown) => error);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    service.dispose();
    expect(signal.aborted).toBe(true);
    pending.resolve(response(metadata()));
    await expect(read).resolves.toMatchObject({ kind: 'disposed' });
    await expect(service.getCredentials()).rejects.toMatchObject({ kind: 'disposed' });
  });

  it('bounds a deferred JSON body with a 30-second timeout and ignores its late result', async () => {
    vi.useFakeTimers();
    const pendingBody = deferred<unknown>();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => pendingBody.promise });
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    const read = service.getCredentials();
    const result = expect(read).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(CREDENTIAL_REQUEST_TIMEOUT_MS);
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    pendingBody.resolve(metadata({ configured: true, generation: 5 }));
    await Promise.resolve();
    expect(service.currentSpeechCredentialGeneration()).toBe(0);
    service.dispose();
  });

  it('fences deferred JSON and all status access after disposal', async () => {
    const pendingBody = deferred<unknown>();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => pendingBody.promise });
    vi.stubGlobal('fetch', fetch);
    const service = createWebProviderCredentialService(session, () => 'csrf');
    const read = service.getCredentials().catch((error: unknown) => error);
    service.dispose();
    await expect(read).resolves.toMatchObject({ kind: 'disposed' });
    pendingBody.resolve(metadata({ configured: true, generation: 5 }));
    await Promise.resolve();
    expect(() => service.currentSpeechCredentialGeneration()).toThrow('no longer available');
    expect(() => service.currentProviderCredentialGeneration('openrouter')).toThrow('no longer available');
    expect(() => service.assertSpeechCredentialGeneration(0)).toThrow('no longer available');
    expect(() => service.assertProviderCredentialGeneration('speech', 0)).toThrow('no longer available');

    const pendingStatus = deferred<unknown>();
    const commandFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => pendingStatus.promise });
    vi.stubGlobal('fetch', commandFetch);
    const commandService = createWebProviderCredentialService(session, () => 'csrf');
    const check = commandService.checkCredentialCommand('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').catch((error: unknown) => error);
    commandService.dispose();
    await expect(check).resolves.toMatchObject({ kind: 'disposed' });
    pendingStatus.resolve({ status: 'claimed' });
    await Promise.resolve();
  });
});
