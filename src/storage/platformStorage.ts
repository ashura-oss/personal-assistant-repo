import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import type { AppState } from '../core';
import { STATE_SNAPSHOT_READ_MAX_BYTES, STORAGE_KEY, type StateStore } from './contracts';
import {
  PENDING_CAPTURE_MAX_BYTES, PENDING_CAPTURE_STORAGE_KEY, assertPendingCaptureConsumption,
  assertPendingCaptureTransition, emptyPendingCaptureSlot, readPendingCaptureSlot,
  resolvePendingCaptureUri, serializePendingCaptureSlot, validatePendingCaptureRecord,
  validatePendingCaptureUuid, type ConsumePendingCapture, type PendingCaptureBackend, type PendingCaptureRead,
} from './pendingCapture';
import {
  createStartupRecoveryBackend, recoveryUtf8Bytes, validateRecoveryId, validateRecoveryReceipt,
  validateRecoveryIso, validateRecoveryReceiptRecord, type StartupRecoveryArchiveRecord, type StartupRecoveryPersistence,
  type StartupRecoveryReceiptRecord, type StartupRecoverySnapshot, type StartupRecoveryTransaction,
} from './startupRecovery';

const DB_NAME = 'voice-assistant.db';
const SCHEMA_VERSION = 1;
const GENERATION_KEY = 'snapshot_generation';
const liveStateHandles = new Set<LiveStateDatabaseHandle>();
let privacyStateDatabaseDeleting = false;
let stateDatabaseLifecycleGeneration = 0;
let openingStateDatabases = 0;
const stateOpenWaiters: (() => void)[] = [];

type ClosableSqlite = SQLiteTransactionDatabase & { closeAsync?: () => Promise<void> };
type LiveStateDatabaseHandle = {
  database: ClosableSqlite;
  activeTransactions: number;
  closing: boolean;
  closed: boolean;
  idleWaiters: (() => void)[];
};

function trackStateDatabase(database: SQLiteTransactionDatabase, track: boolean): SQLiteTransactionDatabase {
  if (!track) return database;
  const handle: LiveStateDatabaseHandle = {
    database: database as ClosableSqlite, activeTransactions: 0, closing: false, closed: false, idleWaiters: [],
  };
  liveStateHandles.add(handle);
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'withExclusiveTransactionAsync') {
        return async (work: (tx: SQLiteExecutor) => Promise<void>) => {
          if (privacyStateDatabaseDeleting || handle.closing || handle.closed) throw new Error('Local storage is being securely cleared.');
          handle.activeTransactions += 1;
          try { await target.withExclusiveTransactionAsync(work); }
          finally {
            handle.activeTransactions -= 1;
            if (handle.activeTransactions === 0) handle.idleWaiters.splice(0).forEach((resolve) => resolve());
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function waitForStateHandleIdle(handle: LiveStateDatabaseHandle): Promise<void> {
  if (handle.activeTransactions === 0) return;
  await new Promise<void>((resolve) => handle.idleWaiters.push(resolve));
}

export interface SQLiteExecutor {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SQLite.SQLiteBindValue[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getFirstAsync<T>(sql: string, ...params: SQLite.SQLiteBindValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: SQLite.SQLiteBindValue[]): Promise<T[]>;
}

export interface SQLiteTransactionDatabase extends SQLiteExecutor {
  withExclusiveTransactionAsync(work: (tx: SQLiteExecutor) => Promise<void>): Promise<void>;
}

export type SQLiteStateStoreOptions = {
  database?: Promise<SQLiteTransactionDatabase>;
  openDatabase?: () => Promise<SQLiteTransactionDatabase>;
  randomId?: () => string;
  sha256?: (raw: string) => Promise<string>;
  now?: () => number;
  resolvePendingCaptureUri?: (path: string) => string;
};

async function readPendingCapture(tx: SQLiteExecutor): Promise<{ read: PendingCaptureRead; raw?: string }> {
  const meta = await tx.getFirstAsync<{ schema_version: number; bytes: number }>('SELECT schema_version,length(CAST(value AS BLOB)) AS bytes FROM app_state WHERE key=?', PENDING_CAPTURE_STORAGE_KEY);
  if (!meta) return { read: Object.freeze({ kind: 'empty', revision: null }) };
  if (!Number.isSafeInteger(meta.schema_version) || meta.schema_version < 1) return { read: Object.freeze({ kind: 'blocked', reason: 'unreadable' }) };
  if (meta.schema_version > 1) return { read: Object.freeze({ kind: 'blocked', reason: 'unsupported' }) };
  if (!Number.isSafeInteger(meta.bytes) || meta.bytes < 0 || meta.bytes > PENDING_CAPTURE_MAX_BYTES) return { read: Object.freeze({ kind: 'blocked', reason: 'unreadable' }) };
  const row = await tx.getFirstAsync<{ value: string }>('SELECT value FROM app_state WHERE key=? AND length(CAST(value AS BLOB))<=?', PENDING_CAPTURE_STORAGE_KEY, PENDING_CAPTURE_MAX_BYTES);
  if (!row || typeof row.value !== 'string') return { read: Object.freeze({ kind: 'blocked', reason: 'unreadable' }) };
  return { read: readPendingCaptureSlot(row.value, meta.bytes), raw: row.value };
}

async function writePendingCapture(tx: SQLiteExecutor, raw: string): Promise<void> {
  await tx.runAsync('INSERT INTO app_state(key,value,schema_version,updated_at) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,schema_version=excluded.schema_version,updated_at=excluded.updated_at', PENDING_CAPTURE_STORAGE_KEY, raw, new Date().toISOString());
}

function defaultSha256(raw: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw);
}

function validateGeneration(value: unknown): string {
  if (value === 'legacy') return value;
  return validateRecoveryId(value, 'Storage generation');
}

function receiptFromRow(row: Record<string, unknown>): StartupRecoveryReceiptRecord {
  const allowed = ['session_id', 'plan_hash', 'source_generation', 'source_sha256', 'replacement_generation', 'replacement_sha256', 'operation_id', 'archive_id', 'archived_at', 'evidence_bytes', 'opened', 'archive_session_id', 'archive_generation', 'archive_sha256', 'archive_evidence_bytes', 'pending_operation_id'];
  if (Object.keys(row).some((key) => !allowed.includes(key))) throw new Error('Recovery journal is unavailable.');
  try {
    const record = validateRecoveryReceiptRecord({ sessionId: row.session_id, planHash: row.plan_hash, sourceGeneration: row.source_generation, sourceSha256: row.source_sha256, replacementGeneration: row.replacement_generation, replacementSha256: row.replacement_sha256, receipt: { operationId: row.operation_id, archiveId: row.archive_id, archivedAt: row.archived_at, evidenceBytes: row.evidence_bytes, alreadyCommitted: true }, opened: row.opened === 1 });
    if (typeof row.opened !== 'number' || (row.opened !== 0 && row.opened !== 1) || row.pending_operation_id !== record.receipt.operationId || row.archive_session_id !== record.sessionId || row.archive_generation !== record.sourceGeneration || String(row.archive_sha256).toLowerCase() !== record.sourceSha256 || row.archive_evidence_bytes !== record.receipt.evidenceBytes) throw new Error('bad receipt/archive reference');
    return record;
  } catch { throw new Error('Recovery journal is unavailable.'); }
}

function persistenceFor(db: SQLiteTransactionDatabase): StartupRecoveryPersistence {
  const makeTx = (sql: SQLiteExecutor): StartupRecoveryTransaction => {
    const validateJournal = async () => {
      const archives = await sql.getAllAsync<{ archive_id: string; session_id: string; schema_version: number; generation: string; archived_at: string; evidence_bytes: number; sha256: string }>('SELECT archive_id,session_id,schema_version,generation,archived_at,evidence_bytes,sha256 FROM recovery_archives ORDER BY archived_at,archive_id');
      const rows = await sql.getAllAsync<Record<string, unknown>>('SELECT r.session_id,r.plan_hash,r.source_generation,r.source_sha256,r.replacement_generation,r.replacement_sha256,r.operation_id,r.archive_id,r.archived_at,r.evidence_bytes,p.opened,a.session_id AS archive_session_id,a.generation AS archive_generation,a.sha256 AS archive_sha256,a.evidence_bytes AS archive_evidence_bytes,p.operation_id AS pending_operation_id FROM recovery_receipts r LEFT JOIN recovery_pending_open p ON p.operation_id=r.operation_id LEFT JOIN recovery_archives a ON a.archive_id=r.archive_id ORDER BY r.archived_at,r.operation_id');
      if (archives.length > 8 || rows.length !== archives.length) throw new Error('Recovery journal is unavailable.');
      const archiveIds = new Set<string>();
      for (const row of archives) {
        try {
          validateRecoveryId(row.archive_id, 'Recovery archive'); validateRecoveryId(row.session_id, 'Recovery session'); validateGeneration(row.generation);
          validateRecoveryIso(row.archived_at, 'Recovery archive time');
          if (archiveIds.has(row.archive_id) || !Number.isSafeInteger(row.schema_version) || row.schema_version < 1 || !Number.isSafeInteger(row.evidence_bytes) || row.evidence_bytes < 0 || row.evidence_bytes > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(row.sha256)) throw new Error('bad archive');
          archiveIds.add(row.archive_id);
        } catch { throw new Error('Recovery journal is unavailable.'); }
      }
      const records = rows.map(receiptFromRow);
      const referenced = new Set(records.map((record) => record.receipt.archiveId));
      if (referenced.size !== records.length || referenced.size !== archiveIds.size || [...archiveIds].some((id) => !referenced.has(id))) throw new Error('Recovery journal is unavailable.');
      const pending = await sql.getAllAsync<{ operation_id: string; opened: number }>('SELECT operation_id,opened FROM recovery_pending_open ORDER BY operation_id');
      if (pending.length !== records.length) throw new Error('Recovery journal is unavailable.');
      const pendingIds = new Set<string>();
      for (const item of pending) {
        try { validateRecoveryId(item.operation_id, 'Recovery operation'); }
        catch { throw new Error('Recovery journal is unavailable.'); }
        if (pendingIds.has(item.operation_id) || (item.opened !== 0 && item.opened !== 1)) throw new Error('Recovery journal is unavailable.');
        pendingIds.add(item.operation_id);
      }
      if (records.some((record) => !pendingIds.has(record.receipt.operationId))) throw new Error('Recovery journal is unavailable.');
      return { archives, records };
    };
    return ({
    async readSnapshotMetadata() {
      const row = await sql.getFirstAsync<{ schema_version: number; evidence_bytes: number }>('SELECT schema_version,length(CAST(value AS BLOB)) AS evidence_bytes FROM app_state WHERE key = ?', STORAGE_KEY);
      if (!row) return undefined;
      const generation = await this.readGeneration();
      if (!Number.isSafeInteger(row.schema_version) || row.schema_version < 1 || !Number.isSafeInteger(row.evidence_bytes) || row.evidence_bytes < 0) throw new Error('Recovery journal is unavailable.');
      return Object.freeze({ schemaVersion: row.schema_version, generation: generation ?? 'legacy', evidenceBytes: row.evidence_bytes });
    },
    async readSnapshot(maxBytes): Promise<StartupRecoverySnapshot | undefined> {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Recovery storage limit is invalid.');
      const row = await sql.getFirstAsync<{ value: string; schema_version: number }>('SELECT value,schema_version FROM app_state WHERE key = ? AND length(CAST(value AS BLOB)) <= ?', STORAGE_KEY, maxBytes);
      if (!row) return undefined;
      const generation = await this.readGeneration();
      if (!Number.isSafeInteger(row.schema_version) || row.schema_version < 1 || recoveryUtf8Bytes(row.value, maxBytes) > maxBytes) throw new Error('Saved data is outside the recovery limit.');
      return Object.freeze({ raw: row.value, schemaVersion: row.schema_version, generation: generation ?? 'legacy' });
    },
    async readGeneration() {
      const row = await sql.getFirstAsync<{ value: string }>('SELECT value FROM storage_meta WHERE key = ?', GENERATION_KEY);
      if (!row) return undefined;
      try { return validateGeneration(row.value); } catch { throw new Error('Recovery journal is unavailable.'); }
    },
    async readArchiveMetadata() {
      return (await validateJournal()).archives.map(({ evidence_bytes }) => ({ evidenceBytes: evidence_bytes }));
    },
    async readPendingReceipt() {
      const { records } = await validateJournal();
      return records.find((record) => !record.opened);
    },
    async findReceipt(sessionId, planHash) {
      return (await validateJournal()).records.find((record) => record.sessionId === sessionId && record.planHash === planHash);
    },
    async findReceiptByOperationId(operationId) {
      return (await validateJournal()).records.find((record) => record.receipt.operationId === operationId);
    },
    async writeSnapshot(raw, schemaVersion) {
      await sql.runAsync('INSERT INTO app_state(key,value,schema_version,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,schema_version=excluded.schema_version,updated_at=excluded.updated_at', STORAGE_KEY, raw, schemaVersion, new Date().toISOString());
    },
    async writeGeneration(generation) {
      await sql.runAsync('INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', GENERATION_KEY, validateRecoveryId(generation, 'Storage generation'));
    },
    async insertArchive(record: StartupRecoveryArchiveRecord) {
      await sql.runAsync('INSERT INTO recovery_archives(archive_id,session_id,raw,schema_version,generation,archived_at,evidence_bytes,sha256) VALUES(?,?,?,?,?,?,?,?)', record.archiveId, record.sessionId, record.raw, record.schemaVersion, record.generation, record.archivedAt, record.evidenceBytes, record.sha256);
    },
    async insertReceipt(record: StartupRecoveryReceiptRecord) {
      const receipt = validateRecoveryReceipt(record.receipt);
      await sql.runAsync('INSERT INTO recovery_receipts(session_id,plan_hash,source_generation,source_sha256,replacement_generation,replacement_sha256,operation_id,archive_id,archived_at,evidence_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)', record.sessionId, record.planHash, record.sourceGeneration, record.sourceSha256, record.replacementGeneration, record.replacementSha256, receipt.operationId, receipt.archiveId, receipt.archivedAt, receipt.evidenceBytes);
      await sql.runAsync('INSERT INTO recovery_pending_open(operation_id,opened) VALUES(?,0)', receipt.operationId);
    },
    async markReceiptOpened(operationId) { await sql.runAsync('UPDATE recovery_pending_open SET opened=1 WHERE operation_id=?', operationId); },
  });
  };
  return {
    async withTransaction<T>(work: (transaction: StartupRecoveryTransaction) => Promise<T>): Promise<T> {
      let result!: T;
      await db.withExclusiveTransactionAsync(async (tx) => { result = await work(makeTx(tx)); });
      return result;
    },
  };
}

/** SQLite stores snapshots and recovery evidence in private app storage. */
export class SQLiteStateStore implements StateStore {
  private readonly openDatabase: () => Promise<SQLiteTransactionDatabase>;
  private readonly fixedDatabase?: Promise<SQLiteTransactionDatabase>;
  private readonly tracksProductionHandle: boolean;
  private operationQueue: Promise<void> = Promise.resolve();
  private initialized?: Promise<SQLiteTransactionDatabase>;
  private generationBaseline = false;
  private originGeneration?: string;
  private currentGeneration?: string;
  readonly recovery;
  readonly pendingCapture: PendingCaptureBackend;
  private readonly randomId: () => string;
  private readonly lifecycleGeneration = stateDatabaseLifecycleGeneration;
  private readonly resolvePendingCaptureUriOption?: (path: string) => string;

  constructor(options: SQLiteStateStoreOptions = {}) {
    this.fixedDatabase = options.database;
    this.tracksProductionHandle = options.database === undefined && options.openDatabase === undefined;
    this.openDatabase = options.openDatabase ?? (() => SQLite.openDatabaseAsync(DB_NAME) as Promise<SQLiteTransactionDatabase>);
    this.randomId = options.randomId ?? Crypto.randomUUID;
    this.resolvePendingCaptureUriOption = options.resolvePendingCaptureUri;
    const owner = this;
    const persistence: StartupRecoveryPersistence = { withTransaction: async <T>(work: (tx: StartupRecoveryTransaction) => Promise<T>) => {
      return owner.enqueue(async () => {
        const db = await owner.initialize();
        return persistenceFor(db).withTransaction(work);
      });
    } };
    this.recovery = createStartupRecoveryBackend({
      persistence, randomId: this.randomId, now: options.now, sha256: options.sha256 ?? defaultSha256,
      getOpenedGeneration: async () => this.generationBaseline ? { originGeneration: this.originGeneration, currentGeneration: this.currentGeneration } : undefined,
    });
    const assertLoadedGeneration = async (tx: SQLiteExecutor, action: string) => {
      if (!this.generationBaseline) throw new Error('Load the current workspace before accessing pending recording data.');
      const row = await tx.getFirstAsync<{ value: string }>('SELECT value FROM storage_meta WHERE key=?', GENERATION_KEY);
      const current = row ? validateGeneration(row.value) : undefined;
      if (current !== this.currentGeneration) throw new Error(`Saved data changed in another workspace. Reload before ${action}.`);
    };
    const nextRevision = (current?: string) => {
      const revision = validatePendingCaptureUuid(this.randomId());
      if (revision === current) throw new Error('Pending recording revision could not be advanced.');
      return revision;
    };
    this.pendingCapture = {
      read: () => this.enqueue(async () => {
        const db = await this.initialize();
        let read!: PendingCaptureRead;
        await db.withExclusiveTransactionAsync(async (rawTx) => {
          const tx = rawTx as SQLiteExecutor;
          await assertLoadedGeneration(tx, 'read');
          read = (await readPendingCapture(tx)).read;
        });
        return read;
      }),
      create: (expectedEmptyRevision, captureValue) => {
        const expectedRevision = expectedEmptyRevision;
        const capture = validatePendingCaptureRecord(captureValue);
        if (capture.phase !== 'prepared' || capture.replacementPaths.length || capture.replacementOverflow || capture.inspection) throw new Error('A new pending recording must be in prepared state.');
        return this.enqueue(async () => {
        const db = await this.initialize();
        let result!: PendingCaptureRead;
        await db.withExclusiveTransactionAsync(async (rawTx) => {
          const tx = rawTx as SQLiteExecutor;
          await assertLoadedGeneration(tx, 'create');
          const current = (await readPendingCapture(tx)).read;
          if (current.kind !== 'empty' || current.revision !== expectedRevision) throw new Error('Pending recording slot changed before capture was saved.');
          const revision = nextRevision(current.revision ?? undefined);
          await writePendingCapture(tx, serializePendingCaptureSlot({ version: 1, revision, capture }));
          result = Object.freeze({ kind: 'valid', revision, capture });
        });
        return result;
        });
      },
      update: (expected, captureValue) => {
        const expectedSnapshot = Object.freeze({ id: validatePendingCaptureUuid(expected.id), revision: validatePendingCaptureUuid(expected.revision) });
        const nextValue = validatePendingCaptureRecord(captureValue);
        return this.enqueue(async () => {
        const db = await this.initialize();
        let result!: PendingCaptureRead;
        await db.withExclusiveTransactionAsync(async (rawTx) => {
          const tx = rawTx as SQLiteExecutor;
          await assertLoadedGeneration(tx, 'update');
          const current = (await readPendingCapture(tx)).read;
          if (current.kind !== 'valid' || current.revision !== expectedSnapshot.revision || current.capture.id !== expectedSnapshot.id) throw new Error('Pending recording changed before update.');
          const capture = assertPendingCaptureTransition(current.capture, nextValue);
          const revision = nextRevision(current.revision);
          await writePendingCapture(tx, serializePendingCaptureSlot({ version: 1, revision, capture }));
          result = Object.freeze({ kind: 'valid', revision, capture });
        });
        return result;
        });
      },
      clearAfterDiscard: (expected) => {
        const expectedSnapshot = Object.freeze({ id: validatePendingCaptureUuid(expected.id), revision: validatePendingCaptureUuid(expected.revision) });
        return this.enqueue(async () => {
        const db = await this.initialize();
        await db.withExclusiveTransactionAsync(async (rawTx) => {
          const tx = rawTx as SQLiteExecutor;
          await assertLoadedGeneration(tx, 'discard');
          const current = (await readPendingCapture(tx)).read;
          if (current.kind !== 'valid' || current.revision !== expectedSnapshot.revision || current.capture.id !== expectedSnapshot.id || current.capture.phase !== 'discarding' || current.capture.replacementOverflow) throw new Error('Pending recording cannot be cleared before discard verification.');
          const revision = nextRevision(current.revision);
          await writePendingCapture(tx, serializePendingCaptureSlot(emptyPendingCaptureSlot(revision)));
        });
        });
      },
    };
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let unlock!: () => void;
    this.operationQueue = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try { return await work(); } finally { unlock(); }
  }

  private async initialize(): Promise<SQLiteTransactionDatabase> {
    if (privacyStateDatabaseDeleting || this.lifecycleGeneration !== stateDatabaseLifecycleGeneration) throw new Error('This local storage handle has been closed for privacy cleanup.');
    if (!this.initialized) {
      openingStateDatabases += 1;
      this.initialized = Promise.resolve().then(() => this.fixedDatabase ?? this.openDatabase()).then(async (opened) => {
      const database = trackStateDatabase(opened, this.tracksProductionHandle);
      await database.execAsync(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL,schema_version INTEGER NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS recovery_archives (archive_id TEXT PRIMARY KEY NOT NULL,session_id TEXT UNIQUE NOT NULL,raw TEXT NOT NULL,schema_version INTEGER NOT NULL,generation TEXT NOT NULL,archived_at TEXT NOT NULL,evidence_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS recovery_receipts (session_id TEXT PRIMARY KEY NOT NULL,plan_hash TEXT NOT NULL,source_generation TEXT NOT NULL,source_sha256 TEXT NOT NULL,replacement_generation TEXT NOT NULL,replacement_sha256 TEXT NOT NULL,operation_id TEXT UNIQUE NOT NULL,archive_id TEXT NOT NULL,archived_at TEXT NOT NULL,evidence_bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS recovery_pending_open (operation_id TEXT PRIMARY KEY NOT NULL,opened INTEGER NOT NULL DEFAULT 0);`);
      return database;
      }).catch((error) => {
        this.initialized = undefined;
        throw error;
      }).finally(() => {
        openingStateDatabases -= 1;
        if (openingStateDatabases === 0) stateOpenWaiters.splice(0).forEach((resolve) => resolve());
      });
    }
    return this.initialized;
  }

  async load(): Promise<AppState | undefined> {
    return this.enqueue(async () => {
      const db = await this.initialize();
      const loaded: { row?: { value: string; schema_version: number } | null } = {};
      let generation: string | undefined;
      await db.withExclusiveTransactionAsync(async (tx) => {
        loaded.row = await tx.getFirstAsync<{ value: string; schema_version: number }>('SELECT value, schema_version FROM app_state WHERE key = ?', STORAGE_KEY);
        const metadata = await tx.getFirstAsync<{ value: string }>('SELECT value FROM storage_meta WHERE key = ?', GENERATION_KEY);
        if (metadata) generation = validateGeneration(metadata.value);
      });
      let state: AppState | undefined;
      if (loaded.row) {
        if (loaded.row.schema_version > SCHEMA_VERSION) throw new Error('This data was saved by a newer version of the app. Update the app before opening it.');
        try { state = JSON.parse(loaded.row.value) as AppState; }
        catch { throw new Error('Saved app data could not be read. Your local database was preserved for recovery.'); }
      }
      this.originGeneration = generation;
      this.currentGeneration = generation;
      this.generationBaseline = true;
      return state;
    });
  }

  async readCurrentSnapshot(): Promise<Readonly<{ raw: string; schemaVersion: number }> | undefined> {
    return this.enqueue(async () => {
      if (!this.generationBaseline) throw new Error('Load the current workspace before reading its persisted snapshot.');
      const db = await this.initialize();
      let snapshot: Readonly<{ raw: string; schemaVersion: number }> | undefined;
      await db.withExclusiveTransactionAsync(async (tx) => {
        const metadata = await tx.getFirstAsync<{ value: string }>('SELECT value FROM storage_meta WHERE key = ?', GENERATION_KEY);
        const generation = metadata ? validateGeneration(metadata.value) : undefined;
        if (generation !== this.currentGeneration) throw new Error('Saved data changed in another workspace. Reload before reading its persisted snapshot.');

        const rowMeta = await tx.getFirstAsync<{ schema_version: number; bytes: number }>(
          'SELECT schema_version, length(CAST(value AS BLOB)) AS bytes FROM app_state WHERE key = ?', STORAGE_KEY);
        if (!rowMeta) return;
        if (!Number.isSafeInteger(rowMeta.schema_version) || rowMeta.schema_version < 1) throw new Error('Saved app data schema is unavailable.');
        if (rowMeta.schema_version > SCHEMA_VERSION) throw new Error('Saved app data was created by a newer version.');
        if (!Number.isSafeInteger(rowMeta.bytes) || rowMeta.bytes < 0 || rowMeta.bytes > STATE_SNAPSHOT_READ_MAX_BYTES) {
          throw new Error('Saved app data exceeds the bounded snapshot read limit.');
        }
        const row = await tx.getFirstAsync<{ value: string }>(
          'SELECT value FROM app_state WHERE key = ? AND length(CAST(value AS BLOB)) <= ?', STORAGE_KEY, STATE_SNAPSHOT_READ_MAX_BYTES);
        if (!row || typeof row.value !== 'string' || recoveryUtf8Bytes(row.value, STATE_SNAPSHOT_READ_MAX_BYTES) !== rowMeta.bytes) {
          throw new Error('Saved app data could not be read as a bounded exact snapshot.');
        }
        snapshot = Object.freeze({ raw: row.value, schemaVersion: rowMeta.schema_version });
      });
      return snapshot;
    });
  }

  async save(state: AppState, options?: { consumePendingCapture: ConsumePendingCapture }): Promise<void> {
    const rawSnapshot = JSON.stringify(state);
    const stateSnapshot = JSON.parse(rawSnapshot) as AppState;
    const consume = options?.consumePendingCapture
      ? Object.freeze({
          id: validatePendingCaptureUuid(options.consumePendingCapture.id),
          revision: validatePendingCaptureUuid(options.consumePendingCapture.revision),
          noteId: validatePendingCaptureUuid(options.consumePendingCapture.noteId),
        })
      : undefined;
    await this.enqueue(async () => {
      const db = await this.initialize();
      const raw = rawSnapshot;
      const generation = validateRecoveryId(this.randomId(), 'Storage generation');
      let resolvedUri: string | undefined;
      if (consume) {
        let current!: PendingCaptureRead;
        await db.withExclusiveTransactionAsync(async (rawTx) => { current = (await readPendingCapture(rawTx as SQLiteExecutor)).read; });
        if (current.kind !== 'valid' || current.capture.id !== consume.id || current.revision !== consume.revision) throw new Error('Pending recording changed before it could be attached.');
        if (this.resolvePendingCaptureUriOption) resolvedUri = this.resolvePendingCaptureUriOption(current.capture.originalPath);
        else {
          const fileSystem = await import('expo-file-system/legacy');
          if (!fileSystem.documentDirectory) throw new Error('Pending recording storage is unavailable.');
          resolvedUri = resolvePendingCaptureUri(fileSystem.documentDirectory, current.capture.originalPath);
        }
      }
      await db.withExclusiveTransactionAsync(async (tx) => {
        const current = await tx.getFirstAsync<{ value: string }>('SELECT value FROM storage_meta WHERE key = ?', GENERATION_KEY);
        const currentGeneration = current ? validateGeneration(current.value) : undefined;
        const hasSnapshot = Boolean(await tx.getFirstAsync<{ key: string }>('SELECT key FROM app_state WHERE key = ?', STORAGE_KEY));
        if (this.generationBaseline) {
          if (currentGeneration !== this.currentGeneration) throw new Error('Saved data changed in another workspace. Reload before saving.');
        } else if (hasSnapshot || currentGeneration !== undefined) throw new Error('Load the current workspace before saving.');
        let consumedCaptureRaw: string | undefined;
        if (consume) {
          const currentPending = await readPendingCapture(tx as SQLiteExecutor);
          const prior = await tx.getFirstAsync<{ value: string }>('SELECT value FROM app_state WHERE key=?', STORAGE_KEY);
          const capture = assertPendingCaptureConsumption(stateSnapshot, prior?.value, currentPending.read, consume, resolvedUri!);
          if (currentPending.read.kind !== 'valid') throw new Error('Pending recording changed before it could be attached.');
          const revision = validatePendingCaptureUuid(this.randomId());
          if (revision === currentPending.read.revision) throw new Error('Pending recording revision could not be advanced.');
          consumedCaptureRaw = serializePendingCaptureSlot({ version: 1, revision, consumedCaptureId: capture.id });
        }
        const sql = tx as SQLiteExecutor;
        await sql.runAsync('INSERT INTO app_state(key,value,schema_version,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,schema_version=excluded.schema_version,updated_at=excluded.updated_at', STORAGE_KEY, raw, SCHEMA_VERSION, new Date().toISOString());
        await sql.runAsync('INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', GENERATION_KEY, generation);
        if (consumedCaptureRaw) await writePendingCapture(sql, consumedCaptureRaw);
      });
      if (!this.generationBaseline) this.originGeneration = undefined;
      this.currentGeneration = generation;
      this.generationBaseline = true;
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      const db = await this.initialize();
      const generation = validateRecoveryId(this.randomId(), 'Storage generation');
      await db.withExclusiveTransactionAsync(async (tx) => {
        const current = await tx.getFirstAsync<{ value: string }>('SELECT value FROM storage_meta WHERE key = ?', GENERATION_KEY);
        const currentGeneration = current ? validateGeneration(current.value) : undefined;
        const hasSnapshot = Boolean(await tx.getFirstAsync<{ key: string }>('SELECT key FROM app_state WHERE key = ?', STORAGE_KEY));
        if (this.generationBaseline) {
          if (currentGeneration !== this.currentGeneration) throw new Error('Saved data changed in another workspace. Reload before clearing.');
        } else if (hasSnapshot || currentGeneration !== undefined) throw new Error('Load the current workspace before clearing.');
        const pending = (await readPendingCapture(tx as SQLiteExecutor)).read;
        if (pending.kind !== 'empty') throw new Error('Discard the pending recording before clearing the workspace.');
        await tx.runAsync('DELETE FROM app_state WHERE key = ?', STORAGE_KEY);
        await tx.runAsync('INSERT INTO storage_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', GENERATION_KEY, generation);
      });
      if (!this.generationBaseline) this.originGeneration = undefined;
      this.currentGeneration = generation;
      this.generationBaseline = true;
    });
  }

  async assertCurrent(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.generationBaseline) throw new Error('The current workspace has not been loaded.');
      const db = await this.initialize();
      let currentGeneration: string | undefined;
      await db.withExclusiveTransactionAsync(async (tx) => {
        const row = await tx.getFirstAsync<{ value: string }>('SELECT value FROM storage_meta WHERE key = ?', GENERATION_KEY);
        currentGeneration = row ? validateGeneration(row.value) : undefined;
      });
      if (currentGeneration !== this.currentGeneration) throw new Error('Saved data changed in another workspace. Reload before continuing.');
    });
  }
}

export const stateStore: StateStore = new SQLiteStateStore();

/** Construct a fresh platform store after a completed privacy database deletion. */
export function createPlatformStateStore(): StateStore {
  return new SQLiteStateStore();
}

/** Internal privacy-only deletion hook. It is intentionally absent from StateStore/UI. */
export async function eraseStateDatabaseForPrivacy(beforeMutation: () => Promise<void>): Promise<void> {
  await beforeMutation();
  privacyStateDatabaseDeleting = true;
  if (openingStateDatabases > 0) await new Promise<void>((resolve) => stateOpenWaiters.push(resolve));
  const handles = [...liveStateHandles];
  for (const handle of handles) handle.closing = true;
  await Promise.all(handles.map(waitForStateHandleIdle));
  for (const handle of handles) {
    if (handle.closed) continue;
    if (typeof handle.database.closeAsync !== 'function') throw new Error('Local database handles cannot be drained in this runtime.');
    await handle.database.closeAsync();
    handle.closed = true;
  }

  await beforeMutation();
  await SQLite.deleteDatabaseAsync(DB_NAME);
  const fileSystem = await import('expo-file-system/legacy');
  const directory = SQLite.defaultDatabaseDirectory;
  if (!directory || !directory.startsWith('file://') || directory.includes('..')) throw new Error('The app database directory is unavailable.');
  const databasePath = `${directory.endsWith('/') ? directory : `${directory}/`}${DB_NAME}`;
  for (const suffix of ['-wal', '-shm']) {
    const path = `${databasePath}${suffix}`;
    const info = await fileSystem.getInfoAsync(path);
    if (info.exists) {
      if ('isDirectory' in info && info.isDirectory) throw new Error('A database sidecar path is invalid.');
      await beforeMutation();
      await fileSystem.deleteAsync(path);
    }
  }
  stateDatabaseLifecycleGeneration += 1;
  privacyStateDatabaseDeleting = false;
  for (const handle of handles) liveStateHandles.delete(handle);
}

/** Confirms the app DB and its exact SQLite sidecars are absent after SDK deletion succeeds. */
export async function privacyStateDatabaseGone(): Promise<boolean> {
  const fileSystem = await import('expo-file-system/legacy');
  const directory = SQLite.defaultDatabaseDirectory;
  if (!directory || !directory.startsWith('file://') || directory.includes('..')) throw new Error('The app database directory is unavailable.');
  const base = `${directory.endsWith('/') ? directory : `${directory}/`}${DB_NAME}`;
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    const info = await fileSystem.getInfoAsync(path);
    if (info.exists) return false;
  }
  return true;
}
