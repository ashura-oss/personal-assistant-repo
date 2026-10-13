import { SQLitePrivacyControlStore } from './controlStore';
import type { PrivacyCleanupTarget, PrivacyControlStore, PrivacyEraseAdapter, PrivacyOwner } from './types';
import { assertCleanupTarget, isUuid, PrivacyEraseAdapterError, safeRelativeMarkdownPath, validateCleanupEpoch } from './eraseAdapter.shared';
import { MAIL_REFRESH_TASK_NAME } from '../background/backend.types';

type FileInfo = { exists: boolean; isDirectory?: boolean };
export interface NativePrivacyEraseIO {
  documentDirectory?: string | null;
  cacheDirectory?: string | null;
  exists(uri: string): Promise<FileInfo>;
  deleteFile(uri: string): Promise<void>;
  deleteDirectory(uri: string): Promise<void>;
  deleteStateDatabase?(beforeMutation: () => Promise<void>): Promise<void>;
  verifyStateDatabaseGone?(): Promise<boolean>;
  deleteProviderCredential(kind: 'speech' | 'openai', beforeMutation: () => Promise<void>): Promise<void>;
  providerCredentialExists(kind: 'speech' | 'openai'): Promise<boolean>;
  deleteOAuthToken(tokenRef: string, beforeMutation: () => Promise<void>): Promise<void>;
  oauthTokenExists(tokenRef: string): Promise<boolean>;
  cancelAndDismissNotifications(beforeMutation: () => Promise<void>): Promise<void>;
  notificationsRemain(): Promise<boolean>;
  unregisterBackgroundTask(taskName: typeof MAIL_REFRESH_TASK_NAME, beforeMutation: () => Promise<void>): Promise<void>;
  backgroundTaskRegistered(taskName: typeof MAIL_REFRESH_TASK_NAME): Promise<boolean>;
}

export interface NativePrivacyEraseAdapterOptions {
  controlStore?: PrivacyControlStore;
  getOwner?: () => Promise<PrivacyOwner>;
  io?: NativePrivacyEraseIO;
}

type NotificationReadBridge = {
  getAllScheduledNotificationsAsync(): Promise<unknown>;
  getPresentedNotificationsAsync(): Promise<unknown>;
};

/** Wait for both native reads before releasing the cleanup writer, even if one fails early. */
export async function notificationsRemainFromBridge(bridge: NotificationReadBridge): Promise<boolean> {
  const [scheduled, presented] = await Promise.allSettled([
    Promise.resolve().then(() => bridge.getAllScheduledNotificationsAsync()),
    Promise.resolve().then(() => bridge.getPresentedNotificationsAsync()),
  ]);
  if (scheduled.status !== 'fulfilled' || presented.status !== 'fulfilled' ||
      !Array.isArray(scheduled.value) || !Array.isArray(presented.value)) {
    throw new PrivacyEraseAdapterError('target_unavailable');
  }
  return scheduled.value.length > 0 || presented.value.length > 0;
}

function supportedOwner(owner: PrivacyOwner): boolean {
  const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  return owner.platform === 'ios' && owner.bundleIdentifier === 'com.still.voiceassistant' &&
    uuid(owner.runtimeId) && uuid(owner.processLaunchId);
}

async function createDefaultIO(): Promise<NativePrivacyEraseIO> {
  const FileSystem = await import('expo-file-system/legacy');
  const documentDirectory = FileSystem.documentDirectory;
  const cacheDirectory = FileSystem.cacheDirectory;
  const info = async (uri: string): Promise<FileInfo> => {
    const result = await FileSystem.getInfoAsync(uri);
    return { exists: result.exists, isDirectory: result.exists && 'isDirectory' in result ? result.isDirectory : undefined };
  };
  return {
    documentDirectory,
    cacheDirectory,
    exists: info,
    async deleteFile(uri) {
      const current = await info(uri);
      if (current.exists && current.isDirectory) throw new Error('Expected an app-owned file.');
      if (current.exists) await FileSystem.deleteAsync(uri);
    },
    async deleteDirectory(uri) {
      const current = await info(uri);
      if (current.exists && !current.isDirectory) throw new Error('Expected an app-owned directory.');
      if (current.exists) await FileSystem.deleteAsync(uri);
    },
    async deleteStateDatabase(beforeMutation) {
      const storage = await import('../storage/platformStorage');
      await storage.eraseStateDatabaseForPrivacy(beforeMutation);
    },
    async verifyStateDatabaseGone() {
      const storage = await import('../storage/platformStorage');
      return await storage.privacyStateDatabaseGone();
    },
    async deleteProviderCredential(kind, beforeMutation) {
      const { deleteCredentials } = await import('../services/credentials');
      await beforeMutation();
      await deleteCredentials(kind);
    },
    async providerCredentialExists(kind) {
      const SecureStore = await import('expo-secure-store');
      return (await SecureStore.getItemAsync(kind === 'speech' ? 'azure.speech.subscription-key' : 'azure.openai.api-key')) !== null;
    },
    async deleteOAuthToken(tokenRef, beforeMutation) {
      const { deleteOAuthToken } = await import('../auth/tokenStore');
      await beforeMutation();
      await deleteOAuthToken(tokenRef);
    },
    async oauthTokenExists(tokenRef) {
      const SecureStore = await import('expo-secure-store');
      return (await SecureStore.getItemAsync(`still.oauth.${tokenRef}`)) !== null;
    },
    async cancelAndDismissNotifications(beforeMutation) {
      const Notifications = await import('expo-notifications');
      await beforeMutation();
      await Notifications.cancelAllScheduledNotificationsAsync();
      const presented = await Notifications.getPresentedNotificationsAsync();
      for (const notification of presented) {
        await beforeMutation();
        await Notifications.dismissNotificationAsync(notification.request.identifier);
      }
    },
    async notificationsRemain() {
      const Notifications = await import('expo-notifications');
      return notificationsRemainFromBridge(Notifications);
    },
    async unregisterBackgroundTask(taskName, beforeMutation) {
      if (taskName !== MAIL_REFRESH_TASK_NAME) throw new PrivacyEraseAdapterError('unsupported_target');
      await beforeMutation();
      const { backgroundTaskBackend } = await import('../background/backend.native');
      await backgroundTaskBackend.unregister(beforeMutation);
    },
    async backgroundTaskRegistered(taskName) {
      if (taskName !== MAIL_REFRESH_TASK_NAME) throw new PrivacyEraseAdapterError('unsupported_target');
      const { backgroundTaskBackend } = await import('../background/backend.native');
      const status = await backgroundTaskBackend.getStatus();
      if (status.state === 'unavailable' || status.state === 'unsupported') throw new PrivacyEraseAdapterError('target_unavailable');
      return backgroundTaskBackend.isRegistered();
    },
  };
}

function join(root: string | null | undefined, relative: string): string {
  if (!root || !root.startsWith('file://') || /[\u0000-\u001f]/.test(root) || root.includes('..')) {
    throw new PrivacyEraseAdapterError('target_unavailable');
  }
  return `${root.endsWith('/') ? root : `${root}/`}${relative}`;
}

async function removeDirectory(io: NativePrivacyEraseIO, uri: string): Promise<void> {
  const found = await io.exists(uri);
  if (found.exists && !found.isDirectory) throw new PrivacyEraseAdapterError('target_unavailable');
  if (found.exists) await io.deleteDirectory(uri);
}

async function removeFile(io: NativePrivacyEraseIO, uri: string): Promise<void> {
  const found = await io.exists(uri);
  if (found.exists && found.isDirectory) throw new PrivacyEraseAdapterError('target_unavailable');
  if (found.exists) await io.deleteFile(uri);
}

async function eraseNativeTarget(io: NativePrivacyEraseIO, target: PrivacyCleanupTarget, beforeMutation: () => Promise<void>): Promise<void> {
  if (target.kind === 'legacy_markdown') {
    if (!safeRelativeMarkdownPath(target.path)) throw new PrivacyEraseAdapterError('unsupported_target');
    await beforeMutation();
    await removeFile(io, join(io.documentDirectory, target.path));
    return;
  }
  if (target.kind === 'oauth_token') {
    if (!isUuid(target.tokenRef)) throw new PrivacyEraseAdapterError('unsupported_target');
    await io.deleteOAuthToken(target.tokenRef, beforeMutation);
    return;
  }
  switch (target.namespace) {
    case 'state_database':
      if (!io.deleteStateDatabase) throw new PrivacyEraseAdapterError('target_unavailable');
      await io.deleteStateDatabase(beforeMutation);
      return;
    case 'browser_audio':
      return; // IndexedDB audio is not present in the native iOS runtime.
    case 'native_recordings':
      await beforeMutation(); await removeDirectory(io, join(io.documentDirectory, 'ExpoAudio/'));
      return;
    case 'recovery_audio':
      await beforeMutation(); await removeDirectory(io, join(io.documentDirectory, 'recording-recovery/'));
      return;
    case 'speech_staging':
      await beforeMutation(); await removeDirectory(io, join(io.cacheDirectory, 'speech-upload/'));
      return;
    case 'picker_cache':
      await beforeMutation(); await removeDirectory(io, join(io.cacheDirectory, 'DocumentPicker/'));
      return;
    case 'markdown_mirrors':
      for (const folder of ['StillDocuments-v1/', 'memory/', 'logs/', 'notes/', 'people/', 'projects/']) {
        await beforeMutation();
        await removeDirectory(io, join(io.documentDirectory, folder));
      }
      return;
    case 'internal_export':
      await beforeMutation(); await removeFile(io, join(io.documentDirectory, 'still-export.json'));
      return;
    case 'provider_credentials':
      await io.deleteProviderCredential('speech', beforeMutation);
      await io.deleteProviderCredential('openai', beforeMutation);
      return;
    case 'notifications':
      await io.cancelAndDismissNotifications(beforeMutation);
      await io.unregisterBackgroundTask(MAIL_REFRESH_TASK_NAME, beforeMutation);
      return;
  }
}

async function verifyNativeTargetGone(io: NativePrivacyEraseIO, target: PrivacyCleanupTarget, cleanupEpoch: string, stateDeleteProofEpoch?: string): Promise<boolean> {
  if (target.kind === 'legacy_markdown') {
    if (!safeRelativeMarkdownPath(target.path)) return false;
    const found = await io.exists(join(io.documentDirectory, target.path));
    return !found.exists;
  }
  if (target.kind === 'oauth_token') return isUuid(target.tokenRef) && !(await io.oauthTokenExists(target.tokenRef));
  switch (target.namespace) {
    case 'state_database': return stateDeleteProofEpoch === cleanupEpoch && io.verifyStateDatabaseGone ? await io.verifyStateDatabaseGone() : false;
    case 'browser_audio': return true;
    case 'native_recordings': return !(await io.exists(join(io.documentDirectory, 'ExpoAudio/'))).exists;
    case 'recovery_audio': return !(await io.exists(join(io.documentDirectory, 'recording-recovery/'))).exists;
    case 'speech_staging': return !(await io.exists(join(io.cacheDirectory, 'speech-upload/'))).exists;
    case 'picker_cache': return !(await io.exists(join(io.cacheDirectory, 'DocumentPicker/'))).exists;
    case 'markdown_mirrors':
      for (const folder of ['StillDocuments-v1/', 'memory/', 'logs/', 'notes/', 'people/', 'projects/']) {
        if ((await io.exists(join(io.documentDirectory, folder))).exists) return false;
      }
      return true;
    case 'internal_export': return !(await io.exists(join(io.documentDirectory, 'still-export.json'))).exists;
    case 'provider_credentials': return !(await io.providerCredentialExists('speech')) && !(await io.providerCredentialExists('openai'));
    case 'notifications': return !(await io.notificationsRemain()) && !(await io.backgroundTaskRegistered(MAIL_REFRESH_TASK_NAME));
  }
}

/** Lazy iOS-only adapter. Every operation revalidates the independent cleanup journal and runtime. */
export function createPrivacyEraseAdapter(options: NativePrivacyEraseAdapterOptions = {}): PrivacyEraseAdapter {
  const store = options.controlStore ?? new SQLitePrivacyControlStore();
  const ownerReader = options.getOwner ?? (async () => (await import('./runtime')).getPrivacyRuntimeOwner());
  let defaultIO: Promise<NativePrivacyEraseIO> | undefined;
  let stateDeleteProofEpoch: string | undefined;
  const getIO = () => options.io ? Promise.resolve(options.io) : (defaultIO ??= createDefaultIO());
  const authorize = async (target: PrivacyCleanupTarget, epoch: string) => {
    validateCleanupEpoch(epoch);
    await assertCleanupTarget(store, target, epoch);
    let owner: PrivacyOwner;
    try { owner = await ownerReader(); } catch { throw new PrivacyEraseAdapterError('unsupported_target'); }
    if (!supportedOwner(owner)) throw new PrivacyEraseAdapterError('unsupported_target');
    return getIO();
  };
  return {
    async erase(target, cleanupEpoch) {
      const io = await authorize(target, cleanupEpoch);
      if (target.kind === 'namespace' && target.namespace === 'state_database') stateDeleteProofEpoch = undefined;
      const beforeMutation = async () => { await authorize(target, cleanupEpoch); };
      await eraseNativeTarget(io, target, beforeMutation);
      if (target.kind === 'namespace' && target.namespace === 'state_database') stateDeleteProofEpoch = cleanupEpoch;
    },
    async verifyGone(target, cleanupEpoch) {
      const io = await authorize(target, cleanupEpoch);
      return verifyNativeTargetGone(io, target, cleanupEpoch, stateDeleteProofEpoch);
    },
  };
}

export { PrivacyEraseAdapterError } from './eraseAdapter.shared';
