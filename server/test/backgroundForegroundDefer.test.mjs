import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { BackgroundOccurrenceStore } from '../dist/backgroundOccurrences.js';
import { ProcessWorkspaceActors, RUNTIME_ACTOR_EXPIRES_AT } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { ServerOAuthTokenBindings } from '../dist/oauthTokenBindings.js';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function waitFor(promise, label, milliseconds = 9_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('foreground account sync causes one durable scheduled deferral and leaves the target claimable later', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-foreground-'));
  mkdirSync(join(directory, 'public'), { recursive: true });
  let enrollment;
  let actors;
  let runtime;
  const providerEntered = deferred();
  const releaseProvider = deferred();
  const providerCalls = [];
  try {
    const identity = { providerNamespace: 'google', clientId: 'foreground-client', subject: 'foreground-subject',
      issuer: 'https://accounts.google.com' };
    const tokenRef = 'foreground-token-ref';
    const accountId = 'google:foreground';
    const snapshot = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
      openRouterModel: 'openai/gpt-6-luna:batch', openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
    snapshot.accounts.push({ id: accountId, provider: 'google', displayName: 'Foreground fixture', email: 'foreground@example.test',
      connected: true, authStatus: 'connected', identity, tokenRef, grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      capabilities: ['mail.read'], capabilityLimits: ['mail.read'], connectionGeneration: 1, syncStatus: 'idle' });
    const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
      STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: identity.clientId,
      STILL_GOOGLE_CLIENT_SECRET: 'synthetic-foreground-client-secret' }, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
    enrollment = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => snapshot });
    const enrolled = await enrollment.foundation.auth.enrollOwner('foreground fixture password', snapshot);
    const { kernel, vault } = enrollment.privateContext;
    const actor = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    kernel.recordAccountGeneration(actor, accountId, 1);
    kernel.withOwnedTransaction(actor, 0, (context) => {
      const credential = vault.setSecretWithinTransaction(context, { type: 'account', accountId, expectedAccountGeneration: 1 },
        'googleOAuth', 0, JSON.stringify({ accessToken: 'synthetic-foreground-access', expiresAt: Date.now() + 3_600_000, identity }));
      new ServerOAuthTokenBindings(kernel).writeExistingCredentialBindingWithinTransaction(context, { tokenRef, accountId,
        provider: 'google', accountGeneration: 1, credentialGeneration: credential.generation });
    });
    const challenge = enrollment.foundation.auth.createLoginChallenge(config.canonicalOrigin);
    const login = await enrollment.foundation.auth.login({ password: 'foreground fixture password', origin: config.canonicalOrigin,
      preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
    enrollment.privateContext.startup.beginRecovery();
    enrollment.privateContext.startup.seal();
    actors = new ProcessWorkspaceActors(kernel);
    const runtimeSessionFor = (workspaceIdentity) => actors.sessionForRegistry(workspaceIdentity);
    const factory = createProductionApplicationRuntimeFactory(config, { fetcher: async (input) => {
      const url = String(input);
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages')) {
        providerCalls.push(url);
        if (providerCalls.length === 1) { providerEntered.resolve(); await releaseProvider.promise; }
        return new Response(JSON.stringify({ messages: [], resultSizeEstimate: 0 }), { status: 200,
          headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected foreground fixture request to ${new URL(url).origin}`);
    } });
    runtime = factory({ kernel, vault, auth: enrollment.foundation.auth, runtimeSessionFor,
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit), processInstanceId: randomUUID() });
    const admission = Object.freeze({ sessionToken: login.sessionToken, assertCurrent: () => kernel.getOwnedIdentity(login.sessionToken) });
    const before = await runtime.workspaceApi.getSnapshot(admission);
    const foreground = runtime.workspaceApi.dispatchCommand(admission, { schemaVersion: 1, commandId: randomUUID(),
      expectedRevision: before.revision, expectedPrivacyEpoch: before.privacyEpoch,
      command: { kind: 'accounts.refreshMail', accountId, expectedConnectionGeneration: 1 } });
    await waitFor(providerEntered.promise, 'foreground provider read did not reach the synthetic barrier');
    const saved = runtime.workspaceApi.saveBackgroundPolicy(admission, { commandId: randomUUID(), expectedPrivacyEpoch: 0,
      policyId: randomUUID(), expectedPolicyRevision: 0, enabled: true,
      specification: { kind: 'account_sync', accounts: [{ accountId, expectedConnectionGeneration: 1 }], resources: ['mail'], intervalMinutes: 1 } });
    assert.equal(saved.status, 'enabled');

    const readState = () => kernel.withTrustedDatabaseTransaction((db) => ({
      attempts: db.prepare('SELECT status,result_code,occurrence_id,target_id,target_generation,attempt_id FROM background_occurrence_attempts ORDER BY claimed_at').all(),
      targets: db.prepare('SELECT status,attempt_id,updated_at,occurrence_id,target_id,target_generation FROM background_occurrence_targets').all(),
    }));
    const deadline = Date.now() + 5_000;
    let state = readState();
    while (!state.attempts.some((attempt) => attempt.result_code === 'foreground_sync_busy') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = readState();
    }
    const deferredAttempt = state.attempts.find((attempt) => attempt.result_code === 'foreground_sync_busy');
    assert.ok(deferredAttempt, `scheduled attempt should be durably deferred: ${JSON.stringify(state)}`);
    assert.equal(deferredAttempt.status, 'skipped');
    assert.equal(state.targets[0].status, 'pending');
    assert.equal(providerCalls.length, 1, 'scheduled work must not overlap the foreground provider read');
    releaseProvider.resolve();
    const foregroundResult = await foreground;
    assert.equal(foregroundResult.status, 'finished');

    runtime.stopAdmission();
    await runtime.drainAndDispose();
    runtime = undefined;
    const runtimeActor = actors.sessionForRegistry({ workspaceId: enrolled.workspaceId, ownerId: enrolled.ownerId,
      privacyEpoch: 0, revision: kernel.getOwnedIdentity(actor).revision });
    const resolver = { resolve(context, specification) {
      const current = kernel.readOwnedSnapshotWithinTransaction(context).snapshot.accounts.find((item) => item.id === accountId);
      if (specification.kind !== 'account_sync' || !current || !current.connected || current.connectionGeneration !== 1) throw new Error('background_binding_changed');
      const canonical = JSON.stringify({ provider: current.provider, providerNamespace: current.identity.providerNamespace,
        clientId: current.identity.clientId, subject: current.identity.subject, issuer: current.identity.issuer ?? null,
        tenantId: current.identity.tenantId ?? null, resourceUserId: current.identity.resourceUserId ?? null });
      return { accounts: [{ accountId, provider: current.provider, identityKey: (awaitHash(canonical)),
        connectionGeneration: 1, label: current.displayName, connected: true }] };
    } };
    const retryClock = () => Date.now() + 61_000;
    const occurrenceStore = new BackgroundOccurrenceStore({ kernel, actorSessionToken: runtimeActor, resolver, clock: retryClock });
    const retry = occurrenceStore.claim({ expectedPrivacyEpoch: 0, occurrenceId: deferredAttempt.occurrence_id,
      targetId: deferredAttempt.target_id, targetGeneration: deferredAttempt.target_generation });
    assert.notEqual(retry.claim.attemptId, deferredAttempt.attempt_id);
    occurrenceStore.deferClaimBeforeDispatch(retry.claim, 0, 'test_cleanup');
  } finally {
    releaseProvider.resolve();
    if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
    if (actors) await actors.closeAfterDrain(async () => {});
    if (enrollment) enrollment.foundation.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function awaitHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
