export const MAIL_REFRESH_TASK_NAME = 'still.mail-refresh.v1' as const;
export const MAIL_REFRESH_MINIMUM_INTERVAL_MINUTES = 15 as const;
export const EXPO_BACKGROUND_TASK_IDENTIFIER = 'com.expo.modules.backgroundtask.processing' as const;
/** Cooperative JS admission/run budget; expiry still waits for real work settlement. */
export const MAIL_REFRESH_RUN_BUDGET_MS = 25_000 as const;

export type BackgroundTaskPlatform = 'ios' | 'android' | 'web' | 'unsupported';
export type BackgroundTaskAvailability = 'available' | 'restricted' | 'unavailable' | 'unsupported';
export type BackgroundTaskPublicState = 'available' | 'restricted' | 'unavailable' | 'unsupported' | 'registered' | 'disabled';

export interface BackgroundTaskStatus {
  platform: BackgroundTaskPlatform;
  state: BackgroundTaskPublicState;
  registered: boolean;
  /** Fixed user-safe explanation; never promises an execution interval. */
  message: string;
}

export interface BackgroundTaskExpirationSubscription {
  remove(): void;
}

export interface BackgroundTaskBackend {
  getStatus(): Promise<BackgroundTaskStatus>;
  isRegistered(): Promise<boolean>;
  register(): Promise<BackgroundTaskStatus>;
  unregister(beforeMutation?: () => Promise<void>): Promise<void>;
  addExpirationListener(listener: () => void): Promise<BackgroundTaskExpirationSubscription>;
}

export interface NativeBackgroundTaskApi {
  platform: BackgroundTaskPlatform;
  isAvailable(): Promise<boolean>;
  getAvailability(): Promise<BackgroundTaskAvailability>;
  isRegistered(taskName: string): Promise<boolean>;
  register(taskName: string, minimumIntervalMinutes: number): Promise<void>;
  unregister(taskName: string, beforeMutation?: () => Promise<void>): Promise<void>;
  addExpirationListener(listener: () => void): Promise<BackgroundTaskExpirationSubscription>;
}

export type MailRefreshTaskRunner = (signal: AbortSignal) => Promise<boolean>;
