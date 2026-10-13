import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { Account, AppState } from '../src/core';
import { createBackgroundMailRefreshEngine } from '../src/background/mailRefresh';
import type { BackgroundMailAlertWriter, BackgroundMailConnector } from '../src/background/mailRefresh.types';
import { ConnectorClient } from '../src/connectors';
import type { OAuthTokenStore } from '../src/connectors';
import type { PrivacyService, PrivacyWorkspaceSession } from '../src/privacy/service';
import type { SQLiteExecutor, SQLiteTransactionDatabase } from '../src/storage/platformStorage';
import { SQLiteStateStore } from '../src/storage/platformStorage';
import type { StateStore } from '../src/storage/contracts';
import { emptyProactiveMailAlertState, createProactiveMailAlertConsent, validateProactiveMailAlertState } from '../src/proactiveMailAlerts';
import type { MailAlertNotificationBackend } from '../src/services/mailAlertNotificationBackend';
import type { ExistingWorkspaceWriterStore } from '../src/privacy/workspaceStorage';
import type { PrivacyWriterScope } from '../src/privacy/types';

const session: PrivacyWorkspaceSession = Object.freeze({ epoch: '00000000-0000-4000-8000-000000000001', runtimeId: '00000000-0000-4000-8000-000000000002' });
const tokenRef = '00000000-0000-4000-8000-000000000003';
const randomUuid = (() => { let n = 10; return () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`; })();

function account(id = 'google-1'): Account {
  return {
    id, provider: 'google', displayName: 'Inbox', email: 'person@example.test', connected: true, authStatus: 'connected', tokenRef,
    identity: { providerNamespace: 'google', clientId: 'google-client', subject: 'stable-subject' },
    capabilities: ['mail.read'], grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'], connectionGeneration: 4,
  };
}

function appState(accounts: Account[] = [account()], extras: Record<string, unknown> = {}): AppState {
  const base = {
    notes: [], proposals: [], tasks: [], accounts, calendars: [], documents: [], activity: [],
    settings: { mode: 'preview', timezone: 'UTC', backgroundMailRefreshEnabled: true, backgroundRefreshGeneration: 3,
      maxContextTokens: 1000, maxRequestBytes: 24000, maxOutputTokens: 500, monthlyBudgetUsd: 5, reasoningEffort: 'none',
      maxAttempts: 2, maxCallsPerDay: 20, maxAudioSeconds: 600, audioRetention: 'keep' },
    usage: { month: '2026-10', day: '2026-10-13', requests: 0, attemptsToday: 0, inputTokens: 0, outputTokens: 0,
      transcriptionSeconds: 0, attempts: 0, unknownCharges: 0, reservedUsd: 0, priceKnown: false, estimatedCostUsd: 0 },
    transcription: { schemaVersion: 1, installationUUID: randomUuid(), attempts: [], cleanupLeases: [] },
    mailbox: [], selectedMailTexts: [], calendarEvents: [], deviceCalendars: { schemaVersion: 1, installationId: randomUuid(), generation: 1,
      selectionRevision: 1, enabled: false, selectedCalendarIds: [], calendars: [], events: [], dispatchRecords: [] },
    deviceCalendarAccess: { status: 'needs_check' }, syncStates: {}, pendingCredentialCleanup: [], dispatchRecords: [], mailboxSchemaVersion: 2,
    proactive: { schemaVersion: 1, rules: [], candidates: [], dismissals: [], snoozes: [] }, importedBackups: [],
    knowledge: { schemaVersion: 1, people: [], projects: [], suggestions: [] }, reminders: { schemaVersion: 1, installationId: randomUuid(), records: [], dispatches: [], cleanups: [] },
    privateEnvelope: { preserved: true },
    ...extras,
  };
  return base as unknown as AppState;
}

function sqliteMemory() {
  const raw = new DatabaseSync(':memory:');
  const executor: SQLiteExecutor = {
    async execAsync(sql) { raw.exec(sql); },
    async runAsync(sql, ...params) { const result = raw.prepare(sql).run(...params as never[]); return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) }; },
    async getFirstAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return (raw.prepare(sql).get(...params as never[]) as T | undefined) ?? null; },
    async getAllAsync<T>(sql: string, ...params: import('expo-sqlite').SQLiteBindValue[]) { return raw.prepare(sql).all(...params as never[]) as T[]; },
  };
  let tail = Promise.resolve();
  const database: SQLiteTransactionDatabase & { close(): void } = {
    ...executor,
    async withExclusiveTransactionAsync(work) {
      const previous = tail; let unlock!: () => void; tail = new Promise<void>((resolve) => { unlock = resolve; }); await previous;
      raw.exec('BEGIN IMMEDIATE');
      try { await work(executor); raw.exec('COMMIT'); } catch (error) { raw.exec('ROLLBACK'); throw error; } finally { unlock(); }
    },
    close() { raw.close(); },
  };
  return database;
}

function privacy(phase: 'ready' | 'writer_active' | 'erasing' | 'complete' = 'ready') {
  let active = phase === 'writer_active' ? 1 : 0;
  const withWriter = vi.fn(async (_epoch: string, _descriptor: unknown, work: (lease: unknown) => Promise<unknown>) => {
    active++;
    try { return await work({ id: randomUuid() }); } finally { active--; }
  });
  const service = {
    async getStatus() { return { phase: active > 0 ? 'writer_active' : phase, epoch: session.epoch, activeWriterCount: active, pendingCleanupCount: 0, failedCleanupCount: 0, limits: {}, coverage: 'tracked_with_legacy_limits' }; },
    async assertWorkspaceEpoch(epoch: string) { if (epoch !== session.epoch) throw new Error('stale_epoch'); },
    withWriter,
    setActive(value: number) { active = value; },
  } as unknown as PrivacyService & { withWriter: typeof withWriter; setActive(value: number): void };
  return service;
}

function stateWithMailAlerts(): AppState {
  const initial = appState();
  const accountValue = initial.accounts[0];
  const binding = { accountId: accountValue.id, providerNamespace: 'google' as const,
    identityKey: 'google:google-client:stable-subject:', connectionGeneration: accountValue.connectionGeneration ?? 0,
    connected: true, authStatus: 'connected' as const, canReadMail: true };
  const rule = { id: 'background-alert-rule', name: 'Build updates', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    version: 1, revision: 1, enabled: true, accountIds: [accountValue.id],
    trigger: { type: 'keyword' as const, keywords: ['build'] } };
  const consent = createProactiveMailAlertConsent({ id: '30000000-0000-4000-8000-000000000001', rule,
    timeZone: 'UTC', activatedAt: '2026-10-12T00:00:00.000Z', accounts: [binding] });
  return { ...initial,
    proactive: { schemaVersion: 1, rules: [rule], candidates: [], dismissals: [], snoozes: [] },
    proactiveMailAlerts: validateProactiveMailAlertState({ ...emptyProactiveMailAlertState('30000000-0000-4000-8000-000000000002'),
      revision: 1, consents: [consent] }),
  } as unknown as AppState;
}

function alertBackend(onPresent?: () => Promise<void>): MailAlertNotificationBackend {
  return {
    platform: 'mock',
    async getPermission() { return 'authorized'; },
    async requestPermission() { throw new Error('automatic flow must not request permission'); },
    async present(_input, beforePresent) {
      if (!(await beforePresent())) return 'not_admitted';
      await onPresent?.();
      return 'submitted';
    },
    async cancel(_input, beforeCancel) { return (await beforeCancel()) ? 'absent' : 'not_admitted'; },
  };
}

function page(accountValue: Account, window = { from: '2026-09-29T00:00:00.000Z', to: '2026-10-13T00:00:00.000Z' }) {
  const identity = accountValue.identity!;
  const queryFingerprint = JSON.stringify(['mail-window-v1', accountValue.provider, identity.providerNamespace, identity.clientId, identity.subject, '', window.from, window.to, 5]);
  return { items: [{ id: 'provider-message-1', idFormat: 'gmail' as const, subject: 'Hello', receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }],
    nextCursor: undefined, partial: false, window, queryFingerprint, unavailableIds: [] };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('background mail refresh engine', () => {
  it('uses only a durably committed exact page and reserves before presenting one privacy-minimal alert', async () => {
    const db = sqliteMemory();
    try {
      const initial = stateWithMailAlerts();
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      await seed.load(); await seed.save(initial);
      const reader = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      const privacyService = privacy();
      let presentCount = 0;
      const backend = alertBackend(async () => {
        presentCount++;
        const current = await reader.load();
        expect(current?.proactiveMailAlerts.receipts).toHaveLength(1);
        expect(current?.proactiveMailAlerts.receipts[0]).toMatchObject({ desired: 'notify', observed: 'attempting' });
      });
      const notificationWriter: BackgroundMailAlertWriter = {
        async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
          return await privacyService.withWriter(session.epoch,
            { kind: 'notification', namespace: 'notifications' }, async () => work({} as never, {
              load: () => store.load(), save: (value, options) => store.save(value, options),
              assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
            })) as T;
        },
      };
      const engine = createBackgroundMailRefreshEngine({
        privacy: privacyService, session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} },
        withProviderOwnership: async (actual) => actual(),
        mailAlerts: { backend, notificationWriter },
        connectorFactory: () => ({ async syncMessageWindow(selected) {
          return { ...page(selected), items: [{ id: 'provider-message-1', idFormat: 'gmail', subject: 'Build status',
            receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }] };
        } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'refreshed', completed: 1 });
      expect(presentCount).toBe(1);
      const final = await reader.load();
      expect(final?.proactiveMailAlerts.receipts[0]).toMatchObject({ observed: 'submitted', providerMessageId: 'provider-message-1' });
    } finally { db.close(); }
  });

  it('applies the two-attempt alert limit across all committed account pages in one run', async () => {
    const db = sqliteMemory();
    try {
      const initial = stateWithMailAlerts();
      const second = account('google-2');
      initial.accounts.push(second);
      const rule = initial.proactive.rules[0] as AppState['proactive']['rules'][number] & { version: number };
      rule.accountIds = [];
      const bindings = initial.accounts.map((value) => ({ accountId: value.id, providerNamespace: 'google' as const,
        identityKey: 'google:google-client:stable-subject:', connectionGeneration: value.connectionGeneration ?? 0,
        connected: true, authStatus: 'connected' as const, canReadMail: true }));
      const consent = createProactiveMailAlertConsent({ id: '30000000-0000-4000-8000-000000000004', rule,
        timeZone: 'UTC', activatedAt: '2026-10-12T00:00:00.000Z', accounts: bindings });
      initial.proactiveMailAlerts = validateProactiveMailAlertState({ ...emptyProactiveMailAlertState('30000000-0000-4000-8000-000000000002'),
        revision: 1, consents: [consent] });
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(initial);
      let presentations = 0; let permissionRequests = 0; let pages = 0;
      const backend: MailAlertNotificationBackend = {
        platform: 'mock', async getPermission() { return 'authorized'; },
        async requestPermission() { permissionRequests++; throw new Error('background must not prompt'); },
        async present(_input, beforePresent) { if (!(await beforePresent())) return 'not_admitted'; presentations++; return 'submitted'; },
        async cancel(_input, beforeCancel) { return (await beforeCancel()) ? 'absent' : 'not_admitted'; },
      };
      const privacyService = privacy();
      const notificationWriter: BackgroundMailAlertWriter = {
        async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
          return await privacyService.withWriter(session.epoch, { kind: 'notification', namespace: 'notifications' }, async () => work({} as never, {
            load: () => store.load(), save: (value, options) => store.save(value, options),
            assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
          })) as T;
        },
      };
      const engine = createBackgroundMailRefreshEngine({ privacy: privacyService, session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        mailAlerts: { backend, notificationWriter },
        connectorFactory: () => ({ async syncMessageWindow(selected, options) {
          pages++;
          return { ...page(selected, { from: options.timeMin, to: options.timeMax }), items: [1, 2, 3].map((n) => ({
            id: `${selected.id}-message-${n}`, idFormat: 'gmail' as const, subject: 'Build project update',
            receivedAt: `2026-10-12T${String(10 + n).padStart(2, '0')}:00:00.000Z`, isRead: false,
          })) };
        } }), now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'refreshed', attempted: 2, completed: 2 });
      expect(pages).toBe(2);
      expect(presentations).toBe(2);
      expect(permissionRequests).toBe(0);
      const final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      expect(final?.proactiveMailAlerts.receipts).toHaveLength(2);
      expect(final?.proactiveMailAlerts.receipts.every((receipt) => receipt.observed === 'submitted')).toBe(true);
    } finally { db.close(); }
  });

  it('keeps a lost-ack alert reservation consumed and never resends it on a later run', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(stateWithMailAlerts());
      let loseReservationAck = true; let presentations = 0; let permissionRequests = 0;
      const createStateStore = () => {
        const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
        const save = store.save.bind(store);
        store.save = async (state, options) => {
          const alert = (state as AppState).proactiveMailAlerts;
          const isReservation = alert?.receipts.some((receipt) => receipt.observed === 'attempting');
          await save(state, options);
          if (loseReservationAck && isReservation) {
            loseReservationAck = false;
            throw new Error('lost acknowledgement after reservation commit');
          }
        };
        return store;
      };
      const privacyService = privacy();
      const backend: MailAlertNotificationBackend = {
        platform: 'mock', async getPermission() { return 'authorized'; },
        async requestPermission() { permissionRequests++; throw new Error('background must not prompt'); },
        async present(_input, beforePresent) { if (!(await beforePresent())) return 'not_admitted'; presentations++; return 'submitted'; },
        async cancel(_input, beforeCancel) { return (await beforeCancel()) ? 'absent' : 'not_admitted'; },
      };
      const notificationWriter: BackgroundMailAlertWriter = {
        async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
          return await privacyService.withWriter(session.epoch, { kind: 'notification', namespace: 'notifications' }, async () => work({} as never, {
            load: () => store.load(), save: (value, options) => store.save(value, options),
            assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
          })) as T;
        },
      };
      let nowMs = Date.parse('2026-10-13T00:00:00.000Z');
      const engine = createBackgroundMailRefreshEngine({ privacy: privacyService, session, createStateStore,
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        mailAlerts: { backend, notificationWriter },
        connectorFactory: () => ({ async syncMessageWindow(selected, options) {
          return { ...page(selected, { from: options.timeMin, to: options.timeMax }), items: [{ id: 'provider-message-1', idFormat: 'gmail',
            subject: 'Build status', receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }] };
        } }), now: () => new Date(nowMs), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'refreshed', completed: 1 });
      expect(loseReservationAck).toBe(false);
      expect(presentations).toBe(0);
      let final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      expect(final?.proactiveMailAlerts.receipts).toHaveLength(1);
      expect(final?.proactiveMailAlerts.receipts[0]).toMatchObject({ desired: 'notify', observed: 'attempting', providerMessageId: 'provider-message-1' });

      nowMs += 16 * 60_000;
      await expect(engine.run()).resolves.toMatchObject({ status: 'refreshed', completed: 1 });
      expect(presentations).toBe(0);
      expect(permissionRequests).toBe(0);
      final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      expect(final?.proactiveMailAlerts.receipts).toHaveLength(1);
      expect(final?.proactiveMailAlerts.receipts[0]).toMatchObject({ desired: 'notify', observed: 'attempting', providerMessageId: 'provider-message-1' });
    } finally { db.close(); }
  });

  it('rechecks the run gate after a queued notification writer is granted', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      await seed.load(); await seed.save(stateWithMailAlerts());
      const enteredWriter = deferred<void>(); const releaseWriter = deferred<void>();
      let presentations = 0;
      const notificationWriter: BackgroundMailAlertWriter = {
        async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
          enteredWriter.resolve();
          await releaseWriter.promise;
          return await work({} as never, {
            load: () => store.load(), save: (value, options) => store.save(value, options),
            assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
          });
        },
      };
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(), deadlineMs: 1_000,
        mailAlerts: { backend: alertBackend(async () => { presentations++; }), notificationWriter },
        connectorFactory: () => ({ async syncMessageWindow(selected) { return { ...page(selected), items: [{ id: 'provider-message-1',
          idFormat: 'gmail', subject: 'Build status', receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }] }; } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      const run = engine.run();
      await enteredWriter.promise;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      releaseWriter.resolve();
      await expect(run).resolves.toMatchObject({ status: 'refreshed', completed: 1 });
      expect(presentations).toBe(0);
      const final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      expect(final?.proactiveMailAlerts.receipts).toHaveLength(1);
      expect(final?.proactiveMailAlerts.receipts[0].observed).toBe('attempting');
    } finally { db.close(); }
  });

  it('rejects final admission when opt-out changes during asynchronous source verification', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      await seed.load(); await seed.save(stateWithMailAlerts());
      const privacyService = privacy();
      const verifying = deferred<void>(); const continueDigest = deferred<string>();
      let digestCalls = 0; let nativeSchedules = 0;
      const backend: MailAlertNotificationBackend = {
        platform: 'mock', async getPermission() { return 'authorized'; }, async requestPermission() { throw new Error('no prompt'); },
        async present(_input, beforePresent) {
          if (!(await beforePresent())) return 'not_admitted';
          nativeSchedules++;
          return 'submitted';
        }, async cancel(_input, beforeCancel) { return (await beforeCancel()) ? 'absent' : 'not_admitted'; },
      };
      const notificationWriter: BackgroundMailAlertWriter = {
        async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
          return await privacyService.withWriter(session.epoch, { kind: 'notification', namespace: 'notifications' }, async () => work({} as never, {
            load: () => store.load(), save: (value, options) => store.save(value, options),
            assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
          })) as T;
        },
      };
      const engine = createBackgroundMailRefreshEngine({ privacy: privacyService, session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        mailAlerts: { backend, notificationWriter, digest: async (text) => {
          digestCalls++;
          if (digestCalls === 2) { verifying.resolve(); return continueDigest.promise; }
          return `digest-${digestCalls}-${text.length}`;
        } },
        connectorFactory: () => ({ async syncMessageWindow(selected) { return { ...page(selected), items: [{ id: 'provider-message-1',
          idFormat: 'gmail', subject: 'Build status', receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }] }; } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      const run = engine.run();
      await verifying.promise;
      const uiStore = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      const current = await uiStore.load() as AppState;
      current.settings.backgroundMailRefreshEnabled = false;
      current.settings.backgroundRefreshGeneration = 4;
      await uiStore.save(current);
      continueDigest.resolve('verified-but-stale');
      await expect(run).resolves.toMatchObject({ status: 'refreshed', completed: 1 });
      expect(nativeSchedules).toBe(0);
      const final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      expect(final?.settings.backgroundMailRefreshEnabled).toBe(false);
      expect(final?.proactiveMailAlerts.receipts).toHaveLength(1);
      expect(final?.proactiveMailAlerts.receipts[0].observed).toBe('attempting');
    } finally { db.close(); }
  });

  it('keeps the successful mail result when optional page hashing finishes after the run deadline', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      await seed.load(); await seed.save(stateWithMailAlerts());
      const hashing = deferred<void>(); const finishHash = deferred<string>();
      let providerCalls = 0; let writerCalls = 0;
      const privacyService = privacy();
      const backend = alertBackend();
      const notificationWriter: BackgroundMailAlertWriter = {
        async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
          writerCalls++;
          return await privacyService.withWriter(session.epoch, { kind: 'notification', namespace: 'notifications' }, async () => work({} as never, {
            load: () => store.load(), save: (value, options) => store.save(value, options),
            assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
          })) as T;
        },
      };
      const engine = createBackgroundMailRefreshEngine({ privacy: privacyService, session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(), deadlineMs: 1_000,
        mailAlerts: { backend, notificationWriter, digest: async () => { hashing.resolve(); return finishHash.promise; } },
        connectorFactory: () => ({ async syncMessageWindow(selected) {
          providerCalls++;
          return { ...page(selected), items: [{ id: 'provider-message-1', idFormat: 'gmail', subject: 'Build status',
            receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }] };
        } }), now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      const run = engine.run();
      await hashing.promise;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      finishHash.resolve('late-but-unused');
      await expect(run).resolves.toMatchObject({ status: 'refreshed', completed: 1 });
      expect(providerCalls).toBe(1);
      expect(writerCalls).toBe(0);
      const final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      expect(final?.mailbox.map((row) => row.providerMessageId)).toEqual(['provider-message-1']);
      expect(final?.proactiveMailAlerts.receipts).toEqual([]);
    } finally { db.close(); }
  });

  it('does not widen a committed-page proof when provider-owned page data mutates during save', async () => {
    const db = sqliteMemory();
    try {
      const initial = stateWithMailAlerts();
      initial.mailbox = [{ id: 'cached-build', accountId: initial.accounts[0].id, providerMessageId: 'cached-build',
        identityKey: 'google:google-client:stable-subject::cached-build', verifiedIdentityKey: 'google:google-client:stable-subject:',
        connectionGeneration: 4, idFormat: 'gmail', subject: 'Build status from cache', receivedAt: '2026-10-12T11:00:00.000Z',
        isRead: false, observedAt: '2026-10-12T12:00:00.000Z' }];
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(initial);
      const rawPage = page(initial.accounts[0]);
      rawPage.items = [{ id: 'unrelated-provider-message', idFormat: 'gmail', subject: 'General note',
        receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }];
      let mutated = false; let presentations = 0;
      const privacyService = privacy();
      const storeFactory = () => {
        const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
        const save = store.save.bind(store);
        store.save = async (state, options) => {
          if ((state as AppState).mailbox.some((row) => row.providerMessageId === 'unrelated-provider-message') && !mutated) {
            mutated = true;
            rawPage.items.push({ id: 'cached-build', idFormat: 'gmail', subject: 'Build status from cache',
              receivedAt: '2026-10-12T11:00:00.000Z', isRead: false });
          }
          await save(state, options);
        };
        return store;
      };
      const notificationWriter: BackgroundMailAlertWriter = {
        async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
          return await privacyService.withWriter(session.epoch, { kind: 'notification', namespace: 'notifications' }, async () => work({} as never, {
            load: () => store.load(), save: (value, options) => store.save(value, options),
            assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
          })) as T;
        },
      };
      const engine = createBackgroundMailRefreshEngine({ privacy: privacyService, session, createStateStore: storeFactory,
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        mailAlerts: { backend: alertBackend(async () => { presentations++; }), notificationWriter },
        connectorFactory: () => ({ async syncMessageWindow() { return rawPage; } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'refreshed', completed: 1 });
      expect(mutated).toBe(true);
      expect(presentations).toBe(0);
      const final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      expect(final?.proactiveMailAlerts.receipts).toEqual([]);
    } finally { db.close(); }
  });

  it.each(['missing-token-ref', 'missing-read-scope', 'malformed-capabilities', 'duplicate-id'] as const)(
    'does not use an ineligible persisted account for a mail alert (%s)', async (failure) => {
      const db = sqliteMemory();
      try {
        const initial = stateWithMailAlerts();
        if (failure === 'missing-token-ref') initial.accounts[0].tokenRef = undefined as never;
        if (failure === 'missing-read-scope') initial.accounts[0].grantedScopes = ['openid'];
        if (failure === 'malformed-capabilities') initial.accounts[0].capabilities = 'mail.read' as never;
        if (failure === 'duplicate-id') initial.accounts.push({ ...account(initial.accounts[0].id),
          identity: { providerNamespace: 'google', clientId: 'other-client', subject: 'other-subject' } });
        const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(initial);
        let requests = 0; let presentations = 0;
        const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
          createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
          tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
          mailAlerts: { backend: alertBackend(async () => { presentations++; }), notificationWriter: {
            async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
              return await privacy().withWriter(session.epoch, { kind: 'notification', namespace: 'notifications' }, async () => work({} as never, {
                load: () => store.load(), save: (value, options) => store.save(value, options),
                assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
              })) as T;
            },
          } },
          connectorFactory: () => ({ async syncMessageWindow(selected) { requests++; return { ...page(selected), items: [{ id: 'provider-message-1',
            idFormat: 'gmail', subject: 'Build status', receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }] }; } }),
          now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
        });
        await engine.run();
        expect(requests).toBe(0);
        expect(presentations).toBe(0);
        const final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
        expect(final?.proactiveMailAlerts.receipts).toEqual([]);
        expect(final?.accounts).toEqual(initial.accounts);
      } finally { db.close(); }
    });

  it('preserves and rejects unknown nested __proto__ ledger metadata without presenting', async () => {
    const db = sqliteMemory();
    try {
      const initial = stateWithMailAlerts();
      const rawLedger = JSON.parse(JSON.stringify(initial.proactiveMailAlerts)) as Record<string, unknown>;
      rawLedger.extension = JSON.parse('{"__proto__":{"marker":"must-stay-private"}}');
      initial.proactiveMailAlerts = rawLedger as never;
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(initial);
      let presentations = 0;
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        mailAlerts: { backend: alertBackend(async () => { presentations++; }), notificationWriter: {
          async withNotificationWriter<T>(store: StateStore, work: (scope: PrivacyWriterScope, scopedStore: ExistingWorkspaceWriterStore) => Promise<T>): Promise<T> {
            return await privacy().withWriter(session.epoch, { kind: 'notification', namespace: 'notifications' }, async () => work({} as never, {
              load: () => store.load(), save: (value, options) => store.save(value, options),
              assertCurrent: () => store.assertCurrent?.() ?? Promise.reject(new Error('no store generation fence')),
            })) as T;
          },
        } },
        connectorFactory: () => ({ async syncMessageWindow(selected) { return { ...page(selected), items: [{ id: 'provider-message-1',
          idFormat: 'gmail', subject: 'Build status', receivedAt: '2026-10-12T12:00:00.000Z', isRead: false }] }; } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await engine.run();
      expect(presentations).toBe(0);
      const persisted = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      const serialized = JSON.stringify(persisted?.proactiveMailAlerts);
      expect(serialized).toContain('"__proto__"');
      expect(serialized).toContain('must-stay-private');
    } finally { db.close(); }
  });

  it('persists the attempt before a single metadata page and preserves unrelated raw fields', async () => {
    const db = sqliteMemory();
    try {
      const initial = appState();
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      await seed.load(); await seed.save(initial);
      const reader = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      let providerCalls = 0;
      const connectorFactory = (): BackgroundMailConnector => ({
        async syncMessageWindow(selected, options) {
          providerCalls++;
          const beforeRequest = await reader.load();
          expect(beforeRequest?.syncStates[selected.id]?.mailHead.lastAttemptAt).toBe('2026-10-13T00:00:00.000Z');
          expect(options).toMatchObject({ pageSize: 5, allowTokenRefresh: false });
          return page(selected);
        },
      });
      const engine = createBackgroundMailRefreshEngine({
        privacy: privacy(), session, createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }), tokenStore: { async get() { return null; }, async set() {} },
        withProviderOwnership: async (actual) => actual(), connectorFactory,
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      const result = await engine.run();
      expect(result).toMatchObject({ status: 'refreshed', attempted: 1, completed: 1, failed: 0 });
      expect(providerCalls).toBe(1);
      const persisted = await reader.load();
      expect((persisted as AppState & { privateEnvelope: { preserved: boolean } }).privateEnvelope).toEqual({ preserved: true });
      expect(persisted?.mailbox).toHaveLength(1);
      expect(persisted?.syncStates[initial.accounts[0].id]?.mailHead.completeWindow).toEqual({ from: '2026-09-29T00:00:00.000Z', through: '2026-10-13T00:00:00.000Z' });
    } finally { db.close(); }
  });

  it('limits a run to two accounts and skips a clock-rollback cooldown without making provider calls', async () => {
    const db = sqliteMemory();
    try {
      const accounts = [account('a'), account('b'), account('c')];
      const initial = appState(accounts, { syncStates: { a: { accountId: 'a', status: 'idle', mailHead: { status: 'idle' } },
        b: { accountId: 'b', status: 'idle', mailHead: { status: 'idle' } },
        c: { accountId: 'c', status: 'idle', mailHead: { status: 'idle', lastAttemptAt: '2026-10-13T00:05:00.000Z' } } } });
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(initial);
      let calls = 0;
      const engine = createBackgroundMailRefreshEngine({
        privacy: privacy(), session, createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) { calls++; return page(selected); } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      const result = await engine.run();
      expect(result).toMatchObject({ attempted: 2, completed: 2, skipped: 1 });
      expect(calls).toBe(2);
    } finally { db.close(); }
  });

  it('fails its final CAS after a concurrent UI write without overwriting the UI snapshot', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(appState());
      const releaseProvider = deferred<void>(); const providerStarted = deferred<void>();
      const engine = createBackgroundMailRefreshEngine({
        privacy: privacy(), session, createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) { providerStarted.resolve(); await releaseProvider.promise; return page(selected); } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      const job = engine.run(); await providerStarted.promise;
      const uiStore = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
      const ui = await uiStore.load() as AppState & { privateEnvelope: { preserved: boolean; uiEdit?: string } };
      ui.privateEnvelope.uiEdit = 'keep this concurrent write'; await uiStore.save(ui);
      releaseProvider.resolve();
      await expect(job).resolves.toMatchObject({ status: 'failed', reason: 'stale_state', completed: 0 });
      const final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load() as (AppState & { privateEnvelope: { uiEdit?: string } });
      expect(final.privateEnvelope.uiEdit).toBe('keep this concurrent write');
      expect(final.mailbox).toHaveLength(0);
    } finally { db.close(); }
  });

  it('allows only one of two workers with the same captured baseline to claim and dispatch', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(appState());
      const bothLoaded = deferred<void>(); const providerStarted = deferred<void>(); const releaseProvider = deferred<void>();
      let loadArrivals = 0; let providerCalls = 0;
      const createStateStore = () => {
        const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
        const load = store.load.bind(store);
        store.load = async () => {
          const result = await load();
          loadArrivals++;
          if (loadArrivals === 2) bothLoaded.resolve();
          await bothLoaded.promise;
          return result;
        };
        return store;
      };
      const engine = () => createBackgroundMailRefreshEngine({ privacy: privacy(), session, createStateStore,
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) {
          providerCalls++;
          providerStarted.resolve();
          await releaseProvider.promise;
          return page(selected);
        } }), now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      const first = engine().run(); const second = engine().run();
      await providerStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(providerCalls).toBe(1);
      releaseProvider.resolve();
      const results = await Promise.all([first, second]);
      expect(providerCalls).toBe(1);
      expect(results.reduce((sum, item) => sum + item.attempted, 0)).toBe(1);
      expect(results.filter((item) => item.completed === 1)).toHaveLength(1);
    } finally { db.close(); }
  });

  it('does not retry HTTP after a committed page save loses its acknowledgement and preserves the private slot', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(appState());
      const privateCaptureId = '10000000-0000-4000-8000-000000000001';
      const privateFileId = '10000000-0000-4000-8000-000000000002';
      const before = await seed.pendingCapture!.create(null, {
        version: 1, id: privateCaptureId, originalPath: `ExpoAudio/recording-${privateFileId}.m4a`,
        capturedAt: '2026-10-13T00:00:00.000Z', captureTimeZone: 'UTC', phase: 'prepared', replacementPaths: [], replacementOverflow: false,
      });
      if (before.kind !== 'valid') throw new Error('Expected a valid private capture fixture.');
      const providerCalls = { value: 0 }; let saves = 0;
      const createStateStore = () => {
        const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
        const save = store.save.bind(store);
        store.save = async (state, options) => {
          saves++;
          await save(state, options);
          if (saves === 2) throw new Error('simulated lost acknowledgement after commit');
        };
        return store;
      };
      const engine = () => createBackgroundMailRefreshEngine({ privacy: privacy(), session, createStateStore,
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) { providerCalls.value++; return page(selected); } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      const readPending = async () => {
        const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
        await store.load();
        return store.pendingCapture!.read();
      };
      await expect(engine().run()).resolves.toMatchObject({ status: 'failed', reason: 'stale_state', completed: 0 });
      const afterFirst = await readPending();
      expect(afterFirst).toMatchObject({ kind: 'valid', revision: before.revision, capture: { id: privateCaptureId } });
      await expect(engine().run()).resolves.toMatchObject({ status: 'skipped', reason: 'cooldown' });
      expect(providerCalls.value).toBe(1);
      expect(await readPending()).toMatchObject({
        kind: 'valid', revision: before.revision, capture: { id: privateCaptureId },
      });
    } finally { db.close(); }
  });

  it('rechecks deadline after state-writer admission and does not reserve once expired', async () => {
    const loaded = appState();
    const waitingForReservation = deferred<void>(); const allowWriter = deferred<void>();
    let writerCalls = 0; let saves = 0; let requests = 0;
    const privacyService = {
      async getStatus() { return { phase: 'ready', epoch: session.epoch, activeWriterCount: 0, pendingCleanupCount: 0, failedCleanupCount: 0, limits: {}, coverage: 'tracked_with_legacy_limits' }; },
      async assertWorkspaceEpoch() {},
      async withWriter<T>(_epoch: string, _descriptor: unknown, work: (lease: unknown) => Promise<T>) {
        writerCalls++;
        if (writerCalls === 2) { waitingForReservation.resolve(); await allowWriter.promise; }
        return work({ id: randomUuid() });
      },
    } as unknown as PrivacyService;
    const store: StateStore = { async load() { return structuredClone(loaded); }, async save() { saves++; }, async clear() {}, async assertCurrent() {} };
    const engine = createBackgroundMailRefreshEngine({ privacy: privacyService, session, createStateStore: () => store,
      tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(), deadlineMs: 1_000,
      connectorFactory: () => ({ async syncMessageWindow(selected) { requests++; return page(selected); } }),
      now: () => new Date('2026-10-13T00:00:00.000Z'),
    });
    const run = engine.run();
    await waitingForReservation.promise;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    allowWriter.resolve();
    await expect(run).resolves.toMatchObject({ status: 'failed', reason: 'deadline' });
    expect(saves).toBe(0);
    expect(requests).toBe(0);
  });

  it.each(['writer_active', 'erasing', 'complete'] as const)('does not read app storage when privacy is %s', async (phase) => {
    const createStateStore = vi.fn(() => { throw new Error('must not open app state'); });
    const engine = createBackgroundMailRefreshEngine({ privacy: privacy(phase), session, createStateStore,
      tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual() });
    await expect(engine.run()).resolves.toMatchObject({ status: 'skipped', reason: 'privacy_not_ready' });
    expect(createStateStore).not.toHaveBeenCalled();
  });

  it('does not send or refresh when the stored access token is expired', async () => {
    const db = sqliteMemory();
    try {
      const selected = account(); const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(appState([selected]));
      const tokenStore: OAuthTokenStore = { async get() { return { accessToken: 'expired-token', refreshToken: 'refresh-token', expiresAt: 1, identity: selected.identity! }; }, async set() { throw new Error('must not rotate'); } };
      const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
      const authStatus = vi.fn();
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }), tokenStore,
        withProviderOwnership: async (actual) => actual(),
        connectorFactory: (boundStore, ownership) => new ConnectorClient({ tokenStore: boundStore, fetcher, withProviderOwnership: ownership, onAuthStatus: authStatus }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'failed', failed: 1, reason: 'provider_unavailable' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(authStatus).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('treats provider 401 as a read failure without refresh or auth-status mutation', async () => {
    const db = sqliteMemory();
    try {
      const selected = account(); const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(appState([selected]));
      const tokenStore: OAuthTokenStore = { async get() { return { accessToken: 'valid-looking-token', refreshToken: 'refresh-token', expiresAt: Date.now() + 600_000, identity: selected.identity! }; }, async set() { throw new Error('must not rotate'); } };
      const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
      const authStatus = vi.fn();
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }), tokenStore,
        withProviderOwnership: async (actual) => actual(),
        connectorFactory: (boundStore, ownership) => new ConnectorClient({ tokenStore: boundStore, fetcher, withProviderOwnership: ownership, onAuthStatus: authStatus }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'failed', failed: 1, reason: 'provider_unavailable' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(authStatus).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('skips disabled, disconnected, and legacy opt-in state without repairing or calling providers', async () => {
    const disabledDb = sqliteMemory(); const disconnectedDb = sqliteMemory();
    try {
      const disabledStore = new SQLiteStateStore({ database: Promise.resolve(disabledDb), randomId: randomUuid });
      const disabledState = appState(); disabledState.settings.backgroundMailRefreshEnabled = false;
      await disabledStore.load(); await disabledStore.save(disabledState);
      let calls = 0;
      const disabled = createBackgroundMailRefreshEngine({ privacy: privacy(), session, createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(disabledDb), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) { calls++; return page(selected); } }) });
      await expect(disabled.run()).resolves.toMatchObject({ status: 'skipped', reason: 'disabled' });

      const disconnectedStore = new SQLiteStateStore({ database: Promise.resolve(disconnectedDb), randomId: randomUuid });
      const disconnected = account(); disconnected.connected = false; disconnected.authStatus = 'configured';
      await disconnectedStore.load(); await disconnectedStore.save(appState([disconnected]));
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session, createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(disconnectedDb), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) { calls++; return page(selected); } }) });
      await expect(engine.run()).resolves.toMatchObject({ status: 'skipped', reason: 'no_eligible_accounts' });
      expect(calls).toBe(0);
    } finally { disabledDb.close(); disconnectedDb.close(); }
  });

  it('does not dispatch a request when the pre-I/O claim save fails', async () => {
    const loaded = appState();
    let calls = 0;
    const store: StateStore = {
      async load() { return structuredClone(loaded); },
      async save() { throw new Error('injected storage failure'); },
      async clear() {},
      async assertCurrent() {},
    };
    const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session, createStateStore: () => store,
      tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
      connectorFactory: () => ({ async syncMessageWindow(selected) { calls++; return page(selected); } }),
      now: () => new Date('2026-10-13T00:00:00.000Z'), });
    await expect(engine.run()).resolves.toMatchObject({ status: 'failed', attempted: 0, reason: 'state_unavailable' });
    expect(calls).toBe(0);
  });

  it('awaits request settlement after the run deadline aborts the provider signal', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(appState());
      let settledAfterAbort = false;
      let rawOwnerCount = 0;
      const releaseRaw = deferred<void>();
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => {
          rawOwnerCount++;
          try { return await actual(); } finally { rawOwnerCount--; }
        }, deadlineMs: 1_000,
        connectorFactory: (_store, ownership) => ({ async syncMessageWindow(selected, options) {
          return ownership(async () => {
            await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => { settledAfterAbort = true; resolve(); }, { once: true }));
            await releaseRaw.promise;
            return page(selected);
          });
        } }), now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      let done = false;
      const result = engine.run().then((value) => { done = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(settledAfterAbort).toBe(true);
      expect(rawOwnerCount).toBe(1);
      expect(done).toBe(false);
      releaseRaw.resolve();
      await expect(result).resolves.toMatchObject({ status: 'failed', attempted: 1, reason: 'deadline' });
      expect(settledAfterAbort).toBe(true);
      expect(rawOwnerCount).toBe(0);
      expect(await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load()).toMatchObject({ mailbox: [] });
    } finally { db.close(); }
  });

  it('fails closed on malformed cached mailbox rows before provider access', async () => {
    const db = sqliteMemory();
    try {
      const initial = appState(); initial.mailbox = [{ id: 'broken' } as never];
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(initial);
      let calls = 0;
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) { calls++; return page(selected); } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'skipped', reason: 'state_unavailable' });
      expect(calls).toBe(0);
    } finally { db.close(); }
  });

  it.each(['__proto__', 'constructor', 'duplicate'] as const)('makes no claim or HTTP request for unsafe account key %s', async (caseName) => {
    const db = sqliteMemory();
    try {
      const accounts: Account[] = caseName === 'duplicate'
        ? [account('same-id'), { ...account('same-id'), identity: { providerNamespace: 'google', clientId: 'other-client', subject: 'other-subject' } }]
        : [account(caseName)];
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(appState(accounts));
      let claimWrites = 0; let requests = 0;
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
        createStateStore: () => {
          const store = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid });
          const save = store.save.bind(store);
          store.save = async (state, options) => { claimWrites++; await save(state, options); };
          return store;
        }, tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) { requests++; return page(selected); } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'skipped', reason: 'state_unavailable' });
      expect(claimWrites).toBe(0);
      expect(requests).toBe(0);
    } finally { db.close(); }
  });

  it('does not commit provider pages with inconsistent ids or malformed partial metadata', async () => {
    const db = sqliteMemory();
    try {
      const seed = new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }); await seed.load(); await seed.save(appState());
      let requests = 0;
      const engine = createBackgroundMailRefreshEngine({ privacy: privacy(), session,
        createStateStore: () => new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }),
        tokenStore: { async get() { return null; }, async set() {} }, withProviderOwnership: async (actual) => actual(),
        connectorFactory: () => ({ async syncMessageWindow(selected) { requests++; return { ...page(selected), partial: 'yes' } as never; } }),
        now: () => new Date('2026-10-13T00:00:00.000Z'), uuid: randomUuid,
      });
      await expect(engine.run()).resolves.toMatchObject({ status: 'failed', reason: 'provider_unavailable' });
      expect(requests).toBe(1);
      const final = await new SQLiteStateStore({ database: Promise.resolve(db), randomId: randomUuid }).load();
      expect(final?.mailbox).toEqual([]);
      expect(final?.syncStates[account().id]?.mailHead.lastPageSucceededAt).toBeUndefined();
    } finally { db.close(); }
  });
});
