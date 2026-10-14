import type { AppSettings, Note } from '../core';
import type { PreparedSpeechAudio, SpeechAudioService } from '../audio/speechUpload.types';
import { SPEECH_MAX_AUDIO_BYTES, SPEECH_MAX_AUDIO_SECONDS, SPEECH_MAX_RESPONSE_BYTES, SPEECH_MAX_TRANSCRIPT_BYTES, SpeechTranscriptionError, validateSpeechAudioSnapshot, type SpeechTranscriptionResult } from '../transcription/types';
import type { ProviderResponseLifetime } from './providerResponseLifetime.shared';
import { SpeechCredentialChangedError } from './speechCredentialChangedError';
import { validateAzureEndpoint } from './controllerRuntimeContracts';

export { SpeechCredentialChangedError } from './speechCredentialChangedError';

export type FetchLike = typeof fetch;
const SPEECH_API_VERSION = '2025-10-15';
const SPEECH_PREPARATION_STEP_MS = 10_000;

export interface AzureSpeechSharedPorts {
  readonly fetcher: FetchLike;
  readonly audio: SpeechAudioService;
  readonly readKeySnapshot: (capturedGeneration: number) => Promise<{ key: string | null; generation: number }>;
  readonly currentCredentialGeneration: () => number;
  readonly assertCredentialGeneration: (generation: number) => void;
  readonly randomUUID: () => string;
  readonly withRequestOwnership: <T>(actualRequest: () => Promise<T>) => Promise<T>;
  readonly withResponseLifetime: ProviderResponseLifetime;
  readonly deadlineMs?: number;
}

function boundedSpeechPreparationStep<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Speech preparation was cancelled.'));
  let operation: Promise<T>;
  try { operation = Promise.resolve(start()); }
  catch (error) { operation = Promise.reject(error); }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    const onAbort = () => finish(signal?.reason ?? new Error('Speech preparation was cancelled.'));
    const timer = setTimeout(() => finish(new Error('Speech preparation exceeded its 10 second limit.')), SPEECH_PREPARATION_STEP_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => finish(undefined, value), (error) => finish(error));
  });
}


export class SharedAzureSpeechClient {
  private readonly audio: SpeechAudioService;
  private rawPostInFlight = false;
  private activeRawLeaseId?: string;
  private readonly leaseReleasePromises = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private readonly options: AzureSpeechSharedPorts) {
    this.audio = options.audio;
  }

  /** Retry cleanup for a durable lease, but never remove bytes owned by an unsettled raw request. */
  releaseUploadLease(leaseId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseId)) return Promise.reject(new Error('Speech upload lease is invalid.'));
    if (this.activeRawLeaseId === leaseId) return Promise.reject(new Error('The raw speech upload still owns this audio lease.'));
    const current = this.leaseReleasePromises.get(leaseId);
    if (current) return current;
    const operation = this.audio.release(leaseId).finally(() => {
      if (this.leaseReleasePromises.get(leaseId) === operation) this.leaseReleasePromises.delete(leaseId);
    });
    this.leaseReleasePromises.set(leaseId, operation);
    return operation;
  }

  /** Discards private staged bytes synchronously; in-flight native promises retain their own leases. */
  disposeMemory(): void {
    this.disposed = true;
    this.audio.disposeMemory?.();
  }

  /** One bounded request. A sent request is never automatically retried. */
  async transcribe(
    note: Note,
    settings: AppSettings,
    signal?: AbortSignal,
    onAttempt?: (prepared: PreparedSpeechAudio) => Promise<void>,
    beforeDispatch?: (prepared: PreparedSpeechAudio) => void,
    onPrepared?: (prepared: PreparedSpeechAudio) => Promise<void> | void,
    suppliedLeaseId?: string,
  ): Promise<SpeechTranscriptionResult> {
    const fail = (message: string, code: ConstructorParameters<typeof SpeechTranscriptionError>[1] = 'pre_dispatch'): never => { throw new SpeechTranscriptionError(message, code, false); };
    if (this.disposed) fail('Speech upload staging is no longer available in this workspace.', 'pre_dispatch');
    if (this.rawPostInFlight) fail('A previous speech upload is still settling. Wait before starting another upload.', 'pre_dispatch');
    if (signal?.aborted) fail('Speech transcription was cancelled before upload.', 'cancelled');
    if (!note.audioUri) fail('This note has no recorded audio to transcribe.', 'invalid_audio');
    if (note.audioAttachment?.durationStatus === 'unknown') fail('This replacement recording has no verified duration and cannot be uploaded.', 'invalid_audio');
    const configuredSpeech = (settings as AppSettings & { speechEnabled?: boolean }).speechEnabled;
    if (configuredSpeech !== true) fail('Enable Azure Speech in Settings before transcribing.', 'pre_dispatch');
    const sourceDuration = note.audioAttachment?.durationStatus === 'known' ? note.audioAttachment.durationSeconds : note.durationSeconds;
    if (typeof sourceDuration !== 'number' || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > Math.min(settings.maxAudioSeconds, SPEECH_MAX_AUDIO_SECONDS)) fail('Recording duration is outside the configured upload limit.', 'invalid_audio');
    const configuredEndpoint = settings.speechEndpoint;
    if (!configuredEndpoint) fail('Add an Azure Speech endpoint before transcribing.', 'pre_dispatch');
    let endpoint = '';
    try { endpoint = validateAzureEndpoint(configuredEndpoint as string, 'speech'); }
    catch (error) { fail(error instanceof Error ? error.message : 'The Azure Speech endpoint is invalid.', 'pre_dispatch'); }
    if (!Number.isFinite(settings.maxAudioSeconds) || settings.maxAudioSeconds <= 0) fail('The configured audio limit is invalid.', 'invalid_audio');
    const leaseId = suppliedLeaseId ?? this.options.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseId)) fail('Speech upload lease is invalid.', 'invalid_audio');
    let prepared: PreparedSpeechAudio | undefined;
    let dispatched = false;
    let credentialReadStarted = false;
    let releasePromise: Promise<void> | undefined;
    let dispatchCleanup: Promise<void> | undefined;
    const release = () => releasePromise ??= prepared ? Promise.resolve().then(() => this.releaseUploadLease(prepared!.leaseId)) : Promise.resolve();
    try {
      prepared = await this.audio.prepare(note, { leaseId, maxDurationSeconds: Math.min(settings.maxAudioSeconds, SPEECH_MAX_AUDIO_SECONDS), signal });
      const snapshot = validateSpeechAudioSnapshot(prepared);
      if (snapshot.leaseId !== leaseId || snapshot.byteLength > SPEECH_MAX_AUDIO_BYTES) fail('Prepared audio does not match the requested lease or upload limit.', 'invalid_audio');
      await this.audio.verify(prepared, signal);
      await onPrepared?.(prepared);
      if (signal?.aborted) fail('Speech transcription was cancelled before upload.', 'cancelled');
      credentialReadStarted = true;
      const readGeneration = this.options.currentCredentialGeneration();
      let credentialSnapshot: { key: string | null; generation: number };
      try {
        credentialSnapshot = await boundedSpeechPreparationStep(() => this.options.readKeySnapshot(readGeneration), signal);
      } catch (error) {
        if (error instanceof SpeechCredentialChangedError) fail('The Azure Speech credential changed while upload was being prepared.', 'stale_credential');
        throw error;
      }
      credentialReadStarted = false;
      if (!credentialSnapshot.key) fail('Add an Azure Speech key in Settings before transcribing.', 'credential_missing');
      await onAttempt?.(prepared);
      await this.audio.verify(prepared, signal);
      if (signal?.aborted) fail('Speech transcription was cancelled before upload.', 'cancelled');
      const form = new FormData();
      if (prepared.platform === 'web') form.append('audio', prepared.upload.blob, prepared.upload.fileName);
      else form.append('audio', prepared.upload.part as unknown as Blob);
      form.append('definition', JSON.stringify({ locales: ['en-US'] }));
      if (this.rawPostInFlight) fail('Another speech upload started before this request could be dispatched.', 'pre_dispatch');
      const controller = new AbortController();
      const deadlineMs = this.options.deadlineMs ?? 120_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort: ((reason: unknown) => void) | undefined;
      let rejectDeadline: ((reason: unknown) => void) | undefined;
      const abort = () => controller.abort(signal?.reason ?? new Error('Speech transcription was cancelled.'));
      const onSignalAbort = () => { abort(); rejectAbort?.(signal?.reason ?? new Error('Speech transcription was cancelled.')); };
      const aborted = signal ? new Promise<never>((_, reject) => { rejectAbort = reject; }) : new Promise<never>(() => undefined);
      const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
      const responseLifetime = this.options.withResponseLifetime;
      const rawPromise = this.options.withRequestOwnership(async () => {
        // Reserve this client before platform normalization so parallel calls cannot race into admission.
        if (this.rawPostInFlight) fail('Another speech upload started before this request could be dispatched.', 'pre_dispatch');
        this.rawPostInFlight = true;
        this.activeRawLeaseId = leaseId;
        signal?.addEventListener('abort', onSignalAbort, { once: true });
        if (signal?.aborted) onSignalAbort();
        timer = setTimeout(() => { controller.abort(new Error('Speech transcription timed out.')); rejectDeadline?.(new SpeechDeadlineError()); }, deadlineMs);
        const beforeStart = () => {
          if (signal?.aborted) fail('Speech transcription was cancelled before upload.', 'cancelled');
          try { beforeDispatch?.(prepared!); }
          catch (error) { throw new SpeechTranscriptionError('The note, audio, settings, or claim changed before upload. No audio was sent.', 'pre_dispatch', false, undefined, { cause: error }); }
          try { this.options.assertCredentialGeneration(credentialSnapshot.generation); }
          catch { fail('The Azure Speech credential changed before upload.', 'stale_credential'); }
          dispatched = true;
        };
        const consume = async (response: Response): Promise<{ transcript: string; durationMilliseconds: number | null }> => {
          if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* The actual request still settles before ownership is released. */ }
            throw new SpeechHttpResponseError(response.status);
          }
          try { return await readSpeechResponse(response); }
          catch (error) { if (error instanceof SpeechResponseError) throw error; throw new SpeechResponseError('Speech response could not be parsed.', undefined, { cause: error }); }
        };
        try {
          return await responseLifetime(`${endpoint}/speechtotext/transcriptions:transcribe?api-version=${SPEECH_API_VERSION}`, {
            method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': credentialSnapshot.key! }, body: form, signal: controller.signal, redirect: 'error',
          }, consume, undefined, beforeStart);
        } catch (error) {
          if (error instanceof SpeechTranscriptionError || error instanceof SpeechHttpResponseError || error instanceof SpeechResponseError) throw error;
          if (!dispatched) throw error;
          throw new SpeechNetworkError('Speech request could not be completed.');
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', onSignalAbort);
          this.rawPostInFlight = false;
          if (this.activeRawLeaseId === leaseId) this.activeRawLeaseId = undefined;
        }
      });
      const cleanupPromise = rawPromise.then(() => undefined, () => undefined).then(async () => {
        await release();
      });
      dispatchCleanup = cleanupPromise;
      void cleanupPromise.catch(() => undefined);
      const observedRaw = rawPromise.then((value) => ({ kind: 'value' as const, value }), (error) => ({ kind: 'error' as const, error }));
      let outcome: Awaited<typeof observedRaw>;
      try { outcome = await Promise.race([observedRaw, deadline, aborted]); }
      catch (error) {
        if (error instanceof SpeechDeadlineError) throw new SpeechTranscriptionError('Speech transcription timed out; the provider may have received the audio.', 'timeout', true, undefined, { cause: error }, cleanupPromise);
        if (signal?.aborted) throw new SpeechTranscriptionError('Speech transcription was cancelled after upload started; the provider may have received the audio.', 'cancelled', true, undefined, { cause: error }, cleanupPromise);
        throw new SpeechTranscriptionError('Speech provider request failed; its charge status is unknown.', 'provider_unknown', true, undefined, { cause: error }, cleanupPromise);
      }
      if (outcome.kind === 'error') {
        if (outcome.error instanceof SpeechTranscriptionError) throw outcome.error;
        if (!dispatched) throw new SpeechTranscriptionError('The upload could not start inside the local writer boundary. No audio was sent.', 'pre_dispatch', false, undefined, { cause: outcome.error }, cleanupPromise);
        if (outcome.error instanceof SpeechHttpResponseError) {
          const definite = outcome.error.status >= 400 && outcome.error.status < 500 && outcome.error.status !== 429;
          throw new SpeechTranscriptionError(`Azure Speech returned HTTP ${outcome.error.status}.`, definite ? 'provider_rejected' : 'provider_unknown', true, undefined, { cause: outcome.error }, cleanupPromise);
        }
        const responseDuration = outcome.error instanceof SpeechResponseError ? outcome.error.durationMilliseconds : undefined;
        const networkFailure = outcome.error instanceof SpeechNetworkError;
        throw new SpeechTranscriptionError(networkFailure ? 'Speech provider request failed; its charge status is unknown.' : 'Speech provider response was invalid; its charge status is unknown.', networkFailure ? 'provider_unknown' : 'invalid_response', true, responseDuration, { cause: outcome.error }, cleanupPromise);
      }
      const parsed = outcome.value;
      if (parsed.durationMilliseconds === null) throw new SpeechTranscriptionError('Azure Speech returned an invalid duration; billing cannot be verified.', 'provider_unknown', true, undefined, undefined, cleanupPromise);
      if (!parsed.transcript) throw new SpeechTranscriptionError('Azure Speech detected no speech. The audio note was left unchanged.', 'no_speech', true, parsed.durationMilliseconds, undefined, cleanupPromise);
      return Object.freeze({ transcript: parsed.transcript, durationMilliseconds: parsed.durationMilliseconds, durationSeconds: parsed.durationMilliseconds / 1000, billedEstimateSeconds: Math.ceil(parsed.durationMilliseconds / 1000), attempts: 1 as const, cleanupPromise: dispatchCleanup });
    } catch (error) {
      if (error instanceof SpeechTranscriptionError) {
        if (!dispatched) {
          const pendingCleanup = release();
          void pendingCleanup.catch(() => undefined);
          throw new SpeechTranscriptionError(error.message, error.code, false, error.durationMilliseconds, { cause: error }, pendingCleanup);
        }
        throw error;
      }
      if (dispatched) throw new SpeechTranscriptionError('Speech transcription failed; the provider may have received the audio.', 'provider_unknown', true, undefined, { cause: error }, dispatchCleanup);
      const code = signal?.aborted ? 'cancelled' : 'invalid_audio';
      const safeCode = signal?.aborted ? 'cancelled' : credentialReadStarted ? 'credential_missing' : code;
      const safeMessage = signal?.aborted
        ? 'Speech transcription was cancelled before upload.'
        : credentialReadStarted
          ? 'The local speech credential could not be read safely. No audio was sent.'
          : 'The audio file could not be safely prepared for upload. No audio was sent.';
      const failure = new SpeechTranscriptionError(safeMessage, safeCode, false, undefined, { cause: error });
      const pendingCleanup = release();
      void pendingCleanup.catch(() => undefined);
      throw new SpeechTranscriptionError(failure.message, failure.code, false, undefined, { cause: failure }, pendingCleanup);
    }
  }
}

class SpeechHttpResponseError extends Error { constructor(readonly status: number) { super(`Speech HTTP ${status}`); } }
class SpeechDeadlineError extends Error {}
class SpeechNetworkError extends Error { readonly name = 'SpeechNetworkError'; }
class SpeechResponseError extends Error { constructor(message: string, readonly durationMilliseconds?: number, options?: ErrorOptions) { super(message, options); } }

async function readSpeechResponse(response: Response): Promise<{ transcript: string; durationMilliseconds: number | null }> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > SPEECH_MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* Keep the fixed response-size failure. */ }
    throw new Error('Speech response exceeds the 1 MiB response limit.');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > SPEECH_MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch { /* Keep the fixed response-size failure. */ }
          throw new Error('Speech response exceeds the 1 MiB response limit.');
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    total = bytes.byteLength;
    if (total > SPEECH_MAX_RESPONSE_BYTES) throw new Error('Speech response exceeds the 1 MiB response limit.');
    chunks.push(bytes);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(decoded);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Speech response must be a JSON object.');
  const row = value as Record<string, unknown>;
  const duration = row.durationMilliseconds;
  const validDuration = Number.isSafeInteger(duration) && (duration as number) > 0 && (duration as number) <= SPEECH_MAX_AUDIO_SECONDS * 1000;
  if (!validDuration) return { transcript: '', durationMilliseconds: null };
  if (!Array.isArray(row.combinedPhrases) || row.combinedPhrases.length > 1) throw new SpeechResponseError('Speech response must contain zero or one merged phrase.', duration as number);
  let text = '';
  if (row.combinedPhrases.length === 1) {
    const phrase = row.combinedPhrases[0];
    if (!phrase || typeof phrase !== 'object' || Array.isArray(phrase) || typeof (phrase as Record<string, unknown>).text !== 'string') throw new SpeechResponseError('Speech response phrase is malformed.', duration as number);
    text = (phrase as { text: string }).text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  }
  if (new TextEncoder().encode(text).byteLength > SPEECH_MAX_TRANSCRIPT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new SpeechResponseError('Speech transcript exceeds its supported text limit.', duration as number);
  // Reject unpaired UTF-16 surrogates before the text can enter a note.
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(i + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new SpeechResponseError('Speech transcript contains invalid Unicode.', duration as number); i += 1; }
    else if (code >= 0xdc00 && code <= 0xdfff) throw new SpeechResponseError('Speech transcript contains invalid Unicode.', duration as number);
  }
  return { transcript: text, durationMilliseconds: duration as number };
}
