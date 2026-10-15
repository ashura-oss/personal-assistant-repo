import { constants, closeSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DurableKernel } from './kernel.js';
import type { ApplicationStartupCapability } from './applicationStartup.js';
import { assertApplicationStartupCapability, createApplicationStartupCursor, createApplicationStartupIntentCursor } from './applicationStartup.js';
import { assertPrivateAudioSchemaVersion, isUnsupportedDirectorySyncError, privateAudioStoragePath,
  privateAudioWorkspaceRoot, readPrivateAudioSchemaVersion, assertPrivateAudioSchema } from './privateAudioStorage.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const FORMATS = new Set(['m4a', 'mp3', 'wav', 'webm', 'ogg']);
const MIME: Readonly<Record<string, string>> = Object.freeze({ m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg' });
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const PAGE_SIZE = 128;

type SafeReason = 'owner_missing' | 'owner_changed' | 'epoch_future' | 'lineage_invalid' | 'audio_schema_invalid' |
  'intent_invalid' | 'media_invalid' | 'snapshot_invalid' | 'media_still_attached' | 'current_holder' | 'path_invalid' |
  'unlink_pending' | 'directory_sync_pending' | 'completion_pending';

export type AudioColdStartRecoveryOutcome = Readonly<{
  workspaceId: string;
  intentId?: string;
  status: 'complete' | 'cleanup_pending' | 'inspection_required';
  reason?: SafeReason;
}>;

export interface AudioColdStartFileOperations {
  readonly remove?: (path: string) => Promise<void>;
  /** Narrow failure-injection seam; production always uses closeSync. */
  readonly closeDescriptor?: (fd: number) => void;
  readonly beforeComplete?: (intentId: string) => void;
  readonly afterUnlink?: (intentId: string) => void;
  readonly syncDirectory?: (path: string, closeDescriptor: (fd: number) => void) => void;
}

export interface AudioColdStartRecoveryOptions {
  readonly kernel: DurableKernel;
  readonly capability: ApplicationStartupCapability;
  readonly privateRoot: string;
  readonly processInstanceId: string;
  readonly fileOperations?: AudioColdStartFileOperations;
}

interface CleanupIntentRow {
  intent_id: unknown; workspace_id: unknown; owner_id: unknown; privacy_epoch: unknown; media_id: unknown;
  source_note_id: unknown; snapshot_revision: unknown; command_id: unknown; status: unknown; created_at: unknown; updated_at: unknown;
}
interface AudioRow {
  upload_id: unknown; media_id: unknown; workspace_id: unknown; owner_id: unknown; privacy_epoch: unknown; status: unknown;
  temp_name: unknown; final_name: unknown; file_name: unknown; format: unknown; mime_type: unknown; expected_bytes: unknown;
  sha256: unknown; byte_length: unknown; duration_seconds: unknown; process_id: unknown; created_at: unknown; updated_at: unknown;
}
interface AsyncJournalRow {
  workspace_id: unknown; idempotency_key: unknown; owner_id: unknown; session_digest: unknown; request_digest: unknown;
  command_kind: unknown; privacy_epoch: unknown; ticket_id: unknown; ticket_digest: unknown; status: unknown;
  created_at: unknown; updated_at: unknown; checkpoint_revision: unknown; snapshot_digest: unknown;
  owned_object_ids_json: unknown; receipt_json: unknown;
}
interface Ticket {
  readonly workspaceId: string; readonly ownerId: string; readonly intentId: string; readonly mediaId: string;
  readonly uploadId: string; readonly privacyEpoch: number; readonly snapshotRevision: number; readonly tempName: string; readonly finalName: string;
  readonly directory: string; readonly tempPath: string; readonly finalPath: string;
}
interface ValidIntent extends CleanupIntentRow {
  intent_id: string; workspace_id: string; owner_id: string; privacy_epoch: number; media_id: string;
  source_note_id: string; snapshot_revision: number; command_id: string | null; status: 'pending'; created_at: number; updated_at: number;
}

function safeOutcome(workspaceId: string, status: AudioColdStartRecoveryOutcome['status'], reason?: SafeReason,
  intentId?: string): AudioColdStartRecoveryOutcome {
  return Object.freeze({ workspaceId, ...(intentId ? { intentId } : {}), status, ...(reason ? { reason } : {}) });
}
function validUuid(value: unknown): value is string { return typeof value === 'string' && UUID_V4.test(value); }
function validInt(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum; }
function validOpaqueId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1024) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    else if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
function validTimestampPair(created: unknown, updated: unknown): boolean {
  return validInt(created) && validInt(updated) && (updated as number) >= (created as number);
}
function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
function fsCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : undefined; }
function isMissing(error: unknown): boolean { return fsCode(error) === 'ENOENT'; }

/** Validates only audio references used for cleanup proof; malformed historical state fails closed. */
function snapshotAudioReferences(snapshot: unknown): ReadonlySet<string> {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('snapshot_invalid');
  const notes = (snapshot as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) throw new Error('snapshot_invalid');
  const seen = new Set<string>();
  const refs = new Set<string>();
  for (const raw of notes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('snapshot_invalid');
    const note = raw as { id?: unknown; audioUri?: unknown };
    if (!validOpaqueId(note.id) || seen.has(note.id)) throw new Error('snapshot_invalid');
    seen.add(note.id);
    if (note.audioUri === undefined) continue;
    if (typeof note.audioUri !== 'string') throw new Error('snapshot_invalid');
    if (!note.audioUri.startsWith('still-media:')) continue;
    const match = /^still-media:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(note.audioUri);
    if (!match || match[0] !== note.audioUri) throw new Error('snapshot_invalid');
    refs.add(match[1]!.toLowerCase());
  }
  return refs;
}

function validateIntent(row: CleanupIntentRow): asserts row is ValidIntent {
  if (!validUuid(row.intent_id) || !validUuid(row.workspace_id) || !validUuid(row.owner_id) || !validInt(row.privacy_epoch) ||
      !validUuid(row.media_id) || !validOpaqueId(row.source_note_id) || !validInt(row.snapshot_revision, 1) ||
      (row.command_id !== null && !validUuid(row.command_id)) || row.status !== 'pending' || !validTimestampPair(row.created_at, row.updated_at)) {
    throw new Error('intent_invalid');
  }
}

function validateAudio(row: AudioRow, intent: ValidIntent): asserts row is AudioRow & {
  upload_id: string; media_id: string; workspace_id: string; owner_id: string; privacy_epoch: number; status: 'deletion_pending';
  temp_name: string; final_name: string; file_name: string; format: string; mime_type: string; expected_bytes: number | null;
  sha256: string | null; byte_length: number | null; duration_seconds: number | null; process_id: string; created_at: number; updated_at: number;
} {
  if (!validUuid(row.upload_id) || row.media_id !== intent.media_id || row.workspace_id !== intent.workspace_id || row.owner_id !== intent.owner_id ||
      row.privacy_epoch !== intent.privacy_epoch || row.status !== 'deletion_pending' || row.temp_name !== `${row.upload_id}.part` ||
      row.final_name !== `${row.upload_id}.audio` || typeof row.format !== 'string' || !FORMATS.has(row.format) ||
      row.file_name !== `recording.${row.format}` || row.mime_type !== MIME[row.format] || !validUuid(row.process_id) ||
      (row.expected_bytes !== null && (!validInt(row.expected_bytes, 1) || row.expected_bytes > MAX_AUDIO_BYTES)) ||
      (row.sha256 !== null && (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256))) ||
      (row.byte_length !== null && (!validInt(row.byte_length, 1) || row.byte_length > MAX_AUDIO_BYTES)) ||
      (row.duration_seconds !== null && (typeof row.duration_seconds !== 'number' || !Number.isFinite(row.duration_seconds) || row.duration_seconds <= 0)) ||
      !validTimestampPair(row.created_at, row.updated_at)) throw new Error('media_invalid');
}

function validStoredObjectIds(value: unknown): value is Record<string, string[]> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(['notes', 'tasks', 'proposals', 'accounts', 'documents', 'calendars']);
  return Object.keys(record).every((key) => allowed.has(key)) && Object.values(record).every((ids) =>
    Array.isArray(ids) && ids.every(validOpaqueId) && new Set(ids).size === ids.length);
}

function readAsyncJournalRow(db: import('better-sqlite3').Database, workspaceId: string, commandId: string): AsyncJournalRow | undefined {
  return db.prepare(`SELECT workspace_id,idempotency_key,owner_id,session_digest,request_digest,command_kind,privacy_epoch,
      ticket_id,ticket_digest,status,created_at,updated_at,checkpoint_revision,snapshot_digest,owned_object_ids_json,receipt_json
    FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`).get(workspaceId, commandId) as AsyncJournalRow | undefined;
}

function validateAsyncJournalEnvelope(row: AsyncJournalRow | undefined, expected: {
  workspaceId: string; ownerId: string; privacyEpoch: number; commandId: string; headRevision: number;
}): asserts row is AsyncJournalRow {
  if (!row || row.workspace_id !== expected.workspaceId || row.idempotency_key !== expected.commandId ||
      row.owner_id !== expected.ownerId || row.privacy_epoch !== expected.privacyEpoch ||
      !validUuid(row.idempotency_key) || !validUuid(row.ticket_id) ||
      typeof row.session_digest !== 'string' || !SHA256.test(row.session_digest) ||
      typeof row.request_digest !== 'string' || !SHA256.test(row.request_digest) ||
      typeof row.ticket_digest !== 'string' || !SHA256.test(row.ticket_digest) ||
      !validTimestampPair(row.created_at, row.updated_at) || !validInt(row.checkpoint_revision, 1) ||
      row.checkpoint_revision < 1 || row.checkpoint_revision > expected.headRevision ||
      typeof row.snapshot_digest !== 'string' || !SHA256.test(row.snapshot_digest) ||
      !validStoredObjectIds(row.owned_object_ids_json) ||
      (row.status !== 'checkpointed' && row.status !== 'inspect_required' && row.status !== 'finished') ||
      (row.status === 'finished' ? typeof row.receipt_json !== 'string' : row.receipt_json !== null)) {
    throw new Error('lineage_invalid');
  }
}

function readJournalReceipt(row: AsyncJournalRow): Record<string, unknown> {
  if (typeof row.receipt_json !== 'string' || Buffer.byteLength(row.receipt_json, 'utf8') > 16 * 1024) throw new Error('lineage_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(row.receipt_json); } catch { throw new Error('lineage_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('lineage_invalid');
  return parsed as Record<string, unknown>;
}

function validateCommandLineage(db: import('better-sqlite3').Database, intent: ValidIntent): void {
  if (intent.command_id === null) return;
  const head = db.prepare('SELECT revision FROM workspaces WHERE id=? AND owner_id=? AND privacy_epoch>=?')
    .get(intent.workspace_id, intent.owner_id, intent.privacy_epoch) as { revision: unknown } | undefined;
  if (!head || !validInt(head.revision)) throw new Error('lineage_invalid');
  const row = readAsyncJournalRow(db, intent.workspace_id, intent.command_id);
  validateAsyncJournalEnvelope(row, { workspaceId: intent.workspace_id, ownerId: intent.owner_id,
    privacyEpoch: intent.privacy_epoch, commandId: intent.command_id, headRevision: head.revision });
  const checkpointRevision = row.checkpoint_revision;
  if ((row.command_kind !== 'notes.delete' && row.command_kind !== 'notes.transcribe') ||
      !validInt(checkpointRevision, intent.snapshot_revision)) throw new Error('lineage_invalid');
  const ownedIds = JSON.parse(row.owned_object_ids_json as string) as Record<string, string[]>;
  if (row.command_kind === 'notes.delete' && (ownedIds.notes ?? []).includes(intent.source_note_id)) throw new Error('lineage_invalid');
  if (row.command_kind === 'notes.transcribe' && !(ownedIds.notes ?? []).includes(intent.source_note_id)) throw new Error('lineage_invalid');
  if (row.status !== 'finished') return;
  const receipt = readJournalReceipt(row);
  if (row.command_kind === 'notes.delete') {
    if (Object.keys(receipt).sort().join('\0') !== ['kind', 'noteId'].join('\0') ||
        receipt.kind !== 'notes.delete' || receipt.noteId !== intent.source_note_id) throw new Error('lineage_invalid');
    return;
  }
  const keys = ['attemptId', 'commandId', 'kind', 'objectId', 'outcome', 'schemaVersion', 'sourceRevision'].sort();
  if (Object.keys(receipt).sort().join('\0') !== keys.join('\0') || receipt.schemaVersion !== 1 ||
      receipt.commandId !== intent.command_id || receipt.kind !== 'notes.transcribe' ||
      receipt.objectId !== intent.source_note_id || !validUuid(receipt.attemptId) ||
      !validInt(receipt.sourceRevision, 1) || receipt.outcome !== 'completed') throw new Error('lineage_invalid');
}

function validateWorkspaceAndSnapshot(kernel: DurableKernel, capability: ApplicationStartupCapability,
  db: import('better-sqlite3').Database, intent: ValidIntent): Readonly<{ revision: number; privacyEpoch: number }> {
  const workspace = db.prepare('SELECT id,owner_id,privacy_epoch,revision,schema_version,snapshot_json FROM workspaces WHERE id=?')
    .get(intent.workspace_id) as { id: unknown; owner_id: unknown; privacy_epoch: unknown; revision: unknown; schema_version: unknown; snapshot_json: unknown } | undefined;
  if (!workspace) throw new Error('owner_missing');
  if (workspace.id !== intent.workspace_id || workspace.owner_id !== intent.owner_id || !validUuid(workspace.owner_id) ||
      !validInt(workspace.privacy_epoch) || !validInt(workspace.revision) || !validInt(workspace.schema_version, 1)) throw new Error('owner_changed');
  if (workspace.privacy_epoch < intent.privacy_epoch) throw new Error('epoch_future');
  if (intent.snapshot_revision > workspace.revision || typeof workspace.snapshot_json !== 'string') throw new Error('intent_invalid');
  let snapshot: unknown;
  try { snapshot = JSON.parse(workspace.snapshot_json); kernel.validateColdStartSnapshot(capability, snapshot); }
  catch { throw new Error('snapshot_invalid'); }
  let references: ReadonlySet<string>;
  try { references = snapshotAudioReferences(snapshot); } catch { throw new Error('snapshot_invalid'); }
  if (references.has(intent.media_id.toLowerCase())) throw new Error('media_still_attached');
  return Object.freeze({ revision: workspace.revision, privacyEpoch: workspace.privacy_epoch });
}

function safeReason(error: unknown): SafeReason {
  const code = error instanceof Error ? error.message : '';
  if (['owner_missing','owner_changed','epoch_future','lineage_invalid','audio_schema_invalid','intent_invalid','media_invalid',
    'snapshot_invalid','media_still_attached','current_holder','path_invalid','unlink_pending','directory_sync_pending','completion_pending'].includes(code)) return code as SafeReason;
  return 'intent_invalid';
}

export class AudioColdStartRecoveryCleanupError extends Error {
  constructor(private readonly recovery: AudioColdStartRecovery) {
    super('Audio cold-start recovery still owns a physical cleanup descriptor.');
    this.name = 'AudioColdStartRecoveryCleanupError';
  }
  async retryClose(): Promise<void> { await this.recovery.retryCloseOwnedDescriptors(); }
}

/** One host-startup pass. It owns every temporary descriptor until close is confirmed. */
export class AudioColdStartRecovery {
  private readonly ownedDescriptors = new Set<number>();
  private readonly remove: (path: string) => Promise<void>;
  private readonly closeDescriptor: (fd: number) => void;
  private readonly operations: AudioColdStartFileOperations;

  constructor(private readonly options: AudioColdStartRecoveryOptions) {
    if (typeof options.privateRoot !== 'string' || options.privateRoot.length === 0 || !validUuid(options.processInstanceId)) throw new TypeError('audio_cold_start_configuration_invalid');
    assertApplicationStartupCapability(options.capability, options.kernel, 'recovering', options.processInstanceId);
    this.remove = options.fileOperations?.remove ?? (async (path) => rm(path, { force: true }));
    this.closeDescriptor = options.fileOperations?.closeDescriptor ?? closeSync;
    this.operations = options.fileOperations ?? {};
  }

  async run(): Promise<readonly AudioColdStartRecoveryOutcome[]> {
    const { kernel, capability } = this.options;
    assertApplicationStartupCapability(capability, kernel, 'recovering', this.options.processInstanceId);
    const outcomes: AudioColdStartRecoveryOutcome[] = [];
    let cursor = createApplicationStartupCursor(capability);
    while (true) {
      assertApplicationStartupCapability(capability, kernel, 'recovering', this.options.processInstanceId);
      const page = kernel.listColdStartWorkspacePage(capability, cursor, PAGE_SIZE);
      for (const entry of page.entries) {
        const workspaceId: unknown = entry.workspaceId;
        if (!validUuid(workspaceId)) {
          outcomes.push(safeOutcome(typeof workspaceId === 'string' ? workspaceId.slice(0, 128) : 'unknown', 'inspection_required', 'owner_changed'));
          continue;
        }
        if (!entry.ownerId) {
          const hasPending = this.hasOrphanPendingIntent(entry.workspaceId);
          if (hasPending) outcomes.push(safeOutcome(entry.workspaceId, 'inspection_required', 'owner_missing'));
          continue;
        }
        let cursor = createApplicationStartupIntentCursor(capability, entry.workspaceId);
        while (true) {
        let page: Readonly<{ entries: readonly CleanupIntentRow[]; nextCursor?: import('./applicationStartup.js').ApplicationStartupCursor }>;
        try { page = this.pendingForWorkspace(entry.workspaceId, cursor); }
        catch (error) {
          outcomes.push(safeOutcome(entry.workspaceId, 'inspection_required', safeReason(error)));
          break;
        }
        for (const row of page.entries) outcomes.push(await this.recoverOne(row));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    try { await this.retryCloseOwnedDescriptors(); }
    catch { throw new AudioColdStartRecoveryCleanupError(this); }
    return Object.freeze(outcomes);
  }

  async retryCloseOwnedDescriptors(): Promise<void> {
    const failures: unknown[] = [];
    for (const fd of [...this.ownedDescriptors]) {
      try { this.closeDescriptor(fd); this.ownedDescriptors.delete(fd); }
      catch (error) {
        if (fsCode(error) === 'EBADF') this.ownedDescriptors.delete(fd);
        else failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Audio recovery descriptor close remains unconfirmed.');
  }

  private hasOrphanPendingIntent(workspaceId: string): boolean {
    return this.options.kernel.withColdStartDatabaseTransaction(this.options.capability, (db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='private_audio_cleanup_intents'").get()) return false;
      return Boolean(db.prepare("SELECT 1 FROM private_audio_cleanup_intents WHERE workspace_id=? AND status='pending' LIMIT 1").get(workspaceId));
    });
  }

  private pendingForWorkspace(workspaceId: string, cursor: import('./applicationStartup.js').ApplicationStartupCursor): Readonly<{
    entries: readonly CleanupIntentRow[]; nextCursor?: import('./applicationStartup.js').ApplicationStartupCursor;
  }> {
    const hasCurrentSchema = this.options.kernel.withColdStartDatabaseTransaction(this.options.capability, (db) => {
      const version = readPrivateAudioSchemaVersion(db);
      if (version === undefined || version < 4) return false;
      assertPrivateAudioSchemaVersion(db);
      assertPrivateAudioSchema(db);
      return true;
    });
    if (!hasCurrentSchema) return Object.freeze({ entries: Object.freeze([]) });
    const page = this.options.kernel.listColdStartIntentPage(this.options.capability, workspaceId, cursor, PAGE_SIZE);
    return Object.freeze({ entries: page.entries, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
  }

  private async recoverOne(rawIntent: CleanupIntentRow): Promise<AudioColdStartRecoveryOutcome> {
    let ticket: Ticket;
    try { ticket = this.validateAndRetireHolders(rawIntent); }
    catch (error) {
      const workspaceId = typeof rawIntent.workspace_id === 'string' && validUuid(rawIntent.workspace_id) ? rawIntent.workspace_id : 'unknown';
      const intentId = typeof rawIntent.intent_id === 'string' && validUuid(rawIntent.intent_id) ? rawIntent.intent_id : undefined;
      return safeOutcome(workspaceId, 'inspection_required', safeReason(error), intentId);
    }
    try {
      await this.unlinkTicketFile(ticket, ticket.finalPath);
      this.assertCurrentTicket(ticket);
      await this.unlinkTicketFile(ticket, ticket.tempPath);
      this.assertCurrentTicket(ticket);
      this.syncTicketDirectory(ticket);
      this.assertCurrentTicket(ticket);
      this.operations.beforeComplete?.(ticket.intentId);
      try { this.completeTicket(ticket); }
      catch {
        if (this.isExactCompleted(ticket)) return safeOutcome(ticket.workspaceId, 'complete', undefined, ticket.intentId);
        return safeOutcome(ticket.workspaceId, 'cleanup_pending', 'completion_pending', ticket.intentId);
      }
      return safeOutcome(ticket.workspaceId, 'complete', undefined, ticket.intentId);
    } catch (error) {
      const reason = safeReason(error);
      const status = reason === 'owner_changed' || reason === 'owner_missing' || reason === 'epoch_future' || reason === 'snapshot_invalid' ||
        reason === 'media_still_attached' || reason === 'lineage_invalid' || reason === 'intent_invalid' || reason === 'media_invalid' ||
        reason === 'audio_schema_invalid' || reason === 'current_holder' || reason === 'path_invalid' ? 'inspection_required' : 'cleanup_pending';
      return safeOutcome(ticket.workspaceId, status, reason, ticket.intentId);
    }
  }

  private validateAndRetireHolders(rawIntent: CleanupIntentRow): Ticket {
    const { kernel, capability, privateRoot, processInstanceId } = this.options;
    return kernel.withColdStartDatabaseTransaction(capability, (db) => {
      const intent = db.prepare("SELECT * FROM private_audio_cleanup_intents WHERE intent_id=?").get(rawIntent.intent_id) as CleanupIntentRow | undefined;
      if (!intent) throw new Error('intent_invalid');
      validateIntent(intent);
      const workspace = validateWorkspaceAndSnapshot(kernel, capability, db, intent);
      validateCommandLineage(db, intent);
      const sameMedia = db.prepare(`SELECT * FROM private_audio_uploads WHERE media_id=?`).all(intent.media_id) as AudioRow[];
      if (sameMedia.length !== 1) throw new Error('media_invalid');
      const audio = sameMedia[0]!;
      validateAudio(audio, intent);
      this.validateCaptureRows(db, audio, intent);
      const otherPending = db.prepare(`SELECT intent_id FROM private_audio_cleanup_intents WHERE media_id=? AND status='pending' AND intent_id<>?`)
        .all(intent.media_id, intent.intent_id);
      if (otherPending.length) throw new Error('intent_invalid');
      const readers = db.prepare('SELECT * FROM private_audio_readers WHERE media_id=?').all(intent.media_id) as Record<string, unknown>[];
      const leases = db.prepare('SELECT * FROM private_audio_speech_leases WHERE media_id=?').all(intent.media_id) as Record<string, unknown>[];
      for (const reader of readers) {
        if (!validUuid(reader.reader_id) || reader.media_id !== intent.media_id || reader.workspace_id !== intent.workspace_id || reader.owner_id !== intent.owner_id ||
            reader.privacy_epoch !== intent.privacy_epoch || !validUuid(reader.process_id) || !validInt(reader.created_at)) throw new Error('media_invalid');
        if (reader.process_id === processInstanceId) throw new Error('current_holder');
      }
      for (const lease of leases) {
        if (!validUuid(lease.lease_id) || lease.media_id !== intent.media_id || lease.upload_id !== audio.upload_id || lease.workspace_id !== intent.workspace_id ||
            lease.owner_id !== intent.owner_id || lease.privacy_epoch !== intent.privacy_epoch || !validOpaqueId(lease.note_id) || !validInt(lease.note_revision, 1) ||
            typeof lease.sha256 !== 'string' || !SHA256.test(lease.sha256) || !validInt(lease.byte_length, 1) || lease.byte_length > MAX_AUDIO_BYTES ||
            typeof lease.duration_seconds !== 'number' || !Number.isFinite(lease.duration_seconds) || lease.duration_seconds <= 0 ||
            !validUuid(lease.process_id) || !validInt(lease.created_at)) throw new Error('media_invalid');
        if (lease.process_id === processInstanceId) throw new Error('current_holder');
      }
      for (const reader of readers) db.prepare(`DELETE FROM private_audio_readers WHERE reader_id=? AND media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=? AND process_id=?`)
        .run(reader.reader_id, intent.media_id, intent.workspace_id, intent.owner_id, intent.privacy_epoch, reader.process_id);
      for (const lease of leases) db.prepare(`DELETE FROM private_audio_speech_leases WHERE lease_id=? AND media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=? AND process_id=?`)
        .run(lease.lease_id, intent.media_id, intent.workspace_id, intent.owner_id, intent.privacy_epoch, lease.process_id);
      const directory = privateAudioWorkspaceRoot(privateRoot, intent.workspace_id);
      const tempPath = privateAudioStoragePath(directory, audio.temp_name);
      const finalPath = privateAudioStoragePath(directory, audio.final_name);
      if (dirname(tempPath) !== directory || dirname(finalPath) !== directory) throw new Error('path_invalid');
      return Object.freeze({ workspaceId: intent.workspace_id, ownerId: intent.owner_id, intentId: intent.intent_id, mediaId: intent.media_id,
        uploadId: audio.upload_id, privacyEpoch: intent.privacy_epoch, snapshotRevision: intent.snapshot_revision,
        tempName: audio.temp_name, finalName: audio.final_name, directory, tempPath, finalPath });
    });
  }

  private assertCurrentTicket(ticket: Ticket): void {
    const { kernel, capability } = this.options;
    kernel.withColdStartDatabaseTransaction(capability, (db) => {
      const intent = db.prepare('SELECT * FROM private_audio_cleanup_intents WHERE intent_id=?').get(ticket.intentId) as CleanupIntentRow | undefined;
      const audio = db.prepare('SELECT * FROM private_audio_uploads WHERE media_id=?').get(ticket.mediaId) as AudioRow | undefined;
      if (!intent || !audio) throw new Error('owner_changed');
      if (intent.intent_id !== ticket.intentId || intent.workspace_id !== ticket.workspaceId || intent.owner_id !== ticket.ownerId ||
          intent.media_id !== ticket.mediaId || intent.privacy_epoch !== ticket.privacyEpoch || intent.snapshot_revision !== ticket.snapshotRevision ||
          audio.upload_id !== ticket.uploadId || audio.workspace_id !== ticket.workspaceId || audio.owner_id !== ticket.ownerId ||
          audio.media_id !== ticket.mediaId || audio.privacy_epoch !== ticket.privacyEpoch || audio.temp_name !== ticket.tempName || audio.final_name !== ticket.finalName) throw new Error('owner_changed');
      if (intent.status === 'complete' && audio.status === 'unavailable') {
        validateCompletedRows(intent, audio);
        this.validateCaptureRows(db, audio, intent as ValidIntent);
        validateWorkspaceAndSnapshot(kernel, capability, db, intent as ValidIntent);
        validateCommandLineage(db, intent as ValidIntent);
        return;
      }
      validateIntent(intent);
      validateAudio(audio, intent);
      validateWorkspaceAndSnapshot(kernel, capability, db, intent);
      validateCommandLineage(db, intent);
    });
  }

  private async unlinkTicketFile(ticket: Ticket, path: string): Promise<void> {
    this.assertCurrentTicket(ticket);
    await this.assertStoragePathSafe(ticket, path);
    this.assertCurrentTicket(ticket);
    try { await this.remove(path); }
    catch { throw new Error('unlink_pending'); }
    this.operations.afterUnlink?.(ticket.intentId);
    this.assertCurrentTicket(ticket);
  }

  private async assertStoragePathSafe(ticket: Ticket, target: string): Promise<void> {
    const base = resolve(this.options.privateRoot);
    const directory = ticket.directory;
    for (const dir of [base, directory]) {
      let info;
      try { info = await lstat(dir); }
      catch (error) { if (isMissing(error)) return; throw new Error('path_invalid'); }
      this.assertCurrentTicket(ticket);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('path_invalid');
    }
    let file;
    try { file = await lstat(target); }
    catch (error) { if (isMissing(error)) return; throw new Error('path_invalid'); }
    this.assertCurrentTicket(ticket);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('path_invalid');
  }

  private syncTicketDirectory(ticket: Ticket): void {
    this.assertCurrentTicket(ticket);
    if (this.operations.syncDirectory) {
      try { this.operations.syncDirectory(ticket.directory, (fd) => this.closeOwnedDescriptor(fd)); }
      catch { throw new Error('directory_sync_pending'); }
      return;
    }
    let fd: number | undefined;
    try {
      fd = openSync(ticket.directory, constants.O_RDONLY);
      fsyncSync(fd);
      this.closeOwnedDescriptor(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) this.ownedDescriptors.add(fd);
      const code = fsCode(error);
      if (isUnsupportedDirectorySyncError(process.platform, code)) {
        if (fd !== undefined) { this.closeOwnedDescriptor(fd); this.ownedDescriptors.delete(fd); }
        return;
      }
      throw new Error('directory_sync_pending');
    }
  }

  private closeOwnedDescriptor(fd: number): void {
    try { this.closeDescriptor(fd); this.ownedDescriptors.delete(fd); }
    catch (error) { this.ownedDescriptors.add(fd); throw error; }
  }

  private completeTicket(ticket: Ticket): void {
    const { kernel, capability } = this.options;
    kernel.withColdStartDatabaseTransaction(capability, (db) => {
      const intent = db.prepare('SELECT * FROM private_audio_cleanup_intents WHERE intent_id=?').get(ticket.intentId) as CleanupIntentRow | undefined;
      const audio = db.prepare('SELECT * FROM private_audio_uploads WHERE media_id=?').get(ticket.mediaId) as AudioRow | undefined;
      if (!intent || !audio) throw new Error('completion_pending');
      if (intent.intent_id !== ticket.intentId || intent.workspace_id !== ticket.workspaceId || intent.owner_id !== ticket.ownerId ||
          intent.privacy_epoch !== ticket.privacyEpoch || intent.snapshot_revision !== ticket.snapshotRevision || intent.media_id !== ticket.mediaId ||
          audio.upload_id !== ticket.uploadId || audio.workspace_id !== ticket.workspaceId || audio.owner_id !== ticket.ownerId || audio.privacy_epoch !== ticket.privacyEpoch ||
          audio.media_id !== ticket.mediaId || audio.temp_name !== ticket.tempName || audio.final_name !== ticket.finalName) throw new Error('completion_pending');
      if (intent.status === 'complete' && audio.status === 'unavailable') {
        validateCompletedRows(intent, audio);
        this.validateCaptureRows(db, audio, intent as ValidIntent);
        validateWorkspaceAndSnapshot(kernel, capability, db, intent as ValidIntent);
        validateCommandLineage(db, intent as ValidIntent);
        return;
      }
      validateIntent(intent);
      validateAudio(audio, intent);
      validateWorkspaceAndSnapshot(kernel, capability, db, intent);
      validateCommandLineage(db, intent);
      const now = Date.now();
      const audioChanged = db.prepare(`UPDATE private_audio_uploads SET status='unavailable',updated_at=? WHERE upload_id=? AND media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=? AND status='deletion_pending'`)
        .run(now, ticket.uploadId, ticket.mediaId, ticket.workspaceId, ticket.ownerId, ticket.privacyEpoch);
      if (audioChanged.changes !== 1) throw new Error('completion_pending');
      const intentChanged = db.prepare(`UPDATE private_audio_cleanup_intents SET status='complete',updated_at=? WHERE intent_id=? AND media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=? AND status='pending'`)
        .run(now, ticket.intentId, ticket.mediaId, ticket.workspaceId, ticket.ownerId, ticket.privacyEpoch);
      if (intentChanged.changes !== 1) throw new Error('completion_pending');
    });
  }

  private isExactCompleted(ticket: Ticket): boolean {
    return this.options.kernel.withColdStartDatabaseTransaction(this.options.capability, (db) => {
      const intent = db.prepare('SELECT * FROM private_audio_cleanup_intents WHERE intent_id=?').get(ticket.intentId) as CleanupIntentRow | undefined;
      const audio = db.prepare('SELECT * FROM private_audio_uploads WHERE upload_id=?').get(ticket.uploadId) as AudioRow | undefined;
      if (!intent || !audio || intent.status !== 'complete' || audio.status !== 'unavailable') return false;
      try {
        if (intent.intent_id !== ticket.intentId || intent.workspace_id !== ticket.workspaceId || intent.owner_id !== ticket.ownerId || intent.privacy_epoch !== ticket.privacyEpoch ||
            intent.media_id !== ticket.mediaId || intent.snapshot_revision !== ticket.snapshotRevision || audio.upload_id !== ticket.uploadId || audio.workspace_id !== ticket.workspaceId ||
            audio.owner_id !== ticket.ownerId || audio.privacy_epoch !== ticket.privacyEpoch || audio.media_id !== ticket.mediaId || audio.temp_name !== ticket.tempName || audio.final_name !== ticket.finalName) return false;
        validateCompletedRows(intent, audio);
        this.validateCaptureRows(db, audio, intent as ValidIntent);
        validateWorkspaceAndSnapshot(this.options.kernel, this.options.capability, db, intent as ValidIntent);
        validateCommandLineage(db, intent as ValidIntent);
        return true;
      } catch { return false; }
    });
  }

  private validateCaptureLineage(db: import('better-sqlite3').Database, capture: Record<string, unknown>, audio: AudioRow, intent: ValidIntent): void {
    const capturedAt = typeof capture.captured_at === 'string' ? Date.parse(capture.captured_at) : NaN;
    if (capture.upload_id !== audio.upload_id || capture.media_id !== audio.media_id || capture.workspace_id !== intent.workspace_id ||
        capture.owner_id !== intent.owner_id || capture.privacy_epoch !== intent.privacy_epoch || capture.status !== 'consumed' ||
        !validUuid(capture.capture_id) || !validUuid(capture.capture_revision) ||
        !Number.isFinite(capturedAt) || new Date(capturedAt).toISOString() !== capture.captured_at || !validTimeZone(capture.time_zone) || typeof capture.mime_type !== 'string' ||
        capture.mime_type !== audio.mime_type || capture.format !== audio.format || capture.sha256 !== audio.sha256 ||
        capture.expected_bytes !== audio.expected_bytes || capture.byte_length !== audio.byte_length || capture.duration_seconds !== audio.duration_seconds ||
        typeof capture.sha256 !== 'string' || !SHA256.test(capture.sha256) || !validInt(capture.byte_length, 1) ||
        typeof capture.duration_seconds !== 'number' || !Number.isFinite(capture.duration_seconds) || capture.duration_seconds <= 0 || capture.failure_code !== null ||
        !validUuid(capture.consumed_command_id) || capture.note_id !== intent.source_note_id || !validInt(capture.note_revision, 1) ||
        !validTimestampPair(capture.created_at, capture.updated_at)) throw new Error('media_invalid');
    const head = db.prepare('SELECT revision FROM workspaces WHERE id=? AND owner_id=? AND privacy_epoch>=?')
      .get(intent.workspace_id, intent.owner_id, intent.privacy_epoch) as { revision: unknown } | undefined;
    if (!head || !validInt(head.revision)) throw new Error('lineage_invalid');
    const command = readAsyncJournalRow(db, intent.workspace_id, capture.consumed_command_id);
    validateAsyncJournalEnvelope(command, { workspaceId: intent.workspace_id, ownerId: intent.owner_id,
      privacyEpoch: intent.privacy_epoch, commandId: capture.consumed_command_id, headRevision: head.revision });
    if (command.command_kind !== 'notes.capture.adopt' || command.status !== 'finished' ||
        !(JSON.parse(command.owned_object_ids_json as string) as Record<string, string[]>).notes?.includes(capture.note_id as string)) {
      throw new Error('lineage_invalid');
    }
    const receipt = readJournalReceipt(command);
    if (Object.keys(receipt).sort().join('\0') !== ['captureId', 'captureRevision', 'commandId', 'kind', 'objectId', 'schemaVersion'].sort().join('\0') ||
        receipt.schemaVersion !== 1 || receipt.kind !== 'notes.capture.adopt' || receipt.commandId !== capture.consumed_command_id ||
        receipt.objectId !== capture.note_id || receipt.captureId !== capture.capture_id || receipt.captureRevision !== capture.capture_revision) {
      throw new Error('lineage_invalid');
    }
  }

  private validateCaptureRows(db: import('better-sqlite3').Database, audio: AudioRow, intent: ValidIntent): void {
    const rows = db.prepare('SELECT * FROM private_audio_capture_uploads WHERE upload_id=?').all(audio.upload_id) as Record<string, unknown>[];
    if (rows.length > 1) throw new Error('media_invalid');
    if (rows.length === 1) this.validateCaptureLineage(db, rows[0]!, audio, intent);
  }
}

function validateCompletedRows(intent: CleanupIntentRow, audio: AudioRow): void {
  validateIntent({ ...intent, status: 'pending' });
  if (audio.status !== 'unavailable') throw new Error('media_invalid');
  validateAudio({ ...audio, status: 'deletion_pending' }, intent as ValidIntent);
}

export async function recoverPendingPrivateAudioAtStartup(options: AudioColdStartRecoveryOptions): Promise<readonly AudioColdStartRecoveryOutcome[]> {
  return new AudioColdStartRecovery(options).run();
}
