import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { NotificationBackend, PendingNotificationRequest } from '../src/services/notificationBackend';
import type { StateStore } from '../src/storage/contracts';
import { notificationContentForIntent } from '../src/reminders';
import * as Crypto from 'expo-crypto';
import { createCompletedAssistantBatchClient } from './helpers/assistantBatchFixture';

class MemoryStore implements StateStore {
  value?: AppState;
  failNext = false;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    if (this.failNext) { this.failNext = false; throw new Error('disk full'); }
    this.value = structuredClone(state);
  }
  async clear() { this.value = undefined; }
}

function backend(overrides: Partial<NotificationBackend> = {}): NotificationBackend {
  return {
    platform: 'mock',
    getPermission: async () => 'authorized',
    requestPermission: async () => 'authorized',
    listPending: async () => [] as PendingNotificationRequest[],
    schedule: async () => 'scheduled-id',
    cancel: async () => undefined,
    cancelLegacy: async () => undefined,
    installForegroundHandler: async () => undefined,
    ...overrides,
  };
}

describe('reminder controller integrity', () => {
  it('saves a local reminder honestly when alert permission is denied', async () => {
    const store = new MemoryStore();
    const requestPermission = vi.fn(async () => 'denied' as const);
    const schedule = vi.fn(async () => 'unexpected');
    const app = new AppControllerImpl(store, {}, { reminderBackend: backend({
      getPermission: async () => 'undetermined', requestPermission, schedule,
    }) });
    await app.load();
    const draft = await app.createReminderDraft();
    expect(draft.title).toBe('Reminder');
    expect(new Date(draft.dueAt).getMilliseconds()).toBe(0);
    await expect(app.approveReminder(draft.id, { expectedRevision: draft.revision + 1 })).rejects.toThrow(/changed/i);
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    const saved = await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(saved).toMatchObject({ status: 'saved', firstSavedAt: expect.any(String) });
    expect(app.getSnapshot().reminders.intents[0]).toMatchObject({ desired: 'scheduled', observed: 'blocked', errorCode: 'permission_denied' });
  });

  it('does not schedule a restored intent whose payload no longer matches its approved digests', async () => {
    const store = new MemoryStore();
    const firstBackend = backend();
    const app = new AppControllerImpl(store, {}, { reminderBackend: firstBackend });
    await app.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 1000) * 1000).toISOString();
    const draft = await app.createReminderDraft({ title: 'Review budget', body: 'Open the local sheet', dueAt });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });

    const persisted = store.value!;
    const record = persisted.reminders.records.find((item) => item.id === draft.id)!;
    const intent = persisted.reminders.intents.find((item) => item.id === record.currentIntentId)!;
    // This is structurally valid persisted data, but neither frozen digest is updated.
    record.title = 'Different action';
    intent.payload!.title = 'Different action';
    await store.save(persisted);

    const schedule = vi.fn(async () => 'should-not-schedule');
    const restored = new AppControllerImpl(store, {}, { reminderBackend: backend({ schedule }) });
    await restored.load();
    await restored.reconcileReminderAlerts();
    expect(schedule).not.toHaveBeenCalled();
    expect(restored.getSnapshot().reminders.intents.find((item) => item.id === intent.id)).toMatchObject({ observed: 'error', errorCode: 'unverifiable' });
  });

  it('allows foreground delivery only for the exact saved owner and visible content', async () => {
    const store = new MemoryStore();
    let foregroundGate: ((notification: { identifier?: string; content: { title?: unknown; body?: unknown; data?: unknown } }) => boolean) | undefined;
    const pending: PendingNotificationRequest[] = [];
    const app = new AppControllerImpl(store, {}, { reminderBackend: backend({
      listPending: async () => structuredClone(pending),
      installForegroundHandler: async (gate) => { foregroundGate = gate; },
      schedule: async (intent, installationId) => {
        const projection = notificationContentForIntent(intent, installationId!);
        pending.push({ identifier: intent.identifier, title: projection.title, body: projection.body, data: projection.data,
          trigger: { dueAt: intent.payload!.dueAt, repeats: false, verifiable: true }, extraContentSafe: true });
        return intent.identifier;
      },
    }) });
    await app.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const draft = await app.createReminderDraft({ title: 'Call the clinic', body: 'Ask about the appointment', dueAt, privacyMode: 'full' });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    const saved = await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    expect(saved.status).toBe('saved');
    const intent = app.getSnapshot().reminders.intents.find((item) => item.id === saved.currentIntentId)!;
    expect(intent.observed).toBe('pending');
    const projection = notificationContentForIntent(intent, app.getSnapshot().reminders.installationId);
    expect(foregroundGate).toBeDefined();
    expect(foregroundGate!({ identifier: intent.identifier, content: { ...projection } })).toBe(true);
    expect(foregroundGate!({ identifier: intent.identifier, content: { ...projection, body: 'Different reminder' } })).toBe(false);
    (app as unknown as { proactiveMailAlertQuarantine: unknown[] }).proactiveMailAlertQuarantine.push({ held: true });
    expect(foregroundGate!({ identifier: intent.identifier, content: { ...projection } })).toBe(true);
  });

  it('does not reschedule a replacement while cancellation is still visible natively', async () => {
    const store = new MemoryStore();
    const pending: PendingNotificationRequest[] = [];
    const schedule = vi.fn(async (intent, installationId) => {
      const projection = notificationContentForIntent(intent, installationId!);
      pending.push({ identifier: intent.identifier, title: projection.title, body: projection.body, data: projection.data,
        trigger: { dueAt: intent.payload!.dueAt, repeats: false, verifiable: true }, extraContentSafe: true });
      return intent.identifier;
    });
    const app = new AppControllerImpl(store, {}, { reminderBackend: backend({ listPending: async () => structuredClone(pending), schedule, cancel: async () => undefined }) });
    await app.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const draft = await app.createReminderDraft({ title: 'Original', dueAt });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    const saved = await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    expect(schedule).toHaveBeenCalledTimes(1);

    const edited = await app.updateReminderDraft(saved.id, { expectedRevision: saved.revision, title: 'Replacement' });
    const reapproved = await app.approveReminder(edited.id, { expectedRevision: edited.revision });
    await app.saveApprovedReminder(reapproved.id, { expectedRevision: reapproved.revision });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().reminders.intents.find((item) => item.id === saved.currentIntentId)).toMatchObject({ desired: 'cancelled', observed: 'unconfirmed' });
  });

  it('cancels a native schedule that completes after the reminder is marked done', async () => {
    const store = new MemoryStore();
    const pending: PendingNotificationRequest[] = [];
    let startSchedule!: () => void;
    let releaseSchedule!: () => void;
    const enteredSchedule = new Promise<void>((resolve) => { startSchedule = resolve; });
    const scheduleGate = new Promise<void>((resolve) => { releaseSchedule = resolve; });
    const cancel = vi.fn(async (identifier: string) => {
      const index = pending.findIndex((item) => item.identifier === identifier);
      if (index >= 0) pending.splice(index, 1);
    });
    const schedule = vi.fn(async (intent, installationId) => {
      startSchedule();
      await scheduleGate;
      const projection = notificationContentForIntent(intent, installationId!);
      pending.push({ identifier: intent.identifier, title: projection.title, body: projection.body, data: projection.data,
        trigger: { dueAt: intent.payload!.dueAt, repeats: false, verifiable: true }, extraContentSafe: true });
      return intent.identifier;
    });
    const app = new AppControllerImpl(store, {}, { reminderBackend: backend({ listPending: async () => structuredClone(pending), schedule, cancel }) });
    await app.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const draft = await app.createReminderDraft({ title: 'Finish report', dueAt });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    const saving = app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    await enteredSchedule;
    const completing = app.completeReminder(draft.id, { expectedRevision: approved.revision });
    releaseSchedule();
    await Promise.all([saving, completing]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pending).toEqual([]);
    expect(app.getSnapshot().reminders.records[0].status).toBe('completed');
  });

  it('keeps reconciliation shared through the follow-up pass and cancels a schedule completed after Done in that pass', async () => {
    const store = new MemoryStore();
    const pending: PendingNotificationRequest[] = [];
    let permission: 'denied' | 'authorized' = 'denied';
    let app!: AppControllerImpl;
    let shouldGate = false;
    let scheduleCount = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let enteredFirst!: () => void;
    let enteredSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { enteredSecond = resolve; });
    const schedule = vi.fn(async (intent, installationId) => {
      scheduleCount += 1;
      const call = scheduleCount;
      if (shouldGate && call === 1) { enteredFirst(); await firstGate; }
      if (shouldGate && call === 2) { enteredSecond(); await secondGate; }
      const projection = notificationContentForIntent(intent, installationId!);
      pending.push({ identifier: intent.identifier, title: projection.title, body: projection.body, data: projection.data,
        trigger: { dueAt: intent.payload!.dueAt, repeats: false, verifiable: true }, extraContentSafe: true });
      return intent.identifier;
    });
    app = new AppControllerImpl(store, {}, { reminderBackend: backend({
      getPermission: async () => permission,
      listPending: async () => structuredClone(pending), schedule,
      cancel: async (identifier) => { const index = pending.findIndex((item) => item.identifier === identifier); if (index >= 0) pending.splice(index, 1); },
    }) });
    await app.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const drafts = await Promise.all(['First pass', 'Second pass'].map((title) => app.createReminderDraft({ title, dueAt })));
    const approved = await Promise.all(drafts.map((draft) => app.approveReminder(draft.id, { expectedRevision: draft.revision })));
    await Promise.all(approved.map((item) => app.saveApprovedReminder(item.id, { expectedRevision: item.revision })));
    expect(schedule).not.toHaveBeenCalled();

    permission = 'authorized';
    shouldGate = true;
    const reconciliation = app.reconcileReminderAlerts();
    await firstStarted;
    const joinedCall = app.reconcileReminderAlerts();
    releaseFirst();
    await secondStarted;
    const secondRecord = app.getSnapshot().reminders.records.find((item) => item.title === 'Second pass')!;
    const done = app.completeReminder(secondRecord.id, { expectedRevision: secondRecord.revision });
    releaseSecond();
    await Promise.all([reconciliation, joinedCall, done]);

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(pending.some((item) => item.identifier === app.getSnapshot().reminders.intents.find((intent) => intent.reminderId === secondRecord.id)?.identifier)).toBe(false);
    expect(app.getSnapshot().reminders.records.find((item) => item.id === secondRecord.id)?.status).toBe('completed');
  });

  it('cancels an earlier reminder deleted while a different schedule is pending in the second pass', async () => {
    const store = new MemoryStore();
    const pending: PendingNotificationRequest[] = [];
    let permission: 'denied' | 'authorized' = 'denied';
    let scheduleCount = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let enteredFirst!: () => void;
    let enteredSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { enteredSecond = resolve; });
    const schedule = vi.fn(async (intent, installationId) => {
      const call = ++scheduleCount;
      if (call === 1) { enteredFirst(); await firstGate; }
      if (call === 2) { enteredSecond(); await secondGate; }
      const projection = notificationContentForIntent(intent, installationId!);
      pending.push({ identifier: intent.identifier, title: projection.title, body: projection.body, data: projection.data,
        trigger: { dueAt: intent.payload!.dueAt, repeats: false, verifiable: true }, extraContentSafe: true });
      return intent.identifier;
    });
    const cancel = vi.fn(async (identifier: string) => {
      const index = pending.findIndex((item) => item.identifier === identifier);
      if (index >= 0) pending.splice(index, 1);
    });
    const app = new AppControllerImpl(store, {}, { reminderBackend: backend({
      getPermission: async () => permission,
      listPending: async () => structuredClone(pending), schedule, cancel,
    }) });
    await app.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const firstDraft = await app.createReminderDraft({ title: 'Delete while second schedules', dueAt });
    const firstApproved = await app.approveReminder(firstDraft.id, { expectedRevision: firstDraft.revision });
    await app.saveApprovedReminder(firstApproved.id, { expectedRevision: firstApproved.revision });
    const firstRecord = app.getSnapshot().reminders.records.find((item) => item.id === firstDraft.id)!;

    permission = 'authorized';
    const reconciliation = app.reconcileReminderAlerts();
    await firstStarted;
    const followupRequested = app.reconcileReminderAlerts();
    const secondDraft = await app.createReminderDraft({ title: 'Second pass schedule', dueAt });
    const secondApproved = await app.approveReminder(secondDraft.id, { expectedRevision: secondDraft.revision });
    const savingSecond = app.saveApprovedReminder(secondApproved.id, { expectedRevision: secondApproved.revision });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (app.getSnapshot().reminders.records.find((item) => item.id === secondDraft.id)?.status === 'saved') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    releaseFirst();
    await secondStarted;

    const deletingFirst = app.deleteReminder(firstRecord.id, { expectedRevision: firstRecord.revision });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!app.getSnapshot().reminders.records.some((item) => item.id === firstRecord.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(app.getSnapshot().reminders.records.some((item) => item.id === firstRecord.id)).toBe(false);
    releaseSecond();
    await Promise.all([reconciliation, followupRequested, savingSecond, deletingFirst]);

    expect(cancel).toHaveBeenCalledWith(app.getSnapshot().reminders.intents.find((item) => item.reminderId === firstRecord.id)?.identifier);
    expect(pending.some((item) => item.identifier === app.getSnapshot().reminders.intents.find((intent) => intent.reminderId === firstRecord.id)?.identifier)).toBe(false);
    expect(pending).toHaveLength(1);
    expect(app.getSnapshot().reminders.intents.find((intent) => intent.reminderId === firstRecord.id)).toMatchObject({ desired: 'cancelled', observed: 'absent' });
    expect(app.getSnapshot().reminders.intents.find((intent) => intent.reminderId === secondDraft.id)).toMatchObject({ desired: 'scheduled', observed: 'pending' });
  });

  it('sweeps a deletion during the second pass even when no new native schedule is needed', async () => {
    const store = new MemoryStore();
    const pending: PendingNotificationRequest[] = [];
    let gatePermission = false;
    let permissionReads = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let enteredFirst!: () => void;
    let enteredSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { enteredSecond = resolve; });
    const schedule = vi.fn(async (intent, installationId) => {
      const projection = notificationContentForIntent(intent, installationId!);
      pending.push({ identifier: intent.identifier, title: projection.title, body: projection.body, data: projection.data,
        trigger: { dueAt: intent.payload!.dueAt, repeats: false, verifiable: true }, extraContentSafe: true });
      return intent.identifier;
    });
    const cancel = vi.fn(async (identifier: string) => {
      const index = pending.findIndex((item) => item.identifier === identifier);
      if (index >= 0) pending.splice(index, 1);
    });
    const app = new AppControllerImpl(store, {}, { reminderBackend: backend({
      getPermission: async () => {
        if (!gatePermission) return 'authorized';
        permissionReads += 1;
        if (permissionReads === 1) { enteredFirst(); await firstGate; }
        if (permissionReads === 2) { enteredSecond(); await secondGate; }
        return 'authorized';
      },
      listPending: async () => structuredClone(pending), schedule, cancel,
    }) });
    await app.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const draft = await app.createReminderDraft({ title: 'Already scheduled', dueAt });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    const saved = await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    expect(pending).toHaveLength(1);
    expect(schedule).toHaveBeenCalledOnce();

    gatePermission = true;
    const reconciliation = app.reconcileReminderAlerts();
    await firstStarted;
    const joined = app.reconcileReminderAlerts();
    releaseFirst();
    await secondStarted;
    const deleting = app.deleteReminder(saved.id, { expectedRevision: saved.revision });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!app.getSnapshot().reminders.records.some((record) => record.id === saved.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(app.getSnapshot().reminders.records.some((record) => record.id === saved.id)).toBe(false);
    releaseSecond();
    await Promise.all([reconciliation, joined, deleting]);

    expect(schedule).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(pending).toEqual([]);
    expect(app.getSnapshot().reminders.intents.find((item) => item.reminderId === saved.id)).toMatchObject({ desired: 'cancelled', observed: 'absent' });
  });

  it('cancels exactly sixteen pending reminders, verifies absence, and stays within one-pass limits', async () => {
    const store = new MemoryStore();
    const pending: PendingNotificationRequest[] = [];
    let app!: AppControllerImpl;
    let triggerBulkCancel = false;
    let bulkCancelStarted = false;
    let trackReads = false;
    let passCount = 0;
    const cancellationPromises: Promise<unknown>[] = [];
    let listCalls = 0;
    let cancelCalls = 0;
    const readsByPass: number[] = [];
    const schedule = vi.fn(async (intent, installationId) => {
      const projection = notificationContentForIntent(intent, installationId!);
      pending.push({ identifier: intent.identifier, title: projection.title, body: projection.body, data: projection.data,
        trigger: { dueAt: intent.payload!.dueAt, repeats: false, verifiable: true }, extraContentSafe: true });
      return intent.identifier;
    });
    app = new AppControllerImpl(store, {}, { reminderBackend: backend({
      listPending: async () => {
        listCalls += 1;
        if (trackReads && passCount > 0) readsByPass[passCount - 1] += 1;
        return structuredClone(pending);
      },
      schedule,
      cancel: async (identifier) => { cancelCalls += 1; const index = pending.findIndex((item) => item.identifier === identifier); if (index >= 0) pending.splice(index, 1); },
      installForegroundHandler: async () => {
        if (trackReads) { passCount += 1; readsByPass.push(0); }
        if (!triggerBulkCancel || bulkCancelStarted) return;
        bulkCancelStarted = true;
        for (const record of app.getSnapshot().reminders.records) {
          cancellationPromises.push(app.cancelReminder(record.id, { expectedRevision: record.revision }));
        }
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (app.getSnapshot().reminders.records.every((record) => record.status === 'cancelled')) return;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error('Timed out waiting for cancellation mutations to commit.');
      },
    }) });
    await app.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    for (let index = 0; index < 16; index += 1) {
      const draft = await app.createReminderDraft({ title: `Reminder ${index}`, dueAt });
      const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
      await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    }
    expect(pending).toHaveLength(16);
    const beforeLists = listCalls;
    triggerBulkCancel = true;
    trackReads = true;
    await app.reconcileReminderAlerts();
    await Promise.all(cancellationPromises);
    expect(cancelCalls).toBe(16);
    expect(pending).toHaveLength(0);
    expect(app.getSnapshot().reminders.intents.every((intent) => intent.observed === 'absent')).toBe(true);
    expect(listCalls - beforeLists).toBeLessThanOrEqual(6); // two bounded passes, each capped at three reads
    expect(Math.max(...readsByPass)).toBeLessThanOrEqual(3);
    expect(readsByPass.length).toBeLessThanOrEqual(2);
  });

  it('reloads a cancelled and scrubbed intent without quarantine', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { reminderBackend: backend({ getPermission: async () => 'denied' }) });
    await app.load();
    const draft = await app.createReminderDraft({ title: 'Cancel and verify' });
    const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
    const saved = await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    const cancelled = await app.cancelReminder(saved.id, { expectedRevision: saved.revision });
    const intent = app.getSnapshot().reminders.intents.find((item) => item.reminderId === cancelled.id)!;
    expect(intent).toMatchObject({ desired: 'cancelled', observed: 'absent', observedAt: expect.any(String) });
    expect(intent).not.toHaveProperty('payload');

    const restored = new AppControllerImpl(store);
    await restored.load();
    expect(restored.getSnapshot().reminderRecoveryStatus).toBeUndefined();
    expect(restored.getSnapshot().reminders.intents.find((item) => item.id === intent.id)).toMatchObject({ desired: 'cancelled', observed: 'absent' });
    expect(restored.getSnapshot().reminders.intents.find((item) => item.id === intent.id)).not.toHaveProperty('payload');
  });

  it('does not catch up an absent reminder after its due time has passed', async () => {
    vi.useFakeTimers();
    const startingAt = Date.now();
    vi.setSystemTime(startingAt);
    try {
      const store = new MemoryStore();
      let permission: 'denied' | 'authorized' = 'denied';
      const schedule = vi.fn(async () => 'unexpected');
      const app = new AppControllerImpl(store, {}, { reminderBackend: backend({ getPermission: async () => permission, schedule }) });
      await app.load();
      const draft = await app.createReminderDraft({ title: 'Past reminder', dueAt: new Date(Math.ceil((startingAt + 30_000) / 1000) * 1000).toISOString() });
      const approved = await app.approveReminder(draft.id, { expectedRevision: draft.revision });
      const saved = await app.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
      permission = 'authorized';
      vi.setSystemTime(startingAt + 60_000);
      await app.reconcileReminderAlerts();
      expect(schedule).not.toHaveBeenCalled();
      expect(app.getSnapshot().reminders.intents.find((item) => item.id === saved.currentIntentId)?.observed).toBe('delivery_unknown');
    } finally { vi.useRealTimers(); }
  });

  it('adopts an exact native schedule after the first receipt save fails, without scheduling twice', async () => {
    const store = new MemoryStore();
    const pending: PendingNotificationRequest[] = [];
    const schedule = vi.fn(async (intent, installationId) => {
      const projection = notificationContentForIntent(intent, installationId!);
      pending.push({ identifier: intent.identifier, title: projection.title, body: projection.body, data: projection.data,
        trigger: { dueAt: intent.payload!.dueAt, repeats: false, verifiable: true }, extraContentSafe: true });
      store.failNext = true;
      return intent.identifier;
    });
    const first = new AppControllerImpl(store, {}, { reminderBackend: backend({ listPending: async () => structuredClone(pending), schedule }) });
    await first.load();
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const draft = await first.createReminderDraft({ title: 'Receipt recovery', dueAt });
    const approved = await first.approveReminder(draft.id, { expectedRevision: draft.revision });
    await first.saveApprovedReminder(approved.id, { expectedRevision: approved.revision });
    expect(schedule).toHaveBeenCalledOnce();

    const restored = new AppControllerImpl(store, {}, { reminderBackend: backend({ listPending: async () => structuredClone(pending), schedule }) });
    await restored.load();
    await restored.reconcileReminderAlerts();
    expect(schedule).toHaveBeenCalledOnce();
    expect(restored.getSnapshot().reminders.intents[0].observed).toBe('pending');
  });

  it('routes note reminders through the saved ledger and cancels them atomically with note deletion', async () => {
    const dueAt = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000).toISOString();
    const transcriptDueAt = dueAt.replace('.000Z', 'Z');
    const transcript = `Remind me to call Sam at ${transcriptDueAt}.`;
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
    const batch = createCompletedAssistantBatchClient(() => ({
        summary: 'Call Sam.', answer: '', decisions: [],
        citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: transcript }], clarifications: [],
        proposals: [{ kind: 'reminder', title: 'Call Sam', body: 'Call Sam about the appointment.', recipients: [], dueAt, evidence: [transcript] }],
        memorySuggestions: [],
      }));
    const store = new MemoryStore();
    const schedule = vi.fn(async () => 'must-not-schedule');
    const app = new AppControllerImpl(store, {}, { openRouterBatchClient: batch.client,
      reminderBackend: backend({ getPermission: async () => 'denied', schedule }),
    });
    await app.load();
    await app.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
    const note = await app.saveNote({ transcript });
    await app.refreshAssistantBatch((await app.submitNoteBatch(note.id)).id);
    const proposal = app.getSnapshot().proposals.find((item) => item.noteId === note.id)!;
    expect(proposal.kind).toBe('reminder');
    await app.approveProposal(proposal.id);
    const executed = await app.executeProposal(proposal.id);
    expect(executed.status).toBe('executed');
    expect(executed.reminderId).toBeTruthy();
    expect(app.getSnapshot().reminders.records.find((item) => item.id === executed.reminderId)).toMatchObject({ status: 'saved', origin: { kind: 'note', noteId: note.id } });
    expect(schedule).not.toHaveBeenCalled();

    await app.deleteNote(note.id);
    const reminder = app.getSnapshot().reminders.records.find((item) => item.id === executed.reminderId);
    const intent = app.getSnapshot().reminders.intents.find((item) => item.reminderId === executed.reminderId);
    expect(app.getSnapshot().notes.some((item) => item.id === note.id)).toBe(false);
    expect(reminder?.status).toBe('cancelled');
    expect(intent).toMatchObject({ desired: 'cancelled', observed: 'absent', observedAt: expect.any(String) });
    expect(intent).not.toHaveProperty('payload');
  });

  it('keeps malformed reminder data private and blocks reminder mutations', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const persisted = structuredClone(store.value!);
    (persisted as unknown as { reminders: unknown }).reminders = { schemaVersion: 1, installationId: 'bad', records: [{ title: 'secret raw corruption' }], intents: [] };
    await store.save(persisted);
    const restored = new AppControllerImpl(store, {}, { reminderBackend: backend() });
    await restored.load();
    expect(JSON.stringify(restored.getSnapshot())).not.toContain('secret raw corruption');
    expect(restored.getSnapshot().reminderRecoveryStatus).toBeTruthy();
    await expect(restored.createReminderDraft()).rejects.toThrow(/recovery/i);
  });
});
