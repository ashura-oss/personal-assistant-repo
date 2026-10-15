import type { Account } from '../core';
import type { StoredOAuthToken, OAuthTokenStore } from '../connectors';
import type { DurableKernel, OwnedTransactionContext } from '../../server/src/kernel.js';
import type { SecretVault } from '../../server/src/vault.js';

type Identity = NonNullable<Account['identity']>;
type OAuthPurpose = 'googleOAuth' | 'microsoftOAuth';
type Binding = Readonly<{ accountId: string; provider: 'google' | 'microsoft'; accountGeneration: number; credentialGeneration: number; privacyEpoch: number }>;
type BindingRow = { account_id: string; provider: 'google' | 'microsoft'; account_generation: number; credential_generation: number; privacy_epoch: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSE: Readonly<Record<Binding['provider'], OAuthPurpose>> = Object.freeze({ google: 'googleOAuth', microsoft: 'microsoftOAuth' });

function sameIdentity(a: Identity | undefined, b: Identity | undefined): boolean {
  return Boolean(a && b && a.providerNamespace === b.providerNamespace && a.clientId === b.clientId && a.subject === b.subject &&
    a.resourceUserId === b.resourceUserId && a.issuer === b.issuer && a.tenantId === b.tenantId);
}

function validateToken(value: unknown): StoredOAuthToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('oauth_token_invalid');
  const token = value as Partial<StoredOAuthToken>;
  if (typeof token.accessToken !== 'string' || token.accessToken.length < 1 || token.accessToken.length > 16_384 ||
      /[\u0000-\u001f\u007f]/.test(token.accessToken) ||
      token.refreshToken !== undefined && (typeof token.refreshToken !== 'string' || token.refreshToken.length > 16_384 || /[\u0000-\u001f\u007f]/.test(token.refreshToken)) ||
      !Number.isSafeInteger(token.expiresAt) || (token.expiresAt as number) < 0 || !token.identity ||
      typeof token.identity.providerNamespace !== 'string' || typeof token.identity.clientId !== 'string' || typeof token.identity.subject !== 'string') {
    throw new Error('oauth_token_invalid');
  }
  return Object.freeze({ accessToken: token.accessToken,
    ...(token.refreshToken !== undefined ? { refreshToken: token.refreshToken } : {}),
    expiresAt: token.expiresAt as number, identity: Object.freeze({ ...token.identity }) });
}

/**
 * Node-only token store for accounts that are already durably bound to a token
 * reference. New OAuth installation is deliberately rejected until its atomic
 * snapshot-and-vault promotion command exists.
 */
export class NodeVaultOAuthTokenStore implements OAuthTokenStore {
  constructor(private readonly kernel: DurableKernel, private readonly vault: SecretVault,
    private readonly actorToken: string, private readonly binding: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>,
    private readonly currentAccounts: () => readonly Account[]) {
    if (!UUID.test(binding.workspaceId) || !UUID.test(binding.ownerId) || !Number.isSafeInteger(binding.privacyEpoch) || binding.privacyEpoch < 0) {
      throw new Error('oauth_token_store_binding_invalid');
    }
    this.withOwned((context) => {
      const tables = context.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('server_oauth_token_binding_schema','server_oauth_token_bindings')")
        .all() as Array<{ name: string }>;
      const hasSchema = tables.some((row) => row.name === 'server_oauth_token_binding_schema');
      const hasBindings = tables.some((row) => row.name === 'server_oauth_token_bindings');
      const marker = hasSchema
        ? context.db.prepare("SELECT version FROM server_oauth_token_binding_schema WHERE singleton=1").get() as { version: number } | undefined
        : undefined;
      if (!marker) {
        if (hasSchema || hasBindings) throw new Error('oauth_token_binding_schema_invalid');
        context.db.exec(`CREATE TABLE server_oauth_token_binding_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL) STRICT;
        INSERT INTO server_oauth_token_binding_schema(singleton,version) VALUES(1,1);
        CREATE TABLE server_oauth_token_bindings (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
        token_ref TEXT NOT NULL CHECK(length(token_ref) BETWEEN 1 AND 128),
        account_id TEXT NOT NULL CHECK(length(account_id)=36),
        provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')),
        account_generation INTEGER NOT NULL CHECK(account_generation>=0),
        credential_generation INTEGER NOT NULL CHECK(credential_generation>0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, privacy_epoch, token_ref),
        UNIQUE(workspace_id, privacy_epoch, account_id, provider, account_generation)
      ) STRICT;`);
      } else if (marker.version !== 1) throw new Error('oauth_token_binding_schema_unsupported');
      const columns = context.db.pragma('table_info(server_oauth_token_bindings)') as Array<{ name: string; type: string; notnull: number; pk: number }>;
      const expected = [['workspace_id','TEXT',1,1],['privacy_epoch','INTEGER',1,2],['token_ref','TEXT',1,3],['account_id','TEXT',1,0],['provider','TEXT',1,0],
        ['account_generation','INTEGER',1,0],['credential_generation','INTEGER',1,0],['created_at','INTEGER',1,0],['updated_at','INTEGER',1,0]] as const;
      if (columns.length !== expected.length || columns.some((row,index) => row.name !== expected[index]?.[0] || row.type !== expected[index]?.[1] ||
        row.notnull !== expected[index]?.[2] || row.pk !== expected[index]?.[3])) throw new Error('oauth_token_binding_schema_invalid');
    });
  }

  async get(tokenRef: string): Promise<StoredOAuthToken | null> {
    this.validateRef(tokenRef);
    const account = this.currentAccounts().find((row) => row.tokenRef === tokenRef && row.connected && row.authStatus === 'connected');
    if (!account || (account.provider !== 'google' && account.provider !== 'microsoft') || !account.identity) return null;
    return this.withOwned((context) => {
      const binding = this.readBinding(context, tokenRef);
      if (!binding || binding.accountId !== account.id || binding.provider !== account.provider ||
          binding.accountGeneration !== (account.connectionGeneration ?? 0)) return null;
      if (binding.privacyEpoch !== context.privacyEpoch) return null;
      const currentGeneration = this.accountGeneration(context, binding.accountId);
      if (currentGeneration !== binding.accountGeneration) return null;
      const secret = this.vault.getSecretWithinTransaction(context, { type: 'account', accountId: binding.accountId,
        expectedAccountGeneration: binding.accountGeneration }, PURPOSE[binding.provider]);
      if (!secret) return null;
      let parsed: unknown;
      try { parsed = JSON.parse(secret) as unknown; } catch { throw new Error('oauth_token_record_invalid'); }
      const token = validateToken(parsed);
      if (!sameIdentity(token.identity, account.identity)) return null;
      return token;
    });
  }

  async set(tokenRef: string, tokenValue: StoredOAuthToken): Promise<void> {
    this.validateRef(tokenRef);
    const token = validateToken(tokenValue);
    const account = this.currentAccounts().find((row) => row.tokenRef === tokenRef && row.connected && row.authStatus === 'connected');
    if (!account || (account.provider !== 'google' && account.provider !== 'microsoft') || !account.identity ||
        !sameIdentity(account.identity, token.identity)) throw new Error('oauth_install_transaction_required');
    const provider = account.provider;
    this.withOwned((context) => {
      const generation = account.connectionGeneration ?? 0;
      if (this.accountGeneration(context, account.id) !== generation) throw new Error('oauth_account_generation_changed');
      const old = this.readBinding(context, tokenRef);
      if (old && (old.accountId !== account.id || old.provider !== provider || old.accountGeneration !== generation || old.privacyEpoch !== context.privacyEpoch)) {
        throw new Error('oauth_token_binding_changed');
      }
      const other = context.db.prepare(`SELECT token_ref FROM server_oauth_token_bindings WHERE workspace_id=? AND privacy_epoch=?
        AND account_id=? AND provider=? AND account_generation=? AND token_ref<>?`).get(context.workspaceId, context.privacyEpoch,
        account.id, provider, generation, tokenRef) as { token_ref: string } | undefined;
      if (other) throw new Error('oauth_install_transaction_required');
      const purpose = PURPOSE[provider];
      const metadata = this.vault.getMetadataWithinTransaction(context,
        { type: 'account', accountId: account.id, expectedAccountGeneration: generation }, purpose);
      const raw = JSON.stringify(token);
      const saved = this.vault.setSecretWithinTransaction(context, { type: 'account', accountId: account.id,
        expectedAccountGeneration: generation }, purpose, metadata.generation, raw);
      const now = context.now;
      context.db.prepare(`INSERT INTO server_oauth_token_bindings (workspace_id,privacy_epoch,token_ref,account_id,provider,account_generation,credential_generation,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,privacy_epoch,token_ref) DO UPDATE SET
          account_id=excluded.account_id,provider=excluded.provider,account_generation=excluded.account_generation,
          credential_generation=excluded.credential_generation,updated_at=excluded.updated_at`)
        .run(context.workspaceId, context.privacyEpoch, tokenRef, account.id, provider, generation, saved.generation, now, now);
    });
  }

  async delete(tokenRef: string): Promise<void> {
    this.validateRef(tokenRef);
    this.withOwned((context) => {
      const binding = this.readBinding(context, tokenRef);
      if (!binding) return;
      if (binding.privacyEpoch !== context.privacyEpoch) return;
      const activeRef = this.currentAccounts().find((row) => row.id === binding.accountId && row.connected && row.authStatus === 'connected');
      if (activeRef) {
        if (activeRef.tokenRef === tokenRef && (activeRef.connectionGeneration ?? 0) === binding.accountGeneration) return;
        // A live replacement may share this provider slot. Retire only the old
        // opaque reference; it cannot authorize touching the active ciphertext.
        this.retireBinding(context, tokenRef);
        return;
      }
      this.vault.deleteAccountSecretForExactBindingWithinTransaction(context, {
        accountId: binding.accountId, expectedAccountGeneration: binding.accountGeneration,
        purpose: PURPOSE[binding.provider], expectedCredentialGeneration: binding.credentialGeneration,
      });
      this.retireBinding(context, tokenRef);
    });
  }

  private readBinding(context: OwnedTransactionContext, tokenRef: string): Binding | undefined {
    const row = context.db.prepare(`SELECT account_id,provider,account_generation,credential_generation,privacy_epoch FROM server_oauth_token_bindings
      WHERE workspace_id=? AND privacy_epoch=? AND token_ref=?`).get(context.workspaceId, context.privacyEpoch, tokenRef) as BindingRow | undefined;
    return row ? Object.freeze({ accountId: row.account_id, provider: row.provider, accountGeneration: row.account_generation,
      credentialGeneration: row.credential_generation, privacyEpoch: row.privacy_epoch }) : undefined;
  }

  private retireBinding(context: OwnedTransactionContext, tokenRef: string): void {
    context.db.prepare('DELETE FROM server_oauth_token_bindings WHERE workspace_id=? AND privacy_epoch=? AND token_ref=?')
      .run(context.workspaceId, context.privacyEpoch, tokenRef);
  }

  private accountGeneration(context: OwnedTransactionContext, accountId: string): number | undefined {
    const row = context.db.prepare('SELECT generation FROM account_generations WHERE workspace_id=? AND account_id=?')
      .get(context.workspaceId, accountId) as { generation: number } | undefined;
    return row?.generation;
  }

  private validateRef(value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('oauth_token_reference_invalid');
  }

  private withOwned<T>(callback: (context: OwnedTransactionContext) => T): T {
    return this.kernel.withOwnedTransaction(this.actorToken, this.binding.privacyEpoch, (context) => {
      if (context.workspaceId !== this.binding.workspaceId || context.ownerId !== this.binding.ownerId || context.privacyEpoch !== this.binding.privacyEpoch) {
        throw new Error('oauth_token_store_binding_invalid');
      }
      return callback(context);
    });
  }
}
