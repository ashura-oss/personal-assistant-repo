import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel, SecretVault } from '../dist/index.js';
import { isValidAccountId } from '../dist/accountIds.js';
import { ServerOAuthTokenBindings } from '../dist/oauthTokenBindings.js';
import { NodeVaultOAuthTokenStore } from '../dist/applicationHost.node.mjs';

test('account IDs are exact bounded UTF-8 identifiers with no controls or invalid surrogates', () => {
  const maxBytes = '😀'.repeat(256);
  assert.equal(Buffer.byteLength(maxBytes), 1024);
  assert.equal(isValidAccountId(maxBytes), true);
  assert.equal(isValidAccountId(`${maxBytes}a`), false);
  assert.equal(isValidAccountId(''), false);
  assert.equal(isValidAccountId(`account\u0000id`), false);
  assert.equal(isValidAccountId(`account\u001fid`), false);
  assert.equal(isValidAccountId(`account\u007fid`), false);
  assert.equal(isValidAccountId('\ud800'), false);
  assert.equal(isValidAccountId('Account'), true);
  assert.equal(isValidAccountId('account'), true);
  assert.equal(isValidAccountId('é'), true);
  assert.equal(isValidAccountId('e\u0301'), true);
});

function fixture(accountId) {
  const directory = mkdtempSync(join(tmpdir(), 'still-opaque-account-'));
  const ownerId = randomUUID();
  const kernel = createDurableKernel({ databasePath: join(directory, 'private', 'still.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const workspace = kernel.createWorkspace(ownerId, { notes: [] });
  const actor = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 3_600_000);
  const vault = new SecretVault(kernel, randomBytes(32));
  let accounts = [];
  const identity = Object.freeze({ providerNamespace: 'google', clientId: 'client', subject: 'subject', issuer: 'https://accounts.google.com' });
  const store = new NodeVaultOAuthTokenStore(kernel, vault, actor, kernel.getOwnedIdentity(actor), () => accounts);
  const token = { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000, identity };
  const account = { id: accountId, provider: 'google', displayName: 'User', email: 'user@example.test', connected: true,
    authStatus: 'connected', identity, tokenRef: 'oauth-opaque-1', connectionGeneration: 1 };
  return { directory, kernel, vault, actor, accountId, store, token, account,
    setAccounts(value) { accounts = value; },
    close() { vault.close(); kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test('opaque Unicode account IDs pass kernel generation, vault encryption, token binding, and exact cleanup', async () => {
  const accountId = '帳戶-😀-A';
  const f = fixture(accountId);
  try {
    f.kernel.recordAccountGeneration(f.actor, accountId, 1);
    f.setAccounts([f.account]);
    await f.store.set(f.account.tokenRef, f.token);
    assert.equal((await f.store.get(f.account.tokenRef))?.accessToken, 'access');
    await f.store.set(f.account.tokenRef, { ...f.token, accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh' });
    assert.equal((await f.store.get(f.account.tokenRef))?.accessToken, 'refreshed-access');

    const current = f.kernel.getOwnedSnapshot(f.actor);
    const plan = f.kernel.createOneUsePlan(f.actor, { expectedRevision: current.revision, expectedPrivacyEpoch: current.privacyEpoch,
      accountId, sourceHash: 'a'.repeat(64) });
    assert.ok(plan.planId);

    f.setAccounts([]);
    await f.store.delete(f.account.tokenRef);
    assert.equal(await f.store.get(f.account.tokenRef), null);
    const metadata = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.getMetadataWithinTransaction(context,
      { type: 'account', accountId, expectedAccountGeneration: 1 }, 'googleOAuth'));
    assert.deepEqual(metadata, { configured: false, generation: 3 });
  } finally { f.close(); }
});

test('1024-byte account IDs work in the vault and invalid IDs are rejected before persistence', () => {
  const accountId = '😀'.repeat(256);
  const f = fixture(accountId);
  try {
    f.kernel.recordAccountGeneration(f.actor, accountId, 4);
    const stored = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId, expectedAccountGeneration: 4 }, 'googleOAuth', 0, 'synthetic-secret'));
    assert.deepEqual(stored, { configured: true, generation: 1 });
    for (const invalid of ['', `${accountId}a`, 'x\u0000y', '\ud800']) {
      assert.throws(() => f.kernel.recordAccountGeneration(f.actor, invalid, 1));
      assert.throws(() => f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.setSecretWithinTransaction(context,
        { type: 'account', accountId: invalid, expectedAccountGeneration: 1 }, 'googleOAuth', 0, 'never-stored')));
    }
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS n FROM account_generations').get().n), 1);
  } finally { f.close(); }
});

test('kernel snapshot account-generation commands and vault slots preserve exact case and Unicode identity', () => {
  const f = fixture('unused');
  const ids = ['Account', 'account', 'é', 'e\u0301'];
  try {
    for (const [index, accountId] of ids.entries()) {
      const snapshot = f.kernel.getOwnedSnapshot(f.actor);
      f.kernel.runLocalCommand(f.actor, { expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch,
        idempotencyKey: randomUUID(), type: 'account.fixture', canonicalRequest: JSON.stringify({ accountId, index }) },
      () => ({ snapshot: { notes: [] }, receipt: { indexed: index }, accountGenerations: { [accountId]: index + 1 } }));
      f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.setSecretWithinTransaction(context,
        { type: 'account', accountId, expectedAccountGeneration: index + 1 }, 'googleOAuth', 0, `secret-${index}`));
    }
    const observed = f.kernel.withOwnedTransaction(f.actor, 0, (context) => ids.map((accountId) => ({
      id: accountId,
      generation: context.db.prepare('SELECT generation FROM account_generations WHERE workspace_id=? AND account_id=?')
        .get(context.workspaceId, accountId).generation,
      secret: f.vault.getSecretWithinTransaction(context, { type: 'account', accountId,
        expectedAccountGeneration: ids.indexOf(accountId) + 1 }, 'googleOAuth'),
    })));
    assert.deepEqual(observed, ids.map((id, index) => ({ id, generation: index + 1, secret: `secret-${index}` })));
  } finally { f.close(); }
});

test('existing-credential binding writer rejects absent, stale, and wrong-provider vault slots without binding rows', () => {
  const accountId = 'opaque-帳戶';
  const f = fixture(accountId);
  try {
    f.kernel.recordAccountGeneration(f.actor, accountId, 3);
    const bindings = new ServerOAuthTokenBindings(f.kernel);
    const write = (input) => f.kernel.withOwnedTransaction(f.actor, 0, (context) =>
      bindings.writeExistingCredentialBindingWithinTransaction(context, input));
    const base = { tokenRef: 'oauth-guard-test', accountId, provider: 'google', accountGeneration: 3 };
    assert.throws(() => write({ ...base, credentialGeneration: 1 }), (error) => error?.code === 'oauth_token_binding_credential_changed');
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId, expectedAccountGeneration: 3 }, 'googleOAuth', 0, 'credential-generation-one'));
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId, expectedAccountGeneration: 3 }, 'googleOAuth', 1, 'credential-generation-two'));
    assert.throws(() => write({ ...base, credentialGeneration: 1 }), (error) => error?.code === 'oauth_token_binding_credential_changed');
    assert.throws(() => write({ ...base, provider: 'microsoft', credentialGeneration: 2 }),
      (error) => error?.code === 'oauth_token_binding_credential_changed');
    const count = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS n FROM server_oauth_token_bindings').get().n);
    assert.equal(count, 0);
    assert.equal(write({ ...base, credentialGeneration: 2 }).credentialGeneration, 2);
  } finally { f.close(); }
});

test('vault v1 migration preserves ciphertext bytes and generation tombstones without changing crypto format', () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-vault-account-migration-'));
  const databasePath = join(directory, 'private', 'still.sqlite');
  const rootKey = randomBytes(32);
  const ownerId = randomUUID();
  const accountId = randomUUID();
  const validateSnapshot = (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  let kernel = createDurableKernel({ databasePath, validateSnapshot });
  let workspace = kernel.createWorkspace(ownerId, { notes: [] });
  let actor = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 3_600_000);
  let vault = new SecretVault(kernel, rootKey);
  try {
    kernel.recordAccountGeneration(actor, accountId, 2);
    kernel.withOwnedTransaction(actor, 0, (context) => vault.setSecretWithinTransaction(context,
      { type: 'account', accountId, expectedAccountGeneration: 2 }, 'googleOAuth', 0, 'vault-migration-secret'));
    kernel.withOwnedTransaction(actor, 0, (context) => vault.deleteSecretWithinTransaction(context,
      { type: 'account', accountId, expectedAccountGeneration: 2 }, 'googleOAuth', 1));
    kernel.withOwnedTransaction(actor, 0, (context) => vault.setSecretWithinTransaction(context,
      { type: 'workspace' }, 'openrouter', 0, 'workspace-migration-secret'));
    const before = kernel.withTrustedDatabaseTransaction((db) => ({
      metadata: db.prepare('SELECT workspace_id,scope_type,scope_id,purpose,generation,configured FROM vault_metadata ORDER BY scope_type,scope_id,purpose').all(),
      ciphertexts: db.prepare('SELECT workspace_id,scope_type,scope_id,purpose,generation,account_generation,key_version,nonce,tag,ciphertext FROM vault_ciphertexts ORDER BY scope_type,scope_id,purpose').all(),
    }));
    kernel.withTrustedDatabaseTransaction((db) => {
      db.exec(`
        ALTER TABLE vault_metadata RENAME TO vault_metadata_v2_shape;
        CREATE TABLE vault_metadata (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'account')),
          scope_id TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('openrouter', 'azureSpeech', 'googleOAuth', 'microsoftOAuth')),
          generation INTEGER NOT NULL CHECK (generation >= 0),
          configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
          PRIMARY KEY (workspace_id, scope_type, scope_id, purpose),
          CHECK ((scope_type = 'workspace' AND scope_id = '') OR (scope_type = 'account' AND length(scope_id)=36))
        ) STRICT;
        INSERT INTO vault_metadata SELECT * FROM vault_metadata_v2_shape;
        DROP TABLE vault_metadata_v2_shape;
        UPDATE vault_schema SET version=1 WHERE singleton=1;`);
    });
    assert.throws(() => new SecretVault(kernel, randomBytes(32)), (error) => error?.code === 'vault_wrong_root_key');
    kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TRIGGER reject_vault_schema_update BEFORE UPDATE ON vault_schema
      BEGIN SELECT RAISE(ABORT,'synthetic vault migration failure'); END;`));
    assert.throws(() => new SecretVault(kernel, rootKey), /synthetic vault migration failure/);
    const rolledBack = kernel.withTrustedDatabaseTransaction((db) => ({
      version: db.prepare('SELECT version FROM vault_schema WHERE singleton=1').get().version,
      oldTable: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_metadata'").get()),
      tempTable: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_metadata_v2'").get()),
    }));
    assert.deepEqual(rolledBack, { version: 1, oldTable: true, tempTable: false });
    kernel.withTrustedDatabaseTransaction((db) => db.exec('DROP TRIGGER reject_vault_schema_update'));
    vault.close(); vault = undefined;
    kernel.close(); kernel = undefined;

    kernel = createDurableKernel({ databasePath, validateSnapshot });
    vault = new SecretVault(kernel, rootKey);
    const after = kernel.withTrustedDatabaseTransaction((db) => ({
      version: db.prepare('SELECT version FROM vault_schema WHERE singleton=1').get().version,
      metadata: db.prepare('SELECT workspace_id,scope_type,scope_id,purpose,generation,configured FROM vault_metadata ORDER BY scope_type,scope_id,purpose').all(),
      ciphertexts: db.prepare('SELECT workspace_id,scope_type,scope_id,purpose,generation,account_generation,key_version,nonce,tag,ciphertext FROM vault_ciphertexts ORDER BY scope_type,scope_id,purpose').all(),
    }));
    assert.equal(after.version, 2);
    assert.deepEqual(after.metadata, before.metadata);
    assert.deepEqual(after.ciphertexts, before.ciphertexts);
    assert.equal(kernel.withOwnedTransaction(actor, 0, (context) => vault.getSecretWithinTransaction(context,
      { type: 'workspace' }, 'openrouter')), 'workspace-migration-secret');
  } finally { vault?.close(); kernel?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('OAuth token binding v1 migration preserves exact rows and credential ciphertext remains readable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-binding-migration-'));
  const databasePath = join(directory, 'private', 'still.sqlite');
  const rootKey = randomBytes(32);
  const ownerId = randomUUID();
  const accountId = randomUUID();
  const validateSnapshot = (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  let kernel = createDurableKernel({ databasePath, validateSnapshot });
  let workspace = kernel.createWorkspace(ownerId, { notes: [] });
  let actor = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 3_600_000);
  let vault = new SecretVault(kernel, rootKey);
  let bindings = new ServerOAuthTokenBindings(kernel);
  try {
    kernel.recordAccountGeneration(actor, accountId, 8);
    kernel.withOwnedTransaction(actor, 0, (context) => vault.setSecretWithinTransaction(context,
      { type: 'account', accountId, expectedAccountGeneration: 8 }, 'googleOAuth', 0, 'binding-migration-secret'));
    const before = kernel.withOwnedTransaction(actor, 0, (context) => {
      bindings.writeExistingCredentialBindingWithinTransaction(context, { tokenRef: 'oauth-UUID-v1', accountId, provider: 'google',
        accountGeneration: 8, credentialGeneration: 1 });
      return context.db.prepare(`SELECT workspace_id,privacy_epoch,token_ref,account_id,provider,account_generation,
        credential_generation,created_at,updated_at FROM server_oauth_token_bindings`).all();
    });
    kernel.withTrustedDatabaseTransaction((db) => db.exec(`
      ALTER TABLE server_oauth_token_bindings RENAME TO server_oauth_token_bindings_v2_shape;
      CREATE TABLE server_oauth_token_bindings (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
        token_ref TEXT NOT NULL CHECK(length(token_ref) BETWEEN 1 AND 128),
        account_id TEXT NOT NULL CHECK(length(account_id)=36),
        provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
        account_generation INTEGER NOT NULL CHECK(account_generation>=0),
        credential_generation INTEGER NOT NULL CHECK(credential_generation>0),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,privacy_epoch,token_ref),
        UNIQUE(workspace_id,privacy_epoch,account_id,provider,account_generation)
      ) STRICT;
      INSERT INTO server_oauth_token_bindings SELECT * FROM server_oauth_token_bindings_v2_shape;
      DROP TABLE server_oauth_token_bindings_v2_shape;
      UPDATE server_oauth_token_binding_schema SET version=1 WHERE singleton=1;`));
    kernel.withTrustedDatabaseTransaction((db) => {
      db.pragma('ignore_check_constraints = ON');
      db.prepare('UPDATE server_oauth_token_bindings SET account_id=? WHERE token_ref=?').run('\u007f'.repeat(36), 'oauth-UUID-v1');
      db.pragma('ignore_check_constraints = OFF');
    });
    assert.throws(() => new ServerOAuthTokenBindings(kernel), (error) => error?.code === 'oauth_token_binding_schema_invalid');
    const malformed = kernel.withTrustedDatabaseTransaction((db) => ({
      version: db.prepare('SELECT version FROM server_oauth_token_binding_schema WHERE singleton=1').get().version,
      accountId: db.prepare('SELECT account_id FROM server_oauth_token_bindings WHERE token_ref=?').get('oauth-UUID-v1').account_id,
      tempTable: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_oauth_token_bindings_v2'").get()),
    }));
    assert.deepEqual(malformed, { version: 1, accountId: '\u007f'.repeat(36), tempTable: false });
    kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE server_oauth_token_bindings SET account_id=? WHERE token_ref=?')
      .run(accountId, 'oauth-UUID-v1'));
    kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE server_oauth_token_binding_schema SET version=3 WHERE singleton=1').run());
    assert.throws(() => new ServerOAuthTokenBindings(kernel), (error) => error?.code === 'oauth_token_binding_schema_newer');
    const future = kernel.withTrustedDatabaseTransaction((db) => ({
      version: db.prepare('SELECT version FROM server_oauth_token_binding_schema WHERE singleton=1').get().version,
      rows: db.prepare(`SELECT workspace_id,privacy_epoch,token_ref,account_id,provider,account_generation,
        credential_generation,created_at,updated_at FROM server_oauth_token_bindings`).all(),
      tempTable: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_oauth_token_bindings_v2'").get()),
    }));
    assert.deepEqual(future, { version: 3, rows: before, tempTable: false });
    kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE server_oauth_token_binding_schema SET version=1 WHERE singleton=1').run());
    kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TRIGGER reject_binding_schema_update BEFORE UPDATE ON server_oauth_token_binding_schema
      BEGIN SELECT RAISE(ABORT,'synthetic binding migration failure'); END;`));
    assert.throws(() => new ServerOAuthTokenBindings(kernel), /synthetic binding migration failure/);
    const rolledBack = kernel.withTrustedDatabaseTransaction((db) => ({
      version: db.prepare('SELECT version FROM server_oauth_token_binding_schema WHERE singleton=1').get().version,
      oldTable: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_oauth_token_bindings'").get()),
      tempTable: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_oauth_token_bindings_v2'").get()),
    }));
    assert.deepEqual(rolledBack, { version: 1, oldTable: true, tempTable: false });
    kernel.withTrustedDatabaseTransaction((db) => db.exec('DROP TRIGGER reject_binding_schema_update'));
    vault.close(); vault = undefined;
    kernel.close(); kernel = undefined;

    kernel = createDurableKernel({ databasePath, validateSnapshot });
    vault = new SecretVault(kernel, rootKey);
    bindings = new ServerOAuthTokenBindings(kernel);
    const after = kernel.withOwnedTransaction(actor, 0, (context) => ({
      version: context.db.prepare('SELECT version FROM server_oauth_token_binding_schema WHERE singleton=1').get().version,
      rows: context.db.prepare(`SELECT workspace_id,privacy_epoch,token_ref,account_id,provider,account_generation,
        credential_generation,created_at,updated_at FROM server_oauth_token_bindings`).all(),
      secret: vault.getSecretWithinTransaction(context, { type: 'account', accountId, expectedAccountGeneration: 8 }, 'googleOAuth'),
      binding: bindings.readBindingWithinTransaction(context, 'oauth-UUID-v1'),
    }));
    assert.equal(after.version, 2);
    assert.deepEqual(after.rows, before);
    assert.equal(after.secret, 'binding-migration-secret');
    assert.equal(after.binding.accountId, accountId);
    assert.equal(after.binding.credentialGeneration, 1);
    const ciphertextBeforeReopen = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT nonce,tag,ciphertext,key_version FROM vault_ciphertexts
      WHERE workspace_id=? AND scope_type='account' AND scope_id=? AND purpose='googleOAuth'`).get(workspace.workspaceId, accountId));
    const reopenedVault = new SecretVault(kernel, rootKey);
    const reopenedBindings = new ServerOAuthTokenBindings(kernel);
    const afterRepeatedOpen = kernel.withOwnedTransaction(actor, 0, (context) => ({
      secret: reopenedVault.getSecretWithinTransaction(context, { type: 'account', accountId, expectedAccountGeneration: 8 }, 'googleOAuth'),
      binding: reopenedBindings.readBindingWithinTransaction(context, 'oauth-UUID-v1'),
    }));
    const ciphertextAfterReopen = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT nonce,tag,ciphertext,key_version FROM vault_ciphertexts
      WHERE workspace_id=? AND scope_type='account' AND scope_id=? AND purpose='googleOAuth'`).get(workspace.workspaceId, accountId));
    assert.deepEqual(afterRepeatedOpen, { secret: 'binding-migration-secret', binding: after.binding });
    assert.deepEqual(ciphertextAfterReopen, ciphertextBeforeReopen);
    reopenedVault.close();
  } finally { vault?.close(); kernel?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
