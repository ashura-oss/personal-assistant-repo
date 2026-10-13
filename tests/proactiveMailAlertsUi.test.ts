/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, SavedProactiveRule } from '../src/core';
import type { ProactiveMailAlertConsent, ProactiveMailAlertReceipt, ProactiveMailAlertState } from '../src/proactiveMailAlerts/types';
import { ProactiveMailAlertsSection } from '../src/ui/ProactiveMailAlertsSection';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const passthrough = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    ReactModule.createElement(tag, {}, children);
  return {
    Platform: { OS: 'web' },
    StyleSheet: { create: (value: unknown) => value },
    View: passthrough('div'), Text: passthrough('span'), ScrollView: passthrough('div'),
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? ReactModule.createElement('div', {}, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: {
      children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
      onPress?: () => void; disabled?: boolean; accessibilityLabel?: string; accessibilityState?: { checked?: boolean; selected?: boolean };
    }) => ReactModule.createElement('button', {
      type: 'button', onClick: onPress, disabled, 'aria-label': accessibilityLabel,
      'aria-checked': accessibilityState?.checked, 'aria-pressed': accessibilityState?.selected,
    }, typeof children === 'function' ? children({ pressed: false }) : children),
  };
});

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  const passthrough = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', {}, children);
  return { SafeAreaProvider: passthrough, SafeAreaView: passthrough };
});

const rule: SavedProactiveRule = {
  id: 'rule-1', revision: 3, version: 2, enabled: true, name: 'Priority mail', accountIds: [],
  trigger: { type: 'keyword', keywords: ['launch'], unreadOnly: false }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
};
const account: Account = {
  id: 'account-1', provider: 'google', displayName: 'Sample Google', email: 'alex@example.test', connected: true, authStatus: 'connected',
  identity: { providerNamespace: 'google', clientId: 'sample-client', subject: 'sample-subject', issuer: 'issuer-ignored-for-binding', tenantId: 'tenant-ignored-for-binding' },
  tokenRef: 'fictional-ref', capabilities: ['mail.read'], connectionGeneration: 4,
};
const fourFieldKey = 'google:sample-client:sample-subject:';

function consent(identityKey = fourFieldKey): ProactiveMailAlertConsent {
  return {
    id: '10000000-0000-4000-8000-000000000001', ruleId: rule.id, ruleVersion: rule.version, ruleRevision: rule.revision,
    timeZone: 'Asia/Singapore', activatedAt: '2026-10-10T03:00:00.000Z',
    accounts: [{ accountId: account.id, identityKey, connectionGeneration: 4 }], status: 'active',
  };
}

function receipt(observed: ProactiveMailAlertReceipt['observed']): ProactiveMailAlertReceipt {
  return {
    id: '20000000-0000-4000-8000-000000000001', installationId: '30000000-0000-4000-8000-000000000001',
    consentId: '10000000-0000-4000-8000-000000000001', ruleId: rule.id, ruleVersion: rule.version, ruleRevision: rule.revision,
    timeZone: 'Asia/Singapore', consentActivatedAt: '2026-10-10T03:00:00.000Z', accountId: account.id,
    identityKey: fourFieldKey, connectionGeneration: 4, providerMessageId: 'sample-message', sourceVersion: 'sample-source',
    receivedAt: '2026-10-10T05:00:00.000Z', desired: 'cancel', observed, createdAt: '2026-10-10T05:01:00.000Z',
    updatedAt: '2026-10-11T03:00:00.000Z', attemptedAt: '2026-10-10T05:01:00.000Z',
    cancellation: { requestedAt: '2026-10-11T03:00:00.000Z', result: 'requested' },
  };
}

function state(consents: ProactiveMailAlertConsent[] = [], receipts: ProactiveMailAlertReceipt[] = []): ProactiveMailAlertState {
  return { schemaVersion: 1, installationId: '30000000-0000-4000-8000-000000000001', revision: 1, consents, receipts };
}

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

function render(props: Partial<React.ComponentProps<typeof ProactiveMailAlertsSection>> = {}) {
  const defaults: React.ComponentProps<typeof ProactiveMailAlertsSection> = {
    rules: [rule], accounts: [account], ledger: state(), timeZone: 'Asia/Singapore', busy: false, captureAdmissionBlocked: false,
    onEnable: vi.fn(async () => undefined), onRevoke: vi.fn(async () => undefined),
    onReconcile: vi.fn(async () => undefined), onRefresh: vi.fn(async () => undefined),
  };
  act(() => root.render(React.createElement(ProactiveMailAlertsSection, { ...defaults, ...props })));
  return defaults;
}

function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  act(() => button.click());
  return button;
}

async function clickAsync(label: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ProactiveMailAlertsSection contracts', () => {
  it('compares consent using the four-field provider binding even when account identity has issuer and tenant metadata', () => {
    render({ ledger: state([consent()]) });
    click('Review mail alerts for Priority mail');
    expect(host.textContent).toContain('Enabled for new matching mail');
    expect(host.textContent).toContain('1 approved account · Asia/Singapore');
    expect(host.textContent).toContain('Mail matching launch');
    expect(host.textContent).not.toContain('Unread mail matching launch');
  });

  it('labels the isolated preview panel as sample and simulated', () => {
    render({ previewOnly: true });
    click('Review mail alerts for Priority mail');
    expect(host.textContent).toContain('SAMPLE · SIMULATED');
  });

  it('shows retry cleanup for any outstanding cancellation intent, including an attempting receipt', () => {
    render({ ledger: state([], [receipt('attempting')]) });
    expect(host.querySelector('button[aria-label="Retry alert cleanup"]')).not.toBeNull();
    expect(host.textContent).toContain('Alert cleanup is pending. Retry cleanup.');
    click('Review mail alerts for Priority mail');
    expect(host.querySelector('button[aria-label="Retry cleanup for Priority mail"]')).not.toBeNull();
  });

  it('keeps explicit workspace refresh available for a stopped pending recording', async () => {
    const props = render({
      captureAdmissionBlocked: true,
      refreshAdmissionBlocked: false,
      refreshRequired: { required: true, message: 'Saved data changed. Refresh local data before continuing.' },
    });
    const refresh = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Refresh workspace');
    expect(refresh?.disabled).toBe(false);
    await clickAsync('Refresh workspace');
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('clears selected accounts after a successful disable and keeps cleanup retry in the panel', async () => {
    function ControlledSection() {
      const [ledger, setLedger] = React.useState(state());
      return React.createElement(ProactiveMailAlertsSection, {
        rules: [rule], accounts: [account], ledger, timeZone: 'Asia/Singapore', busy: false, captureAdmissionBlocked: false,
        onEnable: async () => { setLedger(state([consent()])); },
        onRevoke: async () => { setLedger(state([], [receipt('cancellation_pending')])); },
        onReconcile: async () => undefined, onRefresh: async () => undefined,
      });
    }
    act(() => root.render(React.createElement(ControlledSection)));
    click('Review mail alerts for Priority mail');
    click('Sample Google, alex@example.test');
    await clickAsync('Enable private mail alerts');
    expect(host.textContent).toContain('Mail alerts enabled.');
    await clickAsync('Disable mail alerts');
    expect(host.textContent).toContain('Mail alerts off. Check cleanup status below.');
    expect(host.querySelector('button[aria-label="Sample Google, alex@example.test"]')?.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('button[aria-label="Retry cleanup for Priority mail"]')).not.toBeNull();
  });

  it('blocks rapid duplicate enables and ignores completion after the form is closed and reopened', async () => {
    let finishFirst!: () => void;
    const pending = new Promise<void>((resolve) => { finishFirst = resolve; });
    const onEnable = vi.fn(() => pending);
    render({ onEnable });
    click('Review mail alerts for Priority mail');
    click('Sample Google, alex@example.test');
    const enableButton = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Enable private mail alerts')!;
    act(() => { enableButton.click(); enableButton.click(); });
    expect(onEnable).toHaveBeenCalledTimes(1);
    click('Close mail alert settings');
    click('Review mail alerts for Priority mail');
    await act(async () => {
      finishFirst();
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).not.toContain('Mail alerts enabled.');
    click('Sample Google, alex@example.test');
    await clickAsync('Enable private mail alerts');
    expect(onEnable).toHaveBeenCalledTimes(2);
  });

  it('shows one accessible error when notification permission is denied', async () => {
    render({ onEnable: vi.fn(async () => { throw new Error('denied'); }) });
    click('Review mail alerts for Priority mail');
    click('Sample Google, alex@example.test');
    await clickAsync('Enable private mail alerts');
    const message = 'That change could not be confirmed. Review the current status and try again.';
    expect(host.textContent?.split(message)).toHaveLength(2);
  });
});
