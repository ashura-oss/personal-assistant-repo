import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button } from './primitives';
import type { ImportedArchiveDisplay, ImportedKnowledgePreviewDisplay, ImportedKnowledgeSelection } from './knowledgeDisplayTypes';
import { s } from './theme';

type Props = {
  archives: readonly ImportedArchiveDisplay[];
  busy: boolean;
  blocked: boolean;
  preparing: boolean;
  applying: boolean;
  canActivate: boolean;
  preview: ImportedKnowledgePreviewDisplay | null;
  message: string;
  onSelectionChange: (selection: ImportedKnowledgeSelection | null) => void;
  onPrepare: (selection: ImportedKnowledgeSelection) => void;
  onActivate: (selection: ImportedKnowledgeSelection, confirmed: true) => void;
  onCancel: () => void;
};

export function ImportedKnowledgeReview({ archives, busy, blocked, preparing, applying, canActivate, preview, message, onSelectionChange, onPrepare, onActivate, onCancel }: Props) {
  const [selectedArchiveId, setSelectedArchiveId] = useState('');
  const [selectedCohortId, setSelectedCohortId] = useState('');
  const [selectedEntity, setSelectedEntity] = useState<{ kind: 'person' | 'project'; id: string } | null>(null);
  const archive = archives.find((item) => item.id === selectedArchiveId);
  const cohort = archive?.archivedKnowledge?.find((item) => item.id === selectedCohortId);
  const selection = selectedEntity ? { archiveId: selectedArchiveId, cohortId: selectedCohortId, kind: selectedEntity.kind, entityId: selectedEntity.id } as const : null;
  const previewMatchesSelection = Boolean(preview && selection && preview.archiveId === selection.archiveId && preview.cohortId === selection.cohortId && preview.kind === selection.kind && preview.sourceEntityId === selection.entityId);

  useEffect(() => () => onCancel(), [onCancel]);

  const prepare = (kind: 'person' | 'project', entityId: string) => {
    if (applying || blocked || busy) return;
    const selected = { archiveId: selectedArchiveId, cohortId: selectedCohortId, kind, entityId } as const;
    setSelectedEntity({ kind, id: entityId });
    onSelectionChange(selected);
    onPrepare(selected);
  };

  const resetSelection = (nextArchiveId = '', nextCohortId = '') => {
    if (applying) return;
    onSelectionChange(null);
    onCancel();
    setSelectedArchiveId(nextArchiveId);
    setSelectedCohortId(nextCohortId);
    setSelectedEntity(null);
  };

  return <View style={{ gap: 10 }}>
    <Text style={s.sectionTitle}>Imported knowledge</Text>
    <Text style={s.knowledgeFootnote}>Imported people and projects stay archived until you choose an item and activate a separate copy. Names are never merged automatically.</Text>
    {archives.flatMap((item) => (item.archivedKnowledge ?? []).map((cohortItem) => ({ archive: item, cohort: cohortItem }))).map(({ archive: archiveItem, cohort: cohortItem }) => {
      const people = cohortItem.knowledge.state.people;
      const projects = cohortItem.knowledge.state.projects;
      return <View key={`${archiveItem.id}:${cohortItem.id}`} style={s.knowledgeCard}>
        <View style={{ flex: 1, gap: 4 }}><Text style={s.knowledgeName}>Archived backup · {new Date(archiveItem.importedAt).toLocaleDateString()}</Text><Text style={s.knowledgeMeta}>{people.length} people · {projects.length} projects · imported, not active</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Review archived knowledge from ${archiveItem.sourceFormat}`} disabled={applying || blocked} onPress={() => resetSelection(archiveItem.id, cohortItem.id)} style={s.knowledgeSmallAction}><Text style={s.knowledgeActionText}>Choose</Text></Pressable>
      </View>;
    })}
    {cohort ? <>
      {cohort.knowledge.state.people.map((person) => <View key={`person:${person.id}`} style={s.knowledgeCard}><Text style={[s.knowledgeName, { flex: 1 }]}>{person.name} · Person</Text><Button label="Review separate copy" tone="quiet" disabled={busy || blocked || applying} onPress={() => prepare('person', person.id)} /></View>)}
      {cohort.knowledge.state.projects.map((project) => <View key={`project:${project.id}`} style={s.knowledgeCard}><Text style={[s.knowledgeName, { flex: 1 }]}>{project.name} · Project</Text><Button label="Review separate copy" tone="quiet" disabled={busy || blocked || applying} onPress={() => prepare('project', project.id)} /></View>)}
    </> : null}
    {preparing ? <View style={s.knowledgeInlineForm}><Text style={s.knowledgeFootnote}>Preparing a local review…</Text><Button label="Cancel preview" tone="quiet" disabled={applying} onPress={() => resetSelection(selectedArchiveId, selectedCohortId)} /></View> : null}
    {preview && selection && cohort && previewMatchesSelection ? <View style={s.setupCard}>
      <Text style={s.kicker}>ACTIVATION PREVIEW</Text>
      <Text style={s.knowledgeName}>{preview.sourceName} · separate local copy</Text>
      <Text style={s.knowledgeMeta}>A new local {preview.kind} will be created. Existing entities and their edits stay unchanged.</Text>
      <Text style={s.knowledgeMeta}>{preview.factCount} facts · {preview.contactCount} contact claims · {preview.sourceLinkCount} source links · {preview.memberCount} members</Text>
      {preview.unavailableProviderReferenceCount ? <Text style={s.knowledgeFootnote}>{preview.unavailableProviderReferenceCount} provider references will remain historical and unavailable.</Text> : null}
      {preview.unresolvedMemberCount ? <Text style={s.knowledgeFootnote}>{preview.unresolvedMemberCount} members cannot be matched to an active person.</Text> : null}
      <Text style={s.analysisSource}>Narrative</Text><Text style={s.analysisText}>{preview.narrativeContent || 'No narrative text.'}</Text>
      <ImportedEntityDetails entity={preview.sourceEntity} cohort={cohort} archive={archive!} />
      <Text style={s.knowledgeFootnote}>This creates local knowledge only. Imported pending suggestions and historical actions remain read-only.</Text>
      {preview.alreadyActivated ? <Text style={s.knowledgeFootnote}>This archived item has already been added. Existing edits were preserved.</Text> : null}
      <Button label={applying ? 'Activating…' : preview.alreadyActivated ? 'Already added' : `Activate separate ${preview.kind}`} disabled={busy || blocked || applying || !canActivate || preview.alreadyActivated} onPress={() => onActivate(selection, true)} />
      <Button label="Cancel preview" tone="quiet" disabled={busy || applying} onPress={() => resetSelection(selectedArchiveId, selectedCohortId)} />
    </View> : null}
    {message ? <Text style={s.knowledgeFootnote}>{message}</Text> : null}
  </View>;
}

function ImportedEntityDetails({ entity, cohort, archive }: {
  entity: ImportedKnowledgePreviewDisplay['sourceEntity'];
  cohort: NonNullable<ImportedArchiveDisplay['archivedKnowledge']>[number];
  archive: ImportedArchiveDisplay;
}) {
  const relatedItems = [
    ...entity.facts.map((item) => ({ key: `fact:${item.id}`, label: `Fact · ${item.statement}`, provenance: item.provenance })),
    ...entity.sourceLinks.map((item) => ({ key: `link:${item.id}`, label: `Source link · ${item.label} · ${archivedReferenceLabel(item.reference, cohort, archive)}`, provenance: item.provenance })),
    ...('contacts' in entity ? entity.contacts.map((item) => ({ key: `contact:${item.id}`, label: `Contact claim · ${item.label}: ${item.address}`, provenance: item.provenance })) : []),
    ...('members' in entity ? entity.members.map((member) => {
      const personId = 'personId' in member ? member.personId : member.sourcePersonId;
      const person = cohort.knowledge.state.people.find((item) => item.id === personId);
      return { key: `member:${member.id}`, label: `Member · ${person?.name ?? ('label' in member ? member.label : 'Unavailable person')}${member.role ? ` · ${member.role}` : ''}`, provenance: member.provenance };
    }) : []),
  ];
  return <View style={{ gap: 8 }}>
    {relatedItems.length ? <>
      <Text style={s.analysisSource}>Imported claims and links</Text>
      {relatedItems.map((item) => <View key={item.key} style={s.contextSource}><Text style={s.analysisText}>{item.label}</Text><Text style={s.knowledgeMeta}>{item.provenance === 'user_authored' ? 'Entered by you in the archived copy' : 'Kept inference in the archived copy'}</Text></View>)}
    </> : <Text style={s.knowledgeFootnote}>No facts, contact claims, source links, or members are attached to this archived item.</Text>}
    {'contacts' in entity && entity.contacts.length ? <Text style={s.knowledgeFootnote}>Contact addresses are imported claims and are not verified identities.</Text> : null}
  </View>;
}

function archivedReferenceLabel(reference: ImportedKnowledgePreviewDisplay['sourceEntity']['sourceLinks'][number]['reference'], cohort: NonNullable<ImportedArchiveDisplay['archivedKnowledge']>[number], archive: ImportedArchiveDisplay) {
  if (reference.kind === 'historical') return `${reference.originalKind} · ${reference.label} (historical)`;
  if (reference.kind === 'note') return archive.noteLinks.some((link) => link.sourceId === reference.id) ? 'Saved note · imported link' : 'Saved note · historical link';
  if (reference.kind === 'task') return archive.taskLinks.some((link) => link.sourceId === reference.id) ? 'Saved task · imported link' : 'Saved task · historical link';
  if (reference.kind === 'document') {
    const title = reference.id.split(/[\\/]/).filter(Boolean).pop() ?? 'document';
    const activatedPath = archive.documents.find((document) => document.path === reference.id)?.activatedPath;
    return activatedPath ? `Document · ${title} (archived source; separately activated as ${activatedPath})` : `Document · ${title} (inactive archived source)`;
  }
  if (reference.kind === 'person' || reference.kind === 'project') {
    const entities = reference.kind === 'person' ? cohort.knowledge.state.people : cohort.knowledge.state.projects;
    const name = entities.find((entity) => entity.id === reference.id)?.name;
    const activated = cohort.activatedEntities.some((item) => item.entityKind === reference.kind && item.sourceEntityId === reference.id);
    return `${reference.kind === 'person' ? 'Person' : 'Project'} · ${name ?? 'historical entity unavailable'} (archived source; ${activated ? 'linked only to a previously added separate copy' : 'no separate copy linked'})`;
  }
  return reference.kind === 'mail' ? 'Mail · historical provider reference' : 'Calendar · historical provider reference';
}
