import type { AppState } from '../core';

export const STARTUP_RECOVERY_MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
export const STARTUP_RECOVERY_MAX_ARCHIVES = 8;
export const STARTUP_RECOVERY_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const STARTUP_RECOVERY_SESSION_MS = 5 * 60 * 1000;

export type StartupRecoveryReceipt = Readonly<{
  operationId: string;
  archiveId: string;
  archivedAt: string;
  evidenceBytes: number;
  alreadyCommitted: boolean;
}>;

export type StartupRecoveryInspection = Readonly<{
  status: 'available' | 'empty' | 'too_large' | 'newer_version' | 'archive_full';
  evidenceBytes: number;
  archiveCount: number;
  pendingReceipt?: StartupRecoveryReceipt;
}>;

export type StartupRecoveryPlan = Readonly<{
  operation: 'archive_and_start_fresh';
  sessionId: string;
  planHash: string;
  expiresAt: string;
  evidenceBytes: number;
  archiveCount: number;
}>;

export type StartupRecoveryCommitInput = Readonly<{ sessionId: string; planHash: string }>;

export interface StartupRecoveryBackend {
  inspect(): Promise<StartupRecoveryInspection>;
  prepare(): Promise<StartupRecoveryPlan>;
  commit(input: StartupRecoveryCommitInput, replacement: AppState): Promise<StartupRecoveryReceipt>;
  acknowledgeOpened(operationId: string): Promise<void>;
}

export type StartupRecoverySnapshot = Readonly<{ raw: string; schemaVersion: number; generation: string }>;

export interface StartupRecoveryArchiveRecord extends StartupRecoverySnapshot {
  archiveId: string;
  sessionId: string;
  archivedAt: string;
  evidenceBytes: number;
  sha256: string;
}

export interface StartupRecoveryReceiptRecord {
  sessionId: string;
  planHash: string;
  sourceGeneration: string;
  sourceSha256: string;
  replacementGeneration: string;
  replacementSha256: string;
  receipt: StartupRecoveryReceipt;
  opened: boolean;
}

export type StartupRecoverySnapshotMetadata = Readonly<{ schemaVersion: number; generation: string; evidenceBytes: number }>;

export interface StartupRecoveryTransaction {
  readSnapshotMetadata(): Promise<StartupRecoverySnapshotMetadata | undefined>;
  readSnapshot(maxBytes: number): Promise<StartupRecoverySnapshot | undefined>;
  readGeneration(): Promise<string | undefined>;
  readArchiveMetadata(): Promise<{ evidenceBytes: number }[]>;
  readPendingReceipt(): Promise<StartupRecoveryReceiptRecord | undefined>;
  findReceipt(sessionId: string, planHash: string): Promise<StartupRecoveryReceiptRecord | undefined>;
  findReceiptByOperationId(operationId: string): Promise<StartupRecoveryReceiptRecord | undefined>;
  writeSnapshot(raw: string, schemaVersion: number): Promise<void>;
  writeGeneration(generation: string): Promise<void>;
  insertArchive(record: StartupRecoveryArchiveRecord): Promise<void>;
  insertReceipt(record: StartupRecoveryReceiptRecord): Promise<void>;
  markReceiptOpened(operationId: string): Promise<void>;
}

export interface StartupRecoveryPersistence {
  withTransaction<T>(work: (transaction: StartupRecoveryTransaction) => Promise<T>): Promise<T>;
}

export interface StartupRecoveryFactoryOptions {
  persistence: StartupRecoveryPersistence;
  now?: () => number;
  randomId?: () => string;
  sha256?: (value: string) => Promise<string>;
  /** A successful load establishes origin; own writes may advance current before receipt acknowledgement. */
  getOpenedGeneration?: (currentGeneration: string | undefined) => Promise<{ originGeneration: string | undefined; currentGeneration: string | undefined } | undefined>;
}

const CURRENT_SNAPSHOT_SCHEMA = 1;

type SettledReadTuple<T extends readonly (() => Promise<unknown>)[]> = {
  [K in keyof T]: T[K] extends () => Promise<infer R> ? Awaited<R> : never;
};

/** Start every bounded read, then keep its transaction open until every read settles. */
async function settledReadTuple<T extends readonly (() => Promise<unknown>)[]>(...readers: T): Promise<SettledReadTuple<T>> {
  const pending = readers.map((read) => {
    try { return Promise.resolve(read()); }
    catch (error) { return Promise.reject(error); }
  });
  const results = await Promise.allSettled(pending);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as SettledReadTuple<T>;
}

/**
 * Create a process-local confirmation session over an atomic persistent adapter.
 * Raw snapshots and their digests remain private to this helper and its adapter.
 */
export function createStartupRecoveryBackend(options: StartupRecoveryFactoryOptions): StartupRecoveryBackend {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => globalThis.crypto.randomUUID());
  const sha256 = options.sha256 ?? (async (raw: string) => {
    const bytes = new TextEncoder().encode(raw);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  });
  let active: { plan: StartupRecoveryPlan; snapshot: StartupRecoverySnapshot; digest: string } | undefined;
  let preparationQueue: Promise<void> = Promise.resolve();
  const serializePrepare = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = preparationQueue;
    let finish!: () => void;
    preparationQueue = new Promise<void>((resolve) => { finish = resolve; });
    await previous;
    try { return await work(); } finally { finish(); }
  };
  const readInspection = async (): Promise<{ public: StartupRecoveryInspection; metadata?: StartupRecoverySnapshotMetadata }> => options.persistence.withTransaction(async (tx) => {
    const [metadata, archives, pending] = await settledReadTuple(
      () => tx.readSnapshotMetadata(), () => tx.readArchiveMetadata(), () => tx.readPendingReceipt(),
    );
    const archiveCount = archives.length;
    const archiveBytes = archives.reduce((total, item) => total + item.evidenceBytes, 0);
    const evidenceBytes = metadata?.evidenceBytes ?? 0;
    const pendingReceipt = pending && !pending.opened ? validateRecoveryReceipt({ ...pending.receipt, alreadyCommitted: true }) : undefined;
    let status: StartupRecoveryInspection['status'];
    if (!metadata) status = 'empty';
    else if (metadata.schemaVersion > CURRENT_SNAPSHOT_SCHEMA) status = 'newer_version';
    else if (evidenceBytes > STARTUP_RECOVERY_MAX_EVIDENCE_BYTES) status = 'too_large';
    else if (archiveCount >= STARTUP_RECOVERY_MAX_ARCHIVES || archiveBytes + evidenceBytes > STARTUP_RECOVERY_MAX_ARCHIVE_BYTES) status = 'archive_full';
    else status = 'available';
    return { public: Object.freeze({ status, evidenceBytes, archiveCount, ...(pendingReceipt ? { pendingReceipt } : {}) }), metadata };
  });
  return {
    async inspect() { return (await readInspection()).public; },
    async prepare() {
      return serializePrepare(async () => {
        const instant = now();
        // Every explicit prepare rebinds the plan to the current snapshot and invalidates older plans.
        active = undefined;
        const inspection = await readInspection();
        if (inspection.public.pendingReceipt) throw new Error('Open the previously recovered fresh workspace before preparing another recovery.');
        if (inspection.public.status !== 'available') throw new Error('Saved data is not eligible for recovery right now.');
        if (!inspection.metadata) throw new Error('Saved data is not eligible for recovery right now.');
        const snapshot = await options.persistence.withTransaction(async (tx) => {
          const metadata = await tx.readSnapshotMetadata();
          const [pending, archives] = await settledReadTuple(() => tx.readPendingReceipt(), () => tx.readArchiveMetadata());
          if (pending || archives.length !== inspection.public.archiveCount || !sameMetadata(inspection.metadata, metadata)) throw new Error('Saved data changed while recovery was being prepared. Inspect and prepare again.');
          if (!metadata || metadata.evidenceBytes > STARTUP_RECOVERY_MAX_EVIDENCE_BYTES) throw new Error('Saved data is not eligible for recovery right now.');
          const row = await tx.readSnapshot(STARTUP_RECOVERY_MAX_EVIDENCE_BYTES);
          if (!row || row.schemaVersion !== metadata.schemaVersion || row.generation !== metadata.generation || recoveryUtf8Bytes(row.raw, STARTUP_RECOVERY_MAX_EVIDENCE_BYTES) !== metadata.evidenceBytes) throw new Error('Saved data changed while recovery was being prepared. Inspect and prepare again.');
          return row;
        });
        const digest = await sha256(snapshot.raw);
        if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error('Saved data could not be secured for recovery.');
        const sessionId = validateRecoveryId(randomId(), 'Recovery session');
        const planHash = validateRecoveryId(randomId(), 'Recovery plan');
        const expiresAt = new Date(instant + STARTUP_RECOVERY_SESSION_MS).toISOString();
        const plan = Object.freeze({ operation: 'archive_and_start_fresh' as const, sessionId, planHash, expiresAt, evidenceBytes: inspection.public.evidenceBytes, archiveCount: inspection.public.archiveCount });
        // Recheck the private CAS material after the asynchronous digest before exposing a plan.
        const current = await options.persistence.withTransaction(async (tx) => {
          const [metadata, snapshot, generation, archives, pending] = await settledReadTuple(
            () => tx.readSnapshotMetadata(), () => tx.readSnapshot(STARTUP_RECOVERY_MAX_EVIDENCE_BYTES), () => tx.readGeneration(),
            () => tx.readArchiveMetadata(), () => tx.readPendingReceipt(),
          );
          return { metadata, snapshot, generation, archiveCount: archives.length, pending };
        });
        if (current.pending || current.archiveCount !== inspection.public.archiveCount || !sameMetadata(inspection.metadata, current.metadata) || !sameSnapshot(snapshot, current.snapshot, current.generation)) throw new Error('Saved data changed while recovery was being prepared. Inspect and prepare again.');
        active = { plan, snapshot, digest: digest.toLowerCase() };
        return plan;
      });
    },
    async commit(input, replacement) {
      const sessionId = validateRecoveryId(input?.sessionId, 'Recovery session');
      const planHash = validateRecoveryId(input?.planHash, 'Recovery plan');
      const prior = await options.persistence.withTransaction((tx) => tx.findReceipt(sessionId, planHash));
      if (prior) return Object.freeze({ ...prior.receipt, alreadyCommitted: true });
      const replacementRaw = validateReplacementSnapshot(replacement);
      const replacementGeneration = validateRecoveryId(randomId(), 'Storage generation');
      const replacementDigest = (await sha256(replacementRaw)).toLowerCase();
      if (!/^[a-f0-9]{64}$/i.test(replacementDigest)) throw new Error('Fresh app data could not be secured for recovery.');
      const result = await options.persistence.withTransaction(async (tx) => {
        const previous = await tx.findReceipt(sessionId, planHash);
        if (previous) return { receipt: Object.freeze({ ...previous.receipt, alreadyCommitted: true }), duplicate: true };
        const session = active;
        if (!session || session.plan.sessionId !== sessionId || session.plan.planHash !== planHash) throw new Error('Recovery confirmation is unavailable. Prepare a fresh recovery plan.');
        if (Date.parse(session.plan.expiresAt) <= now()) throw new Error('Recovery confirmation expired. Prepare a fresh recovery plan.');
        const [metadata, generation, archives, pending] = await settledReadTuple(
          () => tx.readSnapshotMetadata(), () => tx.readGeneration(), () => tx.readArchiveMetadata(), () => tx.readPendingReceipt(),
        );
        if (pending) throw new Error('A recovered workspace must be opened before another recovery can commit.');
        if (!metadata || metadata.evidenceBytes > STARTUP_RECOVERY_MAX_EVIDENCE_BYTES) throw new Error('Saved data is no longer eligible for recovery. Nothing was replaced.');
        if (!sameMetadata({ schemaVersion: session.snapshot.schemaVersion, generation: session.snapshot.generation, evidenceBytes: session.plan.evidenceBytes }, metadata) || archives.length !== session.plan.archiveCount) throw new Error('Saved data changed after recovery confirmation. Nothing was replaced.');
        const snapshot = await tx.readSnapshot(STARTUP_RECOVERY_MAX_EVIDENCE_BYTES);
        if (!sameSnapshot(session.snapshot, snapshot, generation)) throw new Error('Saved data changed after recovery confirmation. Nothing was replaced.');
        const evidenceBytes = metadata.evidenceBytes;
        if (evidenceBytes !== session.plan.evidenceBytes || evidenceBytes !== recoveryUtf8Bytes(snapshot!.raw, STARTUP_RECOVERY_MAX_EVIDENCE_BYTES)) throw new Error('Saved data changed after recovery confirmation. Nothing was replaced.');
        const archiveBytes = archives.reduce((total, item) => total + item.evidenceBytes, 0);
        if (snapshot!.schemaVersion > CURRENT_SNAPSHOT_SCHEMA) throw new Error('Saved data is from a newer app version.');
        if (evidenceBytes > STARTUP_RECOVERY_MAX_EVIDENCE_BYTES || archives.length >= STARTUP_RECOVERY_MAX_ARCHIVES || archiveBytes + evidenceBytes > STARTUP_RECOVERY_MAX_ARCHIVE_BYTES) throw new Error('The recovery archive limit has been reached. Nothing was replaced.');
        const archivedAt = new Date(now()).toISOString();
        const archiveId = validateRecoveryId(randomId(), 'Recovery archive');
        const operationId = sessionId;
        const receipt = Object.freeze({ operationId, archiveId, archivedAt, evidenceBytes, alreadyCommitted: false });
        await tx.insertArchive({ archiveId, sessionId, raw: snapshot!.raw, schemaVersion: snapshot!.schemaVersion, generation: generation ?? 'legacy', archivedAt, evidenceBytes, sha256: session.digest });
        await tx.insertReceipt({ sessionId, planHash, sourceGeneration: snapshot!.generation, sourceSha256: session.digest, replacementGeneration, replacementSha256: replacementDigest, receipt: Object.freeze({ ...receipt, alreadyCommitted: true }), opened: false });
        await tx.writeSnapshot(replacementRaw, CURRENT_SNAPSHOT_SCHEMA);
        await tx.writeGeneration(replacementGeneration);
        return { receipt, duplicate: false };
      });
      if (!result.duplicate && active?.plan.sessionId === sessionId) active = undefined;
      return result.receipt;
    },
    async acknowledgeOpened(operationIdInput) {
      const operationId = validateRecoveryId(operationIdInput, 'Recovery operation');
      await options.persistence.withTransaction(async (tx) => {
        const record = await tx.findReceiptByOperationId(operationId);
        if (!record) throw new Error('Recovery receipt was not found.');
        const currentGeneration = await tx.readGeneration();
        const ownership = await options.getOpenedGeneration?.(currentGeneration);
        let openedGeneration: string | undefined;
        try { openedGeneration = ownership?.originGeneration === undefined ? undefined : validateRecoveryId(ownership.originGeneration, 'Opened storage generation'); }
        catch { openedGeneration = undefined; }
        if (!ownership || !openedGeneration || ownership.currentGeneration !== currentGeneration) throw new Error('This workspace no longer owns the recovered data. Reload the current workspace before acknowledging it.');
        await tx.markReceiptOpened(operationId);
      });
    },
  };
}

function sameMetadata(expected: StartupRecoverySnapshotMetadata | undefined, actual: StartupRecoverySnapshotMetadata | undefined): boolean {
  return Boolean(expected && actual && expected.schemaVersion === actual.schemaVersion && expected.generation === actual.generation && expected.evidenceBytes === actual.evidenceBytes);
}

function sameSnapshot(expected: StartupRecoverySnapshot, current: StartupRecoverySnapshot | undefined, generation: string | undefined): boolean {
  return Boolean(current && current.raw === expected.raw && current.schemaVersion === expected.schemaVersion && current.generation === expected.generation && (generation ?? expected.generation) === expected.generation);
}

export function recoveryUtf8Bytes(value: string, maxBytes = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1; }
    else bytes += 3;
    if (bytes > maxBytes) return maxBytes + 1;
  }
  return bytes;
}

export function validateRecoveryId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${label} is invalid.`);
  return value.toLowerCase();
}

export function validateRecoveryIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid.`);
  return value;
}

export function validateRecoveryReceipt(value: unknown): StartupRecoveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recovery receipt is invalid.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['operationId', 'archiveId', 'archivedAt', 'evidenceBytes', 'alreadyCommitted'].includes(key))) throw new Error('Recovery receipt contains unsupported fields.');
  const operationId = validateRecoveryId(row.operationId, 'Recovery operation');
  const archiveId = validateRecoveryId(row.archiveId, 'Recovery archive');
  const archivedAt = validateRecoveryIso(row.archivedAt, 'Recovery receipt time');
  if (!Number.isSafeInteger(row.evidenceBytes) || (row.evidenceBytes as number) < 0 || typeof row.alreadyCommitted !== 'boolean') throw new Error('Recovery receipt is invalid.');
  return Object.freeze({ operationId, archiveId, archivedAt, evidenceBytes: row.evidenceBytes as number, alreadyCommitted: row.alreadyCommitted });
}

export function validateRecoveryReceiptRecord(value: unknown): StartupRecoveryReceiptRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recovery journal is unavailable.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['sessionId', 'planHash', 'sourceGeneration', 'sourceSha256', 'replacementGeneration', 'replacementSha256', 'receipt', 'opened'].includes(key))) throw new Error('Recovery journal is unavailable.');
  try {
    const sessionId = validateRecoveryId(row.sessionId, 'Recovery session');
    const planHash = validateRecoveryId(row.planHash, 'Recovery plan');
    const sourceGeneration = row.sourceGeneration === 'legacy' ? 'legacy' : validateRecoveryId(row.sourceGeneration, 'Source generation');
    const replacementGeneration = validateRecoveryId(row.replacementGeneration, 'Replacement generation');
    const sourceSha256 = cleanHash(row.sourceSha256);
    const replacementSha256 = cleanHash(row.replacementSha256);
    const receipt = validateRecoveryReceipt(row.receipt);
    if (typeof row.opened !== 'boolean' || receipt.evidenceBytes > STARTUP_RECOVERY_MAX_EVIDENCE_BYTES || receipt.operationId !== sessionId) throw new Error('bad receipt');
    return Object.freeze({ sessionId, planHash, sourceGeneration, sourceSha256, replacementGeneration, replacementSha256, receipt, opened: row.opened });
  } catch { throw new Error('Recovery journal is unavailable.'); }
}

function cleanHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('Invalid recovery digest.');
  return value.toLowerCase();
}

export function validateReplacementSnapshot(state: AppState): string {
  const raw = JSON.stringify(state);
  const bytes = recoveryUtf8Bytes(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > STARTUP_RECOVERY_MAX_EVIDENCE_BYTES) throw new Error('Fresh app data exceeds the local storage recovery limit.');
  return raw;
}
