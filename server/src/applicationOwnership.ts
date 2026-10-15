import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';

export class ApplicationOwnershipError extends Error {
  constructor(readonly code: 'application_owner_busy' | 'application_owner_path_unsafe' | 'application_owner_unavailable') {
    super(code === 'application_owner_busy' ? 'Another live application owner holds this database.' : 'Application ownership could not be established safely.');
    this.name = 'ApplicationOwnershipError';
  }
}

export class ApplicationOwnershipStartupCleanupError extends Error {
  readonly #retryClose: () => void;

  constructor(retryClose: () => void) {
    super('Application ownership startup cleanup is incomplete.');
    this.name = 'ApplicationOwnershipStartupCleanupError';
    this.#retryClose = retryClose;
  }

  retryClose(): void { this.#retryClose(); }
}

export interface ApplicationOwnershipHandle {
  readonly databasePath: string;
  readonly lockDatabasePath: string;
  assertHeld(): void;
  release(): void;
}

interface FileIdentity { readonly dev: number; readonly ino: number; }
interface OwnershipState {
  readonly databasePath: string;
  readonly lockDatabasePath: string;
  readonly lock: Database.Database;
  readonly lockIdentity: FileIdentity;
  databaseIdentity?: FileIdentity;
  released: boolean;
}

const ownershipStates = new WeakMap<object, OwnershipState>();

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }
function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (('code' in error && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')) ||
      ('message' in error && typeof error.message === 'string' && /database is (?:locked|busy)/i.test(error.message)));
}

function inspectPathAncestors(path: string): void {
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
      if (isMissing(error)) { missing = true; continue; }
      throw new ApplicationOwnershipError('application_owner_path_unsafe');
    }
    if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) {
      throw new ApplicationOwnershipError('application_owner_path_unsafe');
    }
  }
}

function canonicalDatabasePath(databasePath: string, createParent: boolean): string {
  if (typeof databasePath !== 'string' || !databasePath || !isAbsolute(databasePath) || databasePath.includes('\0')) {
    throw new ApplicationOwnershipError('application_owner_path_unsafe');
  }
  const absolute = resolve(databasePath);
  inspectPathAncestors(absolute);
  if (createParent) mkdirSync(dirname(absolute), { recursive: true });
  inspectPathAncestors(absolute);
  let parent: string;
  try { parent = realpathSync(dirname(absolute)); }
  catch { throw new ApplicationOwnershipError('application_owner_path_unsafe'); }
  let canonical = resolve(parent, absolute.slice(dirname(absolute).length + (dirname(absolute).endsWith(sep) ? 0 : 1)));
  try {
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new ApplicationOwnershipError('application_owner_path_unsafe');
    canonical = realpathSync(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error instanceof ApplicationOwnershipError ? error : new ApplicationOwnershipError('application_owner_path_unsafe');
  }
  return canonical;
}

function createPrivateFile(path: string): void {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    fsyncSync(descriptor);
  } catch (error) {
    if (!isMissing(error) && !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
      throw new ApplicationOwnershipError('application_owner_unavailable');
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function regularFileIdentity(path: string, requirePrivate = false): FileIdentity {
  inspectPathAncestors(path);
  let info;
  try { info = lstatSync(path); }
  catch { throw new ApplicationOwnershipError('application_owner_path_unsafe'); }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 ||
      (requirePrivate && process.platform === 'linux' && (uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0))) {
    throw new ApplicationOwnershipError('application_owner_path_unsafe');
  }
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function stateFor(handle: ApplicationOwnershipHandle, checkDatabase = true): OwnershipState {
  if (!handle || typeof handle !== 'object') throw new ApplicationOwnershipError('application_owner_path_unsafe');
  const state = ownershipStates.get(handle as object);
  if (!state || state.released) throw new ApplicationOwnershipError('application_owner_path_unsafe');
  if (!state.lock.open || !state.lock.inTransaction) throw new ApplicationOwnershipError('application_owner_busy');
  const currentLockIdentity = regularFileIdentity(state.lockDatabasePath, true);
  if (!sameIdentity(currentLockIdentity, state.lockIdentity)) throw new ApplicationOwnershipError('application_owner_path_unsafe');
  if (checkDatabase && state.databaseIdentity) {
    const currentDatabaseIdentity = regularFileIdentity(state.databasePath);
    if (!sameIdentity(currentDatabaseIdentity, state.databaseIdentity)) throw new ApplicationOwnershipError('application_owner_path_unsafe');
  }
  return state;
}

/** Records and checks the database inode after SQLite has safely opened it. */
export function bindApplicationDatabaseIdentity(handle: ApplicationOwnershipHandle): void {
  const state = stateFor(handle);
  const identity = regularFileIdentity(state.databasePath);
  if (state.databaseIdentity && !sameIdentity(identity, state.databaseIdentity)) throw new ApplicationOwnershipError('application_owner_path_unsafe');
  state.databaseIdentity = identity;
}

/** Validates the nonforgeable connection/transaction handle for a matching database path. */
export function assertApplicationOwnership(handle: ApplicationOwnershipHandle, databasePath: string): string {
  const state = stateFor(handle);
  const canonical = canonicalDatabasePath(databasePath, false);
  if (canonical !== state.databasePath) throw new ApplicationOwnershipError('application_owner_path_unsafe');
  return state.databasePath;
}

/** Acquires the persistent database's non-expiring SQLite OS lock without touching the user database. */
export function acquireApplicationOwnership(databasePath: string): ApplicationOwnershipHandle {
  const canonical = canonicalDatabasePath(databasePath, true);
  const lockDatabasePath = `${canonical}.owner.sqlite`;
  inspectPathAncestors(lockDatabasePath);
  createPrivateFile(lockDatabasePath);
  const lockIdentity = regularFileIdentity(lockDatabasePath, true);
  let lock: Database.Database | undefined;
  try {
    lock = new Database(lockDatabasePath, { timeout: 0 });
    lock.pragma('busy_timeout = 0');
    const journalMode = lock.pragma('journal_mode = DELETE', { simple: true });
    if (typeof journalMode !== 'string' || journalMode.toLowerCase() !== 'delete') throw new ApplicationOwnershipError('application_owner_unavailable');
    lock.pragma('synchronous = FULL');
    lock.exec('CREATE TABLE IF NOT EXISTS application_owner_guard (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)) STRICT');
    lock.exec('BEGIN EXCLUSIVE');
    const state: OwnershipState = { databasePath: canonical, lockDatabasePath, lock, lockIdentity, released: false };
    const handle: ApplicationOwnershipHandle = Object.freeze({
      databasePath: canonical,
      lockDatabasePath,
      assertHeld: () => { stateFor(handle); },
      release: () => {
        if (state.released) return;
        stateFor(handle, false);
        lock!.close();
        state.released = true;
      },
    });
    ownershipStates.set(handle, state);
    stateFor(handle);
    return handle;
  } catch (error) {
    try { if (lock?.open) lock.close(); }
    catch {
      const retainedLock = lock;
      if (!retainedLock) throw error;
      throw new ApplicationOwnershipStartupCleanupError(() => { if (retainedLock.open) retainedLock.close(); });
    }
    if (error instanceof ApplicationOwnershipError) throw error;
    if (isBusy(error)) throw new ApplicationOwnershipError('application_owner_busy');
    throw new ApplicationOwnershipError('application_owner_unavailable');
  }
}
