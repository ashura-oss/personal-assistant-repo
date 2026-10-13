import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import { buildProactiveMailSources, buildProactiveSources } from '../src/proactive/adapters';
import type { StateStore } from '../src/storage/contracts';
import type { StoredOAuthToken } from '../src/connectors';
import type { NotificationBackend } from '../src/services/notificationBackend';

class MemoryStore implements StateStore {
  value?: AppState;
  saves = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.saves++; this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'subject-1' };
const token: StoredOAuthToken = { accessToken: 'private-test-token', expiresAt: Date.now() + 60_000, identity };
const tokenStore = { async get() { return structuredClone(token); }, async set() {} };

async function configuredController(reminderBackend?: NotificationBackend): Promise<{ app: AppControllerImpl; store: MemoryStore; accountId: string }> {
  const store = new MemoryStore();
  const integration = reminderBackend ? { reminderBackend } : {};
  const first = new AppControllerImpl(store, {}, integration);
  await first.load();
  const account = await first.saveAccount({ provider: 'google', displayName: 'Personal', email: 'person@example.com' });
  const current = store.value!;
  current.accounts[0] = {
    ...current.accounts[0], connected: true, authStatus: 'connected', identity, tokenRef: 'verified-ref',
    grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], capabilities: ['mail.read'], capabilityLimits: ['mail.read'],
  };
  const receivedAt = new Date(Date.now() - 60_000).toISOString();
  const accountKey = 'google:google-client:subject-1:';
  current.mailbox = [{
    id: 'cached-message', accountId: account.id, providerMessageId: 'message-1', identityKey: `${accountKey}:message-1`,
    verifiedIdentityKey: accountKey, connectionGeneration: current.accounts[0].connectionGeneration ?? 0,
    idFormat: 'gmail', senderEmail: 'boss@example.com', from: 'Boss', isRead: false, subject: 'Urgent: review',
    snippet: 'Please handle this urgent item.', receivedAt, observedAt: new Date().toISOString(), replyMetadataComplete: true,
  }];
  await store.save(current);
  const app = new AppControllerImpl(store, {}, { ...integration, tokenStore, clientIds: { google: 'google-client' } });
  await app.load();
  return { app, store, accountId: account.id };
}

describe('controller-owned proactive state', () => {
  it('keeps eligibility revision stable for label edits and requires version CAS for every edit', async () => {
    const { app, accountId } = await configuredController();
    const rule = await app.saveProactiveRule({
      name: 'Urgent sender', enabled: true, accountIds: [accountId], trigger: { type: 'unread_from', addresses: ['boss@example.com'] },
    });
    expect(rule).toMatchObject({ revision: 1, version: 1 });
    const renamed = await app.saveProactiveRule({
      id: rule.id, expectedVersion: rule.version, name: 'Important sender', enabled: true, accountIds: [accountId],
      trigger: { type: 'unread_from', addresses: ['boss@example.com'] },
    });
    expect(renamed).toMatchObject({ revision: 1, version: 2 });
    await expect(app.saveProactiveRule({
      id: rule.id, expectedVersion: rule.version, name: 'Lost update', enabled: true, accountIds: [accountId],
      trigger: { type: 'unread_from', addresses: ['boss@example.com'] },
    })).rejects.toThrow(/changed elsewhere/i);
    const edited = await app.saveProactiveRule({
      id: renamed.id, expectedVersion: renamed.version, name: renamed.name, enabled: true, accountIds: [accountId],
      trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    expect(edited).toMatchObject({ revision: 2, version: 3 });
  });

  it('removes quiet hours when an edited rule clears them', async () => {
    const { app, accountId } = await configuredController();
    const rule = await app.saveProactiveRule({
      name: 'Quiet rule', enabled: true, accountIds: [accountId], quietHours: { start: '22:00', end: '07:00' },
      trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    const edited = await app.saveProactiveRule({
      id: rule.id, expectedVersion: rule.version, name: rule.name, enabled: true, accountIds: [accountId],
      trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    expect(edited.quietHours).toBeUndefined();
    expect(app.getSnapshot().proactive.rules[0].quietHours).toBeUndefined();
  });

  it('creates fresh local candidates, verifies exact source details, and avoids provider I/O', async () => {
    const { app, accountId } = await configuredController();
    const fetchMock = vi.fn(() => { throw new Error('provider network must not run'); });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const rule = await app.saveProactiveRule({
        name: 'Urgent mail', enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['urgent'] },
      });
      const [entry] = app.getSnapshot().proactive.candidates;
      expect(entry).toMatchObject({ presentation: 'active', candidate: { ruleId: rule.id, sourceKind: 'mail', quote: 'Urgent' } });
      const detail = await app.getProactiveCandidateSource(entry.candidate.id);
      expect(detail).toMatchObject({ status: 'current', source: { kind: 'mail', subject: 'Urgent: review' } });
      const saves = app.getSnapshot().proactive.lastEvaluation?.inputFingerprint;
      const saveCount = (app as unknown as { store: MemoryStore }).store.saves;
      await app.evaluateLocalCandidates();
      expect(app.getSnapshot().proactive.lastEvaluation?.inputFingerprint).toBe(saves);
      expect((app as unknown as { store: MemoryStore }).store.saves).toBe(saveCount);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the task or message title for a proactive reminder instead of the matched quote', async () => {
    const { app, accountId } = await configuredController();
    await app.saveProactiveRule({
      name: 'Urgent mail', enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    const candidate = app.getSnapshot().proactive.candidates[0].candidate;
    const reminder = await app.createReminderDraft({ candidateId: candidate.id });
    expect(candidate.quote).not.toBe(reminder.title);
    expect(reminder.title).toBe('Urgent: review');
  });

  it('rechecks a proactive source after permission UI before saving the reminder intent', async () => {
    let appRef: AppControllerImpl | undefined;
    let ruleRef: ReturnType<AppControllerImpl['getSnapshot']>['proactive']['rules'][number] | undefined;
    const schedule = vi.fn(async () => 'must-not-schedule');
    const backend: NotificationBackend = {
      platform: 'mock', getPermission: async () => 'undetermined', requestPermission: async () => {
        const current = appRef!.getSnapshot().proactive.rules[0];
        ruleRef = await appRef!.saveProactiveRule({ id: current.id, expectedVersion: current.version, name: 'Renamed while permission was open',
          enabled: current.enabled, accountIds: current.accountIds, trigger: current.trigger });
        return 'authorized';
      }, listPending: async () => [], schedule, cancel: async () => undefined, cancelLegacy: async () => undefined,
      installForegroundHandler: async () => undefined,
    };
    const { app, accountId } = await configuredController(backend);
    appRef = app;
    const rule = await app.saveProactiveRule({ name: 'Urgent mail', enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['urgent'] } });
    const candidate = app.getSnapshot().proactive.candidates[0].candidate;
    const draft = await app.createReminderDraft({ candidateId: candidate.id });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    await expect(app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision })).rejects.toThrow(/no longer current|source changed/i);
    expect(ruleRef?.version).toBe(rule.version + 1);
    expect(app.getSnapshot().reminders.records[0].status).toBe('approved');
    expect(app.getSnapshot().reminders.records[0]).not.toHaveProperty('firstSavedAt');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('rejects the first save when a local task source changes while permission is open', async () => {
    let appRef: AppControllerImpl | undefined;
    let taskId = '';
    const schedule = vi.fn(async () => 'must-not-schedule');
    const notificationBackend: NotificationBackend = {
      platform: 'mock', getPermission: async () => 'undetermined', requestPermission: async () => {
        await appRef!.completeTask(taskId);
        return 'authorized';
      }, listPending: async () => [], schedule, cancel: async () => undefined, cancelLegacy: async () => undefined,
      installForegroundHandler: async () => undefined,
    };
    const { store } = await configuredController(notificationBackend);
    const initial = structuredClone(store.value!);
    taskId = 'permission-race-task';
    initial.tasks.push({
      id: taskId, title: 'Submit application', body: 'Submit the application today', status: 'open',
      createdAt: new Date().toISOString(), dueAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      sourceNoteId: 'source-note', sourceRevision: 1, proposalId: 'source-proposal',
    });
    await store.save(initial);
    const app = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' }, reminderBackend: notificationBackend });
    await app.load();
    appRef = app;
    await app.saveProactiveRule({ name: 'Due task', enabled: true, accountIds: [], trigger: { type: 'task_due', minutes: 60 } });
    const candidate = app.getSnapshot().proactive.candidates.find((entry) => entry.candidate.sourceId.includes(taskId))?.candidate;
    expect(candidate).toBeDefined();
    const draft = await app.createReminderDraft({ candidateId: candidate!.id });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });

    await expect(app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision })).rejects.toThrow(/no longer current|source changed/i);
    expect(app.getSnapshot().tasks.find((task) => task.id === taskId)?.status).toBe('completed');
    expect(app.getSnapshot().reminders.records.find((record) => record.id === approved.id)).toMatchObject({ status: 'approved' });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('keeps a previously saved reminder editable after its original proactive source expires', async () => {
    const backend: NotificationBackend = {
      platform: 'mock', getPermission: async () => 'denied', requestPermission: async () => 'denied', listPending: async () => [],
      schedule: async () => 'must-not-schedule', cancel: async () => undefined, cancelLegacy: async () => undefined, installForegroundHandler: async () => undefined,
    };
    const { app, accountId } = await configuredController(backend);
    const rule = await app.saveProactiveRule({ name: 'Urgent mail', enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['urgent'] } });
    const candidate = app.getSnapshot().proactive.candidates[0].candidate;
    const draft = await app.createReminderDraft({ candidateId: candidate.id });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    const saved = await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    expect(saved.firstSavedAt).toBeTruthy();

    await app.saveProactiveRule({ id: rule.id, expectedVersion: rule.version, name: rule.name, enabled: false, accountIds: rule.accountIds, trigger: rule.trigger });
    const edited = await app.updateReminderDraft(saved.id, { expectedRevision: saved.revision, title: 'Edited local reminder' });
    const reapproved = await app.approveReminder(edited.id, { expectedRevision: edited.revision });
    const savedAgain = await app.saveApprovedReminder(reapproved.id, { expectedRevision: reapproved.revision });
    expect(savedAgain).toMatchObject({ status: 'saved', title: 'Edited local reminder', firstSavedAt: saved.firstSavedAt });
  });

  it('retains exact dismissals across renames, then allows a new eligibility revision to recur', async () => {
    const { app, accountId } = await configuredController();
    const rule = await app.saveProactiveRule({
      name: 'Boss unread', enabled: true, accountIds: [accountId], trigger: { type: 'unread_from', addresses: ['boss@example.com'] },
    });
    const entry = app.getSnapshot().proactive.candidates[0];
    await app.dismissProactiveCandidate(entry.candidate.id);
    expect(app.getSnapshot().proactive.candidates).toHaveLength(0);
    const renamed = await app.saveProactiveRule({
      id: rule.id, expectedVersion: rule.version, name: 'Boss mail', enabled: true, accountIds: [accountId],
      trigger: { type: 'unread_from', addresses: ['boss@example.com'] },
    });
    expect(renamed.revision).toBe(rule.revision);
    expect(app.getSnapshot().proactive.candidates).toHaveLength(0);
    const changed = await app.saveProactiveRule({
      id: renamed.id, expectedVersion: renamed.version, name: renamed.name, enabled: true, accountIds: [accountId],
      trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    expect(changed.revision).toBe(renamed.revision + 1);
    expect(app.getSnapshot().proactive.candidates).toHaveLength(1);
  });

  it('keeps a source-level snooze across a fresh content version and invalidates read mail', async () => {
    const { app, store, accountId } = await configuredController();
    const rule = await app.saveProactiveRule({
      name: 'Urgent unread', enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    const original = app.getSnapshot().proactive.candidates[0].candidate;
    await app.snoozeProactiveCandidate(original.id, new Date(Date.now() + 60 * 60_000).toISOString());
    const changedState = structuredClone(store.value!);
    changedState.mailbox[0].subject = 'Urgent: updated';
    changedState.mailbox[0].observedAt = new Date().toISOString();
    await store.save(changedState);
    const restored = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
    await restored.load();
    expect(restored.getSnapshot().proactive.candidates[0]).toMatchObject({ presentation: 'deferred', candidate: { ruleId: rule.id } });
    expect(restored.getSnapshot().proactive.candidates[0].candidate.sourceVersion).not.toBe(original.sourceVersion);
    const readState = structuredClone(store.value!);
    readState.mailbox[0].isRead = true;
    readState.mailbox[0].observedAt = new Date().toISOString();
    await store.save(readState);
    const readApp = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
    await readApp.load();
    expect(readApp.getSnapshot().proactive.candidates).toHaveLength(0);
  });

  it('keeps a persisted snooze valid across device clock rollback', async () => {
    const { app, store, accountId } = await configuredController();
    const rule = await app.saveProactiveRule({
      name: 'Urgent mail', enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    const candidate = app.getSnapshot().proactive.candidates.find((item) => item.candidate.ruleId === rule.id)!.candidate;
    const snoozeUntil = new Date(Date.now() + 6 * 86_400_000).toISOString();
    await app.snoozeProactiveCandidate(candidate.id, snoozeUntil);
    const originalNow = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(originalNow - 30 * 86_400_000);
    try {
      const restored = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
      await expect(restored.load()).resolves.toBeUndefined();
      expect(restored.getSnapshot().proactive.integrityError).toBeUndefined();
      expect(restored.getSnapshot().proactive.snoozes[0].snoozedAt).toBeDefined();
    } finally { vi.useRealTimers(); }
  });

  it('treats freshness as snapshot freshness while rules handle individually missing mail facts', async () => {
    const { store, accountId } = await configuredController();
    const state = structuredClone(store.value!);
    state.mailbox[0].senderEmail = undefined;
    state.mailbox[0].isRead = undefined;
    await store.save(state);
    const restored = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
    await restored.load();
    const keywordRule = await restored.saveProactiveRule({
      name: 'Literal urgent', enabled: true, accountIds: [accountId],
      trigger: { type: 'keyword', keywords: ['urgent'], unreadOnly: false },
    });
    expect(restored.getSnapshot().proactive.candidates).toMatchObject([
      { presentation: 'active', candidate: { ruleId: keywordRule.id, reasonCode: 'keyword' } },
    ]);
    const read = structuredClone(store.value!);
    read.mailbox[0].isRead = true;
    read.mailbox[0].observedAt = new Date().toISOString();
    await store.save(read);
    const readController = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
    await readController.load();
    expect(readController.getSnapshot().proactive.candidates).toHaveLength(1); // unreadOnly:false remains eligible
    const unreadRule = await readController.saveProactiveRule({
      name: 'Unread from boss', enabled: true, accountIds: [accountId],
      trigger: { type: 'unread_from', addresses: ['boss@example.com'] },
    });
    expect(readController.getSnapshot().proactive.candidates.some((item) => item.candidate.ruleId === unreadRule.id)).toBe(false);
  });

  it('caps source work before hashing, reports overflow, and isolates malformed rows', async () => {
    const { store } = await configuredController();
    const state = structuredClone(store.value!);
    const account = state.accounts[0];
    const accountKey = 'google:google-client:subject-1:';
    state.mailbox = Array.from({ length: 2002 }, (_, index) => ({
      id: `message-${index}`, accountId: account.id, providerMessageId: `mail-${String(index).padStart(4, '0')}`,
      identityKey: `${accountKey}mail-${index}`, verifiedIdentityKey: accountKey, connectionGeneration: account.connectionGeneration ?? 0,
      idFormat: 'gmail' as const, senderEmail: 'boss@example.com', isRead: false, subject: `Urgent ${index}`,
      receivedAt: new Date(Date.now() - 60_000).toISOString(), observedAt: new Date().toISOString(), replyMetadataComplete: true,
    }));
    (state.mailbox[0] as unknown as { subject: number }).subject = 42;
    let hashes = 0;
    const built = await buildProactiveSources(state, [], Date.now(), new Map(), async (value) => { hashes++; return String(value.length); });
    expect(built.sources).toHaveLength(1999);
    expect(built.omittedSourceCount).toBe(2);
    expect(hashes).toBe(1999);
    expect(built.sources.some((source) => source.providerId === 'mail-0000')).toBe(false);
  });

  it('projects only exact mail rows through the mail-only mapper and rehashes changed current facts', async () => {
    const { store } = await configuredController();
    const state = structuredClone(store.value!);
    let hashes = 0;
    const memo = new Map();
    const first = await buildProactiveMailSources(state.accounts, [state.mailbox[0]], Date.now(), memo, async (value) => {
      hashes += 1;
      return String(value.length);
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'mail', providerId: state.mailbox[0].providerMessageId });
    expect(hashes).toBe(1);

    const changed = { ...state.mailbox[0], subject: 'Changed after committed page' };
    const current = await buildProactiveMailSources(state.accounts, [changed], Date.now(), memo, async (value) => {
      hashes += 1;
      return `changed-${value.length}`;
    });
    expect(current).toHaveLength(1);
    expect(current[0].sourceId).toBe(first[0].sourceId);
    expect(current[0].sourceVersion).not.toBe(first[0].sourceVersion);
    expect(hashes).toBe(2);
  });

  it('returns stale detail for an expired observation rather than current source facts', async () => {
    const { app, store, accountId } = await configuredController();
    const rule = await app.saveProactiveRule({
      name: 'Urgent mail', enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    const candidate = app.getSnapshot().proactive.candidates.find((item) => item.candidate.ruleId === rule.id)!.candidate;
    const expired = structuredClone(store.value!);
    expired.mailbox[0].observedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    await store.save(expired);
    const restored = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
    await restored.load();
    expect(await restored.getProactiveCandidateSource(candidate.id)).toMatchObject({ status: 'stale' });
    expect(restored.getSnapshot().proactive.candidates.find((item) => item.candidate.id === candidate.id)?.presentation).toBe('uncertain');
  });

  it('filters malformed cached source rows without quarantining or losing valid candidates', async () => {
    const { app, store, accountId } = await configuredController();
    const rule = await app.saveProactiveRule({
      name: 'Urgent mail', enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['urgent'] },
    });
    const candidateId = app.getSnapshot().proactive.candidates.find((item) => item.candidate.ruleId === rule.id)!.candidate.id;
    const corrupted = structuredClone(store.value!) as AppState;
    const validRow = { ...corrupted.mailbox[0], id: 'second-message', providerMessageId: 'second-valid', subject: 'Urgent follow-up' };
    corrupted.mailbox = [
      null,
      { ...corrupted.mailbox[0], accountId: 7 },
      { ...corrupted.mailbox[0], providerMessageId: 9 },
      corrupted.mailbox[0], validRow,
    ] as unknown as AppState['mailbox'];
    corrupted.calendarEvents = [null, { accountId: 'acc', calendarId: 9, providerEventId: 'event' }] as unknown as AppState['calendarEvents'];
    await store.save(corrupted);
    const fetchMock = vi.fn(() => { throw new Error('proactive local evaluation must not call provider APIs'); });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const restored = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
      await restored.load();
      expect(restored.getSnapshot().proactive.integrityError).toBeUndefined();
      expect(restored.getSnapshot().proactive.candidates.some((item) => item.candidate.id === candidateId)).toBe(true);
      expect(restored.getSnapshot().proactive.candidates.some((item) => item.candidate.providerId === 'second-valid')).toBe(true);
      await restored.saveSettings({ timezone: 'Asia/Singapore' });
      expect(restored.getSnapshot().proactive.candidates.some((item) => item.candidate.id === candidateId)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('invalidates completed local task candidates without any remote action', async () => {
    const { store } = await configuredController();
    const dueAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const state = structuredClone(store.value!);
    state.tasks.push({ id: 'local-task', title: 'Pay invoice', body: 'Pay invoice', status: 'open', createdAt: new Date().toISOString(), dueAt, sourceNoteId: 'note-1', sourceRevision: 1, proposalId: 'proposal-1' });
    await store.save(state);
    const restored = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
    await restored.load();
    const rule = await restored.saveProactiveRule({ name: 'Due soon', enabled: true, accountIds: [], trigger: { type: 'task_due', minutes: 60 } });
    expect(restored.getSnapshot().proactive.candidates).toHaveLength(0);
    expect(Date.parse(restored.getSnapshot().proactive.lastEvaluation!.nextCheckAt!) - Date.parse(dueAt)).toBe(-60 * 60_000);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(restored.getSnapshot().proactive.lastEvaluation!.nextCheckAt!));
    try { await restored.evaluateLocalCandidates(); }
    finally { vi.useRealTimers(); }
    expect(restored.getSnapshot().proactive.candidates).toMatchObject([{ candidate: { ruleId: rule.id, sourceKind: 'task' }, presentation: 'active' }]);
    await restored.completeTask('local-task');
    expect(restored.getSnapshot().proactive.candidates).toHaveLength(0);
  });

  it('quarantines malformed suppressions privately and fails closed on a full dismissal ledger', async () => {
    const { app, store, accountId } = await configuredController();
    const rule = await app.saveProactiveRule({ name: 'Unread boss', enabled: true, accountIds: [accountId], trigger: { type: 'unread_from', addresses: ['boss@example.com'] } });
    const candidate = app.getSnapshot().proactive.candidates[0].candidate;
    const corrupted = structuredClone(store.value!) as AppState & { proactiveQuarantine?: unknown };
    corrupted.proactive.snoozes = [{ suppressionKey: 'tampered-private-value', ruleId: rule.id, sourceId: candidate.sourceId, until: new Date(Date.now() + 60_000).toISOString(), snoozedAt: new Date().toISOString() }];
    await store.save(corrupted);
    const quarantined = new AppControllerImpl(store, {}, { tokenStore, clientIds: { google: 'google-client' } });
    await quarantined.load();
    expect(quarantined.getSnapshot().proactive).toMatchObject({ integrityError: expect.any(String), candidates: [] });
    expect(quarantined.getSnapshot()).not.toHaveProperty('proactiveQuarantine');
    const exported = await quarantined.exportData();
    expect(exported).not.toContain('tampered-private-value');
    expect(store.value).toHaveProperty('proactiveQuarantine');

    const full = await configuredController();
    const fullRule = await full.app.saveProactiveRule({ name: 'Unread boss', enabled: true, accountIds: [full.accountId], trigger: { type: 'unread_from', addresses: ['boss@example.com'] } });
    const fullCandidate = full.app.getSnapshot().proactive.candidates[0].candidate;
    const fullState = structuredClone(full.store.value!);
    fullState.proactive.dismissals = Array.from({ length: 2000 }, (_, index) => {
      const sourceId = JSON.stringify(['fixture', null, `source-${index}`]);
      const sourceVersion = `v-${index}`;
      return {
        candidateId: JSON.stringify([fullRule.id, fullRule.revision, sourceId, sourceVersion]), ruleId: fullRule.id,
        ruleRevision: fullRule.revision, sourceId, sourceVersion, dismissedAt: new Date().toISOString(),
      };
    });
    await full.store.save(fullState);
    const fullApp = new AppControllerImpl(full.store, {}, { tokenStore, clientIds: { google: 'google-client' } });
    await fullApp.load();
    const saves = full.store.saves;
    await expect(fullApp.dismissProactiveCandidate(fullCandidate.id)).rejects.toThrow(/history is full/i);
    expect(full.store.saves).toBe(saves);
  });
});
