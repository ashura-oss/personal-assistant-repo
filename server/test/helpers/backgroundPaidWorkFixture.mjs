import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerConfig } from '../../dist/config.js';
import { openServerFoundationInternal } from '../../dist/bootstrap.js';
import { ProcessWorkspaceActors, RUNTIME_ACTOR_EXPIRES_AT } from '../../dist/runtimeActors.js';
import { ServerOAuthTokenBindings } from '../../dist/oauthTokenBindings.js';
import { BackgroundOccurrenceStore } from '../../dist/backgroundOccurrences.js';
import { BackgroundBatchLinkStore } from '../../dist/backgroundBatchLink.js';
import { createInitialWorkspaceState } from '../../dist/sharedControllerNode.mjs';
import { createCloudApplicationRuntimeFactory, createProductionWorkspacePortsFor, runBackgroundPaidMailReplyCheckpoint } from '../../dist/applicationHost.node.mjs';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

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

async function loadProductionResolver(directory) {
  const bundlePath = join(directory, 'background-binding-resolver.test.mjs');
  await build({ entryPoints: [join(process.cwd(), '..', 'src', 'cloud', 'backgroundBindingResolver.node.ts')],
    outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return (await import(pathToFileURL(bundlePath).href)).ProductionBackgroundBindingResolver;
}

export async function runPaidReplyFixture({ missingOpenRouterCredential = false, lostProviderAck = false, snapshotMutation } = {}) {
  const realDate = globalThis.Date;
  const fixedNow = realDate.now();
  globalThis.Date = class FixedDate extends realDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  const directory = mkdtempSync(join(tmpdir(), 'still-background-paid-mail-reply-'));
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
  let workspaceStore;
  let mutationApplied = false;
  let actor;
  let policyId;
  let occurrenceStore;
  let resolver;
  let providerCalls = [];
  let providerEnteredResolve;
  const providerEntered = new Promise((resolve) => { providerEnteredResolve = resolve; });
  let releaseProviderResolve;
  const releaseProvider = new Promise((resolve) => { releaseProviderResolve = resolve; });
  const batchId = 'batch-paid-mail-reply-fixture';
  const configEnv = { STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: CLIENT_ID,
    STILL_GOOGLE_CLIENT_SECRET: 'test-only-synthetic-google-secret' };
  const config = loadServerConfig(configEnv, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
  try {
    const ProductionBackgroundBindingResolver = await loadProductionResolver(directory);
    opened = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => initial });
    const enrolled = await opened.foundation.auth.enrollOwner('paid reply synthetic fixture password', initial);
    const { kernel, vault } = opened.privateContext;
    const browserChallenge = opened.foundation.auth.createLoginChallenge(config.canonicalOrigin);
    const browserLogin = await opened.foundation.auth.login({ password: 'paid reply synthetic fixture password', origin: config.canonicalOrigin,
      preAuthToken: browserChallenge.preAuthToken, csrfToken: browserChallenge.csrfToken });
    actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    kernel.recordAccountGeneration(actor, ACCOUNT_ID, 1);
    kernel.withOwnedTransaction(actor, 0, (context) => {
      const credential = vault.setSecretWithinTransaction(context, { type: 'account', accountId: ACCOUNT_ID, expectedAccountGeneration: 1 },
        'googleOAuth', 0, JSON.stringify({ accessToken: 'test-only-synthetic-google-token', expiresAt: fixedNow + 3_600_000, identity: { ...IDENTITY } }));
      new ServerOAuthTokenBindings(kernel).writeExistingCredentialBindingWithinTransaction(context, { tokenRef: TOKEN_REF,
        accountId: ACCOUNT_ID, provider: 'google', accountGeneration: 1, credentialGeneration: credential.generation });
      if (!missingOpenRouterCredential) {
        vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'test-only-synthetic-openrouter-key');
      }
    });
    opened.privateContext.startup.beginRecovery();
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
    const factory = createCloudApplicationRuntimeFactory({ workspacePortsFor: async (context, activeVault, activeKernel) => {
      workspaceStore = context.store;
      return productionPortsFor(context, activeVault, activeKernel);
    } });
    runtime = await factory({ kernel, vault, auth: opened.foundation.auth,
      runtimeSessionFor, listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
      processInstanceId: randomUUID(), createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });
    const admission = Object.freeze({ sessionToken: browserLogin.sessionToken, assertCurrent() { kernel.getOwnedIdentity(browserLogin.sessionToken); } });
    const snapshot = await runtime.workspaceApi.getSnapshot(admission);
    if (snapshotMutation) {
      assert.ok(workspaceStore, 'the actual registry-owned store was captured from production factory context');
      const save = workspaceStore.save.bind(workspaceStore);
      workspaceStore.save = async (candidate, saveOptions) => {
        const copy = structuredClone(candidate);
        const jobs = copy.openRouterBatchLedger?.jobs;
        const target = Array.isArray(jobs) ? jobs.find((job) => job.kind === 'mail_reply') : undefined;
        if (!mutationApplied && target?.status === snapshotMutation.stage) {
          snapshotMutation.apply(copy, target);
          mutationApplied = true;
        }
        await save(copy, saveOptions);
        if (snapshotMutation.followupStatus !== undefined && snapshotMutation.followupStatus === target?.status && mutationApplied) {
          const followup = structuredClone(copy);
          const followupJob = followup.openRouterBatchLedger.jobs.find((job) => job.kind === 'mail_reply');
          snapshotMutation.followup(followup, followupJob);
          await save(followup, saveOptions);
        }
      };
    }
    const loadedSource = await runtime.workspaceApi.readMailReplySource(admission, { messageId: message.id,
      expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 });
    assert.equal(loadedSource.status, 'current');
    assert.equal(loadedSource.source.sourceDigest, source.sourceDigest, 'the test projection matches the production source digest');
    const loadedText = await runtime.workspaceApi.readMailReplyText(admission, { messageId: message.id,
      expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0 });
    assert.equal(loadedText.status, 'current');
    assert.equal(loadedText.snapshot.textDigest, textDigest);

    const specification = { kind: 'proactive_draft', ruleId: 'paid-reply-rule', expectedRuleRevision: 1,
      accounts: [{ accountId: ACCOUNT_ID, expectedConnectionGeneration: 1 }], brief: 'Write a concise reply.', replyMode: 'reply',
      sourceChangePolicy: 'first_match_only', paidConsent: { authorized: true, model: MODEL, effort: 'none' } };
    policyId = randomUUID();
    const savedPolicy = runtime.workspaceApi.saveBackgroundPolicy(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      policyId, expectedPolicyRevision: 0, enabled: true, specification });
    assert.equal(savedPolicy.status, 'enabled');
    resolver = new ProductionBackgroundBindingResolver(kernel);
    occurrenceStore = new BackgroundOccurrenceStore({ kernel, actorSessionToken: actor, resolver });
    const descriptor = { kind: 'proactive_draft', accountIdentityKey: sha256(JSON.stringify({ provider: 'google',
      providerNamespace: IDENTITY.providerNamespace, clientId: IDENTITY.clientId, subject: IDENTITY.subject,
      issuer: IDENTITY.issuer, tenantId: null, resourceUserId: null })), providerMessageId: message.providerMessageId };
    const body = { text, textDigest, bytes: Buffer.byteLength(text), extractionVersion: 'mail-text-v2', representation: 'plain',
      completeness: 'complete_text', omissionReasons: [] };
    const settings = snapshot.state.settings;
    assert.equal(settings.mode, 'provider');
    assert.equal(settings.llmProvider, 'openrouter');
    assert.equal(settings.openRouterReasoningEffort, 'none');
    const settingsSnapshot = stable({ mode: settings.mode, llmProvider: settings.llmProvider ?? 'azure',
      openRouterModel: settings.openRouterModel ?? MODEL, openRouterReasoningEffort: settings.openRouterReasoningEffort ?? 'low',
      llmRequestContractVersion: settings.llmRequestContractVersion ?? 1, timezone: settings.timezone });
    const policy = snapshot.state.documents.filter((doc) => /^memory\/(?:RULES|ROUTINES)\.md$/i.test(doc.path))
      .map((doc) => ({ path: doc.path, revision: doc.revision, content: doc.content, sha256: sha256(doc.content) }));
    const request = { schemaVersion: 1, bindingVersion: 1, mode: 'reply', subject: source.subject, to: ['alex@example.test'], cc: [],
      brief: specification.brief, policy, settingsFingerprint: sha256(settingsSnapshot), settingsSnapshot,
      requestAsOf: new realDate(fixedNow).toISOString(), timeZone: settings.timezone };
    const occurrence = occurrenceStore.schedule({ expectedPrivacyEpoch: 0, policyId, expectedPolicyRevision: 1, descriptor,
      scheduledAt: fixedNow, source: { schemaVersion: 1, accountId: ACCOUNT_ID, connectionGeneration: 1, messageId: message.id, source, body }, request });
    const claimed = occurrenceStore.claim({ expectedPrivacyEpoch: 0, occurrenceId: occurrence.occurrenceId,
      targetId: descriptor.accountIdentityKey, targetGeneration: 1 });
    const commandId = randomUUID();
    const scoped = runBackgroundPaidMailReplyCheckpoint({ occurrences: occurrenceStore, links: new BackgroundBatchLinkStore(kernel),
      claim: claimed.claim, privacyEpoch: 0 }, () => runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId,
        expectedRevision: snapshot.revision, expectedPrivacyEpoch: 0, command: { kind: 'mail.replyBatch.submit', messageId: message.id,
          accountId: ACCOUNT_ID, expectedConnectionGeneration: 1, sourceDigest: source.sourceDigest, textDigest, mode: 'reply',
          to: ['alex@example.test'], cc: [], brief: specification.brief, composerRevision: 1 } }));
    if (missingOpenRouterCredential) {
      let failure;
      try { await withDeadline(scoped, 'pre-dispatch missing credential settlement'); } catch (error) { failure = error; }
      if (snapshotMutation) {
        assert.equal(mutationApplied, true, `mutation stage ${snapshotMutation.stage} was reached`);
        assert.ok(failure, 'the snapshot participant rejects the forged pre-dispatch ledger delta');
        assert.equal(providerCalls.length, 0, 'rejected candidate performs no provider POST');
        return;
      }
      assert.equal(failure?.phase, 'pre_dispatch');
      assert.equal(providerCalls.length, 0, 'missing credentials fail before provider I/O');
      const failed = kernel.withOwnedTransaction(actor, 0, (context) => kernel.readOwnedSnapshotWithinTransaction(context).snapshot);
      const failedJob = failed.openRouterBatchLedger.jobs.find((job) => job.kind === 'mail_reply');
      assert.equal(failedJob?.status, 'failed');
      assert.equal(failedJob?.failureCode, 'not_submitted');
      assert.equal(failedJob?.unknownCharge, false);
      const durable = kernel.withTrustedDatabaseTransaction((db) => ({
        link: db.prepare('SELECT occurrence_id FROM background_paid_batch_links WHERE workspace_id=? AND occurrence_id=?')
          .get(enrolled.workspaceId, occurrence.occurrenceId),
        attempt: db.prepare('SELECT status FROM background_occurrence_attempts WHERE occurrence_id=? AND attempt_id=?')
          .get(occurrence.occurrenceId, claimed.claim.attemptId),
      }));
      assert.equal(durable.link, undefined, 'pre-dispatch failure never creates a Batch link');
      assert.equal(durable.attempt.status, 'claimed', 'pre-dispatch failure preserves an unsubmitted claim for its scheduler owner');
      return;
    }
    const beforeProvider = await withDeadline(Promise.race([
      providerEntered.then(() => ({ kind: 'provider' })),
      scoped.then((value) => ({ kind: 'settled', value }), (error) => ({ kind: 'rejected', error })),
    ]), 'scheduled reply before provider POST');
    if (snapshotMutation && snapshotMutation.stage !== 'queued' && snapshotMutation.stage !== 'failed') {
      assert.equal(mutationApplied, true, `mutation stage ${snapshotMutation.stage} was reached`);
      assert.equal(beforeProvider.kind, 'rejected', 'the participant rejects the mutated candidate before provider I/O');
      assert.equal(providerCalls.length, 0, 'rejected candidate performs no provider POST');
      return;
    }
    assert.equal(beforeProvider.kind, 'provider', beforeProvider.kind === 'settled'
      ? `mail reply settled before provider POST: ${JSON.stringify(beforeProvider.value)}`
      : `mail reply rejected before provider POST: ${beforeProvider.error?.message ?? 'unknown error'}`);
    const paused = runtime.workspaceApi.pauseBackgroundPolicy(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      policyId, expectedPolicyRevision: 1 });
    assert.equal(paused.status, 'paused');
    releaseProviderResolve();
    let result;
    let failure;
    try { result = await scoped; } catch (error) { failure = error; }
    if (snapshotMutation?.stage === 'queued' || snapshotMutation?.stage === 'failed') {
      assert.equal(mutationApplied, true, `mutation stage ${snapshotMutation.stage} was reached`);
      assert.ok(failure, 'the participant rejects the invalid later ledger transition');
      assert.equal(providerCalls.length, missingOpenRouterCredential ? 0 : 1, 'the transition check does not repeat provider I/O');
      const durableState = kernel.withOwnedTransaction(actor, 0, (context) => kernel.readOwnedSnapshotWithinTransaction(context).snapshot);
      const persisted = durableState.openRouterBatchLedger.jobs.find((job) => job.kind === 'mail_reply');
      if (snapshotMutation.stage === 'queued') {
        assert.equal(persisted?.status, 'queued');
        assert.equal(persisted?.batchId, batchId, 'the original known provider ID remains immutable');
      } else {
        assert.equal(persisted?.status, 'failed');
        assert.equal(persisted?.failureCode, 'not_submitted');
      }
      return;
    }
    if (lostProviderAck) assert.equal(failure?.phase, 'unknown');
    else assert.equal(failure, undefined);
    if (!lostProviderAck) {
      assert.equal(result.status, 'finished', JSON.stringify(result));
      assert.equal(result.receipt.kind, 'mail.replyBatch.submit');
      assert.equal(result.receipt.jobStatus, 'queued');
    }
    assert.equal(providerCalls.length, 1, 'known provider admission is not repeated after consent is paused');

    const durable = kernel.withTrustedDatabaseTransaction((db) => ({
      link: db.prepare(`SELECT workspace_id,owner_id,privacy_epoch,occurrence_id,attempt_id,command_id,ticket_id,policy_id,policy_revision,
        policy_digest,job_id,custom_id,request_sha256,source_digest,source_version_digest,request_digest FROM background_paid_batch_links
        WHERE workspace_id=? AND occurrence_id=?`).get(enrolled.workspaceId, occurrence.occurrenceId),
      attempt: db.prepare('SELECT status FROM background_occurrence_attempts WHERE occurrence_id=? AND attempt_id=?')
        .get(occurrence.occurrenceId, claimed.claim.attemptId),
      command: db.prepare('SELECT status,command_kind FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?')
        .get(enrolled.workspaceId, commandId),
    }));
    assert.ok(durable.link);
    assert.equal(durable.link.command_id, commandId);
    assert.ok(durable.link.job_id);
    assert.equal(durable.link.custom_id, durable.link.job_id);
    assert.equal(durable.attempt.status, 'dispatching', 'the private paid occurrence remains linked for later known-ID observation');
    if (!lostProviderAck) assert.deepEqual(durable.command, { status: 'finished', command_kind: 'mail.replybatch.submit' });
    const after = kernel.withOwnedTransaction(actor, 0, (context) => kernel.readOwnedSnapshotWithinTransaction(context).snapshot);
    const savedJob = after.openRouterBatchLedger.jobs.find((job) => job.id === durable.link.job_id);
    assert.equal(savedJob?.status, lostProviderAck ? 'submission_unknown' : 'queued');
  } finally {
    releaseProviderResolve?.();
    if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
    if (actors) await actors.closeAfterDrain(async () => {});
    if (opened) opened.foundation.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    globalThis.Date = realDate;
  }
}
