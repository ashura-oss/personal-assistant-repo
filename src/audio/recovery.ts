import { Platform } from 'react-native';
import type { RecordingRecoveryService, StagedRecording, AudioRecoveryMetadata } from './recovery.types';

let implementation: Promise<RecordingRecoveryService> | undefined;

export function getRecordingRecoveryService(): Promise<RecordingRecoveryService> {
  if (!implementation) {
    implementation = (Platform.OS === 'web'
      ? import('./recovery.web')
      : import('./recovery.native'))
      .then(module => module.recordingRecoveryService)
      .catch(error => { implementation = undefined; throw error; });
  }
  return implementation;
}

/** Lazy platform facade: importing this module does not load either platform's media APIs. */
export const recordingRecoveryService: RecordingRecoveryService = {
  async pickAndStage(options) { return (await getRecordingRecoveryService()).pickAndStage(options); },
  async inspect(staged: StagedRecording, options): Promise<AudioRecoveryMetadata> {
    return (await getRecordingRecoveryService()).inspect(staged, options);
  },
  async remove(staged) { return (await getRecordingRecoveryService()).remove(staged); },
};

export type { AudioRecoveryMetadata, RecordingRecoveryService, StagedRecording } from './recovery.types';
export { MAX_DURATION_SECONDS, MAX_RECOVERY_BYTES, RECOVERY_FORMATS, boundedAudioFormatFromSignature, boundedRecoveryDuration, safeAudioFileName, validateRecoveryFormat, assertRecoveryByteLength } from './formats';
