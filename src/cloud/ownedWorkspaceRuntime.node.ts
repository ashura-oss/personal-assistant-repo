import type { AppState } from '../core';
import { AppControllerImpl, type ControllerCryptoPort, type ControllerRuntimePorts, type ControllerSpeechPort } from '../services/controller.shared';
import type { AssistantModelClient } from '../services/assistantClient';
import type { OpenRouterSpeechAdapter } from '../services/openRouterSpeechAdapter';
import { createWorkspaceSnapshotDTO, type WorkspaceMediaResolver, type WorkspaceSnapshotDTO } from './workspaceDto';
import type { DurableKernel, JsonValue, OwnedWorkspaceIdentity } from '../../server/src/kernel.js';
import { CommandJournal, type CommandAdmission } from '../../server/src/commandJournal.js';
import { WorkspaceRegistry } from '../../server/src/workspaceRegistry.js';
import type { RuntimeSessionResolver } from '../../server/src/workspaceRegistry.js';
import type { LoadedWorkspaceIdentity } from '../../server/src/workspaceStore.js';

export interface OwnedWorkspaceAdmission {
  /** Kernel-issued session for the authenticated caller. Never a workspace id supplied by a caller. */
  readonly sessionToken: string;
  /** Rechecks current authentication synchronously after each async ownership lookup. */
  readonly assertCurrent: () => void;
}

export interface OwnedWorkspaceRuntimeOptions {
  readonly kernel: DurableKernel;
  readonly runtimeSessionFor: RuntimeSessionResolver;
  readonly crypto: ControllerCryptoPort;
  readonly providers: {
    readonly speech: ControllerSpeechPort;
    readonly speechOpenRouter?: OpenRouterSpeechAdapter;
    readonly openAi: AssistantModelClient;
  };
  readonly integration: ControllerRuntimePorts['integration'];
  readonly mediaResolver?: WorkspaceMediaResolver;
}

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
  private readonly refreshRequired = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: OwnedWorkspaceRuntimeOptions) {
    validatePorts(options);
    this.journal = new CommandJournal(options.kernel);
    this.registry = new WorkspaceRegistry<AppControllerImpl, AppState>(options.kernel, this.journal,
      options.runtimeSessionFor, ({ store }) => new AppControllerImpl({ store, crypto: options.crypto,
        providers: options.providers, integration: options.integration }));
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
  closeAfterDrain(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
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
      privacyEpoch: loaded.privacyEpoch, revision: loaded.revision }, this.options.mediaResolver);
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

function validatePorts(options: OwnedWorkspaceRuntimeOptions): void {
  if (!options || !options.kernel || typeof options.runtimeSessionFor !== 'function' || !options.crypto ||
      typeof options.crypto.randomUUID !== 'function' || typeof options.crypto.sha256 !== 'function' ||
      !options.providers || !options.providers.speech || typeof options.providers.speech.transcribe !== 'function' ||
      typeof options.providers.speech.releaseUploadLease !== 'function' || typeof options.providers.speech.disposeMemory !== 'function' ||
      !options.providers.openAi || typeof options.providers.openAi.prepare !== 'function' ||
      typeof options.providers.openAi.analyze !== 'function' || typeof options.providers.openAi.generateReply !== 'function' ||
      !options.integration || typeof options.integration.writeDocument !== 'function' ||
      typeof options.integration.removeAudio !== 'function' || typeof options.integration.loadRecordingRecovery !== 'function' ||
      typeof options.integration.bindRecordingRecovery !== 'function' || !options.integration.reminderBackend ||
      !options.integration.mailAlertBackend || !options.integration.deviceCalendarBackend) {
    throw new TypeError('owned_workspace_runtime_ports_required');
  }
}
