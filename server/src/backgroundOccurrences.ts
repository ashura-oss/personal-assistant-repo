import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import type { CommandJournal, CommandTicketContext } from './commandJournal.js';
import type { ApplicationStartupCapability } from './applicationStartup.js';
import { ensureBackgroundSchema } from './backgroundSchema.js';
import { BACKGROUND_REQUEST_MAX_BYTES, canonicalBackgroundJson, isBackgroundUuidV4, parseBackgroundOccurrenceDisplay, parseBackgroundPolicyDisplay, type BackgroundAccounting, type BackgroundOccurrenceDisplay, type BackgroundPolicyKind, type BackgroundPolicySpecification } from './backgroundContracts.js';
import { backgroundBindingAuthority, normalizeResolvedBackgroundBinding, type BackgroundBindingResolver, type ResolvedBackgroundBinding } from './backgroundPolicies.js';
import { resolveCompletePeriod } from './backgroundClock.js';
import { BackgroundProactiveCandidateIndex, type BackgroundProactivePreflightClaim } from './backgroundProactiveCandidates.js';

const PAGE_MAX = 100;
const PRIVATE_MAX = 16 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type AttemptStatus = 'claimed' | 'dispatching' | 'completed' | 'unknown' | 'inspect_required' | 'skipped';
type OccurrenceStatus = 'scheduled' | 'claimed' | 'dispatching' | 'completed' | 'unknown' | 'inspect_required' | 'suppressed';

export interface BackgroundOccurrenceStoreOptions {
  readonly kernel: DurableKernel;
  readonly actorSessionToken: string;
  readonly resolver: BackgroundBindingResolver;
  readonly clock?: () => number;
}

export interface ScheduleBackgroundOccurrenceInput {
  readonly expectedPrivacyEpoch: number;
  readonly policyId: string;
  readonly expectedPolicyRevision: number;
  readonly descriptor: BackgroundOccurrenceDescriptor;
  readonly scheduledAt: number;
  readonly source: unknown;
  readonly request?: unknown;
}

export type BackgroundOccurrenceDescriptor =
  | Readonly<{ kind: 'account_sync'; accountId: string; resource: 'mail' | 'calendars'; scheduledSlotUtc: string }>
  | Readonly<{ kind: 'period_summary'; period: 'daily' | 'weekly' | 'monthly' | 'yearly'; localPeriodStart: string }>
  | Readonly<{ kind: 'proactive_draft'; accountIdentityKey: string; providerMessageId: string; sourceVersionDigest?: string }>
  | Readonly<{ kind: 'approved_reminder_delivery'; reminderId: string; reminderRevision: number; approvedIntentId: string }>;

export interface BackgroundClaim {
  readonly occurrenceId: string;
  readonly attemptId: string;
  readonly targetId: string;
  readonly targetGeneration?: number;
  /** Private one-use capability. Never serialize or project this value. */
  readonly capability: string;
}

export interface ClaimedBackgroundOccurrence {
  readonly occurrence: BackgroundOccurrenceDisplay;
  readonly claim: BackgroundClaim;
}

export interface BackgroundAccountSyncClaimMetadata {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly revision: number;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly accountId: string;
  readonly targetGeneration: number;
  readonly resource: 'mail' | 'calendars';
  readonly scheduledAt: number;
}

/** Private, frozen inputs for the one scheduled mail-reply checkpoint path. */
export interface BackgroundPaidMailReplyInputs {
  readonly occurrenceId: string;
  readonly attemptId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly ruleSpecificationDigest: string;
  readonly accountId: string;
  readonly accountIdentityKey: string;
  readonly connectionGeneration: number;
  readonly providerMessageId: string;
  readonly sourceVersionDigest?: string;
  readonly specification: BackgroundPolicySpecification;
  readonly descriptor: BackgroundOccurrenceDescriptor;
  readonly source: unknown;
  readonly request: unknown;
  readonly requestDigest: string;
}

export interface BackgroundPaidMailReplyCheckpointProof {
  readonly occurrenceId: string; readonly attemptId: string; readonly policyId: string; readonly policyRevision: number;
  readonly policyDigest: string; readonly jobId: string; readonly customId: string; readonly requestSha256: string;
  readonly sourceDigest: string; readonly sourceVersionDigest?: string; readonly requestDigest: string;
}

export interface BackgroundPaidMailReplyCheckpointAuthority {
  readonly policyId: string; readonly policyRevision: number; readonly policyDigest: string;
  readonly effort: 'none' | 'low'; readonly occurrenceId: string; readonly attemptId: string;
}

interface PolicyRow {
  current_revision: number; status: string; suspension: string | null; updated_at: number;
}
interface PolicyRevisionRow {
  revision: number; enabled: number; specification_json: string; binding_json: string; binding_digest: string;
  policy_digest: string; effective_from: number; created_at: number;
}
interface OccurrenceRow {
  occurrence_id: string; policy_id: string; logical_key_digest: string; policy_revision: number; policy_kind: BackgroundPolicyKind;
  policy_digest: string; status: OccurrenceStatus; scheduled_at: number; actual_at: number | null; period_kind: string | null;
  local_period_start: string | null; time_zone: string | null; source_digest: string; source_json: string; descriptor_json: string;
  request_json: string; source_version_digest: string | null; request_digest: string; target_snapshot_json: string;
  batch_job_id: string | null; accounting_json: string;
  created_at: number; updated_at: number;
}
interface AttemptRow {
  attempt_id: string; occurrence_id: string; target_id: string; target_generation: number; capability_hash: string;
  status: AttemptStatus; claimed_at: number; dispatch_started_at: number | null; settled_at: number | null;
  accounting_json: string; result_code: string | null; finalization_operation: string | null;
  finalization_request_json: string | null; finalization_receipt_json: string | null; finalization_receipt_digest: string | null;
}

interface FrozenTarget { readonly targetId: string; readonly generation: number }
interface TargetRow { target_id: string; target_generation: number; status: 'pending' | AttemptStatus; attempt_id: string | null; accounting_json: string; updated_at: number }
interface ProactiveReauthorizationPlan {
  readonly childLogicalKeyDigest: string;
  readonly generation: number;
  readonly parentOccurrenceId: string;
  readonly consentCommandId: string;
  readonly predecessorSetDigest: string;
  readonly existing?: OccurrenceRow;
}

function fail(code: string): never { throw new Error(code); }
function priorFinalization(attempt: AttemptRow, operation: string, requestJson: string): string | undefined {
  const fields = [attempt.finalization_operation, attempt.finalization_request_json, attempt.finalization_receipt_json, attempt.finalization_receipt_digest];
  if (fields.every((field) => field === null)) return undefined;
  if (fields.some((field) => field === null) || attempt.finalization_operation !== operation || attempt.finalization_request_json !== requestJson) {
    return fail('background_claim_finalization_conflict');
  }
  if (hash(attempt.finalization_receipt_json!) !== attempt.finalization_receipt_digest) return fail('background_occurrence_storage_invalid');
  return attempt.finalization_receipt_json!;
}
function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function normalizedSql(value: string): string { return value.toLowerCase().replace(/[\s"`\[\]]/g, ''); }
function ensureProactiveReauthorizationSchema(db: Database.Database): void {
  const hasMeta = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_proactive_reauthorization_schema'").get());
  const hasTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_proactive_reauthorization_lineage'").get());
  if (!hasMeta && !hasTable) {
    db.exec(`CREATE TABLE background_proactive_reauthorization_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1)) STRICT;
      INSERT INTO background_proactive_reauthorization_schema(singleton,version) VALUES(1,1);
      CREATE TABLE background_proactive_reauthorization_lineage(
        workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
        original_logical_digest TEXT NOT NULL CHECK(length(original_logical_digest)=64),generation INTEGER NOT NULL CHECK(generation>0),
        policy_id TEXT NOT NULL CHECK(length(policy_id)=36),policy_revision INTEGER NOT NULL CHECK(policy_revision>0),
        policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),parent_occurrence_id TEXT NOT NULL CHECK(length(parent_occurrence_id)=36),
        child_occurrence_id TEXT NOT NULL CHECK(length(child_occurrence_id)=36),consent_command_id TEXT NOT NULL CHECK(length(consent_command_id)=36),
        predecessor_set_digest TEXT NOT NULL CHECK(length(predecessor_set_digest)=64),created_at INTEGER NOT NULL CHECK(created_at>=0),
        PRIMARY KEY(workspace_id,owner_id,privacy_epoch,original_logical_digest,generation),
        UNIQUE(workspace_id,owner_id,privacy_epoch,original_logical_digest,policy_revision),
        UNIQUE(workspace_id,owner_id,privacy_epoch,child_occurrence_id),UNIQUE(workspace_id,owner_id,privacy_epoch,parent_occurrence_id)
      ) STRICT;
      CREATE TRIGGER background_proactive_reauthorization_no_update BEFORE UPDATE ON background_proactive_reauthorization_lineage
        BEGIN SELECT RAISE(ABORT,'proactive_reauthorization_immutable'); END;
      CREATE TRIGGER background_proactive_reauthorization_erase_only BEFORE DELETE ON background_proactive_reauthorization_lineage
        WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
        BEGIN SELECT RAISE(ABORT,'proactive_reauthorization_retained'); END;`);
    return;
  }
  if (!hasMeta || !hasTable) return fail('background_proactive_reauthorization_schema_invalid');
  const meta = db.prepare('SELECT singleton,version FROM background_proactive_reauthorization_schema').all() as { singleton: number; version: number }[];
  if (meta.length !== 1 || meta[0]?.singleton !== 1 || meta[0].version !== 1) return fail('background_proactive_reauthorization_schema_unsupported');
  const expected = ['workspace_id:TEXT:1:1','owner_id:TEXT:1:2','privacy_epoch:INTEGER:1:3','original_logical_digest:TEXT:1:4',
    'generation:INTEGER:1:5','policy_id:TEXT:1:0','policy_revision:INTEGER:1:0','policy_digest:TEXT:1:0','parent_occurrence_id:TEXT:1:0',
    'child_occurrence_id:TEXT:1:0','consent_command_id:TEXT:1:0','predecessor_set_digest:TEXT:1:0','created_at:INTEGER:1:0'];
  const columns = db.pragma('table_info(background_proactive_reauthorization_lineage)') as { name: string; type: string; notnull: number; pk: number }[];
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_proactive_reauthorization_lineage'").get() as { sql: string } | undefined;
  const strict = db.prepare("SELECT strict FROM pragma_table_list WHERE name='background_proactive_reauthorization_lineage'").get() as { strict: number } | undefined;
  if (!table?.sql || strict?.strict !== 1 || columns.length !== expected.length || columns.some((column, index) =>
      `${column.name}:${column.type.toUpperCase()}:${column.notnull}:${column.pk}` !== expected[index]) ||
      !normalizedSql(table.sql).includes('unique(workspace_id,owner_id,privacy_epoch,original_logical_digest,policy_revision)') ||
      !normalizedSql(table.sql).includes('unique(workspace_id,owner_id,privacy_epoch,parent_occurrence_id)') ||
      !normalizedSql(table.sql).includes('unique(workspace_id,owner_id,privacy_epoch,child_occurrence_id)')) {
    return fail('background_proactive_reauthorization_schema_invalid');
  }
  for (const [name, sql] of [
    ['background_proactive_reauthorization_no_update', "CREATE TRIGGER background_proactive_reauthorization_no_update BEFORE UPDATE ON background_proactive_reauthorization_lineage BEGIN SELECT RAISE(ABORT,'proactive_reauthorization_immutable'); END"],
    ['background_proactive_reauthorization_erase_only', "CREATE TRIGGER background_proactive_reauthorization_erase_only BEFORE DELETE ON background_proactive_reauthorization_lineage WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1 BEGIN SELECT RAISE(ABORT,'proactive_reauthorization_retained'); END"],
  ] as const) {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name='background_proactive_reauthorization_lineage'").get(name) as { sql: string } | undefined;
    if (!trigger?.sql || normalizedSql(trigger.sql) !== normalizedSql(sql)) return fail('background_proactive_reauthorization_schema_invalid');
  }
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail('background_occurrence_input_invalid');
  return value as number;
}
function safeStored<T>(text: string): T {
  if (Buffer.byteLength(text, 'utf8') > PRIVATE_MAX) return fail('background_occurrence_storage_invalid');
  try { return JSON.parse(text) as T; } catch { return fail('background_occurrence_storage_invalid'); }
}
function freezeJson<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  return Object.freeze(value);
}
function accounting(value: unknown): BackgroundAccounting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('background_accounting_invalid');
  const raw = value as Record<string, unknown>;
  if (raw.status === 'unknown' || raw.status === 'not_applicable') {
    if (Object.keys(raw).length !== 1) return fail('background_accounting_invalid');
    return Object.freeze({ status: raw.status });
  }
  if (raw.status !== 'reported' || typeof raw.unknownCharge !== 'boolean') return fail('background_accounting_invalid');
  const allowed = new Set(['status', 'unknownCharge', 'providerReportedCostUsd', 'byok', 'promptTokens', 'completionTokens', 'totalTokens']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return fail('background_accounting_invalid');
  if (raw.providerReportedCostUsd !== undefined && (typeof raw.providerReportedCostUsd !== 'number' || !Number.isFinite(raw.providerReportedCostUsd) || raw.providerReportedCostUsd < 0)) return fail('background_accounting_invalid');
  if (raw.unknownCharge !== (raw.providerReportedCostUsd === undefined)) return fail('background_accounting_invalid');
  if (raw.byok !== undefined && typeof raw.byok !== 'boolean') return fail('background_accounting_invalid');
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) return fail('background_accounting_invalid');
  }
  if (raw.providerReportedCostUsd === undefined && raw.byok === undefined && raw.promptTokens === undefined && raw.completionTokens === undefined && raw.totalTokens === undefined) return fail('background_accounting_invalid');
  return Object.freeze({ status: 'reported', unknownCharge: raw.unknownCharge,
    ...(raw.providerReportedCostUsd === undefined ? {} : { providerReportedCostUsd: raw.providerReportedCostUsd }),
    ...(raw.byok === undefined ? {} : { byok: raw.byok }),
    ...(raw.promptTokens === undefined ? {} : { promptTokens: raw.promptTokens as number }),
    ...(raw.completionTokens === undefined ? {} : { completionTokens: raw.completionTokens as number }),
    ...(raw.totalTokens === undefined ? {} : { totalTokens: raw.totalTokens as number }) });
}
function aggregateTargetAccounting(targets: readonly TargetRow[], finalStatus: OccurrenceStatus): BackgroundAccounting {
  if (finalStatus === 'suppressed' || targets.length === 0) return Object.freeze({ status: 'not_applicable' });
  const reports: Extract<BackgroundAccounting, { status: 'reported' }>[] = [];
  let unknownCharge = false;
  let unreportedTarget = false;
  let chargeApplicableTargets = 0;
  for (const target of targets) {
    const recorded = accounting(safeStored(target.accounting_json));
    if (recorded.status === 'not_applicable') continue;
    chargeApplicableTargets += 1;
    if (recorded.status === 'reported') {
      reports.push(recorded);
      if (recorded.unknownCharge) unknownCharge = true;
    } else {
      unknownCharge = true;
      unreportedTarget = true;
    }
  }
  if (reports.length === 0) return unknownCharge ? Object.freeze({ status: 'unknown' }) : Object.freeze({ status: 'not_applicable' });
  const allTargetsReported = !unreportedTarget && reports.length === chargeApplicableTargets;
  const allHave = <K extends 'providerReportedCostUsd' | 'promptTokens' | 'completionTokens' | 'totalTokens'>(key: K): boolean =>
    allTargetsReported && reports.every((item) => item[key] !== undefined);
  const summed = (key: 'providerReportedCostUsd' | 'promptTokens' | 'completionTokens' | 'totalTokens'): number | undefined => {
    if ((key === 'providerReportedCostUsd' && unknownCharge) || !allHave(key)) return undefined;
    const value = reports.reduce((total, item) => total + item[key]!, 0);
    if (!Number.isFinite(value)) return fail('background_accounting_invalid');
    return value;
  };
  const byok = allTargetsReported && reports.every((item) => item.byok !== undefined && item.byok === reports[0]!.byok) ? reports[0]!.byok : undefined;
  const cost = summed('providerReportedCostUsd');
  const promptTokens = summed('promptTokens');
  const completionTokens = summed('completionTokens');
  const totalTokens = summed('totalTokens');
  if (cost === undefined && byok === undefined && promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return Object.freeze({ status: 'unknown' });
  }
  const result = { status: 'reported' as const, unknownCharge,
    ...(cost === undefined ? {} : { providerReportedCostUsd: cost }),
    ...(byok === undefined ? {} : { byok }),
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }) };
  return accounting(result);
}
function project(row: OccurrenceRow): BackgroundOccurrenceDisplay {
  const recorded = accounting(safeStored(row.accounting_json));
  return Object.freeze({ schemaVersion: 1, occurrenceId: row.occurrence_id, policyId: row.policy_id,
    policyRevision: row.policy_revision, policyKind: row.policy_kind, status: row.status, scheduledAt: row.scheduled_at,
    ...(row.actual_at === null ? {} : { actualAt: row.actual_at }), ...(row.batch_job_id ? { batchJobId: row.batch_job_id } : {}),
    accounting: recorded, createdAt: row.created_at, updatedAt: row.updated_at });
}
function readOccurrence(db: Database.Database, context: OwnedTransactionContext, occurrenceId: string): OccurrenceRow | undefined {
  return db.prepare(`SELECT occurrence_id,policy_id,logical_key_digest,policy_revision,policy_kind,policy_digest,status,scheduled_at,
    actual_at,period_kind,local_period_start,time_zone,source_digest,source_json,descriptor_json,request_json,source_version_digest,request_digest,target_snapshot_json,
    batch_job_id,accounting_json,created_at,updated_at FROM background_occurrences
    WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
    .get(context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId) as OccurrenceRow | undefined;
}
function readPolicy(db: Database.Database, context: OwnedTransactionContext, policyId: string, revision: number): { head: PolicyRow; revision: PolicyRevisionRow } | undefined {
  const row = db.prepare(`SELECT h.current_revision,h.status,h.suspension,h.updated_at,r.revision,r.enabled,r.specification_json,
    r.binding_json,r.binding_digest,r.policy_digest,r.effective_from,r.created_at FROM background_policy_heads h
    JOIN background_policy_revisions r ON r.workspace_id=h.workspace_id AND r.owner_id=h.owner_id AND r.privacy_epoch=h.privacy_epoch
      AND r.policy_id=h.policy_id AND r.revision=? WHERE h.workspace_id=? AND h.owner_id=? AND h.privacy_epoch=? AND h.policy_id=?`)
    .get(revision, context.workspaceId, context.ownerId, context.privacyEpoch, policyId) as (PolicyRow & PolicyRevisionRow) | undefined;
  if (!row) return undefined;
  return { head: row, revision: row };
}
function verifyPolicy(context: OwnedTransactionContext, db: Database.Database, resolver: BackgroundBindingResolver,
  occurrence: OccurrenceRow): { spec: BackgroundPolicySpecification; binding: ResolvedBackgroundBinding; digest: string } {
  const found = readPolicy(db, context, occurrence.policy_id, occurrence.policy_revision);
  if (!found || found.head.current_revision !== occurrence.policy_revision || found.head.status !== 'enabled' || found.revision.enabled !== 1 ||
      found.revision.policy_digest !== occurrence.policy_digest) return fail('background_occurrence_policy_stale');
  const spec = safeStored<BackgroundPolicySpecification>(found.revision.specification_json);
  const storedBinding = safeStored<ResolvedBackgroundBinding>(found.revision.binding_json);
  const normalizedStored = normalizeResolvedBackgroundBinding(storedBinding, spec, context.privacyEpoch);
  if (canonicalBackgroundJson(normalizedStored, PRIVATE_MAX) !== canonicalBackgroundJson(storedBinding, PRIVATE_MAX)) return fail('background_occurrence_policy_corrupt');
  const bindingDigest = hash(canonicalBackgroundJson(backgroundBindingAuthority(normalizedStored), PRIVATE_MAX));
  const expectedPolicyDigest = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
    privacyEpoch: context.privacyEpoch, policyId: occurrence.policy_id, revision: found.revision.revision,
    enabled: true, specification: spec, bindingDigest, effectiveFrom: found.revision.effective_from }));
  if (bindingDigest !== found.revision.binding_digest || expectedPolicyDigest !== found.revision.policy_digest) return fail('background_occurrence_policy_corrupt');
  let current: ResolvedBackgroundBinding;
  try { current = normalizeResolvedBackgroundBinding(resolver.resolve(context, spec), spec, context.privacyEpoch); }
  catch (error) {
    if (error instanceof Error && error.message === 'background_binding_changed') return fail('background_occurrence_binding_changed');
    throw error;
  }
  const currentText = canonicalBackgroundJson(backgroundBindingAuthority(current), PRIVATE_MAX);
  if (currentText !== canonicalBackgroundJson(backgroundBindingAuthority(normalizedStored), PRIVATE_MAX)) return fail('background_occurrence_binding_changed');
  return { spec, binding: normalizedStored, digest: found.revision.policy_digest };
}
function descriptorTuple(spec: BackgroundPolicySpecification, binding: ResolvedBackgroundBinding, descriptor: BackgroundOccurrenceDescriptor): readonly unknown[] {
  const invalid = (): never => fail('background_occurrence_identity_invalid');
  const keys = Object.keys(descriptor as object).sort().join(',');
  if (descriptor.kind !== spec.kind) return invalid();
  if (spec.kind === 'account_sync' && descriptor.kind === 'account_sync') {
    if (keys !== 'accountId,kind,resource,scheduledSlotUtc') return invalid();
    const account = (binding.accounts ?? []).find((item) => item.accountId === descriptor.accountId);
    const slotMs = Date.parse(descriptor.scheduledSlotUtc);
    if (typeof descriptor.accountId !== 'string' || !descriptor.accountId || Buffer.byteLength(descriptor.accountId, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(descriptor.accountId) ||
        typeof descriptor.scheduledSlotUtc !== 'string' || !account || !spec.accounts.some((item) => item.accountId === descriptor.accountId && item.expectedConnectionGeneration === account.connectionGeneration) ||
        !spec.resources.includes(descriptor.resource) || !Number.isFinite(slotMs) || new Date(slotMs).toISOString() !== descriptor.scheduledSlotUtc) return invalid();
    return Object.freeze(['account_sync', descriptor.accountId, descriptor.resource, descriptor.scheduledSlotUtc]);
  }
  if (spec.kind === 'period_summary' && descriptor.kind === 'period_summary') {
    if (keys !== 'kind,localPeriodStart,period' || descriptor.period !== spec.period || typeof descriptor.localPeriodStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(descriptor.localPeriodStart)) return invalid();
    return Object.freeze(['period_summary', descriptor.period, descriptor.localPeriodStart]);
  }
  if (spec.kind === 'proactive_draft' && descriptor.kind === 'proactive_draft') {
    const hasVersion = spec.sourceChangePolicy === 'each_changed_source';
    if (keys !== (hasVersion ? 'accountIdentityKey,kind,providerMessageId,sourceVersionDigest' : 'accountIdentityKey,kind,providerMessageId')) return invalid();
    const account = (binding.accounts ?? []).find((item) => item.identityKey === descriptor.accountIdentityKey);
    if (typeof descriptor.accountIdentityKey !== 'string' || !descriptor.accountIdentityKey || Buffer.byteLength(descriptor.accountIdentityKey, 'utf8') > 1024 ||
        /[\u0000-\u001f\u007f]/.test(descriptor.accountIdentityKey) || !account ||
        !spec.accounts.some((item) => item.accountId === account.accountId && item.expectedConnectionGeneration === account.connectionGeneration) ||
        typeof descriptor.providerMessageId !== 'string' || descriptor.providerMessageId.length === 0 || Buffer.byteLength(descriptor.providerMessageId, 'utf8') > 1024 ||
        (hasVersion && !HEX.test(descriptor.sourceVersionDigest ?? '')) || (!hasVersion && descriptor.sourceVersionDigest !== undefined)) return invalid();
    return Object.freeze(['proactive_draft', descriptor.accountIdentityKey, descriptor.providerMessageId,
      ...(hasVersion ? [descriptor.sourceVersionDigest!] : [])]);
  }
  if (spec.kind === 'approved_reminder_delivery' && descriptor.kind === 'approved_reminder_delivery') {
    const reminder = binding.reminder;
    if (keys !== 'approvedIntentId,kind,reminderId,reminderRevision' || !reminder || descriptor.reminderId !== spec.reminderId || descriptor.reminderRevision !== spec.expectedReminderRevision ||
        descriptor.reminderId !== reminder.reminderId || descriptor.reminderRevision !== reminder.revision || descriptor.approvedIntentId !== reminder.intentId) return invalid();
    return Object.freeze(['approved_reminder_delivery', descriptor.reminderId, descriptor.reminderRevision, descriptor.approvedIntentId]);
  }
  return invalid();
}
function allowedTarget(spec: BackgroundPolicySpecification, binding: ResolvedBackgroundBinding, occurrence: OccurrenceRow,
  targetId: string, generation: number): boolean {
  if (spec.kind === 'approved_reminder_delivery') {
    const snapshot = safeStored<{ targets?: readonly { targetId: string; generation: number }[] }>(occurrence.target_snapshot_json);
    return (snapshot.targets ?? []).some((target) => target.targetId === targetId && target.generation === generation);
  }
  if (spec.kind === 'period_summary') return targetId === 'workspace' && generation === 0;
  const descriptor = safeStored<BackgroundOccurrenceDescriptor>(occurrence.descriptor_json);
  if (spec.kind === 'proactive_draft' && descriptor.kind === 'proactive_draft') {
    const account = (binding.accounts ?? []).find((item) => item.identityKey === descriptor.accountIdentityKey);
    return targetId === descriptor.accountIdentityKey && account?.connectionGeneration === generation;
  }
  if (spec.kind === 'account_sync' && descriptor.kind === 'account_sync') {
    const account = (binding.accounts ?? []).find((item) => item.accountId === descriptor.accountId);
    return targetId === descriptor.accountId && account?.connectionGeneration === generation;
  }
  return false;
}
export class BackgroundOccurrenceStore {
  readonly #kernel: DurableKernel;
  readonly #actor: string;
  readonly #resolver: BackgroundBindingResolver;
  readonly #clock: () => number;

  constructor(options: BackgroundOccurrenceStoreOptions) {
    if (!options?.kernel || !options.actorSessionToken || !options.resolver || typeof options.resolver.resolve !== 'function' ||
        options.resolver.resolve.constructor?.name === 'AsyncFunction' ||
        (options.resolver.captureReminderTargets && options.resolver.captureReminderTargets.constructor?.name === 'AsyncFunction')) throw new TypeError('background_occurrence_store_invalid');
    this.#kernel = options.kernel; this.#actor = options.actorSessionToken; this.#resolver = options.resolver;
    this.#clock = options.clock ?? Date.now;
  }

  private fenceStaleScheduled(context: OwnedTransactionContext): void {
    const rows = context.db.prepare(`SELECT occurrence_id,policy_id,logical_key_digest,policy_revision,policy_kind,policy_digest,status,scheduled_at,
      actual_at,period_kind,local_period_start,time_zone,source_digest,source_json,descriptor_json,request_json,source_version_digest,request_digest,target_snapshot_json,
      batch_job_id,accounting_json,created_at,updated_at FROM background_occurrences
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_kind='account_sync' AND status='scheduled'`)
      .all(context.workspaceId, context.ownerId, context.privacyEpoch) as OccurrenceRow[];
    for (const occurrence of rows) {
      try { verifyPolicy(context, context.db, this.#resolver, occurrence); }
      catch (error) {
        if (!(error instanceof Error) || !['background_occurrence_policy_stale', 'background_occurrence_binding_changed'].includes(error.message)) throw error;
        const now = timestamp(this.#clock());
        context.db.prepare(`UPDATE background_occurrences SET status='inspect_required',updated_at=?
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status='scheduled'`)
          .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
        context.db.prepare(`UPDATE background_occurrence_targets SET status='inspect_required',updated_at=?
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status='pending'`)
          .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
      }
    }
  }

  schedule(input: ScheduleBackgroundOccurrenceInput): BackgroundOccurrenceDisplay {
    return this.#schedule(input, false);
  }

  /** Creates a child occurrence only after exact consent and no-submission lineage proof. */
  scheduleReauthorizedPaidMailReply(input: ScheduleBackgroundOccurrenceInput): BackgroundOccurrenceDisplay {
    return this.#schedule(input, true);
  }

  /** Resolves immutable prior inputs only when the exact current reading claim and full no-submit lineage validate. */
  readProactiveReauthorizationInputsWithinTransaction(context: OwnedTransactionContext, input: Readonly<{
    expectedPrivacyEpoch: number; policyId: string; expectedPolicyRevision: number; descriptor: BackgroundOccurrenceDescriptor;
    candidateIndex: BackgroundProactiveCandidateIndex; preflightClaim: BackgroundProactivePreflightClaim;
  }>): Readonly<{ status: 'reuse'; source: unknown; request: unknown; scheduledAt: number; parentOccurrenceId: string } |
    { readonly status: 'stale' } | undefined> {
    this.#kernel.assertOwnedTransactionContext(context);
    if (!input || input.expectedPrivacyEpoch !== context.privacyEpoch || !isBackgroundUuidV4(input.policyId) ||
        !Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 1 ||
        !input.candidateIndex || !input.preflightClaim || input.descriptor?.kind !== 'proactive_draft') return fail('background_proactive_reauthorization_invalid');
    ensureBackgroundSchema(context.db);
    const reading = input.candidateIndex.assertReadingWithinTransaction(context, input.preflightClaim);
    if (reading.candidateId !== input.preflightClaim.candidateId || input.preflightClaim.policyId !== input.policyId ||
        input.preflightClaim.policyRevision !== input.expectedPolicyRevision) return fail('background_proactive_reauthorization_preflight_invalid');
    const policy = readPolicy(context.db, context, input.policyId, input.expectedPolicyRevision);
    if (!policy || policy.head.current_revision !== input.expectedPolicyRevision || policy.head.status !== 'enabled' || policy.revision.enabled !== 1) {
      return undefined;
    }
    const specification = safeStored<BackgroundPolicySpecification>(policy.revision.specification_json);
    if (specification.kind !== 'proactive_draft') return fail('background_policy_kind_unavailable');
    const storedBinding = safeStored<ResolvedBackgroundBinding>(policy.revision.binding_json);
    const normalizedStored = normalizeResolvedBackgroundBinding(storedBinding, specification, context.privacyEpoch);
    if (canonicalBackgroundJson(normalizedStored, PRIVATE_MAX) !== canonicalBackgroundJson(storedBinding, PRIVATE_MAX)) {
      return fail('background_occurrence_policy_corrupt');
    }
    const currentBinding = normalizeResolvedBackgroundBinding(this.#resolver.resolve(context, specification), specification, context.privacyEpoch);
    if (canonicalBackgroundJson(backgroundBindingAuthority(currentBinding), PRIVATE_MAX) !==
        canonicalBackgroundJson(backgroundBindingAuthority(normalizedStored), PRIVATE_MAX)) return fail('background_occurrence_binding_changed');
    const descriptor = safeStored<Extract<BackgroundOccurrenceDescriptor, { kind: 'proactive_draft' }>>(
      canonicalBackgroundJson(input.descriptor, PRIVATE_MAX));
    const logicalTuple = descriptorTuple(specification, normalizedStored, descriptor);
    const originalLogicalKeyDigest = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
      privacyEpoch: context.privacyEpoch, policyId: input.policyId, logicalTuple }));
    const base = context.db.prepare(`SELECT occurrence_id,policy_id,logical_key_digest,policy_revision,policy_kind,policy_digest,status,scheduled_at,
      actual_at,period_kind,local_period_start,time_zone,source_digest,source_json,descriptor_json,request_json,source_version_digest,request_digest,
      target_snapshot_json,batch_job_id,accounting_json,created_at,updated_at FROM background_occurrences
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND logical_key_digest=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, input.policyId, originalLogicalKeyDigest) as OccurrenceRow | undefined;
    if (!base) {
      const related = context.db.prepare(`SELECT occurrence_id,policy_revision FROM background_occurrences
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND policy_kind='proactive_draft'
          AND json_extract(descriptor_json,'$.accountIdentityKey')=? AND json_extract(descriptor_json,'$.providerMessageId')=? ORDER BY policy_revision`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch, input.policyId, input.descriptor.accountIdentityKey,
          input.descriptor.providerMessageId) as { occurrence_id: string; policy_revision: number }[];
      if (related.length === 0) return undefined;
      // A changed semantic source version is a new slot only while the standing
      // consent has consistently opted into each_changed_source. first_match_only
      // and any switch between the two modes remain single-shot/fail-closed.
      if (specification.sourceChangePolicy !== 'each_changed_source') return Object.freeze({ status: 'stale' });
      for (const previous of related) {
        const previousPolicy = readPolicy(context.db, context, input.policyId, previous.policy_revision);
        if (!previousPolicy || previousPolicy.revision.specification_json === '' ||
            safeStored<BackgroundPolicySpecification>(previousPolicy.revision.specification_json).kind !== 'proactive_draft' ||
            safeStored<Extract<BackgroundPolicySpecification, { kind: 'proactive_draft' }>>(previousPolicy.revision.specification_json)
              .sourceChangePolicy !== 'each_changed_source') return Object.freeze({ status: 'stale' });
      }
      return undefined;
    }
    this.#assertProactiveOccurrenceIdentity(context, base, specification, normalizedStored, descriptor);
    if (base.policy_revision >= input.expectedPolicyRevision) return undefined;
    const sourceJson = canonicalBackgroundJson(safeStored<unknown>(base.source_json), PRIVATE_MAX);
    const requestJson = canonicalBackgroundJson(safeStored<unknown>(base.request_json), PRIVATE_MAX);
    if (sourceJson !== base.source_json || requestJson !== base.request_json ||
        base.descriptor_json !== canonicalBackgroundJson(descriptor, PRIVATE_MAX)) {
      return fail('background_proactive_reauthorization_predecessor_invalid');
    }
    const plan = this.#prepareProactiveReauthorization(context, { input: { expectedPrivacyEpoch: input.expectedPrivacyEpoch,
      policyId: input.policyId, expectedPolicyRevision: input.expectedPolicyRevision, descriptor, scheduledAt: base.scheduled_at,
      source: JSON.parse(sourceJson), request: JSON.parse(requestJson) }, policy, specification, descriptor, originalLogicalKeyDigest,
      sourceJson, requestJson, requestDigest: base.request_digest, scheduledAt: base.scheduled_at });
    const selected = plan.existing ?? base;
    return Object.freeze({ status: 'reuse', source: safeStored<unknown>(selected.source_json), request: safeStored<unknown>(selected.request_json),
      scheduledAt: selected.scheduled_at, parentOccurrenceId: plan.parentOccurrenceId });
  }

  #schedule(input: ScheduleBackgroundOccurrenceInput, reauthorized: boolean): BackgroundOccurrenceDisplay {
    if (!input || !Number.isSafeInteger(input.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0 ||
        !isBackgroundUuidV4(input.policyId) || !Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 1 ||
        !input.descriptor || typeof input.descriptor !== 'object' || Array.isArray(input.descriptor) || Object.hasOwn(input, 'targetSnapshot')) return fail('background_occurrence_input_invalid');
    const scheduledAt = timestamp(input.scheduledAt);
    const sourceJson = canonicalBackgroundJson(input.source, PRIVATE_MAX);
    const requestJson = canonicalBackgroundJson(input.request ?? {}, PRIVATE_MAX);
    const descriptorJson = canonicalBackgroundJson(input.descriptor, PRIVATE_MAX);
    const sourceDigest = hash(sourceJson);
    const requestDigest = hash(canonicalBackgroundJson({ sourceDigest, requestJson, scheduledAt }, PRIVATE_MAX));
    return this.#kernel.withOwnedTransaction(this.#actor, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const policy = readPolicy(context.db, context, input.policyId, input.expectedPolicyRevision);
      if (!policy || policy.head.current_revision !== input.expectedPolicyRevision) return fail('background_occurrence_policy_stale');
      const specification = safeStored<BackgroundPolicySpecification>(policy.revision.specification_json);
      const storedBinding = safeStored<ResolvedBackgroundBinding>(policy.revision.binding_json);
      const normalizedStored = normalizeResolvedBackgroundBinding(storedBinding, specification, context.privacyEpoch);
      if (canonicalBackgroundJson(normalizedStored, PRIVATE_MAX) !== canonicalBackgroundJson(storedBinding, PRIVATE_MAX)) return fail('background_occurrence_policy_corrupt');
      const safeDescriptor = safeStored<BackgroundOccurrenceDescriptor>(descriptorJson);
      const logicalTuple = descriptorTuple(specification, normalizedStored, safeDescriptor);
      const originalLogicalKeyDigest = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
        privacyEpoch: context.privacyEpoch, policyId: input.policyId, logicalTuple }));
      let logicalKeyDigest = originalLogicalKeyDigest;
      let reauthorization: ProactiveReauthorizationPlan | undefined;
      if (reauthorized) {
        if (specification.kind !== 'proactive_draft' || safeDescriptor.kind !== 'proactive_draft') return fail('background_policy_kind_unavailable');
        reauthorization = this.#prepareProactiveReauthorization(context, { input, policy, specification, descriptor: safeDescriptor,
          originalLogicalKeyDigest, sourceJson, requestJson, requestDigest, scheduledAt });
        logicalKeyDigest = reauthorization.childLogicalKeyDigest;
        if (reauthorization.existing) {
          if (reauthorization.existing.request_digest !== requestDigest || reauthorization.existing.source_json !== sourceJson ||
              reauthorization.existing.request_json !== requestJson || reauthorization.existing.descriptor_json !== descriptorJson ||
              reauthorization.existing.scheduled_at !== scheduledAt) return fail('background_occurrence_identity_conflict');
          this.#assertProactiveOccurrenceIdentity(context, reauthorization.existing, specification, normalizedStored, safeDescriptor);
          return project(reauthorization.existing);
        }
      }
      const existing = context.db.prepare(`SELECT occurrence_id,policy_id,logical_key_digest,policy_revision,policy_kind,policy_digest,status,scheduled_at,
        actual_at,period_kind,local_period_start,time_zone,source_digest,source_json,descriptor_json,request_json,source_version_digest,request_digest,target_snapshot_json,
        batch_job_id,accounting_json,created_at,updated_at FROM background_occurrences
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND logical_key_digest=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, input.policyId, logicalKeyDigest) as OccurrenceRow | undefined;
      if (existing && !reauthorized) {
        this.#assertProactiveOccurrenceIdentity(context, existing, specification, normalizedStored, safeDescriptor);
        if (existing.policy_revision === input.expectedPolicyRevision && existing.request_digest !== requestDigest) return fail('background_occurrence_identity_conflict');
        return project(existing);
      }
      if (existing) return fail('background_proactive_reauthorization_conflict');
      if (reauthorized && !reauthorization) return fail('background_proactive_reauthorization_invalid');
      if (policy.head.status !== 'enabled' || policy.revision.enabled !== 1) return fail('background_occurrence_policy_stale');
      const currentBinding = normalizeResolvedBackgroundBinding(this.#resolver.resolve(context, specification), specification, context.privacyEpoch);
      if (canonicalBackgroundJson(backgroundBindingAuthority(currentBinding), PRIVATE_MAX) !== canonicalBackgroundJson(backgroundBindingAuthority(normalizedStored), PRIVATE_MAX)) return fail('background_occurrence_binding_changed');
      let emptyPeriod = false;
      if (specification.kind === 'account_sync') {
        const slot = safeDescriptor.kind === 'account_sync' ? safeDescriptor.scheduledSlotUtc : '';
        const slotMs = Date.parse(slot);
        const first = readPolicy(context.db, context, input.policyId, 1);
        if (!first || !Number.isFinite(slotMs) || new Date(slotMs).toISOString() !== slot || slotMs !== scheduledAt ||
            slotMs < policy.revision.effective_from || (slotMs - first.revision.effective_from) % (specification.intervalMinutes * 60_000) !== 0) {
          return fail('background_occurrence_slot_invalid');
        }
      }
      if (specification.kind === 'period_summary') {
        if (safeDescriptor.kind !== 'period_summary') return fail('background_occurrence_identity_invalid');
        let period;
        try { period = resolveCompletePeriod({ period: specification.period, timeZone: specification.timeZone,
          localDeliveryTime: specification.localDeliveryTime, localPeriod: safeDescriptor.localPeriodStart }); }
        catch { return fail('background_occurrence_period_invalid'); }
        if (Date.parse(period.dueUtc) !== scheduledAt) return fail('background_occurrence_period_invalid');
        emptyPeriod = period.empty;
      }
      const targets: FrozenTarget[] = [];
      if (!emptyPeriod && specification.kind === 'account_sync' && safeDescriptor.kind === 'account_sync') {
        const account = (currentBinding.accounts ?? []).find((item) => item.accountId === safeDescriptor.accountId);
        if (!account) return fail('background_target_not_bound');
        targets.push({ targetId: account.accountId, generation: account.connectionGeneration });
      } else if (!emptyPeriod && specification.kind === 'proactive_draft' && safeDescriptor.kind === 'proactive_draft') {
        const account = (currentBinding.accounts ?? []).find((item) => item.identityKey === safeDescriptor.accountIdentityKey);
        if (!account) return fail('background_target_not_bound');
        targets.push({ targetId: account.identityKey, generation: account.connectionGeneration });
      } else if (!emptyPeriod && specification.kind === 'period_summary') {
        targets.push({ targetId: 'workspace', generation: 0 });
      } else if (!emptyPeriod && specification.kind === 'approved_reminder_delivery') {
        if (!currentBinding.reminder || !this.#resolver.captureReminderTargets) return fail('background_reminder_target_resolver_unavailable');
        if (timestamp(this.#clock()) < currentBinding.reminder.dueAt || scheduledAt !== currentBinding.reminder.dueAt) return fail('background_reminder_not_due');
        const capturedTargets = this.#resolver.captureReminderTargets(context, specification, currentBinding.reminder);
        if (!Array.isArray(capturedTargets) || capturedTargets.some((target) => !target || Object.keys(target).sort().join(',') !== 'generation,subscriptionId' ||
            typeof target.subscriptionId !== 'string' || !target.subscriptionId || Buffer.byteLength(target.subscriptionId, 'utf8') > 1024 ||
            /[\u0000-\u001f\u007f]/.test(target.subscriptionId) || !Number.isSafeInteger(target.generation) || target.generation < 1) ||
            new Set(capturedTargets.map((target) => target.subscriptionId)).size !== capturedTargets.length) return fail('background_reminder_targets_invalid');
        const selected = currentBinding.reminder.deviceSelection;
        if (selected !== 'all_current') {
          if ('subscriptions' in selected) {
            const generations = new Map(selected.subscriptions.map((item) => [item.subscriptionId, item.generation]));
            if (capturedTargets.length !== generations.size || capturedTargets.some((target) => generations.get(target.subscriptionId) !== target.generation)) {
              return fail('background_reminder_targets_changed');
            }
          } else {
            const ids = new Set(selected.subscriptionIds);
            if (capturedTargets.length !== ids.size || capturedTargets.some((target) => !ids.has(target.subscriptionId))) return fail('background_reminder_targets_changed');
          }
        }
        capturedTargets.sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId))
          .forEach((target) => targets.push({ targetId: target.subscriptionId, generation: target.generation }));
      }
      const targetJson = canonicalBackgroundJson({ targets }, PRIVATE_MAX);
      canonicalBackgroundJson({ source: JSON.parse(sourceJson), request: JSON.parse(requestJson), targetSnapshot: JSON.parse(targetJson), logicalTuple }, PRIVATE_MAX);
      const now = timestamp(this.#clock());
      const occurrenceId = randomUUID();
      const periodKind = specification.kind === 'period_summary' ? specification.period : null;
      const localPeriodStart = specification.kind === 'period_summary' && input.descriptor.kind === 'period_summary' ? input.descriptor.localPeriodStart : null;
      const timeZone = specification.kind === 'period_summary' ? specification.timeZone : null;
      const suppressed = emptyPeriod || targets.length === 0;
      context.db.prepare(`INSERT INTO background_occurrences(workspace_id,owner_id,privacy_epoch,occurrence_id,policy_id,logical_key_digest,
        policy_revision,policy_kind,policy_digest,status,scheduled_at,actual_at,period_kind,local_period_start,time_zone,source_digest,
        source_json,descriptor_json,request_json,source_version_digest,request_digest,target_snapshot_json,batch_job_id,accounting_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId, input.policyId, logicalKeyDigest,
          input.expectedPolicyRevision, specification.kind, policy.revision.policy_digest, suppressed ? 'suppressed' : 'scheduled', scheduledAt,
          periodKind, localPeriodStart, timeZone, sourceDigest, sourceJson, descriptorJson, requestJson,
          specification.kind === 'proactive_draft' && safeDescriptor.kind === 'proactive_draft' ? safeDescriptor.sourceVersionDigest ?? null : null,
          requestDigest, targetJson, canonicalBackgroundJson({ status: suppressed ? 'not_applicable' : 'unknown' }), now, now);
      for (const target of targets) context.db.prepare(`INSERT INTO background_occurrence_targets(workspace_id,owner_id,privacy_epoch,occurrence_id,target_id,
        target_generation,status,attempt_id,accounting_json,updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId, target.targetId, target.generation,
          suppressed ? 'skipped' : 'pending', canonicalBackgroundJson({ status: suppressed ? 'not_applicable' : 'unknown' }), now);
      if (reauthorization) {
        context.db.prepare(`INSERT INTO background_proactive_reauthorization_lineage(workspace_id,owner_id,privacy_epoch,original_logical_digest,generation,
          policy_id,policy_revision,policy_digest,parent_occurrence_id,child_occurrence_id,consent_command_id,predecessor_set_digest,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(context.workspaceId, context.ownerId, context.privacyEpoch, originalLogicalKeyDigest, reauthorization.generation, input.policyId,
            input.expectedPolicyRevision, policy.revision.policy_digest, reauthorization.parentOccurrenceId, occurrenceId,
            reauthorization.consentCommandId, reauthorization.predecessorSetDigest, now);
      }
      const row = readOccurrence(context.db, context, occurrenceId);
      if (!row) return fail('background_occurrence_storage_invalid');
      return project(row);
    });
  }

  #prepareProactiveReauthorization(context: OwnedTransactionContext, input: Readonly<{
    input: ScheduleBackgroundOccurrenceInput; policy: { head: PolicyRow; revision: PolicyRevisionRow };
    specification: BackgroundPolicySpecification; descriptor: Extract<BackgroundOccurrenceDescriptor, { kind: 'proactive_draft' }>;
    originalLogicalKeyDigest: string; sourceJson: string; requestJson: string; requestDigest: string; scheduledAt: number;
  }>, allowHistoricalHead = false): ProactiveReauthorizationPlan {
    const { input: schedule, policy, specification, descriptor, originalLogicalKeyDigest, sourceJson, requestJson, requestDigest, scheduledAt } = input;
    if ((!allowHistoricalHead && (policy.head.current_revision !== schedule.expectedPolicyRevision || policy.head.status !== 'enabled')) ||
        policy.revision.enabled !== 1 ||
        specification.kind !== 'proactive_draft') return fail('background_proactive_reauthorization_policy_invalid');
    ensureProactiveReauthorizationSchema(context.db);
    const consentRows = context.db.prepare(`SELECT command_id,request_digest,receipt_json FROM background_policy_commands
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`).all(context.workspaceId, context.ownerId, context.privacyEpoch) as
      { command_id: string; request_digest: string; receipt_json: string }[];
    const consents = consentRows.filter((row) => {
      try {
        const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>;
        return receipt.operation === 'save' && receipt.policyId === schedule.policyId && receipt.policyRevision === schedule.expectedPolicyRevision &&
          receipt.status === 'enabled' && receipt.commandId === row.command_id;
      } catch { return false; }
    });
    if (consents.length !== 1 || !UUID_V4.test(consents[0]!.command_id) || !HEX.test(consents[0]!.request_digest)) {
      return fail('background_proactive_reauthorization_consent_missing');
    }
    const consentCommandId = consents[0]!.command_id;
    const base = context.db.prepare(`SELECT occurrence_id,policy_id,logical_key_digest,policy_revision,policy_kind,policy_digest,status,scheduled_at,
      actual_at,period_kind,local_period_start,time_zone,source_digest,source_json,descriptor_json,request_json,source_version_digest,request_digest,
      target_snapshot_json,batch_job_id,accounting_json,created_at,updated_at FROM background_occurrences
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND logical_key_digest=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, schedule.policyId, originalLogicalKeyDigest) as OccurrenceRow | undefined;
    if (!base || base.policy_kind !== 'proactive_draft' || base.policy_revision >= schedule.expectedPolicyRevision || base.batch_job_id !== null ||
        base.descriptor_json !== canonicalBackgroundJson(descriptor, PRIVATE_MAX) || base.source_json !== sourceJson || base.request_json !== requestJson ||
        base.request_digest !== requestDigest || base.status !== 'suppressed' && base.status !== 'scheduled') {
      return fail('background_proactive_reauthorization_predecessor_invalid');
    }
    const snapshot = this.#kernel.readOwnedSnapshotWithinTransaction(context).snapshot as unknown as Record<string, unknown>;
    const hasLedger = Object.hasOwn(snapshot, 'openRouterBatchLedger');
    const rawLedger = hasLedger ? snapshot.openRouterBatchLedger : { version: 1, jobs: [] };
    if (!rawLedger || typeof rawLedger !== 'object' || Array.isArray(rawLedger) ||
        Object.keys(rawLedger as Record<string, unknown>).sort().join(',') !== 'jobs,version' ||
        (rawLedger as Record<string, unknown>).version !== 1 || !Array.isArray((rawLedger as Record<string, unknown>).jobs)) {
      return fail('background_proactive_reauthorization_ledger_invalid');
    }
    const jobs = (rawLedger as { jobs: unknown[] }).jobs;
    const ledgerJobs = new Map<string, Record<string, unknown>>();
    for (const candidate of jobs) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fail('background_proactive_reauthorization_ledger_invalid');
      const candidateRecord = candidate as Record<string, unknown>;
      if (candidateRecord.kind === 'mail_reply') {
        if (typeof candidateRecord.id !== 'string' || ledgerJobs.has(candidateRecord.id)) return fail('background_proactive_reauthorization_ledger_invalid');
        ledgerJobs.set(candidateRecord.id, candidateRecord);
      }
    }
    const linksPresent = Boolean(context.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_paid_batch_links'").get());
    const lineageRows = context.db.prepare(`SELECT original_logical_digest,generation,policy_id,policy_revision,policy_digest,parent_occurrence_id,
      child_occurrence_id,consent_command_id,predecessor_set_digest,created_at FROM background_proactive_reauthorization_lineage
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND original_logical_digest=? AND policy_revision<? ORDER BY generation`)
      .all(context.workspaceId, context.ownerId, context.privacyEpoch, originalLogicalKeyDigest, schedule.expectedPolicyRevision) as Record<string, unknown>[];
    let parentOccurrenceId = base.occurrence_id;
    const historyIds = [base.occurrence_id];
    for (let index = 0; index < lineageRows.length; index += 1) {
      const lineage = lineageRows[index]!;
      if (lineage.original_logical_digest !== originalLogicalKeyDigest || lineage.generation !== index + 1 || lineage.parent_occurrence_id !== parentOccurrenceId ||
          lineage.policy_id !== schedule.policyId || !UUID_V4.test(String(lineage.child_occurrence_id)) || !HEX.test(String(lineage.policy_digest)) ||
          !UUID_V4.test(String(lineage.consent_command_id)) || !HEX.test(String(lineage.predecessor_set_digest)) ||
          !Number.isSafeInteger(lineage.policy_revision) || !Number.isSafeInteger(lineage.created_at)) return fail('background_proactive_reauthorization_lineage_invalid');
      const child = readOccurrence(context.db, context, String(lineage.child_occurrence_id));
      const expectedKey = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
        privacyEpoch: context.privacyEpoch, policyId: schedule.policyId, domain: 'proactive_reauthorization_v1', originalLogicalKeyDigest,
        generation: index + 1 }));
      if (!child || child.logical_key_digest !== expectedKey || child.policy_revision !== lineage.policy_revision || child.policy_digest !== lineage.policy_digest ||
          child.policy_kind !== 'proactive_draft' || child.descriptor_json !== base.descriptor_json || child.source_json !== base.source_json ||
          child.request_json !== base.request_json || child.request_digest !== base.request_digest || child.batch_job_id !== null) {
        return fail('background_proactive_reauthorization_lineage_invalid');
      }
      const priorPolicy = readPolicy(context.db, context, schedule.policyId, child.policy_revision);
      if (!priorPolicy || priorPolicy.revision.specification_json === '' ||
          safeStored<BackgroundPolicySpecification>(priorPolicy.revision.specification_json).kind !== 'proactive_draft' ||
          (safeStored<Extract<BackgroundPolicySpecification, { kind: 'proactive_draft' }>>(priorPolicy.revision.specification_json)).sourceChangePolicy !== specification.sourceChangePolicy) {
        return fail('background_proactive_reauthorization_lineage_invalid');
      }
      parentOccurrenceId = child.occurrence_id;
      historyIds.push(child.occurrence_id);
    }
    const evidence: unknown[] = [];
    for (const occurrenceId of historyIds) {
      const occurrence = readOccurrence(context.db, context, occurrenceId);
      if (!occurrence || occurrence.policy_id !== schedule.policyId || occurrence.policy_kind !== 'proactive_draft' ||
          occurrence.descriptor_json !== base.descriptor_json || occurrence.source_json !== base.source_json || occurrence.request_json !== base.request_json ||
          occurrence.batch_job_id !== null || !['suppressed', 'scheduled'].includes(occurrence.status)) {
        return fail('background_proactive_reauthorization_history_invalid');
      }
      const attempts = context.db.prepare(`SELECT attempt_id,target_id,target_generation,status,dispatch_started_at,settled_at,accounting_json,result_code,
        finalization_operation,finalization_request_json,finalization_receipt_json,finalization_receipt_digest FROM background_occurrence_attempts
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? ORDER BY attempt_id`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId) as Record<string, unknown>[];
      if (attempts.length === 0) return fail('background_proactive_reauthorization_history_invalid');
      for (const attempt of attempts) {
        if (!UUID_V4.test(String(attempt.attempt_id)) || attempt.status !== 'skipped' || attempt.dispatch_started_at !== null ||
            typeof attempt.result_code !== 'string' || !['live_not_submitted','startup_not_submitted_recovered','startup_before_submit_recovered'].includes(attempt.result_code) ||
            attempt.settled_at === null || attempt.finalization_operation === null || typeof attempt.finalization_request_json !== 'string' ||
            typeof attempt.finalization_receipt_json !== 'string' || typeof attempt.finalization_receipt_digest !== 'string' ||
            hash(attempt.finalization_receipt_json) !== attempt.finalization_receipt_digest ||
            canonicalBackgroundJson(JSON.parse(attempt.finalization_request_json)) !== attempt.finalization_request_json ||
            canonicalBackgroundJson(JSON.parse(attempt.finalization_receipt_json)) !== attempt.finalization_receipt_json) {
          return fail('background_proactive_reauthorization_history_invalid');
        }
        if (linksPresent && context.db.prepare(`SELECT 1 FROM background_paid_batch_links WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?
            AND (occurrence_id=? OR attempt_id=?)`).get(context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId, attempt.attempt_id)) {
          return fail('background_proactive_reauthorization_linked_attempt');
        }
        const preflights = context.db.prepare(`SELECT attempt_id,candidate_id,policy_id,policy_revision,attempt_number,status,result_code,
          paid_occurrence_id,paid_attempt_id,recovery_protocol_version FROM background_proactive_preflight_attempts
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND paid_occurrence_id=? AND paid_attempt_id=?`)
          .all(context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId, attempt.attempt_id) as Record<string, unknown>[];
        if (preflights.length !== 1 || preflights[0]!.recovery_protocol_version !== 1 || preflights[0]!.policy_id !== schedule.policyId ||
            preflights[0]!.policy_revision !== occurrence.policy_revision ||
            preflights[0]!.paid_occurrence_id !== occurrenceId || preflights[0]!.paid_attempt_id !== attempt.attempt_id) {
          return fail('background_proactive_reauthorization_preflight_invalid');
        }
        const preflight = preflights[0]!;
        const code = attempt.result_code;
        const certificate = context.db.prepare(`SELECT job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,proof_kind,ticket_id,
          preflight_attempt_id,occurrence_id,paid_attempt_id,command_id FROM background_proactive_not_submitted_certificates
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND paid_attempt_id=?`)
          .get(context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attempt_id) as Record<string, unknown> | undefined;
        if (code === 'startup_before_submit_recovered') {
          if (certificate || preflight.status !== 'deferred' || preflight.result_code !== code ||
              preflight.attempt_id !== preflights[0]!.attempt_id) return fail('background_proactive_reauthorization_nojob_invalid');
          const journalExists = context.db.prepare(`SELECT 1 FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`)
            .get(context.workspaceId, attempt.attempt_id);
          const matchingJob = jobs.some((candidate) => (candidate as Record<string, unknown>).proactiveMailReply &&
            ((candidate as Record<string, unknown>).proactiveMailReply as Record<string, unknown>).attemptId === attempt.attempt_id);
          if (journalExists || matchingJob) return fail('background_proactive_reauthorization_nojob_invalid');
        } else {
          if (!certificate || certificate.occurrence_id !== occurrenceId || certificate.paid_attempt_id !== attempt.attempt_id ||
              certificate.preflight_attempt_id !== preflight.attempt_id || certificate.command_id !== attempt.attempt_id ||
              certificate.custom_id !== certificate.job_id || typeof certificate.job_id !== 'string' ||
              !['live_pre_dispatch', 'cold_checkpoint'].includes(String(certificate.proof_kind)) ||
              (code === 'live_not_submitted' ? certificate.proof_kind !== 'live_pre_dispatch' || certificate.ticket_id === null ||
                preflight.status !== 'complete' || preflight.result_code !== code
                : certificate.proof_kind !== 'cold_checkpoint' || certificate.ticket_id !== null || preflight.status !== 'deferred' ||
                  preflight.result_code !== code)) return fail('background_proactive_reauthorization_certificate_invalid');
          const job = ledgerJobs.get(String(certificate.job_id));
          if (!job || job.id !== certificate.job_id || job.customId !== certificate.custom_id || job.requestSha256 !== certificate.request_sha256 ||
              typeof job.requestBody !== 'string' || hash(job.requestBody) !== certificate.request_sha256 || job.status !== 'failed' ||
              job.failureCode !== 'not_submitted' || job.unknownCharge !== false || job.batchId !== undefined ||
              hash(canonicalBackgroundJson(job.proactiveMailReply)) !== certificate.marker_sha256) return fail('background_proactive_reauthorization_certificate_invalid');
          const projection = { ...job };
          delete projection.status; delete projection.failureCode; delete projection.updatedAt;
          if (hash(canonicalBackgroundJson(projection, PRIVATE_MAX)) !== certificate.job_projection_sha256) {
            return fail('background_proactive_reauthorization_certificate_invalid');
          }
          const journal = context.db.prepare(`SELECT owner_id,privacy_epoch,command_kind,status,ticket_id FROM async_command_journal
            WHERE workspace_id=? AND idempotency_key=?`).get(context.workspaceId, attempt.attempt_id) as Record<string, unknown> | undefined;
          if (!journal || journal.owner_id !== context.ownerId || journal.privacy_epoch !== context.privacyEpoch ||
              journal.command_kind !== 'mail.replybatch.submit' || !['finished','inspect_required'].includes(String(journal.status)) ||
              (certificate.proof_kind === 'live_pre_dispatch' && journal.ticket_id !== certificate.ticket_id)) {
            return fail('background_proactive_reauthorization_journal_invalid');
          }
        }
        evidence.push({ occurrenceId, attempt: { ...attempt }, preflight: { ...preflight }, certificate: certificate ?? null });
      }
    }
    const predecessorSetDigest = hash(canonicalBackgroundJson({ originalLogicalKeyDigest, historyIds, evidence, lineages: lineageRows }, PRIVATE_MAX));
    const generation = lineageRows.length + 1;
    const existingLineage = context.db.prepare(`SELECT generation,parent_occurrence_id,child_occurrence_id,consent_command_id,predecessor_set_digest
      FROM background_proactive_reauthorization_lineage WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?
        AND original_logical_digest=? AND policy_revision=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, originalLogicalKeyDigest, schedule.expectedPolicyRevision) as Record<string, unknown> | undefined;
    if (existingLineage) {
      if (existingLineage.parent_occurrence_id !== parentOccurrenceId || existingLineage.consent_command_id !== consentCommandId ||
          existingLineage.predecessor_set_digest !== predecessorSetDigest || existingLineage.generation !== generation ||
          !Number.isSafeInteger(existingLineage.generation)) {
        return fail('background_proactive_reauthorization_conflict');
      }
      const childLogicalKeyDigest = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
        privacyEpoch: context.privacyEpoch, policyId: schedule.policyId, domain: 'proactive_reauthorization_v1', originalLogicalKeyDigest,
        generation: existingLineage.generation }));
      const existing = context.db.prepare(`SELECT occurrence_id,policy_id,logical_key_digest,policy_revision,policy_kind,policy_digest,status,scheduled_at,
        actual_at,period_kind,local_period_start,time_zone,source_digest,source_json,descriptor_json,request_json,source_version_digest,request_digest,
        target_snapshot_json,batch_job_id,accounting_json,created_at,updated_at FROM background_occurrences
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, existingLineage.child_occurrence_id) as OccurrenceRow | undefined;
      if (!existing || existing.logical_key_digest !== childLogicalKeyDigest) return fail('background_proactive_reauthorization_conflict');
      return Object.freeze({ childLogicalKeyDigest, generation: existingLineage.generation as number,
        parentOccurrenceId: String(existingLineage.parent_occurrence_id), consentCommandId, predecessorSetDigest, existing });
    }
    if (!Number.isSafeInteger(generation) || generation < 1 || schedule.expectedPolicyRevision <= base.policy_revision) {
      return fail('background_proactive_reauthorization_conflict');
    }
    const childLogicalKeyDigest = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
      privacyEpoch: context.privacyEpoch, policyId: schedule.policyId, domain: 'proactive_reauthorization_v1', originalLogicalKeyDigest, generation }));
    const collision = context.db.prepare(`SELECT occurrence_id FROM background_occurrences WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?
      AND policy_id=? AND logical_key_digest=?`).get(context.workspaceId, context.ownerId, context.privacyEpoch, schedule.policyId, childLogicalKeyDigest);
    if (collision) return fail('background_proactive_reauthorization_conflict');
    return Object.freeze({ childLogicalKeyDigest, generation, parentOccurrenceId, consentCommandId, predecessorSetDigest });
  }

  /** Accepts only the ordinary tuple digest or an exact immutable, consent-backed reauthorization child. */
  #assertProactiveOccurrenceIdentity(context: OwnedTransactionContext, occurrence: OccurrenceRow,
    specification: BackgroundPolicySpecification, binding: ResolvedBackgroundBinding, descriptor: BackgroundOccurrenceDescriptor): void {
    if (occurrence.policy_kind !== specification.kind || descriptor.kind !== specification.kind) {
      return fail('background_occurrence_storage_invalid');
    }
    const descriptorJson = canonicalBackgroundJson(descriptor, PRIVATE_MAX);
    const sourceJson = canonicalBackgroundJson(safeStored<unknown>(occurrence.source_json), PRIVATE_MAX);
    const requestJson = canonicalBackgroundJson(safeStored<unknown>(occurrence.request_json), PRIVATE_MAX);
    if (descriptorJson !== occurrence.descriptor_json || sourceJson !== occurrence.source_json || requestJson !== occurrence.request_json ||
        hash(sourceJson) !== occurrence.source_digest ||
        hash(canonicalBackgroundJson({ sourceDigest: occurrence.source_digest, requestJson, scheduledAt: occurrence.scheduled_at }, PRIVATE_MAX)) !== occurrence.request_digest) {
      return fail('background_occurrence_storage_invalid');
    }
    if (specification.kind !== 'proactive_draft' || descriptor.kind !== 'proactive_draft') return;
    const logicalTuple = descriptorTuple(specification, binding, descriptor);
    const originalLogicalKeyDigest = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
      privacyEpoch: context.privacyEpoch, policyId: occurrence.policy_id, logicalTuple }));
    if (occurrence.logical_key_digest === originalLogicalKeyDigest) return;
    const policy = readPolicy(context.db, context, occurrence.policy_id, occurrence.policy_revision);
    if (!policy || policy.revision.policy_digest !== occurrence.policy_digest) return fail('background_occurrence_storage_invalid');
    const plan = this.#prepareProactiveReauthorization(context, { input: { expectedPrivacyEpoch: context.privacyEpoch,
      policyId: occurrence.policy_id, expectedPolicyRevision: occurrence.policy_revision, descriptor,
      scheduledAt: occurrence.scheduled_at, source: JSON.parse(sourceJson), request: JSON.parse(requestJson) },
      policy, specification, descriptor, originalLogicalKeyDigest, sourceJson, requestJson,
      requestDigest: occurrence.request_digest, scheduledAt: occurrence.scheduled_at }, true);
    if (occurrence.logical_key_digest !== plan.childLogicalKeyDigest || plan.existing?.occurrence_id !== occurrence.occurrence_id ||
        plan.existing.policy_revision !== occurrence.policy_revision || plan.existing.policy_digest !== occurrence.policy_digest ||
        plan.existing.descriptor_json !== occurrence.descriptor_json || plan.existing.source_json !== occurrence.source_json ||
        plan.existing.request_json !== occurrence.request_json || plan.existing.request_digest !== occurrence.request_digest ||
        plan.existing.scheduled_at !== occurrence.scheduled_at) return fail('background_occurrence_storage_invalid');
  }

  claim(input: { readonly expectedPrivacyEpoch: number; readonly occurrenceId: string; readonly targetId: string; readonly targetGeneration?: number }): ClaimedBackgroundOccurrence {
    return this.#claim(input);
  }

  /** Paid proactive claims atomically bind their exact reading preflight identity. */
  claimProactive(input: { readonly expectedPrivacyEpoch: number; readonly occurrenceId: string; readonly targetId: string;
    readonly targetGeneration?: number; readonly preflightIndex: BackgroundProactiveCandidateIndex;
    readonly preflightClaim: BackgroundProactivePreflightClaim }): ClaimedBackgroundOccurrence {
    if (!input?.preflightIndex || !input.preflightClaim) return fail('background_proactive_claim_invalid');
    return this.#claim(input, Object.freeze({ index: input.preflightIndex, claim: input.preflightClaim }));
  }

  #claim(input: { readonly expectedPrivacyEpoch: number; readonly occurrenceId: string; readonly targetId: string; readonly targetGeneration?: number },
    preflight?: Readonly<{ index: BackgroundProactiveCandidateIndex; claim: BackgroundProactivePreflightClaim }>): ClaimedBackgroundOccurrence {
    if (!input || !Number.isSafeInteger(input.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0 || !isBackgroundUuidV4(input.occurrenceId) ||
        typeof input.targetId !== 'string' || !input.targetId || Buffer.byteLength(input.targetId, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(input.targetId) ||
        (input.targetGeneration !== undefined && (!Number.isSafeInteger(input.targetGeneration) || input.targetGeneration < 1))) return fail('background_claim_invalid');
    return this.#kernel.withOwnedTransaction(this.#actor, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const occurrence = readOccurrence(context.db, context, input.occurrenceId);
      if (!occurrence || !['scheduled', 'claimed', 'dispatching'].includes(occurrence.status)) return fail('background_occurrence_not_claimable');
      if (timestamp(this.#clock()) < occurrence.scheduled_at) return fail('background_occurrence_not_due');
      const generation = input.targetGeneration ?? 0;
      const verified = verifyPolicy(context, context.db, this.#resolver, occurrence);
      if (!allowedTarget(verified.spec, verified.binding, occurrence, input.targetId, generation)) return fail('background_target_not_bound');
      const target = context.db.prepare(`SELECT target_id,target_generation,status,attempt_id,accounting_json,updated_at FROM background_occurrence_targets
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, input.targetId, generation) as TargetRow | undefined;
      if (!target || target.status !== 'pending' || target.attempt_id !== null || target.updated_at > timestamp(this.#clock())) return fail('background_occurrence_not_claimable');
      const claimId = randomUUID(); const capability = randomUUID(); const now = timestamp(this.#clock());
      if (preflight) {
        const descriptor = safeStored<BackgroundOccurrenceDescriptor>(occurrence.descriptor_json);
        if (occurrence.policy_kind !== 'proactive_draft' || descriptor.kind !== 'proactive_draft' || occurrence.policy_id !== preflight.claim.policyId ||
            occurrence.policy_revision !== preflight.claim.policyRevision || descriptor.accountIdentityKey !== input.targetId ||
            (descriptor.kind === 'proactive_draft' && !allowedTarget(verified.spec, verified.binding, occurrence, input.targetId, generation))) {
          return fail('background_proactive_paid_binding_invalid');
        }
      } else if (occurrence.policy_kind === 'proactive_draft') {
        return fail('background_proactive_preflight_required');
      }
      context.db.prepare(`INSERT INTO background_occurrence_attempts(workspace_id,owner_id,privacy_epoch,attempt_id,occurrence_id,target_id,
        target_generation,capability_hash,status,claimed_at,dispatch_started_at,settled_at,accounting_json,result_code)
        VALUES(?,?,?,?,?,?,?,?, 'claimed',?,NULL,NULL,?,NULL)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, claimId, occurrence.occurrence_id, input.targetId,
          generation, hash(capability), now, canonicalBackgroundJson({ status: 'unknown' }));
      const targetChanged = context.db.prepare(`UPDATE background_occurrence_targets SET status='claimed',attempt_id=?,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=? AND status='pending'`)
        .run(claimId, now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, input.targetId, generation);
      if (targetChanged.changes !== 1) return fail('background_occurrence_not_claimable');
      if (preflight) preflight.index.bindPaidOccurrenceWithinTransaction(context, preflight.claim,
        { occurrenceId: occurrence.occurrence_id, paidAttemptId: claimId });
      context.db.prepare(`UPDATE background_occurrences SET status='claimed',updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status IN ('scheduled','claimed','dispatching')`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
      const fresh = readOccurrence(context.db, context, occurrence.occurrence_id);
      if (!fresh) return fail('background_occurrence_storage_invalid');
      return Object.freeze({ occurrence: project(fresh), claim: Object.freeze({ occurrenceId: occurrence.occurrence_id, attemptId: claimId,
        targetId: input.targetId, ...(generation === 0 ? {} : { targetGeneration: generation }), capability }) });
    });
  }

  /** Metadata-only due timestamp query for the trusted scheduler. */
  readNextDueAt(expectedPrivacyEpoch: number): number | null {
    return this.#kernel.withOwnedTransaction(this.#actor, expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      this.fenceStaleScheduled(context);
      const row = context.db.prepare(`SELECT MIN(max(o.scheduled_at,t.updated_at)) AS dueAt FROM background_occurrences o
        JOIN background_occurrence_targets t ON t.workspace_id=o.workspace_id AND t.owner_id=o.owner_id AND t.privacy_epoch=o.privacy_epoch
          AND t.occurrence_id=o.occurrence_id AND t.status='pending'
        JOIN background_policy_heads h ON h.workspace_id=o.workspace_id AND h.owner_id=o.owner_id AND h.privacy_epoch=o.privacy_epoch
          AND h.policy_id=o.policy_id AND h.current_revision=o.policy_revision AND h.status='enabled'
        JOIN background_policy_revisions r ON r.workspace_id=o.workspace_id AND r.owner_id=o.owner_id AND r.privacy_epoch=o.privacy_epoch
          AND r.policy_id=o.policy_id AND r.revision=o.policy_revision AND r.enabled=1 AND r.policy_digest=o.policy_digest
        WHERE o.workspace_id=? AND o.owner_id=? AND o.privacy_epoch=? AND o.policy_kind='account_sync' AND o.status='scheduled'`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch) as { dueAt: number | null };
      return row.dueAt;
    });
  }

  /** Closed keyset page containing only due account-sync occurrence/target metadata. */
  listDueAccountSyncWork(expectedPrivacyEpoch: number, now: number, afterWorkId?: string, limit = PAGE_MAX): readonly Readonly<{ workId: string; dueAt: number }>[] {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX ||
        (afterWorkId !== undefined && (afterWorkId.length > 256 || /[\u0000-\u001f\u007f]/.test(afterWorkId)))) return fail('background_occurrence_query_invalid');
    let cursor: readonly [string, string, number] | undefined;
    if (afterWorkId !== undefined) {
      try {
        const parsed = JSON.parse(afterWorkId) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== 3 || !isBackgroundUuidV4(parsed[0]) || typeof parsed[1] !== 'string' ||
            !parsed[1] || !Number.isSafeInteger(parsed[2]) || (parsed[2] as number) < 0 || JSON.stringify(parsed) !== afterWorkId) return fail('background_occurrence_query_invalid');
        cursor = [parsed[0], parsed[1], parsed[2] as number];
      } catch { return fail('background_occurrence_query_invalid'); }
    }
    return this.#kernel.withOwnedTransaction(this.#actor, expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      this.fenceStaleScheduled(context);
      const rows = context.db.prepare(`SELECT o.occurrence_id,max(o.scheduled_at,t.updated_at) AS scheduled_at,t.target_id,t.target_generation
        FROM background_occurrences o JOIN background_occurrence_targets t ON t.workspace_id=o.workspace_id AND t.owner_id=o.owner_id
          AND t.privacy_epoch=o.privacy_epoch AND t.occurrence_id=o.occurrence_id
        JOIN background_policy_heads h ON h.workspace_id=o.workspace_id AND h.owner_id=o.owner_id AND h.privacy_epoch=o.privacy_epoch
          AND h.policy_id=o.policy_id AND h.current_revision=o.policy_revision AND h.status='enabled'
        JOIN background_policy_revisions r ON r.workspace_id=o.workspace_id AND r.owner_id=o.owner_id AND r.privacy_epoch=o.privacy_epoch
          AND r.policy_id=o.policy_id AND r.revision=o.policy_revision AND r.enabled=1 AND r.policy_digest=o.policy_digest
        WHERE o.workspace_id=? AND o.owner_id=? AND o.privacy_epoch=? AND o.policy_kind='account_sync' AND o.status='scheduled'
          AND o.scheduled_at<=? AND t.status='pending' AND t.updated_at<=?
          AND (? IS NULL OR o.occurrence_id>? OR (o.occurrence_id=? AND t.target_id>?) OR
            (o.occurrence_id=? AND t.target_id=? AND t.target_generation>?))
        ORDER BY o.occurrence_id,t.target_id,t.target_generation LIMIT ?`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch, now, now,
          cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null,
          cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, limit) as { occurrence_id: string; scheduled_at: number; target_id: string; target_generation: number }[];
      const output = rows.map((row) => Object.freeze({ workId: JSON.stringify([row.occurrence_id, row.target_id, row.target_generation]), dueAt: row.scheduled_at }));
      return Object.freeze(output);
    });
  }

  /** Returns exact bound metadata for one live claim; never returns source/request bodies or capability. */
  readAccountSyncClaimMetadata(claim: BackgroundClaim, expectedPrivacyEpoch: number): BackgroundAccountSyncClaimMetadata {
    return this.#withClaim(claim, expectedPrivacyEpoch, (context, occurrence, attempt) => {
      if (occurrence.policy_kind !== 'account_sync' || attempt.status !== 'claimed') return fail('background_claim_invalid');
      const verified = verifyPolicy(context, context.db, this.#resolver, occurrence);
      const descriptor = safeStored<BackgroundOccurrenceDescriptor>(occurrence.descriptor_json);
      if (descriptor.kind !== 'account_sync' || descriptor.accountId !== attempt.target_id || attempt.target_generation < 1 ||
          !allowedTarget(verified.spec, verified.binding, occurrence, attempt.target_id, attempt.target_generation)) return fail('background_claim_invalid');
      return Object.freeze({ workspaceId: context.workspaceId, ownerId: context.ownerId, privacyEpoch: context.privacyEpoch,
        revision: context.revision, policyId: occurrence.policy_id, policyRevision: occurrence.policy_revision,
        accountId: descriptor.accountId, targetGeneration: attempt.target_generation, resource: descriptor.resource,
        scheduledAt: occurrence.scheduled_at });
    });
  }

  /** Releases only a proven pre-dispatch claim so a foreground account sync can finish first. */
  deferClaimBeforeDispatch(claim: BackgroundClaim, expectedPrivacyEpoch: number, resultCode = 'foreground_sync_busy', nextDueAt?: number): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(resultCode)) return fail('background_settlement_invalid');
    if (nextDueAt !== undefined && (!Number.isSafeInteger(nextDueAt) || nextDueAt < 0)) return fail('background_settlement_invalid');
    this.#withClaim(claim, expectedPrivacyEpoch, (context, occurrence, attempt) => {
      const requestJson = canonicalBackgroundJson({ operation: 'defer', resultCode, nextDueAt: nextDueAt ?? null }, 64 * 1024);
      const prior = priorFinalization(attempt, 'defer', requestJson);
      if (prior !== undefined) return;
      if (occurrence.status !== 'claimed' || attempt.status !== 'claimed') return fail('background_claim_not_deferable');
      const now = timestamp(this.#clock());
      const eligibleAt = Math.max(now, nextDueAt ?? now);
      const receiptJson = canonicalBackgroundJson({ schemaVersion: 1, operation: 'defer', attemptId: attempt.attempt_id,
        resultCode, nextDueAt: eligibleAt, settledAt: now }, 64 * 1024);
      const attemptUpdated = context.db.prepare(`UPDATE background_occurrence_attempts SET status='skipped',settled_at=?,result_code=?,
        finalization_operation='defer',finalization_request_json=?,finalization_receipt_json=?,finalization_receipt_digest=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status='claimed' AND finalization_operation IS NULL`)
        .run(now, resultCode, requestJson, receiptJson, hash(receiptJson), context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attempt_id);
      const targetUpdated = context.db.prepare(`UPDATE background_occurrence_targets SET status='pending',attempt_id=NULL,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=? AND attempt_id=? AND status='claimed'`)
        .run(eligibleAt, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, attempt.target_id,
          attempt.target_generation, attempt.attempt_id);
      if (attemptUpdated.changes !== 1 || targetUpdated.changes !== 1) return fail('background_claim_not_deferable');
      const occurrenceUpdated = context.db.prepare(`UPDATE background_occurrences SET status='scheduled',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status='claimed'`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
      if (occurrenceUpdated.changes !== 1) return fail('background_claim_not_deferable');
    });
  }

  /** Fences a target when claim commit acknowledgement was ambiguous and its capability was not returned. */
  inspectUnacknowledgedAccountSyncWork(expectedPrivacyEpoch: number, occurrenceId: string, targetId: string, generation: number): void {
    if (!isBackgroundUuidV4(occurrenceId) || typeof targetId !== 'string' || !targetId || Buffer.byteLength(targetId, 'utf8') > 1024 ||
        /[\u0000-\u001f\u007f]/.test(targetId) || !Number.isSafeInteger(generation) || generation < 1) return fail('background_claim_invalid');
    this.#kernel.withOwnedTransaction(this.#actor, expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const row = context.db.prepare(`SELECT status,attempt_id FROM background_occurrence_targets
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId, targetId, generation) as { status: string; attempt_id: string | null } | undefined;
      if (!row || !row.attempt_id) return;
      const attempt = context.db.prepare(`SELECT attempt_id,occurrence_id,target_id,target_generation,capability_hash,status,claimed_at,
        dispatch_started_at,settled_at,accounting_json,result_code,finalization_operation,finalization_request_json,finalization_receipt_json,finalization_receipt_digest
        FROM background_occurrence_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, row.attempt_id) as AttemptRow | undefined;
      if (!attempt) return fail('background_occurrence_storage_invalid');
      const requestJson = canonicalBackgroundJson({ operation: 'inspect_unacknowledged', occurrenceId, targetId, generation,
        resultCode: 'claim_outcome_unknown' }, 64 * 1024);
      const prior = priorFinalization(attempt, 'inspect_unacknowledged', requestJson);
      if (prior !== undefined) return;
      if (!['claimed', 'dispatching'].includes(row.status) || !['claimed', 'dispatching'].includes(attempt.status)) {
        return fail('background_claim_not_inspectable');
      }
      const now = timestamp(this.#clock());
      const receiptJson = canonicalBackgroundJson({ schemaVersion: 1, operation: 'inspect_unacknowledged', attemptId: attempt.attempt_id,
        resultCode: 'claim_outcome_unknown', settledAt: now }, 64 * 1024);
      const attemptUpdated = context.db.prepare(`UPDATE background_occurrence_attempts SET status='inspect_required',settled_at=?,result_code='claim_outcome_unknown',
        finalization_operation='inspect_unacknowledged',finalization_request_json=?,finalization_receipt_json=?,finalization_receipt_digest=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status IN ('claimed','dispatching') AND finalization_operation IS NULL`)
        .run(now, requestJson, receiptJson, hash(receiptJson), context.workspaceId, context.ownerId, context.privacyEpoch, row.attempt_id);
      if (attemptUpdated.changes !== 1) return fail('background_claim_not_inspectable');
      context.db.prepare(`UPDATE background_occurrence_targets SET status='inspect_required',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId, targetId, generation);
      context.db.prepare(`UPDATE background_occurrences SET status='inspect_required',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status IN ('scheduled','claimed','dispatching')`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrenceId);
    });
  }

  /** Durable hold for an exact owned claim whether dispatch had begun or not. */
  inspectClaimForRecovery(claim: BackgroundClaim, expectedPrivacyEpoch: number, resultCode = 'execution_outcome_unknown'): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(resultCode)) return fail('background_settlement_invalid');
    this.#withClaim(claim, expectedPrivacyEpoch, (context, occurrence, attempt) => {
      const requestJson = canonicalBackgroundJson({ operation: 'inspect', resultCode }, 64 * 1024);
      const prior = priorFinalization(attempt, 'inspect', requestJson);
      if (prior !== undefined) return;
      if (!['claimed', 'dispatching'].includes(attempt.status) || !['claimed', 'dispatching', 'inspect_required', 'unknown'].includes(occurrence.status)) {
        return fail('background_claim_not_inspectable');
      }
      const now = timestamp(this.#clock());
      const receiptJson = canonicalBackgroundJson({ schemaVersion: 1, operation: 'inspect', attemptId: attempt.attempt_id,
        resultCode, settledAt: now }, 64 * 1024);
      const attemptUpdated = context.db.prepare(`UPDATE background_occurrence_attempts SET status='inspect_required',settled_at=?,result_code=?,
        finalization_operation='inspect',finalization_request_json=?,finalization_receipt_json=?,finalization_receipt_digest=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status IN ('claimed','dispatching') AND finalization_operation IS NULL`)
        .run(now, resultCode, requestJson, receiptJson, hash(receiptJson), context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attempt_id);
      if (attemptUpdated.changes !== 1) return fail('background_claim_not_inspectable');
      const targetUpdated = context.db.prepare(`UPDATE background_occurrence_targets SET status='inspect_required',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=? AND attempt_id=?
          AND status IN ('claimed','dispatching')`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, attempt.target_id, attempt.target_generation, attempt.attempt_id);
      if (targetUpdated.changes !== 1) return fail('background_claim_not_inspectable');
      context.db.prepare(`UPDATE background_occurrences SET status='inspect_required',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status IN ('claimed','dispatching')`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
    });
  }

  beginDispatch(claim: BackgroundClaim, expectedPrivacyEpoch: number): void {
    this.#withClaim(claim, expectedPrivacyEpoch, (context, occurrence, attempt) => {
      if (attempt.status !== 'claimed' || !['claimed', 'dispatching'].includes(occurrence.status)) return fail('background_claim_not_dispatchable');
      const verified = verifyPolicy(context, context.db, this.#resolver, occurrence);
      if (!allowedTarget(verified.spec, verified.binding, occurrence, attempt.target_id, attempt.target_generation)) return fail('background_target_not_bound');
      const now = timestamp(this.#clock());
      context.db.prepare(`UPDATE background_occurrence_attempts SET status='dispatching',dispatch_started_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status='claimed'`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attempt_id);
      const targetChanged = context.db.prepare(`UPDATE background_occurrence_targets SET status='dispatching',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?
          AND attempt_id=? AND status='claimed'`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, attempt.target_id,
          attempt.target_generation, attempt.attempt_id);
      if (targetChanged.changes !== 1) return fail('background_claim_not_dispatchable');
      context.db.prepare(`UPDATE background_occurrences SET status='dispatching',updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
    });
  }

  /**
   * Reads the exact current, claimed proactive occurrence in an already-active
   * kernel transaction. The kernel read proves this is the owning transaction;
   * the returned frozen private inputs are not authority by themselves and must
   * still be checked against the next snapshot and the current policy here.
   */
  readPaidMailReplyInputsWithinTransaction(context: OwnedTransactionContext, claim: BackgroundClaim,
    expectedPrivacyEpoch: number): BackgroundPaidMailReplyInputs {
    this.#kernel.readOwnedSnapshotWithinTransaction(context);
    if (!claim || !isBackgroundUuidV4(claim.occurrenceId) || !isBackgroundUuidV4(claim.attemptId) || !isBackgroundUuidV4(claim.capability) ||
        typeof expectedPrivacyEpoch !== 'number' || !Number.isSafeInteger(expectedPrivacyEpoch) || expectedPrivacyEpoch !== context.privacyEpoch) {
      return fail('background_claim_invalid');
    }
    ensureBackgroundSchema(context.db);
    const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
    const attempt = context.db.prepare(`SELECT attempt_id,occurrence_id,target_id,target_generation,capability_hash,status,claimed_at,
      dispatch_started_at,settled_at,accounting_json,result_code,finalization_operation,finalization_request_json,finalization_receipt_json,finalization_receipt_digest
      FROM background_occurrence_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.attemptId, claim.occurrenceId) as AttemptRow | undefined;
    if (!occurrence || !attempt || attempt.capability_hash !== hash(claim.capability) || attempt.target_id !== claim.targetId ||
        attempt.target_generation !== (claim.targetGeneration ?? 0) || occurrence.policy_kind !== 'proactive_draft' ||
        occurrence.status !== 'claimed' || attempt.status !== 'claimed' || attempt.finalization_operation !== null) {
      return fail('background_claim_invalid');
    }
    const verified = verifyPolicy(context, context.db, this.#resolver, occurrence);
    if (verified.spec.kind !== 'proactive_draft') return fail('background_occurrence_policy_stale');
    const descriptor = safeStored<BackgroundOccurrenceDescriptor>(occurrence.descriptor_json);
    if (descriptor.kind !== 'proactive_draft' || !allowedTarget(verified.spec, verified.binding, occurrence, attempt.target_id, attempt.target_generation)) {
      return fail('background_target_not_bound');
    }
    const account = (verified.binding.accounts ?? []).find((item) => item.identityKey === descriptor.accountIdentityKey);
    const selection = account && verified.spec.accounts.find((row) => row.accountId === account.accountId);
    if (!account || !selection || selection.expectedConnectionGeneration !== account.connectionGeneration ||
        attempt.target_id !== account.identityKey || attempt.target_generation !== account.connectionGeneration) return fail('background_target_not_bound');
    const source = freezeJson(safeStored<unknown>(occurrence.source_json));
    const request = freezeJson(safeStored<unknown>(occurrence.request_json));
    return Object.freeze({ occurrenceId: occurrence.occurrence_id, attemptId: attempt.attempt_id,
      policyId: occurrence.policy_id, policyRevision: occurrence.policy_revision, policyDigest: occurrence.policy_digest,
      accountId: account.accountId, accountIdentityKey: account.identityKey, connectionGeneration: account.connectionGeneration,
      providerMessageId: descriptor.providerMessageId,
      ...(descriptor.sourceVersionDigest ? { sourceVersionDigest: descriptor.sourceVersionDigest } : {}),
      ruleSpecificationDigest: verified.binding.rule?.specificationDigest ?? fail('background_rule_binding_missing'),
      specification: verified.spec, descriptor, source, request, requestDigest: occurrence.request_digest });
  }

  /** Exact linked-job revalidation at the final synchronous provider-dispatch fence. */
  readPaidMailReplyInputsForDispatchWithinTransaction(context: OwnedTransactionContext, claim: BackgroundClaim,
    expectedPrivacyEpoch: number, jobId: string): BackgroundPaidMailReplyInputs {
    this.#kernel.readOwnedSnapshotWithinTransaction(context);
    if (!claim || !isBackgroundUuidV4(claim.occurrenceId) || !isBackgroundUuidV4(claim.attemptId) || !isBackgroundUuidV4(claim.capability) ||
        !isBackgroundUuidV4(jobId) || !Number.isSafeInteger(expectedPrivacyEpoch) || expectedPrivacyEpoch !== context.privacyEpoch) {
      return fail('background_claim_invalid');
    }
    ensureBackgroundSchema(context.db);
    const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
    const attempt = context.db.prepare(`SELECT attempt_id,occurrence_id,target_id,target_generation,capability_hash,status,finalization_operation
      FROM background_occurrence_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.attemptId, claim.occurrenceId) as
      { attempt_id: string; occurrence_id: string; target_id: string; target_generation: number; capability_hash: string; status: string; finalization_operation: string | null } | undefined;
    if (!occurrence || !attempt || attempt.capability_hash !== hash(claim.capability) || attempt.target_id !== claim.targetId ||
        attempt.target_generation !== (claim.targetGeneration ?? 0) || attempt.status !== 'dispatching' || occurrence.status !== 'dispatching' ||
        occurrence.policy_kind !== 'proactive_draft' || occurrence.batch_job_id !== jobId || attempt.finalization_operation !== null) {
      return fail('background_claim_not_dispatchable');
    }
    const verified = verifyPolicy(context, context.db, this.#resolver, occurrence);
    if (verified.spec.kind !== 'proactive_draft') return fail('background_occurrence_policy_stale');
    const descriptor = safeStored<BackgroundOccurrenceDescriptor>(occurrence.descriptor_json);
    if (descriptor.kind !== 'proactive_draft' || !allowedTarget(verified.spec, verified.binding, occurrence, attempt.target_id, attempt.target_generation)) {
      return fail('background_target_not_bound');
    }
    const account = (verified.binding.accounts ?? []).find((item) => item.identityKey === descriptor.accountIdentityKey);
    const selection = account && verified.spec.accounts.find((row) => row.accountId === account.accountId);
    if (!account || !selection || selection.expectedConnectionGeneration !== account.connectionGeneration ||
        attempt.target_id !== account.identityKey || attempt.target_generation !== account.connectionGeneration) return fail('background_target_not_bound');
    return Object.freeze({ occurrenceId: occurrence.occurrence_id, attemptId: attempt.attempt_id,
      policyId: occurrence.policy_id, policyRevision: occurrence.policy_revision, policyDigest: occurrence.policy_digest,
      accountId: account.accountId, accountIdentityKey: account.identityKey, connectionGeneration: account.connectionGeneration,
      providerMessageId: descriptor.providerMessageId,
      ...(descriptor.sourceVersionDigest ? { sourceVersionDigest: descriptor.sourceVersionDigest } : {}),
      ruleSpecificationDigest: verified.binding.rule?.specificationDigest ?? fail('background_rule_binding_missing'),
      specification: verified.spec, descriptor, source: freezeJson(safeStored<unknown>(occurrence.source_json)),
      request: freezeJson(safeStored<unknown>(occurrence.request_json)), requestDigest: occurrence.request_digest });
  }

  /**
   * Verifies historical ownership of a retained proactive mail job. This deliberately
   * validates the immutable policy revision and dispatched claim without resolving
   * current policy enablement, so pause/revoke cannot invalidate an already-created result.
   */
  readPaidMailReplyCheckpointAuthorityWithinTransaction(context: OwnedTransactionContext,
    proof: BackgroundPaidMailReplyCheckpointProof): BackgroundPaidMailReplyCheckpointAuthority {
    this.#kernel.readOwnedSnapshotWithinTransaction(context);
    if (!proof || !isBackgroundUuidV4(proof.occurrenceId) || !isBackgroundUuidV4(proof.attemptId) ||
        !isBackgroundUuidV4(proof.policyId) || !isBackgroundUuidV4(proof.jobId) || proof.customId !== proof.jobId ||
        !HEX.test(proof.policyDigest) || !HEX.test(proof.requestSha256) || !HEX.test(proof.sourceDigest) || !HEX.test(proof.requestDigest) ||
        (proof.sourceVersionDigest !== undefined && !HEX.test(proof.sourceVersionDigest)) ||
        !Number.isSafeInteger(proof.policyRevision) || proof.policyRevision < 1) return fail('background_paid_link_invalid');
    ensureBackgroundSchema(context.db);
    const occurrence = readOccurrence(context.db, context, proof.occurrenceId);
    const attempt = context.db.prepare(`SELECT attempt_id,occurrence_id,target_id,target_generation,status,finalization_operation
      FROM background_occurrence_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, proof.attemptId, proof.occurrenceId) as
      { attempt_id: string; occurrence_id: string; target_id: string; target_generation: number; status: string; finalization_operation: string | null } | undefined;
    if (!occurrence || !attempt || occurrence.policy_kind !== 'proactive_draft' || occurrence.policy_id !== proof.policyId ||
        occurrence.policy_revision !== proof.policyRevision || occurrence.policy_digest !== proof.policyDigest ||
        occurrence.batch_job_id !== proof.jobId || occurrence.status === 'scheduled' || occurrence.status === 'claimed' ||
        !['dispatching', 'unknown', 'completed', 'inspect_required'].includes(occurrence.status) ||
        attempt.attempt_id !== proof.attemptId || attempt.occurrence_id !== proof.occurrenceId ||
        !['dispatching', 'unknown', 'completed', 'inspect_required'].includes(attempt.status) ||
        attempt.finalization_operation === 'defer' || occurrence.source_digest !== proof.sourceDigest ||
        occurrence.source_version_digest !== (proof.sourceVersionDigest ?? null) || occurrence.request_digest !== proof.requestDigest) {
      return fail('background_paid_link_missing');
    }
    const storedSource = safeStored<unknown>(occurrence.source_json);
    if (hash(canonicalBackgroundJson(storedSource, PRIVATE_MAX)) !== occurrence.source_digest ||
        hash(canonicalBackgroundJson({ sourceDigest: occurrence.source_digest, requestJson: occurrence.request_json,
          scheduledAt: occurrence.scheduled_at }, PRIVATE_MAX)) !== occurrence.request_digest) return fail('background_occurrence_storage_invalid');
    const policy = readPolicy(context.db, context, proof.policyId, proof.policyRevision);
    if (!policy || policy.revision.revision !== proof.policyRevision || policy.revision.enabled !== 1 ||
        policy.revision.policy_digest !== proof.policyDigest) return fail('background_paid_link_missing');
    const rawSpec = safeStored<unknown>(policy.revision.specification_json);
    const parsed = parseBackgroundPolicyDisplay({ schemaVersion: 1, policyId: proof.policyId, revision: proof.policyRevision,
      status: policy.head.status, enabled: true, specification: rawSpec, accounts: [], effectiveFrom: policy.revision.effective_from,
      updatedAt: policy.head.updated_at, ...(policy.head.suspension ? { suspension: policy.head.suspension } : {}) });
    if (parsed.specification.kind !== 'proactive_draft') return fail('background_paid_link_missing');
    const rawBinding = safeStored<ResolvedBackgroundBinding>(policy.revision.binding_json);
    const binding = normalizeResolvedBackgroundBinding(rawBinding, parsed.specification, context.privacyEpoch);
    if (canonicalBackgroundJson(binding, PRIVATE_MAX) !== canonicalBackgroundJson(rawBinding, PRIVATE_MAX)) return fail('background_occurrence_policy_corrupt');
    const bindingDigest = hash(canonicalBackgroundJson(backgroundBindingAuthority(binding), PRIVATE_MAX));
    const policyDigest = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
      privacyEpoch: context.privacyEpoch, policyId: proof.policyId, revision: proof.policyRevision, enabled: true,
      specification: parsed.specification, bindingDigest, effectiveFrom: policy.revision.effective_from }));
    if (bindingDigest !== policy.revision.binding_digest || policyDigest !== proof.policyDigest) return fail('background_occurrence_policy_corrupt');
    const descriptor = safeStored<BackgroundOccurrenceDescriptor>(occurrence.descriptor_json);
    if (descriptor.kind !== 'proactive_draft' || descriptor.accountIdentityKey !== attempt.target_id ||
        attempt.target_generation < 1 || !allowedTarget(parsed.specification, binding, occurrence, attempt.target_id, attempt.target_generation)) {
      return fail('background_paid_link_missing');
    }
    this.#assertProactiveOccurrenceIdentity(context, occurrence, parsed.specification, binding, descriptor);
    return Object.freeze({ policyId: proof.policyId, policyRevision: proof.policyRevision, policyDigest: proof.policyDigest,
      effort: parsed.specification.paidConsent.effort, occurrenceId: proof.occurrenceId, attemptId: proof.attemptId });
  }

  /**
   * Binds the exact live journal ticket and preparing mail-reply job to this
   * claim in the same transaction that saves the `submitting` snapshot.
   */
  beginPaidSubmissionWithinTransaction(context: OwnedTransactionContext, claim: BackgroundClaim, expectedPrivacyEpoch: number,
    ticket: CommandTicketContext, journal: CommandJournal, jobId: string): BackgroundPaidMailReplyInputs {
    if (!journal || typeof jobId !== 'string' || !isBackgroundUuidV4(jobId)) return fail('background_paid_submission_invalid');
    const inputs = this.readPaidMailReplyInputsWithinTransaction(context, claim, expectedPrivacyEpoch);
    journal.assertPaidMailReplySubmissionWithinTransaction(context, ticket);
    const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
    const attempt = context.db.prepare(`SELECT status FROM background_occurrence_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.attemptId) as { status: string } | undefined;
    if (!occurrence || !attempt || occurrence.status !== 'claimed' || attempt.status !== 'claimed' || occurrence.batch_job_id !== null) {
      return fail('background_claim_not_dispatchable');
    }
    const now = timestamp(this.#clock());
    const attemptUpdated = context.db.prepare(`UPDATE background_occurrence_attempts SET status='dispatching',dispatch_started_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status='claimed' AND finalization_operation IS NULL`)
      .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, claim.attemptId);
    const targetUpdated = context.db.prepare(`UPDATE background_occurrence_targets SET status='dispatching',updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?
        AND attempt_id=? AND status='claimed'`)
      .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, claim.occurrenceId, claim.targetId,
        claim.targetGeneration ?? 0, claim.attemptId);
    const occurrenceUpdated = context.db.prepare(`UPDATE background_occurrences SET status='dispatching',batch_job_id=?,updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status='claimed' AND batch_job_id IS NULL`)
      .run(jobId, now, context.workspaceId, context.ownerId, context.privacyEpoch, claim.occurrenceId);
    if (attemptUpdated.changes !== 1 || targetUpdated.changes !== 1 || occurrenceUpdated.changes !== 1) return fail('background_claim_not_dispatchable');
    return inputs;
  }

  /** Confirms the already-dispatched claim identity during settlement without reauthorizing new work. */
  assertPaidSubmissionSettlementWithinTransaction(context: OwnedTransactionContext, claim: BackgroundClaim,
    expectedPrivacyEpoch: number, jobId: string): void {
    this.#kernel.readOwnedSnapshotWithinTransaction(context);
    if (!claim || !isBackgroundUuidV4(claim.occurrenceId) || !isBackgroundUuidV4(claim.attemptId) ||
        !isBackgroundUuidV4(claim.capability) || !isBackgroundUuidV4(jobId) || expectedPrivacyEpoch !== context.privacyEpoch) {
      return fail('background_claim_invalid');
    }
    ensureBackgroundSchema(context.db);
    const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
    const attempt = context.db.prepare(`SELECT target_id,target_generation,capability_hash,status FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.attemptId, claim.occurrenceId) as
      { target_id: string; target_generation: number; capability_hash: string; status: string } | undefined;
    if (!occurrence || !attempt || attempt.capability_hash !== hash(claim.capability) || attempt.target_id !== claim.targetId ||
        attempt.target_generation !== (claim.targetGeneration ?? 0) || attempt.status !== 'dispatching' || occurrence.status !== 'dispatching' ||
        occurrence.policy_kind !== 'proactive_draft' || occurrence.batch_job_id !== jobId) return fail('background_claim_not_dispatchable');
  }

  /** Final synchronous paid-dispatch authority check; call in the same owned transaction as link/job validation. */
  assertPaidSubmissionDispatchAuthorizedWithinTransaction(context: OwnedTransactionContext, claim: BackgroundClaim,
    expectedPrivacyEpoch: number, jobId: string): void {
    this.assertPaidSubmissionSettlementWithinTransaction(context, claim, expectedPrivacyEpoch, jobId);
    const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
    if (!occurrence) return fail('background_claim_not_dispatchable');
    const verified = verifyPolicy(context, context.db, this.#resolver, occurrence);
    const attempt = context.db.prepare(`SELECT target_id,target_generation FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND occurrence_id=? AND status='dispatching'`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.attemptId, claim.occurrenceId) as
      { target_id: string; target_generation: number } | undefined;
    if (!attempt || !allowedTarget(verified.spec, verified.binding, occurrence, attempt.target_id, attempt.target_generation)) {
      return fail('background_occurrence_binding_changed');
    }
  }

  /** Confirms a precise pre-provider failure may settle without reauthorizing or linking a Batch job. */
  assertPaidPreDispatchSettlementWithinTransaction(context: OwnedTransactionContext, claim: BackgroundClaim,
    expectedPrivacyEpoch: number): void {
    this.#kernel.readOwnedSnapshotWithinTransaction(context);
    if (!claim || !isBackgroundUuidV4(claim.occurrenceId) || !isBackgroundUuidV4(claim.attemptId) ||
        !isBackgroundUuidV4(claim.capability) || expectedPrivacyEpoch !== context.privacyEpoch) return fail('background_claim_invalid');
    ensureBackgroundSchema(context.db);
    const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
    const attempt = context.db.prepare(`SELECT target_id,target_generation,capability_hash,status,dispatch_started_at,finalization_operation FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.attemptId, claim.occurrenceId) as
      { target_id: string; target_generation: number; capability_hash: string; status: string; dispatch_started_at: number | null; finalization_operation: string | null } | undefined;
    if (!occurrence || !attempt || attempt.capability_hash !== hash(claim.capability) || attempt.target_id !== claim.targetId ||
        attempt.target_generation !== (claim.targetGeneration ?? 0) || attempt.status !== 'claimed' || attempt.dispatch_started_at !== null ||
        attempt.finalization_operation !== null ||
        occurrence.status !== 'claimed' || occurrence.policy_kind !== 'proactive_draft' || occurrence.batch_job_id !== null) {
      return fail('background_claim_not_dispatchable');
    }
  }

  /** Atomically retires an exact claimed paid target after a proven live pre-provider failure. */
  settlePaidPreDispatchNotSubmittedWithinTransaction(context: OwnedTransactionContext, claim: BackgroundClaim,
    expectedPrivacyEpoch: number, resultCode: string, settledAt: number): BackgroundOccurrenceDisplay {
    this.assertPaidPreDispatchSettlementWithinTransaction(context, claim, expectedPrivacyEpoch);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(resultCode) || !Number.isSafeInteger(settledAt) || settledAt < 0) {
      return fail('background_settlement_invalid');
    }
    const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
    const attempt = context.db.prepare(`SELECT attempt_id,target_id,target_generation,status,dispatch_started_at,accounting_json,
      finalization_operation,finalization_request_json,finalization_receipt_json,finalization_receipt_digest
      FROM background_occurrence_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND attempt_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.occurrenceId, claim.attemptId) as AttemptRow | undefined;
    if (!occurrence || !attempt) return fail('background_claim_not_settleable');
    const requestJson = canonicalBackgroundJson({ operation: 'settle_not_submitted', resultCode,
      accounting: { status: 'not_applicable' } }, 64 * 1024);
    const prior = priorFinalization(attempt, 'settle', requestJson);
    if (prior !== undefined) return parseBackgroundOccurrenceDisplay(safeStored(prior));
    if (attempt.status !== 'claimed' || attempt.dispatch_started_at !== null || occurrence.status !== 'claimed' ||
        occurrence.policy_kind !== 'proactive_draft' || occurrence.batch_job_id !== null) return fail('background_claim_not_settleable');
    const noCharge = canonicalBackgroundJson({ status: 'not_applicable' });
    const attemptUpdated = context.db.prepare(`UPDATE background_occurrence_attempts SET status='skipped',settled_at=?,accounting_json=?,result_code=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND attempt_id=? AND status='claimed'
        AND dispatch_started_at IS NULL AND finalization_operation IS NULL`)
      .run(settledAt, noCharge, resultCode, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, attempt.attempt_id);
    const targetUpdated = context.db.prepare(`UPDATE background_occurrence_targets SET status='skipped',attempt_id=?,accounting_json=?,updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?
        AND status='claimed' AND attempt_id=?`)
      .run(attempt.attempt_id, noCharge, settledAt, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id,
        attempt.target_id, attempt.target_generation, attempt.attempt_id);
    const occurrenceUpdated = context.db.prepare(`UPDATE background_occurrences SET status='suppressed',accounting_json=?,updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status='claimed' AND batch_job_id IS NULL`)
      .run(noCharge, settledAt, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
    if (attemptUpdated.changes !== 1 || targetUpdated.changes !== 1 || occurrenceUpdated.changes !== 1) return fail('background_claim_not_settleable');
    const fresh = readOccurrence(context.db, context, occurrence.occurrence_id);
    if (!fresh) return fail('background_occurrence_storage_invalid');
    const receiptJson = canonicalBackgroundJson(project(fresh), BACKGROUND_REQUEST_MAX_BYTES);
    const finalized = context.db.prepare(`UPDATE background_occurrence_attempts SET finalization_operation='settle',finalization_request_json=?,
      finalization_receipt_json=?,finalization_receipt_digest=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?
        AND finalization_operation IS NULL`)
      .run(requestJson, receiptJson, hash(receiptJson), context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attempt_id);
    if (finalized.changes !== 1) return fail('background_claim_not_settleable');
    return project(fresh);
  }

  /** Verifies the exact durable pre-dispatch settlement after its acknowledgement was lost. */
  assertPaidPreDispatchFinalizedWithinTransaction(context: OwnedTransactionContext, claim: BackgroundClaim,
    expectedPrivacyEpoch: number, resultCode: string): BackgroundOccurrenceDisplay {
    this.#kernel.assertOwnedTransactionContext(context);
    if (!claim || !isBackgroundUuidV4(claim.occurrenceId) || !isBackgroundUuidV4(claim.attemptId) ||
        !isBackgroundUuidV4(claim.capability) || expectedPrivacyEpoch !== context.privacyEpoch ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(resultCode)) return fail('background_claim_invalid');
    ensureBackgroundSchema(context.db);
    const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
    const attempt = context.db.prepare(`SELECT attempt_id,target_id,target_generation,capability_hash,status,dispatch_started_at,result_code,
      finalization_operation,finalization_request_json,finalization_receipt_json,finalization_receipt_digest
      FROM background_occurrence_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND attempt_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.occurrenceId, claim.attemptId) as AttemptRow | undefined;
    if (!occurrence || !attempt || attempt.capability_hash !== hash(claim.capability) || attempt.target_id !== claim.targetId ||
        attempt.target_generation !== (claim.targetGeneration ?? 0) || attempt.status !== 'skipped' || attempt.dispatch_started_at !== null ||
        attempt.result_code !== resultCode || occurrence.policy_kind !== 'proactive_draft' || occurrence.status !== 'suppressed' ||
        occurrence.batch_job_id !== null) return fail('background_claim_not_settleable');
    const requestJson = canonicalBackgroundJson({ operation: 'settle_not_submitted', resultCode, accounting: { status: 'not_applicable' } }, 64 * 1024);
    const receiptJson = priorFinalization(attempt, 'settle', requestJson);
    if (receiptJson === undefined) return fail('background_claim_finalization_missing');
    const receipt = parseBackgroundOccurrenceDisplay(safeStored<unknown>(receiptJson));
    if (receipt.occurrenceId !== occurrence.occurrence_id || receipt.status !== 'suppressed' ||
        canonicalBackgroundJson(receipt.accounting) !== canonicalBackgroundJson({ status: 'not_applicable' })) {
      return fail('background_claim_finalization_invalid');
    }
    const target = context.db.prepare(`SELECT status,attempt_id,accounting_json FROM background_occurrence_targets
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, attempt.target_id, attempt.target_generation) as
      { status: string; attempt_id: string | null; accounting_json: string } | undefined;
    if (!target || target.status !== 'skipped' || target.attempt_id !== claim.attemptId ||
        target.accounting_json !== canonicalBackgroundJson({ status: 'not_applicable' })) return fail('background_claim_finalization_invalid');
    return receipt;
  }

  /** Final synchronous provider-read fence, called after any credential lookup and before fetch admission. */
  assertDispatchAuthorized(claim: BackgroundClaim, expectedPrivacyEpoch: number): void {
    this.#withClaim(claim, expectedPrivacyEpoch, (context, occurrence, attempt) => {
      if (attempt.status !== 'dispatching' || occurrence.status !== 'dispatching') return fail('background_claim_not_dispatchable');
      const verified = verifyPolicy(context, context.db, this.#resolver, occurrence);
      if (!allowedTarget(verified.spec, verified.binding, occurrence, attempt.target_id, attempt.target_generation)) {
        return fail('background_occurrence_binding_changed');
      }
    });
  }

  settle(claim: BackgroundClaim, expectedPrivacyEpoch: number, outcome: { readonly status: 'completed' | 'unknown' | 'inspect_required'; readonly accounting: BackgroundAccounting; readonly actualAt?: number; readonly batchJobId?: string; readonly resultCode?: string }): BackgroundOccurrenceDisplay {
    const cleanAccounting = accounting(outcome?.accounting);
    if (!outcome || !['completed', 'unknown', 'inspect_required'].includes(outcome.status) ||
        (outcome.actualAt !== undefined && !Number.isSafeInteger(outcome.actualAt)) ||
        (outcome.batchJobId !== undefined && !isBackgroundUuidV4(outcome.batchJobId)) ||
        (outcome.resultCode !== undefined && (typeof outcome.resultCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(outcome.resultCode)))) return fail('background_settlement_invalid');
    return this.#withClaim(claim, expectedPrivacyEpoch, (context, occurrence, attempt) => {
      const requestJson = canonicalBackgroundJson({ operation: 'settle', status: outcome.status, accounting: cleanAccounting,
        actualAt: outcome.actualAt ?? null, batchJobId: outcome.batchJobId ?? null, resultCode: outcome.resultCode ?? null }, 64 * 1024);
      const prior = priorFinalization(attempt, 'settle', requestJson);
      if (prior !== undefined) return parseBackgroundOccurrenceDisplay(safeStored(prior));
      // An already-dispatched exact target must be allowed to record its real outcome even if a sibling
      // has moved the aggregate occurrence into inspection/unknown. That aggregate state still fences
      // every new claim and dispatch; it must not erase an admitted target's settlement authority.
      if (attempt.status !== 'dispatching' || !['dispatching', 'claimed', 'inspect_required', 'unknown'].includes(occurrence.status)) {
        return fail('background_claim_not_settleable');
      }
      const now = timestamp(this.#clock());
      const accountingJson = canonicalBackgroundJson(cleanAccounting, 64 * 1024);
      const attemptUpdated = context.db.prepare(`UPDATE background_occurrence_attempts SET status=?,settled_at=?,accounting_json=?,result_code=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status='dispatching' AND finalization_operation IS NULL`)
        .run(outcome.status, now, accountingJson, outcome.resultCode ?? null, context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attempt_id);
      if (attemptUpdated.changes !== 1) return fail('background_claim_not_settleable');
      const targetChanged = context.db.prepare(`UPDATE background_occurrence_targets SET status=?,accounting_json=?,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?
          AND attempt_id=? AND status='dispatching'`)
        .run(outcome.status, accountingJson, now, context.workspaceId, context.ownerId, context.privacyEpoch,
          occurrence.occurrence_id, attempt.target_id, attempt.target_generation, attempt.attempt_id);
      if (targetChanged.changes !== 1) return fail('background_claim_not_settleable');
      const targetRows = context.db.prepare(`SELECT target_id,target_generation,status,attempt_id,accounting_json FROM background_occurrence_targets
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id) as TargetRow[];
      const hasPending = targetRows.some((target) => target.status === 'pending');
      const hasActive = targetRows.some((target) => target.status === 'claimed' || target.status === 'dispatching');
      const finalStatus: OccurrenceStatus = targetRows.some((target) => target.status === 'inspect_required') ? 'inspect_required'
        : hasPending || hasActive ? (hasActive ? 'dispatching' : 'scheduled')
          : targetRows.some((target) => target.status === 'unknown') ? 'unknown'
            : targetRows.length > 0 && targetRows.every((target) => target.status === 'skipped') ? 'suppressed' : 'completed';
      const nextAccounting = aggregateTargetAccounting(targetRows, finalStatus);
      context.db.prepare(`UPDATE background_occurrences SET status=?,actual_at=COALESCE(actual_at,?),batch_job_id=COALESCE(?,batch_job_id),accounting_json=?,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
        .run(finalStatus, outcome.actualAt ?? (outcome.status === 'completed' ? now : null), outcome.batchJobId ?? null,
          canonicalBackgroundJson(nextAccounting), now,
          context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
      const fresh = readOccurrence(context.db, context, occurrence.occurrence_id);
      if (!fresh) return fail('background_occurrence_storage_invalid');
      const receipt = project(fresh);
      const receiptJson = canonicalBackgroundJson(receipt, BACKGROUND_REQUEST_MAX_BYTES);
      const finalized = context.db.prepare(`UPDATE background_occurrence_attempts SET finalization_operation='settle',finalization_request_json=?,
        finalization_receipt_json=?,finalization_receipt_digest=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND finalization_operation IS NULL`)
        .run(requestJson, receiptJson, hash(receiptJson), context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attempt_id);
      if (finalized.changes !== 1) return fail('background_claim_not_settleable');
      return receipt;
    });
  }

  list(input: { readonly expectedPrivacyEpoch: number; readonly afterOccurrenceId?: string; readonly limit?: number }): readonly BackgroundOccurrenceDisplay[] {
    const limit = input?.limit ?? PAGE_MAX;
    if (!input || !Number.isSafeInteger(input.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX ||
        (input.afterOccurrenceId !== undefined && !isBackgroundUuidV4(input.afterOccurrenceId))) return fail('background_occurrence_query_invalid');
    return this.#kernel.withOwnedTransaction(this.#actor, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const rows = context.db.prepare(`SELECT occurrence_id,policy_id,logical_key_digest,policy_revision,policy_kind,policy_digest,status,scheduled_at,
        actual_at,period_kind,local_period_start,time_zone,source_digest,source_json,descriptor_json,request_json,source_version_digest,request_digest,target_snapshot_json,
        batch_job_id,accounting_json,created_at,updated_at FROM background_occurrences
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND (? IS NULL OR occurrence_id>?) ORDER BY occurrence_id LIMIT ?`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch, input.afterOccurrenceId ?? null, input.afterOccurrenceId ?? null, limit) as OccurrenceRow[];
      return Object.freeze(rows.map(project));
    });
  }

  #withClaim<T>(claim: BackgroundClaim, expectedPrivacyEpoch: number, callback: (context: OwnedTransactionContext, occurrence: OccurrenceRow, attempt: AttemptRow) => T): T {
    if (!claim || !isBackgroundUuidV4(claim.occurrenceId) || !isBackgroundUuidV4(claim.attemptId) || !isBackgroundUuidV4(claim.capability) ||
        typeof expectedPrivacyEpoch !== 'number' || !Number.isSafeInteger(expectedPrivacyEpoch) || expectedPrivacyEpoch < 0) return fail('background_claim_invalid');
    return this.#kernel.withOwnedTransaction(this.#actor, expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const occurrence = readOccurrence(context.db, context, claim.occurrenceId);
      const attempt = context.db.prepare(`SELECT attempt_id,occurrence_id,target_id,target_generation,capability_hash,status,claimed_at,
        dispatch_started_at,settled_at,accounting_json,result_code,finalization_operation,finalization_request_json,finalization_receipt_json,finalization_receipt_digest FROM background_occurrence_attempts
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND occurrence_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.attemptId, claim.occurrenceId) as AttemptRow | undefined;
      if (!occurrence || !attempt || attempt.capability_hash !== hash(claim.capability) || attempt.target_id !== claim.targetId ||
          attempt.target_generation !== (claim.targetGeneration ?? 0)) return fail('background_claim_invalid');
      return callback(context, occurrence, attempt);
    });
  }
}

/** Cold-start only: convert interrupted private claims to inspect-only without authorizing dispatch or replay. */
export function markInterruptedBackgroundWorkForInspection(kernel: DurableKernel, capability: ApplicationStartupCapability): number {
  if (!kernel || !capability) return fail('background_startup_capability_invalid');
  return kernel.withColdStartDatabaseTransaction(capability, (db) => {
    ensureBackgroundSchema(db);
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0) return fail('background_clock_invalid');
    db.prepare(`UPDATE background_occurrence_attempts SET status='inspect_required',result_code='interrupted_requires_inspection'
      WHERE status IN ('claimed','dispatching')`).run();
    const result = db.prepare(`UPDATE background_occurrences SET status='inspect_required',updated_at=?
      WHERE status IN ('claimed','dispatching')`).run(now);
    db.prepare(`UPDATE background_occurrence_targets SET status='inspect_required',updated_at=?
      WHERE status IN ('claimed','dispatching')`).run(now);
    return result.changes;
  });
}
