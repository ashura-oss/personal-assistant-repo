import { evaluateProactive, normalizeProactiveOffsetTimestamp, validateProactiveSource, type ProactiveRule } from '../proactive';
import { isValidAccountId } from '../core/accountIds';
import { MAX_MAIL_ALERT_ACCOUNTS_PER_CONSENT, MAX_MAIL_ALERT_CONSENTS, MAX_MAIL_ALERT_RECEIPTS, validateProactiveMailAlertConsent, validateProactiveMailAlertState } from './state';
import type {
  MailAlertAccountBinding, MailAlertVerifiedAccount, CommittedMailAlertPage, MailAlertRule, ProactiveMailAlertConsent,
  ProactiveMailAlertConsentInput, ProactiveMailAlertPlan, ProactiveMailAlertPlanInput,
  ProactiveMailAlertReceipt, ProactiveMailAlertState,
} from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ROLLING_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 2;
const MAX_PER_ROLLING_DAY = 20;
const PAGE_FRESHNESS_MS = 15 * 60_000;

function fail(message: string): never { throw new Error(message); }
function validateIdentifier(value: string, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function validateAccountId(value: unknown): string {
  if (!isValidAccountId(value)) fail('Mail alert account ID is invalid.');
  return value;
}
function validateUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a canonical UUID.`);
  return value.toLowerCase();
}
function parseCanonicalUtc(value: string, label: string): number {
  if (typeof value !== 'string' || !CANONICAL_UTC.test(value)) fail(`${label} must be canonical UTC.`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(`${label} is invalid.`);
  return epoch;
}
function validZone(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) fail('Mail alert time zone is invalid.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); }
  catch { fail('Mail alert time zone is invalid.'); }
  return value;
}
function verifiedIdentity(account: MailAlertVerifiedAccount): boolean {
  if (!account || (account.providerNamespace !== 'google' && account.providerNamespace !== 'microsoft') ||
      account.connected !== true || account.authStatus !== 'connected' || account.canReadMail !== true ||
      !Number.isSafeInteger(account.connectionGeneration) || account.connectionGeneration < 0 ||
      typeof account.identityKey !== 'string' || !account.identityKey || account.identityKey.length > 2048 ||
      /[\u0000-\u001f\u007f]/.test(account.identityKey) ||
      account.identityKey.split(':').length !== 4 || account.identityKey.slice(0, account.identityKey.indexOf(':')) !== account.providerNamespace) return false;
  try { validateAccountId(account.accountId); } catch { return false; }
  return true;
}
function bindingOf(account: MailAlertVerifiedAccount): MailAlertAccountBinding {
  return { accountId: validateAccountId(account.accountId), identityKey: account.identityKey,
    connectionGeneration: account.connectionGeneration };
}
function sameBinding(a: MailAlertAccountBinding, b: MailAlertAccountBinding): boolean {
  return a.accountId === b.accountId && a.identityKey === b.identityKey && a.connectionGeneration === b.connectionGeneration;
}
function mailRule(rule: ProactiveRule): boolean {
  return rule.trigger.type === 'unread_from' || rule.trigger.type === 'keyword';
}
function cancellationRequested(receipt: ProactiveMailAlertReceipt, at: string): ProactiveMailAlertReceipt {
  if (receipt.desired === 'cancel') return receipt;
  return { ...receipt, desired: 'cancel', updatedAt: at,
    ...(receipt.observed === 'attempting' ? {} : { observed: 'cancellation_pending' as const }),
    cancellation: { requestedAt: at, result: 'requested' } };
}
function dedupeKey(consentId: string, accountId: string, identityKey: string, generation: number, providerMessageId: string): string {
  return JSON.stringify([consentId, accountId, identityKey, generation, providerMessageId]);
}
function sourceReceivedAt(source: { receivedAt?: string }): number | undefined {
  const value = source.receivedAt;
  if (typeof value !== 'string') return undefined;
  try { return Date.parse(normalizeProactiveOffsetTimestamp(value)); } catch { return undefined; }
}
function validateRuleSnapshot(rule: MailAlertRule, now: string, zone: string): void {
  if (!Number.isSafeInteger(rule.version) || rule.version < 1 || !Number.isSafeInteger(rule.revision) || rule.revision < 1) {
    fail('Mail alert planner rule version is invalid.');
  }
  validateIdentifier(rule.id, 'Mail alert rule ID');
  // The shared evaluator owns the canonical rule schema and quiet-hours validation.
  evaluateProactive({ nowUtc: now, timeZone: zone, rules: [rule], sources: [], sourceSnapshotComplete: false });
}
function validateMailRule(rule: MailAlertRule, now: string, zone: string): void {
  if (!rule.enabled || !mailRule(rule)) fail('Mail alert consent requires an enabled mail rule.');
  validateRuleSnapshot(rule, now, zone);
}
function makeConsent(input: ProactiveMailAlertConsentInput): ProactiveMailAlertConsent {
  const id = validateUuid(input.id, 'Mail alert consent ID');
  const zone = validZone(input.timeZone);
  const activatedAt = new Date(parseCanonicalUtc(input.activatedAt, 'Consent activation time')).toISOString();
  validateMailRule(input.rule, activatedAt, zone);
  if (!Array.isArray(input.accounts) || input.accounts.length < 1 || input.accounts.length > MAX_MAIL_ALERT_ACCOUNTS_PER_CONSENT) {
    fail('Choose between 1 and 64 verified accounts for mail alerts.');
  }
  const accounts = input.accounts.map((account) => {
    if (!verifiedIdentity(account)) fail('Mail alert consent requires a connected verified mail account.');
    if (input.rule.accountIds.length > 0 && !input.rule.accountIds.includes(account.accountId)) fail('Mail alert account is outside the saved rule scope.');
    return bindingOf(account);
  }).sort((a, b) => a.accountId.localeCompare(b.accountId));
  if (new Set(accounts.map((item) => item.accountId)).size !== accounts.length) fail('Mail alert consent account IDs must be unique.');
  return validateProactiveMailAlertConsent({ id, ruleId: validateIdentifier(input.rule.id, 'Mail alert rule ID'),
    ruleVersion: input.rule.version, ruleRevision: input.rule.revision, timeZone: zone, activatedAt, accounts, status: 'active' });
}
function validateRuleInput(rule: MailAlertRule, now: string, zone: string, requireEnabled = false): void {
  if (!rule || !Array.isArray(rule.accountIds)) fail('Mail alert rule is invalid.');
  if (requireEnabled) validateMailRule(rule, now, zone);
  else validateRuleSnapshot(rule, now, zone);
}

/** Explicitly binds consent to the exact enabled rule and currently verified accounts. */
export function createProactiveMailAlertConsent(input: ProactiveMailAlertConsentInput): ProactiveMailAlertConsent {
  return makeConsent(input);
}

/** Re-opt-in replaces the rule's current consent while preserving old receipts as cancellable history. */
export function replaceProactiveMailAlertConsent(stateInput: ProactiveMailAlertState, input: ProactiveMailAlertConsentInput): ProactiveMailAlertState {
  const state = validateProactiveMailAlertState(stateInput);
  const consent = makeConsent(input);
  const consents = [...state.consents.filter((item) => item.ruleId !== consent.ruleId), consent];
  if (consents.length > MAX_MAIL_ALERT_CONSENTS) fail('Mail alert consent limit is reached.');
  const receipts = state.receipts.map((receipt) => {
    if (receipt.ruleId !== consent.ruleId || receipt.desired === 'cancel' || receipt.observed === 'cancelled') return receipt;
    return cancellationRequested(receipt, consent.activatedAt);
  });
  const next = { ...state, revision: state.revision + 1, consents, receipts };
  return validateProactiveMailAlertState(next);
}

/** User revocation is durable state; receipts are retained and receive explicit cancellation intent. */
export function revokeProactiveMailAlertConsent(stateInput: ProactiveMailAlertState, ruleIdValue: string, atValue: string): ProactiveMailAlertState {
  const state = validateProactiveMailAlertState(stateInput);
  const ruleId = validateIdentifier(ruleIdValue, 'Mail alert rule ID');
  const at = new Date(parseCanonicalUtc(atValue, 'Consent revocation time')).toISOString();
  let changed = false;
  const consents = state.consents.map((item) => {
    if (item.ruleId !== ruleId || item.status === 'revoked') return item;
    changed = true;
    return { ...item, status: 'revoked' as const, revokedAt: at, revocationReason: 'user_revoked' as const };
  });
  const receipts = state.receipts.map((receipt) => {
    if (receipt.ruleId !== ruleId || receipt.desired === 'cancel' || receipt.observed === 'cancelled') return receipt;
    changed = true;
    return cancellationRequested(receipt, at);
  });
  return validateProactiveMailAlertState({ ...state, revision: changed ? state.revision + 1 : state.revision, consents, receipts });
}

/** Recovery revokes all extant rule consent and preserves every receipt while requesting cancellation once. */
export function revokeAllProactiveMailAlertConsentsForRecovery(stateInput: ProactiveMailAlertState, atValue: string): ProactiveMailAlertState {
  const state = validateProactiveMailAlertState(stateInput);
  const at = new Date(parseCanonicalUtc(atValue, 'Mail alert recovery time')).toISOString();
  let changed = false;
  const consents = state.consents.map((item) => {
    if (item.status === 'revoked') return item;
    changed = true;
    return { ...item, status: 'revoked' as const, revokedAt: at, revocationReason: 'user_revoked' as const };
  });
  const receipts = state.receipts.map((receipt) => {
    if (receipt.desired === 'cancel' || receipt.observed === 'cancelled') return receipt;
    changed = true;
    return cancellationRequested(receipt, at);
  });
  return validateProactiveMailAlertState({ ...state, revision: changed ? state.revision + 1 : state.revision, consents, receipts });
}

/**
 * Builds a bounded deterministic plan from one fresh mail-head snapshot. It performs no IO;
 * the caller persists `nextState` before dispatching any `newAttempts`.
 */
export function planProactiveMailAlerts(input: ProactiveMailAlertPlanInput): ProactiveMailAlertPlan {
  const state = validateProactiveMailAlertState(input.state);
  const nowMs = parseCanonicalUtc(input.now, 'Mail alert check time');
  const now = new Date(nowMs).toISOString();
  const currentZone = validZone(input.currentTimeZone);
  if (!Array.isArray(input.rules) || input.rules.length > MAX_MAIL_ALERT_CONSENTS ||
      !Array.isArray(input.accounts) || input.accounts.length > MAX_MAIL_ALERT_ACCOUNTS_PER_CONSENT * MAX_MAIL_ALERT_CONSENTS ||
      !Array.isArray(input.pages) || input.pages.length > MAX_MAIL_ALERT_ACCOUNTS_PER_CONSENT * MAX_MAIL_ALERT_CONSENTS ||
      (input.previousCandidates && input.previousCandidates.length > MAX_MAIL_ALERT_RECEIPTS) ||
      (input.dismissedCandidateIds && input.dismissedCandidateIds.length > MAX_MAIL_ALERT_RECEIPTS) ||
      (input.snoozes && input.snoozes.length > MAX_MAIL_ALERT_RECEIPTS)) fail('Mail alert planner input exceeds its bounded limits.');
  const rules = new Map<string, MailAlertRule>();
  for (const rule of input.rules) {
    validateRuleInput(rule, now, currentZone, false);
    if (rules.has(rule.id)) fail('Mail alert planner received duplicate rule IDs.');
    rules.set(rule.id, rule);
  }
  const accountMap = new Map<string, MailAlertVerifiedAccount>();
  for (const account of input.accounts) {
    if (!account || accountMap.has(account.accountId)) fail('Mail alert planner received duplicate or invalid account IDs.');
    validateAccountId(account.accountId);
    accountMap.set(account.accountId, account);
  }
  const pageAccounts = new Set<string>();
  const sources = [] as CommittedMailAlertPage['sources'][number][];
  for (const page of input.pages) {
    if (pageAccounts.has(page.accountId)) fail('Mail alert planner received more than one committed page for an account.');
    pageAccounts.add(page.accountId);
    const account = accountMap.get(page.accountId);
    const checkedAt = parseCanonicalUtc(page.checkedAt, 'Committed mail page time');
    if (nowMs - checkedAt < 0 || nowMs - checkedAt > PAGE_FRESHNESS_MS ||
        !account || !verifiedIdentity(account) || page.providerNamespace !== account.providerNamespace ||
        page.identityKey !== account.identityKey || page.connectionGeneration !== account.connectionGeneration ||
        !Array.isArray(page.sources) || page.sources.length > 2000) continue;
    for (const source of page.sources) {
      validateProactiveSource(source);
      if (source.kind === 'mail' && source.accountId === page.accountId && source.namespace === page.providerNamespace) sources.push(source);
      if (sources.length > 2000) fail('Committed mail pages exceed the planner source limit.');
    }
  }
  const uuidSet = new Set<string>([...state.consents.map((row) => row.id), ...state.receipts.map((row) => row.id)]);
  const makeId = () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = validateUuid(input.uuid(), 'Generated mail alert ID');
      if (!uuidSet.has(id)) { uuidSet.add(id); return id; }
    }
    return fail('Could not allocate a unique mail alert receipt ID.');
  };
  let changed = false;
  const revokedConsentIds: string[] = [];
  const consents = state.consents.map((consent) => {
    if (consent.status !== 'active') return consent;
    const rule = rules.get(consent.ruleId);
    let reason: ProactiveMailAlertConsent['revocationReason'];
    if (!rule?.enabled) reason = 'rule_disabled';
    else if (!mailRule(rule) || rule.version !== consent.ruleVersion || rule.revision !== consent.ruleRevision) reason = 'rule_changed';
    else if (consent.timeZone !== currentZone) reason = 'time_zone_changed';
    else if (consent.accounts.some((binding) => {
      const account = accountMap.get(binding.accountId);
      return !account || !verifiedIdentity(account) || !sameBinding(binding, bindingOf(account)) ||
        (rule.accountIds.length > 0 && !rule.accountIds.includes(binding.accountId));
    })) reason = 'account_changed';
    if (!reason) return consent;
    changed = true;
    revokedConsentIds.push(consent.id);
    return { ...consent, status: 'revoked' as const, revokedAt: now, revocationReason: reason };
  });
  const revokedIds = new Set(revokedConsentIds);
  let receipts = state.receipts.map((receipt) => {
    if (!revokedIds.has(receipt.consentId) || receipt.desired === 'cancel' || receipt.observed === 'cancelled') return receipt;
    changed = true;
    return cancellationRequested(receipt, now);
  });
  const cancellationReceipts = receipts.filter((receipt) => receipt.desired === 'cancel' && receipt.observed !== 'cancelled');
  const seen = new Set(receipts.map((row) => dedupeKey(row.consentId, row.accountId, row.identityKey, row.connectionGeneration, row.providerMessageId)));
  const activeConsents = consents.filter((item) => item.status === 'active');
  let attemptsIn24h = receipts.filter((item) => item.attemptedAt !== undefined && Date.parse(item.attemptedAt) >= nowMs - ROLLING_DAY_MS).length;
  let attemptsThisRun = 0;
  let quietSkippedCount = 0;
  let quotaSkippedCount = 0;
  let receiptCapacityReached = receipts.length >= MAX_MAIL_ALERT_RECEIPTS;
  const newAttempts: ProactiveMailAlertReceipt[] = [];

  if (!receiptCapacityReached && attemptsIn24h < MAX_PER_ROLLING_DAY) {
    for (const consent of activeConsents) {
      if (attemptsThisRun >= MAX_PER_RUN || attemptsIn24h >= MAX_PER_ROLLING_DAY || receipts.length + newAttempts.length >= MAX_MAIL_ALERT_RECEIPTS) break;
      const rule = rules.get(consent.ruleId);
      if (!rule || !rule.enabled || !mailRule(rule) || rule.version !== consent.ruleVersion || rule.revision !== consent.ruleRevision) continue;
      const sourceRows = sources.filter((source) => {
        if (source.kind !== 'mail' || !source.accountId || source.availability !== 'available' || source.freshness !== 'fresh') return false;
        const binding = consent.accounts.find((item) => item.accountId === source.accountId);
        const account = binding && accountMap.get(binding.accountId);
        const receivedAt = sourceReceivedAt(source);
        if (!binding || !account || !verifiedIdentity(account) || !sameBinding(binding, bindingOf(account)) ||
            source.namespace !== account.providerNamespace || receivedAt === undefined ||
            receivedAt <= Date.parse(consent.activatedAt) || receivedAt > nowMs) return false;
        return rule.accountIds.length === 0 || rule.accountIds.includes(account.accountId);
      });
      if (sourceRows.length === 0) continue;
      const evaluation = evaluateProactive({ nowUtc: now, timeZone: consent.timeZone, rules: [rule], sources: sourceRows,
        previousCandidates: input.previousCandidates ? [...input.previousCandidates] : undefined,
        dismissedCandidateIds: input.dismissedCandidateIds ? [...input.dismissedCandidateIds] : undefined,
        snoozes: input.snoozes ? [...input.snoozes] : undefined,
        sourceSnapshotComplete: false });
      quietSkippedCount += evaluation.deferredCandidates.length;
      for (const candidate of evaluation.activeCandidates) {
        const source = sourceRows.find((row) => row.sourceId === candidate.sourceId);
        if (!source || source.kind !== 'mail' || !source.accountId) continue;
        const account = accountMap.get(source.accountId);
        const binding = consent.accounts.find((item) => item.accountId === source.accountId);
        if (!account || !binding || !source.receivedAt) continue;
        const key = dedupeKey(consent.id, account.accountId, binding.identityKey, binding.connectionGeneration, source.providerId);
        if (seen.has(key)) continue;
        if (attemptsThisRun >= MAX_PER_RUN || attemptsIn24h >= MAX_PER_ROLLING_DAY || receipts.length + newAttempts.length >= MAX_MAIL_ALERT_RECEIPTS) {
          quotaSkippedCount++;
          receiptCapacityReached ||= receipts.length + newAttempts.length >= MAX_MAIL_ALERT_RECEIPTS;
          continue;
        }
        const id = makeId();
        const canonicalReceivedAt = normalizeProactiveOffsetTimestamp(source.receivedAt);
        const receipt: ProactiveMailAlertReceipt = {
          id, installationId: state.installationId, consentId: consent.id, ruleId: consent.ruleId, ruleVersion: consent.ruleVersion, ruleRevision: consent.ruleRevision,
          timeZone: consent.timeZone, consentActivatedAt: consent.activatedAt,
          accountId: account.accountId, identityKey: binding.identityKey, connectionGeneration: binding.connectionGeneration,
          providerMessageId: source.providerId, sourceVersion: source.sourceVersion, receivedAt: canonicalReceivedAt,
          desired: 'notify', observed: 'attempting', createdAt: now, updatedAt: now, attemptedAt: now,
        };
        newAttempts.push(receipt);
        seen.add(key);
        attemptsThisRun++;
        attemptsIn24h++;
      }
    }
  } else if (receiptCapacityReached) {
    receiptCapacityReached = true;
  }
  if (newAttempts.length > 0) changed = true;
  receipts = [...receipts, ...newAttempts];
  const nextState = validateProactiveMailAlertState({ ...state, revision: changed ? state.revision + 1 : state.revision, consents, receipts });
  return { nextState, newAttempts, cancellationReceipts, revokedConsentIds, quietSkippedCount, quotaSkippedCount, receiptCapacityReached };
}
