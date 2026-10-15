import { createHash, randomUUID } from 'node:crypto';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import type { SnapshotCommitParticipant, SnapshotCommitParticipantInput } from './workspaceStore.js';

export const DOCUMENT_LINEAGE_SCHEMA_VERSION = 2;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENT_PATH_MAX_BYTES = 1024;

type Scope = Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>;
type DocumentView = Readonly<{ path: string; revision: number; contentSha256: string }>;
type HeadRow = Readonly<{ path: string; document_id: string | null; document_revision: number | null;
  content_sha256: string | null; absence_generation: number }>;
type ScopeRow = Readonly<{ snapshot_revision: number }>;
type ReplacementProof = Readonly<{ path: string; documentId: string; revision: number }>;
type SnapshotProof = Readonly<{ fingerprint: string; replacements: ReadonlyMap<string, ReplacementProof> }>;

export type CapturedDocumentDestination = Readonly<{
  workspaceId: string;
  ownerId: string;
  privacyEpoch: number;
  path: string;
  documentId: string | null;
  expectedRevision: number | null;
  expectedAbsenceGeneration: number | null;
}>;

/**
 * Private durable identities for document incarnations. The actor session is fixed at construction;
 * callers must use an active context from that actor's owned transaction.
 */
export class DocumentLineage {
  readonly #identity: Scope;
  readonly #replacementProofs = new WeakMap<OwnedTransactionContext, Map<string, ReplacementProof>>();
  readonly #snapshotProofs = new WeakMap<OwnedTransactionContext, SnapshotProof>();

  constructor(private readonly kernel: DurableKernel, private readonly actorSessionToken: string) {
    const identity = kernel.getOwnedIdentity(actorSessionToken);
    if (!UUID_V4.test(identity.workspaceId) || !UUID_V4.test(identity.ownerId) ||
        !Number.isSafeInteger(identity.privacyEpoch) || identity.privacyEpoch < 0) throw new Error('document_lineage_identity_invalid');
    this.#identity = Object.freeze({ workspaceId: identity.workspaceId, ownerId: identity.ownerId, privacyEpoch: identity.privacyEpoch });
    kernel.withTrustedDatabaseTransaction((db) => initializeSchema(db));
  }

  /**
   * Captures the exact current destination and its incarnation or absence generation. An uninitialized
   * scope is backfilled only from the exact snapshot read in this same owned transaction.
   */
  captureDestination(context: OwnedTransactionContext, path: string): CapturedDocumentDestination {
    this.#assertContext(context);
    validateDocumentPath(path);
    const owned = this.kernel.readOwnedSnapshotWithinTransaction(context);
    const documents = projectDocuments(owned.snapshot);
    this.#ensureInitialized(context, documents);
    const head = this.#head(context, path);
    const document = documents.find((item) => item.path === path);
    if (document) {
      if (!head || head.document_id === null || head.document_revision !== document.revision) throw new Error('document_lineage_head_invalid');
      return Object.freeze({ ...this.#identity, path, documentId: head.document_id, expectedRevision: document.revision,
        expectedAbsenceGeneration: null });
    }
    if (head?.document_id !== null && head !== undefined) throw new Error('document_lineage_head_invalid');
    const generation = head?.absence_generation ?? 0;
    if (!head) this.#insertHead(context, path, null, null, null, generation);
    return Object.freeze({ ...this.#identity, path, documentId: null, expectedRevision: null, expectedAbsenceGeneration: generation });
  }

  /** Revalidates a captured destination against the exact current snapshot and private head. */
  assertDestination(context: OwnedTransactionContext, captured: CapturedDocumentDestination): void {
    this.#assertContext(context);
    validateCapturedDestination(captured);
    if (captured.workspaceId !== this.#identity.workspaceId || captured.ownerId !== this.#identity.ownerId ||
        captured.privacyEpoch !== this.#identity.privacyEpoch) throw new Error('document_lineage_destination_stale');
    const owned = this.kernel.readOwnedSnapshotWithinTransaction(context);
    const documents = projectDocuments(owned.snapshot);
    const scope = this.#requireInitializedScope(context, documents);
    const row = this.#head(context, captured.path);
    const current = documents.find((item) => item.path === captured.path);
    if (captured.documentId !== null) {
      if (!current || !row || row.document_id !== captured.documentId || row.document_revision !== captured.expectedRevision ||
          current.revision !== captured.expectedRevision || captured.expectedAbsenceGeneration !== null) {
        throw new Error('document_lineage_destination_stale');
      }
    } else {
      if (current || (row && row.document_id !== null) || captured.expectedRevision !== null ||
          captured.expectedAbsenceGeneration === null || (row?.absence_generation ?? 0) !== captured.expectedAbsenceGeneration) {
        throw new Error('document_lineage_destination_stale');
      }
    }
    if (scope.snapshot_revision !== context.revision) throw new Error('document_lineage_snapshot_stale');
  }

  /**
   * Records a one-context identity proof for a human-authorized replacement. Call only from a
   * purpose-specific trusted precommit hook in the same composed save transaction, before this
   * participant's beforeCommit hook. This method attests identity and CAS only; it grants no UI/HTTP
   * replacement authority and cannot be carried across transactions or an awaited store.save().
   */
  authorizeReplacementWithinTransaction(context: OwnedTransactionContext, path: string,
    expectedDocumentId: string, expectedRevision: number): void {
    this.#assertContext(context);
    validateDocumentPath(path);
    if (!UUID_V4.test(expectedDocumentId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('document_lineage_replacement_invalid');
    }
    const owned = this.kernel.readOwnedSnapshotWithinTransaction(context);
    const documents = projectDocuments(owned.snapshot);
    this.#requireInitializedScope(context, documents);
    const document = documents.find((item) => item.path === path);
    const head = this.#head(context, path);
    if (!document || !head || head.document_id !== expectedDocumentId || document.revision !== expectedRevision ||
        head.document_revision !== expectedRevision) throw new Error('document_lineage_replacement_stale');
    let proofs = this.#replacementProofs.get(context);
    if (!proofs) { proofs = new Map(); this.#replacementProofs.set(context, proofs); }
    if (proofs.has(path)) throw new Error('document_lineage_replacement_duplicate');
    proofs.set(path, Object.freeze({ path, documentId: expectedDocumentId, revision: expectedRevision }));
  }

  /** Snapshot participant: all head changes commit atomically with the exact workspace revision. */
  createSnapshotCommitParticipant<TState extends object>(): SnapshotCommitParticipant<TState> {
    return Object.freeze({
      beforeCommit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>) => this.#beforeCommit(context, input),
      commit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>) => this.#commit(context, input),
    });
  }

  #beforeCommit<TState extends object>(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>): void {
    this.#assertContext(context);
    if (!Number.isSafeInteger(input.nextRevision) || input.nextRevision !== context.revision + 1) throw new Error('document_lineage_snapshot_revision_invalid');
    const owned = this.kernel.readOwnedSnapshotWithinTransaction(context);
    const previous = projectDocuments(owned.snapshot);
    const suppliedPrevious = projectDocuments(input.previousSnapshot);
    const next = projectDocuments(input.nextSnapshot);
    const previousRow = context.db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(context.workspaceId) as { snapshot_json: string } | undefined;
    if (!previousRow || previousRow.snapshot_json !== canonicalJson(input.previousSnapshot) ||
        canonicalJson(owned.snapshot) !== canonicalJson(input.previousSnapshot) ||
        canonicalJson(previous) !== canonicalJson(suppliedPrevious)) throw new Error('document_lineage_previous_snapshot_mismatch');
    const scope = this.#scopeRow(context);
    if (scope) {
      if (scope.snapshot_revision !== context.revision) throw new Error('document_lineage_snapshot_stale');
      this.#validateHeadsAgainstSnapshot(context, previous);
    } else if (this.#hasAnyHead(context)) {
      throw new Error('document_lineage_scope_missing');
    }
    const proofs = new Map(this.#replacementProofs.get(context) ?? []);
    const previousByPath = new Map(previous.map((document) => [document.path, document]));
    const nextByPath = new Map(next.map((document) => [document.path, document]));
    for (const proof of proofs.values()) {
      const before = previousByPath.get(proof.path);
      const after = nextByPath.get(proof.path);
      const head = this.#head(context, proof.path);
      if (!before || !after || before.revision !== proof.revision || !head || head.document_id !== proof.documentId ||
          head.document_revision !== proof.revision) throw new Error('document_lineage_replacement_proof_mismatch');
    }
    const fingerprint = snapshotFingerprint(input);
    this.#snapshotProofs.set(context, Object.freeze({ fingerprint, replacements: proofs }));
  }

  #commit<TState extends object>(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>): void {
    this.#assertContext(context);
    const proof = this.#snapshotProofs.get(context);
    if (!proof || proof.fingerprint !== snapshotFingerprint(input)) throw new Error('document_lineage_snapshot_proof_missing');
    const row = context.db.prepare(`SELECT id,owner_id,revision,privacy_epoch,snapshot_json FROM workspaces WHERE id=?`)
      .get(context.workspaceId) as { id: string; owner_id: string; revision: number; privacy_epoch: number; snapshot_json: string } | undefined;
    if (!row || row.id !== this.#identity.workspaceId || row.owner_id !== this.#identity.ownerId ||
        row.privacy_epoch !== this.#identity.privacyEpoch || row.revision !== input.nextRevision ||
        row.snapshot_json !== canonicalJson(input.nextSnapshot)) {
      throw new Error('document_lineage_committed_snapshot_mismatch');
    }
    const previous = projectDocuments(input.previousSnapshot);
    const next = projectDocuments(input.nextSnapshot);
    let scope = this.#scopeRow(context);
    if (!scope) {
      if (this.#hasAnyHead(context)) throw new Error('document_lineage_scope_missing');
      for (const document of previous) this.#insertHead(context, document.path, randomUUID(), document.revision, document.contentSha256, 0);
      scope = Object.freeze({ snapshot_revision: context.revision });
      this.#insertScope(context, context.revision);
    }
    if (scope.snapshot_revision !== context.revision) throw new Error('document_lineage_snapshot_stale');
    this.#validateHeadsAgainstSnapshot(context, previous);
    this.#applyDocumentDiff(context, previous, next, proof.replacements);
    const changed = context.db.prepare(`UPDATE document_lineage_scopes SET snapshot_revision=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND snapshot_revision=?`)
      .run(input.nextRevision, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, context.revision);
    if (changed.changes !== 1) throw new Error('document_lineage_snapshot_race');
    this.#snapshotProofs.delete(context);
    this.#replacementProofs.delete(context);
  }

  #applyDocumentDiff(context: OwnedTransactionContext, previous: readonly DocumentView[], next: readonly DocumentView[],
    replacements: ReadonlyMap<string, ReplacementProof>): void {
    const before = new Map(previous.map((document) => [document.path, document]));
    const after = new Map(next.map((document) => [document.path, document]));
    for (const [path, document] of before) {
      const nextDocument = after.get(path);
      const head = this.#head(context, path);
      if (!head || !head.document_id || head.document_revision !== document.revision) throw new Error('document_lineage_head_invalid');
      if (!nextDocument) {
        this.#updateHead(context, path, null, null, null, head.absence_generation + 1);
      } else if (replacements.has(path)) {
        this.#updateHead(context, path, randomUUID(), nextDocument.revision, nextDocument.contentSha256, head.absence_generation + 1);
      } else {
        if (nextDocument.revision < document.revision) throw new Error('document_lineage_revision_regression');
        if (nextDocument.revision === document.revision && nextDocument.contentSha256 !== document.contentSha256) {
          throw new Error('document_lineage_revision_reused');
        }
        this.#updateHead(context, path, head.document_id, nextDocument.revision, nextDocument.contentSha256, head.absence_generation);
      }
    }
    for (const [path, document] of after) {
      if (before.has(path)) continue;
      const head = this.#head(context, path);
      if (head?.document_id !== null && head !== undefined) throw new Error('document_lineage_head_invalid');
      const generation = head?.absence_generation ?? 0;
      if (head) this.#updateHead(context, path, randomUUID(), document.revision, document.contentSha256, generation);
      else this.#insertHead(context, path, randomUUID(), document.revision, document.contentSha256, generation);
    }
  }

  #ensureInitialized(context: OwnedTransactionContext, documents: readonly DocumentView[]): void {
    const scope = this.#scopeRow(context);
    if (scope) {
      if (scope.snapshot_revision !== context.revision) throw new Error('document_lineage_snapshot_stale');
      this.#validateHeadsAgainstSnapshot(context, documents);
      return;
    }
    if (this.#hasAnyHead(context)) throw new Error('document_lineage_scope_missing');
    for (const document of documents) this.#insertHead(context, document.path, randomUUID(), document.revision, document.contentSha256, 0);
    this.#insertScope(context, context.revision);
  }

  #requireInitializedScope(context: OwnedTransactionContext, documents: readonly DocumentView[]): ScopeRow {
    const scope = this.#scopeRow(context);
    if (!scope || scope.snapshot_revision !== context.revision) throw new Error('document_lineage_scope_uninitialized');
    this.#validateHeadsAgainstSnapshot(context, documents);
    return scope;
  }

  #validateHeadsAgainstSnapshot(context: OwnedTransactionContext, documents: readonly DocumentView[]): void {
    const rows = this.#headRows(context);
    const byPath = new Map(documents.map((document) => [document.path, document]));
    const found = new Set<string>();
    for (const row of rows) {
      validateDocumentPath(row.path);
      if (found.has(row.path) || !Number.isSafeInteger(row.absence_generation) || row.absence_generation < 0) {
        throw new Error('document_lineage_head_invalid');
      }
      found.add(row.path);
      const document = byPath.get(row.path);
      if (document) {
        if (!row.document_id || !UUID_V4.test(row.document_id) || row.document_revision !== document.revision ||
            row.content_sha256 !== document.contentSha256) throw new Error('document_lineage_head_invalid');
      } else if (row.document_id !== null || row.document_revision !== null || row.content_sha256 !== null) throw new Error('document_lineage_head_invalid');
    }
    for (const document of documents) if (!found.has(document.path)) throw new Error('document_lineage_head_missing');
  }

  #scopeRow(context: OwnedTransactionContext): ScopeRow | undefined {
    return context.db.prepare(`SELECT snapshot_revision FROM document_lineage_scopes
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
      .get(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as ScopeRow | undefined;
  }

  #head(context: OwnedTransactionContext, path: string): HeadRow | undefined {
    return context.db.prepare(`SELECT path,document_id,document_revision,content_sha256,absence_generation FROM document_lineage_heads
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND path=?`)
      .get(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, path) as HeadRow | undefined;
  }

  #headRows(context: OwnedTransactionContext): HeadRow[] {
    return context.db.prepare(`SELECT path,document_id,document_revision,content_sha256,absence_generation FROM document_lineage_heads
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? ORDER BY path`)
      .all(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch) as HeadRow[];
  }

  #hasAnyHead(context: OwnedTransactionContext): boolean {
    return Boolean(context.db.prepare(`SELECT 1 AS found FROM document_lineage_heads
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? LIMIT 1`)
      .get(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch));
  }

  #insertScope(context: OwnedTransactionContext, revision: number): void {
    context.db.prepare(`INSERT INTO document_lineage_scopes(workspace_id,owner_id,privacy_epoch,snapshot_revision) VALUES(?,?,?,?)`)
      .run(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, revision);
  }

  #insertHead(context: OwnedTransactionContext, path: string, documentId: string | null, revision: number | null,
    contentSha256: string | null, generation: number): void {
    context.db.prepare(`INSERT INTO document_lineage_heads(workspace_id,owner_id,privacy_epoch,path,document_id,document_revision,content_sha256,absence_generation)
      VALUES(?,?,?,?,?,?,?,?)`).run(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch,
      path, documentId, revision, contentSha256, generation);
  }

  #updateHead(context: OwnedTransactionContext, path: string, documentId: string | null, revision: number | null,
    contentSha256: string | null, generation: number): void {
    const result = context.db.prepare(`UPDATE document_lineage_heads SET document_id=?,document_revision=?,content_sha256=?,absence_generation=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND path=?`)
      .run(documentId, revision, contentSha256, generation, this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, path);
    if (result.changes !== 1) throw new Error('document_lineage_head_missing');
  }

  #assertContext(context: OwnedTransactionContext): void {
    context.assertActive();
    if (context.workspaceId !== this.#identity.workspaceId || context.ownerId !== this.#identity.ownerId ||
        context.privacyEpoch !== this.#identity.privacyEpoch || !context.db.inTransaction) throw new Error('document_lineage_context_rejected');
  }
}

function initializeSchema(db: import('better-sqlite3').Database): void {
  const names = new Set(['document_lineage_schema', 'document_lineage_scopes', 'document_lineage_heads']);
  const existing = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'document_lineage_*'`).all() as { name: string }[];
  const existingNames = new Set(existing.map((row) => row.name));
  if (existingNames.size === 0) {
    db.exec(`CREATE TABLE document_lineage_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL) STRICT;
      INSERT INTO document_lineage_schema(singleton,version) VALUES(1,${DOCUMENT_LINEAGE_SCHEMA_VERSION});
      CREATE TABLE document_lineage_scopes(workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
        snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision>=0),PRIMARY KEY(workspace_id,owner_id,privacy_epoch)) STRICT;
      CREATE TABLE document_lineage_heads(workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
        path TEXT NOT NULL,document_id TEXT,document_revision INTEGER,content_sha256 TEXT,absence_generation INTEGER NOT NULL CHECK(absence_generation>=0),
        PRIMARY KEY(workspace_id,owner_id,privacy_epoch,path),
        CHECK((document_id IS NULL AND document_revision IS NULL AND content_sha256 IS NULL) OR
          (document_id IS NOT NULL AND document_revision IS NOT NULL AND document_revision>0 AND content_sha256 IS NOT NULL AND length(content_sha256)=64))) STRICT;
      CREATE TRIGGER document_lineage_heads_no_delete BEFORE DELETE ON document_lineage_heads
        BEGIN SELECT RAISE(ABORT,'document_lineage_tombstones_are_durable'); END;
      CREATE TRIGGER document_lineage_scopes_no_delete BEFORE DELETE ON document_lineage_scopes
        BEGIN SELECT RAISE(ABORT,'document_lineage_scopes_are_durable'); END;`);
  }
  if (existingNames.size !== 0 && existingNames.size !== names.size) throw new Error('document_lineage_schema_invalid');
  assertSchema(db);
}

function assertSchema(db: import('better-sqlite3').Database): void {
  const expected: Readonly<Record<string, readonly (readonly [string, string, number, number])[]>> = {
    document_lineage_schema: [['singleton', 'INTEGER', 0, 1], ['version', 'INTEGER', 1, 0]],
    document_lineage_scopes: [['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3], ['snapshot_revision', 'INTEGER', 1, 0]],
    document_lineage_heads: [['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3],
      ['path', 'TEXT', 1, 4], ['document_id', 'TEXT', 0, 0], ['document_revision', 'INTEGER', 0, 0],
      ['content_sha256', 'TEXT', 0, 0], ['absence_generation', 'INTEGER', 1, 0]],
  };
  for (const [table, columns] of Object.entries(expected)) {
    const actual = db.pragma(`table_info(${table})`) as { name: string; type: string; notnull: number; pk: number }[];
    const strict = db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table) as { strict?: number } | undefined;
    if (actual.length !== columns.length || actual.some((column, index) => {
      const [name, type, notnull, primaryKey] = columns[index]!;
      return column.name !== name || column.type.toUpperCase() !== type || column.notnull !== notnull || column.pk !== primaryKey;
    }) || strict?.strict !== 1) throw new Error(`document_lineage_schema_invalid:${table}`);
  }
  const schemaRows = db.prepare('SELECT singleton,version FROM document_lineage_schema').all() as { singleton: number; version: number }[];
  if (schemaRows.length !== 1 || schemaRows[0]?.singleton !== 1 || schemaRows[0]?.version !== DOCUMENT_LINEAGE_SCHEMA_VERSION) {
    throw new Error('document_lineage_schema_unsupported');
  }
  for (const table of ['document_lineage_scopes', 'document_lineage_heads']) {
    const index = db.prepare('SELECT 1 AS found FROM pragma_index_list(?) WHERE "unique"=1').get(table);
    if (!index) throw new Error(`document_lineage_schema_invalid:${table}_index`);
  }
  for (const [trigger, table] of [['document_lineage_heads_no_delete', 'document_lineage_heads'],
    ['document_lineage_scopes_no_delete', 'document_lineage_scopes']] as const) {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?`).get(trigger, table) as { sql: string } | undefined;
    if (!row || !/BEFORE\s+DELETE/i.test(row.sql) || !/RAISE\s*\(\s*ABORT/i.test(row.sql)) throw new Error(`document_lineage_schema_invalid:${trigger}`);
  }
}

function projectDocuments(snapshot: unknown): readonly DocumentView[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('document_lineage_snapshot_invalid');
  const rawDocuments = (snapshot as { documents?: unknown }).documents;
  if (rawDocuments === undefined) return Object.freeze([]);
  if (!Array.isArray(rawDocuments)) throw new Error('document_lineage_snapshot_invalid');
  const documents: DocumentView[] = [];
  const paths = new Set<string>();
  for (const raw of rawDocuments) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('document_lineage_snapshot_invalid');
    const document = raw as { path?: unknown; revision?: unknown; content?: unknown; updatedAt?: unknown; selectionPriority?: unknown };
    if (typeof document.path !== 'string' || typeof document.content !== 'string' || typeof document.updatedAt !== 'string' ||
        !hasWellFormedUnicode(document.content) ||
        !Number.isSafeInteger(document.revision) || (document.revision as number) < 1 ||
        document.selectionPriority !== undefined && ![0, 1, 2].includes(document.selectionPriority as number)) {
      throw new Error('document_lineage_snapshot_invalid');
    }
    validateDocumentPath(document.path);
    if (paths.has(document.path)) throw new Error('document_lineage_duplicate_path');
    paths.add(document.path);
    documents.push(Object.freeze({ path: document.path, revision: document.revision as number,
      contentSha256: createHash('sha256').update(document.content, 'utf8').digest('hex') }));
  }
  return Object.freeze(documents);
}

/** Mirrors safeRelativeMarkdownPath in src/privacy/eraseAdapter.shared.ts, the storage path predicate. */
function validateDocumentPath(value: string): void {
  if (value.length === 0 || !hasWellFormedUnicode(value) || Buffer.byteLength(value, 'utf8') > DOCUMENT_PATH_MAX_BYTES || !value.endsWith('.md') ||
      value.includes('\\') || value.startsWith('/') || value.endsWith('/') || /[:?#%<>|"*\u0000-\u001f]/.test(value) ||
      value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment))) {
    throw new Error('document_lineage_path_invalid');
  }
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validateCapturedDestination(value: CapturedDocumentDestination): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('document_lineage_destination_invalid');
  validateDocumentPath(value.path);
  if (!UUID_V4.test(value.workspaceId) || !UUID_V4.test(value.ownerId) || !Number.isSafeInteger(value.privacyEpoch) || value.privacyEpoch < 0 ||
      value.documentId !== null && !UUID_V4.test(value.documentId) ||
      value.expectedRevision !== null && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) ||
      value.expectedAbsenceGeneration !== null && (!Number.isSafeInteger(value.expectedAbsenceGeneration) || value.expectedAbsenceGeneration < 0) ||
      (value.documentId === null) !== (value.expectedRevision === null) ||
      (value.documentId === null) !== (value.expectedAbsenceGeneration !== null)) throw new Error('document_lineage_destination_invalid');
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonicalValue(value)); }

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return result;
  }
  throw new Error('document_lineage_snapshot_invalid');
}

function snapshotFingerprint<TState extends object>(input: SnapshotCommitParticipantInput<TState>): string {
  return canonicalJson({ previous: input.previousSnapshot, next: input.nextSnapshot, nextRevision: input.nextRevision });
}
