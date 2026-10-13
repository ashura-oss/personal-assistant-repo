import type { OpenRouterBatchClientDependencies } from './openRouter';

/** Default test/runtime fallback; platform builds resolve the native or web implementation. */
export const openRouterTransportFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export const openRouterTransportWithResponseLifetime: NonNullable<OpenRouterBatchClientDependencies['withResponseLifetime']> =
  async (input, init, consumeResponse, _onCancelPending, beforeStart) => {
    beforeStart?.();
    return consumeResponse(await openRouterTransportFetch(input, init));
  };
