import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, fsyncSync, closeSync } from 'node:fs';
import { open, lstat, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import { ensurePrivateDirectory } from './config.js';
import { AudioVerificationError, verifyPrivateAudioFile, type PrivateAudioFormat } from './audioVerification.js';

const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const AUDIO_SCHEMA_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const MIME: Readonly<Record<PrivateAudioFormat, string>> = Object.freeze({
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg',
});
const activeAudioOperations = new Set<string>();
const audioWaiters = new Map<string, Set<() => void>>();
let currentHostProcessId: string | undefined;

export type PrivateAudioStatus = 'receiving' | 'verified' | 'ready' | 'deletion_pending' | 'unavailable';
export type PrivateAudioRecord = Readonly<{
  uploadId: string; mediaId: string; status: PrivateAudioStatus; fileName: string; format: PrivateAudioFormat;
  mimeType: string; byteLength?: number; sha256?: string; durationSeconds?: number;
}>;
export type AttachedAudioReference = Readonly<{ mediaId: string; noteId: string; noteRevision: number; sha256?: string; byteLength?: number }>;
export type AudioRangeResponse = Readonly<{
  status: 200 | 206 | 416;
  headers: Readonly<Record<string, string>>;
  body?: Readable;
}>;

export interface PrivateAudioRepositoryOptions {
  readonly kernel: DurableKernel;
  /** Long-lived private actor session owned by trusted server composition. */
  readonly actorSessionToken: string;
  /** Absolute root outside the static/public tree. */
  readonly privateRoot: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  /** Host-wide fresh UUIDv4 shared across every workspace repository in this process. */
  readonly processId: string;
  readonly now?: () => number;
  /** Test seam for a crash after durable rename but before ready metadata commit. */
  readonly afterRenameBeforeReady?: () => void;
  /** Trusted test seams for failures between opening a reader and returning its stream. */
  readonly createReaderStream?: (handle: FileHandle, options: { start: number; end: number; highWaterMark: number }) => Readable;
  readonly closeReaderHandle?: (handle: FileHandle) => Promise<void>;
  /** Trusted app-state resolver. It must return the currently attached exact media reference. */
  readonly resolveAttachedMedia: (input: { workspaceId: string; ownerId: string; privacyEpoch: number; noteId: string; noteRevision: number }) => AttachedAudioReference | undefined;
}

interface AudioRow {
  upload_id: string; media_id: string; workspace_id: string; owner_id: string; privacy_epoch: number; status: PrivateAudioStatus;
  temp_name: string; final_name: string; file_name: string; format: PrivateAudioFormat; mime_type: string;
  expected_bytes: number | null; sha256: string | null; byte_length: number | null; duration_seconds: number | null; process_id: string;
}
interface SpeechLeaseRow {
  lease_id: string; upload_id: string; media_id: string; workspace_id: string; owner_id: string; privacy_epoch: number;
  note_id: string; note_revision: number; sha256: string; byte_length: number; duration_seconds: number; process_id: string;
}
interface ReaderCleanup {
  readonly readerId: string;
  readonly mediaId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly processId: string;
  fileClosed: boolean;
  acknowledged: boolean;
  retryRequired: boolean;
  fileHandle?: FileHandle;
  closeOperation?: Promise<void>;
  operation?: Promise<void>;
}

function safeFileName(value: unknown): { fileName: string; format: PrivateAudioFormat } {
  if (typeof value !== 'string' || value.length < 5 || value.length > 128 || /[\\/\0\r\n]/.test(value) || value === '.' || value === '..') {
    throw new Error('audio_invalid');
  }
  const format = value.slice(value.lastIndexOf('.') + 1).toLowerCase();
  if (!['m4a', 'mp3', 'wav', 'webm', 'ogg'].includes(format)) throw new Error('unsupported_format');
  return { fileName: `recording.${format}`, format: format as PrivateAudioFormat };
}
function requireUuid(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label}_invalid`); }
function requireOpaqueNoteId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1024) throw new Error('note_id_invalid');
}
function asSafeRecord(row: AudioRow): PrivateAudioRecord {
  return Object.freeze({ uploadId: row.upload_id, mediaId: row.media_id, status: row.status, fileName: row.file_name, format: row.format,
    mimeType: row.mime_type, ...(row.byte_length === null ? {} : { byteLength: row.byte_length }),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }), ...(row.duration_seconds === null ? {} : { durationSeconds: row.duration_seconds }) });
}
function syncDirectory(path: string): void {
  let handle;
  try { handle = openSync(path, constants.O_RDONLY); fsyncSync(handle); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(String(code))) throw error;
  }
  finally { if (handle !== undefined) closeSync(handle); }
}
function pathInside(root: string, name: string): string {
  if (!/^[0-9a-f-]{36}\.(?:part|audio)$/i.test(name)) throw new Error('audio_path_invalid');
  const path = resolve(root, name);
  if (dirname(path) !== root) throw new Error('audio_path_invalid');
  return path;
}
function expectedMime(format: PrivateAudioFormat): string { return MIME[format]; }

export class PrivateAudioRepository {
  readonly #kernel: DurableKernel;
  readonly #actorToken: string;
  readonly #root: string;
  readonly #ffmpegPath: string | undefined;
  readonly #ffprobePath: string | undefined;
  readonly #processId: string;
  readonly #now: () => number;
  readonly #afterRename: (() => void) | undefined;
  readonly #createReaderStream: PrivateAudioRepositoryOptions['createReaderStream'];
  readonly #closeReaderHandle: NonNullable<PrivateAudioRepositoryOptions['closeReaderHandle']>;
  readonly #resolveAttached: PrivateAudioRepositoryOptions['resolveAttachedMedia'];
  readonly #identity: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>;
  readonly #readerCleanups = new Map<string, ReaderCleanup>();

  constructor(options: PrivateAudioRepositoryOptions) {
    if (!isAbsolute(options.privateRoot) || options.privateRoot.includes('\0')) throw new Error('audio_root_invalid');
    this.#kernel = options.kernel;
    this.#actorToken = options.actorSessionToken;
    const identity = options.kernel.getOwnedIdentity(options.actorSessionToken);
    this.#identity = Object.freeze({ workspaceId: identity.workspaceId, ownerId: identity.ownerId, privacyEpoch: identity.privacyEpoch });
    this.#root = resolve(options.privateRoot, identity.workspaceId);
    this.#ffmpegPath = options.ffmpegPath;
    this.#ffprobePath = options.ffprobePath;
    this.#processId = options.processId;
    requireUuid(this.#processId, 'process_id');
    if (currentHostProcessId && currentHostProcessId !== this.#processId) throw new Error('audio_process_id_mismatch');
    currentHostProcessId = this.#processId;
    this.#now = options.now ?? Date.now;
    this.#afterRename = options.afterRenameBeforeReady;
    this.#createReaderStream = options.createReaderStream;
    this.#closeReaderHandle = options.closeReaderHandle ?? ((handle) => handle.close());
    this.#resolveAttached = options.resolveAttachedMedia;
    ensurePrivateDirectory(resolve(options.privateRoot));
    ensurePrivateDirectory(this.#root);
    this.#kernel.withTrustedDatabaseTransaction((db) => {
      const marker = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_audio_schema'").get();
      const knownTables = ['private_audio_uploads', 'private_audio_speech_leases', 'private_audio_readers'];
      if (!marker) {
        const existing = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${knownTables.map(() => '?').join(',')})`)
          .all(...knownTables) as { name: string }[];
        if (existing.length) throw new Error('audio_schema_unversioned');
        db.exec(`CREATE TABLE private_audio_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL) STRICT;
        INSERT INTO private_audio_schema (singleton,version) VALUES (1,${AUDIO_SCHEMA_VERSION});
        CREATE TABLE private_audio_uploads (
        upload_id TEXT PRIMARY KEY, media_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch >= 0), status TEXT NOT NULL CHECK(status IN ('receiving','verified','ready','deletion_pending','unavailable')),
        temp_name TEXT NOT NULL, final_name TEXT NOT NULL, file_name TEXT NOT NULL, format TEXT NOT NULL,
        mime_type TEXT NOT NULL, expected_bytes INTEGER, sha256 TEXT, byte_length INTEGER, duration_seconds REAL, process_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE private_audio_speech_leases (
        lease_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, media_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        privacy_epoch INTEGER NOT NULL, note_id TEXT NOT NULL, note_revision INTEGER NOT NULL,
        sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, duration_seconds REAL NOT NULL, process_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY(upload_id) REFERENCES private_audio_uploads(upload_id)
      ) STRICT;
      CREATE TABLE private_audio_readers (
        reader_id TEXT PRIMARY KEY, media_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        privacy_epoch INTEGER NOT NULL, process_id TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS private_audio_reader_media ON private_audio_readers(media_id);`);
      } else {
        const markerColumns = db.pragma('table_info(private_audio_schema)') as { name: string; type: string }[];
        if (markerColumns.length !== 2 || markerColumns[0]?.name !== 'singleton' || markerColumns[0]?.type !== 'INTEGER' ||
          markerColumns[1]?.name !== 'version' || markerColumns[1]?.type !== 'INTEGER') throw new Error('audio_schema_invalid');
        const versions = db.prepare('SELECT singleton,version FROM private_audio_schema').all() as { singleton: number; version: number }[];
        if (versions.length !== 1 || versions[0]?.singleton !== 1 || versions[0]?.version !== AUDIO_SCHEMA_VERSION) throw new Error('audio_schema_unsupported');
      }
      const expectedColumns: Record<string, readonly { name: string; type: string; notnull: number; pk: number }[]> = {
        private_audio_schema: [{ name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 }, { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 }],
        private_audio_uploads: [
          ['upload_id', 'TEXT', 1, 1], ['media_id', 'TEXT', 1, 0], ['workspace_id', 'TEXT', 1, 0], ['owner_id', 'TEXT', 1, 0],
          ['privacy_epoch', 'INTEGER', 1, 0], ['status', 'TEXT', 1, 0], ['temp_name', 'TEXT', 1, 0], ['final_name', 'TEXT', 1, 0],
          ['file_name', 'TEXT', 1, 0], ['format', 'TEXT', 1, 0], ['mime_type', 'TEXT', 1, 0], ['expected_bytes', 'INTEGER', 0, 0],
          ['sha256', 'TEXT', 0, 0], ['byte_length', 'INTEGER', 0, 0], ['duration_seconds', 'REAL', 0, 0], ['process_id', 'TEXT', 1, 0],
          ['created_at', 'INTEGER', 1, 0], ['updated_at', 'INTEGER', 1, 0],
        ].map(([name, type, notnull, pk]) => ({ name: String(name), type: String(type), notnull: Number(notnull), pk: Number(pk) })),
        private_audio_speech_leases: [
          ['lease_id', 'TEXT', 1, 1], ['upload_id', 'TEXT', 1, 0], ['media_id', 'TEXT', 1, 0], ['workspace_id', 'TEXT', 1, 0],
          ['owner_id', 'TEXT', 1, 0], ['privacy_epoch', 'INTEGER', 1, 0], ['note_id', 'TEXT', 1, 0], ['note_revision', 'INTEGER', 1, 0],
          ['sha256', 'TEXT', 1, 0], ['byte_length', 'INTEGER', 1, 0], ['duration_seconds', 'REAL', 1, 0], ['process_id', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0],
        ].map(([name, type, notnull, pk]) => ({ name: String(name), type: String(type), notnull: Number(notnull), pk: Number(pk) })),
        private_audio_readers: [
          ['reader_id', 'TEXT', 1, 1], ['media_id', 'TEXT', 1, 0], ['workspace_id', 'TEXT', 1, 0], ['owner_id', 'TEXT', 1, 0],
          ['privacy_epoch', 'INTEGER', 1, 0], ['process_id', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0],
        ].map(([name, type, notnull, pk]) => ({ name: String(name), type: String(type), notnull: Number(notnull), pk: Number(pk) })),
      };
      for (const [table, expected] of Object.entries(expectedColumns)) {
        const columns = db.pragma(`table_info(${table})`) as { name: string; type: string; notnull: number; pk: number }[];
        if (columns.length !== expected.length || columns.some((column, index) => {
          const target = expected[index]!;
          return column.name !== target.name || column.type.toUpperCase() !== target.type || column.notnull !== target.notnull || column.pk !== target.pk;
        })) throw new Error(`audio_schema_invalid:${table}`);
        const listed = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table) as { strict: number } | undefined;
        if (!listed || listed.strict !== 1) throw new Error('audio_schema_invalid');
      }
    });
  }

  #owned<T>(operation: (context: OwnedTransactionContext) => T): T {
    return this.#kernel.withOwnedTransaction(this.#actorToken, this.#identity.privacyEpoch, (context) => {
      if (context.workspaceId !== this.#identity.workspaceId || context.ownerId !== this.#identity.ownerId) throw new Error('audio_owner_changed');
      return operation(context);
    });
  }
  #trustedDb<T>(operation: (db: import('better-sqlite3').Database) => T): T {
    return this.#kernel.withTrustedDatabaseTransaction(operation);
  }
  #resourceKey(mediaId: string): string { return `${this.#root}:${this.#identity.workspaceId}:${this.#identity.ownerId}:${this.#identity.privacyEpoch}:${mediaId}`; }
  #isActive(mediaId: string): boolean { return activeAudioOperations.has(this.#resourceKey(mediaId)); }
  #setActive(mediaId: string, active: boolean): void {
    const key = this.#resourceKey(mediaId);
    if (active) activeAudioOperations.add(key); else activeAudioOperations.delete(key);
    if (!active) this.#notifyMedia(mediaId);
  }
  #notifyMedia(mediaId: string): void {
    const key = this.#resourceKey(mediaId);
    const waiters = audioWaiters.get(key);
    if (!waiters) return;
    audioWaiters.delete(key);
    for (const wake of waiters) wake();
  }
  async #waitForMediaIdle(mediaId: string): Promise<void> {
    const key = this.#resourceKey(mediaId);
    while (true) {
      const hasHolders = this.#trustedDb((db) => {
        const leases = db.prepare('SELECT count(*) AS count FROM private_audio_speech_leases WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
          .get(mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as { count: number };
        const readers = db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
          .get(mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as { count: number };
        return leases.count > 0 || readers.count > 0;
      });
      if (!hasHolders) return;
      await new Promise<void>((resolveWake) => {
        const waiters = audioWaiters.get(key) ?? new Set<() => void>();
        let finished = false;
        const timer = setTimeout(wake, 100);
        function wake() {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          waiters.delete(wake);
          if (waiters.size === 0) audioWaiters.delete(key);
          resolveWake();
        }
        waiters.add(wake); audioWaiters.set(key, waiters);
        // Recheck after subscribing so a concurrent release cannot be missed.
        const stillHeld = this.#trustedDb((db) => {
          const leases = db.prepare('SELECT count(*) AS count FROM private_audio_speech_leases WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
            .get(mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as { count: number };
          const readers = db.prepare('SELECT count(*) AS count FROM private_audio_readers WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
            .get(mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as { count: number };
          return leases.count > 0 || readers.count > 0;
        });
        if (!stillHeld) wake();
      });
    }
  }
  #directory(): string { return this.#root; }
  #safePath(name: string): string { return pathInside(this.#directory(), name); }
  #rowByMedia(context: OwnedTransactionContext, mediaId: string): AudioRow | undefined {
    return context.db.prepare('SELECT * FROM private_audio_uploads WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
      .get(mediaId, context.workspaceId, context.ownerId, context.privacyEpoch) as AudioRow | undefined;
  }
  #record(context: OwnedTransactionContext, mediaId: string, expectedStatuses?: readonly PrivateAudioStatus[]): AudioRow {
    const row = this.#rowByMedia(context, mediaId);
    if (!row || (expectedStatuses && !expectedStatuses.includes(row.status))) throw new Error('audio_unavailable');
    return row;
  }

  async ingest(source: AsyncIterable<Uint8Array>, input: { fileName: string; mimeType: string; expectedByteLength?: number; expectedSha256?: string }): Promise<PrivateAudioRecord> {
    const { fileName, format } = safeFileName(input.fileName);
    if (input.mimeType !== expectedMime(format)) throw new Error('unsupported_format');
    if (input.expectedByteLength !== undefined && (!Number.isSafeInteger(input.expectedByteLength) || input.expectedByteLength <= 0 || input.expectedByteLength > MAX_AUDIO_BYTES)) throw new Error('audio_size_invalid');
    if (input.expectedSha256 !== undefined && !SHA256.test(input.expectedSha256)) throw new Error('audio_hash_invalid');
    const uploadId = randomUUID(), mediaId = randomUUID();
    const tempName = `${uploadId}.part`, finalName = `${uploadId}.audio`;
    const tempPath = this.#safePath(tempName), finalPath = this.#safePath(finalName);
    this.#setActive(mediaId, true);
    try {
      this.#owned((context) => {
        context.db.prepare(`INSERT INTO private_audio_uploads (upload_id,media_id,workspace_id,owner_id,privacy_epoch,status,temp_name,final_name,file_name,format,mime_type,expected_bytes,sha256,byte_length,duration_seconds,process_id,created_at,updated_at)
          VALUES (?,?,?,?,?,'receiving',?,?,?,?,?,?,NULL,NULL,NULL,?,?,?)`).run(uploadId, mediaId, context.workspaceId, context.ownerId, context.privacyEpoch,
          tempName, finalName, fileName, format, input.mimeType, input.expectedByteLength ?? null, this.#processId, this.#now(), this.#now());
      });
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
      let file;
      try {
        file = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
        const hash = createHash('sha256');
        let byteLength = 0;
        for await (const part of source) {
          if (!(part instanceof Uint8Array) || part.byteLength === 0) continue;
          byteLength += part.byteLength;
          if (byteLength > MAX_AUDIO_BYTES) throw new Error('audio_size_limit');
          hash.update(part);
          let offset = 0;
          while (offset < part.byteLength) {
            const result = await file.write(part, offset, part.byteLength - offset);
            if (result.bytesWritten <= 0) throw new Error('audio_write_failed');
            offset += result.bytesWritten;
          }
        }
        if (byteLength <= 0 || (input.expectedByteLength !== undefined && input.expectedByteLength !== byteLength)) throw new Error('audio_size_mismatch');
        const sha256 = hash.digest('hex');
        if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) throw new Error('audio_hash_mismatch');
        await file.sync();
        await file.close(); file = undefined;
        const verified = await verifyPrivateAudioFile({ filePath: tempPath, fileName, mimeType: input.mimeType, expectedFormat: format,
          ...(this.#ffmpegPath ? { ffmpegPath: this.#ffmpegPath } : {}), ...(this.#ffprobePath ? { ffprobePath: this.#ffprobePath } : {}) });
        this.#owned((context) => {
          context.db.prepare(`UPDATE private_audio_uploads SET status='verified',sha256=?,byte_length=?,duration_seconds=?,updated_at=? WHERE upload_id=? AND status='receiving'`)
            .run(sha256, byteLength, verified.durationSeconds, this.#now(), uploadId);
        });
        await rename(tempPath, finalPath);
        syncDirectory(this.#directory());
        this.#afterRename?.();
        return this.#owned((context) => {
          context.db.prepare(`UPDATE private_audio_uploads SET status='ready',updated_at=? WHERE upload_id=? AND status='verified' AND workspace_id=? AND owner_id=? AND privacy_epoch=?`)
            .run(this.#now(), uploadId, context.workspaceId, context.ownerId, context.privacyEpoch);
          const row = context.db.prepare('SELECT * FROM private_audio_uploads WHERE upload_id=?').get(uploadId) as AudioRow;
          return asSafeRecord(row);
        });
      } catch (error) {
        await file?.close().catch(() => undefined);
        // Keep the durable row and any owned file for explicit reconciliation after uncertain I/O.
        if (!(error instanceof AudioVerificationError) || error.code !== 'codec_timeout') {
          try { await rm(tempPath, { force: true }); } catch { /* Reconciliation owns cleanup. */ }
        }
        throw error;
      }
    } finally { this.#setActive(mediaId, false); }
  }

  getRecord(mediaId: string): PrivateAudioRecord {
    requireUuid(mediaId, 'media_id');
    return this.#owned((context) => asSafeRecord(this.#record(context, mediaId)));
  }

  /** Old-process records are touched only after the host proves an exclusive restart. */
  async reconcile(options: { exclusiveRestartVerified?: boolean } = {}): Promise<readonly PrivateAudioRecord[]> {
    if (options.exclusiveRestartVerified) {
      this.#trustedDb((db) => {
        db.prepare('DELETE FROM private_audio_readers WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND process_id<>?')
          .run(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, this.#processId);
        db.prepare('DELETE FROM private_audio_speech_leases WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND process_id<>?')
          .run(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, this.#processId);
      });
    }
    const rows = this.#owned((context) => context.db.prepare('SELECT * FROM private_audio_uploads WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?')
      .all(context.workspaceId, context.ownerId, context.privacyEpoch) as AudioRow[]);
    const output: PrivateAudioRecord[] = [];
    for (const row of rows) {
      if (this.#isActive(row.media_id) || (row.process_id !== this.#processId && !options.exclusiveRestartVerified)) {
        output.push(asSafeRecord(row));
        continue;
      }
      const tempPath = this.#safePath(row.temp_name), finalPath = this.#safePath(row.final_name);
      if (row.status === 'receiving') {
        try {
          await rm(tempPath, { force: true });
          this.#owned((context) => context.db.prepare(`UPDATE private_audio_uploads SET status='unavailable',updated_at=? WHERE upload_id=? AND status='receiving'`).run(this.#now(), row.upload_id));
        } catch {
          this.#owned((context) => context.db.prepare(`UPDATE private_audio_uploads SET status='deletion_pending',updated_at=? WHERE upload_id=? AND status='receiving'`).run(this.#now(), row.upload_id));
          await this.#finishDelete(row.media_id);
        }
      } else if (row.status === 'verified') {
        let chosen: string | undefined;
        try { await lstat(finalPath); chosen = finalPath; } catch { try { await lstat(tempPath); chosen = tempPath; } catch { /* unavailable */ } }
        if (!chosen || !row.sha256 || !row.byte_length) {
          this.#owned((context) => context.db.prepare(`UPDATE private_audio_uploads SET status='unavailable',updated_at=? WHERE upload_id=?`).run(this.#now(), row.upload_id));
        } else {
          const actual = await this.#hashFile(chosen);
          if (actual.byteLength !== row.byte_length || actual.sha256 !== row.sha256) {
            this.#owned((context) => context.db.prepare(`UPDATE private_audio_uploads SET status='deletion_pending',updated_at=? WHERE upload_id=?`).run(this.#now(), row.upload_id));
            await this.#finishDelete(row.media_id);
          } else {
            if (chosen === tempPath) await rename(tempPath, finalPath);
            syncDirectory(this.#directory());
            this.#owned((context) => context.db.prepare(`UPDATE private_audio_uploads SET status='ready',updated_at=? WHERE upload_id=? AND status='verified'`).run(this.#now(), row.upload_id));
          }
        }
      } else if (row.status === 'ready') {
        try {
          const actual = await this.#hashFile(finalPath);
          if (actual.byteLength !== row.byte_length || actual.sha256 !== row.sha256) {
            this.#owned((context) => context.db.prepare(`UPDATE private_audio_uploads SET status='deletion_pending',updated_at=? WHERE upload_id=? AND status='ready'`).run(this.#now(), row.upload_id));
            await this.#finishDelete(row.media_id);
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'audio_file_unavailable') {
            this.#owned((context) => context.db.prepare(`UPDATE private_audio_uploads SET status='unavailable',updated_at=? WHERE upload_id=? AND status='ready'`).run(this.#now(), row.upload_id));
            output.push(this.getRecord(row.media_id));
            continue;
          }
          this.#owned((context) => context.db.prepare(`UPDATE private_audio_uploads SET status='unavailable',updated_at=? WHERE upload_id=? AND status='ready'`).run(this.#now(), row.upload_id));
        }
      } else if (row.status === 'deletion_pending') {
        await this.#finishDelete(row.media_id);
      }
      output.push(this.getRecord(row.media_id));
    }
    return Object.freeze(output);
  }

  async createSpeechLease(input: { noteId: string; noteRevision: number }): Promise<Readonly<{ leaseId: string; mediaId: string; sha256: string; byteLength: number; durationSeconds: number; fileName: string; format: PrivateAudioFormat; mimeType: string }>> {
    requireOpaqueNoteId(input.noteId);
    if (!Number.isSafeInteger(input.noteRevision) || input.noteRevision < 0) throw new Error('note_revision_invalid');
    return this.#owned((context) => {
      const ref = this.#resolveAttached({ workspaceId: context.workspaceId, ownerId: context.ownerId, privacyEpoch: context.privacyEpoch, noteId: input.noteId, noteRevision: input.noteRevision });
      if (!ref || ref.noteId !== input.noteId || ref.noteRevision !== input.noteRevision) throw new Error('audio_not_attached');
      requireUuid(ref.mediaId, 'media_id');
      const row = this.#record(context, ref.mediaId, ['ready']);
      if (!row.sha256 || !row.byte_length || !row.duration_seconds || (ref.sha256 && ref.sha256.toLowerCase() !== row.sha256) || (ref.byteLength !== undefined && ref.byteLength !== row.byte_length)) throw new Error('audio_attachment_changed');
      const leaseId = randomUUID();
      context.db.prepare(`INSERT INTO private_audio_speech_leases (lease_id,upload_id,media_id,workspace_id,owner_id,privacy_epoch,note_id,note_revision,sha256,byte_length,duration_seconds,process_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(leaseId, row.upload_id, row.media_id, context.workspaceId, context.ownerId, context.privacyEpoch,
        input.noteId, input.noteRevision, row.sha256, row.byte_length, row.duration_seconds, this.#processId, this.#now());
      return Object.freeze({ leaseId, mediaId: row.media_id, sha256: row.sha256, byteLength: row.byte_length, durationSeconds: row.duration_seconds,
        fileName: row.file_name, format: row.format, mimeType: row.mime_type });
    });
  }

  async readSpeechLease(leaseId: string): Promise<Readonly<{ metadata: Awaited<ReturnType<PrivateAudioRepository['createSpeechLease']>>; bytes: Buffer }>> {
    requireUuid(leaseId, 'lease_id');
    const row = this.#owned((context) => {
      const value = context.db.prepare(`SELECT l.*,u.file_name,u.format,u.mime_type,u.final_name,u.status FROM private_audio_speech_leases l
        JOIN private_audio_uploads u ON u.upload_id=l.upload_id WHERE l.lease_id=? AND l.workspace_id=? AND l.owner_id=? AND l.privacy_epoch=?`)
        .get(leaseId, context.workspaceId, context.ownerId, context.privacyEpoch) as (SpeechLeaseRow & { file_name: string; format: PrivateAudioFormat; mime_type: string; final_name: string; status: PrivateAudioStatus }) | undefined;
      if (!value || value.status !== 'ready') throw new Error('audio_lease_unavailable');
      return value;
    });
    const path = this.#safePath(row.final_name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== row.byte_length || info.size > MAX_AUDIO_BYTES) throw new Error('audio_file_unavailable');
    // A single private audio file has a strict 40 MiB physical cap; speech adapters may use a bounded Blob.
    const handle = await open(path, constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== row.byte_length) throw new Error('audio_file_unavailable');
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    if (bytes.byteLength !== row.byte_length || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error('audio_lease_changed');
    const metadata = Object.freeze({ leaseId: row.lease_id, mediaId: row.media_id, sha256: row.sha256, byteLength: row.byte_length,
      durationSeconds: row.duration_seconds, fileName: row.file_name, format: row.format, mimeType: row.mime_type });
    return Object.freeze({ metadata, bytes });
  }

  async releaseSpeechLease(leaseId: string): Promise<void> {
    requireUuid(leaseId, 'lease_id');
    const mediaId = this.#trustedDb((db) => {
      const current = db.prepare('SELECT media_id FROM private_audio_speech_leases WHERE lease_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
        .get(leaseId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as { media_id: string } | undefined;
      db.prepare('DELETE FROM private_audio_speech_leases WHERE lease_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
        .run(leaseId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch);
      return current?.media_id;
    });
    if (mediaId) this.#notifyMedia(mediaId);
  }

  /** Explicit retry for a closed reader whose exact private-row cleanup was not acknowledged. */
  async retryReaderCleanup(readerId: string): Promise<void> {
    requireUuid(readerId, 'reader_id');
    const cleanup = this.#readerCleanups.get(readerId);
    if (!cleanup || cleanup.acknowledged || !cleanup.retryRequired) throw new Error('audio_reader_cleanup_unavailable');
    if (!cleanup.fileClosed) await this.#closeReaderFile(cleanup);
    await this.#releaseReaderCleanup(cleanup);
  }

  #markReaderFileClosed(cleanup: ReaderCleanup): void {
    if (cleanup.fileClosed) return;
    cleanup.fileClosed = true;
    delete cleanup.fileHandle;
    void this.#releaseReaderCleanup(cleanup).catch(() => undefined);
  }

  #closeReaderFile(cleanup: ReaderCleanup): Promise<void> {
    if (cleanup.fileClosed) return Promise.resolve();
    if (cleanup.closeOperation) return cleanup.closeOperation;
    const handle = cleanup.fileHandle;
    if (!handle) return Promise.reject(new Error('audio_reader_close_unavailable'));
    const operation = Promise.resolve().then(() => this.#closeReaderHandle(handle)).then(() => {
      this.#markReaderFileClosed(cleanup);
    }).finally(() => {
      if (cleanup.closeOperation === operation) delete cleanup.closeOperation;
    });
    cleanup.closeOperation = operation;
    return operation;
  }

  #releaseReaderCleanup(cleanup: ReaderCleanup): Promise<void> {
    if (cleanup.acknowledged) return Promise.resolve();
    if (cleanup.operation) return cleanup.operation;
    const operation = Promise.resolve().then(() => this.#trustedDb((db) => {
      const current = db.prepare('SELECT reader_id,media_id,workspace_id,owner_id,privacy_epoch,process_id FROM private_audio_readers WHERE reader_id=?')
        .get(cleanup.readerId) as { reader_id: string; media_id: string; workspace_id: string; owner_id: string; privacy_epoch: number; process_id: string } | undefined;
      if (current && (current.media_id !== cleanup.mediaId || current.workspace_id !== cleanup.workspaceId || current.owner_id !== cleanup.ownerId ||
        current.privacy_epoch !== cleanup.privacyEpoch || current.process_id !== cleanup.processId)) throw new Error('audio_reader_cleanup_mismatch');
      if (current) db.prepare('DELETE FROM private_audio_readers WHERE reader_id=? AND media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=? AND process_id=?')
        .run(cleanup.readerId, cleanup.mediaId, cleanup.workspaceId, cleanup.ownerId, cleanup.privacyEpoch, cleanup.processId);
    })).then(() => {
      cleanup.acknowledged = true;
      cleanup.retryRequired = false;
      if (this.#readerCleanups.get(cleanup.readerId) === cleanup) this.#readerCleanups.delete(cleanup.readerId);
      this.#notifyMedia(cleanup.mediaId);
    }).catch((error: unknown) => {
      cleanup.retryRequired = true;
      throw error;
    }).finally(() => {
      if (cleanup.operation === operation) delete cleanup.operation;
    });
    cleanup.operation = operation;
    return operation;
  }

  async verifySpeechLease(leaseId: string): Promise<void> {
    requireUuid(leaseId, 'lease_id');
    const row = this.#owned((context) => {
      const value = context.db.prepare(`SELECT l.*,u.final_name,u.file_name,u.format,u.mime_type,u.status FROM private_audio_speech_leases l
        JOIN private_audio_uploads u ON u.upload_id=l.upload_id WHERE l.lease_id=? AND l.workspace_id=? AND l.owner_id=? AND l.privacy_epoch=?`)
        .get(leaseId, context.workspaceId, context.ownerId, context.privacyEpoch) as (SpeechLeaseRow & { final_name: string; file_name: string; format: PrivateAudioFormat; mime_type: string; status: PrivateAudioStatus }) | undefined;
      if (!value || value.status !== 'ready') throw new Error('audio_lease_unavailable');
      return value;
    });
    const path = this.#safePath(row.final_name);
    const [actualHash, checked] = await Promise.all([
      this.#hashFile(path),
      verifyPrivateAudioFile({ filePath: path, fileName: row.file_name, mimeType: row.mime_type, expectedFormat: row.format,
        ...(this.#ffmpegPath ? { ffmpegPath: this.#ffmpegPath } : {}), ...(this.#ffprobePath ? { ffprobePath: this.#ffprobePath } : {}) }),
    ]);
    if (actualHash.byteLength !== row.byte_length || actualHash.sha256 !== row.sha256 ||
      Math.abs(checked.durationSeconds - row.duration_seconds) > 0.001) throw new Error('audio_lease_changed');
  }

  async openAttachedMedia(input: { noteId: string; noteRevision: number; method?: 'GET' | 'HEAD'; range?: string; signal?: AbortSignal }): Promise<AudioRangeResponse> {
    requireOpaqueNoteId(input.noteId);
    if (!Number.isSafeInteger(input.noteRevision) || input.noteRevision < 0) throw new Error('note_revision_invalid');
    const row = this.#owned((context) => {
      const ref = this.#resolveAttached({ workspaceId: context.workspaceId, ownerId: context.ownerId, privacyEpoch: context.privacyEpoch, noteId: input.noteId, noteRevision: input.noteRevision });
      if (!ref || ref.noteId !== input.noteId || ref.noteRevision !== input.noteRevision) throw new Error('audio_not_attached');
      return this.#record(context, ref.mediaId, ['ready']);
    });
    if (!row.byte_length) throw new Error('audio_unavailable');
    const baseHeaders = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Type': row.mime_type,
      'Content-Disposition': `inline; filename="${row.file_name}"` };
    let start = 0, end = row.byte_length - 1, status: 200 | 206 = 200;
    if (input.range !== undefined) {
      const parsed = /^bytes=(\d*)-(\d*)$/.exec(input.range);
      if (!parsed || (!parsed[1] && !parsed[2])) return Object.freeze({ status: 416, headers: Object.freeze({ ...baseHeaders, 'Content-Range': `bytes */${row.byte_length}` }) });
      if (!parsed[1]) { const suffix = Number(parsed[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return Object.freeze({ status: 416, headers: Object.freeze({ ...baseHeaders, 'Content-Range': `bytes */${row.byte_length}` }) }); start = Math.max(0, row.byte_length - suffix); }
      else start = Number(parsed[1]);
      if (parsed[1] && parsed[2]) end = Number(parsed[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= row.byte_length || end < start) return Object.freeze({ status: 416, headers: Object.freeze({ ...baseHeaders, 'Content-Range': `bytes */${row.byte_length}` }) });
      end = Math.min(end, row.byte_length - 1); status = 206;
    }
    const contentLength = end - start + 1;
    const headers = Object.freeze({ ...baseHeaders, 'Content-Length': String(contentLength), ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${row.byte_length}` } : {}) });
    if ((input.method ?? 'GET') === 'HEAD') return Object.freeze({ status, headers });
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('cancelled');
    const readerId = randomUUID();
    const path = this.#safePath(row.final_name);
    const file = await open(path, constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.size !== row.byte_length) throw new Error('audio_file_unavailable');
      this.#owned((context) => {
        const current = this.#record(context, row.media_id, ['ready']);
        if (current.upload_id !== row.upload_id) throw new Error('audio_unavailable');
        context.db.prepare('INSERT INTO private_audio_readers (reader_id,media_id,workspace_id,owner_id,privacy_epoch,process_id,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(readerId, row.media_id, context.workspaceId, context.ownerId, context.privacyEpoch, this.#processId, this.#now());
      });
    } catch (error) { await file.close(); throw error; }
    const cleanup: ReaderCleanup = { readerId, mediaId: row.media_id, workspaceId: this.#identity.workspaceId, ownerId: this.#identity.ownerId,
      privacyEpoch: this.#identity.privacyEpoch, processId: this.#processId, fileClosed: false, acknowledged: false, retryRequired: false, fileHandle: file };
    this.#readerCleanups.set(readerId, cleanup);
    let stream: Readable;
    try {
      stream = this.#createReaderStream
        ? this.#createReaderStream(file, { start, end, highWaterMark: 64 * 1024 })
        : file.createReadStream({ start, end, highWaterMark: 64 * 1024 });
    }
    catch (error) {
      cleanup.retryRequired = true;
      void this.#closeReaderFile(cleanup).then(() => this.#releaseReaderCleanup(cleanup)).catch(() => undefined);
      throw error;
    }
    const abortStream = () => stream.destroy();
    const release = () => {
      input.signal?.removeEventListener('abort', abortStream);
      this.#markReaderFileClosed(cleanup);
    };
    stream.once('close', release);
    if (input.signal) {
      input.signal.addEventListener('abort', abortStream, { once: true });
      if (input.signal.aborted) abortStream();
    }
    return Object.freeze({ status, headers, body: stream });
  }

  async deleteAttachedMedia(input: { noteId: string; noteRevision: number }): Promise<PrivateAudioRecord> {
    requireOpaqueNoteId(input.noteId);
    if (!Number.isSafeInteger(input.noteRevision) || input.noteRevision < 0) throw new Error('note_revision_invalid');
    const mediaId = this.#owned((context) => {
      const ref = this.#resolveAttached({ workspaceId: context.workspaceId, ownerId: context.ownerId, privacyEpoch: context.privacyEpoch, noteId: input.noteId, noteRevision: input.noteRevision });
      if (!ref || ref.noteId !== input.noteId || ref.noteRevision !== input.noteRevision) throw new Error('audio_not_attached');
      this.#record(context, ref.mediaId, ['ready', 'deletion_pending']);
      return ref.mediaId;
    });
    return this.#deleteMedia(mediaId);
  }

  /** Trusted local privacy cleanup by opaque ID; never accepts a path or browser-controlled ownership. */
  async eraseOwnedMedia(mediaId: string): Promise<PrivateAudioRecord> {
    requireUuid(mediaId, 'media_id');
    this.#trustedDb((db) => {
      const row = db.prepare('SELECT status FROM private_audio_uploads WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
        .get(mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as { status: PrivateAudioStatus } | undefined;
      if (!row || !['ready', 'deletion_pending', 'unavailable'].includes(row.status)) throw new Error('audio_unavailable');
      db.prepare(`UPDATE private_audio_uploads SET status='deletion_pending',updated_at=? WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .run(this.#now(), mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch);
    });
    return this.#deleteMedia(mediaId, true);
  }

  async #deleteMedia(mediaId: string, alreadyMarked = false): Promise<PrivateAudioRecord> {
    if (!alreadyMarked) this.#owned((context) => {
      this.#record(context, mediaId, ['ready', 'deletion_pending', 'unavailable']);
      context.db.prepare(`UPDATE private_audio_uploads SET status='deletion_pending',updated_at=? WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .run(this.#now(), mediaId, context.workspaceId, context.ownerId, context.privacyEpoch);
    });
    await this.#finishDelete(mediaId);
    return this.#trustedDb((db) => {
      const row = db.prepare('SELECT * FROM private_audio_uploads WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
        .get(mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as AudioRow | undefined;
      if (!row) throw new Error('audio_unavailable');
      return asSafeRecord(row);
    });
  }

  async #finishDelete(mediaId: string): Promise<void> {
    await this.#waitForMediaIdle(mediaId);
    const row = this.#trustedDb((db) => {
      const value = db.prepare('SELECT * FROM private_audio_uploads WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=?')
        .get(mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as AudioRow | undefined;
      if (!value || value.status !== 'deletion_pending') throw new Error('audio_unavailable');
      return value;
    });
    try {
      await rm(this.#safePath(row.final_name), { force: true });
      await rm(this.#safePath(row.temp_name), { force: true });
      syncDirectory(this.#directory());
      this.#trustedDb((db) => {
        db.prepare(`UPDATE private_audio_uploads SET status='unavailable',updated_at=? WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=? AND status='deletion_pending'`)
          .run(this.#now(), mediaId, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch);
      });
    } catch { throw new Error('audio_delete_pending'); }
  }

  async #hashFile(filePath: string): Promise<{ byteLength: number; sha256: string }> {
    const handle = await open(filePath, constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_AUDIO_BYTES) throw new Error('audio_file_unavailable');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let byteLength = 0;
      while (byteLength < info.size) {
        const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, info.size - byteLength), byteLength);
        if (result.bytesRead <= 0) throw new Error('audio_file_unavailable');
        byteLength += result.bytesRead;
        hash.update(buffer.subarray(0, result.bytesRead));
      }
      return { byteLength, sha256: hash.digest('hex') };
    } finally { await handle.close(); }
  }
}
