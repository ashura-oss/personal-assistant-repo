import type { AppSettings, Note } from '../core';
import * as Crypto from 'expo-crypto';
import type { PreparedSpeechAudio, SpeechAudioService } from '../audio/speechUpload.types';
import {
  SPEECH_MAX_AUDIO_BYTES, SPEECH_MAX_AUDIO_SECONDS,
  SpeechTranscriptionError, validateSpeechAudioSnapshot,
  type OpenRouterSpeechTranscriptionResult,
} from '../transcription';
import { OpenRouterSpeechClient, OpenRouterSpeechError } from './openRouterSpeech';
import { buildOpenRouterSpeechWireRequest } from './openRouterSpeechWire';
import { OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION, getOpenRouterSpeechProfile } from '../transcription/openRouterSpeechProfiles';

export interface OpenRouterSpeechAdapterOptions {
  readonly audio: SpeechAudioService;
  readonly client: OpenRouterSpeechClient;
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
}

/** Provider-specific staging adapter; audio ownership remains with the existing speech audio service. */
export class OpenRouterSpeechAdapter {
  private disposed = false;
  private readonly releasePromises = new Map<string, Promise<void>>();
  private readonly activeUploadLeases = new Set<string>();
  constructor(private readonly options: OpenRouterSpeechAdapterOptions) {}

  disposeMemory(): void {
    this.disposed = true;
    this.options.audio.disposeMemory?.();
  }

  releaseUploadLease(leaseId: string): Promise<void> {
    if (!isUuidV4(leaseId)) return Promise.reject(new Error('Speech upload lease is invalid.'));
    if (this.activeUploadLeases.has(leaseId)) return Promise.reject(new Error('The speech upload still owns this audio lease.'));
    const existing = this.releasePromises.get(leaseId);
    if (existing) return existing;
    const operation = this.options.audio.release(leaseId).finally(() => {
      if (this.releasePromises.get(leaseId) === operation) this.releasePromises.delete(leaseId);
    });
    this.releasePromises.set(leaseId, operation);
    return operation;
  }

  async transcribe(
    note: Note,
    settings: AppSettings,
    signal: AbortSignal | undefined,
    onAttempt: (prepared: PreparedSpeechAudio) => Promise<void>,
    beforeDispatch: (prepared: PreparedSpeechAudio) => void,
    onPrepared: (prepared: PreparedSpeechAudio) => Promise<void> | void,
    leaseId: string,
  ): Promise<OpenRouterSpeechTranscriptionResult> {
    const fail = (message: string, code: ConstructorParameters<typeof SpeechTranscriptionError>[1] = 'pre_dispatch'): never => {
      throw new SpeechTranscriptionError(message, code, false);
    };
    if (this.disposed) fail('Speech upload staging is no longer available in this workspace.');
    if (signal?.aborted) fail('Speech transcription was cancelled before upload.', 'cancelled');
    if (!isUuidV4(leaseId) || !note.audioUri || note.audioAttachment?.durationStatus === 'unknown') fail('This note has no verified audio to transcribe.', 'invalid_audio');
    const sourceDuration = note.audioAttachment?.durationStatus === 'known' ? note.audioAttachment.durationSeconds : note.durationSeconds;
    if (settings.speechProvider !== 'openrouter' || settings.speechEnabled !== true || !Number.isFinite(settings.maxAudioSeconds) || settings.maxAudioSeconds <= 0 ||
        typeof sourceDuration !== 'number' || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > Math.min(settings.maxAudioSeconds, SPEECH_MAX_AUDIO_SECONDS)) {
      fail('Speech transcription settings or source audio are invalid.', 'invalid_audio');
    }

    let prepared: PreparedSpeechAudio | undefined;
    let dispatched = false;
    let uploadLeaseActive = false;
    let releasePromise: Promise<void> | undefined;
    const releaseAfterSettlement = () => {
      if (uploadLeaseActive && prepared) {
        this.activeUploadLeases.delete(prepared.leaseId);
        uploadLeaseActive = false;
      }
      return releasePromise ??= prepared ? this.releaseUploadLease(prepared.leaseId) : Promise.resolve();
    };
    try {
      prepared = await this.options.audio.prepare(note, {
        leaseId, maxDurationSeconds: Math.min(settings.maxAudioSeconds, SPEECH_MAX_AUDIO_SECONDS),
        maxAudioBytes: getOpenRouterSpeechProfile(OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION)!.maxAudioBytes, signal,
      });
      this.activeUploadLeases.add(leaseId);
      uploadLeaseActive = true;
      const snapshot = validateSpeechAudioSnapshot(prepared);
      const profile = getOpenRouterSpeechProfile(OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION)!;
      if (snapshot.leaseId !== leaseId || snapshot.byteLength > SPEECH_MAX_AUDIO_BYTES || snapshot.byteLength > profile.maxAudioBytes) fail('Prepared audio does not match the requested lease or upload limit.', 'invalid_audio');
      await this.options.audio.verify(prepared, signal);
      await onPrepared(prepared);
      if (signal?.aborted) fail('Speech transcription was cancelled before upload.', 'cancelled');
      const bytes = prepared.platform === 'native'
        ? await prepared.upload.part.bytes()
        : new Uint8Array(await prepared.upload.blob.arrayBuffer());
      if (bytes.byteLength !== snapshot.byteLength || bytes.byteLength > SPEECH_MAX_AUDIO_BYTES) fail('Prepared audio changed before upload.', 'audio_changed');
      const digest = (this.options.sha256 ?? hashBytes)(bytes);
      if (await digest !== snapshot.sha256) fail('Prepared audio changed before upload.', 'audio_changed');
      await this.options.audio.verify(prepared, signal);
      const request = buildOpenRouterSpeechWireRequest({ bytes, format: snapshot.format });
      const parsed = await this.options.client.transcribe({
        operationId: leaseId,
        request,
        signal,
        onBeforeDispatch: () => onAttempt(prepared!),
        assertBeforeStart: () => {
          try { beforeDispatch(prepared!); }
          catch (error) { throw new Error('The note, audio, settings, or transcription claim changed before upload.', { cause: error }); }
          dispatched = true;
        },
      });
      const cleanupPromise = releaseAfterSettlement();
      const usage = parsed.usage;
      if (parsed.kind === 'transcript') {
        return Object.freeze({ provider: 'openrouter', profileVersion: request.profileVersion, model: request.model, outcome: 'completed', transcript: parsed.transcript, ...(usage ? { usage } : {}), unknownCharge: usage?.costUsd === undefined, attempts: 1, cleanupPromise }) as OpenRouterSpeechTranscriptionResult;
      }
      if (parsed.kind === 'no_speech') {
        return Object.freeze({ provider: 'openrouter', profileVersion: request.profileVersion, model: request.model, outcome: 'no_speech', ...(usage ? { usage } : {}), unknownCharge: usage?.costUsd === undefined, attempts: 1, cleanupPromise }) as OpenRouterSpeechTranscriptionResult;
      }
      return Object.freeze({ provider: 'openrouter', profileVersion: request.profileVersion, model: request.model, outcome: 'invalid_response', ...(usage ? { usage } : {}), unknownCharge: usage?.costUsd === undefined, attempts: 1, cleanupPromise }) as OpenRouterSpeechTranscriptionResult;
    } catch (error) {
      const typed = error instanceof OpenRouterSpeechError ? error : undefined;
      const transcriptionError = error instanceof SpeechTranscriptionError ? error : undefined;
      const pendingCleanup = releaseAfterSettlement();
      void pendingCleanup.catch(() => undefined);
      const code = transcriptionError?.code ?? (typed ? speechErrorCode(typed.code) : signal?.aborted ? 'cancelled' : dispatched ? 'provider_unknown' : 'invalid_audio');
      const message = transcriptionError?.message ?? typed?.message ?? (dispatched
        ? 'Speech provider request failed; its charge status is unknown.'
        : 'The audio file could not be safely prepared for upload. No audio was sent.');
      const wasDispatched = transcriptionError?.dispatched ?? typed?.dispatched ?? dispatched;
      const usage = typed?.usage;
      throw new SpeechTranscriptionError(message, code, wasDispatched, undefined,
        { cause: error }, pendingCleanup, usage, wasDispatched && usage?.costUsd === undefined);
    }
  }

  retryPendingCleanup(leaseId: string): Promise<void> {
    return this.options.client.retryPendingCleanup(leaseId);
  }
}

function hashBytes(bytes: Uint8Array): Promise<string> {
  return Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes.slice().buffer as ArrayBuffer)
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

function speechErrorCode(code: OpenRouterSpeechError['code']): ConstructorParameters<typeof SpeechTranscriptionError>[1] {
  switch (code) {
    case 'credential_missing': return 'credential_missing';
    case 'stale_credential': return 'stale_credential';
    case 'cancelled': return 'cancelled';
    case 'timeout': return 'timeout';
    case 'provider_rejected': return 'provider_rejected';
    case 'provider_unknown': case 'response_too_large': return 'provider_unknown';
    case 'invalid_request': case 'pre_dispatch': return 'pre_dispatch';
  }
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
