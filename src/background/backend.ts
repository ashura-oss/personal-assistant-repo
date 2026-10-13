import type { BackgroundTaskBackend, BackgroundTaskStatus } from './backend.types';

const status: BackgroundTaskStatus = {
  platform: 'unsupported', state: 'unsupported', registered: false,
  message: 'Background refresh is unavailable on this platform.',
};

/** Non-native fallback. Platform-specific Metro files provide the real implementation. */
export const backgroundTaskBackend: BackgroundTaskBackend = {
  async getStatus() { return status; },
  async isRegistered() { return false; },
  async register() { return status; },
  async unregister() {},
  async addExpirationListener() { return { remove() {} }; },
};
