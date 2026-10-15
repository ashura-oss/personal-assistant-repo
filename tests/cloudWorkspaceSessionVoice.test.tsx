/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { CloudWorkspaceSessionStore } from '../src/web/CloudWorkspaceSession';
import type { CloudVoiceCapturePort } from '../src/web/cloudVoiceCoordinator';
import type { AuthenticatedSession } from '../src/web/authClient';

vi.mock('react-native', () => ({ ActivityIndicator: () => null, Text: () => null, View: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: { children: unknown }) => children,
  SafeAreaView: ({ children }: { children: unknown }) => children }));
vi.mock('../src/web/CloudWorkspace', () => ({ CloudWorkspace: () => null }));
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', sage: '#9a9' }, s: new Proxy({}, { get: () => ({}) }) }));

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const uploadId = '6bcab02c-ab0a-4b82-b2fd-4b3038317c4a';
const captureId = '51ec9e62-8a76-4cb8-bc1e-f34e26d5177b';
const captureRevision = 'b095d70b-0061-431e-b89c-a96c3230e9a3';
const session: AuthenticatedSession = Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'csrf-test' });

function snapshot() {
  const state = createInitialWorkspaceState(() => '11111111-1111-4111-8111-111111111111');
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: session.privacyEpoch, revision: 1 });
}

const body = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeCapture(overrides: Partial<CloudVoiceCapturePort> = {}) {
  const capture: CloudVoiceCapturePort = {
    start: vi.fn(async () => undefined), pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({ uri: 'ram://clip', durationSeconds: 2, capturedAt: '2026-10-15T02:00:00.000Z',
      captureTimeZone: 'Asia/Singapore' })), commit: vi.fn(), cancel: vi.fn(async () => undefined),
    readTemporaryClip: vi.fn(async () => new Blob(['voice'], { type: 'audio/webm' })),
    ...overrides,
  };
  return capture;
}

function installFetch(fetcher: (...args: [string, RequestInit]) => Promise<ReturnType<typeof body>>) {
  const mock = vi.fn(fetcher);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('CloudWorkspaceSession voice lifecycle', () => {
  it('creates fresh voice owners per setup, ignores stale cleanup, and does no implicit upload-history read', async () => {
    let failRefresh = false;
    let commandId: string | undefined;
    const fetcher = installFetch(async (path, init) => {
      if (path === '/api/workspace/snapshot') return body(snapshot());
      if (path === '/api/workspace/refresh') return failRefresh ? body({}, 503) : body(snapshot());
      if (path === '/api/workspace/commands') {
        const envelope = JSON.parse(String(init.body)) as { commandId: string };
        commandId = envelope.commandId;
        return body({ schemaVersion: 1, commandId, status: 'finished', receipt: { schemaVersion: 1, commandId,
          kind: 'chat.create', objectId: '88888888-8888-4888-8888-888888888888' }, snapshot: snapshot() });
      }
      if (commandId && path === `/api/workspace/commands/${commandId}`) return body({ schemaVersion: 1, commandId, status: 'finished',
        receipt: { schemaVersion: 1, commandId, kind: 'chat.create', objectId: '88888888-8888-4888-8888-888888888888' } });
      throw new Error(`Unexpected request ${path}`);
    });
    const store = new CloudWorkspaceSessionStore(session);
    const oldCapture = fakeCapture();
    const currentCapture = fakeCapture();
    const oldCleanup = store.start(() => oldCapture);
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    oldCleanup();
    const currentCleanup = store.start(() => currentCapture);
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    expect(store.getSnapshot().voice?.phase).toBe('idle'); // Initial snapshot loading must retain the coordinator DTO.
    await store.refresh();
    expect(store.getSnapshot().voice?.phase).toBe('idle');
    const created = await store.execute({ kind: 'chat.create' });
    expect(created.status).toBe('finished');
    expect(store.getSnapshot().voice?.phase).toBe('idle');
    await store.inspect(commandId!);
    expect(store.getSnapshot().voice?.phase).toBe('idle');
    failRefresh = true;
    await store.refresh();
    expect(store.getSnapshot().voice?.phase).toBe('idle');
    failRefresh = false;

    oldCleanup(); // A stale StrictMode cleanup must not dispose the replacement generation.
    await store.voiceActions.start();
    expect(currentCapture.start).toHaveBeenCalledOnce();
    expect(oldCapture.start).not.toHaveBeenCalled();
    expect(store.getSnapshot().voice?.phase).toBe('recording');
    expect(fetcher.mock.calls.map(([path]) => path).filter((path) => path === '/api/audio/upload-history')).toHaveLength(0);

    currentCleanup();
    await expect(Promise.resolve().then(() => store.voiceActions.start())).rejects.toMatchObject({ kind: 'disposed' });
    expect(currentCapture.start).toHaveBeenCalledOnce();
    store.invalidate();
  });

  it('allows exact transcription cancellation during command execution without clearing its pending write', async () => {
    const commandReply = deferred<ReturnType<typeof body>>();
    let admittedId = '';
    const fetcher = installFetch(async (path, init) => {
      if (path === '/api/workspace/snapshot') return body(snapshot());
      if (path === '/api/workspace/commands' && init.method === 'POST') {
        admittedId = JSON.parse(String(init.body)).commandId as string;
        return commandReply.promise;
      }
      if (path.endsWith('/cancel-transcription') && init.method === 'POST') {
        return body({ schemaVersion: 1, commandId: admittedId, status: 'cancellation_requested' });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const store = new CloudWorkspaceSessionStore(session);
    const cleanup = store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    let admitted!: string;
    const command = store.execute({ kind: 'notes.transcribe', noteId: captureId, expectedNoteRevision: 1 }, (envelope) => {
      admitted = envelope.commandId;
    });
    await vi.waitFor(() => expect(admittedId).toBe(admitted));
    await vi.waitFor(() => expect(store.getSnapshot().pendingCommand).toEqual({ commandId: admitted, kind: 'notes.transcribe' }));
    const beforeCancel = store.getSnapshot();
    await expect(store.cancelTranscription(admitted)).resolves.toBe('cancellation_requested');
    expect(store.getSnapshot()).toBe(beforeCancel);
    expect(store.getSnapshot().busy).toBe(true);
    await expect(store.execute({ kind: 'chat.create' })).rejects.toMatchObject({ name: 'WorkspaceCommandNotStartedError' });
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/workspace/commands/${admitted}/cancel-transcription`);
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ credentials: 'same-origin', headers: { 'X-Still-CSRF': 'csrf-test' } });

    commandReply.resolve(body({ schemaVersion: 1, commandId: admitted, status: 'inspect_required' }));
    await expect(command).resolves.toMatchObject({ status: 'inspect_required' });
    expect(store.getSnapshot().pendingCommand).toEqual({ commandId: admitted, kind: 'notes.transcribe' });
    cleanup();
  });

  it('clears only an admission it published when the caller declines before dispatch', async () => {
    const fetcher = installFetch(async (path) => {
      if (path === '/api/workspace/snapshot') return body(snapshot());
      throw new Error(`Unexpected request ${path}`);
    });
    const store = new CloudWorkspaceSessionStore(session);
    const cleanup = store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    await expect(store.execute({ kind: 'notes.transcribe', noteId: captureId, expectedNoteRevision: 1 }, () => {
      throw new Error('declined before dispatch');
    })).rejects.toMatchObject({ name: 'WorkspaceCommandNotStartedError' });
    expect(store.getSnapshot().pendingCommand).toBeUndefined();
    expect(store.getSnapshot().refreshRequired).toBe(false);
    expect(fetcher.mock.calls.filter(([path, init]) => path === '/api/workspace/commands' && init.method === 'POST')).toHaveLength(0);
    cleanup();
  });

  it('keeps a timed-out command pending for inspection and never sends it again', async () => {
    const commandReply = deferred<ReturnType<typeof body>>();
    const postStarted = deferred<void>();
    const fetcher = installFetch(async (path, init) => {
      if (path === '/api/workspace/snapshot') return body(snapshot());
      if (path === '/api/workspace/commands' && init.method === 'POST') { postStarted.resolve(); return commandReply.promise; }
      throw new Error(`Unexpected request ${path}`);
    });
    const store = new CloudWorkspaceSessionStore(session);
    const cleanup = store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    vi.useFakeTimers();
    const command = store.execute({ kind: 'notes.transcribe', noteId: captureId, expectedNoteRevision: 1 });
    const timedOut = expect(command).rejects.toMatchObject({ name: 'WorkspaceCommandUnknownError' });
    await postStarted.promise;
    await vi.advanceTimersByTimeAsync(30_001);
    await timedOut;
    expect(store.getSnapshot().pendingCommand?.kind).toBe('notes.transcribe');
    expect(fetcher.mock.calls.filter(([path, init]) => path === '/api/workspace/commands' && init.method === 'POST')).toHaveLength(1);
    cleanup();
    commandReply.resolve(body({ schemaVersion: 1, commandId: 'ignored', status: 'finished' }));
  });

  it('fences a late audio-history read after logout and makes its coordinator unusable', async () => {
    const historyReply = deferred<ReturnType<typeof body>>();
    const fetcher = installFetch(async (path) => {
      if (path === '/api/workspace/snapshot') return body(snapshot());
      if (path === '/api/audio/upload-history') return historyReply.promise;
      throw new Error(`Unexpected request ${path}`);
    });
    const store = new CloudWorkspaceSessionStore(session);
    const capture = fakeCapture();
    store.start(() => capture);
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    const beforeRead = store.getSnapshot();
    const historyRead = store.voiceActions.listHistory();
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([path]) => path === '/api/audio/upload-history')).toBe(true));
    store.invalidate();
    historyReply.resolve(body({ schemaVersion: 1, entries: [] }));
    await expect(historyRead).rejects.toMatchObject({ kind: 'disposed' });
    expect(store.getSnapshot().voice).toBeUndefined();
    expect(store.getSnapshot()).not.toBe(beforeRead);
    await expect(Promise.resolve().then(() => store.voiceActions.listHistory())).rejects.toMatchObject({ kind: 'disposed' });
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/audio/upload-history')).toHaveLength(1);
  });

  it('does not dispatch adoption after logout fences an upload that was still awaiting its receipt', async () => {
    const uploadReply = deferred<ReturnType<typeof body>>();
    let uploadRequestCount = 0;
    const fetcher = installFetch(async (path, init) => {
      if (path === '/api/workspace/snapshot') return body(snapshot());
      if (path === '/api/audio/uploads' && init.method === 'POST') { uploadRequestCount += 1; return uploadReply.promise; }
      throw new Error(`Unexpected request ${path}`);
    });
    const store = new CloudWorkspaceSessionStore(session);
    const capture = fakeCapture();
    store.start(() => capture);
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    await store.voiceActions.start();
    const save = store.voiceActions.stopAndSave();
    await vi.waitFor(() => expect(uploadRequestCount).toBe(1));
    store.invalidate();
    uploadReply.resolve(body({ schemaVersion: 1, uploadId, status: 'ready',
      capture: { id: captureId, revision: captureRevision, capturedAt: '2026-10-15T02:00:00.000Z', timeZone: 'Asia/Singapore' },
      media: { mediaId: `still-media:${captureId}`, sha256: 'a'.repeat(64), byteLength: 5, durationSeconds: 2,
        format: 'webm', mimeType: 'audio/webm' } }));
    await expect(save).resolves.toBeUndefined();
    expect(fetcher.mock.calls.some(([path]) => path === '/api/workspace/commands')).toBe(false);
    expect(capture.cancel).not.toHaveBeenCalled();
    expect(uploadRequestCount).toBe(1);
  });

  it('fences an admitted adoption acknowledgement after logout without issuing another write', async () => {
    const adoptionReply = deferred<ReturnType<typeof body>>();
    let commandPosts = 0;
    const readyReceipt = { schemaVersion: 1, uploadId, status: 'ready',
      capture: { id: captureId, revision: captureRevision, capturedAt: '2026-10-15T02:00:00.000Z', timeZone: 'Asia/Singapore' },
      media: { mediaId: `still-media:${captureId}`, sha256: 'a'.repeat(64), byteLength: 5, durationSeconds: 2,
        format: 'webm', mimeType: 'audio/webm' } };
    const fetcher = installFetch(async (path, init) => {
      if (path === '/api/workspace/snapshot') return body(snapshot());
      if (path === `/api/audio/uploads/${uploadId}` && init.method === 'GET') return body(readyReceipt);
      if (path === '/api/workspace/commands' && init.method === 'POST') { commandPosts += 1; return adoptionReply.promise; }
      throw new Error(`Unexpected request ${path}`);
    });
    const store = new CloudWorkspaceSessionStore(session);
    store.start(() => fakeCapture());
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    await store.voiceActions.inspectUpload(uploadId);
    const save = store.voiceActions.saveReady();
    await vi.waitFor(() => expect(commandPosts).toBe(1));
    const sentEnvelope = JSON.parse(String(fetcher.mock.calls.find(([path, init]) => path === '/api/workspace/commands' && init.method === 'POST')?.[1].body));
    store.invalidate();
    adoptionReply.resolve(body({ schemaVersion: 1, commandId: sentEnvelope.commandId, status: 'finished', receipt: {
      schemaVersion: 1, commandId: sentEnvelope.commandId, kind: 'notes.capture.adopt', objectId: captureId,
      captureId, captureRevision,
    } }));
    await expect(save).resolves.toBeUndefined();
    expect(commandPosts).toBe(1);
    expect(fetcher.mock.calls.some(([path]) => path === '/api/workspace/refresh')).toBe(false);
    expect(store.getSnapshot().voice).toBeUndefined();
  });
});
