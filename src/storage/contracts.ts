import type { AppState } from '../core';
import type { StartupRecoveryBackend } from './startupRecovery';
import type { ConsumePendingCapture, PendingCaptureBackend } from './pendingCapture';

export interface StateStore {
  load(): Promise<AppState | undefined>;
  save(state: AppState, options?: { consumePendingCapture: ConsumePendingCapture }): Promise<void>;
  clear(): Promise<void>;
  /** Confirms that this store instance still owns the generation it loaded or wrote. */
  assertCurrent?(): Promise<void>;
  recovery?: StartupRecoveryBackend;
  pendingCapture?: PendingCaptureBackend;
}

export const STORAGE_KEY = 'voice-assistant.state.v1';
