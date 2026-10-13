import type { BackgroundTaskBackend, BackgroundTaskStatus } from './backend.types';

const status: BackgroundTaskStatus = {
  platform: 'web',
  state: 'unsupported',
  registered: false,
  message: 'Background refresh is unavailable on the web.',
};

export const backgroundTaskBackend: BackgroundTaskBackend = {
  async getStatus() { return status; },
  async isRegistered() { return false; },
  async register() { return status; },
  async unregister() {},
  async addExpirationListener() { return { remove() {} }; },
};
