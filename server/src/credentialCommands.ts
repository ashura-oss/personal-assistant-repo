import { createHash } from 'node:crypto';
import type { DurableKernel, JsonValue, OwnedTransactionContext } from './kernel.js';
import { SecretVault, type VaultCredentialMetadata } from './vault.js';

const SCHEMA_VERSION = 1;
const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_KINDS = ['speech', 'openrouter'] as const;
const MAX_REQUEST_BYTES = 2 * 16 * 1024 * 1024 + 64 * 1024;

export type CredentialKind = typeof CREDENTIAL_KINDS[number];

export interface SafeCredentialMetadata {
  readonly configured: boolean;
  readonly generation: number;
}

export interface SafeCredentialMetadataSnapshot {
  readonly workspaceId: string;
  readonly privacyEpoch: number;
  readonly credentials: Readonly<Record<CredentialKind, SafeCredentialMetadata>>;
}

export type CredentialCommandInspection =
  | Readonly<{ status: 'finished'; metadata: SafeCredentialMetadataSnapshot }>
  | Readonly<{ status: 'inspect_required' }>
  | Readonly<{ status: 'claimed' }>;

export interface CredentialCommandServiceOptions {
  readonly now?: () => number;
  /** A synchronous, trusted in-process notification hook. Errors are contained after commit. */
  readonly onCredentialGenerationChanged?: (kind: CredentialKind, generation: number) => void;
}

interface ParsedPut {
  readonly expectedPrivacyEpoch: number;
  readonly expectedGenerations: Readonly<Partial<Record<CredentialKind, number>>>;
  readonly keys: Readonly<Partial<Record<CredentialKind, string>>>;
}

interface ParsedDelete {
  readonly expectedPrivacyEpoch: number;
  readonly expectedGenerations: Readonly<Partial<Record<CredentialKind, number>>>;
  readonly kinds: readonly CredentialKind[];
}

interface CommandRow {
  owner_id: string;
  privacy_epoch: number;
  command_kind: 'put' | 'delete';
  request_digest: string;
  status: 'finished' | 'claimed' | 'inspect_required';
  metadata_json: string | null;
}

function fail(message: string): never { throw new Error(message); }

function canonicalValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail('Credential command body must be canonical JSON.');
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return result;
  }
  return fail('Credential command body must contain only JSON values.');
}

function parseCanonicalBody(text: unknown): { value: Record<string, unknown>; text: string } {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) fail('Credential command body is invalid or too large.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('Credential command body is invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Credential command body must be a JSON object.');
  const clean = canonicalValue(parsed);
  const canonical = JSON.stringify(clean);
  if (canonical !== text) fail('Credential command body must use canonical JSON encoding.');
  return { value: parsed as Record<string, unknown>, text: canonical };
}

function digest(kind: 'put' | 'delete', canonicalBody: string): string {
  return createHash('sha256').update(`credential.${kind}\0${canonicalBody}`, 'utf8').digest('hex');
}

function validCommandId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !COMMAND_ID.test(value)) fail('Credential command id must be a UUIDv4.');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== [...expected].sort()[index])) fail(`${label} contains unsupported or missing fields.`);
}

function parseEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('Credential command privacy epoch is invalid.');
  return value as number;
}

function parseGenerationMap(value: unknown, allowedKinds: readonly CredentialKind[]): Partial<Record<CredentialKind, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected credential generations are invalid.');
  const source = value as Record<string, unknown>;
  const result: Partial<Record<CredentialKind, number>> = {};
  for (const key of Object.keys(source)) {
    if (!CREDENTIAL_KINDS.includes(key as CredentialKind) || !allowedKinds.includes(key as CredentialKind)) fail('Credential command scope is unsupported.');
    const generation = source[key];
    if (!Number.isSafeInteger(generation) || (generation as number) < 0) fail('Expected credential generation is invalid.');
    result[key as CredentialKind] = generation as number;
  }
  return result;
}

function parsePutBody(body: Record<string, unknown>): ParsedPut {
  exactKeys(body, ['expectedPrivacyEpoch', 'expectedGenerations', 'keys'], 'Credential update');
  const keysValue = body.keys;
  if (!keysValue || typeof keysValue !== 'object' || Array.isArray(keysValue)) fail('Credential update keys are invalid.');
  const keysSource = keysValue as Record<string, unknown>;
  const kinds = Object.keys(keysSource);
  if (kinds.length === 0) fail('Credential update must include at least one supported key.');
  const keys: Partial<Record<CredentialKind, string>> = {};
  for (const kind of kinds) {
    if (!CREDENTIAL_KINDS.includes(kind as CredentialKind)) fail('Credential update includes an unsupported provider key.');
    const secret = keysSource[kind];
    if (typeof secret !== 'string' || secret.length === 0 || Buffer.from(secret, 'utf8').toString('utf8') !== secret) {
      fail('Credential update contains an invalid provider key.');
    }
    keys[kind as CredentialKind] = secret;
  }
  const expectedGenerations = parseGenerationMap(body.expectedGenerations, kinds as CredentialKind[]);
  if (Object.keys(expectedGenerations).length !== kinds.length || kinds.some((kind) => !Object.hasOwn(expectedGenerations, kind as CredentialKind))) {
    fail('Expected generations must match the supplied provider keys.');
  }
  return Object.freeze({ expectedPrivacyEpoch: parseEpoch(body.expectedPrivacyEpoch),
    expectedGenerations: Object.freeze(expectedGenerations), keys: Object.freeze(keys) });
}

function parseDeleteBody(body: Record<string, unknown>): ParsedDelete {
  exactKeys(body, ['expectedPrivacyEpoch', 'expectedGenerations', 'kinds'], 'Credential deletion');
  if (!Array.isArray(body.kinds) || body.kinds.length === 0) fail('Credential deletion must include at least one supported provider.');
  const kinds: CredentialKind[] = [];
  for (const value of body.kinds) {
    if (typeof value !== 'string' || !CREDENTIAL_KINDS.includes(value as CredentialKind)) fail('Credential deletion scope is unsupported.');
    if (kinds.includes(value as CredentialKind)) fail('Credential deletion contains duplicate scopes.');
    kinds.push(value as CredentialKind);
  }
  const ordered = [...kinds].sort();
  if (kinds.some((kind, index) => kind !== ordered[index])) fail('Credential deletion scopes must be in canonical order.');
  const expectedGenerations = parseGenerationMap(body.expectedGenerations, kinds);
  if (Object.keys(expectedGenerations).length !== kinds.length || kinds.some((kind) => !Object.hasOwn(expectedGenerations, kind))) {
    fail('Expected generations must match the deletion scopes.');
  }
  return Object.freeze({ expectedPrivacyEpoch: parseEpoch(body.expectedPrivacyEpoch),
    expectedGenerations: Object.freeze(expectedGenerations), kinds: Object.freeze(kinds) });
}

function safeMetadata(context: OwnedTransactionContext, vault: SecretVault): SafeCredentialMetadataSnapshot {
  const speech = vault.getMetadataWithinTransaction(context, { type: 'workspace' }, 'azureSpeech');
  const openrouter = vault.getMetadataWithinTransaction(context, { type: 'workspace' }, 'openrouter');
  return Object.freeze({ workspaceId: context.workspaceId, privacyEpoch: context.privacyEpoch,
    credentials: Object.freeze({ speech: cleanMetadata(speech), openrouter: cleanMetadata(openrouter) }) });
}

function cleanMetadata(value: VaultCredentialMetadata): SafeCredentialMetadata {
  return Object.freeze({ configured: value.configured, generation: value.generation });
}

function decodeSafeMetadata(text: string): SafeCredentialMetadataSnapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('Saved credential command receipt is corrupt.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('Saved credential command receipt is corrupt.');
  const source = parsed as Record<string, unknown>;
  const credentials = source.credentials as Record<string, unknown> | undefined;
  const decodeKind = (value: unknown): SafeCredentialMetadata => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Saved credential command receipt is corrupt.');
    const row = value as Record<string, unknown>;
    if (typeof row.configured !== 'boolean' || !Number.isSafeInteger(row.generation) || (row.generation as number) < 0 || Object.keys(row).length !== 2) {
      return fail('Saved credential command receipt is corrupt.');
    }
    return Object.freeze({ configured: row.configured, generation: row.generation as number });
  };
  if (typeof source.workspaceId !== 'string' || !Number.isSafeInteger(source.privacyEpoch) || (source.privacyEpoch as number) < 0 ||
    !credentials || typeof credentials !== 'object' || Array.isArray(credentials) || Object.keys(credentials).length !== 2 ||
    Object.keys(source).length !== 3) return fail('Saved credential command receipt is corrupt.');
  return Object.freeze({ workspaceId: source.workspaceId, privacyEpoch: source.privacyEpoch as number,
    credentials: Object.freeze({ speech: decodeKind(credentials.speech), openrouter: decodeKind(credentials.openrouter) }) });
}

/** Synchronous, all-or-nothing BYOK updates and metadata-only receipts. */
export class ServerCredentialCommandService {
  private readonly now: () => number;

  constructor(private readonly kernel: DurableKernel, private readonly vault: SecretVault,
    private readonly options: CredentialCommandServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.kernel.withTrustedDatabaseTransaction((db) => {
      const versionTable = Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='credential_command_schema'").get());
      const commandTable = Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='credential_commands'").get());
      if (!versionTable && !commandTable) {
        db.exec(`
          CREATE TABLE credential_command_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version>0)) STRICT;
          CREATE TABLE credential_commands (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            command_id TEXT NOT NULL, owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL,
            command_kind TEXT NOT NULL CHECK(command_kind IN ('put','delete')),
            request_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('finished','claimed','inspect_required')),
            metadata_json TEXT, created_at INTEGER NOT NULL,
            PRIMARY KEY(workspace_id,command_id),
            CHECK ((status='finished' AND metadata_json IS NOT NULL) OR (status!='finished' AND metadata_json IS NULL))
          ) STRICT;
          CREATE INDEX credential_commands_epoch_idx ON credential_commands(workspace_id,privacy_epoch,created_at);
          INSERT INTO credential_command_schema(singleton,version) VALUES(1,${SCHEMA_VERSION});
        `);
        return;
      }
      if (!versionTable || !commandTable) throw new Error('Credential command schema is incomplete.');
      const version = db.prepare('SELECT version FROM credential_command_schema WHERE singleton=1').get() as { version: number } | undefined;
      if (!version || !Number.isSafeInteger(version.version) || version.version < 1 || version.version !== SCHEMA_VERSION) {
        throw new Error('Credential command schema version is unsupported.');
      }
    });
  }

  getMetadata(sessionToken: string): SafeCredentialMetadataSnapshot {
    const identity = this.kernel.getOwnedIdentity(sessionToken);
    return this.kernel.withOwnedTransaction(sessionToken, identity.privacyEpoch, (context) => safeMetadata(context, this.vault));
  }

  put(sessionToken: string, commandId: string, canonicalBody: string): SafeCredentialMetadataSnapshot {
    validCommandId(commandId);
    const parsed = parseCanonicalBody(canonicalBody);
    const request = parsePutBody(parsed.value);
    const requestDigest = digest('put', parsed.text);
    const result = this.commit(sessionToken, commandId, request.expectedPrivacyEpoch, 'put', requestDigest, (context) => {
      const changed: (readonly [CredentialKind, number])[] = [];
      for (const kind of CREDENTIAL_KINDS) {
        const secret = request.keys[kind];
        if (secret === undefined) continue;
        const expected = request.expectedGenerations[kind];
        if (expected === undefined) throw new Error('Expected credential generation is missing.');
        const metadata = this.vault.setSecretWithinTransaction(context, { type: 'workspace' }, purposeFor(kind), expected, secret);
        changed.push([kind, metadata.generation]);
      }
      return { metadata: safeMetadata(context, this.vault), changed };
    });
    this.notifyAfterCommit(result.changed);
    return result.metadata;
  }

  delete(sessionToken: string, commandId: string, canonicalBody: string): SafeCredentialMetadataSnapshot {
    validCommandId(commandId);
    const parsed = parseCanonicalBody(canonicalBody);
    const request = parseDeleteBody(parsed.value);
    const requestDigest = digest('delete', parsed.text);
    const result = this.commit(sessionToken, commandId, request.expectedPrivacyEpoch, 'delete', requestDigest, (context) => {
      const changed: (readonly [CredentialKind, number])[] = [];
      for (const kind of request.kinds) {
        const expected = request.expectedGenerations[kind];
        if (expected === undefined) throw new Error('Expected credential generation is missing.');
        const metadata = this.vault.deleteSecretWithinTransaction(context, { type: 'workspace' }, purposeFor(kind), expected);
        changed.push([kind, metadata.generation]);
      }
      return { metadata: safeMetadata(context, this.vault), changed };
    });
    this.notifyAfterCommit(result.changed);
    return result.metadata;
  }

  inspect(sessionToken: string, commandId: string): CredentialCommandInspection {
    validCommandId(commandId);
    const identity = this.kernel.getOwnedIdentity(sessionToken);
    return this.kernel.withOwnedTransaction(sessionToken, identity.privacyEpoch, (context) => {
      const row = context.db.prepare('SELECT owner_id,privacy_epoch,status,metadata_json FROM credential_commands WHERE workspace_id=? AND command_id=?')
        .get(context.workspaceId, commandId) as Pick<CommandRow, 'owner_id' | 'privacy_epoch' | 'status' | 'metadata_json'> | undefined;
      if (!row || row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch || row.status !== 'finished' || !row.metadata_json) {
        return Object.freeze({ status: 'inspect_required' as const });
      }
      return Object.freeze({ status: 'finished' as const, metadata: decodeSafeMetadata(row.metadata_json) });
    });
  }

  private commit(sessionToken: string, commandId: string, expectedPrivacyEpoch: number, kind: 'put' | 'delete', requestDigest: string,
    mutate: (context: OwnedTransactionContext) => { metadata: SafeCredentialMetadataSnapshot; changed: (readonly [CredentialKind, number])[] }):
    { metadata: SafeCredentialMetadataSnapshot; changed: (readonly [CredentialKind, number])[] } {
    return this.kernel.withOwnedTransaction(sessionToken, expectedPrivacyEpoch, (context) => {
      const prior = context.db.prepare('SELECT owner_id,privacy_epoch,command_kind,request_digest,status,metadata_json FROM credential_commands WHERE workspace_id=? AND command_id=?')
        .get(context.workspaceId, commandId) as CommandRow | undefined;
      if (prior) {
        if (prior.owner_id !== context.ownerId || prior.privacy_epoch !== context.privacyEpoch || prior.command_kind !== kind || prior.request_digest !== requestDigest) {
          throw new Error('This credential command id is already bound to different content or workspace state.');
        }
        if (prior.status !== 'finished' || !prior.metadata_json) throw new Error('This credential command requires inspection and cannot be resubmitted.');
        return { metadata: decodeSafeMetadata(prior.metadata_json), changed: [] };
      }
      const result = mutate(context);
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('Server clock is invalid.');
      const metadataJson = JSON.stringify(canonicalValue(result.metadata));
      context.db.prepare(`INSERT INTO credential_commands(workspace_id,command_id,owner_id,privacy_epoch,command_kind,request_digest,status,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,'finished',?,?)`)
        .run(context.workspaceId, commandId, context.ownerId, context.privacyEpoch, kind, requestDigest, metadataJson, now);
      return result;
    });
  }

  private notifyAfterCommit(changed: readonly (readonly [CredentialKind, number])[]): void {
    for (const [kind, generation] of changed) {
      try { this.options.onCredentialGenerationChanged?.(kind, generation); }
      catch { /* The credential commit and safe acknowledgement are already durable. */ }
    }
  }
}

function purposeFor(kind: CredentialKind): 'azureSpeech' | 'openrouter' {
  return kind === 'speech' ? 'azureSpeech' : 'openrouter';
}
