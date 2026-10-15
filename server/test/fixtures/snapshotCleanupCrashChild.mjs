import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createDurableKernel } from '../../dist/kernel.js';
import { PrivateAudioRepository } from '../../dist/privateAudioRepository.js';
import { ServerWorkspaceStore } from '../../dist/workspaceStore.js';

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
async function* chunks(bytes) { yield bytes; }

const [databasePath, privateRoot] = process.argv.slice(2);
if (!databasePath || !privateRoot) throw new Error('fixture_paths_required');
let kernel;
try {
  kernel = createDurableKernel({ databasePath, validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, { accounts: [], notes: [] });
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  let attached;
  const processId = randomUUID();
  const repository = new PrivateAudioRepository({ kernel, actorSessionToken: sessionToken, privateRoot, processId,
    resolveAttachedMedia: ({ workspaceId, ownerId: candidateOwnerId, privacyEpoch, noteId, noteRevision }) =>
      attached && workspaceId === workspace.workspaceId && candidateOwnerId === ownerId && privacyEpoch === 0 &&
      attached.mediaId && noteId === 'crash-child-note' && noteRevision === 1
        ? { mediaId: attached.mediaId, noteId, noteRevision, sha256: attached.sha256, byteLength: attached.byteLength } : undefined,
  });
  const data = wavFixture();
  const record = await repository.ingest(chunks(data), { fileName: 'crash.wav', mimeType: 'audio/wav' });
  kernel.runLocalCommand(sessionToken, { expectedRevision: 0, expectedPrivacyEpoch: 0, idempotencyKey: randomUUID(),
    type: 'workspace.snapshot.write', canonicalRequest: '{"fixture":"attach-before-crash"}' }, () => ({
    snapshot: { accounts: [], notes: [{ id: 'crash-child-note', revision: 1, audioUri: `still-media:${record.mediaId}` }] },
    receipt: { kind: 'fixture_seed' }, accountGenerations: {},
  }));
  attached = { mediaId: record.mediaId, sha256: record.sha256, byteLength: record.byteLength };
  const store = new ServerWorkspaceStore({ kernel, sessionToken,
    snapshotCommitParticipant: repository.createSnapshotCommitParticipant(),
    afterCommitForTesting() { throw new Error('simulated process loss after durable commit'); },
  });
  await store.load();
  await assert.rejects(store.save({ accounts: [], notes: [] }), /simulated process loss/);
  // Flush only the fixture identifiers, then terminate without kernel.close(),
  // repository drain, or any other orderly application shutdown path.
  process.stdout.write(JSON.stringify({ workspaceId: workspace.workspaceId, ownerId, mediaId: record.mediaId,
    uploadId: record.uploadId, processId, databasePath, privateRoot }), () => process.exit(73));
} catch (error) {
  try { kernel?.close(); } catch { /* Preserve the original fixture failure. */ }
  process.stderr.write(`${error instanceof Error ? error.message : 'child_fixture_failed'}\n`);
  process.exitCode = 1;
}
