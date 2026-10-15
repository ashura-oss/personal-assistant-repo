import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Account, Note } from '../core';
import type { AudioStorageHttpApi, AudioHttpMediaResponse, AudioUploadReceiptDTO } from '../../server/src/audioHttp.js';
import type { WorkspaceHttpAdmission } from '../../server/src/workspaceHttp.js';
import type { SecretVault } from '../../server/src/vault.js';
import type { DurableKernel, OwnedWorkspaceIdentity } from '../../server/src/kernel.js';
import type { ServerConfig } from '../../server/src/config.js';
import { ServerProviderCredentialService } from '../../server/src/providerCredentials.js';
import { PrivateAudioRepository } from '../../server/src/privateAudioRepository.js';
import { ensurePrivateDirectory } from '../../server/src/config.js';
import { createNodeProviderResponseLifetimeOwner } from './providerResponseLifetime.node';
import { createNodeSpeechAudioService } from '../audio/speechUpload.node';
import { createNodePendingCaptureController } from './pendingCaptureService.node';
import { SharedAzureSpeechClient } from '../services/azureSpeech.shared';
import { OpenRouterBatchClient, OpenRouterBatchRequestBuilder } from '../services/openRouter';
import { OpenRouterSpeechClient } from '../services/openRouterSpeech';
import { SharedOpenRouterSpeechAdapter } from '../services/openRouterSpeechAdapter.shared';
import { ConnectorClient, type OAuthBridgeResult, type OAuthTokenStore, type StoredOAuthToken } from '../connectors';
import type { AssistantModelClient } from '../services/assistantClient';
import type { AppControllerImpl, ControllerRuntimePorts, ControllerSpeechPort } from '../services/controller.shared';
import type { PreparedAnalysis } from '../services/azure';
import type { OwnedWorkspaceFactoryContext, OwnedWorkspaceFactoryPorts } from './ownedWorkspaceRuntime.node';
import type { RecordingRecoveryService } from '../audio/recovery.types';
import type { NotificationBackend } from '../services/notificationBackend';
import { NotificationBackendError, DeviceCalendarBackendError } from '../services/controllerRuntimeErrors';
import type { DeviceCalendarBackend } from '../services/deviceCalendarBackend';
import type { MailAlertNotificationBackend } from '../services/mailAlertNotificationBackend';
import type { MailAlertTapBackend } from '../proactiveMailAlerts/taps';
import { NodeVaultOAuthTokenStore } from './nodeOAuthTokenStore.node';
import { safeRelativeMarkdownPath } from '../privacy/eraseAdapter.shared';
import type { ProviderPurpose, ProviderResponseLifetime } from '../services/providerResponseLifetime.shared';
import type { WorkspaceMediaResolver } from './workspaceDto';

type FactoryContext = OwnedWorkspaceFactoryContext;

export interface ProductionWorkspacePortsOptions {
  readonly kernel: DurableKernel;
  readonly vault: SecretVault;
  readonly dataDirectory: string;
  readonly googleClientId?: string;
  readonly googleClientSecret?: string;
  readonly microsoftClientId?: string;
  readonly microsoftClientSecret?: string;
  readonly microsoftAuthority?: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly fetcher?: typeof fetch;
  /** Narrow filesystem fault-injection port for private-document ownership tests. */
  readonly documentFileOperations?: PrivateDocumentFileOperations;
}

export interface PrivateDocumentFileHandle {
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PrivateDocumentFileOperations {
  mkdir(path: string, options: { mode: number }): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<PrivateDocumentFileHandle>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const SAME_ACCOUNT = (a: Account['identity'], b: Account['identity']): boolean => Boolean(a && b &&
  a.providerNamespace === b.providerNamespace && a.clientId === b.clientId && a.subject === b.subject &&
  a.resourceUserId === b.resourceUserId && a.issuer === b.issuer && a.tenantId === b.tenantId);

const nodeDocumentFileOperations: PrivateDocumentFileOperations = Object.freeze({ mkdir, open, lstat, rename, unlink });

type HeldFileCleanup = { readonly retry: () => Promise<void>; pending?: Promise<void> };

/** Keeps exact open handles owned until close/unlink is acknowledged. */
class PrivateDocumentFileOwner {
  private readonly active = new Set<Promise<void>>();
  private readonly held = new Map<string, HeldFileCleanup>();
  private draining?: Promise<void>;

  constructor(readonly operations: PrivateDocumentFileOperations) {}

  track(task: Promise<void>): Promise<void> {
    this.active.add(task);
    void task.then(() => this.active.delete(task), () => this.active.delete(task));
    return task;
  }

  async runCleanup(key: string, retry: () => Promise<void>): Promise<void> {
    const current = this.held.get(key);
    const cleanup = current ?? { retry };
    if (!current) this.held.set(key, cleanup);
    const attempt = this.retryAction(key, cleanup);
    return attempt;
  }

  hasCleanup(key: string): boolean { return this.held.has(key); }
  assertNoHeldCleanup(): void { if (this.held.size) throw new Error('private_document_cleanup_pending'); }

  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    const attempt = (async () => {
      while (this.active.size) await Promise.allSettled([...this.active]);
      for (const [key, cleanup] of [...this.held]) {
        try { await this.retryAction(key, cleanup); } catch { /* Retain the exact failed handle for an explicit later drain. */ }
      }
      if (this.held.size) throw new Error('private_document_cleanup_pending');
    })();
    this.draining = attempt;
    void attempt.then(() => { if (this.draining === attempt) this.draining = undefined; },
      () => { if (this.draining === attempt) this.draining = undefined; });
    return attempt;
  }

  private retryAction(key: string, cleanup: HeldFileCleanup): Promise<void> {
    if (cleanup.pending) return cleanup.pending;
    const attempt = Promise.resolve().then(cleanup.retry).then(() => {
      if (this.held.get(key) === cleanup) this.held.delete(key);
    });
    cleanup.pending = attempt;
    void attempt.then(() => { if (cleanup.pending === attempt) cleanup.pending = undefined; },
      () => { if (cleanup.pending === attempt) cleanup.pending = undefined; });
    return attempt;
  }
}

/** Build the real Node providers for one authoritative owner/epoch entry. */
export function createProductionWorkspacePortsFor(config: Pick<ServerConfig,
  'dataDirectory' | 'googleClientId' | 'googleClientSecret' | 'microsoftClientId' | 'microsoftClientSecret' | 'microsoftAuthority'>,
  options: Pick<ProductionWorkspacePortsOptions, 'fetcher' | 'ffmpegPath' | 'ffprobePath' | 'documentFileOperations'> = {}) {
  if (!config || typeof config.dataDirectory !== 'string' || !config.dataDirectory || config.dataDirectory.includes('\0')) {
    throw new TypeError('production_workspace_data_directory_required');
  }
  return async (context: FactoryContext, vault: SecretVault, kernel: DurableKernel): Promise<OwnedWorkspaceFactoryPorts> => {
    const identity = Object.freeze({ workspaceId: context.identity.workspaceId, ownerId: context.identity.ownerId,
      privacyEpoch: context.identity.privacyEpoch });
    const actorToken = context.runtimeSessionToken;
    const assertActor = () => {
      const current = kernel.getOwnedIdentity(actorToken);
      if (current.workspaceId !== identity.workspaceId || current.ownerId !== identity.ownerId || current.privacyEpoch !== identity.privacyEpoch) {
        throw new Error('workspace_runtime_identity_changed');
      }
    };
    const assertLoadedWorkspaceCurrent = () => {
      assertActor();
      const current = kernel.getOwnedIdentity(actorToken);
      const loaded = context.store.getLoadedIdentity();
      if (loaded.workspaceId !== identity.workspaceId || loaded.ownerId !== identity.ownerId ||
          loaded.privacyEpoch !== identity.privacyEpoch || loaded.revision !== current.revision) {
        throw new Error('workspace_provider_state_stale');
      }
    };
    const isAuthoritativeConnectionCurrent = (account: Account): boolean => {
      try {
        assertLoadedWorkspaceCurrent();
        const live = currentController?.getSnapshot();
        const current = live?.accounts.find((row) => row.id === account.id);
        if (!live || live.mailAlertRefreshRequired || !current?.connected || current.authStatus !== 'connected' ||
            current.tokenRef !== account.tokenRef || current.connectionGeneration !== account.connectionGeneration ||
            !SAME_ACCOUNT(current.identity, account.identity)) return false;
        const generation = kernel.withOwnedTransaction(actorToken, identity.privacyEpoch, (owned) => {
          if (owned.workspaceId !== identity.workspaceId || owned.ownerId !== identity.ownerId) return undefined;
          const row = owned.db.prepare('SELECT generation FROM account_generations WHERE workspace_id=? AND account_id=?')
            .get(identity.workspaceId, account.id) as { generation: number } | undefined;
          return row?.generation;
        });
        return generation === account.connectionGeneration;
      } catch { return false; }
    };
    const fetcher = options.fetcher ?? globalThis.fetch;
    if (typeof fetcher !== 'function') throw new Error('server_fetch_unavailable');
    const responseLifetimeOwner = createNodeProviderResponseLifetimeOwner({ fetcher,
      createId: randomUUID });
    const withResponseLifetime = (purpose: ProviderPurpose): ProviderResponseLifetime => {
      const lifetime = responseLifetimeOwner.withResponseLifetimeFor(purpose);
      return <T>(input: RequestInfo | URL, init: RequestInit, consume: (response: Response) => Promise<T>,
        onCancelPending?: (retryCancel: import('../services/providerResponseLifetime.shared').ProviderCancellationRetry) => void,
        beforeStart?: () => void) => lifetime(input, init, consume, onCancelPending, () => {
          assertLoadedWorkspaceCurrent();
          beforeStart?.();
        });
    };
    const credentialService = new ServerProviderCredentialService(kernel, vault, actorToken, identity);
    let currentController: AppControllerImpl | undefined;
    let acceptingProviderWork = true;
    const providerWork = new Set<Promise<unknown>>();
    const withProviderOwnership = async <T>(actual: () => Promise<T>): Promise<T> => {
        assertActor();
        if (!acceptingProviderWork) throw new Error('workspace_provider_admission_closed');
        const task = Promise.resolve().then(actual);
        providerWork.add(task);
        try { return await task; }
        finally { providerWork.delete(task); }
      };
    const stopProviderWork = () => { acceptingProviderWork = false; };
    const drainProviderWork = async () => {
      while (providerWork.size) await Promise.allSettled([...providerWork]);
    };
    const documentFiles = new PrivateDocumentFileOwner(options.documentFileOperations ?? nodeDocumentFileOperations);
    const openRouterBatchClient = new OpenRouterBatchClient({ fetcher,
      withResponseLifetime: withResponseLifetime('openrouter_batch'), withRequestOwnership: withProviderOwnership,
      readCredentialSnapshot: () => credentialService.readProviderCredentialSnapshot('openrouter'),
      assertCredentialGeneration: (generation) => credentialService.assertProviderCredentialGeneration('openrouter', generation),
      assertBeforeStart: assertLoadedWorkspaceCurrent,
      onCancelPending: (operationId, retryCancel) => currentController?.rememberOpenRouterBatchCleanup(operationId, retryCancel),
    });
    const batchBuilder = new OpenRouterBatchRequestBuilder(async (value) => createHash('sha256').update(value).digest('hex'));
    const openAi: AssistantModelClient = Object.freeze({
      prepare: async (note, docs, settings, request): Promise<PreparedAnalysis> => {
        const prepared = await batchBuilder.prepareAnalysis(note, docs, settings, request);
        return { endpoint: 'openrouter-batch', catalog: prepared.catalog, selection: prepared.selection, body: prepared.body,
          includedSourceIds: [...prepared.includedSourceIds], includedSources: prepared.includedSources.map((source) => ({ ...source })),
          omittedSourceIds: [...prepared.omittedSourceIds], omittedSourceCount: prepared.omittedSourceCount,
          sourceVersions: { ...prepared.sourceVersions } };
      },
      analyze: async () => { throw new Error('Paid text requests require explicit OpenRouter Batch submission.'); },
      generateReply: async () => { throw new Error('Paid text requests require explicit OpenRouter Batch submission.'); },
    });
    let audioRepo!: PrivateAudioRepository;
    const resolveCurrentAttachedMedia = (input: { workspaceId: string; ownerId: string; privacyEpoch: number; noteId: string; noteRevision: number }) => {
      assertActor();
      if (input.workspaceId !== identity.workspaceId || input.ownerId !== identity.ownerId || input.privacyEpoch !== identity.privacyEpoch) return undefined;
      const note = currentController?.getSnapshot().notes.find((candidate) => candidate.id === input.noteId && candidate.revision === input.noteRevision);
      const match = note?.audioUri ? /^still-media:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(note.audioUri) : undefined;
      if (!match || !note) return undefined;
      try {
        const record = audioRepo.getRecord(match[1]!);
        if (record.status !== 'ready') return undefined;
        return Object.freeze({ mediaId: match[1]!, noteId: note.id, noteRevision: note.revision,
          ...(record.sha256 ? { sha256: record.sha256 } : {}), ...(record.byteLength !== undefined ? { byteLength: record.byteLength } : {}) });
      } catch { return undefined; }
    };
    audioRepo = new PrivateAudioRepository({ kernel, actorSessionToken: actorToken,
      privateRoot: join(config.dataDirectory, 'private-audio'), processId: context.processInstanceId,
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}), ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
      resolveAttachedMedia: resolveCurrentAttachedMedia,
    });
    const speechAudio = createNodeSpeechAudioService(audioRepo);
    const azureSpeech = new SharedAzureSpeechClient({ fetcher, audio: speechAudio,
      readKeySnapshot: async (capturedGeneration) => {
        const snapshot = await credentialService.readSpeechCredentialSnapshot();
        if (snapshot.generation !== capturedGeneration) throw new Error('The Azure Speech credential changed during preparation.');
        return snapshot;
      }, currentCredentialGeneration: () => credentialService.currentSpeechCredentialGeneration(),
      assertCredentialGeneration: (generation) => credentialService.assertSpeechCredentialGeneration(generation),
      randomUUID, withRequestOwnership: withProviderOwnership,
      withResponseLifetime: withResponseLifetime('azure_speech'),
    });
    const openRouterSpeechClient = new OpenRouterSpeechClient({ fetcher,
      withRequestOwnership: withProviderOwnership, withResponseLifetime: withResponseLifetime('openrouter_speech'),
      readCredentialSnapshot: () => credentialService.readProviderCredentialSnapshot('openrouter'),
      assertCredentialGeneration: (generation) => credentialService.assertProviderCredentialGeneration('openrouter', generation),
      assertBeforeStart: assertLoadedWorkspaceCurrent,
      onCancelPending: (leaseId, retryCancel) => currentController?.rememberSpeechRequestCleanup(leaseId, retryCancel),
    });
    const openRouterSpeech = new SharedOpenRouterSpeechAdapter({ audio: speechAudio, client: openRouterSpeechClient,
      sha256: async (value) => createHash('sha256').update(value).digest('hex') });
    const tokenStore = new NodeVaultOAuthTokenStore(kernel, vault, actorToken, identity,
      () => currentController?.getSnapshot().accounts ?? []);
    let connector: ConnectorClient | undefined;
    const connectorFactory = (store: OAuthTokenStore, onAuthStatus: (accountId: string, status: Account['authStatus']) => Promise<void> | void) => {
      connector = new ConnectorClient({ tokenStore: store, ...(config.googleClientId ? { googleClientId: config.googleClientId } : {}),
        ...(config.microsoftClientId ? { microsoftClientId: config.microsoftClientId } : {}),
        ...(config.microsoftAuthority ? { microsoftAuthority: config.microsoftAuthority } : {}), onAuthStatus,
        applyRefreshClientAuthentication: ({ provider, clientId, tokenEndpoint, body }) => {
          const expectedClientId = provider === 'google' ? config.googleClientId : config.microsoftClientId;
          const secret = provider === 'google' ? config.googleClientSecret : config.microsoftClientSecret;
          const expectedEndpoint = provider === 'google' ? 'https://oauth2.googleapis.com/token'
            : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
          const keys = [...body.keys()].sort();
          if (!secret || !expectedClientId || clientId !== expectedClientId || tokenEndpoint !== expectedEndpoint ||
              keys.join(',') !== 'client_id,grant_type,refresh_token' || body.get('client_id') !== expectedClientId ||
              body.get('grant_type') !== 'refresh_token' || !body.get('refresh_token') || body.get('refresh_token')!.length > 16_384) {
            throw new Error('confidential_refresh_configuration_invalid');
          }
          body.set('client_secret', secret);
        },
        withProviderOwnership, withResponseLifetime: responseLifetimeOwner.withResponseLifetimeFor('connector'),
        isConnectionCurrent: isAuthoritativeConnectionCurrent,
      });
      return connector;
    };
    const verifyOAuthResult = async (result: OAuthBridgeResult, stored: StoredOAuthToken, assertCurrent?: () => void): Promise<boolean> => {
      assertActor(); assertCurrent?.();
      if (!connector || !await connector.verifyOAuthIdentity(result, stored, assertCurrent)) return false;
      assertActor(); assertCurrent?.();
      const allowed = new Set(['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write']);
      if (result.requestedCapabilities.some((item) => !allowed.has(item)) ||
          result.capabilities.some((item) => !result.requestedCapabilities.includes(item)) ||
          result.requestedCapabilities.includes('calendar.write') && !result.requestedCapabilities.includes('calendar.read')) return false;
      return true;
    };
    const integration: ControllerRuntimePorts['integration'] = {
      credentials: credentialService, tokenStore, deleteToken: tokenStore.delete.bind(tokenStore),
      ...(config.googleClientId || config.microsoftClientId ? { clientIds: {
        ...(config.googleClientId ? { google: config.googleClientId } : {}),
        ...(config.microsoftClientId ? { microsoft: config.microsoftClientId } : {}),
      } } : {}),
      connectorFactory, verifyOAuthResult, openRouterBatchClient,
      speechAudioService: speechAudio, openRouterSpeechAdapter: openRouterSpeech,
      writeDocument: async (path, content) => {
        assertActor();
        documentFiles.assertNoHeldCleanup();
        const controller = currentController;
        if (!controller) throw new Error('private_document_controller_unavailable');
        const captured = controller.getSnapshot().documents.find((document) => document.path === path && document.content === content);
        if (!captured) throw new Error('private_document_source_changed');
        const task = documentFiles.track(writePrivateMarkdown(config.dataDirectory, identity, captured, assertActor, () => {
          assertActor();
          const current = controller.getSnapshot().documents.find((document) => document.path === path);
          if (!current || current.revision !== captured.revision || current.content !== captured.content) {
            throw new Error('private_document_source_changed');
          }
        }, documentFiles, documentFiles.operations));
        await task;
      },
      removeAudio: async (uri) => {
        assertActor();
        const match = /^still-media:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(uri);
        if (!match) throw new Error('Server audio reference is unavailable.');
        await audioRepo.eraseOwnedMedia(match[1]!);
      },
      loadRecordingRecovery: async () => recordingRecoveryUnavailable,
      bindRecordingRecovery: (service) => service,
      reminderBackend: unavailableReminderBackend,
      mailAlertBackend: unavailableMailAlertBackend,
      deviceCalendarBackend: unavailableDeviceCalendarBackend,
      mailAlertTapBackend: unavailableMailAlertTapBackend,
    };
    const audioHttpApi: AudioStorageHttpApi = Object.freeze({
      upload: async (admission: WorkspaceHttpAdmission, input: Parameters<AudioStorageHttpApi['upload']>[1]) => {
        assertActor();
        const admitted = kernel.getOwnedIdentity(admission.sessionToken);
        if (admitted.workspaceId !== identity.workspaceId || admitted.ownerId !== identity.ownerId || admitted.privacyEpoch !== identity.privacyEpoch) {
          throw new Error('workspace_runtime_identity_changed');
        }
        const receipt = await audioRepo.uploadCapture(input.source, { uploadId: input.uploadId, captureId: input.capture.id,
          capturedAt: input.capture.capturedAt, timeZone: input.capture.timeZone, mimeType: input.mimeType,
          ...(input.expectedByteLength === undefined ? {} : { expectedByteLength: input.expectedByteLength }) });
        assertActor();
        return projectCaptureReceipt(receipt);
      },
      inspectUpload: async (admission: WorkspaceHttpAdmission, uploadId: string) => {
        assertActor();
        const admitted = kernel.getOwnedIdentity(admission.sessionToken);
        if (admitted.workspaceId !== identity.workspaceId || admitted.ownerId !== identity.ownerId || admitted.privacyEpoch !== identity.privacyEpoch) {
          throw new Error('workspace_runtime_identity_changed');
        }
        const receipt = audioRepo.inspectCaptureUpload(uploadId);
        assertActor();
        return projectCaptureReceipt(receipt);
      },
      openMedia: async (admission: WorkspaceHttpAdmission, mediaId: string,
        input: Parameters<AudioStorageHttpApi['openMedia']>[2]): Promise<AudioHttpMediaResponse> => {
        assertActor();
        const admitted = kernel.getOwnedIdentity(admission.sessionToken);
        if (admitted.workspaceId !== identity.workspaceId || admitted.ownerId !== identity.ownerId || admitted.privacyEpoch !== identity.privacyEpoch) {
          throw new Error('workspace_runtime_identity_changed');
        }
        const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(mediaId);
        if (!match) throw new Error('audio_unavailable');
        const controller = currentController;
        if (!controller) throw new Error('audio_unavailable');
        const note = controller.getSnapshot().notes.find((item) => item.audioUri === `still-media:${match[1]}`);
        if (!note || !resolveCurrentAttachedMedia({ ...identity, noteId: note.id, noteRevision: note.revision })) throw new Error('audio_unavailable');
        const response = await audioRepo.openAttachedMedia({ noteId: note.id, noteRevision: note.revision,
          method: input.method, ...(input.range ? { range: input.range } : {}), ...(input.signal ? { signal: input.signal } : {}) });
        try { assertActor(); return response; }
        catch (error) { await closeOpenedMediaResponse(response); throw error; }
      },
    });
    const providers: ControllerRuntimePorts['providers'] = Object.freeze({ speech: azureSpeech as ControllerSpeechPort,
      speechOpenRouter: openRouterSpeech, openAi });
    const attachedLifecycle = Object.freeze({
      stopAdmission: () => { stopProviderWork(); audioRepo.stopAdmission(); },
      drain: async (replacement?: { identity: OwnedWorkspaceIdentity; admissionSessionToken: string }) => {
        await Promise.all([drainProviderWork(), documentFiles.drain()]);
        await audioRepo.drain(replacement);
      },
      dispose: async () => { speechAudio.disposeMemory?.(); },
    });
    const disposeUnattached = async () => {
      stopProviderWork(); responseLifetimeOwner.stopAdmission(); audioRepo.stopAdmission();
      await Promise.all([drainProviderWork(), documentFiles.drain(), responseLifetimeOwner.drain(), audioRepo.drain()]);
      speechAudio.disposeMemory?.();
    };
    const mediaResolver: WorkspaceMediaResolver = Object.freeze({
      resolveMediaId: (note: Readonly<Note>, localUri: string) => {
        const match = /^still-media:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(localUri);
        if (!match || note.audioUri !== localUri) return undefined;
        return resolveCurrentAttachedMedia({ ...identity, noteId: note.id, noteRevision: note.revision })?.mediaId;
      },
    });
    return Object.freeze({ providers, integration, responseLifetimeOwner, disposeUnattached, audioHttpApi, mediaResolver,
      pendingCapture: createNodePendingCaptureController(audioRepo),
      attachedLifecycle, attachController: (controller: AppControllerImpl) => { currentController = controller; },
    });
  };
}

async function closeOpenedMediaResponse(response: AudioHttpMediaResponse): Promise<void> {
  const body = response.body;
  if (!body || body.closed) return;
  await new Promise<void>((resolve) => {
    const onClose = () => { cleanup(); resolve(); };
    const onError = (_error: Error) => { /* Wait for close as the physical ownership acknowledgement. */ };
    const cleanup = () => { body.off('close', onClose); body.off('error', onError); };
    body.once('close', onClose);
    body.on('error', onError);
    if (!body.destroyed) body.destroy();
    if (body.closed) onClose();
  });
}

function projectCaptureReceipt(receipt: import('../../server/src/privateAudioRepository.js').CaptureUploadReceipt): AudioUploadReceiptDTO {
  return Object.freeze({ schemaVersion: 1, uploadId: receipt.uploadId, status: receipt.status,
    capture: Object.freeze({ id: receipt.capture.id, revision: receipt.capture.revision, capturedAt: receipt.capture.capturedAt,
      timeZone: receipt.capture.timeZone }),
    ...(receipt.consumption ? { consumption: Object.freeze({ ...receipt.consumption }) } : {}),
    ...(receipt.media ? { media: Object.freeze({ mediaId: receipt.media.mediaId, sha256: receipt.media.sha256,
      byteLength: receipt.media.byteLength, durationSeconds: receipt.media.durationSeconds,
      format: receipt.media.format, mimeType: receipt.media.mimeType }) } : {}) });
}

async function writePrivateMarkdown(dataDirectory: string, identity: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>,
  document: Readonly<{ path: string; content: string; revision: number }>, assertActor: () => void, assertStillApproved: () => void,
  fileOwner: PrivateDocumentFileOwner, fileOperations: PrivateDocumentFileOperations): Promise<void> {
  const { path, content } = document;
  if (typeof content !== 'string' || !safeRelativeMarkdownPath(path)) throw new Error('private_document_path_invalid');
  assertActor(); assertStillApproved();
  const root = resolve(dataDirectory, 'private-documents', identity.ownerId, identity.workspaceId, String(identity.privacyEpoch));
  ensurePrivateDirectory(root);
  let directory = root;
  const segments = path.split('/');
  const name = segments.pop()!;
  for (const segment of segments) {
    directory = join(directory, segment);
    try { await fileOperations.mkdir(directory, { mode: 0o700 }); assertActor(); assertStillApproved(); } catch (error) {
      assertActor(); assertStillApproved();
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    assertActor(); assertStillApproved();
    const info = await fileOperations.lstat(directory);
    assertActor(); assertStillApproved();
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('private_document_path_invalid');
  }
  const target = join(directory, name);
  const temp = join(directory, `.still-${randomUUID()}.tmp`);
  let handle: PrivateDocumentFileHandle | undefined;
  let tempExists = false;
  let renamed = false;
  let abandonTemp = false;
  let fileFailure: unknown;
  const fileCleanup = async () => {
    if (handle) { await handle.close(); handle = undefined; }
    if (abandonTemp && tempExists && !renamed) {
      try { await fileOperations.unlink(temp); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      tempExists = false;
    }
  };
  try {
    assertActor(); assertStillApproved();
    handle = await fileOperations.open(temp, 'wx', 0o600); tempExists = true;
    assertActor(); assertStillApproved();
    await handle.writeFile(content, { encoding: 'utf8' });
    assertActor(); assertStillApproved();
    await handle.sync();
    assertActor(); assertStillApproved();
    await fileOwner.runCleanup(`file:${temp}`, fileCleanup);
    assertActor(); assertStillApproved();
    await fileOperations.rename(temp, target); assertActor(); assertStillApproved(); tempExists = false; renamed = true;
    const directoryHandle = await fileOperations.open(directory, 'r');
    const directoryCleanup = async () => directoryHandle.close();
    try { assertActor(); assertStillApproved(); await directoryHandle.sync(); assertActor(); assertStillApproved(); }
    catch (error) { fileFailure = error; throw error; }
    finally {
      // Directory paths are shared by concurrent document writes, but each open
      // descriptor has independent ownership and must be closed independently.
      try { await fileOwner.runCleanup(`directory:${randomUUID()}`, directoryCleanup); }
      catch (error) { if (fileFailure === undefined) fileFailure = error; }
    }
    if (fileFailure !== undefined) throw fileFailure;
  } catch (error) {
    fileFailure = error;
    abandonTemp = true;
    if (handle || tempExists && !renamed) {
      try { if (!fileOwner.hasCleanup(`file:${temp}`)) await fileOwner.runCleanup(`file:${temp}`, fileCleanup); }
      catch { /* The exact handle/path remains held by fileOwner for explicit drain retry. */ }
    }
    throw error;
  }
}

const recordingRecoveryUnavailable: RecordingRecoveryService = Object.freeze({
  async pickAndStage() { throw new Error('Local file picking is unavailable on the server.'); },
  async inspect() { throw new Error('Local recording import is unavailable on the server.'); },
  async remove() { throw new Error('Local recording removal is unavailable on the server.'); },
});

const unavailableReminderBackend: NotificationBackend = Object.freeze({
  platform: 'web',
  async getPermission() { return 'unavailable' as const; },
  async requestPermission() { return 'unavailable' as const; },
  async listPending() { return []; },
  async schedule() { throw new NotificationBackendError('unavailable'); },
  async cancel() { throw new NotificationBackendError('unavailable'); },
  async cancelLegacy() { throw new NotificationBackendError('unavailable'); },
  async installForegroundHandler() { throw new NotificationBackendError('unavailable'); },
});

const unavailableDeviceCalendarBackend: DeviceCalendarBackend = Object.freeze({
  platform: 'web',
  async getPermission() { return 'unavailable' as const; },
  async requestFullPermission() { throw new DeviceCalendarBackendError('unavailable'); },
  async listCalendars() { throw new DeviceCalendarBackendError('unavailable'); },
  async getCalendar() { throw new DeviceCalendarBackendError('unavailable'); },
  async readEvents() { throw new DeviceCalendarBackendError('unavailable'); },
  async createApprovedEvent() { throw new DeviceCalendarBackendError('unavailable'); },
  async lookupRecord() { throw new DeviceCalendarBackendError('unavailable'); },
});

const unavailableMailAlertBackend: MailAlertNotificationBackend = Object.freeze({
  platform: 'web',
  async getPermission() { return 'unavailable' as const; },
  async requestPermission() { return 'unavailable' as const; },
  async present() { return 'unavailable' as const; },
  async cancel() { return 'cancellation_unknown' as const; },
});

const unavailableMailAlertTapBackend: MailAlertTapBackend = Object.freeze({
  async subscribe() { throw new Error('Native notification taps are unavailable on the server.'); },
  async getLastResponse() { return undefined; },
});
