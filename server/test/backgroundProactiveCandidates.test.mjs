import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { AuthService, createDurableKernel } from '../dist/index.js';
import { BackgroundProactiveCandidateIndex } from '../dist/backgroundProactiveCandidates.js';
import { BackgroundPolicyStore } from '../dist/backgroundPolicies.js';
import { ServerWorkspaceStore, composeSnapshotCommitParticipants } from '../dist/workspaceRuntime.js';
import { validatePhysicalWorkspaceSnapshot } from '../dist/bootstrap.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { build } from 'esbuild';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 7));
const origin = 'https://still.example';
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-candidates-'));
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), now: () => now,
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const auth = new AuthService(kernel, { canonicalOrigin: origin, authSecret, now: () => now });
  const { ownerId, workspaceId } = await auth.enrollOwner('correct horse battery staple', { notes: [] });
  const challenge = auth.createLoginChallenge(origin);
  const browserToken = (await auth.login({ password: 'correct horse battery staple', origin,
    preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken })).sessionToken;
  const actorToken = kernel.createSession(workspaceId, ownerId, now + 24 * 60 * 60_000);
  const index = new BackgroundProactiveCandidateIndex(kernel);
  const policyId = randomUUID();
  const projection = Object.freeze({ schemaVersion: 1, valid: true, candidates: Object.freeze([Object.freeze({
    ruleId: 'rule-1', ruleRevision: 7, accountId: 'google:account-1', accountIdentityKey: 'a'.repeat(64), connectionGeneration: 4,
    providerMessageId: 'provider-message-1', localMessageId: 'local-message-1', sourceVersion: 'b'.repeat(64), eligibleAt: now - 1000,
  })]) });
  const resolver = { resolve(_context, specification) {
    const selections = specification.kind === 'proactive_draft' ? specification.accounts : [];
    return { ...(selections.length ? { accounts: selections.map((item) => ({ accountId: item.accountId, provider: 'google',
      identityKey: 'c'.repeat(64), connectionGeneration: item.expectedConnectionGeneration, label: 'Account', connected: true })) } : {}),
      ...(specification.kind === 'proactive_draft' ? { rule: { ruleId: specification.ruleId, revision: 7, specificationDigest: 'd'.repeat(64) } } : {}) };
  } };
  let callbackHeadSeen = false;
  const policies = new BackgroundPolicyStore({ kernel, auth, resolver, clock: () => now,
    onProactivePolicyEnabledWithinTransaction(context, timestamp) {
      callbackHeadSeen = Boolean(context.db.prepare(`SELECT 1 AS found FROM background_policy_heads WHERE workspace_id=? AND owner_id=?
        AND privacy_epoch=? AND policy_id=? AND current_revision=1 AND status='enabled'`).get(context.workspaceId, context.ownerId, context.privacyEpoch, policyId));
      index.reconcile(context, projection, context.revision, timestamp);
    } });
  return { directory, kernel, auth, ownerId, workspaceId, browserToken, actorToken, now, index, projection, policies, policyId,
    get callbackHeadSeen() { return callbackHeadSeen; } };
}

function cleanup(fixture) {
  try { fixture.auth.close(); } catch {}
  try { fixture.kernel.close(); } catch {}
  rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function proactivePolicy(policyId, revision = 0, commandId = randomUUID()) {
  return { commandId, expectedPrivacyEpoch: 0, policyId, expectedPolicyRevision: revision, enabled: true,
    specification: { kind: 'proactive_draft', ruleId: 'rule-1', expectedRuleRevision: 7,
      accounts: [{ accountId: 'google:account-1', expectedConnectionGeneration: 4 }], brief: 'Reply carefully', replyMode: 'reply',
      paidConsent: { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'none' } } };
}

test('candidate index validates schema, reconciles content-free rows, and pages exact policy-head work', async () => {
  const f = await setup();
  try {
    const receipt = f.policies.save(f.browserToken, proactivePolicy(f.policyId));
    assert.equal(receipt.status, 'enabled');
    assert.equal(f.callbackHeadSeen, true);
    const due = f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => {
      assert.equal(f.index.hasScope(context), true);
      return f.index.listDueForPolicy(context, { ruleId: 'rule-1', ruleRevision: 7, policyId: f.policyId,
        policyRevision: 1, now: f.now, limit: 10 });
    });
    assert.equal(due.length, 1);
    const candidate = due[0];
    assert.ok(candidate.candidateId);
    assert.equal(Object.hasOwn(candidate, 'text'), false);
    const first = f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.claim(context, candidate.candidateId,
      f.policyId, 1, 'rule-1', 7, f.now));
    assert.ok(first);
    assert.equal(first.workspaceId, f.workspaceId);
    assert.equal(first.ownerId, f.ownerId);
    assert.equal(first.capability.length, 36);
    assert.equal(f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.claim(context, candidate.candidateId,
      f.policyId, 1, 'rule-1', 7, f.now)), undefined);
    f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => {
      f.index.markReadingWithinTransaction(context, first, f.now + 1);
      f.index.settleWithinTransaction(context, first, { status: 'deferred', code: 'body_read_retry', nextDueAt: f.now + 60_000 }, f.now + 2);
    });
    assert.equal(f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.listDueForPolicy(context,
      { ruleId: 'rule-1', ruleRevision: 7, policyId: f.policyId, policyRevision: 1, now: f.now + 59_999 })).length, 0);
    assert.equal(f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.readNextDueAtForPolicy(context,
      { ruleId: 'rule-1', ruleRevision: 7, policyId: f.policyId, policyRevision: 1 })), f.now + 60_000);
    const retryCandidate = f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.listDueForPolicy(context,
      { ruleId: 'rule-1', ruleRevision: 7, policyId: f.policyId, policyRevision: 1, now: f.now + 60_000 }))[0];
    const second = f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.claim(context, retryCandidate.candidateId,
      f.policyId, 1, 'rule-1', 7, f.now + 60_000));
    assert.ok(second);
    assert.notEqual(second.attemptId, first.attemptId);
    f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.settleWithinTransaction(context, second,
      { status: 'complete', code: 'body_loaded' }, f.now + 60_001));
    assert.equal(f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.listDueForPolicy(context,
      { ruleId: 'rule-1', ruleRevision: 7, policyId: f.policyId, policyRevision: 1, now: f.now + 100_000 })).length, 0);
    // New consent heads and independent policies do not inherit another head's completed preflight.
    assert.equal(f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.listDueForPolicy(context,
      { ruleId: 'rule-1', ruleRevision: 7, policyId: f.policyId, policyRevision: 2, now: f.now + 100_000 })).length, 1);
    assert.equal(f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.listDueForPolicy(context,
      { ruleId: 'rule-1', ruleRevision: 7, policyId: randomUUID(), policyRevision: 1, now: f.now + 100_000 })).length, 1);
  } finally { cleanup(f); }
});

test('candidate index rejects copied, expired, and foreign-kernel transaction contexts before touching its schema', async () => {
  const f = await setup();
  const foreign = createDurableKernel({ databasePath: ':memory:', validateSnapshot(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  try {
    let expired;
    f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => {
      expired = context;
      assert.throws(() => f.index.hasScope({ ...context }), (error) => error?.code === 'transaction_context_expired');
    });
    assert.throws(() => f.index.hasScope(expired), (error) => error?.code === 'transaction_context_expired');
    const foreignOwnerId = randomUUID();
    const foreignWorkspace = foreign.createWorkspace(foreignOwnerId, { notes: [] });
    const foreignActor = foreign.createSession(foreignWorkspace.workspaceId, foreignOwnerId, Date.now() + 60_000);
    foreign.withOwnedTransaction(foreignActor, 0, (context) => {
      assert.throws(() => f.index.hasScope(context), (error) => error?.code === 'transaction_context_expired');
    });
    const schemaCount = f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => context.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name LIKE 'background_proactive_%'`).get().count);
    assert.equal(schemaCount, 0, 'invalid contexts are rejected before schema reads or writes');
  } finally {
    foreign.close();
    cleanup(f);
  }
});

test('terminal preflight settlements replay exactly after acknowledgement loss and reject changed outcomes', async () => {
  const f = await setup();
  try {
    f.policies.save(f.browserToken, proactivePolicy(f.policyId));
    const candidate = f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.listDueForPolicy(context, {
      ruleId: 'rule-1', ruleRevision: 7, policyId: f.policyId, policyRevision: 1, now: f.now }))[0];
    const claim = f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.claim(context, candidate.candidateId,
      f.policyId, 1, 'rule-1', 7, f.now));
    assert.ok(claim);
    const deferred = { status: 'deferred', code: 'body_read_retry', nextDueAt: f.now + 60_000 };
    const settledAt = f.now + 1;
    f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.settleWithinTransaction(context, claim, deferred, settledAt));
    assert.doesNotThrow(() => f.kernel.withOwnedTransaction(f.actorToken, 0,
      (context) => f.index.settleWithinTransaction(context, claim, deferred, settledAt)));
    assert.throws(() => f.kernel.withOwnedTransaction(f.actorToken, 0,
      (context) => f.index.settleWithinTransaction(context, claim, deferred, settledAt + 1)), /settlement_conflict/);
    assert.throws(() => f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.settleWithinTransaction(context, claim,
      { ...deferred, code: 'different_read_error' }, f.now + 6 * 60_000)), /settlement_conflict/);
    assert.throws(() => f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.settleWithinTransaction(context, claim,
      { ...deferred, nextDueAt: f.now + 120_000 }, f.now + 6 * 60_000)), /settlement_conflict/);
    assert.throws(() => f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.settleWithinTransaction(context, claim,
      { status: 'complete', code: 'body_loaded' }, f.now + 6 * 60_000)), /settlement_conflict/);
    assert.throws(() => f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => f.index.settleWithinTransaction(context, claim,
      { status: 'deferred', code: 'body_read_retry' }, f.now + 6 * 60_000)), /settlement_invalid/);
  } finally { cleanup(f); }
});

test('enabled candidate reconciliation rolls back atomically when the snapshot projection rejects', async () => {
  const f = await setup();
  try {
    const broken = new BackgroundPolicyStore({ kernel: f.kernel, auth: f.auth, resolver: { resolve: () => ({ accounts: [
      { accountId: 'google:account-1', provider: 'google', identityKey: 'c'.repeat(64), connectionGeneration: 4, label: 'Account', connected: true }],
      rule: { ruleId: 'rule-1', revision: 7, specificationDigest: 'd'.repeat(64) } }) }, clock: () => f.now,
      onProactivePolicyEnabledWithinTransaction(context) {
        f.index.reconcile(context, f.projection, context.revision, f.now);
        throw new Error('test_candidate_reconciliation_failed');
      } });
    assert.throws(() => broken.save(f.browserToken, proactivePolicy(f.policyId)), /test_candidate_reconciliation_failed/);
    const rows = f.kernel.withOwnedTransaction(f.actorToken, 0, (context) => context.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN ('background_policy_heads','background_proactive_candidates')`).get());
    assert.equal(rows.count, 0, 'the rejected transaction rolls back both policy schema creation and candidate writes');
  } finally { cleanup(f); }
});

test('real AppState snapshot participant indexes existing mail and saved consent heads reconcile on update and re-enable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-real-projection-'));
  let now = 1_800_000_000_000;
  const accountId = 'google:account-1';
  const ruleId = 'rule-1';
  const providerMessageId = 'provider-message-1';
  const identity = { providerNamespace: 'google', clientId: 'client-1', subject: 'subject-1', issuer: 'https://accounts.google.com' };
  const verifiedIdentityKey = `${identity.providerNamespace}:${identity.clientId}:${identity.subject}:`;
  const state = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
    openRouterModel: 'openai/gpt-6-luna:batch', openRouterReasoningEffort: 'low', llmRequestContractVersion: 1 });
  state.accounts.push({ id: accountId, provider: 'google', connected: true, authStatus: 'connected', identity,
    tokenRef: 'fixture-token-ref', grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
    capabilities: ['mail.read'], capabilityLimits: ['mail.read'], connectionGeneration: 4, syncStatus: 'idle' });
  state.proactive.rules.push({ id: ruleId, revision: 7, version: 7, name: 'Unread sender', enabled: true, accountIds: [accountId],
    trigger: { type: 'unread_from', addresses: ['sender@example.test'] }, createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString() });
  const sourceId = JSON.stringify(['google', accountId, providerMessageId]);
  const sourceVersion = 'b'.repeat(64);
  state.proactive.candidates.push({ presentation: 'active', candidate: { id: JSON.stringify([ruleId, 7, sourceId, sourceVersion]),
    suppressionKey: JSON.stringify([ruleId, sourceId]), ruleId, ruleRevision: 7, sourceId, sourceVersion,
    sourceKind: 'mail', namespace: 'google', accountId, providerId: providerMessageId,
    eligibleAt: new Date(now - 1_000).toISOString(), reasonCode: 'unread_sender', quote: 'sender@example.test', quoteField: 'senderEmail' } });
  state.mailbox.push({ id: 'local-message-1', accountId, providerMessageId,
    identityKey: `${verifiedIdentityKey}:${providerMessageId}`, verifiedIdentityKey, connectionGeneration: 4,
    idFormat: 'gmail', senderEmail: 'sender@example.test', isRead: false, subject: 'A useful message',
    receivedAt: new Date(now - 60_000).toISOString(), observedAt: new Date(now - 1_000).toISOString() });

  let kernel;
  let auth;
  try {
    const projectionBundle = join(directory, 'candidate-projection.mjs');
    await build({ entryPoints: [join(process.cwd(), '..', 'src', 'cloud', 'backgroundProactiveCandidateProjection.node.ts')],
      bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: projectionBundle,
      packages: 'external', sourcemap: false, write: true });
    const { createBackgroundProactiveCandidateSnapshotParticipant, projectBackgroundProactiveCandidates } = await import(pathToFileURL(projectionBundle).href);
    const projected = projectBackgroundProactiveCandidates(state, now);
    assert.equal(projected.valid, true);
    assert.equal(projected.candidates.length, 1);
    assert.deepEqual(Object.keys(projected.candidates[0]).sort(), ['accountId', 'accountIdentityKey', 'connectionGeneration',
      'eligibleAt', 'localMessageId', 'providerMessageId', 'ruleId', 'ruleRevision', 'sourceVersion']);

    let reorderedWakeCount = 0;
    const reorderParticipant = createBackgroundProactiveCandidateSnapshotParticipant({ reconcile(_context, projection) {
      assert.equal(projection.valid, true);
      assert.equal(projection.candidates.length, 2);
    } }, () => now, () => { reorderedWakeCount += 1; });
    const twoCandidateSnapshot = structuredClone(state);
    const secondEntry = structuredClone(twoCandidateSnapshot.proactive.candidates[0]);
    secondEntry.candidate.providerId = 'provider-message-2';
    secondEntry.candidate.sourceId = JSON.stringify(['google', accountId, 'provider-message-2']);
    secondEntry.candidate.sourceVersion = 'c'.repeat(64);
    secondEntry.candidate.id = JSON.stringify([ruleId, 7, secondEntry.candidate.sourceId, secondEntry.candidate.sourceVersion]);
    twoCandidateSnapshot.proactive.candidates.push(secondEntry);
    twoCandidateSnapshot.mailbox.push({ ...twoCandidateSnapshot.mailbox[0], id: 'local-message-2', providerMessageId: 'provider-message-2',
      identityKey: `${verifiedIdentityKey}:provider-message-2` });
    const reorderedSnapshot = structuredClone(twoCandidateSnapshot);
    reorderedSnapshot.proactive.candidates.reverse();
    reorderedSnapshot.mailbox.reverse();
    const reorderedIntent = reorderParticipant.commit({ revision: 1, assertActive() {} },
      { previousSnapshot: twoCandidateSnapshot, nextSnapshot: reorderedSnapshot, nextRevision: 2 });
    reorderParticipant.afterAcknowledged(reorderedIntent ?? []);
    assert.equal(reorderedWakeCount, 0, 'reordering equivalent content-free candidate metadata does not wake the scheduler');

    kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), now: () => now,
      validateSnapshot: validatePhysicalWorkspaceSnapshot });
    auth = new AuthService(kernel, { canonicalOrigin: origin, authSecret, now: () => now });
    const { ownerId, workspaceId } = await auth.enrollOwner('correct horse battery staple', state);
    const challenge = auth.createLoginChallenge(origin);
    const browserToken = (await auth.login({ password: 'correct horse battery staple', origin,
      preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken })).sessionToken;
    const actorToken = kernel.createSession(workspaceId, ownerId, now + 24 * 60 * 60_000);
    const index = new BackgroundProactiveCandidateIndex(kernel);
    let wakeCount = 0;
    const candidateParticipant = createBackgroundProactiveCandidateSnapshotParticipant(index, () => now, () => { wakeCount += 1; });
    const store = new ServerWorkspaceStore({ kernel, sessionToken: actorToken, snapshotCommitParticipant: candidateParticipant });
    const policies = new BackgroundPolicyStore({ kernel, auth, resolver: { resolve(_context, specification) {
      assert.equal(specification.kind, 'proactive_draft');
      return { accounts: [{ accountId, provider: 'google', identityKey: projected.candidates[0].accountIdentityKey,
        connectionGeneration: 4, label: 'Fixture account', connected: true }],
        rule: { ruleId, revision: 7, specificationDigest: 'd'.repeat(64) } };
    } }, clock: () => now, onProactivePolicyEnabledWithinTransaction(context, timestamp) {
      const exactSnapshot = JSON.parse(context.db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(workspaceId).snapshot_json);
      index.reconcile(context, projectBackgroundProactiveCandidates(exactSnapshot, timestamp), context.revision, timestamp);
    } });

    const loaded = await store.load();
    await store.save(loaded);
    const rows = kernel.withOwnedTransaction(actorToken, 0, (context) => index.listDue(context, now));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].localMessageId, 'local-message-1');
    assert.equal(rows[0].providerMessageId, providerMessageId);
    const candidateId = rows[0].candidateId;

    const removed = structuredClone(loaded);
    removed.mailbox = [];
    removed.proactive.candidates = [];
    const failingStore = new ServerWorkspaceStore({ kernel, sessionToken: actorToken,
      snapshotCommitParticipant: composeSnapshotCommitParticipants([
        { name: 'proactive_candidates', participant: candidateParticipant },
        { name: 'test_failure', participant: { commit() { throw new Error('test_after_candidate_commit_failure'); } } },
      ]) });
    await failingStore.load();
    await assert.rejects(failingStore.save(removed), /test_after_candidate_commit_failure/);
    assert.equal(wakeCount, 0, 'a rolled-back candidate projection never wakes the scheduler');
    assert.equal(kernel.withOwnedTransaction(actorToken, 0, (context) => index.listDue(context, now)).length, 1,
      'candidate rows roll back with the snapshot');
    await store.save(removed);
    assert.equal(wakeCount, 1, 'a changed projection wakes only after snapshot acknowledgement');
    assert.equal(kernel.withOwnedTransaction(actorToken, 0, (context) => index.listDue(context, now)).length, 0,
      'a valid projection that no longer contains the message deactivates it');
    assert.equal(kernel.withOwnedTransaction(actorToken, 0, (context) => index.claim(context, candidateId, randomUUID(), 1, ruleId, 7, now)), undefined,
      'inactive candidates cannot be claimed');
    await store.save(loaded);
    assert.equal(wakeCount, 2, 'a reappearing candidate wakes after acknowledgement');
    await store.save(structuredClone(loaded));
    assert.equal(wakeCount, 2, 'an unchanged content-free projection does not wake the scheduler');
    const restored = kernel.withOwnedTransaction(actorToken, 0, (context) => index.listDue(context, now));
    assert.equal(restored.length, 1);
    assert.equal(restored[0].candidateId, candidateId, 'reappearance restores the same logical candidate without deleting policy attempt history');

    const policyId = randomUUID();
    const first = policies.save(browserToken, proactivePolicy(policyId));
    assert.equal(first.policyRevision, 1);
    const firstDue = kernel.withOwnedTransaction(actorToken, 0, (context) => index.listDueForPolicy(context, {
      ruleId, ruleRevision: 7, policyId, policyRevision: first.policyRevision, now }));
    assert.equal(firstDue.length, 1);
    const claim = kernel.withOwnedTransaction(actorToken, 0, (context) => index.claim(context, firstDue[0].candidateId,
      policyId, first.policyRevision, ruleId, 7, now));
    assert.ok(claim);
    kernel.withOwnedTransaction(actorToken, 0, (context) => index.settleWithinTransaction(context, claim,
      { status: 'complete', code: 'body_loaded' }, now + 1));

    const updated = policies.save(browserToken, proactivePolicy(policyId, 1));
    assert.equal(updated.policyRevision, 2);
    assert.equal(kernel.withOwnedTransaction(actorToken, 0, (context) => index.listDueForPolicy(context, {
      ruleId, ruleRevision: 7, policyId, policyRevision: 2, now: now + 2 })).length, 1);

    const paused = policies.pause(browserToken, { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId, expectedPolicyRevision: 2 });
    assert.equal(paused.policyRevision, 3);
    assert.equal(paused.status, 'paused');
    const disabledState = await store.load();
    const reenabled = policies.save(browserToken, { ...proactivePolicy(policyId, 3), enabled: true });
    assert.equal(reenabled.policyRevision, 4);
    assert.equal(kernel.withOwnedTransaction(actorToken, 0, (context) => index.listDueForPolicy(context, {
      ruleId, ruleRevision: 7, policyId, policyRevision: 4, now: now + 3 })).length, 1);
    assert.equal(disabledState.proactive.candidates.length, 1);
  } finally {
    try { auth?.close(); } catch {}
    try { kernel?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
