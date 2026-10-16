import { createHash, randomUUID } from 'node:crypto';
import type { OwnedTransactionContext, DurableKernel } from './kernel.js';
import type { ApplicationStartupCapability } from './applicationStartup.js';

const SCHEMA_VERSION = 3;
const PAGE_MAX = 100;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface BackgroundProactiveCandidateProjection {
  readonly schemaVersion: 1;
  readonly valid: boolean;
  readonly candidates: readonly Readonly<{
    ruleId: string;
    ruleRevision: number;
    accountId: string;
    accountIdentityKey: string;
    connectionGeneration: number;
    providerMessageId: string;
    localMessageId: string;
    sourceVersion: string;
    eligibleAt: number;
  }>[];
}

export type BackgroundProactiveCandidateProjectionItem = BackgroundProactiveCandidateProjection['candidates'][number];

export interface BackgroundProactiveCandidateRow extends BackgroundProactiveCandidateProjectionItem {
  readonly candidateId: string;
  readonly nextDueAt: number;
  readonly state: 'due' | 'held' | 'inactive' | 'quarantined';
}

export interface BackgroundProactivePreflightClaim {
  readonly attemptId: string;
  readonly candidateId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly capability: string;
}

interface CandidateRow {
  workspace_id: string; owner_id: string; privacy_epoch: number; candidate_id: string; rule_id: string; rule_revision: number;
  account_id: string; account_identity_key: string; connection_generation: number; provider_message_id: string;
  local_message_id: string; source_version: string; eligible_at: number; next_due_at: number;
  state: BackgroundProactiveCandidateRow['state']; updated_at: number;
}

interface AttemptRow { status: string; next_due_at: number; attempt_number: number }

export interface BackgroundPaidOccurrenceBinding {
  readonly occurrenceId: string;
  readonly paidAttemptId: string;
}

function fail(code: string): never { throw new Error(code); }
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function safeText(value: unknown, max = 1024): value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max || /[\u0000-\u001f\u007f]/.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validCandidate(value: unknown): BackgroundProactiveCandidateProjection['candidates'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('background_proactive_candidate_invalid');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'accountId,accountIdentityKey,connectionGeneration,eligibleAt,localMessageId,providerMessageId,ruleId,ruleRevision,sourceVersion' ||
      !safeText(item.ruleId, 160) || !Number.isSafeInteger(item.ruleRevision) || (item.ruleRevision as number) < 1 ||
      !safeText(item.accountId, 1024) || typeof item.accountIdentityKey !== 'string' || !SHA256.test(item.accountIdentityKey) ||
      !Number.isSafeInteger(item.connectionGeneration) || (item.connectionGeneration as number) < 1 ||
      !safeText(item.providerMessageId) || !safeText(item.localMessageId) || typeof item.sourceVersion !== 'string' || !SHA256.test(item.sourceVersion) ||
      !Number.isSafeInteger(item.eligibleAt) || (item.eligibleAt as number) < 0) return fail('background_proactive_candidate_invalid');
  return Object.freeze({ ruleId: item.ruleId, ruleRevision: item.ruleRevision as number, accountId: item.accountId,
    accountIdentityKey: item.accountIdentityKey as string, connectionGeneration: item.connectionGeneration as number,
    providerMessageId: item.providerMessageId, localMessageId: item.localMessageId, sourceVersion: item.sourceVersion as string,
    eligibleAt: item.eligibleAt as number });
}

function candidateFromRow(row: CandidateRow): BackgroundProactiveCandidateRow {
  return Object.freeze({ candidateId: row.candidate_id, ruleId: row.rule_id, ruleRevision: row.rule_revision,
    accountId: row.account_id, accountIdentityKey: row.account_identity_key, connectionGeneration: row.connection_generation,
    providerMessageId: row.provider_message_id, localMessageId: row.local_message_id, sourceVersion: row.source_version,
    eligibleAt: row.eligible_at, nextDueAt: row.next_due_at, state: row.state });
}

function validatePolicyQuery(input: unknown): asserts input is Readonly<{ ruleId: string; ruleRevision: number; policyId: string;
  policyRevision: number; now?: number; afterCandidateId?: string; limit?: number }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('background_proactive_candidate_query_invalid');
  const value = input as Record<string, unknown>;
  const allowed = ['ruleId', 'ruleRevision', 'policyId', 'policyRevision', 'now', 'afterCandidateId', 'limit', 'candidateId'];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !safeText(value.ruleId, 160) ||
      !Number.isSafeInteger(value.ruleRevision) || (value.ruleRevision as number) < 1 || !UUID_V4.test(String(value.policyId)) ||
      !Number.isSafeInteger(value.policyRevision) || (value.policyRevision as number) < 1 ||
      (value.now !== undefined && (!Number.isSafeInteger(value.now) || (value.now as number) < 0)) ||
      (value.afterCandidateId !== undefined && !SHA256.test(String(value.afterCandidateId))) ||
      (value.candidateId !== undefined && !SHA256.test(String(value.candidateId))) ||
      (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > PAGE_MAX))) {
    return fail('background_proactive_candidate_query_invalid');
  }
}

function validateSchema(context: OwnedTransactionContext, expectedVersion = SCHEMA_VERSION): void {
  const tables = ['background_proactive_candidate_meta', 'background_proactive_candidate_scopes', 'background_proactive_candidates', 'background_proactive_preflight_attempts'];
  for (const table of tables) if (!context.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
    return fail('background_proactive_candidate_schema_invalid');
  }
  const meta = context.db.prepare('PRAGMA table_info(background_proactive_candidate_meta)').all() as { name: string; type: string; notnull: number; pk: number }[];
  if (JSON.stringify(meta.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))) !== JSON.stringify([
    { name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 }, { name: 'schema_version', type: 'INTEGER', notnull: 1, pk: 0 }])) {
    return fail('background_proactive_candidate_schema_invalid');
  }
  const version = context.db.prepare('SELECT schema_version FROM background_proactive_candidate_meta WHERE singleton=1').get() as { schema_version: number } | undefined;
  if (!version || version.schema_version > SCHEMA_VERSION) return fail('background_proactive_candidate_schema_unsupported');
  if (version.schema_version !== expectedVersion) return fail('background_proactive_candidate_schema_unsupported');
  const expectedColumns: Record<string, readonly (readonly [string, string, number, number])[]> = {
    background_proactive_candidate_scopes: [
      ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3],
      ['revision', 'INTEGER', 1, 0], ['quarantined', 'INTEGER', 1, 0], ['updated_at', 'INTEGER', 1, 0]],
    background_proactive_candidates: [
      ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3], ['candidate_id', 'TEXT', 1, 4],
      ['rule_id', 'TEXT', 1, 0], ['rule_revision', 'INTEGER', 1, 0], ['account_id', 'TEXT', 1, 0], ['account_identity_key', 'TEXT', 1, 0],
      ['connection_generation', 'INTEGER', 1, 0], ['provider_message_id', 'TEXT', 1, 0], ['local_message_id', 'TEXT', 1, 0],
      ['source_version', 'TEXT', 1, 0], ['eligible_at', 'INTEGER', 1, 0], ['next_due_at', 'INTEGER', 1, 0], ['state', 'TEXT', 1, 0], ['updated_at', 'INTEGER', 1, 0]],
    background_proactive_preflight_attempts: [
      ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3], ['attempt_id', 'TEXT', 1, 4],
      ['candidate_id', 'TEXT', 1, 0], ['policy_id', 'TEXT', 1, 0], ['policy_revision', 'INTEGER', 1, 0], ['attempt_number', 'INTEGER', 1, 0],
      ['capability_hash', 'TEXT', 1, 0], ['status', 'TEXT', 1, 0], ['next_due_at', 'INTEGER', 1, 0], ['created_at', 'INTEGER', 1, 0],
      ['settled_at', 'INTEGER', 0, 0], ['result_code', 'TEXT', 0, 0],
      ...(expectedVersion >= 3 ? [['paid_occurrence_id', 'TEXT', 0, 0], ['paid_attempt_id', 'TEXT', 0, 0],
        ['recovery_protocol_version', 'INTEGER', 1, 0]] as const : [])],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const columns = context.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; pk: number }[];
    if (JSON.stringify(columns.map(({ name, type, notnull, pk }) => [name, type, notnull, pk])) !== JSON.stringify(expected)) {
      return fail('background_proactive_candidate_schema_invalid');
    }
    const sql = context.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
    if (!sql?.sql || !/\bSTRICT\s*$/i.test(sql.sql)) return fail('background_proactive_candidate_schema_invalid');
    if (table === 'background_proactive_preflight_attempts' && expectedVersion >= 3) {
      const normalized = sql.sql.replace(/[\s\"`\[\]]/g, '').toLowerCase();
      if (!normalized.includes('check((paid_occurrence_idisnull)=(paid_attempt_idisnull))') ||
          !normalized.includes('check(recovery_protocol_versionin(0,1))') ||
          !normalized.includes('check(recovery_protocol_version=1or(paid_occurrence_idisnullandpaid_attempt_idisnull))')) {
        return fail('background_proactive_candidate_schema_invalid');
      }
    }
  }
  const dueColumns = context.db.prepare('PRAGMA index_info(background_proactive_candidate_due_idx)').all() as { name: string }[];
  const dueIndex = context.db.prepare('PRAGMA index_list(background_proactive_candidates)').all() as { name: string; unique: number }[];
  const candidatesSql = context.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_proactive_candidates'").get() as { sql: string } | undefined;
  if (dueIndex.find((item) => item.name === 'background_proactive_candidate_due_idx')?.unique !== 0 ||
      dueColumns.map((item) => item.name).join(',') !== 'workspace_id,owner_id,privacy_epoch,state,next_due_at,candidate_id' ||
      !candidatesSql?.sql.replace(/[\s"`\[\]]/g, '').toLowerCase().includes("statein('due','held','inactive','quarantined')")) {
    return fail('background_proactive_candidate_schema_invalid');
  }
  const indexes = context.db.prepare('PRAGMA index_list(background_proactive_preflight_attempts)').all() as { name: string; unique: number }[];
  const live = indexes.find((item) => item.name === 'background_proactive_one_live_preflight');
  const sql = context.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='background_proactive_one_live_preflight'").get() as { sql: string } | undefined;
  const columns = context.db.prepare('PRAGMA index_info(background_proactive_one_live_preflight)').all() as { name: string }[];
  const latest = context.db.prepare('PRAGMA index_info(background_proactive_preflight_latest_idx)').all() as { name: string }[];
  const sequenceIndex = context.db.prepare('PRAGMA index_list(background_proactive_preflight_attempts)').all() as { name: string; unique: number }[];
  const sequenceColumns = context.db.prepare('PRAGMA index_info(background_proactive_preflight_sequence_idx)').all() as { name: string }[];
  if (!live || live.unique !== 1 || columns.map((item) => item.name).join(',') !== 'workspace_id,owner_id,privacy_epoch,candidate_id,policy_id,policy_revision' ||
      !sql?.sql.replace(/[\s"`\[\]]/g, '').toLowerCase().endsWith("wherestatusin('claimed','reading')") ||
      latest.map((item) => item.name).join(',') !== 'workspace_id,owner_id,privacy_epoch,policy_id,policy_revision,candidate_id,attempt_number' ||
      sequenceIndex.find((item) => item.name === 'background_proactive_preflight_sequence_idx')?.unique !== 1 ||
      sequenceColumns.map((item) => item.name).join(',') !== 'workspace_id,owner_id,privacy_epoch,policy_id,policy_revision,candidate_id,attempt_number') {
    return fail('background_proactive_candidate_schema_invalid');
  }
  const fk = context.db.prepare('PRAGMA foreign_key_list(background_proactive_preflight_attempts)').all() as { table: string; from: string; to: string }[];
  if (fk.length !== 4 || fk.some((item) => item.table !== 'background_proactive_candidates') ||
      fk.map((item) => `${item.from}:${item.to}`).sort().join(',') !== 'candidate_id:candidate_id,owner_id:owner_id,privacy_epoch:privacy_epoch,workspace_id:workspace_id') {
    return fail('background_proactive_candidate_schema_invalid');
  }
}

function migrateV2ToV3(context: OwnedTransactionContext): void {
  validateSchema(context, 2);
  context.db.exec(`ALTER TABLE background_proactive_candidate_meta RENAME TO background_proactive_candidate_meta_v2;
    CREATE TABLE background_proactive_candidate_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=3)
    ) STRICT;
    INSERT INTO background_proactive_candidate_meta(singleton,schema_version) VALUES(1,3);
    DROP TABLE background_proactive_candidate_meta_v2;
    DROP INDEX background_proactive_one_live_preflight;
    DROP INDEX background_proactive_preflight_latest_idx;
    DROP INDEX background_proactive_preflight_sequence_idx;
    ALTER TABLE background_proactive_preflight_attempts RENAME TO background_proactive_preflight_attempts_v2;
    CREATE TABLE background_proactive_preflight_attempts (
      workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0), attempt_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL, policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL CHECK(policy_revision>0),
      attempt_number INTEGER NOT NULL CHECK(attempt_number>0), capability_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('claimed','reading','deferred','complete','inspect_required')), next_due_at INTEGER NOT NULL CHECK(next_due_at>=0),
      created_at INTEGER NOT NULL, settled_at INTEGER, result_code TEXT, paid_occurrence_id TEXT, paid_attempt_id TEXT,
      recovery_protocol_version INTEGER NOT NULL CHECK(recovery_protocol_version IN (0,1)),
      PRIMARY KEY(workspace_id,owner_id,privacy_epoch,attempt_id),
      FOREIGN KEY(workspace_id,owner_id,privacy_epoch,candidate_id) REFERENCES background_proactive_candidates(workspace_id,owner_id,privacy_epoch,candidate_id),
      CHECK((paid_occurrence_id IS NULL)=(paid_attempt_id IS NULL)),
      CHECK(recovery_protocol_version=1 OR (paid_occurrence_id IS NULL AND paid_attempt_id IS NULL))
    ) STRICT;
    INSERT INTO background_proactive_preflight_attempts(workspace_id,owner_id,privacy_epoch,attempt_id,candidate_id,policy_id,policy_revision,
      attempt_number,capability_hash,status,next_due_at,created_at,settled_at,result_code,paid_occurrence_id,paid_attempt_id,recovery_protocol_version)
      SELECT workspace_id,owner_id,privacy_epoch,attempt_id,candidate_id,policy_id,policy_revision,attempt_number,capability_hash,status,
        next_due_at,created_at,settled_at,result_code,NULL,NULL,0 FROM background_proactive_preflight_attempts_v2;
    DROP TABLE background_proactive_preflight_attempts_v2;
    CREATE UNIQUE INDEX background_proactive_one_live_preflight ON background_proactive_preflight_attempts(workspace_id,owner_id,privacy_epoch,candidate_id,policy_id,policy_revision)
      WHERE status IN ('claimed','reading');
    CREATE INDEX background_proactive_preflight_latest_idx ON background_proactive_preflight_attempts(workspace_id,owner_id,privacy_epoch,policy_id,policy_revision,candidate_id,attempt_number);
    CREATE UNIQUE INDEX background_proactive_preflight_sequence_idx ON background_proactive_preflight_attempts(workspace_id,owner_id,privacy_epoch,policy_id,policy_revision,candidate_id,attempt_number);
    `);
}

function ensureSchema(context: OwnedTransactionContext): void {
  context.assertActive();
  const existing = context.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='background_proactive_candidate_meta'").get();
  if (existing) {
    const version = context.db.prepare('SELECT schema_version FROM background_proactive_candidate_meta WHERE singleton=1').get() as { schema_version: number } | undefined;
    if (!version || !Number.isSafeInteger(version.schema_version) || version.schema_version > SCHEMA_VERSION || version.schema_version < 2) {
      return fail('background_proactive_candidate_schema_unsupported');
    }
    if (version.schema_version === 2) migrateV2ToV3(context);
    validateSchema(context);
    return;
  }
  const partial = context.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'background_proactive_%'").all();
  if (partial.length) return fail('background_proactive_candidate_schema_invalid');
  context.db.exec(`CREATE TABLE background_proactive_candidate_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=3)
  ) STRICT;
  INSERT INTO background_proactive_candidate_meta(singleton,schema_version) VALUES(1,3);
  CREATE TABLE background_proactive_candidate_scopes (
    workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
    revision INTEGER NOT NULL CHECK(revision>=0), quarantined INTEGER NOT NULL CHECK(quarantined IN (0,1)), updated_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch)
  ) STRICT;
  CREATE TABLE background_proactive_candidates (
    workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
    candidate_id TEXT NOT NULL, rule_id TEXT NOT NULL, rule_revision INTEGER NOT NULL CHECK(rule_revision>0),
    account_id TEXT NOT NULL, account_identity_key TEXT NOT NULL, connection_generation INTEGER NOT NULL CHECK(connection_generation>0),
    provider_message_id TEXT NOT NULL, local_message_id TEXT NOT NULL, source_version TEXT NOT NULL,
    eligible_at INTEGER NOT NULL CHECK(eligible_at>=0), next_due_at INTEGER NOT NULL CHECK(next_due_at>=0),
    state TEXT NOT NULL CHECK(state IN ('due','held','inactive','quarantined')), updated_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,candidate_id)
  ) STRICT;
  CREATE INDEX background_proactive_candidate_due_idx ON background_proactive_candidates(workspace_id,owner_id,privacy_epoch,state,next_due_at,candidate_id);
  CREATE TABLE background_proactive_preflight_attempts (
    workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0), attempt_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL, policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL CHECK(policy_revision>0), attempt_number INTEGER NOT NULL CHECK(attempt_number>0), capability_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('claimed','reading','deferred','complete','inspect_required')), next_due_at INTEGER NOT NULL CHECK(next_due_at>=0),
    created_at INTEGER NOT NULL, settled_at INTEGER, result_code TEXT, paid_occurrence_id TEXT, paid_attempt_id TEXT,
    recovery_protocol_version INTEGER NOT NULL CHECK(recovery_protocol_version IN (0,1)),
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,attempt_id),
    FOREIGN KEY(workspace_id,owner_id,privacy_epoch,candidate_id) REFERENCES background_proactive_candidates(workspace_id,owner_id,privacy_epoch,candidate_id),
    CHECK((paid_occurrence_id IS NULL)=(paid_attempt_id IS NULL)),
    CHECK(recovery_protocol_version=1 OR (paid_occurrence_id IS NULL AND paid_attempt_id IS NULL))
  ) STRICT;
  CREATE UNIQUE INDEX background_proactive_one_live_preflight ON background_proactive_preflight_attempts(workspace_id,owner_id,privacy_epoch,candidate_id,policy_id,policy_revision)
    WHERE status IN ('claimed','reading');
  CREATE INDEX background_proactive_preflight_latest_idx ON background_proactive_preflight_attempts(workspace_id,owner_id,privacy_epoch,policy_id,policy_revision,candidate_id,attempt_number);
  CREATE UNIQUE INDEX background_proactive_preflight_sequence_idx ON background_proactive_preflight_attempts(workspace_id,owner_id,privacy_epoch,policy_id,policy_revision,candidate_id,attempt_number);`);
  validateSchema(context);
}

/**
 * Startup-only validation/migration for an already-created candidate index. It deliberately
 * does not create the index when no proactive metadata has ever been written.
 */
export function prepareBackgroundProactiveRecoverySchema(kernel: DurableKernel, capability: ApplicationStartupCapability): boolean {
  if (!kernel || !capability) return fail('background_proactive_startup_capability_invalid');
  return kernel.withColdStartDatabaseTransaction(capability, (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'background_proactive_%'").all() as { name: string }[];
    if (tables.length === 0) return false;
    const context = { db, assertActive() { if (!db.inTransaction) fail('background_proactive_startup_transaction_invalid'); } } as unknown as OwnedTransactionContext;
    ensureSchema(context);
    return true;
  });
}

function validProjection(raw: unknown): BackgroundProactiveCandidateProjection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('background_proactive_projection_invalid');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'candidates,schemaVersion,valid' || value.schemaVersion !== 1 || typeof value.valid !== 'boolean' || !Array.isArray(value.candidates)) {
    return fail('background_proactive_projection_invalid');
  }
  const candidates = value.candidates.map(validCandidate);
  if (!value.valid && candidates.length) return fail('background_proactive_projection_invalid');
  const identities = new Set<string>();
  for (const item of candidates) {
    const id = hash(JSON.stringify([item.ruleId, item.ruleRevision, item.accountIdentityKey, item.providerMessageId, item.sourceVersion]));
    if (identities.has(id)) return fail('background_proactive_projection_invalid');
    identities.add(id);
  }
  return Object.freeze({ schemaVersion: 1, valid: value.valid, candidates: Object.freeze(candidates) });
}

/** Private metadata index and one-use preflight claims. Source bodies never enter this index. */
export class BackgroundProactiveCandidateIndex {
  readonly #kernel: DurableKernel;
  readonly #claims = new WeakMap<object, BackgroundProactivePreflightClaim>();
  readonly #claimAckFinalizations = new WeakMap<object, Readonly<{ outcome: Readonly<{ status: 'deferred' | 'inspect_required'; nextDueAt: number; code: string }>; settledAt: number }>>();

  constructor(kernel: DurableKernel) { if (!kernel) throw new TypeError('background_proactive_candidate_kernel_required'); this.#kernel = kernel; }

  reconcile(context: OwnedTransactionContext, projectionInput: unknown, revision: number, now: number): void {
    this.#kernel.assertOwnedTransactionContext(context);
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(now) || now < 0) return fail('background_proactive_candidate_time_invalid');
    const projection = validProjection(projectionInput);
    ensureSchema(context);
    if (!projection.valid) {
      context.db.prepare(`UPDATE background_proactive_candidates SET state='quarantined',updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch);
      context.db.prepare(`INSERT INTO background_proactive_candidate_scopes(workspace_id,owner_id,privacy_epoch,revision,quarantined,updated_at)
        VALUES(?,?,?,?,1,?) ON CONFLICT(workspace_id,owner_id,privacy_epoch) DO UPDATE SET revision=excluded.revision,quarantined=1,updated_at=excluded.updated_at`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, revision, now);
      return;
    }
    const current = new Set<string>();
    const upsert = context.db.prepare(`INSERT INTO background_proactive_candidates(workspace_id,owner_id,privacy_epoch,candidate_id,rule_id,rule_revision,
      account_id,account_identity_key,connection_generation,provider_message_id,local_message_id,source_version,eligible_at,next_due_at,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,owner_id,privacy_epoch,candidate_id) DO UPDATE SET
      rule_id=excluded.rule_id,rule_revision=excluded.rule_revision,account_id=excluded.account_id,account_identity_key=excluded.account_identity_key,
      connection_generation=excluded.connection_generation,provider_message_id=excluded.provider_message_id,local_message_id=excluded.local_message_id,
      source_version=excluded.source_version,eligible_at=excluded.eligible_at,next_due_at=excluded.next_due_at,state=excluded.state,
      updated_at=excluded.updated_at`);
    for (const item of projection.candidates) {
      const candidateId = hash(JSON.stringify([context.workspaceId, context.ownerId, context.privacyEpoch, item.ruleId, item.ruleRevision,
        item.accountIdentityKey, item.providerMessageId, item.sourceVersion]));
      current.add(candidateId);
      upsert.run(context.workspaceId, context.ownerId, context.privacyEpoch, candidateId, item.ruleId, item.ruleRevision,
        item.accountId, item.accountIdentityKey, item.connectionGeneration, item.providerMessageId, item.localMessageId, item.sourceVersion,
      item.eligibleAt, item.eligibleAt, item.eligibleAt <= now ? 'due' : 'held', now);
    }
    const old = context.db.prepare(`SELECT candidate_id FROM background_proactive_candidates WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
      .all(context.workspaceId, context.ownerId, context.privacyEpoch) as { candidate_id: string }[];
    const deactivate = context.db.prepare(`UPDATE background_proactive_candidates SET state='inactive',updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND candidate_id=? AND state<>'quarantined'`);
    for (const row of old) if (!current.has(row.candidate_id)) deactivate.run(now, context.workspaceId, context.ownerId, context.privacyEpoch, row.candidate_id);
    context.db.prepare(`INSERT INTO background_proactive_candidate_scopes(workspace_id,owner_id,privacy_epoch,revision,quarantined,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,owner_id,privacy_epoch) DO UPDATE SET revision=excluded.revision,quarantined=excluded.quarantined,updated_at=excluded.updated_at`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, revision, 0, now);
  }

  hasScope(context: OwnedTransactionContext): boolean {
    this.#kernel.assertOwnedTransactionContext(context); ensureSchema(context);
    return Boolean(context.db.prepare(`SELECT 1 AS present FROM background_proactive_candidate_scopes WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch));
  }

  listDue(context: OwnedTransactionContext, now: number, afterCandidateId?: string, limit = PAGE_MAX): readonly BackgroundProactiveCandidateRow[] {
    this.#kernel.assertOwnedTransactionContext(context); ensureSchema(context);
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX ||
        (afterCandidateId !== undefined && !SHA256.test(afterCandidateId))) return fail('background_proactive_candidate_query_invalid');
  const rows = context.db.prepare(`SELECT c.candidate_id,c.rule_id,c.rule_revision,c.account_id,c.account_identity_key,c.connection_generation,
      c.provider_message_id,c.local_message_id,c.source_version,c.eligible_at,c.next_due_at,c.state
      FROM background_proactive_candidates c JOIN background_proactive_candidate_scopes s USING(workspace_id,owner_id,privacy_epoch)
      WHERE c.workspace_id=? AND c.owner_id=? AND c.privacy_epoch=? AND s.quarantined=0 AND c.state IN ('due','held') AND c.eligible_at<=?
        AND (? IS NULL OR c.candidate_id>?) ORDER BY c.candidate_id LIMIT ?`)
      .all(context.workspaceId, context.ownerId, context.privacyEpoch, now, afterCandidateId ?? null, afterCandidateId ?? null, limit) as CandidateRow[];
    return Object.freeze(rows.map(candidateFromRow));
  }

  listDueForPolicy(context: OwnedTransactionContext, input: Readonly<{ ruleId: string; ruleRevision: number; policyId: string;
    policyRevision: number; now: number; afterCandidateId?: string; limit?: number }>): readonly BackgroundProactiveCandidateRow[] {
    this.#kernel.assertOwnedTransactionContext(context); ensureSchema(context);
    validatePolicyQuery(input);
    const rows = context.db.prepare(`SELECT c.candidate_id,c.rule_id,c.rule_revision,c.account_id,c.account_identity_key,c.connection_generation,
      c.provider_message_id,c.local_message_id,c.source_version,c.eligible_at,c.next_due_at,c.state
      FROM background_proactive_candidates c JOIN background_proactive_candidate_scopes s USING(workspace_id,owner_id,privacy_epoch)
      WHERE c.workspace_id=? AND c.owner_id=? AND c.privacy_epoch=? AND s.quarantined=0 AND c.rule_id=? AND c.rule_revision=?
        AND c.state IN ('due','held') AND c.eligible_at<=? AND (? IS NULL OR c.candidate_id>?)
        AND NOT EXISTS (SELECT 1 FROM background_proactive_preflight_attempts a WHERE a.workspace_id=c.workspace_id AND a.owner_id=c.owner_id
          AND a.privacy_epoch=c.privacy_epoch AND a.candidate_id=c.candidate_id AND a.policy_id=? AND a.policy_revision=?
          AND a.status IN ('claimed','reading','complete','inspect_required'))
        AND NOT EXISTS (SELECT 1 FROM background_proactive_preflight_attempts a WHERE a.workspace_id=c.workspace_id AND a.owner_id=c.owner_id
          AND a.privacy_epoch=c.privacy_epoch AND a.candidate_id=c.candidate_id AND a.policy_id=? AND a.policy_revision=?
          AND a.attempt_number=(SELECT MAX(latest.attempt_number) FROM background_proactive_preflight_attempts latest
            WHERE latest.workspace_id=c.workspace_id AND latest.owner_id=c.owner_id AND latest.privacy_epoch=c.privacy_epoch
              AND latest.candidate_id=c.candidate_id AND latest.policy_id=a.policy_id AND latest.policy_revision=a.policy_revision)
          AND (a.status<>'deferred' OR a.next_due_at>?))
      ORDER BY c.candidate_id LIMIT ?`)
      .all(context.workspaceId, context.ownerId, context.privacyEpoch, input.ruleId, input.ruleRevision, input.now,
        input.afterCandidateId ?? null, input.afterCandidateId ?? null, input.policyId, input.policyRevision,
        input.policyId, input.policyRevision, input.now, input.limit ?? PAGE_MAX) as CandidateRow[];
    return Object.freeze(rows.map(candidateFromRow));
  }

  readCandidateForPolicy(context: OwnedTransactionContext, input: Readonly<{ candidateId: string; ruleId: string; ruleRevision: number;
    policyId: string; policyRevision: number; now: number }>): BackgroundProactiveCandidateRow | undefined {
    this.#kernel.assertOwnedTransactionContext(context); ensureSchema(context);
    validatePolicyQuery(input);
    if (!SHA256.test(input.candidateId) || !Number.isSafeInteger(input.now) || input.now < 0) return fail('background_proactive_candidate_query_invalid');
    const row = context.db.prepare(`SELECT c.candidate_id,c.rule_id,c.rule_revision,c.account_id,c.account_identity_key,c.connection_generation,
      c.provider_message_id,c.local_message_id,c.source_version,c.eligible_at,c.next_due_at,c.state
      FROM background_proactive_candidates c JOIN background_proactive_candidate_scopes s USING(workspace_id,owner_id,privacy_epoch)
      WHERE c.workspace_id=? AND c.owner_id=? AND c.privacy_epoch=? AND c.candidate_id=? AND c.rule_id=? AND c.rule_revision=?
        AND s.quarantined=0 AND c.state IN ('due','held') AND c.eligible_at<=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, input.candidateId, input.ruleId, input.ruleRevision, input.now) as CandidateRow | undefined;
    return row ? candidateFromRow(row) : undefined;
  }

  assertReadingWithinTransaction(context: OwnedTransactionContext, claim: BackgroundProactivePreflightClaim): BackgroundProactiveCandidateRow {
    const owned = this.#assertClaim(context, claim);
    const attempt = context.db.prepare(`SELECT status FROM background_proactive_preflight_attempts WHERE workspace_id=? AND owner_id=?
      AND privacy_epoch=? AND attempt_id=? AND candidate_id=? AND policy_id=? AND policy_revision=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, owned.attemptId, owned.candidateId, owned.policyId, owned.policyRevision) as
      { status: string } | undefined;
    if (attempt?.status !== 'reading') return fail('background_proactive_claim_not_dispatchable');
    const row = context.db.prepare(`SELECT candidate_id,rule_id,rule_revision,account_id,account_identity_key,connection_generation,
      provider_message_id,local_message_id,source_version,eligible_at,next_due_at,state FROM background_proactive_candidates
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND candidate_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, owned.candidateId) as CandidateRow | undefined;
    if (!row || !['due', 'held'].includes(row.state)) return fail('background_proactive_candidate_stale');
    return candidateFromRow(row);
  }

  readNextDueAt(context: OwnedTransactionContext): number | null {
    this.#kernel.assertOwnedTransactionContext(context); ensureSchema(context);
    const row = context.db.prepare(`SELECT MIN(c.eligible_at) AS due FROM background_proactive_candidates c
      JOIN background_proactive_candidate_scopes s USING(workspace_id,owner_id,privacy_epoch)
      WHERE c.workspace_id=? AND c.owner_id=? AND c.privacy_epoch=? AND s.quarantined=0 AND c.state IN ('due','held')`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch) as { due: number | null };
    return row.due;
  }

  readNextDueAtForPolicy(context: OwnedTransactionContext, input: Readonly<{ ruleId: string; ruleRevision: number; policyId: string;
    policyRevision: number }>): number | null {
    this.#kernel.assertOwnedTransactionContext(context); ensureSchema(context); validatePolicyQuery(input);
    const row = context.db.prepare(`SELECT MIN(MAX(c.eligible_at,COALESCE((SELECT a.next_due_at FROM background_proactive_preflight_attempts a
      WHERE a.workspace_id=c.workspace_id AND a.owner_id=c.owner_id AND a.privacy_epoch=c.privacy_epoch AND a.candidate_id=c.candidate_id
        AND a.policy_id=? AND a.policy_revision=? ORDER BY a.attempt_number DESC LIMIT 1),c.eligible_at))) AS due
      FROM background_proactive_candidates c JOIN background_proactive_candidate_scopes s USING(workspace_id,owner_id,privacy_epoch)
      WHERE c.workspace_id=? AND c.owner_id=? AND c.privacy_epoch=? AND s.quarantined=0 AND c.rule_id=? AND c.rule_revision=?
        AND c.state IN ('due','held')
        AND NOT EXISTS (SELECT 1 FROM background_proactive_preflight_attempts a WHERE a.workspace_id=c.workspace_id AND a.owner_id=c.owner_id
          AND a.privacy_epoch=c.privacy_epoch AND a.candidate_id=c.candidate_id AND a.policy_id=? AND a.policy_revision=?
          AND a.status IN ('claimed','reading','complete','inspect_required'))
        AND NOT EXISTS (SELECT 1 FROM background_proactive_preflight_attempts a WHERE a.workspace_id=c.workspace_id AND a.owner_id=c.owner_id
          AND a.privacy_epoch=c.privacy_epoch AND a.candidate_id=c.candidate_id AND a.policy_id=? AND a.policy_revision=?
          AND a.attempt_number=(SELECT MAX(latest.attempt_number) FROM background_proactive_preflight_attempts latest
            WHERE latest.workspace_id=c.workspace_id AND latest.owner_id=c.owner_id AND latest.privacy_epoch=c.privacy_epoch
              AND latest.candidate_id=c.candidate_id AND latest.policy_id=a.policy_id AND latest.policy_revision=a.policy_revision)
          AND a.status<>'deferred')`)
      .get(input.policyId, input.policyRevision, context.workspaceId, context.ownerId, context.privacyEpoch, input.ruleId, input.ruleRevision,
        input.policyId, input.policyRevision, input.policyId, input.policyRevision) as { due: number | null };
    return row.due;
  }

  prepareClaim(input: Readonly<{ candidateId: string; policyId: string; policyRevision: number; ruleId: string; ruleRevision: number;
    workspaceId: string; ownerId: string; privacyEpoch: number }>): BackgroundProactivePreflightClaim {
    if (!input || !SHA256.test(input.candidateId) || !UUID_V4.test(input.policyId) || !Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1 ||
        !safeText(input.ruleId, 160) || !Number.isSafeInteger(input.ruleRevision) || input.ruleRevision < 1 ||
        !safeText(input.workspaceId) || !safeText(input.ownerId) || !Number.isSafeInteger(input.privacyEpoch) || input.privacyEpoch < 0) {
      return fail('background_proactive_claim_invalid');
    }
    const claim = Object.freeze({ attemptId: randomUUID(), candidateId: input.candidateId, workspaceId: input.workspaceId,
      ownerId: input.ownerId, privacyEpoch: input.privacyEpoch, policyId: input.policyId, policyRevision: input.policyRevision,
      capability: randomUUID() });
    this.#claims.set(claim as object, claim);
    return claim;
  }

  claim(context: OwnedTransactionContext, candidateId: string, policyId: string, policyRevision: number,
    ruleId: string, ruleRevision: number, now: number, preparedClaim?: BackgroundProactivePreflightClaim): BackgroundProactivePreflightClaim | undefined {
    this.#kernel.assertOwnedTransactionContext(context); ensureSchema(context);
    if (!SHA256.test(candidateId) || !UUID_V4.test(policyId) || !Number.isSafeInteger(policyRevision) || policyRevision < 1 ||
        !safeText(ruleId, 160) || !Number.isSafeInteger(ruleRevision) || ruleRevision < 1 || !Number.isSafeInteger(now) || now < 0) {
      return fail('background_proactive_claim_invalid');
    }
    const row = context.db.prepare(`SELECT state,eligible_at,rule_id,rule_revision FROM background_proactive_candidates
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND candidate_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, candidateId) as { state: string; eligible_at: number; rule_id: string; rule_revision: number } | undefined;
    if (!row || !['due', 'held'].includes(row.state) || row.eligible_at > now || row.rule_id !== ruleId || row.rule_revision !== ruleRevision) return undefined;
    const reserved = preparedClaim ?? this.prepareClaim({ candidateId, policyId, policyRevision, ruleId, ruleRevision,
      workspaceId: context.workspaceId, ownerId: context.ownerId, privacyEpoch: context.privacyEpoch });
    const owned = this.#claims.get(reserved as object);
    if (owned !== reserved || reserved.candidateId !== candidateId || reserved.policyId !== policyId || reserved.policyRevision !== policyRevision ||
        reserved.workspaceId !== context.workspaceId || reserved.ownerId !== context.ownerId || reserved.privacyEpoch !== context.privacyEpoch) {
      return fail('background_proactive_claim_invalid');
    }
    const priorExact = context.db.prepare(`SELECT capability_hash,status,recovery_protocol_version FROM background_proactive_preflight_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND candidate_id=? AND policy_id=? AND policy_revision=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, reserved.attemptId, candidateId, policyId, policyRevision) as
      { capability_hash: string; status: string; recovery_protocol_version: number } | undefined;
    if (priorExact) {
      if (priorExact.capability_hash !== hash(reserved.capability) || priorExact.recovery_protocol_version !== 1 ||
          !['claimed', 'reading'].includes(priorExact.status)) return fail('background_proactive_claim_conflict');
      return reserved;
    }
    const previous = context.db.prepare(`SELECT attempt_number,status,next_due_at FROM background_proactive_preflight_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND candidate_id=? AND policy_id=? AND policy_revision=?
      ORDER BY attempt_number DESC LIMIT 1`).get(context.workspaceId, context.ownerId, context.privacyEpoch, candidateId, policyId, policyRevision) as AttemptRow | undefined;
    if (previous && (previous.status !== 'deferred' || previous.next_due_at > now)) return undefined;
    if (previous && previous.status !== 'deferred') return undefined;
    const attemptNumber = (previous?.attempt_number ?? 0) + 1;
    if (!Number.isSafeInteger(attemptNumber)) return fail('background_proactive_attempt_overflow');
    context.db.prepare(`INSERT INTO background_proactive_preflight_attempts(workspace_id,owner_id,privacy_epoch,attempt_id,candidate_id,policy_id,policy_revision,
      attempt_number,capability_hash,status,next_due_at,created_at,settled_at,result_code,paid_occurrence_id,paid_attempt_id,recovery_protocol_version)
      VALUES(?,?,?,?,?,?,?,?,?, 'claimed',?,?,NULL,NULL,NULL,NULL,1)`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, reserved.attemptId, candidateId, policyId, policyRevision, attemptNumber,
        hash(reserved.capability), now, now);
    return reserved;
  }

  /** Atomic one-way association made in the same transaction as the paid occurrence claim. */
  bindPaidOccurrenceWithinTransaction(context: OwnedTransactionContext, claim: BackgroundProactivePreflightClaim,
    binding: BackgroundPaidOccurrenceBinding): void {
    const owned = this.#assertClaim(context, claim);
    if (!binding || !UUID_V4.test(binding.occurrenceId) || !UUID_V4.test(binding.paidAttemptId)) return fail('background_proactive_paid_binding_invalid');
    const row = context.db.prepare(`SELECT a.paid_occurrence_id,a.paid_attempt_id,a.recovery_protocol_version,a.status,
      c.account_identity_key,c.provider_message_id,o.policy_id AS occurrence_policy_id,o.policy_revision AS occurrence_policy_revision,
      o.policy_kind,o.descriptor_json,pa.status AS paid_status,pa.target_id
      FROM background_proactive_preflight_attempts a
      JOIN background_proactive_candidates c ON c.workspace_id=a.workspace_id AND c.owner_id=a.owner_id AND c.privacy_epoch=a.privacy_epoch
        AND c.candidate_id=a.candidate_id
      JOIN background_occurrences o ON o.workspace_id=a.workspace_id AND o.owner_id=a.owner_id AND o.privacy_epoch=a.privacy_epoch
        AND o.occurrence_id=?
      JOIN background_occurrence_attempts pa ON pa.workspace_id=o.workspace_id AND pa.owner_id=o.owner_id AND pa.privacy_epoch=o.privacy_epoch
        AND pa.occurrence_id=o.occurrence_id AND pa.attempt_id=?
      WHERE a.workspace_id=? AND a.owner_id=? AND a.privacy_epoch=? AND a.attempt_id=? AND a.candidate_id=? AND a.policy_id=? AND a.policy_revision=?`)
      .get(binding.occurrenceId, binding.paidAttemptId, context.workspaceId, context.ownerId, context.privacyEpoch,
        owned.attemptId, owned.candidateId, owned.policyId, owned.policyRevision) as
      { paid_occurrence_id: string | null; paid_attempt_id: string | null; recovery_protocol_version: number; status: string;
        account_identity_key: string; provider_message_id: string; occurrence_policy_id: string; occurrence_policy_revision: number;
        policy_kind: string; descriptor_json: string; paid_status: string; target_id: string } | undefined;
    if (!row || row.recovery_protocol_version !== 1 || row.status !== 'reading' || row.paid_status !== 'claimed' ||
        row.occurrence_policy_id !== owned.policyId || row.occurrence_policy_revision !== owned.policyRevision ||
        row.policy_kind !== 'proactive_draft' || row.target_id !== row.account_identity_key) return fail('background_proactive_claim_not_dispatchable');
    let descriptor: unknown;
    try { descriptor = JSON.parse(row.descriptor_json); } catch { return fail('background_proactive_paid_binding_invalid'); }
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) ||
        Object.keys(descriptor).sort().join(',') !== 'accountIdentityKey,kind,providerMessageId,sourceVersionDigest' &&
          Object.keys(descriptor).sort().join(',') !== 'accountIdentityKey,kind,providerMessageId' ||
        (descriptor as Record<string, unknown>).kind !== 'proactive_draft' ||
        (descriptor as Record<string, unknown>).accountIdentityKey !== row.account_identity_key ||
        (descriptor as Record<string, unknown>).providerMessageId !== row.provider_message_id) return fail('background_proactive_paid_binding_invalid');
    if (row.paid_occurrence_id !== null || row.paid_attempt_id !== null) {
      if (row.paid_occurrence_id === binding.occurrenceId && row.paid_attempt_id === binding.paidAttemptId) return;
      return fail('background_proactive_paid_binding_conflict');
    }
    const changed = context.db.prepare(`UPDATE background_proactive_preflight_attempts SET paid_occurrence_id=?,paid_attempt_id=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND candidate_id=? AND policy_id=? AND policy_revision=?
        AND recovery_protocol_version=1 AND status='reading' AND paid_occurrence_id IS NULL AND paid_attempt_id IS NULL`)
      .run(binding.occurrenceId, binding.paidAttemptId, context.workspaceId, context.ownerId, context.privacyEpoch,
        owned.attemptId, owned.candidateId, owned.policyId, owned.policyRevision);
    if (changed.changes !== 1) return fail('background_proactive_paid_binding_conflict');
  }

  assertPaidOccurrenceMappingWithinTransaction(context: OwnedTransactionContext, claim: BackgroundProactivePreflightClaim,
    binding: BackgroundPaidOccurrenceBinding): void {
    const owned = this.#assertClaim(context, claim);
    if (!binding || !UUID_V4.test(binding.occurrenceId) || !UUID_V4.test(binding.paidAttemptId)) return fail('background_proactive_paid_binding_invalid');
    const row = context.db.prepare(`SELECT a.paid_occurrence_id,a.paid_attempt_id,a.recovery_protocol_version,a.status,
      o.policy_id AS occurrence_policy_id,o.policy_revision AS occurrence_policy_revision,o.policy_kind,pa.status AS paid_status,pa.target_id,c.account_identity_key
      FROM background_proactive_preflight_attempts a JOIN background_occurrences o ON o.workspace_id=a.workspace_id AND o.owner_id=a.owner_id
        AND o.privacy_epoch=a.privacy_epoch AND o.occurrence_id=?
      JOIN background_occurrence_attempts pa ON pa.workspace_id=o.workspace_id AND pa.owner_id=o.owner_id AND pa.privacy_epoch=o.privacy_epoch
        AND pa.occurrence_id=o.occurrence_id AND pa.attempt_id=?
      JOIN background_proactive_candidates c ON c.workspace_id=a.workspace_id AND c.owner_id=a.owner_id AND c.privacy_epoch=a.privacy_epoch
        AND c.candidate_id=a.candidate_id
      WHERE a.workspace_id=? AND a.owner_id=? AND a.privacy_epoch=? AND a.attempt_id=? AND a.candidate_id=? AND a.policy_id=? AND a.policy_revision=?`)
      .get(binding.occurrenceId, binding.paidAttemptId, context.workspaceId, context.ownerId, context.privacyEpoch,
        owned.attemptId, owned.candidateId, owned.policyId, owned.policyRevision) as
      { paid_occurrence_id: string | null; paid_attempt_id: string | null; recovery_protocol_version: number; status: string;
        occurrence_policy_id: string; occurrence_policy_revision: number; policy_kind: string; paid_status: string; target_id: string; account_identity_key: string } | undefined;
    if (!row || row.recovery_protocol_version !== 1 || row.paid_occurrence_id !== binding.occurrenceId || row.paid_attempt_id !== binding.paidAttemptId ||
        row.occurrence_policy_id !== owned.policyId || row.occurrence_policy_revision !== owned.policyRevision || row.policy_kind !== 'proactive_draft' ||
        !['claimed', 'dispatching'].includes(row.paid_status) || row.target_id !== row.account_identity_key || row.status !== 'reading') {
      return fail('background_proactive_paid_binding_conflict');
    }
  }

  /** Resolves only the exact preallocated claim whose admission acknowledgement was lost. */
  reconcileUnacknowledgedClaim(context: OwnedTransactionContext, claim: BackgroundProactivePreflightClaim,
    now: number, deferredUntil: number): void {
    const owned = this.#assertClaim(context, claim);
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deferredUntil) || deferredUntil < now) {
      return fail('background_proactive_settlement_invalid');
    }
    const row = context.db.prepare(`SELECT status,paid_occurrence_id,paid_attempt_id,recovery_protocol_version FROM background_proactive_preflight_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND candidate_id=? AND policy_id=? AND policy_revision=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, owned.attemptId, owned.candidateId, owned.policyId, owned.policyRevision) as
      { status: string; paid_occurrence_id: string | null; paid_attempt_id: string | null; recovery_protocol_version: number } | undefined;
    if (!row) return;
    if (row.recovery_protocol_version !== 1 || row.paid_occurrence_id !== null || row.paid_attempt_id !== null) {
      return fail('background_proactive_claim_recovery_conflict');
    }
    let frozen = this.#claimAckFinalizations.get(owned as object);
    if (!frozen) {
      const outcome = row.status === 'claimed'
        ? Object.freeze({ status: 'deferred' as const, nextDueAt: deferredUntil, code: 'claim_ack_unknown' })
        : Object.freeze({ status: 'inspect_required' as const, nextDueAt: Number.MAX_SAFE_INTEGER, code: 'claim_ack_unknown' });
      frozen = Object.freeze({ outcome, settledAt: now });
      this.#claimAckFinalizations.set(owned as object, frozen);
    }
    if (row.status === 'claimed') {
      if (frozen.outcome.status !== 'deferred') return fail('background_proactive_claim_recovery_conflict');
      this.settleWithinTransaction(context, owned, frozen.outcome, frozen.settledAt);
      return;
    }
    if (row.status === 'reading') {
      if (frozen.outcome.status !== 'inspect_required') return fail('background_proactive_claim_recovery_conflict');
      this.settleWithinTransaction(context, owned, frozen.outcome, frozen.settledAt);
      return;
    }
    // An already-finalized exact claim is accepted only when it matches the frozen result.
    this.settleWithinTransaction(context, owned, frozen.outcome, frozen.settledAt);
  }

  markReadingWithinTransaction(context: OwnedTransactionContext, claim: BackgroundProactivePreflightClaim, now: number): void {
    const owned = this.#assertClaim(context, claim);
    const changed = context.db.prepare(`UPDATE background_proactive_preflight_attempts SET status='reading' WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?
      AND attempt_id=? AND candidate_id=? AND policy_id=? AND policy_revision=? AND status='claimed'`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, owned.attemptId, owned.candidateId, owned.policyId, owned.policyRevision);
    if (changed.changes !== 1) return fail('background_proactive_claim_not_dispatchable');
    void now;
  }

  settleWithinTransaction(context: OwnedTransactionContext, claim: BackgroundProactivePreflightClaim,
    outcome: Readonly<{ status: 'complete' | 'deferred' | 'inspect_required'; nextDueAt?: number; code: string }>, now: number): void {
    const owned = this.#assertClaim(context, claim);
    if (!outcome || !['complete', 'deferred', 'inspect_required'].includes(outcome.status) || !/^[a-z][a-z0-9_:-]{0,95}$/.test(outcome.code) ||
        (outcome.status === 'deferred' && outcome.nextDueAt === undefined) ||
        !Number.isSafeInteger(now) || now < 0 || outcome.nextDueAt !== undefined && (!Number.isSafeInteger(outcome.nextDueAt) || outcome.nextDueAt < 0)) {
      return fail('background_proactive_settlement_invalid');
    }
    const row = context.db.prepare(`SELECT status,next_due_at,settled_at,result_code FROM background_proactive_preflight_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND candidate_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, owned.attemptId, owned.candidateId) as {
        status: string; next_due_at: number; settled_at: number | null; result_code: string | null } | undefined;
    if (!row) return fail('background_proactive_claim_not_settleable');
    const next = outcome.status === 'deferred' ? outcome.nextDueAt : Number.MAX_SAFE_INTEGER;
    if (next === undefined) return fail('background_proactive_settlement_invalid');
    if (['deferred', 'complete', 'inspect_required'].includes(row.status)) {
      if (row.status === outcome.status && row.result_code === outcome.code && row.next_due_at === next && row.settled_at === now) return;
      return fail('background_proactive_settlement_conflict');
    }
    if (!['claimed', 'reading'].includes(row.status)) return fail('background_proactive_claim_not_settleable');
    context.db.prepare(`UPDATE background_proactive_preflight_attempts SET status=?,next_due_at=?,settled_at=?,result_code=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?`)
      .run(outcome.status, next, now, outcome.code, context.workspaceId, context.ownerId, context.privacyEpoch, owned.attemptId);
  }

  /** Reads the exact terminal receipt created by the live pre-dispatch snapshot participant. */
  readLiveNotSubmittedSettlementWithinTransaction(context: OwnedTransactionContext, claim: BackgroundProactivePreflightClaim): Readonly<{
    settledAt: number; occurrenceId: string; paidAttemptId: string;
  }> {
    const owned = this.#assertClaim(context, claim);
    const row = context.db.prepare(`SELECT status,next_due_at,settled_at,result_code,paid_occurrence_id,paid_attempt_id
      FROM background_proactive_preflight_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?
        AND candidate_id=? AND policy_id=? AND policy_revision=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, owned.attemptId, owned.candidateId, owned.policyId, owned.policyRevision) as
      { status: string; next_due_at: number; settled_at: number | null; result_code: string | null;
        paid_occurrence_id: string | null; paid_attempt_id: string | null } | undefined;
    if (!row || row.status !== 'complete' || row.result_code !== 'live_not_submitted' || row.next_due_at !== Number.MAX_SAFE_INTEGER ||
        typeof row.settled_at !== 'number' || !Number.isSafeInteger(row.settled_at) || !row.paid_occurrence_id ||
        !UUID_V4.test(row.paid_occurrence_id) || !row.paid_attempt_id || !UUID_V4.test(row.paid_attempt_id)) {
      return fail('background_proactive_settlement_receipt_missing');
    }
    return Object.freeze({ settledAt: row.settled_at, occurrenceId: row.paid_occurrence_id, paidAttemptId: row.paid_attempt_id });
  }

  #assertClaim(context: OwnedTransactionContext, claim: BackgroundProactivePreflightClaim): BackgroundProactivePreflightClaim {
    this.#kernel.assertOwnedTransactionContext(context); ensureSchema(context);
    const owned = claim && typeof claim === 'object' ? this.#claims.get(claim as object) : undefined;
    if (!owned || owned !== claim || owned.workspaceId !== context.workspaceId || owned.ownerId !== context.ownerId || owned.privacyEpoch !== context.privacyEpoch ||
        !UUID_V4.test(owned.attemptId) || !UUID_V4.test(owned.capability)) return fail('background_proactive_claim_invalid');
    const row = context.db.prepare(`SELECT capability_hash,status,recovery_protocol_version FROM background_proactive_preflight_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?
      AND candidate_id=? AND policy_id=? AND policy_revision=?`).get(context.workspaceId, context.ownerId, context.privacyEpoch, owned.attemptId,
      owned.candidateId, owned.policyId, owned.policyRevision) as { capability_hash: string; status: string; recovery_protocol_version: number } | undefined;
    if (!row || row.capability_hash !== hash(owned.capability) || row.recovery_protocol_version !== 1) return fail('background_proactive_claim_invalid');
    return owned;
  }
}
