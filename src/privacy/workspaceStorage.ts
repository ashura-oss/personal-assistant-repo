import type { StateStore } from '../storage/contracts';
import type { StartupRecoveryBackend } from '../storage/startupRecovery';
import type { PrivacyService, PrivacyWorkspaceSession } from './service';

/** Adds epoch-fenced leases around each real state-store or recovery operation. */
export function bindWorkspaceStorage(
  store: StateStore,
  privacy: PrivacyService,
  session: PrivacyWorkspaceSession,
): StateStore {
  const withStateWriter = <T>(work: () => Promise<T>) => privacy.withWriter(
    session.epoch,
    { kind: 'app_state', namespace: 'state_database' },
    async () => await work(),
  );
  const recovery = store.recovery ? bindRecovery(store.recovery, withStateWriter) : undefined;
  return {
    load: () => withStateWriter(() => store.load()),
    save: (state) => withStateWriter(() => store.save(state)),
    clear: () => withStateWriter(() => store.clear()),
    ...(store.assertCurrent ? { assertCurrent: () => withStateWriter(() => store.assertCurrent!()) } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function bindRecovery(
  backend: StartupRecoveryBackend,
  withWriter: <T>(work: () => Promise<T>) => Promise<T>,
): StartupRecoveryBackend {
  return {
    inspect: () => withWriter(() => backend.inspect()),
    prepare: () => withWriter(() => backend.prepare()),
    commit: (input, replacement) => withWriter(() => backend.commit(input, replacement)),
    acknowledgeOpened: (operationId) => withWriter(() => backend.acknowledgeOpened(operationId)),
  };
}
