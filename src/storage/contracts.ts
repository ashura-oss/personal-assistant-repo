import type { AppState } from '../core';
import type { StartupRecoveryBackend } from './startupRecovery';

export interface StateStore {
  load(): Promise<AppState | undefined>;
  save(state: AppState): Promise<void>;
  clear(): Promise<void>;
  /** Confirms that this store instance still owns the generation it loaded or wrote. */
  assertCurrent?(): Promise<void>;
  recovery?: StartupRecoveryBackend;
}

export const STORAGE_KEY = 'voice-assistant.state.v1';
