import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createDurableKernel, SecretVault } from '../dist/index.js';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';

test('local HTTP production runtime rejects new reminder consent without changing snapshot or attempts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-reminder-local-http-'));
  const origin = 'http://localhost:3000';
  const kernel = createDurableKernel({ databasePath: join(directory, 'private', 'workspace.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const vault = new SecretVault(kernel, randomBytes(32));
  const auth = new AuthService(kernel, { canonicalOrigin: origin, allowLocalHttp: true, authSecret: randomBytes(32) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, createInitialWorkspaceState(randomUUID));
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const actors = new ProcessWorkspaceActors(kernel);
  const runtime = await createProductionApplicationRuntimeFactory({ dataDirectory: join(directory, 'private', 'data'),
    canonicalOrigin: origin, allowLocalHttp: true }, { fetcher: async () => { throw new Error('local reminder save must not contact providers'); } })({
    kernel, vault, auth, runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
    listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
    processInstanceId: randomUUID(), createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID),
  });
  const admission = Object.freeze({ sessionToken, assertCurrent: () => kernel.getOwnedIdentity(sessionToken) });
  const dispatch = async (command) => {
    const snapshot = await runtime.workspaceApi.getSnapshot(admission);
    return runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: randomUUID(), expectedRevision: snapshot.revision,
      expectedPrivacyEpoch: snapshot.privacyEpoch, command });
  };
  try {
    const payload = { title: 'Local reminder', body: 'Private note', dueAt: '2099-11-02T09:30:00.000Z',
      displayTimeZone: 'Asia/Singapore', privacyMode: 'private' };
    const draft = await dispatch({ kind: 'reminders.createDraft', payload });
    const reminderId = draft.receipt.reminderId;
    await dispatch({ kind: 'reminders.approve', reminderId, expectedReminderRevision: 1 });
    const before = await runtime.workspaceApi.getSnapshot(admission);
    await assert.rejects(dispatch({ kind: 'reminders.serverSave', reminderId, expectedReminderRevision: 1,
      deviceSelection: 'all_current' }), /background_reminder_delivery_unavailable/);
    assert.equal(kernel.getOwnedIdentity(sessionToken).revision, before.revision);
    assert.equal(kernel.getOwnedSnapshot(sessionToken).snapshot.reminders.records.find((record) => record.id === reminderId).status, 'approved');
    const persisted = kernel.withTrustedDatabaseTransaction((db) => ({
      policies: db.prepare(`SELECT COUNT(*) AS count FROM background_policy_heads WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`)
        .get(workspace.workspaceId, ownerId).count,
      occurrences: db.prepare(`SELECT COUNT(*) AS count FROM background_occurrences WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`)
        .get(workspace.workspaceId, ownerId).count,
    }));
    assert.deepEqual(persisted, { policies: 0, occurrences: 0 });
  } finally {
    try { await runtime.drainAndDispose(); } finally {
      try { await actors.closeAfterDrain(async () => {}); } finally {
        auth.close(); vault.close(); kernel.close();
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  }
});
