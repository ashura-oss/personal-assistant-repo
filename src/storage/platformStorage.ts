import * as SQLite from 'expo-sqlite';
import type { AppState } from '../core';
import { STORAGE_KEY, type StateStore } from './contracts';

const DB_NAME = 'voice-assistant.db';
const SCHEMA_VERSION = 1;

/** SQLite stores the full versioned snapshot in the app's private database. */
export class SQLiteStateStore implements StateStore {
  private dbPromise = SQLite.openDatabaseAsync(DB_NAME);

  private async initialize(): Promise<SQLite.SQLiteDatabase> {
    const db = await this.dbPromise;
    await db.execAsync(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    return db;
  }

  async load(): Promise<AppState | undefined> {
    const db = await this.initialize();
    const row = await db.getFirstAsync<{ value: string; schema_version: number }>(
      'SELECT value, schema_version FROM app_state WHERE key = ?', STORAGE_KEY,
    );
    if (!row) return undefined;
    if (row.schema_version > SCHEMA_VERSION) {
      throw new Error('This data was saved by a newer version of the app. Update the app before opening it.');
    }
    try {
      return JSON.parse(row.value) as AppState;
    } catch {
      throw new Error('Saved app data could not be read. Your local database was preserved for recovery.');
    }
  }

  async save(state: AppState): Promise<void> {
    const db = await this.initialize();
    await db.runAsync(
      'INSERT INTO app_state(key,value,schema_version,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,schema_version=excluded.schema_version,updated_at=excluded.updated_at',
      STORAGE_KEY, JSON.stringify(state), SCHEMA_VERSION, new Date().toISOString(),
    );
  }

  async clear(): Promise<void> {
    const db = await this.initialize();
    await db.runAsync('DELETE FROM app_state WHERE key = ?', STORAGE_KEY);
  }
}

export const stateStore: StateStore = new SQLiteStateStore();
