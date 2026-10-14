import type { ProviderResponseLifetime } from './providerResponseLifetime';

/** Default test/runtime fallback; platform builds resolve the native or web implementation. */
export const providerTransportFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export const providerTransportWithResponseLifetime: ProviderResponseLifetime =
  async (input, init, consumeResponse, _onCancelPending, beforeStart) => {
    beforeStart?.();
    return consumeResponse(await providerTransportFetch(input, init));
  };
