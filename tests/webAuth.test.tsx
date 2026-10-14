/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUEST_TIMEOUT_MS, AuthClientError, getAuthSession, loginWithPassword, logoutSession } from '../src/web/authClient';
import { AuthGate } from '../src/web/AuthGate';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string, kind: 'basic' | 'pressable' | 'input' = 'basic') => (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    const { children, style: _style, accessibilityRole, accessibilityLabel, accessibilityState, onPress, onChangeText, secureTextEntry, editable, ...rest } = props;
    const mapped: Record<string, unknown> = {
      ...rest,
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
      ...(accessibilityState ? { 'aria-checked': (accessibilityState as { selected?: boolean }).selected } : {}),
      ...(onPress ? { onClick: onPress } : {}),
    };
    if (kind === 'input') {
      mapped.type = secureTextEntry ? 'password' : 'text';
      mapped.disabled = editable === false;
      mapped.onChange = (event: Event) => {
        if (typeof onChangeText === 'function') onChangeText((event.target as HTMLInputElement).value);
      };
    }
    return ReactModule.createElement(tag, mapped, children);
  };
  return {
    ActivityIndicator: () => ReactModule.createElement('span', { role: 'progressbar' }, 'Loading'),
    KeyboardAvoidingView: element('div'),
    Platform: { OS: 'web' },
    Pressable: element('button', 'pressable'),
    ScrollView: element('div'),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: element('span'),
    TextInput: element('input', 'input'),
    View: element('div'),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const ReactModule = await import('react');
  return { SafeAreaView: ({ children, style: _style }: { children?: React.ReactNode; style?: unknown }) => ReactModule.createElement('div', null, children) };
});

const guest = { authenticated: false as const, csrfToken: 'guest-csrf' };
const signedIn = { authenticated: true as const, workspaceId: 'workspace-1', privacyEpoch: 3, csrfToken: 'session-csrf' };
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('same-origin web auth transport', () => {
  it('uses the fixed same-origin paths, credentials, no-store session reads, and CSRF JSON posts', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(guest))
      .mockResolvedValueOnce(response(signedIn))
      .mockResolvedValueOnce(response(guest));
    vi.stubGlobal('fetch', fetch);

    await expect(getAuthSession()).resolves.toEqual(guest);
    await expect(loginWithPassword('secret value', 'guest-csrf')).resolves.toEqual(signedIn);
    await expect(logoutSession('session-csrf')).resolves.toEqual(guest);

    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/auth/session', '/auth/login', '/auth/logout']);
    expect(fetch.mock.calls.map(([, init]) => init.credentials)).toEqual(['same-origin', 'same-origin', 'same-origin']);
    expect(fetch.mock.calls.map(([, init]) => init.redirect)).toEqual(['error', 'error', 'error']);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store' });
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': 'guest-csrf' }, body: JSON.stringify({ password: 'secret value' }),
    });
    expect(fetch.mock.calls[2][1]).toMatchObject({
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': 'session-csrf' }, body: '{}',
    });
    expect(fetch.mock.calls.some(([path]) => String(path).startsWith('http'))).toBe(false);
  });

  it('rejects malformed DTOs and maps HTTP errors to fixed safe messages', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ authenticated: true, csrfToken: 'x' }));
    vi.stubGlobal('fetch', fetch);
    await expect(getAuthSession()).rejects.toMatchObject({ kind: 'malformed', requiresSessionCheck: true });

    fetch.mockResolvedValueOnce(response({ error: 'password=secret', detail: 'private server internals' }, 429));
    const rateLimit = await loginWithPassword('secret', 'csrf').catch((error: unknown) => error);
    expect(rateLimit).toBeInstanceOf(AuthClientError);
    expect(rateLimit).toMatchObject({ status: 429, requiresSessionCheck: false });
    expect((rateLimit as Error).message).toBe('Too many sign-in attempts. Wait a moment, then check session before trying again.');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('times out as an uncertain request without retrying', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_path: string, init: RequestInit) => new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      vi.stubGlobal('fetch', fetch);
      const request = loginWithPassword('secret', 'csrf');
      const rejected = expect(request).rejects.toMatchObject({ kind: 'network', requiresSessionCheck: true });
      await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AuthGate session ownership', () => {
  it('shows accessible password entry, clears it after an uncertain login, and reconciles only after an explicit check', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(guest))
      .mockRejectedValueOnce(new TypeError('network interrupted'))
      .mockResolvedValueOnce(response(signedIn));
    vi.stubGlobal('fetch', fetch);
    const renderWorkspace = vi.fn((_session, onLogout) => React.createElement('button', { onClick: onLogout }, 'Workspace logout'));
    await act(async () => {
      root.render(React.createElement(AuthGate, { renderWorkspace }));
    });
    const passwordInput = host.querySelector('input[aria-label="Workspace password"]') as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.type).toBe('password');
    expect(host.querySelector('button[aria-label="Show password"]')).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(passwordInput, 'never-store-this');
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const signInButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Sign in') as HTMLButtonElement;
    await act(async () => { signInButton().click(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].body).toBe(JSON.stringify({ password: 'never-store-this' }));
    expect(host.textContent).toContain('Check session');
    expect(host.textContent).not.toContain('never-store-this');

    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][0]).toBe('/auth/session');
    expect(host.textContent).toContain('Workspace logout');
    expect(renderWorkspace).toHaveBeenCalledWith(signedIn, expect.any(Function));
  });

  it('keeps the workspace blocked after an uncertain logout until a manual session read confirms guest state', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(signedIn))
      .mockRejectedValueOnce(new TypeError('lost logout acknowledgement'))
      .mockResolvedValueOnce(response(guest));
    vi.stubGlobal('fetch', fetch);
    const renderWorkspace = vi.fn((_session, onLogout) => React.createElement('button', { onClick: onLogout }, 'Workspace logout'));
    await act(async () => { root.render(React.createElement(AuthGate, { renderWorkspace })); });
    expect(host.textContent).toContain('Workspace logout');
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain('Check session');
    expect(host.textContent).not.toContain('Workspace logout');
    expect(renderWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][0]).toBe('/auth/session');
    expect(host.querySelector('input[aria-label="Workspace password"]')).not.toBeNull();
  });

  it('requires a manual challenge refresh after a wrong password before another login', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(guest))
      .mockResolvedValueOnce(response({ error: 'private details' }, 401))
      .mockResolvedValueOnce(response({ authenticated: false, csrfToken: 'fresh-guest-csrf' }))
      .mockResolvedValueOnce(response(signedIn));
    vi.stubGlobal('fetch', fetch);
    const renderWorkspace = vi.fn(() => React.createElement('span', null, 'Workspace'));
    await act(async () => { root.render(React.createElement(AuthGate, { renderWorkspace })); });

    const fillPassword = async (value: string) => act(async () => {
      const input = host.querySelector('input[aria-label="Workspace password"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const clickButton = async (label: string) => act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === label)?.click();
    });

    await fillPassword('wrong-password');
    await clickButton('Sign in');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('That password was not accepted. Check session before trying again.');
    expect(host.textContent).toContain('Check session');
    expect(host.querySelector('input[aria-label="Workspace password"]')).toBeNull();

    await clickButton('Check session');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][0]).toBe('/auth/session');
    await fillPassword('correct-password');
    await clickButton('Sign in');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3][1].headers).toMatchObject({ 'X-Still-CSRF': 'fresh-guest-csrf' });
    expect(host.textContent).toContain('Workspace');
  });

  it('admits only one same-tick password submission and does not abort its request', async () => {
    let finishLogin: ((value: ReturnType<typeof response>) => void) | undefined;
    const loginResponse = new Promise<ReturnType<typeof response>>((resolve) => { finishLogin = resolve; });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(guest))
      .mockReturnValueOnce(loginResponse);
    vi.stubGlobal('fetch', fetch);
    await act(async () => { root.render(React.createElement(AuthGate, { renderWorkspace: () => React.createElement('span', null, 'Workspace') })); });
    await act(async () => {
      const input = host.querySelector('input[aria-label="Workspace password"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'private-password');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const signIn = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Sign in') as HTMLButtonElement;
    act(() => { signIn.click(); signIn.click(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal?.aborted).toBe(false);
    await act(async () => { finishLogin?.(response(signedIn)); await loginResponse; });
    expect(host.textContent).toContain('Workspace');
  });

  it('admits only one same-tick session check', async () => {
    let finishCheck: ((value: ReturnType<typeof response>) => void) | undefined;
    const checkResponse = new Promise<ReturnType<typeof response>>((resolve) => { finishCheck = resolve; });
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockReturnValueOnce(checkResponse);
    vi.stubGlobal('fetch', fetch);
    await act(async () => { root.render(React.createElement(AuthGate, { renderWorkspace: () => null })); });
    const check = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check session') as HTMLButtonElement;
    act(() => { check.click(); check.click(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal?.aborted).toBe(false);
    await act(async () => { finishCheck?.(response(guest)); await checkResponse; });
    expect(host.querySelector('input[aria-label="Workspace password"]')).not.toBeNull();
  });

  it('admits one same-tick logout and fences a saved logout callback after unmount', async () => {
    let finishLogout: ((value: ReturnType<typeof response>) => void) | undefined;
    const logoutResponse = new Promise<ReturnType<typeof response>>((resolve) => { finishLogout = resolve; });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(signedIn))
      .mockReturnValueOnce(logoutResponse);
    vi.stubGlobal('fetch', fetch);
    let savedLogout: (() => void) | undefined;
    await act(async () => {
      root.render(React.createElement(AuthGate, {
        renderWorkspace: (_session, onLogout) => { savedLogout = onLogout; return React.createElement('span', null, 'Workspace'); },
      }));
    });
    act(() => { savedLogout?.(); savedLogout?.(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal?.aborted).toBe(false);

    act(() => root.unmount());
    savedLogout?.();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal?.aborted).toBe(true);
    await act(async () => { finishLogout?.(response(guest)); await logoutResponse; });
  });

  it('does not poll, retry, or persist authentication in browser storage', async () => {
    const fetch = vi.fn().mockResolvedValue(response(guest));
    const storageRead = vi.spyOn(Storage.prototype, 'getItem');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const storageRemove = vi.spyOn(Storage.prototype, 'removeItem');
    vi.stubGlobal('fetch', fetch);
    await act(async () => { root.render(React.createElement(AuthGate, { renderWorkspace: () => null })); });
    await act(async () => { await Promise.resolve(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storageRead).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
  });
});
