import { describe, expect, it, vi } from 'vitest';
import {
  createNativePrivacyOwner,
  isCanonicalUuid,
  validateNativePrivacyRuntimeIdentity,
} from '../src/privacy/runtime';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));

const processId = '6b7b5f77-1b6a-4b94-aeb7-7d76a2098131';
const runtimeOne = 'caa27bbc-5a14-4b73-a8fa-90c6a90207c4';
const runtimeTwo = 'be73fa56-8c43-48f3-a668-d0f9d8311f64';
const validNativeIdentity = {
  version: 1,
  platform: 'ios',
  processLaunchId: processId,
  bundleIdentifier: 'com.still.voiceassistant',
};

describe('privacy runtime identity', () => {
  it('accepts only the exact supported iOS identity schema', () => {
    expect(validateNativePrivacyRuntimeIdentity(validNativeIdentity)).toEqual(validNativeIdentity);
    expect(validateNativePrivacyRuntimeIdentity({ ...validNativeIdentity, bundleIdentifier: 'com.other.app' })).toBeUndefined();
    expect(validateNativePrivacyRuntimeIdentity({ ...validNativeIdentity, processLaunchId: 'not-a-uuid' })).toBeUndefined();
    expect(validateNativePrivacyRuntimeIdentity({ ...validNativeIdentity, version: 2 })).toBeUndefined();
    expect(validateNativePrivacyRuntimeIdentity({ ...validNativeIdentity, processLaunchId: processId.toUpperCase() })).toBeUndefined();
    expect(validateNativePrivacyRuntimeIdentity({ ...validNativeIdentity, extra: true })).toBeUndefined();
    expect(validateNativePrivacyRuntimeIdentity(null)).toBeUndefined();
  });

  it('keeps one native process identity across JS runtime reloads', () => {
    const firstJsRuntime = createNativePrivacyOwner(validNativeIdentity, runtimeOne);
    const reloadedJsRuntime = createNativePrivacyOwner(validNativeIdentity, runtimeTwo);
    expect(firstJsRuntime.processLaunchId).toBe(reloadedJsRuntime.processLaunchId);
    expect(firstJsRuntime.runtimeId).not.toBe(reloadedJsRuntime.runtimeId);
    expect(createNativePrivacyOwner({ ...validNativeIdentity, bundleIdentifier: 'other' }, runtimeOne).platform).toBe('unsupported');
  });

  it('accepts and preserves only the exact AltStore signing-team-suffixed app identity', () => {
    const bundleIdentifier = 'com.still.voiceassistant.A1B2C3D4E5';
    const suffixedIdentity = { ...validNativeIdentity, bundleIdentifier };
    expect(validateNativePrivacyRuntimeIdentity(suffixedIdentity)?.bundleIdentifier).toBe(bundleIdentifier);
    expect(createNativePrivacyOwner(suffixedIdentity, runtimeOne).bundleIdentifier).toBe(bundleIdentifier);
    for (const invalid of [
      'com.still.voiceassistant.a1b2c3d4e5',
      'com.still.voiceassistant.A1B2C3D4E',
      'com.still.voiceassistant.A1B2C3D4E5X',
      'com.still.voiceassistant.A1B2C3D4E5\n',
      'com.still.voiceassistant.A1B2C3D4E-',
      'com.still.voiceassistant.extra.A1B2C3D4E5',
      'com.other.voiceassistant.A1B2C3D4E5',
    ]) {
      expect(validateNativePrivacyRuntimeIdentity({ ...validNativeIdentity, bundleIdentifier: invalid })).toBeUndefined();
    }
  });

  it('requires canonical UUIDs for process and JS runtime identities', () => {
    expect(isCanonicalUuid(runtimeOne)).toBe(true);
    expect(isCanonicalUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(createNativePrivacyOwner(validNativeIdentity, 'bad').platform).toBe('unsupported');
  });
});
