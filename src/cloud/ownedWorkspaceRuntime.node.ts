import type { AppState } from '../core';
import { AppControllerImpl, type ControllerCryptoPort, type ControllerRuntimePorts } from '../services/controller.shared';
export { SpeechTranscriptionError } from '../services/controller.shared';
import type { PendingCaptureControllerPort } from '../audio/pendingCaptureService.types';
import type { AudioHttpApi, AudioStorageHttpApi, AudioHttpMediaResponse, AudioUploadCaptureHeader, AudioUploadReceiptDTO } from '../../server/src/audioHttp.js';
import { readAudioUploadHistory, type AudioUploadHistoryPage } from '../../server/src/audioUploadHistory.js';
import type { WorkspaceHttpAdmission } from '../../server/src/workspaceHttp.js';
import { createWorkspaceSnapshotDTO, type WorkspaceMediaResolver, type WorkspaceSnapshotDTO } from './workspaceDto';
import { NodeSpeechCleanupAdapter } from './speechCleanupAdapter.node';
import type { NodeProviderResponseLifetimeOwner } from './providerResponseLifetime.node';
import { randomUUID } from 'node:crypto';
import type { DurableKernel, JsonValue, OwnedWorkspaceIdentity } from '../../server/src/kernel.js';
import { CommandJournal, currentCommandTicket, type CommandAdmission } from '../../server/src/commandJournal.js';
import { SpeechCleanupChildren } from '../../server/src/speechCleanupChildren.js';
import { WorkspaceControllerFactoryInitializationError, WorkspaceRegistry,
  type RuntimeSessionResolver, type WorkspaceRuntimeContext } from '../../server/src/workspaceRegistry.js';
import type { LoadedWorkspaceIdentity } from '../../server/src/workspaceStore.js';
import type { ServerWorkspaceStore } from '../../server/src/workspaceStore.js';
import type { WorkspaceCommandHistoryPage } from './workspaceCommandHistory';
import type { WorkspaceCommandReceipt } from './workspaceCommands';

export type OwnedWorkspaceFactoryContext = WorkspaceRuntimeContext<AppState> & {
  readonly speechCleanupChildren: SpeechCleanupChildren;
  /** Stable only for this host process; private audio repositories use it for lease ownership. */
  readonly processInstanceId: string;
};

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
  readonly pendingCapture?: PendingCaptureControllerPort;
  /** Per-entry bridge; the runtime never exposes its backing repository/controller. */
  readonly audioHttpApi?: AudioStorageHttpApi;
  readonly attachController?: (controller: AppControllerImpl) => void;
  readonly attachedLifecycle?: Readonly<{
    stopAdmission(): void;
    drain(replacement?: { readonly identity: OwnedWorkspaceIdentity; readonly admissionSessionToken: string }): Promise<void>;
    dispose(): Promise<void>;
  }>;
  /** When supplied, this exact owner must also be used by the speech provider. */
  readonly responseLifetimeOwner?: NodeProviderResponseLifetimeOwner;
}

/** Returned resources remain factory-owned until the real controller is constructed. */
export interface OwnedWorkspaceFactoryPorts extends OwnedWorkspaceRuntimePorts {
  readonly responseLifetimeOwner: NodeProviderResponseLifetimeOwner;
  readonly disposeUnattached: () => void | Promise<void>;
}

interface OwnedWorkspaceRuntimeCommonOptions {
  readonly kernel: DurableKernel;
  readonly runtimeSessionFor: RuntimeSessionResolver;
  readonly crypto: ControllerCryptoPort;
  /** Test-only fault injection for the child receipt's post-commit acknowledgement boundary. */
  readonly afterSpeechCleanupCommitForTesting?: () => void;
  /** Test-only fault injection after an atomic workspace checkpoint has committed. */
  readonly afterWorkspaceCommitForTesting?: () => void | Promise<void>;
}

export type OwnedWorkspaceRuntimeOptions = OwnedWorkspaceRuntimeCommonOptions & (
  | (OwnedWorkspaceRuntimePorts & { readonly workspacePortsFor?: never })
  | { readonly workspacePortsFor: (context: OwnedWorkspaceFactoryContext) => OwnedWorkspaceFactoryPorts | Promise<OwnedWorkspaceFactoryPorts>;
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

interface ActiveTranscriptionCommand {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly privacyEpoch: number;
  readonly commandId: string;
  readonly requestCancellation: () => 'cancellation_requested' | 'not_running';
}

function transcriptionBindingKey(ownerId: string, workspaceId: string, privacyEpoch: number, commandId: string): string {
  return JSON.stringify([ownerId, workspaceId, privacyEpoch, commandId]);
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
  private readonly audioApis = new WeakMap<AppControllerImpl, AudioStorageHttpApi>();
  private readonly attachedLifecycles = new WeakMap<AppControllerImpl, NonNullable<OwnedWorkspaceRuntimePorts['attachedLifecycle']>>();
  private readonly speechAdapters = new WeakMap<AppControllerImpl, NodeSpeechCleanupAdapter>();
  private readonly speechAdapterByWorkspace = new Map<string, NodeSpeechCleanupAdapter>();
  private readonly allSpeechAdapters = new Set<NodeSpeechCleanupAdapter>();
  private readonly responseOwners = new Set<NodeProviderResponseLifetimeOwner>();
  private readonly responseOwnerByWorkspace = new Map<string, NodeProviderResponseLifetimeOwner>();
  private readonly responseOwnerByController = new WeakMap<AppControllerImpl, NodeProviderResponseLifetimeOwner>();
  private readonly storeByController = new WeakMap<AppControllerImpl, ServerWorkspaceStore<AppState>>();
  private readonly activeTranscriptionCommands = new Map<string, ActiveTranscriptionCommand>();
  private readonly controllers = new Set<AppControllerImpl>();
  private readonly refreshRequired = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  private readonly continuationQueues = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly processInstanceId = randomUUID();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: OwnedWorkspaceRuntimeOptions) {
    validateRuntimeConfiguration(options);
    this.journal = new CommandJournal(options.kernel);
    this.registry = new WorkspaceRegistry<AppControllerImpl, AppState>(options.kernel, this.journal,
      options.runtimeSessionFor, async (context) => {
        const children = new SpeechCleanupChildren({ kernel: options.kernel, journal: this.journal,
          runtimeSessionToken: context.runtimeSessionToken, processInstanceId: this.processInstanceId,
          ...(options.afterSpeechCleanupCommitForTesting ? { afterCommitForTesting: options.afterSpeechCleanupCommitForTesting } : {}) });
        const makeAdapter = (owner: NodeProviderResponseLifetimeOwner) => {
          validateResponseLifetimeOwner(owner);
          return new NodeSpeechCleanupAdapter({ children,
            scheduleSettlement: (work) => this.scheduleSpeechSettlement(context.identity.workspaceId, work),
            invalidateLoadedSnapshot: () => this.invalidateWorkspaceSnapshot(context.identity.workspaceId) });
        };
        if (typeof options.workspacePortsFor !== 'function') {
          validateRuntimePorts(options);
          const adapter = options.responseLifetimeOwner ? makeAdapter(options.responseLifetimeOwner) : undefined;
          const controller = new AppControllerImpl({ store: context.store, crypto: options.crypto,
            providers: options.providers, integration: options.integration, ...(adapter ? { speechCleanup: adapter.controllerPort } : {}),
            ...(options.pendingCapture ? { pendingCapture: options.pendingCapture } : {}) });
          if (options.mediaResolver) this.mediaResolvers.set(controller, options.mediaResolver);
          if (options.audioHttpApi) this.audioApis.set(controller, options.audioHttpApi);
          this.storeByController.set(controller, context.store);
          this.attachController(controller, adapter, context.identity.workspaceId, options.responseLifetimeOwner);
          return controller;
        }
        const factoryContext: OwnedWorkspaceFactoryContext = Object.freeze({ ...context, speechCleanupChildren: children,
          processInstanceId: this.processInstanceId });
        const returned = await options.workspacePortsFor(factoryContext);
        let controller: AppControllerImpl | undefined;
        let unattachedDisposed = false;
        let controllerDisposed = false;
        let lifecycleDisposed = false;
        let responseDrained = false;
        let lifecycleDrained = false;
        const cleanup = async () => {
          if (!returned || typeof returned.disposeUnattached !== 'function') throw new Error('workspace_runtime_port_cleanup_unavailable');
          if (!controller) {
            if (unattachedDisposed) return;
            await returned.disposeUnattached();
            unattachedDisposed = true;
            return;
          }
          controller.stopActiveTranscriptions();
          returned.responseLifetimeOwner.stopAdmission();
          returned.attachedLifecycle?.stopAdmission();
          if (!responseDrained) {
            await returned.responseLifetimeOwner.drain();
            responseDrained = true;
          }
          if (returned.attachedLifecycle && !lifecycleDrained) {
            await returned.attachedLifecycle.drain();
            lifecycleDrained = true;
          }
          if (!controllerDisposed) {
            await controller.disposeForPrivacy();
            controllerDisposed = true;
          }
          if (returned.attachedLifecycle && !lifecycleDisposed) {
            await returned.attachedLifecycle.dispose();
            lifecycleDisposed = true;
          }
        };
        try {
          if (!returned || typeof returned.disposeUnattached !== 'function') throw new TypeError('owned_workspace_runtime_ports_required');
          validateRuntimePorts(returned);
          validateResponseLifetimeOwner(returned.responseLifetimeOwner);
          const adapter = makeAdapter(returned.responseLifetimeOwner);
          controller = new AppControllerImpl({ store: context.store, crypto: options.crypto,
            providers: returned.providers, integration: returned.integration, speechCleanup: adapter.controllerPort, pendingCapture: returned.pendingCapture });
          returned.attachController?.(controller);
          if (returned.mediaResolver) this.mediaResolvers.set(controller, returned.mediaResolver);
          if (returned.audioHttpApi) this.audioApis.set(controller, returned.audioHttpApi);
          this.storeByController.set(controller, context.store);
          if (returned.attachedLifecycle) this.attachedLifecycles.set(controller, returned.attachedLifecycle);
          this.attachController(controller, adapter, context.identity.workspaceId, returned.responseLifetimeOwner);
          return controller;
        } catch (error) {
          try { await cleanup(); }
          catch { throw new WorkspaceControllerFactoryInitializationError('workspace_runtime_port_cleanup_failed', cleanup); }
          throw error;
        }
      }, (controller, teardown) => this.teardownWorkspaceController(controller, teardown), options.afterWorkspaceCommitForTesting);
  }

  /** Authenticated audio routes resolve the exact loaded per-workspace owner entry. */
  createAudioHttpApi(): AudioHttpApi {
    const invoke = async <T>(admission: WorkspaceHttpAdmission, operation: (api: AudioStorageHttpApi) => Promise<T>,
      cleanupIfPostcheckFails?: (result: T) => Promise<void>): Promise<T> => {
      this.assertAdmission(admission);
      const initial = this.options.kernel.getOwnedIdentity(admission.sessionToken);
      return this.track(initial.workspaceId, () => undefined, async () => {
        const entry = await this.registry.get(admission.sessionToken);
        admission.assertCurrent();
        const current = this.options.kernel.getOwnedIdentity(admission.sessionToken);
        if (current.workspaceId !== initial.workspaceId || current.ownerId !== initial.ownerId ||
            current.privacyEpoch !== initial.privacyEpoch) throw new Error('workspace_ownership_changed');
        const api = this.audioApis.get(entry.controller);
        if (!api) throw new Error('Audio storage is unavailable for this workspace.');
        const result = await operation(api);
        try {
          admission.assertCurrent();
          const after = this.options.kernel.getOwnedIdentity(admission.sessionToken);
          if (after.workspaceId !== initial.workspaceId || after.ownerId !== initial.ownerId ||
              after.privacyEpoch !== initial.privacyEpoch) throw new Error('workspace_ownership_changed');
          return result;
        } catch (error) {
          await cleanupIfPostcheckFails?.(result);
          throw error;
        }
      });
    };
    return Object.freeze({
      listUploads: (admission: WorkspaceHttpAdmission, cursor?: string): Promise<AudioUploadHistoryPage> =>
        this.listAudioUploadHistory(admission, cursor),
      upload: (admission: WorkspaceHttpAdmission, input: Readonly<{ uploadId: string; capture: AudioUploadCaptureHeader;
        mimeType: string; expectedByteLength?: number; source: AsyncIterable<Uint8Array> }>): Promise<AudioUploadReceiptDTO> =>
        invoke(admission, (api) => api.upload(admission, input)),
      inspectUpload: (admission: WorkspaceHttpAdmission, uploadId: string): Promise<AudioUploadReceiptDTO> =>
        invoke(admission, (api) => api.inspectUpload(admission, uploadId)),
      openMedia: (admission: WorkspaceHttpAdmission, mediaId: string, input: Readonly<{ method: 'GET' | 'HEAD'; range?: string; signal?: AbortSignal }>): Promise<AudioHttpMediaResponse> =>
        invoke(admission, (api) => api.openMedia(admission, mediaId, input), closeOpenedMediaResponse),
    });
  }

  /** Metadata-only recovery path; deliberately bypasses the workspace registry and controller lifecycle. */
  async listAudioUploadHistory(admission: WorkspaceHttpAdmission, cursor?: string): Promise<AudioUploadHistoryPage> {
    this.assertAdmission(admission);
    admission.assertCurrent();
    const initial = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    admission.assertCurrent();
    const result = readAudioUploadHistory(this.options.kernel, admission.sessionToken, cursor);
    admission.assertCurrent();
    const current = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (current.workspaceId !== initial.workspaceId || current.ownerId !== initial.ownerId ||
        current.privacyEpoch !== initial.privacyEpoch) throw new Error('workspace_ownership_changed');
    return result;
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
      try {
        const adapter = this.speechAdapters.get(runtime.controller);
        adapter?.acknowledgeAfterRefresh(runtime.store.getLoadedStateProof());
        return this.projectAndCache(admission, identity, runtime.controller, runtime.store.getLoadedIdentity());
      }
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

  /** Private trusted retry for the exact response/body cleanup held by the per-workspace owner. */
  async retryProviderResponseCleanup(admission: OwnedWorkspaceAdmission, cleanupId: string): Promise<void> {
    if (!admission || typeof admission.sessionToken !== 'string' || !admission.sessionToken ||
        typeof admission.assertCurrent !== 'function') throw new TypeError('owned_workspace_admission_required');
    admission.assertCurrent();
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const owner = this.responseOwnerByWorkspace.get(identity.workspaceId);
    if (!owner) throw new Error('provider_response_cleanup_unavailable');
    await owner.retryCleanup(cleanupId);
    admission.assertCurrent();
  }

  /** Explicitly retries only the same durable lease transition after a database failure. */
  async retrySpeechCleanupSettlement(admission: OwnedWorkspaceAdmission, childId: string): Promise<void> {
    if (!admission || typeof admission.sessionToken !== 'string' || !admission.sessionToken ||
        typeof admission.assertCurrent !== 'function') throw new TypeError('owned_workspace_admission_required');
    admission.assertCurrent();
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const adapter = this.speechAdapterByWorkspace.get(identity.workspaceId);
    if (!adapter) throw new Error('speech_cleanup_settlement_unavailable');
    await adapter.retrySettlement(childId);
    admission.assertCurrent();
  }

  /** Explicitly retries one already-registered physical speech cleanup; it cannot replay provider work. */
  async retrySpeechPhysicalCleanup(admission: OwnedWorkspaceAdmission, childId: string): Promise<void> {
    if (!admission || typeof admission.sessionToken !== 'string' || !admission.sessionToken ||
        typeof admission.assertCurrent !== 'function') throw new TypeError('owned_workspace_admission_required');
    admission.assertCurrent();
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const adapter = this.speechAdapterByWorkspace.get(identity.workspaceId);
    if (!adapter) throw new Error('speech_cleanup_retry_unavailable');
    await adapter.retryCleanup(childId);
    admission.assertCurrent();
  }

  /** Physical-only retry under an authoritative newer epoch for an exact fenced old entry. */
  async retryRetiredSpeechPhysicalCleanup(admission: OwnedWorkspaceAdmission, expectedHeldPrivacyEpoch: number, childId: string): Promise<void> {
    if (!admission || typeof admission.sessionToken !== 'string' || !admission.sessionToken ||
        typeof admission.assertCurrent !== 'function' || !Number.isSafeInteger(expectedHeldPrivacyEpoch) || expectedHeldPrivacyEpoch < 0) {
      throw new TypeError('owned_workspace_admission_required');
    }
    admission.assertCurrent();
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (identity.privacyEpoch <= expectedHeldPrivacyEpoch) throw new Error('workspace_retirement_cleanup_unavailable');
    const held = await this.registry.getFencedOlderControllerForRetirement({
      admissionSessionToken: admission.sessionToken, expectedHeldPrivacyEpoch,
    });
    admission.assertCurrent();
    const adapter = this.speechAdapters.get(held.controller);
    if (!adapter) throw new Error('workspace_retirement_cleanup_unavailable');
    await adapter.retryCleanupForRetirement(childId);
    admission.assertCurrent();
    const current = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (current.workspaceId !== held.identity.workspaceId || current.ownerId !== held.identity.ownerId ||
        current.privacyEpoch <= held.identity.privacyEpoch) throw new Error('workspace_retirement_cleanup_unavailable');
  }

  /**
   * Explicit same-epoch recovery after close was held by a committed cleanup
   * receipt whose acknowledgement was lost. This refreshes and verifies that
   * exact receipt while ordinary runtime admission remains closed.
   */
  async refreshHeldSpeechCleanupAfterClose(admission: OwnedWorkspaceAdmission, expectedHeldPrivacyEpoch: number): Promise<number> {
    if (!this.closing || !admission || typeof admission.sessionToken !== 'string' ||
        typeof admission.assertCurrent !== 'function' || !Number.isSafeInteger(expectedHeldPrivacyEpoch) || expectedHeldPrivacyEpoch < 0) {
      throw new Error('workspace_cleanup_refresh_unavailable');
    }
    const priorClose = this.closePromise;
    if (priorClose) await priorClose.catch(() => undefined);
    if (this.closePromise) throw new Error('workspace_cleanup_refresh_unavailable');
    admission.assertCurrent();
    const before = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (before.privacyEpoch !== expectedHeldPrivacyEpoch) throw new Error('workspace_cleanup_refresh_unavailable');
    const held = await this.registry.getHeldControllerForRefresh({ admissionSessionToken: admission.sessionToken, expectedHeldPrivacyEpoch });
    admission.assertCurrent();
    const adapter = this.speechAdapters.get(held.controller);
    if (!adapter?.hasRefreshAcknowledgementHold()) throw new Error('workspace_cleanup_refresh_unavailable');
    await held.controller.refreshPersistedWorkspace();
    admission.assertCurrent();
    const current = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    if (current.workspaceId !== held.identity.workspaceId || current.ownerId !== held.identity.ownerId ||
        current.privacyEpoch !== expectedHeldPrivacyEpoch) throw new Error('workspace_cleanup_refresh_unavailable');
    const acknowledged = adapter.acknowledgeAfterRefresh(held.store.getLoadedStateProof());
    if (acknowledged < 1) throw new Error('workspace_cleanup_refresh_unavailable');
    return acknowledged;
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
      let commandController: AppControllerImpl | undefined;
      let parentTicketId: string | undefined;
      try {
        const result = await this.registry.execute({ admissionSessionToken: input.sessionToken,
          expectedRevision: input.expectedRevision, expectedPrivacyEpoch: input.expectedPrivacyEpoch,
          idempotencyKey: input.idempotencyKey, kind: input.kind, canonicalBody: input.canonicalBody }, (controller) => {
            commandController = controller;
            parentTicketId = currentCommandTicket()?.ticketId;
            input.assertCurrent();
            return operation(controller);
          }, projectReceipt);
        input.assertCurrent();
        if (!result.admission.fresh && result.admission.status !== 'finished') {
          return Object.freeze({ admission: result.admission });
        }
        const runtime = await this.registry.get(input.sessionToken);
        input.assertCurrent();
        const controller = commandController ?? runtime.controller;
        const adapter = this.speechAdapters.get(controller);
        if (parentTicketId && adapter?.hasChildrenForParent(parentTicketId)) {
          this.invalidateWorkspaceSnapshot(identity.workspaceId);
          return Object.freeze({ admission: result.admission, ...(result.result === undefined ? {} : { result: result.result }) });
        }
        const snapshot = this.projectAndCache(input, identity, controller, runtime.store.getLoadedIdentity());
        return Object.freeze({ admission: result.admission, ...(result.result === undefined ? {} : { result: result.result }), snapshot });
      } finally {
        if (commandController && parentTicketId) this.speechAdapters.get(commandController)?.parentInvocationCompleted(parentTicketId);
      }
    });
  }

  /** Named journal path for cloud transcription; duplicates only replay their stored receipt. */
  async executeTranscriptionCommand(input: OwnedWorkspaceCommandInput,
    request: { readonly noteId: string; readonly expectedNoteRevision: number }): Promise<OwnedWorkspaceCommandResult<WorkspaceCommandReceipt>> {
    this.assertAdmission(input);
    if (!request || typeof request.noteId !== 'string' || !request.noteId ||
        !Number.isSafeInteger(request.expectedNoteRevision) || request.expectedNoteRevision < 1 || input.kind !== 'notes.transcribe') {
      throw new Error('workspace_transcription_request_invalid');
    }
    const identity = this.options.kernel.getOwnedIdentity(input.sessionToken);
    const result = await this.executeCommand(input, async (controller) => {
      const handle = controller.startOwnedTranscription(request.noteId, { expectedRevision: request.expectedNoteRevision });
      const binding: ActiveTranscriptionCommand = Object.freeze({ ownerId: identity.ownerId,
        workspaceId: identity.workspaceId, privacyEpoch: identity.privacyEpoch, commandId: input.idempotencyKey,
        requestCancellation: handle.requestCancellation });
      const bindingKey = transcriptionBindingKey(identity.ownerId, identity.workspaceId, identity.privacyEpoch, input.idempotencyKey);
      this.activeTranscriptionCommands.set(bindingKey, binding);
      let operationError: unknown;
      let operationFailed = false;
      try {
        try { await handle.result; } catch (error) { operationFailed = true; operationError = error; }
        const store = this.storeByController.get(controller);
        if (!store?.readCurrentSnapshot) throw operationFailed ? operationError : new Error('transcription_terminal_proof_unavailable');
        let raw: string;
        try {
          const current = await store.readCurrentSnapshot();
          if (!current) throw new Error('transcription_terminal_proof_unavailable');
          raw = current.raw;
        } catch (error) { throw operationFailed ? operationError : error; }
        let attempt: Record<string, unknown> | undefined;
        const outcomes = ['completed', 'no_speech', 'cancelled', 'failed', 'unknown', 'discarded'] as const;
        try {
          const snapshot = JSON.parse(raw) as { transcription?: { attempts?: unknown } };
          const attempts = snapshot.transcription?.attempts;
          attempt = Array.isArray(attempts) ? attempts.find((value) => value && typeof value === 'object' &&
            (value as Record<string, unknown>).id === handle.attemptId) as Record<string, unknown> | undefined : undefined;
          const terminalAt = attempt?.terminalAt;
          if (!attempt || attempt.noteId !== request.noteId || attempt.sourceRevision !== request.expectedNoteRevision ||
              typeof terminalAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(terminalAt) ||
              new Date(terminalAt).toISOString() !== terminalAt || !outcomes.includes(attempt.outcome as typeof outcomes[number])) {
            throw new Error('transcription_terminal_proof_unavailable');
          }
        } catch (error) { throw operationFailed ? operationError : error; }
        return Object.freeze({ schemaVersion: 1 as const, commandId: input.idempotencyKey, kind: 'notes.transcribe' as const,
          objectId: request.noteId, attemptId: handle.attemptId, sourceRevision: request.expectedNoteRevision,
          outcome: attempt.outcome as typeof outcomes[number] });
      } finally {
        if (this.activeTranscriptionCommands.get(bindingKey) === binding) this.activeTranscriptionCommands.delete(bindingKey);
      }
    }, (receipt): JsonValue => ({ schemaVersion: receipt.schemaVersion, commandId: receipt.commandId, kind: receipt.kind,
      objectId: receipt.objectId, attemptId: receipt.attemptId, sourceRevision: receipt.sourceRevision, outcome: receipt.outcome }));
    return result;
  }

  /** Synchronous signal-only cancellation for one exact active journal parent. */
  requestTranscriptionCancellation(admission: OwnedWorkspaceAdmission, commandId: string): 'cancellation_requested' | 'not_running' {
    this.assertAdmission(admission);
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const binding = this.activeTranscriptionCommands.get(transcriptionBindingKey(identity.ownerId, identity.workspaceId, identity.privacyEpoch, commandId));
    if (!binding || binding.commandId !== commandId || binding.ownerId !== identity.ownerId ||
        binding.workspaceId !== identity.workspaceId || binding.privacyEpoch !== identity.privacyEpoch) return 'not_running';
    admission.assertCurrent();
    return binding.requestCancellation();
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

  /** Bounded read-only journal projection; bypasses busy/refresh/controller state. */
  listCommandHistory(admission: OwnedWorkspaceAdmission, cursor?: unknown): WorkspaceCommandHistoryPage {
    this.assertAdmission(admission);
    const identity = this.options.kernel.getOwnedIdentity(admission.sessionToken);
    const result = this.journal.historyPage(admission.sessionToken, cursor);
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
    for (const controller of this.controllers) controller.stopActiveTranscriptions();
    for (const owner of this.responseOwners) owner.stopAdmission();
  }

  closeAfterDrain(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopAdmission();
    const closing = (async () => {
      for (;;) {
        while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
        await Promise.all([...this.allSpeechAdapters].map((adapter) => adapter.drain()));
        await Promise.all([...this.responseOwners].map((owner) => owner.drain()));
        if (this.inFlight.size === 0) break;
      }
      await this.registry.disposeAll();
      this.controllers.clear();
      this.allSpeechAdapters.clear();
      this.speechAdapterByWorkspace.clear();
      this.responseOwners.clear();
      this.responseOwnerByWorkspace.clear();
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
      this.releaseBusy(workspaceId);
      this.inFlight.delete(pending);
    });
    this.inFlight.add(pending);
    return pending;
  }

  private attachController(controller: AppControllerImpl, adapter: NodeSpeechCleanupAdapter | undefined,
    workspaceId: string, responseOwner?: NodeProviderResponseLifetimeOwner): void {
    this.controllers.add(controller);
    if (adapter) {
      this.speechAdapters.set(controller, adapter);
      this.allSpeechAdapters.add(adapter);
      this.speechAdapterByWorkspace.set(workspaceId, adapter);
    }
    if (responseOwner) {
      this.responseOwners.add(responseOwner);
      this.responseOwnerByWorkspace.set(workspaceId, responseOwner);
      this.responseOwnerByController.set(controller, responseOwner);
    }
  }

  private async teardownWorkspaceController(controller: AppControllerImpl, input: {
    readonly identity: { readonly workspaceId: string; readonly ownerId: string; readonly privacyEpoch: number };
    readonly replacement?: { readonly identity: OwnedWorkspaceIdentity; readonly admissionSessionToken: string };
  }): Promise<void> {
    controller.stopActiveTranscriptions();
    const adapter = this.speechAdapters.get(controller);
    const attachedLifecycle = this.attachedLifecycles.get(controller);
    const owner = this.responseOwnerByController.get(controller);
    owner?.stopAdmission();
    attachedLifecycle?.stopAdmission();
    if (owner) await owner.drain();

    if (input.replacement) {
      const expected = input.replacement.identity;
      if (expected.workspaceId !== input.identity.workspaceId || expected.ownerId !== input.identity.ownerId ||
          expected.privacyEpoch <= input.identity.privacyEpoch) throw new Error('workspace_old_epoch_retirement_unverified');
      const currentBeforeDispose = this.options.kernel.getOwnedIdentity(input.replacement.admissionSessionToken);
      if (currentBeforeDispose.workspaceId !== expected.workspaceId || currentBeforeDispose.ownerId !== expected.ownerId ||
          currentBeforeDispose.privacyEpoch !== expected.privacyEpoch) throw new Error('workspace_old_epoch_retirement_unverified');
      await adapter?.drainPhysicalCleanupForRetirement();
      await attachedLifecycle?.drain(input.replacement);
      const currentAfterDrain = this.options.kernel.getOwnedIdentity(input.replacement.admissionSessionToken);
      if (currentAfterDrain.workspaceId !== expected.workspaceId || currentAfterDrain.ownerId !== expected.ownerId ||
          currentAfterDrain.privacyEpoch !== expected.privacyEpoch) throw new Error('workspace_old_epoch_retirement_unverified');
    } else {
      await adapter?.drain();
      await attachedLifecycle?.drain();
    }

    await controller.disposeForPrivacy();
    await attachedLifecycle?.dispose();
    this.controllers.delete(controller);
    if (adapter) {
      this.allSpeechAdapters.delete(adapter);
      if (this.speechAdapterByWorkspace.get(input.identity.workspaceId) === adapter) this.speechAdapterByWorkspace.delete(input.identity.workspaceId);
    }
    if (owner) {
      this.responseOwners.delete(owner);
      if (this.responseOwnerByWorkspace.get(input.identity.workspaceId) === owner) this.responseOwnerByWorkspace.delete(input.identity.workspaceId);
    }
    this.audioApis.delete(controller);
    this.attachedLifecycles.delete(controller);
    this.cache.delete(input.identity.workspaceId);
  }

  private invalidateWorkspaceSnapshot(workspaceId: string): void {
    this.cache.delete(workspaceId);
    this.refreshRequired.add(workspaceId);
  }

  private scheduleSpeechSettlement(workspaceId: string, work: () => Promise<void>): Promise<void> {
    const prior = this.continuationQueues.get(workspaceId) ?? Promise.resolve();
    const pending = prior.catch(() => undefined).then(async () => {
      if (this.busy.has(workspaceId)) await new Promise<void>((resolve) => {
        const waiters = this.idleWaiters.get(workspaceId) ?? new Set<() => void>();
        waiters.add(resolve);
        this.idleWaiters.set(workspaceId, waiters);
      });
      this.busy.add(workspaceId);
      try { await work(); }
      finally { this.releaseBusy(workspaceId); }
    });
    this.continuationQueues.set(workspaceId, pending);
    this.inFlight.add(pending);
    void pending.finally(() => {
      this.inFlight.delete(pending);
      if (this.continuationQueues.get(workspaceId) === pending) this.continuationQueues.delete(workspaceId);
    }).catch(() => undefined);
    return pending;
  }

  private releaseBusy(workspaceId: string): void {
    this.busy.delete(workspaceId);
    const waiters = this.idleWaiters.get(workspaceId);
    if (!waiters) return;
    this.idleWaiters.delete(workspaceId);
    for (const resolve of waiters) resolve();
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

async function closeOpenedMediaResponse(response: AudioHttpMediaResponse): Promise<void> {
  const body = response.body;
  if (!body || body.closed) return;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      if (error !== undefined && !body.closed) { done = true; cleanup(); reject(error); return; }
      if (!body.closed) return;
      done = true; cleanup(); resolve();
    };
    const onClose = () => finish();
    const onError = (_error: Error) => { /* Wait for the actual close acknowledgement. */ };
    const cleanup = () => { body.off('close', onClose); body.off('error', onError); };
    body.once('close', onClose);
    body.on('error', onError);
    if (!body.destroyed) body.destroy();
    if (body.closed) finish();
  });
}

/** Internal Node test/integration seam; never exported by the HTTP adapter. */
export { NodeSpeechCleanupAdapter };

function validateRuntimeConfiguration(options: OwnedWorkspaceRuntimeOptions): void {
  if (!options || !options.kernel || typeof options.runtimeSessionFor !== 'function' || !options.crypto ||
      typeof options.crypto.randomUUID !== 'function' || typeof options.crypto.sha256 !== 'function' ||
      typeof options !== 'object') {
    throw new TypeError('owned_workspace_runtime_ports_required');
  }
  const hasFactory = Object.prototype.hasOwnProperty.call(options, 'workspacePortsFor');
  const hasStaticPorts = Object.prototype.hasOwnProperty.call(options, 'providers') ||
    Object.prototype.hasOwnProperty.call(options, 'integration') || Object.prototype.hasOwnProperty.call(options, 'mediaResolver') ||
    Object.prototype.hasOwnProperty.call(options, 'responseLifetimeOwner') || Object.prototype.hasOwnProperty.call(options, 'pendingCapture') ||
    Object.prototype.hasOwnProperty.call(options, 'audioHttpApi') || Object.prototype.hasOwnProperty.call(options, 'attachedLifecycle');
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

function validateResponseLifetimeOwner(owner: NodeProviderResponseLifetimeOwner): void {
  if (!owner || typeof owner !== 'object' || typeof owner.withResponseLifetimeFor !== 'function' ||
      typeof owner.stopAdmission !== 'function' || typeof owner.drain !== 'function' ||
      typeof owner.retryCleanup !== 'function' || typeof owner.getPending !== 'function' ||
      typeof owner.subscribe !== 'function') throw new TypeError('workspace_response_lifetime_owner_required');
}
