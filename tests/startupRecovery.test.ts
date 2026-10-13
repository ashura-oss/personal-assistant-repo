import { DatabaseSync } from 'node:sqlite';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import { SQLiteStateStore, type SQLiteExecutor, type SQLiteTransactionDatabase } from '../src/storage/platformStorage';
import { IndexedDbStateStore } from '../src/storage/platformStorage.web';
import { createStartupRecoveryBackend, STARTUP_RECOVERY_MAX_ARCHIVES, STARTUP_RECOVERY_MAX_ARCHIVE_BYTES, type StartupRecoveryPersistence, type StartupRecoveryPlan, type StartupRecoveryTransaction } from '../src/storage/startupRecovery';

vi.stubGlobal('IDBKeyRange', IDBKeyRange);

const appState = (marker: string) => ({ marker }) as unknown as AppState;
function ids() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('keeps the recovery transaction open until sibling reads settle after a synchronous read failure', async () => {
  const sibling = deferred<{ evidenceBytes: number }[]>();
  const siblingStarted = deferred<void>();
  let rollbackStarted = false;
  let transactionFinished = false;
  const transaction = {
    readSnapshotMetadata() { throw new Error('metadata read failed'); },
    readArchiveMetadata() { siblingStarted.resolve(); return sibling.promise; },
    readPendingReceipt: async () => undefined,
  } as unknown as StartupRecoveryTransaction;
  const persistence: StartupRecoveryPersistence = {
    async withTransaction<T>(work: (tx: StartupRecoveryTransaction) => Promise<T>) {
      try { return await work(transaction); }
      catch (error) { rollbackStarted = true; throw error; }
      finally { transactionFinished = true; }
    },
  };
  const backend = createStartupRecoveryBackend({ persistence });

  const inspection = backend.inspect();
  await siblingStarted.promise;
  await Promise.resolve();
  expect(rollbackStarted).toBe(false);
  expect(transactionFinished).toBe(false);

  sibling.resolve([]);
  await expect(inspection).rejects.toThrow('metadata read failed');
  expect(rollbackStarted).toBe(true);
  expect(transactionFinished).toBe(true);
});

function sqliteMemory(options: { failReplacementWrite?: () => boolean } = {}): SQLiteTransactionDatabase & { close(): void; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const executor: SQLiteExecutor = {
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...params) {
      if (options.failReplacementWrite?.() && sql.startsWith('INSERT INTO app_state')) throw new Error('injected write fault');
      const result = raw.prepare(sql).run(...params as never[]);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async getFirstAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return (raw.prepare(sql).get(...params as never[]) as T | undefined) ?? null; },
    async getAllAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return raw.prepare(sql).all(...params as never[]) as T[]; },
  };
  let transactionQueue: Promise<void> = Promise.resolve();
  const db: SQLiteTransactionDatabase & { close(): void; raw: DatabaseSync } = {
    ...executor,
    async withExclusiveTransactionAsync(work) {
      const previous = transactionQueue;
      let unlock!: () => void;
      transactionQueue = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      raw.exec('BEGIN IMMEDIATE');
      try { await work(executor); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
      finally { unlock(); }
    },
    close() { raw.close(); },
    raw,
  };
  return db;
}

describe('SQLite startup recovery', () => {
  it('archives the exact source atomically, returns a receipt after restart, and acknowledges the opened workspace', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids(), sha256: async (value) => 'a'.repeat(64) });
    const original = appState('bad-but-preserved');
    const fresh = appState('fresh');
    await store.save(original);
    const plan = await store.recovery!.prepare();
    expect(plan).toMatchObject({ operation: 'archive_and_start_fresh', evidenceBytes: Buffer.byteLength(JSON.stringify(original)) });
    const first = await store.recovery!.commit(plan, fresh);
    expect(first.alreadyCommitted).toBe(false);
    expect(await store.load()).toEqual(fresh);
    expect(db.raw.prepare('SELECT raw FROM recovery_archives WHERE archive_id=?').get(first.archiveId)).toEqual({ raw: JSON.stringify(original) });
    const restarted = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids() });
    await expect(restarted.recovery!.commit(plan, appState('different retry body'))).resolves.toMatchObject({ operationId: first.operationId, alreadyCommitted: true });
    expect((await restarted.recovery!.inspect()).pendingReceipt).toMatchObject({ operationId: first.operationId, alreadyCommitted: true });
    await restarted.load();
    await restarted.recovery!.acknowledgeOpened(first.operationId);
    expect((await restarted.recovery!.inspect()).pendingReceipt).toBeUndefined();
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM recovery_archives').get()).toEqual({ count: 1 });
    db.close();
  });

  it('rejects stale ABA plans after a normal write even when raw state is restored', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids(), sha256: async () => 'b'.repeat(64) });
    const original = appState('same');
    await store.save(original);
    const plan = await store.recovery!.prepare();
    await store.save(appState('changed'));
    await store.save(original);
    await expect(store.recovery!.commit(plan, appState('fresh'))).rejects.toThrow(/changed/i);
    expect(await store.load()).toEqual(original);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM recovery_archives').get()).toEqual({ count: 0 });
    db.close();
  });

  it('fences stale store instances from save, publish, and acknowledgement after recovery', async () => {
    const db = sqliteMemory();
    const writer = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids(), sha256: async () => '8'.repeat(64) });
    await writer.save(appState('source-A'));
    const oldWorkspace = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids() });
    await oldWorkspace.load();
    const plan = await writer.recovery!.prepare();
    const receipt = await writer.recovery!.commit(plan, appState('fresh-B'));

    await expect(oldWorkspace.save(appState('stale-write'))).rejects.toThrow(/changed in another workspace/i);
    await expect(oldWorkspace.assertCurrent()).rejects.toThrow(/changed in another workspace/i);
    await expect(oldWorkspace.recovery!.acknowledgeOpened(receipt.operationId)).rejects.toThrow(/no longer owns/i);
    expect(await writer.load()).toEqual(appState('fresh-B'));

    const freshWorkspace = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids() });
    await freshWorkspace.load();
    await freshWorkspace.save(appState('normalized-C'));
    await freshWorkspace.assertCurrent();
    // Simulate a restart before acknowledgement, then another owned normalization write.
    const restartedWorkspace = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids() });
    await restartedWorkspace.load();
    await restartedWorkspace.save(appState('normalized-D'));
    await restartedWorkspace.recovery!.acknowledgeOpened(receipt.operationId);
    expect((await restartedWorkspace.recovery!.inspect()).pendingReceipt).toBeUndefined();
    expect(await restartedWorkspace.load()).toEqual(appState('normalized-D'));
    db.close();
  });

  it('rejects a prepare whose captured source changes while its digest is pending', async () => {
    const db = sqliteMemory();
    let releaseDigest!: (value: string) => void;
    let digestStarted!: () => void;
    const started = new Promise<void>((resolve) => { digestStarted = resolve; });
    const blockedDigest = new Promise<string>((resolve) => { releaseDigest = resolve; });
    const first = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids(), sha256: async () => { digestStarted(); return blockedDigest; } });
    await first.save(appState('source-A'));
    const preparing = first.recovery!.prepare();
    await started;

    const other = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids(), sha256: async () => '9'.repeat(64) });
    const otherPlan = await other.recovery!.prepare();
    const receipt = await other.recovery!.commit(otherPlan, appState('source-B'));
    releaseDigest('a'.repeat(64));
    await expect(preparing).rejects.toThrow(/changed while recovery was being prepared/i);
    expect(await first.load()).toEqual(appState('source-B'));
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM recovery_archives').get()).toEqual({ count: 1 });
    expect((await other.recovery!.inspect()).pendingReceipt?.operationId).toBe(receipt.operationId);
    db.close();
  });

  it('serializes concurrent commits and preserves old data if a transaction write fails', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids(), sha256: async () => 'c'.repeat(64) });
    await store.save(appState('original'));
    const plan = await store.recovery!.prepare();
    const results = await Promise.all([store.recovery!.commit(plan, appState('fresh')), store.recovery!.commit(plan, appState('ignored'))]);
    expect(results.map((item) => item.alreadyCommitted).sort()).toEqual([false, true]);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM recovery_archives').get()).toEqual({ count: 1 });
    db.close();

    let fault = false;
    const faultyDb = sqliteMemory({ failReplacementWrite: () => fault });
    const faulty = new SQLiteStateStore({ database: Promise.resolve(faultyDb), randomId: ids(), sha256: async () => 'd'.repeat(64) });
    await faulty.save(appState('preserve-me'));
    const retryPlan = await faulty.recovery!.prepare();
    fault = true;
    await expect(faulty.recovery!.commit(retryPlan, appState('fresh'))).rejects.toThrow();
    expect(await faulty.load()).toEqual(appState('preserve-me'));
    expect(faultyDb.raw.prepare('SELECT COUNT(*) AS count FROM recovery_archives').get()).toEqual({ count: 0 });
    faultyDb.close();
  });

  it('reports missing, newer-schema, oversized, and archive-cap states without parsing saved JSON', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids(), sha256: async () => 'e'.repeat(64) });
    await expect(store.recovery!.prepare()).rejects.toThrow(/eligible/i);
    expect((await store.recovery!.inspect()).status).toBe('empty');
    await store.save(appState('newer'));
    await db.runAsync('UPDATE app_state SET schema_version=2 WHERE key=?', 'voice-assistant.state.v1');
    expect((await store.recovery!.inspect()).status).toBe('newer_version');
    await expect(store.load()).rejects.toThrow(/newer version/i);
    await db.runAsync('UPDATE app_state SET schema_version=1,value=? WHERE key=?', 'x'.repeat(32 * 1024 * 1024 + 1), 'voice-assistant.state.v1');
    expect((await store.recovery!.inspect()).status).toBe('too_large');
    await db.runAsync('UPDATE app_state SET value=?,schema_version=1 WHERE key=?', '{}', 'voice-assistant.state.v1');
    await store.save(appState('cap-start'));
    for (let i = 0; i < STARTUP_RECOVERY_MAX_ARCHIVES; i += 1) {
      const plan = await store.recovery!.prepare();
      const receipt = await store.recovery!.commit(plan, appState(`cap-${i}`));
      await store.load();
      await store.recovery!.acknowledgeOpened(receipt.operationId);
    }
    expect((await store.recovery!.inspect()).status).toBe('archive_full');
    expect(STARTUP_RECOVERY_MAX_ARCHIVE_BYTES).toBe(128 * 1024 * 1024);
    db.close();
  });

  it('expires prepared sessions and requires explicit acknowledgement before another recovery', async () => {
    const db = sqliteMemory();
    let now = Date.parse('2026-10-13T00:00:00.000Z');
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: ids(), now: () => now, sha256: async () => '1'.repeat(64) });
    // Store's factory clock is injectable through its recovery instance in platform-specific tests only;
    // expiration is exercised by setting a valid old plan directly in a tiny helper store below.
    await store.save(appState('original'));
    const plan = await store.recovery!.prepare();
    now += 6 * 60 * 1000;
    await expect(store.recovery!.commit(plan, appState('fresh'))).rejects.toThrow(/expired/i);
    now += 1;
    const replacementPlan = await store.recovery!.prepare();
    const receipt = await store.recovery!.commit(replacementPlan, appState('fresh'));
    expect(receipt.alreadyCommitted).toBe(false);
    await expect(store.recovery!.prepare()).rejects.toThrow(/open the previously recovered/i);
    db.close();
  });
});

describe('IndexedDB startup recovery', () => {
  it('keeps recovery inspection open until the request-error transaction aborts', async () => {
    let abortRequested!: () => void;
    const abortRequestedPromise = new Promise<void>((resolve) => { abortRequested = resolve; });
    let closed = false;
    const transactionHandlers: { error?: (event: Event) => void; abort?: (event: Event) => void } = {};
    const cursorRequest = {
      error: new DOMException('Injected cursor failure', 'UnknownError'),
      set onerror(handler: (event: Event) => void) {
        queueMicrotask(() => {
          transactionHandlers.error?.(new Event('error'));
          handler.call(cursorRequest, new Event('error'));
        });
      },
      set onsuccess(_handler: ((event: Event) => void) | null) { /* failure is injected */ },
    } as unknown as IDBRequest<IDBCursorWithValue | null>;
    const transaction = {
      durability: 'strict',
      error: null,
      objectStore: () => ({ openKeyCursor: () => cursorRequest }),
      abort() { abortRequested(); },
      set onerror(handler: ((event: Event) => void) | null) { transactionHandlers.error = handler ?? undefined; },
      set onabort(handler: ((event: Event) => void) | null) { transactionHandlers.abort = handler ?? undefined; },
      set oncomplete(_handler: ((event: Event) => void) | null) { /* held until the test emits abort */ },
    } as unknown as IDBTransaction;
    const database = {
      objectStoreNames: { contains: () => true },
      transaction: () => transaction,
      close() { closed = true; },
      set onversionchange(_handler: (() => void) | null) { /* registry bookkeeping */ },
    } as unknown as IDBDatabase;
    const factory = {
      open: () => {
        const opening = {
          result: database,
          set onupgradeneeded(_handler: (() => void) | null) { /* existing app store */ },
          set onsuccess(handler: (() => void) | null) { if (handler) queueMicrotask(handler); },
          set onerror(_handler: (() => void) | null) { /* not used */ },
        };
        return opening as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
    const store = new IndexedDbStateStore({ factory, randomId: ids() });
    let settled = false;
    const inspection = store.recovery!.inspect().finally(() => { settled = true; });

    await abortRequestedPromise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    transactionHandlers.abort?.(new Event('abort'));
    await expect(inspection).rejects.toThrow();
    expect(settled).toBe(true);
    expect(closed).toBe(true);
  });

  it('atomically saves schema/generation metadata and recovers with a restart-safe receipt', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbStateStore({ factory, randomId: ids(), sha256: async () => '2'.repeat(64) });
    const original = appState('web-original');
    const fresh = appState('web-fresh');
    await store.save(original);
    const plan: StartupRecoveryPlan = await store.recovery!.prepare();
    expect((await store.recovery!.inspect()).evidenceBytes).toBe(Buffer.byteLength(JSON.stringify(original)));
    const first = await store.recovery!.commit(plan, fresh);
    expect(first.alreadyCommitted).toBe(false);
    const restarted = new IndexedDbStateStore({ factory, randomId: ids() });
    await expect(restarted.recovery!.commit(plan, fresh)).resolves.toMatchObject({ operationId: first.operationId, alreadyCommitted: true });
    expect(await restarted.load()).toEqual(fresh);
    await restarted.recovery!.acknowledgeOpened(first.operationId);
    expect((await restarted.recovery!.inspect()).pendingReceipt).toBeUndefined();
  });

  it('preserves the prior snapshot on serialization failure and rejects missing receipt markers', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbStateStore({ factory, randomId: ids(), sha256: async () => '4'.repeat(64) });
    const original = appState('web-safe');
    await store.save(original);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(store.save(circular as unknown as AppState)).rejects.toThrow();
    expect(await store.load()).toEqual(original);

    const plan = await store.recovery!.prepare();
    const receipt = await store.recovery!.commit(plan, appState('web-fresh'));
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open('voice-assistant', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').delete(`__still.recovery.pending.v1:${receipt.operationId}`);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    await expect(store.recovery!.inspect()).rejects.toThrow(/journal is unavailable/i);
    db.close();
  });

  it('blocks newer or malformed metadata and detects stale web snapshot changes', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbStateStore({ factory, randomId: ids(), sha256: async () => '3'.repeat(64) });
    await store.save(appState('before'));
    const plan = await store.recovery!.prepare();
    await store.save(appState('after'));
    await expect(store.recovery!.commit(plan, appState('fresh'))).rejects.toThrow(/changed/i);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open('voice-assistant', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put({ schemaVersion: 2 }, '__still.storage.schema.v1');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    expect((await store.recovery!.inspect()).status).toBe('newer_version');
    await expect(store.load()).rejects.toThrow(/newer version/i);
    db.close();
  });

  it('fences stale browser workspace writes and permits acknowledgement after an owned normalization save', async () => {
    const factory = new IDBFactory();
    const writer = new IndexedDbStateStore({ factory, randomId: ids(), sha256: async () => '5'.repeat(64) });
    await writer.save(appState('web-A'));
    const oldWorkspace = new IndexedDbStateStore({ factory, randomId: ids() });
    await oldWorkspace.load();
    const plan = await writer.recovery!.prepare();
    const receipt = await writer.recovery!.commit(plan, appState('web-B'));

    await expect(oldWorkspace.save(appState('web-stale'))).rejects.toThrow(/changed in another workspace/i);
    await expect(oldWorkspace.assertCurrent()).rejects.toThrow(/changed in another workspace/i);
    await expect(oldWorkspace.recovery!.acknowledgeOpened(receipt.operationId)).rejects.toThrow(/no longer owns/i);
    expect(await writer.load()).toEqual(appState('web-B'));

    const freshWorkspace = new IndexedDbStateStore({ factory, randomId: ids() });
    await freshWorkspace.load();
    await freshWorkspace.save(appState('web-C'));
    const restartedWorkspace = new IndexedDbStateStore({ factory, randomId: ids() });
    await restartedWorkspace.load();
    await restartedWorkspace.save(appState('web-D'));
    await restartedWorkspace.recovery!.acknowledgeOpened(receipt.operationId);
    expect((await restartedWorkspace.recovery!.inspect()).pendingReceipt).toBeUndefined();
    expect(await restartedWorkspace.load()).toEqual(appState('web-D'));
  });
});
