import * as Crypto from 'expo-crypto';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { PrivacyOwner } from './types';

const EXPECTED_BUNDLE_IDENTIFIER = 'com.still.voiceassistant';
const runtimeId = Crypto.randomUUID().toLowerCase();

export interface NativePrivacyRuntimeIdentity {
  version: 1;
  platform: 'ios';
  processLaunchId: string;
  bundleIdentifier: 'com.still.voiceassistant';
}

interface NativePrivacyModule {
  getRuntimeIdentity(): unknown;
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    value === value.toLowerCase() &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function validateNativePrivacyRuntimeIdentity(value: unknown): NativePrivacyRuntimeIdentity | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity).sort();
  if (keys.join(',') !== 'bundleIdentifier,platform,processLaunchId,version') return undefined;
  if (
    identity.version !== 1 ||
    identity.platform !== 'ios' ||
    identity.bundleIdentifier !== EXPECTED_BUNDLE_IDENTIFIER ||
    !isCanonicalUuid(identity.processLaunchId)
  ) return undefined;

  return {
    version: 1,
    platform: 'ios',
    processLaunchId: identity.processLaunchId.toLowerCase(),
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
  };
}

export function createNativePrivacyOwner(
  identity: unknown,
  ownerRuntimeId: string,
): PrivacyOwner {
  const validated = validateNativePrivacyRuntimeIdentity(identity);
  if (!validated || !isCanonicalUuid(ownerRuntimeId)) {
    return { platform: 'unsupported', runtimeId: ownerRuntimeId };
  }
  return {
    platform: 'ios',
    runtimeId: ownerRuntimeId.toLowerCase(),
    processLaunchId: validated.processLaunchId,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
  };
}

export async function getPrivacyRuntimeOwner(): Promise<PrivacyOwner> {
  if (Platform.OS !== 'ios') return { platform: 'unsupported', runtimeId };
  try {
    const nativeModule = requireOptionalNativeModule<NativePrivacyModule>('StillPrivacy');
    if (!nativeModule || typeof nativeModule.getRuntimeIdentity !== 'function') {
      return { platform: 'unsupported', runtimeId };
    }
    return createNativePrivacyOwner(nativeModule.getRuntimeIdentity(), runtimeId);
  } catch {
    return { platform: 'unsupported', runtimeId };
  }
}

export const PRIVACY_EXPECTED_BUNDLE_IDENTIFIER = EXPECTED_BUNDLE_IDENTIFIER;
