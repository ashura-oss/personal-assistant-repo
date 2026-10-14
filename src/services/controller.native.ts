import { AppControllerImpl as SharedAppControllerImpl, extractPreviewProposals as extractSharedPreviewProposals } from './controller.shared';
import * as Crypto from 'expo-crypto';
import type { Account, AccountCapability, AppController, Note, Proposal } from '../core';
import { createPlatformStateStore, stateStore } from '../storage/platformStorage';
import type { StateStore } from '../storage/contracts';

import { writePrivateDocument } from '../storage/documents';
import { AzureOpenAIClient, AzureSpeechClient } from './azure';
import type { AssistantModelClient } from './assistantClient';
import { createNotificationBackend } from './notificationBackend';

import type { NotificationBackend } from './notificationBackend';

import { getDeviceCalendarBackend } from '../deviceCalendars';
import type { DeviceCalendarBackend } from '../deviceCalendars';

import { removeAudio } from '../audio/readAudio';
import type { RecordingRecoveryService } from '../audio/recovery.types';

import type { OAuthBridgeResult, StoredOAuthToken, OAuthTokenStore } from '../connectors';
import { ConnectorClient } from '../connectors';
import { scopeGrantsCapability } from '../connectors/oauth';
import { oauthTokenStore, deleteOAuthToken } from '../auth/tokenStore';
import { Platform } from 'react-native';

import type { MailAlertTapBackend } from '../proactiveMailAlerts/taps';

import { createMailAlertNotificationBackend, type MailAlertNotificationBackend } from './mailAlertNotificationBackend';
import { createMailAlertTapBackend } from './mailAlertTapBackend';

import type { SpeechAudioService } from '../audio/speechUpload.types';
import { getDefaultPrivacyService, type PrivacyService, type PrivacyWorkspaceSession } from '../privacy/service';
import { createPrivacyBoundController } from '../privacy/controllerBoundary';
import { bindExistingWorkspaceWriter, bindWorkspaceStorage, type ExistingWorkspaceWriterStore } from '../privacy/workspaceStorage';
import type { PrivacyWriterScope } from '../privacy/types';
import { createPendingCaptureService } from '../audio/pendingCaptureService';
import type { PendingCaptureControllerPort, PendingCaptureJournalPort } from '../audio/pendingCaptureService.types';
import type { PendingCaptureNativeIO } from '../audio/pendingCaptureNativeIO.types';
import { createPrivacyResourceBoundary, type PrivacyResourceBoundary } from '../privacy/resourceBoundary';
import { createPrivacyAudioBoundary, createPrivacyBoundRecordingRecoveryService, createPrivacyBoundSpeechAudioService, type PrivacyAudioBoundary } from '../privacy/audioBoundary';
import { createProviderCredentialService, type ProviderCredentialService } from './credentials';
import { credentialStore } from '../storage/credentials';
import type { BackgroundTaskBackend } from '../background/backend.types';
import { OpenRouterBatchClient } from './openRouter';
import { OpenRouterSpeechClient } from './openRouterSpeech';
import { OpenRouterSpeechAdapter } from './openRouterSpeechAdapter';

const newId = () => Crypto.randomUUID();

function sameAccountIdentity(a: Account['identity'], b: Account['identity']): boolean {
  return Boolean(a && b && a.providerNamespace === b.providerNamespace && a.clientId === b.clientId &&
    a.subject === b.subject && a.resourceUserId === b.resourceUserId && a.issuer === b.issuer && a.tenantId === b.tenantId);
}

export function extractPreviewProposals(note: Note): Proposal[] {
  return extractSharedPreviewProposals(note, newId);
}

export interface ControllerIntegrationDependencies {
  privacySession?: { epoch: string; assertCurrent(): Promise<void>; getStatus?(): Promise<import('../privacy/types').PrivacyPublicStatus> };
  credentials?: ProviderCredentialService;
  writeDocument?: (path: string, content: string) => Promise<void>;
  tokenStore?: OAuthTokenStore;
  deleteToken?: (tokenRef: string) => Promise<void>;
  verifyOAuthResult?: (result: OAuthBridgeResult, stored: StoredOAuthToken, assertCurrent?: () => void) => Promise<boolean>;
  clientIds?: Partial<Record<'google' | 'microsoft', string>>;
  connectorFactory?: (
    tokenStore: OAuthTokenStore,
    onAuthStatus: (accountId: string, status: Account['authStatus']) => Promise<void>,
    withProviderOwnership?: <T>(actual: () => Promise<T>) => Promise<T>,
    withResponseLifetime?: import('./providerResponseLifetime').ProviderResponseLifetime,
  ) => ConnectorClient;
  recordingRecovery?: RecordingRecoveryService;
  speechAudioService?: SpeechAudioService;
  audioBoundary?: PrivacyAudioBoundary;
  removeAudio?: (uri: string) => Promise<void>;
  loadRecordingRecovery?: () => Promise<RecordingRecoveryService>;
  bindRecordingRecovery?: (service: RecordingRecoveryService) => RecordingRecoveryService;
  disposePrivacyResources?: () => void;
  reminderBackend?: NotificationBackend;
  deviceCalendarBackend?: DeviceCalendarBackend;
  backgroundTasks?: BackgroundTaskBackend;
  mailAlertBackend?: MailAlertNotificationBackend;
  mailAlertTapBackend?: MailAlertTapBackend;
  withMailAlertNotificationWriter?: <T>(actual: (scope: PrivacyWriterScope, store: ExistingWorkspaceWriterStore) => Promise<T>) => Promise<T>;
  openRouterBatchClient?: OpenRouterBatchClient;
  openRouterSpeechAdapter?: OpenRouterSpeechAdapter;
}

export class AppControllerImpl extends SharedAppControllerImpl {
  constructor(
    store: StateStore = stateStore,
    providers: { speech?: AzureSpeechClient; speechOpenRouter?: OpenRouterSpeechAdapter; openAi?: AssistantModelClient } = {},
    integration: ControllerIntegrationDependencies = {},
    pendingCapture?: PendingCaptureControllerPort,
  ) {
    const credentials = integration.credentials ?? createProviderCredentialService(credentialStore);
    const speech = providers.speech ?? new AzureSpeechClient(integration.credentials ? {
      audio: integration.speechAudioService,
      readKeySnapshot: () => credentials.readSpeechCredentialSnapshot(),
      currentCredentialGeneration: () => credentials.currentSpeechCredentialGeneration(),
      assertCredentialGeneration: (generation: number) => credentials.assertSpeechCredentialGeneration(generation),
    } : { audio: integration.speechAudioService });
    // Read through the caller's object so fields such as privacySession remain
    // live, while native defaults stay on a separate object. This also accepts
    // frozen integration objects without changing caller-owned state.
    const nativeIntegration = Object.create(integration) as ControllerIntegrationDependencies & Required<Pick<ControllerIntegrationDependencies,
      'credentials' | 'reminderBackend' | 'mailAlertBackend' | 'deviceCalendarBackend' | 'writeDocument' | 'removeAudio' | 'loadRecordingRecovery' | 'bindRecordingRecovery'>>;
    Object.defineProperties(nativeIntegration, {
      credentials: { value: credentials, enumerable: true },
      reminderBackend: { value: integration.reminderBackend ?? createNotificationBackend(), enumerable: true },
      mailAlertBackend: { value: integration.mailAlertBackend ?? createMailAlertNotificationBackend(), enumerable: true },
      deviceCalendarBackend: { value: integration.deviceCalendarBackend ?? getDeviceCalendarBackend(), enumerable: true },
      // Resolve the default at use time so native spies and late caller updates
      // retain the original controller's read-through integration semantics.
      writeDocument: { get: () => integration.writeDocument ?? writePrivateDocument, enumerable: true },
      removeAudio: { value: integration.removeAudio ?? ((uri: string) => removeAudio(uri, integration.audioBoundary)), enumerable: true },
      loadRecordingRecovery: { value: integration.loadRecordingRecovery ?? (async () => (await import('../audio/recovery')).recordingRecoveryService), enumerable: true },
      bindRecordingRecovery: { value: integration.bindRecordingRecovery ?? ((service: RecordingRecoveryService) => integration.audioBoundary
        ? createPrivacyBoundRecordingRecoveryService(service, integration.audioBoundary) : service), enumerable: true },
    });
    super({
      store, crypto: {
        randomUUID: () => Crypto.randomUUID(),
        sha256: async (value: string | Uint8Array) => {
          if (typeof value === 'string') return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, { encoding: 'hex' as Crypto.CryptoEncoding });
          if (typeof Crypto.digest === 'function') {
            const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, value.slice().buffer as ArrayBuffer));
            return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
          }
          return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(value), { encoding: 'hex' as Crypto.CryptoEncoding });
        },
      },
      providers: {
        speech, speechOpenRouter: providers.speechOpenRouter ?? integration.openRouterSpeechAdapter,
        openAi: providers.openAi ?? new AzureOpenAIClient(fetch, () => credentials.readProviderCredential('openai')),
      }, integration: nativeIntegration, pendingCapture,
    });
  }
}

const googleClientId = (Platform.OS === 'web' ? process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID : process.env.EXPO_PUBLIC_GOOGLE_NATIVE_CLIENT_ID)?.trim() ?? '';
const microsoftClientId = (Platform.OS === 'web' ? process.env.EXPO_PUBLIC_MICROSOFT_WEB_CLIENT_ID : process.env.EXPO_PUBLIC_MICROSOFT_NATIVE_CLIENT_ID)?.trim() ?? '';
const microsoftAuthority = process.env.EXPO_PUBLIC_MICROSOFT_AUTHORITY?.trim() || 'common';
let defaultConnector: ConnectorClient | undefined;
let defaultController: AppControllerImpl | undefined;
const defaultIntegration: ControllerIntegrationDependencies = {
  tokenStore: oauthTokenStore,
  deleteToken: deleteOAuthToken,
  clientIds: { google: googleClientId, microsoft: microsoftClientId },
  connectorFactory: (tokenStore, onAuthStatus) => {
    defaultConnector = new ConnectorClient({ tokenStore, googleClientId, microsoftClientId, microsoftAuthority, onAuthStatus,
      isConnectionCurrent: (account) => {
        const current = defaultController?.getSnapshot().accounts.find((item) => item.id === account.id);
        return Boolean(!defaultController?.getSnapshot().mailAlertRefreshRequired && current && current.connected && current.authStatus === 'connected' && current.tokenRef === account.tokenRef &&
          current.connectionGeneration === account.connectionGeneration && sameAccountIdentity(current.identity, account.identity));
      },
    });
    return defaultConnector;
  },
  verifyOAuthResult: async (result, stored, assertCurrent) => {
    assertCurrent?.();
    if (!defaultConnector || !await defaultConnector.verifyOAuthIdentity(result, stored, assertCurrent)) return false;
    assertCurrent?.();
    const known: AccountCapability[] = ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'];
    if (result.requestedCapabilities.some((item) => !known.includes(item)) || result.capabilities.some((item) => !result.requestedCapabilities.includes(item))) return false;
    if (result.requestedCapabilities.includes('calendar.write') && !result.requestedCapabilities.includes('calendar.read')) return false;
    return result.capabilities.every((item) => scopeGrantsCapability(result.provider, result.grantedScopes, item));
  },
};

defaultController = new AppControllerImpl(undefined, {}, defaultIntegration);
export const controller: AppController = defaultController;
export default controller;

/**
 * Constructs the production workspace only after the independent privacy journal
 * confirms that no erase is active. Callers should use this factory at the app
 * bootstrap boundary before rendering or invoking data-bearing controller APIs.
 */
export interface ProductionWorkspaceOptions {
  privacy?: PrivacyService;
  session?: PrivacyWorkspaceSession;
  resources?: PrivacyResourceBoundary;
  audioBoundary?: PrivacyAudioBoundary;
  credentials?: ProviderCredentialService;
  store?: StateStore;
  providers?: { speech?: AzureSpeechClient; speechOpenRouter?: OpenRouterSpeechAdapter; openAi?: AssistantModelClient };
  integration?: ControllerIntegrationDependencies;
  pendingCaptureNativeIO?: PendingCaptureNativeIO;
}

export async function createProductionWorkspace(options: ProductionWorkspaceOptions = {}): Promise<{ controller: AppController; backgroundTasks: BackgroundTaskBackend; mailAlertTaps: MailAlertTapBackend; captureJournal?: PendingCaptureJournalPort }> {
  const privacy = options.privacy ?? options.resources?.privacy ?? await getDefaultPrivacyService();
  if (options.resources && options.resources.privacy !== privacy) throw new Error('Privacy resource boundary belongs to a different control service.');
  const requestedSession = options.session ?? options.resources?.session;
  const capturedRequestedSession = requestedSession
    ? Object.freeze({ epoch: requestedSession.epoch, runtimeId: requestedSession.runtimeId })
    : undefined;
  const openedSession = await privacy.openWorkspace();
  const session: PrivacyWorkspaceSession = capturedRequestedSession ?? Object.freeze({ epoch: openedSession.epoch, runtimeId: openedSession.runtimeId });
  if (session.epoch !== openedSession.epoch || session.runtimeId !== openedSession.runtimeId) {
    throw new Error('The supplied privacy workspace session is no longer current.');
  }
  if (options.resources && (options.resources.session.epoch !== session.epoch || options.resources.session.runtimeId !== session.runtimeId)) {
    throw new Error('Privacy resource boundary belongs to a different workspace session.');
  }
  if (options.audioBoundary && (options.audioBoundary.binding.privacy !== privacy ||
      options.audioBoundary.binding.session.epoch !== session.epoch || options.audioBoundary.binding.session.runtimeId !== session.runtimeId)) {
    throw new Error('Privacy audio boundary belongs to a different workspace session.');
  }
  const audioBoundary = options.audioBoundary ?? createPrivacyAudioBoundary({
    privacy, session, captureNamespace: Platform.OS === 'web' ? 'browser_audio' : 'native_recordings',
  });
  const resources = options.resources ?? createPrivacyResourceBoundary({ privacy, session });
  let implementation: AppControllerImpl | undefined;
  const rawStore = options.store ?? createPlatformStateStore();
  const boundStore = bindWorkspaceStorage(rawStore, privacy, session);
  let captureJournal: PendingCaptureJournalPort | undefined;
  let pendingCaptureController: PendingCaptureControllerPort | undefined;
  if (Platform.OS === 'ios' && rawStore.pendingCapture) {
    let nativeIO = options.pendingCaptureNativeIO;
    if (!nativeIO) {
      const native = await import('../audio/pendingCaptureNativeIO.native');
      nativeIO = native.pendingCaptureNativeIO;
    }
    const service = createPendingCaptureService({ backend: rawStore.pendingCapture, privacy, session, nativeIO });
    captureJournal = service.journal;
    pendingCaptureController = service.controller;
  }
  const rawTokenStore = options.integration?.tokenStore ?? oauthTokenStore;
  const tokenStore = resources.oauthTokenStore(rawTokenStore);
  const providerCredentials = options.credentials ?? options.integration?.credentials ?? createProviderCredentialService(resources.credentialStore(credentialStore));
  const openRouterBatchClient = options.integration?.openRouterBatchClient ?? new OpenRouterBatchClient({
    withResponseLifetime: resources.withResponseLifetimeFor('openrouter_batch'),
    withRequestOwnership: resources.withProviderOwnership,
    readCredentialSnapshot: () => providerCredentials.readProviderCredentialSnapshot('openrouter'),
    assertCredentialGeneration: (generation) => providerCredentials.assertProviderCredentialGeneration('openrouter', generation),
    assertBeforeStart: () => undefined,
    onCancelPending: (operationId, retryCancel) => implementation?.rememberOpenRouterBatchCleanup(operationId, retryCancel),
  });
  const rawWriteDocument = options.integration?.writeDocument ?? writePrivateDocument;
  const configuredConnectorFactory = options.integration?.connectorFactory;
  let factoryConnector: ConnectorClient | undefined;
  const boundNotifications = resources.notificationBackend(options.integration?.reminderBackend ?? createNotificationBackend());
  const boundDeviceCalendars = resources.deviceCalendarBackend(options.integration?.deviceCalendarBackend ?? getDeviceCalendarBackend());
  const rawBackgroundTasks = options.integration?.backgroundTasks ?? (await import('../background/backend')).backgroundTaskBackend;
  const boundBackgroundTasks = resources.backgroundTaskBackend(rawBackgroundTasks);
  const mailAlertTaps = options.integration?.mailAlertTapBackend ?? createMailAlertTapBackend({
    withNotificationOwnership: (actual) => resources.withMailAlertNotificationWriter(() => actual()),
  });
  const speechAudioService = options.integration?.speechAudioService ?? createPrivacyBoundSpeechAudioService(audioBoundary);
  const openRouterSpeechAdapter = options.integration?.openRouterSpeechAdapter ?? (() => {
    const client = new OpenRouterSpeechClient({
      withRequestOwnership: (actual) => privacy.withWriter(session.epoch, { kind: 'speech_upload', namespace: 'speech_staging' }, actual),
      withResponseLifetime: resources.withResponseLifetimeFor('openrouter_speech'),
      readCredentialSnapshot: () => providerCredentials.readProviderCredentialSnapshot('openrouter'),
      assertCredentialGeneration: (generation) => providerCredentials.assertProviderCredentialGeneration('openrouter', generation),
      assertBeforeStart: () => undefined,
      onCancelPending: (leaseId, retryCancel) => implementation?.rememberSpeechRequestCleanup(leaseId, retryCancel),
    });
    return new OpenRouterSpeechAdapter({ audio: speechAudioService, client });
  })();
  const integration: ControllerIntegrationDependencies = {
    ...defaultIntegration,
    ...options.integration,
    credentials: providerCredentials,
    openRouterBatchClient,
    audioBoundary,
    speechAudioService,
    openRouterSpeechAdapter,
    removeAudio: async (uri) => audioBoundary.withAudioWrite(() => options.integration?.removeAudio
      ? options.integration.removeAudio(uri)
      : removeAudio(uri)),
    reminderBackend: boundNotifications.backend,
    mailAlertBackend: options.integration?.mailAlertBackend ?? createMailAlertNotificationBackend(),
    withMailAlertNotificationWriter: options.integration?.withMailAlertNotificationWriter ?? ((actual) => resources.withMailAlertNotificationWriter((scope) =>
      actual(scope, bindExistingWorkspaceWriter(rawStore, privacy, session, scope)))),
    deviceCalendarBackend: boundDeviceCalendars.backend,
    disposePrivacyResources: () => { boundNotifications.dispose(); boundDeviceCalendars.dispose(); boundBackgroundTasks.dispose(); },
    privacySession: {
      epoch: session.epoch,
      assertCurrent: () => privacy.assertWorkspaceEpoch(session.epoch),
      getStatus: () => privacy.getStatus(),
    },
    writeDocument: async (path, content) => {
      await privacy.withWriter(session.epoch, { kind: 'markdown_mirror', namespace: 'markdown_mirrors', legacyMarkdownPath: path }, () => rawWriteDocument(path, content));
    },
    tokenStore,
    deleteToken: tokenStore.delete,
    connectorFactory: (store, onAuthStatus) => {
      const connector = configuredConnectorFactory?.(store, onAuthStatus, resources.withProviderOwnership, resources.withResponseLifetimeFor('connector')) ?? new ConnectorClient({
        tokenStore: store, googleClientId, microsoftClientId, microsoftAuthority, onAuthStatus,
        withProviderOwnership: resources.withProviderOwnership,
        withResponseLifetime: resources.withResponseLifetimeFor('connector'),
        isConnectionCurrent: (account) => {
          const current = implementation?.getSnapshot().accounts.find((item) => item.id === account.id);
          return Boolean(!implementation?.getSnapshot().mailAlertRefreshRequired && current && current.connected && current.authStatus === 'connected' && current.tokenRef === account.tokenRef &&
            current.connectionGeneration === account.connectionGeneration && sameAccountIdentity(current.identity, account.identity));
        },
      });
      if (connector instanceof ConnectorClient) factoryConnector = connector;
      return connector;
    },
    verifyOAuthResult: options.integration?.verifyOAuthResult ?? (async (result, stored, assertCurrent) => {
      assertCurrent?.();
      if (!factoryConnector || !await factoryConnector.verifyOAuthIdentity(result, stored, assertCurrent)) return false;
      assertCurrent?.();
      const known: AccountCapability[] = ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'];
      if (result.requestedCapabilities.some((item) => !known.includes(item)) || result.capabilities.some((item) => !result.requestedCapabilities.includes(item))) return false;
      if (result.requestedCapabilities.includes('calendar.write') && !result.requestedCapabilities.includes('calendar.read')) return false;
      return result.capabilities.every((item) => scopeGrantsCapability(result.provider, result.grantedScopes, item));
    }),
  };
  const providers = {
    speech: options.providers?.speech ?? new AzureSpeechClient({
      audio: integration.speechAudioService,
      readKeySnapshot: () => providerCredentials.readSpeechCredentialSnapshot(),
      currentCredentialGeneration: () => providerCredentials.currentSpeechCredentialGeneration(),
      assertCredentialGeneration: (generation) => providerCredentials.assertSpeechCredentialGeneration(generation),
      withRequestOwnership: (actualRequest) => privacy.withWriter(session.epoch, { kind: 'speech_upload', namespace: 'speech_staging' }, actualRequest),
      withResponseLifetime: resources.withResponseLifetimeFor('azure_speech'),
    }),
    speechOpenRouter: options.providers?.speechOpenRouter ?? openRouterSpeechAdapter,
    openAi: options.providers?.openAi ?? new AzureOpenAIClient(fetch, () => providerCredentials.readProviderCredential('openai'), resources.withProviderOwnership,
      resources.withResponseLifetimeFor('azure_ai')),
  };
  implementation = new AppControllerImpl(boundStore, providers, integration, pendingCaptureController);
  return { controller: createPrivacyBoundController(implementation, privacy, session), backgroundTasks: boundBackgroundTasks.backend, mailAlertTaps, ...(captureJournal ? { captureJournal } : {}) };
}

export async function createProductionController(options: ProductionWorkspaceOptions = {}): Promise<AppController> {
  return (await createProductionWorkspace(options)).controller;
}

export type { ControllerCryptoPort, ControllerRuntimePorts } from './controller.shared';
