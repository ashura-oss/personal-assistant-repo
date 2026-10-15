import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO, type WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { parseWorkspaceCommandEnvelope, parseWorkspaceCommandReceipt } from '../src/cloud/workspaceCommands';
import { createWebWorkspaceClient, WorkspaceClientError, WorkspaceCommandNotStartedError, WorkspaceCommandUnknownError } from '../src/web/workspaceClient';
import { parseWorkspaceCommandHistoryPage } from '../src/cloud/workspaceCommandHistory';
import { WORKSPACE_COMMAND_HISTORY_KINDS as SERVER_HISTORY_KINDS, workspaceCommandKindFromJournal as serverJournalKind } from '../server/src/workspaceCommandHistory';
import { WORKSPACE_COMMAND_HISTORY_KINDS as CLIENT_HISTORY_KINDS, workspaceCommandKindFromJournal as clientJournalKind } from '../src/cloud/workspaceCommandHistory';
import type { AuthenticatedSession } from '../src/web/authClient';

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const session: AuthenticatedSession = Object.freeze({ authenticated: true, workspaceId, privacyEpoch: 3, csrfToken: 'private-csrf' });
const commandId = 'e53e7c18-4128-4e80-a55e-331db010a447';
const nextCommandId = '6bcab02c-ab0a-4b82-b2fd-4b3038317c4a';
const conversationId = '51ec9e62-8a76-4cb8-bc1e-f34e26d5177b';
const anotherConversationId = 'ec6cf1a5-c680-4163-9fe0-615e1e7b5cfb';
const parentTurnId = 'b095d70b-0061-431e-b89c-a96c3230e9a3';
const anotherTurnId = '0ff611e5-2a17-4362-a94b-050e81565445';
const jobId = 'bdb51402-7b76-47a6-9a1a-24e022d36bb0';

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
  it('keeps the server projection map and browser history decoder on the same public command kinds', () => {
    expect(SERVER_HISTORY_KINDS).toEqual(['tasks.complete', 'tasks.reopen', 'chat.create', 'settings.update', 'notes.save', 'notes.capture.adopt',
      'notes.updateTranscript', 'assistant.batch.submitNote', 'assistant.batch.check', 'chat.submit', 'chat.refine', 'notes.transcribe', 'accounts.installOAuth',
      'documents.save', 'knowledge.person.save', 'knowledge.project.save', 'knowledge.entity.archive', 'knowledge.fact.save', 'knowledge.fact.remove',
      'knowledge.contact.save', 'knowledge.contact.remove', 'knowledge.member.save', 'knowledge.member.remove']);
    expect(CLIENT_HISTORY_KINDS).toEqual(SERVER_HISTORY_KINDS);
    for (const kind of SERVER_HISTORY_KINDS) {
      expect(serverJournalKind(kind.toLowerCase())).toBe(kind);
      expect(clientJournalKind(kind.toLowerCase())).toBe(kind);
    }
    expect(parseWorkspaceCommandHistoryPage({ entries: [{ updatedAt: 2, createdAt: 1, status: 'finished',
      kind: 'tasks.complete', commandId }], schemaVersion: 1 }).entries[0]?.commandId).toBe(commandId);
  });

  it('validates closed document and knowledge editor commands before they can be admitted', () => {
    const personId = '20000000-0000-4000-8000-000000000001';
    const validDocument = { kind: 'documents.save', path: `people/${personId}.md`, content: 'Narrative', expectedRevision: null,
      expectedEntityRevision: 2 } as const;
    expect(parseWorkspaceCommandEnvelope({ schemaVersion: 1, commandId, expectedRevision: 1, expectedPrivacyEpoch: 3,
      command: validDocument }).command).toEqual(validDocument);
    const personCreate = { kind: 'knowledge.person.save', operation: 'create',
      input: { name: 'Ada', aliases: ['A.'], narrative: 'Notes' } } as const;
    expect(parseWorkspaceCommandEnvelope({ schemaVersion: 1, commandId, expectedRevision: 1, expectedPrivacyEpoch: 3,
      command: personCreate }).command).toMatchObject(personCreate);

    for (const command of [
      { ...validDocument, path: '../outside.md' },
      { ...validDocument, path: `people/${personId}.md`, expectedEntityRevision: undefined },
      { kind: 'documents.save', path: 'notes/readme.md', content: 'x', expectedRevision: null, expectedEntityRevision: 1 },
      { kind: 'knowledge.person.save', operation: 'create', input: { name: 'Ada', aliases: [], narrative: '', id: personId } },
      { kind: 'knowledge.person.save', operation: 'update', input: { id: personId, expectedRevision: 1, name: 'Ada', aliases: [], narrative: '' } },
      { kind: 'knowledge.contact.remove', entityKind: 'project', entityId: personId, expectedEntityRevision: 1, itemId: personId },
      { kind: 'knowledge.member.save', entityKind: 'project', entityId: personId, expectedEntityRevision: 1, personId, personRevision: 0, role: 'lead' },
    ]) {
      expect(() => parseWorkspaceCommandEnvelope({ schemaVersion: 1, commandId, expectedRevision: 1, expectedPrivacyEpoch: 3, command })).toThrow('workspace_command_invalid');
    }
  });

  it('binds metadata receipts to exact document parents, entity kinds, and known item IDs', () => {
    const personId = '20000000-0000-4000-8000-000000000001';
    const itemId = '20000000-0000-4000-8000-000000000002';
    const documentReceipt = { schemaVersion: 1, commandId, kind: 'documents.save', objectId: `people/${personId}.md`, documentRevision: 3,
      entityKind: 'person', entityId: personId, entityRevision: 4 };
    expect(parseWorkspaceCommandReceipt(documentReceipt, { commandId, kind: 'documents.save', objectId: documentReceipt.objectId,
      entityKind: 'person', entityId: personId })).toMatchObject(documentReceipt);
    expect(() => parseWorkspaceCommandReceipt({ ...documentReceipt, entityId: itemId }, { commandId, kind: 'documents.save' })).toThrow('workspace_command_receipt_invalid');
    expect(parseWorkspaceCommandReceipt({ schemaVersion: 1, commandId, kind: 'knowledge.contact.remove', objectId: personId,
      entityKind: 'person', entityRevision: 5, itemId }, { commandId, kind: 'knowledge.contact.remove', objectId: personId,
      entityKind: 'person', itemId })).toMatchObject({ entityRevision: 5, itemId });
    expect(() => parseWorkspaceCommandReceipt({ schemaVersion: 1, commandId, kind: 'knowledge.contact.remove', objectId: personId,
      entityKind: 'project', entityRevision: 5, itemId }, { commandId, kind: 'knowledge.contact.remove' })).toThrow('workspace_command_receipt_invalid');
  });

  it('signals cancellation independently while a command POST remains pending', async () => {
    const commandResponse = deferred<ReturnType<typeof body>>();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(snapshot(1)))
      .mockReturnValueOnce(commandResponse.promise)
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'cancellation_requested' }));
    const client = makeClient(fetcher);
    await client.getSnapshot();
    const command = client.execute({ kind: 'chat.create' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await expect(client.cancelTranscription(commandId)).resolves.toBe('cancellation_requested');
    expect(fetcher.mock.calls[2]?.[0]).toBe(`/api/workspace/commands/${commandId}/cancel-transcription`);
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin' });
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    commandResponse.resolve(body({ schemaVersion: 1, commandId, status: 'finished', receipt: {
      schemaVersion: 1, commandId, kind: 'chat.create', objectId: '00000000-0000-4000-8000-000000000099',
    }, snapshot: snapshot(1) }));
    await expect(command).resolves.toMatchObject({ status: 'finished' });
    expect(client.getPendingCommand()).toBeUndefined();
    client.dispose();
  });

  it('bounds cancellation even when fetch ignores abort and rejects a late acknowledgement', async () => {
    vi.useFakeTimers();
    const late = deferred<ReturnType<typeof body>>();
    const fetcher = vi.fn().mockReturnValueOnce(late.promise);
    const client = createWebWorkspaceClient(session, { assertCurrent() {}, decodeSnapshot: () => snapshot(1), fetcher: fetcher as never, timeoutMs: 10 });
    const cancellation = client.cancelTranscription(commandId);
    const timedOut = expect(cancellation).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    late.resolve(body({ schemaVersion: 1, commandId, status: 'cancellation_requested' }));
    expect(client.getPendingCommand()).toBeUndefined();
    client.dispose();
  });

  it('decodes bounded history and explicitly inspects a recovered receipt without clearing unrelated pending work', async () => {
    const dto = snapshot(1);
    const recoveredId = nextCommandId;
    const historyEntry = { commandId: recoveredId, kind: 'notes.save', status: 'finished', createdAt: 100, updatedAt: 120 } as const;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockRejectedValueOnce(new Error('lost command response'))
      .mockResolvedValueOnce(body({ schemaVersion: 1, entries: [historyEntry], nextCursor: 'YXNk' }))
      .mockResolvedValueOnce(body({ schemaVersion: 1, entries: [] }))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId: recoveredId, status: 'finished', receipt: {
        schemaVersion: 1, commandId: recoveredId, kind: 'notes.save', objectId: 'note-safe-id',
      } }));
    const client = makeClient(fetcher, () => true, [commandId, nextCommandId]);
    await client.getSnapshot();
    await expect(client.execute({ kind: 'chat.create' })).rejects.toBeInstanceOf(WorkspaceCommandUnknownError);
    const page = await client.listCommandHistory();
    expect(page.entries).toEqual([historyEntry]);
    expect(fetcher.mock.calls[2]?.[0]).toBe('/api/workspace/command-history');
    await expect(client.listCommandHistory(page.nextCursor)).resolves.toMatchObject({ entries: [] });
    expect(fetcher.mock.calls[3]?.[0]).toBe('/api/workspace/command-history?cursor=YXNk');
    // The selected row is explicit authority for the receipt kind and does not clear the unrelated pending command.
    await expect(client.inspectRecoveredCommand(page.entries[0]!)).resolves.toMatchObject({ status: 'finished', receipt: { kind: 'notes.save' } });
    expect(fetcher.mock.calls[4]?.[0]).toBe(`/api/workspace/commands/${recoveredId}`);
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    client.dispose();
  });

  it('rejects recovered kind mismatches and history responses after owner generation changes', async () => {
    const entry = { commandId: nextCommandId, kind: 'tasks.complete', status: 'finished', createdAt: 1, updatedAt: 1 } as const;
    const mismatch = makeClient(vi.fn().mockResolvedValue(body({ schemaVersion: 1, commandId: nextCommandId, status: 'finished', receipt: {
      schemaVersion: 1, commandId: nextCommandId, kind: 'tasks.reopen', objectId: 'task-safe-id',
    } })));
    await expect(mismatch.inspectRecoveredCommand(entry)).rejects.toMatchObject({ kind: 'malformed' });
    mismatch.dispose();

    let current = true;
    const response = deferred<ReturnType<typeof body>>();
    const client = makeClient(vi.fn().mockReturnValueOnce(response.promise), () => current);
    const pending = client.listCommandHistory();
    current = false;
    response.resolve(body({ schemaVersion: 1, entries: [entry] }));
    await expect(pending).rejects.toMatchObject({ kind: 'stale' });
    client.dispose();
    expect(() => parseWorkspaceCommandHistoryPage({ schemaVersion: 1, entries: [entry, entry] })).toThrow();
    const accessor = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { throw new Error('must not execute'); } });
    expect(() => parseWorkspaceCommandHistoryPage(accessor)).toThrow();
  });

  it('keeps a same-ID recovered capture unresolved when its receipt names another capture revision', async () => {
    const dto = snapshot(1);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockRejectedValueOnce(new Error('lost capture response'))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: {
        schemaVersion: 1, commandId, kind: 'notes.capture.adopt', objectId: conversationId,
        captureId: conversationId, captureRevision: anotherTurnId,
      } }));
    const client = makeClient(fetcher, () => true, [commandId]);
    await client.getSnapshot();
    await expect(client.execute({ kind: 'notes.capture.adopt', captureId: conversationId, captureRevision: parentTurnId }))
      .rejects.toBeInstanceOf(WorkspaceCommandUnknownError);
    await expect(client.inspectRecoveredCommand({ commandId, kind: 'notes.capture.adopt', status: 'finished', createdAt: 1, updatedAt: 1 }))
      .rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingCommand()?.command).toEqual({ kind: 'notes.capture.adopt', captureId: conversationId, captureRevision: parentTurnId });
    client.dispose();
  });

  it('rejects snapshots on both receipt GET paths before decoding or mutating pending and revision state', async () => {
    const first = snapshot(1);
    const later = snapshot(2);
    const impossible = snapshot(99);
    const decodeSnapshot = vi.fn((value: unknown) => {
      if (JSON.stringify(value) === JSON.stringify(first)) return first;
      if (JSON.stringify(value) === JSON.stringify(later)) return later;
      if (JSON.stringify(value) === JSON.stringify(impossible)) return impossible;
      throw new Error('unexpected snapshot');
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(first))
      .mockRejectedValueOnce(new Error('lost command response'))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId: commandId, status: 'finished',
        receipt: receipt(commandId, 'tasks.complete', 'task-safe-id'), snapshot: impossible }))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished',
        receipt: receipt(commandId, 'tasks.complete', 'task-safe-id'), snapshot: impossible }))
      .mockResolvedValueOnce(body(later))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: receipt(commandId, 'tasks.complete', 'task-safe-id') }))
      .mockResolvedValueOnce(body(later))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId: nextCommandId, status: 'finished', receipt: receipt(nextCommandId, 'chat.create') }));
    const client = createWebWorkspaceClient(session, { assertCurrent: () => undefined, decodeSnapshot, fetcher,
      makeCommandId: () => fetcher.mock.calls.length <= 2 ? commandId : nextCommandId });

    await client.getSnapshot();
    await expect(client.execute({ kind: 'tasks.complete', taskId: 'task-safe-id' })).rejects.toBeInstanceOf(WorkspaceCommandUnknownError);
    const recoveredEntry = { commandId: nextCommandId, kind: 'chat.create', status: 'finished', createdAt: 1, updatedAt: 1 } as const;
    await expect(client.inspectRecoveredCommand(recoveredEntry)).rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    await expect(client.inspectCommand()).rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    await expect(client.getSnapshot()).resolves.toBe(later);
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    expect(decodeSnapshot).toHaveBeenCalledTimes(2);
    await client.inspectCommand();
    expect(client.getPendingCommand()).toBeUndefined();
    await expect(client.getSnapshot()).resolves.toBe(later);
    await client.execute({ kind: 'chat.create' });
    expect(JSON.parse(String(fetcher.mock.calls[7]?.[1].body))).toMatchObject({ expectedRevision: 2,
      command: { kind: 'chat.create' } });
    client.dispose();
  });

  it('binds capture adoption receipts to the exact capture revision and reports only pre-fetch admission failures as not started', async () => {
    const dto = snapshot(1);
    const captureId = conversationId;
    const captureRevision = parentTurnId;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: {
        schemaVersion: 1, commandId, kind: 'notes.capture.adopt', objectId: captureId, captureId, captureRevision,
      } }));
    const client = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => { if (JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('bad DTO'); return dto; },
      fetcher,
      makeCommandId: () => commandId,
    });
    await client.getSnapshot();
    const admitted = vi.fn();
    await expect(client.execute({ kind: 'notes.capture.adopt', captureId, captureRevision }, admitted)).resolves.toMatchObject({ status: 'finished' });
    expect(admitted).toHaveBeenCalledOnce();
    expect(admitted.mock.calls[0]?.[0]).toMatchObject({ commandId, command: { kind: 'notes.capture.adopt', captureId, captureRevision } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();

    const predispatch = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => { if (JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('bad DTO'); return dto; },
      fetcher: vi.fn().mockResolvedValue(body(dto)),
    });
    await predispatch.getSnapshot();
    await expect(predispatch.execute({ kind: 'chat.create' }, () => { throw new Error('owner binding rejected'); })).rejects.toBeInstanceOf(WorkspaceCommandNotStartedError);
    expect(predispatch.getPendingCommand()).toBeUndefined();
    predispatch.dispose();
  });

  it('binds OAuth install receipt inspection to the exact stage without exposing credential material', async () => {
    const dto = snapshot(1);
    const stageId = conversationId;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: {
        schemaVersion: 1, commandId, kind: 'accounts.installOAuth', objectId: 'acct:opaque:日本語', stageId, accountGeneration: 4,
      } }));
    const client = makeClient(fetcher, () => true, [commandId]);
    await client.getSnapshot();
    await expect(client.execute({ kind: 'accounts.installOAuth', stageId })).resolves.toMatchObject({
      status: 'finished', receipt: { kind: 'accounts.installOAuth', stageId, accountGeneration: 4 },
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body))).toMatchObject({ command: { kind: 'accounts.installOAuth', stageId } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();

    const mismatch = makeClient(vi.fn()
      .mockResolvedValueOnce(body(snapshot(1)))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: {
        schemaVersion: 1, commandId, kind: 'accounts.installOAuth', objectId: 'acct:opaque:日本語', stageId: anotherConversationId, accountGeneration: 4,
      } }))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: {
        schemaVersion: 1, commandId, kind: 'accounts.installOAuth', objectId: 'acct:opaque:日本語', stageId: anotherConversationId, accountGeneration: 4,
      } })), () => true, [commandId]);
    await mismatch.getSnapshot();
    await expect(mismatch.execute({ kind: 'accounts.installOAuth', stageId })).rejects.toBeInstanceOf(WorkspaceCommandUnknownError);
    await expect(mismatch.inspectCommand()).rejects.toMatchObject({ kind: 'malformed' });
    expect(mismatch.getPendingCommand()?.command).toEqual({ kind: 'accounts.installOAuth', stageId });
    mismatch.dispose();
  });

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
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: receipt(commandId, 'tasks.complete', 'task-safe-id') }))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId: nextCommandId, status: 'claimed' }));
    const decodeSnapshot = (value: unknown) => {
      if (JSON.stringify(value) === JSON.stringify(dto)) return dto;
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

  it('binds settings.update to the fixed receipt object and never resubmits after an unknown acknowledgement', async () => {
    const dto = snapshot(1);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockRejectedValueOnce(new Error('connection lost after POST'))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: {
        schemaVersion: 1, commandId, kind: 'settings.update', objectId: 'other-settings-object',
      } }));
    const client = createWebWorkspaceClient(session, { assertCurrent() {}, decodeSnapshot: () => dto,
      fetcher: fetcher as never, makeCommandId: () => commandId });
    await client.getSnapshot();
    await expect(client.execute({ kind: 'settings.update', patch: { timezone: 'Asia/Singapore' } }))
      .rejects.toBeInstanceOf(WorkspaceCommandUnknownError);
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    await expect(client.inspectCommand()).rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingCommand()?.commandId).toBe(commandId);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    client.dispose();
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
    await expect(client.inspectRecoveredCommand({ commandId, kind: 'tasks.complete', status: 'finished', createdAt: 1, updatedAt: 1 }))
      .rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingCommand()?.command).toEqual({ kind: 'tasks.complete', taskId: 'task-safe-id' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    client.dispose();
  });

  it('sends large text within the text-command allowance and keeps mismatched chat lineage receipts unresolved', async () => {
    const dto = snapshot(1);
    const longText = '😀\\\n漢'.repeat(5_000);
    const wrongReceipt = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      commandId,
      kind: 'chat.submit',
      objectId: anotherConversationId,
      jobId,
      turnId: anotherTurnId,
      ...overrides,
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(body(dto))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: wrongReceipt() }))
      .mockResolvedValueOnce(body({ schemaVersion: 1, commandId, status: 'finished', receipt: wrongReceipt() }));
    const client = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => { if (JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('bad DTO'); return dto; },
      fetcher,
      makeCommandId: () => commandId,
    });
    await client.getSnapshot();
    await expect(client.execute({ kind: 'chat.submit', conversationId, text: longText })).rejects.toMatchObject({
      name: 'WorkspaceCommandUnknownError', commandId,
    });
    const submittedBody = JSON.parse(String(fetcher.mock.calls[1]?.[1].body)) as { command: { text: string } };
    expect(submittedBody.command.text).toBe(longText);
    expect(Buffer.byteLength(String(fetcher.mock.calls[1]?.[1].body), 'utf8')).toBeGreaterThan(16 * 1024);
    expect(client.getPendingCommand()?.command).toEqual({ kind: 'chat.submit', conversationId, text: longText });
    await expect(client.inspectCommand()).rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingCommand()?.command).toEqual({ kind: 'chat.submit', conversationId, text: longText });
    expect(fetcher).toHaveBeenCalledTimes(3);
    client.dispose();
  });

  it('binds chat refinement receipts to the requested conversation and parent turn', async () => {
    const dto = snapshot(1);
    const response = (parentTurnId: string) => ({ schemaVersion: 1, commandId, status: 'finished', receipt: {
      schemaVersion: 1, commandId, kind: 'chat.refine', objectId: conversationId, jobId,
      turnId: anotherTurnId, parentTurnId,
    } });
    const fetcher = vi.fn().mockResolvedValueOnce(body(dto)).mockResolvedValueOnce(body(response('wrong-parent')))
      .mockResolvedValueOnce(body(response('wrong-parent')));
    const client = createWebWorkspaceClient(session, {
      assertCurrent: () => undefined,
      decodeSnapshot: (value) => { if (JSON.stringify(value) !== JSON.stringify(dto)) throw new Error('bad DTO'); return dto; },
      fetcher,
      makeCommandId: () => commandId,
    });
    await client.getSnapshot();
    const command = { kind: 'chat.refine' as const, conversationId, parentTurnId, effort: 'high' as const };
    await expect(client.execute(command)).rejects.toMatchObject({ name: 'WorkspaceCommandUnknownError', commandId });
    expect(client.getPendingCommand()?.command).toEqual(command);
    await expect(client.inspectCommand()).rejects.toMatchObject({ kind: 'malformed' });
    expect(client.getPendingCommand()?.command).toEqual(command);
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
