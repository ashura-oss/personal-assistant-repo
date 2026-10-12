import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioPlayer, useAudioRecorder, useAudioRecorderState, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import type { AudioCapture } from './types';

export function useAudioCapture(): AudioCapture {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: 'document', isMeteringEnabled: true });
  const recording = useAudioRecorderState(recorder, 250);
  const player = useAudioPlayer(null);
  const [status, setStatus] = useState<AudioCapture['status']>('idle');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [meter, setMeter] = useState<number[]>(Array.from({ length: 37 }, () => 0.08));
  const [hasPending, setHasPending] = useState(false);
  const activeCapture = useRef(false);
  const pending = useRef<{ uri: string; durationSeconds: number } | null>(null);

  useEffect(() => {
    if (status !== 'recording' || recording.metering === undefined) return;
    const timer = setInterval(() => {
      const value = Math.max(0.08, Math.min(1, ((recording.metering ?? -60) + 60) / 60));
      setMeter(previous => [...previous.slice(1), value]);
    }, 150);
    return () => clearInterval(timer);
  }, [recording.metering, status]);

  const start = useCallback(async () => {
    setError('');
    if (pending.current) throw new Error('A recording is waiting to be saved. Save it or discard it before starting another.');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error('Microphone permission was denied. Allow microphone access in device Settings to record.');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false });
      await recorder.prepareToRecordAsync();
      recorder.record();
      activeCapture.current = true;
      setElapsed(0); setStatus('recording');
    } catch (e) {
      setStatus('idle');
      setError(e instanceof Error ? e.message : 'Could not start recording. Check microphone access and try again.');
      throw e;
    }
  }, [recorder]);
  const pause = useCallback(async () => { recorder.pause(); setStatus('paused'); }, [recorder]);
  const resume = useCallback(async () => { recorder.record(); setStatus('recording'); }, [recorder]);
  const stop = useCallback(async () => {
    if (pending.current) return pending.current;
    if (status === 'idle') return null;
    const durationSeconds = Math.max(0, recording.durationMillis / 1000 || elapsed);
    try {
      await recorder.stop();
      const uri = recorder.getStatus().url;
      if (!uri) throw new Error('The device did not finish writing the recording. Your saved notes were not changed.');
      pending.current = { uri, durationSeconds };
      setHasPending(true);
      activeCapture.current = false;
      setStatus('idle');
      try { await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }); } catch { setError('The recording was saved, but audio mode could not be reset. Restart playback if needed.'); }
      return pending.current;
    } catch (e) {
      const partialUri = recorder.getStatus().url;
      if (partialUri) {
        pending.current = { uri: partialUri, durationSeconds };
        setHasPending(true);
        activeCapture.current = false;
        setStatus('idle');
        setError('The recorder stopped with a recoverable file. Save it again to keep the audio.');
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
        return pending.current;
      }
      setError(e instanceof Error ? e.message : 'Could not save the recording. The device did not provide a recoverable audio file.');
      throw e;
    }
  }, [elapsed, recorder, recording.durationMillis, status]);
  const cancel = useCallback(async () => {
    let uri = pending.current?.uri;
    if (activeCapture.current) {
      await recorder.stop();
      uri = recorder.getStatus().url ?? undefined;
    }
    if (uri) await FileSystem.deleteAsync(uri, { idempotent: true });
    pending.current = null; setHasPending(false); activeCapture.current = false;
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
    setElapsed(0); setStatus('idle'); setError('');
  }, [recorder]);
  const commit = useCallback((uri: string) => { if (pending.current?.uri === uri) { pending.current = null; setHasPending(false); } }, []);
  const play = useCallback(async (uri: string) => {
    player.replace(uri); player.play();
  }, [player]);

  const visibleError = recording.mediaServicesDidReset ? 'Recording was interrupted by the device audio service. Stop to save any recoverable audio.' : error;
  return { status: recording.mediaServicesDidReset && status !== 'idle' ? 'paused' : status, durationSeconds: Math.max(0, recording.durationMillis / 1000 || elapsed), meter, error: visibleError, hasPending, start, pause, resume, stop, cancel, commit, play };
}
