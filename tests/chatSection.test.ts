/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSection, type ChatSectionProps } from '../src/ui/ChatSection';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const pass = (tag: string) => ({ children, style: _style, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    ReactModule.createElement(tag, props, children);
  return {
    Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value },
    View: pass('div'), Text: pass('span'), ScrollView: pass('div'), KeyboardAvoidingView: pass('div'),
    Pressable: ({ children, onPress, accessibilityLabel, disabled }: { children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode); onPress?: () => void; accessibilityLabel?: string; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel, disabled }, typeof children === 'function' ? children({ pressed: false }) : children),
    TextInput: ({ value, onChangeText, accessibilityLabel, placeholder, disabled, editable }: { value: string; onChangeText: (value: string) => void; accessibilityLabel?: string; placeholder?: string; disabled?: boolean; editable?: boolean }) => ReactModule.createElement('textarea', { value, 'aria-label': accessibilityLabel, placeholder, disabled: disabled || editable === false, onChange: (event: Event) => onChangeText((event.target as HTMLTextAreaElement).value) }),
  };
});
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function props(onSend: ChatSectionProps['onSend']): ChatSectionProps {
  return {
    conversations: [], selectedConversationId: undefined, turns: [], busy: false, enabled: true,
    onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend,
    onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(),
  };
}

describe('queued chat section', () => {
  it('retains the draft after a failed submission', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('private provider error'));
    act(() => root.render(React.createElement(ChatSection, props(onSend))));
    const input = host.querySelector('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, '  Keep this question  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send Batch request')!;
    await act(async () => { send.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledWith('Keep this question');
    expect(input.value).toBe('  Keep this question  ');
    expect(host.textContent).toContain('Check saved messages and request status before sending again');
    expect(host.textContent).toContain('Your draft is still here');
    expect(host.textContent).not.toContain('private provider error');
  });

  it('uses a synchronous lock to prevent duplicate sends and clears only after success', async () => {
    let resolveSend!: () => void;
    const pending = new Promise<void>((resolve) => { resolveSend = resolve; });
    const onSend = vi.fn(() => pending);
    act(() => root.render(React.createElement(ChatSection, props(onSend))));
    const input = host.querySelector('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, 'One explicit question');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send Batch request')!;
    act(() => { send.click(); send.click(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('One explicit question');
    await act(async () => { resolveSend(); await pending; });
    expect(input.value).toBe('');
  });
});
