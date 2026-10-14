import { createHash, randomUUID } from 'node:crypto';
import type { AppSettings, AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';
import { AppControllerImpl, type ControllerCryptoPort, type ControllerRuntimePorts } from '../src/services/controller.shared';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import type { createInitialWorkspaceState as BundledInitialWorkspaceStateFactory } from '../server/src/sharedControllerNode.mjs';
import { CommandJournal } from '../server/src/commandJournal';
import type { DurableKernel, OwnedWorkspaceIdentity } from '../server/src/kernel';
import { WorkspaceRegistry } from '../server/src/workspaceRegistry';
import { ServerWorkspaceStore } from '../server/src/workspaceStore';

/** Compile-only proof that the real server state adapter and Node ports compose with the shared controller. */
export function createTypedServerRuntime(
  kernel: DurableKernel,
  journal: CommandJournal,
  runtimeSessionToken: string,
  runtimeSessionFor: (identity: OwnedWorkspaceIdentity) => string,
  providers: ControllerRuntimePorts['providers'],
  integration: ControllerRuntimePorts['integration'],
): WorkspaceRegistry<AppControllerImpl, AppState> {
  const crypto: ControllerCryptoPort = {
    randomUUID,
    async sha256(value) { return createHash('sha256').update(value).digest('hex'); },
  };
  const standaloneStore = new ServerWorkspaceStore<AppState>({ kernel, sessionToken: runtimeSessionToken, journal });
  const stateStore: StateStore = standaloneStore;
  const standaloneController = new AppControllerImpl({ store: stateStore, crypto, providers, integration });
  void standaloneController;

  return new WorkspaceRegistry<AppControllerImpl, AppState>(kernel, journal, runtimeSessionFor, ({ store }) => {
    const sharedStore: StateStore = store;
    return new AppControllerImpl({ store: sharedStore, crypto, providers, integration });
  });
}

/** The generated server bundle's declaration stays compatible with the actual complete AppState factory. */
const bundledInitialWorkspaceStateFactory: typeof BundledInitialWorkspaceStateFactory = createInitialWorkspaceState;
const compatibleInitialSettings: Pick<AppSettings, 'mode' | 'llmProvider' | 'openRouterModel' | 'openRouterReasoningEffort' | 'llmRequestContractVersion'> = {
  mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
  openRouterReasoningEffort: 'low', llmRequestContractVersion: 1,
};
void compatibleInitialSettings;
void bundledInitialWorkspaceStateFactory;
