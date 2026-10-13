import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import type { AzureSpeechClient } from '../src/services/azure';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import type { StartupRecoveryBackend, StartupRecoveryCommitInput, StartupRecoveryInspection, StartupRecoveryPlan, StartupRecoveryReceipt } from '../src/storage/startupRecovery';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const UUID2 = '123e4567-e89b-42d3-a456-426614174001';
const receipt: StartupRecoveryReceipt = {
  operationId: UUID, archiveId: UUID2,
  archivedAt: '2026-10-13T00:00:00.000Z', evidenceBytes: 42, alreadyCommitted: false,
};

class RecoveryStore implements StateStore {
  value?: AppState;
  loadErrorCount = 1;
  loadGate?: Promise<void>;
  loadStarted?: () => void;
  assertError?: Error;
  saves = 0;
  recovery!: StartupRecoveryBackend;

  async load() {
    this.loadStarted?.();
    if (this.loadGate) await this.loadGate;
    if (this.loadErrorCount > 0) { this.loadErrorCount -= 1; throw new Error('core store startup failed'); }
    return this.value ? structuredClone(this.value) : undefined;
  }
  async save(state: AppState) { this.saves += 1; this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
  async assertCurrent() { if (this.assertError) throw this.assertError; }
}

function recoveryBackend(store: RecoveryStore, options: { loseCommitResponse?: boolean } = {}) {
  let pendingReceipt: StartupRecoveryReceipt | undefined;
  let commitCalls = 0;
  let acknowledgeCalls = 0;
  const plan: StartupRecoveryPlan = {
    operation: 'archive_and_start_fresh', sessionId: UUID,
    planHash: '123e4567-e89b-42d3-a456-426614174003',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), evidenceBytes: 42, archiveCount: 0,
  };
  const inspection: StartupRecoveryInspection = { status: 'available', evidenceBytes: 42, archiveCount: 0 };
  store.recovery = {
    inspect: vi.fn(async () => ({ ...inspection, ...(pendingReceipt ? { pendingReceipt: { ...pendingReceipt, alreadyCommitted: true } } : {}) })),
    prepare: vi.fn(async () => plan),
    commit: vi.fn(async (_input: StartupRecoveryCommitInput, replacement: AppState) => {
      commitCalls += 1;
      pendingReceipt = { ...receipt, alreadyCommitted: true };
      store.value = structuredClone(replacement);
      if (options.loseCommitResponse) throw new Error('reply lost after durable commit');
      return { ...receipt };
    }),
    acknowledgeOpened: vi.fn(async () => { acknowledgeCalls += 1; pendingReceipt = undefined; }),
  };
  return {
    get commitCalls() { return commitCalls; },
    get acknowledgeCalls() { return acknowledgeCalls; },
    plan,
  };
}

async function validState(): Promise<AppState> {
  const store: StateStore = { load: async () => undefined, save: async () => undefined, clear: async () => undefined };
  const app = new AppControllerImpl(store);
  await app.load();
  return structuredClone(app.getSnapshot());
}

describe('controller startup recovery', () => {
  it('keeps public load and side effects blocked while an explicit retry is opening storage', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl({ load: async () => undefined, save: async () => undefined, clear: async () => undefined });
    await seed.load();
    const note = await seed.saveNote({ transcript: 'A captured recording.', audioUri: 'file:///recording.m4a', durationSeconds: 7 });
    await seed.saveSettings({ speechEnabled: true, speechEndpoint: 'https://example.cognitiveservices.azure.com' });
    store.value = structuredClone(seed.getSnapshot());
    const backend = recoveryBackend(store);
    const speech = { transcribe: vi.fn(async () => { throw new Error('must not reach speech'); }) } as unknown as AzureSpeechClient;
    const app = new AppControllerImpl(store, { speech });
    await expect(app.load()).rejects.toThrow(/core store startup failed/i);
    expect((await app.getStartupRecoveryStatus()).phase).toBe('failed');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    store.loadGate = gate;
    let started!: () => void;
    const opened = new Promise<void>((resolve) => { started = resolve; });
    store.loadStarted = started;
    const retry = app.retryStartup();
    await opened;
    await expect(app.load()).rejects.toThrow(/startup failed/i);
    await expect(app.saveNote({ transcript: 'Must not run during recovery.' })).rejects.toThrow(/startup is not ready/i);
    await expect(app.transcribeNote(note.id, { expectedRevision: note.revision })).rejects.toThrow(/startup failed/i);
    expect(speech.transcribe).not.toHaveBeenCalled();
    release();
    await retry;
    store.loadGate = undefined;
    expect((await app.getStartupRecoveryStatus()).phase).toBe('ready');
    await app.saveNote({ transcript: 'Available after explicit retry.' });
    expect(backend.commitCalls).toBe(0);
  });

  it('lets the user cancel a prepared archive plan without changing stored data', async () => {
    const store = new RecoveryStore();
    store.value = await validState();
    const backend = recoveryBackend(store);
    const app = new AppControllerImpl(store);
    await expect(app.load()).rejects.toThrow();
    const before = structuredClone(store.value);
    const plan = await app.prepareStartupRecovery();
    expect(plan.planHash).toBe(backend.plan.planHash);
    expect((await app.getStartupRecoveryStatus()).phase).toBe('prepared');
    await app.cancelStartupRecovery();
    expect((await app.getStartupRecoveryStatus()).phase).toBe('failed');
    expect(store.value).toEqual(before);
    expect(backend.commitCalls).toBe(0);
    await app.retryStartup();
    expect((await app.getStartupRecoveryStatus()).phase).toBe('ready');
  });

  it('clears a prepared plan after a successful ordinary startup retry', async () => {
    const store = new RecoveryStore();
    store.value = await validState();
    recoveryBackend(store);
    const app = new AppControllerImpl(store);
    await expect(app.load()).rejects.toThrow();
    const plan = await app.prepareStartupRecovery();
    await app.retryStartup();
    expect((await app.getStartupRecoveryStatus()).phase).toBe('ready');
    await expect(app.commitStartupRecovery({ sessionId: plan.sessionId, planHash: plan.planHash })).rejects.toThrow(/plan is not current/i);
  });

  it('uses the durable receipt after a lost commit response instead of archiving twice', async () => {
    const store = new RecoveryStore();
    store.value = await validState();
    const backend = recoveryBackend(store, { loseCommitResponse: true });
    const app = new AppControllerImpl(store);
    await expect(app.load()).rejects.toThrow();
    const plan = await app.prepareStartupRecovery();
    await expect(app.commitStartupRecovery({ sessionId: plan.sessionId, planHash: plan.planHash })).resolves.toMatchObject({
      operationId: receipt.operationId, archiveId: receipt.archiveId,
    });
    expect(backend.commitCalls).toBe(1);
    expect(backend.acknowledgeCalls).toBe(1);
    expect((await app.getStartupRecoveryStatus()).phase).toBe('ready');
    expect(app.getSnapshot().notes).toEqual([]);
  });

  it('does not turn an ancillary document mirror failure into failed core startup', async () => {
    const store: StateStore = { load: async () => undefined, save: async () => undefined, clear: async () => undefined };
    const app = new AppControllerImpl(store, {}, { writeDocument: async () => { throw new Error('mirror unavailable'); } });
    await expect(app.load()).resolves.toBeUndefined();
    expect((await app.getStartupRecoveryStatus()).phase).toBe('ready');
    await expect(app.prepareStartupRecovery()).rejects.toThrow(/only after core startup fails/i);
  });

  it('does not publish a loaded snapshot when the storage generation changed during startup', async () => {
    const store = new RecoveryStore();
    store.loadErrorCount = 0;
    store.value = await validState();
    recoveryBackend(store);
    store.assertError = new Error('storage generation changed');
    const app = new AppControllerImpl(store);
    await expect(app.load()).rejects.toThrow(/generation changed/i);
    expect((await app.getStartupRecoveryStatus()).phase).toBe('failed');
    expect(app.getSnapshot().notes).toEqual([]);
    await expect(app.saveNote({ transcript: 'Must wait for current storage generation.' })).rejects.toThrow(/startup is not ready/i);
  });

  it('opens a committed replacement after restart without another archive commit', async () => {
    const store = new RecoveryStore();
    store.value = await validState();
    const backend = recoveryBackend(store);
    const firstApp = new AppControllerImpl(store);
    await expect(firstApp.load()).rejects.toThrow();
    const plan = await firstApp.prepareStartupRecovery();
    store.loadErrorCount = 1; // Fail the fresh-store open after the durable swap.
    await expect(firstApp.commitStartupRecovery({ sessionId: plan.sessionId, planHash: plan.planHash })).resolves.toMatchObject({ archiveId: receipt.archiveId });
    expect((await firstApp.getStartupRecoveryStatus()).phase).toBe('committed_opening');
    expect(backend.acknowledgeCalls).toBe(0);

    const restarted = new AppControllerImpl(store);
    await restarted.load();
    expect(restarted.getSnapshot().notes).toEqual([]);
    expect(backend.commitCalls).toBe(1);
    expect(backend.acknowledgeCalls).toBe(1);
    expect((await restarted.getStartupRecoveryStatus()).phase).toBe('ready');
  });

  it('does not let a delayed status inspection overwrite a successful explicit retry', async () => {
    const store = new RecoveryStore();
    store.value = await validState();
    recoveryBackend(store);
    const original = store.recovery.inspect.bind(store.recovery);
    let calls = 0;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    store.recovery.inspect = vi.fn(async () => {
      calls += 1;
      if (calls === 2) await delayed;
      return original();
    });
    const app = new AppControllerImpl(store);
    await expect(app.load()).rejects.toThrow(); // First inspect is failure cleanup.
    const status = app.getStartupRecoveryStatus(); // Second inspect is deliberately delayed.
    await vi.waitFor(() => expect(calls).toBe(2));
    await app.retryStartup();
    expect((await app.getStartupRecoveryStatus()).phase).toBe('ready');
    release();
    await expect(status).resolves.toMatchObject({ phase: 'ready' });
    expect((await app.getStartupRecoveryStatus()).phase).toBe('ready');
  });
});
