/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/auth/browser', () => { throw new Error('Imported auth/browser'); });
vi.mock('../src/auth/tokenStore', () => { throw new Error('Imported auth/tokenStore'); });
vi.mock('../src/connectors/oauth', () => { throw new Error('Imported connectors/oauth'); });
vi.mock('../src/storage/platformStorage', () => { throw new Error('Imported storage/platformStorage'); });
vi.mock('../src/storage/platformStorage.web', () => { throw new Error('Imported storage/platformStorage.web'); });
vi.mock('../src/audio/blobStore.web', () => { throw new Error('Imported audio/blobStore.web'); });
vi.mock('../src/audio/readAudio', () => { throw new Error('Imported audio/readAudio'); });
vi.mock('../src/audio/useAudioCapture', () => { throw new Error('Imported audio/useAudioCapture'); });
vi.mock('expo-file-system/legacy', () => { throw new Error('Imported expo-file-system/legacy'); });
vi.mock('expo-sharing', () => { throw new Error('Imported expo-sharing'); });
vi.mock('expo-web-browser', () => { throw new Error('Imported expo-web-browser'); });
vi.mock('expo-document-picker', () => { throw new Error('Imported expo-document-picker'); });
vi.mock('expo-audio', () => { throw new Error('Imported expo-audio'); });
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', Alert: { alert: () => undefined }, KeyboardAvoidingView: 'KeyboardAvoidingView', StyleSheet: { create: (styles: unknown) => styles },
  Modal: 'Modal', Platform: { OS: 'web' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Switch: 'Switch',
  Text: 'Text', TextInput: 'TextInput', View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' }));

describe('shared workspace view platform boundary', () => {
  it('loads the real view without importing native storage, auth, or picker ownership', async () => {
    const view = await import('../WorkspaceView');
    expect(view.WorkspaceView).toBeTypeOf('function');
  });
});
