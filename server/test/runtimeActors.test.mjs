import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createDurableKernel } from '../dist/kernel.js';
import { ProcessWorkspaceActors, RUNTIME_ACTOR_EXPIRES_AT, RuntimeActorError } from '../dist/runtimeActors.js';

const ORIGIN = 'https://runtime-actors.example.test';
const PASSWORD = 'runtime actor test password';
const SNAPSHOT = { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-runtime-actors-'));
  const databasePath = join(directory, 'private', 'still.sqlite');
  let now = Date.now();
  const kernel = createDurableKernel({ databasePath, now: () => now,
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const secret = randomBytes(32);
  let auth;
  try { auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, authSecret: secret, now: () => now }); }
  finally { secret.fill(0); }
  const actors = new ProcessWorkspaceActors(kernel);
  return {
    directory, databasePath, kernel, auth, actors,
    get now() { return now; }, set now(value) { now = value; },
    async login(password = PASSWORD) {
      const challenge = auth.createLoginChallenge(ORIGIN);
      return auth.login({ password, origin: ORIGIN, preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
    },
    async enrollAndLogin() {
      const enrollment = await auth.enrollOwner(PASSWORD, SNAPSHOT);
      return { enrollment, login: await this.login() };
    },
    async close() {
      try { await actors.closeAfterDrain(async () => {}); } catch { /* Cleanup remains best-effort in test teardown. */ }
      auth.close();
      kernel.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function digest(token) { return createHash('sha256').update(token, 'utf8').digest('hex'); }
function sessionRows(kernel, workspaceId) {
  return kernel.withTrustedDatabaseTransaction((db) => db.prepare(`
    SELECT token_hash,owner_id,workspace_id,expires_at,revoked_at,privacy_epoch FROM sessions WHERE workspace_id=? ORDER BY created_at,token_hash
  `).all(workspaceId));
}

test('resolver memoizes one long-lived private kernel actor without persisting its plaintext token', async () => {
  const f = fixture();
  try {
    const { login } = await f.enrollAndLogin();
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const actorToken = f.actors.sessionForRegistry(identity);
    assert.equal(f.actors.sessionForRegistry(identity), actorToken);
    assert.equal(f.kernel.getOwnedIdentity(actorToken).workspaceId, identity.workspaceId);
    const row = sessionRows(f.kernel, identity.workspaceId).find((entry) => entry.token_hash === digest(actorToken));
    assert.ok(row);
    assert.equal(row.owner_id, identity.ownerId);
    assert.equal(row.privacy_epoch, identity.privacyEpoch);
    assert.equal(row.expires_at, RUNTIME_ACTOR_EXPIRES_AT);
    assert.equal(row.revoked_at, null);
    assert.equal(f.auth.getSession(actorToken).authenticated, false);
    assert.deepEqual(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(
      'SELECT COUNT(*) AS count FROM auth_sessions WHERE token_hash=?').get(digest(actorToken))), { count: 0 });
    assert.equal(readFileSync(f.databasePath).toString('utf8').includes(actorToken), false);
    assert.equal(sessionRows(f.kernel, identity.workspaceId).length, 2, 'one browser session and one memoized runtime actor');
  } finally { await f.close(); }
});

test('wrong-owner and stale-epoch metadata cannot mint an actor session', async () => {
  const f = fixture();
  try {
    const { login } = await f.enrollAndLogin();
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const before = sessionRows(f.kernel, identity.workspaceId).length;
    assert.throws(() => f.actors.sessionForRegistry({ ...identity, ownerId: randomUUID() }),
      (error) => error instanceof RuntimeActorError && error.code === 'workspace_binding_rejected');
    assert.throws(() => f.actors.sessionForRegistry({ ...identity, privacyEpoch: identity.privacyEpoch + 1 }),
      (error) => error instanceof RuntimeActorError && error.code === 'workspace_binding_rejected');
    assert.equal(sessionRows(f.kernel, identity.workspaceId).length, before);
    assert.throws(() => f.actors.sessionForRegistry({ ...identity, privacyEpoch: -1 }),
      (error) => error instanceof RuntimeActorError && error.code === 'invalid_identity');
  } finally { await f.close(); }
});

test('browser logout, password reset, and browser expiry do not revoke a private runtime actor', async () => {
  const f = fixture();
  try {
    const { login } = await f.enrollAndLogin();
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const actorToken = f.actors.sessionForRegistry(identity);
    const browser = f.auth.getSession(login.sessionToken);
    assert.equal(browser.authenticated, true);
    f.auth.logout(login.sessionToken, ORIGIN, browser.csrfToken);
    assert.equal(f.auth.getSession(login.sessionToken).authenticated, false);
    assert.equal(f.kernel.getOwnedIdentity(actorToken).ownerId, identity.ownerId);

    const afterLogout = await f.login();
    await f.auth.resetPassword('replacement runtime actor password');
    assert.equal(f.auth.getSession(afterLogout.sessionToken).authenticated, false);
    assert.equal(f.kernel.getOwnedIdentity(actorToken).privacyEpoch, identity.privacyEpoch);

    f.now += 31 * 24 * 60 * 60 * 1000;
    assert.throws(() => f.kernel.getOwnedIdentity(afterLogout.sessionToken), /invalid or expired/i);
    assert.equal(f.kernel.getOwnedIdentity(actorToken).workspaceId, identity.workspaceId);
    assert.equal(f.auth.getSession(actorToken).authenticated, false);
  } finally { await f.close(); }
});

test('privacy erasure invalidates a cached actor, allows a new epoch actor, and never remints the stale binding', async () => {
  const f = fixture();
  try {
    const { login } = await f.enrollAndLogin();
    const oldIdentity = f.kernel.getOwnedIdentity(login.sessionToken);
    const oldActor = f.actors.sessionForRegistry(oldIdentity);
    f.kernel.runLocalCommand(login.sessionToken, { expectedRevision: oldIdentity.revision, expectedPrivacyEpoch: oldIdentity.privacyEpoch,
      idempotencyKey: 'privacy-erase-for-runtime-actor-test', type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: SNAPSHOT, receipt: { kind: 'privacy_erased' }, privacyEpoch: oldIdentity.privacyEpoch + 1,
    }));
    assert.throws(() => f.actors.sessionForRegistry(oldIdentity), /invalid or expired/i);

    const newLogin = await f.login();
    const newIdentity = f.kernel.getOwnedIdentity(newLogin.sessionToken);
    assert.equal(newIdentity.privacyEpoch, oldIdentity.privacyEpoch + 1);
    const newActor = f.actors.sessionForRegistry(newIdentity);
    assert.notEqual(newActor, oldActor);
    assert.equal(f.kernel.getOwnedIdentity(newActor).privacyEpoch, newIdentity.privacyEpoch);
    assert.throws(() => f.actors.sessionForRegistry(oldIdentity), /invalid or expired/i);
    assert.equal(sessionRows(f.kernel, oldIdentity.workspaceId).length, 4, 'stale lookup never creates another actor');
    await f.actors.closeAfterDrain(async () => {});
    assert.throws(() => f.kernel.getOwnedIdentity(newActor), /invalid or expired/i);
  } finally { await f.close(); }
});

test('close stops new lookups synchronously, drains before actor revoke, and is idempotent', async () => {
  const f = fixture();
  try {
    const { login } = await f.enrollAndLogin();
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const actorToken = f.actors.sessionForRegistry(identity);
    let releaseDrain;
    let drainStarted = false;
    const drain = new Promise((resolve) => { releaseDrain = resolve; });
    const closePromise = f.actors.closeAfterDrain(() => { drainStarted = true; return drain; });
    await Promise.resolve();
    assert.equal(drainStarted, true);
    assert.equal(f.kernel.getOwnedIdentity(actorToken).privacyEpoch, identity.privacyEpoch);
    assert.throws(() => f.actors.sessionForRegistry(identity),
      (error) => error instanceof RuntimeActorError && error.code === 'resolver_closed');
    assert.equal(f.actors.closeAfterDrain(async () => { throw new Error('second drain must not run'); }), closePromise);
    releaseDrain();
    await closePromise;
    assert.throws(() => f.kernel.getOwnedIdentity(actorToken), /invalid or expired/i);
    assert.equal(sessionRows(f.kernel, identity.workspaceId).find((row) => row.token_hash === digest(actorToken)).revoked_at !== null, true);
  } finally { await f.close(); }
});

test('rejected drain preserves actors and explicit retry drains before revoking them', async () => {
  const f = fixture();
  try {
    const { login } = await f.enrollAndLogin();
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const actorToken = f.actors.sessionForRegistry(identity);
    let rejectDrain;
    const failedDrain = new Promise((_resolve, reject) => { rejectDrain = reject; });
    const failedClose = f.actors.closeAfterDrain(() => failedDrain);
    assert.throws(() => f.actors.sessionForRegistry(identity),
      (error) => error instanceof RuntimeActorError && error.code === 'resolver_closed');
    assert.equal(f.kernel.getOwnedIdentity(actorToken).privacyEpoch, identity.privacyEpoch);
    rejectDrain(new Error('drain_failed'));
    await assert.rejects(failedClose, /drain_failed/);
    assert.equal(f.kernel.getOwnedIdentity(actorToken).privacyEpoch, identity.privacyEpoch,
      'a failed drain must leave the actor available to in-flight work');

    let retries = 0;
    const retryClose = f.actors.closeAfterDrain(async () => { retries += 1; });
    assert.notEqual(retryClose, failedClose);
    await retryClose;
    assert.equal(retries, 1);
    assert.throws(() => f.kernel.getOwnedIdentity(actorToken), /invalid or expired/i);
    const actorRow = sessionRows(f.kernel, identity.workspaceId).find((row) => row.token_hash === digest(actorToken));
    assert.ok(actorRow.revoked_at);
    assert.equal(f.actors.closeAfterDrain(async () => { throw new Error('completed close must remain idempotent'); }), retryClose);
  } finally { await f.close(); }
});

test('a transaction failure after actor mint does not publish a cached binding', () => {
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  let failAfterMint = true;
  let mintCount = 0;
  const fakeKernel = {
    withTrustedDatabaseTransaction(callback) {
      const token = callback({ prepare() { return { get() { return { owner_id: ownerId, privacy_epoch: 0 }; } }; } });
      if (failAfterMint) {
        failAfterMint = false;
        throw new Error('transaction_commit_failed');
      }
      return token;
    },
    createSession() { mintCount += 1; return `private-token-${mintCount}`; },
    getOwnedIdentity() { return { workspaceId, ownerId, privacyEpoch: 0 }; },
    revokeSession() {},
  };
  const actors = new ProcessWorkspaceActors(fakeKernel);
  const identity = { workspaceId, ownerId, privacyEpoch: 0 };
  assert.throws(() => actors.sessionForRegistry(identity), /transaction_commit_failed/);
  assert.equal(actors.sessionForRegistry(identity), 'private-token-2');
  assert.equal(mintCount, 2, 'the failed transaction result was not published into the memoized cache');
});

test('shutdown ignores only exact pre-revoked actors and preserves kernel I/O failures', async () => {
  const f = fixture();
  try {
    const { login } = await f.enrollAndLogin();
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const actorToken = f.actors.sessionForRegistry(identity);
    f.kernel.runLocalCommand(login.sessionToken, { expectedRevision: identity.revision, expectedPrivacyEpoch: identity.privacyEpoch,
      idempotencyKey: 'privacy-erase-before-runtime-actor-shutdown', type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: SNAPSHOT, receipt: { kind: 'privacy_erased' }, privacyEpoch: identity.privacyEpoch + 1,
    }));
    assert.throws(() => f.kernel.getOwnedIdentity(actorToken), /invalid or expired/i);
    await f.actors.closeAfterDrain(async () => {});

    const second = fixture();
    const enrolled = await second.enrollAndLogin();
    const secondIdentity = second.kernel.getOwnedIdentity(enrolled.login.sessionToken);
    const secondActor = second.actors.sessionForRegistry(secondIdentity);
    second.kernel.close();
    await assert.rejects(second.actors.closeAfterDrain(async () => {}), /closed/i);
    assert.throws(() => second.kernel.getOwnedIdentity(secondActor), /closed/i);
    second.auth.close();
    rmSync(second.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } finally { await f.close(); }
});

test('shutdown reports an actor revoked without a privacy epoch advance', async () => {
  const f = fixture();
  try {
    const { login } = await f.enrollAndLogin();
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const actorToken = f.actors.sessionForRegistry(identity);
    f.kernel.revokeSession(actorToken);
    await assert.rejects(f.actors.closeAfterDrain(async () => {}), /invalid or expired/i);
  } finally { await f.close(); }
});
