import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel, SecretVault } from '../dist/index.js';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';

function wavFixture() {
  const data = Buffer.alloc(1600, 128);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}
async function* chunks(bytes) { yield bytes.subarray(0, 13); yield bytes.subarray(13, 511); yield bytes.subarray(511); }

test('production workspace factory composes the real Node controller, Batch-only text client, vault-backed credentials, and audio API', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-production-workspace-'));
  const calls = [];
  const kernel = createDurableKernel({ databasePath: join(directory, 'private', 'workspace.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const vault = new SecretVault(kernel, randomBytes(32));
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, createInitialWorkspaceState(randomUUID));
  const userSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const actors = new ProcessWorkspaceActors(kernel);
  const runtime = createProductionApplicationRuntimeFactory({ dataDirectory: join(directory, 'private', 'data') }, {
    fetcher: async (input) => { calls.push(String(input)); throw new Error('unexpected provider request'); },
  })({ kernel, vault, runtimeSessionFor: (identity) => actors.sessionForRegistry(identity) });
  const admission = { sessionToken: userSession, assertCurrent: () => kernel.getOwnedIdentity(userSession) };
  try {
    const snapshot = await runtime.workspaceApi.getSnapshot(admission);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.workspaceId, workspace.workspaceId);
    assert.equal(snapshot.state.settings.llmProvider, 'azure', 'legacy provider settings remain inert until an explicit settings update');
    assert.equal(typeof runtime.audioHttpApi.upload, 'function');

    const commandId = randomUUID();
    const result = await runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId,
      expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch,
      command: { kind: 'notes.save', transcript: 'Factory graph works.' } });

    assert.equal(result.status, 'finished');
    assert.equal(result.receipt.commandId, commandId);
    assert.equal(result.receipt.kind, 'notes.save');
    assert.equal(result.snapshot.state.notes[0].transcript, 'Factory graph works.');

    const audio = wavFixture();
    const uploadId = randomUUID();
    const captureId = randomUUID();
    const uploaded = await runtime.audioHttpApi.upload(admission, { uploadId,
      capture: { id: captureId, capturedAt: '2026-10-15T00:00:00.000Z', timeZone: 'Asia/Singapore' },
      mimeType: 'audio/wav', expectedByteLength: audio.byteLength, source: chunks(audio) });
    assert.equal(uploaded.status, 'ready');
    assert.match(uploaded.media.mediaId, /^still-media:/);
    const beforeAdoption = await runtime.workspaceApi.getSnapshot(admission);
    const adoptionCommandId = randomUUID();
    const adopted = await runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: adoptionCommandId,
      expectedRevision: beforeAdoption.revision, expectedPrivacyEpoch: beforeAdoption.privacyEpoch,
      command: { kind: 'notes.capture.adopt', captureId, captureRevision: uploaded.capture.revision } });
    const note = adopted.snapshot.state.notes.find((item) => item.id === captureId);
    assert.equal(note.audio.available, true);
    assert.equal(note.audio.mediaId, uploaded.media.mediaId.slice('still-media:'.length));
    const consumed = await runtime.audioHttpApi.inspectUpload(admission, uploadId);
    assert.deepEqual(consumed.consumption, { commandId: adoptionCommandId, noteId: captureId, noteRevision: note.revision });

    const head = await runtime.audioHttpApi.openMedia(admission, note.audio.mediaId, { method: 'HEAD', range: 'bytes=0-3' });
    assert.equal(head.status, 206);
    assert.equal(head.headers['Content-Range'], `bytes 0-3/${audio.byteLength}`);
    assert.equal(head.body, undefined);
    const range = await runtime.audioHttpApi.openMedia(admission, note.audio.mediaId, { method: 'GET', range: 'bytes=0-3' });
    assert.equal(range.status, 206);
    const returned = Buffer.concat(await Array.fromAsync((async function* () { for await (const part of range.body) yield part; })()));
    assert.deepEqual(returned, audio.subarray(0, 4));
    let admissionChecks = 0;
    const revokedAfterOpen = { sessionToken: userSession, assertCurrent() {
      admissionChecks += 1;
      if (admissionChecks === 3) throw new Error('synthetic admission revocation after open');
      kernel.getOwnedIdentity(userSession);
    } };
    await assert.rejects(runtime.audioHttpApi.openMedia(revokedAfterOpen, note.audio.mediaId, { method: 'GET' }),
      /synthetic admission revocation after open/);
    assert.equal(admissionChecks, 3, 'the final gateway fence ran after the repository returned a body');
    await runtime.audioHttpApi.openMedia(admission, note.audio.mediaId, { method: 'HEAD' });
    assert.deepEqual(calls, [], 'construction and local controller work make no provider request');
  } finally {
    try { await runtime.drainAndDispose(); } finally {
      try { await actors.closeAfterDrain(async () => {}); } finally { vault.close(); kernel.close();
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  }
});
