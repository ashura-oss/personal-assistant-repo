import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ApplicationStartupCapability } from './applicationStartup.js';
import type { OwnedTransactionContext, DurableKernel } from './kernel.js';

const SCHEMA_VERSION = 2;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V1_8 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE_MAX = 100;
const COMMAND_JOURNAL_SCHEMA_VERSION = 3;

/** A closed, content-free projection from the trusted cloud ledger validator. */
export interface BatchObservationLedgerProjection {
  readonly schemaVersion: 1;
  readonly valid: boolean;
  readonly jobs: readonly BatchObservationJobProjection[];
}
export interface BatchObservationJobProjection {
  readonly jobId: string;
  readonly customId: string;
  readonly batchId?: string;
  readonly requestSha256: string;
  readonly status: 'preparing' | 'submitting' | 'submission_unknown' | 'queued' | 'processing' | 'completed' | 'failed' | 'expired' | 'cancelled' | 'result_stale' | 'result_invalid' | 'result_truncated' | 'result_not_retained' | 'cleanup_pending' | 'terminal' | 'source_removed';
  readonly terminalObserved: boolean;
}

export interface BatchObservationAttempt {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly jobId: string;
  readonly batchId: string;
  readonly customId: string;
  readonly requestSha256: string;
  readonly commandId: string;
}

interface JobRow {
  job_id: string; custom_id: string; batch_id: string | null; request_sha256: string; ledger_status: string;
  state: 'due' | 'held' | 'terminal' | 'quarantined'; next_due_at: number; updated_at: number;
}

function fail(code: string): never { throw new Error(code); }
function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function safeId(value: unknown, max = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && validUnicode(value) && Buffer.byteLength(value, 'utf8') <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function validProjection(value: unknown): BatchObservationLedgerProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('batch_observation_projection_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'jobs,schemaVersion,valid' || row.schemaVersion !== 1 || typeof row.valid !== 'boolean' || !Array.isArray(row.jobs)) {
    return fail('batch_observation_projection_invalid');
  }
  const seen = new Set<string>();
  const jobs = row.jobs.map((candidate): BatchObservationJobProjection => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fail('batch_observation_projection_invalid');
    const item = candidate as Record<string, unknown>;
    const keys = Object.keys(item).sort().join(',');
    if (keys !== 'customId,jobId,requestSha256,status,terminalObserved' && keys !== 'batchId,customId,jobId,requestSha256,status,terminalObserved') {
      return fail('batch_observation_projection_invalid');
    }
    if (typeof item.jobId !== 'string' || !UUID_V1_8.test(item.jobId) || !safeId(item.customId) || item.batchId !== undefined && !safeId(item.batchId) ||
        typeof item.requestSha256 !== 'string' || !SHA256.test(item.requestSha256) ||
        typeof item.status !== 'string' || !['preparing', 'submitting', 'submission_unknown', 'queued', 'processing', 'completed', 'failed', 'expired', 'cancelled', 'result_stale', 'result_invalid', 'result_truncated', 'result_not_retained', 'cleanup_pending', 'terminal', 'source_removed'].includes(item.status) ||
        typeof item.terminalObserved !== 'boolean' || seen.has(item.jobId)) return fail('batch_observation_projection_invalid');
    if ((item.status === 'queued' || item.status === 'processing') && !item.batchId) return fail('batch_observation_projection_invalid');
    if (item.terminalObserved && !item.batchId) return fail('batch_observation_projection_invalid');
    seen.add(item.jobId);
    return Object.freeze({ jobId: item.jobId, customId: item.customId, ...(item.batchId === undefined ? {} : { batchId: item.batchId }),
      requestSha256: item.requestSha256, status: item.status as BatchObservationJobProjection['status'], terminalObserved: item.terminalObserved });
  });
  if (!row.valid && jobs.length !== 0) return fail('batch_observation_projection_invalid');
  return Object.freeze({ schemaVersion: 1, valid: row.valid, jobs: Object.freeze(jobs) });
}

function validateSchemaObjects(db: OwnedTransactionContext['db']): void {
  const expectedColumns: Readonly<Record<string, readonly Readonly<{ name: string; type: string; notnull: number; pk: number }> []>> = {
    batch_observation_meta: [{ name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 }, { name: 'schema_version', type: 'INTEGER', notnull: 1, pk: 0 }],
    batch_observation_workspaces: [{ name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 }, { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 }, { name: 'quarantined', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 }],
    batch_observation_jobs: [{ name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 }, { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 }, { name: 'job_id', type: 'TEXT', notnull: 1, pk: 4 },
      { name: 'custom_id', type: 'TEXT', notnull: 1, pk: 0 }, { name: 'batch_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'request_sha256', type: 'TEXT', notnull: 1, pk: 0 }, { name: 'ledger_status', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'state', type: 'TEXT', notnull: 1, pk: 0 }, { name: 'next_due_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 }],
    batch_observation_attempts: [{ name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 }, { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 }, { name: 'attempt_id', type: 'TEXT', notnull: 1, pk: 4 },
      { name: 'job_id', type: 'TEXT', notnull: 1, pk: 0 }, { name: 'batch_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'custom_id', type: 'TEXT', notnull: 1, pk: 0 }, { name: 'request_sha256', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'command_id', type: 'TEXT', notnull: 1, pk: 0 }, { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'next_due_at', type: 'INTEGER', notnull: 1, pk: 0 }, { name: 'result_code', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 }, { name: 'settled_at', type: 'INTEGER', notnull: 0, pk: 0 },
      { name: 'finalization_request_json', type: 'TEXT', notnull: 0, pk: 0 }, { name: 'finalization_digest', type: 'TEXT', notnull: 0, pk: 0 }],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const exists = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) fail('batch_observation_schema_invalid');
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; pk: number }[];
    if (JSON.stringify(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))) !== JSON.stringify(expected)) fail('batch_observation_schema_invalid');
  }
  const requiredIndexes = [
    ['batch_observation_due_idx', 'batch_observation_jobs', 0, 'state,next_due_at,workspace_id,job_id', null],
    ['batch_observation_one_live_attempt', 'batch_observation_attempts', 1, 'workspace_id,owner_id,privacy_epoch,job_id', "status IN ('claimed','dispatched')"],
  ] as const;
  for (const [name, table, unique, columns, predicate] of requiredIndexes) {
    const index = db.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as { tbl_name: string; sql: string | null } | undefined;
    const info = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string; unique: number }[];
    const row = info.find((item) => item.name === name);
    if (!index || index.tbl_name !== table || !row || row.unique !== unique) fail('batch_observation_schema_invalid');
    const indexColumns = db.prepare(`PRAGMA index_info(${name})`).all() as { name: string }[];
    if (indexColumns.map((item) => item.name).join(',') !== columns) fail('batch_observation_schema_invalid');
    if (predicate) {
      const normalized = index.sql?.replace(/[\s"`\[\]]/g, '').toLowerCase() ?? '';
      if (!normalized.endsWith(`where${predicate.replace(/[\s"`\[\]]/g, '').toLowerCase()}`)) fail('batch_observation_schema_invalid');
    } else if (/\bwhere\b/i.test(index.sql ?? '')) fail('batch_observation_schema_invalid');
  }
}

function ensureSchemaDb(db: OwnedTransactionContext['db']): void {
  const existingMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_observation_meta'").get();
  if (existingMeta) {
    const metaColumns = db.prepare('PRAGMA table_info(batch_observation_meta)').all() as { name: string }[];
    if (metaColumns.map((column) => column.name).join(',') !== 'singleton,schema_version') fail('batch_observation_schema_invalid');
    const meta = db.prepare('SELECT schema_version FROM batch_observation_meta WHERE singleton=1').get() as { schema_version: number } | undefined;
    if (!meta || meta.schema_version !== SCHEMA_VERSION) fail('batch_observation_schema_unsupported');
    validateSchemaObjects(db);
  } else {
    const partialTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'batch_observation_%'").all();
    if (partialTables.length !== 0) fail('batch_observation_schema_invalid');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS batch_observation_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=2)
  ) STRICT;
  INSERT OR IGNORE INTO batch_observation_meta(singleton,schema_version) VALUES(1,2);
  CREATE TABLE IF NOT EXISTS batch_observation_workspaces (
    workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
    quarantined INTEGER NOT NULL CHECK(quarantined IN (0,1)), updated_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS batch_observation_jobs (
    workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL,
    job_id TEXT NOT NULL, custom_id TEXT NOT NULL, batch_id TEXT, request_sha256 TEXT NOT NULL,
    ledger_status TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('due','held','terminal','quarantined')),
    next_due_at INTEGER NOT NULL CHECK(next_due_at>=0), updated_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,job_id),
    FOREIGN KEY(workspace_id,owner_id,privacy_epoch) REFERENCES batch_observation_workspaces(workspace_id,owner_id,privacy_epoch) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS batch_observation_due_idx ON batch_observation_jobs(state,next_due_at,workspace_id,job_id);
  CREATE TABLE IF NOT EXISTS batch_observation_attempts (
    workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL,
    attempt_id TEXT NOT NULL, job_id TEXT NOT NULL, batch_id TEXT NOT NULL, custom_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL, command_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('claimed','dispatched','deferred','completed','inspect_required')),
    next_due_at INTEGER NOT NULL CHECK(next_due_at>=0), result_code TEXT, created_at INTEGER NOT NULL, settled_at INTEGER,
    finalization_request_json TEXT, finalization_digest TEXT,
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,attempt_id),
    FOREIGN KEY(workspace_id,owner_id,privacy_epoch,job_id) REFERENCES batch_observation_jobs(workspace_id,owner_id,privacy_epoch,job_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS batch_observation_one_live_attempt ON batch_observation_attempts(workspace_id,owner_id,privacy_epoch,job_id)
    WHERE status IN ('claimed','dispatched');`);
  validateSchemaObjects(db);
}

function ensureSchema(context: OwnedTransactionContext): void {
  context.assertActive();
  ensureSchemaDb(context.db);
}

function checkScope(context: OwnedTransactionContext, expectedPrivacyEpoch: number): void {
  context.assertActive();
  if (!Number.isSafeInteger(expectedPrivacyEpoch) || expectedPrivacyEpoch !== context.privacyEpoch) fail('stale_epoch');
}

/** Private metadata index. The current workspace ledger remains the sole authority. */
export class BatchObservationIndex {
  hasWorkspaceScope(context: OwnedTransactionContext, expectedPrivacyEpoch: number): boolean {
    checkScope(context, expectedPrivacyEpoch); ensureSchema(context);
    const row = context.db.prepare(`SELECT 1 AS present FROM batch_observation_workspaces
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`).get(context.workspaceId, context.ownerId, context.privacyEpoch);
    return Boolean(row);
  }

  /** Reconciles one exact current ledger projection. Called only in the snapshot transaction/participant. */
  reconcile(context: OwnedTransactionContext, projectionInput: unknown, now: number): void {
    checkScope(context, context.privacyEpoch);
    if (!Number.isSafeInteger(now) || now < 0) fail('batch_observation_time_invalid');
    const projection = validProjection(projectionInput);
    ensureSchema(context);
    context.db.prepare(`INSERT INTO batch_observation_workspaces(workspace_id,owner_id,privacy_epoch,quarantined,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,owner_id,privacy_epoch) DO UPDATE SET quarantined=excluded.quarantined,updated_at=excluded.updated_at`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, projection.valid ? 0 : 1, now);
    if (!projection.valid) {
      context.db.prepare(`UPDATE batch_observation_jobs SET state='quarantined',updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch);
      return;
    }
    const upsert = context.db.prepare(`INSERT INTO batch_observation_jobs(workspace_id,owner_id,privacy_epoch,job_id,custom_id,batch_id,request_sha256,ledger_status,state,next_due_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,owner_id,privacy_epoch,job_id) DO UPDATE SET
      custom_id=excluded.custom_id,batch_id=excluded.batch_id,request_sha256=excluded.request_sha256,ledger_status=excluded.ledger_status,
      state=excluded.state,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at`);
    const activeJobs = new Set<string>();
    for (const job of projection.jobs) {
      activeJobs.add(job.jobId);
      const state: JobRow['state'] = job.terminalObserved ? 'terminal'
        : (job.status === 'queued' || job.status === 'processing' || job.status === 'source_removed') && job.batchId ? 'due' : 'held';
      const previous = context.db.prepare(`SELECT custom_id,batch_id,request_sha256,state,next_due_at FROM batch_observation_jobs
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, job.jobId) as Pick<JobRow, 'custom_id' | 'batch_id' | 'request_sha256' | 'state' | 'next_due_at'> | undefined;
      const sameProviderRequest = previous?.custom_id === job.customId && previous.batch_id === (job.batchId ?? null) && previous.request_sha256 === job.requestSha256;
      const latestFinalization = context.db.prepare(`SELECT next_due_at,status FROM batch_observation_attempts
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=? AND batch_id IS ? AND custom_id=? AND request_sha256=?
          AND status IN ('deferred','completed','inspect_required')
        ORDER BY created_at DESC,attempt_id DESC LIMIT 1`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, job.jobId, job.batchId ?? null, job.customId, job.requestSha256) as { next_due_at: number; status: string } | undefined;
      const hasActiveAttempt = context.db.prepare(`SELECT 1 FROM batch_observation_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?
        AND batch_id IS ? AND custom_id=? AND request_sha256=? AND status IN ('claimed','dispatched') LIMIT 1`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, job.jobId, job.batchId ?? null, job.customId, job.requestSha256);
      const terminalForExactRequest = sameProviderRequest && previous?.state === 'terminal';
      const effectiveState = terminalForExactRequest ? 'terminal' : state;
      // Preserve the durable current schedule for an exact provider request. Historical attempts
      // must never shorten a newer Retry-After; only a new exact provider identity may be repaired
      // from its latest immutable finalization record.
      const due = effectiveState !== 'due' ? now : hasActiveAttempt ? Number.MAX_SAFE_INTEGER
        : sameProviderRequest ? previous!.next_due_at : Math.max(now, latestFinalization?.next_due_at ?? now);
      upsert.run(context.workspaceId, context.ownerId, context.privacyEpoch, job.jobId, job.customId, job.batchId ?? null,
        job.requestSha256, job.status, effectiveState, due, now);
    }
    const existing = context.db.prepare('SELECT job_id FROM batch_observation_jobs WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?')
      .all(context.workspaceId, context.ownerId, context.privacyEpoch) as { job_id: string }[];
    for (const row of existing) if (!activeJobs.has(row.job_id)) {
      context.db.prepare('UPDATE batch_observation_jobs SET state=\'held\',updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?')
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, row.job_id);
    }
  }

  readNextDueAt(context: OwnedTransactionContext, expectedPrivacyEpoch: number): number | null {
    checkScope(context, expectedPrivacyEpoch); ensureSchema(context);
    const row = context.db.prepare(`SELECT MIN(j.next_due_at) AS due FROM batch_observation_jobs j
      JOIN batch_observation_workspaces w USING(workspace_id,owner_id,privacy_epoch)
      WHERE j.workspace_id=? AND j.owner_id=? AND j.privacy_epoch=? AND j.state='due' AND w.quarantined=0`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch) as { due: number | null };
    return row.due;
  }

  listDue(context: OwnedTransactionContext, expectedPrivacyEpoch: number, now: number, afterJobId?: string, limit = PAGE_MAX): readonly JobRow[] {
    checkScope(context, expectedPrivacyEpoch); ensureSchema(context);
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX || afterJobId !== undefined && !safeId(afterJobId)) fail('batch_observation_query_invalid');
    return Object.freeze(context.db.prepare(`SELECT j.job_id,j.custom_id,j.batch_id,j.request_sha256,j.ledger_status,j.state,j.next_due_at,j.updated_at
      FROM batch_observation_jobs j JOIN batch_observation_workspaces w USING(workspace_id,owner_id,privacy_epoch)
      WHERE j.workspace_id=? AND j.owner_id=? AND j.privacy_epoch=? AND j.state='due' AND j.next_due_at<=? AND w.quarantined=0 AND (? IS NULL OR j.job_id>?)
      ORDER BY j.job_id LIMIT ?`).all(context.workspaceId, context.ownerId, context.privacyEpoch, now, afterJobId ?? null, afterJobId ?? null, limit) as JobRow[]);
  }

  /** Revalidates the exact job authority against a fresh owned-snapshot projection before dispatch. */
  assertClaimMatchesCurrentLedger(context: OwnedTransactionContext, attempt: BatchObservationAttempt, projectionInput: unknown): void {
    this.#exact(context, attempt);
    const projection = validProjection(projectionInput);
    if (!projection.valid) fail('batch_observation_ledger_quarantined');
    const job = projection.jobs.find((item) => item.jobId === attempt.jobId);
    if (!job || job.batchId !== attempt.batchId || job.customId !== attempt.customId || job.requestSha256 !== attempt.requestSha256 ||
        !((job.status === 'queued' || job.status === 'processing' || job.status === 'source_removed') && !job.terminalObserved)) {
      fail('batch_observation_job_changed');
    }
    const row = context.db.prepare(`SELECT state,custom_id,batch_id,request_sha256 FROM batch_observation_jobs
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, attempt.jobId) as Pick<JobRow, 'state' | 'custom_id' | 'batch_id' | 'request_sha256'> | undefined;
    if (!row || row.custom_id !== attempt.customId || row.batch_id !== attempt.batchId || row.request_sha256 !== attempt.requestSha256 ||
        row.state === 'quarantined' || row.state === 'terminal') fail('batch_observation_job_changed');
  }

  claim(context: OwnedTransactionContext, expectedPrivacyEpoch: number, jobId: string, now: number): BatchObservationAttempt | undefined {
    checkScope(context, expectedPrivacyEpoch); ensureSchema(context);
    if (!safeId(jobId) || !Number.isSafeInteger(now) || now < 0) fail('batch_observation_claim_invalid');
    const row = context.db.prepare(`SELECT j.job_id,j.custom_id,j.batch_id,j.request_sha256,j.ledger_status,j.state,j.next_due_at,j.updated_at
      FROM batch_observation_jobs j JOIN batch_observation_workspaces w USING(workspace_id,owner_id,privacy_epoch)
      WHERE j.workspace_id=? AND j.owner_id=? AND j.privacy_epoch=? AND j.job_id=? AND j.state='due' AND j.next_due_at<=? AND w.quarantined=0`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, jobId, now) as JobRow | undefined;
    if (!row?.batch_id || (row.ledger_status !== 'queued' && row.ledger_status !== 'processing' && row.ledger_status !== 'source_removed')) return undefined;
    const attemptId = randomUUID();
    try {
      context.db.prepare(`INSERT INTO batch_observation_attempts(workspace_id,owner_id,privacy_epoch,attempt_id,job_id,batch_id,custom_id,request_sha256,
        command_id,status,next_due_at,result_code,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,'claimed',?,NULL,?,NULL)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, attemptId, row.job_id, row.batch_id, row.custom_id,
          row.request_sha256, attemptId, now, now);
    } catch (error) {
      if (String((error as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT')) return undefined;
      throw error;
    }
    context.db.prepare(`UPDATE batch_observation_jobs SET next_due_at=?,updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .run(Number.MAX_SAFE_INTEGER, now, context.workspaceId, context.ownerId, context.privacyEpoch, row.job_id);
    return Object.freeze({ attemptId, workspaceId: context.workspaceId, ownerId: context.ownerId, privacyEpoch: context.privacyEpoch,
      jobId: row.job_id, batchId: row.batch_id, customId: row.custom_id, requestSha256: row.request_sha256, commandId: attemptId });
  }

  holdUnacknowledged(context: OwnedTransactionContext, expectedPrivacyEpoch: number, jobId: string, now: number): void {
    checkScope(context, expectedPrivacyEpoch);
    if (!safeId(jobId) || !Number.isSafeInteger(now) || now < 0) fail('batch_observation_claim_invalid');
    const active = context.db.prepare(`SELECT attempt_id FROM batch_observation_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?
      AND status IN ('claimed','dispatched') ORDER BY created_at DESC LIMIT 1`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, jobId) as { attempt_id: string } | undefined;
    if (!active) return;
    context.db.prepare(`UPDATE batch_observation_attempts SET status='inspect_required',next_due_at=?,result_code='claim_outcome_unknown',settled_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status IN ('claimed','dispatched')`)
      .run(Number.MAX_SAFE_INTEGER, now, context.workspaceId, context.ownerId, context.privacyEpoch, active.attempt_id);
    context.db.prepare(`UPDATE batch_observation_jobs SET state='held',next_due_at=?,updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .run(Number.MAX_SAFE_INTEGER, now, context.workspaceId, context.ownerId, context.privacyEpoch, jobId);
  }

  markDispatched(context: OwnedTransactionContext, attempt: BatchObservationAttempt, now: number): void {
    this.#exact(context, attempt);
    if (!Number.isSafeInteger(now) || now < 0) fail('batch_observation_time_invalid');
    const result = context.db.prepare(`UPDATE batch_observation_attempts SET status='dispatched' WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status='claimed'`)
      .run(attempt.workspaceId, attempt.ownerId, attempt.privacyEpoch, attempt.attemptId);
    if (result.changes !== 1) fail('batch_observation_attempt_stale');
    void now;
  }

  nextRetryAt(context: OwnedTransactionContext, attempt: BatchObservationAttempt, now: number, retryAfterMs?: number): number {
    this.#exact(context, attempt);
    if (!Number.isSafeInteger(now) || now < 0 || retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) {
      fail('batch_observation_outcome_invalid');
    }
    const row = context.db.prepare(`SELECT COUNT(*) AS attempts FROM batch_observation_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .get(attempt.workspaceId, attempt.ownerId, attempt.privacyEpoch, attempt.jobId) as { attempts: number };
    if (!Number.isSafeInteger(row.attempts) || row.attempts < 1) fail('batch_observation_storage_invalid');
    const delay = Math.min(60 * 60_000, 1_000 * (2 ** Math.min(12, row.attempts - 1)));
    const backoffAt = now + delay;
    if (!Number.isSafeInteger(backoffAt)) fail('batch_observation_time_invalid');
    return Math.max(backoffAt, retryAfterMs ?? 0);
  }

  settle(context: OwnedTransactionContext, attempt: BatchObservationAttempt, input: { readonly kind: 'deferred' | 'completed' | 'inspect_required'; readonly nextDueAt: number; readonly code: string; readonly terminal: boolean }, now: number): void {
    this.#exact(context, attempt);
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(input.nextDueAt) || input.nextDueAt < now ||
        !['deferred', 'completed', 'inspect_required'].includes(input.kind) || !/^[a-z][a-z0-9_:-]{0,95}$/.test(input.code) || typeof input.terminal !== 'boolean') fail('batch_observation_outcome_invalid');
    const status = input.kind;
    const finalization = JSON.stringify({ kind: input.kind, nextDueAt: input.nextDueAt, code: input.code, terminal: input.terminal, settledAt: now });
    const finalizationDigest = createHash('sha256').update(finalization).digest('hex');
    const prior = context.db.prepare(`SELECT status,finalization_request_json,finalization_digest FROM batch_observation_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?`)
      .get(attempt.workspaceId, attempt.ownerId, attempt.privacyEpoch, attempt.attemptId) as { status: string; finalization_request_json: string | null; finalization_digest: string | null } | undefined;
    if (!prior) fail('batch_observation_attempt_stale');
    if (prior.finalization_request_json !== null || prior.finalization_digest !== null) {
      if (prior.status !== status || prior.finalization_request_json !== finalization || prior.finalization_digest !== finalizationDigest) fail('batch_observation_finalization_conflict');
      return;
    }
    if (prior.status !== 'claimed' && prior.status !== 'dispatched') fail('batch_observation_attempt_stale');
    const update = context.db.prepare(`UPDATE batch_observation_attempts SET status=?,next_due_at=?,result_code=?,settled_at=?,finalization_request_json=?,finalization_digest=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status IN ('claimed','dispatched')
        AND finalization_request_json IS NULL AND finalization_digest IS NULL`)
      .run(status, input.nextDueAt, input.code, now, finalization, finalizationDigest, attempt.workspaceId, attempt.ownerId, attempt.privacyEpoch, attempt.attemptId);
    if (update.changes !== 1) fail('batch_observation_attempt_stale');
    const current = context.db.prepare(`SELECT custom_id,batch_id,request_sha256 FROM batch_observation_jobs
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .get(attempt.workspaceId, attempt.ownerId, attempt.privacyEpoch, attempt.jobId) as { custom_id: string; batch_id: string | null; request_sha256: string } | undefined;
    if (current?.custom_id === attempt.customId && current.batch_id === attempt.batchId && current.request_sha256 === attempt.requestSha256) {
      const updateJob = context.db.prepare(`UPDATE batch_observation_jobs SET state=?,next_due_at=?,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=? AND custom_id=? AND batch_id=? AND request_sha256=?`)
        .run(input.terminal || input.kind === 'completed' ? 'terminal' : input.kind === 'inspect_required' ? 'held' : 'due', input.nextDueAt,
          now, attempt.workspaceId, attempt.ownerId, attempt.privacyEpoch, attempt.jobId, attempt.customId, attempt.batchId, attempt.requestSha256);
      if (updateJob.changes !== 1) fail('batch_observation_storage_invalid');
    }
  }

  #exact(context: OwnedTransactionContext, attempt: BatchObservationAttempt): void {
    checkScope(context, attempt.privacyEpoch);
    if (attempt.workspaceId !== context.workspaceId || attempt.ownerId !== context.ownerId || !UUID_V4.test(attempt.attemptId) ||
        !UUID_V4.test(attempt.commandId) || attempt.commandId !== attempt.attemptId) fail('batch_observation_attempt_invalid');
    const row = context.db.prepare(`SELECT job_id,batch_id,custom_id,request_sha256,command_id FROM batch_observation_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attemptId) as { job_id: string; batch_id: string; custom_id: string; request_sha256: string; command_id: string } | undefined;
    if (!row || row.job_id !== attempt.jobId || row.batch_id !== attempt.batchId || row.custom_id !== attempt.customId ||
        row.request_sha256 !== attempt.requestSha256 || row.command_id !== attempt.commandId) fail('batch_observation_attempt_stale');
  }
}

const recoveredStartupCapabilities = new WeakSet<object>();

/**
 * Cold-start-only recovery. Exclusive startup ownership proves every persisted active attempt
 * belongs to a process that is no longer running. Since this lane only performs GET observations,
 * each interrupted attempt can be immutably finalized as deferred and retried with a fresh UUID.
 */
export function recoverInterruptedBatchObservations(kernel: DurableKernel, capability: ApplicationStartupCapability, now = Date.now()): number {
  if (!kernel || !capability || !Number.isSafeInteger(now) || now < 0 || recoveredStartupCapabilities.has(capability)) fail('batch_observation_startup_recovery_invalid');
  recoveredStartupCapabilities.add(capability);
  try {
    return kernel.withColdStartDatabaseTransaction(capability, (db) => {
      ensureSchemaDb(db);
      const rows = db.prepare(`SELECT a.workspace_id,a.owner_id,a.privacy_epoch,a.attempt_id,a.command_id,a.job_id,a.batch_id,a.custom_id,a.request_sha256
        FROM batch_observation_attempts a JOIN batch_observation_jobs j
          ON j.workspace_id=a.workspace_id AND j.owner_id=a.owner_id AND j.privacy_epoch=a.privacy_epoch AND j.job_id=a.job_id
        WHERE a.status IN ('claimed','dispatched')
        ORDER BY a.workspace_id,a.owner_id,a.privacy_epoch,a.created_at,a.attempt_id`)
        .all() as { workspace_id: string; owner_id: string; privacy_epoch: number; attempt_id: string; command_id: string; job_id: string; batch_id: string; custom_id: string; request_sha256: string }[];
      const settle = db.prepare(`UPDATE batch_observation_attempts SET status='deferred',next_due_at=?,result_code='interrupted_get_retry',settled_at=?,
        finalization_request_json=?,finalization_digest=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?
          AND status IN ('claimed','dispatched') AND finalization_request_json IS NULL AND finalization_digest IS NULL`);
      const schedule = db.prepare(`UPDATE batch_observation_jobs SET state='due',next_due_at=?,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=? AND batch_id=? AND custom_id=? AND request_sha256=?
          AND state<>'terminal'`);
      const hasJournal = Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='async_command_journal'").get());
      const hasJournalVersion = Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='command_journal_schema'").get());
      if (rows.length > 0 && hasJournal !== hasJournalVersion) fail('batch_observation_journal_schema_invalid');
      let readJournal: Database.Statement | undefined;
      let inspectJournal: Database.Statement | undefined;
      if (rows.length > 0 && hasJournal) {
        const versionColumns = db.pragma('table_info(command_journal_schema)') as { name: string }[];
        const journalColumns = db.pragma('table_info(async_command_journal)') as { name: string }[];
        if (versionColumns.map(({ name }) => name).join(',') !== 'singleton,version' ||
            !['workspace_id', 'idempotency_key', 'owner_id', 'command_kind', 'privacy_epoch', 'status', 'updated_at']
              .every((name) => journalColumns.some((column) => column.name === name))) {
          fail('batch_observation_journal_schema_invalid');
        }
        const version = db.prepare('SELECT version FROM command_journal_schema WHERE singleton=1').get() as { version: number } | undefined;
        if (!version || version.version !== COMMAND_JOURNAL_SCHEMA_VERSION) fail('batch_observation_journal_schema_invalid');
        readJournal = db.prepare(`SELECT workspace_id,owner_id,privacy_epoch,command_kind,status FROM async_command_journal
          WHERE workspace_id=? AND idempotency_key=?`);
        inspectJournal = db.prepare(`UPDATE async_command_journal SET status='inspect_required',updated_at=?
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND idempotency_key=? AND command_kind='assistant.batch.check'
            AND status IN ('claimed','checkpointed')`);
      }
      let recovered = 0;
      for (const row of rows) {
        if (!UUID_V4.test(row.attempt_id) || row.command_id !== row.attempt_id) fail('batch_observation_journal_link_invalid');
        const journal = readJournal?.get(row.workspace_id, row.command_id) as
          { workspace_id: string; owner_id: string; privacy_epoch: number; command_kind: string; status: string } | undefined;
        if (journal && (journal.workspace_id !== row.workspace_id || journal.owner_id !== row.owner_id || journal.privacy_epoch !== row.privacy_epoch ||
            journal.command_kind !== 'assistant.batch.check' ||
            !['claimed', 'checkpointed', 'finished', 'inspect_required'].includes(journal.status))) {
          fail('batch_observation_journal_link_invalid');
        }
        if (journal && (journal.status === 'claimed' || journal.status === 'checkpointed')) {
          const marked = inspectJournal?.run(now, row.workspace_id, row.owner_id, row.privacy_epoch, row.command_id);
          if (marked?.changes !== 1) fail('batch_observation_journal_link_invalid');
        }
        const finalization = JSON.stringify({ kind: 'deferred', nextDueAt: now, code: 'interrupted_get_retry', terminal: false, settledAt: now });
        const digest = createHash('sha256').update(finalization).digest('hex');
        const result = settle.run(now, now, finalization, digest, row.workspace_id, row.owner_id, row.privacy_epoch, row.attempt_id);
        if (result.changes !== 1) fail('batch_observation_startup_recovery_conflict');
        schedule.run(now, now, row.workspace_id, row.owner_id, row.privacy_epoch, row.job_id, row.batch_id, row.custom_id, row.request_sha256);
        recovered += 1;
      }
      return recovered;
    });
  } catch (error) {
    recoveredStartupCapabilities.delete(capability);
    throw error;
  }
}
