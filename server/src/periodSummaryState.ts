import { randomUUID } from 'node:crypto';
import { listDuePeriods, nextLocalPeriod, previousLocalPeriod, resolveCompletePeriod,
  type BackgroundPeriodKind, type CompleteBackgroundPeriod } from './backgroundClock.js';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import { initializePeriodSummaryStateSchema } from './periodSummaryStateSchema.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const STATUSES = new Set(['eligible', 'suppressed', 'awaiting_review', 'deferred', 'linked', 'ambiguous']);

export type PeriodSummarySlotStatus = 'eligible' | 'suppressed' | 'awaiting_review' | 'deferred' | 'linked' | 'ambiguous';
export type PeriodSummaryCatchUp = 'ask' | 'latest' | 'all';
export type PeriodSummaryActivation = Readonly<{
  workspaceId: string;
  ownerId: string;
  privacyEpoch: number;
  activationId: string;
  policyId: string;
  policyRevision: number;
  period: BackgroundPeriodKind;
  timeZone: string;
  localDeliveryTime: string;
  catchUp: PeriodSummaryCatchUp;
  activationAt: string;
  firstLocalPeriod: string;
}>;
export type PeriodSummarySlotDecision = Readonly<{
  localPeriodStart: string;
  status: Exclude<PeriodSummarySlotStatus, 'deferred' | 'linked' | 'ambiguous'>;
  reason: string | null;
}>;
export type PeriodSummarySlot = Readonly<{
  period: BackgroundPeriodKind;
  localPeriodStart: string;
  policyId: string;
  policyRevision: number;
  activationId: string;
  status: PeriodSummarySlotStatus;
  reason: string | null;
  dependencyDigest: string | null;
  authorityDigest: string | null;
  linkedOccurrenceId: string | null;
  materializedAt: string;
  updatedAt: string;
}>;
export type PlannedPeriodSummarySlot = Readonly<{
  period: CompleteBackgroundPeriod;
  status: Exclude<PeriodSummarySlotStatus, 'deferred' | 'linked' | 'ambiguous'>;
  reason: string | null;
}>;

interface ActivationRow {
  workspace_id: string;
  owner_id: string;
  privacy_epoch: number;
  activation_id: string;
  policy_id: string;
  policy_revision: number;
  period: BackgroundPeriodKind;
  time_zone: string;
  local_delivery_time: string;
  catch_up: PeriodSummaryCatchUp;
  activation_at: string;
  first_local_period: string;
  materialized_through: string | null;
  next_due_at: string | null;
  status: 'active' | 'paused';
  created_at: string;
  updated_at: string;
}
interface SlotRow {
  period: BackgroundPeriodKind;
  local_period_start: string;
  policy_id: string;
  policy_revision: number;
  activation_id: string;
  status: PeriodSummarySlotStatus;
  reason: string | null;
  dependency_digest: string | null;
  authority_digest: string | null;
  linked_occurrence_id: string | null;
  materialized_at: string;
  updated_at: string;
}

function fail(code: string): never {
  throw new Error(code);
}
function validTime(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('period_summary_state_invalid');
}
function validTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail('period_summary_state_invalid');
  }
}
function validPeriod(value: unknown): asserts value is BackgroundPeriodKind {
  if (value !== 'daily' && value !== 'weekly' && value !== 'monthly' && value !== 'yearly') fail('period_summary_state_invalid');
}
function validateActivation(value: PeriodSummaryActivation): void {
  if (!UUID_V4.test(value.workspaceId) || !UUID_V4.test(value.ownerId) || !UUID_V4.test(value.activationId) || !UUID_V4.test(value.policyId) ||
      !Number.isSafeInteger(value.privacyEpoch) || value.privacyEpoch < 0 || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1) fail('period_summary_activation_invalid');
  validPeriod(value.period);
  validTime(value.localDeliveryTime);
  validTimestamp(value.activationAt);
  if (value.catchUp !== 'ask' && value.catchUp !== 'latest' && value.catchUp !== 'all') fail('period_summary_activation_invalid');
  resolveCompletePeriod({ period: value.period, localPeriod: value.firstLocalPeriod, timeZone: value.timeZone,
    localDeliveryTime: value.localDeliveryTime });
}

function validateActivationRow(row: ActivationRow): void {
  if (!UUID_V4.test(row.workspace_id) || !UUID_V4.test(row.owner_id) || !UUID_V4.test(row.activation_id) ||
      !UUID_V4.test(row.policy_id) || !Number.isSafeInteger(row.privacy_epoch) || row.privacy_epoch < 0 ||
      !Number.isSafeInteger(row.policy_revision) || row.policy_revision < 1 ||
      (row.status !== 'active' && row.status !== 'paused')) fail('period_summary_storage_invalid');
  validPeriod(row.period);
  validTime(row.local_delivery_time);
  validTimestamp(row.activation_at);
  validTimestamp(row.created_at);
  validTimestamp(row.updated_at);
  if (row.catch_up !== 'ask' && row.catch_up !== 'latest' && row.catch_up !== 'all') fail('period_summary_storage_invalid');
  const first = firstPeriodAtOrAfterActivation({
    period: row.period,
    timeZone: row.time_zone,
    localDeliveryTime: row.local_delivery_time,
    activationAt: row.activation_at,
  });
  if (first.localPeriod !== row.first_local_period) fail('period_summary_storage_invalid');
  if (row.materialized_through !== null) {
    resolveCompletePeriod({ period: row.period, localPeriod: row.materialized_through,
      timeZone: row.time_zone, localDeliveryTime: row.local_delivery_time });
    if (row.materialized_through < row.first_local_period) fail('period_summary_storage_invalid');
  }
  if (row.status === 'paused') {
    if (row.next_due_at !== null) fail('period_summary_storage_invalid');
  } else {
    validTimestamp(row.next_due_at);
  }
}

function validateSlotRow(row: SlotRow): void {
  if (!UUID_V4.test(row.policy_id) || !UUID_V4.test(row.activation_id) || !Number.isSafeInteger(row.policy_revision) ||
      row.policy_revision < 1 || !STATUSES.has(row.status)) fail('period_summary_storage_invalid');
  validPeriod(row.period);
  resolveCompletePeriod({ period: row.period, localPeriod: row.local_period_start, timeZone: 'UTC', localDeliveryTime: '00:00' });
  validTimestamp(row.materialized_at);
  validTimestamp(row.updated_at);
  if (row.reason !== null && (typeof row.reason !== 'string' || row.reason.length === 0 || /[\u0000-\u001f\u007f]/.test(row.reason))) {
    fail('period_summary_storage_invalid');
  }
  if ((row.status === 'eligible' && row.reason !== null) ||
      (['suppressed', 'awaiting_review'].includes(row.status) && row.reason === null)) {
    fail('period_summary_storage_invalid');
  }
  if (row.status === 'deferred') {
    if (!row.reason || !SHA256.test(row.dependency_digest ?? '')) fail('period_summary_storage_invalid');
  } else if (row.dependency_digest !== null) fail('period_summary_storage_invalid');
  if (row.status === 'linked') {
    if (!UUID_V4.test(row.linked_occurrence_id ?? '') || !SHA256.test(row.authority_digest ?? '')) fail('period_summary_storage_invalid');
  } else if (row.linked_occurrence_id !== null) fail('period_summary_storage_invalid');
  if (row.status === 'ambiguous' && !SHA256.test(row.authority_digest ?? '')) fail('period_summary_storage_invalid');
  if (row.authority_digest !== null && !SHA256.test(row.authority_digest)) fail('period_summary_storage_invalid');
}

/** Find the first civil period whose authoritative resolved start is at or after activation. */
export function firstPeriodAtOrAfterActivation(input: Readonly<{
  period: BackgroundPeriodKind;
  timeZone: string;
  localDeliveryTime: string;
  activationAt: string;
}>): CompleteBackgroundPeriod {
  validPeriod(input.period);
  validTime(input.localDeliveryTime);
  validTimestamp(input.activationAt);
  let localPeriod = localPeriodForInstant(input.period, input.timeZone, Date.parse(input.activationAt));
  const activationMs = Date.parse(input.activationAt);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const resolved = resolveCompletePeriod({
      period: input.period,
      localPeriod,
      timeZone: input.timeZone,
      localDeliveryTime: input.localDeliveryTime,
    });
    if (Date.parse(resolved.startUtc) >= activationMs) return resolved;
    localPeriod = nextLocalPeriod(input.period,localPeriod);
  }
  return fail('period_summary_activation_boundary_unresolved');
}

/** Returns the latest nonempty period whose delivery instant has passed, plus bounded local work diagnostics. */
export function findLatestDuePeriodStart(input: Readonly<{
  period: BackgroundPeriodKind;
  timeZone: string;
  localDeliveryTime: string;
  firstLocalPeriod: string;
  throughUtc: string;
}>): Readonly<{ localPeriod: string | null; examinedPeriods: number }> {
  validPeriod(input.period);
  validTime(input.localDeliveryTime);
  validTimestamp(input.throughUtc);
  resolveCompletePeriod({
    period: input.period,
    localPeriod: input.firstLocalPeriod,
    timeZone: input.timeZone,
    localDeliveryTime: input.localDeliveryTime,
  });

  const through = Date.parse(input.throughUtc);
  let candidate = localPeriodForInstant(input.period, input.timeZone, through);
  let examinedPeriods = 0;
  while (candidate >= input.firstLocalPeriod) {
    const resolved = resolveCompletePeriod({
      period: input.period,
      localPeriod: candidate,
      timeZone: input.timeZone,
      localDeliveryTime: input.localDeliveryTime,
    });
    examinedPeriods += 1;
    if (!resolved.empty && Date.parse(resolved.dueUtc) <= through) {
      return Object.freeze({ localPeriod: candidate, examinedPeriods });
    }
    candidate = previousLocalPeriod(input.period, candidate);
  }
  return Object.freeze({ localPeriod: null, examinedPeriods });
}

function localPeriodForInstant(period: BackgroundPeriodKind, timeZone: string, instant: number): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const component = (name: string): number => {
    const part = parts.find((item) => item.type === name)?.value;
    if (!part || !/^\d+$/.test(part)) fail('period_summary_timezone_invalid');
    return Number(part);
  };
  const candidate = new Date(0);
  candidate.setUTCFullYear(component('year'), component('month') - 1, component('day'));
  candidate.setUTCHours(0, 0, 0, 0);
  if (period === 'weekly') candidate.setUTCDate(candidate.getUTCDate() - ((candidate.getUTCDay() + 6) % 7));
  if (period === 'monthly') candidate.setUTCDate(1);
  if (period === 'yearly') candidate.setUTCMonth(0, 1);
  return candidate.toISOString().slice(0, 10);
}

/** Pure schedule projection. It records every due slot and never implies capture or dispatch authority. */
export function planDuePeriodSummarySlots(input: Readonly<{
  period: BackgroundPeriodKind;
  timeZone: string;
  localDeliveryTime: string;
  firstLocalPeriod: string;
  throughUtc: string;
  catchUp: PeriodSummaryCatchUp;
  cursor?: string;
  pageSize?: number;
}>): Readonly<{ periods: readonly PlannedPeriodSummarySlot[]; nextCursor: string | null }> {
  validPeriod(input.period); validTime(input.localDeliveryTime); validTimestamp(input.throughUtc);
  if (input.catchUp !== 'ask' && input.catchUp !== 'latest' && input.catchUp !== 'all') fail('period_summary_plan_invalid');
  const pageSize = input.pageSize ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('period_summary_plan_invalid');
  const latest = input.catchUp === 'all' ? null : findLatestDuePeriodStart(input);
  const page = listDuePeriods({
    period: input.period,
    timeZone: input.timeZone,
    localDeliveryTime: input.localDeliveryTime,
    firstLocalPeriod: input.firstLocalPeriod,
    throughUtc: input.throughUtc,
    pageSize,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  if (page.periods.length === 0) return Object.freeze({ periods: Object.freeze([]), nextCursor: page.nextCursor });
  const result = page.periods.map((period): PlannedPeriodSummarySlot => {
    if (period.empty) return Object.freeze({ period, status: 'suppressed', reason: 'empty_local_period' });
    if (input.catchUp === 'latest' && period.localPeriod !== latest?.localPeriod) {
      return Object.freeze({ period, status: 'suppressed', reason: 'catch_up_latest' });
    }
    if (input.catchUp === 'ask' && period.localPeriod !== latest?.localPeriod) {
      return Object.freeze({ period, status: 'awaiting_review', reason: 'catch_up_review' });
    }
    return Object.freeze({ period, status: 'eligible', reason: null });
  });
  return Object.freeze({ periods: Object.freeze(result), nextCursor: page.nextCursor });
}

/** Durable policy activation and globally unique local-period slot ledger. All methods require this actor's live kernel transaction. */
export class PeriodSummaryState {
  readonly #identity: Readonly<{workspaceId:string;ownerId:string;privacyEpoch:number}>;

  constructor(private readonly kernel: DurableKernel, actorSessionToken: string) {
    const identity = kernel.getOwnedIdentity(actorSessionToken);
    if (!UUID_V4.test(identity.workspaceId) || !UUID_V4.test(identity.ownerId) ||
        !Number.isSafeInteger(identity.privacyEpoch) || identity.privacyEpoch < 0) fail('period_summary_identity_invalid');
    this.#identity = Object.freeze({
      workspaceId: identity.workspaceId,
      ownerId: identity.ownerId,
      privacyEpoch: identity.privacyEpoch,
    });
    kernel.withTrustedDatabaseTransaction((db) => initializePeriodSummaryStateSchema(db));
  }

  /** Call only after a trusted enable/resume/time-zone-change command has established fresh authority. */
  beginActivation(context: OwnedTransactionContext, input: Readonly<{
    policyId: string;
    policyRevision: number;
    period: BackgroundPeriodKind;
    timeZone: string;
    localDeliveryTime: string;
    catchUp: PeriodSummaryCatchUp;
    activationAt: string;
  }>): PeriodSummaryActivation {
    this.#assertContext(context);
    const boundary = firstPeriodAtOrAfterActivation(input);
    const activation: PeriodSummaryActivation = Object.freeze({
      ...this.#identity,
      activationId: randomUUID(),
      ...input,
      firstLocalPeriod: boundary.localPeriod,
    });
    validateActivation(activation);
    const now = new Date(context.now).toISOString();
    context.db.prepare(`INSERT INTO period_summary_policy_activations
      (workspace_id,owner_id,privacy_epoch,activation_id,policy_id,policy_revision,period,time_zone,local_delivery_time,catch_up,
       activation_at,first_local_period,materialized_through,next_due_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,'active',?,?)`)
      .run(
        this.#identity.workspaceId,
        this.#identity.ownerId,
        this.#identity.privacyEpoch,
        activation.activationId,
        activation.policyId,
        activation.policyRevision,
        activation.period,
        activation.timeZone,
        activation.localDeliveryTime,
        activation.catchUp,
        activation.activationAt,
        activation.firstLocalPeriod,
        boundary.dueUtc,
        now,
        now,
      );
    return activation;
  }

  /** Ordinary policy revisions preserve activation and all decisions already materialized for its slots. */
  revisePolicyWithinTransaction(
    context: OwnedTransactionContext,
    activation: PeriodSummaryActivation,
    nextRevision: number,
  ): PeriodSummaryActivation {
    this.#assertContext(context);
    this.#assertActivation(activation);
    if (!Number.isSafeInteger(nextRevision) || nextRevision <= activation.policyRevision) {
      fail('period_summary_revision_invalid');
    }
    const stored = this.#activationRow(context, activation.activationId);
    this.#assertActivationMatchesRow(activation,stored,'active');
    const result=context.db.prepare(`UPDATE period_summary_policy_activations SET policy_revision=?,updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND activation_id=? AND policy_id=? AND policy_revision=? AND status='active'`)
      .run(nextRevision, new Date(context.now).toISOString(), this.#identity.workspaceId, this.#identity.ownerId,
        this.#identity.privacyEpoch, activation.activationId, activation.policyId, activation.policyRevision);
    if (result.changes!==1) fail('period_summary_activation_stale');
    context.db.prepare(`UPDATE period_summary_period_slots SET status='awaiting_review',reason='policy_revision_changed',updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND activation_id=? AND status='eligible'`)
      .run(new Date(context.now).toISOString(), this.#identity.workspaceId, this.#identity.ownerId,
        this.#identity.privacyEpoch, activation.activationId);
    return Object.freeze({...activation,policyRevision:nextRevision});
  }

  pauseActivationWithinTransaction(context: OwnedTransactionContext, activation: PeriodSummaryActivation): void {
    this.#assertContext(context);
    this.#assertActivation(activation);
    this.#assertActivationMatchesRow(activation, this.#activationRow(context, activation.activationId), 'active');
    const result=context.db.prepare(`UPDATE period_summary_policy_activations SET status='paused',next_due_at=NULL,updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND activation_id=? AND policy_id=? AND policy_revision=? AND status='active'`)
      .run(new Date(context.now).toISOString(), this.#identity.workspaceId, this.#identity.ownerId,
        this.#identity.privacyEpoch, activation.activationId, activation.policyId, activation.policyRevision);
    if (result.changes !== 1) fail('period_summary_activation_stale');
    context.db.prepare(`UPDATE period_summary_period_slots SET status='awaiting_review',reason='policy_paused_before_dispatch',updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND activation_id=? AND status='eligible'`)
      .run(new Date(context.now).toISOString(), this.#identity.workspaceId, this.#identity.ownerId,
        this.#identity.privacyEpoch, activation.activationId);
  }

  assertNoOtherActivePolicyWithinTransaction(context:OwnedTransactionContext,period:BackgroundPeriodKind,policyId:string):void {
    this.#assertContext(context);
    validPeriod(period);
    if (!UUID_V4.test(policyId)) fail('period_summary_policy_id_invalid');
    const other=context.db.prepare(`SELECT policy_id FROM period_summary_policy_activations WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?
      AND period=? AND status='active' AND policy_id<>? LIMIT 1`)
      .get(this.#identity.workspaceId,this.#identity.ownerId,this.#identity.privacyEpoch,period,policyId);
    if(other)fail('period_summary_active_policy_conflict');
  }

  materializeDueSlotsWithinTransaction(context:OwnedTransactionContext,activation:PeriodSummaryActivation,
    decisions:readonly PeriodSummarySlotDecision[]):readonly PeriodSummarySlot[] {
    this.#assertContext(context); this.#assertActivation(activation);
    if(!Array.isArray(decisions))fail('period_summary_materialization_invalid');
    const row=this.#activationRow(context,activation.activationId);
    this.#assertActivationMatchesRow(activation,row,'active');
    const unique=new Set<string>();
    const ordered=decisions.map((decision)=>decision.localPeriodStart);
    if(ordered.some((value,index)=>index>0&&value<=ordered[index-1]!))fail('period_summary_materialization_order_invalid');
    const highest=ordered.at(-1)??null;
    const replay=highest!==null&&row!.materialized_through!==null&&highest<=row!.materialized_through;
    if(decisions.length>0&&!replay){
      const expected=row!.materialized_through===null?activation.firstLocalPeriod:nextLocalPeriod(activation.period,row!.materialized_through);
      if(ordered[0]!==expected)fail('period_summary_materialization_cursor_gap');
      for(let index=1;index<ordered.length;index+=1){
        if(ordered[index]!==nextLocalPeriod(activation.period,ordered[index-1]!))fail('period_summary_materialization_cursor_gap');
      }
    }
    const now=new Date(context.now).toISOString();
    const output:PeriodSummarySlot[]=[];
    for(const decision of decisions){
      const resolved=resolveCompletePeriod({period:activation.period,localPeriod:decision.localPeriodStart,timeZone:activation.timeZone,localDeliveryTime:activation.localDeliveryTime});
      if(unique.has(resolved.localPeriod))fail('period_summary_materialization_duplicate');
      unique.add(resolved.localPeriod);
      if(!['eligible','suppressed','awaiting_review'].includes(decision.status) ||
          (decision.status==='eligible'&&decision.reason!==null) || (decision.status!=='eligible'&&typeof decision.reason!=='string'))fail('period_summary_materialization_invalid');
      const existing=this.#slotRow(context,activation.period,resolved.localPeriod);
      if(existing){
        if(existing.policy_id!==activation.policyId||existing.activation_id!==activation.activationId)fail('period_summary_global_slot_conflict');
        if(!replay)fail('period_summary_materialization_cursor_conflict');
        output.push(this.#slot(existing));
        continue;
      }
      if(replay)fail('period_summary_materialization_replay_missing_slot');
      context.db.prepare(`INSERT INTO period_summary_period_slots
        (workspace_id,owner_id,privacy_epoch,period,local_period_start,policy_id,policy_revision,activation_id,status,reason,
         dependency_digest,authority_digest,linked_occurrence_id,materialized_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)`)
        .run(this.#identity.workspaceId,this.#identity.ownerId,this.#identity.privacyEpoch,activation.period,resolved.localPeriod,
          activation.policyId,activation.policyRevision,activation.activationId,decision.status,decision.reason,now,now);
      const inserted=this.#slotRow(context,activation.period,resolved.localPeriod);
      if(!inserted)fail('period_summary_slot_missing');
      output.push(this.#slot(inserted));
    }
    const max=highest??row!.materialized_through;
    if(!replay&&decisions.length>0){
      const nextStart = nextLocalPeriod(activation.period, max!);
      const nextDueAt = resolveCompletePeriod({
        period: activation.period,
        localPeriod: nextStart,
        timeZone: activation.timeZone,
        localDeliveryTime: activation.localDeliveryTime,
      }).dueUtc;
      context.db.prepare(`UPDATE period_summary_policy_activations SET materialized_through=?,next_due_at=?,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND activation_id=? AND status='active'`)
        .run(max,nextDueAt,now,this.#identity.workspaceId,this.#identity.ownerId,this.#identity.privacyEpoch,activation.activationId);
    }
    return Object.freeze(output);
  }

  deferSlotWithinTransaction(context:OwnedTransactionContext,period:BackgroundPeriodKind,localPeriodStart:string,
    expectedStatus:PeriodSummarySlotStatus,reason:string,dependencyDigest:string):PeriodSummarySlot {
    this.#assertContext(context);validPeriod(period);
    if(!STATUSES.has(expectedStatus)||typeof reason!=='string'||reason.length===0||!SHA256.test(dependencyDigest))fail('period_summary_defer_invalid');
    const resolved=resolveCompletePeriod({period,localPeriod:localPeriodStart,timeZone:'UTC',localDeliveryTime:'00:00'});
    const row=this.#slotRow(context,period,resolved.localPeriod);
    if(!row||row.status!==expectedStatus||row.status==='linked'||row.status==='ambiguous')fail('period_summary_slot_stale');
    const result=context.db.prepare(`UPDATE period_summary_period_slots SET status='deferred',reason=?,dependency_digest=?,updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND period=? AND local_period_start=? AND status=?`)
      .run(reason,dependencyDigest,new Date(context.now).toISOString(),this.#identity.workspaceId,this.#identity.ownerId,this.#identity.privacyEpoch,
        period,resolved.localPeriod,expectedStatus);
    if(result.changes!==1)fail('period_summary_slot_stale');
    const updated=this.#slotRow(context,period,resolved.localPeriod)!;return this.#slot(updated);
  }

  /**
   * Records a link only after the caller has independently proven the occurrence in the same
   * owned transaction. This state primitive does not mint dispatch authority.
   */
  linkSlotWithinTransaction(
    context: OwnedTransactionContext,
    period: BackgroundPeriodKind,
    localPeriodStart: string,
    occurrenceId: string,
    authorityDigest: string,
  ): PeriodSummarySlot {
    this.#assertContext(context);validPeriod(period);
    if(!UUID_V4.test(occurrenceId)||!SHA256.test(authorityDigest))fail('period_summary_link_invalid');
    const resolved=resolveCompletePeriod({period,localPeriod:localPeriodStart,timeZone:'UTC',localDeliveryTime:'00:00'});
    const row=this.#slotRow(context,period,resolved.localPeriod);
    if(!row||row.status!=='eligible')fail('period_summary_slot_stale');
    const activation=this.#activationRow(context,row.activation_id);
    if(!activation||activation.status!=='active'||activation.policy_id!==row.policy_id||
        activation.policy_revision!==row.policy_revision||activation.period!==row.period)fail('period_summary_slot_stale');
    const result=context.db.prepare(`UPDATE period_summary_period_slots SET status='linked',reason=NULL,dependency_digest=NULL,
      authority_digest=?,linked_occurrence_id=?,updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND period=?
      AND local_period_start=? AND status='eligible'`)
      .run(authorityDigest,occurrenceId,new Date(context.now).toISOString(),this.#identity.workspaceId,this.#identity.ownerId,this.#identity.privacyEpoch,
        period,resolved.localPeriod);
    if(result.changes!==1)fail('period_summary_slot_stale');
    return this.#slot(this.#slotRow(context,period,resolved.localPeriod)!);
  }

  markSlotAmbiguousWithinTransaction(context:OwnedTransactionContext,period:BackgroundPeriodKind,localPeriodStart:string,
    expectedStatus:PeriodSummarySlotStatus,authorityDigest:string):PeriodSummarySlot {
    this.#assertContext(context);validPeriod(period);
    if(!SHA256.test(authorityDigest))fail('period_summary_ambiguity_invalid');
    const resolved=resolveCompletePeriod({period,localPeriod:localPeriodStart,timeZone:'UTC',localDeliveryTime:'00:00'});
    const row=this.#slotRow(context,period,resolved.localPeriod);
    if(!row||row.status!==expectedStatus||row.status==='linked'||row.status==='ambiguous')fail('period_summary_slot_stale');
    const result=context.db.prepare(`UPDATE period_summary_period_slots SET status='ambiguous',reason='dispatch_outcome_ambiguous',
      dependency_digest=NULL,authority_digest=?,updated_at=? WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?
      AND period=? AND local_period_start=? AND status=?`)
      .run(authorityDigest,new Date(context.now).toISOString(),this.#identity.workspaceId,this.#identity.ownerId,this.#identity.privacyEpoch,
        period,resolved.localPeriod,expectedStatus);
    if(result.changes!==1)fail('period_summary_slot_stale');
    return this.#slot(this.#slotRow(context,period,resolved.localPeriod)!);
  }

  getSlotsWithinTransaction(context:OwnedTransactionContext,period:BackgroundPeriodKind,afterLocalPeriod:string|null,limit:number):readonly PeriodSummarySlot[]{
    this.#assertContext(context);validPeriod(period);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('period_summary_page_invalid');
    if(afterLocalPeriod!==null)resolveCompletePeriod({period,localPeriod:afterLocalPeriod,timeZone:'UTC',localDeliveryTime:'00:00'});
    const rows=(afterLocalPeriod===null
      ?context.db.prepare(`SELECT period,local_period_start,policy_id,policy_revision,activation_id,status,reason,dependency_digest,authority_digest,linked_occurrence_id,materialized_at,updated_at
        FROM period_summary_period_slots WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND period=? ORDER BY local_period_start LIMIT ?`).all(this.#identity.workspaceId,this.#identity.ownerId,this.#identity.privacyEpoch,period,limit)
      :context.db.prepare(`SELECT period,local_period_start,policy_id,policy_revision,activation_id,status,reason,dependency_digest,authority_digest,linked_occurrence_id,materialized_at,updated_at
        FROM period_summary_period_slots WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND period=? AND local_period_start>? ORDER BY local_period_start LIMIT ?`).all(this.#identity.workspaceId,this.#identity.ownerId,this.#identity.privacyEpoch,period,afterLocalPeriod,limit)) as SlotRow[];
    return Object.freeze(rows.map((row)=>this.#slot(row)));
  }

  #assertContext(context:OwnedTransactionContext):void{
    this.kernel.assertOwnedTransactionContext(context);
    if(context.workspaceId!==this.#identity.workspaceId||context.ownerId!==this.#identity.ownerId||context.privacyEpoch!==this.#identity.privacyEpoch||!context.db.inTransaction)fail('period_summary_context_rejected');
  }
  #assertActivation(activation:PeriodSummaryActivation):void{validateActivation(activation);if(activation.workspaceId!==this.#identity.workspaceId||activation.ownerId!==this.#identity.ownerId||activation.privacyEpoch!==this.#identity.privacyEpoch)fail('period_summary_activation_stale');}
  #assertActivationMatchesRow(activation:PeriodSummaryActivation,row:ActivationRow|undefined,status:'active'|'paused'):void{
    if(!row||row.status!==status||row.workspace_id!==this.#identity.workspaceId||row.owner_id!==this.#identity.ownerId||
      row.privacy_epoch!==this.#identity.privacyEpoch||row.activation_id!==activation.activationId||row.policy_id!==activation.policyId||
      row.policy_revision!==activation.policyRevision||row.period!==activation.period||row.time_zone!==activation.timeZone||
      row.local_delivery_time!==activation.localDeliveryTime||row.catch_up!==activation.catchUp||row.activation_at!==activation.activationAt||
      row.first_local_period!==activation.firstLocalPeriod)fail('period_summary_activation_stale');
  }
  #activationRow(context: OwnedTransactionContext, id: string): ActivationRow | undefined {
    const row = context.db.prepare(`SELECT * FROM period_summary_policy_activations
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND activation_id=?`)
      .get(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, id) as ActivationRow | undefined;
    if (row) validateActivationRow(row);
    return row;
  }

  #slotRow(context: OwnedTransactionContext, period: BackgroundPeriodKind, localPeriod: string): SlotRow | undefined {
    const row = context.db.prepare(`SELECT period,local_period_start,policy_id,policy_revision,activation_id,status,reason,
        dependency_digest,authority_digest,linked_occurrence_id,materialized_at,updated_at
      FROM period_summary_period_slots
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND period=? AND local_period_start=?`)
      .get(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, period, localPeriod) as SlotRow | undefined;
    if (row) validateSlotRow(row);
    return row;
  }

  #slot(row: SlotRow): PeriodSummarySlot {
    return Object.freeze({
      period: row.period,
      localPeriodStart: row.local_period_start,
      policyId: row.policy_id,
      policyRevision: row.policy_revision,
      activationId: row.activation_id,
      status: row.status,
      reason: row.reason,
      dependencyDigest: row.dependency_digest,
      authorityDigest: row.authority_digest,
      linkedOccurrenceId: row.linked_occurrence_id,
      materializedAt: row.materialized_at,
      updatedAt: row.updated_at,
    });
  }
}
