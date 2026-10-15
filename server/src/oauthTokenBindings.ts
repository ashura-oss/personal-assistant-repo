import type Database from 'better-sqlite3';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import { isValidAccountId } from './accountIds.js';

const SCHEMA_VERSION = 2;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_REF_CONTROLS = /[\u0000-\u001f\u007f]/;

export type OAuthBindingProvider = 'google' | 'microsoft';

export interface OAuthTokenBinding {
  readonly tokenRef: string;
  readonly accountId: string;
  readonly provider: OAuthBindingProvider;
  readonly accountGeneration: number;
  readonly credentialGeneration: number;
  readonly privacyEpoch: number;
}

export interface OAuthTokenBindingWrite {
  readonly tokenRef: string;
  readonly accountId: string;
  readonly provider: OAuthBindingProvider;
  readonly accountGeneration: number;
  readonly credentialGeneration: number;
  /** Required only to replace the credential generation for this already-bound token reference. */
  readonly expectedCredentialGeneration?: number;
}

interface BindingRow {
  workspace_id: string;
  privacy_epoch: number;
  token_ref: string;
  account_id: string;
  provider: OAuthBindingProvider;
  account_generation: number;
  credential_generation: number;
  created_at: number;
  updated_at: number;
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }

export function isValidOAuthTokenRef(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !TOKEN_REF_CONTROLS.test(value) &&
    Buffer.from(value, 'utf8').toString('utf8') === value;
}

function validGeneration(value: unknown, allowZero = true): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1);
}

function assertProvider(value: unknown): asserts value is OAuthBindingProvider {
  if (value !== 'google' && value !== 'microsoft') fail('oauth_token_binding_invalid', 'The OAuth token binding is invalid.');
}

/** Separate server-owned mapping from an opaque account ID/token ref to the encrypted vault slot. */
export class ServerOAuthTokenBindings {
  readonly #db: Database.Database;

  constructor(kernel: DurableKernel) {
    this.#db = kernel.withTrustedDatabaseTransaction((db) => { this.initialize(db); return db; });
  }

  private initialize(db: Database.Database): void {
    const exists = (name: string): boolean => Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const hasSchema = exists('server_oauth_token_binding_schema');
    const hasBindings = exists('server_oauth_token_bindings');
    if (!hasSchema && !hasBindings) {
      db.exec(`CREATE TABLE server_oauth_token_binding_schema (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version>0)
      ) STRICT;`);
      this.createBindingsTable(db, 'server_oauth_token_bindings', true);
      db.prepare('INSERT INTO server_oauth_token_binding_schema(singleton,version) VALUES(1,?)').run(SCHEMA_VERSION);
      return;
    }
    if (!hasSchema || !hasBindings) fail('oauth_token_binding_schema_invalid', 'The OAuth token binding schema is incomplete.');
    const marker = db.prepare('SELECT version FROM server_oauth_token_binding_schema WHERE singleton=1').get() as { version: number } | undefined;
    if (!marker || !Number.isSafeInteger(marker.version) || marker.version < 1) {
      fail('oauth_token_binding_schema_invalid', 'The OAuth token binding schema version is invalid.');
    }
    if (marker.version > SCHEMA_VERSION) fail('oauth_token_binding_schema_newer', 'This server cannot read a newer OAuth token binding schema.');
    if (marker.version !== 1 && marker.version !== SCHEMA_VERSION) {
      fail('oauth_token_binding_schema_unsupported', 'No OAuth token binding schema migration is available.');
    }
    if (marker.version === 1) this.migrateV1ToV2(db);
    this.validateColumns(db);
  }

  private createBindingsTable(db: Database.Database, tableName: string, opaqueAccountIds: boolean): void {
    if (!['server_oauth_token_bindings', 'server_oauth_token_bindings_v2'].includes(tableName)) {
      fail('oauth_token_binding_schema_invalid', 'The OAuth token binding table name is invalid.');
    }
    const accountCheck = opaqueAccountIds ? 'length(CAST(account_id AS BLOB)) BETWEEN 1 AND 1024' : 'length(account_id)=36';
    db.exec(`CREATE TABLE ${tableName} (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
      token_ref TEXT NOT NULL CHECK(length(token_ref) BETWEEN 1 AND 128),
      account_id TEXT NOT NULL CHECK(${accountCheck}),
      provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
      account_generation INTEGER NOT NULL CHECK(account_generation>=0),
      credential_generation INTEGER NOT NULL CHECK(credential_generation>0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, privacy_epoch, token_ref),
      UNIQUE(workspace_id, privacy_epoch, account_id, provider, account_generation)
    ) STRICT;`);
  }

  private migrateV1ToV2(db: Database.Database): void {
    const rows = db.prepare(`SELECT workspace_id,privacy_epoch,token_ref,account_id,provider,account_generation,
      credential_generation,created_at,updated_at FROM server_oauth_token_bindings`).all() as BindingRow[];
    for (const row of rows) {
    if (!UUID_V4.test(row.workspace_id) || !validGeneration(row.privacy_epoch) || !isValidOAuthTokenRef(row.token_ref) ||
          !isValidAccountId(row.account_id) || row.provider !== 'google' && row.provider !== 'microsoft' ||
          !validGeneration(row.account_generation) || !validGeneration(row.credential_generation, false) ||
          !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at)) {
        fail('oauth_token_binding_schema_invalid', 'The existing OAuth token bindings are invalid.');
      }
    }
    this.createBindingsTable(db, 'server_oauth_token_bindings_v2', true);
    const insert = db.prepare(`INSERT INTO server_oauth_token_bindings_v2 (workspace_id,privacy_epoch,token_ref,account_id,provider,
      account_generation,credential_generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) insert.run(row.workspace_id, row.privacy_epoch, row.token_ref, row.account_id, row.provider,
      row.account_generation, row.credential_generation, row.created_at, row.updated_at);
    db.exec('DROP TABLE server_oauth_token_bindings; ALTER TABLE server_oauth_token_bindings_v2 RENAME TO server_oauth_token_bindings;');
    db.prepare('UPDATE server_oauth_token_binding_schema SET version=? WHERE singleton=1').run(SCHEMA_VERSION);
  }

  private validateColumns(db: Database.Database): void {
    const columns = db.pragma('table_info(server_oauth_token_bindings)') as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const expected = [['workspace_id','TEXT',1,1],['privacy_epoch','INTEGER',1,2],['token_ref','TEXT',1,3],['account_id','TEXT',1,0],
      ['provider','TEXT',1,0],['account_generation','INTEGER',1,0],['credential_generation','INTEGER',1,0],['created_at','INTEGER',1,0],
      ['updated_at','INTEGER',1,0]] as const;
    if (columns.length !== expected.length || columns.some((row, index) => row.name !== expected[index]?.[0] || row.type !== expected[index]?.[1] ||
        row.notnull !== expected[index]?.[2] || row.pk !== expected[index]?.[3])) {
      fail('oauth_token_binding_schema_invalid', 'The OAuth token binding table is invalid.');
    }
  }

  readBindingWithinTransaction(context: OwnedTransactionContext, tokenRef: string): OAuthTokenBinding | undefined {
    this.assertContext(context);
    if (!isValidOAuthTokenRef(tokenRef)) fail('oauth_token_reference_invalid', 'The OAuth token reference is invalid.');
    const row = context.db.prepare(`SELECT workspace_id,privacy_epoch,token_ref,account_id,provider,account_generation,
      credential_generation,created_at,updated_at FROM server_oauth_token_bindings
      WHERE workspace_id=? AND privacy_epoch=? AND token_ref=?`).get(context.workspaceId, context.privacyEpoch, tokenRef) as BindingRow | undefined;
    if (!row) return undefined;
    if (!isValidAccountId(row.account_id) || row.provider !== 'google' && row.provider !== 'microsoft' ||
        !validGeneration(row.account_generation) || !validGeneration(row.credential_generation, false)) {
      fail('oauth_token_binding_corrupt', 'The OAuth token binding is unavailable.');
    }
    return Object.freeze({ tokenRef: row.token_ref, accountId: row.account_id, provider: row.provider,
      accountGeneration: row.account_generation, credentialGeneration: row.credential_generation, privacyEpoch: row.privacy_epoch });
  }

  writeExistingCredentialBindingWithinTransaction(context: OwnedTransactionContext, input: OAuthTokenBindingWrite): OAuthTokenBinding {
    this.assertContext(context);
    if (!input || typeof input !== 'object' || !isValidOAuthTokenRef(input.tokenRef) || !isValidAccountId(input.accountId)) {
      fail('oauth_token_binding_invalid', 'The OAuth token binding is invalid.');
    }
    assertProvider(input.provider);
    if (!validGeneration(input.accountGeneration) || !validGeneration(input.credentialGeneration, false) ||
        input.expectedCredentialGeneration !== undefined && !validGeneration(input.expectedCredentialGeneration)) {
      fail('oauth_token_binding_invalid', 'The OAuth token binding is invalid.');
    }
    const current = context.db.prepare('SELECT generation FROM account_generations WHERE workspace_id=? AND account_id=?')
      .get(context.workspaceId, input.accountId) as { generation: number } | undefined;
    if (!current || current.generation !== input.accountGeneration) fail('oauth_account_generation_changed', 'The account generation changed.');
    const purpose = input.provider === 'google' ? 'googleOAuth' : 'microsoftOAuth';
    const metadata = context.db.prepare(`SELECT generation,configured FROM vault_metadata WHERE workspace_id=? AND scope_type='account'
      AND scope_id=? AND purpose=?`).get(context.workspaceId, input.accountId, purpose) as { generation: number; configured: number } | undefined;
    const ciphertext = context.db.prepare(`SELECT generation,account_generation FROM vault_ciphertexts WHERE workspace_id=? AND scope_type='account'
      AND scope_id=? AND purpose=?`).get(context.workspaceId, input.accountId, purpose) as
      { generation: number; account_generation: number } | undefined;
    if (!metadata || metadata.configured !== 1 || metadata.generation !== input.credentialGeneration ||
        !ciphertext || ciphertext.generation !== input.credentialGeneration || ciphertext.account_generation !== input.accountGeneration) {
      fail('oauth_token_binding_credential_changed', 'The encrypted OAuth credential is unavailable or changed.');
    }
    const existing = this.readBindingWithinTransaction(context, input.tokenRef);
    if (existing) {
      if (existing.accountId !== input.accountId || existing.provider !== input.provider ||
          existing.accountGeneration !== input.accountGeneration || existing.privacyEpoch !== context.privacyEpoch ||
          input.expectedCredentialGeneration === undefined || existing.credentialGeneration !== input.expectedCredentialGeneration) {
        fail('oauth_token_binding_changed', 'The OAuth token binding changed.');
      }
      const changed = context.db.prepare(`UPDATE server_oauth_token_bindings SET credential_generation=?,updated_at=?
        WHERE workspace_id=? AND privacy_epoch=? AND token_ref=? AND account_id=? AND provider=? AND account_generation=? AND credential_generation=?`)
        .run(input.credentialGeneration, context.now, context.workspaceId, context.privacyEpoch, input.tokenRef, input.accountId,
          input.provider, input.accountGeneration, input.expectedCredentialGeneration).changes;
      if (changed !== 1) fail('oauth_token_binding_changed', 'The OAuth token binding changed.');
    } else {
      if (input.expectedCredentialGeneration !== undefined) fail('oauth_token_binding_changed', 'The OAuth token binding changed.');
      const other = context.db.prepare(`SELECT token_ref FROM server_oauth_token_bindings WHERE workspace_id=? AND privacy_epoch=?
        AND account_id=? AND provider=? AND account_generation=? AND token_ref<>?`)
        .get(context.workspaceId, context.privacyEpoch, input.accountId, input.provider, input.accountGeneration, input.tokenRef);
      if (other) fail('oauth_token_binding_conflict', 'Another token reference is bound to this account generation.');
      context.db.prepare(`INSERT INTO server_oauth_token_bindings (workspace_id,privacy_epoch,token_ref,account_id,provider,
        account_generation,credential_generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(context.workspaceId, context.privacyEpoch, input.tokenRef, input.accountId, input.provider, input.accountGeneration,
          input.credentialGeneration, context.now, context.now);
    }
    return Object.freeze({ tokenRef: input.tokenRef, accountId: input.accountId, provider: input.provider,
      accountGeneration: input.accountGeneration, credentialGeneration: input.credentialGeneration, privacyEpoch: context.privacyEpoch });
  }

  retireBindingWithinTransaction(context: OwnedTransactionContext, tokenRef: string): void {
    this.assertContext(context);
    if (!isValidOAuthTokenRef(tokenRef)) fail('oauth_token_reference_invalid', 'The OAuth token reference is invalid.');
    context.db.prepare('DELETE FROM server_oauth_token_bindings WHERE workspace_id=? AND privacy_epoch=? AND token_ref=?')
      .run(context.workspaceId, context.privacyEpoch, tokenRef);
  }

  private assertContext(context: OwnedTransactionContext): void {
    if (!context || context.db !== this.#db || !UUID_V4.test(context.workspaceId) || !UUID_V4.test(context.ownerId) ||
        !Number.isSafeInteger(context.privacyEpoch) || context.privacyEpoch < 0 || typeof context.assertActive !== 'function') {
      fail('oauth_token_binding_context_invalid', 'A current owned transaction context is required.');
    }
    context.assertActive();
    const owner = context.db.prepare('SELECT owner_id,privacy_epoch FROM workspaces WHERE id=?').get(context.workspaceId) as
      { owner_id: string; privacy_epoch: number } | undefined;
    if (!owner || owner.owner_id !== context.ownerId || owner.privacy_epoch !== context.privacyEpoch) {
      fail('oauth_token_binding_context_invalid', 'A current owned transaction context is required.');
    }
  }
}
