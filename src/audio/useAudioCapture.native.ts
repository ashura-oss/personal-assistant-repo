import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioPlayer, useAudioRecorder, useAudioRecorderState, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { CaptureStillActiveError } from '../privacy/audioBoundary';
import type { PrivacyAudioBoundary, PrivacyCaptureSession } from '../privacy/audioBoundary';
import type { AudioCapture } from './types';
import { stopNativeRecorderWithProof } from './nativeStopProof';

export function useAudioCapture(boundary?: PrivacyAudioBoundary): AudioCapture {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: 'document', isMeteringEnabled: true });
  const recording = useAudioRecorderState(recorder, 250);
  const player = useAudioPlayer(null);
  const [status, setStatus] = useState<AudioCapture['status']>('idle');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [meter, setMeter] = useState<number[]>(Array.from({ length: 37 }, () => 0.08));
  const [hasPending, setHasPending] = useState(false);
  const activeCapture = useRef(false);
  const captureSession = useRef<PrivacyCaptureSession | null>(null);
  const stopOnUnmount = useRef<() => Promise<unknown>>(async () => null);
  const pending = useRef<{ uri: string; durationSeconds: number; capturedAt: string; captureTimeZone: string } | null>(null);
  const captureAnchor = useRef<{ capturedAt: string; captureTimeZone: string } | null>(null);

  useEffect(() => {
    if (status !== 'recording' || recording.metering === undefined) return;
    const timer = setInterval(() => {
      const value = Math.max(0.08, Math.min(1, ((recording.metering ?? -60) + 60) / 60));
      setMeter(previous => [...previous.slice(1), value]);
    }, 150);
    return () => clearInterval(timer);
  }, [recording.metering, status]);

  const startActual = useCallback(async () => {
    setError('');
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error('Microphone permission was denied. Allow microphone access in device Settings to record.');
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
      await recorder.prepareToRecordAsync();
      recorder.record();
      captureAnchor.current = { capturedAt: new Date().toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
      activeCapture.current = true;
      setElapsed(0); setStatus('recording');
    } catch (error) {
      try {
        await stopNativeRecorderWithProof({
          stop: () => recorder.stop(),
          disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
          readRecordingFlag: () => recorder.isRecording,
          readStatus: () => recorder.getStatus(),
          wasPaused: false,
          message: 'Recording setup failed while the device recorder may still be active. Stop or discard it before leaving.',
        });
      } catch (stopError) {
        if (stopError instanceof CaptureStillActiveError) {
          activeCapture.current = true;
          setStatus('paused');
          throw stopError;
        }
      }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
      throw error;
    }
  }, [recorder]);

  const start = useCallback(async () => {
    if (pending.current) throw new Error('A recording is waiting to be saved. Save it or discard it before starting another.');
    if (captureSession.current || activeCapture.current) throw new Error('A recording is already in progress.');
    try {
      if (boundary) {
        const session = boundary.beginCapture(startActual);
        captureSession.current = session;
        await session.ready;
      } else {
        await startActual();
      }
    } catch (error) {
      if (!(error instanceof CaptureStillActiveError)) {
        captureSession.current = null;
        setStatus('idle');
      }
      setError(error instanceof Error ? error.message : 'Could not start recording. Check microphone access and try again.');
      throw error;
    }
  }, [boundary, startActual]);

  const pauseActual = useCallback(async () => {
    recorder.pause();
    setStatus('paused');
  }, [recorder]);
  const pause = useCallback(async () => {
    if (!activeCapture.current || status !== 'recording') return;
    const session = captureSession.current;
    if (session) await session.runAction(pauseActual);
    else if (boundary) await boundary.withAudioWrite(pauseActual);
    else await pauseActual();
  }, [boundary, pauseActual, status]);

  const resumeActual = useCallback(async () => {
    recorder.record();
    setStatus('recording');
  }, [recorder]);
  const resume = useCallback(async () => {
    if (!activeCapture.current || status !== 'paused') return;
    const session = captureSession.current;
    if (session) await session.runAction(resumeActual);
    else if (boundary) await boundary.withAudioWrite(resumeActual);
    else await resumeActual();
  }, [boundary, resumeActual, status]);

  const stopActual = useCallback(async () => {
    if (pending.current) return pending.current;
    if (!activeCapture.current) return null;
    const durationSeconds = Math.max(0, recording.durationMillis / 1000 || elapsed);
    let stopError: unknown;
    stopError = await stopNativeRecorderWithProof({
      stop: () => recorder.stop(),
      disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
      readRecordingFlag: () => recorder.isRecording,
      readStatus: () => recorder.getStatus(),
      wasPaused: status === 'paused',
      message: 'The device recorder may still be active. Retry Stop or discard before leaving.',
    });
    const uri = recorder.getStatus().url;
    activeCapture.current = false;
    setStatus('idle');
    try {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch {
      setError(uri ? 'The recording was saved, but audio mode could not be reset. Restart playback if needed.' : 'The device audio mode could not be reset after recording.');
    }
    if (uri) {
      pending.current = {
        uri,
        durationSeconds,
        ...(captureAnchor.current ?? { capturedAt: new Date().toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
      };
      setHasPending(true);
      if (stopError) setError('The recorder stopped with a recoverable file. Save it again to keep the audio.');
      return pending.current;
    }
    setError(stopError instanceof Error ? stopError.message : 'Could not save the recording. The device did not provide a recoverable audio file.');
    if (stopError) throw stopError;
    throw new Error('The device did not finish writing the recording. Your saved notes were not changed.');
  }, [elapsed, recorder, recording.durationMillis, status]);

  const stop = useCallback(async () => {
    const session = captureSession.current;
    if (!boundary) return stopActual();
    if (!session) return boundary.withAudioWrite(stopActual);
    try {
      const result = await session.stop(stopActual);
      if (captureSession.current === session) captureSession.current = null;
      return result;
    } catch (error) {
      if (!(error instanceof CaptureStillActiveError) && captureSession.current === session) captureSession.current = null;
      throw error;
    }
  }, [boundary, stopActual]);

  const cancelActual = useCallback(async () => {
    let uri = pending.current?.uri;
    let stopFailure: unknown;
    if (activeCapture.current) {
      stopFailure = await stopNativeRecorderWithProof({
        stop: () => recorder.stop(),
        disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
        readRecordingFlag: () => recorder.isRecording,
        readStatus: () => recorder.getStatus(),
        wasPaused: status === 'paused',
        message: 'The device recorder may still be active. Retry discard before leaving.',
      });
      try { uri = recorder.getStatus().url ?? uri; }
      catch {
        activeCapture.current = false;
        setStatus('idle');
        throw new Error('The recorder stopped, but its saved file could not be inspected. Keep the app open and retry from the recording screen.');
      }
      activeCapture.current = false;
    }
    let deleteFailure: unknown;
    try {
      if (uri) await FileSystem.deleteAsync(uri, { idempotent: true });
      pending.current = null; captureAnchor.current = null; setHasPending(false);
      setElapsed(0); setStatus('idle'); setError('');
    } catch (error) {
      deleteFailure = error;
      if (uri && !pending.current) {
        pending.current = {
          uri,
          durationSeconds: Math.max(0, recording.durationMillis / 1000 || elapsed),
          ...(captureAnchor.current ?? { capturedAt: new Date().toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
        };
        setHasPending(true);
      }
      setError('The unsaved recording could not be removed. Try discarding it again.');
    } finally {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
    }
    if (deleteFailure) throw deleteFailure;
    if (stopFailure) throw stopFailure;
  }, [elapsed, recorder, recording.durationMillis, status]);
  const cancel = useCallback(async () => {
    const session = captureSession.current;
    if (session) {
      try {
        await session.stop(cancelActual);
        if (captureSession.current === session) captureSession.current = null;
      } catch (error) {
        if (!(error instanceof CaptureStillActiveError) && captureSession.current === session) captureSession.current = null;
        throw error;
      }
      return;
    }
    if (boundary) await boundary.withAudioWrite(cancelActual);
    else await cancelActual();
  }, [boundary, cancelActual]);

  const commit = useCallback((uri: string) => {
    if (pending.current?.uri === uri) { pending.current = null; captureAnchor.current = null; setHasPending(false); }
  }, []);
  const play = useCallback(async (uri: string) => {
    const playActual = async () => { player.replace(uri); player.play(); };
    if (boundary) await boundary.withAudioRead(playActual);
    else await playActual();
  }, [boundary, player]);

  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => setElapsed(Math.max(0, recording.durationMillis / 1000 || elapsed)), 250);
    return () => clearInterval(timer);
  }, [elapsed, recording.durationMillis, status]);

  useEffect(() => { stopOnUnmount.current = stop; }, [stop]);
  useEffect(() => () => { void stopOnUnmount.current().catch(() => undefined); }, []);

  const visibleError = recording.mediaServicesDidReset && status !== 'idle'
    ? 'Recording was interrupted by the device audio service. Stop to save any recoverable audio.'
    : error;
  return {
    status: recording.mediaServicesDidReset && status !== 'idle' ? 'paused' : status,
    durationSeconds: Math.max(0, recording.durationMillis / 1000 || elapsed),
    meter,
    error: visibleError,
    hasPending,
    start,
    pause,
    resume,
    stop,
    cancel,
    commit,
    play,
  };
}
