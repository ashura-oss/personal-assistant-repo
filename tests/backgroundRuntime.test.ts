import { describe, expect, it, vi } from 'vitest';
import type { OAuthTokenStore } from '../src/connectors';
import type { PrivacyService, PrivacyWorkspaceSession } from '../src/privacy/service';
import type { PrivacyPublicStatus } from '../src/privacy/types';
import type { BackgroundMailRefreshEngineDependencies, BackgroundMailRefreshOutcome } from '../src/background/mailRefresh.types';
import { createBackgroundMailRefreshRuntime } from '../src/background/runtime.native';

const session: PrivacyWorkspaceSession = { epoch: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222' };
const readyStatus = {
  phase: 'ready' as const, epoch: session.epoch, activeWriterCount: 0, pendingCleanupCount: 0, failedCleanupCount: 0,
  limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096, writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 },
  coverage: 'tracked_with_legacy_limits' as const,
};

function fakePrivacy(status: PrivacyPublicStatus = readyStatus) {
  return {
    reconcileStartupWriters: vi.fn(async () => status),
    getStatus: vi.fn(async () => status),
    openWorkspace: vi.fn(async () => session),
    assertWorkspaceEpoch: vi.fn(async () => undefined),
    withWriter: vi.fn(async (_epoch: string, _descriptor: unknown, actual: (lease: never, scope: never) => Promise<unknown>) => actual(undefined as never, undefined as never)),
  } as unknown as PrivacyService;
}

function runtime(options: {
  status?: PrivacyPublicStatus;
  run?: (signal?: AbortSignal) => Promise<BackgroundMailRefreshOutcome>;
  onEngine?: (dependencies: BackgroundMailRefreshEngineDependencies) => void;
} = {}) {
  const privacy = fakePrivacy(options.status ?? readyStatus);
  const createStateStore = vi.fn(() => { throw new Error('fake engine must not open a store'); });
  const tokenStore: OAuthTokenStore = {
    async get() { return null; },
    async set() {},
  };
  const createEngine = vi.fn((dependencies: BackgroundMailRefreshEngineDependencies) => {
    options.onEngine?.(dependencies);
    return { run: options.run ?? (async () => ({ status: 'skipped', attempted: 0, completed: 0, failed: 0, skipped: 0, reason: 'disabled' })) };
  });
  const taskRuntime = createBackgroundMailRefreshRuntime({ privacy, createStateStore, tokenStore, createEngine });
  return { taskRuntime, privacy, createStateStore, createEngine };
}

describe('headless background mail refresh runtime', () => {
  it('reconciles privacy writers and refuses bootstrap while cleanup is active', async () => {
    const blocked = { ...readyStatus, phase: 'erasing' as const, pendingCleanupCount: 1 };
    const subject = runtime({ status: blocked });
    expect(await subject.taskRuntime.run()).toBe(false);
    expect(subject.privacy.reconcileStartupWriters).toHaveBeenCalledOnce();
    expect(subject.privacy.openWorkspace).not.toHaveBeenCalled();
    expect(subject.createEngine).not.toHaveBeenCalled();
    expect(subject.createStateStore).not.toHaveBeenCalled();
  });

  it('creates a fresh headless engine only after a clean privacy session and treats safe skips as success', async () => {
    let received: BackgroundMailRefreshEngineDependencies | undefined;
    const subject = runtime({ onEngine: (dependencies) => { received = dependencies; } });
    expect(await subject.taskRuntime.run()).toBe(true);
    expect(subject.privacy.reconcileStartupWriters).toHaveBeenCalledOnce();
    expect(subject.privacy.openWorkspace).toHaveBeenCalledOnce();
    expect(subject.createEngine).toHaveBeenCalledOnce();
    expect(received?.session).toEqual(session);
    expect(received?.createStateStore).toBe(subject.createStateStore);
    expect(subject.createStateStore).not.toHaveBeenCalled();
  });

  it('single-flights concurrent callbacks through actual engine settlement', async () => {
    let finish!: () => void;
    const subject = runtime({ run: () => new Promise((resolve) => {
      finish = () => resolve({ status: 'skipped', attempted: 0, completed: 0, failed: 0, skipped: 0, reason: 'cooldown' });
    }) });
    const first = subject.taskRuntime.run();
    const second = subject.taskRuntime.run();
    expect(second).toBe(first);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(subject.createEngine).toHaveBeenCalledOnce();
    finish();
    expect(await first).toBe(true);
    expect(subject.createEngine).toHaveBeenCalledOnce();
  });

  it('returns failure for an engine failure without automatic retry', async () => {
    const failed = { status: 'failed' as const, attempted: 1, completed: 0, failed: 1, skipped: 0, reason: 'provider_unavailable' as const };
    const subject = runtime({ run: async () => failed });
    expect(await subject.taskRuntime.run()).toBe(false);
    expect(subject.createEngine).toHaveBeenCalledOnce();
  });
});
