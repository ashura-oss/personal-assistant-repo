import { createEmptyPrivacyControlState, validatePrivacyControlState } from './schema';
import type { PrivacyControlState, PrivacyControlStore } from './types';

class PrivacyControlStoreError extends Error {
  readonly code: 'unavailable' | 'conflict';
  constructor(code: 'unavailable' | 'conflict') {
    super(code === 'conflict' ? 'Privacy control state changed. Reload and retry.' : 'Privacy control state is unavailable. It was preserved.');
    this.name = 'PrivacyControlStoreError';
    this.code = code;
  }
}

const DATABASE_NAME = 'still-privacy-control-v1';
const STORE_NAME = 'control';
const STATE_KEY = 'control-state-v1';
const MAX_CONTROL_STATE_BYTES = 16 * 1024 * 1024;

function boundedUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1; }
    else bytes += 3;
    if (bytes > MAX_CONTROL_STATE_BYTES) return MAX_CONTROL_STATE_BYTES + 1;
  }
  return bytes;
}

function defaultFactory(): IDBFactory {
  if (typeof indexedDB === 'undefined') throw new PrivacyControlStoreError('unavailable');
  return indexedDB;
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = factory.open(DATABASE_NAME, 1); }
    catch { reject(new PrivacyControlStoreError('unavailable')); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new PrivacyControlStoreError('unavailable'));
    request.onblocked = () => reject(new PrivacyControlStoreError('unavailable'));
  });
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let requestFailure = false;
    tx.oncomplete = () => {
      if (requestFailure) reject(new PrivacyControlStoreError('unavailable'));
      else resolve();
    };
    tx.onerror = () => { requestFailure = true; };
    tx.onabort = () => reject(new PrivacyControlStoreError('unavailable'));
  });
}

function strictReadwriteTransaction(db: IDBDatabase): IDBTransaction {
  let tx: IDBTransaction;
  try {
    tx = db.transaction(STORE_NAME, 'readwrite', { durability: 'strict' });
  } catch {
    throw new PrivacyControlStoreError('unavailable');
  }
  if (tx.durability !== 'strict') {
    try { tx.abort(); } catch { /* transaction may already be inactive */ }
    throw new PrivacyControlStoreError('unavailable');
  }
  return tx;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new PrivacyControlStoreError('unavailable'));
  });
}

export type IndexedDbPrivacyControlStoreOptions = { factory?: IDBFactory; randomId?: () => string };

/** IndexedDB control state is stored in a separate database from app snapshots. */
export class IndexedDbPrivacyControlStore implements PrivacyControlStore {
  private readonly factory?: IDBFactory;
  private readonly randomId: () => string;

  constructor(options: IndexedDbPrivacyControlStoreOptions = {}) {
    this.factory = options.factory;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
  }

  private getFactory(): IDBFactory { return this.factory ?? defaultFactory(); }

  private emptyState(): PrivacyControlState {
    try { return validatePrivacyControlState({ ...createEmptyPrivacyControlState(this.randomId()), revision: this.randomId() }); }
    catch { throw new PrivacyControlStoreError('unavailable'); }
  }

  async read(): Promise<PrivacyControlState> {
    let db: IDBDatabase | undefined;
    let tx: IDBTransaction | undefined;
    let done: Promise<void> | undefined;
    try {
      db = await openDb(this.getFactory());
      tx = strictReadwriteTransaction(db);
      done = complete(tx);
      const store = tx.objectStore(STORE_NAME);
      const value = await result(store.get(STATE_KEY));
      let state: PrivacyControlState;
      if (value === undefined) {
        state = this.emptyState();
        store.add(state, STATE_KEY);
      } else state = validatePrivacyControlState(value);
      await done;
      return state;
    } catch (error) {
      try { tx?.abort(); } catch { /* transaction may have completed */ }
      await done?.catch(() => undefined);
      if (error instanceof PrivacyControlStoreError) throw error;
      throw new PrivacyControlStoreError('unavailable');
    } finally { db?.close(); }
  }

  async compareAndSwap(expectedRevision: string, nextState: PrivacyControlState): Promise<void> {
    let next: PrivacyControlState;
    try { next = validatePrivacyControlState(nextState); }
    catch { throw new PrivacyControlStoreError('unavailable'); }
    if (next.revision === expectedRevision) throw new PrivacyControlStoreError('conflict');
    let serialized: string;
    try { serialized = JSON.stringify(next); }
    catch { throw new PrivacyControlStoreError('unavailable'); }
    if (boundedUtf8Bytes(serialized) > MAX_CONTROL_STATE_BYTES) throw new PrivacyControlStoreError('unavailable');
    let db: IDBDatabase | undefined;
    let tx: IDBTransaction | undefined;
    let done: Promise<void> | undefined;
    let conflict = false;
    try {
      db = await openDb(this.getFactory());
      tx = strictReadwriteTransaction(db);
      done = complete(tx);
      const store = tx.objectStore(STORE_NAME);
      const value = await result(store.get(STATE_KEY));
      if (value === undefined) {
        const initial = this.emptyState();
        store.add(initial, STATE_KEY);
        conflict = true;
      } else {
        const current = validatePrivacyControlState(value);
        if (current.revision !== expectedRevision) conflict = true;
        else store.put(next, STATE_KEY);
      }
      await done;
      if (conflict) throw new PrivacyControlStoreError('conflict');
    } catch (error) {
      try { tx?.abort(); } catch { /* transaction may have completed */ }
      await done?.catch(() => undefined);
      if (error instanceof PrivacyControlStoreError) throw error;
      throw new PrivacyControlStoreError('unavailable');
    } finally { db?.close(); }
  }
}
