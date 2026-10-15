import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalMailReplySource } from '../src/mailReply';
import { assistantReplyTextSchema } from '../src/services/assistantWire';
import { OPENROUTER_BATCH_BODY_MODEL, OPENROUTER_BATCH_MODEL } from '../src/services/openRouter';
import { buildOpenRouterPeriodSummaryRequest, createOpenRouterPeriodSummaryBinding, validateOpenRouterPeriodSummaryBinding } from '../src/services/openRouterPeriodSummary';
import { capturePeriodSummarySources } from '../src/cloud/periodSummarySources.node';
import type { BackgroundSourceSelection } from '../server/src/backgroundContracts.js';
import { DocumentLineage } from '../server/src/documentLineage.js';
import { createDurableKernel, type JsonValue } from '../server/src/kernel.js';

const START = '2026-06-30T00:00:00.000Z';
const END = '2026-07-01T00:00:00.000Z';
const PREPARED = '2026-07-01T01:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = async (value: string) => sha(value);

function emptySelection(): BackgroundSourceSelection {
  return { notes: false, chat: false, tasks: false, decisions: false, acceptedInferences: false,
    mailAccounts: [], calendarAccounts: [], documentPaths: [], knowledge: [] };
}
function baseState(overrides: Record<string, unknown> = {}) {
  return { accounts: [], calendars: [], documents: [], notes: [], tasks: [], activity: [], settings: {}, usage: {}, mailbox: [],
    selectedMailTexts: [], calendarEvents: [], syncStates: {}, assistantChatLedger: { version: 1, conversations: [] },
    openRouterBatchLedger: { version: 1, jobs: [] }, knowledge: { schemaVersion: 1, people: [], projects: [], suggestions: [] }, ...overrides };
}
function fixture(state: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'still-summary-source-producers-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), validateSnapshot: (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid test snapshot');
  } });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, state as JsonValue);
  const token = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const lineage = new DocumentLineage(kernel, token);
  return { kernel, token, lineage, close() { kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}
function captureRequest(selection: BackgroundSourceSelection) {
  return { expectedPrivacyEpoch: 0, period: 'daily' as const, timeZone: 'UTC', localPeriodStart: '2026-06-30', localDeliveryTime: '08:00',
    preparedAt: PREPARED, selection };
}
async function assertProfile6RoundTrip(capture: Awaited<ReturnType<typeof capturePeriodSummarySources>>) {
  const destination = capture.destination.documentId ? { kind: 'existing' as const, documentId: capture.destination.documentId,
    path: capture.destination.path, expectedRevision: capture.destination.expectedRevision! } : {
    kind: 'absent' as const, documentId: null, path: capture.destination.path, expectedRevision: null,
    expectedAbsenceGeneration: capture.destination.expectedAbsenceGeneration! };
  const binding = await createOpenRouterPeriodSummaryBinding({ version: 1, requestProfileVersion: 6, operation: 'period_summary',
    policyId: randomUUID(), policyRevision: 1, policyDigest: sha('policy'), occurrenceId: randomUUID(), period: 'daily', timeZone: 'UTC',
    localInterval: { start: capture.interval.localStart, end: capture.interval.localEnd }, startUtc: capture.interval.startUtc,
    endUtc: capture.interval.endUtc, preparedAt: PREPARED, sources: capture.sources, destination,
    instructions: 'Summarize the supplied sources faithfully.', effort: 'none' }, digest);
  const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
  const persisted = await validateOpenRouterPeriodSummaryBinding(JSON.parse(JSON.stringify(binding)), digest);
  const replayed = await buildOpenRouterPeriodSummaryRequest(persisted, digest);
  expect(replayed.body).toBe(prepared.body);
}
const syncForMail = (accountId: string) => ({ [accountId]: { accountId, status: 'idle',
  mailHead: { status: 'idle', completeWindow: { from: START, through: END } }, mailBackfill: { status: 'idle' },
  messagesPartial: false, calendarsPartial: false, eventCursors: {}, eventsCompletedAt: {} } });

describe('period summary source producers', () => {
  it('captures plain message text from the canonical mail source envelope and defers extracted excerpts', async () => {
    const accountId = 'account.mail'; const localMessageId = randomUUID(); const providerMessageId = 'provider-message';
    const identity = { providerNamespace: 'google' as const, clientId: 'client', subject: 'subject' };
    const identityKey = 'google:client:subject:';
    const account = { id: accountId, provider: 'google', displayName: 'Mail', email: 'owner@example.test', connected: true, authStatus: 'connected',
      identity, tokenRef: 'test-ref', grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], capabilities: ['mail.read'], connectionGeneration: 4 };
    const row = { id: localMessageId, accountId, providerMessageId, idFormat: 'gmail', identityKey: `${identityKey}:${providerMessageId}`,
      verifiedIdentityKey: identityKey, connectionGeneration: 4, internetMessageId: '<message@example.test>', replyMetadataComplete: true,
      receivedAt: '2026-06-30T12:00:00.000Z', observedAt: '2026-06-30T12:05:00.000Z', subject: 'Planning', from: 'sender@example.test' };
    const envelope = { version: 1 as const, accountId, accountEmail: account.email, identity, connectionGeneration: 4, localMessageId,
      providerMessageId, idFormat: 'gmail' as const, internetMessageId: row.internetMessageId, subject: row.subject, from: row.from,
      replyMetadataComplete: true as const, observedAt: row.observedAt, sourceDigest: '0'.repeat(64) };
    const sourceDigest = sha(canonicalMailReplySource(envelope));
    const body = (representation: 'plain' | 'converted_html', completeness: 'complete_text' | 'excerpt', omissionReasons: string[], text: string) => ({
      version: 1 as const, messageId: localMessageId, accountId, identityKey, identity, connectionGeneration: 4, providerMessageId,
      idFormat: 'gmail' as const, sourceDigest, checkedAt: '2026-06-30T12:06:00.000Z', text, textDigest: sha(text), bytes: Buffer.byteLength(text),
      extractionVersion: representation === 'plain' ? 'mail-text-v1' as const : 'mail-text-v2' as const,
      representation, completeness, omissionReasons });
    const selection = { ...emptySelection(), mailAccounts: [{ accountId, expectedConnectionGeneration: 4 }] };

    const full = fixture(baseState({ accounts: [account], mailbox: [row], selectedMailTexts: [body('plain', 'complete_text', [], 'Full retained message.')],
      syncStates: syncForMail(accountId) }));
    try {
      const capture = capturePeriodSummarySources(full.kernel, full.token, full.lineage, captureRequest(selection));
      expect(capture.outcome, JSON.stringify(capture)).toBe('ready');
      expect(capture.sources.map((item) => item.id)).toEqual([`mail:${localMessageId}`]);
      await assertProfile6RoundTrip(capture);
    } finally { full.close(); }

    const excerpt = fixture(baseState({ accounts: [account], mailbox: [row], selectedMailTexts: [body('converted_html', 'excerpt', ['conversion_incomplete'], 'Retained excerpt.')],
      syncStates: syncForMail(accountId) }));
    try {
      const capture = capturePeriodSummarySources(excerpt.kernel, excerpt.token, excerpt.lineage, captureRequest(selection));
      expect(capture.outcome).toBe('deferred_sources');
      expect(capture.omissions).toContainEqual({ sourceId: `mail:${localMessageId}`, reason: 'mail_body_incomplete',
        mailBodyProvenance: { representation: 'converted_html', completeness: 'excerpt', extractionVersion: 'mail-text-v2',
          omissionReasons: ['conversion_incomplete'] } });
    } finally { excerpt.close(); }
  });

  it('captures ordinary completed chat turns with their actual private note, turn, and completed-job links', async () => {
    const conversationId = randomUUID(); const turnId = randomUUID(); const noteId = randomUUID(); const jobId = randomUUID();
    const createdAt = '2026-06-30T12:00:00.000Z';
    const requestBody = JSON.stringify({ model: OPENROUTER_BATCH_BODY_MODEL, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
      reasoning: { effort: 'none', exclude: true }, response_format: { type: 'json_schema', json_schema: { name: 'mail_reply_body', strict: true,
        schema: assistantReplyTextSchema } }, stream: false });
    const job = { id: jobId, customId: jobId, kind: 'note_assistance', status: 'completed', createdAt, updatedAt: createdAt, batchId: 'batch-1',
      model: OPENROUTER_BATCH_MODEL, effort: 'none', requestSha256: sha(requestBody), unknownCharge: true, settingsFingerprint: sha('settings'),
      sourceFingerprint: sha('sources'), requestProfileVersion: 1, requestBytes: Buffer.byteLength(requestBody), omittedSourceCount: 0,
      requestBody, sourceVersions: {}, noteId, noteRevision: 1, intent: 'assist', capturedAt: createdAt, captureTimeZone: 'UTC',
      chatBinding: { conversationId, turnId, context: [], omittedTurnCount: 0 } };
    const userText = 'I will send the proposal tomorrow.';
    const reply = { answer: 'I will note that.', clarifications: [], completedAt: '2026-06-30T12:30:00.000Z', requestProfileVersion: 1,
      requestSha256: job.requestSha256, summary: 'Confirmed.' };
    const note = { id: noteId, title: 'Chat turn', transcript: userText, durationSeconds: 0, createdAt, status: 'processed', origin: 'assistant_chat', revision: 1 };
    const turn = { id: turnId, noteId, noteRevision: 1, jobId, userText, createdAt, captureTimeZone: 'UTC', reply,
      replySha256: sha(JSON.stringify(reply)) };
    const state = baseState({ notes: [note], assistantChatLedger: { version: 1, conversations: [{ id: conversationId, title: 'Chat', createdAt,
      updatedAt: '2026-06-30T13:00:00.000Z', turns: [turn] }] }, openRouterBatchLedger: { version: 1, jobs: [job] } });
    const f = fixture(state);
    try {
      const selection = { ...emptySelection(), chat: true };
      const capture = capturePeriodSummarySources(f.kernel, f.token, f.lineage, captureRequest(selection));
      expect(capture.outcome, JSON.stringify(capture)).toBe('ready');
      expect(capture.sources.map((item) => item.id)).toEqual([`chat:${turnId}`]);
      expect(capture.sources[0].content).toBe(`User: ${userText}\n\nAssistant: ${reply.summary}\n${reply.answer}`);
      expect(capture.sources[0].effectiveAt).toBe(createdAt);
      expect(capture.sources[0].observedAt).toBe(PREPARED);
      await assertProfile6RoundTrip(capture);
    } finally { f.close(); }

    const invalidReplyState = baseState({ notes: [note], assistantChatLedger: { version: 1, conversations: [{ id: conversationId, title: 'Chat', createdAt,
      updatedAt: '2026-06-30T13:00:00.000Z', turns: [{ ...turn, replySha256: sha('tampered') }] }] }, openRouterBatchLedger: { version: 1, jobs: [job] } });
    const invalid = fixture(invalidReplyState);
    try {
      const capture = capturePeriodSummarySources(invalid.kernel, invalid.token, invalid.lineage, captureRequest({ ...emptySelection(), chat: true }));
      expect(capture.outcome).toBe('deferred_sources');
      expect(capture.omissions).toEqual([{ sourceId: `chat:${turnId}`, reason: 'private_ledger_invalid' }]);
      expect(capture.sources).toEqual([]);
    } finally { invalid.close(); }
  });

  it('captures current provider decisions and accepted-inference facts alongside selected knowledge context', async () => {
    const noteId = randomUUID(); const personId = randomUUID(); const factId = randomUUID(); const suggestionId = randomUUID();
    const path = `memory/people/${personId}.md`; const capturedAt = '2026-06-30T10:00:00.000Z';
    const evidence = [{ sourceId: `note:${noteId}`, sourceVersion: 'r2', revision: 2, quote: 'I work at Example.' }];
    const suggestion = { id: suggestionId, revision: 1, targetRevision: 1, createdAt: capturedAt, updatedAt: capturedAt, reviewedAt: '2026-06-30T11:00:00.000Z',
      status: 'accepted', change: { type: 'add_fact', entityKind: 'person', entityId: personId, statement: 'Works at Example.' }, evidence };
    const fact = { id: factId, provenance: 'accepted_inference', createdAt: capturedAt, suggestionId, evidence, statement: 'Works at Example.' };
    const person = { id: personId, revision: 1, name: 'Rae', aliases: [], narrativePath: path, createdAt: capturedAt, updatedAt: capturedAt,
      facts: [fact], sourceLinks: [], contacts: [] };
    const note = { id: noteId, title: 'Meeting', transcript: 'I work at Example.', durationSeconds: 1, createdAt: capturedAt, capturedAt,
      status: 'processed', revision: 2, processingFingerprint: sha('analysis'), analysis: { noteId, sourceRevision: 2, intent: 'assist', fingerprint: sha('analysis'),
        analyzedAt: '2026-06-30T12:00:00.000Z', capturedAt, captureTimeZone: 'UTC', summary: '', answer: '',
        decisions: [{ sourceId: `note:${noteId}`, revision: 2, sourceVersion: 'r2', quote: 'I work at Example.', source: 'transcript', text: 'Works at Example.' }],
        citations: [], clarifications: [], proposalIds: [], source: 'provider', includedSourceIds: [], includedSources: [], omittedSourceIds: [],
        omittedSourceCount: 0, sourceVersions: {} } };
    const f = fixture(baseState({ notes: [note], documents: [{ path, content: 'Rae profile', revision: 1, updatedAt: capturedAt }],
      knowledge: { schemaVersion: 1, people: [person], projects: [], suggestions: [suggestion] } }));
    try {
      const selection = { ...emptySelection(), decisions: true, acceptedInferences: true, knowledge: [{ kind: 'person' as const, id: personId }] };
      const capture = capturePeriodSummarySources(f.kernel, f.token, f.lineage, captureRequest(selection));
      expect(capture.outcome).toBe('ready');
      expect(capture.sources.map((item) => item.kind)).toEqual(['accepted_inference', 'decision', 'person']);
      expect(capture.sources.find((item) => item.kind === 'person')?.content).toContain('Rae profile');
      await assertProfile6RoundTrip(capture);
    } finally { f.close(); }
  });

  it('round-trips note, task, calendar, document, and project captures through the strict profile-6 builder', async () => {
    const noteId = randomUUID(); const taskId = randomUUID(); const accountId = 'account.calendar';
    const accountKey = 'google:client:subject:'; const projectId = randomUUID();
    const at = '2026-06-30T10:00:00.000Z'; const documentPath = 'memory/projects/launch.md';
    const account = { id: accountId, provider: 'google', displayName: 'Calendar', email: 'owner@example.test', connected: true, authStatus: 'connected',
      identity: { providerNamespace: 'google' as const, clientId: 'client', subject: 'subject' }, tokenRef: 'synthetic-ref',
      grantedScopes: ['https://www.googleapis.com/auth/calendar.readonly'], capabilities: ['calendar.read'], connectionGeneration: 4 };
    const calendar = { id: 'local-calendar-id', accountId, providerId: 'provider-calendar-primary', name: 'Primary', writable: true, connected: true };
    const event = { id: 'local-event-id', accountId, calendarId: calendar.id, providerEventId: 'provider-event-id', subject: 'Planning',
      start: '2026-06-30T14:00:00.000Z', end: '2026-06-30T14:30:00.000Z', startUtcCertified: true, endUtcCertified: true,
      observedAt: '2026-06-30T13:00:00.000Z', verifiedIdentityKey: accountKey, connectionGeneration: 4 };
    const syncStates = { [accountId]: { accountId, status: 'idle', mailHead: { status: 'idle' }, mailBackfill: { status: 'idle' }, messagesPartial: false,
      calendarsPartial: false, calendarsCompletedAt: '2026-07-01T00:00:00.000Z', eventsTimeMin: START, eventsTimeMax: END,
      eventCursors: {}, eventsCompletedAt: { [calendar.id]: '2026-07-01T00:00:00.000Z' } } };
    const project = { id: projectId, revision: 3, name: 'Launch', aliases: [], narrativePath: documentPath, createdAt: at, updatedAt: at,
      facts: [], sourceLinks: [], members: [], status: 'active', goal: 'Ship the launch' };
    const note = { id: noteId, title: 'Meeting', transcript: 'We agreed to the launch plan.', durationSeconds: 1, createdAt: at, capturedAt: at,
      status: 'recorded', revision: 2 };
    const task = { id: taskId, title: 'Review launch plan', body: 'Check the final schedule.', status: 'completed', createdAt: at,
      completedAt: '2026-06-30T11:00:00.000Z' };
    const f = fixture(baseState({ accounts: [account], calendars: [calendar], calendarEvents: [event], syncStates, notes: [note], tasks: [task],
      documents: [{ path: documentPath, content: 'Launch project notes.', revision: 1, updatedAt: at }],
      knowledge: { schemaVersion: 1, people: [], projects: [project], suggestions: [] } }));
    try {
      const selection = { ...emptySelection(), notes: true, tasks: true, calendarAccounts: [{ accountId, expectedConnectionGeneration: 4 }],
        documentPaths: [documentPath], knowledge: [{ kind: 'project' as const, id: projectId }] };
      const capture = capturePeriodSummarySources(f.kernel, f.token, f.lineage, captureRequest(selection));
      expect(capture.outcome).toBe('ready');
      expect(capture.sources.map((item) => item.kind)).toEqual(['calendar', 'document', 'note', 'project', 'task', 'task']);
      for (const item of capture.sources) {
        expect((item.revision !== undefined) !== (item.version !== undefined)).toBe(true);
        if (item.kind === 'document') expect(item.documentPath).toBe(documentPath);
        else expect(item.documentPath).toBeUndefined();
      }
      await assertProfile6RoundTrip(capture);
    } finally { f.close(); }
  });
});
