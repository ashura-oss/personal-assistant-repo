import { Platform } from 'react-native';
import { isMatchingProactiveMailAlertNotification } from './mailAlertNotificationBackend';
import type { MailAlertTapBackend, MailAlertTapKey, MailAlertTapSubscription } from '../proactiveMailAlerts/taps';

// Expo Notifications 57's DEFAULT_ACTION_IDENTIFIER; keep module loading lazy below.
const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT';

export interface MailAlertTapBridge {
  addNotificationResponseReceivedListener(listener: (response: unknown) => void): { remove(): void };
  getLastNotificationResponseAsync(): Promise<unknown>;
}

export type MailAlertTapPlatform = 'ios' | 'android' | 'web' | 'mock';
export type MailAlertTapBackendOptions = {
  platform?: MailAlertTapPlatform;
  loadBridge?: () => Promise<MailAlertTapBridge>;
  withNotificationOwnership?: <T>(actual: () => Promise<T>) => Promise<T>;
};

type Row = Record<string, unknown>;
function isRecord(value: unknown): value is Row { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Drops the SDK response synchronously; no notification body or action text escapes this function. */
export function projectDefaultMailAlertTap(response: unknown, installationId: string): MailAlertTapKey | undefined {
  try {
    if (!UUID.test(installationId) || !isRecord(response) || response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER ||
        !isRecord(response.notification) || !isRecord(response.notification.request)) return undefined;
    const request = response.notification.request;
    if (!isRecord(request.content) || !isRecord(request.content.data)) return undefined;
    const receiptId = request.content.data.receiptId;
    if (typeof receiptId !== 'string' || !UUID.test(receiptId)) return undefined;
    const input = { installationId, receiptId };
    if (!isMatchingProactiveMailAlertNotification(input, { identifier: request.identifier, content: request.content })) return undefined;
    return Object.freeze({ installationId: installationId.toLowerCase(), receiptId: receiptId.toLowerCase() });
  } catch { return undefined; }
}

function platform(): MailAlertTapPlatform {
  return Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? Platform.OS : 'mock';
}

/** Expo response listener and cached response are each covered only for their actual native call. */
export function createMailAlertTapBackend(options: MailAlertTapBackendOptions = {}): MailAlertTapBackend {
  const currentPlatform = options.platform ?? platform();
  const ownership = options.withNotificationOwnership ?? (async <T,>(actual: () => Promise<T>) => actual());
  const loadBridge = options.loadBridge ?? (async () => await import('expo-notifications') as unknown as MailAlertTapBridge);
  const unavailable = currentPlatform === 'web';

  return Object.freeze({
    async subscribe(installationId: string, listener: (key: MailAlertTapKey) => void): Promise<MailAlertTapSubscription> {
      if (unavailable || !UUID.test(installationId)) throw new Error('Mail alert tap source is unavailable.');
      let subscription: { remove(): void } | undefined;
      let active = true;
      try {
        await ownership(async () => {
          const bridge = await loadBridge();
          subscription = bridge.addNotificationResponseReceivedListener((response) => {
            if (!active) return;
            const key = projectDefaultMailAlertTap(response, installationId);
            if (key) listener(key);
          });
        });
      } catch (error) {
        active = false;
        try { subscription?.remove(); } catch { /* Preserve ownership failure; listener is gated either way. */ }
        throw error;
      }
      if (!subscription) throw new Error('Mail alert tap listener was not installed.');
      let removed = false;
      return Object.freeze({ remove() { if (!removed) { removed = true; active = false; subscription?.remove(); } } });
    },
    async getLastResponse(installationId: string): Promise<MailAlertTapKey | undefined> {
      if (unavailable || !UUID.test(installationId)) return undefined;
      return ownership(async () => {
        const bridge = await loadBridge();
        const response = await bridge.getLastNotificationResponseAsync();
        return projectDefaultMailAlertTap(response, installationId);
      });
    },
  });
}
