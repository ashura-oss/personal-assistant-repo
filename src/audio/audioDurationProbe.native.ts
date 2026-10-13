import { createAudioPlayer } from 'expo-audio';
import { measureAudioDuration } from './audioDurationProbe';
import type { AudioDurationMeasurement } from './audioDurationProbe';

export { AudioDurationProbeError } from './audioDurationProbe';

export function measureNativeAudioDuration(uri: string, timeoutMs?: number): Promise<AudioDurationMeasurement> {
  return measureAudioDuration(uri, {
    create: (source) => createAudioPlayer(source),
  }, timeoutMs);
}
