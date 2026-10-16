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

test('production reminder commands save exact generations and revoke consent on cancel, completion, and delete', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-reminder-commands-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'private', 'workspace.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const vault = new SecretVault(kernel, randomBytes(32));
  const auth = new AuthService(kernel, { canonicalOrigin: 'https://app.example.test', authSecret: randomBytes(32) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, createInitialWorkspaceState(randomUUID));
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const actors = new ProcessWorkspaceActors(kernel);
  const runtime = await createProductionApplicationRuntimeFactory({ dataDirectory: join(directory, 'private', 'data'),
    canonicalOrigin: 'https://app.example.test' }, { fetcher: async () => { throw new Error('reminder commands must not contact providers'); } })({
    kernel, vault, auth, runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
    listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
    processInstanceId: randomUUID(), createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID),
  });
  const admission = Object.freeze({ sessionToken, assertCurrent: () => kernel.getOwnedIdentity(sessionToken) });
  const dispatch = async (command, commandId = randomUUID()) => {
    const snapshot = await runtime.workspaceApi.getSnapshot(admission);
    const envelope = { schemaVersion: 1, commandId, expectedRevision: snapshot.revision,
      expectedPrivacyEpoch: snapshot.privacyEpoch, command };
    const result = await runtime.workspaceApi.dispatchCommand(admission, envelope);
    assert.equal(result.status, 'finished');
    assert.equal(result.receipt.commandId, commandId);
    return { result, envelope };
  };
  const readRecords = async () => (await runtime.workspaceApi.getSnapshot(admission)).state.reminders.records;
  const readPolicy = (commandId) => kernel.withTrustedDatabaseTransaction((db) => {
    const saved = db.prepare(`SELECT receipt_json FROM background_policy_commands WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND command_id=?`)
      .get(workspace.workspaceId, ownerId, commandId);
    if (!saved) return undefined;
    const receipt = JSON.parse(saved.receipt_json);
    const head = db.prepare(`SELECT current_revision,status FROM background_policy_heads WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND policy_id=?`)
      .get(workspace.workspaceId, ownerId, receipt.policyId);
    const revision = db.prepare(`SELECT specification_json FROM background_policy_revisions WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND policy_id=? AND revision=1`)
      .get(workspace.workspaceId, ownerId, receipt.policyId);
    return { receipt, head, specification: revision ? JSON.parse(revision.specification_json) : undefined };
  });

  try {
    const payload = { title: 'Review medicine', body: 'Private note', dueAt: '2099-11-02T09:30:00.000Z',
      displayTimeZone: 'Asia/Singapore', privacyMode: 'private' };
    const created = await dispatch({ kind: 'reminders.createDraft', payload });
    const reminderId = created.result.receipt.reminderId;
    assert.equal(created.result.receipt.reminderStatus, 'draft');
    const edited = await dispatch({ kind: 'reminders.editDraft', reminderId, expectedReminderRevision: 1,
      payload: { ...payload, title: 'Review medicine tomorrow' } });
    assert.equal(edited.result.receipt.reminderRevision, 2);
    assert.equal(edited.result.receipt.reminderStatus, 'draft');
    const approved = await dispatch({ kind: 'reminders.approve', reminderId, expectedReminderRevision: 2 });
    assert.equal(approved.result.receipt.reminderStatus, 'approved');

    const deviceId = randomUUID();
    const selectedGeneration = 7;
    const saveCommandId = randomUUID();
    const save = await dispatch({ kind: 'reminders.serverSave', reminderId, expectedReminderRevision: 2,
      deviceSelection: { subscriptions: [{ subscriptionId: deviceId, generation: selectedGeneration }] } }, saveCommandId);
    assert.equal(save.result.receipt.reminderStatus, 'saved');
    const storedPolicy = readPolicy(saveCommandId);
    assert.equal(storedPolicy.head.status, 'enabled');
    assert.deepEqual(storedPolicy.specification.devices, { subscriptions: [{ subscriptionId: deviceId, generation: selectedGeneration }] });
    const inspected = runtime.workspaceApi.inspectCommand(admission, saveCommandId);
    assert.equal(inspected.status, 'finished');
    const replay = await runtime.workspaceApi.dispatchCommand(admission, save.envelope);
    assert.deepEqual(replay.receipt, save.result.receipt, 'a lost acknowledgement is recovered from the original durable command receipt');
    assert.equal(kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_policy_heads
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`).get(workspace.workspaceId, ownerId).count), 1,
      'exact save replay does not create a second consent policy');

    const cancelled = await dispatch({ kind: 'reminders.cancel', reminderId, expectedReminderRevision: 2 });
    assert.equal(cancelled.result.receipt.reminderStatus, 'cancelled');
    assert.equal(readPolicy(saveCommandId).head.status, 'revoked');

    const makeSaved = async (title) => {
      const draft = await dispatch({ kind: 'reminders.createDraft', payload: { ...payload, title } });
      const id = draft.result.receipt.reminderId;
      await dispatch({ kind: 'reminders.approve', reminderId: id, expectedReminderRevision: 1 });
      const commandId = randomUUID();
      const saved = await dispatch({ kind: 'reminders.serverSave', reminderId: id, expectedReminderRevision: 1,
        deviceSelection: { subscriptions: [{ subscriptionId: deviceId, generation: selectedGeneration }] } }, commandId);
      return { id, commandId, saved };
    };
    const editedSaved = await makeSaved('Change this reminder');
    const savedSnapshot = kernel.getOwnedSnapshot(sessionToken).snapshot;
    const previousIntentId = savedSnapshot.reminders.records.find((record) => record.id === editedSaved.id).currentIntentId;
    const changedSaved = await dispatch({ kind: 'reminders.editDraft', reminderId: editedSaved.id, expectedReminderRevision: 1,
      payload: { ...payload, title: 'Changed reminder' } });
    assert.equal(changedSaved.result.receipt.reminderStatus, 'draft');
    assert.equal(changedSaved.result.receipt.reminderRevision, 2);
    const changedSnapshot = kernel.getOwnedSnapshot(sessionToken).snapshot;
    assert.equal(changedSnapshot.reminders.intents.find((intent) => intent.id === previousIntentId).desired, 'cancelled');
    assert.equal(readPolicy(editedSaved.commandId).head.status, 'revoked');

    const completed = await makeSaved('Take a walk');
    const done = await dispatch({ kind: 'reminders.complete', reminderId: completed.id, expectedReminderRevision: 1 });
    assert.equal(done.result.receipt.reminderStatus, 'completed');
    assert.equal(readPolicy(completed.commandId).head.status, 'revoked');

    const deleted = await makeSaved('Water the plant');
    const removed = await dispatch({ kind: 'reminders.delete', reminderId: deleted.id, expectedReminderRevision: 1 });
    assert.equal(removed.result.receipt.deleted, true);
    assert.equal(readPolicy(deleted.commandId).head.status, 'revoked');
    assert.equal((await readRecords()).some((record) => record.id === deleted.id), false);
  } finally {
    try { await runtime.drainAndDispose(); } finally {
      try { await actors.closeAfterDrain(async () => {}); } finally {
        auth.close(); vault.close(); kernel.close();
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  }
});
