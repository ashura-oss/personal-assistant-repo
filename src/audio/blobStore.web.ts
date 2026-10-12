const DB = 'still-audio-v1';
const STORE = 'recordings';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open browser audio storage.'));
  });
}

async function request<T>(key: string, mode: IDBTransactionMode, value?: Blob): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req = value ? store.put(value, key) : mode === 'readwrite' ? store.delete(key) : store.get(key);
    const result = await new Promise<T>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('Browser audio storage failed.'));
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Browser audio transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Browser audio transaction was interrupted.'));
    });
    return result;
  } finally { db.close(); }
}

export async function putAudio(id: string, blob: Blob): Promise<string> {
  await request<IDBValidKey>(id, 'readwrite', blob);
  return `indexeddb-audio:${id}`;
}
export async function getAudio(uri: string): Promise<Blob> {
  const id = uri.replace(/^indexeddb-audio:/, '');
  const blob = await request<Blob | undefined>(id, 'readonly');
  if (!blob) throw new Error('This recording is missing from browser storage. The note was kept; record it again or remove the missing audio attachment.');
  return blob;
}
export async function removeAudio(uri: string): Promise<void> {
  await request<undefined>(uri.replace(/^indexeddb-audio:/, ''), 'readwrite');
}
