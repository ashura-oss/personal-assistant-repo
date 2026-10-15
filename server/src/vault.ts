import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, fstatSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import { isValidAccountId } from './accountIds.js';

const VAULT_FORMAT_VERSION = 1;
const VAULT_SCHEMA_VERSION = 2;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CREDENTIAL_BYTES = 16 * 1024 * 1024;
const MAX_OAUTH_STAGE_BYTES = 64 * 1024;
const KEY_CHECK_LABEL = 'still-server-vault-root-key-check:v1';
const OAUTH_STAGE_DOMAIN = 'still-server:oauth-stage:v1';
const WEB_PUSH_SECRET_DOMAIN = 'still-server:web-push-secret:v1';
const MAX_WEB_PUSH_SECRET_BYTES = 32 * 1024;
const PURPOSES = new Set(['openrouter', 'azureSpeech', 'googleOAuth', 'microsoftOAuth']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type VaultPurpose = 'openrouter' | 'azureSpeech' | 'googleOAuth' | 'microsoftOAuth';
export type VaultScope = { readonly type: 'workspace' } | {
  readonly type: 'account';
  readonly accountId: string;
  readonly expectedAccountGeneration: number;
};

export interface VaultCredentialMetadata {
  readonly configured: boolean;
  readonly generation: number;
}

/** Cryptographic binding only; it is not proof of install authority, live session, or TTL validity. */
export interface OAuthStageBinding {
  readonly stageId: string;
  readonly initiatingSessionBinding: string;
  readonly registrationId: string;
  readonly provider: 'google' | 'microsoft';
  readonly expiresAt: number;
  readonly payloadKind: 'authorization' | 'verified';
  readonly payloadGeneration: number;
}

/** Closed encrypted OAuth-stage value for a trusted stage repository to persist. */
export interface StageCiphertext {
  readonly format: 1;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/** Cryptographic binding for a Web Push secret; it is not subscription or rotation authority. */
export type WebPushSecretBinding = Readonly<{ kind: 'subscription'; deviceId: string; generation: number; keyId: string }> |
  Readonly<{ kind: 'vapid'; keyId: string }>;

/** Dedicated encrypted Web Push value for a trusted registry to persist. */
export interface WebPushSecretCiphertext {
  readonly format: 1;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

export class VaultError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'VaultError';
  }
}

function reject(code: string, message: string): never {
  throw new VaultError(message, code);
}

interface NormalizedScope {
  readonly type: 'workspace' | 'account';
  readonly id: string;
  readonly accountGeneration: number;
}

function validScope(scope: VaultScope): NormalizedScope {
  if (!scope || typeof scope !== 'object') return reject('invalid_scope', 'The credential scope is invalid.');
  if (scope.type === 'workspace' && Object.keys(scope).length === 1) return { type: 'workspace', id: '', accountGeneration: 0 };
  if (scope.type === 'account' && Object.keys(scope).length === 3 && isValidAccountId(scope.accountId)) {
    validGeneration(scope.expectedAccountGeneration);
    return { type: 'account', id: scope.accountId, accountGeneration: scope.expectedAccountGeneration };
  }
  return reject('invalid_scope', 'The credential scope is invalid.');
}

function validPurpose(purpose: VaultPurpose): asserts purpose is VaultPurpose {
  if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) reject('invalid_purpose', 'The credential purpose is invalid.');
}

function validGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject('invalid_generation', 'The credential generation is invalid.');
}

function validSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES ||
    Buffer.from(value, 'utf8').toString('utf8') !== value) {
    reject('invalid_secret', 'The credential must be a nonempty, valid UTF-8 string within the physical size limit.');
  }
}

function encodeAad(workspaceId: string, scopeType: 'workspace' | 'account', scopeId: string,
  purpose: VaultPurpose, generation: number, privacyEpoch: number, accountGeneration: number): Buffer {
  const scope = scopeType === 'workspace' ? ['workspace'] : ['account', scopeId];
  return Buffer.from(JSON.stringify([VAULT_FORMAT_VERSION, workspaceId, scope, purpose, generation,
    VAULT_FORMAT_VERSION, privacyEpoch, accountGeneration]), 'utf8');
}

function keyVerifier(key: Buffer): Buffer {
  return createHmac('sha256', key).update(KEY_CHECK_LABEL, 'utf8').digest();
}

function checkContext(db: Database.Database, context: OwnedTransactionContext): void {
  if (!context || !context.db || context.db !== db || !UUID_V4.test(context.workspaceId) || !UUID_V4.test(context.ownerId) ||
    !Number.isSafeInteger(context.privacyEpoch) || context.privacyEpoch < 0 || typeof context.assertActive !== 'function') {
    reject('invalid_transaction_context', 'A current owned transaction context is required.');
  }
  context.assertActive();
  const row = db.prepare('SELECT owner_id, privacy_epoch FROM workspaces WHERE id = ?').get(context.workspaceId) as
    { owner_id: string; privacy_epoch: number } | undefined;
  if (!row || row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch) {
    reject('stale_epoch', 'The owned workspace context is no longer current.');
  }
}

function closedDataFields(value: unknown, expected: readonly string[], code: string): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) reject(code, 'The OAuth stage value is invalid.');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) reject(code, 'The OAuth stage value is invalid.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
      reject(code, 'The OAuth stage value is invalid.');
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        reject(code, 'The OAuth stage value is invalid.');
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return reject(code, 'The OAuth stage value is invalid.');
  }
}

function normalizeOAuthStageBinding(value: unknown): OAuthStageBinding {
  const fields = closedDataFields(value, ['stageId', 'initiatingSessionBinding', 'registrationId', 'provider', 'expiresAt',
    'payloadKind', 'payloadGeneration'], 'oauth_stage_invalid_binding');
  if (typeof fields.stageId !== 'string' || !UUID_V4.test(fields.stageId) ||
      typeof fields.initiatingSessionBinding !== 'string' || !/^[0-9a-f]{64}$/.test(fields.initiatingSessionBinding) ||
      typeof fields.registrationId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(fields.registrationId) ||
      (fields.provider !== 'google' && fields.provider !== 'microsoft') ||
      typeof fields.expiresAt !== 'number' || !Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= 0 ||
      (fields.payloadKind !== 'authorization' && fields.payloadKind !== 'verified') ||
      typeof fields.payloadGeneration !== 'number' || !Number.isSafeInteger(fields.payloadGeneration) || fields.payloadGeneration <= 0) {
    reject('oauth_stage_invalid_binding', 'The OAuth stage binding is invalid.');
  }
  return Object.freeze({ stageId: fields.stageId, initiatingSessionBinding: fields.initiatingSessionBinding,
    registrationId: fields.registrationId, provider: fields.provider, expiresAt: fields.expiresAt,
    payloadKind: fields.payloadKind, payloadGeneration: fields.payloadGeneration });
}

function normalizeStageCiphertext(value: unknown): StageCiphertext {
  const fields = closedDataFields(value, ['format', 'nonce', 'tag', 'ciphertext'], 'oauth_stage_invalid_ciphertext');
  if (fields.format !== 1 || !Buffer.isBuffer(fields.nonce) || fields.nonce.length !== NONCE_BYTES ||
      !Buffer.isBuffer(fields.tag) || fields.tag.length !== TAG_BYTES || !Buffer.isBuffer(fields.ciphertext) ||
      fields.ciphertext.length < 1 || fields.ciphertext.length > MAX_OAUTH_STAGE_BYTES) {
    reject('oauth_stage_invalid_ciphertext', 'The OAuth stage ciphertext is invalid.');
  }
  return Object.freeze({ format: 1, nonce: Buffer.from(fields.nonce), tag: Buffer.from(fields.tag),
    ciphertext: Buffer.from(fields.ciphertext) });
}

function oauthStageAad(context: OwnedTransactionContext, binding: OAuthStageBinding): Buffer {
  return Buffer.from(JSON.stringify([1, OAUTH_STAGE_DOMAIN, context.ownerId, context.workspaceId, context.privacyEpoch,
    binding.stageId, binding.initiatingSessionBinding, binding.registrationId, binding.provider, binding.expiresAt,
    binding.payloadKind, binding.payloadGeneration]), 'utf8');
}

function normalizeWebPushSecretBinding(value: unknown): WebPushSecretBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject('web_push_secret_invalid_binding', 'The Web Push secret binding is invalid.');
  }
  let kind: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      reject('web_push_secret_invalid_binding', 'The Web Push secret binding is invalid.');
    }
    kind = descriptor.value;
  } catch { reject('web_push_secret_invalid_binding', 'The Web Push secret binding is invalid.'); }
  if (kind === 'subscription') {
    const fields = closedDataFields(value, ['kind', 'deviceId', 'generation', 'keyId'], 'web_push_secret_invalid_binding');
    if (typeof fields.deviceId !== 'string' || !UUID_V4.test(fields.deviceId) ||
        typeof fields.generation !== 'number' || !Number.isSafeInteger(fields.generation) || fields.generation <= 0 ||
        typeof fields.keyId !== 'string' || !UUID_V4.test(fields.keyId)) {
      reject('web_push_secret_invalid_binding', 'The Web Push secret binding is invalid.');
    }
    return Object.freeze({ kind: 'subscription', deviceId: fields.deviceId, generation: fields.generation, keyId: fields.keyId });
  }
  if (kind === 'vapid') {
    const fields = closedDataFields(value, ['kind', 'keyId'], 'web_push_secret_invalid_binding');
    if (typeof fields.keyId !== 'string' || !UUID_V4.test(fields.keyId)) {
      reject('web_push_secret_invalid_binding', 'The Web Push secret binding is invalid.');
    }
    return Object.freeze({ kind: 'vapid', keyId: fields.keyId });
  }
  return reject('web_push_secret_invalid_binding', 'The Web Push secret binding is invalid.');
}

function normalizeWebPushSecretCiphertext(value: unknown): WebPushSecretCiphertext {
  const fields = closedDataFields(value, ['format', 'nonce', 'tag', 'ciphertext'], 'web_push_secret_invalid_ciphertext');
  if (fields.format !== 1 || !Buffer.isBuffer(fields.nonce) || fields.nonce.length !== NONCE_BYTES ||
      !Buffer.isBuffer(fields.tag) || fields.tag.length !== TAG_BYTES || !Buffer.isBuffer(fields.ciphertext) ||
      fields.ciphertext.length < 1 || fields.ciphertext.length > MAX_WEB_PUSH_SECRET_BYTES) {
    reject('web_push_secret_invalid_ciphertext', 'The Web Push secret ciphertext is invalid.');
  }
  return Object.freeze({ format: 1, nonce: Buffer.from(fields.nonce), tag: Buffer.from(fields.tag), ciphertext: Buffer.from(fields.ciphertext) });
}

function webPushSecretAad(context: OwnedTransactionContext, binding: WebPushSecretBinding): Buffer {
  return Buffer.from(JSON.stringify([1, WEB_PUSH_SECRET_DOMAIN, context.ownerId, context.workspaceId, context.privacyEpoch,
    binding.kind, binding.kind === 'subscription' ? binding.deviceId : null,
    binding.kind === 'subscription' ? binding.generation : null, binding.keyId]), 'utf8');
}

function webPushSecretPlaintextBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_WEB_PUSH_SECRET_BYTES) {
    reject('web_push_secret_invalid_plaintext', 'The Web Push secret plaintext is invalid.');
  }
  return Buffer.from(value);
}

function oauthStagePlaintextBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OAUTH_STAGE_BYTES) {
    reject('oauth_stage_invalid_plaintext', 'OAuth stage plaintext is invalid.');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_OAUTH_STAGE_BYTES || bytes.toString('utf8') !== value) {
    bytes.fill(0);
    reject('oauth_stage_invalid_plaintext', 'OAuth stage plaintext is invalid.');
  }
  return bytes;
}

function checkedKeyBytes(input: Uint8Array): Buffer {
  if (!(input instanceof Uint8Array) || input.byteLength !== KEY_BYTES) reject('invalid_root_key', 'The vault root key must contain exactly 32 bytes.');
  return Buffer.from(input);
}

/** Reads a root key from an absolute file path without following symlinks. */
export function loadVaultRootKey(filePath: string): Buffer {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) reject('invalid_key_path', 'The vault key path must be absolute.');
  let before;
  try { before = lstatSync(filePath); }
  catch { return reject('invalid_root_key_file', 'The vault root key file is unavailable.'); }
  if (before.isSymbolicLink() || !before.isFile() || before.size !== KEY_BYTES) {
    reject('invalid_root_key_file', 'The vault root key must be a regular 32-byte file, not a symlink.');
  }

  let descriptor: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== KEY_BYTES || (before.ino && opened.ino && before.ino !== opened.ino) ||
      (before.dev && opened.dev && before.dev !== opened.dev)) {
      reject('invalid_root_key_file', 'The opened vault root key is not the expected regular 32-byte file.');
    }
    if (process.platform === 'linux') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (uid === undefined || opened.uid !== uid || (opened.mode & 0o077) !== 0) {
        reject('unsafe_root_key_permissions', 'On Linux, the vault root key must be owned by this user and have mode 0600 or stricter.');
      }
    }
    const bytes = Buffer.alloc(KEY_BYTES + 1);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== KEY_BYTES) reject('invalid_root_key_file', 'The vault root key file must contain exactly 32 bytes.');
    return Buffer.from(bytes.subarray(0, KEY_BYTES));
  } catch (error) {
    if (error instanceof VaultError) throw error;
    return reject('invalid_root_key_file', 'The vault root key file could not be safely opened.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface MetadataRow {
  generation: number;
  configured: number;
}

interface SecretRow {
  generation: number;
  account_generation: number;
  key_version: number;
  nonce: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/**
 * Trusted internal storage only. Call methods from inside DurableKernel.withOwnedTransaction;
 * this class intentionally has no HTTP or serialization surface for credential material.
 */
export class SecretVault {
  readonly #key: Buffer;
  readonly #oauthStageKey: Buffer;
  readonly #webPushSecretKey: Buffer;
  readonly #db: Database.Database;
  private closed = false;

  constructor(kernel: DurableKernel, rootKey: Uint8Array) {
    this.#key = checkedKeyBytes(rootKey);
    let oauthStageKey: Buffer | undefined;
    let webPushSecretKey: Buffer | undefined;
    try {
      oauthStageKey = Buffer.from(hkdfSync('sha256', this.#key, Buffer.alloc(0), Buffer.from(OAUTH_STAGE_DOMAIN, 'utf8'), KEY_BYTES));
      this.#oauthStageKey = oauthStageKey;
      webPushSecretKey = Buffer.from(hkdfSync('sha256', this.#key, Buffer.alloc(0), Buffer.from(WEB_PUSH_SECRET_DOMAIN, 'utf8'), KEY_BYTES));
      this.#webPushSecretKey = webPushSecretKey;
      this.#db = kernel.withTrustedDatabaseTransaction((db) => {
        this.initialize(db);
        return db;
      });
    } catch (error) {
      this.#key.fill(0);
      oauthStageKey?.fill(0);
      webPushSecretKey?.fill(0);
      throw error;
    }
  }

  private initialize(db: Database.Database): void {
    const tableExists = (name: string): boolean => Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const hasVersionTable = tableExists('vault_schema');
    if (!hasVersionTable) {
      if (['vault_key_check', 'vault_metadata', 'vault_ciphertexts'].some(tableExists)) {
        reject('vault_schema_corrupt', 'Vault tables exist without a version record.');
      }
      db.exec(`
        CREATE TABLE vault_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL CHECK (version > 0)
        ) STRICT;
        CREATE TABLE vault_key_check (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          format_version INTEGER NOT NULL,
          verifier BLOB NOT NULL CHECK (length(verifier) = 32)
        ) STRICT;
      `);
      this.createMetadataTable(db, 'vault_metadata', true);
      this.createCiphertextTable(db);
      db.prepare('INSERT INTO vault_key_check (singleton, format_version, verifier) VALUES (1, ?, ?)')
        .run(VAULT_FORMAT_VERSION, keyVerifier(this.#key));
      db.prepare('INSERT INTO vault_schema (singleton, version) VALUES (1, ?)').run(VAULT_SCHEMA_VERSION);
      return;
    } else {
      if (!tableExists('vault_key_check') || !tableExists('vault_metadata') || !tableExists('vault_ciphertexts')) {
        reject('vault_schema_corrupt', 'The vault schema is incomplete.');
      }
      const version = db.prepare('SELECT version FROM vault_schema WHERE singleton = 1').get() as { version: number } | undefined;
      if (!version || !Number.isSafeInteger(version.version) || version.version < 1) reject('vault_schema_corrupt', 'The vault schema version is invalid.');
      if (version.version > VAULT_SCHEMA_VERSION) reject('vault_newer_schema', 'This server cannot read a newer vault schema.');
      if (version.version !== 1 && version.version !== VAULT_SCHEMA_VERSION) reject('vault_migration_required', 'No migration is available for this vault schema.');
    }

    const saved = db.prepare('SELECT format_version, verifier FROM vault_key_check WHERE singleton = 1').get() as
      { format_version: number; verifier: Buffer } | undefined;
    if (!saved) {
      reject('vault_schema_corrupt', 'The vault key verifier is missing.');
    }
    if (saved.format_version !== VAULT_FORMAT_VERSION || !Buffer.isBuffer(saved.verifier) || saved.verifier.length !== 32) {
      reject('vault_schema_corrupt', 'The vault key verifier metadata is invalid.');
    }
    if (!timingSafeEqual(saved.verifier, keyVerifier(this.#key))) reject('vault_wrong_root_key', 'The configured vault root key does not match this database.');
    const version = db.prepare('SELECT version FROM vault_schema WHERE singleton = 1').get() as { version: number };
    if (version.version === 1) this.migrateMetadataToSchemaV2(db);
  }

  private createMetadataTable(db: Database.Database, tableName: string, opaqueAccountIds: boolean): void {
    if (!['vault_metadata', 'vault_metadata_v2'].includes(tableName)) reject('vault_schema_corrupt', 'The vault metadata table name is invalid.');
    const accountConstraint = opaqueAccountIds
      ? 'length(CAST(scope_id AS BLOB)) BETWEEN 1 AND 1024'
      : 'length(scope_id) = 36';
    db.exec(`CREATE TABLE ${tableName} (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'account')),
      scope_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('openrouter', 'azureSpeech', 'googleOAuth', 'microsoftOAuth')),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
      PRIMARY KEY (workspace_id, scope_type, scope_id, purpose),
      CHECK ((scope_type = 'workspace' AND scope_id = '') OR (scope_type = 'account' AND ${accountConstraint}))
    ) STRICT;`);
  }

  private createCiphertextTable(db: Database.Database): void {
    db.exec(`CREATE TABLE vault_ciphertexts (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'account')),
      scope_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('openrouter', 'azureSpeech', 'googleOAuth', 'microsoftOAuth')),
      generation INTEGER NOT NULL CHECK (generation > 0),
      account_generation INTEGER NOT NULL CHECK (account_generation >= 0),
      key_version INTEGER NOT NULL CHECK (key_version = 1),
      nonce BLOB NOT NULL CHECK (length(nonce) = 12),
      tag BLOB NOT NULL CHECK (length(tag) = 16),
      ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 0),
      PRIMARY KEY (workspace_id, scope_type, scope_id, purpose)
    ) STRICT;`);
  }

  private migrateMetadataToSchemaV2(db: Database.Database): void {
    const rows = db.prepare('SELECT workspace_id,scope_type,scope_id,purpose,generation,configured FROM vault_metadata')
      .all() as Array<{ workspace_id: string; scope_type: 'workspace' | 'account'; scope_id: string;
        purpose: string; generation: number; configured: number }>;
    for (const row of rows) {
      if (typeof row.workspace_id !== 'string' || !UUID_V4.test(row.workspace_id) ||
          row.scope_type !== 'workspace' && row.scope_type !== 'account' ||
          row.scope_type === 'workspace' && row.scope_id !== '' ||
          row.scope_type === 'account' && !isValidAccountId(row.scope_id) ||
          !PURPOSES.has(row.purpose) || !Number.isSafeInteger(row.generation) || row.generation < 0 ||
          row.configured !== 0 && row.configured !== 1) {
        reject('vault_schema_corrupt', 'The existing vault metadata is invalid.');
      }
    }
    this.createMetadataTable(db, 'vault_metadata_v2', true);
    const insert = db.prepare('INSERT INTO vault_metadata_v2 (workspace_id,scope_type,scope_id,purpose,generation,configured) VALUES (?,?,?,?,?,?)');
    for (const row of rows) insert.run(row.workspace_id, row.scope_type, row.scope_id, row.purpose, row.generation, row.configured);
    db.exec('DROP TABLE vault_metadata; ALTER TABLE vault_metadata_v2 RENAME TO vault_metadata;');
    db.prepare('UPDATE vault_schema SET version=? WHERE singleton=1').run(VAULT_SCHEMA_VERSION);
  }

  getMetadataWithinTransaction(context: OwnedTransactionContext, scope: VaultScope, purpose: VaultPurpose): VaultCredentialMetadata {
    const normalized = this.validate(context, scope, purpose);
    const metadata = this.readMetadata(context.workspaceId, normalized.type, normalized.id, purpose);
    let configured = metadata?.configured === 1;
    if (configured) {
      const row = context.db.prepare(`SELECT account_generation FROM vault_ciphertexts
        WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND purpose = ?`)
        .get(context.workspaceId, normalized.type, normalized.id, purpose) as { account_generation: number } | undefined;
      if (!row) reject('vault_corrupt', 'The encrypted credential record is unavailable.');
      if (row.account_generation !== normalized.accountGeneration) configured = false;
    }
    return Object.freeze({ configured, generation: metadata?.generation ?? 0 });
  }

  getSecretWithinTransaction(context: OwnedTransactionContext, scope: VaultScope, purpose: VaultPurpose): string | undefined {
    const normalized = this.validate(context, scope, purpose);
    const metadata = this.readMetadata(context.workspaceId, normalized.type, normalized.id, purpose);
    if (!metadata || metadata.configured !== 1) return undefined;
    const row = context.db.prepare(`SELECT generation, account_generation, key_version, nonce, tag, ciphertext FROM vault_ciphertexts
      WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND purpose = ?`)
      .get(context.workspaceId, normalized.type, normalized.id, purpose) as SecretRow | undefined;
    if (!row || row.generation !== metadata.generation || row.key_version !== VAULT_FORMAT_VERSION ||
      !Buffer.isBuffer(row.nonce) || row.nonce.length !== NONCE_BYTES || !Buffer.isBuffer(row.tag) || row.tag.length !== TAG_BYTES ||
      !Buffer.isBuffer(row.ciphertext) || row.ciphertext.length === 0 || row.ciphertext.length > MAX_CREDENTIAL_BYTES) {
      reject('vault_corrupt', 'The encrypted credential record is unavailable.');
    }
    if (row.account_generation !== normalized.accountGeneration) reject('stale_generation', 'The credential belongs to an earlier account generation.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, row.nonce);
      decipher.setAAD(encodeAad(context.workspaceId, normalized.type, normalized.id, purpose, row.generation,
        context.privacyEpoch, row.account_generation));
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      reject('vault_decryption_failed', 'The encrypted credential could not be authenticated.');
    }
  }

  /**
   * Encrypts a durable OAuth stage payload. This binds ciphertext to trusted transaction identity and the supplied
   * stage metadata; it does not establish install authority, session liveness, or whether expiresAt is still valid.
   */
  sealOAuthStageWithinTransaction(context: OwnedTransactionContext, bindingInput: OAuthStageBinding,
    plaintext: string): StageCiphertext {
    this.validateOAuthStageContext(context);
    const binding = normalizeOAuthStageBinding(bindingInput);
    const cleartext = oauthStagePlaintextBytes(plaintext);
    try {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.#oauthStageKey, nonce);
      cipher.setAAD(oauthStageAad(context, binding));
      const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
      return Object.freeze({ format: 1, nonce: Buffer.from(nonce), tag: Buffer.from(cipher.getAuthTag()), ciphertext });
    } catch {
      reject('oauth_stage_seal_failed', 'The OAuth stage could not be encrypted.');
    } finally {
      cleartext.fill(0);
    }
  }

  /** Opens only a ciphertext with the exact trusted owner/workspace/epoch and complete stage binding. */
  openOAuthStageWithinTransaction(context: OwnedTransactionContext, bindingInput: OAuthStageBinding,
    ciphertextInput: StageCiphertext): string {
    this.validateOAuthStageContext(context);
    const binding = normalizeOAuthStageBinding(bindingInput);
    const ciphertext = normalizeStageCiphertext(ciphertextInput);
    let cleartext: Buffer | undefined;
    let partialPlaintext: Buffer | undefined;
    let finalPlaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#oauthStageKey, ciphertext.nonce);
      decipher.setAAD(oauthStageAad(context, binding));
      decipher.setAuthTag(ciphertext.tag);
      partialPlaintext = decipher.update(ciphertext.ciphertext);
      finalPlaintext = decipher.final();
      cleartext = Buffer.concat([partialPlaintext, finalPlaintext]);
      if (cleartext.length === 0 || cleartext.length > MAX_OAUTH_STAGE_BYTES) {
        reject('oauth_stage_open_failed', 'The OAuth stage could not be authenticated.');
      }
      const plaintext = cleartext.toString('utf8');
      const utf8 = Buffer.from(plaintext, 'utf8');
      try {
        if (utf8.compare(cleartext) !== 0) reject('oauth_stage_open_failed', 'The OAuth stage could not be authenticated.');
      } finally {
        utf8.fill(0);
      }
      return plaintext;
    } catch {
      return reject('oauth_stage_open_failed', 'The OAuth stage could not be authenticated.');
    } finally {
      cleartext?.fill(0);
      partialPlaintext?.fill(0);
      finalPlaintext?.fill(0);
    }
  }

  /** Encrypts a Web Push subscription or VAPID secret under a purpose-specific HKDF domain. */
  sealWebPushSecretWithinTransaction(context: OwnedTransactionContext, bindingInput: WebPushSecretBinding,
    plaintextInput: Uint8Array): WebPushSecretCiphertext {
    this.validateOAuthStageContext(context);
    const binding = normalizeWebPushSecretBinding(bindingInput);
    const cleartext = webPushSecretPlaintextBytes(plaintextInput);
    try {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.#webPushSecretKey, nonce);
      cipher.setAAD(webPushSecretAad(context, binding));
      const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
      return Object.freeze({ format: 1, nonce: Buffer.from(nonce), tag: Buffer.from(cipher.getAuthTag()), ciphertext });
    } catch {
      reject('web_push_secret_seal_failed', 'The Web Push secret could not be encrypted.');
    } finally { cleartext.fill(0); }
  }

  /** Opens only a Web Push ciphertext with the exact current owner/workspace/epoch and binding. Caller must zero the result. */
  openWebPushSecretWithinTransaction(context: OwnedTransactionContext, bindingInput: WebPushSecretBinding,
    ciphertextInput: WebPushSecretCiphertext): Buffer {
    this.validateOAuthStageContext(context);
    const binding = normalizeWebPushSecretBinding(bindingInput);
    const ciphertext = normalizeWebPushSecretCiphertext(ciphertextInput);
    let cleartext: Buffer | undefined;
    let partial: Buffer | undefined;
    let final: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#webPushSecretKey, ciphertext.nonce);
      decipher.setAAD(webPushSecretAad(context, binding));
      decipher.setAuthTag(ciphertext.tag);
      partial = decipher.update(ciphertext.ciphertext);
      final = decipher.final();
      cleartext = Buffer.concat([partial, final]);
      if (cleartext.length < 1 || cleartext.length > MAX_WEB_PUSH_SECRET_BYTES) {
        reject('web_push_secret_open_failed', 'The Web Push secret could not be authenticated.');
      }
      return cleartext;
    } catch {
      cleartext?.fill(0);
      return reject('web_push_secret_open_failed', 'The Web Push secret could not be authenticated.');
    } finally {
      partial?.fill(0);
      final?.fill(0);
    }
  }

  setSecretWithinTransaction(context: OwnedTransactionContext, scope: VaultScope, purpose: VaultPurpose,
    expectedGeneration: number, secret: string): VaultCredentialMetadata {
    const normalized = this.validate(context, scope, purpose);
    validGeneration(expectedGeneration);
    validSecret(secret);
    const current = this.readMetadata(context.workspaceId, normalized.type, normalized.id, purpose);
    const credentialGeneration = current?.generation ?? 0;
    if (credentialGeneration !== expectedGeneration) reject('stale_generation', 'The credential generation changed.');
    const nextGeneration = this.increment(credentialGeneration);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(encodeAad(context.workspaceId, normalized.type, normalized.id, purpose, nextGeneration,
      context.privacyEpoch, normalized.accountGeneration));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.writeGeneration(context, normalized.type, normalized.id, purpose, nextGeneration, normalized.accountGeneration,
      true, nonce, tag, ciphertext);
    return Object.freeze({ configured: true, generation: nextGeneration });
  }

  deleteSecretWithinTransaction(context: OwnedTransactionContext, scope: VaultScope, purpose: VaultPurpose,
    expectedGeneration: number): VaultCredentialMetadata {
    const normalized = this.validate(context, scope, purpose);
    validGeneration(expectedGeneration);
    const current = this.readMetadata(context.workspaceId, normalized.type, normalized.id, purpose);
    const credentialGeneration = current?.generation ?? 0;
    if (credentialGeneration !== expectedGeneration) reject('stale_generation', 'The credential generation changed.');
    const nextGeneration = this.increment(credentialGeneration);
    this.writeGeneration(context, normalized.type, normalized.id, purpose, nextGeneration, normalized.accountGeneration, false);
    return Object.freeze({ configured: false, generation: nextGeneration });
  }

  /**
   * Deletes an obsolete account credential only when both generations still
   * identify the exact ciphertext captured by its durable token binding.
   * A newer account credential shares the same vault slot, so ordinary
   * deleteSecretWithinTransaction must never be authorized by a stale token
   * reference.
   */
  deleteAccountSecretForExactBindingWithinTransaction(context: OwnedTransactionContext, input: {
    readonly accountId: string;
    readonly expectedAccountGeneration: number;
    readonly purpose: 'googleOAuth' | 'microsoftOAuth';
    readonly expectedCredentialGeneration: number;
  }): boolean {
    checkContext(this.#db, context);
    if (!input || typeof input !== 'object' || !isValidAccountId(input.accountId) ||
        (input.purpose !== 'googleOAuth' && input.purpose !== 'microsoftOAuth')) {
      reject('invalid_scope', 'The credential scope is invalid.');
    }
    validGeneration(input.expectedAccountGeneration);
    validGeneration(input.expectedCredentialGeneration);
    const metadata = this.readMetadata(context.workspaceId, 'account', input.accountId, input.purpose);
    if (!metadata || metadata.generation !== input.expectedCredentialGeneration) return false;
    const row = context.db.prepare(`SELECT generation, account_generation FROM vault_ciphertexts
      WHERE workspace_id=? AND scope_type='account' AND scope_id=? AND purpose=?`)
      .get(context.workspaceId, input.accountId, input.purpose) as { generation: number; account_generation: number } | undefined;
    if (!row || row.generation !== input.expectedCredentialGeneration || row.account_generation !== input.expectedAccountGeneration) return false;
    const nextGeneration = this.increment(metadata.generation);
    this.writeGeneration(context, 'account', input.accountId, input.purpose, nextGeneration,
      input.expectedAccountGeneration, false);
    return true;
  }

  /** Erases all credential bytes for this workspace while preserving generation tombstones. */
  eraseWithinTransaction(context: OwnedTransactionContext): void {
    checkContext(this.#db, context);
    const rows = context.db.prepare(`SELECT scope_type, scope_id, purpose, generation FROM vault_metadata WHERE workspace_id = ?`)
      .all(context.workspaceId) as Array<{ scope_type: 'workspace' | 'account'; scope_id: string; purpose: VaultPurpose; generation: number }>;
    for (const row of rows) {
      const nextGeneration = this.increment(row.generation);
      context.db.prepare(`UPDATE vault_metadata SET generation = ?, configured = 0
        WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND purpose = ?`)
        .run(nextGeneration, context.workspaceId, row.scope_type, row.scope_id, row.purpose);
    }
    context.db.prepare('DELETE FROM vault_ciphertexts WHERE workspace_id = ?').run(context.workspaceId);
  }

  close(): void {
    this.closed = true;
    this.#key.fill(0);
    this.#oauthStageKey.fill(0);
    this.#webPushSecretKey.fill(0);
  }

  private validateOAuthStageContext(context: OwnedTransactionContext): void {
    if (this.closed) reject('vault_closed', 'The credential vault is closed.');
    checkContext(this.#db, context);
  }

  private validate(context: OwnedTransactionContext, scope: VaultScope, purpose: VaultPurpose): NormalizedScope {
    if (this.closed) reject('vault_closed', 'The credential vault is closed.');
    checkContext(this.#db, context);
    validPurpose(purpose);
    const normalized = validScope(scope);
    const workspacePurpose = purpose === 'openrouter' || purpose === 'azureSpeech';
    if ((normalized.type === 'workspace') !== workspacePurpose) {
      reject('invalid_scope_purpose', 'Workspace scope is for BYOK credentials; OAuth credentials require account scope.');
    }
    if (normalized.type === 'account') {
      const current = this.currentAccountGeneration(context.db, context.workspaceId, normalized.id);
      if (current === undefined || current !== normalized.accountGeneration) {
        reject('stale_account_generation', 'The account credential operation is bound to a stale account generation.');
      }
    }
    return normalized;
  }

  private readMetadata(workspaceId: string, scopeType: 'workspace' | 'account', scopeId: string, purpose: VaultPurpose): MetadataRow | undefined {
    return this.#db.prepare(`SELECT generation, configured FROM vault_metadata WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND purpose = ?`)
      .get(workspaceId, scopeType, scopeId, purpose) as MetadataRow | undefined;
  }

  private currentAccountGeneration(db: Database.Database, workspaceId: string, accountId: string): number | undefined {
    const row = db.prepare('SELECT generation FROM account_generations WHERE workspace_id = ? AND account_id = ?')
      .get(workspaceId, accountId) as { generation: number } | undefined;
    return row?.generation;
  }

  private writeGeneration(context: OwnedTransactionContext, scopeType: 'workspace' | 'account', scopeId: string,
    purpose: VaultPurpose, generation: number, accountGeneration: number, configured: boolean,
    nonce?: Buffer, tag?: Buffer, ciphertext?: Buffer): void {
    context.db.prepare(`INSERT INTO vault_metadata (workspace_id, scope_type, scope_id, purpose, generation, configured)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, scope_type, scope_id, purpose) DO UPDATE SET
      generation = excluded.generation, configured = excluded.configured`)
      .run(context.workspaceId, scopeType, scopeId, purpose, generation, configured ? 1 : 0);
    context.db.prepare('DELETE FROM vault_ciphertexts WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND purpose = ?')
      .run(context.workspaceId, scopeType, scopeId, purpose);
    if (configured) {
      if (!nonce || !tag || !ciphertext) reject('vault_internal', 'Encrypted credential material is missing.');
      context.db.prepare(`INSERT INTO vault_ciphertexts (workspace_id, scope_type, scope_id, purpose, generation,
        account_generation, key_version, nonce, tag, ciphertext) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(context.workspaceId, scopeType, scopeId, purpose, generation, accountGeneration, VAULT_FORMAT_VERSION, nonce, tag, ciphertext);
    }
  }

  private increment(generation: number): number {
    const next = generation + 1;
    if (!Number.isSafeInteger(next)) reject('generation_overflow', 'The credential generation cannot be advanced.');
    return next;
  }
}
