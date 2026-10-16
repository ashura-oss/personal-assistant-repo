import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { AppState } from '../core';
import { canonicalVerifiedProviderIdentity, projectBackgroundAuthorityAccounts } from '../core';
import { canonicalMailReplySource, type MailReplySourceSnapshot } from '../mailReply';
import { scopeGrantsCapability } from '../connectors/oauth';
import type { BackgroundPeriodKind, BackgroundSourceSelection } from '../../server/src/backgroundContracts.js';
import type { ReadonlyChatLedger } from '../chat/types';
import { validateChatLedger } from '../chat/ledger';
import type { OpenRouterPeriodSummarySource, OpenRouterPeriodSummarySourceKind } from '../services/openRouterPeriodSummary';
import { validateOpenRouterBatchLedger } from '../services/openRouterBatchJobs';
import { validSelectedMailTextSnapshot } from '../mailText';
import { nextLocalPeriod, resolveCompletePeriod } from '../../server/src/backgroundClock.js';
import type { DurableKernel, OwnedTransactionContext, WorkspaceSnapshot } from '../../server/src/kernel.js';
import type { CapturedDocumentDestination, DocumentLineage } from '../../server/src/documentLineage.js';

export type PeriodSummaryCaptureOutcome = 'ready' | 'deferred_coverage' | 'deferred_sources' | 'no_events';
export type PeriodSummaryCaptureReason = 'coverage_missing' | 'mail_body_missing' | 'selected_context_missing' |
  'selected_context_ineligible' | 'private_ledger_invalid' | 'unsupported_source_locator' | 'mail_body_incomplete' |
  'missing_transcript' | 'generated_summary_excluded';

export interface PeriodSummaryCaptureRequest {
  readonly expectedPrivacyEpoch: number;
  readonly period: BackgroundPeriodKind;
  readonly timeZone: string;
  readonly localPeriodStart: string;
  readonly localDeliveryTime: string;
  readonly preparedAt: string;
  readonly emailTextMode?: 'complete_body' | 'available_extracted_email_text';
  readonly selection: BackgroundSourceSelection;
}

export interface PeriodSummaryCaptureInterval {
  readonly localStart: string;
  readonly localEnd: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly empty: boolean;
}

export interface PeriodSummaryCaptureOmission {
  readonly sourceId: string;
  readonly reason: PeriodSummaryCaptureReason;
  readonly mailBodyProvenance?: Readonly<{ representation: string; completeness: string; extractionVersion: string;
    omissionReasons: readonly string[] }>;
}

export interface PeriodSummarySourceCapture {
  readonly outcome: PeriodSummaryCaptureOutcome;
  readonly interval: PeriodSummaryCaptureInterval;
  readonly destination: CapturedDocumentDestination;
  readonly sources: readonly OpenRouterPeriodSummarySource[];
  readonly omissions: readonly PeriodSummaryCaptureOmission[];
}

type Scope = Readonly<{ workspaceId: string; ownerId: string; privacyEpoch: number }>;
type SourceProof = Readonly<{ kind: OpenRouterPeriodSummarySourceKind; locator: string; version: string; contentSha256: string;
  document?: CapturedDocumentDestination; accountId?: string; accountIdentity?: string; generation?: number;
  providerId?: string; containerId?: string; entityId?: string; itemId?: string; sourceRevision?: number; linkedNoteId?: string; linkedNoteRevision?: number;
  linkedTranscriptSha256?: string; childRefs?: readonly string[]; mailBodyProvenance?: Readonly<{ representation: string; completeness: string;
    extractionVersion: string; omissionReasons: readonly string[] }> }>;
type CaptureProof = Readonly<{ scope: Scope; request: PeriodSummaryCaptureRequest; interval: PeriodSummaryCaptureInterval;
  sources: readonly SourceProof[]; destination: CapturedDocumentDestination }>;
type RawSnapshot = AppState & { assistantChatLedger?: unknown; openRouterBatchLedger?: unknown };

const proofs = new WeakMap<object, CaptureProof>();
const HEX = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SUMMARY_ROOT = 'memory/summaries/';

function fail(code: string): never { throw new Error(code); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function closedRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (nodeTypes.isProxy(value)) return fail('period_summary_capture_invalid');
  if (!record(value)) return fail('period_summary_capture_invalid');
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    return fail('period_summary_capture_invalid');
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail('period_summary_capture_invalid');
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) copy[key] = Object.getOwnPropertyDescriptor(value, key)!.value;
  return copy;
}
function safeArray(value: unknown): unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string' ||
      key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) return fail('period_summary_capture_invalid');
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail('period_summary_capture_invalid');
    result.push(descriptor.value);
  }
  return result;
}
function cloneSelection(raw: unknown): BackgroundSourceSelection {
  const value = closedRecord(raw, ['notes', 'chat', 'tasks', 'decisions', 'acceptedInferences', 'mailAccounts', 'calendarAccounts', 'documentPaths', 'knowledge']);
  for (const key of ['notes', 'chat', 'tasks', 'decisions', 'acceptedInferences']) if (typeof value[key] !== 'boolean') fail('period_summary_capture_invalid');
  const accountList = (rawAccounts: unknown): readonly Readonly<{ accountId: string; expectedConnectionGeneration: number }>[] => {
    const accounts = safeArray(rawAccounts);
    const seen = new Set<string>();
    const result = accounts.map((rawAccount) => {
      const account = closedRecord(rawAccount, ['accountId', 'expectedConnectionGeneration']);
      if (typeof account.accountId !== 'string' || !account.accountId || !Number.isSafeInteger(account.expectedConnectionGeneration) ||
          (account.expectedConnectionGeneration as number) < 1 || seen.has(account.accountId)) fail('period_summary_capture_invalid');
      seen.add(account.accountId);
      return Object.freeze({ accountId: account.accountId, expectedConnectionGeneration: account.expectedConnectionGeneration as number });
    });
    return Object.freeze(result);
  };
  const documentPaths = safeArray(value.documentPaths);
  if (documentPaths.some((path) => typeof path !== 'string') || new Set(documentPaths).size !== documentPaths.length) fail('period_summary_capture_invalid');
  const knowledge = safeArray(value.knowledge).map((rawItem) => {
    const item = closedRecord(rawItem, ['kind', 'id']);
    if ((item.kind !== 'person' && item.kind !== 'project') || typeof item.id !== 'string') fail('period_summary_capture_invalid');
    return Object.freeze({ kind: item.kind, id: item.id }) as Readonly<{ kind: 'person' | 'project'; id: string }>;
  });
  if (new Set(knowledge.map((item) => `${item.kind}:${item.id}`)).size !== knowledge.length) fail('period_summary_capture_invalid');
  return Object.freeze({ notes: value.notes as boolean, chat: value.chat as boolean, tasks: value.tasks as boolean,
    decisions: value.decisions as boolean, acceptedInferences: value.acceptedInferences as boolean,
    mailAccounts: accountList(value.mailAccounts), calendarAccounts: accountList(value.calendarAccounts),
    documentPaths: Object.freeze(documentPaths as string[]), knowledge: Object.freeze(knowledge) });
}
function canonicalTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function wellFormedText(value: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}
function intervalContains(start: string, end: string, effectiveAt: string): boolean {
  const time = Date.parse(effectiveAt);
  return Number.isFinite(time) && time >= Date.parse(start) && time < Date.parse(end);
}
function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : fail('period_summary_source_invalid');
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!record(value)) return fail('period_summary_source_invalid');
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function source(input: { id: string; role: OpenRouterPeriodSummarySource['role']; kind: OpenRouterPeriodSummarySourceKind;
  version?: string; revision?: number; documentPath?: string; content: string; effectiveAt: string; observedAt: string }): OpenRouterPeriodSummarySource {
  if (!input.id || !input.content || !wellFormedText(input.content) || !canonicalTime(input.effectiveAt) || !canonicalTime(input.observedAt)) fail('period_summary_source_invalid');
  return Object.freeze({ id: input.id, role: input.role, kind: input.kind, ...(input.version ? { version: input.version } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}), ...(input.documentPath ? { documentPath: input.documentPath } : {}),
    content: input.content, contentSha256: sha(input.content), effectiveAt: input.effectiveAt, observedAt: input.observedAt });
}
function stateFrom(snapshot: WorkspaceSnapshot): RawSnapshot {
  if (!record(snapshot.snapshot)) return fail('period_summary_snapshot_invalid');
  return snapshot.snapshot as unknown as RawSnapshot;
}
function accountIdentity(account: AppState['accounts'][number]): string {
  try {
    canonicalVerifiedProviderIdentity(account);
    const identity = account.identity!;
    return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
  } catch { return ''; }
}
function selectedAccountAuthority(state: RawSnapshot, accountId: string, generation: number,
  capability: 'mail.read' | 'calendar.read'): { account: AppState['accounts'][number]; identity: string } | null {
  let projected: ReturnType<typeof projectBackgroundAuthorityAccounts>;
  try { projected = projectBackgroundAuthorityAccounts(state); } catch { return null; }
  const authority = projected.find((item) => item.id === accountId);
  if (!authority || !authority.connected || authority.authStatus !== 'connected' || !authority.tokenRef ||
      (authority.provider !== 'google' && authority.provider !== 'microsoft') || authority.connectionGeneration !== generation ||
      !authority.capabilities?.includes(capability) || !authority.grantedScopes ||
      !scopeGrantsCapability(authority.provider, [...authority.grantedScopes], capability) ||
      (authority.capabilityLimits !== undefined && !authority.capabilityLimits.includes(capability))) return null;
  try { canonicalVerifiedProviderIdentity(authority); } catch { return null; }
  const account = state.accounts.find((item) => item.id === accountId);
  return account ? { account, identity: [authority.identity!.providerNamespace, authority.identity!.clientId,
    authority.identity!.subject, authority.identity!.resourceUserId ?? ''].join(':') } : null;
}
function mailboxSourceDigest(row: AppState['mailbox'][number], account: AppState['accounts'][number]): string | null {
  if (!account.identity || !canonicalTime(row.observedAt) || row.providerDeletedAt !== undefined || row.replyMetadataComplete !== true ||
      !row.internetMessageId || !row.idFormat || row.verifiedIdentityKey !== accountIdentity(account) ||
      row.identityKey !== `${accountIdentity(account)}:${row.providerMessageId}` || row.connectionGeneration !== account.connectionGeneration) return null;
  const candidate: MailReplySourceSnapshot = { version: 1, accountId: account.id, accountEmail: account.email,
    ...(account.verifiedEmail ? { verifiedSelfEmail: account.verifiedEmail } : {}), identity: account.identity,
    connectionGeneration: row.connectionGeneration!, localMessageId: row.id, providerMessageId: row.providerMessageId, idFormat: row.idFormat,
    ...(row.providerVersion ? { providerVersion: row.providerVersion } : {}), ...(row.threadId ? { threadId: row.threadId } : {}),
    internetMessageId: row.internetMessageId, ...(row.references ? { references: row.references } : {}), ...(row.inReplyTo ? { inReplyTo: row.inReplyTo } : {}),
    subject: row.subject ?? '', ...(row.from ? { from: row.from } : {}), ...(row.senderEmail ? { senderEmail: row.senderEmail } : {}),
    ...(row.replyTo ? { replyTo: [...row.replyTo] } : {}), ...(row.to ? { to: [...row.to] } : {}), ...(row.cc ? { cc: [...row.cc] } : {}),
    ...(row.snippet !== undefined ? { snippet: row.snippet } : {}), replyMetadataComplete: true, observedAt: row.observedAt,
    sourceDigest: '0'.repeat(64) };
  try { return sha(canonicalMailReplySource(candidate)); } catch { return null; }
}
function pathIsGenerated(path: string): boolean { return path.startsWith(SUMMARY_ROOT); }
function validSourceDocument(path: string): boolean {
  return path.length <= 1024 && path.endsWith('.md') && !path.startsWith('/') && !path.includes('\\') && !/[:?#%<>|"*]/.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}
function inPeriodTime(value: unknown, interval: PeriodSummaryCaptureInterval): value is string {
  return canonicalTime(value) && intervalContains(interval.startUtc, interval.endUtc, value);
}
function docSource(state: RawSnapshot, lineage: DocumentLineage, context: OwnedTransactionContext, path: string,
  interval: PeriodSummaryCaptureInterval, observedAt: string): { source: OpenRouterPeriodSummarySource; proof: SourceProof } | null {
  if (!validSourceDocument(path) || pathIsGenerated(path)) fail('period_summary_source_path_invalid');
  const doc = state.documents.find((item) => item.path === path);
  if (!doc) return null;
  const destination = lineage.captureDestination(context, path);
  if (!destination.documentId || destination.expectedRevision !== doc.revision || typeof doc.content !== 'string' || !canonicalTime(doc.updatedAt)) return null;
  const item = source({ id: `document:${path}`, role: 'context', kind: 'document',
    revision: doc.revision, documentPath: path, content: doc.content, effectiveAt: doc.updatedAt, observedAt });
  return { source: item, proof: Object.freeze({ kind: 'document', locator: path, version: destination.documentId, contentSha256: item.contentSha256,
    document: destination }) };
}
function addContextDocument(state: RawSnapshot, lineage: DocumentLineage, context: OwnedTransactionContext, path: string,
  interval: PeriodSummaryCaptureInterval, observedAt: string, omissions: PeriodSummaryCaptureOmission[]): { source?: OpenRouterPeriodSummarySource; proof?: SourceProof } {
  if (pathIsGenerated(path)) {
    omissions.push(Object.freeze({ sourceId: `document:${path}`, reason: 'generated_summary_excluded' }));
    return {};
  }
  const result = docSource(state, lineage, context, path, interval, observedAt);
  if (!result) { omissions.push(Object.freeze({ sourceId: `document:${path}`, reason: 'selected_context_missing' })); return {}; }
  return result;
}
function sourceProofFor(item: OpenRouterPeriodSummarySource, locator: string, version: string): SourceProof {
  return Object.freeze({ kind: item.kind, locator, version, contentSha256: item.contentSha256 });
}

function buildSources(state: RawSnapshot, lineage: DocumentLineage, context: OwnedTransactionContext, request: PeriodSummaryCaptureRequest,
  interval: PeriodSummaryCaptureInterval): { sources: OpenRouterPeriodSummarySource[]; proofs: SourceProof[]; omissions: PeriodSummaryCaptureOmission[]; coverageDeferred: boolean; sourceDeferred: boolean } {
  const sources: OpenRouterPeriodSummarySource[] = [];
  const proofs: SourceProof[] = [];
  const omissions: PeriodSummaryCaptureOmission[] = [];
  let coverageDeferred = false;
  let sourceDeferred = false;
  const add = (item: OpenRouterPeriodSummarySource, proof: SourceProof) => { sources.push(item); proofs.push(proof); };
  const notes = Array.isArray(state.notes) ? state.notes : fail('period_summary_snapshot_invalid');
  if (request.selection.notes) for (const note of notes) {
    if (!canonicalTime(note.capturedAt ?? note.createdAt) || !inPeriodTime(note.capturedAt ?? note.createdAt, interval)) continue;
    if (note.origin === 'assistant_chat' || note.importOrigin?.originUnverified) {
      omissions.push(Object.freeze({ sourceId: `note:${note.id}`, reason: 'selected_context_ineligible' })); continue;
    }
    if (typeof note.transcript !== 'string' || !note.transcript.trim()) {
      omissions.push(Object.freeze({ sourceId: `note:${note.id}`, reason: 'missing_transcript' })); sourceDeferred = true; continue;
    }
    const observedAt = note.capturedAt ?? note.createdAt;
    const item = source({ id: `note:${note.id}`, role: 'event', kind: 'note', revision: note.revision,
      content: note.transcript, effectiveAt: observedAt, observedAt: request.preparedAt });
    add(item, sourceProofFor(item, note.id, `r${note.revision}`));
  }

  if (request.selection.chat) {
    let ledger: ReadonlyChatLedger;
    let batchLedger: ReturnType<typeof validateOpenRouterBatchLedger> | null;
    try { ledger = validateChatLedger(state.assistantChatLedger ?? { version: 1, conversations: [] }); }
    catch { omissions.push(Object.freeze({ sourceId: 'chat:*', reason: 'private_ledger_invalid' })); sourceDeferred = true; ledger = { version: 1, conversations: [] }; }
    try { batchLedger = validateOpenRouterBatchLedger(state.openRouterBatchLedger ?? { version: 1, jobs: [] }); }
    catch { omissions.push(Object.freeze({ sourceId: 'chat_jobs:*', reason: 'private_ledger_invalid' })); sourceDeferred = true; batchLedger = null; }
    for (const conversation of ledger.conversations) for (const turn of conversation.turns) {
      if (turn.operation === 'chat_refinement' || !inPeriodTime(turn.createdAt, interval)) continue;
      const note = notes.find((item) => item.id === turn.noteId && item.origin === 'assistant_chat' && item.revision === turn.noteRevision);
      const job = batchLedger?.jobs.find((candidate) => candidate.id === turn.jobId);
      if (!note || note.transcript !== turn.userText || !job || job.kind !== 'note_assistance' || job.status !== 'completed' || job.sourceRemoved || job.noteId !== turn.noteId ||
          job.noteRevision !== turn.noteRevision || !job.chatBinding || job.chatBinding.conversationId !== conversation.id || job.chatBinding.turnId !== turn.id) continue;
      if (!turn.userText.trim()) { omissions.push(Object.freeze({ sourceId: `chat:${turn.id}`, reason: 'missing_transcript' })); sourceDeferred = true; continue; }
      if (turn.reply && (!turn.replySha256 || sha(canonical(turn.reply)) !== turn.replySha256 || job.requestSha256 !== turn.reply.requestSha256 ||
          job.requestProfileVersion !== turn.reply.requestProfileVersion || (job.outputPolicyVersion ?? 1) !== (turn.reply.outputPolicyVersion ?? 1) ||
          job.operation !== turn.operation)) {
        sourceDeferred = true; omissions.push(Object.freeze({ sourceId: `chat:${turn.id}`, reason: 'private_ledger_invalid' })); continue;
      }
      let linkedNoteId: string | undefined;
      let linkedNoteRevision: number | undefined;
      let linkedTranscriptSha256: string | undefined;
      if (turn.messageOrigin === 'saved_transcript') {
        const transcriptSource = job.chatBinding.transcriptSource;
        const sourceNote = transcriptSource && notes.find((item) => item.id === transcriptSource.noteId);
        if (!transcriptSource || !sourceNote || sourceNote.importOrigin?.originUnverified || sourceNote.revision !== transcriptSource.noteRevision ||
            sha(sourceNote.transcript) !== transcriptSource.transcriptSha256 || sourceNote.capturedAt !== transcriptSource.capturedAt ||
            sourceNote.captureTimeZone !== transcriptSource.captureTimeZone) continue;
        linkedNoteId = sourceNote.id; linkedNoteRevision = sourceNote.revision; linkedTranscriptSha256 = transcriptSource.transcriptSha256;
      } else if (job.chatBinding.transcriptSource) continue;
      const reply = turn.reply && canonicalTime(turn.reply.completedAt) && Date.parse(turn.reply.completedAt) <= Date.parse(request.preparedAt)
        ? `\n\nAssistant: ${turn.reply.summary}\n${turn.reply.answer}` : '';
      const content = `User: ${turn.userText}${reply}`;
      const observedAt = request.preparedAt;
      const item = source({ id: `chat:${turn.id}`, role: 'event', kind: 'chat', version: turn.id, content, effectiveAt: turn.createdAt, observedAt });
      add(item, Object.freeze({ ...sourceProofFor(item, turn.id, turn.id), containerId: conversation.id, ...(linkedNoteId ? { linkedNoteId,
        linkedNoteRevision, linkedTranscriptSha256 } : {}) }));
    }
  }

  if (request.selection.tasks) for (const task of state.tasks) {
    if (task.importOrigin?.originUnverified) continue;
    if (inPeriodTime(task.createdAt, interval)) {
      const item = source({ id: `task:${task.id}:created`, role: 'event', kind: 'task', version: sha(canonical({ id: task.id, title: task.title, body: task.body, createdAt: task.createdAt })),
        content: `Task created: ${task.title}\n${task.body}`, effectiveAt: task.createdAt, observedAt: request.preparedAt });
      add(item, sourceProofFor(item, `${task.id}:created`, item.version!));
    }
    if (task.status === 'completed' && task.completedAt && inPeriodTime(task.completedAt, interval)) {
      const item = source({ id: `task:${task.id}:completed`, role: 'event', kind: 'task', version: sha(canonical({ id: task.id, title: task.title, body: task.body, completedAt: task.completedAt })),
        content: `Task completed: ${task.title}\n${task.body}`, effectiveAt: task.completedAt, observedAt: request.preparedAt });
      add(item, sourceProofFor(item, `${task.id}:completed`, item.version!));
    }
  }

  if (request.selection.decisions) for (const note of notes) {
    const analysis = note.analysis;
    const effectiveAt = note.capturedAt ?? note.createdAt;
    if (!analysis || note.importOrigin?.originUnverified || analysis.source !== 'provider' || analysis.stale || analysis.sourceRevision !== note.revision || analysis.fingerprint !== note.processingFingerprint ||
        !canonicalTime(effectiveAt) || !inPeriodTime(effectiveAt, interval) || !canonicalTime(analysis.analyzedAt)) continue;
    analysis.decisions.forEach((decision, index) => {
      const item = source({ id: `decision:${note.id}:${note.revision}:${index}`, role: 'event', kind: 'decision',
        version: sha(analysis.fingerprint), content: `Assistant-extracted decision; unconfirmed. ${decision.text}`, effectiveAt, observedAt: analysis.analyzedAt });
      add(item, Object.freeze({ ...sourceProofFor(item, note.id, analysis.fingerprint), sourceRevision: note.revision, itemId: String(index) }));
    });
  }

  if (request.selection.acceptedInferences) {
    const suggestionById = new Map(state.knowledge.suggestions.map((item) => [item.id, item]));
    const collect = (kind: 'person' | 'project', entityId: string, entries: readonly { id: string; provenance: string; suggestionId?: string;
      evidence?: unknown[]; createdAt: string; statement?: string; address?: string; label?: string; reference?: unknown; personId?: string; role?: string }[]) => {
      for (const entry of entries) {
        if (entry.provenance !== 'accepted_inference' || !entry.suggestionId) continue;
        const suggestion = suggestionById.get(entry.suggestionId);
        if (!suggestion || suggestion.status !== 'accepted' || !suggestion.reviewedAt || !inPeriodTime(suggestion.reviewedAt, interval) ||
            suggestion.change.entityKind !== kind || suggestion.change.entityId !== entityId || !Array.isArray(entry.evidence) ||
            canonical(entry.evidence) !== canonical(suggestion.evidence)) continue;
        const payloadMatches = suggestion.change.type === 'add_fact' ? entry.statement === suggestion.change.statement :
          suggestion.change.type === 'add_contact' ? entry.address === suggestion.change.address && entry.label === suggestion.change.label :
          suggestion.change.type === 'add_source_link' ? canonical(entry.reference) === canonical(suggestion.change.reference) && entry.label === suggestion.change.label :
          suggestion.change.type === 'add_member' ? entry.personId === suggestion.change.personId && entry.role === suggestion.change.role : false;
        if (!payloadMatches) continue;
        const payload = canonical(Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'createdAt')));
        const item = source({ id: `accepted_inference:${kind}:${entityId}:${entry.id}`, role: 'event', kind: 'accepted_inference',
          version: `${suggestion.id}:${suggestion.revision}`, content: payload, effectiveAt: suggestion.reviewedAt, observedAt: suggestion.reviewedAt });
        add(item, Object.freeze({ ...sourceProofFor(item, kind, `${suggestion.id}:${suggestion.revision}`),
          entityId, itemId: entry.id }));
      }
    };
    for (const person of state.knowledge.people) collect('person', person.id, [...person.facts, ...person.contacts, ...person.sourceLinks]);
    for (const project of state.knowledge.projects) collect('project', project.id, [...project.facts, ...project.sourceLinks, ...project.members]);
  }

  const resolveSelectedAccount = (selected: BackgroundSourceSelection['mailAccounts'][number], capability: 'mail.read' | 'calendar.read') => {
    return selectedAccountAuthority(state, selected.accountId, selected.expectedConnectionGeneration, capability);
  };

  if (request.selection.mailAccounts.length) for (const selected of request.selection.mailAccounts) {
    const resolved = resolveSelectedAccount(selected, 'mail.read');
    const sync = state.syncStates[selected.accountId];
      if (!resolved || !sync || sync.messagesPartial || !covers(sync.mailHead.completeWindow, interval) && !covers(sync.mailBackfill.coverage, interval)) {
      coverageDeferred = true; omissions.push(Object.freeze({ sourceId: `mail-account:${selected.accountId}`, reason: 'coverage_missing' })); continue;
    }
    const rows = state.mailbox.filter((row) => row.accountId === selected.accountId && !row.providerDeletedAt &&
      row.identityKey === `${resolved.identity}:${row.providerMessageId}` && row.verifiedIdentityKey === resolved.identity &&
      row.connectionGeneration === selected.expectedConnectionGeneration &&
      row.receivedAt && inPeriodTime(row.receivedAt, interval));
    for (const row of rows) {
      const body = state.selectedMailTexts.find((item) => item.messageId === row.id);
      const sourceDigest = mailboxSourceDigest(row, resolved.account);
      if (!sourceDigest || !body || !validSelectedMailTextSnapshot(body) ||
          body.accountId !== selected.accountId || body.identityKey !== resolved.identity || body.connectionGeneration !== selected.expectedConnectionGeneration ||
          canonical(body.identity) !== canonical(resolved.account.identity) ||
          body.providerMessageId !== row.providerMessageId || !HEX.test(body.sourceDigest) || body.sourceDigest !== sourceDigest ||
          !body.text || !HEX.test(body.textDigest ?? '') || sha(body.text) !== body.textDigest) {
        sourceDeferred = true; omissions.push(Object.freeze({ sourceId: `mail:${row.id}`, reason: 'mail_body_missing' })); continue;
      }
      const extractedExcerptAllowed = request.emailTextMode === 'available_extracted_email_text' && body.completeness === 'excerpt';
      if (body.completeness !== 'complete_text' && !extractedExcerptAllowed) {
        sourceDeferred = true;
        omissions.push(Object.freeze({ sourceId: `mail:${row.id}`, reason: 'mail_body_incomplete', mailBodyProvenance: Object.freeze({
          representation: body.representation, completeness: body.completeness, extractionVersion: body.extractionVersion,
          omissionReasons: Object.freeze([...body.omissionReasons]) }) }));
        continue;
      }
      const receivedAt = row.receivedAt!;
      const excerptLabel = extractedExcerptAllowed
        ? `\n[Retained extracted email text is an excerpt; omissions: ${body.omissionReasons.join(', ') || 'unspecified'}]\n`
        : '';
      const content = `Subject: ${row.subject ?? ''}\nFrom: ${row.from ?? ''}\nReceived: ${receivedAt}${excerptLabel}\n${body.text}`;
      const mailBodyProvenance = Object.freeze({ representation: body.representation, completeness: body.completeness,
        extractionVersion: body.extractionVersion, omissionReasons: Object.freeze([...body.omissionReasons]) });
      const version = sha(canonical({ sourceDigest, textDigest: body.textDigest,
        representation: body.representation, completeness: body.completeness, extractionVersion: body.extractionVersion,
        omissionReasons: [...body.omissionReasons] }));
      const item = source({ id: `mail:${row.id}`, role: 'event', kind: 'mail', version,
        content, effectiveAt: receivedAt, observedAt: body.checkedAt });
      add(item, Object.freeze({ ...sourceProofFor(item, row.id, canonical({ sourceDigest, textDigest: body.textDigest,
        representation: body.representation, completeness: body.completeness, extractionVersion: body.extractionVersion,
        omissionReasons: [...body.omissionReasons] })), providerId: row.providerMessageId,
        accountId: selected.accountId, accountIdentity: resolved.identity, generation: selected.expectedConnectionGeneration, mailBodyProvenance }));
    }
  }

  if (request.selection.calendarAccounts.length) for (const selected of request.selection.calendarAccounts) {
    const resolved = resolveSelectedAccount(selected, 'calendar.read');
    const sync = state.syncStates[selected.accountId];
    const calendars = state.calendars.filter((item) => item.accountId === selected.accountId && item.connected);
    const covered = resolved && sync && !sync.calendarsPartial && canonicalTime(sync.calendarsCompletedAt) &&
      canonicalTime(sync.eventsTimeMin) && canonicalTime(sync.eventsTimeMax) && Date.parse(sync.eventsTimeMin) <= Date.parse(interval.startUtc) &&
      Date.parse(sync.eventsTimeMax) >= Date.parse(interval.endUtc) && calendars.length > 0 && calendars.every((item) => canonicalTime(sync.eventsCompletedAt[item.id]));
    if (!covered || !resolved) { coverageDeferred = true; omissions.push(Object.freeze({ sourceId: `calendar-account:${selected.accountId}`, reason: 'coverage_missing' })); continue; }
    for (const row of state.calendarEvents.filter((event) => event.accountId === selected.accountId && calendars.some((calendar) =>
      calendar.id === event.calendarId) && !event.providerDeletedAt &&
      event.verifiedIdentityKey === resolved.identity && event.connectionGeneration === selected.expectedConnectionGeneration)) {
      if (!row.startUtcCertified || !row.endUtcCertified || !canonicalTime(row.start) || !canonicalTime(row.end) ||
          !inPeriodTime(row.start, interval) || !canonicalTime(row.observedAt)) continue;
      const version = sha(canonical({ calendarId: row.calendarId, providerEventId: row.providerEventId, start: row.start, end: row.end, subject: row.subject ?? null }));
      const item = source({ id: `calendar:${row.id}`, role: 'event', kind: 'calendar',
        version, content: `Event: ${row.subject ?? '(untitled)'}\nStart: ${row.start}\nEnd: ${row.end}`,
        effectiveAt: row.start, observedAt: row.observedAt });
      add(item, Object.freeze({ ...sourceProofFor(item, row.id, canonical({ calendarId: row.calendarId, providerEventId: row.providerEventId,
        start: row.start, end: row.end, subject: row.subject ?? null })), providerId: row.providerEventId, containerId: row.calendarId,
        accountId: selected.accountId, accountIdentity: resolved.identity, generation: selected.expectedConnectionGeneration }));
    }
  }

  for (const path of request.selection.documentPaths) {
    const result = addContextDocument(state, lineage, context, path, interval, request.preparedAt, omissions);
    if (!result.source && !pathIsGenerated(path)) sourceDeferred = true;
    if (result.source && result.proof) add(result.source, result.proof);
  }
  for (const selected of request.selection.knowledge) {
    const entity = selected.kind === 'person' ? state.knowledge.people.find((item) => item.id === selected.id) : state.knowledge.projects.find((item) => item.id === selected.id);
    if (!entity || entity.archivedAt || entity.importOrigin) {
      omissions.push(Object.freeze({ sourceId: `${selected.kind}:${selected.id}`, reason: entity ? 'selected_context_ineligible' : 'selected_context_missing' })); sourceDeferred = true; continue;
    }
    const doc = addContextDocument(state, lineage, context, entity.narrativePath, interval, request.preparedAt, omissions);
    if (!doc.source && !pathIsGenerated(entity.narrativePath)) sourceDeferred = true;
    const content = canonical({ kind: selected.kind, name: entity.name, aliases: [...entity.aliases].sort(),
      facts: [...entity.facts].sort((a, b) => compareText(a.id, b.id)), sourceLinks: [...entity.sourceLinks].sort((a, b) => compareText(a.id, b.id)),
      ...(selected.kind === 'person' ? { contacts: [...(entity as AppState['knowledge']['people'][number]).contacts].sort((a, b) => compareText(a.id, b.id)) } :
        { status: (entity as AppState['knowledge']['projects'][number]).status, goal: (entity as AppState['knowledge']['projects'][number]).goal,
          members: [...(entity as AppState['knowledge']['projects'][number]).members].sort((a, b) => compareText(a.id, b.id)) }) });
    if (!canonicalTime(entity.updatedAt)) fail('period_summary_knowledge_invalid');
    const item = source({ id: `${selected.kind}:${selected.id}`, role: 'context', kind: selected.kind, revision: entity.revision,
      content: `${content}${doc.source ? `\n\n${doc.source.content}` : ''}`, effectiveAt: entity.createdAt, observedAt: request.preparedAt });
    const childRef = (type: string, child: { id: string; createdAt: string }) => `${type}\u0000${child.id}\u0000${child.createdAt}`;
    const childRefs = selected.kind === 'person'
      ? [...entity.facts.map((child) => childRef('fact', child)), ...entity.sourceLinks.map((child) => childRef('sourceLink', child)),
        ...(entity as AppState['knowledge']['people'][number]).contacts.map((child) => childRef('contact', child))]
      : [...entity.facts.map((child) => childRef('fact', child)), ...entity.sourceLinks.map((child) => childRef('sourceLink', child)),
        ...(entity as AppState['knowledge']['projects'][number]).members.map((child) => childRef('member', child))];
    add(item, Object.freeze({ ...sourceProofFor(item, selected.id, `r${entity.revision}`), entityId: selected.id, document: doc.proof?.document,
      childRefs: Object.freeze(childRefs.sort(compareText)) }));
  }
  sources.sort((a, b) => compareText(a.id, b.id));
  proofs.sort((a, b) => compareText(`${a.kind}:${a.locator}`, `${b.kind}:${b.locator}`));
  return { sources, proofs, omissions, coverageDeferred, sourceDeferred };
}

function covers(value: unknown, interval: PeriodSummaryCaptureInterval): boolean {
  if (!record(value) || !canonicalTime(value.from) || !canonicalTime(value.through)) return false;
  return Date.parse(value.from) <= Date.parse(interval.startUtc) && Date.parse(value.through) >= Date.parse(interval.endUtc);
}

function validateRequest(raw: unknown): PeriodSummaryCaptureRequest {
  const value = closedRecord(raw, ['expectedPrivacyEpoch', 'period', 'timeZone', 'localPeriodStart', 'localDeliveryTime', 'preparedAt', 'selection'], ['emailTextMode']);
  if (!Number.isSafeInteger(value.expectedPrivacyEpoch) || (value.expectedPrivacyEpoch as number) < 0 ||
      !['daily', 'weekly', 'monthly', 'yearly'].includes(String(value.period)) || typeof value.timeZone !== 'string' ||
      typeof value.localPeriodStart !== 'string' || typeof value.localDeliveryTime !== 'string' || !canonicalTime(value.preparedAt) ||
      (value.emailTextMode !== undefined && value.emailTextMode !== 'complete_body' && value.emailTextMode !== 'available_extracted_email_text')) fail('period_summary_capture_invalid');
  const selection = cloneSelection(value.selection);
  return Object.freeze({ expectedPrivacyEpoch: value.expectedPrivacyEpoch as number, period: value.period as BackgroundPeriodKind,
    timeZone: value.timeZone, localPeriodStart: value.localPeriodStart, localDeliveryTime: value.localDeliveryTime,
    preparedAt: value.preparedAt, ...(value.emailTextMode === undefined ? {} : { emailTextMode: value.emailTextMode as PeriodSummaryCaptureRequest['emailTextMode'] }), selection });
}

export function capturePeriodSummarySources(kernel: DurableKernel, sessionToken: string, lineage: DocumentLineage,
  rawRequest: unknown): PeriodSummarySourceCapture {
  const request = validateRequest(rawRequest);
  const identity = kernel.getOwnedIdentity(sessionToken);
  if (identity.privacyEpoch !== request.expectedPrivacyEpoch) fail('period_summary_capture_scope_changed');
  const complete = resolveCompletePeriod({ period: request.period, localPeriod: request.localPeriodStart, timeZone: request.timeZone,
    localDeliveryTime: request.localDeliveryTime });
  const interval: PeriodSummaryCaptureInterval = Object.freeze({ localStart: complete.localPeriod,
    localEnd: nextLocalPeriod(request.period, complete.localPeriod), startUtc: complete.startUtc, endUtc: complete.endUtc, empty: complete.empty });
  if (Date.parse(request.preparedAt) < Date.parse(interval.endUtc)) fail('period_summary_period_incomplete');
  return kernel.withOwnedTransaction(sessionToken, request.expectedPrivacyEpoch, (context) => {
    const owned = kernel.readOwnedSnapshotWithinTransaction(context);
    const state = stateFrom(owned);
    const destinationPath = `${SUMMARY_ROOT}${request.period}/${request.localPeriodStart}.md`;
    const destination = lineage.captureDestination(context, destinationPath);
    const built = interval.empty ? { sources: [], proofs: [], omissions: [], coverageDeferred: false, sourceDeferred: false } :
      buildSources(state, lineage, context, request, interval);
    const events = built.sources.some((item) => item.role === 'event');
    built.omissions.sort((a, b) => compareText(a.sourceId, b.sourceId) || compareText(a.reason, b.reason));
    const outcome: PeriodSummaryCaptureOutcome = built.coverageDeferred ? 'deferred_coverage' : built.sourceDeferred ? 'deferred_sources' : !events ? 'no_events' : 'ready';
    const capture: PeriodSummarySourceCapture = deepFreeze({ outcome, interval, destination, sources: built.sources, omissions: built.omissions });
    proofs.set(capture, Object.freeze({ scope: Object.freeze({ workspaceId: context.workspaceId, ownerId: context.ownerId,
      privacyEpoch: context.privacyEpoch }), request, interval, sources: Object.freeze(built.proofs), destination }));
    return capture;
  });
}

function sourceStillExists(state: RawSnapshot, proof: SourceProof, interval: PeriodSummaryCaptureInterval): boolean {
  switch (proof.kind) {
    case 'note': return state.notes.some((item) => item.id === proof.locator && item.origin !== 'assistant_chat' && !item.importOrigin?.originUnverified);
    case 'chat': {
      try {
        const turn = validateChatLedger(state.assistantChatLedger ?? { version: 1, conversations: [] }).conversations.flatMap((item) => item.turns)
          .find((item) => item.id === proof.locator && item.operation !== 'chat_refinement');
        if (!turn) return false;
        const note = state.notes.find((item) => item.id === turn.noteId && item.origin === 'assistant_chat' && item.revision === turn.noteRevision &&
          item.transcript === turn.userText);
        const ledger = validateOpenRouterBatchLedger(state.openRouterBatchLedger ?? { version: 1, jobs: [] });
        const job = ledger.jobs.find((item) => item.id === turn.jobId && item.kind === 'note_assistance' && item.status === 'completed' && !item.sourceRemoved &&
          item.noteId === turn.noteId && item.noteRevision === turn.noteRevision && item.chatBinding?.conversationId === proof.containerId &&
          item.chatBinding?.turnId === turn.id);
        const conversation = validateChatLedger(state.assistantChatLedger ?? { version: 1, conversations: [] }).conversations.find((item) => item.id === proof.containerId);
        const linkedTurn = conversation?.turns.find((item) => item.id === proof.locator && item.operation !== 'chat_refinement');
        const replyValid = !turn.reply || Boolean(turn.replySha256 && sha(canonical(turn.reply)) === turn.replySha256 &&
          job?.requestSha256 === turn.reply.requestSha256 && job.requestProfileVersion === turn.reply.requestProfileVersion &&
          (job.outputPolicyVersion ?? 1) === (turn.reply.outputPolicyVersion ?? 1) && job.operation === turn.operation);
        return Boolean(note && job && linkedTurn && linkedTurn.noteId === turn.noteId && linkedTurn.noteRevision === turn.noteRevision && replyValid &&
          (!proof.linkedNoteId || state.notes.some((item) => item.id === proof.linkedNoteId && !item.importOrigin?.originUnverified)));
      }
      catch { return false; }
    }
    case 'task': {
      const [id, phase] = proof.locator.split(':');
      return state.tasks.some((task) => task.id === id && !task.importOrigin?.originUnverified && (phase === 'created' || task.status === 'completed' && Boolean(task.completedAt)));
    }
    case 'decision': {
      const index = Number(proof.itemId);
      return state.notes.some((note) => note.id === proof.locator && note.revision === proof.sourceRevision && note.analysis && !note.analysis.stale && note.analysis.sourceRevision === note.revision &&
        note.analysis.source === 'provider' && !note.importOrigin?.originUnverified && note.analysis.fingerprint === note.processingFingerprint && Boolean(note.analysis.decisions[index]));
    }
    case 'accepted_inference': {
      const kind = proof.locator; const entityId = proof.entityId; const itemId = proof.itemId;
      if (!entityId || !itemId || (kind !== 'person' && kind !== 'project')) return false;
      const entity = kind === 'person' ? state.knowledge.people.find((item) => item.id === entityId) : state.knowledge.projects.find((item) => item.id === entityId);
      const entry = entity && [...entity.facts, ...entity.sourceLinks, ...(kind === 'person' ? (entity as AppState['knowledge']['people'][number]).contacts :
        (entity as AppState['knowledge']['projects'][number]).members)].find((item) => item.id === itemId);
      const suggestion = entry?.suggestionId && state.knowledge.suggestions.find((item) => item.id === entry.suggestionId);
      if (!entry || entry.provenance !== 'accepted_inference' || !suggestion || suggestion.status !== 'accepted' || !suggestion.reviewedAt ||
          !Array.isArray(entry.evidence) || canonical(entry.evidence) !== canonical(suggestion.evidence) ||
          suggestion.change.entityKind !== kind || suggestion.change.entityId !== entityId) return false;
      return suggestion.change.type === 'add_fact' ? 'statement' in entry && entry.statement === suggestion.change.statement :
        suggestion.change.type === 'add_contact' ? 'address' in entry && entry.address === suggestion.change.address && entry.label === suggestion.change.label :
        suggestion.change.type === 'add_source_link' ? 'reference' in entry && canonical(entry.reference) === canonical(suggestion.change.reference) && entry.label === suggestion.change.label :
        suggestion.change.type === 'add_member' ? 'personId' in entry && entry.personId === suggestion.change.personId && entry.role === suggestion.change.role : false;
    }
    case 'mail': {
      const authority = selectedAccountAuthority(state, proof.accountId!, proof.generation!, 'mail.read');
      const account = authority?.account;
      return Boolean(account && state.mailbox.some((row) => row.id === proof.locator && row.providerMessageId === proof.providerId && row.accountId === proof.accountId &&
        !row.providerDeletedAt && row.verifiedIdentityKey === proof.accountIdentity && row.identityKey === `${proof.accountIdentity}:${proof.providerId}` &&
        accountIdentity(account) === proof.accountIdentity && row.connectionGeneration === proof.generation) &&
        state.selectedMailTexts.some((body) => body.accountId === proof.accountId && body.messageId === proof.locator && body.providerMessageId === proof.providerId &&
          body.identityKey === proof.accountIdentity && body.connectionGeneration === proof.generation && validSelectedMailTextSnapshot(body) &&
          (body.completeness === 'complete_text' || proof.mailBodyProvenance?.completeness === 'excerpt' && body.completeness === 'excerpt')));
    }
    case 'calendar': {
      const calendarId = proof.containerId!; const eventId = proof.providerId!;
      const authority = selectedAccountAuthority(state, proof.accountId!, proof.generation!, 'calendar.read');
      const account = authority?.account;
      return Boolean(account && state.calendars.some((calendar) => calendar.id === calendarId && calendar.accountId === proof.accountId && calendar.connected) &&
        accountIdentity(account) === proof.accountIdentity &&
        state.calendarEvents.some((row) => row.id === proof.locator && row.calendarId === calendarId && row.providerEventId === eventId && row.accountId === proof.accountId &&
          !row.providerDeletedAt && row.verifiedIdentityKey === proof.accountIdentity && row.connectionGeneration === proof.generation));
    }
    case 'document': {
      const doc = state.documents.find((item) => item.path === proof.locator);
      return Boolean(doc && !pathIsGenerated(doc.path));
    }
    case 'person': case 'project': {
      const entity = proof.kind === 'person' ? state.knowledge.people.find((item) => item.id === proof.entityId) :
        state.knowledge.projects.find((item) => item.id === proof.entityId);
      if (!entity || entity.archivedAt || entity.importOrigin) return false;
      const childRef = (type: string, item: { id: string; createdAt: string }) => `${type}\u0000${item.id}\u0000${item.createdAt}`;
      const children = proof.kind === 'person'
        ? [...entity.facts.map((item) => childRef('fact', item)), ...entity.sourceLinks.map((item) => childRef('sourceLink', item)),
          ...(entity as AppState['knowledge']['people'][number]).contacts.map((item) => childRef('contact', item))]
        : [...entity.facts.map((item) => childRef('fact', item)), ...entity.sourceLinks.map((item) => childRef('sourceLink', item)),
          ...(entity as AppState['knowledge']['projects'][number]).members.map((item) => childRef('member', item))];
      const current = new Set(children);
      return (proof.childRefs ?? []).every((child) => current.has(child));
    }
  }
}

function sourceIdForProof(proof: SourceProof): string {
  switch (proof.kind) {
    case 'note': return `note:${proof.locator}`;
    case 'chat': return `chat:${proof.locator}`;
    case 'task': { const [taskId, phase] = proof.locator.split(':'); return `task:${taskId}:${phase}`; }
    case 'decision': return `decision:${proof.locator}:${proof.sourceRevision}:${proof.itemId}`;
    case 'accepted_inference': return `accepted_inference:${proof.locator.split(':')[0]}:${proof.entityId}:${proof.itemId}`;
    case 'mail': return `mail:${proof.locator}`;
    case 'calendar': return `calendar:${proof.locator}`;
    case 'document': return `document:${proof.locator}`;
    case 'person': case 'project': return `${proof.kind}:${proof.entityId}`;
  }
}

export function revalidatePeriodSummarySourceCapture(kernel: DurableKernel, sessionToken: string, lineage: DocumentLineage,
  capture: PeriodSummarySourceCapture, mode: 'exact' | 'membership'): PeriodSummarySourceCapture {
  const proof = capture && typeof capture === 'object' ? proofs.get(capture) : undefined;
  if (!proof || (mode !== 'exact' && mode !== 'membership')) fail('period_summary_capture_proof_invalid');
  return kernel.withOwnedTransaction(sessionToken, proof.scope.privacyEpoch, (context) => {
    return revalidateCaptureWithinTransaction(kernel, context, lineage, capture, mode, proof);
  });
}

/** Same-transaction source fence for trusted snapshot participants; never opens a nested kernel transaction. */
export function revalidatePeriodSummarySourceCaptureWithinTransaction(kernel: DurableKernel, context: OwnedTransactionContext,
  lineage: DocumentLineage, capture: PeriodSummarySourceCapture, mode: 'exact' | 'membership'): PeriodSummarySourceCapture {
  kernel.assertOwnedTransactionContext(context);
  const proof = capture && typeof capture === 'object' ? proofs.get(capture) : undefined;
  if (!proof || (mode !== 'exact' && mode !== 'membership')) fail('period_summary_capture_proof_invalid');
  return revalidateCaptureWithinTransaction(kernel, context, lineage, capture, mode, proof);
}

/** Extracts only immutable, non-capability metadata from a capture already authenticated by this module's WeakMap. */
export function periodSummaryCaptureCheckpointEvidence(capture: PeriodSummarySourceCapture): Readonly<{
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly request: PeriodSummaryCaptureRequest;
  readonly interval: PeriodSummaryCaptureInterval;
  readonly destination: CapturedDocumentDestination;
  readonly sourceProofs: readonly SourceProof[];
  readonly sourceManifestSha256: string;
}> {
  const proof = capture && typeof capture === 'object' ? proofs.get(capture) : undefined;
  if (!proof) fail('period_summary_capture_proof_invalid');
  const sourceManifestSha256 = sha(canonical(capture.sources.map(({ content: _content, ...entry }) => entry)));
  return Object.freeze({ workspaceId: proof.scope.workspaceId, ownerId: proof.scope.ownerId, privacyEpoch: proof.scope.privacyEpoch,
    request: proof.request, interval: proof.interval, destination: proof.destination, sourceProofs: proof.sources, sourceManifestSha256 });
}

function revalidateCaptureWithinTransaction(kernel: DurableKernel, context: OwnedTransactionContext, lineage: DocumentLineage,
  capture: PeriodSummarySourceCapture, mode: 'exact' | 'membership', proof: CaptureProof): PeriodSummarySourceCapture {
  if (context.workspaceId !== proof.scope.workspaceId || context.ownerId !== proof.scope.ownerId || context.privacyEpoch !== proof.scope.privacyEpoch) {
    fail('period_summary_capture_scope_changed');
  }
  const state = stateFrom(kernel.readOwnedSnapshotWithinTransaction(context));
  lineage.assertDestination(context, proof.destination);
  const omitted: PeriodSummaryCaptureOmission[] = [];
  const rebuilt = proof.interval.empty ? { sources: [], proofs: [], omissions: [], coverageDeferred: false, sourceDeferred: false } :
    buildSources(state, lineage, context, proof.request, proof.interval);
  if (mode === 'exact') {
    const capturedIds = new Set(capture.sources.map((item) => item.id));
    const rebuiltIds = new Set(rebuilt.sources.map((item) => item.id));
    if (rebuilt.coverageDeferred || rebuilt.sourceDeferred || capturedIds.size !== rebuiltIds.size ||
        [...capturedIds].some((id) => !rebuiltIds.has(id))) fail('period_summary_capture_stale');
  }
  const currentById = new Map(rebuilt.sources.map((item) => [item.id, item]));
  for (const item of proof.sources) {
    const present = sourceStillExists(state, item, proof.interval);
    if (!present) omitted.push(Object.freeze({ sourceId: `${item.kind}:${item.locator}`, reason: 'selected_context_missing' }));
    const sourceId = sourceIdForProof(item);
    const current = currentById.get(sourceId);
    if (present && mode === 'exact' && !current) omitted.push(Object.freeze({ sourceId, reason: 'selected_context_ineligible' }));
    if (item.document && present) {
      const currentDocument = lineage.captureDestination(context, item.document.path);
      if (currentDocument.documentId !== item.document.documentId) omitted.push(Object.freeze({ sourceId, reason: 'selected_context_ineligible' }));
    }
    if (present && mode === 'exact') {
      const capturedSource = capture.sources.find((candidate) => candidate.id === sourceId);
      if (!current || !capturedSource || canonical(current) !== canonical(capturedSource)) {
        omitted.push(Object.freeze({ sourceId, reason: 'selected_context_ineligible' }));
      }
    }
  }
  if (omitted.length) fail(mode === 'exact' ? 'period_summary_capture_stale' : 'period_summary_capture_source_removed');
  const refreshed = deepFreeze({ ...capture });
  proofs.set(refreshed, proof);
  return refreshed;
}

export function periodSummaryCaptureHasPrivateProof(value: unknown): value is PeriodSummarySourceCapture {
  return Boolean(value && typeof value === 'object' && proofs.has(value));
}
