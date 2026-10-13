import type { Account, AppState, MailboxSnapshotMessage } from '../core';
import { evaluateProactive, normalizeProactiveOffsetTimestamp } from '../proactive';
import { buildProactiveMailSources, type ProactiveSourceHashMemo } from '../proactive/adapters';
import { validateProactiveState } from '../proactive/state';
import { validateProactiveMailAlertState } from './state';
import type { CommittedMailAlertPage, MailAlertVerifiedAccount, ProactiveMailAlertReceipt, ProactiveMailSource } from './types';

export interface MailAlertWorkspacePolicyOptions {
  now: () => Date;
  digest: (text: string) => Promise<string>;
}

const PAGE_FRESHNESS_MS = 15 * 60_000;
const MAX_PAGE_IDS = 2000;
const MAX_PROVIDER_MESSAGE_ID = 2048;

function identityKey(account: Account): string | undefined {
  const identity = account.identity;
  if (!identity || (account.provider !== 'google' && account.provider !== 'microsoft') ||
      identity.providerNamespace !== account.provider || typeof identity.clientId !== 'string' || !identity.clientId ||
      typeof identity.subject !== 'string' || !identity.subject ||
      account.provider === 'microsoft' && (typeof identity.resourceUserId !== 'string' || !identity.resourceUserId)) return undefined;
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}

function canonicalTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

function asEpoch(now: () => Date): number | undefined {
  try {
    const value = now();
    const parsed = value instanceof Date ? value.getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function isObservedFresh(row: MailboxSnapshotMessage, at: number): boolean {
  if (typeof row.observedAt !== 'string') return false;
  const observedAt = Date.parse(row.observedAt);
  return Number.isFinite(observedAt) && observedAt <= at && at - observedAt < PAGE_FRESHNESS_MS;
}

function receivedAt(source: { receivedAt?: string }): number {
  if (typeof source.receivedAt !== 'string') return Number.NaN;
  try { return Date.parse(normalizeProactiveOffsetTimestamp(source.receivedAt)); }
  catch { return Number.NaN; }
}

/** Projects only exact verified provider accounts, including disconnected rows for revocation checks. */
export function mailAlertAccountsForWorkspace(state: AppState): MailAlertVerifiedAccount[] {
  if (!Array.isArray(state.accounts)) return [];
  return state.accounts.flatMap((account) => {
    if (!account || typeof account !== 'object') return [];
    const key = identityKey(account);
    const namespace = account.identity?.providerNamespace;
    if (!key || (namespace !== 'google' && namespace !== 'microsoft') || account.provider !== namespace) return [];
    return [{
      accountId: account.id,
      providerNamespace: namespace,
      identityKey: key,
      connectionGeneration: account.connectionGeneration ?? 0,
      connected: account.connected,
      authStatus: account.authStatus,
      canReadMail: Boolean(account.capabilities?.includes('mail.read')),
    }];
  });
}

/** Builds proof only from the exact IDs returned by a committed head-page request. */
export async function committedMailAlertPageForWorkspace(
  state: Pick<AppState, 'accounts' | 'mailbox'>,
  capturedAccount: Account,
  returnedIds: readonly string[],
  checkedAt: string,
  options: MailAlertWorkspacePolicyOptions,
): Promise<CommittedMailAlertPage | undefined> {
  try {
    if (!Array.isArray(returnedIds) || returnedIds.length > MAX_PAGE_IDS) return undefined;
    const checkedAtMs = canonicalTimestamp(checkedAt);
    const capturedIdentity = identityKey(capturedAccount);
    const namespace = capturedAccount.identity?.providerNamespace;
    if (checkedAtMs === undefined || !capturedIdentity || (namespace !== 'google' && namespace !== 'microsoft') ||
        !Array.isArray(state.accounts) || !Array.isArray(state.mailbox)) return undefined;
    const ids = new Set<string>();
    // Provider-facing IDs may be up to 2048 chars; the existing proactive-source validator remains stricter.
    for (const id of returnedIds) {
      if (typeof id !== 'string' || !id || id.length > MAX_PROVIDER_MESSAGE_ID || /[\r\n\0]/.test(id) || ids.has(id)) return undefined;
      ids.add(id);
    }
    if (!ids.size) return undefined;
    const account = state.accounts.find((row) => row.id === capturedAccount.id);
    if (!account || identityKey(account) !== capturedIdentity || (account.connectionGeneration ?? 0) !== (capturedAccount.connectionGeneration ?? 0)) return undefined;
    const exactRows = state.mailbox.filter((row) => row.accountId === account.id && ids.has(row.providerMessageId) &&
      row.connectionGeneration === (account.connectionGeneration ?? 0) && row.verifiedIdentityKey === capturedIdentity && !row.providerDeletedAt);
    if (!exactRows.length || new Set(exactRows.map((row) => row.providerMessageId)).size !== exactRows.length) return undefined;
    const sampledAt = asEpoch(options.now);
    if (sampledAt === undefined) return undefined;
    const memo: ProactiveSourceHashMemo = new Map();
    const sources = await buildProactiveMailSources([account], exactRows, sampledAt, memo, options.digest);
    const finalAt = asEpoch(options.now);
    if (finalAt === undefined || checkedAtMs > finalAt || finalAt - checkedAtMs > PAGE_FRESHNESS_MS) return undefined;
    const mailSources = sources.filter((source): source is ProactiveMailSource => {
      if (source.kind !== 'mail' || source.accountId !== account.id || !ids.has(source.providerId) ||
          source.availability !== 'available' || source.freshness !== 'fresh') return false;
      const row = exactRows.find((item) => item.providerMessageId === source.providerId);
      const received = receivedAt(source);
      return Boolean(row && isObservedFresh(row, finalAt) && Number.isFinite(received) && received <= finalAt);
    });
    if (!mailSources.length) return undefined;
    return { accountId: account.id, providerNamespace: namespace, identityKey: capturedIdentity,
      connectionGeneration: account.connectionGeneration ?? 0, checkedAt, sources: mailSources };
  } catch { return undefined; }
}

/** Revalidates exact committed-page evidence against current workspace rows immediately before dispatch. */
export async function isMailAlertAttemptCurrentForWorkspace(
  state: AppState,
  pages: readonly CommittedMailAlertPage[],
  receipt: ProactiveMailAlertReceipt,
  options: MailAlertWorkspacePolicyOptions,
): Promise<boolean> {
  try {
    const rawState = state as AppState & { proactiveQuarantine?: unknown; proactiveMailAlertQuarantine?: unknown };
    if (rawState.proactiveQuarantine !== undefined ||
        rawState.proactiveMailAlertQuarantine !== undefined &&
          (!Array.isArray(rawState.proactiveMailAlertQuarantine) || rawState.proactiveMailAlertQuarantine.length > 0)) return false;
    const alertState = validateProactiveMailAlertState(state.proactiveMailAlerts);
    const proactive = validateProactiveState(state.proactive);
    if (proactive.integrityError) return false;
    const page = pages.find((item) => item.accountId === receipt.accountId);
    const consent = alertState.consents.find((item) => item.id === receipt.consentId);
    const rule = proactive.rules.find((item) => item.id === receipt.ruleId);
    const account = mailAlertAccountsForWorkspace(state).find((item) => item.accountId === receipt.accountId);
    if (!consent || consent.status !== 'active' || consent.ruleId !== receipt.ruleId || consent.ruleVersion !== receipt.ruleVersion ||
        consent.ruleRevision !== receipt.ruleRevision || consent.timeZone !== receipt.timeZone || consent.activatedAt !== receipt.consentActivatedAt ||
        state.settings.timezone !== receipt.timeZone || !rule || !rule.enabled || rule.version !== receipt.ruleVersion ||
        rule.revision !== receipt.ruleRevision || rule.accountIds.length > 0 && !rule.accountIds.includes(receipt.accountId) ||
        !account || !account.connected || account.authStatus !== 'connected' || !account.canReadMail ||
        account.identityKey !== receipt.identityKey || account.connectionGeneration !== receipt.connectionGeneration ||
        !consent.accounts.some((binding) => binding.accountId === receipt.accountId && binding.identityKey === receipt.identityKey &&
          binding.connectionGeneration === receipt.connectionGeneration) ||
        !page || page.providerNamespace !== account.providerNamespace || page.identityKey !== receipt.identityKey ||
        page.connectionGeneration !== receipt.connectionGeneration || !Array.isArray(page.sources) || page.sources.length > MAX_PAGE_IDS) return false;
    const pageTime = canonicalTimestamp(page.checkedAt);
    const pageSource = page.sources.find((source) => source.kind === 'mail' && source.accountId === receipt.accountId &&
      source.providerId === receipt.providerMessageId && source.sourceVersion === receipt.sourceVersion &&
      source.availability === 'available' && source.freshness === 'fresh');
    if (pageTime === undefined || !pageSource || pageSource.kind !== 'mail') return false;
    const rows = state.mailbox.filter((row) => row.accountId === account.accountId && row.providerMessageId === receipt.providerMessageId &&
      row.verifiedIdentityKey === account.identityKey && row.connectionGeneration === account.connectionGeneration && !row.providerDeletedAt);
    if (rows.length !== 1) return false;
    const firstAt = asEpoch(options.now);
    if (firstAt === undefined) return false;
    const currentSources = await buildProactiveMailSources([state.accounts.find((row) => row.id === account.accountId)!], rows,
      firstAt, new Map(), options.digest);
    const source = currentSources.find((item): item is ProactiveMailSource => item.kind === 'mail' &&
      item.accountId === receipt.accountId && item.providerId === receipt.providerMessageId);
    // Re-sample after the awaited content digest so a stale page/source cannot pass on an old clock.
    const finalAt = asEpoch(options.now);
    if (finalAt === undefined || finalAt < pageTime || finalAt - pageTime > PAGE_FRESHNESS_MS || !source ||
        source.availability !== 'available' || source.freshness !== 'fresh' || source.sourceVersion !== receipt.sourceVersion ||
        receivedAt(source) !== Date.parse(receipt.receivedAt) || receivedAt(source) <= Date.parse(consent.activatedAt) ||
        receivedAt(source) > finalAt || !isObservedFresh(rows[0], finalAt)) return false;
    const evaluation = evaluateProactive({
      nowUtc: new Date(finalAt).toISOString(), timeZone: consent.timeZone, rules: [rule], sources: [source],
      previousCandidates: proactive.candidates.map((entry) => entry.candidate),
      dismissedCandidateIds: proactive.dismissals.map((item) => item.candidateId),
      snoozes: proactive.snoozes,
      sourceSnapshotComplete: false,
    });
    return evaluation.activeCandidates.some((candidate) => candidate.ruleId === rule.id &&
      candidate.sourceId === source.sourceId && candidate.sourceVersion === source.sourceVersion);
  } catch { return false; }
}
