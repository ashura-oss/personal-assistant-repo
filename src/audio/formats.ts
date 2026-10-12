import type { RecoveryFormat } from './recovery.types';

export const MAX_RECOVERY_BYTES = 40 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 600;

export const RECOVERY_FORMATS: Readonly<Record<RecoveryFormat, { mimeType: string; extensions: readonly string[]; mimeAliases: readonly string[] }>> = {
  m4a: { mimeType: 'audio/mp4', extensions: ['m4a'], mimeAliases: ['audio/mp4', 'audio/x-m4a', 'audio/m4a'] },
  mp3: { mimeType: 'audio/mpeg', extensions: ['mp3'], mimeAliases: ['audio/mpeg', 'audio/mp3'] },
  wav: { mimeType: 'audio/wav', extensions: ['wav'], mimeAliases: ['audio/wav', 'audio/x-wav', 'audio/wave'] },
  webm: { mimeType: 'audio/webm', extensions: ['webm'], mimeAliases: ['audio/webm'] },
  ogg: { mimeType: 'audio/ogg', extensions: ['ogg'], mimeAliases: ['audio/ogg', 'audio/opus', 'application/ogg'] },
};

const FORMATS = Object.keys(RECOVERY_FORMATS) as RecoveryFormat[];

export function boundedAudioFormatFromSignature(bytes: Uint8Array): RecoveryFormat | null {
  if (bytes.length < 4) return null;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (bytes.length >= 8 && ascii(4, 8) === 'ftyp') return 'm4a';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return 'mp3';
  return null;
}

/** A display-only leaf name, never a path or control-bearing label. */
export function safeAudioFileName(input: string, format?: RecoveryFormat): string {
  const leaf = input.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = leaf
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\p{Cf}/gu, character => character === '\u200c' || character === '\u200d' ? character : '')
    .replace(/[<>:"|?*]/g, '_')
    .trim();
  if (!clean) return `recording.${format ?? 'audio'}`;
  const truncateCodePoints = (value: string, max: number) => Array.from(value).slice(0, max).join('');
  if (format && !clean.toLowerCase().endsWith(`.${format}`)) {
    const base = truncateCodePoints(clean.replace(/\.[^.]*$/, '') || 'recording', 150) || 'recording';
    return `${base}.${format}`;
  }
  if (format) {
    const base = truncateCodePoints(clean.slice(0, -(format.length + 1)), 150) || 'recording';
    return `${base}.${format}`;
  }
  return truncateCodePoints(clean, 160);
}

function formatFromExtension(name: string): RecoveryFormat | null {
  const extension = name.split('.').pop()?.toLowerCase();
  return FORMATS.find(format => RECOVERY_FORMATS[format].extensions.includes(extension ?? '')) ?? null;
}

function formatFromMime(mimeType: string): RecoveryFormat | null {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (!normalized || normalized === 'application/octet-stream' || normalized === 'binary/octet-stream') return null;
  return FORMATS.find(format => RECOVERY_FORMATS[format].mimeAliases.includes(normalized)) ?? null;
}

/**
 * Resolve a closed supported format and reject contradictory metadata. File headers are
 * only a quick signature check; the platform-local media probe must still succeed.
 */
export function validateRecoveryFormat(name: string, mimeType: string | undefined, bytes: Uint8Array): RecoveryFormat {
  const signatureFormat = boundedAudioFormatFromSignature(bytes);
  const extensionFormat = formatFromExtension(name);
  const declaredMime = mimeType?.split(';', 1)[0].trim().toLowerCase() ?? '';
  const mimeFormat = formatFromMime(declaredMime);
  if (!signatureFormat || (extensionFormat && extensionFormat !== signatureFormat) || (mimeFormat && mimeFormat !== signatureFormat)) {
    throw new Error('The selected file is not a supported audio recording or its format details do not match.');
  }
  if (extensionFormat === null && name.includes('.')) throw new Error('The selected file type is not supported. Choose M4A, MP3, WAV, WebM, or OGG audio.');
  if (declaredMime && !mimeFormat && declaredMime !== 'application/octet-stream' && declaredMime !== 'binary/octet-stream') {
    throw new Error('The selected file type is not supported. Choose M4A, MP3, WAV, WebM, or OGG audio.');
  }
  return signatureFormat;
}

export function boundedRecoveryDuration(durationSeconds: number, maxDurationSeconds: number): { durationStatus: 'known'; durationSeconds: number } | { durationStatus: 'unknown' } {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) throw new Error('The maximum recording duration is invalid.');
  const limit = Math.min(MAX_DURATION_SECONDS, maxDurationSeconds);
  if (Number.isNaN(durationSeconds) || durationSeconds === Number.POSITIVE_INFINITY) return { durationStatus: 'unknown' };
  if (durationSeconds <= 0 || durationSeconds > limit) throw new Error(`Choose an audio recording longer than zero and no longer than ${limit} seconds.`);
  return { durationStatus: 'known', durationSeconds: Math.max(0.001, Math.round(durationSeconds * 1000) / 1000) };
}

export function assertRecoveryByteLength(length: number): void {
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_RECOVERY_BYTES) {
    throw new Error('Choose an audio file that is larger than zero and no more than 40 MiB.');
  }
}
