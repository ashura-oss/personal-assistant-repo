export type AudioDurationMeasurement =
  | { outcome: 'known'; durationSeconds: number }
  | { outcome: 'unknown'; reason: 'zero' | 'indefinite' };

export type AudioDurationStatus = {
  isLoaded: boolean;
  playbackState: string;
  duration: unknown;
};

export type AudioDurationPlayer = {
  readonly currentStatus: AudioDurationStatus;
  addListener(event: 'playbackStatusUpdate', listener: (status: AudioDurationStatus) => void): { remove(): void };
  remove(): void;
};

export type AudioDurationPlayerFactory = {
  create(uri: string): AudioDurationPlayer;
};

export class AudioDurationProbeError extends Error {
  constructor(readonly code: 'timeout' | 'decode_error' | 'invalid_duration') {
    super(code === 'timeout' ? 'Audio duration probe timed out.'
      : code === 'decode_error' ? 'Audio duration could not be decoded.'
        : 'Audio duration is invalid.');
    this.name = 'AudioDurationProbeError';
  }
}

export const DEFAULT_AUDIO_DURATION_PROBE_TIMEOUT_MS = 10_000;

export function measureAudioDuration(
  uri: string,
  factory: AudioDurationPlayerFactory,
  timeoutMs = DEFAULT_AUDIO_DURATION_PROBE_TIMEOUT_MS,
): Promise<AudioDurationMeasurement> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_AUDIO_DURATION_PROBE_TIMEOUT_MS) {
    return Promise.reject(new Error('Audio duration probe timeout is invalid.'));
  }

  let player: AudioDurationPlayer;
  try { player = factory.create(uri); }
  catch { return Promise.reject(new Error('Audio duration player could not be created.')); }

  return new Promise((resolve, reject) => {
    let settled = false;
    let playerRemoved = false;
    let subscriptionRemoved = false;
    let subscription: { remove(): void } | undefined;
    const timer = setTimeout(() => finish(undefined, new AudioDurationProbeError('timeout')), timeoutMs);

    const removeSubscription = (target = subscription) => {
      if (!target || subscriptionRemoved) return;
      subscriptionRemoved = true;
      try { target.remove(); } catch { /* cleanup is best effort */ }
    };
    const cleanup = () => {
      clearTimeout(timer);
      removeSubscription();
      if (!playerRemoved) {
        playerRemoved = true;
        try { player.remove(); } catch { /* cleanup is best effort */ }
      }
    };
    const finish = (value?: AudioDurationMeasurement, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value!);
    };
    const onStatus = (status: AudioDurationStatus) => {
      if (!status || typeof status !== 'object' || typeof status.isLoaded !== 'boolean') {
        finish(undefined, new AudioDurationProbeError('invalid_duration'));
        return;
      }
      if (status.playbackState === 'error') {
        finish(undefined, new AudioDurationProbeError('decode_error'));
        return;
      }
      if (!status.isLoaded) {
        return;
      }
      const duration = status.duration;
      if (typeof duration !== 'number' || Number.isNaN(duration) || duration < 0) {
        finish(undefined, new AudioDurationProbeError('invalid_duration'));
      } else if (duration === 0) {
        finish({ outcome: 'unknown', reason: 'zero' });
      } else if (duration === Number.POSITIVE_INFINITY) {
        finish({ outcome: 'unknown', reason: 'indefinite' });
      } else if (Number.isFinite(duration)) {
        finish({ outcome: 'known', durationSeconds: duration });
      } else {
        finish(undefined, new AudioDurationProbeError('invalid_duration'));
      }
    };

    try {
      const createdSubscription = player.addListener('playbackStatusUpdate', onStatus);
      if (settled) removeSubscription(createdSubscription);
      else subscription = createdSubscription;
      if (!settled) onStatus(player.currentStatus);
    } catch {
      finish(undefined, new AudioDurationProbeError('invalid_duration'));
    }
  });
}
