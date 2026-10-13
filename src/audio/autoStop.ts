export interface AutoStopEligibility {
  startupReady: boolean;
  isolatedPreview: boolean;
  outcomeUnknown: boolean;
  busy: boolean;
  status: 'idle' | 'recording' | 'paused';
  durationSeconds: number;
  maxAudioSeconds: number;
  /** Review visibility is informational; it never creates or cancels a capture stop. */
  privacyReviewOpen?: boolean;
}

/** Review visibility is ignored: opening a review never stops an idle recording. */
export function shouldAutoStopRecording(input: AutoStopEligibility): boolean {
  return input.startupReady && !input.isolatedPreview && !input.outcomeUnknown && !input.busy &&
    input.status === 'recording' && Number.isFinite(input.durationSeconds) &&
    Number.isFinite(input.maxAudioSeconds) && input.maxAudioSeconds > 0 &&
    input.durationSeconds >= input.maxAudioSeconds;
}

/** Coalesces rerenders into one stop request per recording session. */
export class RecordingAutoStopGate {
  private claimed = false;

  claim(input: AutoStopEligibility): boolean {
    if (input.status !== 'recording') this.claimed = false;
    if (!shouldAutoStopRecording(input) || this.claimed) return false;
    this.claimed = true;
    return true;
  }

  defer(): void {
    this.claimed = false;
  }
}
