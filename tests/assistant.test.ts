import { describe, expect, it } from 'vitest';
import {
  assistantResponseSchema, buildLocalSourceInputs, buildLocalSourceSet, buildOfflinePreview, createSourceCatalog, selectContext, validateAssistantResponse,
} from '../src/assistant';
import type { AssistantSourceInput } from '../src/assistant/types';

const fakeSha256 = async (_bytes: Uint8Array) => 'a'.repeat(64);
const transcript: AssistantSourceInput = { id: 'transcript', revision: 3, text: 'I decided to call Mina tomorrow. The draft is ready.', required: true, kind: 'note', title: 'Current transcript' };
const rules: AssistantSourceInput = { id: 'doc:memory/RULES.md', revision: 2, text: 'Never send a message without my approval.', required: true, kind: 'document', title: 'Rules' };
const profile: AssistantSourceInput = { id: 'doc:memory/PROFILE.md', revision: 1, text: 'I work with Mina on the North project.', required: false, kind: 'document', title: 'Profile', updatedAt: '2026-10-10T00:00:00Z' };

describe('local assistant context and response validation', () => {
  it('builds immutable source fingerprints and retains exact source text', async () => {
    const catalog = await createSourceCatalog([transcript], fakeSha256);
    expect(catalog.byId.get('transcript')).toMatchObject({ revision: 3, text: transcript.text, contentHash: 'a'.repeat(64), version: `3:${'a'.repeat(64)}` });
    expect(Object.isFrozen(catalog.sources)).toBe(true);
  });

  it('normalizes line endings and Unicode before hashing source versions', async () => {
    let hashed = '';
    const catalog = await createSourceCatalog([{ id: 'transcript', revision: 1, text: 'Cafe\u0301\r\nnext', required: true }], async (bytes) => {
      hashed = new TextDecoder().decode(bytes);
      return 'c'.repeat(64);
    });
    expect(hashed).toBe('Café\nnext');
    expect(catalog.byId.get('transcript')?.text).toBe('Cafe\u0301\r\nnext');
  });

  it('keys remote local snapshots to immutable account identity and omits unbound records', () => {
    const inputs = buildLocalSourceInputs({
      transcript: { revision: 3, text: transcript.text },
      query: 'Planning Work Project mail', intent: 'answer',
      documents: [{ path: 'memory/RULES.md', revision: 2, content: rules.text }],
      tasks: [{ id: 'task-1', title: 'Call Mina', body: 'Confirm the plan.', status: 'open', dueAt: '2026-10-13' }],
      calendars: [
        { id: 'local-calendar', accountId: 'acct-1', identityKey: 'google:client:subject', providerId: 'Opaque==', name: 'Work', writable: true, connected: true },
        { id: 'unbound', accountId: 'acct-2', name: 'Unbound', writable: true, connected: true },
      ],
      calendarEvents: [{ id: 'event-local', accountId: 'acct-1', calendarId: 'local-calendar', providerEventId: 'evt/1', identityKey: 'google:client:subject', subject: 'Planning', start: '2026-10-13T09:00:00+08:00' }],
      mailbox: [
        { id: 'mail-local', accountId: 'acct-1', providerMessageId: 'msg/1', identityKey: 'google:client:subject', subject: 'Project', from: 'person@example.test', snippet: 'Details' },
        { id: 'mail-unbound', accountId: 'acct-2', providerMessageId: 'msg/2', identityKey: '', subject: 'Unbound' },
      ],
    });
    expect(inputs.map(({ id }) => id)).toContain('calendar:google%3Aclient%3Asubject:Opaque%3D%3D');
    expect(inputs.map(({ id }) => id)).toContain('calendar-event:google%3Aclient%3Asubject:Opaque%3D%3D:evt%2F1');
    expect(inputs.map(({ id }) => id)).toContain('mail:google%3Aclient%3Asubject:msg%2F1');
    expect(inputs.map(({ id }) => id)).not.toContain('calendar:unbound:unbound');
    expect(inputs.map(({ id }) => id)).not.toContain('mail::msg%2F2');
  });

  it('requires the full transcript and user rules, then ranks and omits bounded context', async () => {
    const routines: AssistantSourceInput = { id: 'doc:memory/ROUTINES.md', revision: 1, text: 'I review priorities each morning.', required: false, kind: 'document', title: 'Routines' };
    const many: AssistantSourceInput[] = [transcript, { ...rules, required: false }, routines, profile];
    for (let i = 0; i < 12; i++) many.push({ id: `doc:memory/${i}.md`, revision: 1, text: `North project background item ${i}.`, required: false, kind: 'document', updatedAt: `2026-10-${String(1 + i).padStart(2, '0')}T00:00:00Z` });
    const catalog = await createSourceCatalog(many, fakeSha256);
    const selection = selectContext(catalog, { query: 'project North', transcript: transcript.text, byteBudget: 5000, buildBody: (context) => JSON.stringify({ system: 'structured output schema', context }) });
    expect(selection.includedSourceIds).toContain('transcript');
    expect(selection.includedSourceIds).toContain('doc:memory/RULES.md');
    expect(selection.includedSourceIds).toContain('doc:memory/ROUTINES.md');
    expect(selection.includedSourceIds).toContain('doc:memory/PROFILE.md');
    expect(selection.includedSourceIds.length).toBeLessThanOrEqual(9);
    expect(selection.omittedSourceIds.length).toBeGreaterThan(0);
    expect(selection.context).toContain(transcript.text);
    expect(selection.context).toContain(rules.text);
  });

  it('accounts for Unicode JSON escaping and fails before dropping required transcript or rules', async () => {
    const catalog = await createSourceCatalog([transcript, rules], fakeSha256);
    let checkedBody = '';
    const body = (context: string) => { checkedBody = JSON.stringify({ schema: { properties: { summary: 'string', citations: [] } }, context }); return checkedBody; };
    const fullSelection = selectContext(catalog, { byteBudget: 5000, buildBody: body });
    const budget = new TextEncoder().encode(body(fullSelection.context)).length;
    const picked = selectContext(catalog, { byteBudget: budget, buildBody: body });
    expect(new TextEncoder().encode(body(picked.context)).length).toBeLessThanOrEqual(budget);
    expect(() => selectContext(catalog, { byteBudget: 10, buildBody: body })).toThrow(/required context source/i);
  });

  it('bounds preselection across large account snapshots and leaves irrelevant additions out of fingerprints', async () => {
    const mailbox = Array.from({ length: 10 }, (_, account) => Array.from({ length: 200 }, (_, index) => ({
      id: `${account}-${index}`, accountId: `acct-${account}`, identityKey: `google:client:${account}`,
      providerMessageId: `message-${index}`, subject: index === 199 ? 'Quarterly budget review' : `Unrelated ${account}-${index}`,
      snippet: index === 199 ? 'quarterly budget and forecast' : 'random status information',
    }))).flat();
    const base = { transcript: { revision: 1, text: 'Please review the quarterly budget.' }, query: 'quarterly budget', intent: 'answer' as const, mailbox };
    const selected = buildLocalSourceSet(base);
    expect(selected.sources.length).toBeLessThanOrEqual(200);
    expect(selected.omittedSourceCount).toBeGreaterThanOrEqual(1_800);
    expect(selected.omittedSourceIds.length).toBeLessThanOrEqual(100);
    expect(selected.sources.some(({ id }) => id.includes('message-199'))).toBe(true);
    const withIrrelevant = buildLocalSourceSet({ ...base, documents: [{ path: 'memory/irrelevant.md', revision: 1, content: 'An unrelated archival passage.' }] });
    expect(withIrrelevant.sources.map(({ id }) => id)).toEqual(selected.sources.map(({ id }) => id));

    const seenMaterials: string[] = [];
    const digest = async (bytes: Uint8Array) => {
      const value = new TextDecoder().decode(bytes);
      seenMaterials.push(value);
      let hash = 0;
      for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 0x45d9f3b) >>> 0;
      return hash.toString(16).padStart(8, '0').repeat(8);
    };
    const first = await createSourceCatalog(selected.sources, digest);
    const fresh = await createSourceCatalog(withIrrelevant.sources, digest);
    expect(first.sources.map(({ id, version }) => [id, version])).toEqual(fresh.sources.map(({ id, version }) => [id, version]));
    expect(seenMaterials.some((material) => material.includes('An unrelated archival passage.'))).toBe(false);
  });

  it('fingerprints the complete task index, including the zero-task case', async () => {
    const snapshot = { transcript: { revision: 1, text: '' }, query: 'How many tasks do I have?', intent: 'answer' as const };
    const digest = async (bytes: Uint8Array) => {
      let hash = 0;
      for (const char of new TextDecoder().decode(bytes)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x45d9f3b) >>> 0;
      return hash.toString(16).padStart(8, '0').repeat(8);
    };
    const empty = await createSourceCatalog(buildLocalSourceSet(snapshot).sources, digest);
    const populated = await createSourceCatalog(buildLocalSourceSet({ ...snapshot, tasks: [
      ...Array.from({ length: 2_000 }, (_, index) => ({ id: `t-${index}`, title: 'Task', body: '', status: index === 1_999 ? 'open' : 'completed', dueAt: index === 1_999 ? '2026-10-20' : undefined })),
    ] }).sources, digest);
    expect(empty.byId.get('task:index')?.version).toBeDefined();
    expect(populated.byId.get('task:index')?.version).not.toBe(empty.byId.get('task:index')?.version);
    expect(populated.byId.get('task:index')?.text).toContain('2000 total; 1 open; 1999 completed');
  });

  it('caps catalog iteration and rejects duplicate or oversized sources', async () => {
    await expect(createSourceCatalog(Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, revision: 1, text: 'x', required: false })), fakeSha256)).rejects.toThrow(/200 sources/i);
    await expect(createSourceCatalog([{ ...transcript }, { ...transcript }], fakeSha256)).rejects.toThrow(/unique/i);
    await expect(createSourceCatalog([{ ...transcript, text: 'x'.repeat(300_000) }], fakeSha256)).rejects.toThrow(/too large/i);
  });

  it('validates source revision, normalized source version, and exact quotes against included excerpts', async () => {
    const catalog = await createSourceCatalog([transcript, rules, profile], fakeSha256);
    const selection = selectContext(catalog, { query: 'North', byteBudget: 4000, buildBody: (context) => JSON.stringify({ context }) });
    const good = {
      summary: 'The note mentions a decision.', answer: 'The transcript says this.',
      decisions: [{ text: 'call Mina tomorrow', sourceId: 'transcript', revision: 3, sourceVersion: catalog.byId.get('transcript')!.version, quote: 'I decided to call Mina tomorrow.' }],
      citations: [{ sourceId: 'transcript', revision: 3, sourceVersion: catalog.byId.get('transcript')!.version, quote: 'The draft is ready.' }],
      clarifications: [], proposals: [{ kind: 'task', title: 'Call Mina', body: 'Call Mina tomorrow.', recipients: [], dueAt: null, evidence: ['I decided to call Mina tomorrow.'] }],
      memorySuggestions: [],
    };
    expect(validateAssistantResponse(good, catalog, selection).citations[0].source).toBe('Current transcript');
    expect(() => validateAssistantResponse({ ...good, citations: [{ ...good.citations[0], revision: 2 }] }, catalog, selection)).toThrow(/stale source revision/i);
    expect(() => validateAssistantResponse({ ...good, citations: [{ ...good.citations[0], sourceVersion: `3:${'b'.repeat(64)}` }] }, catalog, selection)).toThrow(/different source version/i);
    expect(() => validateAssistantResponse({ ...good, citations: [{ ...good.citations[0], quote: 'The draft is nearly ready.' }] }, catalog, selection)).toThrow(/exact quote/i);
    expect(() => validateAssistantResponse({ ...good, proposals: [{ ...good.proposals[0], evidence: [] }] }, catalog, selection)).toThrow(/exact transcript quote/i);
    expect(() => validateAssistantResponse({ ...good, decisions: [{ ...good.decisions[0], sourceId: 'doc:memory/PROFILE.md', revision: 1, sourceVersion: catalog.byId.get('doc:memory/PROFILE.md')!.version, quote: 'I decided to call Mina tomorrow.' }] }, catalog, selection)).toThrow(/exact quote/i);
  });

  it('rejects citations to a source whose selected excerpt was omitted', async () => {
    const long: AssistantSourceInput = { id: 'doc:memory/large.md', revision: 1, text: 'Private context '.repeat(300), required: false, kind: 'document' };
    const catalog = await createSourceCatalog([transcript, rules, long], fakeSha256);
    const selection = selectContext(catalog, { byteBudget: 500, buildBody: (context) => JSON.stringify({ context }) });
    expect(selection.omittedSourceIds).toContain(long.id);
    const bad = { summary: '', answer: '', decisions: [], citations: [{ sourceId: long.id, revision: 1, sourceVersion: catalog.byId.get(long.id)!.version, quote: 'Private context' }], clarifications: [], proposals: [], memorySuggestions: [] };
    expect(() => validateAssistantResponse(bad, catalog, selection)).toThrow(/exact quote/i);
  });

  it('cuts oversized supplemental context around a lexical match without changing source text', async () => {
    const long: AssistantSourceInput = { id: 'doc:project/notes.md', revision: 5, text: `${'irrelevant '.repeat(300)}Needle phrase goes here.`, required: false, kind: 'document' };
    const catalog = await createSourceCatalog([transcript, rules, long], fakeSha256);
    const selection = selectContext(catalog, { query: 'Needle', byteBudget: 800, buildBody: (context) => JSON.stringify({ context }) });
    expect(selection.includedSourceIds).toContain(long.id);
    expect(selection.excerpts[long.id]).toContain('Needle phrase goes here.');
    expect(catalog.byId.get(long.id)?.text.startsWith('irrelevant')).toBe(true);
  });

  it('emits strict one-response schema and safe deterministic offline answers', () => {
    expect(assistantResponseSchema.required).toEqual(['summary', 'answer', 'decisions', 'citations', 'clarifications', 'proposals', 'memorySuggestions']);
    const empty = buildOfflinePreview({ intent: 'assist', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z' });
    expect(empty.summary).toContain('No transcript text');
    expect(empty.answer).toContain('AI is not connected');
    const upcoming = buildOfflinePreview({ intent: 'answer', question: 'What meetings are upcoming tomorrow?', transcript: transcript.text, timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z' });
    expect(upcoming.answer).toContain('can’t verify');
    expect(upcoming.clarifications).toHaveLength(1);
    expect(upcoming.proposals).toEqual([]);
    const localEvents = buildOfflinePreview({ intent: 'answer', question: 'What meetings are upcoming tomorrow?', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', calendarSnapshotAvailable: true,
      calendarEvents: [{ subject: 'Planning', start: '2026-10-13T09:00:00+08:00', timeZone: 'Asia/Singapore' }], tasks: [{ title: 'Call Mina', status: 'open' }] });
    expect(localEvents.answer).toContain('Planning');
    const taskCount = buildOfflinePreview({ intent: 'answer', question: 'How many tasks do I have?', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', tasks: [{ title: 'Call Mina', status: 'open' }, { title: 'Send notes', status: 'completed' }] });
    expect(taskCount.answer).toContain('1 open, 1 completed, and 2 total tasks');
    const openCount = buildOfflinePreview({ intent: 'answer', question: 'How many open tasks do I have?', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', tasks: [{ title: 'Call Mina', status: 'open' }, { title: 'Send notes', status: 'completed' }] });
    expect(openCount.answer).toContain('1 open task');
    const completedCount = buildOfflinePreview({ intent: 'answer', question: 'How many completed tasks are there?', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', tasks: [{ title: 'Call Mina', status: 'open' }, { title: 'Send notes', status: 'completed' }] });
    expect(completedCount.answer).toContain('1 completed task');
    const reversedOrder = buildOfflinePreview({ intent: 'answer', question: 'How many tasks are open?', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', tasks: [{ title: 'Call Mina', status: 'open' }] });
    expect(reversedOrder.answer).toContain('1 open task');
    const totalCount = buildOfflinePreview({ intent: 'answer', question: 'How many total tasks do I have?', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', tasks: [{ title: 'Call Mina', status: 'open' }] });
    expect(totalCount.answer).toContain('1 task in total');
    const noTasks = buildOfflinePreview({ intent: 'answer', question: 'How many open tasks do I have?', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', tasks: [] });
    expect(noTasks.answer).toContain('0 open tasks');
    const dueDateQuestion = buildOfflinePreview({ intent: 'answer', question: 'How many tasks are due tomorrow?', transcript: '', timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', tasks: [{ title: 'Call Mina', status: 'open', dueAt: '2026-10-13' }] });
    expect(dueDateQuestion.answer).toContain('can’t verify current tasks');
    const decision = buildOfflinePreview({ intent: 'extract', transcript: transcript.text, timeZone: 'Asia/Singapore', now: '2026-10-12T00:00:00Z', transcriptRevision: 3, transcriptSourceVersion: `3:${'a'.repeat(64)}` });
    expect(decision.decisions[0]).toMatchObject({ sourceId: 'transcript', revision: 3, quote: 'I decided to call Mina tomorrow.' });
  });
});
