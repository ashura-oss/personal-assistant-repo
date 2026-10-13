import { describe, expect, it, vi } from 'vitest';
import { bindPrivacyDeviceCalendarBackend, bindPrivacyNotificationBackend, createPrivacyBoundCredentialStore, createPrivacyBoundOAuthTokenStore } from '../src/privacy/resourceBoundary';
import type { PrivacyService } from '../src/privacy/service';
import type { NotificationBackend } from '../src/services/notificationBackend';
import type { OAuthTokenStore } from '../src/connectors';
import type { PrivacyWriterDescriptor, PrivacyWriterLease } from '../src/privacy/types';
import type { DeviceCalendarBackend } from '../src/services/deviceCalendarBackend';
import type { DeviceEventDispatchRecord } from '../src/deviceCalendars';

const session = { epoch: '20000000-0000-4000-8000-000000000001', runtimeId: 'runtime' };

function privacyMock() {
  const descriptors: unknown[] = [];
  const privacy = {
    async withWriter<T>(_epoch: string, descriptor: PrivacyWriterDescriptor, work: (lease: PrivacyWriterLease) => Promise<T>) {
      descriptors.push(descriptor);
      return work({} as PrivacyWriterLease);
    },
    async assertWorkspaceEpoch() {},
  } as unknown as PrivacyService;
  return { privacy, descriptors };
}

describe('privacy-bound provider and notification resources', () => {
  it('holds the writer lease through an actual delayed credential write and rejects arbitrary keys', async () => {
    const { privacy, descriptors } = privacyMock();
    let finish!: () => void;
    let completed = false;
    const raw = { get: vi.fn(async () => null), set: vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve; }); }), delete: vi.fn(async () => undefined) };
    const store = createPrivacyBoundCredentialStore(raw, { privacy, session });
    const operation = store.set('azure.speech.subscription-key', 'opaque').then(() => { completed = true; });
    await vi.waitFor(() => expect(raw.set).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    expect(descriptors).toEqual([{ kind: 'provider_credential', namespace: 'provider_credentials' }]);
    finish();
    await operation;
    expect(() => store.get('arbitrary-key')).toThrow('outside the provider credential store');
  });

  it('binds OAuth token references into cleanup registration and wraps each secure-store call', async () => {
    const { privacy, descriptors } = privacyMock();
    const raw: OAuthTokenStore = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
    const store = createPrivacyBoundOAuthTokenStore(raw, { privacy, session });
    await store.get('20000000-0000-4000-8000-000000000002');
    expect(descriptors).toEqual([{
      kind: 'provider_credential', namespace: 'provider_credentials', oauthTokenRef: '20000000-0000-4000-8000-000000000002',
    }]);
  });

  it('holds notification ownership until a delayed schedule settles and disables foreground delivery after disposal', async () => {
    const { privacy, descriptors } = privacyMock();
    let finish!: () => void;
    let active = 0;
    let handler: ((notification: never) => boolean) | undefined;
    const raw = {
      platform: 'ios' as const,
      getPermission: async () => 'authorized' as const,
      requestPermission: async () => 'authorized' as const,
      listPending: async () => [],
      async schedule() { await new Promise<void>((resolve) => { finish = resolve; }); return 'scheduled-id'; },
      cancel: async () => undefined,
      cancelLegacy: async () => undefined,
      async installForegroundHandler(callback: (notification: never) => boolean) { handler = callback; },
    } satisfies NotificationBackend;
    const binding = { privacy, session };
    const originalWithWriter = privacy.withWriter.bind(privacy);
    vi.spyOn(privacy, 'withWriter').mockImplementation(async <T>(epoch: string, descriptor: PrivacyWriterDescriptor, work: (lease: PrivacyWriterLease) => Promise<T>) => {
      active += 1;
      try { return await originalWithWriter(epoch, descriptor, work); } finally { active -= 1; }
    });
    const bound = bindPrivacyNotificationBackend(raw, binding);
    let completed = false;
    const schedule = bound.backend.schedule({} as never).then(() => { completed = true; });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(active).toBe(1);
    finish();
    await schedule;
    expect(completed).toBe(true);
    await bound.backend.installForegroundHandler(() => true);
    expect(handler?.({} as never)).toBe(true);
    bound.dispose();
    expect(handler?.({} as never)).toBe(false);
    expect(descriptors.every((item) => item === undefined || (item as { kind: string; namespace: string }).kind === 'notification' && (item as { namespace: string }).namespace === 'notifications')).toBe(true);
  });

  it('waits for the device-calendar lease before the final create guard and retains it until native create settles', async () => {
    const { privacy } = privacyMock();
    let allowLease!: () => void;
    let startedNative!: () => void;
    let finishNative!: () => void;
    let active = 0;
    let callbackChecked = false;
    const leaseGate = new Promise<void>((resolve) => { allowLease = resolve; });
    const nativeStarted = new Promise<void>((resolve) => { startedNative = resolve; });
    const raw = {
      platform: 'ios' as const,
      async getPermission() { return 'full_access' as const; },
      async requestFullPermission() { return 'full_access' as const; },
      async listCalendars() { return { calendars: [], omitted: 0, discoveryTruncated: false }; },
      async getCalendar() { throw new Error('unused'); },
      async readEvents() { throw new Error('unused'); },
      async createApprovedEvent(_record: DeviceEventDispatchRecord, beforeCreate: () => boolean) {
        callbackChecked = beforeCreate();
        startedNative();
        await new Promise<void>((resolve) => { finishNative = resolve; });
        return { status: 'saved' as const, nativeEventId: 'native-1' };
      },
      async lookupRecord() { return { candidates: [], partial: false, identity: 'unverified' as const }; },
    } as unknown as DeviceCalendarBackend;
    vi.spyOn(privacy, 'withWriter').mockImplementation(async <T>(_epoch: string, _descriptor: PrivacyWriterDescriptor, work: (lease: PrivacyWriterLease) => Promise<T>) => {
      await leaseGate;
      active += 1;
      try { return await work({} as PrivacyWriterLease); } finally { active -= 1; }
    });
    const bound = bindPrivacyDeviceCalendarBackend(raw, { privacy, session });
    const create = bound.backend.createApprovedEvent({} as DeviceEventDispatchRecord, () => true);
    await Promise.resolve();
    expect(callbackChecked).toBe(false);
    allowLease();
    await nativeStarted;
    expect(callbackChecked).toBe(true);
    expect(active).toBe(1);
    bound.dispose();
    expect(active).toBe(1);
    finishNative();
    await expect(create).resolves.toMatchObject({ status: 'saved', nativeEventId: 'native-1' });
    expect(active).toBe(0);
    await expect(bound.backend.getPermission()).rejects.toThrow('session has ended');
  });
});
