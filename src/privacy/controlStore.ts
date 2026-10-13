import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { createEmptyPrivacyControlState, validatePrivacyControlState } from './schema';
import type { PrivacyControlState, PrivacyControlStore } from './types';
export type { PrivacyControlStore } from './types';

const DATABASE_NAME = 'still-privacy-control.db';
const STATE_KEY = 'control-state-v1';
const MAX_CONTROL_STATE_BYTES = 16 * 1024 * 1024;
let controlDatabaseTail: Promise<void> = Promise.resolve();

/** Serializes exclusive-transaction clones across every store instance for this literal control DB. */
async function withControlDatabaseLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = controlDatabaseTail;
  let release!: () => void;
  controlDatabaseTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); }
  finally { release(); }
}

export type PrivacyControlErrorCode = 'unavailable' | 'conflict';

export class PrivacyControlStoreError extends Error {
  readonly code: PrivacyControlErrorCode;
  constructor(code: PrivacyControlErrorCode) {
    super(code === 'conflict' ? 'Privacy control state changed. Reload and retry.' : 'Privacy control state is unavailable. It was preserved.');
    this.name = 'PrivacyControlStoreError';
    this.code = code;
  }
}

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

export interface PrivacySQLiteExecutor {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SQLite.SQLiteBindValue[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...params: SQLite.SQLiteBindValue[]): Promise<T | null>;
}

export interface PrivacySQLiteDatabase extends PrivacySQLiteExecutor {
  withExclusiveTransactionAsync(work: (tx: PrivacySQLiteExecutor) => Promise<void>): Promise<void>;
}

async function assertDurableSQLiteTransaction(tx: PrivacySQLiteExecutor): Promise<void> {
  const synchronous = await tx.getFirstAsync<{ synchronous?: unknown }>('PRAGMA main.synchronous');
  const journal = await tx.getFirstAsync<{ journal_mode?: unknown }>('PRAGMA main.journal_mode');
  if (!synchronous || typeof synchronous.synchronous !== 'number' || synchronous.synchronous < 2 ||
      !journal || typeof journal.journal_mode !== 'string' || journal.journal_mode.toLowerCase() !== 'wal') {
    throw new PrivacyControlStoreError('unavailable');
  }
}

export type SQLitePrivacyControlStoreOptions = {
  database?: Promise<PrivacySQLiteDatabase>;
  openDatabase?: () => Promise<PrivacySQLiteDatabase>;
  randomId?: () => string;
};

/** Private control metadata lives in a database that survives deletion of app data. */
export class SQLitePrivacyControlStore implements PrivacyControlStore {
  private readonly openDatabase: () => Promise<PrivacySQLiteDatabase>;
  private readonly fixedDatabase?: Promise<PrivacySQLiteDatabase>;
  private readonly randomId: () => string;
  private initialized?: Promise<PrivacySQLiteDatabase>;

  constructor(options: SQLitePrivacyControlStoreOptions = {}) {
    this.fixedDatabase = options.database;
    this.openDatabase = options.openDatabase ?? (() => SQLite.openDatabaseAsync(DATABASE_NAME) as Promise<PrivacySQLiteDatabase>);
    this.randomId = options.randomId ?? Crypto.randomUUID;
  }

  private emptyState(): PrivacyControlState {
    try { return validatePrivacyControlState({ ...createEmptyPrivacyControlState(this.randomId()), revision: this.randomId() }); }
    catch { throw new PrivacyControlStoreError('unavailable'); }
  }

  private async database(): Promise<PrivacySQLiteDatabase> {
    if (!this.initialized) {
      const opening = this.fixedDatabase ? Promise.resolve(this.fixedDatabase) : Promise.resolve().then(() => this.openDatabase());
      this.initialized = opening.then(async (db) => {
        await db.execAsync(`PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS privacy_control (key TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, revision TEXT NOT NULL, value TEXT NOT NULL);`);
        return db;
      }).catch(() => {
        this.initialized = undefined;
        throw new PrivacyControlStoreError('unavailable');
      });
    }
    return this.initialized;
  }

  async read(): Promise<PrivacyControlState> {
    return withControlDatabaseLock(() => this.readLocked());
  }

  private async readLocked(): Promise<PrivacyControlState> {
    const db = await this.database();
    let result: PrivacyControlState | undefined;
    try {
      await db.withExclusiveTransactionAsync(async (tx) => {
        await assertDurableSQLiteTransaction(tx);
        const metadata = await tx.getFirstAsync<{ schema_version: number; revision: string; value_bytes: number }>('SELECT schema_version,revision,length(CAST(value AS BLOB)) AS value_bytes FROM privacy_control WHERE key=?', STATE_KEY);
        if (!metadata) {
          const initial = this.emptyState();
          const raw = JSON.stringify(initial);
          if (boundedUtf8Bytes(raw) > MAX_CONTROL_STATE_BYTES) throw new Error('oversize');
          await tx.runAsync('INSERT INTO privacy_control(key,schema_version,revision,value) VALUES(?,?,?,?)', STATE_KEY, initial.schemaVersion, initial.revision, raw);
          result = initial;
          return;
        }
        if (!Number.isSafeInteger(metadata.value_bytes) || metadata.value_bytes < 0 || metadata.value_bytes > MAX_CONTROL_STATE_BYTES) throw new Error('oversize');
        const row = await tx.getFirstAsync<{ value: string }>('SELECT value FROM privacy_control WHERE key=? AND length(CAST(value AS BLOB))<=?', STATE_KEY, MAX_CONTROL_STATE_BYTES);
        if (!row) throw new Error('missing control row');
        const parsed: unknown = JSON.parse(row.value);
        const state = validatePrivacyControlState(parsed);
        if (metadata.schema_version !== state.schemaVersion || metadata.revision !== state.revision || boundedUtf8Bytes(row.value) !== metadata.value_bytes) throw new Error('invalid row binding');
        result = state;
      });
      if (!result) throw new PrivacyControlStoreError('unavailable');
      return result;
    } catch (error) {
      if (error instanceof PrivacyControlStoreError) throw error;
      throw new PrivacyControlStoreError('unavailable');
    }
  }

  async compareAndSwap(expectedRevision: string, nextState: PrivacyControlState): Promise<void> {
    let next: PrivacyControlState;
    try { next = validatePrivacyControlState(nextState); }
    catch { throw new PrivacyControlStoreError('unavailable'); }
    if (next.revision === expectedRevision) throw new PrivacyControlStoreError('conflict');
    const raw = JSON.stringify(next);
    if (boundedUtf8Bytes(raw) > MAX_CONTROL_STATE_BYTES) throw new PrivacyControlStoreError('unavailable');
    return withControlDatabaseLock(() => this.compareAndSwapLocked(expectedRevision, next, raw));
  }

  private async compareAndSwapLocked(expectedRevision: string, next: PrivacyControlState, raw: string): Promise<void> {
    const db = await this.database();
    try {
      let conflict = false;
      await db.withExclusiveTransactionAsync(async (tx) => {
        await assertDurableSQLiteTransaction(tx);
        const metadata = await tx.getFirstAsync<{ schema_version: number; revision: string; value_bytes: number }>('SELECT schema_version,revision,length(CAST(value AS BLOB)) AS value_bytes FROM privacy_control WHERE key=?', STATE_KEY);
        if (!metadata) {
          const initial = this.emptyState();
          const initialRaw = JSON.stringify(initial);
          if (boundedUtf8Bytes(initialRaw) > MAX_CONTROL_STATE_BYTES) throw new Error('oversize');
          await tx.runAsync('INSERT INTO privacy_control(key,schema_version,revision,value) VALUES(?,?,?,?)', STATE_KEY, initial.schemaVersion, initial.revision, initialRaw);
          conflict = true;
          return;
        }
        if (!Number.isSafeInteger(metadata.value_bytes) || metadata.value_bytes < 0 || metadata.value_bytes > MAX_CONTROL_STATE_BYTES) throw new Error('oversize');
        const currentRow = await tx.getFirstAsync<{ value: string }>('SELECT value FROM privacy_control WHERE key=? AND length(CAST(value AS BLOB))<=?', STATE_KEY, MAX_CONTROL_STATE_BYTES);
        if (!currentRow || boundedUtf8Bytes(currentRow.value) !== metadata.value_bytes) throw new Error('invalid control row');
        const current = validatePrivacyControlState(JSON.parse(currentRow.value));
        if (metadata.schema_version !== current.schemaVersion || metadata.revision !== current.revision) throw new Error('invalid row binding');
        if (current.revision !== expectedRevision) { conflict = true; return; }
        const updated = await tx.runAsync('UPDATE privacy_control SET schema_version=?,revision=?,value=? WHERE key=? AND revision=?', next.schemaVersion, next.revision, raw, STATE_KEY, expectedRevision);
        if (updated.changes !== 1) conflict = true;
      });
      if (conflict) throw new PrivacyControlStoreError('conflict');
    } catch (error) {
      if (error instanceof PrivacyControlStoreError) throw error;
      throw new PrivacyControlStoreError('unavailable');
    }
  }
}
