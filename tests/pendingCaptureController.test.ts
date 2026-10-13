import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import type { PendingCaptureControllerPort, PendingCaptureReceipt, PendingCaptureSafeStatus } from '../src/audio/pendingCaptureService.types';
import type { PendingCaptureRecord } from '../src/storage/pendingCapture';

const id = '00000000-0000-4000-8000-000000000001';
const revision = '00000000-0000-4000-8000-000000000002';
const uri = 'file:///mock/Documents/ExpoAudio/recording-00000000-0000-4000-8000-000000000003.m4a';

class MemoryStore implements StateStore {
  value?: AppState;
  consumed = false;
  failAfterCommit = false;
  failBeforeCommit = false;
  allowConsumedEvidence = true;
  afterConsumeCommit?: () => void;
  onNextLoad?: () => void;
  failAssert = false;
  saves = 0;
  consumeSaves = 0;
  seenOptions?: Parameters<StateStore['save']>[1];
  async save(state: AppState, options?: Parameters<StateStore['save']>[1]) {
    this.seenOptions = structuredClone(options);
    this.saves += 1;
    if (options?.consumePendingCapture) this.consumeSaves += 1;
    if (this.failBeforeCommit) { this.failBeforeCommit = false; throw new Error('injected write failure'); }
    this.value = structuredClone(state);
    if (options?.consumePendingCapture) this.consumed = true;
    if (options?.consumePendingCapture) this.afterConsumeCommit?.();
    if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('lost acknowledgement'); }
  }
  async clear() { this.value = undefined; }
  async assertCurrent() { if (this.failAssert) throw new Error('store fence failed'); }
  async load() {
    const value = this.value ? structuredClone(this.value) : undefined;
    const callback = this.onNextLoad;
    this.onNextLoad = undefined;
    callback?.();
    return value;
  }
}

function setup(writerActive = false) {
  const store = new MemoryStore();
  let cleanupBlocked = false;
  let cleanupRetryCalls = 0;
  const pendingStatus = (): PendingCaptureSafeStatus => cleanupBlocked
    ? { kind: 'blocked', reason: 'cleanup_required' }
    : { kind: 'empty' };
  const capture: PendingCaptureRecord = {
    version: 1, id, originalPath: 'ExpoAudio/recording-00000000-0000-4000-8000-000000000003.m4a',
    capturedAt: '2026-10-13T02:03:04.125Z', captureTimeZone: 'Asia/Singapore', phase: 'inspected',
    replacementPaths: [], replacementOverflow: false, inspection: { outcome: 'known', durationSeconds: 8.375 },
  };
  const pendingCapture = {
    async getStatus() { return pendingStatus(); },
    async inspect() { return pendingStatus(); },
    async export() { if (cleanupBlocked) throw new Error('source cleanup is still pending'); },
    async discard() { return pendingStatus(); },
    async retryPendingCaptureSourceRelease() { cleanupRetryCalls++; return pendingStatus(); },
    async readForAdoption(_receipt: PendingCaptureReceipt) {
      if (store.consumed) throw new Error('already consumed');
      return { capture, uri };
    },
    async readConsumedEvidence(receiptId: string) { return store.allowConsumedEvidence && store.consumed && receiptId === id; },
  } as unknown as PendingCaptureControllerPort;
  const app = new AppControllerImpl(store, {}, {
    writeDocument: async () => undefined,
    privacySession: {
      epoch: 'pending-capture-test-epoch',
      async assertCurrent() {},
      async getStatus() { return { phase: writerActive ? 'writer_active' as const : 'ready' as const, epoch: 'pending-capture-test-epoch',
        activeWriterCount: writerActive ? 1 : 0, pendingCleanupCount: 0, failedCleanupCount: 0,
        limits: { namespaces: 10, oauthTokenRefs: 10, legacyMarkdownPaths: 10, writerLeases: 10, cleanupTargets: 100, cleanupBatch: 16 },
        coverage: 'tracked_with_legacy_limits' as const }; },
    },
  }, pendingCapture);
  return { app, store, setCleanupBlocked(value: boolean) { cleanupBlocked = value; }, cleanupRetryCalls: () => cleanupRetryCalls };
}

describe('pending capture controller adoption', () => {
  it('atomically saves a deterministic note using the journal receipt', async () => {
    const { app, store } = setup();
    await app.load();
    const note = await app.savePendingCapture({ id, revision });
    expect(note).toMatchObject({ id, audioUri: uri, durationSeconds: 8.375, capturedAt: '2026-10-13T02:03:04.125Z', captureTimeZone: 'Asia/Singapore' });
    expect(app.getSnapshot().notes.map((item) => item.id)).toEqual([id]);
    expect(store.seenOptions).toEqual({ consumePendingCapture: { id, revision, noteId: id } });
  });

  it('recovers a lost acknowledgement only from the consumed slot and the exact persisted note', async () => {
    const { app, store } = setup();
    await app.load();
    store.failAfterCommit = true;
    const note = await app.savePendingCapture({ id, revision });
    expect(note.id).toBe(id);
    expect(store.value?.notes).toHaveLength(1);
    expect(store.value?.notes[0].audioUri).toBe(uri);
    expect(app.getSnapshot().notes).toHaveLength(1);
    expect(store.seenOptions).toEqual({ consumePendingCapture: { id, revision, noteId: id } });
    const retried = await app.savePendingCapture({ id, revision });
    expect(retried.id).toBe(id);
    expect(store.value?.notes.filter((item) => item.id === id)).toHaveLength(1);
    expect(store.consumeSaves).toBe(1);
  });

  it('does not publish a failed consume write and retries with the same deterministic note id', async () => {
    const { app, store } = setup();
    await app.load();
    store.failBeforeCommit = true;
    await expect(app.savePendingCapture({ id, revision })).rejects.toThrow(/could not be saved/i);
    expect(app.getSnapshot().notes).toHaveLength(0);
    expect(store.value?.notes ?? []).toHaveLength(0);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    await app.refreshPersistedWorkspace();
    const note = await app.savePendingCapture({ id, revision });
    expect(note.id).toBe(id);
    expect(app.getSnapshot().notes.filter((item) => item.id === id)).toHaveLength(1);
    expect(store.value?.notes.filter((item) => item.id === id)).toHaveLength(1);
  });

  it('keeps read-only pending-capture recovery reachable while a separate data refresh gate remains set', async () => {
    const { app, store, setCleanupBlocked, cleanupRetryCalls } = setup(true);
    await app.load();
    store.failBeforeCommit = true;
    await expect(app.saveNote({ transcript: 'Force a durable-store gate.' })).rejects.toThrow(/injected write failure/i);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    setCleanupBlocked(true);
    await expect(app.refreshPersistedWorkspace()).rejects.toThrow(/storage is still in use/i);
    const readsBefore = store.saves;
    await expect(app.getPendingCaptureStatus()).resolves.toMatchObject({ kind: 'blocked', reason: 'cleanup_required' });
    await expect(app.inspectPendingCapture({ id, revision })).resolves.toMatchObject({ kind: 'blocked', reason: 'cleanup_required' });
    await expect(app.exportPendingCapture({ id, revision })).rejects.toThrow(/source cleanup is still pending/i);
    await expect(app.discardPendingCapture({ id, revision })).resolves.toMatchObject({ kind: 'blocked', reason: 'cleanup_required' });
    await expect(app.retryPendingCaptureSourceRelease()).resolves.toMatchObject({ kind: 'blocked', reason: 'cleanup_required' });
    expect(cleanupRetryCalls()).toBe(1);
    expect(store.saves).toBe(readsBefore);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
  });

  it.each([
    ['consumed receipt is absent', (store: MemoryStore) => { store.allowConsumedEvidence = false; }],
    ['fresh persisted snapshot has an unrelated private-sidecar change', (store: MemoryStore) => {
      store.afterConsumeCommit = () => {
        (store.value as AppState & { proactiveMailAlertQuarantine?: unknown[] }).proactiveMailAlertQuarantine = ['private-concurrent-sidecar'];
      };
    }],
    ['final storage ownership fence is unavailable', (store: MemoryStore) => {
      (store as unknown as { assertCurrent?: () => Promise<void> }).assertCurrent = undefined;
    }],
    ['final storage ownership fence rejects', (store: MemoryStore) => { store.failAssert = true; }],
  ])('keeps the data gate closed when exact consume recovery fails because %s', async (_reason, configure) => {
    const { app, store } = setup();
    await app.load();
    configure(store);
    store.failAfterCommit = true;
    await expect(app.savePendingCapture({ id, revision })).rejects.toThrow(/could not be saved/i);
    expect(app.getSnapshot().notes).toHaveLength(0);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
  });

  it('does not adopt a consumed write if the workspace generation changes during the final read', async () => {
    const { app, store } = setup();
    await app.load();
    const internal = app as unknown as { bootstrapGeneration: number };
    store.onNextLoad = () => { internal.bootstrapGeneration += 1; };
    store.failAfterCommit = true;
    await expect(app.savePendingCapture({ id, revision })).rejects.toThrow(/could not be saved/i);
    expect(app.getSnapshot().notes).toHaveLength(0);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
  });

  it('keeps the gate closed if publishing an otherwise proven consume recovery fails', async () => {
    const { app, store } = setup();
    await app.load();
    const internal = app as unknown as { publicState: (state: AppState) => AppState; mailAlertRefreshRequired: boolean };
    const original = internal.publicState.bind(app);
    let failed = false;
    internal.publicState = (state) => {
      if (!internal.mailAlertRefreshRequired && !failed) { failed = true; throw new Error('publication failed'); }
      return original(state);
    };
    store.failAfterCommit = true;
    await expect(app.savePendingCapture({ id, revision })).rejects.toThrow(/could not be saved/i);
    expect(store.consumed).toBe(true);
    expect(app.getSnapshot().notes).toHaveLength(0);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
  });
});
