import type Database from 'better-sqlite3';

export const BACKGROUND_SCHEMA_VERSION = 4;
const TABLES = Object.freeze([
  'background_schema',
  'background_policy_heads',
  'background_policy_revisions',
  'background_policy_commands',
  'background_occurrences',
  'background_occurrence_targets',
  'background_occurrence_attempts',
]);

type Column = Readonly<{ name: string; type: string; notnull: number; pk: number }>;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly Column[]>> = Object.freeze({
  background_schema: [
    { name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  background_policy_heads: [
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 },
    { name: 'policy_id', type: 'TEXT', notnull: 1, pk: 4 },
    { name: 'current_revision', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'suspension', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  background_policy_revisions: [
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 },
    { name: 'policy_id', type: 'TEXT', notnull: 1, pk: 4 },
    { name: 'revision', type: 'INTEGER', notnull: 1, pk: 5 },
    { name: 'enabled', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'specification_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'binding_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'binding_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'policy_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'effective_from', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  background_policy_commands: [
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 },
    { name: 'command_id', type: 'TEXT', notnull: 1, pk: 4 },
    { name: 'request_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'receipt_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  background_occurrences: [
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 },
    { name: 'occurrence_id', type: 'TEXT', notnull: 1, pk: 4 },
    { name: 'policy_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'logical_key_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'policy_revision', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'policy_kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'policy_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scheduled_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'actual_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'period_kind', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'local_period_start', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'time_zone', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'source_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'source_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'descriptor_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'request_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'source_version_digest', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'request_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'target_snapshot_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'batch_job_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'accounting_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  background_occurrence_attempts: [
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 },
    { name: 'attempt_id', type: 'TEXT', notnull: 1, pk: 4 },
    { name: 'occurrence_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'target_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'target_generation', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'capability_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'claimed_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'dispatch_started_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'settled_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'accounting_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'result_code', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'finalization_operation', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'finalization_request_json', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'finalization_receipt_json', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'finalization_receipt_digest', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'dispatch_admission_id', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  background_occurrence_targets: [
    { name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'owner_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'privacy_epoch', type: 'INTEGER', notnull: 1, pk: 3 },
    { name: 'occurrence_id', type: 'TEXT', notnull: 1, pk: 4 },
    { name: 'target_id', type: 'TEXT', notnull: 1, pk: 5 },
    { name: 'target_generation', type: 'INTEGER', notnull: 1, pk: 6 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'attempt_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'accounting_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
});

const CREATE_SCHEMA = `
CREATE TABLE background_schema (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version INTEGER NOT NULL CHECK(version>0)
) STRICT;
INSERT INTO background_schema(singleton,version) VALUES(1,${BACKGROUND_SCHEMA_VERSION});
CREATE TABLE background_policy_heads (
  workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
  policy_id TEXT NOT NULL CHECK(length(policy_id)=36), current_revision INTEGER NOT NULL CHECK(current_revision>0),
  status TEXT NOT NULL CHECK(status IN ('enabled','paused','revoked','suspended')),
  suspension TEXT CHECK(suspension IS NULL OR suspension IN ('account_changed','rule_changed','reminder_changed','reauthorization_required')),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(workspace_id,owner_id,privacy_epoch,policy_id)
) STRICT;
CREATE TABLE background_policy_revisions (
  workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
  policy_id TEXT NOT NULL CHECK(length(policy_id)=36), revision INTEGER NOT NULL CHECK(revision>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), specification_json TEXT NOT NULL CHECK(length(specification_json)>0),
  binding_json TEXT NOT NULL CHECK(length(binding_json)>0), binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64), effective_from INTEGER NOT NULL CHECK(effective_from>=0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(workspace_id,owner_id,privacy_epoch,policy_id,revision)
) STRICT;
CREATE TABLE background_policy_commands (
  workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
  command_id TEXT NOT NULL CHECK(length(command_id)=36), request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  receipt_json TEXT NOT NULL CHECK(length(receipt_json)>0), created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(workspace_id,owner_id,privacy_epoch,command_id)
) STRICT;
CREATE TABLE background_occurrences (
  workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
  occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36), policy_id TEXT NOT NULL CHECK(length(policy_id)=36),
  logical_key_digest TEXT NOT NULL CHECK(length(logical_key_digest)=64), policy_revision INTEGER NOT NULL CHECK(policy_revision>0),
  policy_kind TEXT NOT NULL CHECK(policy_kind IN ('account_sync','period_summary','proactive_draft','approved_reminder_delivery')),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
  status TEXT NOT NULL CHECK(status IN ('scheduled','claimed','dispatching','completed','unknown','inspect_required','suppressed')),
  scheduled_at INTEGER NOT NULL CHECK(scheduled_at>=0), actual_at INTEGER CHECK(actual_at IS NULL OR actual_at>=0),
  period_kind TEXT CHECK(period_kind IS NULL OR period_kind IN ('daily','weekly','monthly','yearly')),
  local_period_start TEXT, time_zone TEXT, source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  source_json TEXT NOT NULL CHECK(length(source_json)>0), descriptor_json TEXT NOT NULL CHECK(length(descriptor_json)>0),
  request_json TEXT NOT NULL CHECK(length(request_json)>0),
  source_version_digest TEXT CHECK(source_version_digest IS NULL OR length(source_version_digest)=64),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64), target_snapshot_json TEXT NOT NULL,
  batch_job_id TEXT CHECK(batch_job_id IS NULL OR length(batch_job_id)=36),
  accounting_json TEXT NOT NULL CHECK(length(accounting_json)>0), created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(workspace_id,owner_id,privacy_epoch,occurrence_id),
  UNIQUE(workspace_id,owner_id,privacy_epoch,policy_id,logical_key_digest)
) STRICT;
CREATE UNIQUE INDEX background_occurrence_batch_job_unique ON background_occurrences(workspace_id,owner_id,privacy_epoch,batch_job_id)
  WHERE batch_job_id IS NOT NULL;
CREATE TABLE background_occurrence_targets (
  workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
  occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36), target_id TEXT NOT NULL CHECK(length(target_id)>0),
  target_generation INTEGER NOT NULL CHECK(target_generation>=0),
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','dispatching','completed','unknown','inspect_required','skipped')),
  attempt_id TEXT CHECK(attempt_id IS NULL OR length(attempt_id)=36), accounting_json TEXT NOT NULL CHECK(length(accounting_json)>0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(workspace_id,owner_id,privacy_epoch,occurrence_id,target_id,target_generation)
) STRICT;
CREATE TABLE background_occurrence_attempts (
  workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id)=36), occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36),
  target_id TEXT NOT NULL, target_generation INTEGER NOT NULL CHECK(target_generation>=0),
  capability_hash TEXT NOT NULL CHECK(length(capability_hash)=64),
  status TEXT NOT NULL CHECK(status IN ('claimed','dispatching','completed','unknown','inspect_required','skipped')),
  claimed_at INTEGER NOT NULL CHECK(claimed_at>=0), dispatch_started_at INTEGER CHECK(dispatch_started_at IS NULL OR dispatch_started_at>=0),
  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=0), accounting_json TEXT NOT NULL CHECK(length(accounting_json)>0),
  result_code TEXT CHECK(result_code IS NULL OR length(result_code)>0),
  finalization_operation TEXT CHECK(finalization_operation IS NULL OR finalization_operation IN ('settle','defer','inspect','inspect_unacknowledged')),
  finalization_request_json TEXT, finalization_receipt_json TEXT, finalization_receipt_digest TEXT CHECK(finalization_receipt_digest IS NULL OR length(finalization_receipt_digest)=64),
  dispatch_admission_id TEXT CHECK(dispatch_admission_id IS NULL OR length(dispatch_admission_id)=36),
  CHECK((finalization_operation IS NULL AND finalization_request_json IS NULL AND finalization_receipt_json IS NULL AND finalization_receipt_digest IS NULL) OR
    (finalization_operation IS NOT NULL AND finalization_request_json IS NOT NULL AND finalization_receipt_json IS NOT NULL AND finalization_receipt_digest IS NOT NULL)),
  PRIMARY KEY(workspace_id,owner_id,privacy_epoch,attempt_id)
) STRICT;
CREATE UNIQUE INDEX background_occurrence_active_attempt_unique
  ON background_occurrence_attempts(workspace_id,owner_id,privacy_epoch,occurrence_id,target_id,target_generation)
  WHERE status IN ('claimed','dispatching');
CREATE INDEX background_policy_status_idx ON background_policy_heads(workspace_id,owner_id,privacy_epoch,status,updated_at);
CREATE INDEX background_occurrence_due_idx ON background_occurrences(workspace_id,owner_id,privacy_epoch,status,scheduled_at);
CREATE INDEX background_occurrence_target_due_idx ON background_occurrence_targets(workspace_id,owner_id,privacy_epoch,status,updated_at);
`;

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function validateTable(db: Database.Database, name: string): void {
  const expected = REQUIRED_COLUMNS[name];
  if (!expected) throw new Error('background_schema_invalid');
  const actual = db.pragma(`table_info(${name})`) as Column[];
  if (actual.length !== expected.length || actual.some((column, index) => {
    const target = expected[index]!;
    return column.name !== target.name || column.type.toUpperCase() !== target.type || column.notnull !== target.notnull || column.pk !== target.pk;
  })) throw new Error('background_schema_invalid');
  const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(name) as { strict?: number } | undefined;
  if (strict?.strict !== 1) throw new Error('background_schema_invalid');
}

function validateIndexes(db: Database.Database): void {
  const expected: Readonly<Record<string, readonly Readonly<{ columns: readonly string[]; unique: boolean; partial?: boolean; name?: string; predicate?: string }> []>> = {
    background_policy_heads: [{ columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'policy_id'], unique: true },
      { columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'status', 'updated_at'], unique: false, name: 'background_policy_status_idx' }],
    background_policy_revisions: [{ columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'policy_id', 'revision'], unique: true }],
    background_policy_commands: [{ columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'command_id'], unique: true }],
    background_occurrences: [{ columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'occurrence_id'], unique: true },
      { columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'policy_id', 'logical_key_digest'], unique: true },
      { columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'batch_job_id'], unique: true, partial: true, name: 'background_occurrence_batch_job_unique',
        predicate: 'batch_job_id IS NOT NULL' },
      { columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'status', 'scheduled_at'], unique: false, name: 'background_occurrence_due_idx' }],
    background_occurrence_targets: [{ columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'occurrence_id', 'target_id', 'target_generation'], unique: true },
      { columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'status', 'updated_at'], unique: false, name: 'background_occurrence_target_due_idx' }],
    background_occurrence_attempts: [{ columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'attempt_id'], unique: true },
      { columns: ['workspace_id', 'owner_id', 'privacy_epoch', 'occurrence_id', 'target_id', 'target_generation'], unique: true, partial: true,
        name: 'background_occurrence_active_attempt_unique', predicate: "status IN ('claimed','dispatching')" }],
  };
  for (const [table, required] of Object.entries(expected)) {
    const indexes = db.pragma(`index_list(${table})`) as { name: string; unique: number; partial: number }[];
    for (const rule of required) {
      const matches = indexes.filter((index) => (!rule.name || index.name === rule.name) && index.unique === Number(rule.unique) &&
        index.partial === Number(rule.partial ?? false) &&
        JSON.stringify((db.pragma(`index_info("${index.name.replaceAll('"', '""')}")`) as { name: string | null }[]).map((column) => column.name)) === JSON.stringify(rule.columns));
      if (matches.length !== 1) throw new Error('background_schema_invalid');
      if (rule.predicate) {
        const index = matches[0]!;
        const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name) as { sql: string | null } | undefined;
        const where = definition?.sql?.match(/\bwhere\b([\s\S]*)$/i)?.[1];
        const normalize = (value: string): string => value.replace(/[\"`\[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!where || normalize(where) !== normalize(rule.predicate)) throw new Error('background_schema_invalid');
      }
    }
  }
}

/** Initializes this module-owned schema only from inside an authenticated owner transaction. */
export function ensureBackgroundSchema(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('background_schema_requires_owned_transaction');
  const existing = TABLES.map((name) => [name, tableExists(db, name)] as const);
  const present = existing.filter(([, found]) => found).length;
  if (present === 0) {
    db.exec(CREATE_SCHEMA);
  } else if (present !== TABLES.length) {
    throw new Error('background_schema_invalid');
  }

  const versions = db.prepare('SELECT singleton,version FROM background_schema').all() as { singleton: number; version: number }[];
  if (versions.length !== 1 || versions[0]?.singleton !== 1) throw new Error('background_schema_invalid');
  if (versions[0]!.version === 1) {
    const attemptColumns = db.pragma('table_info(background_occurrence_attempts)') as Column[];
    const present = new Set(attemptColumns.map((column) => column.name));
    if (['finalization_operation', 'finalization_request_json', 'finalization_receipt_json', 'finalization_receipt_digest'].some((name) => present.has(name))) {
      throw new Error('background_schema_invalid');
    }
    db.exec(`ALTER TABLE background_occurrence_attempts ADD COLUMN finalization_operation TEXT;
      ALTER TABLE background_occurrence_attempts ADD COLUMN finalization_request_json TEXT;
      ALTER TABLE background_occurrence_attempts ADD COLUMN finalization_receipt_json TEXT;
      ALTER TABLE background_occurrence_attempts ADD COLUMN finalization_receipt_digest TEXT;
      UPDATE background_schema SET version=2 WHERE singleton=1 AND version=1;`);
  }
  const migratedVersion = (db.prepare('SELECT version FROM background_schema WHERE singleton=1').get() as { version: number } | undefined)?.version;
  if (migratedVersion === 2) {
    migrateAttemptHistoryIndex(db);
  }
  const indexedVersion = (db.prepare('SELECT version FROM background_schema WHERE singleton=1').get() as { version: number } | undefined)?.version;
  if (indexedVersion === 3) {
    const columns = db.pragma('table_info(background_occurrence_attempts)') as Column[];
    if (columns.some((column) => column.name === 'dispatch_admission_id')) throw new Error('background_schema_invalid');
    db.exec(`ALTER TABLE background_occurrence_attempts ADD COLUMN dispatch_admission_id TEXT
      CHECK(dispatch_admission_id IS NULL OR length(dispatch_admission_id)=36);
      UPDATE background_schema SET version=4 WHERE singleton=1 AND version=3;`);
  } else if (indexedVersion !== BACKGROUND_SCHEMA_VERSION) {
    throw new Error('background_schema_unsupported');
  }
  for (const name of TABLES) validateTable(db, name);
  validateIndexes(db);
}

const ATTEMPT_HISTORY_COLUMNS = `workspace_id,owner_id,privacy_epoch,attempt_id,occurrence_id,target_id,target_generation,
  capability_hash,status,claimed_at,dispatch_started_at,settled_at,accounting_json,result_code,finalization_operation,
  finalization_request_json,finalization_receipt_json,finalization_receipt_digest`;

function migrateAttemptHistoryIndex(db: Database.Database): void {
  // Validate the known v2 table before rebuilding its autoindex. This preserves every durable attempt byte-for-byte
  // while replacing the lifetime target uniqueness constraint with a uniqueness fence for live attempts only.
  const expectedColumns = REQUIRED_COLUMNS.background_occurrence_attempts!.filter((column) => column.name !== 'dispatch_admission_id');
  const actualColumns = db.pragma('table_info(background_occurrence_attempts)') as Column[];
  const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get('background_occurrence_attempts') as { strict?: number } | undefined;
  if (strict?.strict !== 1 || actualColumns.length !== expectedColumns.length || actualColumns.some((column, index) => {
    const target = expectedColumns[index]!;
    return column.name !== target.name || column.type.toUpperCase() !== target.type || column.notnull !== target.notnull || column.pk !== target.pk;
  })) throw new Error('background_schema_invalid');
  const indexes = db.pragma('index_list(background_occurrence_attempts)') as { name: string; unique: number; partial: number }[];
  const legacyTargetIndex = indexes.filter((index) => index.unique === 1 && index.partial === 0 &&
    JSON.stringify((db.pragma(`index_info("${index.name.replaceAll('"', '""')}")`) as { name: string | null }[]).map((column) => column.name)) ===
      JSON.stringify(['workspace_id', 'owner_id', 'privacy_epoch', 'occurrence_id', 'target_id', 'target_generation']));
  if (legacyTargetIndex.length !== 1) throw new Error('background_schema_invalid');
  const primaryAttemptIndex = indexes.filter((index) => index.unique === 1 && index.partial === 0 &&
    JSON.stringify((db.pragma(`index_info("${index.name.replaceAll('"', '""')}")`) as { name: string | null }[]).map((column) => column.name)) ===
      JSON.stringify(['workspace_id', 'owner_id', 'privacy_epoch', 'attempt_id']));
  if (primaryAttemptIndex.length !== 1) throw new Error('background_schema_invalid');

  db.exec(`ALTER TABLE background_occurrence_attempts RENAME TO background_occurrence_attempts_v2;
    CREATE TABLE background_occurrence_attempts (
      workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
      attempt_id TEXT NOT NULL CHECK(length(attempt_id)=36), occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36),
      target_id TEXT NOT NULL, target_generation INTEGER NOT NULL CHECK(target_generation>=0),
      capability_hash TEXT NOT NULL CHECK(length(capability_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('claimed','dispatching','completed','unknown','inspect_required','skipped')),
      claimed_at INTEGER NOT NULL CHECK(claimed_at>=0), dispatch_started_at INTEGER CHECK(dispatch_started_at IS NULL OR dispatch_started_at>=0),
      settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=0), accounting_json TEXT NOT NULL CHECK(length(accounting_json)>0),
      result_code TEXT CHECK(result_code IS NULL OR length(result_code)>0),
      finalization_operation TEXT CHECK(finalization_operation IS NULL OR finalization_operation IN ('settle','defer','inspect','inspect_unacknowledged')),
      finalization_request_json TEXT, finalization_receipt_json TEXT, finalization_receipt_digest TEXT CHECK(finalization_receipt_digest IS NULL OR length(finalization_receipt_digest)=64),
      CHECK((finalization_operation IS NULL AND finalization_request_json IS NULL AND finalization_receipt_json IS NULL AND finalization_receipt_digest IS NULL) OR
        (finalization_operation IS NOT NULL AND finalization_request_json IS NOT NULL AND finalization_receipt_json IS NOT NULL AND finalization_receipt_digest IS NOT NULL)),
      PRIMARY KEY(workspace_id,owner_id,privacy_epoch,attempt_id)
    ) STRICT;
    INSERT INTO background_occurrence_attempts(${ATTEMPT_HISTORY_COLUMNS})
      SELECT ${ATTEMPT_HISTORY_COLUMNS} FROM background_occurrence_attempts_v2;
    DROP TABLE background_occurrence_attempts_v2;
    CREATE UNIQUE INDEX background_occurrence_active_attempt_unique
      ON background_occurrence_attempts(workspace_id,owner_id,privacy_epoch,occurrence_id,target_id,target_generation)
      WHERE status IN ('claimed','dispatching');
    UPDATE background_schema SET version=3 WHERE singleton=1 AND version=2;`);
}
