// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Note, AppSettings } from '../src/core';
import { createNodeSpeechAudioService } from '../src/audio/speechUpload.node';
import { SharedAzureSpeechClient } from '../src/services/azureSpeech.shared';

function wavFixture(): Uint8Array {
  const bytes = new Uint8Array(44 + 1600);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); text(36, 'data'); view.setUint32(40, 1600, true);
  bytes.fill(128, 44);
  return bytes;
}

describe('server speech upload adapter', () => {
  it('passes the exact leased digest and bytes through the shared multipart Speech client as Blob', async () => {
    const mediaId = randomUUID();
    const repositoryLeaseId = randomUUID();
    const audio = wavFixture();
    const sha256 = createHash('sha256').update(audio).digest('hex');
    const releaseSpeechLease = vi.fn(async () => undefined);
    const repository = {
      createSpeechLease: vi.fn(async ({ noteId, noteRevision }) => {
        expect(noteId).toBe('22222222-2222-4222-8222-222222222222');
        expect(noteRevision).toBe(7);
        return { leaseId: repositoryLeaseId, mediaId, sha256, byteLength: audio.byteLength, durationSeconds: 0.2,
          fileName: 'recording.wav', format: 'wav' as const, mimeType: 'audio/wav' };
      }),
      readSpeechLease: vi.fn(async () => ({ metadata: { leaseId: repositoryLeaseId, mediaId, sha256, byteLength: audio.byteLength,
        durationSeconds: 0.2, fileName: 'recording.wav', format: 'wav' as const, mimeType: 'audio/wav' }, bytes: Buffer.from(audio) })),
      verifySpeechLease: vi.fn(async () => undefined),
      releaseSpeechLease,
    };
    const audioService = createNodeSpeechAudioService(repository);
    const note = { id: '22222222-2222-4222-8222-222222222222', title: 'Voice note', transcript: '', audioUri: `still-media:${mediaId}`,
      durationSeconds: 0.2, createdAt: '2026-10-15T00:00:00.000Z', status: 'recorded', revision: 7 } as Note;
    let form!: FormData;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      form = init?.body as FormData;
      return new Response(JSON.stringify({ durationMilliseconds: 200, combinedPhrases: [{ text: 'spoken words' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new SharedAzureSpeechClient({ fetcher, audio: audioService,
      readKeySnapshot: async () => ({ key: 'fixture-key', generation: 3 }), currentCredentialGeneration: () => 3,
      assertCredentialGeneration: (generation) => { if (generation !== 3) throw new Error('stale'); }, randomUUID: randomUUID,
      withRequestOwnership: (request) => request(), withResponseLifetime: async (_input, _init, consume, _cancel, beforeStart) => {
        beforeStart?.(); return consume(await fetcher(_input, _init));
      } });
    const settings = { speechEnabled: true, speechEndpoint: 'https://fixture.cognitiveservices.azure.com', maxAudioSeconds: 600 } as AppSettings;
    const result = await client.transcribe(note, settings);
    await result.cleanupPromise;
    expect(result.transcript).toBe('spoken words');
    expect(repository.createSpeechLease).toHaveBeenCalledTimes(1);
    expect(repository.verifySpeechLease).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent = form.get('audio');
    expect(sent).toBeInstanceOf(Blob);
    expect((sent as File).name).toBe('recording.wav');
    expect(new Uint8Array(await (sent as Blob).arrayBuffer())).toEqual(audio);
    expect(releaseSpeechLease).toHaveBeenCalledWith(repositoryLeaseId);
  });

  it('retains exact repository cleanup authority when release fails and coalesces concurrent retries', async () => {
    const mediaId = randomUUID();
    const repositoryLeaseId = randomUUID();
    const externalLeaseId = randomUUID();
    let releaseAttempts = 0;
    let settleFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { settleFirst = resolve; });
    const repository = {
      createSpeechLease: vi.fn(async () => ({ leaseId: repositoryLeaseId, mediaId, sha256: 'a'.repeat(64), byteLength: 100,
        durationSeconds: 0.2, fileName: 'recording.wav', format: 'wav' as const, mimeType: 'audio/wav' })),
      readSpeechLease: vi.fn(async () => ({ metadata: { sha256: 'a'.repeat(64), byteLength: 100 }, bytes: Buffer.alloc(100) })),
      verifySpeechLease: vi.fn(async () => undefined),
      releaseSpeechLease: vi.fn(async (leaseId: string) => {
        expect(leaseId).toBe(repositoryLeaseId);
        releaseAttempts += 1;
        if (releaseAttempts === 1) { await firstRelease; throw new Error('temporary release failure'); }
      }),
    };
    const service = createNodeSpeechAudioService(repository);
    const note = { id: 'legacy-note-id', title: '', transcript: '', audioUri: `still-media:${mediaId}`, durationSeconds: 0.2,
      createdAt: '2026-10-15T00:00:00.000Z', status: 'recorded', revision: 1 } as Note;
    await service.prepare(note, { leaseId: externalLeaseId, maxDurationSeconds: 600, maxAudioBytes: 1024 });

    const first = service.release(externalLeaseId);
    const coalesced = service.release(externalLeaseId);
    expect(repository.releaseSpeechLease).toHaveBeenCalledTimes(1);
    settleFirst();
    await expect(first).rejects.toThrow('temporary release failure');
    await expect(coalesced).rejects.toThrow('temporary release failure');
    await service.release(externalLeaseId);
    expect(repository.releaseSpeechLease).toHaveBeenCalledTimes(2);
    expect(releaseAttempts).toBe(2);
  });

  it('keeps cleanup authority after preparation validation fails and reports release failure for explicit retry', async () => {
    const mediaId = randomUUID();
    const repositoryLeaseId = randomUUID();
    const externalLeaseId = randomUUID();
    const releaseSpeechLease = vi.fn().mockRejectedValueOnce(new Error('cleanup pending')).mockResolvedValueOnce(undefined);
    const repository = {
      createSpeechLease: vi.fn(async () => ({ leaseId: repositoryLeaseId, mediaId: randomUUID(), sha256: 'b'.repeat(64), byteLength: 100,
        durationSeconds: 0.2, fileName: 'recording.wav', format: 'wav' as const, mimeType: 'audio/wav' })),
      readSpeechLease: vi.fn(async () => ({ metadata: { sha256: 'b'.repeat(64), byteLength: 100 }, bytes: Buffer.alloc(100) })),
      verifySpeechLease: vi.fn(async () => undefined),
      releaseSpeechLease,
    };
    const service = createNodeSpeechAudioService(repository);
    const note = { id: 'old local note id', title: '', transcript: '', audioUri: `still-media:${mediaId}`, durationSeconds: 0.2,
      createdAt: '2026-10-15T00:00:00.000Z', status: 'recorded', revision: 1 } as Note;
    await expect(service.prepare(note, { leaseId: externalLeaseId, maxDurationSeconds: 600, maxAudioBytes: 1024 }))
      .rejects.toThrow('recording changed');
    await expect(service.release(externalLeaseId)).rejects.toThrow('cleanup pending');
    await service.release(externalLeaseId);
    expect(releaseSpeechLease.mock.calls).toEqual([[repositoryLeaseId], [repositoryLeaseId]]);
  });
});
