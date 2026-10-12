import type { AppState } from '../core';

export interface StateStore {
  load(): Promise<AppState | undefined>;
  save(state: AppState): Promise<void>;
  clear(): Promise<void>;
}

export const STORAGE_KEY = 'voice-assistant.state.v1';
