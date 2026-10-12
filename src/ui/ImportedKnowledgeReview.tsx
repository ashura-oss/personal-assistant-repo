import React, { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { AppController, ImportedKnowledgeActivationPreview } from '../core';
import type { ImportedBackupArchive } from '../backup';
import type { KnowledgeReference, Person, Project } from '../knowledge/types';
import { Button } from './primitives';
import { s } from './theme';

type Props = {
  archives: ImportedBackupArchive[];
  busy: boolean;
  controller: AppController;
  onRun: <T>(action: () => Promise<T>) => Promise<T | undefined>;
};

export function ImportedKnowledgeReview({ archives, busy, controller, onRun }: Props) {
  const [selectedArchiveId, setSelectedArchiveId] = useState('');
  const [selectedCohortId, setSelectedCohortId] = useState('');
  const [selectedEntity, setSelectedEntity] = useState<{ kind: 'person' | 'project'; id: string } | null>(null);
  const [preview, setPreview] = useState<ImportedKnowledgeActivationPreview | null>(null);
  const [message, setMessage] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [applying, setApplying] = useState(false);
  const previewSequence = useRef(0);
  const archive = archives.find((item) => item.id === selectedArchiveId);
  const cohort = archive?.archivedKnowledge?.find((item) => item.id === selectedCohortId);
  const previewMatchesSelection = Boolean(preview && selectedEntity && preview.archiveId === selectedArchiveId && preview.cohortId === selectedCohortId && preview.kind === selectedEntity.kind && preview.sourceEntityId === selectedEntity.id);
  const sourceEntity = preview?.sourceEntity;

  const prepare = async (archiveId: string, cohortId: string, kind: 'person' | 'project', entityId: string) => {
    if (applying) return;
    const sequence = ++previewSequence.current;
    setSelectedArchiveId(archiveId); setSelectedCohortId(cohortId); setSelectedEntity({ kind, id: entityId });
    setPreview(null); setMessage(''); setPreparing(true);
    try {
      const result = await onRun(() => controller.prepareImportedKnowledgeActivation({ archiveId, cohortId, kind, entityId }));
      if (sequence === previewSequence.current && result && result.archiveId === archiveId && result.cohortId === cohortId && result.kind === kind && result.sourceEntityId === entityId) setPreview(result);
    } catch (error) {
      if (sequence === previewSequence.current) setMessage(error instanceof Error ? error.message : 'Could not prepare this imported copy. Try again.');
    } finally {
      if (sequence === previewSequence.current) setPreparing(false);
    }
  };

  const activate = async () => {
    if (!preview || !previewMatchesSelection || busy || applying || preview.alreadyActivated) return;
    setMessage('');
    const sequence = previewSequence.current;
    setApplying(true);
    const result = await onRun(() => controller.activateImportedKnowledgeEntity({
      sessionId: preview.sessionId,
      planHash: preview.planHash,
    }));
    if (sequence === previewSequence.current && result) {
      setPreview((current) => current?.sessionId === preview.sessionId ? { ...current, alreadyActivated: true } : current);
      setMessage(`Added ${result.entity.name} as a separate ${preview.kind}.`);
    }
    setApplying(false);
  };

  const resetSelection = (nextArchiveId = '', nextCohortId = '') => {
    if (applying) return;
    previewSequence.current += 1;
    setSelectedArchiveId(nextArchiveId); setSelectedCohortId(nextCohortId); setSelectedEntity(null);
    setPreview(null); setMessage(''); setPreparing(false);
  };

  return <View style={{ gap: 10 }}>
    <Text style={s.sectionTitle}>Imported knowledge</Text>
    <Text style={s.knowledgeFootnote}>Imported people and projects stay archived until you choose an item and activate a separate copy. Names are never merged automatically.</Text>
    {archives.flatMap((item) => (item.archivedKnowledge ?? []).map((cohortItem) => ({ archive: item, cohort: cohortItem }))).map(({ archive: archiveItem, cohort: cohortItem }) => {
      const people = cohortItem.knowledge.state.people;
      const projects = cohortItem.knowledge.state.projects;
      return <View key={`${archiveItem.id}:${cohortItem.id}`} style={s.knowledgeCard}>
        <View style={{ flex: 1, gap: 4 }}><Text style={s.knowledgeName}>Archived backup · {new Date(archiveItem.importedAt).toLocaleDateString()}</Text><Text style={s.knowledgeMeta}>{people.length} people · {projects.length} projects · imported, not active</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Review archived knowledge from ${archiveItem.sourceFormat}`} disabled={applying} onPress={() => resetSelection(archiveItem.id, cohortItem.id)} style={s.knowledgeSmallAction}><Text style={s.knowledgeActionText}>Choose</Text></Pressable>
      </View>;
    })}
    {cohort ? <>
      {cohort.knowledge.state.people.map((person) => <View key={`person:${person.id}`} style={s.knowledgeCard}><Text style={[s.knowledgeName, { flex: 1 }]}>{person.name} · Person</Text><Button label="Review separate copy" tone="quiet" disabled={busy || applying} onPress={() => void prepare(selectedArchiveId, selectedCohortId, 'person', person.id)} /></View>)}
      {cohort.knowledge.state.projects.map((project) => <View key={`project:${project.id}`} style={s.knowledgeCard}><Text style={[s.knowledgeName, { flex: 1 }]}>{project.name} · Project</Text><Button label="Review separate copy" tone="quiet" disabled={busy || applying} onPress={() => void prepare(selectedArchiveId, selectedCohortId, 'project', project.id)} /></View>)}
    </> : null}
    {preparing ? <View style={s.knowledgeInlineForm}><Text style={s.knowledgeFootnote}>Preparing a local review…</Text><Button label="Cancel preview" tone="quiet" disabled={applying} onPress={() => resetSelection(selectedArchiveId, selectedCohortId)} /></View> : null}
    {preview && selectedEntity && cohort && previewMatchesSelection && sourceEntity ? <View style={s.setupCard}>
      <Text style={s.kicker}>ACTIVATION PREVIEW</Text>
      <Text style={s.knowledgeName}>{preview.sourceName} · separate local copy</Text>
      <Text style={s.knowledgeMeta}>A new local {preview.kind} will be created. Existing entities and their edits stay unchanged.</Text>
      <Text style={s.knowledgeMeta}>{preview.factCount} facts · {preview.contactCount} contact claims · {preview.sourceLinkCount} source links · {preview.memberCount} members</Text>
      {preview.unavailableProviderReferenceCount ? <Text style={s.knowledgeFootnote}>{preview.unavailableProviderReferenceCount} provider references will remain historical and unavailable.</Text> : null}
      {preview.unresolvedMemberCount ? <Text style={s.knowledgeFootnote}>{preview.unresolvedMemberCount} members cannot be matched to an active person.</Text> : null}
      <Text style={s.analysisSource}>Narrative</Text><Text style={s.analysisText}>{preview.narrativeContent || 'No narrative text.'}</Text>
      <ImportedEntityDetails entity={sourceEntity} cohort={cohort!} archive={archive!} />
      <Text style={s.knowledgeFootnote}>This creates local knowledge only. Imported pending suggestions and historical actions remain read-only.</Text>
      {preview.alreadyActivated ? <Text style={s.knowledgeFootnote}>This archived item has already been added. Existing edits were preserved.</Text> : null}
      <Button label={applying ? 'Activating…' : preview.alreadyActivated ? 'Already added' : `Activate separate ${preview.kind}`} disabled={busy || applying || preview.alreadyActivated} onPress={() => void activate()} />
      <Button label="Cancel preview" tone="quiet" disabled={busy || applying} onPress={() => resetSelection(selectedArchiveId, selectedCohortId)} />
    </View> : null}
    {message ? <Text style={s.knowledgeFootnote}>{message}</Text> : null}
  </View>;
}

function ImportedEntityDetails({
  entity,
  cohort,
  archive,
}: {
  entity: Person | Project;
  cohort: NonNullable<ImportedBackupArchive['archivedKnowledge']>[number];
  archive: ImportedBackupArchive;
}) {
  const relatedItems = [
    ...entity.facts.map((item) => ({ key: `fact:${item.id}`, label: `Fact · ${item.statement}`, provenance: item.provenance })),
    ...entity.sourceLinks.map((item) => ({ key: `link:${item.id}`, label: `Source link · ${item.label} · ${archivedReferenceLabel(item.reference, cohort, archive)}`, provenance: item.provenance })),
    ...('contacts' in entity ? entity.contacts.map((item) => ({ key: `contact:${item.id}`, label: `Contact claim · ${item.label}: ${item.address}`, provenance: item.provenance })) : []),
    ...('members' in entity ? entity.members.map((member) => {
      const originalPersonId = 'personId' in member ? member.personId : member.sourcePersonId;
      const person = cohort.knowledge.state.people.find((item) => item.id === originalPersonId);
      return { key: `member:${member.id}`, label: `Member · ${person?.name ?? ('label' in member ? member.label : 'Unavailable person')}${member.role ? ` · ${member.role}` : ''}`, provenance: member.provenance };
    }) : []),
  ];

  return <View style={{ gap: 8 }}>
    {relatedItems.length ? <>
      <Text style={s.analysisSource}>Imported claims and links</Text>
      {relatedItems.map((item) => <View key={item.key} style={s.contextSource}>
        <Text style={s.analysisText}>{item.label}</Text>
        <Text style={s.knowledgeMeta}>{item.provenance === 'user_authored' ? 'Entered by you in the archived copy' : 'Kept inference in the archived copy'}</Text>
      </View>)}
    </> : <Text style={s.knowledgeFootnote}>No facts, contact claims, source links, or members are attached to this archived item.</Text>}
    {'contacts' in entity && entity.contacts.length ? <Text style={s.knowledgeFootnote}>Contact addresses are imported claims and are not verified identities.</Text> : null}
  </View>;
}

function archivedReferenceLabel(reference: KnowledgeReference, cohort: NonNullable<ImportedBackupArchive['archivedKnowledge']>[number], archive: ImportedBackupArchive) {
  if (reference.kind === 'historical') return `${reference.originalKind} · ${reference.label} (historical)`;
  if (reference.kind === 'note') {
    return archive.noteLinks.some((link) => link.sourceId === reference.id) ? 'Saved note · imported link' : 'Saved note · historical link';
  }
  if (reference.kind === 'task') {
    return archive.taskLinks.some((link) => link.sourceId === reference.id) ? 'Saved task · imported link' : 'Saved task · historical link';
  }
  if (reference.kind === 'document') {
    const title = reference.id.split(/[\\/]/).filter(Boolean).pop() ?? 'document';
    const activatedPath = archive.documents.find((document) => document.path === reference.id)?.activatedPath;
    return activatedPath ? `Document · ${title} (archived source; separately activated as ${activatedPath})` : `Document · ${title} (inactive archived source)`;
  }
  if (reference.kind === 'person' || reference.kind === 'project') {
    const entities = reference.kind === 'person' ? cohort.knowledge.state.people : cohort.knowledge.state.projects;
    const name = entities.find((entity) => entity.id === reference.id)?.name;
    const activatedSeparately = Boolean(cohort.activationLinks?.some((link) => link.entityKind === reference.kind && link.sourceEntityId === reference.id));
    return `${reference.kind === 'person' ? 'Person' : 'Project'} · ${name ?? 'historical entity unavailable'} (archived source; ${activatedSeparately ? 'linked only to a previously added separate copy' : 'no separate copy linked'})`;
  }
  return reference.kind === 'mail' ? 'Mail · historical provider reference' : 'Calendar · historical provider reference';
}
