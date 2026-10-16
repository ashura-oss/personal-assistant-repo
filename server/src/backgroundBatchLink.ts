import type Database from 'better-sqlite3';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';

const VERSION = 1;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface BackgroundPaidBatchLinkInput {
  readonly occurrenceId: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly ticketId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly jobId: string;
  readonly customId: string;
  readonly requestSha256: string;
  readonly sourceDigest: string;
  readonly sourceVersionDigest?: string;
  readonly requestDigest: string;
  readonly createdAt: number;
}

export interface BackgroundPaidBatchJobLookup {
  readonly jobId: string;
  readonly customId: string;
  readonly requestSha256: string;
}

const COLUMNS = Object.freeze([
  ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3],
  ['occurrence_id', 'TEXT', 1, 4], ['attempt_id', 'TEXT', 1, 0], ['command_id', 'TEXT', 1, 0], ['ticket_id', 'TEXT', 1, 0],
  ['policy_id', 'TEXT', 1, 0], ['policy_revision', 'INTEGER', 1, 0], ['policy_digest', 'TEXT', 1, 0],
  ['job_id', 'TEXT', 1, 0], ['custom_id', 'TEXT', 1, 0], ['request_sha256', 'TEXT', 1, 0], ['source_digest', 'TEXT', 1, 0],
  ['source_version_digest', 'TEXT', 0, 0], ['request_digest', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0],
] as const);

function fail(code: string): never { throw new Error(code); }
function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function ensureSchema(db: Database.Database): void {
  const hasVersion = tableExists(db, 'background_paid_batch_link_schema');
  const hasTable = tableExists(db, 'background_paid_batch_links');
  if (!hasVersion && !hasTable) {
    db.exec(`CREATE TABLE background_paid_batch_link_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version>0)) STRICT;
      CREATE TABLE background_paid_batch_links(
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
        occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36), attempt_id TEXT NOT NULL CHECK(length(attempt_id)=36),
        command_id TEXT NOT NULL CHECK(length(command_id)=36), ticket_id TEXT NOT NULL CHECK(length(ticket_id)=36),
        policy_id TEXT NOT NULL CHECK(length(policy_id)=36), policy_revision INTEGER NOT NULL CHECK(policy_revision>0),
        policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64), job_id TEXT NOT NULL CHECK(length(job_id)=36),
        custom_id TEXT NOT NULL CHECK(length(custom_id)=36), request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        source_digest TEXT NOT NULL CHECK(length(source_digest)=64), source_version_digest TEXT CHECK(source_version_digest IS NULL OR length(source_version_digest)=64),
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64), created_at INTEGER NOT NULL CHECK(created_at>=0),
        PRIMARY KEY(workspace_id,owner_id,privacy_epoch,occurrence_id),
        CHECK(job_id=custom_id)
      ) STRICT;
      CREATE UNIQUE INDEX background_paid_batch_attempt_uq ON background_paid_batch_links(workspace_id,owner_id,privacy_epoch,attempt_id);
      CREATE UNIQUE INDEX background_paid_batch_command_uq ON background_paid_batch_links(workspace_id,owner_id,privacy_epoch,command_id);
      CREATE UNIQUE INDEX background_paid_batch_ticket_uq ON background_paid_batch_links(workspace_id,owner_id,privacy_epoch,ticket_id);
      CREATE UNIQUE INDEX background_paid_batch_job_uq ON background_paid_batch_links(workspace_id,owner_id,privacy_epoch,job_id);
      INSERT INTO background_paid_batch_link_schema(singleton,version) VALUES(1,${VERSION});`);
    return;
  }
  if (!hasVersion || !hasTable) return fail('background_paid_link_schema_invalid');
  const versionRows = db.prepare('SELECT singleton,version FROM background_paid_batch_link_schema').all() as { singleton: number; version: number }[];
  if (versionRows.length !== 1 || versionRows[0]?.singleton !== 1 || versionRows[0].version !== VERSION) return fail('background_paid_link_schema_invalid');
  const columns = db.pragma('table_info(background_paid_batch_links)') as { name: string; type: string; notnull: number; pk: number }[];
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_paid_batch_links'").get() as { sql: string } | undefined;
  if (!table?.sql || !/CHECK\s*\(\s*job_id\s*=\s*custom_id\s*\)/i.test(table.sql) ||
      columns.length !== COLUMNS.length || columns.some((column, index) => {
    const expected = COLUMNS[index]!;
    return column.name !== expected[0] || column.type.toUpperCase() !== expected[1] || column.notnull !== expected[2] || column.pk !== expected[3];
  })) return fail('background_paid_link_schema_invalid');
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='background_paid_batch_links'").all() as { name: string; sql: string | null }[];
  const required: Readonly<Record<string, readonly string[]>> = {
    background_paid_batch_attempt_uq: ['workspace_id', 'owner_id', 'privacy_epoch', 'attempt_id'],
    background_paid_batch_command_uq: ['workspace_id', 'owner_id', 'privacy_epoch', 'command_id'],
    background_paid_batch_ticket_uq: ['workspace_id', 'owner_id', 'privacy_epoch', 'ticket_id'],
    background_paid_batch_job_uq: ['workspace_id', 'owner_id', 'privacy_epoch', 'job_id'],
  };
  for (const [name, columnsForIndex] of Object.entries(required)) {
    const index = indexes.find((item) => item.name === name);
    const info = db.pragma(`index_info(${name})`) as { seqno: number; name: string }[];
    if (!index?.sql || !/^CREATE UNIQUE INDEX\s+background_paid_batch_(?:attempt|command|ticket|job)_uq\s+ON\s+background_paid_batch_links\s*\([^)]*\)\s*;?\s*$/i.test(index.sql) ||
        info.length !== columnsForIndex.length || info.some((column, position) => column.seqno !== position || column.name !== columnsForIndex[position])) {
      return fail('background_paid_link_schema_invalid');
    }
  }
}

/** Private additive map between a validated occurrence claim and its one durable Batch checkpoint. */
export class BackgroundBatchLinkStore {
  constructor(private readonly kernel: DurableKernel) {
    if (!kernel) throw new TypeError('background_paid_link_kernel_required');
  }

  /** Looks up a durable job link without creating schema or trusting job metadata. */
  readByJobWithinTransaction(context: OwnedTransactionContext, lookup: BackgroundPaidBatchJobLookup): BackgroundPaidBatchLinkInput | undefined {
    this.kernel.readOwnedSnapshotWithinTransaction(context);
    if (!lookup || !UUID_V4.test(lookup.jobId) || lookup.customId !== lookup.jobId || !SHA256.test(lookup.requestSha256)) {
      return fail('background_paid_link_invalid');
    }
    if (!tableExists(context.db, 'background_paid_batch_links')) return undefined;
    ensureSchema(context.db);
    const row = context.db.prepare(`SELECT occurrence_id,attempt_id,command_id,ticket_id,policy_id,policy_revision,policy_digest,job_id,custom_id,
      request_sha256,source_digest,source_version_digest,request_digest,created_at FROM background_paid_batch_links
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, lookup.jobId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (row.job_id !== lookup.jobId || row.custom_id !== lookup.customId || row.request_sha256 !== lookup.requestSha256 ||
        typeof row.occurrence_id !== 'string' || !UUID_V4.test(row.occurrence_id) || typeof row.attempt_id !== 'string' || !UUID_V4.test(row.attempt_id) ||
        typeof row.command_id !== 'string' || !UUID_V4.test(row.command_id) || typeof row.ticket_id !== 'string' || !UUID_V4.test(row.ticket_id) ||
        typeof row.policy_id !== 'string' || !UUID_V4.test(row.policy_id) || !Number.isSafeInteger(row.policy_revision) || (row.policy_revision as number) < 1 ||
        typeof row.policy_digest !== 'string' || !SHA256.test(row.policy_digest) || typeof row.source_digest !== 'string' || !SHA256.test(row.source_digest) ||
        (row.source_version_digest !== null && (typeof row.source_version_digest !== 'string' || !SHA256.test(row.source_version_digest))) ||
        typeof row.request_digest !== 'string' || !SHA256.test(row.request_digest) || !Number.isSafeInteger(row.created_at) || (row.created_at as number) < 0) {
      return fail('background_paid_link_storage_invalid');
    }
    return Object.freeze({ occurrenceId: row.occurrence_id, attemptId: row.attempt_id, commandId: row.command_id,
      ticketId: row.ticket_id, policyId: row.policy_id, policyRevision: row.policy_revision as number, policyDigest: row.policy_digest,
      jobId: row.job_id as string, customId: row.custom_id as string, requestSha256: row.request_sha256 as string,
      sourceDigest: row.source_digest, ...(row.source_version_digest === null ? {} : { sourceVersionDigest: row.source_version_digest as string }),
      requestDigest: row.request_digest, createdAt: row.created_at as number });
  }

  linkWithinTransaction(context: OwnedTransactionContext, input: BackgroundPaidBatchLinkInput): void {
    this.kernel.readOwnedSnapshotWithinTransaction(context);
    if (!input || !UUID_V4.test(input.occurrenceId) || !UUID_V4.test(input.attemptId) || !UUID_V4.test(input.commandId) ||
        !UUID_V4.test(input.ticketId) || !UUID_V4.test(input.policyId) || !Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1 ||
        !SHA256.test(input.policyDigest) || !UUID_V4.test(input.jobId) || input.customId !== input.jobId || !SHA256.test(input.requestSha256) ||
        !SHA256.test(input.sourceDigest) || (input.sourceVersionDigest !== undefined && !SHA256.test(input.sourceVersionDigest)) ||
        !SHA256.test(input.requestDigest) || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) return fail('background_paid_link_invalid');
    ensureSchema(context.db);
    try {
      context.db.prepare(`INSERT INTO background_paid_batch_links(workspace_id,owner_id,privacy_epoch,occurrence_id,attempt_id,command_id,ticket_id,
        policy_id,policy_revision,policy_digest,job_id,custom_id,request_sha256,source_digest,source_version_digest,request_digest,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, input.occurrenceId, input.attemptId, input.commandId, input.ticketId,
          input.policyId, input.policyRevision, input.policyDigest, input.jobId, input.customId, input.requestSha256, input.sourceDigest,
          input.sourceVersionDigest ?? null, input.requestDigest, input.createdAt);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
        return fail('background_paid_link_conflict');
      }
      throw error;
    }
  }

  /** Verifies the immutable checkpoint link while an already-owned request settles. */
  assertExistingLinkWithinTransaction(context: OwnedTransactionContext, input: BackgroundPaidBatchLinkInput): void {
    this.kernel.readOwnedSnapshotWithinTransaction(context);
    if (!input || !UUID_V4.test(input.occurrenceId) || !UUID_V4.test(input.attemptId) || !UUID_V4.test(input.commandId) ||
        !UUID_V4.test(input.ticketId) || !UUID_V4.test(input.jobId) || input.customId !== input.jobId) return fail('background_paid_link_invalid');
    ensureSchema(context.db);
    const row = context.db.prepare(`SELECT occurrence_id,attempt_id,command_id,ticket_id,policy_id,policy_revision,policy_digest,job_id,custom_id,
      request_sha256,source_digest,source_version_digest,request_digest,created_at FROM background_paid_batch_links
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, input.occurrenceId) as Record<string, unknown> | undefined;
    if (!row || row.occurrence_id !== input.occurrenceId || row.attempt_id !== input.attemptId || row.command_id !== input.commandId ||
        row.ticket_id !== input.ticketId || row.policy_id !== input.policyId || row.policy_revision !== input.policyRevision ||
        row.policy_digest !== input.policyDigest || row.job_id !== input.jobId || row.custom_id !== input.customId ||
        row.request_sha256 !== input.requestSha256 || row.source_digest !== input.sourceDigest ||
        row.source_version_digest !== (input.sourceVersionDigest ?? null) || row.request_digest !== input.requestDigest || row.created_at !== input.createdAt) {
      return fail('background_paid_link_missing');
    }
  }

  /** Proves an exact pre-dispatch failure has not acquired a paid Batch link. */
  assertNoLinkWithinTransaction(context: OwnedTransactionContext, occurrenceId: string, attemptId: string): void {
    this.kernel.readOwnedSnapshotWithinTransaction(context);
    if (!UUID_V4.test(occurrenceId) || !UUID_V4.test(attemptId)) return fail('background_paid_link_invalid');
    ensureSchema(context.db);
    const row = context.db.prepare(`SELECT attempt_id FROM background_paid_batch_links
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId) as { attempt_id: string } | undefined;
    if (row) return fail(row.attempt_id === attemptId ? 'background_paid_link_already_exists' : 'background_paid_link_conflict');
  }
}
