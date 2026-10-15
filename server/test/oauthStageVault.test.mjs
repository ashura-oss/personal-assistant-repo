import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel, KernelError, SecretVault, VaultError } from '../dist/index.js';

const rootKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x31 + index));
const binding = () => ({ stageId: randomUUID(), initiatingSessionBinding: 'b'.repeat(64), registrationId: 'google-main.v1',
  provider: 'google', expiresAt: 1_900_000_000_000, payloadKind: 'authorization', payloadGeneration: 1 });

function setup() {
  const directory = mkdtempSync(join(process.cwd(), '.test-data-oauth-stage-'));
  const databasePath = join(directory, 'kernel.sqlite');
  const now = () => 1_800_000_000_000;
  const ownerId = randomUUID();
  const validateSnapshot = (snapshot) => assert.ok(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot));
  const kernel = createDurableKernel({ databasePath, validateSnapshot, now });
  const workspace = kernel.createWorkspace(ownerId, { data: 'fixture' });
  const session = kernel.createSession(workspace.workspaceId, ownerId, now() + 60 * 60 * 1000);
  const vault = new SecretVault(kernel, rootKey);
  return { directory, databasePath, now, ownerId, validateSnapshot, kernel, workspace, session, vault };
}

function closeAndRemove(f) {
  f.vault?.close();
  f.kernel?.close();
  try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error; }
}

const inOwned = (f, callback, session = f.session, epoch = 0) => f.kernel.withOwnedTransaction(session, epoch, callback);
const assertVaultFailure = (fn, code) => assert.throws(fn,
  (error) => error instanceof VaultError && error.code === code && !error.message.includes('synthetic-stage-secret'));

test('stage encryption round-trips each provider and payload kind with fresh nonces and no account-vault writes', () => {
  const f = setup();
  try {
    const original = 'synthetic-stage-secret:authorization-and-verified-payload';
    const ciphertexts = [];
    for (const provider of ['google', 'microsoft']) {
      for (const payloadKind of ['authorization', 'verified']) {
        const currentBinding = { ...binding(), provider, payloadKind };
        const encrypted = inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, currentBinding, original));
        ciphertexts.push(encrypted);
        assert.deepEqual(Object.keys(encrypted).sort(), ['ciphertext', 'format', 'nonce', 'tag']);
        assert.equal(encrypted.format, 1);
        assert.equal(encrypted.nonce.length, 12);
        assert.equal(encrypted.tag.length, 16);
        assert.equal(inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, currentBinding, encrypted)), original);
      }
    }
    const sameBinding = { ...binding(), provider: 'google', payloadKind: 'authorization' };
    const first = inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, sameBinding, original));
    const second = inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, sameBinding, original));
    assert.notDeepEqual(first.nonce, second.nonce);
    assert.notDeepEqual(first.ciphertext, second.ciphertext);
    assert.equal(ciphertexts.length, 4);

    const normalVaultRows = inOwned(f, (context) => ({
      metadata: context.db.prepare('SELECT count(*) AS count FROM vault_metadata').get().count,
      ciphertexts: context.db.prepare('SELECT count(*) AS count FROM vault_ciphertexts').get().count,
      stageTables: context.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE '%oauth_stage%'").get().count,
    }));
    assert.deepEqual(normalVaultRows, { metadata: 0, ciphertexts: 0, stageTables: 0 });
  } finally { closeAndRemove(f); }
});

test('same root key reopens stage ciphertext and wrong root key fails through the normal verifier', () => {
  const f = setup();
  const currentBinding = binding();
  const secret = 'synthetic-stage-secret:reopen';
  try {
    const ciphertext = inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, currentBinding, secret));
    f.vault.close();
    f.kernel.close();
    f.kernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    f.session = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, f.now() + 60 * 60 * 1000);
    f.vault = new SecretVault(f.kernel, rootKey);
    assert.equal(inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, currentBinding, ciphertext)), secret);

    f.vault.close();
    f.kernel.close();
    const wrongKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    assert.throws(() => new SecretVault(wrongKernel, Buffer.alloc(32, 0x7f)),
      (error) => error instanceof VaultError && error.code === 'vault_wrong_root_key');
    wrongKernel.close();
  } finally { closeAndRemove(f); }
});

test('all OAuth-stage binding fields are authenticated as associated data', () => {
  const f = setup();
  const originalBinding = binding();
  const secret = 'synthetic-stage-secret:binding';
  try {
    const ciphertext = inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, originalBinding, secret));
    const alternatives = [
      { ...originalBinding, stageId: randomUUID() },
      { ...originalBinding, initiatingSessionBinding: 'c'.repeat(64) },
      { ...originalBinding, registrationId: 'other-registration' },
      { ...originalBinding, provider: 'microsoft' },
      { ...originalBinding, expiresAt: originalBinding.expiresAt + 1 },
      { ...originalBinding, payloadKind: 'verified' },
      { ...originalBinding, payloadGeneration: originalBinding.payloadGeneration + 1 },
    ];
    for (const altered of alternatives) {
      assertVaultFailure(() => inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, altered, ciphertext)),
        'oauth_stage_open_failed');
    }
  } finally { closeAndRemove(f); }
});

test('owner, workspace, and privacy epoch substitutions cannot open a stage ciphertext', () => {
  const f = setup();
  const currentBinding = binding();
  const secret = 'synthetic-stage-secret:context';
  try {
    const ciphertext = inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, currentBinding, secret));
    const sameOwnerWorkspace = f.kernel.createWorkspace(f.ownerId, { data: 'second workspace' });
    const sameOwnerSession = f.kernel.createSession(sameOwnerWorkspace.workspaceId, f.ownerId, f.now() + 60 * 60 * 1000);
    assertVaultFailure(() => inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, currentBinding, ciphertext), sameOwnerSession),
      'oauth_stage_open_failed');

    const otherOwner = randomUUID();
    const otherWorkspace = f.kernel.createWorkspace(otherOwner, { data: 'other owner' });
    const otherSession = f.kernel.createSession(otherWorkspace.workspaceId, otherOwner, f.now() + 60 * 60 * 1000);
    assertVaultFailure(() => inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, currentBinding, ciphertext), otherSession),
      'oauth_stage_open_failed');

    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('UPDATE workspaces SET privacy_epoch = 1 WHERE id = ?').run(f.workspace.workspaceId));
    f.session = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, f.now() + 60 * 60 * 1000);
    assertVaultFailure(() => inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, currentBinding, ciphertext), f.session, 1),
      'oauth_stage_open_failed');
  } finally { closeAndRemove(f); }
});

test('tampering, oversize values, malformed closed records, and accessors fail without invoking getters', () => {
  const f = setup();
  const currentBinding = binding();
  const secret = 'synthetic-stage-secret:tamper';
  try {
    const ciphertext = inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, currentBinding, secret));
    for (const field of ['nonce', 'tag', 'ciphertext']) {
      const modified = { ...ciphertext, [field]: Buffer.from(ciphertext[field]) };
      modified[field][0] ^= 1;
      assertVaultFailure(() => inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, currentBinding, modified)),
        'oauth_stage_open_failed');
    }
    assertVaultFailure(() => inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, currentBinding,
      { ...ciphertext, ciphertext: Buffer.alloc(64 * 1024 + 1) })), 'oauth_stage_invalid_ciphertext');
    assertVaultFailure(() => inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, currentBinding, 'x'.repeat(64 * 1024 + 1))),
      'oauth_stage_invalid_plaintext');
    assertVaultFailure(() => inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, currentBinding, '\ud800')),
      'oauth_stage_invalid_plaintext');

    let getterCalls = 0;
    const accessorBinding = { ...currentBinding };
    Object.defineProperty(accessorBinding, 'stageId', { enumerable: true, configurable: true, get() { getterCalls += 1; return currentBinding.stageId; } });
    assertVaultFailure(() => inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, accessorBinding, secret)),
      'oauth_stage_invalid_binding');
    const accessorCiphertext = { ...ciphertext };
    Object.defineProperty(accessorCiphertext, 'nonce', { enumerable: true, configurable: true, get() { getterCalls += 1; return ciphertext.nonce; } });
    assertVaultFailure(() => inOwned(f, (context) => f.vault.openOAuthStageWithinTransaction(context, currentBinding, accessorCiphertext)),
      'oauth_stage_invalid_ciphertext');
    assert.equal(getterCalls, 0);
  } finally { closeAndRemove(f); }
});

test('closed vault and expired transaction contexts reject stage operations', () => {
  const f = setup();
  const currentBinding = binding();
  let escapedContext;
  try {
    inOwned(f, (context) => { escapedContext = context; });
    assert.throws(() => f.vault.sealOAuthStageWithinTransaction(escapedContext, currentBinding, 'synthetic-stage-secret:closed-context'),
      (error) => error instanceof KernelError && error.code === 'transaction_context_expired');
    f.vault.close();
    assertVaultFailure(() => inOwned(f, (context) => f.vault.sealOAuthStageWithinTransaction(context, currentBinding, 'synthetic-stage-secret:closed-vault')),
      'vault_closed');
  } finally { closeAndRemove(f); }
});
