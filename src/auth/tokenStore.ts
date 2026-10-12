import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { OAuthBridgeResult, OAuthTokenStore, StoredOAuthToken } from '../connectors';

const prefix = 'still.oauth.';
const webTokens = new Map<string, StoredOAuthToken>();
const deletedRefs = new Set<string>();
const tokenQueues = new Map<string, Promise<void>>();
const clone = (token: StoredOAuthToken): StoredOAuthToken => JSON.parse(JSON.stringify(token)) as StoredOAuthToken;

function serializeToken<T>(tokenRef: string, operation: () => Promise<T>): Promise<T> {
  const previous = tokenQueues.get(tokenRef) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  tokenQueues.set(tokenRef, current.then(() => undefined, () => undefined));
  return current;
}

export const oauthTokenStore: OAuthTokenStore = {
  async get(tokenRef) {
    if (deletedRefs.has(tokenRef)) return null;
    return serializeToken(tokenRef, async () => {
      if (deletedRefs.has(tokenRef)) return null;
      const value = Platform.OS === 'web' ? webTokens.get(tokenRef) : await SecureStore.getItemAsync(`${prefix}${tokenRef}`);
      if (!value) return null;
      if (typeof value !== 'string') return clone(value);
      try { return clone(JSON.parse(value) as StoredOAuthToken); }
      catch { throw new Error('A saved account token could not be read. Reconnect that account.'); }
    });
  },
  async set(tokenRef, token) {
    if (deletedRefs.has(tokenRef)) throw new Error('This account token was deleted; reconnect to create a new secure token.');
    const value = JSON.stringify(token);
    await serializeToken(tokenRef, async () => {
      if (deletedRefs.has(tokenRef)) throw new Error('This account token was deleted; reconnect to create a new secure token.');
      if (Platform.OS === 'web') webTokens.set(tokenRef, clone(token));
      else await SecureStore.setItemAsync(`${prefix}${tokenRef}`, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    });
  },
};

export async function storeVerifiedOAuthResult(result: OAuthBridgeResult): Promise<{ tokenRef: string; token: StoredOAuthToken }> {
  if (result.identity.providerNamespace !== result.provider || !result.identity.subject || !result.identity.clientId ||
      (result.provider === 'microsoft' && !result.identity.resourceUserId) ||
      !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || !result.accessToken) {
    throw new Error('The account identity has not been verified against its provider.');
  }
  const tokenRef = Crypto.randomUUID();
  const token: StoredOAuthToken = { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt, identity: result.identity };
  await oauthTokenStore.set(tokenRef, token);
  return { tokenRef, token };
}

export async function deleteOAuthToken(tokenRef: string): Promise<void> {
  // Tombstone synchronously so queued refreshes and concurrent reads cannot revive/use it.
  deletedRefs.add(tokenRef);
  await serializeToken(tokenRef, async () => {
    if (Platform.OS === 'web') webTokens.delete(tokenRef);
    else await SecureStore.deleteItemAsync(`${prefix}${tokenRef}`);
  });
}
