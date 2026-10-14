import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveAuthSecret, loadOrCreateVaultRootKey, loadServerConfig, ServerConfigError } from '../dist/config.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'still-config-'));
  const staticRoot = join(root, 'public');
  const dataDirectory = join(root, 'private', 'data');
  const keyDirectory = join(root, 'private', 'keys');
  mkdirSync(staticRoot);
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(keyDirectory, { recursive: true });
  return { root, staticRoot, dataDirectory, keyDirectory, keyPath: join(keyDirectory, 'vault.key'), dbPath: join(dataDirectory, 'still.sqlite'),
    env: { STILL_ORIGIN: 'https://still.example', STILL_DATA_DIR: dataDirectory, STILL_VAULT_KEY_FILE: join(keyDirectory, 'vault.key') },
    close: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('server config accepts only canonical origins and private absolute paths', () => {
  const f = fixture();
  try {
    const config = loadServerConfig(f.env, { staticRoot: f.staticRoot });
    assert.equal(config.canonicalOrigin, 'https://still.example');
    assert.equal(config.databasePath, f.dbPath);
    assert.equal(config.host, '127.0.0.1');
    for (const origin of ['https://still.example/path', 'https://user@still.example', 'https://still.example/', 'http://still.example']) {
      assert.throws(() => loadServerConfig({ ...f.env, STILL_ORIGIN: origin }, { staticRoot: f.staticRoot }), ServerConfigError);
    }
    assert.equal(loadServerConfig({ ...f.env, STILL_ORIGIN: 'http://127.0.0.1:8080' }, { staticRoot: f.staticRoot, allowLocalHttp: true }).allowLocalHttp, true);
    assert.throws(() => loadServerConfig({ ...f.env, STILL_DATA_DIR: 'relative' }, { staticRoot: f.staticRoot }), ServerConfigError);
    assert.throws(() => loadServerConfig({ ...f.env, STILL_VAULT_KEY_FILE: join(f.dataDirectory, 'key') }, { staticRoot: f.staticRoot }), ServerConfigError);
    assert.throws(() => loadServerConfig({ ...f.env, STILL_DATA_DIR: join(f.staticRoot, 'private') }, { staticRoot: f.staticRoot }), ServerConfigError);
  } finally { f.close(); }
});

test('root-key creation is exclusive, exact-size, stable across restart, and refuses key loss for a nonempty database', () => {
  const f = fixture();
  try {
    const config = loadServerConfig(f.env, { staticRoot: f.staticRoot });
    const first = loadOrCreateVaultRootKey(config);
    assert.equal(first.length, 32);
    const persisted = readFileSync(f.keyPath);
    assert.equal(persisted.length, 32);
    assert.deepEqual(loadOrCreateVaultRootKey(config), persisted);
    const derived = deriveAuthSecret(first);
    assert.equal(derived.length, 32);
    assert.notDeepEqual(derived, first);
    first.fill(0); derived.fill(0);
    if (process.platform === 'linux') assert.equal(statSync(f.keyPath).mode & 0o077, 0);

    rmSync(f.keyPath);
    writeFileSync(f.dbPath, 'existing database bytes');
    assert.throws(() => loadOrCreateVaultRootKey(config), (error) => error.code === 'missing_key_existing_database');
    assert.equal(readFileSync(f.dbPath, 'utf8'), 'existing database bytes');
    assert.equal(exists(f.keyPath), false);
  } finally { f.close(); }
});

test('invalid existing key is never replaced and any database or SQLite sidecar requires its original key', () => {
  const f = fixture();
  try {
    const config = loadServerConfig(f.env, { staticRoot: f.staticRoot });
    writeFileSync(f.dbPath, Buffer.alloc(0));
    assert.throws(() => loadOrCreateVaultRootKey(config), (error) => error.code === 'missing_key_existing_database');
    rmSync(f.dbPath);
    writeFileSync(`${f.dbPath}-wal`, Buffer.alloc(0));
    assert.throws(() => loadOrCreateVaultRootKey(config), (error) => error.code === 'missing_key_existing_database');
    rmSync(`${f.dbPath}-wal`);
    const created = loadOrCreateVaultRootKey(config);
    assert.equal(created.length, 32);
    created.fill(0);
    const before = readFileSync(f.keyPath);
    writeFileSync(f.keyPath, 'wrong-size');
    assert.throws(() => loadOrCreateVaultRootKey(config));
    assert.equal(readFileSync(f.keyPath, 'utf8'), 'wrong-size');
    assert.notDeepEqual(before, readFileSync(f.keyPath));
  } finally { f.close(); }
});

test('configured path aliases through symlink ancestors fail before creating private files', (t) => {
  const f = fixture();
  try {
    const alias = join(f.root, 'public-alias');
    try { symlinkSync(f.staticRoot, alias, 'dir'); }
    catch { t.skip('symlink creation is unavailable in this environment'); return; }
    assert.throws(() => loadServerConfig({ ...f.env, STILL_DATA_DIR: join(alias, 'private') }, { staticRoot: f.staticRoot }), ServerConfigError);
    const aliasedKeyConfig = { ...loadServerConfig(f.env, { staticRoot: f.staticRoot }), vaultKeyFile: join(alias, 'vault.key') };
    assert.throws(() => loadOrCreateVaultRootKey(aliasedKeyConfig), ServerConfigError);
    assert.equal(exists(aliasedKeyConfig.vaultKeyFile), false);
  } finally { f.close(); }
});

function exists(path) { try { readFileSync(path); return true; } catch { return false; } }
