import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createDurableKernel } from '../dist/kernel.js';
import { SecretVault } from '../dist/vault.js';
import { WorkspaceEraseService } from '../dist/workspaceErase.js';
import { WebPushSubscriptions } from '../dist/webPushSubscriptions.js';
import { createWebPushTransport } from '../dist/webPushTransport.js';
import { createWebPushDeliveryDispatcher } from '../dist/webPushDelivery.js';

const ORIGIN = 'https://still.example';
const EMPTY = Object.freeze({ accounts: [], documents: [], tasks: [], notes: [], proposals: [], backgroundPolicies: [] });

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-web-push-delivery-'));
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(directory, 'kernel.sqlite'), now: () => now,
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, authSecret: randomBytes(32), now: () => now });
  const enrolled = await auth.enrollOwner('synthetic-delivery-test-password', EMPTY);
  const challenge = auth.createLoginChallenge(ORIGIN);
  const login = await auth.login({ password: 'synthetic-delivery-test-password', origin: ORIGIN,
    preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
  const vault = new SecretVault(kernel, randomBytes(32));
  new WorkspaceEraseService({ kernel, auth, vault, createEmptySnapshot: () => EMPTY, now: () => now });
  const service = new WebPushSubscriptions(kernel, vault, () => undefined, { now: () => now });
  kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TABLE web_push_delivery_test_attempts(
    workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL, attempt_id TEXT NOT NULL,
    device_id TEXT NOT NULL, generation INTEGER NOT NULL, key_id TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('ready','dispatch_admitted','settled')),
    consent_enabled INTEGER NOT NULL CHECK(consent_enabled IN (0,1)), source_enabled INTEGER NOT NULL CHECK(source_enabled IN (0,1)),
    admission_id TEXT, outcome_json TEXT, PRIMARY KEY(workspace_id,owner_id,privacy_epoch,attempt_id)) STRICT`));
  const admission = Object.freeze({ sessionToken: login.sessionToken, assertCurrent() { kernel.getOwnedIdentity(login.sessionToken); } });
  const ownerId = kernel.getOwnedIdentity(login.sessionToken).ownerId;
  return { directory, kernel, auth, vault, service, admission, login, enrolled, ownerId,
    setConsent(attemptId, enabled) { kernel.withTrustedDatabaseTransaction((db) => db.prepare(
      'UPDATE web_push_delivery_test_attempts SET consent_enabled=? WHERE attempt_id=?').run(enabled ? 1 : 0, attemptId)); },
    setSource(attemptId, enabled) { kernel.withTrustedDatabaseTransaction((db) => db.prepare(
      'UPDATE web_push_delivery_test_attempts SET source_enabled=? WHERE attempt_id=?').run(enabled ? 1 : 0, attemptId)); },
    row(attemptId) { return kernel.withTrustedDatabaseTransaction((db) => db.prepare(
      'SELECT state,outcome_json FROM web_push_delivery_test_attempts WHERE attempt_id=?').get(attemptId)); },
    close() { vault.close(); auth.close(); kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

function createSubscription() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return Object.freeze({ endpoint: `https://push.example.test/send/${randomUUID()}`,
    keys: Object.freeze({ p256dh: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'), auth: randomBytes(16).toString('base64url') }) });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test_wait_condition_timed_out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createHarness(f, options = {}) {
  const provision = f.service.provision(f.admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0 });
  const subscription = createSubscription();
  const registered = f.service.register(f.admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId: randomUUID(),
    keyId: provision.result.keyId, expectedPreviousGeneration: 0, subscription });
  const claim = Object.freeze({ attemptId: randomUUID(), workspaceId: f.enrolled.workspaceId, ownerId: f.ownerId,
    privacyEpoch: 0, deviceId: registered.result.deviceId, generation: 1, keyId: provision.result.keyId, kind: options.kind ?? 'reminder' });
  f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`INSERT INTO web_push_delivery_test_attempts(workspace_id,owner_id,privacy_epoch,
    attempt_id,device_id,generation,key_id,kind,state,consent_enabled,source_enabled) VALUES(?,?,?,?,?,?,?,?, 'ready',1,1)`)
    .run(claim.workspaceId, claim.ownerId, claim.privacyEpoch, claim.attemptId, claim.deviceId, claim.generation, claim.keyId, claim.kind));
  const calls = { requests: 0, bytes: 0, admissionAtBytes: undefined, vapidSubject: undefined, onResolve: options.onResolve };
  const transaction = (inputClaim, callback) => f.kernel.withOwnedTransaction(f.login.sessionToken, inputClaim.privacyEpoch, callback);
  const owner = {
    withOwnedAttemptTransaction: transaction,
    assertAttemptCurrentWithinTransaction(context, inputClaim) {
      const row = context.db.prepare(`SELECT * FROM web_push_delivery_test_attempts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?`)
        .get(inputClaim.workspaceId, inputClaim.ownerId, inputClaim.privacyEpoch, inputClaim.attemptId);
      if (!row || row.device_id !== inputClaim.deviceId || row.generation !== inputClaim.generation || row.key_id !== inputClaim.keyId ||
          row.kind !== inputClaim.kind || row.consent_enabled !== 1 || row.source_enabled !== 1) throw new Error('attempt_or_consent_changed');
    },
    readAttemptWithinTransaction(context, inputClaim) {
      const row = context.db.prepare(`SELECT state,admission_id,outcome_json FROM web_push_delivery_test_attempts
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?`)
        .get(inputClaim.workspaceId, inputClaim.ownerId, inputClaim.privacyEpoch, inputClaim.attemptId);
      if (!row) throw new Error('attempt_missing');
      return row.state === 'settled' ? { state: 'settled', outcome: JSON.parse(row.outcome_json) } :
        row.state === 'dispatch_admitted' ? { state: row.state, admissionId: row.admission_id } : { state: row.state };
    },
    admitDispatchWithinTransaction(context, inputClaim, binding) {
      this.assertAttemptCurrentWithinTransaction(context, inputClaim);
      if (binding.deviceId !== inputClaim.deviceId || binding.generation !== inputClaim.generation || binding.keyId !== inputClaim.keyId || !binding.admissionId) throw new Error('attempt_binding_changed');
      const result = context.db.prepare(`UPDATE web_push_delivery_test_attempts SET state='dispatch_admitted',admission_id=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=? AND state='ready' AND consent_enabled=1 AND source_enabled=1`)
        .run(binding.admissionId, inputClaim.workspaceId, inputClaim.ownerId, inputClaim.privacyEpoch, inputClaim.attemptId);
      if (result.changes !== 1) throw new Error('duplicate_attempt');
      if (options.abortAfterAdmission) options.abortAfterAdmission();
    },
    settleWithinTransaction(context, inputClaim, outcome, binding) {
      const result = context.db.prepare(`UPDATE web_push_delivery_test_attempts SET state='settled',outcome_json=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND attempt_id=?
          AND ((state='ready' AND ? IS NULL) OR (state='dispatch_admitted' AND admission_id=?))`)
        .run(JSON.stringify(outcome), inputClaim.workspaceId, inputClaim.ownerId, inputClaim.privacyEpoch, inputClaim.attemptId,
          binding.admissionId ?? null, binding.admissionId ?? null);
      if (result.changes !== 1) throw new Error('attempt_already_settled');
    },
  };
  if (options.loseAdmissionAck) {
    let lost = false;
    owner.withOwnedAttemptTransaction = (inputClaim, callback) => {
      const value = transaction(inputClaim, callback);
      if (!lost && f.row(inputClaim.attemptId)?.state === 'dispatch_admitted') { lost = true; throw new Error('admission_ack_lost'); }
      return value;
    };
  }
  const transport = createWebPushTransport({
    resolve: async () => { calls.onResolve?.(); return [{ address: '8.8.8.8', family: 4 }]; },
    dial: async (_hostname, address) => ({ remoteAddress: address, authorized: true, destroy() {} }),
    request: async (context) => {
      calls.requests += 1;
      const authorization = String(context.details.headers.Authorization ?? '');
      const token = /^vapid\s+t=([^,]+)/i.exec(authorization)?.[1];
      if (token) calls.vapidSubject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
      context.beforeDispatch();
      calls.admissionAtBytes = f.row(claim.attemptId)?.state;
      calls.bytes += 1;
      if (options.onRequest) return options.onRequest(context, calls, claim);
      return { statusCode: options.statusCode ?? 201 };
    },
  });
  const subscriptionsPort = options.subscriptions ?? f.service;
  const dispatcher = createWebPushDeliveryDispatcher({ canonicalOrigin: ORIGIN, subscriptions: subscriptionsPort, owner, transport });
  return { dispatcher, owner, claim, calls, provision, registered, subscription, transaction, subscriptionsPort };
}

test('admits the exact attempt before bytes, settles acceptance, and never repeats a settled attempt', async () => {
  const f = await setup();
  try {
    const h = createHarness(f);
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'accepted' });
    assert.equal(h.calls.requests, 1);
    assert.equal(h.calls.bytes, 1);
    assert.equal(h.calls.admissionAtBytes, 'dispatch_admitted');
    assert.equal(h.calls.vapidSubject, ORIGIN);
    assert.equal(f.row(h.claim.attemptId).state, 'settled');
    const duplicate = await h.dispatcher.dispatchClaimedNotification(h.claim);
    assert.deepEqual(duplicate, { kind: 'already_settled', outcome: { kind: 'accepted' } });
    assert.equal(h.calls.requests, 1);
    assert.equal(JSON.stringify(duplicate).includes(h.subscription.endpoint), false);
  } finally { f.close(); }
});

test('replays retained state before cancellation and current-consent checks', async () => {
  const f = await setup();
  try {
    const h = createHarness(f);
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'accepted' });
    f.setConsent(h.claim.attemptId, false);
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification({ ...h.claim, signal: controller.signal }),
      { kind: 'already_settled', outcome: { kind: 'accepted' } });

    const admittedClaim = { ...h.claim, attemptId: randomUUID() };
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`INSERT INTO web_push_delivery_test_attempts(
      workspace_id,owner_id,privacy_epoch,attempt_id,device_id,generation,key_id,kind,state,consent_enabled,source_enabled,admission_id)
      VALUES(?,?,?,?,?,?,?,?,'dispatch_admitted',0,0,?)`).run(admittedClaim.workspaceId, admittedClaim.ownerId,
      admittedClaim.privacyEpoch, admittedClaim.attemptId, admittedClaim.deviceId, admittedClaim.generation,
      admittedClaim.keyId, admittedClaim.kind, randomUUID()));
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification({ ...admittedClaim, signal: controller.signal }),
      { kind: 'ambiguous', reason: 'transport_failure' });
    assert.equal(h.calls.bytes, 1);
  } finally { f.close(); }
});

test('zeroes initial material when the owned transaction wrapper throws after its callback', async () => {
  const f = await setup();
  try {
    let observed;
    const subscriptions = {
      readDeliveryMaterialWithinTransaction(context, request) {
        observed = f.service.readDeliveryMaterialWithinTransaction(context, request);
        return observed;
      },
      expireDeliveryGenerationWithinTransaction: (...args) => f.service.expireDeliveryGenerationWithinTransaction(...args),
    };
    const h = createHarness(f, { subscriptions });
    const original = h.owner.withOwnedAttemptTransaction;
    let throwAfterCallback = true;
    h.owner.withOwnedAttemptTransaction = (claim, callback) => {
      const value = original(claim, callback);
      if (throwAfterCallback) { throwAfterCallback = false; throw new Error('synthetic_lost_transaction_ack'); }
      return value;
    };
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'not_started', reason: 'authorization_changed' });
    assert.ok(observed.subscription.endpoint.every((byte) => byte === 0));
    assert.ok(observed.subscription.keys.p256dh.every((byte) => byte === 0));
    assert.ok(observed.subscription.keys.auth.every((byte) => byte === 0));
    assert.ok(observed.vapid.privateKey.every((byte) => byte === 0));
  } finally { f.close(); }
});

test('concurrent dispatcher cannot settle another invocation admission', async () => {
  const f = await setup();
  let releaseFirst;
  let firstAtRequest;
  try {
    const entered = new Promise((resolve) => { firstAtRequest = resolve; });
    const wait = new Promise((resolve) => { releaseFirst = resolve; });
    const first = createHarness(f, { onRequest: async () => { firstAtRequest(); await wait; return { statusCode: 201 }; } });
    const firstSend = first.dispatcher.dispatchClaimedNotification(first.claim);
    await entered;
    const secondTransport = createWebPushTransport({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      dial: async (_hostname, address) => ({ remoteAddress: address, authorized: true, destroy() {} }),
      request: async (context) => { context.beforeDispatch(); return { statusCode: 201 }; },
    });
    const second = createWebPushDeliveryDispatcher({ canonicalOrigin: ORIGIN, subscriptions: first.subscriptionsPort,
      owner: first.owner, transport: secondTransport });
    assert.deepEqual(await second.dispatchClaimedNotification(first.claim), { kind: 'ambiguous', reason: 'transport_failure' });
    assert.equal(f.row(first.claim.attemptId).state, 'dispatch_admitted');
    releaseFirst();
    assert.deepEqual(await firstSend, { kind: 'accepted' });
    assert.equal(JSON.parse(f.row(first.claim.attemptId).outcome_json).kind, 'accepted');
  } finally { releaseFirst?.(); f.close(); }
});

test('zeros mismatched decrypted material before refusing an exact-key claim', async () => {
  const f = await setup();
  try {
    let observed;
    const subscriptionPort = {
      readDeliveryMaterialWithinTransaction(context, request) {
        observed = f.service.readDeliveryMaterialWithinTransaction(context, request);
        return observed && { ...observed, keyId: randomUUID() };
      },
      expireDeliveryGenerationWithinTransaction: (...args) => f.service.expireDeliveryGenerationWithinTransaction(...args),
    };
    const h = createHarness(f, { subscriptions: subscriptionPort });
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'not_started', reason: 'authorization_changed' });
    assert.equal(h.calls.requests, 0);
    assert.equal(h.calls.bytes, 0);
    assert.ok(observed.subscription.endpoint.every((byte) => byte === 0));
    assert.ok(observed.subscription.keys.p256dh.every((byte) => byte === 0));
    assert.ok(observed.subscription.keys.auth.every((byte) => byte === 0));
    assert.ok(observed.vapid.privateKey.every((byte) => byte === 0));
  } finally { f.close(); }
});

test('no-op or asynchronous admission adapters cannot send before durable admission is visible', async (t) => {
  for (const mode of ['noop', 'async']) {
    await t.test(mode, async () => {
      const f = await setup();
      try {
        const h = createHarness(f);
        const original = h.owner.admitDispatchWithinTransaction;
        if (mode === 'noop') h.owner.admitDispatchWithinTransaction = () => undefined;
        else h.owner.admitDispatchWithinTransaction = async function (...args) { return original.apply(this, args); };
        assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'not_started', reason: 'authorization_changed' });
        assert.equal(h.calls.bytes, 0);
        assert.equal(f.row(h.claim.attemptId).state, 'settled');
      } finally { f.close(); }
    });
  }
});

test('retained old VAPID key continues to deliver to its exact registered generation', async () => {
  const f = await setup();
  try {
    const h = createHarness(f, { kind: 'mail_alert' });
    f.service.rotate(f.admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, expectedActiveKeyId: h.provision.result.keyId });
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'accepted' });
    assert.equal(h.calls.bytes, 1);
  } finally { f.close(); }
});

test('service rejection is retained and never automatically retried', async () => {
  const f = await setup();
  try {
    const h = createHarness(f, { statusCode: 503 });
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'rejected', statusCode: 503 });
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'already_settled', outcome: { kind: 'rejected', statusCode: 503 } });
    assert.equal(h.calls.requests, 1);
  } finally { f.close(); }
});

test('a source or consent change during DNS prevents dispatch admission and bytes', async (t) => {
  for (const changed of ['source', 'consent']) {
    await t.test(changed, async () => {
      const f = await setup();
      try {
        let h;
        h = createHarness(f, { onResolve: () => changed === 'source' ? f.setSource(h.claim.attemptId, false) : f.setConsent(h.claim.attemptId, false) });
        assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'not_started', reason: 'authorization_changed' });
        assert.equal(h.calls.bytes, 0);
        assert.equal(f.row(h.claim.attemptId).state, 'settled');
        assert.deepEqual(JSON.parse(f.row(h.claim.attemptId).outcome_json), { kind: 'not_started', reason: 'authorization_changed' });
      } finally { f.close(); }
    });
  }
});

test('a new subscription generation during DNS fences the older delivery claim', async () => {
  const f = await setup();
  try {
    let h;
    h = createHarness(f, { onResolve: () => {
      f.service.revoke(f.admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
        deviceId: h.claim.deviceId, expectedGeneration: h.claim.generation });
      f.service.register(f.admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId: h.claim.deviceId,
        keyId: h.claim.keyId, expectedPreviousGeneration: h.claim.generation, subscription: createSubscription() });
    } });
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'not_started', reason: 'authorization_changed' });
    assert.equal(h.calls.bytes, 0);
    assert.equal(f.service.listSubscriptions(f.admission).subscriptions[0].generation, 2);
    assert.equal(f.service.listSubscriptions(f.admission).subscriptions[0].status, 'active');
  } finally { f.close(); }
});

test('a cancellation or lost acknowledgement after admission is ambiguous and cannot be resent', async (t) => {
  for (const mode of ['cancel', 'lost_ack']) {
    await t.test(mode, async () => {
      const f = await setup();
      try {
        const controller = new AbortController();
        const h = createHarness(f, mode === 'cancel' ? { abortAfterAdmission: () => controller.abort() } : { loseAdmissionAck: true });
        const input = { ...h.claim, signal: controller.signal };
        assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(input), { kind: 'ambiguous', reason: 'transport_failure' });
        assert.equal(h.calls.bytes, 0);
        assert.equal(f.row(h.claim.attemptId).state, 'settled');
        assert.equal((await h.dispatcher.dispatchClaimedNotification(h.claim)).kind, 'already_settled');
        assert.equal(h.calls.requests, 1);
      } finally { f.close(); }
    });
  }
});

test('404/410 expiry cannot revoke a replacement subscription generation', async () => {
  const f = await setup();
  try {
    let h;
    h = createHarness(f, { statusCode: 410, onRequest: (_context, _calls, claim) => {
      f.service.revoke(f.admission, { commandId: randomUUID(), expectedPrivacyEpoch: claim.privacyEpoch,
        deviceId: claim.deviceId, expectedGeneration: claim.generation });
      f.service.register(f.admission, { commandId: randomUUID(), expectedPrivacyEpoch: claim.privacyEpoch,
        deviceId: claim.deviceId, keyId: claim.keyId, expectedPreviousGeneration: claim.generation, subscription: createSubscription() });
      return { statusCode: 410 };
    } });
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'expired', statusCode: 410 });
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'already_settled', outcome: { kind: 'expired', statusCode: 410 } });
    assert.equal(h.calls.requests, 1);
    assert.equal(f.service.listSubscriptions(f.admission).subscriptions[0].status, 'active');
    assert.equal(f.service.listSubscriptions(f.admission).subscriptions[0].generation, 2);
  } finally { f.close(); }
});

test('dispatcher stop admission drains active socket work and rejects later attempts', async () => {
  const f = await setup();
  let resolveResponse;
  try {
    const response = new Promise((resolve) => { resolveResponse = resolve; });
    const h = createHarness(f, { onRequest: async () => response });
    const sending = h.dispatcher.dispatchClaimedNotification(h.claim);
    await waitFor(() => h.calls.bytes > 0);
    h.dispatcher.stopAdmission();
    assert.deepEqual(await h.dispatcher.dispatchClaimedNotification(h.claim), { kind: 'not_started', reason: 'stopping' });
    let drained = false;
    const draining = h.dispatcher.drain().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    resolveResponse({ statusCode: 201 });
    assert.deepEqual(await sending, { kind: 'accepted' });
    await draining;
    assert.equal(drained, true);
  } finally { f.close(); }
});
