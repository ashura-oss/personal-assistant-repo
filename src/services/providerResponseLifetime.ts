/** Native compatibility wrapper for the Expo-free provider lifetime contracts. */
import * as Crypto from 'expo-crypto';
import {
  createProviderCleanupRegistry as createRegistry,
  createTrackedProviderResponseLifetime as createTracked,
} from './providerResponseLifetime.shared';
import type {
  ProviderCleanupRegistry,
  ProviderPurpose,
  ProviderResponseLifetime,
} from './providerResponseLifetime.shared';

export type {
  ProviderCancellationRetry,
  ProviderCleanupItem,
  ProviderCleanupRegistry,
  ProviderPurpose,
  ProviderRequestInput,
  ProviderResponseLifetime,
} from './providerResponseLifetime.shared';

export function createProviderCleanupRegistry(): ProviderCleanupRegistry {
  return createRegistry(() => Crypto.randomUUID());
}

/** The process-wide registry is shared by foreground, background, and UI bindings. */
export const providerCleanupRegistry = createProviderCleanupRegistry();

export function createTrackedProviderResponseLifetime(
  raw: ProviderResponseLifetime,
  purpose: ProviderPurpose,
  registry: ProviderCleanupRegistry = providerCleanupRegistry,
): ProviderResponseLifetime {
  return createTracked(raw, purpose, registry);
}
