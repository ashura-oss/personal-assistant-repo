/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudOAuthState } from '../src/web/cloudOAuthCoordinator';
import type { CloudConnectionsActions, CloudConnectionsCapability } from '../src/ui/CloudConnectionsPanel';
import { CloudConnectionsPanel } from '../src/ui/CloudConnectionsPanel';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const View = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('div', null, children);
  const Text = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement('span', null, children);
  const Pressable = ({ children, disabled, onPress, accessibilityRole, accessibilityLabel, accessibilityState }: {
    children?: React.ReactNode; disabled?: boolean; onPress?: () => void; accessibilityRole?: string; accessibilityLabel?: string;
    accessibilityState?: { checked?: boolean; disabled?: boolean };
  }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress, role: accessibilityRole,
    'aria-label': accessibilityLabel, 'aria-checked': accessibilityState?.checked }, children);
  return { View, Text, Pressable };
});
vi.mock('../src/ui/primitives', () => ({
  Button: ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress?: () => void }) => <button type="button" disabled={disabled} onClick={onPress}>{label}</button>,
}));
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9', bg: '#000' }, s: {} }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function mount(capability: CloudConnectionsCapability) { act(() => root.render(<CloudConnectionsPanel capability={capability} busy={false} />)); }
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label) || item.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing button ${label}; rendered ${host.textContent}`);
  return found;
}
function state(overrides: Partial<CloudOAuthState> = {}): CloudOAuthState {
  return Object.freeze({ attempts: Object.freeze([]), loading: false, ...overrides });
}
function actions(): CloudConnectionsActions {
  return {
    open: vi.fn(), reload: vi.fn(), refreshWorkspace: vi.fn(), start: vi.fn(), restart: vi.fn(), inspectStart: vi.fn(), inspectStage: vi.fn(), installStage: vi.fn(), inspectInstall: vi.fn(),
    } as unknown as CloudConnectionsActions;
}

describe('Cloud connections controls', () => {
  it('keeps exact inspection available for an uncertain start while blocking every new start', () => {
    const ports = actions();
    mount({ available: true, blockedReason: 'A workspace command is awaiting inspection.', state: state({ availability: { google: true, microsoft: false }, unknownStart: { provider: 'google', attemptId: '11111111-1111-4111-8111-111111111111' } }), accounts: [], actions: ports });
    act(() => button('Manage connections').click());
    expect(ports.open).toHaveBeenCalledTimes(1);
    expect(button('Inspect uncertain start').disabled).toBe(false);
    expect(button('Connect Google').disabled).toBe(true);
    act(() => button('Inspect uncertain start').click());
    expect(ports.inspectStart).toHaveBeenCalledWith('google', '11111111-1111-4111-8111-111111111111');
  });

  it('requires workspace refresh after a proven not-admitted start without blocking exact reads', () => {
    const ports = actions();
    mount({ available: true, state: state({ availability: { google: true, microsoft: false }, workspaceRefreshRequired: true,
      installCommandId: '33333333-3333-4333-8333-333333333333', installStageId: '22222222-2222-4222-8222-222222222222' }),
      accounts: [], actions: ports });
    act(() => button('Manage connections').click());
    expect(button('Connect Google').disabled).toBe(true);
    expect(button('Inspect exact account-install command').disabled).toBe(false);
    act(() => button('Refresh workspace').click());
    expect(ports.refreshWorkspace).toHaveBeenCalledTimes(1);
  });

  it('preserves read access for write requests and exposes Add account only with a verified preview', () => {
    const ports = actions();
    const verifiedStageId = '22222222-2222-4222-8222-222222222222';
    mount({ available: true, state: state({ availability: { google: true, microsoft: false }, stage: {
      attemptId: verifiedStageId, registrationId: 'google-web', provider: 'google', status: 'verified', payloadGeneration: 1,
      createdAt: 1_800_000_000_000, expiresAt: 1_800_000_600_000,
    } }), accounts: [], actions: ports });
    act(() => button('Manage connections').click());
    expect(host.textContent).toContain('Verified account details are not available yet');
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Add account')).toBe(false);
    const writeToggle = host.querySelector('[aria-label="google Create calendar events"]') as HTMLButtonElement;
    act(() => writeToggle.click());
    expect(host.querySelector('[aria-label="google Read calendars"]')?.getAttribute('aria-checked')).toBe('true');
    act(() => button('Connect Google').click());
    expect(ports.start).toHaveBeenCalledWith('google', expect.arrayContaining(['calendar.read', 'calendar.write']), undefined);

    const verifiedAccount = { displayName: 'Alex Example', email: 'alex@example.test', requestedCapabilities: ['mail.read'] as const, capabilities: ['mail.read'] as const };
    act(() => root.render(null));
    mount({ available: true, state: state({ availability: { google: true, microsoft: false }, stage: {
      attemptId: verifiedStageId, registrationId: 'google-web', provider: 'google', status: 'verified', payloadGeneration: 1,
      createdAt: 1_800_000_000_000, expiresAt: 1_800_000_600_000,
    }, verifiedAccount }), accounts: [], actions: ports });
    act(() => button('Manage connections').click());
    expect(host.textContent).toContain('Alex Example');
    act(() => button('Add account').click());
    expect(ports.installStage).toHaveBeenCalledWith(verifiedStageId);
  });
});
