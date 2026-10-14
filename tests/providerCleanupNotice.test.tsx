/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCleanupItem, ProviderCleanupRegistry } from '../src/services/providerResponseLifetime';
import { ProviderCleanupNotice, visibleProviderCleanupItems } from '../src/ui/ProviderCleanupNotice';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, style: _style, accessibilityLabel, ...props }: Record<string, unknown> & { children?: React.ReactNode; style?: unknown; accessibilityLabel?: string }) => ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}) }, children);
  return { Text: element('span'), View: element('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', onClick: onPress, disabled }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa' }, s: { notice: {}, noticeText: {} } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function registry(initial: readonly ProviderCleanupItem[] = []) {
  let current = initial;
  const listeners = new Set<(items: readonly ProviderCleanupItem[]) => void>();
  const retryCancellation = vi.fn(async (_id: string): Promise<void> => undefined);
  const value: ProviderCleanupRegistry = {
    getPending: () => current,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    retryCancellation,
  };
  return {
    value,
    retryCancellation,
    publish(items: readonly ProviderCleanupItem[]) { current = items; for (const listener of listeners) listener(items); },
  };
}

const rows: ProviderCleanupItem[] = [
  { id: 'oauth-id', purpose: 'oauth' },
  { id: 'connector-id', purpose: 'connector' },
  { id: 'ai-id', purpose: 'azure_ai' },
  { id: 'speech-id', purpose: 'azure_speech' },
  { id: 'batch-id', purpose: 'openrouter_batch' },
  { id: 'openrouter-speech-id', purpose: 'openrouter_speech' },
];

describe('ProviderCleanupNotice', () => {
  it('keeps old-domain purpose rows visible in Workspace after a controller replacement', () => {
    expect(visibleProviderCleanupItems(rows, 'workspace')).toEqual(rows);
    expect(visibleProviderCleanupItems(rows, 'all')).toEqual(rows);
  });

  it('renders old OpenRouter purpose rows in the active Workspace cleanup notice', () => {
    const selected = registry(rows);
    act(() => root.render(<ProviderCleanupNotice registry={selected.value} scope="workspace" />));
    expect(host.textContent).toContain('Batch request');
    expect(host.textContent).toContain('speech request');
    expect(host.textContent).toContain('A provider request is still closing (6).');
  });

  it('renders all process purposes in the global fallback and drops entries when the registry settles them', () => {
    const selected = registry(rows);
    act(() => root.render(<ProviderCleanupNotice registry={selected.value} scope="all" />));
    expect(host.textContent).toContain('Batch request');
    act(() => selected.publish(rows.filter((item) => item.id !== 'batch-id')));
    expect(host.textContent).not.toContain('Batch request');
  });

  it('subscribes to safe process state and retries the same cancellation ID without an app busy lock', async () => {
    const selected = registry();
    act(() => root.render(<ProviderCleanupNotice registry={selected.value} scope="workspace" />));
    act(() => selected.publish(rows));
    expect(host.textContent).toContain('A provider request is still closing (6).');
    expect(host.textContent).toContain('Batch request');
    const retryButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry cancellation');
    expect(retryButton).toBeTruthy();
    await act(async () => { retryButton!.click(); await Promise.resolve(); });
    expect(selected.retryCancellation).toHaveBeenCalledOnce();
    expect(selected.retryCancellation).toHaveBeenCalledWith('oauth-id');
  });

  it('does not publish late retry state after unmount and leaves transport lifecycle with the registry', async () => {
    let resolve!: () => void;
    const selected = registry([{ id: 'pending', purpose: 'connector' }]);
    selected.retryCancellation.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    act(() => root.render(<ProviderCleanupNotice registry={selected.value} scope="workspace" />));
    const retryButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry cancellation')!;
    act(() => retryButton.click());
    expect(selected.retryCancellation).toHaveBeenCalledWith('pending');
    act(() => root.unmount());
    resolve();
    await Promise.resolve();
  });

  it('does not restore a row after its registry entry settles during a retry', async () => {
    let resolve!: () => void;
    const selected = registry([{ id: 'pending', purpose: 'connector' }]);
    selected.retryCancellation.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    act(() => root.render(<ProviderCleanupNotice registry={selected.value} scope="workspace" />));
    const retryButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry cancellation')!;
    act(() => retryButton.click());
    act(() => selected.publish([]));
    expect(host.textContent).not.toContain('still closing');
    resolve();
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain('still closing');
  });
});
