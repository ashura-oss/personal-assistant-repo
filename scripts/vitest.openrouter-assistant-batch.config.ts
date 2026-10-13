import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const fromRoot = (path: string) => resolve(process.cwd(), path);

export default defineConfig({
  resolve: { alias: {
    'react-native': fromRoot('tests/mocks/react-native.ts'),
    'expo-crypto': fromRoot('tests/mocks/expo-crypto.ts'),
    'expo-secure-store': fromRoot('tests/mocks/expo-secure-store.ts'),
    'expo-sqlite': fromRoot('tests/mocks/expo-sqlite.ts'),
    'expo-file-system/legacy': fromRoot('tests/mocks/expo-file-system-legacy.ts'),
  } },
  test: {
    environment: 'node',
    include: ['scripts/openrouterAssistantBatchSmoke.test.ts'],
  },
});
