import * as Crypto from 'expo-crypto';
import type {
  Account, AccountConfig, AccountSyncState, AccountCapability, ActivityItem, AppController, AppSettings, AppState,
  Calendar, CalendarConfig, ContextDocument, Note, Proposal, ProposalPatch,
  SaveNoteInput, SettingsPatch, MailboxSnapshotMessage, CalendarEventSnapshot, OAuthInstallResult,
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
import { ConnectorClient } from '../connectors';
import { scopeGrantsCapability } from '../connectors/oauth';
import { oauthTokenStore, deleteOAuthToken } from '../auth/tokenStore';
import { Platform } from 'react-native';

const now = () => new Date().toISOString();
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
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const DEFAULT_SETTINGS: AppSettings = {
  mode: 'preview', timezone: validTimezone(), maxContextTokens: 6000, maxOutputTokens: 1200, monthlyBudgetUsd: 5,
  reasoningEffort: 'none', maxAttempts: 2, maxCallsPerDay: 20, maxAudioSeconds: 600, audioRetention: 'keep',
};

function initialState(): AppState {
  const day = localDate(DEFAULT_SETTINGS.timezone);
  return {
    notes: [], proposals: [], accounts: [], calendars: [], documents: [], activity: [],
    settings: { ...DEFAULT_SETTINGS },
    usage: { month: day.slice(0, 7), day, requests: 0, attemptsToday: 0, inputTokens: 0, outputTokens: 0, transcriptionSeconds: 0, attempts: 0, unknownCharges: 0, reservedUsd: 0, priceKnown: false, estimatedCostUsd: 0 },
    mailbox: [], calendarEvents: [], syncStates: {},
  };
}

function emptySyncState(accountId: string): AccountSyncState {
  return { accountId, status: 'idle', messagesPartial: false, calendarsPartial: false, eventCursors: {}, eventsCompletedAt: {} };
}

function addActivity(state: AppState, type: ActivityItem['type'], message: string, refs: Partial<ActivityItem> = {}): void {
  state.activity.unshift({ id: newId(), type, message, createdAt: now(), ...refs });
  state.activity = state.activity.slice(0, 250);
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

function identityKey(account: Account): string {
  const identity = account.identity;
  if (!identity?.providerNamespace || !identity.clientId || !identity.subject ||
      (account.provider === 'microsoft' && !identity.resourceUserId)) throw new Error('Verified account identity is incomplete.');
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
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

function normalizeLoadedState(value: unknown): AppState {
  const defaults = initialState();
  if (!value || typeof value !== 'object') throw new Error('Saved app data is not a valid state snapshot. It was preserved for recovery.');
  const raw = value as Partial<AppState>;
  if (!Array.isArray(raw.notes) || !Array.isArray(raw.proposals) || !Array.isArray(raw.accounts) ||
      !Array.isArray(raw.calendars) || !Array.isArray(raw.documents) || !Array.isArray(raw.activity)) {
    throw new Error('Saved app data is incomplete. It was preserved for recovery.');
  }
  const notes = raw.notes.map((note) => ({ ...note, revision: Number.isFinite(note.revision) ? note.revision : 1 }));
  const proposals = raw.proposals.map((proposal) => {
    const source = notes.find((note) => note.id === proposal.noteId);
    return {
      ...proposal, recipients: Array.isArray(proposal.recipients) ? proposal.recipients : [],
      evidence: Array.isArray(proposal.evidence) ? proposal.evidence : [],
      revision: Number.isFinite(proposal.revision) ? proposal.revision : 1,
      sourceRevision: Number.isFinite(proposal.sourceRevision) ? proposal.sourceRevision : source?.revision ?? 1,
    };
  });
  return {
    ...defaults, ...raw, notes, proposals,
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
    settings: { ...DEFAULT_SETTINGS, ...raw.settings, timezone: validTimezone(raw.settings?.timezone) },
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
  private analysisCache = new Map<string, DraftAnalysis['proposals']>();
  private mirrorDirty = new Set<string>();
  private readonly speechClient: AzureSpeechClient;
  private readonly openAiClient: AzureOpenAIClient;
  private readonly connector?: ConnectorClient;
  private activeSyncCount = 0;
  private syncQueue: (() => void)[] = [];
  private syncJobs = new Map<string, Promise<AccountSyncState>>();
  private syncGeneration = new Map<string, number>();
  private syncAbortControllers = new Map<string, AbortController>();

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
  private invalidate(proposal: Proposal): void {
    proposal.revision += 1;
    proposal.approvedRevision = undefined;
    proposal.approvedPayloadDigest = undefined;
    proposal.lastError = undefined;
    if (proposal.status === 'approved' || proposal.status === 'failed') proposal.status = 'draft';
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
    for (const proposal of this.state.proposals) {
      if (proposal.status === 'dispatching') {
        const remote = proposal.kind === 'email' || proposal.kind === 'event';
        proposal.status = remote ? 'unknown' : 'failed';
        proposal.approvedPayloadDigest = undefined;
        proposal.lastError = remote
          ? 'App closed while this external action was in progress. Check the destination manually; this action will not be retried.'
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
      const note: Note = {
        id: newId(), title: transcript ? transcript.split(/\s+/).slice(0, 7).join(' ').slice(0, 72) : 'Audio note',
        transcript, ...(input.audioUri ? { audioUri: input.audioUri } : {}),
        durationSeconds: Math.max(0, Math.round(input.durationSeconds ?? 0)), createdAt: now(), status: 'recorded', revision: 1,
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
      addActivity(state, 'note_saved', 'Transcript edited. Earlier approvals were cleared.', { noteId: id });
      return note;
    });
    return result;
  }

  async processNote(id: string): Promise<Proposal[]> {
    const existing = this.processJobs.get(id);
    if (existing) return existing;
    const job = this.runProcessNote(id).finally(() => this.processJobs.delete(id));
    this.processJobs.set(id, job);
    return job;
  }

  private async runProcessNote(id: string): Promise<Proposal[]> {
    const state = this.snapshot;
    const note = state.notes.find((item) => item.id === id);
    if (!note) throw new Error('Note was not found.');
    if (!note.transcript.trim()) throw new Error('This audio note has no transcript. Enter text or connect the speech provider before processing.');
    const sourceRevision = note.revision;
    const contextDocs = state.documents
      .filter(({ path }) => !path.startsWith('logs/') && path !== 'memory/INFERENCES.md' && path !== 'memory/DECISIONS.md')
      .map(({ path, revision }) => [path, revision]);
    const processingFingerprint = JSON.stringify({ transcript: note.transcript, sourceRevision, docs: contextDocs, settings: state.settings });
    if (state.settings.mode === 'provider' && note.processingFingerprint === processingFingerprint) {
      return state.proposals.filter((proposal) => proposal.noteId === id && proposal.sourceRevision === sourceRevision);
    }
    let created: Proposal[];
    let usage: DraftAnalysis | undefined;
    if (state.settings.mode === 'provider') {
      // Generated journals/inference/decision trails are outputs, not prompt context.
      // Including them would make a successful analysis invalidate its own cache.
      const cacheKey = processingFingerprint;
      let drafts = this.analysisCache.get(cacheKey);
      if (!drafts) {
        usage = await this.openAiClient.analyze(note, state.documents, state.settings, undefined, () => this.recordProviderAttempt('model', state.settings));
        await this.settleModelUsage(usage, state.settings);
        if (this.snapshot.notes.find((item) => item.id === id)?.revision !== sourceRevision) throw new Error('The transcript changed during processing. The provider result was discarded.');
        drafts = usage.proposals;
        this.analysisCache.set(cacheKey, drafts);
      }
      created = drafts.map((draft) => ({
        id: newId(), noteId: note.id, ...draft, status: 'draft', revision: 1,
        recipients: [...draft.recipients], sourceRevision: note.revision, evidence: draft.evidence.map((item) => ({ ...item })),
      }));
    } else created = extractPreviewProposals(note);

    const result = await this.mutate((draft) => {
      const current = this.note(draft, id);
      if (current.revision !== sourceRevision) throw new Error('The transcript changed during processing. Process the updated note again.');
      draft.proposals = [...created, ...draft.proposals.filter((proposal) =>
        proposal.noteId !== id || ['executed', 'accepted', 'simulated', 'dismissed', 'dispatching', 'unknown'].includes(proposal.status),
      )];
      current.status = 'processed';
      if (state.settings.mode === 'provider') current.processingFingerprint = processingFingerprint;
      const docs = [
        ...recordJournal(draft, `processed:${id}:r${sourceRevision}`, `Processed note ${current.title}; ${created.length} review suggestion(s) created.`),
        ...created.map((proposal) => appendInference(draft, proposal, state.settings.mode)),
      ];
      addActivity(draft, 'proposal_created', state.settings.mode === 'provider'
        ? `Azure OpenAI drafted ${created.length} suggestion${created.length === 1 ? '' : 's'} from this recorded note.`
        : `Preview mode extracted ${created.length} suggestion${created.length === 1 ? '' : 's'} from your transcript. No provider was contacted.`, { noteId: id });
      return { proposals: created, docs };
    });
    await Promise.all(result.docs.map((document) => this.mirrorDocument(document)));
    return result.proposals;
  }

  private providerReserve(settings: AppSettings, kind: 'model' | 'speech'): number {
    if (kind === 'model') {
      if (settings.inputUsdPerMillionTokens === undefined || settings.outputUsdPerMillionTokens === undefined) return 0;
      return settings.maxContextTokens * settings.inputUsdPerMillionTokens / 1_000_000 + settings.maxOutputTokens * settings.outputUsdPerMillionTokens / 1_000_000;
    }
    if (settings.speechUsdPerMinute === undefined) return 0;
    return settings.maxAudioSeconds / 60 * settings.speechUsdPerMinute;
  }

  private async recordProviderAttempt(kind: 'model' | 'speech', requestSettings: AppSettings): Promise<void> {
    await this.mutate((state) => {
      this.rollUsage(state);
      if (state.usage.attemptsToday >= state.settings.maxCallsPerDay) throw new Error('Daily provider call limit reached. Try again tomorrow or adjust the limit in Settings.');
      const reserve = this.providerReserve(requestSettings, kind);
      if (state.settings.monthlyBudgetUsd === 0) throw new Error('Provider requests are disabled while the monthly budget is set to zero.');
      if (state.usage.estimatedCostUsd + state.usage.reservedUsd + reserve > state.settings.monthlyBudgetUsd) throw new Error('The configured monthly budget does not have room for this bounded provider request.');
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
    const claimed = await this.mutate(async (state) => {
      const proposal = this.proposal(state, id);
      if (proposal.status !== 'approved' || proposal.approvedRevision !== proposal.revision || !proposal.approvedPayloadDigest) throw new Error('Approve this exact version before continuing.');
      const note = this.note(state, proposal.noteId);
      if (proposal.sourceRevision !== note.revision) throw new Error('The source transcript changed after approval. Review the suggestion again.');
      if (proposal.kind === 'reminder') {
        if (!proposal.dueAt) throw new Error('Add a date and time before saving this reminder.');
        if (Date.parse(proposal.dueAt) <= Date.now()) throw new Error('Reminder time must be in the future.');
      }
      if (await approvedDigest(proposal, state) !== proposal.approvedPayloadDigest) throw new Error('The approved content or destination changed. Review and approve it again.');
      if (proposal.kind === 'event' && !proposal.eventTransactionId) proposal.eventTransactionId = newId();
      proposal.status = 'dispatching';
      return proposal;
    });

    let result: ProposalStatusOutcome;
    if (claimed.kind === 'reminder') {
      const alert = await requestReminderNotification(claimed);
      result = { status: 'executed', notificationId: alert.status === 'scheduled' ? alert.notificationId : undefined, message: alert.status === 'scheduled'
        ? 'Reminder saved locally and an alert was scheduled on this device.'
        : alert.status === 'unavailable'
          ? 'Reminder saved locally. This browser does not provide alerts after its tab is closed.'
          : 'Reminder saved locally; alerts are disabled on this device.' };
    } else if (claimed.kind === 'task') {
      result = { status: 'executed', message: 'Task saved locally on this device.' };
    } else if (claimed.kind === 'memory') {
      try {
        const document = await this.mutate((state) => {
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
      const account = this.snapshot.accounts.find((item) => item.id === claimed.accountId);
      const operation = claimed.kind === 'email' ? claimed.email?.operation : claimed.kind === 'event' ? 'event' : undefined;
      const capability = operation === 'draft' ? 'mail.draft' : operation === 'send' ? 'mail.send' : operation === 'event' ? 'calendar.write' : undefined;
      const calendar = claimed.kind === 'event' ? this.snapshot.calendars.find((item) => item.id === claimed.calendarId) : undefined;
      if (this.snapshot.settings.mode !== 'provider' || !this.connector || !account || account.authStatus !== 'connected' || !account.connected || !capability || !account.capabilities?.includes(capability) ||
          (claimed.kind === 'event' && (!calendar || calendar.accountId !== account.id || !calendar.connected || !calendar.writable || !calendar.providerId))) {
        result = { status: 'simulated', message: `Simulation only: this ${claimed.kind === 'email' ? 'email' : 'calendar event'} was not sent or created in an external account because provider mode, verified identity, and the selected permission are required.` };
      } else {
        const envelope: ApprovedDispatch = {
          proposalId: claimed.id, revision: claimed.revision, sourceRevision: claimed.sourceRevision, operation: operation!,
          accountId: account.id, identity: clone(account.identity!), payloadDigest: claimed.approvedPayloadDigest!,
          title: claimed.title, body: claimed.body, calendarId: claimed.kind === 'event'
            ? this.snapshot.calendars.find((calendar) => calendar.id === claimed.calendarId)?.providerId
            : claimed.calendarId,
          payload: claimed.kind === 'email'
            ? clone(claimed.email!)
            : { ...clone(claimed.event!), title: claimed.event!.title ?? claimed.title, description: claimed.event!.description ?? claimed.body },
        };
        const verifier: DispatchVerifier = { verify: async (candidate) => {
          const currentState = this.snapshot;
          const current = currentState.proposals.find((item) => item.id === id);
          const currentAccount = currentState.accounts.find((item) => item.id === candidate.accountId);
          if (!current || !currentAccount || current.status !== 'dispatching' || current.revision !== candidate.revision ||
              current.approvedRevision !== candidate.revision || current.approvedPayloadDigest !== candidate.payloadDigest ||
              current.sourceRevision !== candidate.sourceRevision || current.accountId !== candidate.accountId ||
              !sameAccountIdentity(currentAccount.identity, candidate.identity) ||
              (current.kind === 'event'
                ? currentState.calendars.find((calendar) => calendar.id === current.calendarId)?.providerId !== candidate.calendarId
                : current.calendarId !== candidate.calendarId) ||
              await approvedDigest(current, currentState) !== candidate.payloadDigest) return false;
          return JSON.stringify(candidate.payload) === JSON.stringify(current.kind === 'email'
            ? current.email
            : { ...current.event, title: current.event?.title ?? current.title, description: current.event?.description ?? current.body });
        }, verifyBeforeDispatch: (candidate) => {
          const currentState = this.snapshot;
          const current = currentState.proposals.find((item) => item.id === id);
          const currentNote = current && currentState.notes.find((item) => item.id === current.noteId);
          const currentAccount = currentState.accounts.find((item) => item.id === candidate.accountId);
          const expectedCapability = candidate.operation === 'draft' ? 'mail.draft' : candidate.operation === 'send' ? 'mail.send' : 'calendar.write';
          if (!current || !currentNote || !currentAccount || currentState.settings.mode !== 'provider' ||
              current.status !== 'dispatching' || current.approvedRevision !== candidate.revision ||
              current.revision !== candidate.revision || current.approvedPayloadDigest !== candidate.payloadDigest ||
              current.sourceRevision !== currentNote.revision || current.sourceRevision !== candidate.sourceRevision ||
              current.accountId !== currentAccount.id || currentAccount.authStatus !== 'connected' || !currentAccount.connected ||
              currentAccount.connectionGeneration !== account.connectionGeneration || !currentAccount.capabilities?.includes(expectedCapability) ||
              !sameAccountIdentity(currentAccount.identity, candidate.identity)) return false;
          if (candidate.operation === 'event') {
            const target = currentState.calendars.find((item) => item.id === current.calendarId);
            if (!target || !target.connected || !target.writable || target.accountId !== currentAccount.id || target.providerId !== candidate.calendarId) return false;
          }
          if (candidate.operation === 'draft' || candidate.operation === 'send') return current.email?.operation === candidate.operation;
          return current.kind === 'event';
        } };
        try {
          const receipt: MutationReceipt = operation === 'draft'
            ? await this.connector.createDraft(account, envelope, verifier)
            : operation === 'send'
              ? await this.connector.sendEmail(account, envelope, verifier)
              : await this.connector.createEvent(account, this.snapshot.calendars.find((calendar) => calendar.id === claimed.calendarId)?.providerId ?? '', envelope, verifier, claimed.eventTransactionId!);
          result = receipt.status === 'unknown'
            ? { status: 'unknown', operation, message: 'The provider outcome is unknown. Check the destination manually; this action will not be retried.' }
            : { status: 'accepted', operation, remoteId: receipt.id, message: `The provider accepted the ${operation} request${receipt.id ? ` (reference ${receipt.id})` : ''}. Completion or delivery is not confirmed.` };
        } catch (error) {
          result = { status: 'failed', message: error instanceof Error ? error.message : 'The provider rejected the approved action.' };
        }
      }
    }

    return this.mutate((state) => {
      const proposal = this.proposal(state, id);
      if (proposal.status !== 'dispatching') throw new Error('Action state changed while execution was in progress.');
      proposal.status = result.status;
      proposal.simulated = result.status === 'simulated';
      proposal.lastError = result.status === 'failed' || result.status === 'unknown' ? result.message : undefined;
      if ('operation' in result && result.operation) proposal.remoteOperation = result.operation;
      if ('remoteId' in result && result.remoteId) proposal.remoteId = result.remoteId;
      if (result.status === 'accepted') proposal.remoteAcceptedAt = now();
      if (result.notificationId) {
        proposal.notificationId = result.notificationId;
        proposal.notificationRevision = proposal.revision;
      }
      addActivity(state, result.status === 'simulated' ? 'simulation' : result.status === 'failed' || result.status === 'unknown' ? 'error' : 'local_action', result.message, { proposalId: id, noteId: proposal.noteId });
      return proposal;
    });
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

  async saveDocument(path: string, content: string): Promise<ContextDocument> {
    const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanPath || cleanPath.split('/').some((part) => part === '.' || part === '..')) throw new Error('Document path must stay inside the app documents folder.');
    const document = await this.mutate((state) => {
      const existing = state.documents.find((item) => item.path === cleanPath);
      const next: ContextDocument = { path: cleanPath, content, revision: (existing?.revision ?? 0) + 1, updatedAt: now() };
      if (existing) Object.assign(existing, next); else state.documents.unshift(next);
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
    if (sanitized.maxOutputTokens !== undefined) sanitized.maxOutputTokens = finiteClamp(sanitized.maxOutputTokens, 64, 1200, 'Output token limit');
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
      if (state.proposals.some((item) => item.accountId === id && ['dispatching', 'unknown'].includes(item.status))) throw new Error('This account is part of an action whose result must be checked before changing its identity.');
      const prior = state.accounts.find((item) => item.id === id);
      const account: Account = { id, provider: config.provider, displayName: config.displayName.trim(), email, connected: false, authStatus: 'configured', grantedScopes: [], capabilities: [], syncStatus: 'idle', connectionGeneration: (prior?.connectionGeneration ?? 0) + 1 };
      if (prior) Object.assign(prior, account); else state.accounts.push(account);
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

  async installVerifiedAccount(config: AccountConfig, result: OAuthInstallResult, tokenRef: string): Promise<Account> {
    const tokenStore = this.integration.tokenStore;
    if (!tokenStore || !this.integration.verifyOAuthResult || !this.connector) throw new Error('Verified account connection is unavailable until the OAuth and connector services are configured.');
    if (!tokenRef || tokenRef.length > 200 || result.provider !== config.provider || !['google', 'microsoft'].includes(result.provider)) throw new Error('The verified sign-in does not match this account configuration.');
    const expectedClientId = this.integration.clientIds?.[result.provider];
    if (!expectedClientId || result.identity.providerNamespace !== result.provider || result.identity.clientId !== expectedClientId ||
        !result.identity.subject || (result.provider === 'microsoft' && !result.identity.resourceUserId) ||
        !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || !result.accessToken) throw new Error('The provider identity or token is incomplete or expired.');
    const stored = await tokenStore.get(tokenRef);
    if (!stored || stored.accessToken !== result.accessToken || stored.refreshToken !== result.refreshToken || stored.expiresAt !== result.expiresAt ||
        !sameAccountIdentity(stored.identity, result.identity)) throw new Error('The token stored for this connection does not match the verified sign-in result.');
    if (!await this.integration.verifyOAuthResult(result as OAuthBridgeResult, stored) || !await this.connector.verifyOAuthIdentity(result as OAuthBridgeResult, stored)) {
      throw new Error('The provider could not verify this account identity and granted access.');
    }
    const email = (result.email || config.email).trim().toLowerCase();
    if (!validEmail(email)) throw new Error('The verified account did not provide a valid email address.');
    const scopeCapabilities = grantedCapabilities(result.provider, result.grantedScopes);
    const effectiveCapabilities = intersectCapabilities(result.requestedCapabilities, result.capabilities, scopeCapabilities);
    const installed = await this.mutate((state) => {
      const existing = state.accounts.find((account) => sameAccountIdentity(account.identity, result.identity));
      const configured = config.id ? state.accounts.find((account) => account.id === config.id) : undefined;
      if (config.id) {
        const byId = configured;
        const reusablePlaceholder = byId && byId.provider === result.provider && !byId.identity && byId.authStatus === 'configured' && !byId.tokenRef;
        if (byId && !sameAccountIdentity(byId.identity, result.identity) && !reusablePlaceholder) throw new Error('Choose a new account entry for a different provider identity.');
        if (existing && existing.id !== config.id) throw new Error('This provider identity is already connected under another account entry.');
      }
      const prior = existing ?? configured;
      if (prior && state.proposals.some((item) => item.accountId === prior.id && ['dispatching', 'unknown'].includes(item.status))) throw new Error('Resolve the in-progress or unknown provider action before reconnecting this account.');
      const account: Account = {
        id: prior?.id ?? config.id ?? newId(), provider: result.provider,
        displayName: (result.displayName || config.displayName).trim(), email,
        connected: true, authStatus: 'connected', identity: clone(result.identity), tokenRef,
        grantedScopes: [...new Set(result.grantedScopes)], capabilities: effectiveCapabilities,
        capabilityLimits: [...result.requestedCapabilities], syncStatus: 'idle', configuredAt: prior?.configuredAt ?? now(),
        connectionGeneration: (prior?.connectionGeneration ?? 0) + 1,
      };
      if (state.accounts.some((candidate) => candidate.id === account.id && candidate !== prior)) throw new Error('Account identifier is already in use.');
      for (const proposal of state.proposals.filter((item) => item.accountId === account.id && ['draft', 'approved', 'failed'].includes(item.status))) {
        this.invalidate(proposal); proposal.status = 'draft';
      }
      if (prior) Object.assign(prior, account); else state.accounts.push(account);
      for (const calendar of state.calendars.filter((item) => item.accountId === account.id)) { calendar.connected = false; calendar.writable = false; }
      state.syncStates[account.id] ??= emptySyncState(account.id);
      addActivity(state, 'local_action', `${account.displayName || account.email} was connected after provider identity verification.`);
      return { account, priorTokenRef: prior?.tokenRef };
    });
    this.syncGeneration.set(installed.account.id, installed.account.connectionGeneration ?? 0);
    this.syncAbortControllers.get(installed.account.id)?.abort();
    if (installed.priorTokenRef && installed.priorTokenRef !== tokenRef && this.integration.deleteToken) {
      try { await this.integration.deleteToken(installed.priorTokenRef); }
      catch { await this.mutate((state) => addActivity(state, 'error', 'The previous secure account token could not be deleted after reconnect.')); }
    }
    return installed.account;
  }

  async disconnectAccount(id: string): Promise<Account> {
    this.syncGeneration.set(id, (this.syncGeneration.get(id) ?? 0) + 1);
    this.syncAbortControllers.get(id)?.abort();
    const account = await this.mutate((state) => {
      const current = state.accounts.find((item) => item.id === id);
      if (!current) throw new Error('Account was not found.');
      if (state.proposals.some((item) => item.accountId === id && ['dispatching', 'unknown'].includes(item.status))) throw new Error('Resolve the in-progress or unknown provider action before disconnecting this account.');
      current.authStatus = 'configured'; current.connected = false; current.capabilities = []; current.grantedScopes = []; current.syncStatus = 'idle';
      current.connectionGeneration = (current.connectionGeneration ?? 0) + 1;
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
    if (account.tokenRef) {
      if (!this.integration.deleteToken) throw new Error('Account was disconnected, but secure token deletion is not configured.');
      try { await this.integration.deleteToken(account.tokenRef); }
      catch { throw new Error('Account was disconnected, but its secure token could not be deleted. Retry disconnect to remove it.'); }
      return this.mutate((state) => {
        const current = state.accounts.find((item) => item.id === id);
        if (!current) throw new Error('Account was disconnected but could not be refreshed in local state.');
        current.tokenRef = undefined;
        return current;
      });
    }
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
    return JSON.stringify({ format: 'voice-assistant-export-v1', exportedAt: now(), ...clone(this.snapshot) }, null, 2);
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

type ProposalStatusOutcome = { status: 'executed' | 'simulated' | 'failed' | 'accepted' | 'unknown'; message: string; notificationId?: string; operation?: ApprovedDispatch['operation']; remoteId?: string };

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
