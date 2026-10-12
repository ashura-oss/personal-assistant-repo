export type AudioStatus = 'idle' | 'recording' | 'paused';
export interface AudioCapture {
  status: AudioStatus;
  durationSeconds: number;
  meter: number[];
  error: string;
  hasPending: boolean;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<{ uri: string; durationSeconds: number } | null>;
  cancel(): Promise<void>;
  commit(uri: string): void;
  play(uri: string): Promise<void>;
}
