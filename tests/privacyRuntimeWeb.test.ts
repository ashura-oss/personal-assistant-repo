import { describe, expect, it } from 'vitest';
import { getPrivacyRuntimeOwner, isWebPrivacyRuntimeSupported } from '../src/privacy/runtime.web';

describe('web privacy runtime identity', () => {
  it('requires secure context and Web Locks before identifying a web runtime', async () => {
    expect(isWebPrivacyRuntimeSupported({ isSecureContext: false, navigator: { locks: { request() {} } } } as never)).toBe(false);
    expect(isWebPrivacyRuntimeSupported({ isSecureContext: true, navigator: {} } as never)).toBe(false);
    const scope = { isSecureContext: true, navigator: { locks: { request() {} } } } as never;
    expect(isWebPrivacyRuntimeSupported(scope)).toBe(true);
    expect((await getPrivacyRuntimeOwner(scope)).platform).toBe('web');
  });
});
