import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadServerConfig } from '../../dist/config.js';
import { openServerFoundationInternal } from '../../dist/bootstrap.js';
import { BackgroundProactiveCandidateIndex } from '../../dist/backgroundProactiveCandidates.js';
import { BackgroundOccurrenceStore } from '../../dist/backgroundOccurrences.js';
import { BackgroundPolicyStore } from '../../dist/backgroundPolicies.js';
import { canonicalBackgroundJson } from '../../dist/backgroundContracts.js';
import { createInitialWorkspaceState } from '../../dist/sharedControllerNode.mjs';

const [dataDirectory, keyFile, staticRoot, mode = 'unmapped'] = process.argv.slice(2);
if (!dataDirectory || !keyFile || !staticRoot || !['unmapped', 'mapped'].includes(mode)) throw new Error('fixture_arguments_invalid');
mkdirSync(dataDirectory, { recursive: true });
const config = loadServerConfig({ STILL_ORIGIN: 'https://app.example.test', STILL_DATA_DIR: dataDirectory,
  STILL_VAULT_KEY_FILE: keyFile }, { staticRoot });
const opened = openServerFoundationInternal(config);
opened.privateContext.startup.beginRecovery();
opened.privateContext.startup.seal();
const now = Date.now();
const initial = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
  openRouterReasoningEffort: 'low', llmRequestContractVersion: 1 });
const accountId = 'google:fixture-account';
const ruleId = 'fixture-rule';
const providerMessageId = 'fixture-message';
const identity = Object.freeze({ providerNamespace: 'google', clientId: 'fixture-client', subject: 'fixture-subject', issuer: 'https://accounts.google.com' });
const verifiedIdentityKey = `${identity.providerNamespace}:${identity.clientId}:${identity.subject}:`;
const accountIdentityKey = createHash('sha256').update(JSON.stringify({ provider: 'google', providerNamespace: 'google',
  clientId: identity.clientId, subject: identity.subject, issuer: identity.issuer, tenantId: null, resourceUserId: null }), 'utf8').digest('hex');
const rule = { id: ruleId, revision: 7, version: 7, enabled: true, accountIds: [accountId],
  trigger: { type: 'unread_from', addresses: ['fixture-sender@example.test'] }, name: 'Fixture unread sender',
  createdAt: new Date(now - 60_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString() };
initial.accounts.push({ id: accountId, provider: 'google', displayName: 'Fixture account', email: 'owner@example.test', connected: true,
  authStatus: 'connected', identity, tokenRef: 'fixture-token-ref', grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
  capabilities: ['mail.read'], capabilityLimits: ['mail.read'], connectionGeneration: 4, syncStatus: 'idle' });
initial.proactive.rules.push(rule);
initial.mailbox.push({ id: 'fixture-local-message', accountId, providerMessageId,
  identityKey: `${verifiedIdentityKey}:${providerMessageId}`, verifiedIdentityKey, connectionGeneration: 4, idFormat: 'gmail',
  senderEmail: 'fixture-sender@example.test', isRead: false, subject: 'Fixture message',
  receivedAt: new Date(now - 60_000).toISOString(), observedAt: new Date(now - 1_000).toISOString() });
initial.proactive.candidates.push({ presentation: 'active', candidate: { id: JSON.stringify([ruleId, 7, 'fixture-source', 'b'.repeat(64)]),
  suppressionKey: JSON.stringify([ruleId, 'fixture-source']), ruleId, ruleRevision: 7, sourceId: JSON.stringify(['google', accountId, providerMessageId]),
  sourceVersion: 'b'.repeat(64), sourceKind: 'mail', namespace: 'google', accountId, providerId: providerMessageId,
  eligibleAt: new Date(now - 1_000).toISOString(), reasonCode: 'unread_sender', quote: 'fixture-sender@example.test', quoteField: 'senderEmail' } });
const { ownerId, workspaceId } = await opened.foundation.auth.enrollOwner('synthetic proactive recovery password', initial);
const kernel = opened.privateContext.kernel;
const actor = kernel.createSession(workspaceId, ownerId, now + 60 * 60_000);
const index = new BackgroundProactiveCandidateIndex(kernel);
const policyId = randomUUID();
const resolver = { resolve(_context, specification) {
  return { accounts: specification.accounts.map((entry) => ({ accountId: entry.accountId, provider: 'google', identityKey: accountIdentityKey,
    connectionGeneration: entry.expectedConnectionGeneration, label: 'Fixture account', connected: true })),
    rule: { ruleId: specification.ruleId, revision: 7, specificationDigest: createHash('sha256').update(canonicalBackgroundJson({ id: rule.id,
      revision: rule.revision, enabled: rule.enabled, accountIds: rule.accountIds, trigger: rule.trigger }), 'utf8').digest('hex') } };
} };
if (mode === 'mapped') {
  const challenge = opened.foundation.auth.createLoginChallenge('https://app.example.test');
  const browserToken = (await opened.foundation.auth.login({ password: 'synthetic proactive recovery password', origin: 'https://app.example.test',
    preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken })).sessionToken;
  new BackgroundPolicyStore({ kernel, auth: opened.foundation.auth, resolver, clock: () => now }).save(browserToken, {
    commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId, expectedPolicyRevision: 0, enabled: true,
    specification: { kind: 'proactive_draft', ruleId: 'fixture-rule', expectedRuleRevision: 7,
      accounts: [{ accountId: 'google:fixture-account', expectedConnectionGeneration: 4 }], brief: 'Synthetic saved consent', replyMode: 'reply',
      paidConsent: { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'none' } },
  });
}
const candidateProjection = { schemaVersion: 1, valid: true, candidates: [{ ruleId, ruleRevision: 7,
  accountId, accountIdentityKey, connectionGeneration: 4,
  providerMessageId, localMessageId: 'fixture-local-message', sourceVersion: 'b'.repeat(64), eligibleAt: now - 1 }] };
const attempt = kernel.withOwnedTransaction(actor, 0, (context) => {
  index.reconcile(context, candidateProjection, context.revision, now);
  const candidate = index.listDueForPolicy(context, { ruleId, ruleRevision: 7, policyId, policyRevision: 1, now })[0];
  if (!candidate) throw new Error('fixture_candidate_missing');
  const claim = index.prepareClaim({ candidateId: candidate.candidateId, policyId, policyRevision: 1,
    ruleId, ruleRevision: 7, workspaceId, ownerId, privacyEpoch: 0 });
  if (!index.claim(context, candidate.candidateId, policyId, 1, ruleId, 7, now, claim)) throw new Error('fixture_claim_missing');
  index.markReadingWithinTransaction(context, claim, now);
  return { attemptId: claim.attemptId, candidateId: candidate.candidateId, claim };
});
let paidOccurrenceId;
let paidAttemptId;
if (mode === 'mapped') {
  const occurrences = new BackgroundOccurrenceStore({ kernel, actorSessionToken: actor, resolver, clock: () => now });
  const occurrence = occurrences.schedule({ expectedPrivacyEpoch: 0, policyId, expectedPolicyRevision: 1,
    descriptor: { kind: 'proactive_draft', accountIdentityKey, providerMessageId: 'fixture-message' }, scheduledAt: now - 1,
    source: { sourceDigest: 'e'.repeat(64) }, request: { requestDigest: 'f'.repeat(64) } });
  const claimed = occurrences.claimProactive({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId, targetId: accountIdentityKey,
    targetGeneration: 4, preflightIndex: index, preflightClaim: attempt.claim });
  paidOccurrenceId = claimed.occurrence.occurrenceId;
  paidAttemptId = claimed.claim.attemptId;
}
await new Promise((resolve) => process.stdout.write(`${JSON.stringify({ ownerId, workspaceId, policyId, attemptId: attempt.attemptId,
  candidateId: attempt.candidateId, paidOccurrenceId, paidAttemptId, mode })}\n`, resolve));
process.exit(73);
