import { createHmac, randomBytes } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVaultRootKey } from './vault.js';

const ROOT_KEY_BYTES = 32;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_ROOT = resolve(MODULE_DIRECTORY, '../../dist-web');

export interface ServerConfig {
  readonly canonicalOrigin: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly vaultKeyFile: string;
  readonly staticRoot: string;
  readonly host: '127.0.0.1';
  readonly allowLocalHttp: boolean;
}

export interface ServerConfigOptions {
  readonly staticRoot?: string;
  readonly allowLocalHttp?: boolean;
}

export class ServerConfigError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ServerConfigError';
  }
}

function fail(code: string, message: string): never { throw new ServerConfigError(message, code); }

function requiredAbsolute(env: NodeJS.ProcessEnv, name: 'STILL_DATA_DIR' | 'STILL_VAULT_KEY_FILE'): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || value.includes('\0')) {
    fail('invalid_config', `${name} must be an absolute path.`);
  }
  return resolve(value);
}

function pathContains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function canonicalPathWithoutSymlinks(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let missing = false;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    if (missing) continue;
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') { missing = true; continue; }
      fail('unsafe_path', 'A configured server path could not be inspected safely.');
    }
    if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) {
      fail('unsafe_path', 'Configured server paths cannot contain symlinks or non-directory ancestors.');
    }
  }
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) fail('unsafe_path', 'A configured server path has no existing canonical ancestor.');
    existing = parent;
  }
  let canonicalAncestor: string;
  try { canonicalAncestor = realpathSync(existing); }
  catch { return fail('unsafe_path', 'A configured server path has no canonical existing ancestor.'); }
  return resolve(canonicalAncestor, relative(existing, absolute));
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    fail('database_path_unavailable', 'A configured database path could not be inspected safely.');
  }
}

function validOrigin(value: unknown, allowLocalHttp: boolean): string {
  if (typeof value !== 'string' || value.length === 0) fail('invalid_config', 'STILL_ORIGIN must be a canonical origin.');
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('invalid_config', 'STILL_ORIGIN is invalid.'); }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.origin !== value || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
    (parsed.protocol !== 'https:' && !(allowLocalHttp && localHttp))) {
    fail('invalid_config', 'STILL_ORIGIN must be HTTPS, or explicit local development HTTP.');
  }
  return value;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, options: ServerConfigOptions = {}): ServerConfig {
  const allowLocalHttp = options.allowLocalHttp === true;
  const canonicalOrigin = validOrigin(env.STILL_ORIGIN, allowLocalHttp);
  const dataDirectory = requiredAbsolute(env, 'STILL_DATA_DIR');
  const vaultKeyFile = requiredAbsolute(env, 'STILL_VAULT_KEY_FILE');
  const staticRootCandidate = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  if (typeof staticRootCandidate !== 'string' || !isAbsolute(staticRootCandidate)) {
    fail('invalid_config', 'The generated static root must be an absolute path.');
  }
  const staticRoot = resolve(staticRootCandidate);
  try {
    const rootStat = lstatSync(staticRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('invalid_static_root', 'The generated static root must be a real directory.');
  } catch (error) {
    if (error instanceof ServerConfigError) throw error;
    fail('invalid_static_root', 'The generated static root is unavailable.');
  }
  const canonicalStatic = canonicalPathWithoutSymlinks(staticRoot);
  const canonicalData = canonicalPathWithoutSymlinks(dataDirectory);
  const canonicalKey = canonicalPathWithoutSymlinks(vaultKeyFile);
  if (pathContains(canonicalStatic, canonicalData) || pathContains(canonicalData, canonicalStatic) ||
    pathContains(canonicalStatic, canonicalKey) || pathContains(canonicalKey, canonicalStatic) ||
    pathContains(canonicalData, canonicalKey)) {
    fail('invalid_config', 'Private data and the vault key must be outside the public static root, with the key outside the database directory.');
  }
  return Object.freeze({ canonicalOrigin, dataDirectory, databasePath: join(dataDirectory, 'still.sqlite'),
    vaultKeyFile, staticRoot, host: '127.0.0.1', allowLocalHttp });
}

/** Creates private directories for trusted local setup; does not open or replace existing data. */
export function ensurePrivateDirectory(directory: string): void {
  if (!isAbsolute(directory) || directory.includes('\0')) fail('invalid_config', 'A private directory path must be absolute.');
  canonicalPathWithoutSymlinks(directory);
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch { fail('private_directory_unavailable', 'A private server directory could not be created.'); }
  let info;
  try { info = lstatSync(directory); } catch { return fail('private_directory_unavailable', 'A private server directory is unavailable.'); }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_private_directory', 'A private server path must be a real directory.');
  canonicalPathWithoutSymlinks(directory);
  if (process.platform === 'linux') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {
      fail('unsafe_private_directory', 'On Linux, private server directories must be owned by this user and have mode 0700 or stricter.');
    }
  }
}

/** Creates a root key only for a new database installation. Existing invalid keys are never replaced. */
export function loadOrCreateVaultRootKey(config: Pick<ServerConfig, 'vaultKeyFile' | 'databasePath' | 'dataDirectory' | 'staticRoot'>): Buffer {
  if (!isAbsolute(config.vaultKeyFile)) {
    fail('invalid_config', 'The vault key must be an absolute private path outside the database and static roots.');
  }
  const canonicalStatic = canonicalPathWithoutSymlinks(config.staticRoot);
  const canonicalData = canonicalPathWithoutSymlinks(config.dataDirectory);
  const canonicalKey = canonicalPathWithoutSymlinks(config.vaultKeyFile);
  if (pathContains(canonicalStatic, canonicalKey) || pathContains(canonicalKey, canonicalStatic) ||
    pathContains(canonicalData, canonicalKey) || pathContains(canonicalStatic, canonicalData) || pathContains(canonicalData, canonicalStatic)) {
    fail('invalid_config', 'The vault key must be an absolute private path outside the database and static roots.');
  }
  ensurePrivateDirectory(dirname(config.vaultKeyFile));
  if (existsSync(config.vaultKeyFile)) return loadVaultRootKey(config.vaultKeyFile);
  for (const databasePath of [config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`]) {
    if (pathEntryExists(databasePath)) {
      fail('missing_key_existing_database', 'Existing database or SQLite sidecar files have no vault key; restore the original key before starting.');
    }
  }
  const key = randomBytes(ROOT_KEY_BYTES);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  let createdIdentity: { dev: number; ino: number } | undefined;
  try {
    descriptor = openSync(config.vaultKeyFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== 0) fail('unsafe_root_key_file', 'The new vault key was not created as an empty regular file.');
    if (process.platform === 'linux') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (uid === undefined || opened.uid !== uid || (opened.mode & 0o077) !== 0) {
        fail('unsafe_root_key_permissions', 'On Linux, the vault key must be owned by this user and have mode 0600 or stricter.');
      }
    }
    createdIdentity = { dev: opened.dev, ino: opened.ino };
    let offset = 0;
    while (offset < key.length) {
      const written = writeSync(descriptor, key, offset, key.length - offset);
      if (written <= 0) fail('root_key_creation_failed', 'The vault root key could not be created safely.');
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    return Buffer.from(key);
  } catch (error) {
    if (createdIdentity) {
      try {
        const current = lstatSync(config.vaultKeyFile);
        if (current.isFile() && current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) unlinkSync(config.vaultKeyFile);
      } catch { /* Leave uncertain filesystem state for explicit recovery. */ }
    }
    if (error instanceof ServerConfigError) throw error;
    return fail('root_key_creation_failed', 'The vault root key could not be created safely.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    key.fill(0);
  }
}

/** Derives the auth-only secret; callers must clear the returned Buffer after constructing AuthService. */
export function deriveAuthSecret(rootKey: Uint8Array): Buffer {
  if (!(rootKey instanceof Uint8Array) || rootKey.byteLength !== ROOT_KEY_BYTES) {
    fail('invalid_root_key', 'The vault root key must contain exactly 32 bytes.');
  }
  return createHmac('sha256', rootKey).update('still-auth-secret:v1', 'utf8').digest();
}
