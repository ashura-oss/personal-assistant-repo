import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DurableKernel, OwnedTransactionContext } from './kernel.js';
import type { AuthService } from './auth.js';
import { currentCommandTicket } from './commandJournal.js';
import type { SnapshotCommitParticipant, SnapshotCommitParticipantInput } from './workspaceStore.js';
import { consumeReminderSavePolicyCapture, readReminderSavePolicyCapture } from './reminderPolicyCapture.js';
import { ensureBackgroundSchema } from './backgroundSchema.js';
import {
  canonicalBackgroundJson, parsePauseBackgroundPolicyEnvelope, parseRevokeBackgroundPolicyEnvelope,
  parseSaveBackgroundPolicyEnvelope, parseBackgroundPolicyDisplay, parseBackgroundPolicyReceipt, parseBackgroundSpecification,
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
  readonly connected: boolean;
}

export type ResolvedBackgroundBinding = Readonly<{
  accounts?: readonly ResolvedBackgroundAccount[];
  rule?: Readonly<{ ruleId: string; revision: number; specificationDigest: string }>;
  reminder?: Readonly<{ reminderId: string; revision: number; approvedDigest: string; dueAt: number; privacyEpoch: number;
    intentId: string; privacyMode: 'private' | 'full'; deviceSelection: 'all_current' |
      Readonly<{ subscriptionIds: readonly string[] }> |
      Readonly<{ subscriptions: readonly Readonly<{ subscriptionId: string; generation: number }>[] }> }>;
}>;

/** Must resolve only exact current saved identities/revisions from the owned context. */
export interface BackgroundBindingResolver {
  resolve(context: OwnedTransactionContext, specification: BackgroundPolicySpecification): ResolvedBackgroundBinding;
  /** Resolves only reminder authority against the exact persisted post-commit snapshot in this transaction. */
  resolveReminderSnapshotTransitionWithinTransaction?(context: OwnedTransactionContext, nextRevision: number, candidate: unknown,
    specification: Extract<BackgroundPolicySpecification, { kind: 'approved_reminder_delivery' }>): ResolvedBackgroundBinding;
  /** Captures currently eligible devices at the due instant; never called while saving policy authorization. */
  assertReminderDeliveryAvailableWithinTransaction?(context: OwnedTransactionContext): void;
  captureReminderTargets?(context: OwnedTransactionContext, specification: Extract<BackgroundPolicySpecification, { kind: 'approved_reminder_delivery' }>,
    reminder: NonNullable<ResolvedBackgroundBinding['reminder']>): readonly Readonly<{ subscriptionId: string; generation: number }>[];
}

export interface BackgroundPolicyStoreOptions {
  readonly kernel: DurableKernel;
  readonly auth: AuthService;
  readonly resolver: BackgroundBindingResolver;
  readonly clock?: () => number;
  /** Synchronous wake signal invoked only after the owned policy transaction commits. */
  readonly onCommitted?: (identity: Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>) => void;
  /** Synchronous candidate-index reconciliation in the same transaction as proactive consent enablement. */
  readonly onProactivePolicyEnabledWithinTransaction?: (context: OwnedTransactionContext, now: number) => void;
}

export interface BackgroundAccountSyncCandidate {
  readonly policy: BackgroundPolicyDisplay;
  readonly initialEffectiveFrom: number;
}

export interface BackgroundReminderDeliveryCandidate {
  readonly policyId: string;
  readonly policyRevision: number;
  readonly reminderId: string;
  readonly reminderRevision: number;
  readonly approvedIntentId: string;
  readonly dueAt: number;
}

export interface BackgroundProactiveDraftCandidate {
  readonly policy: BackgroundPolicyDisplay;
  readonly initialEffectiveFrom: number;
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
function invokeReminderDeliveryAvailability(callback: NonNullable<BackgroundBindingResolver['assertReminderDeliveryAvailableWithinTransaction']>,
  context: OwnedTransactionContext): void {
  const result = (callback as (context: OwnedTransactionContext) => unknown)(context);
  if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
    let then: unknown;
    try { then = (result as { then?: unknown }).then; } catch { return fail('background_reminder_delivery_availability_async_rejected'); }
    if (typeof then === 'function') {
      try { Promise.resolve(result).catch(() => undefined); } catch { /* A hostile thenable is rejected below. */ }
      return fail('background_reminder_delivery_availability_async_rejected');
    }
  }
}
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
        !Number.isSafeInteger(account.connectionGeneration) || account.connectionGeneration < 1 ||
        typeof account.label !== 'string' || Buffer.byteLength(account.label, 'utf8') > 1024 ||
        /[\u0000-\u001f\u007f]/.test(account.label) || typeof account.connected !== 'boolean' || actualMap.has(account.accountId)) return fail('background_binding_invalid');
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
      if (!selection || specification.devices === 'all_current') return fail('background_binding_changed');
      if ('subscriptionIds' in selection) {
        if (Object.keys(selection as object).join(',') !== 'subscriptionIds' || !Array.isArray(selection.subscriptionIds) ||
            selection.subscriptionIds.some((id) => typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(id)) ||
            new Set(selection.subscriptionIds).size !== selection.subscriptionIds.length || !('subscriptionIds' in specification.devices) ||
            canonicalBackgroundJson([...selection.subscriptionIds].sort()) !== canonicalBackgroundJson([...specification.devices.subscriptionIds].sort())) return fail('background_binding_changed');
      } else {
        if (Object.keys(selection as object).join(',') !== 'subscriptions' || !Array.isArray(selection.subscriptions) ||
            selection.subscriptions.some((item) => !item || Object.keys(item).sort().join(',') !== 'generation,subscriptionId' ||
              typeof item.subscriptionId !== 'string' || item.subscriptionId.length > 1024 ||
              /[\u0000-\u001f\u007f]/.test(item.subscriptionId) || !Number.isSafeInteger(item.generation) || item.generation < 1) ||
            new Set(selection.subscriptions.map((item) => item.subscriptionId)).size !== selection.subscriptions.length ||
            !('subscriptions' in specification.devices) ||
            canonicalBackgroundJson([...selection.subscriptions].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId))) !==
              canonicalBackgroundJson([...specification.devices.subscriptions].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)))) return fail('background_binding_changed');
      }
    }
  } else if (parsed.reminder !== undefined) return fail('background_binding_invalid');
  return Object.freeze({ ...(expectedMap.size ? { accounts: Object.freeze([...actualMap.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)).map((item) => Object.freeze({ ...item }))) } : {}),
    ...(parsed.rule ? { rule: Object.freeze({ ...parsed.rule }) } : {}), ...(parsed.reminder ? { reminder: Object.freeze({ ...parsed.reminder,
      deviceSelection: parsed.reminder.deviceSelection === 'all_current' ? 'all_current' :
        'subscriptionIds' in parsed.reminder.deviceSelection
          ? Object.freeze({ subscriptionIds: Object.freeze([...parsed.reminder.deviceSelection.subscriptionIds].sort()) })
          : Object.freeze({ subscriptions: Object.freeze([...parsed.reminder.deviceSelection.subscriptions]
            .sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)).map((item) => Object.freeze({ ...item }))) }) }) } : {}) });
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
  readonly #onCommitted?: BackgroundPolicyStoreOptions['onCommitted'];
  readonly #onProactivePolicyEnabledWithinTransaction?: BackgroundPolicyStoreOptions['onProactivePolicyEnabledWithinTransaction'];

  constructor(options: BackgroundPolicyStoreOptions) {
    if (!options || !options.kernel || !options.auth || !options.resolver || typeof options.resolver.resolve !== 'function' ||
        options.resolver.resolve.constructor?.name === 'AsyncFunction' ||
        (options.resolver.captureReminderTargets && options.resolver.captureReminderTargets.constructor?.name === 'AsyncFunction')) {
      throw new TypeError('background_policy_store_invalid');
    }
    if (options.onProactivePolicyEnabledWithinTransaction?.constructor?.name === 'AsyncFunction') throw new TypeError('background_policy_store_invalid');
    this.#kernel = options.kernel;
    this.#auth = options.auth;
    this.#resolver = options.resolver;
    this.#clock = options.clock ?? Date.now;
    this.#onCommitted = options.onCommitted;
    this.#onProactivePolicyEnabledWithinTransaction = options.onProactivePolicyEnabledWithinTransaction;
  }

  /** Pass the authenticated browser's private kernel admission token for each human-consent mutation. */
  save(admissionSessionToken: string, raw: unknown): BackgroundPolicyReceipt {
    if (typeof admissionSessionToken !== 'string' || !admissionSessionToken) return fail('background_admission_required');
    const envelope = parseSaveBackgroundPolicyEnvelope(raw);
    if (envelope.specification.kind === 'approved_reminder_delivery') return fail('background_reminder_command_required');
    const result = this.#kernel.withOwnedTransaction(admissionSessionToken, envelope.expectedPrivacyEpoch, (context) => {
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
      if (envelope.enabled && envelope.specification.kind === 'proactive_draft') {
        this.#onProactivePolicyEnabledWithinTransaction?.(context, now);
      }
      return this.#saveReceipt(context, envelope.commandId, request, { schemaVersion: 1, commandId: envelope.commandId,
        operation: 'save', policyId: envelope.policyId, policyRevision: revision, status, effectiveFrom });
    });
    try { this.#onCommitted?.(this.#kernel.getOwnedIdentity(admissionSessionToken)); } catch { /* committed receipt remains authoritative */ }
    return result;
  }

  pause(admissionSessionToken: string, raw: unknown): BackgroundPolicyReceipt { return this.#change(admissionSessionToken, raw, parsePauseBackgroundPolicyEnvelope, 'pause'); }
  revoke(admissionSessionToken: string, raw: unknown): BackgroundPolicyReceipt { return this.#change(admissionSessionToken, raw, parseRevokeBackgroundPolicyEnvelope, 'revoke'); }

  inspect(admissionSessionToken: string, input: { readonly commandId: string; readonly expectedPrivacyEpoch: number }): BackgroundPolicyReceipt | undefined {
    if (!input || Object.keys(input).some((key) => !['commandId', 'expectedPrivacyEpoch'].includes(key)) ||
        !isBackgroundUuidV4(input.commandId) || !Number.isSafeInteger(input.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0) return fail('background_policy_query_invalid');
    return this.#kernel.withOwnedTransaction(admissionSessionToken, input.expectedPrivacyEpoch, (context) => {
      this.#auth.bindInitiatingSessionWithinTransaction(context, admissionSessionToken);
      ensureBackgroundSchema(context.db);
      const row = context.db.prepare(`SELECT receipt_json FROM background_policy_commands
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND command_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, input.commandId) as { receipt_json: string } | undefined;
      return row ? parseBackgroundPolicyReceipt(parseStored<unknown>(row.receipt_json)) : undefined;
    });
  }

  list(admissionSessionToken: string, input: { readonly expectedPrivacyEpoch: number; readonly afterPolicyId?: string;
    readonly atOrAfterPolicyId?: string; readonly limit?: number }): readonly BackgroundPolicyDisplay[] {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['expectedPrivacyEpoch', 'afterPolicyId', 'atOrAfterPolicyId', 'limit'].includes(key)) ||
        (input.afterPolicyId !== undefined && input.atOrAfterPolicyId !== undefined)) {
      throw new TypeError('background_policy_query_invalid');
    }
    const limit = input?.limit ?? 100;
    if (!Number.isSafeInteger(input?.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (input.afterPolicyId !== undefined && !isBackgroundUuidV4(input.afterPolicyId)) ||
        (input.atOrAfterPolicyId !== undefined && !isBackgroundUuidV4(input.atOrAfterPolicyId))) throw new TypeError('background_policy_query_invalid');
    return this.#kernel.withOwnedTransaction(admissionSessionToken, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const rows = context.db.prepare(`SELECT h.policy_id,h.current_revision,h.status,h.suspension,h.updated_at,
        r.revision,r.enabled,r.specification_json,r.binding_json,r.binding_digest,r.policy_digest,r.effective_from,r.created_at
        FROM background_policy_heads h JOIN background_policy_revisions r ON r.workspace_id=h.workspace_id AND r.owner_id=h.owner_id
          AND r.privacy_epoch=h.privacy_epoch AND r.policy_id=h.policy_id AND r.revision=h.current_revision
        WHERE h.workspace_id=? AND h.owner_id=? AND h.privacy_epoch=?
          AND (? IS NULL OR h.policy_id>?) AND (? IS NULL OR h.policy_id>=?) ORDER BY h.policy_id LIMIT ?`)
        .all(context.workspaceId, context.ownerId, context.privacyEpoch, input.afterPolicyId ?? null, input.afterPolicyId ?? null,
          input.atOrAfterPolicyId ?? null, input.atOrAfterPolicyId ?? null, limit) as (PolicyHeadRow & PolicyRevisionRow)[];
      return Object.freeze(rows.map((row) => projection(row, row, context)));
    });
  }

  /** Private scheduler metadata page; candidates contain only account-sync policy and cadence metadata. */
  listAccountSyncCandidatePage(actorSessionToken: string, input: { readonly expectedPrivacyEpoch: number; readonly afterPolicyId?: string; readonly limit?: number }): Readonly<{ candidates: readonly BackgroundAccountSyncCandidate[]; nextCursor?: string }> {
    const policies = this.list(actorSessionToken, input);
    return this.#kernel.withOwnedTransaction(actorSessionToken, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const candidates: BackgroundAccountSyncCandidate[] = [];
      for (const policy of policies) {
        if (policy.status !== 'enabled' || !policy.enabled || policy.specification.kind !== 'account_sync') continue;
        const row = context.db.prepare(`SELECT effective_from FROM background_policy_revisions
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND revision=1`)
          .get(context.workspaceId, context.ownerId, context.privacyEpoch, policy.policyId) as { effective_from: number } | undefined;
        if (!row || !Number.isSafeInteger(row.effective_from) || row.effective_from < 0) return fail('background_policy_storage_invalid');
        candidates.push(Object.freeze({ policy, initialEffectiveFrom: row.effective_from }));
      }
      const nextCursor = policies.length === (input.limit ?? 100) ? policies.at(-1)?.policyId : undefined;
      return Object.freeze({ candidates: Object.freeze(candidates), ...(nextCursor ? { nextCursor } : {}) });
    });
  }

  /** Private scheduler metadata page for enabled proactive-draft policy heads. */
  listProactiveDraftCandidatePage(actorSessionToken: string, input: { readonly expectedPrivacyEpoch: number; readonly afterPolicyId?: string;
    readonly atOrAfterPolicyId?: string; readonly limit?: number }): Readonly<{ candidates: readonly BackgroundProactiveDraftCandidate[]; nextCursor?: string }> {
    const policies = this.list(actorSessionToken, input);
    return this.#kernel.withOwnedTransaction(actorSessionToken, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const candidates: BackgroundProactiveDraftCandidate[] = [];
      for (const policy of policies) {
        if (policy.status !== 'enabled' || !policy.enabled || policy.specification.kind !== 'proactive_draft') continue;
        const row = context.db.prepare(`SELECT effective_from FROM background_policy_revisions
          WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND revision=1`)
          .get(context.workspaceId, context.ownerId, context.privacyEpoch, policy.policyId) as { effective_from: number } | undefined;
        if (!row || !Number.isSafeInteger(row.effective_from) || row.effective_from < 0) return fail('background_policy_storage_invalid');
        candidates.push(Object.freeze({ policy, initialEffectiveFrom: row.effective_from }));
      }
      const nextCursor = policies.length === (input.limit ?? 100) ? policies.at(-1)?.policyId : undefined;
      return Object.freeze({ candidates: Object.freeze(candidates), ...(nextCursor ? { nextCursor } : {}) });
    });
  }

  assertProactiveDraftPreflightCurrentWithinTransaction(context: OwnedTransactionContext, input: Readonly<{ policyId: string; policyRevision: number }>): void {
    this.#kernel.assertOwnedTransactionContext(context);
    if (!input || !isBackgroundUuidV4(input.policyId) || !Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) {
      return fail('background_policy_query_invalid');
    }
    ensureBackgroundSchema(context.db);
    const head = this.#head(context.db, context, input.policyId);
    if (!head || head.current_revision !== input.policyRevision || head.status !== 'enabled') return fail('background_occurrence_policy_stale');
    const row = context.db.prepare(`SELECT revision,enabled,specification_json,binding_json,binding_digest,policy_digest,effective_from,created_at
      FROM background_policy_revisions WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND revision=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, input.policyId, input.policyRevision) as PolicyRevisionRow | undefined;
    if (!row || row.enabled !== 1) return fail('background_occurrence_policy_stale');
    const displayed = projection(head, row, context);
    if (displayed.specification.kind !== 'proactive_draft') return fail('background_policy_kind_unavailable');
    const stored = normalizeResolvedBackgroundBinding(parseStored<ResolvedBackgroundBinding>(row.binding_json), displayed.specification, context.privacyEpoch);
    const current = normalizeResolvedBackgroundBinding(this.#resolver.resolve(context, displayed.specification), displayed.specification, context.privacyEpoch);
    if (canonicalBackgroundJson(backgroundBindingAuthority(current), MAX_PRIVATE_BYTES) !==
        canonicalBackgroundJson(backgroundBindingAuthority(stored), MAX_PRIVATE_BYTES)) return fail('background_binding_changed');
  }

  /** Trusted scheduler hold for an exact account-sync revision whose live identity no longer matches consent. */
  suspendAccountSyncAfterBindingChange(actorSessionToken: string, input: { readonly expectedPrivacyEpoch: number;
    readonly policyId: string; readonly expectedPolicyRevision: number }): void {
    if (!input || !isBackgroundUuidV4(input.policyId) || !Number.isSafeInteger(input.expectedPrivacyEpoch) || input.expectedPrivacyEpoch < 0 ||
        !Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 1) return fail('background_policy_query_invalid');
    this.#kernel.withOwnedTransaction(actorSessionToken, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const head = this.#head(context.db, context, input.policyId);
      if (!head || head.current_revision !== input.expectedPolicyRevision || head.status !== 'enabled') return;
      const revision = context.db.prepare(`SELECT revision,enabled,specification_json,binding_json,binding_digest,policy_digest,effective_from,created_at
        FROM background_policy_revisions WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND revision=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, input.policyId, input.expectedPolicyRevision) as PolicyRevisionRow | undefined;
      if (!revision) return fail('background_policy_storage_invalid');
      const displayed = projection(head, revision, context);
      let authorityChanged = false;
      try {
        const current = normalizeResolvedBackgroundBinding(this.#resolver.resolve(context, displayed.specification), displayed.specification, context.privacyEpoch);
        const stored = parseStored<ResolvedBackgroundBinding>(revision.binding_json);
        authorityChanged = canonicalBackgroundJson(backgroundBindingAuthority(current), MAX_PRIVATE_BYTES) !==
          canonicalBackgroundJson(backgroundBindingAuthority(stored), MAX_PRIVATE_BYTES);
      } catch (error) {
        if (!(error instanceof Error) || !['background_binding_changed', 'background_occurrence_binding_changed'].includes(error.message)) throw error;
        authorityChanged = true;
      }
      if (!authorityChanged) return;
      const updated = context.db.prepare(`UPDATE background_policy_heads SET status='suspended',suspension='account_changed',updated_at=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND current_revision=? AND status='enabled'
          AND EXISTS (SELECT 1 FROM background_policy_revisions r WHERE r.workspace_id=background_policy_heads.workspace_id
            AND r.owner_id=background_policy_heads.owner_id AND r.privacy_epoch=background_policy_heads.privacy_epoch
            AND r.policy_id=background_policy_heads.policy_id AND r.revision=background_policy_heads.current_revision AND r.policy_digest=?)`)
        .run(epoch(this.#clock()), context.workspaceId, context.ownerId, context.privacyEpoch, input.policyId,
          input.expectedPolicyRevision, revision.policy_digest);
      if (updated.changes > 1) return fail('background_policy_storage_invalid');
    });
  }

  #change(admissionSessionToken: string, raw: unknown, parse: (value: unknown) => ChangeBackgroundPolicyEnvelope, operation: 'pause' | 'revoke'): BackgroundPolicyReceipt {
    if (typeof admissionSessionToken !== 'string' || !admissionSessionToken) return fail('background_admission_required');
    const envelope = parse(raw);
    const result = this.#kernel.withOwnedTransaction(admissionSessionToken, envelope.expectedPrivacyEpoch, (context) => {
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
    try { this.#onCommitted?.(this.#kernel.getOwnedIdentity(admissionSessionToken)); } catch { /* committed receipt remains authoritative */ }
    return result;
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

    listReminderDeliveryCandidatePage(actorSessionToken: string, input: { readonly expectedPrivacyEpoch: number;
    readonly afterPolicyId?: string; readonly limit?: number }): Readonly<{ candidates: readonly BackgroundReminderDeliveryCandidate[]; nextCursor?: string }> {
    const policies = this.list(actorSessionToken, input);
    return this.#kernel.withOwnedTransaction(actorSessionToken, input.expectedPrivacyEpoch, (context) => {
      ensureBackgroundSchema(context.db);
      const candidates: BackgroundReminderDeliveryCandidate[] = [];
      for (const policy of policies) {
        if (policy.status !== 'enabled' || !policy.enabled || policy.specification.kind !== 'approved_reminder_delivery') continue;
        const row = context.db.prepare(`SELECT binding_json FROM background_policy_revisions WHERE workspace_id=? AND owner_id=?
          AND privacy_epoch=? AND policy_id=? AND revision=? AND enabled=1`)
          .get(context.workspaceId, context.ownerId, context.privacyEpoch, policy.policyId, policy.revision) as { binding_json: string } | undefined;
        if (!row) return fail('background_policy_storage_invalid');
        const stored = parseStored<ResolvedBackgroundBinding>(row.binding_json);
        const binding = normalizeResolvedBackgroundBinding(stored, policy.specification, context.privacyEpoch);
        if (canonicalBackgroundJson(binding, MAX_PRIVATE_BYTES) !== canonicalBackgroundJson(stored, MAX_PRIVATE_BYTES) || !binding.reminder ||
            binding.reminder.reminderId !== policy.specification.reminderId || binding.reminder.revision !== policy.specification.expectedReminderRevision ||
            !Number.isSafeInteger(binding.reminder.dueAt) || binding.reminder.dueAt < 0) return fail('background_policy_storage_invalid');
        candidates.push(Object.freeze({ policyId: policy.policyId, policyRevision: policy.revision,
          reminderId: binding.reminder.reminderId, reminderRevision: binding.reminder.revision,
          approvedIntentId: binding.reminder.intentId, dueAt: binding.reminder.dueAt }));
      }
      const nextCursor = policies.length === (input.limit ?? 100) ? policies.at(-1)?.policyId : undefined;
      return Object.freeze({ candidates: Object.freeze(candidates), ...(nextCursor ? { nextCursor } : {}) });
    });
  }

  #saveReceipt(context: OwnedTransactionContext, commandId: string, request: string, receipt: BackgroundPolicyReceipt): BackgroundPolicyReceipt {
    const json = canonicalBackgroundJson(receipt, 64 * 1024);
    context.db.prepare(`INSERT INTO background_policy_commands(workspace_id,owner_id,privacy_epoch,command_id,request_digest,receipt_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(context.workspaceId, context.ownerId, context.privacyEpoch, commandId, digest(request), json, epoch(this.#clock()));
    return Object.freeze(receipt);
  }

  /**
   * Couples reminder policy creation/revocation to the canonical snapshot commit.
   * Only the exact server-save command capture can create delivery consent.
   */
  createReminderSnapshotCommitParticipant<TState extends object>(): SnapshotCommitParticipant<TState> {
    return Object.freeze({
      beforeCommit: (_context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>) => {
        const ticket = currentCommandTicket();
        if (ticket?.kind === 'reminders.serversave' && (!input.commandId || input.commandId !== ticket.idempotencyKey)) {
          return fail('background_reminder_command_capture_invalid');
        }
      },
      commit: (context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>) => {
        const ticket = currentCommandTicket();
        if (ticket?.kind === 'reminders.serversave') {
          if (!input.commandId || input.commandId !== ticket.idempotencyKey) return fail('background_reminder_command_capture_invalid');
          const capturePreview = readReminderSavePolicyCapture(context, input.commandId);
          const after = reminderSnapshotRecord(input.nextSnapshot, capturePreview.reminderId);
          const before = reminderSnapshotRecord(input.previousSnapshot, capturePreview.reminderId);
          if (!before || !after || before.status !== 'approved' || after.status !== 'saved' || before.revision !== after.revision ||
              after.revision !== capturePreview.reminderRevision ||
              before.approvedRevision !== after.revision || after.approvedRevision !== after.revision ||
              before.approvedPayloadDigest !== after.approvedPayloadDigest || !after.currentIntentId) {
            return fail('background_reminder_snapshot_transition_invalid');
          }
          const capture = consumeReminderSavePolicyCapture(context, capturePreview);
          const specification = parseBackgroundSpecification({ kind: 'approved_reminder_delivery', reminderId: after.id,
            expectedReminderRevision: after.revision, channel: 'web_push', devices: capture.devices });
          if (specification.kind !== 'approved_reminder_delivery') return fail('background_reminder_policy_invalid');
          this.#insertReminderPolicy(context, capture.policyId, specification, input.commandId, input.nextRevision, input.nextSnapshot);
          return Object.freeze([reminderPolicyWake(context)]);
        }

        return this.#revokeChangedReminderPolicies(context, input) ? Object.freeze([reminderPolicyWake(context)]) : undefined;
      },
      afterAcknowledged: (intentIds: readonly string[]) => {
        for (const value of intentIds) {
          const identity = parseReminderPolicyWake(value);
          if (identity) {
            try { this.#onCommitted?.(identity); } catch { /* The durable policy is authoritative; scheduler polling remains safe. */ }
          }
        }
      },
    });
  }

  #insertReminderPolicy(context: OwnedTransactionContext, policyId: string, specification: Extract<BackgroundPolicySpecification, { kind: 'approved_reminder_delivery' }>,
    commandId: string, nextRevision: number, nextSnapshot: object): void {
    if (!isBackgroundUuidV4(policyId) || !isBackgroundUuidV4(commandId)) return fail('background_reminder_policy_invalid');
    const assertDeliveryAvailable = this.#resolver.assertReminderDeliveryAvailableWithinTransaction;
    if (!assertDeliveryAvailable) return fail('background_reminder_delivery_unavailable');
    invokeReminderDeliveryAvailability(assertDeliveryAvailable.bind(this.#resolver), context);
    ensureBackgroundSchema(context.db);
    if (this.#head(context.db, context, policyId)) return fail('background_policy_id_conflict');
    const binding = this.#resolveReminderSnapshotTransition(context, nextRevision, nextSnapshot, specification);
    if (!binding.reminder || binding.reminder.deviceSelection !== 'all_current' &&
        !('subscriptions' in binding.reminder.deviceSelection)) return fail('background_reminder_generation_required');
    const bindingJson = canonicalBackgroundJson(binding, MAX_PRIVATE_BYTES);
    const specificationJson = canonicalBackgroundJson(specification);
    const now = epoch(this.#clock());
    const bindingDigest = digest(canonicalBackgroundJson(backgroundBindingAuthority(binding), MAX_PRIVATE_BYTES));
    const policyDigest = digest(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
      privacyEpoch: context.privacyEpoch, policyId, revision: 1, enabled: true, specification: JSON.parse(specificationJson), bindingDigest,
      effectiveFrom: now }));
    context.db.prepare(`INSERT INTO background_policy_revisions(workspace_id,owner_id,privacy_epoch,policy_id,revision,enabled,
      specification_json,binding_json,binding_digest,policy_digest,effective_from,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, policyId, 1, 1,
        specificationJson, bindingJson, bindingDigest, policyDigest, now, now);
    context.db.prepare(`INSERT INTO background_policy_heads(workspace_id,owner_id,privacy_epoch,policy_id,current_revision,status,suspension,updated_at)
      VALUES(?,?,?,?,1,'enabled',NULL,?)`).run(context.workspaceId, context.ownerId, context.privacyEpoch, policyId, now);
    this.#saveReceipt(context, commandId, canonicalBackgroundJson({ operation: 'reminder_snapshot_save', policyId, specification }),
      { schemaVersion: 1, commandId, operation: 'save', policyId, policyRevision: 1, status: 'enabled', effectiveFrom: now });
  }

  #resolveReminderSnapshotTransition(context: OwnedTransactionContext, nextRevision: number, candidate: object,
    specification: Extract<BackgroundPolicySpecification, { kind: 'approved_reminder_delivery' }>): ResolvedBackgroundBinding {
    const resolve = this.#resolver.resolveReminderSnapshotTransitionWithinTransaction;
    if (!resolve || !candidate || typeof candidate !== 'object') return fail('background_reminder_transition_resolver_required');
    return normalizeResolvedBackgroundBinding(resolve.call(this.#resolver, context, nextRevision, candidate, specification), specification, context.privacyEpoch);
  }

  #revokeChangedReminderPolicies<TState extends object>(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<TState>): boolean {
    ensureBackgroundSchema(context.db);
    const heads = context.db.prepare(`SELECT policy_id,current_revision,status,suspension,updated_at FROM background_policy_heads
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND status!='revoked'`)
      .all(context.workspaceId, context.ownerId, context.privacyEpoch) as PolicyHeadRow[];
    let changed = false;
    for (const head of heads) {
      const row = context.db.prepare(`SELECT revision,enabled,specification_json,binding_json,binding_digest,policy_digest,effective_from,created_at
        FROM background_policy_revisions WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND revision=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, head.policy_id, head.current_revision) as PolicyRevisionRow | undefined;
      if (!row) return fail('background_policy_storage_invalid');
      const display = projection(head, row, context);
      if (display.specification.kind !== 'approved_reminder_delivery') continue;
      let stillCurrent = false;
      try {
        const current = this.#resolveReminderSnapshotTransition(context, input.nextRevision, input.nextSnapshot, display.specification);
        const stored = parseStored<ResolvedBackgroundBinding>(row.binding_json);
        stillCurrent = canonicalBackgroundJson(backgroundBindingAuthority(current), MAX_PRIVATE_BYTES) ===
          canonicalBackgroundJson(backgroundBindingAuthority(stored), MAX_PRIVATE_BYTES);
      } catch (error) {
        if (!(error instanceof Error) || !['background_reminder_changed', 'background_binding_changed'].includes(error.message)) throw error;
      }
      if (!stillCurrent) { this.#appendReminderRevocation(context, head, row, input.commandId); changed = true; }
    }
    return changed;
  }

  #appendReminderRevocation(context: OwnedTransactionContext, head: PolicyHeadRow, current: PolicyRevisionRow, causeCommandId?: string): void {
    const revision = current.revision + 1;
    if (!Number.isSafeInteger(revision)) return fail('background_policy_revision_overflow');
    const now = epoch(this.#clock());
    const policyDigest = digest(canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId,
      privacyEpoch: context.privacyEpoch, policyId: head.policy_id, revision, enabled: 0,
      previousPolicyDigest: current.policy_digest, operation: 'reminder_changed', causeCommandId: causeCommandId ?? null }));
    context.db.prepare(`INSERT INTO background_policy_revisions(workspace_id,owner_id,privacy_epoch,policy_id,revision,enabled,
      specification_json,binding_json,binding_digest,policy_digest,effective_from,created_at) VALUES(?,?,?,?,?,0,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.ownerId, context.privacyEpoch, head.policy_id, revision,
        current.specification_json, current.binding_json, current.binding_digest, policyDigest, now, now);
    context.db.prepare(`UPDATE background_policy_heads SET current_revision=?,status='revoked',suspension='reminder_changed',updated_at=?
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? AND current_revision=?`)
      .run(revision, now, context.workspaceId, context.ownerId, context.privacyEpoch, head.policy_id, current.revision);
    const commandId = randomUUID();
    const request = canonicalBackgroundJson({ operation: 'reminder_changed', causeCommandId: causeCommandId ?? null,
      policyId: head.policy_id, revision });
    this.#saveReceipt(context, commandId, request, { schemaVersion: 1, commandId, operation: 'revoke', policyId: head.policy_id,
      policyRevision: revision, status: 'revoked', effectiveFrom: now });
  }
}

function reminderSnapshotRecord(snapshot: object, reminderId: string): Readonly<Record<string, unknown>> | undefined {
  if (!snapshot || typeof snapshot !== 'object' || !reminderId) return undefined;
  const reminders = (snapshot as Record<string, unknown>).reminders;
  if (!reminders || typeof reminders !== 'object' || Array.isArray(reminders)) return undefined;
  const records = (reminders as Record<string, unknown>).records;
  if (!Array.isArray(records)) return undefined;
  const found = records.find((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).id === reminderId);
  return found && typeof found === 'object' && !Array.isArray(found) ? found as Readonly<Record<string, unknown>> : undefined;
}

function reminderPolicyWake(context: OwnedTransactionContext): string {
  const body = canonicalBackgroundJson({ workspaceId: context.workspaceId, ownerId: context.ownerId, privacyEpoch: context.privacyEpoch });
  return `reminder-policy-wake:${Buffer.from(body, 'utf8').toString('base64url')}`;
}

function parseReminderPolicyWake(value: string): Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }> | undefined {
  const prefix = 'reminder-policy-wake:';
  if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return undefined;
    const text = bytes.toString('utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (canonicalBackgroundJson(parsed) !== text || Object.keys(parsed).sort().join(',') !== 'ownerId,privacyEpoch,workspaceId' ||
        typeof parsed.workspaceId !== 'string' || !isBackgroundUuidV4(parsed.workspaceId) ||
        typeof parsed.ownerId !== 'string' || !isBackgroundUuidV4(parsed.ownerId) ||
        !Number.isSafeInteger(parsed.privacyEpoch) || (parsed.privacyEpoch as number) < 0) return undefined;
    return Object.freeze({ workspaceId: parsed.workspaceId, ownerId: parsed.ownerId, privacyEpoch: parsed.privacyEpoch as number });
  } catch { return undefined; }
}
