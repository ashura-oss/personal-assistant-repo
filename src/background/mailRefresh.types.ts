import type { OAuthTokenStore, MessageWindowSyncResult } from '../connectors';
import type { PrivacyService, PrivacyWorkspaceSession } from '../privacy/service';
import type { StateStore } from '../storage/contracts';
import type { PrivacyWriterScope } from '../privacy/types';
import type { MailAlertNotificationBackend } from '../services/mailAlertNotificationBackend';
import type { ExistingWorkspaceWriterStore } from '../privacy/workspaceStorage';
import type { ProviderResponseLifetime } from '../services/providerResponseLifetime';

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

export interface BackgroundMailAlertWriter {
  withNotificationWriter<T>(
    store: StateStore,
    work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>,
  ): Promise<T>;
}

export type BackgroundMailRefreshEngineDependencies = Readonly<{
  privacy: Pick<PrivacyService, 'getStatus' | 'assertWorkspaceEpoch' | 'withWriter'>;
  session: PrivacyWorkspaceSession;
  /** Must construct a new raw store for each run; it must not invoke controller normalization. */
  createStateStore: () => StateStore;
  tokenStore: OAuthTokenStore;
  withProviderOwnership: <T>(actual: () => Promise<T>) => Promise<T>;
  withResponseLifetime?: ProviderResponseLifetime;
  /** Optional headless alert execution; automatic runs never request permission. */
  mailAlerts?: Readonly<{
    backend: MailAlertNotificationBackend;
    notificationWriter: BackgroundMailAlertWriter;
    /** Closed deterministic test seam; production leaves this as the platform SHA-256 digest. */
    digest?: (text: string) => Promise<string>;
  }>;
  connectorFactory?: (tokenStore: OAuthTokenStore, withProviderOwnership: <T>(actual: () => Promise<T>) => Promise<T>, withResponseLifetime?: ProviderResponseLifetime) => BackgroundMailConnector;
  now?: () => Date;
  uuid?: () => string;
  deadlineMs?: number;
}>;
