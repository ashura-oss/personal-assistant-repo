import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createEmptyPrivacyControlState, validatePrivacyControlState } from '../src/privacy/schema';
import { SQLitePrivacyControlStore, type PrivacySQLiteDatabase, type PrivacySQLiteExecutor } from '../src/privacy/controlStore';
import { IndexedDbPrivacyControlStore } from '../src/privacy/controlStore.web';

function ids() {
  let value = 0;
  return () => `20000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function sqliteMemory(options: { failUpdate?: () => boolean } = {}, filename?: string): PrivacySQLiteDatabase & { raw: DatabaseSync; close(): void } {
  const directory = filename ? undefined : mkdtempSync(join(tmpdir(), 'privacy-control-'));
  const raw = new DatabaseSync(filename ?? join(directory!, 'control.db'));
  const executor: PrivacySQLiteExecutor = {
    async execAsync(sql: string) { raw.exec(sql); },
    async runAsync(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) {
      if (options.failUpdate?.() && sql.startsWith('UPDATE privacy_control')) throw new Error('injected fault');
      const value = raw.prepare(sql).run(...params as never[]);
      return { changes: Number(value.changes) };
    },
    async getFirstAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return (raw.prepare(sql).get(...params as never[]) as T | undefined) ?? null; },
  };
  let queue = Promise.resolve();
  return {
    ...executor,
    async withExclusiveTransactionAsync(work) {
      const previous = queue;
      let unlock!: () => void;
      queue = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      raw.exec('BEGIN IMMEDIATE');
      try { await work(executor); raw.exec('COMMIT'); }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
      finally { unlock(); }
    },
    raw,
    close() { raw.close(); if (directory) rmSync(directory, { recursive: true, force: true }); },
  };
}

function nextState(revision: string, namespace = 'state_database') {
  return validatePrivacyControlState({
    ...createEmptyPrivacyControlState('20000000-0000-4000-8000-999999999999'),
    revision,
    ownedNamespaces: [namespace],
  });
}

describe('SQLite privacy control store', () => {
  it('initializes atomically, supports CAS, and persists across store instances', async () => {
    const db = sqliteMemory();
    const store = new SQLitePrivacyControlStore({ database: Promise.resolve(db), randomId: ids() });
    const [first, concurrent] = await Promise.all([store.read(), store.read()]);
    expect(first).toEqual(concurrent);
    const next = nextState(ids()());
    await store.compareAndSwap(first.revision, next);
    const restarted = new SQLitePrivacyControlStore({ database: Promise.resolve(db), randomId: ids() });
    expect(await restarted.read()).toEqual(next);
    db.close();
  });

  it('serializes initialization and CAS across separate native store instances', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'privacy-control-shared-'));
    const filename = join(directory, 'control.db');
    const firstDb = sqliteMemory({}, filename);
    const secondDb = sqliteMemory({}, filename);
    try {
      const first = new SQLitePrivacyControlStore({ database: Promise.resolve(firstDb), randomId: ids() });
      const second = new SQLitePrivacyControlStore({ database: Promise.resolve(secondDb), randomId: ids() });
      const [a, b] = await Promise.all([first.read(), second.read()]);
      expect(a).toEqual(b);
      const [one, two] = await Promise.allSettled([
        first.compareAndSwap(a.revision, nextState(ids()())),
        second.compareAndSwap(b.revision, nextState(ids()())),
      ]);
      expect([one.status, two.status].filter((status) => status === 'fulfilled')).toHaveLength(1);
      expect([one, two].filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await first.read()).toEqual(await second.read());
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects stale revisions after ABA-style writes and rolls failed writes back', async () => {
    const db = sqliteMemory();
    const nextId = ids();
    const store = new SQLitePrivacyControlStore({ database: Promise.resolve(db), randomId: nextId });
    const first = await store.read();
    const second = nextState(nextId());
    await store.compareAndSwap(first.revision, second);
    const third = nextState(nextId(), 'browser_audio');
    await store.compareAndSwap(second.revision, third);
    await expect(store.compareAndSwap(first.revision, nextState(nextId()))).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.read()).toEqual(third);
    db.close();

    let fail = false;
    const failingDb = sqliteMemory({ failUpdate: () => fail });
    const failingStore = new SQLitePrivacyControlStore({ database: Promise.resolve(failingDb), randomId: ids() });
    const original = await failingStore.read();
    fail = true;
    await expect(failingStore.compareAndSwap(original.revision, nextState(ids()()))).rejects.toMatchObject({ code: 'unavailable' });
    expect(await failingStore.read()).toEqual(original);
    failingDb.close();
  });

  it('retains corrupt and newer control rows instead of reinitializing them', async () => {
    const db = sqliteMemory();
    const store = new SQLitePrivacyControlStore({ database: Promise.resolve(db), randomId: ids() });
    await store.read();
    db.raw.prepare('UPDATE privacy_control SET value=? WHERE key=?').run('{}', 'control-state-v1');
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(db.raw.prepare('SELECT value FROM privacy_control WHERE key=?').get('control-state-v1')).toEqual({ value: '{}' });
    const newer = JSON.stringify({ ...createEmptyPrivacyControlState(ids()()), schemaVersion: 2 });
    db.raw.prepare('UPDATE privacy_control SET schema_version=2,revision=?,value=? WHERE key=?').run(ids()(), newer, 'control-state-v1');
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(db.raw.prepare('SELECT schema_version FROM privacy_control WHERE key=?').get('control-state-v1')).toEqual({ schema_version: 2 });
    db.close();
  });

  it('validates the entire current control row again inside a CAS transaction', async () => {
    const db = sqliteMemory();
    const nextId = ids();
    const store = new SQLitePrivacyControlStore({ database: Promise.resolve(db), randomId: nextId });
    const current = await store.read();
    db.raw.prepare('UPDATE privacy_control SET value=? WHERE key=?').run('{"schemaVersion":2}', 'control-state-v1');
    await expect(store.compareAndSwap(current.revision, nextState(nextId()))).rejects.toMatchObject({ code: 'unavailable' });
    expect(db.raw.prepare('SELECT value,revision FROM privacy_control WHERE key=?').get('control-state-v1')).toEqual({ value: '{"schemaVersion":2}', revision: current.revision });
    db.close();
  });

  it('retries a failed lazy database open without poisoning later reads', async () => {
    const db = sqliteMemory();
    let opens = 0;
    const store = new SQLitePrivacyControlStore({
      openDatabase: async () => {
        opens += 1;
        if (opens === 1) throw new Error('temporary open failure');
        return db;
      },
      randomId: ids(),
    });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect((await store.read()).schemaVersion).toBe(1);
    expect(opens).toBe(2);
    db.close();
  });

  it('fails closed before control-state mutation when SQLite durability is weaker than FULL', async () => {
    const db = sqliteMemory();
    const store = new SQLitePrivacyControlStore({ database: Promise.resolve(db), randomId: ids() });
    await store.read();
    db.raw.exec('PRAGMA synchronous = NORMAL');
    expect(() => db.raw.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', 'privacy_control')).not.toThrow();
    db.raw.prepare('DELETE FROM privacy_control').run();
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM privacy_control').get()).toEqual({ count: 0 });
    db.close();
  });

  it('fails closed before control-state mutation when SQLite journal mode is not WAL', async () => {
    const db = sqliteMemory();
    const store = new SQLitePrivacyControlStore({ database: Promise.resolve(db), randomId: ids() });
    await store.read();
    db.raw.exec('PRAGMA journal_mode = DELETE');
    db.raw.prepare('DELETE FROM privacy_control').run();
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM privacy_control').get()).toEqual({ count: 0 });
    db.close();
  });
});

describe('IndexedDB privacy control store', () => {
  it('keeps the operation and database connection open until a request-error transaction aborts', async () => {
    let requestAbort!: () => void;
    let abortRequested!: () => void;
    const abortRequestedPromise = new Promise<void>((resolve) => { abortRequested = resolve; });
    let closed = false;
    let transactionError: ((event: Event) => void) | null = null;
    let transactionAbort: ((event: Event) => void) | null = null;
    const request = {
      error: new DOMException('Injected request failure', 'UnknownError'),
      set onerror(handler: (event: Event) => void) {
        queueMicrotask(() => {
          transactionError?.(new Event('error'));
          handler.call(request, new Event('error'));
        });
      },
    } as unknown as IDBRequest<unknown>;
    const transaction = {
      durability: 'strict',
      error: null,
      objectStore: () => ({ get: () => request }),
      abort() { abortRequested(); },
      set onerror(handler: ((event: Event) => void) | null) { transactionError = handler; },
      set onabort(handler: ((event: Event) => void) | null) { transactionAbort = handler; },
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
          set onupgradeneeded(_handler: (() => void) | null) { /* existing control store */ },
          set onsuccess(handler: (() => void) | null) { if (handler) queueMicrotask(handler); },
          set onerror(_handler: (() => void) | null) { /* not used */ },
          set onblocked(_handler: (() => void) | null) { /* not used */ },
        };
        return opening as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
    const store = new IndexedDbPrivacyControlStore({ factory, randomId: ids() });
    let settled = false;
    const operation = store.read().finally(() => { settled = true; });

    await abortRequestedPromise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    requestAbort = () => transactionAbort?.(new Event('abort'));
    requestAbort();
    await expect(operation).rejects.toMatchObject({ code: 'unavailable' });
    expect(settled).toBe(true);
    expect(closed).toBe(true);
  });

  it('serializes initialization and revision CAS, and remains available if app storage is deleted', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbPrivacyControlStore({ factory, randomId: ids() });
    const [first, concurrent] = await Promise.all([store.read(), store.read()]);
    expect(first).toEqual(concurrent);
    const next = nextState(ids()());
    await store.compareAndSwap(first.revision, next);
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase('voice-assistant');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const restarted = new IndexedDbPrivacyControlStore({ factory, randomId: ids() });
    expect(await restarted.read()).toEqual(next);
    await expect(restarted.compareAndSwap(first.revision, nextState(ids()()))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('preserves malformed state and rejects a newer schema without resetting it', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbPrivacyControlStore({ factory, randomId: ids() });
    await store.read();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('still-privacy-control-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = async (value: unknown) => {
      const tx = db.transaction('control', 'readwrite');
      tx.objectStore('control').put(value, 'control-state-v1');
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    };
    await write({ nope: true });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(await new Promise((resolve, reject) => { const request = db.transaction('control').objectStore('control').get('control-state-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })).toEqual({ nope: true });
    await write({ ...createEmptyPrivacyControlState(ids()()), schemaVersion: 2 });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    db.close();
  });
});
