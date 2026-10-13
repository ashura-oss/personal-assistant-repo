import { describe, expect, it, vi } from 'vitest';
import type { Note } from '../src/core';
import { createNativeSpeechAudioService } from '../src/audio/speechUpload.native';
import { clearSpeechStagingMemory, createWebSpeechAudioService, speechStagingMemoryCount } from '../src/audio/speechUpload.web';
import type { NativeSpeechAudioIO } from '../src/audio/speechUpload.types';
import { convertFormDataAsync } from 'expo/src/winter/fetch/convertFormData';

const lease = '11111111-1111-4111-8111-111111111111';
const bytes = new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0, 1, 2, 3]);
const note = { id: '22222222-2222-4222-8222-222222222222', title: 'Audio', transcript: '', audioUri: 'file:///private/documents/recording-recovery/input.m4a', durationSeconds: 7, createdAt: '2026-10-13T00:00:00.000Z', status: 'recorded', revision: 1 } as Note;

function nativeIO(initial = bytes.slice()) {
  const files = new Map<string, Uint8Array>([[note.audioUri!, initial]]);
  const dirs = new Set<string>();
  const io: NativeSpeechAudioIO = {
    cacheDirectory: 'file:///app/cache/',
    async exists(uri) { return dirs.has(uri) ? { exists: true, isDirectory: true } : files.has(uri) ? { exists: true, size: files.get(uri)!.byteLength } : { exists: false }; },
    async makeDirectory(uri) { dirs.add(uri); },
    async copy(from, to) { files.set(to, files.get(from)!.slice()); },
    async move(from, to) { files.set(to, files.get(from)!.slice()); files.delete(from); },
    async remove(uri) { files.delete(uri); },
    async readHeader(uri) { return files.get(uri)!.slice(0, 16); },
    async readBytes(uri) { return files.get(uri)!.slice(); },
  };
  return { io, files, dirs };
}

describe('speech upload snapshots', () => {
  it('copies native media into its private cache lease, verifies the snapshot, and never deletes the source', async () => {
    const mock = nativeIO();
    const service = createNativeSpeechAudioService({ io: mock.io, crypto: { sha256: async () => 'a'.repeat(64) } });
    const result = await service.prepare(note, { leaseId: lease, maxDurationSeconds: 30 });
    if (result.platform !== 'native') throw new Error('Expected native upload.');
    expect(result).toMatchObject({ leaseId: lease, platform: 'native', format: 'm4a', byteLength: bytes.byteLength, sha256: 'a'.repeat(64), durationSeconds: 7 });
    expect(result.upload.uri).toBe(`file:///app/cache/speech-upload/${lease}.m4a`);
    expect(result.upload.part.name).toBe('still-recording.m4a');
    expect(Array.from(await result.upload.part.bytes())).toEqual(Array.from(bytes));
    const form = { entries: () => [['audio', result.upload.part] as [string, unknown]] } as unknown as FormData;
    const serialized = await convertFormDataAsync(form, 'test-boundary');
    expect(new TextDecoder().decode(serialized.body)).toContain('filename="still-recording.m4a"');
    expect(Buffer.from(serialized.body).includes(Buffer.from(bytes))).toBe(true);
    await service.verify(result);
    expect(mock.files.has(note.audioUri!)).toBe(true);
    mock.files.set(result.upload.uri, new Uint8Array([1]));
    await expect(service.verify(result)).rejects.toThrow(/changed/i);
    await service.release(lease);
    expect(mock.files.has(note.audioUri!)).toBe(true);
    expect(mock.files.has(result.upload.uri)).toBe(false);
  });

  it('rejects unsupported headers and arbitrary cleanup identifiers before retaining files', async () => {
    const mock = nativeIO(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const service = createNativeSpeechAudioService({ io: mock.io, crypto: { sha256: async () => 'a'.repeat(64) } });
    await expect(service.prepare(note, { leaseId: lease, maxDurationSeconds: 30 })).rejects.toThrow(/header|supported/i);
    await expect(service.release('../../recording')).rejects.toThrow(/lease/i);
    expect(mock.files.has(note.audioUri!)).toBe(true);
  });

  it('does not invoke native I/O for an already-aborted preparation', async () => {
    const mock = nativeIO();
    const exists = vi.spyOn(mock.io, 'exists');
    const service = createNativeSpeechAudioService({ io: mock.io, crypto: { sha256: async () => 'a'.repeat(64) } });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(service.prepare(note, { leaseId: lease, maxDurationSeconds: 30, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(exists).not.toHaveBeenCalled();
  });

  it('rejects file mutation against attachment size and digest before returning uploadable bytes', async () => {
    const mock = nativeIO();
    const service = createNativeSpeechAudioService({ io: mock.io, crypto: { sha256: async () => 'a'.repeat(64) } });
    const attached = { ...note, audioAttachment: { kind: 'user_selected_replacement', originalMatch: 'unverified', attachedAt: '2026-10-13T00:00:00.000Z', fileName: 'original.m4a', format: 'm4a', mimeType: 'audio/mp4', byteLength: bytes.byteLength, sha256: 'f'.repeat(64), durationStatus: 'known', durationSeconds: 7 } } as Note;
    await expect(service.prepare(attached, { leaseId: lease, maxDurationSeconds: 30 })).rejects.toThrow(/changed since/i);
  });

  it('creates immutable web Blob snapshot and releases only its exact lease', async () => {
    const original = new Blob([bytes], { type: 'audio/mp4' });
    const get = vi.fn(async () => original);
    const service = createWebSpeechAudioService({ get, crypto: { sha256: async () => 'a'.repeat(64) } });
    const webNote = { ...note, audioUri: 'indexeddb-audio:test', audioAttachment: undefined } as Note;
    const result = await service.prepare(webNote, { leaseId: lease, maxDurationSeconds: 30 });
    if (result.platform !== 'web') throw new Error('Expected web upload.');
    expect(result.platform).toBe('web');
    expect(result.upload.blob).not.toBe(original);
    await service.verify(result);
    await service.release('../../bad');
    await expect(service.verify(result)).resolves.toBeUndefined();
    await service.release(lease);
    await expect(service.verify(result)).rejects.toThrow(/lease/i);
  });

  it('does not start web storage work for an already-aborted signal', async () => {
    const get = vi.fn(async () => new Blob([bytes], { type: 'audio/mp4' }));
    const service = createWebSpeechAudioService({ get, crypto: { sha256: async () => 'a'.repeat(64) } });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const webNote = { ...note, audioUri: 'indexeddb-audio:test', audioAttachment: undefined } as Note;
    await expect(service.prepare(webNote, { leaseId: lease, maxDurationSeconds: 30, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(get).not.toHaveBeenCalled();
  });

  it('settles a stalled web read on cancellation and ignores its late result', async () => {
    let finish!: (value: Blob) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const delayedRead = new Promise<Blob>((resolve) => { finish = resolve; });
    const hash = vi.fn(async () => 'a'.repeat(64));
    const service = createWebSpeechAudioService({ get: () => { entered(); return delayedRead; }, crypto: { sha256: hash } });
    const controller = new AbortController();
    const webNote = { ...note, audioUri: 'indexeddb-audio:test', audioAttachment: undefined } as Note;
    const preparing = service.prepare(webNote, { leaseId: lease, maxDurationSeconds: 30, signal: controller.signal });
    await started;
    controller.abort(new Error('cancelled'));
    await expect(preparing).rejects.toThrow('cancelled');
    finish(new Blob([bytes], { type: 'audio/mp4' }));
    await Promise.resolve();
    expect(hash).not.toHaveBeenCalled();
  });

  it('fails duration and size preflight before copying', async () => {
    const mock = nativeIO();
    const copy = vi.spyOn(mock.io, 'copy');
    const service = createNativeSpeechAudioService({ io: mock.io, crypto: { sha256: async () => 'a'.repeat(64) } });
    await expect(service.prepare({ ...note, durationSeconds: 31 }, { leaseId: lease, maxDurationSeconds: 30 })).rejects.toThrow(/duration/i);
    expect(copy).not.toHaveBeenCalled();
  });

  it('keeps a timed-out native copy lease locked until the late write settles, then removes only its staged file', async () => {
    const mock = nativeIO();
    let finishCopy!: () => void;
    let copyStarted!: () => void;
    const started = new Promise<void>((resolve) => { copyStarted = resolve; });
    const delayedCopy = new Promise<void>((resolve) => { finishCopy = resolve; });
    const io: NativeSpeechAudioIO = {
      ...mock.io,
      async copy(from, to) {
        copyStarted();
        await delayedCopy;
        mock.files.set(to, mock.files.get(from)!.slice());
      },
    };
    const service = createNativeSpeechAudioService({ io, crypto: { sha256: async () => 'a'.repeat(64) } });
    const controller = new AbortController();
    const preparing = service.prepare(note, { leaseId: lease, maxDurationSeconds: 30, signal: controller.signal });
    await started;
    controller.abort(new Error('cancelled'));
    await expect(preparing).rejects.toThrow();
    await expect(service.release(lease)).rejects.toThrow(/still owns/i);
    finishCopy();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(mock.files.has(`${io.cacheDirectory}speech-upload/${lease}.stage`)).toBe(false);
    expect(mock.files.has(note.audioUri!)).toBe(true);
  });

  it('privacy-disposes native memory without claiming or removing an in-flight staged file', async () => {
    const mock = nativeIO();
    let finishHash!: (digest: string) => void;
    let hashStarted!: () => void;
    const started = new Promise<void>((resolve) => { hashStarted = resolve; });
    const service = createNativeSpeechAudioService({
      io: mock.io,
      crypto: { sha256: async () => { hashStarted(); return new Promise<string>((resolve) => { finishHash = resolve; }); } },
    });
    const preparing = service.prepare(note, { leaseId: lease, maxDurationSeconds: 30 });
    await started;
    service.disposeMemory?.();
    finishHash('a'.repeat(64));
    await expect(preparing).rejects.toThrow(/no longer available/i);
    expect(mock.files.has(note.audioUri!)).toBe(true);
    await expect(service.verify({ leaseId: lease, platform: 'native', format: 'm4a', mimeType: 'audio/mp4', byteLength: bytes.length, sha256: 'a'.repeat(64), durationSeconds: 7, upload: { uri: `file:///app/cache/speech-upload/${lease}.m4a`, part: { name: 'recording.m4a', type: 'audio/mp4', async bytes() { return bytes; } } } })).rejects.toThrow(/no longer available/i);
  });

  it('clears and disposes every instance-local web blob map and blocks a late hash from repopulating it', async () => {
    const first = createWebSpeechAudioService({ get: async () => new Blob([bytes], { type: 'audio/mp4' }), crypto: { sha256: async () => 'a'.repeat(64) } });
    const second = createWebSpeechAudioService({ get: async () => new Blob([bytes], { type: 'audio/mp4' }), crypto: { sha256: async () => 'a'.repeat(64) } });
    const webNote = { ...note, audioUri: 'indexeddb-audio:test', audioAttachment: undefined } as Note;
    await first.prepare(webNote, { leaseId: lease, maxDurationSeconds: 30 });
    const otherLease = '33333333-3333-4333-8333-333333333333';
    await second.prepare(webNote, { leaseId: otherLease, maxDurationSeconds: 30 });
    expect(speechStagingMemoryCount()).toBe(2);
    expect(clearSpeechStagingMemory()).toBe(2);
    expect(speechStagingMemoryCount()).toBe(0);
    await expect(first.prepare(webNote, { leaseId: '44444444-4444-4444-8444-444444444444', maxDurationSeconds: 30 })).rejects.toThrow(/no longer available/i);

    let finishHash!: (digest: string) => void;
    let hashStarted!: () => void;
    const started = new Promise<void>((resolve) => { hashStarted = resolve; });
    const late = createWebSpeechAudioService({ get: async () => new Blob([bytes], { type: 'audio/mp4' }), crypto: { sha256: async () => { hashStarted(); return new Promise<string>((resolve) => { finishHash = resolve; }); } } });
    const lateLease = '55555555-5555-4555-8555-555555555555';
    const preparing = late.prepare(webNote, { leaseId: lateLease, maxDurationSeconds: 30 });
    await started;
    clearSpeechStagingMemory();
    finishHash('a'.repeat(64));
    await expect(preparing).rejects.toThrow(/no longer available/i);
    expect(speechStagingMemoryCount()).toBe(0);
  });
});
