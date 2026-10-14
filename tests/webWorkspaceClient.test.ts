import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO, type WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { parseWorkspaceCommandEnvelope } from '../src/cloud/workspaceCommands';
import { createWebWorkspaceClient, WorkspaceClientError, WorkspaceCommandUnknownError } from '../src/web/workspaceClient';
import type { AuthenticatedSession } from '../src/web/authClient';

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const session: AuthenticatedSession = Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'private-csrf' });
const commandId = 'e53e7c18-4128-4e80-a55e-331db010a447';
const nextCommandId = '6bcab02c-ab0a-4b82-b2fd-4b3038317c4a';

function snapshot(revision: number): WorkspaceSnapshotDTO {
  let nextId = 0;
  const state = createInitialWorkspaceState(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`);
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision });
}

const body = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const receipt = (
  id: string,
  kind: 'tasks.complete' | 'tasks.reopen' | 'chat.create' = 'tasks.complete',
  objectId = kind === 'chat.create' ? '00000000-0000-4000-8000-000000000099' : 'task-safe-id',
) => ({
  schemaVersion: 1, commandId: id, kind, objectId,
});

function makeClient(fetcher: (input: string, init: RequestInit) => Promise<ReturnType<typeof body>>, current: () => boolean = () => true, ids = [commandId, nextCommandId]) {
  const dto = snapshot(1);
  const decodeSnapshot = (value: unknown): WorkspaceSnapshotDTO => {
    if (!value || typeof value !== 'object' || JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('invalid safe DTO');
    return dto;
  };
  return createWebWorkspaceClient(session, {
    assertCurrent: () => { if (!current()) throw new Error('session changed'); },
    decodeSnapshot,
    fetcher: fetcher as never,
    makeCommandId: () => ids.shift() ?? nextCommandId,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('same-origin web workspace command client', () => {
  it('uses relative endpoints, strict command envelopes, CSRF, and the injected full DTO decoder', async () => {
    const dto = snapshot(1);
    const updatedDto = snapshot(2);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: receipt(commandId, 'tasks.complete', 'task-safe-id'), snapshot: updatedDto }));
    const decodeSnapshot = (value: unknown) => {
      if (JSON.stringify(value) === JSON.stringify(dto)) return dto;
      if (JSON.stringify(value) === JSON.stringify(updatedDto)) return updatedDto;
      throw new Error('invalid safe DTO');
    };
    const client = createWebWorkspaceClient(session, { assertCurrent: () => undefined, decodeSnapshot, fetcher, makeCommandId: () => commandId });

    await client.getSnapshot();
    const result = await client.execute({ kind: 'tasks.complete', taskId: 'task-safe-id' });
    expect(result.status).toBe('finished');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/workspace/snapshot', '/api/workspace/commands']);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    const [, init] = fetcher.mock.calls[1]!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Still-CSRF': 'private-csrf' });
    const sent = JSON.parse(String(init.body)) as unknown;
    expect(parseWorkspaceCommandEnvelope(sent)).toMatchObject({
      schemaVersion: 1,
      commandId,
      expectedRevision: 1,
      expectedPrivacyEpoch: 3,
      command: { kind: 'tasks.complete', taskId: 'task-safe-id' },
    });
    expect(JSON.stringify(result)).not.toContain('private-csrf');
    client.dispose();
  });

  it('holds an uncertain command across refresh and only explicit matching receipt inspection clears it', async () => {
    const dto = snapshot(1);
    const updatedDto = snapshot(2);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockRejectedValueOnce(new Error('connection dropped after dispatch'))
      .mockResolvedValueOnce(body(dto))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: receipt(commandId, 'tasks.complete', 'task-safe-id'), snapshot: updatedDto }))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId: nextCommandId, status: 'claimed' }));
    const decodeSnapshot = (value: unknown) => {
      if (JSON.stringify(value) === JSON.stringify(dto)) return dto;
      if (JSON.stringify(value) === JSON.stringify(updatedDto)) return updatedDto;
      throw new Error('invalid safe DTO');
    };
    const client = createWebWorkspaceClient(session, { assertCurrent: () => undefined, decodeSnapshot, fetcher, makeCommandId: () => fetcher.mock.calls.length === 1 ? commandId : nextCommandId });

    await client.getSnapshot();
    await expect(client.execute({ kind: 'tasks.complete', taskId: 'task-safe-id' })).rejects.toMatchObject({
      name: 'WorkspaceCommandUnknownError', commandId, reason: 'network',
    } satisfies Partial<WorkspaceCommandUnknownError>);
    expect(client.getPendingCommand()).toEqual({ commandId, command: { kind: 'tasks.complete', taskId: 'task-safe-id' } });
    await expect(client.execute({ kind: 'chat.create', title: 'Another action' })).rejects.toMatchObject({ kind: 'busy' });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await client.refresh();
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    await expect(client.inspectCommand(nextCommandId)).rejects.toMatchObject({ kind: 'busy' });
    const checked = await client.inspectCommand();
    expect(checked.status).toBe('finished');
    expect(client.getPendingCommand()).toBeUndefined();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/workspace/snapshot', '/api/workspace/commands', '/api/workspace/refresh',
      `/api/workspace/commands/${commandId}`,
    ]);
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect(fetcher.mock.calls[2]?.[1].headers).toMatchObject({ 'X-Still-CSRF': 'private-csrf' });
    client.dispose();
  });

  it('fences an old snapshot after session invalidation and never publishes it', async () => {
    const pending = deferred<ReturnType<typeof body>>();
    let current = true;
    const fetcher = vi.fn(() => pending.promise);
    const client = makeClient(fetcher, () => current);
    const request = client.getSnapshot();
    current = false;
    pending.resolve(body(snapshot(1)));
    await expect(request).rejects.toMatchObject({ kind: 'stale' } satisfies Partial<WorkspaceClientError>);
    await expect(client.execute({ kind: 'chat.create' })).rejects.toMatchObject({ kind: 'stale' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('rejects malformed acknowledgements as unknown, withholds automatic replay, and uses no browser persistence', async () => {
    const localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', localStorage);
    const dto = snapshot(1);
    const fetcher = vi.fn().mockResolvedValueOnce(body(dto)).mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: { ...receipt(commandId), secret: 'must not escape' } }));
    const client = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => { if (JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('bad DTO'); return dto; },
      fetcher,
      makeCommandId: () => commandId,
    });
    await client.getSnapshot();
    await expect(client.execute({ kind: 'chat.create' })).rejects.toMatchObject({ name: 'WorkspaceCommandUnknownError', reason: 'invalid_acknowledgement' });
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    client.dispose();
    expect(client.getPendingCommand()).toBeUndefined();
  });

  it('keeps a command unresolved after a late authorization error and binds receipt ids without a held envelope', async () => {
    const dto = snapshot(1);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockResolvedValueOnce(body({ message: 'private server detail' }, 403));
    const client = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => { if (JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('bad DTO'); return dto; },
      fetcher,
      makeCommandId: () => commandId,
    });
    await client.getSnapshot();
    await expect(client.execute({ kind: 'tasks.complete', taskId: 'task-safe-id' })).rejects.toMatchObject({
      name: 'WorkspaceCommandUnknownError', commandId,
    });
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();

    const mismatchFetcher = vi.fn().mockResolvedValue(body({
      schemaVersion: 1, commandId: nextCommandId, status: 'finished', receipt: receipt(commandId),
    }));
    const mismatchClient = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => { if (JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('bad DTO'); return dto; },
      fetcher: mismatchFetcher,
    });
    await expect(mismatchClient.inspectCommand(nextCommandId)).rejects.toMatchObject({ kind: 'malformed' });
    mismatchClient.dispose();
  });

  it('requires task receipts to name the held task for both acknowledgements and inspections', async () => {
    const dto = snapshot(1);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: receipt(commandId, 'tasks.complete', 'another-task-id') }))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: receipt(commandId, 'tasks.complete', 'another-task-id') }));
    const client = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => { if (JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('bad DTO'); return dto; },
      fetcher,
      makeCommandId: () => commandId,
    });
    await client.getSnapshot();
    await expect(client.execute({ kind: 'tasks.complete', taskId: 'task-safe-id' })).rejects.toMatchObject({
      name: 'WorkspaceCommandUnknownError', commandId,
    });
    expect(client.getPendingCommand()).toEqual({ commandId, command: { kind: 'tasks.complete', taskId: 'task-safe-id' } });
    await expect(client.inspectCommand()).rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingCommand()).toEqual({ commandId, command: { kind: 'tasks.complete', taskId: 'task-safe-id' } });
    expect(fetcher).toHaveBeenCalledTimes(3);
    client.dispose();
  });

  it('keeps a revision watermark after receipt reconciliation and rejects out-of-order older snapshots', async () => {
    const first = snapshot(1);
    const older = snapshot(0);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(first))
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: receipt(commandId, 'chat.create') }))
      .mockResolvedValueOnce(body(older));
    const client = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => {
        if (JSON.stringify(value) === JSON.stringify(first)) return first;
        if (JSON.stringify(value) === JSON.stringify(older)) return older;
        throw new Error('bad DTO');
      },
      fetcher,
      makeCommandId: () => commandId,
    });
    await client.getSnapshot();
    await expect(client.execute({ kind: 'chat.create' })).rejects.toBeInstanceOf(WorkspaceCommandUnknownError);
    await client.inspectCommand();
    await expect(client.getSnapshot()).rejects.toMatchObject({ kind: 'stale' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    client.dispose();
  });

  it('does not let an earlier delayed snapshot overwrite a newer explicit read', async () => {
    const first = snapshot(1);
    const later = snapshot(2);
    const delayed = deferred<ReturnType<typeof body>>();
    const fetcher = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(body(later));
    const client = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => {
        if (JSON.stringify(value) === JSON.stringify(first)) return first;
        if (JSON.stringify(value) === JSON.stringify(later)) return later;
        throw new Error('bad DTO');
      },
      fetcher,
    });
    const earlierRead = client.getSnapshot();
    await expect(client.refresh()).resolves.toMatchObject({ revision: 2 });
    delayed.resolve(body(first));
    await expect(earlierRead).rejects.toMatchObject({ kind: 'stale' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();
  });
});
