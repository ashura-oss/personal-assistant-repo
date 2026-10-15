import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import type { ApplicationStartupCapability } from './applicationStartup.js';
import { ensureBackgroundSchema } from './backgroundSchema.js';
import { canonicalBackgroundJson, isBackgroundUuidV4, type BackgroundAccounting, type BackgroundOccurrenceDisplay, type BackgroundPolicyKind, type BackgroundPolicySpecification } from './backgroundContracts.js';
import { backgroundBindingAuthority, normalizeResolvedBackgroundBinding, type BackgroundBindingResolver, type ResolvedBackgroundBinding } from './backgroundPolicies.js';
import { resolveCompletePeriod } from './backgroundClock.js';

const PAGE_MAX = 100;
const PRIVATE_MAX = 16 * 1024 * 1024;
const HEX = /^[0-9a-f]{64}$/;
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
  accounting_json: string; result_code: string | null;
}

interface FrozenTarget { readonly targetId: string; readonly generation: number }
interface TargetRow { target_id: string; target_generation: number; status: 'pending' | AttemptStatus; attempt_id: string | null; accounting_json: string }

function fail(code: string): never { throw new Error(code); }
function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail('background_occurrence_input_invalid');
  return value as number;
}
function safeStored<T>(text: string): T {
  if (Buffer.byteLength(text, 'utf8') > PRIVATE_MAX) return fail('background_occurrence_storage_invalid');
  try { return JSON.parse(text) as T; } catch { return fail('background_occurrence_storage_invalid'); }
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
  const current = normalizeResolvedBackgroundBinding(resolver.resolve(context, spec), spec, context.privacyEpoch);
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

  schedule(input: ScheduleBackgroundOccurrenceInput): BackgroundOccurrenceDisplay {
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
      const logicalKeyDigest = hash(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
        privacyEpoch: context.privacyEpoch, policyId: input.policyId, logicalTuple }));
      const existing = context.db.prepare(`SELECT occurrence_id,policy_id,logical_key_digest,policy_revision,policy_kind,policy_digest,status,scheduled_at,
        actual_at,period_kind,local_period_start,time_zone,source_digest,source_json,descriptor_json,request_json,source_version_digest,request_digest,target_snapshot_json,
        batch_job_id,accounting_json,created_at,updated_at FROM background_occurrences
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND logical_key_digest=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, input.policyId, logicalKeyDigest) as OccurrenceRow | undefined;
      if (existing) {
        if (existing.policy_revision === input.expectedPolicyRevision && existing.request_digest !== requestDigest) return fail('background_occurrence_identity_conflict');
        return project(existing);
      }
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
          const ids = new Set(selected.subscriptionIds);
          if (capturedTargets.length !== ids.size || capturedTargets.some((target) => !ids.has(target.subscriptionId))) return fail('background_reminder_targets_changed');
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
      const row = readOccurrence(context.db, context, occurrenceId);
      if (!row) return fail('background_occurrence_storage_invalid');
      return project(row);
    });
  }

  claim(input: { readonly expectedPrivacyEpoch: number; readonly occurrenceId: string; readonly targetId: string; readonly targetGeneration?: number }): ClaimedBackgroundOccurrence {
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
      const target = context.db.prepare(`SELECT target_id,target_generation,status,attempt_id,accounting_json FROM background_occurrence_targets
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, input.targetId, generation) as TargetRow | undefined;
      if (!target || target.status !== 'pending' || target.attempt_id !== null) return fail('background_occurrence_not_claimable');
      const claimId = randomUUID(); const capability = randomUUID(); const now = timestamp(this.#clock());
      context.db.prepare(`INSERT INTO background_occurrence_attempts(workspace_id,owner_id,privacy_epoch,attempt_id,occurrence_id,target_id,
        target_generation,capability_hash,status,claimed_at,dispatch_started_at,settled_at,accounting_json,result_code)
        VALUES(?,?,?,?,?,?,?,?, 'claimed',?,NULL,NULL,?,NULL)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, claimId, occurrence.occurrence_id, input.targetId,
          generation, hash(capability), now, canonicalBackgroundJson({ status: 'unknown' }));
      const targetChanged = context.db.prepare(`UPDATE background_occurrence_targets SET status='claimed',attempt_id=?,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND target_id=? AND target_generation=? AND status='pending'`)
        .run(claimId, now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id, input.targetId, generation);
      if (targetChanged.changes !== 1) return fail('background_occurrence_not_claimable');
      context.db.prepare(`UPDATE background_occurrences SET status='claimed',updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND status IN ('scheduled','claimed','dispatching')`)
        .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, occurrence.occurrence_id);
      const fresh = readOccurrence(context.db, context, occurrence.occurrence_id);
      if (!fresh) return fail('background_occurrence_storage_invalid');
      return Object.freeze({ occurrence: project(fresh), claim: Object.freeze({ occurrenceId: occurrence.occurrence_id, attemptId: claimId,
        targetId: input.targetId, ...(generation === 0 ? {} : { targetGeneration: generation }), capability }) });
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

  settle(claim: BackgroundClaim, expectedPrivacyEpoch: number, outcome: { readonly status: 'completed' | 'unknown' | 'inspect_required'; readonly accounting: BackgroundAccounting; readonly actualAt?: number; readonly batchJobId?: string; readonly resultCode?: string }): BackgroundOccurrenceDisplay {
    const cleanAccounting = accounting(outcome?.accounting);
    if (!outcome || !['completed', 'unknown', 'inspect_required'].includes(outcome.status) ||
        (outcome.actualAt !== undefined && !Number.isSafeInteger(outcome.actualAt)) ||
        (outcome.batchJobId !== undefined && !isBackgroundUuidV4(outcome.batchJobId)) ||
        (outcome.resultCode !== undefined && (typeof outcome.resultCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(outcome.resultCode)))) return fail('background_settlement_invalid');
    return this.#withClaim(claim, expectedPrivacyEpoch, (context, occurrence, attempt) => {
      // An already-dispatched exact target must be allowed to record its real outcome even if a sibling
      // has moved the aggregate occurrence into inspection/unknown. That aggregate state still fences
      // every new claim and dispatch; it must not erase an admitted target's settlement authority.
      if (attempt.status !== 'dispatching' || !['dispatching', 'claimed', 'inspect_required', 'unknown'].includes(occurrence.status)) {
        return fail('background_claim_not_settleable');
      }
      const now = timestamp(this.#clock());
      const accountingJson = canonicalBackgroundJson(cleanAccounting, 64 * 1024);
      context.db.prepare(`UPDATE background_occurrence_attempts SET status=?,settled_at=?,accounting_json=?,result_code=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND status='dispatching'`)
        .run(outcome.status, now, accountingJson, outcome.resultCode ?? null, context.workspaceId, context.ownerId, context.privacyEpoch, attempt.attempt_id);
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
      return project(fresh);
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
        dispatch_started_at,settled_at,accounting_json,result_code FROM background_occurrence_attempts
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
