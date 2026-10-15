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

export { NodeVaultOAuthTokenStore } from './nodeOAuthTokenStore.node';
export { createProductionWorkspacePortsFor } from './productionWorkspacePorts.node';

export type ApplicationWorkspacePortsFactory =
  (context: OwnedWorkspaceFactoryContext, vault: SecretVault, kernel: DurableKernel) => OwnedWorkspaceFactoryPorts | Promise<OwnedWorkspaceFactoryPorts>;

export interface CloudApplicationRuntimeOptions {
  /** Required concrete per-workspace provider/integration composition. */
  readonly workspacePortsFor: ApplicationWorkspacePortsFactory;
}

/** Creates the Node host adapter. Missing provider composition is a startup error, never a stub. */
export function createCloudApplicationRuntimeFactory(options: CloudApplicationRuntimeOptions): ApplicationRuntimeFactory {
  if (!options || typeof options !== 'object' || typeof options.workspacePortsFor !== 'function') {
    throw new TypeError('application_workspace_ports_factory_required');
  }
  const factory: ApplicationRuntimeFactory = ({ kernel, vault, auth, runtimeSessionFor }) => {
    const oauthStages = new OAuthInstallStages(kernel, vault, auth);
    const oauthBindings = new ServerOAuthTokenBindings(kernel);
    const runtime = new OwnedWorkspaceRuntime({ kernel, runtimeSessionFor, oauthInstall: { auth, vault, stages: oauthStages, bindings: oauthBindings },
      crypto: {
        randomUUID,
        async sha256(value) { return createHash('sha256').update(value).digest('hex'); },
      },
      workspacePortsFor: (context) => options.workspacePortsFor(context, vault, kernel),
    });
    return Object.freeze({ workspaceApi: createWorkspaceHttpApi(runtime), audioHttpApi: runtime.createAudioHttpApi(),
      stopAdmission: () => runtime.stopAdmission(),
      drainAndDispose: () => runtime.closeAfterDrain(),
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
      ...(config.microsoftClientId ? { microsoftClientId: config.microsoftClientId } : {}),
      ...(config.microsoftAuthority ? { microsoftAuthority: config.microsoftAuthority } : {}) }, {
        ffmpegPath: adapters.ffmpegPath ?? config.ffmpegPath,
        ffprobePath: adapters.ffprobePath ?? config.ffprobePath,
        ...(adapters.fetcher ? { fetcher: adapters.fetcher } : {}),
        ...(adapters.documentFileOperations ? { documentFileOperations: adapters.documentFileOperations } : {}),
      });
  return ({ kernel, vault, auth, runtimeSessionFor }) => createCloudApplicationRuntimeFactory({
    workspacePortsFor: (context) => makeWorkspacePorts(context, vault, kernel),
  })({ kernel, vault, auth, runtimeSessionFor });
}
