/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailReplyContextSelection, MailReplyConversationContextDiscovery } from '../src/core';
import { MailReplyConversationContext } from '../src/ui/MailReplyConversationContext';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, style: _style, accessibilityRole, accessibilityLabel, accessibilityState, onPress, ...props }: Record<string, unknown> & { children?: React.ReactNode; style?: unknown; accessibilityRole?: string; accessibilityLabel?: string; accessibilityState?: { checked?: boolean; disabled?: boolean }; onPress?: () => void }) =>
    ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}), ...(accessibilityState?.checked !== undefined ? { 'aria-checked': accessibilityState.checked } : {}), disabled: accessibilityState?.disabled, onClick: onPress }, children);
  return { Pressable: view('button'), Text: view('span'), View: view('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00', bg: '#000' }, s: { label: {} } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const owner = { messageId: 'fixed-target', generation: 7 };
const discovery: MailReplyConversationContextDiscovery = {
  sessionId: 'opaque-session', targetMessageId: 'fixed-target',
  rows: [
    { rowId: 'opaque-row-sent', subject: 'Earlier sent', sender: 'person@example.com', sentAt: '2026-10-14T09:00:00Z', isDraft: false },
    { rowId: 'opaque-row-draft', subject: 'Unsent draft', isDraft: true },
    { rowId: 'opaque-row-unknown', subject: 'Unknown state' },
  ],
  coverage: 'partial', omissionReasons: ['page_limit'], hasMore: true, expiresAt: '2026-10-14T10:00:00Z',
};
const selection: MailReplyContextSelection = {
  selectionId: 'opaque-selection-id', subject: 'Earlier sent', sender: 'person@example.com', sentAt: '2026-10-14T09:00:00Z',
  text: 'Quoted message excerpt', bytes: 23, representation: 'plain', completeness: 'excerpt', omissionReasons: ['provider_excerpt'],
};

function render(props: Partial<React.ComponentProps<typeof MailReplyConversationContext>> = {}) {
  act(() => root.render(React.createElement(MailReplyConversationContext, {
    visible: true, messageId: owner.messageId, sourceDigest: 'source-digest', ownerGeneration: owner.generation,
    blocked: false, busy: false, onChange: vi.fn(), ...props,
  })));
}

describe('MailReplyConversationContext', () => {
  it('loads only sent metadata rows and submits opaque selections only after explicit excerpt consent', async () => {
    const onChange = vi.fn();
    const onLoadMessage = vi.fn(async () => selection);
    render({ onChange, onDiscover: vi.fn(async () => discovery), onLoadMessage });
    expect(host.textContent).toContain('The reply target stays fixed.');
    expect(host.textContent).toContain('Only messages you load and select are included');
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load conversation metadata')!.click(); await Promise.resolve(); });
    expect(host.textContent).toContain('Earlier sent');
    expect(host.textContent).toContain('Draft · cannot select');
    expect(host.textContent).toContain('Draft status unknown · cannot select');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Unsent draft') || button.textContent?.includes('Unknown state'))).toBe(false);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load this message text')!.click(); await Promise.resolve(); });
    expect(onLoadMessage).toHaveBeenCalledExactlyOnceWith('opaque-session', 'opaque-row-sent', expect.anything(), expect.any(Function));
    const include = [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.startsWith('Include'))!;
    act(() => include.click());
    expect(onChange).toHaveBeenLastCalledWith(['opaque-selection-id'], []);
    expect(host.textContent).toContain('Review it before consenting to use it.');
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Use this excerpt')!.click());
    expect(onChange).toHaveBeenLastCalledWith(['opaque-selection-id'], ['opaque-selection-id']);
    act(() => root.render(null));
    expect(onChange).toHaveBeenLastCalledWith([], []);
  });

  it('cancels a late metadata session after the composer closes without publishing rows', async () => {
    let resolveDiscovery!: (value: MailReplyConversationContextDiscovery) => void;
    const onCancel = vi.fn();
    const onDiscover = vi.fn(() => new Promise<MailReplyConversationContextDiscovery>((resolve) => { resolveDiscovery = resolve; }));
    render({ onDiscover, onCancel });
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load conversation metadata')!.click());
    render({ visible: false, onDiscover, onCancel });
    await act(async () => { resolveDiscovery(discovery); await Promise.resolve(); });
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('opaque-session', owner);
    expect(host.textContent).not.toContain('Earlier sent');
  });

  it('clears a blocked action and lets a fresh owner action complete after unblock', async () => {
    const pending: ((value: MailReplyConversationContextDiscovery) => void)[] = [];
    const onDiscover = vi.fn(() => new Promise<MailReplyConversationContextDiscovery>((resolve) => pending.push(resolve)));
    const onCancel = vi.fn();
    render({ onDiscover, onCancel });
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load conversation metadata')!.click());
    expect(host.textContent).toContain('Loading conversation metadata…');

    render({ blocked: true, onDiscover, onCancel });
    expect(host.textContent).not.toContain('Loading conversation metadata…');
    render({ blocked: false, onDiscover, onCancel });
    expect(host.textContent).toContain('Load conversation metadata');
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load conversation metadata')!.click());
    expect(onDiscover).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending[0]({ ...discovery, sessionId: 'old-session' });
      await Promise.resolve();
    });
    expect(onCancel).toHaveBeenCalledWith('old-session', owner);
    expect(host.textContent).not.toContain('Earlier sent');
    await act(async () => {
      pending[1]({ ...discovery, sessionId: 'fresh-session' });
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Earlier sent');
  });
});
