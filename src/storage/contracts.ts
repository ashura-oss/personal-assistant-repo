import type { AppState } from '../core';
import type { StartupRecoveryBackend } from './startupRecovery';
import type { ConsumePendingCapture, PendingCaptureBackend } from './pendingCapture';
import type { ServerPendingCaptureConsumption } from '../audio/pendingCaptureService.types';

export const STORAGE_KEY = 'voice-assistant.state.v1';
export const STATE_SNAPSHOT_READ_MAX_BYTES = 16 * 1024 * 1024;
export interface PersistedStateSnapshot {
  readonly raw: string;
  readonly schemaVersion: number;
}

export interface StateStore {
  load(): Promise<AppState | undefined>;
  /** Returns the exact bounded persisted JSON under the loaded generation without rebasing it. */
  readCurrentSnapshot?(): Promise<PersistedStateSnapshot | undefined>;
  save(state: AppState, options?: { consumePendingCapture?: ConsumePendingCapture; consumeServerPendingCapture?: ServerPendingCaptureConsumption }): Promise<void>;
  clear(): Promise<void>;
  /** Confirms that this store instance still owns the generation it loaded or wrote. */
  assertCurrent?(): Promise<void>;
  recovery?: StartupRecoveryBackend;
  pendingCapture?: PendingCaptureBackend;
}
