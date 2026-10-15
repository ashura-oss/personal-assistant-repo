/** Same-origin, receipt-aware transport for the authenticated browser workspace. */
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import {
  parseWorkspaceCommandEnvelope,
  parseWorkspaceCommandId,
  parseWorkspaceCommandReceipt,
  type WorkspaceCommand,
  type WorkspaceCommandEnvelope,
  type WorkspaceCommandResponse,
} from '../cloud/workspaceCommands';
import type { AuthenticatedSession } from './authClient';
import { parseWorkspaceCommandHistoryPage, type WorkspaceCommandHistoryEntry, type WorkspaceCommandHistoryKind,
  type WorkspaceCommandHistoryPage } from '../cloud/workspaceCommandHistory';

export const WORKSPACE_REQUEST_TIMEOUT_MS = 30_000;

export type WorkspaceClientOptions = Readonly<{
  /** Must recursively validate the complete safe WorkspaceSnapshotDTO projection. */
  decodeSnapshot: (value: unknown) => WorkspaceSnapshotDTO;
  /** Throws when the authenticated session or owning workspace is no longer current. */
  assertCurrent: () => void;
  fetcher?: FetchLike;
  timeoutMs?: number;
  makeCommandId?: () => string;
}>;

export type PendingWorkspaceCommand = Readonly<{
  commandId: string;
  command: WorkspaceCommand;
}>;

export type WorkspaceCommandAdmission = WorkspaceCommandEnvelope;

export type WorkspaceClient = Readonly<{
  getSnapshot(): Promise<WorkspaceSnapshotDTO>;
  refresh(): Promise<WorkspaceSnapshotDTO>;
  execute(command: WorkspaceCommand, onAdmitted?: (envelope: WorkspaceCommandAdmission) => void): Promise<WorkspaceCommandResponse>;
  inspectCommand(commandId?: string): Promise<WorkspaceCommandResponse>;
  inspectRecoveredCommand(entry: WorkspaceCommandHistoryEntry): Promise<WorkspaceCommandResponse>;
  listCommandHistory(cursor?: string): Promise<WorkspaceCommandHistoryPage>;
  getPendingCommand(): PendingWorkspaceCommand | undefined;
  dispose(): void;
}>;

export class WorkspaceClientError extends Error {
  readonly kind: 'http' | 'network' | 'timeout' | 'malformed' | 'busy' | 'disposed' | 'stale' | 'snapshot_required';
  readonly status?: number;

  constructor(kind: WorkspaceClientError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'WorkspaceClientError';
    this.kind = kind;
    this.status = status;
  }
}

export class WorkspaceCommandUnknownError extends Error {
  readonly name = 'WorkspaceCommandUnknownError';
  constructor(readonly commandId: string, readonly reason: 'network' | 'timeout' | 'invalid_acknowledgement' | 'server_error') {
    super('The workspace command outcome is unknown. Check its receipt before trying another action.');
  }
}

/** The allowlist/envelope was rejected before the command entered fetch. */
export class WorkspaceCommandNotStartedError extends Error {
  readonly name = 'WorkspaceCommandNotStartedError';
  constructor(message = 'The command was not sent. Review the workspace and try again.') { super(message); }
}

type SafeResponse = Pick<Response, 'ok' | 'status' | 'json'>;
type FetchLike = (input: string, init: RequestInit) => Promise<SafeResponse>;
type HeldCommand = Readonly<{ envelope: WorkspaceCommandEnvelope }>;
type ParsedCommandResponse = Readonly<{
  schemaVersion: 1;
  commandId: string;
  status: WorkspaceCommandResponse['status'];
  receipt?: WorkspaceCommandResponse['receipt'];
  snapshot?: unknown;
}>;

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') return async () => { throw new Error('Fetch unavailable'); };
  return globalThis.fetch.bind(globalThis) as FetchLike;
}

function makeCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') throw new WorkspaceClientError('network', 'A secure command identifier is unavailable.');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fixedHttpMessage(status: number): string {
  if (status === 401 || status === 403) return 'Your workspace session needs to be checked before continuing.';
  if (status === 404) return 'That workspace item is no longer available.';
  if (status === 409) return 'The workspace changed. Refresh it before trying that action again.';
  if (status === 422) return 'That workspace action could not be applied.';
  if (status === 429) return 'Workspace actions are temporarily limited. Try again later.';
  if (status >= 500 || status === 408 || status === 425) return 'The workspace service is busy. Check the command receipt before continuing.';
  return 'The workspace request could not be completed.';
}

function statusFromError(error: unknown): number | undefined {
  return error instanceof WorkspaceClientError ? error.status : undefined;
}

/**
 * Browser workspace transport. It only sends allowlisted shared commands and
 * keeps an unresolved command envelope in memory until an explicit receipt read.
 */
export function createWebWorkspaceClient(session: AuthenticatedSession, options: WorkspaceClientOptions): WorkspaceClient {
  if (!session.authenticated || !session.workspaceId || !isGeneration(session.privacyEpoch) || !session.csrfToken) {
    throw new WorkspaceClientError('stale', 'An authenticated workspace session is required.');
  }

  const workspaceId = session.workspaceId;
  const privacyEpoch = session.privacyEpoch;
  const fetcher = options.fetcher ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? WORKSPACE_REQUEST_TIMEOUT_MS;
  let disposed = false;
  let snapshot: WorkspaceSnapshotDTO | undefined;
  let highestRevision = -1;
  let pending: HeldCommand | undefined;
  let operation = 0;

  function assertUsable(): void {
    if (disposed) throw new WorkspaceClientError('disposed', 'This workspace client is no longer active.');
    try {
      options.assertCurrent();
    } catch {
      throw new WorkspaceClientError('stale', 'The workspace session has changed.');
    }
  }

  function assertOperation(ticket: number): void {
    assertUsable();
    if (ticket !== operation) throw new WorkspaceClientError('stale', 'The workspace response is no longer current.');
  }

  function parseSnapshot(value: unknown): WorkspaceSnapshotDTO {
    let decoded: WorkspaceSnapshotDTO;
    try {
      decoded = options.decodeSnapshot(value);
    } catch {
      throw new WorkspaceClientError('malformed', 'The workspace snapshot could not be confirmed.');
    }
    if (!decoded || decoded.schemaVersion !== 1 || decoded.workspaceId !== workspaceId ||
        decoded.privacyEpoch !== privacyEpoch || !isGeneration(decoded.revision)) {
      throw new WorkspaceClientError('malformed', 'The workspace snapshot could not be confirmed.');
    }
    if (decoded.revision < highestRevision) {
      throw new WorkspaceClientError('stale', 'An older workspace snapshot was ignored.');
    }
    highestRevision = decoded.revision;
    return decoded;
  }

  async function request(path: string, init: RequestInit, ticket: number, onDispatch?: () => void): Promise<unknown> {
    assertOperation(ticket);
    const controller = new AbortController();
    let timedOut = false;
    let timeoutReject!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => { timeoutReject = reject; });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      timeoutReject(new WorkspaceClientError('timeout', 'The workspace request timed out.'));
    }, timeoutMs);
    try {
      onDispatch?.();
      const responsePromise = fetcher(path, {
        ...init,
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      const response = await Promise.race([responsePromise, timeoutPromise]);
      assertOperation(ticket);
      if (!response.ok) {
        throw new WorkspaceClientError('http', fixedHttpMessage(response.status), response.status);
      }
      const bodyPromise = response.json();
      const body = await Promise.race([bodyPromise, timeoutPromise]);
      assertOperation(ticket);
      return body;
    } catch (error) {
      if (error instanceof WorkspaceClientError) throw error;
      if (timedOut) throw new WorkspaceClientError('timeout', 'The workspace request timed out.');
      throw new WorkspaceClientError('network', 'The workspace connection was interrupted.');
    } finally {
      clearTimeout(timeout);
    }
  }

  function beginOperation(): number {
    assertUsable();
    operation += 1;
    return operation;
  }

  async function readSnapshot(path: '/api/workspace/snapshot' | '/api/workspace/refresh', method: 'GET' | 'POST'): Promise<WorkspaceSnapshotDTO> {
    const ticket = beginOperation();
    let body: unknown;
    try {
      body = await request(path, {
        method,
        ...(method === 'POST' ? {
          headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': session.csrfToken },
          body: '{}',
        } : {}),
      }, ticket);
    } catch (error) {
      throw error;
    }
    assertOperation(ticket);
    // The snapshot endpoint returns the DTO directly. The injected decoder
    // validates every nested allowlisted field before this value is published.
    const next = parseSnapshot(body);
    assertOperation(ticket);
    snapshot = next;
    return next;
  }

  function parseResponse(value: unknown, expectedCommand?: WorkspaceCommandEnvelope, expectedHistoryKind?: WorkspaceCommandHistoryKind): WorkspaceCommandResponse {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WorkspaceClientError('malformed', 'The workspace command receipt could not be confirmed.');
    }
    const record = value as Record<string, unknown>;
    const allowedKeys = ['schemaVersion', 'commandId', 'status', 'receipt', 'snapshot'];
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key)) ||
        !Object.hasOwn(record, 'schemaVersion') || !Object.hasOwn(record, 'commandId') || !Object.hasOwn(record, 'status')) {
      throw new WorkspaceClientError('malformed', 'The workspace command receipt could not be confirmed.');
    }
    let parsed: ParsedCommandResponse;
    try {
      const commandId = parseWorkspaceCommandId(record.commandId);
      const statuses = ['finished', 'claimed', 'checkpointed', 'inspect_required', 'unverified'] as const;
      if (record.schemaVersion !== 1 || !statuses.includes(record.status as (typeof statuses)[number]) ||
          (expectedCommand && commandId !== expectedCommand.commandId) ||
          (expectedCommand && expectedHistoryKind && expectedCommand.command.kind !== expectedHistoryKind)) throw new Error('response_invalid');
      const status = record.status as WorkspaceCommandResponse['status'];
      const expectedReceipt = expectedCommand ? expectedReceiptFor(expectedCommand) :
        expectedHistoryKind ? { commandId, kind: expectedHistoryKind } : undefined;
      const receipt = Object.hasOwn(record, 'receipt')
        ? parseWorkspaceCommandReceipt(record.receipt, expectedReceipt)
        : undefined;
      if ((status === 'finished' && !receipt) || (status !== 'finished' && receipt)) throw new Error('response_invalid');
      if (receipt && receipt.commandId !== commandId) throw new Error('response_command_mismatch');
      parsed = {
        schemaVersion: 1,
        commandId,
        status,
        ...(receipt ? { receipt } : {}),
        ...(Object.hasOwn(record, 'snapshot') ? { snapshot: record.snapshot } : {}),
      };
    } catch {
      throw new WorkspaceClientError('malformed', 'The workspace command receipt could not be confirmed.');
    }

    let validatedSnapshot: WorkspaceSnapshotDTO | undefined;
    if (parsed.snapshot !== undefined) {
      validatedSnapshot = parseSnapshot(parsed.snapshot);
    }
    return Object.freeze({
      schemaVersion: 1,
      commandId: parsed.commandId,
      status: parsed.status,
      ...(parsed.receipt ? { receipt: parsed.receipt } : {}),
      ...(validatedSnapshot ? { snapshot: validatedSnapshot } : {}),
    });
  }

  async function execute(command: WorkspaceCommand, onAdmitted?: (envelope: WorkspaceCommandAdmission) => void): Promise<WorkspaceCommandResponse> {
    assertUsable();
    if (pending) throw new WorkspaceClientError('busy', 'Check the pending workspace command receipt before another action.');
    if (!snapshot) throw new WorkspaceClientError('snapshot_required', 'Refresh the workspace before making a change.');

    const ticket = beginOperation();
    let envelope: WorkspaceCommandEnvelope;
    try {
      envelope = parseWorkspaceCommandEnvelope({
        schemaVersion: 1,
        commandId: (options.makeCommandId ?? makeCommandId)(),
        expectedRevision: snapshot.revision,
        expectedPrivacyEpoch: privacyEpoch,
        command,
      });
    } catch {
      throw new WorkspaceCommandNotStartedError('The workspace action could not be prepared, so it was not sent.');
    }
    try {
      onAdmitted?.(envelope);
    } catch {
      throw new WorkspaceCommandNotStartedError('The chat request could not be bound to its original message, so it was not sent.');
    }
    pending = Object.freeze({ envelope });
    let dispatched = false;
    try {
      const raw = await request('/api/workspace/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': session.csrfToken },
        body: JSON.stringify(envelope),
      }, ticket, () => { dispatched = true; });
      assertOperation(ticket);
      let response: WorkspaceCommandResponse;
      try {
        response = parseResponse(raw, envelope);
      } catch {
        throw new WorkspaceCommandUnknownError(envelope.commandId, 'invalid_acknowledgement');
      }
      if (response.snapshot) snapshot = response.snapshot;
      else snapshot = undefined;
      if (response.status === 'finished') pending = undefined;
      return response;
    } catch (error) {
      if (!dispatched && error instanceof WorkspaceClientError && error.kind === 'stale') {
        pending = undefined;
        throw error;
      }
      const status = statusFromError(error);
      if (error instanceof WorkspaceCommandUnknownError) throw error;
      const reason = error instanceof WorkspaceClientError && error.kind === 'timeout'
        ? 'timeout'
        : error instanceof WorkspaceClientError && error.kind === 'network'
          ? 'network'
          : status !== undefined
            ? 'server_error'
            : 'invalid_acknowledgement';
      throw new WorkspaceCommandUnknownError(envelope.commandId, reason);
    }
  }

  async function inspect(commandId: string | undefined, expectedHistoryKind?: WorkspaceCommandHistoryKind,
    allowOtherPending = false, clearPendingOnSuccess = true): Promise<WorkspaceCommandResponse> {
    assertUsable();
    if (!allowOtherPending && pending && commandId && commandId !== pending.envelope.commandId) {
      throw new WorkspaceClientError('busy', 'Check the pending workspace command receipt first.');
    }
    let inspectedId: string;
    try {
      inspectedId = parseWorkspaceCommandId(commandId ?? pending?.envelope.commandId ?? '');
    } catch {
      throw new WorkspaceClientError('malformed', 'The workspace command identifier is invalid.');
    }
    if (!allowOtherPending && pending && inspectedId !== pending.envelope.commandId) {
      throw new WorkspaceClientError('busy', 'Check the pending workspace command receipt first.');
    }
    const ticket = beginOperation();
    let raw: unknown;
    try {
      raw = await request(`/api/workspace/commands/${inspectedId}`, { method: 'GET' }, ticket);
    } catch (error) {
      throw error;
    }
    assertOperation(ticket);
    let response: WorkspaceCommandResponse;
    try {
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'snapshot')) throw new Error('inspection_snapshot_forbidden');
      const pendingEnvelope = pending?.envelope.commandId === inspectedId ? pending.envelope : undefined;
      response = parseResponse(raw, pendingEnvelope, expectedHistoryKind);
      if (response.commandId !== inspectedId) throw new Error('command_id_mismatch');
    } catch {
      throw new WorkspaceClientError('malformed', 'The workspace command receipt could not be confirmed.');
    }
    if (clearPendingOnSuccess && response.snapshot) snapshot = response.snapshot;
    if (clearPendingOnSuccess && pending?.envelope.commandId === inspectedId && response.status === 'finished' && response.receipt) {
      pending = undefined;
      if (!response.snapshot) snapshot = undefined;
    }
    return response;
  }

  function inspectCommand(commandId?: string): Promise<WorkspaceCommandResponse> {
    return inspect(commandId);
  }

  async function inspectRecoveredCommand(entry: WorkspaceCommandHistoryEntry): Promise<WorkspaceCommandResponse> {
    let selected: WorkspaceCommandHistoryEntry;
    try { selected = parseWorkspaceCommandHistoryPage({ schemaVersion: 1, entries: [entry] }).entries[0]!; }
    catch { throw new WorkspaceClientError('malformed', 'The selected command history entry is invalid.'); }
    return inspect(selected.commandId, selected.kind, true, false);
  }

  async function listCommandHistory(cursor?: string): Promise<WorkspaceCommandHistoryPage> {
    assertUsable();
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor))) {
      throw new WorkspaceClientError('malformed', 'The command history cursor is invalid.');
    }
    const ticket = beginOperation();
    const raw = await request(`/api/workspace/command-history${cursor === undefined ? '' : `?cursor=${cursor}`}`, { method: 'GET' }, ticket);
    assertOperation(ticket);
    try { return parseWorkspaceCommandHistoryPage(raw); }
    catch { throw new WorkspaceClientError('malformed', 'The command history could not be confirmed.'); }
  }

  return Object.freeze({
    getSnapshot: () => readSnapshot('/api/workspace/snapshot', 'GET'),
    refresh: () => readSnapshot('/api/workspace/refresh', 'POST'),
    execute,
    inspectCommand,
    inspectRecoveredCommand,
    listCommandHistory,
    getPendingCommand: () => pending ? Object.freeze({ commandId: pending.envelope.commandId, command: pending.envelope.command }) : undefined,
    dispose: () => {
      disposed = true;
      operation += 1;
      pending = undefined;
      snapshot = undefined;
    },
  });
}

function expectedReceiptFor(envelope: WorkspaceCommandEnvelope) {
  const { command } = envelope;
  switch (command.kind) {
    case 'tasks.complete': case 'tasks.reopen':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.taskId };
    case 'chat.create': case 'notes.save':
      return { commandId: envelope.commandId, kind: command.kind };
    case 'notes.capture.adopt':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.captureId,
        captureId: command.captureId, captureRevision: command.captureRevision };
    case 'notes.updateTranscript':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.noteId };
    case 'assistant.batch.submitNote':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.noteId };
    case 'assistant.batch.check':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.jobId };
    case 'chat.submit':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.conversationId };
    case 'chat.refine':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.conversationId, parentTurnId: command.parentTurnId };
    default: return assertNever(command);
  }
}

function assertNever(_value: never): never { throw new WorkspaceClientError('malformed', 'The workspace action is unsupported.'); }
