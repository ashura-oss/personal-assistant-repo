/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportedBackupArchive } from '../src/backup';
import { ImportedBackupsSection } from '../src/ui/ImportedBackupsSection';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, accessibilityLabel, onPress, ...props }: Record<string, unknown> & {
    children?: React.ReactNode; accessibilityLabel?: string; onPress?: () => void;
  }) => ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}), ...(onPress ? { onClick: onPress } : {}) }, children);
  return { Modal: view('div'), Pressable: view('button'), ScrollView: view('div'), Switch: view('input'), Text: view('span'), View: view('div') };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  return { SafeAreaView: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children) };
});
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, CryptoEncoding: { HEX: 'hex' }, digestStringAsync: vi.fn(async () => 'a'.repeat(64)) }));
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ label, onPress }: { label: string; onPress: () => void }) => ReactModule.createElement('button', { type: 'button', onClick: onPress }, label),
    Field: () => ReactModule.createElement('input'),
    IconButton: ({ label, onPress }: { label: string; onPress: () => void }) => ReactModule.createElement('button', { type: 'button', onClick: onPress }, label),
  };
});
vi.mock('../src/ui/ImportedChatHistoryView', () => ({ ImportedChatHistoryView: () => null }));
vi.mock('../src/ui/theme', () => ({
  C: { bg: '#111', card: '#222', border: '#333', text: '#fff', muted: '#aaa', sage: '#9a9', red: '#d66' },
  s: { sectionTitle: {}, kicker: {}, h1Small: {} },
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ImportedBackupsSection', () => {
  it('labels a V4 backup as Still v4', () => {
    const archive = {
      id: 'archive-v4', sourceFormat: 'still-backup-v4', exportedAt: '2026-10-14T00:00:00.000Z', importedAt: '2026-10-14T01:00:00.000Z',
      noteLinks: [], taskLinks: [], documents: [], history: [], chatHistory: [],
    } as unknown as ImportedBackupArchive;
    act(() => root.render(React.createElement(ImportedBackupsSection, {
      archives: [archive], currentDocuments: [], controller: {} as never, busy: false, query: '',
    })));
    expect(host.textContent).toContain('Imported backup · Still v4');
    expect(host.textContent).not.toContain('Unknown backup version');
  });
});
