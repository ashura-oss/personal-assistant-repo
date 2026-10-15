import { useSyncExternalStore } from 'react';
import type { CloudOAuthCoordinator, CloudOAuthState } from './cloudOAuthCoordinator';

const EMPTY: CloudOAuthState = Object.freeze({ attempts: Object.freeze([]), loading: false });
export function useCloudOAuth(coordinator: CloudOAuthCoordinator | undefined): CloudOAuthState {
  return useSyncExternalStore(coordinator?.subscribe ?? (() => () => undefined), coordinator?.getSnapshot ?? (() => EMPTY), coordinator?.getSnapshot ?? (() => EMPTY));
}
