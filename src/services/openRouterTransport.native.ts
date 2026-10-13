// Native requests use Expo's additive lifetime callback so ownership spans native cancellation.
import { withFetchLifetime } from 'expo/src/winter/fetch/fetch';
import type { FetchRequestInit } from 'expo/src/winter/fetch/fetch.types';
import type { OpenRouterBatchClientDependencies } from './openRouter';

export const openRouterTransportWithResponseLifetime: NonNullable<OpenRouterBatchClientDependencies['withResponseLifetime']> =
  (input, init, consumeResponse, onCancelPending, beforeStart) => withFetchLifetime(
    input,
    init as FetchRequestInit,
    (response) => consumeResponse(response as unknown as Response),
    onCancelPending,
    beforeStart
  );
