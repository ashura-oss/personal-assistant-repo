import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Crypto from 'expo-crypto';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { BACKUP_LIMITS, PORTABLE_BACKUP_FORMAT, PORTABLE_BACKUP_SCHEMA_VERSION, parsePortableBackup, type PortableBackupV2 } from '../src/backup';

class MemoryStore implements StateStore {
  value?: AppState;
  failNext = false;
  saves = 0;
  loads = 0;
  async load() { this.loads += 1; return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.saves += 1;
    if (this.failNext) { this.failNext = false; throw new Error('disk full'); }
    this.value = structuredClone(state);
  }
  async clear() { this.value = undefined; }
}

const stamp = '2026-10-12T10:00:00.000Z';
function fixture(): PortableBackupV2 {
  return {
    format: PORTABLE_BACKUP_FORMAT, schemaVersion: PORTABLE_BACKUP_SCHEMA_VERSION, exportId: 'portable-1',
    exportedAt: stamp, audioIncluded: false,
    notes: [{ sourceId: 'same-note-id', title: 'Restored note', transcript: 'Remember the launch checklist.', durationSeconds: 12, createdAt: stamp, audioMissing: true, originalTimeZoneUnknown: true }],
    tasks: [
      { sourceId: 'linked-task', title: 'Pack cables', body: 'Bring the spare cable.', status: 'open', createdAt: stamp, sourceNoteId: 'same-note-id' },
      { sourceId: 'orphan-task', title: 'Call the venue', body: 'Confirm access.', status: 'completed', createdAt: stamp, completedAt: stamp, sourceNoteId: 'missing-note' },
    ],
    documents: [{ path: 'memory/RULES.md', content: '# Imported rules\n\nDo not call venues without asking.', revision: 3, updatedAt: stamp }],
    archivedDocuments: [],
    history: [{ kind: 'analysis', sourceId: 'analysis:same-note-id', sourceNoteId: 'same-note-id', title: 'Old analysis', content: 'Historical only.', status: 'Unverified historical result', occurredAt: stamp }],
  };
}

const sha = async (text: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });
afterEach(() => vi.restoreAllMocks());

describe('controller portable backup workflow', () => {
  it('rejects oversized input before cloning, loading state, or hashing', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    const digestSpy = vi.spyOn(Crypto, 'digestStringAsync');
    await expect(app.prepareBackupImport(new Uint8Array(BACKUP_LIMITS.maxBytes + 1))).rejects.toThrow(/exceeds the allowed size/i);
    expect(store.loads).toBe(0);
    expect(store.saves).toBe(0);
    expect(digestSpy).not.toHaveBeenCalled();
  });

  it('exports an allowlisted v2 backup without connected-account authority or credentials', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const state = structuredClone(app.getSnapshot());
    state.accounts.push({
      id: 'private-account', provider: 'google', displayName: 'Mail', email: 'me@example.test', connected: true,
      authStatus: 'connected', tokenRef: 'secret-token-ref', identity: { providerNamespace: 'google', clientId: 'client', subject: 'subject' },
      capabilities: ['mail.read'], connectionGeneration: 1,
    });
    await store.save(state);
    const restored = new AppControllerImpl(store);
    await restored.load();
    const backup = JSON.parse(await restored.exportData());
    expect(backup).toMatchObject({ format: PORTABLE_BACKUP_FORMAT, schemaVersion: 2, audioIncluded: false });
    expect(JSON.stringify(backup)).not.toContain('secret-token-ref');
    expect(backup).not.toHaveProperty('accounts');
    expect(backup).not.toHaveProperty('settings');
  });

  it('remaps colliding IDs, keeps imported policy/history inert, and supports imported task lifecycle', async () => {
    const store = new MemoryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const state = structuredClone(seed.getSnapshot());
    state.notes.push(
      { id: 'same-note-id', title: 'Existing', transcript: 'Local note.', durationSeconds: 0, createdAt: stamp, capturedAt: stamp, captureTimeZone: 'Asia/Singapore', status: 'recorded', revision: 1 },
      { id: 'missing-note', title: 'Unrelated collision', transcript: 'Not the task source.', durationSeconds: 0, createdAt: stamp, capturedAt: stamp, captureTimeZone: 'Asia/Singapore', status: 'recorded', revision: 1 },
    );
    await store.save(state);
    const app = new AppControllerImpl(store);
    await app.load();
    const beforeDocuments = structuredClone(app.getSnapshot().documents);
    const input = JSON.stringify(fixture());
    const preview = await app.prepareBackupImport(input);
    expect(preview).toMatchObject({ noteCount: 1, taskCount: 2, documentCount: 1, historyCount: 1, missingAudioCount: 1, alreadyImported: false });
    const [archive, duplicateApply] = await Promise.all([
      app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash }),
      app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash }),
    ]);
    expect(duplicateApply.id).toBe(archive.id);
    const importedNote = app.getSnapshot().notes.find((note) => note.importOrigin?.archiveId === archive.id)!;
    expect(importedNote.id).not.toBe('same-note-id');
    expect(importedNote).toMatchObject({ title: 'Restored note', status: 'recorded', revision: 1, captureTimeZone: 'UTC', importOrigin: { sourceNoteId: 'same-note-id', audioMissing: true, originalTimeZoneUnknown: true } });
    expect(importedNote).not.toHaveProperty('audioUri');
    expect(importedNote).not.toHaveProperty('analysis');
    const unknownZoneExport = parsePortableBackup(await app.exportData()).backup.notes.find((item) => item.sourceId === importedNote.id);
    expect(unknownZoneExport).toMatchObject({ originalTimeZoneUnknown: true });
    expect(unknownZoneExport).not.toHaveProperty('captureTimeZone');
    expect(app.getSnapshot().documents).toEqual(beforeDocuments);
    const linked = app.getSnapshot().tasks.find((task) => task.importOrigin?.kind === 'backup_import' && task.importOrigin.sourceTaskId === 'linked-task')!;
    const orphan = app.getSnapshot().tasks.find((task) => task.importOrigin?.kind === 'backup_import' && task.importOrigin.sourceTaskId === 'orphan-task')!;
    expect(linked).toMatchObject({ sourceNoteId: importedNote.id, importOrigin: { kind: 'backup_import', originalSourceNoteId: 'same-note-id' } });
    expect(orphan).not.toHaveProperty('sourceNoteId');
    expect(orphan).toMatchObject({ status: 'completed', importOrigin: { originalSourceNoteId: 'missing-note' } });
    await app.reopenTask(orphan.id);
    expect(app.getSnapshot().tasks.find((task) => task.id === orphan.id)?.status).toBe('open');
    await app.completeTask(orphan.id);
    expect(app.getSnapshot().tasks.find((task) => task.id === orphan.id)?.status).toBe('completed');
    expect(app.getSnapshot().proposals).toEqual([]);
    expect(app.getSnapshot().dispatchRecords).toEqual([]);
  });

  it('requires explicit original time zone confirmation before paid note or selected-note reply assistance', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const preview = await app.prepareBackupImport(JSON.stringify(fixture()));
    const archive = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    const imported = app.getSnapshot().notes.find((note) => note.importOrigin?.archiveId === archive.id)!;
    await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
    const internal = app as unknown as { openAiClient: { prepare: (...args: unknown[]) => Promise<unknown> } };
    const prepareSpy = vi.spyOn(internal.openAiClient, 'prepare');
    const attemptsBefore = app.getSnapshot().usage.attemptsToday;
    await expect(app.processNote(imported.id)).rejects.toThrow(/confirm this imported note/i);
    await expect(app.assistNote(imported.id)).rejects.toThrow(/confirm this imported note/i);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(app.getSnapshot().usage.attemptsToday).toBe(attemptsBefore);
    const internalState = app as unknown as { mutate: (operation: (draft: AppState) => void) => Promise<void> };
    await internalState.mutate((draft) => draft.proposals.push({
      id: 'zone-bound-proposal', noteId: imported.id, kind: 'task', title: 'Zone-dependent task', body: 'Review tomorrow.',
      status: 'approved', revision: 1, approvedRevision: 1, sourceRevision: imported.revision, recipients: [], evidence: [],
    }));

    await expect(app.confirmImportedNoteTimeZone(imported.id, { timeZone: 'Asia/Singapore', expectedRevision: imported.revision + 1 })).rejects.toThrow(/current revision/i);
    const confirmed = await app.confirmImportedNoteTimeZone(imported.id, { timeZone: 'Asia/Singapore', expectedRevision: imported.revision });
    expect(confirmed).toMatchObject({ revision: 2, captureTimeZone: 'Asia/Singapore', importOrigin: { timeZoneConfirmedAt: expect.any(String) } });
    expect(confirmed.importOrigin).not.toHaveProperty('originalTimeZoneUnknown');
    expect(app.getSnapshot().proposals.find((proposal) => proposal.id === 'zone-bound-proposal')).toMatchObject({ status: 'draft', revision: 2 });
    await app.saveSettings({ mode: 'preview' });
    expect(await app.assistNote(imported.id)).toMatchObject({ source: 'offline_preview' });

    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    const saved = reloaded.getSnapshot().notes.find((note) => note.id === imported.id)!;
    expect(saved.importOrigin?.timeZoneConfirmedAt).toBe(confirmed.importOrigin?.timeZoneConfirmedAt);
    const exported = parsePortableBackup(await reloaded.exportData()).backup.notes.find((note) => note.sourceId === saved.id);
    expect(exported).toMatchObject({ captureTimeZone: 'Asia/Singapore' });
    expect(exported).not.toHaveProperty('originalTimeZoneUnknown');
  });

  it('requires a fresh preview after state changes and keeps failed durable imports retryable without partial state', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const stale = await app.prepareBackupImport(JSON.stringify(fixture()));
    await app.saveNote({ transcript: 'A concurrent local edit.' });
    await expect(app.applyBackupImport({ sessionId: stale.sessionId, planHash: stale.planHash })).rejects.toThrow(/changed after the backup preview/i);
    expect(app.getSnapshot().importedBackups).toHaveLength(0);

    const fresh = await app.prepareBackupImport(JSON.stringify(fixture()));
    const notesBefore = app.getSnapshot().notes.length;
    store.failNext = true;
    await expect(app.applyBackupImport({ sessionId: fresh.sessionId, planHash: fresh.planHash })).rejects.toThrow(/disk full/i);
    expect(app.getSnapshot().notes).toHaveLength(notesBefore);
    expect(app.getSnapshot().importedBackups).toHaveLength(0);
    await app.applyBackupImport({ sessionId: fresh.sessionId, planHash: fresh.planHash });
    expect(app.getSnapshot().importedBackups).toHaveLength(1);
  });

  it('restores a deleted imported note from the same backup while preserving edited content and repairing only its verified task link', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const input = JSON.stringify(fixture());
    const firstPreview = await app.prepareBackupImport(input);
    const originalArchive = await app.applyBackupImport({ sessionId: firstPreview.sessionId, planHash: firstPreview.planHash });
    const originalNoteId = originalArchive.noteLinks[0].noteId;
    const linkedTaskId = originalArchive.taskLinks.find((item) => item.sourceId === 'linked-task')!.taskId;
    const internal = app as unknown as { mutate: (operation: (draft: AppState) => void) => Promise<void> };
    await internal.mutate((state) => {
      const task = state.tasks.find((item) => item.id === linkedTaskId)!;
      task.title = 'My edited task'; task.body = 'Keep this edited body.'; task.status = 'completed'; task.completedAt = stamp;
    });
    await app.deleteNote(originalNoteId);

    const preview = await app.prepareBackupImport(input);
    expect(preview).toMatchObject({ alreadyImported: true, missingNoteCount: 1, missingTaskCount: 0, missingNoteLabels: ['Restored note'], taskLinkRepairCount: 1, taskLinkRepairLabels: ['Pack cables'] });
    const restoredArchive = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    const restoredNote = app.getSnapshot().notes.find((item) => item.importOrigin?.archiveId === originalArchive.id && item.importOrigin.sourceNoteId === 'same-note-id')!;
    const task = app.getSnapshot().tasks.find((item) => item.id === linkedTaskId)!;
    expect(restoredNote.id).not.toBe(originalNoteId);
    expect(restoredNote).toMatchObject({ revision: 1, status: 'recorded', importOrigin: { audioMissing: true, originalTimeZoneUnknown: true } });
    expect(restoredNote).not.toHaveProperty('audioUri');
    expect(restoredNote).not.toHaveProperty('analysis');
    expect(task).toMatchObject({ title: 'My edited task', body: 'Keep this edited body.', status: 'completed', completedAt: stamp, sourceNoteId: restoredNote.id });
    expect(restoredArchive).toMatchObject({ id: originalArchive.id, importedAt: originalArchive.importedAt, contentHash: originalArchive.contentHash, fileHash: originalArchive.fileHash });
    expect(restoredArchive.documents).toEqual(originalArchive.documents);
    expect(restoredArchive.history).toEqual(originalArchive.history);
    expect(restoredArchive.noteLinks.find((item) => item.sourceId === 'same-note-id')?.noteId).toBe(restoredNote.id);
    expect(app.getSnapshot().proposals).toEqual([]);
    expect(app.getSnapshot().dispatchRecords).toEqual([]);

    const saves = store.saves;
    const repeated = await app.prepareBackupImport(input);
    expect(repeated).toMatchObject({ alreadyImported: true, missingNoteCount: 0, missingTaskCount: 0, taskLinkRepairCount: 0 });
    await app.applyBackupImport({ sessionId: repeated.sessionId, planHash: repeated.planHash });
    expect(app.getSnapshot().notes.filter((item) => item.importOrigin?.archiveId === originalArchive.id)).toHaveLength(1);
    expect(app.getSnapshot().tasks.filter((item) => item.importOrigin?.archiveId === originalArchive.id)).toHaveLength(2);
    expect(store.saves).toBe(saves);
  });

  it('uses canonical content identity when a regenerated export changes only export ID and time', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const originalInput = JSON.stringify(fixture());
    const first = await app.prepareBackupImport(originalInput);
    const archive = await app.applyBackupImport({ sessionId: first.sessionId, planHash: first.planHash });
    await app.deleteNote(archive.noteLinks[0].noteId);
    const regenerated = fixture();
    regenerated.exportId = 'portable-regenerated';
    regenerated.exportedAt = '2026-10-13T08:00:00.000Z';
    const newInput = JSON.stringify(regenerated);
    const preview = await app.prepareBackupImport(newInput);
    expect(preview.fileHash).not.toBe(archive.fileHash);
    expect(preview.contentHash).toBe(archive.contentHash);
    expect(preview).toMatchObject({ alreadyImported: true, missingNoteCount: 1, missingTaskCount: 0 });
    const restored = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    expect(restored).toMatchObject({ id: archive.id, fileHash: archive.fileHash, contentHash: archive.contentHash, importedAt: archive.importedAt });
    expect(app.getSnapshot().notes.some((item) => item.importOrigin?.archiveId === archive.id && item.importOrigin.sourceNoteId === 'same-note-id')).toBe(true);
    const duplicate = await app.prepareBackupImport(newInput);
    expect(duplicate).toMatchObject({ alreadyImported: true, missingNoteCount: 0, missingTaskCount: 0 });
  });

  it('imports and recovers special source IDs such as __proto__ and constructor as ordinary values', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const special = fixture();
    special.notes[0].sourceId = '__proto__';
    special.tasks[0].sourceId = '__proto__';
    special.tasks[0].sourceNoteId = '__proto__';
    special.tasks[1].sourceId = 'constructor';
    const input = JSON.stringify(special);
    const preview = await app.prepareBackupImport(input);
    const archive = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    const noteId = archive.noteLinks.find((link) => link.sourceId === '__proto__')?.noteId;
    const taskId = archive.taskLinks.find((link) => link.sourceId === '__proto__')?.taskId;
    expect(noteId).toBeTruthy();
    expect(taskId).toBeTruthy();
    expect(app.getSnapshot().tasks.find((task) => task.id === taskId)?.sourceNoteId).toBe(noteId);
    await app.deleteNote(noteId!);
    const recovery = await app.prepareBackupImport(input);
    expect(recovery).toMatchObject({ alreadyImported: true, missingNoteCount: 1, missingTaskCount: 0, taskLinkRepairCount: 1 });
    const recoveredArchive = await app.applyBackupImport({ sessionId: recovery.sessionId, planHash: recovery.planHash });
    expect(recoveredArchive.noteLinks.find((link) => link.sourceId === '__proto__')?.noteId).not.toBe(noteId);
    expect(recoveredArchive.taskLinks.find((link) => link.sourceId === '__proto__')?.taskId).toBe(taskId);
  });

  it('treats an occupied linked ID with the wrong origin as missing and never repairs a task away from another live note', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const input = JSON.stringify(fixture());
    const initial = await app.prepareBackupImport(input);
    const archive = await app.applyBackupImport({ sessionId: initial.sessionId, planHash: initial.planHash });
    const oldNoteId = archive.noteLinks[0].noteId;
    const otherNoteId = (await app.saveNote({ transcript: 'Unrelated source.' })).id;
    const taskId = archive.taskLinks.find((item) => item.sourceId === 'linked-task')!.taskId;
    const internal = app as unknown as { mutate: (operation: (draft: AppState) => void) => Promise<void> };
    await internal.mutate((state) => { state.tasks.find((item) => item.id === taskId)!.sourceNoteId = otherNoteId; });
    await app.deleteNote(oldNoteId);
    await internal.mutate((state) => state.notes.unshift({
      id: oldNoteId, title: 'Unrelated replacement', transcript: 'This is not the imported note.', durationSeconds: 0,
      createdAt: stamp, capturedAt: stamp, captureTimeZone: 'UTC', status: 'recorded', revision: 1,
    }));
    const preview = await app.prepareBackupImport(input);
    expect(preview).toMatchObject({ missingNoteCount: 1, missingTaskCount: 0, taskLinkRepairCount: 0 });
    await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    const imported = app.getSnapshot().notes.find((item) => item.importOrigin?.archiveId === archive.id && item.importOrigin.sourceNoteId === 'same-note-id')!;
    expect(imported.id).not.toBe(oldNoteId);
    expect(app.getSnapshot().notes.find((item) => item.id === oldNoteId)?.title).toBe('Unrelated replacement');
    expect(app.getSnapshot().tasks.find((item) => item.id === taskId)?.sourceNoteId).toBe(otherNoteId);
  });

  it('restores missing tasks with fresh IDs and leaves a failed same-file recovery fully atomic', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const input = JSON.stringify(fixture());
    const first = await app.prepareBackupImport(input);
    const archive = await app.applyBackupImport({ sessionId: first.sessionId, planHash: first.planHash });
    const oldTaskId = archive.taskLinks.find((item) => item.sourceId === 'linked-task')!.taskId;
    await app.completeTask(oldTaskId);
    await app.deleteNote(archive.noteLinks[0].noteId); // The remaining task remains local and edited.
    await (app as unknown as { mutate: (operation: (draft: AppState) => void) => Promise<void> }).mutate((state) => {
      state.tasks = state.tasks.filter((item) => item.id !== oldTaskId);
      state.tasks.push({ id: oldTaskId, title: 'Unrelated occupied task ID', body: 'Do not replace.', status: 'completed', createdAt: stamp,
        sourceNoteId: 'unrelated-note', sourceRevision: 1, proposalId: 'unrelated-proposal' });
    });
    const preview = await app.prepareBackupImport(input);
    expect(preview).toMatchObject({ alreadyImported: true, missingNoteCount: 1, missingTaskCount: 1 });
    const stateBeforeFailure = structuredClone(app.getSnapshot());
    store.failNext = true;
    await expect(app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash })).rejects.toThrow(/disk full/i);
    expect(app.getSnapshot()).toEqual(stateBeforeFailure);
    const restored = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    expect(restored.id).toBe(archive.id);
    expect(app.getSnapshot().tasks).toHaveLength(3);
    expect(app.getSnapshot().tasks.find((item) => item.id === oldTaskId)).toMatchObject({ title: 'Unrelated occupied task ID', body: 'Do not replace.', status: 'completed' });
    expect(app.getSnapshot().tasks.find((item) => item.importOrigin?.sourceTaskId === 'linked-task')).toMatchObject({ status: 'open', title: 'Pack cables' });
  });

  it('copies byte input before async hashing and fails closed on an expired or clock-rolled-back preview', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const bytes = new TextEncoder().encode(JSON.stringify(fixture()));
    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    let release!: () => void;
    let started!: () => void;
    const digestStarted = new Promise<void>((resolve) => { started = resolve; });
    let gate = true;
    vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (algorithm, value, options) => {
      if (gate) { gate = false; started(); await new Promise<void>((resolve) => { release = resolve; }); }
      return originalDigest(algorithm, value, options);
    });
    try {
      const pending = app.prepareBackupImport(bytes);
      bytes.fill(0);
      await digestStarted;
      release();
      const preview = await pending;
      expect(preview.noteCount).toBe(1);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
      await expect(app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash })).rejects.toThrow(/expired/i);
      nowSpy.mockRestore();
    } finally { release?.(); }
  });

  it('activates documents only with exact content digest and conflict revision, preserving replaced text inertly', async () => {
    const store = new MemoryStore();
    const seed = new AppControllerImpl(store);
    await seed.load();
    const state = structuredClone(seed.getSnapshot());
    const existingRules = state.documents.find((item) => item.path === 'memory/RULES.md')!;
    Object.assign(existingRules, { content: '# Existing rules', revision: 4, updatedAt: stamp });
    await store.save(state);
    const app = new AppControllerImpl(store);
    await app.load();
    const preview = await app.prepareBackupImport(JSON.stringify(fixture()));
    expect(preview.documentConflicts).toEqual([{ path: 'memory/RULES.md', identical: false }]);
    const archive = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    const document = archive.documents[0];
    const contentDigest = await sha(document.content);
    await expect(app.activateImportedDocument({ archiveId: archive.id, documentId: document.id, destinationPath: '../escape.md', contentDigest, expectedCurrentRevision: 4, replaceConfirmed: true })).rejects.toThrow(/invalid segment/i);
    await expect(app.activateImportedDocument({ archiveId: archive.id, documentId: document.id, destinationPath: document.path, contentDigest: 'f'.repeat(64), expectedCurrentRevision: 4, replaceConfirmed: true })).rejects.toThrow(/content changed/i);
    await expect(app.activateImportedDocument({ archiveId: archive.id, documentId: document.id, destinationPath: document.path, contentDigest, expectedCurrentRevision: 3, replaceConfirmed: true })).rejects.toThrow(/explicit replacement confirmation/i);
    const activated = await app.activateImportedDocument({ archiveId: archive.id, documentId: document.id, destinationPath: document.path, contentDigest, expectedCurrentRevision: 4, replaceConfirmed: true });
    expect(activated).toMatchObject({ status: 'activated', document: { revision: 5, content: document.content } });
    const savedArchive = app.getSnapshot().importedBackups.find((item) => item.id === archive.id)!;
    expect(savedArchive.documents).toHaveLength(2);
    expect(savedArchive.documents[1]).toMatchObject({ path: 'memory/RULES.md', content: '# Existing rules', revision: 4 });
    const unchanged = await app.activateImportedDocument({ archiveId: archive.id, documentId: document.id, destinationPath: document.path, contentDigest, expectedCurrentRevision: 5, replaceConfirmed: false });
    expect(unchanged.status).toBe('unchanged');
    expect(unchanged.document.revision).toBe(5);
  });

  it('reports mirror failures after canonical activation and preserves the saved document', async () => {
    const store = new MemoryStore();
    const app = new AppControllerImpl(store);
    await app.load();
    const preview = await app.prepareBackupImport(JSON.stringify(fixture()));
    const archive = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    const doc = archive.documents[0];
    const mirrorSpy = vi.spyOn(await import('../src/storage/documents'), 'writePrivateDocument').mockRejectedValue(new Error('mirror unavailable'));
    try {
      const activated = await app.activateImportedDocument({ archiveId: archive.id, documentId: doc.id, destinationPath: 'memory/restored-RULES.md', contentDigest: await sha(doc.content), replaceConfirmed: false });
      expect(activated).toMatchObject({ status: 'activated', mirrorPending: true });
      expect(app.getSnapshot().documents.find((item) => item.path === 'memory/restored-RULES.md')?.content).toBe(doc.content);
    } finally { mirrorSpy.mockRestore(); }
  });

  it('quarantines malformed archives privately without erasing imported local content on later saves', async () => {
    const store = new MemoryStore();
    const base = new AppControllerImpl(store);
    await base.load();
    const corrupted = structuredClone(base.getSnapshot());
    (corrupted as unknown as { importedBackups: unknown[] }).importedBackups = Array.from({ length: 50 }, (_, index) => ({
      id: `bad-archive-${index}`, contentHash: index === 0 ? 'private-invalid-archive-data' : `invalid-${index}`,
    }));
    (corrupted as unknown as { backupRecoveryStatus: unknown }).backupRecoveryStatus = { quarantinedArchiveCount: 999, message: 'raw untrusted status' };
    corrupted.notes.push({
      id: 'kept-note', title: 'Kept transcript', transcript: 'Local text remains available.', durationSeconds: 1,
      createdAt: stamp, capturedAt: stamp, captureTimeZone: 'UTC', status: 'recorded', revision: 1,
      importOrigin: { kind: 'backup_import', archiveId: 'bad-archive', sourceNoteId: 'source-note', audioMissing: true },
    });
    corrupted.tasks.push({
      id: 'kept-task', title: 'Kept task', body: 'Still locally useful.', status: 'open', createdAt: stamp,
      importOrigin: { kind: 'backup_import', archiveId: 'bad-archive', sourceTaskId: 'source-task' },
    });
    store.value = corrupted;

    const loaded = new AppControllerImpl(store);
    await loaded.load();
    expect(loaded.getSnapshot().backupRecoveryStatus?.quarantinedArchiveCount).toBe(50);
    expect(loaded.getSnapshot().backupRecoveryStatus?.message).not.toContain('raw untrusted status');
    expect(loaded.getSnapshot()).not.toHaveProperty('backupImportQuarantine');
    expect(loaded.getSnapshot().importedBackups).toEqual([]);
    expect(loaded.getSnapshot().notes.find((note) => note.id === 'kept-note')).toMatchObject({
      transcript: 'Local text remains available.', importOrigin: { originUnverified: true },
    });
    expect(loaded.getSnapshot().tasks.find((task) => task.id === 'kept-task')).toMatchObject({
      body: 'Still locally useful.', importOrigin: { originUnverified: true },
    });
    const blocked = await loaded.prepareBackupImport(JSON.stringify(fixture()));
    await expect(loaded.applyBackupImport({ sessionId: blocked.sessionId, planHash: blocked.planHash })).rejects.toThrow(/archive limit is 50/i);
    await loaded.saveSettings({ timezone: 'Asia/Singapore' });
    const rawAfterSave = JSON.stringify(store.value);
    expect(rawAfterSave).toContain('private-invalid-archive-data');

    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    expect(reloaded.getSnapshot().backupRecoveryStatus?.quarantinedArchiveCount).toBe(50);
    expect(reloaded.getSnapshot().notes.find((note) => note.id === 'kept-note')?.transcript).toBe('Local text remains available.');
    expect(await reloaded.exportData()).not.toContain('private-invalid-archive-data');
  });
});
