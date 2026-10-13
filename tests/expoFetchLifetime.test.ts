import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFetchLifetime } from '../node_modules/expo/src/winter/fetch/fetch';

const native = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  starts: 0,
  cancels: 0,
}));

vi.mock('../node_modules/expo/src/winter/fetch/ExpoFetchModule', () => ({
  ExpoFetchModule: {
    NativeResponse: class {
      addListener() { return { remove() {} }; }
    },
    NativeRequest: class {
      constructor(private readonly response: unknown) {}
      start() { native.starts += 1; return native.start(this.response); }
      cancel() { native.cancels += 1; return native.cancel(); }
    },
  },
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe('Expo native fetch lifetime callback', () => {
  afterEach(() => {
    native.start.mockReset();
    native.cancel.mockReset();
    native.starts = 0;
    native.cancels = 0;
  });

  it('holds through consumer completion and awaited native cancellation acknowledgement', async () => {
    const finishCancel = deferred();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel.mockImplementation(() => finishCancel.promise);
    let settled = false;
    const request = withFetchLifetime('https://openrouter.example/batches', {}, async () => 'parsed').finally(() => { settled = true; });
    await vi.waitFor(() => expect(native.cancels).toBe(1));
    expect(native.starts).toBe(1);
    expect(settled).toBe(false);
    finishCancel.resolve();
    await expect(request).resolves.toBe('parsed');
    expect(settled).toBe(true);
  });

  it('keeps ownership pending after cancel rejection until an explicit retry is acknowledged', async () => {
    const finishRetry = deferred();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel
      .mockImplementationOnce(async () => { throw new Error('private native cancellation failure'); })
      .mockImplementationOnce(() => finishRetry.promise);
    let retryCancel: (() => Promise<void>) | undefined;
    let settled = false;
    const request = withFetchLifetime('https://openrouter.example/batches', {}, async () => {
      throw new Error('consumer failed');
    }, (retry) => { retryCancel = retry; }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(retryCancel).toBeTypeOf('function'));
    expect(settled).toBe(false);
    expect(native.cancels).toBe(1);
    const retry = retryCancel!();
    await vi.waitFor(() => expect(native.cancels).toBe(2));
    expect(settled).toBe(false);
    finishRetry.resolve();
    await retry;
    await expect(request).rejects.toThrow('consumer failed');
    expect(settled).toBe(true);
  });

  it('does not start or cancel a request when the signal is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel.mockResolvedValue(undefined);
    await expect(withFetchLifetime('https://openrouter.example/batches', { signal: abort.signal }, async () => 'unused')).rejects.toThrow(/aborted/i);
    expect(native.starts).toBe(0);
    expect(native.cancels).toBe(0);
  });

  it('runs the final credential fence after asynchronous body normalization and before native start', async () => {
    const normalization = deferred<ArrayBuffer>();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel.mockResolvedValue(undefined);
    let credentialGeneration = 1;
    const blobLike = { type: 'application/json', arrayBuffer: () => normalization.promise };
    const request = withFetchLifetime(
      'https://openrouter.example/batches',
      { method: 'POST', body: blobLike as never },
      async () => 'unused',
      undefined,
      () => {
        if (credentialGeneration !== 1) throw new Error('stale credential');
      }
    );

    await Promise.resolve();
    credentialGeneration = 2;
    normalization.resolve(new TextEncoder().encode('{}').buffer);
    await expect(request).rejects.toThrow('stale credential');
    expect(native.starts).toBe(0);
    expect(native.cancels).toBe(0);
  });

  it('drains an asynchronous native start rejection through cancellation acknowledgement', async () => {
    const cancelAck = deferred();
    native.start.mockRejectedValue(new Error('native start failed'));
    native.cancel.mockImplementation(() => cancelAck.promise);
    let settled = false;
    const request = withFetchLifetime('https://openrouter.example/batches', {}, async () => 'unused').finally(() => { settled = true; });
    await vi.waitFor(() => expect(native.cancels).toBe(1));
    expect(settled).toBe(false);
    cancelAck.resolve();
    await expect(request).rejects.toThrow('native start failed');
    expect(settled).toBe(true);
  });

  it('keeps ownership through abort while headers are pending and through the consumer read', async () => {
    const cancelAck = deferred();
    const startHeaders = deferred<unknown>();
    native.start.mockImplementation(() => startHeaders.promise);
    native.cancel.mockImplementation(() => cancelAck.promise.then(() => { startHeaders.reject(new Error('native abort settled start')); }));
    const headersAbort = new AbortController();
    let headersSettled = false;
    const headersRequest = withFetchLifetime('https://openrouter.example/batches', { signal: headersAbort.signal }, async () => 'unused').finally(() => { headersSettled = true; });
    await vi.waitFor(() => expect(native.starts).toBe(1));
    headersAbort.abort();
    await vi.waitFor(() => expect(native.cancels).toBe(1));
    expect(headersSettled).toBe(false);
    cancelAck.resolve();
    await expect(headersRequest).rejects.toThrow();
    expect(headersSettled).toBe(true);

    const bodyAbort = new AbortController();
    const bodyRead = deferred<string>();
    native.start.mockResolvedValue({});
    native.cancel.mockResolvedValue(undefined);
    let bodySettled = false;
    const bodyRequest = withFetchLifetime('https://openrouter.example/batches', { signal: bodyAbort.signal }, () => bodyRead.promise).finally(() => { bodySettled = true; });
    await vi.waitFor(() => expect(native.starts).toBe(2));
    bodyAbort.abort();
    await vi.waitFor(() => expect(native.cancels).toBe(2));
    expect(bodySettled).toBe(false);
    bodyRead.resolve('read settled');
    await expect(bodyRequest).resolves.toBe('read settled');
    expect(bodySettled).toBe(true);
  });

  it('deduplicates explicit cancel retries and preserves ownership when the observer throws', async () => {
    const retryAck = deferred();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel
      .mockRejectedValueOnce(new Error('first cancel failed'))
      .mockImplementationOnce(() => retryAck.promise);
    let retryCancel: (() => Promise<void>) | undefined;
    let settled = false;
    const request = withFetchLifetime('https://openrouter.example/batches', {}, async () => 'done', (retry) => {
      retryCancel = retry;
      throw new Error('observer failed');
    }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(retryCancel).toBeTypeOf('function'));
    expect(settled).toBe(false);
    const first = retryCancel!();
    const second = retryCancel!();
    await vi.waitFor(() => expect(native.cancels).toBe(2));
    expect(first).toBe(second);
    retryAck.resolve();
    await Promise.all([first, second]);
    await expect(request).resolves.toBe('done');
    expect(settled).toBe(true);
  });
});
