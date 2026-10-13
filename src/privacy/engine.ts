import { PRIVACY_CONTROL_LIMITS, validatePrivacyControlState } from './schema';
import type {
  PrivacyCleanupPassResult,
  PrivacyCleanupStep,
  PrivacyCleanupTarget,
  PrivacyCleanupCategory,
  PrivacyControlState,
  PrivacyEngineDependencies,
  PrivacyErasePlan,
  PrivacyNamespace,
  PrivacyPublicStatus,
  PrivacyWriterDescriptor,
  PrivacyWriterLease,
  PrivacyWriterScope,
} from './types';
import { PRIVACY_NAMESPACES } from './types';

export type PrivacyEngineErrorCode =
  | 'blocked'
  | 'stale_epoch'
  | 'stale_plan'
  | 'plan_expired'
  | 'capacity'
  | 'corrupt_state'
  | 'revision_conflict'
  | 'cleanup_in_progress'
  | 'unsupported_owner'
  | 'writer_missing';

const ERROR_MESSAGES: Record<PrivacyEngineErrorCode, string> = {
  blocked: 'Local privacy operation is blocked until active work finishes.',
  stale_epoch: 'Local privacy state changed. Reload and retry.',
  stale_plan: 'The erase plan is no longer current. Prepare a new plan.',
  plan_expired: 'The erase plan expired. Prepare a new plan.',
  capacity: 'Local privacy cleanup capacity is full. No state was discarded.',
  corrupt_state: 'Privacy control state is unreadable. It was preserved.',
  revision_conflict: 'Privacy control state changed. Reload and retry.',
  cleanup_in_progress: 'Local data cleanup is in progress.',
  unsupported_owner: 'This runtime cannot safely verify local writer ownership.',
  writer_missing: 'The local writer lease is no longer available.',
};

export class PrivacyEngineError extends Error {
  readonly code: PrivacyEngineErrorCode;
  constructor(code: PrivacyEngineErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PrivacyEngineError';
    this.code = code;
  }
}

interface PreparedGrant {
  readonly sessionId: string;
  readonly planHash: string;
  readonly expectedRevision: string;
  readonly expectedEpoch: string;
  readonly projection: string;
  readonly expiresAtMs: number;
  readonly preparedAtMs: number;
  readonly ownerRuntimeId: string;
}

interface WriterScopeState {
  readonly lease: PrivacyWriterLease;
  readonly epoch: string;
  sealed: boolean;
  active: boolean;
  readonly pending: Set<Promise<unknown>>;
}

const SESSION_MS = 5 * 60 * 1_000;
const MAX_CAS_ATTEMPTS = 4;

export class PrivacyEngine {
  private readonly grants = new Map<string, PreparedGrant>();
  private readonly writerScopes = new WeakMap<object, WriterScopeState>();
  /** Process-local proof that a callback settled before its durable lease release failed. */
  private readonly settledLeaseProofs = new Map<string, PrivacyWriterLease>();
  private cleanupJob?: Promise<PrivacyCleanupPassResult>;

  constructor(private readonly dependencies: PrivacyEngineDependencies) {}

  async getStatus(): Promise<PrivacyPublicStatus> {
    const state = await this.read();
    const pendingCleanupCount = state.cleanup?.steps.filter((step) => step.status !== 'complete').length ?? 0;
    const failedCleanupCount = state.cleanup?.steps.filter((step) => step.status === 'failed').length ?? 0;
    let ownershipVerified = false;
    try {
      const owner = await this.dependencies.arbitration.getRuntimeOwner();
      ownershipVerified = owner.platform === 'web' || (owner.platform === 'ios' && !!owner.processLaunchId && owner.bundleIdentifier === 'com.still.voiceassistant');
    } catch { /* Fixed blocked status; no platform details escape. */ }
    const phase = this.phaseFor(state, ownershipVerified);
    return {
      phase,
      epoch: state.epoch,
      activeWriterCount: state.writerLeases.length,
      pendingCleanupCount,
      failedCleanupCount,
      limits: {
        namespaces: PRIVACY_CONTROL_LIMITS.namespaces,
        oauthTokenRefs: PRIVACY_CONTROL_LIMITS.oauthTokenRefs,
        legacyMarkdownPaths: PRIVACY_CONTROL_LIMITS.legacyMarkdownPaths,
        writerLeases: PRIVACY_CONTROL_LIMITS.writerLeases,
        cleanupTargets: PRIVACY_CONTROL_LIMITS.cleanupTargets,
        cleanupBatch: PRIVACY_CONTROL_LIMITS.cleanupBatch,
      },
      coverage: 'tracked_with_legacy_limits',
      ...(state.cleanup ? { categoryStates: categoryStatesFor(state.cleanup), ...(state.cleanup.status === 'complete' && state.cleanup.completedAt ? { completedAt: state.cleanup.completedAt } : {}) } : {}),
    };
  }

  /**
   * One-shot startup reconciliation. The exclusive platform lock proves that web
   * callbacks protected by the writer lock have ended; native retirement still
   * requires the existing process-identity or settled-callback proof.
   */
  async reconcileStartupWriters(): Promise<PrivacyPublicStatus> {
    try {
      return await this.dependencies.arbitration.withCleanupLock(async () => {
        const state = await this.read();
        if (state.cleanup && state.cleanup.status !== 'complete') return this.getStatus();
        try {
          await this.retireProvenAbandonedLeases();
        } catch (error) {
          if (error instanceof PrivacyEngineError && (error.code === 'blocked' || error.code === 'unsupported_owner')) return this.getStatus();
          throw error;
        }
        return this.getStatus();
      });
    } catch (error) {
      if (error instanceof PrivacyEngineError) throw error;
      // Keep the startup gate closed on an arbiter timeout/availability failure.
      const status = await this.getStatus();
      return { ...status, phase: 'blocked' };
    }
  }

  async registerNamespace(expectedEpoch: string, namespace: PrivacyNamespace): Promise<void> {
    await this.update((state) => {
      if (state.epoch !== expectedEpoch) throw new PrivacyEngineError('stale_epoch');
      this.assertWritable(state);
      if (state.ownedNamespaces.includes(namespace)) return state;
      if (state.ownedNamespaces.length >= PRIVACY_CONTROL_LIMITS.namespaces) throw new PrivacyEngineError('capacity');
      return { ...state, ownedNamespaces: [...state.ownedNamespaces, namespace] };
    });
  }

  async registerOAuthTokenRef(expectedEpoch: string, tokenRef: string): Promise<void> {
    await this.update((state) => {
      if (state.epoch !== expectedEpoch) throw new PrivacyEngineError('stale_epoch');
      this.assertWritable(state);
      if (state.oauthTokenRefs.includes(tokenRef)) return state;
      if (state.oauthTokenRefs.length >= PRIVACY_CONTROL_LIMITS.oauthTokenRefs) throw new PrivacyEngineError('capacity');
      return { ...state, oauthTokenRefs: [...state.oauthTokenRefs, tokenRef] };
    });
  }

  async registerLegacyMarkdownPath(expectedEpoch: string, path: string): Promise<void> {
    await this.update((state) => {
      if (state.epoch !== expectedEpoch) throw new PrivacyEngineError('stale_epoch');
      this.assertWritable(state);
      if (state.legacyMarkdownPaths.includes(path)) return state;
      if (state.legacyMarkdownPaths.length >= PRIVACY_CONTROL_LIMITS.legacyMarkdownPaths) throw new PrivacyEngineError('capacity');
      return { ...state, legacyMarkdownPaths: [...state.legacyMarkdownPaths, path] };
    });
  }

  private async acquireWriter(expectedEpoch: string, descriptor: PrivacyWriterDescriptor): Promise<PrivacyWriterLease> {
    const owner = await this.dependencies.arbitration.getRuntimeOwner();
    if (!isVerifiedWriterOwner(owner)) throw new PrivacyEngineError('unsupported_owner');
    let created: PrivacyWriterLease | undefined;
    await this.update((state) => {
      if (state.epoch !== expectedEpoch) throw new PrivacyEngineError('stale_epoch');
      this.assertWritable(state);
      if (state.writerLeases.length >= PRIVACY_CONTROL_LIMITS.writerLeases) throw new PrivacyEngineError('capacity');
      validateDescriptorIntent(descriptor);
      created = {
        id: this.uuid(),
        epoch: state.epoch,
        owner: { ...owner },
        kind: descriptor.kind,
        ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
        createdAt: this.now().toISOString(),
      };
      const registered = registerDescriptor(state, descriptor);
      return { ...registered, writerLeases: [...registered.writerLeases, created] };
    });
    if (!created) throw new PrivacyEngineError('writer_missing');
    return created;
  }

  private async releaseWriter(leaseId: string): Promise<void> {
    await this.update((state) => {
      const writerLeases = state.writerLeases.filter((lease) => lease.id !== leaseId);
      if (writerLeases.length === state.writerLeases.length) return state;
      return { ...state, writerLeases };
    });
  }

  /** Holds platform arbitration until the writer callback actually settles. */
  async withWriter<T>(
    expectedEpoch: string,
    descriptor: PrivacyWriterDescriptor,
    work: (lease: PrivacyWriterLease, scope: PrivacyWriterScope) => Promise<T>,
  ): Promise<T> {
    const descriptorSnapshot = snapshotDescriptor(descriptor);
    return this.dependencies.arbitration.withWriterLock(async () => {
      const lease = await this.acquireWriter(expectedEpoch, descriptorSnapshot);
      const privateLease = cloneLease(lease);
      const scope = Object.freeze(Object.create(null)) as PrivacyWriterScope;
      const scopeState: WriterScopeState = {
        lease: privateLease,
        epoch: expectedEpoch,
        sealed: false,
        active: true,
        pending: new Set(),
      };
      this.writerScopes.set(scope as object, scopeState);
      const callbackLease = Object.freeze({ ...cloneLease(privateLease), owner: Object.freeze({ ...privateLease.owner }) }) as PrivacyWriterLease;
      let value!: T;
      let workError: unknown;
      let failed = false;
      try {
        value = await work(callbackLease, scope);
      } catch (error) {
        failed = true;
        workError = error;
      } finally {
        scopeState.sealed = true;
        await Promise.allSettled([...scopeState.pending]);
        scopeState.active = false;
        this.writerScopes.delete(scope as object);
      }
      const leaseProof = cloneLease(privateLease);
      try {
        await this.releaseWriter(privateLease.id);
        this.settledLeaseProofs.delete(privateLease.id);
      } catch (error) {
        this.settledLeaseProofs.set(privateLease.id, leaseProof);
        if (!failed) throw error;
      }
      if (failed) throw workError;
      return value;
    });
  }

  /** Runs a child I/O operation under the already-held parent writer arbitration. */
  withExistingWriter<T>(
    scope: PrivacyWriterScope,
    expectedEpoch: string,
    descriptor: PrivacyWriterDescriptor,
    actualIO: () => Promise<T>,
  ): Promise<T> {
    const descriptorSnapshot = Object.freeze({ ...descriptor });
    const scopeState = scope && typeof scope === 'object' ? this.writerScopes.get(scope as object) : undefined;
    if (!scopeState || !scopeState.active || scopeState.sealed) {
      return Promise.reject(new PrivacyEngineError('writer_missing'));
    }
    if (expectedEpoch !== scopeState.epoch) return Promise.reject(new PrivacyEngineError('stale_epoch'));

    // Admission is synchronous: the parent cannot settle and seal between the
    // capability check and the child becoming visible to the drain loop.
    let operation!: Promise<T>;
    operation = (async () => {
      try {
        await this.registerExistingWriterIntent(scopeState, descriptorSnapshot);
        return await actualIO();
      } finally {
        scopeState.pending.delete(operation);
      }
    })();
    scopeState.pending.add(operation);
    // A caller may intentionally fire-and-forget. Observe rejection here so it
    // cannot become unhandled; an awaited caller still receives the rejection.
    void operation.catch(() => undefined);
    return operation;
  }

  private async registerExistingWriterIntent(scope: WriterScopeState, descriptor: PrivacyWriterDescriptor): Promise<void> {
    validateDescriptorIntent(descriptor);
    await this.update((state) => {
      if (state.epoch !== scope.epoch) throw new PrivacyEngineError('stale_epoch');
      this.assertWritable(state);
      const liveLease = state.writerLeases.find((lease) => lease.id === scope.lease.id);
      if (!liveLease || !sameLease(liveLease, scope.lease) || liveLease.epoch !== scope.epoch) {
        throw new PrivacyEngineError('writer_missing');
      }
      return registerDescriptor(state, descriptor);
    });
  }

  async prepareErase(): Promise<PrivacyErasePlan> {
    return this.dependencies.arbitration.withCleanupLock(async () => {
      await this.retireProvenAbandonedLeases();
      const state = await this.read();
      this.assertNoCleanup(state);
      if (state.writerLeases.length > 0) throw new PrivacyEngineError('blocked');
      const owner = await this.dependencies.arbitration.getRuntimeOwner();
      if (owner.platform === 'unsupported' || (owner.platform === 'ios' && (!owner.processLaunchId || owner.bundleIdentifier !== 'com.still.voiceassistant'))) {
        throw new PrivacyEngineError('unsupported_owner');
      }
      const projection = manifestProjection(state);
      const sessionId = this.uuid();
      const planHash = this.uuid();
      const preparedAtMs = this.now().getTime();
      const expiresAtMs = preparedAtMs + SESSION_MS;
      const grant: PreparedGrant = {
        sessionId, planHash, expectedRevision: state.revision, expectedEpoch: state.epoch,
        projection, preparedAtMs, expiresAtMs, ownerRuntimeId: owner.runtimeId,
      };
      this.grants.set(sessionId, grant);
      while (this.grants.size > 2) this.grants.delete(this.grants.keys().next().value as string);
      return {
        operation: 'erase_local_data',
        sessionId,
        planHash,
        expiresAt: new Date(expiresAtMs).toISOString(),
        targetCount: targetsFor(state).length,
        coverage: 'tracked_with_legacy_limits',
      };
    });
  }

  async cancelErase(sessionId: string): Promise<void> {
    this.grants.delete(sessionId);
  }

  async commitErase(input: { sessionId: string; planHash: string }): Promise<void> {
    await this.dependencies.arbitration.withCleanupLock(async () => {
      const grant = this.grants.get(input.sessionId);
      if (!grant || grant.planHash !== input.planHash) throw new PrivacyEngineError('stale_plan');
      const commitNowMs = this.now().getTime();
      if (commitNowMs < grant.preparedAtMs || commitNowMs >= grant.expiresAtMs) {
        this.grants.delete(input.sessionId);
        throw new PrivacyEngineError('plan_expired');
      }
      const owner = await this.dependencies.arbitration.getRuntimeOwner();
      if (owner.runtimeId !== grant.ownerRuntimeId) throw new PrivacyEngineError('stale_plan');
      const state = await this.read();
      if (state.revision !== grant.expectedRevision || state.epoch !== grant.expectedEpoch || manifestProjection(state) !== grant.projection) {
        this.grants.delete(input.sessionId);
        throw new PrivacyEngineError('stale_plan');
      }
      this.assertNoCleanup(state);
      if (state.writerLeases.length > 0) throw new PrivacyEngineError('blocked');
      const nextEpoch = this.uuid();
      const targets = targetsFor(state);
      const steps: PrivacyCleanupStep[] = targets.map((target) => ({ target, status: 'pending' }));
      const cleanup = {
        id: this.uuid(), epoch: nextEpoch, startedAt: this.now().toISOString(), status: 'erasing' as const,
        steps, coverage: 'tracked_with_legacy_limits' as const,
      };
      await this.write(state, { ...state, epoch: nextEpoch, ownedNamespaces: [...PRIVACY_NAMESPACES], cleanup });
      this.grants.delete(input.sessionId);
    });
  }

  async runCleanupPass(): Promise<PrivacyCleanupPassResult> {
    if (this.cleanupJob) return this.cleanupJob;
    this.cleanupJob = this.dependencies.arbitration.withCleanupLock(() => this.runCleanupPassLocked())
      .finally(() => { this.cleanupJob = undefined; });
    return this.cleanupJob;
  }

  private async runCleanupPassLocked(): Promise<PrivacyCleanupPassResult> {
    let state = await this.read();
    const cleanup = state.cleanup;
    if (!cleanup || cleanup.status === 'complete') {
      return { phase: cleanup?.status === 'complete' ? 'complete' : 'idle', attempted: 0, completed: 0, remaining: 0 };
    }
    if (state.writerLeases.length > 0) {
      return { phase: 'blocked', attempted: 0, completed: 0, remaining: remaining(cleanup.steps) };
    }
    if (cleanup.status === 'paused') {
      const resetSteps = cleanup.steps.map((step) => step.status === 'failed' ? { target: step.target, status: 'pending' as const } : step);
      state = await this.write(state, { ...state, cleanup: { ...cleanup, status: 'erasing', steps: resetSteps } });
    }
    let attempted = 0;
    let completedThisPass = 0;
    for (let i = 0; i < state.cleanup!.steps.length && attempted < PRIVACY_CONTROL_LIMITS.cleanupBatch; i += 1) {
      const step = state.cleanup!.steps[i]!;
      if (step.status !== 'pending') continue;
      attempted += 1;
      let errorCode: PrivacyCleanupStep['errorCode'];
      try {
        await this.dependencies.adapter.erase(step.target, state.cleanup!.epoch);
      } catch {
        errorCode = 'erase_failed';
      }
      if (!errorCode) {
        try {
          const gone = await this.dependencies.adapter.verifyGone(step.target, state.cleanup!.epoch);
          if (!gone) errorCode = 'verification_failed';
        } catch {
          errorCode = 'verification_failed';
        }
      }
      const fresh = await this.read();
      const current = fresh.cleanup;
      if (!current || current.id !== state.cleanup!.id || current.epoch !== state.epoch || current.status === 'complete') {
        throw new PrivacyEngineError('stale_epoch');
      }
      const currentStep = current.steps.findIndex((item) => targetKey(item.target) === targetKey(step.target));
      if (currentStep < 0 || current.steps[currentStep]!.status !== 'pending') {
        state = fresh;
        continue;
      }
      const steps = current.steps.slice();
      const oldStep = steps[currentStep]!;
      if (errorCode) {
        steps[currentStep] = { target: oldStep.target, status: 'failed', errorCode };
        state = await this.write(fresh, { ...fresh, cleanup: { ...current, status: 'paused', steps } });
      } else {
        steps[currentStep] = { target: oldStep.target, status: 'complete', completedAt: this.now().toISOString() };
        const manifests = removeManifestTarget(fresh, oldStep.target);
        state = await this.write(fresh, { ...fresh, ...manifests, cleanup: { ...current, steps } });
        completedThisPass += 1;
      }
      if (errorCode) break;
    }
    state = await this.finishIfComplete(state);
    const end = state.cleanup;
    return {
      phase: end?.status === 'complete' ? 'complete' : end?.status === 'paused' ? 'paused' : 'erasing',
      attempted,
      completed: completedThisPass,
      remaining: end?.status === 'complete' ? 0 : remaining(end?.steps ?? []),
    };
  }

  private async finishIfComplete(state: PrivacyControlState): Promise<PrivacyControlState> {
    const cleanup = state.cleanup;
    if (!cleanup || cleanup.steps.some((step) => step.status !== 'complete')) return state;
    if (state.writerLeases.length > 0) return state;
    const counts = {
      namespaces: cleanup.steps.filter((step) => step.target.kind === 'namespace').length,
      oauthTokens: cleanup.steps.filter((step) => step.target.kind === 'oauth_token').length,
      legacyMarkdown: cleanup.steps.filter((step) => step.target.kind === 'legacy_markdown').length,
    };
    return this.write(state, {
      ...state,
      ownedNamespaces: [], oauthTokenRefs: [], legacyMarkdownPaths: [], writerLeases: [],
      cleanup: { ...cleanup, status: 'complete', steps: [], completedAt: this.now().toISOString(), completedCounts: counts },
    });
  }

  private async retireProvenAbandonedLeases(): Promise<void> {
    const state = await this.read();
    if (state.writerLeases.length === 0) return;
    const current = await this.dependencies.arbitration.getRuntimeOwner();
    if (current.platform === 'unsupported') throw new PrivacyEngineError('unsupported_owner');
    let keep: PrivacyWriterLease[] = [];
    if (current.platform === 'web') {
      // The exclusive web cleanup lock proves callbacks protected by the shared writer lock have ended.
      keep = state.writerLeases.filter((lease) => lease.owner.platform !== 'web');
    } else {
      if (!current.processLaunchId || current.bundleIdentifier !== 'com.still.voiceassistant') throw new PrivacyEngineError('unsupported_owner');
      keep = state.writerLeases.filter((lease) => lease.owner.platform !== 'ios' ||
        !lease.owner.processLaunchId || lease.owner.bundleIdentifier !== 'com.still.voiceassistant' ||
        (lease.owner.processLaunchId === current.processLaunchId && !this.hasSettledLeaseProof(lease)));
    }
    if (keep.length === state.writerLeases.length) throw new PrivacyEngineError('blocked');
    await this.write(state, { ...state, writerLeases: keep });
    const keptIds = new Set(keep.map((lease) => lease.id));
    for (const id of this.settledLeaseProofs.keys()) if (!keptIds.has(id)) this.settledLeaseProofs.delete(id);
  }

  private hasSettledLeaseProof(lease: PrivacyWriterLease): boolean {
    const proof = this.settledLeaseProofs.get(lease.id);
    return !!proof && proof.id === lease.id && proof.epoch === lease.epoch && proof.kind === lease.kind &&
      proof.namespace === lease.namespace && proof.createdAt === lease.createdAt &&
      proof.owner.platform === lease.owner.platform && proof.owner.runtimeId === lease.owner.runtimeId &&
      proof.owner.processLaunchId === lease.owner.processLaunchId && proof.owner.bundleIdentifier === lease.owner.bundleIdentifier;
  }

  private async read(): Promise<PrivacyControlState> {
    try {
      return validatePrivacyControlState(await this.dependencies.controlStore.read());
    } catch {
      throw new PrivacyEngineError('corrupt_state');
    }
  }

  private async update(change: (state: PrivacyControlState) => PrivacyControlState): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const state = await this.read();
      const changed = change(state);
      if (changed === state) return;
      const next = validatePrivacyControlState({ ...changed, revision: this.uuid() });
      try {
        await this.dependencies.controlStore.compareAndSwap(state.revision, next);
        return;
      } catch (error) {
        if (!isConflict(error) || attempt + 1 >= MAX_CAS_ATTEMPTS) throw isConflict(error) ? new PrivacyEngineError('revision_conflict') : error;
      }
    }
  }

  private async write(state: PrivacyControlState, changed: PrivacyControlState): Promise<PrivacyControlState> {
    const next = validatePrivacyControlState({ ...changed, revision: this.uuid() });
    try {
      await this.dependencies.controlStore.compareAndSwap(state.revision, next);
      return next;
    } catch (error) {
      if (isConflict(error)) throw new PrivacyEngineError('revision_conflict');
      throw error;
    }
  }

  private assertWritable(state: PrivacyControlState): void {
    if (state.cleanup && state.cleanup.status !== 'complete') throw new PrivacyEngineError('cleanup_in_progress');
  }

  private assertNoCleanup(state: PrivacyControlState): void {
    if (state.cleanup && state.cleanup.status !== 'complete') throw new PrivacyEngineError('cleanup_in_progress');
  }

  private phaseFor(state: PrivacyControlState, ownershipVerified: boolean): PrivacyPublicStatus['phase'] {
    if (state.cleanup?.status === 'complete' && state.ownedNamespaces.length === 0 && state.oauthTokenRefs.length === 0 &&
        state.legacyMarkdownPaths.length === 0 && state.writerLeases.length === 0) return 'complete';
    if (state.cleanup?.status === 'paused') return 'paused';
    if (state.cleanup?.status === 'erasing') return 'erasing';
    if (!ownershipVerified) return 'blocked';
    if (state.writerLeases.length > 0) return 'writer_active';
    return 'ready';
  }

  private now(): Date { return (this.dependencies.now ?? (() => new Date()))(); }
  private uuid(): string { return (this.dependencies.uuid ?? randomUuid)().toLowerCase(); }
}

function registerDescriptor(state: PrivacyControlState, descriptor: PrivacyWriterDescriptor): PrivacyControlState {
  const ownedNamespaces = descriptor.namespace && !state.ownedNamespaces.includes(descriptor.namespace)
    ? [...state.ownedNamespaces, descriptor.namespace]
    : state.ownedNamespaces;
  if (ownedNamespaces.length > PRIVACY_CONTROL_LIMITS.namespaces) throw new PrivacyEngineError('capacity');
  const oauthTokenRefs = descriptor.oauthTokenRef && !state.oauthTokenRefs.includes(descriptor.oauthTokenRef)
    ? [...state.oauthTokenRefs, descriptor.oauthTokenRef]
    : state.oauthTokenRefs;
  if (oauthTokenRefs.length > PRIVACY_CONTROL_LIMITS.oauthTokenRefs) throw new PrivacyEngineError('capacity');
  const legacyMarkdownPaths = descriptor.legacyMarkdownPath && !state.legacyMarkdownPaths.includes(descriptor.legacyMarkdownPath)
    ? [...state.legacyMarkdownPaths, descriptor.legacyMarkdownPath]
    : state.legacyMarkdownPaths;
  if (legacyMarkdownPaths.length > PRIVACY_CONTROL_LIMITS.legacyMarkdownPaths) throw new PrivacyEngineError('capacity');
  if (ownedNamespaces === state.ownedNamespaces && oauthTokenRefs === state.oauthTokenRefs && legacyMarkdownPaths === state.legacyMarkdownPaths) return state;
  return { ...state, ownedNamespaces, oauthTokenRefs, legacyMarkdownPaths };
}

function cloneLease(lease: PrivacyWriterLease): PrivacyWriterLease {
  return { ...lease, owner: { ...lease.owner } };
}

function snapshotDescriptor(descriptor: PrivacyWriterDescriptor): PrivacyWriterDescriptor {
  return Object.freeze({ ...descriptor });
}

function sameLease(left: PrivacyWriterLease, right: PrivacyWriterLease): boolean {
  return left.id === right.id && left.epoch === right.epoch && left.kind === right.kind && left.namespace === right.namespace &&
    left.createdAt === right.createdAt && left.owner.platform === right.owner.platform && left.owner.runtimeId === right.owner.runtimeId &&
    left.owner.processLaunchId === right.owner.processLaunchId && left.owner.bundleIdentifier === right.owner.bundleIdentifier;
}

function isConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'conflict';
}

function targetsFor(state: PrivacyControlState): PrivacyCleanupTarget[] {
  return [
    ...PRIVACY_NAMESPACES.map((namespace): PrivacyCleanupTarget => ({ kind: 'namespace', namespace })),
    ...state.oauthTokenRefs.map((tokenRef): PrivacyCleanupTarget => ({ kind: 'oauth_token', tokenRef })),
    ...state.legacyMarkdownPaths.map((path): PrivacyCleanupTarget => ({ kind: 'legacy_markdown', path })),
  ];
}

function validateDescriptorIntent(descriptor: PrivacyWriterDescriptor): void {
  const hasToken = descriptor.oauthTokenRef !== undefined;
  const hasPath = descriptor.legacyMarkdownPath !== undefined;
  const expectedNamespace: Partial<Record<PrivacyWriterDescriptor['kind'], PrivacyNamespace | readonly PrivacyNamespace[]>> = {
    app_state: 'state_database',
    audio_capture: ['browser_audio', 'native_recordings'],
    recording_recovery: 'recovery_audio',
    speech_upload: 'speech_staging',
    picker_cache: 'picker_cache',
    markdown_mirror: 'markdown_mirrors',
    internal_export: 'internal_export',
    provider_credential: 'provider_credentials',
    notification: 'notifications',
  };
  const expected = expectedNamespace[descriptor.kind];
  if (!expected || !descriptor.namespace || (Array.isArray(expected) ? !expected.includes(descriptor.namespace) : expected !== descriptor.namespace)) {
    throw new PrivacyEngineError('blocked');
  }
  if (descriptor.kind === 'provider_credential') {
    if (hasPath || (hasToken && !UUID_PATTERN.test(descriptor.oauthTokenRef!))) {
      throw new PrivacyEngineError('blocked');
    }
  } else if (descriptor.kind === 'markdown_mirror') {
    if (hasToken || !hasPath || !validMarkdownPath(descriptor.legacyMarkdownPath!)) {
      throw new PrivacyEngineError('blocked');
    }
  } else if (hasToken || hasPath) {
    throw new PrivacyEngineError('blocked');
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validMarkdownPath(path: string): boolean {
  return path.length > 0 && path.length <= 1_024 && hasWellFormedUnicode(path) && new TextEncoder().encode(path).byteLength <= 1_024 && path.endsWith('.md') && !/[\\:?#%<>|"*\u0000-\u001f\u007f]/.test(path) &&
    !path.startsWith('/') && !path.endsWith('/') &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !/[. ]$/.test(segment));
}

function hasWellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function isVerifiedWriterOwner(owner: PrivacyWriterLease['owner']): boolean {
  if (!UUID_PATTERN.test(owner.runtimeId) || owner.runtimeId !== owner.runtimeId.toLowerCase()) return false;
  if (owner.platform === 'web') return owner.processLaunchId === undefined && owner.bundleIdentifier === undefined;
  return owner.platform === 'ios' && !!owner.processLaunchId && UUID_PATTERN.test(owner.processLaunchId) &&
    owner.processLaunchId === owner.processLaunchId.toLowerCase() && owner.bundleIdentifier === 'com.still.voiceassistant';
}

function targetKey(target: PrivacyCleanupTarget): string {
  switch (target.kind) {
    case 'namespace': return `n:${target.namespace}`;
    case 'oauth_token': return `o:${target.tokenRef}`;
    case 'legacy_markdown': return `m:${target.path}`;
  }
}

function manifestProjection(state: PrivacyControlState): string {
  return JSON.stringify(targetsFor(state).map(targetKey).sort());
}

const CLEANUP_CATEGORIES: readonly PrivacyCleanupCategory[] = [
  'notes_context', 'action_history_recovery', 'recordings_caches', 'credentials', 'notifications',
];

function categoryStatesFor(cleanup: NonNullable<PrivacyControlState['cleanup']>): Record<PrivacyCleanupCategory, 'pending' | 'verified' | 'paused'> {
  if (cleanup.status === 'complete') return {
    notes_context: 'verified', action_history_recovery: 'verified', recordings_caches: 'verified',
    credentials: 'verified', notifications: 'verified',
  };
  const belongs = (category: PrivacyCleanupCategory, target: PrivacyCleanupTarget): boolean => {
    if (target.kind === 'legacy_markdown') return category === 'notes_context';
    if (target.kind === 'oauth_token') return category === 'credentials';
    switch (target.namespace) {
      case 'state_database': return category === 'notes_context' || category === 'action_history_recovery';
      case 'markdown_mirrors': case 'internal_export': return category === 'notes_context';
      case 'browser_audio': case 'native_recordings': case 'recovery_audio': case 'speech_staging': case 'picker_cache': return category === 'recordings_caches';
      case 'provider_credentials': return category === 'credentials';
      case 'notifications': return category === 'notifications';
    }
  };
  const out = {} as Record<PrivacyCleanupCategory, 'pending' | 'verified' | 'paused'>;
  for (const category of CLEANUP_CATEGORIES) {
    const steps = cleanup.steps.filter((step) => belongs(category, step.target));
    if (steps.length > 0 && steps.every((step) => step.status === 'complete')) out[category] = 'verified';
    else if (cleanup.status === 'paused' || steps.some((step) => step.status === 'failed')) out[category] = 'paused';
    else out[category] = 'pending';
  }
  return out;
}

function removeManifestTarget(state: PrivacyControlState, target: PrivacyCleanupTarget): Pick<PrivacyControlState, 'ownedNamespaces' | 'oauthTokenRefs' | 'legacyMarkdownPaths'> {
  switch (target.kind) {
    case 'namespace': return { ownedNamespaces: state.ownedNamespaces.filter((value) => value !== target.namespace), oauthTokenRefs: state.oauthTokenRefs, legacyMarkdownPaths: state.legacyMarkdownPaths };
    case 'oauth_token': return { ownedNamespaces: state.ownedNamespaces, oauthTokenRefs: state.oauthTokenRefs.filter((value) => value !== target.tokenRef), legacyMarkdownPaths: state.legacyMarkdownPaths };
    case 'legacy_markdown': return { ownedNamespaces: state.ownedNamespaces, oauthTokenRefs: state.oauthTokenRefs, legacyMarkdownPaths: state.legacyMarkdownPaths.filter((value) => value !== target.path) };
  }
}

function remaining(steps: PrivacyCleanupStep[]): number {
  return steps.filter((step) => step.status !== 'complete').length;
}

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
