import { useSyncExternalStore } from 'react';
import type { CloudMailCoordinator, CloudMailCoordinatorState } from './cloudMailCoordinator';

const EMPTY: CloudMailCoordinatorState = Object.freeze({});
const subscribeEmpty = () => () => undefined;
const getEmpty = () => EMPTY;

export function useCloudMail(coordinator?: CloudMailCoordinator): CloudMailCoordinatorState {
  return useSyncExternalStore(coordinator?.subscribe ?? subscribeEmpty, coordinator?.getSnapshot ?? getEmpty, coordinator?.getSnapshot ?? getEmpty);
}
