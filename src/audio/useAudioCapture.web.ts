import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioCapture } from './types';
import { getAudio, putAudio, removeAudio } from './blobStore.web';

export function useAudioCapture(): AudioCapture {
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
  const pending = useRef<{ blob: Blob; uri: string; durationSeconds: number; capturedAt: string; captureTimeZone: string } | null>(null);
  const captureAnchor = useRef<{ capturedAt: string; captureTimeZone: string } | null>(null);
  const currentPlayer = useRef<HTMLAudioElement | null>(null);
  const playerObjectUrl = useRef<string | null>(null);

  const closeMeter = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    void audioContext.current?.close(); audioContext.current = null;
  };
  const start = useCallback(async () => {
    setError('');
    if (pending.current) throw new Error('A recording is waiting to be saved. Save it or discard it before starting another.');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('This browser cannot record audio. Use a current browser over HTTPS or localhost, or use the iOS app.');
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media; chunks.current = []; elapsedBeforePause.current = 0;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      recorder.current = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      recorder.current.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
      recorder.current.start(250); startAt.current = Date.now();
      captureAnchor.current = { capturedAt: new Date(startAt.current).toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
      setDurationSeconds(0); setStatus('recording');
      if (window.AudioContext) {
        const context = new AudioContext(); audioContext.current = context;
        const source = context.createMediaStreamSource(media); const analyser = context.createAnalyser(); analyser.fftSize = 128; source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const sample = () => { analyser.getByteFrequencyData(data); const bars = Array.from({ length: 37 }, (_, i) => Math.max(.08, Math.min(1, (data[Math.floor(i * data.length / 37)] ?? 16) / 180))); setMeter(bars); raf.current = requestAnimationFrame(sample); };
        sample();
      }
    } catch (e) {
      stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; closeMeter();
      const permissionError = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      const message = permissionError ? 'Microphone permission was denied. Allow microphone access in your browser settings to record.' : e instanceof Error ? e.message : 'Could not start recording.';
      setError(message); throw new Error(message);
    }
  }, []);
  const pause = useCallback(async () => {
    if (recorder.current?.state !== 'recording') return;
    recorder.current.pause(); elapsedBeforePause.current += (Date.now() - startAt.current) / 1000; setDurationSeconds(elapsedBeforePause.current); setStatus('paused');
  }, []);
  const resume = useCallback(async () => {
    if (recorder.current?.state !== 'paused') return;
    recorder.current.resume(); startAt.current = Date.now(); setStatus('recording');
  }, []);
  const stop = useCallback(async () => {
    if (pending.current) {
      await putAudio(pending.current.uri.replace(/^indexeddb-audio:/, ''), pending.current.blob);
      setStatus('idle'); setDurationSeconds(pending.current.durationSeconds);
      return { uri: pending.current.uri, durationSeconds: pending.current.durationSeconds, capturedAt: pending.current.capturedAt, captureTimeZone: pending.current.captureTimeZone };
    }
    const active = recorder.current;
    if (!active || status === 'idle') return null;
    const duration = elapsedBeforePause.current + (active.state === 'recording' ? (Date.now() - startAt.current) / 1000 : 0);
    let blob: Blob;
    try {
      blob = await new Promise<Blob>((resolve, reject) => {
        active.onstop = () => resolve(new Blob(chunks.current, { type: active.mimeType || 'audio/webm' }));
        active.onerror = () => { setError('Recording was interrupted. The available partial audio will be saved for review.'); resolve(new Blob(chunks.current, { type: active.mimeType || 'audio/webm' })); };
        if (active.state !== 'inactive') active.stop(); else reject(new Error('The browser recorder stopped unexpectedly.'));
      });
    } finally {
      stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; closeMeter();
    }
    const uri = `indexeddb-audio:${crypto.randomUUID()}`;
    pending.current = { blob, uri, durationSeconds: duration, ...(captureAnchor.current ?? { capturedAt: new Date().toISOString(), captureTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }) };
    setHasPending(true);
    recorder.current = null; setStatus('idle'); setDurationSeconds(duration);
    await putAudio(uri.replace(/^indexeddb-audio:/, ''), blob);
    return { uri, durationSeconds: duration, capturedAt: pending.current.capturedAt, captureTimeZone: pending.current.captureTimeZone };
  }, [status]);
  const cancel = useCallback(async () => {
    const active = recorder.current;
    if (active && active.state !== 'inactive') await new Promise<void>(resolve => { active.onstop = () => resolve(); active.stop(); });
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; closeMeter();
    if (pending.current) await removeAudio(pending.current.uri).catch(() => undefined);
    pending.current = null; captureAnchor.current = null; setHasPending(false); recorder.current = null; chunks.current = []; setStatus('idle'); setDurationSeconds(0); setError('');
  }, []);
  const commit = useCallback((uri: string) => { if (pending.current?.uri === uri) { pending.current = null; captureAnchor.current = null; setHasPending(false); } }, []);
  const play = useCallback(async (uri: string) => {
    currentPlayer.current?.pause();
    currentPlayer.current?.removeAttribute('src');
    currentPlayer.current = null;
    if (playerObjectUrl.current) URL.revokeObjectURL(playerObjectUrl.current);
    const blob = await getAudio(uri); const objectUrl = URL.createObjectURL(blob); const audio = new Audio(objectUrl); currentPlayer.current = audio;
    playerObjectUrl.current = objectUrl;
    const cleanup = () => { URL.revokeObjectURL(objectUrl); if (playerObjectUrl.current === objectUrl) playerObjectUrl.current = null; if (currentPlayer.current === audio) currentPlayer.current = null; };
    audio.onended = cleanup; audio.onerror = () => { cleanup(); setError('This saved recording could not be played in this browser.'); };
    try { await audio.play(); } catch (e) { cleanup(); throw e; }
  }, []);
  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => setDurationSeconds(elapsedBeforePause.current + (Date.now() - startAt.current) / 1000), 250);
    return () => clearInterval(timer);
  }, [status]);
  useEffect(() => () => { closeMeter(); currentPlayer.current?.pause(); if (playerObjectUrl.current) URL.revokeObjectURL(playerObjectUrl.current); stream.current?.getTracks().forEach(t => t.stop()); }, []);
  return { status, durationSeconds, meter, error, hasPending, start, pause, resume, stop, cancel, commit, play };
}
