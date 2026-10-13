/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailAlertTapResolution } from '../src/proactiveMailAlerts/taps';
import { MailAlertTapReviewSheet, MailAlertTapStatusCard } from '../src/ui/MailAlertTapReviewSheet';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    ReactModule.createElement(tag, {}, children);
  return {
    Platform: { OS: 'web' },
    StyleSheet: { create: (value: unknown) => value },
    View: passthrough('div'), Text: passthrough('span'), ScrollView: passthrough('div'),
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? ReactModule.createElement('div', {}, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: {
      children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
      onPress?: () => void; disabled?: boolean; accessibilityLabel?: string;
    }) => ReactModule.createElement('button', { type: 'button', onClick: onPress, disabled, 'aria-label': accessibilityLabel },
      typeof children === 'function' ? children({ pressed: false }) : children),
  };
});

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  const passthrough = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', {}, children);
  return { SafeAreaProvider: passthrough, SafeAreaView: passthrough };
});

let host: HTMLDivElement;
let root: Root;
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

const savedMail: MailAlertTapResolution = {
  kind: 'mail', receiptId: 'private-receipt-id', ruleId: 'private-rule-id', messageId: 'private-message-id',
  sourceVersion: 'private-source-version', subject: 'Timeline update', senderLabel: 'Morgan Lee',
  snippet: 'Please review the revised dates.', accountLabel: 'Work account',
  receivedAt: '2026-10-13T09:15:00.000Z', checkedAt: '2026-10-13T09:20:00.000Z',
};

describe('mail alert tap review', () => {
  it('shows only the bounded saved preview and human timing, never internal identity fields', () => {
    act(() => root.render(React.createElement(MailAlertTapReviewSheet, {
      visible: true, result: savedMail, previewOnly: true, onClose: vi.fn(),
    })));
    expect(host.textContent).toContain('Timeline update');
    expect(host.textContent).toContain('Morgan Lee');
    expect(host.textContent).toContain('Please review the revised dates.');
    expect(host.textContent).toContain('Work account');
    expect(host.textContent).toContain('SAMPLE · SIMULATED');
    expect(host.textContent).not.toContain('private-receipt-id');
    expect(host.textContent).not.toContain('private-rule-id');
    expect(host.textContent).not.toContain('private-message-id');
    expect(host.textContent).not.toContain('private-source-version');
  });

  it('renders a fixed status card without receipt identifiers', () => {
    act(() => root.render(React.createElement(MailAlertTapStatusCard, { status: {
      kind: 'status', receiptId: 'private-receipt-id', ruleId: 'private-rule-id',
      observed: 'submitted', reason: 'refresh_required',
    } })));
    expect(host.textContent).toContain('Refresh local data before reviewing this alert.');
    expect(host.textContent).toContain('Submission to iOS was recorded; delivery is not confirmed.');
    expect(host.textContent).not.toContain('receipt');
  });

  it('does not imply an active native check from pending receipt states', () => {
    const status: MailAlertTapResolution = {
      kind: 'status', receiptId: 'private-receipt-id', observed: 'attempting', reason: 'changed',
    };
    act(() => root.render(React.createElement(MailAlertTapReviewSheet, {
      visible: true, result: status, onClose: vi.fn(),
    })));
    expect(host.textContent).toContain('Submission has not been confirmed.');
    expect(host.textContent).not.toContain('being checked');
    act(() => root.render(React.createElement(MailAlertTapReviewSheet, {
      visible: true, result: { ...status, observed: 'cancellation_pending' }, onClose: vi.fn(),
    })));
    expect(host.textContent).toContain('Removal has not been confirmed.');
  });
});
