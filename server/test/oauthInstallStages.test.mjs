import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { AuthError, AuthService, createDurableKernel, SecretVault } from '../dist/index.js';
import { OAuthInstallStageError, OAuthInstallStages } from '../dist/oauthInstallStages.js';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
const vaultKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 11));
const origin = 'https://still.example';
const password = 'correct horse battery staple';

function setup() {
  const directory = mkdtempSync(join(process.cwd(), '.test-data-oauth-stage-'));
  const databasePath = join(directory, 'kernel.sqlite');
  let time = 1_800_000_000_000;
  const now = () => time;
  const validateSnapshot = (snapshot) => assert.ok(snapshot && typeof snapshot === 'object');
  const kernel = createDurableKernel({ databasePath, validateSnapshot, now });
  const auth = new AuthService(kernel, { canonicalOrigin: origin, authSecret, now });
  const vault = new SecretVault(kernel, vaultKey);
  const stages = new OAuthInstallStages(kernel, vault, auth);
  return { directory, databasePath, now, advance: (ms) => { time += ms; }, validateSnapshot, kernel, auth, vault, stages };
}

function cleanup(f) {
  f.vault?.close(); f.auth?.close(); f.kernel?.close();
  try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error; }
}

async function login(f) {
  await f.auth.enrollOwner(password, { private: 'workspace' });
  return loginAgain(f);
}

async function loginAgain(f) {
  const challenge = f.auth.createLoginChallenge(origin);
  return f.auth.login({ password, origin, preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
}

function inSession(f, sessionToken, work) {
  const identity = f.kernel.getOwnedIdentity(sessionToken);
  return f.kernel.withOwnedTransaction(sessionToken, identity.privacyEpoch, work);
}

function start(f, sessionToken, options = {}) {
  return inSession(f, sessionToken, (context) => f.stages.createAuthorization(context, {
    initiatingSessionToken: sessionToken, registrationId: 'google-main', provider: 'google',
    requestedCapabilities: ['mail.read'], ...options,
  }));
}

function proof(startResult) {
  return { state: startResult.authorization.state, cookieBinding: startResult.authorization.cookieBinding };
}

function claim(f, sessionToken, startResult) {
  return inSession(f, sessionToken, (context) => f.stages.claimExchange(context, proof(startResult)));
}

function verifiedPayload(overrides = {}) {
  return { provider: 'google', accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token',
    expiresAt: 1_800_000_600_000, grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
    requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], identity: {
      providerNamespace: 'google', clientId: 'trusted-client', subject: 'synthetic-subject', issuer: 'https://accounts.google.com',
    }, displayName: 'Synthetic user', email: 'synthetic@example.test', ...overrides };
}

test('authorization stage returns private proofs only at start and completes encrypted verified handoff', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    assert.equal(started.status.status, 'authorization_pending');
    assert.equal(Object.hasOwn(started.status, 'state'), false);
    assert.match(started.authorization.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(started.authorization.state, started.authorization.cookieBinding);
    const claimed = claim(f, session.sessionToken, started);
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.authorization.nonce, started.authorization.nonce);
    const completed = inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, claimed.claim, verifiedPayload()));
    assert.equal(completed.status, 'verified');
    const binding = inSession(f, session.sessionToken, (context) => f.auth.bindInitiatingSessionWithinTransaction(context, session.sessionToken));
    const read = inSession(f, session.sessionToken, (context) => f.stages.readVerifiedForInstall(context, started.status.attemptId, binding));
    assert.equal(read.status.status, 'verified');
    assert.equal(read.payload.accessToken, 'synthetic-access-token');
    const db = new Database(f.databasePath);
    const raw = Buffer.concat([readFileSync(f.databasePath), readFileSync(`${f.databasePath}-wal`)]);
    assert.equal(raw.includes(Buffer.from('synthetic-access-token')), false);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='oauth_install_stages'").get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM vault_ciphertexts').get().n, 0);
    db.close();
  } finally { cleanup(f); }
});

test('stage schema v1 migration preserves pending and verified encrypted payload bytes and rejects future versions unchanged', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const pending = start(f, session.sessionToken);
    const verified = start(f, session.sessionToken);
    const claimResult = claim(f, session.sessionToken, verified);
    inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, claimResult.claim, verifiedPayload()));
    const readState = () => f.kernel.withTrustedDatabaseTransaction((db) => ({
      version: db.prepare('SELECT version FROM oauth_install_stage_schema WHERE singleton=1').get().version,
      columns: db.pragma('table_info(oauth_install_stages)').map((column) => column.name),
      indexes: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='oauth_install_stages' ORDER BY name").all().map((row) => row.name),
      rows: db.prepare(`SELECT stage_id,status,payload_generation,payload_kind,nonce,tag,ciphertext FROM oauth_install_stages ORDER BY stage_id`).all(),
    }));
    const currentRows = readState().rows;
    assert.deepEqual(currentRows.map((row) => row.status).sort(), ['authorization_pending', 'verified']);
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.exec(`DROP INDEX oauth_install_stages_owner_idx;
        ALTER TABLE oauth_install_stages RENAME TO oauth_install_stages_v2_fixture;
        CREATE TABLE oauth_install_stages (
          stage_id TEXT PRIMARY KEY CHECK(length(stage_id)=36),
          owner_id TEXT NOT NULL CHECK(length(owner_id)=36),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
          initiating_session_binding TEXT NOT NULL CHECK(length(initiating_session_binding)=64),
          registration_id TEXT NOT NULL CHECK(length(registration_id) BETWEEN 1 AND 128),
          provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
          created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
          state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash)=64), cookie_hash TEXT NOT NULL CHECK(length(cookie_hash)=64),
          claim_hash TEXT CHECK(claim_hash IS NULL OR length(claim_hash)=64),
          payload_generation INTEGER NOT NULL CHECK(payload_generation>0),
          payload_kind TEXT NOT NULL CHECK(payload_kind IN ('authorization','verified')),
          status TEXT NOT NULL CHECK(status IN ('authorization_pending','exchange_claimed','verified','denied','inspect_required','expired')),
          nonce BLOB, tag BLOB, ciphertext BLOB,
          CHECK((nonce IS NULL AND tag IS NULL AND ciphertext IS NULL) OR
            (length(nonce)=12 AND length(tag)=16 AND length(ciphertext) BETWEEN 1 AND 65536)),
          CHECK((status IN ('authorization_pending','exchange_claimed','verified') AND ciphertext IS NOT NULL) OR
            (status IN ('denied','inspect_required','expired') AND ciphertext IS NULL)),
          CHECK((status='exchange_claimed' AND claim_hash IS NOT NULL) OR (status!='exchange_claimed' AND claim_hash IS NULL))
        ) STRICT;
        INSERT INTO oauth_install_stages (stage_id,owner_id,workspace_id,privacy_epoch,initiating_session_binding,registration_id,provider,
          created_at,expires_at,state_hash,cookie_hash,claim_hash,payload_generation,payload_kind,status,nonce,tag,ciphertext)
          SELECT stage_id,owner_id,workspace_id,privacy_epoch,initiating_session_binding,registration_id,provider,created_at,expires_at,
            state_hash,cookie_hash,claim_hash,payload_generation,payload_kind,status,nonce,tag,ciphertext FROM oauth_install_stages_v2_fixture;
        DROP TABLE oauth_install_stages_v2_fixture;
        CREATE INDEX oauth_install_stages_owner_idx ON oauth_install_stages(owner_id,workspace_id,privacy_epoch,created_at);
        UPDATE oauth_install_stage_schema SET version=1 WHERE singleton=1;
        CREATE TRIGGER reject_stage_v2_marker BEFORE UPDATE OF version ON oauth_install_stage_schema
          WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'synthetic stage marker failure'); END;`);
    });
    const before = readState();
    assert.equal(before.version, 1);
    assert.equal(before.columns.includes('consumed_command_id'), false);
    assert.deepEqual(before.rows, currentRows);
    assert.deepEqual(before.indexes, ['oauth_install_stages_owner_idx', 'sqlite_autoindex_oauth_install_stages_1', 'sqlite_autoindex_oauth_install_stages_2']);
    assert.throws(() => new OAuthInstallStages(f.kernel, f.vault, f.auth), /synthetic stage marker failure/);
    assert.deepEqual(readState(), before, 'failed marker publication leaves the genuine v1 table and encrypted rows intact');
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec('DROP TRIGGER reject_stage_v2_marker'));
    const migrated = new OAuthInstallStages(f.kernel, f.vault, f.auth);
    const after = readState();
    assert.equal(after.version, 2);
    assert.ok(after.columns.includes('consumed_command_id'));
    assert.deepEqual(after.rows, currentRows);
    const binding = inSession(f, session.sessionToken, (context) => f.auth.bindInitiatingSessionWithinTransaction(context, session.sessionToken));
    const decrypted = inSession(f, session.sessionToken, (context) => migrated.readVerifiedForInstall(context, verified.status.attemptId, binding));
    assert.equal(decrypted.payload.refreshToken, 'synthetic-refresh-token');

    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE oauth_install_stage_schema SET version=3 WHERE singleton=1').run());
    const beforeFuture = readState();
    assert.throws(() => new OAuthInstallStages(f.kernel, f.vault, f.auth), /newer OAuth stage format/i);
    assert.deepEqual(readState(), beforeFuture);
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT version FROM oauth_install_stage_schema WHERE singleton=1').get().version), 3);
  } finally { cleanup(f); }
});

test('callback claim is one-use and callback proof does not require or accept a raw initiating bearer', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    const first = claim(f, session.sessionToken, started);
    assert.equal(first.claimed, true);
    assert.equal(Object.hasOwn(first, 'initiatingSessionToken'), false);
    assert.equal(Object.hasOwn(first.claim, 'initiatingSessionToken'), false);
    const duplicate = claim(f, session.sessionToken, started);
    assert.deepEqual(duplicate, { claimed: false, status: first.status });
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.claimExchange(context,
      { ...proof(started), initiatingSessionToken: session.sessionToken })),
    (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_invalid_proof');
  } finally { cleanup(f); }
});

test('callback rejects wrong state or cookie and callbacks from another workspace cannot inspect a stage', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.claimExchange(context,
      { ...proof(started), state: 'A'.repeat(43) })),
    (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_proof_invalid');
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.claimExchange(context,
      { ...proof(started), cookieBinding: 'A'.repeat(43) })),
    (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_proof_invalid');

    const otherOwner = randomUUID();
    const other = f.kernel.createWorkspace(otherOwner, { private: 'other' });
    const otherSession = f.kernel.createSession(other.workspaceId, otherOwner, f.now() + 60_000);
    assert.throws(() => inSession(f, otherSession, (context) => f.stages.claimExchange(context, proof(started))),
      (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_proof_invalid');
  } finally { cleanup(f); }
});

test('stage is fenced from a later privacy epoch and an expired transaction context', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    const sessionHash = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT initiating_session_binding FROM oauth_install_stages WHERE stage_id=?')
      .get(started.status.attemptId).initiating_session_binding);
    let staleContext;
    inSession(f, session.sessionToken, (context) => { staleContext = context; });
    assert.throws(() => f.stages.readStatus(staleContext, started.status.attemptId, sessionHash),
      (error) => error?.code === 'transaction_context_expired');

    const identity = f.kernel.getOwnedIdentity(session.sessionToken);
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=?').run(identity.workspaceId));
    const currentSession = f.kernel.createSession(identity.workspaceId, identity.ownerId, f.now() + 60_000);
    assert.throws(() => inSession(f, currentSession, (context) => f.stages.claimExchange(context, proof(started))),
      (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_proof_invalid');
  } finally { cleanup(f); }
});

test('revoked original session prevents callback and status discovery terminalizes safely', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    f.auth.logoutAll();
    const replacement = await loginAgain(f);
    const callback = inSession(f, replacement.sessionToken, (context) => f.stages.claimExchange(context, proof(started)));
    assert.equal(callback.claimed, false);
    assert.equal(callback.status.status, 'inspect_required');
    assert.equal(callback.authorization, undefined);
    const binding = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT initiating_session_binding FROM oauth_install_stages WHERE stage_id=?')
      .get(started.status.attemptId).initiating_session_binding);
    const status = inSession(f, replacement.sessionToken, (context) => f.stages.readStatus(context, started.status.attemptId, binding));
    assert.equal(status.status, 'inspect_required');
    const cleared = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT nonce,tag,ciphertext FROM oauth_install_stages WHERE stage_id=?')
      .get(started.status.attemptId));
    assert.deepEqual(cleared, { nonce: null, tag: null, ciphertext: null });
  } finally { cleanup(f); }
});

test('either auth-session or kernel-session expiry invalidates the original-session binding', async () => {
  const f = setup();
  try {
    const authExpired = await login(f);
    const authExpiredStage = start(f, authExpired.sessionToken);
    const authHash = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT token_hash FROM auth_sessions ORDER BY rowid DESC LIMIT 1').get().token_hash);
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE auth_sessions SET expires_at=? WHERE token_hash=?').run(f.now() - 1, authHash));
    assert.throws(() => inSession(f, authExpired.sessionToken, (context) => f.auth.assertInitiatingSessionWithinTransaction(context, authHash)),
      (error) => error instanceof AuthError && error.code === 'initiating_session_inactive');

    const kernelExpired = await loginAgain(f);
    const kernelExpiredStage = start(f, kernelExpired.sessionToken);
    const kernelHash = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT token_hash FROM sessions ORDER BY rowid DESC LIMIT 1').get().token_hash);
    const observer = await loginAgain(f);
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(f.now() - 1, kernelHash));
    assert.throws(() => inSession(f, observer.sessionToken, (context) => f.auth.assertInitiatingSessionWithinTransaction(context, kernelHash)),
      (error) => error instanceof AuthError && error.code === 'initiating_session_inactive');
    assert.equal(authExpiredStage.status.status, 'authorization_pending');
    assert.equal(kernelExpiredStage.status.status, 'authorization_pending');
  } finally { cleanup(f); }
});

test('expiry is persisted as terminal and encrypted payload is cleared', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    f.advance(10 * 60 * 1000);
    const callback = inSession(f, session.sessionToken, (context) => f.stages.completeDenied(context, proof(started)));
    assert.equal(callback.status, 'expired');
    const binding = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT initiating_session_binding FROM oauth_install_stages WHERE stage_id=?')
      .get(started.status.attemptId).initiating_session_binding);
    const status = inSession(f, session.sessionToken, (context) => f.stages.readStatus(context, started.status.attemptId, binding));
    assert.equal(status.status, 'expired');
    const row = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT nonce,tag,ciphertext,claim_hash FROM oauth_install_stages WHERE stage_id=?')
      .get(started.status.attemptId));
    assert.deepEqual(row, { nonce: null, tag: null, ciphertext: null, claim_hash: null });
  } finally { cleanup(f); }
});

test('late provider completion after logout is inspect_required and never becomes installable', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    const result = claim(f, session.sessionToken, started);
    f.auth.logoutAll();
    const replacement = await loginAgain(f);
    const completed = inSession(f, replacement.sessionToken, (context) => f.stages.completeVerified(context, result.claim, verifiedPayload()));
    assert.equal(completed.status, 'inspect_required');
    const payload = inSession(f, replacement.sessionToken, (context) => f.stages.readVerifiedForInstall(context, started.status.attemptId,
      f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT initiating_session_binding FROM oauth_install_stages WHERE stage_id=?')
        .get(started.status.attemptId).initiating_session_binding)));
    assert.equal(payload.payload, undefined);
  } finally { cleanup(f); }
});

test('restart reconciliation clears an interrupted exchange without permitting a second claim', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    const first = claim(f, session.sessionToken, started);
    assert.equal(first.claimed, true);
    assert.equal(f.stages.reconcileInterruptedExchanges(), 1);
    const duplicate = claim(f, session.sessionToken, started);
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.status.status, 'inspect_required');
    const row = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT ciphertext,claim_hash FROM oauth_install_stages WHERE stage_id=?')
      .get(started.status.attemptId));
    assert.deepEqual(row, { ciphertext: null, claim_hash: null });
  } finally { cleanup(f); }
});

test('denial and explicit unknown exchange both erase staged verifier material', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const deniedStart = start(f, session.sessionToken);
    const denied = inSession(f, session.sessionToken, (context) => f.stages.completeDenied(context, proof(deniedStart)));
    assert.equal(denied.status, 'denied');
    const unknownStart = start(f, session.sessionToken);
    const claimed = claim(f, session.sessionToken, unknownStart);
    const unknown = inSession(f, session.sessionToken, (context) => f.stages.markExchangeUnknown(context, claimed.claim));
    assert.equal(unknown.status, 'inspect_required');
    const row = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT nonce,tag,ciphertext,claim_hash FROM oauth_install_stages WHERE stage_id=?')
      .get(unknownStart.status.attemptId));
    assert.deepEqual(row, { nonce: null, tag: null, ciphertext: null, claim_hash: null });
  } finally { cleanup(f); }
});

test('fresh verified installs require a refresh token and reject capabilities beyond consent', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const noRefreshStart = start(f, session.sessionToken);
    const noRefreshClaim = claim(f, session.sessionToken, noRefreshStart);
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, noRefreshClaim.claim,
      verifiedPayload({ refreshToken: '' }))),
    (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_invalid_verified_payload');
    const tooBroadStart = start(f, session.sessionToken);
    const tooBroadClaim = claim(f, session.sessionToken, tooBroadStart);
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, tooBroadClaim.claim,
      verifiedPayload({ requestedCapabilities: ['mail.read', 'mail.send'], capabilities: ['mail.send'] }))),
    (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_invalid_verified_payload');
  } finally { cleanup(f); }
});

test('reconnect requires the exact active account lifecycle and verified provider identity', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const lifecycle = { accountId: randomUUID(), connectionGeneration: 7, tokenRef: `oauth-${randomUUID()}`, connected: true,
      authStatus: 'connected', identity: { providerNamespace: 'google', clientId: 'trusted-client', subject: 'synthetic-subject',
        issuer: 'https://accounts.google.com' } };
    const started = start(f, session.sessionToken, { reconnectLifecycle: lifecycle });
    const claimed = claim(f, session.sessionToken, started);
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, claimed.claim,
      verifiedPayload({ identity: { ...lifecycle.identity, subject: 'different-subject' } }))),
    (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_reconnect_identity_mismatch');
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, claimed.claim,
      { ...verifiedPayload(), reconnectLifecycle: { ...lifecycle, tokenRef: 'attacker-selected' } })),
    (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_invalid_verified_payload');
    const completed = inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, claimed.claim, verifiedPayload()));
    assert.equal(completed.status, 'verified');
    const sessionHash = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT initiating_session_binding FROM oauth_install_stages WHERE stage_id=?')
      .get(started.status.attemptId).initiating_session_binding);
    const read = inSession(f, session.sessionToken, (context) => f.stages.readVerifiedForInstall(context, started.status.attemptId, sessionHash));
    assert.deepEqual(read.reconnectLifecycle, lifecycle);
    assert.equal(read.payload.accessToken, 'synthetic-access-token');
  } finally { cleanup(f); }
});

test('reauthentication and configured-placeholder lifecycles preserve their real account evidence', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const lifecycles = [
      { accountId: 'google-account-1', connectionGeneration: 0, tokenRef: `oauth-${randomUUID()}`, connected: false,
        authStatus: 'reauth_required', identity: { providerNamespace: 'google', clientId: 'trusted-client',
          subject: 'synthetic-subject', issuer: 'https://accounts.google.com' } },
      { accountId: 'google-placeholder', connectionGeneration: 0, connected: false, authStatus: 'configured' },
    ];
    for (const lifecycle of lifecycles) {
      const started = start(f, session.sessionToken, { reconnectLifecycle: lifecycle });
      const claimed = claim(f, session.sessionToken, started);
      if (lifecycle.authStatus === 'reauth_required') {
        assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, claimed.claim,
          verifiedPayload({ identity: { ...lifecycle.identity, subject: 'another-provider-account' } }))),
        (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_reconnect_identity_mismatch');
      }
      const completed = inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, claimed.claim, verifiedPayload()));
      assert.equal(completed.status, 'verified');
      const sessionHash = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT initiating_session_binding FROM oauth_install_stages WHERE stage_id=?')
        .get(started.status.attemptId).initiating_session_binding);
      const read = inSession(f, session.sessionToken, (context) => f.stages.readVerifiedForInstall(context, started.status.attemptId, sessionHash));
      assert.deepEqual(read.reconnectLifecycle, lifecycle);
      assert.equal(read.payload.refreshToken, 'synthetic-refresh-token');
    }
  } finally { cleanup(f); }
});

test('closed input rejects accessor properties before invoking them and create rolls back atomically', async () => {
  const f = setup();
  try {
    const session = await login(f);
    let invoked = false;
    const unsafe = { registrationId: 'google-main', provider: 'google', requestedCapabilities: ['mail.read'] };
    Object.defineProperty(unsafe, 'initiatingSessionToken', { enumerable: true, get() { invoked = true; return session.sessionToken; } });
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.createAuthorization(context, unsafe)),
      (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_invalid_input');
    assert.equal(invoked, false);

    assert.throws(() => inSession(f, session.sessionToken, (context) => {
      f.stages.createAuthorization(context, { initiatingSessionToken: session.sessionToken, registrationId: 'google-main',
        provider: 'google', requestedCapabilities: ['mail.read'] });
      throw new Error('rollback');
    }), /rollback/);
    const count = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS n FROM oauth_install_stages').get().n);
    assert.equal(count, 0);
  } finally { cleanup(f); }
});

test('wrong live session hash cannot read verified token material', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const started = start(f, session.sessionToken);
    const claimed = claim(f, session.sessionToken, started);
    inSession(f, session.sessionToken, (context) => f.stages.completeVerified(context, claimed.claim, verifiedPayload()));
    const otherHash = '0'.repeat(64);
    assert.throws(() => inSession(f, session.sessionToken, (context) => f.stages.readVerifiedForInstall(context, started.status.attemptId, otherHash)),
      (error) => error instanceof OAuthInstallStageError && error.code === 'oauth_stage_not_found');
  } finally { cleanup(f); }
});
