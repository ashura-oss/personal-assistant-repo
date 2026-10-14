/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { AssistantBatchJobDTO } from '../src/services/openRouterBatchJobs';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import type { ChatConversationDTO, ChatTurnDTO } from '../src/chat/types';
import { ChatSection } from '../src/ui/ChatSection';
import { ChatSubmissionNotStartedError, type ChatSendAttempt } from '../src/ui/chatSubmission';
import { buildCurrentChatTurnCommand, captureChatSubmissionOwner, chatSubmissionOwnerIsCurrent, resolveChatKnowledgeSelection } from '../src/ui/chatKnowledgeContext';
import { projectChatKnowledgeChoices } from '../src/ui/workspaceChatDisplayTypes';
import type { Person, Project } from '../src/knowledge/types';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, onPress, style: _style, accessibilityRole: _role, accessibilityState: _state, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement(tag, { ...props, ...(onPress ? { onClick: onPress } : {}) }, children);
  const TextInput = ({ onChangeText, ...props }: Record<string, unknown> & { onChangeText?: (value: string) => void }) => ReactModule.createElement('textarea', { ...props, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText?.(event.target.value) });
  return { KeyboardAvoidingView: element('div'), Modal: element('div'), Platform: { OS: 'web' }, Pressable: element('button'), ScrollView: element('div'), Text: element('span'), TextInput, View: element('div') };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  return { SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children), SafeAreaView: ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children) };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', red: '#f00', input: '#111' }, s: new Proxy({}, { get: () => ({}) }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const ordinary = (overrides: Partial<ChatTurnDTO> = {}): ChatTurnDTO => ({ id: 'turn-1', noteId: 'note-1', userText: 'Question', createdAt: '2026-10-14T08:00:00Z', ...overrides });
const conversation = (turns: readonly ChatTurnDTO[]): ChatConversationDTO => ({ id: 'conv-1', title: 'Planning', createdAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:00:00Z', turns });

function sixKnowledgeChoices() {
  const state = createInitialWorkspaceState(() => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  const stamp = '2026-10-14T08:00:00.000Z';
  for (let index = 1; index <= 3; index += 1) {
    const base = { id: `person-${index}`, revision: index, name: `Person ${index}`, aliases: [], narrativePath: `people/${index}.md`, createdAt: stamp, updatedAt: stamp, facts: [], sourceLinks: [] };
    state.knowledge.people.push({ ...base, contacts: [] } satisfies Person);
    state.knowledge.projects.push({ ...base, id: `project-${index}`, name: `Project ${index}`, narrativePath: `projects/${index}.md`, status: 'active', goal: `Project goal ${index}`, members: [] } satisfies Project);
  }
  const dto = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', privacyEpoch: 1, revision: 2 });
  return { dto, choices: projectChatKnowledgeChoices(dto.state.knowledge) };
}

function setTextArea(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Chat memory review affordance', () => {
  it('sends all six explicitly selected DTO people and projects as frozen exact revision bindings', async () => {
    const { dto, choices } = sixKnowledgeChoices();
    const chat = conversation([]);
    const onSend = vi.fn(async (_text: string, _selection?: readonly { kind: 'person' | 'project'; id: string; revision: number }[]) => ({ kind: 'accepted' as const, conversationId: chat.id, turnId: 'turn-sent', jobId: 'job-sent' }));
    act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      knowledgeChoices={choices} onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    expect(Object.isFrozen(dto.state.knowledge.people)).toBe(true);
    for (const choice of choices) act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(choice.name))!.click());
    const input = host.querySelector('textarea')!;
    act(() => setTextArea(input, 'Summarize the selected work context'));
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Summarize the selected work context', choices.map(({ kind, id, revision }) => ({ kind, id, revision })));
    expect(Object.isFrozen(onSend.mock.calls[0]?.[1])).toBe(true);
    expect(host.textContent).toContain('Selected people and projects context was sent with this message.');
  });

  it('locks same-tick duplicate sends and keeps the draft and selected context after an unknown result without retrying', async () => {
    const { choices } = sixKnowledgeChoices();
    const chat = conversation([]);
    let resolveSend!: (value: unknown) => void;
    const onSend = vi.fn((_text: string, _selection?: readonly { kind: 'person' | 'project'; id: string; revision: number }[]) => new Promise<unknown>((resolve) => { resolveSend = resolve; }));
    const onInspectUnconfirmedSend = vi.fn(async (_attempt: ChatSendAttempt) => ({ kind: 'unresolved' as const }));
    act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      knowledgeChoices={choices} onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onInspectUnconfirmedSend={onInspectUnconfirmedSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(choices[0]!.name))!.click());
    act(() => setTextArea(host.querySelector('textarea')!, 'Keep this draft until accepted'));
    act(() => {
      const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!;
      send.click(); send.click();
    });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Keep this draft until accepted', [{ kind: choices[0]!.kind, id: choices[0]!.id, revision: choices[0]!.revision }]);
    await act(async () => { resolveSend(undefined); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('textarea')!.value).toBe('Keep this draft until accepted');
    expect(host.textContent).toContain(`${choices[0]!.kind === 'person' ? 'Person' : 'Project'} · ${choices[0]!.name} · Selected`);
    expect(host.textContent).toContain('submission outcome is unknown');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.disabled).toBe(true);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check submission status')!.click(); await Promise.resolve(); });
    expect(onInspectUnconfirmedSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId: chat.id, text: 'Keep this draft until accepted' }));
    expect(host.textContent).toContain('exact submission is still unresolved');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.disabled).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('unlocks an uncertain send only after an exact verified not-started inspection, preserving the draft for an explicit retry', async () => {
    const { choices } = sixKnowledgeChoices();
    const chat = conversation([]);
    const onSend = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ kind: 'accepted', conversationId: chat.id, turnId: 'turn-2', jobId: 'job-2' });
    const onInspectUnconfirmedSend = vi.fn(async () => ({ kind: 'not_started' as const }));
    act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      knowledgeChoices={choices} onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onInspectUnconfirmedSend={onInspectUnconfirmedSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(choices[0]!.name))!.click());
    act(() => setTextArea(host.querySelector('textarea')!, 'Explicit retry only'));
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click(); await Promise.resolve(); });
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check submission status')!.click(); await Promise.resolve(); });
    expect(host.querySelector('textarea')!.value).toBe('Explicit retry only');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.disabled).toBe(false);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click(); await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('does not hold a send when the parent proves controller submission was never invoked', async () => {
    const chat = conversation([]);
    const onSend = vi.fn(async () => { throw new ChatSubmissionNotStartedError('Credentials need attention.'); });
    act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    act(() => setTextArea(host.querySelector('textarea')!, 'Safe to retry explicitly'));
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click(); await Promise.resolve(); });
    expect(host.querySelector('textarea')!.value).toBe('Safe to retry explicitly');
    expect(host.textContent).toContain('Credentials need attention.');
    expect(host.textContent).not.toContain('submission outcome is unknown');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.disabled).toBe(false);
  });

  it('clears the held draft only when inspection confirms the exact original conversation submission', async () => {
    const chat = conversation([]);
    const accepted = { kind: 'accepted' as const, conversationId: chat.id, turnId: 'turn-original', jobId: 'job-original' };
    const onSend = vi.fn(async () => undefined);
    const onInspectUnconfirmedSend = vi.fn(async () => ({ kind: 'accepted' as const, submission: accepted }));
    act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onInspectUnconfirmedSend={onInspectUnconfirmedSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    act(() => setTextArea(host.querySelector('textarea')!, 'Resolve original'));
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click(); await Promise.resolve(); });
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check submission status')!.click(); await Promise.resolve(); });
    expect(onInspectUnconfirmedSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId: chat.id, text: 'Resolve original' }));
    expect(host.querySelector('textarea')!.value).toBe('');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.disabled).toBe(true);
    expect(host.textContent).not.toContain('submission outcome is unknown');
  });

  it('keeps the hold when inspection acceptance names another conversation', async () => {
    const chat = conversation([]);
    const onSend = vi.fn(async () => undefined);
    const onInspectUnconfirmedSend = vi.fn(async () => ({ kind: 'accepted' as const, submission: { kind: 'accepted' as const, conversationId: 'other-conversation', turnId: 'turn-other', jobId: 'job-other' } }));
    act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onInspectUnconfirmedSend={onInspectUnconfirmedSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    act(() => setTextArea(host.querySelector('textarea')!, 'Do not clear for another receipt'));
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click(); await Promise.resolve(); });
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check submission status')!.click(); await Promise.resolve(); });
    expect(host.querySelector('textarea')!.value).toBe('Do not clear for another receipt');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.disabled).toBe(true);
    expect(host.textContent).toContain('exact submission is still unresolved');
  });

  it('allows exact acceptance inspection after a held source choice is revised without resubmitting', async () => {
    const { choices } = sixKnowledgeChoices();
    const chat = conversation([]);
    const original = choices[0]!;
    const revised = choices.map((choice) => choice.kind === original.kind && choice.id === original.id ? { ...choice, revision: choice.revision + 1 } : choice);
    const onSend = vi.fn(async () => undefined);
    const onInspectUnconfirmedSend = vi.fn(async () => ({ kind: 'accepted' as const, submission: { kind: 'accepted' as const, conversationId: chat.id, turnId: 'turn-held', jobId: 'job-held' } }));
    const render = (knowledgeChoices: typeof choices) => act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      knowledgeChoices={knowledgeChoices} onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onInspectUnconfirmedSend={onInspectUnconfirmedSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    render(choices);
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(original.name))!.click());
    act(() => setTextArea(host.querySelector('textarea')!, 'Resolve original source revision'));
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click(); await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Resolve original source revision', [{ kind: original.kind, id: original.id, revision: original.revision }]);
    render(revised);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check submission status')!.click(); await Promise.resolve(); });
    expect(onInspectUnconfirmedSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ knowledgeSelection: [{ kind: original.kind, id: original.id, revision: original.revision }] }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(host.querySelector('textarea')!.value).toBe('');
    expect(host.textContent).not.toContain('submission outcome is unknown');
  });

  it('reconciles a send that becomes unknown after its selected source changes in flight', async () => {
    const { choices } = sixKnowledgeChoices();
    const chat = conversation([]);
    const original = choices[0]!;
    const revised = choices.map((choice) => choice.kind === original.kind && choice.id === original.id ? { ...choice, revision: choice.revision + 1 } : choice);
    let resolveSend!: (value: unknown) => void;
    const onSend = vi.fn(() => new Promise<unknown>((resolve) => { resolveSend = resolve; }));
    const onInspectUnconfirmedSend = vi.fn(async () => ({ kind: 'accepted' as const, submission: { kind: 'accepted' as const, conversationId: chat.id, turnId: 'turn-inflight', jobId: 'job-inflight' } }));
    const render = (knowledgeChoices: typeof choices) => act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      knowledgeChoices={knowledgeChoices} onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onInspectUnconfirmedSend={onInspectUnconfirmedSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    render(choices);
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(original.name))!.click());
    act(() => setTextArea(host.querySelector('textarea')!, 'Original in-flight source'));
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click());
    render(revised);
    await act(async () => { resolveSend(undefined); await Promise.resolve(); });
    expect(host.querySelector('textarea')!.value).toBe('Original in-flight source');
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check submission status')!.click(); await Promise.resolve(); });
    expect(onInspectUnconfirmedSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Original in-flight source' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(host.querySelector('textarea')!.value).toBe('');
    expect(host.textContent).not.toContain('submission outcome is unknown');
  });

  it.each(['removed', 'revised', 'archived'] as const)('clears a selected choice and send notice when its source is %s', async (change) => {
    const { choices } = sixKnowledgeChoices();
    const selected = choices[0]!;
    const chat = conversation([]);
    const onSend = vi.fn(async () => ({ kind: 'accepted' as const, conversationId: chat.id, turnId: 'turn-current', jobId: 'job-current' }));
    const render = (knowledgeChoices: typeof choices) => act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={[]} busy={false} enabled
      knowledgeChoices={knowledgeChoices} onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    render(choices);
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(selected.name))!.click());
    act(() => setTextArea(host.querySelector('textarea')!, 'Review the selected entity'));
    const updated = change === 'removed' ? choices.filter((choice) => choice.id !== selected.id || choice.kind !== selected.kind)
      : choices.map((choice) => choice.id === selected.id && choice.kind === selected.kind
        ? change === 'revised' ? { ...choice, revision: choice.revision + 1 } : { ...choice, archivedAt: '2026-10-15T00:00:00.000Z' }
        : choice);
    render(updated);
    expect(host.textContent).not.toContain(`${selected.kind === 'person' ? 'Person' : 'Project'} · ${selected.name} · Selected`);
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Review the selected entity');
  });

  it('rejects a credential-delayed send after its conversation/controller/privacy owner changes', async () => {
    const { dto, choices } = sixKnowledgeChoices();
    const controller = {};
    const replacementController = {};
    const privacyOwner = {};
    let runtime = { controller, selectedConversationId: 'conv-1', workspaceGeneration: 8, privacyOwner, ready: true, blocked: false, mounted: true };
    const owner = captureChatSubmissionOwner(runtime)!;
    let releaseCredentials!: () => void;
    const credentials = new Promise<void>((resolve) => { releaseCredentials = resolve; });
    const submit = vi.fn();
    const pendingSend = (async () => {
      await credentials;
      const command = buildCurrentChatTurnCommand(owner, runtime, { knowledge: dto.state.knowledge, assistantChatConversations: [conversation([])] }, 'Question', [
        { kind: choices[0]!.kind, id: choices[0]!.id, revision: choices[0]!.revision },
      ]);
      submit(command);
    })();
    runtime = { ...runtime, controller: replacementController, selectedConversationId: 'conv-2', privacyOwner: {}, workspaceGeneration: 9 };
    releaseCredentials();
    await expect(pendingSend).rejects.toThrow(/conversation changed/i);
    expect(chatSubmissionOwnerIsCurrent(owner, runtime)).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a credential-delayed submit after the workspace unmounts', async () => {
    const { dto, choices } = sixKnowledgeChoices();
    const controller = {};
    const privacyOwner = {};
    let runtime = { controller, selectedConversationId: 'conv-1', workspaceGeneration: 8, privacyOwner, ready: true, blocked: false, mounted: true };
    const owner = captureChatSubmissionOwner(runtime)!;
    let releaseCredentials!: () => void;
    const credentials = new Promise<void>((resolve) => { releaseCredentials = resolve; });
    const submit = vi.fn();
    const pendingSend = (async () => {
      await credentials;
      const command = buildCurrentChatTurnCommand(owner, runtime, { knowledge: dto.state.knowledge, assistantChatConversations: [conversation([])] }, 'Question', [
        { kind: choices[0]!.kind, id: choices[0]!.id, revision: choices[0]!.revision },
      ]);
      submit(command);
    })();
    runtime = { ...runtime, mounted: false };
    releaseCredentials();
    await expect(pendingSend).rejects.toThrow(/conversation changed/i);
    expect(chatSubmissionOwnerIsCurrent(owner, runtime)).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps an exact accepted Chat submission accepted when its Batch job status is unknown', async () => {
    const stamp = '2026-10-14T08:00:00Z';
    const job: AssistantBatchJobDTO = { id: 'job-unknown-status', kind: 'note_assistance', status: 'submission_unknown', canCheck: false, createdAt: stamp, updatedAt: stamp, model: 'openai/gpt-6-luna:batch', effort: 'low', requestBytes: 64, omittedSourceCount: 0, unknownCharge: true, costStatus: 'waiting', billingScope: 'openrouter_reported', promptTokens: 0, moreComputeEfforts: [] };
    const chat = conversation([ordinary({ id: 'turn-1', job })]);
    const onSend = vi.fn(async () => ({ kind: 'accepted' as const, conversationId: chat.id, turnId: 'turn-accepted', jobId: 'job-accepted' }));
    act(() => root.render(<ChatSection conversations={[chat]} selectedConversationId={chat.id} turns={chat.turns} busy={false} enabled
      onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    act(() => setTextArea(host.querySelector('textarea')!, 'Accepted independently of later job status'));
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click(); await Promise.resolve(); });
    expect(host.querySelector('textarea')!.value).toBe('');
    expect(host.textContent).not.toContain('submission outcome is unknown');
  });

  it('does not clear an older held attempt from a stale conversation after the selected conversation changes', async () => {
    const chat = conversation([]);
    const nextConversation = { ...conversation([]), id: 'conv-2', title: 'Other' };
    const onSend = vi.fn(async () => undefined);
    const onInspectUnconfirmedSend = vi.fn(async () => ({ kind: 'accepted' as const, submission: { kind: 'accepted' as const, conversationId: chat.id, turnId: 'turn-original', jobId: 'job-original' } }));
    const render = (selectedConversationId: string) => act(() => root.render(<ChatSection conversations={[chat, nextConversation]} selectedConversationId={selectedConversationId} turns={[]} busy={false} enabled
      onSelectConversation={vi.fn()} onCreateConversation={vi.fn()} onSend={onSend} onInspectUnconfirmedSend={onInspectUnconfirmedSend} onOpenActions={vi.fn()} onCheckJob={vi.fn()} onRetryJobCleanup={vi.fn()} />));
    render(chat.id);
    act(() => setTextArea(host.querySelector('textarea')!, 'Keep stale held draft'));
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click(); await Promise.resolve(); });
    render(nextConversation.id);
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check submission status')!.click(); await Promise.resolve(); });
    expect(host.querySelector('textarea')!.value).toBe('Keep stale held draft');
    expect(host.textContent).toContain('exact submission is still unresolved');
  });

  it('requires every selected entity to remain non-archived at the exact captured revision and deduplicates command bindings', () => {
    const { dto, choices } = sixKnowledgeChoices();
    const first = choices[0]!;
    const binding = { kind: first.kind, id: first.id, revision: first.revision };
    expect(resolveChatKnowledgeSelection(dto.state.knowledge, [binding, binding])).toEqual([{ kind: binding.kind, id: binding.id }]);
    expect(() => resolveChatKnowledgeSelection(dto.state.knowledge, [{ ...binding, revision: binding.revision + 1 }])).toThrow(/changed/i);
    const removed = { ...dto.state.knowledge, people: dto.state.knowledge.people.filter((item) => item.id !== binding.id) };
    expect(() => resolveChatKnowledgeSelection(removed, [binding])).toThrow(/changed/i);
    const archived = { ...dto.state.knowledge, people: dto.state.knowledge.people.map((item) => item.id === binding.id ? { ...item, archivedAt: '2026-10-15T00:00:00.000Z' } : item) };
    expect(() => resolveChatKnowledgeSelection(archived, [binding])).toThrow(/changed/i);
  });

  it('routes each exact ordinary pending suggestion ID and excludes refinement/import-like records without public Chat IDs', () => {
    const turns = [
      ordinary({ id: 'turn-a', memorySuggestionIds: ['memory-a', 'memory-b'] }),
      ordinary({ id: 'turn-refinement', operation: 'chat_refinement', memorySuggestionIds: ['refinement-id'] }),
      ordinary({ id: 'turn-no-memory' }),
    ];
    const onReviewMemorySuggestion = vi.fn();
    const chat = conversation(turns);
    act(() => root.render(React.createElement(ChatSection, {
      conversations: [chat], selectedConversationId: chat.id, turns, busy: false, enabled: false,
      onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(async () => undefined), onOpenActions: vi.fn(),
      onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onReviewMemorySuggestion,
    })));
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.filter((item) => item.textContent?.startsWith('Review memory')).map((item) => item.textContent)).toEqual([
      'Review memory suggestion 1', 'Review memory suggestion 2',
    ]);
    act(() => buttons.find((item) => item.textContent === 'Review memory suggestion 2')?.click());
    expect(onReviewMemorySuggestion).toHaveBeenCalledExactlyOnceWith('memory-b', chat, turns[0]);
  });

  it('renders deeply frozen snapshot chat and nested Batch DTOs and returns the exact readonly memory view', () => {
    const stamp = '2026-10-14T08:00:00.000Z';
    const job: AssistantBatchJobDTO = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'note_assistance', status: 'submission_unknown', canCheck: false,
      createdAt: stamp, updatedAt: stamp, noteId: 'note-1', noteRevision: 2, model: 'openai/gpt-6-luna:batch', effort: 'low',
      requestBytes: 150, omittedSourceCount: 0, unknownCharge: true, costStatus: 'waiting', billingScope: 'openrouter_reported',
      promptTokens: 0, moreComputeEfforts: ['high'],
    };
    const turn: ChatTurnDTO = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', noteId: 'note-1', userText: 'Keep the original message.', createdAt: stamp,
      memorySuggestionIds: ['memory-safe-id'], job,
    };
    const conversation: ChatConversationDTO = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Planning', createdAt: stamp, updatedAt: stamp, turns: [turn],
    };
    const state = createInitialWorkspaceState(() => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    state.assistantBatchJobs = [job];
    state.assistantChatConversations = [conversation];
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, {
      workspaceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', privacyEpoch: 1, revision: 9,
    });
    const readonlyConversation = snapshot.state.assistantChatConversations[0]!;
    const readonlyTurn = readonlyConversation.turns[0]!;
    expect(Object.isFrozen(readonlyConversation.turns)).toBe(true);
    expect(Object.isFrozen(readonlyTurn.job)).toBe(true);
    expect(Object.isFrozen(readonlyTurn.job?.moreComputeEfforts)).toBe(true);

    const onReview = vi.fn();
    act(() => root.render(React.createElement(ChatSection, {
      conversations: snapshot.state.assistantChatConversations,
      selectedConversationId: readonlyConversation.id,
      turns: readonlyConversation.turns,
      busy: false,
      enabled: false,
      onSelectConversation: vi.fn(), onCreateConversation: vi.fn(), onSend: vi.fn(async () => undefined),
      onOpenActions: vi.fn(), onCheckJob: vi.fn(), onRetryJobCleanup: vi.fn(), onReviewMemorySuggestion: onReview,
    })));
    expect(host.textContent).toContain('Submission status uncertain');
    expect(host.textContent).toContain('Provider-reported usage is not available yet.');
    expect(host.textContent).toContain('0 prompt');
    act(() => [...host.querySelectorAll('button')].find((item) => item.textContent === 'Review memory')?.click());
    expect(onReview).toHaveBeenCalledExactlyOnceWith('memory-safe-id', readonlyConversation, readonlyTurn);
  });
});
