import type { AppState } from '../core';
import { STORAGE_KEY, type StateStore } from './contracts';

const DB_NAME = 'voice-assistant';
const STORE_NAME = 'snapshots';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local browser storage.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
  });
}

/** IndexedDB is same-origin local storage; browser credentials are memory-only. */
export class IndexedDbStateStore implements StateStore {
  async load(): Promise<AppState | undefined> {
    const db = await openDb();
    try {
      const result = await requestResult<string | undefined>(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(STORAGE_KEY));
      if (!result) return undefined;
      try { return JSON.parse(result) as AppState; }
      catch { throw new Error('Saved app data could not be read. Browser storage was preserved for recovery.'); }
    } finally { db.close(); }
  }

  async save(state: AppState): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(JSON.stringify(state), STORAGE_KEY);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Could not save app data.'));
        tx.onabort = () => reject(tx.error ?? new Error('Saving app data was cancelled.'));
      });
    } finally { db.close(); }
  }

  async clear(): Promise<void> {
    const db = await openDb();
    try { await requestResult(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(STORAGE_KEY)); }
    finally { db.close(); }
  }
}

export const stateStore: StateStore = new IndexedDbStateStore();
