import type { DurableKernel, JsonValue, OwnedWorkspaceIdentity } from './kernel.js';
import { CommandJournal, type CommandAdmission, type CommandTicketContext } from './commandJournal.js';
import { ServerWorkspaceStore } from './workspaceStore.js';

export interface WorkspaceController {
  load(): Promise<void>;
  disposeForPrivacy?(): Promise<void>;
}

export interface WorkspaceRuntimeContext<TState extends object = Record<string, unknown>> {
  readonly identity: OwnedWorkspaceIdentity;
  readonly store: ServerWorkspaceStore<TState>;
  readonly journal: CommandJournal;
}

export type WorkspaceControllerFactory<C extends WorkspaceController, TState extends object = Record<string, unknown>> = (context: WorkspaceRuntimeContext<TState>) => C | Promise<C>;

interface WorkspaceEntry<C extends WorkspaceController, TState extends object> {
  readonly identity: Pick<OwnedWorkspaceIdentity, 'workspaceId' | 'ownerId' | 'privacyEpoch'>;
  readonly store: ServerWorkspaceStore<TState>;
  readonly controllerPromise: Promise<C>;
  readonly runtimeSessionToken: string;
  activeWork: number;
  closing: boolean;
  closingPromise: Promise<void> | undefined;
}

export type RuntimeSessionResolver = (identity: OwnedWorkspaceIdentity) => string;

/** One loaded shared controller per authenticated workspace for this server process. */
export class WorkspaceRegistry<C extends WorkspaceController, TState extends object = Record<string, unknown>> {
  private readonly entries = new Map<string, WorkspaceEntry<C, TState>>();
  private accepting = true;
  private disposeAllPromise: Promise<void> | undefined;

  constructor(
    private readonly kernel: DurableKernel,
    private readonly journal: CommandJournal,
    private readonly runtimeSessionFor: RuntimeSessionResolver,
    private readonly createController: WorkspaceControllerFactory<C, TState>,
  ) {
  }

  async get(admissionSessionToken: string): Promise<{ controller: C; store: ServerWorkspaceStore<TState> }> {
    for (;;) {
      if (!this.accepting) throw new Error('The workspace registry is closing.');
      const identity = this.kernel.getOwnedIdentity(admissionSessionToken);
      const runtimeSessionToken = this.runtimeSessionFor(identity);
      if (typeof runtimeSessionToken !== 'string' || !runtimeSessionToken) throw new Error('The trusted workspace runtime session is unavailable.');
      const runtimeIdentity = this.kernel.getOwnedIdentity(runtimeSessionToken);
      if (runtimeIdentity.workspaceId !== identity.workspaceId || runtimeIdentity.ownerId !== identity.ownerId ||
        runtimeIdentity.privacyEpoch !== identity.privacyEpoch) throw new Error('The current session does not match the private workspace runtime.');
      let entry = this.entries.get(identity.workspaceId);
      if (entry && (entry.identity.ownerId !== identity.ownerId || entry.identity.privacyEpoch !== identity.privacyEpoch)) {
        if (entry.activeWork > 0) throw new Error('The previous workspace runtime still has active work.');
        await this.closeEntry(entry);
        continue;
      }
      if (entry?.closing) {
        if (!entry.closingPromise) throw new Error('The previous workspace runtime is fenced pending an explicit disposal retry.');
        await entry.closingPromise;
        continue;
      }
      if (!entry) {
        const store = new ServerWorkspaceStore<TState>({ kernel: this.kernel, sessionToken: runtimeSessionToken, journal: this.journal });
        const identityBinding = Object.freeze({ workspaceId: identity.workspaceId, ownerId: identity.ownerId, privacyEpoch: identity.privacyEpoch });
        const pending = {} as WorkspaceEntry<C, TState>;
        const controllerPromise = Promise.resolve(this.createController({ identity, store, journal: this.journal })).then(async (controller) => {
          await controller.load();
          return controller;
        }).catch((error) => {
          if (this.entries.get(identity.workspaceId) === pending) this.entries.delete(identity.workspaceId);
          throw error;
        });
        Object.assign(pending, { identity: identityBinding, store, controllerPromise, runtimeSessionToken, activeWork: 0, closing: false });
        entry = pending;
        this.entries.set(identity.workspaceId, entry);
      }
      if (entry.identity.ownerId !== identity.ownerId || entry.identity.privacyEpoch !== identity.privacyEpoch) {
        throw new Error('Workspace runtime ownership changed during controller lookup.');
      }
      const controller = await entry.controllerPromise;
      // An async load can overlap disposal. Never hand out an entry that started
      // closing while this lookup awaited its controller initialization.
      if (entry.closing || this.entries.get(identity.workspaceId) !== entry) {
        await entry.closingPromise;
        continue;
      }
      return Object.freeze({ controller, store: entry.store });
    }
  }

  private closeEntry(entry: WorkspaceEntry<C, TState>): Promise<void> {
    if (entry.closingPromise) return entry.closingPromise;
    if (entry.activeWork > 0) throw new Error('Workspace runtime has active work and cannot be disposed.');
    entry.closing = true;
    const attempt = Promise.resolve().then(async () => {
      const controller = await entry.controllerPromise;
      await controller.disposeForPrivacy?.();
      if (this.entries.get(entry.identity.workspaceId) === entry) this.entries.delete(entry.identity.workspaceId);
    });
    entry.closingPromise = attempt;
    void attempt.catch(() => {
      // Keep the entry fenced, but allow its owner to retry disposal of this exact entry.
      if (entry.closingPromise === attempt) entry.closingPromise = undefined;
    });
    return attempt;
  }

  async execute<T>(input: {
    admissionSessionToken: string;
    expectedRevision: number;
    expectedPrivacyEpoch: number;
    idempotencyKey: string;
    kind: string;
    canonicalBody: string;
  }, operation: (controller: C) => Promise<T>, projectReceipt: (result: T) => JsonValue): Promise<{ admission: CommandAdmission; result?: T }> {
    let runtime: { controller: C; store: ServerWorkspaceStore<TState> };
    let entry: WorkspaceEntry<C, TState>;
    for (;;) {
      runtime = await this.get(input.admissionSessionToken);
      const identity = runtime.store.getOwnedIdentity();
      const current = this.entries.get(identity.workspaceId);
      if (!current) continue;
      if (current.closing) {
        await current.closingPromise;
        continue;
      }
      if (current.store !== runtime.store) continue;
      // Reserve the exact entry before the next await so disposal cannot slip
      // between lookup and durable command admission.
      current.activeWork += 1;
      entry = current;
      break;
    }
    try {
      const admission = this.journal.admit(input);
      if (!admission.fresh || !admission.ticket) return Object.freeze({ admission });
      const ticket: CommandTicketContext = Object.freeze({ ...admission.ticket, runtimeSessionToken: entry.runtimeSessionToken });
      const result = await this.journal.run(admission.ticket, entry.runtimeSessionToken, () => operation(runtime.controller));
      try { this.journal.finish(ticket, projectReceipt(result)); }
      catch (error) { this.journal.requireInspection(ticket); throw error; }
      return Object.freeze({ admission, result });
    } finally {
      entry.activeWork = Math.max(0, entry.activeWork - 1);
    }
  }

  getRuntimeCount(): number { return this.entries.size; }

  /** TRUSTED INTERNAL ONLY. Call after the owner has drained all lookups and commands. */
  disposeAll(): Promise<void> {
    if (this.disposeAllPromise) return this.disposeAllPromise;
    if ([...this.entries.values()].some((entry) => entry.activeWork > 0)) {
      throw new Error('Workspace registry has active work and cannot be disposed.');
    }
    this.accepting = false;
    const entries = [...this.entries.values()];
    const attempts = entries.map((entry) => this.closeEntry(entry));
    const disposal = Promise.allSettled(attempts).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'One or more workspace runtimes could not be disposed.');
    });
    this.disposeAllPromise = disposal;
    void disposal.catch(() => {
      if (this.disposeAllPromise === disposal) this.disposeAllPromise = undefined;
    });
    return disposal;
  }

  async disposeWorkspace(admissionSessionToken: string): Promise<void> {
    const identity = this.kernel.getOwnedIdentity(admissionSessionToken);
    const entry = this.entries.get(identity.workspaceId);
    if (!entry || entry.identity.ownerId !== identity.ownerId || entry.identity.privacyEpoch !== identity.privacyEpoch) return;
    if (entry.activeWork > 0) throw new Error('Workspace runtime has active work and cannot be disposed.');
    await this.closeEntry(entry);
  }
}

export function createWorkspaceRegistry<C extends WorkspaceController, TState extends object = Record<string, unknown>>(kernel: DurableKernel,
  journal: CommandJournal, runtimeSessionFor: RuntimeSessionResolver, factory: WorkspaceControllerFactory<C, TState>): WorkspaceRegistry<C, TState> {
  return new WorkspaceRegistry<C, TState>(kernel, journal, runtimeSessionFor, factory);
}
