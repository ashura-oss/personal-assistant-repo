import { CaptureStillActiveError } from '../privacy/audioBoundary';

export type NativeRecorderStatus = { isRecording: boolean; canRecord: boolean };

/**
 * A stop that returns is not sufficient proof: some native states treat stop
 * as a no-op while prepared. Accept an inactive/unprepared status directly;
 * otherwise disable recording and verify it cannot auto-resume. A paused
 * failed-stop cannot pass direct status proof; it can pass only after the
 * awaited recording-mode disable and a fresh valid inactive status read.
 */
export async function stopNativeRecorderWithProof(options: {
  stop: () => Promise<void>;
  disableRecording: () => Promise<void>;
  readRecordingFlag: () => boolean;
  readStatus: () => NativeRecorderStatus;
  wasPaused: boolean;
  message: string;
}): Promise<unknown | undefined> {
  let stopError: unknown;
  let stopFailed = false;
  try {
    await options.stop();
  } catch (error) { stopFailed = true; stopError = error; }

  let terminal = false;
  try {
    const recordingFlag = options.readRecordingFlag();
    const status = options.readStatus();
    terminal = recordingFlag === false && status.isRecording === false && status.canRecord === false;
  } catch {
    // A broken or incomplete status API is not proof that native I/O has stopped.
  }
  if (terminal && !(stopFailed && options.wasPaused)) return stopError;

  try {
    await options.disableRecording();
    const recordingFlag = options.readRecordingFlag();
    const status = options.readStatus();
    const disabledAndInactive = recordingFlag === false && status.isRecording === false && typeof status.canRecord === 'boolean';
    if (disabledAndInactive) return stopError;
  } catch {
    // Disabling or re-reading failed; retain the capture lease.
  }
  throw new CaptureStillActiveError(options.message);
}
