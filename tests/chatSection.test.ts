/** @vitest-environment jsdom */
import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversationDTO } from '../src/chat/types';
import { ChatSection } from '../src/ui/ChatSection';
import { isAcceptedChatSubmission, runAcceptedChatSubmission } from '../src/ui/chatSubmission';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, onChangeText, onPress, style: _style, numberOfLines: _numberOfLines,
    accessibilityRole: _role, accessibilityState: _state, accessibilityLabel: _label, accessibilityHint: _hint,
    ...props }: Record<string, unknown> & { children?: React.ReactNode; onChangeText?: (value: string) => void; onPress?: () => void }) =>
    ReactModule.createElement(tag, { ...props, ...(_label ? { 'aria-label': _label } : {}), ...(onPress ? { onClick: onPress } : {}), ...(onChangeText ? { onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) } : {}) }, children);
  return {
    KeyboardAvoidingView: view('div'), Modal: ({ visible, children }: { visible: boolean; children?: React.ReactNode }) => visible ? ReactModule.createElement('div', { role: 'dialog' }, children) : null,
    Platform: { OS: 'web' }, Pressable: view('button'), ScrollView: view('div'), Text: view('span'), TextInput: view('textarea'), View: view('div'),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  const Safe = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children);
  return { SafeAreaProvider: Safe, SafeAreaView: Safe };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', input: '#111' }, s: { kicker: {}, h1Small: {} } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const conversation: ChatConversationDTO = {
  id: 'conversation-1', title: 'Launch plan', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', turns: [],
};
function renderChat(overrides: Partial<React.ComponentProps<typeof ChatSection>> = {}) {
  const props: React.ComponentProps<typeof ChatSection> = {
    conversations: [conversation], selectedConversationId: conversation.id, turns: [], busy: false, enabled: true,
    onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(async () => ({ kind: 'accepted', conversationId: conversation.id, turnId: 'turn-1', jobId: 'job-1' })),
    onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onDeleteConversation: vi.fn(async () => undefined),
    ...overrides,
  };
  act(() => root.render(React.createElement(ChatSection, props)));
  return props;
}

function enterDraft(value: string) {
  const input = host.querySelector('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input as HTMLTextAreaElement;
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === label);
}

describe('ChatSection review and submission behavior', () => {
  it('shows saved-transcript provenance with the original capture time while retaining the later Chat time', () => {
    const capturedAt = '2026-10-13T10:00:00.000Z';
    const addedAt = '2026-10-14T01:00:00.000Z';
    const turn = {
      id: 'saved-turn', noteId: 'source-note', userText: 'Use the saved words.', createdAt: addedAt,
      messageOrigin: 'saved_transcript' as const, capturedAt, captureTimeZone: 'Asia/Singapore',
    };
    renderChat({ conversations: [{ ...conversation, turns: [turn] }], turns: [turn] });
    expect(host.textContent).toContain('From saved transcript');
    expect(host.textContent).toContain('Asia/Singapore');
    expect(host.textContent).toContain('Added to Chat');
  });

  const completedParentTurn = {
    id: 'parent-turn', noteId: 'note-parent', userText: 'Summarize the planning notes.',
    createdAt: conversation.createdAt,
    reply: { summary: 'Summary', answer: 'A useful saved answer.', clarifications: [], completedAt: conversation.createdAt },
    job: { id: 'parent-job', kind: 'note_assistance', status: 'completed', canCheck: false, createdAt: conversation.createdAt,
      updatedAt: conversation.createdAt, model: 'openai/gpt-6-luna:batch', effort: 'low', unknownCharge: false,
      costStatus: 'reported', billingScope: 'openrouter_reported', providerReportedCostUsd: 0 },
  } satisfies React.ComponentProps<typeof ChatSection>['turns'][number];

  it('reviews a separate paid refinement with Medium selected, then submits only the chosen effort', async () => {
    const onRefineTurn = vi.fn(async () => ({ kind: 'accepted', conversationId: conversation.id, turnId: 'child-turn', jobId: 'child-job' }));
    renderChat({ conversations: [{ ...conversation, turns: [completedParentTurn] }], turns: [completedParentTurn], onRefineTurn });
    act(() => button('Think more')?.click());
    expect(host.textContent).toContain('separate paid Batch request');
    expect(host.textContent).toContain('does not change the original message or its actions');
    expect(button('Medium · Selected')).not.toBeUndefined();
    act(() => button('High')?.click());
    await act(async () => { button('Refine answer')?.click(); await Promise.resolve(); });
    expect(onRefineTurn).toHaveBeenCalledTimes(1);
    expect(onRefineTurn).toHaveBeenCalledWith({
      conversationId: conversation.id, parentTurnId: 'parent-turn', parentJobId: 'parent-job', effort: 'high',
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('settles and releases the refinement review after a StrictMode effect replay', async () => {
    let resolveRefinement!: (value: unknown) => void;
    const onRefineTurn = vi.fn(() => new Promise((resolve) => { resolveRefinement = resolve; }));
    const onInteractionLockChange = vi.fn();
    const props: React.ComponentProps<typeof ChatSection> = {
      conversations: [{ ...conversation, turns: [completedParentTurn] }],
      selectedConversationId: conversation.id,
      turns: [completedParentTurn],
      busy: false,
      enabled: true,
      onSelectConversation: vi.fn(),
      onCreateConversation: vi.fn(),
      onSend: vi.fn(),
      onOpenActions: vi.fn(),
      onCheckJob: vi.fn(),
      onRetryJobCleanup: vi.fn(),
      onRefineTurn,
      onInteractionLockChange,
    };
    act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(ChatSection, props))));
    act(() => button('Think more')?.click());
    act(() => button('Refine answer')?.click());
    expect(onRefineTurn).toHaveBeenCalledTimes(1);
    expect(button('Cancel')?.disabled).toBe(true);
    await act(async () => {
      resolveRefinement({ kind: 'accepted', conversationId: conversation.id, turnId: 'strict-child', jobId: 'strict-job' });
      await Promise.resolve();
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(button('Think more')?.disabled).toBe(false);
    expect(onInteractionLockChange).toHaveBeenLastCalledWith(false);
  });

  it('singleflights review opening and blocks navigation in the same event turn', () => {
    const onCreateConversation = vi.fn();
    const onSelectConversation = vi.fn();
    renderChat({
      conversations: [{ ...conversation, turns: [completedParentTurn] }, { ...conversation, id: 'conversation-2', title: 'Other' }],
      selectedConversationId: conversation.id,
      turns: [completedParentTurn],
      onRefineTurn: vi.fn(), onCreateConversation, onSelectConversation,
    });
    act(() => {
      button('Think more')?.click();
      button('Think more')?.click();
      button('New conversation')?.click();
      host.querySelector('[aria-label^="Open conversation Other"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(onCreateConversation).not.toHaveBeenCalled();
    expect(onSelectConversation).not.toHaveBeenCalled();
  });

  it('keeps the review open after an unconfirmed refinement and never clears the parent answer', async () => {
    const onRefineTurn = vi.fn(async () => undefined);
    renderChat({ conversations: [{ ...conversation, turns: [completedParentTurn] }], turns: [completedParentTurn], onRefineTurn });
    act(() => button('Think more')?.click());
    await act(async () => { button('Refine answer')?.click(); await Promise.resolve(); });
    expect(onRefineTurn).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.textContent).toContain('Could not confirm refinement');
    expect(host.textContent).toContain('A useful saved answer.');
  });

  it('closes a refinement review if its bound parent reply or conversation changes', async () => {
    const props = renderChat({ conversations: [{ ...conversation, turns: [completedParentTurn] }], turns: [completedParentTurn], onRefineTurn: vi.fn() });
    act(() => button('Think more')?.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      root.render(React.createElement(ChatSection, { ...props, conversations: [{ ...conversation, turns: [{ ...completedParentTurn, reply: undefined }] }], turns: [{ ...completedParentTurn, reply: undefined }] }));
      await Promise.resolve();
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('hides and invalidates a review during a hard blocker, ignoring late completion', async () => {
    let resolveRefinement!: (value: unknown) => void;
    const onRefineTurn = vi.fn(() => new Promise((resolve) => { resolveRefinement = resolve; }));
    const originalConversations = [{ ...conversation, turns: [completedParentTurn] }];
    renderChat({ conversations: originalConversations, turns: [completedParentTurn], onRefineTurn });
    act(() => button('Think more')?.click());
    act(() => button('Refine answer')?.click());
    expect(onRefineTurn).toHaveBeenCalledTimes(1);
    expect(button('Cancel')?.disabled).toBe(true);
    await act(async () => {
      flushSync(() => root.render(React.createElement(ChatSection, {
        conversations: originalConversations, selectedConversationId: conversation.id, turns: [completedParentTurn], busy: true, enabled: true,
        reviewBlocked: true, onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(), onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onRefineTurn,
      })));
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      resolveRefinement({ kind: 'accepted', conversationId: conversation.id, turnId: 'late-turn', jobId: 'late-job' });
      await Promise.resolve();
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain('Refinement request saved.');
  });

  it('can refine a completed refinement as another distinct answer, with effort labeled', async () => {
    const childTurn = {
      ...completedParentTurn, id: 'refined-turn', noteId: 'note-refined', operation: 'chat_refinement' as const,
      reasoningEffort: 'high' as const, parentTurnId: 'parent-turn', job: { ...completedParentTurn.job, id: 'refined-job' },
      reply: { ...completedParentTurn.reply, answer: 'Refined saved answer.' },
    };
    const onRefineTurn = vi.fn(async () => ({ kind: 'accepted', conversationId: conversation.id, turnId: 'next-turn', jobId: 'next-job' }));
    renderChat({ conversations: [{ ...conversation, turns: [completedParentTurn, childTurn] }], turns: [completedParentTurn, childTurn], onRefineTurn });
    expect(host.textContent).toContain('Refined answer · high');
    expect(host.textContent).toContain('Refinement of an earlier message');
    expect(host.textContent?.match(/Summarize the planning notes\./g)).toHaveLength(1);
    act(() => button('Think more · HIGH')?.click());
    await act(async () => { button('Refine answer')?.click(); await Promise.resolve(); });
    expect(onRefineTurn).toHaveBeenCalledWith({
      conversationId: conversation.id, parentTurnId: 'refined-turn', parentJobId: 'refined-job', effort: 'medium',
    });
  });

  it('requires explicit accepted result before clearing the draft', async () => {
    const props = renderChat({ onSend: vi.fn(async () => undefined) });
    const input = enterDraft('keep my draft');
    await act(async () => { button('Send')?.click(); await Promise.resolve(); });
    expect(input.value).toBe('keep my draft');
    expect(host.textContent).toContain('Could not confirm submission');
    expect(props.onSend).toHaveBeenCalledWith('keep my draft');
  });

  it('clears the draft only for a complete accepted result', async () => {
    renderChat();
    const input = enterDraft('accepted text');
    await act(async () => { button('Send')?.click(); await Promise.resolve(); });
    expect(input.value).toBe('');
  });

  it('holds a synchronous singleflight and blocks navigation while sending', async () => {
    let resolveSend!: (value: unknown) => void;
    const onSend = vi.fn(() => new Promise((resolve) => { resolveSend = resolve; }));
    const turn = { id: 'turn-1', noteId: 'note-1', userText: 'Question', createdAt: conversation.createdAt };
    renderChat({ turns: [turn], onSend });
    const input = enterDraft('double tap');
    act(() => {
      button('Send')?.click();
      button('Send')?.click();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(button('New conversation')?.disabled).toBe(true);
    expect(button('Review suggested actions')?.disabled).toBe(true);
    expect(host.querySelectorAll('[aria-label^="Open conversation"]')[0]).toHaveProperty('disabled', true);
    await act(async () => { resolveSend({ kind: 'accepted', conversationId: conversation.id, turnId: 'turn-1', jobId: 'job-1' }); await Promise.resolve(); });
    expect(input.value).toBe('');
  });

  it('does not delete until the separate confirmation is pressed and cancel unlocks navigation', async () => {
    const onDelete = vi.fn(async () => undefined);
    const onLock = vi.fn();
    renderChat({ onDeleteConversation: onDelete, onInteractionLockChange: onLock });
    act(() => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Delete conversation')?.click(); });
    expect(host.textContent).toContain('Small billing and submission receipts remain');
    expect(onDelete).not.toHaveBeenCalled();
    expect(onLock).toHaveBeenCalledWith(true);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')?.click(); await Promise.resolve(); });
    expect(onDelete).not.toHaveBeenCalled();
    expect(onLock).toHaveBeenLastCalledWith(false);
  });

  it('calls deletion only after confirmation', async () => {
    const onDelete = vi.fn(async () => undefined);
    renderChat({ onDeleteConversation: onDelete });
    act(() => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Delete conversation')?.click(); });
    await act(async () => { [...host.querySelectorAll('button')].filter((button) => button.textContent === 'Delete conversation').at(-1)?.click(); await Promise.resolve(); });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(conversation.id);
  });

  it('keeps a failed deletion review cancellable and permits an explicit retry', async () => {
    const onDelete = vi.fn().mockRejectedValueOnce(new Error('unknown')).mockResolvedValueOnce(undefined);
    const onLock = vi.fn();
    renderChat({ onDeleteConversation: onDelete, onInteractionLockChange: onLock });
    act(() => button('Delete conversation')?.click());
    await act(async () => { [...host.querySelectorAll('button')].filter((item) => item.textContent === 'Delete conversation').at(-1)?.click(); await Promise.resolve(); });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Could not confirm conversation removal');
    expect(button('Cancel')?.disabled).toBe(false);
    await act(async () => { button('Cancel')?.click(); await Promise.resolve(); });
    expect(onLock).toHaveBeenLastCalledWith(false);

    act(() => button('Delete conversation')?.click());
    await act(async () => { [...host.querySelectorAll('button')].filter((item) => item.textContent === 'Delete conversation').at(-1)?.click(); await Promise.resolve(); });
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it('singleflights repeated confirmation taps while deletion is pending', async () => {
    let resolveDelete!: () => void;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    renderChat({ onDeleteConversation: onDelete });
    act(() => button('Delete conversation')?.click());
    act(() => {
      [...host.querySelectorAll('button')].filter((item) => item.textContent === 'Delete conversation').at(-1)?.click();
      [...host.querySelectorAll('button')].filter((item) => item.textContent === 'Delete conversation').at(-1)?.click();
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(button('Cancel')?.disabled).toBe(true);
    await act(async () => { resolveDelete(); await Promise.resolve(); });
  });

  it('closes and releases review when recovery starts or the reviewed conversation disappears', async () => {
    const onLock = vi.fn();
    renderChat({ onInteractionLockChange: onLock, onDeleteConversation: vi.fn() });
    act(() => button('Delete conversation')?.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { root.render(React.createElement(ChatSection, {
      conversations: [conversation], selectedConversationId: conversation.id, turns: [], busy: false, enabled: false,
      recoveryMessage: 'Saved data needs refresh.', onInteractionLockChange: onLock,
      onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(), onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onDeleteConversation: vi.fn(),
    })); await Promise.resolve(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(onLock).toHaveBeenLastCalledWith(false);

    act(() => root.render(React.createElement(ChatSection, {
      conversations: [conversation], selectedConversationId: conversation.id, turns: [], busy: false, enabled: true,
      onInteractionLockChange: onLock, onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(), onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onDeleteConversation: vi.fn(),
    })));
    act(() => button('Delete conversation')?.click());
    await act(async () => { root.render(React.createElement(ChatSection, {
      conversations: [], selectedConversationId: conversation.id, turns: [], busy: false, enabled: true,
      onInteractionLockChange: onLock, onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(), onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onDeleteConversation: vi.fn(),
    })); await Promise.resolve(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(onLock).toHaveBeenLastCalledWith(false);
  });

  it('synchronously blocks confirmation after a recovery blocker or selection change', async () => {
    const onDelete = vi.fn(async () => undefined);
    renderChat({ onDeleteConversation: onDelete });
    act(() => button('Delete conversation')?.click());
    const blockedProps: React.ComponentProps<typeof ChatSection> = {
      conversations: [conversation], selectedConversationId: conversation.id, turns: [], busy: false, enabled: true,
      reviewBlocked: true, onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(), onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onDeleteConversation: onDelete,
    };
    act(() => {
      flushSync(() => root.render(React.createElement(ChatSection, blockedProps)));
      const confirm = [...host.querySelectorAll('button')].filter((item) => item.textContent === 'Delete conversation').at(-1);
      expect(confirm?.disabled).toBe(true);
      confirm?.click();
    });
    expect(onDelete).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });

    act(() => flushSync(() => root.render(React.createElement(ChatSection, {
      conversations: [conversation], selectedConversationId: conversation.id, turns: [], busy: false, enabled: true,
      onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(), onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onDeleteConversation: onDelete,
    }))));
    act(() => button('Delete conversation')?.click());
    const otherConversation = { ...conversation, id: 'conversation-2', title: 'Another chat' };
    act(() => flushSync(() => root.render(React.createElement(ChatSection, {
      conversations: [conversation, otherConversation], selectedConversationId: otherConversation.id, turns: [], busy: false, enabled: true,
      onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(), onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onDeleteConversation: onDelete,
    }))));
    expect(onDelete).not.toHaveBeenCalled();
    expect(button('Delete conversation')?.disabled).toBe(true);
  });

  it('releases the parent interaction lock when unmounted with a review open', () => {
    const onLock = vi.fn();
    renderChat({ onInteractionLockChange: onLock });
    act(() => button('Delete conversation')?.click());
    expect(onLock).toHaveBeenLastCalledWith(true);
    act(() => root.unmount());
    expect(onLock).toHaveBeenLastCalledWith(false);
    root = createRoot(host);
  });

  it('blocks sending when recovery is required even if the parent enables the composer', async () => {
    const onSend = vi.fn(async () => ({ kind: 'accepted' }));
    renderChat({ recoveryMessage: 'Saved history needs refresh.', onSend });
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')?.disabled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('runAcceptedChatSubmission', () => {
  const accepted = { kind: 'accepted' as const, conversationId: 'c', turnId: 't', jobId: 'j' };
  it('returns only the explicit accepted DTO', async () => {
    await expect(runAcceptedChatSubmission(async (action) => action(), async () => accepted)).resolves.toEqual(accepted);
  });
  it('rejects malformed or extra-field acceptance objects', () => {
    expect(isAcceptedChatSubmission(accepted)).toBe(true);
    expect(isAcceptedChatSubmission({ ...accepted, providerBatchId: 'private' })).toBe(false);
    expect(isAcceptedChatSubmission({ ...accepted, turnId: '' })).toBe(false);
    expect(isAcceptedChatSubmission({ kind: 'accepted', conversationId: 'c', turnId: 't' })).toBe(false);
  });
  it('rejects swallowed run errors or missing credentials instead of reporting success', async () => {
    const controllerSubmit = vi.fn(async () => accepted);
    const settings = vi.fn();
    const missingKeyAction = async () => { settings(); throw new Error('key missing'); };
    await expect(runAcceptedChatSubmission(async (action) => { try { return await action(); } catch { return undefined; } }, missingKeyAction)).rejects.toThrow(/could not be confirmed/i);
    expect(settings).toHaveBeenCalledTimes(1);
    expect(controllerSubmit).not.toHaveBeenCalled();
    await expect(runAcceptedChatSubmission(async () => undefined, async () => accepted)).rejects.toThrow(/could not be confirmed/i);
  });
});
