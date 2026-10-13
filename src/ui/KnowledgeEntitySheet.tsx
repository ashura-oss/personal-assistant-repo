import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { KnowledgeReference, Person, Project, ProjectMember } from '../knowledge/types';
import type { SavePersonInput, SaveProjectInput } from '../core';
import { Button, Field, IconButton } from './primitives';
import { s } from './theme';

type Entity = Person | Project;
type Props = {
  visible: boolean;
  kind: 'person' | 'project';
  entity?: Entity;
  people: Person[];
  documents: { path: string; revision: number; content: string }[];
  references: { reference: KnowledgeReference; label: string }[];
  busy: boolean;
  onClose: () => void;
  onSavePerson: (input: SavePersonInput) => Promise<unknown>;
  onSaveProject: (input: SaveProjectInput) => Promise<unknown>;
  onSaveFact: (input: { entityKind: 'person' | 'project'; entityId: string; expectedEntityRevision: number; itemId?: string; statement: string }) => Promise<unknown>;
  onRemoveFact: (input: { entityKind: 'person' | 'project'; entityId: string; expectedEntityRevision: number; itemId: string }) => Promise<unknown>;
  onSaveContact: (input: { entityKind: 'person'; entityId: string; expectedEntityRevision: number; itemId?: string; address: string; label: string }) => Promise<unknown>;
  onRemoveContact: (input: { entityKind: 'person'; entityId: string; expectedEntityRevision: number; itemId: string }) => Promise<unknown>;
  onSaveSourceLink: (input: { entityKind: 'person' | 'project'; entityId: string; expectedEntityRevision: number; itemId?: string; reference: KnowledgeReference; label: string }) => Promise<unknown>;
  onRemoveSourceLink: (input: { entityKind: 'person' | 'project'; entityId: string; expectedEntityRevision: number; itemId: string }) => Promise<unknown>;
  onSaveMember: (input: { entityKind: 'project'; entityId: string; expectedEntityRevision: number; itemId?: string; personId: string; personRevision: number; role: string }) => Promise<unknown>;
  onRemoveMember: (input: { entityKind: 'project'; entityId: string; expectedEntityRevision: number; itemId: string }) => Promise<unknown>;
};

export function KnowledgeEntitySheet(props: Props) {
  const { visible, kind, entity, people, documents, references, busy, onClose } = props;
  const project = entity && kind === 'project' ? entity as Project : undefined;
  const person = entity && kind === 'person' ? entity as Person : undefined;
  const referenceOptions = references.filter(({ reference }) => !(entity && reference.kind === kind && reference.id === entity.id));
  const narrativeDoc = entity ? documents.find((doc) => doc.path === entity.narrativePath) : undefined;
  const [openingSnapshot] = useState({
    documentRevision: narrativeDoc?.revision,
    name: entity?.name ?? '', aliases: entity?.aliases.join(', ') ?? '', narrative: narrativeDoc?.content ?? '',
    goal: project?.goal ?? '', status: project?.status ?? 'planned' as Project['status'],
    startsOn: project?.startsOn ?? '', targetOn: project?.targetOn ?? '', timeZone: project?.dateTimeZone ?? '',
  });
  const [baseRevision, setBaseRevision] = useState(entity?.revision);
  const [baseDocumentRevision] = useState(narrativeDoc?.revision);
  const [name, setName] = useState(() => entity?.name ?? '');
  const [aliases, setAliases] = useState(() => entity?.aliases.join(', ') ?? '');
  const [narrative, setNarrative] = useState(() => narrativeDoc?.content ?? '');
  const [goal, setGoal] = useState(() => project?.goal ?? '');
  const [status, setStatus] = useState<Project['status']>(() => project?.status ?? 'planned');
  const [startsOn, setStartsOn] = useState(() => project?.startsOn ?? '');
  const [targetOn, setTargetOn] = useState(() => project?.targetOn ?? '');
  const [timeZone, setTimeZone] = useState(() => project?.dateTimeZone ?? '');
  const [fact, setFact] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const [contactLabel, setContactLabel] = useState('Email address');
  const [selectedReference, setSelectedReference] = useState<KnowledgeReference | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [memberId, setMemberId] = useState('');
  const [memberRole, setMemberRole] = useState('');
  const [message, setMessage] = useState('');
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const formDirty = name !== openingSnapshot.name || aliases !== openingSnapshot.aliases || narrative !== openingSnapshot.narrative || goal !== openingSnapshot.goal || status !== openingSnapshot.status || startsOn !== openingSnapshot.startsOn || targetOn !== openingSnapshot.targetOn || timeZone !== openingSnapshot.timeZone;
  const sourceChanged = Boolean(entity && (entity.revision !== baseRevision || narrativeDoc?.revision !== baseDocumentRevision));
  const itemDisabled = busy || formDirty || sourceChanged;
  const selectedReferenceKey = selectedReference ? referenceKey(selectedReference) : undefined;
  const selectedReferenceAvailable = Boolean(selectedReferenceKey && referenceOptions.some(({ reference }) => referenceKey(reference) === selectedReferenceKey));

  const submit = async () => {
    setMessage('');
    try {
      const common = {
        ...(entity ? { id: entity.id, expectedRevision: baseRevision ?? entity.revision, expectedDocumentRevision: baseDocumentRevision } : {}),
        name: name.trim(),
        aliases: aliases.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        narrative,
      };
      const saved = kind === 'person'
        ? await props.onSavePerson(common)
        : await props.onSaveProject({ ...common, status, goal, ...(startsOn ? { startsOn } : {}), ...(targetOn ? { targetOn } : {}), ...(startsOn || targetOn ? { dateTimeZone: timeZone.trim() } : {}) });
      if (saved) onClose();
      else setMessage('Changes were not saved. Check the app notice, then try again.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'This item changed elsewhere. Close and reopen it to review the latest version.');
    }
  };
  const itemAction = async (action: () => Promise<unknown>) => {
    setMessage('');
    try {
      const saved = await action();
      if (!saved) return;
      setBaseRevision((revision) => revision === undefined ? undefined : revision + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The saved context changed. Reopen this item to review the latest version.');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.modalHeader}>
          <IconButton name="close" label="Close knowledge editor" onPress={onClose} />
          <Text style={s.modalTitle}>{entity ? `Edit ${kind}` : `New ${kind}`}</Text>
          <View style={{ width: 46 }} />
        </View>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          <Text style={s.kicker}>YOUR KNOWLEDGE</Text>
          {entity && 'importOrigin' in entity && entity.importOrigin ? <Text style={s.knowledgeFootnote}>Activated as a separate copy from an imported archive. It was not matched by name.</Text> : null}
          {sourceChanged ? <View style={s.analysisStale}><Text style={s.analysisText}>This item changed since you opened it. Your unsaved draft is still here; close and reopen to review the latest version.</Text></View> : null}
          <Field label="Name" value={name} onChangeText={setName} placeholder={kind === 'person' ? 'Morgan Lee' : 'Project name'} />
          <Field label="Aliases · separate with commas" value={aliases} onChangeText={setAliases} placeholder="Preferred name, team shorthand" />
          <Field label="Notes" value={narrative} onChangeText={setNarrative} multiline placeholder="What should you remember?" />
          {kind === 'project' ? <>
            <Field label="Goal" value={goal} onChangeText={setGoal} multiline placeholder="What is this project trying to do?" />
            <Text style={s.label}>Status</Text>
            <View style={s.knowledgeStatusRow}>{(['planned', 'active', 'paused', 'completed'] as const).map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: status === value }} onPress={() => setStatus(value)} style={[s.knowledgeStatusChoice, status === value && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{value}</Text></Pressable>)}</View>
            <Field label="Starts on · optional date" value={startsOn} onChangeText={setStartsOn} placeholder="YYYY-MM-DD" />
            <Field label="Target date · optional" value={targetOn} onChangeText={setTargetOn} placeholder="YYYY-MM-DD" />
            {startsOn || targetOn ? <Field label="IANA time zone for these dates" value={timeZone} onChangeText={setTimeZone} placeholder="Asia/Singapore" /> : null}
          </> : null}
          <Button label={busy ? 'Saving…' : entity ? 'Save changes' : `Create ${kind}`} onPress={() => void submit()} disabled={busy || sourceChanged || !name.trim() || (Boolean(startsOn || targetOn) && !timeZone.trim())} />
          {message ? <Text accessibilityRole="alert" style={s.knowledgeError}>{message}</Text> : null}
          {entity ? <>
            <View style={s.knowledgeDivider} />
            <Text style={s.sectionTitle}>Saved claims</Text>
            <Text style={s.knowledgeFootnote}>Claims can disagree; keep the source and history visible. “Entered by you” does not mean independently verified.</Text>
            {entity.facts.map((item) => editingFactId === item.id ? <View key={item.id} style={s.knowledgeInlineForm}><Field label="Edit fact" value={fact} onChangeText={setFact} multiline /><Button label="Save fact" tone="quiet" disabled={itemDisabled || !fact.trim()} onPress={() => void itemAction(async () => { const saved = await props.onSaveFact({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: item.id, statement: fact.trim() }); if (saved) { setEditingFactId(null); setFact(''); } return saved; })} /><Button label="Cancel edit" tone="quiet" disabled={busy} onPress={() => { setEditingFactId(null); setFact(''); }} /></View> : <ClaimRow key={item.id} title={item.statement} provenance={item.provenance} busy={itemDisabled} onEdit={() => { setEditingFactId(item.id); setFact(item.statement); }} onRemove={() => void itemAction(() => props.onRemoveFact({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: item.id }))} />)}
            {!editingFactId ? <View style={s.knowledgeInlineForm}><Field label="Add a fact" value={fact} onChangeText={setFact} placeholder="A specific detail to keep" /><Button label="Add fact" tone="quiet" disabled={itemDisabled || !fact.trim()} onPress={() => void itemAction(async () => { const saved = await props.onSaveFact({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, statement: fact.trim() }); if (saved) setFact(''); return saved; })} /></View> : null}
            {person ? <>
              {person.contacts.map((item) => editingContactId === item.id ? <View key={item.id} style={s.knowledgeInlineForm}><Field label="Contact address · unverified" value={contactAddress} onChangeText={setContactAddress} keyboardType="email-address" /><Field label="Claim label" value={contactLabel} onChangeText={setContactLabel} /><Button label="Save contact claim" tone="quiet" disabled={itemDisabled || !contactAddress.trim()} onPress={() => void itemAction(async () => { const saved = await props.onSaveContact({ entityKind: 'person', entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: item.id, address: contactAddress.trim(), label: contactLabel.trim() || 'Contact' }); if (saved) setEditingContactId(null); return saved; })} /><Button label="Cancel edit" tone="quiet" disabled={busy} onPress={() => setEditingContactId(null)} /></View> : <ClaimRow key={item.id} title={`${item.label}: ${item.address}`} provenance={item.provenance} busy={itemDisabled} onEdit={() => { setEditingContactId(item.id); setContactAddress(item.address); setContactLabel(item.label); }} onRemove={() => void itemAction(() => props.onRemoveContact({ entityKind: 'person', entityId: person.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: item.id }))} />)}
              {!editingContactId ? <View style={s.knowledgeInlineForm}><Field label="Contact address · not verified" value={contactAddress} onChangeText={setContactAddress} placeholder="name@example.com" keyboardType="email-address" /><Field label="Label" value={contactLabel} onChangeText={setContactLabel} /><Button label="Add contact claim" tone="quiet" disabled={itemDisabled || !contactAddress.trim()} onPress={() => void itemAction(async () => { const saved = await props.onSaveContact({ entityKind: 'person', entityId: person.id, expectedEntityRevision: baseRevision ?? entity.revision, address: contactAddress.trim(), label: contactLabel.trim() || 'Contact' }); if (saved) setContactAddress(''); return saved; })} /></View> : null}
            </> : null}
            {entity.sourceLinks.map((item) => editingLinkId === item.id ? <View key={item.id} style={s.knowledgeInlineForm}><Text style={s.knowledgeFootnote}>{referenceSummary(item.reference, references)}</Text><Field label="Link label" value={sourceLabel} onChangeText={setSourceLabel} /><Button label="Save link" tone="quiet" disabled={itemDisabled || !sourceLabel.trim()} onPress={() => void itemAction(async () => { const saved = await props.onSaveSourceLink({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: item.id, reference: item.reference, label: sourceLabel.trim() }); if (saved) setEditingLinkId(null); return saved; })} /><Button label="Cancel edit" tone="quiet" disabled={busy} onPress={() => setEditingLinkId(null)} /></View> : <ClaimRow key={item.id} title={`${item.label} · ${referenceSummary(item.reference, references)}`} provenance={item.provenance} busy={itemDisabled} onEdit={() => { setEditingLinkId(item.id); setSourceLabel(item.label); }} onRemove={() => void itemAction(() => props.onRemoveSourceLink({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: item.id }))} />)}
            <Text style={s.label}>Add a source link</Text>
            {referenceOptions.length ? referenceOptions.map((option) => { const key = referenceKey(option.reference); return <Pressable key={key} accessibilityRole="radio" accessibilityState={{ selected: selectedReferenceKey === key }} onPress={() => setSelectedReference({ ...option.reference })} style={[s.knowledgeStatusChoice, selectedReferenceKey === key && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{option.label}</Text></Pressable>; }) : <Text style={s.knowledgeFootnote}>No saved sources are available to link yet.</Text>}
            {selectedReference && !selectedReferenceAvailable ? <Text style={s.knowledgeError}>That source changed or is no longer available. Choose a current source.</Text> : null}
            <Field label="Why is this relevant?" value={sourceLabel} onChangeText={setSourceLabel} />
            <Button label="Save source link" tone="quiet" disabled={itemDisabled || !selectedReferenceAvailable || !sourceLabel.trim()} onPress={() => {
              const reference = selectedReference && selectedReferenceAvailable ? selectedReference : undefined;
              if (!reference) return;
              void itemAction(async () => { const saved = await props.onSaveSourceLink({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, reference, label: sourceLabel.trim() }); if (saved) { setSelectedReference(null); setSourceLabel(''); } return saved; });
            }} />
            {project ? <>
              <Text style={s.sectionTitle}>Members</Text>
              {project.members.map((member) => editingMemberId === member.id && 'personId' in member ? <View key={member.id} style={s.knowledgeInlineForm}><Text style={s.knowledgeFootnote}>{people.find((candidate) => candidate.id === member.personId)?.name ?? 'Person unavailable'}</Text><Field label="Role" value={memberRole} onChangeText={setMemberRole} /><Button label="Save member" tone="quiet" disabled={itemDisabled} onPress={() => { const selected = people.find((candidate) => candidate.id === member.personId); if (!selected) return; void itemAction(async () => { const saved = await props.onSaveMember({ entityKind: 'project', entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: member.id, personId: selected.id, personRevision: selected.revision, role: memberRole.trim() }); if (saved) setEditingMemberId(null); return saved; }); }} /><Button label="Cancel edit" tone="quiet" disabled={busy} onPress={() => setEditingMemberId(null)} /></View> : <MemberRow key={member.id} member={member} people={people} busy={itemDisabled} onEdit={() => { if ('personId' in member) { setEditingMemberId(member.id); setMemberRole(member.role); } }} onRemove={() => void itemAction(() => props.onRemoveMember({ entityKind: 'project', entityId: project.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: member.id }))} />)}
              <Text style={s.label}>Add a person</Text>
              {people.filter((candidate) => !candidate.archivedAt).map((candidate) => <Pressable key={candidate.id} accessibilityRole="radio" accessibilityState={{ selected: memberId === candidate.id }} onPress={() => setMemberId(candidate.id)} style={[s.knowledgeStatusChoice, memberId === candidate.id && s.knowledgeStatusSelected]}><Text style={s.knowledgeName}>{candidate.name}{candidate.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}</Text></Pressable>)}
              <Field label="Role" value={memberRole} onChangeText={setMemberRole} placeholder="Optional role" />
              <Button label="Add project member" tone="quiet" disabled={itemDisabled || !memberId} onPress={() => { const selected = people.find((candidate) => candidate.id === memberId); if (!selected) return; void itemAction(async () => { const saved = await props.onSaveMember({ entityKind: 'project', entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, personId: selected.id, personRevision: selected.revision, role: memberRole.trim() }); if (saved) { setMemberId(''); setMemberRole(''); } return saved; }); }} />
              {project.members.filter((member) => !('personId' in member)).map((member) => <Text key={member.id} style={s.knowledgeFootnote}>{member.label} · historical member unavailable</Text>)}
            </> : null}
          </> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ClaimRow({ title, provenance, busy, removeDisabled = busy, onEdit, onRemove }: { title: string; provenance: 'user_authored' | 'accepted_inference'; busy: boolean; removeDisabled?: boolean; onEdit: () => void; onRemove: () => void }) {
  return <View style={s.knowledgeClaim}><View style={{ flex: 1, gap: 3 }}><Text style={s.knowledgeMeta}>{provenance === 'user_authored' ? 'Entered by you' : 'Kept inference'}</Text><Text style={s.analysisText}>{title}</Text></View><Pressable accessibilityRole="button" accessibilityLabel={`Edit claim ${title.slice(0, 60)}`} disabled={busy} onPress={onEdit} style={s.knowledgeSmallAction}><Text style={s.knowledgeActionText}>Edit</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Remove claim ${title.slice(0, 60)}`} disabled={removeDisabled} onPress={onRemove} style={s.knowledgeSmallAction}><Text style={s.knowledgeActionText}>Remove</Text></Pressable></View>;
}

function MemberRow({ member, people, busy, onEdit, onRemove }: { member: ProjectMember; people: Person[]; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const person = 'personId' in member ? people.find((item) => item.id === member.personId) : undefined;
  const name = person?.name ?? ('label' in member ? member.label : 'Person unavailable');
  return <ClaimRow title={`${name}${member.role ? ` · ${member.role}` : ''}${!person && 'sourcePersonId' in member ? ' · historical member unavailable' : ''}`} provenance={member.provenance} busy={busy || !person} removeDisabled={busy} onEdit={onEdit} onRemove={onRemove} />;
}

function referenceSummary(reference: KnowledgeReference, options: { reference: KnowledgeReference; label: string }[]) {
  if (reference.kind === 'historical') return `${reference.originalKind} · ${reference.label} (historical)`;
  const match = options.find(({ reference: candidate }) => referenceKey(candidate) === referenceKey(reference));
  if (match) return match.label;
  if (reference.kind === 'person' || reference.kind === 'project') return `${reference.kind === 'person' ? 'Person' : 'Project'} · historical entity unavailable`;
  if (reference.kind === 'device_calendar_event') return 'On this iPhone · historical event unavailable';
  return `${reference.kind} · historical source unavailable`;
}

function referenceKey(reference: KnowledgeReference) {
  if (reference.kind === 'historical') return JSON.stringify([reference.kind, reference.originalKind, reference.label]);
  if (reference.kind === 'mail') return JSON.stringify([reference.kind, reference.id, reference.identityKey, reference.connectionGeneration]);
  if (reference.kind === 'calendar') return JSON.stringify([reference.kind, reference.id, reference.calendarId, reference.identityKey, reference.connectionGeneration]);
  if (reference.kind === 'device_calendar_event') return JSON.stringify([reference.kind, reference.installationId, reference.generation, reference.calendarId, reference.eventId, reference.occurrenceStart]);
  return JSON.stringify([reference.kind, reference.id]);
}
