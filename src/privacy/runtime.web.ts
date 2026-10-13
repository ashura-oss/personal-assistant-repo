import * as Crypto from 'expo-crypto';
import type { PrivacyOwner } from './types';

const runtimeId = Crypto.randomUUID().toLowerCase();

export function isWebPrivacyRuntimeSupported(
  scope: Pick<typeof globalThis, 'isSecureContext' | 'navigator'> = globalThis,
): boolean {
  try {
    return scope.isSecureContext === true &&
      typeof scope.navigator?.locks?.request === 'function';
  } catch {
    return false;
  }
}

export async function getPrivacyRuntimeOwner(
  scope: Pick<typeof globalThis, 'isSecureContext' | 'navigator'> = globalThis,
): Promise<PrivacyOwner> {
  return {
    platform: isWebPrivacyRuntimeSupported(scope) ? 'web' : 'unsupported',
    runtimeId,
  };
}
