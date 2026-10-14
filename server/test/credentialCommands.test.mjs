import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { ServerCredentialCommandService } from '../dist/credentialCommands.js';
import { SecretVault } from '../dist/vault.js';

function canonical(value) {
  const stable = (item) => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(stable);
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])]));
  };
  return JSON.stringify(stable(value));
}

function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-credential-commands-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const rootKey = randomBytes(32);
  const kernel = createDurableKernel({ databasePath, validateSnapshot: (value) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  const ownerId = randomUUID();
  const initial = { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] };
  const workspace = kernel.createWorkspace(ownerId, initial);
  const sessionA = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const sessionB = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const vault = new SecretVault(kernel, rootKey);
  const service = new ServerCredentialCommandService(kernel, vault, options);
  return { directory, databasePath, rootKey, kernel, ownerId, workspace, sessionA, sessionB, vault, service };
}

function close(f, ...extra) {
  for (const vault of [f.vault, ...extra.map((item) => item.vault).filter(Boolean)]) vault.close();
  for (const kernel of [f.kernel, ...extra.map((item) => item.kernel).filter(Boolean)]) kernel.close();
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('multi-key update commits atomically and returns only safe metadata while secrets stay encrypted in SQLite and WAL', () => {
  const sentinels = ['SPEECH_SENTINEL_NEVER_PERSIST', 'OPENROUTER_SENTINEL_NEVER_PERSIST'];
  const changed = [];
  const f = setup({ onCredentialGenerationChanged: (kind, generation) => { changed.push([kind, generation]); throw new Error('cache hook failed'); } });
  try {
    const body = canonical({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0, openrouter: 0 },
      keys: { speech: sentinels[0], openrouter: sentinels[1] } });
    const metadata = f.service.put(f.sessionA, randomUUID(), body);
    assert.deepEqual(metadata, { workspaceId: f.workspace.workspaceId, privacyEpoch: 0,
      credentials: { speech: { configured: true, generation: 1 }, openrouter: { configured: true, generation: 1 } } });
    assert.deepEqual(changed, [['speech', 1], ['openrouter', 1]]);
    assert.equal(JSON.stringify(metadata).includes('SENTINEL'), false);
    assert.deepEqual(Object.keys(metadata.credentials.speech).sort(), ['configured', 'generation']);
    const databaseBytes = readFileSync(f.databasePath).toString('utf8');
    const walPath = `${f.databasePath}-wal`;
    const walBytes = existsSync(walPath) ? readFileSync(walPath).toString('utf8') : '';
    for (const sentinel of sentinels) {
      assert.equal(databaseBytes.includes(sentinel), false);
      assert.equal(walBytes.includes(sentinel), false);
    }
  } finally { close(f); }
});

test('multi-key generation conflict rolls back every vault mutation and writes no command receipt', () => {
  const f = setup();
  const commandId = randomUUID();
  try {
    const body = canonical({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0, openrouter: 9 },
      keys: { speech: 'SPEECH_ROLLBACK_SENTINEL', openrouter: 'OPENROUTER_ROLLBACK_SENTINEL' } });
    assert.throws(() => f.service.put(f.sessionA, commandId, body), /generation changed/i);
    assert.deepEqual(f.service.getMetadata(f.sessionA).credentials, {
      speech: { configured: false, generation: 0 }, openrouter: { configured: false, generation: 0 },
    });
    assert.deepEqual(f.service.inspect(f.sessionA, commandId), { status: 'inspect_required' });
    f.kernel.withOwnedTransaction(f.sessionA, 0, (context) => {
      assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM credential_commands WHERE workspace_id=? AND command_id=?')
        .get(f.workspace.workspaceId, commandId).count, 0);
    });
  } finally { close(f); }
});

test('exact duplicate survives restart and later key changes without replaying secret writes or lowering current metadata', () => {
  const f = setup();
  const commandId = randomUUID();
  const originalBody = canonical({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0 }, keys: { speech: 'FIRST_SPEECH_SECRET' } });
  try {
    const originalReceipt = f.service.put(f.sessionA, commandId, originalBody);
    f.vault.close();
    f.kernel.close();
    const kernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot: (value) => {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    } });
    const vault = new SecretVault(kernel, f.rootKey);
    const service = new ServerCredentialCommandService(kernel, vault);
    try {
      assert.deepEqual(service.inspect(f.sessionB, commandId), { status: 'finished', metadata: originalReceipt });
      assert.deepEqual(service.put(f.sessionB, commandId, originalBody), originalReceipt);
      const next = service.put(f.sessionB, randomUUID(), canonical({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 1 }, keys: { speech: 'SECOND_SPEECH_SECRET' } }));
      assert.equal(next.credentials.speech.generation, 2);
      assert.deepEqual(service.put(f.sessionB, commandId, originalBody), originalReceipt,
        'lost-ACK replay returns the original safe receipt without restoring the old credential');
      assert.equal(service.getMetadata(f.sessionB).credentials.speech.generation, 2);
      assert.throws(() => service.put(f.sessionB, commandId,
        canonical({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0 }, keys: { speech: 'CHANGED_SECRET' } })), /already bound/i);
      assert.equal(JSON.stringify(service.inspect(f.sessionB, commandId)).includes('FIRST_SPEECH_SECRET'), false);
    } finally { vault.close(); kernel.close(); }
  } finally {
    // The first kernel and vault were closed above to simulate a process restart.
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('strict credential scopes allow only Speech and OpenRouter and delete updates tombstone generations', () => {
  const f = setup();
  try {
    assert.throws(() => f.service.put(f.sessionA, randomUUID(), canonical({ expectedPrivacyEpoch: 0,
      expectedGenerations: { azure: 0 }, keys: { azure: 'UNSUPPORTED_SENTINEL' } })), /unsupported/i);
    assert.throws(() => f.service.put(f.sessionA, randomUUID(), canonical({ expectedPrivacyEpoch: 0,
      expectedGenerations: { speech: 0 }, keys: { azureText: 'UNSUPPORTED_SENTINEL' } })), /unsupported/i);
    const first = f.service.put(f.sessionA, randomUUID(), canonical({ expectedPrivacyEpoch: 0,
      expectedGenerations: { speech: 0, openrouter: 0 }, keys: { speech: 'SPEECH_SECRET', openrouter: 'OPENROUTER_SECRET' } }));
    const deleted = f.service.delete(f.sessionA, randomUUID(), canonical({ expectedPrivacyEpoch: 0,
      expectedGenerations: { openrouter: 1, speech: 1 }, kinds: ['openrouter', 'speech'] }));
    assert.deepEqual(Object.fromEntries(Object.entries(deleted.credentials).map(([kind, value]) => [kind, value.configured])),
      { speech: false, openrouter: false });
    assert.equal(deleted.credentials.speech.generation, first.credentials.speech.generation + 1);
    assert.equal(deleted.credentials.openrouter.generation, first.credentials.openrouter.generation + 1);
    assert.throws(() => f.service.delete(f.sessionA, randomUUID(), canonical({ expectedPrivacyEpoch: 0,
      expectedGenerations: { speech: 1 }, kinds: ['speech'] })), /generation changed/i);
  } finally { close(f); }
});

test('workspace, epoch, and revoked-session fences prevent receipt or metadata access across identities', () => {
  const f = setup();
  const commandId = randomUUID();
  const body = canonical({ expectedPrivacyEpoch: 0, expectedGenerations: { speech: 0 }, keys: { speech: 'EPOCH_SENTINEL_SECRET' } });
  try {
    f.service.put(f.sessionA, commandId, body);
    const otherOwner = randomUUID();
    const otherWorkspace = f.kernel.createWorkspace(otherOwner, { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] });
    const otherSession = f.kernel.createSession(otherWorkspace.workspaceId, otherOwner, Date.now() + 60 * 60_000);
    assert.deepEqual(f.service.inspect(otherSession, commandId), { status: 'inspect_required' });
    assert.equal(f.service.getMetadata(otherSession).credentials.speech.configured, false);

    f.kernel.withOwnedTransaction(f.sessionA, 0, (context) => {
      f.vault.eraseWithinTransaction(context);
      f.kernel.runLocalCommand(f.sessionA, { expectedRevision: 0, expectedPrivacyEpoch: 0, idempotencyKey: 'test:erase-epoch',
        type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
        snapshot: { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] },
        receipt: { kind: 'test.erased' }, privacyEpoch: 1,
      }));
    });
    assert.throws(() => f.service.getMetadata(f.sessionA), /session|epoch|authenticated/i);
    const newSession = f.kernel.createSession(f.workspace.workspaceId, f.ownerId, Date.now() + 60 * 60_000);
    assert.equal(f.service.inspect(newSession, commandId).status, 'inspect_required');
    const current = f.service.getMetadata(newSession);
    assert.equal(current.privacyEpoch, 1);
    assert.equal(current.credentials.speech.configured, false);
    assert.equal(current.credentials.speech.generation, 2);
    assert.throws(() => f.service.put(newSession, commandId,
      canonical({ expectedPrivacyEpoch: 1, expectedGenerations: { speech: 2 }, keys: { speech: 'REUSED_COMMAND_SECRET' } })), /already bound|different content/i);
  } finally { close(f); }
});
