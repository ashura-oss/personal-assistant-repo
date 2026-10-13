export const PRIVACY_BASE_BUNDLE_IDENTIFIER = 'com.still.voiceassistant';

/** Accept the original ID or AltStore's exact ten-character signing-team suffix. */
export function isSupportedPrivacyBundleIdentifier(value: unknown): value is string {
  return value === PRIVACY_BASE_BUNDLE_IDENTIFIER ||
    (typeof value === 'string' && value.length === PRIVACY_BASE_BUNDLE_IDENTIFIER.length + 11 &&
      /^com\.still\.voiceassistant\.[A-Z0-9]{10}$/.test(value));
}
