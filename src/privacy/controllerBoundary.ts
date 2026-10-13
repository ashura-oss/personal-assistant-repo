import type { AppController } from '../core';
import type { PrivacyService, PrivacyWorkspaceSession } from './service';

const SYNCHRONOUS_METHODS = new Set<PropertyKey>(['getSnapshot', 'subscribe']);

/**
 * Binds asynchronous controller calls to their opened workspace epoch. Actual
 * persistence and artifact I/O boundaries acquire writer leases themselves.
 */
export function createPrivacyBoundController(
  inner: AppController,
  privacy: PrivacyService,
  session: PrivacyWorkspaceSession,
): AppController {
  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (SYNCHRONOUS_METHODS.has(property)) return value.bind(target);
      if (property === 'disposeForPrivacy') return async () => {
        const status = await privacy.getStatus();
        if (!['erasing', 'paused', 'complete'].includes(status.phase) || status.epoch === session.epoch) {
          throw new Error('Local privacy cleanup must be durably committed before the workspace is cleared.');
        }
        return await (value as () => Promise<void>).call(target);
      };
      return async (...args: unknown[]) => {
        await privacy.assertWorkspaceEpoch(session.epoch);
        const result = await (value as (...input: unknown[]) => unknown).apply(target, args);
        await privacy.assertWorkspaceEpoch(session.epoch);
        return result;
      };
    },
  });
}
