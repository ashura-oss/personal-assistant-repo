/** One provider HTTP exchange, including complete response consumption and native cancellation. */
import * as Crypto from 'expo-crypto';

export type ProviderRequestInput = RequestInfo | URL;

export type ProviderPurpose =
  | 'connector'
  | 'oauth'
  | 'azure_ai'
  | 'azure_speech'
  | 'openrouter_batch'
  | 'openrouter_speech';

export type ProviderResponseLifetime = <T>(
  input: ProviderRequestInput,
  init: RequestInit,
  consumeResponse: (response: Response) => Promise<T>,
  onCancelPending?: (retryCancel: ProviderCancellationRetry) => void,
  beforeStart?: () => void,
) => Promise<T>;

/** Retry handle for the exact native request whose cancellation is still pending. */
export type ProviderCancellationRetry = (() => Promise<void>) & {
  /** Fires once when this request lifetime actually settles, whether by retry or normal completion. */
  subscribeSettled?: (listener: () => void) => () => void;
};

export interface ProviderCleanupItem {
  readonly id: string;
  readonly purpose: ProviderPurpose;
}

export interface ProviderCleanupRegistry {
  readonly getPending: () => readonly ProviderCleanupItem[];
  readonly subscribe: (listener: (pending: readonly ProviderCleanupItem[]) => void) => () => void;
  readonly retryCancellation: (id: string) => Promise<void>;
}

type CleanupEntry = {
  readonly id: string;
  readonly purpose: ProviderPurpose;
  readonly retryRaw: () => Promise<void>;
  readonly settledListeners: Set<() => void>;
  retrying?: Promise<void>;
};

type CleanupRegistryState = {
  readonly entries: Map<string, CleanupEntry>;
  readonly listeners: Set<(pending: readonly ProviderCleanupItem[]) => void>;
};

const registryStates = new WeakMap<ProviderCleanupRegistry, CleanupRegistryState>();

function opaqueId(): string {
  return Crypto.randomUUID();
}

export function createProviderCleanupRegistry(): ProviderCleanupRegistry {
  const entries = new Map<string, CleanupEntry>();
  const listeners = new Set<(pending: readonly ProviderCleanupItem[]) => void>();
  const snapshot = (): readonly ProviderCleanupItem[] => Object.freeze([...entries.values()].map(({ id, purpose }) => Object.freeze({ id, purpose })));
  const api: ProviderCleanupRegistry = Object.freeze({
    getPending: snapshot,
    subscribe(listener: (pending: readonly ProviderCleanupItem[]) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retryCancellation(id: string) {
      const entry = entries.get(id);
      if (!entry) return Promise.reject(new Error('Provider cancellation is no longer pending.'));
      if (entry.retrying) return entry.retrying;
      const current = Promise.resolve().then(() => {
        if (entries.get(id) !== entry) throw new Error('Provider cancellation is no longer pending.');
        return entry.retryRaw();
      }).finally(() => { if (entry.retrying === current) entry.retrying = undefined; });
      entry.retrying = current;
      return current;
    },
  });
  registryStates.set(api, { entries, listeners });
  return api;
}

function trackLifetime(registry: ProviderCleanupRegistry, purpose: ProviderPurpose, retryRaw: () => Promise<void>) {
  const state = registryStates.get(registry);
  if (!state) throw new Error('Provider cleanup registry is not owned by this module.');
  let id = opaqueId();
  while (state.entries.has(id)) id = opaqueId();
  const entry: CleanupEntry = { id, purpose, retryRaw, settledListeners: new Set() };
  state.entries.set(id, entry);
  const pending = Object.freeze([...state.entries.values()].map(({ id: itemId, purpose: itemPurpose }) => Object.freeze({ id: itemId, purpose: itemPurpose })));
  for (const listener of [...state.listeners]) { try { listener(pending); } catch { /* Observers cannot affect provider cleanup. */ } }
  const retry = (() => {
      if (state.entries.get(id) !== entry) return Promise.reject(new Error('Provider cancellation is no longer pending.'));
      if (entry.retrying) return entry.retrying;
      const current = Promise.resolve().then(() => {
        if (state.entries.get(id) !== entry) throw new Error('Provider cancellation is no longer pending.');
        return entry.retryRaw();
      }).finally(() => { if (entry.retrying === current) entry.retrying = undefined; });
      entry.retrying = current;
      return current;
  }) as ProviderCancellationRetry;
  Object.defineProperty(retry, 'subscribeSettled', { value: (listener: () => void) => {
    if (state.entries.get(id) !== entry) {
      try { listener(); } catch { /* A stale domain observer cannot change request settlement. */ }
      return () => undefined;
    }
    entry.settledListeners.add(listener);
    return () => entry.settledListeners.delete(listener);
  }, enumerable: false });
  Object.freeze(retry);
  return Object.freeze({
    id,
    retry,
    settle: () => {
      if (state.entries.get(id) !== entry) return;
      state.entries.delete(id);
      for (const listener of [...entry.settledListeners]) { try { listener(); } catch { /* Domain cleanup views cannot affect request settlement. */ } }
      entry.settledListeners.clear();
      const current = Object.freeze([...state.entries.values()].map(({ id: itemId, purpose: itemPurpose }) => Object.freeze({ id: itemId, purpose: itemPurpose })));
      for (const listener of [...state.listeners]) { try { listener(current); } catch { /* Observers cannot affect provider cleanup. */ } }
    },
  });
}

/** The process-wide registry is shared by foreground, background, and later UI bindings. */
export const providerCleanupRegistry = createProviderCleanupRegistry();

/**
 * Adds safe process-level visibility to a platform lifetime without taking ownership itself.
 * A cancellation retry is always routed back through the exact active registry entry.
 */
export function createTrackedProviderResponseLifetime(
  raw: ProviderResponseLifetime,
  purpose: ProviderPurpose,
  registry: ProviderCleanupRegistry = providerCleanupRegistry,
): ProviderResponseLifetime {
  return async (input, init, consumeResponse, onCancelPending, beforeStart) => {
    let tracked: ReturnType<typeof trackLifetime> | undefined;
    try {
      return await raw(input, init, consumeResponse, (retryRaw) => {
        if (tracked) return;
        tracked = trackLifetime(registry, purpose, retryRaw);
        try { onCancelPending?.(tracked.retry); } catch { /* Domain notification cannot alter transport ownership. */ }
      }, beforeStart);
    } finally {
      tracked?.settle();
    }
  };
}
