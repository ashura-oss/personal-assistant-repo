import { getPrivacyRuntimeOwner, isWebPrivacyRuntimeSupported } from './runtime.web';
import type { PrivacyWriterArbitration } from './types';

const LOCK_NAME = 'still-privacy-workspace-v1';
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export type WebPrivacyArbitrationErrorCode = 'unsupported_runtime' | 'wait_timeout' | 'lock_unavailable';

export class WebPrivacyArbitrationError extends Error {
  constructor(readonly code: WebPrivacyArbitrationErrorCode) {
    const message = code === 'unsupported_runtime'
      ? 'Privacy cleanup is unavailable in this browser.'
      : code === 'wait_timeout'
        ? 'Privacy work did not start before the wait limit.'
        : 'Privacy work could not acquire the browser lock.';
    super(message);
    this.name = 'WebPrivacyArbitrationError';
  }
}

export interface WebPrivacyArbitrationOptions {
  scope?: typeof globalThis;
  waitTimeoutMs?: number;
}

export function createWebPrivacyArbitration(
  options: WebPrivacyArbitrationOptions = {},
): PrivacyWriterArbitration {
  const scope = options.scope ?? globalThis;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const ownerReader = () => getPrivacyRuntimeOwner(scope);

  const withLock = async <T>(mode: 'shared' | 'exclusive', work: () => Promise<T>): Promise<T> => {
    if (!isWebPrivacyRuntimeSupported(scope) || typeof AbortController === 'undefined') {
      throw new WebPrivacyArbitrationError('unsupported_runtime');
    }
    const locks = scope.navigator.locks;
    const controller = new AbortController();
    let granted = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    timeout = setTimeout(() => {
      // Abort only an ungranted request. The timer is cleared as soon as the
      // lock callback starts, before user work begins.
      if (!granted) controller.abort();
    }, waitTimeoutMs);

    const request = locks.request(
      LOCK_NAME,
      { mode, signal: controller.signal },
      async (lock) => {
        if (!lock) throw new WebPrivacyArbitrationError('lock_unavailable');
        granted = true;
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        return await work();
      },
    );

    try {
      return await request;
    } catch (error) {
      if (error instanceof WebPrivacyArbitrationError) throw error;
      if (controller.signal.aborted) throw new WebPrivacyArbitrationError('wait_timeout');
      throw new WebPrivacyArbitrationError('lock_unavailable');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  return {
    getRuntimeOwner: ownerReader,
    withWriterLock: (work) => withLock('shared', work),
    withCleanupLock: (work) => withLock('exclusive', work),
  };
}

export { LOCK_NAME as PRIVACY_WEB_LOCK_NAME };
