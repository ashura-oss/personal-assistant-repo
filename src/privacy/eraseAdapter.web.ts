import { IndexedDbPrivacyControlStore } from './controlStore.web';
import { getPrivacyRuntimeOwner, isWebPrivacyRuntimeSupported } from './runtime.web';
import type { PrivacyCleanupTarget, PrivacyControlStore, PrivacyEraseAdapter, PrivacyOwner } from './types';
import { assertCleanupTarget, isUuid, PrivacyEraseAdapterError, safeRelativeMarkdownPath, validateCleanupEpoch } from './eraseAdapter.shared';
import { browserDatabaseGeneration, closeBrowserDatabaseConnections } from '../storage/browserDatabaseRegistry';

const AUDIO_DATABASE = 'still-audio-v1';

export interface WebPrivacyEraseIO {
  supported(): boolean;
  deleteStateDatabase(beforeMutation: () => Promise<void>): Promise<void>;
  stateDatabaseGone(): Promise<boolean>;
  deleteDatabase(name: 'voice-assistant' | 'still-audio-v1', beforeMutation: () => Promise<void>): Promise<void>;
  databaseDeletionConfirmed(name: 'voice-assistant' | 'still-audio-v1'): boolean;
  deleteProviderCredential(kind: 'speech' | 'openai' | 'openrouter', beforeMutation: () => Promise<void>): Promise<void>;
  providerCredentialExists(kind: 'speech' | 'openai' | 'openrouter'): Promise<boolean>;
  deleteOAuthToken(tokenRef: string, beforeMutation: () => Promise<void>): Promise<void>;
  oauthTokenExists(tokenRef: string): Promise<boolean>;
}

export interface WebPrivacyEraseAdapterOptions {
  controlStore?: PrivacyControlStore;
  io?: WebPrivacyEraseIO;
  getOwner?: () => Promise<PrivacyOwner>;
}

function createDefaultWebIO(): WebPrivacyEraseIO {
  const factory = globalThis.indexedDB;
  const deletedDatabaseGenerations = new Map<string, number>();
  const deleteDatabase = async (name: string, beforeMutation: () => Promise<void>) => {
    await beforeMutation();
    closeBrowserDatabaseConnections(name);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => { deletedDatabaseGenerations.set(name, browserDatabaseGeneration(name)); if (!settled) { settled = true; resolve(); } };
      request.onerror = () => { if (!settled) { settled = true; reject(new PrivacyEraseAdapterError('target_unavailable')); } };
      request.onblocked = () => { /* Retain the request and cleanup lock until it settles. */ };
    });
  };
  return {
    supported: () => isWebPrivacyRuntimeSupported(),
    async deleteStateDatabase(beforeMutation) {
      const storage = await import('../storage/platformStorage.web');
      await storage.eraseStateDatabaseForPrivacy(beforeMutation);
    },
    async stateDatabaseGone() {
      const storage = await import('../storage/platformStorage.web');
      return storage.privacyStateDatabaseGone();
    },
    deleteDatabase: (name, beforeMutation) => deleteDatabase(name, beforeMutation),
    databaseDeletionConfirmed: (name) => deletedDatabaseGenerations.get(name) === browserDatabaseGeneration(name) && deletedDatabaseGenerations.has(name),
    async deleteProviderCredential(kind, beforeMutation) {
      const { deleteCredentials } = await import('../services/credentials');
      await beforeMutation();
      await deleteCredentials(kind);
    },
    async providerCredentialExists(kind) {
      const { getCredentials } = await import('../services/credentials');
      const status = await getCredentials();
      return kind === 'speech' ? status.speechConfigured : kind === 'openai' ? status.openAiConfigured : status.openRouterConfigured === true;
    },
    async deleteOAuthToken(tokenRef, beforeMutation) {
      const { deleteOAuthToken } = await import('../auth/tokenStore');
      await beforeMutation();
      await deleteOAuthToken(tokenRef);
    },
    async oauthTokenExists(tokenRef) {
      const { oauthTokenStore } = await import('../auth/tokenStore');
      return (await oauthTokenStore.get(tokenRef)) !== null;
    },
  };
}

async function eraseWebTarget(io: WebPrivacyEraseIO, target: PrivacyCleanupTarget, beforeMutation: () => Promise<void>): Promise<void> {
  if (target.kind === 'legacy_markdown') {
    if (!safeRelativeMarkdownPath(target.path)) throw new PrivacyEraseAdapterError('unsupported_target');
    return; // Legacy mirror paths exist only in the app-state database on web.
  }
  if (target.kind === 'oauth_token') {
    if (!isUuid(target.tokenRef)) throw new PrivacyEraseAdapterError('unsupported_target');
    await io.deleteOAuthToken(target.tokenRef, beforeMutation);
    return;
  }
  switch (target.namespace) {
    case 'state_database': await io.deleteStateDatabase(beforeMutation); return;
    case 'browser_audio': await io.deleteDatabase(AUDIO_DATABASE, beforeMutation); return;
    case 'native_recordings':
    case 'picker_cache': return; // These namespaces have no persistent browser implementation.
    case 'speech_staging': {
      await beforeMutation();
      const staging = await import('../audio/speechUpload.web');
      await beforeMutation();
      staging.clearSpeechStagingMemory();
      if (staging.speechStagingMemoryCount() !== 0) throw new PrivacyEraseAdapterError('target_unavailable');
      return;
    }
    case 'markdown_mirrors': return; // Markdown documents are inside the app-state database on web.
    case 'internal_export':
    case 'notifications': return; // Browser notifications/background work are not owned by this app backend.
    case 'recovery_audio': return; // Stored in still-audio-v1, removed by browser_audio.
    case 'provider_credentials':
      {
        const results = await Promise.allSettled((['speech', 'openai', 'openrouter'] as const).map(async (kind) => io.deleteProviderCredential(kind, beforeMutation)));
        if (results.some((result) => result.status === 'rejected')) throw new PrivacyEraseAdapterError('target_unavailable');
      }
      return;
  }
}

async function priorNamespaceComplete(store: PrivacyControlStore, epoch: string, namespace: string): Promise<boolean> {
  const state = await store.read();
  return state.cleanup?.epoch === epoch && state.cleanup.steps.some((step) =>
    step.target.kind === 'namespace' && step.target.namespace === namespace && step.status === 'complete');
}

async function webTargetGone(io: WebPrivacyEraseIO, target: PrivacyCleanupTarget, store: PrivacyControlStore, epoch: string, stateDeleteProofEpoch?: string): Promise<boolean> {
  if (target.kind === 'legacy_markdown') {
    if (!safeRelativeMarkdownPath(target.path)) return false;
    return priorNamespaceComplete(store, epoch, 'state_database');
  }
  if (target.kind === 'oauth_token') return isUuid(target.tokenRef) && !(await io.oauthTokenExists(target.tokenRef));
  switch (target.namespace) {
    case 'state_database': return stateDeleteProofEpoch === epoch && io.stateDatabaseGone();
    case 'browser_audio': return io.databaseDeletionConfirmed(AUDIO_DATABASE);
    case 'native_recordings':
    case 'picker_cache':
    case 'internal_export':
    case 'notifications': return true;
    case 'markdown_mirrors': return await priorNamespaceComplete(store, epoch, 'state_database');
    case 'recovery_audio': return await priorNamespaceComplete(store, epoch, 'browser_audio');
    case 'speech_staging': {
      const staging = await import('../audio/speechUpload.web');
      return staging.speechStagingMemoryCount() === 0;
    }
    case 'provider_credentials': {
      const results = await Promise.allSettled((['speech', 'openai', 'openrouter'] as const).map(async (kind) => io.providerCredentialExists(kind)));
      return results.every((result) => result.status === 'fulfilled' && !result.value);
    }
  }
}

/** Lazy browser adapter; blocked database deletion is an error and never reported as completion. */
export function createWebPrivacyEraseAdapter(options: WebPrivacyEraseAdapterOptions = {}): PrivacyEraseAdapter {
  const store = options.controlStore ?? new IndexedDbPrivacyControlStore();
  const io = options.io ?? createDefaultWebIO();
  const ownerReader = options.getOwner ?? getPrivacyRuntimeOwner;
  let stateDeleteProofEpoch: string | undefined;
  const authorize = async (target: PrivacyCleanupTarget, epoch: string) => {
    validateCleanupEpoch(epoch);
    await assertCleanupTarget(store, target, epoch);
    try {
      const owner = await ownerReader();
      if (owner.platform !== 'web' || !io.supported()) throw new PrivacyEraseAdapterError('unsupported_target');
    } catch (error) {
      if (error instanceof PrivacyEraseAdapterError) throw error;
      throw new PrivacyEraseAdapterError('unsupported_target');
    }
  };
  return {
    async erase(target, cleanupEpoch) {
      await authorize(target, cleanupEpoch);
      if (target.kind === 'namespace' && target.namespace === 'state_database') stateDeleteProofEpoch = undefined;
      const beforeMutation = () => authorize(target, cleanupEpoch);
      await eraseWebTarget(io, target, beforeMutation);
      if (target.kind === 'namespace' && target.namespace === 'state_database') stateDeleteProofEpoch = cleanupEpoch;
    },
    async verifyGone(target, cleanupEpoch) { await authorize(target, cleanupEpoch); return webTargetGone(io, target, store, cleanupEpoch, stateDeleteProofEpoch); },
  };
}

export { PrivacyEraseAdapterError } from './eraseAdapter.shared';
