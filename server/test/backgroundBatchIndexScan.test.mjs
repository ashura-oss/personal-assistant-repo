import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';

const OPENROUTER_BATCH_MODEL = 'openai/gpt-6-luna:batch';
test('idle scheduler rescans use the backfilled Batch metadata index without rereading workspace content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-batch-idle-index-'));
  mkdirSync(join(directory, 'public'), { recursive: true });
  let opened;
  let actors;
  let runtime;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  let pageReads = 0;
  let snapshotReads = 0;
  try {
    const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
      STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') }, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
    const initial = createInitialWorkspaceState(randomUUID, { mode: 'local', llmProvider: 'openrouter',
      openRouterModel: OPENROUTER_BATCH_MODEL, openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
    opened = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => initial });
    const enrolled = await opened.foundation.auth.enrollOwner('batch idle synthetic fixture password', initial);
    const { kernel, vault } = opened.privateContext;
    const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, Date.now() + 60 * 60_000);
    kernel.withOwnedTransaction(actor, 0, (context) => vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0,
      'test-only-synthetic-openrouter-key'));
    opened.privateContext.startup.beginRecovery();
    opened.privateContext.startup.seal();
    actors = new ProcessWorkspaceActors(kernel);
    const originalReadSnapshot = kernel.readOwnedSnapshotWithinTransaction.bind(kernel);
    kernel.readOwnedSnapshotWithinTransaction = (...args) => { snapshotReads += 1; return originalReadSnapshot(...args); };
    globalThis.setTimeout = (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      scheduled.push(timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => { if (timer && typeof timer === 'object') timer.cancelled = true; };
    const factory = createProductionApplicationRuntimeFactory(config, { fetcher: async () => {
      throw new Error('idle empty index must not perform provider work');
    } });
    runtime = factory({ kernel, vault, auth: opened.foundation.auth,
      runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => { pageReads += 1; return actors.listWorkspaceMetadataPage(afterWorkspaceId, limit); },
      processInstanceId: opened.privateContext.processInstanceId });
    assert.equal(snapshotReads, 1, 'startup performs the one content backfill');

    const waitForNextScan = async (before) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (pageReads > before && scheduled.some((timer) => !timer.cancelled)) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`idle scheduler scan did not finish: pages=${pageReads}`);
    };
    for (let scan = 0; scan < 3; scan += 1) {
      const before = pageReads;
      const timer = scheduled.find((candidate) => !candidate.cancelled);
      assert.ok(timer, 'scheduler should retain one next timer');
      timer.cancelled = true;
      timer.callback();
      await waitForNextScan(before);
      // Let the scan reach its finally/rearm path before triggering the next tick.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(snapshotReads, 1, 'timer scans must use index metadata after the startup backfill');
    }
  } finally {
    if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (actors) await actors.closeAfterDrain(async () => {});
    if (opened) opened.foundation.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
