import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { MAIL_REFRESH_RUN_BUDGET_MS, MAIL_REFRESH_TASK_NAME, type MailRefreshTaskRunner } from './backend.types';
import { backgroundTaskBackend } from './backend.native';

let runner: MailRefreshTaskRunner | undefined;
type NativeTaskBody = { error?: unknown };

/** Composition installs this only after a background-safe mail engine exists. */
export function setMailRefreshTaskRunner(next: MailRefreshTaskRunner | undefined): void {
  runner = next;
}

export async function executeMailRefreshWithExpiration(
  currentRunner: MailRefreshTaskRunner,
  addExpirationListener: (listener: () => void) => Promise<{ remove(): void }>,
  budgetMs: number = MAIL_REFRESH_RUN_BUDGET_MS,
): Promise<number> {
  const controller = new AbortController();
  let expiration: { remove(): void } | undefined;
  const boundedBudget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : MAIL_REFRESH_RUN_BUDGET_MS;
  const budget = setTimeout(() => controller.abort(), boundedBudget);
  try {
    expiration = await addExpirationListener(() => controller.abort());
    if (controller.signal.aborted) return 2;
    const succeeded = await currentRunner(controller.signal);
    return !controller.signal.aborted && succeeded ? 1 : 2;
  } catch {
    return 2;
  } finally {
    clearTimeout(budget);
    try { expiration?.remove(); } catch { /* The actual runner has settled; listener cleanup is best effort. */ }
  }
}

export function createMailRefreshTaskHandler(
  resolveRunner: () => Promise<MailRefreshTaskRunner>,
  addExpirationListener: (listener: () => void) => Promise<{ remove(): void }>,
  budgetMs: number = MAIL_REFRESH_RUN_BUDGET_MS,
): (body?: NativeTaskBody) => Promise<number> {
  let active: Promise<number> | undefined;
  return (body) => {
    if (body?.error !== undefined && body.error !== null) return Promise.resolve(2);
    if (active) return active;
    const currentRunner: MailRefreshTaskRunner = async (signal) => {
      if (signal.aborted) return false;
      const run = await resolveRunner();
      if (signal.aborted) return false;
      return run(signal);
    };
    const job = executeMailRefreshWithExpiration(currentRunner, addExpirationListener, budgetMs).catch(() => 2);
    const settled = job.finally(() => { if (active === settled) active = undefined; });
    active = settled;
    return settled;
  };
}

const defaultTaskHandler = createMailRefreshTaskHandler(
  async () => {
    if (runner) return runner;
    const runtime = await import('./runtime.native');
    return runtime.runProductionMailRefreshTask;
  },
  (listener) => backgroundTaskBackend.addExpirationListener(listener),
);

export function defineMailRefreshTaskIfSupported(
  platform: string,
  hasTaskManager: boolean,
  hasBackgroundTask: boolean,
  defineTask: (name: string, handler: (body?: NativeTaskBody) => Promise<number>) => void,
): boolean {
  if (platform !== 'ios' || !hasTaskManager || !hasBackgroundTask) return false;
  defineTask(MAIL_REFRESH_TASK_NAME, defaultTaskHandler);
  return true;
}

// Resolve the JS registry only when both custom modules are actually present (Expo Go may omit them).
if (Platform.OS === 'ios') {
  const hasTaskManager = !!requireOptionalNativeModule('ExpoTaskManager');
  const hasBackgroundTask = !!requireOptionalNativeModule('ExpoBackgroundTask');
  if (hasTaskManager && hasBackgroundTask) {
    // This synchronous global definition must happen during bundle initialization.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const taskManager = require('expo-task-manager') as typeof import('expo-task-manager');
    if (typeof taskManager.defineTask === 'function') {
      defineMailRefreshTaskIfSupported('ios', hasTaskManager, hasBackgroundTask, taskManager.defineTask);
    }
  }
}
