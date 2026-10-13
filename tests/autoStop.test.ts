import { describe, expect, it } from 'vitest';
import { RecordingAutoStopGate, type AutoStopEligibility } from '../src/audio/autoStop';

const base: AutoStopEligibility = {
  startupReady: true,
  isolatedPreview: false,
  outcomeUnknown: false,
  busy: false,
  status: 'recording',
  durationSeconds: 60,
  maxAudioSeconds: 60,
};

describe('recording auto-stop gate', () => {
  it('does not stop idle, startup-failed, isolated, or below-limit recordings', () => {
    const gate = new RecordingAutoStopGate();
    expect(gate.claim({ ...base, status: 'idle', privacyReviewOpen: true })).toBe(false);
    expect(gate.claim({ ...base, startupReady: false })).toBe(false);
    expect(gate.claim({ ...base, isolatedPreview: true })).toBe(false);
    expect(gate.claim({ ...base, durationSeconds: 59.99 })).toBe(false);
  });

  it('waits while another action is busy, then claims one stop despite rerenders', () => {
    const gate = new RecordingAutoStopGate();
    expect(gate.claim({ ...base, busy: true })).toBe(false);
    expect(gate.claim({ ...base, privacyReviewOpen: true })).toBe(true);
    expect(gate.claim({ ...base, privacyReviewOpen: true })).toBe(false);
    expect(gate.claim({ ...base, status: 'idle' })).toBe(false);
    expect(gate.claim(base)).toBe(true);
  });

  it('never auto-stops behind an unknown privacy outcome', () => {
    const gate = new RecordingAutoStopGate();
    expect(gate.claim({ ...base, outcomeUnknown: true })).toBe(false);
  });
});
