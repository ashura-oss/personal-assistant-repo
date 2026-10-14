import { createHash, randomUUID } from 'node:crypto';
import type { ApplicationRuntimeFactory } from '../../server/src/applicationHost.js';
import type { SecretVault } from '../../server/src/vault.js';
import { OwnedWorkspaceRuntime, type OwnedWorkspaceFactoryPorts } from './ownedWorkspaceRuntime.node';
import { createWorkspaceHttpApi } from './workspaceHttp.node';
import type { WorkspaceRuntimeContext } from '../../server/src/workspaceRegistry.js';
import type { AppState } from '../core';

export type ApplicationWorkspacePortsFactory =
  (context: WorkspaceRuntimeContext<AppState>, vault: SecretVault) => OwnedWorkspaceFactoryPorts | Promise<OwnedWorkspaceFactoryPorts>;

export interface CloudApplicationRuntimeOptions {
  /** Required concrete per-workspace provider/integration composition. */
  readonly workspacePortsFor: ApplicationWorkspacePortsFactory;
}

/** Creates the Node host adapter. Missing provider composition is a startup error, never a stub. */
export function createCloudApplicationRuntimeFactory(options: CloudApplicationRuntimeOptions): ApplicationRuntimeFactory {
  if (!options || typeof options !== 'object' || typeof options.workspacePortsFor !== 'function') {
    throw new TypeError('application_workspace_ports_factory_required');
  }
  const factory: ApplicationRuntimeFactory = ({ kernel, vault, runtimeSessionFor }) => {
    const runtime = new OwnedWorkspaceRuntime({ kernel, runtimeSessionFor,
      crypto: {
        randomUUID,
        async sha256(value) { return createHash('sha256').update(value).digest('hex'); },
      },
      workspacePortsFor: (context) => options.workspacePortsFor(context, vault),
    });
    return Object.freeze({ workspaceApi: createWorkspaceHttpApi(runtime),
      stopAdmission: () => runtime.stopAdmission(),
      drainAndDispose: () => runtime.closeAfterDrain(),
    });
  };
  return factory;
}
