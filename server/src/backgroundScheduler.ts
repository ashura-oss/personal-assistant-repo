export const BACKGROUND_SCHEDULER_PAGE_MAX = 100;
export const BACKGROUND_SCHEDULER_MIN_PACING_MS = 1_000;
export const BACKGROUND_SCHEDULER_RECONCILE_MS = 60_000;
export const BACKGROUND_SCHEDULER_MAX_TIMER_MS = 2_147_000_000;
const READ_BACKOFF_BASE_MS = 1_000;
const READ_BACKOFF_MAX_MS = 5 * 60_000;
const WORK_LANES = Object.freeze(['account_sync', 'period_summary', 'proactive_draft', 'approved_reminder_delivery', 'batch_observation'] as const);

export type BackgroundSchedulerLane = typeof WORK_LANES[number];
export type BackgroundSchedulerLifecycle = 'running' | 'stopping' | 'drained';
declare const backgroundSchedulerClaimBrand: unique symbol;
export interface BackgroundSchedulerClaim { readonly [backgroundSchedulerClaimBrand]: true }
export interface BackgroundSchedulerWork {
  readonly workspaceId: string;
  readonly workId: string;
  readonly lane: BackgroundSchedulerLane;
  readonly dueAt: number;
}
export interface BackgroundSchedulerExecutionResult {
  readonly kind: 'terminal' | 'inspect_required' | 'deferred';
  readonly code: string;
  readonly nextDueAt?: number;
}
export type BackgroundSchedulerOutcome = BackgroundSchedulerExecutionResult | Readonly<{
  kind: 'held'; reason: 'stopped_before_dispatch' | 'stale_scan_before_dispatch' | 'clock_rollback_before_dispatch';
}>;

export interface BackgroundSchedulerPorts {
  /** Durable metadata only; returns the earliest due timestamp, or null when the queue is empty. */
  readNextDueAt(input: Readonly<{ now: number }>): Promise<number | null>;
  /** Keyset page of workspaces with due work. Results are closed workspace identifiers. */
  listDueWorkspaces(input: Readonly<{ now: number; afterWorkspaceId?: string; limit: number }>): Promise<readonly string[]>;
  /** Closed lanes with due work for this workspace. */
  listDueLanes(input: Readonly<{ workspaceId: string; now: number }>): Promise<readonly BackgroundSchedulerLane[]>;
  /** Keyset page of closed work metadata for one workspace and one lane. */
  listDueOccurrences(input: Readonly<{ workspaceId: string; lane: BackgroundSchedulerLane; now: number;
    afterWorkId?: string; limit: number }>): Promise<readonly BackgroundSchedulerWork[]>;
  /** DB-only atomic admission; never performs provider or HTTP work. */
  claimOccurrence(input: Readonly<{ work: BackgroundSchedulerWork; now: number }>): Promise<BackgroundSchedulerClaim | undefined>;
  /** Executes this exact private claim through the trusted runtime gateway. batch_observation is GET-only. */
  executeClaim(claim: BackgroundSchedulerClaim): Promise<BackgroundSchedulerExecutionResult>;
  /** Persists an exact, idempotent terminal/deferred/held outcome. */
  recordOutcome(claim: BackgroundSchedulerClaim, outcome: BackgroundSchedulerOutcome): Promise<void>;
  /** Marks an exact dispatched claim inspect-only after an ambiguous execution failure. */
  reconcileAmbiguousClaim(claim: BackgroundSchedulerClaim, reason: 'execution_outcome_unknown'): Promise<void>;
  /** Holds a work item whose atomic claim acknowledgement was ambiguous. */
  reconcileUnacknowledgedClaim(work: BackgroundSchedulerWork, reason: 'claim_outcome_unknown'): Promise<void>;
}

export interface BackgroundSchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  random?(): number;
}

export interface BackgroundSchedulerOptions {
  readonly ports: BackgroundSchedulerPorts;
  readonly clock: BackgroundSchedulerClock;
  readonly minimumPacingMs?: number;
  readonly reconciliationIntervalMs?: number;
  readonly pageSize?: number;
}

interface PendingFinalization {
  readonly retry: () => Promise<void>;
}

function fail(code: string): never { throw new Error(code); }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).byteLength <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function validLane(value: unknown): value is BackgroundSchedulerLane { return typeof value === 'string' && (WORK_LANES as readonly string[]).includes(value); }
function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function copyWork(raw: unknown, workspaceId: string, lane: BackgroundSchedulerLane, now: number): BackgroundSchedulerWork {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exactKeys(raw, ['workspaceId', 'workId', 'lane', 'dueAt'])) return fail('background_scheduler_metadata_invalid');
  const item = raw as Record<string, unknown>;
  if (!validIdentifier(item.workspaceId) || item.workspaceId !== workspaceId || !validIdentifier(item.workId) ||
      !validLane(item.lane) || item.lane !== lane || !validTime(item.dueAt) || item.dueAt > now) return fail('background_scheduler_metadata_invalid');
  return Object.freeze({ workspaceId: item.workspaceId, workId: item.workId, lane: item.lane, dueAt: item.dueAt });
}
function validateExecutionResult(raw: unknown, now: number): BackgroundSchedulerExecutionResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('background_scheduler_result_invalid');
  const item = raw as Record<string, unknown>;
  if (item.kind === 'deferred') {
    if (!exactKeys(item, ['kind', 'code', 'nextDueAt']) || !validCode(item.code) || !validTime(item.nextDueAt)) return fail('background_scheduler_result_invalid');
    return Object.freeze({ kind: 'deferred', code: item.code, nextDueAt: Math.max(now, item.nextDueAt) });
  }
  if ((item.kind !== 'terminal' && item.kind !== 'inspect_required') || !exactKeys(item, ['kind', 'code']) || !validCode(item.code)) {
    return fail('background_scheduler_result_invalid');
  }
  return Object.freeze({ kind: item.kind, code: item.code });
}
function validCode(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value); }
function readRetryAfter(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !Object.hasOwn(error, 'retryAfterMs')) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

/** A single-timer, serial engine. Durable policy/claim authority remains entirely in its named ports. */
export class BackgroundScheduler {
  readonly #ports: BackgroundSchedulerPorts;
  readonly #clock: BackgroundSchedulerClock;
  readonly #minimumPacingMs: number;
  readonly #reconciliationIntervalMs: number;
  readonly #pageSize: number;
  readonly #active = new Set<Promise<void>>();
  readonly #pendingFinalizations: PendingFinalization[] = [];
  readonly #laneCursor = new Map<string, BackgroundSchedulerLane>();
  readonly #workCursor = new Map<string, string>();
  #state: BackgroundSchedulerLifecycle = 'running';
  #started = false;
  #generation = 0;
  #timer: unknown;
  #timerArmed = false;
  #scanActive = false;
  #wakePending = false;
  #workspaceCursor: string | undefined;
  #readFailures = 0;
  #retryNotBefore = 0;
  #drainPromise: Promise<void> | undefined;

  constructor(options: BackgroundSchedulerOptions) {
    const methods: (keyof BackgroundSchedulerPorts)[] = ['readNextDueAt', 'listDueWorkspaces', 'listDueLanes', 'listDueOccurrences',
      'claimOccurrence', 'executeClaim', 'recordOutcome', 'reconcileAmbiguousClaim', 'reconcileUnacknowledgedClaim'];
    if (!options || !options.ports || methods.some((method) => typeof options.ports[method] !== 'function') ||
        !options.clock || typeof options.clock.now !== 'function' || typeof options.clock.setTimeout !== 'function' || typeof options.clock.clearTimeout !== 'function') {
      throw new TypeError('background_scheduler_options_invalid');
    }
    this.#ports = options.ports;
    this.#clock = options.clock;
    this.#minimumPacingMs = options.minimumPacingMs ?? BACKGROUND_SCHEDULER_MIN_PACING_MS;
    this.#reconciliationIntervalMs = options.reconciliationIntervalMs ?? BACKGROUND_SCHEDULER_RECONCILE_MS;
    this.#pageSize = options.pageSize ?? BACKGROUND_SCHEDULER_PAGE_MAX;
    if (!validTime(this.#minimumPacingMs) || this.#minimumPacingMs < BACKGROUND_SCHEDULER_MIN_PACING_MS || !validTime(this.#reconciliationIntervalMs) ||
        this.#reconciliationIntervalMs < this.#minimumPacingMs || !Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 ||
        this.#pageSize > BACKGROUND_SCHEDULER_PAGE_MAX) throw new TypeError('background_scheduler_options_invalid');
  }

  get lifecycle(): BackgroundSchedulerLifecycle { return this.#state; }

  start(): void {
    if (this.#state !== 'running') return;
    if (this.#started) return;
    this.#started = true;
    this.#armAt(this.#readClock());
  }

  /** Coalesces wakeups into the active scan or the one pending timer. */
  wake(): void {
    if (this.#state !== 'running') return;
    this.#generation += 1;
    this.#wakePending = true;
    if (!this.#started) { this.start(); return; }
    if (this.#scanActive) return;
    this.#clearTimer();
    this.#wakePending = false;
    this.#armAt(this.#readClock());
  }

  /** Synchronous admission fence; any awaited claim returned later is durably held, never dispatched. */
  stopAdmission(): void {
    if (this.#state !== 'running') return;
    this.#state = 'stopping';
    this.#generation += 1;
    this.#wakePending = false;
    this.#clearTimer();
  }

  /** Waits for owned work and exact pending finalization. Failed finalization remains retryable by a later drain. */
  drainAndDispose(): Promise<void> {
    this.stopAdmission();
    if (this.#drainPromise) return this.#drainPromise;
    if (this.#state === 'drained') return Promise.resolve();
    // Defer the inner operation one microtask so same-turn callers share this
    // exact promise even when there is no outstanding work to await.
    const draining = Promise.resolve().then(() => this.#drain());
    this.#drainPromise = draining;
    // A failed drain keeps its durable pending stages and becomes explicitly
    // retryable. Successful drains retain their resolved promise for callers.
    void draining.catch(() => { if (this.#drainPromise === draining) this.#drainPromise = undefined; });
    return draining;
  }

  async #drain(): Promise<void> {
    while (this.#active.size > 0) await Promise.allSettled([...this.#active]);
    while (this.#pendingFinalizations.length > 0) {
      const pending = this.#pendingFinalizations[0]!;
      try { await pending.retry(); }
      catch { throw new Error('background_scheduler_drain_incomplete'); }
      this.#pendingFinalizations.shift();
    }
    if (this.#active.size > 0 || this.#pendingFinalizations.length > 0) throw new Error('background_scheduler_drain_incomplete');
    this.#state = 'drained';
  }

  #readClock(): number {
    const value = this.#clock.now();
    if (!validTime(value)) return fail('background_scheduler_clock_invalid');
    // Persisted due times are wall-clock UTC. Never pass a monotonic maximum to
    // durable ports: after a clock rollback that could admit future work early.
    return value;
  }

  #armAt(at: number): void {
    if (this.#state !== 'running' || !this.#started) return;
    this.#clearTimer();
    const now = this.#readClock();
    const delay = Math.min(BACKGROUND_SCHEDULER_MAX_TIMER_MS, Math.max(0, Math.max(at, this.#retryNotBefore) - now));
    this.#timerArmed = true;
    const generation = this.#generation;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timerArmed = false;
      this.#timer = undefined;
      if (this.#state !== 'running') return;
      if (this.#readClock() < this.#retryNotBefore) {
        this.#armAt(this.#retryNotBefore);
        return;
      }
      this.#launchScan(generation);
    }, delay);
  }

  #clearTimer(): void {
    if (!this.#timerArmed) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timerArmed = false;
    this.#timer = undefined;
  }

  #launchScan(generation: number): void {
    if (this.#state !== 'running' || this.#scanActive) return;
    this.#scanActive = true;
    const task = this.#scan(generation).catch((error: unknown) => {
      if (this.#state === 'running') this.#armAt(this.#readClock() + this.#metadataFailure(error));
    })
      .finally(() => {
        this.#scanActive = false;
        this.#active.delete(task);
        if (this.#state !== 'running') return;
        if (this.#wakePending || generation !== this.#generation) {
          this.#wakePending = false;
          this.#armAt(this.#readClock());
        }
      });
    this.#active.add(task);
  }

  #current(generation: number): boolean { return this.#state === 'running' && generation === this.#generation; }

  #metadataFailure(error: unknown): number {
    this.#readFailures = Math.min(this.#readFailures + 1, 20);
    const exponential = Math.min(READ_BACKOFF_MAX_MS, READ_BACKOFF_BASE_MS * (2 ** Math.min(this.#readFailures - 1, 18)));
    const random = this.#clock.random?.() ?? 0.5;
    const jitter = Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0.5));
    const jittered = Math.round(exponential * (0.75 + jitter * 0.5));
    const delay = Math.max(jittered, readRetryAfter(error) ?? 0);
    const retryAt = this.#readClock() + delay;
    this.#retryNotBefore = Math.max(this.#retryNotBefore, Number.isSafeInteger(retryAt) ? retryAt : Number.MAX_SAFE_INTEGER);
    return delay;
  }

  async #scan(generation: number): Promise<void> {
    if (!this.#current(generation) || this.#pendingFinalizations.length > 0) return;
    const now = this.#readClock();
    let retryDelay: number | undefined;
    let nextDueAt: number | null;
    try { nextDueAt = await this.#ports.readNextDueAt({ now }); }
    catch (error) { retryDelay = this.#metadataFailure(error); this.#armAt(this.#readClock() + retryDelay); return; }
    if (!this.#current(generation)) return;
    if (nextDueAt !== null && !validTime(nextDueAt)) return fail('background_scheduler_metadata_invalid');
    const reconcileAt = now + this.#reconciliationIntervalMs;
    if (nextDueAt === null || nextDueAt > now) {
      this.#metadataSucceeded();
      this.#armAt(Math.min(nextDueAt ?? reconcileAt, reconcileAt));
      return;
    }

    let work: BackgroundSchedulerWork | undefined;
    try { work = await this.#findDueWork(now, generation); }
    catch (error) { retryDelay = this.#metadataFailure(error); this.#armAt(this.#readClock() + retryDelay); return; }
    this.#metadataSucceeded();
    if (!this.#current(generation)) return;
    if (!work) { this.#armAt(this.#readClock() + this.#minimumPacingMs); return; }

    const claimNow = this.#readClock();
    if (work.dueAt > claimNow) {
      this.#armAt(work.dueAt);
      return;
    }

    let claim: BackgroundSchedulerClaim | undefined;
    try { claim = await this.#ports.claimOccurrence(Object.freeze({ work, now: claimNow })); }
    catch {
      const pending: PendingFinalization = { retry: () => this.#ports.reconcileUnacknowledgedClaim(work!, 'claim_outcome_unknown') };
      try { await pending.retry(); }
      catch { this.#pendingFinalizations.push(pending); }
      if (this.#pendingFinalizations.length === 0) await this.#armFromDurableDue();
      return;
    }
    const dispatchNow = this.#readClock();
    if (!this.#current(generation) || work.dueAt > dispatchNow) {
      const reason = this.#state === 'stopping' ? 'stopped_before_dispatch'
        : !this.#current(generation) ? 'stale_scan_before_dispatch' : 'clock_rollback_before_dispatch';
      if (claim) await this.#recordOrRetain(claim, Object.freeze({ kind: 'held', reason }));
      if (this.#state === 'running') this.#armAt(work.dueAt > dispatchNow ? work.dueAt : dispatchNow + this.#minimumPacingMs);
      return;
    }
    if (!claim) { this.#armAt(this.#readClock() + this.#minimumPacingMs); return; }

    let outcome: BackgroundSchedulerOutcome;
    try { outcome = validateExecutionResult(await this.#ports.executeClaim(claim), this.#readClock()); }
    catch {
      const pending: PendingFinalization = { retry: () => this.#ports.reconcileAmbiguousClaim(claim!, 'execution_outcome_unknown') };
      try { await pending.retry(); }
      catch { this.#pendingFinalizations.push(pending); }
      if (this.#state === 'running' && this.#pendingFinalizations.length === 0) await this.#armFromDurableDue();
      return;
    }
    const persisted = await this.#recordOrRetain(claim, outcome);
    if (persisted && this.#state === 'running') await this.#armFromDurableDue();
  }

  async #recordOrRetain(claim: BackgroundSchedulerClaim, outcome: BackgroundSchedulerOutcome): Promise<boolean> {
    const pending: PendingFinalization = { retry: () => this.#ports.recordOutcome(claim, outcome) };
    try { await pending.retry(); return true; }
    catch { this.#pendingFinalizations.push(pending); return false; }
  }

  async #armFromDurableDue(): Promise<void> {
    if (this.#state !== 'running' || this.#pendingFinalizations.length > 0) return;
    const now = this.#readClock();
    let nextDueAt: number | null;
    try {
      nextDueAt = await this.#ports.readNextDueAt({ now });
      if (nextDueAt !== null && !validTime(nextDueAt)) throw new Error('background_scheduler_metadata_invalid');
    } catch (error) {
      if (this.#state === 'running') this.#armAt(this.#readClock() + this.#metadataFailure(error));
      return;
    }
    if (this.#state !== 'running') return;
    const fallback = now + this.#reconciliationIntervalMs;
    const paceFloor = now + this.#minimumPacingMs;
    this.#armAt(Math.max(paceFloor, Math.min(nextDueAt ?? fallback, fallback)));
  }

  #metadataSucceeded(): void {
    this.#readFailures = 0;
    this.#retryNotBefore = 0;
  }

  async #findDueWork(now: number, generation: number): Promise<BackgroundSchedulerWork | undefined> {
    let workspaces = await this.#ports.listDueWorkspaces({ now, ...(this.#workspaceCursor ? { afterWorkspaceId: this.#workspaceCursor } : {}), limit: this.#pageSize });
    if (!Array.isArray(workspaces) || workspaces.length > this.#pageSize || workspaces.some((id) => !validIdentifier(id)) || new Set(workspaces).size !== workspaces.length ||
        workspaces.some((id, index) => index > 0 && workspaces[index - 1]! >= id)) {
      return fail('background_scheduler_metadata_invalid');
    }
    if (workspaces.length === 0 && this.#workspaceCursor) {
      workspaces = await this.#ports.listDueWorkspaces({ now, limit: this.#pageSize });
      if (!Array.isArray(workspaces) || workspaces.length > this.#pageSize || workspaces.some((id) => !validIdentifier(id)) || new Set(workspaces).size !== workspaces.length ||
          workspaces.some((id, index) => index > 0 && workspaces[index - 1]! >= id)) {
        return fail('background_scheduler_metadata_invalid');
      }
    }
    for (const workspaceId of workspaces) {
      if (!this.#current(generation)) return undefined;
      this.#workspaceCursor = workspaceId;
      const rawLanes = await this.#ports.listDueLanes({ workspaceId, now });
      const lanes = Array.isArray(rawLanes) ? rawLanes : [];
      if (!Array.isArray(rawLanes) || lanes.length > WORK_LANES.length || lanes.some((lane) => !validLane(lane)) || new Set(lanes).size !== lanes.length) {
        return fail('background_scheduler_metadata_invalid');
      }
      if (!lanes.length) continue;
      const priorLane = this.#laneCursor.get(workspaceId);
      const normalizedLanes = WORK_LANES.filter((lane) => lanes.includes(lane));
      const start = priorLane ? (normalizedLanes.indexOf(priorLane) + 1) % normalizedLanes.length : 0;
      const ordered = [...normalizedLanes.slice(start), ...normalizedLanes.slice(0, start)];
      for (const lane of ordered) {
        if (!this.#current(generation)) return undefined;
        const key = `${workspaceId}\u0000${lane}`;
        const cursor = this.#workCursor.get(key);
        let items = await this.#ports.listDueOccurrences({ workspaceId, lane, now, ...(cursor ? { afterWorkId: cursor } : {}), limit: 1 });
        if (!Array.isArray(items) || items.length > 1) return fail('background_scheduler_metadata_invalid');
        if (!items.length && cursor) items = await this.#ports.listDueOccurrences({ workspaceId, lane, now, limit: 1 });
        if (items.length === 0) continue;
        const copied = copyWork(items[0], workspaceId, lane, now);
        this.#laneCursor.set(workspaceId, lane);
        this.#workCursor.set(key, copied.workId);
        return copied;
      }
    }
    return undefined;
  }
}
