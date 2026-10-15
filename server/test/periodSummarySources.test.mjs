import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/kernel.js';
import { DocumentLineage } from '../dist/documentLineage.js';
import { ServerWorkspaceStore, composeSnapshotCommitParticipants } from '../dist/workspaceStore.js';
import { capturePeriodSummarySources, revalidatePeriodSummarySourceCapture, periodSummaryCaptureHasPrivateProof } from '../dist/periodSummarySources.node.mjs';

const START = '2026-06-30T00:00:00.000Z';
const END = '2026-07-01T00:00:00.000Z';
const PREPARED = '2026-07-01T01:00:00.000Z';
const baseSelection = () => ({ notes: false, chat: false, tasks: false, decisions: false, acceptedInferences: false,
  mailAccounts: [], calendarAccounts: [], documentPaths: [], knowledge: [] });
const baseState = (overrides = {}) => ({ accounts: [], calendars: [], documents: [], notes: [], tasks: [], activity: [], settings: {}, usage: {},
  mailbox: [], selectedMailTexts: [], calendarEvents: [], syncStates: {}, assistantChatLedger: { version: 1, conversations: [] },
  openRouterBatchLedger: { version: 1, jobs: [] }, knowledge: { schemaVersion: 1, people: [], projects: [], suggestions: [] }, ...overrides });

function setup(initial = baseState()) {
  const directory = mkdtempSync(join(tmpdir(), 'still-period-summary-sources-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const workspace = kernel.createWorkspace(ownerId, initial);
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const lineage = new DocumentLineage(kernel, sessionToken);
  const participant = lineage.createSnapshotCommitParticipant();
  const store = new ServerWorkspaceStore({ kernel, sessionToken,
    snapshotCommitParticipant: composeSnapshotCommitParticipants([{ name: 'lineage', participant }]) });
  return { directory, kernel, workspace, sessionToken, lineage, store, close() {
    kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

function request(selection = baseSelection(), overrides = {}) {
  return { expectedPrivacyEpoch: 0, period: 'daily', timeZone: 'UTC', localPeriodStart: '2026-06-30', localDeliveryTime: '08:00',
    preparedAt: PREPARED, selection, ...overrides };
}

test('capture resolves a completed DST period and produces private, frozen, stable no-event output', () => {
  const f = setup();
  try {
    const selection = baseSelection();
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection,
      { timeZone: 'America/New_York', localPeriodStart: '2026-03-08', preparedAt: '2026-03-10T00:00:00.000Z' }));
    assert.equal(capture.outcome, 'no_events');
    assert.equal(capture.interval.localEnd, '2026-03-09');
    assert.equal(Date.parse(capture.interval.endUtc) - Date.parse(capture.interval.startUtc), 23 * 60 * 60 * 1000);
    assert.equal(periodSummaryCaptureHasPrivateProof(capture), true);
    assert.equal(Object.isFrozen(capture.sources), true);
    assert.equal(capture.destination.path, 'memory/summaries/daily/2026-03-08.md');
    assert.throws(() => capture.sources.push({}), TypeError);
  } finally { f.close(); }
});

test('a skipped civil date is an empty no-event period and does not wait for remote coverage', () => {
  const f = setup();
  try {
    const selection = { ...baseSelection(), mailAccounts: [{ accountId: 'not-connected', expectedConnectionGeneration: 1 }] };
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection, {
      timeZone: 'Pacific/Apia', localPeriodStart: '2011-12-30', preparedAt: '2011-12-31T00:00:00.000Z' }));
    assert.equal(capture.interval.empty, true);
    assert.equal(capture.interval.localEnd, '2011-12-31');
    assert.equal(capture.outcome, 'no_events');
    assert.deepEqual(capture.omissions, []);
  } finally { f.close(); }
});

test('notes and separate task events are canonical, exact mode detects edits, membership preserves frozen content', async () => {
  const noteId = randomUUID(); const taskId = randomUUID();
  const f = setup(baseState({ notes: [{ id: noteId, title: 'N', transcript: 'original note text', durationSeconds: 1, createdAt: '2026-06-30T09:00:00.000Z',
    capturedAt: '2026-06-30T09:00:00.000Z', status: 'recorded', revision: 2 }], tasks: [{ id: taskId, title: 'Call client', body: 'Ask about timing',
      status: 'completed', createdAt: '2026-06-30T10:00:00.000Z', completedAt: '2026-06-30T11:00:00.000Z', sourceNoteId: noteId, sourceRevision: 2, proposalId: randomUUID() }] }));
  try {
    const selection = { ...baseSelection(), notes: true, tasks: true };
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection));
    assert.equal(capture.outcome, 'ready', JSON.stringify(capture));
    assert.deepEqual(capture.sources.map((item) => item.id), [`note:${noteId}`, `task:${taskId}:completed`, `task:${taskId}:created`].sort());
    assert.equal(capture.sources.find((item) => item.id === `note:${noteId}`).effectiveAt, '2026-06-30T09:00:00.000Z');
    assert.equal(capture.sources.find((item) => item.id === `note:${noteId}`).observedAt, PREPARED);
    assert.equal(capture.sources.find((item) => item.id === `task:${taskId}:created`).effectiveAt, '2026-06-30T10:00:00.000Z');
    assert.equal(capture.sources.find((item) => item.id === `task:${taskId}:created`).observedAt, PREPARED);
    const originalContent = capture.sources.find((item) => item.id === `note:${noteId}`).content;
    const state = await f.store.load();
    await f.store.save({ ...state, notes: state.notes.map((item) => item.id === noteId ? { ...item, transcript: 'edited later', revision: 3 } : item) });
    assert.throws(() => revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, capture, 'exact'), /capture_stale/);
    const membership = revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, capture, 'membership');
    assert.equal(membership.sources.find((item) => item.id === `note:${noteId}`).content, originalContent);
  } finally { f.close(); }
});

test('selected mail distinguishes incomplete coverage from missing complete body material', () => {
  const accountId = 'account.synthetic';
  const selection = { ...baseSelection(), mailAccounts: [{ accountId, expectedConnectionGeneration: 4 }] };
  const account = { id: accountId, provider: 'google', displayName: 'Synthetic', email: 'person@example.test', connected: true, authStatus: 'connected',
    identity: { providerNamespace: 'google', clientId: 'client', subject: 'subject' }, tokenRef: 'synthetic-ref', grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    capabilities: ['mail.read'], connectionGeneration: 4 };
  const f = setup(baseState({ accounts: [account], syncStates: { [accountId]: { accountId, status: 'idle', mailHead: { status: 'idle' },
    mailBackfill: { status: 'idle' }, messagesPartial: false, calendarsPartial: false, eventCursors: {}, eventsCompletedAt: {} } } }));
  try {
    const uncovered = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection));
    assert.equal(uncovered.outcome, 'deferred_coverage');
    const state = baseState({ accounts: [account], mailbox: [{ id: 'local-message', accountId, providerMessageId: 'provider-message', idFormat: 'gmail',
      identityKey: 'google:client:subject::provider-message', verifiedIdentityKey: 'google:client:subject:', connectionGeneration: 4,
      internetMessageId: '<provider@example.test>', receivedAt: '2026-06-30T12:00:00.000Z', observedAt: '2026-06-30T12:30:00.000Z',
      replyMetadataComplete: true }], syncStates: { [accountId]: { accountId, status: 'idle',
        mailHead: { status: 'idle', completeWindow: { from: START, through: END } }, mailBackfill: { status: 'idle' }, messagesPartial: false,
        calendarsPartial: false, eventCursors: {}, eventsCompletedAt: {} } } });
    const g = setup(state);
    try {
      const noBody = capturePeriodSummarySources(g.kernel, g.sessionToken, g.lineage, request(selection));
      assert.equal(noBody.outcome, 'deferred_sources');
      assert.equal(noBody.omissions.some((item) => item.reason === 'mail_body_missing'), true);
    } finally { g.close(); }
  } finally { f.close(); }
});

test('calendar events bind provider identity and current grant authority separately from local calendar ID', async () => {
  const accountId = 'account.calendar'; const accountKey = 'google:client:subject:';
  const account = { id: accountId, provider: 'google', displayName: 'Synthetic', email: 'person@example.test', connected: true, authStatus: 'connected',
    identity: { providerNamespace: 'google', clientId: 'client', subject: 'subject' }, tokenRef: 'synthetic-ref', grantedScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    capabilities: ['calendar.read'], connectionGeneration: 4 };
  const calendar = { id: 'local-calendar-id', accountId, providerId: 'provider-calendar-primary', name: 'Primary', writable: true, connected: true };
  const event = { id: 'local-event-id', accountId, calendarId: calendar.id, providerEventId: 'provider-event-id', subject: 'Planning',
    start: '2026-06-30T14:00:00.000Z', end: '2026-06-30T14:30:00.000Z', startUtcCertified: true, endUtcCertified: true,
    observedAt: '2026-06-30T13:00:00.000Z', verifiedIdentityKey: accountKey, connectionGeneration: 4 };
  const syncStates = { [accountId]: { accountId, status: 'idle', mailHead: { status: 'idle' }, mailBackfill: { status: 'idle' }, messagesPartial: false,
    calendarsPartial: false, calendarsCompletedAt: '2026-07-01T00:00:00.000Z', eventsTimeMin: START, eventsTimeMax: END,
    eventCursors: {}, eventsCompletedAt: { [calendar.id]: '2026-07-01T00:00:00.000Z' } } };
  const f = setup(baseState({ accounts: [account], calendars: [calendar], calendarEvents: [event], syncStates }));
  try {
    const selection = { ...baseSelection(), calendarAccounts: [{ accountId, expectedConnectionGeneration: 4 }] };
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection));
    assert.equal(capture.outcome, 'ready');
    assert.equal(capture.sources[0].id, 'calendar:local-event-id');
    const loaded = await f.store.load();
    const next = structuredClone(loaded);
    next.accounts[0].capabilityLimits = [];
    await f.store.save(next);
    assert.throws(() => revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, capture, 'membership'), /capture_source_removed/);
    const current = await f.store.load();
    const restored = structuredClone(current);
    delete restored.accounts[0].capabilityLimits;
    await f.store.save(restored);
    const scopeCapture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection));
    assert.equal(scopeCapture.outcome, 'ready');
    const noScope = await f.store.load();
    const revoked = structuredClone(noScope);
    revoked.accounts[0].grantedScopes = [];
    await f.store.save(revoked);
    assert.throws(() => revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, scopeCapture, 'membership'), /capture_source_removed/);
  } finally { f.close(); }
});

test('generated summaries stay excluded and selected context gaps are surfaced', () => {
  const f = setup(baseState({ documents: [{ path: 'memory/summaries/daily/2026-06-30.md', content: 'prior generated output', revision: 1, updatedAt: PREPARED }] }));
  try {
    const selected = { ...baseSelection(), documentPaths: ['memory/summaries/daily/2026-06-30.md', 'notes/missing.md'] };
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selected));
    assert.equal(capture.outcome, 'deferred_sources');
    assert.equal(capture.sources.some((item) => item.documentPath?.startsWith('memory/summaries/')), false);
    assert.equal(capture.omissions.some((item) => item.sourceId === 'document:notes/missing.md'), true);
    assert.equal(capture.omissions.some((item) => item.reason === 'generated_summary_excluded'), true);
    const onlyGenerated = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request({ ...baseSelection(),
      documentPaths: ['memory/summaries/daily/2026-06-30.md'] }));
    assert.equal(onlyGenerated.outcome, 'no_events');
    assert.deepEqual(onlyGenerated.omissions, [{ sourceId: 'document:memory/summaries/daily/2026-06-30.md', reason: 'generated_summary_excluded' }]);
  } finally { f.close(); }
});

test('blank selected notes are explicitly deferred instead of silently omitted', () => {
  const noteId = randomUUID();
  const f = setup(baseState({ notes: [{ id: noteId, title: 'Empty', transcript: ' \n ', durationSeconds: 1, createdAt: '2026-06-30T09:00:00.000Z',
    capturedAt: '2026-06-30T09:00:00.000Z', status: 'recorded', revision: 1 }] }));
  try {
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request({ ...baseSelection(), notes: true }));
    assert.equal(capture.outcome, 'deferred_sources');
    assert.deepEqual(capture.omissions, [{ sourceId: `note:${noteId}`, reason: 'missing_transcript' }]);
  } finally { f.close(); }
});

test('exact revalidation rejects removed remote coverage even when a local note remains', async () => {
  const noteId = randomUUID(); const accountId = 'account.coverage';
  const account = { id: accountId, provider: 'google', displayName: 'Mail', email: 'owner@example.test', connected: true, authStatus: 'connected',
    identity: { providerNamespace: 'google', clientId: 'client', subject: 'subject' }, tokenRef: 'synthetic-ref',
    grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], capabilities: ['mail.read'], connectionGeneration: 4 };
  const state = baseState({ accounts: [account], notes: [{ id: noteId, title: 'N', transcript: 'Still here', durationSeconds: 1,
    createdAt: '2026-06-30T09:00:00.000Z', capturedAt: '2026-06-30T09:00:00.000Z', status: 'recorded', revision: 1 }],
    syncStates: { [accountId]: { accountId, status: 'idle', mailHead: { status: 'idle', completeWindow: { from: START, through: END } },
      mailBackfill: { status: 'idle' }, messagesPartial: false, calendarsPartial: false, eventCursors: {}, eventsCompletedAt: {} } } });
  const f = setup(state);
  try {
    const selection = { ...baseSelection(), notes: true, mailAccounts: [{ accountId, expectedConnectionGeneration: 4 }] };
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection));
    assert.equal(capture.outcome, 'ready');
    const loaded = await f.store.load();
    const next = structuredClone(loaded);
    delete next.syncStates[accountId].mailHead.completeWindow;
    await f.store.save(next);
    assert.throws(() => revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, capture, 'exact'), /capture_stale/);
  } finally { f.close(); }
});

test('exact revalidation rejects a newly eligible source that was absent from the frozen source set', async () => {
  const firstId = randomUUID(); const nextId = randomUUID();
  const note = (id, title) => ({ id, title, transcript: `${title} text`, durationSeconds: 1, createdAt: '2026-06-30T09:00:00.000Z',
    capturedAt: '2026-06-30T09:00:00.000Z', status: 'recorded', revision: 1 });
  const f = setup(baseState({ notes: [note(firstId, 'First')] }));
  try {
    const selection = { ...baseSelection(), notes: true };
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection));
    assert.equal(capture.outcome, 'ready');
    const loaded = await f.store.load();
    await f.store.save({ ...loaded, notes: [...loaded.notes, note(nextId, 'Newly eligible')] });
    assert.throws(() => revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, capture, 'exact'), /capture_stale/);
  } finally { f.close(); }
});

test('membership revalidation invalidates captured knowledge child deletions by typed locator', async (t) => {
  const scenarios = [
    ['person fact', 'person', 'facts', { id: 'fact-1', provenance: 'user_authored', createdAt: '2026-06-30T09:00:00.000Z', statement: 'Fact' }],
    ['person contact', 'person', 'contacts', { id: 'contact-1', provenance: 'user_authored', createdAt: '2026-06-30T09:00:00.000Z', address: 'a@example.test', label: 'Email' }],
    ['person source link', 'person', 'sourceLinks', { id: 'link-1', provenance: 'user_authored', createdAt: '2026-06-30T09:00:00.000Z', reference: { kind: 'note', id: 'source' }, label: 'Source' }],
    ['project fact', 'project', 'facts', { id: 'fact-1', provenance: 'user_authored', createdAt: '2026-06-30T09:00:00.000Z', statement: 'Fact' }],
    ['project source link', 'project', 'sourceLinks', { id: 'link-1', provenance: 'user_authored', createdAt: '2026-06-30T09:00:00.000Z', reference: { kind: 'note', id: 'source' }, label: 'Source' }],
    ['project member', 'project', 'members', { id: 'member-1', provenance: 'user_authored', createdAt: '2026-06-30T09:00:00.000Z', personId: randomUUID(), role: 'Owner' }],
  ];
  for (const [label, kind, field, child] of scenarios) await t.test(label, async () => {
    const entityId = randomUUID(); const noteId = randomUUID(); const narrativePath = `memory/${kind}s/${entityId}.md`;
    const entity = { id: entityId, revision: 1, name: 'Entity', aliases: [], narrativePath, createdAt: '2026-06-30T08:00:00.000Z',
      updatedAt: '2026-06-30T09:00:00.000Z', facts: [], sourceLinks: [], ...(kind === 'person' ? { contacts: [] } : { members: [], status: 'active', goal: 'Goal' }),
      [field]: [child] };
    const knowledge = { schemaVersion: 1, people: kind === 'person' ? [entity] : [], projects: kind === 'project' ? [entity] : [], suggestions: [] };
    const f = setup(baseState({ notes: [{ id: noteId, title: 'N', transcript: 'An event', durationSeconds: 1, createdAt: '2026-06-30T09:00:00.000Z',
      capturedAt: '2026-06-30T09:00:00.000Z', status: 'recorded', revision: 1 }], documents: [{ path: narrativePath, content: 'Entity narrative', revision: 1,
        updatedAt: '2026-06-30T09:00:00.000Z' }], knowledge }));
    try {
      const selection = { ...baseSelection(), notes: true, knowledge: [{ kind, id: entityId }] };
      const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection));
      assert.equal(capture.outcome, 'ready');
      const loaded = await f.store.load();
      const next = structuredClone(loaded);
      const target = kind === 'person' ? next.knowledge.people[0] : next.knowledge.projects[0];
      target[field] = [];
      await f.store.save(next);
      assert.throws(() => revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, capture, 'membership'), /capture_source_removed/);
    } finally { f.close(); }
  });
});

test('recreated knowledge child with the same ID but a new immutable creation time cannot revive captured membership', async () => {
  const entityId = randomUUID(); const noteId = randomUUID(); const factId = randomUUID(); const narrativePath = `memory/people/${entityId}.md`;
  const fact = { id: factId, provenance: 'user_authored', createdAt: '2026-06-30T09:00:00.000Z', statement: 'Original fact' };
  const person = { id: entityId, revision: 1, name: 'Person', aliases: [], narrativePath, createdAt: '2026-06-30T08:00:00.000Z',
    updatedAt: '2026-06-30T09:00:00.000Z', facts: [fact], sourceLinks: [], contacts: [] };
  const f = setup(baseState({ notes: [{ id: noteId, title: 'N', transcript: 'An event', durationSeconds: 1, createdAt: '2026-06-30T09:00:00.000Z',
    capturedAt: '2026-06-30T09:00:00.000Z', status: 'recorded', revision: 1 }], documents: [{ path: narrativePath, content: 'Narrative', revision: 1,
      updatedAt: '2026-06-30T09:00:00.000Z' }], knowledge: { schemaVersion: 1, people: [person], projects: [], suggestions: [] } }));
  try {
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request({ ...baseSelection(), notes: true,
      knowledge: [{ kind: 'person', id: entityId }] }));
    const loaded = await f.store.load();
    const next = structuredClone(loaded);
    next.knowledge.people[0].facts[0] = { ...fact, createdAt: '2026-06-30T10:00:00.000Z', statement: 'Recreated fact' };
    await f.store.save(next);
    assert.throws(() => revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, capture, 'membership'), /capture_source_removed/);
  } finally { f.close(); }
});

test('document delete and byte-identical same-path recreation changes the captured incarnation', async () => {
  const path = 'context/brief.md';
  const content = 'Stable bytes do not imply the same document incarnation.';
  const f = setup(baseState({ documents: [{ path, content, revision: 1, updatedAt: '2026-06-30T09:00:00.000Z' }] }));
  try {
    const selection = { ...baseSelection(), documentPaths: [path] };
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection));
    assert.equal(capture.outcome, 'no_events');
    const loaded = await f.store.load();
    await f.store.save({ ...loaded, documents: [] });
    const afterDelete = await f.store.load();
    await f.store.save({ ...afterDelete, documents: [{ path, content, revision: 1, updatedAt: '2026-06-30T09:00:00.000Z' }] });
    assert.throws(() => revalidatePeriodSummarySourceCapture(f.kernel, f.sessionToken, f.lineage, capture, 'membership'), /capture_source_removed/);
  } finally { f.close(); }
});

test('request rejects accessor and proxied selection values before entering the owned transaction', () => {
  const f = setup();
  try {
    const selection = baseSelection();
    Object.defineProperty(selection, 'notes', { enumerable: true, get() { throw new Error('getter_ran'); } });
    assert.throws(() => capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(selection)), /capture_invalid/);
    let proxyTrapCalls = 0;
    const proxied = new Proxy(baseSelection(), { ownKeys() { proxyTrapCalls += 1; throw new Error('proxy_ran'); } });
    assert.throws(() => capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, request(proxied)), /period_summary_capture_invalid/);
    assert.equal(proxyTrapCalls, 0);
  } finally { f.close(); }
});
