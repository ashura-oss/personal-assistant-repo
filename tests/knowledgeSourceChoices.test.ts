import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import { parseKnowledgeSourceChoicesDTO, parseKnowledgeSuggestionReviewDTO, projectKnowledgeSuggestionForHttp } from '../src/cloud/knowledgeHttpContracts';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { buildKnowledgeReferenceOptions, knowledgeReferenceBindingIsCurrent, projectKnowledgeSourceChoiceReference } from '../src/knowledge/sourceChoices';
import { isCanonicalKnowledgeId } from '../src/knowledge';
import { buildCloudKnowledgeSourceChoiceOptions, knowledgeSourceChoiceId, resolveKnowledgeSourceChoice } from '../src/cloud/knowledgeSourceChoices.node';
import { KNOWLEDGE_SOURCE_CHOICES_PATH, KNOWLEDGE_SUGGESTION_REVIEW_PATH, parseKnowledgeHttpRead } from '../server/src/knowledgeHttp';

const stamp = '2026-10-15T00:00:00.000Z';
const personId = '123e4567-e89b-42d3-a456-426614174001';
const noteId = '123e4567-e89b-42d3-a456-426614174002';
const suggestionId = '123e4567-e89b-42d3-a456-426614174003';
const stateWithSources = () => {
  const state = createInitialWorkspaceState(() => '123e4567-e89b-42d3-a456-426614174099');
  state.notes.push({ id: noteId, title: 'Current note', transcript: 'Useful source', durationSeconds: 0, createdAt: stamp, status: 'recorded', revision: 1 });
  state.notes.push({ id: 'chat-note', title: 'Chat', transcript: 'Hidden source', durationSeconds: 0, createdAt: stamp, status: 'recorded', revision: 1, origin: 'assistant_chat' });
  state.knowledge.people.push({ id: personId, revision: 1, name: 'Morgan', aliases: [], narrativePath: `people/${personId}.md`, createdAt: stamp, updatedAt: stamp, facts: [], contacts: [], sourceLinks: [] });
  state.documents.push({ path: `people/${personId}.md`, content: 'private narrative', revision: 1, updatedAt: stamp },
    { path: 'notes/meeting-notes.md', content: 'meeting', revision: 1, updatedAt: stamp });
  return state;
};

describe('shared knowledge source choices', () => {
  it('parses exact read routes and keeps suggestion-ID grammar in parity with the domain', () => {
    expect(parseKnowledgeHttpRead(KNOWLEDGE_SOURCE_CHOICES_PATH, '?expectedRevision=0&expectedPrivacyEpoch=0')).toEqual({
      kind: 'source_choices', expectedRevision: 0, expectedPrivacyEpoch: 0,
    });
    const id = '30000000-0000-4000-8000-000000000003';
    expect(parseKnowledgeHttpRead(KNOWLEDGE_SUGGESTION_REVIEW_PATH,
      `?expectedRevision=2&expectedPrivacyEpoch=0&suggestionId=${id}&expectedSuggestionRevision=1`)).toMatchObject({ kind: 'suggestion_review', suggestionId: id });
    for (const candidate of [id, '30000000-0000-0000-8000-000000000003', '30000000-0000-9000-8000-000000000003', 'not-an-id']) {
      let serverAccepts = true;
      try { parseKnowledgeHttpRead(KNOWLEDGE_SUGGESTION_REVIEW_PATH,
        `?expectedRevision=2&expectedPrivacyEpoch=0&suggestionId=${candidate}&expectedSuggestionRevision=1`); }
      catch { serverAccepts = false; }
      expect(serverAccepts).toBe(isCanonicalKnowledgeId(candidate));
    }
    for (const query of [
      '?expectedRevision=2&expectedPrivacyEpoch=0&expectedPrivacyEpoch=0',
      '?expectedRevision=2&expectedPrivacyEpoch=0&extra=x',
      '?expectedRevision=02&expectedPrivacyEpoch=0',
    ]) expect(() => parseKnowledgeHttpRead(KNOWLEDGE_SOURCE_CHOICES_PATH, query)).toThrow('knowledge_http_query_invalid');
  });

  it('preserves native availability filters and rejects a source after its binding changes or disappears', () => {
    const state = stateWithSources();
    const choices = buildKnowledgeReferenceOptions(state, Date.parse(stamp));
    const note = choices.find((choice) => choice.reference.kind === 'note' && choice.reference.id === noteId)!;
    expect(choices.some((choice) => choice.reference.kind === 'note' && choice.reference.id === 'chat-note')).toBe(false);
    expect(choices.some((choice) => choice.reference.kind === 'document' && choice.reference.id === `people/${personId}.md`)).toBe(false);
    expect(choices.some((choice) => choice.reference.kind === 'document' && choice.reference.id === 'notes/meeting-notes.md')).toBe(true);
    expect(knowledgeReferenceBindingIsCurrent(state, note.binding, note.reference)).toBe(true);

    state.notes[0]!.transcript = 'Updated source';
    expect(knowledgeReferenceBindingIsCurrent(state, note.binding, note.reference)).toBe(false);
    state.notes.splice(0, 1);
    expect(knowledgeReferenceBindingIsCurrent(state, note.binding, note.reference)).toBe(false);
  });

  it('filters references that exceed domain UTF-8 limits without poisoning usable cloud choices', () => {
    const state = stateWithSources();
    const oversizedAscii = 'a'.repeat(513);
    const oversizedMultibyte = 'é'.repeat(257);
    state.notes.push(...[oversizedAscii, oversizedMultibyte].map((id) => ({ id, title: 'Large ID', transcript: 'Still usable', durationSeconds: 0,
      createdAt: stamp, status: 'recorded' as const, revision: 1 })));
    const nativeChoices = buildKnowledgeReferenceOptions(state);
    const rejectedNativeChoices = nativeChoices.filter((choice) => choice.reference.kind === 'note' &&
      (choice.reference.id === oversizedAscii || choice.reference.id === oversizedMultibyte));
    expect(rejectedNativeChoices).toHaveLength(2);

    const cloudChoices = buildCloudKnowledgeSourceChoiceOptions(state);
    expect(cloudChoices.some((choice) => choice.reference.kind === 'note' && choice.reference.id === noteId)).toBe(true);
    expect(cloudChoices.some((choice) => choice.reference.kind === 'note' &&
      (choice.reference.id === oversizedAscii || choice.reference.id === oversizedMultibyte))).toBe(false);
    for (const choice of rejectedNativeChoices) {
      const opaqueId = knowledgeSourceChoiceId('7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', 0, choice.binding);
      expect(resolveKnowledgeSourceChoice(state, '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', 0, opaqueId)).toBeUndefined();
    }

    const envelope = { schemaVersion: 1, workspaceId: '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', privacyEpoch: 0, revision: 0,
      choices: [{ id: `knowledge-choice-${'c'.repeat(64)}`, label: 'Normal', reference: { kind: 'note', id: noteId } }] };
    expect(parseKnowledgeSourceChoicesDTO(envelope, { workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0 }).choices).toHaveLength(1);
    for (const id of [oversizedAscii, oversizedMultibyte]) {
      expect(() => parseKnowledgeSourceChoicesDTO({ ...envelope, choices: [{ ...envelope.choices[0], reference: { kind: 'note', id } }] },
        { workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0 })).toThrow('knowledge_http_response_invalid');
    }
  });

  it('filters device events at the injected freshness boundary and projects no native identifiers', () => {
    const state = stateWithSources();
    state.deviceCalendars.enabled = true;
    state.deviceCalendars.generation = 4;
    state.deviceCalendars.installationId = 'private-installation';
    state.deviceCalendars.selectedCalendarIds = ['private-calendar'];
    state.deviceCalendars.calendars.push({ localId: 'private-calendar', nativeId: 'native-calendar', title: 'Personal', allowsModifications: false,
      fingerprint: 'private-fingerprint', observedAt: stamp });
    state.deviceCalendars.events.push({ id: 'local-event', calendarId: 'private-calendar', nativeEventId: 'native-event', occurrenceStart: stamp,
      title: 'Appointment', notes: '', notesTruncated: false, start: stamp, end: stamp, allDay: false, cancelled: false, observedAt: stamp, generation: 4 });
    (state.deviceCalendarAccess as { status: string }).status = 'full_access';
    const now = Date.parse(stamp) + 15 * 60_000;
    const event = buildKnowledgeReferenceOptions(state, now).find((choice) => choice.reference.kind === 'device_calendar_event')!;
    expect(event).toBeDefined();
    expect(buildKnowledgeReferenceOptions(state, now + 1).some((choice) => choice.reference.kind === 'device_calendar_event')).toBe(false);
    const reference = projectKnowledgeSourceChoiceReference(event.reference);
    expect(reference).toEqual({ kind: 'historical', label: `Device calendar event (${stamp})`, originalKind: 'device_calendar_event' });
    expect(JSON.stringify(reference)).not.toMatch(/private-installation|private-calendar|native-event|native-calendar/);
  });

  it('decodes only closed owner-bound DTOs and projects both suggestion changes safely', () => {
    const envelope = { schemaVersion: 1, workspaceId: '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', privacyEpoch: 0, revision: 0,
      choices: [{ id: `knowledge-choice-${'a'.repeat(64)}`, label: 'Event', reference: { kind: 'historical', label: 'Device event', originalKind: 'device_calendar_event' } }] };
    expect(parseKnowledgeSourceChoicesDTO(envelope, { workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0 }).choices).toHaveLength(1);
    expect(() => parseKnowledgeSourceChoicesDTO({ ...envelope, binding: 'private' }, { workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0 })).toThrow();
    expect(() => parseKnowledgeSourceChoicesDTO(envelope, { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', privacyEpoch: 0, revision: 0 })).toThrow(/stale/i);

    const sourceRef = { kind: 'device_calendar_event' as const, installationId: '123e4567-e89b-42d3-a456-426614174021', generation: 4,
      calendarId: '123e4567-e89b-42d3-a456-426614174022', eventId: 'secret-event', occurrenceStart: stamp };
    const suggestion = { id: suggestionId, revision: 2, targetRevision: 3,
      change: { type: 'add_source_link' as const, entityKind: 'person' as const, entityId: personId, reference: sourceRef, label: 'Evidence link' },
      originalChange: { type: 'add_source_link' as const, entityKind: 'person' as const, entityId: personId, reference: sourceRef, label: 'Original link' },
      evidence: [{ sourceId: `note:${noteId}`, sourceVersion: `1:${'b'.repeat(64)}`, revision: 1, quote: 'Useful source' }],
      status: 'pending' as const, createdAt: stamp, updatedAt: stamp, sourceAnalysisFingerprint: 'f'.repeat(256), inputPolicyVersion: 2 as const };
    const safe = projectKnowledgeSuggestionForHttp(suggestion);
    expect(JSON.stringify(safe)).not.toMatch(/123e4567-e89b-42d3-a456-42661417402[12]|secret-event|f{32}/);
    const review = { schemaVersion: 1, workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0,
      review: { suggestion: projectKnowledgeSuggestionForHttp(suggestion), canEdit: true, canAccept: true } };
    const decoded = parseKnowledgeSuggestionReviewDTO(review, { workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0, suggestionId, suggestionRevision: 2 });
    expect(decoded.review.suggestion.change).toMatchObject({ reference: { kind: 'historical', originalKind: 'device_calendar_event' } });
    expect(decoded.review.suggestion.originalChange).toMatchObject({ reference: { kind: 'historical', originalKind: 'device_calendar_event' } });
    expect(JSON.stringify(decoded)).not.toMatch(/f{32}/);
    expect(() => parseKnowledgeSuggestionReviewDTO(review, { workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0, suggestionId, suggestionRevision: 1 })).toThrow(/stale/i);
    expect(() => parseKnowledgeSuggestionReviewDTO({ ...review, review: { ...review.review, suggestion } },
      { workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0, suggestionId, suggestionRevision: 2 })).toThrow('knowledge_http_response_invalid');

    for (const [status, extra] of [['accepted', { reviewedAt: stamp }], ['dismissed', { reviewedAt: stamp }],
      ['stale', { reviewedAt: stamp, staleReason: 'Evidence changed.' }]] as const) {
      const terminal = { ...suggestion, status, ...extra } as unknown as typeof suggestion;
      const terminalDto = { ...review, review: { suggestion: projectKnowledgeSuggestionForHttp(terminal), canEdit: false, canAccept: false, reason: 'Already reviewed.' } };
      expect(parseKnowledgeSuggestionReviewDTO(terminalDto, { workspaceId: envelope.workspaceId, privacyEpoch: 0, revision: 0, suggestionId, suggestionRevision: 2 }).review.suggestion)
        .toMatchObject({ status, reviewedAt: stamp });
    }
  });
});

class QueuedMemoryStore implements StateStore {
  value?: AppState;
  blockNextSave = false;
  saveStarted!: () => void;
  releaseSave!: () => void;
  readonly started = new Promise<void>((resolve) => { this.saveStarted = resolve; });
  readonly gate = new Promise<void>((resolve) => { this.releaseSave = resolve; });
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    if (this.blockNextSave) { this.blockNextSave = false; this.saveStarted(); await this.gate; }
    this.value = structuredClone(state);
  }
  async clear() { this.value = undefined; }
}

describe('cloud source-link mutation binding', () => {
  it('rechecks a resolved choice inside the queued mutation after an earlier note edit commits', async () => {
    const store = new QueuedMemoryStore();
    const app = new AppControllerImpl(store, {}, { writeDocument: async () => undefined });
    await app.load();
    const person = await app.savePerson({ name: 'Morgan', aliases: [], narrative: '' });
    const note = await app.saveNote({ transcript: 'Before edit' });
    const selected = buildKnowledgeReferenceOptions(app.getSnapshot()).find((choice) => choice.reference.kind === 'note' && choice.reference.id === note.id)!;

    store.blockNextSave = true;
    const first = app.saveNote({ transcript: 'Queue barrier' });
    await store.started;
    const edit = app.updateTranscript(note.id, 'After edit', { expectedRevision: note.revision });
    const link = app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision,
      reference: selected.reference, expectedSourceBinding: selected.binding, label: 'Selected earlier' });
    store.releaseSave();
    await first;
    await edit;
    await expect(link).rejects.toThrow(/source changed/i);
    expect(app.getSnapshot().knowledge.people[0]!.sourceLinks).toEqual([]);
  });
});
