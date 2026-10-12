import { describe, expect, it, vi } from 'vitest';
import * as Crypto from 'expo-crypto';
import type { AudioRecoveryMetadata, RecordingRecoveryService, StagedRecording } from '../src/audio/recovery.types';
import { PORTABLE_BACKUP_FORMAT, PORTABLE_BACKUP_SCHEMA_VERSION, type PortableBackupV2 } from '../src/backup';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import { AzureSpeechClient } from '../src/services/azure';
import type { StateStore } from '../src/storage/contracts';

class MemoryStore implements StateStore {
  value?: AppState;
  failNext = false;
  saves = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.saves += 1;
    if (this.failNext) { this.failNext = false; throw new Error('disk full'); }
    this.value = structuredClone(state);
  }
  async clear() { this.value = undefined; }
}

const metadata: AudioRecoveryMetadata = {
  fileName: 'picked.wav', format: 'wav', mimeType: 'audio/wav', byteLength: 128,
  sha256: 'a'.repeat(64), durationStatus: 'known', durationSeconds: 42,
};
const staged: StagedRecording = { uri: 'file:///private/recording-recovery/picked.wav', metadata };
const stamp = '2026-10-12T10:00:00.000Z';

function backup(): PortableBackupV2 {
  return {
    format: PORTABLE_BACKUP_FORMAT, schemaVersion: PORTABLE_BACKUP_SCHEMA_VERSION, exportId: 'recovery-test',
    exportedAt: stamp, audioIncluded: false,
    notes: [{ sourceId: 'source-note', title: 'Imported note', transcript: 'Keep the launch checklist.', durationSeconds: 0, createdAt: stamp, audioMissing: true, originalTimeZoneUnknown: true }],
    tasks: [], documents: [], archivedDocuments: [], history: [],
  };
}

function fakeRecovery(overrides: Partial<RecordingRecoveryService> = {}) {
  return {
    pickAndStage: vi.fn(async () => structuredClone(staged)),
    inspect: vi.fn(async (recording: StagedRecording) => structuredClone(recording.metadata)),
    remove: vi.fn(async () => undefined),
    ...overrides,
  } satisfies RecordingRecoveryService;
}

async function importedNote(app: AppControllerImpl) {
  await app.load();
  const preview = await app.prepareBackupImport(JSON.stringify(backup()));
  const archive = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
  return app.getSnapshot().notes.find((note) => note.importOrigin?.archiveId === archive.id)!;
}

describe('imported recording recovery', () => {
  it('attaches only an explicitly selected, reinspected staged recording and survives reload', async () => {
    const store = new MemoryStore();
    const recovery = fakeRecovery();
    const app = new AppControllerImpl(store, {}, { recordingRecovery: recovery });
    const note = await importedNote(app);
    await (app as unknown as { mutate: (operation: (draft: AppState) => void) => Promise<void> }).mutate((state) => state.proposals.push({
      id: 'attachment-bound-proposal', noteId: note.id, kind: 'task', title: 'Use the recording', body: 'Review the audio.',
      status: 'approved', revision: 1, approvedRevision: 1, sourceRevision: note.revision, recipients: [], evidence: [],
    }));
    const preview = await app.prepareRecordingAttachment(note.id, { expectedRevision: note.revision });
    expect(preview).toMatchObject({ noteId: note.id, expectedRevision: 1, ...metadata });
    expect(preview).not.toHaveProperty('uri');
    expect(recovery.pickAndStage).toHaveBeenCalledWith({ maxDurationSeconds: 600 });

    const [attached, duplicate] = await Promise.all([
      app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash }),
      app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash }),
    ]);
    expect(attached).toEqual(duplicate);
    expect(recovery.inspect).toHaveBeenCalledTimes(1);
    expect(recovery.remove).not.toHaveBeenCalled();
    expect(attached).toMatchObject({ revision: 2, audioUri: staged.uri, durationSeconds: 42,
      importOrigin: { audioMissing: false }, audioAttachment: { kind: 'user_selected_replacement', originalMatch: 'unverified', sha256: metadata.sha256, attachedAt: expect.any(String) } });
    expect(attached.transcript).toBe(note.transcript);
    expect(attached.captureTimeZone).toBe('UTC');
    expect(app.getSnapshot().proposals.find((item) => item.id === 'attachment-bound-proposal')).toMatchObject({ status: 'draft', revision: 2 });
    expect(app.getSnapshot().proposals.find((item) => item.id === 'attachment-bound-proposal')?.approvedPayloadDigest).toBeUndefined();

    const reloaded = new AppControllerImpl(store, {}, { recordingRecovery: recovery });
    await reloaded.load();
    expect(reloaded.getSnapshot().notes.find((item) => item.id === note.id)).toMatchObject({ audioUri: staged.uri, audioAttachment: { sha256: metadata.sha256, durationStatus: 'known' }, importOrigin: { audioMissing: false } });

    const saves = store.saves;
    const sequentialRepeat = await app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash });
    expect(sequentialRepeat.audioUri).toBe(staged.uri);
    expect(recovery.inspect).toHaveBeenCalledTimes(1);
    await app.cancelRecordingAttachment(preview!.sessionId);
    expect(recovery.remove).not.toHaveBeenCalled();
    expect(store.saves).toBe(saves);
  });

  it('does not mark an ordinary text-only imported note as having lost audio after reload', async () => {
    const store = new MemoryStore();
    const plainBackup = backup();
    delete plainBackup.notes[0].audioMissing;
    const app = new AppControllerImpl(store);
    await app.load();
    const preview = await app.prepareBackupImport(JSON.stringify(plainBackup));
    const archive = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
    const note = app.getSnapshot().notes.find((item) => item.importOrigin?.archiveId === archive.id)!;
    expect(note.importOrigin?.audioMissing).toBe(false);
    const reloaded = new AppControllerImpl(store);
    await reloaded.load();
    const saved = reloaded.getSnapshot().notes.find((item) => item.id === note.id)!;
    expect(saved.importOrigin?.audioMissing).toBe(false);
    const exported = JSON.parse(await reloaded.exportData()) as { notes: { sourceId: string; audioMissing?: true }[] };
    expect(exported.notes.find((item) => item.sourceId === saved.id)).not.toHaveProperty('audioMissing');
    const service = fakeRecovery();
    const withService = new AppControllerImpl(store, {}, { recordingRecovery: service });
    await expect(withService.prepareRecordingAttachment(saved.id, { expectedRevision: saved.revision })).rejects.toThrow(/only an imported note with missing audio/i);
    expect(service.pickAndStage).not.toHaveBeenCalled();
  });

  it('resolves the lazily selected platform service without loading it during controller construction', async () => {
    const app = new AppControllerImpl(new MemoryStore());
    const service = await (app as unknown as { getRecordingRecoveryService: () => Promise<RecordingRecoveryService> }).getRecordingRecoveryService();
    expect(service).toMatchObject({ pickAndStage: expect.any(Function), inspect: expect.any(Function), remove: expect.any(Function) });
  });

  it('does not let a throwing subscriber reject a durable attachment or trigger staged-file cleanup', async () => {
    const store = new MemoryStore();
    const recovery = fakeRecovery();
    const app = new AppControllerImpl(store, {}, { recordingRecovery: recovery });
    const note = await importedNote(app);
    const preview = await app.prepareRecordingAttachment(note.id, { expectedRevision: note.revision });
    let healthySubscriberCalled = false;
    app.subscribe(() => { throw new Error('view failed'); });
    app.subscribe(() => { healthySubscriberCalled = true; });
    await expect(app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash })).resolves.toMatchObject({ audioUri: staged.uri });
    expect(healthySubscriberCalled).toBe(true);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)?.audioUri).toBe(staged.uri);
    expect(recovery.remove).not.toHaveBeenCalled();
  });

  it('removes a staged file and leaves the note unchanged when its revision changes after selection', async () => {
    const recovery = fakeRecovery();
    const app = new AppControllerImpl(new MemoryStore(), {}, { recordingRecovery: recovery });
    const note = await importedNote(app);
    const preview = await app.prepareRecordingAttachment(note.id, { expectedRevision: note.revision });
    await app.updateTranscript(note.id, 'Edited during file selection.');
    await expect(app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash })).rejects.toThrow(/note changed/i);
    expect(recovery.inspect).not.toHaveBeenCalled();
    expect(recovery.remove).toHaveBeenCalledWith(staged);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)).toMatchObject({ transcript: 'Edited during file selection.', revision: 2, importOrigin: { audioMissing: true } });
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)).not.toHaveProperty('audioUri');
  });

  it('claims attachment before asynchronous inspection so cancellation cannot race a commit', async () => {
    let release!: () => void;
    let started!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => { started = resolve; });
    const inspectionGate = new Promise<void>((resolve) => { release = resolve; });
    const recovery = fakeRecovery({ inspect: vi.fn(async (recording) => { started(); await inspectionGate; return structuredClone(recording.metadata); }) });
    const app = new AppControllerImpl(new MemoryStore(), {}, { recordingRecovery: recovery });
    const note = await importedNote(app);
    const preview = await app.prepareRecordingAttachment(note.id, { expectedRevision: note.revision });
    const attaching = app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash });
    await inspectionStarted;
    await expect(app.cancelRecordingAttachment(preview!.sessionId)).rejects.toThrow(/already being saved/i);
    release();
    const attached = await attaching;
    expect(attached.audioUri).toBe(staged.uri);
    expect(recovery.remove).not.toHaveBeenCalled();
  });

  it('protects an applying stage from a concurrent prepare that evicts older ready previews', async () => {
    const store = new MemoryStore();
    let pickIndex = 0;
    const recovery = fakeRecovery({
      pickAndStage: vi.fn(async () => {
        pickIndex += 1;
        const selectedMetadata = { ...metadata, fileName: `picked-${pickIndex}.wav`, sha256: String(pickIndex).repeat(64) };
        return { uri: `file:///private/recording-recovery/picked-${pickIndex}.wav`, metadata: selectedMetadata };
      }),
    });
    const app = new AppControllerImpl(store, {}, { recordingRecovery: recovery });
    const portable = backup();
    portable.notes.push(
      { ...portable.notes[0], sourceId: 'source-note-2', title: 'Imported note 2', transcript: 'Second note.' },
      { ...portable.notes[0], sourceId: 'source-note-3', title: 'Imported note 3', transcript: 'Third note.' },
    );
    await app.load();
    const importPreview = await app.prepareBackupImport(JSON.stringify(portable));
    const archive = await app.applyBackupImport({ sessionId: importPreview.sessionId, planHash: importPreview.planHash });
    const notes = app.getSnapshot().notes.filter((note) => note.importOrigin?.archiveId === archive.id);
    const first = await app.prepareRecordingAttachment(notes[0].id, { expectedRevision: notes[0].revision });
    const second = await app.prepareRecordingAttachment(notes[1].id, { expectedRevision: notes[1].revision });
    const firstUri = `file:///private/recording-recovery/picked-1.wav`;

    let releaseHash!: () => void;
    let hashStarted!: () => void;
    const hashGate = new Promise<void>((resolve) => { releaseHash = resolve; });
    const hashStartedPromise = new Promise<void>((resolve) => { hashStarted = resolve; });
    const originalDigest = Crypto.digestStringAsync.bind(Crypto);
    const digestSpy = vi.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (...args) => {
      if (String(args[1]).includes('picked-3.wav')) {
        hashStarted();
        await hashGate;
      }
      return originalDigest(...args);
    });
    try {
      const thirdPreparing = app.prepareRecordingAttachment(notes[2].id, { expectedRevision: notes[2].revision });
      await hashStartedPromise;
      const attachingFirst = app.attachRecording({ sessionId: first!.sessionId, planHash: first!.planHash });
      releaseHash();
      const third = await thirdPreparing;
      await expect(attachingFirst).resolves.toMatchObject({ audioUri: firstUri });
      expect(recovery.remove).not.toHaveBeenCalledWith({
        uri: firstUri,
        metadata: { ...metadata, fileName: 'picked-1.wav', sha256: '1'.repeat(64) },
      });
      expect(third).toBeTruthy();
      expect(second).toBeTruthy();
    } finally {
      releaseHash();
      digestSpy.mockRestore();
    }
  });

  it('rejects a staged-file metadata change and cleans up on durable-save failure', async () => {
    const recovery = fakeRecovery({ inspect: vi.fn(async () => ({ ...metadata, sha256: 'b'.repeat(64) })) });
    const store = new MemoryStore();
    const app = new AppControllerImpl(store, {}, { recordingRecovery: recovery });
    const note = await importedNote(app);
    const preview = await app.prepareRecordingAttachment(note.id, { expectedRevision: note.revision });
    await expect(app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash })).rejects.toThrow(/staged recording changed/i);
    expect(recovery.remove).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().notes.find((item) => item.id === note.id)).not.toHaveProperty('audioUri');

    const secondRecovery = fakeRecovery();
    const secondStore = new MemoryStore();
    const secondApp = new AppControllerImpl(secondStore, {}, { recordingRecovery: secondRecovery });
    const secondNote = await importedNote(secondApp);
    const secondPreview = await secondApp.prepareRecordingAttachment(secondNote.id, { expectedRevision: secondNote.revision });
    const before = structuredClone(secondApp.getSnapshot());
    secondStore.failNext = true;
    await expect(secondApp.attachRecording({ sessionId: secondPreview!.sessionId, planHash: secondPreview!.planHash })).rejects.toThrow(/disk full/i);
    expect(secondApp.getSnapshot()).toEqual(before);
    expect(secondRecovery.remove).toHaveBeenCalledWith(staged);
  });

  it('cancels only the staged selection and blocks unknown-duration replacements before key access or reservation', async () => {
    const unknown: AudioRecoveryMetadata = { ...metadata, durationStatus: 'unknown', durationSeconds: undefined };
    const recovery = fakeRecovery({
      pickAndStage: vi.fn(async () => ({ uri: staged.uri, metadata: unknown })),
      inspect: vi.fn(async (recording) => structuredClone(recording.metadata)),
    });
    const store = new MemoryStore();
    const readKey = vi.fn(async () => 'fictional-key');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ combinedPhrases: [{ text: 'should not happen' }] }), { status: 200 }));
    const app = new AppControllerImpl(store, { speech: new AzureSpeechClient({ readKey, fetcher }) }, { recordingRecovery: recovery });
    const note = await importedNote(app);
    const preview = await app.prepareRecordingAttachment(note.id, { expectedRevision: note.revision });
    await app.cancelRecordingAttachment(preview!.sessionId);
    expect(recovery.remove).toHaveBeenCalledWith({ uri: staged.uri, metadata: unknown });
    await expect(app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash })).rejects.toThrow(/preview is missing/i);

    const secondRecovery = fakeRecovery({
      pickAndStage: vi.fn(async () => ({ uri: staged.uri, metadata: unknown })),
      inspect: vi.fn(async (recording) => structuredClone(recording.metadata)),
    });
    const secondApp = new AppControllerImpl(new MemoryStore(), { speech: new AzureSpeechClient({ readKey, fetcher }) }, { recordingRecovery: secondRecovery });
    const secondNote = await importedNote(secondApp);
    const secondPreview = await secondApp.prepareRecordingAttachment(secondNote.id, { expectedRevision: secondNote.revision });
    const attached = await secondApp.attachRecording({ sessionId: secondPreview!.sessionId, planHash: secondPreview!.planHash });
    expect(attached).toMatchObject({ durationSeconds: 0, audioAttachment: { durationStatus: 'unknown' } });
    const snapshot = secondApp.getSnapshot();
    await secondApp.saveSettings({ mode: 'provider', speechEndpoint: 'https://example.cognitiveservices.azure.com' });
    const attempts = secondApp.getSnapshot().usage.attemptsToday;
    await expect(secondApp.transcribeNote(secondNote.id)).rejects.toThrow(/no verified duration/i);
    await expect(new AzureSpeechClient({ readKey, fetcher }).transcribe(attached, secondApp.getSnapshot().settings)).rejects.toThrow(/no verified duration/i);
    expect(secondApp.getSnapshot().usage.attemptsToday).toBe(attempts);
    expect(readKey).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(snapshot.usage.attemptsToday).toBe(0);
  });

  it('fails closed on malformed persisted attachment provenance without losing the imported transcript', async () => {
    const store = new MemoryStore();
    const recovery = fakeRecovery();
    const app = new AppControllerImpl(store, {}, { recordingRecovery: recovery });
    const note = await importedNote(app);
    const preview = await app.prepareRecordingAttachment(note.id, { expectedRevision: note.revision });
    await app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash });
    store.value!.notes.find((item) => item.id === note.id)!.audioAttachment!.durationStatus = 'unknown';
    const reloaded = new AppControllerImpl(store, {}, { recordingRecovery: recovery });
    await reloaded.load();
    const recovered = reloaded.getSnapshot().notes.find((item) => item.id === note.id)!;
    expect(recovered).toMatchObject({ transcript: note.transcript, importOrigin: { audioMissing: true } });
    expect(recovered).not.toHaveProperty('audioUri');
    expect(recovered).not.toHaveProperty('audioAttachment');
  });

  it('clears replacement provenance and marks audio missing when delete-after-transcription detaches the clip', async () => {
    const store = new MemoryStore();
    const recovery = fakeRecovery();
    const speech = { transcribe: vi.fn(async () => ({ transcript: 'Recovered transcript.', durationSeconds: 42, attempts: 1 })) } as unknown as AzureSpeechClient;
    const app = new AppControllerImpl(store, { speech }, { recordingRecovery: recovery });
    const note = await importedNote(app);
    const preview = await app.prepareRecordingAttachment(note.id, { expectedRevision: note.revision });
    const attached = await app.attachRecording({ sessionId: preview!.sessionId, planHash: preview!.planHash });
    await app.saveSettings({ mode: 'provider', audioRetention: 'delete_after_transcription' });
    const transcribed = await app.transcribeNote(note.id);
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
    expect(transcribed).toMatchObject({ transcript: 'Recovered transcript.', status: 'recorded', revision: attached.revision + 2, importOrigin: { audioMissing: true } });
    expect(transcribed).not.toHaveProperty('audioUri');
    expect(transcribed).not.toHaveProperty('audioAttachment');
  });
});
