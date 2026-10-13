import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyEngine, PrivacyEngineError } from '../src/privacy/engine';
import { createPrivacyService } from '../src/privacy/service';
import { createEmptyPrivacyControlState, PRIVACY_CONTROL_LIMITS, validatePrivacyControlState } from '../src/privacy/schema';
import type {
  PrivacyCleanupTarget,
  PrivacyControlState,
  PrivacyControlStore,
  PrivacyEraseAdapter,
  PrivacyOwner,
  PrivacyWriterArbitration,
} from '../src/privacy/types';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => undefined }));

afterEach(() => vi.unstubAllGlobals());

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

class MemoryControlStore implements PrivacyControlStore {
  state: PrivacyControlState;
  conflictNext = false;
  failNext = false;
  saves = 0;

  constructor() { this.state = createEmptyPrivacyControlState(uuid(1)); }
  async read() { return structuredClone(validatePrivacyControlState(this.state)); }
  async compareAndSwap(expectedRevision: string, next: PrivacyControlState) {
    if (this.conflictNext) { this.conflictNext = false; throw Object.assign(new Error('changed'), { code: 'conflict' }); }
    if (expectedRevision !== this.state.revision) throw Object.assign(new Error('changed'), { code: 'conflict' });
    if (this.failNext) { this.failNext = false; throw new Error('durable write failed'); }
    this.state = structuredClone(validatePrivacyControlState(next));
    this.saves += 1;
  }
}

class TestLocks {
  private tail = Promise.resolve();
  writerDepth = 0;
  cleanupDepth = 0;
  owner: PrivacyOwner = { platform: 'web', runtimeId: uuid(9) };

  async withWriterLock<T>(work: () => Promise<T>): Promise<T> {
    return this.run(async () => { this.writerDepth += 1; try { return await work(); } finally { this.writerDepth -= 1; } });
  }
  async withCleanupLock<T>(work: () => Promise<T>): Promise<T> {
    return this.run(async () => { this.cleanupDepth += 1; try { return await work(); } finally { this.cleanupDepth -= 1; } });
  }
  async getRuntimeOwner() { return { ...this.owner }; }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}

class TestEraseAdapter implements PrivacyEraseAdapter {
  live = new Set<string>();
  erased: string[] = [];
  failOnce = new Set<string>();
  failVerifyOnce = new Set<string>();
  beforeErase?: (target: PrivacyCleanupTarget) => void;
  async erase(target: PrivacyCleanupTarget) {
    this.beforeErase?.(target);
    const key = JSON.stringify(target);
    this.erased.push(key);
    if (this.failOnce.delete(key)) throw new Error('raw platform error must not escape');
    if (!this.failVerifyOnce.has(key)) this.live.delete(key);
  }
  async verifyGone(target: PrivacyCleanupTarget) {
    const key = JSON.stringify(target);
    if (this.failVerifyOnce.delete(key)) return false;
    return !this.live.has(key);
  }
}

function setup(owner?: PrivacyOwner) {
  const store = new MemoryControlStore();
  const locks = new TestLocks();
  if (owner) locks.owner = owner;
  const adapter = new TestEraseAdapter();
  let id = 10;
  const engine = new PrivacyEngine({
    controlStore: store,
    arbitration: locks as PrivacyWriterArbitration,
    adapter,
    now: () => new Date('2026-10-13T00:00:00.000Z'),
    uuid: () => uuid(id++),
  });
  return { store, locks, adapter, engine };
}

describe('privacy control schema', () => {
  it('validates canonical manifests and rejects unsafe or unknown fields without rewriting', async () => {
    const state = createEmptyPrivacyControlState(uuid(1));
    const valid = validatePrivacyControlState({ ...state, legacyMarkdownPaths: ['people/alex.md'] });
    expect(valid.legacyMarkdownPaths).toEqual(['people/alex.md']);
    expect(() => validatePrivacyControlState({ ...state, legacyMarkdownPaths: ['../secret.md'] })).toThrow(/invalid/i);
    expect(() => validatePrivacyControlState({ ...state, oauthTokenRefs: [uuid(2), uuid(2)] })).toThrow(/invalid/i);
    expect(() => validatePrivacyControlState({ ...state, unexpected: 'private sentinel' })).toThrow(/invalid/i);
  });

  it('enforces the legacy path byte limit shared with the erasure adapter', () => {
    const state = createEmptyPrivacyControlState(uuid(1));
    const exactLimit = `${'a'.repeat(1_021)}.md`;
    expect(new TextEncoder().encode(exactLimit).byteLength).toBe(1_024);
    expect(validatePrivacyControlState({ ...state, legacyMarkdownPaths: [exactLimit] }).legacyMarkdownPaths).toEqual([exactLimit]);
    const unicodeOverLimit = `${'é'.repeat(511)}.md`;
    expect(unicodeOverLimit.length).toBeLessThanOrEqual(1_024);
    expect(new TextEncoder().encode(unicodeOverLimit).byteLength).toBeGreaterThan(1_024);
    expect(() => validatePrivacyControlState({ ...state, legacyMarkdownPaths: [unicodeOverLimit] })).toThrow(/invalid/i);
    const validUnicode = `notes/${'😀'.repeat(250)}.md`;
    expect(new TextEncoder().encode(validUnicode).byteLength).toBeLessThanOrEqual(1_024);
    expect(validatePrivacyControlState({ ...state, legacyMarkdownPaths: [validUnicode] }).legacyMarkdownPaths).toEqual([validUnicode]);
    for (const malformed of [`notes/\uD800.md`, `notes/\uDC00.md`]) {
      expect(() => validatePrivacyControlState({ ...state, legacyMarkdownPaths: [malformed] })).toThrow(/invalid/i);
    }
  });

  it('can prepare the maximum manifest without exceeding the bounded control record size', async () => {
    const { engine, store } = setup();
    const paths = Array.from({ length: PRIVACY_CONTROL_LIMITS.legacyMarkdownPaths }, (_, index) => `legacy/${index}-${'😀'.repeat(245)}.md`);
    expect(paths.every((path) => new TextEncoder().encode(path).byteLength <= 1_024)).toBe(true);
    store.state = validatePrivacyControlState({ ...store.state, legacyMarkdownPaths: paths });
    const plan = await engine.prepareErase();
    expect(plan.targetCount).toBe(10 + paths.length);
    expect(new TextEncoder().encode(JSON.stringify(store.state)).byteLength).toBeLessThan(16 * 1024 * 1024);
  });

  it('rejects ill-formed Unicode writer paths before acquiring a lease and accepts valid supplementary characters', async () => {
    const { engine, store } = setup();
    let callbacks = 0;
    for (const path of [`notes/\uD800.md`, `notes/\uDC00.md`]) {
      await expect(engine.withWriter(store.state.epoch, {
        kind: 'markdown_mirror', namespace: 'markdown_mirrors', legacyMarkdownPath: path,
      }, async () => { callbacks += 1; })).rejects.toMatchObject({ code: 'blocked' });
    }
    await engine.withWriter(store.state.epoch, {
      kind: 'markdown_mirror', namespace: 'markdown_mirrors', legacyMarkdownPath: `notes/${'😀'.repeat(250)}.md`,
    }, async () => { callbacks += 1; });
    expect(callbacks).toBe(1);
    expect(store.state.writerLeases).toHaveLength(0);
  });

  it('enforces exact aggregate bounds, including the 5,130 cleanup-target maximum', () => {
    expect(PRIVACY_CONTROL_LIMITS.cleanupTargets).toBe(5_130);
    const state = createEmptyPrivacyControlState(uuid(1));
    expect(() => validatePrivacyControlState({ ...state, oauthTokenRefs: Array.from({ length: 1_025 }, (_, i) => uuid(i + 10)) })).toThrow(/invalid/i);
  });

  it('binds active cleanup steps to the complete fixed namespace set and unresolved manifest', async () => {
    const { engine, store } = setup();
    const plan = await engine.prepareErase();
    await engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    expect(store.state.ownedNamespaces).toHaveLength(10);
    expect(() => validatePrivacyControlState({
      ...store.state,
      ownedNamespaces: store.state.ownedNamespaces.slice(1),
    })).toThrow(/invalid/i);
    expect(() => validatePrivacyControlState({
      ...store.state,
      writerLeases: [{
        id: uuid(500), epoch: store.state.epoch,
        owner: { platform: 'web', runtimeId: uuid(501) }, kind: 'app_state',
        namespace: 'state_database', createdAt: '2026-10-13T00:00:00.000Z',
      }],
    })).toThrow(/invalid/i);
  });
});

describe('privacy cleanup engine', () => {
  it('registers writer intent before I/O and holds arbitration until actual callback settlement', async () => {
    const { engine, store, locks } = setup();
    const epoch = store.state.epoch;
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = engine.withWriter(epoch, { kind: 'audio_capture', namespace: 'native_recordings' }, async (lease) => {
      expect(store.state.writerLeases.some((row) => row.id === lease.id)).toBe(true);
      expect(store.state.ownedNamespaces).toContain('native_recordings');
      started();
      await gate;
      return 'done';
    });
    await began;
    expect(locks.writerDepth).toBe(1);
    expect((await engine.getStatus()).activeWriterCount).toBe(1);
    release();
    await expect(task).resolves.toBe('done');
    expect(locks.writerDepth).toBe(0);
    expect(store.state.writerLeases).toHaveLength(0);
  });

  it('admits scoped child I/O behind a queued exclusive request using native fair arbitration', async () => {
    vi.stubGlobal('__DEV__', true);
    const { createNativePrivacyArbitration } = await import('../src/privacy/arbitration');
    const owner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(901), processLaunchId: uuid(902), bundleIdentifier: 'com.still.voiceassistant' };
    const store = new MemoryControlStore();
    const arbitration = createNativePrivacyArbitration({ getRuntimeOwner: async () => owner, waitTimeoutMs: 1_000 });
    let id = 910;
    const engine = new PrivacyEngine({ controlStore: store, arbitration, adapter: new TestEraseAdapter(), uuid: () => uuid(id++) });
    let releaseParent!: () => void;
    let parentStarted!: (scope: import('../src/privacy/types').PrivacyWriterScope) => void;
    let exclusiveStarted = false;
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
    const parentScope = new Promise<import('../src/privacy/types').PrivacyWriterScope>((resolve) => { parentStarted = resolve; });
    const parent = engine.withWriter(store.state.epoch, { kind: 'app_state', namespace: 'state_database' }, async (_lease, scope) => {
      parentStarted(scope);
      await parentGate;
    });
    const scope = await parentScope;
    const cleanup = arbitration.withCleanupLock(async () => { exclusiveStarted = true; });
    await Promise.resolve();
    let childCalled = false;
    await expect(engine.withExistingWriter(scope, store.state.epoch, {
      kind: 'recording_recovery', namespace: 'recovery_audio',
    }, async () => { childCalled = true; })).resolves.toBeUndefined();
    expect(childCalled).toBe(true);
    expect(exclusiveStarted).toBe(false);
    expect(store.state.ownedNamespaces).toContain('recovery_audio');
    releaseParent();
    await parent;
    await cleanup;
    expect(exclusiveStarted).toBe(true);
    expect(store.state.writerLeases).toHaveLength(0);
  });

  it('rejects forged, foreign, wrong-epoch, and sealed scopes before child I/O', async () => {
    const first = setup();
    const second = setup();
    let scope!: import('../src/privacy/types').PrivacyWriterScope;
    let childCalls = 0;
    await first.engine.withWriter(first.store.state.epoch, { kind: 'app_state', namespace: 'state_database' }, async (_lease, issued) => {
      scope = issued;
      expect(Object.isFrozen(scope)).toBe(true);
      await expect(first.engine.withExistingWriter(Object.freeze({}) as typeof issued, first.store.state.epoch, {
        kind: 'recording_recovery', namespace: 'recovery_audio',
      }, async () => { childCalls += 1; })).rejects.toMatchObject({ code: 'writer_missing' });
      await expect(second.engine.withExistingWriter(scope, second.store.state.epoch, {
        kind: 'recording_recovery', namespace: 'recovery_audio',
      }, async () => { childCalls += 1; })).rejects.toMatchObject({ code: 'writer_missing' });
      await expect(first.engine.withExistingWriter(scope, uuid(999), {
        kind: 'recording_recovery', namespace: 'recovery_audio',
      }, async () => { childCalls += 1; })).rejects.toMatchObject({ code: 'stale_epoch' });
    });
    await expect(first.engine.withExistingWriter(scope, first.store.state.epoch, {
      kind: 'recording_recovery', namespace: 'recovery_audio',
    }, async () => { childCalls += 1; })).rejects.toMatchObject({ code: 'writer_missing' });
    expect(childCalls).toBe(0);
  });

  it('drains a fire-and-forget child after the parent fails and seals further admissions', async () => {
    const { engine, store, locks } = setup();
    let releaseChild!: () => void;
    let childStarted!: (scope: import('../src/privacy/types').PrivacyWriterScope) => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    const started = new Promise<import('../src/privacy/types').PrivacyWriterScope>((resolve) => { childStarted = resolve; });
    const failure = new Error('parent failure');
    const parent = engine.withWriter(store.state.epoch, { kind: 'app_state', namespace: 'state_database' }, async (_lease, scope) => {
      void engine.withExistingWriter(scope, store.state.epoch, { kind: 'recording_recovery', namespace: 'recovery_audio' }, async () => {
        childStarted(scope);
        await childGate;
      });
      await started;
      throw failure;
    });
    const scope = await started;
    let settled = false;
    void parent.catch(() => { settled = true; });
    await Promise.resolve();
    expect(locks.writerDepth).toBe(1);
    expect(settled).toBe(false);
    releaseChild();
    await expect(parent).rejects.toBe(failure);
    expect(locks.writerDepth).toBe(0);
    await expect(engine.withExistingWriter(scope, store.state.epoch, { kind: 'recording_recovery', namespace: 'recovery_audio' }, async () => undefined))
      .rejects.toMatchObject({ code: 'writer_missing' });
  });

  it('snapshots child descriptors and fails closed when intent registration fails', async () => {
    const { engine, store } = setup();
    let releaseRead!: () => void;
    let pauseReads = false;
    let readStarted!: () => void;
    const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve; });
    const originalRead = store.read.bind(store);
    store.read = async () => {
      if (pauseReads) { readStarted(); await new Promise<void>((resolve) => { releaseRead = resolve; }); }
      return originalRead();
    };
    let childCalls = 0;
    let parentSettled = false;
    let mutableDescriptor: { kind: 'markdown_mirror'; namespace: 'markdown_mirrors'; legacyMarkdownPath: string } | undefined;
    const parent = engine.withWriter(store.state.epoch, { kind: 'app_state', namespace: 'state_database' }, async (_lease, issued) => {
      const descriptor = { kind: 'markdown_mirror' as const, namespace: 'markdown_mirrors' as const, legacyMarkdownPath: 'notes/original.md' };
      mutableDescriptor = descriptor;
      pauseReads = true;
      void engine.withExistingWriter(issued, store.state.epoch, descriptor, async () => { childCalls += 1; });
      // Parent is allowed to settle while the already-admitted child is still
      // waiting for durable descriptor registration.
    }).finally(() => { parentSettled = true; });
    await readStartedPromise;
    await Promise.resolve();
    expect(parentSettled).toBe(false);
    mutableDescriptor!.legacyMarkdownPath = 'notes/changed.md';
    releaseRead();
    pauseReads = false;
    await parent;
    const before = childCalls;
    expect(store.state.legacyMarkdownPaths).toContain('notes/original.md');
    expect(store.state.legacyMarkdownPaths).not.toContain('notes/changed.md');
    expect(store.state.writerLeases).toEqual([]);
    await engine.withWriter(store.state.epoch, { kind: 'app_state', namespace: 'state_database' }, async (_lease, issued) => {
      await expect(engine.withExistingWriter(issued, store.state.epoch, {
        kind: 'markdown_mirror', namespace: 'markdown_mirrors', legacyMarkdownPath: '../unsafe.md',
      }, async () => { childCalls += 1; })).rejects.toMatchObject({ code: 'blocked' });
    });
    expect(childCalls).toBe(before);
    expect(store.state.writerLeases).toHaveLength(0);
  });

  it('keeps the issued lease immutable and releases the private lease identity', async () => {
    const { engine, store } = setup();
    let attemptedMutation = false;
    await engine.withWriter(store.state.epoch, { kind: 'app_state', namespace: 'state_database' }, async (lease) => {
      expect(Object.isFrozen(lease)).toBe(true);
      expect(Object.isFrozen(lease.owner)).toBe(true);
      try { (lease as { id: string }).id = uuid(777_001); } catch { attemptedMutation = true; }
      expect(store.state.writerLeases).toHaveLength(1);
    });
    expect(attemptedMutation).toBe(true);
    expect(store.state.writerLeases).toEqual([]);
  });

  it('snapshots the outer descriptor before waiting for writer arbitration', async () => {
    const { engine, store, locks } = setup();
    let unlock!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = locks.withWriterLock(async () => { entered(); await gate; });
    await started;
    const descriptor = { kind: 'markdown_mirror' as const, namespace: 'markdown_mirrors' as const, legacyMarkdownPath: 'notes/queued-original.md' };
    const write = engine.withWriter(store.state.epoch, descriptor, async () => undefined);
    descriptor.legacyMarkdownPath = 'notes/queued-mutated.md';
    unlock();
    await blocker;
    await write;
    expect(store.state.legacyMarkdownPaths).toEqual(['notes/queued-original.md']);
    expect(store.state.writerLeases).toEqual([]);
  });

  it('snapshots service writer intent before its asynchronous epoch check', async () => {
    const { store, locks } = setup();
    let release!: () => void;
    let readStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const originalRead = store.read.bind(store);
    let delayed = false;
    store.read = async () => {
      if (!delayed) { delayed = true; readStarted(); await gate; }
      return originalRead();
    };
    const privacy = createPrivacyService({ controlStore: store, arbitration: locks as PrivacyWriterArbitration, eraseAdapter: new TestEraseAdapter() });
    const descriptor = { kind: 'markdown_mirror' as const, namespace: 'markdown_mirrors' as const, legacyMarkdownPath: 'notes/service-original.md' };
    const write = privacy.withWriter(store.state.epoch, descriptor, async () => undefined);
    await started;
    descriptor.legacyMarkdownPath = 'notes/service-mutated.md';
    release();
    await write;
    expect(store.state.legacyMarkdownPaths).toEqual(['notes/service-original.md']);
  });

  it('rejects unsupported writer ownership before persisting intent or invoking work', async () => {
    const { engine, store } = setup({ platform: 'unsupported', runtimeId: uuid(77) });
    let called = false;
    await expect(engine.withWriter(store.state.epoch, {
      kind: 'app_state', namespace: 'state_database',
    }, async () => { called = true; })).rejects.toMatchObject({ code: 'unsupported_owner' });
    expect(called).toBe(false);
    expect(store.state.writerLeases).toEqual([]);
    expect(store.state.ownedNamespaces).toEqual([]);
  });

  it('retires a same-process lease only when this engine observed the callback settle before release failed', async () => {
    const owner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(701), processLaunchId: uuid(702), bundleIdentifier: 'com.still.voiceassistant' };
    const { engine, store } = setup(owner);
    await expect(engine.withWriter(store.state.epoch, { kind: 'app_state', namespace: 'state_database' }, async () => {
      store.failNext = true;
    })).rejects.toThrow(/durable write failed/i);
    expect(store.state.writerLeases).toHaveLength(1);
    await expect(engine.reconcileStartupWriters()).resolves.toMatchObject({ phase: 'ready' });
    expect(store.state.writerLeases).toEqual([]);
    await expect(engine.prepareErase()).resolves.toMatchObject({ operation: 'erase_local_data' });
  });

  it('keeps an unknown same-process lease blocked after reload when no callback-settled proof exists', async () => {
    const owner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(711), processLaunchId: uuid(712), bundleIdentifier: 'com.still.voiceassistant' };
    const { engine, store } = setup(owner);
    store.state = validatePrivacyControlState({
      ...store.state,
      writerLeases: [{
        id: uuid(713), epoch: store.state.epoch, owner, kind: 'app_state', namespace: 'state_database',
        createdAt: '2026-10-13T00:00:00.000Z',
      }],
    });
    await expect(engine.prepareErase()).rejects.toMatchObject({ code: 'blocked' });
    expect(store.state.writerLeases).toHaveLength(1);
    expect(store.state.cleanup).toBeUndefined();
  });

  it('atomically registers credential references without storing a token value on the lease', async () => {
    const { engine, store } = setup();
    const tokenRef = uuid(88);
    await engine.withWriter(store.state.epoch, {
      kind: 'provider_credential', namespace: 'provider_credentials', oauthTokenRef: tokenRef,
    }, async (lease) => {
      expect(store.state.oauthTokenRefs).toContain(tokenRef);
      expect(lease).not.toHaveProperty('oauthTokenRef');
    });
    expect(store.state.oauthTokenRefs).toContain(tokenRef);
    expect(store.state.writerLeases).toHaveLength(0);
  });

  it('allows fixed provider-key operations without an OAuth ref and rejects mismatched writer namespaces', async () => {
    const { engine, store } = setup();
    let called = false;
    await engine.withWriter(store.state.epoch, { kind: 'provider_credential', namespace: 'provider_credentials' }, async () => { called = true; });
    expect(called).toBe(true);
    expect(store.state.ownedNamespaces).toContain('provider_credentials');
    called = false;
    await expect(engine.withWriter(store.state.epoch, { kind: 'provider_credential', namespace: 'state_database' }, async () => { called = true; })).rejects.toMatchObject({ code: 'blocked' });
    expect(called).toBe(false);
    expect(store.state.writerLeases).toHaveLength(0);
  });

  it('does not permit a prepared plan after the manifest changes', async () => {
    const { engine, store } = setup();
    await engine.registerNamespace(store.state.epoch, 'state_database');
    const plan = await engine.prepareErase();
    await engine.registerNamespace(store.state.epoch, 'browser_audio');
    await expect(engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash })).rejects.toMatchObject({ code: 'stale_plan' });
    expect(store.state.cleanup).toBeUndefined();
  });

  it('rejects a prepared erase plan if the clock moves backward before commit', async () => {
    const store = new MemoryControlStore();
    const locks = new TestLocks();
    const adapter = new TestEraseAdapter();
    let nowMs = Date.parse('2026-10-13T00:00:00.000Z');
    let id = 600;
    const engine = new PrivacyEngine({
      controlStore: store,
      arbitration: locks as PrivacyWriterArbitration,
      adapter,
      now: () => new Date(nowMs),
      uuid: () => uuid(id++),
    });
    const plan = await engine.prepareErase();
    nowMs -= 1;
    await expect(engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash }))
      .rejects.toMatchObject({ code: 'plan_expired' });
    expect(store.state.cleanup).toBeUndefined();
    expect(adapter.erased).toEqual([]);
  });

  it('persists the cleanup journal before deletion and removes manifest entries only after verification', async () => {
    const { engine, store, adapter } = setup();
    await engine.registerNamespace(store.state.epoch, 'state_database');
    await engine.registerOAuthTokenRef(store.state.epoch, uuid(90));
    const plan = await engine.prepareErase();
    adapter.beforeErase = () => expect(store.state.cleanup?.status).toBe('erasing');
    await engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    expect(adapter.erased).toHaveLength(0);
    const result = await engine.runCleanupPass();
    expect(result.phase).toBe('complete');
    expect(adapter.erased).toHaveLength(11);
    expect(store.state.ownedNamespaces).toEqual([]);
    expect(store.state.oauthTokenRefs).toEqual([]);
    expect(store.state.cleanup).toMatchObject({ status: 'complete', steps: [], completedCounts: { namespaces: 10, oauthTokens: 1, legacyMarkdown: 0 } });
    expect((await engine.getStatus()).phase).toBe('complete');
    expect((await engine.getStatus()).categoryStates).toEqual({
      notes_context: 'verified', action_history_recovery: 'verified', recordings_caches: 'verified',
      credentials: 'verified', notifications: 'verified',
    });
    expect((await engine.getStatus()).completedAt).toBe('2026-10-13T00:00:00.000Z');
    await engine.registerNamespace(store.state.epoch, 'state_database');
    expect(store.state.cleanup?.completedCounts?.namespaces).toBe(10);
    expect(store.state.ownedNamespaces).toEqual(['state_database']);
  });

  it('runs no more than 16 targets in a pass and leaves every other target resumable', async () => {
    const { engine, store, adapter } = setup();
    for (let i = 0; i < 20; i += 1) await engine.registerLegacyMarkdownPath(store.state.epoch, `notes/n${i}.md`);
    const plan = await engine.prepareErase();
    await engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    const first = await engine.runCleanupPass();
    expect(first.attempted).toBe(16);
    expect(first.remaining).toBe(14);
    expect(adapter.erased).toHaveLength(16);
    const second = await engine.runCleanupPass();
    expect(second.phase).toBe('complete');
    expect(adapter.erased).toHaveLength(30);
    expect(store.state.cleanup?.steps).toEqual([]);
  });

  it('re-verifies after deletion when the acknowledgement save fails', async () => {
    const { engine, store, adapter } = setup();
    const plan = await engine.prepareErase();
    await engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    store.failNext = true;
    await expect(engine.runCleanupPass()).rejects.toThrow(/durable write failed/i);
    expect(store.state.cleanup?.steps[0]?.status).toBe('pending');
    expect(adapter.erased).toHaveLength(1);
    await expect(engine.runCleanupPass()).resolves.toMatchObject({ phase: 'complete' });
    expect(adapter.erased.length).toBeGreaterThan(1); // Repeating the idempotent erase is safer than fabricating acknowledgement.
  });

  it('pauses on verification failure, retains the target, and retries only on explicit pass', async () => {
    const { engine, store, adapter } = setup();
    await engine.registerLegacyMarkdownPath(store.state.epoch, 'notes/keep.md');
    const plan = await engine.prepareErase();
    await engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    const key = JSON.stringify({ kind: 'legacy_markdown', path: 'notes/keep.md' });
    adapter.failVerifyOnce.add(key);
    const failed = await engine.runCleanupPass();
    expect(failed.phase).toBe('paused');
    expect(store.state.legacyMarkdownPaths).toEqual(['notes/keep.md']);
    expect(store.state.cleanup?.steps.find((step) => step.target.kind === 'legacy_markdown')).toMatchObject({ status: 'failed', errorCode: 'verification_failed' });
    expect(key).toContain('notes/keep.md');
    const retried = await engine.runCleanupPass();
    expect(retried.phase).toBe('complete');
    expect(adapter.erased).toHaveLength(12);
  });

  it('blocks an iOS same-process abandoned lease and retires a lease only for a verified new process', async () => {
    const owner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(9), processLaunchId: uuid(10), bundleIdentifier: 'com.still.voiceassistant' };
    const { engine, store, locks } = setup(owner);
    const lease = {
      id: uuid(20), epoch: store.state.epoch, owner,
      kind: 'audio_capture' as const, namespace: 'native_recordings' as const,
      createdAt: '2026-10-13T00:00:00.000Z',
    };
    store.state = validatePrivacyControlState({ ...store.state, ownedNamespaces: ['native_recordings'], writerLeases: [lease] });
    await expect(engine.prepareErase()).rejects.toMatchObject({ code: 'blocked' });
    locks.owner = { ...owner, runtimeId: uuid(11), processLaunchId: uuid(12) };
    const plan = await engine.prepareErase();
    expect(store.state.writerLeases).toEqual([]);
    expect(plan.targetCount).toBe(10);
  });

  it('reconciles only proven old-process leases and preserves the epoch and manifests', async () => {
    const priorOwner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(801), processLaunchId: uuid(802), bundleIdentifier: 'com.still.voiceassistant' };
    const currentOwner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(803), processLaunchId: uuid(804), bundleIdentifier: 'com.still.voiceassistant' };
    const { engine, store } = setup(currentOwner);
    const lease = {
      id: uuid(805), epoch: store.state.epoch, owner: priorOwner, kind: 'app_state' as const,
      namespace: 'state_database' as const, createdAt: '2026-10-13T00:00:00.000Z',
    };
    store.state = validatePrivacyControlState({
      ...store.state, ownedNamespaces: ['state_database'], legacyMarkdownPaths: ['notes/keep.md'], writerLeases: [lease],
    });
    const epoch = store.state.epoch;
    const result = await engine.reconcileStartupWriters();
    expect(result.phase).toBe('ready');
    expect(store.state.writerLeases).toEqual([]);
    expect(store.state.epoch).toBe(epoch);
    expect(store.state.ownedNamespaces).toEqual(['state_database']);
    expect(store.state.legacyMarkdownPaths).toEqual(['notes/keep.md']);
  });

  it('keeps same-process unknown leases blocked and leaves active or completed cleanup untouched', async () => {
    const owner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(811), processLaunchId: uuid(812), bundleIdentifier: 'com.still.voiceassistant' };
    const { engine, store } = setup(owner);
    store.state = validatePrivacyControlState({
      ...store.state,
      ownedNamespaces: ['state_database'],
      writerLeases: [{ id: uuid(813), epoch: store.state.epoch, owner, kind: 'app_state', namespace: 'state_database', createdAt: '2026-10-13T00:00:00.000Z' }],
    });
    const beforeUnknown = structuredClone(store.state);
    await expect(engine.reconcileStartupWriters()).resolves.toMatchObject({ phase: 'writer_active' });
    expect(store.state).toEqual(beforeUnknown);

    const active = setup();
    const plan = await active.engine.prepareErase();
    await active.engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    const activeState = structuredClone(active.store.state);
    const activeSaves = active.store.saves;
    await active.engine.reconcileStartupWriters();
    expect(active.store.state).toEqual(activeState);
    expect(active.store.saves).toBe(activeSaves);

    await active.engine.runCleanupPass();
    const completeState = structuredClone(active.store.state);
    const completeSaves = active.store.saves;
    await active.engine.reconcileStartupWriters();
    expect(active.store.state).toEqual(completeState);
    expect(active.store.saves).toBe(completeSaves);
  });

  it('reconciles a crashed old-process writer after a completed erase is reused by a fresh workspace', async () => {
    const oldOwner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(821), processLaunchId: uuid(822), bundleIdentifier: 'com.still.voiceassistant' };
    const { engine, store } = setup(oldOwner);
    const plan = await engine.prepareErase();
    await engine.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    await expect(engine.runCleanupPass()).resolves.toMatchObject({ phase: 'complete' });

    // A completed privacy epoch is reusable by the next workspace.
    await engine.registerNamespace(store.state.epoch, 'state_database');
    const previous = new TestLocks();
    previous.owner = oldOwner;
    const oldProcessEngine = new PrivacyEngine({ controlStore: store, arbitration: previous as PrivacyWriterArbitration,
      adapter: new TestEraseAdapter(), uuid: () => uuid(830) });
    await expect(oldProcessEngine.withWriter(store.state.epoch, { kind: 'app_state', namespace: 'state_database' }, async () => { store.failNext = true; }))
      .rejects.toThrow(/durable write failed/i);
    expect(store.state.writerLeases).toHaveLength(1);

    const cleanupJournal = structuredClone(store.state.cleanup);
    const epoch = store.state.epoch;
    const ownedNamespaces = [...store.state.ownedNamespaces];
    const currentLocks = new TestLocks();
    currentLocks.owner = { platform: 'ios', runtimeId: uuid(831), processLaunchId: uuid(832), bundleIdentifier: 'com.still.voiceassistant' };
    const reopenedEngine = new PrivacyEngine({ controlStore: store, arbitration: currentLocks as PrivacyWriterArbitration,
      adapter: new TestEraseAdapter(), uuid: () => uuid(833) });

    await expect(reopenedEngine.reconcileStartupWriters()).resolves.toMatchObject({ phase: 'ready' });
    expect(store.state.cleanup).toEqual(cleanupJournal);
    expect(store.state.epoch).toBe(epoch);
    expect(store.state.ownedNamespaces).toEqual(ownedNamespaces);
    expect(store.state.writerLeases).toEqual([]);
  });

  it('returns the existing fixed blocked status when startup arbitration is unavailable', async () => {
    const { store } = setup();
    const leaseOwner: PrivacyOwner = { platform: 'web', runtimeId: uuid(900) };
    store.state = validatePrivacyControlState({
      ...store.state, ownedNamespaces: ['state_database'],
      writerLeases: [{ id: uuid(899), epoch: store.state.epoch, owner: leaseOwner, kind: 'app_state', namespace: 'state_database', createdAt: '2026-10-13T00:00:00.000Z' }],
    });
    const before = structuredClone(store.state);
    const arbitration: PrivacyWriterArbitration = {
      withWriterLock: async <T>(work: () => Promise<T>) => work(),
      withCleanupLock: async () => { throw new Error('lock timeout details must not escape'); },
      getRuntimeOwner: async () => ({ platform: 'web', runtimeId: uuid(901) }),
    };
    const blockedEngine = new PrivacyEngine({
      controlStore: store, arbitration, adapter: new TestEraseAdapter(), uuid: () => uuid(900),
    });
    await expect(blockedEngine.reconcileStartupWriters()).resolves.toMatchObject({ phase: 'blocked' });
    expect(store.state).toEqual(before);
  });

  it('reports only fixed summary data and blocks erase when runtime ownership is unsupported', async () => {
    const { engine } = setup({ platform: 'unsupported', runtimeId: uuid(9) });
    const status = await engine.getStatus();
    expect(status.phase).toBe('blocked');
    expect(Object.keys(status).sort()).toEqual(['activeWriterCount', 'coverage', 'epoch', 'failedCleanupCount', 'limits', 'pendingCleanupCount', 'phase'].sort());
    await expect(engine.prepareErase()).rejects.toMatchObject({ code: 'unsupported_owner' });
  });

  it('keeps target locators out of public status while retaining them in private control state', async () => {
    const { engine, store } = setup();
    const tokenRef = uuid(77);
    const path = 'private/Person Name.md';
    await engine.registerOAuthTokenRef(store.state.epoch, tokenRef);
    await engine.registerLegacyMarkdownPath(store.state.epoch, path);
    const publicStatus = JSON.stringify(await engine.getStatus());
    expect(publicStatus).not.toContain(tokenRef);
    expect(publicStatus).not.toContain(path);
    expect(store.state.oauthTokenRefs).toContain(tokenRef);
    expect(store.state.legacyMarkdownPaths).toContain(path);
  });

  it('does not expose corrupted control data or a raw failure message', async () => {
    const { engine, store } = setup();
    store.state = { ...store.state, legacyMarkdownPaths: ['notes/sentinel-private.md'] };
    const corrupt = { ...store.state, poisoned: 'raw sentinel data' } as PrivacyControlState;
    store.state = corrupt;
    const error = await engine.getStatus().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrivacyEngineError);
    expect((error as Error).message).not.toMatch(/sentinel|poisoned/i);
    expect(store.state).toHaveProperty('poisoned', 'raw sentinel data');
  });
});
