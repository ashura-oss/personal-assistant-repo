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

  it('blocks conversation navigation while sending without blocking idle queued navigation', async () => {
    let resolveSend!: () => void;
    const pending = new Promise<void>((resolve) => { resolveSend = resolve; });
    const onSend = vi.fn(() => pending);
    const ui = props(onSend);
    ui.conversations = [{ id: 'conversation-1', title: 'One', createdAt: '2026-01-01T00:00:00.000Z' }];
    ui.selectedConversationId = 'conversation-1';
    const onDeleteConversation = vi.fn(async () => undefined);
    const onOpenActions = vi.fn();
    ui.onDeleteConversation = onDeleteConversation;
    ui.onOpenActions = onOpenActions;
    ui.turns = [{ id: 'turn-1', userText: 'Review this', createdAt: '2026-10-13T12:00:00.000Z', noteId: 'note-1' }];
    act(() => root.render(React.createElement(ChatSection, ui)));
    const input = host.querySelector('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, 'Question');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send Batch request')!;
    await act(async () => { send.click(); await Promise.resolve(); });
    const newConversation = [...host.querySelectorAll('button')].find((button) => button.textContent === 'New conversation')!;
    const selectConversation = [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Open conversation One')!;
    const deleteConversation = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Delete conversation')!;
    const reviewActions = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Review suggested actions')!;
    expect(newConversation.disabled).toBe(true);
    expect(selectConversation.disabled).toBe(true);
    expect(deleteConversation.disabled).toBe(true);
    expect(reviewActions.disabled).toBe(true);
    act(() => { newConversation.click(); selectConversation.click(); deleteConversation.click(); reviewActions.click(); });
    expect(ui.onCreateConversation).not.toHaveBeenCalled();
    expect(ui.onSelectConversation).not.toHaveBeenCalled();
    expect(onDeleteConversation).not.toHaveBeenCalled();
    expect(onOpenActions).not.toHaveBeenCalled();
    await act(async () => { resolveSend(); await pending; });
    expect(newConversation.disabled).toBe(false);
    act(() => selectConversation.click());
    expect(ui.onSelectConversation).toHaveBeenCalledWith('conversation-1');
    act(() => reviewActions.click());
    expect(onOpenActions).toHaveBeenCalledWith('note-1');
  });

  it('blocks sending while recovery is required even if sending is otherwise enabled', async () => {
    const onSend = vi.fn(async () => undefined);
    const ui = { ...props(onSend), recoveryMessage: 'Refresh saved data before continuing.' };
    const onOpenActions = vi.fn();
    ui.turns = [{ id: 'turn-1', userText: 'Review this', createdAt: '2026-10-13T12:00:00.000Z', noteId: 'note-1' }];
    ui.onOpenActions = onOpenActions;
    act(() => root.render(React.createElement(ChatSection, ui)));
    const input = host.querySelector('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, 'Do not send while recovery is required');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send Batch request')!;
    expect(send.disabled).toBe(true);
    const reviewActions = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Review suggested actions')!;
    expect(reviewActions.disabled).toBe(true);
    await act(async () => { send.click(); await Promise.resolve(); });
    expect(onSend).not.toHaveBeenCalled();
    act(() => reviewActions.click());
    expect(onOpenActions).not.toHaveBeenCalled();
  });

  it('single-flights repeated Delete conversation presses', async () => {
    let resolveDelete!: () => void;
    const pending = new Promise<void>((resolve) => { resolveDelete = resolve; });
    const onDeleteConversation = vi.fn(() => pending);
    const ui = { ...props(vi.fn(async () => undefined)), onDeleteConversation };
    ui.conversations = [{ id: 'conversation-1', title: 'One', createdAt: '2026-01-01T00:00:00.000Z' }];
    ui.selectedConversationId = 'conversation-1';
    act(() => root.render(React.createElement(ChatSection, ui)));
    const remove = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Delete conversation')!;
    act(() => { remove.click(); remove.click(); });
    expect(onDeleteConversation).toHaveBeenCalledTimes(1);
    expect(onDeleteConversation).toHaveBeenCalledWith('conversation-1');
    await act(async () => { resolveDelete(); await pending; });
  });
});
