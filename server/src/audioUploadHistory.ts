import { createHash } from 'node:crypto';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import type { CaptureUploadStatus } from './privateAudioRepository.js';

export const AUDIO_UPLOAD_HISTORY_PAGE_SIZE = 50;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_GLOB = '[0-9a-fA-F]';
const VALID_UUID_GLOB = `${HEX_GLOB.repeat(8)}-${HEX_GLOB.repeat(4)}-4${HEX_GLOB.repeat(3)}-[89aAbB]${HEX_GLOB.repeat(3)}-${HEX_GLOB.repeat(12)}`;
const STATUS = new Set<CaptureUploadStatus>(['receiving', 'ready', 'failed', 'inspect_required', 'consumed', 'discarded']);

export type AudioUploadHistoryEntry = Readonly<{
  uploadId: string;
  capture: Readonly<{ id: string; revision: string; capturedAt: string; timeZone: string }>;
  status: CaptureUploadStatus;
  createdAt: number;
  updatedAt: number;
}>;
export type AudioUploadHistoryPage = Readonly<{
  schemaVersion: 1;
  entries: readonly AudioUploadHistoryEntry[];
  nextCursor?: string;
}>;

type Cursor = Readonly<{ v: 1; scope: string; createdAt: number; uploadId: string }>;
type HistoryRow = {
  upload_id: string; capture_id: string; capture_revision: string; captured_at: string; time_zone: string;
  status: string; created_at: number; updated_at: number;
};

function scopeFor(identity: { ownerId: string; workspaceId: string; privacyEpoch: number }): string {
  return createHash('sha256').update(JSON.stringify({ ownerId: identity.ownerId, workspaceId: identity.workspaceId,
    privacyEpoch: identity.privacyEpoch })).digest('hex');
}

function parseCursor(value: unknown, scope: string): Cursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('audio_history_cursor_invalid');
  }
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(json, 'utf8').toString('base64url') !== value) throw new Error();
    const cursor = JSON.parse(json) as Record<string, unknown>;
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) ||
        Object.keys(cursor).length !== 4 || !Object.hasOwn(cursor, 'v') || !Object.hasOwn(cursor, 'scope') ||
        !Object.hasOwn(cursor, 'createdAt') || !Object.hasOwn(cursor, 'uploadId') ||
        JSON.stringify({ v: cursor.v, scope: cursor.scope, createdAt: cursor.createdAt, uploadId: cursor.uploadId }) !== json ||
        cursor.v !== 1 || cursor.scope !== scope || typeof cursor.scope !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.scope) ||
        typeof cursor.createdAt !== 'number' || !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0 ||
        typeof cursor.uploadId !== 'string' || !UUID_V4.test(cursor.uploadId)) throw new Error();
    return cursor as Cursor;
  } catch { throw new Error('audio_history_cursor_invalid'); }
}

function ensureReadableSchema(db: OwnedTransactionContext['db']): boolean {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_audio_capture_uploads'").get();
  const marker = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_audio_schema'").get();
  if (!table && !marker) {
    const partial = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'private_audio_*' LIMIT 1").get();
    if (partial) throw new Error('audio_schema_unversioned');
    return false;
  }
  if (!table || !marker) throw new Error('audio_schema_invalid');
  const markerColumns = db.pragma('table_info(private_audio_schema)') as { name: string; type: string }[];
  if (markerColumns.length !== 2 || markerColumns[0]?.name !== 'singleton' || markerColumns[0]?.type !== 'INTEGER' ||
      markerColumns[1]?.name !== 'version' || markerColumns[1]?.type !== 'INTEGER') throw new Error('audio_schema_invalid');
  const versions = db.prepare('SELECT singleton,version FROM private_audio_schema').all() as { singleton: number; version: number }[];
  if (versions.length !== 1 || versions[0]?.singleton !== 1 || ![2, 3, 4].includes(versions[0]?.version ?? -1)) {
    throw new Error('audio_schema_unsupported');
  }
  const required = [
    ['upload_id', 'TEXT', 1, 1], ['capture_id', 'TEXT', 1, 0], ['capture_revision', 'TEXT', 1, 0],
    ['workspace_id', 'TEXT', 1, 0], ['owner_id', 'TEXT', 1, 0], ['privacy_epoch', 'INTEGER', 1, 0],
    ['captured_at', 'TEXT', 1, 0], ['time_zone', 'TEXT', 1, 0], ['status', 'TEXT', 1, 0],
    ['created_at', 'INTEGER', 1, 0], ['updated_at', 'INTEGER', 1, 0],
  ] as const;
  const columns = db.pragma('table_info(private_audio_capture_uploads)') as { name: string; type: string; notnull: number; pk: number }[];
  for (const [name, type, notnull, pk] of required) {
    const actual = columns.find((column) => column.name === name);
    if (!actual || actual.type.toUpperCase() !== type || actual.notnull !== notnull || actual.pk !== pk) throw new Error('audio_schema_invalid');
  }
  const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get('private_audio_capture_uploads') as { strict: number } | undefined;
  if (!strict || strict.strict !== 1) throw new Error('audio_schema_invalid');
  return true;
}

function validCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

/** Authenticated, metadata-only history. This reader never initializes or mutates the audio schema. */
export function readAudioUploadHistory(kernel: DurableKernel, sessionToken: string, cursorValue?: string): AudioUploadHistoryPage {
  const admission = kernel.getOwnedIdentity(sessionToken);
  return kernel.withOwnedTransaction(sessionToken, admission.privacyEpoch, (context) => {
    if (context.workspaceId !== admission.workspaceId || context.ownerId !== admission.ownerId ||
        context.privacyEpoch !== admission.privacyEpoch) throw new Error('audio_owner_changed');
    const scope = scopeFor(admission);
    const cursor = parseCursor(cursorValue, scope);
    if (!ensureReadableSchema(context.db)) {
      if (cursor) throw new Error('audio_history_cursor_invalid');
      return Object.freeze({ schemaVersion: 1, entries: Object.freeze([]) });
    }

    if (cursor) {
      const anchor = context.db.prepare(`SELECT created_at FROM private_audio_capture_uploads
        WHERE upload_id=? AND upload_id GLOB ? AND capture_id GLOB ? AND capture_revision GLOB ?
          AND status IN ('receiving','ready','failed','inspect_required','consumed','discarded')
          AND workspace_id=? AND owner_id=? AND privacy_epoch=?`).get(cursor.uploadId, VALID_UUID_GLOB, VALID_UUID_GLOB,
        VALID_UUID_GLOB, context.workspaceId, context.ownerId, context.privacyEpoch) as { created_at: number } | undefined;
      if (!anchor || anchor.created_at !== cursor.createdAt) throw new Error('audio_history_cursor_invalid');
    }

    const rows = context.db.prepare(`SELECT upload_id,capture_id,capture_revision,captured_at,time_zone,status,created_at,updated_at
      FROM private_audio_capture_uploads
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?
        AND upload_id GLOB ? AND capture_id GLOB ? AND capture_revision GLOB ?
        AND status IN ('receiving','ready','failed','inspect_required','consumed','discarded')
        ${cursor ? 'AND (created_at,upload_id) < (?,?)' : ''}
      ORDER BY created_at DESC,upload_id DESC LIMIT ?`).all(context.workspaceId, context.ownerId, context.privacyEpoch,
        VALID_UUID_GLOB, VALID_UUID_GLOB, VALID_UUID_GLOB,
        ...(cursor ? [cursor.createdAt, cursor.uploadId] : []), AUDIO_UPLOAD_HISTORY_PAGE_SIZE + 1) as HistoryRow[];
    const pageRows = rows.slice(0, AUDIO_UPLOAD_HISTORY_PAGE_SIZE);
    for (const row of pageRows) {
      if (!UUID_V4.test(row.upload_id) || !UUID_V4.test(row.capture_id) || !UUID_V4.test(row.capture_revision) ||
          !STATUS.has(row.status as CaptureUploadStatus) || !Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
          !Number.isSafeInteger(row.updated_at) || row.updated_at < 0 || !validCanonicalIso(row.captured_at) || !validTimeZone(row.time_zone)) {
        throw new Error('audio_history_projection_invalid');
      }
    }
    const entries = Object.freeze(pageRows.map((row): AudioUploadHistoryEntry => Object.freeze({
      uploadId: row.upload_id,
      capture: Object.freeze({ id: row.capture_id, revision: row.capture_revision, capturedAt: row.captured_at, timeZone: row.time_zone }),
      status: row.status as CaptureUploadStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
    const last = pageRows.at(-1);
    const nextCursor = rows.length > AUDIO_UPLOAD_HISTORY_PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ v: 1, scope, createdAt: last.created_at, uploadId: last.upload_id }), 'utf8').toString('base64url')
      : undefined;
    return Object.freeze({ schemaVersion: 1, entries, ...(nextCursor ? { nextCursor } : {}) });
  });
}
