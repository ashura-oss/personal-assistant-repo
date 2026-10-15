import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { BackgroundPolicyStore } from '../dist/backgroundPolicies.js';
import { ProcessWorkspaceActors, RUNTIME_ACTOR_EXPIRES_AT } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { ServerOAuthTokenBindings } from '../dist/oauthTokenBindings.js';

const CLIENT_ID = 'background-fairness-client';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function state(accountId, subject, tokenRef) {
  const value = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter',
    openRouterModel: 'openai/gpt-6-luna:batch', openRouterReasoningEffort: 'none', llmRequestContractVersion: 1 });
  value.accounts.push({ id: accountId, provider: 'google', displayName: `Mailbox ${subject}`, email: `${subject}@example.test`,
    connected: true, authStatus: 'connected', identity: { providerNamespace: 'google', clientId: CLIENT_ID,
      subject, issuer: 'https://accounts.google.com' }, tokenRef, grantedScopes: [SCOPE], capabilities: ['mail.read'],
    capabilityLimits: ['mail.read'], connectionGeneration: 1, syncStatus: 'idle' });
  return value;
}

function identityKey(account) {
  const identity = account.identity;
  return createHash('sha256').update(JSON.stringify({ provider: account.provider, providerNamespace: identity.providerNamespace,
    clientId: identity.clientId, subject: identity.subject, issuer: identity.issuer ?? null, tenantId: identity.tenantId ?? null,
    resourceUserId: identity.resourceUserId ?? null })).digest('hex');
}

test('production background runtime suspends stale authority and continues healthy workspace without a browser', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-background-fairness-'));
  let enrollment;
  let actors;
  let runtime;
  const requests = [];
  try {
    mkdirSync(join(directory, 'public'), { recursive: true });
    const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
      STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: CLIENT_ID,
      STILL_GOOGLE_CLIENT_SECRET: 'synthetic-background-client-secret' }, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
    const staleCases = [
      { workspaceId: undefined, accountId: 'google:stale-identity', tokenRef: 'token-stale-identity', subject: 'old-identity', invalidation: 'identity' },
      { accountId: 'google:stale-generation', tokenRef: 'token-stale-generation', subject: 'old-generation', invalidation: 'generation' },
      { accountId: 'google:stale-disconnected', tokenRef: 'token-stale-disconnected', subject: 'old-disconnected', invalidation: 'disconnected' },
      { accountId: 'google:stale-capability', tokenRef: 'token-stale-capability', subject: 'old-capability', invalidation: 'capability' },
    ];
    const invalidSnapshot = state(staleCases[0].accountId, staleCases[0].subject, staleCases[0].tokenRef);
    enrollment = openServerFoundationInternal(config, { initialWorkspaceSnapshot: () => invalidSnapshot });
    const enrolled = await enrollment.foundation.auth.enrollOwner('background fairness fixture password', invalidSnapshot);
    const { kernel, vault } = enrollment.privateContext;
    staleCases[0].workspaceId = enrolled.workspaceId;
    for (const fixture of staleCases.slice(1)) fixture.workspaceId = kernel.createWorkspace(enrolled.ownerId,
      state(fixture.accountId, fixture.subject, fixture.tokenRef)).workspaceId;
    const healthyId = kernel.createWorkspace(enrolled.ownerId, state('google:healthy', 'healthy-subject', 'token-healthy')).workspaceId;
    const tokens = new Map();
    const tokenFixtures = [...staleCases.map((item) => [item.workspaceId, item.accountId, item.tokenRef, item.subject]),
      [healthyId, 'google:healthy', 'token-healthy', 'healthy-subject']];
    for (const [workspaceId, accountId, tokenRef, subject] of tokenFixtures) {
      const actor = kernel.createSession(workspaceId, enrolled.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
      kernel.recordAccountGeneration(actor, accountId, 1);
      tokens.set(workspaceId, actor);
      kernel.withOwnedTransaction(actor, 0, (context) => {
        const credential = vault.setSecretWithinTransaction(context, { type: 'account', accountId, expectedAccountGeneration: 1 },
          'googleOAuth', 0, JSON.stringify({ accessToken: `synthetic-${subject}`, expiresAt: Date.now() + 3_600_000,
            identity: { providerNamespace: 'google', clientId: CLIENT_ID, subject, issuer: 'https://accounts.google.com' } }));
        new ServerOAuthTokenBindings(kernel).writeExistingCredentialBindingWithinTransaction(context, { tokenRef, accountId,
          provider: 'google', accountGeneration: 1, credentialGeneration: credential.generation });
      });
    }
    const resolver = { resolve(context, specification) {
      if (specification.kind !== 'account_sync') throw new Error('background_policy_kind_unavailable');
      const snapshot = kernel.readOwnedSnapshotWithinTransaction(context).snapshot;
      return { accounts: specification.accounts.map((selection) => {
        const account = snapshot.accounts.find((item) => item.id === selection.accountId);
        if (!account || !account.connected || account.authStatus !== 'connected' || account.connectionGeneration !== selection.expectedConnectionGeneration) {
          throw new Error('background_binding_changed');
        }
        return { accountId: account.id, provider: account.provider, identityKey: identityKey(account),
          connectionGeneration: account.connectionGeneration, label: account.displayName, connected: account.connected };
      }) };
    } };
    const seedAuth = { bindInitiatingSessionWithinTransaction() {} };
    const clock = () => Date.now() - 180_000;
    const seeder = new BackgroundPolicyStore({ kernel, auth: seedAuth, resolver, clock });
    for (const [workspaceId, accountId] of [...staleCases.map((item) => [item.workspaceId, item.accountId]),
      [healthyId, 'google:healthy']]) {
      const actor = tokens.get(workspaceId);
      seeder.save(actor, { commandId: randomUUID(), expectedPrivacyEpoch: 0, policyId: randomUUID(), expectedPolicyRevision: 0,
        enabled: true, specification: { kind: 'account_sync', accounts: [{ accountId, expectedConnectionGeneration: 1 }],
          resources: ['mail'], intervalMinutes: 1 } });
    }
    kernel.withTrustedDatabaseTransaction((db) => {
      for (const fixture of staleCases) {
        const row = db.prepare('SELECT snapshot_json,revision FROM workspaces WHERE id=?').get(fixture.workspaceId);
        const changed = JSON.parse(row.snapshot_json);
        const account = changed.accounts.find((item) => item.id === fixture.accountId);
        if (fixture.invalidation === 'identity') account.identity.subject = 'changed-same-generation';
        if (fixture.invalidation === 'generation') account.connectionGeneration = 2;
        if (fixture.invalidation === 'disconnected') { account.connected = false; account.authStatus = 'reauth_required'; }
        if (fixture.invalidation === 'capability') account.capabilities = [];
        db.prepare('UPDATE workspaces SET snapshot_json=?,revision=? WHERE id=?').run(JSON.stringify(changed), row.revision + 1, fixture.workspaceId);
      }
    });
    enrollment.privateContext.startup.beginRecovery();
    enrollment.privateContext.startup.seal();
    actors = new ProcessWorkspaceActors(kernel);
    const runtimeSessionFor = (identity) => actors.sessionForRegistry(identity);
    const factory = createProductionApplicationRuntimeFactory(config, { fetcher: async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages')) {
        requests.push(new Headers(init.headers).get('Authorization'));
        return new Response(JSON.stringify({ messages: [], resultSizeEstimate: 0 }), { status: 200,
          headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fairness fixture request to ${new URL(url).origin}`);
    } });
    runtime = await factory({ kernel, vault, auth: enrollment.foundation.auth, runtimeSessionFor,
      listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit), processInstanceId: randomUUID(), createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });

    const readStatus = () => kernel.withTrustedDatabaseTransaction((db) => ({
      stalePolicies: staleCases.map((item) => db.prepare('SELECT h.status,h.suspension FROM background_policy_heads h JOIN workspaces w ON w.id=h.workspace_id WHERE w.id=?').get(item.workspaceId)),
      healthyPolicy: db.prepare('SELECT h.status,h.suspension FROM background_policy_heads h JOIN workspaces w ON w.id=h.workspace_id WHERE w.id=?').get(healthyId),
      history: db.prepare('SELECT command_kind,status,count(*) AS count FROM async_command_journal GROUP BY command_kind,status').all(),
    }));
    const deadline = Date.now() + 8_000;
    let status = readStatus();
    while (!status.history.some((row) => row.command_kind === 'accounts.refreshmail' && row.status === 'finished') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = readStatus();
    }
    assert.deepEqual(requests, ['Bearer synthetic-healthy-subject'], 'only the unaffected workspace should reach the provider');
    assert.deepEqual(status.stalePolicies, staleCases.map(() => ({ status: 'suspended', suspension: 'account_changed' })));
    assert.equal(status.healthyPolicy.status, 'enabled');
    assert.ok(status.history.some((row) => row.command_kind === 'accounts.refreshmail' && row.status === 'finished'));
  } finally {
    if (runtime) {
      runtime.stopAdmission();
      await runtime.drainAndDispose();
    }
    if (actors) await actors.closeAfterDrain(async () => {});
    if (enrollment) enrollment.foundation.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
