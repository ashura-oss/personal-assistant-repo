import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import type { PendingCaptureControllerPort, PendingCaptureReceipt } from '../src/audio/pendingCaptureService.types';
import type { PendingCaptureRecord } from '../src/storage/pendingCapture';

const id = '00000000-0000-4000-8000-000000000001';
const revision = '00000000-0000-4000-8000-000000000002';
const uri = 'file:///mock/Documents/ExpoAudio/recording-00000000-0000-4000-8000-000000000003.m4a';

class MemoryStore implements StateStore {
  value?: AppState;
  consumed = false;
  failAfterCommit = false;
  failBeforeCommit = false;
  saves = 0;
  consumeSaves = 0;
  seenOptions?: Parameters<StateStore['save']>[1];
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState, options?: Parameters<StateStore['save']>[1]) {
    this.seenOptions = structuredClone(options);
    this.saves += 1;
    if (options?.consumePendingCapture) this.consumeSaves += 1;
    if (this.failBeforeCommit) { this.failBeforeCommit = false; throw new Error('injected write failure'); }
    this.value = structuredClone(state);
    if (options?.consumePendingCapture) this.consumed = true;
    if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('lost acknowledgement'); }
  }
  async clear() { this.value = undefined; }
}

function setup() {
  const store = new MemoryStore();
  const capture: PendingCaptureRecord = {
    version: 1, id, originalPath: 'ExpoAudio/recording-00000000-0000-4000-8000-000000000003.m4a',
    capturedAt: '2026-10-13T02:03:04.125Z', captureTimeZone: 'Asia/Singapore', phase: 'inspected',
    replacementPaths: [], replacementOverflow: false, inspection: { outcome: 'known', durationSeconds: 8.375 },
  };
  const pendingCapture = {
    async getStatus() { return { kind: 'empty' as const }; },
    async inspect() { return { kind: 'empty' as const }; },
    async export() {},
    async discard() { return { kind: 'empty' as const }; },
    async retryPendingCaptureSourceRelease() { return { kind: 'empty' as const }; },
    async readForAdoption(_receipt: PendingCaptureReceipt) {
      if (store.consumed) throw new Error('already consumed');
      return { capture, uri };
    },
    async readConsumedEvidence(receiptId: string) { return store.consumed && receiptId === id; },
  } as unknown as PendingCaptureControllerPort;
  const app = new AppControllerImpl(store, {}, { writeDocument: async () => undefined }, pendingCapture);
  return { app, store };
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
    const note = await app.savePendingCapture({ id, revision });
    expect(note.id).toBe(id);
    expect(app.getSnapshot().notes.filter((item) => item.id === id)).toHaveLength(1);
    expect(store.value?.notes.filter((item) => item.id === id)).toHaveLength(1);
  });
});
