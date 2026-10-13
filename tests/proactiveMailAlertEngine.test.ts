import { describe, expect, it, vi } from 'vitest';
import type { PrivacyPublicStatus } from '../src/privacy/types';
import {
  executeRequestedMailAlertCancellations,
  executeReservedMailAlertAttempts,
  type ProactiveMailAlertEngineDependencies,
  type MailAlertQueueSlot,
  type MailAlertScopedStore,
  type MailAlertWorkspaceState,
} from '../src/proactiveMailAlerts/engine';
import { emptyProactiveMailAlertState, validateProactiveMailAlertState } from '../src/proactiveMailAlerts/state';
import type { ProactiveMailAlertReceipt } from '../src/proactiveMailAlerts/types';
import type { MailAlertNotificationBackend } from '../src/services/mailAlertNotificationBackend';

const installationId = '11111111-1111-4111-8111-111111111111';
const consentId = '22222222-2222-4222-8222-222222222222';
const receiptId = '33333333-3333-4333-8333-333333333333';
const instant = '2026-10-13T18:00:00.000Z';
type TestState = MailAlertWorkspaceState & { unrelated: { marker: string } };

function receipt(desired: 'notify' | 'cancel' = 'notify'): ProactiveMailAlertReceipt {
  return {
    id: receiptId, installationId, consentId, ruleId: 'rule-1', ruleVersion: 1, ruleRevision: 1,
    timeZone: 'UTC', consentActivatedAt: '2026-10-13T17:00:00.000Z', accountId: 'acct',
    identityKey: 'google:client:subject:', connectionGeneration: 2, providerMessageId: 'message-1',
    sourceVersion: '3:sha256', receivedAt: '2026-10-13T17:30:00.000Z', desired,
    observed: desired === 'notify' ? 'attempting' : 'cancellation_pending', createdAt: instant,
    updatedAt: instant, attemptedAt: instant,
    ...(desired === 'cancel' ? { cancellation: { requestedAt: instant, result: 'requested' as const } } : {}),
  };
}

function workspace(row = receipt()): TestState {
  return { proactiveMailAlerts: validateProactiveMailAlertState({
    ...emptyProactiveMailAlertState(installationId), revision: 3, receipts: [row],
  }), unrelated: { marker: 'preserve' } };
}

function privacyStatus(overrides: Partial<PrivacyPublicStatus> = {}): PrivacyPublicStatus {
  return { phase: 'writer_active', epoch: installationId, activeWriterCount: 1, pendingCleanupCount: 0,
    failedCleanupCount: 0, limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096,
      writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 }, coverage: 'tracked_with_legacy_limits', ...overrides };
}

function environment<State extends MailAlertWorkspaceState>(initial: State, events: string[], options: { saveFails?: boolean; admitted?: boolean; activeWriterCount?: number } = {}) {
  let current = initial;
  const store: MailAlertScopedStore<State> = {
    load: vi.fn(async () => { events.push('scoped-load'); return structuredClone(current); }),
    save: vi.fn(async (next) => { events.push('scoped-save'); if (options.saveFails) throw new Error('stale generation'); current = structuredClone(next); }),
    assertCurrent: vi.fn(async () => { events.push('assert-current'); }),
  };
  const queueSlot: MailAlertQueueSlot<State> = {
    publishScoped: vi.fn((next) => { events.push('publish-scoped'); current = structuredClone(next); }),
  };
  const backend: MailAlertNotificationBackend = {
    platform: 'mock', getPermission: vi.fn(async () => 'authorized' as const), requestPermission: vi.fn(async () => 'authorized' as const),
    present: vi.fn(async (_input, before) => {
      events.push('native-admission');
      if (!await before()) return 'not_admitted';
      events.push('native-present'); return 'submitted';
    }),
    cancel: vi.fn(async (_input, before) => {
      events.push('native-admission');
      if (!await before()) return 'not_admitted';
      events.push('native-list'); return 'absent';
    }),
  };
  const dependencies: ProactiveMailAlertEngineDependencies<State> = {
      backend,
      notificationWriter: { withNotificationWriter: async <T>(work: (scope: never, store: MailAlertScopedStore<State>) => Promise<T>): Promise<T> => {
        events.push('writer-enter');
        try { return await work({} as never, store); } finally { events.push('writer-exit'); }
      } },
      sessionEpoch: installationId,
      getPrivacyStatus: vi.fn(async () => { events.push('get-privacy-status'); return privacyStatus({ activeWriterCount: options.activeWriterCount ?? (options.admitted === false ? 2 : 1) }); }),
      isAttemptCurrent: vi.fn(() => options.admitted !== false),
      isDispatchGateOpen: vi.fn(() => true),
      now: () => new Date('2026-10-13T18:01:00.000Z'),
    };
  return {
    store, queueSlot, backend, dependencies,
    read: () => current,
    setCurrent: (next: State) => { current = structuredClone(next); },
  };
}

describe('proactive mail alert engine', () => {
  it('does fresh admission and exact-receipt postflight within one notification writer', async () => {
    const events = ['queue-slot-enter'];
    const env = environment(workspace(), events);
    const result = await executeReservedMailAlertAttempts(env.dependencies, env.queueSlot, [receipt()]);
    expect(result.submitted).toBe(1);
    expect(events).toEqual([
      'queue-slot-enter', 'writer-enter', 'assert-current', 'scoped-load', 'native-admission',
      'get-privacy-status', 'assert-current', 'scoped-load', 'assert-current', 'native-present',
      'assert-current', 'scoped-load', 'assert-current', 'scoped-load', 'scoped-save', 'publish-scoped', 'writer-exit',
    ]);
    expect(env.read().proactiveMailAlerts.receipts[0].observed).toBe('submitted');
    expect(env.read().unrelated).toEqual({ marker: 'preserve' });
    expect(env.backend.present).toHaveBeenCalledOnce();
  });

  it('allows presentation with another active writer but keeps cancellation pending until it settles', async () => {
    const events: string[] = [];
    let activeWriterCount = 2;
    const presentation = environment(workspace(), events, { activeWriterCount });
    presentation.dependencies.getPrivacyStatus = vi.fn(async () => privacyStatus({ activeWriterCount }));
    const presented = await executeReservedMailAlertAttempts(presentation.dependencies, presentation.queueSlot, [receipt()]);
    expect(presented.submitted).toBe(1);
    expect(presentation.backend.present).toHaveBeenCalledOnce();

    const cancellation = receipt('cancel');
    const cleanup = environment(workspace(cancellation), events, { activeWriterCount });
    cleanup.dependencies.getPrivacyStatus = vi.fn(async () => privacyStatus({ activeWriterCount }));
    const waiting = await executeRequestedMailAlertCancellations(cleanup.dependencies, cleanup.queueSlot, [cancellation]);
    expect(waiting.cancellationPending).toBe(1);
    expect(cleanup.backend.cancel).toHaveBeenCalledOnce();
    expect(cleanup.read().proactiveMailAlerts.receipts[0].observed).toBe('cancellation_pending');

    activeWriterCount = 1;
    const settled = await executeRequestedMailAlertCancellations(cleanup.dependencies, cleanup.queueSlot, [cancellation]);
    expect(settled.cancelled).toBe(1);
    expect(cleanup.read().proactiveMailAlerts.receipts[0].observed).toBe('cancelled');
  });

  it('does not call native presentation when the fresh admission predicate rejects the committed source', async () => {
    const events: string[] = [];
    const env = environment(workspace(), events, { admitted: false });
    const result = await executeReservedMailAlertAttempts(env.dependencies, env.queueSlot, [receipt()]);
    expect(result.notAdmitted).toBe(1);
    expect(env.backend.present).not.toHaveBeenCalled();
    expect(env.read().proactiveMailAlerts.receipts[0].observed).toBe('delivery_unknown');
    expect(env.store.save).toHaveBeenCalledOnce();
  });

  it('lets a committed cancellation win before a reserved producer acquires its notification writer', async () => {
    const events: string[] = [];
    const cancelled = { ...receipt('cancel'), observed: 'cancellation_pending' as const,
      cancellation: { requestedAt: '2026-10-13T18:00:30.000Z', result: 'requested' as const } };
    const env = environment(workspace(cancelled), events);
    const result = await executeReservedMailAlertAttempts(env.dependencies, env.queueSlot, [receipt()]);
    expect(result.notAdmitted).toBe(1);
    expect(env.backend.present).not.toHaveBeenCalled();
    expect(env.read().proactiveMailAlerts.receipts[0]).toMatchObject({ desired: 'cancel', observed: 'cancellation_pending' });
  });

  it('rechecks the scoped storage generation after an asynchronous final predicate', async () => {
    const events: string[] = [];
    const env = environment(workspace(), events);
    let releasePredicate!: (allowed: boolean) => void;
    let predicateCalls = 0;
    env.dependencies.isAttemptCurrent = vi.fn(() => {
      predicateCalls++;
      if (predicateCalls === 1) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => { releasePredicate = resolve; });
    });
    let assertions = 0;
    env.store.assertCurrent = vi.fn(async () => {
      assertions++;
      events.push('assert-current');
      if (assertions >= 3) throw new Error('workspace changed after predicate');
    });
    const run = executeReservedMailAlertAttempts(env.dependencies, env.queueSlot, [receipt()]);
    await vi.waitFor(() => expect(releasePredicate).toBeTypeOf('function'));
    releasePredicate(true);
    const result = await run;
    expect(result.deliveryUnknown).toBe(1);
    expect(env.backend.present).toHaveBeenCalledOnce();
    expect(events).not.toContain('native-present');
    expect(env.store.save).not.toHaveBeenCalled();
    expect(env.read().proactiveMailAlerts.receipts[0].observed).toBe('attempting');
  });

  it('compensates a late revoke only after the in-flight present settles, under the same writer', async () => {
    const events: string[] = [];
    const env = environment(workspace(), events);
    let releaseNative!: () => void;
    let signalStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const nativeGate = new Promise<void>((resolve) => { releaseNative = resolve; });
    env.backend.present = vi.fn(async (_input, before) => {
      if (!await before()) return 'not_admitted';
      events.push('native-present-start'); signalStarted();
      await nativeGate;
      events.push('native-present-settled');
      return 'submitted';
    });
    env.backend.cancel = vi.fn(async (_input, before) => {
      events.push('native-cancel-admission');
      if (!await before()) return 'not_admitted';
      events.push('native-cancel-list');
      return 'absent';
    });
    const pending = executeReservedMailAlertAttempts(env.dependencies, env.queueSlot, [receipt()]);
    await nativeStarted;
    const revoked = { ...receipt('cancel'), observed: 'cancellation_pending' as const,
      cancellation: { requestedAt: '2026-10-13T18:00:30.000Z', result: 'requested' as const } };
    env.setCurrent({ ...workspace(revoked), unrelated: { marker: 'changed independently' } });
    expect(events).not.toContain('native-cancel-list');
    releaseNative();
    const result = await pending;
    expect(result.cancelled).toBe(1);
    expect(events.indexOf('native-present-settled')).toBeLessThan(events.indexOf('native-cancel-list'));
    expect(events.filter((event) => event === 'writer-enter')).toHaveLength(1);
    expect(events.filter((event) => event === 'writer-exit')).toHaveLength(1);
    expect(env.read().proactiveMailAlerts.receipts[0]).toMatchObject({ desired: 'cancel', observed: 'cancelled', cancellation: { result: 'absent' } });
  });

  it('keeps a late-revocation cancellation pending when its postflight CAS conflicts', async () => {
    const events: string[] = [];
    const env = environment(workspace(), events, { saveFails: true });
    let releaseNative!: () => void;
    let signalStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const nativeGate = new Promise<void>((resolve) => { releaseNative = resolve; });
    env.backend.present = vi.fn(async (_input, before) => {
      if (!await before()) return 'not_admitted';
      signalStarted(); await nativeGate; return 'submitted';
    });
    const pending = executeReservedMailAlertAttempts(env.dependencies, env.queueSlot, [receipt()]);
    await nativeStarted;
    const revoked = { ...receipt('cancel'), observed: 'cancellation_pending' as const,
      cancellation: { requestedAt: '2026-10-13T18:00:30.000Z', result: 'requested' as const } };
    env.setCurrent(workspace(revoked));
    releaseNative();
    const result = await pending;
    expect(result.cleanupPending).toBe(1);
    expect(env.backend.cancel).toHaveBeenCalledOnce();
    expect(env.read().proactiveMailAlerts.receipts[0]).toMatchObject({ desired: 'cancel', observed: 'cancellation_pending', cancellation: { result: 'requested' } });
    expect(env.queueSlot.publishScoped).not.toHaveBeenCalled();
  });

  it('rechecks a headless cancellation gate after asynchronous privacy and fresh-state reads', async () => {
    const events: string[] = [];
    const env = environment(workspace(receipt('cancel')), events);
    let releasePrivacy!: () => void;
    let signalPrivacy!: () => void;
    const privacyStarted = new Promise<void>((resolve) => { signalPrivacy = resolve; });
    const privacyGate = new Promise<void>((resolve) => { releasePrivacy = resolve; });
    let releaseLoad!: () => void;
    let signalLoad!: () => void;
    const loadStarted = new Promise<void>((resolve) => { signalLoad = resolve; });
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    env.dependencies.getPrivacyStatus = vi.fn(async () => {
      signalPrivacy();
      await privacyGate;
      return privacyStatus();
    });
    env.store.load = vi.fn(async () => {
      signalLoad();
      await loadGate;
      return env.read();
    });
    let gateOpen = true;
    env.dependencies.isCancellationGateOpen = vi.fn(() => gateOpen);

    const pending = executeRequestedMailAlertCancellations(env.dependencies, env.queueSlot, [receipt('cancel')]);
    await privacyStarted;
    releasePrivacy();
    await loadStarted;
    gateOpen = false;
    releaseLoad();

    const result = await pending;
    expect(result.cancellationPending).toBe(1);
    expect(env.dependencies.isCancellationGateOpen).toHaveBeenCalledOnce();
    expect(env.backend.cancel).toHaveBeenCalledOnce();
    expect(events).not.toContain('native-list');
    expect(env.store.save).not.toHaveBeenCalled();
    expect(env.read().proactiveMailAlerts.receipts[0]).toMatchObject({
      desired: 'cancel', observed: 'cancellation_pending', cancellation: { result: 'requested' },
    });
  });

  it('keeps late-revoke compensation pending when the final cancellation gate closes', async () => {
    const events: string[] = [];
    const env = environment(workspace(), events);
    let releaseNative!: () => void;
    let signalStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const nativeGate = new Promise<void>((resolve) => { releaseNative = resolve; });
    env.backend.present = vi.fn(async (_input, before) => {
      if (!await before()) return 'not_admitted';
      signalStarted();
      await nativeGate;
      return 'submitted';
    });
    env.backend.cancel = vi.fn(async (_input, before) => {
      events.push('native-cancel-admission');
      if (!await before()) return 'not_admitted';
      events.push('native-cancel-list');
      return 'absent';
    });
    env.dependencies.isCancellationGateOpen = vi.fn(() => false);

    const pending = executeReservedMailAlertAttempts(env.dependencies, env.queueSlot, [receipt()]);
    await nativeStarted;
    const revoked = { ...receipt('cancel'), observed: 'cancellation_pending' as const,
      cancellation: { requestedAt: '2026-10-13T18:00:30.000Z', result: 'requested' as const } };
    env.setCurrent(workspace(revoked));
    releaseNative();

    const result = await pending;
    expect(result.submitted).toBe(1);
    expect(result.cleanupPending).toBe(1);
    expect(env.dependencies.isCancellationGateOpen).toHaveBeenCalledOnce();
    expect(events).not.toContain('native-cancel-list');
    expect(env.read().proactiveMailAlerts.receipts[0]).toMatchObject({
      desired: 'cancel', observed: 'cancellation_pending', cancellation: { result: 'requested' },
    });
  });

  it('leaves the durable reservation conservative if scoped postflight CAS fails', async () => {
    const events: string[] = [];
    const env = environment(workspace(), events, { saveFails: true });
    const result = await executeReservedMailAlertAttempts(env.dependencies, env.queueSlot, [receipt()]);
    expect(result.deliveryUnknown).toBe(1);
    expect(env.backend.present).toHaveBeenCalledOnce();
    expect(env.read().proactiveMailAlerts.receipts[0].observed).toBe('attempting');
    expect(env.queueSlot.publishScoped).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe('writer-exit');
  });

  it('proves sole-writer ownership before cancellation reads and retains uncertainty on CAS failure', async () => {
    const events: string[] = [];
    const env = environment(workspace(receipt('cancel')), events);
    env.dependencies.getPrivacyStatus = vi.fn(async () => { events.push('get-privacy-status'); return privacyStatus(); });
    const result = await executeRequestedMailAlertCancellations(env.dependencies, env.queueSlot, [receipt('cancel')]);
    expect(result.cancelled).toBe(1);
    expect(events.indexOf('get-privacy-status')).toBeLessThan(events.indexOf('native-list'));
    expect(env.read().proactiveMailAlerts.receipts[0]).toMatchObject({ desired: 'cancel', observed: 'cancelled', cancellation: { result: 'absent' } });
  });

  it('does not inspect native cancellation state if another writer is still active', async () => {
    const events: string[] = [];
    const env = environment(workspace(receipt('cancel')), events);
    env.dependencies.getPrivacyStatus = vi.fn(async () => { events.push('get-privacy-status'); return privacyStatus({ activeWriterCount: 2 }); });
    const result = await executeRequestedMailAlertCancellations(env.dependencies, env.queueSlot, [receipt('cancel')]);
    expect(result.cancellationPending).toBe(1);
    expect(env.backend.cancel).toHaveBeenCalledOnce();
    expect(events).not.toContain('native-list');
    expect(env.store.save).not.toHaveBeenCalled();
  });

  it('persists a valid observedAt even when native cancellation outcome remains unknown', async () => {
    const events: string[] = [];
    const env = environment(workspace(receipt('cancel')), events);
    env.backend.cancel = vi.fn(async (_input, before) => await before() ? 'cancellation_unknown' : 'not_admitted');
    const result = await executeRequestedMailAlertCancellations(env.dependencies, env.queueSlot, [receipt('cancel')]);
    expect(result.cancellationUnknown).toBe(1);
    expect(env.read().proactiveMailAlerts.receipts[0]).toMatchObject({
      observed: 'cancellation_unknown', cancellation: { result: 'unknown', attemptedAt: expect.any(String), observedAt: expect.any(String) },
    });
  });

  it('rejects a privacy writer proof from a different workspace epoch', async () => {
    const events: string[] = [];
    const env = environment(workspace(receipt('cancel')), events);
    env.dependencies.getPrivacyStatus = vi.fn(async () => privacyStatus({ epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
    const result = await executeRequestedMailAlertCancellations(env.dependencies, env.queueSlot, [receipt('cancel')]);
    expect(result.cancellationPending).toBe(1);
    expect(events).not.toContain('native-list');
    expect(env.read().proactiveMailAlerts.receipts[0].observed).toBe('cancellation_pending');
  });
});
