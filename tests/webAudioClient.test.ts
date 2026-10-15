import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioMediaUrl, parseAudioUploadReceiptDTO } from '../src/cloud/audioUploadDto';
import { parseAudioUploadHistoryPageDTO } from '../src/cloud/audioUploadHistoryDto';
import { AudioUploadNotStartedError, AudioUploadUnknownError, createWebAudioUploadClient,
  type AudioFetchLike } from '../src/web/audioClient';

const uploadId = '11111111-1111-4111-8111-111111111111';
const captureId = '22222222-2222-4222-8222-222222222222';
const captureRevision = '33333333-3333-4333-8333-333333333333';
const noteId = '44444444-4444-4444-8444-444444444444';
const commandId = '55555555-5555-4555-8555-555555555555';
const mediaId = '66666666-6666-4666-8666-666666666666';
const capture = Object.freeze({ id: captureId, capturedAt: '2026-10-15T02:03:04.000Z', timeZone: 'Asia/Singapore' });
const session = Object.freeze({ authenticated: true as const, workspaceId: 'workspace-safe-id', privacyEpoch: 3, csrfToken: 'private-csrf' });
const media = Object.freeze({ mediaId: `still-media:${mediaId}`, sha256: 'a'.repeat(64), byteLength: 2048,
  durationSeconds: 1.25, format: 'm4a', mimeType: 'audio/mp4' });
const historyEntry = Object.freeze({ uploadId, capture: Object.freeze({ id: captureId, revision: captureRevision,
  capturedAt: capture.capturedAt, timeZone: capture.timeZone }), status: 'ready', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_001_000 });

function receipt(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, uploadId, status,
    capture: { ...capture, revision: captureRevision }, ...extra };
}

function response(value: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function makeClient(fetcher: AudioFetchLike, assertCurrent: () => void = () => undefined, timeoutMs = 10,
  makeId = () => uploadId) {
  return createWebAudioUploadClient(session, { assertCurrent, fetcher, timeoutMs, makeUploadId: makeId });
}

function blob(): Blob { return new Blob(['private audio bytes'], { type: 'audio/mp4' }); }
function codecBlob(): Blob { return new Blob(['private audio bytes'], { type: 'audio/webm;codecs=opus' }); }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); });

describe('web audio upload transport', () => {
  it('posts the raw Blob once with the authenticated protocol headers and retains admission metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(receipt('ready', { media })));
    const client = makeClient(fetcher);
    const admitted = vi.fn();
    await expect(client.uploadClip({ blob: blob(), capture }, admitted)).resolves.toMatchObject({ status: 'ready' });
    expect(admitted).toHaveBeenCalledOnce();
    expect(admitted).toHaveBeenCalledWith({ uploadId, capture });
    expect(fetcher).toHaveBeenCalledOnce();
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe('/api/audio/uploads');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect(init.headers).toEqual({ 'Content-Type': 'audio/mp4', 'X-Still-CSRF': 'private-csrf',
      'X-Still-Upload-ID': uploadId, 'X-Still-Capture': JSON.stringify(capture) });
    expect(init.body).toBeInstanceOf(Blob);
    expect(await (init.body as Blob).text()).toBe('private audio bytes');
    expect(init).not.toHaveProperty('Content-Length');
    expect(client.getPendingUpload()).toBeUndefined();
    client.dispose();
  });

  it('passes browser recorder codec MIME values through unchanged when they match the server allowlist', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(receipt('ready', { media: { ...media, format: 'webm', mimeType: 'audio/webm' } })));
    const client = makeClient(fetcher);
    await client.uploadClip({ blob: codecBlob(), capture });
    expect(fetcher.mock.calls[0]?.[1].headers).toMatchObject({ 'Content-Type': 'audio/webm;codecs=opus' });
    client.dispose();
    const rejected = makeClient(vi.fn());
    await expect(rejected.uploadClip({ blob: new Blob(['x'], { type: 'audio/webm;codecs=vorbis' }), capture }))
      .rejects.toBeInstanceOf(AudioUploadNotStartedError);
    rejected.dispose();
  });

  it('admits only one active or unresolved write even under duplicate clicks', async () => {
    const responseWait = deferred<ReturnType<typeof response>>();
    const fetcher = vi.fn(() => responseWait.promise);
    const client = makeClient(fetcher);
    const first = client.uploadClip({ blob: blob(), capture });
    await expect(client.uploadClip({ blob: blob(), capture })).rejects.toMatchObject({ kind: 'busy' });
    expect(fetcher).toHaveBeenCalledOnce();
    responseWait.resolve(response(receipt('inspect_required')));
    await expect(first).resolves.toMatchObject({ status: 'inspect_required' });
    await expect(client.uploadClip({ blob: blob(), capture })).rejects.toMatchObject({ kind: 'busy', uploadId });
    client.dispose();
  });

  it('distinguishes callback/pre-fetch failures from synchronous fetch entry failures', async () => {
    const notSent = vi.fn();
    const client = makeClient(notSent);
    await expect(client.uploadClip({ blob: blob(), capture }, () => { throw new Error('callback'); }))
      .rejects.toBeInstanceOf(AudioUploadNotStartedError);
    expect(notSent).not.toHaveBeenCalled();
    expect(client.getPendingUpload()).toBeUndefined();
    client.dispose();

    const fetcher = vi.fn(() => { throw new Error('transport boundary'); });
    const dispatched = makeClient(fetcher);
    await expect(dispatched.uploadClip({ blob: blob(), capture })).rejects.toMatchObject({
      name: 'AudioUploadUnknownError', uploadId, reason: 'network',
    } satisfies Partial<AudioUploadUnknownError>);
    expect(dispatched.getPendingUpload()).toEqual({ uploadId, capture });
    dispatched.dispose();
  });

  it('keeps a lost acknowledgement pending until the exact read-only inspection resolves it', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValueOnce(response(receipt('consumed', { media, consumption: { commandId, noteId, noteRevision: 7 } })));
    const client = makeClient(fetcher);
    await expect(client.uploadClip({ blob: blob(), capture })).rejects.toBeInstanceOf(AudioUploadUnknownError);
    expect(client.getPendingUpload()).toEqual({ uploadId, capture });
    await expect(client.inspectUpload()).resolves.toMatchObject({ status: 'consumed', consumption: { noteId, noteRevision: 7 } });
    expect(fetcher.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      ['/api/audio/uploads', 'POST'], [`/api/audio/uploads/${uploadId}`, 'GET'],
    ]);
    expect(client.getPendingUpload()).toBeUndefined();
    client.dispose();
  });

  it('clears only an explicitly inspected failed outcome and holds receiving or inspect-required outcomes', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(response(receipt('receiving')))
      .mockResolvedValueOnce(response(receipt('failed')));
    const client = makeClient(fetcher);
    await expect(client.uploadClip({ blob: blob(), capture })).rejects.toBeInstanceOf(AudioUploadUnknownError);
    await expect(client.inspectUpload()).resolves.toMatchObject({ status: 'receiving' });
    expect(client.getPendingUpload()).toBeDefined();
    await expect(client.inspectUpload(uploadId)).resolves.toMatchObject({ status: 'failed' });
    expect(client.getPendingUpload()).toBeUndefined();
    client.dispose();
  });

  it('rejects mismatched receipt identity and capture metadata as unknown without releasing the hold', async () => {
    const wrongUpload = { ...receipt('ready', { media }), uploadId: '77777777-7777-4777-8777-777777777777' };
    const wrongCapture = receipt('ready', { media, capture: { ...capture, id: noteId, revision: captureRevision } });
    const fetcher = vi.fn().mockResolvedValueOnce(response(wrongUpload)).mockResolvedValueOnce(response(wrongCapture));
    const client = makeClient(fetcher);
    await expect(client.uploadClip({ blob: blob(), capture })).rejects.toMatchObject({ reason: 'malformed_acknowledgement' });
    expect(client.getPendingUpload()).toEqual({ uploadId, capture });
    await expect(client.inspectUpload()).rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingUpload()).toEqual({ uploadId, capture });
    client.dispose();
  });

  it('fences session changes and disposal after fetch and JSON awaits, even when the fetcher ignores abort', async () => {
    const bodyWait = deferred<unknown>();
    let current = true;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => bodyWait.promise });
    const client = makeClient(fetcher, () => { if (!current) throw new Error('stale'); });
    const upload = client.uploadClip({ blob: blob(), capture });
    current = false;
    bodyWait.resolve(receipt('ready', { media }));
    await expect(upload).rejects.toMatchObject({ kind: 'stale' });
    expect(client.getPendingUpload()).toBeDefined();
    client.dispose();

    const late = deferred<ReturnType<typeof response>>();
    const disposed = makeClient(vi.fn(() => late.promise));
    const pending = disposed.uploadClip({ blob: blob(), capture });
    const completion = expect(pending).rejects.toMatchObject({ kind: 'disposed' });
    disposed.dispose();
    late.resolve(response(receipt('ready', { media })));
    await completion;
  });

  it('serializes receipt reads against new writes and aborts a read on disposal', async () => {
    const delayed = deferred<ReturnType<typeof response>>();
    const fetcher = vi.fn(() => delayed.promise);
    const client = makeClient(fetcher);
    const read = client.inspectUpload(uploadId);
    await expect(client.uploadClip({ blob: blob(), capture })).rejects.toMatchObject({ kind: 'busy' });
    expect(fetcher).toHaveBeenCalledOnce();
    const completion = expect(read).rejects.toMatchObject({ kind: 'disposed' });
    client.dispose();
    delayed.resolve(response(receipt('failed')));
    await completion;
    expect(client.getPendingUpload()).toBeUndefined();
  });

  it('times out without retrying and keeps the pending identity when abort is ignored', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<ReturnType<typeof response>>(() => undefined));
    const client = makeClient(fetcher, () => undefined, 25);
    const upload = client.uploadClip({ blob: blob(), capture });
    const completion = expect(upload).rejects.toMatchObject({ name: 'AudioUploadUnknownError', reason: 'timeout', uploadId });
    await vi.advanceTimersByTimeAsync(26);
    await completion;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(client.getPendingUpload()).toEqual({ uploadId, capture });
    client.dispose();
  });

  it('rejects malformed, unknown-field, and status-inconsistent receipt projections', () => {
    expect(() => parseAudioUploadReceiptDTO(receipt('ready'))).toThrow();
    expect(() => parseAudioUploadReceiptDTO({ ...receipt('failed'), privateDetail: 'no' })).toThrow();
    expect(() => parseAudioUploadReceiptDTO(receipt('consumed', { media }))).toThrow();
    expect(() => parseAudioUploadReceiptDTO(receipt('ready', { media: { ...media, format: 'wav' } }))).toThrow();
    let getterCalled = false;
    const accessor = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { getterCalled = true; throw new Error('must not execute'); } });
    expect(() => parseAudioUploadReceiptDTO(accessor)).toThrow();
    expect(getterCalled).toBe(false);
  });

  it('binds decoder IDs and builds media paths only from a raw opaque UUID', () => {
    expect(() => parseAudioUploadReceiptDTO(receipt('failed'), commandId)).toThrow();
    expect(audioMediaUrl(mediaId)).toBe(`/api/audio/${mediaId}`);
    for (const id of ['../secret', 'https://example.test/a', 'still-media:66666666-6666-4666-8666-666666666666',
      '66666666-6666-4666-8666-66666666666/extra']) expect(() => audioMediaUrl(id)).toThrow();
  });

  it('lists durable metadata pages with same-origin GET and preserves an unknown pending upload', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValueOnce(response({ schemaVersion: 1, entries: [historyEntry], nextCursor: 'Y3Vyc29y' }))
      .mockResolvedValueOnce(response({ schemaVersion: 1, entries: [] }));
    const client = makeClient(fetcher);
    await expect(client.uploadClip({ blob: blob(), capture })).rejects.toBeInstanceOf(AudioUploadUnknownError);
    const pending = client.getPendingUpload();
    await expect(client.listUploads()).resolves.toMatchObject({ entries: [{ uploadId, status: 'ready' }], nextCursor: 'Y3Vyc29y' });
    await expect(client.listUploads('Y3Vyc29y')).resolves.toMatchObject({ entries: [] });
    expect(fetcher.mock.calls.slice(1).map(([path, init]) => [path, init.method, init.credentials, init.redirect, init.cache])).toEqual([
      ['/api/audio/upload-history', 'GET', 'same-origin', 'error', 'no-store'],
      ['/api/audio/upload-history?cursor=Y3Vyc29y', 'GET', 'same-origin', 'error', 'no-store'],
    ]);
    expect(client.getPendingUpload()).toBe(pending);
    expect(fetcher.mock.calls.every(([, init]) => init.method === 'POST' || init.method === 'GET')).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    client.dispose();
  });

  it('a new client can discover an old upload, then inspect its full receipt only on explicit selection', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ schemaVersion: 1, entries: [historyEntry] }))
      .mockResolvedValueOnce(response(receipt('ready', { media })));
    const reloadedClient = makeClient(fetcher);
    await expect(reloadedClient.listUploads()).resolves.toMatchObject({ entries: [{ uploadId, status: 'ready' }] });
    expect(reloadedClient.getPendingUpload()).toBeUndefined();
    await expect(reloadedClient.inspectUpload(uploadId)).resolves.toMatchObject({ uploadId, status: 'ready', media });
    expect(fetcher.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      ['/api/audio/upload-history', 'GET'], [`/api/audio/uploads/${uploadId}`, 'GET'],
    ]);
    reloadedClient.dispose();
  });

  it('rejects malformed history and fences owner changes and disposal without changing pending state', async () => {
    const malformed = { schemaVersion: 1, entries: [{ ...historyEntry, sha256: 'private' }] };
    const fetcher = vi.fn().mockResolvedValueOnce(response(malformed));
    const client = makeClient(fetcher);
    await expect(client.listUploads()).rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingUpload()).toBeUndefined();
    client.dispose();

    const lateBody = deferred<unknown>();
    let current = true;
    const stale = makeClient(vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => lateBody.promise }), () => {
      if (!current) throw new Error('stale');
    });
    const reading = stale.listUploads();
    current = false;
    lateBody.resolve({ schemaVersion: 1, entries: [historyEntry] });
    await expect(reading).rejects.toMatchObject({ kind: 'stale' });
    stale.dispose();

    const lateResponse = deferred<ReturnType<typeof response>>();
    const disposed = makeClient(vi.fn(() => lateResponse.promise));
    const disposedRead = disposed.listUploads();
    const result = expect(disposedRead).rejects.toMatchObject({ kind: 'disposed' });
    disposed.dispose();
    lateResponse.resolve(response({ schemaVersion: 1, entries: [historyEntry] }));
    await result;
  });

  it('rejects non-plain, accessor, duplicate, oversized and malformed cursor history projections', () => {
    expect(() => parseAudioUploadHistoryPageDTO({ schemaVersion: 1, entries: [], extra: true })).toThrow();
    expect(() => parseAudioUploadHistoryPageDTO({ schemaVersion: 1, entries: [historyEntry, historyEntry] })).toThrow();
    expect(() => parseAudioUploadHistoryPageDTO({ schemaVersion: 1, entries: [], nextCursor: 'bad=' })).toThrow();
    expect(() => parseAudioUploadHistoryPageDTO({ schemaVersion: 1, entries: Array.from({ length: 51 }, () => historyEntry) })).toThrow();
    let getterCalled = false;
    const accessor = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { getterCalled = true; throw new Error('must not execute'); } });
    Object.defineProperties(accessor, { entries: { value: [], enumerable: true } });
    expect(() => parseAudioUploadHistoryPageDTO(accessor)).toThrow();
    expect(getterCalled).toBe(false);
  });
});
