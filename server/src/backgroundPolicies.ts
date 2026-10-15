import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import type { AuthService } from './auth.js';
import { ensureBackgroundSchema } from './backgroundSchema.js';
import {
  canonicalBackgroundJson, parsePauseBackgroundPolicyEnvelope, parseRevokeBackgroundPolicyEnvelope,
  parseSaveBackgroundPolicyEnvelope, parseBackgroundPolicyDisplay, parseBackgroundPolicyReceipt,
  isBackgroundUuidV4, type BackgroundAccountDisplay, type BackgroundPolicyDisplay,
  type BackgroundPolicyReceipt, type BackgroundPolicySpecification, type ChangeBackgroundPolicyEnvelope,
  type SaveBackgroundPolicyEnvelope,
} from './backgroundContracts.js';
import { isValidAccountId } from './accountIds.js';

const SHA256 = /^[0-9a-f]{64}$/;
const ACCOUNT_PROVIDERS = new Set(['google', 'microsoft']);
const MAX_PRIVATE_BYTES = 16 * 1024 * 1024;

export interface ResolvedBackgroundAccount {
  readonly accountId: string;
  readonly provider: 'google' | 'microsoft';
  readonly identityKey: string;
  readonly connectionGeneration: number;
  readonly label: string;
  readonly connected: true;
}

export type ResolvedBackgroundBinding = Readonly<{
  accounts?: readonly ResolvedBackgroundAccount[];
  rule?: Readonly<{ ruleId: string; revision: number; specificationDigest: string }>;
  reminder?: Readonly<{ reminderId: string; revision: number; approvedDigest: string; dueAt: number; privacyEpoch: number;
    intentId: string; privacyMode: 'private' | 'full'; deviceSelection: 'all_current' | Readonly<{ subscriptionIds: readonly string[] }> }>;
}>;

/** Must resolve only exact current saved identities/revisions from the owned context. */
export interface BackgroundBindingResolver {
  resolve(context: OwnedTransactionContext, specification: BackgroundPolicySpecification): ResolvedBackgroundBinding;
  /** Captures currently eligible devices at the due instant; never called while saving policy authorization. */
  captureReminderTargets?(context: OwnedTransactionContext, specification: Extract<BackgroundPolicySpecification, { kind: 'approved_reminder_delivery' }>,
    reminder: NonNullable<ResolvedBackgroundBinding['reminder']>): readonly Readonly<{ subscriptionId: string; generation: number }>[];
}

export interface BackgroundPolicyStoreOptions {
  readonly kernel: DurableKernel;
  readonly auth: AuthService;
  readonly resolver: BackgroundBindingResolver;
  readonly clock?: () => number;
}

interface PolicyHeadRow {
  policy_id: string; current_revision: number; status: 'enabled' | 'paused' | 'revoked' | 'suspended';
  suspension: string | null; updated_at: number;
}
interface PolicyRevisionRow {
  revision: number; enabled: number; specification_json: string; binding_json: string; binding_digest: string;
  policy_digest: string; effective_from: number; created_at: number;
}
interface CommandRow { request_digest: string; receipt_json: string }

function fail(code: string): never { throw new Error(code); }
function digest(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function parseStored<T>(text: string, maximum = MAX_PRIVATE_BYTES): T {
  if (Buffer.byteLength(text, 'utf8') > maximum) return fail('background_storage_invalid');
  try { return JSON.parse(text) as T; } catch { return fail('background_storage_invalid'); }
}
function epoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return fail('background_clock_invalid');
  return value;
}
export function normalizeResolvedBackgroundBinding(value: unknown, specification: BackgroundPolicySpecification, privacyEpoch: number): ResolvedBackgroundBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('background_binding_invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['accounts', 'rule', 'reminder'].includes(key))) return fail('background_binding_invalid');
  const canonical = canonicalBackgroundJson(record, MAX_PRIVATE_BYTES);
  const parsed = JSON.parse(canonical) as ResolvedBackgroundBinding;
  const expected: { accountId: string; expectedConnectionGeneration: number }[] = [];
  if (specification.kind === 'account_sync' || specification.kind === 'proactive_draft') expected.push(...specification.accounts);
  if (specification.kind === 'period_summary') expected.push(...specification.sources.mailAccounts, ...specification.sources.calendarAccounts);
  const accounts = parsed.accounts ?? [];
    const expectedMap = new Map<string, number>();
  for (const selection of expected) {
    const previous = expectedMap.get(selection.accountId);
    if (previous !== undefined && previous !== selection.expectedConnectionGeneration) return fail('background_binding_invalid');
    expectedMap.set(selection.accountId, selection.expectedConnectionGeneration);
  }
  if (accounts.length !== expectedMap.size) return fail('background_binding_invalid');
  const actualMap = new Map<string, ResolvedBackgroundAccount>();
  for (const account of accounts) {
    if (!account || Object.keys(account as object).sort().join(',') !== 'accountId,connected,connectionGeneration,identityKey,label,provider' ||
        !isValidAccountId(account.accountId) || !ACCOUNT_PROVIDERS.has(account.provider) ||
        typeof account.identityKey !== 'string' || !SHA256.test(account.identityKey) ||
        account.identityKey !== digest(canonicalBackgroundJson({ accountId: account.accountId, provider: account.provider })) ||
        !Number.isSafeInteger(account.connectionGeneration) || account.connectionGeneration < 1 ||
        typeof account.label !== 'string' || Buffer.byteLength(account.label, 'utf8') > 1024 ||
        /[\u0000-\u001f\u007f]/.test(account.label) || account.connected !== true || actualMap.has(account.accountId)) return fail('background_binding_invalid');
    if (expectedMap.get(account.accountId) !== account.connectionGeneration) return fail('background_binding_changed');
    actualMap.set(account.accountId, account);
  }
  if (actualMap.size !== expectedMap.size) return fail('background_binding_invalid');
  if (specification.kind === 'proactive_draft') {
    const rule = parsed.rule;
    if (!rule || Object.keys(rule as object).sort().join(',') !== 'revision,ruleId,specificationDigest' || rule.ruleId !== specification.ruleId ||
        rule.revision !== specification.expectedRuleRevision || !SHA256.test(rule.specificationDigest)) return fail('background_binding_changed');
  } else if (parsed.rule !== undefined) return fail('background_binding_invalid');
  if (specification.kind === 'approved_reminder_delivery') {
    const reminder = parsed.reminder;
    if (!reminder || Object.keys(reminder as object).sort().join(',') !== 'approvedDigest,deviceSelection,dueAt,intentId,privacyEpoch,privacyMode,reminderId,revision' ||
        reminder.reminderId !== specification.reminderId || reminder.revision !== specification.expectedReminderRevision ||
        !SHA256.test(reminder.approvedDigest) || !Number.isSafeInteger(reminder.dueAt) || reminder.dueAt < 0 ||
        reminder.privacyEpoch !== privacyEpoch || typeof reminder.intentId !== 'string' || reminder.intentId.length === 0 ||
        Buffer.byteLength(reminder.intentId, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(reminder.intentId) ||
        (reminder.privacyMode !== 'private' && reminder.privacyMode !== 'full')) return fail('background_binding_changed');
    if (reminder.deviceSelection === 'all_current') {
      if (specification.devices !== 'all_current') return fail('background_binding_changed');
    } else {
      const selection = reminder.deviceSelection;
      if (!selection || Object.keys(selection as object).join(',') !== 'subscriptionIds' || !Array.isArray(selection.subscriptionIds) ||
          selection.subscriptionIds.some((id) => typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(id)) ||
          new Set(selection.subscriptionIds).size !== selection.subscriptionIds.length || specification.devices === 'all_current' ||
          canonicalBackgroundJson([...selection.subscriptionIds].sort()) !== canonicalBackgroundJson([...specification.devices.subscriptionIds].sort())) return fail('background_binding_changed');
    }
  } else if (parsed.reminder !== undefined) return fail('background_binding_invalid');
  return Object.freeze({ ...(expectedMap.size ? { accounts: Object.freeze([...actualMap.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)).map((item) => Object.freeze({ ...item }))) } : {}),
    ...(parsed.rule ? { rule: Object.freeze({ ...parsed.rule }) } : {}), ...(parsed.reminder ? { reminder: Object.freeze({ ...parsed.reminder,
      deviceSelection: parsed.reminder.deviceSelection === 'all_current' ? 'all_current' : Object.freeze({ subscriptionIds: Object.freeze([...parsed.reminder.deviceSelection.subscriptionIds].sort()) }) }) } : {}) });
}

export function backgroundBindingAuthority(binding: ResolvedBackgroundBinding): unknown {
  return Object.freeze({
    ...(binding.accounts ? { accounts: binding.accounts.map(({ accountId, provider, identityKey, connectionGeneration }) => ({ accountId, provider, identityKey, connectionGeneration })) } : {}),
    ...(binding.rule ? { rule: binding.rule } : {}),
    ...(binding.reminder ? { reminder: binding.reminder } : {}),
  });
}
function projection(row: PolicyHeadRow, revision: PolicyRevisionRow, context: OwnedTransactionContext): BackgroundPolicyDisplay {
  if (row.current_revision !== revision.revision || !Number.isSafeInteger(revision.revision) || revision.revision < 1) return fail('background_storage_invalid');
  const rawSpec = parseStored<unknown>(revision.specification_json);
  const specProbe = parseBackgroundPolicyDisplay({ schemaVersion: 1, policyId: row.policy_id, revision: revision.revision,
    status: row.status, enabled: revision.enabled === 1, specification: rawSpec, accounts: [], effectiveFrom: revision.effective_from,
    updatedAt: row.updated_at, ...(row.suspension ? { suspension: row.suspension } : {}) });
  const rawBinding = parseStored<ResolvedBackgroundBinding>(revision.binding_json);
  const binding = normalizeResolvedBackgroundBinding(rawBinding, specProbe.specification, context.privacyEpoch);
  if (canonicalBackgroundJson(binding, MAX_PRIVATE_BYTES) !== canonicalBackgroundJson(rawBinding, MAX_PRIVATE_BYTES)) return fail('background_storage_invalid');
  if (digest(canonicalBackgroundJson(backgroundBindingAuthority(binding), MAX_PRIVATE_BYTES)) !== revision.binding_digest) return fail('background_storage_invalid');
  return parseBackgroundPolicyDisplay({ schemaVersion: 1, policyId: row.policy_id, revision: revision.revision, status: row.status,
    enabled: revision.enabled === 1, specification: specProbe.specification,
    accounts: Object.freeze((binding.accounts ?? []).map((account): BackgroundAccountDisplay => Object.freeze({ accountId: account.accountId,
      provider: account.provider, label: account.label, connectionGeneration: account.connectionGeneration, connected: account.connected }))),
    ...(row.suspension ? { suspension: row.suspension } : {}), effectiveFrom: revision.effective_from, updatedAt: row.updated_at });
}

export class BackgroundPolicyStore {
  readonly #kernel: DurableKernel;
  readonly #auth: AuthService;
  readonly #resolver: BackgroundBindingResolver;
  readonly #clock: () => number;

  constructor(options: BackgroundPolicyStoreOptions) {
    if (!options || !options.kernel || !options.auth || !options.resolver || typeof options.resolver.resolve !== 'function' ||
        options.resolver.resolve.constructor?.name === 'AsyncFunction' ||
        (options.resolver.captureReminderTargets && options.resolver.captureReminderTargets.constructor?.name === 'AsyncFunction')) {
      throw new TypeError('background_policy_store_invalid');
    }
    this.#kernel = options.kernel;
    this.#auth = options.auth;
    this.#resolver = options.resolver;
    this.#clock = options.clock ?? Date.now;
  }

  /** Pass the authenticated browser's private kernel admission token for each human-consent mutation. */
  save(admissionSessionToken: string, raw: unknown): BackgroundPolicyReceipt {
    if (typeof admissionSessionToken !== 'string' || !admissionSessionToken) return fail('background_admission_required');
    const envelope = parseSaveBackgroundPolicyEnvelope(raw);
    return this.#kernel.withOwnedTransaction(admissionSessionToken, envelope.expectedPrivacyEpoch, (context) => {
      this.#auth.bindInitiatingSessionWithinTransaction(context, admissionSessionToken);
      ensureBackgroundSchema(context.db);
      const request = canonicalBackgroundJson({ operation: 'save', envelope });
      const replay = this.#findCommand(context, envelope.commandId, request, 'save', envelope.policyId, envelope.expectedPolicyRevision + 1,
        envelope.enabled ? 'enabled' : 'paused');
      if (replay) return replay;
      const head = this.#head(context.db, context, envelope.policyId);
      if ((head?.current_revision ?? 0) !== envelope.expectedPolicyRevision) return fail('background_policy_revision_stale');
      if (head?.status === 'revoked') return fail('background_policy_revoked');
      const binding = normalizeResolvedBackgroundBinding(this.#resolver.resolve(context, envelope.specification), envelope.specification, context.privacyEpoch);
      const bindingJson = canonicalBackgroundJson(binding, MAX_PRIVATE_BYTES);
      const specificationJson = canonicalBackgroundJson(envelope.specification);
      const revision = envelope.expectedPolicyRevision + 1;
      if (!Number.isSafeInteger(revision)) return fail('background_policy_revision_overflow');
      const now = epoch(this.#clock());
      const effectiveFrom = now;
      const bindingDigest = digest(canonicalBackgroundJson(backgroundBindingAuthority(binding), MAX_PRIVATE_BYTES));
      const policyDigest = digest(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
        privacyEpoch: context.privacyEpoch, policyId: envelope.policyId, revision, enabled: envelope.enabled,
        specification: JSON.parse(specificationJson), bindingDigest, effectiveFrom }));
      context.db.prepare(`INSERT INTO background_policy_revisions(workspace_id,owner_id,privacy_epoch,policy_id,revision,enabled,
        specification_json,binding_json,binding_digest,policy_digest,effective_from,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, envelope.policyId, revision, envelope.enabled ? 1 : 0,
          specificationJson, bindingJson, bindingDigest, policyDigest, effectiveFrom, now);
      const status = envelope.enabled ? 'enabled' : 'paused';
      if (head) context.db.prepare(`UPDATE background_policy_heads SET current_revision=?,status=?,suspension=NULL,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=?`)
        .run(revision, status, now, context.workspaceId, context.ownerId, context.privacyEpoch, envelope.policyId);
      else context.db.prepare(`INSERT INTO background_policy_heads(workspace_id,owner_id,privacy_epoch,policy_id,current_revision,status,suspension,updated_at)
        VALUES(?,?,?,?,?,?,NULL,?)`).run(context.workspaceId, context.ownerId, context.privacyEpoch, envelope.policyId, revision, status, now);
      return this.#saveReceipt(context, envelope.commandId, request, { schemaVersion: 1, commandId: envelope.commandId,
        operation: 'save', policyId: envelope.policyId, policyRevision: revision, status, effectiveFrom });
    });
  }

  pause(admissionSessionToken: string, raw: unknown): BackgroundPolicyReceipt { return this.#change(admissionSessionToken, raw, parsePauseBackgroundPolicyEnvelope, 'pause'); }
  revoke(admissionSessionToken: string, raw: unknown): BackgroundPolicyReceipt { return this.#change(admissionSessionToken, raw, parseRevokeBackgroundPolicyEnvelope, 'revoke'); }

  list(admissionSessionToken: string, input: { readonly expectedPrivacyEpoch: number; readonly afterPolicyId?: string; readonly limit?: number }): readonly BackgroundPolicyDisplay[] {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['expectedPrivacyEpoch', 'afterPolicyId', 'limit'].includes(key))) {
      throw new TypeError('background_policy_query_invalid');
    }
    const limit = input?.limit ?? 100;
    if (!Number.isSafeInteger(input?.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (input.afterPolicyId !== undefined && !isBackgroundUuidV4(input.afterPolicyId))) throw new TypeError('background_policy_query_invalid');
    return this.#kernel.withOwnedTransaction(admissionSessionToken, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const rows = context.db.prepare(`SELECT h.policy_id,h.current_revision,h.status,h.suspension,h.updated_at,
        r.revision,r.enabled,r.specification_json,r.binding_json,r.binding_digest,r.policy_digest,r.effective_from,r.created_at
        FROM background_policy_heads h JOIN background_policy_revisions r ON r.workspace_id=h.workspace_id AND r.owner_id=h.owner_id
          AND r.privacy_epoch=h.privacy_epoch AND r.policy_id=h.policy_id AND r.revision=h.current_revision
        WHERE h.workspace_id=? AND h.owner_id=? AND h.privacy_epoch=? AND (? IS NULL OR h.policy_id>?) ORDER BY h.policy_id LIMIT ?`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch, input.afterPolicyId ?? null, input.afterPolicyId ?? null, limit) as (PolicyHeadRow & PolicyRevisionRow)[];
      return Object.freeze(rows.map((row) => projection(row, row, context)));
    });
  }

  #change(admissionSessionToken: string, raw: unknown, parse: (value: unknown) => ChangeBackgroundPolicyEnvelope, operation: 'pause' | 'revoke'): BackgroundPolicyReceipt {
    if (typeof admissionSessionToken !== 'string' || !admissionSessionToken) return fail('background_admission_required');
    const envelope = parse(raw);
    return this.#kernel.withOwnedTransaction(admissionSessionToken, envelope.expectedPrivacyEpoch, (context) => {
      this.#auth.bindInitiatingSessionWithinTransaction(context, admissionSessionToken);
      ensureBackgroundSchema(context.db);
      const request = canonicalBackgroundJson({ operation, envelope });
      const replay = this.#findCommand(context, envelope.commandId, request, operation, envelope.policyId, envelope.expectedPolicyRevision + 1,
        operation === 'pause' ? 'paused' : 'revoked');
      if (replay) return replay;
      const head = this.#head(context.db, context, envelope.policyId);
      if (!head || head.current_revision !== envelope.expectedPolicyRevision) return fail('background_policy_revision_stale');
      if (head.status === 'revoked') return fail('background_policy_revoked');
      const current = context.db.prepare(`SELECT revision,enabled,specification_json,binding_json,binding_digest,policy_digest,effective_from,created_at
        FROM background_policy_revisions WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND revision=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, envelope.policyId, head.current_revision) as PolicyRevisionRow | undefined;
      if (!current) return fail('background_policy_storage_invalid');
      const revision = current.revision + 1;
      if (!Number.isSafeInteger(revision)) return fail('background_policy_revision_overflow');
      const now = epoch(this.#clock());
      const enabled = operation === 'pause' ? 0 : current.enabled;
      const status = operation === 'pause' ? 'paused' : 'revoked';
      const policyDigest = digest(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
        privacyEpoch: context.privacyEpoch, policyId: envelope.policyId, revision, enabled,
        previousPolicyDigest: current.policy_digest, operation }));
      context.db.prepare(`INSERT INTO background_policy_revisions(workspace_id,owner_id,privacy_epoch,policy_id,revision,enabled,
        specification_json,binding_json,binding_digest,policy_digest,effective_from,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch, envelope.policyId, revision, enabled,
          current.specification_json, current.binding_json, current.binding_digest, policyDigest, now, now);
      context.db.prepare(`UPDATE background_policy_heads SET current_revision=?,status=?,suspension=NULL,updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=?`)
        .run(revision, status, now, context.workspaceId, context.ownerId, context.privacyEpoch, envelope.policyId);
      return this.#saveReceipt(context, envelope.commandId, request, { schemaVersion: 1, commandId: envelope.commandId,
        operation, policyId: envelope.policyId, policyRevision: revision, status, effectiveFrom: now });
    });
  }

  #head(db: Database.Database, context: OwnedTransactionContext, policyId: string): PolicyHeadRow | undefined {
    return db.prepare(`SELECT policy_id,current_revision,status,suspension,updated_at FROM background_policy_heads
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, policyId) as PolicyHeadRow | undefined;
  }

  #findCommand(context: OwnedTransactionContext, commandId: string, request: string, operation: BackgroundPolicyReceipt['operation'],
    policyId: string, policyRevision: number, status: BackgroundPolicyReceipt['status']): BackgroundPolicyReceipt | undefined {
    const found = context.db.prepare(`SELECT request_digest,receipt_json FROM background_policy_commands
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND command_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, commandId) as CommandRow | undefined;
    if (!found) return undefined;
    if (found.request_digest !== digest(request)) return fail('background_policy_idempotency_conflict');
    const receipt = parseBackgroundPolicyReceipt(parseStored<unknown>(found.receipt_json));
    if (receipt.commandId !== commandId || receipt.operation !== operation || receipt.policyId !== policyId ||
        receipt.policyRevision !== policyRevision || receipt.status !== status) return fail('background_policy_storage_invalid');
    return receipt;
  }

  #saveReceipt(context: OwnedTransactionContext, commandId: string, request: string, receipt: BackgroundPolicyReceipt): BackgroundPolicyReceipt {
    const json = canonicalBackgroundJson(receipt, 64 * 1024);
    context.db.prepare(`INSERT INTO background_policy_commands(workspace_id,owner_id,privacy_epoch,command_id,request_digest,receipt_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(context.workspaceId, context.ownerId, context.privacyEpoch, commandId, digest(request), json, epoch(this.#clock()));
    return Object.freeze(receipt);
  }
}
