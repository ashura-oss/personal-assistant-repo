import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** Credentials are intentionally not part of settings or the exported state. */
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const browserCredentials = new Map<string, string>();
export const credentialStore: CredentialStore = Platform.OS === 'web'
  ? {
      async get(key) { return browserCredentials.get(key) ?? null; },
      async set(key, value) { browserCredentials.set(key, value); },
      async delete(key) { browserCredentials.delete(key); },
    }
  : {
      get: (key) => SecureStore.getItemAsync(key),
      set: (key, value) => SecureStore.setItemAsync(key, value),
      delete: (key) => SecureStore.deleteItemAsync(key),
    };
