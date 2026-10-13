import { describe, expect, it, vi } from 'vitest';
import { buildOpenRouterSpeechWireRequest } from '../src/services/openRouterSpeechWire';
import { OpenRouterSpeechClient, OpenRouterSpeechError, type OpenRouterSpeechClientDependencies } from '../src/services/openRouterSpeech';

const operationId = '00000000-0000-4000-8000-000000000001';
const request = buildOpenRouterSpeechWireRequest({ bytes: new Uint8Array([1, 2, 3, 4]), format: 'm4a' });

function dependencies(overrides: Partial<OpenRouterSpeechClientDependencies> = {}): OpenRouterSpeechClientDependencies {
  return {
    withRequestOwnership: async (actual) => actual(),
    readCredentialSnapshot: async () => ({ key: 'fictional-only', generation: 1 }),
    assertCredentialGeneration: () => undefined,
    assertBeforeStart: () => undefined,
    fetcher: async () => new Response(JSON.stringify({ text: 'recognized words', usage: { cost: 0.0004, input_tokens: 8, output_tokens: 3, total_tokens: 11 } }), { status: 200 }),
    ...overrides,
  };
}

function call(overrides: Partial<Parameters<OpenRouterSpeechClient['transcribe']>[0]> = {}) {
  return { operationId, request, onBeforeDispatch: async () => undefined, ...overrides };
}

describe('OpenRouterSpeechClient', () => {
  it('records intent before one owned fixed-profile POST and returns only parsed transcript and actual usage', async () => {
    const events: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      events.push('http');
      expect(String(url)).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer fictional-only', 'Content-Type': 'application/json' });
      return new Response(JSON.stringify({ text: '  exact transcript  ', usage: { cost: 0.0004, input_tokens: 8, output_tokens: 3, total_tokens: 11 } }), { status: 200 });
    });
    const client = new OpenRouterSpeechClient(dependencies({
      readCredentialSnapshot: async () => { events.push('credential'); return { key: 'fictional-only', generation: 1 }; },
      withRequestOwnership: async (actual) => { events.push('provider-owner'); return actual(); },
      assertBeforeStart: () => { events.push('final-fence'); },
      fetcher,
    }));

    const result = await client.transcribe(call({ onBeforeDispatch: async () => { events.push('durable-intent'); } }));
    expect(events).toEqual(['credential', 'durable-intent', 'provider-owner', 'final-fence', 'http']);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'transcript', transcript: 'exact transcript', usage: { costUsd: 0.0004, inputTokens: 8, outputTokens: 3, totalTokens: 11 } });
  });

  it('rejects a changed credential at the last synchronous fence without starting HTTP', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    let checks = 0;
    const client = new OpenRouterSpeechClient(dependencies({
      assertCredentialGeneration: () => { checks += 1; if (checks === 2) throw new Error('rotated'); },
      fetcher,
    }));
    await expect(client.transcribe(call())).rejects.toMatchObject({ code: 'stale_credential', dispatched: false });
    expect(checks).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('runs the per-call source fence after ownership is acquired and before HTTP starts', async () => {
    const events: string[] = [];
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const subject = new OpenRouterSpeechClient(dependencies({
      withRequestOwnership: async (actual) => { events.push('ownership'); return actual(); },
      fetcher,
    }));
    await expect(subject.transcribe(call({ assertBeforeStart: () => { events.push('source-fence'); throw new Error('changed'); } })))
      .rejects.toMatchObject({ code: 'pre_dispatch', dispatched: false });
    expect(events).toEqual(['ownership', 'source-fence']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not start HTTP when the durable pre-dispatch callback fails', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = new OpenRouterSpeechClient(dependencies({ fetcher }));
    await expect(client.transcribe(call({ onBeforeDispatch: async () => { throw new Error('private storage detail'); } })))
      .rejects.toMatchObject({ code: 'pre_dispatch', dispatched: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects altered endpoint, extra wire fields, and mismatched audio byte count before credential or persistence IO', async () => {
    const readCredentialSnapshot = vi.fn(async () => ({ key: 'fictional-only', generation: 1 }));
    const onBeforeDispatch = vi.fn(async () => undefined);
    const client = new OpenRouterSpeechClient(dependencies({ readCredentialSnapshot, fetcher: vi.fn() as unknown as typeof fetch }));
    const altered = { ...request, endpoint: 'https://example.invalid/' } as unknown as typeof request;
    await expect(client.transcribe(call({ request: altered, onBeforeDispatch }))).rejects.toMatchObject({ code: 'invalid_request' });
    const extra = { ...request, extra: true } as typeof request & { extra: boolean };
    await expect(client.transcribe(call({ request: extra, onBeforeDispatch }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.transcribe(call({ request: { ...request, audioBytes: request.audioBytes + 1 }, onBeforeDispatch })))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(readCredentialSnapshot).not.toHaveBeenCalled();
    expect(onBeforeDispatch).not.toHaveBeenCalled();
  });

  it('validates a multi-megabyte canonical base64 body without a backtracking regular expression', async () => {
    const large = buildOpenRouterSpeechWireRequest({ bytes: new Uint8Array(12 * 1024 * 1024), format: 'm4a' });
    const client = new OpenRouterSpeechClient(dependencies({ fetcher: vi.fn(async () => new Response('{}', { status: 200 })) }));
    await expect(client.transcribe(call({ request: large }))).resolves.toMatchObject({ kind: 'invalid', code: 'invalid_response' });
  });

  it('preserves actual usage for silent and invalid text results', async () => {
    const silent = new OpenRouterSpeechClient(dependencies({ fetcher: async () => new Response(JSON.stringify({ text: '  ', usage: { cost: 0, seconds: 0 } }), { status: 200 }) }));
    await expect(silent.transcribe(call())).resolves.toEqual({ kind: 'no_speech', usage: { seconds: 0, costUsd: 0 } });
    const invalid = new OpenRouterSpeechClient(dependencies({ fetcher: async () => new Response(JSON.stringify({ text: '\u0001', usage: { cost: 0.02 } }), { status: 200 }) }));
    await expect(invalid.transcribe(call())).resolves.toEqual({ kind: 'invalid', code: 'invalid_text', usage: { costUsd: 0.02 } });
  });

  it('drains an aborted timed-out request under provider ownership until the same cancel handle succeeds', async () => {
    let releaseOwner!: () => void;
    const ownerReleased = new Promise<void>((resolve) => { releaseOwner = resolve; });
    let notifyCancel!: () => void;
    const cancelNotified = new Promise<void>((resolve) => { notifyCancel = resolve; });
    let finishCancel!: () => void;
    const cancelAck = new Promise<void>((resolve) => { finishCancel = resolve; });
    let insideOwner = false;
    const fetcher = vi.fn();
    const retryCancel = vi.fn(async () => { finishCancel(); });
    const client = new OpenRouterSpeechClient(dependencies({
      deadlineMs: 15,
      withRequestOwnership: async (actual) => {
        insideOwner = true;
        try { return await actual(); }
        finally { insideOwner = false; releaseOwner(); }
      },
      withResponseLifetime: async <T>(
        _url: string,
        init: RequestInit,
        _consume: (response: Response) => Promise<T>,
        onCancelPending: ((retryCancel: () => Promise<void>) => void) | undefined,
        beforeStart: (() => void) | undefined,
      ) => {
        beforeStart?.();
        return await new Promise<T>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            onCancelPending?.(retryCancel);
            notifyCancel();
            void cancelAck.then(() => reject(new Error('native request cancelled')));
          }, { once: true });
        });
      },
      fetcher: fetcher as unknown as typeof fetch,
    }));

    let settled = false;
    const pending = client.transcribe(call()).finally(() => { settled = true; });
    await cancelNotified;
    expect(insideOwner).toBe(true);
    expect(settled).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    const retry = client.retryPendingCleanup(operationId);
    await retry;
    await expect(pending).rejects.toBeInstanceOf(OpenRouterSpeechError);
    await ownerReleased;
    expect(insideOwner).toBe(false);
    expect(settled).toBe(true);
    expect(retryCancel).toHaveBeenCalledOnce();
    expect((await client.retryPendingCleanup(operationId))).toBeUndefined();
  });

  it('uses fixed errors for HTTP failures and never returns provider error text', async () => {
    const client = new OpenRouterSpeechClient(dependencies({ fetcher: async () => new Response('PRIVATE_PROVIDER_ERROR', { status: 429 }) }));
    await expect(client.transcribe(call())).rejects.toMatchObject({ code: 'provider_rejected', dispatched: true, unknownCharge: true });
    await expect(client.transcribe(call())).rejects.not.toThrow('PRIVATE_PROVIDER_ERROR');
    const created = new OpenRouterSpeechClient(dependencies({ fetcher: async () => new Response(JSON.stringify({ text: 'not accepted as success' }), { status: 201 }) }));
    await expect(created.transcribe(call())).rejects.toMatchObject({ code: 'provider_rejected', dispatched: true });
  });

  it('bounds response bytes before JSON parsing and keeps the request owner until response lifetime cleanup', async () => {
    let ownerReleased = false;
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    let notifyCancel!: () => void;
    const cancelNotified = new Promise<void>((resolve) => { notifyCancel = resolve; });
    const client = new OpenRouterSpeechClient(dependencies({
      withRequestOwnership: async (actual) => { try { return await actual(); } finally { ownerReleased = true; } },
      withResponseLifetime: async (_url, _init, consume, onCancelPending, beforeStart) => {
        beforeStart?.();
        try { return await consume(new Response('x', { status: 200, headers: { 'Content-Length': String(1024 * 1024 + 1) } })); }
        catch (error) {
          onCancelPending?.(async () => { finishCleanup(); });
          notifyCancel();
          await cleanup;
          throw error;
        }
      },
    }));
    let settled = false;
    const pending = client.transcribe(call()).finally(() => { settled = true; });
    await cancelNotified;
    expect(ownerReleased).toBe(false);
    expect(settled).toBe(false);
    await client.retryPendingCleanup(operationId);
    await expect(pending).rejects.toMatchObject({ code: 'response_too_large', dispatched: true });
    expect(ownerReleased).toBe(true);
  });

  it('awaits plain-response body cancellation after an oversized Content-Length before releasing ownership', async () => {
    let cancelBody!: () => void;
    let bodyCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { bodyCancelStarted = resolve; });
    const cancelGate = new Promise<void>((resolve) => { cancelBody = resolve; });
    let ownerHeld = false;
    const response = {
      status: 200,
      ok: true,
      headers: { get: () => String(1024 * 1024 + 1) },
      body: { cancel: async () => { bodyCancelStarted(); await cancelGate; } },
    } as unknown as Response;
    const client = new OpenRouterSpeechClient(dependencies({
      withRequestOwnership: async (actual) => { ownerHeld = true; try { return await actual(); } finally { ownerHeld = false; } },
      fetcher: vi.fn(async () => response) as unknown as typeof fetch,
    }));
    let settled = false;
    const pending = client.transcribe(call()).finally(() => { settled = true; });
    await cancelStarted;
    expect(ownerHeld).toBe(true);
    expect(settled).toBe(false);
    cancelBody();
    await expect(pending).rejects.toMatchObject({ code: 'response_too_large', dispatched: true });
    expect(ownerHeld).toBe(false);
  });

  it('does not publish a late success after timeout and keeps its actual zero-cost receipt', async () => {
    let resolveResponse!: (response: Response) => void;
    let notifyAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { notifyAbort = resolve; });
    let held = false;
    const client = new OpenRouterSpeechClient(dependencies({
      deadlineMs: 12,
      withRequestOwnership: async (actual) => {
        held = true;
        try { return await actual(); } finally { held = false; }
      },
      fetcher: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve) => {
        resolveResponse = resolve;
        init?.signal?.addEventListener('abort', notifyAbort, { once: true });
      })) as unknown as typeof fetch,
    }));
    const pending = client.transcribe(call());
    await aborted;
    expect(held).toBe(true);
    resolveResponse(new Response(JSON.stringify({ text: 'late words must not publish', usage: { cost: 0, seconds: 1.25 } }), { status: 200 }));
    await expect(pending).rejects.toMatchObject({ code: 'timeout', dispatched: true, usage: { costUsd: 0, seconds: 1.25 } });
    expect(held).toBe(false);
  });
});
