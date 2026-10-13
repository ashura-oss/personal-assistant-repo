import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductionWorkspace } from '../src/services/controller';
import { createEmptyPrivacyControlState, validatePrivacyControlState } from '../src/privacy/schema';
import { createPrivacyService } from '../src/privacy/service';
import { createNativePrivacyArbitration } from '../src/privacy/arbitration';
import type { PrivacyControlState, PrivacyControlStore, PrivacyOwner, PrivacyWriterDescriptor, PrivacyWriterLease, PrivacyWriterScope } from '../src/privacy/types';
import { SQLiteStateStore, type SQLiteExecutor, type SQLiteTransactionDatabase } from '../src/storage/platformStorage';
import type { PendingCaptureNativeIO } from '../src/audio/pendingCaptureNativeIO.types';
import type { PrivacyService } from '../src/privacy/service';

vi.hoisted(() => { (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false; });
vi.mock('expo', () => ({ requireOptionalNativeModule: () => undefined }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
afterEach(() => vi.unstubAllGlobals());

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class MemoryControl implements PrivacyControlStore {
  state: PrivacyControlState = createEmptyPrivacyControlState(uuid(1));
  writerReleaseGate?: Promise<void>;
  writerReleaseStarted?: () => void;
  writerAcquireCount = 0;
  async read() { return structuredClone(validatePrivacyControlState(this.state)); }
  async compareAndSwap(revision: string, next: PrivacyControlState) {
    if (revision !== this.state.revision) throw Object.assign(new Error('conflict'), { code: 'conflict' });
    this.writerAcquireCount += Math.max(0, next.writerLeases.length - this.state.writerLeases.length);
    if (next.writerLeases.length < this.state.writerLeases.length && this.writerReleaseGate) {
      const gate = this.writerReleaseGate;
      this.writerReleaseGate = undefined;
      this.writerReleaseStarted?.();
      await gate;
    }
    this.state = structuredClone(validatePrivacyControlState(next));
  }
}

function sqliteMemory() {
  const raw = new DatabaseSync(':memory:');
  const executor: SQLiteExecutor = {
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...params) {
      const result = raw.prepare(sql).run(...params as never[]);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async getFirstAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return (raw.prepare(sql).get(...params as never[]) as T | undefined) ?? null; },
    async getAllAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return raw.prepare(sql).all(...params as never[]) as T[]; },
  };
  let tail = Promise.resolve();
  const database: SQLiteTransactionDatabase & { close(): void } = {
    ...executor,
    async withExclusiveTransactionAsync(work) {
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      raw.exec('BEGIN IMMEDIATE');
      try { await work(executor); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
      finally { release(); }
    },
    close() { raw.close(); },
  };
  return database;
}

function privacyRuntime(): { privacy: PrivacyService; control: MemoryControl; arbitration: ReturnType<typeof createNativePrivacyArbitration> } {
  const owner: PrivacyOwner = { platform: 'ios', runtimeId: uuid(2), processLaunchId: uuid(3), bundleIdentifier: 'com.still.voiceassistant' };
  const arbitration = createNativePrivacyArbitration({ getRuntimeOwner: async () => owner, waitTimeoutMs: 2_000 });
  const control = new MemoryControl();
  const privacy = createPrivacyService({
    controlStore: control, arbitration,
    eraseAdapter: { async erase() {}, async verifyGone() { return true; } },
  });
  return { privacy, control, arbitration };
}

function deferred<T = void>() {
  let settle!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { settle = done; });
  return { promise, resolve(value?: T | PromiseLike<T>) { settle(value as T); } };
}

describe('production pending-capture composition', () => {
  it('uses the same SQLite snapshot and durable capture slot through inspection and atomic note adoption', async () => {
    const { privacy, arbitration } = privacyRuntime();
    const session = await privacy.openWorkspace();
    const database = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(database), randomId: (() => { let n = 10; return () => uuid(n++); })(), resolvePendingCaptureUri: (path) => `file:///mock/Documents/${path}` });
    const sourceUri = `file:///mock/Documents/ExpoAudio/recording-${uuid(9)}.m4a`;
    const files = new Set([sourceUri]);
    const nativeIO: PendingCaptureNativeIO = {
      toRelativePath(uri) {
        const prefix = 'file:///mock/Documents/';
        if (!uri.startsWith(prefix)) throw new Error('outside app documents');
        return uri.slice(prefix.length);
      },
      toUri(path) { return `file:///mock/Documents/${path}`; },
      async exists(uri) { return files.has(uri); },
      async remove(uri) { files.delete(uri); },
      async probe() { return { inspection: { outcome: 'known', durationSeconds: 9.375 } }; },
      async export(uri) { if (!files.has(uri)) throw new Error('missing'); },
    };
    try {
      const workspace = await createProductionWorkspace({ privacy, session, store, pendingCaptureNativeIO: nativeIO, integration: { writeDocument: async () => undefined } });
      expect(workspace.captureJournal).toBeDefined();
      await workspace.controller.load();
      const stopRequested = deferred();
      const stopped = deferred<import('../src/audio/pendingCaptureService.types').PendingCaptureReceipt>();
      const capturePrepared = deferred();
      const requestScopedStatus = deferred();
      const scopedStatusRead = deferred<import('../src/audio/pendingCaptureService.types').PendingCaptureSafeStatus>();
      const captureRelease = deferred();
      const cleanupStarted = deferred();
      const cleanupRelease = deferred();
      const ordinaryRequested = deferred();
      let cleanupDidStart = false;
      const originalWithWriter = privacy.withWriter.bind(privacy);
      const trackedWithWriter = async <T,>(epoch: string, descriptor: PrivacyWriterDescriptor, callback: (lease: PrivacyWriterLease, scope: PrivacyWriterScope) => Promise<T>): Promise<T> => {
        if (descriptor.kind === 'app_state' && descriptor.namespace === 'state_database') ordinaryRequested.resolve();
        return originalWithWriter(epoch, descriptor, callback);
      };
      privacy.withWriter = trackedWithWriter;
      let stoppedReceipt!: import('../src/audio/pendingCaptureService.types').PendingCaptureReceipt;
      const captureJob = privacy.withWriter(session.epoch, { kind: 'audio_capture', namespace: 'native_recordings' }, async (_lease, scope) => {
        const prepared = await workspace.captureJournal!.prepare(scope, { uri: sourceUri, capturedAt: '2026-10-13T04:00:00.125Z', captureTimeZone: 'Asia/Singapore' });
        capturePrepared.resolve();
        await requestScopedStatus.promise;
        scopedStatusRead.resolve(await workspace.captureJournal!.getStatus(scope));
        await stopRequested.promise;
        stoppedReceipt = await workspace.captureJournal!.stopped(scope, prepared, {});
        stopped.resolve(stoppedReceipt);
        await captureRelease.promise;
      });
      await capturePrepared.promise;
      const cleanupJob = arbitration.withCleanupLock(async () => { cleanupDidStart = true; cleanupStarted.resolve(); await cleanupRelease.promise; });
      requestScopedStatus.resolve();
      await expect(scopedStatusRead.promise).resolves.toMatchObject({ kind: 'pending', phase: 'prepared' });
      expect(cleanupDidStart).toBe(false);
      const ordinaryMutation = workspace.controller.saveNote({ transcript: 'ordinary mutation queued before capture journal write' });
      await ordinaryRequested.promise;
      stopRequested.resolve();
      await stopped.promise;
      expect(cleanupDidStart).toBe(false);
      expect((await store.load())?.notes).toHaveLength(0);
      captureRelease.resolve();
      await captureJob;
      await cleanupStarted.promise;
      expect((await store.load())?.notes).toHaveLength(0);
      cleanupRelease.resolve();
      const ordinaryNote = await ordinaryMutation;
      await cleanupJob;
      workspace.captureJournal!.released();
      expect((await store.load())?.notes.some((note) => note.id === ordinaryNote.id)).toBe(true);
      const inspection = await workspace.controller.inspectPendingCapture(stoppedReceipt);
      expect(inspection).toMatchObject({ kind: 'pending', canSave: true, durationSeconds: 9.375 });
      const saved = await workspace.controller.savePendingCapture(inspection.kind === 'pending' ? inspection.receipt : stoppedReceipt);
      expect(saved).toMatchObject({ id: stoppedReceipt.id, audioUri: sourceUri, durationSeconds: 9.375, capturedAt: '2026-10-13T04:00:00.125Z' });
      expect((await store.load())?.notes.filter((note) => note.id === stoppedReceipt.id)).toHaveLength(1);
      expect(await store.pendingCapture.read()).toMatchObject({ kind: 'empty', consumedCaptureId: stoppedReceipt.id });
      expect(await workspace.controller.getPendingCaptureStatus()).toEqual({ kind: 'empty' });
    } finally { database.close(); }
  });

  it('keeps cleanup blocked until the actual privacy writer release settles after an inspection write failure', async () => {
    const { privacy, control } = privacyRuntime();
    const session = await privacy.openWorkspace();
    const database = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(database), randomId: (() => { let n = 100; return () => uuid(n++); })(), resolvePendingCaptureUri: (path) => `file:///mock/Documents/${path}` });
    const sourceUri = `file:///mock/Documents/ExpoAudio/recording-${uuid(19)}.m4a`;
    const nativeIO: PendingCaptureNativeIO = {
      toRelativePath(uri) { const prefix = 'file:///mock/Documents/'; if (!uri.startsWith(prefix)) throw new Error('outside app documents'); return uri.slice(prefix.length); },
      toUri(path) { return `file:///mock/Documents/${path}`; },
      async exists() { return true; }, async remove() {},
      async probe() { return { inspection: { outcome: 'known', durationSeconds: 2.25 }, sourceRelease: { retry() {} } }; },
      async export() {},
    };
    let releaseGate!: () => void;
    let releaseStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    try {
      const workspace = await createProductionWorkspace({ privacy, session, store, pendingCaptureNativeIO: nativeIO, integration: { writeDocument: async () => undefined } });
      await workspace.controller.load();
      const receipt = await privacy.withWriter(session.epoch, { kind: 'audio_capture', namespace: 'native_recordings' }, async (_lease, scope) => {
        const prepared = await workspace.captureJournal!.prepare(scope, { uri: sourceUri, capturedAt: '2026-10-13T04:00:00.125Z', captureTimeZone: 'UTC' });
        return workspace.captureJournal!.stopped(scope, prepared, {});
      });
      workspace.captureJournal!.released();
      await expect(workspace.controller.inspectPendingCapture(receipt)).rejects.toThrow(/source could not be released/i);
      const acquisitionsBeforeBlockedSave = control.writerAcquireCount;
      await expect(workspace.controller.savePendingCapture(receipt)).rejects.toThrow(/could not be saved/i);
      expect(control.writerAcquireCount).toBe(acquisitionsBeforeBlockedSave);
      expect(await workspace.controller.getPendingCaptureStatus()).toEqual({ kind: 'blocked', reason: 'cleanup_required' });
      const backend = store.pendingCapture;
      const update = backend.update.bind(backend);
      backend.update = async (expected, next) => {
        if (next.phase === 'inspected') throw new Error('injected inspection persistence failure');
        return update(expected, next);
      };
      control.writerReleaseStarted = releaseStarted;
      control.writerReleaseGate = gate;
      let retrySettled = false;
      const retry = workspace.controller.retryPendingCaptureSourceRelease().finally(() => { retrySettled = true; });
      await started;
      await Promise.resolve();
      expect(retrySettled).toBe(false);
      expect(await workspace.controller.getPendingCaptureStatus()).toEqual({ kind: 'blocked', reason: 'cleanup_required' });
      releaseGate();
      await expect(retry).rejects.toThrow(/pending recording is unavailable/i);
      expect(await store.pendingCapture.read()).toMatchObject({ kind: 'valid', capture: { phase: 'needs_inspection' } });
      expect(await workspace.controller.getPendingCaptureStatus()).toMatchObject({ kind: 'pending', phase: 'needs_inspection', canSave: false });
    } finally { releaseGate?.(); database.close(); }
  });
});
