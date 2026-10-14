import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { AuthError, AuthService, createDurableKernel, SecretVault } from '../dist/index.js';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
const vaultKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 11));
const origin = 'https://still.example';

function setup(options = {}) {
  const directory = mkdtempSync(join(process.cwd(), '.test-data-auth-'));
  const databasePath = join(directory, 'kernel.sqlite');
  let time = 1_800_000_000_000;
  let rejectSnapshot = false;
  const now = () => time;
  const validateSnapshot = (snapshot) => {
    if (rejectSnapshot) throw new Error('snapshot parser should not be called');
    assert.ok(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot));
  };
  const kernel = createDurableKernel({ databasePath, validateSnapshot, now });
  const auth = new AuthService(kernel, { canonicalOrigin: origin, authSecret, now, ...options });
  return { directory, databasePath, now, advance: (ms) => { time += ms; }, setTime: (value) => { time = value; },
    rejectSnapshotParsing: () => { rejectSnapshot = true; },
    validateSnapshot, kernel, auth };
}

function cleanup(f, ...kernels) {
  f.auth?.close(); f.kernel?.close();
  for (const kernel of kernels) kernel?.close();
  try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error; }
}
async function assertAuthServiceClosed(auth) {
  const isClosed = (error) => error instanceof AuthError && error.code === 'auth_closed';
  assert.throws(() => auth.createLoginChallenge(origin), isClosed);
  assert.throws(() => auth.getSession(''), isClosed);
  assert.throws(() => auth.assertMutation('', origin, ''), isClosed);
  assert.throws(() => auth.logout('', origin, ''), isClosed);
  assert.throws(() => auth.logoutAll(), isClosed);
  await assert.rejects(auth.enrollOwner('password', {}), isClosed);
  await assert.rejects(auth.login({}), isClosed);
  await assert.rejects(auth.resetPassword('password'), isClosed);
}

async function enroll(f, password = 'correct horse battery staple') {
  return f.auth.enrollOwner(password, { private: 'workspace' });
}

function challenge(f) { return f.auth.createLoginChallenge(origin); }
function credentials(challengeRow, password = 'correct horse battery staple', extra = {}) {
  return { password, origin, preAuthToken: challengeRow.preAuthToken, csrfToken: challengeRow.csrfToken, ...extra };
}
function deferredHashGate() {
  let release;
  let markEntered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  return { entered, release, afterHash: async () => { markEntered(); await blocked; } };
}

test('trusted enrollment is atomic and one-owner-only; password limits are byte based and exact', async () => {
  const f = setup();
  try {
    await assert.rejects(f.auth.enrollOwner(''.padEnd(0), { private: 'workspace' }),
      (error) => error instanceof AuthError && error.code === 'invalid_password');
    await assert.rejects(f.auth.enrollOwner('x'.repeat(1025), { private: 'workspace' }),
      (error) => error instanceof AuthError && error.code === 'invalid_password');
    await assert.rejects(f.auth.enrollOwner('é'.repeat(513), { private: 'workspace' }),
      (error) => error instanceof AuthError && error.code === 'invalid_password');
    await assert.rejects(f.auth.enrollOwner('\ud800', { private: 'workspace' }),
      (error) => error instanceof AuthError && error.code === 'invalid_password');
    await assert.rejects(f.auth.enrollOwner('valid but not committed', null));
    const rolledBack = new Database(f.databasePath);
    assert.equal(rolledBack.prepare('SELECT count(*) AS n FROM workspaces').get().n, 0);
    assert.equal(rolledBack.prepare('SELECT count(*) AS n FROM auth_owner').get().n, 0);
    rolledBack.close();
    const enrolled = await enroll(f, '  keep spaces  ');
    assert.match(enrolled.ownerId, /^[0-9a-f-]{36}$/i);
    assert.match(enrolled.workspaceId, /^[0-9a-f-]{36}$/i);
    await assert.rejects(f.auth.login(credentials(challenge(f), 'keep spaces')),
      (error) => error instanceof AuthError && error.code === 'unauthenticated');
    assert.equal(f.auth.getSession((await f.auth.login(credentials(challenge(f), '  keep spaces  '))).sessionToken).authenticated, true);
    const secondWorkspaceOwner = randomUUID();
    assert.throws(() => f.auth.createLoginChallenge('https://attacker.example'),
      (error) => error instanceof AuthError && error.code === 'origin_rejected');
    await assert.rejects(f.auth.enrollOwner('another password', { private: 'other' }),
      (error) => error instanceof AuthError && error.code === 'already_enrolled');
    const otherWorkspace = f.kernel.createWorkspace(secondWorkspaceOwner, { private: 'other' });
    const db = new Database(f.databasePath);
    assert.equal(db.prepare('SELECT count(*) AS n FROM workspaces').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_owner').get().n, 1);
    assert.equal(db.prepare('SELECT owner_id FROM workspaces WHERE id=?').get(enrolled.workspaceId).owner_id, enrolled.ownerId);
    assert.equal(db.prepare('SELECT owner_id FROM workspaces WHERE id=?').get(otherWorkspace.workspaceId).owner_id, secondWorkspaceOwner);
    assert.equal(Buffer.concat([readFileSync(f.databasePath), readFileSync(`${f.databasePath}-wal`)]).includes(Buffer.from('  keep spaces  ')), false);
    db.close();
  } finally { cleanup(f); }
});

test('login challenges are exact-origin, CSRF-bound, expiring, one-use, and survive restart safely', async () => {
  const f = setup();
  let reopenedKernel;
  let reopenedAuth;
  try {
    await enroll(f);
    assert.throws(() => f.auth.createLoginChallenge('https://still.example/'),
      (error) => error instanceof AuthError && error.code === 'origin_rejected');
    assert.throws(() => f.auth.createLoginChallenge('http://still.example'),
      (error) => error instanceof AuthError && error.code === 'origin_rejected');
    const c = challenge(f);
    await assert.rejects(f.auth.login({ ...credentials(c), origin: 'https://evil.example' }),
      (error) => error instanceof AuthError && error.code === 'origin_rejected');
    await assert.rejects(f.auth.login(credentials({ ...c, csrfToken: 'A'.repeat(43) })),
      (error) => error instanceof AuthError && error.code === 'challenge_invalid');
    const loggedIn = await f.auth.login(credentials(c));
    assert.equal(loggedIn.session.authenticated, true);
    assert.equal(loggedIn.session.workspaceId, f.kernel.getOwnedSnapshot(loggedIn.sessionToken).workspaceId);
    assert.equal(loggedIn.session.privacyEpoch, 0);
    assert.equal(f.auth.getSession(loggedIn.sessionToken).authenticated, true);
    assert.equal(Object.hasOwn(f.auth.getSession(loggedIn.sessionToken), 'sessionToken'), false);
    await assert.rejects(f.auth.login(credentials(c)),
      (error) => error instanceof AuthError && error.code === 'challenge_invalid');

    const replayChallenge = challenge(f);
    f.auth.close(); f.kernel.close();
    reopenedKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    reopenedAuth = new AuthService(reopenedKernel, { canonicalOrigin: origin, authSecret, now: f.now });
    assert.equal(reopenedAuth.getSession(loggedIn.sessionToken).authenticated, true);
    const afterRestart = await reopenedAuth.login(credentials(replayChallenge));
    assert.equal(reopenedAuth.getSession(afterRestart.sessionToken).authenticated, true);
    f.advance(30 * 24 * 60 * 60 * 1000);
    assert.deepEqual(reopenedAuth.getSession(afterRestart.sessionToken), { authenticated: false });
  } finally {
    reopenedAuth?.close();
    cleanup(f, ...(reopenedKernel ? [reopenedKernel] : []));
  }
});

test('resuming a live HttpOnly login challenge derives its CSRF value without creating rows or reusing consumed challenges', async () => {
  const f = setup();
  try {
    await enroll(f);
    const first = challenge(f);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      assert.deepEqual(f.auth.resumeLoginChallenge(first.preAuthToken), first);
    }
    const db = new Database(f.databasePath);
    assert.equal(db.prepare('SELECT count(*) AS count FROM auth_challenges WHERE consumed_at IS NULL').get().count, 1);
    db.close();
    await f.auth.login(credentials(first));
    assert.throws(() => f.auth.resumeLoginChallenge(first.preAuthToken),
      (error) => error instanceof AuthError && error.code === 'challenge_invalid');
    const replacement = challenge(f);
    assert.notEqual(replacement.preAuthToken, first.preAuthToken);
  } finally { cleanup(f); }
});

test('successful login rotates the presented session; logout requires matching origin and CSRF', async () => {
  const f = setup();
  try {
    await enroll(f);
    const first = await f.auth.login(credentials(challenge(f)));
    const second = await f.auth.login(credentials(challenge(f), undefined, { previousSessionToken: first.sessionToken }));
    assert.equal(f.auth.getSession(first.sessionToken).authenticated, false);
    assert.equal(f.auth.getSession(second.sessionToken).authenticated, true);
    assert.throws(() => f.auth.logout(second.sessionToken, origin, 'x'.repeat(43)),
      (error) => error instanceof AuthError && error.code === 'csrf_rejected');
    assert.throws(() => f.auth.logout(second.sessionToken, 'https://bad.example', second.session.csrfToken),
      (error) => error instanceof AuthError && error.code === 'origin_rejected');
    f.auth.logout(second.sessionToken, origin, second.session.csrfToken);
    assert.deepEqual(f.auth.getSession(second.sessionToken), { authenticated: false });
    const third = await f.auth.login(credentials(challenge(f)));
    f.auth.logoutAll();
    assert.deepEqual(f.auth.getSession(third.sessionToken), { authenticated: false });
  } finally { cleanup(f); }
});

test('authenticated session reads and CSRF mutation checks avoid parsing the workspace snapshot', async () => {
  const f = setup();
  try {
    await enroll(f);
    const loggedIn = await f.auth.login(credentials(challenge(f)));
    f.rejectSnapshotParsing();

    const identity = f.kernel.getOwnedIdentity(loggedIn.sessionToken);
    assert.equal(identity.workspaceId, loggedIn.session.workspaceId);
    assert.equal(identity.privacyEpoch, loggedIn.session.privacyEpoch);
    assert.deepEqual(f.auth.getSession(loggedIn.sessionToken), loggedIn.session);
    assert.deepEqual(f.auth.assertMutation(loggedIn.sessionToken, origin, loggedIn.session.csrfToken), loggedIn.session);
    assert.throws(() => f.kernel.getOwnedSnapshot(loggedIn.sessionToken), /snapshot parser should not be called/);

    f.auth.logout(loggedIn.sessionToken, origin, loggedIn.session.csrfToken);
    assert.deepEqual(f.auth.getSession(loggedIn.sessionToken), { authenticated: false });
  } finally { cleanup(f); }
});

test('browser logout and password reset revoke browser sessions without revoking trusted kernel actors', async () => {
  const f = setup();
  try {
    const enrolled = await enroll(f);
    const browser = await f.auth.login(credentials(challenge(f)));
    const runtime = f.kernel.createSession(enrolled.workspaceId, enrolled.ownerId, f.now() + 60 * 60 * 1000);

    f.auth.logoutAll();
    assert.deepEqual(f.auth.getSession(browser.sessionToken), { authenticated: false });
    assert.deepEqual(f.auth.getSession(runtime), { authenticated: false }, 'kernel-only sessions are not browser-authenticated');
    assert.equal(f.kernel.getOwnedIdentity(runtime).workspaceId, enrolled.workspaceId);
    const firstReceipt = f.kernel.runLocalCommand(runtime, {
      expectedRevision: 0, expectedPrivacyEpoch: 0, idempotencyKey: randomUUID(),
      type: 'trusted.runtime.update', canonicalRequest: '{"value":1}',
    }, () => ({ snapshot: { private: 'workspace after logout' }, receipt: { saved: true } }));
    assert.equal(firstReceipt.revision, 1);

    const nextBrowser = await f.auth.login(credentials(challenge(f)));
    const nextRuntime = f.kernel.createSession(enrolled.workspaceId, enrolled.ownerId, f.now() + 60 * 60 * 1000);
    await f.auth.resetPassword('replacement password');
    assert.deepEqual(f.auth.getSession(nextBrowser.sessionToken), { authenticated: false });
    assert.deepEqual(f.auth.getSession(nextRuntime), { authenticated: false });
    const secondReceipt = f.kernel.runLocalCommand(nextRuntime, {
      expectedRevision: 1, expectedPrivacyEpoch: 0, idempotencyKey: randomUUID(),
      type: 'trusted.runtime.update', canonicalRequest: '{"value":2}',
    }, () => ({ snapshot: { private: 'workspace after reset' }, receipt: { saved: true } }));
    assert.equal(secondReceipt.revision, 2);
    assert.deepEqual({ ...f.kernel.getOwnedSnapshot(nextRuntime).snapshot }, { private: 'workspace after reset' });
  } finally { cleanup(f); }
});

test('durable failure throttle counts five bad passwords, cools down for 60 seconds, and resets on success', async () => {
  const f = setup();
  try {
    await enroll(f);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const c = challenge(f);
      await assert.rejects(f.auth.login(credentials(c, 'incorrect password')),
        (error) => error instanceof AuthError && error.code === 'unauthenticated');
    }
    f.auth.close(); f.kernel.close();
    f.kernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    f.auth = new AuthService(f.kernel, { canonicalOrigin: origin, authSecret, now: f.now });
    const blockedChallenge = challenge(f);
    await assert.rejects(f.auth.login(credentials(blockedChallenge)),
      (error) => error instanceof AuthError && error.code === 'auth_throttled');
    f.advance(60_000);
    const restored = await f.auth.login(credentials(challenge(f)));
    assert.equal(f.auth.getSession(restored.sessionToken).authenticated, true);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(f.auth.login(credentials(challenge(f), 'incorrect password')),
        (error) => error instanceof AuthError && error.code === 'unauthenticated');
    }
    f.advance(15 * 60 * 1000);
    await assert.rejects(f.auth.login(credentials(challenge(f), 'incorrect password')),
      (error) => error instanceof AuthError && error.code === 'unauthenticated');
    assert.equal(f.auth.getSession((await f.auth.login(credentials(challenge(f)))).sessionToken).authenticated, true,
      'the rolling failure window resets after 15 minutes');
    const db = new Database(f.databasePath);
    assert.deepEqual(db.prepare('SELECT failures,cooldown_until,inflight_id FROM auth_throttle').get(),
      { failures: 0, cooldown_until: 0, inflight_id: null });
    db.close();
  } finally { cleanup(f); }
});

test('only one expensive scrypt operation is admitted per service, with no waiting queue', async () => {
  let releaseHash;
  let enteredHash;
  const entered = new Promise((resolve) => { enteredHash = resolve; });
  const gate = new Promise((resolve) => { releaseHash = resolve; });
  let gateEnabled = false;
  const f = setup({ afterPasswordHashForTesting: async () => { if (gateEnabled) { enteredHash(); await gate; } } });
  try {
    await enroll(f);
    gateEnabled = true;
    const firstChallenge = challenge(f);
    const firstLogin = f.auth.login(credentials(firstChallenge));
    await entered;
    await assert.rejects(f.auth.login(credentials(challenge(f))),
      (error) => error instanceof AuthError && error.code === 'auth_busy');
    releaseHash();
    const loggedIn = await firstLogin;
    assert.equal(f.auth.getSession(loggedIn.sessionToken).authenticated, true);
  } finally { releaseHash?.(); cleanup(f); }
});

test('password reset racing an in-flight login advances auth generation and prevents stale session issuance', async () => {
  let releaseHash;
  let enteredHash;
  const entered = new Promise((resolve) => { enteredHash = resolve; });
  const gate = new Promise((resolve) => { releaseHash = resolve; });
  let gateEnabled = false;
  const f = setup({ afterPasswordHashForTesting: async () => { if (gateEnabled) { enteredHash(); await gate; } } });
  let secondKernel;
  let resetService;
  let beforeResetVault;
  let afterResetVault;
  try {
    await enroll(f);
    const oldSession = await f.auth.login(credentials(challenge(f)));
    beforeResetVault = new SecretVault(f.kernel, vaultKey);
    f.kernel.withOwnedTransaction(oldSession.sessionToken, 0, (context) =>
      beforeResetVault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'must-survive-password-reset'));
    secondKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    resetService = new AuthService(secondKernel, { canonicalOrigin: origin, authSecret, now: f.now });
    gateEnabled = true;
    const staleLogin = f.auth.login(credentials(challenge(f)));
    await entered;
    gateEnabled = false;
    await resetService.resetPassword('new password after reset');
    releaseHash();
    await assert.rejects(staleLogin, (error) => error instanceof AuthError && error.code === 'unauthenticated');
    assert.equal(resetService.getSession(oldSession.sessionToken).authenticated, false);
    const fresh = await resetService.login(credentials(resetService.createLoginChallenge(origin), 'new password after reset'));
    assert.equal(resetService.getSession(fresh.sessionToken).authenticated, true);
    afterResetVault = new SecretVault(secondKernel, vaultKey);
    secondKernel.withOwnedTransaction(fresh.sessionToken, 0, (context) =>
      assert.equal(afterResetVault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter'), 'must-survive-password-reset'));
  } finally {
    releaseHash?.(); beforeResetVault?.close(); afterResetVault?.close(); resetService?.close();
    cleanup(f, ...(secondKernel ? [secondKernel] : []));
  }
});

test('closing during enrollment hashing prevents the pending owner/workspace commit', async () => {
  const gate = deferredHashGate();
  const f = setup({ afterPasswordHashForTesting: gate.afterHash });
  try {
    const pending = f.auth.enrollOwner('new owner password', { private: 'must not persist' });
    await gate.entered;
    f.auth.close();
    gate.release();
    await assert.rejects(pending, (error) => error instanceof AuthError && error.code === 'auth_closed');
    const db = new Database(f.databasePath);
    assert.equal(db.prepare('SELECT count(*) AS count FROM auth_owner').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM workspaces').get().count, 0);
    db.close();
    await assertAuthServiceClosed(f.auth);
  } finally { gate.release(); cleanup(f); }
});

test('closing during login hashing releases only its reservation and issues no session', async () => {
  let blockHash = false;
  const gate = deferredHashGate();
  const f = setup({ afterPasswordHashForTesting: async () => { if (blockHash) await gate.afterHash(); } });
  let reopenedKernel;
  let reopenedAuth;
  try {
    await enroll(f);
    const pendingChallenge = challenge(f);
    blockHash = true;
    const pending = f.auth.login(credentials(pendingChallenge));
    await gate.entered;
    f.auth.close();
    gate.release();
    await assert.rejects(pending, (error) => error instanceof AuthError && error.code === 'auth_closed');
    const db = new Database(f.databasePath);
    assert.equal(db.prepare('SELECT count(*) AS count FROM auth_sessions').get().count, 0);
    assert.equal(db.prepare('SELECT inflight_id FROM auth_throttle WHERE singleton=1').get().inflight_id, null);
    db.close();
    await assertAuthServiceClosed(f.auth);

    reopenedKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    reopenedAuth = new AuthService(reopenedKernel, { canonicalOrigin: origin, authSecret, now: f.now });
    const successful = await reopenedAuth.login(credentials(reopenedAuth.createLoginChallenge(origin)));
    assert.equal(reopenedAuth.getSession(successful.sessionToken).authenticated, true,
      'the abandoned login released its own throttle reservation');
  } finally {
    gate.release(); reopenedAuth?.close();
    cleanup(f, ...(reopenedKernel ? [reopenedKernel] : []));
  }
});

test('closing during password-reset hashing leaves the existing password and sessions untouched', async () => {
  let blockHash = false;
  const gate = deferredHashGate();
  const f = setup({ afterPasswordHashForTesting: async () => { if (blockHash) await gate.afterHash(); } });
  let reopenedKernel;
  let reopenedAuth;
  try {
    await enroll(f);
    const browser = await f.auth.login(credentials(challenge(f)));
    blockHash = true;
    const pending = f.auth.resetPassword('replacement password');
    await gate.entered;
    f.auth.close();
    gate.release();
    await assert.rejects(pending, (error) => error instanceof AuthError && error.code === 'auth_closed');
    await assertAuthServiceClosed(f.auth);

    reopenedKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    reopenedAuth = new AuthService(reopenedKernel, { canonicalOrigin: origin, authSecret, now: f.now });
    assert.equal(reopenedAuth.getSession(browser.sessionToken).authenticated, true,
      'an uncommitted reset does not revoke the existing browser session');
    const oldPasswordLogin = await reopenedAuth.login(credentials(reopenedAuth.createLoginChallenge(origin)));
    assert.equal(reopenedAuth.getSession(oldPasswordLogin.sessionToken).authenticated, true);
  } finally {
    gate.release(); reopenedAuth?.close();
    cleanup(f, ...(reopenedKernel ? [reopenedKernel] : []));
  }
});

test('challenge expiry and clock rollback fail closed; stale challenges do not create sessions', async () => {
  const f = setup();
  try {
    await enroll(f);
    const c = challenge(f);
    f.advance(10 * 60 * 1000);
    await assert.rejects(f.auth.login(credentials(c)),
      (error) => error instanceof AuthError && error.code === 'challenge_invalid');
    const next = challenge(f);
    f.advance(1000);
    f.setTime(f.now() - 2000);
    await assert.rejects(f.auth.login(credentials(next)),
      (error) => error instanceof AuthError && error.code === 'clock_rollback');
    assert.equal(new Database(f.databasePath).prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
  } finally { cleanup(f); }
});

test('auth schema future versions fail before writes and owner/workspace mismatches do not authenticate', async () => {
  const f = setup();
  try {
    await enroll(f);
    const loggedIn = await f.auth.login(credentials(challenge(f)));
    const db = new Database(f.databasePath);
    const otherOwner = randomUUID();
    const otherWorkspace = f.kernel.createWorkspace(otherOwner, { private: 'other' });
    db.prepare('UPDATE auth_owner SET workspace_id=? WHERE singleton=1').run(otherWorkspace.workspaceId);
    db.close();
    assert.deepEqual(f.auth.getSession(loggedIn.sessionToken), { authenticated: false });

    const mutate = new Database(f.databasePath);
    const ownerId = mutate.prepare('SELECT owner_id FROM auth_owner WHERE singleton=1').get().owner_id;
    mutate.prepare('UPDATE auth_owner SET workspace_id=(SELECT id FROM workspaces WHERE owner_id=?) WHERE singleton=1').run(ownerId);
    mutate.prepare('UPDATE auth_schema SET version=2 WHERE singleton=1').run();
    const before = readFileSync(f.databasePath);
    assert.throws(() => new AuthService(f.kernel, { canonicalOrigin: origin, authSecret, now: f.now }),
      (error) => error instanceof AuthError && error.code === 'auth_newer_schema');
    mutate.close();
    assert.deepEqual(readFileSync(f.databasePath), before);
  } finally { cleanup(f); }
});

test('explicit local HTTP origin is limited to localhost and 127.0.0.1', () => {
  const directory = mkdtempSync(join(process.cwd(), '.test-data-auth-origin-'));
  const databasePath = join(directory, 'kernel.sqlite');
  const kernel = createDurableKernel({ databasePath, validateSnapshot: (snapshot) => assert.ok(snapshot && typeof snapshot === 'object') });
  try {
    assert.doesNotThrow(() => new AuthService(kernel, { canonicalOrigin: 'http://localhost:3000', allowLocalHttp: true, authSecret }));
    assert.throws(() => new AuthService(kernel, { canonicalOrigin: 'http://example.com', allowLocalHttp: true, authSecret }),
      (error) => error instanceof AuthError && error.code === 'invalid_origin_config');
    assert.throws(() => new AuthService(kernel, { canonicalOrigin: 'http://[::1]:3000', allowLocalHttp: true, authSecret }),
      (error) => error instanceof AuthError && error.code === 'invalid_origin_config');
  } finally { kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
