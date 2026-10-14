import type { ProviderResponseLifetime } from './providerResponseLifetime';

export const providerTransportFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export const providerTransportWithResponseLifetime: ProviderResponseLifetime =
  async (input, init, consumeResponse, _onCancelPending, beforeStart) => {
    beforeStart?.();
    return consumeResponse(await globalThis.fetch(input, init));
  };
