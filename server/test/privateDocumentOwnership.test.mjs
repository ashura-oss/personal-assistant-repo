import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel, SecretVault } from '../dist/index.js';
import { OwnedWorkspaceRuntime } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionWorkspacePortsFor } from '../dist/applicationHost.node.mjs';

test('production private document file and directory close failures retain exact handles until explicit retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-private-document-owner-'));
  const dataDirectory = join(directory, 'private', 'data');
  const kernel = createDurableKernel({ databasePath: join(directory, 'private', 'workspace.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const vault = new SecretVault(kernel, randomBytes(32));
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, createInitialWorkspaceState(randomUUID));
  const actors = new ProcessWorkspaceActors(kernel);
  const admissionFor = () => kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  let admissionSession = admissionFor();
  let epoch = 0;
  let controller;
  let target = 'temporary-file';
  let closeAttempts = 0;
  let directoryHandleNumber = 0;
  let firstDirectoryCloseEntered;
  const firstDirectoryCloseStarted = new Promise((resolve) => { firstDirectoryCloseEntered = resolve; });
  let releaseFirstDirectoryClose;
  const firstDirectoryCloseGate = new Promise((resolve) => { releaseFirstDirectoryClose = resolve; });
  let secondDirectoryClosed;
  const secondDirectoryCloseFinished = new Promise((resolve) => { secondDirectoryClosed = resolve; });
  const directoryCloseCounts = [];
  const basePorts = createProductionWorkspacePortsFor({ dataDirectory }, {
    fetcher: async () => { throw new Error('provider calls are forbidden in this test'); },
    documentFileOperations: {
      async mkdir(path, options) { const { mkdir } = await import('node:fs/promises'); return mkdir(path, options); },
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        const isTargetHandle = target === 'temporary-file' ? flags === 'wx' : flags === 'r';
        const directoryHandleId = flags === 'r' ? ++directoryHandleNumber : undefined;
        return { async writeFile(data, options) { await handle.writeFile(data, options); },
          async sync() { await handle.sync(); },
          async close() {
            if (target === 'concurrent' && directoryHandleId !== undefined) {
              directoryCloseCounts[directoryHandleId - 1] = (directoryCloseCounts[directoryHandleId - 1] ?? 0) + 1;
              if (directoryHandleId === 1) {
                firstDirectoryCloseEntered();
                await firstDirectoryCloseGate;
              }
              await handle.close();
              if (directoryHandleId === 2) secondDirectoryClosed();
              return;
            }
            if (isTargetHandle && ++closeAttempts <= 3) throw new Error('synthetic close failure');
            await handle.close();
          } };
      },
      async lstat(path) { const { lstat } = await import('node:fs/promises'); return lstat(path); },
      async rename(from, to) { const { rename } = await import('node:fs/promises'); return rename(from, to); },
      async unlink(path) { const { unlink } = await import('node:fs/promises'); return unlink(path); },
    },
  });
  const runtime = new OwnedWorkspaceRuntime({ kernel,
    runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
    crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    workspacePortsFor: async (context) => {
      const ports = await basePorts(context, vault, kernel);
      return { ...ports, attachController(instance) { ports.attachController(instance); controller = instance; } };
    } });
  const admission = () => ({ sessionToken: admissionSession, assertCurrent() { kernel.getOwnedIdentity(admissionSession); } });
  const advanceEpoch = () => {
    kernel.runLocalCommand(admissionSession, { expectedRevision: kernel.getOwnedIdentity(admissionSession).revision,
      expectedPrivacyEpoch: epoch, idempotencyKey: randomUUID(), type: 'test.privacy-advance', canonicalRequest: '{}' },
      (context) => ({ snapshot: context.snapshot, privacyEpoch: epoch + 1, receipt: { advanced: true } }));
    epoch += 1;
    admissionSession = admissionFor();
  };
  const disposeOldEpoch = async (oldEpoch) => {
    await assert.rejects(runtime.refreshSnapshot(admission()), /private_document_cleanup_pending/);
    await assert.rejects(runtime.retryFailedWorkspaceDisposal(admission(), oldEpoch), /private_document_cleanup_pending/);
    assert.doesNotThrow(() => kernel.getOwnedIdentity(admissionSession), 'the authoritative newer workspace remains available');
    await runtime.retryFailedWorkspaceDisposal(admission(), oldEpoch);
  };
  try {
    await runtime.refreshSnapshot(admission());
    await controller.saveDocument('notes/file-close.md', 'first private document');
    assert.equal(closeAttempts, 1, 'the initial temporary-file close failed once');
    advanceEpoch();
    await disposeOldEpoch(0);
    assert.equal(closeAttempts, 4, 'the exact temporary file was retried only through explicit disposal');
    const filePath = join(dataDirectory, 'private-documents', ownerId, workspace.workspaceId, '0', 'notes', 'file-close.md');
    assert.equal(existsSync(filePath), false);

    target = 'directory'; closeAttempts = 0;
    await runtime.refreshSnapshot(admission());
    await controller.saveDocument('notes/directory-close.md', 'second private document');
    assert.equal(closeAttempts, 1, 'the directory close failed after the file was atomically renamed');
    advanceEpoch();
    await disposeOldEpoch(1);
    assert.equal(closeAttempts, 4, 'the exact directory handle was retried through explicit disposal');
    const directoryPath = join(dataDirectory, 'private-documents', ownerId, workspace.workspaceId, '1', 'notes', 'file-close.md');
    assert.equal(readFileSync(directoryPath, 'utf8'), 'first private document');

    await runtime.refreshSnapshot(admission());
    target = 'concurrent'; directoryHandleNumber = 0;
    const firstSave = controller.saveDocument('notes/concurrent-a.md', 'first concurrent document');
    const secondSave = controller.saveDocument('notes/concurrent-b.md', 'second concurrent document');
    try {
      await firstDirectoryCloseStarted;
      const secondClosed = await Promise.race([
        secondDirectoryCloseFinished.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      assert.equal(secondClosed, true, 'the second directory descriptor closes while the first descriptor is still owned');
    } finally {
      releaseFirstDirectoryClose();
    }
    await Promise.all([firstSave, secondSave]);
    assert.deepEqual(directoryCloseCounts, [1, 1], 'each distinct directory handle is closed exactly once without a fallback close');
    advanceEpoch();
    await runtime.refreshSnapshot(admission());
    assert.doesNotThrow(() => kernel.getOwnedIdentity(admissionSession), 'concurrent cleanup preserves the newly authoritative epoch');
  } finally {
    await runtime.closeAfterDrain().catch(() => undefined);
    try { await actors.closeAfterDrain(async () => {}); } finally {
      try { vault.close(); } finally { kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  }
});
