import {
  TRANSCRIPTION_MAX_ATTEMPTS, TRANSCRIPTION_MAX_CLEANUP_LEASES, TRANSCRIPTION_SCHEMA_VERSION,
  OPENROUTER_SPEECH_ENDPOINT, validateSpeechAudioSnapshot, type TranscriptionAttempt, type TranscriptionCleanupLease,
  type TranscriptionState,
} from './types';
import { getOpenRouterSpeechProfile, isOpenRouterSpeechModelProfile } from './openRouterSpeechProfiles';
export * from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const HASH = /^[a-f0-9]{64}$/i;
const OUTCOMES = new Set(['preparing', 'pending', 'completed', 'no_speech', 'failed', 'unknown', 'discarded', 'cancelled']);
const CODES = new Set(['preparation_interrupted', 'audio_invalid', 'credential_missing', 'stale_credential', 'cancelled', 'timeout', 'provider_rejected', 'provider_unknown', 'invalid_response', 'no_speech', 'discarded']);
const cleanText = (value: unknown, limit: number, label: string): string => {
  if (typeof value !== 'string' || !value.length || new TextEncoder().encode(value).byteLength > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
};
const canonicalTime = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !TIME.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid.`);
  return value;
};
const safeInteger = (value: unknown, min: number, max: number, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} is invalid.`);
  return value as number;
};

function validateAttempt(value: unknown): TranscriptionAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Transcription attempt is invalid.');
  const row = value as Record<string, unknown>;
  const allowedAttemptKeys = new Set(['id', 'leaseId', 'noteId', 'sourceRevision', 'source', 'endpoint', 'provider', 'profileVersion', 'model', 'locale', 'createdAt', 'prepared', 'reservation', 'dispatchStarted', 'outcome', 'terminalAt', 'code', 'durationMilliseconds', 'billedEstimateSeconds', 'rateEstimated', 'transcriptSha256', 'actualUsage', 'unknownCharge', 'lateObservations']);
  if (Object.keys(row).some((key) => !allowedAttemptKeys.has(key))) throw new Error('Transcription attempt contains unsupported fields.');
  if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.noteId !== 'string' || !UUID.test(row.noteId)) throw new Error('Transcription attempt identity is invalid.');
  if (typeof row.leaseId !== 'string' || !UUID.test(row.leaseId)) throw new Error('Transcription upload lease is invalid.');
  const sourceRevision = safeInteger(row.sourceRevision, 1, Number.MAX_SAFE_INTEGER, 'Transcription source revision');
  if (!row.source || typeof row.source !== 'object' || Array.isArray(row.source)) throw new Error('Transcription source snapshot is invalid.');
  const sourceRow = row.source as Record<string, unknown>;
  const allowedSourceKeys = new Set(['audioUri', 'durationSeconds', 'capturedAt', 'captureTimeZone', 'speechEnabled', 'maxAudioSeconds', 'provider', 'audioAttachment']);
  if (Object.keys(sourceRow).some((key) => !allowedSourceKeys.has(key))) throw new Error('Transcription source contains unsupported fields.');
  const audioUri = cleanText(sourceRow.audioUri, 2048, 'Audio URI');
  if (!(audioUri.startsWith('file://') || audioUri.startsWith('indexeddb-audio:')) || audioUri.includes('..')) throw new Error('Transcription audio source URI is invalid.');
  const durationSeconds = sourceRow.durationSeconds;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600) throw new Error('Transcription source duration is invalid.');
  const capturedAt = canonicalTime(sourceRow.capturedAt, 'Transcription capture time');
  if (typeof sourceRow.captureTimeZone !== 'string' || sourceRow.captureTimeZone.length > 128) throw new Error('Transcription capture time zone is invalid.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: sourceRow.captureTimeZone }); } catch { throw new Error('Transcription capture time zone is invalid.'); }
  if (sourceRow.speechEnabled !== true || typeof sourceRow.maxAudioSeconds !== 'number' || !Number.isFinite(sourceRow.maxAudioSeconds) || sourceRow.maxAudioSeconds <= 0 || sourceRow.maxAudioSeconds > 600 || durationSeconds > sourceRow.maxAudioSeconds) throw new Error('Transcription Speech settings snapshot is invalid.');
  const sourceProvider = sourceRow.provider === undefined ? 'azure' : sourceRow.provider;
  if (sourceProvider !== 'azure' && sourceProvider !== 'openrouter') throw new Error('Speech provider snapshot is invalid.');
  let source: TranscriptionAttempt['source'] = { audioUri, durationSeconds, capturedAt, captureTimeZone: sourceRow.captureTimeZone, speechEnabled: sourceRow.speechEnabled, maxAudioSeconds: sourceRow.maxAudioSeconds, ...(sourceRow.provider !== undefined ? { provider: sourceProvider } : {}) };
  if (sourceRow.audioAttachment !== undefined) {
    const a = sourceRow.audioAttachment as Record<string, unknown>;
    const allowedAttachmentKeys = new Set(['fileName', 'format', 'mimeType', 'byteLength', 'sha256', 'durationStatus', 'durationSeconds']);
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some((key) => !allowedAttachmentKeys.has(key))) throw new Error('Audio attachment metadata is invalid.');
    const formats = new Set(['m4a', 'mp3', 'wav', 'webm', 'ogg']);
    if (typeof a.format !== 'string' || !formats.has(a.format) || typeof a.mimeType !== 'string') throw new Error('Audio attachment metadata is invalid.');
    const format = a.format as import('../audio/recovery.types').RecoveryFormat;
    const expectedMime: Record<typeof format, string> = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg' };
    if (a.mimeType !== expectedMime[format] || !Number.isSafeInteger(a.byteLength) || (a.byteLength as number) <= 0 || (a.byteLength as number) > 40 * 1024 * 1024 || typeof a.sha256 !== 'string' || !HASH.test(a.sha256) || a.durationStatus !== 'known') throw new Error('Audio attachment metadata is invalid.');
    const attachmentDuration = a.durationSeconds === undefined ? undefined : typeof a.durationSeconds === 'number' && Number.isFinite(a.durationSeconds) && a.durationSeconds > 0 && a.durationSeconds <= 600 ? a.durationSeconds : (() => { throw new Error('Audio attachment duration is invalid.'); })();
    if (attachmentDuration === undefined) throw new Error('Audio attachment duration is inconsistent.');
    if (attachmentDuration !== durationSeconds) throw new Error('Audio attachment duration does not match the captured source duration.');
    source = { ...source, audioAttachment: { fileName: cleanText(a.fileName, 512, 'Audio file name'), format, mimeType: a.mimeType, byteLength: a.byteLength as number, sha256: a.sha256.toLowerCase(), durationStatus: a.durationStatus, ...(attachmentDuration ? { durationSeconds: attachmentDuration } : {}) } };
  }
  if (new TextEncoder().encode(JSON.stringify(source)).byteLength > 16 * 1024) throw new Error('Transcription source snapshot exceeds its storage limit.');
  const provider = row.provider === undefined ? 'azure' : row.provider;
  if (provider !== 'azure' && provider !== 'openrouter') throw new Error('Speech provider is invalid.');
  const endpoint = cleanText(row.endpoint, 512, 'Speech endpoint');
  if (provider === 'azure') {
    let parsedEndpoint: URL;
    try { parsedEndpoint = new URL(endpoint); } catch { throw new Error('Speech endpoint is invalid.'); }
    if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.origin !== endpoint || !/\.(cognitiveservices\.azure\.com|api\.cognitive\.microsoft\.com)$/i.test(parsedEndpoint.hostname)) throw new Error('Speech endpoint is invalid.');
    if (row.locale !== 'en-US' || row.profileVersion !== undefined || row.model !== undefined || row.actualUsage !== undefined || row.unknownCharge !== undefined) throw new Error('Azure speech profile is invalid.');
  } else if (endpoint !== OPENROUTER_SPEECH_ENDPOINT || row.locale !== 'auto' || !isOpenRouterSpeechModelProfile(row.profileVersion, row.model)) throw new Error('OpenRouter speech profile is invalid.');
  if (sourceProvider !== provider) throw new Error('Speech provider snapshot does not match the attempt.');
  const createdAt = canonicalTime(row.createdAt, 'Transcription creation time');
  const outcome = row.outcome;
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) throw new Error('Transcription outcome is invalid.');
  const dispatchStarted = row.dispatchStarted;
  if (typeof dispatchStarted !== 'boolean') throw new Error('Transcription dispatch state is invalid.');
  let prepared: TranscriptionAttempt['prepared'];
  if (row.prepared !== undefined) {
    if (!row.prepared || typeof row.prepared !== 'object' || Array.isArray(row.prepared) || 'upload' in (row.prepared as Record<string, unknown>)) throw new Error('Persisted prepared audio metadata must not contain an upload handle.');
    prepared = validateSpeechAudioSnapshot(row.prepared);
  }
  if (prepared && (prepared.leaseId !== row.leaseId || prepared.durationSeconds !== source.durationSeconds)) throw new Error('Prepared audio does not match the attempt lease or source duration.');
  let reservation: TranscriptionAttempt['reservation'];
  if (row.reservation !== undefined) {
    const r = row.reservation as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((key) => !['month', 'day', 'reserve'].includes(key)) || typeof r.month !== 'string' || !/^\d{4}-\d{2}$/.test(r.month) || typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Number.isFinite(Date.parse(`${r.day}T00:00:00.000Z`)) || new Date(`${r.day}T00:00:00.000Z`).toISOString().slice(0, 10) !== r.day || !r.day.startsWith(`${r.month}-`)) throw new Error('Transcription reservation is invalid.');
    if (typeof r.reserve !== 'number' || !Number.isFinite(r.reserve) || r.reserve < 0 || r.reserve > 100) throw new Error('Transcription reservation is invalid.');
    reservation = { month: r.month, day: r.day, reserve: r.reserve };
  }
  const terminal = row.terminalAt === undefined ? undefined : canonicalTime(row.terminalAt, 'Transcription terminal time');
  const code = row.code === undefined ? undefined : typeof row.code === 'string' && CODES.has(row.code) ? row.code as TranscriptionAttempt['code'] : (() => { throw new Error('Transcription outcome code is invalid.'); })();
  const durationMilliseconds = row.durationMilliseconds === undefined ? undefined : safeInteger(row.durationMilliseconds, 1, 600_000, 'Transcription duration');
  const billedEstimateSeconds = row.billedEstimateSeconds === undefined ? undefined : safeInteger(row.billedEstimateSeconds, 1, 600, 'Transcription billed duration');
  const transcriptSha256 = row.transcriptSha256 === undefined ? undefined : typeof row.transcriptSha256 === 'string' && HASH.test(row.transcriptSha256) ? row.transcriptSha256.toLowerCase() : (() => { throw new Error('Transcript fingerprint is invalid.'); })();
  const rateEstimated = row.rateEstimated === undefined ? undefined : typeof row.rateEstimated === 'boolean' ? row.rateEstimated : (() => { throw new Error('Speech estimate state is invalid.'); })();
  let actualUsage: NonNullable<Extract<TranscriptionAttempt, { provider: 'openrouter' }>['actualUsage']> | undefined;
  if (row.actualUsage !== undefined) {
    const usage = row.actualUsage as Record<string, unknown>;
    const usageKeys = new Set(['seconds', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd']);
    if (!usage || typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).some((key) => !usageKeys.has(key)) || Object.keys(usage).length === 0) throw new Error('OpenRouter speech usage is invalid.');
    const checked: Record<string, number> = {};
    for (const key of usageKeys) {
      const value = usage[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'seconds' && key !== 'costUsd' && !Number.isSafeInteger(value))) throw new Error('OpenRouter speech usage is invalid.');
      checked[key] = value;
    }
    actualUsage = Object.freeze(checked) as NonNullable<Extract<TranscriptionAttempt, { provider: 'openrouter' }>['actualUsage']>;
  }
  const unknownCharge = row.unknownCharge === undefined ? undefined : typeof row.unknownCharge === 'boolean' ? row.unknownCharge : (() => { throw new Error('OpenRouter charge state is invalid.'); })();
  if (provider === 'openrouter' && (reservation !== undefined || durationMilliseconds !== undefined || billedEstimateSeconds !== undefined || rateEstimated !== undefined)) throw new Error('OpenRouter attempts cannot contain Azure reservations or estimates.');
  if (outcome === 'preparing' && (dispatchStarted || reservation || terminal || code || durationMilliseconds || billedEstimateSeconds || rateEstimated !== undefined || transcriptSha256 || actualUsage || unknownCharge !== undefined)) throw new Error('Preparing attempts cannot be dispatched, reserved, or terminal.');
  if (outcome === 'pending' && (!dispatchStarted || (provider === 'azure' && !reservation) || !prepared || terminal || code || durationMilliseconds || billedEstimateSeconds || rateEstimated !== undefined || transcriptSha256 || actualUsage || unknownCharge !== undefined)) throw new Error('Pending attempts require prepared audio and a provider-specific dispatch claim.');
  if (['completed', 'no_speech', 'failed', 'unknown', 'discarded', 'cancelled'].includes(outcome) && !terminal) throw new Error('Terminal attempts require an outcome time.');
  if (dispatchStarted && (!prepared || (provider === 'azure' && !reservation) || (provider === 'openrouter' && reservation !== undefined))) throw new Error('Dispatched attempts require prepared audio and a provider-specific claim.');
  if (terminal && Date.parse(terminal) < Date.parse(createdAt)) throw new Error('Transcription terminal time predates its creation.');
  if (outcome === 'completed' && (!transcriptSha256 || !dispatchStarted || !prepared || code || (provider === 'azure' && (!durationMilliseconds || rateEstimated === undefined)) || (provider === 'openrouter' && durationMilliseconds !== undefined))) throw new Error('Completed attempts require verified provider output.');
  if (outcome === 'discarded' && (!transcriptSha256 || !dispatchStarted || !prepared || code !== 'discarded' ||
      (provider === 'azure' && (!durationMilliseconds || rateEstimated === undefined)) ||
      (provider === 'openrouter' && (durationMilliseconds !== undefined || unknownCharge === undefined)))) throw new Error('Discarded attempts require verified provider output.');
  if (durationMilliseconds && billedEstimateSeconds !== Math.ceil(durationMilliseconds / 1000)) throw new Error('Transcription billed duration does not match the provider duration.');
  if (outcome === 'no_speech' && (!dispatchStarted || !prepared || code !== 'no_speech' || transcriptSha256 || (provider === 'azure' && (!durationMilliseconds || rateEstimated === undefined)) || (provider === 'openrouter' && durationMilliseconds !== undefined))) throw new Error('No-speech attempts require a verified provider response.');
  if (outcome === 'unknown' && (!dispatchStarted || !prepared || !['timeout', 'provider_unknown', 'invalid_response', 'cancelled'].includes(String(code)) || (provider === 'openrouter' && unknownCharge === undefined))) throw new Error('Unknown attempts require an uncertain dispatched upload with explicit charge knowledge.');
  if (outcome === 'failed' && (dispatchStarted ? !['provider_rejected', 'invalid_response'].includes(String(code)) : !code || ['provider_rejected', 'provider_unknown', 'timeout', 'invalid_response', 'no_speech'].includes(String(code)))) throw new Error('Failed attempt outcome does not match its dispatch result.');
  if (outcome === 'failed' && code === 'provider_rejected' && provider === 'azure' && (durationMilliseconds !== undefined || billedEstimateSeconds !== undefined || rateEstimated !== undefined || transcriptSha256 !== undefined)) throw new Error('A rejected provider request cannot contain verified usage.');
  if (outcome === 'failed' && code === 'invalid_response' && transcriptSha256 !== undefined) throw new Error('An invalid provider response cannot contain a transcript fingerprint.');
  if (outcome === 'cancelled' && (code !== 'cancelled' || dispatchStarted && !prepared)) throw new Error('Cancelled attempt outcome is inconsistent.');
  if (!dispatchStarted && (durationMilliseconds || billedEstimateSeconds || rateEstimated !== undefined || transcriptSha256 || actualUsage !== undefined || unknownCharge !== undefined)) throw new Error('A pre-dispatch attempt cannot contain provider usage.');
  if (!durationMilliseconds && (billedEstimateSeconds !== undefined || rateEstimated !== undefined)) throw new Error('Speech usage estimates require a verified duration.');
  const lateObservations = Array.isArray(row.lateObservations) ? row.lateObservations.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Late speech observation is invalid.');
    const o = entry as Record<string, unknown>;
    if (Object.keys(o).some((key) => !['at', 'kind', 'durationMilliseconds'].includes(key))) throw new Error('Late speech observation contains unsupported fields.');
    if (o.kind !== 'provider_duration' && o.kind !== 'cleanup_complete') throw new Error('Late speech observation is invalid.');
    const d = o.durationMilliseconds === undefined ? undefined : safeInteger(o.durationMilliseconds, 1, 600_000, 'Observed speech duration');
    if (o.kind === 'provider_duration' && !d) throw new Error('Late provider duration is invalid.');
    if (o.kind === 'cleanup_complete' && d !== undefined) throw new Error('Cleanup observations cannot include a provider duration.');
    return Object.freeze({ at: canonicalTime(o.at, 'Late observation time'), kind: o.kind, ...(d ? { durationMilliseconds: d } : {}) });
  }) : row.lateObservations === undefined ? undefined : (() => { throw new Error('Late speech observations are invalid.'); })();
  if (lateObservations && lateObservations.length > 4) throw new Error('Too many late speech observations.');
  if (provider === 'openrouter' && lateObservations?.some((entry) => entry.kind === 'provider_duration')) throw new Error('OpenRouter attempts cannot contain Azure duration observations.');
  if (lateObservations?.some((entry) => !terminal || Date.parse(entry.at) < Date.parse(terminal))) throw new Error('Late speech observations must follow the terminal outcome.');
  if (provider === 'openrouter' && dispatchStarted && terminal && unknownCharge !== (actualUsage?.costUsd === undefined)) throw new Error('OpenRouter charge knowledge must match reported actual cost.');
  const frozenSource = Object.freeze({ ...source, ...(source.audioAttachment ? { audioAttachment: Object.freeze({ ...source.audioAttachment }) } : {}) });
  const speechProfile = provider === 'openrouter' ? getOpenRouterSpeechProfile(row.profileVersion) : undefined;
  return Object.freeze({ id: row.id, leaseId: row.leaseId, noteId: row.noteId, sourceRevision, source: frozenSource, endpoint, ...(provider !== 'azure' || row.provider !== undefined ? { provider } : {}), ...(speechProfile ? { profileVersion: speechProfile.version, model: speechProfile.model } : {}), locale: provider === 'azure' ? 'en-US' as const : 'auto' as const, createdAt, ...(prepared ? { prepared } : {}), ...(reservation ? { reservation: Object.freeze(reservation) } : {}), dispatchStarted, outcome: outcome as TranscriptionAttempt['outcome'], ...(terminal ? { terminalAt: terminal } : {}), ...(code ? { code } : {}), ...(durationMilliseconds ? { durationMilliseconds } : {}), ...(billedEstimateSeconds ? { billedEstimateSeconds } : {}), ...(rateEstimated !== undefined ? { rateEstimated } : {}), ...(transcriptSha256 ? { transcriptSha256 } : {}), ...(actualUsage ? { actualUsage } : {}), ...(unknownCharge !== undefined ? { unknownCharge } : {}), ...(lateObservations ? { lateObservations: Object.freeze(lateObservations) as unknown as TranscriptionAttempt['lateObservations'] } : {}) } as TranscriptionAttempt);
}

function validateLease(value: unknown): TranscriptionCleanupLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Speech cleanup lease is invalid.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['leaseId', 'attemptId', 'createdAt', 'outcome'].includes(key))) throw new Error('Speech cleanup lease contains unsupported fields.');
  if (typeof row.leaseId !== 'string' || !UUID.test(row.leaseId) || typeof row.attemptId !== 'string' || !UUID.test(row.attemptId)) throw new Error('Speech cleanup lease identity is invalid.');
  if (!['owned', 'released', 'pending_cleanup'].includes(String(row.outcome))) throw new Error('Speech cleanup lease state is invalid.');
  return Object.freeze({ leaseId: row.leaseId, attemptId: row.attemptId, createdAt: canonicalTime(row.createdAt, 'Speech cleanup lease time'), outcome: row.outcome as TranscriptionCleanupLease['outcome'] });
}

export function validateTranscriptionState(value: unknown): TranscriptionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Transcription state is invalid.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['schemaVersion', 'installationUUID', 'attempts', 'cleanupLeases'].includes(key))) throw new Error('Transcription state contains unsupported fields.');
  if (row.schemaVersion !== TRANSCRIPTION_SCHEMA_VERSION || typeof row.installationUUID !== 'string' || !UUID.test(row.installationUUID)) throw new Error('Transcription state identity is invalid.');
  if (!Array.isArray(row.attempts) || row.attempts.length > TRANSCRIPTION_MAX_ATTEMPTS || !Array.isArray(row.cleanupLeases) || row.cleanupLeases.length > TRANSCRIPTION_MAX_CLEANUP_LEASES) throw new Error('Transcription state exceeds its storage limits.');
  const attempts = row.attempts.map(validateAttempt);
  const cleanupLeases = row.cleanupLeases.map(validateLease);
  const attemptIds = new Set<string>();
  const leaseToAttempt = new Map<string, string>();
  for (const a of attempts) { if (attemptIds.has(a.id) || leaseToAttempt.has(a.leaseId)) throw new Error('Transcription attempt and lease IDs must be unique.'); attemptIds.add(a.id); leaseToAttempt.set(a.leaseId, a.id); }
  const leaseIds = new Set<string>();
  for (const l of cleanupLeases) { if (leaseIds.has(l.leaseId) || !attemptIds.has(l.attemptId) || leaseToAttempt.get(l.leaseId) !== l.attemptId) throw new Error('Speech cleanup lease references are invalid.'); leaseIds.add(l.leaseId); }
  return Object.freeze({ schemaVersion: TRANSCRIPTION_SCHEMA_VERSION, installationUUID: row.installationUUID, attempts: Object.freeze(attempts) as unknown as TranscriptionAttempt[], cleanupLeases: Object.freeze(cleanupLeases) as unknown as TranscriptionCleanupLease[] });
}
