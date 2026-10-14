// Native requests use Expo's additive lifetime callback so ownership spans native cancellation.
import { withFetchLifetime } from 'expo/src/winter/fetch/fetch';
import type { FetchRequestInit } from 'expo/src/winter/fetch/fetch.types';
import type { ProviderResponseLifetime } from './providerResponseLifetime';

export const providerTransportFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export const providerTransportWithResponseLifetime: ProviderResponseLifetime =
  (input, init, consumeResponse, onCancelPending, beforeStart) => withFetchLifetime(
    input as Parameters<typeof withFetchLifetime>[0],
    init as FetchRequestInit,
    (response) => consumeResponse(response as unknown as Response),
    onCancelPending,
    beforeStart,
  );
