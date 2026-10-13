import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptureStillActiveError } from '../privacy/audioBoundary';
import type { PrivacyAudioBoundary, PrivacyCaptureSession } from '../privacy/audioBoundary';
import type { AudioCapture } from './types';
import { getAudio, putAudio, removeAudio } from './blobStore.web';

type PendingClip = { blob: Blob; uri: string; durationSeconds: number; capturedAt: string; captureTimeZone: string };

function isRecorderActive(active: MediaRecorder | null | undefined): boolean {
  return !!active && active.state !== 'inactive';
}

export function useAudioCapture(boundary?: PrivacyAudioBoundary): AudioCapture {
  const [status, setStatus] = useState<AudioCapture['status']>('idle');
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [meter, setMeter] = useState<number[]>(Array.from({ length: 37 }, (_, i) => 0.14 + (i % 5) * 0.07));
  const [error, setError] = useState('');
  const [hasPending, setHasPending] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const startAt = useRef(0);
  const elapsedBeforePause = useRef(0);
  const audioContext = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);
  const pending = useRef<PendingClip | null>(null);
  const captureAnchor = useRef<{ capturedAt: string; captureTimeZone: string } | null>(null);
  const currentPlayer = useRef<HTMLAudioElement | null>(null);
  const playerObjectUrl = useRef<string | null>(null);
  const captureSession = useRef<PrivacyCaptureSession | null>(null);
  const stopOnUnmount = useRef<() => Promise<unknown>>(async () => null);

  const closeMeter = useCallback(async () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    const context = audioContext.current; audioContext.current = null;
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }, []);

  const startActual = useCallback(async () => {
    setError('');
    if (pending.current) throw new Error('A recording is waiting to be saved. Save it or discard it before starting another.');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('This browser cannot record audio. Use a current browser over HTTPS or localhost, or use the iOS app.');
    }
    let media: MediaStream | null = null;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media; chunks.current = []; elapsedBeforePause.current = 0;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      active.ondataavailable = event => { if (event.data.size) chunks.current.push(event.data); };
      recorder.current = active;
      active.start(250); startAt.current = Date.now();
      captureAnchor.current = { capturedAt: new Date(startAt.current).toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
      setDurationSeconds(0); setStatus('recording');
      if (window.AudioContext) {
        const context = new AudioContext(); audioContext.current = context;
        const source = context.createMediaStreamSource(media); const analyser = context.createAnalyser(); analyser.fftSize = 128; source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const sample = () => {
          analyser.getByteFrequencyData(data);
          const bars = Array.from({ length: 37 }, (_, i) => Math.max(.08, Math.min(1, (data[Math.floor(i * data.length / 37)] ?? 16) / 180)));
          setMeter(bars); raf.current = requestAnimationFrame(sample);
        };
        sample();
      }
    } catch (cause) {
      const active = recorder.current;
      if (isRecorderActive(active)) {
        try {
          await new Promise<void>((resolve, reject) => {
            active!.onstop = () => resolve();
            try { active!.stop(); } catch (error) { reject(error); }
          });
        } catch {
          if (isRecorderActive(active)) {
            setStatus('paused');
            setError('Recording setup failed while the browser recorder may still be active. Stop or discard it before leaving.');
            throw new CaptureStillActiveError('Recording setup failed while the browser recorder may still be active.');
          }
        }
      }
      media?.getTracks().forEach(track => track.stop()); stream.current = null;
      recorder.current = null; await closeMeter();
      const permissionError = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
      const message = permissionError ? 'Microphone permission was denied. Allow microphone access in your browser settings to record.' : cause instanceof Error ? cause.message : 'Could not start recording.';
      setError(message); setStatus('idle'); throw new Error(message);
    }
  }, [closeMeter]);

  const start = useCallback(async () => {
    if (captureSession.current || recorder.current) throw new Error('A recording is already in progress.');
    try {
      if (boundary) {
        const session = boundary.beginCapture(startActual);
        captureSession.current = session;
        await session.ready;
      } else await startActual();
    } catch (cause) {
      if (!(cause instanceof CaptureStillActiveError)) {
        captureSession.current = null;
        setStatus('idle');
      } else {
        setStatus('paused');
      }
      throw cause;
    }
  }, [boundary, startActual]);

  const pauseActual = useCallback(async () => {
    const active = recorder.current;
    if (active?.state !== 'recording') return;
    active.pause(); elapsedBeforePause.current += (Date.now() - startAt.current) / 1000;
    setDurationSeconds(elapsedBeforePause.current); setStatus('paused');
  }, []);
  const pause = useCallback(async () => {
    const session = captureSession.current;
    if (session) await session.runAction(pauseActual);
    else if (boundary) await boundary.withAudioWrite(pauseActual);
    else await pauseActual();
  }, [boundary, pauseActual]);

  const resumeActual = useCallback(async () => {
    const active = recorder.current;
    if (active?.state !== 'paused') return;
    active.resume(); startAt.current = Date.now(); setStatus('recording');
  }, []);
  const resume = useCallback(async () => {
    const session = captureSession.current;
    if (session) await session.runAction(resumeActual);
    else if (boundary) await boundary.withAudioWrite(resumeActual);
    else await resumeActual();
  }, [boundary, resumeActual]);

  const stopActual = useCallback(async () => {
    const existing = pending.current;
    if (existing) {
      await putAudio(existing.uri.replace(/^indexeddb-audio:/, ''), existing.blob);
      setStatus('idle'); setDurationSeconds(existing.durationSeconds);
      return { uri: existing.uri, durationSeconds: existing.durationSeconds, capturedAt: existing.capturedAt, captureTimeZone: existing.captureTimeZone };
    }
    const active = recorder.current;
    if (!active) return null;
    const duration = elapsedBeforePause.current + (active.state === 'recording' ? (Date.now() - startAt.current) / 1000 : 0);
    let blob: Blob;
    let stopConfirmed = active.state === 'inactive';
    try {
      if (stopConfirmed) {
        blob = new Blob(chunks.current, { type: active.mimeType || 'audio/webm' });
      } else {
        try {
          blob = await new Promise<Blob>((resolve, reject) => {
          let recorderError = false;
          active.onstop = () => {
            if (recorderError && chunks.current.length === 0) reject(new Error('The browser recorder stopped without recoverable audio.'));
            else resolve(new Blob(chunks.current, { type: active.mimeType || 'audio/webm' }));
          };
          active.onerror = () => { recorderError = true; };
          try { active.stop(); } catch (error) { reject(error); }
          });
          stopConfirmed = true;
        } catch (error) {
          if (active.state !== 'inactive') throw new CaptureStillActiveError('The browser recorder may still be active. Retry Stop or discard before leaving.');
          stopConfirmed = true;
          throw error;
        }
      }
    } finally {
      if (stopConfirmed) {
        stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; await closeMeter();
      }
    }
    const uri = `indexeddb-audio:${crypto.randomUUID()}`;
    const anchor = captureAnchor.current ?? { capturedAt: new Date().toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
    pending.current = { blob, uri, durationSeconds: duration, ...anchor };
    setHasPending(true); recorder.current = null; setStatus('idle'); setDurationSeconds(duration);
    await putAudio(uri.replace(/^indexeddb-audio:/, ''), blob);
    return { uri, durationSeconds: duration, capturedAt: anchor.capturedAt, captureTimeZone: anchor.captureTimeZone };
  }, [closeMeter]);

  const stop = useCallback(async () => {
    const session = captureSession.current;
    if (!boundary) return stopActual();
    if (!session) return boundary.withAudioWrite(stopActual);
    try {
      const result = await session.stop(stopActual);
      if (captureSession.current === session) captureSession.current = null;
      return result;
    } catch (cause) {
      if (!(cause instanceof CaptureStillActiveError) && captureSession.current === session) captureSession.current = null;
      throw cause;
    }
  }, [boundary, stopActual]);

  const cancelActual = useCallback(async () => {
    const active = recorder.current;
    if (isRecorderActive(active)) {
      try {
        await new Promise<void>((resolve, reject) => {
          active!.onstop = () => resolve();
          active!.onerror = () => { /* Wait for onstop before releasing the capture lease. */ };
          try { active!.stop(); } catch (error) { reject(error); }
        });
      } catch (error) {
        if (isRecorderActive(active)) throw new CaptureStillActiveError('The browser recorder may still be active. Retry discard before leaving.');
        throw error;
      }
    }
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; await closeMeter();
    if (pending.current) await removeAudio(pending.current.uri);
    pending.current = null; captureAnchor.current = null; setHasPending(false); recorder.current = null; chunks.current = [];
    setStatus('idle'); setDurationSeconds(0); setError('');
  }, [closeMeter]);
  const cancel = useCallback(async () => {
    const session = captureSession.current;
    if (session) {
      try {
        await session.stop(cancelActual);
        if (captureSession.current === session) captureSession.current = null;
      } catch (cause) {
        if (!(cause instanceof CaptureStillActiveError) && captureSession.current === session) captureSession.current = null;
        throw cause;
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
    const playActual = async () => {
      currentPlayer.current?.pause(); currentPlayer.current?.removeAttribute('src'); currentPlayer.current = null;
      if (playerObjectUrl.current) URL.revokeObjectURL(playerObjectUrl.current);
      const blob = await getAudio(uri);
      const objectUrl = URL.createObjectURL(blob); const audio = new Audio(objectUrl);
      currentPlayer.current = audio; playerObjectUrl.current = objectUrl;
      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        if (playerObjectUrl.current === objectUrl) playerObjectUrl.current = null;
        if (currentPlayer.current === audio) currentPlayer.current = null;
      };
      audio.onended = cleanup; audio.onerror = () => { cleanup(); setError('This saved recording could not be played in this browser.'); };
      try { await audio.play(); } catch (cause) { cleanup(); throw cause; }
    };
    if (boundary) await boundary.withAudioRead(playActual);
    else await playActual();
  }, [boundary]);

  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => setDurationSeconds(elapsedBeforePause.current + (Date.now() - startAt.current) / 1000), 250);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => { stopOnUnmount.current = stop; }, [stop]);
  useEffect(() => () => {
    void stopOnUnmount.current().catch(() => undefined);
    currentPlayer.current?.pause();
    if (playerObjectUrl.current) URL.revokeObjectURL(playerObjectUrl.current);
  }, []);

  return {
    status,
    // MediaRecorder is the authoritative resumability source; status alone is not enough after a failed start.
    // eslint-disable-next-line react-hooks/refs
    canResume: status === 'paused' && recorder.current?.state === 'paused',
    durationSeconds, meter, error, hasPending, start, pause, resume, stop, cancel, commit, play,
  };
}
