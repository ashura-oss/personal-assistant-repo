import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import type { PrivacyPublicStatus } from '../src/privacy/types';

const emptyStatus = {
  phase: 'ready' as const,
  epoch: '11111111-1111-4111-8111-111111111111',
  activeWriterCount: 0,
  pendingCleanupCount: 0,
  failedCleanupCount: 0,
  limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096, writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 },
  coverage: 'tracked_with_legacy_limits' as const,
};

class RefreshStore implements StateStore {
  value?: AppState;
  loads = 0;
  saveGate?: Promise<void>;
  onSaveStarted?: () => void;
  failLoad = false;

  async load(): Promise<AppState | undefined> {
    this.loads += 1;
    if (this.failLoad) throw new Error('storage unavailable');
    return this.value ? structuredClone(this.value) : undefined;
  }

  async save(state: AppState): Promise<void> {
    if (this.saveGate) {
      this.onSaveStarted?.();
      await this.saveGate;
    }
    this.value = structuredClone(state);
  }

  async clear(): Promise<void> { this.value = undefined; }
}

function makeController(store = new RefreshStore()) {
  let status: PrivacyPublicStatus = emptyStatus;
  const integration = {
    privacySession: { epoch: emptyStatus.epoch, assertCurrent: vi.fn(async () => undefined), getStatus: async () => status },
  };
  const controller = new AppControllerImpl(store, {}, integration);
  return { controller, store, setStatus: (next: PrivacyPublicStatus) => { status = next; } };
}

describe('refreshing the foreground cache after background work', () => {
  it('reloads persisted background changes only after startup and preserves saved state', async () => {
    const { controller, store } = makeController();
    await controller.load();
    const backgroundState = structuredClone(store.value!);
    backgroundState.settings.timezone = 'Pacific/Honolulu';
    store.value = backgroundState;

    await controller.refreshPersistedWorkspace();
    expect(controller.getSnapshot().settings.timezone).toBe('Pacific/Honolulu');
    expect(store.loads).toBe(2);
  });

  it('serializes refresh behind a queued mutation instead of dropping its write', async () => {
    const store = new RefreshStore();
    const { controller } = makeController(store);
    await controller.load();
    let started!: () => void;
    let release!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    store.saveGate = new Promise<void>((resolve) => { release = resolve; });
    store.onSaveStarted = started;

    const mutation = controller.saveSettings({ timezone: 'America/Los_Angeles' });
    await hasStarted;
    const refresh = controller.refreshPersistedWorkspace();
    release();
    await mutation;
    await refresh;
    expect(controller.getSnapshot().settings.timezone).toBe('America/Los_Angeles');
    expect(store.loads).toBe(2);
  });

  it('refuses a reload while a writer is active', async () => {
    const { controller, store, setStatus } = makeController();
    await controller.load();
    setStatus({ ...emptyStatus, phase: 'writer_active', activeWriterCount: 1 });
    await expect(controller.refreshPersistedWorkspace()).rejects.toThrow(/storage is still in use/i);
    expect(store.loads).toBe(1);
  });

  it('does not convert failed startup into an implicit retry', async () => {
    const store = new RefreshStore();
    store.failLoad = true;
    const { controller } = makeController(store);
    await expect(controller.load()).rejects.toThrow('storage unavailable');
    await expect(controller.refreshPersistedWorkspace()).rejects.toThrow(/only after startup is ready/i);
    expect(store.loads).toBe(1);
  });
});
