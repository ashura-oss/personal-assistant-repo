import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService, createDurableKernel } from '../dist/index.js';
import { acquireApplicationOwnership, reserveApplicationStartup } from '../dist/applicationOwnership.js';
import { registerApplicationStartup } from '../dist/applicationStartup.js';
import { BackgroundPolicyStore } from '../dist/backgroundPolicies.js';
import { BackgroundOccurrenceStore, markInterruptedBackgroundWorkForInspection } from '../dist/backgroundOccurrences.js';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 11));
const origin = 'https://still.example';

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-occurrences-'));
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), now: () => now, validateSnapshot(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  } });
  const auth = new AuthService(kernel, { canonicalOrigin: origin, authSecret, now: () => now });
  const { ownerId, workspaceId } = await auth.enrollOwner('correct horse battery staple', { notes: [] });
  const challenge = auth.createLoginChallenge(origin);
  const browserSessionToken = (await auth.login({ password: 'correct horse battery staple', origin,
    preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken })).sessionToken;
  const actorSessionToken = kernel.createSession(workspaceId, ownerId, now + 60_000);
  const workspace = kernel.getOwnedSnapshot(actorSessionToken);
  let devices = [{ subscriptionId: randomUUID(), generation: 1 }];
  let savedRuleRevision = 7;
  let targetCaptureCount = 0;
  const resolver = { resolve(_context, specification) {
    const selections = specification.kind === 'account_sync' || specification.kind === 'proactive_draft' ? specification.accounts : [];
    return { ...(selections.length ? { accounts: selections.map((entry) => ({ accountId: entry.accountId, provider: 'google', identityKey: createHash('sha256').update(JSON.stringify({ accountId: entry.accountId, provider: 'google' })).digest('hex'),
      connectionGeneration: entry.expectedConnectionGeneration, label: 'Account', connected: true })) } : {}),
    ...(specification.kind === 'proactive_draft' ? { rule: { ruleId: specification.ruleId, revision: savedRuleRevision, specificationDigest: 'd'.repeat(64) } } : {}),
    ...(specification.kind === 'approved_reminder_delivery' ? { reminder: { reminderId: specification.reminderId, revision: specification.expectedReminderRevision,
      approvedDigest: 'c'.repeat(64), dueAt: 1_800_000_000_000, privacyEpoch: 0, intentId: 'intent-approved', privacyMode: 'private', deviceSelection: 'all_current' } } : {}) };
  }, captureReminderTargets() { targetCaptureCount += 1; return devices.map((item) => ({ ...item })); } };
  const clock = () => now++;
  const policies = new BackgroundPolicyStore({ kernel, auth, resolver, clock });
  const occurrences = new BackgroundOccurrenceStore({ kernel, actorSessionToken, resolver, clock });
  return { directory, kernel, auth, ownerId, workspace, browserSessionToken, actorSessionToken, resolver, policies, occurrences,
    setDevices(value) { devices = value; }, setSavedRuleRevision(value) { savedRuleRevision = value; }, get targetCaptureCount() { return targetCaptureCount; } };
}
function cleanup(f) { try { f.auth.close(); } catch {} try { f.kernel.close(); } catch {} rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
function accountPolicy() {
  return { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
    specification: { kind: 'account_sync', accounts: [{ accountId: 'google:acct-1', expectedConnectionGeneration: 3 }], resources: ['mail'] } };
}
function occurrenceInput(policyId, revision = 1, overrides = {}) {
  return { expectedPrivacyEpoch: 0, policyId, expectedPolicyRevision: revision,
    descriptor: { kind: 'account_sync', accountId: 'google:acct-1', resource: 'mail', scheduledSlotUtc: new Date(1_800_000_000_000).toISOString() },
    scheduledAt: 1_800_000_000_000, source: { accountId: 'google:acct-1', resource: 'mail' }, ...overrides };
}

test('occurrence identity is stable across retries and policy edits cannot mint another same-slot occurrence', async () => {
  const f = await setup();
  try {
    const policy = accountPolicy(); f.policies.save(f.browserSessionToken, policy);
    const input = occurrenceInput(policy.policyId);
    const first = f.occurrences.schedule(input);
    assert.equal(first.status, 'scheduled');
    assert.deepEqual(f.occurrences.schedule(input), first);
    assert.equal(Object.hasOwn(first, 'targetSnapshot'), false);
    assert.equal(f.occurrences.list({ expectedPrivacyEpoch: 0 }).length, 1);
    const pause = f.policies.pause(f.browserSessionToken, { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1 });
    f.policies.save(f.browserSessionToken, { ...policy, commandId: randomUUID(), expectedPolicyRevision: pause.policyRevision, enabled: true });
    assert.deepEqual(f.occurrences.schedule(occurrenceInput(policy.policyId, 3)), first);
    assert.equal(f.occurrences.list({ expectedPrivacyEpoch: 0 }).length, 1);
  } finally { cleanup(f); }
});

test('claim capability is private, attempt is recorded before dispatch, and unknown outcome is never automatically resubmitted', async () => {
  const f = await setup();
  try {
    const policy = accountPolicy(); f.policies.save(f.browserSessionToken, policy);
    const occurrence = f.occurrences.schedule(occurrenceInput(policy.policyId));
    const claimed = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId, targetId: 'google:acct-1', targetGeneration: 3 });
    assert.equal(claimed.occurrence.status, 'claimed');
    assert.equal(JSON.stringify(f.occurrences.list({ expectedPrivacyEpoch: 0 })).includes(claimed.claim.capability), false);
    assert.throws(() => f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId, targetId: 'google:acct-1', targetGeneration: 3 }), /not_claimable/);
    f.occurrences.beginDispatch(claimed.claim, 0);
    const result = f.occurrences.settle(claimed.claim, 0, { status: 'unknown', accounting: { status: 'unknown' }, resultCode: 'provider_outcome_unknown' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.accounting.status, 'unknown');
    assert.throws(() => f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId, targetId: 'google:acct-1', targetGeneration: 3 }), /not_claimable/);
    assert.throws(() => f.occurrences.beginDispatch(claimed.claim, 0), /not_dispatchable/);
  } finally { cleanup(f); }
});

test('claimed work is revalidated against the exact policy revision before dispatch and accounting preserves reported precision', async () => {
  const f = await setup();
  try {
    const policy = accountPolicy(); f.policies.save(f.browserSessionToken, policy);
    const occurrence = f.occurrences.schedule(occurrenceInput(policy.policyId));
    const claimed = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId, targetId: 'google:acct-1', targetGeneration: 3 });
    f.policies.pause(f.browserSessionToken, { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1 });
    assert.throws(() => f.occurrences.beginDispatch(claimed.claim, 0), /policy_stale/);
  } finally { cleanup(f); }

  const g = await setup();
  try {
    const policy = accountPolicy(); g.policies.save(g.browserSessionToken, policy);
    const occurrence = g.occurrences.schedule(occurrenceInput(policy.policyId));
    const claimed = g.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId, targetId: 'google:acct-1', targetGeneration: 3 });
    g.occurrences.beginDispatch(claimed.claim, 0);
    const reported = { status: 'reported', unknownCharge: false, providerReportedCostUsd: 0.0000595, promptTokens: 5, completionTokens: 2, totalTokens: 7 };
    assert.deepEqual(g.occurrences.settle(claimed.claim, 0, { status: 'completed', accounting: reported }).accounting, reported);
  } finally { cleanup(g); }
});

test('dispatch rejects a changed authoritative saved rule revision instead of trusting the policy request', async () => {
  const f = await setup();
  try {
    const policy = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'proactive_draft', ruleId: 'rule-1', expectedRuleRevision: 7,
        accounts: [{ accountId: 'google:acct-1', expectedConnectionGeneration: 3 }], brief: 'Review carefully', replyMode: 'reply',
        paidConsent: { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'none' } } };
    f.policies.save(f.browserSessionToken, policy);
    const identityKey = createHash('sha256').update(JSON.stringify({ accountId: 'google:acct-1', provider: 'google' })).digest('hex');
    const occurrence = f.occurrences.schedule({ expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1,
      descriptor: { kind: 'proactive_draft', accountIdentityKey: identityKey, providerMessageId: 'provider-message-1' },
      scheduledAt: 1_800_000_000_000, source: { messageDigest: 'e'.repeat(64) } });
    const claim = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId, targetId: identityKey, targetGeneration: 3 });
    f.setSavedRuleRevision(8);
    assert.throws(() => f.occurrences.beginDispatch(claim.claim, 0), /binding_changed/);
  } finally { cleanup(f); }
});

test('reminder fanout freezes device generations at due time and never expands on retry', async () => {
  const f = await setup();
  try {
    const reminderId = 'reminder-1';
    const policy = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'approved_reminder_delivery', reminderId, expectedReminderRevision: 4, channel: 'web_push', devices: 'all_current' } };
    f.policies.save(f.browserSessionToken, policy);
    const original = { subscriptionId: randomUUID(), generation: 2 };
    f.setDevices([original]);
    const input = { expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1,
      descriptor: { kind: 'approved_reminder_delivery', reminderId, reminderRevision: 4, approvedIntentId: 'intent-approved' },
      scheduledAt: 1_800_000_000_000, source: { approvedPayloadDigest: 'c'.repeat(64) } };
    const occurrence = f.occurrences.schedule(input);
    assert.equal(f.targetCaptureCount, 1);
    const addedAfterDue = { subscriptionId: randomUUID(), generation: 1 };
    f.setDevices([original, addedAfterDue]);
    assert.deepEqual(f.occurrences.schedule(input), occurrence);
    assert.equal(f.targetCaptureCount, 1, 'exact replay returns the frozen target set without recapturing devices');
    const claim = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: original.subscriptionId, targetGeneration: original.generation });
    assert.equal(claim.claim.targetId, original.subscriptionId);
    assert.throws(() => f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: addedAfterDue.subscriptionId, targetGeneration: addedAfterDue.generation }), /target_not_bound/);
  } finally { cleanup(f); }
});

test('a multi-device reminder stays open until every frozen target settles and preserves reported accounting', async () => {
  const f = await setup();
  try {
    const reminderId = 'reminder-fanout';
    const policy = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'approved_reminder_delivery', reminderId, expectedReminderRevision: 4, channel: 'web_push', devices: 'all_current' } };
    f.policies.save(f.browserSessionToken, policy);
    const firstDevice = { subscriptionId: randomUUID(), generation: 3 };
    const secondDevice = { subscriptionId: randomUUID(), generation: 8 };
    f.setDevices([firstDevice, secondDevice]);
    const occurrence = f.occurrences.schedule({ expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1,
      descriptor: { kind: 'approved_reminder_delivery', reminderId, reminderRevision: 4, approvedIntentId: 'intent-approved' },
      scheduledAt: 1_800_000_000_000, source: { approvedPayloadDigest: 'c'.repeat(64) } });
    const first = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: firstDevice.subscriptionId, targetGeneration: firstDevice.generation });
    f.occurrences.beginDispatch(first.claim, 0);
    const actual = { status: 'reported', unknownCharge: false, providerReportedCostUsd: 0.0000595, promptTokens: 9 };
    const afterFirst = f.occurrences.settle(first.claim, 0, { status: 'completed', accounting: actual });
    assert.equal(afterFirst.status, 'scheduled');
    assert.deepEqual(afterFirst.accounting, { status: 'unknown' }, 'aggregate stays unknown while another frozen target has unknown charge');
    const second = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: secondDevice.subscriptionId, targetGeneration: secondDevice.generation });
    f.occurrences.beginDispatch(second.claim, 0);
    const afterSecond = f.occurrences.settle(second.claim, 0, { status: 'unknown', accounting: { status: 'unknown' }, resultCode: 'delivery_unknown' });
    assert.equal(afterSecond.status, 'unknown');
    assert.deepEqual(afterSecond.accounting, { status: 'unknown' });
    const rows = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT target_id,status,accounting_json FROM background_occurrence_targets
      WHERE occurrence_id=? ORDER BY target_id`).all(occurrence.occurrenceId));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.status).sort(), ['completed', 'unknown']);
    assert.equal(rows.some((row) => row.accounting_json.includes('0.0000595')), true);
  } finally { cleanup(f); }
});

test('multi-target aggregate reports only sums backed by every settled target', async () => {
  const f = await setup();
  try {
    const reminderId = 'reminder-known-fanout';
    const policy = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'approved_reminder_delivery', reminderId, expectedReminderRevision: 2, channel: 'web_push', devices: 'all_current' } };
    f.policies.save(f.browserSessionToken, policy);
    const targets = [{ subscriptionId: randomUUID(), generation: 1 }, { subscriptionId: randomUUID(), generation: 2 }];
    f.setDevices(targets);
    const occurrence = f.occurrences.schedule({ expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1,
      descriptor: { kind: 'approved_reminder_delivery', reminderId, reminderRevision: 2, approvedIntentId: 'intent-approved' },
      scheduledAt: 1_800_000_000_000, source: { approvedPayloadDigest: 'a'.repeat(64) } });
    for (const [index, target] of targets.entries()) {
      const claimed = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
        targetId: target.subscriptionId, targetGeneration: target.generation });
      f.occurrences.beginDispatch(claimed.claim, 0);
      const result = f.occurrences.settle(claimed.claim, 0, { status: 'completed', accounting: {
        status: 'reported', unknownCharge: false, providerReportedCostUsd: index === 0 ? 0.25 : 0.5,
        promptTokens: index + 1, completionTokens: index + 2, totalTokens: index + 3, byok: true,
      } });
      if (index === 0) assert.deepEqual(result.accounting, { status: 'unknown' });
      else assert.deepEqual(result.accounting, { status: 'reported', unknownCharge: false, providerReportedCostUsd: 0.75,
        promptTokens: 3, completionTokens: 5, totalTokens: 7, byok: true });
    }
  } finally { cleanup(f); }
});

test('reported usage remains visible when actual provider cost is missing', async () => {
  const f = await setup();
  try {
    const policy = accountPolicy();
    f.policies.save(f.browserSessionToken, policy);
    const occurrence = f.occurrences.schedule(occurrenceInput(policy.policyId));
    const claimed = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: 'google:acct-1', targetGeneration: 3 });
    f.occurrences.beginDispatch(claimed.claim, 0);
    const reportedUsage = { status: 'reported', unknownCharge: true, promptTokens: 13, completionTokens: 5, totalTokens: 18, byok: true };
    const result = f.occurrences.settle(claimed.claim, 0, { status: 'completed', accounting: reportedUsage });
    assert.deepEqual(result.accounting, reportedUsage);
  } finally { cleanup(f); }
});

test('multi-target usage sums remain visible when any settled target lacks reported cost', async () => {
  const f = await setup();
  try {
    const reminderId = 'reminder-partial-cost';
    const policy = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'approved_reminder_delivery', reminderId, expectedReminderRevision: 2, channel: 'web_push', devices: 'all_current' } };
    f.policies.save(f.browserSessionToken, policy);
    const targets = [{ subscriptionId: randomUUID(), generation: 1 }, { subscriptionId: randomUUID(), generation: 2 }];
    f.setDevices(targets);
    const occurrence = f.occurrences.schedule({ expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1,
      descriptor: { kind: 'approved_reminder_delivery', reminderId, reminderRevision: 2, approvedIntentId: 'intent-approved' },
      scheduledAt: 1_800_000_000_000, source: { approvedPayloadDigest: 'b'.repeat(64) } });
    for (const [index, target] of targets.entries()) {
      const claimed = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
        targetId: target.subscriptionId, targetGeneration: target.generation });
      f.occurrences.beginDispatch(claimed.claim, 0);
      const accounting = index === 0
        ? { status: 'reported', unknownCharge: false, providerReportedCostUsd: 0.25, promptTokens: 4, completionTokens: 2, totalTokens: 6 }
        : { status: 'reported', unknownCharge: true, promptTokens: 3, completionTokens: 1, totalTokens: 4 };
      const result = f.occurrences.settle(claimed.claim, 0, { status: 'completed', accounting });
      if (index === 1) assert.deepEqual(result.accounting, { status: 'reported', unknownCharge: true,
        promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    }
  } finally { cleanup(f); }
});

test('an already-dispatched sibling can record its result after aggregate inspection begins', async () => {
  const f = await setup();
  try {
    const reminderId = 'reminder-inspection-hold';
    const policy = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'approved_reminder_delivery', reminderId, expectedReminderRevision: 2, channel: 'web_push', devices: 'all_current' } };
    f.policies.save(f.browserSessionToken, policy);
    const targets = [{ subscriptionId: randomUUID(), generation: 2 }, { subscriptionId: randomUUID(), generation: 4 }];
    f.setDevices(targets);
    const occurrence = f.occurrences.schedule({ expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1,
      descriptor: { kind: 'approved_reminder_delivery', reminderId, reminderRevision: 2, approvedIntentId: 'intent-approved' },
      scheduledAt: 1_800_000_000_000, source: { approvedPayloadDigest: 'e'.repeat(64) } });
    const claims = targets.map((target) => f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: target.subscriptionId, targetGeneration: target.generation }));
    claims.forEach(({ claim }) => f.occurrences.beginDispatch(claim, 0));

    const held = f.occurrences.settle(claims[0].claim, 0, { status: 'inspect_required',
      accounting: { status: 'unknown' }, resultCode: 'manual_inspection_required' });
    assert.equal(held.status, 'inspect_required');
    const settled = f.occurrences.settle(claims[1].claim, 0, { status: 'completed', accounting: { status: 'not_applicable' } });
    assert.equal(settled.status, 'inspect_required', 'the aggregate inspection hold survives an admitted sibling settlement');
    assert.throws(() => f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: randomUUID(), targetGeneration: 1 }), /not_claimable/);
    const rows = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT status FROM background_occurrence_targets
      WHERE occurrence_id=? ORDER BY target_id`).all(occurrence.occurrenceId));
    assert.deepEqual(rows.map((row) => row.status).sort(), ['completed', 'inspect_required']);
  } finally { cleanup(f); }
});

test('interrupted work recovery requires the exact cold-start capability and preserves durable evidence', async () => {
  const f = await setup();
  let owner;
  let kernel;
  let startup;
  try {
    const policy = accountPolicy();
    f.policies.save(f.browserSessionToken, policy);
    const occurrence = f.occurrences.schedule(occurrenceInput(policy.policyId));
    const claimed = f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: 'google:acct-1', targetGeneration: 3 });
    f.occurrences.beginDispatch(claimed.claim, 0);
    const before = f.kernel.withTrustedDatabaseTransaction((db) => ({
      attempt: db.prepare(`SELECT status,dispatch_started_at,settled_at,accounting_json FROM background_occurrence_attempts WHERE attempt_id=?`).get(claimed.claim.attemptId),
      target: db.prepare(`SELECT status,accounting_json FROM background_occurrence_targets WHERE occurrence_id=? AND target_id=?`).get(occurrence.occurrenceId, 'google:acct-1'),
    }));
    f.auth.close();
    f.kernel.close();

    const databasePath = join(f.directory, 'workspace.sqlite');
    owner = acquireApplicationOwnership(databasePath);
    const startupReservation = reserveApplicationStartup(owner);
    kernel = createDurableKernel({ databasePath, applicationOwnership: owner, startupReservation, validateSnapshot(value) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    } });
    startup = registerApplicationStartup(kernel, owner, databasePath, randomUUID());
    startup.beginRecovery();

    assert.throws(() => markInterruptedBackgroundWorkForInspection(kernel, {}), /application_startup_capability_invalid/);
    assert.equal(markInterruptedBackgroundWorkForInspection(kernel, startup.capability), 1);
    const recovered = kernel.withColdStartDatabaseTransaction(startup.capability, (db) => ({
      attempt: db.prepare(`SELECT status,result_code,dispatch_started_at,settled_at,accounting_json FROM background_occurrence_attempts WHERE attempt_id=?`).get(claimed.claim.attemptId),
      target: db.prepare(`SELECT status,accounting_json FROM background_occurrence_targets WHERE occurrence_id=? AND target_id=?`).get(occurrence.occurrenceId, 'google:acct-1'),
      occurrence: db.prepare(`SELECT status,accounting_json FROM background_occurrences WHERE occurrence_id=?`).get(occurrence.occurrenceId),
    }));
    assert.equal(recovered.attempt.status, 'inspect_required');
    assert.equal(recovered.attempt.result_code, 'interrupted_requires_inspection');
    assert.equal(recovered.attempt.dispatch_started_at, before.attempt.dispatch_started_at);
    assert.equal(recovered.attempt.settled_at, null);
    assert.equal(recovered.attempt.accounting_json, before.attempt.accounting_json);
    assert.equal(recovered.target.status, 'inspect_required');
    assert.equal(recovered.target.accounting_json, before.target.accounting_json);
    assert.equal(recovered.occurrence.status, 'inspect_required');
    assert.equal(recovered.occurrence.accounting_json, JSON.stringify({ status: 'unknown' }));

    startup.seal();
    assert.throws(() => markInterruptedBackgroundWorkForInspection(kernel, startup.capability), /application_startup_capability_invalid/);
  } finally {
    try { startup?.seal(); } catch {}
    try { kernel?.close(); } catch {}
    try { owner?.release(); } catch {}
    cleanup(f);
  }
});

test('a complete calendar period erased by a time-zone date-line skip is durably suppressed', async () => {
  const f = await setup();
  try {
    const policy = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'period_summary', period: 'daily', timeZone: 'Pacific/Apia', localDeliveryTime: '08:00',
        sources: { notes: false, chat: false, tasks: false, decisions: false, acceptedInferences: false, mailAccounts: [], calendarAccounts: [], documentPaths: [], knowledge: [] },
        instructions: 'Summarize the day', catchUp: 'ask', paidConsent: { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'low' } } };
    f.policies.save(f.browserSessionToken, policy);
    const scheduledAt = Date.parse('2011-12-30T18:00:00.000Z');
    const occurrence = f.occurrences.schedule({ expectedPrivacyEpoch: 0, policyId: policy.policyId, expectedPolicyRevision: 1,
      descriptor: { kind: 'period_summary', period: 'daily', localPeriodStart: '2011-12-30' }, scheduledAt, source: { period: '2011-12-30' } });
    assert.equal(occurrence.status, 'suppressed');
    assert.equal(occurrence.accounting.status, 'not_applicable');
    assert.throws(() => f.occurrences.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId, targetId: 'workspace' }), /not_claimable/);
  } finally { cleanup(f); }
});
