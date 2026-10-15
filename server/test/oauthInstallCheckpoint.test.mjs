import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { AuthService, createDurableKernel, SecretVault } from '../dist/index.js';
import { CommandJournal, ServerWorkspaceStore, currentCommandTicket } from '../dist/workspaceRuntime.js';
import { OAuthInstallStages } from '../dist/oauthInstallStages.js';
import { ServerOAuthTokenBindings } from '../dist/oauthTokenBindings.js';
import { NodeVaultOAuthTokenStore } from '../dist/applicationHost.node.mjs';
import { OwnedWorkspaceRuntime } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { dispatchWorkspaceCommand, inspectWorkspaceCommand } from '../dist/workspaceCommands.node.mjs';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 3));
const vaultKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 101));
const origin = 'https://still.example';
const password = 'correct horse battery staple';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-oauth-install-checkpoint-'));
  const databasePath = join(directory, 'kernel.sqlite');
  let time = 1_800_000_000_000;
  const now = () => time;
  const kernel = createDurableKernel({ databasePath, now, validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const auth = new AuthService(kernel, { canonicalOrigin: origin, authSecret, now });
  const vault = new SecretVault(kernel, vaultKey);
  const stages = new OAuthInstallStages(kernel, vault, auth);
  const bindings = new ServerOAuthTokenBindings(kernel);
  return { directory, databasePath, now, kernel, auth, vault, stages, bindings };
}

function cleanup(f) {
  f.vault.close(); f.auth.close(); f.kernel.close();
  rmSync(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function login(f, initialSnapshot = { accounts: [], notes: [], marker: 'before' }) {
  await f.auth.enrollOwner(password, initialSnapshot);
  return loginAgain(f);
}

async function loginAgain(f) {
  const challenge = f.auth.createLoginChallenge(origin);
  return f.auth.login({ password, origin, preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
}

async function loginForControllerRuntime(f) {
  await f.auth.enrollOwner(password, createInitialWorkspaceState(randomUUID));
  return loginAgain(f);
}

function withOwned(f, token, work) {
  const identity = f.kernel.getOwnedIdentity(token);
  return f.kernel.withOwnedTransaction(token, identity.privacyEpoch, work);
}

function startVerifiedStage(f, token, provider = 'google', reconnectLifecycle) {
  const started = withOwned(f, token, (context) => f.stages.createAuthorization(context, {
    initiatingSessionToken: token, registrationId: `${provider}-main`, provider, requestedCapabilities: ['mail.read'],
    ...(reconnectLifecycle ? { reconnectLifecycle } : {}),
  }));
  const claimed = withOwned(f, token, (context) => f.stages.claimExchange(context, {
    state: started.authorization.state, cookieBinding: started.authorization.cookieBinding,
  }));
  assert.equal(claimed.claimed, true);
  const identity = provider === 'google'
    ? { providerNamespace: 'google', clientId: 'synthetic-google-client', subject: 'subject-google', issuer: 'https://accounts.google.com' }
    : { providerNamespace: 'microsoft', clientId: 'synthetic-ms-client', subject: 'subject-ms', issuer: 'https://login.microsoftonline.com/common/v2.0', resourceUserId: 'resource-ms' };
  const grantedScopes = provider === 'google'
    ? ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']
    : ['openid', 'email', 'Mail.Read'];
  const verified = withOwned(f, token, (context) => f.stages.completeVerified(context, claimed.claim, {
    provider, accessToken: `synthetic-${provider}-access`, refreshToken: `synthetic-${provider}-refresh`, expiresAt: f.now() + 600_000,
    grantedScopes, requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], identity,
    displayName: `${provider} user`, email: `${provider}@example.test`,
  }));
  assert.equal(verified.status, 'verified');
  return started.status;
}

function installEnvelope(commandId, stageId, expectedRevision = 0, expectedPrivacyEpoch = 0) {
  return JSON.stringify({ command: { kind: 'accounts.installOAuth', stageId }, commandId, expectedPrivacyEpoch, expectedRevision, schemaVersion: 1 });
}

test('atomic OAuth install consumes the exact verified stage with snapshot, generation, vault slot, binding, and receipt', async () => {
  const f = setup();
  try {
    const admission = await login(f);
    const owner = f.kernel.getOwnedIdentity(admission.sessionToken);
    const runtimeSession = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const stage = startVerifiedStage(f, admission.sessionToken, 'google');
    const journal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings }, now: f.now });
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: runtimeSession, journal });
    await store.load();
    const commandId = randomUUID();
    const admitted = journal.admit({ admissionSessionToken: admission.sessionToken, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: commandId, kind: 'accounts.installoauth', canonicalBody: installEnvelope(commandId, stage.attemptId) });
    assert.equal(admitted.fresh, true);
    let facts;
    const accountId = 'acct:opaque:日本語';
    const tokenRef = `oauth-${randomUUID()}`;
    await journal.run(admitted.ticket, runtimeSession, async () => {
      facts = journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
      assert.deepEqual(Object.keys(facts).sort(), ['capabilities', 'displayName', 'email', 'expiresAt', 'identity', 'provider',
        'requestedCapabilities', 'grantedScopes', 'stageId', 'stagePayloadGeneration'].sort());
      assert.equal(facts.stageId, stage.attemptId);
      const account = { id: accountId, provider: 'google', displayName: facts.displayName, email: 'google@example.test',
        verifiedEmail: 'google@example.test', connected: true, authStatus: 'connected', identity: facts.identity, tokenRef,
        grantedScopes: [...facts.grantedScopes], capabilities: ['mail.read'], capabilityLimits: ['mail.read'], syncStatus: 'idle',
        configuredAt: new Date(f.now()).toISOString(), connectionGeneration: 1 };
      await store.save({ accounts: [account], notes: [], marker: 'installed' }, { consumeOAuthInstall: {
        stageId: facts.stageId, stagePayloadGeneration: facts.stagePayloadGeneration, accountId, accountGeneration: 1, tokenRef,
      } });
      journal.finish({ ...admitted.ticket, runtimeSessionToken: runtimeSession }, { schemaVersion: 1, commandId,
        kind: 'accounts.installOAuth', objectId: accountId, stageId: stage.attemptId, accountGeneration: 1 });
    });

    assert.equal(f.kernel.getOwnedSnapshot(runtimeSession).snapshot.accounts[0].id, accountId);
    const credential = withOwned(f, runtimeSession, (context) => f.vault.getSecretWithinTransaction(context,
      { type: 'account', accountId, expectedAccountGeneration: 1 }, 'googleOAuth'));
    assert.equal(JSON.parse(credential).refreshToken, 'synthetic-google-refresh');
    assert.equal(withOwned(f, runtimeSession, (context) => f.bindings.readBindingWithinTransaction(context, tokenRef)).accountId, accountId);
    const installedTokenStore = new NodeVaultOAuthTokenStore(f.kernel, f.vault, runtimeSession,
      f.kernel.getOwnedIdentity(runtimeSession), () => f.kernel.getOwnedSnapshot(runtimeSession).snapshot.accounts);
    assert.equal((await installedTokenStore.get(tokenRef))?.refreshToken, 'synthetic-google-refresh');
    const consumed = withOwned(f, runtimeSession, (context) => f.stages.readStatus(context, stage.attemptId,
      admitted.ticket.initiatingSessionBinding));
    assert.equal(consumed.status, 'consumed');
    assert.deepEqual(consumed.consumption, { commandId, accountId, accountGeneration: 1 });
    const inspected = journal.inspect(admission.sessionToken, commandId);
    assert.deepEqual(inspected.receipt, { schemaVersion: 1, commandId, kind: 'accounts.installOAuth', objectId: accountId,
      stageId: stage.attemptId, accountGeneration: 1 });
    assert.equal(JSON.stringify(inspected).includes('synthetic-google-refresh'), false);
  } finally { cleanup(f); }
});

test('real controller command dispatch installs Google and Microsoft once with exact public receipts', async () => {
  for (const provider of ['google', 'microsoft']) {
    const f = setup();
    let runtime;
    try {
    const session = await loginForControllerRuntime(f);
    const owner = f.kernel.getOwnedIdentity(session.sessionToken);
    const runtimeSession = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const unavailable = async () => 'unavailable';
    runtime = new OwnedWorkspaceRuntime({ kernel: f.kernel, runtimeSessionFor: () => runtimeSession,
      oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings },
      crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
      providers: { speech: { async transcribe() { throw new Error('provider must not run'); }, async releaseUploadLease() {}, disposeMemory() {} },
        openAi: { async prepare() { throw new Error('provider must not run'); }, async analyze() { throw new Error('provider must not run'); },
          async generateReply() { throw new Error('provider must not run'); } } },
      integration: {
        reminderBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
          async listPending() { return []; }, async schedule() {}, async cancel() {}, async cancelLegacy() {}, async installForegroundHandler() {} },
        mailAlertBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
          async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; } },
        deviceCalendarBackend: { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
          async listCalendars() { return []; }, async getCalendar() { return undefined; }, async readEvents() { return []; },
          async createApprovedEvent() { throw new Error('unsupported'); }, async lookupRecord() { return undefined; } },
        async writeDocument() {}, async removeAudio() {},
        async loadRecordingRecovery() { return { async pickAndStage() { return null; }, async inspect() { throw new Error('unsupported'); }, async remove() {} }; },
        bindRecordingRecovery(service) { return service; },
      },
    });
    const admission = { sessionToken: session.sessionToken, assertCurrent() { f.kernel.getOwnedIdentity(session.sessionToken); } };
    const initial = await runtime.getSnapshot(admission);
    const stage = startVerifiedStage(f, session.sessionToken, provider);
    const commandId = randomUUID();
    const command = { schemaVersion: 1, commandId, expectedRevision: initial.revision, expectedPrivacyEpoch: initial.privacyEpoch,
      command: { kind: 'accounts.installOAuth', stageId: stage.attemptId } };
    const installed = await dispatchWorkspaceCommand(runtime, admission, command);
    assert.equal(installed.status, 'finished');
    assert.equal(installed.receipt.kind, 'accounts.installOAuth');
    assert.equal(installed.receipt.stageId, stage.attemptId);
    assert.equal(installed.receipt.accountGeneration, 1);
    assert.equal(installed.snapshot.state.accounts.length, 1);
    assert.equal(installed.snapshot.state.accounts[0].id, installed.receipt.objectId);
    const inspection = inspectWorkspaceCommand(runtime, admission, commandId);
    assert.equal(inspection.status, 'finished');
    assert.deepEqual(inspection.receipt, installed.receipt);
    assert.equal(Object.hasOwn(installed.snapshot.state.accounts[0], 'tokenRef'), false);
    const installedAccount = f.kernel.getOwnedSnapshot(runtimeSession).snapshot.accounts[0];
    const tokenRef = installedAccount.tokenRef;
    const tokenStore = new NodeVaultOAuthTokenStore(f.kernel, f.vault, runtimeSession, f.kernel.getOwnedIdentity(runtimeSession),
      () => f.kernel.getOwnedSnapshot(runtimeSession).snapshot.accounts);
    assert.equal((await tokenStore.get(tokenRef))?.refreshToken, `synthetic-${provider}-refresh`);
    const replay = await dispatchWorkspaceCommand(runtime, admission, command);
    assert.deepEqual(replay.receipt, installed.receipt);
    assert.equal(f.kernel.getOwnedSnapshot(runtimeSession).snapshot.accounts.length, 1);
    const expectedBody = installEnvelope(commandId, stage.attemptId, initial.revision, initial.privacyEpoch);
    await runtime.closeAfterDrain();
    runtime = undefined;
    f.vault.close(); f.auth.close(); f.kernel.close();
    f.kernel = createDurableKernel({ databasePath: f.databasePath, now: f.now,
      validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
    f.auth = new AuthService(f.kernel, { canonicalOrigin: origin, authSecret, now: f.now });
    f.vault = new SecretVault(f.kernel, vaultKey);
    f.stages = new OAuthInstallStages(f.kernel, f.vault, f.auth);
    f.bindings = new ServerOAuthTokenBindings(f.kernel);
    const reopenedJournal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings }, now: f.now });
    const recovered = reopenedJournal.inspect(session.sessionToken, commandId);
    assert.equal(recovered.status, 'finished');
    assert.deepEqual(recovered.receipt, installed.receipt);
    const afterRestart = reopenedJournal.admit({ admissionSessionToken: session.sessionToken, expectedRevision: initial.revision,
      expectedPrivacyEpoch: initial.privacyEpoch, idempotencyKey: commandId, kind: 'accounts.installoauth', canonicalBody: expectedBody });
    assert.equal(afterRestart.fresh, false);
    assert.equal(afterRestart.ticket, undefined);
    assert.deepEqual(afterRestart.receipt, installed.receipt);
    } finally { await runtime?.closeAfterDrain(); cleanup(f); }
  }
});

test('OAuth install admission is bound to the originating authenticated session and duplicate admission never rebinds', async () => {
  const f = setup();
  try {
    const first = await login(f);
    const owner = f.kernel.getOwnedIdentity(first.sessionToken);
    const second = await loginAgain(f);
    const stage = startVerifiedStage(f, first.sessionToken);
    const journal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings }, now: f.now });
    const commandId = randomUUID();
    const body = installEnvelope(commandId, stage.attemptId);
    const admitted = journal.admit({ admissionSessionToken: first.sessionToken, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: commandId, kind: 'accounts.installoauth', canonicalBody: body });
    const originalBinding = admitted.ticket.initiatingSessionBinding;
    const duplicate = journal.admit({ admissionSessionToken: second.sessionToken, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: commandId, kind: 'accounts.installoauth', canonicalBody: body });
    assert.equal(duplicate.fresh, false);
    assert.equal(duplicate.ticket, undefined);
    assert.equal(admitted.ticket.initiatingSessionBinding, originalBinding);
    const secondCommandId = randomUUID();
    const secondAdmission = journal.admit({ admissionSessionToken: second.sessionToken, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: secondCommandId, kind: 'accounts.installoauth', canonicalBody: installEnvelope(secondCommandId, stage.attemptId) });
    const runtimeForSecond = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    await assert.rejects(journal.run(secondAdmission.ticket, runtimeForSecond, async () => {
      journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
    }), /stage|binding|session|inspect_required/i);
    assert.equal(journal.inspect(second.sessionToken, secondCommandId).status, 'inspect_required');
    f.kernel.revokeSession(first.sessionToken);
    const runtime = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const journalStore = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: runtime, journal });
    await journalStore.load();
    await assert.rejects(journal.run(admitted.ticket, runtime, async () => {
      journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
    }), /session|initiating|stage_inspect_required/i);
    assert.equal(journal.inspect(second.sessionToken, commandId).status, 'inspect_required');
  } finally { cleanup(f); }
});

test('failed lifecycle validation rolls back workspace, vault, token binding, stage consumption, and journal finish together', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const owner = f.kernel.getOwnedIdentity(session.sessionToken);
    const runtime = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const stage = startVerifiedStage(f, session.sessionToken);
    const journal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings }, now: f.now });
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: runtime, journal });
    await store.load();
    const commandId = randomUUID();
    const baseline = f.kernel.getOwnedSnapshot(runtime);
    const admitted = journal.admit({ admissionSessionToken: session.sessionToken, expectedRevision: baseline.revision, expectedPrivacyEpoch: baseline.privacyEpoch,
      idempotencyKey: commandId, kind: 'accounts.installoauth', canonicalBody: installEnvelope(commandId, stage.attemptId, baseline.revision, baseline.privacyEpoch) });
    const tokenRef = `oauth-${randomUUID()}`;
    const accountId = randomUUID();
    await assert.rejects(journal.run(admitted.ticket, runtime, async () => {
      const facts = journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
      await store.save({ accounts: [{ id: accountId, provider: 'google', displayName: facts.displayName, email: 'wrong@example.test',
        verifiedEmail: 'wrong@example.test', connected: true, authStatus: 'connected', identity: facts.identity, tokenRef,
        grantedScopes: [...facts.grantedScopes], capabilities: ['mail.read'], capabilityLimits: ['mail.read'], connectionGeneration: 1 }], notes: [] },
      { consumeOAuthInstall: { stageId: facts.stageId, stagePayloadGeneration: facts.stagePayloadGeneration, accountId, accountGeneration: 1, tokenRef } });
    }), /candidate_invalid/);
    assert.deepEqual(f.kernel.getOwnedSnapshot(runtime).snapshot, baseline.snapshot);
    assert.equal(f.kernel.getOwnedSnapshot(runtime).revision, baseline.revision);
    const credentialRows = f.kernel.withTrustedDatabaseTransaction((db) => ({
      metadata: db.prepare(`SELECT configured FROM vault_metadata WHERE workspace_id=? AND scope_type='account' AND scope_id=? AND purpose='googleOAuth'`)
        .get(owner.workspaceId, accountId),
      ciphertext: db.prepare(`SELECT 1 AS present FROM vault_ciphertexts WHERE workspace_id=? AND scope_type='account' AND scope_id=? AND purpose='googleOAuth'`)
        .get(owner.workspaceId, accountId),
    }));
    assert.equal(credentialRows.metadata, undefined);
    assert.equal(credentialRows.ciphertext, undefined);
    assert.equal(withOwned(f, runtime, (context) => f.bindings.readBindingWithinTransaction(context, tokenRef)), undefined);
    assert.equal(withOwned(f, runtime, (context) => f.stages.readStatus(context, stage.attemptId,
      admitted.ticket.initiatingSessionBinding)).status, 'verified');
    assert.equal(journal.inspect(session.sessionToken, commandId).status, 'inspect_required');
  } finally { cleanup(f); }
});

test('Microsoft verified install writes the Microsoft account slot and Node token lookup accepts the exact binding', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const owner = f.kernel.getOwnedIdentity(session.sessionToken);
    const runtime = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const stage = startVerifiedStage(f, session.sessionToken, 'microsoft');
    const journal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings }, now: f.now });
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: runtime, journal });
    const baseline = await store.load();
    const commandId = randomUUID();
    const admitted = journal.admit({ admissionSessionToken: session.sessionToken, expectedRevision: 0, expectedPrivacyEpoch: 0,
      idempotencyKey: commandId, kind: 'accounts.installoauth', canonicalBody: installEnvelope(commandId, stage.attemptId) });
    const tokenRef = `oauth-${randomUUID()}`;
    const accountId = 'ms:opaque-account';
    await journal.run(admitted.ticket, runtime, async () => {
      const facts = journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
      const account = { id: accountId, provider: 'microsoft', displayName: facts.displayName, email: 'microsoft@example.test',
        verifiedEmail: 'microsoft@example.test', connected: true, authStatus: 'connected', identity: facts.identity, tokenRef,
        grantedScopes: [...facts.grantedScopes], capabilities: ['mail.read'], capabilityLimits: ['mail.read'], syncStatus: 'idle',
        configuredAt: new Date(f.now()).toISOString(), connectionGeneration: 1 };
      await store.save({ ...baseline, accounts: [account] }, { consumeOAuthInstall: { stageId: facts.stageId,
        stagePayloadGeneration: facts.stagePayloadGeneration, accountId, accountGeneration: 1, tokenRef } });
    });
    const tokenStore = new NodeVaultOAuthTokenStore(f.kernel, f.vault, runtime, f.kernel.getOwnedIdentity(runtime),
      () => f.kernel.getOwnedSnapshot(runtime).snapshot.accounts);
    const stored = await tokenStore.get(tokenRef);
    assert.equal(stored?.accessToken, 'synthetic-microsoft-access');
    assert.equal(stored?.refreshToken, 'synthetic-microsoft-refresh');
    assert.equal(stored?.identity.subject, f.kernel.getOwnedSnapshot(runtime).snapshot.accounts[0].identity.subject);
  } finally { cleanup(f); }
});

test('reauthenticated and configured-placeholder lifecycles reconnect only the exact stored account generation', async () => {
  for (const lifecycleCase of [
    { name: 'reauthenticated', authStatus: 'reauth_required', connected: false, tokenRef: 'oauth-previous-ref',
      identity: { providerNamespace: 'google', clientId: 'synthetic-google-client', subject: 'subject-google', issuer: 'https://accounts.google.com' } },
    { name: 'configured placeholder', authStatus: 'configured', connected: false },
  ]) {
    const f = setup();
    try {
      const accountId = `reconnect:${lifecycleCase.name}`;
      const priorAccount = { id: accountId, provider: 'google', displayName: 'Prior user', email: 'prior@example.test',
        connected: lifecycleCase.connected, authStatus: lifecycleCase.authStatus, connectionGeneration: 1,
        ...(lifecycleCase.tokenRef ? { tokenRef: lifecycleCase.tokenRef } : {}),
        ...(lifecycleCase.identity ? { identity: lifecycleCase.identity } : {}) };
      const session = await login(f, { accounts: [priorAccount], notes: [], marker: 'before-reconnect' });
      const owner = f.kernel.getOwnedIdentity(session.sessionToken);
      f.kernel.runLocalCommand(session.sessionToken, { expectedRevision: 0, expectedPrivacyEpoch: 0,
        idempotencyKey: randomUUID(), type: 'fixture.account_generation', canonicalRequest: '{"account":"seed"}' }, () => ({
        snapshot: { accounts: [priorAccount], notes: [], marker: 'before-reconnect' }, receipt: { kind: 'fixture' },
        accountGenerations: { [accountId]: 1 },
      }));
      const runtime = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
      const lifecycle = { accountId, connectionGeneration: 1, connected: lifecycleCase.connected, authStatus: lifecycleCase.authStatus,
        ...(lifecycleCase.tokenRef ? { tokenRef: lifecycleCase.tokenRef } : {}),
        ...(lifecycleCase.identity ? { identity: lifecycleCase.identity } : {}) };
      const stage = startVerifiedStage(f, session.sessionToken, 'google', lifecycle);
      const journal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings }, now: f.now });
      const workspaceStore = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: runtime, journal });
      const baseline = await workspaceStore.load();
      const head = f.kernel.getOwnedSnapshot(runtime);
      const commandId = randomUUID();
      const admitted = journal.admit({ admissionSessionToken: session.sessionToken, expectedRevision: head.revision,
        expectedPrivacyEpoch: head.privacyEpoch, idempotencyKey: commandId, kind: 'accounts.installoauth',
        canonicalBody: installEnvelope(commandId, stage.attemptId, head.revision, head.privacyEpoch) });
      const tokenRef = `oauth-${randomUUID()}`;
      await journal.run(admitted.ticket, runtime, async () => {
        const facts = journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
        assert.deepEqual(facts.expectedLifecycle, lifecycle);
        const updatedAccount = { id: accountId, provider: 'google', displayName: facts.displayName, email: facts.email,
          verifiedEmail: facts.email, connected: true, authStatus: 'connected', identity: facts.identity, tokenRef,
          grantedScopes: [...facts.grantedScopes], capabilities: ['mail.read'], capabilityLimits: ['mail.read'], syncStatus: 'idle',
          configuredAt: new Date(f.now()).toISOString(), connectionGeneration: 2 };
        await workspaceStore.save({ ...baseline, accounts: [updatedAccount] }, { consumeOAuthInstall: { stageId: stage.attemptId,
          stagePayloadGeneration: facts.stagePayloadGeneration, accountId, accountGeneration: 2, tokenRef } });
      });
      const installed = f.kernel.getOwnedSnapshot(runtime).snapshot.accounts[0];
      assert.equal(installed.id, accountId);
      assert.equal(installed.connectionGeneration, 2);
      assert.equal(installed.authStatus, 'connected');
      assert.equal(installed.identity.subject, 'subject-google');
    } finally { cleanup(f); }
  }
});

test('every atomic install write boundary rolls back all prior workspace, vault, binding, stage, and receipt writes', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const owner = f.kernel.getOwnedIdentity(session.sessionToken);
    const runtime = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const phases = ['after_workspace', 'after_vault', 'after_binding', 'after_stage', 'after_receipt'];
    for (const [index, phase] of phases.entries()) {
      const stage = startVerifiedStage(f, session.sessionToken);
      const journal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings },
        oauthInstallFailureForTesting: phase, now: f.now });
      const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: runtime, journal });
      const baseline = await store.load();
      const baselineSnapshot = f.kernel.getOwnedSnapshot(runtime);
      const commandId = randomUUID();
      const admitted = journal.admit({ admissionSessionToken: session.sessionToken, expectedRevision: baselineSnapshot.revision,
        expectedPrivacyEpoch: baselineSnapshot.privacyEpoch, idempotencyKey: commandId, kind: 'accounts.installoauth',
        canonicalBody: installEnvelope(commandId, stage.attemptId, baselineSnapshot.revision, baselineSnapshot.privacyEpoch) });
      const accountId = `fault-test-${index}`;
      const tokenRef = `oauth-${randomUUID()}`;
      await assert.rejects(journal.run(admitted.ticket, runtime, async () => {
        const facts = journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
        const account = { id: accountId, provider: facts.provider, displayName: facts.displayName, email: facts.email,
          verifiedEmail: facts.email, connected: true, authStatus: 'connected', identity: facts.identity, tokenRef,
          grantedScopes: [...facts.grantedScopes], capabilities: ['mail.read'], capabilityLimits: ['mail.read'], connectionGeneration: 1 };
        await store.save({ ...baseline, accounts: [...baseline.accounts, account] }, { consumeOAuthInstall: { stageId: stage.attemptId,
          stagePayloadGeneration: facts.stagePayloadGeneration, accountId, accountGeneration: 1, tokenRef } });
      }), new RegExp(`oauth_install_test_failure_${phase}`));
      const after = f.kernel.getOwnedSnapshot(runtime);
      assert.equal(after.revision, baselineSnapshot.revision, `${phase}: workspace checkpoint must roll back`);
      assert.deepEqual(after.snapshot, baselineSnapshot.snapshot, `${phase}: snapshot must roll back`);
      assert.equal(withOwned(f, runtime, (context) => f.stages.readStatus(context, stage.attemptId,
        admitted.ticket.initiatingSessionBinding)).status, 'verified', `${phase}: stage remains retry-inspection only, not consumed`);
      assert.equal(withOwned(f, runtime, (context) => f.bindings.readBindingWithinTransaction(context, tokenRef)), undefined,
        `${phase}: binding must roll back`);
      assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`SELECT 1 FROM vault_ciphertexts WHERE workspace_id=?
        AND scope_type='account' AND scope_id=? AND purpose='googleOAuth'`).get(owner.workspaceId, accountId)), undefined,
        `${phase}: vault ciphertext must roll back`);
      assert.equal(journal.inspect(session.sessionToken, commandId).status, 'inspect_required', `${phase}: failed command is not replayable`);
    }
  } finally { cleanup(f); }
});

test('lost post-commit acknowledgement is recovered by exact receipt inspection without a second install', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const owner = f.kernel.getOwnedIdentity(session.sessionToken);
    const runtime = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const stage = startVerifiedStage(f, session.sessionToken);
    const journal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings }, now: f.now });
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: runtime, journal,
      afterCommitForTesting: () => { throw new Error('synthetic acknowledgement loss'); } });
    const baseline = await store.load();
    const baselineSnapshot = f.kernel.getOwnedSnapshot(runtime);
    const commandId = randomUUID();
    const body = installEnvelope(commandId, stage.attemptId, baselineSnapshot.revision, baselineSnapshot.privacyEpoch);
    const admitted = journal.admit({ admissionSessionToken: session.sessionToken, expectedRevision: baselineSnapshot.revision,
      expectedPrivacyEpoch: baselineSnapshot.privacyEpoch, idempotencyKey: commandId, kind: 'accounts.installoauth', canonicalBody: body });
    const tokenRef = `oauth-${randomUUID()}`;
    let executions = 0;
    await assert.rejects(journal.run(admitted.ticket, runtime, async () => {
      executions += 1;
      const facts = journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
      const account = { id: 'ack-loss-account', provider: facts.provider, displayName: facts.displayName, email: facts.email,
        verifiedEmail: facts.email, connected: true, authStatus: 'connected', identity: facts.identity, tokenRef,
        grantedScopes: [...facts.grantedScopes], capabilities: ['mail.read'], capabilityLimits: ['mail.read'], connectionGeneration: 1 };
      await store.save({ ...baseline, accounts: [account] }, { consumeOAuthInstall: { stageId: stage.attemptId,
        stagePayloadGeneration: facts.stagePayloadGeneration, accountId: account.id, accountGeneration: 1, tokenRef } });
    }), /acknowledgement loss/);
    const exact = journal.inspect(session.sessionToken, commandId);
    assert.equal(exact.status, 'finished');
    assert.equal(exact.receipt.stageId, stage.attemptId);
    assert.equal(exact.receipt.accountGeneration, 1);
    assert.equal(executions, 1);
    const duplicate = journal.admit({ admissionSessionToken: session.sessionToken, expectedRevision: baselineSnapshot.revision,
      expectedPrivacyEpoch: baselineSnapshot.privacyEpoch, idempotencyKey: commandId, kind: 'accounts.installoauth', canonicalBody: body });
    assert.equal(duplicate.fresh, false);
    assert.equal(duplicate.ticket, undefined);
    assert.deepEqual(duplicate.receipt, exact.receipt);
    assert.equal(executions, 1);
    await store.load();
    assert.equal(f.kernel.getOwnedSnapshot(runtime).revision, 1);
  } finally { cleanup(f); }
});

test('logout after facts preparation terminalizes the stage and cannot promote a token or workspace account', async () => {
  const f = setup();
  try {
    const session = await login(f);
    const owner = f.kernel.getOwnedIdentity(session.sessionToken);
    const observer = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const runtime = f.kernel.createSession(owner.workspaceId, owner.ownerId, f.now() + 60 * 60_000);
    const stage = startVerifiedStage(f, session.sessionToken);
    const journal = new CommandJournal(f.kernel, { oauthInstall: { auth: f.auth, vault: f.vault, stages: f.stages, bindings: f.bindings }, now: f.now });
    const workspaceStore = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: runtime, journal });
    const baseline = await workspaceStore.load();
    const head = f.kernel.getOwnedSnapshot(runtime);
    const commandId = randomUUID();
    const admitted = journal.admit({ admissionSessionToken: session.sessionToken, expectedRevision: head.revision,
      expectedPrivacyEpoch: head.privacyEpoch, idempotencyKey: commandId, kind: 'accounts.installoauth',
      canonicalBody: installEnvelope(commandId, stage.attemptId, head.revision, head.privacyEpoch) });
    const tokenRef = `oauth-${randomUUID()}`;
    await assert.rejects(journal.run(admitted.ticket, runtime, async () => {
      const facts = journal.prepareOAuthInstallFacts(currentCommandTicket(), stage.attemptId);
      f.auth.logout(session.sessionToken, origin, session.session.csrfToken);
      const account = { id: 'must-not-install', provider: facts.provider, displayName: facts.displayName, email: facts.email,
        verifiedEmail: facts.email, connected: true, authStatus: 'connected', identity: facts.identity, tokenRef,
        grantedScopes: [...facts.grantedScopes], capabilities: ['mail.read'], capabilityLimits: ['mail.read'], connectionGeneration: 1 };
      await workspaceStore.save({ ...baseline, accounts: [account] }, { consumeOAuthInstall: { stageId: stage.attemptId,
        stagePayloadGeneration: facts.stagePayloadGeneration, accountId: account.id, accountGeneration: 1, tokenRef } });
    }), /oauth_install_stage_inspect_required/);
    assert.equal(JSON.stringify(f.kernel.getOwnedSnapshot(runtime).snapshot), JSON.stringify(baseline));
    assert.equal(withOwned(f, runtime, (context) => f.bindings.readBindingWithinTransaction(context, tokenRef)), undefined);
    assert.equal(withOwned(f, runtime, (context) => f.stages.readStatus(context, stage.attemptId,
      admitted.ticket.initiatingSessionBinding)).status, 'inspect_required');
    assert.equal(journal.inspect(observer, commandId).status, 'inspect_required');
  } finally { cleanup(f); }
});
