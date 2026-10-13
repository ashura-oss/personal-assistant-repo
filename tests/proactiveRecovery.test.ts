import { describe, expect, it, vi } from 'vitest';
import type { AppState, Note } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { PROACTIVE_RECOVERY_MAX_ARCHIVES, validateProactiveRecoveryArchiveState } from '../src/proactive/recovery';
import type { PrivacyPublicStatus } from '../src/privacy/types';
import * as Crypto from 'expo-crypto';
import { createPortableBackup } from '../src/backup';
import { recoveryUtf8Bytes } from '../src/storage/startupRecovery';
import { STATE_SNAPSHOT_READ_MAX_BYTES } from '../src/storage/contracts';

type PrivateState = AppState & { proactiveQuarantine?: unknown; proactiveRecoveryArchives?: unknown; proactiveMailAlertQuarantine?: unknown; opaqueRecoverySibling?: unknown };

class SnapshotStore implements StateStore {
  value?: PrivateState;
  saves = 0;
  readCurrentSnapshotCalls = 0;
  afterSave?: () => void;
  failAfterSave = false;
  staleGeneration = false;
  failSnapshotRead = false;
  beforeReadSnapshot?: () => Promise<void>;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.saves += 1;
    this.value = structuredClone(state) as PrivateState;
    this.afterSave?.();
    if (this.failAfterSave) { this.failAfterSave = false; throw new Error('lost save acknowledgement'); }
  }
  async clear() { this.value = undefined; }
  async readCurrentSnapshot() {
    this.readCurrentSnapshotCalls += 1;
    await this.beforeReadSnapshot?.();
    if (this.failSnapshotRead) { this.failSnapshotRead = false; throw new Error('snapshot read failed'); }
    return this.value ? { raw: JSON.stringify(this.value), schemaVersion: 1 } : undefined;
  }
  async assertCurrent() { if (this.staleGeneration) throw new Error('storage generation changed'); }
}

const privacySession = {
  epoch: 'workspace-test-epoch',
  async assertCurrent() {},
  async getStatus() {
    return { phase: 'ready', epoch: 'workspace-test-epoch', activeWriterCount: 0, pendingCleanupCount: 0, failedCleanupCount: 0,
      limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096, writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 },
      coverage: 'tracked_with_legacy_limits' } satisfies PrivacyPublicStatus;
  },
};

async function quarantinedController() {
  const store = new SnapshotStore();
  const seed = new AppControllerImpl(store);
  await seed.load();
  const malformed = structuredClone(store.value!) as PrivateState;
  malformed.proactive = { distinctiveRawRule: 'keep this evidence', candidates: 'malformed' } as never;
  malformed.opaqueRecoverySibling = { mustRemain: ['unchanged'] };
  store.value = malformed;
  const app = new AppControllerImpl(store, {}, { privacySession });
  await app.load();
  return { app, store };
}

describe('selective proactive quarantine recovery', () => {
  it('archives exact quarantined evidence in one CAS save and preserves unrelated persisted data', async () => {
    const { app, store } = await quarantinedController();
    expect(app.getProactiveRecoveryStatus().status).toBe('available');
    const plan = await app.prepareProactiveRecovery();
    expect(plan.effects).toMatchObject({ resetsRules: true, resetsAttention: true, resetsDismissalsAndSnoozes: true });
    const before = store.saves;
    const result = await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' });
    expect(result).toMatchObject({ status: 'applied', operationId: plan.operationId, archiveCount: 1 });
    expect(store.saves).toBe(before + 1);
    expect(store.value?.proactive).toMatchObject({ rules: [], candidates: [] });
    expect(store.value?.opaqueRecoverySibling).toEqual({ mustRemain: ['unchanged'] });
    const archive = validateProactiveRecoveryArchiveState(store.value?.proactiveRecoveryArchives);
    expect(archive.entries).toHaveLength(1);
    const evidence = JSON.parse(archive.entries[0].sourceJson) as { proactive: { integrityError?: string }; proactiveQuarantine: { raw: unknown } };
    expect(evidence.proactive.integrityError).toBeTruthy();
    expect(evidence.proactiveQuarantine.raw).toEqual({ distinctiveRawRule: 'keep this evidence', candidates: 'malformed' });
    expect(app.getSnapshot()).not.toHaveProperty('proactiveRecoveryArchives');
    const backup = createPortableBackup(app.getSnapshot(), { exportId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', exportedAt: new Date().toISOString() });
    expect(JSON.stringify(backup)).not.toContain('keep this evidence');
    expect(await app.inspectProactiveRecoveryReceipt(plan.operationId)).toMatchObject({ status: 'not_verified' });
    await app.refreshPersistedWorkspace();
    expect(await app.inspectProactiveRecoveryReceipt(plan.operationId)).toMatchObject({ status: 'applied', operationId: plan.operationId, archiveCount: 1 });
  });

  it('does not save when durable unrelated state changed behind the cached workspace', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    const note: Note = { id: 'late-note', title: 'Concurrent edit', transcript: 'keep', durationSeconds: 0, createdAt: new Date().toISOString(), status: 'recorded', revision: 1 };
    store.value!.notes.push(note);
    const before = store.saves;
    await expect(app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).rejects.toThrow();
    expect(store.saves).toBe(before);
    expect(store.value!.notes.some((note) => note.id === 'late-note')).toBe(true);
  });

  it('keeps malformed archive data private and refuses to replace or count it', async () => {
    const store = (await quarantinedController()).store;
    const preserved = { version: 1, entries: [{ operationId: 'private-marker' }] };
    store.value!.proactiveRecoveryArchives = preserved;
    const reloaded = new AppControllerImpl(store, {}, { privacySession });
    await reloaded.load();
    expect(reloaded.getProactiveRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'archive_invalid', archiveCount: null, archiveBytes: null });
    expect(reloaded.getSnapshot()).not.toHaveProperty('proactiveRecoveryArchives');
    expect(store.value!.proactiveRecoveryArchives).toEqual(preserved);
    await expect(reloaded.prepareProactiveRecovery()).rejects.toThrow();
    expect(store.value!.proactiveRecoveryArchives).toEqual(preserved);
  });

  it('does not reset a healthy raw proactive value merely because the loaded quarantine is stale', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    await app.cancelProactiveRecovery(plan.operationId);
    const fresh = structuredClone(store.value!) as PrivateState;
    fresh.proactive = { schemaVersion: 1, rules: [], candidates: [], dismissals: [], snoozes: [] } as never;
    delete fresh.proactiveQuarantine;
    store.value = fresh;
    const before = store.saves;
    await expect(app.prepareProactiveRecovery()).rejects.toThrow(/not_needed/i);
    expect(store.saves).toBe(before);
    expect(store.value!.proactive).toMatchObject({ rules: [], candidates: [] });
  });

  it('preserves a malformed alert ledger exactly and does not derive cancellation authority from it', async () => {
    const fixture = await quarantinedController();
    const store = fixture.store;
    const rawAlerts = { version: 1, installationId: 'sentinel', consents: [], receipts: [], unknownNested: { keep: true } };
    store.value!.proactiveMailAlerts = rawAlerts as never;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    const plan = await app.prepareProactiveRecovery();
    expect(plan.effects).toMatchObject({ mailConsentsToRevoke: null, mailReceiptsPreserved: null, mailCleanup: 'unavailable' });
    await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' });
    expect(store.value!.proactiveMailAlertQuarantine).toEqual([rawAlerts]);
  });

  it('rejects oversized evidence before saving or truncating it', async () => {
    const store = new SnapshotStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const malformed = structuredClone(store.value!) as PrivateState;
    malformed.proactive = { privateOversized: 'x'.repeat(270 * 1024) } as never;
    store.value = malformed;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    const before = store.saves;
    await expect(app.prepareProactiveRecovery()).rejects.toThrow(/evidence_too_large/i);
    expect(store.saves).toBe(before);
    expect((store.value!.proactiveQuarantine as { raw?: Record<string, unknown> }).raw?.privateOversized).toHaveLength(270 * 1024);
    expect(app.getProactiveRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'evidence_too_large' });
  });

  it('rejects an archive replacement that would exceed the persisted snapshot byte limit', async () => {
    const { app, store } = await quarantinedController();
    const internals = app as unknown as { state: AppState; persistedState(state: AppState): AppState };
    const note: Note = { id: 'capacity-note', title: 'Capacity', transcript: '', durationSeconds: 0, createdAt: new Date().toISOString(), status: 'recorded', revision: 1 };
    internals.state.notes.push(note);
    const base = JSON.stringify(internals.persistedState(internals.state));
    note.transcript = 'x'.repeat(STATE_SNAPSHOT_READ_MAX_BYTES - 8 - recoveryUtf8Bytes(base));
    const stateWithLargeNote = internals.persistedState(internals.state) as PrivateState;
    const rawBefore = JSON.stringify(stateWithLargeNote);
    expect(recoveryUtf8Bytes(rawBefore)).toBeLessThanOrEqual(STATE_SNAPSHOT_READ_MAX_BYTES);
    store.value = structuredClone(stateWithLargeNote);
    const plan = await app.prepareProactiveRecovery();
    const before = store.saves;
    await expect(app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).rejects.toThrow(/too large for selective recovery/i);
    expect(store.saves).toBe(before);
    expect(JSON.stringify(store.value)).toBe(rawBefore);
    expect(app.getProactiveRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'evidence_too_large' });
  });

  it('keeps a post-save acknowledgement uncertain if the captured privacy epoch changes before publication', async () => {
    const store = new SnapshotStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const malformed = structuredClone(store.value!) as PrivateState;
    malformed.proactive = { candidates: 'bad' } as never;
    store.value = malformed;
    let epoch = 'workspace-test-epoch';
    const changingSession = {
      epoch: 'workspace-test-epoch',
      async assertCurrent() { if (epoch !== 'workspace-test-epoch') throw new Error('stale epoch'); },
      async getStatus() {
        return { phase: 'ready', epoch, activeWriterCount: 0,
          pendingCleanupCount: 0, failedCleanupCount: 0, limits: { namespaces: 10, oauthTokenRefs: 1024, legacyMarkdownPaths: 4096, writerLeases: 512, cleanupTargets: 5130, cleanupBatch: 16 },
          coverage: 'tracked_with_legacy_limits' } as const;
      },
    };
    const app = new AppControllerImpl(store, {}, { privacySession: changingSession });
    await app.load();
    const plan = await app.prepareProactiveRecovery();
    store.afterSave = () => { epoch = 'replacement-epoch'; };
    const result = await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' });
    expect(result).toEqual({ status: 'unknown', operationId: plan.operationId });
    expect(app.getSnapshot().proactive.integrityError).toBeTruthy();
  });

  it('requires explicit refresh before receipt verification and reads the current archive without writing', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' });
    await app.refreshPersistedWorkspace();
    const beforeSaves = store.saves;
    const beforeReads = store.readCurrentSnapshotCalls;
    const inspection = await app.inspectProactiveRecoveryReceipt(plan.operationId);
    expect(inspection).toMatchObject({ status: 'applied', operationId: plan.operationId });
    expect(store.saves).toBe(beforeSaves);
    expect(store.readCurrentSnapshotCalls).toBeGreaterThan(beforeReads);
  });

  it('does not publish an applied receipt if a stored archive digest is corrupted', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' });
    const archive = store.value!.proactiveRecoveryArchives as { entries: { sourceSha256: string }[] };
    archive.entries[0].sourceSha256 = 'f'.repeat(64);
    await app.refreshPersistedWorkspace();
    expect(await app.inspectProactiveRecoveryReceipt(plan.operationId)).toMatchObject({ status: 'unavailable', operationId: plan.operationId });
    expect(archive.entries[0].sourceSha256).toBe('f'.repeat(64));
    expect(app.getProactiveRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'archive_invalid', archiveCount: null, archiveBytes: null });
  });

  it('gates receipt inspection when another writer changes the current raw workspace', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' });
    await app.refreshPersistedWorkspace();
    let startRead!: () => void;
    let continueRead!: () => void;
    const reading = new Promise<void>((resolve) => { startRead = resolve; });
    const gate = new Promise<void>((resolve) => { continueRead = resolve; });
    store.beforeReadSnapshot = async () => { store.beforeReadSnapshot = undefined; startRead(); await gate; };
    const inspect = app.inspectProactiveRecoveryReceipt(plan.operationId);
    await reading;
    store.value!.notes.push({ id: 'external-late', title: 'Late edit', transcript: '', durationSeconds: 0, createdAt: new Date().toISOString(), status: 'recorded', revision: 1 });
    continueRead();
    expect(await inspect).toMatchObject({ status: 'unavailable', operationId: plan.operationId });
    expect(app.getProactiveRecoveryStatus().status).toBe('refresh_required');
  });

  it('returns unknown and gates refresh if publication fails after the durable replacement', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    const before = store.saves;
    (app as unknown as { emit: () => void }).emit = () => { throw new Error('synthetic publication failure'); };
    const result = await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' });
    expect(result).toEqual({ status: 'unknown', operationId: plan.operationId });
    expect(store.saves).toBe(before + 1);
    expect(app.getProactiveRecoveryStatus().status).toBe('refresh_required');
  });

  it('requires the exact confirmation phrase and does not persist a preparation or cancellation', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    const before = store.saves;
    await expect(app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'Reset Rules' as never })).rejects.toThrow(/RESET RULES/);
    await app.cancelProactiveRecovery(plan.operationId);
    expect(store.saves).toBe(before);
    expect(app.getProactiveRecoveryStatus().status).toBe('available');
  });

  it('consumes a plan after a lost save acknowledgement and verifies it only after explicit refresh', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    const before = store.saves;
    store.failAfterSave = true;
    expect(await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).toEqual({ status: 'unknown', operationId: plan.operationId });
    expect(store.saves).toBe(before + 1);
    expect(app.getProactiveRecoveryStatus().status).toBe('refresh_required');
    await expect(app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).rejects.toThrow(/no longer current/i);
    expect(store.saves).toBe(before + 1);
    await app.refreshPersistedWorkspace();
    const savesAfterRefresh = store.saves;
    expect(await app.inspectProactiveRecoveryReceipt(plan.operationId)).toMatchObject({ status: 'applied', operationId: plan.operationId });
    expect(store.saves).toBe(savesAfterRefresh);
  });

  it('does not accept a different valid archive entry that reuses a lost operation ID', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    store.failAfterSave = true;
    expect(await app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).toEqual({ status: 'unknown', operationId: plan.operationId });

    const archive = store.value!.proactiveRecoveryArchives as { version: 1; entries: { operationId: string; archivedAt: string; sourceJson: string; sourceSha256: string; sourceBytes: number }[] };
    const replacementSource = JSON.stringify({ proactiveQuarantine: { raw: { differentEvidence: 'valid but unrelated' } } });
    const replacementHash = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, replacementSource, { encoding: Crypto.CryptoEncoding.HEX })).toLowerCase();
    archive.entries[0] = {
      ...archive.entries[0], sourceJson: replacementSource, sourceSha256: replacementHash, sourceBytes: recoveryUtf8Bytes(replacementSource),
    };
    await app.refreshPersistedWorkspace();
    const beforeInspectSaves = store.saves;
    expect(await app.inspectProactiveRecoveryReceipt(plan.operationId)).toEqual({ status: 'not_verified', operationId: plan.operationId });
    expect(store.saves).toBe(beforeInspectSaves);
  });

  it('rejects expired and rolled-back confirmation plans without saving', async () => {
    const { app, store } = await quarantinedController();
    const originalNow = Date.now;
    let nowMs = originalNow();
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const plan = await app.prepareProactiveRecovery();
      const before = store.saves;
      nowMs = Date.parse(plan.expiresAt) + 1;
      await expect(app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).rejects.toThrow(/expired/i);
      expect(store.saves).toBe(before);
      const second = await app.prepareProactiveRecovery();
      nowMs = Date.now() - 1;
      await expect(app.confirmProactiveRecovery({ operationId: second.operationId, confirmation: 'RESET RULES' })).rejects.toThrow(/expired/i);
      expect(store.saves).toBe(before);
    } finally { vi.restoreAllMocks(); }
  });

  it('consumes a plan and requires refresh when the storage generation changes before confirmation', async () => {
    const { app, store } = await quarantinedController();
    const plan = await app.prepareProactiveRecovery();
    const before = store.saves;
    store.staleGeneration = true;
    await expect(app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).rejects.toThrow(/refresh_required/i);
    expect(store.saves).toBe(before);
    expect(app.getProactiveRecoveryStatus().status).toBe('refresh_required');
    await expect(app.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).rejects.toThrow(/no longer current/i);
  });

  it('gates the current workspace when the storage snapshot read fails during preparation', async () => {
    const { app, store } = await quarantinedController();
    const before = store.saves;
    store.failSnapshotRead = true;
    await expect(app.prepareProactiveRecovery()).rejects.toThrow(/refresh_required/i);
    expect(store.saves).toBe(before);
    expect(app.getProactiveRecoveryStatus().status).toBe('refresh_required');
  });

  it('does not evict a full archive and refuses a syntactically valid entry with a wrong digest', async () => {
    const store = new SnapshotStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const malformed = structuredClone(store.value!) as PrivateState;
    malformed.proactive = { bad: true } as never;
    const sourceJson = JSON.stringify({ proactiveQuarantine: { raw: { keep: true } } });
    const sourceSha256 = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, sourceJson, { encoding: Crypto.CryptoEncoding.HEX })).toLowerCase();
    const entries = Array.from({ length: PROACTIVE_RECOVERY_MAX_ARCHIVES }, (_, index) => ({
      operationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      archivedAt: new Date().toISOString(), sourceJson, sourceSha256, sourceBytes: recoveryUtf8Bytes(sourceJson),
    }));
    malformed.proactiveRecoveryArchives = { version: 1, entries };
    store.value = malformed;
    const app = new AppControllerImpl(store, {}, { privacySession });
    await app.load();
    const before = store.saves;
    expect(app.getProactiveRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'archive_full', archiveCount: 4 });
    await expect(app.prepareProactiveRecovery()).rejects.toThrow(/archive_full/i);
    expect(store.saves).toBe(before);

    const tampered = structuredClone(store.value!) as PrivateState;
    tampered.proactiveRecoveryArchives = { version: 1, entries: [{ ...entries[0], operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sourceSha256: 'e'.repeat(64) }] };
    store.value = tampered;
    const reloaded = new AppControllerImpl(store, {}, { privacySession });
    await reloaded.load();
    const beforeBadDigest = store.saves;
    await expect(reloaded.prepareProactiveRecovery()).rejects.toThrow(/archive_invalid/i);
    expect(store.saves).toBe(beforeBadDigest);
    expect(reloaded.getProactiveRecoveryStatus()).toMatchObject({ status: 'unavailable', reason: 'archive_invalid', archiveCount: null });
  });

  it('rejects noncanonical stored UUIDs instead of rewriting archive history', () => {
    const sourceJson = JSON.stringify({ proactiveQuarantine: { raw: true } });
    expect(() => validateProactiveRecoveryArchiveState({ version: 1, entries: [{
      operationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', archivedAt: new Date().toISOString(), sourceJson,
      sourceSha256: 'a'.repeat(64), sourceBytes: recoveryUtf8Bytes(sourceJson),
    }] })).toThrow(/unavailable/i);
    expect(() => validateProactiveRecoveryArchiveState(null)).toThrow(/unavailable/i);
  });

  it('refuses preparation while privacy reports an active writer and invalidates a plan on privacy disposal', async () => {
    const { store } = await quarantinedController();
    const active = new AppControllerImpl(store, {}, { privacySession: {
      ...privacySession,
      async getStatus() { return { ...(await privacySession.getStatus()), activeWriterCount: 1 }; },
    } });
    await active.load();
    const before = store.saves;
    await expect(active.prepareProactiveRecovery()).rejects.toThrow(/busy/i);
    expect(store.saves).toBe(before);

    const ready = new AppControllerImpl(store, {}, { privacySession });
    await ready.load();
    const plan = await ready.prepareProactiveRecovery();
    await ready.disposeForPrivacy();
    await expect(ready.confirmProactiveRecovery({ operationId: plan.operationId, confirmation: 'RESET RULES' })).rejects.toThrow();
    expect(store.saves).toBe(before);
  });
});
