import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  calls: [] as string[],
  files: new Set<string>(['file:///private/app/SQLite/voice-assistant.db-wal', 'file:///private/app/SQLite/voice-assistant.db-shm']),
  deleteDatabaseAsync: vi.fn(async (_name: string) => { native.calls.push('sqlite-delete'); native.files.delete('file:///private/app/SQLite/voice-assistant.db'); }),
  openDatabaseAsync: vi.fn(async (_name: string) => { native.files.add('file:///private/app/SQLite/voice-assistant.db'); return native.database(); }),
  database: () => ({
    async execAsync() { native.calls.push('schema'); },
    async runAsync() { return { changes: 1, lastInsertRowId: 1 }; },
    async getFirstAsync() { return null; },
    async getAllAsync() { return []; },
    async withExclusiveTransactionAsync(work: (tx: unknown) => Promise<void>) {
      native.calls.push('transaction-start');
      await work(this);
      native.calls.push('transaction-end');
    },
    async closeAsync() { native.calls.push('close'); },
  }),
}));

vi.mock('expo-sqlite', () => ({
  defaultDatabaseDirectory: 'file:///private/app/SQLite',
  deleteDatabaseAsync: native.deleteDatabaseAsync,
  openDatabaseAsync: native.openDatabaseAsync,
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => '20000000-0000-4000-8000-000000000001',
  digestStringAsync: async () => 'a'.repeat(64),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

vi.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async (uri: string) => { native.calls.push(`exists:${uri}`); return { exists: native.files.has(uri) }; },
  deleteAsync: async (uri: string) => { native.calls.push(`file-delete:${uri}`); native.files.delete(uri); },
}));

describe('privileged native app-state database deletion', () => {
  beforeEach(async () => {
    await vi.resetModules();
    native.calls.length = 0;
    native.files = new Set(['file:///private/app/SQLite/voice-assistant.db-wal', 'file:///private/app/SQLite/voice-assistant.db-shm']);
    native.deleteDatabaseAsync.mockReset().mockImplementation(async () => { native.calls.push('sqlite-delete'); native.files.delete('file:///private/app/SQLite/voice-assistant.db'); });
    native.openDatabaseAsync.mockReset().mockImplementation(async () => { native.files.add('file:///private/app/SQLite/voice-assistant.db'); return native.database(); });
  });

  it('drains and closes live handles, deletes the database, then its exact sidecars', async () => {
    const storage = await import('../src/storage/platformStorage');
    const store = storage.createPlatformStateStore();
    await store.load();
    await storage.eraseStateDatabaseForPrivacy(async () => { native.calls.push('journal-check'); });

    const sqliteDelete = native.calls.indexOf('sqlite-delete');
    const walDelete = native.calls.indexOf('file-delete:file:///private/app/SQLite/voice-assistant.db-wal');
    const shmDelete = native.calls.indexOf('file-delete:file:///private/app/SQLite/voice-assistant.db-shm');
    expect(native.calls.indexOf('close')).toBeGreaterThanOrEqual(0);
    expect(sqliteDelete).toBeGreaterThan(native.calls.indexOf('close'));
    expect(walDelete).toBeGreaterThan(sqliteDelete);
    expect(shmDelete).toBeGreaterThan(walDelete);
    expect(await storage.privacyStateDatabaseGone()).toBe(true);
    expect(native.deleteDatabaseAsync).toHaveBeenCalledWith('voice-assistant.db');
    await expect(store.load()).rejects.toThrow('closed for privacy cleanup');
    await storage.createPlatformStateStore().load();
    expect(native.openDatabaseAsync).toHaveBeenCalledTimes(2);
    expect(await storage.privacyStateDatabaseGone()).toBe(false);
  });

  it('never unlinks WAL/SHM when SQLite reports database deletion failure', async () => {
    const storage = await import('../src/storage/platformStorage');
    await storage.createPlatformStateStore().load();
    native.deleteDatabaseAsync.mockRejectedValueOnce(new Error('SDK failure'));
    await expect(storage.eraseStateDatabaseForPrivacy(async () => undefined)).rejects.toThrow('SDK failure');
    expect(native.calls.some((call) => call.startsWith('file-delete:'))).toBe(false);
    expect(await storage.privacyStateDatabaseGone()).toBe(false);
  });

  it('waits for a live transaction to settle before closing or deleting', async () => {
    let finish!: () => void;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const database = native.database();
    const original = database.withExclusiveTransactionAsync;
    database.withExclusiveTransactionAsync = async (work) => {
      if (native.calls.includes('defer-one-transaction')) {
        native.calls.push('actual-transaction-start');
        await new Promise<void>((resolve) => { finish = resolve; startedResolve(); });
        native.calls.push('actual-transaction-end');
        return;
      }
      await original.call(database, work);
    };
    native.openDatabaseAsync.mockResolvedValueOnce(database as never);
    const storage = await import('../src/storage/platformStorage');
    const store = storage.createPlatformStateStore();
    await store.load();
    native.calls.push('defer-one-transaction');
    const read = store.assertCurrent!();
    await started;
    const deleting = storage.eraseStateDatabaseForPrivacy(async () => undefined);
    await Promise.resolve();
    expect(native.calls).not.toContain('close');
    expect(native.calls).not.toContain('sqlite-delete');
    finish();
    await Promise.all([read, deleting]);
    expect(native.calls.indexOf('actual-transaction-end')).toBeLessThan(native.calls.indexOf('close'));
  });
});
