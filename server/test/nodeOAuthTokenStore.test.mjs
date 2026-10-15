import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel, SecretVault } from '../dist/index.js';
import { NodeVaultOAuthTokenStore } from '../dist/applicationHost.node.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-node-oauth-store-'));
  const ownerId = randomUUID();
  const accountId = randomUUID();
  const identity = Object.freeze({ providerNamespace: 'google', clientId: 'client-id', subject: 'provider-subject',
    issuer: 'https://accounts.google.com' });
  let accounts = [];
  const kernel = createDurableKernel({ databasePath: join(directory, 'private', 'still.sqlite'),
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const workspace = kernel.createWorkspace(ownerId, { notes: [] });
  const session = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 3_600_000);
  const vault = new SecretVault(kernel, randomBytes(32));
  const actor = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 3_600_000);
  const binding = kernel.getOwnedIdentity(actor);
  const store = new NodeVaultOAuthTokenStore(kernel, vault, actor, binding, () => accounts);
  const token = (accessToken) => ({ accessToken, refreshToken: `refresh-${accessToken}`, expiresAt: Date.now() + 60_000, identity });
  const account = (tokenRef, generation) => ({ id: accountId, provider: 'google', displayName: 'User', email: 'user@example.test',
    connected: true, authStatus: 'connected', identity, tokenRef, connectionGeneration: generation });
  return { directory, kernel, vault, session, actor, workspace, accountId, identity, store, token, account,
    setAccounts(value) { accounts = value; },
    close() { vault.close(); kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test('obsolete OAuth tokenRef cleanup cannot delete a replacement token in the shared vault slot', async () => {
  const f = fixture();
  try {
    f.kernel.recordAccountGeneration(f.actor, f.accountId, 1);
    f.setAccounts([f.account('old-ref', 1)]);
    await f.store.set('old-ref', f.token('old-access'));

    f.kernel.recordAccountGeneration(f.actor, f.accountId, 2);
    f.setAccounts([f.account('new-ref', 2)]);
    await f.store.set('new-ref', f.token('new-access'));
    await f.store.delete('old-ref');

    assert.equal((await f.store.get('new-ref'))?.accessToken, 'new-access');
    assert.equal(await f.store.get('old-ref'), null);
    const bindings = f.kernel.withOwnedTransaction(f.actor, 0, (context) => context.db.prepare(
      'SELECT token_ref,account_generation,credential_generation FROM server_oauth_token_bindings WHERE workspace_id=? ORDER BY token_ref')
      .all(context.workspaceId));
    assert.deepEqual(bindings, [{ token_ref: 'new-ref', account_generation: 2, credential_generation: 2 }]);
  } finally { f.close(); }
});

test('disconnected token cleanup deletes only its exact old-generation ciphertext', async () => {
  const f = fixture();
  try {
    f.kernel.recordAccountGeneration(f.actor, f.accountId, 4);
    f.setAccounts([f.account('old-ref', 4)]);
    await f.store.set('old-ref', f.token('old-access'));

    f.kernel.recordAccountGeneration(f.actor, f.accountId, 5);
    f.setAccounts([]);
    await f.store.delete('old-ref');

    const metadata = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.getMetadataWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 5 }, 'googleOAuth'));
    assert.deepEqual(metadata, { configured: false, generation: 2 });
    const remaining = f.kernel.withOwnedTransaction(f.actor, 0, (context) => context.db.prepare(
      'SELECT count(*) AS count FROM server_oauth_token_bindings WHERE workspace_id=?').get(context.workspaceId).count);
    assert.equal(remaining, 0);
  } finally { f.close(); }
});

test('old tokenRef cannot tombstone a vault slot whose credential generation changed', async () => {
  const f = fixture();
  try {
    f.kernel.recordAccountGeneration(f.actor, f.accountId, 7);
    f.setAccounts([f.account('old-ref', 7)]);
    await f.store.set('old-ref', f.token('old-access'));
    f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 7 }, 'googleOAuth', 1,
      JSON.stringify(f.token('replacement-access'))));
    f.setAccounts([]);
    await f.store.delete('old-ref');
    const stored = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 7 }, 'googleOAuth'));
    assert.equal(JSON.parse(stored).accessToken, 'replacement-access');
  } finally { f.close(); }
});

test('failed exact token deletion rolls back both vault ciphertext and binding retirement', async () => {
  const f = fixture();
  try {
    f.kernel.recordAccountGeneration(f.actor, f.accountId, 3);
    f.setAccounts([f.account('old-ref', 3)]);
    await f.store.set('old-ref', f.token('old-access'));
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TRIGGER reject_oauth_vault_tombstone BEFORE UPDATE ON vault_metadata
      WHEN OLD.scope_type='account' AND OLD.purpose='googleOAuth' BEGIN SELECT RAISE(ABORT,'synthetic tombstone failure'); END;`));
    f.setAccounts([]);
    await assert.rejects(f.store.delete('old-ref'), /synthetic tombstone failure/);
    const secret = f.kernel.withOwnedTransaction(f.actor, 0, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 3 }, 'googleOAuth'));
    assert.equal(JSON.parse(secret).accessToken, 'old-access');
    const bindingCount = f.kernel.withOwnedTransaction(f.actor, 0, (context) => context.db.prepare(
      'SELECT count(*) AS count FROM server_oauth_token_bindings WHERE workspace_id=? AND token_ref=?')
      .get(context.workspaceId, 'old-ref').count);
    assert.equal(bindingCount, 1);
  } finally { f.close(); }
});
