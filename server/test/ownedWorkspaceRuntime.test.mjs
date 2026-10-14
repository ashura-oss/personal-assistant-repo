import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { OwnedWorkspaceRuntime } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { RUNTIME_ACTOR_EXPIRES_AT } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-owned-runtime-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const validateSnapshot = (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const kernel = createDurableKernel({ databasePath, validateSnapshot });
  const ownerId = randomUUID();
  const initial = createInitialWorkspaceState(randomUUID);
  const workspace = kernel.createWorkspace(ownerId, initial);
  const admissionSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const otherAdmissionSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const runtimeSession = kernel.createSession(workspace.workspaceId, ownerId, RUNTIME_ACTOR_EXPIRES_AT);
  let disposedSpeech = 0;
  const speech = {
    async transcribe() { throw new Error('speech fixture must not make provider requests'); },
    async releaseUploadLease() {},
    disposeMemory() { disposedSpeech += 1; options.onDisposeSpeech?.(); },
  };
  const unavailable = async () => 'unavailable';
  const ports = {
    kernel,
    runtimeSessionFor: (identity) => {
      assert.equal(identity.workspaceId, workspace.workspaceId);
      assert.equal(identity.ownerId, ownerId);
      return runtimeSession;
    },
    crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    providers: { speech, openAi: {
      async prepare() { throw new Error('assistant provider must not run in this test'); },
      async analyze() { throw new Error('assistant provider must not run in this test'); },
      async generateReply() { throw new Error('assistant provider must not run in this test'); },
    } },
    integration: {
      reminderBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async listPending() { return []; }, async schedule() { throw new Error('unsupported'); },
        async cancel() { throw new Error('unsupported'); }, async cancelLegacy() { throw new Error('unsupported'); }, async installForegroundHandler() {} },
      mailAlertBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; } },
      deviceCalendarBackend: { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
        async listCalendars() { throw new Error('unsupported'); }, async getCalendar() { throw new Error('unsupported'); },
        async readEvents() { throw new Error('unsupported'); }, async createApprovedEvent() { throw new Error('unsupported'); },
        async lookupRecord() { throw new Error('unsupported'); } },
      async writeDocument() {}, async removeAudio() {},
      async loadRecordingRecovery() { return { async pickAndStage() { return null; }, async inspect() { throw new Error('unsupported'); }, async remove() {} }; },
      bindRecordingRecovery(service) { return service; },
      ...(options.integration ?? {}),
    },
  };
  const runtime = new OwnedWorkspaceRuntime(ports);
  const admission = { sessionToken: admissionSession, assertCurrent: () => kernel.getOwnedIdentity(admissionSession) };
  return { directory, databasePath, validateSnapshot, kernel, ownerId, workspace, admissionSession,
    otherAdmissionSession, runtimeSession, runtime, admission, ports, disposedSpeech: () => disposedSpeech };
}

test('Node gateway uses the real controller, caches only matching loaded revisions, and durable duplicate commands do not rerun', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const loadedIdentity = f.kernel.getOwnedIdentity(f.admissionSession);
    assert.equal(initial.revision, loadedIdentity.revision);
    assert.equal(Object.isFrozen(initial), true);
    assert.equal(await f.runtime.getSnapshot(f.admission), initial, 'a repeated read reuses one immutable DTO object');

    let operations = 0;
    const command = { ...f.admission, expectedRevision: initial.revision, expectedPrivacyEpoch: initial.privacyEpoch,
      idempotencyKey: randomUUID(), kind: 'note.save', canonicalBody: JSON.stringify({ transcript: 'durable through Node runtime' }) };
    const first = await f.runtime.executeCommand(command, async (controller) => {
      operations += 1;
      return controller.saveNote({ transcript: 'durable through Node runtime', capturedAt: '2026-10-14T00:00:00.000Z' });
    }, (note) => ({ kind: 'note.saved', noteId: note.id }));
    assert.equal(first.admission.fresh, true);
    assert.equal(first.snapshot.revision, initial.revision + 1);
    assert.equal(first.snapshot.state.notes[0].transcript, 'durable through Node runtime');

    const duplicate = await f.runtime.executeCommand({ ...command, sessionToken: f.otherAdmissionSession,
      assertCurrent: () => f.kernel.getOwnedIdentity(f.otherAdmissionSession) }, async () => {
      operations += 1;
      throw new Error('a finished duplicate must never invoke its callback');
    }, () => null);
    assert.equal(duplicate.admission.fresh, false);
    assert.equal(duplicate.admission.status, 'finished');
    assert.equal(operations, 1);
    assert.equal(duplicate.snapshot.revision, initial.revision + 1);

    const reopened = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot });
    try { assert.equal(reopened.getOwnedSnapshot(f.runtimeSession).snapshot.notes[0].transcript, 'durable through Node runtime'); }
    finally { reopened.close(); }
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('cache reads are suppressed across an owned save and stale loaded state cannot be stamped with a newer DB revision', async () => {
  const gate = deferred();
  const entered = deferred();
  let pause = false;
  const f = fixture({ integration: { privacySession: { epoch: '0', async assertCurrent() {
    if (pause) { entered.resolve(); await gate.promise; }
  } } } });
  try {
    const before = await f.runtime.getSnapshot(f.admission);
    pause = true;
    const command = f.runtime.executeCommand({ ...f.admission, expectedRevision: before.revision,
      expectedPrivacyEpoch: before.privacyEpoch, idempotencyKey: randomUUID(), kind: 'note.save',
      canonicalBody: '{"transcript":"private save gap"}' }, async (controller) =>
      controller.saveNote({ transcript: 'private save gap', capturedAt: '2026-10-14T00:00:00.000Z' }),
    (note) => ({ kind: 'note.saved', noteId: note.id }));
    await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('owned command did not enter')), 500))]);
    await assert.rejects(f.runtime.getSnapshot(f.admission), /busy/);
    gate.resolve();
    const saved = await command;
    pause = false;
    assert.equal(saved.snapshot.revision, before.revision + 1);

    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: saved.snapshot.revision, expectedPrivacyEpoch: 0,
      idempotencyKey: randomUUID(), type: 'external.snapshot.advance', canonicalRequest: '{"advance":true}' }, () => ({
      snapshot: f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot,
      receipt: { kind: 'external.advance' },
    }));
    await assert.rejects(f.runtime.getSnapshot(f.admission), /workspace_refresh_required/);
  } finally { gate.resolve(); await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('lost checkpoint acknowledgement invalidates cache until explicit refresh and never reruns the command', async () => {
  const f = fixture();
  try {
    const before = await f.runtime.getSnapshot(f.admission);
    let executions = 0;
    const command = { ...f.admission, expectedRevision: before.revision, expectedPrivacyEpoch: before.privacyEpoch,
      idempotencyKey: randomUUID(), kind: 'note.save', canonicalBody: '{"transcript":"saved before lost acknowledgement"}' };
    await assert.rejects(f.runtime.executeCommand(command, async (controller) => {
      executions += 1;
      return controller.saveNote({ transcript: 'saved before lost acknowledgement', capturedAt: '2026-10-14T00:00:00.000Z' });
    }, () => { throw new Error('synthetic lost command receipt acknowledgement'); }), /synthetic lost command receipt acknowledgement/);
    assert.equal(executions, 1);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.notes.at(-1).transcript, 'saved before lost acknowledgement');
    await assert.rejects(f.runtime.getSnapshot(f.admission));
    let noSaveRuns = 0;
    await assert.rejects(f.runtime.executeCommand({ ...command, idempotencyKey: randomUUID(), kind: 'workspace.noop', canonicalBody: '{}'
    }, async () => { noSaveRuns += 1; return 'noop'; }, () => ({ kind: 'noop' })), /workspace_refresh_required/);
    const replay = f.runtime.executeCommand(command, async () => {
      executions += 1;
      throw new Error('inspection-required command must not rerun');
    }, () => null);
    await assert.rejects(replay, /workspace_refresh_required/);
    assert.equal(noSaveRuns, 0, 'no-save work is not admitted while the snapshot needs explicit refresh');
    assert.equal(executions, 1, 'a finished receipt is not replayed through the execution API while refresh is required');
    const refreshed = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(refreshed.revision, f.kernel.getOwnedIdentity(f.admissionSession).revision);
    assert.equal(refreshed.state.notes[0].transcript, 'saved before lost acknowledgement');
    const afterRefreshReplay = await f.runtime.executeCommand(command, async () => {
      executions += 1;
      throw new Error('finished command must not rerun');
    }, () => null);
    assert.equal(afterRefreshReplay.admission.fresh, false);
    assert.equal(afterRefreshReplay.admission.status, 'inspect_required');
    assert.equal(executions, 1);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('post-save caller verification failure keeps the snapshot unavailable until an explicit reload', async () => {
  const f = fixture();
  try {
    const before = await f.runtime.getSnapshot(f.admission);
    let revoked = false;
    const admission = { ...f.admission, assertCurrent() {
      if (revoked) throw new Error('synthetic caller authorization changed');
      f.kernel.getOwnedIdentity(f.admissionSession);
    } };
    let executions = 0;
    const command = { ...admission, expectedRevision: before.revision,
      expectedPrivacyEpoch: before.privacyEpoch, idempotencyKey: randomUUID(), kind: 'note.save',
      canonicalBody: '{"transcript":"committed before caller check"}' };
    await assert.rejects(f.runtime.executeCommand(command, async (controller) => {
      executions += 1;
      const note = await controller.saveNote({ transcript: 'committed before caller check', capturedAt: '2026-10-14T00:00:00.000Z' });
      revoked = true;
      return note;
    }, (note) => ({ kind: 'note.saved', noteId: note.id })), /synthetic caller authorization changed/);
    assert.equal(executions, 1);
    await assert.rejects(f.runtime.getSnapshot(f.admission), /workspace_refresh_required/);
    await assert.rejects(f.runtime.executeCommand({ ...f.admission, expectedRevision: before.revision,
      expectedPrivacyEpoch: before.privacyEpoch, idempotencyKey: command.idempotencyKey, kind: command.kind,
      canonicalBody: command.canonicalBody }, async () => {
      executions += 1;
      throw new Error('finished receipt must not be replayed through execution');
    }, () => null), /workspace_refresh_required/);
    assert.equal(executions, 1, 'finished receipt replay remains unavailable until the independent refresh succeeds');

    const refreshed = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(refreshed.revision, f.kernel.getOwnedIdentity(f.admissionSession).revision);
    assert.equal(refreshed.state.notes[0].transcript, 'committed before caller check');
    assert.equal(executions, 1, 'refresh reloads committed state but never repeats the owned command');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('controller privacy verification after a committed save cannot publish old state under the new DB revision', async () => {
  const f = fixture();
  let failPostSave = false;
  let beforeRevision = 0;
  const originalPrivacy = f.ports.integration.privacySession;
  f.ports.integration.privacySession = { epoch: '0', async assertCurrent() {
    if (failPostSave && f.kernel.getOwnedIdentity(f.admissionSession).revision > beforeRevision) {
      throw new Error('synthetic post-save privacy verification failure');
    }
    await originalPrivacy?.assertCurrent();
  } };
  try {
    const before = await f.runtime.getSnapshot(f.admission);
    beforeRevision = before.revision;
    failPostSave = true;
    let controllerSeen;
    let executions = 0;
    await assert.rejects(f.runtime.executeCommand({ ...f.admission, expectedRevision: before.revision,
      expectedPrivacyEpoch: before.privacyEpoch, idempotencyKey: randomUUID(), kind: 'note.save',
      canonicalBody: '{"transcript":"DB committed before controller privacy check"}' }, async (controller) => {
      controllerSeen = controller;
      executions += 1;
      return controller.saveNote({ transcript: 'DB committed before controller privacy check', capturedAt: '2026-10-14T00:00:00.000Z' });
    }, (note) => ({ kind: 'note.saved', noteId: note.id })), /synthetic post-save privacy verification failure/);
    assert.equal(executions, 1);
    assert.equal(controllerSeen.getSnapshot().notes.some((note) => note.transcript === 'DB committed before controller privacy check'), false,
      'the controller still has its old public snapshot after its post-save guard fails');
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.notes.some((note) => note.transcript === 'DB committed before controller privacy check'), true,
      'the underlying snapshot may already have committed');
    await assert.rejects(f.runtime.getSnapshot(f.admission), /workspace_refresh_required/);

    failPostSave = false;
    const refreshed = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(refreshed.revision, f.kernel.getOwnedIdentity(f.admissionSession).revision);
    assert.equal(refreshed.state.notes.some((note) => note.transcript === 'DB committed before controller privacy check'), true);
    assert.equal(executions, 1, 'explicit reload restores state without repeating the command');
  } finally { failPostSave = false; await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('browser revocation blocks new admission while an already-owned command can settle, and shutdown drains it before disposal', async () => {
  const f = fixture();
  const release = deferred();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const entered = deferred();
    let executions = 0;
    const command = f.runtime.executeCommand({ ...f.admission, expectedRevision: initial.revision,
      expectedPrivacyEpoch: initial.privacyEpoch, idempotencyKey: randomUUID(), kind: 'test.owned', canonicalBody: '{"run":true}' }, async (controller) => {
      executions += 1;
      entered.resolve();
      await release.promise;
      return controller.saveNote({ transcript: 'owned work settled after caller revoke', capturedAt: '2026-10-14T00:00:00.000Z' });
    }, (note) => ({ kind: 'note.saved', noteId: note.id }));
    void command.catch((error) => entered.reject(error));
    await entered.promise;
    f.kernel.revokeSession(f.admissionSession);
    const closing = f.runtime.closeAfterDrain();
    assert.throws(() => f.runtime.getSnapshot(f.admission), /closing/);
    assert.equal(f.disposedSpeech(), 0, 'owned controller is not disposed while its operation is active');
    release.resolve();
    await assert.rejects(command, /session is invalid or expired/);
    await closing;
    assert.equal(executions, 1);
    assert.equal(f.disposedSpeech(), 1);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.notes[0].transcript, 'owned work settled after caller revoke');
  } finally { release.resolve(); await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('caller authorization is rechecked after async registry lookup and before trusted operation invocation', async () => {
  let callerCurrent = true;
  const f = fixture();
  try {
    const before = await f.runtime.getSnapshot(f.admission);
    const initialIdentity = f.kernel.getOwnedIdentity(f.admissionSession);
    const admission = { sessionToken: f.admissionSession, assertCurrent() {
      if (!callerCurrent) throw new Error('synthetic caller guard changed during controller load');
      f.kernel.getOwnedIdentity(f.admissionSession);
    } };
    let invocations = 0;
    const commandInput = { ...admission, expectedRevision: before.revision,
      expectedPrivacyEpoch: initialIdentity.privacyEpoch,
      idempotencyKey: randomUUID(), kind: 'test.noop', canonicalBody: '{}' };
    const pending = f.runtime.executeCommand(commandInput,
    async () => {
      invocations += 1;
      return 'should not run';
    }, () => ({ kind: 'test.noop' }));
    queueMicrotask(() => { callerCurrent = false; });
    await assert.rejects(pending, /synthetic caller guard changed during controller load/);
    assert.equal(invocations, 0, 'the private operation is not invoked after caller authorization changes');
    assert.doesNotThrow(() => f.kernel.getOwnedIdentity(f.admissionSession), 'kernel session remains valid independently of caller authorization');
    callerCurrent = true;
    const refreshed = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(refreshed.revision, f.kernel.getOwnedIdentity(f.admissionSession).revision);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('failed controller cleanup remains fenced and can be retried explicitly', async () => {
  let failOnce = true;
  const f = fixture({ onDisposeSpeech() {
    if (failOnce) { failOnce = false; throw new Error('synthetic one-time controller cleanup failure'); }
  } });
  try {
    await f.runtime.getSnapshot(f.admission);
    await assert.rejects(f.runtime.closeAfterDrain(), /synthetic one-time controller cleanup failure/);
    assert.throws(() => f.runtime.getSnapshot(f.admission), /closing/,
      'a partially disposed controller is never returned to normal use');
    assert.equal(f.disposedSpeech(), 1);
    await f.runtime.closeAfterDrain();
    assert.equal(f.disposedSpeech(), 2, 'a second explicit shutdown retries the exact failed disposal');
    await f.runtime.closeAfterDrain();
    assert.equal(f.disposedSpeech(), 2, 'successful disposal remains idempotent');
  } finally { await f.runtime.closeAfterDrain().catch(() => undefined); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('runtime port factory is shared within an epoch and replaces only the old epoch ports', async () => {
  const f = fixture();
  try {
    let runtimeSession = f.runtimeSession;
    const made = [];
    let unattachedCleanups = 0;
    const { providers: _providers, integration: _integration, mediaResolver: _mediaResolver, ...base } = f.ports;
    const runtime = new OwnedWorkspaceRuntime({ ...base, runtimeSessionFor: () => runtimeSession, workspacePortsFor(context) {
      assert.equal(Object.isFrozen(context.identity), true);
      assert.equal(context.identity.workspaceId, f.workspace.workspaceId);
      assert.equal(context.identity.ownerId, f.ownerId);
      assert.equal(context.identity.privacyEpoch, made.length);
      assert.equal(context.runtimeSessionToken, runtimeSession);
      const portSet = { disposed: 0 };
      const speech = {
        async transcribe() { throw new Error('speech fixture must not make provider requests'); },
        async releaseUploadLease() {},
        disposeMemory() { portSet.disposed += 1; },
      };
      made.push(portSet);
      return { providers: { ...f.ports.providers, speech }, integration: f.ports.integration,
        mediaResolver: { resolveMediaId() { return undefined; } },
        disposeUnattached() { unattachedCleanups += 1; } };
    } });
    const initial = await runtime.getSnapshot(f.admission);
    assert.equal((await runtime.getSnapshot(f.admission)), initial);
    assert.equal(made.length, 1, 'reads in one workspace epoch reuse one provider set');

    const currentSnapshot = f.kernel.getOwnedSnapshot(runtimeSession).snapshot;
    const loadedIdentity = f.kernel.getOwnedIdentity(runtimeSession);
    f.kernel.runLocalCommand(runtimeSession, { expectedRevision: loadedIdentity.revision, expectedPrivacyEpoch: loadedIdentity.privacyEpoch,
      idempotencyKey: randomUUID(), type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: currentSnapshot, receipt: { kind: 'privacy.erased' }, privacyEpoch: 1,
    }));
    const expiry = Date.now() + 60 * 60_000;
    const nextAdmissionToken = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, expiry);
    runtimeSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    const nextAdmission = { sessionToken: nextAdmissionToken, assertCurrent: () => f.kernel.getOwnedIdentity(nextAdmissionToken) };
    const next = await runtime.refreshSnapshot(nextAdmission);
    assert.equal(next.privacyEpoch, 1);
    assert.equal(made.length, 2, 'the new privacy epoch receives a distinct provider set');
    assert.equal(unattachedCleanups, 0, 'the controller takes ownership after successful construction');
    assert.equal(made[0].disposed, 1, 'only the old epoch controller disposes its own provider port');
    assert.equal(made[1].disposed, 0, 'the current provider port remains live');
    await runtime.closeAfterDrain();
    assert.equal(unattachedCleanups, 0);
    assert.equal(made[0].disposed, 1);
    assert.equal(made[1].disposed, 1, 'shutdown disposes the current epoch provider exactly once');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('runtime rejects missing, mixed, and malformed per-epoch port configuration before controller construction', async () => {
  const f = fixture();
  try {
    const { providers, integration, mediaResolver, ...base } = f.ports;
    assert.throws(() => new OwnedWorkspaceRuntime(base), /owned_workspace_runtime_ports_required/);
    assert.throws(() => new OwnedWorkspaceRuntime({ ...f.ports, workspacePortsFor: () => ({ providers, integration }) }),
      /owned_workspace_runtime_ports_required/);

    let cleanupAttempts = 0;
    const malformed = new OwnedWorkspaceRuntime({ ...base, workspacePortsFor: () => ({ providers: null, integration,
      disposeUnattached() { cleanupAttempts += 1; } }) });
    await assert.rejects(malformed.getSnapshot(f.admission), /owned_workspace_runtime_ports_required/);
    assert.equal(cleanupAttempts, 1, 'returned ports are cleaned if validation fails before construction');
    await malformed.closeAfterDrain();

    let missingDisposerCalls = 0;
    const missingDisposer = new OwnedWorkspaceRuntime({ ...base, workspacePortsFor() {
      missingDisposerCalls += 1;
      return { providers: null, integration };
    } });
    await assert.rejects(missingDisposer.getSnapshot(f.admission), /workspace_runtime_port_cleanup_failed/);
    await assert.rejects(missingDisposer.refreshSnapshot(f.admission), /explicit disposal retry/);
    assert.equal(missingDisposerCalls, 1, 'returned resources without cleanup stay fenced instead of being forgotten');
    await assert.rejects(missingDisposer.retryFailedWorkspaceDisposal(f.admission, 0), /cleanup_unavailable/);
    await missingDisposer.closeAfterDrain().catch(() => undefined);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('failed unattached-port cleanup fences epoch replacement until the caller explicitly retries the exact held epoch', async () => {
  const f = fixture();
  try {
    let runtimeSession = f.runtimeSession;
    let factoryCalls = 0;
    let cleanupCalls = 0;
    const { providers, integration, ...base } = f.ports;
    const runtime = new OwnedWorkspaceRuntime({ ...base, runtimeSessionFor: () => runtimeSession,
      workspacePortsFor() {
        factoryCalls += 1;
        if (factoryCalls === 1) return { providers: null, integration, disposeUnattached() {
          cleanupCalls += 1;
          if (cleanupCalls === 1) throw new Error('synthetic unattached cleanup failure');
        } };
        return { providers, integration, disposeUnattached() {} };
      } });

    await assert.rejects(runtime.getSnapshot(f.admission), /workspace_runtime_port_cleanup_failed/);
    assert.equal(cleanupCalls, 1);
    const oldIdentity = f.kernel.getOwnedIdentity(runtimeSession);
    const currentSnapshot = f.kernel.getOwnedSnapshot(runtimeSession).snapshot;
    f.kernel.runLocalCommand(runtimeSession, { expectedRevision: oldIdentity.revision, expectedPrivacyEpoch: oldIdentity.privacyEpoch,
      idempotencyKey: randomUUID(), type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: currentSnapshot, receipt: { kind: 'privacy.erased' }, privacyEpoch: 1,
    }));
    const expiry = Date.now() + 60 * 60_000;
    const nextAdmissionToken = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, expiry);
    runtimeSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    const nextAdmission = { sessionToken: nextAdmissionToken, assertCurrent: () => f.kernel.getOwnedIdentity(nextAdmissionToken) };
    await assert.rejects(runtime.refreshSnapshot(nextAdmission), /explicit disposal retry/);
    assert.equal(cleanupCalls, 1, 'an ordinary new-epoch read never retries failed cleanup');
    assert.equal(factoryCalls, 1, 'no replacement ports are created while old cleanup is unresolved');

    await assert.rejects(runtime.retryFailedWorkspaceDisposal(nextAdmission, 1), /retry_not_available/);
    assert.equal(cleanupCalls, 1, 'a wrong held epoch cannot retry cleanup');
    const foreignOwner = randomUUID();
    const foreignWorkspace = f.kernel.createWorkspace(foreignOwner, createInitialWorkspaceState(randomUUID));
    const foreignAdmission = f.kernel.createSession(foreignWorkspace.workspaceId, foreignOwner, expiry);
    await assert.rejects(runtime.retryFailedWorkspaceDisposal({ sessionToken: foreignAdmission,
      assertCurrent: () => f.kernel.getOwnedIdentity(foreignAdmission) }, 0), /retry_not_available/);
    assert.equal(cleanupCalls, 1, 'a different owner/workspace cannot retry cleanup');
    assert.throws(() => runtime.retryFailedWorkspaceDisposal(f.admission, 0), /invalid or expired/);

    let callerAuthorized = true;
    const guardedAdmission = { sessionToken: nextAdmissionToken, assertCurrent() {
      if (!callerAuthorized) throw new Error('synthetic caller guard revoked before queued cleanup retry');
      f.kernel.getOwnedIdentity(nextAdmissionToken);
    } };
    queueMicrotask(() => { callerAuthorized = false; });
    await assert.rejects(runtime.retryFailedWorkspaceDisposal(guardedAdmission, 0), /revoked before queued cleanup retry/);
    assert.equal(cleanupCalls, 1, 'a caller guard changed before queued work cannot invoke retained cleanup');
    callerAuthorized = true;

    await runtime.retryFailedWorkspaceDisposal(guardedAdmission, 0);
    assert.equal(cleanupCalls, 2, 'the exact retry invokes the retained cleanup capability once');
    const recovered = await runtime.refreshSnapshot(nextAdmission);
    assert.equal(recovered.privacyEpoch, 1);
    assert.equal(factoryCalls, 2, 'replacement construction happens only after explicit cleanup and refresh');
    await runtime.closeAfterDrain();
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
