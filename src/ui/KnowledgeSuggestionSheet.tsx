import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import type { KnowledgeChange, KnowledgeReference, KnowledgeSuggestion, Person, Project } from '../knowledge/types';
import type { EditKnowledgeSuggestionInput, ReviewKnowledgeSuggestionInput } from '../core';
import { Button, Field, IconButton } from './primitives';
import { s } from './theme';

type Props = {
  suggestions: KnowledgeSuggestion[];
  people: Person[];
  projects: Project[];
  sourceLabels: Record<string, string>;
  busy: boolean;
  onReview: (id: string, input: ReviewKnowledgeSuggestionInput) => Promise<unknown>;
  onEdit: (id: string, input: EditKnowledgeSuggestionInput) => Promise<KnowledgeSuggestion | undefined>;
};

type Filter = 'pending' | 'accepted' | 'dismissed' | 'stale';
type OpenSnapshot = {
  suggestion: KnowledgeSuggestion;
  entity?: Person | Project;
  entityRevision?: number;
  memberPerson?: Person;
  memberRevision?: number;
  referencedEntity?: Person | Project;
  referenceRevision?: number;
  people: Person[];
  projects: Project[];
  sourceLabels: Record<string, string>;
};

export function KnowledgeSuggestionSheet({ suggestions, people, projects, sourceLabels, busy, onReview, onEdit }: Props) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [opened, setOpened] = useState<OpenSnapshot | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editPersonId, setEditPersonId] = useState('');
  const [message, setMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const selected = opened?.suggestion;
  const liveSuggestion = selected && suggestions.find((item) => item.id === selected.id);
  const liveEntity = selected ? findTarget(selected, people, projects) : undefined;
  const selectedEntity = opened?.entity;
  const selectedMemberPersonId = selected?.change.type === 'add_member' ? selected.change.personId : undefined;
  const liveMemberPerson = selectedMemberPersonId ? people.find((person) => person.id === selectedMemberPersonId) : undefined;
  const selectedReference = selected?.change.type === 'add_source_link' ? selected.change.reference : undefined;
  const liveReferencedEntity = selectedReference ? findReferencedEntity(selectedReference, people, projects) : undefined;
  const snapshotChanged = Boolean(selected && (
    !liveSuggestion || liveSuggestion.revision !== selected.revision ||
    liveEntity?.revision !== opened?.entityRevision ||
    (selectedMemberPersonId && liveMemberPerson?.revision !== opened?.memberRevision) ||
    (selectedReference && (selectedReference.kind === 'person' || selectedReference.kind === 'project') &&
      (!liveReferencedEntity || liveReferencedEntity.revision !== opened?.referenceRevision || Boolean(liveReferencedEntity.archivedAt)))
  ));
  const items = suggestions.filter((item) => item.status === filter).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const openSuggestion = (suggestion: KnowledgeSuggestion) => {
    const entity = findTarget(suggestion, people, projects);
    const personId = suggestion.change.type === 'add_member' ? suggestion.change.personId : undefined;
    const person = personId ? people.find((item) => item.id === personId) : undefined;
    const reference = suggestion.change.type === 'add_source_link' ? suggestion.change.reference : undefined;
    const referencedEntity = reference ? findReferencedEntity(reference, people, projects) : undefined;
    setOpened({ suggestion, entity: entity ? cloneValue(entity) : undefined, entityRevision: entity?.revision, memberPerson: person ? cloneValue(person) : undefined, memberRevision: person?.revision, referencedEntity: referencedEntity ? cloneValue(referencedEntity) : undefined, referenceRevision: referencedEntity?.revision, people: cloneValue(people), projects: cloneValue(projects), sourceLabels: { ...sourceLabels } });
    setEditing(false); setMessage(''); setSuccessMessage('');
  };

  const decide = async (decision: 'accept' | 'dismiss') => {
    if (!selected || busy || snapshotChanged) return;
    try {
      setMessage('');
      setSuccessMessage('');
      const result = await onReview(selected.id, {
        expectedRevision: selected.revision,
        decision,
        ...(decision === 'accept' && opened?.entityRevision !== undefined ? { targetRevision: opened.entityRevision } : {}),
        ...(decision === 'accept' && opened?.memberRevision !== undefined ? { memberPersonRevision: opened.memberRevision } : {}),
      });
      if (result) setOpened(null);
      else setMessage('This review could not be saved. Check the app notice, then close and reopen it.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'This review changed. Close and reopen the latest version.');
    }
  };

  const beginEdit = () => {
    if (!selected) return;
    switch (selected.change.type) {
      case 'add_fact': setEditValue(selected.change.statement); break;
      case 'add_contact': setEditValue(selected.change.address); setEditLabel(selected.change.label); break;
      case 'add_source_link': setEditValue(selected.change.label); break;
      case 'add_member': setEditValue(selected.change.role); setEditPersonId(selected.change.personId); break;
    }
    setEditing(true); setMessage(''); setSuccessMessage('');
  };

  const saveEdit = async () => {
    if (!selected || !opened || busy || snapshotChanged) return;
    const change = editedChange(selected.change, editValue, editLabel, editPersonId, opened.people);
    if (!change) { setMessage('Choose a valid value for this suggestion.'); return; }
    try {
      const result = await onEdit(selected.id, { expectedRevision: selected.revision, change, evidence: selected.evidence });
      if (!result) { setMessage('The edit was not saved. Check the app notice, then reopen this suggestion.'); return; }
      const entity = findTarget(result, people, projects);
      const personId = result.change.type === 'add_member' ? result.change.personId : undefined;
      const person = personId ? people.find((item) => item.id === personId) : undefined;
      const reference = result.change.type === 'add_source_link' ? result.change.reference : undefined;
      const referencedEntity = reference ? findReferencedEntity(reference, people, projects) : undefined;
      setOpened({ suggestion: result, entity: entity ? cloneValue(entity) : undefined, entityRevision: entity?.revision, memberPerson: person ? cloneValue(person) : undefined, memberRevision: person?.revision, referencedEntity: referencedEntity ? cloneValue(referencedEntity) : undefined, referenceRevision: referencedEntity?.revision, people: cloneValue(people), projects: cloneValue(projects), sourceLabels: { ...sourceLabels } });
      setEditing(false); setMessage(''); setSuccessMessage('The original remains in review history. This edit is a new suggestion revision.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'This suggestion changed. Close and reopen the latest version.');
    }
  };

  return <View style={{ gap: 12 }}>
    <Text style={s.sectionTitle}>Memory review</Text>
    <View style={s.librarySegments}>{(['pending', 'accepted', 'dismissed', 'stale'] as Filter[]).map((value) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: filter === value }} onPress={() => setFilter(value)} style={[s.librarySegment, filter === value && s.librarySegmentActive]}><Text style={[s.librarySegmentText, filter === value && s.librarySegmentTextActive]}>{labelCase(value)}</Text></Pressable>)}</View>
    {items.length ? items.map((item) => {
      const entity = findTarget(item, people, projects);
      return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Review ${changeLabel(item)} for ${entity?.name ?? 'unavailable entity'}`} onPress={() => openSuggestion(item)} style={s.knowledgeCard}>
        <View style={{ flex: 1, gap: 4 }}><Text style={s.knowledgeName}>{changeLabel(item)}</Text><Text style={s.knowledgeMeta}>{entity?.name ?? 'Target unavailable'} · {labelCase(item.status)}</Text><Text numberOfLines={2} style={s.knowledgeFootnote}>“{item.evidence[0]?.quote ?? 'Evidence unavailable'}”</Text></View>
      </Pressable>;
    }) : <View style={s.knowledgeEmpty}><Text style={s.emptyTitle}>{filter === 'pending' ? 'Nothing to review' : `No ${filter} suggestions`}</Text><Text style={s.emptyText}>Suggestions stay separate from saved knowledge until you review them.</Text></View>}

    <Modal visible={Boolean(opened)} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpened(null)}>
      <View style={s.safe}>
        {selected ? <>
          <View style={s.modalHeader}><IconButton name="chevron-back" label="Close suggestion review" onPress={() => setOpened(null)} /><Text style={s.modalTitle}>Memory suggestion</Text><View style={{ width: 46 }} /></View>
          <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
            <Text style={s.kicker}>{selected.status.toUpperCase()} · REVIEW BEFORE SAVING</Text>
            <Text style={s.h1Small}>{changeLabel(selected)}</Text>
            <Text style={s.analysisSource}>{selectedEntity ? `${entityLabel(selected.change.entityKind)} · ${selectedEntity.name}${selectedEntity.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}` : 'Target unavailable'}</Text>
            {selectedEntity?.archivedAt ? <Text style={s.knowledgeFootnote}>This {selected.change.entityKind} is archived.</Text> : null}
            {snapshotChanged ? <View style={s.analysisStale}><Text style={s.analysisText}>The suggestion, target, member, or linked entity changed while this sheet was open. Close and reopen it to review the current revision.</Text></View> : null}
            <Text style={s.sectionTitle}>Proposed change</Text>
            <Text style={s.analysisText}>{changeDescription(selected, opened?.people ?? [], opened?.projects ?? [], opened?.sourceLabels ?? {})}</Text>
            <Text style={s.sectionTitle}>Current saved context</Text>
            {currentTargetValues(selected, selectedEntity, opened?.people ?? [], opened?.projects ?? [], opened?.sourceLabels ?? {}).map((value, index) => <Text key={`${index}:${value}`} style={s.knowledgeFootnote}>{value}</Text>)}
            {selected.originalChange ? <View style={s.analysisStale}><Text style={s.knowledgeMeta}>Original suggestion preserved</Text><Text style={s.analysisText}>{changeDescription({ ...selected, change: selected.originalChange }, opened?.people ?? [], opened?.projects ?? [], opened?.sourceLabels ?? {})}</Text>{(selected.originalEvidence ?? []).map((item, index) => <Text key={`${item.sourceId}:${index}`} style={s.knowledgeFootnote}>“{item.quote}”</Text>)}</View> : null}
            <Text style={s.sectionTitle}>Evidence</Text>
            {selected.evidence.map((evidence, index) => <View key={`${evidence.sourceId}:${evidence.sourceVersion}:${index}`} style={s.contextSource}>
              <Text style={s.knowledgeName}>{opened?.sourceLabels[evidence.sourceId] ?? 'Historical source · unavailable'}</Text>
              <Text style={s.analysisText}>“{evidence.quote}”</Text>
            </View>)}
            {selected.status === 'stale' ? <Text style={s.knowledgeError}>{selected.staleReason || 'The source or target changed. Create a new suggestion from the current note.'}</Text> : null}
            {message ? <Text accessibilityRole="alert" style={s.knowledgeError}>{message}</Text> : null}
            {successMessage ? <Text style={s.knowledgeFootnote}>{successMessage}</Text> : null}
            {selected.status === 'pending' && !editing ? <>
              <Button label="Edit suggestion" tone="quiet" disabled={busy || snapshotChanged} onPress={beginEdit} />
              <Button label="Save this suggestion" disabled={busy || snapshotChanged || !selectedEntity || Boolean(selectedEntity?.archivedAt)} onPress={() => void decide('accept')} />
              <Button label="Dismiss suggestion" tone="quiet" disabled={busy || snapshotChanged} onPress={() => void decide('dismiss')} />
              <Text style={s.knowledgeFootnote}>Saving adds a new claim or link and keeps its evidence. It does not send a message or verify contact details.</Text>
            </> : null}
            {editing ? <>
              {selected.change.type === 'add_fact' ? <Field label="Proposed fact" value={editValue} onChangeText={setEditValue} multiline /> : null}
              {selected.change.type === 'add_contact' ? <><Field label="Contact address · not verified" value={editValue} onChangeText={setEditValue} keyboardType="email-address" /><Field label="Claim label" value={editLabel} onChangeText={setEditLabel} /></> : null}
              {selected.change.type === 'add_source_link' ? <Field label="Link label" value={editValue} onChangeText={setEditValue} /> : null}
              {selected.change.type === 'add_member' ? <><Text style={s.label}>Person</Text>{(opened?.people ?? []).filter((person) => !person.archivedAt).map((person) => <Pressable key={person.id} accessibilityRole="radio" accessibilityState={{ selected: editPersonId === person.id }} onPress={() => setEditPersonId(person.id)} style={[s.knowledgeStatusChoice, editPersonId === person.id && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{person.name}{person.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}</Text></Pressable>)}<Field label="Role" value={editValue} onChangeText={setEditValue} /></> : null}
              <Button label="Save as a new suggestion revision" disabled={busy || snapshotChanged || !editValue.trim()} onPress={() => void saveEdit()} />
              <Button label="Cancel edit" tone="quiet" disabled={busy} onPress={() => setEditing(false)} />
            </> : null}
          </ScrollView>
        </> : null}
      </View>
    </Modal>
  </View>;
}

function findTarget(suggestion: KnowledgeSuggestion, people: Person[], projects: Project[]) {
  return suggestion.change.entityKind === 'person'
    ? people.find((item) => item.id === suggestion.change.entityId)
    : projects.find((item) => item.id === suggestion.change.entityId);
}

function findReferencedEntity(reference: KnowledgeReference, people: Person[], projects: Project[]) {
  if (reference.kind === 'person') return people.find((item) => item.id === reference.id);
  if (reference.kind === 'project') return projects.find((item) => item.id === reference.id);
  return undefined;
}

function changeLabel(item: KnowledgeSuggestion) {
  switch (item.change.type) {
    case 'add_fact': return 'Add a fact';
    case 'add_contact': return 'Add a contact claim';
    case 'add_member': return 'Add a project member';
    case 'add_source_link': return 'Connect a source';
  }
}

function changeDescription(item: KnowledgeSuggestion, people: Person[], projects: Project[], sourceLabels: Record<string, string>) {
  switch (item.change.type) {
    case 'add_fact': return item.change.statement;
    case 'add_contact': return `${item.change.label}: ${item.change.address} · entered as a claim, not verified`;
    case 'add_member': return `${item.change.role || 'Member'} · person selection is revision-bound`;
    case 'add_source_link': return `${item.change.label} · ${referenceLabel(item.change.reference, people, projects, sourceLabels)}`;
  }
}

function editedChange(change: KnowledgeChange, value: string, label: string, personId: string, people: Person[]): KnowledgeChange | undefined {
  switch (change.type) {
    case 'add_fact': return { ...change, statement: value.trim() };
    case 'add_contact': return { ...change, address: value.trim(), label: label.trim() || 'Contact' };
    case 'add_source_link': return { ...change, label: value.trim() };
    case 'add_member': {
      const person = people.find((item) => item.id === personId);
      return person ? { ...change, personId: person.id, personRevision: person.revision, role: value.trim() } : undefined;
    }
  }
}

function currentTargetValues(suggestion: KnowledgeSuggestion, entity: Person | Project | undefined, people: Person[], projects: Project[], sourceLabels: Record<string, string>) {
  if (!entity) return ['Current target is unavailable.'];
  if (suggestion.change.type === 'add_fact') return entity.facts.length ? entity.facts.map((item) => `Saved fact · ${item.statement}`) : ['No saved facts yet.'];
  if (suggestion.change.type === 'add_contact' && 'contacts' in entity) return entity.contacts.length ? entity.contacts.map((item) => `Contact claim · ${item.label}: ${item.address}`) : ['No contact claims yet.'];
  if (suggestion.change.type === 'add_source_link') return entity.sourceLinks.length ? entity.sourceLinks.map((item) => `Source link · ${item.label} · ${referenceLabel(item.reference, people, projects, sourceLabels)}`) : ['No source links yet.'];
  if (suggestion.change.type === 'add_member' && 'members' in entity) return entity.members.length ? entity.members.map((member) => {
    const person = 'personId' in member ? people.find((item) => item.id === member.personId) : undefined;
    const name = person?.name ?? ('label' in member ? member.label : 'Person unavailable');
    return `Member · ${name}${person?.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}${member.role ? ` · ${member.role}` : ''}${!person && 'sourcePersonId' in member ? ' · historical unavailable' : ''}`;
  }) : ['No members yet.'];
  return ['No matching saved claims.'];
}

function referenceLabel(reference: KnowledgeReference, people: Person[] = [], projects: Project[] = [], sourceLabels: Record<string, string> = {}) {
  if (reference.kind === 'historical') return `${reference.originalKind} · ${reference.label} (historical)`;
  if (reference.kind === 'person') {
    const person = people.find((item) => item.id === reference.id);
    return person ? `Person · ${person.name}${person.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}` : 'Person · historical entity unavailable';
  }
  if (reference.kind === 'project') {
    const project = projects.find((item) => item.id === reference.id);
    return project ? `Project · ${project.name}${project.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}` : 'Project · historical entity unavailable';
  }
  if (reference.kind === 'calendar') {
    const sourceId = `calendar-event:${encodeURIComponent(reference.identityKey)}:${encodeURIComponent(reference.calendarId)}:${encodeURIComponent(reference.id)}`;
    return sourceLabels[sourceId] ?? 'Calendar · historical source unavailable';
  }
  if (reference.kind === 'mail') {
    const sourceId = `mail:${encodeURIComponent(reference.identityKey)}:${encodeURIComponent(reference.id)}`;
    return sourceLabels[sourceId] ?? 'Mail · historical source unavailable';
  }
  return `${reference.kind} · ${reference.id}`;
}

function entityLabel(kind: 'person' | 'project') { return kind === 'person' ? 'Person' : 'Project'; }
function labelCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function cloneValue<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
