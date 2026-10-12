import * as Crypto from 'expo-crypto';
import type {
  Account, AccountConfig, AccountSyncState, AccountCapability, ActivityItem, AppController, AppSettings, AppState,
  Calendar, CalendarConfig, ContextDocument, Note, NoteAssistResult, AssistIntent, LocalTask, Proposal, ProposalPatch,
  ProposalProvenance, SaveNoteInput, SettingsPatch, MailboxSnapshotMessage, CalendarEventSnapshot, OAuthInstallResult,
} from '../core';
import { stateStore } from '../storage/platformStorage';
import type { StateStore } from '../storage/contracts';
import { writePrivateDocument } from '../storage/documents';
import { AzureOpenAIClient, AzureSpeechClient, validateAzureEndpoint, type DraftAnalysis } from './azure';
import { cancelReminderNotification, requestReminderNotification } from './notifications';
import { removeAudio } from '../audio/readAudio';
import type {
  ApprovedDispatch, DispatchVerifier, OAuthBridgeResult, StoredOAuthToken, OAuthTokenStore,
  MessageSummary, CalendarSummary, SyncPage, MutationReceipt,
} from '../connectors';
import { ConnectorClient, ProviderWriteRejectedError, withCredentialLock } from '../connectors';
import { scopeGrantsCapability } from '../connectors/oauth';
import { oauthTokenStore, deleteOAuthToken } from '../auth/tokenStore';
import { Platform } from 'react-native';
import { buildLocalSourceSet, buildOfflinePreview, createSourceCatalog, type AssistantSourceInput } from '../assistant';
import { appendDispatchReconciliation, createDispatchRecord, recordDispatchOutcome, validateDispatchRecord } from '../dispatch';
import type { DispatchOutcome, DispatchRecord, DispatchReconciliation } from '../dispatch';

const now = () => new Date().toISOString();
const ASSIST_CONTRACT_VERSION = 'assist-v2';
let fallbackUuidCounter = 0;
const newId = () => Crypto.randomUUID?.() ?? globalThis.crypto?.randomUUID?.() ??
  `00000000-0000-4000-8000-${String(++fallbackUuidCounter).padStart(12, '0')}`;
function validTimezone(value?: string): string {
  const candidate = value?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore';
  try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(); return candidate; }
  catch { return 'Asia/Singapore'; }
}
function localDate(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: validTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (key: string) => parts.find((part) => part.type === key)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function isoWeek(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const weekYear = value.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((value.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}
const clone = <T,>(value: T): T => structuredClone(value);
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const DEFAULT_SETTINGS: AppSettings = {
  mode: 'preview', timezone: validTimezone(), maxContextTokens: 6000, maxRequestBytes: 24000, maxOutputTokens: 1200, monthlyBudgetUsd: 5,
  reasoningEffort: 'none', maxAttempts: 2, maxCallsPerDay: 20, maxAudioSeconds: 600, audioRetention: 'keep',
};

function initialState(): AppState {
  const day = localDate(DEFAULT_SETTINGS.timezone);
  return {
    notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [],
    settings: { ...DEFAULT_SETTINGS },
    usage: { month: day.slice(0, 7), day, requests: 0, attemptsToday: 0, inputTokens: 0, outputTokens: 0, transcriptionSeconds: 0, attempts: 0, unknownCharges: 0, reservedUsd: 0, priceKnown: false, estimatedCostUsd: 0 },
    mailbox: [], calendarEvents: [], syncStates: {}, pendingCredentialCleanup: [], dispatchRecords: [], dispatchRecordQuarantine: [],
  };
}

function emptySyncState(accountId: string): AccountSyncState {
  return { accountId, status: 'idle', messagesPartial: false, calendarsPartial: false, eventCursors: {}, eventsCompletedAt: {} };
}

function addActivity(state: AppState, type: ActivityItem['type'], message: string, refs: Partial<ActivityItem> = {}): void {
  state.activity.unshift({ id: newId(), type, message, createdAt: now(), ...refs });
  state.activity = state.activity.slice(0, 250);
}

function markAnalysesStale(state: AppState, sourceIds: string[], prefixes: string[] = []): void {
  for (const note of state.notes) {
    const versions = note.analysis?.sourceVersions;
    if (!versions) continue;
    if (sourceIds.some((id) => id in versions) || Object.keys(versions).some((id) => prefixes.some((prefix) => id.startsWith(prefix)))) note.analysis!.stale = true;
  }
}

function markTaskAnalysesStale(state: AppState, taskId?: string): void {
  markAnalysesStale(state, taskId ? [`task:${encodeURIComponent(taskId)}`] : []);
  for (const note of state.notes) {
    if (note.analysis?.intent === 'answer' && /\btask|todo|to-do|action item/i.test(note.analysis.question ?? '')) note.analysis.stale = true;
  }
}

function upsertDocument(state: AppState, path: string, content: string): ContextDocument {
  const existing = state.documents.find((item) => item.path === path);
  const document: ContextDocument = { path, content, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
  if (existing) Object.assign(existing, document); else state.documents.unshift(document);
  return document;
}

function ensureMemoryDocuments(state: AppState): ContextDocument[] {
  const defaults: Record<string, string> = {
    'memory/PROFILE.md': '# Profile\n\nUser-confirmed facts and preferences.\n',
    'memory/RULES.md': '# Rules\n\nUser-authored rules. Assistant suggestions do not modify this file.\n',
    'memory/ROUTINES.md': '# Routines\n\nUser-confirmed recurring routines.\n',
    'memory/DECISIONS.md': '# Decisions\n\nUser-approved decisions and actions.\n',
    'memory/INFERENCES.md': '# Inferences\n\nUnverified suggestions are labeled and linked to their source note.\n',
  };
  const created: ContextDocument[] = [];
  for (const [path, content] of Object.entries(defaults)) if (!state.documents.some((item) => item.path === path)) created.push(upsertDocument(state, path, content));
  return created;
}

function recordJournal(state: AppState, marker: string, text: string): ContextDocument[] {
  const day = localDate(state.settings.timezone);
  const paths = [
    `logs/daily/${day}.md`, `logs/weekly/${isoWeek(day)}.md`,
    `logs/monthly/${day.slice(0, 7)}.md`, `logs/yearly/${day.slice(0, 4)}.md`,
  ];
  const written: ContextDocument[] = [];
  for (const path of paths) {
    const existing = state.documents.find((item) => item.path === path);
    const tag = `<!-- ${marker} -->`;
    if (existing?.content.includes(tag)) continue;
    const content = `${existing?.content?.trim() || `# ${path.split('/').at(-1)?.replace('.md', '')}\n`}\n${tag}\n- ${text}\n`;
    written.push(upsertDocument(state, path, content));
  }
  return written;
}

function appendDecision(state: AppState, proposal: Proposal): ContextDocument {
  const path = 'memory/DECISIONS.md';
  const existing = state.documents.find((item) => item.path === path);
  const marker = `<!-- approved:${proposal.id}:r${proposal.revision} -->`;
  if (existing?.content.includes(marker)) return existing;
  return upsertDocument(state, path, `${existing?.content?.trim() || '# Decisions'}\n${marker}\n- Approved ${proposal.kind}: ${proposal.title}. Source note ${proposal.noteId}, revision ${proposal.sourceRevision}.\n`);
}

function ensurePeriodDocuments(state: AppState): ContextDocument[] {
  const day = localDate(state.settings.timezone);
  const paths = [
    `logs/daily/${day}.md`, `logs/weekly/${isoWeek(day)}.md`,
    `logs/monthly/${day.slice(0, 7)}.md`, `logs/yearly/${day.slice(0, 4)}.md`,
  ];
  return paths.filter((path) => !state.documents.some((doc) => doc.path === path))
    .map((path) => upsertDocument(state, path, `# ${path.split('/').at(-1)?.replace('.md', '')}\n`));
}

function appendInference(state: AppState, proposal: Proposal, mode: AppSettings['mode']): ContextDocument {
  const path = 'memory/INFERENCES.md';
  const existing = state.documents.find((item) => item.path === path);
  const marker = `<!-- suggestion:${proposal.id}:r${proposal.sourceRevision} -->`;
  if (existing?.content.includes(marker)) return existing;
  const evidence = proposal.evidence.map((item) => `“${item.quote}”`).join('; ');
  const label = mode === 'provider' ? 'Unverified provider suggestion' : 'Offline rule-based preview';
  return upsertDocument(state, path, `${existing?.content?.trim() || '# Inferences'}\n${marker}\n- ${label}: ${proposal.title}. Source note ${proposal.noteId}: ${evidence}\n`);
}

function finiteClamp(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return Math.min(max, Math.max(min, Math.floor(value)));
}
function finiteRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return Math.min(max, Math.max(min, value));
}

function validEmail(value: string): boolean {
  return !/[\r\n]/.test(value) && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

function sameAccountIdentity(a: Account['identity'], b: Account['identity']): boolean {
  return Boolean(a && b && a.providerNamespace === b.providerNamespace && a.clientId === b.clientId &&
    a.subject === b.subject && a.resourceUserId === b.resourceUserId && a.issuer === b.issuer && a.tenantId === b.tenantId);
}

function dispatchIdentityMatches(record: DispatchRecord, account: Account): boolean {
  const identity = account.identity;
  return Boolean(identity && record.account.identity.providerNamespace === identity.providerNamespace &&
    record.account.identity.clientId === identity.clientId && record.account.identity.subject === identity.subject &&
    (record.account.identity.resourceUserId ?? '') === (identity.resourceUserId ?? ''));
}

function assertNoDuplicateDispatch(state: AppState, candidate: DispatchRecord): void {
  const sameSourceIdentity = (record: DispatchRecord) => record.sourceActionKey === candidate.sourceActionKey &&
    record.account.identity.providerNamespace === candidate.account.identity.providerNamespace &&
    record.account.identity.clientId === candidate.account.identity.clientId &&
    record.account.identity.subject === candidate.account.identity.subject &&
    (record.account.identity.resourceUserId ?? '') === (candidate.account.identity.resourceUserId ?? '');
  const candidateMail = candidate.operation === 'draft' || candidate.operation === 'send';
  const recordDuplicate = state.dispatchRecords.some((record) => {
    if (!['pending', 'accepted', 'unknown'].includes(record.outcome)) return false;
    if (record.duplicateKey === candidate.duplicateKey) return true;
    return record.outcome === 'unknown' && candidateMail && (record.operation === 'draft' || record.operation === 'send') && sameSourceIdentity(record);
  });
  if (recordDuplicate) throw new Error('This source action already has a pending, accepted, or unknown provider attempt. Review its dispatch history; it will not be sent again.');

  const recordedProposalIds = new Set(state.dispatchRecords.map((record) => record.proposalId));
  const legacyDuplicate = state.proposals.some((proposal) => {
    if (proposal.id === candidate.proposalId || recordedProposalIds.has(proposal.id) || !['accepted', 'unknown', 'dispatching'].includes(proposal.status) || proposal.simulated) return false;
    const operation = proposal.remoteOperation ?? (proposal.kind === 'email' ? proposal.email?.operation : proposal.kind === 'event' ? 'event' : undefined);
    const proposalMail = proposal.kind === 'email';
    const identity = proposal.accountId ? state.accounts.find((account) => account.id === proposal.accountId) : undefined;
    const sameAccount = proposal.accountId === candidate.accountId || Boolean(identity && dispatchIdentityMatches(candidate, identity));
    const sameSource = proposal.sourceActionKey
      ? proposal.sourceActionKey === candidate.sourceActionKey
      : proposal.noteId === candidate.sourceProvenance.noteId && proposal.sourceRevision === candidate.sourceRevision && proposal.kind === (candidate.operation === 'event' ? 'event' : 'email');
    if (!sameAccount || !sameSource) return false;
    if (proposalMail && candidateMail && !operation) return true;
    if (proposal.status === 'unknown' && proposalMail && candidateMail) return true;
    return operation === candidate.operation;
  });
  if (legacyDuplicate) throw new Error('A legacy provider action for this source already exists. Its historical payload was not captured, so this action is blocked from duplicate dispatch.');
}

function identityKey(account: Account): string {
  const identity = account.identity;
  if (!identity?.providerNamespace || !identity.clientId || !identity.subject ||
      (account.provider === 'microsoft' && !identity.resourceUserId)) throw new Error('Verified account identity is incomplete.');
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}

function assistContext(state: AppState, note: Note, intent: AssistIntent, question?: string): { documents: ContextDocument[]; additionalSources: AssistantSourceInput[]; omittedSourceCount: number; omittedSourceIds: string[] } {
  const allDocuments = state.documents.filter(({ path }) => !path.startsWith('logs/') && path !== 'memory/INFERENCES.md' && path !== 'memory/DECISIONS.md');
  const taskQuery = intent === 'answer' && /\b(task|tasks|task count|how many|todo|to-do|action item)\b/i.test(question ?? '');
  const built = buildLocalSourceSet({
    transcript: { revision: note.revision, text: note.transcript },
    query: `${question ?? ''}\n${note.transcript}`,
    intent,
    documents: allDocuments.map((doc) => ({ path: doc.path, revision: doc.revision, content: doc.content, updatedAt: doc.updatedAt })),
    tasks: taskQuery ? state.tasks.map((task) => ({ id: task.id, title: task.title, body: task.body, status: task.status, dueAt: task.dueAt, updatedAt: task.completedAt ?? task.createdAt })) : [],
    calendars: state.calendars.flatMap((calendar) => {
      const account = state.accounts.find((item) => item.id === calendar.accountId);
      return account?.connected && account.authStatus === 'connected'
        ? [{ id: calendar.id, accountId: calendar.accountId, identityKey: identityKey(account), providerId: calendar.providerId, name: calendar.name, writable: calendar.writable, connected: calendar.connected }]
        : [];
    }),
    calendarEvents: state.calendarEvents.flatMap((event) => {
      const account = state.accounts.find((item) => item.id === event.accountId);
      return account?.connected && account.authStatus === 'connected' ? [{ ...event, identityKey: identityKey(account) }] : [];
    }),
    mailbox: state.mailbox.flatMap((message) => {
      const account = state.accounts.find((item) => item.id === message.accountId);
      if (!account?.connected || account.authStatus !== 'connected' || !message.providerMessageId) return [];
      const accountIdentity = identityKey(account);
      return message.identityKey === `${accountIdentity}:${message.providerMessageId}`
        ? [{ ...message, identityKey: accountIdentity }]
        : [];
    }),
  });
  const documentByPath = new Map(allDocuments.map((document) => [document.path, document]));
  return {
    documents: built.sources.filter((source) => source.id.startsWith('doc:')).flatMap((source) => {
      const document = documentByPath.get(source.id.slice('doc:'.length));
      return document ? [document] : [];
    }),
    additionalSources: built.sources.filter((source) => source.id !== 'transcript' && !source.id.startsWith('doc:') && (taskQuery || !source.id.startsWith('task:'))),
    omittedSourceCount: built.omittedSourceCount,
    omittedSourceIds: built.omittedSourceIds,
  };
}

function sameSourceVersions(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftIds = Object.keys(left).sort();
  const rightIds = Object.keys(right).sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index] && left[id] === right[id]);
}

function offlineAssistInputs(note: Note, intent: AssistIntent, question: string | undefined, additionalSources: AssistantSourceInput[], calendarAvailable: boolean): AssistantSourceInput[] {
  const taskQuestion = intent === 'answer' && /\b(task|tasks|todo|to-do|action item)\b/i.test(question ?? '');
  const calendarQuestion = intent === 'answer' && /\b(calendar|meeting|event|upcoming|tomorrow|today|next)\b/i.test(question ?? '') && calendarAvailable;
  return [
    { id: 'transcript', revision: note.revision, text: note.transcript, required: true, kind: 'note' },
    ...additionalSources.filter((source) => taskQuestion && source.id.startsWith('task:') || calendarQuestion && source.id.startsWith('calendar')),
  ];
}

function grantedCapabilities(provider: Account['provider'], scopes: string[]): AccountCapability[] {
  const values = new Set(scopes.map((scope) => scope.toLowerCase()));
  const has = (...candidates: string[]) => candidates.some((candidate) => values.has(candidate.toLowerCase()));
  const result: AccountCapability[] = [];
  if (provider === 'google') {
    if (has('https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.metadata', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/')) result.push('mail.read');
    if (has('https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/')) result.push('mail.draft');
    if (has('https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://mail.google.com/')) result.push('mail.send');
    if (has('https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.events')) result.push('calendar.read');
    if (has('https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events')) result.push('calendar.write');
  } else if (provider === 'microsoft') {
    if (has('mail.read', 'mail.readbasic', 'mail.readwrite')) result.push('mail.read');
    if (has('mail.readwrite')) result.push('mail.draft');
    if (has('mail.send')) result.push('mail.send');
    if (has('calendars.read', 'calendars.readwrite')) result.push('calendar.read');
    if (has('calendars.readwrite')) result.push('calendar.write');
  }
  return result;
}

function intersectCapabilities(...groups: AccountCapability[][]): AccountCapability[] {
  const first = groups[0] ?? [];
  return first.filter((capability) => groups.every((group) => group.includes(capability)));
}

async function approvedDigest(proposal: Proposal, state: AppState): Promise<string> {
  const account = state.accounts.find((item) => item.id === proposal.accountId);
  const calendar = state.calendars.find((item) => item.id === proposal.calendarId);
  const payload = JSON.stringify({
    id: proposal.id, revision: proposal.revision, noteId: proposal.noteId, sourceRevision: proposal.sourceRevision,
    provenance: proposal.provenance ?? null, requiresRebuild: proposal.requiresRebuild ?? false,
    kind: proposal.kind, title: proposal.title, body: proposal.body,
    accountId: proposal.accountId ?? null, accountIdentity: account ? {
      provider: account.provider, email: account.email, authStatus: account.authStatus,
      identity: account.identity ? {
        providerNamespace: account.identity.providerNamespace ?? null, clientId: account.identity.clientId ?? null,
        subject: account.identity.subject, issuer: account.identity.issuer ?? null, tenantId: account.identity.tenantId ?? null,
        resourceUserId: account.identity.resourceUserId ?? null,
      } : null,
      scopes: account.grantedScopes ?? [], capabilities: account.capabilities ?? [], capabilityLimits: account.capabilityLimits ?? [],
    } : null,
    recipients: [...proposal.recipients], calendarId: proposal.calendarId ?? null,
    calendarDestination: calendar ? { accountId: calendar.accountId, providerId: calendar.providerId ?? null, name: calendar.name, writable: calendar.writable, connected: calendar.connected } : null,
    dueAt: proposal.dueAt ?? null, email: proposal.email ?? null, event: proposal.event ?? null, evidence: proposal.evidence,
  });
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload, { encoding: Crypto.CryptoEncoding.HEX });
}

export function extractPreviewProposals(note: Note): Proposal[] {
  const sentences = note.transcript.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const proposals: Proposal[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    let kind: Proposal['kind'] | undefined;
    if (/\b(remember|keep in mind|my preference is|i prefer)\b/.test(lower)) kind = 'memory';
    else if (/\b(email|e-mail|send|reply to|message)\b/.test(lower)) kind = 'email';
    else if (/\b(meeting|schedule|calendar|appointment|event)\b/.test(lower)) kind = 'event';
    else if (/\b(remind me|reminder|don't forget|due (today|tomorrow|on))\b/.test(lower)) kind = 'reminder';
    else if (/\b(need to|todo|to-do|i should|i must|action item|follow up|follow-up)\b/.test(lower)) kind = 'task';
    if (!kind) continue;
    proposals.push({
      id: newId(), noteId: note.id, kind, title: sentence.replace(/^[\s.!?]+|[.!?]+$/g, '').slice(0, 88) || 'Suggested action',
      body: sentence, status: 'draft', revision: 1, recipients: [], sourceRevision: note.revision,
      evidence: [{ quote: sentence, source: 'transcript' }],
    });
  }
  return proposals;
}

function normalizeActionEvidence(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function sourceActionKey(note: Note, kind: Proposal['kind'], evidence: Proposal['evidence']): string {
  const sentences = note.transcript.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  const anchors = [...new Set(evidence.map(({ quote }) => {
    const normalizedQuote = normalizeActionEvidence(quote);
    const sentence = sentences.find((candidate) => normalizeActionEvidence(candidate).includes(normalizedQuote));
    return normalizeActionEvidence(sentence ?? quote);
  }).filter(Boolean))].sort();
  return JSON.stringify([note.id, note.revision, kind, anchors]);
}

function createProposalProvenance(input: {
  analysisFingerprint: string; note: Note; intent: AssistIntent; question?: string;
  sourceVersions: Record<string, string>; policySources: ProposalProvenance['policySources']; settings: AppSettings; answeredAsOf?: string;
}): ProposalProvenance | undefined {
  const sources = Object.entries(input.sourceVersions).map(([sourceId, sourceVersion]) => {
    const match = /^(\d+):([a-f0-9]{64})$/i.exec(sourceVersion);
    if (!match) return undefined;
    return { sourceId, revision: Number(match[1]), sourceVersion };
  });
  if (sources.some((source) => !source)) return undefined;
  const expiresAt = input.answeredAsOf
    ? new Date((Math.floor(Date.parse(input.answeredAsOf) / 900_000) + 1) * 900_000).toISOString()
    : undefined;
  return {
    version: 1, assistContractVersion: ASSIST_CONTRACT_VERSION, analysisFingerprint: input.analysisFingerprint,
    noteId: input.note.id, noteRevision: input.note.revision, capturedAt: input.note.capturedAt ?? input.note.createdAt,
    captureTimeZone: input.note.captureTimeZone || input.settings.timezone,
    intent: input.intent, ...(input.question ? { question: input.question } : {}),
    sources: sources as NonNullable<typeof sources[number]>[], policySources: input.policySources,
    settingsFingerprint: JSON.stringify(input.settings),
    ...(input.answeredAsOf ? { answeredAsOf: input.answeredAsOf, expiresAt } : {}),
  };
}

function normalizeLoadedState(value: unknown): AppState {
  const defaults = initialState();
  if (!value || typeof value !== 'object') throw new Error('Saved app data is not a valid state snapshot. It was preserved for recovery.');
  const raw = value as Partial<AppState>;
  if (!Array.isArray(raw.notes) || !Array.isArray(raw.proposals) || !Array.isArray(raw.accounts) ||
      !Array.isArray(raw.calendars) || !Array.isArray(raw.documents) || !Array.isArray(raw.activity)) {
    throw new Error('Saved app data is incomplete. It was preserved for recovery.');
  }
  const rawSettings: Partial<AppSettings> = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const maxRequestBytes = Number.isFinite(rawSettings.maxRequestBytes) ? Math.max(4000, Math.min(96000, Math.floor(rawSettings.maxRequestBytes!))) : DEFAULT_SETTINGS.maxRequestBytes;
  const notes = raw.notes.map((note) => {
    const analysis = note.analysis ? {
      ...note.analysis,
      includedSources: Array.isArray(note.analysis.includedSources) ? note.analysis.includedSources : (note.analysis.includedSourceIds ?? []).map((id) => ({ id, title: id })),
      omittedSourceCount: Number.isFinite(note.analysis.omittedSourceCount) ? note.analysis.omittedSourceCount : (note.analysis.omittedSourceIds ?? []).length,
    } : undefined;
    return { ...note, revision: Number.isFinite(note.revision) ? note.revision : 1, capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: validTimezone(note.captureTimeZone ?? rawSettings.timezone), analysis };
  });
  const proposals = raw.proposals.map((proposal) => {
    const source = notes.find((note) => note.id === proposal.noteId);
    const validProvenanceList = (items: unknown): boolean => {
      if (!Array.isArray(items)) return false;
      const ids = new Set<string>();
      return items.every((item) => {
        if (!item || typeof item.sourceId !== 'string' || !item.sourceId || ids.has(item.sourceId) ||
            !Number.isSafeInteger(item.revision) || item.revision < 0 || typeof item.sourceVersion !== 'string') return false;
        const match = /^(\d+):([a-f0-9]{64})$/i.exec(item.sourceVersion);
        if (!match || Number(match[1]) !== item.revision) return false;
        ids.add(item.sourceId);
        return true;
      });
    };
    const candidateProvenance = proposal.provenance;
    const provenance = candidateProvenance && candidateProvenance.version === 1 &&
      candidateProvenance.assistContractVersion === ASSIST_CONTRACT_VERSION &&
      typeof candidateProvenance.analysisFingerprint === 'string' && typeof candidateProvenance.noteId === 'string' &&
      Number.isSafeInteger(candidateProvenance.noteRevision) && typeof candidateProvenance.capturedAt === 'string' &&
      Number.isFinite(Date.parse(candidateProvenance.capturedAt)) && typeof candidateProvenance.captureTimeZone === 'string' &&
      ['assist', 'summarize', 'answer', 'extract'].includes(candidateProvenance.intent) &&
      typeof candidateProvenance.settingsFingerprint === 'string' && validProvenanceList(candidateProvenance.sources) &&
      candidateProvenance.sources.some((item) => item.sourceId === 'transcript') && validProvenanceList(candidateProvenance.policySources) &&
      (!candidateProvenance.answeredAsOf || Number.isFinite(Date.parse(candidateProvenance.answeredAsOf))) &&
      (!candidateProvenance.expiresAt || Number.isFinite(Date.parse(candidateProvenance.expiresAt)))
      ? candidateProvenance : undefined;
    const pending = ['draft', 'approved', 'failed'].includes(proposal.status);
    const requiresRebuild = Boolean(proposal.requiresRebuild || (pending && !provenance));
    return {
      ...proposal, recipients: Array.isArray(proposal.recipients) ? proposal.recipients : [],
      evidence: Array.isArray(proposal.evidence) ? proposal.evidence : [],
      revision: Number.isFinite(proposal.revision) ? proposal.revision : 1,
      sourceRevision: Number.isFinite(proposal.sourceRevision) ? proposal.sourceRevision : source?.revision ?? 1,
      provenance, requiresRebuild,
      ...(requiresRebuild && proposal.status === 'approved' ? { status: 'draft' as const, approvedRevision: undefined, approvedPayloadDigest: undefined } : {}),
      sourceActionKey: proposal.sourceActionKey ?? (source && Array.isArray(proposal.evidence)
        ? sourceActionKey({ ...source, revision: Number.isFinite(proposal.sourceRevision) ? proposal.sourceRevision : source.revision }, proposal.kind, proposal.evidence)
        : undefined),
    };
  });
  const migratedTasks: LocalTask[] = proposals.filter((proposal) => proposal.kind === 'task' && ['executed', 'accepted'].includes(proposal.status))
    .map((proposal) => ({ id: proposal.id, title: proposal.title, body: proposal.body, status: 'open', createdAt: proposal.remoteAcceptedAt ?? now(), dueAt: proposal.dueAt, sourceNoteId: proposal.noteId, sourceRevision: proposal.sourceRevision, proposalId: proposal.id }));
  const savedTasks: LocalTask[] = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks = [...savedTasks, ...migratedTasks.filter((task) => !savedTasks.some((saved) => saved.id === task.id))];
  const settings = { ...DEFAULT_SETTINGS, ...rawSettings, timezone: validTimezone(rawSettings.timezone), maxRequestBytes };
  const dispatchRecords: DispatchRecord[] = [];
  const dispatchRecordQuarantine: AppState['dispatchRecordQuarantine'] = Array.isArray(raw.dispatchRecordQuarantine)
    ? raw.dispatchRecordQuarantine.map((item) => item && typeof item === 'object' && 'raw' in item && 'quarantinedAt' in item
      ? { reason: 'invalid_persisted_receipt' as const, quarantinedAt: typeof item.quarantinedAt === 'string' ? item.quarantinedAt : now(), raw: item.raw }
      : { reason: 'invalid_persisted_receipt' as const, quarantinedAt: now(), raw: item })
    : [];
  if (Array.isArray(raw.dispatchRecords)) {
    for (const value of raw.dispatchRecords) {
      try { dispatchRecords.push(validateDispatchRecord(value)); }
      catch { dispatchRecordQuarantine.push({ reason: 'invalid_persisted_receipt', quarantinedAt: now(), raw: value }); }
    }
  }
  const recordIds = new Set(dispatchRecords.map((record) => record.id));
  for (const proposal of proposals) {
    if (proposal.dispatchRecordId && !recordIds.has(proposal.dispatchRecordId)) proposal.dispatchRecordId = undefined;
    if ((proposal.kind === 'email' || proposal.kind === 'event') && ['accepted', 'unknown'].includes(proposal.status) && !proposal.dispatchRecordId) {
      proposal.dispatchHistoryIncomplete = true;
    }
  }
  return {
    ...defaults, ...raw, notes, proposals, tasks,
    dispatchRecords, dispatchRecordQuarantine,
    pendingCredentialCleanup: Array.isArray(raw.pendingCredentialCleanup) ? raw.pendingCredentialCleanup.filter((item) =>
      item && typeof item.tokenRef === 'string' && item.tokenRef.length > 0 && ['replaced', 'disconnected', 'orphan'].includes(item.reason) && typeof item.createdAt === 'string') : [],
    // Account configuration is not authentication and cannot restore an OAuth connection.
    accounts: raw.accounts.map((account) => {
      const authStatus = ['configured', 'connected', 'reauth_required', 'revoked'].includes(account.authStatus) ? account.authStatus : 'configured';
      const identity = account.identity && typeof account.identity.subject === 'string'
        ? {
          ...(account.identity.providerNamespace === 'google' || account.identity.providerNamespace === 'microsoft' ? { providerNamespace: account.identity.providerNamespace } : {}),
          ...(typeof account.identity.clientId === 'string' ? { clientId: account.identity.clientId } : {}),
          subject: account.identity.subject,
          ...(typeof account.identity.issuer === 'string' ? { issuer: account.identity.issuer } : {}),
          ...(typeof account.identity.tenantId === 'string' ? { tenantId: account.identity.tenantId } : {}),
          ...(typeof account.identity.resourceUserId === 'string' ? { resourceUserId: account.identity.resourceUserId } : {}),
        }
        : undefined;
      const tokenRef = typeof account.tokenRef === 'string' ? account.tokenRef : undefined;
      const verified = authStatus === 'connected' && Boolean(identity?.providerNamespace && identity.clientId && identity.subject && tokenRef) &&
        (identity?.providerNamespace !== 'microsoft' || Boolean(identity.resourceUserId)) && identity?.providerNamespace === account.provider;
      if (!verified && identity) delete identity.tenantId;
      return {
        ...account, authStatus: authStatus === 'connected' && !verified ? 'reauth_required' : authStatus, identity, tokenRef, connected: verified,
        grantedScopes: Array.isArray(account.grantedScopes) ? account.grantedScopes.filter((scope): scope is string => typeof scope === 'string') : [],
        capabilities: Array.isArray(account.capabilities) ? account.capabilities.filter((capability) => ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'].includes(capability)) : [],
        capabilityLimits: Array.isArray(account.capabilityLimits) ? account.capabilityLimits.filter((capability): capability is AccountCapability => ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'].includes(capability)) : [],
        connectionGeneration: Number.isInteger(account.connectionGeneration) && account.connectionGeneration! >= 0 ? account.connectionGeneration : 0,
        syncStatus: ['idle', 'partial', 'error'].includes(String(account.syncStatus)) ? account.syncStatus : 'idle',
      };
    }),
    calendars: raw.calendars.map((calendar) => ({ ...calendar, connected: false, writable: false })),
    settings,
    usage: { ...defaults.usage, ...raw.usage },
    mailbox: Array.isArray(raw.mailbox) ? raw.mailbox : [],
    calendarEvents: Array.isArray(raw.calendarEvents) ? raw.calendarEvents : [],
    syncStates: raw.syncStates && typeof raw.syncStates === 'object' ? raw.syncStates : {},
  };
}

export interface ControllerIntegrationDependencies {
  tokenStore?: OAuthTokenStore;
  deleteToken?: (tokenRef: string) => Promise<void>;
  verifyOAuthResult?: (result: OAuthBridgeResult, stored: StoredOAuthToken) => Promise<boolean>;
  clientIds?: Partial<Record<'google' | 'microsoft', string>>;
  connectorFactory?: (
    tokenStore: OAuthTokenStore,
    onAuthStatus: (accountId: string, status: Account['authStatus']) => Promise<void>,
  ) => ConnectorClient;
}

export class AppControllerImpl implements AppController {
  private state = initialState();
  private snapshot = deepFreeze(clone(this.state));
  private listeners = new Set<(state: AppState) => void>();
  private transactionQueue = Promise.resolve();
  private loadPromise?: Promise<void>;
  private loaded = false;
  private processJobs = new Map<string, Promise<Proposal[]>>();
  private assistJobs = new Map<string, Promise<NoteAssistResult>>();
  private analysisCache = new Map<string, DraftAnalysis>();
  private mirrorDirty = new Set<string>();
  private readonly speechClient: AzureSpeechClient;
  private readonly openAiClient: AzureOpenAIClient;
  private readonly connector?: ConnectorClient;
  private activeSyncCount = 0;
  private syncQueue: (() => void)[] = [];
  private syncJobs = new Map<string, Promise<AccountSyncState>>();
  private syncGeneration = new Map<string, number>();
  private syncAbortControllers = new Map<string, AbortController>();
  private credentialCleanupJob?: Promise<void>;
  private installingTokenRefs = new Set<string>();

  constructor(
    private readonly store: StateStore = stateStore,
    providers: { speech?: AzureSpeechClient; openAi?: AzureOpenAIClient } = {},
    private readonly integration: ControllerIntegrationDependencies = {},
  ) {
    this.speechClient = providers.speech ?? new AzureSpeechClient({});
    this.openAiClient = providers.openAi ?? new AzureOpenAIClient();
    this.connector = integration.tokenStore && integration.connectorFactory
      ? integration.connectorFactory(integration.tokenStore, (accountId, status) => this.handleConnectorAuthStatus(accountId, status))
      : undefined;
  }

  getSnapshot(): AppState { return this.snapshot; }
  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void { for (const listener of this.listeners) listener(this.snapshot); }

  /** Serialize the complete read-modify-write operation; failed writes never mutate committed state. */
  private mutate<T>(operation: (draft: AppState) => T | Promise<T>): Promise<T> {
    const run = this.transactionQueue.then(async () => {
      if (!this.loaded) await this.load();
      if (this.loadPromise) await this.loadPromise;
      const draft = clone(this.state);
      const result = await operation(draft);
      await this.store.save(draft);
      this.state = draft;
      this.snapshot = deepFreeze(clone(draft));
      this.emit();
      return clone(result);
    });
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** A serialized local read/check that only commits when it actually changes state. */
  private mutateIfChanged<T>(operation: (draft: AppState) => Promise<{ changed: boolean; result: T }> | { changed: boolean; result: T }): Promise<T> {
    const run = this.transactionQueue.then(async () => {
      if (!this.loaded) await this.load();
      if (this.loadPromise) await this.loadPromise;
      const draft = clone(this.state);
      const { changed, result } = await operation(draft);
      if (changed) {
        await this.store.save(draft);
        this.state = draft;
        this.snapshot = deepFreeze(clone(draft));
        this.emit();
      }
      return clone(result);
    });
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async queueCredentialCleanup(tokenRef: string, reason: 'replaced' | 'disconnected' | 'orphan'): Promise<void> {
    if (!tokenRef) return;
    await this.mutate((state) => {
      if (state.accounts.some((account) => account.tokenRef === tokenRef)) return;
      if (!state.pendingCredentialCleanup.some((item) => item.tokenRef === tokenRef)) {
        state.pendingCredentialCleanup.push({ tokenRef, reason, createdAt: now() });
      }
    });
  }

  async retryCredentialCleanup(): Promise<void> {
    await this.load();
    if (this.credentialCleanupJob) return this.credentialCleanupJob;
    const job = (async () => {
      for (const queued of [...this.snapshot.pendingCredentialCleanup]) {
        if (this.installingTokenRefs.has(queued.tokenRef)) continue;
        if (this.snapshot.accounts.some((account) => account.tokenRef === queued.tokenRef)) {
          await this.mutate((state) => { state.pendingCredentialCleanup = state.pendingCredentialCleanup.filter((item) => item.tokenRef !== queued.tokenRef); });
          continue;
        }
        if (!this.integration.deleteToken) continue;
        try {
          const deleteCredential = async () => {
            if (this.installingTokenRefs.has(queued.tokenRef) || this.snapshot.accounts.some((account) => account.tokenRef === queued.tokenRef)) return false;
            await this.integration.deleteToken!(queued.tokenRef);
            return true;
          };
          const deleted = this.integration.tokenStore
            ? await withCredentialLock(this.integration.tokenStore, queued.tokenRef, deleteCredential)
            : await deleteCredential();
          if (!deleted) continue;
          await this.mutate((state) => {
            if (!state.accounts.some((account) => account.tokenRef === queued.tokenRef)) {
              state.pendingCredentialCleanup = state.pendingCredentialCleanup.filter((item) => item.tokenRef !== queued.tokenRef);
            }
          });
        } catch {
          await this.mutate((state) => {
            const item = state.pendingCredentialCleanup.find((entry) => entry.tokenRef === queued.tokenRef);
            if (item) item.lastError = 'Secure credential cleanup will be retried.';
          });
        }
      }
    })();
    this.credentialCleanupJob = job;
    try { await job; }
    finally { if (this.credentialCleanupJob === job) this.credentialCleanupJob = undefined; }
  }

  private note(state: AppState, id: string): Note {
    const value = state.notes.find((item) => item.id === id);
    if (!value) throw new Error('Note was not found.');
    return value;
  }
  private proposal(state: AppState, id: string): Proposal {
    const value = state.proposals.find((item) => item.id === id);
    if (!value) throw new Error('Proposal was not found.');
    return value;
  }
  private proposalDependencyInputs(state: AppState, proposal: Proposal): { note: Note; provenance: ProposalProvenance; inputs: AssistantSourceInput[]; policyInputs: AssistantSourceInput[] } {
    const provenance = proposal.provenance;
    if (!provenance || proposal.requiresRebuild) throw new Error('This saved suggestion has no verifiable source history. Run Assist again before approving it.');
    if (provenance.version !== 1 || provenance.assistContractVersion !== ASSIST_CONTRACT_VERSION ||
        !provenance.analysisFingerprint || !provenance.capturedAt || !provenance.captureTimeZone ||
        !provenance.settingsFingerprint || !Array.isArray(provenance.sources) || !Array.isArray(provenance.policySources) ||
        !provenance.sources.some((source) => source.sourceId === 'transcript')) {
      throw new Error('This suggestion uses an older or invalid source contract. Run Assist again before approving it.');
    }
    const validSources = (items: ProposalProvenance['sources']) => {
      const ids = new Set<string>();
      return items.every((item) => {
        const parsed = /^(\d+):([a-f0-9]{64})$/i.exec(item.sourceVersion);
        if (!item.sourceId || ids.has(item.sourceId) || !Number.isSafeInteger(item.revision) || item.revision < 0 ||
            !parsed || Number(parsed[1]) !== item.revision) return false;
        ids.add(item.sourceId);
        return true;
      });
    };
    if (!validSources(provenance.sources) || !validSources(provenance.policySources)) throw new Error('This suggestion has malformed source fingerprints. Run Assist again before approving it.');
    const note = this.note(state, proposal.noteId);
    if (provenance.noteId !== proposal.noteId || provenance.noteRevision !== proposal.sourceRevision || note.revision !== proposal.sourceRevision) {
      throw new Error('The source transcript changed. Run Assist again before approving or continuing this action.');
    }
    if (provenance.capturedAt !== (note.capturedAt ?? note.createdAt) || provenance.captureTimeZone !== (note.captureTimeZone || state.settings.timezone)) {
      throw new Error('The recording time anchor changed. Run Assist again before approving or continuing this action.');
    }
    if (provenance.settingsFingerprint !== JSON.stringify(state.settings)) throw new Error('Assistant settings changed. Run Assist again before approving or continuing this action.');
    if (provenance.answeredAsOf && !Number.isFinite(Date.parse(provenance.answeredAsOf))) throw new Error('This suggestion has an invalid question-time anchor. Run Assist again before approving it.');
    if (provenance.expiresAt && (!Number.isFinite(Date.parse(provenance.expiresAt)) || Date.now() >= Date.parse(provenance.expiresAt))) throw new Error('This answer-based suggestion expired at the next question-time window. Run Assist again before approving or continuing it.');
    const { documents, additionalSources } = assistContext(state, note, provenance.intent, provenance.question);
    const inputs: AssistantSourceInput[] = [
      { id: 'transcript', revision: note.revision, text: note.transcript, required: true, kind: 'note', title: 'Recorded transcript' },
      ...documents.map((document) => ({ id: `doc:${document.path}`, revision: document.revision, text: document.content, required: true, kind: 'document' as const, title: document.path, updatedAt: document.updatedAt })),
      ...additionalSources,
    ];
    const byId = new Map(inputs.map((source) => [source.id, source]));
    const selected = provenance.sources.map((expected) => {
      const source = byId.get(expected.sourceId);
      if (!source) throw new Error(`The source ${expected.sourceId} is no longer available. Run Assist again before approving this action.`);
      if (source.revision !== expected.revision) throw new Error(`The source ${expected.sourceId} changed. Run Assist again before approving this action.`);
      return source;
    });
    const policyInputs = state.documents.filter((document) => /^memory\/(RULES|ROUTINES)\.md$/i.test(document.path)).map((document) => ({
      id: `doc:${document.path}`, revision: document.revision, text: document.content, required: true, kind: 'document' as const,
      title: document.path, updatedAt: document.updatedAt,
    }));
    return { note, provenance, inputs: selected, policyInputs };
  }
  private proposalDependencyProjection(state: AppState, proposal: Proposal): string | undefined {
    try {
      const { note, provenance, inputs, policyInputs } = this.proposalDependencyInputs(state, proposal);
      return JSON.stringify({
        contractVersion: ASSIST_CONTRACT_VERSION, analysisFingerprint: provenance.analysisFingerprint,
        note: { id: note.id, revision: note.revision, capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: note.captureTimeZone },
        settings: state.settings, answeredAsOf: provenance.answeredAsOf ?? null,
        sources: inputs.map((source) => ({ id: source.id, revision: source.revision, text: source.text,
          versionMaterial: source.versionMaterial ?? null, required: source.required, kind: source.kind ?? null, title: source.title ?? null, updatedAt: source.updatedAt ?? null })),
        policySources: policyInputs.map((source) => ({ id: source.id, revision: source.revision, text: source.text, updatedAt: source.updatedAt ?? null })),
      });
    } catch { return undefined; }
  }
  private async validateProposalProvenance(state: AppState, proposal: Proposal): Promise<string> {
    const { inputs, policyInputs, provenance } = this.proposalDependencyInputs(state, proposal);
    const catalog = await createSourceCatalog(inputs, async (bytes) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
    const current = Object.fromEntries(catalog.sources.map((source) => [source.id, source.version]));
    const expected = Object.fromEntries(provenance.sources.map((source) => [source.sourceId, source.sourceVersion]));
    if (!sameSourceVersions(expected, current)) throw new Error('The source or selected context changed. Run Assist again before approving or continuing this action.');
    const policyCatalog = await createSourceCatalog(policyInputs, async (bytes) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
    const currentPolicy = Object.fromEntries(policyCatalog.sources.map((source) => [source.id, source.version]));
    const expectedPolicy = Object.fromEntries(provenance.policySources.map((source) => [source.sourceId, source.sourceVersion]));
    if (!sameSourceVersions(expectedPolicy, currentPolicy)) throw new Error('Rules or routines changed. Run Assist again before approving or continuing this action.');
    const projection = this.proposalDependencyProjection(state, proposal);
    if (!projection) throw new Error('The source context could not be verified. Run Assist again before approving this action.');
    return projection;
  }
  private invalidate(proposal: Proposal): void {
    proposal.revision += 1;
    proposal.approvedRevision = undefined;
    proposal.approvedPayloadDigest = undefined;
    proposal.lastError = undefined;
    if (proposal.status === 'approved' || proposal.status === 'failed') proposal.status = 'draft';
  }

  async checkProposalFreshness(id: string): Promise<{ current: boolean; reason?: string }> {
    let issue: string | undefined;
    return this.mutateIfChanged<{ current: boolean; reason?: string }>(async (state) => {
      const proposal = this.proposal(state, id);
      if (['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'].includes(proposal.status)) {
        return { changed: false, result: { current: true } };
      }
      try {
        await this.validateProposalProvenance(state, proposal);
        if (proposal.requiresRebuild) {
          proposal.requiresRebuild = false;
          issue = undefined;
          return { changed: true, result: { current: true } };
        }
        return { changed: false, result: { current: true } };
      } catch (error) {
        issue = error instanceof Error ? error.message : 'The saved suggestion source could not be verified.';
        const changed = proposal.status !== 'draft' || !proposal.requiresRebuild || Boolean(proposal.approvedPayloadDigest || proposal.approvedRevision !== undefined);
        if (!changed) return { changed: false, result: { current: false, reason: issue } };
        proposal.status = 'draft';
        proposal.requiresRebuild = true;
        proposal.approvedRevision = undefined;
        proposal.approvedPayloadDigest = undefined;
        proposal.dispatchDependencyProjection = undefined;
        proposal.lastError = issue;
        return { changed: true, result: { current: false, reason: issue } };
      }
    });
  }

  private rollUsage(state: AppState): void {
    const day = localDate(state.settings.timezone);
    if (state.usage.day !== day) { state.usage.day = day; state.usage.attemptsToday = 0; }
    const month = day.slice(0, 7);
    if (state.usage.month !== month) {
      state.usage.month = month; state.usage.requests = 0; state.usage.inputTokens = 0;
      state.usage.outputTokens = 0; state.usage.transcriptionSeconds = 0;
      state.usage.estimatedCostUsd = 0; state.usage.unknownCharges = 0; state.usage.reservedUsd = 0; state.usage.priceKnown = false;
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadInternal();
    try { await this.loadPromise; }
    finally { this.loadPromise = undefined; }
    if (this.state.pendingCredentialCleanup.length) void this.retryCredentialCleanup().catch(() => undefined);
  }

  private async loadInternal(): Promise<void> {
    const loaded = await this.store.load();
    this.state = loaded ? normalizeLoadedState(loaded) : initialState();
    for (const account of this.state.accounts) {
      this.state.syncStates[account.id] ??= emptySyncState(account.id);
      if (account.authStatus !== 'connected' || account.provider === 'local') continue;
      let token: StoredOAuthToken | null = null;
      try { token = account.tokenRef ? await this.integration.tokenStore?.get(account.tokenRef) ?? null : null; }
      catch { token = null; }
      if (!token || !sameAccountIdentity(token.identity, account.identity)) {
        account.authStatus = 'reauth_required';
        account.connected = false;
        account.connectionGeneration = (account.connectionGeneration ?? 0) + 1;
        account.syncStatus = 'error';
        account.capabilities = [];
        for (const calendar of this.state.calendars.filter((item) => item.accountId === account.id)) { calendar.connected = false; calendar.writable = false; }
        for (const proposal of this.state.proposals.filter((item) => item.accountId === account.id && ['draft', 'approved', 'failed'].includes(item.status))) {
          this.invalidate(proposal);
          proposal.status = 'draft';
        }
        addActivity(this.state, 'error', `${account.displayName || account.email} needs to reconnect before account actions can continue.`);
      }
    }
    for (const record of this.state.dispatchRecords) {
      if (record.outcome === 'pending') {
        try {
          const unknownAt = new Date(Math.max(Date.now(), Date.parse(record.dispatchStartedAt))).toISOString();
          const unknown = recordDispatchOutcome(record, { outcome: 'unknown', at: unknownAt });
          this.state.dispatchRecords[this.state.dispatchRecords.findIndex((item) => item.id === record.id)] = unknown;
        } catch { /* Keep malformed history read-only; never infer an accepted result. */ }
      }
    }
    for (const proposal of this.state.proposals) {
      if (proposal.dispatchRecordId) {
        const record = this.state.dispatchRecords.find((item) => item.id === proposal.dispatchRecordId);
        if (record && proposal.status === 'dispatching') {
          proposal.status = record.outcome === 'accepted' ? 'accepted' : record.outcome === 'rejected' ? 'failed' : 'unknown';
          proposal.remoteOperation = record.operation;
          proposal.remoteId = record.remoteId;
          if (record.outcome === 'accepted') proposal.remoteAcceptedAt = record.outcomeAt;
          proposal.lastError = record.outcome === 'unknown' ? 'App closed while this external action was in progress. Check the destination manually; this action will not be retried.' : undefined;
        }
      } else if (proposal.status === 'dispatching') {
        const remote = proposal.kind === 'email' || proposal.kind === 'event';
        proposal.status = remote ? 'unknown' : 'failed';
        proposal.dispatchHistoryIncomplete = remote;
        proposal.approvedPayloadDigest = undefined;
        proposal.lastError = remote
          ? 'App closed while this legacy external action was in progress. Its exact provider payload was not captured; do not retry automatically.'
          : 'App closed before this local action was confirmed. Review before trying again.';
      }
    }
    ensureMemoryDocuments(this.state);
    ensurePeriodDocuments(this.state);
    if (!loaded || JSON.stringify(this.state) !== JSON.stringify(loaded)) await this.store.save(this.state);
    this.snapshot = deepFreeze(clone(this.state));
    this.loaded = true;
    this.emit();
    for (const document of this.state.documents) this.mirrorDirty.add(document.path);
    await this.retryDocumentMirrors();
  }

  async saveNote(input: SaveNoteInput): Promise<Note> {
    const transcript = input.transcript.trim();
    if (!transcript && !input.audioUri) throw new Error('Add a transcript or an audio recording first.');
    const result = await this.mutate((state) => {
      const capturedDate = input.capturedAt ? new Date(input.capturedAt) : new Date();
      if (!Number.isFinite(capturedDate.getTime())) throw new Error('Recording start time is invalid.');
      const note: Note = {
        id: newId(), title: transcript ? transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72) : 'Audio note',
        transcript, ...(input.audioUri ? { audioUri: input.audioUri } : {}),
        durationSeconds: Math.max(0, Math.round(input.durationSeconds ?? 0)), createdAt: now(), capturedAt: capturedDate.toISOString(), captureTimeZone: validTimezone(input.captureTimeZone ?? state.settings.timezone), status: 'recorded', revision: 1,
      };
      state.notes.unshift(note);
      addActivity(state, 'note_saved', transcript ? 'Transcript saved on this device.' : 'Audio saved. No transcript has been created yet.', { noteId: note.id });
      const docs = [...ensureMemoryDocuments(state), ...recordJournal(state, `note:${note.id}:r${note.revision}`, `Saved note ${note.title} (note ID ${note.id}, transcript revision ${note.revision}).`), ...ensurePeriodDocuments(state)];
      return { note, docs };
    });
    await Promise.all(result.docs.map((document) => this.mirrorDocument(document)));
    return result.note;
  }

  async updateTranscript(id: string, text: string): Promise<Note> {
    const result = await this.mutate((state) => {
      const note = this.note(state, id);
      note.transcript = text.trim();
      note.title = note.transcript ? note.transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72) : 'Audio note';
      note.revision += 1;
      delete note.processingFingerprint;
      note.status = 'recorded';
      for (const proposal of state.proposals.filter((item) => item.noteId === id)) {
        if (['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'].includes(proposal.status)) continue;
        this.invalidate(proposal);
        proposal.status = 'draft';
        // Keep sourceRevision unchanged. This intentionally blocks approval until reprocessing.
      }
      if (note.analysis) note.analysis.stale = true;
      addActivity(state, 'note_saved', 'Transcript edited. Earlier approvals were cleared.', { noteId: id });
      return note;
    });
    return result;
  }

  async processNote(id: string): Promise<Proposal[]> {
    const existing = this.processJobs.get(id);
    if (existing) return existing;
    const job = this.assistNote(id, { intent: 'assist' }).then((analysis) => {
      const state = this.snapshot;
      const known = new Set(analysis.proposalIds);
      return state.proposals.filter((proposal) => known.has(proposal.id) && proposal.status === 'draft');
    }).finally(() => this.processJobs.delete(id));
    this.processJobs.set(id, job);
    return job;
  }

  async refreshAnalysisStatus(noteId: string): Promise<NoteAssistResult | undefined> {
    await this.load();
    return this.mutateIfChanged(async (state) => {
      const note = state.notes.find((item) => item.id === noteId);
      if (!note?.analysis) return { changed: false, result: undefined };
      const analysis = note.analysis;
      const boundFingerprint = analysis.fingerprint;
      const boundSourceRevision = analysis.sourceRevision;
      const { documents, additionalSources, omittedSourceCount, omittedSourceIds } = assistContext(state, note, analysis.intent, analysis.question);
      const request = {
        intent: analysis.intent, question: analysis.question,
        ...(analysis.answeredAsOf ? { queryTimeAnchor: analysis.answeredAsOf, queryTimeZone: analysis.answerTimeZone ?? state.settings.timezone } : {}),
        additionalSources, preselection: { omittedSourceCount, omittedSourceIds },
      };
      let currentVersions: Record<string, string>;
      if (state.settings.mode === 'provider' && analysis.source === 'provider') {
        currentVersions = (await this.openAiClient.prepare(note, documents, state.settings, request)).sourceVersions;
      } else {
        const calendarAvailable = state.calendars.some((calendar) => {
          const account = state.accounts.find((item) => item.id === calendar.accountId);
          const sync = state.syncStates[calendar.accountId];
          return Boolean(account?.connected && account.authStatus === 'connected' && calendar.connected && sync?.calendarsCompletedAt && sync.eventsCompletedAt[calendar.id]);
        });
        const offlineInputs = offlineAssistInputs(note, analysis.intent, analysis.question, additionalSources, calendarAvailable);
        const catalog = await createSourceCatalog(
          offlineInputs,
          async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)),
        );
        currentVersions = Object.fromEntries(catalog.sources.map((source) => [source.id, source.version]));
      }
      // The serialized transaction binds this result to the exact analysis whose sources were hashed.
      if (note.analysis?.fingerprint !== boundFingerprint || note.analysis?.sourceRevision !== boundSourceRevision) {
        return { changed: false, result: note.analysis };
      }
      let priorFingerprint: { settings?: AppSettings; contractVersion?: string } | undefined;
      try { priorFingerprint = JSON.parse(analysis.fingerprint) as { settings?: AppSettings; contractVersion?: string }; } catch { priorFingerprint = undefined; }
      const settingsChanged = !priorFingerprint?.settings || JSON.stringify(priorFingerprint.settings) !== JSON.stringify(state.settings) ||
        priorFingerprint.contractVersion !== ASSIST_CONTRACT_VERSION ||
        (analysis.source === 'provider') !== (state.settings.mode === 'provider');
      const answerWindowExpired = Boolean(analysis.answeredAsOf &&
        Math.floor(Date.now() / 900_000) !== Math.floor(Date.parse(analysis.answeredAsOf) / 900_000));
      const stale = analysis.sourceRevision !== note.revision || settingsChanged || answerWindowExpired || !sameSourceVersions(analysis.sourceVersions, currentVersions);
      if (Boolean(analysis.stale) === stale) return { changed: false, result: analysis };
      analysis.stale = stale;
      return { changed: true, result: analysis };
    });
  }

  async assistNote(id: string, options: { intent?: AssistIntent; question?: string; forceRefresh?: boolean } = {}): Promise<NoteAssistResult> {
    const intent = options.intent ?? 'assist';
    const question = options.question?.trim() || undefined;
    const requestedAt = new Date();
    const queryBucket = intent === 'answer' && question ? Math.floor(requestedAt.getTime() / 900_000) : '';
    const key = JSON.stringify([id, intent, question, queryBucket, Boolean(options.forceRefresh)]);
    const existing = this.assistJobs.get(key);
    if (existing) return existing;
    const job = this.runAssistNote(id, { ...options, intent, question }, requestedAt).finally(() => this.assistJobs.delete(key));
    this.assistJobs.set(key, job);
    return job;
  }

  private async runAssistNote(id: string, options: { intent?: AssistIntent; question?: string; forceRefresh?: boolean } = {}, requestedAt = new Date()): Promise<NoteAssistResult> {
    const intent = options.intent ?? 'assist';
    const question = options.question?.trim() || undefined;
    if (!['assist', 'summarize', 'answer', 'extract'].includes(intent)) throw new Error('Choose a supported assist action.');
    if (intent === 'answer' && !question) throw new Error('Add a question before asking about this note.');
    const state = this.snapshot;
    const note = state.notes.find((item) => item.id === id);
    if (!note) throw new Error('Note was not found.');
    if (!note.transcript.trim()) throw new Error('This audio note has no transcript. Enter text or connect the speech provider before processing.');
    const sourceRevision = note.revision;
    const { documents: contextDocs, additionalSources: localSources, omittedSourceCount, omittedSourceIds } = assistContext(state, note, intent, question);
    const capturedAt = note.capturedAt ?? note.createdAt;
    const answeredAsOf = intent === 'answer' && question ? requestedAt.toISOString() : undefined;
    const queryBucket = answeredAsOf ? Math.floor(requestedAt.getTime() / 900_000) : undefined;
    const request = { intent, question, ...(answeredAsOf ? { queryTimeAnchor: answeredAsOf, queryTimeZone: state.settings.timezone } : {}), additionalSources: localSources, preselection: { omittedSourceCount, omittedSourceIds } };
    const prepared = state.settings.mode === 'provider' ? await this.openAiClient.prepare(note, contextDocs, state.settings, request) : undefined;
    const transcriptVersion = `${note.revision}:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, note.transcript.replace(/\r\n?/g, '\n').normalize('NFC'))}`;
    const hasCompleteCalendar = state.calendars.some((calendar) => {
      const account = state.accounts.find((item) => item.id === calendar.accountId);
      const sync = state.syncStates[calendar.accountId];
      return Boolean(account?.connected && account.authStatus === 'connected' && calendar.connected && sync?.calendarsCompletedAt && sync.eventsCompletedAt[calendar.id]);
    });
    const verifiedEvents = state.calendarEvents.filter((event) => {
      const calendar = state.calendars.find((item) => item.id === event.calendarId);
      const account = state.accounts.find((item) => item.id === event.accountId);
      return Boolean(calendar?.connected && account?.connected && account.authStatus === 'connected' && identityKey(account));
    });
    const offlineInputs = offlineAssistInputs(note, intent, question, localSources, hasCompleteCalendar);
    const offlineCatalog = state.settings.mode === 'preview' ? await createSourceCatalog(offlineInputs,
      async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes))) : undefined;
    const sourceVersions = prepared?.sourceVersions ?? Object.fromEntries(offlineCatalog?.sources.map((source) => [source.id, source.version]) ?? [['transcript', transcriptVersion]]);
    const processingFingerprint = JSON.stringify({ contractVersion: ASSIST_CONTRACT_VERSION, transcript: note.transcript, sourceRevision, sources: sourceVersions, settings: state.settings, intent, question,
      capturedAt, captureTimeZone: note.captureTimeZone || state.settings.timezone,
      ...(answeredAsOf ? { queryBucket, queryTimeZone: state.settings.timezone } : {}),
    });
    if (!options.forceRefresh && note.analysis?.fingerprint === processingFingerprint) return clone(note.analysis);
    let generated: DraftAnalysis;
    if (state.settings.mode === 'provider') {
      generated = (options.forceRefresh ? undefined : this.analysisCache.get(processingFingerprint)) ?? await this.openAiClient.analyze(note, contextDocs, state.settings, undefined, () => this.recordProviderAttempt('model', state.settings), request, prepared);
      if (options.forceRefresh || !this.analysisCache.has(processingFingerprint)) {
        await this.settleModelUsage(generated, state.settings);
        this.analysisCache.set(processingFingerprint, generated);
      }
      if (this.snapshot.notes.find((item) => item.id === id)?.revision !== sourceRevision) throw new Error('The transcript changed during processing. The provider result was discarded.');
    } else {
      const proposals = extractPreviewProposals(note);
      const preview = buildOfflinePreview({ intent, transcript: note.transcript, question, timeZone: answeredAsOf ? state.settings.timezone : note.captureTimeZone || state.settings.timezone, now: answeredAsOf ?? capturedAt, transcriptRevision: note.revision, transcriptSourceVersion: transcriptVersion,
        ...(intent === 'answer' ? { tasks: state.tasks.map(({ title, status, dueAt }) => ({ title, status, dueAt })), calendarEvents: verifiedEvents.map(({ subject, start, timeZone }) => ({ subject, start, timeZone })), calendarSnapshotAvailable: hasCompleteCalendar } : {}),
      });
      const offlineIncludedIds = offlineInputs.map((source) => source.id);
      generated = {
        summary: preview.summary, answer: preview.answer, decisions: preview.decisions, citations: preview.citations,
        clarifications: preview.clarifications, proposals: proposals.map(({ kind, title, body, recipients, dueAt, evidence }) => ({ kind, title, body, recipients, dueAt, evidence })),
        includedSourceIds: offlineIncludedIds,
        includedSources: offlineIncludedIds.map((sourceId) => {
          const input = sourceId === 'transcript' ? { title: 'Recorded transcript', text: note.transcript } : localSources.find((source) => source.id === sourceId)!;
          return { id: sourceId, title: input.title ?? sourceId, excerpt: input.text };
        }),
        omittedSourceIds: [], omittedSourceCount: 0, sourceVersions, inputTokens: 0, outputTokens: 0, attempts: 0, usageEstimated: true,
      };
    }
    const policyInputs = state.documents.filter((document) => /^memory\/(RULES|ROUTINES)\.md$/i.test(document.path)).map((document) => ({
      id: `doc:${document.path}`, revision: document.revision, text: document.content, required: true, kind: 'document' as const,
      title: document.path, updatedAt: document.updatedAt,
    }));
    const policyCatalog = await createSourceCatalog(policyInputs, async (bytes) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
    const policySources = policyCatalog.sources.map((source) => ({ sourceId: source.id, revision: source.revision, sourceVersion: source.version }));
    const created: Proposal[] = generated.proposals.map((draft) => ({
      id: newId(), noteId: note.id, ...draft, status: 'draft', revision: 1,
      recipients: [...draft.recipients], sourceRevision: note.revision, evidence: draft.evidence.map((item) => ({ ...item })),
      sourceActionKey: sourceActionKey(note, draft.kind, draft.evidence),
      provenance: createProposalProvenance({ analysisFingerprint: processingFingerprint, note, intent, question, sourceVersions: generated.sourceVersions, policySources, settings: state.settings, answeredAsOf }),
      requiresRebuild: false,
    }));

    const result = await this.mutate(async (draft) => {
      const current = this.note(draft, id);
      if (current.revision !== sourceRevision) throw new Error('The transcript changed during processing. Process the updated note again.');
      let stale = JSON.stringify(draft.settings) !== JSON.stringify(state.settings);
      try {
        const currentContext = assistContext(draft, current, intent, question);
        let currentVersions: Record<string, string>;
        if (draft.settings.mode === 'provider') {
          const currentRequest = { intent, question, ...(answeredAsOf ? { queryTimeAnchor: answeredAsOf, queryTimeZone: state.settings.timezone } : {}), additionalSources: currentContext.additionalSources, preselection: { omittedSourceCount: currentContext.omittedSourceCount, omittedSourceIds: currentContext.omittedSourceIds } };
          currentVersions = (await this.openAiClient.prepare(current, currentContext.documents, draft.settings, currentRequest)).sourceVersions;
        } else {
          const calendarAvailable = draft.calendars.some((calendar) => {
            const account = draft.accounts.find((item) => item.id === calendar.accountId);
            const sync = draft.syncStates[calendar.accountId];
            return Boolean(account?.connected && account.authStatus === 'connected' && calendar.connected && sync?.calendarsCompletedAt && sync.eventsCompletedAt[calendar.id]);
          });
          const localInputs = offlineAssistInputs(current, intent, question, currentContext.additionalSources, calendarAvailable);
          const catalog = await createSourceCatalog(localInputs, async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
          currentVersions = Object.fromEntries(catalog.sources.map((source) => [source.id, source.version]));
        }
        stale ||= !sameSourceVersions(generated.sourceVersions, currentVersions);
      } catch {
        stale = true;
      }
      if (stale) {
        const analysis: NoteAssistResult = {
          noteId: id, sourceRevision, intent, ...(question ? { question } : {}), fingerprint: processingFingerprint,
          analyzedAt: now(), capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: note.captureTimeZone || state.settings.timezone,
          ...(answeredAsOf ? { answeredAsOf, answerTimeZone: state.settings.timezone } : {}),
          summary: generated.summary, answer: generated.answer, decisions: generated.decisions, citations: generated.citations,
          clarifications: [...generated.clarifications, 'Local context changed while this response was being prepared. Refresh the analysis to use the current sources.'],
          proposalIds: [], source: state.settings.mode === 'provider' ? 'provider' : 'offline_preview',
          includedSourceIds: generated.includedSourceIds, includedSources: generated.includedSources, omittedSourceIds: generated.omittedSourceIds, omittedSourceCount: generated.omittedSourceCount,
          sourceVersions: generated.sourceVersions, stale: true,
        };
        current.status = 'processed'; current.processingFingerprint = processingFingerprint; current.analysis = analysis;
        addActivity(draft, 'error', 'Assist response retained as stale because local context changed during processing. No proposals were created.', { noteId: id });
        return { proposals: [] as Proposal[], analysis, docs: [] as ContextDocument[] };
      }
      const existingByAction = new Map(draft.proposals.filter((proposal) => proposal.noteId === id && proposal.sourceActionKey)
        .map((proposal) => [proposal.sourceActionKey!, proposal]));
      const selected: Proposal[] = [];
      const terminalStatuses = ['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'];
      for (const proposal of created) {
        const existing = existingByAction.get(proposal.sourceActionKey!);
        if (!existing || terminalStatuses.includes(existing.status)) {
          selected.push(existing ?? proposal);
        } else if (!existing.requiresRebuild && existing.provenance?.analysisFingerprint === processingFingerprint) {
          selected.push(existing);
        } else {
          selected.push({ ...proposal, id: existing.id, revision: existing.revision + 1,
            approvedRevision: undefined, approvedPayloadDigest: undefined, lastError: undefined });
        }
      }
      const selectedIds = new Set(selected.map((proposal) => proposal.id));
      draft.proposals = [
        ...selected,
        ...draft.proposals.filter((proposal) => proposal.noteId !== id || (!selectedIds.has(proposal.id) && proposal.status !== 'draft')),
      ];
      current.status = 'processed';
      current.processingFingerprint = processingFingerprint;
      const analysis: NoteAssistResult = {
        noteId: id, sourceRevision, intent, ...(question ? { question } : {}), fingerprint: processingFingerprint,
        analyzedAt: now(), capturedAt: note.capturedAt ?? note.createdAt, captureTimeZone: note.captureTimeZone || state.settings.timezone, ...(answeredAsOf ? { answeredAsOf, answerTimeZone: state.settings.timezone } : {}),
        summary: generated.summary, answer: generated.answer, decisions: generated.decisions, citations: generated.citations,
        clarifications: generated.clarifications, proposalIds: selected.map((proposal) => proposal.id),
        source: state.settings.mode === 'provider' ? 'provider' : 'offline_preview',
        includedSourceIds: generated.includedSourceIds, includedSources: generated.includedSources, omittedSourceIds: generated.omittedSourceIds, omittedSourceCount: generated.omittedSourceCount, sourceVersions: generated.sourceVersions,
      };
      current.analysis = analysis;
      const docs = [
        ...recordJournal(draft, `processed:${id}:r${sourceRevision}`, `Processed note ${current.title}; ${created.length} review suggestion(s) created.`),
        ...created.filter((proposal) => !existingByAction.has(proposal.sourceActionKey!)).map((proposal) => appendInference(draft, proposal, state.settings.mode)),
      ];
      addActivity(draft, 'proposal_created', state.settings.mode === 'provider'
        ? `Azure OpenAI assisted with this recorded note and drafted ${created.length} review suggestion${created.length === 1 ? '' : 's'}.`
        : `Preview mode extracted ${created.length} suggestion${created.length === 1 ? '' : 's'} from your transcript. No provider was contacted.`, { noteId: id });
      return { proposals: selected, analysis, docs };
    });
    await Promise.all(result.docs.map((document) => this.mirrorDocument(document)));
    return result.analysis;
  }

  private providerReserve(settings: AppSettings, kind: 'model' | 'speech'): number {
    if (kind === 'model') {
      if (settings.inputUsdPerMillionTokens === undefined || settings.outputUsdPerMillionTokens === undefined) return 0;
      return (settings.maxRequestBytes + 256) * settings.inputUsdPerMillionTokens / 1_000_000 + settings.maxOutputTokens * settings.outputUsdPerMillionTokens / 1_000_000;
    }
    if (settings.speechUsdPerMinute === undefined) return 0;
    return settings.maxAudioSeconds / 60 * settings.speechUsdPerMinute;
  }

  private async recordProviderAttempt(kind: 'model' | 'speech', requestSettings: AppSettings): Promise<void> {
    await this.mutate((state) => {
      this.rollUsage(state);
      if (state.usage.attemptsToday >= state.settings.maxCallsPerDay) throw new Error('Daily provider call limit reached. Try again tomorrow or adjust the limit in Settings.');
      const reserve = this.providerReserve(requestSettings, kind);
      const knownRates = kind === 'model'
        ? requestSettings.inputUsdPerMillionTokens !== undefined && requestSettings.outputUsdPerMillionTokens !== undefined
        : requestSettings.speechUsdPerMinute !== undefined;
      if (knownRates && (state.settings.monthlyBudgetUsd === 0 || state.usage.estimatedCostUsd + state.usage.reservedUsd + reserve > state.settings.monthlyBudgetUsd)) throw new Error('The configured monthly estimate limit does not have room for this bounded provider request.');
      state.usage.reservedUsd += reserve;
      state.usage.attemptsToday += 1;
      state.usage.attempts += 1;
      state.usage.unknownCharges += 1;
      state.usage.lastRequestAt = now();
    });
  }

  private async settleModelUsage(usage: DraftAnalysis, requestSettings: AppSettings): Promise<void> {
    await this.mutate((state) => {
      this.rollUsage(state);
      state.usage.requests += 1;
      state.usage.inputTokens += usage.inputTokens;
      state.usage.outputTokens += usage.outputTokens;
      state.usage.lastRequestAt = now();
      const ratesKnown = !usage.usageEstimated && requestSettings.inputUsdPerMillionTokens !== undefined && requestSettings.outputUsdPerMillionTokens !== undefined;
      if (ratesKnown) {
        state.usage.reservedUsd = Math.max(0, state.usage.reservedUsd - this.providerReserve(requestSettings, 'model'));
        state.usage.estimatedCostUsd += usage.inputTokens * requestSettings.inputUsdPerMillionTokens! / 1_000_000 + usage.outputTokens * requestSettings.outputUsdPerMillionTokens! / 1_000_000;
        // Settle only the final successful attempt; earlier retry attempts remain unknown charges.
        state.usage.unknownCharges = Math.max(0, state.usage.unknownCharges - 1);
      }
      state.usage.priceKnown = state.usage.unknownCharges === 0 && ratesKnown;
    });
  }

  private async settleSpeechUsage(seconds: number, requestSettings: AppSettings): Promise<void> {
    await this.mutate((state) => {
      this.rollUsage(state);
      state.usage.requests += 1;
      state.usage.transcriptionSeconds += seconds;
      state.usage.lastRequestAt = now();
      const rate = requestSettings.speechUsdPerMinute;
      if (rate !== undefined) {
        state.usage.reservedUsd = Math.max(0, state.usage.reservedUsd - this.providerReserve(requestSettings, 'speech'));
        state.usage.estimatedCostUsd += seconds / 60 * rate;
        state.usage.unknownCharges = Math.max(0, state.usage.unknownCharges - 1);
      }
      state.usage.priceKnown = state.usage.unknownCharges === 0 && rate !== undefined;
    });
  }

  async transcribeNote(id: string): Promise<Note> {
    const state = this.snapshot;
    const note = state.notes.find((item) => item.id === id);
    if (!note) throw new Error('Note was not found.');
    const sourceRevision = note.revision;
    if (state.settings.mode !== 'provider') throw new Error('Select Provider mode and configure Azure Speech before transcribing.');
    if (state.usage.priceKnown && state.usage.estimatedCostUsd >= state.settings.monthlyBudgetUsd) throw new Error('The configured monthly estimate limit has been reached.');
    const result = await this.speechClient.transcribe(note, state.settings, undefined, () => this.recordProviderAttempt('speech', state.settings));
    await this.settleSpeechUsage(result.durationSeconds, state.settings);
    const updated = await this.mutate(async (draft) => {
      const current = this.note(draft, id);
      if (current.revision !== sourceRevision) throw new Error('The transcript changed during transcription. The provider result was discarded.');
      current.transcript = result.transcript;
      current.title = result.transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72);
      current.revision += 1;
      current.durationSeconds = result.durationSeconds;
      current.status = 'recorded';
      for (const proposal of draft.proposals.filter((item) => item.noteId === id)) {
        if (['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'].includes(proposal.status)) continue;
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      addActivity(draft, 'local_action', 'Audio transcribed by Azure Speech and saved to the note.', { noteId: id });
      return current;
    });
    if (state.settings.audioRetention === 'delete_after_transcription' && note.audioUri) {
      try {
        await removeAudio(note.audioUri);
        return await this.mutate((draft) => {
          const current = this.note(draft, id);
          delete current.audioUri;
          addActivity(draft, 'local_action', 'Original recording deleted after transcription, as configured.', { noteId: id });
          return current;
        });
      } catch {
        return updated;
      }
    }
    return updated;
  }

  async editProposal(id: string, patch: ProposalPatch): Promise<Proposal> {
    const priorReminder = this.snapshot.proposals.find((item) => item.id === id);
    const result = await this.mutate((state) => {
      const proposal = this.proposal(state, id);
      if (['executed', 'accepted', 'simulated', 'dispatching', 'unknown', 'dismissed'].includes(proposal.status)) throw new Error('This proposal can no longer be edited.');
      Object.assign(proposal, patch);
      proposal.recipients = [...new Set((proposal.recipients ?? []).map((recipient) => recipient.trim()).filter(Boolean))];
      this.invalidate(proposal);
      proposal.status = 'draft';
      addActivity(state, 'proposal_created', 'Suggestion edited. Review and approve the updated details.', { proposalId: id, noteId: proposal.noteId });
      return proposal;
    });
    if (priorReminder?.kind === 'reminder') {
      await cancelReminderNotification({ id, revision: priorReminder.notificationRevision ?? priorReminder.revision });
    }
    return result;
  }

  async approveProposal(id: string): Promise<Proposal> {
    const result = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (proposal.status !== 'draft' && proposal.status !== 'failed') throw new Error('Only a draft or safely failed proposal can be approved.');
      const note = this.note(state, proposal.noteId);
      if (proposal.sourceRevision !== note.revision) throw new Error('The source transcript changed. Process the note again before approving.');
      await this.validateProposalProvenance(state, proposal);
      if (!proposal.title.trim() || !proposal.body.trim()) throw new Error('A title and proposed content are required.');
      if (proposal.kind === 'email') {
        if (!proposal.accountId || !(proposal.email?.to.length || proposal.recipients.length)) throw new Error('Choose an account and at least one recipient before approving this email.');
        if (!proposal.email?.operation) throw new Error('Choose Draft in mailbox or Send email before approving this email.');
        if (!state.accounts.some((item) => item.id === proposal.accountId)) throw new Error('The selected account configuration was not found.');
        const email = proposal.email ?? { to: proposal.recipients, cc: [], bcc: [], subject: proposal.title, text: proposal.body, attachments: [] };
        const addresses = [...email.to, ...email.cc, ...email.bcc];
        if (!addresses.length || addresses.some((recipient) => !validEmail(recipient))) throw new Error('Check each recipient email address.');
        if (/[\r\n]/.test(email.subject)) throw new Error('Email subject cannot contain line breaks.');
        for (const attachment of email.attachments) {
          if (!attachment.id.trim() || /[\r\n]/.test(attachment.id) || !attachment.fileName.trim() || /[\r\n]/.test(attachment.fileName) || !/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) || !Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes <= 0 || !/^[a-f\d]{64}$/i.test(attachment.sha256)) {
            throw new Error('Email attachment metadata is incomplete or invalid.');
          }
        }
      }
      if (proposal.kind === 'event') {
        if (!proposal.calendarId) throw new Error('Choose a calendar before approving this event.');
        const calendar = state.calendars.find((item) => item.id === proposal.calendarId);
        if (!calendar || calendar.accountId !== proposal.accountId) throw new Error('The selected calendar does not belong to the selected account.');
        if (!proposal.event) throw new Error('Complete the event date, time zone, attendees, and invite policy before approving.');
        if (proposal.event) {
          const start = Date.parse(proposal.event.start);
          const end = Date.parse(proposal.event.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Event end must be later than its start.');
          try { new Intl.DateTimeFormat('en-US', { timeZone: proposal.event.timeZone }).format(); }
          catch { throw new Error('Choose a valid event time zone.'); }
          if (!['send', 'none'].includes(proposal.event.invitePolicy) || proposal.event.attendees.some((attendee) => !validEmail(attendee))) throw new Error('Check the event invite policy and attendee addresses.');
          const title = proposal.event.title?.trim() || proposal.title;
          if (!title || /[\r\n]/.test(title)) throw new Error('Event title is required and cannot contain line breaks.');
          proposal.event = { ...proposal.event, title, description: proposal.event.description ?? proposal.body };
        }
      }
      if (proposal.kind === 'reminder' && proposal.dueAt && !Number.isFinite(Date.parse(proposal.dueAt))) throw new Error('Enter a valid reminder date and time.');
      proposal.status = 'approved';
      proposal.approvedRevision = proposal.revision;
      proposal.approvedPayloadDigest = await approvedDigest(proposal, state);
      const decision = appendDecision(state, proposal);
      addActivity(state, 'proposal_approved', 'Suggestion approved with its current source, content, account, and destination details.', { proposalId: id, noteId: proposal.noteId });
      return { proposal, decision };
    });
    await this.mirrorDocument(result.decision);
    return result.proposal;
  }

  async executeProposal(id: string): Promise<Proposal> {
    const claim = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (proposal.status !== 'approved' || proposal.approvedRevision !== proposal.revision || !proposal.approvedPayloadDigest) throw new Error('Approve this exact version before continuing.');
      let dependencyProjection: string;
      try { dependencyProjection = await this.validateProposalProvenance(state, proposal); }
      catch (error) {
        this.invalidate(proposal);
        proposal.status = 'draft';
        proposal.requiresRebuild = true;
        addActivity(state, 'error', 'An approved suggestion was invalidated because its source context changed. Run Assist again before reviewing it.', { proposalId: proposal.id, noteId: proposal.noteId });
        return { proposal, dependencyProjection: '', invalidated: error instanceof Error ? error.message : 'The source context changed.' };
      }
      if (proposal.kind === 'reminder') {
        if (!proposal.dueAt) throw new Error('Add a date and time before saving this reminder.');
        if (Date.parse(proposal.dueAt) <= Date.now()) throw new Error('Reminder time must be in the future.');
      }
      if (await approvedDigest(proposal, state) !== proposal.approvedPayloadDigest) throw new Error('The approved content or destination changed. Review and approve it again.');
      if (proposal.kind === 'event' && !proposal.eventTransactionId) proposal.eventTransactionId = newId();
      const operation = proposal.kind === 'email' ? proposal.email?.operation : proposal.kind === 'event' ? 'event' : undefined;
      const account = proposal.accountId ? state.accounts.find((item) => item.id === proposal.accountId) : undefined;
      const capability = operation === 'draft' ? 'mail.draft' : operation === 'send' ? 'mail.send' : operation === 'event' ? 'calendar.write' : undefined;
      const calendar = proposal.kind === 'event' ? state.calendars.find((item) => item.id === proposal.calendarId) : undefined;
      const canDispatch = (proposal.kind === 'email' || proposal.kind === 'event') && state.settings.mode === 'provider' && Boolean(this.connector && account && account.connected && account.authStatus === 'connected' && capability && account.capabilities?.includes(capability)) &&
        (proposal.kind !== 'event' || Boolean(calendar && calendar.accountId === account?.id && calendar.connected && calendar.writable && calendar.providerId));
      proposal.status = 'dispatching';
      let dispatchRecord: DispatchRecord | undefined;
      if (canDispatch && account) {
        if (state.dispatchRecordQuarantine.length) throw new Error('Dispatch history failed integrity validation. External writes are disabled until the receipt history is repaired.');
        dispatchRecord = createDispatchRecord({ id: newId(), dispatchStartedAt: now(), proposal, account, calendar });
        assertNoDuplicateDispatch(state, dispatchRecord);
        state.dispatchRecords.unshift(dispatchRecord);
        proposal.dispatchRecordId = dispatchRecord.id;
      }
      return { proposal, dependencyProjection, dispatchRecord, capturedAccount: canDispatch && account ? account : undefined };
    });
    if ('invalidated' in claim) throw new Error(claim.invalidated);
    const claimed = claim.proposal;
    const approvedDependencyProjection = claim.dependencyProjection;
    const frozenRecord = claim.dispatchRecord;

    let result: ProposalStatusOutcome;
    if (claimed.kind === 'reminder') {
      const alert = await requestReminderNotification(claimed, undefined, undefined, () =>
        this.proposalDependencyProjection(this.snapshot, claimed) === approvedDependencyProjection);
      result = alert.status === 'blocked' || alert.status === 'expired'
        ? { status: 'failed', message: alert.status === 'expired' ? 'Reminder time passed while alert permission was being checked. Review and approve a future time.' : 'The reminder source context changed before scheduling. Run Assist again and review the suggestion.' }
        : { status: 'executed', notificationId: alert.status === 'scheduled' ? alert.notificationId : undefined, message: alert.status === 'scheduled'
          ? 'Reminder saved locally and an alert was scheduled on this device.'
          : alert.status === 'unavailable'
            ? 'Reminder saved locally. This browser does not provide alerts after its tab is closed.'
            : 'Reminder saved locally; alerts are disabled on this device.' };
    } else if (claimed.kind === 'task') {
      result = { status: 'executed', message: 'Task saved locally on this device.' };
    } else if (claimed.kind === 'memory') {
      try {
        const document = await this.mutate((state) => {
          if (this.proposalDependencyProjection(state, claimed) !== approvedDependencyProjection) throw new Error('The memory source context changed before it was saved. Run Assist again and review the suggestion.');
          const path = 'memory/PROFILE.md';
          const existing = state.documents.find((doc) => doc.path === path);
          const marker = `<!-- proposal:${claimed.id} -->`;
          if (existing?.content.includes(marker)) return existing;
          const content = `${existing?.content?.trim() ?? '# Profile\n'}\n${marker}\n- ${claimed.body.trim()}\n`;
          const next = upsertDocument(state, path, content);
          return next;
        });
        await this.mirrorDocument(document);
        result = { status: 'executed', message: 'Memory saved to the local profile documents.' };
      } catch (error) {
        result = { status: 'failed', message: error instanceof Error ? error.message : 'Could not write the local memory.' };
      }
    } else {
      if (!frozenRecord || !this.connector || !claim.capturedAccount) {
        result = { status: 'simulated', message: `Simulation only: this ${claimed.kind === 'email' ? 'email' : 'calendar event'} was not sent or created in an external account because provider mode, verified identity, and the selected permission are required.` };
      } else {
        const account = claim.capturedAccount;
        const record = frozenRecord;
        const operation = record.operation;
        const envelope: ApprovedDispatch = {
          proposalId: record.proposalId, revision: record.approvedRevision, sourceRevision: record.sourceRevision, operation,
          accountId: record.accountId, identity: clone(record.account.identity), payloadDigest: record.payloadDigest,
          title: record.title, body: record.body, calendarId: record.calendar?.providerId,
          payload: record.payload.kind === 'email'
            ? { ...clone(record.payload.email), operation: record.operation === 'draft' || record.operation === 'send' ? record.operation : undefined }
            : clone(record.payload.event),
        };
        const matchesFrozenPayload = (proposal: Proposal) => stableJson(proposal.kind === 'email'
          ? proposal.email
          : proposal.kind === 'event'
            ? { ...proposal.event, title: proposal.event?.title ?? proposal.title, description: proposal.event?.description ?? proposal.body }
            : null) === stableJson(envelope.payload);
        const recordIsCurrent = (state: AppState, proposal: Proposal) => {
          const persisted = state.dispatchRecords.find((item) => item.id === record.id);
          return persisted?.outcome === 'pending' && proposal.dispatchRecordId === record.id && persisted.payloadDigest === record.payloadDigest;
        };
        const verifier: DispatchVerifier = { verify: async (candidate) => {
          const currentState = this.snapshot;
          const current = currentState.proposals.find((item) => item.id === id);
          const currentAccount = currentState.accounts.find((item) => item.id === record.accountId);
          if (!current || !currentAccount || !recordIsCurrent(currentState, current) || current.status !== 'dispatching' ||
              current.revision !== record.approvedRevision || current.approvedRevision !== record.approvedRevision ||
              current.approvedPayloadDigest !== record.payloadDigest || current.sourceRevision !== record.sourceRevision ||
              current.accountId !== record.accountId || !sameAccountIdentity(currentAccount.identity, record.account.identity) ||
              await approvedDigest(current, currentState) !== record.payloadDigest || !matchesFrozenPayload(current)) return false;
          if (await this.validateProposalProvenance(currentState, current) !== approvedDependencyProjection) return false;
          return stableJson(candidate) === stableJson(envelope);
        }, verifyBeforeDispatch: (candidate) => {
          const currentState = this.snapshot;
          const current = currentState.proposals.find((item) => item.id === id);
          const currentNote = current && currentState.notes.find((item) => item.id === current.noteId);
          const currentAccount = currentState.accounts.find((item) => item.id === record.accountId);
          const expectedCapability = operation === 'draft' ? 'mail.draft' : operation === 'send' ? 'mail.send' : 'calendar.write';
          if (!current || !currentNote || !currentAccount || currentState.settings.mode !== 'provider' || !recordIsCurrent(currentState, current) ||
              current.status !== 'dispatching' || current.approvedRevision !== record.approvedRevision || current.revision !== record.approvedRevision ||
              current.approvedPayloadDigest !== record.payloadDigest || current.sourceRevision !== currentNote.revision || current.sourceRevision !== record.sourceRevision ||
              current.accountId !== record.accountId || currentAccount.authStatus !== 'connected' || !currentAccount.connected ||
              currentAccount.connectionGeneration !== account.connectionGeneration || !currentAccount.capabilities?.includes(expectedCapability) ||
              !sameAccountIdentity(currentAccount.identity, record.account.identity) || !matchesFrozenPayload(current) ||
              this.proposalDependencyProjection(currentState, current) !== approvedDependencyProjection ||
              stableJson(candidate) !== stableJson(envelope)) return false;
          if (operation === 'event') {
            const target = currentState.calendars.find((item) => item.id === current.calendarId);
            if (!target || !target.connected || !target.writable || target.accountId !== currentAccount.id || target.providerId !== record.calendar?.providerId) return false;
          }
          return true;
        } };
        try {
          const receipt: MutationReceipt = operation === 'draft'
            ? await this.connector.createDraft(account, envelope, verifier)
            : operation === 'send'
              ? await this.connector.sendEmail(account, envelope, verifier)
              : await this.connector.createEvent(account, record.calendar!.providerId, envelope, verifier, record.providerIdempotencyKey!);
          result = receipt.status === 'unknown'
            ? { status: 'unknown', operation, dispatchOutcome: 'unknown', message: 'The provider outcome is unknown. Check the destination manually; this action will not be retried.' }
            : { status: 'accepted', operation, dispatchOutcome: 'accepted', remoteId: receipt.id, message: `The provider accepted the ${operation} request${receipt.id ? ` (reference ${receipt.id})` : ''}. Completion or delivery is not confirmed.` };
        } catch (error) {
          const providerRejected = error instanceof ProviderWriteRejectedError;
          result = {
            status: 'failed', dispatchOutcome: 'rejected',
            rejectionCode: providerRejected ? 'provider_rejected' : 'precondition_failed',
            message: providerRejected
              ? `The provider rejected the ${operation} request (HTTP ${error.status}). Review the destination and approve a fresh attempt if needed.`
              : error instanceof Error ? error.message : 'The approved action was rejected before transmission.',
          };
        }
      }
    }

    let cancelReminder = false;
    let committed: Proposal | undefined;
    try {
      committed = await this.mutate((state) => {
        let persistedRecord: DispatchRecord | undefined;
        if (frozenRecord) {
          const recordIndex = state.dispatchRecords.findIndex((item) => item.id === frozenRecord.id);
          const record = state.dispatchRecords[recordIndex];
          if (!record) throw new Error('The frozen dispatch receipt disappeared before its result could be saved.');
          if (record.outcome === 'pending') {
            const outcome = result.dispatchOutcome ?? (result.status === 'accepted' ? 'accepted' : result.status === 'unknown' ? 'unknown' : 'rejected');
            persistedRecord = recordDispatchOutcome(record, {
              outcome, at: new Date(Math.max(Date.now(), Date.parse(record.dispatchStartedAt))).toISOString(),
              ...(result.remoteId ? { remoteId: result.remoteId } : {}),
              ...(outcome === 'rejected' ? { rejectionCode: result.rejectionCode ?? 'precondition_failed' } : {}),
            });
            state.dispatchRecords[recordIndex] = persistedRecord;
          } else {
            persistedRecord = record;
          }
          result.status = persistedRecord.outcome === 'accepted' ? 'accepted' : persistedRecord.outcome === 'unknown' ? 'unknown' : 'failed';
          result.dispatchOutcome = persistedRecord.outcome === 'pending' ? undefined : persistedRecord.outcome;
          result.operation = persistedRecord.operation;
          result.remoteId = persistedRecord.remoteId;
          result.rejectionCode = persistedRecord.rejectionCode;
          if (persistedRecord.outcome === 'unknown') result.message = 'The provider outcome is unknown. Check the destination manually; this action will not be retried.';
          if (persistedRecord.outcome === 'accepted') result.message = `The provider accepted the ${persistedRecord.operation} request${persistedRecord.remoteId ? ` (reference ${persistedRecord.remoteId})` : ''}. Completion or delivery is not confirmed.`;
          if (persistedRecord.outcome === 'rejected' && persistedRecord.rejectionCode === 'provider_rejected') result.message = `The provider rejected the ${persistedRecord.operation} request. Review the destination and approve a fresh attempt if needed.`;
        }
        const proposal = state.proposals.find((item) => item.id === id);
        if (!proposal) {
          if (!persistedRecord) throw new Error('The action was removed before completion.');
          addActivity(state, result.status === 'failed' || result.status === 'unknown' ? 'error' : 'local_action',
            `Dispatch receipt saved after the proposal was removed: ${result.message}`, { proposalId: frozenRecord!.proposalId });
          return undefined;
        }
        if (proposal.status !== 'dispatching') {
          if (!persistedRecord) throw new Error('Action state changed while execution was in progress.');
          addActivity(state, 'error', `Dispatch receipt saved while preserving the proposal’s newer state: ${result.message}`, { proposalId: frozenRecord!.proposalId, noteId: proposal.noteId });
          return proposal;
        }
        if ((proposal.kind === 'task' || proposal.kind === 'reminder') && result.status === 'executed' &&
            this.proposalDependencyProjection(state, proposal) !== approvedDependencyProjection) {
          cancelReminder = proposal.kind === 'reminder';
          result = { status: 'failed', message: 'The source context changed before this local action was committed. Run Assist again and review the suggestion.' };
        }
        proposal.status = result.status;
        proposal.simulated = result.status === 'simulated';
        proposal.lastError = result.status === 'failed' || result.status === 'unknown' ? result.message : undefined;
        if ('operation' in result && result.operation) proposal.remoteOperation = result.operation;
        if ('remoteId' in result && result.remoteId) proposal.remoteId = result.remoteId;
        if (result.status === 'accepted') proposal.remoteAcceptedAt = now();
        if (result.notificationId && result.status === 'executed') {
          proposal.notificationId = result.notificationId;
          proposal.notificationRevision = proposal.revision;
        }
        if (proposal.kind === 'task' && result.status === 'executed' && !state.tasks.some((task) => task.id === proposal.id)) {
          state.tasks.unshift({ id: proposal.id, title: proposal.title, body: proposal.body, status: 'open', createdAt: now(), dueAt: proposal.dueAt, sourceNoteId: proposal.noteId, sourceRevision: proposal.sourceRevision, proposalId: proposal.id });
          markTaskAnalysesStale(state, proposal.id);
        }
        addActivity(state, result.status === 'simulated' ? 'simulation' : result.status === 'failed' || result.status === 'unknown' ? 'error' : 'local_action', result.message, { proposalId: id, noteId: proposal.noteId });
        return proposal;
      });
    } catch (error) {
      if (claimed.kind === 'reminder') await cancelReminderNotification(claimed);
      throw error;
    }
    if (cancelReminder) await cancelReminderNotification(claimed);
    if (!committed && frozenRecord) {
      // Preserve a truthful result for the caller even if the local proposal was removed;
      // the durable dispatch history remains the canonical receipt.
      return {
        ...claimed, status: result.status, dispatchRecordId: frozenRecord.id,
        remoteOperation: frozenRecord.operation, remoteId: result.remoteId,
        remoteAcceptedAt: result.status === 'accepted' ? frozenRecord.outcomeAt : undefined,
        lastError: result.status === 'failed' || result.status === 'unknown' ? result.message : undefined,
      };
    }
    if (!committed) throw new Error('The action was removed before completion.');
    return committed;
  }

  async dismissProposal(id: string): Promise<Proposal> {
    return this.mutate((state) => {
      const proposal = this.proposal(state, id);
      if (['dispatching', 'unknown', 'executed', 'accepted', 'simulated'].includes(proposal.status)) throw new Error('This proposal cannot be dismissed while or after execution.');
      proposal.status = 'dismissed';
      proposal.approvedRevision = undefined;
      proposal.approvedPayloadDigest = undefined;
      addActivity(state, 'proposal_created', 'Suggestion dismissed.', { proposalId: id, noteId: proposal.noteId });
      return proposal;
    });
  }

  async reconcileDispatch(recordId: string, input: { disposition: DispatchReconciliation; note: string; remoteId?: string }): Promise<DispatchRecord> {
    return this.mutate((state) => {
      const index = state.dispatchRecords.findIndex((record) => record.id === recordId);
      if (index < 0) throw new Error('Dispatch history record was not found.');
      const current = state.dispatchRecords[index];
      const updated = appendDispatchReconciliation(current, {
        id: newId(), disposition: input.disposition,
        at: new Date(Math.max(Date.now(), current.outcomeAt ? Date.parse(current.outcomeAt) : 0)).toISOString(),
        note: input.note, ...(input.remoteId ? { remoteId: input.remoteId } : {}),
      });
      state.dispatchRecords[index] = updated;
      addActivity(state, 'local_action', 'Added a local reconciliation note. Provider outcome remains unchanged.', { proposalId: current.proposalId });
      return updated;
    });
  }

  async completeTask(id: string): Promise<LocalTask> {
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error('Task was not found.');
      if (task.status !== 'completed') { task.status = 'completed'; task.completedAt = now(); }
      markTaskAnalysesStale(state, id);
      addActivity(state, 'local_action', `Task completed: ${task.title}.`, { noteId: task.sourceNoteId, proposalId: task.proposalId });
      return task;
    });
  }

  async reopenTask(id: string): Promise<LocalTask> {
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error('Task was not found.');
      task.status = 'open'; delete task.completedAt;
      markTaskAnalysesStale(state, id);
      addActivity(state, 'local_action', `Task reopened: ${task.title}.`, { noteId: task.sourceNoteId, proposalId: task.proposalId });
      return task;
    });
  }

  async saveDocument(path: string, content: string): Promise<ContextDocument> {
    const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || cleanPath.split('/').some((part) => part === '.' || part === '..')) throw new Error('Document path must stay inside the app documents folder.');
    const document = await this.mutate((state) => {
      const existing = state.documents.find((item) => item.path === cleanPath);
      if (existing?.content === content) return existing;
      const changed = existing?.content !== content;
      const next: ContextDocument = { path: cleanPath, content, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
      if (existing) Object.assign(existing, next); else state.documents.unshift(next);
      if (changed) markAnalysesStale(state, [`doc:${cleanPath}`]);
      return next;
    });
    await this.mirrorDocument(document);
    return document;
  }

  private async mirrorDocument(document: ContextDocument): Promise<void> {
    try { await writePrivateDocument(document.path, document.content); this.mirrorDirty.delete(document.path); }
    catch (error) {
      this.mirrorDirty.add(document.path);
      await this.mutate((state) => addActivity(state, 'error', `Local document mirror for ${document.path} will retry on next launch: ${error instanceof Error ? error.message : 'write failed'}.`));
    }
  }

  private async retryDocumentMirrors(): Promise<void> {
    for (const path of [...this.mirrorDirty]) {
      const document = this.snapshot.documents.find((item) => item.path === path);
      if (!document) { this.mirrorDirty.delete(path); continue; }
      try { await writePrivateDocument(document.path, document.content); this.mirrorDirty.delete(path); }
      catch { /* canonical SQLite/IndexedDB document remains available and will retry next launch */ }
    }
  }

  async saveSettings(patch: SettingsPatch): Promise<AppSettings> {
    const sanitized: SettingsPatch = { ...patch };
    if ('speechEndpoint' in sanitized) sanitized.speechEndpoint = sanitized.speechEndpoint ? validateAzureEndpoint(sanitized.speechEndpoint, 'speech') : undefined;
    if ('openAiEndpoint' in sanitized) sanitized.openAiEndpoint = sanitized.openAiEndpoint ? validateAzureEndpoint(sanitized.openAiEndpoint, 'openai') : undefined;
    if (sanitized.model && sanitized.model !== 'gpt-6-luna') throw new Error('This app is configured for GPT-6 Luna only.');
    if (sanitized.reasoningEffort && !['none', 'low'].includes(sanitized.reasoningEffort)) throw new Error('Reasoning effort must be none or low.');
    if (sanitized.mode && !['preview', 'provider'].includes(sanitized.mode)) throw new Error('Choose Preview or Provider mode.');
    if (sanitized.timezone !== undefined) sanitized.timezone = validTimezone(sanitized.timezone);
    if (sanitized.audioRetention && !['keep', 'delete_after_transcription'].includes(sanitized.audioRetention)) throw new Error('Choose a supported audio retention policy.');
    if (sanitized.maxContextTokens !== undefined) sanitized.maxContextTokens = finiteClamp(sanitized.maxContextTokens, 256, 6000, 'Context token limit');
    if (sanitized.maxRequestBytes !== undefined) sanitized.maxRequestBytes = finiteClamp(sanitized.maxRequestBytes, 4000, 96000, 'Request byte limit');
    if (sanitized.maxOutputTokens !== undefined) sanitized.maxOutputTokens = finiteClamp(sanitized.maxOutputTokens, 64, 2400, 'Output token limit');
    if (sanitized.monthlyBudgetUsd !== undefined) sanitized.monthlyBudgetUsd = finiteRange(sanitized.monthlyBudgetUsd, 0, 100, 'Monthly budget');
    if (sanitized.maxAttempts !== undefined) sanitized.maxAttempts = finiteClamp(sanitized.maxAttempts, 1, 2, 'Maximum attempts');
    if (sanitized.maxCallsPerDay !== undefined) sanitized.maxCallsPerDay = finiteClamp(sanitized.maxCallsPerDay, 1, 100, 'Daily provider call limit');
    if (sanitized.maxAudioSeconds !== undefined) sanitized.maxAudioSeconds = finiteClamp(sanitized.maxAudioSeconds, 10, 600, 'Maximum audio length');
    for (const rate of ['inputUsdPerMillionTokens', 'outputUsdPerMillionTokens', 'speechUsdPerMinute'] as const) {
      if (sanitized[rate] !== undefined) sanitized[rate] = finiteRange(sanitized[rate]!, 0, 10000, 'Provider rate');
    }
    return this.mutate((state) => {
      this.rollUsage(state);
      Object.assign(state.settings, sanitized);
      this.rollUsage(state);
      addActivity(state, 'local_action', 'Settings saved locally.');
      return state.settings;
    });
  }

  async saveAccount(config: AccountConfig): Promise<Account> {
    const email = config.email.trim().toLowerCase();
    if (!email.includes('@') || /[\s<>]/.test(email)) throw new Error('Enter a valid account email address.');
    return this.mutate((state) => {
      const id = config.id ?? newId();
      const prior = state.accounts.find((item) => item.id === id);
      if (prior?.identity && prior.provider !== config.provider) throw new Error('A saved provider identity cannot be moved to a different provider. Create a separate account entry.');
      if (prior?.identity && state.proposals.some((item) => item.accountId === id && item.status === 'dispatching')) throw new Error('Wait for the current provider operation to finish before editing this account.');
      const oldTokenRef = prior?.tokenRef;
      const account: Account = { id, provider: config.provider, displayName: config.displayName.trim(), email, connected: false, authStatus: 'configured', identity: prior?.identity, tokenRef: undefined, grantedScopes: [], capabilities: [], syncStatus: 'idle', connectionGeneration: (prior?.connectionGeneration ?? 0) + 1 };
      if (prior) Object.assign(prior, account); else state.accounts.push(account);
      if (oldTokenRef && !state.pendingCredentialCleanup.some((item) => item.tokenRef === oldTokenRef)) {
        state.pendingCredentialCleanup.push({ tokenRef: oldTokenRef, reason: 'disconnected', createdAt: now() });
      }
      for (const proposal of state.proposals.filter((item) => item.accountId === id && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      addActivity(state, 'local_action', `${account.displayName || account.email} saved as an unconnected account configuration.`);
      return account;
    });
  }

  private async handleConnectorAuthStatus(accountId: string, status: Account['authStatus']): Promise<void> {
    if (status !== 'reauth_required' && status !== 'revoked') return;
    this.syncGeneration.set(accountId, (this.syncGeneration.get(accountId) ?? 0) + 1);
    this.syncAbortControllers.get(accountId)?.abort();
    await this.mutate((state) => {
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account) return;
      if (account.identity) {
        const priorIdentity = encodeURIComponent(identityKey(account));
        markAnalysesStale(state, [], [`mail:${priorIdentity}:`, `calendar:${priorIdentity}:`, `calendar-event:${priorIdentity}:`]);
      }
      account.authStatus = status;
      account.connected = false;
      account.capabilities = [];
      account.syncStatus = 'error';
      for (const calendar of state.calendars.filter((item) => item.accountId === accountId)) { calendar.connected = false; calendar.writable = false; }
      for (const proposal of state.proposals.filter((item) => item.accountId === accountId && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      const sync = state.syncStates[accountId] ?? emptySyncState(accountId);
      sync.status = 'error'; sync.lastError = 'Account authentication needs attention.';
      state.syncStates[accountId] = sync;
      addActivity(state, 'error', `${account.displayName || account.email} needs to reconnect.`);
    });
  }

  async installVerifiedAccount(config: AccountConfig, result: OAuthInstallResult): Promise<Account> {
    const tokenStore = this.integration.tokenStore;
    if (!tokenStore || !this.integration.verifyOAuthResult || !this.connector) throw new Error('Verified account connection is unavailable until the OAuth and connector services are configured.');
    await this.load();
    if (result.provider !== config.provider || !['google', 'microsoft'].includes(result.provider)) throw new Error('The verified sign-in does not match this account configuration.');
    const expectedClientId = this.integration.clientIds?.[result.provider];
    if (!expectedClientId || result.identity.providerNamespace !== result.provider || result.identity.clientId !== expectedClientId ||
        !result.identity.subject || (result.provider === 'microsoft' && !result.identity.resourceUserId) ||
        !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || !result.accessToken) throw new Error('The provider identity or token is incomplete or expired.');
    const tokenRef = `oauth-${newId()}`;
    this.installingTokenRefs.add(tokenRef);
    // Capture lifecycle state before asynchronous keychain/provider verification; commit uses CAS.
    const initial = this.snapshot;
    const initialExisting = initial.accounts.find((account) => sameAccountIdentity(account.identity, result.identity)) ??
      (config.id ? initial.accounts.find((account) => account.id === config.id) : undefined);
    const expectedLifecycle = initialExisting ? {
      id: initialExisting.id, generation: initialExisting.connectionGeneration ?? 0,
      tokenRef: initialExisting.tokenRef, identity: clone(initialExisting.identity), authStatus: initialExisting.authStatus, connected: initialExisting.connected,
    } : undefined;
    let staged = false;
    try {
      // Register before writing so a crash or verification failure leaves a durable orphan cleanup record.
      await this.queueCredentialCleanup(tokenRef, 'orphan');
      await tokenStore.set(tokenRef, { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt, identity: result.identity });
      staged = true;
      let stored = await tokenStore.get(tokenRef);
      if (!stored || stored.accessToken !== result.accessToken || stored.expiresAt !== result.expiresAt || !sameAccountIdentity(stored.identity, result.identity)) {
        throw new Error('The staged token does not match the verified sign-in result.');
      }
      if (stored.refreshToken !== result.refreshToken) throw new Error('The staged refresh credential does not match the verified sign-in result.');
      if (!await this.integration.verifyOAuthResult(result as OAuthBridgeResult, stored) || !await this.connector.verifyOAuthIdentity(result as OAuthBridgeResult, stored)) {
        throw new Error('The provider could not verify this account identity and granted access.');
      }
      const email = (result.email || config.email).trim().toLowerCase();
      if (!validEmail(email)) throw new Error('The verified account did not provide a valid email address.');
      const scopeCapabilities = grantedCapabilities(result.provider, result.grantedScopes);
      const effectiveCapabilities = intersectCapabilities(result.requestedCapabilities, result.capabilities, scopeCapabilities);
      const commitInstall = async (): Promise<Account> => {
        let expectedRefreshToken = result.refreshToken;
        if (expectedLifecycle?.tokenRef && expectedLifecycle.connected && expectedLifecycle.authStatus === 'connected' &&
            expectedLifecycle.identity && sameAccountIdentity(expectedLifecycle.identity, result.identity) && !result.refreshToken) {
          const priorForRefresh = await tokenStore.get(expectedLifecycle.tokenRef);
          if (priorForRefresh && sameAccountIdentity(priorForRefresh.identity, result.identity) && priorForRefresh.refreshToken) {
            expectedRefreshToken = priorForRefresh.refreshToken;
            await tokenStore.set(tokenRef, { accessToken: result.accessToken, refreshToken: expectedRefreshToken, expiresAt: result.expiresAt, identity: result.identity });
          }
        }
        const verifiedReadback = await tokenStore.get(tokenRef);
        if (!verifiedReadback || verifiedReadback.accessToken !== result.accessToken || verifiedReadback.refreshToken !== expectedRefreshToken ||
            verifiedReadback.expiresAt !== result.expiresAt || !sameAccountIdentity(verifiedReadback.identity, result.identity)) {
        throw new Error('The secure account credential could not be verified after storage.');
        }
        return this.mutate((state) => {
        const existing = state.accounts.find((account) => sameAccountIdentity(account.identity, result.identity));
        const configured = config.id ? state.accounts.find((account) => account.id === config.id) : undefined;
        if (config.id) {
          const reusablePlaceholder = configured && configured.provider === result.provider && !configured.identity && configured.authStatus === 'configured' && !configured.tokenRef;
          if (configured && !sameAccountIdentity(configured.identity, result.identity) && !reusablePlaceholder) throw new Error('Choose a new account entry for a different provider identity.');
          if (existing && existing.id !== config.id) throw new Error('This provider identity is already connected under another account entry.');
        }
        const prior = existing ?? configured;
        if (expectedLifecycle) {
          const current = state.accounts.find((account) => account.id === expectedLifecycle.id);
          if (!current || current.connectionGeneration !== expectedLifecycle.generation || current.tokenRef !== expectedLifecycle.tokenRef ||
              JSON.stringify(current.identity ?? null) !== JSON.stringify(expectedLifecycle.identity ?? null) || current.authStatus !== expectedLifecycle.authStatus ||
              current.connected !== expectedLifecycle.connected) {
            throw new Error('The account changed while reconnecting. Restart sign-in to protect the active connection.');
          }
        } else if (prior) throw new Error('The account was connected or changed while sign-in was being verified. Restart sign-in.');
        const oldTokenRef = prior?.tokenRef;
        const account: Account = {
          id: prior?.id ?? config.id ?? newId(), provider: result.provider,
          displayName: (result.displayName || config.displayName).trim(), email,
          connected: true, authStatus: 'connected', identity: clone(result.identity), tokenRef,
          grantedScopes: [...new Set(result.grantedScopes)], capabilities: effectiveCapabilities,
          capabilityLimits: [...result.requestedCapabilities], syncStatus: 'idle', configuredAt: prior?.configuredAt ?? now(),
          connectionGeneration: (prior?.connectionGeneration ?? 0) + 1,
        };
        if (state.accounts.some((candidate) => candidate.id === account.id && candidate !== prior)) throw new Error('Account identifier is already in use.');
        if (prior?.identity && prior.connected) {
          const priorIdentity = encodeURIComponent(identityKey(prior));
          markAnalysesStale(state, [], [`mail:${priorIdentity}:`, `calendar:${priorIdentity}:`, `calendar-event:${priorIdentity}:`]);
        }
        for (const proposal of state.proposals.filter((item) => item.accountId === account.id && ['draft', 'approved', 'failed'].includes(item.status))) {
          this.invalidate(proposal); proposal.status = 'draft';
        }
        if (prior) Object.assign(prior, account); else state.accounts.push(account);
        state.pendingCredentialCleanup = state.pendingCredentialCleanup.filter((item) => item.tokenRef !== tokenRef);
        if (oldTokenRef && oldTokenRef !== tokenRef && !state.pendingCredentialCleanup.some((item) => item.tokenRef === oldTokenRef)) {
          state.pendingCredentialCleanup.push({ tokenRef: oldTokenRef, reason: 'replaced', createdAt: now() });
        }
        for (const calendar of state.calendars.filter((item) => item.accountId === account.id)) { calendar.connected = false; calendar.writable = false; }
        state.syncStates[account.id] ??= emptySyncState(account.id);
        addActivity(state, 'local_action', `${account.displayName || account.email} was connected after provider identity verification.`);
        return account;
        });
      };
      const priorRef = expectedLifecycle?.tokenRef;
      const installed = priorRef
        ? await withCredentialLock(tokenStore, priorRef, commitInstall)
        : await commitInstall();
      this.syncGeneration.set(installed.id, installed.connectionGeneration ?? 0);
      this.syncAbortControllers.get(installed.id)?.abort();
      this.installingTokenRefs.delete(tokenRef);
      await this.retryCredentialCleanup().catch(() => undefined);
      return installed;
    } catch (error) {
      if (staged) await this.queueCredentialCleanup(tokenRef, 'orphan').catch(() => undefined);
      this.installingTokenRefs.delete(tokenRef);
      await this.retryCredentialCleanup().catch(() => undefined);
      throw error;
    } finally {
      this.installingTokenRefs.delete(tokenRef);
    }
  }

  async disconnectAccount(id: string): Promise<Account> {
    this.syncGeneration.set(id, (this.syncGeneration.get(id) ?? 0) + 1);
    this.syncAbortControllers.get(id)?.abort();
    const account = await this.mutate((state) => {
      const current = state.accounts.find((item) => item.id === id);
      if (!current) throw new Error('Account was not found.');
      if (current.identity) {
        const priorIdentity = encodeURIComponent(identityKey(current));
        markAnalysesStale(state, [], [`mail:${priorIdentity}:`, `calendar:${priorIdentity}:`, `calendar-event:${priorIdentity}:`]);
      }
      const oldTokenRef = current.tokenRef;
      current.authStatus = 'configured'; current.connected = false; current.capabilities = []; current.grantedScopes = []; current.syncStatus = 'idle';
      current.tokenRef = undefined;
      current.connectionGeneration = (current.connectionGeneration ?? 0) + 1;
      if (oldTokenRef && !state.pendingCredentialCleanup.some((item) => item.tokenRef === oldTokenRef)) {
        state.pendingCredentialCleanup.push({ tokenRef: oldTokenRef, reason: 'disconnected', createdAt: now() });
      }
      for (const calendar of state.calendars.filter((item) => item.accountId === id)) { calendar.connected = false; calendar.writable = false; }
      for (const proposal of state.proposals.filter((item) => item.accountId === id && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal); proposal.status = 'draft';
      }
      const sync = state.syncStates[id] ?? emptySyncState(id);
      sync.status = sync.lastStartedAt ? 'partial' : 'idle';
      state.syncStates[id] = sync;
      addActivity(state, 'local_action', `${current.displayName || current.email} was disconnected. Pending approvals were cleared.`);
      return current;
    });
    await this.retryCredentialCleanup();
    return account;
  }

  async syncAccount(id: string, options: { continue?: boolean } = {}): Promise<AccountSyncState> {
    const active = this.syncJobs.get(id);
    if (active) return active;
    const job = this.runSyncAccount(id, options).finally(() => this.syncJobs.delete(id));
    this.syncJobs.set(id, job);
    return job;
  }

  private async acquireSyncSlot(): Promise<() => void> {
    if (this.activeSyncCount < 2) { this.activeSyncCount++; return () => {
      const next = this.syncQueue.shift();
      if (next) next(); else this.activeSyncCount--;
    }; }
    await new Promise<void>((resolve) => this.syncQueue.push(resolve));
    return () => {
      const next = this.syncQueue.shift();
      if (next) next(); else this.activeSyncCount--;
    };
  }

  private async runSyncAccount(id: string, options: { continue?: boolean }): Promise<AccountSyncState> {
    if (!this.connector) throw new Error('Provider sync is not configured.');
    const release = await this.acquireSyncSlot();
    const abortController = new AbortController();
    this.syncAbortControllers.set(id, abortController);
    const deadlineTimer = setTimeout(() => abortController.abort(new Error('Sync reached its 30 second deadline.')), 30_000);
    try {
      const started = Date.now();
      let requests = 0;
      const guard = () => {
        if (abortController.signal.aborted) throw new Error('Sync was cancelled or reached its 30 second deadline. Continue manually when the account is available.');
        if (Date.now() - started > 30_000) throw new Error('Sync stopped at its 30 second run limit. Continue manually to resume.');
        if (++requests > 20) throw new Error('Sync stopped at its 20 request run limit. Continue manually to resume.');
      };
      const { account, sync } = await this.mutate((state) => {
        const account = state.accounts.find((item) => item.id === id);
        if (!account || account.authStatus !== 'connected' || !account.connected) throw new Error('Reconnect this account before syncing.');
        const sync = state.syncStates[id] ?? emptySyncState(id);
        if (sync.status === 'partial' && !options.continue) throw new Error('This sync is partial. Choose Continue to resume saved cursors.');
        if (options.continue && sync.status !== 'partial') throw new Error('There is no partial sync to continue. Start a fresh sync instead.');
        if (!options.continue) {
          const anchor = new Date().toISOString();
          sync.lastStartedAt = anchor;
          sync.messagesTimeMin = new Date(Date.parse(anchor) - 14 * 24 * 60 * 60 * 1000).toISOString();
          sync.eventsTimeMin = anchor;
          sync.eventsTimeMax = new Date(Date.parse(anchor) + 14 * 24 * 60 * 60 * 1000).toISOString();
          sync.messagesCursor = undefined; sync.messagesCompletedAt = undefined; sync.messagesPartial = false;
          sync.calendarsCursor = undefined; sync.calendarsCompletedAt = undefined; sync.calendarsPartial = false;
          sync.eventCursors = {}; sync.eventsCompletedAt = {};
        }
        sync.status = 'syncing'; sync.lastError = undefined;
        state.syncStates[id] = sync; account.syncStatus = 'idle';
        return { account, sync };
      });
      const generation = this.syncGeneration.get(id) ?? account.connectionGeneration ?? 0;
      this.syncGeneration.set(id, generation);
      const tokenRef = account.tokenRef;
      const canMail = account.capabilities?.includes('mail.read') === true;
      const canCalendar = account.capabilities?.includes('calendar.read') === true;
      const currentConnection = (state: AppState = this.snapshot) => {
        const current = state.accounts.find((item) => item.id === id);
        if (abortController.signal.aborted || this.syncGeneration.get(id) !== generation || !current || !current.connected ||
            current.authStatus !== 'connected' || current.tokenRef !== tokenRef || current.connectionGeneration !== account.connectionGeneration ||
            !sameAccountIdentity(current.identity, account.identity)) throw new Error('Account connection changed while syncing; stale pages were discarded.');
      };
      const persist = <T,>(operation: (state: AppState) => T): Promise<T> => this.mutate((state) => {
        currentConnection(state);
        return operation(state);
      });
      const completedThisRun = (at?: string) => Boolean(at && sync.lastStartedAt && Date.parse(at) >= Date.parse(sync.lastStartedAt));
      try {
        if (!canMail && !canCalendar) throw new Error('This account has no mailbox or calendar read permission to sync.');
        const start = sync.messagesTimeMin ?? new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const addMessages = async (items: MessageSummary[], cursor: string | undefined, pagesRead: number) => persist((state) => {
          const current = state.syncStates[id] ?? emptySyncState(id);
          const key = identityKey(account);
          for (const item of items) {
            if (!item.id) continue;
            const dedupe = `${key}:${item.id}`;
            const prior = state.mailbox.find((entry) => entry.accountId === id && entry.identityKey === dedupe);
            const value: MailboxSnapshotMessage = { id: prior?.id ?? newId(), accountId: id, providerMessageId: item.id, identityKey: dedupe, threadId: item.threadId, subject: item.subject, from: item.from, receivedAt: item.receivedAt, snippet: item.snippet };
            if (prior) Object.assign(prior, value); else state.mailbox.push(value);
            markAnalysesStale(state, [`mail:${encodeURIComponent(key)}:${encodeURIComponent(item.id)}`]);
          }
          const accountMessages = state.mailbox.filter((entry) => entry.accountId === id).sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? '')).slice(0, 200);
          state.mailbox = [...state.mailbox.filter((entry) => entry.accountId !== id), ...accountMessages];
          current.messagesCursor = cursor; current.messagesPartial = Boolean(cursor); current.status = cursor ? 'partial' : current.status;
          state.syncStates[id] = current;
        });
        const messageComplete = !canMail || completedThisRun(sync.messagesCompletedAt);
        const messagePage: SyncPage<MessageSummary> = canMail && !messageComplete ? await this.connector.syncMessages(account, {
          cursor: sync.messagesCursor, pageSize: 25, timeMin: start, guard, signal: abortController.signal, onPage: addMessages,
        }) : { items: [], pagesRead: 0, partial: sync.messagesPartial, nextCursor: sync.messagesCursor };
        if (canMail && !messageComplete) await persist((state) => {
          const current = state.syncStates[id] ?? emptySyncState(id);
          current.messagesCursor = messagePage.nextCursor; current.messagesPartial = messagePage.partial;
          if (!messagePage.partial) { current.messagesCursor = undefined; current.messagesCompletedAt = now(); }
          state.syncStates[id] = current;
        });
        currentConnection();
        const calendarsComplete = !canCalendar || completedThisRun(sync.calendarsCompletedAt);
        const calendarPage: SyncPage<CalendarSummary> = canCalendar && !calendarsComplete ? await this.connector.listCalendars(account, {
          cursor: sync.calendarsCursor, guard, signal: abortController.signal,
          onPage: async (items, cursor) => persist((state) => {
            for (const item of items) {
              let calendar = state.calendars.find((entry) => entry.accountId === id && entry.providerId === item.id);
              const localId = calendar?.id ?? `${id}:${item.id}`;
              if (!calendar) { calendar = { id: localId, providerId: item.id, accountId: id, name: item.name, writable: item.writable && account.capabilities?.includes('calendar.write') === true, connected: true }; state.calendars.push(calendar); }
              else { calendar.name = item.name; calendar.connected = true; calendar.writable = item.writable && account.capabilities?.includes('calendar.write') === true; }
              markAnalysesStale(state, [`calendar:${encodeURIComponent(identityKey(account))}:${encodeURIComponent(item.id)}`]);
            }
            const current = state.syncStates[id] ?? emptySyncState(id); current.calendarsCursor = cursor; current.calendarsPartial = Boolean(cursor); state.syncStates[id] = current;
          }),
        }) : { items: [], pagesRead: 0, partial: sync.calendarsPartial, nextCursor: sync.calendarsCursor };
        if (canCalendar && !calendarsComplete) await persist((state) => {
          const current = state.syncStates[id] ?? emptySyncState(id); current.calendarsCursor = calendarPage.nextCursor; current.calendarsPartial = calendarPage.partial;
          if (!calendarPage.partial) { current.calendarsCursor = undefined; current.calendarsCompletedAt = now(); }
          state.syncStates[id] = current;
        });
        const calendars = canCalendar ? this.snapshot.calendars.filter((calendar) => calendar.accountId === id && calendar.providerId) : [];
        let anyEventPartial = false;
        for (const calendar of calendars) {
          if (completedThisRun(sync.eventsCompletedAt[calendar.id])) continue;
          currentConnection();
          const eventPage = await this.connector.readCalendarEvents(account, calendar.providerId!, {
            cursor: sync.eventCursors[calendar.id] || undefined, timeMin: sync.eventsTimeMin ?? now(), timeMax: sync.eventsTimeMax ?? new Date(Date.now() + 14 * 86400000).toISOString(), guard, signal: abortController.signal,
            onPage: (items, cursor, pagesRead) => persist((state) => {
              for (const item of items) {
                if (!item.id) continue;
                let event = state.calendarEvents.find((entry) => entry.calendarId === calendar.id && entry.providerEventId === item.id);
                const mapped: CalendarEventSnapshot = { id: event?.id ?? newId(), accountId: id, calendarId: calendar.id, providerEventId: item.id, subject: item.subject, start: item.start, end: item.end, timeZone: item.timeZone };
                if (event) Object.assign(event, mapped); else state.calendarEvents.push(mapped);
                markAnalysesStale(state, [`calendar-event:${encodeURIComponent(identityKey(account))}:${encodeURIComponent(calendar.providerId!)}:${encodeURIComponent(item.id)}`]);
              }
              const current = state.syncStates[id] ?? emptySyncState(id); current.eventCursors[calendar.id] = cursor ?? '';
              if (!cursor) { delete current.eventCursors[calendar.id]; current.eventsCompletedAt[calendar.id] = now(); }
              state.syncStates[id] = current;
            }),
          });
          anyEventPartial ||= eventPage.partial;
          if (eventPage.partial) break;
        }
        const complete = !messagePage.partial && !calendarPage.partial && !anyEventPartial;
        currentConnection();
        return persist((state) => {
          const current = state.syncStates[id] ?? emptySyncState(id);
          current.status = complete ? 'idle' : 'partial';
          current.lastSuccessAt = complete ? now() : current.lastSuccessAt;
          current.lastError = undefined;
          const owner = state.accounts.find((item) => item.id === id);
          if (owner) { owner.syncStatus = complete ? 'idle' : 'partial'; owner.lastSyncedAt = complete ? current.lastSuccessAt : owner.lastSyncedAt; }
          state.syncStates[id] = current; return current;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sync failed.';
        if (this.syncGeneration.get(id) !== generation || abortController.signal.aborted && !this.snapshot.accounts.some((item) => item.id === id && item.connected && item.connectionGeneration === account.connectionGeneration)) throw error;
        return persist((state) => {
          const current = state.syncStates[id] ?? emptySyncState(id); current.status = 'partial'; current.lastError = message;
          if (canMail && !completedThisRun(current.messagesCompletedAt)) current.messagesPartial = true;
          if (canCalendar && !completedThisRun(current.calendarsCompletedAt)) current.calendarsPartial = true;
          const account = state.accounts.find((item) => item.id === id); if (account) account.syncStatus = current.status === 'partial' ? 'partial' : 'error';
          state.syncStates[id] = current; return current;
        });
      }
    } finally {
      clearTimeout(deadlineTimer);
      if (this.syncAbortControllers.get(id) === abortController) this.syncAbortControllers.delete(id);
      release();
    }
  }

  async saveCalendar(config: CalendarConfig): Promise<Calendar> {
    return this.mutate((state) => {
      const owner = state.accounts.find((item) => item.id === config.accountId);
      if (!owner) throw new Error('Select an account that already exists.');
      const id = config.id ?? newId();
      if (state.proposals.some((item) => item.calendarId === id && ['dispatching', 'unknown'].includes(item.status))) throw new Error('This calendar is part of an action whose result must be checked before changing it.');
      const calendar: Calendar = { id, accountId: owner.id, name: config.name.trim(), writable: false, connected: false };
      const prior = state.calendars.find((item) => item.id === id);
      if (prior) Object.assign(prior, calendar); else state.calendars.push(calendar);
      for (const proposal of state.proposals.filter((item) => item.calendarId === id && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal);
        proposal.status = 'draft';
      }
      addActivity(state, 'local_action', `${calendar.name || 'Calendar'} saved as an unconnected calendar configuration.`);
      return calendar;
    });
  }

  async exportData(): Promise<string> {
    const { pendingCredentialCleanup: _cleanup, dispatchRecordQuarantine: _quarantine, ...userState } = clone(this.snapshot);
    return JSON.stringify({ format: 'voice-assistant-export-v1', exportedAt: now(), ...userState }, null, 2);
  }

  async deleteNote(id: string): Promise<void> {
    const audioUri = this.snapshot.notes.find((note) => note.id === id)?.audioUri;
    const reminderIds = this.snapshot.proposals.filter((proposal) => proposal.noteId === id && proposal.kind === 'reminder')
      .flatMap((proposal) => [...new Set([proposal.revision, proposal.notificationRevision].filter((revision): revision is number => typeof revision === 'number'))]
        .map((revision) => ({ id: proposal.id, revision })));
    await this.mutate((state) => {
      if (state.proposals.some((proposal) => proposal.noteId === id && ['dispatching', 'unknown'].includes(proposal.status))) throw new Error('Wait for the in-progress action result before deleting this note.');
      state.notes = state.notes.filter((item) => item.id !== id);
      state.proposals = state.proposals.filter((item) => item.noteId !== id);
      state.activity = state.activity.filter((item) => item.noteId !== id);
    });
    await Promise.all(reminderIds.map((proposal) => cancelReminderNotification(proposal)));
    if (audioUri) {
      try { await removeAudio(audioUri); }
      catch { /* Note deletion is canonical; a broken or missing clip is harmless. */ }
    }
  }
}

type ProposalStatusOutcome = { status: 'executed' | 'simulated' | 'failed' | 'accepted' | 'unknown'; message: string; notificationId?: string; operation?: ApprovedDispatch['operation']; remoteId?: string; dispatchOutcome?: Exclude<DispatchOutcome, 'pending'>; rejectionCode?: 'provider_rejected' | 'precondition_failed' };

const googleClientId = (Platform.OS === 'web' ? process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID : process.env.EXPO_PUBLIC_GOOGLE_NATIVE_CLIENT_ID)?.trim() ?? '';
const microsoftClientId = (Platform.OS === 'web' ? process.env.EXPO_PUBLIC_MICROSOFT_WEB_CLIENT_ID : process.env.EXPO_PUBLIC_MICROSOFT_NATIVE_CLIENT_ID)?.trim() ?? '';
const microsoftAuthority = process.env.EXPO_PUBLIC_MICROSOFT_AUTHORITY?.trim() || 'common';
let defaultConnector: ConnectorClient | undefined;
let defaultController: AppControllerImpl | undefined;
const defaultIntegration: ControllerIntegrationDependencies = {
  tokenStore: oauthTokenStore,
  deleteToken: deleteOAuthToken,
  clientIds: { google: googleClientId, microsoft: microsoftClientId },
  connectorFactory: (tokenStore, onAuthStatus) => {
    defaultConnector = new ConnectorClient({ tokenStore, googleClientId, microsoftClientId, microsoftAuthority, onAuthStatus,
      isConnectionCurrent: (account) => {
        const current = defaultController?.getSnapshot().accounts.find((item) => item.id === account.id);
        return Boolean(current && current.connected && current.authStatus === 'connected' && current.tokenRef === account.tokenRef &&
          current.connectionGeneration === account.connectionGeneration && sameAccountIdentity(current.identity, account.identity));
      },
    });
    return defaultConnector;
  },
  verifyOAuthResult: async (result, stored) => {
    if (!defaultConnector || !await defaultConnector.verifyOAuthIdentity(result, stored)) return false;
    const known: AccountCapability[] = ['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write'];
    if (result.requestedCapabilities.some((item) => !known.includes(item)) || result.capabilities.some((item) => !result.requestedCapabilities.includes(item))) return false;
    if (result.requestedCapabilities.includes('calendar.write') && !result.requestedCapabilities.includes('calendar.read')) return false;
    return result.capabilities.every((item) => scopeGrantsCapability(result.provider, result.grantedScopes, item));
  },
};

defaultController = new AppControllerImpl(undefined, {}, defaultIntegration);
export const controller: AppController = defaultController;
export default controller;
