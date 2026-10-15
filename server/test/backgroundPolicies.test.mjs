import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthService, createDurableKernel } from '../dist/index.js';
import { BackgroundPolicyStore } from '../dist/backgroundPolicies.js';
import { parseBackgroundPolicyDisplay, parseSaveBackgroundPolicyEnvelope } from '../dist/backgroundContracts.js';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const origin = 'https://still.example';

async function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-policies-'));
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
  let generation = options.generation ?? 3;
  let identityKeyOverride;
  const approvedReminderDevices = options.reminderDevices ?? 'all_current';
  let savedRuleRevision = options.savedRuleRevision ?? 7;
  let savedReminderRevision = options.savedReminderRevision ?? 2;
  const resolver = { resolve(_context, specification) {
    const selections = specification.kind === 'account_sync' || specification.kind === 'proactive_draft' ? specification.accounts
      : specification.kind === 'period_summary' ? [...specification.sources.mailAccounts, ...specification.sources.calendarAccounts] : [];
    const unique = new Map(selections.map((entry) => [entry.accountId, entry.expectedConnectionGeneration]));
    const accounts = [...unique].map(([accountId, connectionGeneration]) => ({ accountId, provider: 'google', identityKey: identityKeyOverride ?? createHash('sha256').update(JSON.stringify({ accountId, provider: 'google' })).digest('hex'),
      connectionGeneration: generation ?? connectionGeneration, label: 'Test account', connected: true }));
    return { ...(accounts.length ? { accounts } : {}), ...(specification.kind === 'proactive_draft' ? { rule: {
      ruleId: specification.ruleId, revision: savedRuleRevision, specificationDigest: 'a'.repeat(64) } } : {}),
    ...(specification.kind === 'approved_reminder_delivery' ? { reminder: { reminderId: specification.reminderId,
      revision: savedReminderRevision, approvedDigest: 'b'.repeat(64), dueAt: 1_900_000_000_000,
      privacyEpoch: _context.privacyEpoch, intentId: 'approved-intent-1', privacyMode: 'private', deviceSelection: approvedReminderDevices } } : {}) };
  } };
  const store = new BackgroundPolicyStore({ kernel, auth, resolver, clock: () => now });
  return { directory, kernel, auth, ownerId, workspace, browserSessionToken, actorSessionToken, store, resolver,
    setGeneration(value) { generation = value; }, setIdentityKey(value) { identityKeyOverride = value; }, setSavedRuleRevision(value) { savedRuleRevision = value; },
    setSavedReminderRevision(value) { savedReminderRevision = value; } };
}
function cleanup(f) { try { f.auth.close(); } catch {} try { f.kernel.close(); } catch {} rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
function syncEnvelope(overrides = {}) {
  return { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
    specification: { kind: 'account_sync', accounts: [{ accountId: 'google:acct-1', expectedConnectionGeneration: 3 }], resources: ['mail'] }, ...overrides };
}

test('background contract closes policy variants, binds every account selection to a generation, and rejects raw offset time zones', () => {
  const good = syncEnvelope();
  assert.equal(parseSaveBackgroundPolicyEnvelope(good).specification.accounts[0].expectedConnectionGeneration, 3);
  assert.throws(() => parseSaveBackgroundPolicyEnvelope({ ...good, specification: { ...good.specification, accounts: ['google:acct-1'] } }), /invalid/);
  for (const timeZone of ['+08', '+0800', '+08:00']) assert.throws(() => parseSaveBackgroundPolicyEnvelope({ ...good, specification: { kind: 'period_summary', period: 'daily', timeZone,
    sources: { notes: false, chat: false, tasks: false, decisions: false, acceptedInferences: false, mailAccounts: [], calendarAccounts: [], documentPaths: [], knowledge: [] },
    instructions: 'brief', catchUp: 'ask', paidConsent: { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'low' } } }), /invalid/);
  assert.equal(parseSaveBackgroundPolicyEnvelope({ ...good, specification: { kind: 'period_summary', period: 'daily', timeZone: 'UTC',
    sources: { notes: false, chat: false, tasks: false, decisions: false, acceptedInferences: false, mailAccounts: [], calendarAccounts: [], documentPaths: [], knowledge: [] },
    instructions: 'brief 😀', catchUp: 'ask', paidConsent: { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'low' } } }).specification.instructions, 'brief 😀');
  assert.throws(() => parseSaveBackgroundPolicyEnvelope({ ...good, specification: { kind: 'period_summary', period: 'daily', timeZone: 'UTC',
    sources: { notes: false, chat: false, tasks: false, decisions: false, acceptedInferences: false, mailAccounts: [], calendarAccounts: [], documentPaths: [], knowledge: [] },
    instructions: '\ud800', catchUp: 'ask', paidConsent: { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'low' } } }), /invalid/);
});

test('policy save is immutable and idempotent, pause advances revision, and revoke is terminal', async () => {
  const f = await setup();
  try {
    const envelope = syncEnvelope();
    const first = f.store.save(f.browserSessionToken, envelope);
    assert.equal(first.policyRevision, 1);
    assert.deepEqual(f.store.save(f.browserSessionToken, envelope), first);
    assert.equal(f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0 })[0].accounts[0].connectionGeneration, 3);
    const display = f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0 })[0];
    assert.equal(parseBackgroundPolicyDisplay({ ...display, accounts: [{ ...display.accounts[0], connected: false }] }).accounts[0].connected, false);
    assert.throws(() => f.store.save(f.browserSessionToken, { ...envelope, enabled: false }), /idempotency_conflict/);
    const paused = f.store.pause(f.browserSessionToken, { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: envelope.policyId, expectedPolicyRevision: 1 });
    assert.equal(paused.status, 'paused');
    assert.equal(paused.policyRevision, 2);
    const resumed = f.store.save(f.browserSessionToken, { ...envelope, commandId: randomUUID(), expectedPolicyRevision: 2, enabled: true });
    assert.equal(resumed.status, 'enabled');
    const revoked = f.store.revoke(f.browserSessionToken, { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: envelope.policyId, expectedPolicyRevision: 3 });
    assert.equal(revoked.status, 'revoked');
    assert.throws(() => f.store.save(f.browserSessionToken, { ...envelope, commandId: randomUUID(), expectedPolicyRevision: 4 }), /revoked/);
  } finally { cleanup(f); }
});

test('policy metadata is keyset paged and corrupted stored DTOs or receipts fail closed', async () => {
  const f = await setup();
  try {
    const envelopes = [syncEnvelope(), syncEnvelope(), syncEnvelope()];
    for (const envelope of envelopes) f.store.save(f.browserSessionToken, envelope);
    const firstPage = f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0, limit: 2 });
    assert.equal(firstPage.length, 2);
    assert.deepEqual(firstPage.map((item) => item.policyId), [...firstPage.map((item) => item.policyId)].sort());
    const secondPage = f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0, afterPolicyId: firstPage.at(-1).policyId, limit: 2 });
    assert.equal(secondPage.length, 1);
    assert.ok(secondPage[0].policyId > firstPage.at(-1).policyId);
    assert.throws(() => f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0, limit: 101 }), /background_policy_query_invalid/);

    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`UPDATE background_policy_revisions SET binding_json='{}'
      WHERE policy_id=? AND revision=1`).run(secondPage[0].policyId));
    assert.throws(() => f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0, afterPolicyId: firstPage.at(-1).policyId }), /background_binding_invalid|background_storage_invalid/);

    const receiptEnvelope = syncEnvelope();
    f.store.save(f.browserSessionToken, receiptEnvelope);
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`UPDATE background_policy_commands SET receipt_json='{"schemaVersion":1}'
      WHERE command_id=?`).run(receiptEnvelope.commandId));
    assert.throws(() => f.store.save(f.browserSessionToken, receiptEnvelope), /background_policy_invalid|background_policy_storage_invalid/);
  } finally { cleanup(f); }
});

test('background schema rejects a missing required unique index rather than silently losing idempotency', async () => {
  const f = await setup();
  try {
    f.store.save(f.browserSessionToken, syncEnvelope());
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec('DROP INDEX background_occurrence_batch_job_unique'));
    assert.throws(() => f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0 }), /background_schema_invalid/);
  } finally { cleanup(f); }
});

test('background schema rejects a same-name partial unique index with the wrong predicate', async () => {
  const f = await setup();
  try {
    f.store.save(f.browserSessionToken, syncEnvelope());
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.exec('DROP INDEX background_occurrence_batch_job_unique');
      db.exec(`CREATE UNIQUE INDEX background_occurrence_batch_job_unique
        ON background_occurrences(workspace_id,owner_id,privacy_epoch,batch_job_id) WHERE 0`);
    });
    assert.throws(() => f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0 }), /background_schema_invalid/);
  } finally { cleanup(f); }
});

test('binding resolver cannot silently accept a reconnected account generation or forged public identity', async () => {
  const f = await setup();
  try {
    const envelope = syncEnvelope();
    f.setGeneration(4);
    assert.throws(() => f.store.save(f.browserSessionToken, envelope), /binding_changed/);
    f.setGeneration(3);
    f.setIdentityKey('z'.repeat(64));
    assert.throws(() => f.store.save(f.browserSessionToken, envelope), /background_binding_invalid/);
    f.setIdentityKey(undefined);
    const saved = f.store.save(f.browserSessionToken, envelope);
    assert.equal(saved.status, 'enabled');
    assert.equal(Object.hasOwn(f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0 })[0].accounts[0], 'identityKey'), false);
    assert.throws(() => f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 1 }), (error) => error?.code === 'stale_epoch');
  } finally { cleanup(f); }
});

test('policy resolver must bind the exact saved proactive rule revision and account generation', async () => {
  const f = await setup();
  try {
    const envelope = syncEnvelope({ specification: { kind: 'proactive_draft', ruleId: 'rule-1', expectedRuleRevision: 7,
      accounts: [{ accountId: 'google:acct-1', expectedConnectionGeneration: 3 }], brief: 'Reply carefully', replyMode: 'reply',
      paidConsent: { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'none' } } });
    assert.equal(f.store.save(f.browserSessionToken, envelope).policyRevision, 1);
    const badRule = { ...envelope, commandId: randomUUID(), policyId: randomUUID(), specification: { ...envelope.specification, expectedRuleRevision: 8 } };
    assert.throws(() => f.store.save(f.browserSessionToken, badRule), /binding_changed/);
  } finally { cleanup(f); }
});

test('reminder policy binds only the approved intent, privacy mode, and device-selection intent', async () => {
  const f = await setup();
  try {
    const envelope = { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'approved_reminder_delivery', reminderId: 'reminder-1', expectedReminderRevision: 2, channel: 'web_push', devices: 'all_current' } };
    const receipt = f.store.save(f.browserSessionToken, envelope);
    assert.equal(receipt.policyRevision, 1);
    assert.equal(f.store.list(f.browserSessionToken, { expectedPrivacyEpoch: 0 })[0].specification.kind, 'approved_reminder_delivery');
    const changedSelection = { ...envelope, commandId: randomUUID(), policyId: randomUUID(), specification: { ...envelope.specification,
      devices: { subscriptionIds: [randomUUID()] } } };
    assert.throws(() => f.store.save(f.browserSessionToken, changedSelection), /binding_changed/);
    f.setSavedReminderRevision(3);
    assert.throws(() => f.store.save(f.browserSessionToken, { ...envelope, commandId: randomUUID(), policyId: randomUUID() }), /binding_changed/);
  } finally { cleanup(f); }
});

test('standing paid consent rejects a kernel-only runtime actor even for an exact command replay', async () => {
  const f = await setup();
  try {
    const envelope = syncEnvelope();
    assert.throws(() => f.store.save(f.actorSessionToken, envelope), (error) => error?.code === 'initiating_session_inactive');
    assert.equal(f.store.save(f.browserSessionToken, envelope).policyRevision, 1);
    assert.throws(() => f.store.pause(f.actorSessionToken, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      policyId: envelope.policyId, expectedPolicyRevision: 1 }), (error) => error?.code === 'initiating_session_inactive');
  } finally { cleanup(f); }
});
