import type Database from 'better-sqlite3';
import { registerWorkspaceEraseDeleteGuard } from './workspaceErase.js';

export const PERIOD_SUMMARY_STATE_SCHEMA_VERSION = 1;
export const PERIOD_SUMMARY_PRIVATE_TABLES = Object.freeze([
  'period_summary_policy_activations',
  'period_summary_period_slots',
] as const);

const TABLE_SQL = Object.freeze({
  period_summary_state_schema: `CREATE TABLE period_summary_state_schema (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    version INTEGER NOT NULL
  ) STRICT`,
  period_summary_policy_activations: `CREATE TABLE period_summary_policy_activations (
    workspace_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
    activation_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK(policy_revision>=1),
    period TEXT NOT NULL CHECK(period IN ('daily','weekly','monthly','yearly')),
    time_zone TEXT NOT NULL,
    local_delivery_time TEXT NOT NULL CHECK(
      local_delivery_time GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(local_delivery_time,1,2)<='23'),
    catch_up TEXT NOT NULL CHECK(catch_up IN ('ask','latest','all')),
    activation_at TEXT NOT NULL,
    first_local_period TEXT NOT NULL,
    materialized_through TEXT,
    next_due_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('active','paused')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,activation_id),
    UNIQUE(workspace_id,owner_id,privacy_epoch,policy_id,activation_id),
    CHECK((status='active' AND next_due_at IS NOT NULL) OR (status='paused' AND next_due_at IS NULL))
  ) STRICT`,
  period_summary_period_slots: `CREATE TABLE period_summary_period_slots (
    workspace_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
    period TEXT NOT NULL CHECK(period IN ('daily','weekly','monthly','yearly')),
    local_period_start TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK(policy_revision>=1),
    activation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('eligible','suppressed','awaiting_review','deferred','linked','ambiguous')),
    reason TEXT,
    dependency_digest TEXT,
    authority_digest TEXT,
    linked_occurrence_id TEXT,
    materialized_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,period,local_period_start),
    FOREIGN KEY(workspace_id,owner_id,privacy_epoch,activation_id)
      REFERENCES period_summary_policy_activations(workspace_id,owner_id,privacy_epoch,activation_id),
    CHECK((status='deferred' AND reason IS NOT NULL AND dependency_digest IS NOT NULL) OR
      (status<>'deferred' AND dependency_digest IS NULL)),
    CHECK((status='linked' AND linked_occurrence_id IS NOT NULL AND authority_digest IS NOT NULL) OR
      (status<>'linked' AND linked_occurrence_id IS NULL)),
    CHECK(status NOT IN ('linked','ambiguous') OR authority_digest IS NOT NULL),
    CHECK(dependency_digest IS NULL OR length(dependency_digest)=64)
  ) STRICT`,
});

const INDEX_SQL = Object.freeze({
  period_summary_one_active_policy_per_period: `CREATE UNIQUE INDEX period_summary_one_active_policy_per_period
    ON period_summary_policy_activations(workspace_id,owner_id,privacy_epoch,period) WHERE status='active'`,
  period_summary_activation_due: `CREATE INDEX period_summary_activation_due
    ON period_summary_policy_activations(workspace_id,owner_id,privacy_epoch,status,next_due_at)`,
  period_summary_slots_cursor: `CREATE INDEX period_summary_slots_cursor
    ON period_summary_period_slots(workspace_id,owner_id,privacy_epoch,period,local_period_start,status)`,
});

const TRIGGER_SQL = Object.freeze({
  period_summary_activations_no_delete: `CREATE TRIGGER period_summary_activations_no_delete
    BEFORE DELETE ON period_summary_policy_activations
    WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
    BEGIN SELECT RAISE(ABORT,'period_summary_activations_are_durable'); END`,
  period_summary_slots_no_delete: `CREATE TRIGGER period_summary_slots_no_delete
    BEFORE DELETE ON period_summary_period_slots
    WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
    BEGIN SELECT RAISE(ABORT,'period_summary_slots_are_durable'); END`,
  period_summary_slots_immutable_final: `CREATE TRIGGER period_summary_slots_immutable_final
    BEFORE UPDATE ON period_summary_period_slots
    WHEN OLD.status IN ('linked','ambiguous')
    BEGIN SELECT RAISE(ABORT,'period_summary_final_slot_is_immutable'); END`,
});

const TABLE_COLUMNS: Readonly<Record<string, readonly (readonly [string, string, number, number])[]>> = {
  period_summary_state_schema: [
    ['singleton', 'INTEGER', 0, 1],
    ['version', 'INTEGER', 1, 0],
  ],
  period_summary_policy_activations: [
    ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3],
    ['activation_id', 'TEXT', 1, 4], ['policy_id', 'TEXT', 1, 0], ['policy_revision', 'INTEGER', 1, 0],
    ['period', 'TEXT', 1, 0], ['time_zone', 'TEXT', 1, 0], ['local_delivery_time', 'TEXT', 1, 0],
    ['catch_up', 'TEXT', 1, 0], ['activation_at', 'TEXT', 1, 0], ['first_local_period', 'TEXT', 1, 0],
    ['materialized_through', 'TEXT', 0, 0], ['next_due_at', 'TEXT', 0, 0], ['status', 'TEXT', 1, 0],
    ['created_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0],
  ],
  period_summary_period_slots: [
    ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3],
    ['period', 'TEXT', 1, 4], ['local_period_start', 'TEXT', 1, 5], ['policy_id', 'TEXT', 1, 0],
    ['policy_revision', 'INTEGER', 1, 0], ['activation_id', 'TEXT', 1, 0], ['status', 'TEXT', 1, 0],
    ['reason', 'TEXT', 0, 0], ['dependency_digest', 'TEXT', 0, 0], ['authority_digest', 'TEXT', 0, 0],
    ['linked_occurrence_id', 'TEXT', 0, 0], ['materialized_at', 'TEXT', 1, 0], ['updated_at', 'TEXT', 1, 0],
  ],
};

export function initializePeriodSummaryStateSchema(db: Database.Database): void {
  registerWorkspaceEraseDeleteGuard(db);
  const expectedTables = new Set(['period_summary_state_schema', ...PERIOD_SUMMARY_PRIVATE_TABLES]);
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
    ('period_summary_state_schema','period_summary_policy_activations','period_summary_period_slots')`).all() as { name: string }[];
  const actualTables = new Set(rows.map((row) => row.name));

  if (actualTables.size === 0) {
    db.exec([
      TABLE_SQL.period_summary_state_schema,
      `INSERT INTO period_summary_state_schema(singleton,version) VALUES(1,${PERIOD_SUMMARY_STATE_SCHEMA_VERSION})`,
      TABLE_SQL.period_summary_policy_activations,
      INDEX_SQL.period_summary_one_active_policy_per_period,
      INDEX_SQL.period_summary_activation_due,
      TABLE_SQL.period_summary_period_slots,
      INDEX_SQL.period_summary_slots_cursor,
      ...Object.values(TRIGGER_SQL),
    ].join(';'));
  } else if (actualTables.size !== expectedTables.size || [...expectedTables].some((name) => !actualTables.has(name))) {
    throw new Error('period_summary_state_schema_invalid');
  }

  assertPeriodSummaryStateSchema(db);
}

export function assertPeriodSummaryStateSchema(db: Database.Database): void {
  const allTableSql: Readonly<Record<string, string>> = {
    period_summary_state_schema: TABLE_SQL.period_summary_state_schema,
    period_summary_policy_activations: TABLE_SQL.period_summary_policy_activations,
    period_summary_period_slots: TABLE_SQL.period_summary_period_slots,
  };
  for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
    const actual = db.pragma(`table_info(${table})`) as { name: string; type: string; notnull: number; pk: number }[];
    const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table) as { strict?: number } | undefined;
    if (actual.length !== columns.length || actual.some((column, index) => {
      const [name, type, notnull, primaryKey] = columns[index]!;
      return column.name !== name || column.type.toUpperCase() !== type || column.notnull !== notnull || column.pk !== primaryKey;
    }) || strict?.strict !== 1) throw new Error(`period_summary_state_schema_invalid:${table}`);

    const row = db.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(table) as { sql: string } | undefined;
    if (!row || normalizeSql(row.sql) !== normalizeSql(allTableSql[table]!)) {
      throw new Error(`period_summary_state_schema_invalid:${table}_constraints`);
    }
  }

  const versionRows = db.prepare('SELECT singleton,version FROM period_summary_state_schema').all() as { singleton: number; version: number }[];
  if (versionRows.length !== 1 || versionRows[0]?.singleton !== 1 ||
      versionRows[0]?.version !== PERIOD_SUMMARY_STATE_SCHEMA_VERSION) throw new Error('period_summary_state_schema_unsupported');

  assertExactSqlObjects(db, 'index', INDEX_SQL);
  assertExactSqlObjects(db, 'trigger', TRIGGER_SQL);
}

function assertExactSqlObjects(db: Database.Database, type: 'index' | 'trigger', expected: Readonly<Record<string, string>>): void {
  const names = Object.keys(expected).sort();
  const actualRows = db.prepare(`SELECT name FROM sqlite_master WHERE type=? AND tbl_name IN
    ('period_summary_policy_activations','period_summary_period_slots') AND sql IS NOT NULL ORDER BY name`).all(type) as { name: string }[];
  if (actualRows.map((row) => row.name).join('|') !== names.join('|')) {
    throw new Error(`period_summary_state_schema_invalid:${type === 'index' ? 'indexes' : 'triggers'}`);
  }
  for (const name of names) {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(type, name) as { sql: string } | undefined;
    if (!row || normalizeSql(row.sql) !== normalizeSql(expected[name]!)) {
      throw new Error(`period_summary_state_schema_invalid:${name}`);
    }
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim().toLowerCase();
}
