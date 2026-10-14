import { describe, expect, it, vi } from 'vitest';
import {
  OAuthConnectionIntentChangedError,
  OAuthConnectionIntentOwnership,
  oauthInstallFailureWithCleanupContext,
  runOwnedOAuthConnection,
  type OAuthConnectionIntentSnapshot,
} from '../src/ui/oauthConnectionIntent';

const controllerRef = {};
const resourcesRef = {};
const privacyRef = {};

function snapshot(overrides: Partial<OAuthConnectionIntentSnapshot> = {}): OAuthConnectionIntentSnapshot {
  return {
    workspaceGeneration: 3,
    controller: controllerRef, resources: resourcesRef, privacy: privacyRef,
    sessionEpoch: 'epoch-a', sessionRuntimeId: 'runtime-a',
    provider: 'google', accountId: 'account-a', accountLifecycle: 'generation:4;token:token-a;identity:google|subject-a',
    platform: 'ios', clientId: 'client-a', nativeRedirectUri: 'still://oauth', webRedirectUri: 'https://example.test/oauth',
    authority: undefined, redirectUri: 'still://oauth', capabilities: ['mail.read'], scopes: ['openid', 'mail.read'],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe('OAuth connection intent ownership', () => {
  it('preserves typed privacy errors even when credential cleanup is pending', () => {
    const privacyError = Object.assign(new Error('privacy epoch changed'), { code: 'stale_epoch' });
    const result = oauthInstallFailureWithCleanupContext(privacyError, 2, (error) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'stale_epoch');
    expect(result).toBe(privacyError);
  });

  it('adds cleanup context to non-privacy install failures only when cleanup is pending', () => {
    const ordinaryError = new Error('install failed');
    const classifyPrivacy = () => false;
    expect(oauthInstallFailureWithCleanupContext(ordinaryError, 0, classifyPrivacy)).toBe(ordinaryError);
    expect(oauthInstallFailureWithCleanupContext(ordinaryError, 2, classifyPrivacy)).toEqual(
      new Error('The account was not connected. Credential cleanup is pending for 2 items; retry below.'),
    );
  });

  it.each([
    ['workspace generation', { workspaceGeneration: 4 }],
    ['controller owner', { controller: {} }],
    ['resource owner', { resources: {} }],
    ['privacy owner', { privacy: {} }],
    ['session epoch', { sessionEpoch: 'epoch-b' }],
    ['session runtime', { sessionRuntimeId: 'runtime-b' }],
    ['account lifecycle', { accountLifecycle: 'generation:5;token:token-b;identity:google|subject-a' }],
    ['auth configuration', { clientId: 'client-b' }],
    ['redirect configuration', { redirectUri: 'still://changed' }],
    ['requested capabilities', { capabilities: ['mail.read', 'calendar.read'] }],
  ])('rejects a stale %s after the system browser returns without exchanging or installing', async (_label, changed) => {
    const ownership = new OAuthConnectionIntentOwnership();
    const captured = snapshot();
    const owner = ownership.begin(captured);
    let current = captured;
    const browser = deferred<{ code: string }>();
    const exchange = vi.fn(async () => ({ token: 'secret-test-token' }));
    const install = vi.fn(async (_result: { token: string }) => undefined);
    const assertCurrent = () => ownership.assertCurrent(owner, current);
    const task = runOwnedOAuthConnection({
      assertCurrent,
      authorize: () => browser.promise,
      validateHandoff: () => undefined,
      exchange,
      install: async (result, guard) => { guard(); await install(result); },
    });

    current = snapshot(changed);
    browser.resolve({ code: 'test-code' });
    await expect(task).rejects.toBeInstanceOf(OAuthConnectionIntentChangedError);
    expect(exchange).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('does not let an old completion invalidate a newer connection attempt', () => {
    const ownership = new OAuthConnectionIntentOwnership();
    const oldOwner = ownership.begin(snapshot());
    const newSnapshot = snapshot({ workspaceGeneration: 4 });
    const newOwner = ownership.begin(newSnapshot);
    ownership.invalidate(oldOwner);
    expect(ownership.isCurrent(newOwner)).toBe(true);
    expect(() => ownership.assertCurrent(newOwner, newSnapshot)).not.toThrow();
  });

  it('checks the guard on each exchange beforeStart and before install', async () => {
    const ownership = new OAuthConnectionIntentOwnership();
    const captured = snapshot();
    const owner = ownership.begin(captured);
    let current = captured;
    const assertCurrent = () => ownership.assertCurrent(owner, current);
    const authorize = vi.fn(async () => ({ code: 'test-code' }));
    const exchange = vi.fn(async (_handoff: { code: string }, guard: () => void) => {
      guard();
      guard();
      return { token: 'test' };
    });
    const install = vi.fn(async (_result: { token: string }) => undefined);
    const completion = await runOwnedOAuthConnection({
      assertCurrent,
      assertWorkspaceCurrent: () => ownership.assertOwnerCurrent(owner),
      authorize,
      validateHandoff: () => undefined,
      exchange,
      install: async (result, guard) => {
        guard();
        await install(result);
        current = snapshot({ accountLifecycle: 'the successful install changed this account' });
      },
    });
    expect(completion.canPublish).toBe(true);
    expect(authorize).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
  });

  it('blocks a subsequent OAuth request at beforeStart if intent changes during exchange', async () => {
    const ownership = new OAuthConnectionIntentOwnership();
    const captured = snapshot();
    const owner = ownership.begin(captured);
    let current = captured;
    const assertCurrent = () => ownership.assertCurrent(owner, current);
    const install = vi.fn(async (_result: { token: string }, _guard: () => void) => undefined);
    let startedRequests = 0;
    const task = runOwnedOAuthConnection({
      assertCurrent,
      assertWorkspaceCurrent: () => ownership.assertOwnerCurrent(owner),
      authorize: async () => ({ code: 'test-code' }),
      validateHandoff: () => undefined,
      exchange: async (_handoff: { code: string }, beforeStart) => {
        beforeStart();
        startedRequests += 1;
        current = snapshot({ sessionEpoch: 'epoch-changed' });
        beforeStart();
        return { token: 'must-not-install' };
      },
      install,
    });
    await expect(task).rejects.toBeInstanceOf(OAuthConnectionIntentChangedError);
    expect(startedRequests).toBe(1);
    expect(install).not.toHaveBeenCalled();
  });

  it('returns a committed result without publishing when the workspace owner is stale afterward', async () => {
    const ownership = new OAuthConnectionIntentOwnership();
    const captured = snapshot();
    const owner = ownership.begin(captured);
    const assertCurrent = () => ownership.assertCurrent(owner, captured);
    const completion = await runOwnedOAuthConnection({
      assertCurrent,
      assertWorkspaceCurrent: () => ownership.assertOwnerCurrent(owner),
      authorize: async () => ({ code: 'test-code' }),
      validateHandoff: () => undefined,
      exchange: async () => ({ token: 'committed' }),
      install: async (_result, guard) => { guard(); ownership.invalidate(owner); },
    });
    expect(completion.result).toEqual({ token: 'committed' });
    expect(completion.canPublish).toBe(false);
  });
});
