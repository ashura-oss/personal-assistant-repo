import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptureStillActiveError } from '../privacy/audioBoundary';
import type { PrivacyAudioBoundary, PrivacyCaptureSession } from '../privacy/audioBoundary';
import type { AudioCapture, AudioCaptureStopResult } from './types';
import type { PendingCaptureJournalPort } from './pendingCaptureService.types';
import type { NativeAudioCaptureOptions } from './useAudioCapture.native';

export interface BrowserAudioClipMetadata {
  readonly durationSeconds: number;
  readonly capturedAt: string;
  readonly captureTimeZone: string;
}

/** Explicit persistence and playback boundary for browser capture. */
export interface BrowserAudioClipStore {
  readonly isOpen: () => boolean;
  readonly createUri: () => string;
  readonly put: (uri: string, blob: Blob) => Promise<void>;
  readonly get: (uri: string) => Promise<Blob>;
  readonly remove: (uri: string) => Promise<void>;
  /** Optional synchronous close is used by RAM-only stores to erase on unmount. */
  readonly close?: () => void;
}

export type BrowserAudioUnmountPolicy = 'save_pending' | 'discard';

export type BrowserAudioCaptureOptions = Readonly<{
  readonly unmountPolicy: BrowserAudioUnmountPolicy;
  readonly commitPolicy?: 'preserve' | 'remove';
}> & (
  | Readonly<{ store: BrowserAudioClipStore; createStore?: never }>
  /** Creates a fresh store for each effect setup, including StrictMode replay. */
  | Readonly<{ store?: never; createStore: () => BrowserAudioClipStore }>
);

type HookOwner = Readonly<{ id: number; store: BrowserAudioClipStore }>;
type PendingClip = BrowserAudioClipMetadata & { owner: HookOwner; uri: string; blob: Blob };
type StoppedClip = BrowserAudioClipMetadata & { blob: Blob };

function safeTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

export function useBrowserAudioCapture(
  options: BrowserAudioCaptureOptions,
  boundary?: PrivacyAudioBoundary,
  _journal?: PendingCaptureJournalPort,
  _nativeOptions?: NativeAudioCaptureOptions,
): AudioCapture & { readClip(uri: string): Promise<Blob> } {
  const configuredStore = options.store;
  const createStore = options.createStore;
  const unmountPolicy = options.unmountPolicy;
  const commitPolicy = options.commitPolicy;
  const [status, setStatus] = useState<AudioCapture['status']>('idle');
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [meter, setMeter] = useState<number[]>(Array.from({ length: 37 }, (_, i) => 0.14 + (i % 5) * 0.07));
  const [error, setError] = useState('');
  const [hasPending, setHasPending] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const recorderOwner = useRef<HookOwner | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const streamOwner = useRef<HookOwner | null>(null);
  const startAt = useRef(0);
  const elapsedBeforePause = useRef(0);
  const audioContext = useRef<AudioContext | null>(null);
  const audioContextOwner = useRef<HookOwner | null>(null);
  const raf = useRef<number | null>(null);
  const rafOwner = useRef<HookOwner | null>(null);
  const pending = useRef<PendingClip | null>(null);
  const captureAnchor = useRef<{ capturedAt: string; captureTimeZone: string } | null>(null);
  const currentPlayer = useRef<HTMLAudioElement | null>(null);
  const currentPlayerOwner = useRef<HookOwner | null>(null);
  const playerObjectUrl = useRef<string | null>(null);
  const playerObjectUrlOwner = useRef<HookOwner | null>(null);
  const captureSession = useRef<PrivacyCaptureSession | null>(null);
  const captureSessionOwner = useRef<HookOwner | null>(null);
  const mounted = useRef(false);
  const ownerCounter = useRef(0);
  const activeOwner = useRef<HookOwner | null>(null);
  const generation = useRef(0);
  const starting = useRef<Promise<void> | null>(null);
  const startingOwner = useRef<HookOwner | null>(null);
  const stopCompletion = useRef<{ recorder: MediaRecorder; promise: Promise<StoppedClip | null> } | null>(null);
  const stopAction = useRef<{ owner: HookOwner; promise: Promise<AudioCaptureStopResult | null> } | null>(null);
  const cancelAction = useRef<{ owner: HookOwner; promise: Promise<void> } | null>(null);
  const stopProven = useRef(false);
  const closingIntent = useRef<'stop' | 'discard' | null>(null);
  const closingOwner = useRef<HookOwner | null>(null);
  const playbackTicket = useRef(0);
  const currentOwner = useCallback((): HookOwner => {
    const owner = activeOwner.current;
    if (!owner || !mounted.current) throw new Error('Audio capture is no longer mounted.');
    return owner;
  }, []);
  const isCurrentOwner = useCallback((owner: HookOwner) => mounted.current && activeOwner.current === owner, []);
  const publish = useCallback((owner: HookOwner, work: () => void) => { if (isCurrentOwner(owner)) work(); }, [isCurrentOwner]);
  const closeMeter = useCallback(async (owner: HookOwner) => {
    if (rafOwner.current === owner && raf.current !== null) cancelAnimationFrame(raf.current);
    if (rafOwner.current === owner) { raf.current = null; rafOwner.current = null; }
    const context = audioContextOwner.current === owner ? audioContext.current : null;
    if (audioContextOwner.current === owner) { audioContext.current = null; audioContextOwner.current = null; }
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }, []);

  const releaseStream = useCallback((owner: HookOwner) => {
    if (streamOwner.current !== owner) return;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null; streamOwner.current = null;
  }, []);

  const stopHardware = useCallback((owner: HookOwner): Promise<StoppedClip | null> => {
    if (recorderOwner.current !== owner) return Promise.resolve(null);
    const active = recorder.current;
    if (!active) return Promise.resolve(null);
    if (stopCompletion.current?.recorder === active) return stopCompletion.current.promise;
    const ticket = generation.current;
    const ownedStream = stream.current;
    const duration = elapsedBeforePause.current + (active.state === 'recording' ? (Date.now() - startAt.current) / 1000 : 0);
    const operation = (async () => {
      let stopConfirmed = active.state === 'inactive' && stopProven.current;
      try {
        let blob: Blob;
        if (active.state === 'inactive') {
          if (!stopConfirmed) throw new CaptureStillActiveError('The browser recorder stop could not be confirmed. Retry Stop or discard before leaving.');
          blob = new Blob(chunks.current, { type: active.mimeType || 'audio/webm' });
        } else {
          blob = await new Promise<Blob>((resolve, reject) => {
            let recorderError = false;
            const previousOnStop = active.onstop;
            active.onstop = (event) => {
              previousOnStop?.call(active, event);
              stopProven.current = true;
              stopConfirmed = true;
              if (recorderError && chunks.current.length === 0) reject(new Error('The browser recorder stopped without recoverable audio.'));
              else resolve(new Blob(chunks.current, { type: active.mimeType || 'audio/webm' }));
            };
            active.onerror = () => { recorderError = true; };
            try { active.stop(); } catch (cause) { reject(cause); }
          });
        }
        const anchor = captureAnchor.current ?? { capturedAt: new Date().toISOString(), captureTimeZone: safeTimeZone() };
        return { blob, durationSeconds: duration, ...anchor };
      } catch (cause) {
        if (!stopConfirmed) throw new CaptureStillActiveError('The browser recorder may still be active. Retry Stop or discard before leaving.');
        throw cause;
      } finally {
        if (stopConfirmed) {
          releaseStream(owner); await closeMeter(owner);
          if (streamOwner.current === owner && stream.current === ownedStream) releaseStream(owner);
          if (recorder.current === active && recorderOwner.current === owner) {
            recorder.current = null; recorderOwner.current = null;
            chunks.current = []; captureAnchor.current = null; elapsedBeforePause.current = 0;
          }
          if (generation.current === ticket) publish(owner, () => setStatus('idle'));
        }
      }
    })();
    const completion = { recorder: active, promise: operation };
    stopCompletion.current = completion;
    void operation.finally(() => { if (stopCompletion.current === completion) stopCompletion.current = null; }).catch(() => undefined);
    return operation;
  }, [closeMeter, publish, releaseStream]);

  const startActual = useCallback(async (ticket: number, owner: HookOwner) => {
    const store = owner.store;
    publish(owner, () => setError(''));
    if (pending.current?.owner === owner) throw new Error('A recording is waiting to be saved. Save it or discard it before starting another.');
    if (!store.isOpen()) throw new Error('Temporary audio storage is no longer available.');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('This browser cannot record audio. Use a current browser over HTTPS or localhost, or use the iOS app.');
    }
    let media: MediaStream | null = null;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrentOwner(owner) || generation.current !== ticket || closingIntent.current || !store.isOpen()) {
        media.getTracks().forEach((track) => track.stop()); media = null;
        throw new Error('Recording start was cancelled.');
      }
      const acquiredStream = media;
      stream.current = acquiredStream; streamOwner.current = owner; media = null; chunks.current = []; elapsedBeforePause.current = 0;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(acquiredStream, mimeType ? { mimeType } : undefined);
      stopProven.current = false;
      active.onstop = () => { stopProven.current = true; };
      recorder.current = active; recorderOwner.current = owner;
      active.ondataavailable = (event) => {
        if (event.data.size && recorder.current === active && (isCurrentOwner(owner) || unmountPolicy === 'save_pending')) chunks.current.push(event.data);
      };
      active.start(250); startAt.current = Date.now();
      captureAnchor.current = { capturedAt: new Date(startAt.current).toISOString(), captureTimeZone: safeTimeZone() };
      publish(owner, () => { setDurationSeconds(0); setStatus('recording'); });
      if (window.AudioContext) {
        const context = new AudioContext(); audioContext.current = context; audioContextOwner.current = owner;
        const source = context.createMediaStreamSource(acquiredStream); const analyser = context.createAnalyser(); analyser.fftSize = 128; source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const sample = () => {
          if (!isCurrentOwner(owner) || generation.current !== ticket || audioContextOwner.current !== owner) return;
          analyser.getByteFrequencyData(data);
          const bars = Array.from({ length: 37 }, (_, i) => Math.max(.08, Math.min(1, (data[Math.floor(i * data.length / 37)] ?? 16) / 180)));
          publish(owner, () => setMeter(bars)); raf.current = requestAnimationFrame(sample); rafOwner.current = owner;
        };
        sample();
      }
    } catch (cause) {
      const active = recorderOwner.current === owner ? recorder.current : null;
      if (active && active.state !== 'inactive') {
        try {
          await stopHardware(owner);
        } catch (stopError) {
          const stateAfterError: RecordingState = active.state as RecordingState;
          if (stopError instanceof CaptureStillActiveError || stateAfterError !== 'inactive' || !stopProven.current) {
            publish(owner, () => { setStatus('paused'); setError('Recording setup failed while the browser recorder may still be active. Stop or discard it before leaving.'); });
            throw new CaptureStillActiveError('Recording setup failed while the browser recorder may still be active.');
          }
        }
      }
      if (media) media.getTracks().forEach((track) => track.stop());
      releaseStream(owner);
      if (recorderOwner.current === owner) { recorder.current = null; recorderOwner.current = null; }
      await closeMeter(owner);
      const permissionError = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
      const message = permissionError ? 'Microphone permission was denied. Allow microphone access in your browser settings to record.' : cause instanceof Error ? cause.message : 'Could not start recording.';
      publish(owner, () => { setError(message); setStatus('idle'); }); throw new Error(message);
    }
  }, [closeMeter, isCurrentOwner, publish, releaseStream, stopHardware, unmountPolicy]);

  const start = useCallback(() => {
    let owner: HookOwner;
    try { owner = currentOwner(); } catch (cause) { return Promise.reject(cause); }
    if (starting.current) return Promise.reject(new Error('A recording is already starting.'));
    if (closingIntent.current) return Promise.reject(new Error('The recording is still stopping.'));
    if ((captureSession.current && captureSessionOwner.current === owner) || recorder.current) return Promise.reject(new Error('A recording is already in progress.'));
    const ticket = ++generation.current;
    closingIntent.current = null;
    let operation!: Promise<void>;
    operation = (async () => {
      try {
        if (boundary) {
          const session = boundary.beginCapture(() => startActual(ticket, owner));
          captureSession.current = session; captureSessionOwner.current = owner;
          await session.ready;
        } else await startActual(ticket, owner);
      } catch (cause) {
        if (!(cause instanceof CaptureStillActiveError)) {
          if (captureSessionOwner.current === owner) { captureSession.current = null; captureSessionOwner.current = null; }
          publish(owner, () => setStatus('idle'));
        } else publish(owner, () => setStatus('paused'));
        throw cause;
      } finally {
        if (starting.current === operation) { starting.current = null; startingOwner.current = null; }
      }
    })();
    starting.current = operation; startingOwner.current = owner;
    return operation;
  }, [boundary, currentOwner, publish, startActual]);

  const pauseActual = useCallback(async (owner: HookOwner) => {
    const active = recorder.current;
    if (recorderOwner.current !== owner || active?.state !== 'recording') return;
    active.pause(); elapsedBeforePause.current += (Date.now() - startAt.current) / 1000;
    publish(owner, () => { setDurationSeconds(elapsedBeforePause.current); setStatus('paused'); });
  }, [publish]);
  const pause = useCallback(async () => {
    const owner = currentOwner();
    const session = captureSessionOwner.current === owner ? captureSession.current : null;
    if (session) await session.runAction(() => pauseActual(owner));
    else if (boundary) await boundary.withAudioWrite(() => pauseActual(owner));
    else await pauseActual(owner);
  }, [boundary, currentOwner, pauseActual]);

  const resumeActual = useCallback(async (owner: HookOwner) => {
    const active = recorder.current;
    if (recorderOwner.current !== owner || active?.state !== 'paused') return;
    active.resume(); startAt.current = Date.now(); publish(owner, () => setStatus('recording'));
  }, [publish]);
  const resume = useCallback(async () => {
    const owner = currentOwner();
    const session = captureSessionOwner.current === owner ? captureSession.current : null;
    if (session) await session.runAction(() => resumeActual(owner));
    else if (boundary) await boundary.withAudioWrite(() => resumeActual(owner));
    else await resumeActual(owner);
  }, [boundary, currentOwner, resumeActual]);

  const stopActual = useCallback((owner: HookOwner): Promise<AudioCaptureStopResult | null> => {
    if (stopAction.current?.owner === owner) return stopAction.current.promise;
    let operation!: Promise<AudioCaptureStopResult | null>;
    operation = (async () => {
      const store = owner.store;
      const old = pending.current?.owner === owner ? pending.current : null;
      if (old) {
        if (!store.isOpen()) throw new Error('Audio storage is no longer available.');
        await store.put(old.uri, old.blob);
        publish(owner, () => { setHasPending(true); setStatus('idle'); setDurationSeconds(old.durationSeconds); });
        return { uri: old.uri, durationSeconds: old.durationSeconds, capturedAt: old.capturedAt, captureTimeZone: old.captureTimeZone };
      }
      const stopped = await stopHardware(owner);
      if (!stopped || (closingOwner.current === owner && closingIntent.current === 'discard')) {
        if ((!activeOwner.current || activeOwner.current === owner) && !pending.current && recorderOwner.current !== owner) closingIntent.current = null;
        return null;
      }
      if (!store.isOpen()) throw new Error('Audio storage is no longer available.');
      const uri = store.createUri();
      const clip: PendingClip = { ...stopped, owner, uri };
      if (activeOwner.current === owner) { pending.current = clip; publish(owner, () => setHasPending(true)); }
      // Retain both the URI and blob after write failure so explicit Stop can retry.
      await store.put(uri, stopped.blob);
      publish(owner, () => { setHasPending(true); setStatus('idle'); setDurationSeconds(stopped.durationSeconds); });
      return { uri, durationSeconds: stopped.durationSeconds, capturedAt: stopped.capturedAt, captureTimeZone: stopped.captureTimeZone };
    })();
    const action = { owner, promise: operation };
    stopAction.current = action;
    void operation.finally(() => { if (stopAction.current === action) stopAction.current = null; }).catch(() => undefined);
    return operation;
  }, [publish, stopHardware]);

  const stopForOwner = useCallback(async (owner: HookOwner): Promise<AudioCaptureStopResult | null> => {
    if (!isCurrentOwner(owner) && unmountPolicy === 'discard') return null;
    generation.current += 1;
    if (closingOwner.current !== owner || !closingIntent.current) { closingOwner.current = owner; closingIntent.current = 'stop'; }
    const session = captureSessionOwner.current === owner ? captureSession.current : null;
    if (!boundary) {
      if (startingOwner.current === owner) await starting.current?.catch(() => undefined);
      return stopActual(owner);
    }
    if (!session) {
      if (startingOwner.current === owner) await starting.current?.catch(() => undefined);
      return boundary.withAudioWrite(() => stopActual(owner));
    }
    try {
      const result = await session.stop(() => stopActual(owner));
      if (captureSession.current === session && captureSessionOwner.current === owner) { captureSession.current = null; captureSessionOwner.current = null; }
      return result;
    } catch (cause) {
      if (!(cause instanceof CaptureStillActiveError) && captureSession.current === session && captureSessionOwner.current === owner) { captureSession.current = null; captureSessionOwner.current = null; }
      throw cause;
    }
  }, [boundary, isCurrentOwner, unmountPolicy, stopActual]);
  const stop = useCallback(() => stopForOwner(currentOwner()), [currentOwner, stopForOwner]);

  const discardPending = useCallback(async (owner: HookOwner) => {
    const current = pending.current?.owner === owner ? pending.current : null;
    if (current) await owner.store.remove(current.uri);
    if (current && pending.current === current) pending.current = null;
    if (recorderOwner.current === owner) { captureAnchor.current = null; chunks.current = []; }
    if (closingOwner.current === owner) { closingIntent.current = null; closingOwner.current = null; }
    publish(owner, () => { setHasPending(false); setStatus('idle'); setDurationSeconds(0); setError(''); });
  }, [publish]);
  const cancelActual = useCallback(async (owner: HookOwner) => {
    if (startingOwner.current === owner) await starting.current?.catch(() => undefined);
    await stopHardware(owner);
    if (stopAction.current?.owner === owner) await stopAction.current.promise.catch(() => undefined);
    await discardPending(owner);
  }, [discardPending, stopHardware]);
  const cancel = useCallback(async () => {
    const owner = currentOwner();
    if (cancelAction.current?.owner === owner) return cancelAction.current.promise;
    generation.current += 1;
    closingOwner.current = owner; closingIntent.current = 'discard';
    playbackTicket.current += 1;
    const player = currentPlayer.current; currentPlayer.current = null;
    player?.pause(); player?.removeAttribute('src');
    const objectUrl = playerObjectUrl.current; playerObjectUrl.current = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const session = captureSessionOwner.current === owner ? captureSession.current : null;
    let operation!: Promise<void>;
    operation = (async () => {
      if (session) {
        try {
          await session.stop(() => cancelActual(owner));
          if (captureSession.current === session && captureSessionOwner.current === owner) { captureSession.current = null; captureSessionOwner.current = null; }
          // A Stop request may already own the boundary's shared completion.
          await discardPending(owner);
        } catch (cause) {
          if (!(cause instanceof CaptureStillActiveError) && captureSession.current === session && captureSessionOwner.current === owner) { captureSession.current = null; captureSessionOwner.current = null; }
          throw cause;
        }
        return;
      }
      if (boundary) await boundary.withAudioWrite(() => cancelActual(owner));
      else await cancelActual(owner);
    })();
    const action = { owner, promise: operation };
    cancelAction.current = action;
    void operation.finally(() => { if (cancelAction.current === action) cancelAction.current = null; }).catch(() => undefined);
    return operation;
  }, [boundary, cancelActual, currentOwner, discardPending]);

  const commitOwner = activeOwner.current;
  const commit = useCallback((uri: string) => {
    const owner = commitOwner;
    const current = pending.current;
    if (!owner || current?.owner !== owner || current.uri !== uri) return;
    pending.current = null; captureAnchor.current = null; chunks.current = [];
    if (closingOwner.current === owner) { closingIntent.current = null; closingOwner.current = null; }
    publish(owner, () => setHasPending(false));
    if (commitPolicy === 'remove') void owner.store.remove(uri).catch(() => undefined);
  }, [commitOwner, commitPolicy, publish]);

  const play = useCallback(async (uri: string) => {
    const owner = currentOwner();
    const ticket = ++playbackTicket.current;
    const store = owner.store;
    const playActual = async () => {
      const oldPlayer = currentPlayer.current; currentPlayer.current = null;
      currentPlayerOwner.current = null;
      oldPlayer?.pause(); oldPlayer?.removeAttribute('src');
      const oldUrl = playerObjectUrl.current; playerObjectUrl.current = null;
      playerObjectUrlOwner.current = null;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      const blob = await store.get(uri);
      if (!isCurrentOwner(owner) || ticket !== playbackTicket.current || !store.isOpen()) return;
      const objectUrl = URL.createObjectURL(blob); const audio = new Audio(objectUrl);
      currentPlayer.current = audio; currentPlayerOwner.current = owner;
      playerObjectUrl.current = objectUrl; playerObjectUrlOwner.current = owner;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true; URL.revokeObjectURL(objectUrl);
        if (playerObjectUrl.current === objectUrl && playerObjectUrlOwner.current === owner) { playerObjectUrl.current = null; playerObjectUrlOwner.current = null; }
        if (currentPlayer.current === audio && currentPlayerOwner.current === owner) { currentPlayer.current = null; currentPlayerOwner.current = null; }
      };
      audio.onended = cleanup; audio.onerror = () => { cleanup(); publish(owner, () => setError('This saved recording could not be played in this browser.')); };
      try {
        const playing = audio.play();
        if (!isCurrentOwner(owner) || ticket !== playbackTicket.current) { audio.pause(); cleanup(); return; }
        await playing;
        if (!isCurrentOwner(owner) || ticket !== playbackTicket.current) { audio.pause(); cleanup(); }
      } catch (cause) { cleanup(); throw cause; }
    };
    if (boundary) await boundary.withAudioRead(playActual);
    else await playActual();
  }, [boundary, currentOwner, isCurrentOwner, publish]);

  const readOwner = activeOwner.current;
  const readClip = useCallback((uri: string) => {
    if (!readOwner) return Promise.reject(new Error('Temporary audio is no longer available.'));
    return readOwner.store.get(uri);
  }, [readOwner]);

  useEffect(() => {
    const owner: HookOwner = { id: ++ownerCounter.current, store: createStore?.() ?? configuredStore! };
    activeOwner.current = owner;
    mounted.current = true;
    if (pending.current?.owner !== owner) {
      pending.current = null;
      captureAnchor.current = null; chunks.current = []; elapsedBeforePause.current = 0;
      setHasPending(false); setStatus('idle'); setDurationSeconds(0); setError('');
    }
    if (closingOwner.current !== owner && recorderOwner.current !== owner) { closingOwner.current = owner; closingIntent.current = null; }
    return () => {
      const ownsLifecycle = activeOwner.current === owner;
      const pendingStop = unmountPolicy === 'save_pending' ? stopForOwner(owner) : null;
      if (ownsLifecycle) { mounted.current = false; activeOwner.current = null; generation.current += 1; }
      if (ownsLifecycle && unmountPolicy === 'discard') { closingOwner.current = owner; closingIntent.current = 'discard'; }
      playbackTicket.current += 1;
      if (unmountPolicy === 'discard') owner.store.close?.();
      const player = currentPlayerOwner.current === owner ? currentPlayer.current : null;
      if (currentPlayerOwner.current === owner) { currentPlayer.current = null; currentPlayerOwner.current = null; }
      player?.pause(); player?.removeAttribute('src');
      const objectUrl = playerObjectUrlOwner.current === owner ? playerObjectUrl.current : null;
      if (playerObjectUrlOwner.current === owner) { playerObjectUrl.current = null; playerObjectUrlOwner.current = null; }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (unmountPolicy === 'save_pending') void pendingStop?.catch(() => undefined);
      else {
        if (recorderOwner.current === owner && recorder.current) void stopHardware(owner).catch(() => undefined);
        else { releaseStream(owner); void closeMeter(owner); }
        const current = pending.current?.owner === owner ? pending.current : null;
        if (pending.current?.owner === owner) pending.current = null;
        chunks.current = []; captureAnchor.current = null; elapsedBeforePause.current = 0;
        if (current) void owner.store.remove(current.uri).catch(() => undefined);
      }
    };
  }, [closeMeter, configuredStore, createStore, releaseStream, stopForOwner, stopHardware, unmountPolicy]);
  useEffect(() => {
    if (status !== 'recording') return;
    const owner = activeOwner.current;
    if (!owner) return;
    const timer = setInterval(() => publish(owner, () => setDurationSeconds(elapsedBeforePause.current + (Date.now() - startAt.current) / 1000)), 250);
    return () => clearInterval(timer);
  }, [publish, status]);

  return {
    status,
    // The recorder itself is authoritative after a failed setup or stop.
    // eslint-disable-next-line react-hooks/refs
    canResume: status === 'paused' && recorder.current?.state === 'paused',
    durationSeconds, meter, error, hasPending, start, pause, resume, stop, cancel, commit, play, readClip,
  };
}
