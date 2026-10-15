/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedSession } from '../src/web/authClient';
import { CloudCredentialsPanel } from '../src/ui/CloudCredentialsPanel';
import { useCloudCredentials } from '../src/web/useCloudCredentials';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, style: _style, contentContainerStyle: _contentStyle, ...props }: Record<string, unknown>) => ReactModule.createElement(tag, props, children as React.ReactNode);
  const Pressable = ({ children, onPress, disabled, accessibilityLabel, style: _style, ...props }: Record<string, unknown> & { onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => ReactModule.createElement('button', {
    ...props, type: 'button', disabled, 'aria-label': accessibilityLabel, onClick: onPress,
  }, children as React.ReactNode);
  const TextInput = ReactModule.forwardRef<HTMLInputElement, Record<string, unknown> & { value?: string; onChangeText?: (text: string) => void; accessibilityLabel?: string }>(
    ({ value, onChangeText, accessibilityLabel, secureTextEntry, style: _style, ...props }, ref) => ReactModule.createElement('input', {
      ...props,
      ref: (node: HTMLInputElement | null) => {
        if (node) Object.assign(node, { clear: () => { node.value = ''; } });
        if (typeof ref === 'function') (ref as (value: HTMLInputElement | null) => void)(node);
        else if (ref && typeof ref === 'object') (ref as { current: HTMLInputElement | null }).current = node;
      },
      value,
      type: secureTextEntry ? 'password' : 'text',
      'aria-label': accessibilityLabel,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => (onChangeText as ((text: string) => void) | undefined)?.(event.target.value),
    }),
  );
  return { ScrollView: element('div'), Text: element('span'), View: element('div'), Pressable, TextInput, StyleSheet: { create: (value: unknown) => value }, Platform: { OS: 'web' } };
});
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('../src/ui/theme', () => ({
  C: { text: '#fff', muted: '#aaa', sage: '#9a9', border: '#333', card: '#222', input: '#111', red: '#f66', bg: '#000' },
  s: new Proxy({}, { get: () => ({}) }),
}));

const session: AuthenticatedSession = Object.freeze({
  authenticated: true,
  workspaceId: 'workspace-one',
  privacyEpoch: 4,
  csrfToken: 'csrf-one',
});

const metadata = (speech = false, openrouter = false) => ({
  workspaceId: session.workspaceId,
  privacyEpoch: session.privacyEpoch,
  credentials: {
    speech: { configured: speech, generation: speech ? 1 : 0 },
    openrouter: { configured: openrouter, generation: openrouter ? 1 : 0 },
  },
});
const response = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mount(initialSession: AuthenticatedSession | null = session, strict = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  function Harness({ currentSession }: { currentSession: AuthenticatedSession | null }) {
    const controller = useCloudCredentials(currentSession);
    return <CloudCredentialsPanel controller={controller} />;
  }
  const render = (nextSession: AuthenticatedSession | null = initialSession) => {
    const child = <Harness currentSession={nextSession} />;
    act(() => root.render(strict ? <React.StrictMode>{child}</React.StrictMode> : child));
  };
  render();
  return {
    host,
    root,
    render,
    async flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); },
    dispose() { act(() => root.unmount()); host.remove(); },
  };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}

function input(host: HTMLElement, label: string): HTMLInputElement {
  const result = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!result) throw new Error(`Missing input ${label}`);
  return result;
}

function click(element: HTMLElement) {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('cloud provider credential settings', () => {
  it('loads metadata only and makes a save single-admission while clearing the field immediately', async () => {
    const pendingSave = deferred<ReturnType<typeof response>>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ...metadata(), speechKey: 'must-not-escape', openrouterKey: 'also-private' }))
      .mockReturnValueOnce(pendingSave.promise);
    vi.stubGlobal('fetch', fetch);
    const view = mount();
    try {
      await view.flush();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe('/api/credentials');
      expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      expect(view.host.textContent).not.toContain('must-not-escape');

      const keyField = input(view.host, 'OpenRouter API key');
      expect(keyField.type).toBe('password');
      expect(keyField.maxLength).toBe(512);
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(keyField, 'router-key-never-rendered-after-submit');
        keyField.dispatchEvent(new Event('input', { bubbles: true }));
        keyField.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(keyField.value).toBe('router-key-never-rendered-after-submit');
      click(button(view.host, 'Save OpenRouter key'));
      expect(input(view.host, 'OpenRouter API key').value).toBe('');
      click(button(view.host, 'Save OpenRouter key'));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'PUT', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
      expect(JSON.stringify(fetch.mock.calls[1][1])).toContain('router-key-never-rendered-after-submit');
      expect(view.host.textContent).not.toContain('router-key-never-rendered-after-submit');

      pendingSave.resolve(response(metadata(false, true)));
      await view.flush();
      expect(view.host.textContent).toContain('OpenRouter · configured');
      expect(view.host.textContent).toContain('OpenRouter credential saved.');
      expect(view.host.textContent).not.toContain('router-key-never-rendered-after-submit');
    } finally { view.dispose(); }
  });

  it('checks the exact unknown command without replaying it and holds writes until confirmed metadata', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata()))
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(response({ status: 'claimed' }))
      .mockResolvedValueOnce(response({ status: 'finished', metadata: metadata(false, true) }))
      .mockResolvedValueOnce(response(metadata(false, true)));
    vi.stubGlobal('fetch', fetch);
    const view = mount();
    try {
      await view.flush();
      const field = input(view.host, 'Azure Speech subscription key');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'speech-secret');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      });
      click(button(view.host, 'Save Azure Speech key'));
      await view.flush();
      expect(input(view.host, 'Azure Speech subscription key').value).toBe('');
      const commandId = new Headers(fetch.mock.calls[1][1].headers).get('X-Still-Command');
      expect(commandId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(button(view.host, 'Inspect pending credential change')).toBeTruthy();
      expect(button(view.host, 'Save OpenRouter key').disabled).toBe(true);

      click(button(view.host, 'Inspect pending credential change'));
      await view.flush();
      expect(fetch.mock.calls[2][0]).toBe(`/api/credential-commands/${commandId}`);
      expect(button(view.host, 'Inspect pending credential change')).toBeTruthy();
      expect(view.host.textContent).toContain('still being checked');

      click(button(view.host, 'Inspect pending credential change'));
      await view.flush();
      expect(fetch.mock.calls[3][0]).toBe(`/api/credential-commands/${commandId}`);
      expect(view.host.querySelector('[aria-label="Inspect pending credential change"]')).toBeNull();
      expect(view.host.textContent).toContain('OpenRouter · configured');
      expect(fetch.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1);
    } finally { view.dispose(); }
  });

  it('keeps the hold after a failed receipt read and requires local confirmation for a per-kind delete', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(metadata(true, true)))
      .mockRejectedValueOnce(new TypeError('lost ack'))
      .mockResolvedValueOnce(response({ status: 'inspect_required' }))
      .mockRejectedValueOnce(new TypeError('receipt unavailable'))
      .mockResolvedValueOnce(response({ status: 'finished', metadata: metadata(true, true) }))
      .mockResolvedValueOnce(response(metadata(true, true)))
      .mockResolvedValueOnce(response({ ...metadata(true, false), credentials: {
        ...metadata(true, false).credentials,
        openrouter: { configured: false, generation: 2 },
      } }));
    vi.stubGlobal('fetch', fetch);
    const view = mount();
    try {
      await view.flush();
      const field = input(view.host, 'OpenRouter API key');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'first-key');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      });
      click(button(view.host, 'Save OpenRouter key'));
      await view.flush();
      click(button(view.host, 'Inspect pending credential change'));
      await view.flush();
      expect(view.host.textContent).toContain('pending credential change');
      expect(button(view.host, 'Save Azure Speech key').disabled).toBe(true);

      click(button(view.host, 'Inspect pending credential change'));
      await view.flush();
      expect(button(view.host, 'Inspect pending credential change')).toBeTruthy();
      expect(view.host.textContent).toContain('could not be reached');

      click(button(view.host, 'Inspect pending credential change'));
      await view.flush();
      expect(view.host.textContent).toContain('OpenRouter · configured');

      click(button(view.host, 'Remove OpenRouter key'));
      expect(fetch.mock.calls).toHaveLength(6);
      expect(button(view.host, 'Confirm remove OpenRouter key')).toBeTruthy();
      click(button(view.host, 'Confirm remove OpenRouter key'));
      await view.flush();
      expect(fetch.mock.calls[6][1].method).toBe('DELETE');
      expect(JSON.parse(String(fetch.mock.calls[6][1].body)).kinds).toEqual(['openrouter']);
      expect(view.host.textContent).toContain('OpenRouter · not configured');
    } finally { view.dispose(); }
  });

  it('requires fresh metadata after a same-workspace service replacement before releasing an inherited unknown hold', async () => {
    const currentMetadata = (configured: boolean, generation: number) => ({
      workspaceId: session.workspaceId,
      privacyEpoch: session.privacyEpoch,
      credentials: {
        speech: { configured: false, generation: 0 },
        openrouter: { configured, generation },
      },
    });
    const historical = {
      workspaceId: session.workspaceId,
      privacyEpoch: session.privacyEpoch,
      credentials: {
        speech: { configured: false, generation: 0 },
        openrouter: { configured: true, generation: 1 },
      },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(currentMetadata(false, 0)))
      .mockRejectedValueOnce(new TypeError('acknowledgement lost'))
      .mockResolvedValueOnce(response(currentMetadata(false, 1)))
      .mockResolvedValueOnce(response({ status: 'finished', metadata: historical }))
      .mockResolvedValueOnce(response({ error: 'private server detail' }, 503))
      .mockResolvedValueOnce(response({ status: 'finished', metadata: historical }))
      .mockResolvedValueOnce(response(currentMetadata(false, 2)));
    vi.stubGlobal('fetch', fetch);
    const view = mount();
    try {
      await view.flush();
      const field = input(view.host, 'OpenRouter API key');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'one-time-key');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      });
      click(button(view.host, 'Save OpenRouter key'));
      await view.flush();
      const commandId = new Headers(fetch.mock.calls[1][1].headers).get('X-Still-Command');
      const renewed = Object.freeze({ ...session, csrfToken: 'csrf-renewed' });
      view.render(renewed);
      await view.flush();
      expect(fetch.mock.calls[2][0]).toBe('/api/credentials');
      expect(button(view.host, 'Inspect pending credential change')).toBeTruthy();

      click(button(view.host, 'Inspect pending credential change'));
      await view.flush();
      expect(fetch.mock.calls[3][0]).toBe(`/api/credential-commands/${commandId}`);
      expect(fetch.mock.calls[4][0]).toBe('/api/credentials');
      expect(view.host.textContent).toContain('could not be completed');
      expect(button(view.host, 'Inspect pending credential change')).toBeTruthy();
      expect(button(view.host, 'Save Azure Speech key').disabled).toBe(true);

      click(button(view.host, 'Inspect pending credential change'));
      await view.flush();
      expect(fetch.mock.calls[5][0]).toBe(`/api/credential-commands/${commandId}`);
      expect(fetch.mock.calls[6][0]).toBe('/api/credentials');
      expect(view.host.textContent).toContain('OpenRouter · not configured');
      expect(view.host.querySelector('[aria-label="Inspect pending credential change"]')).toBeNull();
      expect(fetch.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1);
    } finally { view.dispose(); }
  });

  it.each(['PUT', 'DELETE'] as const)('records the exact %s ID before dispatch and carries the hold through CSRF replacement', async (method) => {
    const oldAck = deferred<ReturnType<typeof response>>();
    const initial = method === 'PUT' ? metadata(false, false) : metadata(false, true);
    const currentAfterReplacement = method === 'PUT' ? metadata(false, false) : {
      ...metadata(false, true), credentials: {
        speech: { configured: false, generation: 0 },
        openrouter: { configured: true, generation: 2 },
      },
    };
    const historicalReceipt = method === 'PUT' ? metadata(false, true) : {
      ...metadata(false, false), credentials: {
        speech: { configured: false, generation: 0 },
        openrouter: { configured: false, generation: 1 },
      },
    };
    let credentialReads = 0;
    const fetch = vi.fn((path: string, init: RequestInit) => {
      if (init.method === 'GET' && path === '/api/credentials') {
        return Promise.resolve(response(credentialReads++ === 0 ? initial : currentAfterReplacement));
      }
      if (init.method === method) return oldAck.promise;
      if (path.startsWith('/api/credential-commands/')) return Promise.resolve(response({ status: 'finished', metadata: historicalReceipt }));
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetch);
    const view = mount();
    try {
      await view.flush();
      if (method === 'PUT') {
        const field = input(view.host, 'OpenRouter API key');
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'dispatch-key');
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        });
        click(button(view.host, 'Save OpenRouter key'));
      } else {
        click(button(view.host, 'Remove OpenRouter key'));
        click(button(view.host, 'Confirm remove OpenRouter key'));
      }
      const mutation = fetch.mock.calls.find(([, init]) => init.method === method);
      expect(mutation).toBeTruthy();
      const commandId = new Headers(mutation?.[1].headers).get('X-Still-Command');
      expect(commandId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(button(view.host, 'Inspect pending credential change').disabled).toBe(true);

      view.render(Object.freeze({ ...session, csrfToken: 'csrf-renewed' }));
      await view.flush();
      expect(button(view.host, 'Inspect pending credential change').disabled).toBe(false);
      if (method === 'PUT') oldAck.resolve(response(metadata(false, true)));
      else oldAck.reject(new TypeError('late delete acknowledgement lost'));
      await view.flush();
      expect(button(view.host, 'Inspect pending credential change')).toBeTruthy();
      expect(view.host.textContent).toContain(method === 'PUT' ? 'OpenRouter · not configured' : 'OpenRouter · configured');

      click(button(view.host, 'Inspect pending credential change'));
      await view.flush();
      expect(fetch.mock.calls.some(([path]) => path === `/api/credential-commands/${commandId}`)).toBe(true);
      expect(view.host.querySelector('[aria-label="Inspect pending credential change"]')).toBeNull();
      expect(view.host.textContent).toContain(method === 'PUT' ? 'OpenRouter · not configured' : 'OpenRouter · configured');
      expect(fetch.mock.calls.filter(([, init]) => init.method === method)).toHaveLength(1);
    } finally { view.dispose(); }
  });

  it('does not publish a stale response after owner replacement or unmount, and StrictMode replays a fresh reader', async () => {
    const first = deferred<ReturnType<typeof response>>();
    const fetch = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(response(metadata(true, true)))
      .mockResolvedValueOnce(response({
        workspaceId: 'workspace-two', privacyEpoch: 8,
        credentials: { speech: { configured: false, generation: 0 }, openrouter: { configured: true, generation: 2 } },
      }));
    vi.stubGlobal('fetch', fetch);
    const view = mount(session, true);
    try {
      await view.flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      const draft = input(view.host, 'Azure Speech subscription key');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(draft, 'uncommitted-key');
        draft.dispatchEvent(new Event('input', { bubbles: true }));
        draft.dispatchEvent(new Event('change', { bubbles: true }));
      });
      click(button(view.host, 'Remove OpenRouter key'));
      expect(button(view.host, 'Confirm remove OpenRouter key')).toBeTruthy();
      const next = Object.freeze({ ...session, workspaceId: 'workspace-two', privacyEpoch: 8, csrfToken: 'csrf-two' });
      view.render(next);
      expect(view.host.textContent).not.toContain('Azure Speech · configured');
      expect(input(view.host, 'Azure Speech subscription key').value).toBe('');
      expect(view.host.querySelector('[aria-label="Confirm remove OpenRouter key"]')).toBeNull();
      expect(button(view.host, 'Save OpenRouter key').disabled).toBe(true);
      await view.flush();
      first.resolve(response(metadata(true)));
      await view.flush();
      expect(view.host.textContent).toContain('OpenRouter · configured');
      expect(view.host.textContent).toContain('Azure Speech · not configured');

      const delayed = deferred<ReturnType<typeof response>>();
      fetch.mockReturnValueOnce(delayed.promise);
      click(button(view.host, 'Refresh saved status'));
      view.dispose();
      delayed.resolve(response({
        workspaceId: 'workspace-two', privacyEpoch: 8,
        credentials: { speech: { configured: true, generation: 1 }, openrouter: { configured: false, generation: 0 } },
      }));
      await Promise.resolve();
      expect(view.host.textContent).toBe('');
    } finally {
      if (view.host.isConnected) view.dispose();
    }
  });
});
