/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProactiveCandidateEntry, ProactiveCandidateSourceResult, ProactiveState } from '../src/core';
import { ProactiveCandidatesSection } from '../src/ui/ProactiveCandidatesSection';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, onPress, accessibilityRole: _role, accessibilityState: _state, accessibilityLabel, style: _style, numberOfLines: _lines,
    showsVerticalScrollIndicator: _indicator, contentContainerStyle: _containerStyle, visible: _visible, animationType: _animation, transparent: _transparent, onRequestClose: _close, disabled, ...props }:
    Record<string, unknown> & { children?: React.ReactNode; onPress?: () => void; accessibilityLabel?: string; disabled?: boolean }) =>
    ReactModule.createElement(tag, { ...props, ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}), ...(disabled !== undefined ? { disabled } : {}), ...(onPress ? { onClick: onPress } : {}) }, children);
  return { Modal: element('div'), Pressable: element('button'), ScrollView: element('div'), Text: element('span'), View: element('div'), StyleSheet: { create: (value: unknown) => value } };
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
  const ReactModule = await import('react');
  return { default: ({ name }: { name: string }) => ReactModule.createElement('span', null, name) };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', border: '#333', sage: '#9a9', red: '#f00' }, s: new Proxy({}, { get: () => ({}) }) }));

const candidate: ProactiveCandidateEntry['candidate'] = {
  id: 'candidate-1', suppressionKey: 'candidate-key', ruleId: 'rule-1', ruleRevision: 1,
  sourceId: 'task-source', sourceVersion: 'source-version', sourceKind: 'task', namespace: 'local_task',
  providerId: 'task-1', eligibleAt: '2026-10-15T00:00:00.000Z', reasonCode: 'task_due', quote: 'A due task', quoteField: 'title',
};
const proactive: ProactiveState = {
  schemaVersion: 1,
  rules: [{ id: 'rule-1', revision: 1, version: 1, name: 'Task reminders', enabled: true, accountIds: [], trigger: { type: 'task_due', minutes: 60 }, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' }],
  candidates: [{ candidate, presentation: 'active' }], dismissals: [], snoozes: [],
  lastEvaluation: { inputFingerprint: 'fingerprint', truncation: { rules: 0, sources: 0, candidates: 0 }, asOf: '2026-10-15T00:00:00.000Z' },
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label) || item.getAttribute('aria-label') === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  act(() => button.click());
}

describe('proactive source modal ownership', () => {
  it('does not publish a source response after the user closes its modal', async () => {
    let resolveSource!: (result: ProactiveCandidateSourceResult) => void;
    const onGetSource = vi.fn(() => new Promise<ProactiveCandidateSourceResult>((resolve) => { resolveSource = resolve; }));
    const capability = <T,>(action: T) => ({ available: true as const, action });
    act(() => root.render(<ProactiveCandidatesSection
      proactive={proactive} accounts={[]} deviceCalendarAccess="denied" busy={false}
      onDismiss={capability(() => undefined)} onSnooze={capability(() => undefined)} onRemind={capability(() => undefined)}
      onGetSource={capability(onGetSource)}
    />));
    click('Open saved source');
    expect(onGetSource).toHaveBeenCalledExactlyOnceWith(candidate.id);
    click('Close source details');
    await act(async () => {
      resolveSource({ status: 'current', candidate, source: { kind: 'task', sourceId: candidate.sourceId, namespace: 'local_task', providerId: candidate.providerId,
        sourceVersion: candidate.sourceVersion, availability: 'available', freshness: 'fresh', title: 'Late source response', status: 'open' } });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Late source response');
    expect(host.textContent).toContain('A due task');
  });

  it('hides an open result when the selected source owner changes', async () => {
    let resolveSource!: (result: ProactiveCandidateSourceResult) => void;
    const onGetSource = vi.fn(() => new Promise<ProactiveCandidateSourceResult>((resolve) => { resolveSource = resolve; }));
    const capability = <T,>(action: T) => ({ available: true as const, action });
    const render = (value: ProactiveState) => root.render(<ProactiveCandidatesSection
      proactive={value} accounts={[]} deviceCalendarAccess="denied" busy={false}
      onDismiss={capability(() => undefined)} onSnooze={capability(() => undefined)} onRemind={capability(() => undefined)}
      onGetSource={capability(onGetSource)}
    />);
    act(() => render(proactive));
    click('Open saved source');
    act(() => render({ ...proactive, rules: [...proactive.rules] }));
    await act(async () => {
      resolveSource({ status: 'current', candidate, source: { kind: 'task', sourceId: candidate.sourceId, namespace: 'local_task', providerId: candidate.providerId,
        sourceVersion: candidate.sourceVersion, availability: 'available', freshness: 'fresh', title: 'Source from previous selection', status: 'open' } });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Source from previous selection');
  });
});
