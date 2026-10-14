import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { ServerCredentialCommandService } from '../dist/credentialCommands.js';
import { createDurableKernel } from '../dist/kernel.js';
import { ServerProviderCredentialService, ServerProviderCredentialError } from '../dist/providerCredentials.js';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { SecretVault } from '../dist/vault.js';

const ORIGIN = 'https://provider-credentials.example.test';
const PASSWORD = 'provider credential test password';
const SNAPSHOT = { notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [] };

function canonical(value) {
  const stable = (item) => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(stable);
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])]));
  };
  return JSON.stringify(stable(value));
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-provider-credentials-'));
  const databasePath = join(directory, 'private', 'still.sqlite');
  const rootKey = randomBytes(32);
  let now = Date.now();
  const kernel = createDurableKernel({ databasePath, now: () => now, validateSnapshot(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  const vault = new SecretVault(kernel, rootKey);
  const authSecret = randomBytes(32);
  const auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, authSecret, now: () => now });
  authSecret.fill(0);
  const commands = new ServerCredentialCommandService(kernel, vault, { now: () => now });
  const actors = new ProcessWorkspaceActors(kernel);
  return {
    directory, databasePath, rootKey, kernel, vault, auth, commands, actors,
    async enroll() {
      await auth.enrollOwner(PASSWORD, SNAPSHOT);
      const challenge = auth.createLoginChallenge(ORIGIN);
      const login = await auth.login({ password: PASSWORD, origin: ORIGIN,
        preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
      const identity = kernel.getOwnedIdentity(login.sessionToken);
      const actorToken = actors.sessionForRegistry(identity);
      return { login, identity, actorToken };
    },
    cleanup() {
      try { vault.close(); } catch { /* fixture teardown */ }
      try { auth.close(); } catch { /* fixture teardown */ }
      try { kernel.close(); } catch { /* fixture teardown */ }
      rootKey.fill(0);
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function reader(f, token, identity) {
  return new ServerProviderCredentialService(f.kernel, f.vault, token, identity);
}

function put(f, sessionToken, keys, expectedGenerations, id = randomUUID()) {
  return f.commands.put(sessionToken, id, canonical({ expectedPrivacyEpoch: 0, expectedGenerations, keys }));
}

function deleteCredentials(f, sessionToken, kinds, expectedGenerations, id = randomUUID()) {
  return f.commands.delete(sessionToken, id, canonical({ expectedPrivacyEpoch: 0,
    expectedGenerations, kinds: [...kinds].sort() }));
}

function tokenHash(token) { return createHash('sha256').update(token, 'utf8').digest('hex'); }

test('reads encrypted workspace credentials and authoritative generations while metadata stays secret-free', async () => {
  const f = setup();
  const sentinels = { speech: 'SPEECH_SERVER_READER_SENTINEL_8f42', openrouter: 'OPENROUTER_SERVER_READER_SENTINEL_198b' };
  try {
    const { login, identity, actorToken } = await f.enroll();
    const service = reader(f, actorToken, identity);
    assert.deepEqual(await service.readSpeechCredentialSnapshot(), { key: null, generation: 0 });
    assert.deepEqual(await service.readProviderCredentialSnapshot('openrouter'), { key: null, generation: 0 });
    assert.deepEqual(await service.readProviderCredentialSnapshot('openai'), { key: null, generation: 0 });
    assert.equal(service.currentSpeechCredentialGeneration(), 0);
    assert.equal(service.currentProviderCredentialGeneration('openrouter'), 0);
    assert.equal(service.currentProviderCredentialGeneration('openai'), 0);
    assert.deepEqual(await service.getCredentials(), { speechConfigured: false, openAiConfigured: false, openRouterConfigured: false });

    put(f, login.sessionToken, sentinels, { speech: 0, openrouter: 0 });
    assert.deepEqual(await service.readSpeechCredentialSnapshot(), { key: sentinels.speech, generation: 1 });
    assert.deepEqual(await service.readProviderCredentialSnapshot('openrouter'), { key: sentinels.openrouter, generation: 1 });
    assert.equal(await service.readProviderCredential('openai'), null, 'Azure text credentials remain unconfigured');
    assert.deepEqual(await service.getCredentials(), { speechConfigured: true, openAiConfigured: false, openRouterConfigured: true });
    assert.equal(JSON.stringify(await service.getCredentials()).includes('SENTINEL'), false);

    const database = readFileSync(f.databasePath).toString('utf8');
    const wal = existsSync(`${f.databasePath}-wal`) ? readFileSync(`${f.databasePath}-wal`).toString('utf8') : '';
    for (const key of Object.values(sentinels)) {
      assert.equal(database.includes(key), false);
      assert.equal(wal.includes(key), false);
    }
    assert.equal(database.includes(actorToken), false);
    assert.equal(database.includes(tokenHash(actorToken)), false);
  } finally { f.cleanup(); }
});

test('rotation immediately invalidates captured generations and deletion preserves the tombstone', async () => {
  const f = setup();
  try {
    const { login, identity, actorToken } = await f.enroll();
    const service = reader(f, actorToken, identity);
    put(f, login.sessionToken, { openrouter: 'OPENROUTER_OLD_SYNTHETIC_KEY' }, { openrouter: 0 });
    const old = await service.readProviderCredentialSnapshot('openrouter');
    assert.deepEqual(old, { key: 'OPENROUTER_OLD_SYNTHETIC_KEY', generation: 1 });
    put(f, login.sessionToken, { openrouter: 'OPENROUTER_ROTATED_SYNTHETIC_KEY' }, { openrouter: 1 });
    assert.throws(() => service.assertProviderCredentialGeneration('openrouter', old.generation),
      (error) => error instanceof ServerProviderCredentialError && error.code === 'generation_changed');
    assert.equal(service.currentProviderCredentialGeneration('openrouter'), 2);
    assert.deepEqual(await service.readProviderCredentialSnapshot('openrouter'),
      { key: 'OPENROUTER_ROTATED_SYNTHETIC_KEY', generation: 2 });

    deleteCredentials(f, login.sessionToken, ['openrouter'], { openrouter: 2 });
    assert.deepEqual(await service.readProviderCredentialSnapshot('openrouter'), { key: null, generation: 3 });
    assert.equal(service.currentProviderCredentialGeneration('openrouter'), 3);
  } finally { f.cleanup(); }
});

test('service refuses mutation paths and rejects mismatched owner, workspace, epoch, actor, or vault connections', async () => {
  const f = setup();
  const other = setup();
  try {
    const { login, identity, actorToken } = await f.enroll();
    const { identity: otherIdentity, actorToken: otherActor } = await other.enroll();
    const service = reader(f, actorToken, identity);
    await assert.rejects(service.setCredentials({ speechSubscriptionKey: 'UNUSED_SYNTHETIC_KEY' }),
      /trusted credential command service/);
    await assert.rejects(service.deleteCredentials('speech'), /trusted credential command service/);
    assert.equal(service.currentSpeechCredentialGeneration(), 0);

    assert.throws(() => reader(f, actorToken, { ...identity, ownerId: randomUUID() }), /binding is invalid/);
    assert.throws(() => reader(f, actorToken, { ...identity, workspaceId: otherIdentity.workspaceId }), /binding is invalid/);
    assert.throws(() => reader(f, actorToken, { ...identity, privacyEpoch: identity.privacyEpoch + 1 }), /privacy epoch changed/i);
    assert.throws(() => reader(f, otherActor, identity), /invalid or expired/i);
    assert.throws(() => reader(f, actorToken, otherIdentity), /binding is invalid/);
    assert.throws(() => new ServerProviderCredentialService(f.kernel, other.vault, actorToken, identity), /transaction context/i);

    f.kernel.runLocalCommand(login.sessionToken, { expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch, idempotencyKey: 'erase-provider-reader-workspace',
      type: 'workspace.privacy.erase', canonicalRequest: '{"erase":true}' }, () => ({
      snapshot: SNAPSHOT, receipt: { kind: 'privacy_erased' }, privacyEpoch: identity.privacyEpoch + 1,
    }));
    assert.throws(() => service.currentProviderCredentialGeneration('speech'), /invalid or expired/i);
  } finally { f.cleanup(); other.cleanup(); }
});

test('vault generations and actual key snapshots survive reopening with the same root key', async () => {
  const f = setup();
  try {
    const { login, identity, actorToken } = await f.enroll();
    put(f, login.sessionToken, { speech: 'SPEECH_RESTART_SYNTHETIC_KEY' }, { speech: 0 });
    f.vault.close();
    f.kernel.close();

    const reopenedKernel = createDurableKernel({ databasePath: f.databasePath, validateSnapshot(value) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    } });
    const reopenedVault = new SecretVault(reopenedKernel, f.rootKey);
    try {
      const reopened = new ServerProviderCredentialService(reopenedKernel, reopenedVault, actorToken, identity);
      assert.deepEqual(await reopened.readSpeechCredentialSnapshot(), { key: 'SPEECH_RESTART_SYNTHETIC_KEY', generation: 1 });
      assert.equal(reopened.currentSpeechCredentialGeneration(), 1);
    } finally { reopenedVault.close(); reopenedKernel.close(); }
  } finally { f.cleanup(); }
});
