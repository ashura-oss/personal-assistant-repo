import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';
import { emptyKnowledgeState } from '../src/knowledge';
import type { Project } from '../src/knowledge/types';
import { BACKUP_LIMITS, type PortableBackupV3 } from '../src/backup';

class MemoryStore implements StateStore {
  value?: AppState;
  failNext = false;
  saves = 0;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) {
    this.saves += 1;
    if (this.failNext) { this.failNext = false; throw new Error('disk full'); }
    this.value = structuredClone(state);
  }
  async clear() { this.value = undefined; }
}

const stamp = '2026-10-12T10:00:00.000Z';
const integration = { writeDocument: async () => undefined };
const newApp = (store = new MemoryStore()) => ({ store, app: new AppControllerImpl(store, {}, integration) });
afterEach(() => vi.restoreAllMocks());

async function createPortableKnowledgeBackup() {
  const { app } = newApp();
  await app.load();
  const note = await app.saveNote({ transcript: 'Maya coordinates the field study.' });
  const person = await app.savePerson({ name: 'Maya Chen', aliases: ['Maya'], narrative: 'Maya coordinates the field study.\n\nKeep this narrative.' });
  const personFact = await app.saveKnowledgeFact({ entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision, statement: 'Coordinates the field study.' });
  const contact = await app.saveKnowledgeContact({ entityKind: 'person', entityId: person.id, expectedEntityRevision: person.revision + 1, address: 'maya@example.test', label: 'Work' });
  const suggestion = await app.createKnowledgeSuggestionFromNote({ noteId: note.id, sourceId: 'transcript', quote: 'Maya coordinates the field study.',
    targetKind: 'person', targetId: person.id, change: { type: 'add_fact', entityKind: 'person', entityId: person.id, statement: 'Coordinates the field study.' } });
  await app.reviewKnowledgeSuggestion(suggestion.id, { expectedRevision: suggestion.revision, decision: 'accept', targetRevision: app.getSnapshot().knowledge.people.find((item) => item.id === person.id)!.revision });
  const project = await app.saveProject({ name: 'Field Study', aliases: [], narrative: 'Study the northern site.', status: 'active', goal: 'Complete the field study.' });
  await app.saveKnowledgeMember({ entityKind: 'project', entityId: project.id, expectedEntityRevision: project.revision, personId: person.id,
    personRevision: app.getSnapshot().knowledge.people.find((item) => item.id === person.id)!.revision, role: 'Coordinator' });
  const currentPerson = app.getSnapshot().knowledge.people.find((item) => item.id === person.id)!;
  const currentProject = app.getSnapshot().knowledge.projects.find((item) => item.id === project.id)!;
  await app.saveKnowledgeSourceLink({ entityKind: 'person', entityId: person.id, expectedEntityRevision: currentPerson.revision,
    reference: { kind: 'project', id: project.id }, label: 'Coordinates this project' });
  await app.saveKnowledgeSourceLink({ entityKind: 'project', entityId: project.id, expectedEntityRevision: currentProject.revision,
    reference: { kind: 'person', id: person.id }, label: 'Project coordinator' });
  const backup = JSON.parse(await app.exportData()) as PortableBackupV3;
  expect(backup.knowledge.state.people[0].facts.some((fact) => fact.provenance === 'user_authored')).toBe(true);
  expect(backup.knowledge.state.people[0].facts.some((fact) => fact.provenance === 'accepted_inference')).toBe(true);
  expect(backup.knowledge.state.people[0].contacts).toHaveLength(1);
  return { backup, sourceNoteId: note.id, sourcePersonId: person.id, sourceProjectId: project.id, personFact, contact };
}

async function importBackup(backup: PortableBackupV3, store = new MemoryStore()) {
  const { app } = newApp(store);
  await app.load();
  const preview = await app.prepareBackupImport(JSON.stringify(backup));
  const archive = await app.applyBackupImport({ sessionId: preview.sessionId, planHash: preview.planHash });
  const cohort = archive.archivedKnowledge?.[0];
  if (!cohort) throw new Error('Expected the imported knowledge cohort to be archived.');
  return { app, store, preview, archive, cohort };
}

describe('controller portable knowledge backup workflow', () => {
  it('imports exported knowledge only as inert archived material until each entity is activated', async () => {
    const { backup } = await createPortableKnowledgeBackup();
    const { app, archive, cohort } = await importBackup(backup);

    expect(app.getSnapshot().knowledge).toEqual(emptyKnowledgeState());
    expect(app.getSnapshot().documents.some((document) => /^people\//.test(document.path) || /^projects\//.test(document.path))).toBe(false);
    expect(cohort.knowledge.state.people).toHaveLength(1);
    expect(cohort.knowledge.state.projects).toHaveLength(1);
    expect(cohort.activationLinks ?? []).toEqual([]);
    expect(app.getSnapshot().proposals).toEqual([]);
    expect(app.getSnapshot().dispatchRecords).toEqual([]);
    expect(archive.archivedKnowledge).toHaveLength(1);
  });

  it('activates a person under a fresh ID with narrative and claims, then maps same-cohort project members and entity references', async () => {
    const { backup, sourcePersonId, sourceProjectId, personFact, contact } = await createPortableKnowledgeBackup();
    const { app, archive, cohort } = await importBackup(backup);
    const sourcePerson = cohort.knowledge.state.people.find((item) => item.id === sourcePersonId)!;

    const personPreview = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const beforeRevisionMismatch = structuredClone(app.getSnapshot());
    await expect(app.activateImportedKnowledgeEntity({ sessionId: personPreview.sessionId, planHash: personPreview.planHash, expectedDocumentRevision: 1 })).rejects.toThrow(/expected to be new/i);
    expect(app.getSnapshot()).toEqual(beforeRevisionMismatch);
    const activatedPerson = await app.activateImportedKnowledgeEntity({ sessionId: personPreview.sessionId, planHash: personPreview.planHash });
    expect(activatedPerson.entity.id).not.toBe(sourcePersonId);
    expect(activatedPerson.entity).toMatchObject({ name: sourcePerson.name, aliases: sourcePerson.aliases, narrativePath: `people/${activatedPerson.entity.id}.md` });
    expect(activatedPerson.document.content).toContain('Keep this narrative.');
    expect((activatedPerson.entity as typeof sourcePerson).facts.map(({ provenance, statement }) => ({ provenance, statement }))).toEqual(sourcePerson.facts.map(({ provenance, statement }) => ({ provenance, statement })));
    expect((activatedPerson.entity as typeof sourcePerson).facts.some((fact) => fact.id === personFact.id)).toBe(false);
    expect((activatedPerson.entity as typeof sourcePerson).contacts[0]).toMatchObject({ address: contact.address, label: contact.label, provenance: 'user_authored' });
    expect((activatedPerson.entity as typeof sourcePerson).contacts[0].id).not.toBe(contact.id);
    expect((activatedPerson.entity as typeof sourcePerson).importOrigin).toMatchObject({ kind: 'backup_knowledge', archiveId: archive.id, cohortId: cohort.id, sourceEntityId: sourcePersonId });

    const projectPreview = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'project', entityId: sourceProjectId });
    const activatedProject = await app.activateImportedKnowledgeEntity({ sessionId: projectPreview.sessionId, planHash: projectPreview.planHash });
    expect(activatedProject.entity.id).not.toBe(sourceProjectId);
    expect((activatedProject.entity as Project).members).toEqual([
      expect.objectContaining({ personId: activatedPerson.entity.id, role: 'Coordinator' }),
    ]);
    expect((activatedProject.entity as Project).members[0]).not.toHaveProperty('sourcePersonId');
    expect(activatedProject.entity.sourceLinks).toEqual([
      expect.objectContaining({ reference: { kind: 'person', id: activatedPerson.entity.id }, label: 'Project coordinator' }),
    ]);
    expect(activatedPerson.entity.sourceLinks).toEqual([
      expect.objectContaining({ reference: { kind: 'historical', label: 'Coordinates this project', originalKind: 'project' }, label: 'Coordinates this project' }),
    ]);
  });

  it('keeps unactivated typed references historical even when a local same-name, same-ID person exists', async () => {
    const { backup, sourcePersonId, sourceProjectId } = await createPortableKnowledgeBackup();
    const localStore = new MemoryStore();
    const seed = new AppControllerImpl(localStore, {}, integration);
    await seed.load();
    const localState = structuredClone(seed.getSnapshot());
    localState.knowledge.people.push({ id: sourcePersonId, revision: 1, name: 'Maya Chen', aliases: ['Maya'], narrativePath: `people/${sourcePersonId}.md`,
      createdAt: stamp, updatedAt: stamp, facts: [], sourceLinks: [], contacts: [] });
    localState.documents.push({ path: `people/${sourcePersonId}.md`, content: 'An unrelated local entry.', revision: 1, updatedAt: stamp });
    await localStore.save(localState);
    const { app, archive, cohort } = await importBackup(backup, localStore);

    const preview = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'project', entityId: sourceProjectId });
    expect(preview.unresolvedMemberCount).toBe(1);
    const activated = await app.activateImportedKnowledgeEntity({ sessionId: preview.sessionId, planHash: preview.planHash });
    expect((activated.entity as Project).members[0]).toMatchObject({ sourcePersonId, label: 'Unavailable imported person', role: 'Coordinator' });
    expect(activated.entity.sourceLinks[0]).toMatchObject({ reference: { kind: 'historical', originalKind: 'person' } });
    expect((activated.entity as Project).members[0]).not.toHaveProperty('personId');
  });

  it('preserves edits to an activated entity when a fresh preview confirms its existing mapping', async () => {
    const { backup, sourcePersonId } = await createPortableKnowledgeBackup();
    const { app, archive, cohort } = await importBackup(backup);
    const preview = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const activated = await app.activateImportedKnowledgeEntity({ sessionId: preview.sessionId, planHash: preview.planHash });
    const changed = await app.savePerson({ id: activated.entity.id, expectedRevision: activated.entity.revision, expectedDocumentRevision: activated.document.revision,
      name: 'Maya Chen Updated', aliases: ['Maya', 'MC'], narrative: 'My edited narrative.' });
    await app.saveKnowledgeFact({ entityKind: 'person', entityId: changed.id, expectedEntityRevision: changed.revision, statement: 'A local-only fact.' });
    const savesBeforeRepeat = app.getSnapshot().knowledge.people.length;

    const repeatPreview = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    expect(repeatPreview.alreadyActivated).toBe(true);
    expect(repeatPreview.targetId).toBe(activated.entity.id);
    const repeated = await app.activateImportedKnowledgeEntity({ sessionId: repeatPreview.sessionId, planHash: repeatPreview.planHash });
    expect(repeated.entity).toMatchObject({ name: 'Maya Chen Updated', narrativePath: changed.narrativePath });
    expect(repeated.document.content).toBe('My edited narrative.');
    expect(repeated.entity.facts.some((fact) => fact.statement === 'A local-only fact.')).toBe(true);
    expect(app.getSnapshot().knowledge.people).toHaveLength(savesBeforeRepeat);
    expect(app.getSnapshot().documents.filter((document) => document.path === changed.narrativePath)).toHaveLength(1);
  });

  it('turns imported calendar event references into historical display data', async () => {
    const { backup, sourcePersonId } = await createPortableKnowledgeBackup();
    const sourcePerson = backup.knowledge.state.people.find((item) => item.id === sourcePersonId)!;
    sourcePerson.sourceLinks.push({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', provenance: 'user_authored', createdAt: sourcePerson.updatedAt,
      reference: { kind: 'calendar', id: 'provider-event-77', calendarId: 'provider-calendar-22', identityKey: 'google:private-account', connectionGeneration: 7 },
      label: 'Discussed at the site visit',
    });
    const { app, archive, cohort } = await importBackup(backup);
    const preview = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const activated = await app.activateImportedKnowledgeEntity({ sessionId: preview.sessionId, planHash: preview.planHash });
    const calendarLink = activated.entity.sourceLinks.find((link) => link.label === 'Discussed at the site visit')!;

    expect(calendarLink.reference).toMatchObject({ kind: 'historical', label: 'Discussed at the site visit', originalKind: 'calendar' });
    expect(calendarLink.reference).not.toHaveProperty('id');
    expect(calendarLink.reference).not.toHaveProperty('calendarId');
    expect(calendarLink.reference).not.toHaveProperty('identityKey');
    expect(calendarLink.reference).not.toHaveProperty('connectionGeneration');
  });

  it('historicalizes imported claim evidence instead of binding a colliding local note ID', async () => {
    const { backup, sourceNoteId, sourcePersonId } = await createPortableKnowledgeBackup();
    const sourceEvidence = backup.knowledge.state.people.find((item) => item.id === sourcePersonId)!.facts.find((fact) => fact.provenance === 'accepted_inference')!.evidence![0]!;
    const localStore = new MemoryStore();
    const seed = new AppControllerImpl(localStore, {}, integration);
    await seed.load();
    const localState = structuredClone(seed.getSnapshot());
    localState.notes.push({ id: sourceNoteId, title: 'Unrelated collision', transcript: 'This local note is unrelated.', durationSeconds: 0,
      createdAt: stamp, capturedAt: stamp, captureTimeZone: 'UTC', status: 'recorded', revision: 1 });
    await localStore.save(localState);
    const { app, archive, cohort } = await importBackup(backup, localStore);
    const restoredSourceNote = app.getSnapshot().notes.find((note) => note.importOrigin?.archiveId === archive.id && note.importOrigin.sourceNoteId === sourceNoteId)!;
    expect(restoredSourceNote.id).not.toBe(sourceNoteId);

    const preview = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const activated = await app.activateImportedKnowledgeEntity({ sessionId: preview.sessionId, planHash: preview.planHash });
    const inferredFact = activated.entity.facts.find((fact) => fact.provenance === 'accepted_inference')!;
    expect(inferredFact.evidence?.[0]).toMatchObject({
      sourceId: expect.stringMatching(/^historical:imported:/),
      sourceVersion: sourceEvidence.sourceVersion,
      revision: sourceEvidence.revision,
      quote: sourceEvidence.quote,
    });
    expect(inferredFact.evidence?.[0].sourceId).not.toContain(sourceNoteId);
    expect(app.getSnapshot().notes.find((note) => note.id === sourceNoteId)?.transcript).toBe('This local note is unrelated.');
  });

  it('rejects changed, stale, and expired activation plans before committing, and allows a valid retry after save failure', async () => {
    const { backup, sourcePersonId } = await createPortableKnowledgeBackup();
    const { app, store, archive, cohort } = await importBackup(backup);
    const preview = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const beforePlanFailure = structuredClone(app.getSnapshot());
    await expect(app.activateImportedKnowledgeEntity({ sessionId: preview.sessionId, planHash: 'f'.repeat(64) })).rejects.toThrow(/missing or changed/i);
    expect(app.getSnapshot()).toEqual(beforePlanFailure);

    const fresh = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const mutate = app as unknown as { mutate(operation: (state: AppState) => void): Promise<void> };
    await mutate.mutate((state) => { state.settings.timezone = 'UTC'; });
    const beforeStaleActivation = structuredClone(app.getSnapshot());
    await expect(app.activateImportedKnowledgeEntity({ sessionId: fresh.sessionId, planHash: fresh.planHash })).rejects.toThrow(/changed after this preview/i);
    expect(app.getSnapshot()).toEqual(beforeStaleActivation);

    const latest = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(latest.expiresAt) + 1);
    const beforeExpiry = structuredClone(app.getSnapshot());
    await expect(app.activateImportedKnowledgeEntity({ sessionId: latest.sessionId, planHash: latest.planHash })).rejects.toThrow(/expired/i);
    expect(app.getSnapshot()).toEqual(beforeExpiry);
    nowSpy.mockRestore();

    const retry = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const beforeSaveFailure = structuredClone(app.getSnapshot());
    const savesBeforeFailure = store.saves;
    store.failNext = true;
    await expect(app.activateImportedKnowledgeEntity({ sessionId: retry.sessionId, planHash: retry.planHash })).rejects.toThrow(/disk full/i);
    expect(app.getSnapshot().notes).toEqual(beforeSaveFailure.notes);
    expect(app.getSnapshot().knowledge).toEqual(beforeSaveFailure.knowledge);
    expect(app.getSnapshot().mailAlertRefreshRequired?.required).toBe(true);
    expect(store.saves).toBe(savesBeforeFailure + 1);
    await app.refreshPersistedWorkspace();
    await expect(app.activateImportedKnowledgeEntity({ sessionId: retry.sessionId, planHash: retry.planHash })).rejects.toThrow(/preview is missing/i);
    const refreshedRetry = await app.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId });
    const committed = await app.activateImportedKnowledgeEntity({ sessionId: refreshedRetry.sessionId, planHash: refreshedRetry.planHash });
    expect(committed.entity.importOrigin?.sourceEntityId).toBe(sourcePersonId);
    expect(app.getSnapshot().knowledge.people).toHaveLength(1);
    expect(app.getSnapshot().importedBackups.find((item) => item.id === archive.id)?.archivedKnowledge?.[0].activationLinks).toHaveLength(1);
  });

  it('blocks archived-knowledge activation while local knowledge is quarantined without writing state', async () => {
    const { backup, sourcePersonId } = await createPortableKnowledgeBackup();
    const { app, store, archive, cohort } = await importBackup(backup);
    const corrupted = structuredClone(app.getSnapshot());
    (corrupted as unknown as { knowledge: unknown }).knowledge = { schemaVersion: 1, people: [{ id: 'invalid-local-knowledge' }], projects: [], suggestions: [] };
    store.value = corrupted;

    const recovering = new AppControllerImpl(store, {}, integration);
    await recovering.load();
    expect(recovering.getSnapshot().knowledgeRecoveryStatus).toBeDefined();
    const before = structuredClone(recovering.getSnapshot());
    const savesBefore = store.saves;
    await expect(recovering.prepareImportedKnowledgeActivation({ archiveId: archive.id, cohortId: cohort.id, kind: 'person', entityId: sourcePersonId })).rejects.toThrow(/held for recovery/i);
    expect(recovering.getSnapshot()).toEqual(before);
    expect(store.saves).toBe(savesBefore);
  });

  it('enforces the cumulative knowledge cohort limit across current and previously archived knowledge', async () => {
    const { backup } = await createPortableKnowledgeBackup();
    backup.archivedKnowledge = Array.from({ length: BACKUP_LIMITS.knowledgeCohorts }, (_, index) => ({
      sourceId: `older-cohort-${index}`,
      knowledge: { state: emptyKnowledgeState(), narratives: [] },
    }));
    const { app, store } = newApp();
    await app.load();
    const savesBefore = store.saves;

    await expect(app.prepareBackupImport(JSON.stringify(backup))).rejects.toThrow(/cohorts exceed the allowed item count/i);
    expect(store.saves).toBe(savesBefore);
    expect(app.getSnapshot().importedBackups).toEqual([]);
    expect(app.getSnapshot().knowledge).toEqual(emptyKnowledgeState());
  });
});
