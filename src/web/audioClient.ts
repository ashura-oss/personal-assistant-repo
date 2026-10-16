/** Same-origin raw audio upload transport. It never adopts media into a note. */
import type { AuthenticatedSession } from './authClient';
import { parseAudioUploadReceiptDTO, type AudioUploadReceiptDTO } from '../cloud/audioUploadDto';
import { parseAudioUploadHistoryPageDTO, type AudioUploadHistoryPageDTO } from '../cloud/audioUploadHistoryDto';

export const AUDIO_REQUEST_TIMEOUT_MS = 60_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_MIME: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'audio/mp4': ['codecs=mp4a.40.2', 'codecs="mp4a.40.2"'],
  'audio/mpeg': [], 'audio/wav': [],
  'audio/webm': ['codecs=opus', 'codecs="opus"'],
  'audio/ogg': ['codecs=opus', 'codecs="opus"'],
});

export type AudioCapture = Readonly<{ id: string; capturedAt: string; timeZone: string }>;
export type PendingAudioUpload = Readonly<{ uploadId: string; capture: AudioCapture }>;
export type DownloadedAudio = Readonly<{ blob: Blob; filename: string }>;

type AudioResponse = Pick<Response, 'ok' | 'status' | 'json'> & Partial<Pick<Response, 'arrayBuffer' | 'headers'>>;
export type AudioFetchLike = (input: string, init: RequestInit) => Promise<AudioResponse>;
export type AudioClientOptions = Readonly<{
  /** Must fail when the authenticated owner, workspace, or privacy epoch is no longer current. */
  assertCurrent: () => void;
  fetcher?: AudioFetchLike;
  timeoutMs?: number;
  makeUploadId?: () => string;
}>;

export type AudioUploadClient = Readonly<{
  uploadClip(input: Readonly<{ blob: Blob; capture: AudioCapture }>, onAdmitted?: (pending: PendingAudioUpload) => void): Promise<AudioUploadReceiptDTO>;
  inspectUpload(uploadId?: string): Promise<AudioUploadReceiptDTO>;
  listUploads(cursor?: string): Promise<AudioUploadHistoryPageDTO>;
  downloadMedia(mediaId: string): Promise<DownloadedAudio>;
  getPendingUpload(): PendingAudioUpload | undefined;
  dispose(): void;
}>;

export class AudioClientError extends Error {
  readonly name: string = 'AudioClientError';
  constructor(readonly kind: 'not_started' | 'unknown' | 'http' | 'network' | 'timeout' | 'malformed' | 'busy' | 'stale' | 'disposed',
    message: string, readonly uploadId?: string, readonly status?: number) { super(message); }
}

export class AudioUploadUnknownError extends AudioClientError {
  override readonly name = 'AudioUploadUnknownError';
  constructor(uploadId: string, readonly reason: 'network' | 'timeout' | 'http' | 'malformed_acknowledgement') {
    super('unknown', 'The audio upload outcome is unknown. Inspect its receipt before continuing.', uploadId);
  }
}

export class AudioUploadNotStartedError extends AudioClientError {
  override readonly name = 'AudioUploadNotStartedError';
  constructor(message = 'The audio upload was not sent.') { super('not_started', message); }
}

function defaultFetch(): AudioFetchLike {
  if (typeof globalThis.fetch !== 'function') return async () => { throw new Error('fetch_unavailable'); };
  return globalThis.fetch.bind(globalThis) as AudioFetchLike;
}

function secureUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('secure_uuid_unavailable');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateCapture(capture: AudioCapture): AudioCapture {
  if (!capture || typeof capture !== 'object' || !UUID_V4.test(capture.id) ||
      typeof capture.capturedAt !== 'string' || !Number.isFinite(Date.parse(capture.capturedAt)) ||
      new Date(Date.parse(capture.capturedAt)).toISOString() !== capture.capturedAt ||
      typeof capture.timeZone !== 'string' || capture.timeZone.length < 1 || capture.timeZone.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(capture.timeZone)) throw new AudioUploadNotStartedError('The audio capture metadata is invalid.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: capture.timeZone }).format(0); }
  catch { throw new AudioUploadNotStartedError('The audio capture metadata is invalid.'); }
  return Object.freeze({ id: capture.id, capturedAt: capture.capturedAt, timeZone: capture.timeZone });
}

function assertSession(session: AuthenticatedSession): void {
  if (!session || session.authenticated !== true || typeof session.workspaceId !== 'string' || !session.workspaceId ||
      !Number.isSafeInteger(session.privacyEpoch) || session.privacyEpoch < 0 ||
      typeof session.csrfToken !== 'string' || session.csrfToken.length === 0) {
    throw new AudioClientError('stale', 'An authenticated workspace session is required.');
  }
}

/** Private app transport for one authenticated workspace session. */
export function createWebAudioUploadClient(session: AuthenticatedSession, options: AudioClientOptions): AudioUploadClient {
  assertSession(session);
  const fetcher = options.fetcher ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? AUDIO_REQUEST_TIMEOUT_MS;
  let disposed = false;
  let generation = 0;
  let pending: PendingAudioUpload | undefined;
  let activeWrite = false;
  let activeController: AbortController | undefined;
  let activeRead = false;
  let activeReadController: AbortController | undefined;

  function assertUsable(ticket?: number): void {
    if (disposed) throw new AudioClientError('disposed', 'This audio client is no longer active.');
    if (ticket !== undefined && ticket !== generation) throw new AudioClientError('stale', 'The audio response is no longer current.');
    try { options.assertCurrent(); }
    catch { throw new AudioClientError('stale', 'The workspace session has changed.'); }
  }

  function parse(value: unknown, expectedUploadId: string, expectedCapture?: AudioCapture): AudioUploadReceiptDTO {
    let receipt: AudioUploadReceiptDTO;
    try { receipt = parseAudioUploadReceiptDTO(value, expectedUploadId); }
    catch { throw new AudioClientError('malformed', 'The audio receipt could not be confirmed.', expectedUploadId); }
    if (expectedCapture && (receipt.capture.id !== expectedCapture.id || receipt.capture.capturedAt !== expectedCapture.capturedAt ||
        receipt.capture.timeZone !== expectedCapture.timeZone)) {
      throw new AudioClientError('malformed', 'The audio receipt could not be confirmed.', expectedUploadId);
    }
    return receipt;
  }

  function validMime(value: string): boolean {
    if (value.length > 128) return false;
    const parts = value.split(';').map((part) => part.trim().toLowerCase());
    const base = parts[0];
    return !!base && Object.hasOwn(ALLOWED_MIME, base) && parts.length <= 2 &&
      (parts.length === 1 || ALLOWED_MIME[base]!.includes(parts[1]!));
  }

  async function sendUpload(input: Readonly<{ blob: Blob; capture: AudioCapture }>, admitted?: (value: PendingAudioUpload) => void): Promise<AudioUploadReceiptDTO> {
    assertUsable();
    if (pending || activeWrite || activeRead) throw new AudioClientError('busy', 'Inspect the pending audio upload before another capture.', pending?.uploadId);
    let attempted: PendingAudioUpload;
    let blob: Blob;
    try {
      if (!input || !(input.blob instanceof Blob) || input.blob.size <= 0 || !validMime(input.blob.type)) throw new Error('blob_invalid');
      blob = input.blob;
      const capture = validateCapture(input.capture);
      const uploadId = (options.makeUploadId ?? secureUuid)();
      if (!UUID_V4.test(uploadId)) throw new Error('upload_id_invalid');
      attempted = Object.freeze({ uploadId, capture });
    } catch { throw new AudioUploadNotStartedError('The audio upload could not be prepared, so it was not sent.'); }
    pending = attempted;
    try { admitted?.(attempted); }
    catch { pending = undefined; throw new AudioUploadNotStartedError('The audio upload was not sent because admission was declined.'); }
    activeWrite = true;
    const ticket = generation;
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    let timeoutReject!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => { timeoutReject = reject; });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); timeoutReject(new Error('timeout')); }, timeoutMs);
    try {
      try { assertUsable(ticket); } catch { pending = undefined; throw new AudioUploadNotStartedError('The audio upload was not sent because the workspace changed.'); }
      // Set the boundary before invoking fetcher, since it may synchronously throw after request admission.
      let responsePromise: Promise<AudioResponse>;
      try {
        responsePromise = fetcher('/api/audio/uploads', {
          method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: {
            'Content-Type': blob.type,
            'X-Still-CSRF': session.csrfToken,
            'X-Still-Upload-ID': attempted.uploadId,
            'X-Still-Capture': JSON.stringify(attempted.capture),
          },
          body: blob,
        });
      } catch { throw new AudioUploadUnknownError(attempted.uploadId, 'network'); }
      const response = await Promise.race([responsePromise, timeoutPromise]);
      assertUsable(ticket);
      if (!response.ok) throw new AudioUploadUnknownError(attempted.uploadId, 'http');
      let body: unknown;
      try { body = await Promise.race([response.json(), timeoutPromise]); }
      catch {
        if (timedOut) throw new AudioUploadUnknownError(attempted.uploadId, 'timeout');
        throw new AudioUploadUnknownError(attempted.uploadId, 'malformed_acknowledgement');
      }
      assertUsable(ticket);
      let receipt: AudioUploadReceiptDTO;
      try { receipt = parseAudioUploadReceiptDTO(body, attempted.uploadId); }
      catch { throw new AudioUploadUnknownError(attempted.uploadId, 'malformed_acknowledgement'); }
      if (receipt.capture.id !== attempted.capture.id || receipt.capture.capturedAt !== attempted.capture.capturedAt ||
          receipt.capture.timeZone !== attempted.capture.timeZone) {
        throw new AudioUploadUnknownError(attempted.uploadId, 'malformed_acknowledgement');
      }
      assertUsable(ticket);
      if (receipt.status === 'ready' && pending?.uploadId === attempted.uploadId) pending = undefined;
      return receipt;
    } catch (error) {
      if (error instanceof AudioClientError) throw error;
      if (disposed || ticket !== generation) throw new AudioClientError('stale', 'The audio response is no longer current.');
      if (timedOut) throw new AudioUploadUnknownError(attempted.uploadId, 'timeout');
      throw new AudioUploadUnknownError(attempted.uploadId, 'network');
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = undefined;
      activeWrite = false;
    }
  }

  async function inspectUpload(uploadId?: string): Promise<AudioUploadReceiptDTO> {
    assertUsable();
    if (activeWrite || activeRead) throw new AudioClientError('busy', 'Wait for the audio upload request before inspecting it.', pending?.uploadId);
    const held = pending;
    const selected = uploadId ?? held?.uploadId;
    if (!selected || !UUID_V4.test(selected) || (held && selected !== held.uploadId)) {
      throw new AudioClientError('malformed', 'The selected audio receipt cannot be inspected.', held?.uploadId);
    }
    const ticket = generation;
    const controller = new AbortController();
    activeRead = true;
    activeReadController = controller;
    let timedOut = false;
    let rejectTimeout!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout(new Error('timeout')); }, timeoutMs);
    try {
      const response = await Promise.race([fetcher(`/api/audio/uploads/${selected}`, {
        method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      }), timeoutPromise]);
      assertUsable(ticket);
      if (!response.ok) throw new AudioClientError('http', 'The audio receipt could not be read.', selected, response.status);
      const body = await Promise.race([response.json(), timeoutPromise]);
      assertUsable(ticket);
      const receipt = parse(body, selected, held?.capture);
      if (held && ['ready', 'failed', 'consumed', 'discarded'].includes(receipt.status) && pending?.uploadId === held.uploadId) pending = undefined;
      return receipt;
    } catch (error) {
      if (error instanceof AudioClientError) throw error;
      if (timedOut) throw new AudioClientError('timeout', 'The audio receipt read timed out.', selected);
      throw new AudioClientError('network', 'The audio receipt could not be read.', selected);
    } finally {
      clearTimeout(timeout);
      if (activeReadController === controller) activeReadController = undefined;
      activeRead = false;
    }
  }

  async function listUploads(cursor?: string): Promise<AudioUploadHistoryPageDTO> {
    assertUsable();
    if (activeWrite || activeRead) throw new AudioClientError('busy', 'Wait for the audio upload request before reading upload history.', pending?.uploadId);
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
      throw new AudioClientError('malformed', 'The selected audio history page cannot be read.');
    }
    const ticket = generation;
    const controller = new AbortController();
    activeRead = true;
    activeReadController = controller;
    let timedOut = false;
    let rejectTimeout!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout(new Error('timeout')); }, timeoutMs);
    const path = cursor === undefined ? '/api/audio/upload-history' : `/api/audio/upload-history?cursor=${encodeURIComponent(cursor)}`;
    try {
      const response = await Promise.race([fetcher(path, {
        method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      }), timeoutPromise]);
      assertUsable(ticket);
      if (!response.ok) throw new AudioClientError('http', 'Audio upload history could not be read.', undefined, response.status);
      const body = await Promise.race([response.json(), timeoutPromise]);
      assertUsable(ticket);
      try { return parseAudioUploadHistoryPageDTO(body); }
      catch { throw new AudioClientError('malformed', 'Audio upload history could not be confirmed.'); }
    } catch (error) {
      if (error instanceof AudioClientError) throw error;
      if (disposed || ticket !== generation) throw new AudioClientError('disposed', 'This audio client is no longer active.');
      if (timedOut) throw new AudioClientError('timeout', 'Audio upload history read timed out.');
      throw new AudioClientError('network', 'Audio upload history could not be read.');
    } finally {
      clearTimeout(timeout);
      if (activeReadController === controller) activeReadController = undefined;
      activeRead = false;
    }
  }

  async function downloadMedia(mediaId: string): Promise<DownloadedAudio> {
    assertUsable();
    if (!UUID_V4.test(mediaId)) throw new AudioClientError('malformed', 'The recording reference is invalid.');
    if (activeWrite || activeRead) throw new AudioClientError('busy', 'Wait for the current audio request before downloading a recording.');
    activeRead = true;
    const ticket = generation;
    const controller = new AbortController();
    activeReadController = controller;
    let timedOut = false;
    let timeoutReject!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => { timeoutReject = reject; });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); timeoutReject(new Error('timeout')); }, timeoutMs);
    try {
      assertUsable(ticket);
      const response = await Promise.race([fetcher(`/api/audio/${encodeURIComponent(mediaId)}?download=1`, {
        method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      }), timeoutPromise]);
      assertUsable(ticket);
      if (!response.ok) throw new AudioClientError('http', response.status === 404 ? 'This recording is no longer available.' : 'The recording could not be downloaded.', undefined, response.status);
      if (typeof response.arrayBuffer !== 'function' || !response.headers) throw new AudioClientError('malformed', 'The recording response could not be confirmed.');
      const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (!mime || !['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg'].includes(mime)) {
        throw new AudioClientError('malformed', 'The recording response could not be confirmed.');
      }
      const bytes = await Promise.race([response.arrayBuffer(), timeoutPromise]);
      assertUsable(ticket);
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = /^attachment; filename="([A-Za-z0-9 _.-]{1,72}\.(?:m4a|mp3|wav|webm|ogg))"$/i.exec(disposition)?.[1];
      if (!filename) throw new AudioClientError('malformed', 'The recording download filename could not be confirmed.');
      return Object.freeze({ blob: new Blob([bytes], { type: mime }), filename });
    } catch (error) {
      if (error instanceof AudioClientError) throw error;
      if (timedOut) throw new AudioClientError('timeout', 'The recording download timed out.');
      if (controller.signal.aborted) throw new AudioClientError('disposed', 'The recording download was cancelled.');
      throw new AudioClientError('network', 'The recording could not be downloaded.');
    } finally {
      clearTimeout(timeout);
      if (activeReadController === controller) activeReadController = undefined;
      activeRead = false;
    }
  }

  return Object.freeze({
    uploadClip: sendUpload,
    inspectUpload,
    listUploads,
    downloadMedia,
    getPendingUpload: () => pending,
    dispose: () => { if (disposed) return; disposed = true; generation += 1; activeController?.abort(); activeController = undefined;
      activeReadController?.abort(); activeReadController = undefined; activeRead = false; activeWrite = false; pending = undefined; },
  });
}
