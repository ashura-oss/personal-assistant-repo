import type { ImportedKnowledgeActivationPreview } from '../core';
import type { KnowledgeReference, KnowledgeSuggestion, Person, Project } from '../knowledge/types';
import type { ImportedArchiveDisplay, KnowledgeChangeDisplay, KnowledgeEntityDisplay, KnowledgeReferenceDisplay, KnowledgeSuggestionDisplay, ImportedKnowledgePreviewDisplay, KnowledgeDisplay } from './knowledgeDisplayTypes';
import type { DeepReadonly, WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
export function knowledgeReferenceDisplay(reference: KnowledgeReference): KnowledgeReferenceDisplay {
  switch (reference.kind) {
    case 'note': case 'task': case 'document': case 'person': case 'project':
      return { kind: reference.kind, id: reference.id };
    case 'mail':
      return { kind: 'mail', id: reference.id, identityKey: reference.identityKey, connectionGeneration: reference.connectionGeneration };
    case 'calendar':
      return { kind: 'calendar', id: reference.id, calendarId: reference.calendarId, identityKey: reference.identityKey, connectionGeneration: reference.connectionGeneration };
    case 'device_calendar_event':
      return { kind: 'historical', label: `Device calendar event (${reference.occurrenceStart})`, originalKind: 'device_calendar_event' };
    case 'historical':
      return { kind: 'historical', label: reference.label, originalKind: reference.originalKind };
  }
}

function projectKnowledgeChangeDisplay(change: DeepReadonly<KnowledgeSuggestion['change']>): KnowledgeChangeDisplay {
  switch (change.type) {
    case 'add_fact': return { type: change.type, entityKind: change.entityKind, entityId: change.entityId, statement: change.statement };
    case 'add_contact': return { type: change.type, entityKind: change.entityKind, entityId: change.entityId, address: change.address, label: change.label };
    case 'add_member': return { type: change.type, entityKind: change.entityKind, entityId: change.entityId, personId: change.personId, personRevision: change.personRevision, role: change.role };
    case 'add_source_link': return { type: change.type, entityKind: change.entityKind, entityId: change.entityId, reference: knowledgeReferenceDisplay(change.reference), ...(change.referenceRevision !== undefined ? { referenceRevision: change.referenceRevision } : {}), label: change.label };
  }
}

export function projectKnowledgeSuggestionDisplay(item: DeepReadonly<KnowledgeSuggestion>): KnowledgeSuggestionDisplay {
  const evidence = (items: readonly DeepReadonly<KnowledgeSuggestion['evidence'][number]>[]) => items.map((entry) => ({ sourceId: entry.sourceId, sourceVersion: entry.sourceVersion, revision: entry.revision, quote: entry.quote }));
  return { id: item.id, revision: item.revision, change: projectKnowledgeChangeDisplay(item.change), targetRevision: item.targetRevision,
    evidence: evidence(item.evidence), status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt,
    ...(item.originalChange ? { originalChange: projectKnowledgeChangeDisplay(item.originalChange) } : {}), ...(item.originalEvidence ? { originalEvidence: evidence(item.originalEvidence) } : {}),
    ...(item.staleReason ? { staleReason: item.staleReason } : {}) };
}

export function projectKnowledgeDisplay(value: DeepReadonly<WorkspaceSnapshotDTO['state']['knowledge']>): KnowledgeDisplay {
  const sourceLinks = (items: readonly DeepReadonly<WorkspaceSnapshotDTO['state']['knowledge']['people'][number]['sourceLinks'][number]>[]) => items.map((item) => ({ id: item.id, provenance: item.provenance,
    reference: knowledgeReferenceDisplay(item.reference), label: item.label }));
  const facts = (items: readonly DeepReadonly<WorkspaceSnapshotDTO['state']['knowledge']['people'][number]['facts'][number]>[]) => items.map((item) => ({ id: item.id, provenance: item.provenance, statement: item.statement }));
  const people = value.people.map((person) => ({ id: person.id, revision: person.revision, name: person.name, aliases: [...person.aliases], narrativePath: person.narrativePath,
    createdAt: person.createdAt, updatedAt: person.updatedAt, ...(person.archivedAt ? { archivedAt: person.archivedAt } : {}), ...(person.importOrigin ? { importOrigin: { kind: 'backup_knowledge' as const } } : {}),
    facts: facts(person.facts), sourceLinks: sourceLinks(person.sourceLinks), contacts: person.contacts.map((item) => ({ id: item.id, provenance: item.provenance, address: item.address, label: item.label })) }));
  const projects = value.projects.map((project) => ({ id: project.id, revision: project.revision, name: project.name, aliases: [...project.aliases], narrativePath: project.narrativePath,
    createdAt: project.createdAt, updatedAt: project.updatedAt, ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}), ...(project.importOrigin ? { importOrigin: { kind: 'backup_knowledge' as const } } : {}),
    facts: facts(project.facts), sourceLinks: sourceLinks(project.sourceLinks), status: project.status, goal: project.goal, ...(project.startsOn ? { startsOn: project.startsOn } : {}),
    ...(project.targetOn ? { targetOn: project.targetOn } : {}), ...(project.dateTimeZone ? { dateTimeZone: project.dateTimeZone } : {}), members: project.members.map((member) => ({ ...member })) }));
  return { people, projects, suggestions: value.suggestions.map(projectKnowledgeSuggestionDisplay) };
}

export function projectKnowledgeEntityDisplay(entity: DeepReadonly<Person | Project>): KnowledgeEntityDisplay {
  if ('contacts' in entity) return projectKnowledgeDisplay({ schemaVersion: 1, people: [entity], projects: [], suggestions: [] }).people[0]!;
  return projectKnowledgeDisplay({ schemaVersion: 1, people: [], projects: [entity], suggestions: [] }).projects[0]!;
}

export function projectImportedKnowledgePreview(preview: ImportedKnowledgeActivationPreview): ImportedKnowledgePreviewDisplay {
  return { archiveId: preview.archiveId, cohortId: preview.cohortId, kind: preview.kind,
    sourceEntityId: preview.sourceEntityId, sourceName: preview.sourceName, sourceEntity: projectKnowledgeEntityDisplay(preview.sourceEntity),
    alreadyActivated: preview.alreadyActivated, narrativeContent: preview.narrativeContent,
    factCount: preview.factCount, contactCount: preview.contactCount, sourceLinkCount: preview.sourceLinkCount, memberCount: preview.memberCount,
    unavailableProviderReferenceCount: preview.unavailableProviderReferenceCount, unresolvedMemberCount: preview.unresolvedMemberCount };
}

export function projectImportedKnowledgeArchives(archives: readonly DeepReadonly<WorkspaceSnapshotDTO['state']['importedBackups'][number]>[]): readonly ImportedArchiveDisplay[] {
  return archives.map((archive) => ({ id: archive.id, sourceFormat: archive.sourceFormat, importedAt: archive.importedAt, noteLinks: archive.noteLinks.map((link) => ({ sourceId: link.sourceId, noteId: link.noteId })),
    taskLinks: archive.taskLinks.map((link) => ({ sourceId: link.sourceId, taskId: link.taskId })),
    documents: archive.documents.map((item) => ({ path: item.path, content: item.content, revision: item.revision, updatedAt: item.updatedAt, id: item.id,
      ...(item.activatedPath ? { activatedPath: item.activatedPath } : {}), ...(item.activatedAt ? { activatedAt: item.activatedAt } : {}) })),
    ...(archive.archivedKnowledge ? { archivedKnowledge: archive.archivedKnowledge.map((cohort) => ({ id: cohort.id, sourceId: cohort.sourceId,
      knowledge: { state: projectKnowledgeDisplay(cohort.knowledge.state), narratives: cohort.knowledge.narratives.map((item) => ({ entityKind: item.entityKind,
        entityId: item.entityId, content: item.content, revision: item.revision, updatedAt: item.updatedAt })) },
      activatedEntities: (cohort.activationLinks ?? []).map((link) => ({ entityKind: link.entityKind, sourceEntityId: link.sourceEntityId })) })) } : {}) }));
}

function localDateTime(iso?: string) {
  if (!iso) return { date: '', time: '' };
  const date = new Date(iso); if (!Number.isFinite(date.getTime())) return { date: '', time: '' };
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
}
export function newDocumentPath(docs: readonly { path: string }[]) {
  const base = `notes/${localDateTime(new Date().toISOString()).date}`; let suffix = 1; let candidate = `${base}.md`;
  while (docs.some((doc) => doc.path === candidate)) { suffix += 1; candidate = `${base}-${suffix}.md`; }
  return candidate;
}
export function friendlyDocumentName(path: string) { const file = path.split(/[\\/]/).pop() ?? path; return file.replace(/\.md$/i, '').replace(/[-_]/g, ' '); }
