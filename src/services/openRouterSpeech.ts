import { SPEECH_MAX_AUDIO_BYTES, SPEECH_MAX_RESPONSE_BYTES } from '../transcription';
import {
  OPENROUTER_SPEECH_ENDPOINT,
  OPENROUTER_SPEECH_MODEL,
  parseOpenRouterSpeechResponse,
  type OpenRouterSpeechParseResult,
  type OpenRouterSpeechUsage,
  type OpenRouterSpeechWireRequest,
} from './openRouterSpeechWire';

export const OPENROUTER_SPEECH_REQUEST_DEADLINE_MS = 120_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface OpenRouterSpeechCredentialSnapshot {
  readonly key: string | null;
  readonly generation: number;
}

export type OpenRouterSpeechErrorCode =
  | 'invalid_request' | 'pre_dispatch' | 'credential_missing' | 'stale_credential'
  | 'cancelled' | 'timeout' | 'provider_rejected' | 'provider_unknown' | 'response_too_large';

export class OpenRouterSpeechError extends Error {
  readonly name = 'OpenRouterSpeechError';
  constructor(
    message: string,
    readonly code: OpenRouterSpeechErrorCode,
    readonly dispatched: boolean,
    readonly unknownCharge: boolean,
    readonly usage?: OpenRouterSpeechUsage,
    options?: ErrorOptions,
  ) { super(message, options); }
}

export interface OpenRouterSpeechClientDependencies {
  /** Owns the complete request and response callback until it actually settles. */
  readonly withRequestOwnership: <T>(actualRequest: () => Promise<T>) => Promise<T>;
  /** Production transports keep their response private and await actual cancellation acknowledgement. */
  readonly withResponseLifetime?: <T>(
    input: string,
    init: RequestInit,
    consumeResponse: (response: Response) => Promise<T>,
    onCancelPending?: (retryCancel: () => Promise<void>) => void,
    beforeStart?: () => void,
  ) => Promise<T>;
  /** Closed tests and non-native platforms may provide an ordinary fetcher. */
  readonly fetcher?: typeof fetch;
  readonly readCredentialSnapshot: () => Promise<OpenRouterSpeechCredentialSnapshot>;
  readonly assertCredentialGeneration: (expectedGeneration: number) => void;
  /** Synchronous, source-and-workspace fence immediately before the one POST. */
  readonly assertBeforeStart: () => void;
  readonly onCancelPending?: (operationId: string, retryCancel: () => Promise<void>) => void;
  readonly deadlineMs?: number;
}

export interface OpenRouterSpeechCall {
  readonly operationId: string;
  readonly request: OpenRouterSpeechWireRequest;
  readonly signal?: AbortSignal;
  /** Persist the one attempt before the provider writer or HTTP request is acquired. */
  readonly onBeforeDispatch: () => Promise<void>;
  /** Synchronous workspace/source fence after credential read and immediately before dispatch. */
  readonly assertBeforeStart?: () => void;
}

/** One fixed OpenRouter transcription POST. This client never retries, chunks, or estimates duration/cost. */
export class OpenRouterSpeechClient {
  private readonly pendingCleanup = new Map<string, () => Promise<void>>();
  private readonly cleanupRuns = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: OpenRouterSpeechClientDependencies) {}

  async transcribe(call: OpenRouterSpeechCall): Promise<OpenRouterSpeechParseResult> {
    const operationId = call?.operationId;
    const suppliedRequest = call?.request;
    const signal = call?.signal;
    const onBeforeDispatch = call?.onBeforeDispatch;
    if (!isUuidV4(operationId) || !validateWireRequest(suppliedRequest) || typeof onBeforeDispatch !== 'function') {
      throw new OpenRouterSpeechError('The prepared speech request is invalid.', 'invalid_request', false, false);
    }
    const request = Object.freeze({ endpoint: suppliedRequest.endpoint, body: suppliedRequest.body, audioBytes: suppliedRequest.audioBytes });
    const deadlineMs = this.dependencies.deadlineMs ?? OPENROUTER_SPEECH_REQUEST_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > OPENROUTER_SPEECH_REQUEST_DEADLINE_MS) {
      throw new OpenRouterSpeechError('The speech request could not be started.', 'pre_dispatch', false, false);
    }
    if (signal?.aborted) throw new OpenRouterSpeechError('Speech transcription was cancelled before upload.', 'cancelled', false, false);

    let credential: OpenRouterSpeechCredentialSnapshot;
    try {
      credential = await this.dependencies.readCredentialSnapshot();
      if (!validCredentialSnapshot(credential)) throw new Error('invalid credential snapshot');
      this.assertCredentialGeneration(credential.generation);
      if (!credential.key) throw new OpenRouterSpeechError('Configure an OpenRouter API key before transcribing.', 'credential_missing', false, false);
      await onBeforeDispatch();
      if (signal?.aborted) throw new OpenRouterSpeechError('Speech transcription was cancelled before upload.', 'cancelled', false, false);
      this.assertCredentialGeneration(credential.generation);
    } catch (error) {
      if (error instanceof OpenRouterSpeechError) throw error;
      throw new OpenRouterSpeechError('Speech transcription could not be prepared. No provider request was started.', 'pre_dispatch', false, false, undefined, { cause: error });
    }

    let dispatched = false;
    let timedOut = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortController: AbortController | undefined;
    let removeCallerAbort: (() => void) | undefined;
    let actualUsage: OpenRouterSpeechUsage | undefined;

    try {
      return await this.dependencies.withRequestOwnership(async () => {
        abortController = new AbortController();
        const onCallerAbort = () => {
          cancelled = true;
          abortController?.abort();
        };
        if (signal) {
          signal.addEventListener('abort', onCallerAbort, { once: true });
          removeCallerAbort = () => signal.removeEventListener('abort', onCallerAbort);
          if (signal.aborted) onCallerAbort();
        }
        timer = setTimeout(() => {
          timedOut = true;
          abortController?.abort();
        }, deadlineMs);

        const beforeStart = () => {
          if (timedOut) throw new OpenRouterSpeechError('Speech transcription timed out before upload.', 'timeout', false, false);
          if (cancelled || signal?.aborted) throw new OpenRouterSpeechError('Speech transcription was cancelled before upload.', 'cancelled', false, false);
          this.assertCredentialGeneration(credential.generation);
          this.dependencies.assertBeforeStart();
          call.assertBeforeStart?.();
          dispatched = true;
        };
        const consume = async (response: Response): Promise<OpenRouterSpeechParseResult> => {
          const bytes = await readBoundedResponseBytes(response);
          let json: unknown;
          try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
          catch {
            if (response.status !== 200) throw new OpenRouterSpeechError('OpenRouter rejected the speech request.', 'provider_rejected', true, true);
            return Object.freeze({ kind: 'invalid', code: 'invalid_response' });
          }
          const parsed = parseOpenRouterSpeechResponse(json);
          actualUsage = parsed.usage;
          if (response.status !== 200) {
            throw new OpenRouterSpeechError('OpenRouter rejected the speech request.', 'provider_rejected', true, true, parsed.usage);
          }
          if (timedOut) throw new OpenRouterSpeechError('Speech transcription timed out; the provider may have received the audio.', 'timeout', true, true, parsed.usage);
          if (cancelled || signal?.aborted) throw new OpenRouterSpeechError('Speech transcription was cancelled; the provider may have received the audio.', 'cancelled', true, true, parsed.usage);
          return parsed;
        };

        try {
          if (this.dependencies.withResponseLifetime) {
            const parsed = await this.dependencies.withResponseLifetime(request.endpoint, {
              method: 'POST', redirect: 'error', signal: abortController.signal,
              headers: { Authorization: `Bearer ${credential.key}`, 'Content-Type': 'application/json' },
              body: request.body,
            }, consume, (retryCancel) => this.rememberCleanup(operationId, retryCancel), beforeStart);
            if (timedOut) throw new OpenRouterSpeechError('Speech transcription timed out; the provider may have received the audio.', 'timeout', dispatched, dispatched, parsed.usage);
            if (cancelled || signal?.aborted) throw new OpenRouterSpeechError('Speech transcription was cancelled; the provider may have received the audio.', 'cancelled', dispatched, dispatched, parsed.usage);
            return parsed;
          }
          if (!this.dependencies.fetcher) throw new Error('Speech transport unavailable');
          beforeStart();
          const response = await this.dependencies.fetcher(request.endpoint, {
            method: 'POST', redirect: 'error', signal: abortController.signal,
            headers: { Authorization: `Bearer ${credential.key}`, 'Content-Type': 'application/json' },
            body: request.body,
          });
          const parsed = await consume(response);
          if (timedOut) throw new OpenRouterSpeechError('Speech transcription timed out; the provider may have received the audio.', 'timeout', dispatched, dispatched, parsed.usage);
          if (cancelled || signal?.aborted) throw new OpenRouterSpeechError('Speech transcription was cancelled; the provider may have received the audio.', 'cancelled', dispatched, dispatched, parsed.usage);
          return parsed;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          removeCallerAbort?.();
        }
      });
    } catch (error) {
        if (error instanceof OpenRouterSpeechError) {
        if (error.usage || !actualUsage) throw error;
        throw new OpenRouterSpeechError(error.message, error.code, error.dispatched, error.unknownCharge, actualUsage, { cause: error });
      }
      if (timedOut) throw new OpenRouterSpeechError('Speech transcription timed out; the provider may have received the audio.', 'timeout', dispatched, dispatched, actualUsage, { cause: error });
      if (cancelled || signal?.aborted) throw new OpenRouterSpeechError('Speech transcription was cancelled; the provider may have received the audio.', 'cancelled', dispatched, dispatched, actualUsage, { cause: error });
      if (error instanceof ResponseTooLargeError) throw new OpenRouterSpeechError('The speech response exceeded the 1 MiB limit.', 'response_too_large', dispatched, dispatched, actualUsage, { cause: error });
      if (!dispatched) throw new OpenRouterSpeechError('Speech transcription could not be started. No provider request was sent.', 'pre_dispatch', false, false, undefined, { cause: error });
      throw new OpenRouterSpeechError('Speech transcription failed; the provider may have received the audio.', 'provider_unknown', true, true, actualUsage, { cause: error });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeCallerAbort?.();
    }
  }

  async retryPendingCleanup(operationId: string): Promise<void> {
    const retry = this.pendingCleanup.get(operationId);
    if (!retry) return;
    const active = this.cleanupRuns.get(operationId);
    if (active) return active;
    const run = retry().then(() => {
      if (this.pendingCleanup.get(operationId) === retry) this.pendingCleanup.delete(operationId);
    }).finally(() => {
      if (this.cleanupRuns.get(operationId) === run) this.cleanupRuns.delete(operationId);
    });
    this.cleanupRuns.set(operationId, run);
    return run;
  }

  private rememberCleanup(operationId: string, retryCancel: () => Promise<void>): void {
    this.pendingCleanup.set(operationId, retryCancel);
    try { this.dependencies.onCancelPending?.(operationId, retryCancel); } catch { /* The same retry handle remains available locally. */ }
  }

  private assertCredentialGeneration(expectedGeneration: number): void {
    try { this.dependencies.assertCredentialGeneration(expectedGeneration); }
    catch (error) { throw new OpenRouterSpeechError('The OpenRouter credential changed before speech dispatch.', 'stale_credential', false, false, undefined, { cause: error }); }
  }
}

class ResponseTooLargeError extends Error {}

function validCredentialSnapshot(value: unknown): value is OpenRouterSpeechCredentialSnapshot {
  return !!value && typeof value === 'object' &&
    (value as OpenRouterSpeechCredentialSnapshot).key !== undefined &&
    ((value as OpenRouterSpeechCredentialSnapshot).key === null || typeof (value as OpenRouterSpeechCredentialSnapshot).key === 'string') &&
    Number.isSafeInteger((value as OpenRouterSpeechCredentialSnapshot).generation) &&
    (value as OpenRouterSpeechCredentialSnapshot).generation >= 0;
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID_V4.test(value);
}

function validateWireRequest(value: unknown): value is OpenRouterSpeechWireRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'audioBytes,body,endpoint' || row.endpoint !== OPENROUTER_SPEECH_ENDPOINT ||
      typeof row.body !== 'string' || !Number.isSafeInteger(row.audioBytes) || (row.audioBytes as number) < 1 || (row.audioBytes as number) > SPEECH_MAX_AUDIO_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (JSON.stringify(parsed) !== row.body || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const body = parsed as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'input_audio,model,provider,response_format' || body.model !== OPENROUTER_SPEECH_MODEL || body.response_format !== 'json') return false;
    const audio = body.input_audio;
    const provider = body.provider;
    if (!audio || typeof audio !== 'object' || Array.isArray(audio) || !provider || typeof provider !== 'object' || Array.isArray(provider)) return false;
    const audioRow = audio as Record<string, unknown>;
    const providerRow = provider as Record<string, unknown>;
    if (Object.keys(audioRow).sort().join(',') !== 'data,format' || Object.keys(providerRow).sort().join(',') !== 'data_collection,zdr' ||
        providerRow.zdr !== true || providerRow.data_collection !== 'deny' ||
        typeof audioRow.data !== 'string' || !isBase64(audioRow.data) ||
        typeof audioRow.format !== 'string' || !['m4a', 'wav', 'mp3', 'webm', 'ogg'].includes(audioRow.format)) return false;
    const padding = audioRow.data.endsWith('==') ? 2 : audioRow.data.endsWith('=') ? 1 : 0;
    const decodedLength = audioRow.data.length / 4 * 3 - padding;
    return decodedLength === row.audioBytes && new TextEncoder().encode(row.body).byteLength <= Math.ceil((row.audioBytes as number) / 3) * 4 + 1024;
  } catch { return false; }
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const contentLength = value.length - padding;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAlpha = code >= 65 && code <= 90 || code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (index < contentLength) {
      if (!isAlpha && !isDigit && code !== 43 && code !== 47) return false;
    } else if (code !== 61) return false;
  }
  return padding === 0 || padding === 1 && contentLength % 4 === 3 || padding === 2 && contentLength % 4 === 2;
}

async function readBoundedResponseBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > SPEECH_MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  const reader = response.body?.getReader?.();
  let bytes: Uint8Array;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!(item.value instanceof Uint8Array)) throw new Error('invalid response bytes');
        total += item.value.byteLength;
        if (total > SPEECH_MAX_RESPONSE_BYTES) throw new ResponseTooLargeError();
        chunks.push(item.value);
      }
    } catch (error) {
      try { await reader.cancel(error); } catch { /* The platform lifetime still awaits its native request cancellation. */ }
      throw error;
    } finally { try { reader.releaseLock(); } catch { /* Already released by the stream. */ } }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } else {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > SPEECH_MAX_RESPONSE_BYTES) throw new ResponseTooLargeError();
    bytes = body;
  }
  return bytes;
}
