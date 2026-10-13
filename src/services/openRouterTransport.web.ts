import type { OpenRouterBatchClientDependencies } from './openRouter';

export const openRouterTransportFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export const openRouterTransportWithResponseLifetime: NonNullable<OpenRouterBatchClientDependencies['withResponseLifetime']> =
  (input, init, consumeResponse, _onCancelPending, beforeStart) => {
    beforeStart?.();
    return globalThis.fetch(input, init).then(consumeResponse);
  };
