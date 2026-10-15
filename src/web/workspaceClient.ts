/** Same-origin, receipt-aware transport for the authenticated browser workspace. */
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import { parseKnowledgeSourceChoicesDTO, parseKnowledgeSuggestionReviewDTO, type KnowledgeSourceChoicesDTO, type KnowledgeSuggestionReviewDTO } from '../cloud/knowledgeHttpContracts';
import { isCanonicalKnowledgeId } from '../knowledge';
import {
  parseWorkspaceCommandEnvelope,
  parseWorkspaceCommandId,
  parseWorkspaceCommandReceipt,
  canonicalKnowledgeDocumentParent,
  type WorkspaceCommand,
  type WorkspaceCommandEnvelope,
  type WorkspaceCommandResponse,
} from '../cloud/workspaceCommands';
import type { AuthenticatedSession } from './authClient';
import { parsePeriodSummaryApplicationPreviewEnvelope, parsePeriodSummaryReadEnvelope, periodSummaryApplicationPreviewPath, periodSummaryResultPath } from '../cloud/periodSummaryHttpContracts';
import type { PeriodSummaryApplicationPreview, PeriodSummaryResultReview } from '../core';
import { parseWorkspaceCommandHistoryPage, type WorkspaceCommandHistoryEntry, type WorkspaceCommandHistoryKind,
  type WorkspaceCommandHistoryPage } from '../cloud/workspaceCommandHistory';
import { cloudDispatchReviewPath, cloudMailReadPath, cloudProposalReviewPath, cloudReplyBatchReviewPath,
  parseCloudDispatchReview, parseCloudMailReplySource, parseCloudMailReplyText, parseCloudProposalReview, parseCloudReplyBatchReview,
  type ReplyBatchPlanRead } from './cloudMailClient';
import type { DispatchReviewReadDto, MailReplyBatchReviewReadDto, MailReplySourceReadDto, MailReplyTextReadDto, ProposalReviewReadDto } from './mailWorkflowDtos';
import { BACKGROUND_PUBLIC_PAGE_MAX, canonicalBackgroundJson, parseBackgroundPolicyDisplay, parseBackgroundPolicyReceipt,
  parsePauseBackgroundPolicyEnvelope, parseRevokeBackgroundPolicyEnvelope, parseSaveBackgroundPolicyEnvelope,
  type BackgroundPolicyDisplay, type BackgroundPolicyReceipt, type ChangeBackgroundPolicyEnvelope, type SaveBackgroundPolicyEnvelope } from '../cloud/backgroundContracts';
import { parseWorkspaceEraseCancellation, parseWorkspaceErasePlan, parseWorkspaceEraseReceipt, parseWorkspaceEraseStatus,
  type WorkspaceEraseCancellation, type WorkspaceErasePlan, type WorkspaceEraseReceipt, type WorkspaceEraseStatus } from '../cloud/workspaceEraseContracts';

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
  readKnowledgeSourceChoices(expectedRevision: number): Promise<KnowledgeSourceChoicesDTO>;
  readKnowledgeSuggestionReview(input: Readonly<{ suggestionId: string; expectedSuggestionRevision: number; expectedRevision: number }>): Promise<KnowledgeSuggestionReviewDTO>;
  readMailReplySource(messageId: string, expectedRevision: number): Promise<MailReplySourceReadDto>;
  readMailReplyText(messageId: string, expectedRevision: number, source: NonNullable<MailReplySourceReadDto['source']>): Promise<MailReplyTextReadDto>;
  readProposalReview(proposalId: string, expectedRevision: number): Promise<ProposalReviewReadDto>;
  readDispatchReview(recordId: string, expectedRevision: number): Promise<DispatchReviewReadDto>;
  readReplyBatchReview(plan: ReplyBatchPlanRead, expectedRevision: number): Promise<MailReplyBatchReviewReadDto>;
  readPeriodSummaryResult(jobId: string, expectedRevision: number): Promise<PeriodSummaryResultReview>;
  readPeriodSummaryApplicationPreview(planId: string, jobId: string, expectedRevision: number): Promise<PeriodSummaryApplicationPreview>;
  listBackgroundPolicies(expectedPrivacyEpoch: number, afterPolicyId?: string): Promise<readonly BackgroundPolicyDisplay[]>;
  saveBackgroundPolicy(envelope: SaveBackgroundPolicyEnvelope): Promise<BackgroundPolicyReceipt>;
  pauseBackgroundPolicy(envelope: ChangeBackgroundPolicyEnvelope): Promise<BackgroundPolicyReceipt>;
  revokeBackgroundPolicy(envelope: ChangeBackgroundPolicyEnvelope): Promise<BackgroundPolicyReceipt>;
  inspectBackgroundPolicyReceipt(commandId: string, expectedPrivacyEpoch: number): Promise<BackgroundPolicyReceipt | undefined>;
  readWorkspaceEraseStatus(): Promise<WorkspaceEraseStatus>;
  prepareWorkspaceErase(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<WorkspaceErasePlan>;
  confirmWorkspaceErase(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<WorkspaceErasePlan>;
  executeWorkspaceErase(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<WorkspaceEraseReceipt>;
  cancelWorkspaceErase(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<WorkspaceEraseCancellation>;
  retryWorkspaceEraseCleanup(input: Readonly<{ commandId: string; expectedPrivacyEpoch: number }>): Promise<WorkspaceEraseReceipt>;
  execute(command: WorkspaceCommand, onAdmitted?: (envelope: WorkspaceCommandAdmission) => void): Promise<WorkspaceCommandResponse>;
  inspectCommand(commandId?: string): Promise<WorkspaceCommandResponse>;
  inspectRecoveredCommand(entry: WorkspaceCommandHistoryEntry): Promise<WorkspaceCommandResponse>;
  listCommandHistory(cursor?: string): Promise<WorkspaceCommandHistoryPage>;
  cancelTranscription(commandId: string): Promise<'cancellation_requested' | 'not_running'>;
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

export function createWorkspaceCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') throw new WorkspaceClientError('network', 'A secure command identifier is unavailable.');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const makeCommandId = createWorkspaceCommandId;

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
  const cancellationControllers = new Set<AbortController>();

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

  async function readKnowledgeSourceChoices(expectedRevision: number): Promise<KnowledgeSourceChoicesDTO> {
    assertUsable();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !snapshot || snapshot.revision !== expectedRevision) {
      throw new WorkspaceClientError('stale', 'The workspace changed. Reload it before loading source choices.');
    }
    const ticket = beginOperation();
    const raw = await request(`/api/workspace/knowledge/source-choices?expectedRevision=${expectedRevision}&expectedPrivacyEpoch=${privacyEpoch}`, { method: 'GET' }, ticket);
    assertOperation(ticket);
    try { return parseKnowledgeSourceChoicesDTO(raw, { workspaceId, privacyEpoch, revision: expectedRevision }); }
    catch (error) {
      if (error instanceof Error && error.message === 'knowledge_http_response_stale') throw new WorkspaceClientError('stale', 'The workspace changed. Reload it before loading source choices.');
      throw new WorkspaceClientError('malformed', 'The source choices could not be confirmed.');
    }
  }

  async function readKnowledgeSuggestionReview(input: Readonly<{ suggestionId: string; expectedSuggestionRevision: number; expectedRevision: number }>): Promise<KnowledgeSuggestionReviewDTO> {
    assertUsable();
    if (!input || !isCanonicalKnowledgeId(input.suggestionId) || !Number.isSafeInteger(input.expectedSuggestionRevision) || input.expectedSuggestionRevision < 1 ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !snapshot || snapshot.revision !== input.expectedRevision) {
      throw new WorkspaceClientError('stale', 'The workspace changed. Reload it before preparing this suggestion.');
    }
    const ticket = beginOperation();
    const query = `suggestionId=${input.suggestionId}&expectedSuggestionRevision=${input.expectedSuggestionRevision}&expectedRevision=${input.expectedRevision}&expectedPrivacyEpoch=${privacyEpoch}`;
    const raw = await request(`/api/workspace/knowledge/suggestion-review?${query}`, { method: 'GET' }, ticket);
    assertOperation(ticket);
    try { return parseKnowledgeSuggestionReviewDTO(raw, { workspaceId, privacyEpoch, revision: input.expectedRevision, suggestionId: input.suggestionId, suggestionRevision: input.expectedSuggestionRevision }); }
    catch (error) {
      if (error instanceof Error && error.message === 'knowledge_http_response_stale') throw new WorkspaceClientError('stale', 'The suggestion changed. Reload the latest revision before preparing it.');
      throw new WorkspaceClientError('malformed', 'The suggestion review could not be confirmed.');
    }
  }

  function assertSavedReadRevision(expectedRevision: number): void {
    assertUsable();
    if (!isGeneration(expectedRevision) || !snapshot || snapshot.workspaceId !== workspaceId || snapshot.privacyEpoch !== privacyEpoch || snapshot.revision !== expectedRevision) {
      throw new WorkspaceClientError('stale', 'The workspace changed. Refresh it before opening saved mail or proposal details.');
    }
  }

  async function readSavedWorkflow<T>(path: string, expectedRevision: number, parse: (raw: unknown) => T, label: string): Promise<T> {
    assertSavedReadRevision(expectedRevision);
    const ticket = beginOperation();
    const raw = await request(path, { method: 'GET' }, ticket);
    assertOperation(ticket);
    try { return parse(raw); }
    catch (error) {
      if (error instanceof Error && error.message === 'mail_workflow_response_stale') {
        throw new WorkspaceClientError('stale', 'The workspace changed while those saved details were loading. Refresh before continuing.');
      }
      throw new WorkspaceClientError('malformed', `${label} could not be confirmed.`);
    }
  }

  function readMailReplySource(messageId: string, expectedRevision: number): Promise<MailReplySourceReadDto> {
    assertSavedReadRevision(expectedRevision);
    return readSavedWorkflow(cloudMailReadPath('source', messageId, { expectedRevision, expectedPrivacyEpoch: privacyEpoch }), expectedRevision,
      (raw) => parseCloudMailReplySource(raw, { workspaceId, privacyEpoch, revision: expectedRevision }, messageId), 'Saved reply details');
  }

  function readMailReplyText(messageId: string, expectedRevision: number, source: NonNullable<MailReplySourceReadDto['source']>): Promise<MailReplyTextReadDto> {
    assertSavedReadRevision(expectedRevision);
    return readSavedWorkflow(cloudMailReadPath('source-text', messageId, { expectedRevision, expectedPrivacyEpoch: privacyEpoch }), expectedRevision,
      (raw) => parseCloudMailReplyText(raw, { workspaceId, privacyEpoch, revision: expectedRevision }, messageId, source), 'Saved message text');
  }

  function readProposalReview(proposalId: string, expectedRevision: number): Promise<ProposalReviewReadDto> {
    assertSavedReadRevision(expectedRevision);
    return readSavedWorkflow(cloudProposalReviewPath(proposalId, { expectedRevision, expectedPrivacyEpoch: privacyEpoch }), expectedRevision,
      (raw) => parseCloudProposalReview(raw, { workspaceId, privacyEpoch, revision: expectedRevision }, proposalId), 'Proposal details');
  }

  function readDispatchReview(recordId: string, expectedRevision: number): Promise<DispatchReviewReadDto> {
    assertSavedReadRevision(expectedRevision);
    return readSavedWorkflow(cloudDispatchReviewPath(recordId, { expectedRevision, expectedPrivacyEpoch: privacyEpoch }), expectedRevision,
      (raw) => parseCloudDispatchReview(raw, { workspaceId, privacyEpoch, revision: expectedRevision }, recordId), 'Dispatch details');
  }

  function readReplyBatchReview(plan: ReplyBatchPlanRead, expectedRevision: number): Promise<MailReplyBatchReviewReadDto> {
    assertSavedReadRevision(expectedRevision);
    return readSavedWorkflow(cloudReplyBatchReviewPath(plan, { expectedRevision, expectedPrivacyEpoch: privacyEpoch }), expectedRevision,
      (raw) => parseCloudReplyBatchReview(raw, { workspaceId, privacyEpoch, revision: expectedRevision }, plan), 'Reply review');
  }

  function readPeriodSummaryResult(jobId: string, expectedRevision: number): Promise<PeriodSummaryResultReview> {
    assertSavedReadRevision(expectedRevision);
    return readSavedWorkflow(periodSummaryResultPath(jobId, { expectedRevision, expectedPrivacyEpoch: privacyEpoch }), expectedRevision,
      (raw) => parsePeriodSummaryReadEnvelope(raw, { workspaceId, privacyEpoch, revision: expectedRevision, jobId }).review,
      'Saved period summary');
  }

  function readPeriodSummaryApplicationPreview(planId: string, jobId: string, expectedRevision: number): Promise<PeriodSummaryApplicationPreview> {
    assertSavedReadRevision(expectedRevision);
    return readSavedWorkflow(periodSummaryApplicationPreviewPath(planId, jobId, { expectedRevision, expectedPrivacyEpoch: privacyEpoch }), expectedRevision,
      (raw) => parsePeriodSummaryApplicationPreviewEnvelope(raw, { workspaceId, privacyEpoch, revision: expectedRevision, planId, jobId }).review,
      'Period summary application preview');
  }

  async function listBackgroundPolicies(expectedPrivacyEpoch: number, afterPolicyId?: string): Promise<readonly BackgroundPolicyDisplay[]> {
    assertUsable();
    if (expectedPrivacyEpoch !== privacyEpoch || !isGeneration(expectedPrivacyEpoch) ||
        (afterPolicyId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(afterPolicyId))) {
      throw new WorkspaceClientError('stale', 'Refresh the workspace before listing background policies.');
    }
    const ticket = beginOperation();
    const query = new URLSearchParams({ expectedPrivacyEpoch: String(privacyEpoch), limit: String(BACKGROUND_PUBLIC_PAGE_MAX) });
    if (afterPolicyId) query.set('afterPolicyId', afterPolicyId);
    const raw = await request(`/api/workspace/background/policies?${query.toString()}`, { method: 'GET' }, ticket);
    assertOperation(ticket);
    try {
      if (!Array.isArray(raw) || raw.length > BACKGROUND_PUBLIC_PAGE_MAX) throw new Error('invalid_page');
      const page = raw.map((value) => parseBackgroundPolicyDisplay(value));
      if (new Set(page.map((policy) => policy.policyId)).size !== page.length) throw new Error('duplicate_policy');
      if (page.some((policy, index) => policy.policyId <= (index === 0 ? afterPolicyId ?? '' : page[index - 1]!.policyId))) throw new Error('unordered_policy_page');
      return Object.freeze(page);
    } catch { throw new WorkspaceClientError('malformed', 'The background policy list could not be confirmed.'); }
  }

  async function postBackgroundPolicy(path: '/api/workspace/background/policies' | '/api/workspace/background/policies/pause' |
    '/api/workspace/background/policies/revoke', envelope: SaveBackgroundPolicyEnvelope | ChangeBackgroundPolicyEnvelope): Promise<BackgroundPolicyReceipt> {
    assertUsable();
    let parsed: SaveBackgroundPolicyEnvelope | ChangeBackgroundPolicyEnvelope;
    try {
      parsed = path.endsWith('/pause') ? parsePauseBackgroundPolicyEnvelope(envelope)
        : path.endsWith('/revoke') ? parseRevokeBackgroundPolicyEnvelope(envelope)
          : parseSaveBackgroundPolicyEnvelope(envelope);
      if (parsed.expectedPrivacyEpoch !== privacyEpoch) throw new Error('stale_privacy_epoch');
    } catch {
      throw new WorkspaceCommandNotStartedError('The background policy request could not be validated for this workspace. Review it before trying again.');
    }
    const ticket = beginOperation();
    let dispatched = false;
    try {
      const raw = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': session.csrfToken },
        body: canonicalBackgroundJson(parsed) }, ticket, () => { dispatched = true; });
      assertOperation(ticket);
      try {
        const receipt = parseBackgroundPolicyReceipt(raw);
        if (receipt.commandId !== parsed.commandId) throw new Error('command_id_mismatch');
        return receipt;
      } catch { throw new WorkspaceCommandUnknownError(parsed.commandId, 'invalid_acknowledgement'); }
    } catch (error) {
      if (!dispatched) {
        if (error instanceof WorkspaceCommandNotStartedError) throw error;
        throw new WorkspaceCommandNotStartedError('The background policy request was not sent. Review the workspace and try again.');
      }
      if (error instanceof WorkspaceCommandUnknownError) throw error;
      const status = statusFromError(error);
      const reason = error instanceof WorkspaceClientError && error.kind === 'timeout' ? 'timeout'
        : error instanceof WorkspaceClientError && error.kind === 'network' ? 'network'
          : status !== undefined ? 'server_error' : 'invalid_acknowledgement';
      throw new WorkspaceCommandUnknownError(parsed.commandId, reason);
    }
  }

  function saveBackgroundPolicy(envelope: SaveBackgroundPolicyEnvelope): Promise<BackgroundPolicyReceipt> {
    return postBackgroundPolicy('/api/workspace/background/policies', envelope);
  }
  function pauseBackgroundPolicy(envelope: ChangeBackgroundPolicyEnvelope): Promise<BackgroundPolicyReceipt> {
    return postBackgroundPolicy('/api/workspace/background/policies/pause', envelope);
  }
  function revokeBackgroundPolicy(envelope: ChangeBackgroundPolicyEnvelope): Promise<BackgroundPolicyReceipt> {
    return postBackgroundPolicy('/api/workspace/background/policies/revoke', envelope);
  }

  async function inspectBackgroundPolicyReceipt(commandId: string, expectedPrivacyEpoch: number): Promise<BackgroundPolicyReceipt | undefined> {
    assertUsable();
    let parsedCommandId: string;
    try { parsedCommandId = parseWorkspaceCommandId(commandId); }
    catch { throw new WorkspaceClientError('malformed', 'The background policy command ID is invalid.'); }
    if (expectedPrivacyEpoch !== privacyEpoch || !isGeneration(expectedPrivacyEpoch)) {
      throw new WorkspaceClientError('stale', 'The workspace changed before the policy receipt could be inspected.');
    }
    const ticket = beginOperation();
    try {
      const raw = await request(`/api/workspace/background/policy-receipts/${parsedCommandId}?expectedPrivacyEpoch=${privacyEpoch}`, { method: 'GET' }, ticket);
      assertOperation(ticket);
      const receipt = parseBackgroundPolicyReceipt(raw);
      if (receipt.commandId !== parsedCommandId) throw new Error('command_id_mismatch');
      return receipt;
    } catch (error) {
      if (error instanceof WorkspaceClientError && error.status === 404) return undefined;
      if (error instanceof WorkspaceClientError) throw error;
      throw new WorkspaceClientError('malformed', 'The background policy receipt could not be confirmed.');
    }
  }

  async function readWorkspaceEraseStatus(): Promise<WorkspaceEraseStatus> {
    const ticket = beginOperation();
    const raw = await request('/api/workspace/erase/status', { method: 'GET' }, ticket);
    assertOperation(ticket);
    try { return parseWorkspaceEraseStatus(raw); }
    catch { throw new WorkspaceClientError('malformed', 'The workspace erasure status could not be confirmed.'); }
  }

  async function postWorkspaceErase<T>(path: string, input: Readonly<Record<string, unknown>>, parse: (value: unknown) => T): Promise<T> {
    const ticket = beginOperation();
    const raw = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': session.csrfToken },
      body: JSON.stringify(input) }, ticket);
    assertOperation(ticket);
    try { return parse(raw); }
    catch { throw new WorkspaceClientError('malformed', 'The workspace erasure response could not be confirmed.'); }
  }

  function captureEraseRequest(input: unknown): Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }> {
    const keys = ['commandId', 'expectedRevision', 'expectedPrivacyEpoch'] as const;
    let prototype: object | null;
    let ownKeys: PropertyKey[];
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid');
      prototype = Object.getPrototypeOf(input);
      ownKeys = Reflect.ownKeys(input);
      if (prototype !== Object.prototype && prototype !== null || ownKeys.length !== keys.length ||
          ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key as typeof keys[number]))) throw new Error('invalid');
      const values = new Map<string, unknown>();
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid');
        values.set(key, descriptor.value);
      }
      const commandId = values.get('commandId');
      const expectedRevision = values.get('expectedRevision');
      const expectedPrivacyEpoch = values.get('expectedPrivacyEpoch');
      if (typeof commandId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId) ||
          !isGeneration(expectedRevision) || expectedPrivacyEpoch !== privacyEpoch || !isGeneration(expectedPrivacyEpoch)) {
        throw new WorkspaceClientError('stale', 'Refresh the authenticated workspace before reviewing erasure.');
      }
      return Object.freeze({ commandId, expectedRevision, expectedPrivacyEpoch });
    } catch (error) {
      if (error instanceof WorkspaceClientError) throw error;
      throw new WorkspaceClientError('malformed', 'The workspace erasure request is invalid.');
    }
  }

  function captureEraseCleanupRequest(input: unknown): Readonly<{ commandId: string; expectedPrivacyEpoch: number }> {
    const keys = ['commandId', 'expectedPrivacyEpoch'] as const;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid');
      const prototype = Object.getPrototypeOf(input);
      const ownKeys = Reflect.ownKeys(input);
      if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length ||
          ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key as typeof keys[number]))) throw new Error('invalid');
      const commandDescriptor = Object.getOwnPropertyDescriptor(input, 'commandId');
      const epochDescriptor = Object.getOwnPropertyDescriptor(input, 'expectedPrivacyEpoch');
      if (!commandDescriptor?.enumerable || !Object.hasOwn(commandDescriptor, 'value') ||
          !epochDescriptor?.enumerable || !Object.hasOwn(epochDescriptor, 'value')) throw new Error('invalid');
      const commandId = commandDescriptor.value;
      const expectedPrivacyEpoch = epochDescriptor.value;
      if (typeof commandId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId) ||
          expectedPrivacyEpoch !== privacyEpoch || !isGeneration(expectedPrivacyEpoch)) {
      throw new WorkspaceClientError('stale', 'Refresh the authenticated workspace before reviewing erasure.');
      }
      return Object.freeze({ commandId, expectedPrivacyEpoch });
    } catch (error) {
      if (error instanceof WorkspaceClientError) throw error;
      throw new WorkspaceClientError('malformed', 'The workspace erasure request is invalid.');
    }
  }

  async function prepareWorkspaceErase(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<WorkspaceErasePlan> {
    const request = captureEraseRequest(input);
    const plan = await postWorkspaceErase('/api/workspace/erase/prepare', request, parseWorkspaceErasePlan);
    if (plan.commandId !== request.commandId || plan.expectedPrivacyEpoch !== request.expectedPrivacyEpoch || plan.status !== 'prepared') {
      throw new WorkspaceClientError('malformed', 'The erasure review could not be confirmed.');
    }
    return plan;
  }
  async function confirmWorkspaceErase(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<WorkspaceErasePlan> {
    const request = captureEraseRequest(input);
    const plan = await postWorkspaceErase('/api/workspace/erase/confirm', request, parseWorkspaceErasePlan);
    if (plan.commandId !== request.commandId || plan.expectedRevision !== request.expectedRevision ||
        plan.expectedPrivacyEpoch !== request.expectedPrivacyEpoch || plan.status !== 'confirmed') {
      throw new WorkspaceClientError('malformed', 'The erasure confirmation could not be confirmed.');
    }
    return plan;
  }
  async function executeWorkspaceErase(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<WorkspaceEraseReceipt> {
    const request = captureEraseRequest(input);
    const receipt = await postWorkspaceErase('/api/workspace/erase/execute', request, parseWorkspaceEraseReceipt);
    if (receipt.commandId !== request.commandId || receipt.erasedPrivacyEpoch !== request.expectedPrivacyEpoch ||
        receipt.currentPrivacyEpoch !== request.expectedPrivacyEpoch + 1) {
      throw new WorkspaceClientError('malformed', 'The erasure result could not be confirmed.');
    }
    return receipt;
  }
  async function cancelWorkspaceErase(input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<WorkspaceEraseCancellation> {
    const request = captureEraseRequest(input);
    const cancellation = await postWorkspaceErase('/api/workspace/erase/cancel', request, parseWorkspaceEraseCancellation);
    if (cancellation.commandId !== request.commandId || cancellation.privacyEpoch !== request.expectedPrivacyEpoch) {
      throw new WorkspaceClientError('malformed', 'The erasure cancellation could not be confirmed.');
    }
    return cancellation;
  }
  async function retryWorkspaceEraseCleanup(input: Readonly<{ commandId: string; expectedPrivacyEpoch: number }>): Promise<WorkspaceEraseReceipt> {
    const request = captureEraseCleanupRequest(input);
    const receipt = await postWorkspaceErase('/api/workspace/erase/retry-cleanup', request, parseWorkspaceEraseReceipt);
    if (request.expectedPrivacyEpoch === 0 || receipt.commandId !== request.commandId ||
        receipt.erasedPrivacyEpoch !== request.expectedPrivacyEpoch - 1 || receipt.currentPrivacyEpoch !== request.expectedPrivacyEpoch) {
      throw new WorkspaceClientError('malformed', 'The cleanup result could not be confirmed.');
    }
    return receipt;
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

  async function cancelTranscription(commandId: string): Promise<'cancellation_requested' | 'not_running'> {
    assertUsable();
    let parsedId: string;
    try { parsedId = parseWorkspaceCommandId(commandId); }
    catch { throw new WorkspaceClientError('malformed', 'The workspace command identifier is invalid.'); }
    const controller = new AbortController();
    cancellationControllers.add(controller);
    let timedOut = false;
    let rejectTimeout!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(new WorkspaceClientError('timeout', 'The cancellation request timed out.'));
    }, timeoutMs);
    try {
      const response = await Promise.race([fetcher(`/api/workspace/commands/${parsedId}/cancel-transcription`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Still-CSRF': session.csrfToken }, body: '{}',
      }), timeoutPromise]);
      assertUsable();
      if (!response.ok) throw new WorkspaceClientError('http', fixedHttpMessage(response.status), response.status);
      const raw = await Promise.race([response.json(), timeoutPromise]);
      assertUsable();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('invalid');
      const keys = Reflect.ownKeys(raw);
      if (keys.length !== 3 || keys.some((key) => typeof key !== 'string' || !['schemaVersion', 'commandId', 'status'].includes(key)) ||
          keys.some((key) => { const desc = Object.getOwnPropertyDescriptor(raw, key); return !desc?.enumerable || !Object.hasOwn(desc, 'value'); })) throw new Error('invalid');
      const result = raw as Record<string, unknown>;
      if (result.schemaVersion !== 1 || result.commandId !== parsedId ||
          (result.status !== 'cancellation_requested' && result.status !== 'not_running')) throw new Error('invalid');
      return result.status;
    } catch (error) {
      if (error instanceof WorkspaceClientError) throw error;
      if (timedOut) throw new WorkspaceClientError('timeout', 'The cancellation request timed out.');
      if (controller.signal.aborted) throw new WorkspaceClientError('disposed', 'The workspace request was cancelled.');
      if (error instanceof TypeError) throw new WorkspaceClientError('network', 'The workspace connection was interrupted.');
      throw new WorkspaceClientError('malformed', 'The cancellation acknowledgement could not be confirmed.');
    } finally {
      clearTimeout(timeout);
      cancellationControllers.delete(controller);
    }
  }

  return Object.freeze({
    getSnapshot: () => readSnapshot('/api/workspace/snapshot', 'GET'),
    refresh: () => readSnapshot('/api/workspace/refresh', 'POST'),
    readKnowledgeSourceChoices,
    readKnowledgeSuggestionReview,
    readMailReplySource,
    readMailReplyText,
    readProposalReview,
    readDispatchReview,
    readReplyBatchReview,
    readPeriodSummaryResult,
    readPeriodSummaryApplicationPreview,
    listBackgroundPolicies,
    saveBackgroundPolicy,
    pauseBackgroundPolicy,
    revokeBackgroundPolicy,
    inspectBackgroundPolicyReceipt,
    readWorkspaceEraseStatus,
    prepareWorkspaceErase,
    confirmWorkspaceErase,
    executeWorkspaceErase,
    cancelWorkspaceErase,
    retryWorkspaceEraseCleanup,
    execute,
    inspectCommand,
    inspectRecoveredCommand,
    listCommandHistory,
    cancelTranscription,
    getPendingCommand: () => pending ? Object.freeze({ commandId: pending.envelope.commandId, command: pending.envelope.command }) : undefined,
    dispose: () => {
      disposed = true;
      for (const controller of cancellationControllers) controller.abort();
      cancellationControllers.clear();
      operation += 1;
      pending = undefined;
      snapshot = undefined;
    },
  });
}

function expectedReceiptFor(envelope: WorkspaceCommandEnvelope) {
  const { command } = envelope;
  switch (command.kind) {
    case 'settings.update':
      return { commandId: envelope.commandId, kind: command.kind, objectId: 'workspace-settings' };
    case 'tasks.complete': case 'tasks.reopen':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.taskId };
    case 'chat.create': case 'notes.save':
      return { commandId: envelope.commandId, kind: command.kind };
    case 'chat.conversation.delete':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.conversationId, conversationId: command.conversationId };
    case 'notes.confirmImportedTimeZone':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.noteId, noteId: command.noteId,
        noteRevision: command.expectedNoteRevision + 1, timeZone: command.timeZone };
    case 'chat.transcript.prepare':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.noteId, noteId: command.noteId,
        noteRevision: command.expectedNoteRevision };
    case 'chat.transcript.cancel':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.planId, planId: command.planId };
    case 'chat.transcript.submit':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.conversationId,
        conversationId: command.conversationId, planId: command.planId };
    case 'notes.capture.adopt':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.captureId,
        captureId: command.captureId, captureRevision: command.captureRevision };
    case 'accounts.installOAuth':
      return { commandId: envelope.commandId, kind: command.kind, stageId: command.stageId };
    case 'accounts.syncCalendars': case 'accounts.refreshMail': case 'accounts.continueMailBackfill': case 'accounts.disconnect':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.accountId, accountId: command.accountId };
    case 'mail.source.loadText': return { commandId: envelope.commandId, kind: command.kind, objectId: command.messageId, accountId: command.accountId,
      connectionGeneration: command.expectedConnectionGeneration, sourceDigest: command.sourceDigest };
    case 'mail.reply.create': return { commandId: envelope.commandId, kind: command.kind };
    case 'mail.reply.derive': return { commandId: envelope.commandId, kind: command.kind, parentProposalId: command.parentProposalId, operation: command.operation };
    case 'mail.reply.promoteDraft': return { commandId: envelope.commandId, kind: command.kind,
      parentProposalId: command.parentProposalId, parentProposalRevision: command.expectedParentRevision,
      draftDispatchRecordId: command.draftDispatchRecordId,
      accountId: command.accountId, connectionGeneration: command.expectedConnectionGeneration, operation: 'send' as const };
    case 'proposals.edit': case 'proposals.approve': case 'proposals.execute': case 'proposals.dismiss':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.proposalId, proposalId: command.proposalId };
    case 'dispatch.reconcile': return { commandId: envelope.commandId, kind: command.kind, objectId: command.recordId, recordId: command.recordId };
    case 'mail.replyBatch.submit': return { commandId: envelope.commandId, kind: command.kind };
    case 'mail.replyBatch.check': case 'mail.replyBatch.review': return { commandId: envelope.commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'mail.replyBatch.activate': return { commandId: envelope.commandId, kind: command.kind, jobId: command.jobId };
    case 'documents.save': {
      const parent = canonicalKnowledgeDocumentParent(command.path);
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.path,
        ...(parent ? { entityKind: parent.entityKind, entityId: parent.entityId } : {}) };
    }
    case 'knowledge.person.save': return { commandId: envelope.commandId, kind: command.kind, entityKind: 'person' as const,
      ...(command.operation === 'update' ? { objectId: command.input.id } : {}) };
    case 'knowledge.project.save': return { commandId: envelope.commandId, kind: command.kind, entityKind: 'project' as const,
      ...(command.operation === 'update' ? { objectId: command.input.id } : {}) };
    case 'knowledge.entity.archive': return { commandId: envelope.commandId, kind: command.kind, objectId: command.id, entityKind: command.entityKind };
    case 'knowledge.fact.save': return { commandId: envelope.commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.fact.remove': return { commandId: envelope.commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind, itemId: command.itemId };
    case 'knowledge.contact.save': return { commandId: envelope.commandId, kind: command.kind, objectId: command.entityId, entityKind: 'person' as const,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.contact.remove': return { commandId: envelope.commandId, kind: command.kind, objectId: command.entityId, entityKind: 'person' as const, itemId: command.itemId };
    case 'knowledge.member.save': return { commandId: envelope.commandId, kind: command.kind, objectId: command.entityId, entityKind: 'project' as const,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.member.remove': return { commandId: envelope.commandId, kind: command.kind, objectId: command.entityId, entityKind: 'project' as const, itemId: command.itemId };
    case 'knowledge.sourceLink.save': return { commandId: envelope.commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.sourceLink.remove': return { commandId: envelope.commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind, itemId: command.itemId };
    case 'knowledge.suggestion.edit': return { commandId: envelope.commandId, kind: command.kind, objectId: command.suggestionId, suggestionId: command.suggestionId,
      suggestionRevision: command.expectedSuggestionRevision + 1, status: 'pending' as const };
    case 'knowledge.suggestion.review': return { commandId: envelope.commandId, kind: command.kind, objectId: command.suggestionId, suggestionId: command.suggestionId,
      suggestionRevision: command.expectedSuggestionRevision + 1, status: command.decision === 'accept' ? 'accepted' as const : 'dismissed' as const };
    case 'notes.updateTranscript':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.noteId };
    case 'notes.transcribe':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.noteId, sourceRevision: command.expectedNoteRevision };
    case 'assistant.batch.submitNote':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.noteId };
    case 'assistant.batch.check':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.jobId };
    case 'assistant.periodSummary.moreCompute.prepare': case 'assistant.periodSummary.moreCompute.submit':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'assistant.periodSummary.moreCompute.cancel':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.planId, planId: command.planId };
    case 'assistant.periodSummary.application.prepare':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'assistant.periodSummary.application.cancel':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.planId, planId: command.planId };
    case 'assistant.periodSummary.application.apply':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'chat.submit':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.conversationId };
    case 'chat.refine':
      return { commandId: envelope.commandId, kind: command.kind, objectId: command.conversationId, parentTurnId: command.parentTurnId };
    default: return assertNever(command);
  }
}

function assertNever(_value: never): never { throw new WorkspaceClientError('malformed', 'The workspace action is unsupported.'); }
