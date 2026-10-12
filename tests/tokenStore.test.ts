import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteOAuthToken, oauthTokenStore } from '../src/auth/tokenStore';

const secure = vi.hoisted(() => ({
  values: new Map<string, string>(),
  blockNextSet: false,
  releaseSet: undefined as (() => void) | undefined,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  getItemAsync: async (key: string) => secure.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (secure.blockNextSet) {
      secure.blockNextSet = false;
      await new Promise<void>(resolve => { secure.releaseSet = () => { secure.values.set(key, value); resolve(); }; });
      return;
    }
    secure.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => { secure.values.delete(key); },
}));

const stored = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: Date.now() + 60_000,
  identity: { providerNamespace: 'google' as const, clientId: 'client', subject: 'subject' },
};

describe('OAuth token deletion', () => {
  beforeEach(() => {
    secure.values.clear();
    secure.blockNextSet = false;
    secure.releaseSet = undefined;
  });

  it('tombstones synchronously, drains an in-flight write, then removes it permanently', async () => {
    const key = 'still.oauth.race-ref';
    secure.blockNextSet = true;
    const lateWrite = oauthTokenStore.set('race-ref', stored);
    while (!secure.releaseSet) await Promise.resolve();

    const deletion = deleteOAuthToken('race-ref');
    await expect(oauthTokenStore.get('race-ref')).resolves.toBeNull();
    await expect(oauthTokenStore.set('race-ref', stored)).rejects.toThrow(/deleted/);
    secure.releaseSet();
    await lateWrite;
    await deletion;

    expect(secure.values.has(key)).toBe(false);
    await expect(oauthTokenStore.get('race-ref')).resolves.toBeNull();
  });
});
