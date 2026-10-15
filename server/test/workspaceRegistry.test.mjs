import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { acquireApplicationOwnership } from '../dist/applicationOwnership.js';
import { AppControllerImpl } from '../dist/sharedControllerNode.mjs';
import { CommandJournal, WorkspaceRegistry } from '../dist/workspaceRuntime.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-workspace-registry-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const applicationOwnership = acquireApplicationOwnership(databasePath);
  const kernel = createDurableKernel({ databasePath, applicationOwnership,
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] });
  const expiry = Date.now() + 60 * 60_000;
  const admissionA = kernel.createSession(workspace.workspaceId, ownerId, expiry);
  const admissionB = kernel.createSession(workspace.workspaceId, ownerId, expiry);
  const runtimeSession = kernel.createSession(workspace.workspaceId, ownerId, expiry);
  const journal = new CommandJournal(kernel);
  return { directory, databasePath, applicationOwnership, kernel, ownerId, workspace, admissionA, admissionB, runtimeSession, journal };
}

function removeFixture(f) {
  try { f.kernel.close(); }
  finally {
    f.applicationOwnership.release();
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function createController({ store }) {
  const unavailable = async () => 'unavailable';
  const notificationBackend = {
    platform: 'web', getPermission: unavailable, requestPermission: unavailable,
    async listPending() { return []; }, async schedule() { throw new Error('notifications unsupported'); },
    async cancel() { throw new Error('notifications unsupported'); }, async cancelLegacy() { throw new Error('notifications unsupported'); },
    async installForegroundHandler() {},
  };
  const mailAlertBackend = { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
    async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; } };
  const deviceCalendarBackend = { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
    async listCalendars() { throw new Error('device calendars unsupported'); }, async getCalendar() { throw new Error('device calendars unsupported'); },
    async readEvents() { throw new Error('device calendars unsupported'); }, async createApprovedEvent() { throw new Error('device calendars unsupported'); },
    async lookupRecord() { throw new Error('device calendars unsupported'); } };
  const deniedProvider = { async prepare() { throw new Error('provider denied in registry test'); },
    async analyze() { throw new Error('provider denied in registry test'); }, async generateReply() { throw new Error('provider denied in registry test'); } };
  return new AppControllerImpl({ store, crypto: { randomUUID,
    async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    providers: { speech: { disposeMemory() {} }, openAi: deniedProvider },
    integration: { reminderBackend: notificationBackend, mailAlertBackend, deviceCalendarBackend,
      async writeDocument() {}, async removeAudio() { throw new Error('audio unsupported'); },
      async loadRecordingRecovery() { throw new Error('recording recovery unsupported'); }, bindRecordingRecovery(service) { return service; } },
  });
}

test('registry loads one real shared controller and durable note commands never rerun on duplicate admission', async () => {
  const f = fixture();
  try {
    let constructions = 0;
    let loads = 0;
    const registry = new WorkspaceRegistry(f.kernel, f.journal, () => f.runtimeSession, (context) => {
      constructions += 1;
      const controller = createController(context);
      const originalLoad = controller.load.bind(controller);
      controller.load = async () => { loads += 1; await originalLoad(); };
      return controller;
    });
    const loadedRuntime = await registry.get(f.admissionA);
    let commandRuns = 0;
    const input = { expectedRevision: loadedRuntime.store.getOwnedIdentity().revision, expectedPrivacyEpoch: 0, idempotencyKey: 'note:save:one',
      kind: 'note.save', canonicalBody: '{"transcript":"durable server note"}' };
    const first = await registry.execute({ ...input, admissionSessionToken: f.admissionA }, async (controller) => {
      commandRuns += 1;
      return controller.saveNote({ transcript: 'durable server note', capturedAt: '2026-10-14T00:00:00.000Z' });
    }, (note) => ({ kind: 'note.saved', noteId: note.id }));
    assert.equal(first.admission.fresh, true);
    assert.equal(first.result.transcript, 'durable server note');
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.notes[0].transcript, 'durable server note');

    const duplicate = await registry.execute({ ...input, admissionSessionToken: f.admissionB }, async () => {
      commandRuns += 1;
      throw new Error('duplicate command must not be invoked');
    }, () => null);
    assert.equal(duplicate.admission.fresh, false);
    assert.equal(duplicate.admission.status, 'finished');
    assert.deepEqual({ ...duplicate.admission.receipt }, { kind: 'note.saved', noteId: first.result.id });
    assert.equal(commandRuns, 1);
    assert.equal(constructions, 1);
    assert.equal(loads, 1);

    const reopened = createDurableKernel({ databasePath: f.databasePath,
      applicationOwnership: f.applicationOwnership,
      validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
    assert.equal(reopened.getOwnedSnapshot(f.runtimeSession).snapshot.notes[0].transcript, 'durable server note');
    reopened.close();
  } finally {
    f.kernel.close();
    removeFixture(f);
  }
});

test('concurrent first lookups reserve one entry before invoking the controller factory', async () => {
  const f = fixture();
  try {
    const factoryStarted = deferred();
    const finishFactory = deferred();
    let factories = 0;
    const registry = new WorkspaceRegistry(f.kernel, f.journal, () => f.runtimeSession, async ({ store }) => {
      factories += 1;
      factoryStarted.resolve();
      await finishFactory.promise;
      return createController({ store });
    });
    const first = registry.get(f.admissionA);
    const second = registry.get(f.admissionB);
    await factoryStarted.promise;
    assert.equal(factories, 1);
    finishFactory.resolve();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.controller, right.controller);
    assert.equal(factories, 1);
  } finally { f.kernel.close(); removeFixture(f); }
});

test('a constructed controller is disposed after load failure and cleanup failure stays fenced for explicit retry', async () => {
  const f = fixture();
  try {
    let constructions = 0;
    let loads = 0;
    let disposals = 0;
    const registry = new WorkspaceRegistry(f.kernel, f.journal, () => f.runtimeSession, ({ store }) => {
      constructions += 1;
      const construction = constructions;
      return {
        async load() {
          loads += 1;
          if (construction === 1) throw new Error('synthetic startup load failure');
          await store.load();
        },
        async disposeForPrivacy() {
          disposals += 1;
          if (disposals === 1) throw new Error('synthetic exact-controller cleanup failure');
        },
      };
    });

    await assert.rejects(registry.get(f.admissionA), /synthetic startup load failure/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(constructions, 1);
    assert.equal(disposals, 1, 'the controller returned by the failed factory is still cleaned up');
    await assert.rejects(registry.get(f.admissionB), /disposal retry/);
    assert.equal(constructions, 1, 'a failed cleanup never permits replacement construction');

    await registry.disposeWorkspace(f.admissionA);
    assert.equal(disposals, 2, 'explicit retry disposes the same failed-load controller');
    const replacement = await registry.get(f.admissionB);
    assert.equal(constructions, 2);
    assert.equal(loads, 2);
    assert.ok(replacement.controller);
  } finally { f.kernel.close(); removeFixture(f); }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function lifecycleControllerFactory(onDispose) {
  let factories = 0;
  let loads = 0;
  const factory = async ({ store }) => {
    const generation = ++factories;
    return {
      async load() { loads += 1; await store.load(); },
      async disposeForPrivacy() { await onDispose?.(generation); },
    };
  };
  return { factory, factories: () => factories, loads: () => loads };
}

test('concurrent new-epoch lookups share the exact old-entry disposal and one replacement runtime', async () => {
  const f = fixture();
  try {
    const disposalStarted = deferred();
    const allowDisposal = deferred();
    let runtimeSession = f.runtimeSession;
    const lifecycle = lifecycleControllerFactory(async (generation) => {
      if (generation === 1) { disposalStarted.resolve(); await allowDisposal.promise; }
    });
    const registry = new WorkspaceRegistry(f.kernel, f.journal, () => runtimeSession, lifecycle.factory);
    await registry.get(f.admissionA);

    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: 'advance-private-epoch', type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] },
      receipt: { kind: 'test.epoch' }, privacyEpoch: 1,
    }));
    const expiry = Date.now() + 60 * 60_000;
    const admissionA = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, expiry);
    const admissionB = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, expiry);
    runtimeSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, expiry);

    const firstLookup = registry.get(admissionA);
    const secondLookup = registry.get(admissionB);
    await disposalStarted.promise;
    assert.equal(lifecycle.factories(), 1, 'no replacement is created while old disposal is unresolved');
    allowDisposal.resolve();
    const [first, second] = await Promise.all([firstLookup, secondLookup]);
    assert.equal(first.controller, second.controller);
    assert.equal(lifecycle.factories(), 2);
    assert.equal(lifecycle.loads(), 2);
    assert.equal(registry.getRuntimeCount(), 1);
  } finally { f.kernel.close(); removeFixture(f); }
});

test('command admission waits for an owned disposal to finish before creating a replacement runtime', async () => {
  const f = fixture();
  try {
    const disposalStarted = deferred();
    const allowDisposal = deferred();
    const lifecycle = lifecycleControllerFactory(async (generation) => {
      if (generation === 1) { disposalStarted.resolve(); await allowDisposal.promise; }
    });
    const registry = new WorkspaceRegistry(f.kernel, f.journal, () => f.runtimeSession, lifecycle.factory);
    await registry.get(f.admissionA);
    const disposal = registry.disposeWorkspace(f.admissionA);
    await disposalStarted.promise;

    let commandRuns = 0;
    const command = registry.execute({ admissionSessionToken: f.admissionA, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: 'command-after-disposal', kind: 'test.operation', canonicalBody: '{"value":1}' }, async () => {
      commandRuns += 1;
      return { ok: true };
    }, (result) => ({ ok: result.ok }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commandRuns, 0, 'no command is admitted while disposal owns the entry');
    assert.equal(lifecycle.factories(), 1);
    allowDisposal.resolve();
    const result = await command;
    await disposal;
    assert.equal(result.admission.fresh, true);
    assert.equal(commandRuns, 1);
    assert.equal(lifecycle.factories(), 2);
    assert.equal(lifecycle.loads(), 2);
  } finally { f.kernel.close(); removeFixture(f); }
});

test('disposeAll waits for every entry, keeps failed entries fenced, and retries only failed cleanup explicitly', async () => {
  const f = fixture();
  const secondWorkspace = f.kernel.createWorkspace(f.ownerId, { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] });
  const secondAdmission = f.kernel.createSession(secondWorkspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
  const secondRuntimeSession = f.kernel.createSession(secondWorkspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
  const delayed = deferred();
  const secondDisposeStarted = deferred();
  let firstDisposeAttempts = 0;
  let secondDisposeAttempts = 0;
  try {
    const runtimeByWorkspace = new Map([[f.workspace.workspaceId, f.runtimeSession], [secondWorkspace.workspaceId, secondRuntimeSession]]);
    const registry = new WorkspaceRegistry(f.kernel, f.journal, (identity) => runtimeByWorkspace.get(identity.workspaceId), ({ identity }) => ({
      async load() {},
      async disposeForPrivacy() {
        if (identity.workspaceId === f.workspace.workspaceId) {
          firstDisposeAttempts += 1;
          if (firstDisposeAttempts === 1) throw new Error('first workspace cleanup failed once');
          return;
        }
        secondDisposeAttempts += 1;
        secondDisposeStarted.resolve();
        await delayed.promise;
      },
    }));
    await registry.get(f.admissionA);
    await registry.get(secondAdmission);

    let settled = false;
    const firstAttempt = registry.disposeAll().then(() => { settled = true; }, () => { settled = true; });
    await secondDisposeStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'one cleanup failure does not make disposeAll return while another cleanup is active');
    delayed.resolve();
    await firstAttempt;
    await assert.rejects(registry.get(f.admissionA), /registry is closing/);
    assert.equal(firstDisposeAttempts, 1);
    assert.equal(secondDisposeAttempts, 1);

    await registry.disposeAll();
    assert.equal(firstDisposeAttempts, 2, 'explicit retry runs cleanup again only for the failed exact entry');
    assert.equal(secondDisposeAttempts, 1, 'successfully disposed entries are not disposed twice');
    await registry.disposeAll();
    assert.equal(firstDisposeAttempts, 2, 'successful explicit retry is idempotent');
  } finally { delayed.resolve(); f.kernel.close(); removeFixture(f); }
});
