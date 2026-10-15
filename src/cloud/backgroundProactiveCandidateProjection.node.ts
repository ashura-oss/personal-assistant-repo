import { createHash } from 'node:crypto';
import type { AppState, ProactiveCandidateEntry } from '../core';
import { canonicalVerifiedProviderIdentity } from '../core';
import { scopeGrantsCapability } from '../connectors/oauth';
import type { BackgroundProactiveCandidateProjection } from '../../server/src/backgroundProactiveCandidates.js';
import type { OwnedTransactionContext } from '../../server/src/kernel.js';
import type { SnapshotCommitParticipant, SnapshotCommitParticipantInput } from '../../server/src/workspaceStore.js';
import { BackgroundProactiveCandidateIndex } from '../../server/src/backgroundProactiveCandidates.js';

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

/**
 * Projects only already-evaluated, content-free mail candidate metadata from the exact persisted snapshot.
 * No message body, subject, snippet, sender, quote, or provider credential is copied into the private index.
 */
export function projectBackgroundProactiveCandidates(snapshot: unknown, now: number): BackgroundProactiveCandidateProjection {
  if (!Number.isSafeInteger(now) || now < 0 || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return Object.freeze({ schemaVersion: 1, valid: false, candidates: Object.freeze([]) });
  }
  const state = snapshot as Partial<AppState>;
  if (!Array.isArray(state.accounts) || !Array.isArray(state.mailbox) || !state.proactive ||
      !Array.isArray(state.proactive.rules) || !Array.isArray(state.proactive.candidates)) {
    return Object.freeze({ schemaVersion: 1, valid: false, candidates: Object.freeze([]) });
  }

  const candidates: BackgroundProactiveCandidateProjection['candidates'][number][] = [];
  for (const entry of state.proactive.candidates as ProactiveCandidateEntry[]) {
    if (!entry || !entry.candidate || (entry.presentation !== 'active' && entry.presentation !== 'deferred')) continue;
    const candidate = entry.candidate;
    if (candidate.sourceKind !== 'mail' || !candidate.accountId || !candidate.providerId || !candidate.sourceVersion ||
        !Number.isSafeInteger(candidate.ruleRevision) || candidate.ruleRevision < 1) continue;
    const rule = state.proactive.rules.find((item) => item.id === candidate.ruleId && item.version === candidate.ruleRevision && item.enabled);
    if (!rule) continue;
    const account = state.accounts.find((item) => item.id === candidate.accountId);
    if (!account || (account.provider !== 'google' && account.provider !== 'microsoft') || !account.connected ||
        account.authStatus !== 'connected' || !account.identity || !account.capabilities?.includes('mail.read') ||
        !account.grantedScopes || !scopeGrantsCapability(account.provider, account.grantedScopes, 'mail.read') ||
        (account.capabilityLimits && !account.capabilityLimits.includes('mail.read')) || !Number.isSafeInteger(account.connectionGeneration) ||
        (account.connectionGeneration ?? 0) < 1 || !rule.accountIds.includes(account.id)) continue;
    let identityKey: string;
    try { identityKey = sha256(canonicalVerifiedProviderIdentity(account)); } catch { continue; }
    const verifiedIdentityKey = [account.identity.providerNamespace, account.identity.clientId, account.identity.subject,
      account.identity.resourceUserId ?? ''].join(':');
    const matched = state.mailbox.find((item) => item.accountId === account.id && item.providerMessageId === candidate.providerId &&
      item.connectionGeneration === account.connectionGeneration && item.verifiedIdentityKey !== undefined &&
      item.verifiedIdentityKey === verifiedIdentityKey && item.identityKey === `${verifiedIdentityKey}:${candidate.providerId}` &&
      !item.providerDeletedAt);
    if (!matched || candidate.sourceId !== JSON.stringify([account.identity.providerNamespace, account.id, candidate.providerId])) continue;
    const eligibleAt = Date.parse(candidate.eligibleAt);
    if (!Number.isFinite(eligibleAt) || eligibleAt < 0) continue;
    candidates.push(Object.freeze({ ruleId: rule.id, ruleRevision: rule.version, accountId: account.id, accountIdentityKey: identityKey,
      connectionGeneration: account.connectionGeneration!, providerMessageId: candidate.providerId, localMessageId: matched.id,
      sourceVersion: candidate.sourceVersion, eligibleAt }));
  }
  return Object.freeze({ schemaVersion: 1, valid: true, candidates: Object.freeze(candidates) });
}

export function createBackgroundProactiveCandidateSnapshotParticipant(index: BackgroundProactiveCandidateIndex,
  now: () => number = Date.now): SnapshotCommitParticipant<AppState> {
  if (!index || typeof index.reconcile !== 'function' || typeof now !== 'function' || now.constructor?.name === 'AsyncFunction') {
    throw new Error('background_proactive_candidate_participant_unavailable');
  }
  return Object.freeze({
    commit(context: OwnedTransactionContext, input: SnapshotCommitParticipantInput<AppState>) {
      context.assertActive();
      if (input.nextRevision !== context.revision + 1) throw new Error('background_proactive_snapshot_revision_changed');
      const current = now();
      if (!Number.isSafeInteger(current) || current < 0) throw new Error('background_proactive_candidate_time_invalid');
      index.reconcile(context, projectBackgroundProactiveCandidates(input.nextSnapshot, current), input.nextRevision, current);
    },
  });
}
