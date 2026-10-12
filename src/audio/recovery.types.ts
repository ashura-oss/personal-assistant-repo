export type RecoveryFormat = 'm4a' | 'mp3' | 'wav' | 'webm' | 'ogg';

export type AudioRecoveryMetadata = {
  fileName: string;
  format: RecoveryFormat;
  mimeType: string;
  byteLength: number;
  sha256: string;
  durationStatus: 'known' | 'unknown';
  durationSeconds?: number;
};

export type StagedRecording = { uri: string; metadata: AudioRecoveryMetadata };

export type RecordingRecoveryService = {
  pickAndStage(options: { maxDurationSeconds: number }): Promise<StagedRecording | null>;
  inspect(staged: StagedRecording, options: { maxDurationSeconds: number }): Promise<AudioRecoveryMetadata>;
  remove(staged: StagedRecording): Promise<void>;
};
