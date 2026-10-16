import { createHash } from 'node:crypto';
import type { DurableKernel } from '../../server/src/kernel.js';
import type { OwnedTransactionContext } from '../../server/src/kernel.js';
import type { ApplicationStartupCapability } from '../../server/src/applicationStartup.js';
import { prepareBackgroundProactiveRecoverySchema } from '../../server/src/backgroundProactiveCandidates.js';
import { canonicalBackgroundJson } from '../../server/src/backgroundContracts.js';
import { validateOpenRouterBatchLedger, isOpenRouterMailReplyContentJob } from '../services/openRouterBatchJobs';

const SCHEMA_VERSION = 2;
const PAGE_SIZE = 64;
const MINUTE = 60_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const certificateRecoveryCapabilities = new WeakSet<object>();
type RecoveryDatabase = OwnedTransactionContext['db'];

function fail(code: string): never { throw new Error(code); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function tableExists(db: RecoveryDatabase, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function normalizedSql(value: string): string { return value.toLowerCase().replace(/[\s"`\[\]]/g, ''); }

function migrateCertificateSchemaV1ToV2(db: RecoveryDatabase): void {
  const metadata = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_proactive_recovery_schema'")
    .get() as { sql: string } | undefined;
  const metaStrict = db.prepare("SELECT strict FROM pragma_table_list WHERE name='background_proactive_recovery_schema'")
    .get() as { strict: number } | undefined;
  const metaColumns = db.pragma('table_info(background_proactive_recovery_schema)') as
    { name: string; type: string; notnull: number; pk: number }[];
  const metaRows = db.prepare('SELECT singleton,version FROM background_proactive_recovery_schema').all() as
    { singleton: number; version: number }[];
  const columns = db.pragma('table_info(background_proactive_not_submitted_certificates)') as
    { name: string; type: string; notnull: number; pk: number }[];
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_proactive_not_submitted_certificates'")
    .get() as { sql: string } | undefined;
  const strict = db.prepare("SELECT strict FROM pragma_table_list WHERE name='background_proactive_not_submitted_certificates'")
    .get() as { strict: number } | undefined;
  const oldColumns = [
    ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3],
    ['job_id', 'TEXT', 1, 4], ['custom_id', 'TEXT', 1, 0], ['request_sha256', 'TEXT', 1, 0],
    ['marker_sha256', 'TEXT', 1, 0], ['job_projection_sha256', 'TEXT', 1, 0], ['preflight_attempt_id', 'TEXT', 1, 0],
    ['occurrence_id', 'TEXT', 1, 0], ['paid_attempt_id', 'TEXT', 1, 0], ['command_id', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0],
  ];
  const metaSql = metadata?.sql ? normalizedSql(metadata.sql) : '';
  if (metaColumns.length !== 2 || metaColumns[0]?.name !== 'singleton' || metaColumns[0].type.toUpperCase() !== 'INTEGER' ||
      metaColumns[0].notnull !== 0 || metaColumns[0].pk !== 1 || metaColumns[1]?.name !== 'version' ||
      metaColumns[1].type.toUpperCase() !== 'INTEGER' || metaColumns[1].notnull !== 1 || metaColumns[1].pk !== 0 ||
      metaStrict?.strict !== 1 || !metaSql.includes('check(singleton=1)') || !metaSql.includes('check(version=1)') ||
      metaRows.length !== 1 || metaRows[0]?.singleton !== 1 || metaRows[0].version !== 1 ||
      columns.length !== oldColumns.length || columns.some((item, index) => {
    const target = oldColumns[index]!;
    return item.name !== target[0] || item.type.toUpperCase() !== target[1] || item.notnull !== target[2] || item.pk !== target[3];
  }) || strict?.strict !== 1 || !table?.sql) return fail('background_proactive_recovery_schema_invalid');
  const sql = normalizedSql(table.sql);
  if (!sql.includes('check(custom_id=job_id)') || !sql.includes('check(command_id=paid_attempt_id)') ||
      !sql.includes('unique(workspace_id,owner_id,privacy_epoch,preflight_attempt_id)') ||
      !sql.includes('unique(workspace_id,owner_id,privacy_epoch,paid_attempt_id)')) return fail('background_proactive_recovery_schema_invalid');
  for (const [name, expectedSql] of [
    ['background_proactive_not_submitted_no_update', "CREATE TRIGGER background_proactive_not_submitted_no_update BEFORE UPDATE ON background_proactive_not_submitted_certificates BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_immutable'); END"],
    ['background_proactive_not_submitted_erase_only', "CREATE TRIGGER background_proactive_not_submitted_erase_only BEFORE DELETE ON background_proactive_not_submitted_certificates WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1 BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_retained'); END"],
  ] as const) {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name='background_proactive_not_submitted_certificates'").get(name) as { sql: string } | undefined;
    if (!trigger?.sql || normalizedSql(trigger.sql) !== normalizedSql(expectedSql)) return fail('background_proactive_recovery_schema_invalid');
  }
  db.exec(`DROP TRIGGER background_proactive_not_submitted_no_update;
    DROP TRIGGER background_proactive_not_submitted_erase_only;
    CREATE TABLE background_proactive_not_submitted_certificates_v2 (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
      job_id TEXT NOT NULL CHECK(length(job_id)=36), custom_id TEXT NOT NULL CHECK(custom_id=job_id),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64), marker_sha256 TEXT NOT NULL CHECK(length(marker_sha256)=64),
      job_projection_sha256 TEXT NOT NULL CHECK(length(job_projection_sha256)=64),
      proof_kind TEXT NOT NULL CHECK(proof_kind IN ('cold_checkpoint','live_pre_dispatch')),
      ticket_id TEXT CHECK(ticket_id IS NULL OR length(ticket_id)=36),
      preflight_attempt_id TEXT NOT NULL CHECK(length(preflight_attempt_id)=36),
      occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36), paid_attempt_id TEXT NOT NULL CHECK(length(paid_attempt_id)=36),
      command_id TEXT NOT NULL CHECK(command_id=paid_attempt_id), created_at INTEGER NOT NULL CHECK(created_at>=0),
      PRIMARY KEY(workspace_id,owner_id,privacy_epoch,job_id),
      UNIQUE(workspace_id,owner_id,privacy_epoch,preflight_attempt_id),
      UNIQUE(workspace_id,owner_id,privacy_epoch,paid_attempt_id),
      CHECK((proof_kind='cold_checkpoint' AND ticket_id IS NULL) OR
        (proof_kind='live_pre_dispatch' AND ticket_id IS NOT NULL AND length(ticket_id)=36))
    ) STRICT;
    INSERT INTO background_proactive_not_submitted_certificates_v2(
      workspace_id,owner_id,privacy_epoch,job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,
      proof_kind,ticket_id,preflight_attempt_id,occurrence_id,paid_attempt_id,command_id,created_at)
    SELECT workspace_id,owner_id,privacy_epoch,job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,
      'cold_checkpoint',NULL,preflight_attempt_id,occurrence_id,paid_attempt_id,command_id,created_at
    FROM background_proactive_not_submitted_certificates;
    DROP TABLE background_proactive_not_submitted_certificates;
    ALTER TABLE background_proactive_not_submitted_certificates_v2 RENAME TO background_proactive_not_submitted_certificates;
    CREATE TABLE background_proactive_recovery_schema_v2 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=${SCHEMA_VERSION})
    ) STRICT;
    INSERT INTO background_proactive_recovery_schema_v2(singleton,version) VALUES(1,${SCHEMA_VERSION});
    DROP TABLE background_proactive_recovery_schema;
    ALTER TABLE background_proactive_recovery_schema_v2 RENAME TO background_proactive_recovery_schema;
    CREATE TRIGGER background_proactive_not_submitted_no_update BEFORE UPDATE ON background_proactive_not_submitted_certificates
      BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_immutable'); END;
    CREATE TRIGGER background_proactive_not_submitted_erase_only BEFORE DELETE ON background_proactive_not_submitted_certificates
      WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
      BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_retained'); END;`);
}

function jobIntegrityProjection(job: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...job };
  delete copy.status;
  delete copy.failureCode;
  delete copy.updatedAt;
  return copy;
}

function ensureCertificateSchema(db: RecoveryDatabase): void {
  const hasMeta = tableExists(db, 'background_proactive_recovery_schema');
  const hasCertificates = tableExists(db, 'background_proactive_not_submitted_certificates');
  if (!hasMeta && !hasCertificates) {
    db.exec(`CREATE TABLE background_proactive_recovery_schema (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=${SCHEMA_VERSION})
      ) STRICT;
      INSERT INTO background_proactive_recovery_schema(singleton,version) VALUES(1,${SCHEMA_VERSION});
      CREATE TABLE background_proactive_not_submitted_certificates (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
        job_id TEXT NOT NULL CHECK(length(job_id)=36), custom_id TEXT NOT NULL CHECK(custom_id=job_id),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64), marker_sha256 TEXT NOT NULL CHECK(length(marker_sha256)=64),
        job_projection_sha256 TEXT NOT NULL CHECK(length(job_projection_sha256)=64),
        proof_kind TEXT NOT NULL CHECK(proof_kind IN ('cold_checkpoint','live_pre_dispatch')),
        ticket_id TEXT CHECK(ticket_id IS NULL OR length(ticket_id)=36),
        preflight_attempt_id TEXT NOT NULL CHECK(length(preflight_attempt_id)=36),
        occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36), paid_attempt_id TEXT NOT NULL CHECK(length(paid_attempt_id)=36),
        command_id TEXT NOT NULL CHECK(command_id=paid_attempt_id), created_at INTEGER NOT NULL CHECK(created_at>=0),
        PRIMARY KEY(workspace_id,owner_id,privacy_epoch,job_id),
        UNIQUE(workspace_id,owner_id,privacy_epoch,preflight_attempt_id),
        UNIQUE(workspace_id,owner_id,privacy_epoch,paid_attempt_id),
      CHECK((proof_kind='cold_checkpoint' AND ticket_id IS NULL) OR
        (proof_kind='live_pre_dispatch' AND ticket_id IS NOT NULL AND length(ticket_id)=36))
      ) STRICT;
      CREATE TRIGGER background_proactive_not_submitted_no_update BEFORE UPDATE ON background_proactive_not_submitted_certificates
        BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_immutable'); END;
      CREATE TRIGGER background_proactive_not_submitted_erase_only BEFORE DELETE ON background_proactive_not_submitted_certificates
        WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
        BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_retained'); END;`);
    return;
  }
  if (!hasMeta || !hasCertificates) return fail('background_proactive_recovery_schema_invalid');
  let versionRows = db.prepare('SELECT singleton,version FROM background_proactive_recovery_schema').all() as { singleton: number; version: number }[];
  if (versionRows.length === 1 && versionRows[0]?.singleton === 1 && versionRows[0].version === 1) {
    migrateCertificateSchemaV1ToV2(db);
    versionRows = db.prepare('SELECT singleton,version FROM background_proactive_recovery_schema').all() as { singleton: number; version: number }[];
  }
  if (versionRows.length !== 1 || versionRows[0]?.singleton !== 1 || versionRows[0].version !== SCHEMA_VERSION) {
    return fail('background_proactive_recovery_schema_unsupported');
  }
  const expected = [
    ['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3],
    ['job_id', 'TEXT', 1, 4], ['custom_id', 'TEXT', 1, 0], ['request_sha256', 'TEXT', 1, 0],
    ['marker_sha256', 'TEXT', 1, 0], ['job_projection_sha256', 'TEXT', 1, 0], ['proof_kind', 'TEXT', 1, 0], ['ticket_id', 'TEXT', 0, 0],
    ['preflight_attempt_id', 'TEXT', 1, 0],
    ['occurrence_id', 'TEXT', 1, 0], ['paid_attempt_id', 'TEXT', 1, 0], ['command_id', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0],
  ];
  const columns = db.pragma('table_info(background_proactive_not_submitted_certificates)') as { name: string; type: string; notnull: number; pk: number }[];
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_proactive_not_submitted_certificates'").get() as { sql: string } | undefined;
  const strict = db.prepare("SELECT strict FROM pragma_table_list WHERE name='background_proactive_not_submitted_certificates'").get() as { strict: number } | undefined;
  if (columns.length !== expected.length || columns.some((item, index) => {
    const target = expected[index]!;
    return item.name !== target[0] || item.type.toUpperCase() !== target[1] || item.notnull !== target[2] || item.pk !== target[3];
  }) || strict?.strict !== 1 || !table?.sql) return fail('background_proactive_recovery_schema_invalid');
  const tableSql = normalizedSql(table.sql);
  if (!tableSql.includes('check(custom_id=job_id)') || !tableSql.includes('check(command_id=paid_attempt_id)') ||
      !tableSql.includes("check(proof_kindin('cold_checkpoint','live_pre_dispatch'))") ||
      !tableSql.includes("check((proof_kind='cold_checkpoint'andticket_idisnull)or(proof_kind='live_pre_dispatch'andticket_idisnotnullandlength(ticket_id)=36))") ||
      !tableSql.includes('unique(workspace_id,owner_id,privacy_epoch,preflight_attempt_id)') ||
      !tableSql.includes('unique(workspace_id,owner_id,privacy_epoch,paid_attempt_id)')) return fail('background_proactive_recovery_schema_invalid');
  for (const [name, expectedSql] of [
    ['background_proactive_not_submitted_no_update', "CREATE TRIGGER background_proactive_not_submitted_no_update BEFORE UPDATE ON background_proactive_not_submitted_certificates BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_immutable'); END"],
    ['background_proactive_not_submitted_erase_only', "CREATE TRIGGER background_proactive_not_submitted_erase_only BEFORE DELETE ON background_proactive_not_submitted_certificates WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1 BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_retained'); END"],
  ] as const) {
    const trigger = db.prepare('SELECT sql FROM sqlite_master WHERE type=\'trigger\' AND name=? AND tbl_name=\'background_proactive_not_submitted_certificates\'').get(name) as { sql: string } | undefined;
    if (!trigger?.sql || normalizedSql(trigger.sql) !== normalizedSql(expectedSql)) return fail('background_proactive_recovery_schema_invalid');
  }
}

function assertJournalSchema(db: RecoveryDatabase): boolean {
  const hasTable = tableExists(db, 'async_command_journal');
  const hasVersion = tableExists(db, 'command_journal_schema');
  if (hasTable !== hasVersion) return fail('proactive_recovery_journal_schema_invalid');
  if (!hasTable) return false;
  const version = db.prepare('SELECT singleton,version FROM command_journal_schema').all() as { singleton: number; version: number }[];
  if (version.length !== 1 || version[0]?.singleton !== 1 || version[0].version !== 3) return fail('proactive_recovery_journal_schema_invalid');
  const cols = db.pragma('table_info(async_command_journal)') as { name: string }[];
  const names = cols.map((item) => item.name);
  for (const required of ['workspace_id', 'idempotency_key', 'owner_id', 'privacy_epoch', 'command_kind', 'status', 'checkpoint_revision', 'snapshot_digest']) {
    if (!names.includes(required)) return fail('proactive_recovery_journal_schema_invalid');
  }
  return true;
}

interface ActivePreflight {
  workspace_id: string; owner_id: string; privacy_epoch: number; attempt_id: string; candidate_id: string; policy_id: string;
  policy_revision: number; attempt_number: number; status: 'claimed' | 'reading'; next_due_at: number;
  paid_occurrence_id: string | null; paid_attempt_id: string | null; recovery_protocol_version: number;
}

/** Cold-start recovery is synchronous and never writes canonical snapshots or dispatches provider work. */
export function recoverProactivePreflights(input: Readonly<{ kernel: DurableKernel; startupCapability: ApplicationStartupCapability }>): void {
  if (!input || !input.kernel || !input.startupCapability || certificateRecoveryCapabilities.has(input.startupCapability as object)) {
    return fail('proactive_preflight_recovery_invalid');
  }
  certificateRecoveryCapabilities.add(input.startupCapability as object);
  try {
    const hasIndex = prepareBackgroundProactiveRecoverySchema(input.kernel, input.startupCapability);
    if (!hasIndex) return;
    input.kernel.withColdStartDatabaseTransaction(input.startupCapability, (db) => {
      ensureCertificateSchema(db);
      assertJournalSchema(db);
    });
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0) return fail('proactive_preflight_recovery_clock_invalid');
    let afterWorkspaceId = '';
    for (;;) {
      const page = input.kernel.withColdStartDatabaseTransaction(input.startupCapability, (db) => db.prepare(`
        SELECT DISTINCT workspace_id FROM background_proactive_preflight_attempts
        WHERE workspace_id>? ORDER BY workspace_id LIMIT ?`).all(afterWorkspaceId, PAGE_SIZE) as { workspace_id: string }[]);
      if (page.length === 0) break;
      for (const item of page) {
        if (typeof item.workspace_id !== 'string' || item.workspace_id.length === 0) return fail('proactive_preflight_storage_invalid');
        afterWorkspaceId = item.workspace_id;
        const workspace = input.kernel.readColdStartWorkspace(input.startupCapability, item.workspace_id);
        if (!workspace) continue;
        let ledger: ReturnType<typeof validateOpenRouterBatchLedger>;
        const snapshot = workspace.snapshot as Record<string, unknown>;
        const hasLedger = Object.hasOwn(snapshot, 'openRouterBatchLedger');
        const rawLedger = snapshot.openRouterBatchLedger;
        try { ledger = validateOpenRouterBatchLedger(rawLedger); }
        catch {
          if (hasLedger) return fail('proactive_recovery_ledger_invalid');
          ledger = Object.freeze({ version: 1, jobs: Object.freeze([]) });
        }
        let afterAttemptId = '';
        for (;;) {
          const rows = input.kernel.withColdStartDatabaseTransaction(input.startupCapability, (db) => db.prepare(`
            SELECT workspace_id,owner_id,privacy_epoch,attempt_id,candidate_id,policy_id,policy_revision,attempt_number,status,next_due_at,
              paid_occurrence_id,paid_attempt_id,recovery_protocol_version
            FROM background_proactive_preflight_attempts WHERE workspace_id=? AND attempt_id>? AND status IN ('claimed','reading')
            ORDER BY attempt_id LIMIT ?`).all(item.workspace_id, afterAttemptId, PAGE_SIZE) as ActivePreflight[]);
          if (rows.length === 0) break;
          for (const row of rows) {
            afterAttemptId = row.attempt_id;
            if (row.workspace_id !== workspace.workspaceId || row.owner_id !== workspace.ownerId || row.privacy_epoch !== workspace.privacyEpoch) continue;
            recoverOne(input.kernel, input.startupCapability, row, ledger.jobs, now);
          }
        }
      }
      if (page.length < PAGE_SIZE) break;
    }
  } catch (error) {
    certificateRecoveryCapabilities.delete(input.startupCapability as object);
    throw error;
  }
}

function recoverOne(kernel: DurableKernel, capability: ApplicationStartupCapability, row: ActivePreflight,
  jobs: readonly unknown[], now: number): void {
  if (!UUID_V4.test(row.attempt_id) || !SHA256.test(row.candidate_id) || !UUID_V4.test(row.policy_id) ||
      !Number.isSafeInteger(row.policy_revision) || row.policy_revision < 1 || !Number.isSafeInteger(row.attempt_number) || row.attempt_number < 1 ||
      !Number.isSafeInteger(row.recovery_protocol_version) || ![0, 1].includes(row.recovery_protocol_version)) return fail('proactive_preflight_storage_invalid');
  if (row.recovery_protocol_version === 0) return markLegacyInspection(kernel, capability, row, now);
  if (!row.paid_occurrence_id && !row.paid_attempt_id) {
    kernel.withColdStartDatabaseTransaction(capability, (db) => {
      const result = db.prepare(`UPDATE background_proactive_preflight_attempts SET status='deferred',next_due_at=?,settled_at=?,result_code='startup_unmapped_preflight'
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND candidate_id=? AND policy_id=? AND policy_revision=?
          AND recovery_protocol_version=1 AND paid_occurrence_id IS NULL AND paid_attempt_id IS NULL AND status IN ('claimed','reading')`)
        .run(now + MINUTE, now, row.workspace_id, row.owner_id, row.privacy_epoch, row.attempt_id, row.candidate_id, row.policy_id, row.policy_revision);
      if (result.changes !== 1) return fail('proactive_preflight_recovery_conflict');
    });
    return;
  }
  if (!row.paid_occurrence_id || !row.paid_attempt_id || !UUID_V4.test(row.paid_occurrence_id) || !UUID_V4.test(row.paid_attempt_id)) {
    return fail('proactive_preflight_mapping_invalid');
  }
  recoverMapped(kernel, capability, row, jobs, now);
}

function markLegacyInspection(kernel: DurableKernel, capability: ApplicationStartupCapability, row: ActivePreflight, now: number): void {
  kernel.withColdStartDatabaseTransaction(capability, (db) => {
    if (row.paid_occurrence_id || row.paid_attempt_id) return fail('proactive_preflight_legacy_mapping_invalid');
    db.prepare(`UPDATE background_proactive_preflight_attempts SET status='inspect_required',next_due_at=?,settled_at=?,result_code='legacy_claim_requires_inspection'
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status IN ('claimed','reading') AND recovery_protocol_version=0`)
      .run(Number.MAX_SAFE_INTEGER, now, row.workspace_id, row.owner_id, row.privacy_epoch, row.attempt_id);
  });
}

function recoverMapped(kernel: DurableKernel, capability: ApplicationStartupCapability, row: ActivePreflight,
  jobs: readonly unknown[], now: number): void {
  const markerMatches = jobs.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const marker = (candidate as Record<string, unknown>).proactiveMailReply;
    return Boolean(marker && typeof marker === 'object' && (marker as Record<string, unknown>).policyId === row.policy_id &&
      (marker as Record<string, unknown>).policyRevision === row.policy_revision &&
      (marker as Record<string, unknown>).occurrenceId === row.paid_occurrence_id &&
      (marker as Record<string, unknown>).attemptId === row.paid_attempt_id);
  });
  if (markerMatches.length > 1 || (markerMatches.length === 1 && !isOpenRouterMailReplyContentJob(markerMatches[0] as never))) {
    return fail('proactive_preflight_job_invalid');
  }
  const job = markerMatches.length === 1 ? markerMatches[0] as unknown as Record<string, unknown> : undefined;
  if (job && (typeof job.id !== 'string' || !UUID_V4.test(job.id) || job.customId !== job.id || typeof job.requestSha256 !== 'string' ||
      !SHA256.test(job.requestSha256) || typeof job.requestBody !== 'string' || sha256(job.requestBody) !== job.requestSha256)) {
    return fail('proactive_preflight_job_invalid');
  }
  const dbRead = kernel.withColdStartDatabaseTransaction(capability, (db) => {
    const occurrence = db.prepare(`SELECT o.policy_id,o.policy_revision,o.policy_kind,o.status,o.descriptor_json,o.batch_job_id,
        a.status AS paid_status,a.target_id,a.target_generation,a.finalization_operation,a.finalization_request_json,
        a.finalization_receipt_json,a.finalization_receipt_digest,t.status AS target_status,t.attempt_id AS target_attempt_id,
        t.target_id AS target_key,t.target_generation AS target_key_generation
      FROM background_occurrences o JOIN background_occurrence_attempts a ON a.workspace_id=o.workspace_id AND a.owner_id=o.owner_id
        AND a.privacy_epoch=o.privacy_epoch AND a.occurrence_id=o.occurrence_id
      JOIN background_occurrence_targets t ON t.workspace_id=o.workspace_id AND t.owner_id=o.owner_id AND t.privacy_epoch=o.privacy_epoch
        AND t.occurrence_id=o.occurrence_id AND t.target_id=a.target_id AND t.target_generation=a.target_generation
      WHERE o.workspace_id=? AND o.owner_id=? AND o.privacy_epoch=? AND o.occurrence_id=? AND a.attempt_id=?`)
      .get(row.workspace_id, row.owner_id, row.privacy_epoch, row.paid_occurrence_id, row.paid_attempt_id) as Record<string, unknown> | undefined;
    if (!occurrence) return fail('proactive_preflight_paid_mapping_invalid');
    const linkPresent = tableExists(db, 'background_paid_batch_links');
    const link = linkPresent ? db.prepare(`SELECT occurrence_id,attempt_id,command_id,job_id,custom_id,request_sha256 FROM background_paid_batch_links
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND (occurrence_id=? OR attempt_id=? OR job_id=?)`)
      .get(row.workspace_id, row.owner_id, row.privacy_epoch, row.paid_occurrence_id, row.paid_attempt_id, job?.id ?? null) as Record<string, unknown> | undefined : undefined;
    const hasJournal = assertJournalSchema(db);
    const journal = hasJournal ? db.prepare(`SELECT idempotency_key,owner_id,privacy_epoch,command_kind,status,checkpoint_revision,snapshot_digest
      FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`).get(row.workspace_id, row.paid_attempt_id) as Record<string, unknown> | undefined : undefined;
    const workspaceState = db.prepare(`SELECT id,owner_id,privacy_epoch,revision,snapshot_json FROM workspaces WHERE id=?`)
      .get(row.workspace_id) as { id: string; owner_id: string; privacy_epoch: number; revision: number; snapshot_json: string } | undefined;
    const candidate = db.prepare(`SELECT candidate_id,rule_id,rule_revision,account_identity_key,connection_generation,provider_message_id
      FROM background_proactive_candidates WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND candidate_id=?`)
      .get(row.workspace_id, row.owner_id, row.privacy_epoch, row.candidate_id) as Record<string, unknown> | undefined;
    return { occurrence, link, journal, candidate, workspaceState };
  });
  if (!job) {
    if (dbRead.link || dbRead.journal || !dbRead.occurrence || !dbRead.candidate) return fail('proactive_preflight_unmapped_paid_evidence');
    const occurrence = dbRead.occurrence;
    let descriptor: unknown;
    try { descriptor = JSON.parse(String(occurrence.descriptor_json)); } catch { return fail('proactive_preflight_paid_mapping_invalid'); }
    const value = descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor) ? descriptor as Record<string, unknown> : undefined;
    const keys = value ? Object.keys(value).sort().join(',') : '';
    if (!value || (keys !== 'accountIdentityKey,kind,providerMessageId' && keys !== 'accountIdentityKey,kind,providerMessageId,sourceVersionDigest') ||
        value.kind !== 'proactive_draft' || occurrence.policy_kind !== 'proactive_draft' || occurrence.policy_id !== row.policy_id ||
        occurrence.policy_revision !== row.policy_revision || occurrence.status !== 'claimed' || occurrence.batch_job_id !== null ||
        occurrence.paid_status !== 'claimed' || occurrence.finalization_operation !== null || occurrence.finalization_request_json !== null ||
        occurrence.finalization_receipt_json !== null || occurrence.finalization_receipt_digest !== null || occurrence.target_status !== 'claimed' ||
        occurrence.target_attempt_id !== row.paid_attempt_id || occurrence.target_key !== occurrence.target_id ||
        occurrence.target_key_generation !== occurrence.target_generation || value.accountIdentityKey !== occurrence.target_id ||
        typeof value.accountIdentityKey !== 'string' || !SHA256.test(value.accountIdentityKey) ||
        typeof occurrence.target_generation !== 'number' || !Number.isSafeInteger(occurrence.target_generation) || occurrence.target_generation < 1 ||
        typeof value.providerMessageId !== 'string' || !value.providerMessageId ||
        dbRead.candidate.candidate_id !== row.candidate_id || typeof dbRead.candidate.rule_id !== 'string' || !dbRead.candidate.rule_id ||
        typeof dbRead.candidate.rule_revision !== 'number' || !Number.isSafeInteger(dbRead.candidate.rule_revision) || dbRead.candidate.rule_revision < 1 ||
        dbRead.candidate.account_identity_key !== value.accountIdentityKey || dbRead.candidate.connection_generation !== occurrence.target_generation ||
        dbRead.candidate.provider_message_id !== value.providerMessageId ||
        (value.sourceVersionDigest !== undefined && (typeof value.sourceVersionDigest !== 'string' || !SHA256.test(value.sourceVersionDigest)))) {
      return fail('proactive_preflight_paid_not_predispatch');
    }
    const request = canonicalBackgroundJson({ operation: 'defer', resultCode: 'startup_before_submit_recovered', nextDueAt: now + MINUTE });
    const receipt = canonicalBackgroundJson({ schemaVersion: 1, operation: 'defer', attemptId: row.paid_attempt_id,
      resultCode: 'startup_before_submit_recovered', nextDueAt: now + MINUTE, settledAt: now });
    kernel.withColdStartDatabaseTransaction(capability, (db) => {
      const paid = db.prepare(`UPDATE background_occurrence_attempts SET status='skipped',settled_at=?,accounting_json=?,
        result_code='startup_before_submit_recovered',finalization_operation='defer',finalization_request_json=?,
        finalization_receipt_json=?,finalization_receipt_digest=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND attempt_id=? AND target_id=? AND target_generation=?
          AND status='claimed' AND finalization_operation IS NULL AND dispatch_started_at IS NULL`)
        .run(now, canonicalBackgroundJson({ status: 'not_applicable' }), request, receipt, sha256(receipt), row.workspace_id, row.owner_id,
          row.privacy_epoch, row.paid_occurrence_id, row.paid_attempt_id, occurrence.target_id, occurrence.target_generation);
      const target = db.prepare(`UPDATE background_occurrence_targets SET status='pending',attempt_id=NULL,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?
          AND status='claimed' AND attempt_id=?`)
        .run(now + MINUTE, row.workspace_id, row.owner_id, row.privacy_epoch, row.paid_occurrence_id, occurrence.target_id,
          occurrence.target_generation, row.paid_attempt_id);
      const paidOccurrence = db.prepare(`UPDATE background_occurrences SET status='scheduled',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status='claimed' AND batch_job_id IS NULL`)
        .run(now, row.workspace_id, row.owner_id, row.privacy_epoch, row.paid_occurrence_id);
      const preflight = db.prepare(`UPDATE background_proactive_preflight_attempts SET status='deferred',next_due_at=?,settled_at=?,
        result_code='startup_before_submit_recovered'
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND candidate_id=? AND policy_id=? AND policy_revision=?
          AND status='reading' AND recovery_protocol_version=1 AND paid_occurrence_id=? AND paid_attempt_id=?`)
        .run(now + MINUTE, now, row.workspace_id, row.owner_id, row.privacy_epoch, row.attempt_id, row.candidate_id, row.policy_id,
          row.policy_revision, row.paid_occurrence_id, row.paid_attempt_id);
      if (paid.changes !== 1 || target.changes !== 1 || paidOccurrence.changes !== 1 || preflight.changes !== 1) {
        return fail('proactive_preflight_recovery_conflict');
      }
    });
    return;
  }
  if (dbRead.link) {
    const link = dbRead.link;
    if (link.occurrence_id !== row.paid_occurrence_id || link.attempt_id !== row.paid_attempt_id || link.command_id !== row.paid_attempt_id ||
        link.job_id !== job.id || link.custom_id !== job.customId || link.request_sha256 !== job.requestSha256 ||
        !['submitting', 'submission_unknown', 'queued', 'processing', 'completed', 'failed', 'expired', 'cancelled', 'result_stale',
          'result_invalid', 'result_truncated', 'result_not_retained', 'cleanup_pending', 'source_removed'].includes(String(job.status))) {
      return fail('proactive_preflight_paid_link_invalid');
    }
    if (dbRead.journal && (dbRead.journal.owner_id !== row.owner_id || dbRead.journal.privacy_epoch !== row.privacy_epoch ||
        dbRead.journal.command_kind !== 'mail.replybatch.submit')) return fail('proactive_preflight_journal_invalid');
    kernel.withColdStartDatabaseTransaction(capability, (db) => {
      const changed = db.prepare(`UPDATE background_proactive_preflight_attempts SET status='complete',next_due_at=?,settled_at=?,result_code='paid_checkpoint_committed'
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status IN ('claimed','reading')
          AND paid_occurrence_id=? AND paid_attempt_id=? AND recovery_protocol_version=1`)
        .run(Number.MAX_SAFE_INTEGER, now, row.workspace_id, row.owner_id, row.privacy_epoch, row.attempt_id, row.paid_occurrence_id, row.paid_attempt_id);
      if (changed.changes !== 1) return fail('proactive_preflight_recovery_conflict');
    });
    return;
  }
  const journal = dbRead.journal;
  const workspaceState = dbRead.workspaceState;
  const journalScopeMatches = !journal || (journal.idempotency_key === row.paid_attempt_id && journal.owner_id === row.owner_id &&
    journal.privacy_epoch === row.privacy_epoch && journal.command_kind === 'mail.replybatch.submit');
  const uncheckpointedAdmission = journal?.status === 'claimed' || journal?.status === 'inspect_required'
    ? journal.checkpoint_revision === null && journal.snapshot_digest === null
    : false;
  const exactPreparingCheckpoint = Boolean(journal?.status === 'checkpointed' && workspaceState && job?.status === 'preparing' &&
    job.unknownCharge === false && job.batchId === undefined && job.resultText === undefined && job.resultSha256 === undefined &&
    workspaceState.id === row.workspace_id && workspaceState.owner_id === row.owner_id && workspaceState.privacy_epoch === row.privacy_epoch &&
    Number.isSafeInteger(workspaceState.revision) && journal.checkpoint_revision === workspaceState.revision &&
    typeof workspaceState.snapshot_json === 'string' && journal.snapshot_digest === sha256(workspaceState.snapshot_json));
  if (!journalScopeMatches || (job ? !exactPreparingCheckpoint : Boolean(journal && !uncheckpointedAdmission))) {
    return fail('proactive_preflight_journal_not_predispatch');
  }
  const marker = job.proactiveMailReply as Record<string, unknown> | undefined;
  if (!marker || job.status !== 'preparing' || job.id !== job.customId || job.batchId !== undefined || job.unknownCharge !== false ||
      job.resultText !== undefined || job.resultSha256 !== undefined || marker.version !== 1 || marker.policyId !== row.policy_id ||
      marker.policyRevision !== row.policy_revision || marker.occurrenceId !== row.paid_occurrence_id || marker.attemptId !== row.paid_attempt_id ||
      typeof job.requestSha256 !== 'string' || !SHA256.test(job.requestSha256)) return fail('proactive_preflight_job_not_predispatch');
  const occurrence = dbRead.occurrence;
  if (occurrence.policy_id !== row.policy_id || occurrence.policy_revision !== row.policy_revision || occurrence.policy_kind !== 'proactive_draft' ||
      occurrence.status !== 'claimed' || occurrence.paid_status !== 'claimed' || occurrence.target_status !== 'claimed' ||
      occurrence.target_attempt_id !== row.paid_attempt_id || occurrence.finalization_operation !== null ||
      occurrence.finalization_request_json !== null || occurrence.finalization_receipt_json !== null || occurrence.finalization_receipt_digest !== null) {
    return fail('proactive_preflight_paid_not_predispatch');
  }
  const markerJson = canonicalBackgroundJson(marker);
  const projectionJson = canonicalBackgroundJson(jobIntegrityProjection(job), 16 * 1024 * 1024);
  const commandId = row.paid_attempt_id!;
  const jobId = job.id as string;
  kernel.withColdStartDatabaseTransaction(capability, (db) => {
    const existing = db.prepare(`SELECT job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,proof_kind,ticket_id,preflight_attempt_id,occurrence_id,
      paid_attempt_id,command_id FROM background_proactive_not_submitted_certificates
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND preflight_attempt_id=?`)
      .get(row.workspace_id, row.owner_id, row.privacy_epoch, row.attempt_id) as Record<string, unknown> | undefined;
    const certificateValues = [jobId, jobId, job.requestSha256, sha256(markerJson), sha256(projectionJson), row.attempt_id,
      row.paid_occurrence_id, row.paid_attempt_id, commandId] as const;
    if (existing) {
      if (existing.proof_kind !== 'cold_checkpoint' || existing.ticket_id !== null ||
          certificateValues.some((value, index) => value !== [existing.job_id, existing.custom_id, existing.request_sha256, existing.marker_sha256,
        existing.job_projection_sha256, existing.preflight_attempt_id, existing.occurrence_id, existing.paid_attempt_id, existing.command_id][index])) {
        return fail('proactive_recovery_certificate_conflict');
      }
      return;
    }
    db.prepare(`INSERT INTO background_proactive_not_submitted_certificates(workspace_id,owner_id,privacy_epoch,job_id,custom_id,request_sha256,
      marker_sha256,job_projection_sha256,proof_kind,ticket_id,preflight_attempt_id,occurrence_id,paid_attempt_id,command_id,created_at)
      VALUES(?,?,?,?,?,?,?,?, 'cold_checkpoint',NULL,?,?,?,?,?)`).run(row.workspace_id, row.owner_id, row.privacy_epoch, ...certificateValues, now);
    if (dbRead.journal && ['claimed', 'checkpointed'].includes(String(dbRead.journal.status))) {
      const changedJournal = db.prepare(`UPDATE async_command_journal SET status='inspect_required',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND idempotency_key=? AND command_kind='mail.replybatch.submit'
          AND status=? AND checkpoint_revision IS ? AND snapshot_digest IS ?`)
        .run(now, row.workspace_id, row.owner_id, row.privacy_epoch, commandId, dbRead.journal.status,
          dbRead.journal.checkpoint_revision, dbRead.journal.snapshot_digest);
      if (changedJournal.changes !== 1) return fail('proactive_preflight_journal_recovery_conflict');
    }
    const request = canonicalBackgroundJson({ operation: 'defer', resultCode: 'startup_not_submitted_recovered', nextDueAt: now + MINUTE });
    const receipt = canonicalBackgroundJson({ schemaVersion: 1, operation: 'defer', attemptId: row.paid_attempt_id,
      resultCode: 'startup_not_submitted_recovered', nextDueAt: now + MINUTE, settledAt: now });
    const paid = db.prepare(`UPDATE background_occurrence_attempts SET status='skipped',settled_at=?,result_code='startup_not_submitted_recovered',
      finalization_operation='defer',finalization_request_json=?,finalization_receipt_json=?,finalization_receipt_digest=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND occurrence_id=? AND status='claimed' AND finalization_operation IS NULL`)
      .run(now, request, receipt, sha256(receipt), row.workspace_id, row.owner_id, row.privacy_epoch, row.paid_attempt_id, row.paid_occurrence_id);
    const target = db.prepare(`UPDATE background_occurrence_targets SET status='pending',attempt_id=NULL,updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?
        AND attempt_id=? AND status='claimed'`)
      .run(now + MINUTE, row.workspace_id, row.owner_id, row.privacy_epoch, row.paid_occurrence_id, occurrence.target_id,
        occurrence.target_generation, row.paid_attempt_id);
    const paidOccurrence = db.prepare(`UPDATE background_occurrences SET status='scheduled',updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status='claimed'`)
      .run(now, row.workspace_id, row.owner_id, row.privacy_epoch, row.paid_occurrence_id);
    const preflight = db.prepare(`UPDATE background_proactive_preflight_attempts SET status='deferred',next_due_at=?,settled_at=?,result_code='startup_not_submitted_recovered'
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND candidate_id=? AND policy_id=? AND policy_revision=?
        AND status='reading' AND recovery_protocol_version=1 AND paid_occurrence_id=? AND paid_attempt_id=?`)
      .run(now + MINUTE, now, row.workspace_id, row.owner_id, row.privacy_epoch, row.attempt_id, row.candidate_id, row.policy_id,
        row.policy_revision, row.paid_occurrence_id, row.paid_attempt_id);
    if (paid.changes !== 1 || target.changes !== 1 || paidOccurrence.changes !== 1 || preflight.changes !== 1) {
      return fail('proactive_preflight_recovery_conflict');
    }
  });
}

export interface CertifiedNotSubmittedProactiveJob {
  readonly proofKind: 'cold_checkpoint' | 'live_pre_dispatch';
  readonly ticketId?: string;
  readonly preflightAttemptId: string;
  readonly occurrenceId: string;
  readonly paidAttemptId: string;
  readonly commandId: string;
}

/**
 * Mints an inert proof for a normal, live pre-provider credential/configuration failure.
 * The caller must already have proved the exact ALS ticket, mapped reading/claimed state,
 * and no-link condition in this same snapshot transaction. This certificate never grants
 * automatic dispatch authority; only cold-recovery certificates can participate in reuse.
 */
export function recordLiveNotSubmittedProactiveJob(context: OwnedTransactionContext, input: Readonly<{
  job: unknown; ticketId: string; commandId: string; preflightAttemptId: string; occurrenceId: string; paidAttemptId: string; createdAt: number;
}>): CertifiedNotSubmittedProactiveJob {
  if (!context || !input || !UUID_V4.test(input.ticketId) || !UUID_V4.test(input.commandId) ||
      !UUID_V4.test(input.preflightAttemptId) || !UUID_V4.test(input.occurrenceId) || !UUID_V4.test(input.paidAttemptId) ||
      !Number.isSafeInteger(input.createdAt) || input.createdAt < 0 ||
      input.commandId !== input.paidAttemptId || !input.job || typeof input.job !== 'object' || Array.isArray(input.job) ||
      !isOpenRouterMailReplyContentJob(input.job as never)) return fail('proactive_live_certificate_invalid');
  ensureCertificateSchema(context.db);
  const job = input.job as unknown as Record<string, unknown>;
  const marker = job.proactiveMailReply;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || job.id !== job.customId ||
      job.status !== 'failed' || job.failureCode !== 'not_submitted' || job.unknownCharge !== false || job.batchId !== undefined ||
      job.resultText !== undefined || job.resultSha256 !== undefined || typeof job.requestSha256 !== 'string' || !SHA256.test(job.requestSha256)) {
    return fail('proactive_live_certificate_job_invalid');
  }
  const markerValue = marker as Record<string, unknown>;
  if (markerValue.version !== 1 || markerValue.attemptId !== input.paidAttemptId ||
      !UUID_V4.test(String(markerValue.policyId)) || !Number.isSafeInteger(markerValue.policyRevision) ||
      markerValue.occurrenceId !== input.occurrenceId) return fail('proactive_live_certificate_marker_invalid');
  const journalPresent = assertJournalSchema(context.db);
  if (!journalPresent) return fail('proactive_live_certificate_journal_invalid');
  const journal = context.db.prepare(`SELECT owner_id,privacy_epoch,command_kind,ticket_id,status FROM async_command_journal
    WHERE workspace_id=? AND idempotency_key=?`).get(context.workspaceId, input.commandId) as
    { owner_id: string; privacy_epoch: number; command_kind: string; ticket_id: string; status: string } | undefined;
  if (!journal || journal.owner_id !== context.ownerId || journal.privacy_epoch !== context.privacyEpoch ||
      journal.command_kind !== 'mail.replybatch.submit' || journal.ticket_id !== input.ticketId ||
      !['claimed', 'checkpointed'].includes(journal.status)) return fail('proactive_live_certificate_ticket_invalid');
  const markerJson = canonicalBackgroundJson(marker);
  const projectionJson = canonicalBackgroundJson(jobIntegrityProjection(job), 16 * 1024 * 1024);
  const values = [job.id, job.customId, job.requestSha256, sha256(markerJson), sha256(projectionJson), input.ticketId,
    input.preflightAttemptId, input.occurrenceId, input.paidAttemptId, input.commandId] as const;
  const existing = context.db.prepare(`SELECT job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,proof_kind,ticket_id,
      preflight_attempt_id,occurrence_id,paid_attempt_id,command_id FROM background_proactive_not_submitted_certificates
    WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
    .get(context.workspaceId, context.ownerId, context.privacyEpoch, job.id) as Record<string, unknown> | undefined;
  if (existing) {
    const prior = [existing.job_id, existing.custom_id, existing.request_sha256, existing.marker_sha256, existing.job_projection_sha256,
      existing.ticket_id, existing.preflight_attempt_id, existing.occurrence_id, existing.paid_attempt_id, existing.command_id];
    if (existing.proof_kind !== 'live_pre_dispatch' || values.some((value, index) => value !== prior[index])) {
      return fail('proactive_live_certificate_conflict');
    }
  } else {
    context.db.prepare(`INSERT INTO background_proactive_not_submitted_certificates(workspace_id,owner_id,privacy_epoch,job_id,custom_id,
      request_sha256,marker_sha256,job_projection_sha256,proof_kind,ticket_id,preflight_attempt_id,occurrence_id,paid_attempt_id,command_id,created_at)
      VALUES(?,?,?,?,?,?,?,?, 'live_pre_dispatch',?,?,?,?,?,?)`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, job.id, job.customId, job.requestSha256, sha256(markerJson),
        sha256(projectionJson), input.ticketId, input.preflightAttemptId, input.occurrenceId, input.paidAttemptId, input.commandId, input.createdAt);
  }
  return Object.freeze({ proofKind: 'live_pre_dispatch', ticketId: input.ticketId, preflightAttemptId: input.preflightAttemptId,
    occurrenceId: input.occurrenceId, paidAttemptId: input.paidAttemptId, commandId: input.commandId });
}

/** Resolves the exact cold-recovery certificate only after validating the immutable retained job projection. */
export function readCertifiedNotSubmittedProactiveJob(context: OwnedTransactionContext,
  job: unknown): CertifiedNotSubmittedProactiveJob | undefined {
  if (!job || typeof job !== 'object' || Array.isArray(job) || !isOpenRouterMailReplyContentJob(job as never)) return undefined;
  const value = job as unknown as Record<string, unknown>;
  const marker = value.proactiveMailReply;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || value.id !== value.customId || typeof value.requestSha256 !== 'string' ||
      !SHA256.test(value.requestSha256) || !['preparing', 'failed'].includes(String(value.status)) ||
      value.status === 'failed' && (value.failureCode !== 'not_submitted' || value.unknownCharge !== false || value.batchId !== undefined) ||
      value.status === 'preparing' && (value.unknownCharge !== false || value.batchId !== undefined)) return undefined;
  if (!tableExists(context.db, 'background_proactive_not_submitted_certificates')) return undefined;
  const row = context.db.prepare(`SELECT job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,proof_kind,ticket_id,preflight_attempt_id,occurrence_id,
      paid_attempt_id,command_id FROM background_proactive_not_submitted_certificates
    WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
    .get(context.workspaceId, context.ownerId, context.privacyEpoch, value.id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  try {
    if (row.job_id !== value.id || row.custom_id !== value.customId || row.request_sha256 !== value.requestSha256 ||
        row.marker_sha256 !== sha256(canonicalBackgroundJson(marker)) ||
        row.job_projection_sha256 !== sha256(canonicalBackgroundJson(jobIntegrityProjection(value), 16 * 1024 * 1024)) ||
        !['cold_checkpoint', 'live_pre_dispatch'].includes(String(row.proof_kind)) ||
        row.proof_kind === 'cold_checkpoint' && row.ticket_id !== null ||
        row.proof_kind === 'live_pre_dispatch' && (typeof row.ticket_id !== 'string' || !UUID_V4.test(row.ticket_id)) ||
        typeof row.preflight_attempt_id !== 'string' || !UUID_V4.test(row.preflight_attempt_id) ||
        typeof row.occurrence_id !== 'string' || !UUID_V4.test(row.occurrence_id) ||
        typeof row.paid_attempt_id !== 'string' || !UUID_V4.test(row.paid_attempt_id) || row.command_id !== row.paid_attempt_id) return undefined;
    return Object.freeze({ proofKind: row.proof_kind as 'cold_checkpoint' | 'live_pre_dispatch',
      ...(row.ticket_id ? { ticketId: row.ticket_id as string } : {}), preflightAttemptId: row.preflight_attempt_id,
      occurrenceId: row.occurrence_id, paidAttemptId: row.paid_attempt_id, commandId: row.command_id });
  } catch { return undefined; }
}

/** Boolean compatibility check for retained-job integrity validation. */
export function hasCertifiedNotSubmittedJob(context: OwnedTransactionContext,
  job: unknown): boolean {
  return readCertifiedNotSubmittedProactiveJob(context, job) !== undefined;
}
