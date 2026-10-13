import { Platform } from 'react-native';
import {
  MAIL_REFRESH_MINIMUM_INTERVAL_MINUTES,
  MAIL_REFRESH_TASK_NAME,
  type BackgroundTaskBackend,
  type BackgroundTaskAvailability,
  type BackgroundTaskStatus,
  type NativeBackgroundTaskApi,
} from './backend.types';

export interface NativeBackgroundTaskBackendOptions {
  api?: NativeBackgroundTaskApi;
}

const FIXED_MESSAGES = {
  available: 'Background refresh is available; iOS chooses when it runs.',
  restricted: 'Background refresh is restricted on this device or build.',
  unavailable: 'Background refresh is unavailable on this device or build.',
  unsupported: 'Background refresh is supported only by the iOS app.',
  registered: 'Background refresh is registered; iOS chooses when it runs.',
  disabled: 'Background refresh is not registered.',
} as const;

interface ExpoBackgroundTaskModule {
  getStatusAsync(): Promise<number>;
  registerTaskAsync(name: string, options: { minimumInterval: number }): Promise<void>;
  unregisterTaskAsync(name: string): Promise<void>;
  addExpirationListener(listener: () => void): { remove(): void };
}
interface ExpoTaskManagerModule {
  isAvailableAsync(): Promise<boolean>;
  isTaskRegisteredAsync(name: string): Promise<boolean>;
  isTaskDefined(name: string): boolean;
  unregisterTaskAsync(name: string): Promise<void>;
}

export function isNativeTaskRegistered(taskManager: Pick<ExpoTaskManagerModule, 'isTaskRegisteredAsync'>, taskName: string): Promise<boolean> {
  // Native persistence remains authoritative if a previous build's JS definition is absent.
  return taskManager.isTaskRegisteredAsync(taskName);
}

async function getExpoModules(): Promise<{ background: ExpoBackgroundTaskModule; taskManager: ExpoTaskManagerModule }> {
  const modulesCore = await import('expo-modules-core');
  if (!modulesCore.requireOptionalNativeModule('ExpoBackgroundTask') || !modulesCore.requireOptionalNativeModule('ExpoTaskManager')) {
    throw new Error('Native background-task modules unavailable.');
  }
  // Loading the JS wrappers only after native capability checks keeps unsupported builds safe.
  const [backgroundModule, taskManagerModule] = await Promise.all([import('expo-background-task'), import('expo-task-manager')]);
  return {
    background: backgroundModule as unknown as ExpoBackgroundTaskModule,
    taskManager: taskManagerModule as unknown as ExpoTaskManagerModule,
  };
}

async function getExpoTaskManager(): Promise<ExpoTaskManagerModule> {
  const modulesCore = await import('expo-modules-core');
  if (!modulesCore.requireOptionalNativeModule('ExpoTaskManager')) {
    throw new Error('Native task-manager module unavailable.');
  }
  const taskManagerModule = await import('expo-task-manager');
  return taskManagerModule as unknown as ExpoTaskManagerModule;
}

function createExpoApi(): NativeBackgroundTaskApi {
  return {
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unsupported',
    async isAvailable() {
      if (Platform.OS !== 'ios') return false;
      return (await getExpoModules()).taskManager.isAvailableAsync();
    },
    async getAvailability(): Promise<BackgroundTaskAvailability> {
      if (Platform.OS !== 'ios') return 'unsupported';
      const status = await (await getExpoModules()).background.getStatusAsync();
      return status === 2 ? 'available' : 'restricted';
    },
    async isRegistered(taskName) {
      return isNativeTaskRegistered(await getExpoTaskManager(), taskName);
    },
    async register(taskName, minimumIntervalMinutes) {
      const modules = await getExpoModules();
      if (!modules.taskManager.isTaskDefined(taskName)) throw new Error('Background task definition unavailable.');
      await modules.background.registerTaskAsync(taskName, { minimumInterval: minimumIntervalMinutes });
    },
    async unregister(taskName, beforeMutation) {
      const taskManager = await getExpoTaskManager();
      await beforeMutation?.();
      // The specialized background wrapper refuses unregister when iOS reports
      // background execution as restricted. TaskManager removes this exact
      // registration without the availability/configuration preflight.
      await taskManager.unregisterTaskAsync(taskName);
    },
    async addExpirationListener(listener) { return (await getExpoModules()).background.addExpirationListener(listener); },
  };
}

function fixedStatus(
  platform: BackgroundTaskStatus['platform'],
  state: BackgroundTaskStatus['state'],
  registered: boolean,
): BackgroundTaskStatus {
  return { platform, state, registered, message: FIXED_MESSAGES[state] };
}

export function createNativeBackgroundTaskBackend(options: NativeBackgroundTaskBackendOptions = {}): BackgroundTaskBackend {
  const api = options.api ?? createExpoApi();
  async function current(): Promise<BackgroundTaskStatus> {
    if (api.platform !== 'ios') return fixedStatus(api.platform, 'unsupported', false);
    try {
      if (!(await api.isAvailable())) return fixedStatus('ios', 'unavailable', false);
      const availability = await api.getAvailability();
      const registered = await api.isRegistered(MAIL_REFRESH_TASK_NAME);
      if (availability !== 'available') return fixedStatus('ios', availability, registered);
      return fixedStatus('ios', registered ? 'registered' : 'disabled', registered);
    } catch {
      return fixedStatus('ios', 'unavailable', false);
    }
  }
  return {
    getStatus: current,
    async isRegistered() {
      if (api.platform !== 'ios') return false;
      if (!(await api.isAvailable())) throw new Error('Background task API unavailable.');
      return api.isRegistered(MAIL_REFRESH_TASK_NAME);
    },
    async register() {
      const before = await current();
      if (before.platform !== 'ios' || before.state === 'unavailable' || before.state === 'restricted' || before.state === 'unsupported') return before;
      if (!before.registered) {
        await api.register(MAIL_REFRESH_TASK_NAME, MAIL_REFRESH_MINIMUM_INTERVAL_MINUTES);
      }
      return current();
    },
    async unregister(beforeMutation) {
      if (api.platform !== 'ios') return;
      if (await api.isRegistered(MAIL_REFRESH_TASK_NAME)) await api.unregister(MAIL_REFRESH_TASK_NAME, beforeMutation);
    },
    async addExpirationListener(listener) {
      return api.addExpirationListener(listener);
    },
  };
}

export const backgroundTaskBackend = createNativeBackgroundTaskBackend();
