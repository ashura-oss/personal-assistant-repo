import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFetchLifetime } from '../node_modules/expo/src/winter/fetch/fetch';

const native = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  cancelAndWait: vi.fn(),
  starts: 0,
  cancels: 0,
  cancelAndWaits: 0,
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
      cancelAndWait() { native.cancelAndWaits += 1; return native.cancelAndWait(); }
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
    vi.useRealTimers();
    native.start.mockReset();
    native.cancel.mockReset();
    native.cancelAndWait.mockReset();
    native.starts = 0;
    native.cancels = 0;
    native.cancelAndWaits = 0;
  });

  it('holds after the cancel invocation returns until native task completion is acknowledged', async () => {
    const finishTerminal = deferred();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel.mockResolvedValue(undefined);
    native.cancelAndWait.mockImplementation(() => finishTerminal.promise);
    let settled = false;
    const request = withFetchLifetime('https://openrouter.example/batches', {}, async () => 'parsed').finally(() => { settled = true; });
    await vi.waitFor(() => expect(native.cancelAndWaits).toBe(1));
    expect(native.starts).toBe(1);
    expect(native.cancels).toBe(0);
    expect(settled).toBe(false);
    finishTerminal.resolve();
    await expect(request).resolves.toBe('parsed');
    expect(settled).toBe(true);
  });

  it('keeps ownership pending after cancel rejection until an explicit retry is acknowledged', async () => {
    const finishRetryTerminal = deferred();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel.mockResolvedValue(undefined);
    native.cancelAndWait
      .mockImplementationOnce(async () => { throw new Error('private native cancellation failure'); })
      .mockImplementationOnce(() => finishRetryTerminal.promise);
    let retryCancel: (() => Promise<void>) | undefined;
    let settled = false;
    const request = withFetchLifetime('https://openrouter.example/batches', {}, async () => {
      throw new Error('consumer failed');
    }, (retry) => { retryCancel = retry; }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(retryCancel).toBeTypeOf('function'));
    expect(settled).toBe(false);
    expect(native.cancelAndWaits).toBe(1);
    const retry = retryCancel!();
    await vi.waitFor(() => expect(native.cancelAndWaits).toBe(2));
    expect(settled).toBe(false);
    finishRetryTerminal.resolve();
    await retry;
    await expect(request).rejects.toThrow('consumer failed');
    expect(settled).toBe(true);
  });

  it('does not start or cancel a request when the signal is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel.mockResolvedValue(undefined);
    native.cancelAndWait.mockResolvedValue(undefined);
    await expect(withFetchLifetime('https://openrouter.example/batches', { signal: abort.signal }, async () => 'unused')).rejects.toThrow(/aborted/i);
    expect(native.starts).toBe(0);
    expect(native.cancels).toBe(0);
  });

  it('runs the final credential fence after asynchronous body normalization and before native start', async () => {
    const normalization = deferred<ArrayBuffer>();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel.mockResolvedValue(undefined);
    native.cancelAndWait.mockResolvedValue(undefined);
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
    const cancelTerminal = deferred();
    native.start.mockRejectedValue(new Error('native start failed'));
    native.cancel.mockResolvedValue(undefined);
    native.cancelAndWait.mockImplementation(() => cancelTerminal.promise);
    let settled = false;
    const request = withFetchLifetime('https://openrouter.example/batches', {}, async () => 'unused').finally(() => { settled = true; });
    await vi.waitFor(() => expect(native.cancelAndWaits).toBe(1));
    expect(settled).toBe(false);
    cancelTerminal.resolve();
    await expect(request).rejects.toThrow('native start failed');
    expect(settled).toBe(true);
  });

  it('keeps ownership through abort while headers are pending and through the consumer read', async () => {
    const cancelTerminal = deferred();
    const startHeaders = deferred<unknown>();
    native.start.mockImplementation(() => startHeaders.promise);
    native.cancel.mockResolvedValue(undefined);
    native.cancelAndWait.mockImplementation(() => cancelTerminal.promise.then(() => { startHeaders.reject(new Error('native abort settled start')); }));
    const headersAbort = new AbortController();
    let headersSettled = false;
    const headersRequest = withFetchLifetime('https://openrouter.example/batches', { signal: headersAbort.signal }, async () => 'unused').finally(() => { headersSettled = true; });
    await vi.waitFor(() => expect(native.starts).toBe(1));
    headersAbort.abort();
    await vi.waitFor(() => expect(native.cancelAndWaits).toBe(1));
    expect(headersSettled).toBe(false);
    cancelTerminal.resolve();
    await expect(headersRequest).rejects.toThrow();
    expect(headersSettled).toBe(true);

    const bodyAbort = new AbortController();
    const bodyRead = deferred<string>();
    native.start.mockResolvedValue({});
    const bodyTerminal = deferred();
    native.cancelAndWait.mockImplementation(() => bodyTerminal.promise);
    let bodySettled = false;
    const bodyRequest = withFetchLifetime('https://openrouter.example/batches', { signal: bodyAbort.signal }, () => bodyRead.promise).finally(() => { bodySettled = true; });
    await vi.waitFor(() => expect(native.starts).toBe(2));
    bodyAbort.abort();
    await vi.waitFor(() => expect(native.cancelAndWaits).toBe(2));
    expect(bodySettled).toBe(false);
    bodyRead.resolve('read settled');
    await Promise.resolve();
    expect(bodySettled).toBe(false);
    bodyTerminal.resolve();
    await expect(bodyRequest).resolves.toBe('read settled');
    expect(bodySettled).toBe(true);
  });

  it('deduplicates explicit cancel retries and preserves ownership when the observer throws', async () => {
    const retryTerminal = deferred();
    native.start.mockImplementation(async (response: unknown) => response);
    native.cancel.mockResolvedValue(undefined);
    native.cancelAndWait
      .mockRejectedValueOnce(new Error('first cancel failed'))
      .mockImplementationOnce(() => retryTerminal.promise);
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
    await vi.waitFor(() => expect(native.cancelAndWaits).toBe(2));
    expect(first).toBe(second);
    retryTerminal.resolve();
    await Promise.all([first, second]);
    await expect(request).resolves.toBe('done');
    expect(settled).toBe(true);
  });

  it('reports a long terminal wait once without releasing ownership or treating retry as completion', async () => {
    vi.useFakeTimers();
    const terminal = deferred();
    native.start.mockResolvedValue({});
    native.cancel.mockResolvedValue(undefined);
    native.cancelAndWait.mockImplementation(() => terminal.promise);
    let retryCancel: (() => Promise<void>) | undefined;
    let settled = false;
    const request = withFetchLifetime('https://openrouter.example/batches', {}, async () => 'parsed', (retry) => {
      retryCancel = retry;
    }).finally(() => { settled = true; });

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(retryCancel).toBeTypeOf('function');
    expect(settled).toBe(false);
    expect(native.cancelAndWaits).toBe(1);
    const retry = retryCancel!();
    expect(native.cancelAndWaits).toBe(1);
    expect(settled).toBe(false);

    terminal.resolve();
    await retry;
    await expect(request).resolves.toBe('parsed');
    expect(settled).toBe(true);
  });
});
