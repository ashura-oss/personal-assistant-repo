import { createHash, randomUUID } from 'node:crypto';
import type { ApplicationRuntimeFactory } from '../../server/src/applicationHost.js';
import type { SecretVault } from '../../server/src/vault.js';
import { OwnedWorkspaceRuntime, type OwnedWorkspaceFactoryContext, type OwnedWorkspaceFactoryPorts } from './ownedWorkspaceRuntime.node';
import { createWorkspaceHttpApi } from './workspaceHttp.node';
import type { DurableKernel } from '../../server/src/kernel.js';
import { OAuthInstallStages } from '../../server/src/oauthInstallStages.js';
import { ServerOAuthTokenBindings } from '../../server/src/oauthTokenBindings.js';
import type { AuthService } from '../../server/src/auth.js';
import type { ServerConfig } from '../../server/src/config.js';
import { createProductionWorkspacePortsFor, type ProductionWorkspacePortsOptions } from './productionWorkspacePorts.node';
import { createNodeProviderResponseLifetimeOwner } from './providerResponseLifetime.node';
import { createServerOAuthProviderAdapter } from '../../server/src/oauthProviderAdapter.js';
import { OAuthConnectionService } from '../../server/src/oauthConnectionService.js';
import type { NodeProviderResponseLifetimeOwner } from './providerResponseLifetime.node';
import type { ServerOAuthProviderAdapter } from '../../server/src/oauthProviderAdapter.js';
import { BackgroundRuntimeOwner } from './backgroundRuntime.node';
import { WorkspaceEraseService } from '../../server/src/workspaceErase.js';
import { join } from 'node:path';

// Private Node gateway seam: callers must already hold an immutable occurrence claim.
// This export shares the exact AsyncLocalStorage instance used by the production participant.
export { runBackgroundPaidMailReplyCheckpoint } from './backgroundPaidWork.node';

export { NodeVaultOAuthTokenStore } from './nodeOAuthTokenStore.node';
export { createProductionWorkspacePortsFor } from './productionWorkspacePorts.node';

export type ApplicationWorkspacePortsFactory =
  (context: OwnedWorkspaceFactoryContext, vault: SecretVault, kernel: DurableKernel) => OwnedWorkspaceFactoryPorts | Promise<OwnedWorkspaceFactoryPorts>;

export interface CloudApplicationRuntimeOptions {
  /** Required concrete per-workspace provider/integration composition. */
  readonly workspacePortsFor: ApplicationWorkspacePortsFactory;
  readonly oauth?: Readonly<{ provider: ServerOAuthProviderAdapter; responseLifetimeOwner: NodeProviderResponseLifetimeOwner;
    config: Pick<ServerConfig, 'googleClientId' | 'googleClientSecret' | 'microsoftClientId' | 'microsoftClientSecret' |
      'googleRedirectUri' | 'microsoftRedirectUri'> }>;
  readonly privateAudioRoot?: string;
  readonly privateDocumentsRoot?: string;
}

/** Creates the Node host adapter. Missing provider composition is a startup error, never a stub. */
export function createCloudApplicationRuntimeFactory(options: CloudApplicationRuntimeOptions): ApplicationRuntimeFactory {
  if (!options || typeof options !== 'object' || typeof options.workspacePortsFor !== 'function') {
    throw new TypeError('application_workspace_ports_factory_required');
  }
  const factory: ApplicationRuntimeFactory = async ({ kernel, vault, auth, runtimeSessionFor, listWorkspaceMetadataPage, processInstanceId,
    createEmptyWorkspaceSnapshot }) => {
    const oauthStages = new OAuthInstallStages(kernel, vault, auth);
    const oauthBindings = new ServerOAuthTokenBindings(kernel);
    const workspaceErase = new WorkspaceEraseService({ kernel, auth, vault, createEmptySnapshot: createEmptyWorkspaceSnapshot,
      ...(options.privateAudioRoot ? { privateAudioRoot: options.privateAudioRoot } : {}),
      ...(options.privateDocumentsRoot ? { privateDocumentsRoot: options.privateDocumentsRoot } : {}) });
    await workspaceErase.resumePendingPhysicalCleanup();
    const runtime = new OwnedWorkspaceRuntime({ kernel, runtimeSessionFor, processInstanceId,
      isWorkspaceErasePending: (workspaceId, ownerId) => workspaceErase.isWorkspaceErasePending(workspaceId, ownerId),
      isWorkspaceEraseCommandPending: (workspaceId, ownerId, commandId) => workspaceErase.isWorkspaceEraseCommandPending(workspaceId, ownerId, commandId),
      isWorkspaceEraseComplete: (workspaceId, ownerId, commandId) => workspaceErase.isWorkspaceEraseComplete(workspaceId, ownerId, commandId),
      isWorkspaceEraseCancellationComplete: (workspaceId, ownerId, commandId) => workspaceErase.isWorkspaceEraseCancellationComplete(workspaceId, ownerId, commandId),
      oauthInstall: { auth, vault, stages: oauthStages, bindings: oauthBindings },
      crypto: {
        randomUUID,
        async sha256(value) { return createHash('sha256').update(value).digest('hex'); },
      },
      workspacePortsFor: (context) => options.workspacePortsFor(context, vault, kernel),
    });
    const oauthService = options.oauth ? new OAuthConnectionService({ kernel, auth, stages: oauthStages,
      provider: options.oauth.provider, config: options.oauth.config, runtimeSessionFor,
      isWorkspaceEraseHeldOrPending: (workspaceId, ownerId) => runtime.isWorkspaceEraseHeldOrPending(workspaceId, ownerId) }) : undefined;
    const background = new BackgroundRuntimeOwner({ kernel, auth, runtime, runtimeSessionFor, listWorkspaceMetadataPage });
    return Object.freeze({ workspaceApi: createWorkspaceHttpApi(runtime, background?.policies, workspaceErase), audioHttpApi: runtime.createAudioHttpApi(),
      ...(oauthService ? { oauthHttpApi: oauthService } : {}),
      stopAdmission: () => { background.stopAdmission(); oauthService?.stopAdmission(); options.oauth?.responseLifetimeOwner.stopAdmission(); runtime.stopAdmission(); },
      drainAndDispose: async () => {
        await background.drainAndDispose();
        await oauthService?.drain();
        await options.oauth?.responseLifetimeOwner.drain();
        await runtime.closeAfterDrain();
      },
    });
  };
  return factory;
}

/** Real Node per-epoch composition; external adapters remain injectable for closed-network tests. */
export function createProductionApplicationRuntimeFactory(config: ServerConfig,
  adapters: Pick<ProductionWorkspacePortsOptions, 'ffmpegPath' | 'ffprobePath' | 'fetcher' | 'documentFileOperations'> = {}): ApplicationRuntimeFactory {
  if (!config || typeof config !== 'object' || typeof config.dataDirectory !== 'string') {
    throw new TypeError('production_application_config_required');
  }
  const makeWorkspacePorts = createProductionWorkspacePortsFor({ dataDirectory: config.dataDirectory,
      ...(config.googleClientId ? { googleClientId: config.googleClientId } : {}),
      ...(config.googleClientSecret ? { googleClientSecret: config.googleClientSecret } : {}),
      ...(config.microsoftClientId ? { microsoftClientId: config.microsoftClientId } : {}),
      ...(config.microsoftClientSecret ? { microsoftClientSecret: config.microsoftClientSecret } : {}),
      ...(config.microsoftAuthority ? { microsoftAuthority: config.microsoftAuthority } : {}) }, {
        ffmpegPath: adapters.ffmpegPath ?? config.ffmpegPath,
        ffprobePath: adapters.ffprobePath ?? config.ffprobePath,
        ...(adapters.fetcher ? { fetcher: adapters.fetcher } : {}),
      ...(adapters.documentFileOperations ? { documentFileOperations: adapters.documentFileOperations } : {}),
      });
  return ({ kernel, vault, auth, runtimeSessionFor, listWorkspaceMetadataPage, processInstanceId, createEmptyWorkspaceSnapshot }) => {
    const fetcher = adapters.fetcher ?? globalThis.fetch;
    const responseLifetimeOwner = createNodeProviderResponseLifetimeOwner({ fetcher, createId: randomUUID });
    const registrations = [
      ...(config.googleClientId && config.googleClientSecret ? [{ registrationId: 'google' as const, provider: 'google' as const,
        clientId: config.googleClientId, clientSecret: config.googleClientSecret }] : []),
      ...(config.microsoftClientId && config.microsoftClientSecret ? [{ registrationId: 'microsoft' as const, provider: 'microsoft' as const,
        clientId: config.microsoftClientId, clientSecret: config.microsoftClientSecret }] : []),
    ];
    const provider = createServerOAuthProviderAdapter({ canonicalOrigin: config.canonicalOrigin, registrations,
      responseLifetime: responseLifetimeOwner.withResponseLifetimeFor('oauth') });
    return createCloudApplicationRuntimeFactory({
      workspacePortsFor: (context) => makeWorkspacePorts(context, vault, kernel),
      oauth: { provider, responseLifetimeOwner, config },
      privateAudioRoot: join(config.dataDirectory, 'private-audio'),
      privateDocumentsRoot: join(config.dataDirectory, 'private-documents'),
    })({ kernel, vault, auth, runtimeSessionFor, listWorkspaceMetadataPage, processInstanceId, createEmptyWorkspaceSnapshot });
  };
}
