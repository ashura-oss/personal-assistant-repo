import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioPlayer, useAudioRecorder, useAudioRecorderState, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { AppState } from 'react-native';
import { CaptureStillActiveError } from '../privacy/audioBoundary';
import type { PrivacyAudioBoundary, PrivacyCaptureSession } from '../privacy/audioBoundary';
import type { PrivacyWriterScope } from '../privacy/types';
import type { AudioCapture, AudioCaptureStopResult } from './types';
import type { PendingCaptureJournalPort, PendingCaptureReceipt, PendingCaptureSafeStatus } from './pendingCaptureService.types';
import { stopNativeRecorderWithProof } from './nativeStopProof';
import { NativeCaptureLifecycle, type NativeCaptureOutcome } from './nativeCaptureLifecycle';
import { NativeCaptureIdentity } from './nativeCaptureIdentity';

const NATIVE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: 'document' as const,
  isMeteringEnabled: true,
};

export type NativeAudioCaptureOptions = Readonly<{ ready: boolean; maxAudioSeconds: number }>;

function validateLimit(value: number): number {
  if (!Number.isFinite(value) || value < 10 || value > 600) throw new Error('Recording limit must be between 10 and 600 seconds.');
  return value;
}

function statusReceipt(status: PendingCaptureSafeStatus): PendingCaptureReceipt | undefined {
  return status.kind === 'pending' ? status.receipt : undefined;
}

export function useAudioCapture(
  boundary?: PrivacyAudioBoundary,
  journal?: PendingCaptureJournalPort,
  options: NativeAudioCaptureOptions = { ready: false, maxAudioSeconds: 600 },
): AudioCapture {
  const requestReconcileRef = useRef<() => void>(() => undefined);
  const activeCapture = useRef(false);
  const startPending = useRef(false);
  const startGeneration = useRef(0);
  const closingIntent = useRef(false);
  const identity = useRef(new NativeCaptureIdentity());
  const receipt = useRef<PendingCaptureReceipt | null>(null);
  const journalBlocked = useRef(false);
  const pendingResult = useRef<AudioCaptureStopResult | null>(null);
  const lastObservation = useRef('');
  const captureLimit = useRef<number>(600);
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
  const [restoredJournal, setRestoredJournal] = useState<PendingCaptureJournalPort | null>(null);
  const captureSession = useRef<PrivacyCaptureSession | null>(null);
  const stopOnUnmount = useRef<() => Promise<unknown>>(async () => null);
  const reconciliationRunning = useRef(false);
  const reconciliationPending = useRef(false);
  const [lifecycle] = useState(() => new NativeCaptureLifecycle());
  const restored = options.ready && !!journal && restoredJournal === journal;

  const observeFreshStatus = useCallback((sample: ReturnType<typeof recorder.getStatus>) => {
    const snapshot = identity.current.observe(sample.url, sample.mediaServicesDidReset);
    if (activeCapture.current && !snapshot.recoveryRequired && sample.url === snapshot.originalUri && Number.isFinite(sample.durationMillis) && sample.durationMillis >= 0) {
      identity.current.observeDuration(sample.url, sample.durationMillis / 1000);
      setElapsed(sample.durationMillis / 1000);
    }
  }, [recorder]);

  const persistObservation = useCallback(async (scope: PrivacyWriterScope) => {
    const currentReceipt = receipt.current;
    const currentJournal = journal;
    if (!currentReceipt || !currentJournal) return;
    const snapshot = identity.current.snapshot();
    const key = JSON.stringify([snapshot.replacementUris, snapshot.replacementOverflow]);
    if (key === lastObservation.current) return;
    const next = await currentJournal.observe(scope, currentReceipt, {
      replacementUris: snapshot.replacementUris,
      replacementOverflow: snapshot.replacementOverflow,
    });
    receipt.current = next;
    lastObservation.current = key;
  }, [journal]);

  const observation = useCallback(() => {
    const snapshot = identity.current.snapshot();
    return { replacementUris: snapshot.replacementUris, replacementOverflow: snapshot.replacementOverflow };
  }, []);

  useEffect(() => {
    lifecycle.setIO({
      record: () => {
        if (closingIntent.current) throw new Error('Recording start was cancelled.');
        const fresh = recorder.getStatus();
        observeFreshStatus(fresh);
        const snapshot = identity.current.snapshot();
        if (!receipt.current || !snapshot.originalUri || snapshot.recoveryRequired || fresh.url !== snapshot.originalUri) {
          throw new Error('The prepared recording source could not be verified.');
        }
        const seconds = recorder.currentTime;
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('The current recording duration could not be verified. Stop or discard this recording before resuming.');
        const remaining = captureLimit.current - seconds;
        if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('The recording time limit has been reached. Stop and save this recording before continuing.');
        recorder.record({ forDuration: remaining });
      },
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
  }, [lifecycle, observeFreshStatus, recorder]);

  useEffect(() => {
    if (!options.ready || !journal) return;
    let current = true;
    void journal.getStatus().then((safe) => {
      if (!current) return;
      if (safe.kind === 'pending') {
        journalBlocked.current = false;
        receipt.current = safe.receipt;
        pendingResult.current = { kind: 'pending_capture', receipt: safe.receipt };
        setHasPending(true);
        if (safe.durationSeconds !== undefined) setElapsed(safe.durationSeconds);
        setStatus('idle'); setCanResume(false); setStatusLabel(undefined);
      } else if (safe.kind === 'empty') {
        journalBlocked.current = false;
        receipt.current = null; pendingResult.current = null;
        setHasPending(false);
      } else {
        journalBlocked.current = true;
        receipt.current = null; pendingResult.current = null;
        setHasPending(true); setCanResume(false); setStatusLabel('Recording needs review');
        setError('A saved recording is unavailable for automatic recovery. Review its status before recording again.');
      }
      setRestoredJournal(journal);
    }).catch(() => {
      if (!current) return;
      journalBlocked.current = true;
      setHasPending(true); setError('The pending recording journal could not be read. Retry recovery before recording.'); setRestoredJournal(journal);
    });
    return () => { current = false; };
  }, [journal, options.ready]);

  const applyLifecycleOutcome = useCallback((outcome: NativeCaptureOutcome) => {
    if (!lifecycle.isCurrent(outcome.generation)) return;
    setCanResume(outcome.canResume);
    setStatusLabel(outcome.state === 'paused' ? 'Paused'
      : outcome.state === 'recovery' ? 'Recording interrupted'
        : outcome.state === 'uncertain' ? 'Recording status uncertain' : undefined);
    setStatus(outcome.state === 'paused' || outcome.state === 'recovery' ? 'paused' : 'recording');
    if (outcome.state === 'recovery' && identity.current.snapshot().originalUri) setHasPending(true);
    if (outcome.message) setError(outcome.message);
  }, [lifecycle]);

  useEffect(() => {
    if (status !== 'recording' || recording.metering === undefined) return;
    const timer = setInterval(() => {
      const value = Math.max(0.08, Math.min(1, ((recording.metering ?? -60) + 60) / 60));
      setMeter(previous => [...previous.slice(1), value]);
    }, 150);
    return () => clearInterval(timer);
  }, [recording.metering, status]);

  const startActual = useCallback(async (scope: PrivacyWriterScope) => {
    setError(''); setCanResume(false); setStatusLabel(undefined);
    if (!boundary || !journal || !options.ready || !restored) throw new Error('Recording is unavailable until the workspace is ready.');
    if (receipt.current || pendingResult.current || identity.current.snapshot().originalUri) throw new Error('A recording is waiting to be saved or inspected. Save or discard it before starting another.');
    const permission = await requestRecordingPermissionsAsync();
    if (closingIntent.current) throw new Error('Recording start was cancelled.');
    if (!permission.granted) throw new Error('Microphone permission was denied. Allow microphone access in device Settings to record.');
    let recorderSetupAttempted = false;
    try {
      recorderSetupAttempted = true;
      // Keep the SDK's auto-resume gate closed until the prepared source has a
      // durable journal receipt. prepareToRecordAsync configures the native
      // recording session but does not need allowsRecording=true to prepare.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: false });
      if (closingIntent.current) throw new Error('Recording start was cancelled.');
      await recorder.prepareToRecordAsync(NATIVE_RECORDING_OPTIONS);
      const prepared = recorder.getStatus();
      if (closingIntent.current) throw new Error('Recording start was cancelled.');
      const anchor = { capturedAt: new Date().toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
      identity.current.begin(prepared.url, anchor);
      if (prepared.mediaServicesDidReset) identity.current.observe(prepared.url, true);
      const uri = identity.current.snapshot().originalUri;
      if (!uri) throw new Error('The device did not provide a recording file.');
      const created = await journal.prepare(scope, { uri, ...anchor });
      journalBlocked.current = false;
      receipt.current = created;
      pendingResult.current = { kind: 'pending_capture', receipt: created };
      lastObservation.current = JSON.stringify([[], false]);
      if (closingIntent.current) throw new Error('Recording start was cancelled.');
      const verified = recorder.getStatus();
      observeFreshStatus(verified);
      const verifiedIdentity = identity.current.snapshot();
      if (verified.url !== uri || verified.mediaServicesDidReset || verifiedIdentity.recoveryRequired || verifiedIdentity.originalUri !== uri) {
        throw new Error('The prepared recording source changed before recording could safely start. Review or discard it.');
      }
      activeCapture.current = true;
      const outcome = await lifecycle.start();
      applyLifecycleOutcome(outcome);
      if (outcome.state === 'recording') {
        const current = recorder.getStatus(); observeFreshStatus(current); setElapsed(0);
      } else if (!outcome.message) setError('Recording could not be confirmed. Stop or discard the recoverable audio.');
    } catch (cause) {
      if (recorderSetupAttempted) {
        try {
          await stopNativeRecorderWithProof({
            stop: () => recorder.stop(),
            disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
            readRecordingFlag: () => recorder.isRecording,
            readStatus: () => recorder.getStatus(),
            wasPaused: false,
            message: 'Recording setup failed while the device recorder may still be prepared or active. Retry Stop or discard before leaving.',
          });
        } catch (stopError) {
          activeCapture.current = true;
          identity.current.markRecoveryRequired();
          setStatus('recording'); setCanResume(false); setStatusLabel('Recording status uncertain');
          setHasPending(!!identity.current.snapshot().originalUri || !!receipt.current);
          setError('Recording setup failed and native stop could not be verified. Retry Stop or discard before leaving.');
          throw stopError instanceof CaptureStillActiveError
            ? stopError
            : new CaptureStillActiveError('The prepared recorder could not be proven stopped. Retry Stop or discard before leaving.');
        }
      }
      if (!activeCapture.current && identity.current.snapshot().originalUri) {
        identity.current.markRecoveryRequired(); setHasPending(true); setStatus('idle'); setCanResume(false); setStatusLabel('Recording interrupted');
        setError('The prepared recording needs inspection. No audio was saved. Review or discard it before starting another recording.');
      }
      if (cause instanceof CaptureStillActiveError) {
        activeCapture.current = true; setStatus('recording'); setCanResume(false); setStatusLabel('Recording status uncertain');
        setHasPending(!!identity.current.snapshot().originalUri);
        throw cause;
      }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
      throw cause;
    }
  }, [applyLifecycleOutcome, boundary, journal, lifecycle, observeFreshStatus, options.ready, recorder, restored]);

  const start = useCallback(async () => {
    if (!boundary || !journal) throw new Error('Secure recording storage is not configured.');
    if (!options.ready || !restored) throw new Error('The workspace must be ready before recording.');
    if (startPending.current || captureSession.current || activeCapture.current) throw new Error('A recording is already in progress.');
    captureLimit.current = validateLimit(options.maxAudioSeconds);
    const generation = ++startGeneration.current;
    startPending.current = true;
    try {
      const current = await journal.getStatus();
      if (generation !== startGeneration.current) throw new Error('Recording start was cancelled.');
      if (current.kind !== 'empty') throw new Error('A pending recording must be saved or discarded before starting another.');
      closingIntent.current = false;
      const session = boundary.beginCapture(startActual);
      captureSession.current = session;
      await session.ready;
      startPending.current = false;
    } catch (cause) {
      startPending.current = false;
      const session = captureSession.current;
      if (!(cause instanceof CaptureStillActiveError) && session && captureSession.current === session) { captureSession.current = null; journal?.released(); }
      setStatus(cause instanceof CaptureStillActiveError ? 'recording' : 'idle'); setCanResume(false);
      if (cause instanceof CaptureStillActiveError) setStatusLabel('Recording status uncertain');
      setError(cause instanceof Error ? cause.message : 'Could not start recording.');
      throw cause;
    }
  }, [boundary, journal, options.maxAudioSeconds, options.ready, restored, startActual]);

  const pauseActual = useCallback(async () => {
    try { observeFreshStatus(recorder.getStatus()); } catch { identity.current.observe(undefined); }
    const outcome = await lifecycle.pause();
    applyLifecycleOutcome(outcome);
  }, [applyLifecycleOutcome, lifecycle, observeFreshStatus, recorder]);
  const pause = useCallback(async () => {
    if (!activeCapture.current || status !== 'recording') return;
    const session = captureSession.current;
    if (session) await session.runAction(async (scope) => { await pauseActual(); await persistObservation(scope); });
  }, [pauseActual, persistObservation, status]);

  const resumeActual = useCallback(async () => {
    if (!canResume || closingIntent.current) return;
    try { observeFreshStatus(recorder.getStatus()); } catch { identity.current.observe(undefined); }
    if (identity.current.snapshot().recoveryRequired) {
      const outcome = await lifecycle.reconcile(); if (outcome) applyLifecycleOutcome(outcome); return;
    }
    const outcome = await lifecycle.resume(); applyLifecycleOutcome(outcome);
  }, [applyLifecycleOutcome, canResume, lifecycle, observeFreshStatus, recorder]);
  const resume = useCallback(async () => {
    if (!activeCapture.current || status !== 'paused' || !canResume) return;
    const session = captureSession.current;
    if (session) await session.runAction(async (scope) => { await resumeActual(); await persistObservation(scope); });
  }, [canResume, persistObservation, resumeActual, status]);

  const stopActual = useCallback(async (scope: PrivacyWriterScope): Promise<AudioCaptureStopResult | null> => {
    lifecycle.close();
    if (!activeCapture.current) return pendingResult.current;
    try { observeFreshStatus(recorder.getStatus()); }
    catch { identity.current.observe(undefined); }
    await stopNativeRecorderWithProof({
      stop: () => recorder.stop(),
      disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
      readRecordingFlag: () => recorder.isRecording,
      readStatus: () => { const value = recorder.getStatus(); observeFreshStatus(value); return value; },
      wasPaused: status === 'paused',
      message: 'The device recorder may still be active. Retry Stop or discard before leaving.',
    });
    lifecycle.finish();
    try { observeFreshStatus(recorder.getStatus()); } catch { identity.current.observe(undefined); }
    const snapshot = identity.current.snapshot();
    if (!journal) throw new Error('The prepared recording journal is unavailable.');
    let currentReceipt = receipt.current;
    if (!currentReceipt) {
      const safe = await journal.getStatus(scope);
      if (safe.kind === 'pending') {
        currentReceipt = safe.receipt;
        receipt.current = safe.receipt;
      }
    }
    if (!currentReceipt) {
      activeCapture.current = false;
      setStatus('idle'); setCanResume(false); setHasPending(!!snapshot.originalUri);
      setStatusLabel(snapshot.originalUri ? 'Recording interrupted' : undefined);
      setError(snapshot.originalUri
        ? 'The original recording is stopped but was not registered for saving. Use Discard to remove it safely.'
        : 'The recorder stopped, but no saved recording is available.');
      lifecycle.finish();
      return null;
    }
    const stoppedReceipt = await journal.stopped(scope, currentReceipt, observation());
    receipt.current = stoppedReceipt;
    pendingResult.current = { kind: 'pending_capture', receipt: stoppedReceipt };
    activeCapture.current = false;
    setElapsed(snapshot.originalDurationSeconds); setHasPending(true); setCanResume(false);
    if (snapshot.recoveryRequired || !snapshot.anchor) {
      setStatus('idle'); setStatusLabel('Recording interrupted');
      setError('The original recording needs inspection. No audio was saved. Review or discard it before starting another recording.');
    } else { setStatus('idle'); setStatusLabel(undefined); }
    try { await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }); }
    catch { setError('The recording was saved, but audio mode could not be reset. Restart playback if needed.'); }
    return pendingResult.current;
  }, [journal, lifecycle, observation, observeFreshStatus, recorder, status]);

  const stop = useCallback(async (): Promise<AudioCaptureStopResult | null> => {
    startGeneration.current += 1;
    closingIntent.current = true;
    lifecycle.close();
    const session = captureSession.current;
    if (!session) {
      if (journal) {
        const safe = await journal.getStatus();
        if (safe.kind === 'pending') {
          receipt.current = safe.receipt;
          pendingResult.current = { kind: 'pending_capture', receipt: safe.receipt };
          setHasPending(true);
        } else if (safe.kind === 'blocked') journalBlocked.current = true;
      }
      return pendingResult.current;
    }
    try {
      const result = await session.stop(async (scope) => {
        try { return await stopActual(scope); }
        catch (cause) {
          if (!(cause instanceof CaptureStillActiveError)) {
            // Quiescence completed; preserve the journal and let explicit recovery inspect it.
            activeCapture.current = false;
            setStatus('idle'); setCanResume(false); setHasPending(!!receipt.current || !!identity.current.snapshot().originalUri);
            if (receipt.current || identity.current.snapshot().originalUri) setStatusLabel('Recording needs review');
          }
          throw cause;
        }
      });
      if (captureSession.current === session) captureSession.current = null;
      journal?.released();
      return result;
    } catch (cause) {
      if (!(cause instanceof CaptureStillActiveError) && captureSession.current === session) {
        captureSession.current = null; journal?.released();
      }
      throw cause;
    }
  }, [journal, lifecycle, stopActual]);

  const cancel = useCallback(async () => {
    startGeneration.current += 1;
    closingIntent.current = true;
    lifecycle.close();
    const session = captureSession.current;
    const currentReceipt = receipt.current;
    if (!journal) throw new Error('Secure recording storage is not configured.');
    const applyDiscardResult = (safe: PendingCaptureSafeStatus) => {
      if (safe.kind === 'empty') {
        receipt.current = null; pendingResult.current = null; identity.current.clear(); journalBlocked.current = false;
        setHasPending(false); setCanResume(false); setStatusLabel(undefined); setElapsed(0); setStatus('idle'); setError('');
        return;
      }
      const latest = statusReceipt(safe);
      receipt.current = latest ?? null;
      pendingResult.current = latest ? { kind: 'pending_capture', receipt: latest } : null;
      journalBlocked.current = safe.kind === 'blocked';
      setHasPending(true); setCanResume(false); setStatus('idle');
      setStatusLabel(safe.kind === 'pending' ? 'Recording needs review' : 'Recording recovery unavailable');
      setError('The recording could not be fully discarded. Keep it for recovery and retry discard after reviewing its status.');
    };
    if (!session) {
      if (journalBlocked.current) throw new Error('The pending recording journal is blocked. Review recovery status before discarding.');
      let safe: PendingCaptureSafeStatus;
      if (currentReceipt) safe = await journal.discard(undefined, currentReceipt);
      else {
        const uri = identity.current.snapshot().originalUri;
        if (uri) safe = await journal.discardUnjournaled(undefined, uri);
        else safe = await journal.getStatus();
      }
      applyDiscardResult(safe);
      activeCapture.current = false;
      return;
    }
    try {
      await session.stop(async (scope) => {
        let quiescent = !activeCapture.current;
        if (activeCapture.current) {
          await stopNativeRecorderWithProof({
            stop: () => recorder.stop(),
            disableRecording: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }),
            readRecordingFlag: () => recorder.isRecording,
            readStatus: () => { const value = recorder.getStatus(); observeFreshStatus(value); return value; },
            wasPaused: status === 'paused',
            message: 'The device recorder may still be active. Retry discard before leaving.',
          });
          quiescent = true;
        }
        const snapshot = identity.current.snapshot();
        try {
          const safe = receipt.current
            ? await journal.discard(scope, receipt.current, observation())
            : snapshot.originalUri
              ? await journal.discardUnjournaled(scope, snapshot.originalUri)
              : await journal.getStatus(scope);
          await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
          applyDiscardResult(safe);
          activeCapture.current = false; lifecycle.finish();
        } catch (error) {
          if (quiescent) {
            activeCapture.current = false; lifecycle.finish(); setStatus('idle'); setCanResume(false); setHasPending(true);
            setStatusLabel('Recording needs review');
            setError('The recording stopped, but discard could not be confirmed. Keep it for recovery and retry.');
          }
          throw error;
        }
      });
      if (captureSession.current === session) captureSession.current = null;
      journal.released();
    } catch (cause) {
      if (!(cause instanceof CaptureStillActiveError)) { if (captureSession.current === session) captureSession.current = null; journal.released(); }
      throw cause;
    }
  }, [journal, lifecycle, observation, observeFreshStatus, recorder, status]);

  const commit = useCallback((captureIdOrUri: string) => {
    if (receipt.current?.id === captureIdOrUri) {
      receipt.current = null; pendingResult.current = null; identity.current.clear();
      setHasPending(false); setError(''); setStatus('idle'); setElapsed(0);
    }
  }, []);

  const refreshPendingRecovery = useCallback(async () => {
    if (!journal || activeCapture.current || captureSession.current) return;
    const safe = await journal.getStatus();
    const currentReceipt = statusReceipt(safe);
    journalBlocked.current = safe.kind === 'blocked';
    receipt.current = currentReceipt ?? null;
    pendingResult.current = currentReceipt ? { kind: 'pending_capture', receipt: currentReceipt } : null;
    setHasPending(safe.kind !== 'empty');
    if (safe.kind === 'pending' && safe.durationSeconds !== undefined) setElapsed(safe.durationSeconds);
    if (safe.kind === 'empty') { setError(''); setStatusLabel(undefined); }
  }, [journal]);

  const play = useCallback(async (uri: string) => {
    if (!boundary) throw new Error('Secure audio access is unavailable.');
    await boundary.withAudioRead(async () => { player.replace(uri); player.play(); });
  }, [boundary, player]);

  const requestReconcile = useCallback(() => {
    const session = captureSession.current;
    if (!session || !activeCapture.current || status === 'idle') return;
    if (reconciliationRunning.current) { reconciliationPending.current = true; return; }
    reconciliationRunning.current = true;
    void session.runAction(async (scope) => {
      const outcome = await lifecycle.reconcile();
      if (outcome) applyLifecycleOutcome(outcome);
      await persistObservation(scope);
    }).catch(() => undefined).finally(() => {
      reconciliationRunning.current = false;
      if (reconciliationPending.current) { reconciliationPending.current = false; requestReconcileRef.current(); }
    });
  }, [applyLifecycleOutcome, lifecycle, persistObservation, status]);
  useEffect(() => { requestReconcileRef.current = requestReconcile; }, [requestReconcile]);
  useEffect(() => {
    if (recording.isRecording !== undefined || recording.canRecord !== undefined || recording.mediaServicesDidReset || recording.url !== undefined || recording.durationMillis !== undefined) requestReconcile();
  }, [recording.isRecording, recording.canRecord, recording.mediaServicesDidReset, recording.url, recording.durationMillis, requestReconcile]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => { if (nextState === 'active') requestReconcile(); });
    return () => subscription.remove();
  }, [requestReconcile]);
  useEffect(() => { stopOnUnmount.current = stop; }, [stop]);
  useEffect(() => () => { void stopOnUnmount.current().catch(() => undefined); }, []);

  return {
    status, canResume, statusLabel, durationSeconds: elapsed, meter,
    error: recording.mediaServicesDidReset && status !== 'idle' ? (error || 'Recording was interrupted by the device audio service. Stop to save any recoverable audio.') : error,
    hasPending, start, pause, resume, stop, cancel, commit, play, refreshPendingRecovery,
  };
}
