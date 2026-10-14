import type { BrowserAudioClipStore } from '../audio/useBrowserAudioCapture';

export interface TemporaryAudioStore extends BrowserAudioClipStore {
  readonly readTemporaryClip: (uri: string) => Promise<Blob>;
}

/** Per-mount RAM-only clip store. close() synchronously erases and fences writes. */
export function createTemporaryAudioStore(): TemporaryAudioStore {
  const clips = new Map<string, Blob>();
  let open = true;
  const assertOpen = () => { if (!open) throw new Error('Temporary audio is no longer available.'); };
  const get = async (uri: string) => {
    assertOpen();
    const blob = clips.get(uri);
    if (!blob) throw new Error('This temporary recording is no longer available.');
    return blob;
  };
  return Object.freeze({
    isOpen: () => open,
    createUri: () => { assertOpen(); return `temporary-audio:${crypto.randomUUID()}`; },
    put: async (uri: string, blob: Blob) => { assertOpen(); clips.set(uri, blob); },
    get,
    readTemporaryClip: get,
    remove: async (uri: string) => { if (open) clips.delete(uri); },
    close: () => { if (!open) return; open = false; clips.clear(); },
  });
}
