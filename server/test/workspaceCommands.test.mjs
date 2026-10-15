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
import { OwnedWorkspaceRuntime, SpeechTranscriptionError } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { PrivateAudioRepository } from '../dist/privateAudioRepository.js';
import { RUNTIME_ACTOR_EXPIRES_AT } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import {
  canonicalWorkspaceCommand,
  dispatchWorkspaceCommand,
  inspectWorkspaceCommand,
  parseWorkspaceCommandEnvelope,
  parseWorkspaceCommandReceipt,
} from '../dist/workspaceCommands.node.mjs';

function fixture({ providerBatchClient, withAudio = false, speechClient, speechEnabled = false, withSpeechCleanup = false,
  initialNoteId, initialKnowledge, initialDocuments = [], writeDocument, captureController } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-workspace-commands-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const state = createInitialWorkspaceState(randomUUID);
  if (speechEnabled) {
    state.settings.speechEnabled = true;
    state.settings.speechEndpoint = 'https://example.cognitiveservices.azure.com';
  }
  if (initialNoteId) state.notes.push({ id: initialNoteId, title: 'Imported audio note', transcript: 'Original transcript.',
    audioUri: 'file:///private/imported.wav', durationSeconds: 2, createdAt: '2026-10-15T00:00:00.000Z',
    status: 'recorded', revision: 1 });
  if (initialKnowledge) state.knowledge = structuredClone(initialKnowledge);
  state.documents.push(...structuredClone(initialDocuments));
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
  const runtimeSessions = new Map([[workspace.workspaceId, runtimeSession]]);
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
  const runtime = new OwnedWorkspaceRuntime({ kernel, runtimeSessionFor: (identity) => runtimeSessions.get(identity.workspaceId) ?? runtimeSession,
    afterWorkspaceCommitForTesting() {
      if (failNextWorkspaceCommitAck) { failNextWorkspaceCommitAck = false; throw new Error('simulated post-commit acknowledgement loss'); }
    },
    ...(audioRepository ? { mediaResolver: { resolveMediaId(_note, uri) {
      const match = /^still-media:([0-9a-f-]{36})$/i.exec(uri);
      if (!match) return undefined;
      return audioRepository.getRecord(match[1]).status === 'ready' ? match[1] : undefined;
    } } } : {}),
    crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    providers: { speech: speechClient ?? { async transcribe() { throw new Error('provider must not run'); }, async releaseUploadLease() {}, disposeMemory() {} },
      openAi: { async prepare() { throw new Error('provider must not run'); }, async analyze() { throw new Error('provider must not run'); }, async generateReply() { throw new Error('provider must not run'); } } },
    ...(withSpeechCleanup ? { responseLifetimeOwner: responseLifetimeOwner() } : {}),
    integration: {
      reminderBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async listPending() { return []; }, async schedule() {}, async cancel() {}, async cancelLegacy() {}, async installForegroundHandler() {} },
      mailAlertBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; } },
      deviceCalendarBackend: { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
        async listCalendars() { return []; }, async getCalendar() { return undefined; }, async readEvents() { return []; },
        async createApprovedEvent() { throw new Error('unsupported'); }, async lookupRecord() { return undefined; } },
      async writeDocument(path, content) { await writeDocument?.(path, content); }, async removeAudio() {},
      async loadRecordingRecovery() { return { async pickAndStage() { return null; }, async inspect() { throw new Error('unsupported'); }, async remove() {} }; },
      bindRecordingRecovery(service) { return service; },
      ...(providerBatchClient ? { openRouterBatchClient: providerBatchClient } : {}),
    }, ...(pendingCapture ? { pendingCapture } : {}) });
  if (captureController) {
    const executeCommand = runtime.executeCommand.bind(runtime);
    runtime.executeCommand = (input, operation, projectReceipt) => executeCommand(input, (controller, identity) => {
      captureController(controller);
      return operation(controller, identity);
    }, projectReceipt);
  }
  const admission = { sessionToken: admissionSession, assertCurrent() { kernel.getOwnedIdentity(admissionSession); } };
  return { directory, kernel, ownerId, workspace, admissionSession, runtimeSession, runtimeSessions, runtime, admission, audioRepository,
    setAttachedSnapshot(value) { attachedSnapshot = value; }, loseNextWorkspaceCommitAck() { failNextWorkspaceCommitAck = true; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function responseLifetimeOwner() {
  return { withResponseLifetimeFor() { throw new Error('unused in fake speech test'); }, stopAdmission() {}, async drain() {},
    async retryCleanup() {}, getPending() { return []; }, subscribe() { return () => {}; } };
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

test('settings.update parser exposes only a nonempty closed settings patch and normalizes speech endpoints', () => {
  const parsed = parseWorkspaceCommandEnvelope(envelope({ kind: 'settings.update', patch: {
    speechEndpoint: 'https://Speech.Example.cognitiveservices.azure.com/path', timezone: 'Asia/Singapore', maxAudioSeconds: 600,
  } }));
  assert.deepEqual(parsed.command.patch, { speechEndpoint: 'https://speech.example.cognitiveservices.azure.com', timezone: 'Asia/Singapore', maxAudioSeconds: 600 });
  assert.deepEqual(parseWorkspaceCommandEnvelope(envelope({ kind: 'settings.update', patch: { speechEndpoint: '' } })).command.patch,
    { speechEndpoint: '' }, 'an empty endpoint explicitly clears the configured value');
  const invalidPatches = [
    {}, { password: 'secret' }, { monthlyBudgetUsd: 0 }, { maxContextTokens: 1 }, { model: 'arbitrary' },
    { llmProvider: 'azure' }, { llmRequestContractVersion: 1 }, { backgroundMailRefreshEnabled: true },
    { mode: 'invalid' }, { speechEnabled: 1 }, { speechProvider: 'other' }, { speechEndpoint: 'http://x.cognitiveservices.azure.com' },
    { speechEndpoint: 'https://user:pass@x.cognitiveservices.azure.com' }, { speechEndpoint: 'https://x.cognitiveservices.azure.com\n' },
    { speechEndpoint: 'https://x.cognitiveservices.azure.com', extra: true }, { speechEndpoint: 'x'.repeat(2049) },
    { openRouterReasoningEffort: 'high' }, { maxAudioSeconds: 9 }, { maxAudioSeconds: 601 }, { maxAudioSeconds: 10.5 },
    { audioRetention: 'archive' }, { timezone: 'Mars/Olympus' },
  ];
  for (const patch of invalidPatches) assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'settings.update', patch })), /workspace_command_invalid/);
  let getterRuns = 0;
  const accessorPatch = {};
  Object.defineProperty(accessorPatch, 'mode', { enumerable: true, get() { getterRuns += 1; return 'preview'; } });
  assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'settings.update', patch: accessorPatch })), /workspace_command_invalid/);
  assert.equal(getterRuns, 0, 'patch accessors are rejected without executing caller code');
  const commandId = randomUUID();
  const receipt = { schemaVersion: 1, commandId, kind: 'settings.update', objectId: 'workspace-settings' };
  assert.deepEqual(parseWorkspaceCommandReceipt(receipt, { commandId, kind: 'settings.update', objectId: 'workspace-settings' }), receipt);
  assert.throws(() => parseWorkspaceCommandReceipt({ ...receipt, objectId: 'settings' }), /workspace_command_receipt_invalid/);
});

test('real command dispatch creates and edits documents, people, projects, facts, contacts, members, and archives with exact metadata receipts', async () => {
  const f = fixture();
  try {
    let head = await f.runtime.getSnapshot(f.admission);
    const execute = async (command) => {
      const admitted = envelope(command, head.revision, head.privacyEpoch);
      const result = await dispatchWorkspaceCommand(f.runtime, f.admission, admitted);
      assert.equal(result.status, 'finished', command.kind);
      head = result.snapshot;
      return { admitted, result };
    };
    const createdPerson = await execute({ kind: 'knowledge.person.save', operation: 'create',
      input: { name: 'Ada Example', aliases: ['Ada'], narrative: 'First note.' } });
    const personId = createdPerson.result.receipt.objectId;
    assert.equal(createdPerson.result.receipt.entityKind, 'person');
    assert.equal(createdPerson.result.receipt.entityRevision, 1);
    assert.deepEqual(Object.keys(createdPerson.result.receipt).sort(), ['commandId', 'entityKind', 'entityRevision', 'kind', 'objectId', 'schemaVersion']);
    const personDocument = head.state.documents.find((document) => document.path === `people/${personId}.md`);
    assert.equal(personDocument.revision, 1);

    const updatedPerson = await execute({ kind: 'knowledge.person.save', operation: 'update', input: {
      id: personId, expectedRevision: 1, expectedDocumentRevision: 1, name: 'Ada Lovelace', aliases: ['Ada'], narrative: 'Second note.',
    } });
    assert.equal(updatedPerson.result.receipt.entityRevision, 2);
    assert.equal(head.state.documents.find((document) => document.path === personDocument.path).revision, 2);

    const editedDocument = await execute({ kind: 'documents.save', path: personDocument.path, content: 'Third note.',
      expectedRevision: 2, expectedEntityRevision: 2 });
    assert.deepEqual(editedDocument.result.receipt, { schemaVersion: 1, commandId: editedDocument.admitted.commandId,
      kind: 'documents.save', objectId: personDocument.path, documentRevision: 3, entityKind: 'person', entityId: personId, entityRevision: 3 });

    const person = head.state.knowledge.people.find((entity) => entity.id === personId);
    const factSaved = await execute({ kind: 'knowledge.fact.save', entityKind: 'person', entityId: personId,
      expectedEntityRevision: person.revision, statement: 'Works on analytical engines.' });
    const factId = factSaved.result.receipt.itemId;
    assert.equal(factSaved.result.receipt.entityRevision, person.revision + 1);
    const updatedPersonState = head.state.knowledge.people.find((entity) => entity.id === personId);
    const factUpdated = await execute({ kind: 'knowledge.fact.save', entityKind: 'person', entityId: personId,
      expectedEntityRevision: updatedPersonState.revision, itemId: factId, statement: 'Designed an analytical engine.' });
    assert.equal(factUpdated.result.receipt.itemId, factId);
    const afterFactUpdate = head.state.knowledge.people.find((entity) => entity.id === personId);
    const factRemoved = await execute({ kind: 'knowledge.fact.remove', entityKind: 'person', entityId: personId,
      expectedEntityRevision: afterFactUpdate.revision, itemId: factId });
    assert.equal(factRemoved.result.receipt.itemId, factId);

    const personForContact = head.state.knowledge.people.find((entity) => entity.id === personId);
    const contactSaved = await execute({ kind: 'knowledge.contact.save', entityKind: 'person', entityId: personId,
      expectedEntityRevision: personForContact.revision, address: 'ada@example.test', label: 'email' });
    const contactId = contactSaved.result.receipt.itemId;
    const personForContactRemoval = head.state.knowledge.people.find((entity) => entity.id === personId);
    const contactRemoved = await execute({ kind: 'knowledge.contact.remove', entityKind: 'person', entityId: personId,
      expectedEntityRevision: personForContactRemoval.revision, itemId: contactId });
    assert.equal(contactRemoved.result.receipt.itemId, contactId);

    const createdProject = await execute({ kind: 'knowledge.project.save', operation: 'create', input: {
      name: 'Analytical engine', aliases: [], narrative: 'Build plan.', status: 'active', goal: 'Construct a prototype.',
    } });
    const projectId = createdProject.result.receipt.objectId;
    assert.equal(createdProject.result.receipt.entityKind, 'project');
    const project = head.state.knowledge.projects.find((entity) => entity.id === projectId);
    const memberSaved = await execute({ kind: 'knowledge.member.save', entityKind: 'project', entityId: projectId,
      expectedEntityRevision: project.revision, personId, personRevision: head.state.knowledge.people.find((entity) => entity.id === personId).revision,
      role: 'designer' });
    const memberId = memberSaved.result.receipt.itemId;
    const projectAfterMember = head.state.knowledge.projects.find((entity) => entity.id === projectId);
    const memberRemoved = await execute({ kind: 'knowledge.member.remove', entityKind: 'project', entityId: projectId,
      expectedEntityRevision: projectAfterMember.revision, itemId: memberId });
    assert.equal(memberRemoved.result.receipt.itemId, memberId);

    const archived = await execute({ kind: 'knowledge.entity.archive', entityKind: 'project', id: projectId,
      expectedRevision: head.state.knowledge.projects.find((entity) => entity.id === projectId).revision, archived: true });
    assert.equal(archived.result.receipt.entityRevision, 4);
    const restored = await execute({ kind: 'knowledge.entity.archive', entityKind: 'project', id: projectId,
      expectedRevision: head.state.knowledge.projects.find((entity) => entity.id === projectId).revision, archived: false });
    assert.equal(restored.result.receipt.entityRevision, 5);
    assert.equal(head.state.knowledge.projects.find((entity) => entity.id === projectId).archivedAt, undefined);
    assert.equal(await f.runtime.getSnapshot(f.admission).then((fresh) => fresh.revision), head.revision);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('knowledge entity mirror failure keeps canonical content durable and returns a receipt only after the side effect settles', async () => {
  const writes = [];
  const f = fixture({ writeDocument: async (path, content) => { writes.push({ path, content }); throw new Error('synthetic mirror unavailable'); } });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'knowledge.person.save', operation: 'create',
      input: { name: 'Mirrored Person', aliases: [], narrative: 'Canonical narrative.' } }, initial.revision, initial.privacyEpoch);
    const result = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(result.status, 'finished');
    const matchingWrites = writes.filter((write) => write.content === 'Canonical narrative.');
    assert.equal(matchingWrites.length, 1);
    const mirroredWrite = matchingWrites[0];
    assert.match(mirroredWrite.path, /^people\/[0-9a-f-]+\.md$/);
    assert.equal(mirroredWrite.content, 'Canonical narrative.');
    assert.equal(result.snapshot.state.documents.find((document) => document.path === mirroredWrite.path).content, mirroredWrite.content);
    assert.ok(result.snapshot.state.activity.some((item) => item.type === 'error' && item.message.includes('Local document mirror')));
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, command.commandId).status, 'finished');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('reserved knowledge document path variants reject before journal admission or mutation', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const paths = [`PEOPLE/${id}.md`, `people/${id.toUpperCase()}.md`, `projects/${id.toUpperCase()}.md`, `people/${id}.MD`];
    for (const path of paths) {
      const command = envelope({ kind: 'documents.save', path, content: 'Must not be committed.', expectedRevision: null },
        initial.revision, initial.privacyEpoch);
      await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, command), /workspace_command_invalid/);
      assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, command.commandId).status, 'unverified', path);
    }
    const current = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(current.state.documents.length, initial.state.documents.length);
    assert.equal(current.state.documents.some((document) => paths.includes(document.path)), false);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('canonical v7 knowledge IDs remain editable with exact document and item receipts after reload', async () => {
  const personId = '018f47d2-6b1a-7c34-8b9d-1234567890ab';
  const person = { id: personId, revision: 1, name: 'Imported v7 Person', aliases: [], narrativePath: `people/${personId}.md`,
    createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', facts: [], sourceLinks: [], contacts: [] };
  const f = fixture({ initialKnowledge: { schemaVersion: 1, people: [person], projects: [], suggestions: [] },
    initialDocuments: [{ path: person.narrativePath, content: 'Legacy narrative.', revision: 1, updatedAt: person.updatedAt }] });
  try {
    let head = await f.runtime.getSnapshot(f.admission);
    const update = envelope({ kind: 'knowledge.person.save', operation: 'update', input: {
      id: personId, expectedRevision: 1, expectedDocumentRevision: 1, name: 'Imported v7 Person Updated', aliases: [], narrative: 'Updated v7 narrative.',
    } }, head.revision, head.privacyEpoch);
    const saved = await dispatchWorkspaceCommand(f.runtime, f.admission, update);
    assert.equal(saved.receipt.objectId, personId);
    assert.equal(saved.receipt.entityRevision, 2);
    head = saved.snapshot;
    const fact = await dispatchWorkspaceCommand(f.runtime, f.admission, envelope({ kind: 'knowledge.fact.save', entityKind: 'person',
      entityId: personId, expectedEntityRevision: 2, statement: 'A fact on the imported entity.' }, head.revision, head.privacyEpoch));
    assert.equal(fact.receipt.objectId, personId);
    assert.equal(fact.receipt.entityRevision, 3);
    assert.ok(fact.receipt.itemId);
    const reloaded = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(reloaded.state.knowledge.people.find((row) => row.id === personId).revision, 3);
    assert.equal(reloaded.state.documents.find((row) => row.path === person.narrativePath).content, 'Updated v7 narrative.');
    assert.equal(reloaded.state.knowledge.people.find((row) => row.id === personId).facts[0].id, fact.receipt.itemId);

    const uppercaseId = personId.toUpperCase();
    const invalid = envelope({ kind: 'knowledge.person.save', operation: 'update', input: {
      id: uppercaseId, expectedRevision: 3, expectedDocumentRevision: 2, name: 'Wrong case', aliases: [], narrative: 'Must reject.',
    } }, reloaded.revision, reloaded.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, invalid), /workspace_command_invalid/);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, invalid.commandId).status, 'unverified');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('stale entity, document, member, and cross-parent item revisions never alter canonical knowledge', async () => {
  const f = fixture();
  try {
    let head = await f.runtime.getSnapshot(f.admission);
    const execute = async (command) => {
      const result = await dispatchWorkspaceCommand(f.runtime, f.admission, envelope(command, head.revision, head.privacyEpoch));
      head = result.snapshot;
      return result;
    };
    const first = await execute({ kind: 'knowledge.person.save', operation: 'create',
      input: { name: 'First Person', aliases: [], narrative: 'One.' } });
    const firstId = first.receipt.objectId;
    const second = await execute({ kind: 'knowledge.person.save', operation: 'create',
      input: { name: 'Second Person', aliases: [], narrative: 'Two.' } });
    const secondId = second.receipt.objectId;
    await execute({ kind: 'knowledge.person.save', operation: 'update', input: {
      id: firstId, expectedRevision: 1, expectedDocumentRevision: 1, name: 'First Updated', aliases: [], narrative: 'One updated.',
    } });
    const firstCurrent = head.state.knowledge.people.find((person) => person.id === firstId);
    const firstDoc = head.state.documents.find((document) => document.path === `people/${firstId}.md`);
    const revisionBeforeStale = head.revision;

    const staleEntity = envelope({ kind: 'knowledge.person.save', operation: 'update', input: {
      id: firstId, expectedRevision: 1, expectedDocumentRevision: firstDoc.revision,
      name: 'Stale Entity', aliases: [], narrative: 'Must not replace.',
    } }, head.revision, head.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, staleEntity));
    head = await f.runtime.refreshSnapshot(f.admission);
    const staleDocument = envelope({ kind: 'documents.save', path: firstDoc.path, content: 'Stale document.',
      expectedRevision: 1, expectedEntityRevision: firstCurrent.revision }, head.revision, head.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, staleDocument));
    head = await f.runtime.refreshSnapshot(f.admission);

    const fact = await execute({ kind: 'knowledge.fact.save', entityKind: 'person', entityId: firstId,
      expectedEntityRevision: firstCurrent.revision, statement: 'Belongs to first person.' });
    const factId = fact.receipt.itemId;
    const secondCurrent = head.state.knowledge.people.find((person) => person.id === secondId);
    const crossParent = envelope({ kind: 'knowledge.fact.save', entityKind: 'person', entityId: secondId,
      expectedEntityRevision: secondCurrent.revision, itemId: factId, statement: 'Must not move between people.' },
    head.revision, head.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, crossParent));
    head = await f.runtime.refreshSnapshot(f.admission);

    const project = await execute({ kind: 'knowledge.project.save', operation: 'create', input: {
      name: 'Stale member project', aliases: [], narrative: '', status: 'active', goal: '',
    } });
    const projectId = project.receipt.objectId;
    const beforeMemberAttempt = head.state.knowledge.projects.find((row) => row.id === projectId);
    const personRevision = head.state.knowledge.people.find((row) => row.id === firstId).revision;
    const member = await execute({ kind: 'knowledge.member.save', entityKind: 'project', entityId: projectId,
      expectedEntityRevision: beforeMemberAttempt.revision, personId: firstId, personRevision, role: 'reviewer' });
    assert.ok(member.receipt.itemId);
    const afterMember = head.state.knowledge.projects.find((row) => row.id === projectId);
    await execute({ kind: 'knowledge.person.save', operation: 'update', input: {
      id: secondId, expectedRevision: 1, expectedDocumentRevision: 1, name: 'Second Updated', aliases: [], narrative: 'Two updated.',
    } });
    const staleMember = envelope({ kind: 'knowledge.member.save', entityKind: 'project', entityId: projectId,
      expectedEntityRevision: afterMember.revision, personId: secondId, personRevision: 1, role: 'stale' }, head.revision, head.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, staleMember));

    const current = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(current.state.knowledge.people.find((row) => row.id === firstId).name, 'First Updated');
    assert.equal(current.state.documents.find((row) => row.path === firstDoc.path).content, 'One updated.');
    assert.equal(current.state.knowledge.people.find((row) => row.id === firstId).facts[0].id, factId);
    assert.equal(current.state.knowledge.people.find((row) => row.id === secondId).facts.length, 0);
    assert.equal(current.state.knowledge.projects.find((row) => row.id === projectId).revision, afterMember.revision);
    assert.ok(current.revision > revisionBeforeStale);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('lost entity-save acknowledgement stays inspect-only and an exact duplicate never reapplies the mutation', async () => {
  const writes = [];
  const f = fixture({ writeDocument: async (path, content) => { writes.push({ path, content }); } });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'knowledge.person.save', operation: 'create',
      input: { name: 'One admission', aliases: [], narrative: 'One canonical write.' } }, initial.revision, initial.privacyEpoch);
    f.loseNextWorkspaceCommitAck();
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, command), /acknowledgement|simulated|commit/i);
    const inspection = inspectWorkspaceCommand(f.runtime, f.admission, command.commandId);
    assert.equal(inspection.status, 'inspect_required');
    assert.equal(Object.hasOwn(inspection, 'receipt'), false);
    const afterCommit = await f.runtime.refreshSnapshot(f.admission);
    const person = afterCommit.state.knowledge.people.find((row) => row.name === 'One admission');
    assert.ok(person);
    const writesForCommand = writes.filter((write) => write.content === 'One canonical write.');
    assert.ok(writesForCommand.length > 0);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, command.commandId).status, 'inspect_required');

    const replay = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(replay.status, 'inspect_required');
    assert.equal(Object.hasOwn(replay, 'receipt'), false);
    const afterReplay = await f.runtime.refreshSnapshot(f.admission);
    const matchingPeople = afterReplay.state.knowledge.people.filter((row) => row.name === 'One admission');
    assert.equal(matchingPeople.length, 1, 'the exact unknown-outcome retry does not create a second entity');
    assert.equal(matchingPeople[0].revision, 1, 'the exact unknown-outcome retry does not apply the entity mutation twice');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('editing a selected knowledge entity invalidates the Batch job that captured its source revision', async () => {
  let providerSubmissions = 0;
  const f = fixture({ providerBatchClient: { async submit(_input, onBeforeDispatch) {
    providerSubmissions += 1;
    await onBeforeDispatch();
    return { batchId: `fixture-knowledge-batch-${providerSubmissions}` };
  }, async inspect() { throw new Error('No result inspection is needed for source invalidation.'); } } });
  try {
    let head = await f.runtime.getSnapshot(f.admission);
    const personResult = await dispatchWorkspaceCommand(f.runtime, f.admission, envelope({ kind: 'knowledge.person.save', operation: 'create',
      input: { name: 'Captured source', aliases: [], narrative: 'Original source.' } }, head.revision, head.privacyEpoch));
    head = personResult.snapshot;
    const personId = personResult.receipt.objectId;
    const note = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'Use the selected person as context.' }, head.revision, head.privacyEpoch));
    head = note.snapshot;
    const submitted = await dispatchWorkspaceCommand(f.runtime, f.admission, envelope({ kind: 'assistant.batch.submitNote',
      noteId: note.receipt.objectId, knowledgeSelection: [{ kind: 'person', id: personId }] }, head.revision, head.privacyEpoch));
    const job = submitted.snapshot.state.assistantBatchJobs.find((row) => row.id === submitted.receipt.jobId);
    assert.ok(job);
    assert.equal(providerSubmissions, 1);

    const updated = await dispatchWorkspaceCommand(f.runtime, f.admission, envelope({ kind: 'knowledge.person.save', operation: 'update', input: {
      id: personId, expectedRevision: 1, expectedDocumentRevision: 1, name: 'Captured source edited', aliases: [], narrative: 'Replacement source.',
    } }, submitted.snapshot.revision, submitted.snapshot.privacyEpoch));
    const invalidated = updated.snapshot.state.assistantBatchJobs.find((row) => row.id === job.id);
    assert.equal(invalidated.status, 'source_removed');
    assert.equal(invalidated.sourceRemoved, true);
    assert.equal(providerSubmissions, 1, 'source invalidation does not resubmit the captured Batch request');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('settings.update is journaled once, forces the Batch profile, and preserves uncertain outcomes for inspection', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const invalid = envelope({ kind: 'settings.update', patch: { monthlyBudgetUsd: 0 } }, initial.revision, initial.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, invalid), /workspace_command_invalid/);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, invalid.commandId).status, 'unverified',
      'an unsafe field is rejected before journal admission');
    const accessorPatch = {};
    Object.defineProperty(accessorPatch, 'mode', { enumerable: true, get() { throw new Error('getter must not run'); } });
    const accessor = envelope({ kind: 'settings.update', patch: accessorPatch }, initial.revision, initial.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, accessor), /workspace_command_invalid/);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, accessor.commandId).status, 'unverified');

    const command = envelope({ kind: 'settings.update', patch: { mode: 'provider', timezone: 'Asia/Singapore',
      speechProvider: 'openrouter', speechEndpoint: 'https://Speech.Example.cognitiveservices.azure.com/path', maxAudioSeconds: 90 } },
      initial.revision, initial.privacyEpoch);
    const first = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.deepEqual(first.receipt, { schemaVersion: 1, commandId: command.commandId, kind: 'settings.update', objectId: 'workspace-settings' });
    assert.deepEqual(Object.keys(first.receipt).sort(), ['commandId', 'kind', 'objectId', 'schemaVersion']);
    assert.equal(first.snapshot.state.settings.speechEndpoint, 'https://speech.example.cognitiveservices.azure.com');
    assert.equal(first.snapshot.state.settings.llmProvider, 'openrouter');
    assert.equal(first.snapshot.state.settings.openRouterModel, 'openai/gpt-6-luna:batch');
    const revisionAfterFirst = first.snapshot.revision;
    const activityAfterFirst = first.snapshot.state.activity.length;
    const historyLength = f.runtime.listCommandHistory(f.admission).entries.length;
    const duplicate = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.deepEqual(duplicate.receipt, first.receipt);
    assert.equal(duplicate.snapshot.revision, revisionAfterFirst);
    assert.equal(duplicate.snapshot.state.activity.length, activityAfterFirst);
    assert.equal(f.runtime.listCommandHistory(f.admission).entries.length, historyLength, 'an exact duplicate does not add another journal row');
    assert.throws(() => parseWorkspaceCommandReceipt(first.receipt, { commandId: command.commandId, kind: 'settings.update', objectId: 'wrong' }),
      /workspace_command_receipt_invalid/);

    const uncertain = envelope({ kind: 'settings.update', patch: { audioRetention: 'delete_after_transcription' } },
      first.snapshot.revision, first.snapshot.privacyEpoch);
    f.loseNextWorkspaceCommitAck();
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, uncertain));
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, uncertain.commandId).status, 'inspect_required');
    assert.equal(Object.hasOwn(inspectWorkspaceCommand(f.runtime, f.admission, uncertain.commandId), 'receipt'), false);
    assert.equal(f.runtime.listCommandHistory(f.admission).entries.find((entry) => entry.commandId === uncertain.commandId)?.status, 'inspect_required');
    const afterUncertainRefresh = await f.runtime.refreshSnapshot(f.admission);
    const revisionBeforeRetry = f.kernel.getOwnedIdentity(f.admissionSession).revision;
    const uncertainRetry = await dispatchWorkspaceCommand(f.runtime, f.admission, uncertain);
    assert.equal(uncertainRetry.status, 'inspect_required');
    assert.equal(Object.hasOwn(uncertainRetry, 'receipt'), false);
    assert.equal(uncertainRetry.snapshot, undefined);
    assert.equal(f.kernel.getOwnedIdentity(f.admissionSession).revision, revisionBeforeRetry);
    assert.ok(afterUncertainRefresh.revision >= revisionBeforeRetry);
    assert.equal(afterUncertainRefresh.state.settings.audioRetention, 'delete_after_transcription');
    assert.equal(f.runtime.listCommandHistory(f.admission).entries.find((entry) => entry.commandId === uncertain.commandId)?.status, 'inspect_required',
      'retrying an uncertain command after refresh does not repeat the settings save');
    const staleRevision = envelope({ kind: 'settings.update', patch: { mode: 'preview' } }, first.snapshot.revision - 1, first.snapshot.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, staleRevision));
    const current = await f.runtime.refreshSnapshot(f.admission);
    const staleEpoch = envelope({ kind: 'settings.update', patch: { mode: 'preview' } }, current.revision, current.privacyEpoch + 1);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, staleEpoch));
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('transcription command and receipt bind a strict note revision and generated attempt', () => {
  const commandId = randomUUID();
  const noteId = 'note-owned-id';
  const parsed = parseWorkspaceCommandEnvelope(envelope({ kind: 'notes.transcribe', noteId, expectedNoteRevision: 3 }, 4, 2, commandId));
  assert.deepEqual(parsed.command, { kind: 'notes.transcribe', noteId, expectedNoteRevision: 3 });
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3']) {
    assert.throws(() => parseWorkspaceCommandEnvelope(envelope({ kind: 'notes.transcribe', noteId, expectedNoteRevision: invalid })),
      /workspace_command_invalid/);
  }
  const attemptId = randomUUID();
  const receipt = { schemaVersion: 1, commandId, kind: 'notes.transcribe', objectId: noteId, attemptId, sourceRevision: 3, outcome: 'completed' };
  assert.deepEqual(parseWorkspaceCommandReceipt(receipt, { commandId, kind: 'notes.transcribe', objectId: noteId, sourceRevision: 3 }), receipt);
  assert.throws(() => parseWorkspaceCommandReceipt({ ...receipt, attemptId: 'not-a-uuid' }), /workspace_command_receipt_invalid/);
  assert.throws(() => parseWorkspaceCommandReceipt(receipt, { commandId, kind: 'notes.transcribe', objectId: noteId, sourceRevision: 4 }),
    /workspace_command_receipt_invalid/);
});

test('settings.update is rejected while an owned transcription command holds the workspace command lane', async () => {
  const started = deferred();
  const release = deferred();
  const speechClient = {
    async transcribe(note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId) {
      const prepared = { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
        sha256: 'b'.repeat(64), durationSeconds: note.durationSeconds, upload: { blob: new Blob(['voice']), fileName: 'clip.wav' } };
      await onPrepared(prepared);
      await onAttempt(prepared);
      beforeDispatch(prepared);
      started.resolve();
      await release.promise;
      return { transcript: 'Done.', durationMilliseconds: 1000, durationSeconds: 1, billedEstimateSeconds: 1,
        attempts: 1, cleanupPromise: Promise.resolve() };
    },
    async releaseUploadLease() {}, disposeMemory() {},
  };
  const f = fixture({ speechClient, speechEnabled: true, withSpeechCleanup: true });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const seeded = await f.runtime.executeCommand({ ...f.admission, expectedRevision: initial.revision,
      expectedPrivacyEpoch: initial.privacyEpoch, idempotencyKey: randomUUID(), kind: 'test.seed-audio-note',
      canonicalBody: '{"fixture":"busy-settings"}' }, (controller) => controller.saveNote({ transcript: 'Audio note.',
        audioUri: 'file:///private/busy-settings.wav', durationSeconds: 2 }), (note) => ({ objectId: note.id }));
    const transcription = envelope({ kind: 'notes.transcribe', noteId: seeded.result.id, expectedNoteRevision: seeded.result.revision },
      seeded.snapshot.revision, seeded.snapshot.privacyEpoch);
    const pendingTranscription = dispatchWorkspaceCommand(f.runtime, f.admission, transcription);
    await started.promise;
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'settings.update', patch: { timezone: 'Asia/Singapore' } }, seeded.snapshot.revision, seeded.snapshot.privacyEpoch)));
    release.resolve();
    const finished = await pendingTranscription;
    assert.equal(finished.status, 'finished');
    assert.equal(f.runtime.listCommandHistory(f.admission).entries.some((entry) => entry.kind === 'settings.update'), false,
      'the busy rejection happens before settings command admission');
  } finally {
    release.resolve();
    await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
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

test('transcription dispatcher rejects a stale note revision before any provider dispatch', async () => {
  const f = fixture();
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const saved = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'A note without current audio.' }, initial.revision, initial.privacyEpoch));
    const note = saved.snapshot.state.notes.find((item) => item.id === saved.receipt.objectId);
    assert.ok(note);
    const command = envelope({ kind: 'notes.transcribe', noteId: note.id, expectedNoteRevision: note.revision + 1 },
      saved.snapshot.revision, saved.snapshot.privacyEpoch);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, command), /revision|changed|stale/i);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('cloud source-link commands preserve omitted references and reject a changed opaque source choice', async () => {
  let controller;
  const f = fixture({ captureController(value) { controller = value; } });
  try {
    let current = await f.runtime.getSnapshot(f.admission);
    const person = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.person.save', operation: 'create', input: { name: 'Morgan', aliases: [], narrative: '' } }, current.revision, current.privacyEpoch));
    current = person.snapshot;
    const note = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'A source that will change.' }, current.revision, current.privacyEpoch));
    current = note.snapshot;
    let identity = f.kernel.getOwnedIdentity(f.admission.sessionToken);
    const choices = await f.runtime.readKnowledgeSourceChoices(f.admission, { expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch });
    const source = choices.choices.find((choice) => choice.reference.kind === 'note' && choice.reference.id === note.receipt.objectId);
    assert.ok(source);
    const personRow = current.state.knowledge.people.find((item) => item.id === person.receipt.objectId);
    const linked = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.sourceLink.save', entityKind: 'person', entityId: person.receipt.objectId,
        expectedEntityRevision: personRow.revision, referenceChoiceId: source.id, label: 'Original label' }, current.revision, current.privacyEpoch));
    const itemId = linked.receipt.itemId;
    const originalReference = linked.snapshot.state.knowledge.people.find((item) => item.id === person.receipt.objectId).sourceLinks.find((item) => item.id === itemId).reference;

    current = linked.snapshot;
    const renameCommand = envelope({ kind: 'knowledge.sourceLink.save', entityKind: 'person', entityId: person.receipt.objectId,
        expectedEntityRevision: current.state.knowledge.people.find((item) => item.id === person.receipt.objectId).revision,
        itemId, label: 'Renamed without changing the source' }, current.revision, current.privacyEpoch);
    f.loseNextWorkspaceCommitAck();
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, renameCommand), /acknowledgement|simulated|commit/i);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, renameCommand.commandId).status, 'inspect_required');
    current = await f.runtime.refreshSnapshot(f.admission);
    const exactRetry = await dispatchWorkspaceCommand(f.runtime, f.admission, renameCommand);
    assert.equal(exactRetry.status, 'inspect_required', 'a lost acknowledgement is inspected without replaying the source-link write');
    current = await f.runtime.refreshSnapshot(f.admission);
    const renamed = current.state.knowledge.people.find((item) => item.id === person.receipt.objectId).sourceLinks.find((item) => item.id === itemId);
    assert.equal(renamed.label, 'Renamed without changing the source');
    assert.deepEqual(renamed.reference, originalReference);

    const editedNote = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.updateTranscript', noteId: note.receipt.objectId, text: 'The source changed.',
        expectedNoteRevision: current.state.notes.find((item) => item.id === note.receipt.objectId).revision }, current.revision, current.privacyEpoch));
    current = editedNote.snapshot;
    identity = f.kernel.getOwnedIdentity(f.admission.sessionToken);
    const latestPerson = current.state.knowledge.people.find((item) => item.id === person.receipt.objectId);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.sourceLink.save', entityKind: 'person', entityId: person.receipt.objectId,
        expectedEntityRevision: latestPerson.revision, referenceChoiceId: source.id, label: 'Stale source' }, current.revision, current.privacyEpoch)),
    /source changed|no longer available/i);
    assert.equal(current.state.knowledge.people.find((item) => item.id === person.receipt.objectId).sourceLinks.length, 1,
      'the rejected stale selector cannot add a second source link');

    current = await f.runtime.refreshSnapshot(f.admission);
    identity = f.kernel.getOwnedIdentity(f.admission.sessionToken);
    const refreshedChoices = await f.runtime.readKnowledgeSourceChoices(f.admission, { expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch });
    const refreshedSource = refreshedChoices.choices.find((choice) => choice.reference.kind === 'note' && choice.reference.id === note.receipt.objectId);
    assert.ok(refreshedSource);
    const resolved = deferred(), continueSave = deferred();
    const originalSave = controller.saveKnowledgeSourceLink.bind(controller);
    controller.saveKnowledgeSourceLink = async (input) => { resolved.resolve(input); await continueSave.promise; return originalSave(input); };
    const currentPerson = current.state.knowledge.people.find((item) => item.id === person.receipt.objectId);
    const queuedCommand = envelope({ kind: 'knowledge.sourceLink.save', entityKind: 'person', entityId: person.receipt.objectId,
      expectedEntityRevision: currentPerson.revision, referenceChoiceId: refreshedSource.id, label: 'Raced source' }, current.revision, current.privacyEpoch);
    const queuedSave = dispatchWorkspaceCommand(f.runtime, f.admission, queuedCommand);
    const resolvedInput = await resolved.promise;
    assert.equal(typeof resolvedInput.expectedSourceBinding, 'string', 'the private binding reaches the controller boundary');
    await controller.updateTranscript(note.receipt.objectId, 'Changed after selector resolution.', {
      expectedRevision: current.state.notes.find((item) => item.id === note.receipt.objectId).revision,
    });
    continueSave.resolve();
    await assert.rejects(queuedSave, /source changed|no longer available|revision changed/i);
    current = await f.runtime.refreshSnapshot(f.admission);
    assert.equal(current.state.knowledge.people.find((item) => item.id === person.receipt.objectId).sourceLinks.length, 1,
      'the queued native mutation cannot persist the selector resolved against older source state');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('suggestion review rejects stale evidence, target, and project-member revisions inside the actual controller', async () => {
  const f = fixture();
  try {
    let current = await f.runtime.getSnapshot(f.admission);
    const personResult = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.person.save', operation: 'create', input: { name: 'Morgan', aliases: [], narrative: '' } }, current.revision, current.privacyEpoch));
    current = personResult.snapshot;
    const projectResult = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.project.save', operation: 'create', input: { name: 'Still project', aliases: [], narrative: '', status: 'active', goal: '' } }, current.revision, current.privacyEpoch));
    current = projectResult.snapshot;
    const noteResult = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'First exact evidence. Second exact evidence. Member evidence.' }, current.revision, current.privacyEpoch));
    current = noteResult.snapshot;
    const noteId = noteResult.receipt.objectId;
    let person = current.state.knowledge.people.find((item) => item.id === personResult.receipt.objectId);
    let project = current.state.knowledge.projects.find((item) => item.id === projectResult.receipt.objectId);
    const createSuggestion = async (evidenceNoteId, quote, targetKind, targetId, change) => {
      const identity = f.kernel.getOwnedIdentity(f.admission.sessionToken);
      return f.runtime.executeCommand({ ...f.admission, expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch,
        idempotencyKey: randomUUID(), kind: 'knowledge.suggestion.edit', canonicalBody: JSON.stringify({ setupQuote: quote, targetId }) },
      (controller) => controller.createKnowledgeSuggestionFromNote({ noteId: evidenceNoteId, sourceId: 'transcript', quote, targetKind, targetId, change }),
      (suggestion) => ({ objectId: suggestion.id }));
    };

    const evidenceSuggestion = await createSuggestion(noteId, 'First exact evidence', 'person', person.id,
      { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Evidence-bound fact.' });
    current = await f.runtime.getSnapshot(f.admission);
    const noteUpdate = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.updateTranscript', noteId, text: 'The source text has changed.',
        expectedNoteRevision: current.state.notes.find((item) => item.id === noteId).revision }, current.revision, current.privacyEpoch));
    current = noteUpdate.snapshot;
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.suggestion.review', suggestionId: evidenceSuggestion.result.id, expectedSuggestionRevision: 1,
        decision: 'accept', targetRevision: person.revision }, current.revision, current.privacyEpoch)), /evidence|source|stale|changed/i);
    current = await f.runtime.refreshSnapshot(f.admission);

    const targetNote = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'Fresh target evidence.' }, current.revision, current.privacyEpoch));
    current = targetNote.snapshot;
    const targetSuggestion = await createSuggestion(targetNote.receipt.objectId, 'Fresh target evidence', 'person', person.id,
      { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Target-bound fact.' });
    current = await f.runtime.getSnapshot(f.admission);
    const identity = f.kernel.getOwnedIdentity(f.admission.sessionToken);
    const choices = await f.runtime.readKnowledgeSourceChoices(f.admission, { expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch });
    const choice = choices.choices.find((item) => item.reference.kind === 'note' && item.reference.id === targetNote.receipt.objectId);
    assert.ok(choice);
    const suggestionEdit = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.suggestion.edit', suggestionId: targetSuggestion.result.id, expectedSuggestionRevision: 1,
        expectedTargetRevision: person.revision,
        change: { type: 'add_source_link', entityKind: 'person', entityId: person.id, referenceChoiceId: choice.id, label: 'Chosen evidence' },
        evidence: targetSuggestion.result.evidence }, current.revision, current.privacyEpoch));
    current = suggestionEdit.snapshot;
    assert.equal(current.state.knowledge.suggestions.find((item) => item.id === targetSuggestion.result.id).change.reference.id, targetNote.receipt.objectId);
    const updatedPerson = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.fact.save', entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision,
        statement: 'A direct change advances the target.' }, current.revision, current.privacyEpoch));
    current = updatedPerson.snapshot;
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.suggestion.review', suggestionId: targetSuggestion.result.id, expectedSuggestionRevision: 2,
        decision: 'accept', targetRevision: person.revision }, current.revision, current.privacyEpoch)), /target|changed|stale/i);
    current = await f.runtime.refreshSnapshot(f.admission);

    const memberNote = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'Member evidence.' }, current.revision, current.privacyEpoch));
    current = memberNote.snapshot;
    person = current.state.knowledge.people.find((item) => item.id === person.id);
    project = current.state.knowledge.projects.find((item) => item.id === project.id);
    const memberSuggestion = await createSuggestion(memberNote.receipt.objectId, 'Member evidence', 'project', project.id,
      { type: 'add_member', entityKind: 'project', entityId: project.id, personId: person.id, personRevision: person.revision, role: 'Designer' });
    current = await f.runtime.getSnapshot(f.admission);
    const personChanged = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.fact.save', entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision,
        statement: 'A direct change advances the member.' }, current.revision, current.privacyEpoch));
    current = personChanged.snapshot;
    project = current.state.knowledge.projects.find((item) => item.id === project.id);
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.suggestion.review', suggestionId: memberSuggestion.result.id, expectedSuggestionRevision: 1,
        decision: 'accept', targetRevision: project.revision, memberPersonRevision: person.revision }, current.revision, current.privacyEpoch)), /member|person|changed|stale/i);
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('suggestion edit and review receipts survive journal inspection, exact retries, and a lost acknowledgement', async () => {
  const f = fixture();
  try {
    let current = await f.runtime.getSnapshot(f.admission);
    const personResult = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'knowledge.person.save', operation: 'create', input: { name: 'Morgan', aliases: [], narrative: '' } }, current.revision, current.privacyEpoch));
    current = personResult.snapshot;
    const noteResult = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'notes.save', transcript: 'Review this exact quote.' }, current.revision, current.privacyEpoch));
    current = noteResult.snapshot;
    const personId = personResult.receipt.objectId, noteId = noteResult.receipt.objectId;
    const seedSuggestion = async (statement) => {
      const identity = f.kernel.getOwnedIdentity(f.admission.sessionToken);
      return f.runtime.executeCommand({ ...f.admission, expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch,
        idempotencyKey: randomUUID(), kind: 'knowledge.suggestion.edit', canonicalBody: JSON.stringify({ seed: statement }) },
      (controller) => controller.createKnowledgeSuggestionFromNote({ noteId, sourceId: 'transcript', quote: 'Review this exact quote.',
        targetKind: 'person', targetId: personId,
        change: { type: 'add_fact', entityKind: 'person', entityId: personId, statement } }),
      (suggestion) => ({ objectId: suggestion.id }));
    };
    const first = await seedSuggestion('Proposed first fact.');
    current = await f.runtime.getSnapshot(f.admission);
    const target = current.state.knowledge.people.find((item) => item.id === personId);
    const editCommand = envelope({ kind: 'knowledge.suggestion.edit', suggestionId: first.result.id,
      expectedSuggestionRevision: first.result.revision, expectedTargetRevision: target.revision,
      change: { type: 'add_fact', entityKind: 'person', entityId: personId, statement: 'Edited first fact.' }, evidence: first.result.evidence },
    current.revision, current.privacyEpoch);
    const edited = await dispatchWorkspaceCommand(f.runtime, f.admission, editCommand);
    assert.equal(edited.receipt.suggestionId, first.result.id);
    assert.equal(edited.receipt.suggestionRevision, 2);
    assert.equal(edited.receipt.status, 'pending');
    assert.deepEqual(inspectWorkspaceCommand(f.runtime, f.admission, editCommand.commandId).receipt, edited.receipt);
    const editRetry = await dispatchWorkspaceCommand(f.runtime, f.admission, editCommand);
    assert.deepEqual(editRetry.receipt, edited.receipt);
    assert.equal(editRetry.snapshot.state.knowledge.suggestions.find((item) => item.id === first.result.id).revision, 2);

    current = editRetry.snapshot;
    const reviewCommand = envelope({ kind: 'knowledge.suggestion.review', suggestionId: first.result.id,
      expectedSuggestionRevision: 2, decision: 'accept', targetRevision: target.revision }, current.revision, current.privacyEpoch);
    const reviewed = await dispatchWorkspaceCommand(f.runtime, f.admission, reviewCommand);
    assert.equal(reviewed.receipt.suggestionId, first.result.id);
    assert.equal(reviewed.receipt.suggestionRevision, 3);
    assert.equal(reviewed.receipt.status, 'accepted');
    assert.deepEqual(inspectWorkspaceCommand(f.runtime, f.admission, reviewCommand.commandId).receipt, reviewed.receipt);
    assert.deepEqual((await dispatchWorkspaceCommand(f.runtime, f.admission, reviewCommand)).receipt, reviewed.receipt);

    const second = await seedSuggestion('Proposed second fact.');
    current = await f.runtime.getSnapshot(f.admission);
    const latestTargetRevision = current.state.knowledge.people.find((item) => item.id === personId).revision;
    const lostAckReview = envelope({ kind: 'knowledge.suggestion.review', suggestionId: second.result.id,
      expectedSuggestionRevision: 1, decision: 'dismiss', targetRevision: latestTargetRevision }, current.revision, current.privacyEpoch);
    f.loseNextWorkspaceCommitAck();
    await assert.rejects(dispatchWorkspaceCommand(f.runtime, f.admission, lostAckReview), /acknowledgement|simulated|commit/i);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, lostAckReview.commandId).status, 'inspect_required');
    current = await f.runtime.refreshSnapshot(f.admission);
    assert.equal((await dispatchWorkspaceCommand(f.runtime, f.admission, lostAckReview)).status, 'inspect_required');
    current = await f.runtime.refreshSnapshot(f.admission);
    const dismissed = current.state.knowledge.suggestions.find((item) => item.id === second.result.id);
    assert.equal(dismissed.status, 'dismissed');
    assert.equal(dismissed.revision, 2, 'inspect-only retry does not dismiss twice');
  } finally { await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('finished transcription receipt accepts a bounded opaque existing note ID and proves completed locally', async () => {
  const noteId = 'imported note: 17';
  let providerCalls = 0;
  const speechClient = {
    async transcribe(note, _settings, _signal, onAttempt, beforeDispatch, onPrepared, leaseId) {
      providerCalls += 1;
      const prepared = { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
        sha256: 'd'.repeat(64), durationSeconds: note.durationSeconds, upload: { blob: new Blob(['voice']), fileName: 'clip.wav' } };
      await onPrepared(prepared); await onAttempt(prepared); beforeDispatch(prepared);
      return { transcript: 'The exact local terminal result is complete.', durationMilliseconds: 1000,
        durationSeconds: 1, billedEstimateSeconds: 1, attempts: 1 };
    }, async releaseUploadLease() {}, disposeMemory() {},
  };
  const f = fixture({ speechClient, speechEnabled: true, initialNoteId: noteId });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const command = envelope({ kind: 'notes.transcribe', noteId, expectedNoteRevision: 1 }, initial.revision, initial.privacyEpoch);
    const completed = await dispatchWorkspaceCommand(f.runtime, f.admission, command);
    assert.equal(completed.status, 'finished');
    assert.equal(completed.receipt.objectId, noteId);
    assert.equal(completed.receipt.outcome, 'completed');
    assert.equal(providerCalls, 1);
    assert.equal(inspectWorkspaceCommand(f.runtime, f.admission, command.commandId).receipt.outcome, 'completed');
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

test('owned transcription dispatch is cancellable by a replacement session, retains cleanup ownership, and replays one bound receipt', async () => {
  const providerStarted = deferred();
  const providerObservedAbort = deferred();
  const cleanup = deferred();
  let providerCalls = 0;
  const speechClient = {
    async transcribe(note, _settings, signal, onAttempt, beforeDispatch, onPrepared, leaseId) {
      providerCalls += 1;
      const prepared = { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
        sha256: 'a'.repeat(64), durationSeconds: note.durationSeconds, upload: { blob: new Blob(['voice']), fileName: 'clip.wav' } };
      await onPrepared(prepared);
      await onAttempt(prepared);
      beforeDispatch(prepared);
      providerStarted.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      providerObservedAbort.resolve(signal.aborted);
      throw new SpeechTranscriptionError('Speech request was cancelled after dispatch.', 'cancelled', true,
        undefined, undefined, cleanup.promise);
    },
    async releaseUploadLease() {}, disposeMemory() {},
  };
  const f = fixture({ speechEnabled: true, speechClient, withSpeechCleanup: true });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const saved = await f.runtime.executeCommand({ ...f.admission, expectedRevision: initial.revision,
      expectedPrivacyEpoch: initial.privacyEpoch, idempotencyKey: randomUUID(), kind: 'test.seed-audio-note',
      canonicalBody: '{"fixture":"audio-note"}' }, (controller) => controller.saveNote({ transcript: 'Audio note.',
        audioUri: 'file:///private/voice.wav', durationSeconds: 2 }), (note) => ({ objectId: note.id }));
    const note = saved.result;
    const command = envelope({ kind: 'notes.transcribe', noteId: note.id, expectedNoteRevision: note.revision },
      saved.snapshot.revision, saved.snapshot.privacyEpoch);
    const pending = dispatchWorkspaceCommand(f.runtime, f.admission, command);
    await providerStarted.promise;
    const replacementSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    const replacementAdmission = { sessionToken: replacementSession, assertCurrent() { f.kernel.getOwnedIdentity(replacementSession); } };
    assert.equal(f.runtime.requestTranscriptionCancellation(replacementAdmission, command.commandId), 'cancellation_requested');
    assert.equal(await providerObservedAbort.promise, true, 'the exact live provider signal was aborted synchronously');
    const completed = await pending;
    assert.equal(completed.status, 'finished');
    assert.deepEqual(Object.keys(completed.receipt).sort(), ['attemptId', 'commandId', 'kind', 'objectId', 'outcome', 'schemaVersion', 'sourceRevision']);
    assert.equal(completed.receipt.kind, 'notes.transcribe');
    assert.equal(completed.receipt.objectId, note.id);
    assert.equal(completed.receipt.sourceRevision, note.revision);
    assert.equal(completed.receipt.outcome, 'cancelled', 'the receipt reports the durable local terminal result, not a provider billing assertion');
    assert.match(completed.receipt.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(Object.hasOwn(completed, 'snapshot'), false, 'the live cleanup child retains continuation ownership');
    assert.equal(f.runtime.requestTranscriptionCancellation(replacementAdmission, command.commandId), 'not_running');

    cleanup.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    let refreshed = false;
    for (let attempt = 0; attempt < 50 && !refreshed; attempt += 1) {
      try { await f.runtime.refreshSnapshot(replacementAdmission); refreshed = true; }
      catch (error) {
        if (!/workspace runtime is busy/i.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    assert.equal(refreshed, true, 'terminal cleanup settles before the explicit snapshot refresh');
    const duplicate = await dispatchWorkspaceCommand(f.runtime, replacementAdmission, command);
    assert.deepEqual(duplicate.receipt, completed.receipt);
    assert.equal(providerCalls, 1, 'the duplicate returns the committed receipt without starting provider work again');
    cleanup.resolve();
  } finally {
    cleanup.resolve();
    await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a lost terminal workspace acknowledgement keeps transcription inspect-required without fabricating a receipt', async () => {
  const started = deferred();
  const cleanup = deferred();
  let providerCalls = 0;
  const speechClient = {
    async transcribe(_note, _settings, signal, onAttempt, beforeDispatch, onPrepared, leaseId) {
      providerCalls += 1;
      const prepared = { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
        sha256: 'c'.repeat(64), durationSeconds: 2, upload: { blob: new Blob(['voice']), fileName: 'clip.wav' } };
      await onPrepared(prepared); await onAttempt(prepared); beforeDispatch(prepared); started.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new SpeechTranscriptionError('Cancelled after dispatch.', 'cancelled', true, undefined, undefined, cleanup.promise);
    }, async releaseUploadLease() {}, disposeMemory() {},
  };
  const f = fixture({ speechClient, speechEnabled: true, withSpeechCleanup: true });
  try {
    const initial = await f.runtime.getSnapshot(f.admission);
    const saved = await f.runtime.executeCommand({ ...f.admission, expectedRevision: initial.revision,
      expectedPrivacyEpoch: initial.privacyEpoch, idempotencyKey: randomUUID(), kind: 'test.seed-audio-note',
      canonicalBody: '{"fixture":"audio-note"}' }, (controller) => controller.saveNote({ transcript: 'Audio note.',
        audioUri: 'file:///private/ack-loss.wav', durationSeconds: 2 }), (note) => ({ objectId: note.id }));
    const command = envelope({ kind: 'notes.transcribe', noteId: saved.result.id, expectedNoteRevision: saved.result.revision },
      saved.snapshot.revision, saved.snapshot.privacyEpoch);
    const pending = dispatchWorkspaceCommand(f.runtime, f.admission, command);
    await started.promise;
    f.loseNextWorkspaceCommitAck();
    assert.equal(f.runtime.requestTranscriptionCancellation(f.admission, command.commandId), 'cancellation_requested');
    await assert.rejects(pending);
    const inspection = inspectWorkspaceCommand(f.runtime, f.admission, command.commandId);
    assert.equal(inspection.status, 'inspect_required');
    assert.equal(Object.hasOwn(inspection, 'receipt'), false);
    assert.equal(providerCalls, 1, 'uncertain terminal persistence does not retry provider work');
  } finally {
    cleanup.resolve();
    await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('same command UUID in two owned workspaces retains two independent active cancellation bindings', async () => {
  const started = [deferred(), deferred()];
  const aborted = [deferred(), deferred()];
  const cleanups = [deferred(), deferred()];
  const abortSeen = [false, false];
  const indexByNote = new Map();
  let providerCalls = 0;
  const speechClient = {
    async transcribe(note, _settings, signal, onAttempt, beforeDispatch, onPrepared, leaseId) {
      const index = indexByNote.get(note.id) ?? providerCalls;
      providerCalls += 1;
      const prepared = { leaseId, platform: 'web', format: 'wav', mimeType: 'audio/wav', byteLength: 5,
        sha256: 'b'.repeat(64), durationSeconds: note.durationSeconds, upload: { blob: new Blob(['voice']), fileName: 'clip.wav' } };
      await onPrepared(prepared); await onAttempt(prepared); beforeDispatch(prepared);
      started[index].resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      abortSeen[index] = signal.aborted;
      aborted[index].resolve();
      return { transcript: 'Done.', durationMilliseconds: 1000, durationSeconds: 1, billedEstimateSeconds: 1,
        attempts: 1, cleanupPromise: cleanups[index].promise };
    }, async releaseUploadLease() {}, disposeMemory() {},
  };
  const f = fixture({ speechClient, speechEnabled: true, withSpeechCleanup: true });
  try {
    const ownerId2 = randomUUID();
    const state2 = createInitialWorkspaceState(randomUUID);
    state2.settings.speechEnabled = true; state2.settings.speechEndpoint = 'https://example.cognitiveservices.azure.com';
    const workspace2 = f.kernel.createWorkspace(ownerId2, state2);
    const session2 = f.kernel.createSession(workspace2.workspaceId, ownerId2, Date.now() + 60 * 60_000);
    const runtimeSession2 = f.kernel.createSession(workspace2.workspaceId, ownerId2, RUNTIME_ACTOR_EXPIRES_AT);
    f.runtimeSessions.set(workspace2.workspaceId, runtimeSession2);
    const admission2 = { sessionToken: session2, assertCurrent() { f.kernel.getOwnedIdentity(session2); } };
    const seed = async (admission, key) => {
      const snapshot = await f.runtime.getSnapshot(admission);
      const saved = await f.runtime.executeCommand({ ...admission, expectedRevision: snapshot.revision,
        expectedPrivacyEpoch: snapshot.privacyEpoch, idempotencyKey: randomUUID(), kind: 'test.seed-audio-note',
        canonicalBody: JSON.stringify({ key }) }, (controller) => controller.saveNote({ transcript: 'Audio note.',
          audioUri: `file:///private/${key}.wav`, durationSeconds: 2 }), (note) => ({ objectId: note.id }));
      return { snapshot: saved.snapshot, noteId: saved.result.id };
    };
    const firstSeed = await seed(f.admission, 'first');
    const secondSeed = await seed(admission2, 'second');
    indexByNote.set(firstSeed.noteId, 0); indexByNote.set(secondSeed.noteId, 1);
    const sharedCommandId = randomUUID();
    const first = envelope({ kind: 'notes.transcribe', noteId: firstSeed.noteId, expectedNoteRevision: 1 },
      firstSeed.snapshot.revision, firstSeed.snapshot.privacyEpoch, sharedCommandId);
    const second = envelope({ kind: 'notes.transcribe', noteId: secondSeed.noteId, expectedNoteRevision: 1 },
      secondSeed.snapshot.revision, secondSeed.snapshot.privacyEpoch, sharedCommandId);
    const firstPending = dispatchWorkspaceCommand(f.runtime, f.admission, first);
    const secondPending = dispatchWorkspaceCommand(f.runtime, admission2, second);
    await Promise.all(started.map((item) => item.promise));
    assert.equal(providerCalls, 2);
    assert.equal(f.runtime.requestTranscriptionCancellation(f.admission, sharedCommandId), 'cancellation_requested');
    await aborted[0].promise;
    assert.equal(abortSeen[1], false, 'signaling one workspace does not reach the other workspace controller');
    assert.equal(f.runtime.requestTranscriptionCancellation(admission2, sharedCommandId), 'cancellation_requested');
    await aborted[1].promise;
    const [firstResult, secondResult] = await Promise.all([firstPending, secondPending]);
    assert.notEqual(firstResult.receipt.attemptId, secondResult.receipt.attemptId);
    assert.equal(firstResult.receipt.outcome, 'cancelled');
    assert.equal(secondResult.receipt.outcome, 'cancelled');
    cleanups.forEach((item) => item.resolve());
  } finally {
    cleanups.forEach((item) => item.resolve());
    await f.runtime.closeAfterDrain(); f.kernel.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
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
    const jobBeforeSettingsUpdate = structuredClone(first.snapshot.state.assistantBatchJobs.find((job) => job.id === first.receipt.jobId));
    const settingsUpdate = await dispatchWorkspaceCommand(f.runtime, f.admission,
      envelope({ kind: 'settings.update', patch: { mode: 'preview', timezone: 'Asia/Singapore' } },
        first.snapshot.revision, first.snapshot.privacyEpoch));
    const jobAfterSettingsUpdate = settingsUpdate.snapshot.state.assistantBatchJobs.find((job) => job.id === first.receipt.jobId);
    assert.deepEqual(jobAfterSettingsUpdate, jobBeforeSettingsUpdate, 'an explicit settings save leaves the queued Batch request and captured settings unchanged');
    assert.equal(providerSubmissions, 1, 'settings updates do not resubmit or rewrite queued Batch work');
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
