import { PrivacyEngine, PrivacyEngineError } from './engine';
import type {
  PrivacyCleanupPassResult,
  PrivacyControlStore,
  PrivacyEngineDependencies,
  PrivacyEraseAdapter,
  PrivacyErasePlan,
  PrivacyNamespace,
  PrivacyPublicStatus,
  PrivacyWriterDescriptor,
  PrivacyWriterLease,
  PrivacyWriterArbitration,
  PrivacyWriterScope,
} from './types';

export interface PrivacyWorkspaceSession {
  readonly epoch: string;
  readonly runtimeId: string;
}

export type PrivacyWorkspaceErrorCode = 'cleanup_in_progress' | 'stale_epoch' | 'control_unavailable' | 'unsupported_runtime';

const WORKSPACE_ERROR_MESSAGES: Record<PrivacyWorkspaceErrorCode, string> = {
  cleanup_in_progress: 'Local data cleanup is in progress. Finish or resume it before opening workspace data.',
  stale_epoch: 'This workspace session has expired. Reopen the app before continuing.',
  control_unavailable: 'Privacy control state is unavailable. It was preserved.',
  unsupported_runtime: 'Local privacy controls are unavailable in this app runtime. Workspace data was not opened.',
};

export class PrivacyWorkspaceError extends Error {
  readonly code: PrivacyWorkspaceErrorCode;
  constructor(code: PrivacyWorkspaceErrorCode) {
    super(WORKSPACE_ERROR_MESSAGES[code]);
    this.name = 'PrivacyWorkspaceError';
    this.code = code;
  }
}

export interface PrivacyService {
  openWorkspace(): Promise<PrivacyWorkspaceSession>;
  assertWorkspaceEpoch(expectedEpoch: string): Promise<void>;
  withWriter<T>(sessionEpoch: string, descriptor: PrivacyWriterDescriptor, actualCallback: (lease: PrivacyWriterLease, scope: PrivacyWriterScope) => Promise<T>): Promise<T>;
  withExistingWriter<T>(scope: PrivacyWriterScope, sessionEpoch: string, descriptor: PrivacyWriterDescriptor, actualIO: () => Promise<T>): Promise<T>;
  reconcileStartupWriters(): Promise<PrivacyPublicStatus>;
  getStatus(): Promise<PrivacyPublicStatus>;
  prepareErase(): Promise<PrivacyErasePlan>;
  cancelErase(sessionId: string): Promise<void>;
  commitErase(input: { sessionId: string; planHash: string }): Promise<void>;
  runCleanupPass(): Promise<PrivacyCleanupPassResult>;
  registerNamespace(sessionEpoch: string, namespace: PrivacyNamespace): Promise<void>;
  registerOAuthTokenRef(sessionEpoch: string, tokenRef: string): Promise<void>;
  registerLegacyMarkdownPath(sessionEpoch: string, path: string): Promise<void>;
}

export interface PrivacyServiceDependencies {
  controlStore: PrivacyControlStore;
  arbitration: PrivacyWriterArbitration;
  eraseAdapter: PrivacyEraseAdapter;
  now?: () => Date;
  uuid?: () => string;
}

export function createPrivacyService(dependencies: PrivacyServiceDependencies): PrivacyService {
  const engine = new PrivacyEngine({
    controlStore: dependencies.controlStore,
    arbitration: dependencies.arbitration,
    adapter: dependencies.eraseAdapter,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.uuid ? { uuid: dependencies.uuid } : {}),
  } satisfies PrivacyEngineDependencies);

  const read = async () => {
    try { return await dependencies.controlStore.read(); }
    catch { throw new PrivacyWorkspaceError('control_unavailable'); }
  };

  return {
    async openWorkspace() {
      const state = await read();
      if (state.cleanup && state.cleanup.status !== 'complete') throw new PrivacyWorkspaceError('cleanup_in_progress');
      let owner;
      try { owner = await dependencies.arbitration.getRuntimeOwner(); }
      catch { throw new PrivacyWorkspaceError('control_unavailable'); }
      if (!isCanonicalUuid(owner.runtimeId) || owner.platform === 'unsupported' || (owner.platform === 'ios' &&
          (!isCanonicalUuid(owner.processLaunchId) || owner.bundleIdentifier !== 'com.still.voiceassistant'))) {
        throw new PrivacyWorkspaceError('unsupported_runtime');
      }
      return Object.freeze({ epoch: state.epoch, runtimeId: owner.runtimeId });
    },
    async assertWorkspaceEpoch(expectedEpoch) {
      const state = await read();
      if (state.epoch !== expectedEpoch) throw new PrivacyWorkspaceError('stale_epoch');
      if (state.cleanup && state.cleanup.status !== 'complete') throw new PrivacyWorkspaceError('cleanup_in_progress');
    },
    async withWriter(sessionEpoch, descriptor, actualCallback) {
      const descriptorSnapshot = Object.freeze({ ...descriptor });
      await this.assertWorkspaceEpoch(sessionEpoch);
      try { return await engine.withWriter(sessionEpoch, descriptorSnapshot, actualCallback); }
      catch (error) {
        if (error instanceof PrivacyEngineError && error.code === 'stale_epoch') throw new PrivacyWorkspaceError('stale_epoch');
        if (error instanceof PrivacyEngineError && error.code === 'cleanup_in_progress') throw new PrivacyWorkspaceError('cleanup_in_progress');
        throw error;
      }
    },
    async withExistingWriter(scope, sessionEpoch, descriptor, actualIO) {
      try { return await engine.withExistingWriter(scope, sessionEpoch, descriptor, actualIO); }
      catch (error) {
        if (error instanceof PrivacyEngineError && error.code === 'stale_epoch') throw new PrivacyWorkspaceError('stale_epoch');
        if (error instanceof PrivacyEngineError && error.code === 'cleanup_in_progress') throw new PrivacyWorkspaceError('cleanup_in_progress');
        throw error;
      }
    },
    reconcileStartupWriters: () => engine.reconcileStartupWriters(),
    getStatus: () => engine.getStatus(),
    prepareErase: () => engine.prepareErase(),
    cancelErase: (sessionId) => engine.cancelErase(sessionId),
    commitErase: (input) => engine.commitErase(input),
    runCleanupPass: () => engine.runCleanupPass(),
    registerNamespace: (sessionEpoch, namespace) => engine.registerNamespace(sessionEpoch, namespace),
    registerOAuthTokenRef: (sessionEpoch, tokenRef) => engine.registerOAuthTokenRef(sessionEpoch, tokenRef),
    registerLegacyMarkdownPath: (sessionEpoch, path) => engine.registerLegacyMarkdownPath(sessionEpoch, path),
  };
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && value === value.toLowerCase() &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/**
 * Production loading is lazy so importing the app/controller does not open a database,
 * read credentials, inspect files, or request native modules.
 */
export async function createDefaultPrivacyService(): Promise<PrivacyService> {
  const [{ Platform }] = await Promise.all([import('react-native')]);
  if (Platform.OS === 'web') {
    const [storeModule, arbitrationModule, adapterModule] = await Promise.all([
      import('./controlStore.web'), import('./arbitration.web'), import('./eraseAdapter.web'),
    ]);
    return createPrivacyService({
      controlStore: new storeModule.IndexedDbPrivacyControlStore(),
      arbitration: arbitrationModule.createWebPrivacyArbitration(),
      eraseAdapter: adapterModule.createWebPrivacyEraseAdapter(),
    });
  }
  const [storeModule, arbitrationModule, adapterModule] = await Promise.all([
    import('./controlStore'), import('./arbitration'), import('./eraseAdapter'),
  ]);
  return createPrivacyService({
    controlStore: new storeModule.SQLitePrivacyControlStore(),
    arbitration: arbitrationModule.createNativePrivacyArbitration(),
    eraseAdapter: adapterModule.createPrivacyEraseAdapter(),
  });
}

let defaultPrivacyServicePromise: Promise<PrivacyService> | undefined;

/** Shared lazy control-plane instance for production workspaces in this process. */
export function getDefaultPrivacyService(): Promise<PrivacyService> {
  defaultPrivacyServicePromise ??= createDefaultPrivacyService().catch((error) => {
    defaultPrivacyServicePromise = undefined;
    throw error;
  });
  return defaultPrivacyServicePromise;
}
