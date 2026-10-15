import { ECDH, createECDH, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import webPush from 'web-push';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import type { SecretVault, WebPushSecretCiphertext } from './vault.js';
import type { WorkspaceHttpAdmission } from './workspaceHttp.js';
import type { WebPushCommandReceipt, WebPushHttpApi, WebPushSafeStatus, WebPushSubscriptionPage, WebPushSubscriptionReconciliation } from './webPushHttp.js';
import { registerWorkspaceEraseDeleteGuard } from './workspaceErase.js';

const SCHEMA_VERSION = 1;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_PAGE_SIZE = 100;
const SECRET_FORMAT = 1;
const DEFAULT_REGISTRY_BUDGET_BYTES = 16 * 1024 * 1024;
const ROW_METADATA_RESERVE_BYTES = 512;
const ACTIVE_DEVICE_REVOKE_RESERVE_BYTES = 1024;

export class WebPushRegistryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WebPushRegistryError';
  }
}

function fail(code: string): never { throw new WebPushRegistryError(code); }

function closedFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('web_push_invalid_request');
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return fail('web_push_invalid_request');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      return fail('web_push_invalid_request');
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail('web_push_invalid_request');
      result[key] = descriptor.value;
    }
    return result;
  } catch { return fail('web_push_invalid_request'); }
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) return fail('web_push_invalid_request');
  return value.toLowerCase();
}

function safeInteger(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return fail('web_push_invalid_request');
  return value;
}

function canonicalBase64Url(value: unknown, expectedBytes: number): string {
  if (typeof value !== 'string' || value.length > 256 || !BASE64URL.test(value)) return fail('web_push_invalid_subscription');
  let decoded: Buffer;
  try { decoded = Buffer.from(value, 'base64url'); } catch { return fail('web_push_invalid_subscription'); }
  const canonical = decoded.toString('base64url');
  const valid = decoded.length === expectedBytes && canonical === value;
  decoded.fill(0);
  if (!valid) return fail('web_push_invalid_subscription');
  return value;
}

function validP256Point(encoded: string): boolean {
  const point = Buffer.from(encoded, 'base64url');
  try {
    if (point.length !== 65 || point[0] !== 4) return false;
    const normalized = ECDH.convertKey(point, 'prime256v1', undefined, undefined, 'uncompressed');
    if (!Buffer.isBuffer(normalized)) return false;
    const valid = normalized.length === 65 && normalized.equals(point);
    normalized.fill(0);
    return valid;
  } catch { return false; }
  finally { point.fill(0); }
}

function endpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ENDPOINT_LENGTH || value.includes('#')) {
    return fail('web_push_invalid_subscription');
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('web_push_invalid_subscription'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port || parsed.href !== value) {
    return fail('web_push_invalid_subscription');
  }
  return value;
}

function nowMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) return fail('web_push_clock_invalid');
  return value;
}

function activeContext(kernel: DurableKernel, context: OwnedTransactionContext): void {
  kernel.assertOwnedTransactionContext(context);
  const row = context.db.prepare('SELECT owner_id,privacy_epoch FROM workspaces WHERE id=?').get(context.workspaceId) as
    { owner_id: string; privacy_epoch: number } | undefined;
  if (!row || row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch) fail('web_push_stale_epoch');
}

function canonicalReceipt(value: unknown): string {
  return JSON.stringify(value);
}

interface VapidRow {
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly privacy_epoch: number;
  readonly key_id: string;
  readonly public_key: string;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
  readonly created_at: number;
}

interface HeadRow {
  readonly generation: number;
  readonly status: 'active' | 'revoked';
  readonly key_id: string;
}

export interface WebPushProvisionRequest { readonly commandId: string; readonly expectedPrivacyEpoch: number }
export interface WebPushRotateRequest extends WebPushProvisionRequest { readonly expectedActiveKeyId: string }
export interface WebPushRegisterRequest extends WebPushProvisionRequest {
  readonly deviceId: string;
  readonly keyId: string;
  readonly expectedPreviousGeneration: number;
  readonly subscription: Readonly<{ endpoint: string; keys: Readonly<{ p256dh: string; auth: string }> }>;
}
export interface WebPushRevokeRequest extends WebPushProvisionRequest {
  readonly deviceId: string;
  readonly expectedGeneration: number;
}

export interface WebPushReconcileRequest {
  readonly expectedPrivacyEpoch: number;
  readonly deviceId: string;
  readonly subscription: Readonly<{ endpoint: string; keys: Readonly<{ p256dh: string; auth: string }> }>;
}

/** Owned-workspace Web Push keyring and subscription registry. It performs no network requests. */
export class WebPushSubscriptions implements WebPushHttpApi {
  readonly #kernel: DurableKernel;
  readonly #vault: SecretVault;
  readonly #now: () => number;
  readonly #assertWorkspaceAdmission: (admission: WorkspaceHttpAdmission) => void;
  readonly #registryBudgetBytes: number;

  constructor(kernel: DurableKernel, vault: SecretVault,
    assertWorkspaceAdmission: (admission: WorkspaceHttpAdmission) => void,
    options: Readonly<{ now?: () => number; physicalBudgetBytes?: number }> = {}) {
    if (typeof assertWorkspaceAdmission !== 'function') throw new TypeError('web_push_workspace_admission_required');
    const budget = options.physicalBudgetBytes ?? DEFAULT_REGISTRY_BUDGET_BYTES;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > DEFAULT_REGISTRY_BUDGET_BYTES) throw new TypeError('web_push_budget_invalid');
    this.#kernel = kernel;
    this.#vault = vault;
    this.#now = options.now ?? Date.now;
    this.#assertWorkspaceAdmission = assertWorkspaceAdmission;
    this.#registryBudgetBytes = budget;
    kernel.withTrustedDatabaseTransaction((db) => {
      registerWorkspaceEraseDeleteGuard(db);
      initializeSchema(db);
    });
  }

  getStatus(admission: WorkspaceHttpAdmission): WebPushSafeStatus {
    const identity = this.#identity(admission);
    return this.#kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
      const head = this.#activeVapid(context);
      const row = context.db.prepare(`SELECT COUNT(*) AS count FROM web_push_subscription_heads
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND status='active'`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch) as { count: number };
      return Object.freeze({ schemaVersion: 1, privacyEpoch: context.privacyEpoch, provisioned: Boolean(head),
        ...(head ? { activeKey: Object.freeze({ keyId: head.key_id, publicKey: head.public_key,
          createdAt: new Date(head.created_at).toISOString() }) } : {}), subscriptionCount: row.count });
    });
  }

  getPublicKey(admission: WorkspaceHttpAdmission): Readonly<{ schemaVersion: 1; privacyEpoch: number; provisioned: boolean;
    keyId?: string; publicKey?: string; createdAt?: string }> {
    const identity = this.#identity(admission);
    return this.#kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
      const head = this.#activeVapid(context);
      return Object.freeze({ schemaVersion: 1, privacyEpoch: context.privacyEpoch, provisioned: Boolean(head),
        ...(head ? { keyId: head.key_id, publicKey: head.public_key, createdAt: new Date(head.created_at).toISOString() } : {}) });
    });
  }

  listSubscriptions(admission: WorkspaceHttpAdmission, cursor?: string): WebPushSubscriptionPage {
    const identity = this.#identity(admission);
    const after = cursor === undefined ? undefined : uuid(cursor);
    return this.#kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
      const rows = context.db.prepare(`SELECT device_id,generation,status,key_id,updated_at FROM web_push_subscription_heads
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? ${after ? 'AND device_id>?' : ''}
        ORDER BY device_id LIMIT ?`).all(...(after ? [context.workspaceId, context.ownerId, context.privacyEpoch, after, MAX_PAGE_SIZE + 1] :
        [context.workspaceId, context.ownerId, context.privacyEpoch, MAX_PAGE_SIZE + 1])) as Array<{
          device_id: string; generation: number; status: 'active' | 'revoked'; key_id: string; updated_at: number }>;
      const hasMore = rows.length > MAX_PAGE_SIZE;
      const page = rows.slice(0, MAX_PAGE_SIZE);
      const last = page.at(-1)?.device_id;
      return Object.freeze({ schemaVersion: 1, privacyEpoch: context.privacyEpoch,
        subscriptions: Object.freeze(page.map((row) => Object.freeze({ deviceId: row.device_id,
          generation: row.generation, status: row.status, keyId: row.key_id, updatedAt: new Date(row.updated_at).toISOString() }))),
        ...(hasMore && last ? { nextCursor: last } : {}) });
    });
  }

  reconcileSubscription(admission: WorkspaceHttpAdmission, input: unknown): WebPushSubscriptionReconciliation {
    const request = parseReconcile(input);
    const identity = this.#identity(admission);
    if (identity.privacyEpoch !== request.expectedPrivacyEpoch) fail('web_push_stale_epoch');
    this.#assertWorkspaceAdmission(admission);
    return this.#kernel.withOwnedTransaction(admission.sessionToken, request.expectedPrivacyEpoch, (context) => {
      activeContext(this.#kernel, context);
      this.#assertWorkspaceAdmission(admission);
      const head = context.db.prepare(`SELECT generation,status,key_id FROM web_push_subscription_heads
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND device_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, request.deviceId) as
        { generation: number; status: 'active' | 'revoked'; key_id: string } | undefined;
      if (!head) return Object.freeze({ schemaVersion: 1, privacyEpoch: context.privacyEpoch,
        deviceId: request.deviceId, status: 'missing' });
      if (head.status === 'revoked') return Object.freeze({ schemaVersion: 1, privacyEpoch: context.privacyEpoch,
        deviceId: request.deviceId, status: 'revoked', generation: head.generation, keyId: head.key_id });
      const row = context.db.prepare(`SELECT s.key_version,s.nonce,s.tag,s.ciphertext,k.public_key
        FROM web_push_subscriptions s JOIN web_push_vapid_keys k ON k.workspace_id=s.workspace_id AND k.owner_id=s.owner_id
          AND k.privacy_epoch=s.privacy_epoch AND k.key_id=s.key_id
        WHERE s.workspace_id=? AND s.owner_id=? AND s.privacy_epoch=? AND s.device_id=? AND s.generation=? AND s.key_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, request.deviceId, head.generation, head.key_id) as
        { key_version: number; nonce: Buffer; tag: Buffer; ciphertext: Buffer; public_key: string } | undefined;
      if (!row || row.key_version !== SECRET_FORMAT) fail('web_push_registry_corrupt');
      const cleartext = this.#vault.openWebPushSecretWithinTransaction(context,
        { kind: 'subscription', deviceId: request.deviceId, generation: head.generation, keyId: head.key_id },
        { format: row.key_version, nonce: row.nonce, tag: row.tag, ciphertext: row.ciphertext });
      let matches = false;
      try {
        const parsed = JSON.parse(cleartext.toString('utf8')) as unknown;
        const secret = closedFields(parsed, ['endpoint', 'p256dh', 'auth']);
        matches = constantTextEqual(secret.endpoint, request.subscription.endpoint) &&
          constantTextEqual(secret.p256dh, request.subscription.keys.p256dh) &&
          constantTextEqual(secret.auth, request.subscription.keys.auth);
      } catch { fail('web_push_registry_corrupt'); }
      finally { cleartext.fill(0); }
      return Object.freeze({ schemaVersion: 1, privacyEpoch: context.privacyEpoch, deviceId: request.deviceId,
        status: matches ? 'matched' : 'unmatched', generation: head.generation, keyId: head.key_id, publicKey: row.public_key });
    });
  }

  provision(admission: WorkspaceHttpAdmission, input: unknown): WebPushCommandReceipt {
    const request = parseProvision(input);
    return this.#mutate(admission, request.expectedPrivacyEpoch, request.commandId, 'provision', [request.expectedPrivacyEpoch],
      (context) => {
        if (this.#activeVapid(context)) fail('web_push_already_provisioned');
        return this.#createVapidKey(context);
      });
  }

  rotate(admission: WorkspaceHttpAdmission, input: unknown): WebPushCommandReceipt {
    const request = parseRotate(input);
    return this.#mutate(admission, request.expectedPrivacyEpoch, request.commandId, 'rotate',
      [request.expectedPrivacyEpoch, request.expectedActiveKeyId], (context) => {
        const active = this.#activeVapid(context);
        if (!active || active.key_id !== request.expectedActiveKeyId) fail('web_push_stale_key');
        return this.#createVapidKey(context);
      });
  }

  register(admission: WorkspaceHttpAdmission, input: unknown): WebPushCommandReceipt {
    const request = parseRegister(input);
    return this.#mutate(admission, request.expectedPrivacyEpoch, request.commandId, 'register',
      [request.expectedPrivacyEpoch, request.deviceId, request.keyId, request.expectedPreviousGeneration, request.subscription.endpoint,
        request.subscription.keys.p256dh, request.subscription.keys.auth], (context) => {
        const key = this.#activeVapid(context);
        if (!key) fail('web_push_not_provisioned');
        if (key.key_id !== request.keyId) fail('web_push_stale_key');
        const head = context.db.prepare(`SELECT owner_id,privacy_epoch,generation FROM web_push_subscription_heads
          WHERE workspace_id=? AND device_id=?`).get(context.workspaceId, request.deviceId) as
          { owner_id: string; privacy_epoch: number; generation: number } | undefined;
        if (head && (head.owner_id !== context.ownerId || head.privacy_epoch !== context.privacyEpoch)) fail('web_push_registry_corrupt');
        const previous = head?.generation ?? 0;
        if (previous !== request.expectedPreviousGeneration) fail('web_push_stale_generation');
        const generation = increment(previous);
        const secretBytes = Buffer.from(JSON.stringify({ endpoint: request.subscription.endpoint,
          p256dh: request.subscription.keys.p256dh, auth: request.subscription.keys.auth }), 'utf8');
        let encrypted: WebPushSecretCiphertext;
        try { encrypted = this.#vault.sealWebPushSecretWithinTransaction(context,
          { kind: 'subscription', deviceId: request.deviceId, generation, keyId: key.key_id }, secretBytes); }
        finally { secretBytes.fill(0); }
        const now = nowMilliseconds(this.#now());
        context.db.prepare(`INSERT INTO web_push_subscriptions(workspace_id,owner_id,privacy_epoch,device_id,generation,key_id,
          key_version,nonce,tag,ciphertext,created_at) VALUES(?,?,?,?,?,?,?, ?,?,?,?)`)
          .run(context.workspaceId, context.ownerId, context.privacyEpoch, request.deviceId, generation, key.key_id,
            SECRET_FORMAT, encrypted.nonce, encrypted.tag, encrypted.ciphertext, now);
        context.db.prepare(`INSERT INTO web_push_subscription_heads(workspace_id,owner_id,privacy_epoch,device_id,generation,status,key_id,updated_at)
          VALUES(?,?,?,?,?,'active',?,?) ON CONFLICT(workspace_id,device_id) DO UPDATE SET
          owner_id=excluded.owner_id,privacy_epoch=excluded.privacy_epoch,generation=excluded.generation,
          status='active',key_id=excluded.key_id,updated_at=excluded.updated_at`)
          .run(context.workspaceId, context.ownerId, context.privacyEpoch, request.deviceId, generation, key.key_id, now);
        return { deviceId: request.deviceId, generation, status: 'active', keyId: key.key_id, updatedAt: new Date(now).toISOString() };
      });
  }

  revoke(admission: WorkspaceHttpAdmission, input: unknown): WebPushCommandReceipt {
    const request = parseRevoke(input);
    return this.#mutate(admission, request.expectedPrivacyEpoch, request.commandId, 'revoke',
      [request.expectedPrivacyEpoch, request.deviceId, request.expectedGeneration], (context) => {
        const head = context.db.prepare(`SELECT generation,key_id,status FROM web_push_subscription_heads
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND device_id=?`)
          .get(context.workspaceId, context.ownerId, context.privacyEpoch, request.deviceId) as HeadRow | undefined;
        if (!head || head.generation !== request.expectedGeneration || head.status !== 'active') fail('web_push_stale_generation');
        const now = nowMilliseconds(this.#now());
        context.db.prepare(`UPDATE web_push_subscription_heads SET status='revoked',updated_at=?
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND device_id=? AND generation=? AND status='active'`)
          .run(now, context.workspaceId, context.ownerId, context.privacyEpoch, request.deviceId, request.expectedGeneration);
        return { deviceId: request.deviceId, generation: request.expectedGeneration, status: 'revoked', keyId: head.key_id,
          updatedAt: new Date(now).toISOString() };
      });
  }

  inspectCommand(admission: WorkspaceHttpAdmission, commandIdInput: string): WebPushCommandReceipt | undefined {
    const commandId = uuid(commandIdInput);
    const identity = this.#identity(admission);
    return this.#kernel.withOwnedTransaction(admission.sessionToken, identity.privacyEpoch, (context) => {
      const row = context.db.prepare(`SELECT operation,result_json,created_at FROM web_push_commands
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND command_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, commandId) as
        { operation: WebPushCommandReceipt['operation']; result_json: string; created_at: number } | undefined;
      return row ? decodeReceipt(commandId, row.operation, row.result_json, row.created_at) : undefined;
    });
  }

  #identity(admission: WorkspaceHttpAdmission): ReturnType<DurableKernel['getOwnedIdentity']> {
    if (!admission || typeof admission !== 'object' || typeof admission.sessionToken !== 'string' ||
        typeof admission.assertCurrent !== 'function') fail('web_push_unauthenticated');
    admission.assertCurrent();
    return this.#kernel.getOwnedIdentity(admission.sessionToken);
  }

  #mutate(admission: WorkspaceHttpAdmission, expectedEpoch: number, commandId: string,
    operation: WebPushCommandReceipt['operation'], digestParts: readonly unknown[],
    mutate: (context: OwnedTransactionContext) => Record<string, string | number | boolean>): WebPushCommandReceipt {
    const identity = this.#identity(admission);
    if (identity.privacyEpoch !== expectedEpoch) fail('web_push_stale_epoch');
    admission.assertCurrent();
    this.#assertWorkspaceAdmission(admission);
    const digest = createHash('sha256').update(JSON.stringify([operation, ...digestParts]), 'utf8').digest('hex');
    return this.#kernel.withOwnedTransaction(admission.sessionToken, expectedEpoch, (context) => {
      activeContext(this.#kernel, context);
      this.#assertWorkspaceAdmission(admission);
      const existing = context.db.prepare(`SELECT operation,request_digest,result_json,created_at FROM web_push_commands
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND command_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, commandId) as
        { operation: string; request_digest: string; result_json: string; created_at: number } | undefined;
      if (existing) {
        if (existing.operation !== operation || existing.request_digest !== digest) fail('web_push_command_conflict');
        return decodeReceipt(commandId, operation, existing.result_json, existing.created_at);
      }
      // Replays bypass capacity checks above; a fresh growth command starts only
      // from a valid current budget. Revocation is exempt so reserved terminal
      // receipt space can always be consumed to reduce active storage.
      if (operation !== 'revoke') assertRegistryBudget(context, this.#registryBudgetBytes);
      const result = mutate(context);
      const resultJson = canonicalReceipt(result);
      const createdAt = nowMilliseconds(this.#now());
      context.db.prepare(`INSERT INTO web_push_commands(workspace_id,owner_id,privacy_epoch,command_id,operation,
        request_digest,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, commandId, operation, digest, resultJson, createdAt);
      assertRegistryBudget(context, this.#registryBudgetBytes);
      return decodeReceipt(commandId, operation, resultJson, createdAt);
    });
  }

  #activeVapid(context: OwnedTransactionContext): VapidRow | undefined {
    const head = context.db.prepare(`SELECT owner_id,privacy_epoch,key_id FROM web_push_vapid_heads WHERE workspace_id=?`)
      .get(context.workspaceId) as { owner_id: string; privacy_epoch: number; key_id: string } | undefined;
    if (head && (head.owner_id !== context.ownerId || head.privacy_epoch !== context.privacyEpoch)) fail('web_push_registry_corrupt');
    const row = context.db.prepare(`SELECT k.workspace_id,k.owner_id,k.privacy_epoch,k.key_id,k.public_key,k.nonce,k.tag,k.ciphertext,k.created_at
      FROM web_push_vapid_heads h JOIN web_push_vapid_keys k ON k.workspace_id=h.workspace_id AND k.owner_id=h.owner_id
      AND k.privacy_epoch=h.privacy_epoch AND k.key_id=h.key_id
      WHERE h.workspace_id=? AND h.owner_id=? AND h.privacy_epoch=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch) as VapidRow | undefined;
    return row;
  }

  #createVapidKey(context: OwnedTransactionContext): Record<string, string | number | boolean> {
    const generated = webPush.generateVAPIDKeys();
    const publicBytes = canonicalBase64Url(generated.publicKey, 65);
    const privateBytes = Buffer.from(canonicalBase64Url(generated.privateKey, 32), 'base64url');
    if (!validP256Point(publicBytes)) { privateBytes.fill(0); fail('web_push_key_generation_failed'); }
    const publicPoint = Buffer.from(publicBytes, 'base64url');
    const derived = createECDH('prime256v1');
    try {
      derived.setPrivateKey(privateBytes);
      if (!derived.getPublicKey(undefined, 'uncompressed').equals(publicPoint)) fail('web_push_key_generation_failed');
    } catch { privateBytes.fill(0); fail('web_push_key_generation_failed'); }
    finally { publicPoint.fill(0); }
    const keyId = randomUUID();
    const now = nowMilliseconds(this.#now());
    let encrypted: WebPushSecretCiphertext;
    try { encrypted = this.#vault.sealWebPushSecretWithinTransaction(context, { kind: 'vapid', keyId }, privateBytes); }
    finally { privateBytes.fill(0); }
    context.db.prepare(`INSERT INTO web_push_vapid_keys(workspace_id,owner_id,privacy_epoch,key_id,public_key,key_version,
      nonce,tag,ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, keyId, publicBytes, SECRET_FORMAT,
        encrypted.nonce, encrypted.tag, encrypted.ciphertext, now);
    context.db.prepare(`INSERT INTO web_push_vapid_heads(workspace_id,owner_id,privacy_epoch,key_id,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET owner_id=excluded.owner_id,
      privacy_epoch=excluded.privacy_epoch,key_id=excluded.key_id,updated_at=excluded.updated_at`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, keyId, now);
    return { keyId, publicKey: publicBytes, createdAt: new Date(now).toISOString() };
  }
}

function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) return fail('web_push_generation_exhausted');
  return value + 1;
}

function parseProvision(value: unknown): WebPushProvisionRequest {
  const f = closedFields(value, ['commandId', 'expectedPrivacyEpoch']);
  return Object.freeze({ commandId: uuid(f.commandId), expectedPrivacyEpoch: safeInteger(f.expectedPrivacyEpoch) });
}

function parseRotate(value: unknown): WebPushRotateRequest {
  const f = closedFields(value, ['commandId', 'expectedPrivacyEpoch', 'expectedActiveKeyId']);
  return Object.freeze({ commandId: uuid(f.commandId), expectedPrivacyEpoch: safeInteger(f.expectedPrivacyEpoch),
    expectedActiveKeyId: uuid(f.expectedActiveKeyId) });
}

function parseRegister(value: unknown): WebPushRegisterRequest {
  const f = closedFields(value, ['commandId', 'expectedPrivacyEpoch', 'deviceId', 'keyId', 'expectedPreviousGeneration', 'subscription']);
  const subscription = closedFields(f.subscription, ['endpoint', 'keys']);
  const keys = closedFields(subscription.keys, ['p256dh', 'auth']);
  const p256dh = canonicalBase64Url(keys.p256dh, 65);
  if (!validP256Point(p256dh)) fail('web_push_invalid_subscription');
  return Object.freeze({ commandId: uuid(f.commandId), expectedPrivacyEpoch: safeInteger(f.expectedPrivacyEpoch),
    deviceId: uuid(f.deviceId), keyId: uuid(f.keyId), expectedPreviousGeneration: safeInteger(f.expectedPreviousGeneration),
    subscription: Object.freeze({ endpoint: endpoint(subscription.endpoint), keys: Object.freeze({ p256dh,
      auth: canonicalBase64Url(keys.auth, 16) }) }) });
}

function parseRevoke(value: unknown): WebPushRevokeRequest {
  const f = closedFields(value, ['commandId', 'expectedPrivacyEpoch', 'deviceId', 'expectedGeneration']);
  return Object.freeze({ commandId: uuid(f.commandId), expectedPrivacyEpoch: safeInteger(f.expectedPrivacyEpoch),
    deviceId: uuid(f.deviceId), expectedGeneration: safeInteger(f.expectedGeneration, 1) });
}

function parseReconcile(value: unknown): WebPushReconcileRequest {
  const f = closedFields(value, ['expectedPrivacyEpoch', 'deviceId', 'subscription']);
  const subscription = closedFields(f.subscription, ['endpoint', 'keys']);
  const keys = closedFields(subscription.keys, ['p256dh', 'auth']);
  const p256dh = canonicalBase64Url(keys.p256dh, 65);
  if (!validP256Point(p256dh)) fail('web_push_invalid_subscription');
  return Object.freeze({ expectedPrivacyEpoch: safeInteger(f.expectedPrivacyEpoch), deviceId: uuid(f.deviceId),
    subscription: Object.freeze({ endpoint: endpoint(subscription.endpoint), keys: Object.freeze({ p256dh,
      auth: canonicalBase64Url(keys.auth, 16) }) }) });
}

function constantTextEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  try { return a.length === b.length && timingSafeEqual(a, b); }
  finally { a.fill(0); b.fill(0); }
}

function decodeReceipt(commandId: string, operation: WebPushCommandReceipt['operation'], json: string, createdAt: number): WebPushCommandReceipt {
  let parsed: unknown;
  try { parsed = JSON.parse(json) as unknown; } catch { return fail('web_push_receipt_corrupt'); }
  const corrupt = (): never => fail('web_push_receipt_corrupt');
  const exactKeys = (value: unknown, expected: readonly string[]): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === expected.length && Reflect.ownKeys(value).every((key) => typeof key === 'string' && expected.includes(key)));
  const receiptTime = (value: unknown): value is string => typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const receiptId = (value: unknown): value is string => typeof value === 'string' && UUID_V4.test(value);
  if (operation !== 'provision' && operation !== 'rotate' && operation !== 'register' && operation !== 'revoke') corrupt();
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > 8_640_000_000_000_000) corrupt();
  if (!exactKeys(parsed, operation === 'provision' || operation === 'rotate'
    ? ['keyId', 'publicKey', 'createdAt'] : ['deviceId', 'generation', 'status', 'keyId', 'updatedAt'])) return corrupt();
  const createdAtText = new Date(createdAt).toISOString();
  if (operation === 'provision' || operation === 'rotate') {
    const keyId = parsed.keyId;
    const publicKeyInput = parsed.publicKey;
    const resultTime = parsed.createdAt;
    if (!receiptId(keyId)) return corrupt();
    if (typeof publicKeyInput !== 'string' || !receiptTime(resultTime)) return corrupt();
    let publicKey: string;
    try { publicKey = canonicalBase64Url(publicKeyInput, 65); } catch { return corrupt(); }
    if (!validP256Point(publicKey)) corrupt();
    return Object.freeze({ schemaVersion: 1, commandId, operation,
      result: Object.freeze({ keyId: keyId.toLowerCase(), publicKey, createdAt: resultTime }), createdAt: createdAtText });
  }
  const deviceId = parsed.deviceId;
  const keyId = parsed.keyId;
  const generation = parsed.generation;
  const status = parsed.status;
  const updatedAt = parsed.updatedAt;
  if (!receiptId(deviceId) || !receiptId(keyId)) return corrupt();
  if (!Number.isSafeInteger(generation) || (generation as number) < 1 ||
      (status !== 'active' && status !== 'revoked') || !receiptTime(updatedAt) ||
      (operation === 'register' && status !== 'active') || (operation === 'revoke' && status !== 'revoked')) corrupt();
  return Object.freeze({ schemaVersion: 1, commandId, operation,
    result: Object.freeze({ deviceId: deviceId.toLowerCase(), generation: generation as number,
      status: status as 'active' | 'revoked', keyId: keyId.toLowerCase(), updatedAt: updatedAt as string }), createdAt: createdAtText });
}

function initializeSchema(db: import('better-sqlite3').Database): void {
  const exists = (name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const schemaExists = exists('web_push_schema');
  const dataTableNames = ['web_push_vapid_keys', 'web_push_vapid_heads', 'web_push_subscriptions',
    'web_push_subscription_heads', 'web_push_commands'];
  if (!schemaExists && !dataTableNames.some(exists)) {
    db.exec(`
      CREATE TABLE web_push_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version>0)) STRICT;
      CREATE TABLE web_push_vapid_keys(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),key_id TEXT NOT NULL,
        public_key TEXT NOT NULL CHECK(length(public_key)=87),key_version INTEGER NOT NULL CHECK(key_version=1),
        nonce BLOB NOT NULL CHECK(length(nonce)=12),tag BLOB NOT NULL CHECK(length(tag)=16),ciphertext BLOB NOT NULL CHECK(length(ciphertext)=32),
        created_at INTEGER NOT NULL CHECK(created_at>0),PRIMARY KEY(workspace_id,key_id),UNIQUE(workspace_id,owner_id,privacy_epoch,key_id)) STRICT;
      CREATE TABLE web_push_vapid_heads(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),key_id TEXT NOT NULL,updated_at INTEGER NOT NULL CHECK(updated_at>0),
        FOREIGN KEY(workspace_id,owner_id,privacy_epoch,key_id) REFERENCES web_push_vapid_keys(workspace_id,owner_id,privacy_epoch,key_id)) STRICT;
      CREATE TABLE web_push_subscriptions(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),device_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),
        key_id TEXT NOT NULL,key_version INTEGER NOT NULL CHECK(key_version=1),nonce BLOB NOT NULL CHECK(length(nonce)=12),
        tag BLOB NOT NULL CHECK(length(tag)=16),ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0 AND length(ciphertext)<=32768),
        created_at INTEGER NOT NULL CHECK(created_at>0),PRIMARY KEY(workspace_id,device_id,generation),
        FOREIGN KEY(workspace_id,owner_id,privacy_epoch,key_id) REFERENCES web_push_vapid_keys(workspace_id,owner_id,privacy_epoch,key_id)) STRICT;
      CREATE TABLE web_push_subscription_heads(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),device_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>0),status TEXT NOT NULL CHECK(status IN ('active','revoked')),
        key_id TEXT NOT NULL,updated_at INTEGER NOT NULL CHECK(updated_at>0),PRIMARY KEY(workspace_id,device_id)) STRICT;
      CREATE TABLE web_push_commands(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),command_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('provision','rotate','register','revoke')),
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),result_json TEXT NOT NULL,created_at INTEGER NOT NULL CHECK(created_at>0),
        PRIMARY KEY(workspace_id,command_id)) STRICT;
      CREATE INDEX web_push_subscription_heads_page ON web_push_subscription_heads(workspace_id,owner_id,privacy_epoch,device_id);
      CREATE INDEX web_push_subscriptions_key ON web_push_subscriptions(workspace_id,owner_id,privacy_epoch,key_id);
      CREATE INDEX web_push_commands_epoch ON web_push_commands(workspace_id,owner_id,privacy_epoch,created_at);
      CREATE TRIGGER web_push_vapid_keys_immutable_update BEFORE UPDATE ON web_push_vapid_keys BEGIN SELECT RAISE(ABORT,'web_push_immutable'); END;
      CREATE TRIGGER web_push_vapid_keys_erase_delete BEFORE DELETE ON web_push_vapid_keys
        WHEN COALESCE(still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch),0)<>1 BEGIN SELECT RAISE(ABORT,'web_push_erase_required'); END;
      CREATE TRIGGER web_push_subscriptions_immutable_update BEFORE UPDATE ON web_push_subscriptions BEGIN SELECT RAISE(ABORT,'web_push_immutable'); END;
      CREATE TRIGGER web_push_subscriptions_erase_delete BEFORE DELETE ON web_push_subscriptions
        WHEN COALESCE(still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch),0)<>1 BEGIN SELECT RAISE(ABORT,'web_push_erase_required'); END;
      CREATE TRIGGER web_push_commands_immutable_update BEFORE UPDATE ON web_push_commands BEGIN SELECT RAISE(ABORT,'web_push_immutable'); END;
      CREATE TRIGGER web_push_commands_erase_delete BEFORE DELETE ON web_push_commands
        WHEN COALESCE(still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch),0)<>1 BEGIN SELECT RAISE(ABORT,'web_push_erase_required'); END;
      INSERT INTO web_push_schema(singleton,version) VALUES(1,${SCHEMA_VERSION});
    `);
    return;
  }
  if (!schemaExists) fail('web_push_schema_corrupt');
  const version = db.prepare('SELECT version FROM web_push_schema WHERE singleton=1').get() as { version: number } | undefined;
  if (!version || !Number.isSafeInteger(version.version) || version.version !== SCHEMA_VERSION) fail('web_push_schema_unsupported');
  const expectedTables = expectedTableSql();
  const required = [...expectedTables.keys()];
  if (required.some((name) => !exists(name))) fail('web_push_schema_corrupt');
  const tableSql = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN (?,?,?,?,?,?)")
    .all(...required) as Array<{ name: string; sql: string | null }>;
  if (tableSql.length !== required.length || tableSql.some((row) => typeof row.sql !== 'string' ||
      normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expectedTables.get(row.name) ?? ''))) {
    fail('web_push_schema_corrupt');
  }
  const expectedIndexes = new Map<string, string>([
    ['web_push_subscription_heads_page', 'CREATE INDEX web_push_subscription_heads_page ON web_push_subscription_heads(workspace_id,owner_id,privacy_epoch,device_id)'],
    ['web_push_subscriptions_key', 'CREATE INDEX web_push_subscriptions_key ON web_push_subscriptions(workspace_id,owner_id,privacy_epoch,key_id)'],
    ['web_push_commands_epoch', 'CREATE INDEX web_push_commands_epoch ON web_push_commands(workspace_id,owner_id,privacy_epoch,created_at)'],
  ]);
  const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('web_push_vapid_keys','web_push_vapid_heads','web_push_subscriptions','web_push_subscription_heads','web_push_commands') AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  if (indexes.length !== expectedIndexes.size || indexes.some((row) => normalizeSchemaSql(row.sql) !==
      normalizeSchemaSql(expectedIndexes.get(row.name) ?? ''))) fail('web_push_schema_corrupt');
  const triggerExpected = new Map<string, string>([
    ['web_push_vapid_keys_immutable_update', "before update on web_push_vapid_keys begin select raise(abort,'web_push_immutable')"],
    ['web_push_subscriptions_immutable_update', "before update on web_push_subscriptions begin select raise(abort,'web_push_immutable')"],
    ['web_push_commands_immutable_update', "before update on web_push_commands begin select raise(abort,'web_push_immutable')"],
    ['web_push_vapid_keys_erase_delete', "before delete on web_push_vapid_keys when coalesce(still_workspace_erase_authorized(old.workspace_id,old.owner_id,old.privacy_epoch),0)<>1 begin select raise(abort,'web_push_erase_required')"],
    ['web_push_subscriptions_erase_delete', "before delete on web_push_subscriptions when coalesce(still_workspace_erase_authorized(old.workspace_id,old.owner_id,old.privacy_epoch),0)<>1 begin select raise(abort,'web_push_erase_required')"],
    ['web_push_commands_erase_delete', "before delete on web_push_commands when coalesce(still_workspace_erase_authorized(old.workspace_id,old.owner_id,old.privacy_epoch),0)<>1 begin select raise(abort,'web_push_erase_required')"],
  ]);
  for (const [name, fragment] of triggerExpected) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined;
    if (!row || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(`CREATE TRIGGER ${name} ${fragment}; END`)) fail('web_push_schema_corrupt');
  }
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('web_push_vapid_keys','web_push_vapid_heads','web_push_subscriptions','web_push_subscription_heads','web_push_commands')")
    .all() as Array<{ name: string }>;
  if (triggers.length !== triggerExpected.size || triggers.some((row) => !triggerExpected.has(row.name))) fail('web_push_schema_corrupt');
}

function expectedTableSql(): Map<string, string> {
  return new Map([
    ['web_push_schema', 'CREATE TABLE web_push_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version>0)) STRICT'],
    ['web_push_vapid_keys', `CREATE TABLE web_push_vapid_keys(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),key_id TEXT NOT NULL,
      public_key TEXT NOT NULL CHECK(length(public_key)=87),key_version INTEGER NOT NULL CHECK(key_version=1),
      nonce BLOB NOT NULL CHECK(length(nonce)=12),tag BLOB NOT NULL CHECK(length(tag)=16),ciphertext BLOB NOT NULL CHECK(length(ciphertext)=32),
      created_at INTEGER NOT NULL CHECK(created_at>0),PRIMARY KEY(workspace_id,key_id),UNIQUE(workspace_id,owner_id,privacy_epoch,key_id)) STRICT`],
    ['web_push_vapid_heads', `CREATE TABLE web_push_vapid_heads(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),key_id TEXT NOT NULL,updated_at INTEGER NOT NULL CHECK(updated_at>0),
      FOREIGN KEY(workspace_id,owner_id,privacy_epoch,key_id) REFERENCES web_push_vapid_keys(workspace_id,owner_id,privacy_epoch,key_id)) STRICT`],
    ['web_push_subscriptions', `CREATE TABLE web_push_subscriptions(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),device_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>0),
      key_id TEXT NOT NULL,key_version INTEGER NOT NULL CHECK(key_version=1),nonce BLOB NOT NULL CHECK(length(nonce)=12),
      tag BLOB NOT NULL CHECK(length(tag)=16),ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0 AND length(ciphertext)<=32768),
      created_at INTEGER NOT NULL CHECK(created_at>0),PRIMARY KEY(workspace_id,device_id,generation),
      FOREIGN KEY(workspace_id,owner_id,privacy_epoch,key_id) REFERENCES web_push_vapid_keys(workspace_id,owner_id,privacy_epoch,key_id)) STRICT`],
    ['web_push_subscription_heads', `CREATE TABLE web_push_subscription_heads(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),device_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>0),status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      key_id TEXT NOT NULL,updated_at INTEGER NOT NULL CHECK(updated_at>0),PRIMARY KEY(workspace_id,device_id)) STRICT`],
    ['web_push_commands', `CREATE TABLE web_push_commands(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),command_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('provision','rotate','register','revoke')),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64),result_json TEXT NOT NULL,created_at INTEGER NOT NULL CHECK(created_at>0),
      PRIMARY KEY(workspace_id,command_id)) STRICT`],
  ]);
}

function normalizeSchemaSql(sql: string): string {
  return sql.toLowerCase().replace(/[\s"`\[\]]+/g, '').replace(/;+$/g, '');
}

function assertRegistryBudget(context: OwnedTransactionContext, budgetBytes: number): void {
  const tables = [
    { name: 'web_push_vapid_keys', text: ['workspace_id', 'owner_id', 'key_id', 'public_key'], blobs: ['nonce', 'tag', 'ciphertext'] },
    { name: 'web_push_vapid_heads', text: ['workspace_id', 'owner_id', 'key_id'], blobs: [] },
    { name: 'web_push_subscriptions', text: ['workspace_id', 'owner_id', 'device_id', 'key_id'], blobs: ['nonce', 'tag', 'ciphertext'] },
    { name: 'web_push_subscription_heads', text: ['workspace_id', 'owner_id', 'device_id', 'status', 'key_id'], blobs: [] },
    { name: 'web_push_commands', text: ['workspace_id', 'owner_id', 'command_id', 'operation', 'request_digest', 'result_json'], blobs: [] },
  ] as const;
  let usedBytes = 0;
  for (const table of tables) {
    const payload = [...table.text.map((column) => `length(CAST(${column} AS BLOB))`), ...table.blobs.map((column) => `length(${column})`),
      String(ROW_METADATA_RESERVE_BYTES)].join('+');
    const row = context.db.prepare(`SELECT COALESCE(SUM(${payload}),0) AS bytes FROM ${table.name}
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch) as { bytes: number };
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isSafeInteger(usedBytes + row.bytes)) fail('web_push_registry_corrupt');
    usedBytes += row.bytes;
  }
  const active = context.db.prepare(`SELECT COUNT(*) AS count FROM web_push_subscription_heads
    WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND status='active'`)
    .get(context.workspaceId, context.ownerId, context.privacyEpoch) as { count: number };
  const revokeReserve = active.count * ACTIVE_DEVICE_REVOKE_RESERVE_BYTES;
  if (!Number.isSafeInteger(active.count) || active.count < 0 || !Number.isSafeInteger(revokeReserve) ||
      !Number.isSafeInteger(usedBytes + revokeReserve) || usedBytes + revokeReserve > budgetBytes) {
    fail('web_push_storage_budget_exceeded');
  }
}
