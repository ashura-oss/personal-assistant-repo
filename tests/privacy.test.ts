import { describe, expect, it } from 'vitest';
import { PrivacyEngine, PrivacyEngineError } from '../src/privacy/engine';
import { createEmptyPrivacyControlState, PRIVACY_CONTROL_LIMITS, validatePrivacyControlState } from '../src/privacy/schema';
import type {
  PrivacyCleanupTarget,
  PrivacyControlState,
  PrivacyControlStore,
  PrivacyEraseAdapter,
  PrivacyOwner,
  PrivacyWriterArbitration,
} from '../src/privacy/types';

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
    await expect(engine.prepareErase()).resolves.toMatchObject({ operation: 'erase_local_data' });
    expect(store.state.writerLeases).toEqual([]);
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
