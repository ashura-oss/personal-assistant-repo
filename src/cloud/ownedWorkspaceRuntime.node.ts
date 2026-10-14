import type { AppState } from '../core';
import { AppControllerImpl, type ControllerCryptoPort, type ControllerRuntimePorts } from '../services/controller.shared';
import { createWorkspaceSnapshotDTO, type WorkspaceMediaResolver, type WorkspaceSnapshotDTO } from './workspaceDto';
import type { DurableKernel, JsonValue, OwnedWorkspaceIdentity } from '../../server/src/kernel.js';
import { CommandJournal, type CommandAdmission } from '../../server/src/commandJournal.js';
import { WorkspaceControllerFactoryInitializationError, WorkspaceRegistry,
  type RuntimeSessionResolver, type WorkspaceRuntimeContext } from '../../server/src/workspaceRegistry.js';
import type { LoadedWorkspaceIdentity } from '../../server/src/workspaceStore.js';

export interface OwnedWorkspaceAdmission {
  /** Kernel-issued session for the authenticated caller. Never a workspace id supplied by a caller. */
  readonly sessionToken: string;
  /** Rechecks current authentication synchronously after each async ownership lookup. */
  readonly assertCurrent: () => void;
}

export interface OwnedWorkspaceRuntimePorts {
  readonly providers: ControllerRuntimePorts['providers'];
  readonly integration: ControllerRuntimePorts['integration'];
  readonly mediaResolver?: WorkspaceMediaResolver;
}

/** Returned resources remain factory-owned until the real controller is constructed. */
export interface OwnedWorkspaceFactoryPorts extends OwnedWorkspaceRuntimePorts {
  readonly disposeUnattached: () => void | Promise<void>;
}

interface OwnedWorkspaceRuntimeCommonOptions {
  readonly kernel: DurableKernel;
  readonly runtimeSessionFor: RuntimeSessionResolver;
  readonly crypto: ControllerCryptoPort;
}

export type OwnedWorkspaceRuntimeOptions = OwnedWorkspaceRuntimeCommonOptions & (
  | (OwnedWorkspaceRuntimePorts & { readonly workspacePortsFor?: never })
  | { readonly workspacePortsFor: (context: WorkspaceRuntimeContext<AppState>) => OwnedWorkspaceFactoryPorts | Promise<OwnedWorkspaceFactoryPorts>;
      readonly providers?: never; readonly integration?: never; readonly mediaResolver?: never }
);

export interface OwnedWorkspaceCommandInput extends OwnedWorkspaceAdmission {
  readonly expectedRevision: number;
  readonly expectedPrivacyEpoch: number;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly canonicalBody: string;
}

export interface OwnedWorkspaceCommandResult<T> {
  readonly admission: CommandAdmission;
  readonly result?: T;
  /** Present only after the durable command receipt is known and the loaded state matches the DB head. */
  readonly snapshot?: WorkspaceSnapshotDTO;
}

interface CachedWorkspaceSnapshot {
  readonly ownerId: string;
  readonly snapshot: WorkspaceSnapshotDTO;
}

/**
 * Private Node owner for one shared controller registry and journal. This is a
 * trusted module interface, not an HTTP dispatcher or caller-defined state API.
 */
export class OwnedWorkspaceRuntime {
  private readonly journal: CommandJournal;
  private readonly registry: WorkspaceRegistry<AppControllerImpl, AppState>;
  private readonly cache = new Map<string, CachedWorkspaceSnapshot>();
  private readonly mediaResolvers = new WeakMap<AppControllerImpl, WorkspaceMediaResolver>();
  private readonly refreshRequired = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: OwnedWorkspaceRuntimeOptions) {
    validateRuntimeConfiguration(options);
    this.journal = new CommandJournal(options.kernel);
    this.registry = new WorkspaceRegistry<AppControllerImpl, AppState>(options.kernel, this.journal,
      options.runtimeSessionFor, async (context) => {
        if (typeof options.workspacePortsFor !== 'function') {
          validateRuntimePorts(options);
          const controller = new AppControllerImpl({ store: context.store, crypto: options.crypto,
            providers: options.providers, integration: options.integration });
          if (options.mediaResolver) this.mediaResolvers.set(controller, options.mediaResolver);
          return controller;
        }
        const returned = await options.workspacePortsFor(context);
        const cleanup = returned && typeof returned.disposeUnattached === 'function'
          ? () => returned.disposeUnattached()
          : () => { throw new Error('workspace_runtime_port_cleanup_unavailable'); };
        try {
          if (!returned || typeof returned.disposeUnattached !== 'function') throw new TypeError('owned_workspace_runtime_ports_required');
          validateRuntimePorts(returned);
          const controller = new AppControllerImpl({ store: context.store, crypto: options.crypto,
            providers: returned.providers, integration: returned.integration });
          if (returned.mediaResolver) this.mediaResolvers.set(controller, returned.mediaResolver);
          return controller;
        } catch (error) {
          try { await cleanup(); }
          catch { throw new WorkspaceControllerFactoryInitializationError('workspace_runtime_port_cleanup_failed', cleanup); }
          throw error;
        }
      });
  }

  getSnapshot(admission: OwnedWorkspaceAdmission): Promise<WorkspaceSnapshotDTO> {
    this.assertAdmission(admission);
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (this.busy.has(identity.workspaceId)) return Promise.reject(new Error('The workspace runtime is busy.'));
    if (this.refreshRequired.has(identity.workspaceId)) return Promise.reject(new Error('workspace_refresh_required'));
    const cached = this.cache.get(identity.workspaceId);
    if (cached) {
      if (cached.ownerId !== identity.ownerId || cached.snapshot.privacyEpoch !== identity.privacyEpoch ||
          cached.snapshot.revision !== identity.revision) {
        this.cache.delete(identity.workspaceId);
        this.refreshRequired.add(identity.workspaceId);
        return Promise.reject(new Error('workspace_refresh_required'));
      }
      return Promise.resolve(cached.snapshot);
    }
    return this.track(identity.workspaceId, () => undefined, async () => {
      const runtime = await this.registry.get(admission.sessionToken);
      admission.assertCurrent();
      try { return this.projectAndCache(admission, identity, runtime.controller, runtime.store.getLoadedIdentity()); }
      catch (error) { this.refreshRequired.add(identity.workspaceId); throw error; }
    });
  }

  /** Explicitly reloads controller state after a caller-directed recovery/refresh. */
  refreshSnapshot(admission: OwnedWorkspaceAdmission): Promise<WorkspaceSnapshotDTO> {
    this.assertAdmission(admission);
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    return this.track(identity.workspaceId, () => {
      this.cache.delete(identity.workspaceId);
      this.refreshRequired.add(identity.workspaceId);
    }, async () => {
      const runtime = await this.registry.get(admission.sessionToken);
      admission.assertCurrent();
      await runtime.controller.refreshPersistedWorkspace();
      admission.assertCurrent();
      try { return this.projectAndCache(admission, identity, runtime.controller, runtime.store.getLoadedIdentity()); }
      catch (error) { this.refreshRequired.add(identity.workspaceId); throw error; }
    });
  }

  /** Explicitly retries cleanup of one fenced registry entry; it never publishes a snapshot. */
  retryFailedWorkspaceDisposal(admission: OwnedWorkspaceAdmission, expectedHeldPrivacyEpoch: number): Promise<void> {
    this.assertAdmission(admission);
    if (!Number.isSafeInteger(expectedHeldPrivacyEpoch) || expectedHeldPrivacyEpoch < 0) {
      return Promise.reject(new TypeError('workspace_disposal_epoch_required'));
    }
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    return this.track(identity.workspaceId, () => {
      this.cache.delete(identity.workspaceId);
      this.refreshRequired.add(identity.workspaceId);
    }, async () => {
      admission.assertCurrent();
      await this.registry.retryFailedDisposal({ admissionSessionToken: admission.sessionToken,
        expectedHeldPrivacyEpoch });
      admission.assertCurrent();
    });
  }

  executeCommand<T>(input: OwnedWorkspaceCommandInput,
    operation: (controller: AppControllerImpl) => Promise<T>,
    projectReceipt: (result: T) => JsonValue): Promise<OwnedWorkspaceCommandResult<T>> {
    this.assertAdmission(input);
    if (typeof operation !== 'function' || typeof projectReceipt !== 'function') throw new TypeError('trusted_command_operation_required');
    const identity = this.options.kernel.getOwnedIdentity(input.sessionToken);
    if (this.refreshRequired.has(identity.workspaceId)) return Promise.reject(new Error('workspace_refresh_required'));
    return this.track(identity.workspaceId, () => {
      this.cache.delete(identity.workspaceId);
      this.refreshRequired.add(identity.workspaceId);
    }, async () => {
      const result = await this.registry.execute({ admissionSessionToken: input.sessionToken,
        expectedRevision: input.expectedRevision, expectedPrivacyEpoch: input.expectedPrivacyEpoch,
        idempotencyKey: input.idempotencyKey, kind: input.kind, canonicalBody: input.canonicalBody }, (controller) => {
          input.assertCurrent();
          return operation(controller);
        }, projectReceipt);
      input.assertCurrent();
      if (!result.admission.fresh && result.admission.status !== 'finished') {
        return Object.freeze({ admission: result.admission });
      }
      const runtime = await this.registry.get(input.sessionToken);
      input.assertCurrent();
      const snapshot = this.projectAndCache(input, identity, runtime.controller, runtime.store.getLoadedIdentity());
      return Object.freeze({ admission: result.admission, ...(result.result === undefined ? {} : { result: result.result }), snapshot });
    });
  }

  /** Read-only receipt lookup. It deliberately bypasses busy/refresh-required state and never touches the controller. */
  inspectCommandReceipt(admission: OwnedWorkspaceAdmission, idempotencyKey: string): CommandAdmission | undefined {
    this.assertAdmission(admission);
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const result = this.journal.inspectIfExists(admission.sessionToken, idempotencyKey);
    admission.assertCurrent();
    const current = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (current.workspaceId !== identity.workspaceId || current.ownerId !== identity.ownerId || current.privacyEpoch !== identity.privacyEpoch) {
      throw new Error('workspace_ownership_changed');
    }
    return result;
  }

  /** Stops admission synchronously, drains owned promises, then disposes exact registry entries. */
  stopAdmission(): void {
    this.closing = true;
  }

  closeAfterDrain(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopAdmission();
    const closing = (async () => {
      while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
      await this.registry.disposeAll();
      this.cache.clear();
      this.refreshRequired.clear();
    })();
    this.closePromise = closing;
    void closing.catch(() => { if (this.closePromise === closing) this.closePromise = undefined; });
    return closing;
  }

  private track<T>(workspaceId: string, beforeWork: () => void, work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('The owned workspace runtime is closing.'));
    if (this.busy.has(workspaceId)) return Promise.reject(new Error('The workspace runtime is busy.'));
    this.busy.add(workspaceId);
    beforeWork();
    const pending = Promise.resolve().then(work).finally(() => {
      this.busy.delete(workspaceId);
      this.inFlight.delete(pending);
    });
    this.inFlight.add(pending);
    return pending;
  }

  private projectAndCache(admission: OwnedWorkspaceAdmission, initial: OwnedWorkspaceIdentity,
    controller: AppControllerImpl, loaded: LoadedWorkspaceIdentity): WorkspaceSnapshotDTO {
    admission.assertCurrent();
    const current = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    this.assertStillCurrent(admission, initial, loaded, current);
    const snapshot = createWorkspaceSnapshotDTO(controller, { workspaceId: loaded.workspaceId,
      privacyEpoch: loaded.privacyEpoch, revision: loaded.revision }, this.mediaResolvers.get(controller));
    admission.assertCurrent();
    const afterProjection = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    this.assertStillCurrent(admission, initial, loaded, afterProjection);
    this.cache.set(loaded.workspaceId, Object.freeze({ ownerId: loaded.ownerId, snapshot }));
    this.refreshRequired.delete(loaded.workspaceId);
    return snapshot;
  }

  private assertStillCurrent(admission: OwnedWorkspaceAdmission, initial: OwnedWorkspaceIdentity,
    loaded: LoadedWorkspaceIdentity | undefined, current: OwnedWorkspaceIdentity): void {
    if (current.ownerId !== initial.ownerId || current.workspaceId !== initial.workspaceId ||
        current.privacyEpoch !== initial.privacyEpoch) throw new Error('workspace_ownership_changed');
    if (loaded && (loaded.ownerId !== current.ownerId || loaded.workspaceId !== current.workspaceId ||
        loaded.privacyEpoch !== current.privacyEpoch || loaded.revision !== current.revision)) {
      throw new Error('workspace_loaded_revision_mismatch');
    }
    admission.assertCurrent();
  }

  private assertAdmission(admission: OwnedWorkspaceAdmission): void {
    if (!admission || typeof admission !== 'object' || typeof admission.sessionToken !== 'string' ||
        !admission.sessionToken || typeof admission.assertCurrent !== 'function') throw new TypeError('owned_workspace_admission_required');
    if (this.closing) throw new Error('The owned workspace runtime is closing.');
    admission.assertCurrent();
  }
}

function validateRuntimeConfiguration(options: OwnedWorkspaceRuntimeOptions): void {
  if (!options || !options.kernel || typeof options.runtimeSessionFor !== 'function' || !options.crypto ||
      typeof options.crypto.randomUUID !== 'function' || typeof options.crypto.sha256 !== 'function' ||
      typeof options !== 'object') {
    throw new TypeError('owned_workspace_runtime_ports_required');
  }
  const hasFactory = Object.prototype.hasOwnProperty.call(options, 'workspacePortsFor');
  const hasStaticPorts = Object.prototype.hasOwnProperty.call(options, 'providers') ||
    Object.prototype.hasOwnProperty.call(options, 'integration') || Object.prototype.hasOwnProperty.call(options, 'mediaResolver');
  if (hasFactory) {
    if (hasStaticPorts || typeof options.workspacePortsFor !== 'function') throw new TypeError('owned_workspace_runtime_ports_required');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(options, 'providers') || !Object.prototype.hasOwnProperty.call(options, 'integration')) {
    throw new TypeError('owned_workspace_runtime_ports_required');
  }
  validateRuntimePorts(options as OwnedWorkspaceRuntimePorts);
}

function validateRuntimePorts(ports: OwnedWorkspaceRuntimePorts): void {
  if (!ports || typeof ports !== 'object' || !ports.providers || !ports.providers.speech ||
      typeof ports.providers.speech.transcribe !== 'function' ||
      typeof ports.providers.speech.releaseUploadLease !== 'function' || typeof ports.providers.speech.disposeMemory !== 'function' ||
      !ports.providers.openAi || typeof ports.providers.openAi.prepare !== 'function' ||
      typeof ports.providers.openAi.analyze !== 'function' || typeof ports.providers.openAi.generateReply !== 'function' ||
      !ports.integration || typeof ports.integration.writeDocument !== 'function' ||
      typeof ports.integration.removeAudio !== 'function' || typeof ports.integration.loadRecordingRecovery !== 'function' ||
      typeof ports.integration.bindRecordingRecovery !== 'function' || !ports.integration.reminderBackend ||
      !ports.integration.mailAlertBackend || !ports.integration.deviceCalendarBackend ||
      (ports.mediaResolver !== undefined && (!ports.mediaResolver || typeof ports.mediaResolver.resolveMediaId !== 'function'))) {
    throw new TypeError('owned_workspace_runtime_ports_required');
  }
}
