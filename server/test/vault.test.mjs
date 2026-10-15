import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createDurableKernel, KernelError, SecretVault, VaultError, loadVaultRootKey } from '../dist/index.js';

const rootKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));

function setup() {
  const directory = mkdtempSync(join(process.cwd(), '.test-data-vault-'));
  const databasePath = join(directory, 'kernel.sqlite');
  let time = 1_800_000_000_000;
  const now = () => time;
  const ownerId = randomUUID();
  const accountId = randomUUID();
  const validateSnapshot = (snapshot) => assert.ok(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot));
  const kernel = createDurableKernel({ databasePath, validateSnapshot, now });
  const workspace = kernel.createWorkspace(ownerId, { data: 'fixture' });
  const session = kernel.createSession(workspace.workspaceId, ownerId, now() + 60 * 60 * 1000);
  const vault = new SecretVault(kernel, rootKey);
  return { directory, databasePath, now, advance: (ms) => { time += ms; }, ownerId, accountId, validateSnapshot,
    kernel, workspace, session, vault };
}

function closeAndRemove(fixture, ...extraKernels) {
  fixture.vault?.close();
  fixture.kernel?.close();
  for (const kernel of extraKernels) kernel?.close();
  try { rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error; }
}

function inOwned(fixture, callback, session = fixture.session, epoch = 0) {
  return fixture.kernel.withOwnedTransaction(session, epoch, callback);
}

function privacyReset(fixture) {
  return inOwned(fixture, (context) => {
    fixture.vault.eraseWithinTransaction(context);
    return fixture.kernel.runLocalCommand(fixture.session, {
      expectedRevision: context.revision,
      expectedPrivacyEpoch: context.privacyEpoch,
      idempotencyKey: randomUUID(),
      type: 'privacy.erase',
      canonicalRequest: '{}',
    }, () => ({ snapshot: { data: 'erased' }, receipt: { erased: true }, privacyEpoch: context.privacyEpoch + 1 }));
  });
}

test('owned DB hooks authenticate inside the transaction, freeze context, and reject asynchronous work', () => {
  const f = setup();
  try {
    let escapedContext;
    const rowCount = inOwned(f, (context) => {
      assert.equal(Object.isFrozen(context), true);
      assert.equal(context.workspaceId, f.workspace.workspaceId);
      escapedContext = context;
      context.db.prepare('INSERT INTO account_generations (workspace_id, account_id, generation, updated_at) VALUES (?, ?, 0, ?)')
        .run(context.workspaceId, f.accountId, context.now);
      return context.db.prepare('SELECT count(*) AS count FROM account_generations WHERE workspace_id = ?').get(context.workspaceId).count;
    });
    assert.equal(rowCount, 1);
    assert.throws(() => f.kernel.withOwnedTransaction(f.session, 1, () => true),
      (error) => error instanceof KernelError && error.code === 'stale_epoch');
    assert.throws(() => f.kernel.withOwnedTransaction(f.session, 0, () => Promise.resolve('no')),
      (error) => error instanceof KernelError && error.code === 'invalid_mutator');
    let asyncInvoked = false;
    assert.throws(() => f.kernel.withOwnedTransaction(f.session, 0, async () => { asyncInvoked = true; return 'no'; }),
      (error) => error instanceof KernelError && error.code === 'invalid_mutator');
    assert.equal(asyncInvoked, false);
    const beforeFailedPromise = inOwned(f, (context) => context.db.prepare('SELECT count(*) AS count FROM account_generations').get().count);
    assert.throws(() => f.kernel.withOwnedTransaction(f.session, 0, (context) => {
      context.db.prepare('INSERT INTO account_generations (workspace_id, account_id, generation, updated_at) VALUES (?, ?, 0, ?)')
        .run(context.workspaceId, randomUUID(), context.now);
      return Promise.resolve('late');
    }), (error) => error instanceof KernelError && error.code === 'invalid_mutator');
    assert.equal(inOwned(f, (context) => context.db.prepare('SELECT count(*) AS count FROM account_generations').get().count), beforeFailedPromise);
    assert.throws(() => f.kernel.withOwnedTransaction(randomUUID(), 0, () => true),
      (error) => error instanceof KernelError && error.code === 'unauthenticated');
    assert.equal(inOwned(f, (context) => context.db.prepare('SELECT count(*) AS count FROM account_generations').get().count), 1);
    assert.throws(() => f.vault.getSecretWithinTransaction(escapedContext, { type: 'workspace' }, 'openrouter'),
      (error) => error instanceof KernelError && error.code === 'transaction_context_expired');
  } finally { closeAndRemove(f); }
});

test('vault encrypts workspace and account credentials, persists generations, and leaves no plaintext in SQLite files', () => {
  const f = setup();
  const workspaceSentinel = 'workspace-token-plaintext-sentinel-87f2d';
  const accountSentinel = 'oauth-refresh-token-plaintext-sentinel-21a9c';
  try {
    f.kernel.recordAccountGeneration(f.session, f.accountId, 8);
    assert.deepEqual(inOwned(f, (context) => f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, workspaceSentinel)),
      { configured: true, generation: 1 });
    assert.deepEqual(inOwned(f, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 8 }, 'googleOAuth', 0, accountSentinel)),
      { configured: true, generation: 1 });
    const walPath = `${f.databasePath}-wal`;
    const liveWal = readFileSync(walPath);
    assert.ok(liveWal.length > 0, 'SQLite WAL should be active before connections close');
    assert.equal(liveWal.includes(Buffer.from(workspaceSentinel)), false, 'workspace secret must not appear in active WAL');
    assert.equal(liveWal.includes(Buffer.from(accountSentinel)), false, 'account secret must not appear in active WAL');
    assert.equal(JSON.stringify(f.vault).includes(rootKey.toString('hex')), false);
    assert.equal(JSON.stringify(f.vault).includes(workspaceSentinel), false);
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter')), workspaceSentinel);
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 8 }, 'googleOAuth')), accountSentinel);
    const metadataColumns = inOwned(f, (context) => context.db.prepare('PRAGMA table_info(vault_metadata)').all().map((column) => column.name));
    assert.deepEqual(metadataColumns, ['workspace_id', 'scope_type', 'scope_id', 'purpose', 'generation', 'configured']);

    f.vault.close();
    f.kernel.close();
    const reopened = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    f.kernel = reopened;
    f.session = reopened.createSession(f.workspace.workspaceId, f.ownerId, f.now() + 60 * 60 * 1000);
    f.vault = new SecretVault(reopened, rootKey);
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter'), f.session), workspaceSentinel);
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 8 }, 'googleOAuth'), f.session), accountSentinel);
    assert.deepEqual(inOwned(f, (context) => f.vault.deleteSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 8 }, 'googleOAuth', 1), f.session),
      { configured: false, generation: 2 });
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 8 }, 'googleOAuth'), f.session), undefined);
    assert.throws(() => inOwned(f, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 8 }, 'googleOAuth', 1, accountSentinel), f.session),
      (error) => error instanceof VaultError && error.code === 'stale_generation');
    assert.deepEqual(inOwned(f, (context) => f.vault.deleteSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 1), f.session),
      { configured: false, generation: 2 });
    assert.throws(() => inOwned(f, (context) => f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 1, workspaceSentinel), f.session),
      (error) => error instanceof VaultError && error.code === 'stale_generation');
    f.vault.close();
    f.kernel.close();
    const reopenedAgain = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    f.kernel = reopenedAgain;
    f.session = reopenedAgain.createSession(f.workspace.workspaceId, f.ownerId, f.now() + 60 * 60 * 1000);
    f.vault = new SecretVault(reopenedAgain, rootKey);
    assert.deepEqual(inOwned(f, (context) => f.vault.getMetadataWithinTransaction(context, { type: 'workspace' }, 'openrouter'), f.session),
      { configured: false, generation: 2 });
    assert.deepEqual(inOwned(f, (context) => f.vault.getMetadataWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 8 }, 'googleOAuth'), f.session),
      { configured: false, generation: 2 });
    f.vault.close();
    f.kernel.close();
    const files = [f.databasePath, `${f.databasePath}-wal`, `${f.databasePath}-shm`].filter((path) => {
      try { return readFileSync(path).length > 0; } catch { return false; }
    });
    for (const file of files) {
      const bytes = readFileSync(file);
      assert.equal(bytes.includes(Buffer.from(workspaceSentinel)), false, `plaintext found in ${file}`);
      assert.equal(bytes.includes(Buffer.from(accountSentinel)), false, `plaintext found in ${file}`);
    }
  } finally { closeAndRemove(f); }
});

test('account generation mismatch invalidates stored credentials and ciphertext authentication is bound to AAD', () => {
  const f = setup();
  try {
    f.kernel.recordAccountGeneration(f.session, f.accountId, 4);
    inOwned(f, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 4 }, 'googleOAuth', 0, 'account-secret'));
    assert.equal(f.kernel.getOwnedSnapshot(f.session).privacyEpoch, 0);
    assert.equal(inOwned(f, (context) => context.db.prepare('SELECT generation FROM account_generations WHERE account_id = ?')
      .get(f.accountId).generation), 4);
    f.kernel.recordAccountGeneration(f.session, f.accountId, 6);
    assert.throws(() => inOwned(f, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 4 }, 'googleOAuth')),
      (error) => error instanceof VaultError && error.code === 'stale_account_generation');
    assert.deepEqual(inOwned(f, (context) => f.vault.getMetadataWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 6 }, 'googleOAuth')),
      { configured: false, generation: 1 });
    assert.deepEqual(inOwned(f, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 6 }, 'googleOAuth', 1, 'replacement-token')),
      { configured: true, generation: 2 });
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 6 }, 'googleOAuth')), 'replacement-token');
    assert.equal(inOwned(f, (context) => context.db.prepare('SELECT generation FROM account_generations WHERE account_id = ?')
      .get(f.accountId).generation), 6);

    inOwned(f, (context) => {
      f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'first-purpose');
      f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'azureSpeech', 0, 'second-purpose');
      const row = context.db.prepare(`SELECT nonce, tag, ciphertext FROM vault_ciphertexts
        WHERE workspace_id = ? AND scope_type = 'workspace' AND purpose = 'openrouter'`).get(context.workspaceId);
      context.db.prepare(`UPDATE vault_ciphertexts SET nonce = ?, tag = ?, ciphertext = ?
        WHERE workspace_id = ? AND scope_type = 'workspace' AND purpose = 'azureSpeech'`)
        .run(row.nonce, row.tag, row.ciphertext, context.workspaceId);
    });
    assert.throws(() => inOwned(f, (context) => f.vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'azureSpeech')),
      (error) => error instanceof VaultError && error.code === 'vault_decryption_failed');
  } finally { closeAndRemove(f); }
});

test('vault reads stay bound to the authenticated workspace, active session, and account generation', () => {
  const f = setup();
  try {
    inOwned(f, (context) => f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'workspace-only-secret'));
    const otherOwner = randomUUID();
    const otherWorkspace = f.kernel.createWorkspace(otherOwner, { data: 'other' });
    const otherSession = f.kernel.createSession(otherWorkspace.workspaceId, otherOwner, f.now() + 60 * 60 * 1000);
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter'), otherSession), undefined);

    f.kernel.recordAccountGeneration(f.session, f.accountId, 3);
    assert.deepEqual(inOwned(f, (context) => f.vault.getMetadataWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 3 }, 'googleOAuth')),
      { configured: false, generation: 0 });
    f.kernel.revokeSession(f.session);
    assert.throws(() => inOwned(f, (context) => f.vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter')),
      (error) => error instanceof KernelError && error.code === 'unauthenticated');
  } finally { closeAndRemove(f); }
});

test('nonce, ciphertext, and authentication-tag tampering are rejected without revealing credential bytes', () => {
  for (const column of ['nonce', 'ciphertext', 'tag']) {
    const f = setup();
    const secret = `tamper-proof-secret-${column}`;
    try {
      inOwned(f, (context) => f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, secret));
      inOwned(f, (context) => {
        const row = context.db.prepare(`SELECT ${column} FROM vault_ciphertexts
          WHERE workspace_id = ? AND scope_type = 'workspace' AND purpose = 'openrouter'`).get(context.workspaceId);
        const changed = Buffer.from(row[column]);
        changed[0] ^= 0x01;
        context.db.prepare(`UPDATE vault_ciphertexts SET ${column} = ?
          WHERE workspace_id = ? AND scope_type = 'workspace' AND purpose = 'openrouter'`).run(changed, context.workspaceId);
      });
      assert.throws(() => inOwned(f, (context) => f.vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter')),
        (error) => error instanceof VaultError && error.code === 'vault_decryption_failed' &&
          !error.message.includes(secret));
    } finally { closeAndRemove(f); }
  }
});

test('privacy erasure and epoch advance commit atomically, preserve tombstones, and stale writers cannot restore a key', () => {
  const f = setup();
  try {
    f.kernel.recordAccountGeneration(f.session, f.accountId, 2);
    inOwned(f, (context) => f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'erase-me'));
    inOwned(f, (context) => f.vault.setSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 2 }, 'microsoftOAuth', 0, 'account-erase-me'));
    assert.throws(() => inOwned(f, (context) => {
      f.vault.eraseWithinTransaction(context);
      throw new Error('abort outer privacy reset');
    }), /abort outer privacy reset/);
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter')), 'erase-me');
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 2 }, 'microsoftOAuth')), 'account-erase-me');

    privacyReset(f);
    assert.throws(() => f.kernel.withOwnedTransaction(f.session, 0, () => true),
      (error) => error instanceof KernelError && error.code === 'unauthenticated');
    const freshSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, f.now() + 60 * 60 * 1000);
    f.session = freshSession;
    assert.deepEqual(inOwned(f, (context) => f.vault.getMetadataWithinTransaction(context, { type: 'workspace' }, 'openrouter'), freshSession, 1),
      { configured: false, generation: 2 });
    assert.equal(inOwned(f, (context) => f.vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter'), freshSession, 1), undefined);
    assert.deepEqual(inOwned(f, (context) => f.vault.getMetadataWithinTransaction(context,
      { type: 'account', accountId: f.accountId, expectedAccountGeneration: 2 }, 'microsoftOAuth'), freshSession, 1),
      { configured: false, generation: 2 });
    assert.equal(inOwned(f, (context) => context.db.prepare('SELECT count(*) AS count FROM vault_ciphertexts WHERE workspace_id = ?').get(context.workspaceId).count,
      freshSession, 1), 0);
  } finally { closeAndRemove(f); }
});

test('privacy erasure advances the epoch even when the vault has never held a credential', () => {
  const f = setup();
  try {
    const oldSession = f.session;
    privacyReset(f);
    assert.throws(() => inOwned(f, (context) => f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'late-write'), oldSession),
      (error) => error instanceof KernelError && error.code === 'unauthenticated');
    const newSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, f.now() + 60 * 60 * 1000);
    assert.equal(inOwned(f, (context) => context.db.prepare('SELECT count(*) AS count FROM vault_ciphertexts').get().count, newSession, 1), 0);
  } finally { closeAndRemove(f); }
});

test('wrong root keys and newer vault formats fail without changing vault metadata', () => {
  const f = setup();
  try {
    inOwned(f, (context) => f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'preserve'));
    f.vault.close();
    f.kernel.close();
    const beforeWrongKey = readFileSync(f.databasePath);
    const wrongKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    assert.throws(() => new SecretVault(wrongKernel, Buffer.alloc(32, 0xff)),
      (error) => error instanceof VaultError && error.code === 'vault_wrong_root_key');
    wrongKernel.close();
    assert.deepEqual(readFileSync(f.databasePath), beforeWrongKey);

    const tamper = new Database(f.databasePath);
    tamper.prepare('UPDATE vault_schema SET version = 3 WHERE singleton = 1').run();
    tamper.close();
    const beforeNewerFormat = readFileSync(f.databasePath);
    const newerKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: f.validateSnapshot, now: f.now });
    assert.throws(() => new SecretVault(newerKernel, rootKey),
      (error) => error instanceof VaultError && error.code === 'vault_newer_schema');
    newerKernel.close();
    assert.deepEqual(readFileSync(f.databasePath), beforeNewerFormat);
  } finally { closeAndRemove(f); }
});

test('root-key file loader requires an absolute regular exact-size file and rejects symlinks', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'still-vault-key-'));
  const goodPath = join(directory, 'key.bin');
  const insecurePath = join(directory, 'insecure.bin');
  const shortPath = join(directory, 'short.bin');
  const linkPath = join(directory, 'key-link.bin');
  try {
    writeFileSync(goodPath, rootKey);
    writeFileSync(insecurePath, rootKey);
    if (process.platform === 'linux') chmodSync(goodPath, 0o600);
    if (process.platform === 'linux') {
      chmodSync(insecurePath, 0o644);
      assert.throws(() => loadVaultRootKey(resolve(insecurePath)),
        (error) => error instanceof VaultError && error.code === 'unsafe_root_key_permissions');
    }
    writeFileSync(shortPath, Buffer.alloc(31, 7));
    assert.deepEqual(loadVaultRootKey(resolve(goodPath)), rootKey);
    assert.throws(() => loadVaultRootKey('relative-key.bin'),
      (error) => error instanceof VaultError && error.code === 'invalid_key_path');
    assert.throws(() => loadVaultRootKey(resolve(shortPath)),
      (error) => error instanceof VaultError && error.code === 'invalid_root_key_file');
    try { symlinkSync(goodPath, linkPath); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('symlink creation is unavailable in this environment');
      throw error;
    }
    assert.throws(() => loadVaultRootKey(resolve(linkPath)),
      (error) => error instanceof VaultError && error.code === 'invalid_root_key_file');
  } finally {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error; }
  }
});
