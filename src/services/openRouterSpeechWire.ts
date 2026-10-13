import { SPEECH_MAX_AUDIO_BYTES, SPEECH_MAX_TRANSCRIPT_BYTES } from '../transcription';
import {
  getOpenRouterSpeechProfile,
  OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION,
  OPENROUTER_SPEECH_LEGACY_MODEL,
  type OpenRouterSpeechModel,
  type OpenRouterSpeechProfileVersion,
} from '../transcription/openRouterSpeechProfiles';
export { OPENROUTER_SPEECH_DEFAULT_MODEL, OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION, OPENROUTER_SPEECH_PROFILES } from '../transcription/openRouterSpeechProfiles';

export const OPENROUTER_SPEECH_ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions' as const;
/** Backward-compatible profile-1 model name. New requests use profile 2 by default. */
export const OPENROUTER_SPEECH_MODEL = OPENROUTER_SPEECH_LEGACY_MODEL;

export type OpenRouterSpeechFormat = 'm4a' | 'wav' | 'mp3' | 'webm' | 'ogg';

export type OpenRouterSpeechUsage = Readonly<{
  seconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}>;

export type OpenRouterSpeechParseResult =
  | Readonly<{ kind: 'transcript'; transcript: string; usage?: OpenRouterSpeechUsage }>
  | Readonly<{ kind: 'no_speech'; usage?: OpenRouterSpeechUsage }>
  | Readonly<{ kind: 'invalid'; code: 'invalid_response' | 'invalid_text' | 'transcript_too_large'; usage?: OpenRouterSpeechUsage }>;

export interface OpenRouterSpeechWireRequest {
  readonly endpoint: typeof OPENROUTER_SPEECH_ENDPOINT;
  readonly body: string;
  readonly audioBytes: number;
  readonly profileVersion: OpenRouterSpeechProfileVersion;
  readonly model: OpenRouterSpeechModel;
}

/** Builds the exact JSON wire payload from a snapshot copy. It performs no I/O. */
export function buildOpenRouterSpeechWireRequest(input: {
  bytes: Uint8Array;
  format: OpenRouterSpeechFormat;
  profileVersion?: OpenRouterSpeechProfileVersion;
}): OpenRouterSpeechWireRequest {
  if (!input || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength <= 0 || input.bytes.byteLength > SPEECH_MAX_AUDIO_BYTES) {
    throw new Error('Prepared audio is outside the supported upload size.');
  }
  if (!['m4a', 'wav', 'mp3', 'webm', 'ogg'].includes(input.format)) {
    throw new Error('Prepared audio format is not supported.');
  }
  const profileVersion = input.profileVersion ?? OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION;
  const profile = getOpenRouterSpeechProfile(profileVersion);
  if (!profile) throw new Error('OpenRouter speech profile is not supported.');
  if (input.bytes.byteLength > profile.maxAudioBytes) throw new Error('Prepared audio exceeds the selected OpenRouter speech profile size limit.');

  // Snapshot synchronously so subsequent mutation of a caller-owned typed array cannot alter the payload.
  const snapshot = new Uint8Array(input.bytes);
  const body = JSON.stringify({
    model: profile.model,
    input_audio: { data: encodeBase64(snapshot), format: input.format },
    response_format: 'json',
    provider: { zdr: true, data_collection: 'deny' },
  });
  return Object.freeze({ endpoint: OPENROUTER_SPEECH_ENDPOINT, body, audioBytes: snapshot.byteLength, profileVersion: profile.version, model: profile.model });
}

/** Parses only transcription text and allowlisted actual usage fields; provider strings/errors never escape. */
export function parseOpenRouterSpeechResponse(value: unknown): OpenRouterSpeechParseResult {
  const row = objectRecord(value);
  if (!row) return Object.freeze({ kind: 'invalid', code: 'invalid_response' });
  const usage = parseUsage(row.usage);
  const includeUsage = usage && Object.keys(usage).length > 0 ? { usage } : {};
  if (typeof row.text !== 'string') return Object.freeze({ kind: 'invalid', code: 'invalid_response', ...includeUsage });

  const transcript = row.text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (hasInvalidUnicode(transcript) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(transcript)) {
    return Object.freeze({ kind: 'invalid', code: 'invalid_text', ...includeUsage });
  }
  if (new TextEncoder().encode(transcript).byteLength > SPEECH_MAX_TRANSCRIPT_BYTES) {
    return Object.freeze({ kind: 'invalid', code: 'transcript_too_large', ...includeUsage });
  }
  if (!transcript) return Object.freeze({ kind: 'no_speech', ...includeUsage });
  return Object.freeze({ kind: 'transcript', transcript, ...includeUsage });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseUsage(value: unknown): OpenRouterSpeechUsage | undefined {
  const row = objectRecord(value);
  if (!row) return undefined;
  const usage: {
    seconds?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  } = {};
  if (typeof row.seconds === 'number' && Number.isFinite(row.seconds) && row.seconds >= 0) usage.seconds = row.seconds;
  if (Number.isSafeInteger(row.input_tokens) && (row.input_tokens as number) >= 0) usage.inputTokens = row.input_tokens as number;
  if (Number.isSafeInteger(row.output_tokens) && (row.output_tokens as number) >= 0) usage.outputTokens = row.output_tokens as number;
  if (Number.isSafeInteger(row.total_tokens) && (row.total_tokens as number) >= 0) usage.totalTokens = row.total_tokens as number;
  if (typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0) usage.costUsd = row.cost;
  return Object.keys(usage).length ? Object.freeze(usage) : undefined;
}

function hasInvalidUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks: string[] = [];
  const bytesPerChunk = 12 * 1024;
  for (let chunkStart = 0; chunkStart < bytes.length; chunkStart += bytesPerChunk) {
    const end = Math.min(bytes.length, chunkStart + bytesPerChunk);
    let encoded = '';
    for (let index = chunkStart; index < end; index += 3) {
      const a = bytes[index];
      const hasB = index + 1 < end;
      const hasC = index + 2 < end;
      const b = hasB ? bytes[index + 1] : 0;
      const c = hasC ? bytes[index + 2] : 0;
      encoded += alphabet[a >> 2];
      encoded += alphabet[((a & 3) << 4) | (b >> 4)];
      encoded += hasB ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
      encoded += hasC ? alphabet[c & 63] : '=';
    }
    chunks.push(encoded);
  }
  return chunks.join('');
}
