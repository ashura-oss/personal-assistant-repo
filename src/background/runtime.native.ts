import type { OAuthTokenStore } from '../connectors';
import { type PrivacyService, type PrivacyWorkspaceSession } from '../privacy/service';
import { createPrivacyResourceBoundary } from '../privacy/resourceBoundary';
import { bindExistingWorkspaceWriter } from '../privacy/workspaceStorage';
import type { MailAlertNotificationBackend } from '../services/mailAlertNotificationBackend';
import type { StateStore } from '../storage/contracts';
import { createBackgroundMailRefreshEngine } from './mailRefresh';
import type { BackgroundMailRefreshEngineDependencies, BackgroundMailRefreshOutcome } from './mailRefresh.types';

export type BackgroundMailRefreshRuntimeDependencies = Readonly<{
  privacy: PrivacyService;
  createStateStore: () => StateStore;
  tokenStore: OAuthTokenStore;
  mailAlertBackend?: MailAlertNotificationBackend;
  createEngine?: (dependencies: BackgroundMailRefreshEngineDependencies) => { run(signal?: AbortSignal): Promise<BackgroundMailRefreshOutcome> };
}>;

/** Creates a headless runner. It never loads controller normalization or performs foreground bootstrap. */
export function createBackgroundMailRefreshRuntime(dependencies: BackgroundMailRefreshRuntimeDependencies) {
  let active: Promise<boolean> | undefined;
  const createEngine = dependencies.createEngine ?? createBackgroundMailRefreshEngine;

  async function perform(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    try {
      await dependencies.privacy.reconcileStartupWriters();
      if (signal.aborted) return false;
      const status = await dependencies.privacy.getStatus();
      if (status.phase !== 'ready' || status.activeWriterCount !== 0 ||
          status.pendingCleanupCount !== 0 || status.failedCleanupCount !== 0) return false;
      const session: PrivacyWorkspaceSession = await dependencies.privacy.openWorkspace();
      if (signal.aborted) return false;
      const current = await dependencies.privacy.getStatus();
      if (current.epoch !== session.epoch || current.phase !== 'ready' || current.activeWriterCount !== 0 ||
          current.pendingCleanupCount !== 0 || current.failedCleanupCount !== 0) return false;
      const resources = createPrivacyResourceBoundary({ privacy: dependencies.privacy, session });
      let mailAlertBackend = dependencies.mailAlertBackend;
      if (!mailAlertBackend) {
        const alerts = await import('../services/mailAlertNotificationBackend');
        mailAlertBackend = alerts.createMailAlertNotificationBackend();
      }
      const engine = createEngine({
        privacy: dependencies.privacy,
        session,
        createStateStore: dependencies.createStateStore,
        tokenStore: resources.oauthTokenStore(dependencies.tokenStore),
        withProviderOwnership: resources.withProviderOwnership,
        mailAlerts: {
          backend: mailAlertBackend,
          notificationWriter: {
            withNotificationWriter: (store, work) => resources.withMailAlertNotificationWriter((scope) =>
              work(scope, bindExistingWorkspaceWriter(store, dependencies.privacy, session, scope))),
          },
        },
      });
      const outcome = await engine.run(signal);
      // Safe skips (disabled, cooldown, no eligible accounts) complete without inviting retries.
      return outcome.status !== 'failed';
    } catch {
      return false;
    }
  }

  return Object.freeze({
    run(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
      if (active) return active;
      const job = perform(signal);
      const settled = job.finally(() => { if (active === settled) active = undefined; });
      active = settled;
      return settled;
    },
  });
}

let productionRuntimePromise: Promise<ReturnType<typeof createBackgroundMailRefreshRuntime>> | undefined;

/** Imports production stores only after an actual iOS task callback. */
export async function runProductionMailRefreshTask(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  productionRuntimePromise ??= (async () => {
    const [privacyModule, storeModule, tokenModule] = await Promise.all([
      import('../privacy/service'),
      import('../storage/platformStorage'),
      import('../auth/tokenStore'),
    ]);
    return createBackgroundMailRefreshRuntime({
      privacy: await privacyModule.getDefaultPrivacyService(),
      createStateStore: storeModule.createPlatformStateStore,
      tokenStore: tokenModule.oauthTokenStore,
    });
  })().catch((error) => {
    productionRuntimePromise = undefined;
    throw error;
  });
  const runtime = await productionRuntimePromise;
  if (signal.aborted) return false;
  return runtime.run(signal);
}
