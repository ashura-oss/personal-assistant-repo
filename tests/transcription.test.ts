import { describe, expect, it } from 'vitest';
import { validateTranscriptionState, TRANSCRIPTION_SCHEMA_VERSION, type AzureTranscriptionAttempt, type OpenRouterTranscriptionAttempt, type TranscriptionState } from '../src/transcription';
import { OPENROUTER_SPEECH_DEFAULT_MODEL } from '../src/transcription/openRouterSpeechProfiles';

const attempt = {
  id: '22222222-2222-4222-8222-222222222222', leaseId: '11111111-1111-4111-8111-111111111111', noteId: '33333333-3333-4333-8333-333333333333',
  sourceRevision: 4,
  source: { audioUri: 'file:///private/documents/recording-recovery/audio.m4a', durationSeconds: 7.25, capturedAt: '2026-10-13T04:00:00.000Z', captureTimeZone: 'Asia/Singapore', speechEnabled: true, maxAudioSeconds: 600, provider: 'azure' as const },
  provider: 'azure' as const,
  endpoint: 'https://eastus.cognitiveservices.azure.com', locale: 'en-US' as const, createdAt: '2026-10-13T04:01:00.000Z', dispatchStarted: false, outcome: 'preparing' as const,
};
const base = (): Omit<TranscriptionState, 'attempts'> & { attempts: AzureTranscriptionAttempt[] } => ({ schemaVersion: TRANSCRIPTION_SCHEMA_VERSION, installationUUID: '44444444-4444-4444-8444-444444444444', attempts: [structuredClone(attempt)], cleanupLeases: [{ leaseId: attempt.leaseId, attemptId: attempt.id, createdAt: attempt.createdAt, outcome: 'owned' }] });

describe('transcription journal validation', () => {
  it('returns immutable preparing claim and owned cleanup lease without exposing credentials', () => {
    const result = validateTranscriptionState(base());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attempts[0])).toBe(true);
    expect(result.attempts[0]).toMatchObject({ outcome: 'preparing', dispatchStarted: false, leaseId: attempt.leaseId });
    expect(JSON.stringify(result)).not.toMatch(/key|secret|token/i);
  });

  it('requires matching prepared lease and reservation after the single request claim', () => {
    const state = base();
    state.attempts[0] = { ...state.attempts[0], outcome: 'pending', dispatchStarted: true, reservation: { month: '2026-10', day: '2026-10-13', reserve: 0.1 } };
    expect(() => validateTranscriptionState(state)).toThrow(/prepared audio/i);
    state.attempts[0] = { ...state.attempts[0], prepared: { leaseId: '55555555-5555-4555-8555-555555555555', platform: 'native', format: 'm4a', mimeType: 'audio/mp4', byteLength: 16, sha256: 'a'.repeat(64), durationSeconds: 7.25 } };
    expect(() => validateTranscriptionState(state)).toThrow(/attempt lease/i);
    state.attempts[0] = { ...state.attempts[0], prepared: { leaseId: attempt.leaseId, platform: 'native', format: 'm4a', mimeType: 'audio/mp4', byteLength: 16, sha256: 'a'.repeat(64), durationSeconds: 7.25 } };
    expect(validateTranscriptionState(state).attempts[0].outcome).toBe('pending');
  });

  it('rejects unsupported properties, inconsistent usage, noncanonical endpoint, and broken cleanup references', () => {
    const extra = base() as unknown as Record<string, unknown>;
    extra.credentials = { key: 'must-not-persist' };
    expect(() => validateTranscriptionState(extra)).toThrow(/unsupported/i);
    const invalid = base();
    invalid.attempts[0] = { ...invalid.attempts[0], endpoint: 'http://example.com' };
    expect(() => validateTranscriptionState(invalid)).toThrow(/endpoint/i);
    const relation = base();
    relation.cleanupLeases[0].attemptId = '55555555-5555-4555-8555-555555555555';
    expect(() => validateTranscriptionState(relation)).toThrow(/references/i);
  });

  it('preserves a provider duration only when billed seconds exactly ceil it', () => {
    const state = base();
    state.attempts[0] = { ...state.attempts[0], outcome: 'no_speech', terminalAt: '2026-10-13T04:02:00.000Z', dispatchStarted: true, reservation: { month: '2026-10', day: '2026-10-13', reserve: 0.1 }, durationMilliseconds: 1001, billedEstimateSeconds: 1, rateEstimated: false, code: 'no_speech' };
    state.attempts[0].prepared = { leaseId: attempt.leaseId, platform: 'native', format: 'm4a', mimeType: 'audio/mp4', byteLength: 16, sha256: 'a'.repeat(64), durationSeconds: 7.25 };
    expect(() => validateTranscriptionState(state)).toThrow(/billed duration/i);
    state.attempts[0].billedEstimateSeconds = 2;
    expect(validateTranscriptionState(state).attempts[0].durationMilliseconds).toBe(1001);
  });

  it('enforces usage, dispatch, and terminal-code relationships without discarding valid cancellation usage', () => {
    const prepared = { leaseId: attempt.leaseId, platform: 'native' as const, format: 'm4a' as const, mimeType: 'audio/mp4', byteLength: 16, sha256: 'a'.repeat(64), durationSeconds: 7.25 };
    const terminal = { terminalAt: '2026-10-13T04:02:00.000Z', dispatchStarted: true, reservation: { month: '2026-10', day: '2026-10-13', reserve: 0.1 }, prepared };

    const disabled = base();
    disabled.attempts[0] = { ...disabled.attempts[0], source: { ...disabled.attempts[0].source, speechEnabled: false } };
    expect(() => validateTranscriptionState(disabled)).toThrow(/Speech settings/i);

    const pendingWithTerminalCode = base();
    pendingWithTerminalCode.attempts[0] = { ...pendingWithTerminalCode.attempts[0], outcome: 'pending', ...terminal, code: 'timeout' };
    expect(() => validateTranscriptionState(pendingWithTerminalCode)).toThrow(/Pending attempts/i);

    const noSpeechMismatch = base();
    noSpeechMismatch.attempts[0] = { ...noSpeechMismatch.attempts[0], outcome: 'no_speech', ...terminal, code: 'invalid_response', durationMilliseconds: 1000, billedEstimateSeconds: 1, rateEstimated: false };
    expect(() => validateTranscriptionState(noSpeechMismatch)).toThrow(/No-speech/i);

    const rejectedWithUsage = base();
    rejectedWithUsage.attempts[0] = { ...rejectedWithUsage.attempts[0], outcome: 'failed', ...terminal, code: 'provider_rejected', durationMilliseconds: 1000, billedEstimateSeconds: 1, rateEstimated: false };
    expect(() => validateTranscriptionState(rejectedWithUsage)).toThrow(/rejected provider/i);

    const invalidResponseWithUsage = base();
    invalidResponseWithUsage.attempts[0] = { ...invalidResponseWithUsage.attempts[0], outcome: 'failed', ...terminal, code: 'invalid_response', durationMilliseconds: 1001, billedEstimateSeconds: 2, rateEstimated: true };
    expect(validateTranscriptionState(invalidResponseWithUsage).attempts[0].durationMilliseconds).toBe(1001);

    const cancelledWithKnownResult = base();
    cancelledWithKnownResult.attempts[0] = { ...cancelledWithKnownResult.attempts[0], outcome: 'cancelled', ...terminal, code: 'cancelled', durationMilliseconds: 1001, billedEstimateSeconds: 2, rateEstimated: false, transcriptSha256: 'b'.repeat(64) };
    expect(validateTranscriptionState(cancelledWithKnownResult).attempts[0].transcriptSha256).toBe('b'.repeat(64));
  });

  it('deep-freezes nested source attachment metadata', () => {
    const state = base();
    state.attempts[0].source.audioAttachment = { fileName: 'capture.m4a', format: 'm4a', mimeType: 'audio/mp4', byteLength: 16, sha256: 'a'.repeat(64), durationStatus: 'known', durationSeconds: 7.25 };
    const result = validateTranscriptionState(state);
    expect(Object.isFrozen(result.attempts[0].source.audioAttachment)).toBe(true);
  });

  it('accepts a verified OpenRouter transcript when actual cost was not reported', () => {
    const openRouter: OpenRouterTranscriptionAttempt = {
      id: attempt.id, leaseId: attempt.leaseId, noteId: attempt.noteId, sourceRevision: 4,
      source: { ...attempt.source, provider: 'openrouter' }, provider: 'openrouter', profileVersion: 1,
      model: 'openai/gpt-4o-mini-transcribe', endpoint: 'https://openrouter.ai/api/v1/audio/transcriptions', locale: 'auto',
      createdAt: attempt.createdAt, terminalAt: '2026-10-13T04:02:00.000Z', dispatchStarted: true, outcome: 'completed',
      prepared: { leaseId: attempt.leaseId, platform: 'native', format: 'm4a', mimeType: 'audio/mp4', byteLength: 16, sha256: 'a'.repeat(64), durationSeconds: 7.25 },
      transcriptSha256: 'b'.repeat(64), actualUsage: { totalTokens: 9 }, unknownCharge: true,
    };
    const state = base();
    state.attempts[0] = openRouter as unknown as AzureTranscriptionAttempt;
    const checked = validateTranscriptionState(state);
    expect(checked.attempts[0]).toMatchObject({ provider: 'openrouter', outcome: 'completed', unknownCharge: true, actualUsage: { totalTokens: 9 } });
    const missingCostMarkedKnown = structuredClone(state);
    (missingCostMarkedKnown.attempts[0] as unknown as Record<string, unknown>).unknownCharge = false;
    expect(() => validateTranscriptionState(missingCostMarkedKnown)).toThrow(/charge knowledge/i);
    const zeroCostMarkedUnknown = structuredClone(state);
    Object.assign(zeroCostMarkedUnknown.attempts[0], { actualUsage: { costUsd: 0 }, unknownCharge: true });
    expect(() => validateTranscriptionState(zeroCostMarkedUnknown)).toThrow(/charge knowledge/i);
    const azureDurationInOpenRouter = structuredClone(state);
    Object.assign(azureDurationInOpenRouter.attempts[0], { lateObservations: [{ at: '2026-10-13T04:03:00.000Z', kind: 'provider_duration', durationMilliseconds: 1_000 }] });
    expect(() => validateTranscriptionState(azureDurationInOpenRouter)).toThrow(/Azure duration/i);
  });

  it('accepts profile 2 while retaining the exact profile-1 model pairing for historical attempts', () => {
    const state = base();
    const prepared = { leaseId: attempt.leaseId, platform: 'native' as const, format: 'm4a' as const, mimeType: 'audio/mp4', byteLength: 16, sha256: 'a'.repeat(64), durationSeconds: 7.25 };
    const v2: OpenRouterTranscriptionAttempt = {
      id: attempt.id, leaseId: attempt.leaseId, noteId: attempt.noteId, sourceRevision: 4,
      source: { ...attempt.source, provider: 'openrouter' }, provider: 'openrouter', profileVersion: 2,
      model: OPENROUTER_SPEECH_DEFAULT_MODEL, endpoint: 'https://openrouter.ai/api/v1/audio/transcriptions', locale: 'auto',
      createdAt: attempt.createdAt, terminalAt: '2026-10-13T04:02:00.000Z', dispatchStarted: true, outcome: 'completed',
      prepared, transcriptSha256: 'b'.repeat(64), actualUsage: { costUsd: 0 }, unknownCharge: false,
    };
    state.attempts[0] = v2 as unknown as AzureTranscriptionAttempt;
    expect(validateTranscriptionState(state).attempts[0]).toMatchObject({ profileVersion: 2, model: OPENROUTER_SPEECH_DEFAULT_MODEL });
    const mismatched = structuredClone(state);
    (mismatched.attempts[0] as unknown as Record<string, unknown>).model = 'openai/gpt-4o-mini-transcribe';
    expect(() => validateTranscriptionState(mismatched)).toThrow(/speech profile/i);
    const oldPair = structuredClone(state);
    Object.assign(oldPair.attempts[0], { profileVersion: 1, model: 'openai/gpt-4o-mini-transcribe' });
    expect(validateTranscriptionState(oldPair).attempts[0]).toMatchObject({ profileVersion: 1, model: 'openai/gpt-4o-mini-transcribe' });
  });
});
