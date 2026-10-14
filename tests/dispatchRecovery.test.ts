import { describe, expect, it, vi } from 'vitest';
import type { Account, AppState, Proposal } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import type { PrivacyPublicStatus } from '../src/privacy/types';
import { createDispatchRecord, recordDispatchOutcome } from '../src/dispatch';
import * as Crypto from 'expo-crypto';
import { AzureOpenAIClient } from '../src/services/azure';
import type { OAuthBridgeResult, StoredOAuthToken } from '../src/connectors';

type RawState = AppState & { dispatchRecoveryArchives?: unknown; dispatchRecoveryRawEvidence?: unknown; dispatchRecordQuarantine?: unknown };

class RecoveryStore implements StateStore {
  value?: RawState;
  saves = 0;
  failSave = false;
  failAfterCommit = false;
  async load() { return this.value ? JSON.parse(JSON.stringify(this.value)) as RawState : undefined; }
  async save(state: AppState) {
    this.saves += 1;
    if (this.failSave) throw new Error('simulated save failure before commit');
    this.value = JSON.parse(JSON.stringify(state)) as RawState;
    if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('simulated lost save acknowledgement after commit'); }
  }
  async clear() { this.value = undefined; }
  async readCurrentSnapshot() { return this.value ? { raw: JSON.stringify(this.value), schemaVersion: 1 } : undefined; }
  async assertCurrent() {}
}

const privacySession = {
  epoch: 'recovery-test-epoch',
  async assertCurrent() {},
  async getStatus() {
    return { phase: 'ready', epoch: 'recovery-test-epoch', activeWriterCount: 0, pendingCleanupCount: 0, failedCleanupCount: 0,
      limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096, writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 },
      coverage: 'tracked_with_legacy_limits' } satisfies PrivacyPublicStatus;
  },
};

function remoteDraft(): Proposal {
  return { id: 'old-mail-proposal', kind: 'email', title: 'Old draft', body: 'Old body', status: 'draft', revision: 1,
    recipients: ['person@example.invalid'], evidence: [], sourceActionKey: 'stable-mail-source-action', remoteOperation: 'draft' };
}

function terminalMailReceipt(sourceActionKey: string, outcome: 'accepted' | 'unknown') {
  const account: Account = { id: 'provider-account', provider: 'google', displayName: 'Work', email: 'me@example.test', connected: true,
    authStatus: 'connected', identity: { providerNamespace: 'google', clientId: 'client', subject: 'subject' }, connectionGeneration: 2 };
  const proposal: Proposal = { id: `proposal-${outcome}`, kind: 'email', title: 'Reply', body: 'Body', status: 'approved', revision: 1,
    approvedRevision: 1, approvedPayloadDigest: 'a'.repeat(64), sourceActionKey, accountId: account.id, sourceRevision: 1, noteId: 'note-1',
    provenance: { version: 1, assistContractVersion: 'v1', analysisFingerprint: 'fingerprint', noteId: 'note-1', noteRevision: 1,
      capturedAt: '2026-10-14T00:00:00.000Z', captureTimeZone: 'UTC', intent: 'assist',
      sources: [{ sourceId: 'transcript', revision: 1, sourceVersion: `1:${'b'.repeat(64)}` }], policySources: [], settingsFingerprint: 'settings' },
    recipients: ['sam@example.test'], evidence: [], email: { operation: 'draft', to: ['sam@example.test'], cc: [], bcc: [], subject: 'Reply', text: 'Body', attachments: [] } };
  const pending = createDispatchRecord({ id: `receipt-${outcome}`, dispatchStartedAt: '2026-10-14T00:00:00.000Z', proposal, account });
  return recordDispatchOutcome(pending, { outcome, at: '2026-10-14T00:00:01.000Z' });
}

describe('selective dispatch recovery', () => {
  it('archives malformed receipt evidence, preserves valid workspace state, and permanently retires its remote proposal', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [{ id: 'bad-row', privateEvidence: 'opaque-receipt-sentinel' }] as never;
    corrupt.proposals = [remoteDraft()];
    store.value = corrupt;

    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    expect(app.getSnapshot().dispatchRecoveryStatus?.quarantinedCount).toBe(1);
    expect(JSON.stringify(app.getSnapshot())).not.toContain('opaque-receipt-sentinel');
    const plan = await app.prepareDispatchRecovery();
    expect(plan.effects).toMatchObject({ quarantinedReceiptCount: 1, preservedValidReceiptCount: 0, remoteProposalsRetired: 1, sourceActionFencesAdded: 1 });
    const result = await app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' });
    expect(result.status).toBe('applied');
    expect(store.value?.dispatchRecords).toEqual([]);
    expect(store.value?.dispatchRecordQuarantine).toBeUndefined();
    expect(JSON.stringify(store.value?.dispatchRecoveryArchives)).toContain('opaque-receipt-sentinel');
    expect(app.getSnapshot().proposals[0]?.dispatchRecoveryRetired).toBe(true);
    expect(app.getSnapshot().dispatchRecoveryStatus).toBeUndefined();
    expect(JSON.stringify(app.getSnapshot())).not.toContain('opaque-receipt-sentinel');

    await expect(app.editProposal('old-mail-proposal', { body: 'Changed' })).rejects.toThrow(/permanently read-only/);
    await expect(app.approveProposal('old-mail-proposal')).rejects.toThrow(/permanently read-only/);
    await expect(app.executeProposal('old-mail-proposal')).rejects.toThrow(/permanently read-only/);
    await expect(app.dismissProposal('old-mail-proposal')).rejects.toThrow(/permanently read-only/);

    const reloaded = new AppControllerImpl(store, {}, { privacySession });
    await reloaded.load();
    expect(reloaded.getSnapshot().proposals[0]?.dispatchRecoveryRetired).toBe(true);
    expect(reloaded.getDispatchRecoveryStatus().lastOperationId).toBe(plan.operationId);
    expect(store.value?.dispatchRecordQuarantine).toBeUndefined();
    expect(store.value?.proposals[0]?.dispatchRecoveryRetired).toBe(true);
    expect(store.value?.dispatchRecoveryRawEvidence).toBeUndefined();
    const inspection = await reloaded.inspectDispatchRecoveryReceipt(plan.operationId);
    expect(inspection).toMatchObject({ status: 'applied' });
    const independent = new AppControllerImpl(store, {}, { privacySession });
    // Simulate source cleanup after the archival transaction. The permanent
    // source-action tombstone must stand even if its proposal row is gone.
    store.value!.proposals = [{ ...remoteDraft(), id: 'new-copy-of-old-action' }];
    await independent.load();
    await expect(independent.approveProposal('new-copy-of-old-action')).rejects.toThrow(/retired in dispatch recovery history/);
    const note = await independent.saveNote({ transcript: 'Content erasure remains paused while the receipt evidence is unresolved.' });
    await expect(independent.deleteNote(note.id)).rejects.toThrow(/unresolved receipt evidence/);

    const revoked = await independent.saveAccount({ provider: 'google', displayName: 'Revoked work account', email: 'revoked@example.test' });
    await expect(independent.disconnectAccount(revoked.id)).resolves.toMatchObject({ connected: false, authStatus: 'configured' });
    expect(independent.getDispatchRecoveryStatus().unresolvedReceiptCount).toBe(1);
    expect((store.value?.dispatchRecoveryArchives as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('keeps the exact opaque quarantine raw value across ordinary saves until explicit recovery', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [{ id: 'bad-row', secret: 'raw-bad-record' }] as never;
    corrupt.dispatchRecordQuarantine = { originalEnvelope: ['sentinel', { opaque: true }] };
    store.value = corrupt;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    await app.saveNote({ transcript: 'Ordinary unrelated save.' });
    expect(JSON.stringify(store.value?.dispatchRecoveryRawEvidence)).toContain('raw-bad-record');
    expect(JSON.stringify(store.value?.dispatchRecoveryRawEvidence)).toContain('originalEnvelope');
    const persistedEvidence = JSON.stringify(store.value?.dispatchRecoveryRawEvidence);
    const reloaded = new AppControllerImpl(store, {}, { privacySession });
    await reloaded.load();
    await reloaded.saveNote({ transcript: 'Another ordinary save after restart.' });
    expect(JSON.stringify(store.value?.dispatchRecoveryRawEvidence)).toBe(persistedEvidence);
    const checkedAgain = new AppControllerImpl(store, {}, { privacySession });
    await checkedAgain.load();
    await checkedAgain.saveNote({ transcript: 'Repeated saves must not grow the private evidence wrapper.' });
    expect(JSON.stringify(store.value?.dispatchRecoveryRawEvidence)).toBe(persistedEvidence);

    (store.value as RawState).dispatchRecords = [{ id: 'new-bad-row', newOpaqueEvidence: 'later-corruption' }] as never;
    const withNewEvidence = new AppControllerImpl(store, {}, { privacySession });
    await withNewEvidence.load();
    await withNewEvidence.saveNote({ transcript: 'A newly observed corrupt row is appended once.' });
    const updatedEvidence = JSON.stringify(store.value?.dispatchRecoveryRawEvidence);
    expect(updatedEvidence).not.toBe(persistedEvidence);
    expect(updatedEvidence).toContain('raw-bad-record');
    expect(updatedEvidence).toContain('later-corruption');
    const finalReload = new AppControllerImpl(store, {}, { privacySession });
    await finalReload.load();
    await finalReload.saveNote({ transcript: 'Restart does not append the same corrupt row again.' });
    expect(JSON.stringify(store.value?.dispatchRecoveryRawEvidence)).toBe(updatedEvidence);
  });

  it('preserves accepted and unknown provider receipts byte-for-byte while retiring only corrupt receipt content', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const accepted = terminalMailReceipt('accepted-source-key', 'accepted');
    const unknown = terminalMailReceipt('unknown-source-key', 'unknown');
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [accepted, unknown, { id: 'bad-row', raw: 'corrupt' }] as never;
    corrupt.dispatchRecordQuarantine = { originalEnvelope: 'private-corrupt-envelope' };
    store.value = corrupt;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    const plan = await app.prepareDispatchRecovery();
    expect(plan.effects.preservedValidReceiptCount).toBe(2);
    expect((await app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' })).status).toBe('applied');
    expect(store.value?.dispatchRecords).toEqual([accepted, unknown]);
    expect(store.value?.dispatchRecords.map((record) => record.outcome)).toEqual(['accepted', 'unknown']);
  });

  it('leaves EventKit proposals outside provider recovery and allows an independent mail source afterward', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const state = structuredClone(seed.getSnapshot());
    const identity = { providerNamespace: 'google' as const, clientId: 'fresh-client', subject: 'fresh-subject' };
    const account: Account = { id: 'fresh-account', provider: 'google', displayName: 'Work', email: 'me@example.test', verifiedEmail: 'me@example.test',
      connected: true, authStatus: 'connected', identity, tokenRef: 'fresh-token', connectionGeneration: 4,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'], capabilities: ['mail.read', 'mail.draft'] };
    const observedAt = new Date().toISOString();
    state.accounts.push(account);
    state.mailbox.push({ id: 'fresh-message', accountId: account.id, providerMessageId: 'provider-fresh-message', identityKey: 'google:fresh-client:fresh-subject:',
      verifiedIdentityKey: 'google:fresh-client:fresh-subject:', connectionGeneration: 4, idFormat: 'gmail', threadId: 'fresh-thread',
      subject: 'Independent source', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test', receivedAt: observedAt,
      replyTo: ['sam@example.test'], to: ['me@example.test'], cc: [], internetMessageId: '<fresh@example.test>',
      replyMetadataComplete: true, observedAt });
    const deviceEvent: Proposal = { id: 'device-event', kind: 'event', title: 'On device', body: 'Local event', status: 'draft', revision: 1,
      eventDestination: { kind: 'device_calendar', calendarId: 'device-calendar' }, sourceActionKey: 'local-event-source',
      recipients: [],
      event: { title: 'On device', description: 'Local event', start: '2026-10-15T10:00:00.000Z', end: '2026-10-15T11:00:00.000Z',
        timeZone: 'UTC', attendees: [], invitePolicy: 'none' }, evidence: [] };
    const raw = state as RawState;
    raw.dispatchRecords = [{ id: 'bad-row', opaque: 'receipt' }] as never;
    raw.dispatchRecordQuarantine = { opaqueReceipt: 'quarantined' };
    raw.proposals = [deviceEvent];
    store.value = raw;

    const app = new AppControllerImpl(store, {}, { privacySession, tokenStore: { async get() {
      return { accessToken: 'test-token', expiresAt: Date.now() + 600_000, identity };
    }, async set() {} } });
    await app.load();
    const plan = await app.prepareDispatchRecovery();
    expect(plan.effects.remoteProposalsRetired).toBe(0);
    await app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' });
    expect(app.getSnapshot().proposals.find((item) => item.id === deviceEvent.id)?.dispatchRecoveryRetired).toBeUndefined();
    const archive = store.value!.dispatchRecoveryArchives as { entries: { sourceJson: string }[] };
    expect(JSON.parse(archive.entries[0].sourceJson).sourceActionFences).toEqual([]);

    const source = await app.getMailReplySource('fresh-message');
    expect(source.status).toBe('current');
    const proposal = await app.createMailReplyProposal({ messageId: 'fresh-message', mode: 'reply', sourceDigest: source.source!.sourceDigest,
      text: 'A genuinely new message receives a fresh draft.' });
    expect((await app.approveProposal(proposal.id)).status).toBe('approved');
  });

  it('consumes a recovery plan after an unknown save acknowledgement and never replays it', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [{ id: 'bad-row', opaque: 'unknown-save-receipt' }] as never;
    store.value = corrupt;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    const plan = await app.prepareDispatchRecovery();

    store.failSave = true;
    const result = await app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' });
    expect(result).toEqual({ status: 'unknown', operationId: plan.operationId });
    const writesAfterUnknown = store.saves;
    await expect(app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' })).rejects.toThrow(/no longer current/);
    expect(store.saves).toBe(writesAfterUnknown);
    expect(app.getDispatchRecoveryStatus()).toMatchObject({ status: 'refresh_required', lastOperationId: plan.operationId });
  });

  it('resolves a commit-then-throw acknowledgement only after refresh and inspection, without replay', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const accepted = terminalMailReceipt('accepted-before-unknown-save', 'accepted');
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [accepted, { id: 'bad-row-after-accepted', opaque: 'commit-then-throw' }] as never;
    corrupt.proposals = [remoteDraft()];
    store.value = corrupt;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    const plan = await app.prepareDispatchRecovery();
    store.failAfterCommit = true;
    const writesBeforeConfirm = store.saves;
    const result = await app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' });
    expect(result).toEqual({ status: 'unknown', operationId: plan.operationId });
    expect(store.saves).toBe(writesBeforeConfirm + 1);
    expect(store.value?.dispatchRecords).toEqual([accepted]);
    expect((store.value?.dispatchRecoveryArchives as { entries: unknown[] }).entries).toHaveLength(1);
    const writesAfterUnknown = store.saves;
    await expect(app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' })).rejects.toThrow(/no longer current/);
    expect(store.saves).toBe(writesAfterUnknown);

    await app.refreshPersistedWorkspace();
    expect(app.getSnapshot().proposals.find((item) => item.id === 'old-mail-proposal')?.dispatchRecoveryRetired).toBe(true);
    await expect(app.inspectDispatchRecoveryReceipt(plan.operationId)).resolves.toMatchObject({ status: 'applied', operationId: plan.operationId });
    expect(store.value?.dispatchRecords).toEqual([accepted]);
  });

  it('consumes a confirmation plan before its first storage await, even when that read fails', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [{ id: 'bad-row', opaque: 'one-use-plan' }] as never;
    store.value = corrupt;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    const plan = await app.prepareDispatchRecovery();
    let reads = 0;
    const savesBeforeConfirm = store.saves;
    store.readCurrentSnapshot = async () => { reads += 1; throw new Error('read unavailable'); };
    await expect(app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' })).rejects.toThrow(/read unavailable/);
    await expect(app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' })).rejects.toThrow(/no longer current/);
    expect(reads).toBe(1);
    expect(store.saves).toBe(savesBeforeConfirm);
  });

  it('rechecks plan expiry against a controlled clock at confirmation', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [{ id: 'bad-row', opaque: 'expired-plan' }] as never;
    store.value = corrupt;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    const plan = await app.prepareDispatchRecovery();
    const originalTime = Date.now();
    vi.setSystemTime(originalTime + 6 * 60 * 1000);
    try {
      const savesBefore = store.saves;
      await expect(app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' })).rejects.toThrow(/expired/i);
      expect(store.saves).toBe(savesBefore);
    } finally { vi.setSystemTime(originalTime); }
  });

  it('rejects confirmation after the persisted workspace changes and after the privacy epoch changes', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [{ id: 'bad-row', privateEvidence: 'stale-plan-sentinel' }] as never;
    store.value = corrupt;

    const changed = new AppControllerImpl(store, {}, { privacySession });
    await changed.load();
    const staleSnapshotPlan = await changed.prepareDispatchRecovery();
    await changed.saveNote({ transcript: 'An unrelated save invalidates the recovery snapshot.' });
    const savesAfterIndependentMutation = store.saves;
    await expect(changed.confirmDispatchRecovery({ operationId: staleSnapshotPlan.operationId, confirmation: 'RETIRE ACTIONS' })).rejects.toThrow(/refresh|workspace changed/i);
    expect(store.saves).toBe(savesAfterIndependentMutation);

    const epochState = { value: 'recovery-test-epoch' };
    const epochSession = { ...privacySession, get epoch() { return epochState.value; }, async getStatus() {
      return { ...(await privacySession.getStatus()), epoch: epochState.value };
    } };
    const epochStore = new RecoveryStore();
    const epochSeed = new AppControllerImpl(epochStore);
    await epochSeed.load();
    const epochCorrupt = structuredClone(epochSeed.getSnapshot()) as RawState;
    epochCorrupt.dispatchRecords = [{ id: 'bad-row', privateEvidence: 'privacy-plan-sentinel' }] as never;
    epochStore.value = epochCorrupt;
    const epochApp = new AppControllerImpl(epochStore, {}, { privacySession: epochSession });
    await epochApp.load();
    const epochPlan = await epochApp.prepareDispatchRecovery();
    const writesBeforeEpochChange = epochStore.saves;
    epochState.value = 'new-privacy-epoch';
    await expect(epochApp.confirmDispatchRecovery({ operationId: epochPlan.operationId, confirmation: 'RETIRE ACTIONS' })).rejects.toThrow(/workspace changed|refresh|privacy/i);
    expect(epochStore.saves).toBe(writesBeforeEpochChange);
  });

  it('fails closed for malformed recovery archives before an external proposal can be approved', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecoveryArchives = { version: 1, entries: [{ operationId: 'not-a-valid-entry' }] };
    corrupt.proposals = [remoteDraft()];
    store.value = corrupt;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    expect(app.getDispatchRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'archive_invalid' });
    const savesBefore = store.saves;
    await expect(app.approveProposal('old-mail-proposal')).rejects.toThrow(/integrity validation|archive_invalid/i);
    expect(store.saves).toBe(savesBefore);
  });

  it('fails closed after archived evidence is tampered and when the archive reaches its entry limit', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    store.value = structuredClone(seed.getSnapshot()) as RawState;
    for (let index = 0; index < 4; index += 1) {
      store.value!.dispatchRecords = [{ id: `bad-${index}`, raw: 'corrupt' }] as never;
      store.value!.dispatchRecordQuarantine = { sentinel: `receipt-${index}` };
      const app = new AppControllerImpl(store, {}, { privacySession });
      await app.load();
      const plan = await app.prepareDispatchRecovery();
      expect((await app.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' })).status).toBe('applied');
    }
    store.value!.dispatchRecords = [{ id: 'bad-fifth', raw: 'corrupt' }] as never;
    store.value!.dispatchRecordQuarantine = { sentinel: 'fifth-receipt' };
    const full = new AppControllerImpl(store, {}, { privacySession });
    await full.load();
    expect(full.getDispatchRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'archive_full', archiveCount: 4 });
    const savesBefore = store.saves;
    await expect(full.prepareDispatchRecovery()).rejects.toThrow(/archive_full|full/i);
    expect(store.saves).toBe(savesBefore);

    const tampered = structuredClone(store.value!) as RawState;
    const archives = tampered.dispatchRecoveryArchives as { entries: { sourceJson: string }[] };
    archives.entries[0].sourceJson = archives.entries[0].sourceJson.replace('receipt-0', 'receipt-X');
    tampered.proposals = [remoteDraft()];
    store.value = tampered;
    const invalid = new AppControllerImpl(store, {}, { privacySession });
    await invalid.load();
    expect(invalid.getDispatchRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'archive_invalid' });
    await expect(invalid.approveProposal('old-mail-proposal')).rejects.toThrow(/integrity validation/i);
  });

  it('does not mark a newer privacy workspace malformed when an old archive digest finishes late', async () => {
    const store = new RecoveryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const corrupt = structuredClone(seed.getSnapshot()) as RawState;
    corrupt.dispatchRecords = [{ id: 'bad-row', privateEvidence: 'late-digest-sentinel' }] as never;
    store.value = corrupt;
    const first = new AppControllerImpl(store, {}, { privacySession });
    await first.load();
    const plan = await first.prepareDispatchRecovery();
    expect((await first.confirmDispatchRecovery({ operationId: plan.operationId, confirmation: 'RETIRE ACTIONS' })).status).toBe('applied');

    const reloading = new AppControllerImpl(store, {}, { privacySession });
    let digestStarted!: () => void;
    let releaseDigest!: () => void;
    const started = new Promise<void>((resolve) => { digestStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    const digestSpy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (...args) => {
      digestStarted();
      await gate;
      return originalDigest(...args);
    });
    try {
      const loading = reloading.load();
      await started;
      const reset = reloading.disposeForPrivacy();
      releaseDigest();
      await reset;
      await expect(loading).rejects.toThrow(/workspace changed|refresh|privacy/i);
      expect(reloading.getDispatchRecoveryStatus()).not.toMatchObject({ status: 'unavailable', reason: 'archive_invalid' });
    } finally {
      releaseDigest();
      digestSpy.mockRestore();
    }
  });

  it('keeps recovery busy across refresh while an admitted fake provider request is still pending', async () => {
    const store = new RecoveryStore();
    const identity = { providerNamespace: 'google' as const, clientId: 'dispatch-client', subject: 'dispatch-subject' };
    const token: StoredOAuthToken = { accessToken: 'test-access', expiresAt: Date.now() + 600_000, identity };
    const tokenStore = { async get() { return structuredClone(token); }, async set() {} };
    const oauth: OAuthBridgeResult = { provider: 'google', accessToken: token.accessToken, expiresAt: token.expiresAt,
      grantedScopes: ['openid', 'https://www.googleapis.com/auth/gmail.compose'], requestedCapabilities: ['mail.draft'],
      capabilities: ['mail.draft'], identity, displayName: 'Verified', email: 'me@example.test' };
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const connector = { async verifyOAuthIdentity() { return true; }, async createDraft(_account: unknown, envelope: unknown,
      verifier: { verify(value: never): Promise<boolean>; verifyBeforeDispatch(value: never): boolean }) {
      providerStarted();
      await held;
      return verifier.verifyBeforeDispatch(envelope as never) ? { status: 'accepted' as const, id: 'draft-reference' } : { status: 'unknown' as const };
    } };
    const integration = { tokenStore, deleteToken: async () => undefined, clientIds: { google: identity.clientId },
      verifyOAuthResult: async () => true, connectorFactory: () => connector as never, privacySession };
    const transcript = 'Email Sam the reviewed update.';
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, transcript.normalize('NFC'))}`;
    const fetcher = async () => new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      summary: transcript, answer: '', decisions: [], citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: transcript }],
      clarifications: [], proposals: [{ kind: 'email', title: 'Reviewed update', body: 'Here is the update.', recipients: ['sam@example.test'], dueAt: null, evidence: [transcript] }], memorySuggestions: [],
    }) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const client = { openAi: new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key') };
    const app = new AppControllerImpl(store, client, integration);
    await app.load();
    const account = await app.installVerifiedAccount({ provider: 'google', displayName: '', email: '' }, oauth);
    await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const note = await app.saveNote({ transcript });
    const result = await app.assistNote(note.id, { intent: 'assist' });
    const draft = app.getSnapshot().proposals.find((proposal) => proposal.id === result.proposalIds[0])!;
    await app.editProposal(draft.id, { accountId: account.id, email: { operation: 'draft', to: ['sam@example.test'], cc: [], bcc: [],
      subject: 'Reviewed update', text: 'Here is the update.', attachments: [] } });
    await app.approveProposal(draft.id);

    const execution = app.executeProposal(draft.id);
    try {
      await started;
      store.value!.dispatchRecords.push({ id: 'corrupt-dispatch-record', raw: 'opaque' } as never);
      store.value!.dispatchRecordQuarantine = { opaqueReceipt: 'private-dispatch-evidence' };
      await app.refreshPersistedWorkspace();
      expect(app.getSnapshot().proposals.find((proposal) => proposal.id === draft.id)?.status).toBe('unknown');
      const savesAtRefresh = store.saves;
      await expect(app.prepareDispatchRecovery()).rejects.toThrow(/busy|in progress/i);
      expect(store.saves).toBe(savesAtRefresh);
    } finally {
      releaseProvider();
    }
    await expect(execution).resolves.toMatchObject({ status: 'unknown' });
    expect(app.getSnapshot().dispatchRecoveryStatus?.quarantinedCount).toBeGreaterThan(0);
    await expect(app.prepareDispatchRecovery()).resolves.toMatchObject({ evidenceBytes: expect.any(Number) });
  });

});
