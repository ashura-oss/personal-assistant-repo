import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalBackgroundJson, type BackgroundPeriodKind } from './backgroundContracts.js';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import { registerWorkspaceEraseDeleteGuard } from './workspaceErase.js';

const VERSION = 1;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PERIOD_SUMMARY_CAPTURE_PRIVATE_TABLES = Object.freeze([
  'period_summary_capture_evidence',
  'period_summary_capture_phase',
] as const);

export interface PeriodSummaryCaptureEvidence {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly executionOptionsDigest: string;
  readonly occurrenceSourceDigest: string;
  readonly occurrenceRequestDigest: string;
  readonly occurrenceSourceVersionDigest: string | null;
  readonly occurrenceId: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly ticketId: string;
  readonly jobId: string;
  readonly customId: string;
  readonly requestSha256: string;
  readonly linkCreatedAt: number;
  readonly sourceManifestSha256: string;
  readonly sourceProofSha256: string;
  readonly sourceProofs: readonly Readonly<Record<string, unknown>>[];
  readonly period: BackgroundPeriodKind;
  readonly timeZone: string;
  readonly localInterval: Readonly<{ start: string; end: string }>;
  readonly utcInterval: Readonly<{ start: string; endExclusive: string }>;
  readonly preparedAt: string;
  readonly destination: Readonly<{
    path: string;
    documentId: string | null;
    expectedRevision: number | null;
    expectedAbsenceGeneration?: number;
  }>;
}

export type PeriodSummaryCapturePhase = 'preparing' | 'submitting' | 'submitted' | 'not_submitted' | 'inspect_required' | 'settled';

export interface PeriodSummaryCapturePhaseRecord {
  readonly jobId: string;
  readonly requestSha256: string;
  readonly phase: PeriodSummaryCapturePhase;
  readonly batchId?: string;
  readonly status?: string;
  readonly updatedAt: number;
}

const TABLE_SQL = Object.freeze({
  period_summary_capture_store_schema: `CREATE TABLE period_summary_capture_store_schema (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    version INTEGER NOT NULL
  ) STRICT`,
  period_summary_capture_evidence: `CREATE TABLE period_summary_capture_evidence (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
    job_id TEXT NOT NULL,
    occurrence_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK(policy_revision>=1),
    request_sha256 TEXT NOT NULL,
    source_manifest_sha256 TEXT NOT NULL,
    source_proof_sha256 TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    evidence_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,job_id),
    UNIQUE(workspace_id,owner_id,privacy_epoch,attempt_id),
    UNIQUE(workspace_id,owner_id,privacy_epoch,command_id),
    UNIQUE(workspace_id,owner_id,privacy_epoch,ticket_id),
    CHECK(length(job_id)=36),
    CHECK(length(request_sha256)=64 AND length(source_manifest_sha256)=64 AND length(source_proof_sha256)=64 AND length(evidence_sha256)=64)
  ) STRICT`,
  period_summary_capture_phase: `CREATE TABLE period_summary_capture_phase (
    workspace_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
    job_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('preparing','submitting','submitted','not_submitted','inspect_required','settled')),
    batch_id TEXT,
    status TEXT,
    updated_at INTEGER NOT NULL CHECK(updated_at>=0),
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,job_id),
    FOREIGN KEY(workspace_id,owner_id,privacy_epoch,job_id)
      REFERENCES period_summary_capture_evidence(workspace_id,owner_id,privacy_epoch,job_id),
    CHECK(length(request_sha256)=64),
    CHECK(batch_id IS NULL OR length(batch_id)>0),
    CHECK(status IS NULL OR length(status)>0)
  ) STRICT`,
});

const INDEX_SQL = Object.freeze({
  period_summary_capture_evidence_occurrence: `CREATE UNIQUE INDEX period_summary_capture_evidence_occurrence
    ON period_summary_capture_evidence(workspace_id,owner_id,privacy_epoch,occurrence_id)`,
  period_summary_capture_phase_lookup: `CREATE INDEX period_summary_capture_phase_lookup
    ON period_summary_capture_phase(workspace_id,owner_id,privacy_epoch,phase,updated_at)`,
});

const TRIGGER_SQL = Object.freeze({
  period_summary_capture_evidence_no_update: `CREATE TRIGGER period_summary_capture_evidence_no_update
    BEFORE UPDATE ON period_summary_capture_evidence
    BEGIN SELECT RAISE(ABORT,'period_summary_capture_evidence_is_immutable'); END`,
  period_summary_capture_evidence_no_delete: `CREATE TRIGGER period_summary_capture_evidence_no_delete
    BEFORE DELETE ON period_summary_capture_evidence
    WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
    BEGIN SELECT RAISE(ABORT,'period_summary_capture_evidence_is_durable'); END`,
  period_summary_capture_phase_no_delete: `CREATE TRIGGER period_summary_capture_phase_no_delete
    BEFORE DELETE ON period_summary_capture_phase
    WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
    BEGIN SELECT RAISE(ABORT,'period_summary_capture_phase_is_durable'); END`,
  period_summary_capture_phase_transition: `CREATE TRIGGER period_summary_capture_phase_transition
    BEFORE UPDATE ON period_summary_capture_phase
    WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.owner_id<>NEW.owner_id OR OLD.privacy_epoch<>NEW.privacy_epoch OR
      OLD.job_id<>NEW.job_id OR OLD.request_sha256<>NEW.request_sha256 OR NOT (
        (OLD.phase='preparing' AND NEW.phase IN ('submitting','not_submitted','inspect_required')) OR
        (OLD.phase='submitting' AND NEW.phase IN ('submitted','not_submitted','inspect_required')) OR
        (OLD.phase='submitted' AND NEW.phase IN ('settled','inspect_required')) OR
        (OLD.phase='inspect_required' AND NEW.phase='settled')) OR
      (NEW.phase='submitted' AND NEW.batch_id IS NULL) OR
      (OLD.phase IN ('submitted','settled') AND OLD.batch_id IS NOT NEW.batch_id)
    BEGIN SELECT RAISE(ABORT,'period_summary_capture_phase_transition_invalid'); END`,
});

const COLUMNS: Readonly<Record<string, readonly (readonly [string, string, number, number])[]>> = {
  period_summary_capture_store_schema: [['singleton', 'INTEGER', 0, 1], ['version', 'INTEGER', 1, 0]],
  period_summary_capture_evidence: [
    ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3], ['job_id', 'TEXT', 1, 4],
    ['occurrence_id', 'TEXT', 1, 0], ['attempt_id', 'TEXT', 1, 0], ['command_id', 'TEXT', 1, 0], ['ticket_id', 'TEXT', 1, 0],
    ['policy_id', 'TEXT', 1, 0], ['policy_revision', 'INTEGER', 1, 0], ['request_sha256', 'TEXT', 1, 0],
    ['source_manifest_sha256', 'TEXT', 1, 0], ['source_proof_sha256', 'TEXT', 1, 0], ['evidence_json', 'TEXT', 1, 0],
    ['evidence_sha256', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0],
  ],
  period_summary_capture_phase: [
    ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3], ['job_id', 'TEXT', 1, 4],
    ['request_sha256', 'TEXT', 1, 0], ['phase', 'TEXT', 1, 0], ['batch_id', 'TEXT', 0, 0], ['status', 'TEXT', 0, 0], ['updated_at', 'INTEGER', 1, 0],
  ],
};

function fail(code: string): never { throw new Error(code); }
function sha(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function normalizeSql(sql: string): string { return sql.replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim().toLowerCase(); }
function assertExactObjects(db: Database.Database, type: 'index' | 'trigger', expected: Readonly<Record<string, string>>): void {
  const names = Object.keys(expected).sort();
  const actual = db.prepare("SELECT name FROM sqlite_master WHERE type=? AND tbl_name LIKE 'period_summary_capture_%' AND sql IS NOT NULL ORDER BY name")
    .all(type) as { name: string }[];
  if (actual.map((item) => item.name).join('|') !== names.join('|')) fail(`period_summary_capture_schema_invalid:${type}s`);
  for (const name of names) {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type, name) as { sql?: string } | undefined;
    if (!row?.sql || normalizeSql(row.sql) !== normalizeSql(expected[name]!)) fail(`period_summary_capture_schema_invalid:${name}`);
  }
}
function initializeSchema(db: Database.Database): void {
  registerWorkspaceEraseDeleteGuard(db);
  const expected = new Set(Object.keys(TABLE_SQL));
  const names = [...expected].map((name) => `'${name}'`).join(',');
  const actual = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names})`).all() as { name: string }[];
  const actualNames = new Set(actual.map((row) => row.name));
  if (actualNames.size === 0) {
    db.exec([TABLE_SQL.period_summary_capture_store_schema,
      `INSERT INTO period_summary_capture_store_schema(singleton,version) VALUES(1,${VERSION})`,
      TABLE_SQL.period_summary_capture_evidence, INDEX_SQL.period_summary_capture_evidence_occurrence,
      TABLE_SQL.period_summary_capture_phase, INDEX_SQL.period_summary_capture_phase_lookup,
      ...Object.values(TRIGGER_SQL)].join(';'));
  } else if (actualNames.size !== expected.size || [...expected].some((name) => !actualNames.has(name))) {
    fail('period_summary_capture_schema_invalid');
  }
  for (const [tableName, columns] of Object.entries(COLUMNS)) {
    const actualColumns = db.pragma(`table_info(${tableName})`) as { name: string; type: string; notnull: number; pk: number }[];
    const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(tableName) as { strict?: number } | undefined;
    if (actualColumns.length !== columns.length || actualColumns.some((column, index) => {
      const expectedColumn = columns[index]!;
      return column.name !== expectedColumn[0] || column.type.toUpperCase() !== expectedColumn[1] ||
        column.notnull !== expectedColumn[2] || column.pk !== expectedColumn[3];
    }) || strict?.strict !== 1) fail(`period_summary_capture_schema_invalid:${tableName}`);
    const sql = db.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(tableName) as { sql?: string } | undefined;
    if (!sql?.sql || normalizeSql(sql.sql) !== normalizeSql(TABLE_SQL[tableName as keyof typeof TABLE_SQL])) {
      fail(`period_summary_capture_schema_invalid:${tableName}_constraints`);
    }
  }
  const versionRows = db.prepare('SELECT singleton,version FROM period_summary_capture_store_schema').all() as { singleton: number; version: number }[];
  if (versionRows.length !== 1 || versionRows[0]?.singleton !== 1 || versionRows[0]?.version !== VERSION) fail('period_summary_capture_schema_unsupported');
  assertExactObjects(db, 'index', INDEX_SQL);
  assertExactObjects(db, 'trigger', TRIGGER_SQL);
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    });
}
function validateEvidence(value: unknown): PeriodSummaryCaptureEvidence {
  const fields = ['schemaVersion','workspaceId','ownerId','privacyEpoch','policyId','policyRevision','policyDigest','executionOptionsDigest',
    'occurrenceSourceDigest','occurrenceRequestDigest','occurrenceSourceVersionDigest',
    'occurrenceId','attemptId','commandId','ticketId','jobId','customId','requestSha256','linkCreatedAt','sourceManifestSha256','sourceProofSha256','sourceProofs',
    'period','timeZone','localInterval','utcInterval','preparedAt','destination'];
  if (!record(value) || !exact(value, fields) || value.schemaVersion !== 1 || !UUID.test(String(value.workspaceId)) || !UUID.test(String(value.ownerId)) ||
      !Number.isSafeInteger(value.privacyEpoch) || (value.privacyEpoch as number) < 0 || !UUID.test(String(value.policyId)) ||
      !Number.isSafeInteger(value.policyRevision) || (value.policyRevision as number) < 1 ||
      ![value.policyDigest,value.executionOptionsDigest,value.occurrenceSourceDigest,value.occurrenceRequestDigest,value.requestSha256,
        value.sourceManifestSha256,value.sourceProofSha256].every((item) => typeof item === 'string' && SHA256.test(item)) ||
      !Number.isSafeInteger(value.linkCreatedAt) || (value.linkCreatedAt as number) < 0 ||
      (value.occurrenceSourceVersionDigest !== null && (typeof value.occurrenceSourceVersionDigest !== 'string' || !SHA256.test(value.occurrenceSourceVersionDigest))) ||
      ![value.occurrenceId,value.attemptId,value.commandId,value.ticketId,value.jobId,value.customId].every((item) => typeof item === 'string' && UUID.test(item)) ||
      value.customId !== value.jobId || !['daily','weekly','monthly','yearly'].includes(String(value.period)) ||
      typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.length > 128 ||
      !record(value.localInterval) || !exact(value.localInterval, ['start','end']) || typeof value.localInterval.start !== 'string' || typeof value.localInterval.end !== 'string' ||
      !record(value.utcInterval) || !exact(value.utcInterval, ['start','endExclusive']) || typeof value.utcInterval.start !== 'string' || typeof value.utcInterval.endExclusive !== 'string' ||
      typeof value.preparedAt !== 'string' || !Number.isFinite(Date.parse(value.preparedAt)) || new Date(value.preparedAt).toISOString() !== value.preparedAt ||
      !record(value.destination) || !Array.isArray(value.sourceProofs)) fail('period_summary_capture_evidence_invalid');
  const destinationKeys = value.destination.documentId === null
    ? ['path','documentId','expectedRevision','expectedAbsenceGeneration'] : ['path','documentId','expectedRevision'];
  if (!exact(value.destination, destinationKeys) || typeof value.destination.path !== 'string' || !value.destination.path ||
      (value.destination.documentId === null ? value.destination.expectedRevision !== null || !Number.isSafeInteger(value.destination.expectedAbsenceGeneration) ||
        (value.destination.expectedAbsenceGeneration as number) < 0 : !UUID.test(String(value.destination.documentId)) ||
        !Number.isSafeInteger(value.destination.expectedRevision) || (value.destination.expectedRevision as number) < 1)) fail('period_summary_capture_evidence_invalid');
  const json = canonicalBackgroundJson(value, MAX_EVIDENCE_BYTES);
  const cloned = JSON.parse(json) as PeriodSummaryCaptureEvidence;
  if (sha(canonicalBackgroundJson(cloned.sourceProofs, MAX_EVIDENCE_BYTES)) !== cloned.sourceProofSha256) fail('period_summary_capture_evidence_invalid');
  return Object.freeze(cloned);
}

function evidenceDigest(evidence: PeriodSummaryCaptureEvidence): string {
  return sha(canonicalBackgroundJson(evidence, MAX_EVIDENCE_BYTES));
}

/** Durable job-keyed evidence and phase checkpoint. Evidence is immutable; phase transitions are explicit. */
export class PeriodSummaryCaptureStore {
  readonly #identity: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>;

  constructor(private readonly kernel: DurableKernel, actorSessionToken: string) {
    const identity = kernel.getOwnedIdentity(actorSessionToken);
    if (!UUID.test(identity.workspaceId) || !UUID.test(identity.ownerId) || !Number.isSafeInteger(identity.privacyEpoch) || identity.privacyEpoch < 0) {
      fail('period_summary_capture_identity_invalid');
    }
    this.#identity = Object.freeze({ workspaceId: identity.workspaceId, ownerId: identity.ownerId, privacyEpoch: identity.privacyEpoch });
    kernel.withTrustedDatabaseTransaction((db) => initializeSchema(db));
  }

  insertPreparingWithinTransaction(context: OwnedTransactionContext, rawEvidence: PeriodSummaryCaptureEvidence): PeriodSummaryCaptureEvidence {
    this.#assertContext(context);
    const evidence = validateEvidence(rawEvidence);
    if (evidence.workspaceId !== context.workspaceId || evidence.ownerId !== context.ownerId || evidence.privacyEpoch !== context.privacyEpoch) {
      fail('period_summary_capture_scope_changed');
    }
    const evidenceJson = canonicalBackgroundJson(evidence, MAX_EVIDENCE_BYTES);
    const now = context.now;
    context.db.prepare(`INSERT INTO period_summary_capture_evidence
      (workspace_id,owner_id,privacy_epoch,job_id,occurrence_id,attempt_id,command_id,ticket_id,policy_id,policy_revision,request_sha256,
       source_manifest_sha256,source_proof_sha256,evidence_json,evidence_sha256,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, evidence.jobId, evidence.occurrenceId, evidence.attemptId,
        evidence.commandId, evidence.ticketId, evidence.policyId, evidence.policyRevision, evidence.requestSha256,
        evidence.sourceManifestSha256, evidence.sourceProofSha256, evidenceJson, sha(evidenceJson), now);
    context.db.prepare(`INSERT INTO period_summary_capture_phase
      (workspace_id,owner_id,privacy_epoch,job_id,request_sha256,phase,batch_id,status,updated_at)
      VALUES(?,?,?,?,?,'preparing',NULL,NULL,?)`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, evidence.jobId, evidence.requestSha256, now);
    return evidence;
  }

  readEvidenceWithinTransaction(context: OwnedTransactionContext, jobId: string): PeriodSummaryCaptureEvidence | undefined {
    this.#assertContext(context);
    if (!UUID.test(jobId)) fail('period_summary_capture_lookup_invalid');
    const row = context.db.prepare(`SELECT job_id,occurrence_id,attempt_id,command_id,ticket_id,policy_id,policy_revision,request_sha256,
      source_manifest_sha256,source_proof_sha256,evidence_json,evidence_sha256 FROM period_summary_capture_evidence
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, jobId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (typeof row.evidence_json !== 'string' || Buffer.byteLength(row.evidence_json, 'utf8') > MAX_EVIDENCE_BYTES ||
        sha(row.evidence_json) !== row.evidence_sha256) fail('period_summary_capture_storage_invalid');
    let parsed: unknown;
    try { parsed = JSON.parse(row.evidence_json); } catch { return fail('period_summary_capture_storage_invalid'); }
    const evidence = validateEvidence(parsed);
    if (canonicalBackgroundJson(evidence, MAX_EVIDENCE_BYTES) !== row.evidence_json || evidenceDigest(evidence) !== row.evidence_sha256 ||
        evidence.jobId !== row.job_id || evidence.occurrenceId !== row.occurrence_id || evidence.attemptId !== row.attempt_id ||
        evidence.commandId !== row.command_id || evidence.ticketId !== row.ticket_id || evidence.policyId !== row.policy_id ||
        evidence.policyRevision !== row.policy_revision || evidence.requestSha256 !== row.request_sha256 ||
        evidence.sourceManifestSha256 !== row.source_manifest_sha256 || evidence.sourceProofSha256 !== row.source_proof_sha256) {
      fail('period_summary_capture_storage_invalid');
    }
    return evidence;
  }

  readPhaseWithinTransaction(context: OwnedTransactionContext, jobId: string): PeriodSummaryCapturePhaseRecord | undefined {
    this.#assertContext(context);
    const evidence = this.readEvidenceWithinTransaction(context, jobId);
    if (!evidence) return undefined;
    const row = context.db.prepare(`SELECT job_id,request_sha256,phase,batch_id,status,updated_at FROM period_summary_capture_phase
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, jobId) as Record<string, unknown> | undefined;
    if (!row || row.job_id !== jobId || row.request_sha256 !== evidence.requestSha256 ||
        !['preparing','submitting','submitted','not_submitted','inspect_required','settled'].includes(String(row.phase)) ||
        (row.batch_id !== null && (typeof row.batch_id !== 'string' || !row.batch_id)) ||
        (row.status !== null && (typeof row.status !== 'string' || !row.status)) || !Number.isSafeInteger(row.updated_at) || (row.updated_at as number) < 0) {
      fail('period_summary_capture_storage_invalid');
    }
    return Object.freeze({ jobId, requestSha256: evidence.requestSha256, phase: row.phase as PeriodSummaryCapturePhase,
      ...(row.batch_id === null ? {} : { batchId: row.batch_id as string }), ...(row.status === null ? {} : { status: row.status as string }), updatedAt: row.updated_at as number });
  }

  transitionWithinTransaction(context: OwnedTransactionContext, jobId: string, requestSha256: string,
    expectedPhase: PeriodSummaryCapturePhase, nextPhase: PeriodSummaryCapturePhase,
    details: Readonly<{ batchId?: string; status?: string }> = {}): void {
    this.#assertContext(context);
    if (!UUID.test(jobId) || !SHA256.test(requestSha256) || !['preparing','submitting','submitted','not_submitted','inspect_required','settled'].includes(expectedPhase) ||
        !['preparing','submitting','submitted','not_submitted','inspect_required','settled'].includes(nextPhase) ||
        (details.batchId !== undefined && (typeof details.batchId !== 'string' || !details.batchId || details.batchId.length > 256)) ||
        (details.status !== undefined && (typeof details.status !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(details.status)))) fail('period_summary_capture_transition_invalid');
    const permitted = expectedPhase === 'preparing' && ['submitting','not_submitted','inspect_required'].includes(nextPhase) ||
      expectedPhase === 'submitting' && ['submitted','not_submitted','inspect_required'].includes(nextPhase) ||
      expectedPhase === 'submitted' && ['settled','inspect_required'].includes(nextPhase) ||
      expectedPhase === 'inspect_required' && nextPhase === 'settled';
    if (!permitted) fail('period_summary_capture_transition_invalid');
    const result = context.db.prepare(`UPDATE period_summary_capture_phase SET phase=?,batch_id=COALESCE(?,batch_id),status=?,updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=? AND request_sha256=? AND phase=?`)
      .run(nextPhase, details.batchId ?? null, details.status ?? null, context.now, context.workspaceId, context.ownerId,
        context.privacyEpoch, jobId, requestSha256, expectedPhase);
    if (result.changes !== 1) fail('period_summary_capture_phase_stale');
  }

  #assertContext(context: OwnedTransactionContext): void {
    this.kernel.assertOwnedTransactionContext(context);
    if (context.workspaceId !== this.#identity.workspaceId || context.ownerId !== this.#identity.ownerId || context.privacyEpoch !== this.#identity.privacyEpoch) {
      fail('period_summary_capture_scope_changed');
    }
    initializeSchema(context.db);
  }
}
