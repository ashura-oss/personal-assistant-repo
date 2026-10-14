import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService, createDurableKernel, createStillHttpServer } from '../dist/index.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPONENT_DIRECTORY = resolve(REPOSITORY_ROOT, '.expo');
const QA_BASE = resolve(EXPONENT_DIRECTORY, 'qa-http');
const RUN_DIRECTORY = resolve(QA_BASE, randomUUID());
const DATABASE_PATH = join(RUN_DIRECTORY, 'private', 'still.sqlite');
const STATIC_ROOT = resolve(REPOSITORY_ROOT, 'dist-web');
const ORIGIN = 'http://localhost:8098';
const PASSWORD = 'isolated-qa-only-not-a-user-password';
const SAFE_ERROR_CODES = new Set([
  'EADDRINUSE', 'EACCES', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EROFS',
  'SQLITE_CANTOPEN', 'SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_CONSTRAINT',
]);
const SAFE_ERROR_MESSAGES = new Set([
  'unsafe_qa_directory', 'qa_path_escape', 'invalid_fixture_snapshot', 'http_dependencies_invalid',
  'canonical_origin_invalid', 'static_root_invalid', 'static_path_escape', 'static_symlink',
  'static_not_file', 'static_realpath_mismatch', 'static_file_changed', 'static_file_too_large',
  'static_index_too_large', 'static_external_reference', 'static_reference_invalid',
  'static_reference_not_allowlisted', 'static_protected_path', 'static_pwa_files_missing',
  'auth_schema_corrupt', 'auth_closed', 'invalid_auth_secret', 'database_path_unavailable',
]);
const isWithin = (root, candidate) => {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const ensureRealDirectory = (path) => {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_qa_directory');
  return realpathSync(path);
};

if (!isWithin(REPOSITORY_ROOT, QA_BASE) || relative(REPOSITORY_ROOT, QA_BASE).startsWith(`..${sep}`)) process.exit(1);

let kernel;
let auth;
let server;
let closing = false;
const authSecret = randomBytes(32);

async function close() {
  if (closing) return;
  closing = true;
  if (server?.listening) {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }
  auth?.close();
  kernel?.close();
  authSecret.fill(0);
}

process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });

try {
  const canonicalRoot = realpathSync(REPOSITORY_ROOT);
  ensureRealDirectory(EXPONENT_DIRECTORY);
  const canonicalQaBase = ensureRealDirectory(QA_BASE);
  if (!isWithin(canonicalRoot, canonicalQaBase) || !isWithin(canonicalQaBase, RUN_DIRECTORY)) throw new Error('qa_path_escape');
  mkdirSync(RUN_DIRECTORY, { recursive: false, mode: 0o700 });
  const canonicalRunDirectory = realpathSync(RUN_DIRECTORY);
  if (!isWithin(canonicalQaBase, canonicalRunDirectory)) throw new Error('qa_path_escape');
  mkdirSync(join(RUN_DIRECTORY, 'private'), { recursive: false, mode: 0o700 });
  kernel = createDurableKernel({ databasePath: DATABASE_PATH,
    validateSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('invalid_fixture_snapshot');
    },
  });
  auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, allowLocalHttp: true, authSecret });
  await auth.enrollOwner(PASSWORD, { fixture: 'isolated-qa' });
  server = createStillHttpServer({ auth, canonicalOrigin: ORIGIN, allowLocalHttp: true, staticRoot: STATIC_ROOT });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(8098, '127.0.0.1', resolveListen);
  });
  process.stdout.write('isolatedQA http://localhost:8098\n');
} catch (error) {
  const name = error && typeof error === 'object' && typeof error.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
    ? error.name : 'Error';
  const rawCode = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
  const code = rawCode && SAFE_ERROR_CODES.has(rawCode) ? rawCode : 'UNKNOWN';
  const rawMessage = error && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
  const message = SAFE_ERROR_MESSAGES.has(rawMessage) ? rawMessage : 'startup_failed';
  await close().catch(() => {});
  process.stderr.write(`isolatedQA startup failure: name=${name} code=${code} message=${message}\n`);
  process.exitCode = 1;
}
