import type { CredentialStore } from '../storage/credentials';
import type { OAuthTokenStore } from '../connectors';
import type { NotificationBackend, ForegroundNotificationProjection, PendingNotificationRequest } from '../services/notificationBackend';
import type { DeviceCalendarBackend } from '../services/deviceCalendarBackend';
import type { DeviceCalendarReadWindow, DeviceCalendarRow, DeviceEventDispatchRecord } from '../deviceCalendars';
import type { BackgroundTaskBackend, BackgroundTaskExpirationSubscription } from '../background/backend.types';
import type { LegacyReminderCancellation, ReminderIntent } from '../reminders';
import type { PrivacyService, PrivacyWorkspaceSession } from './service';
import type { PrivacyWriterDescriptor, PrivacyWriterScope } from './types';

const CREDENTIAL_KEYS = new Set(['azure.speech.subscription-key', 'azure.openai.api-key']);

export interface PrivacyResourceBinding {
  readonly privacy: PrivacyService;
  readonly session: PrivacyWorkspaceSession;
}

function snapshotBinding(binding: PrivacyResourceBinding): PrivacyResourceBinding {
  return Object.freeze({
    privacy: binding.privacy,
    session: Object.freeze({ epoch: binding.session.epoch, runtimeId: binding.session.runtimeId }),
  });
}

function underWriter<T>(binding: PrivacyResourceBinding, descriptor: PrivacyWriterDescriptor, actual: () => Promise<T>): Promise<T> {
  return binding.privacy.withWriter(binding.session.epoch, descriptor, async () => {
    let result: T;
    try { result = await actual(); }
    catch (error) {
      await binding.privacy.assertWorkspaceEpoch(binding.session.epoch);
      throw error;
    }
    await binding.privacy.assertWorkspaceEpoch(binding.session.epoch);
    return result;
  });
}

/** Each operation owns the provider-credential namespace only for the actual key-store promise. */
export function createPrivacyBoundCredentialStore(raw: CredentialStore, input: PrivacyResourceBinding): CredentialStore {
  const binding = snapshotBinding(input);
  const descriptor: PrivacyWriterDescriptor = { kind: 'provider_credential', namespace: 'provider_credentials' };
  const checkKey = (key: string) => {
    if (!CREDENTIAL_KEYS.has(key)) throw new Error('This credential is outside the provider credential store.');
  };
  return Object.freeze({
    get(key: string) { checkKey(key); return underWriter(binding, descriptor, () => raw.get(key)); },
    set(key: string, value: string) { checkKey(key); return underWriter(binding, descriptor, () => raw.set(key, value)); },
    delete(key: string) { checkKey(key); return underWriter(binding, descriptor, () => raw.delete(key)); },
  });
}

export interface PrivacyBoundOAuthTokenStore extends OAuthTokenStore {
  delete(tokenRef: string): Promise<void>;
}

export interface PrivacyBoundDeviceCalendarBackend {
  readonly backend: DeviceCalendarBackend;
  dispose(): void;
}

/** Holds the local-state writer lease through each native permission/read/write promise. */
export function bindPrivacyDeviceCalendarBackend(raw: DeviceCalendarBackend, input: PrivacyResourceBinding): PrivacyBoundDeviceCalendarBackend {
  const binding = snapshotBinding(input);
  const descriptor: PrivacyWriterDescriptor = { kind: 'app_state', namespace: 'state_database' };
  let active = true;
  const run = <T>(actual: () => Promise<T>) => {
    if (!active) return Promise.reject(new Error('This workspace device-calendar session has ended.'));
    return underWriter(binding, descriptor, actual);
  };
  const backend: DeviceCalendarBackend = {
    platform: raw.platform,
    getPermission: () => run(() => raw.getPermission()),
    requestFullPermission: () => run(() => raw.requestFullPermission()),
    listCalendars: (previous?: readonly DeviceCalendarRow[]) => run(() => raw.listCalendars(previous)),
    getCalendar: (nativeId: string, previous?: DeviceCalendarRow) => run(() => raw.getCalendar(nativeId, previous)),
    readEvents: (calendarLocalId: string, nativeCalendarId: string, window: DeviceCalendarReadWindow, observedAt: string, generation: number) =>
      run(() => raw.readEvents(calendarLocalId, nativeCalendarId, window, observedAt, generation)),
    createApprovedEvent: (record: DeviceEventDispatchRecord, beforeCreate: () => boolean) =>
      run(() => raw.createApprovedEvent(record, () => active && beforeCreate())),
    lookupRecord: (record: DeviceEventDispatchRecord) => run(() => raw.lookupRecord(record)),
  };
  Object.freeze(backend);
  return Object.freeze({ backend, dispose() { active = false; } });
}

/** Token references are bound into the independent cleanup manifest before each store operation. */
export function createPrivacyBoundOAuthTokenStore(raw: OAuthTokenStore & { delete?: (tokenRef: string) => Promise<void> }, input: PrivacyResourceBinding): PrivacyBoundOAuthTokenStore {
  const binding = snapshotBinding(input);
  const descriptor = (tokenRef: string): PrivacyWriterDescriptor => ({
    kind: 'provider_credential', namespace: 'provider_credentials', oauthTokenRef: tokenRef,
  });
  return Object.freeze({
    get(tokenRef: string) { return underWriter(binding, descriptor(tokenRef), () => raw.get(tokenRef)); },
    set(tokenRef: string, token: Parameters<OAuthTokenStore['set']>[1]) { return underWriter(binding, descriptor(tokenRef), () => raw.set(tokenRef, token)); },
    delete(tokenRef: string) {
      if (!raw.delete) return Promise.reject(new Error('This token store does not support owned deletion.'));
      return underWriter(binding, descriptor(tokenRef), () => raw.delete!(tokenRef));
    },
  });
}

export interface PrivacyBoundNotificationBackend {
  readonly backend: NotificationBackend;
  /** Synchronously disables a previously installed foreground callback for this workspace. */
  dispose(): void;
}

export interface PrivacyBoundBackgroundTaskBackend {
  readonly backend: BackgroundTaskBackend;
  dispose(): void;
}

/** Keeps task registration and status reads inside the existing notification cleanup namespace. */
export function bindPrivacyBackgroundTaskBackend(raw: BackgroundTaskBackend, input: PrivacyResourceBinding): PrivacyBoundBackgroundTaskBackend {
  const binding = snapshotBinding(input);
  const descriptor: PrivacyWriterDescriptor = { kind: 'notification', namespace: 'notifications' };
  let active = true;
  const run = <T>(actual: () => Promise<T>) => {
    if (!active) return Promise.reject(new Error('This workspace background-task session has ended.'));
    return underWriter(binding, descriptor, actual);
  };
  const backend: BackgroundTaskBackend = {
    getStatus: () => run(() => raw.getStatus()),
    isRegistered: () => run(() => raw.isRegistered()),
    register: () => run(() => raw.register()),
    unregister: (beforeMutation?: () => Promise<void>) => run(() => raw.unregister(beforeMutation ? async () => {
      if (!active) throw new Error('This workspace background-task session has ended.');
      await binding.privacy.assertWorkspaceEpoch(binding.session.epoch);
      await beforeMutation();
      if (!active) throw new Error('This workspace background-task session has ended.');
    } : undefined)),
    addExpirationListener: (listener: () => void): Promise<BackgroundTaskExpirationSubscription> =>
      run(() => raw.addExpirationListener(() => active && listener())),
  };
  Object.freeze(backend);
  return Object.freeze({ backend, dispose() { active = false; } });
}

/** Holds notification writer ownership through each native request, including a delayed schedule. */
export function bindPrivacyNotificationBackend(raw: NotificationBackend, input: PrivacyResourceBinding): PrivacyBoundNotificationBackend {
  const binding = snapshotBinding(input);
  const descriptor: PrivacyWriterDescriptor = { kind: 'notification', namespace: 'notifications' };
  let active = true;
  const run = <T>(actual: () => Promise<T>) => {
    if (!active) return Promise.reject(new Error('This workspace notification session has ended.'));
    return underWriter(binding, descriptor, actual);
  };
  const backend: NotificationBackend = {
    platform: raw.platform,
    getPermission: () => run(() => raw.getPermission()),
    requestPermission: () => run(() => raw.requestPermission()),
    listPending: () => run(() => raw.listPending()),
    schedule: (intent: ReminderIntent, installationId?: string, beforeSchedule?: () => boolean) => run(() => raw.schedule(intent, installationId, () => active && beforeSchedule?.() !== false)),
    cancel: (identifier: string) => run(() => raw.cancel(identifier)),
    cancelLegacy: (cancellation: LegacyReminderCancellation, pending: PendingNotificationRequest) => run(() => raw.cancelLegacy(cancellation, pending)),
    installForegroundHandler: (isAllowedByCachedLedger: (notification: ForegroundNotificationProjection) => boolean) => run(() => raw.installForegroundHandler(
      (notification: ForegroundNotificationProjection) => active && isAllowedByCachedLedger(notification),
    )),
  };
  Object.freeze(backend);
  return Object.freeze({ backend, dispose() { active = false; } });
}

export interface PrivacyResourceBoundary extends PrivacyResourceBinding {
  credentialStore(raw: CredentialStore): CredentialStore;
  oauthTokenStore(raw: OAuthTokenStore & { delete?: (tokenRef: string) => Promise<void> }): PrivacyBoundOAuthTokenStore;
  notificationBackend(raw: NotificationBackend): PrivacyBoundNotificationBackend;
  backgroundTaskBackend(raw: BackgroundTaskBackend): PrivacyBoundBackgroundTaskBackend;
  deviceCalendarBackend(raw: DeviceCalendarBackend): PrivacyBoundDeviceCalendarBackend;
  /** Holds one notifications writer through the supplied raw mail-alert I/O and its scoped receipt updates. */
  withMailAlertNotificationWriter<T>(actual: (scope: PrivacyWriterScope) => Promise<T>): Promise<T>;
  withProviderOwnership<T>(actual: () => Promise<T>): Promise<T>;
}

/** Creates narrow adapters over the independent privacy control service and one opened workspace. */
export function createPrivacyResourceBoundary(input: PrivacyResourceBinding): PrivacyResourceBoundary {
  const binding = snapshotBinding(input);
  return Object.freeze({
    ...binding,
    credentialStore: (raw: CredentialStore) => createPrivacyBoundCredentialStore(raw, binding),
    oauthTokenStore: (raw: OAuthTokenStore & { delete?: (tokenRef: string) => Promise<void> }) => createPrivacyBoundOAuthTokenStore(raw, binding),
    notificationBackend: (raw: NotificationBackend) => bindPrivacyNotificationBackend(raw, binding),
    backgroundTaskBackend: (raw: BackgroundTaskBackend) => bindPrivacyBackgroundTaskBackend(raw, binding),
    deviceCalendarBackend: (raw: DeviceCalendarBackend) => bindPrivacyDeviceCalendarBackend(raw, binding),
    withMailAlertNotificationWriter: <T>(actual: (scope: PrivacyWriterScope) => Promise<T>) =>
      binding.privacy.withWriter(binding.session.epoch, { kind: 'notification', namespace: 'notifications' }, async (_lease, scope) => {
        await binding.privacy.assertWorkspaceEpoch(binding.session.epoch);
        const result = await actual(scope);
        await binding.privacy.assertWorkspaceEpoch(binding.session.epoch);
        return result;
      }),
    withProviderOwnership: <T>(actual: () => Promise<T>) => underWriter(binding, { kind: 'provider_credential', namespace: 'provider_credentials' }, actual),
  });
}
