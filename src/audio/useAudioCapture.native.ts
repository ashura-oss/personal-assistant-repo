import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioPlayer, useAudioRecorder, useAudioRecorderState, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { CaptureStillActiveError } from '../privacy/audioBoundary';
import type { PrivacyAudioBoundary, PrivacyCaptureSession } from '../privacy/audioBoundary';
import type { AudioCapture } from './types';
import { stopNativeRecorderWithProof } from './nativeStopProof';
import { NativeCaptureLifecycle, type NativeCaptureOutcome } from './nativeCaptureLifecycle';
import { NativeCaptureIdentity } from './nativeCaptureIdentity';

const NATIVE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: 'document' as const,
  isMeteringEnabled: true,
};

export function useAudioCapture(boundary?: PrivacyAudioBoundary): AudioCapture {
  const requestReconcileRef = useRef<() => void>(() => undefined);
  const activeCapture = useRef(false);
  const identity = useRef(new NativeCaptureIdentity());
  const onRecorderStatus = useCallback((sample: { url: string | null; mediaServicesDidReset?: boolean }) => {
    if (activeCapture.current && sample.mediaServicesDidReset) {
      identity.current.observe(sample.url, true);
      requestReconcileRef.current();
    }
  }, []);
  const recorder = useAudioRecorder(NATIVE_RECORDING_OPTIONS, onRecorderStatus);
  const recording = useAudioRecorderState(recorder, 250);
  const player = useAudioPlayer(null);
  const [status, setStatus] = useState<AudioCapture['status']>('idle');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [meter, setMeter] = useState<number[]>(Array.from({ length: 37 }, () => 0.08));
  const [hasPending, setHasPending] = useState(false);
  const [canResume, setCanResume] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | undefined>();
  const captureSession = useRef<PrivacyCaptureSession | null>(null);
  const stopOnUnmount = useRef<() => Promise<unknown>>(async () => null);
  const reconciliationRunning = useRef(false);
  const reconciliationPending = useRef(false);
  const pending = useRef<{ uri: string; durationSeconds: number; capturedAt: string; captureTimeZone: string } | null>(null);
  const observeFreshStatus = useCallback((sample: ReturnType<typeof recorder.getStatus>) => {
    const snapshot = identity.current.observe(sample.url, sample.mediaServicesDidReset);
    if (activeCapture.current && !snapshot.recoveryRequired && sample.url === snapshot.originalUri) {
      identity.current.observeDuration(sample.url, sample.durationMillis / 1000);
      setElapsed(sample.durationMillis / 1000);
    }
  }, [recorder]);
  const [lifecycleController] = useState(() => new NativeCaptureLifecycle());
  useEffect(() => {
    lifecycleController.setIO({
      record: () => recorder.record(),
      pause: () => recorder.pause(),
      setRecordingEnabled: async (enabled) => {
        await setAudioModeAsync({ allowsRecording: enabled, playsInSilentMode: true, shouldPlayInBackground: false });
      },
      readFacts: () => {
        const facts = recorder.getStatus();
        observeFreshStatus(facts);
        return {
          isRecording: recorder.isRecording,
          statusRecording: facts.isRecording,
          canRecord: facts.canRecord,
          recoveryRequired: identity.current.snapshot().recoveryRequired,
        };
      },
    });
  }, [lifecycleController, observeFreshStatus, recorder]);

  const applyLifecycleOutcome = useCallback((outcome: NativeCaptureOutcome) => {
    if (!lifecycleController.isCurrent(outcome.generation)) return;
    setCanResume(outcome.canResume);
    setStatusLabel(outcome.state === 'paused' ? 'Paused'
      : outcome.state === 'recovery' ? 'Recording interrupted'
        : outcome.state === 'uncertain' ? 'Recording status uncertain' : undefined);
    setStatus(outcome.state === 'paused' || outcome.state === 'recovery' ? 'paused' : 'recording');
    if (outcome.state === 'recovery' && identity.current.snapshot().originalUri) setHasPending(true);
    if (outcome.message) setError(outcome.message);
  }, [lifecycleController]);

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
    setCanResume(false); setStatusLabel(undefined);
    if (pending.current || identity.current.snapshot().originalUri) throw new Error('A recording is waiting to be saved or inspected. Save or discard it before starting another.');
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error('Microphone permission was denied. Allow microphone access in device Settings to record.');
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
      // Expo reuses and overwrites the current recording URL when prepare receives no options.
      // Pass the same full options as the hook so each new capture gets a fresh file.
      await recorder.prepareToRecordAsync(NATIVE_RECORDING_OPTIONS);
      const prepared = recorder.getStatus();
      const anchor = { capturedAt: new Date().toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
      identity.current.begin(prepared.url, anchor);
      if (prepared.mediaServicesDidReset) identity.current.observe(prepared.url, true);
      activeCapture.current = true;
      const outcome = await lifecycleController.start();
      applyLifecycleOutcome(outcome);
      if (outcome.state === 'recording') {
        const current = recorder.getStatus();
        observeFreshStatus(current);
        setElapsed(0);
      } else if (!outcome.message) {
        setError('Recording could not be confirmed. Stop or discard the recoverable audio.');
      }
    } catch (error) {
      try {
        await stopNativeRecorderWithProof({
          stop: () => recorder.stop(),
          disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
          readRecordingFlag: () => recorder.isRecording,
          readStatus: () => { const value = recorder.getStatus(); observeFreshStatus(value); return value; },
          wasPaused: false,
          message: 'Recording setup failed while the device recorder may still be active. Stop or discard it before leaving.',
        });
      } catch (stopError) {
        activeCapture.current = true;
        setStatus('recording'); setCanResume(false); setStatusLabel('Recording status uncertain');
        if (stopError instanceof CaptureStillActiveError) throw stopError;
        throw new CaptureStillActiveError('The prepared recorder state could not be proven stopped. Stop or discard the recording before leaving.');
      }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
      if (identity.current.snapshot().originalUri) {
        identity.current.markRecoveryRequired();
        activeCapture.current = true;
        setStatus('paused'); setCanResume(false); setStatusLabel('Recording interrupted'); setHasPending(true);
        setError('The prepared recording needs inspection. No audio was saved. Discard it before starting another recording.');
      }
      throw error;
    }
  }, [applyLifecycleOutcome, lifecycleController, observeFreshStatus, recorder]);

  const start = useCallback(async () => {
    if (pending.current || identity.current.snapshot().originalUri) throw new Error('A recording is waiting to be saved or inspected. Save or discard it before starting another.');
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
        if (identity.current.snapshot().originalUri) {
          setStatus('paused'); setCanResume(false); setStatusLabel('Recording interrupted'); setHasPending(true);
        } else {
          setStatus('idle'); setCanResume(false); setStatusLabel(undefined);
        }
      }
      setError(error instanceof Error ? error.message : 'Could not start recording. Check microphone access and try again.');
      throw error;
    }
  }, [boundary, startActual]);

  const pauseActual = useCallback(async () => {
    try { observeFreshStatus(recorder.getStatus()); } catch { identity.current.observe(undefined); }
    const outcome = await lifecycleController.pause();
    applyLifecycleOutcome(outcome);
  }, [applyLifecycleOutcome, lifecycleController, observeFreshStatus, recorder]);
  const pause = useCallback(async () => {
    if (!activeCapture.current || status !== 'recording') return;
    const session = captureSession.current;
    if (session) await session.runAction(pauseActual);
    else if (boundary) await boundary.withAudioWrite(pauseActual);
    else await pauseActual();
  }, [boundary, pauseActual, status]);

  const resumeActual = useCallback(async () => {
    if (!canResume) return;
    try { observeFreshStatus(recorder.getStatus()); } catch { identity.current.observe(undefined); }
    if (identity.current.snapshot().recoveryRequired) {
      const outcome = await lifecycleController.reconcile();
      if (outcome) applyLifecycleOutcome(outcome);
      return;
    }
    const outcome = await lifecycleController.resume();
    applyLifecycleOutcome(outcome);
  }, [applyLifecycleOutcome, canResume, lifecycleController, observeFreshStatus, recorder]);
  const resume = useCallback(async () => {
    if (!activeCapture.current || status !== 'paused') return;
    const session = captureSession.current;
    if (session) await session.runAction(resumeActual);
    else if (boundary) await boundary.withAudioWrite(resumeActual);
    else await resumeActual();
  }, [boundary, resumeActual, status]);

  const stopActual = useCallback(async () => {
    lifecycleController.close();
    if (pending.current) return pending.current;
    if (!activeCapture.current) return null;
    try {
      const sample = recorder.getStatus();
      observeFreshStatus(sample);
    } catch { /* The missing sample is itself a recovery condition. */ identity.current.observe(undefined); }
    let stopError: unknown;
    stopError = await stopNativeRecorderWithProof({
      stop: () => recorder.stop(),
      disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
      readRecordingFlag: () => recorder.isRecording,
      readStatus: () => { const value = recorder.getStatus(); observeFreshStatus(value); return value; },
      wasPaused: status === 'paused',
      message: 'The device recorder may still be active. Retry Stop or discard before leaving.',
    });
    lifecycleController.finish();
    const finalStatus = recorder.getStatus();
    observeFreshStatus(finalStatus);
    const identitySnapshot = identity.current.snapshot();
    const uri = identitySnapshot.originalUri;
    setElapsed(identitySnapshot.originalDurationSeconds);
    activeCapture.current = false;
    try {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch {
      if (!identity.current.snapshot().recoveryRequired) setError(uri ? 'The recording was saved, but audio mode could not be reset. Restart playback if needed.' : 'The device audio mode could not be reset after recording.');
    }
    if (identitySnapshot.recoveryRequired || !identitySnapshot.anchor) {
      setStatus('paused'); setCanResume(false); setStatusLabel('Recording interrupted'); setHasPending(true);
      setError('The original recording needs inspection. No audio was saved. Discard it before starting another recording.');
      return null;
    }
    setStatus('idle'); setCanResume(false); setStatusLabel(undefined);
    if (uri) {
      pending.current = {
        uri,
        durationSeconds: identitySnapshot.originalDurationSeconds,
        ...identitySnapshot.anchor!,
      };
      setHasPending(true);
      if (stopError) setError('The recorder stopped with a recoverable file. Save it again to keep the audio.');
      return pending.current;
    }
    setError(stopError instanceof Error ? stopError.message : 'Could not save the recording. The device did not provide a recoverable audio file.');
    if (stopError) throw stopError;
    throw new Error('The device did not finish writing the recording. Your saved notes were not changed.');
  }, [lifecycleController, observeFreshStatus, recorder, status]);

  const stop = useCallback(async () => {
    lifecycleController.close();
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
  }, [boundary, lifecycleController, stopActual]);

  const cancelActual = useCallback(async () => {
    lifecycleController.close();
    let uri = pending.current?.uri ?? identity.current.snapshot().originalUri ?? undefined;
    let stopFailure: unknown;
    if (activeCapture.current) {
      stopFailure = await stopNativeRecorderWithProof({
        stop: () => recorder.stop(),
        disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
        readRecordingFlag: () => recorder.isRecording,
        readStatus: () => { const value = recorder.getStatus(); observeFreshStatus(value); return value; },
        wasPaused: status === 'paused',
        message: 'The device recorder may still be active. Retry discard before leaving.',
      });
      try { observeFreshStatus(recorder.getStatus()); }
      catch {
        identity.current.observe(undefined);
        throw new Error('The recorder stopped, but its saved file could not be inspected. Keep the app open and retry from the recording screen.');
      }
      activeCapture.current = false;
    }
    lifecycleController.finish();
    let deleteFailure: unknown;
    const identitySnapshot = identity.current.snapshot();
    const knownUris = [...new Set([uri, ...identitySnapshot.replacementUris].filter((item): item is string => !!item))];
    try {
      if (!uri) throw new Error('The original recording location is unavailable.');
      for (const knownUri of knownUris) await FileSystem.deleteAsync(knownUri, { idempotent: true });
      if (identitySnapshot.replacementOverflow) {
        setHasPending(true); setStatus('paused'); setCanResume(false); setStatusLabel('Recording interrupted');
        setError('Some replacement recording files could not be tracked. Keep the original recording reference and retry discard.');
      } else {
        pending.current = null; identity.current.clear();
        setHasPending(false); setCanResume(false); setStatusLabel(undefined);
        setElapsed(0); setStatus('idle'); setError('');
      }
    } catch (error) {
      deleteFailure = error;
      if (uri && !pending.current && !identitySnapshot.recoveryRequired && identitySnapshot.anchor) {
        pending.current = {
          uri,
          durationSeconds: identitySnapshot.originalDurationSeconds,
          ...identitySnapshot.anchor,
        };
        setHasPending(true);
      }
      setHasPending(true); setStatus('paused'); setCanResume(false); setStatusLabel('Recording interrupted');
      setError('The unsaved recording could not be removed. Try discarding it again.');
    } finally {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
    }
    if (deleteFailure) throw deleteFailure;
    if (stopFailure) throw stopFailure;
  }, [lifecycleController, observeFreshStatus, recorder, status]);
  const cancel = useCallback(async () => {
    lifecycleController.close();
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
  }, [boundary, cancelActual, lifecycleController]);

  const commit = useCallback((uri: string) => {
    if (pending.current?.uri === uri) {
      pending.current = null; identity.current.clear();
      setHasPending(false);
    }
  }, []);
  const play = useCallback(async (uri: string) => {
    const playActual = async () => { player.replace(uri); player.play(); };
    if (boundary) await boundary.withAudioRead(playActual);
    else await playActual();
  }, [boundary, player]);

  const requestReconcile = useCallback(() => {
    const session = captureSession.current;
    if (!session || !activeCapture.current || status === 'idle') return;
    if (reconciliationRunning.current) { reconciliationPending.current = true; return; }
    reconciliationRunning.current = true;
    void session.runAction(async () => {
      const outcome = await lifecycleController.reconcile();
      if (outcome) applyLifecycleOutcome(outcome);
    }).catch(() => undefined).finally(() => {
      reconciliationRunning.current = false;
      if (reconciliationPending.current) {
        reconciliationPending.current = false;
        requestReconcileRef.current();
      }
    });
  }, [applyLifecycleOutcome, lifecycleController, status]);
  useEffect(() => { requestReconcileRef.current = requestReconcile; }, [requestReconcile]);

  // useAudioRecorderState already polls at 250 ms; only changed native samples enqueue one coalesced check.
  useEffect(() => {
    if (recording.isRecording !== undefined || recording.canRecord !== undefined || recording.mediaServicesDidReset || recording.url !== undefined) requestReconcile();
  }, [recording.isRecording, recording.canRecord, recording.mediaServicesDidReset, recording.url, recording.durationMillis, requestReconcile]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') requestReconcile();
    });
    return () => subscription.remove();
  }, [requestReconcile]);

  useEffect(() => { stopOnUnmount.current = stop; }, [stop]);
  useEffect(() => () => { void stopOnUnmount.current().catch(() => undefined); }, []);

  const visibleError = recording.mediaServicesDidReset && status !== 'idle'
    ? (error || 'Recording was interrupted by the device audio service. Stop to save any recoverable audio.')
    : error;
  return {
    status,
    canResume,
    statusLabel,
    durationSeconds: elapsed,
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
