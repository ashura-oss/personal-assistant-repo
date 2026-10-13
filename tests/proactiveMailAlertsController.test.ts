import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import { createProactiveMailAlertConsent, planProactiveMailAlerts } from '../src/proactiveMailAlerts/planner';
import { committedMailAlertPageForWorkspace, isMailAlertAttemptCurrentForWorkspace } from '../src/proactiveMailAlerts/workspace';
import { isMatchingProactiveMailAlertNotification, proactiveMailAlertNotificationContent } from '../src/services/mailAlertNotificationBackend';
import { AppControllerImpl } from '../src/services/controller';
import type { ControllerIntegrationDependencies } from '../src/services/controller';
import type { PrivacyWriterScope } from '../src/privacy/types';
import type { ExistingWorkspaceWriterStore } from '../src/privacy/workspaceStorage';
import type { StateStore } from '../src/storage/contracts';

class MemoryStore implements StateStore {
  value?: AppState;
  failLoad = false;
  afterSave?: () => void;
  async load() {
    if (this.failLoad) throw new Error('read failed');
    return this.value ? structuredClone(this.value) : undefined;
  }
  async save(state: AppState) { this.value = structuredClone(state); this.afterSave?.(); }
  async clear() { this.value = undefined; }
  async assertCurrent() {}
}

class JsonRoundTripStore extends MemoryStore {
  override async load() {
    if (this.failLoad) throw new Error('read failed');
    return this.value ? JSON.parse(JSON.stringify(this.value)) as AppState : undefined;
  }
  override async save(state: AppState) {
    this.value = JSON.parse(JSON.stringify(state)) as AppState;
    this.afterSave?.();
  }
}

const alertAccount = {
  id: 'alert-account', provider: 'google' as const, displayName: 'Work', email: 'work@example.test',
  connected: true, authStatus: 'connected' as const,
  identity: { providerNamespace: 'google' as const, clientId: 'alert-client', subject: 'alert-subject' },
  tokenRef: 'opaque-test-ref', capabilities: ['mail.read' as const], connectionGeneration: 4,
};
const alertIdentityKey = 'google:alert-client:alert-subject:';
const alertRule = {
  id: 'project-alert-rule', version: 1, revision: 1, name: 'Project updates', enabled: true,
  accountIds: [], trigger: { type: 'keyword' as const, keywords: ['project'] },
  createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:00.000Z',
};

async function createCancellationFixture() {
  const receiptAt = new Date(Date.now() - 30_000).toISOString();
  const consentAt = new Date(Date.now() - 60_000).toISOString();
  const store = new MemoryStore();
  let cancelCalls = 0;
  let cancellationOutcome: 'absent' | 'cancelled' | 'not_admitted' | 'cancellation_unknown' = 'absent';
  let writerActive = true;
  const backend = {
    platform: 'mock' as const,
    async getPermission() { return 'authorized' as const; },
    async requestPermission() { return 'authorized' as const; },
    async present() { return 'not_admitted' as const; },
    async cancel(_input: { installationId: string; receiptId: string }, beforeCancel: () => Promise<boolean>) {
      cancelCalls++;
      expect(store.value?.proactiveMailAlerts.receipts[0].desired).toBe('cancel');
      if (!await beforeCancel()) return 'not_admitted' as const;
      return cancellationOutcome;
    },
  };
  const integration: ControllerIntegrationDependencies = {
    mailAlertBackend: backend,
    privacySession: {
      epoch: 'test-epoch',
      async assertCurrent() {},
      async getStatus() { return { phase: writerActive ? 'writer_active' as const : 'ready' as const, epoch: 'test-epoch', activeWriterCount: writerActive ? 1 : 0,
        pendingCleanupCount: 0, failedCleanupCount: 0, limits: { namespaces: 10, oauthTokenRefs: 10,
          legacyMarkdownPaths: 10, writerLeases: 10, cleanupTargets: 100, cleanupBatch: 16 }, coverage: 'tracked_with_legacy_limits' as const }; },
    },
    async withMailAlertNotificationWriter<T>(actual: (scope: PrivacyWriterScope, store: ExistingWorkspaceWriterStore) => Promise<T>) {
      return actual(Object.freeze({}) as unknown as PrivacyWriterScope, store as unknown as ExistingWorkspaceWriterStore);
    },
  };
  const app = new AppControllerImpl(store, {}, integration);
  await app.load();
  const state = structuredClone(store.value!);
  const consent = createProactiveMailAlertConsent({
    id: '123e4567-e89b-42d3-a456-426614174201', rule: alertRule,
    timeZone: state.settings.timezone, activatedAt: consentAt,
    accounts: [{ accountId: alertAccount.id, identityKey: alertIdentityKey, connectionGeneration: 4,
      providerNamespace: 'google', connected: true, authStatus: 'connected', canReadMail: true }],
  });
  state.accounts = [alertAccount];
  state.proactive.rules = [structuredClone(alertRule)];
  state.proactiveMailAlerts.consents = [consent];
  state.proactiveMailAlerts.receipts = [{
    id: '123e4567-e89b-42d3-a456-426614174202', installationId: state.proactiveMailAlerts.installationId,
    consentId: consent.id, ruleId: alertRule.id, ruleVersion: alertRule.version, ruleRevision: alertRule.revision,
    timeZone: consent.timeZone, consentActivatedAt: consent.activatedAt, accountId: alertAccount.id,
    identityKey: alertIdentityKey, connectionGeneration: 4, providerMessageId: 'provider-message-1',
    sourceVersion: 'a'.repeat(64), receivedAt: receiptAt, desired: 'notify', observed: 'submitted',
    createdAt: receiptAt, updatedAt: receiptAt, attemptedAt: receiptAt,
  }];
  state.proactiveMailAlerts.revision += 1;
  await store.save(state);
  (app as unknown as { state: AppState }).state = structuredClone(state);
  return { app, store, initial: structuredClone(store.value!), get cancelCalls() { return cancelCalls; },
    set cancellationOutcome(value: 'absent' | 'cancelled' | 'not_admitted' | 'cancellation_unknown') { cancellationOutcome = value; },
    set writerActive(value: boolean) { writerActive = value; } };
}

describe('proactive mail-alert controller state', () => {
  it.each([
    ['rule rename', async (app: AppControllerImpl) => app.saveProactiveRule({ ...alertRule, id: alertRule.id,
      expectedVersion: alertRule.version, name: 'Renamed project updates' })],
    ['rule disable', async (app: AppControllerImpl) => app.saveProactiveRule({ ...alertRule, id: alertRule.id,
      expectedVersion: alertRule.version, enabled: false })],
    ['account replacement', async (app: AppControllerImpl) => app.saveAccount({ id: alertAccount.id,
      provider: 'google', displayName: 'Replacement', email: 'new@example.test' })],
    ['time-zone change', async (app: AppControllerImpl) => app.saveSettings({ timezone: 'Europe/Paris' })],
  ])('automatically requests bounded cancellation after %s is durably saved', async (_label, mutate) => {
    const fixture = await createCancellationFixture();
    expect(fixture.initial.proactiveMailAlerts.receipts[0].desired).toBe('notify');
    await mutate(fixture.app);
    expect((fixture.app as unknown as { state: AppState }).state.proactiveMailAlerts.receipts[0].desired).toBe('cancel');
    expect(fixture.store.value?.proactiveMailAlerts.consents[0].status).toBe('revoked');
    expect(fixture.store.value?.proactiveMailAlerts.receipts[0].desired).toBe('cancel');
    expect(fixture.cancelCalls).toBe(1);
    expect(fixture.store.value?.proactiveMailAlerts.receipts[0].desired).toBe('cancel');
    expect(fixture.store.value?.proactiveMailAlerts.receipts[0].observed).toBe('cancelled');
  });

  it('keeps a committed primary mutation successful when native cancellation is uncertain', async () => {
    const fixture = await createCancellationFixture();
    fixture.cancellationOutcome = 'cancellation_unknown';
    await expect(fixture.app.saveProactiveRule({ ...alertRule, id: alertRule.id,
      expectedVersion: alertRule.version, enabled: false })).resolves.toMatchObject({ enabled: false });
    expect(fixture.cancelCalls).toBe(1);
    expect(fixture.store.value?.proactive.rules[0].enabled).toBe(false);
    expect(fixture.store.value?.proactiveMailAlerts.receipts[0]).toMatchObject({ desired: 'cancel', observed: 'cancellation_unknown', cancellation: { result: 'unknown' } });
  });

  it('gates generic mutations after a committed save loses acknowledgement until a successful explicit reload', async () => {
    const fixture = await createCancellationFixture();
    fixture.store.afterSave = () => { fixture.store.afterSave = undefined; throw new Error('save acknowledgement lost'); };
    await expect(fixture.app.saveProactiveRule({ ...alertRule, id: alertRule.id,
      expectedVersion: alertRule.version, enabled: false })).rejects.toThrow('save acknowledgement lost');
    expect(fixture.store.value?.proactive.rules[0].enabled).toBe(false);
    expect(fixture.store.value?.proactiveMailAlerts.receipts[0].desired).toBe('cancel');
    expect(fixture.app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    await expect(fixture.app.saveNote({ transcript: 'Blocked until reload.' }))
      .rejects.toThrow('Saved data changed. Refresh local data before continuing.');

    fixture.writerActive = false;
    fixture.store.failLoad = true;
    await expect(fixture.app.refreshPersistedWorkspace()).rejects.toThrow('read failed');
    expect(fixture.app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    fixture.store.failLoad = false;
    await fixture.app.refreshPersistedWorkspace();
    expect(fixture.app.getSnapshot().mailAlertRefreshRequired).toBeUndefined();
    await expect(fixture.app.saveNote({ transcript: 'Allowed after reload.' })).resolves.toMatchObject({ transcript: 'Allowed after reload.' });
  });

  it('gates writes when state publication fails after the storage commit', async () => {
    const fixture = await createCancellationFixture();
    const internals = fixture.app as unknown as { publicState: (state: AppState) => AppState };
    const originalPublicState = internals.publicState.bind(fixture.app);
    let failOnce = true;
    internals.publicState = (state) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('state publication failed');
      }
      return originalPublicState(state);
    };

    await expect(fixture.app.saveSettings({ timezone: 'Europe/Paris' }))
      .rejects.toThrow('state publication failed');
    expect(fixture.store.value?.settings.timezone).toBe('Europe/Paris');
    expect(fixture.app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    await expect(fixture.app.saveNote({ transcript: 'Must wait for refresh.' }))
      .rejects.toThrow('Saved data changed. Refresh local data before continuing.');

    fixture.writerActive = false;
    await fixture.app.refreshPersistedWorkspace();
    expect(fixture.app.getSnapshot().mailAlertRefreshRequired).toBeUndefined();
    await expect(fixture.app.saveNote({ transcript: 'Allowed after refresh.' }))
      .resolves.toMatchObject({ transcript: 'Allowed after refresh.' });
  });

  it('does not run cancellation cleanup for unrelated mutations', async () => {
    const fixture = await createCancellationFixture();
    await fixture.app.saveSettings({ mode: 'provider' });
    expect(fixture.cancelCalls).toBe(0);
    expect(fixture.store.value?.proactiveMailAlerts.receipts[0].desired).toBe('notify');
  });

  it('migrates a legacy snapshot to an independent empty alert installation ledger', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    const legacy = structuredClone(store.value!);
    delete (legacy as Partial<AppState>).proactiveMailAlerts;
    store.value = legacy;

    const migrated = new AppControllerImpl(store);
    await migrated.load();
    const state = migrated.getSnapshot();
    expect(state.proactiveMailAlerts.consents).toEqual([]);
    expect(state.proactiveMailAlerts.receipts).toEqual([]);
    expect(state.proactiveMailAlerts.installationId).not.toBe(state.reminders.installationId);
    expect(state.proactiveMailAlertRecoveryStatus).toBeUndefined();
  });

  it('keeps malformed ledger content private while preserving it in persisted quarantine', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    const rawMarker = 'PRIVATE-ALERT-RAW-MARKER';
    (store.value as unknown as Record<string, unknown>).proactiveMailAlerts = { raw: rawMarker };

    const reopened = new AppControllerImpl(store);
    await reopened.load();
    const state = reopened.getSnapshot();
    expect(state.proactiveMailAlerts.consents).toEqual([]);
    expect(state.proactiveMailAlertRecoveryStatus).toEqual({
      quarantined: true,
      message: 'Some saved mail alert settings could not be validated and are held privately. New mail alerts are disabled until recovery.',
    });
    expect(JSON.stringify(state)).not.toContain(rawMarker);
    expect(JSON.stringify(store.value)).toContain(rawMarker);
  });

  it('returns the exact fresh scoped snapshot while adopting only the alert ledger', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const before = app.getSnapshot();
    const exactRaw = structuredClone(store.value!);
    const scoped = (app as unknown as { mailAlertScopedStore(scope: object, store: StateStore): { load(): Promise<AppState | undefined> } })
      .mailAlertScopedStore(Object.freeze({}), store);

    const loaded = await scoped.load();
    expect(loaded).toEqual(exactRaw);
    expect(app.getSnapshot().accounts).toEqual(before.accounts);
    expect(app.getSnapshot().proactiveMailAlerts).toEqual(exactRaw.proactiveMailAlerts);
  });

  it('compares scoped snapshots with JSON storage semantics and still fences private sidecar changes', async () => {
    const store = new JsonRoundTripStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const activeCalendar = { id: 'local-calendar', accountId: 'local-account', name: 'Local', connected: true, writable: true };
    (app as unknown as { state: AppState }).state.calendars = [activeCalendar];
    const quarantine = [{ reason: 'invalid_persisted_receipt' as const, quarantinedAt: '2026-10-13T10:00:00.000Z', raw: { marker: 'private' } }];
    (app as unknown as { dispatchRecordQuarantine: typeof quarantine }).dispatchRecordQuarantine = quarantine;
    await store.save((app as unknown as { persistedState(state: AppState): AppState }).persistedState((app as unknown as { state: AppState }).state));
    const scoped = (app as unknown as { mailAlertScopedStore(scope: object, store: StateStore): { load(): Promise<AppState | undefined> } })
      .mailAlertScopedStore(Object.freeze({}), store);

    const unchanged = await scoped.load();
    expect(unchanged).toEqual(store.value);
    expect(app.getSnapshot().mailAlertRefreshRequired).toBeUndefined();
    expect((app as unknown as { state: AppState }).state.calendars[0]).toMatchObject({ connected: true, writable: true });

    const changedSidecar = structuredClone(store.value!) as AppState & { dispatchRecordQuarantine: unknown[] };
    changedSidecar.dispatchRecordQuarantine = [...changedSidecar.dispatchRecordQuarantine, { raw: { marker: 'changed-private-sidecar' } }];
    await store.save(changedSidecar);
    await expect(scoped.load()).rejects.toThrow('Saved data changed. Refresh local data before continuing.');
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    expect((app as unknown as { state: AppState }).state.calendars[0]).toMatchObject({ connected: true, writable: true });
  });

  it('hard-gates ordinary saves when a scoped load observes unrelated concurrent state', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const before = structuredClone(store.value!);
    const rawChangedElsewhere = structuredClone(before);
    rawChangedElsewhere.settings = { ...rawChangedElsewhere.settings, timezone: 'Europe/Paris' };
    await store.save(rawChangedElsewhere);
    const changedRaw = structuredClone(store.value!);
    const scoped = (app as unknown as { mailAlertScopedStore(scope: object, store: StateStore): { load(): Promise<AppState | undefined> } })
      .mailAlertScopedStore(Object.freeze({}), store);

    await expect(scoped.load()).rejects.toThrow('Saved data changed. Refresh local data before continuing.');
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    await expect(app.saveSettings({ timezone: 'America/Los_Angeles' })).rejects.toThrow('Saved data changed. Refresh local data before continuing.');
    expect(store.value).toEqual(changedRaw);
    await app.refreshPersistedWorkspace();
    expect(app.getSnapshot().mailAlertRefreshRequired).toBeUndefined();
    expect(app.getSnapshot().settings.timezone).toBe('Europe/Paris');
    await app.saveSettings({ timezone: 'America/Los_Angeles' });
    expect(store.value?.settings.timezone).toBe('America/Los_Angeles');
  });

  it('keeps the gate after an unacknowledged committed alert save and retries the explicit reload', async () => {
    const store = new MemoryStore();
    let failPrivacyCheck = false;
    const integration = { privacySession: { epoch: 'test-epoch', async assertCurrent() {
      if (failPrivacyCheck) throw new Error('ownership acknowledgement failed');
    } } };
    const app = new AppControllerImpl(store, {}, integration);
    await app.load();
    const beforeRevision = app.getSnapshot().proactiveMailAlerts.revision;
    const draft = structuredClone(app.getSnapshot());
    draft.proactiveMailAlerts.revision += 1;
    store.afterSave = () => { failPrivacyCheck = true; store.afterSave = undefined; };

    await expect((app as unknown as { commitMailAlertDraft(state: AppState): Promise<void> }).commitMailAlertDraft(draft))
      .rejects.toThrow('ownership acknowledgement failed');
    expect(store.value?.proactiveMailAlerts.revision).toBe(beforeRevision + 1);
    expect(app.getSnapshot().proactiveMailAlerts.revision).toBe(beforeRevision);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    await expect(app.saveSettings({ mode: 'provider' })).rejects.toThrow('Saved data changed. Refresh local data before continuing.');

    failPrivacyCheck = false;
    store.failLoad = true;
    await expect(app.refreshPersistedWorkspace()).rejects.toThrow('read failed');
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    await expect(app.saveSettings({ mode: 'provider' })).rejects.toThrow('Saved data changed. Refresh local data before continuing.');

    store.failLoad = false;
    await app.refreshPersistedWorkspace();
    expect(app.getSnapshot().mailAlertRefreshRequired).toBeUndefined();
    expect(app.getSnapshot().proactiveMailAlerts.revision).toBe(beforeRevision + 1);
  });

  it('rederives the exact current mailbox source before admitting a reserved alert', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const state = structuredClone(app.getSnapshot());
    const now = Date.now();
    const receivedAt = new Date(now - 30_000).toISOString();
    const checkedAt = new Date(now).toISOString();
    const account = {
      id: 'alert-account', provider: 'google' as const, displayName: 'Work', email: 'work@example.test',
      connected: true, authStatus: 'connected' as const,
      identity: { providerNamespace: 'google' as const, clientId: 'alert-client', subject: 'alert-subject' },
      tokenRef: 'opaque-test-ref', capabilities: ['mail.read' as const], connectionGeneration: 4,
    };
    const accountIdentityKey = 'google:alert-client:alert-subject:';
    state.accounts.push(account);
    state.mailbox.push({
      id: 'mail-local-1', accountId: account.id, providerMessageId: 'provider-message-1', identityKey: accountIdentityKey,
      verifiedIdentityKey: accountIdentityKey, connectionGeneration: 4, idFormat: 'gmail', subject: 'Project update',
      senderEmail: 'sam@example.test', receivedAt, isRead: false, observedAt: checkedAt,
    });
    state.mailbox.push({
      id: 'mail-local-2', accountId: account.id, providerMessageId: 'not-in-returned-page', identityKey: accountIdentityKey,
      verifiedIdentityKey: accountIdentityKey, connectionGeneration: 4, idFormat: 'gmail', subject: 'Cached but not returned',
      senderEmail: 'other@example.test', receivedAt, isRead: false, observedAt: checkedAt,
    });
    const rule = {
      id: 'project-alert-rule', version: 1, revision: 1, name: 'Project updates', enabled: true,
      accountIds: [], trigger: { type: 'keyword' as const, keywords: ['project'] },
      createdAt: new Date(now - 60_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString(),
    };
    state.proactive.rules = [rule];
    const consent = createProactiveMailAlertConsent({
      id: '123e4567-e89b-42d3-a456-426614174113', rule, timeZone: state.settings.timezone,
      activatedAt: new Date(now - 45_000).toISOString(),
      accounts: [{ accountId: account.id, identityKey: accountIdentityKey, connectionGeneration: 4,
        providerNamespace: 'google', connected: true, authStatus: 'connected', canReadMail: true }],
    });
    state.proactiveMailAlerts.consents = [consent];
    state.proactiveMailAlerts.revision += 1;
    const digest = async (value: string) => {
      const bytes = new TextEncoder().encode(value);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const page = await committedMailAlertPageForWorkspace(state, account, ['provider-message-1'], checkedAt, {
      now: () => new Date(), digest,
    });
    expect(page).toBeDefined();
    if (!page) throw new Error('Expected exact committed mail page proof.');
    expect(page.sources.map((source) => source.providerId)).toEqual(['provider-message-1']);
    await expect(committedMailAlertPageForWorkspace(state, account, ['bad\nprovider-id'], checkedAt, {
      now: () => new Date(), digest,
    })).resolves.toBeUndefined();
    const plan = planProactiveMailAlerts({
      state: state.proactiveMailAlerts, rules: [rule], accounts: [{ accountId: account.id,
        identityKey: accountIdentityKey, connectionGeneration: 4, providerNamespace: 'google', connected: true,
        authStatus: 'connected', canReadMail: true }], pages: [page],
      previousCandidates: [], dismissedCandidateIds: [], snoozes: [], now: checkedAt,
      currentTimeZone: state.settings.timezone, uuid: () => '123e4567-e89b-42d3-a456-426614174114',
    });
    expect(plan.newAttempts).toHaveLength(1);
    state.proactiveMailAlerts = plan.nextState;
    const check = (candidate: AppState) => isMailAlertAttemptCurrentForWorkspace(candidate, [page], plan.newAttempts[0], {
      now: () => new Date(), digest,
    });

    expect(await check(state)).toBe(true);
    let admissionClock = now;
    const clockAdvancingDigest = async (value: string) => {
      const result = await digest(value);
      admissionClock = now + 16 * 60_000;
      return result;
    };
    expect(await isMailAlertAttemptCurrentForWorkspace(state, [page], plan.newAttempts[0], {
      now: () => new Date(admissionClock), digest: clockAdvancingDigest,
    })).toBe(false);
    const changedState = structuredClone(state);
    changedState.mailbox[0].subject = 'A different project subject';
    expect(await check(changedState)).toBe(false);
    const changedZone = structuredClone(state);
    changedZone.settings.timezone = state.settings.timezone === 'UTC' ? 'Europe/Paris' : 'UTC';
    expect(await check(changedZone)).toBe(false);
    const changedConsentBinding = structuredClone(state);
    changedConsentBinding.proactiveMailAlerts.consents[0].accounts = [];
    expect(await check(changedConsentBinding)).toBe(false);
    const changedRuleScope = structuredClone(state);
    changedRuleScope.proactive.rules[0].accountIds = ['another-account'];
    expect(await check(changedRuleScope)).toBe(false);
    const quarantinedProactive = structuredClone(state);
    quarantinedProactive.proactive.integrityError = 'Saved proactive data failed validation. Local candidate generation is paused.';
    expect(await check(quarantinedProactive)).toBe(false);
    const quarantinedMailAlert = structuredClone(state) as AppState & { proactiveMailAlertQuarantine?: unknown[] };
    quarantinedMailAlert.proactiveMailAlertQuarantine = [{ held: true }];
    expect(await check(quarantinedMailAlert)).toBe(false);

    (app as unknown as { state: AppState }).state = state;
    const content = proactiveMailAlertNotificationContent({ installationId: plan.newAttempts[0].installationId, receiptId: plan.newAttempts[0].id });
    const projection = { title: content.title, body: content.body, data: content.data, sound: content.sound, interruptionLevel: content.interruptionLevel };
    expect(isMatchingProactiveMailAlertNotification({ installationId: plan.newAttempts[0].installationId, receiptId: plan.newAttempts[0].id }, { identifier: content.identifier, content: projection })).toBe(true);
    const allowsForeground = (app as unknown as { isForegroundReminderAllowed(value: unknown): boolean }).isForegroundReminderAllowed.bind(app);
    expect(allowsForeground({ identifier: content.identifier, content: projection })).toBe(true);
    state.settings.timezone = state.settings.timezone === 'UTC' ? 'Europe/Paris' : 'UTC';
    expect(allowsForeground({ identifier: content.identifier, content: projection })).toBe(false);
    state.settings.timezone = consent.timeZone;
    state.proactive.rules[0].accountIds = ['another-account'];
    expect(allowsForeground({ identifier: content.identifier, content: projection })).toBe(false);
    state.proactive.rules[0].accountIds = [];
    state.proactiveMailAlerts.receipts[0].desired = 'cancel';
    expect(allowsForeground({ identifier: content.identifier, content: projection })).toBe(false);
  });

  it('keeps consent out of portable exports and does not replace the local ledger during import', async () => {
    const store = new MemoryStore();
    const first = new AppControllerImpl(store);
    await first.load();
    const rule = {
      id: 'mail-rule-1', version: 1, revision: 1, name: 'Project updates', enabled: true,
      accountIds: [], trigger: { type: 'keyword' as const, keywords: ['project'] },
      createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:00.000Z',
    };
    const consent = createProactiveMailAlertConsent({
      id: '123e4567-e89b-42d3-a456-426614174112', rule, timeZone: 'Asia/Singapore',
      activatedAt: '2026-10-13T10:00:00.000Z',
      accounts: [{ accountId: 'account-1', identityKey: 'google:client:subject:', connectionGeneration: 1,
        providerNamespace: 'google', connected: true, authStatus: 'connected', canReadMail: true }],
    });
    const withConsent = structuredClone(store.value!);
    withConsent.proactiveMailAlerts.consents = [consent];
    withConsent.proactiveMailAlerts.revision = 1;
    await store.save(withConsent);

    const app = new AppControllerImpl(store);
    await app.load();
    const localLedger = structuredClone(app.getSnapshot().proactiveMailAlerts);
    const exported = await app.exportData();
    expect(exported).not.toContain('proactiveMailAlerts');
    expect(exported).not.toContain(consent.id);

    const preview = await app.prepareBackupImport(exported);
    await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    expect(app.getSnapshot().proactiveMailAlerts).toEqual(localLedger);
  });
});
