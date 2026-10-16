import type { DurableKernel, OwnedWorkspaceIdentity } from '../../server/src/kernel.js';
import { BackgroundOccurrenceStore, type BackgroundClaim } from '../../server/src/backgroundOccurrences.js';
import { BackgroundPolicyStore, type BackgroundAccountSyncCandidate, type BackgroundProactiveDraftCandidate } from '../../server/src/backgroundPolicies.js';
import { BackgroundScheduler, type BackgroundSchedulerClaim, type BackgroundSchedulerOutcome, type BackgroundSchedulerPorts,
} from '../../server/src/backgroundScheduler.js';
import type { AuthService } from '../../server/src/auth.js';
import type { WorkspaceActorMetadata } from '../../server/src/runtimeActors.js';
import type { RuntimeSessionResolver } from '../../server/src/workspaceRegistry.js';
import type { OwnedWorkspaceRuntime } from './ownedWorkspaceRuntime.node';
import { ProductionBackgroundBindingResolver } from './backgroundBindingResolver.node';
import { BatchObservationIndex, type BatchObservationAttempt } from '../../server/src/batchObservationIndex.js';
import { projectBatchObservationLedger } from './batchObservationProjection.node';
import { OpenRouterBatchInspectionReadError } from '../services/openRouter';
import { BackgroundProactiveCandidateIndex, type BackgroundProactiveCandidateRow, type BackgroundProactivePreflightClaim } from '../../server/src/backgroundProactiveCandidates.js';
import { projectBackgroundProactiveCandidates } from './backgroundProactiveCandidateProjection.node';

const PAGE = 100;
const MINUTE = 60_000;

interface OwnedClaim {
  readonly claim: BackgroundClaim;
  readonly identity: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>;
  readonly actor: string;
  readonly occurrences: BackgroundOccurrenceStore;
  /** Immutable occurrence linkage only; suspension still revalidates the current policy head in its own transaction. */
  readonly policyId: string;
  readonly policyRevision: number;
}
interface OwnedBatchClaim {
  readonly attempt: BatchObservationAttempt;
  readonly identity: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>;
  readonly actor: string;
}
interface OwnedProactiveClaim {
  readonly claim: BackgroundProactivePreflightClaim;
  readonly candidate: BackgroundProactiveCandidateRow;
  readonly policy: BackgroundProactiveDraftCandidate;
  readonly metadata: WorkspaceActorMetadata;
  readonly identity: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>;
  readonly actor: string;
}

function parseWorkId(value: string): readonly [string, string, number] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('background_scheduler_metadata_invalid'); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' ||
      !Number.isSafeInteger(parsed[2]) || JSON.stringify(parsed) !== value) throw new Error('background_scheduler_metadata_invalid');
  return Object.freeze([parsed[0], parsed[1], parsed[2] as number]);
}

function proactiveWorkId(policyId: string, policyRevision: number, candidateId: string): string {
  return JSON.stringify([policyId, policyRevision, candidateId]);
}

function parseProactiveWorkId(value: string): readonly [string, number, string] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('background_scheduler_metadata_invalid'); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string' || !Number.isSafeInteger(parsed[1]) ||
      typeof parsed[2] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed[0]) ||
      !/^[0-9a-f]{64}$/.test(parsed[2]) || (parsed[1] as number) < 1 || JSON.stringify(parsed) !== value) {
    throw new Error('background_scheduler_metadata_invalid');
  }
  return Object.freeze([parsed[0], parsed[1] as number, parsed[2]]);
}

function identityOf(metadata: WorkspaceActorMetadata): OwnedWorkspaceIdentity {
  return Object.freeze({ workspaceId: metadata.workspaceId, ownerId: metadata.ownerId, privacyEpoch: metadata.privacyEpoch, revision: metadata.revision });
}

/** The per-host owner. Its timer starts only after the application host has sealed startup recovery. */
export class BackgroundRuntimeOwner {
  readonly policies: BackgroundPolicyStore;
  readonly #scheduler: BackgroundScheduler;
  readonly #kernel: DurableKernel;
  readonly #runtime: OwnedWorkspaceRuntime;
  readonly #runtimeSessionFor: RuntimeSessionResolver;
  readonly #metadataPage: (afterWorkspaceId?: string, limit?: number) => readonly WorkspaceActorMetadata[];
  readonly #resolver: ProductionBackgroundBindingResolver;
  readonly #claims = new WeakMap<object, OwnedClaim>();
  readonly #batchClaims = new WeakMap<object, OwnedBatchClaim>();
  readonly #proactiveClaims = new WeakMap<object, OwnedProactiveClaim>();
  readonly #proactiveClaimReservations = new Map<string, BackgroundProactivePreflightClaim>();
  readonly #batchFinalizations = new WeakMap<object, Readonly<{ readonly final: { readonly kind: 'deferred' | 'completed' | 'inspect_required'; readonly code: string; readonly nextDueAt: number; readonly terminal: boolean }; readonly settledAt: number }>>();
  readonly #proactiveFinalizations = new WeakMap<object, Readonly<{ readonly final: Readonly<{
    readonly status: 'complete' | 'deferred' | 'inspect_required'; readonly code: string; readonly nextDueAt?: number }>;
    readonly settledAt: number }>>();
  readonly #batchIndex = new BatchObservationIndex();
  readonly #proactiveCandidateIndex: BackgroundProactiveCandidateIndex;
  #stopped = false;

  constructor(input: Readonly<{ kernel: DurableKernel; auth: AuthService; runtime: OwnedWorkspaceRuntime;
    runtimeSessionFor: RuntimeSessionResolver;
    listWorkspaceMetadataPage: (afterWorkspaceId?: string, limit?: number) => readonly WorkspaceActorMetadata[] }>) {
    this.#kernel = input.kernel;
    this.#runtime = input.runtime;
    this.#runtimeSessionFor = input.runtimeSessionFor;
    this.#metadataPage = input.listWorkspaceMetadataPage;
    this.#resolver = new ProductionBackgroundBindingResolver(input.kernel);
    this.#proactiveCandidateIndex = new BackgroundProactiveCandidateIndex(input.kernel);
    this.policies = new BackgroundPolicyStore({ kernel: input.kernel, auth: input.auth, resolver: this.#resolver,
      onProactivePolicyEnabledWithinTransaction: (context, now) => {
        const current = input.kernel.readOwnedSnapshotWithinTransaction(context);
        if (current.workspaceId !== context.workspaceId || current.privacyEpoch !== context.privacyEpoch) throw new Error('background_proactive_snapshot_identity_changed');
        this.#proactiveCandidateIndex.reconcile(context, projectBackgroundProactiveCandidates(current.snapshot, now), context.revision, now);
      },
      onCommitted: () => this.#scheduler?.wake() });
    this.#scheduler = new BackgroundScheduler({ ports: this.#ports(), clock: {
      now: Date.now,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    } });
    // Cold startup backfills content-free Batch metadata once before arming the
    // scheduler. Subsequent timer scans read only this index; snapshot writes
    // maintain it through the composed commit participant.
    this.#forEachMetadata((metadata) => { this.#ensureCandidateIndexes(metadata, Date.now()); });
    this.#scheduler.start();
  }

  stopAdmission(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#scheduler.stopAdmission();
  }

  /** Private Node composition signal for durable metadata changes; coalesces through the existing timer. */
  wakeForMetadataCommit(): void {
    if (!this.#stopped) this.#scheduler.wake();
  }

  drainAndDispose(): Promise<void> { this.stopAdmission(); return this.#scheduler.drainAndDispose(); }

  #actor(metadata: WorkspaceActorMetadata): string {
    return this.#runtimeSessionFor(identityOf(metadata));
  }

  #occurrences(metadata: WorkspaceActorMetadata): BackgroundOccurrenceStore {
    return new BackgroundOccurrenceStore({ kernel: this.#kernel, actorSessionToken: this.#actor(metadata), resolver: this.#resolver });
  }

  #ensureCandidateIndexes(metadata: WorkspaceActorMetadata, now: number): number | null {
    const actor = this.#actor(metadata);
    return this.#kernel.withOwnedTransaction(actor, metadata.privacyEpoch, (context) => {
      const backfillBatch = !this.#batchIndex.hasWorkspaceScope(context, metadata.privacyEpoch);
      const backfillProactive = !this.#proactiveCandidateIndex.hasScope(context);
      if (backfillBatch || backfillProactive) {
        const current = this.#kernel.readOwnedSnapshotWithinTransaction(context);
        if (current.workspaceId !== metadata.workspaceId || context.ownerId !== metadata.ownerId || current.privacyEpoch !== metadata.privacyEpoch) {
          return null;
        }
        if (backfillBatch) this.#batchIndex.reconcile(context, projectBatchObservationLedger(current.snapshot), now);
        if (backfillProactive) this.#proactiveCandidateIndex.reconcile(context,
          projectBackgroundProactiveCandidates(current.snapshot, now), current.revision, now);
      }
      return this.#batchIndex.readNextDueAt(context, metadata.privacyEpoch);
    });
  }

  #batchDue(metadata: WorkspaceActorMetadata, now: number): number | null {
    return this.#ensureCandidateIndexes(metadata, now);
  }

  #forEachMetadata(visitor: (metadata: WorkspaceActorMetadata) => boolean | void, afterWorkspaceId?: string): void {
    let cursor: string | undefined;
    if (afterWorkspaceId !== undefined) cursor = afterWorkspaceId;
    for (;;) {
      const page = this.#metadataPage(cursor, PAGE);
      if (!Array.isArray(page) || page.length > PAGE || page.some((item, index) => index > 0 && page[index - 1]!.workspaceId >= item.workspaceId)) throw new Error('background_metadata_invalid');
      for (const item of page) if (visitor(Object.freeze({ ...item })) === false) return;
      if (page.length < PAGE) break;
      const next = page.at(-1)?.workspaceId;
      if (!next || next === cursor) throw new Error('background_metadata_invalid');
      cursor = next;
    }
  }

  #forEachCandidate(metadata: WorkspaceActorMetadata, visit: (candidate: BackgroundAccountSyncCandidate) => void): void {
    const actor = this.#actor(metadata);
    let afterPolicyId: string | undefined;
    for (;;) {
      const page = this.policies.listAccountSyncCandidatePage(actor, { expectedPrivacyEpoch: metadata.privacyEpoch, afterPolicyId, limit: PAGE });
      for (const candidate of page.candidates) visit(candidate);
      if (!page.nextCursor) break;
      if (page.nextCursor === afterPolicyId) throw new Error('background_policy_cursor_invalid');
      afterPolicyId = page.nextCursor;
    }
  }

  #forEachProactiveCandidate(metadata: WorkspaceActorMetadata, visit: (candidate: BackgroundProactiveDraftCandidate) => boolean | void,
    start?: Readonly<{ policyId: string; inclusive: boolean }>): void {
    const actor = this.#actor(metadata);
    let afterPolicyId: string | undefined;
    let atOrAfterPolicyId: string | undefined = start?.inclusive ? start.policyId : undefined;
    if (start && !start.inclusive) afterPolicyId = start.policyId;
    for (;;) {
      const page = this.policies.listProactiveDraftCandidatePage(actor, { expectedPrivacyEpoch: metadata.privacyEpoch,
        ...(afterPolicyId ? { afterPolicyId } : {}), ...(atOrAfterPolicyId ? { atOrAfterPolicyId } : {}), limit: PAGE });
      for (const candidate of page.candidates) if (visit(candidate) === false) return;
      if (!page.nextCursor) break;
      if (page.nextCursor === afterPolicyId) throw new Error('background_policy_cursor_invalid');
      afterPolicyId = page.nextCursor;
      atOrAfterPolicyId = undefined;
    }
  }

  #proactiveDueAt(metadata: WorkspaceActorMetadata): number | null {
    let earliest: number | null = null;
    this.#forEachProactiveCandidate(metadata, (candidate) => {
      const spec = candidate.policy.specification;
      if (spec.kind !== 'proactive_draft') return;
      const due = this.#kernel.withOwnedTransaction(this.#actor(metadata), metadata.privacyEpoch, (context) =>
        this.#proactiveCandidateIndex.readNextDueAtForPolicy(context, { ruleId: spec.ruleId, ruleRevision: spec.expectedRuleRevision,
          policyId: candidate.policy.policyId, policyRevision: candidate.policy.revision }));
      if (due !== null && (earliest === null || due < earliest)) earliest = due;
    });
    return earliest;
  }

  #ensureOccurrences(metadata: WorkspaceActorMetadata, now: number): BackgroundOccurrenceStore {
    const store = this.#occurrences(metadata);
    this.#forEachCandidate(metadata, (candidate) => {
      const spec = candidate.policy.specification;
      if (spec.kind !== 'account_sync') return;
      const interval = spec.intervalMinutes * MINUTE;
      const grid = candidate.initialEffectiveFrom;
      const effective = candidate.policy.effectiveFrom;
      const first = grid + Math.max(0, Math.ceil((effective - grid) / interval)) * interval;
      const latest = now >= first ? first + Math.floor((now - first) / interval) * interval : undefined;
      const next = latest === undefined ? first : latest + interval;
      const slots = latest === undefined ? [next] : [latest, next];
      for (const selection of spec.accounts) for (const resource of spec.resources) for (const slot of slots) {
        const iso = new Date(slot).toISOString();
        try {
          store.schedule({ expectedPrivacyEpoch: metadata.privacyEpoch, policyId: candidate.policy.policyId,
            expectedPolicyRevision: candidate.policy.revision,
            descriptor: { kind: 'account_sync', accountId: selection.accountId, resource, scheduledSlotUtc: iso },
            scheduledAt: slot, source: {}, request: {} });
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'background_occurrence_binding_changed' || code === 'background_binding_changed') {
            this.policies.suspendAccountSyncAfterBindingChange(this.#actor(metadata), { expectedPrivacyEpoch: metadata.privacyEpoch,
              policyId: candidate.policy.policyId, expectedPolicyRevision: candidate.policy.revision });
            continue;
          }
          if (!['background_occurrence_policy_stale', 'background_occurrence_policy_corrupt',
            'background_target_not_bound', 'background_occurrence_slot_invalid'].includes(code)) throw error;
        }
      }
    });
    return store;
  }

  #ports(): BackgroundSchedulerPorts {
    const claimFor = (opaque: BackgroundSchedulerClaim): OwnedClaim => {
      const entry = this.#claims.get(opaque as object);
      if (!entry) throw new Error('background_claim_invalid');
      return entry;
    };
    return {
      readNextDueAt: async ({ now }) => {
        let earliest: number | null = null;
        this.#forEachMetadata((metadata) => {
          try {
            const store = this.#ensureOccurrences(metadata, now);
            const due = store.readNextDueAt(metadata.privacyEpoch);
            if (due !== null && (earliest === null || due < earliest)) earliest = due;
            const batchDue = this.#batchDue(metadata, now);
            if (batchDue !== null && (earliest === null || batchDue < earliest)) earliest = batchDue;
            const proactiveDue = this.#proactiveDueAt(metadata);
            if (proactiveDue !== null && (earliest === null || proactiveDue < earliest)) earliest = proactiveDue;
          } catch (error) {
            if (error instanceof Error && ['unauthenticated', 'stale_epoch', 'workspace_binding_rejected'].includes(error.message)) return;
            throw error;
          }
        });
        return earliest;
      },
      listDueWorkspaces: async ({ now, afterWorkspaceId, limit }) => {
        const found: string[] = [];
        this.#forEachMetadata((item) => {
          if (afterWorkspaceId && item.workspaceId <= afterWorkspaceId) return;
          try {
            const store = this.#ensureOccurrences(item, now);
            const batchDue = this.#batchDue(item, now);
            const proactiveDue = this.#proactiveDueAt(item);
            if (store.listDueAccountSyncWork(item.privacyEpoch, now, undefined, 1).length || batchDue !== null && batchDue <= now ||
                proactiveDue !== null && proactiveDue <= now) found.push(item.workspaceId);
          } catch (error) {
            if (error instanceof Error && ['unauthenticated', 'stale_epoch', 'workspace_binding_rejected'].includes(error.message)) return;
            throw error;
          }
          return found.length < limit;
        }, afterWorkspaceId);
        return Object.freeze(found);
      },
      listDueLanes: async ({ workspaceId, now }) => {
        const metadata = this.#findMetadata(workspaceId);
        if (!metadata) return Object.freeze([]);
        try {
          const lanes: ('account_sync' | 'batch_observation' | 'proactive_draft')[] = [];
          const batchDue = this.#batchDue(metadata, now);
          const proactiveDue = this.#proactiveDueAt(metadata);
          if (this.#occurrences(metadata).listDueAccountSyncWork(metadata.privacyEpoch, now, undefined, 1).length) lanes.push('account_sync');
          if (batchDue !== null && batchDue <= now) lanes.push('batch_observation');
          if (proactiveDue !== null && proactiveDue <= now) lanes.push('proactive_draft');
          return Object.freeze(lanes);
        }
        catch (error) { if (error instanceof Error && ['unauthenticated', 'stale_epoch'].includes(error.message)) return Object.freeze([]); throw error; }
      },
      listDueOccurrences: async ({ workspaceId, now, afterWorkId, limit, lane }) => {
        const metadata = this.#findMetadata(workspaceId);
        if (!metadata) return Object.freeze([]);
        if (lane === 'batch_observation') return this.#kernel.withOwnedTransaction(this.#actor(metadata), metadata.privacyEpoch, (context) => {
          return Object.freeze(this.#batchIndex.listDue(context, metadata.privacyEpoch, now, afterWorkId, limit)
            .map((item) => Object.freeze({ workspaceId, workId: item.job_id, lane, dueAt: item.next_due_at })));
        });
        if (lane === 'proactive_draft') {
          const cursorTuple = afterWorkId === undefined ? undefined : parseProactiveWorkId(afterWorkId);
          const output: { workspaceId: string; workId: string; lane: 'proactive_draft'; dueAt: number }[] = [];
          this.#forEachProactiveCandidate(metadata, (policy) => {
            if (output.length >= limit) return false;
            if (policy.policy.specification.kind !== 'proactive_draft') return;
            if (cursorTuple && (policy.policy.policyId < cursorTuple[0] ||
                (policy.policy.policyId === cursorTuple[0] && policy.policy.revision < cursorTuple[1]))) return;
            const spec = policy.policy.specification;
            const samePolicyCursor = cursorTuple && policy.policy.policyId === cursorTuple[0] && policy.policy.revision === cursorTuple[1];
            const page = this.#kernel.withOwnedTransaction(this.#actor(metadata), metadata.privacyEpoch, (context) =>
              this.#proactiveCandidateIndex.listDueForPolicy(context, { ruleId: spec.ruleId, ruleRevision: spec.expectedRuleRevision,
                policyId: policy.policy.policyId, policyRevision: policy.policy.revision, now,
                ...(samePolicyCursor ? { afterCandidateId: cursorTuple[2] } : {}), limit: Math.min(PAGE, limit - output.length) }));
            for (const candidate of page) output.push(Object.freeze({ workspaceId, lane, workId: proactiveWorkId(policy.policy.policyId,
              policy.policy.revision, candidate.candidateId), dueAt: Math.max(candidate.eligibleAt, candidate.nextDueAt) }));
            if (output.length >= limit) return false;
          }, cursorTuple ? { policyId: cursorTuple[0], inclusive: true } : undefined);
          return Object.freeze(output.slice(0, limit));
        }
        if (lane !== 'account_sync') return Object.freeze([]);
        return this.#occurrences(metadata).listDueAccountSyncWork(metadata.privacyEpoch, now, afterWorkId, limit)
          .map((item) => Object.freeze({ workspaceId, workId: item.workId, lane, dueAt: item.dueAt }));
      },
      claimOccurrence: async ({ work, now }) => {
        const metadata = this.#findMetadata(work.workspaceId);
        if (!metadata) return undefined;
        if (work.lane === 'batch_observation') {
          const actor = this.#actor(metadata);
          const attempt = this.#kernel.withOwnedTransaction(actor, metadata.privacyEpoch, (context) => {
            const current = this.#kernel.readOwnedSnapshotWithinTransaction(context);
            this.#batchIndex.reconcile(context, projectBatchObservationLedger(current.snapshot), now);
            return this.#batchIndex.claim(context, metadata.privacyEpoch, work.workId, now);
          });
          if (!attempt) return undefined;
          const opaque = Object.freeze({}) as BackgroundSchedulerClaim;
          const identity = Object.freeze({ workspaceId: metadata.workspaceId, ownerId: metadata.ownerId, privacyEpoch: metadata.privacyEpoch });
          this.#batchClaims.set(opaque as object, Object.freeze({ attempt, identity, actor }));
          return opaque;
        }
        if (work.lane === 'proactive_draft') {
          const [policyId, policyRevision, candidateId] = parseProactiveWorkId(work.workId);
          let policyCandidate: BackgroundProactiveDraftCandidate | undefined;
          this.#forEachProactiveCandidate(metadata, (candidate) => {
            if (candidate.policy.policyId === policyId && candidate.policy.revision === policyRevision) policyCandidate = candidate;
          });
          if (!policyCandidate || policyCandidate.policy.specification.kind !== 'proactive_draft') return undefined;
          const spec = policyCandidate.policy.specification;
          const actor = this.#actor(metadata);
          const reservation = this.#proactiveClaimReservations.get(work.workId) ?? this.#proactiveCandidateIndex.prepareClaim({
            candidateId, policyId, policyRevision, ruleId: spec.ruleId, ruleRevision: spec.expectedRuleRevision,
            workspaceId: metadata.workspaceId, ownerId: metadata.ownerId, privacyEpoch: metadata.privacyEpoch });
          this.#proactiveClaimReservations.set(work.workId, reservation);
          let admitted: Readonly<{ candidate: BackgroundProactiveCandidateRow; claim: BackgroundProactivePreflightClaim }> | undefined;
          try { admitted = this.#kernel.withOwnedTransaction(actor, metadata.privacyEpoch, (context) => {
            const candidate = this.#proactiveCandidateIndex.readCandidateForPolicy(context, { candidateId, ruleId: spec.ruleId,
              ruleRevision: spec.expectedRuleRevision, policyId, policyRevision, now });
            if (!candidate) return undefined;
            const claim = this.#proactiveCandidateIndex.claim(context, candidateId, policyId, policyRevision,
              spec.ruleId, spec.expectedRuleRevision, now, reservation);
            return claim ? Object.freeze({ candidate, claim }) : undefined;
          }); } catch (error) { throw error; }
          if (!admitted) { this.#proactiveClaimReservations.delete(work.workId); return undefined; }
          this.#proactiveClaimReservations.delete(work.workId);
          const { candidate, claim } = admitted;
          const opaque = Object.freeze({}) as BackgroundSchedulerClaim;
          const identity = Object.freeze({ workspaceId: metadata.workspaceId, ownerId: metadata.ownerId, privacyEpoch: metadata.privacyEpoch });
          this.#proactiveClaims.set(opaque as object, Object.freeze({ claim, candidate, policy: policyCandidate, metadata, identity, actor }));
          return opaque;
        }
        if (work.lane !== 'account_sync') return undefined;
    const [occurrenceId, targetId, generation] = parseWorkId(work.workId);
        const store = this.#occurrences(metadata);
        const owned = store.claim({ expectedPrivacyEpoch: metadata.privacyEpoch, occurrenceId, targetId, targetGeneration: generation });
        const opaque = Object.freeze({}) as BackgroundSchedulerClaim;
        const identity = Object.freeze({ workspaceId: metadata.workspaceId, ownerId: metadata.ownerId, privacyEpoch: metadata.privacyEpoch });
        this.#claims.set(opaque as object, Object.freeze({ claim: owned.claim, identity, actor: this.#actor(metadata), occurrences: store,
          policyId: owned.occurrence.policyId, policyRevision: owned.occurrence.policyRevision }));
        void now;
        return opaque;
      },
      executeClaim: async (opaque) => {
        const proactive = this.#proactiveClaims.get(opaque as object);
        if (proactive) {
          try {
            this.#kernel.withOwnedTransaction(proactive.actor, proactive.identity.privacyEpoch, (context) =>
              this.#proactiveCandidateIndex.markReadingWithinTransaction(context, proactive.claim, Date.now()));
            const outcome = await this.#runtime.executeScheduledProactiveDraft({ sessionToken: proactive.actor, ownerId: proactive.identity.ownerId,
              privacyEpoch: proactive.identity.privacyEpoch, claim: proactive.claim, candidate: proactive.candidate, policy: proactive.policy,
              candidateIndex: this.#proactiveCandidateIndex, occurrences: this.#occurrences(proactive.metadata), policies: this.policies });
            if (outcome.status === 'complete') return Object.freeze({ kind: 'terminal', code: outcome.code });
            if (outcome.status === 'deferred') return Object.freeze({ kind: 'deferred', code: outcome.code, nextDueAt: outcome.nextDueAt });
            return Object.freeze({ kind: 'inspect_required', code: outcome.code });
          } catch (error) {
            if (error instanceof Error && error.message === 'The workspace runtime is busy.') {
              return Object.freeze({ kind: 'deferred', code: 'foreground_mail_busy', nextDueAt: Date.now() + MINUTE });
            }
            if (error instanceof Error && ['background_execution_stale', 'background_occurrence_policy_stale', 'background_mail_binding_changed',
              'background_mail_source_changed', 'background_mail_rule_not_currently_eligible'].includes(error.message)) {
              return Object.freeze({ kind: 'inspect_required', code: 'binding_changed' });
            }
            throw error;
          }
        }
        const batch = this.#batchClaims.get(opaque as object);
        if (batch) {
          try {
            const result = await this.#runtime.executeScheduledBatchObservation({ sessionToken: batch.actor, ownerId: batch.identity.ownerId,
              privacyEpoch: batch.identity.privacyEpoch, attempt: batch.attempt, index: this.#batchIndex });
            if (result.providerTerminal) return Object.freeze({ kind: 'terminal', code: 'provider_terminal' });
            return Object.freeze({ kind: 'deferred', code: 'provider_pending', nextDueAt: Math.max(Date.now() + MINUTE, result.retryAfterAt ?? 0) });
          } catch (error) {
            const code = error instanceof Error && /^[a-z][a-z0-9_:-]{0,95}$/.test(error.message) ? error.message : 'batch_observation_failed';
            if (error instanceof Error && error.message === 'The workspace runtime is busy.') return Object.freeze({ kind: 'deferred', code: 'foreground_busy', nextDueAt: Date.now() + MINUTE });
            if (error instanceof OpenRouterBatchInspectionReadError && error.retryable) {
              const now = Date.now();
              const nextDueAt = this.#kernel.withOwnedTransaction(batch.actor, batch.identity.privacyEpoch, (context) =>
                this.#batchIndex.nextRetryAt(context, batch.attempt, now, error.retryAfterMs));
              return Object.freeze({ kind: 'deferred', code: 'provider_get_retry', nextDueAt });
            }
            return Object.freeze({ kind: 'inspect_required', code });
          }
        }
        const owned = claimFor(opaque);
        try {
          const outcome = await this.#runtime.executeScheduledAccountSync({ sessionToken: owned.actor, ownerId: owned.identity.ownerId,
            privacyEpoch: owned.identity.privacyEpoch, claim: owned.claim, occurrences: owned.occurrences });
          return Object.freeze({ kind: outcome.status === 'completed' ? 'terminal' : 'inspect_required', code: outcome.code });
        } catch (error) {
          if (error instanceof Error && error.message === 'The workspace runtime is busy.') {
            return Object.freeze({ kind: 'deferred', code: 'foreground_sync_busy', nextDueAt: Date.now() + MINUTE });
          }
          if (error instanceof Error && error.message === 'background_occurrence_binding_changed') {
            try { this.policies.suspendAccountSyncAfterBindingChange(owned.actor, { expectedPrivacyEpoch: owned.identity.privacyEpoch,
              policyId: owned.policyId, expectedPolicyRevision: owned.policyRevision }); }
            catch { /* the immutable occurrence remains held even if a concurrent policy edit won */ }
          }
          if (error instanceof Error && ['background_execution_stale', 'background_occurrence_policy_stale',
            'background_occurrence_binding_changed', 'background_target_not_bound'].includes(error.message)) {
            return Object.freeze({ kind: 'inspect_required', code: 'binding_changed' });
          }
          throw error;
        }
      },
      recordOutcome: async (opaque, outcome: BackgroundSchedulerOutcome) => {
        const proactive = this.#proactiveClaims.get(opaque as object);
        if (proactive) {
          let pending = this.#proactiveFinalizations.get(opaque as object);
          if (!pending) {
            let now = Date.now();
            if (outcome.kind === 'terminal' && outcome.code === 'live_not_submitted') {
              now = this.#kernel.withOwnedTransaction(proactive.actor, proactive.identity.privacyEpoch, (context) =>
                this.#proactiveCandidateIndex.readLiveNotSubmittedSettlementWithinTransaction(context, proactive.claim).settledAt);
            }
            const final = outcome.kind === 'deferred'
              ? { status: 'deferred' as const, code: outcome.code, nextDueAt: outcome.nextDueAt ?? now + MINUTE }
              : outcome.kind === 'held'
                ? { status: 'deferred' as const, code: outcome.reason, nextDueAt: now + MINUTE }
                : outcome.kind === 'inspect_required'
                  ? { status: 'inspect_required' as const, code: outcome.code }
                  : { status: 'complete' as const, code: outcome.code };
            pending = Object.freeze({ final: Object.freeze(final), settledAt: now });
            this.#proactiveFinalizations.set(opaque as object, pending);
          }
          this.#kernel.withOwnedTransaction(proactive.actor, proactive.identity.privacyEpoch, (context) =>
            this.#proactiveCandidateIndex.settleWithinTransaction(context, proactive.claim, pending!.final, pending!.settledAt));
          return;
        }
        const batch = this.#batchClaims.get(opaque as object);
        if (batch) {
          let pending = this.#batchFinalizations.get(opaque as object);
          if (!pending) {
            const now = Date.now();
            const final = outcome.kind === 'deferred'
              ? { kind: 'deferred' as const, code: outcome.code, nextDueAt: outcome.nextDueAt ?? now + MINUTE, terminal: false }
              : outcome.kind === 'held'
                ? { kind: 'deferred' as const, code: outcome.reason, nextDueAt: now + MINUTE, terminal: false }
                : outcome.kind === 'inspect_required'
                  ? { kind: 'inspect_required' as const, code: outcome.code, nextDueAt: Number.MAX_SAFE_INTEGER, terminal: false }
                  : { kind: 'completed' as const, code: outcome.code, nextDueAt: Number.MAX_SAFE_INTEGER, terminal: true };
            pending = Object.freeze({ final: Object.freeze(final), settledAt: now });
            this.#batchFinalizations.set(opaque as object, pending);
          }
          this.#kernel.withOwnedTransaction(batch.actor, batch.identity.privacyEpoch, (context) => {
            this.#batchIndex.settle(context, batch.attempt, pending!.final, pending!.settledAt);
          });
          return;
        }
        const owned = claimFor(opaque);
        if (outcome.kind === 'deferred') {
          owned.occurrences.deferClaimBeforeDispatch(owned.claim, owned.identity.privacyEpoch, outcome.code, outcome.nextDueAt);
          return;
        }
        if (outcome.kind === 'held') {
          owned.occurrences.deferClaimBeforeDispatch(owned.claim, owned.identity.privacyEpoch, outcome.reason);
          return;
        }
        if (outcome.kind === 'inspect_required') owned.occurrences.inspectClaimForRecovery(owned.claim, owned.identity.privacyEpoch, outcome.code);
        else owned.occurrences.settle(owned.claim, owned.identity.privacyEpoch, { status: 'completed',
          accounting: { status: 'not_applicable' }, resultCode: outcome.code });
      },
      reconcileAmbiguousClaim: async (opaque) => {
        const batch = this.#batchClaims.get(opaque as object);
        if (batch) {
          const now = Date.now();
          this.#kernel.withOwnedTransaction(batch.actor, batch.identity.privacyEpoch, (context) => {
            this.#batchIndex.settle(context, batch.attempt, { kind: 'inspect_required', code: 'execution_outcome_unknown',
              nextDueAt: Number.MAX_SAFE_INTEGER, terminal: false }, now);
          });
          return;
        }
        const proactive = this.#proactiveClaims.get(opaque as object);
        if (proactive) {
          const now = Date.now();
          this.#kernel.withOwnedTransaction(proactive.actor, proactive.identity.privacyEpoch, (context) =>
            this.#proactiveCandidateIndex.settleWithinTransaction(context, proactive.claim,
              { status: 'inspect_required', code: 'execution_outcome_unknown' }, now));
          return;
        }
        const owned = claimFor(opaque);
        owned.occurrences.inspectClaimForRecovery(owned.claim, owned.identity.privacyEpoch, 'execution_outcome_unknown');
      },
      reconcileUnacknowledgedClaim: async (work) => {
        const metadata = this.#findMetadata(work.workspaceId);
        if (metadata && work.lane === 'batch_observation') {
          // An unacknowledged claim may have committed. Never mint a replacement GET attempt here.
          const now = Date.now();
          this.#kernel.withOwnedTransaction(this.#actor(metadata), metadata.privacyEpoch, (context) => {
            const current = this.#kernel.readOwnedSnapshotWithinTransaction(context);
            this.#batchIndex.reconcile(context, projectBatchObservationLedger(current.snapshot), now);
            this.#batchIndex.holdUnacknowledged(context, metadata.privacyEpoch, work.workId, now);
          });
          return;
        }
        if (metadata && work.lane === 'proactive_draft') {
          const reservation = this.#proactiveClaimReservations.get(work.workId);
          if (!reservation) return;
          const now = Date.now();
          this.#kernel.withOwnedTransaction(this.#actor(metadata), metadata.privacyEpoch, (context) =>
            this.#proactiveCandidateIndex.reconcileUnacknowledgedClaim(context, reservation, now, now + MINUTE));
          this.#proactiveClaimReservations.delete(work.workId);
          return;
        }
        if (!metadata || work.lane !== 'account_sync') return;
        const [occurrenceId, targetId, generation] = parseWorkId(work.workId);
        this.#occurrences(metadata).inspectUnacknowledgedAccountSyncWork(metadata.privacyEpoch, occurrenceId, targetId, generation);
      },
    };
  }

  #findMetadata(workspaceId: string): WorkspaceActorMetadata | undefined {
    let found: WorkspaceActorMetadata | undefined;
    this.#forEachMetadata((metadata) => {
      if (metadata.workspaceId === workspaceId) { found = metadata; return false; }
      return metadata.workspaceId < workspaceId;
    });
    return found;
  }
}
