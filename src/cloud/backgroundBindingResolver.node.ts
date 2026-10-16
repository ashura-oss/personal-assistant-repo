import { createHash } from 'node:crypto';
import { canonicalVerifiedProviderIdentity, projectBackgroundAuthorityAccounts, type BackgroundAuthorityAccount } from '../core';
import { scopeGrantsCapability } from '../connectors/oauth';
import { evaluateProactive, type ProactiveRule } from '../proactive';
import type { ReminderRecord, ReminderIntent } from '../reminders';
import { canonicalBackgroundJson } from '../../server/src/backgroundContracts.js';
import type { BackgroundBindingResolver, ResolvedBackgroundBinding } from '../../server/src/backgroundPolicies.js';
import type { AccountCapability } from '../core';
import type { BackgroundPolicySpecification } from '../../server/src/backgroundContracts.js';
import type { DurableKernel, OwnedTransactionContext } from '../../server/src/kernel.js';
import type { WebPushSubscriptions } from '../../server/src/webPushSubscriptions.js';

function fail(code: string): never { throw new Error(code); }
function sha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

export function currentSavedProactiveRule(snapshot: unknown, ruleId: string): ProactiveRule & { readonly revision: number; readonly accountIds: readonly string[] } {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return fail('background_rule_changed');
  const proactive = (snapshot as Record<string, unknown>).proactive;
  if (!proactive || typeof proactive !== 'object' || Array.isArray(proactive) || !Array.isArray((proactive as Record<string, unknown>).rules)) {
    return fail('background_rule_changed');
  }
  const rules = (proactive as { rules: unknown[] }).rules;
  const seen = new Set<string>();
  let found: Record<string, unknown> | undefined;
  for (const raw of rules) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('background_rule_changed');
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || !candidate.id || seen.has(candidate.id)) return fail('background_rule_changed');
    seen.add(candidate.id);
    if (candidate.id !== ruleId) continue;
    const required = ['id', 'revision', 'enabled', 'accountIds', 'trigger', 'version', 'name', 'createdAt', 'updatedAt'];
    const optional = ['quietHours'];
    if (required.some((key) => !Object.hasOwn(candidate, key)) || Object.keys(candidate).some((key) => !required.includes(key) && !optional.includes(key)) ||
        !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1 || candidate.enabled !== true ||
        !Array.isArray(candidate.accountIds) || candidate.accountIds.some((id) => typeof id !== 'string') ||
        new Set(candidate.accountIds).size !== candidate.accountIds.length) return fail('background_rule_changed');
    found = candidate;
  }
  if (!found) return fail('background_rule_changed');
  try {
    evaluateProactive({ nowUtc: new Date(0).toISOString(), timeZone: 'UTC', rules: [found as unknown as ProactiveRule], sources: [] });
  } catch { return fail('background_rule_changed'); }
  return found as unknown as ProactiveRule & { readonly revision: number; readonly accountIds: readonly string[] };
}

export function backgroundProactiveRuleDigest(rule: ProactiveRule & { readonly revision: number; readonly accountIds: readonly string[] }): string {
  return sha256(canonicalBackgroundJson({ id: rule.id, revision: rule.revision, enabled: rule.enabled,
    accountIds: rule.accountIds, trigger: rule.trigger, ...(rule.quietHours ? { quietHours: rule.quietHours } : {}) }));
}

/** Resolves saved consent against the exact canonical DB snapshot in the same owned transaction. */
export class ProductionBackgroundBindingResolver implements BackgroundBindingResolver {
  constructor(private readonly kernel: DurableKernel, private readonly webPush?: WebPushSubscriptions) {
    if (!kernel) throw new TypeError('background_binding_kernel_required');
  }

  resolve(context: OwnedTransactionContext, specification: BackgroundPolicySpecification): ResolvedBackgroundBinding {
    const canonical = this.kernel.readOwnedSnapshotWithinTransaction(context).snapshot;
    if (specification.kind === 'approved_reminder_delivery') return resolveReminderSnapshot(canonical, context, specification);
    if (specification.kind !== 'account_sync' && specification.kind !== 'proactive_draft') throw new Error('background_policy_kind_unavailable');
    let projectedAccounts: readonly BackgroundAuthorityAccount[];
    try { projectedAccounts = projectBackgroundAuthorityAccounts(canonical); }
    catch { return fail('background_snapshot_invalid'); }
    const accounts = new Map<string, BackgroundAuthorityAccount>();
    for (const value of projectedAccounts) {
      accounts.set(value.id, value);
    }
    const bound = specification.accounts.map((selection) => {
      const account = accounts.get(selection.accountId);
      if (!account || !account.connected || account.authStatus !== 'connected' || !account.tokenRef ||
          account.connectionGeneration !== selection.expectedConnectionGeneration ||
          (account.provider !== 'google' && account.provider !== 'microsoft') ||
          !Array.isArray(account.capabilities) || !Array.isArray(account.grantedScopes)) return fail('background_binding_changed');
      const identity = canonicalVerifiedProviderIdentity(account);
      const required: readonly AccountCapability[] = specification.kind === 'account_sync'
        ? specification.resources.map((resource) => resource === 'mail' ? 'mail.read' : 'calendar.read') : ['mail.read'];
      if (required.some((capability) => !account.capabilities!.includes(capability) ||
          !scopeGrantsCapability(account.provider as 'google' | 'microsoft', [...account.grantedScopes!], capability) ||
          (account.capabilityLimits !== undefined && !account.capabilityLimits.includes(capability)))) {
        return fail('background_binding_changed');
      }
      return Object.freeze({ accountId: account.id, provider: account.provider as 'google' | 'microsoft',
        identityKey: sha256(identity), connectionGeneration: account.connectionGeneration,
        label: account.displayName, connected: account.connected });
    });
    if (specification.kind === 'account_sync') return Object.freeze({ accounts: Object.freeze(bound) });
    const rule = currentSavedProactiveRule(canonical, specification.ruleId);
    if (rule.revision !== specification.expectedRuleRevision || !rule.enabled ||
        (rule.trigger.type !== 'unread_from' && rule.trigger.type !== 'keyword') ||
        (rule.accountIds.length > 0 && specification.accounts.some((selection) => !rule.accountIds.includes(selection.accountId)))) {
      return fail('background_binding_changed');
    }
    return Object.freeze({ accounts: Object.freeze(bound), rule: Object.freeze({ ruleId: rule.id, revision: rule.revision,
      specificationDigest: backgroundProactiveRuleDigest(rule) }) });
  }

  assertReminderDeliveryAvailableWithinTransaction(context: OwnedTransactionContext): void {
    this.kernel.assertOwnedTransactionContext(context);
    if (!this.webPush) return fail('background_reminder_delivery_unavailable');
  }

  captureReminderTargets(context: OwnedTransactionContext, specification: Extract<BackgroundPolicySpecification, { kind: 'approved_reminder_delivery' }>,
    reminder: NonNullable<ResolvedBackgroundBinding['reminder']>): readonly Readonly<{ subscriptionId: string; generation: number }>[] {
    this.kernel.assertOwnedTransactionContext(context);
    if (!this.webPush || specification.kind !== 'approved_reminder_delivery' || reminder.reminderId !== specification.reminderId ||
        reminder.revision !== specification.expectedReminderRevision || reminder.privacyEpoch !== context.privacyEpoch) {
      return fail('background_reminder_target_resolver_unavailable');
    }
    if (reminder.deviceSelection === 'all_current') {
      return this.webPush.listActiveDeliveryTargetsWithinTransaction(context);
    }
    if (typeof reminder.deviceSelection === 'string' || typeof specification.devices === 'string' ||
        !('subscriptions' in reminder.deviceSelection) || !('subscriptions' in specification.devices)) {
      return fail('background_reminder_generation_required');
    }
    return Object.freeze(reminder.deviceSelection.subscriptions.map((item) => Object.freeze({ subscriptionId: item.subscriptionId, generation: item.generation })));
  }

  resolveReminderSnapshotTransitionWithinTransaction(context: OwnedTransactionContext, nextRevision: number, candidate: unknown,
    specification: Extract<BackgroundPolicySpecification, { kind: 'approved_reminder_delivery' }>): ResolvedBackgroundBinding {
    this.kernel.assertOwnedTransactionContext(context);
    if (!specification || specification.kind !== 'approved_reminder_delivery' || !Number.isSafeInteger(nextRevision) ||
        nextRevision !== context.revision + 1 || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return fail('background_reminder_transition_invalid');
    }
    context.assertActive();
    const row = context.db.prepare('SELECT id,owner_id,revision,privacy_epoch,snapshot_json FROM workspaces WHERE id=?')
      .get(context.workspaceId) as { id: unknown; owner_id: unknown; revision: unknown; privacy_epoch: unknown; snapshot_json: unknown } | undefined;
    if (!row || row.id !== context.workspaceId || row.owner_id !== context.ownerId || row.privacy_epoch !== context.privacyEpoch ||
        row.revision !== nextRevision || typeof row.snapshot_json !== 'string') return fail('background_reminder_transition_stale');
    let persisted: unknown;
    try { persisted = JSON.parse(row.snapshot_json); } catch { return fail('background_snapshot_invalid'); }
    const storedCanonical = canonicalBackgroundJson(persisted, 16 * 1024 * 1024);
    if (storedCanonical !== row.snapshot_json || canonicalBackgroundJson(candidate, 16 * 1024 * 1024) !== storedCanonical) {
      return fail('background_reminder_transition_mismatch');
    }
    context.assertActive();
    return resolveReminderSnapshot(persisted, context, specification);
  }
}

function resolveReminderSnapshot(canonical: unknown, context: OwnedTransactionContext,
  specification: Extract<BackgroundPolicySpecification, { kind: 'approved_reminder_delivery' }>): ResolvedBackgroundBinding {
  const remindersState = (canonical as Record<string, unknown>).reminders;
  if (!remindersState || typeof remindersState !== 'object' || Array.isArray(remindersState)) return fail('background_reminder_changed');
  const state = remindersState as Record<string, unknown>;
  if (!Array.isArray(state.records) || !Array.isArray(state.intents)) return fail('background_reminder_changed');
  const record = state.records.find((item) => item && typeof item === 'object' && !Array.isArray(item) &&
    (item as Record<string, unknown>).id === specification.reminderId) as ReminderRecord | undefined;
  if (!record || record.revision !== specification.expectedReminderRevision || record.status !== 'saved' ||
      record.approvedRevision !== record.revision || typeof record.approvedPayloadDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.approvedPayloadDigest) || !record.currentIntentId ||
      !Number.isFinite(Date.parse(record.dueAt))) return fail('background_reminder_changed');
  const intent = state.intents.find((item) => item && typeof item === 'object' && !Array.isArray(item) &&
    (item as Record<string, unknown>).id === record.currentIntentId) as ReminderIntent | undefined;
  if (!intent || intent.reminderId !== record.id || intent.reminderRevision !== record.revision ||
      !Number.isSafeInteger(intent.epoch) || intent.epoch < 1 || intent.desired !== 'scheduled' || !/^[0-9a-f]{64}$/.test(intent.payloadDigest) ||
      !intent.payload || intent.payload.dueAt !== record.dueAt || intent.payload.title !== record.title ||
      intent.payload.body !== record.body || intent.payload.displayTimeZone !== record.displayTimeZone ||
      intent.payload.privacyMode !== record.privacyMode) return fail('background_reminder_changed');
  return Object.freeze({ reminder: Object.freeze({ reminderId: record.id, revision: record.revision,
    approvedDigest: record.approvedPayloadDigest, dueAt: Date.parse(record.dueAt), privacyEpoch: context.privacyEpoch,
    intentId: intent.id, privacyMode: record.privacyMode, deviceSelection: specification.devices }) });
}
