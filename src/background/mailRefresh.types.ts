import type { OAuthTokenStore, MessageWindowSyncResult } from '../connectors';
import type { PrivacyService, PrivacyWorkspaceSession } from '../privacy/service';
import type { StateStore } from '../storage/contracts';

export type BackgroundMailRefreshOutcome = Readonly<{
  status: 'refreshed' | 'partial' | 'skipped' | 'failed';
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  reason?: 'privacy_not_ready' | 'state_unavailable' | 'disabled' | 'no_eligible_accounts' | 'cooldown' | 'deadline' | 'stale_state' | 'provider_unavailable';
}>;

export interface BackgroundMailConnector {
  syncMessageWindow(account: import('../core').Account, options: {
    timeMin: string;
    timeMax: string;
    pageSize: 5;
    signal: AbortSignal;
    guard: () => void;
    allowTokenRefresh: false;
  }): Promise<MessageWindowSyncResult>;
}

export type BackgroundMailRefreshEngineDependencies = Readonly<{
  privacy: Pick<PrivacyService, 'getStatus' | 'assertWorkspaceEpoch' | 'withWriter'>;
  session: PrivacyWorkspaceSession;
  /** Must construct a new raw store for each run; it must not invoke controller normalization. */
  createStateStore: () => StateStore;
  tokenStore: OAuthTokenStore;
  withProviderOwnership: <T>(actual: () => Promise<T>) => Promise<T>;
  connectorFactory?: (tokenStore: OAuthTokenStore, withProviderOwnership: <T>(actual: () => Promise<T>) => Promise<T>) => BackgroundMailConnector;
  now?: () => Date;
  uuid?: () => string;
  deadlineMs?: number;
}>;
