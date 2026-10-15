import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel, SecretVault } from '../dist/index.js';
import { createProductionWorkspacePortsFor } from '../dist/applicationHost.node.mjs';
import { createWorkspaceHttpApi } from '../dist/workspaceHttp.node.mjs';
import { OwnedWorkspaceRuntime } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
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

async function* chunks(bytes) {
  yield bytes.subarray(0, 13);
  yield bytes.subarray(13, 511);
  yield bytes.subarray(511);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('production owned runtime atomically marks and physically cleans media on controller note deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-production-media-cleanup-'));
  const dataDirectory = join(directory, 'private-data');
  const calls = [];
  const firstMirrorFailure = deferred();
  const delayedSiblingStarted = deferred();
  const releaseDelayedSibling = deferred();
  let fileOpenCount = 0;
  let mirrorFaultInjectionEnabled = false;
  let closeFailuresRemaining = 2;
  let failNextCommitAck = false;
  const documentFileOperations = {
    mkdir, lstat, rename, unlink,
    async open(path, flags, mode) {
      if (flags !== 'wx') return open(path, flags, mode);
      if (!mirrorFaultInjectionEnabled) return open(path, flags, mode);
      const openedFileOrdinal = ++fileOpenCount;
      if (openedFileOrdinal === 1) {
        failNextCommitAck = true;
        firstMirrorFailure.resolve();
        const error = new Error('synthetic immediate mirror open failure');
        error.code = 'EIO';
        throw error;
      }
      if (openedFileOrdinal === 2) {
        delayedSiblingStarted.resolve();
        await releaseDelayedSibling.promise;
      }
      const handle = await open(path, flags, mode);
      return Object.freeze({
        writeFile: (value, options) => handle.writeFile(value, options),
        sync: () => handle.sync(),
        async close() {
          if (openedFileOrdinal === 2 && closeFailuresRemaining > 0) {
            closeFailuresRemaining -= 1;
            throw new Error('synthetic owned document handle close failure');
          }
          await handle.close();
        },
      });
    },
  };
  const kernel = createDurableKernel({ databasePath: join(dataDirectory, 'workspace.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const vault = new SecretVault(kernel, randomBytes(32));
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, createInitialWorkspaceState(randomUUID));
  const userSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const actors = new ProcessWorkspaceActors(kernel);
  const portsFor = createProductionWorkspacePortsFor({ dataDirectory }, {
    fetcher: async (input) => { calls.push(String(input)); throw new Error('provider access is forbidden in this test'); },
    documentFileOperations,
  });
  const runtime = new OwnedWorkspaceRuntime({ kernel, runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
    crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    afterWorkspaceCommitForTesting() {
      if (failNextCommitAck) { failNextCommitAck = false; throw new Error('synthetic mirror log acknowledgement loss'); }
    },
    workspacePortsFor: (context) => portsFor(context, vault, kernel),
  });
  const workspaceApi = createWorkspaceHttpApi(runtime);
  const audioHttpApi = runtime.createAudioHttpApi();
  const admission = { sessionToken: userSession, assertCurrent: () => kernel.getOwnedIdentity(userSession) };
  try {
    const uploadId = randomUUID();
    const captureId = randomUUID();
    const audio = wavFixture();
    const uploaded = await audioHttpApi.upload(admission, { uploadId,
      capture: { id: captureId, capturedAt: '2026-10-15T00:00:00.000Z', timeZone: 'Asia/Singapore' },
      mimeType: 'audio/wav', expectedByteLength: audio.byteLength, source: chunks(audio) });
    assert.equal(uploaded.status, 'ready');
    const beforeAdoption = await workspaceApi.getSnapshot(admission);
    const adoptionCommand = { schemaVersion: 1, commandId: randomUUID(),
      expectedRevision: beforeAdoption.revision, expectedPrivacyEpoch: beforeAdoption.privacyEpoch,
      command: { kind: 'notes.capture.adopt', captureId, captureRevision: uploaded.capture.revision },
    };
    mirrorFaultInjectionEnabled = true;
    const adoptionOutcome = workspaceApi.dispatchCommand(admission, adoptionCommand).then(
      (value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    await Promise.all([firstMirrorFailure.promise, delayedSiblingStarted.promise]);
    const settledBeforeSibling = await Promise.race([adoptionOutcome.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 25))]);
    releaseDelayedSibling.resolve();
    const outcome = await adoptionOutcome;
    assert.equal(settledBeforeSibling, false, 'capture acknowledgement waits until every started mirror sibling settles');
    assert.equal(outcome.ok, true, `capture completed with mirror failure: ${outcome.error instanceof Error ? outcome.error.message : 'unknown'}`);
    const adopted = outcome.value;
    failNextCommitAck = false;
    assert.equal(adopted.status, 'finished');
    assert.equal(adopted.snapshot.state.notes[0].id, captureId);
    assert.equal(adopted.snapshot.state.activity.some((item) => item.message.includes('Local document mirror')), false,
      'derived mirror failure does not write canonical activity');
    const mediaId = uploaded.media.mediaId.slice('still-media:'.length);
    const mediaPath = join(dataDirectory, 'private-audio', workspace.workspaceId, `${uploadId}.audio`);
    assert.equal(existsSync(mediaPath), true);

    const source = adopted.snapshot.state.notes[0];
    const identity = kernel.getOwnedIdentity(userSession);
    assert.equal(identity.revision, adopted.snapshot.revision);
    const replay = await workspaceApi.dispatchCommand(admission, adoptionCommand);
    assert.deepEqual(replay.receipt, adopted.receipt, 'adoption replay returns the exact finished receipt');
    assert.equal((await audioHttpApi.inspectUpload(admission, uploadId)).status, 'consumed');
    assert.equal(calls.length, 0, 'capture replay performs no provider request');
    const removed = await runtime.executeCommand({ sessionToken: userSession, assertCurrent: admission.assertCurrent,
      expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch, idempotencyKey: randomUUID(),
      kind: 'notes.delete', canonicalBody: `{"noteId":"${captureId}"}`,
    }, async (controller) => { await controller.deleteNote(captureId); return { noteId: captureId }; },
    (result) => ({ kind: 'notes.delete', noteId: result.noteId }));
    assert.equal(removed.snapshot.state.notes.some((note) => note.id === source.id), false);
    assert.equal(existsSync(mediaPath), false, 'production removeAudio consumes only the committed cleanup intent');
    const rows = kernel.withTrustedDatabaseTransaction((db) => ({
      intent: db.prepare(`SELECT status,media_id,snapshot_revision FROM private_audio_cleanup_intents WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`)
        .get(workspace.workspaceId, ownerId),
      audio: db.prepare(`SELECT status FROM private_audio_uploads WHERE media_id=? AND workspace_id=? AND owner_id=? AND privacy_epoch=0`)
        .get(mediaId, workspace.workspaceId, ownerId),
    }));
    assert.equal(rows.intent.status, 'complete');
    assert.equal(rows.intent.media_id, mediaId);
    assert.equal(rows.intent.snapshot_revision, identity.revision + 1);
    assert.equal(rows.audio.status, 'unavailable');
    assert.deepEqual(calls, [], 'local media upload, adoption and deletion make no provider request');

    await assert.rejects(runtime.closeAfterDrain(), /private_document_cleanup_pending/,
      'failed close retains ownership and makes runtime drain report pending cleanup');
    closeFailuresRemaining = 0;
    await runtime.closeAfterDrain();
  } finally {
    releaseDelayedSibling.resolve();
    closeFailuresRemaining = 0;
    try { await runtime.closeAfterDrain(); } finally {
      try { await actors.closeAfterDrain(async () => {}); } finally {
        vault.close(); kernel.close();
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }
});
