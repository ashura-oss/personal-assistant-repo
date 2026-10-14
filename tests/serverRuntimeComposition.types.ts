import { createHash, randomUUID } from 'node:crypto';
import type { AppState } from '../src/core';
import type { StateStore } from '../src/storage/contracts';
import { AppControllerImpl, type ControllerCryptoPort, type ControllerRuntimePorts } from '../src/services/controller.shared';
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
