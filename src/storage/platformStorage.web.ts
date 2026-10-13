import type { AppState } from '../core';
import { STORAGE_KEY, type StateStore } from './contracts';
import {
  PENDING_CAPTURE_STORAGE_KEY, assertPendingCaptureConsumption, assertPendingCaptureTransition,
  emptyPendingCaptureSlot, readPendingCaptureSlot, serializePendingCaptureSlot,
  validatePendingCaptureRecord, validatePendingCaptureUuid,
  type ConsumePendingCapture, type PendingCaptureBackend, type PendingCaptureRead,
} from './pendingCapture';
import { closeBrowserDatabaseConnections, registerBrowserDatabase } from './browserDatabaseRegistry';
import {
  createStartupRecoveryBackend, recoveryUtf8Bytes, validateRecoveryId, validateRecoveryIso,
  validateRecoveryReceiptRecord,
  STARTUP_RECOVERY_MAX_ARCHIVES, STARTUP_RECOVERY_MAX_EVIDENCE_BYTES,
  type StartupRecoveryArchiveRecord, type StartupRecoveryPersistence, type StartupRecoveryReceiptRecord,
  type StartupRecoverySnapshot, type StartupRecoverySnapshotMetadata, type StartupRecoveryTransaction,
} from './startupRecovery';

const DB_NAME = 'voice-assistant';
const STORE_NAME = 'snapshots';
const SCHEMA_KEY = '__still.storage.schema.v1';
const GENERATION_KEY = '__still.storage.generation.v1';
const SIZE_KEY = '__still.storage.size.v1';
const ARCHIVE_META_PREFIX = '__still.recovery.archive-meta.v1:';
const ARCHIVE_DATA_PREFIX = '__still.recovery.archive-data.v1:';
const RECEIPT_PREFIX = '__still.recovery.receipt.v1:';
const OPERATION_PREFIX = '__still.recovery.operation.v1:';
const PENDING_PREFIX = '__still.recovery.pending.v1:';
const trackedConnections = new WeakMap<IDBDatabase, () => void>();
let appStorageLifecycleGeneration = 0;
let privacyDeletingAppStorage = false;

function openDb(factory: IDBFactory = indexedDB, expectedGeneration = appStorageLifecycleGeneration): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (privacyDeletingAppStorage || expectedGeneration !== appStorageLifecycleGeneration) { reject(new Error('This local browser storage handle has been closed for privacy cleanup.')); return; }
    if (factory === globalThis.indexedDB) stateDatabaseDeleteConfirmed = false;
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => {
      const database = request.result;
      trackedConnections.set(database, registerBrowserDatabase(DB_NAME, database));
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open local browser storage.'));
  });
}

function closeTracked(database: IDBDatabase): void {
  try { database.close(); } finally { trackedConnections.get(database)?.(); trackedConnections.delete(database); }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
  });
}

function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Browser storage transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Browser storage transaction was cancelled.'));
  });
}

async function keysWithPrefix(store: IDBObjectStore, prefix: string, max: number): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const result: IDBValidKey[] = [];
    const request = store.openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onerror = () => reject(request.error ?? new Error('Browser recovery journal could not be read.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(result); return; }
      result.push(cursor.key);
      if (result.length > max) { reject(new Error('Browser recovery journal is unavailable.')); return; }
      cursor.continue();
    };
  });
}

function cleanSchema(value: unknown): number {
  if (value === undefined) return 1; // Legacy snapshots predate the reserved schema marker.
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).some((key) => key !== 'schemaVersion')) throw new Error('Browser storage metadata is unavailable.');
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error('Browser storage metadata is unavailable.');
  return version as number;
}

function cleanGeneration(value: unknown): string {
  if (value === undefined) return 'legacy';
  try { return validateRecoveryId(value, 'Storage generation'); }
  catch { throw new Error('Browser storage metadata is unavailable.'); }
}

function cleanSize(value: unknown, raw?: string): number {
  if (value === undefined) {
    if (raw === undefined) return -1;
    return recoveryUtf8Bytes(raw, STARTUP_RECOVERY_MAX_EVIDENCE_BYTES);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).some((key) => key !== 'bytes')) throw new Error('Browser storage metadata is unavailable.');
  const bytes = (value as { bytes?: unknown }).bytes;
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) throw new Error('Browser storage metadata is unavailable.');
  return bytes as number;
}

function validateArchiveMetadata(value: unknown): { archiveId: string; sessionId: string; schemaVersion: number; generation: string; archivedAt: string; evidenceBytes: number; sha256: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Browser recovery journal is unavailable.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['archiveId', 'sessionId', 'schemaVersion', 'generation', 'archivedAt', 'evidenceBytes', 'sha256'].includes(key))) throw new Error('Browser recovery journal is unavailable.');
  try {
    const archiveId = validateRecoveryId(row.archiveId, 'Recovery archive');
    const sessionId = validateRecoveryId(row.sessionId, 'Recovery session');
    const generation = row.generation === 'legacy' ? 'legacy' : validateRecoveryId(row.generation, 'Storage generation');
    const archivedAt = validateRecoveryIso(row.archivedAt, 'Recovery archive time');
    if (!Number.isSafeInteger(row.schemaVersion) || (row.schemaVersion as number) < 1 || !Number.isSafeInteger(row.evidenceBytes) || (row.evidenceBytes as number) < 0 || (row.evidenceBytes as number) > STARTUP_RECOVERY_MAX_EVIDENCE_BYTES || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(row.sha256)) throw new Error('bad metadata');
    return { archiveId, sessionId, schemaVersion: row.schemaVersion as number, generation, archivedAt, evidenceBytes: row.evidenceBytes as number, sha256: row.sha256.toLowerCase() };
  } catch { throw new Error('Browser recovery journal is unavailable.'); }
}

function validatePending(value: unknown, operationId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).some((key) => !['operationId', 'opened'].includes(key))) throw new Error('Browser recovery journal is unavailable.');
  const row = value as { operationId?: unknown; opened?: unknown };
  if (row.operationId !== operationId || typeof row.opened !== 'boolean') throw new Error('Browser recovery journal is unavailable.');
  return row.opened;
}

function validateStoredReceipt(value: unknown): StartupRecoveryReceiptRecord {
  return validateRecoveryReceiptRecord(value);
}

async function validateJournal(store: IDBObjectStore): Promise<{ records: StartupRecoveryReceiptRecord[]; archives: { evidenceBytes: number }[] }> {
  const [metaKeys, dataKeys, receiptKeys, operationKeys, pendingKeys] = await Promise.all([
    keysWithPrefix(store, ARCHIVE_META_PREFIX, STARTUP_RECOVERY_MAX_ARCHIVES + 1),
    keysWithPrefix(store, ARCHIVE_DATA_PREFIX, STARTUP_RECOVERY_MAX_ARCHIVES + 1),
    keysWithPrefix(store, RECEIPT_PREFIX, STARTUP_RECOVERY_MAX_ARCHIVES + 1),
    keysWithPrefix(store, OPERATION_PREFIX, STARTUP_RECOVERY_MAX_ARCHIVES + 1),
    keysWithPrefix(store, PENDING_PREFIX, STARTUP_RECOVERY_MAX_ARCHIVES + 1),
  ]);
  if (metaKeys.length !== dataKeys.length || metaKeys.length !== receiptKeys.length || metaKeys.length !== operationKeys.length || metaKeys.length !== pendingKeys.length) throw new Error('Browser recovery journal is unavailable.');
  const metadata = await Promise.all(metaKeys.map(async (key) => validateArchiveMetadata(await requestResult(store.get(key)))));
  const records: StartupRecoveryReceiptRecord[] = [];
  const seenSessions = new Set<string>();
  const seenArchives = new Set<string>();
  const dataIds = new Set(dataKeys.map((key) => String(key).slice(ARCHIVE_DATA_PREFIX.length)));
  const metadataById = new Map(metadata.map((entry) => [entry.archiveId, entry]));
  if (dataIds.size !== dataKeys.length || metadataById.size !== metadata.length || dataIds.size !== metadataById.size || [...dataIds].some((id) => !metadataById.has(id))) throw new Error('Browser recovery journal is unavailable.');
  for (const key of receiptKeys) {
    const record = validateStoredReceipt(await requestResult(store.get(key)));
    const expectedReceiptKey = `${RECEIPT_PREFIX}${record.sessionId}:${record.planHash}`;
    const operationId = record.receipt.operationId;
    if (String(key) !== expectedReceiptKey || operationId !== record.sessionId || seenSessions.has(record.sessionId) || seenArchives.has(record.receipt.archiveId)) throw new Error('Browser recovery journal is unavailable.');
    const archive = metadataById.get(record.receipt.archiveId);
    if (!archive || archive.sessionId !== record.sessionId || archive.generation !== record.sourceGeneration || archive.sha256 !== record.sourceSha256 || archive.evidenceBytes !== record.receipt.evidenceBytes) throw new Error('Browser recovery journal is unavailable.');
    const operationKey = `${OPERATION_PREFIX}${operationId}`;
    const operation = validateStoredReceipt(await requestResult(store.get(operationKey)));
    if (JSON.stringify(operation) !== JSON.stringify(record)) throw new Error('Browser recovery journal is unavailable.');
    const opened = validatePending(await requestResult(store.get(`${PENDING_PREFIX}${operationId}`)), operationId);
    seenSessions.add(record.sessionId);
    seenArchives.add(record.receipt.archiveId);
    records.push(Object.freeze({ ...record, opened }));
  }
  if (seenArchives.size !== metadata.length || seenSessions.size !== receiptKeys.length) throw new Error('Browser recovery journal is unavailable.');
  const opIds = new Set(operationKeys.map((key) => String(key).slice(OPERATION_PREFIX.length)));
  const pendingIds = new Set(pendingKeys.map((key) => String(key).slice(PENDING_PREFIX.length)));
  if (opIds.size !== operationKeys.length || pendingIds.size !== pendingKeys.length || [...seenSessions].some((id) => !opIds.has(id) || !pendingIds.has(id)) || [...opIds].some((id) => !seenSessions.has(id)) || [...pendingIds].some((id) => !seenSessions.has(id))) throw new Error('Browser recovery journal is unavailable.');
  return { records, archives: metadata.map(({ evidenceBytes }) => ({ evidenceBytes })) };
}

function persistenceFor(factory: IDBFactory, randomId: () => string, expectedGeneration: number): StartupRecoveryPersistence {
  const withTransaction = async <T>(work: (transaction: StartupRecoveryTransaction) => Promise<T>): Promise<T> => {
    const db = await openDb(factory, expectedGeneration);
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionComplete(tx);
    const store = tx.objectStore(STORE_NAME);
    const readSchema = async () => cleanSchema(await requestResult(store.get(SCHEMA_KEY)));
    const readGeneration = async () => cleanGeneration(await requestResult(store.get(GENERATION_KEY)));
    const readRaw = async () => {
      const value = await requestResult(store.get(STORAGE_KEY));
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw new Error('Saved browser data is unavailable.');
      return value;
    };
    const makeTransaction: StartupRecoveryTransaction = {
      async readSnapshotMetadata(): Promise<StartupRecoverySnapshotMetadata | undefined> {
        const exists = await requestResult(store.getKey(STORAGE_KEY));
        if (exists === undefined) return undefined;
        const [schemaVersion, generation, sizeValue] = await Promise.all([readSchema(), readGeneration(), requestResult(store.get(SIZE_KEY))]);
        const raw = await readRaw();
        if (raw === undefined) throw new Error('Browser storage metadata is unavailable.');
        const evidenceBytes = recoveryUtf8Bytes(raw);
        if (sizeValue !== undefined && cleanSize(sizeValue) !== evidenceBytes) throw new Error('Browser storage metadata is unavailable.');
        return Object.freeze({ schemaVersion, generation, evidenceBytes });
      },
      async readSnapshot(maxBytes): Promise<StartupRecoverySnapshot | undefined> {
        const raw = await readRaw();
        if (raw === undefined) return undefined;
        const evidenceBytes = recoveryUtf8Bytes(raw, maxBytes);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || evidenceBytes > maxBytes) throw new Error('Saved data exceeds the recovery size limit.');
        const [schemaVersion, generation] = await Promise.all([readSchema(), readGeneration()]);
        return Object.freeze({ raw, schemaVersion, generation });
      },
      readGeneration,
      async readArchiveMetadata() {
        return (await validateJournal(store)).archives;
      },
      async readPendingReceipt() {
        return (await validateJournal(store)).records.find((record) => !record.opened);
      },
      async findReceipt(sessionId, planHash) {
        const journal = await validateJournal(store);
        const key = `${RECEIPT_PREFIX}${sessionId}:${planHash}`;
        const value = await requestResult(store.get(key));
        if (value === undefined) return undefined;
        const record = validateStoredReceipt(value);
        if (record.sessionId !== sessionId || record.planHash !== planHash) throw new Error('Browser recovery journal is unavailable.');
        const pendingValue = await requestResult(store.get(`${PENDING_PREFIX}${record.receipt.operationId}`));
        const opened = validatePending(pendingValue, record.receipt.operationId);
        return journal.records.find((candidate) => candidate.sessionId === record.sessionId && candidate.planHash === record.planHash)
          ? Object.freeze({ ...record, opened }) : undefined;
      },
      async findReceiptByOperationId(operationId) {
        const journal = await validateJournal(store);
        const value = await requestResult(store.get(`${OPERATION_PREFIX}${operationId}`));
        if (value === undefined) return undefined;
        const record = validateStoredReceipt(value);
        if (record.receipt.operationId !== operationId) throw new Error('Browser recovery journal is unavailable.');
        const pendingValue = await requestResult(store.get(`${PENDING_PREFIX}${operationId}`));
        const opened = validatePending(pendingValue, operationId);
        return journal.records.find((candidate) => candidate.receipt.operationId === operationId) ? Object.freeze({ ...record, opened }) : undefined;
      },
      async writeSnapshot(raw, schemaVersion) {
        store.put(raw, STORAGE_KEY);
        store.put({ schemaVersion }, SCHEMA_KEY);
        store.put({ bytes: recoveryUtf8Bytes(raw) }, SIZE_KEY);
      },
      async writeGeneration(generation) { store.put(validateRecoveryId(generation, 'Storage generation'), GENERATION_KEY); },
      async insertArchive(record: StartupRecoveryArchiveRecord) {
        const meta = validateArchiveMetadata({ archiveId: record.archiveId, sessionId: record.sessionId, schemaVersion: record.schemaVersion, generation: record.generation, archivedAt: record.archivedAt, evidenceBytes: record.evidenceBytes, sha256: record.sha256 });
        store.add(meta, `${ARCHIVE_META_PREFIX}${record.archiveId}`);
        store.add({ raw: record.raw, schemaVersion: record.schemaVersion, generation: record.generation }, `${ARCHIVE_DATA_PREFIX}${record.archiveId}`);
      },
      async insertReceipt(record: StartupRecoveryReceiptRecord) {
        const safe = validateStoredReceipt(record);
        store.add(safe, `${RECEIPT_PREFIX}${safe.sessionId}:${safe.planHash}`);
        store.add(safe, `${OPERATION_PREFIX}${safe.receipt.operationId}`);
        store.add({ operationId: safe.receipt.operationId, opened: false }, `${PENDING_PREFIX}${safe.receipt.operationId}`);
      },
      async markReceiptOpened(operationId) {
        const key = `${PENDING_PREFIX}${operationId}`;
        const value = await requestResult(store.get(key));
        if (value === undefined) throw new Error('Recovery receipt could not be acknowledged.');
        validatePending(value, operationId);
        store.put({ operationId, opened: true }, key);
      },
    };
    try {
      const result = await work(makeTransaction);
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already have finished */ }
      await done.catch(() => undefined);
      throw error;
    } finally { closeTracked(db); }
  };
  return { withTransaction };
}

export type IndexedDbStateStoreOptions = { factory?: IDBFactory; randomId?: () => string; sha256?: (raw: string) => Promise<string>; now?: () => number; resolvePendingCaptureUri?: (path: string) => string };

async function readPendingCapture(store: IDBObjectStore): Promise<PendingCaptureRead> {
  const key = await requestResult(store.getKey(PENDING_CAPTURE_STORAGE_KEY));
  if (key === undefined) return Object.freeze({ kind: 'empty', revision: null });
  return readPendingCaptureSlot(await requestResult(store.get(PENDING_CAPTURE_STORAGE_KEY)));
}

function deferredDefaultFactory(): IDBFactory {
  return { open(name: string, version?: number) {
    if (typeof indexedDB === 'undefined') throw new Error('Browser storage is unavailable in this environment.');
    return indexedDB.open(name, version);
  } } as IDBFactory;
}

export class IndexedDbStateStore implements StateStore {
  readonly recovery;
  readonly pendingCapture: PendingCaptureBackend;
  private readonly factory: IDBFactory;
  private readonly randomId: () => string;
  private readonly resolvePendingCaptureUriOption?: (path: string) => string;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly lifecycleGeneration = appStorageLifecycleGeneration;
  private generationBaseline = false;
  private originGeneration?: string;
  private currentGeneration?: string;
  constructor(options: IndexedDbStateStoreOptions = {}) {
    this.factory = options.factory ?? deferredDefaultFactory();
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.resolvePendingCaptureUriOption = options.resolvePendingCaptureUri;
    const owner = this;
    this.recovery = createStartupRecoveryBackend({
      persistence: { withTransaction: (work) => owner.enqueue(() => persistenceFor(owner.factory, owner.randomId, owner.lifecycleGeneration).withTransaction(work)) }, randomId: this.randomId, now: options.now, sha256: options.sha256,
      getOpenedGeneration: async () => this.generationBaseline ? { originGeneration: this.originGeneration, currentGeneration: this.currentGeneration } : undefined,
    });
    const assertLoadedGeneration = async (store: IDBObjectStore, action: string) => {
      if (!this.generationBaseline) throw new Error('Load the current workspace before accessing pending recording data.');
      const generation = cleanGeneration(await requestResult(store.get(GENERATION_KEY)));
      const normalized = generation === 'legacy' ? undefined : generation;
      if (normalized !== this.currentGeneration) throw new Error(`Saved data changed in another workspace. Reload before ${action}.`);
    };
    const nextRevision = (current?: string) => {
      const revision = validatePendingCaptureUuid(this.randomId());
      if (revision === current) throw new Error('Pending recording revision could not be advanced.');
      return revision;
    };
    this.pendingCapture = {
      read: () => this.enqueue(() => this.withTransaction('readonly', async (store) => {
        await assertLoadedGeneration(store, 'read');
        return readPendingCapture(store);
      })),
      create: (expectedEmptyRevision, captureValue) => {
        const expectedRevision = expectedEmptyRevision;
        const capture = validatePendingCaptureRecord(captureValue);
        if (capture.phase !== 'prepared' || capture.replacementPaths.length || capture.replacementOverflow || capture.inspection) throw new Error('A new pending recording must be in prepared state.');
        return this.enqueue(() => this.withTransaction('readwrite', async (store) => {
        await assertLoadedGeneration(store, 'create');
        const current = await readPendingCapture(store);
        if (current.kind !== 'empty' || current.revision !== expectedRevision) throw new Error('Pending recording slot changed before capture was saved.');
        const revision = nextRevision(current.revision ?? undefined);
        store.put(serializePendingCaptureSlot({ version: 1, revision, capture }), PENDING_CAPTURE_STORAGE_KEY);
        return Object.freeze({ kind: 'valid', revision, capture });
        }));
      },
      update: (expected, captureValue) => {
        const expectedSnapshot = Object.freeze({ id: validatePendingCaptureUuid(expected.id), revision: validatePendingCaptureUuid(expected.revision) });
        const nextValue = validatePendingCaptureRecord(captureValue);
        return this.enqueue(() => this.withTransaction('readwrite', async (store) => {
        await assertLoadedGeneration(store, 'update');
        const current = await readPendingCapture(store);
        if (current.kind !== 'valid' || current.revision !== expectedSnapshot.revision || current.capture.id !== expectedSnapshot.id) throw new Error('Pending recording changed before update.');
        const capture = assertPendingCaptureTransition(current.capture, nextValue);
        const revision = nextRevision(current.revision);
        store.put(serializePendingCaptureSlot({ version: 1, revision, capture }), PENDING_CAPTURE_STORAGE_KEY);
        return Object.freeze({ kind: 'valid', revision, capture });
        }));
      },
      clearAfterDiscard: (expected) => {
        const expectedSnapshot = Object.freeze({ id: validatePendingCaptureUuid(expected.id), revision: validatePendingCaptureUuid(expected.revision) });
        return this.enqueue(() => this.withTransaction('readwrite', async (store) => {
        await assertLoadedGeneration(store, 'discard');
        const current = await readPendingCapture(store);
        if (current.kind !== 'valid' || current.revision !== expectedSnapshot.revision || current.capture.id !== expectedSnapshot.id || current.capture.phase !== 'discarding' || current.capture.replacementOverflow) throw new Error('Pending recording cannot be cleared before discard verification.');
        store.put(serializePendingCaptureSlot(emptyPendingCaptureSlot(nextRevision(current.revision))), PENDING_CAPTURE_STORAGE_KEY);
        }));
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

  private async withTransaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    this.assertActive();
    const db = await openDb(this.factory, this.lifecycleGeneration);
    let tx: IDBTransaction | undefined;
    let done: Promise<void> | undefined;
    try {
      tx = db.transaction(STORE_NAME, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      done = transactionComplete(tx);
      const result = await work(tx.objectStore(STORE_NAME));
      await done;
      return result;
    } catch (error) {
      try { tx?.abort(); } catch { /* transaction may already have finished */ }
      await done?.catch(() => undefined);
      throw error;
    } finally { closeTracked(db); }
  }

  private assertActive(): void {
    if (privacyDeletingAppStorage || this.lifecycleGeneration !== appStorageLifecycleGeneration) throw new Error('This local browser storage handle has been closed for privacy cleanup.');
  }

  async load(): Promise<AppState | undefined> {
    return this.enqueue(async () => {
      this.assertActive();
      const db = await openDb(this.factory, this.lifecycleGeneration);
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const done = transactionComplete(tx);
        const store = tx.objectStore(STORE_NAME);
        const raw = await requestResult(store.get(STORAGE_KEY));
        const schema = cleanSchema(await requestResult(store.get(SCHEMA_KEY)));
        const generation = cleanGeneration(await requestResult(store.get(GENERATION_KEY)));
        if (raw !== undefined && typeof raw !== 'string') throw new Error('Saved browser data is unavailable.');
        if (schema > 1) throw new Error('This data was saved by a newer version of the app. Update the app before opening it.');
        let state: AppState | undefined;
        if (raw !== undefined) {
          try { state = JSON.parse(raw) as AppState; }
          catch { throw new Error('Saved app data could not be read. Browser storage was preserved for recovery.'); }
        }
        await done;
        this.originGeneration = generation === 'legacy' ? undefined : generation;
        this.currentGeneration = this.originGeneration;
        this.generationBaseline = true;
        return state;
      } finally { closeTracked(db); }
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
      this.assertActive();
      const raw = rawSnapshot;
      const bytes = recoveryUtf8Bytes(raw);
      const generation = validateRecoveryId(this.randomId(), 'Storage generation');
      const resolvedUri = consume ? this.resolvePendingCaptureUriOption?.(await this.withTransaction('readonly', async (store) => {
        const generationValue = cleanGeneration(await requestResult(store.get(GENERATION_KEY)));
        const normalized = generationValue === 'legacy' ? undefined : generationValue;
        if (!this.generationBaseline || normalized !== this.currentGeneration) throw new Error('Saved data changed in another workspace. Reload before attaching a pending recording.');
        const pending = await readPendingCapture(store);
        if (pending.kind !== 'valid' || pending.revision !== consume.revision || pending.capture.id !== consume.id) throw new Error('Pending recording changed before it could be attached.');
        return pending.capture.originalPath;
      })) : undefined;
      if (consume && !resolvedUri) throw new Error('Pending recording storage is unavailable in this runtime.');
      await this.withTransaction('readwrite', async (store) => {
        const [currentGeneration, snapshotKey] = await Promise.all([requestResult(store.get(GENERATION_KEY)), requestResult(store.getKey(STORAGE_KEY))]);
        const generationValue = cleanGeneration(currentGeneration);
        const normalizedCurrent = generationValue === 'legacy' ? undefined : generationValue;
        if (this.generationBaseline) {
          if (normalizedCurrent !== this.currentGeneration) throw new Error('Saved data changed in another workspace. Reload before saving.');
        } else if (snapshotKey !== undefined || normalizedCurrent !== undefined) throw new Error('Load the current workspace before saving.');
        if (consume) {
          const pending = await readPendingCapture(store);
          const priorValue = await requestResult(store.get(STORAGE_KEY));
          if (priorValue !== undefined && typeof priorValue !== 'string') throw new Error('Saved browser data is unavailable.');
          const capture = assertPendingCaptureConsumption(stateSnapshot, priorValue as string | undefined, pending, consume, resolvedUri!);
          const tombstoneRevision = validatePendingCaptureUuid(this.randomId());
          if (pending.kind !== 'valid' || tombstoneRevision === pending.revision) throw new Error('Pending recording revision could not be advanced.');
          store.put(serializePendingCaptureSlot({ version: 1, revision: tombstoneRevision, consumedCaptureId: capture.id }), PENDING_CAPTURE_STORAGE_KEY);
        }
        store.put(raw, STORAGE_KEY);
        store.put({ schemaVersion: 1 }, SCHEMA_KEY);
        store.put({ bytes }, SIZE_KEY);
        store.put(generation, GENERATION_KEY);
      });
      if (!this.generationBaseline) this.originGeneration = undefined;
      this.currentGeneration = generation;
      this.generationBaseline = true;
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      this.assertActive();
      const generation = validateRecoveryId(this.randomId(), 'Storage generation');
      await this.withTransaction('readwrite', async (store) => {
        const [currentGeneration, snapshotKey] = await Promise.all([requestResult(store.get(GENERATION_KEY)), requestResult(store.getKey(STORAGE_KEY))]);
        const generationValue = cleanGeneration(currentGeneration);
        const normalizedCurrent = generationValue === 'legacy' ? undefined : generationValue;
        if (this.generationBaseline) {
          if (normalizedCurrent !== this.currentGeneration) throw new Error('Saved data changed in another workspace. Reload before clearing.');
        } else if (snapshotKey !== undefined || normalizedCurrent !== undefined) throw new Error('Load the current workspace before clearing.');
        const pending = await readPendingCapture(store);
        if (pending.kind !== 'empty') throw new Error('Discard the pending recording before clearing the workspace.');
        store.delete(STORAGE_KEY);
        store.delete(SIZE_KEY);
        store.put({ schemaVersion: 1 }, SCHEMA_KEY);
        store.put(generation, GENERATION_KEY);
      });
      if (!this.generationBaseline) this.originGeneration = undefined;
      this.currentGeneration = generation;
      this.generationBaseline = true;
    });
  }

  async assertCurrent(): Promise<void> {
    await this.enqueue(async () => {
      this.assertActive();
      if (!this.generationBaseline) throw new Error('The current workspace has not been loaded.');
      const generation = await this.withTransaction('readonly', (store) => requestResult(store.get(GENERATION_KEY)).then(cleanGeneration));
      const normalized = generation === 'legacy' ? undefined : generation;
      if (normalized !== this.currentGeneration) throw new Error('Saved data changed in another workspace. Reload before continuing.');
    });
  }
}

export const stateStore: StateStore = new IndexedDbStateStore();

/** Construct a new adapter after privacy cleanup terminally closes old handles. */
export function createPlatformStateStore(): StateStore {
  return new IndexedDbStateStore();
}

let stateDatabaseDeleteConfirmed = false;

/** Internal privacy-only hook. The IDB delete request remains pending while blocked so cleanup keeps its lock. */
export async function eraseStateDatabaseForPrivacy(beforeMutation: () => Promise<void>): Promise<void> {
  await beforeMutation();
  stateDatabaseDeleteConfirmed = false;
  privacyDeletingAppStorage = true;
  closeBrowserDatabaseConnections(DB_NAME);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => { stateDatabaseDeleteConfirmed = true; appStorageLifecycleGeneration += 1; privacyDeletingAppStorage = false; resolve(); };
    request.onerror = () => reject(new Error('The local browser database could not be deleted.'));
    request.onblocked = () => { /* Keep awaiting the original request until it settles. */ };
  });
}

export function privacyStateDatabaseGone(): boolean {
  return stateDatabaseDeleteConfirmed;
}
