import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import * as Crypto from 'expo-crypto';
import { AzureOpenAIClient } from '../src/services/azure';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { buildLocalSourceSet, createSourceCatalog } from '../src/assistant';

class MemoryStore implements StateStore {
  value?: AppState;
  saves = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.saves += 1; this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

function createController(store = new MemoryStore()) {
  const fetcher = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Reviewed local context.', answer: '', decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [] }) }] }],
    usage: { input_tokens: 20, output_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const openAi = new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key');
  return { store, app: new AppControllerImpl(store, { openAi }, { writeDocument: async () => undefined }) };
}

async function enableProvider(app: AppControllerImpl) {
  await app.saveSettings({ mode: 'provider', openAiEndpoint: 'https://example.openai.azure.com', openAiDeployment: 'gpt-6-luna' });
}

describe('knowledge controller integration', () => {
  it('includes tasks linked to a selected project and excludes tasks linked only to an unselected archived project', async () => {
    const { app } = createController();
    await app.load();
    await enableProvider(app);
    const note = await app.saveNote({ transcript: 'What should I focus on today?' });
    const selected = await app.saveProject({ name: 'North Star', aliases: [], narrative: 'Current launch work.', status: 'active', goal: 'Ship the pilot.' });
    const archived = await app.saveProject({ name: 'Old Project', aliases: [], narrative: 'A finished effort.', status: 'completed', goal: 'Archive it.' });
    const internal = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> };
    await internal.mutate((state) => {
      state.tasks.push(
        { id: 'task-selected', title: 'Prepare the pilot', body: 'Finish the pilot checklist.', status: 'open', createdAt: note.createdAt, sourceNoteId: note.id, sourceRevision: note.revision, proposalId: 'proposal-selected' },
        { id: 'task-archived', title: 'Old invoice', body: 'Send the old invoice.', status: 'open', createdAt: note.createdAt, sourceNoteId: note.id, sourceRevision: note.revision, proposalId: 'proposal-archived' },
      );
    });
    await app.saveKnowledgeSourceLink({ entityKind: 'project', entityId: selected.id, expectedEntityRevision: selected.revision, reference: { kind: 'task', id: 'task-selected' }, label: 'Pilot task' });
    const selectedAfterTaskLink = app.getSnapshot().knowledge.projects.find((item) => item.id === selected.id)!;
    await app.saveKnowledgeSourceLink({ entityKind: 'project', entityId: selected.id, expectedEntityRevision: selectedAfterTaskLink.revision, reference: { kind: 'note', id: note.id }, label: 'Discussed in this note' });
    await app.saveKnowledgeSourceLink({ entityKind: 'project', entityId: archived.id, expectedEntityRevision: archived.revision, reference: { kind: 'task', id: 'task-archived' }, label: 'Old task' });
    await app.setKnowledgeEntityArchived({ kind: 'project', id: archived.id, expectedRevision: archived.revision + 1, archived: true });

    const analysis = await app.assistNote(note.id, { intent: 'summarize' });
    expect(analysis.includedSourceIds).toContain(`knowledge:project:${selected.id}`);
    expect(Object.keys(analysis.sourceVersions)).toContain('task:task-selected');
    expect(Object.keys(analysis.sourceVersions)).not.toContain('task:task-archived');
    expect(analysis.knowledgeSelection).toEqual([]);
  });

  it('preselects a bounded set of many directly linked notes and reports the omitted remainder', async () => {
    const { app } = createController();
    await app.load();
    await enableProvider(app);
    const note = await app.saveNote({ transcript: 'Summarize the work connected to these people.' });
    const people: Awaited<ReturnType<typeof app.savePerson>>[] = [];
    for (let index = 0; index < 5; index += 1) people.push(await app.savePerson({ name: `Person ${index}`, aliases: [], narrative: '' }));
    const relatedNotes = Array.from({ length: 250 }, (_, index) => ({
      id: `123e4567-e89b-42d3-a456-${String(index + 100).padStart(12, '0')}`,
      title: `Linked note ${index}`, transcript: `A short detail about person ${index % 5}.`, durationSeconds: 0,
      createdAt: note.createdAt, capturedAt: note.createdAt, captureTimeZone: 'Asia/Singapore', status: 'recorded' as const, revision: 1,
    }));
    const internal = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> };
    await internal.mutate((state) => {
      state.notes.push(...relatedNotes);
      for (let entityIndex = 0; entityIndex < people.length; entityIndex += 1) {
        const person = state.knowledge.people.find((item) => item.id === people[entityIndex]!.id)!;
        person.sourceLinks = relatedNotes.slice(entityIndex * 50, entityIndex * 50 + 50).map((linkedNote, index) => ({
          id: `123e4567-e89b-42d3-a456-${String(1000 + entityIndex * 100 + index).padStart(12, '0')}`,
          provenance: 'user_authored', createdAt: note.createdAt, reference: { kind: 'note', id: linkedNote.id }, label: 'Related note',
        }));
      }
    });

    const result = await app.assistNote(note.id, { intent: 'summarize', knowledgeSelection: people.map((person) => ({ kind: 'person' as const, id: person.id })) });
    expect(result.source).toBe('provider');
    expect(Object.keys(result.sourceVersions).length).toBeLessThanOrEqual(200);
    expect(result.omittedSourceCount).toBeGreaterThan(0);
  });

  it('follows linked knowledge associations one hop without re-entering a cycle', async () => {
    const { app } = createController();
    await app.load();
    await enableProvider(app);
    const note = await app.saveNote({ transcript: 'Summarize the project context.' });
    const [anchor, linked, beyond] = await Promise.all([
      app.savePerson({ name: 'Anchor person', aliases: [], narrative: 'Directly linked.' }),
      app.savePerson({ name: 'One hop person', aliases: [], narrative: 'Related directly.' }),
      app.savePerson({ name: 'Two hops away', aliases: [], narrative: 'Only linked through another person.' }),
    ]);
    let revision = anchor.revision;
    const linkedToNote = await app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: anchor.id, expectedEntityRevision: revision,
      reference: { kind: 'note', id: note.id }, label: 'Captured in note' });
    revision += 1;
    await app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: anchor.id, expectedEntityRevision: revision,
      reference: { kind: 'person', id: linked.id }, label: 'Related person' });
    await app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: linked.id, expectedEntityRevision: linked.revision,
      reference: { kind: 'person', id: beyond.id }, label: 'Second hop' });
    await app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: beyond.id, expectedEntityRevision: beyond.revision,
      reference: { kind: 'person', id: anchor.id }, label: 'Cycle back' });
    expect(linkedToNote.reference).toMatchObject({ kind: 'note', id: note.id });

    const analysis = await app.assistNote(note.id, { intent: 'summarize' });
    expect(Object.keys(analysis.sourceVersions)).toContain(`knowledge:person:${anchor.id}`);
    expect(Object.keys(analysis.sourceVersions)).toContain(`knowledge:person:${linked.id}`);
    expect(Object.keys(analysis.sourceVersions)).not.toContain(`knowledge:person:${beyond.id}`);
  });

  it('rejects dangling and forged live source links without persisting them', async () => {
    const { app, store } = createController();
    await app.load();
    const person = await app.savePerson({ name: 'Sam', aliases: [], narrative: 'Works with the team.' });
    const beforeSaves = store.saves;
    await expect(app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision,
      reference: { kind: 'note', id: 'missing-note' }, label: 'Missing note' })).rejects.toThrow(/still exists/i);
    await expect(app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision,
      reference: { kind: 'mail', id: 'provider-message', identityKey: 'claimed:identity', connectionGeneration: 4 }, label: 'Forged provider message' })).rejects.toThrow(/verified account/i);
    expect(store.saves).toBe(beforeSaves);
    expect(app.getSnapshot().knowledge.people[0].sourceLinks).toEqual([]);
  });

  it('journals review actions and refuses archived targets, while keeping inferred claims unverified', async () => {
    const { app } = createController();
    await app.load();
    const note = await app.saveNote({ transcript: 'I prefer concise project updates.' });
    const person = await app.savePerson({ name: 'Alex', aliases: [], narrative: '' });
    const suggestion = await app.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript', quote: 'I prefer concise project updates.',
      targetKind: 'person', targetId: person.id, change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Prefers concise project updates.' } });
    expect(suggestion.evidence[0].sourceId).toBe(`note:${note.id}`);
    expect(app.getSnapshot().documents.find((item) => item.path === 'memory/INFERENCES.md')?.content).toContain(`knowledge-suggestion:${suggestion.id}`);
    const accepted = await app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision: person.revision });
    expect(accepted.status).toBe('accepted');
    expect(app.getSnapshot().knowledge.people[0].facts[0]).toMatchObject({ provenance: 'accepted_inference', statement: 'Prefers concise project updates.' });
    expect(app.getSnapshot().documents.find((item) => item.path === 'memory/DECISIONS.md')?.content).toContain(`knowledge-suggestion:${suggestion.id}`);
    const refreshedPerson = app.getSnapshot().knowledge.people[0];
    await app.setKnowledgeEntityArchived({ kind: 'person', id: person.id, expectedRevision: refreshedPerson.revision, archived: true });
    await expect(app.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript', quote: 'I prefer concise project updates.',
      targetKind: 'person', targetId: person.id, change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Prefers short updates.' } })).rejects.toThrow(/unarchive/i);
  });

  it('bounds entity narratives before a durable write', async () => {
    const { app, store } = createController();
    await app.load();
    const before = store.saves;
    await expect(app.savePerson({ name: 'Too Large', aliases: [], narrative: 'x'.repeat(16 * 1024 + 1) })).rejects.toThrow(/16 KiB/i);
    expect(store.saves).toBe(before);
    expect(app.getSnapshot().knowledge.people).toEqual([]);
  });

  it('keeps untracked UUID Markdown files as ordinary context documents', async () => {
    const { app } = createController();
    await app.load();
    await enableProvider(app);
    const note = await app.saveNote({ transcript: 'The launch checklist needs an owner.' });
    const legacyPath = 'people/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.md';
    const internal = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> };
    await internal.mutate((state) => {
      state.documents.push({ path: legacyPath, content: 'Legacy launch owner: Maya coordinates the checklist.', revision: 1, updatedAt: note.createdAt });
    });

    const analysis = await app.assistNote(note.id, { intent: 'summarize' });
    expect(Object.keys(analysis.sourceVersions)).toContain(`doc:${legacyPath}`);
  });

  it('reviews exact saved document evidence after a later Assist uses different context', async () => {
    const { app } = createController();
    await app.load();
    await enableProvider(app);
    const note = await app.saveNote({ transcript: 'Maya coordinates the launch checklist.' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: '' });
    const path = 'notes/evidence.md';
    const content = '# Profile\n\nMaya coordinates the launch checklist.';
    const internal = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> };
    await internal.mutate((state) => state.documents.push({ path, content, revision: 1, updatedAt: note.createdAt }));
    const suggestion = await app.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript', quote: 'Maya coordinates the launch checklist.',
      targetKind: 'person', targetId: person.id, change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Coordinates the launch checklist.' } });
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, content)}`;
    await internal.mutate((state) => {
      const stored = state.knowledge.suggestions.find((item) => item.id === suggestion.id)!;
      stored.evidence = [{ sourceId: `doc:${path}`, revision: 1, sourceVersion, quote: 'Maya coordinates the launch checklist.' }];
    });

    await app.assistNote(note.id, { intent: 'summarize', knowledgeSelection: [] });
    const reviewed = await app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision: person.revision });
    expect(reviewed.status).toBe('accepted');
    expect(app.getSnapshot().knowledge.people[0].facts[0].statement).toBe('Coordinates the launch checklist.');
  });

  it('saves a grounded provider memory suggestion atomically with a bounded fingerprint', async () => {
    const text = 'Maya prefers concise weekly updates.';
    const store = new MemoryStore();
    let calls = 0;
    let targetSourceId = '';
    const fetcher = async () => {
      calls += 1;
      const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text.normalize('NFC'))}`;
      return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
        summary: 'Maya prefers concise weekly updates.', answer: '', decisions: [],
        citations: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: text }], clarifications: [], proposals: [],
        memorySuggestions: [{ targetSourceId, targetRevision: 1, type: 'add_fact', statement: 'Prefers concise weekly updates.', address: null, label: null, relatedSourceId: null, role: null,
          evidence: [{ sourceId: 'transcript', revision: 1, sourceVersion, quote: text }] }],
      }) }] }], usage: { input_tokens: 50, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const openAi = new AzureOpenAIClient(fetcher as typeof fetch, async () => 'test-key');
    const app = new AppControllerImpl(store, { openAi }, { writeDocument: async () => undefined });
    await app.load();
    await enableProvider(app);
    const note = await app.saveNote({ transcript: text });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: '' });
    targetSourceId = `knowledge:person:${person.id}`;
    const responseSourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text.normalize('NFC'))}`;
    const response = await app.assistNote(note.id, { intent: 'summarize', knowledgeSelection: [{ kind: 'person', id: person.id }] });
    const suggestion = app.getSnapshot().knowledge.suggestions.find((item) => item.status === 'pending');
    expect(calls).toBe(1);
    expect(response.memorySuggestionIds).toEqual([suggestion?.id]);
    expect(suggestion).toMatchObject({ sourceNoteId: note.id, evidence: [{ sourceId: `note:${note.id}`, sourceVersion: responseSourceVersion }] });
    expect(suggestion?.sourceAnalysisFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a knowledge suggestion when its cited local document has changed', async () => {
    const { app } = createController();
    await app.load();
    const note = await app.saveNote({ transcript: 'Maya coordinates the launch checklist.' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: '' });
    const path = 'notes/evidence.md';
    const content = 'Maya coordinates the launch checklist.';
    const internal = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> };
    await internal.mutate((state) => state.documents.push({ path, content, revision: 1, updatedAt: note.createdAt }));
    const suggestion = await app.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript', quote: 'Maya coordinates the launch checklist.',
      targetKind: 'person', targetId: person.id, change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Coordinates the launch checklist.' } });
    const sourceVersion = `1:${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, content)}`;
    await internal.mutate((state) => {
      const stored = state.knowledge.suggestions.find((item) => item.id === suggestion.id)!;
      stored.evidence = [{ sourceId: `doc:${path}`, revision: 1, sourceVersion, quote: content }];
    });
    await app.saveDocument(path, 'Maya no longer coordinates this checklist.', { expectedRevision: 1 });
    await expect(app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision: person.revision })).rejects.toThrow(/source changed/i);
  });

  it('uses the same safe task projection when revalidating long multiline evidence', async () => {
    const { app } = createController();
    await app.load();
    const note = await app.saveNote({ transcript: 'The related task contains a useful detail.' });
    const person = await app.savePerson({ name: 'Maya', aliases: [], narrative: '' });
    const task = { id: 'task-long', title: 'Launch\nchecklist', body: `First line with exact citation.\n${'Details and notes. '.repeat(500)}`, status: 'open' as const,
      createdAt: note.createdAt, sourceNoteId: note.id, sourceRevision: note.revision, proposalId: 'proposal-long-task' };
    const internal = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> };
    await internal.mutate((state) => state.tasks.push(task));
    const suggestion = await app.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript', quote: 'The related task contains a useful detail.',
      targetKind: 'person', targetId: person.id, change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Review the launch checklist.' } });
    const projected = buildLocalSourceSet({ transcript: { revision: 0, text: '' }, tasks: [{ ...task, selectionPriority: 1 }] }).sources.find((source) => source.id === 'task:task-long')!;
    const catalog = await createSourceCatalog([projected], async (bytes) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, new TextDecoder().decode(bytes)));
    await internal.mutate((state) => {
      state.knowledge.suggestions.find((item) => item.id === suggestion.id)!.evidence = [{
        sourceId: 'task:task-long', revision: catalog.sources[0]!.revision, sourceVersion: catalog.sources[0]!.version, quote: 'First line with exact citation.',
      }];
    });
    const reviewed = await app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision: person.revision });
    expect(reviewed.status).toBe('accepted');
  });

  it('checks private knowledge quarantine after implicit load before a first knowledge write', async () => {
    const store = new MemoryStore();
    const seed = createController(store).app;
    await seed.load();
    const corrupted = structuredClone(seed.getSnapshot());
    (corrupted as unknown as { knowledge: unknown }).knowledge = { schemaVersion: 1, people: [{ id: 'invalid-row' }], projects: [], suggestions: [] };
    store.value = corrupted;
    const recovering = createController(store).app;
    await expect(recovering.savePerson({ name: 'Should not write', aliases: [], narrative: '' })).rejects.toThrow(/held for recovery/i);
    expect(recovering.getSnapshot().knowledge.people).toEqual([]);
    expect(JSON.stringify(recovering.getSnapshot())).not.toContain('invalid-row');
    expect(JSON.stringify(store.value)).toContain('invalid-row');
  });
});
