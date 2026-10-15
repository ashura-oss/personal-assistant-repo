import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createDurableKernel } from '../dist/kernel.js';
import { SecretVault, VaultError } from '../dist/vault.js';
import { WorkspaceEraseService } from '../dist/workspaceErase.js';
import { WebPushRegistryError, WebPushSubscriptions } from '../dist/webPushSubscriptions.js';

const ORIGIN = 'http://127.0.0.1:43210';
const EMPTY = Object.freeze({ accounts: [], documents: [], tasks: [], notes: [], proposals: [], backgroundPolicies: [] });

async function setup({ registry = true, physicalBudgetBytes } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-web-push-'));
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(directory, 'kernel.sqlite'), now: () => now,
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, allowLocalHttp: true, authSecret: randomBytes(32), now: () => now });
  const enrolled = await auth.enrollOwner('synthetic-web-push-test-password', EMPTY);
  const loginChallenge = auth.createLoginChallenge(ORIGIN);
  const login = await auth.login({ password: 'synthetic-web-push-test-password', origin: ORIGIN,
    preAuthToken: loginChallenge.preAuthToken, csrfToken: loginChallenge.csrfToken });
  const rootKey = randomBytes(32);
  const vault = new SecretVault(kernel, rootKey);
  new WorkspaceEraseService({ kernel, auth, vault, createEmptySnapshot: () => EMPTY, now: () => now });
  let eraseHeld = false;
  const assertWorkspaceAdmission = () => { if (eraseHeld) throw new Error('workspace_erase_in_progress'); };
  const service = registry ? new WebPushSubscriptions(kernel, vault, assertWorkspaceAdmission,
    { now: () => now, ...(physicalBudgetBytes === undefined ? {} : { physicalBudgetBytes }) }) : undefined;
  const admission = (sessionToken = login.sessionToken) => Object.freeze({ sessionToken,
    assertCurrent() { assert.equal(kernel.getOwnedIdentity(sessionToken).ownerId.length, 36); } });
  return { directory, kernel, auth, vault, service, login, enrolled, admission, assertWorkspaceAdmission,
    setEraseHeld(value) { eraseHeld = value; },
    setNow(value) { now = value; },
    close() {
      vault.close(); auth.close(); kernel.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } };
}

function subscription() {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  return Object.freeze({ endpoint: `https://push.example.invalid/send/${randomUUID()}`,
    keys: Object.freeze({ p256dh: receiver.getPublicKey(undefined, 'uncompressed').toString('base64url'),
      auth: randomBytes(16).toString('base64url') }) });
}

function counts(kernel, workspaceId) {
  return kernel.withTrustedDatabaseTransaction((db) => Object.fromEntries([
    'web_push_vapid_keys', 'web_push_vapid_heads', 'web_push_subscriptions', 'web_push_subscription_heads', 'web_push_commands',
  ].map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=?`).get(workspaceId).count])));
}

test('Web Push vault ciphertext binds owner, workspace, epoch, device, generation, and VAPID key id', async () => {
  const f = await setup({ registry: false });
  const deviceId = randomUUID();
  const keyId = randomUUID();
  const secret = Buffer.from('synthetic-endpoint-and-subscription-keys');
  const binding = { kind: 'subscription', deviceId, generation: 3, keyId };
  try {
    const ciphertext = f.kernel.withOwnedTransaction(f.login.sessionToken, 0, (context) =>
      f.vault.sealWebPushSecretWithinTransaction(context, binding, secret));
    assert.deepEqual(Object.keys(ciphertext).sort(), ['ciphertext', 'format', 'nonce', 'tag']);
    assert.equal(ciphertext.format, 1);
    assert.equal(ciphertext.nonce.length, 12);
    assert.equal(ciphertext.tag.length, 16);
    assert.equal(ciphertext.ciphertext.includes(Buffer.from('synthetic-endpoint')), false);
    const opened = f.kernel.withOwnedTransaction(f.login.sessionToken, 0, (context) =>
      f.vault.openWebPushSecretWithinTransaction(context, binding, ciphertext));
    try { assert.deepEqual(opened, secret); } finally { opened.fill(0); }

    assert.throws(() => f.kernel.withOwnedTransaction(f.login.sessionToken, 0, (context) =>
      f.vault.openWebPushSecretWithinTransaction(context, { ...binding, generation: 4 }, ciphertext)),
    (error) => error instanceof VaultError && error.code === 'web_push_secret_open_failed');
    assert.throws(() => f.kernel.withOwnedTransaction(f.login.sessionToken, 0, (context) =>
      f.vault.openWebPushSecretWithinTransaction(context, { ...binding, keyId: randomUUID() }, ciphertext)),
    (error) => error instanceof VaultError && error.code === 'web_push_secret_open_failed');

    const accessor = { kind: 'vapid', keyId };
    Object.defineProperty(accessor, 'keyId', { enumerable: true, get() { throw new Error('getter invoked'); } });
    assert.throws(() => f.kernel.withOwnedTransaction(f.login.sessionToken, 0, (context) =>
      f.vault.sealWebPushSecretWithinTransaction(context, accessor, secret)),
    (error) => error instanceof VaultError && error.code === 'web_push_secret_invalid_binding');
  } finally { secret.fill(0); f.close(); }
});

test('explicit provisioning and key rotation are idempotent, inspectable, and bind registration to the exact public key', async () => {
  const f = await setup();
  const admission = f.admission();
  const commandId = randomUUID();
  try {
    assert.deepEqual(f.service.getStatus(admission), { schemaVersion: 1, privacyEpoch: 0, provisioned: false, subscriptionCount: 0 });
    assert.deepEqual(f.service.getPublicKey(admission), { schemaVersion: 1, privacyEpoch: 0, provisioned: false });
    assert.deepEqual(counts(f.kernel, f.enrolled.workspaceId), {
      web_push_vapid_keys: 0, web_push_vapid_heads: 0, web_push_subscriptions: 0,
      web_push_subscription_heads: 0, web_push_commands: 0,
    }, 'GET-style status reads never create a key');

    const provisionRequest = { commandId, expectedPrivacyEpoch: 0 };
    const first = f.service.provision(admission, provisionRequest);
    assert.deepEqual(f.service.provision(admission, provisionRequest), first, 'the same command replays the exact receipt');
    assert.equal(first.operation, 'provision');
    assert.deepEqual(Object.keys(first.result).sort(), ['createdAt', 'keyId', 'publicKey']);
    assert.equal(first.result.publicKey.length, 87);
    assert.deepEqual(f.service.inspectCommand(admission, commandId), first);
    assert.throws(() => f.service.rotate(admission, { commandId, expectedPrivacyEpoch: 0,
      expectedActiveKeyId: first.result.keyId }), (error) => error instanceof WebPushRegistryError && error.code === 'web_push_command_conflict');

    const second = f.service.rotate(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      expectedActiveKeyId: first.result.keyId });
    assert.notEqual(second.result.keyId, first.result.keyId);
    assert.notEqual(second.result.publicKey, first.result.publicKey);

    const deviceId = randomUUID();
    const subscriptionInput = subscription();
    const staleRegistration = { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId,
      keyId: first.result.keyId, expectedPreviousGeneration: 0, subscription: subscriptionInput };
    assert.throws(() => f.service.register(admission, staleRegistration),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_stale_key');
    assert.equal(f.service.listSubscriptions(admission).subscriptions.length, 0);

    const registerRequest = { ...staleRegistration, commandId: randomUUID(), keyId: second.result.keyId };
    const registered = f.service.register(admission, registerRequest);
    assert.deepEqual(registered.result, { deviceId, generation: 1, status: 'active', keyId: second.result.keyId,
      updatedAt: registered.result.updatedAt });
    assert.equal(JSON.stringify(registered).includes(subscriptionInput.endpoint), false);
    assert.equal(JSON.stringify(registered).includes(subscriptionInput.keys.p256dh), false);
    assert.equal(JSON.stringify(registered).includes(subscriptionInput.keys.auth), false);
    assert.deepEqual(f.service.register(admission, registerRequest), registered);
    assert.deepEqual(f.service.reconcileSubscription(admission, { expectedPrivacyEpoch: 0, deviceId, subscription: subscriptionInput }),
      { schemaVersion: 1, privacyEpoch: 0, deviceId, status: 'matched', generation: 1, keyId: second.result.keyId, publicKey: second.result.publicKey });
    assert.equal(f.service.reconcileSubscription(admission, { expectedPrivacyEpoch: 0, deviceId: randomUUID(), subscription: subscriptionInput }).status, 'missing');
    assert.equal(f.service.reconcileSubscription(admission, { expectedPrivacyEpoch: 0, deviceId,
      subscription: { ...subscriptionInput, endpoint: `${subscriptionInput.endpoint}/changed` } }).status, 'unmatched');
    assert.deepEqual(f.service.listSubscriptions(admission).subscriptions, [{ deviceId, generation: 1, status: 'active',
      keyId: second.result.keyId, updatedAt: registered.result.updatedAt }]);

    const third = f.service.rotate(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      expectedActiveKeyId: second.result.keyId });
    const retained = f.kernel.withTrustedDatabaseTransaction((db) => ({
      keys: db.prepare('SELECT key_id FROM web_push_vapid_keys WHERE workspace_id=? ORDER BY key_id').all(f.enrolled.workspaceId).map((row) => row.key_id),
      subscriptionKey: db.prepare('SELECT key_id FROM web_push_subscriptions WHERE workspace_id=? AND device_id=? AND generation=1')
        .get(f.enrolled.workspaceId, deviceId).key_id,
    }));
    assert.equal(retained.keys.length, 3, 'rotation keeps old VAPID keys available for existing generations');
    assert.equal(retained.subscriptionKey, second.result.keyId);
    assert.equal(f.service.getPublicKey(admission).keyId, third.result.keyId);

    const revokeRequest = { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId, expectedGeneration: 1 };
    const revoked = f.service.revoke(admission, revokeRequest);
    assert.equal(revoked.result.status, 'revoked');
    assert.deepEqual(f.service.reconcileSubscription(admission, { expectedPrivacyEpoch: 0, deviceId, subscription: subscriptionInput }),
      { schemaVersion: 1, privacyEpoch: 0, deviceId, status: 'revoked', generation: 1, keyId: second.result.keyId });
    assert.deepEqual(f.service.revoke(admission, revokeRequest), revoked);
    assert.throws(() => f.service.revoke(admission, { ...revokeRequest, commandId: randomUUID() }),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_stale_generation');
    const reregistered = f.service.register(admission, { ...registerRequest, commandId: randomUUID(), keyId: third.result.keyId,
      expectedPreviousGeneration: 1 });
    assert.equal(reregistered.result.generation, 2);
    assert.equal(reregistered.result.status, 'active');
  } finally { f.close(); }
});

test('registration rejects fragments, malformed P-256 points, accessors, and symbols before any row write', async () => {
  const f = await setup();
  const admission = f.admission();
  const key = f.service.provision(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0 });
  const valid = subscription();
  try {
    const base = { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId: randomUUID(), keyId: key.result.keyId,
      expectedPreviousGeneration: 0, subscription: valid };
    assert.throws(() => f.service.register(admission, { ...base, subscription: { ...valid, endpoint: `${valid.endpoint}#` } }),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_invalid_subscription');
    const zeroPoint = Buffer.alloc(65, 0).toString('base64url');
    assert.throws(() => f.service.register(admission, { ...base, subscription: { ...valid, keys: { ...valid.keys, p256dh: zeroPoint } } }),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_invalid_subscription');
    let getterCalls = 0;
    const accessor = { ...base };
    Object.defineProperty(accessor, 'commandId', { enumerable: true, get() { getterCalls += 1; return base.commandId; } });
    assert.throws(() => f.service.register(admission, accessor),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_invalid_request');
    assert.equal(getterCalls, 0);
    const withSymbol = { ...base, [Symbol('hidden')]: 'invalid' };
    assert.throws(() => f.service.register(admission, withSymbol),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_invalid_request');
    assert.equal(f.service.listSubscriptions(admission).subscriptions.length, 0);
  } finally { f.close(); }
});

test('a percent-encoded hash remains endpoint path data', async () => {
  const f = await setup();
  try {
    const key = f.service.provision(f.admission(), { commandId: randomUUID(), expectedPrivacyEpoch: 0 });
    const subscriptionInput = subscription();
    const receipt = f.service.register(f.admission(), { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      deviceId: randomUUID(), keyId: key.result.keyId, expectedPreviousGeneration: 0,
      subscription: { ...subscriptionInput, endpoint: `${subscriptionInput.endpoint}%23` } });
    assert.equal(receipt.operation, 'register');
    assert.equal(receipt.result.status, 'active');
  } finally { f.close(); }
});

test('stored receipts reject secret-bearing extras and operation/result shape changes', async () => {
  const f = await setup();
  try {
    const receipt = f.service.provision(f.admission(), { commandId: randomUUID(), expectedPrivacyEpoch: 0 });
    const commandId = receipt.commandId;
    const original = JSON.stringify(receipt.result);
    const corruptResults = [
      { ...receipt.result, endpoint: 'https://push.example.invalid/private' },
      { ...receipt.result, auth: randomBytes(16).toString('base64url') },
      { ...receipt.result, privateKey: randomBytes(32).toString('base64url') },
    ];
    const writeCorruption = (resultJson, operation = 'provision') => f.kernel.withTrustedDatabaseTransaction((db) => {
      db.exec('DROP TRIGGER web_push_commands_immutable_update');
      db.prepare('UPDATE web_push_commands SET operation=?,result_json=? WHERE workspace_id=? AND command_id=?')
        .run(operation, resultJson, f.enrolled.workspaceId, commandId);
      db.exec("CREATE TRIGGER web_push_commands_immutable_update BEFORE UPDATE ON web_push_commands BEGIN SELECT RAISE(ABORT,'web_push_immutable'); END");
    });
    for (const value of corruptResults) {
      writeCorruption(JSON.stringify(value));
      assert.throws(() => f.service.inspectCommand(f.admission(), commandId),
        (error) => error instanceof WebPushRegistryError && error.code === 'web_push_receipt_corrupt');
    }
    writeCorruption(original, 'register');
    assert.throws(() => f.service.inspectCommand(f.admission(), commandId),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_receipt_corrupt');
  } finally { f.close(); }
});

test('same-version schema with a missing required index fails closed', async () => {
  const f = await setup();
  try {
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec('DROP INDEX web_push_subscription_heads_page'));
    assert.throws(() => new WebPushSubscriptions(f.kernel, f.vault, f.assertWorkspaceAdmission),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_schema_corrupt');
  } finally { f.close(); }
});

test('same-version schema with a weakened table definition fails closed', async () => {
  const f = await setup();
  try {
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec('ALTER TABLE web_push_commands RENAME COLUMN request_digest TO request_hash'));
    assert.throws(() => new WebPushSubscriptions(f.kernel, f.vault, f.assertWorkspaceAdmission),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_schema_corrupt');
  } finally { f.close(); }
});

test('direct registry mutation rechecks the trusted workspace hold before any write', async () => {
  const f = await setup();
  try {
    f.setEraseHeld(true);
    assert.throws(() => f.service.provision(f.admission(), { commandId: randomUUID(), expectedPrivacyEpoch: 0 }),
      /workspace_erase_in_progress/);
    assert.deepEqual(counts(f.kernel, f.enrolled.workspaceId), {
      web_push_vapid_keys: 0, web_push_vapid_heads: 0, web_push_subscriptions: 0,
      web_push_subscription_heads: 0, web_push_commands: 0,
    });
  } finally { f.close(); }
});

test('the physical registry budget rolls back new growth, preserves replay, and reserves terminal revocation space', async () => {
  const f = await setup({ physicalBudgetBytes: 8_000 });
  try {
    const admission = f.admission();
    const provisionRequest = { commandId: randomUUID(), expectedPrivacyEpoch: 0 };
    const provision = f.service.provision(admission, provisionRequest);
    const deviceId = randomUUID();
    const endpointPayload = `https://push.example.invalid/send/${'x'.repeat(1400)}`;
    const receiver = createECDH('prime256v1');
    receiver.generateKeys();
    const firstRegister = { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId, keyId: provision.result.keyId,
      expectedPreviousGeneration: 0, subscription: { endpoint: endpointPayload, keys: {
        p256dh: receiver.getPublicKey(undefined, 'uncompressed').toString('base64url'), auth: randomBytes(16).toString('base64url'),
      } } };
    const registered = f.service.register(admission, firstRegister);
    const before = counts(f.kernel, f.enrolled.workspaceId);
    const oversized = { ...firstRegister, commandId: randomUUID(), deviceId: randomUUID(), subscription: {
      ...firstRegister.subscription, endpoint: `https://push.example.invalid/send/${'y'.repeat(1980)}`,
    } };
    assert.throws(() => f.service.register(admission, oversized),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_storage_budget_exceeded');
    assert.deepEqual(counts(f.kernel, f.enrolled.workspaceId), before, 'failed registration leaves no generation, head, or receipt');

    const rotate = { commandId: randomUUID(), expectedPrivacyEpoch: 0, expectedActiveKeyId: provision.result.keyId };
    assert.throws(() => f.service.rotate(admission, rotate),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_storage_budget_exceeded');
    assert.deepEqual(counts(f.kernel, f.enrolled.workspaceId), before, 'failed rotation leaves no key/head/receipt change');

    assert.deepEqual(f.service.register(admission, firstRegister), registered, 'exact mutation replay remains available at saturation');
    assert.deepEqual(f.service.inspectCommand(admission, firstRegister.commandId), registered);
    const revoked = f.service.revoke(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0, deviceId, expectedGeneration: 1 });
    assert.equal(revoked.result.status, 'revoked', 'the reserved terminal receipt still fits');

    const secondOwnerId = randomUUID();
    const secondWorkspace = f.kernel.createWorkspace(secondOwnerId, EMPTY);
    const secondSession = f.kernel.createSession(secondWorkspace.workspaceId, secondOwnerId, 1_800_000_100_000);
    const secondAdmission = f.admission(secondSession);
    const secondProvision = f.service.provision(secondAdmission, { commandId: randomUUID(), expectedPrivacyEpoch: 0 });
    assert.equal(secondProvision.operation, 'provision', 'another owner workspace has an independent 16 MiB budget');
    assert.notEqual(secondWorkspace.workspaceId, f.enrolled.workspaceId);
  } finally { f.close(); }
});

test('an exception after encrypted inserts rolls back the key, active head, and command receipt together', async () => {
  const f = await setup({ registry: false });
  let clockCalls = 0;
  const service = new WebPushSubscriptions(f.kernel, f.vault, f.assertWorkspaceAdmission, { now: () => {
    clockCalls += 1;
    if (clockCalls === 2) throw new Error('synthetic clock failure');
    return 1_800_000_000_000;
  } });
  try {
    assert.throws(() => service.provision(f.admission(), { commandId: randomUUID(), expectedPrivacyEpoch: 0 }), /synthetic clock failure/);
    assert.deepEqual(counts(f.kernel, f.enrolled.workspaceId), {
      web_push_vapid_keys: 0, web_push_vapid_heads: 0, web_push_subscriptions: 0,
      web_push_subscription_heads: 0, web_push_commands: 0,
    });
  } finally { f.close(); }
});

test('future or incomplete registry schemas fail closed without creating missing tables', async () => {
  const f = await setup({ registry: false });
  try {
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TABLE web_push_schema(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version>0)) STRICT;
      INSERT INTO web_push_schema(singleton,version) VALUES(1,2);`));
    assert.throws(() => new WebPushSubscriptions(f.kernel, f.vault, f.assertWorkspaceAdmission),
      (error) => error instanceof WebPushRegistryError && error.code === 'web_push_schema_unsupported');
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) =>
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='web_push_vapid_keys'").get().count), 0);
  } finally { f.close(); }
});
