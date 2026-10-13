import { describe, expect, it, vi } from 'vitest';
import {
  createNotificationBackend, isMatchingPending, isOwnedLegacyReminderCancellation, NotificationBackendError,
  type ExpoNotificationBridge, type ExpoForegroundNotification, type PendingNotificationRequest,
} from '../src/services/notificationBackend';
import { legacyReminderIdentifier, notificationContentForIntent, reminderNotificationIdentifier } from '../src/reminders';
import type { LegacyReminderCancellation, ReminderIntent } from '../src/reminders';

const installationId = '11111111-1111-4111-8111-111111111111';
const reminderId = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-10-12T10:00:00.000Z';
const dueAt = '2026-10-15T09:30:00.000Z';

function createIntent(privacyMode: 'private' | 'full' = 'private'): ReminderIntent {
  return { id: '33333333-3333-4333-8333-333333333333', reminderId, reminderRevision: 1, epoch: 1,
    identifier: reminderNotificationIdentifier(installationId, reminderId, 1), payloadDigest: 'a'.repeat(64),
    payload: { title: 'Review the launch plan', body: 'Check the release notes.', dueAt, displayTimeZone: 'Asia/Singapore', privacyMode },
    desired: 'scheduled', observed: 'unconfirmed', createdAt: stamp, updatedAt: stamp };
}

function mockBridge(overrides: Partial<ExpoNotificationBridge> = {}) {
  const scheduled: unknown[] = [];
  const cancelled: string[] = [];
  const bridge: ExpoNotificationBridge = {
    getPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getAllScheduledNotificationsAsync: vi.fn(async () => scheduled),
    scheduleNotificationAsync: vi.fn(async (input: unknown) => {
      scheduled.push(input);
      const value = input as { identifier: string };
      return value.identifier;
    }),
    cancelScheduledNotificationAsync: vi.fn(async (identifier: string) => { cancelled.push(identifier); }),
    ...overrides,
  };
  return { bridge, scheduled, cancelled };
}

function iosCalendarTrigger(due: string, extras: Record<string, unknown> = {}) {
  const date = new Date(due);
  return { type: 'calendar', repeats: false, dateComponents: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(), timeZone: 'UTC', calendar: 'gregorian', isLeapMonth: false, isRepeatedDay: false, ...extras } };
}

describe('injected native reminder notification backend', () => {
  it('schedules private and full content using a UTC non-repeating iOS calendar trigger', async () => {
    const { bridge, scheduled } = mockBridge();
    const backend = createNotificationBackend('ios', async () => bridge);
    const privateIntent = createIntent('private');
    expect(await backend.schedule(privateIntent)).toBe(privateIntent.identifier);
    const privateRequest = scheduled[0] as { identifier: string; content: Record<string, unknown>; trigger: Record<string, unknown> };
    expect(privateRequest).toMatchObject({ identifier: privateIntent.identifier, content: { title: 'Still reminder', body: 'Open Still to view', sound: false,
      data: { schemaVersion: 1, installationId, reminderId, epoch: 1, payloadDigest: 'a'.repeat(64) } },
    });
    expect(JSON.stringify(privateRequest.content)).not.toContain(privateIntent.payload!.title);
    expect(privateRequest.trigger).toMatchObject({ type: 'calendar', repeats: false, timezone: 'UTC', year: 2026, month: 10, day: 15, hour: 9, minute: 30, second: 0 });
    expect(privateRequest.trigger).not.toHaveProperty('date');
    expect(bridge.requestPermissionsAsync).not.toHaveBeenCalled();

    const fullIntent = { ...createIntent('full'), id: '44444444-4444-4444-8444-444444444444', reminderId: '55555555-5555-4555-8555-555555555555',
      identifier: reminderNotificationIdentifier(installationId, '55555555-5555-4555-8555-555555555555', 1) };
    await backend.schedule(fullIntent);
    const fullRequest = scheduled[1] as { content: Record<string, unknown> };
    expect(fullRequest.content).toMatchObject({ title: fullIntent.payload!.title, body: fullIntent.payload!.body });
  });

  it('normalizes and verifies exact content plus an absolute UTC calendar trigger', async () => {
    const intent = createIntent('private');
    const expectedContent = notificationContentForIntent(intent, installationId);
    const pendingRequest = { identifier: intent.identifier, content: { ...expectedContent, interruptionLevel: 'active' }, trigger: iosCalendarTrigger(dueAt) };
    const { bridge } = mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [pendingRequest]) });
    const backend = createNotificationBackend('ios', async () => bridge);
    const pending = (await backend.listPending())[0]!;
    expect(pending.trigger).toEqual({ dueAt, repeats: false, verifiable: true });
    expect(isMatchingPending(intent, pending, installationId)).toBe(true);
    expect(isMatchingPending(intent, { ...pending, body: 'Private details leaked' }, installationId)).toBe(false);
    expect(isMatchingPending(intent, { ...pending, extraContentSafe: false }, installationId)).toBe(false);

    const legacyDate = { ...pendingRequest, trigger: { type: 'date', date: new Date(dueAt) } };
    const legacyBridge = mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [legacyDate]) });
    const legacyPending = (await createNotificationBackend('ios', async () => legacyBridge.bridge).listPending())[0]!;
    expect(legacyPending.trigger.verifiable).toBe(false);
    expect(isMatchingPending(intent, legacyPending, installationId)).toBe(false);

    const contradictory = { ...pendingRequest, trigger: iosCalendarTrigger(dueAt, { weekday: 2 }) };
    const contradictionBridge = mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [contradictory]) });
    expect((await createNotificationBackend('ios', async () => contradictionBridge.bridge).listPending())[0]?.trigger.verifiable).toBe(false);

    const nativeShape = { identifier: intent.identifier, content: { title: 'Still reminder', body: 'Open Still to view', data: expectedContent.data,
      interruptionLevel: 'active' }, trigger: iosCalendarTrigger(dueAt, { isLeapMonth: undefined, isRepeatedDay: undefined }) };
    const nativeBackend = createNotificationBackend('ios', async () => mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [nativeShape]) }).bridge);
    const nativePending = (await nativeBackend.listPending())[0]!;
    expect(nativePending.extraContentSafe).toBe(true);
    expect(isMatchingPending(intent, nativePending, installationId)).toBe(true);

    for (const interruptionLevel of ['timeSensitive', 'passive', undefined]) {
      const altered = { ...nativeShape, content: { ...nativeShape.content, interruptionLevel } };
      const shaped = await createNotificationBackend('ios', async () => mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [altered]) }).bridge).listPending();
      expect(shaped[0]?.extraContentSafe).toBe(false);
    }
    const soundful = { ...nativeShape, content: { ...nativeShape.content, sound: 'default' } };
    expect((await createNotificationBackend('ios', async () => mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [soundful]) }).bridge).listPending())[0]?.extraContentSafe).toBe(false);
    const silentNil = { ...nativeShape, content: { ...nativeShape.content, sound: null } };
    expect((await createNotificationBackend('ios', async () => mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [silentNil]) }).bridge).listPending())[0]?.extraContentSafe).toBe(true);

    const partialComponents = { ...nativeShape, trigger: iosCalendarTrigger(dueAt) };
    delete (partialComponents.trigger as { dateComponents: Record<string, unknown> }).dateComponents.isLeapMonth;
    delete (partialComponents.trigger as { dateComponents: Record<string, unknown> }).dateComponents.isRepeatedDay;
    expect((await createNotificationBackend('ios', async () => mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [partialComponents]) }).bridge).listPending())[0]?.trigger.verifiable).toBe(true);
    const leapMonth = { ...nativeShape, trigger: iosCalendarTrigger(dueAt, { isLeapMonth: true }) };
    expect((await createNotificationBackend('ios', async () => mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [leapMonth]) }).bridge).listPending())[0]?.trigger.verifiable).toBe(false);

    const emptyBodyIntent = { ...intent, payload: { ...intent.payload!, privacyMode: 'full' as const, body: '' } };
    const emptyBodyNative = { ...nativeShape, content: { title: emptyBodyIntent.payload.title, body: null, data: expectedContent.data, interruptionLevel: 'active' } };
    const emptyBodyPending = (await createNotificationBackend('ios', async () => mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => [emptyBodyNative]) }).bridge).listPending())[0]!;
    expect(emptyBodyPending.body).toBe('');
    expect(isMatchingPending(emptyBodyIntent, emptyBodyPending, installationId)).toBe(true);
  });

  it('runs the epoch fence immediately before native scheduling and does not call native code when stale', async () => {
    const { bridge, scheduled } = mockBridge();
    const fence = vi.fn(() => false);
    const backend = createNotificationBackend('ios', async () => bridge);
    await expect(backend.schedule(createIntent(), installationId, fence)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fence).toHaveBeenCalledTimes(1);
    expect(bridge.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
  });

  it('does not prompt for permission during reconciliation and maps backend failures to fixed codes', async () => {
    const denied = mockBridge({ getPermissionsAsync: vi.fn(async () => ({ status: 'denied' })), requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })) });
    const backend = createNotificationBackend('android', async () => denied.bridge);
    expect(await backend.getPermission()).toBe('denied');
    expect(await backend.listPending()).toEqual([]);
    expect(denied.bridge.requestPermissionsAsync).not.toHaveBeenCalled();
    await expect(backend.schedule(createIntent(), installationId)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(denied.bridge.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(await backend.requestPermission()).toBe('authorized');
    expect(denied.bridge.requestPermissionsAsync).toHaveBeenCalledTimes(1);

    const listFailure = mockBridge({ getAllScheduledNotificationsAsync: vi.fn(async () => { throw new Error('raw native text'); }) });
    await expect(createNotificationBackend('ios', async () => listFailure.bridge).listPending()).rejects.toBeInstanceOf(NotificationBackendError);
    await expect(createNotificationBackend('ios', async () => listFailure.bridge).listPending()).rejects.toMatchObject({ code: 'listing_failed' });
    const scheduleFailure = mockBridge({ scheduleNotificationAsync: vi.fn(async () => { throw new Error('sensitive provider text'); }) });
    await expect(createNotificationBackend('ios', async () => scheduleFailure.bridge).schedule(createIntent(), installationId)).rejects.toMatchObject({ code: 'schedule_failed' });
    await expect(createNotificationBackend('ios', async () => scheduleFailure.bridge).cancel('reminder-foreign-1')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('restricts legacy cancellation to the exact proposal identifier and matching legacy payload data', async () => {
    const cancellation: LegacyReminderCancellation = { id: '66666666-6666-4666-8666-666666666666', proposalId: 'old-proposal', proposalRevision: 4,
      identifier: legacyReminderIdentifier('old-proposal', 4), requestedAt: stamp, observed: 'unconfirmed' };
    const owned: PendingNotificationRequest = { identifier: cancellation.identifier, title: 'Old title', body: 'Old body',
      data: { proposalId: cancellation.proposalId, proposalRevision: cancellation.proposalRevision }, trigger: { repeats: false, verifiable: false }, extraContentSafe: false };
    expect(isOwnedLegacyReminderCancellation(cancellation, owned)).toBe(true);
    expect(isOwnedLegacyReminderCancellation(cancellation, { ...owned, data: { proposalId: 'different', proposalRevision: 4 } })).toBe(false);
    const { bridge, cancelled } = mockBridge();
    const backend = createNotificationBackend('ios', async () => bridge);
    await expect(backend.cancelLegacy(cancellation, { ...owned, data: { proposalId: 'different', proposalRevision: 4 } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(cancelled).toEqual([]);
    await backend.cancelLegacy(cancellation, owned);
    expect(cancelled).toEqual([cancellation.identifier]);
  });

  it('installs a synchronous cached-ledger foreground gate that never adds sound or badge', async () => {
    let handler: ((notification: ExpoForegroundNotification) => Promise<unknown>) | undefined;
    const { bridge } = mockBridge({ setNotificationHandler: vi.fn((value) => { handler = value.handleNotification; }) });
    const isAllowed = vi.fn((notification: { identifier?: string }) => notification.identifier === 'allowed');
    await createNotificationBackend('ios', async () => bridge).installForegroundHandler(isAllowed);
    expect(handler).toBeDefined();
    const behavior = await handler!({ request: { identifier: 'allowed', content: {}, trigger: {} }, date: new Date() }) as Record<string, unknown>;
    expect(behavior).toEqual({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
    expect(await handler!({ request: { identifier: 'unknown', content: {}, trigger: {} }, date: new Date() })).toEqual({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
    expect(await handler!({ request: undefined, date: new Date() })).toEqual({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
    expect(isAllowed).toHaveBeenCalledTimes(2);
  });

  it('preserves normalized visible and sound fields for the shared foreground ledger gate', async () => {
    let handler: ((notification: ExpoForegroundNotification) => Promise<unknown>) | undefined;
    const { bridge } = mockBridge({ setNotificationHandler: vi.fn((value) => { handler = value.handleNotification; }) });
    const check = vi.fn(() => false);
    await createNotificationBackend('ios', async () => bridge).installForegroundHandler(check);
    const content = {
      title: 'New email', body: 'Open Still to view', data: { kind: 'proactive_mail_alert', installationId, receiptId: 'receipt' },
      sound: null, badge: null, subtitle: null, attachments: [], categoryIdentifier: null, launchImageName: null,
      threadIdentifier: null, summaryArgument: null, interruptionLevel: 'active', color: null, sticky: false,
    };
    await handler!({ request: { identifier: 'still-mail-alert', content }, date: new Date() });
    expect(check).toHaveBeenCalledWith({ identifier: 'still-mail-alert', content });
  });

  it('keeps web unavailable without loading the native API or asking for permissions', async () => {
    const load = vi.fn(async () => { throw new Error('must not load'); });
    const backend = createNotificationBackend('web', load);
    expect(await backend.getPermission()).toBe('unavailable');
    expect(await backend.requestPermission()).toBe('unavailable');
    expect(await backend.listPending()).toEqual([]);
    await expect(backend.schedule(createIntent(), installationId)).rejects.toMatchObject({ code: 'unavailable' });
    await backend.installForegroundHandler(() => false);
    expect(load).not.toHaveBeenCalled();
  });
});
