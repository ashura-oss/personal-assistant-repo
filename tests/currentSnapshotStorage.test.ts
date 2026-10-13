import { DatabaseSync } from 'node:sqlite';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { AppState, Note } from '../src/core';
import { SQLiteStateStore, type SQLiteExecutor, type SQLiteTransactionDatabase } from '../src/storage/platformStorage';
import { IndexedDbStateStore } from '../src/storage/platformStorage.web';
import { STATE_SNAPSHOT_READ_MAX_BYTES, STORAGE_KEY } from '../src/storage/contracts';

vi.stubGlobal('IDBKeyRange', IDBKeyRange);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const appState = (notes: Note[] = []) => ({ notes }) as unknown as AppState;
function idFactory(start = 1) { let next = start; return () => uuid(next++); }

async function writeWebMetadata(factory: IDBFactory, updates: Readonly<Record<string, unknown>>, deletes: readonly string[] = []): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('voice-assistant');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = database.transaction('snapshots', 'readwrite');
  const objectStore = tx.objectStore('snapshots');
  for (const [key, value] of Object.entries(updates)) objectStore.put(value, key);
  for (const key of deletes) objectStore.delete(key);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  database.close();
}

function sqliteMemory() {
  const raw = new DatabaseSync(':memory:');
  const executor: SQLiteExecutor = {
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...params) {
      const result = raw.prepare(sql).run(...params as never[]);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async getFirstAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) {
      return (raw.prepare(sql).get(...params as never[]) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return raw.prepare(sql).all(...params as never[]) as T[]; },
  };
  let tail: Promise<void> = Promise.resolve();
  const database: SQLiteTransactionDatabase & { raw: DatabaseSync } = {
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
    raw,
  };
  return database;
}

describe('exact persisted state snapshot reads', () => {
  it('requires a loaded baseline, returns exact native JSON, and leaves the baseline usable for save', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory() });
    await expect(store.readCurrentSnapshot!()).rejects.toThrow(/load the current workspace/i);
    await store.load();
    await store.save(appState());
    const raw = '{ "notes": [], "privateMarker": "kept exactly" }';
    db.raw.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(raw, STORAGE_KEY);

    await expect(store.readCurrentSnapshot!()).resolves.toEqual({ raw, schemaVersion: 1 });
    await store.save(appState([{ id: uuid(90), title: 'saved after exact read' } as Note]));
    db.raw.close();
  });

  it('rejects a stale native reader without rebasing it for a later save', async () => {
    const db = sqliteMemory();
    const stale = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory(1) });
    const writer = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory(100) });
    await stale.load(); await writer.load(); await writer.save(appState());
    await expect(stale.readCurrentSnapshot!()).rejects.toThrow(/changed in another workspace/i);
    await expect(stale.save(appState())).rejects.toThrow(/changed in another workspace/i);
    db.raw.close();
  });

  it('drains a delayed native transaction failure before the queued save starts', async () => {
    const db = sqliteMemory();
    const original = db.withExclusiveTransactionAsync.bind(db);
    let interceptNext = false;
    let releaseFailure!: () => void;
    let startedFailure!: () => void;
    let startedSave!: () => void;
    const failureStarted = new Promise<void>((resolve) => { startedFailure = resolve; });
    const saveStarted = new Promise<void>((resolve) => { startedSave = resolve; });
    const delayed = new Promise<void>((resolve) => { releaseFailure = resolve; });
    let calls = 0;
    db.withExclusiveTransactionAsync = async (work) => {
      calls += 1;
      if (interceptNext) {
        interceptNext = false;
        startedFailure();
        await delayed;
        await original(async (tx) => { await work(tx); throw new Error('delayed snapshot transaction failure'); });
        return;
      }
      if (calls > 2) startedSave();
      await original(work);
    };
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory() });
    await store.load();
    await store.save(appState());
    interceptNext = true;
    const read = store.readCurrentSnapshot!();
    await failureStarted;
    const save = store.save(appState([{ id: uuid(91), title: 'queued' } as Note]));
    let saved = false;
    void save.then(() => { saved = true; });
    await Promise.resolve();
    expect(saved).toBe(false);
    releaseFailure();
    await expect(read).rejects.toThrow('delayed snapshot transaction failure');
    await save;
    await saveStarted;
    expect(saved).toBe(true);
    db.raw.close();
  });

  it('returns exact web JSON and rejects cross-instance generations without rebasing', async () => {
    const factory = new IDBFactory();
    const stale = new IndexedDbStateStore({ factory, randomId: idFactory(200) });
    const writer = new IndexedDbStateStore({ factory, randomId: idFactory(300) });
    await expect(stale.readCurrentSnapshot!()).rejects.toThrow(/load the current workspace/i);
    await stale.load(); await writer.load(); await writer.save(appState());
    const snapshot = await writer.readCurrentSnapshot!();
    expect(snapshot).toEqual({ raw: JSON.stringify(appState()), schemaVersion: 1 });
    await expect(stale.readCurrentSnapshot!()).rejects.toThrow(/changed in another workspace/i);
    await expect(stale.save(appState())).rejects.toThrow(/changed in another workspace/i);
    await writer.save(appState([{ id: uuid(92), title: 'saved after exact read' } as Note]));
  });

  it('serializes a same-instance read behind an already queued save on both stores', async () => {
    const nativeDb = sqliteMemory();
    const native = new SQLiteStateStore({ database: Promise.resolve(nativeDb), randomId: idFactory(700) });
    await native.load();
    const nativeState = appState([{ id: uuid(94), title: 'queued native save' } as Note]);
    const nativeSave = native.save(nativeState);
    const nativeRead = native.readCurrentSnapshot!();
    await nativeSave;
    expect(await nativeRead).toEqual({ raw: JSON.stringify(nativeState), schemaVersion: 1 });
    nativeDb.raw.close();

    const factory = new IDBFactory();
    const browser = new IndexedDbStateStore({ factory, randomId: idFactory(800) });
    await browser.load();
    const webState = appState([{ id: uuid(95), title: 'queued web save' } as Note]);
    const webSave = browser.save(webState);
    const webRead = browser.readCurrentSnapshot!();
    await webSave;
    expect(await webRead).toEqual({ raw: JSON.stringify(webState), schemaVersion: 1 });
  });

  it('validates snapshot schema and UTF-8 size, and computes legacy web size when metadata is absent', async () => {
    const nativeDb = sqliteMemory();
    const nativeStore = new SQLiteStateStore({ database: Promise.resolve(nativeDb), randomId: idFactory(500) });
    await nativeStore.load(); await nativeStore.save(appState());
    nativeDb.raw.prepare('UPDATE app_state SET schema_version = 2 WHERE key = ?').run(STORAGE_KEY);
    await expect(nativeStore.readCurrentSnapshot!()).rejects.toThrow(/newer version/i);
    const multibyteOverLimit = 'é'.repeat(Math.floor(STATE_SNAPSHOT_READ_MAX_BYTES / 2) + 1);
    expect(multibyteOverLimit.length).toBeLessThanOrEqual(STATE_SNAPSHOT_READ_MAX_BYTES);
    expect(new TextEncoder().encode(multibyteOverLimit).byteLength).toBeGreaterThan(STATE_SNAPSHOT_READ_MAX_BYTES);
    nativeDb.raw.prepare('UPDATE app_state SET schema_version = 1, value = ? WHERE key = ?')
      .run(multibyteOverLimit, STORAGE_KEY);
    await expect(nativeStore.readCurrentSnapshot!()).rejects.toThrow(/bounded snapshot read limit/i);
    nativeDb.raw.close();

    const factory = new IDBFactory();
    const browser = new IndexedDbStateStore({ factory, randomId: idFactory(600) });
    await browser.load(); await browser.save(appState());
    const exact = JSON.stringify(appState());
    await writeWebMetadata(factory, {}, ['__still.storage.size.v1']);
    await expect(browser.readCurrentSnapshot!()).resolves.toEqual({ raw: exact, schemaVersion: 1 });
    await writeWebMetadata(factory, { '__still.storage.schema.v1': { schemaVersion: 2 } });
    await expect(browser.readCurrentSnapshot!()).rejects.toThrow(/newer version/i);
    await writeWebMetadata(factory, { '__still.storage.schema.v1': { schemaVersion: 1 }, [STORAGE_KEY]: multibyteOverLimit }, ['__still.storage.size.v1']);
    await expect(browser.readCurrentSnapshot!()).rejects.toThrow(/bounded snapshot read limit/i);
  });

  it('drains a malformed web snapshot transaction and permits a later queued write', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbStateStore({ factory, randomId: idFactory(400) });
    await store.load(); await store.save(appState());
    const opened = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('voice-assistant');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = opened.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put({ invalid: true }, STORAGE_KEY);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    opened.close();

    await expect(store.readCurrentSnapshot!()).rejects.toThrow(/browser data is unavailable/i);
    await store.save(appState([{ id: uuid(93), title: 'write after drained failure' } as Note]));
    expect((await store.readCurrentSnapshot!())?.raw).toBe(JSON.stringify(appState([{ id: uuid(93), title: 'write after drained failure' } as Note])));
  });
});
