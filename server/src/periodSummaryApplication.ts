import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import { currentCommandTicket, type CommandJournal } from './commandJournal.js';
import type { SnapshotCommitParticipant, SnapshotCommitParticipantInput } from './workspaceStore.js';
import { DocumentLineage, type CapturedDocumentDestination } from './documentLineage.js';
import { registerWorkspaceEraseDeleteGuard } from './workspaceErase.js';

const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAN_TTL_MS = 5 * 60_000;
type PeriodSummaryApplicationPlan = Readonly<{ planId: string; jobId: string; kind: 'period_summary_application';
  period: 'daily' | 'weekly' | 'monthly' | 'yearly'; timeZone: string; interval: Readonly<{ start: string; end: string }>;
  preparedAt: string; destinationPath: string; destinationExists: boolean; destinationRevision?: number; expiresAt: string }>;
type PeriodSummaryApplicationPreview = Readonly<{ planId: string; jobId: string; period: 'daily' | 'weekly' | 'monthly' | 'yearly';
  timeZone: string; interval: Readonly<{ start: string; end: string }>; preparedAt: string; markdown: string; sourceReferences: readonly string[] }>;
type PeriodSummaryApplicationReceipt = Readonly<{ kind: 'applied'; jobId: string; path: string; documentRevision: number; appliedAt: string }>;

export type PeriodSummaryApplicationCapture = Readonly<{
  jobId: string;
  requestSha256: string;
  resultSha256: string;
  period: 'daily' | 'weekly' | 'monthly' | 'yearly';
  timeZone: string;
  interval: Readonly<{ start: string; end: string }>;
  preparedAt: string;
  /** Exact private result bytes, revalidated against the canonical ledger at snapshot commit. */
  resultText: string;
  markdown: string;
  sourceReferences: readonly string[];
}>;

export type PeriodSummaryApplicationWrite = Readonly<{
  path: string;
  content: string;
  expectedRevision?: number;
}>;

type Scope = Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>;
type PlanState = Readonly<{ publicPlan: PeriodSummaryApplicationPlan; destination: CapturedDocumentDestination;
  capture: PeriodSummaryApplicationCapture; expiresAtMs: number }>;
type PendingProof = Readonly<{ scope: Scope; commandId: string; capability: string; jobId: string; requestSha256: string;
  resultSha256: string; resultText: string; sourceReferences: readonly string[]; capture: PeriodSummaryApplicationCapture;
  destination: CapturedDocumentDestination; content: string; expectedRevision?: number }>;
type ReceiptRow = Readonly<{ workspace_id: string; owner_id: string; privacy_epoch: number; job_id: string; command_id: string;
  request_sha256: string; result_sha256: string; destination_path: string; document_id: string; document_revision: number; applied_at: number }>;

/** Private same-owner application gateway and snapshot participant for period summaries. */
export class PeriodSummaryApplicationRuntime {
  readonly #identity: Scope;
  readonly #plans = new Map<string, PlanState>();
  readonly #pending = new AsyncLocalStorage<PendingProof>();
  readonly #lineageParticipant: SnapshotCommitParticipant<object>;

  constructor(private readonly kernel: DurableKernel, private readonly actorSessionToken: string, private readonly lineage: DocumentLineage,
    private readonly journal: CommandJournal) {
    const identity = kernel.getOwnedIdentity(actorSessionToken);
    this.#identity = Object.freeze({ workspaceId: identity.workspaceId, ownerId: identity.ownerId, privacyEpoch: identity.privacyEpoch });
    kernel.withTrustedDatabaseTransaction((db) => initializeSchema(db));
    this.#lineageParticipant = lineage.createSnapshotCommitParticipant<object>();
  }

  async readReceipt(jobId: string, requestSha256: string, resultSha256?: string): Promise<PeriodSummaryApplicationReceipt | undefined> {
    validateJob(jobId); validateHash(requestSha256);
    if (resultSha256 !== undefined) validateHash(resultSha256);
    return this.kernel.withOwnedTransaction(this.actorSessionToken, this.#identity.privacyEpoch, (context) => {
      this.#assertScope(context);
      const row = this.#receiptRow(context, jobId);
      if (!row) return undefined;
      if (row.request_sha256 !== requestSha256 || resultSha256 !== undefined && row.result_sha256 !== resultSha256) {
        throw new Error('period_summary_application_receipt_mismatch');
      }
      return projectReceipt(row);
    });
  }

  async readReceiptByJob(jobId: string): Promise<PeriodSummaryApplicationReceipt | undefined> {
    validateJob(jobId);
    return this.kernel.withOwnedTransaction(this.actorSessionToken, this.#identity.privacyEpoch, (context) => {
      this.#assertScope(context);
      const row = this.#receiptRow(context, jobId);
      return row ? projectReceipt(row) : undefined;
    });
  }

  async prepare(capture: PeriodSummaryApplicationCapture): Promise<PeriodSummaryApplicationPlan | PeriodSummaryApplicationReceipt> {
    const ownedCapture = captureApplicationCapture(capture);
    this.#prunePlans(Date.now());
    const existing = await this.readReceipt(ownedCapture.jobId, ownedCapture.requestSha256, ownedCapture.resultSha256);
    this.#assertCurrentScope();
    if (existing) return existing;
    const path = `memory/summaries/${ownedCapture.period}/${ownedCapture.interval.start}.md`;
    const destination = this.kernel.withOwnedTransaction(this.actorSessionToken, this.#identity.privacyEpoch,
      (context) => this.lineage.captureDestination(context, path));
    this.#assertCurrentScope();
    const planId = randomUUID();
    const preparedAtMs = Date.now();
    const expiresAt = new Date(preparedAtMs + PLAN_TTL_MS).toISOString();
    const plan: PeriodSummaryApplicationPlan = Object.freeze({ planId, jobId: ownedCapture.jobId, kind: 'period_summary_application',
      period: ownedCapture.period, timeZone: ownedCapture.timeZone, interval: Object.freeze({ ...ownedCapture.interval }), preparedAt: ownedCapture.preparedAt,
      destinationPath: path, destinationExists: destination.documentId !== null,
      ...(destination.expectedRevision !== null ? { destinationRevision: destination.expectedRevision } : {}),
      expiresAt });
    for (const [oldId, oldPlan] of this.#plans) if (oldPlan.publicPlan.jobId === ownedCapture.jobId) this.#plans.delete(oldId);
    this.#plans.set(planId, Object.freeze({ publicPlan: plan, destination, capture: ownedCapture, expiresAtMs: Date.parse(expiresAt) }));
    return plan;
  }

  readPreview(input: Readonly<{ planId: string; jobId: string }>): PeriodSummaryApplicationPreview | undefined {
    this.#assertCurrentScope();
    if (!isExactDataRecord(input, ['planId', 'jobId'])) return undefined;
    const planId = input.planId;
    const jobId = input.jobId;
    this.#prunePlans(Date.now());
    if (!UUID_V4.test(planId) || !UUID_V4.test(jobId)) return undefined;
    const state = this.#plans.get(planId);
    if (!state || state.publicPlan.jobId !== jobId || Date.now() >= state.expiresAtMs) return undefined;
    const preview = Object.freeze({ planId: state.publicPlan.planId, jobId: state.publicPlan.jobId, period: state.capture.period,
      timeZone: state.capture.timeZone, interval: Object.freeze({ ...state.capture.interval }), preparedAt: state.capture.preparedAt,
      markdown: state.capture.markdown, sourceReferences: Object.freeze([...state.capture.sourceReferences]) });
    this.#assertCurrentScope();
    return preview;
  }

  cancel(planId: string): void { if (UUID_V4.test(planId)) this.#plans.delete(planId); }

  invalidateJobs(jobIds: readonly string[]): void {
    const ids = new Set(jobIds);
    for (const [planId, plan] of this.#plans) if (ids.has(plan.publicPlan.jobId)) this.#plans.delete(planId);
  }

  invalidateAll(): void { this.#plans.clear(); }

  async apply(input: Readonly<{ planId: string; jobId: string; requestSha256: string; resultSha256: string;
    writeDocument: (write: PeriodSummaryApplicationWrite) => Promise<number> }>): Promise<PeriodSummaryApplicationReceipt> {
    const ownedInput = captureApplicationApplyInput(input);
    this.#prunePlans(Date.now());
    validateJob(ownedInput.jobId); validateHash(ownedInput.requestSha256); validateHash(ownedInput.resultSha256);
    if (!UUID_V4.test(ownedInput.planId)) throw new Error('period_summary_application_plan_stale');

    // A committed receipt wins before checking current document CAS, so a lost ACK or later user edit never reapplies.
    const prior = await this.readReceipt(ownedInput.jobId, ownedInput.requestSha256, ownedInput.resultSha256);
    this.#assertCurrentScope();
    if (prior) return prior;
    const plan = this.#plans.get(ownedInput.planId);
    if (!plan || plan.publicPlan.jobId !== ownedInput.jobId || plan.capture.requestSha256 !== ownedInput.requestSha256 ||
        plan.capture.resultSha256 !== ownedInput.resultSha256 || Date.now() >= plan.expiresAtMs) {
      this.#plans.delete(ownedInput.planId);
      throw new Error('period_summary_application_plan_stale');
    }
    const ticket = currentCommandTicket();
    if (!ticket || ticket.workspaceId !== this.#identity.workspaceId || ticket.ownerId !== this.#identity.ownerId ||
        ticket.privacyEpoch !== this.#identity.privacyEpoch || ticket.kind !== 'assistant.periodsummary.application.apply') {
      throw new Error('period_summary_application_command_untrusted');
    }
    this.kernel.withOwnedTransaction(this.actorSessionToken, this.#identity.privacyEpoch, (context) => {
      this.#assertScope(context);
      this.lineage.assertDestination(context, plan.destination);
    });
    this.#plans.delete(ownedInput.planId);
    const proof: PendingProof = Object.freeze({ scope: this.#identity, commandId: ticket.idempotencyKey, capability: ticket.capability,
      jobId: ownedInput.jobId, requestSha256: ownedInput.requestSha256, resultSha256: ownedInput.resultSha256, resultText: plan.capture.resultText,
      sourceReferences: plan.capture.sourceReferences, capture: plan.capture, destination: plan.destination,
      content: plan.capture.markdown, ...(plan.destination.expectedRevision !== null ? { expectedRevision: plan.destination.expectedRevision } : {}) });
    await this.#pending.run(proof, async () => { await ownedInput.writeDocument(Object.freeze({ path: plan.destination.path, content: plan.capture.markdown,
      ...(proof.expectedRevision !== undefined ? { expectedRevision: proof.expectedRevision } : {}) })); });
    this.#assertCurrentScope();
    const receipt = await this.readReceipt(ownedInput.jobId, ownedInput.requestSha256, ownedInput.resultSha256);
    if (!receipt) throw new Error('period_summary_application_receipt_missing');
    return receipt;
  }

  createSnapshotCommitParticipant<TState extends object>(): SnapshotCommitParticipant<TState> {
    return Object.freeze({
      beforeCommit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>) => {
        const proof = this.#pending.getStore();
        if (proof) this.#validateApplicationProof(context, input as SnapshotCommitParticipantInput<Record<string, unknown>>, proof);
        this.#lineageParticipant.beforeCommit?.(context, input as SnapshotCommitParticipantInput<object>);
      },
      commit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>) => {
        this.#lineageParticipant.commit(context, input as SnapshotCommitParticipantInput<object>);
        const proof = this.#pending.getStore();
        if (!proof) return;
        const ticket = currentCommandTicket();
        if (!ticket) throw new Error('period_summary_application_command_untrusted');
        this.journal.assertPeriodSummaryApplicationWithinTransaction(context, ticket);
        const destination = this.lineage.readCommittedDestinationWithinTransaction(context, proof.destination.path, input.nextRevision);
        if (destination.documentId === null || destination.expectedRevision === null) throw new Error('period_summary_application_resulting_identity_missing');
        const result = context.db.prepare(`INSERT INTO period_summary_application_receipts
          (workspace_id,owner_id,privacy_epoch,job_id,command_id,request_sha256,result_sha256,destination_path,document_id,document_revision,applied_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, proof.jobId,
          proof.commandId, proof.requestSha256, proof.resultSha256, destination.path, destination.documentId, destination.expectedRevision, context.now);
        if (result.changes !== 1) throw new Error('period_summary_application_receipt_write_failed');
        return Object.freeze([]);
      },
    });
  }

  #validateApplicationProof(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<object>, proof: PendingProof): void {
    this.#assertScope(context);
    const ticket = currentCommandTicket();
    if (!ticket || ticket.idempotencyKey !== proof.commandId || ticket.capability !== proof.capability ||
        ticket.workspaceId !== this.#identity.workspaceId || ticket.ownerId !== this.#identity.ownerId ||
        ticket.privacyEpoch !== this.#identity.privacyEpoch || input.commandId !== proof.commandId ||
        input.nextRevision !== context.revision + 1) throw new Error('period_summary_application_proof_mismatch');
    this.journal.assertPeriodSummaryApplicationWithinTransaction(context, ticket);
    this.lineage.assertDestination(context, proof.destination);
    const previousSnapshot = input.previousSnapshot as Record<string, unknown>;
    const nextSnapshot = input.nextSnapshot as Record<string, unknown>;
    assertCanonicalSummaryResult(previousSnapshot, proof);
    const previous = snapshotDocuments(previousSnapshot);
    const next = snapshotDocuments(nextSnapshot);
    if (JSON.stringify(withoutDocuments(previousSnapshot)) !== JSON.stringify(withoutDocuments(nextSnapshot))) {
      throw new Error('period_summary_application_non_document_state_changed');
    }
    const prior = previous.find((document) => document.path === proof.destination.path);
    const resulting = next.find((document) => document.path === proof.destination.path);
    const priorIndex = previous.findIndex((document) => document.path === proof.destination.path);
    const resultingIndex = next.findIndex((document) => document.path === proof.destination.path);
    const expectedRevision = proof.destination.expectedRevision ?? 0;
    if (!resulting || resulting.content !== proof.content || resulting.revision !== expectedRevision + 1 ||
        proof.destination.documentId === null !== !prior || prior && (prior.revision !== expectedRevision ||
          resultingIndex !== priorIndex || JSON.stringify(withoutDocumentWriteFields(prior)) !== JSON.stringify(withoutDocumentWriteFields(resulting))) ||
        !prior && resultingIndex !== next.length - 1) {
      throw new Error('period_summary_application_snapshot_mismatch');
    }
    const priorOtherDocuments = previous.filter((document) => document.path !== proof.destination.path).map((document) => JSON.stringify(document));
    const nextOtherDocuments = next.filter((document) => document.path !== proof.destination.path).map((document) => JSON.stringify(document));
    if (JSON.stringify(priorOtherDocuments) !== JSON.stringify(nextOtherDocuments)) {
      throw new Error('period_summary_application_unrelated_documents_changed');
    }
  }

  #assertScope(context: OwnedTransactionContext): void {
    this.kernel.assertOwnedTransactionContext(context);
    if (context.workspaceId !== this.#identity.workspaceId || context.ownerId !== this.#identity.ownerId ||
        context.privacyEpoch !== this.#identity.privacyEpoch || !context.db.inTransaction) throw new Error('period_summary_application_scope_rejected');
  }

  #assertCurrentScope(): void {
    const identity = this.kernel.getOwnedIdentity(this.actorSessionToken);
    if (identity.workspaceId !== this.#identity.workspaceId || identity.ownerId !== this.#identity.ownerId ||
        identity.privacyEpoch !== this.#identity.privacyEpoch) throw new Error('period_summary_application_scope_rejected');
  }

  #prunePlans(at: number): void {
    for (const [planId, plan] of this.#plans) if (at >= plan.expiresAtMs) this.#plans.delete(planId);
  }

  #receiptRow(context: OwnedTransactionContext, jobId: string): ReceiptRow | undefined {
    const row = context.db.prepare(`SELECT workspace_id,owner_id,privacy_epoch,job_id,command_id,request_sha256,result_sha256,
      destination_path,document_id,document_revision,applied_at FROM period_summary_application_receipts
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
      .get(this.#identity.workspaceId, this.#identity.ownerId, this.#identity.privacyEpoch, jobId) as ReceiptRow | undefined;
    if (row) validateReceiptRow(row, this.#identity);
    return row;
  }
}

function initializeSchema(db: import('better-sqlite3').Database): void {
  registerWorkspaceEraseDeleteGuard(db);
  const existing = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='period_summary_application_receipts'`).get();
  if (!existing) db.exec(`CREATE TABLE period_summary_application_receipts(
    workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),job_id TEXT NOT NULL,
    command_id TEXT NOT NULL,request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),result_sha256 TEXT NOT NULL CHECK(length(result_sha256)=64),
    destination_path TEXT NOT NULL,document_id TEXT NOT NULL,document_revision INTEGER NOT NULL CHECK(document_revision>0),applied_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,owner_id,privacy_epoch,job_id)) STRICT;
    CREATE TRIGGER period_summary_application_receipts_no_delete BEFORE DELETE ON period_summary_application_receipts
      WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
      BEGIN SELECT RAISE(ABORT,'period_summary_application_receipts_are_durable'); END;
    CREATE TRIGGER period_summary_application_receipts_no_update BEFORE UPDATE ON period_summary_application_receipts
      BEGIN SELECT RAISE(ABORT,'period_summary_application_receipts_are_immutable'); END;`);
  const columns = db.pragma('table_info(period_summary_application_receipts)') as { name: string; type: string; notnull: number; pk: number }[];
  const expected = [['workspace_id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 2], ['privacy_epoch', 'INTEGER', 1, 3], ['job_id', 'TEXT', 1, 4],
    ['command_id', 'TEXT', 1, 0], ['request_sha256', 'TEXT', 1, 0], ['result_sha256', 'TEXT', 1, 0], ['destination_path', 'TEXT', 1, 0],
    ['document_id', 'TEXT', 1, 0], ['document_revision', 'INTEGER', 1, 0], ['applied_at', 'INTEGER', 1, 0]] as const;
  const strict = db.prepare(`SELECT strict FROM pragma_table_list WHERE name='period_summary_application_receipts'`).get() as { strict?: number } | undefined;
  if (columns.length !== expected.length || columns.some((column, index) => {
    const shape = expected[index]!;
    return column.name !== shape[0] || column.type.toUpperCase() !== shape[1] || column.notnull !== shape[2] || column.pk !== shape[3];
  }) || strict?.strict !== 1) throw new Error('period_summary_application_schema_invalid');
  const triggers = db.prepare(`SELECT name,sql,tbl_name FROM sqlite_master WHERE type='trigger' AND tbl_name='period_summary_application_receipts'`)
    .all() as { name: string; sql: string; tbl_name: string }[];
  const actual = new Map(triggers.map((row) => [row.name, row]));
  const deleteTrigger = actual.get('period_summary_application_receipts_no_delete');
  const updateTrigger = actual.get('period_summary_application_receipts_no_update');
  if (triggers.length !== 2 || !deleteTrigger || deleteTrigger.tbl_name !== 'period_summary_application_receipts' ||
      normalizeSql(deleteTrigger.sql) !== normalizeSql(`CREATE TRIGGER period_summary_application_receipts_no_delete BEFORE DELETE ON period_summary_application_receipts
        WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
        BEGIN SELECT RAISE(ABORT,'period_summary_application_receipts_are_durable'); END`) ||
      !updateTrigger || updateTrigger.tbl_name !== 'period_summary_application_receipts' ||
      normalizeSql(updateTrigger.sql) !== normalizeSql(`CREATE TRIGGER period_summary_application_receipts_no_update BEFORE UPDATE ON period_summary_application_receipts
        BEGIN SELECT RAISE(ABORT,'period_summary_application_receipts_are_immutable'); END`)) {
    throw new Error('period_summary_application_schema_invalid');
  }
}

function normalizeSql(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, ' '); }

function snapshotDocuments(snapshot: unknown): readonly { path: string; content: string; revision: number }[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Array.isArray((snapshot as { documents?: unknown }).documents)) {
    throw new Error('period_summary_application_snapshot_invalid');
  }
  const seen = new Set<string>();
  return (snapshot as { documents: unknown[] }).documents.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('period_summary_application_snapshot_invalid');
    const document = value as { path?: unknown; content?: unknown; revision?: unknown; updatedAt?: unknown };
    if (typeof document.path !== 'string' || typeof document.content !== 'string' || !Number.isSafeInteger(document.revision) ||
        (document.revision as number) < 1 || typeof document.updatedAt !== 'string') throw new Error('period_summary_application_snapshot_invalid');
    if (seen.has(document.path)) throw new Error('period_summary_application_snapshot_invalid');
    seen.add(document.path);
    return value as { path: string; content: string; revision: number };
  });
}

function assertCanonicalSummaryResult(snapshot: Record<string, unknown>, proof: PendingProof): void {
  const rawLedger = snapshot.openRouterBatchLedger;
  if (!isPlainRecord(rawLedger) || rawLedger.version !== 1 || !Array.isArray(rawLedger.jobs)) throw new Error('period_summary_application_result_changed');
  const jobs = rawLedger.jobs as unknown[];
  if (jobs.some((candidate) => !isPlainRecord(candidate) || typeof candidate.id !== 'string')) {
    throw new Error('period_summary_application_result_changed');
  }
  const jobMatches = jobs.filter((candidate) => isPlainRecord(candidate) && candidate.id === proof.jobId);
  if (jobMatches.length !== 1 || jobs.some((candidate, index) => isPlainRecord(candidate) && jobs.slice(0, index)
    .some((earlier) => isPlainRecord(earlier) && earlier.id === candidate.id))) throw new Error('period_summary_application_result_changed');
  const job = jobMatches[0] as Record<string, unknown>;
  const binding = isPlainRecord(job.summaryBinding) ? job.summaryBinding : undefined;
  if (job.kind !== 'period_summary' || job.status !== 'completed' || Object.hasOwn(job, 'sourceRemoved') ||
      job.customId !== proof.jobId || job.operation !== 'period_summary' || job.requestProfileVersion !== 6 ||
      job.inputPolicyVersion !== 2 || job.outputPolicyVersion !== 2 || !binding ||
      job.requestSha256 !== proof.requestSha256 || job.resultSha256 !== proof.resultSha256 || job.resultText !== proof.resultText ||
      binding.period !== proof.capture.period || binding.timeZone !== proof.capture.timeZone ||
      !isPlainRecord(binding.localInterval) || binding.localInterval.start !== proof.capture.interval.start || binding.localInterval.end !== proof.capture.interval.end ||
      binding.preparedAt !== proof.capture.preparedAt || typeof job.requestBody !== 'string' ||
      createHash('sha256').update(job.requestBody, 'utf8').digest('hex') !== proof.requestSha256 || typeof job.resultText !== 'string' ||
      createHash('sha256').update(job.resultText, 'utf8').digest('hex') !== proof.resultSha256) {
    throw new Error('period_summary_application_result_changed');
  }
  let parsed: { markdown: string; sourceReferences: string[] };
  try {
    const value = JSON.parse(job.resultText) as unknown;
    if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== 'markdown,sourceReferences' || typeof value.markdown !== 'string' ||
        !validUnicodeText(value.markdown) || !value.markdown.trim() || !Array.isArray(value.sourceReferences) || !Array.isArray(binding.sources)) throw new Error('invalid_result');
    const sources = binding.sources.filter(isPlainRecord);
    const sourceIds = new Set(sources.map((source) => source.id).filter((id): id is string => typeof id === 'string'));
    if (value.sourceReferences.some((id) => typeof id !== 'string' || !sourceIds.has(id)) ||
        new Set(value.sourceReferences).size !== value.sourceReferences.length) throw new Error('invalid_result');
    parsed = { markdown: value.markdown, sourceReferences: value.sourceReferences as string[] };
  } catch { throw new Error('period_summary_application_result_changed'); }
  const labels = new Map<string, string>();
  for (const source of binding.sources.filter(isPlainRecord)) {
    if (typeof source.id !== 'string' || typeof source.kind !== 'string' || typeof source.effectiveAt !== 'string') {
      throw new Error('period_summary_application_result_changed');
    }
    labels.set(source.id, `${source.kind.replaceAll('_', ' ')} · ${source.effectiveAt.slice(0, 10)}`);
  }
  const expectedReferences = parsed.sourceReferences.map((id) => labels.get(id) ?? 'Saved source');
  if (parsed.markdown !== proof.content || JSON.stringify(expectedReferences) !== JSON.stringify(proof.sourceReferences)) {
    throw new Error('period_summary_application_result_changed');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function withoutDocuments(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('period_summary_application_snapshot_invalid');
  const copy = { ...(snapshot as Record<string, unknown>) };
  if (!Array.isArray(copy.documents)) throw new Error('period_summary_application_snapshot_invalid');
  delete copy.documents;
  return copy;
}

function withoutDocumentWriteFields(document: { path: string; content: string; revision: number }): unknown {
  const copy = { ...(document as unknown as Record<string, unknown>) };
  delete copy.content;
  delete copy.revision;
  delete copy.updatedAt;
  return copy;
}

function validateCapture(value: PeriodSummaryApplicationCapture): void {
  if (!value || typeof value !== 'object' || !UUID_V4.test(value.jobId) || !SHA256.test(value.requestSha256) || !SHA256.test(value.resultSha256) ||
      !['daily', 'weekly', 'monthly', 'yearly'].includes(value.period) || typeof value.timeZone !== 'string' ||
      !Number.isFinite(Date.parse(value.preparedAt)) || !value.interval || typeof value.interval.start !== 'string' || typeof value.interval.end !== 'string' ||
      typeof value.resultText !== 'string' || !value.resultText || !validUnicodeText(value.resultText) ||
      createHash('sha256').update(value.resultText, 'utf8').digest('hex') !== value.resultSha256 ||
      typeof value.markdown !== 'string' || !value.markdown.trim() || !Array.isArray(value.sourceReferences) ||
      !value.sourceReferences.every((label) => typeof label === 'string' && label.length > 0)) throw new Error('period_summary_application_capture_invalid');
}
function validUnicodeText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function captureApplicationCapture(input: PeriodSummaryApplicationCapture): PeriodSummaryApplicationCapture {
  if (!isExactDataRecord(input, ['jobId', 'requestSha256', 'resultSha256', 'period', 'timeZone', 'interval', 'preparedAt', 'resultText', 'markdown', 'sourceReferences'])) {
    throw new Error('period_summary_application_capture_invalid');
  }
  const interval = input.interval;
  if (!isExactDataRecord(interval, ['start', 'end']) || !Array.isArray(input.sourceReferences) ||
      Object.getPrototypeOf(input.sourceReferences) !== Array.prototype || Reflect.ownKeys(input.sourceReferences).length !== input.sourceReferences.length + 1) {
    throw new Error('period_summary_application_capture_invalid');
  }
  const refs: string[] = [];
  for (let index = 0; index < input.sourceReferences.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input.sourceReferences, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
      throw new Error('period_summary_application_capture_invalid');
    }
    refs.push(descriptor.value);
  }
  const owned = Object.freeze({ jobId: input.jobId, requestSha256: input.requestSha256, resultSha256: input.resultSha256,
    period: input.period, timeZone: input.timeZone, interval: Object.freeze({ start: interval.start, end: interval.end }),
    preparedAt: input.preparedAt, resultText: input.resultText, markdown: input.markdown, sourceReferences: Object.freeze(refs) });
  validateCapture(owned);
  return owned;
}
function captureApplicationApplyInput(input: unknown): Readonly<{ planId: string; jobId: string; requestSha256: string; resultSha256: string;
  writeDocument: (write: PeriodSummaryApplicationWrite) => Promise<number> }> {
  const keys = ['planId', 'jobId', 'requestSha256', 'resultSha256', 'writeDocument'];
  if (!isExactDataRecord(input, keys)) throw new Error('period_summary_application_plan_stale');
  const value = input as Record<string, unknown>;
  if (typeof value.writeDocument !== 'function' || typeof value.planId !== 'string' || typeof value.jobId !== 'string' ||
      typeof value.requestSha256 !== 'string' || typeof value.resultSha256 !== 'string') throw new Error('period_summary_application_plan_stale');
  return Object.freeze({ planId: value.planId, jobId: value.jobId, requestSha256: value.requestSha256,
    resultSha256: value.resultSha256, writeDocument: value.writeDocument as (write: PeriodSummaryApplicationWrite) => Promise<number> });
}
function isExactDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    return (prototype === Object.prototype || prototype === null) && ownKeys.length === keys.length &&
      ownKeys.every((key) => typeof key === 'string' && keys.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
  } catch { return false; }
}
function validateJob(value: string): void { if (!UUID_V4.test(value)) throw new Error('period_summary_application_job_invalid'); }
function validateHash(value: string): void { if (!SHA256.test(value)) throw new Error('period_summary_application_hash_invalid'); }
function projectReceipt(row: ReceiptRow): PeriodSummaryApplicationReceipt {
  return Object.freeze({ kind: 'applied', jobId: row.job_id, path: row.destination_path, documentRevision: row.document_revision,
    appliedAt: new Date(row.applied_at).toISOString() });
}

function validateReceiptRow(row: ReceiptRow, scope: Scope): void {
  if (!row || row.workspace_id !== scope.workspaceId || row.owner_id !== scope.ownerId || row.privacy_epoch !== scope.privacyEpoch ||
      !UUID_V4.test(row.job_id) || !UUID_V4.test(row.command_id) || !SHA256.test(row.request_sha256) || !SHA256.test(row.result_sha256) ||
      !/^memory\/summaries\/(daily|weekly|monthly|yearly)\/\d{4}-\d{2}-\d{2}\.md$/.test(row.destination_path) ||
      !UUID_V4.test(row.document_id) || !Number.isSafeInteger(row.document_revision) || row.document_revision < 1 ||
      !Number.isSafeInteger(row.applied_at) || row.applied_at < 0) throw new Error('period_summary_application_receipt_invalid');
  const day = row.destination_path.match(/\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
  if (!day || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) {
    throw new Error('period_summary_application_receipt_invalid');
  }
}
