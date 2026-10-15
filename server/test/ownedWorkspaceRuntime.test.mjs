import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { acquireApplicationOwnership } from '../dist/applicationOwnership.js';
import { NodeSpeechCleanupAdapter, OwnedWorkspaceRuntime } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { withCommandTicket } from '../dist/workspaceRuntime.js';
import { createNodeProviderResponseLifetimeOwner } from '../dist/providerResponseLifetime.node.mjs';
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
  const applicationOwnership = acquireApplicationOwnership(databasePath);
  const kernel = createDurableKernel({ databasePath, validateSnapshot, applicationOwnership });
  const ownerId = randomUUID();
  const initial = createInitialWorkspaceState(randomUUID);
  const workspace = kernel.createWorkspace(ownerId, initial);
  const admissionSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const otherAdmissionSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const runtimeSession = kernel.createSession(workspace.workspaceId, ownerId, RUNTIME_ACTOR_EXPIRES_AT);
  const responseLifetimeOwner = createNodeProviderResponseLifetimeOwner({
    fetcher: options.responseFetcher ?? (async () => { throw new Error('unexpected provider response fetch'); }), createId: randomUUID,
  });
  let disposedSpeech = 0;
  const speech = {
    async transcribe(...args) {
      if (options.transcribe) return options.transcribe(...args, responseLifetimeOwner);
      throw new Error('speech fixture must not make provider requests');
    },
    async releaseUploadLease() {},
    disposeMemory() { disposedSpeech += 1; options.onDisposeSpeech?.(); },
  };
  const unavailable = async () => 'unavailable';
  const ports = {
    kernel,
    runtimeSessionFor: options.runtimeSessionFor ?? ((identity) => {
      assert.equal(identity.workspaceId, workspace.workspaceId);
      assert.equal(identity.ownerId, ownerId);
      return runtimeSession;
    }),
    crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    responseLifetimeOwner,
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
  const runtimeOptions = options.workspacePortsFor ? { kernel, runtimeSessionFor: ports.runtimeSessionFor, crypto: ports.crypto,
    workspacePortsFor: (context) => options.workspacePortsFor(context, ports),
    ...(options.isWorkspaceEraseComplete ? { isWorkspaceEraseComplete: options.isWorkspaceEraseComplete } : {}),
    ...(options.isWorkspaceEraseCancellationComplete ? { isWorkspaceEraseCancellationComplete: options.isWorkspaceEraseCancellationComplete } : {})
  } : { ...ports, ...(options.isWorkspaceEraseComplete ? { isWorkspaceEraseComplete: options.isWorkspaceEraseComplete } : {}),
    ...(options.isWorkspaceEraseCancellationComplete ? { isWorkspaceEraseCancellationComplete: options.isWorkspaceEraseCancellationComplete } : {}) };
  const runtime = new OwnedWorkspaceRuntime({ ...runtimeOptions, ...(options.afterSpeechCleanupCommitForTesting
    ? { afterSpeechCleanupCommitForTesting: options.afterSpeechCleanupCommitForTesting } : {}) });
  const admission = { sessionToken: admissionSession, assertCurrent: () => kernel.getOwnedIdentity(admissionSession) };
  return { directory, databasePath, applicationOwnership, validateSnapshot, kernel, ownerId, workspace, admissionSession,
    otherAdmissionSession, runtimeSession, runtime, admission, ports, disposedSpeech: () => disposedSpeech };
}

function removeFixture(f) {
  try { f.kernel.close(); }
  finally {
    f.applicationOwnership.release();
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function speechPrepared(leaseId, durationSeconds = 1) {
  return { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
    sha256: 'a'.repeat(64), durationSeconds, upload: { blob: new Blob(['voice']), fileName: 'note.wav' } };
}

test('scheduled account sync observes active foreground busy before sticky refresh-required state', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  try {
    const snapshot = await f.runtime.getSnapshot(f.admission);
    const foreground = f.runtime.executeCommand({ ...f.admission, expectedRevision: snapshot.revision,
      expectedPrivacyEpoch: snapshot.privacyEpoch, idempotencyKey: randomUUID(), kind: 'notes.save', canonicalBody: '{}' },
    async () => { entered.resolve(); await release.promise; return Object.freeze({ saved: true }); },
    () => Object.freeze({ kind: 'note.saved', noteId: randomUUID() }));
    await entered.promise;
    await assert.rejects(f.runtime.executeScheduledAccountSync({ sessionToken: f.admissionSession, ownerId: f.ownerId,
      privacyEpoch: snapshot.privacyEpoch, claim: Object.freeze({ occurrenceId: randomUUID(), attemptId: randomUUID(),
        targetId: 'google:account', targetGeneration: 1, capability: randomUUID() }), occurrences: {} }),
    /The workspace runtime is busy\./);
    release.resolve();
    await foreground;
  } finally {
    release.resolve();
    await f.runtime.closeAfterDrain();
    removeFixture(f);
  }
});

test('erase hold survives a failed drain and the same command explicitly retries before cancellation can release it', async () => {
  let drainCalls = 0;
  let cancellationDurable = false;
  const lifecycle = { stopAdmission() {}, async drain() {
    drainCalls += 1;
    if (drainCalls === 1) throw new Error('synthetic attached cleanup failure');
  }, async dispose() {} };
  const f = fixture({ isWorkspaceEraseCancellationComplete: () => cancellationDurable,
    workspacePortsFor: (_context, ports) => ({ providers: ports.providers, integration: ports.integration,
      responseLifetimeOwner: ports.responseLifetimeOwner, disposeUnattached() {}, attachedLifecycle: lifecycle }) });
  const commandId = randomUUID();
  try {
    await f.runtime.getSnapshot(f.admission);
    await assert.rejects(f.runtime.reserveWorkspaceForErase(f.admission, commandId), /synthetic attached cleanup failure/);
    assert.deepEqual(f.runtime.getWorkspaceEraseHoldStatus(f.admission), { commandId, status: 'drain_failed', expectedRevision: f.kernel.getOwnedIdentity(f.admissionSession).revision, expectedPrivacyEpoch: 0 });
    assert.throws(() => f.runtime.getSnapshot(f.admission), /workspace_erase_in_progress/);

    const hold = await f.runtime.reserveWorkspaceForErase(f.admission, commandId);
    assert.deepEqual(f.runtime.getWorkspaceEraseHoldStatus(f.admission), { commandId, status: 'drained', expectedRevision: f.kernel.getOwnedIdentity(f.admissionSession).revision, expectedPrivacyEpoch: 0 });
    assert.equal(drainCalls, 2, 'same-command retry reruns the retained exact lifecycle drain');
    assert.throws(() => f.runtime.assertWorkspaceEraseHold({}, commandId), /workspace_erase_hold_rejected/);
    assert.throws(() => hold.releaseAfterCancellation(), /workspace_erase_cancellation_rejected/);
    cancellationDurable = true;
    hold.releaseAfterCancellation();
    assert.equal(f.runtime.getWorkspaceEraseHoldStatus(f.admission), undefined);
  } finally {
    await f.runtime.closeAfterDrain();
    removeFixture(f);
  }
});

async function executeAtCurrent(runtime, kernel, admission, kind, canonicalBody, operation, receipt) {
  const identity = kernel.getOwnedIdentity(admission.sessionToken);
  return runtime.executeCommand({ ...admission, expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch,
    idempotencyKey: randomUUID(), kind, canonicalBody }, operation, receipt);
}

test('knowledge source and suggestion reads return current projections without journal admission or snapshot publication', async () => {
  const f = fixture();
  try {
    await f.runtime.getSnapshot(f.admission);
    const created = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'knowledge.person.save', '{"kind":"setup"}', async (controller) => {
      const person = await controller.savePerson({ name: 'Morgan', aliases: [], narrative: '' });
      const note = await controller.saveNote({ transcript: 'A source quote for review.' });
      const suggestion = await controller.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript',
        quote: 'A source quote', targetKind: 'person', targetId: person.id,
        change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Works on the Still project.' } });
      return { person, note, suggestion };
    }, (value) => ({ kind: 'knowledge.person.save', suggestionId: value.suggestion.id }));
    const identity = f.kernel.getOwnedIdentity(f.admission.sessionToken);
    const beforeSnapshot = await f.runtime.getSnapshot(f.admission);
    const beforeHistory = f.runtime.listCommandHistory(f.admission).entries;
    const sourceChoices = await f.runtime.readKnowledgeSourceChoices(f.admission, {
      expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch,
    });
    assert.equal(sourceChoices.workspaceId, identity.workspaceId);
    assert.equal(sourceChoices.revision, identity.revision);
    assert.ok(sourceChoices.choices.some((choice) => choice.reference.kind === 'note' && choice.reference.id === created.result.note.id));

    const suggestionReview = await f.runtime.readKnowledgeSuggestionReview(f.admission, {
      suggestionId: created.result.suggestion.id, expectedSuggestionRevision: created.result.suggestion.revision,
      expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch,
    });
    assert.equal(suggestionReview.review.suggestion.id, created.result.suggestion.id);
    assert.equal(suggestionReview.review.suggestion.status, 'pending');
    assert.equal(suggestionReview.review.canEdit, true);
    assert.deepEqual(f.runtime.listCommandHistory(f.admission).entries, beforeHistory);
    assert.equal(await f.runtime.getSnapshot(f.admission), beforeSnapshot, 'named reads must not publish a snapshot');
    await assert.rejects(f.runtime.readKnowledgeSourceChoices(f.admission, { expectedRevision: identity.revision + 1,
      expectedPrivacyEpoch: identity.privacyEpoch }), /workspace_read_stale/);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
});

test('actual Node controller and response owner register speech cleanup before dispatch and settle after parent receipt', async () => {
  const cleanup = deferred();
  let dispatched = 0;
  const f = fixture({ responseFetcher: async () => new Response('owned synthetic speech response'),
    transcribe: async (_note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId, responseOwner) => {
    const prepared = speechPrepared(leaseId);
    await onPrepared(prepared);
    await onAttempt(prepared);
    beforeDispatch(prepared);
    const responseLifetime = responseOwner.withResponseLifetimeFor('azure_speech');
    assert.equal(await responseLifetime('https://speech.invalid/synthetic', {}, async (response) => response.text()), 'owned synthetic speech response');
    dispatched += 1;
    return { transcript: 'A real controller transcript.', durationMilliseconds: 1000, durationSeconds: 1,
      billedEstimateSeconds: 1, attempts: 1, cleanupPromise: cleanup.promise };
  } });
  try {
    await f.runtime.getSnapshot(f.admission);
    const created = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.create', '{"transcript":"voice"}',
      (controller) => controller.saveNote({ transcript: 'voice', audioUri: 'file:///private/voice.m4a', durationSeconds: 1 }),
      (note) => ({ kind: 'note.created', noteId: note.id }));
    const note = created.result;
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'settings.update', '{"speechEnabled":true}',
      (controller) => controller.saveSettings({ speechEnabled: true, speechEndpoint: 'https://example.cognitiveservices.azure.com' }),
      () => ({ kind: 'settings.updated' }));

    const result = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.transcribe', JSON.stringify({ noteId: note.id }),
      (controller) => controller.transcribeNote(note.id, { expectedRevision: note.revision }),
      (updated) => ({ kind: 'transcription.finished', noteId: updated.id }));
    assert.equal(dispatched, 1);
    assert.equal(result.admission.fresh, true);
    assert.equal(f.runtime.inspectCommandReceipt(f.admission, result.admission.ticket.idempotencyKey).status, 'finished');
    assert.equal(result.snapshot, undefined, 'speech lease settlement must be followed by an explicit refresh before publishing a snapshot');
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.transcription.cleanupLeases.at(-1).outcome, 'pending_cleanup');
    await assert.rejects(f.runtime.getSnapshot(f.admission), /refresh_required/i);

    cleanup.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.transcription.cleanupLeases.at(-1).outcome, 'released');
    await assert.rejects(f.runtime.getSnapshot(f.admission), /refresh_required/i);
    const refreshed = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(refreshed.state.transcription.attempts.at(-1).outcome, 'completed');
    assert.equal(refreshed.state.notes.find((item) => item.id === note.id).transcript, 'A real controller transcript.');
  } finally { cleanup.resolve(); await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
});

test('new privacy epoch waits for old raw and audio cleanup, then retires without settling through the revoked actor', async () => {
  const cleanup = deferred();
  let currentRuntimeSession;
  const f = fixture({ responseFetcher: async () => new Response('owned synthetic speech response'),
    runtimeSessionFor: () => currentRuntimeSession,
    transcribe: async (_note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId, responseOwner) => {
      const prepared = speechPrepared(leaseId);
      await onPrepared(prepared); await onAttempt(prepared); beforeDispatch(prepared);
      await responseOwner.withResponseLifetimeFor('azure_speech')('https://speech.invalid/synthetic', {}, async (response) => response.text());
      return { transcript: 'Old epoch transcript.', durationMilliseconds: 1000, durationSeconds: 1,
        billedEstimateSeconds: 1, attempts: 1, cleanupPromise: cleanup.promise };
    } });
  currentRuntimeSession = f.runtimeSession;
  try {
    await f.runtime.getSnapshot(f.admission);
    const created = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.create', '{"transcript":"voice"}',
      (controller) => controller.saveNote({ transcript: 'voice', audioUri: 'file:///private/voice.m4a', durationSeconds: 1 }),
      (note) => ({ kind: 'note.created', noteId: note.id }));
    const note = created.result;
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'settings.update', '{"speechEnabled":true}',
      (controller) => controller.saveSettings({ speechEnabled: true, speechEndpoint: 'https://speech.cognitiveservices.azure.com' }),
      () => ({ kind: 'settings.updated' }));
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.transcribe', JSON.stringify({ noteId: note.id }),
      (controller) => controller.transcribeNote(note.id, { expectedRevision: note.revision }),
      (updated) => ({ kind: 'transcription.finished', noteId: updated.id }));

    const oldIdentity = f.kernel.getOwnedIdentity(f.runtimeSession);
    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: oldIdentity.revision, expectedPrivacyEpoch: oldIdentity.privacyEpoch,
      idempotencyKey: randomUUID(), type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot, receipt: { kind: 'privacy.erased' }, privacyEpoch: 1,
    }));
    const nextAdmissionToken = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    const nextRuntimeSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    currentRuntimeSession = nextRuntimeSession;
    const nextAdmission = { sessionToken: nextAdmissionToken, assertCurrent: () => f.kernel.getOwnedIdentity(nextAdmissionToken) };
    let replacementFinished = false;
    const replacement = f.runtime.refreshSnapshot(nextAdmission).then((snapshot) => { replacementFinished = true; return snapshot; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replacementFinished, false, 'replacement waits while the exact old audio cleanup promise is pending');
    assert.equal(f.disposedSpeech(), 0, 'old provider resources are not disposed before audio cleanup settles');

    cleanup.resolve();
    const next = await replacement;
    assert.equal(next.privacyEpoch, 1);
    assert.equal(f.disposedSpeech(), 1, 'the old controller is disposed only after both physical cleanup chains finish');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const durable = f.kernel.getOwnedSnapshot(nextRuntimeSession).snapshot;
    assert.notEqual(durable.transcription.cleanupLeases.at(-1).outcome, 'released',
      'a new actor never settles the old epoch cleanup lease');
    const child = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM speech_cleanup_children').get());
    assert.notEqual(child.status, 'released', 'old child evidence remains inspection-only after revocation');
    await f.runtime.closeAfterDrain();
  } finally { cleanup.resolve(); await f.runtime.closeAfterDrain().catch(() => undefined); f.kernel.close(); removeFixture(f); }
});

test('registry epoch replacement cannot bypass a sticky raw response owner before disposing the old controller', async () => {
  let currentRuntimeSession;
  let fetches = 0;
  const f = fixture({ runtimeSessionFor: () => currentRuntimeSession, responseFetcher: async () => {
    fetches += 1;
    return new Response(new ReadableStream({ pull() {}, cancel() { throw new Error('synthetic raw response cancellation failure'); } }));
  }, transcribe: async (_note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId, responseOwner) => {
    const prepared = speechPrepared(leaseId);
    await onPrepared(prepared); await onAttempt(prepared); beforeDispatch(prepared);
    await responseOwner.withResponseLifetimeFor('azure_speech')('https://speech.invalid/synthetic', {}, async () => 'not consumed').catch(() => undefined);
    return { transcript: 'Old response owner transcript.', durationMilliseconds: 1000, durationSeconds: 1,
      billedEstimateSeconds: 1, attempts: 1, cleanupPromise: Promise.resolve() };
  } });
  currentRuntimeSession = f.runtimeSession;
  try {
    await f.runtime.getSnapshot(f.admission);
    const created = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.create', '{"transcript":"voice"}',
      (controller) => controller.saveNote({ transcript: 'voice', audioUri: 'file:///private/voice.m4a', durationSeconds: 1 }),
      (note) => ({ kind: 'note.created', noteId: note.id }));
    const note = created.result;
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'settings.update', '{"speechEnabled":true}',
      (controller) => controller.saveSettings({ speechEnabled: true, speechEndpoint: 'https://speech.cognitiveservices.azure.com' }),
      () => ({ kind: 'settings.updated' }));
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.transcribe', JSON.stringify({ noteId: note.id }),
      (controller) => controller.transcribeNote(note.id, { expectedRevision: note.revision }),
      (updated) => ({ kind: 'transcription.finished', noteId: updated.id }));
    assert.equal(fetches, 1);
    const pending = f.ports.responseLifetimeOwner.getPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, 'cleanup_failed');

    const oldIdentity = f.kernel.getOwnedIdentity(f.runtimeSession);
    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: oldIdentity.revision, expectedPrivacyEpoch: oldIdentity.privacyEpoch,
      idempotencyKey: randomUUID(), type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot, receipt: { kind: 'privacy.erased' }, privacyEpoch: 1,
    }));
    const nextToken = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    currentRuntimeSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    const nextAdmission = { sessionToken: nextToken, assertCurrent: () => f.kernel.getOwnedIdentity(nextToken) };
    await assert.rejects(f.runtime.refreshSnapshot(nextAdmission), /synthetic raw response cancellation failure/);
    assert.equal(f.disposedSpeech(), 0, 'the exact registry entry remains held while its response body is unresolved');
    assert.equal(f.ports.responseLifetimeOwner.getPending()[0].id, pending[0].id);
    await assert.rejects(f.runtime.retryProviderResponseCleanup(nextAdmission, pending[0].id), /synthetic raw response cancellation failure/);
    assert.equal(fetches, 1, 'raw cleanup retry never repeats the provider request');
  } finally { f.kernel.close(); removeFixture(f); }
});

test('a failed old-epoch audio release needs an exact physical-only retry under the newer owner before retirement', async () => {
  const cleanup = deferred();
  let retryReleases = 0;
  let losePendingCleanupAcknowledgement = true;
  const f = fixture({ responseFetcher: async () => new Response('owned synthetic speech response'),
    afterSpeechCleanupCommitForTesting() {
      if (losePendingCleanupAcknowledgement) {
        losePendingCleanupAcknowledgement = false;
        throw new Error('synthetic pending cleanup acknowledgement loss');
      }
    },
    runtimeSessionFor: () => currentRuntimeSession,
    transcribe: async (_note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId, responseOwner) => {
      const prepared = speechPrepared(leaseId);
      await onPrepared(prepared); await onAttempt(prepared); beforeDispatch(prepared);
      await responseOwner.withResponseLifetimeFor('azure_speech')('https://speech.invalid/synthetic', {}, async (response) => response.text());
      return { transcript: 'Old epoch transcript.', durationMilliseconds: 1000, durationSeconds: 1,
        billedEstimateSeconds: 1, attempts: 1, cleanupPromise: cleanup.promise };
    } });
  let currentRuntimeSession = f.runtimeSession;
  f.ports.providers.speech.releaseUploadLease = async () => { retryReleases += 1; };
  try {
    await f.runtime.getSnapshot(f.admission);
    const created = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.create', '{"transcript":"voice"}',
      (controller) => controller.saveNote({ transcript: 'voice', audioUri: 'file:///private/voice.m4a', durationSeconds: 1 }),
      (note) => ({ kind: 'note.created', noteId: note.id }));
    const note = created.result;
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'settings.update', '{"speechEnabled":true}',
      (controller) => controller.saveSettings({ speechEnabled: true, speechEndpoint: 'https://speech.cognitiveservices.azure.com' }),
      () => ({ kind: 'settings.updated' }));
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.transcribe', JSON.stringify({ noteId: note.id }),
      (controller) => controller.transcribeNote(note.id, { expectedRevision: note.revision }),
      (updated) => ({ kind: 'transcription.finished', noteId: updated.id }));
    cleanup.reject(new Error('synthetic audio cleanup failure'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const childId = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT child_id FROM speech_cleanup_children').get().child_id);
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM speech_cleanup_children WHERE child_id = ?').get(childId).status),
      'pending_cleanup', 'the pending cleanup transition committed despite its lost acknowledgement');

    const oldIdentity = f.kernel.getOwnedIdentity(f.runtimeSession);
    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: oldIdentity.revision, expectedPrivacyEpoch: oldIdentity.privacyEpoch,
      idempotencyKey: randomUUID(), type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot, receipt: { kind: 'privacy.erased' }, privacyEpoch: 1,
    }));
    const nextAdmissionToken = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    const nextRuntimeSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    currentRuntimeSession = nextRuntimeSession;
    const nextAdmission = { sessionToken: nextAdmissionToken, assertCurrent: () => f.kernel.getOwnedIdentity(nextAdmissionToken) };
    await assert.rejects(f.runtime.refreshSnapshot(nextAdmission), /physical work is unresolved/);
    assert.equal(f.disposedSpeech(), 0, 'failed physical cleanup keeps the revoked actor resources held');
    assert.equal(retryReleases, 0);

    await assert.rejects(f.runtime.retryRetiredSpeechPhysicalCleanup(nextAdmission, 1, childId),
    /retirement_cleanup_unavailable/);
    await f.runtime.retryRetiredSpeechPhysicalCleanup(nextAdmission, 0, childId);
    assert.equal(retryReleases, 1, 'only the captured cleanup callback is retried, once');
    const childBeforeRetirement = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM speech_cleanup_children WHERE child_id = ?').get(childId).status);
    assert.notEqual(childBeforeRetirement, 'released', 'the newer actor does not settle old durable child evidence');
    await f.runtime.retryFailedWorkspaceDisposal(nextAdmission, 0);
    assert.equal(f.disposedSpeech(), 1);
    const refreshed = await f.runtime.refreshSnapshot(nextAdmission);
    assert.equal(refreshed.privacyEpoch, 1);
    assert.equal(f.kernel.getOwnedSnapshot(nextRuntimeSession).snapshot.transcription.cleanupLeases.at(-1).outcome, 'pending_cleanup',
      'physical cleanup retirement does not write the old lease through the new actor');
    await f.runtime.closeAfterDrain();
  } finally { cleanup.resolve(); await f.runtime.closeAfterDrain().catch(() => undefined); f.kernel.close(); removeFixture(f); }
});

test('runtime shutdown retains the controller and private actor while the actual response owner has sticky body cleanup', async () => {
  let fetches = 0;
  let bodyCancelCalls = 0;
  const f = fixture({ responseFetcher: async () => {
    fetches += 1;
    return new Response(new ReadableStream({
      pull() {},
      cancel() { bodyCancelCalls += 1; throw new Error('synthetic response body cancellation failure'); },
    }));
  }, transcribe: async (_note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId, responseOwner) => {
    const prepared = speechPrepared(leaseId);
    await onPrepared(prepared);
    await onAttempt(prepared);
    beforeDispatch(prepared);
    // The speech caller's cleanup promise can finish while the transport owner
    // still holds an unconsumed response body and its failed cancellation.
    await responseOwner.withResponseLifetimeFor('azure_speech')('https://speech.invalid/synthetic', {}, async () => 'not consumed')
      .catch(() => undefined);
    return { transcript: 'A safe synthetic transcript.', durationMilliseconds: 1000, durationSeconds: 1,
      billedEstimateSeconds: 1, attempts: 1, cleanupPromise: Promise.resolve() };
  } });
  try {
    await f.runtime.getSnapshot(f.admission);
    const created = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.create', '{"transcript":"voice"}',
      (controller) => controller.saveNote({ transcript: 'voice', audioUri: 'file:///private/voice.m4a', durationSeconds: 1 }),
      (note) => ({ kind: 'note.created', noteId: note.id }));
    const note = created.result;
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'settings.update', '{"speechEnabled":true}',
      (controller) => controller.saveSettings({ speechEnabled: true, speechEndpoint: 'https://speech.cognitiveservices.azure.com' }),
      () => ({ kind: 'settings.updated' }));
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.transcribe', JSON.stringify({ noteId: note.id }),
      (controller) => controller.transcribeNote(note.id, { expectedRevision: note.revision }),
      (updated) => ({ kind: 'transcription.finished', noteId: updated.id }));

    const ownedPending = f.ports.responseLifetimeOwner.getPending();
    assert.equal(fetches, 1, 'the real per-workspace owner is the only fake transport used by this speech operation');
    assert.equal(ownedPending.length, 1);
    assert.equal(ownedPending[0].purpose, 'azure_speech');
    assert.equal(ownedPending[0].state, 'cleanup_failed');
    await assert.rejects(f.runtime.closeAfterDrain(), /synthetic response body cancellation failure/);
    assert.equal(f.disposedSpeech(), 0, 'controller disposal waits while the response owner has sticky body cleanup');
    assert.equal(f.kernel.getOwnedIdentity(f.runtimeSession).workspaceId, f.workspace.workspaceId,
      'the private actor remains live while owner drain is unresolved');
    await assert.rejects(f.runtime.retryProviderResponseCleanup(f.admission, ownedPending[0].id),
      /synthetic response body cancellation failure/);
    assert.equal(fetches, 1, 'an exact cleanup retry never repeats the provider request');
    assert.equal(f.disposedSpeech(), 0);
    assert.equal(bodyCancelCalls, 1, 'a repeated cancellation that lacks underlying acknowledgement cannot clear the sticky hold');
  } finally {
    f.kernel.close();
    removeFixture(f);
  }
});

test('a registered child without an observed cleanup promise blocks adapter drain', async () => {
  const childId = randomUUID();
  const ticketId = randomUUID();
  const handle = Object.freeze({ childId });
  const adapter = new NodeSpeechCleanupAdapter({
    children: { registerCurrentChild() { return { childId, status: 'owned', handle }; } },
    scheduleSettlement: async (work) => work(),
    invalidateLoadedSnapshot() {},
  });
  await withCommandTicket({ ticketId }, async () => {
    const observer = adapter.controllerPort.register({ noteId: randomUUID(), attemptId: randomUUID(), leaseId: randomUUID(), provider: 'azure' });
    observer.markPending();
  });
  adapter.parentInvocationCompleted(ticketId);
  await assert.rejects(adapter.drain(), /ownership requires exact cleanup or settlement acknowledgement/);
});

test('lost cleanup settlement acknowledgement holds shutdown until exact refresh proof is adopted', async () => {
  let loseAcknowledgement = true;
  const f = fixture({ afterSpeechCleanupCommitForTesting() {
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('synthetic committed cleanup acknowledgement loss'); }
    }, responseFetcher: async () => new Response('owned synthetic speech response'),
    transcribe: async (_note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId, responseOwner) => {
      const prepared = speechPrepared(leaseId);
      await onPrepared(prepared);
      await onAttempt(prepared);
      beforeDispatch(prepared);
      await responseOwner.withResponseLifetimeFor('azure_speech')('https://speech.invalid/synthetic', {}, async (response) => response.text());
      return { transcript: 'A synthetic transcript.', durationMilliseconds: 1000, durationSeconds: 1,
        billedEstimateSeconds: 1, attempts: 1, cleanupPromise: Promise.resolve() };
    } });
  try {
    await f.runtime.getSnapshot(f.admission);
    const created = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.create', '{"transcript":"voice"}',
      (controller) => controller.saveNote({ transcript: 'voice', audioUri: 'file:///private/voice.m4a', durationSeconds: 1 }),
      (note) => ({ kind: 'note.created', noteId: note.id }));
    const note = created.result;
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'settings.update', '{"speechEnabled":true}',
      (controller) => controller.saveSettings({ speechEnabled: true, speechEndpoint: 'https://speech.cognitiveservices.azure.com' }),
      () => ({ kind: 'settings.updated' }));
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.transcribe', JSON.stringify({ noteId: note.id }),
      (controller) => controller.transcribeNote(note.id, { expectedRevision: note.revision }),
      (updated) => ({ kind: 'transcription.finished', noteId: updated.id }));

    await assert.rejects(f.runtime.closeAfterDrain(), /ownership requires exact cleanup or settlement acknowledgement/);
    assert.equal(f.disposedSpeech(), 0, 'durable child failure keeps provider resources and the actor available');
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.transcription.cleanupLeases.at(-1).outcome, 'released',
      'the transition committed even though its acknowledgement was lost');
    const childStatus = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM speech_cleanup_children').get().status);
    assert.equal(childStatus, 'released');
    await assert.rejects(f.runtime.refreshHeldSpeechCleanupAfterClose(f.admission, 1), /cleanup_refresh_unavailable/);
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.transcription.cleanupLeases.at(-1).outcome, 'released');
    assert.equal(await f.runtime.refreshHeldSpeechCleanupAfterClose(f.admission, 0), 1,
      'explicit refresh adopts and acknowledges the exact committed cleanup receipt while admission stays closed');
    assert.equal(f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.transcription.cleanupLeases.at(-1).outcome, 'released');
    await f.runtime.closeAfterDrain();
    assert.equal(f.disposedSpeech(), 1, 'disposal proceeds only after the exact transition is acknowledged');
  } finally {
    f.kernel.close();
    removeFixture(f);
  }
});

test('a failed terminal transcription checkpoint still marks its exact cleanup child after the parent fails', async () => {
  const f = fixture({ transcribe: async (_note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId) => {
    const prepared = speechPrepared(leaseId);
    await onPrepared(prepared);
    await onAttempt(prepared);
    beforeDispatch(prepared);
    throw new Error('synthetic dispatched transcription failure');
  } });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const created = await executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.create', '{"transcript":"voice"}',
      (controller) => controller.saveNote({ transcript: 'voice', audioUri: 'file:///private/voice.m4a', durationSeconds: 1 }),
      (note) => ({ kind: 'note.created', noteId: note.id }));
    const note = created.result;
    await executeAtCurrent(f.runtime, f.kernel, f.admission, 'settings.update', '{"speechEnabled":true}',
      (controller) => controller.saveSettings({ speechEnabled: true, speechEndpoint: 'https://speech.cognitiveservices.azure.com' }),
      () => ({ kind: 'settings.updated' }));
    const current = f.kernel.getOwnedIdentity(f.runtimeSession);
    await f.kernel.withTrustedDatabaseTransaction((db) => db.exec(`
      CREATE TRIGGER reject_terminal_transcription BEFORE UPDATE ON workspaces
      WHEN instr(NEW.snapshot_json, '"outcome":"unknown"') > 0
      BEGIN SELECT RAISE(ABORT, 'synthetic terminal transcription checkpoint failure'); END;
    `));
    await assert.rejects(executeAtCurrent(f.runtime, f.kernel, f.admission, 'notes.transcribe', JSON.stringify({ noteId: note.id }),
      (controller) => controller.transcribeNote(note.id, { expectedRevision: note.revision }),
      (updated) => ({ kind: 'transcription.finished', noteId: updated.id })), /Transcription status could not be saved/);
    assert.ok(f.kernel.getOwnedIdentity(f.runtimeSession).revision > current.revision,
      'the exact cleanup transition commits after the terminal parent checkpoint fails');
    const lease = f.kernel.getOwnedSnapshot(f.runtimeSession).snapshot.transcription.cleanupLeases.at(-1);
    assert.equal(lease.outcome, 'released');
    const child = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status FROM speech_cleanup_children').get());
    assert.equal(child.status, 'released');
    assert.equal(f.runtime.inspectCommandReceipt(f.admission, f.kernel.withTrustedDatabaseTransaction((db) =>
      db.prepare("SELECT idempotency_key AS idempotencyKey FROM async_command_journal WHERE command_kind='notes.transcribe'").get().idempotencyKey)).status,
    'inspect_required', 'the failed parent remains inspect-only while cleanup reaches its exact terminal state');
    await f.kernel.withTrustedDatabaseTransaction((db) => db.exec('DROP TRIGGER reject_terminal_transcription'));
    await f.runtime.refreshSnapshot(f.admission);
    assert.equal(initial.privacyEpoch, 0);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
});

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

    const reopened = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot,
      applicationOwnership: f.applicationOwnership });
    try { assert.equal(reopened.getOwnedSnapshot(f.runtimeSession).snapshot.notes[0].transcript, 'durable through Node runtime'); }
    finally { reopened.close(); }
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
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
  } finally { gate.resolve(); await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
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
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
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
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
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
  } finally { failPostSave = false; await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
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
  } finally { release.resolve(); await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
});

test('stopAdmission closes only new work while closeAfterDrain still waits for admitted work', async () => {
  const gate = deferred();
  const entered = deferred();
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = f.runtime.executeCommand({ ...f.admission, expectedRevision: initial.revision,
      expectedPrivacyEpoch: initial.privacyEpoch, idempotencyKey: randomUUID(), kind: 'test.owned', canonicalBody: '{"run":true}' },
    async (controller) => {
      entered.resolve();
      await gate.promise;
      return controller.saveNote({ transcript: 'already admitted work drains', capturedAt: '2026-10-14T00:00:00.000Z' });
    }, (note) => ({ kind: 'note.saved', noteId: note.id }));
    await entered.promise;
    f.runtime.stopAdmission();
    assert.throws(() => f.runtime.getSnapshot(f.admission), /closing/);
    const closing = f.runtime.closeAfterDrain();
    assert.equal(f.disposedSpeech(), 0);
    gate.resolve();
    const result = await command;
    await closing;
    assert.equal(result.snapshot.state.notes[0].transcript, 'already admitted work drains');
    assert.equal(f.disposedSpeech(), 1);
  } finally { gate.resolve(); await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
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
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
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
  } finally { await f.runtime.closeAfterDrain().catch(() => undefined); f.kernel.close(); removeFixture(f); }
});

test('runtime port factory is shared within an epoch and replaces only the old epoch ports', async () => {
  const f = fixture();
  try {
    let runtimeSession = f.runtimeSession;
    const made = [];
    let unattachedCleanups = 0;
    const { providers: _providers, integration: _integration, mediaResolver: _mediaResolver,
      responseLifetimeOwner: _responseLifetimeOwner, ...base } = f.ports;
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
        responseLifetimeOwner: f.ports.responseLifetimeOwner,
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
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
});

test('runtime rejects missing, mixed, and malformed per-epoch port configuration before controller construction', async () => {
  const f = fixture();
  try {
    const { providers, integration, mediaResolver, responseLifetimeOwner: _responseLifetimeOwner, ...base } = f.ports;
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
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
});

test('a controller whose attachment hook fails is retained through exact controller teardown', async () => {
  const f = fixture();
  try {
    let unattachedCleanupCalls = 0;
    const { providers, integration, responseLifetimeOwner, ...base } = f.ports;
    const runtime = new OwnedWorkspaceRuntime({ ...base, workspacePortsFor() {
      return { providers, integration, responseLifetimeOwner,
        attachController() { throw new Error('synthetic controller attach failure'); },
        disposeUnattached() { unattachedCleanupCalls += 1; } };
    } });

    await assert.rejects(runtime.getSnapshot(f.admission), /synthetic controller attach failure/);
    assert.equal(f.disposedSpeech(), 1, 'the constructed controller disposes the resources it already owns');
    assert.equal(unattachedCleanupCalls, 0, 'factory-only cleanup is not run after controller ownership transferred');
    await runtime.closeAfterDrain();
    assert.equal(f.disposedSpeech(), 1, 'failed construction cleanup does not leave a controller for later duplicate disposal');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
});

test('failed unattached-port cleanup fences epoch replacement until the caller explicitly retries the exact held epoch', async () => {
  const f = fixture();
  try {
    let runtimeSession = f.runtimeSession;
    let factoryCalls = 0;
    let cleanupCalls = 0;
    const { providers, integration, responseLifetimeOwner: _responseLifetimeOwner, ...base } = f.ports;
    const runtime = new OwnedWorkspaceRuntime({ ...base, runtimeSessionFor: () => runtimeSession,
      workspacePortsFor() {
        factoryCalls += 1;
        if (factoryCalls === 1) return { providers: null, integration, disposeUnattached() {
          cleanupCalls += 1;
          if (cleanupCalls === 1) throw new Error('synthetic unattached cleanup failure');
        } };
        return { providers, integration, responseLifetimeOwner: f.ports.responseLifetimeOwner, disposeUnattached() {} };
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
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); removeFixture(f); }
});

test('completed erase receipt never unfences ordinary reads until the exact drained hold is explicitly released', async () => {
  const commandId = randomUUID();
  const f = fixture({ isWorkspaceEraseComplete: (_workspaceId, _ownerId, completedCommandId) => completedCommandId === commandId });
  try {
    await f.runtime.getSnapshot(f.admission);
    const hold = await f.runtime.reserveWorkspaceForErase(f.admission, commandId);
    assert.throws(() => f.runtime.getSnapshot(f.admission), /workspace_erase_in_progress/);
    assert.throws(() => f.runtime.inspectCommandReceipt(f.admission, randomUUID()), /workspace_erase_in_progress/);
    hold.releaseAfterCleanup();
    assert.equal((await f.runtime.getSnapshot(f.admission)).privacyEpoch, 0);
  } finally {
    await f.runtime.closeAfterDrain();
    removeFixture(f);
  }
});
