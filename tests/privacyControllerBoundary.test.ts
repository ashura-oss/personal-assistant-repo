import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import { createProductionController } from '../src/services/controller';
import { ConnectorClient } from '../src/connectors';
import type { OAuthTokenStore, StoredOAuthToken } from '../src/connectors';
import type { StateStore } from '../src/storage/contracts';
import { createEmptyPrivacyControlState, validatePrivacyControlState } from '../src/privacy/schema';
import { createPrivacyService } from '../src/privacy/service';
import type { PrivacyControlState, PrivacyControlStore, PrivacyEraseAdapter, PrivacyOwner, PrivacyWriterArbitration } from '../src/privacy/types';
import type { PrivacyService } from '../src/privacy/service';
import { createPrivacyResourceBoundary } from '../src/privacy/resourceBoundary';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class MemoryControl implements PrivacyControlStore {
  state = createEmptyPrivacyControlState(id(1));
  async read() { return structuredClone(validatePrivacyControlState(this.state)); }
  async compareAndSwap(revision: string, next: PrivacyControlState) {
    if (revision !== this.state.revision) throw Object.assign(new Error('conflict'), { code: 'conflict' });
    this.state = structuredClone(validatePrivacyControlState(next));
  }
}

class Locks implements PrivacyWriterArbitration {
  owner: PrivacyOwner = { platform: 'web', runtimeId: id(2) };
  private tail = Promise.resolve();
  withWriterLock<T>(work: () => Promise<T>) { return this.serial(work); }
  withCleanupLock<T>(work: () => Promise<T>) { return this.serial(work); }
  async getRuntimeOwner() { return { ...this.owner }; }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }
}

class Store implements StateStore {
  value?: AppState;
  loads = 0;
  writes = 0;
  nextSaveGate?: Promise<void>;
  saveStarted?: () => void;
  afterSave?: () => void;
  async load() { this.loads += 1; return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.writes += 1;
    if (this.nextSaveGate) { const gate = this.nextSaveGate; this.nextSaveGate = undefined; this.saveStarted?.(); await gate; }
    this.value = structuredClone(state);
    this.afterSave?.();
  }
  async clear() { this.value = undefined; }
}

function makePrivacy(control = new MemoryControl(), locks = new Locks()) {
  const adapter: PrivacyEraseAdapter = { async erase() {}, async verifyGone() { return true; } };
  return { control, locks, privacy: createPrivacyService({ controlStore: control, arbitration: locks, eraseAdapter: adapter }) };
}

describe('privacy controller boundary', () => {
  it('checks the independent cleanup gate before the app store is opened', async () => {
    const { control, privacy } = makePrivacy();
    const plan = await privacy.prepareErase();
    await privacy.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    const state = control.state;
    const pausedCleanup = { ...state.cleanup!, status: 'paused' as const, steps: state.cleanup!.steps.map((step, index) => index === 0 ? { target: step.target, status: 'failed' as const, errorCode: 'erase_failed' as const } : step) };
    control.state = { ...state, revision: id(3), cleanup: pausedCleanup };
    const store = new Store();
    await expect(createProductionController({ privacy, store })).rejects.toThrow(/cleanup is in progress/i);
    expect(store.loads).toBe(0);
  });

  it('uses the exact bootstrap session and rejects a stale session before app-data IO', async () => {
    const { control, privacy } = makePrivacy();
    const session = await privacy.openWorkspace();
    const resources = createPrivacyResourceBoundary({ privacy, session });
    const store = new Store();
    const app = await createProductionController({ privacy, session, resources, store, integration: { writeDocument: async () => {} } });
    await app.load();
    expect(store.loads).toBe(1);

    control.state = { ...control.state, epoch: id(41), revision: id(42) };
    const staleStore = new Store();
    await expect(createProductionController({ privacy, session, resources, store: staleStore })).rejects.toThrow(/session is no longer current/i);
    expect(staleStore.loads).toBe(0);
  });

  it('rejects a workspace facade after its epoch changes, before controller work starts', async () => {
    const { control, privacy } = makePrivacy();
    const store = new Store();
    const app = await createProductionController({ privacy, store, integration: { writeDocument: async () => {} } });
    control.state = { ...control.state, epoch: id(4), revision: id(5) };
    await expect(app.load()).rejects.toThrow(/session has expired/i);
    expect(store.loads).toBe(0);
  });

  it('holds the writer lease through a delayed canonical state write', async () => {
    const { privacy } = makePrivacy();
    const store = new Store();
    const app = await createProductionController({ privacy, store, integration: { writeDocument: async () => {} } });
    await app.load();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    store.nextSaveGate = gate;
    store.saveStarted = started;
    const save = app.saveNote({ transcript: 'boundary test' });
    try {
      await didStart;
      expect((await privacy.getStatus()).activeWriterCount).toBe(1);
    } finally { finish(); }
    await save;
    expect((await privacy.getStatus()).activeWriterCount).toBe(0);
  });

  it('holds the mirror writer lease until the real filesystem callback settles', async () => {
    const { privacy, control } = makePrivacy();
    const store = new Store();
    let finish!: () => void;
    let began!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { began = resolve; });
    let writes = 0;
    const app = await createProductionController({ privacy, store, integration: {
      writeDocument: async () => {
        writes += 1;
        if (writes === 1) { began(); await gate; }
      },
    } });
    const loading = app.load();
    let cleanupResolved = false;
    let cleanupPlan: Promise<Awaited<ReturnType<PrivacyService['prepareErase']>>> | undefined;
    try {
      await started;
      expect(writes).toBe(1);
      expect((await privacy.getStatus()).activeWriterCount).toBe(1);
      expect(control.state.ownedNamespaces).toContain('markdown_mirrors');
      expect(control.state.legacyMarkdownPaths).toHaveLength(1);
      cleanupPlan = privacy.prepareErase().then((plan) => { cleanupResolved = true; return plan; });
      await Promise.resolve();
      expect(cleanupResolved).toBe(false);
    } finally { finish(); }
    await loading;
    const plan = await cleanupPlan!;
    expect(plan.targetCount).toBe(11);
  });

  it('registers OAuth references and waits for credential reads/writes through the bound store', async () => {
    const { control, privacy } = makePrivacy();
    const store = new Store();
    let boundStore: OAuthTokenStore | undefined;
    let rawSetCalls = 0;
    const app = await createProductionController({ privacy, store, integration: {
      tokenStore: {
        async get() { return null; },
        async set() { rawSetCalls += 1; },
      },
      connectorFactory: (tokens) => {
        boundStore = tokens;
        return new ConnectorClient({ tokenStore: tokens });
      },
      writeDocument: async () => {},
    } });
    const tokenRef = id(91);
    const token: StoredOAuthToken = {
      accessToken: 'private-test-token', expiresAt: Date.now() + 60_000,
      identity: { providerNamespace: 'google', clientId: 'client-test', subject: 'subject-test' },
    };
    expect(boundStore).toBeDefined();
    await boundStore!.set(tokenRef, token);
    expect(rawSetCalls).toBe(1);
    expect(control.state.ownedNamespaces).toContain('provider_credentials');
    expect(control.state.oauthTokenRefs).toContain(tokenRef);
    let finish!: () => void;
    let began!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { began = resolve; });
    // A second production workspace uses a delayed raw credential read.
    const delayed = await createProductionController({ privacy, store: new Store(), integration: {
      tokenStore: {
        async get() { began(); await gate; return structuredClone(token); },
        async set() {},
      },
      connectorFactory: (tokens) => { boundStore = tokens; return new ConnectorClient({ tokenStore: tokens }); },
      writeDocument: async () => {},
    } });
    const read = boundStore!.get(tokenRef);
    let cleanupResolved = false;
    let cleanupPlan: Promise<Awaited<ReturnType<PrivacyService['prepareErase']>>> | undefined;
    try {
      await started;
      expect((await privacy.getStatus()).activeWriterCount).toBe(1);
      expect(control.state.writerLeases[0]).toMatchObject({ kind: 'provider_credential', namespace: 'provider_credentials' });
      cleanupPlan = privacy.prepareErase().then((plan) => { cleanupResolved = true; return plan; });
      await Promise.resolve();
      expect(cleanupResolved).toBe(false);
    } finally { finish(); }
    await expect(read).resolves.toMatchObject({ accessToken: 'private-test-token' });
    expect((await cleanupPlan!).targetCount).toBe(11);
    expect(delayed.getSnapshot().accounts).toEqual([]);
    expect(app.getSnapshot().accounts).toEqual([]);
  });

  it('does not publish a saved draft after erase advances the workspace before controller publication', async () => {
    const { privacy: basePrivacy } = makePrivacy();
    let gateNextAssertion = false;
    let release!: () => void;
    let begin!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const assertionStarted = new Promise<void>((resolve) => { begin = resolve; });
    const privacy: PrivacyService = {
      ...basePrivacy,
      withWriter: basePrivacy.withWriter.bind(basePrivacy),
      async assertWorkspaceEpoch(epoch) {
        await basePrivacy.assertWorkspaceEpoch(epoch);
        if (gateNextAssertion) {
          gateNextAssertion = false;
          begin();
          await gate;
          await basePrivacy.assertWorkspaceEpoch(epoch);
        }
      },
    };
    const store = new Store();
    const app = await createProductionController({ privacy, store, integration: { writeDocument: async () => {} } });
    await app.load();
    store.afterSave = () => { gateNextAssertion = true; };
    const pendingSave = app.saveNote({ transcript: 'Do not publish after local erase.' });
    try {
      await assertionStarted;
      const plan = await basePrivacy.prepareErase();
      await basePrivacy.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
      for (let pass = 0; pass < 8 && (await basePrivacy.getStatus()).phase !== 'complete'; pass += 1) await basePrivacy.runCleanupPass();
      await app.disposeForPrivacy!();
    } finally { release(); }
    await expect(pendingSave).rejects.toThrow(/workspace session has expired/i);
    expect(app.getSnapshot().notes).toEqual([]);
    expect((await basePrivacy.getStatus()).phase).toBe('complete');
  });

  it('opens a completed cleanup epoch with fresh app state', async () => {
    const { privacy } = makePrivacy();
    const plan = await privacy.prepareErase();
    await privacy.commitErase({ sessionId: plan.sessionId, planHash: plan.planHash });
    await privacy.runCleanupPass();
    expect((await privacy.getStatus()).phase).toBe('complete');
    const store = new Store();
    const app = await createProductionController({ privacy, store, integration: { writeDocument: async () => {} } });
    await app.load();
    expect(app.getSnapshot().notes).toEqual([]);
    expect(app.getSnapshot().proposals).toEqual([]);
    expect(store.loads).toBe(1);
  });
});
