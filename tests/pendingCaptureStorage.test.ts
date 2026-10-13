import { DatabaseSync } from 'node:sqlite';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { AppState, Note } from '../src/core';
import { IndexedDbStateStore } from '../src/storage/platformStorage.web';
import { SQLiteStateStore, type SQLiteExecutor, type SQLiteTransactionDatabase } from '../src/storage/platformStorage';
import {
  PENDING_CAPTURE_MAX_BYTES, PENDING_CAPTURE_STORAGE_KEY, assertPendingCaptureConsumption, resolvePendingCaptureUri, validatePendingCaptureRecord,
  type PendingCaptureRecord,
} from '../src/storage/pendingCapture';

vi.stubGlobal('IDBKeyRange', IDBKeyRange);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = (notes: Note[] = []) => ({ notes }) as unknown as AppState;
const capture = (phase: PendingCaptureRecord['phase'] = 'prepared'): PendingCaptureRecord => ({
  version: 1, id: uuid(40), originalPath: `ExpoAudio/recording-${uuid(41)}.m4a`,
  capturedAt: '2026-10-13T04:00:00.125Z', captureTimeZone: 'Asia/Singapore', phase,
  replacementPaths: [], replacementOverflow: false,
  ...(phase === 'inspected' ? { inspection: { outcome: 'known' as const, durationSeconds: 600 } } : {}),
});

function idFactory(start = 1) { let n = start; return () => uuid(n++); }

function sqliteMemory(failKey?: { key?: string }) {
  const raw = new DatabaseSync(':memory:');
  const executor: SQLiteExecutor = {
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...params) {
      if (failKey?.key && params[0] === failKey.key) { failKey.key = undefined; throw new Error('injected pending write failure'); }
      const result = raw.prepare(sql).run(...params as never[]);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async getFirstAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return (raw.prepare(sql).get(...params as never[]) as T | undefined) ?? null; },
    async getAllAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return raw.prepare(sql).all(...params as never[]) as T[]; },
  };
  let queue: Promise<void> = Promise.resolve();
  const db: SQLiteTransactionDatabase & { raw: DatabaseSync; close(): void } = {
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
    close() { raw.close(); }, raw,
  };
  return db;
}

async function webStore(factory = new IDBFactory(), start = 100) {
  let n = start;
  const store = new IndexedDbStateStore({ factory, randomId: () => uuid(n++), resolvePendingCaptureUri: (path) => `file:///mock/Documents/${path}` });
  return { store, factory };
}

function attachedNote(record: PendingCaptureRecord, uri = `file:///mock/Documents/${record.originalPath}`): Note {
  return {
    id: record.id, title: 'Recording', transcript: '', audioUri: uri,
    durationSeconds: record.inspection?.outcome === 'known' ? record.inspection.durationSeconds : 600, createdAt: record.capturedAt, capturedAt: record.capturedAt,
    captureTimeZone: record.captureTimeZone, status: 'recorded', revision: 1,
  };
}

describe('durable pending capture slot', () => {
  it('keeps revisions monotonic through inspection retries and discard, rejecting stale create revisions', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory() });
    await store.load();
    const initial = await store.pendingCapture!.read();
    expect(initial).toEqual({ kind: 'empty', revision: null });
    const prepared = await store.pendingCapture!.create(null, capture());
    expect(prepared.kind).toBe('valid');
    if (prepared.kind !== 'valid') throw new Error('expected capture');
    const needs = await store.pendingCapture!.update({ id: prepared.capture.id, revision: prepared.revision }, { ...prepared.capture, phase: 'needs_inspection' });
    if (needs.kind !== 'valid') throw new Error('expected capture');
    const inspected = await store.pendingCapture!.update({ id: needs.capture.id, revision: needs.revision }, { ...needs.capture, phase: 'inspected', inspection: { outcome: 'unknown' } });
    if (inspected.kind !== 'valid') throw new Error('expected capture');
    const retry = await store.pendingCapture!.update({ id: inspected.capture.id, revision: inspected.revision }, { ...inspected.capture, phase: 'needs_inspection', inspection: undefined });
    if (retry.kind !== 'valid') throw new Error('expected capture');
    const inspectedAgain = await store.pendingCapture!.update({ id: retry.capture.id, revision: retry.revision }, { ...retry.capture, phase: 'inspected', inspection: { outcome: 'known', durationSeconds: 6.125 } });
    if (inspectedAgain.kind !== 'valid') throw new Error('expected capture');
    const discarding = await store.pendingCapture!.update({ id: inspectedAgain.capture.id, revision: inspectedAgain.revision }, { ...inspectedAgain.capture, phase: 'discarding' });
    if (discarding.kind !== 'valid') throw new Error('expected capture');
    await expect(store.clear()).rejects.toThrow(/pending recording/i);
    await store.pendingCapture!.clearAfterDiscard({ id: discarding.capture.id, revision: discarding.revision });
    const tombstone = await store.pendingCapture!.read();
    expect(tombstone.kind).toBe('empty');
    if (tombstone.kind !== 'empty') throw new Error('expected empty slot');
    expect(tombstone.revision).not.toBeNull();
    await expect(store.pendingCapture!.create(null, capture())).rejects.toThrow(/slot changed/i);
    db.close();
  });

  it('snapshots mutable capture input before waiting in the storage queue', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory() });
    await store.load();
    const mutable = { ...capture() };
    const create = store.pendingCapture!.create(null, mutable);
    mutable.id = 'invalid-after-call';
    mutable.originalPath = 'outside/private-file.m4a';
    const result = await create;
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.capture.id).toBe(uuid(40));
      expect(result.capture.originalPath).toBe(`ExpoAudio/recording-${uuid(41)}.m4a`);
    }
    db.close();
  });

  it('serializes normal saves and slot writes without stale-generation false conflicts', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory() });
    await store.load();
    await Promise.all([
      store.save(state()),
      store.pendingCapture!.create(null, capture()),
    ]);
    expect(await store.load()).toEqual(state());
    expect((await store.pendingCapture!.read()).kind).toBe('valid');
    db.close();

    const { store: browser } = await webStore();
    await browser.load();
    await Promise.all([browser.save(state()), browser.pendingCapture!.create(null, capture())]);
    expect(await browser.load()).toEqual(state());
    expect((await browser.pendingCapture!.read()).kind).toBe('valid');
  });

  it('fences pending operations from a stale loaded snapshot generation', async () => {
    const db = sqliteMemory();
    const stale = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory(1) });
    const current = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory(100) });
    await stale.load(); await current.load();
    await current.save(state());
    await expect(stale.pendingCapture!.create(null, capture())).rejects.toThrow(/changed in another workspace/i);
    expect((await current.pendingCapture!.read()).kind).toBe('empty');
    db.close();

    const factory = new IDBFactory();
    const staleBrowser = new IndexedDbStateStore({ factory, randomId: idFactory(200) });
    const currentBrowser = new IndexedDbStateStore({ factory, randomId: idFactory(300) });
    await staleBrowser.load(); await currentBrowser.load();
    await currentBrowser.save(state());
    await expect(staleBrowser.pendingCapture!.create(null, capture())).rejects.toThrow(/changed in another workspace/i);
    expect((await currentBrowser.pendingCapture!.read()).kind).toBe('empty');
  });

  it('atomically consumes an inspected known capture only when the exact deterministic note matches', async () => {
    const failure: { key?: string } = {};
    const db = sqliteMemory(failure);
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory(), resolvePendingCaptureUri: (path) => `file:///mock/Documents/${path}` });
    await store.load();
    const prepared = await store.pendingCapture!.create(null, capture());
    if (prepared.kind !== 'valid') throw new Error('expected capture');
    const needs = await store.pendingCapture!.update({ id: prepared.capture.id, revision: prepared.revision }, { ...prepared.capture, phase: 'needs_inspection' });
    if (needs.kind !== 'valid') throw new Error('expected capture');
    const inspectedWithReplacement = await store.pendingCapture!.update({ id: needs.capture.id, revision: needs.revision }, { ...needs.capture, phase: 'inspected', replacementPaths: [`ExpoAudio/recording-${uuid(42)}.m4a`], inspection: { outcome: 'known', durationSeconds: 600 } });
    if (inspectedWithReplacement.kind !== 'valid') throw new Error('expected capture');
    const inspected = await store.pendingCapture!.update({ id: inspectedWithReplacement.capture.id, revision: inspectedWithReplacement.revision }, { ...inspectedWithReplacement.capture, replacementPaths: [] });
    if (inspected.kind !== 'valid') throw new Error('expected capture');
    const invalidNote = attachedNote(inspected.capture, 'file:///external/ExpoAudio/recording-other.m4a');
    await expect(store.save(state([invalidNote]), { consumePendingCapture: { id: inspected.capture.id, revision: inspected.revision, noteId: inspected.capture.id } })).rejects.toThrow(/does not match/i);
    expect(await store.pendingCapture!.read()).toMatchObject({ kind: 'valid', revision: inspected.revision });
    failure.key = PENDING_CAPTURE_STORAGE_KEY;
    await expect(store.save(state([attachedNote(inspected.capture)]), { consumePendingCapture: { id: inspected.capture.id, revision: inspected.revision, noteId: inspected.capture.id } })).rejects.toThrow(/injected pending write failure/i);
    expect(await store.load()).toBeUndefined();
    expect(await store.pendingCapture!.read()).toMatchObject({ kind: 'valid', revision: inspected.revision });
    await store.save(state([attachedNote(inspected.capture)]), { consumePendingCapture: { id: inspected.capture.id, revision: inspected.revision, noteId: inspected.capture.id } });
    expect(await store.load()).toEqual(state([attachedNote(inspected.capture)]));
    expect(await store.pendingCapture!.read()).toMatchObject({ kind: 'empty', consumedCaptureId: inspected.capture.id });
    db.close();

    const { store: browser } = await webStore();
    await browser.load();
    const browserPrepared = await browser.pendingCapture!.create(null, capture());
    if (browserPrepared.kind !== 'valid') throw new Error('expected capture');
    const browserNeeds = await browser.pendingCapture!.update({ id: browserPrepared.capture.id, revision: browserPrepared.revision }, { ...browserPrepared.capture, phase: 'needs_inspection' });
    if (browserNeeds.kind !== 'valid') throw new Error('expected capture');
    const browserInspected = await browser.pendingCapture!.update({ id: browserNeeds.capture.id, revision: browserNeeds.revision }, { ...browserNeeds.capture, phase: 'inspected', inspection: { outcome: 'known', durationSeconds: 0.125 } });
    if (browserInspected.kind !== 'valid') throw new Error('expected capture');
    await browser.save(state([attachedNote(browserInspected.capture)]), { consumePendingCapture: { id: browserInspected.capture.id, revision: browserInspected.revision, noteId: browserInspected.capture.id } });
    expect(await browser.pendingCapture!.read()).toMatchObject({ kind: 'empty', consumedCaptureId: browserInspected.capture.id });
  });

  it('preserves malformed and future-version slot bytes and refuses destructive clear while blocked', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory() });
    await store.load();
    const raw = '{"version":1,"revision":"broken","capture":{}}';
    db.raw.prepare('INSERT INTO app_state(key,value,schema_version,updated_at) VALUES(?,?,1,?)').run(PENDING_CAPTURE_STORAGE_KEY, raw, new Date().toISOString());
    expect(await store.pendingCapture!.read()).toEqual({ kind: 'blocked', reason: 'unreadable' });
    await expect(store.clear()).rejects.toThrow(/pending recording/i);
    expect(db.raw.prepare('SELECT value FROM app_state WHERE key=?').get(PENDING_CAPTURE_STORAGE_KEY)).toEqual({ value: raw });
    db.close();

    const factory = new IDBFactory();
    const { store: browser } = await webStore(factory);
    await browser.load();
    const dbRequest = factory.open('voice-assistant', 1);
    const browserDb = await new Promise<IDBDatabase>((resolve, reject) => { dbRequest.onsuccess = () => resolve(dbRequest.result); dbRequest.onerror = () => reject(dbRequest.error); });
    const tx = browserDb.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put(JSON.stringify({ version: 2, revision: uuid(50) }), PENDING_CAPTURE_STORAGE_KEY);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    browserDb.close();
    expect(await browser.pendingCapture!.read()).toEqual({ kind: 'blocked', reason: 'unsupported' });
    await expect(browser.clear()).rejects.toThrow(/pending recording/i);
  });

  it('rejects replacement paths outside the exact recording namespace and enforces the 600-second attach limit', async () => {
    const base = capture('inspected');
    expect(base.id).not.toBe(base.originalPath.match(/[0-9a-f-]{36}/i)?.[0]);
    expect(() => validatePendingCaptureRecord({ ...base, replacementPaths: ['provider_credentials/token.json'] })).toThrow(/pending recording/i);
    expect(() => validatePendingCaptureRecord({ ...base, replacementPaths: [base.originalPath.replace('ExpoAudio/', 'expoaudio/')] })).toThrow(/pending recording/i);
    expect(() => validatePendingCaptureRecord({ ...base, replacementPaths: ['ExpoAudio/recording-00000000-0000-4000-8000-000000000042.m4a'] })).not.toThrow();
    const overLimit = validatePendingCaptureRecord({ ...base, inspection: { outcome: 'known', durationSeconds: 600.0001 } });
    expect(() => assertPendingCaptureConsumption(state([attachedNote(overLimit)]), undefined, { kind: 'valid', revision: uuid(60), capture: overLimit }, { id: overLimit.id, revision: uuid(60), noteId: overLimit.id }, `file:///mock/Documents/${overLimit.originalPath}`)).toThrow(/not eligible/i);
    const duplicate = validatePendingCaptureRecord({ ...base, inspection: { outcome: 'known', durationSeconds: 6.5 } });
    expect(() => assertPendingCaptureConsumption(state([attachedNote(duplicate)]), JSON.stringify(state([attachedNote(duplicate)])), { kind: 'valid', revision: uuid(61), capture: duplicate }, { id: duplicate.id, revision: uuid(61), noteId: duplicate.id }, `file:///mock/Documents/${duplicate.originalPath}`)).toThrow(/already exists/i);
  });

  it('keeps a pending slot through startup recovery replacement and bounds its private envelope', async () => {
    const db = sqliteMemory();
    const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: idFactory(), sha256: async () => 'a'.repeat(64) });
    await store.save(state());
    const slot = await store.pendingCapture!.create(null, capture());
    expect(slot.kind).toBe('valid');
    const plan = await store.recovery!.prepare();
    await store.recovery!.commit(plan, state());
    await store.load();
    expect((await store.pendingCapture!.read()).kind).toBe('valid');
    expect(db.raw.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM app_state WHERE key=?').get(PENDING_CAPTURE_STORAGE_KEY)).toBeTruthy();
    expect(resolvePendingCaptureUri('file:///mock/Documents/', capture().originalPath)).toBe(`file:///mock/Documents/${capture().originalPath}`);
    expect(PENDING_CAPTURE_MAX_BYTES).toBe(16 * 1024);
    db.close();
  });
});
