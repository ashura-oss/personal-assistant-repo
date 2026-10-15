import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { CommandJournal } from '../dist/workspaceRuntime.js';
import { OwnedWorkspaceRuntime } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { PrivateAudioRepository } from '../dist/privateAudioRepository.js';
import { RUNTIME_ACTOR_EXPIRES_AT } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import {
  canonicalWorkspaceCommand,
  dispatchWorkspaceCommand,
  inspectWorkspaceCommand,
  parseWorkspaceCommandEnvelope,
} from '../dist/workspaceCommands.node.mjs';

function fixture({ providerBatchClient, withAudio = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-workspace-commands-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const state = createInitialWorkspaceState(randomUUID);
  if (providerBatchClient) {
    state.settings.mode = 'provider';
    state.settings.llmProvider = 'openrouter';
    state.settings.openRouterModel = 'openai/gpt-6-luna:batch';
  }
  state.tasks.push({ id: 'legacy task: 1', title: 'A task', body: '', status: 'open', createdAt: '2026-10-14T00:00:00.000Z',
    importOrigin: { kind: 'backup_import', archiveId: randomUUID(), sourceTaskId: 'legacy task: 1' } });
  const workspace = kernel.createWorkspace(ownerId, state);
  const admissionSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const runtimeSession = kernel.createSession(workspace.workspaceId, ownerId, RUNTIME_ACTOR_EXPIRES_AT);
  const unavailable = async () => 'unavailable';
  let attachedSnapshot;
  let failNextWorkspaceCommitAck = false;
  const audioRepository = withAudio ? new PrivateAudioRepository({ kernel, actorSessionToken: runtimeSession,
    privateRoot: join(directory, 'private-audio'), processId: randomUUID(),
    resolveAttachedMedia: ({ noteId, noteRevision }) => {
      const note = attachedSnapshot?.notes.find((item) => item.id === noteId && item.revision === noteRevision);
      const mediaId = note?.audio?.available ? note.audio.mediaId : undefined;
      if (!mediaId) return undefined;
      const record = audioRepository?.getRecord(mediaId);
      return record?.status === 'ready' ? { mediaId, noteId, noteRevision, sha256: record.sha256, byteLength: record.byteLength } : undefined;
    } }) : undefined;
  const pendingCapture = audioRepository ? Object.freeze({
    async getStatus() { return Object.freeze({ kind: 'empty' }); },
    async inspect() { return Object.freeze({ kind: 'empty' }); },
    async export() { throw new Error('unsupported'); },
    async discard() { throw new Error('unsupported'); },
    async retryPendingCaptureSourceRelease() { return Object.freeze({ kind: 'empty' }); },
    async readForAdoption({ id, revision }) {
      const uploaded = audioRepository.readCaptureForAdoption(id, revision);
      if (!uploaded.media) throw new Error('capture media missing');
      return Object.freeze({ kind: 'server', uri: uploaded.media.mediaId, capture: Object.freeze({
        id, revision, capturedAt: uploaded.capture.capturedAt, captureTimeZone: uploaded.capture.timeZone,
        durationSeconds: uploaded.media.durationSeconds, media: Object.freeze({
          uploadId: uploaded.uploadId, mediaId: uploaded.media.mediaId.slice('still-media:'.length),
          sha256: uploaded.media.sha256, byteLength: uploaded.media.byteLength,
          format: uploaded.media.format, mimeType: uploaded.media.mimeType,
        }),
      }) });
    },
    async readConsumedEvidence(id) { return audioRepository.readConsumedCaptureEvidence(id); },
  }) : undefined;
  const runtime = new OwnedWorkspaceRuntime({ kernel, runtimeSessionFor: () => runtimeSession,
    afterWorkspaceCommitForTesting() {
      if (failNextWorkspaceCommitAck) { failNextWorkspaceCommitAck = false; throw new Error('simulated post-commit acknowledgement loss'); }
    },
    ...(audioRepository ? { mediaResolver: { resolveMediaId(_note, uri) {
      const match = /^still-media:([0-9a-f-]{36})$/i.exec(uri);
      if (!match) return undefined;
      return audioRepository.getRecord(match[1]).status === 'ready' ? match[1] : undefined;
    } } } : {}),
    crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    providers: { speech: { async transcribe() { throw new Error('provider must not run'); }, async releaseUploadLease() {}, disposeMemory() {} },
      openAi: { async prepare() { throw new Error('provider must not run'); }, async analyze() { throw new Error('provider must not run'); }, async generateReply() { throw new Error('provider must not run'); } } },
    integration: {
      reminderBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async listPending() { return []; }, async schedule() {}, async cancel() {}, async cancelLegacy() {}, async installForegroundHandler() {} },
      mailAlertBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; } },
      deviceCalendarBackend: { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
        async listCalendars() { return []; }, async getCalendar() { return undefined; }, async readEvents() { return []; },
        async createApprovedEvent() { throw new Error('unsupported'); }, async lookupRecord() { return undefined; } },
      async writeDocument() {}, async removeAudio() {},
      async loadRecordingRecovery() { return { async pickAndStage() { return null; }, async inspect() { throw new Error('unsupported'); }, async remove() {} }; },
      bindRecordingRecovery(service) { return service; },
      ...(providerBatchClient ? { openRouterBatchClient: providerBatchClient } : {}),
    }, ...(pendingCapture ? { pendingCapture } : {}) });
  const admission = { sessionToken: admissionSession, assertCurrent() { kernel.getOwnedIdentity(admissionSession); } };
  return { directory, kernel, ownerId, workspace, admissionSession, runtimeSession, runtime, admission, audioRepository,
    setAttachedSnapshot(value) { attachedSnapshot = value; }, loseNextWorkspaceCommitAck() { failNextWorkspaceCommitAck = true; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function envelope(command, expectedRevision = 0, expectedPrivacyEpoch = 0, commandId = randomUUID()) {
  return { schemaVersion: 1, commandId, expectedRevision, expectedPrivacyEpoch, command };
}

function wavFixture() {
  const sampleRate = 8000;
  const data = Buffer.alloc(1600, 128);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}
async function* byteChunks(bytes) { yield bytes.subarray(0, 17); yield bytes.subarray(17, 900); yield bytes.subarray(900); }

test('shared command envelope enforces exact keys, UUIDs, revision fences, and physical text bounds', () => {
  const valid = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' });
  assert.deepEqual(parseWorkspaceCommandEnvelope(valid), valid);
  const reordered = { command: valid.command, expectedPrivacyEpoch: 0, commandId: valid.commandId,
    schemaVersion: 1, expectedRevision: 0 };
  assert.equal(canonicalWorkspaceCommand(valid), canonicalWorkspaceCommand(reordered));
  assert.throws(() => parseWorkspaceCommandEnvelope({ ...valid, extra: true }), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope({ ...valid, command: { ...valid.command, extra: 'ignored?' } }), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope({ ...valid, commandId: 'not-a-uuid' }), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope({ ...valid, expectedRevision: -1 }), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'assistant.batch.submitNote', noteId: 'note-1', intent: ['assist'] })), /workspace_command_invalid/,
    'intent must be one of the exact string enum values');
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'chat.submit', conversationId: 'legacy-conversation', text: 'hello' })), /workspace_command_invalid/,
    'chat conversations use UUID identifiers');
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'assistant.batch.check', jobId: 'legacy-job' })), /workspace_command_invalid/,
    'Batch jobs use UUID identifiers');
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'chat.create', title: 'x'.repeat(5000) })), /workspace_command_invalid/);
  let getterRuns = 0;
  const accessorCommand = { kind: 'chat.create' };
  Object.defineProperty(accessorCommand, 'title', { enumerable: true, get() { getterRuns += 1; return 'unsafe'; } });
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope(accessorCommand)), /workspace_command_invalid/);
  assert.equal(getterRuns, 0, 'accessor payloads are rejected without executing caller code');
  const accessorDiscriminator = {};
  Object.defineProperty(accessorDiscriminator, 'kind', { enumerable: true, get() { getterRuns += 1; return 'chat.create'; } });
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope(accessorDiscriminator)), /workspace_command_invalid/);
  assert.equal(getterRuns, 0, 'the command discriminator is never read before payload descriptors are checked');
  assert.equal(parseWorkspaceCommandEnvelope(envelope({ kind: 'chat.create', title: 'x'.repeat(4096) })).command.title.length, 4096,
    'the maximum allowed title remains below the independent 16 KiB envelope physical bound');
  const largeTextCommand = envelope({ kind: 'notes.save', transcript: '😀\\\n漢'.repeat(70_000) });
  const parsedLargeText = parseWorkspaceCommandEnvelope(largeTextCommand);
  assert.equal(parsedLargeText.command.transcript, largeTextCommand.command.transcript);
  assert.ok(new TextEncoder().encode(canonicalWorkspaceCommand(parsedLargeText)).length > 16 * 1024);
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'notes.save', transcript: '雪'.repeat(350_000) })), /workspace_command_invalid/);
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'chat.create', title: 'x'.repeat(20_000) })), /workspace_command_invalid/);
  const emptyTextEnvelope = envelope({ kind: 'notes.save', transcript: '' });
  const fixedEnvelopeBytes = new TextEncoder().encode(JSON.stringify(emptyTextEnvelope)).length;
  const boundaryText = 'a'.repeat(1024 * 1024 - fixedEnvelopeBytes);
  assert.equal(parseWorkspaceCommandEnvelope(envelope({ kind: 'notes.save', transcript: boundaryText })).command.transcript.length, boundaryText.length,
    'the exact 1 MiB JSON envelope boundary is accepted');
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'notes.save', transcript: `${boundaryText}a` })), /workspace_command_invalid/,
    'one additional encoded byte is rejected');
  const escapedBoundaryText = `${'a'.repeat(1024 * 1024 - fixedEnvelopeBytes - 2)}\n`;
  assert.equal(new TextEncoder().encode(JSON.stringify(envelope({ kind: 'notes.save', transcript: escapedBoundaryText }))).length, 1024 * 1024);
  assert.equal(parseWorkspaceCommandEnvelope(envelope({ kind: 'notes.save', transcript: escapedBoundaryText })).command.transcript, escapedBoundaryText,
    'an escaped control character is counted by its JSON wire bytes at the exact boundary');
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'notes.save', transcript: `${escapedBoundaryText}a` })), /workspace_command_invalid/);
});

test('large escaped-Unicode note save dispatches through the actual controller once and returns a safe exact receipt', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const transcript = '😀\\\n漢'.repeat(70_000);
    const command = envelope({ kind: 'notes.save', transcript }, initial.revision, initial.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(first.status, 'finished');
    assert.equal(first.receipt.kind, 'notes.save');
    assert.ok(first.receipt.objectId);
    assert.equal(first.snapshot.state.notes.find((note) => note.id === first.receipt.objectId).transcript, transcript);
    assert.deepEqual(Object.keys(first.receipt).sort(), ['commandId', 'kind', 'objectId', 'schemaVersion']);

    const replay = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(replay.snapshot.state.notes.filter((note) => note.transcript === transcript).length, 1);
    assert.equal(replay.snapshot.state.activity.filter((item) => item.noteId === first.receipt.objectId && item.type === 'note_saved').length, 1,
      'the exact duplicate receipt avoids a second controller save');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('actual runtime adopts one ready upload atomically, recovers a lost checkpoint acknowledgement, and replays the exact receipt', async () => {
  const f = fixture({ withAudio: true });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const bytes = wavFixture();
    const uploadId = randomUUID();
    const captureId = randomUUID();
    const uploaded = await f.audioRepository.uploadCapture(byteChunks(bytes), { uploadId, captureId,
      capturedAt: '2026-10-15T00:00:00.000Z', timeZone: 'Asia/Singapore', mimeType: 'audio/wav', expectedByteLength: bytes.length });
    assert.equal(uploaded.status, 'ready');
    assert.equal(uploaded.media.byteLength, bytes.length);

    const command = envelope({ kind: 'notes.capture.adopt', captureId, captureRevision: uploaded.capture.revision },
      initial.revision, initial.privacyEpoch);
    f.loseNextWorkspaceCommitAck();
    const adopted = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(adopted.status, 'finished');
    assert.equal(adopted.receipt.kind, 'notes.capture.adopt');
    assert.equal(adopted.receipt.objectId, captureId);
    assert.equal(adopted.receipt.captureId, captureId);
    assert.equal(adopted.receipt.captureRevision, uploaded.capture.revision);
    const saved = adopted.snapshot.state.notes.filter((note) => note.id === captureId);
    assert.equal(saved.length, 1, 'the real AppController stored one attached note');
    assert.equal(saved[0].audio.available, true);
    assert.equal(saved[0].audio.mediaId, uploaded.media.mediaId.slice('still-media:'.length));
    assert.equal(saved[0].revision, 1);
    f.setAttachedSnapshot(adopted.snapshot.state);

    const reloaded = await f.runtime.refreshSnapshot(f.admission);
    assert.ok(reloaded.revision >= adopted.snapshot.revision);
    assert.equal(reloaded.state.notes.filter((note) => note.id === captureId).length, 1);
    assert.equal(reloaded.state.notes.find((note) => note.id === captureId).audio.mediaId,
      uploaded.media.mediaId.slice('still-media:'.length), 'reload preserves only the safe attached media ID');

    const attached = await f.audioRepository.openAttachedMedia({ noteId: captureId, noteRevision: 1 });
    const parts = [];
    for await (const part of attached.body) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), bytes, 'the adopted note resolves only its verified original bytes');
    assert.equal(f.audioRepository.inspectCaptureUpload(uploadId).status, 'consumed');

    const replay = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.deepEqual(replay.receipt, adopted.receipt);
    assert.equal(replay.snapshot.state.notes.filter((note) => note.id === captureId).length, 1);
    assert.equal(f.audioRepository.inspectCaptureUpload(uploadId).status, 'consumed');
    const inspection = inspectWorkspaceCommand(f.runtime, f.admission, command.commandId);
    assert.deepEqual(inspection.receipt, adopted.receipt);
    assert.equal(inspection.status, 'finished');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a duplicate note Batch command returns its exact receipt without a second provider submission', async () => {
  let providerSubmissions = 0;
  const providerBatch = { async submit(_input, onBeforeDispatch) {
    providerSubmissions += 1;
    await onBeforeDispatch();
    return { batchId: `fixture-batch-${providerSubmissions}` };
  }, async inspect() { throw new Error('The duplicate command must not inspect or submit again.'); } };
  const f = fixture({ providerBatchClient: providerBatch });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const saved = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'Prepare a short local summary.' }, initial.revision, initial.privacyEpoch));
    const noteId = saved.receipt.objectId;
    const command = envelope({ kind: 'assistant.batch.submitNote', noteId }, saved.snapshot.revision, saved.snapshot.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(first.status, 'finished');
    assert.equal(first.receipt.kind, 'assistant.batch.submitNote');
    assert.equal(first.receipt.objectId, noteId);
    assert.ok(first.receipt.jobId);
    assert.equal(providerSubmissions, 1);
    const replay = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(providerSubmissions, 1, 'the exact journal duplicate returns its receipt without repeating the paid provider POST');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('an invalid intent type is rejected before command admission or any provider submission', async () => {
  let providerSubmissions = 0;
  const f = fixture({ providerBatchClient: { async submit() { providerSubmissions += 1; throw new Error('must not submit'); } } });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const invalid = envelope({ kind: 'assistant.batch.submitNote', noteId: 'legacy-note', intent: ['assist'] }, initial.revision, initial.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, invalid), /workspace_command_invalid/);
    assert.equal(providerSubmissions, 0);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, invalid.commandId).status, 'unverified',
      'invalid input never creates a journal admission or a provider-visible job');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a paid Batch command admitted before browser revocation settles once and its later accounting remains inspectable', async () => {
  const enteredSubmit = deferred();
  const releaseSubmit = deferred();
  let providerSubmissions = 0;
  const providerBatch = {
    async submit(_input, onBeforeDispatch) {
      providerSubmissions += 1;
      await onBeforeDispatch();
      enteredSubmit.resolve();
      await releaseSubmit.promise;
      return { batchId: 'late-ack-batch' };
    },
    async inspect(batchId, _customId) {
      return { batchId, status: 'in_progress', endpoint: '/v1/chat/completions', model: 'openai/gpt-6-luna', completionWindow: '24h',
        total: 1, completed: 0, failed: 0, metadataValidation: 'valid', resultValidation: 'unavailable',
        usage: { cost: 0.0042, promptTokens: 31, completionTokens: 0, totalTokens: 31 } };
    },
  };
  const f = fixture({ providerBatchClient: providerBatch });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const saved = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'A saved note to submit once.' }, initial.revision, initial.privacyEpoch));
    const command = envelope({ kind: 'assistant.batch.submitNote', noteId: saved.receipt.objectId },
      saved.snapshot.revision, saved.snapshot.privacyEpoch);
    const ownedSubmit = dispatchWorkspaceCommand(f.runtime, f.admission, command);
    await enteredSubmit.promise;

    f.kernel.revokeSession(f.admissionSession);
    releaseSubmit.resolve();
    await assert.rejects(ownedSubmit, /session|ownership|current/i,
      'the revoked browser does not receive a late acknowledgement after the provider operation has already started');
    assert.equal(providerSubmissions, 1);

    const replacementSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    const replacementAdmission = { sessionToken: replacementSession, assertCurrent() { f.kernel.getOwnedIdentity(replacementSession); } };
    const snapshot = await f.runtime.refreshSnapshot(replacementAdmission);
    const receipt = inspectWorkspaceCommand(f.runtime, replacementAdmission, command.commandId);
    assert.equal(receipt.status, 'finished', 'the private owner records the already-admitted command outcome');
    assert.match(receipt.receipt.jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(Object.hasOwn(receipt, 'snapshot'), false, 'receipt inspection exposes no workspace snapshot or private provider payload');

    const jobId = snapshot.state.assistantBatchJobs.find((job) => job.noteId === saved.receipt.objectId).id;
    const replay = await dispatchWorkspaceCommand(f.runtime, replacementAdmission, command);
    assert.equal(replay.receipt.jobId, jobId);
    assert.equal(providerSubmissions, 1, 'replaying the saved command under the replacement browser never repeats the provider POST');

    const checked = await dispatchWorkspaceCommand(f.runtime, replacementAdmission,
      envelope({ kind: 'assistant.batch.check', jobId }, replay.snapshot.revision, replay.snapshot.privacyEpoch));
    const settledJob = checked.snapshot.state.assistantBatchJobs.find((job) => job.id === jobId);
    assert.equal(settledJob.status, 'processing');
    assert.equal(settledJob.providerReportedCostUsd, 0.0042, 'later provider-reported accounting is retained after browser revocation');
    assert.equal(settledJob.unknownCharge, false);
    assert.equal(providerSubmissions, 1);
  } finally {
    releaseSubmit.resolve();
    await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('the real gateway completes chat create, submit, check, and refinement with UUID-bound receipts', async () => {
  const outputs = new Map();
  let providerSubmissions = 0;
  const providerBatch = {
    async submit(input, onBeforeDispatch) {
      providerSubmissions += 1;
      await onBeforeDispatch();
      outputs.set(input.operationId, { summary: 'A concise local Batch result.', answer: 'Start with the most urgent task.',
        decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] });
      return { batchId: `chat-batch-${providerSubmissions}` };
    },
    async inspect(batchId, customId) {
      return { batchId, status: 'completed', endpoint: '/v1/chat/completions', model: 'openai/gpt-6-luna', completionWindow: '24h',
        total: 1, completed: 1, failed: 0, metadataValidation: 'valid', resultValidation: 'valid',
        usage: { cost: 0.001, promptTokens: 20, completionTokens: 8, totalTokens: 28 },
        result: { customId, statusCode: 200, finishReason: 'stop', responseBody: { model: 'openai/gpt-6-luna',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(outputs.get(customId)) } }] } } };
    },
  };
  const f = fixture({ providerBatchClient: providerBatch });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const created = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'chat.create', title: 'Gateway chat' }, initial.revision, initial.privacyEpoch));
    const conversationId = created.receipt.objectId;
    assert.match(conversationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const submitted = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'chat.submit', conversationId, text: 'What should I prioritize today?' }, created.snapshot.revision, created.snapshot.privacyEpoch));
    assert.equal(submitted.receipt.kind, 'chat.submit');
    assert.equal(submitted.receipt.objectId, conversationId);
    assert.match(submitted.receipt.turnId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(submitted.receipt.jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const checked = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'assistant.batch.check', jobId: submitted.receipt.jobId }, submitted.snapshot.revision, submitted.snapshot.privacyEpoch));
    assert.deepEqual(checked.receipt, { schemaVersion: 1, commandId: checked.commandId, kind: 'assistant.batch.check', objectId: submitted.receipt.jobId });
    const refined = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'chat.refine', conversationId, parentTurnId: submitted.receipt.turnId, effort: 'high' }, checked.snapshot.revision, checked.snapshot.privacyEpoch));
    assert.equal(refined.receipt.kind, 'chat.refine');
    assert.equal(refined.receipt.objectId, conversationId);
    assert.equal(refined.receipt.parentTurnId, submitted.receipt.turnId);
    assert.match(refined.receipt.turnId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(refined.receipt.jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(providerSubmissions, 2, 'one submit and one refinement reached the injected Batch provider');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('explicit dispatcher calls only the task/chat allowlist and returns safe durable receipts', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' }, initial.revision, initial.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.deepEqual(Object.keys(first).sort(), ['commandId', 'receipt', 'schemaVersion', 'snapshot', 'status']);
    assert.deepEqual(first.receipt, { schemaVersion: 1, commandId: command.commandId, kind: 'tasks.complete', objectId: 'legacy task: 1' });
    assert.equal(first.status, 'finished');
    assert.equal(first.snapshot.state.tasks[0].status, 'completed');
    assert.equal('ticket' in first, false);
    assert.equal('result' in first, false);

    const replay = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(replay.status, 'finished');
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(replay.snapshot.revision, first.snapshot.revision);
    assert.equal(replay.snapshot.state.activity.filter((item) => item.message === 'Task completed: A task.').length, 1,
      'finished duplicate returns the original receipt without invoking the controller again');

    const chatCommand = envelope({ kind: 'chat.create', title: 'No model call' }, replay.snapshot.revision, replay.snapshot.privacyEpoch);
    const chat = await dispatchWorkspaceCommand(f.runtime, f.admission, chatCommand);
    assert.equal(chat.status, 'finished');
    assert.equal(chat.receipt.kind, 'chat.create');
    assert.ok(chat.snapshot.state.assistantChatConversations.some((item) => item.id === chat.receipt.objectId));
    const changed = { ...command, command: { kind: 'tasks.reopen', taskId: 'legacy task: 1' } };
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, changed), /already bound to different/);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a finished journal receipt with the right command ID but a different allowed kind is rejected without replay', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' }, initial.revision, initial.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(first.status, 'finished');

    const corruptedReceipt = { ...first.receipt, kind: 'tasks.reopen' };
    const db = new Database(join(f.directory, 'workspace.sqlite'));
    try {
      db.prepare(`UPDATE async_command_journal SET receipt_json=? WHERE workspace_id=? AND idempotency_key=?`)
        .run(JSON.stringify(corruptedReceipt), f.workspace.workspaceId, command.commandId);
    } finally { db.close(); }

    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, command), /workspace_command_receipt_invalid/);
    assert.throws(() => inspectWorkspaceCommand(f.runtime, f.admission, command.commandId), /workspace_command_receipt_invalid/,
      'inspection also binds the stored receipt to its trusted journal kind');
    const snapshot = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(snapshot.state.activity.filter((item) => item.message === 'Task completed: A task.').length, 1,
      'the controller operation remains applied exactly once despite the invalid duplicate receipt');
    assert.equal(snapshot.state.tasks[0].status, 'completed');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('a task receipt with the right command ID and kind but a different task ID is rejected without replay', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' }, initial.revision, initial.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(first.status, 'finished');

    const corruptedReceipt = { ...first.receipt, objectId: 'another task' };
    const db = new Database(join(f.directory, 'workspace.sqlite'));
    try {
      db.prepare(`UPDATE async_command_journal SET receipt_json=? WHERE workspace_id=? AND idempotency_key=?`)
        .run(JSON.stringify(corruptedReceipt), f.workspace.workspaceId, command.commandId);
    } finally { db.close(); }

    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, command), /workspace_command_receipt_invalid/);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, command.commandId).receipt.objectId, 'another task',
      'the invalid durable receipt remains inspectable as invalid source data, not silently repaired');
    const snapshot = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(snapshot.state.activity.filter((item) => item.message === 'Task completed: A task.').length, 1,
      'the original task operation was not replayed');
    assert.equal(snapshot.state.tasks[0].status, 'completed');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('read-only receipt inspection distinguishes missing, pending, finished and unknown outcomes during refresh-required state', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const journal = new CommandJournal(f.kernel);
    const finished = envelope({ kind: 'chat.create', title: 'finished' }, initial.revision, initial.privacyEpoch);
    const created = await dispatchWorkspaceCommand(f.runtime, f.admission, finished);
    const entered = deferred();
    const hold = deferred();
    const busyCommandId = randomUUID();
    const busyCommand = f.runtime.executeCommand({ ...f.admission, expectedRevision: created.snapshot.revision,
      expectedPrivacyEpoch: created.snapshot.privacyEpoch, idempotencyKey: busyCommandId, kind: 'test.wait', canonicalBody: '{}' }, async () => {
      entered.resolve();
      await hold.promise;
      return 'done';
    }, () => ({ kind: 'test.wait' }));
    await entered.promise;
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, finished.commandId).status, 'finished',
      'read-only receipt inspection remains available while another owned command is busy');
    assert.ok(f.runtime.listCommandHistory(f.admission).entries.some((entry) => entry.commandId === finished.commandId),
      'history reads bypass busy controller state');
    assert.throws(() => inspectWorkspaceCommand(f.runtime, f.admission, busyCommandId), /workspace_command_unexposed/);
    hold.resolve();
    await busyCommand;

    const pending = envelope({ kind: 'tasks.reopen', taskId: 'legacy task: 1' }, created.snapshot.revision, created.snapshot.privacyEpoch);
    journal.admit({ admissionSessionToken: f.admissionSession, expectedRevision: created.snapshot.revision,
      expectedPrivacyEpoch: created.snapshot.privacyEpoch, idempotencyKey: pending.commandId, kind: pending.command.kind,
      canonicalBody: canonicalWorkspaceCommand(pending) });
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, pending.commandId).status, 'claimed');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, randomUUID()).status, 'unverified');

    let sideEffects = 0;
    const uncertain = envelope({ kind: 'tasks.complete', taskId: 'legacy task: 1' }, created.snapshot.revision, created.snapshot.privacyEpoch);
    await assert.rejects(f.runtime.executeCommand({ ...f.admission, expectedRevision: uncertain.expectedRevision,
      expectedPrivacyEpoch: uncertain.expectedPrivacyEpoch, idempotencyKey: uncertain.commandId, kind: uncertain.command.kind,
      canonicalBody: canonicalWorkspaceCommand(uncertain) }, async (controller) => {
      sideEffects += 1;
      return controller.completeTask('legacy task: 1');
    }, () => { throw new Error('lost receipt acknowledgement'); }), /lost receipt acknowledgement/);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, finished.commandId).status, 'finished');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, finished.commandId).snapshot, undefined,
      'receipt inspection returns no cached or unfenced workspace snapshot');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, uncertain.commandId).status, 'inspect_required');
    assert.ok(f.runtime.listCommandHistory(f.admission).entries.some((entry) => entry.commandId === uncertain.commandId),
      'history reads remain available while the loaded snapshot requires refresh');
    assert.equal(f.runtime.listCommandHistory(f.admission).entries.some((entry) => entry.kind === 'test.wait'), false,
      'internal journal kinds are never projected');
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, randomUUID()).status, 'unverified');
    await assert.rejects(f.runtime.getSnapshot(f.admission), /workspace_refresh_required/);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, uncertain), /workspace_refresh_required/);
    assert.equal(sideEffects, 1, 'inspection during uncertainty never replays an operation');
    const refreshed = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(refreshed.revision, f.kernel.getOwnedIdentity(f.admissionSession).revision);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('receipt inspection still checks owner, privacy epoch, and caller authorization', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'chat.create' }, initial.revision, initial.privacyEpoch);
    await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    const otherOwnerId = randomUUID();
    const otherOwner = f.kernel.createWorkspace(otherOwnerId, createInitialWorkspaceState(randomUUID));
    const otherSession = f.kernel.createSession(otherOwner.workspaceId, otherOwnerId, Date.now() + 60 * 60_000);
    assert.equal(inspectWorkspaceCommand(f.runtime, { sessionToken: otherSession,
      assertCurrent() { f.kernel.getOwnedIdentity(otherSession); } }, command.commandId).status, 'unverified',
    'a command in another owner workspace is indistinguishable from an unverified ID');
    let allowed = true;
    assert.equal(inspectWorkspaceCommand(f.runtime, { ...f.admission, assertCurrent() {
      if (!allowed) throw new Error('inspection authorization revoked');
      f.kernel.getOwnedIdentity(f.admissionSession);
    } }, randomUUID()).status, 'unverified');
    allowed = false;
    assert.throws(() => inspectWorkspaceCommand(f.runtime, { ...f.admission, assertCurrent() {
      if (!allowed) throw new Error('inspection authorization revoked');
      f.kernel.getOwnedIdentity(f.admissionSession);
    } }, command.commandId), /inspection authorization revoked/);
    f.kernel.runLocalCommand(f.runtimeSession, { expectedRevision: f.kernel.getOwnedIdentity(f.runtimeSession).revision,
      expectedPrivacyEpoch: 0, idempotencyKey: randomUUID(), type: 'workspace.erase', canonicalRequest: '{}' }, () => ({
      snapshot: createInitialWorkspaceState(randomUUID), receipt: { kind: 'erase' }, privacyEpoch: 1,
    }));
    const newSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    assert.throws(() => inspectWorkspaceCommand(f.runtime, { sessionToken: newSession,
      assertCurrent() { f.kernel.getOwnedIdentity(newSession); } }, command.commandId), /another workspace or privacy epoch/);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
