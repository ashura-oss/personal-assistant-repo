import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createECDH } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createDurableKernel, SecretVault } from '../dist/index.js';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';

const waitFor = async (predicate, timeoutMs = 15_000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('reminder_delivery_test_timeout');
};
const within = async (promise, label, timeoutMs = 20_000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
};
const waitForWorkspaceBusy = async (runtime, admission) => {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    try { await runtime.workspaceApi.getSnapshot(admission); }
    catch (error) {
      if (error instanceof Error && error.message === 'The workspace runtime is busy.') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('foreground_workspace_lane_not_busy');
};

function subscription() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://push.example.test/${randomUUID()}`, keys: {
    p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'), auth: randomBytes(16).toString('base64url'),
  } };
}

test('production scheduler dispatches one admitted reminder and suppresses a reminder cancelled before its final fence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-reminder-delivery-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'private', 'workspace.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const vault = new SecretVault(kernel, randomBytes(32));
  const auth = new AuthService(kernel, { canonicalOrigin: 'https://app.example.test', authSecret: randomBytes(32) });
  const enrolled = await auth.enrollOwner('synthetic reminder test password', createInitialWorkspaceState(randomUUID));
  const ownerId = enrolled.ownerId;
  const workspace = { workspaceId: enrolled.workspaceId };
  const loginChallenge = auth.createLoginChallenge('https://app.example.test');
  const sessionToken = (await auth.login({ password: 'synthetic reminder test password', origin: 'https://app.example.test',
    preAuthToken: loginChallenge.preAuthToken, csrfToken: loginChallenge.csrfToken })).sessionToken;
  const actors = new ProcessWorkspaceActors(kernel);
  let firstSendEntered;
  let releaseFirstSend;
  let secondSendEntered;
  let releaseSecondSend;
  let thirdSendEntered;
  let releaseThirdSend;
  let fifthSendEntered;
  let releaseFifthSend;
  let fifthResponseEntered;
  let releaseFifthResponse;
  let sixthSendEntered;
  let releaseSixthSend;
  let seventhSendEntered;
  let releaseSeventhSend;
  let eighthSendEntered;
  let releaseEighthSend;
  let ninthSendEntered;
  let releaseNinthSend;
  const firstEntered = new Promise((resolve) => { firstSendEntered = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirstSend = resolve; });
  const secondEntered = new Promise((resolve) => { secondSendEntered = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecondSend = resolve; });
  const thirdEntered = new Promise((resolve) => { thirdSendEntered = resolve; });
  const thirdGate = new Promise((resolve) => { releaseThirdSend = resolve; });
  const fifthEntered = new Promise((resolve) => { fifthSendEntered = resolve; });
  const fifthGate = new Promise((resolve) => { releaseFifthSend = resolve; });
  const fifthDispatched = new Promise((resolve) => { fifthResponseEntered = resolve; });
  const fifthResponseGate = new Promise((resolve) => { releaseFifthResponse = resolve; });
  const sixthEntered = new Promise((resolve) => { sixthSendEntered = resolve; });
  const sixthGate = new Promise((resolve) => { releaseSixthSend = resolve; });
  const seventhEntered = new Promise((resolve) => { seventhSendEntered = resolve; });
  const seventhGate = new Promise((resolve) => { releaseSeventhSend = resolve; });
  const eighthEntered = new Promise((resolve) => { eighthSendEntered = resolve; });
  const eighthGate = new Promise((resolve) => { releaseEighthSend = resolve; });
  const ninthEntered = new Promise((resolve) => { ninthSendEntered = resolve; });
  const ninthGate = new Promise((resolve) => { releaseNinthSend = resolve; });
  let sends = 0;
  let authorizedBytes = 0;
  let expireNext = false;
  let loseAdmissionAckNext = false;
  let loseSettlementAck;
  const createTransport = () => Object.freeze({
    async send(input) {
      sends += 1;
      if (sends === 1) {
        firstSendEntered();
        await firstGate;
      } else if (sends === 2) {
        secondSendEntered();
        await secondGate;
      } else if (sends === 3) {
        thirdSendEntered();
        await thirdGate;
      } else if (sends === 5) {
        fifthSendEntered();
        await fifthGate;
      } else if (sends === 6) {
        sixthSendEntered();
        await sixthGate;
      } else if (sends === 7) {
        seventhSendEntered();
        await seventhGate;
      } else if (sends === 8) {
        eighthSendEntered();
        await eighthGate;
      } else if (sends === 9) {
        ninthSendEntered();
        await ninthGate;
      }
      try {
        input.assertBeforeDispatch();
        authorizedBytes += 1;
        if (sends === 5 && expireNext) {
          fifthResponseEntered();
          await fifthResponseGate;
          return Object.freeze({ kind: 'expired', statusCode: 410 });
        }
        return Object.freeze({ kind: 'accepted' });
      } catch {
        return Object.freeze({ kind: 'not_started', reason: 'authorization_changed' });
      }
    },
    stopAdmission() {},
    async drain() {},
  });
  const runtime = await createProductionApplicationRuntimeFactory({ dataDirectory: join(directory, 'private', 'data'),
    canonicalOrigin: 'https://app.example.test' }, { fetcher: async () => { throw new Error('reminder delivery must not contact providers'); },
    createWebPushTransport: createTransport })({
    kernel, vault, auth, runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
    listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
    processInstanceId: randomUUID(), createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID),
  });
  const originalWithOwnedTransaction = kernel.withOwnedTransaction.bind(kernel);
  kernel.withOwnedTransaction = function (sessionToken, expectedPrivacyEpoch, operation) {
    const result = originalWithOwnedTransaction(sessionToken, expectedPrivacyEpoch, operation);
    if (loseAdmissionAckNext) {
      const admitted = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND status='dispatching' AND dispatch_admission_id IS NOT NULL`)
        .get(workspace.workspaceId, ownerId).count);
      if (admitted > 0) {
        loseAdmissionAckNext = false;
        throw new Error('synthetic_dispatch_admission_ack_lost_after_commit');
      }
    }
    if (loseSettlementAck) {
      const settled = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND target_id=? AND target_generation=? AND status='completed' AND result_code='push_accepted'`)
        .get(workspace.workspaceId, ownerId, deviceId, loseSettlementAck.generation).count);
      if (settled > loseSettlementAck.baseline) {
        loseSettlementAck = undefined;
        throw new Error('synthetic_settlement_ack_lost_after_commit');
      }
    }
    return result;
  };
  const admission = Object.freeze({ sessionToken, assertCurrent: () => kernel.getOwnedIdentity(sessionToken) });
  const dispatch = async (command) => {
    const snapshot = await runtime.workspaceApi.getSnapshot(admission);
    return runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: randomUUID(),
      expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch, command });
  };
  const saveReminder = async (title, deviceSelection = { subscriptions: [
    { subscriptionId: deviceId, generation: 1 }, { subscriptionId: unavailableDeviceId, generation: 1 },
  ] }) => {
    const dueAt = new Date(Math.ceil((Date.now() + 8_000) / 1_000) * 1_000).toISOString();
    const payload = { title, body: 'Private reminder details', dueAt, displayTimeZone: 'Asia/Singapore', privacyMode: 'private' };
    const created = await dispatch({ kind: 'reminders.createDraft', payload });
    const reminderId = created.receipt.reminderId;
    await dispatch({ kind: 'reminders.approve', reminderId, expectedReminderRevision: 1 });
    const saved = await dispatch({ kind: 'reminders.serverSave', reminderId, expectedReminderRevision: 1,
      deviceSelection });
    return { reminderId, revision: saved.receipt.reminderRevision };
  };
  const deviceId = '00000000-0000-4000-8000-000000000002';
  const unavailableDeviceId = '00000000-0000-4000-8000-000000000001';
  try {
    const provision = runtime.webPushApi.provision(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0 });
    runtime.webPushApi.register(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId,
      keyId: provision.result.keyId, expectedPreviousGeneration: 0, subscription: subscription() });
    runtime.webPushApi.register(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId: unavailableDeviceId,
      keyId: provision.result.keyId, expectedPreviousGeneration: 0, subscription: subscription() });
    const rotated = runtime.webPushApi.rotate(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      expectedActiveKeyId: provision.result.keyId });
    assert.notEqual(rotated.result.keyId, provision.result.keyId, 'the due-time device keeps its retained VAPID key after rotation');
    runtime.webPushApi.revoke(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      deviceId: unavailableDeviceId, expectedGeneration: 1 });

    const unrelatedEditReminder = await saveReminder('Private reminder one');
    await within(firstEntered, 'first_reminder_transport_not_entered');
    await dispatch({ kind: 'chat.create', title: 'An unrelated workspace edit' });
    releaseFirstSend();
    await waitFor(() => authorizedBytes === 1);

    const cancelled = await saveReminder('Private reminder two');
    await within(secondEntered, 'second_reminder_transport_not_entered');
    await dispatch({ kind: 'reminders.cancel', reminderId: cancelled.reminderId, expectedReminderRevision: cancelled.revision });
    releaseSecondSend();
    await waitFor(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`).get(workspace.workspaceId, ownerId).count) === 4);
    assert.equal(authorizedBytes, 1, 'cancellation is rechecked at dispatch while an unrelated edit does not invalidate consent');
    const unavailable = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND target_id=? AND result_code='push_not_started_subscription_unavailable'`)
      .get(workspace.workspaceId, ownerId, unavailableDeviceId).count);
    assert.equal(unavailable, 2, 'each exact unavailable generation closes as skipped while healthy siblings remain eligible');
    assert.equal(sends, 2, 'the existing scheduler makes one transport attempt per healthy frozen target');

    await saveReminder('Retry while the workspace lane is busy');
    await within(thirdEntered, 'third_reminder_transport_not_entered');
    const currentSnapshot = await runtime.workspaceApi.getSnapshot(admission);
    const foregroundCommand = runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: randomUUID(),
      expectedRevision: currentSnapshot.revision, expectedPrivacyEpoch: currentSnapshot.privacyEpoch,
      command: { kind: 'chat.create', title: 'Hold the foreground workspace lane' } });
    await within(waitForWorkspaceBusy(runtime, admission), 'foreground_workspace_lane_not_acquired');
    releaseThirdSend();
    await waitFor(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND result_code='foreground_reminder_busy'`)
      .get(workspace.workspaceId, ownerId).count) === 1);
    await waitFor(() => authorizedBytes === 2);
    assert.equal(sends, 4, 'a proven pre-admission busy result is durably deferred and sent once after the lane clears');

    expireNext = true;
    await saveReminder('Exact generation expiry');
    await within(fifthEntered, 'expired_generation_transport_not_entered');
    releaseFifthSend();
    await within(fifthDispatched, 'expired_generation_not_dispatched');
    const replacement = runtime.webPushApi.register(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId,
      keyId: rotated.result.keyId, expectedPreviousGeneration: 1, subscription: subscription() });
    assert.equal(replacement.result.generation, 2);
    releaseFifthResponse();
    await waitFor(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND target_id=? AND result_code='push_expired_410'`)
      .get(workspace.workspaceId, ownerId, deviceId).count) === 1);
    assert.deepEqual(runtime.webPushApi.listSubscriptions(admission).subscriptions.find((item) => item.deviceId === deviceId),
      { deviceId, generation: 2, status: 'active', keyId: rotated.result.keyId, updatedAt: replacement.result.updatedAt },
      'a late expiry for generation 1 cannot revoke its replacement');

    runtime.webPushApi.revoke(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId, expectedGeneration: 2 });
    await saveReminder('No devices at due time', 'all_current');
    await waitFor(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrences
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND policy_kind='approved_reminder_delivery'`).get(workspace.workspaceId, ownerId).count) === 5);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(sends, 5, 'settled reminders and empty due-time target sets are not sent or rematerialized');

    const generationThree = runtime.webPushApi.register(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId,
      keyId: rotated.result.keyId, expectedPreviousGeneration: 2, subscription: subscription() });
    loseAdmissionAckNext = true;
    await saveReminder('Admitted outcome remains inspect only', { subscriptions: [
      { subscriptionId: deviceId, generation: generationThree.result.generation },
    ] });
    await within(sixthEntered, 'ambiguous_reminder_transport_not_entered');
    releaseSixthSend();
    await waitFor(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND result_code='push_ambiguous_transport_failure'`)
      .get(workspace.workspaceId, ownerId).count) === 1, 5_000);
    assert.equal(kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT status FROM background_occurrences
      WHERE occurrence_id=(SELECT occurrence_id FROM background_occurrence_attempts WHERE workspace_id=? AND owner_id=?
        AND privacy_epoch=0 AND result_code='push_ambiguous_transport_failure' LIMIT 1)`)
      .get(workspace.workspaceId, ownerId)?.status),
      'inspect_required', 'an admitted ambiguous outcome is retained for inspection and never retried');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(sends, 6, 'a commit with a lost admission acknowledgement is inspected and never automatically resent');

    const settlementBaseline = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND target_id=? AND target_generation=3 AND status='completed' AND result_code='push_accepted'`)
      .get(workspace.workspaceId, ownerId, deviceId).count);
    loseSettlementAck = { generation: 3, baseline: settlementBaseline };
    await saveReminder('Settlement acknowledgement can be lost', { subscriptions: [
      { subscriptionId: deviceId, generation: generationThree.result.generation },
    ] });
    await within(seventhEntered, 'settlement_ack_reminder_transport_not_entered');
    releaseSeventhSend();
    await waitFor(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND target_id=? AND target_generation=3 AND status='completed' AND result_code='push_accepted'`)
      .get(workspace.workspaceId, ownerId, deviceId).count) === settlementBaseline + 1);
    assert.equal(loseSettlementAck, undefined, 'the test lost the acknowledgement only after settlement committed');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(sends, 7, 'a settled attempt recovered after a lost acknowledgement is not sent again');

    const bytesBeforeEraseFence = authorizedBytes;
    await saveReminder('Erase hold blocks an unadmitted reminder', { subscriptions: [
      { subscriptionId: deviceId, generation: generationThree.result.generation },
    ] });
    await within(eighthEntered, 'shutdown_reminder_transport_not_entered');
    const eraseCommandId = randomUUID();
    const eraseReview = await within(runtime.workspaceApi.prepareWorkspaceErase(admission, {
      commandId: eraseCommandId, expectedRevision: (await runtime.workspaceApi.getSnapshot(admission)).revision,
      expectedPrivacyEpoch: 0,
    }), 'reminder_erase_prepare_did_not_finish', 15_000);
    assert.equal(eraseReview.status, 'prepared');
    releaseEighthSend();
    await waitFor(() => kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT COUNT(*) AS count FROM background_occurrence_attempts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND result_code='push_not_started_authorization_changed'`)
      .get(workspace.workspaceId, ownerId).count) === 1);
    assert.equal(authorizedBytes, bytesBeforeEraseFence, 'an erase hold established before final dispatch prevents transport bytes');
    assert.equal(sends, 8);
    await runtime.workspaceApi.cancelWorkspaceErase(admission, { commandId: eraseCommandId,
      expectedRevision: eraseReview.expectedRevision, expectedPrivacyEpoch: 0 });

    await saveReminder('Shutdown drains an admitted reminder', { subscriptions: [
      { subscriptionId: deviceId, generation: generationThree.result.generation },
    ] });
    await within(ninthEntered, 'shutdown_reminder_transport_not_entered');
    const draining = runtime.drainAndDispose();
    let drained = false;
    void draining.then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false, 'drain remains pending while the admitted transport owns its socket');
    releaseNinthSend();
    await within(draining, 'shutdown_did_not_drain_reminder_transport');
    assert.equal(sends, 9, 'shutdown waits for the admitted transport and does not start a duplicate send');
  } finally {
    releaseFirstSend?.();
    releaseSecondSend?.();
    releaseThirdSend?.();
    releaseFifthSend?.();
    releaseFifthResponse?.();
    releaseSixthSend?.();
    releaseSeventhSend?.();
    releaseEighthSend?.();
    releaseNinthSend?.();
    try { await within(runtime.drainAndDispose(), 'reminder_runtime_drain_timeout', 30_000); } finally {
      try { await actors.closeAfterDrain(async () => {}); } finally {
        auth.close(); vault.close(); kernel.close();
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  }
});
