import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertRecoveryByteLength,
  boundedAudioFormatFromSignature,
  boundedRecoveryDuration,
  MAX_DURATION_SECONDS,
  MAX_RECOVERY_BYTES,
  safeAudioFileName,
  validateRecoveryFormat,
} from '../src/audio/formats';
import * as DocumentPicker from 'expo-document-picker';
import { createWebRecordingRecoveryService } from '../src/audio/recovery.web';
import type { RecoveryBlobStore } from '../src/audio/recovery.web';
import { loadAudioForUpload } from '../src/audio/readAudio.web';

vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('../src/audio/blobStore.web', () => ({
  getAudio: vi.fn(),
  putAudio: vi.fn(),
  removeAudio: vi.fn(),
}));

const ascii = (value: string) => new Uint8Array(Array.from(value, char => char.charCodeAt(0)));

describe('recording recovery format checks', () => {
  it('recognizes only the closed audio signatures using bounded header bytes', () => {
    expect(boundedAudioFormatFromSignature(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))).toBe('wav');
    expect(boundedAudioFormatFromSignature(ascii('OggS'))).toBe('ogg');
    expect(boundedAudioFormatFromSignature(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('webm');
    expect(boundedAudioFormatFromSignature(new Uint8Array([...ascii('0000ftyp'), 0, 0, 0, 0]))).toBe('m4a');
    expect(boundedAudioFormatFromSignature(ascii('ID3\u0004'))).toBe('mp3');
    expect(boundedAudioFormatFromSignature(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3');
    expect(boundedAudioFormatFromSignature(ascii('text'))).toBeNull();
  });

  it('requires extension and MIME declarations to agree with the file signature', () => {
    const wav = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]);
    expect(validateRecoveryFormat('speech.wav', 'audio/wav', wav)).toBe('wav');
    expect(() => validateRecoveryFormat('speech.mp3', 'audio/mpeg', wav)).toThrow(/format details do not match/i);
    expect(() => validateRecoveryFormat('speech.wav', 'audio/mpeg', wav)).toThrow(/format details do not match/i);
    expect(() => validateRecoveryFormat('speech.aac', 'audio/aac', wav)).toThrow(/not supported/i);
  });

  it('sanitizes display names into bounded path-free labels', () => {
    expect(safeAudioFileName('C:\\private\\folder\\report.wav', 'wav')).toBe('report.wav');
    expect(safeAudioFileName('../voice?.mp3', 'mp3')).toBe('voice_.mp3');
    expect(safeAudioFileName(`a\u202Eb.wav`, 'wav')).toBe('ab.wav');
    const longName = safeAudioFileName('𐐷'.repeat(200) + '.wav', 'wav');
    expect(Array.from(longName).length).toBeLessThanOrEqual(160);
    expect(longName.endsWith('.wav')).toBe(true);
  });
});

describe('recording recovery limits', () => {
  it('accepts only positive actual sizes up to 40 MiB', () => {
    expect(MAX_RECOVERY_BYTES).toBe(40 * 1024 * 1024);
    expect(() => assertRecoveryByteLength(1)).not.toThrow();
    expect(() => assertRecoveryByteLength(MAX_RECOVERY_BYTES)).not.toThrow();
    for (const invalid of [0, -1, MAX_RECOVERY_BYTES + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertRecoveryByteLength(invalid)).toThrow(/40 MiB/i);
    }
  });

  it('accepts finite positive durations only within the smaller configured cap', () => {
    expect(MAX_DURATION_SECONDS).toBe(600);
    expect(boundedRecoveryDuration(12.5004, 120)).toEqual({ durationStatus: 'known', durationSeconds: 12.5 });
    expect(boundedRecoveryDuration(0.0001, 120)).toEqual({ durationStatus: 'known', durationSeconds: 0.001 });
    expect(boundedRecoveryDuration(Number.NaN, 120)).toEqual({ durationStatus: 'unknown' });
    expect(() => boundedRecoveryDuration(0, 120)).toThrow(/longer than zero/i);
    expect(() => boundedRecoveryDuration(121, 120)).toThrow(/120 seconds/i);
    expect(() => boundedRecoveryDuration(601, 900)).toThrow(/600 seconds/i);
    expect(boundedRecoveryDuration(Number.POSITIVE_INFINITY, 120)).toEqual({ durationStatus: 'unknown' });
    expect(() => boundedRecoveryDuration(Number.NEGATIVE_INFINITY, 120)).toThrow(/longer than zero/i);
  });
});

const wavHeader = new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]);
const wavFile = (name = 'voice.wav', extraByte = 1) => new File([wavHeader, new Uint8Array([extraByte])], name, { type: 'audio/wav' });
const picked = (file: File) => ({
  canceled: false as const,
  assets: [{ name: file.name, size: file.size, lastModified: file.lastModified, uri: 'blob:chosen-file', mimeType: file.type, file }],
});

let audioInstances: MockAudio[];
let audioBehavior: 'loaded' | 'error' | 'timeout';
let createdUrls: string[];
let revokedUrls: string[];

class MockAudio extends EventTarget {
  duration = 3.23456;
  preload = '';
  src = '';
  pause = vi.fn();
  load = vi.fn(() => {
    if (audioBehavior === 'loaded') queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    if (audioBehavior === 'error') queueMicrotask(() => this.dispatchEvent(new Event('error')));
  });
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
  removedListeners = 0;
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    this.removedListeners++;
    super.removeEventListener(type, callback, options);
  }
  constructor() { super(); audioInstances.push(this); }
}

function memoryStore(): RecoveryBlobStore & { entries: Map<string, Blob> } {
  const entries = new Map<string, Blob>();
  return {
    entries,
    async put(id, blob) { entries.set(id, blob); },
    async get(id) { return entries.get(id); },
    async remove(id) { entries.delete(id); },
  };
}

beforeEach(() => {
  audioInstances = [];
  audioBehavior = 'loaded';
  createdUrls = [];
  revokedUrls = [];
  vi.stubGlobal('Audio', MockAudio);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => { const uri = `blob:probe-${createdUrls.length + 1}`; createdUrls.push(uri); return uri; }),
    revokeObjectURL: vi.fn((uri: string) => { revokedUrls.push(uri); }),
  });
  vi.mocked(DocumentPicker.getDocumentAsync).mockReset();
  vi.useRealTimers();
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('web recovery adapter boundaries', () => {
  it('stages a selected local file and inspects the exact staged hash', async () => {
    const store = memoryStore();
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(picked(wavFile()));
    const service = createWebRecordingRecoveryService(store);
    const staged = await service.pickAndStage({ maxDurationSeconds: 60 });
    expect(staged?.uri).toMatch(/^indexeddb-audio:recording-recovery-[0-9a-f-]{36}$/);
    expect(staged?.uri).not.toBe('blob:chosen-file');
    expect(staged?.metadata).toMatchObject({ format: 'wav', mimeType: 'audio/wav', durationStatus: 'known', durationSeconds: 3.235 });
    expect((await service.inspect(staged!, { maxDurationSeconds: 60 })).sha256).toBe(staged?.metadata.sha256);
    expect(createdUrls).toHaveLength(2);
    expect(revokedUrls).toEqual(createdUrls);
  });

  it('rejects changed staged bytes and removes only the generated stage id', async () => {
    const store = memoryStore();
    store.entries.set('keep-existing', new Blob(['keep']));
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(picked(wavFile()));
    const service = createWebRecordingRecoveryService(store);
    const staged = await service.pickAndStage({ maxDurationSeconds: 60 });
    const id = staged!.uri.replace(/^indexeddb-audio:recording-recovery-/, '');
    store.entries.set(id, wavFile('voice.wav', 2));
    await expect(service.inspect(staged!, { maxDurationSeconds: 60 })).rejects.toThrow(/changed since it was selected/i);
    await service.remove(staged!);
    expect(store.entries.has(id)).toBe(false);
    expect(store.entries.has('keep-existing')).toBe(true);
    await expect(service.remove({ ...staged!, uri: 'blob:chosen-file' })).rejects.toThrow(/not owned/i);
  });

  it.each(['save', 'readback'] as const)('cleans only its fresh id after a %s failure', async failure => {
    const store = memoryStore();
    store.entries.set('keep-existing', new Blob(['keep']));
    const remove = vi.spyOn(store, 'remove');
    if (failure === 'save') vi.spyOn(store, 'put').mockRejectedValue(new Error('save failed'));
    else vi.spyOn(store, 'get').mockResolvedValue(undefined);
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(picked(wavFile()));
    const service = createWebRecordingRecoveryService(store);
    await expect(service.pickAndStage({ maxDurationSeconds: 60 })).rejects.toThrow();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.entries.has('keep-existing')).toBe(true);
  });

  it('rejects unsupported and oversized files before persistent storage', async () => {
    const store = memoryStore();
    const put = vi.spyOn(store, 'put');
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(picked(new File(['not audio'], 'notes.wav', { type: 'audio/wav' })));
    await expect(createWebRecordingRecoveryService(store).pickAndStage({ maxDurationSeconds: 60 })).rejects.toThrow(/not a supported audio/i);
    expect(put).not.toHaveBeenCalled();

    class OversizedFile extends File { override get size() { return MAX_RECOVERY_BYTES + 1; } }
    const oversized = new OversizedFile([new Uint8Array([1])], 'large.wav', { type: 'audio/wav' });
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(picked(oversized));
    await expect(createWebRecordingRecoveryService(store).pickAndStage({ maxDurationSeconds: 60 })).rejects.toThrow(/40 MiB/i);
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects probe errors and timeouts while releasing object URLs and listeners', async () => {
    const store = memoryStore();
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(picked(wavFile()));
    audioBehavior = 'error';
    await expect(createWebRecordingRecoveryService(store).pickAndStage({ maxDurationSeconds: 60 })).rejects.toThrow(/could not be loaded/i);
    expect(revokedUrls).toEqual(createdUrls);
    expect(audioInstances[0].removedListeners).toBe(3);

    audioBehavior = 'timeout';
    vi.useFakeTimers();
    vi.stubGlobal('Audio', MockAudio);
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32));
    const pending = createWebRecordingRecoveryService(store).pickAndStage({ maxDurationSeconds: 60 });
    for (let attempt = 0; attempt < 20 && audioInstances.length < 2; attempt++) await Promise.resolve();
    expect(audioInstances).toHaveLength(2);
    const timedOut = expect(pending).rejects.toThrow(/within 10 seconds/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await timedOut;
    expect(revokedUrls).toEqual(createdUrls);
    expect(audioInstances[1].removedListeners).toBe(3);
  });

  it('keeps MP3 upload extension and MIME aligned with the actual signature', async () => {
    const mp3 = new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x64])], { type: 'audio/mpeg' });
    const { getAudio } = await import('../src/audio/blobStore.web');
    vi.mocked(getAudio).mockResolvedValue(mp3);
    await expect(loadAudioForUpload('indexeddb-audio:recording-id')).resolves.toMatchObject({ fileName: 'still-recording.mp3', mimeType: 'audio/mpeg', platform: 'web' });
  });
});
