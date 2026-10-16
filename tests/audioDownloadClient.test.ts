import { describe, expect, it, vi } from 'vitest';
import { createWebAudioUploadClient } from '../src/web/audioClient';

const session = Object.freeze({ authenticated: true as const, workspaceId: '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', privacyEpoch: 3, csrfToken: 'csrf' });
const mediaId = '30000000-0000-4000-8000-000000000001';

describe('authenticated audio download', () => {
  it('uses the same-origin media endpoint and validates an attachment response', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200,
      headers: new Headers({ 'Content-Type': 'audio/mp4; codecs=mp4a.40.2', 'Content-Disposition': 'attachment; filename="voice-note.m4a"' }),
      json: async () => ({}), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
    const client = createWebAudioUploadClient(session, { assertCurrent() {}, fetcher: fetcher as never });
    const result = await client.downloadMedia(mediaId);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/audio/${mediaId}?download=1`, expect.objectContaining({
      method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    }));
    expect(result.filename).toBe('voice-note.m4a');
    expect(result.blob.type).toBe('audio/mp4');
    expect([...new Uint8Array(await result.blob.arrayBuffer())]).toEqual([1, 2, 3]);
    client.dispose();
  });

  it('rejects unsafe filenames and stale media identifiers', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200,
      headers: new Headers({ 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename="../../secret.mp3"' }),
      json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }));
    const client = createWebAudioUploadClient(session, { assertCurrent() {}, fetcher: fetcher as never });
    await expect(client.downloadMedia(mediaId)).rejects.toMatchObject({ kind: 'malformed' });
    await expect(client.downloadMedia('../media')).rejects.toMatchObject({ kind: 'malformed' });
    expect(fetcher).toHaveBeenCalledOnce();
    client.dispose();
  });
});
