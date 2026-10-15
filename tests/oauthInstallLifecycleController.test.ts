import { describe, expect, it, vi } from 'vitest';
import type { Account, AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import type { OAuthInstallCheckpoint, PreparedOAuthInstallFacts } from '../src/services/oauthInstallContracts';
import type { OAuthBridgeResult, StoredOAuthToken } from '../src/connectors';
import { isValidAccountId as isValidServerAccountId } from '../server/src/accountIds';
import { isValidAccountId } from '../src/core/accountIds';
import { evaluateProactive, type ProactiveRule, type ProactiveMailSource } from '../src/proactive';
import { validateProactiveState } from '../src/proactive/state';
import { SQLiteStateStore } from '../src/storage/platformStorage';
import { IndexedDbStateStore } from '../src/storage/platformStorage.web';
import { createProactiveMailAlertConsent } from '../src/proactiveMailAlerts/planner';

class InstallStore implements StateStore {
  value?: AppState;
  readonly saves: { state: AppState; options?: { consumeOAuthInstall?: OAuthInstallCheckpoint } }[] = [];
  failInstallSave = false;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState, options?: { consumeOAuthInstall?: OAuthInstallCheckpoint }) {
    this.saves.push({ state: structuredClone(state), options: structuredClone(options) });
    if (options?.consumeOAuthInstall && this.failInstallSave) {
      this.failInstallSave = false;
      throw new Error('journal acknowledgement lost');
    }
    this.value = structuredClone(state);
  }
  async clear() { this.value = undefined; }
}

const stageId = '5c55a8d8-3bbd-4f51-8c87-f7739fd0e7c0';
const identity = { providerNamespace: 'google' as const, clientId: 'google-client', subject: 'subject-1', issuer: 'https://accounts.google.com' };
const facts = (overrides: Partial<PreparedOAuthInstallFacts> = {}): PreparedOAuthInstallFacts => ({
  stageId, stagePayloadGeneration: 7, provider: 'google', identity,
  requestedCapabilities: ['mail.read', 'mail.draft'], capabilities: ['mail.read', 'mail.draft'],
  grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
  displayName: 'Google account', email: 'person@example.test', expiresAt: Date.now() + 60_000,
  ...overrides,
});

function existingAccount(overrides: Partial<Account> = {}): Account & { connectionGeneration: number } {
  return {
    id: 'account-1', provider: 'google', displayName: 'Old account', email: 'person@example.test',
    connected: true, authStatus: 'connected', identity, tokenRef: 'old-token',
    grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], capabilities: ['mail.read'],
    capabilityLimits: ['mail.read', 'mail.draft'], syncStatus: 'idle', ...overrides, connectionGeneration: overrides.connectionGeneration ?? 3,
  } as Account & { connectionGeneration: number };
}

async function seededStore(account: Account): Promise<InstallStore> {
  const store = new InstallStore();
  const seed = new AppControllerImpl(store);
  await seed.load();
  store.value!.accounts = [structuredClone(account)];
  return store;
}

describe('verified staged OAuth installation', () => {
  it('matches the server account-ID boundary without normalizing opaque values', () => {
    const cases = ['', 'mixed Case ', '界'.repeat(341) + 'a', '界'.repeat(341) + 'ab', 'bad\u0000id', '\ud800', '\udc00'];
    for (const candidate of cases) expect(isValidAccountId(candidate)).toBe(isValidServerAccountId(candidate));
    expect(isValidAccountId('mixed Case ')).toBe(true);
    expect(isValidAccountId('界'.repeat(341) + 'a')).toBe(true);
    expect(isValidAccountId('界'.repeat(341) + 'ab')).toBe(false);
  });

  it('persists and reloads evaluator candidates with maximum escaped source tuple components', async () => {
    const accountId = '"'.repeat(1024);
    const namespace = '"\\'.repeat(64);
    const providerId = '\\'.repeat(1024);
    const ruleId = 'r'.repeat(160);
    const sourceVersion = 'v'.repeat(512);
    const rule: ProactiveRule = { id: ruleId, revision: 1, enabled: true, accountIds: [accountId], trigger: { type: 'keyword', keywords: ['Due task'] } };
    const sourceId = JSON.stringify([namespace, accountId, providerId]);
    const source: ProactiveMailSource = {
      kind: 'mail', namespace, accountId, providerId, sourceId, sourceVersion, availability: 'available', freshness: 'fresh',
      subject: 'Due task', isRead: false, receivedAt: '2026-10-15T09:30:00.000Z',
    };
    expect(source.sourceId.length).toBeGreaterThan(2048);
    const evaluated = evaluateProactive({ nowUtc: '2026-10-15T10:00:00.000Z', timeZone: 'UTC', rules: [rule], sources: [source] });
    const candidate = evaluated.activeCandidates[0];
    expect(candidate).toBeDefined();
    expect(candidate.sourceId).toBe(source.sourceId);

    const store = new InstallStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const saved = structuredClone(store.value!);
    saved.proactive.rules = [{ ...rule, version: 1, name: 'Maximum source tuple', createdAt: '2026-10-15T09:00:00.000Z', updatedAt: '2026-10-15T09:00:00.000Z' }];
    saved.proactive.candidates = [{ candidate, presentation: 'active' }];
    saved.proactive.dismissals = [{ ruleId, ruleRevision: 1, sourceId: source.sourceId, sourceVersion, candidateId: candidate.id, dismissedAt: '2026-10-15T09:00:00.000Z' }];
    saved.proactive.snoozes = [{ ruleId, sourceId: source.sourceId, suppressionKey: candidate.suppressionKey,
      until: '2026-10-15T11:00:00.000Z', snoozedAt: '2026-10-15T10:00:00.000Z' }];
    expect(validateProactiveState(saved.proactive)).toMatchObject({ candidates: [{ candidate: { sourceId: source.sourceId } }] });
    await store.save(saved);
    const reloaded = (await store.load())!;
    const validated = validateProactiveState(reloaded.proactive);
    expect(validated.candidates[0].candidate).toEqual(candidate);
    expect(validated.dismissals[0].candidateId).toBe(candidate.id);
    expect(validated.snoozes[0].suppressionKey).toBe(candidate.suppressionKey);
  });

  it('installs a fresh verified identity and binds the checkpoint to the returned account', async () => {
    const store = new InstallStore();
    const prepare = vi.fn(async () => facts());
    const tokenStore = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
    const app = new AppControllerImpl(store, {}, { oauthInstallLifecycle: { prepare }, tokenStore });

    const account = await app.installOAuthStage(stageId);

    expect(prepare).toHaveBeenCalledExactlyOnceWith(stageId);
    expect(account).toMatchObject({ provider: 'google', identity, connected: true, authStatus: 'connected', email: 'person@example.test' });
    expect(account.tokenRef).toMatch(/^oauth-/);
    expect(store.saves.at(-1)?.options?.consumeOAuthInstall).toEqual({
      stageId, stagePayloadGeneration: 7, accountId: account.id, accountGeneration: account.connectionGeneration, tokenRef: account.tokenRef,
    });
    expect(tokenStore.get).not.toHaveBeenCalled();
    expect(tokenStore.set).not.toHaveBeenCalled();
  });

  it('reuses a configured placeholder and preserves the selected account identity on reconnect', async () => {
    const placeholderStore = await seededStore(existingAccount({ identity: undefined, tokenRef: undefined, connected: false, authStatus: 'configured', connectionGeneration: 0 }));
    const placeholder = placeholderStore.value!.accounts[0];
    const placeholderApp = new AppControllerImpl(placeholderStore, {}, { oauthInstallLifecycle: { prepare: async () => facts({ expectedLifecycle: {
      accountId: placeholder.id, connectionGeneration: placeholder.connectionGeneration ?? 0, connected: placeholder.connected,
      authStatus: placeholder.authStatus,
    } }) } });
    await placeholderApp.installOAuthStage(stageId);
    expect(placeholderStore.value!.accounts).toHaveLength(1);
    expect(placeholderStore.value!.accounts[0].id).toBe(placeholder.id);

    const old = existingAccount({ authStatus: 'reauth_required', connected: false });
    const reconnectStore = await seededStore(old);
    const expectedLifecycle = {
      accountId: old.id, connectionGeneration: old.connectionGeneration, tokenRef: old.tokenRef,
      connected: old.connected, authStatus: old.authStatus, identity: old.identity!,
    };
    const reconnectApp = new AppControllerImpl(reconnectStore, {}, { oauthInstallLifecycle: { prepare: async () => facts({ expectedLifecycle }) } });
    const reconnected = await reconnectApp.installOAuthStage(stageId);
    expect(reconnected.id).toBe(old.id);
    expect(reconnected.connectionGeneration).toBe(old.connectionGeneration + 1);
    expect(reconnected.tokenRef).not.toBe(old.tokenRef);
    expect(reconnectStore.value!.accounts).toHaveLength(1);
  });

  it('accepts a bounded Unicode account identifier and Microsoft resource identity', async () => {
    const longId = '界'.repeat(341) + 'a'; // Exactly 1,024 UTF-8 bytes.
    const account = existingAccount({ id: longId, tokenRef: '😀'.repeat(64) });
    const store = await seededStore(account);
    const lifecycle = { prepare: async () => facts() };
    const reconnect = new AppControllerImpl(store, {}, { oauthInstallLifecycle: lifecycle });
    await reconnect.load();
    const current = reconnect.getSnapshot().accounts[0];
    const expectedLifecycle = {
      accountId: current.id, connectionGeneration: current.connectionGeneration!, tokenRef: current.tokenRef,
      connected: current.connected, authStatus: current.authStatus, identity: current.identity!,
    };
    lifecycle.prepare = async () => facts({ expectedLifecycle });
    const installed = await reconnect.installOAuthStage(stageId);
    expect(installed.id).toBe(longId);
    expect(installed.connectionGeneration).toBe(current.connectionGeneration! + 1);

    const microsoftStore = new InstallStore();
    const microsoft = new AppControllerImpl(microsoftStore, {}, { oauthInstallLifecycle: { prepare: async () => facts({
      provider: 'microsoft', identity: { providerNamespace: 'microsoft', clientId: 'ms-client', subject: 'subject-ms', resourceUserId: 'resource-user' },
      requestedCapabilities: ['mail.read'], capabilities: ['mail.read'], grantedScopes: ['User.Read', 'Mail.Read'],
    }) } });
    expect(await microsoft.installOAuthStage(stageId)).toMatchObject({ provider: 'microsoft', identity: { resourceUserId: 'resource-user' } });
  });

  it('rejects duplicate identities without lifecycle authority and rejects a lifecycle change during prepare', async () => {
    const duplicateStore = await seededStore(existingAccount());
    const duplicateApp = new AppControllerImpl(duplicateStore, {}, { oauthInstallLifecycle: { prepare: async () => facts() } });
    await duplicateApp.load();
    const duplicateSaveCount = duplicateStore.saves.length;
    await expect(duplicateApp.installOAuthStage(stageId)).rejects.toThrow(/lifecycle|identity/i);
    expect(duplicateStore.saves).toHaveLength(duplicateSaveCount);

    let resolvePrepare!: (value: PreparedOAuthInstallFacts) => void;
    const current = existingAccount();
    const changedStore = await seededStore(current);
    const changedApp = new AppControllerImpl(changedStore, {}, { oauthInstallLifecycle: { prepare: () => new Promise((resolve) => { resolvePrepare = resolve; }) } });
    const expectedLifecycle = {
      accountId: current.id, connectionGeneration: current.connectionGeneration, tokenRef: current.tokenRef,
      connected: current.connected, authStatus: current.authStatus, identity: current.identity!,
    };
    const operation = changedApp.installOAuthStage(stageId);
    await Promise.resolve();
    await changedApp.disconnectAccount(current.id);
    resolvePrepare(facts({ expectedLifecycle }));
    await expect(operation).rejects.toThrow(/lifecycle|changed/i);
  });

  it.each([
    ['wrong stage', { stageId: 'c8fb57d3-647d-42a2-89b4-37013ef32dfb' }],
    ['expired result', { expiresAt: 0 }],
    ['unknown capability', { capabilities: ['admin'] as unknown as PreparedOAuthInstallFacts['capabilities'] }],
    ['invalid email', { email: 'not-an-email' }],
    ['oversized token reference', { expectedLifecycle: { accountId: 'account-1', connectionGeneration: 1, tokenRef: 'x'.repeat(129), connected: false, authStatus: 'configured' as const } }],
    ['UTF-16 oversized token reference', { expectedLifecycle: { accountId: 'account-1', connectionGeneration: 1, tokenRef: '😀'.repeat(65), connected: false, authStatus: 'configured' as const } }],
    ['control character account id', { expectedLifecycle: { accountId: 'bad\u0000id', connectionGeneration: 1, connected: false, authStatus: 'configured' as const } }],
    ['unpaired surrogate account id', { expectedLifecycle: { accountId: '\ud800', connectionGeneration: 1, connected: false, authStatus: 'configured' as const } }],
  ])('rejects %s before persistence', async (_label, override) => {
    const store = new InstallStore();
    const app = new AppControllerImpl(store, {}, { oauthInstallLifecycle: { prepare: async () => facts(override) } });
    await expect(app.installOAuthStage(stageId)).rejects.toThrow();
    expect(store.saves.filter((item) => item.options?.consumeOAuthInstall)).toHaveLength(0);
  });

  it('does not publish an account when the terminal consume save loses its acknowledgement', async () => {
    const store = new InstallStore();
    store.failInstallSave = true;
    const app = new AppControllerImpl(store, {}, { oauthInstallLifecycle: { prepare: async () => facts() } });
    await expect(app.installOAuthStage(stageId)).rejects.toThrow(/acknowledgement/i);
    expect(app.getSnapshot().accounts).toEqual([]);
    expect(store.value?.accounts).toEqual([]);
    expect(store.saves.filter((item) => item.options?.consumeOAuthInstall)).toHaveLength(1);
  });

  it('defers alert cancellation follow-up so terminal server installation uses one save', async () => {
    const old = existingAccount({ id: '界'.repeat(341) + 'a' });
    const store = await seededStore(old);
    const alertRule = { id: 'oauth-install-alert', version: 1, revision: 1, name: 'Project updates', enabled: true,
      accountIds: [old.id], trigger: { type: 'keyword' as const, keywords: ['project'] }, createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date().toISOString() };
    const alertIdentityKey = 'google:google-client:subject-1:';
    const consent = createProactiveMailAlertConsent({
      id: 'c396346b-33fd-480a-b74e-f3671eb944ea', rule: alertRule, timeZone: store.value!.settings.timezone,
      activatedAt: new Date(Date.now() - 60_000).toISOString(),
      accounts: [{ accountId: old.id, identityKey: alertIdentityKey, connectionGeneration: old.connectionGeneration,
        providerNamespace: 'google', connected: true, authStatus: 'connected', canReadMail: true }],
    });
    store.value!.proactive.rules = [alertRule];
    store.value!.proactiveMailAlerts.consents = [consent];
    const receiptTime = new Date(Date.now() - 30_000).toISOString();
    store.value!.proactiveMailAlerts.receipts = [{
      id: '5b94d122-7ac0-4bc0-980a-3747543b8674', installationId: store.value!.proactiveMailAlerts.installationId,
      consentId: consent.id, ruleId: alertRule.id, ruleVersion: alertRule.version, ruleRevision: alertRule.revision,
      timeZone: consent.timeZone, consentActivatedAt: consent.activatedAt, accountId: old.id,
      identityKey: alertIdentityKey, connectionGeneration: old.connectionGeneration, providerMessageId: 'provider-message-1',
      sourceVersion: 'a'.repeat(64), receivedAt: receiptTime, desired: 'notify', observed: 'submitted',
      createdAt: receiptTime, updatedAt: receiptTime, attemptedAt: receiptTime,
    }];
    store.value!.proactiveMailAlerts.revision += 1;
    const cancel = vi.fn(async () => 'cancelled' as const);
    const lifecycle = { prepare: async () => facts() as PreparedOAuthInstallFacts };
    const installing = new AppControllerImpl(store, {}, { mailAlertBackend: {
      platform: 'mock', getPermission: async () => 'authorized', requestPermission: async () => 'authorized',
      present: async () => 'not_admitted', cancel,
    }, oauthInstallLifecycle: lifecycle });
    await installing.load();
    const before = installing.getSnapshot().accounts[0];
    const expectedLifecycle = {
      accountId: before.id, connectionGeneration: before.connectionGeneration!, tokenRef: before.tokenRef,
      connected: before.connected, authStatus: before.authStatus, identity: before.identity!,
    };
    lifecycle.prepare = async () => facts({ expectedLifecycle });
    const priorSaveCount = store.saves.length;
    await installing.installOAuthStage(stageId);
    const newSaves = store.saves.slice(priorSaveCount);
    expect(newSaves).toHaveLength(1);
    expect(newSaves[0].options?.consumeOAuthInstall).toBeDefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('explicitly rejects server OAuth consumption in native and browser snapshot stores', async () => {
    const checkpoint: OAuthInstallCheckpoint = { stageId, stagePayloadGeneration: 7, accountId: 'account-1', accountGeneration: 1, tokenRef: 'oauth-token' };
    const state = {} as AppState;
    await expect(new SQLiteStateStore().save(state, { consumeOAuthInstall: checkpoint })).rejects.toThrow(/unavailable in native storage/i);
    await expect(new IndexedDbStateStore().save(state, { consumeOAuthInstall: checkpoint })).rejects.toThrow(/unavailable in browser storage/i);
  });

  it('freezes verified native permissions before the final token-store read can yield', async () => {
    const store = new InstallStore();
    const stored = new Map<string, StoredOAuthToken>();
    let reads = 0;
    let enterFinalRead!: () => void;
    let releaseFinalRead!: () => void;
    const finalReadEntered = new Promise<void>((resolve) => { enterFinalRead = resolve; });
    const finalReadGate = new Promise<void>((resolve) => { releaseFinalRead = resolve; });
    const tokenStore = {
      async get(ref: string) {
        reads += 1;
        if (reads === 2) { enterFinalRead(); await finalReadGate; }
        const value = stored.get(ref);
        return value ? structuredClone(value) : null;
      },
      async set(ref: string, token: StoredOAuthToken) { stored.set(ref, structuredClone(token)); },
    };
    const result: OAuthBridgeResult = {
      provider: 'google', accessToken: 'access-token', expiresAt: Date.now() + 60_000,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      requestedCapabilities: ['mail.read'], capabilities: ['mail.read'],
      identity, displayName: 'Verified account', email: 'person@example.test',
    };
    const app = new AppControllerImpl(store, {}, {
      tokenStore, clientIds: { google: 'google-client' }, verifyOAuthResult: async () => true,
      connectorFactory: () => ({ async verifyOAuthIdentity() { return true; } }) as never,
    });
    const pending = app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, result);
    await finalReadEntered;
    result.requestedCapabilities.push('calendar.read', 'calendar.write');
    result.capabilities.push('calendar.read', 'calendar.write');
    result.grantedScopes.push('https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events');
    releaseFinalRead();
    const account = await pending;
    expect(account.capabilityLimits).toEqual(['mail.read']);
    expect(account.capabilities).toEqual(['mail.read']);
    expect(account.grantedScopes).toEqual(['openid', 'https://www.googleapis.com/auth/gmail.readonly']);
  });
});
