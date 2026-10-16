import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerConfig } from '../../dist/config.js';
import { openServerFoundationInternal } from '../../dist/bootstrap.js';
import { ProcessWorkspaceActors, RUNTIME_ACTOR_EXPIRES_AT } from '../../dist/runtimeActors.js';
import { ServerOAuthTokenBindings } from '../../dist/oauthTokenBindings.js';
import { createInitialWorkspaceState } from '../../dist/sharedControllerNode.mjs';
import { createCloudApplicationRuntimeFactory, createProductionApplicationRuntimeFactory, createProductionWorkspacePortsFor } from '../../dist/applicationHost.node.mjs';

const MODEL = 'openai/gpt-6-luna:batch';
const ACCOUNT_ID = 'google:paid-reply-fixture';
const CLIENT_ID = 'paid-reply-client';
const IDENTITY = Object.freeze({ providerNamespace: 'google', clientId: CLIENT_ID, subject: 'paid-reply-subject',
  issuer: 'https://accounts.google.com' });
const IDENTITY_KEY = `${IDENTITY.providerNamespace}:${IDENTITY.clientId}:${IDENTITY.subject}:`;
const TOKEN_REF = 'paid-reply-token-ref';

function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
async function withDeadline(promise, label, timeoutMs = 8_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function canonicalSourceDigest(source) {
  const identity = { providerNamespace: source.identity.providerNamespace, clientId: source.identity.clientId,
    subject: source.identity.subject, ...(source.identity.issuer ? { issuer: source.identity.issuer } : {}),
    ...(source.identity.tenantId ? { tenantId: source.identity.tenantId } : {}),
    ...(source.identity.resourceUserId ? { resourceUserId: source.identity.resourceUserId } : {}) };
  return sha256(stable({ version: 1, accountId: source.accountId, accountEmail: source.accountEmail,
    verifiedSelfEmail: source.verifiedSelfEmail ?? null, identity, localMessageId: source.localMessageId,
    providerMessageId: source.providerMessageId, idFormat: source.idFormat, providerVersion: source.providerVersion ?? null,
    threadId: source.threadId ?? null, internetMessageId: source.internetMessageId,
    references: source.references ? source.references.trim().split(/\s+/).filter(Boolean) : [], inReplyTo: source.inReplyTo ?? null,
    subject: source.subject, from: source.from ?? null, senderEmail: source.senderEmail ?? null, replyTo: source.replyTo ?? null,
    to: source.to ?? null, cc: source.cc ?? null, snippet: source.snippet ?? null, replyMetadataComplete: true }));
}

export async function runPaidReplyFixture({ missingOpenRouterCredential = false, lostProviderAck = false, snapshotMutation,
  expectedAuthorizedRequest, losePreflightFinalizationAck, stopAfterPreflightClaim = false, directoryPath,
  crashAfterSavedJobStatus, crashAfterPaidClaim = false, resumeExisting = false, expectNoProviderPost = false,
  configureOpenRouterKey = false, reauthorizeExisting = false, expectCredentialSetupOnly = false,
  advanceClockMs = 0, advanceAfterRecoveryMs = 0, sourceChangePolicy = 'first_match_only',
  changeExistingSourceTo, pauseAfterProvider = true, expectNoAdditionalProviderPost = false, expectedExistingLinkCount,
  expectedNoPostPreflightStatus, expectReauthorizationLineage = true } = {}) {
  const realDate = globalThis.Date;
  const fixedNow = realDate.now();
  let clockOffset = advanceClockMs;
  globalThis.Date = class FixedDate extends realDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow + clockOffset; }
  };
  const directory = directoryPath ?? mkdtempSync(join(tmpdir(), 'still-background-paid-mail-reply-'));
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, 'public'), { recursive: true });
  const createdAt = new realDate(fixedNow - 60_000).toISOString();
  const observedAt = new realDate(fixedNow).toISOString();
  const account = { id: ACCOUNT_ID, provider: 'google', displayName: 'Synthetic mailbox', email: 'owner@example.test',
    verifiedEmail: 'owner@example.test', connected: true, authStatus: 'connected', identity: { ...IDENTITY }, tokenRef: TOKEN_REF,
    grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'], capabilities: ['mail.read'],
    capabilityLimits: ['mail.read'], connectionGeneration: 1, syncStatus: 'idle' };
  const message = { id: 'paid-reply-local-message', accountId: ACCOUNT_ID, providerMessageId: 'paid-reply-provider-message',
    identityKey: `${IDENTITY_KEY}:paid-reply-provider-message`, verifiedIdentityKey: IDENTITY_KEY, connectionGeneration: 1,
    idFormat: 'gmail', threadId: 'paid-reply-thread', subject: 'A question', from: 'Alex <alex@example.test>',
    senderEmail: 'alex@example.test', receivedAt: new realDate(fixedNow - 120_000).toISOString(), snippet: 'Could you send details?', isRead: false,
    replyMetadataComplete: true, internetMessageId: '<paid-reply@example.test>', replyTo: ['alex@example.test'], to: ['owner@example.test'],
    cc: [], observedAt };
  const source = { version: 1, accountId: ACCOUNT_ID, accountEmail: account.email, verifiedSelfEmail: account.verifiedEmail,
    identity: { ...IDENTITY }, connectionGeneration: 1, localMessageId: message.id, providerMessageId: message.providerMessageId,
    idFormat: 'gmail', threadId: message.threadId, internetMessageId: message.internetMessageId, subject: message.subject,
    from: message.from, senderEmail: message.senderEmail, replyTo: [...message.replyTo], to: [...message.to], cc: [], snippet: message.snippet,
    replyMetadataComplete: true, observedAt, sourceDigest: '0'.repeat(64) };
  source.sourceDigest = canonicalSourceDigest(source);
  const text = 'Please send the concise project overview.';
  const textDigest = sha256(text);
  const selectedText = { version: 1, messageId: message.id, accountId: ACCOUNT_ID, identityKey: IDENTITY_KEY,
    identity: { ...IDENTITY }, connectionGeneration: 1, providerMessageId: message.providerMessageId, idFormat: 'gmail',
    sourceDigest: source.sourceDigest, checkedAt: observedAt, text, textDigest, bytes: Buffer.byteLength(text),
    extractionVersion: 'mail-text-v2', representation: 'plain', completeness: 'complete_text', omissionReasons: [] };
  const initial = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter', openRouterModel: MODEL,
    openRouterReasoningEffort: 'none', llmRequestContractVersion: 1, timezone: 'UTC' });
  initial.accounts.push(account);
  initial.mailbox.push(message);
  initial.selectedMailTexts.push(selectedText);
  initial.proactive.rules.push({ id: 'paid-reply-rule', revision: 1, version: 1, enabled: true, accountIds: [ACCOUNT_ID],
    trigger: { type: 'unread_from', addresses: ['alex@example.test'] }, name: 'Reply to Alex', createdAt, updatedAt: createdAt });

  let opened;
  let actors;
  let runtime;
  let productionPorts;
  let activeController;
  let workspaceStore;
  let mutationApplied = false;
  let actor;
  let enrolledWorkspaceId;
  let policyId;
  let activePolicyRevision;
  let providerCalls = [];
  let providerEnteredResolve;
  const providerEntered = new Promise((resolve) => { providerEnteredResolve = resolve; });
  let releaseProviderResolve;
  const releaseProvider = new Promise((resolve) => { releaseProviderResolve = resolve; });
  let primaryFailure;
  let finalizationAckLost = false;
  let paidClaimCrashHandled = false;
  let committedSettlement;
  let stopQueued = false;
  const batchId = 'batch-paid-mail-reply-fixture';
  const configEnv = { STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: CLIENT_ID,
    STILL_GOOGLE_CLIENT_SECRET: 'test-only-synthetic-google-secret' };
  const config = loadServerConfig(configEnv, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
  try {
    opened = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => initial });
    const { kernel, vault } = opened.privateContext;
    let enrolled;
    let browserLogin;
    if (resumeExisting) {
      const challenge = opened.foundation.auth.createLoginChallenge(config.canonicalOrigin);
      browserLogin = await opened.foundation.auth.login({ password: 'paid reply synthetic fixture password', origin: config.canonicalOrigin,
        preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
      const identity = kernel.getOwnedIdentity(browserLogin.sessionToken);
      enrolled = { workspaceId: identity.workspaceId, ownerId: identity.ownerId };
      policyId = kernel.withTrustedDatabaseTransaction((db) => {
        const rows = db.prepare(`SELECT r.policy_id,r.specification_json,h.current_revision FROM background_policy_heads h
          JOIN background_policy_revisions r ON r.workspace_id=h.workspace_id AND r.owner_id=h.owner_id AND r.privacy_epoch=h.privacy_epoch
            AND r.policy_id=h.policy_id AND r.revision=h.current_revision
          WHERE h.workspace_id=? AND h.owner_id=? AND h.privacy_epoch=? ORDER BY r.policy_id`)
          .all(enrolled.workspaceId, enrolled.ownerId, identity.privacyEpoch);
        const row = rows.find((candidate) => JSON.parse(candidate.specification_json).kind === 'proactive_draft');
        if (row) activePolicyRevision = row.current_revision;
        return row?.policy_id;
      });
      if (typeof policyId !== 'string') throw new Error('existing_proactive_policy_missing');
    } else enrolled = await opened.foundation.auth.enrollOwner('paid reply synthetic fixture password', initial);
    enrolledWorkspaceId = enrolled.workspaceId;
    if (losePreflightFinalizationAck || stopAfterPreflightClaim || crashAfterPaidClaim) {
      if (losePreflightFinalizationAck) losePreflightFinalizationAck.workspaceId = enrolled.workspaceId;
      const withOwnedTransaction = kernel.withOwnedTransaction.bind(kernel);
      kernel.withOwnedTransaction = (sessionToken, expectedPrivacyEpoch, operation) => {
        const result = withOwnedTransaction(sessionToken, expectedPrivacyEpoch, operation);
        if (losePreflightFinalizationAck || stopAfterPreflightClaim || crashAfterPaidClaim) {
          if (crashAfterPaidClaim && !paidClaimCrashHandled) {
            const evidence = kernel.withTrustedDatabaseTransaction((db) => {
              if (!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='background_proactive_preflight_attempts'").get()) return undefined;
              const preflight = db.prepare(`SELECT attempt_id,candidate_id,policy_id,policy_revision,paid_occurrence_id,paid_attempt_id,status
                FROM background_proactive_preflight_attempts WHERE workspace_id=? ORDER BY attempt_number DESC LIMIT 1`).get(enrolled.workspaceId);
              if (!preflight || preflight.status !== 'reading' || !preflight.paid_occurrence_id || !preflight.paid_attempt_id) return undefined;
              const paid = db.prepare(`SELECT status FROM background_occurrence_attempts WHERE workspace_id=? AND occurrence_id=? AND attempt_id=?`)
                .get(enrolled.workspaceId, preflight.paid_occurrence_id, preflight.paid_attempt_id);
              if (paid?.status !== 'claimed') return undefined;
              const occurrence = db.prepare(`SELECT request_json FROM background_occurrences WHERE workspace_id=? AND occurrence_id=?`)
                .get(enrolled.workspaceId, preflight.paid_occurrence_id);
              const journalPresent = Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='async_command_journal'").get()) &&
                Boolean(db.prepare('SELECT 1 FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?')
                  .get(enrolled.workspaceId, preflight.paid_attempt_id));
              const linkPresent = Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='background_paid_batch_links'").get()) &&
                Boolean(db.prepare('SELECT 1 FROM background_paid_batch_links WHERE workspace_id=? AND attempt_id=?')
                  .get(enrolled.workspaceId, preflight.paid_attempt_id));
              const snapshot = db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(enrolled.workspaceId);
              const jobs = snapshot ? JSON.parse(snapshot.snapshot_json).openRouterBatchLedger.jobs : [];
              const matchingJob = jobs.some((job) => job.proactiveMailReply?.attemptId === preflight.paid_attempt_id);
              if (journalPresent || linkPresent || matchingJob) return undefined;
              return { preflight, paid, journalPresent, linkPresent, matchingJob,
                requestAsOf: occurrence ? JSON.parse(occurrence.request_json).requestAsOf : undefined };
            });
            if (evidence) {
              paidClaimCrashHandled = true;
              writeSync(1, `${JSON.stringify({ workspaceId: enrolled.workspaceId, ownerId: enrolled.ownerId, policyId, ...evidence })}\n`);
              process.exit(73);
            }
          }
          const settled = kernel.withTrustedDatabaseTransaction((db) => {
            if (!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='background_proactive_preflight_attempts'").get()) return undefined;
            return db.prepare(`SELECT status,next_due_at,settled_at,result_code FROM background_proactive_preflight_attempts
              WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1`).get(enrolled.workspaceId);
          });
          if (stopAfterPreflightClaim && !stopQueued && settled?.status === 'claimed') {
            stopQueued = true;
            queueMicrotask(() => runtime?.stopAdmission());
          }
          const expectedStatus = losePreflightFinalizationAck?.expectedStatus ?? 'complete';
          if (losePreflightFinalizationAck && !finalizationAckLost && settled?.status === expectedStatus) {
            finalizationAckLost = true;
            committedSettlement = settled;
            clockOffset += 90_000;
            losePreflightFinalizationAck.committedThenThrown = true;
            throw new Error('synthetic_preflight_finalization_ack_lost');
          }
          if (losePreflightFinalizationAck && finalizationAckLost && settled?.status === expectedStatus) {
            assert.deepEqual(settled, committedSettlement, 'retry preserves exact committed settlement fields');
            losePreflightFinalizationAck.replayMatched = true;
          }
        }
        return result;
      };
    }
    if (!browserLogin) {
      const browserChallenge = opened.foundation.auth.createLoginChallenge(config.canonicalOrigin);
      browserLogin = await opened.foundation.auth.login({ password: 'paid reply synthetic fixture password', origin: config.canonicalOrigin,
        preAuthToken: browserChallenge.preAuthToken, csrfToken: browserChallenge.csrfToken });
    }
    actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    kernel.recordAccountGeneration(actor, ACCOUNT_ID, 1);
    if (configureOpenRouterKey) kernel.withOwnedTransaction(actor, 0, (context) => {
      const existing = vault.getSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter');
      if (existing === undefined) {
        vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'test-only-synthetic-openrouter-key');
      }
    });
    if (!resumeExisting) kernel.withOwnedTransaction(actor, 0, (context) => {
      const credential = vault.setSecretWithinTransaction(context, { type: 'account', accountId: ACCOUNT_ID, expectedAccountGeneration: 1 },
        'googleOAuth', 0, JSON.stringify({ accessToken: 'test-only-synthetic-google-token', expiresAt: fixedNow + 3_600_000, identity: { ...IDENTITY } }));
      new ServerOAuthTokenBindings(kernel).writeExistingCredentialBindingWithinTransaction(context, { tokenRef: TOKEN_REF,
        accountId: ACCOUNT_ID, provider: 'google', accountGeneration: 1, credentialGeneration: credential.generation });
      if (!missingOpenRouterCredential) {
        vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'test-only-synthetic-openrouter-key');
      }
    });
    opened.privateContext.startup.beginRecovery();
    if (resumeExisting) {
      const recoveryFactory = createProductionApplicationRuntimeFactory(config, { fetcher: async () => {
        throw new Error('provider_fetch_is_forbidden_during_cold_recovery');
      } });
      recoveryFactory.recoverProactivePreflights({ kernel, startupCapability: opened.privateContext.startup.capability });
    }
    opened.privateContext.startup.seal();
    actors = new ProcessWorkspaceActors(kernel);
    const runtimeSessionFor = (identity) => actors.sessionForRegistry(identity);
    const fetcher = async (input, init = {}) => {
      const url = String(input);
      providerCalls.push({ method: init.method ?? 'GET', url });
      providerEnteredResolve();
      if (missingOpenRouterCredential) throw new Error('provider_must_not_be_called_without_credential');
      assert.equal(url, 'https://openrouter.ai/api/v1/batches', `unexpected synthetic provider URL: ${new URL(url).host}${new URL(url).pathname}`);
      assert.equal(init.method, 'POST');
      await releaseProvider;
      if (lostProviderAck) throw new Error('synthetic lost provider acknowledgement');
      return new Response(JSON.stringify({ id: batchId, object: 'batch', status: 'validating', endpoint: '/v1/chat/completions',
        model: 'openai/gpt-6-luna', completion_window: '24h', request_counts: { total: 1, completed: 0, failed: 0 } }),
      { status: 202, headers: { 'content-type': 'application/json' } });
    };
    const productionPortsFor = createProductionWorkspacePortsFor(config, { fetcher });
    const factory = createCloudApplicationRuntimeFactory({ workspacePortsFor: async (context, activeVault, activeKernel, policies,
      onBackgroundMetadataCommitted) => {
      workspaceStore = context.store;
      const ports = await productionPortsFor(context, activeVault, activeKernel, policies, onBackgroundMetadataCommitted);
      productionPorts = Object.freeze({ ...ports, attachController(controller) {
        ports.attachController(controller);
        activeController = controller;
      } });
      return productionPorts;
    } });
    runtime = await factory({ kernel, vault, auth: opened.foundation.auth,
      runtimeSessionFor, listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
      processInstanceId: randomUUID(), createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });
    const admission = Object.freeze({ sessionToken: browserLogin.sessionToken, assertCurrent() { kernel.getOwnedIdentity(browserLogin.sessionToken); } });
    const snapshot = await runtime.workspaceApi.getSnapshot(admission);
    if (snapshotMutation || crashAfterSavedJobStatus) {
      assert.ok(workspaceStore, 'the actual registry-owned store was captured from production factory context');
      const save = workspaceStore.save.bind(workspaceStore);
      workspaceStore.save = async (candidate, saveOptions) => {
        const copy = structuredClone(candidate);
        const jobs = copy.openRouterBatchLedger?.jobs;
        const target = Array.isArray(jobs) ? jobs.find((job) => job.kind === 'mail_reply' &&
          (snapshotMutation?.stage === undefined || job.status === snapshotMutation.stage) &&
          (crashAfterSavedJobStatus === undefined || job.status === crashAfterSavedJobStatus)) : undefined;
        if (snapshotMutation && !mutationApplied && target?.status === snapshotMutation.stage) {
          snapshotMutation.apply(copy, target);
          mutationApplied = true;
        }
        await save(copy, saveOptions);
        if (crashAfterSavedJobStatus && target?.status === crashAfterSavedJobStatus) {
          const recoveryEvidence = kernel.withTrustedDatabaseTransaction((db) => {
            const preflight = db.prepare(`SELECT attempt_id,candidate_id,policy_id,policy_revision,paid_occurrence_id,paid_attempt_id,status
              FROM background_proactive_preflight_attempts WHERE workspace_id=? AND policy_id=? ORDER BY attempt_number DESC LIMIT 1`)
              .get(enrolled.workspaceId, policyId);
            const journal = db.prepare(`SELECT idempotency_key,status,checkpoint_revision,snapshot_digest FROM async_command_journal
              WHERE workspace_id=? AND command_kind='mail.replybatch.submit' ORDER BY created_at DESC LIMIT 1`).get(enrolled.workspaceId);
            const job = target ? { id: target.id, status: target.status, customId: target.customId } : null;
            return { preflight, journal, job };
          });
          writeSync(1, `${JSON.stringify({ workspaceId: enrolled.workspaceId, ownerId: enrolled.ownerId, policyId,
            recoveryEvidence })}\n`);
          process.exit(73);
        }
        if (snapshotMutation?.followupStatus !== undefined && snapshotMutation.followupStatus === target?.status && mutationApplied) {
          const followup = structuredClone(copy);
          const followupJob = followup.openRouterBatchLedger.jobs.find((job) => job.kind === 'mail_reply');
          snapshotMutation.followup(followup, followupJob);
          await save(followup, saveOptions);
        }
      };
    }
    if (resumeExisting && changeExistingSourceTo) {
      assert.ok(workspaceStore, 'the production registry store is available to prepare a changed current source');
      const candidate = await workspaceStore.load();
      const changedMessage = candidate.mailbox.find((item) => item.id === 'paid-reply-local-message');
      const changedText = candidate.selectedMailTexts.find((item) => item.messageId === changedMessage?.id);
      assert.ok(changedMessage && changedText, 'the existing canonical message and cached body are present');
      changedMessage.subject = changeExistingSourceTo.subject;
      changedMessage.snippet = changeExistingSourceTo.snippet;
      const currentSource = { ...source, subject: changedMessage.subject, snippet: changedMessage.snippet };
      currentSource.sourceDigest = canonicalSourceDigest(currentSource);
      changedText.sourceDigest = currentSource.sourceDigest;
      changedText.text = changeExistingSourceTo.text;
      changedText.textDigest = sha256(changedText.text);
      changedText.bytes = Buffer.byteLength(changedText.text);
      await workspaceStore.save(candidate);
      await activeController.refreshPersistedWorkspace();
      await activeController.evaluateLocalCandidates();
    }
    if (!resumeExisting) {
      const loadedSource = await runtime.workspaceApi.readMailReplySource(admission, { messageId: message.id,
        expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 });
      assert.equal(loadedSource.status, 'current');
      assert.equal(loadedSource.source.sourceDigest, source.sourceDigest, 'the test projection matches the production source digest');
      const loadedText = await runtime.workspaceApi.readMailReplyText(admission, { messageId: message.id,
        expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 });
      assert.equal(loadedText.status, 'current');
      assert.equal(loadedText.snapshot.textDigest, textDigest);
    }

    const specification = { kind: 'proactive_draft', ruleId: 'paid-reply-rule', expectedRuleRevision: 1,
      accounts: [{ accountId: ACCOUNT_ID, expectedConnectionGeneration: 1 }], brief: 'Write a concise reply.', replyMode: 'reply',
      sourceChangePolicy, paidConsent: { authorized: true, model: MODEL, effort: 'none' } };
    if (resumeExisting && advanceAfterRecoveryMs > 0) {
      clockOffset += advanceAfterRecoveryMs;
      const wake = runtime.workspaceApi.saveBackgroundPolicy(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
        policyId: randomUUID(), expectedPolicyRevision: 0, enabled: false,
        specification: { kind: 'account_sync', accounts: [{ accountId: ACCOUNT_ID, expectedConnectionGeneration: 1 }],
          resources: ['mail'], intervalMinutes: 5 } });
      assert.ok(wake.status === 'disabled' || wake.status === 'paused');
    }
    if (!resumeExisting) {
      policyId = randomUUID();
      const savedPolicy = runtime.workspaceApi.saveBackgroundPolicy(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
        policyId, expectedPolicyRevision: 0, enabled: true, specification });
      assert.equal(savedPolicy.status, 'enabled');
      activePolicyRevision = savedPolicy.policyRevision;
    } else if (reauthorizeExisting) {
      assert.equal(providerCalls.length, 0, 'a paused prior policy performs no provider I/O before explicit reauthorization');
      const head = kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT current_revision FROM background_policy_heads
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=?`).get(enrolled.workspaceId, enrolled.ownerId, 0, policyId));
      assert.ok(head && Number.isSafeInteger(head.current_revision));
      const savedPolicy = runtime.workspaceApi.saveBackgroundPolicy(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
        policyId, expectedPolicyRevision: head.current_revision, enabled: true, specification });
      assert.equal(savedPolicy.status, 'enabled');
      activePolicyRevision = savedPolicy.policyRevision;
    }
    const readScheduledState = () => kernel.withTrustedDatabaseTransaction((db) => {
      const workspace = db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(enrolled.workspaceId);
      const state = JSON.parse(workspace.snapshot_json);
      const linkSchema = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='background_paid_batch_links'").get();
      const links = linkSchema ? db.prepare(`SELECT workspace_id,owner_id,privacy_epoch,occurrence_id,attempt_id,command_id,ticket_id,policy_id,policy_revision,
        policy_digest,job_id,custom_id,request_sha256,source_digest,source_version_digest,request_digest FROM background_paid_batch_links
        WHERE workspace_id=? AND policy_id=? ORDER BY rowid`).all(enrolled.workspaceId, policyId) : [];
      const attempts = db.prepare(`SELECT occurrence_id,attempt_id,status FROM background_occurrence_attempts
        WHERE workspace_id=? ORDER BY rowid`).all(enrolled.workspaceId);
      const proactiveSchema = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='background_proactive_preflight_attempts'").get();
      const candidateSchema = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='background_proactive_candidates'").get();
      const currentCandidate = candidateSchema ? db.prepare(`SELECT candidate_id,state,eligible_at,next_due_at,source_version FROM background_proactive_candidates
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND rule_id='paid-reply-rule' AND account_id=?
          AND local_message_id='paid-reply-local-message' AND state<>'inactive' ORDER BY updated_at DESC,candidate_id LIMIT 1`)
        .get(enrolled.workspaceId, enrolled.ownerId, ACCOUNT_ID) : undefined;
      const candidateRows = candidateSchema ? db.prepare(`SELECT candidate_id,state,eligible_at,next_due_at,source_version FROM background_proactive_candidates
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0 AND rule_id='paid-reply-rule' AND account_id=?
          AND local_message_id='paid-reply-local-message' ORDER BY updated_at DESC,candidate_id`).all(enrolled.workspaceId, enrolled.ownerId, ACCOUNT_ID) : [];
      const preflight = proactiveSchema && currentCandidate ? db.prepare(`SELECT attempt_id,candidate_id,status,result_code,next_due_at FROM background_proactive_preflight_attempts
        WHERE workspace_id=? AND policy_id=? AND policy_revision=? AND candidate_id=? ORDER BY attempt_number DESC LIMIT 1`)
        .get(enrolled.workspaceId, policyId, activePolicyRevision, currentCandidate.candidate_id) : undefined;
      const preflightHistory = proactiveSchema ? db.prepare(`SELECT attempt_id,candidate_id,policy_id,policy_revision,status,result_code,next_due_at,paid_occurrence_id,paid_attempt_id
        FROM background_proactive_preflight_attempts WHERE workspace_id=? AND policy_id=? ORDER BY attempt_number`).all(enrolled.workspaceId, policyId) : [];
      const certificateSchema = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='background_proactive_not_submitted_certificates'").get();
      const scopedCertificates = certificateSchema ? db.prepare(`SELECT job_id,proof_kind,ticket_id,preflight_attempt_id,occurrence_id,paid_attempt_id,command_id
        FROM background_proactive_not_submitted_certificates WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .all(enrolled.workspaceId, enrolled.ownerId, 0) : [];
      const policyHead = db.prepare(`SELECT current_revision,status,suspension FROM background_policy_heads
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=?`).get(enrolled.workspaceId, enrolled.ownerId, 0, policyId);
      const occurrenceRows = db.prepare(`SELECT occurrence_id,status,accounting_json FROM background_occurrences
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? ORDER BY created_at`).all(enrolled.workspaceId, enrolled.ownerId, 0, policyId);
      const lineageSchema = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='background_proactive_reauthorization_lineage'").get();
      const lineage = lineageSchema ? db.prepare(`SELECT original_logical_digest,generation,policy_id,policy_revision,parent_occurrence_id,child_occurrence_id,
        consent_command_id,predecessor_set_digest FROM background_proactive_reauthorization_lineage
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND policy_id=? ORDER BY generation`)
        .all(enrolled.workspaceId, enrolled.ownerId, 0, policyId) : [];
      return { state, links, attempts, preflight, preflightHistory, candidate: currentCandidate, candidateRows,
        proactiveCandidates: state.proactive?.candidates?.map((entry) => ({ presentation: entry.presentation, id: entry.candidate?.id,
          sourceVersion: entry.candidate?.sourceVersion, subject: entry.candidate?.quote })),
        certificates: scopedCertificates, policyHead, occurrenceRows, lineage };
    });
    if (expectCredentialSetupOnly) {
      await withDeadline(new Promise((resolve) => setTimeout(resolve, 1_250)), 'credential setup without fresh human consent');
      const current = readScheduledState();
      assert.equal(providerCalls.filter((call) => call.method === 'POST').length, 0, 'installing a key alone never authorizes another paid POST');
      assert.equal(current.policyHead?.status, 'suspended');
      assert.equal(current.policyHead?.suspension, 'reauthorization_required');
      assert.equal(current.lineage.length, 0, 'credential setup does not create a human-consent lineage edge');
      return;
    }
    if (expectNoAdditionalProviderPost) {
      let current = readScheduledState();
      if (expectedNoPostPreflightStatus) {
        let polling = true;
        try {
          try {
            await withDeadline((async () => {
              while (polling && current.preflight?.status !== expectedNoPostPreflightStatus) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                current = readScheduledState();
              }
            })(), `source no-POST terminal preflight ${expectedNoPostPreflightStatus}`);
          } catch (error) {
            current = readScheduledState();
            throw new Error(`source no-POST terminal preflight timeout: ${JSON.stringify({
              requested: expectedNoPostPreflightStatus, current: current.preflight, candidate: current.candidate,
              candidateRows: current.candidateRows, preflightHistory: current.preflightHistory,
              policyHead: current.policyHead, links: current.links.length, providerCalls: providerCalls.length,
            })}`, { cause: error });
          }
        } finally { polling = false; }
      }
      assert.equal(providerCalls.filter((call) => call.method === 'POST').length, 0, 'no duplicate or incompatible-mode source is submitted');
      if (expectedNoPostPreflightStatus) assert.equal(current.preflight?.status, expectedNoPostPreflightStatus);
      if (Number.isSafeInteger(expectedExistingLinkCount)) assert.equal(current.links.length, expectedExistingLinkCount);
      if (expectedNoPostPreflightStatus === 'complete') {
        assert.equal(current.preflight?.result_code, 'batch_submitted', 'the exact current source candidate already has its durable completed attempt');
      }
      if (expectedNoPostPreflightStatus === 'inspect_required') {
        assert.equal(current.preflight?.result_code, 'reauthorized_occurrence_stale', 'the incompatible first_match policy transition is durably rejected');
      }
      return;
    }
    if (expectNoProviderPost) {
      await withDeadline(new Promise((resolve) => setTimeout(resolve, 1_250)), 'ambiguous work suppression window');
      assert.equal(providerCalls.filter((call) => call.method === 'POST').length, 0,
        'linked submitting/unknown work is never sent again after a real restart');
      const current = readScheduledState();
      assert.ok(current.links.length >= 1, 'the prior irreversible paid admission remains linked');
      assert.ok(current.state.openRouterBatchLedger.jobs.some((job) => job.kind === 'mail_reply' &&
        ['submitting', 'submission_unknown'].includes(job.status)), 'the ambiguous job remains durable');
      return;
    }
    const waitFor = async (predicate, label) => {
      try {
        return await withDeadline((async () => {
          for (;;) {
            const value = readScheduledState();
            if (predicate(value)) return value;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })(), label);
      } catch (error) {
        const current = readScheduledState();
        const diagnostic = { links: current.links.length, attempts: current.attempts.map((item) => item.status),
          candidate: current.candidate, candidateRows: current.candidateRows,
          proactiveCandidates: current.proactiveCandidates,
          preflight: current.preflight ? { status: current.preflight.status, resultCode: current.preflight.result_code } : null,
          jobs: current.state.openRouterBatchLedger.jobs.filter((job) => job.kind === 'mail_reply').map((job) => ({ status: job.status,
            failureCode: job.failureCode, batchIdPresent: typeof job.batchId === 'string' })) };
        throw new Error(`${label}: ${JSON.stringify(diagnostic)}`, { cause: error });
      }
    };
    if (stopAfterPreflightClaim) {
      const held = await waitFor((value) => value.preflight?.status === 'deferred', 'stopped preflight claim settlement');
      assert.equal(providerCalls.length, 0, 'a claim held before execution performs no provider POST');
      assert.ok(held.preflight.next_due_at > fixedNow, 'the pre-dispatch hold is durably delayed');
      return;
    }
    if (missingOpenRouterCredential) {
      const failedState = await waitFor((value) => value.preflight?.status === 'complete' && value.preflight?.result_code === 'live_not_submitted' &&
        value.state.openRouterBatchLedger.jobs.some((job) => job.kind === 'mail_reply' && job.status === 'failed'),
        'scheduled pre-dispatch missing credential settlement');
      if (snapshotMutation) {
        assert.equal(mutationApplied, true, `mutation stage ${snapshotMutation.stage} was reached`);
        assert.equal(failedState.state.openRouterBatchLedger.jobs.find((job) => job.kind === 'mail_reply')?.status, 'failed');
        assert.equal(providerCalls.length, 0, 'rejected candidate performs no provider POST');
        return;
      }
      assert.equal(providerCalls.length, 0, 'missing credentials fail before provider I/O');
      const failedJob = failedState.state.openRouterBatchLedger.jobs.find((job) => job.kind === 'mail_reply');
      assert.equal(failedJob?.status, 'failed');
      assert.equal(failedJob?.failureCode, 'not_submitted');
      assert.equal(failedJob?.unknownCharge, false);
      assert.equal(failedState.links.length, 0, 'pre-dispatch failure never creates a Batch link');
      assert.equal(failedState.certificates.length, 1, 'the failed job has one durable private no-submission certificate');
      assert.equal(failedState.certificates[0].proof_kind, 'live_pre_dispatch');
      assert.equal(failedState.certificates[0].ticket_id.length, 36);
      assert.equal(failedState.certificates[0].job_id, failedJob.id);
      assert.equal(failedState.certificates[0].preflight_attempt_id, failedState.preflight.attempt_id);
      assert.equal(failedState.certificates[0].occurrence_id, failedState.occurrenceRows[0].occurrence_id);
      assert.equal(failedState.certificates[0].paid_attempt_id,
        failedState.attempts.find((attempt) => attempt.occurrence_id === failedState.occurrenceRows[0].occurrence_id)?.attempt_id);
      assert.equal(failedState.policyHead?.status, 'suspended');
      assert.equal(failedState.policyHead?.suspension, 'reauthorization_required');
      assert.equal(failedState.occurrenceRows.length, 1);
      assert.equal(failedState.occurrenceRows[0].status, 'suppressed');
      assert.deepEqual(JSON.parse(failedState.occurrenceRows[0].accounting_json), { status: 'not_applicable' });
      const paidAttempt = failedState.attempts.find((attempt) => attempt.occurrence_id === failedState.occurrenceRows[0].occurrence_id);
      assert.equal(paidAttempt?.status, 'skipped');
      return;
    }
    const beforeProvider = await withDeadline(Promise.race([
      providerEntered.then(() => 'provider'),
      waitFor((value) => ['complete', 'inspect_required'].includes(value.preflight?.status), 'scheduled candidate preflight finalization')
        .then(() => 'finalized'),
    ]), 'scheduled reply before provider POST or exact preflight finalization');
    if (snapshotMutation && snapshotMutation.stage !== 'queued' && snapshotMutation.stage !== 'failed') {
      assert.equal(mutationApplied, true, `mutation stage ${snapshotMutation.stage} was reached; preflight=${JSON.stringify(readScheduledState().preflight)}; ` +
        `jobs=${JSON.stringify(readScheduledState().state.openRouterBatchLedger.jobs.filter((job) => job.kind === 'mail_reply').map((job) => ({ status: job.status, failureCode: job.failureCode })))}; ` +
        `providerCalls=${providerCalls.length}`);
      if (expectedAuthorizedRequest) {
        assert.equal(beforeProvider, 'provider', 'the explicitly authorized settings case reaches the existing Batch POST path');
        assert.equal(providerCalls.length, 1, 'the explicitly authorized settings case performs exactly one provider POST');
      } else {
        assert.equal(beforeProvider, 'finalized', 'a rejected pre-POST mutation must settle before provider admission');
        assert.equal(providerCalls.length, 0, 'a rejected pre-POST mutation performs no provider POST');
        return;
      }
    }
    assert.equal(beforeProvider, 'provider', `scheduled candidate should reach provider; state=${JSON.stringify((() => {
        const current = readScheduledState();
        return { preflight: current.preflight, jobs: current.state.openRouterBatchLedger.jobs.filter((job) => job.kind === 'mail_reply')
          .map((job) => ({ status: job.status, failureCode: job.failureCode, batchIdPresent: typeof job.batchId === 'string' })),
        policyHead: current.policyHead, lineage: current.lineage, occurrences: current.occurrenceRows, preflightHistory: current.preflightHistory,
        candidate: current.candidate, proactiveCandidates: current.proactiveCandidates, links: current.links.length,
        attempts: current.attempts, providerCalls };
      })())}`);
    assert.equal(providerCalls.length, 1, 'the owned scheduler reached the existing Batch POST path');
    if (reauthorizeExisting && expectReauthorizationLineage) {
      const replacement = readScheduledState();
      assert.equal(replacement.lineage.length, 1, 'fresh consent links the replacement to the exact no-submission history');
      assert.equal(replacement.lineage[0].policy_revision, activePolicyRevision);
      assert.notEqual(replacement.lineage[0].parent_occurrence_id, replacement.lineage[0].child_occurrence_id);
      assert.equal(new Set(replacement.occurrenceRows.map((row) => row.occurrence_id)).size, 2);
      assert.equal(replacement.links.length, 1, 'only the replacement occurrence is linked to Batch');
    }
    if (pauseAfterProvider) {
      const paused = runtime.workspaceApi.pauseBackgroundPolicy(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
        policyId, expectedPolicyRevision: activePolicyRevision });
      assert.equal(paused.status, 'paused');
    }
    releaseProviderResolve();
    const expectedPreflight = lostProviderAck || snapshotMutation?.stage === 'queued' || snapshotMutation?.stage === 'failed'
      ? 'inspect_required' : 'complete';
    const expectedLinkCount = expectedExistingLinkCount ?? 1;
    const settledState = await waitFor((value) => value.links.length === expectedLinkCount && value.preflight?.status === expectedPreflight &&
      value.state.openRouterBatchLedger.jobs.some((job) => job.kind === 'mail_reply' &&
        ['queued', 'submission_unknown', 'failed'].includes(job.status)), 'scheduled reply settlement');
    const link = settledState.links.at(-1);
    const savedJob = settledState.state.openRouterBatchLedger.jobs.find((job) => job.id === link.job_id);
    if (expectedAuthorizedRequest) {
      const preparedRequest = JSON.parse(savedJob.requestBody);
      assert.equal(preparedRequest.model, expectedAuthorizedRequest.model);
      assert.equal(preparedRequest.reasoning?.effort, expectedAuthorizedRequest.effort);
    }
    if (snapshotMutation?.stage === 'queued' || snapshotMutation?.stage === 'failed') {
      assert.equal(mutationApplied, true, `mutation stage ${snapshotMutation.stage} was reached`);
      assert.equal(providerCalls.length, 1, 'the transition check does not repeat provider I/O');
      if (snapshotMutation.stage === 'queued') {
        assert.equal(savedJob?.status, 'queued');
        assert.equal(savedJob?.batchId, batchId, 'the original known provider ID remains immutable');
      } else {
        assert.equal(savedJob?.status, 'failed');
        assert.equal(savedJob?.failureCode, 'not_submitted');
      }
      return;
    }
    assert.equal(savedJob?.status, lostProviderAck ? 'submission_unknown' : 'queued');
    assert.equal(providerCalls.length, 1, 'known provider admission is not repeated after consent is paused');

    assert.ok(link);
    assert.equal(link.command_id, link.attempt_id, 'the scheduled journal command is the exact claimed attempt');
    assert.ok(link.job_id);
    assert.equal(link.custom_id, link.job_id);
    const durableCommand = kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT status,command_kind FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?')
      .get(enrolled.workspaceId, link.command_id));
    if (!lostProviderAck) assert.deepEqual(durableCommand, { status: 'finished', command_kind: 'mail.replybatch.submit' });
    const integration = productionPorts.integration ?? productionPorts.controllerOptions?.integration;
    assert.equal(typeof integration?.resolveProactiveMailReplyJobAuthority, 'function',
      `production factory retains the private authority resolver (ports: ${Object.keys(productionPorts ?? {}).join(',')})`);
    const authority = await integration.resolveProactiveMailReplyJobAuthority(savedJob);
    assert.deepEqual(authority, { status: 'scheduled', effort: 'none' }, 'the real production port resolves the exact durable link and consent revision');
    const mismatchedMarker = structuredClone(savedJob);
    mismatchedMarker.proactiveMailReply.policyRevision += 1;
    await assert.rejects(integration.resolveProactiveMailReplyJobAuthority(mismatchedMarker), /background_paid_authority_unavailable/);
    const mismatchedRequest = { ...savedJob, requestSha256: 'f'.repeat(64) };
    await assert.rejects(integration.resolveProactiveMailReplyJobAuthority(mismatchedRequest), /background_paid_link_storage_invalid/);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    releaseProviderResolve?.();
    let cleanupFailure;
    try { if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
      if (losePreflightFinalizationAck) losePreflightFinalizationAck.drainCompleted = true;
    } catch (error) {
      let state;
      try {
        state = opened?.privateContext.kernel.withTrustedDatabaseTransaction((db) => {
          const preflight = db.prepare("SELECT status,result_code FROM background_proactive_preflight_attempts WHERE workspace_id=? ORDER BY attempt_number DESC LIMIT 1")
            .get(enrolledWorkspaceId);
          const occurrences = db.prepare("SELECT status FROM background_occurrences WHERE workspace_id=? ORDER BY created_at").all(enrolledWorkspaceId);
          const jobs = db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(enrolledWorkspaceId);
          return { preflight, occurrences, jobs: jobs ? JSON.parse(jobs.snapshot_json).openRouterBatchLedger?.jobs?.filter((job) => job.kind === 'mail_reply')
            .map((job) => ({ status: job.status, failureCode: job.failureCode })) : [] };
        });
      } catch {}
      cleanupFailure ??= new Error(`fixture_runtime_drain_failed ${JSON.stringify(state ?? null)}`, { cause: error });
    }
    try { if (actors) await actors.closeAfterDrain(async () => {}); } catch (error) { cleanupFailure ??= error; }
    try { if (opened) opened.foundation.close(); } catch (error) { cleanupFailure ??= error; }
    if (!directoryPath) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    globalThis.Date = realDate;
    if (cleanupFailure) throw primaryFailure ? new AggregateError([primaryFailure, cleanupFailure], 'fixture and runtime cleanup failed') : cleanupFailure;
  }
}
