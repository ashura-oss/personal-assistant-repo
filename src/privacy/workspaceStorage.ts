import type { StateStore } from '../storage/contracts';
import type { ConsumePendingCapture } from '../storage/pendingCapture';
import type { StartupRecoveryBackend } from '../storage/startupRecovery';
import type { PrivacyWriterScope } from './types';
import type { PrivacyService, PrivacyWorkspaceSession } from './service';

/** Narrow child-store surface available while an existing privacy writer is active. */
export interface ExistingWorkspaceWriterStore {
  load(): Promise<Awaited<ReturnType<StateStore['load']>>>;
  save(state: Parameters<StateStore['save']>[0], options?: Parameters<StateStore['save']>[1]): Promise<void>;
  assertCurrent(): Promise<void>;
}

/** Adds epoch-fenced leases around each real state-store or recovery operation. */
export function bindWorkspaceStorage(
  store: StateStore,
  privacy: PrivacyService,
  session: PrivacyWorkspaceSession,
): StateStore {
  const sessionEpoch = String(session.epoch);
  const capturedSession = Object.freeze({ epoch: sessionEpoch, runtimeId: String(session.runtimeId) });
  const withStateWriter = <T>(work: () => Promise<T>) => privacy.withWriter(
    capturedSession.epoch,
    { kind: 'app_state', namespace: 'state_database' },
    async () => await work(),
  );
  const recovery = store.recovery ? bindRecovery(store.recovery, withStateWriter) : undefined;
  return {
    load: () => withStateWriter(() => store.load()),
    save: (state: Parameters<StateStore['save']>[0], options?: Parameters<StateStore['save']>[1]) => {
      const consumePendingCapture: ConsumePendingCapture | undefined = options?.consumePendingCapture
        ? Object.freeze({ ...options.consumePendingCapture })
        : undefined;
      return withStateWriter(() => store.save(state, consumePendingCapture ? { consumePendingCapture } : undefined));
    },
    clear: () => withStateWriter(() => store.clear()),
    ...(store.assertCurrent ? { assertCurrent: () => withStateWriter(() => store.assertCurrent!()) } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

/**
 * Provides state I/O under a writer already acquired by the caller. Each method
 * is admitted through the opaque scope; this adapter deliberately has no clear,
 * recovery, pending-capture, or raw-store escape hatch.
 */
export function bindExistingWorkspaceWriter(
  store: StateStore,
  privacy: PrivacyService,
  session: PrivacyWorkspaceSession,
  scope: PrivacyWriterScope,
): ExistingWorkspaceWriterStore {
  const capturedSession = Object.freeze({ epoch: String(session.epoch), runtimeId: String(session.runtimeId) });
  const capturedScope = scope;
  const descriptor = Object.freeze({ kind: 'app_state' as const, namespace: 'state_database' as const });
  const load = store.load.bind(store);
  const save = store.save.bind(store);
  const assertCurrent = store.assertCurrent?.bind(store);
  const copyState = (state: Parameters<StateStore['save']>[0]) => cloneState(state);
  const copyOptions = (options: Parameters<StateStore['save']>[1]) => options?.consumePendingCapture
    ? { consumePendingCapture: { ...options.consumePendingCapture } }
    : undefined;
  const withChild = <T>(actualIO: () => Promise<T>) => privacy.withExistingWriter(
    capturedScope,
    capturedSession.epoch,
    descriptor,
    actualIO,
  );

  return Object.freeze({
    load: () => withChild(load),
    save: (state: Parameters<StateStore['save']>[0], options?: Parameters<StateStore['save']>[1]) => {
      const stateSnapshot = copyState(state);
      const optionsSnapshot = copyOptions(options);
      return withChild(() => save(stateSnapshot, optionsSnapshot));
    },
    assertCurrent: () => withChild(async () => {
      if (!assertCurrent) throw new Error('Workspace storage ownership cannot be checked.');
      await assertCurrent();
    }),
  });
}

function cloneState<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
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
