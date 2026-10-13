import { describe, expect, it, vi } from 'vitest';
import { evaluateProactive, proactiveSourceId, type ProactiveMailSource } from '../src/proactive';
import {
  createProactiveMailAlertConsent, emptyProactiveMailAlertState, planProactiveMailAlerts, replaceProactiveMailAlertConsent, revokeProactiveMailAlertConsent,
  revokeAllProactiveMailAlertConsentsForRecovery,
  validateProactiveMailAlertState,
  type CommittedMailAlertPage, type MailAlertRule, type MailAlertVerifiedAccount, type ProactiveMailAlertState,
} from '../src/proactiveMailAlerts';
import { isMatchingProactiveMailAlertNotification } from '../src/services/mailAlertNotificationBackend';

const installationId = '11111111-1111-4111-8111-111111111111';
const consentId = '22222222-2222-4222-8222-222222222222';
const receiptId = '33333333-3333-4333-8333-333333333333';
const now = '2026-10-13T18:00:00.000Z';
const account: MailAlertVerifiedAccount = {
  accountId: 'account-1', providerNamespace: 'google', identityKey: 'google:client:subject:', connectionGeneration: 3,
  connected: true, authStatus: 'connected', canReadMail: true,
};
const mail = (providerId: string, sourceVersion = 'v1'): ProactiveMailSource => {
  return mailFor(account, providerId, sourceVersion);
};
const mailFor = (owner: MailAlertVerifiedAccount, providerId: string, sourceVersion = 'v1'): ProactiveMailSource => {
  const base = { namespace: owner.providerNamespace, accountId: owner.accountId, providerId };
  return { kind: 'mail', ...base, sourceId: proactiveSourceId(base), sourceVersion, availability: 'available', freshness: 'fresh',
    senderEmail: 'alert@example.test', isRead: false, subject: 'Build status', receivedAt: '2026-10-13T17:55:00.000Z' };
};
const rule = (id = 'rule-1', overrides: Record<string, unknown> = {}): MailAlertRule => ({
  id, version: 2, revision: 4, enabled: true, accountIds: [account.accountId],
  trigger: { type: 'keyword' as const, keywords: ['build'] }, ...overrides,
} as MailAlertRule);
const page = (sources: ProactiveMailSource[], overrides: Partial<CommittedMailAlertPage> = {}): CommittedMailAlertPage => ({
  accountId: account.accountId, providerNamespace: 'google', identityKey: account.identityKey,
  connectionGeneration: account.connectionGeneration, checkedAt: '2026-10-13T17:59:00.000Z', sources, ...overrides,
});
function consentState() {
  const state = emptyProactiveMailAlertState(installationId);
  const consent = createProactiveMailAlertConsent({ id: consentId, rule: rule(), timeZone: 'UTC', activatedAt: '2026-10-13T17:50:00.000Z', accounts: [account] });
  return validateProactiveMailAlertState({ ...state, revision: 1, consents: [consent] });
}
function plan(state = consentState(), pages = [page([mail('m1')])], accounts = [account], rules: MailAlertRule[] = [rule()], ids = [receiptId], zone = 'UTC', extra: Record<string, unknown> = {}) {
  let index = 0;
  return planProactiveMailAlerts({ state, rules, accounts, pages, now, currentTimeZone: zone, uuid: () => ids[index++] ?? '44444444-4444-4444-8444-444444444444', ...extra } as Parameters<typeof planProactiveMailAlerts>[0]);
}

describe('proactive mail alert domain', () => {
  it('requires a finite verified-account consent and preserves both rule versions', () => {
    const consent = createProactiveMailAlertConsent({ id: consentId, rule: rule(), timeZone: 'UTC', activatedAt: '2026-10-13T17:50:00.000Z', accounts: [account] });
    expect(consent).toMatchObject({ ruleId: 'rule-1', ruleVersion: 2, ruleRevision: 4, accounts: [{ accountId: account.accountId, identityKey: account.identityKey, connectionGeneration: account.connectionGeneration }] });
    expect(() => createProactiveMailAlertConsent({ id: consentId, rule: rule(), timeZone: 'UTC', activatedAt: now, accounts: [] })).toThrow(/1 and 64/);
  });

  it('rejects duplicate current consents for one rule and malformed receipt fields', () => {
    const state = consentState();
    expect(() => validateProactiveMailAlertState({ ...state, consents: [state.consents[0], { ...state.consents[0], id: '55555555-5555-4555-8555-555555555555' }] })).toThrow(/one current/i);
    expect(() => validateProactiveMailAlertState({ ...state, surprise: 'private raw data' })).toThrow(/unknown or missing/);
  });

  it('plans only fresh committed pages and freezes source version without including it in dedupe', () => {
    const first = plan();
    expect(first.newAttempts).toHaveLength(1);
    expect(first.newAttempts[0]).toMatchObject({ observed: 'attempting', sourceVersion: 'v1', ruleVersion: 2, ruleRevision: 4 });
    const second = plan(first.nextState, [page([mail('m1', 'v2')])], [account], [rule()], ['66666666-6666-4666-8666-666666666666']);
    expect(second.newAttempts).toEqual([]);
    expect(plan(consentState(), [page([mail('stale')], { checkedAt: '2026-10-13T17:40:00.000Z' })]).newAttempts).toEqual([]);
  });

  it('coexists with other proactive rule kinds and canonicalizes explicit-offset mail timestamps', () => {
    const eventRule = { id: 'meeting-rule', version: 1, revision: 2, enabled: true, accountIds: [], trigger: { type: 'meeting_soon' as const, minutes: 10 } };
    const source = mail('offset-time');
    source.receivedAt = '2026-10-13T19:55:00+02:00';
    const result = plan(consentState(), [page([source])], [account], [rule(), eventRule]);
    expect(result.newAttempts[0].receivedAt).toBe('2026-10-13T17:55:00.000Z');
    expect(result.newAttempts).toHaveLength(1);
  });

  it('rejects mail at or before consent, future mail, naive time, and invalid calendar dates', () => {
    for (const receivedAt of [
      '2026-10-13T17:49:59.999Z', // older than consent
      '2026-10-13T17:50:00.000Z', // equal to consent
      '2026-10-13T18:00:00.001Z', // future
    ]) {
      const source = mail(`received-${receivedAt}`);
      source.receivedAt = receivedAt;
      expect(plan(consentState(), [page([source])]).newAttempts).toEqual([]);
    }
    for (const receivedAt of ['2026-10-13T17:55:00', '2026-02-30T17:55:00Z']) {
      const source = mail(`received-${receivedAt}`);
      source.receivedAt = receivedAt;
      let rejected = false;
      let attempts: ReturnType<typeof plan>['newAttempts'] | undefined;
      try {
        attempts = plan(consentState(), [page([source])]).newAttempts;
      } catch {
        // Strict source validation may reject these malformed timestamps outright.
        rejected = true;
      }
      if (!rejected) expect(attempts).toEqual([]);
    }
  });

  it('applies quiet hours using the rule timezone across the fall-back DST hour', () => {
    const quietRule = rule('rule-1', { quietHours: { start: '01:00', end: '02:00' } });
    const state = validateProactiveMailAlertState({
      ...emptyProactiveMailAlertState(installationId), revision: 1,
      consents: [createProactiveMailAlertConsent({ id: consentId, rule: quietRule, timeZone: 'America/New_York',
        activatedAt: '2026-11-01T04:00:00.000Z', accounts: [account] })],
    });
    const source = mail('dst-fall-back');
    source.receivedAt = '2026-11-01T05:00:00Z';
    const result = plan(state, [page([source], { checkedAt: '2026-11-01T05:29:00.000Z' })], [account], [quietRule],
      [receiptId], 'America/New_York', { now: '2026-11-01T05:30:00.000Z' });
    expect(result.newAttempts).toEqual([]);
    expect(result.quietSkippedCount).toBeGreaterThan(0);
  });

  it('revokes consent when either rule token, timezone, or account binding changes and retains cancel intent', () => {
    const first = plan();
    const changedRule = plan(first.nextState, [page([mail('m2')])], [account], [rule('rule-1', { version: 3 })], ['77777777-7777-4777-8777-777777777777']);
    expect(changedRule.revokedConsentIds).toEqual([consentId]);
    expect(changedRule.nextState.consents[0]).toMatchObject({ status: 'revoked', revocationReason: 'rule_changed' });
    expect(changedRule.nextState.receipts[0]).toMatchObject({ desired: 'cancel', observed: 'attempting', cancellation: { result: 'requested' } });
    const changedZone = plan(consentState(), [page([mail('m2')])], [account], [rule()], ['88888888-8888-4888-8888-888888888888'], 'Asia/Singapore');
    expect(changedZone.revokedConsentIds).toEqual([consentId]);
    const changedAccount = { ...account, identityKey: 'google:other:subject:' };
    const changedBinding = plan(consentState(), [page([mail('m2')], { identityKey: changedAccount.identityKey })], [changedAccount], [rule()]);
    expect(changedBinding.nextState.consents[0]).toMatchObject({ status: 'revoked', revocationReason: 'account_changed' });
  });

  it('preserves and cancels orphaned receipt history when a rule is revoked or re-consented', () => {
    const receipt = plan().newAttempts[0];
    const orphaned = validateProactiveMailAlertState({ ...emptyProactiveMailAlertState(installationId), revision: 1, receipts: [receipt] });
    const revoked = revokeProactiveMailAlertConsent(orphaned, 'rule-1', now);
    expect(revoked.receipts[0]).toMatchObject({ desired: 'cancel', cancellation: { result: 'requested' } });
    const replaced = replaceProactiveMailAlertConsent(orphaned, { id: '99999999-9999-4999-8999-999999999999', rule: rule(), timeZone: 'UTC', activatedAt: now, accounts: [account] });
    expect(replaced.receipts[0]).toMatchObject({ desired: 'cancel', cancellation: { result: 'requested' } });
    expect(replaced.receipts).toHaveLength(1);
  });

  it('recovery revokes old consent and requests cancellation for orphaned uncertain receipts without changing prior cancellation intent', () => {
    const planned = plan().newAttempts[0];
    const orphanUnknown = { ...planned, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', observed: 'delivery_unknown' as const };
    const priorCancellation = { ...planned, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', providerMessageId: 'another-message', desired: 'cancel' as const, observed: 'cancellation_pending' as const, cancellation: { result: 'requested' as const, requestedAt: now } };
    const input = validateProactiveMailAlertState({ ...emptyProactiveMailAlertState(installationId), revision: 2, receipts: [orphanUnknown, priorCancellation] });
    const recovered = revokeAllProactiveMailAlertConsentsForRecovery(input, now);
    expect(recovered.receipts).toHaveLength(2);
    expect(recovered.receipts[0]).toMatchObject({ desired: 'cancel', observed: 'cancellation_pending', cancellation: { result: 'requested', requestedAt: now } });
    expect(recovered.receipts[1]).toEqual(priorCancellation);
    expect(recovered.consents).toEqual([]);
  });

  it('honors exact candidate dismissals and source/rule snoozes', () => {
    const source = mail('quiet-me');
    const evaluated = evaluateProactive({ nowUtc: now, timeZone: 'UTC', rules: [rule()], sources: [source] });
    expect(evaluated.activeCandidates).toHaveLength(1);
    const candidate = evaluated.activeCandidates[0];
    const dismissed = plan(consentState(), [page([source])], [account], [rule()], [receiptId], 'UTC', { dismissedCandidateIds: [candidate.id] });
    expect(dismissed.newAttempts).toEqual([]);
    const snoozed = plan(consentState(), [page([source])], [account], [rule()], [receiptId], 'UTC', { snoozes: [{ suppressionKey: candidate.suppressionKey, until: '2026-10-13T19:00:00.000Z', snoozedAt: now }] });
    expect(snoozed.newAttempts).toEqual([]);
    expect(snoozed.quietSkippedCount).toBeGreaterThan(0);
  });

  it('limits one plan to two attempts across every committed account page', () => {
    const secondAccount = { ...account, accountId: 'account-2', identityKey: 'google:client:subject2:', connectionGeneration: 1 };
    const scopedRule = rule('rule-1', { accountIds: [account.accountId, secondAccount.accountId] });
    const state = validateProactiveMailAlertState({
      ...emptyProactiveMailAlertState(installationId), revision: 1,
      consents: [createProactiveMailAlertConsent({ id: consentId, rule: scopedRule, timeZone: 'UTC',
        activatedAt: '2026-10-13T17:50:00.000Z', accounts: [account, secondAccount] })],
    });
    const pages = [
      page([mail('m1'), mail('m2')]),
      page([mailFor(secondAccount, 'm3'), mailFor(secondAccount, 'm4')], { accountId: secondAccount.accountId,
        identityKey: secondAccount.identityKey, connectionGeneration: secondAccount.connectionGeneration }),
    ];
    const multi = plan(state, pages, [account, secondAccount], [scopedRule], [receiptId, '44444444-4444-4444-8444-444444444444']);
    expect(multi.newAttempts).toHaveLength(2);
    expect(multi.quotaSkippedCount).toBeGreaterThanOrEqual(2);
  });

  it('hard-stops the rolling-day and receipt caps without evicting history', () => {
    const template = plan().newAttempts[0];
    const makeReceipts = (count: number): ProactiveMailAlertState['receipts'] => Array.from({ length: count }, (_, index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
      providerMessageId: `prior-${index}`,
    }));
    const dayLimited = { ...consentState(), revision: 2, receipts: makeReceipts(20) };
    const dayPlan = plan(dayLimited, [page([mail('new-day-limit')])]);
    expect(dayPlan.newAttempts).toEqual([]);
    expect(dayPlan.nextState.receipts).toHaveLength(20);
    const full = { ...consentState(), revision: 2, receipts: makeReceipts(2000) };
    const fullPlan = plan(full, [page([mail('new-cap-limit')])]);
    expect(fullPlan.newAttempts).toEqual([]);
    expect(fullPlan.receiptCapacityReached).toBe(true);
    expect(fullPlan.nextState.receipts).toHaveLength(2000);
  });

  it('keeps future attempted receipts in the rolling quota after a clock rollback', () => {
    const template = plan().newAttempts[0];
    const future = Array.from({ length: 20 }, (_, index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${(index + 101).toString(16).padStart(12, '0')}`,
      providerMessageId: `future-prior-${index}`,
      attemptedAt: '2026-10-14T01:00:00.000Z',
    }));
    const state = validateProactiveMailAlertState({ ...consentState(), revision: 2, receipts: future });
    expect(plan(state, [page([mail('after-clock-rollback')])]).newAttempts).toEqual([]);
  });
});

describe('mail alert notification backend', () => {
  function bridge() {
    const scheduled = new Set<string>();
    const presented = new Set<string>();
    return {
      scheduled, presented,
      api: {
        getPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
        requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
        scheduleNotificationAsync: vi.fn(async (request: { identifier: string }) => { scheduled.add(request.identifier); return request.identifier; }),
        cancelScheduledNotificationAsync: vi.fn(async (id: string) => { scheduled.delete(id); }),
        getAllScheduledNotificationsAsync: vi.fn(async () => [...scheduled].map((identifier) => ({ identifier }))),
        getPresentedNotificationsAsync: vi.fn(async () => [...presented].map((identifier) => ({ request: { identifier } }))),
        dismissNotificationAsync: vi.fn(async (id: string) => { presented.delete(id); }),
      },
    };
  }

  it('waits for asynchronous final admission after all reads and presents only generic content', async () => {
    const { api } = bridge();
    let release!: (value: boolean) => void;
    const admission = new Promise<boolean>((resolve) => { release = resolve; });
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    const promise = backend.present({ installationId, receiptId }, () => admission);
    await vi.waitFor(() => expect(api.getPermissionsAsync).toHaveBeenCalledOnce());
    expect(api.scheduleNotificationAsync).not.toHaveBeenCalled();
    release(true);
    expect(await promise).toBe('submitted');
    const request = api.scheduleNotificationAsync.mock.calls[0][0] as { identifier: string; content: { title: string; body: string; data: Record<string, unknown> }; trigger: unknown };
    expect(request.identifier).toBe(`still-mail-alert:${installationId}:${receiptId}`);
    expect(request.content).toEqual({ title: 'New mail alert', body: 'A saved mail rule matched a new message.', data: { kind: 'proactive_mail_alert', installationId, receiptId }, sound: false, interruptionLevel: 'active' });
    expect(request.trigger).toBeNull();
    expect(api.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does not prompt and exact-cancels/verifies only its own scheduled or presented identifier', async () => {
    const { api, presented } = bridge();
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    const id = `still-mail-alert:${installationId}:${receiptId}`;
    presented.add(id);
    expect(await backend.cancel({ installationId, receiptId }, async () => true)).toBe('cancelled');
    expect(api.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(api.dismissNotificationAsync).toHaveBeenCalledWith(id);
    expect(api.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('runs cancellation admission before listing, including when the native list is empty', async () => {
    const { api } = bridge();
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    const admission = vi.fn(async () => false);
    expect(await backend.cancel({ installationId, receiptId }, admission)).toBe('not_admitted');
    expect(admission).toHaveBeenCalledOnce();
    expect(api.getAllScheduledNotificationsAsync).not.toHaveBeenCalled();
    expect(api.getPresentedNotificationsAsync).not.toHaveBeenCalled();
  });

  it('rejects malformed notification snapshots instead of treating them as verified absence', async () => {
    const { api } = bridge();
    api.getAllScheduledNotificationsAsync.mockResolvedValueOnce([{} as { identifier: string }]);
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    expect(await backend.cancel({ installationId, receiptId }, async () => true)).toBe('cancellation_unknown');
    expect(api.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it('drains the sibling native list read after an asynchronous read rejection', async () => {
    const { api } = bridge();
    let releasePresented!: (value: { request: { identifier: string } }[]) => void;
    const presented = new Promise<{ request: { identifier: string } }[]>((resolve) => { releasePresented = resolve; });
    api.getAllScheduledNotificationsAsync.mockRejectedValueOnce(new Error('scheduled read failed'));
    api.getPresentedNotificationsAsync.mockImplementationOnce(() => presented);
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    let settled = false;
    const pending = backend.cancel({ installationId, receiptId }, async () => true).then((value) => { settled = true; return value; });
    await vi.waitFor(() => {
      expect(api.getAllScheduledNotificationsAsync).toHaveBeenCalledOnce();
      expect(api.getPresentedNotificationsAsync).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releasePresented([]);
    expect(await pending).toBe('cancellation_unknown');
  });

  it('drains the sibling native list read after a synchronous bridge throw', async () => {
    const { api } = bridge();
    let releasePresented!: (value: { request: { identifier: string } }[]) => void;
    const presented = new Promise<{ request: { identifier: string } }[]>((resolve) => { releasePresented = resolve; });
    api.getAllScheduledNotificationsAsync.mockImplementationOnce(() => { throw new Error('scheduled bridge threw'); });
    api.getPresentedNotificationsAsync.mockImplementationOnce(() => presented);
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    let settled = false;
    const pending = backend.cancel({ installationId, receiptId }, async () => true).then((value) => { settled = true; return value; });
    await vi.waitFor(() => {
      expect(api.getAllScheduledNotificationsAsync).toHaveBeenCalledOnce();
      expect(api.getPresentedNotificationsAsync).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releasePresented([]);
    expect(await pending).toBe('cancellation_unknown');
  });

  it('does not claim absence when a noncanonical notification ID carries this receipt data', async () => {
    const { api } = bridge();
    api.getAllScheduledNotificationsAsync.mockResolvedValueOnce([{
      identifier: 'unexpected-native-id',
      content: { data: { kind: 'proactive_mail_alert', installationId, receiptId } },
    } as { identifier: string }]);
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    expect(await backend.cancel({ installationId, receiptId }, async () => true)).toBe('cancellation_unknown');
    expect(api.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(api.dismissNotificationAsync).not.toHaveBeenCalled();
    expect(api.getPresentedNotificationsAsync).toHaveBeenCalledOnce();
  });

  it('snapshots receipt identifiers before asynchronous bridge loading', async () => {
    const { api, presented } = bridge();
    const expectedId = `still-mail-alert:${installationId}:${receiptId}`;
    presented.add(expectedId);
    let release!: () => void;
    const delayedBridge = new Promise<void>((resolve) => { release = resolve; });
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => {
      await delayedBridge;
      return api;
    });
    const input = { installationId, receiptId };
    const pending = backend.cancel(input, async () => true);
    input.installationId = '44444444-4444-4444-8444-444444444444';
    input.receiptId = '55555555-5555-4555-8555-555555555555';
    release();
    expect(await pending).toBe('cancelled');
    expect(api.dismissNotificationAsync).toHaveBeenCalledWith(expectedId);
  });

  it('exports the exact fixed foreground projection and rejects altered content', () => {
    const notification = { request: { identifier: `still-mail-alert:${installationId}:${receiptId}`, content: {
      title: 'New mail alert', body: 'A saved mail rule matched a new message.', sound: null, interruptionLevel: 'active',
      data: { kind: 'proactive_mail_alert', installationId, receiptId },
    } } };
    expect(isMatchingProactiveMailAlertNotification({ installationId, receiptId }, notification)).toBe(true);
    expect(isMatchingProactiveMailAlertNotification({ installationId, receiptId }, { ...notification, request: { ...notification.request, content: { ...notification.request.content, sound: 'default' } } })).toBe(false);
    expect(isMatchingProactiveMailAlertNotification({ installationId, receiptId }, { ...notification, request: { ...notification.request, content: { ...notification.request.content, attachments: [{ uri: 'private' }] } } })).toBe(false);
  });

  it('keeps uncertain outcomes conservative when scheduling throws and treats web as unavailable', async () => {
    const { api } = bridge();
    api.scheduleNotificationAsync.mockRejectedValueOnce(new Error('native outcome unclear'));
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    expect(await backend.present({ installationId, receiptId }, async () => true)).toBe('delivery_unknown');
    const web = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('web', async () => api);
    expect(await web.getPermission()).toBe('unavailable');
    expect(await web.present({ installationId, receiptId }, async () => true)).toBe('unavailable');
    expect(api.scheduleNotificationAsync).toHaveBeenCalledOnce();
  });

  it('can request permission only through the explicit consent-facing method', async () => {
    const { api } = bridge();
    const backend = (await import('../src/services/mailAlertNotificationBackend')).createMailAlertNotificationBackend('ios', async () => api);
    expect(await backend.requestPermission()).toBe('authorized');
    expect(api.requestPermissionsAsync).toHaveBeenCalledOnce();
  });
});
