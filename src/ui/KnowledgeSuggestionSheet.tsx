import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import type { KnowledgeChangeDisplay, KnowledgePersonDisplay, KnowledgeProjectDisplay, KnowledgeReferenceDisplay, KnowledgeSuggestionDisplay, KnowledgeSuggestionEditCommand, KnowledgeSuggestionReviewCommand, KnowledgeSuggestionReviewDisplay } from './knowledgeDisplayTypes';
import { KnowledgeSuggestionReviewOwnership, type KnowledgeSuggestionReviewOwner } from './knowledgeSuggestionReviewOwnership';
import { Button, Field, IconButton } from './primitives';
import { s } from './theme';

type Props = {
  suggestions: readonly KnowledgeSuggestionDisplay[];
  people: readonly KnowledgePersonDisplay[];
  projects: readonly KnowledgeProjectDisplay[];
  sourceLabels: Readonly<Record<string, string>>;
  busy: boolean;
  blocked?: boolean;
  openRequest?: Readonly<{ suggestionId: string; requestId: number }>;
  onRequestHandled?: (requestId: number) => void;
  onPrepareReview: (id: string, input: { expectedRevision: number }) => Promise<KnowledgeSuggestionReviewDisplay>;
  onReview: (id: string, input: KnowledgeSuggestionReviewCommand) => Promise<unknown>;
  onEdit: (id: string, input: KnowledgeSuggestionEditCommand) => Promise<KnowledgeSuggestionDisplay | undefined>;
};


type Filter = 'pending' | 'accepted' | 'dismissed' | 'stale';
type OpenSnapshot = {
  suggestion: KnowledgeSuggestionDisplay;
  entity?: KnowledgePersonDisplay | KnowledgeProjectDisplay;
  entityRevision?: number;
  memberPerson?: KnowledgePersonDisplay;
  memberRevision?: number;
  referencedEntity?: KnowledgePersonDisplay | KnowledgeProjectDisplay;
  referenceRevision?: number;
  people: readonly KnowledgePersonDisplay[];
  projects: readonly KnowledgeProjectDisplay[];
  sourceLabels: Readonly<Record<string, string>>;
};

export function KnowledgeSuggestionSheet({ suggestions, people, projects, sourceLabels, busy, blocked = false, openRequest, onRequestHandled, onPrepareReview, onReview, onEdit }: Props) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [opened, setOpened] = useState<OpenSnapshot | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editPersonId, setEditPersonId] = useState('');
  const [message, setMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [preparedReview, setPreparedReview] = useState<KnowledgeSuggestionReviewDisplay>();
  const [preparingReview, setPreparingReview] = useState(false);
  const [preflightReason, setPreflightReason] = useState('');
  const [selectedOwnerGeneration, setSelectedOwnerGeneration] = useState<number | undefined>(undefined);
  const ownerRef = useRef(new KnowledgeSuggestionReviewOwnership<KnowledgeSuggestionReviewDisplay>());
  const selectedOwnerRef = useRef<KnowledgeSuggestionReviewOwner | undefined>(undefined);
  const actionLock = useRef(false);
  const actionTokenSequence = useRef(0);
  const activeActionTokenRef = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const pendingEditedPreflightRef = useRef<KnowledgeSuggestionReviewOwner | undefined>(undefined);
  const [waitingEditedRevision, setWaitingEditedRevision] = useState(false);
  const requestIdRef = useRef<number | undefined>(openRequest?.requestId);
  const requestRef = useRef(openRequest);
  const openSuggestionRef = useRef<(suggestion: KnowledgeSuggestionDisplay) => void>(() => undefined);
  const contextRef = useRef({ suggestions, people, projects, blocked, busy, onPrepareReview, onRequestHandled });
  useLayoutEffect(() => { contextRef.current = { suggestions, people, projects, blocked, busy, onPrepareReview, onRequestHandled }; }, [suggestions, people, projects, blocked, busy, onPrepareReview, onRequestHandled]);
  useLayoutEffect(() => {
    mounted.current = true;
    const ownership = ownerRef.current;
    return () => { mounted.current = false; ownership.publish(); selectedOwnerRef.current = undefined; };
  }, []);
  useLayoutEffect(() => { requestIdRef.current = openRequest?.requestId; requestRef.current = openRequest; }, [openRequest]);
  const selected = opened?.suggestion;
  const liveSuggestion = selected && suggestions.find((item) => item.id === selected.id);
  const liveEntity = selected ? findTarget(selected, people, projects) : undefined;
  const selectedEntity = opened?.entity;
  const selectedMemberPersonId = selected?.change.type === 'add_member' ? selected.change.personId : undefined;
  const liveMemberPerson = selectedMemberPersonId ? people.find((person) => person.id === selectedMemberPersonId) : undefined;
  const selectedReference = selected?.change.type === 'add_source_link' ? selected.change.reference : undefined;
  const liveReferencedEntity = selectedReference ? findReferencedEntity(selectedReference, people, projects) : undefined;
  const suggestionChanged = Boolean(selected && (!liveSuggestion || liveSuggestion.revision !== selected.revision));
  const preparedReviewCurrent = Boolean(selected && preparedReview?.suggestion.id === selected.id && preparedReview.suggestion.revision === selected.revision);
  const targetSnapshotChanged = Boolean(selected && (
    liveEntity?.revision !== opened?.entityRevision ||
    (selectedMemberPersonId && liveMemberPerson?.revision !== opened?.memberRevision) ||
    (selectedReference && (selectedReference.kind === 'person' || selectedReference.kind === 'project') &&
      (!liveReferencedEntity || liveReferencedEntity.revision !== opened?.referenceRevision || Boolean(liveReferencedEntity.archivedAt)))
  ));
  const reviewIsPreparing = preparingReview && selectedOwnerGeneration !== undefined;
  const items = suggestions.filter((item) => item.status === filter).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const isOwnerCurrent = useCallback((owner: KnowledgeSuggestionReviewOwner) => {
    const context = contextRef.current;
    const current = context.suggestions.find((item) => item.id === owner.suggestionId);
    return mounted.current && !context.blocked && ownerRef.current.owns(owner) &&
      (!context.busy || actionLock.current) && current?.revision === owner.revision && current.status === 'pending';
  }, []);

  const closeSuggestion = () => {
    ownerRef.current.publish(); selectedOwnerRef.current = undefined; setSelectedOwnerGeneration(undefined); pendingEditedPreflightRef.current = undefined; setWaitingEditedRevision(false); actionLock.current = false; activeActionTokenRef.current = undefined;
    setOpened(null); setEditing(false); setPreparedReview(undefined); setPreparingReview(false); setPreflightReason('');
  };

  const prepareCurrent = useCallback(async (owner: KnowledgeSuggestionReviewOwner) => {
    setPreparingReview(true); setPreparedReview(undefined); setPreflightReason('');
    try {
      const result = await ownerRef.current.prepare({
        owner,
        isCurrent: () => isOwnerCurrent(owner),
        prepare: () => contextRef.current.onPrepareReview(owner.suggestionId, { expectedRevision: owner.revision }),
      });
      if (result.kind === 'prepared' && isOwnerCurrent(owner)) {
        setPreparedReview(result.review);
        setPreflightReason(result.review.reason ?? '');
      }
    } catch (error) {
      if (isOwnerCurrent(owner)) setPreflightReason(error instanceof Error ? error.message : 'Could not check the latest suggestion. Close and reopen it.');
    } finally {
      if (ownerRef.current.owns(owner)) setPreparingReview(false);
    }
  }, [isOwnerCurrent]);

  const openSuggestion = (suggestion: KnowledgeSuggestionDisplay) => {
    if (blocked || busy || actionLock.current) return;
    pendingEditedPreflightRef.current = undefined;
    const entity = findTarget(suggestion, people, projects);
    const personId = suggestion.change.type === 'add_member' ? suggestion.change.personId : undefined;
    const person = personId ? people.find((item) => item.id === personId) : undefined;
    const reference = suggestion.change.type === 'add_source_link' ? suggestion.change.reference : undefined;
    const referencedEntity = reference ? findReferencedEntity(reference, people, projects) : undefined;
    setOpened({ suggestion, entity, entityRevision: entity?.revision, memberPerson: person, memberRevision: person?.revision, referencedEntity, referenceRevision: referencedEntity?.revision, people, projects, sourceLabels });
    setEditing(false); setMessage(''); setSuccessMessage('');
    setPreparedReview(undefined); setPreflightReason('');
    const owner = ownerRef.current.publish(suggestion.id, suggestion.revision)!;
    selectedOwnerRef.current = owner;
    setSelectedOwnerGeneration(owner.generation);
    if (suggestion.status === 'pending') void prepareCurrent(owner);
  };
  useLayoutEffect(() => { openSuggestionRef.current = openSuggestion; });

  useEffect(() => {
    const request = requestRef.current;
    if (!request) return;
    if (blocked) { contextRef.current.onRequestHandled?.(request.requestId); return; }
    if (busy) return;
    void Promise.resolve().then(() => {
      if (!mounted.current || requestIdRef.current !== request.requestId || requestRef.current?.requestId !== request.requestId || contextRef.current.blocked || contextRef.current.busy) return;
      const suggestion = contextRef.current.suggestions.find((item) => item.id === request.suggestionId && item.status === 'pending');
      if (suggestion) openSuggestionRef.current(suggestion);
      else setMessage('This Chat suggestion is no longer pending. Refresh the latest Memory list.');
      contextRef.current.onRequestHandled?.(request.requestId);
    });
  }, [openRequest?.requestId, blocked, busy]);

  useEffect(() => {
    const owner = pendingEditedPreflightRef.current;
    if (!owner || blocked || busy || !ownerRef.current.owns(owner)) return;
    const live = suggestions.find((item) => item.id === owner.suggestionId);
    if (!live || live.revision !== owner.revision || live.status !== 'pending') return;
    pendingEditedPreflightRef.current = undefined;
    void Promise.resolve().then(() => {
      if (!mounted.current || blocked || busy || !isOwnerCurrent(owner)) return;
      setWaitingEditedRevision(false);
      void prepareCurrent(owner);
    });
  }, [suggestions, blocked, busy, waitingEditedRevision, isOwnerCurrent, prepareCurrent]);

  useLayoutEffect(() => {
    if (blocked && selectedOwnerRef.current) {
      ownerRef.current.publish();
      selectedOwnerRef.current = undefined;
      activeActionTokenRef.current = undefined;
      actionLock.current = false;
      pendingEditedPreflightRef.current = undefined;
      void Promise.resolve().then(() => {
        if (!mounted.current || selectedOwnerRef.current) return;
        setOpened(null); setEditing(false); setPreparedReview(undefined); setPreparingReview(false); setPreflightReason(''); setSelectedOwnerGeneration(undefined); setWaitingEditedRevision(false);
      });
    }
  }, [blocked]);

  const decide = async (decision: 'accept' | 'dismiss') => {
    const owner = selectedOwnerRef.current;
    if (!selected || !owner || busy || blocked || actionLock.current || suggestionChanged || selected.status !== 'pending' ||
      (decision === 'dismiss' ? false : targetSnapshotChanged || !preparedReviewCurrent || !preparedReview ||
        ownerRef.current.current(owner)?.canAccept !== true)) return;
    if (decision === 'dismiss' && !preparedReviewCurrent && !preflightReason && !suggestionChanged) return;
    if (!isOwnerCurrent(owner)) return;
    actionLock.current = true;
    const actionToken = ++actionTokenSequence.current;
    activeActionTokenRef.current = actionToken;
    try {
      setMessage('');
      setSuccessMessage('');
      const result = await onReview(owner.suggestionId, {
        expectedRevision: selected.revision,
        decision,
        ...(decision === 'accept' && opened?.entityRevision !== undefined ? { targetRevision: opened.entityRevision } : {}),
        ...(decision === 'accept' && opened?.memberRevision !== undefined ? { memberPersonRevision: opened.memberRevision } : {}),
      });
      if (!ownerRef.current.owns(owner)) return;
      if (result) closeSuggestion();
      else if (isOwnerCurrent(owner)) setMessage('This review could not be saved. Check the app notice, then close and reopen it.');
    } catch (error) {
      if (isOwnerCurrent(owner)) setMessage(error instanceof Error ? error.message : 'This review changed. Close and reopen the latest version.');
    } finally {
      if (activeActionTokenRef.current === actionToken) { actionLock.current = false; activeActionTokenRef.current = undefined; }
    }
  };

  const beginEdit = () => {
    const owner = selectedOwnerRef.current;
    if (!selected || !owner || !isOwnerCurrent(owner) || suggestionChanged || targetSnapshotChanged ||
      !preparedReviewCurrent || !preparedReview || ownerRef.current.current(owner)?.canEdit !== true || busy || blocked || actionLock.current) return;
    switch (selected.change.type) {
      case 'add_fact': setEditValue(selected.change.statement); break;
      case 'add_contact': setEditValue(selected.change.address); setEditLabel(selected.change.label); break;
      case 'add_source_link': setEditValue(selected.change.label); break;
      case 'add_member': setEditValue(selected.change.role); setEditPersonId(selected.change.personId); break;
    }
    setEditing(true); setMessage(''); setSuccessMessage('');
  };

  const saveEdit = async () => {
    const owner = selectedOwnerRef.current;
    if (!selected || !opened || !owner || busy || blocked || actionLock.current || suggestionChanged || targetSnapshotChanged ||
      !preparedReviewCurrent || !preparedReview || ownerRef.current.current(owner)?.canEdit !== true || !isOwnerCurrent(owner)) return;
    const change = editedChange(selected.change, editValue, editLabel, editPersonId, opened.people);
    if (!change) { setMessage('Choose a valid value for this suggestion.'); return; }
    actionLock.current = true;
    const actionToken = ++actionTokenSequence.current;
    activeActionTokenRef.current = actionToken;
    try {
      const result = await onEdit(owner.suggestionId, { expectedRevision: owner.revision, change, evidence: selected.evidence });
      if (!ownerRef.current.owns(owner) || selectedOwnerRef.current?.generation !== owner.generation) return;
      if (!result) { setMessage('The edit was not saved. Check the app notice, then reopen this suggestion.'); return; }
      if (result.id !== owner.suggestionId || result.revision <= owner.revision) { setMessage('The edit result could not be matched to this suggestion. Reopen the latest Memory list.'); return; }
      const entity = findTarget(result, people, projects);
      const personId = result.change.type === 'add_member' ? result.change.personId : undefined;
      const person = personId ? people.find((item) => item.id === personId) : undefined;
      const reference = result.change.type === 'add_source_link' ? result.change.reference : undefined;
      const referencedEntity = reference ? findReferencedEntity(reference, people, projects) : undefined;
      setOpened({ suggestion: result, entity, entityRevision: entity?.revision, memberPerson: person, memberRevision: person?.revision, referencedEntity, referenceRevision: referencedEntity?.revision, people, projects, sourceLabels });
      const nextOwner = ownerRef.current.publish(result.id, result.revision)!;
      selectedOwnerRef.current = nextOwner;
      setSelectedOwnerGeneration(nextOwner.generation);
      setPreparedReview(undefined); setPreparingReview(false); setPreflightReason('');
      pendingEditedPreflightRef.current = nextOwner;
      setWaitingEditedRevision(true);
      setEditing(false); setMessage(''); setSuccessMessage('The original remains in review history. This edit is a new suggestion revision.');
    } catch (error) {
      if (isOwnerCurrent(owner)) setMessage(error instanceof Error ? error.message : 'This suggestion changed. Close and reopen the latest version.');
    } finally {
      if (activeActionTokenRef.current === actionToken) { actionLock.current = false; activeActionTokenRef.current = undefined; }
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

    <Modal visible={Boolean(opened && selectedOwnerGeneration !== undefined && !blocked)} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeSuggestion}>
      <View style={s.safe}>
        {selected ? <>
          <View style={s.modalHeader}><IconButton name="chevron-back" label="Close suggestion review" onPress={closeSuggestion} /><Text style={s.modalTitle}>Memory suggestion</Text><View style={{ width: 46 }} /></View>
          <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
            <Text style={s.kicker}>{selected.status.toUpperCase()} · REVIEW BEFORE SAVING</Text>
            <Text style={s.h1Small}>{changeLabel(selected)}</Text>
            <Text style={s.analysisSource}>{selectedEntity ? `${entityLabel(selected.change.entityKind)} · ${selectedEntity.name}${selectedEntity.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}` : 'Target unavailable'}</Text>
            {selectedEntity?.archivedAt ? <Text style={s.knowledgeFootnote}>This {selected.change.entityKind} is archived.</Text> : null}
            {suggestionChanged ? <View style={s.analysisStale}><Text style={s.analysisText}>This suggestion changed. Close and reopen the latest revision before reviewing it.</Text></View> : null}
            {targetSnapshotChanged && !suggestionChanged ? <View style={s.analysisStale}><Text style={s.analysisText}>The target, member, or linked entity changed while this sheet was open. Edit or save is unavailable. You can still dismiss this exact suggestion revision.</Text></View> : null}
            {selected.status === 'pending' && reviewIsPreparing ? <Text style={s.knowledgeFootnote}>Checking the current source before enabling review…</Text> : null}
            {selected.status === 'pending' && waitingEditedRevision ? <Text style={s.knowledgeFootnote}>Waiting for the saved revision before checking it…</Text> : null}
            {selected.status === 'pending' && preflightReason ? <Text style={s.knowledgeError}>{preflightReason}</Text> : null}
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
              <Button label="Edit suggestion" tone="quiet" disabled={blocked || busy || selectedOwnerGeneration === undefined || reviewIsPreparing || !preparedReviewCurrent || !preparedReview?.canEdit || targetSnapshotChanged || suggestionChanged} onPress={beginEdit} />
              <Button label="Save this suggestion" disabled={blocked || busy || selectedOwnerGeneration === undefined || reviewIsPreparing || !preparedReviewCurrent || !preparedReview?.canAccept || targetSnapshotChanged || suggestionChanged || !selectedEntity || Boolean(selectedEntity?.archivedAt)} onPress={() => void decide('accept')} />
              <Button label="Dismiss suggestion" tone="quiet" disabled={blocked || busy || selectedOwnerGeneration === undefined || reviewIsPreparing || (!preparedReviewCurrent && !preflightReason) || suggestionChanged} onPress={() => void decide('dismiss')} />
              <Text style={s.knowledgeFootnote}>Saving adds a new claim or link and keeps its evidence. It does not send a message or verify contact details.</Text>
            </> : null}
            {editing ? <>
              {selected.change.type === 'add_fact' ? <Field label="Proposed fact" value={editValue} onChangeText={setEditValue} multiline /> : null}
              {selected.change.type === 'add_contact' ? <><Field label="Contact address · not verified" value={editValue} onChangeText={setEditValue} keyboardType="email-address" /><Field label="Claim label" value={editLabel} onChangeText={setEditLabel} /></> : null}
              {selected.change.type === 'add_source_link' ? <Field label="Link label" value={editValue} onChangeText={setEditValue} /> : null}
              {selected.change.type === 'add_member' ? <><Text style={s.label}>Person</Text>{(opened?.people ?? []).filter((person) => !person.archivedAt).map((person) => <Pressable key={person.id} accessibilityRole="radio" accessibilityState={{ selected: editPersonId === person.id }} onPress={() => setEditPersonId(person.id)} style={[s.knowledgeStatusChoice, editPersonId === person.id && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{person.name}{person.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}</Text></Pressable>)}<Field label="Role" value={editValue} onChangeText={setEditValue} /></> : null}
              <Button label="Save as a new suggestion revision" disabled={blocked || busy || selectedOwnerGeneration === undefined || !preparedReviewCurrent || !preparedReview?.canEdit || targetSnapshotChanged || suggestionChanged || !editValue.trim()} onPress={() => void saveEdit()} />
              <Button label="Cancel edit" tone="quiet" disabled={busy} onPress={() => setEditing(false)} />
            </> : null}
          </ScrollView>
        </> : null}
      </View>
    </Modal>
  </View>;
}

function findTarget(suggestion: KnowledgeSuggestionDisplay, people: readonly KnowledgePersonDisplay[], projects: readonly KnowledgeProjectDisplay[]) {
  return suggestion.change.entityKind === 'person'
    ? people.find((item) => item.id === suggestion.change.entityId)
    : projects.find((item) => item.id === suggestion.change.entityId);
}

function findReferencedEntity(reference: KnowledgeReferenceDisplay, people: readonly KnowledgePersonDisplay[], projects: readonly KnowledgeProjectDisplay[]) {
  if (reference.kind === 'person') return people.find((item) => item.id === reference.id);
  if (reference.kind === 'project') return projects.find((item) => item.id === reference.id);
  return undefined;
}

function changeLabel(item: KnowledgeSuggestionDisplay) {
  switch (item.change.type) {
    case 'add_fact': return 'Add a fact';
    case 'add_contact': return 'Add a contact claim';
    case 'add_member': return 'Add a project member';
    case 'add_source_link': return 'Connect a source';
  }
}

function changeDescription(item: KnowledgeSuggestionDisplay, people: readonly KnowledgePersonDisplay[], projects: readonly KnowledgeProjectDisplay[], sourceLabels: Readonly<Record<string, string>>) {
  switch (item.change.type) {
    case 'add_fact': return item.change.statement;
    case 'add_contact': return `${item.change.label}: ${item.change.address} · entered as a claim, not verified`;
    case 'add_member': return `${item.change.role || 'Member'} · person selection is revision-bound`;
    case 'add_source_link': return `${item.change.label} · ${referenceLabel(item.change.reference, people, projects, sourceLabels)}`;
  }
}

function editedChange(change: KnowledgeChangeDisplay, value: string, label: string, personId: string, people: readonly KnowledgePersonDisplay[]): KnowledgeChangeDisplay | undefined {
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

function currentTargetValues(suggestion: KnowledgeSuggestionDisplay, entity: KnowledgePersonDisplay | KnowledgeProjectDisplay | undefined, people: readonly KnowledgePersonDisplay[], projects: readonly KnowledgeProjectDisplay[], sourceLabels: Readonly<Record<string, string>>) {
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

function referenceLabel(reference: KnowledgeReferenceDisplay, people: readonly KnowledgePersonDisplay[] = [], projects: readonly KnowledgeProjectDisplay[] = [], sourceLabels: Readonly<Record<string, string>> = {}) {
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
