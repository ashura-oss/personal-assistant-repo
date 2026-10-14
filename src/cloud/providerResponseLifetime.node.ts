/** Per-workspace Node ownership for a provider request and its response body. */
import type {
  ProviderCancellationRetry,
  ProviderCleanupItem,
  ProviderPurpose,
  ProviderRequestInput,
  ProviderResponseLifetime,
} from '../services/providerResponseLifetime.shared';

export type NodeProviderFetch = (input: ProviderRequestInput, init: RequestInit) => Promise<Response>;

export interface NodeProviderCleanupStatus extends ProviderCleanupItem {
  readonly state: 'active' | 'cancelling' | 'cleanup_failed';
}

export interface NodeProviderResponseLifetimeOwner {
  readonly withResponseLifetimeFor: (purpose: ProviderPurpose) => ProviderResponseLifetime;
  readonly stopAdmission: () => void;
  readonly drain: () => Promise<void>;
  readonly retryCleanup: (id: string) => Promise<void>;
  readonly getPending: () => readonly NodeProviderCleanupStatus[];
  readonly subscribe: (listener: (pending: readonly NodeProviderCleanupStatus[]) => void) => () => void;
}

type Entry = {
  readonly id: string;
  readonly purpose: ProviderPurpose;
  readonly abort: AbortController;
  readonly listeners: Set<() => void>;
  readonly onCancelPending?: (retryCancel: ProviderCancellationRetry) => void;
  retry?: ProviderCancellationRetry;
  retrying?: Promise<void>;
  run?: Promise<unknown>;
  response?: Response;
  cancelBody?: (reason?: unknown) => Promise<void>;
  bodyDone?: Promise<void>;
  bodyDoneResolve?: () => void;
  bodySettled: boolean;
  consumerSettled: boolean;
  requestSettled: boolean;
  cleanupRunning?: Promise<void>;
  cleanupFailed: boolean;
  cleanupFailureSticky: boolean;
  cleanupError?: unknown;
  completion?: Promise<void>;
  completionResolve?: () => void;
  completionReject?: (error: unknown) => void;
  cancelNotified: boolean;
  signalLinks: (readonly [AbortSignal, () => void])[];
};

export interface NodeProviderResponseLifetimeOptions {
  readonly fetcher: NodeProviderFetch;
  readonly createId: () => string;
}

function makeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeObservedCompletion() {
  const deferred = makeDeferred<void>();
  void deferred.promise.catch(() => undefined);
  return deferred;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object' && value !== null && typeof (value as AbortSignal).addEventListener === 'function';
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function linkedSignals(input: ProviderRequestInput, init: RequestInit): AbortSignal[] {
  const signals: AbortSignal[] = [];
  if (isAbortSignal(init.signal)) signals.push(init.signal);
  if (typeof Request !== 'undefined' && input instanceof Request && isAbortSignal(input.signal) && !signals.includes(input.signal)) {
    signals.push(input.signal);
  }
  return signals;
}

/**
 * Owns request admission through complete stream consumption/cancellation. IDs and fetch are
 * injected so Node composition never imports Expo or shares a process-global owner.
 */
export function createNodeProviderResponseLifetimeOwner(
  options: NodeProviderResponseLifetimeOptions,
): NodeProviderResponseLifetimeOwner {
  if (typeof options.fetcher !== 'function' || typeof options.createId !== 'function') {
    throw new Error('provider_lifetime_configuration_invalid');
  }
  const entries = new Map<string, Entry>();
  const listeners = new Set<(pending: readonly NodeProviderCleanupStatus[]) => void>();
  const lifetimes = new Map<ProviderPurpose, ProviderResponseLifetime>();
  let accepting = true;
  let drainPromise: Promise<void> | undefined;

  const snapshot = (): readonly NodeProviderCleanupStatus[] => Object.freeze([...entries.values()].map((entry) => Object.freeze({
    id: entry.id,
    purpose: entry.purpose,
    state: entry.cleanupFailed ? 'cleanup_failed' : entry.cancelNotified ? 'cancelling' : 'active',
  })));
  const notify = () => {
    const pending = snapshot();
    for (const listener of [...listeners]) { try { listener(pending); } catch { /* Observers cannot affect ownership. */ } }
  };

  const removeIfSettled = (entry: Entry) => {
    if (!entry.requestSettled || !entry.consumerSettled || !entry.bodySettled || entry.cleanupRunning || entry.cleanupFailed) return;
    if (entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    for (const listener of [...entry.listeners]) { try { listener(); } catch { /* Observers cannot affect settlement. */ } }
    entry.listeners.clear();
    for (const [signal, callback] of entry.signalLinks) signal.removeEventListener('abort', callback);
    entry.signalLinks = [];
    notify();
    entry.completionResolve?.();
  };

  const notifyCancellationPending = (entry: Entry) => {
    if (entry.cancelNotified) return;
    entry.cancelNotified = true;
    const retry = (() => {
      if (entries.get(entry.id) !== entry) return Promise.reject(new Error('provider_cleanup_not_pending'));
      return retryEntry(entry);
    }) as ProviderCancellationRetry;
    Object.defineProperty(retry, 'subscribeSettled', {
      enumerable: false,
      value: (listener: () => void) => {
        if (entries.get(entry.id) !== entry) { try { listener(); } catch { /* ignored */ } return () => undefined; }
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
    });
    entry.retry = Object.freeze(retry);
    try { entry.onCancelPending?.(entry.retry); } catch { /* Domain notification cannot affect request ownership. */ }
  };

  const runCleanup = (entry: Entry, reason?: unknown): Promise<void> => {
    if (entry.cleanupRunning) return entry.cleanupRunning;
    const current = (async () => {
      entry.abort.abort(reason);
      try {
        if (entry.cancelBody) await entry.cancelBody(reason);
        if (entry.cleanupFailureSticky) throw entry.cleanupError ?? new Error('provider_cleanup_unconfirmed');
        entry.cleanupFailed = false;
        entry.cleanupError = undefined;
        if (!entry.bodySettled && !entry.response) {
          // No Response exists yet; the fetch promise remains owned until it settles.
        }
      } catch (error) {
        entry.cleanupFailed = true;
        entry.cleanupFailureSticky = true;
        entry.cleanupError = error;
        notifyCancellationPending(entry);
        entry.completionReject?.(error);
        throw error;
      }
    })();
    entry.cleanupRunning = current;
    current.then(
      () => { if (entry.cleanupRunning === current) entry.cleanupRunning = undefined; removeIfSettled(entry); },
      () => { if (entry.cleanupRunning === current) entry.cleanupRunning = undefined; },
    );
    return current;
  };

  function retryEntry(entry: Entry): Promise<void> {
    const id = entry.id;
    if (entries.get(id) !== entry || !entry.cancelNotified) return Promise.reject(new Error('provider_cleanup_not_pending'));
    if (entry.retrying) return entry.retrying;
    const current = Promise.resolve().then(() => {
      if (entries.get(id) !== entry || !entry.cancelNotified) throw new Error('provider_cleanup_not_pending');
      if (entry.cleanupFailed) {
        const next = makeObservedCompletion();
        entry.completion = next.promise;
        entry.completionResolve = next.resolve;
        entry.completionReject = next.reject;
      }
      return runCleanup(entry, new Error('provider_cleanup_retry'));
    }).finally(() => { if (entry.retrying === current) entry.retrying = undefined; });
    entry.retrying = current;
    return current;
  }

  function retryCleanup(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!entry) return Promise.reject(new Error('provider_cleanup_not_pending'));
    return retryEntry(entry);
  }

  const attachObservedBody = (entry: Entry, response: Response): Response => {
    entry.response = response;
    if (!response.body) {
      entry.bodySettled = true;
      return response;
    }
    const reader = response.body.getReader();
    const terminal = makeDeferred<void>();
    entry.bodyDone = terminal.promise;
    entry.bodyDoneResolve = () => { if (!entry.bodySettled) { entry.bodySettled = true; terminal.resolve(); removeIfSettled(entry); } };
    entry.cancelBody = async (reason?: unknown) => {
      try {
        await reader.cancel(reason);
        entry.bodyDoneResolve?.();
      } catch (error) {
        entry.cleanupFailed = true;
        entry.cleanupError = error;
        throw error;
      }
    };
    const observedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            entry.bodyDoneResolve?.();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          entry.bodyDoneResolve?.();
          controller.error(error);
        }
      },
      async cancel(reason) {
        await entry.cancelBody?.(reason);
      },
    });
    const observed = new Response(observedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Preserve response metadata used by fetch consumers while methods still operate on the observed stream.
    for (const key of ['url', 'redirected', 'type'] as const) {
      try { Object.defineProperty(observed, key, { configurable: true, value: response[key] }); } catch { /* Runtime may make these properties non-configurable. */ }
    }
    return observed;
  };

  const withResponseLifetime = async <T>(purpose: ProviderPurpose, input: ProviderRequestInput, init: RequestInit, consumeResponse: (response: Response) => Promise<T>, onCancelPending?: (retryCancel: ProviderCancellationRetry) => void, beforeStart?: () => void): Promise<T> => {
    if (!accepting) throw new Error('provider_lifetime_admission_closed');
    const abort = new AbortController();
    const completion = makeObservedCompletion();
    let id = options.createId();
    if (!isUuidV4(id)) throw new Error('provider_lifetime_id_invalid');
    let attempts = 0;
    while (entries.has(id)) {
      if (++attempts > 8) throw new Error('provider_lifetime_id_collision');
      id = options.createId();
      if (!isUuidV4(id)) throw new Error('provider_lifetime_id_invalid');
    }
    const entry: Entry = {
      id, purpose, abort, listeners: new Set(), bodySettled: false,
      consumerSettled: false, requestSettled: false, cleanupFailed: false,
      cancelNotified: false, signalLinks: [], completion: completion.promise, cleanupFailureSticky: false,
      completionResolve: completion.resolve, completionReject: completion.reject,
      onCancelPending,
    };
    entries.set(id, entry);
    notify();

    const sources = linkedSignals(input, init);
    for (const signal of sources) {
      const callback = () => {
        notifyCancellationPending(entry);
        void runCleanup(entry, signal.reason).catch(() => undefined);
      };
      entry.signalLinks.push([signal, callback]);
      if (signal.aborted) callback();
      else signal.addEventListener('abort', callback, { once: true });
    }

    const run = (async () => {
      let response: Response | undefined;
      try {
        if (!accepting) throw new Error('provider_lifetime_admission_closed');
        beforeStart?.();
        if (!accepting) throw new Error('provider_lifetime_admission_closed');
        if (abort.signal.aborted) throw abort.signal.reason ?? new Error('provider_lifetime_aborted');
        response = await options.fetcher(input, { ...init, signal: abort.signal });
        entry.requestSettled = true;
        const observed = attachObservedBody(entry, response);
        if (abort.signal.aborted) {
          if (!entry.bodySettled) await runCleanup(entry, abort.signal.reason);
          entry.consumerSettled = true;
          if (entry.bodyDone) await entry.bodyDone;
          removeIfSettled(entry);
          throw abort.signal.reason ?? new Error('provider_lifetime_aborted');
        }
        try {
          const result = await consumeResponse(observed);
          entry.consumerSettled = true;
          if (!entry.bodySettled) {
            try { await runCleanup(entry, new Error('provider_response_body_unconsumed')); }
            catch (error) { entry.completionReject?.(error); throw error; }
          }
          if (entry.bodyDone) await entry.bodyDone;
          removeIfSettled(entry);
          return result;
        } catch (error) {
          entry.consumerSettled = true;
          if (!entry.bodySettled && !entry.cleanupFailed) {
            try { await runCleanup(entry, error); }
            catch (cleanupError) { entry.completionReject?.(cleanupError); /* Retained for explicit cleanup retry. */ }
          }
          if (entry.bodyDone && (entry.bodySettled || !entry.cleanupFailed)) {
            try { await entry.bodyDone; } catch { /* Stream error is already represented by consumer result. */ }
          }
          removeIfSettled(entry);
          throw error;
        }
      } catch (error) {
        if (!response) {
          entry.requestSettled = true;
          entry.consumerSettled = true;
          entry.bodySettled = true;
          if (entry.cleanupFailed) {
            entry.completionReject?.(entry.cleanupError);
          } else {
            removeIfSettled(entry);
          }
        } else {
          entry.requestSettled = true;
          entry.consumerSettled = true;
          if (!entry.bodySettled) {
            if (entry.cancelBody && !entry.cleanupFailed) {
              try { await runCleanup(entry, error); }
              catch (cleanupError) { entry.completionReject?.(cleanupError); }
            } else {
              entry.cleanupFailed = true;
              entry.cleanupFailureSticky = true;
              entry.cleanupError = error;
              notifyCancellationPending(entry);
              entry.completionReject?.(error);
            }
          }
          removeIfSettled(entry);
        }
        throw error;
      }
    })();
    entry.run = run;
    void run.then(
      () => { if (entries.get(id) === entry) removeIfSettled(entry); },
      (error) => {
        if (entries.get(id) === entry && entry.cleanupFailed) entry.completionReject?.(entry.cleanupError ?? error);
      },
    );
    return run;
  };

  const stopAdmission = () => {
    if (!accepting) return;
    accepting = false;
    for (const entry of [...entries.values()]) {
      if (entry.cancelNotified) continue;
      notifyCancellationPending(entry);
      void runCleanup(entry, new Error('provider_lifetime_owner_stopping')).catch(() => undefined);
    }
  };

  const drain = (): Promise<void> => {
    stopAdmission();
    if (drainPromise) return drainPromise;
    const current = (async () => {
      const pending = [...entries.values()];
      await Promise.all(pending.map(async (entry) => {
        if (entry.completion) await entry.completion;
        else if (entry.run) await entry.run;
      }));
      if (entries.size) throw new Error('provider_lifetime_cleanup_pending');
    })();
    drainPromise = current;
    current.catch(() => { if (drainPromise === current) drainPromise = undefined; });
    return current;
  };

  const withResponseLifetimeFor = (purpose: ProviderPurpose): ProviderResponseLifetime => {
    if (!['connector', 'oauth', 'azure_ai', 'azure_speech', 'openrouter_batch', 'openrouter_speech'].includes(purpose)) {
      throw new Error('provider_lifetime_purpose_invalid');
    }
    const existing = lifetimes.get(purpose);
    if (existing) return existing;
    const lifetime: ProviderResponseLifetime = (input, init, consumeResponse, onCancelPending, beforeStart) =>
      withResponseLifetime(purpose, input, init, consumeResponse, onCancelPending, beforeStart);
    lifetimes.set(purpose, lifetime);
    return lifetime;
  };

  return Object.freeze({
    withResponseLifetimeFor,
    stopAdmission,
    drain,
    retryCleanup,
    getPending: snapshot,
    subscribe(listener: (pending: readonly NodeProviderCleanupStatus[]) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
