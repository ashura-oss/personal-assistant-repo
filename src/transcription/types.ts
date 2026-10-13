import type { AudioRecoveryMetadata, RecoveryFormat } from '../audio/recovery.types';
import {
  OPENROUTER_SPEECH_LEGACY_MODEL,
  OPENROUTER_SPEECH_PROFILES,
} from './openRouterSpeechProfiles';

export const TRANSCRIPTION_SCHEMA_VERSION = 1 as const;
export const TRANSCRIPTION_MAX_ATTEMPTS = 500;
export const TRANSCRIPTION_MAX_CLEANUP_LEASES = 500;
export const SPEECH_MAX_AUDIO_SECONDS = 600;
export const SPEECH_MAX_AUDIO_BYTES = 40 * 1024 * 1024;
export const SPEECH_MAX_RESPONSE_BYTES = 1024 * 1024;
export const SPEECH_MAX_TRANSCRIPT_BYTES = 128 * 1024;
export const OPENROUTER_SPEECH_ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions' as const;
/** Backward-compatible name for the model stored in profile-1 receipts. */
export const OPENROUTER_SPEECH_MODEL = OPENROUTER_SPEECH_LEGACY_MODEL;
export { OPENROUTER_SPEECH_DEFAULT_MODEL, OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION, OPENROUTER_SPEECH_PROFILES } from './openRouterSpeechProfiles';
export type { OpenRouterSpeechModel, OpenRouterSpeechProfileVersion } from './openRouterSpeechProfiles';

export type SpeechAudioSnapshot = Readonly<{
  leaseId: string;
  platform: 'native' | 'web';
  format: RecoveryFormat;
  mimeType: string;
  byteLength: number;
  sha256: string;
  durationSeconds: number;
}>;

export type SpeechTranscriptionResult = Readonly<{
  transcript: string;
  durationMilliseconds: number;
  durationSeconds: number;
  billedEstimateSeconds: number;
  attempts: 1;
  /** Resolves only after the raw request settles and the private lease cleanup succeeds. */
  cleanupPromise?: Promise<void>;
}>;

export type OpenRouterSpeechActualUsage = Readonly<{
  seconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}>;

type OpenRouterSpeechResultBase = Readonly<{
  provider: 'openrouter';
  usage?: OpenRouterSpeechActualUsage;
  attempts: 1;
  cleanupPromise?: Promise<void>;
}>;

type OpenRouterSpeechOutcome =
  | Readonly<{ outcome: 'completed'; transcript: string; unknownCharge: boolean }>
  | Readonly<{ outcome: 'no_speech' | 'invalid_response'; transcript?: never; unknownCharge: boolean }>;

export type OpenRouterSpeechTranscriptionResult =
  | (OpenRouterSpeechResultBase & Readonly<{ profileVersion: 1; model: typeof OPENROUTER_SPEECH_PROFILES[1]['model'] }> & OpenRouterSpeechOutcome)
  | (OpenRouterSpeechResultBase & Readonly<{ profileVersion: 2; model: typeof OPENROUTER_SPEECH_PROFILES[2]['model'] }> & OpenRouterSpeechOutcome);

export type AnySpeechTranscriptionResult = SpeechTranscriptionResult | OpenRouterSpeechTranscriptionResult;

export type SpeechTranscriptionErrorCode =
  | 'invalid_audio' | 'unsupported_format' | 'audio_changed' | 'credential_missing'
  | 'stale_credential' | 'cancelled' | 'timeout' | 'provider_rejected'
  | 'provider_unknown' | 'invalid_response' | 'no_speech' | 'pre_dispatch';

export class SpeechTranscriptionError extends Error {
  readonly name = 'SpeechTranscriptionError';
  constructor(
    message: string,
    readonly code: SpeechTranscriptionErrorCode,
    readonly dispatched: boolean,
    readonly durationMilliseconds?: number,
    options?: ErrorOptions,
    readonly cleanupPromise?: Promise<void>,
    readonly providerUsage?: OpenRouterSpeechActualUsage,
    readonly unknownCharge?: boolean,
  ) { super(message, options); }
}

export type TranscriptionOutcome = 'preparing' | 'pending' | 'completed' | 'no_speech' | 'failed' | 'unknown' | 'discarded' | 'cancelled';
export type SpeechAttemptCode =
  | 'preparation_interrupted' | 'audio_invalid' | 'credential_missing' | 'stale_credential'
  | 'cancelled' | 'timeout' | 'provider_rejected' | 'provider_unknown'
  | 'invalid_response' | 'no_speech' | 'discarded';

export interface TranscriptionSourceProjection {
  audioUri: string;
  durationSeconds: number;
  capturedAt: string;
  captureTimeZone: string;
  speechEnabled: boolean;
  maxAudioSeconds: number;
  provider?: 'azure' | 'openrouter';
  audioAttachment?: AudioRecoveryMetadata;
}

interface TranscriptionAttemptBase {
  id: string;
  leaseId: string;
  noteId: string;
  sourceRevision: number;
  source: TranscriptionSourceProjection;
  endpoint: string;
  createdAt: string;
  prepared?: SpeechAudioSnapshot;
  dispatchStarted: boolean;
  outcome: TranscriptionOutcome;
  terminalAt?: string;
  code?: SpeechAttemptCode;
  transcriptSha256?: string;
  lateObservations?: { at: string; kind: 'provider_duration' | 'cleanup_complete'; durationMilliseconds?: number }[];
}

export type AzureTranscriptionAttempt = TranscriptionAttemptBase & {
  provider?: 'azure';
  endpoint: string;
  locale: 'en-US';
  reservation?: { month: string; day: string; reserve: number };
  durationMilliseconds?: number;
  billedEstimateSeconds?: number;
  rateEstimated?: boolean;
  actualUsage?: never;
  unknownCharge?: never;
};

type OpenRouterTranscriptionProfile =
  | Readonly<{ profileVersion: 1; model: typeof OPENROUTER_SPEECH_PROFILES[1]['model'] }>
  | Readonly<{ profileVersion: 2; model: typeof OPENROUTER_SPEECH_PROFILES[2]['model'] }>;

export type OpenRouterTranscriptionAttempt = TranscriptionAttemptBase & OpenRouterTranscriptionProfile & {
  provider: 'openrouter';
  endpoint: typeof OPENROUTER_SPEECH_ENDPOINT;
  locale: 'auto';
  reservation?: never;
  durationMilliseconds?: never;
  billedEstimateSeconds?: never;
  rateEstimated?: never;
  actualUsage?: OpenRouterSpeechActualUsage;
  unknownCharge?: boolean;
};

export type TranscriptionAttempt = AzureTranscriptionAttempt | OpenRouterTranscriptionAttempt;

export interface TranscriptionCleanupLease {
  leaseId: string;
  attemptId: string;
  createdAt: string;
  outcome: 'owned' | 'released' | 'pending_cleanup';
}

export interface TranscriptionState {
  schemaVersion: typeof TRANSCRIPTION_SCHEMA_VERSION;
  installationUUID: string;
  attempts: TranscriptionAttempt[];
  cleanupLeases: TranscriptionCleanupLease[];
}

export function validateSpeechAudioSnapshot(value: unknown): SpeechAudioSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prepared audio metadata is invalid.');
  const row = value as Record<string, unknown>;
  const allowed = new Set(['leaseId', 'platform', 'format', 'mimeType', 'byteLength', 'sha256', 'durationSeconds', 'upload']);
  if (Object.keys(row).some((key) => !allowed.has(key))) throw new Error('Prepared audio metadata contains unsupported fields.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof row.leaseId !== 'string' || !uuid.test(row.leaseId)) throw new Error('Prepared audio lease is invalid.');
  if (row.platform !== 'native' && row.platform !== 'web') throw new Error('Prepared audio platform is invalid.');
  if (!['m4a', 'mp3', 'wav', 'webm', 'ogg'].includes(String(row.format))) throw new Error('Prepared audio format is invalid.');
  const format = row.format as RecoveryFormat;
  if (row.format === 'caf') throw new Error('CAF audio cannot be uploaded to cloud transcription.');
  const expectedMime: Record<RecoveryFormat, string> = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg' };
  if (typeof row.mimeType !== 'string' || row.mimeType !== expectedMime[format]) throw new Error('Prepared audio MIME type does not match its format.');
  if (!Number.isSafeInteger(row.byteLength) || (row.byteLength as number) <= 0 || (row.byteLength as number) > SPEECH_MAX_AUDIO_BYTES) throw new Error('Prepared audio size is outside the upload limit.');
  if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(row.sha256)) throw new Error('Prepared audio fingerprint is invalid.');
  if (typeof row.durationSeconds !== 'number' || !Number.isFinite(row.durationSeconds) || row.durationSeconds <= 0 || row.durationSeconds > SPEECH_MAX_AUDIO_SECONDS) throw new Error('Prepared audio duration is outside the upload limit.');
  return Object.freeze({ leaseId: row.leaseId, platform: row.platform, format, mimeType: row.mimeType, byteLength: row.byteLength as number, sha256: row.sha256.toLowerCase(), durationSeconds: row.durationSeconds });
}
