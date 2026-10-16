import { randomBytes, randomUUID, createECDH } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createDurableKernel, SecretVault } from '../../dist/index.js';
import { AuthService } from '../../dist/auth.js';
import { ProcessWorkspaceActors } from '../../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../../dist/applicationHost.node.mjs';

const [mode, databasePath, authSecretHex, vaultKeyHex, admittedPath, secondSendPath, reportPath] = process.argv.slice(2);
if (!['create', 'restart'].includes(mode) || !databasePath || !admittedPath || !secondSendPath || !reportPath) {
  throw new Error('reminder_crash_fixture_arguments_required');
}
const authSecret = authSecretHex ? Buffer.from(authSecretHex, 'hex') : randomBytes(32);
const vaultKey = vaultKeyHex ? Buffer.from(vaultKeyHex, 'hex') : randomBytes(32);
const kernel = createDurableKernel({ databasePath, validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reminder_crash_fixture_snapshot_invalid');
} });
const vault = new SecretVault(kernel, vaultKey);
const auth = new AuthService(kernel, { canonicalOrigin: 'https://app.example.test', authSecret });
const actors = new ProcessWorkspaceActors(kernel);
let sends = 0;
const runtime = await createProductionApplicationRuntimeFactory({ dataDirectory: `${databasePath}.data`,
  canonicalOrigin: 'https://app.example.test' }, { fetcher: async () => { throw new Error('reminder crash fixture must not call providers'); },
  createWebPushTransport: () => Object.freeze({
    async send(input) {
      sends += 1;
      if (mode === 'create') {
        input.assertBeforeDispatch();
        writeFileSync(admittedPath, JSON.stringify({ sends, admitted: true }));
        await new Promise(() => {});
      }
      writeFileSync(secondSendPath, JSON.stringify({ sends }));
      input.assertBeforeDispatch();
      return Object.freeze({ kind: 'accepted' });
    },
    stopAdmission() {},
    async drain() {},
  }) })({ kernel, vault, auth, runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
  listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
  processInstanceId: randomUUID(), createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });

const admissionFor = (sessionToken) => Object.freeze({ sessionToken, assertCurrent: () => kernel.getOwnedIdentity(sessionToken) });
const dispatch = async (admission, command) => {
  const snapshot = await runtime.workspaceApi.getSnapshot(admission);
  return runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: randomUUID(),
    expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch, command });
};

if (mode === 'create') {
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, createInitialWorkspaceState(randomUUID));
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const admission = admissionFor(sessionToken);
  const provision = runtime.webPushApi.provision(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0 });
  const deviceId = randomUUID();
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const registered = runtime.webPushApi.register(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId,
    keyId: provision.result.keyId, expectedPreviousGeneration: 0, subscription: { endpoint: `https://push.example.test/${randomUUID()}`,
      keys: { p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'), auth: randomBytes(16).toString('base64url') } } });
  const dueAt = new Date(Math.ceil((Date.now() + 3_000) / 1_000) * 1_000).toISOString();
  const created = await dispatch(admission, { kind: 'reminders.createDraft', payload: { title: 'Crash-window reminder',
    body: 'Synthetic private reminder body', dueAt, displayTimeZone: 'UTC', privacyMode: 'private' } });
  const reminderId = created.receipt.reminderId;
  await dispatch(admission, { kind: 'reminders.approve', reminderId, expectedReminderRevision: 1 });
  await dispatch(admission, { kind: 'reminders.serverSave', reminderId, expectedReminderRevision: 1,
    deviceSelection: { subscriptions: [{ subscriptionId: deviceId, generation: registered.result.generation }] } });
  const keepAlive = setInterval(() => {}, 1_000);
  writeFileSync(reportPath, JSON.stringify({ workspaceId: workspace.workspaceId, ownerId, deviceId, reminderId }));
  void keepAlive;
  await new Promise(() => {});
}

await new Promise((resolve) => setTimeout(resolve, 3_000));
const state = kernel.withTrustedDatabaseTransaction((db) => {
  const attempt = db.prepare(`SELECT attempt_id,occurrence_id,status,result_code,dispatch_admission_id FROM background_occurrence_attempts
    WHERE owner_id=(SELECT owner_id FROM workspaces LIMIT 1) AND privacy_epoch=0 ORDER BY claimed_at DESC LIMIT 1`).get();
  const occurrence = attempt ? db.prepare(`SELECT status FROM background_occurrences WHERE occurrence_id=?`)
    .get(attempt.occurrence_id)?.status : undefined;
  return { attempt, occurrence };
});
writeFileSync(reportPath, JSON.stringify({ sends, secondSendObserved: existsSync(secondSendPath), state }));
await runtime.drainAndDispose();
await actors.closeAfterDrain(async () => {});
auth.close(); vault.close(); kernel.close();
