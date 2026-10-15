import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioMediaUrl } from '../cloud/audioUploadDto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNAVAILABLE = 'Audio playback is unavailable for this recording.';
const PLAY_FAILED = 'Audio playback could not be started.';

export type CloudAudioPlaybackStatus = 'idle' | 'ready' | 'playing' | 'paused' | 'error';

export type CloudAudioPlaybackState = Readonly<{
  status: CloudAudioPlaybackStatus;
  error?: string;
}>;

/** Minimal audio element contract, also usable by focused browser-hook tests. */
export interface CloudAudioPlaybackElement {
  preload: string;
  src: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: 'playing' | 'pause' | 'ended' | 'error', listener: EventListener): void;
  removeEventListener(type: 'playing' | 'pause' | 'ended' | 'error', listener: EventListener): void;
}
export type CloudAudioPlaybackOptions = Readonly<{
  ownerKey: string;
  /** UUIDv4 media ID from the validated workspace snapshot, without the `still-media:` prefix. */
  mediaId?: string;
  /** Called only in the owning effect, never during render or server rendering. */
  createAudioElement?: () => CloudAudioPlaybackElement;
}>;

type OwnedPlayer = {
  readonly ownerKey: string;
  readonly mediaId: string;
  readonly resourceKey: object;
  readonly element: CloudAudioPlaybackElement;
  sourceAssigned: boolean;
  intent: 'ready' | 'playing' | 'paused' | 'error';
  intentGeneration: number;
  playPromise?: Readonly<{ generation: number; promise: Promise<void> }>;
};

type PublishedState = Readonly<{
  resourceKey: object;
  state: CloudAudioPlaybackState;
}>;

function defaultAudioElement(): CloudAudioPlaybackElement | undefined {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return undefined;
  return document.createElement('audio');
}

function initialState(mediaId: string | undefined): CloudAudioPlaybackState {
  return mediaId === undefined ? Object.freeze({ status: 'idle' })
    : UUID_V4.test(mediaId) ? Object.freeze({ status: 'ready' })
      : Object.freeze({ status: 'error', error: UNAVAILABLE });
}

/** Session-owned playback for server-backed recordings. It never accepts temporary clip URIs. */
export function useCloudAudioPlayback({ ownerKey, mediaId, createAudioElement }: CloudAudioPlaybackOptions): Readonly<{
  state: CloudAudioPlaybackState;
  play(): Promise<void>;
  pause(): void;
}> {
  const resourceKey = useMemo(() => Object.freeze({ ownerKey, mediaId, createAudioElement }), [ownerKey, mediaId, createAudioElement]);
  const [stored, setStored] = useState<PublishedState>(() => Object.freeze({ resourceKey, state: initialState(mediaId) }));
  const generation = useRef(0);
  const player = useRef<OwnedPlayer | null>(null);

  useEffect(() => {
    const ticket = ++generation.current;
    let element: CloudAudioPlaybackElement | undefined;
    const publish = (state: CloudAudioPlaybackState) => {
      if (generation.current === ticket && player.current?.element === element) {
        setStored(Object.freeze({ resourceKey, state: Object.freeze(state) }));
      }
    };

    if (mediaId === undefined) {
      player.current = null;
      // This effect synchronizes the published state with the new external player lifecycle identity.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset lifecycle state after the active player is released.
      setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'idle' }) }));
    } else if (!UUID_V4.test(mediaId)) {
      player.current = null;
      // This effect synchronizes the published state with the new external player lifecycle identity.
      setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'error', error: UNAVAILABLE }) }));
    } else {
      try { element = createAudioElement ? createAudioElement() : defaultAudioElement(); }
      catch { element = undefined; }
      if (!element) {
        player.current = null;
        // This effect synchronizes the published state with the failed external player creation.
        setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'error', error: UNAVAILABLE }) }));
      } else {
        element.preload = 'none';
        const owned: OwnedPlayer = { ownerKey, mediaId, resourceKey, element, sourceAssigned: false, intent: 'ready', intentGeneration: 0 };
        player.current = owned;
        const onPlaying: EventListener = () => { if (owned.intent === 'playing') publish({ status: 'playing' }); };
        const onPause: EventListener = () => { if (owned.sourceAssigned && owned.intent === 'paused') publish({ status: 'paused' }); };
        const onEnded: EventListener = () => {
          if (owned.intent === 'playing') { owned.intent = 'ready'; publish({ status: 'ready' }); }
        };
        const onError: EventListener = () => {
          if (owned.intent === 'playing') { owned.intent = 'error'; publish({ status: 'error', error: PLAY_FAILED }); }
        };
        element.addEventListener('playing', onPlaying);
        element.addEventListener('pause', onPause);
        element.addEventListener('ended', onEnded);
        element.addEventListener('error', onError);
        // A newly created, unsourced player starts ready even when this key appeared before.
        setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'ready' }) }));
        return () => {
          if (generation.current === ticket) generation.current += 1;
          if (player.current === owned) player.current = null;
          element!.removeEventListener('playing', onPlaying);
          element!.removeEventListener('pause', onPause);
          element!.removeEventListener('ended', onEnded);
          element!.removeEventListener('error', onError);
          try { element!.pause(); } catch { /* Cleanup is best effort for detached media. */ }
          try { element!.removeAttribute('src'); } catch { /* Continue releasing the detached media element. */ }
          try { element!.load(); } catch { /* Cleanup is best effort for detached media. */ }
        };
      }
    }

    return () => {
      if (generation.current === ticket) generation.current += 1;
      if (player.current) player.current = null;
    };
  }, [ownerKey, mediaId, createAudioElement, resourceKey]);

  const play = useCallback(async (): Promise<void> => {
    const owned = player.current;
    if (!owned || owned.resourceKey !== resourceKey || owned.ownerKey !== ownerKey || owned.mediaId !== mediaId || !UUID_V4.test(owned.mediaId)) return;
    if (owned.intent === 'playing' && owned.playPromise?.generation === owned.intentGeneration) return owned.playPromise.promise;
    const intentGeneration = ++owned.intentGeneration;
    owned.intent = 'playing';
    const ticket = generation.current;
    const isCurrent = () => generation.current === ticket && player.current === owned && owned.intentGeneration === intentGeneration;
    if (!owned.sourceAssigned) {
      try {
        owned.element.src = audioMediaUrl(owned.mediaId);
        owned.sourceAssigned = true;
        owned.element.load();
      } catch {
        if (isCurrent()) {
          owned.intent = 'error';
          setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'error', error: PLAY_FAILED }) }));
        }
        return;
      }
    }
    const operation = (async () => {
      try {
        await owned.element.play();
        if (isCurrent()) {
          owned.intent = 'playing';
          setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'playing' }) }));
        }
      } catch {
        if (isCurrent()) {
          owned.intent = 'error';
          setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'error', error: PLAY_FAILED }) }));
        }
      }
    })();
    const playAttempt = Object.freeze({ generation: intentGeneration, promise: operation });
    owned.playPromise = playAttempt;
    try { await operation; }
    finally { if (owned.playPromise === playAttempt) owned.playPromise = undefined; }
  }, [ownerKey, mediaId, resourceKey]);

  const pause = useCallback(() => {
    const owned = player.current;
    if (!owned || owned.resourceKey !== resourceKey || owned.ownerKey !== ownerKey || owned.mediaId !== mediaId || !owned.sourceAssigned) return;
    ++owned.intentGeneration;
    owned.intent = 'paused';
    try {
      owned.element.pause();
      if (player.current === owned) setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'paused' }) }));
    } catch {
      if (player.current === owned) {
        owned.intent = 'error';
        setStored(Object.freeze({ resourceKey, state: Object.freeze({ status: 'error', error: PLAY_FAILED }) }));
      }
    }
  }, [ownerKey, mediaId, resourceKey]);

  const state = stored.resourceKey === resourceKey ? stored.state : initialState(mediaId);
  return { state, play, pause };
}
