import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { KnowledgeEntityDisplay, KnowledgePersonDisplay, KnowledgeProjectDisplay, KnowledgeReferenceDisplay, KnowledgeSourceChoiceDisplay } from './knowledgeDisplayTypes';
import { Button, Field, IconButton } from './primitives';
import { s } from './theme';
import type { WorkspaceActionCapability } from './workspaceCapabilities';

type PersonDisplay = KnowledgePersonDisplay;
type ProjectDisplay = KnowledgeProjectDisplay;
type EntityDisplay = KnowledgeEntityDisplay;
type ProjectMemberDisplay = ProjectDisplay['members'][number];
export type KnowledgeEntityEditCommand = Readonly<{
  id?: string;
  expectedRevision?: number;
  expectedDocumentRevision?: number;
  name: string;
  aliases: readonly string[];
  narrative: string;
}>;
export type KnowledgeProjectEditCommand = KnowledgeEntityEditCommand & Readonly<{
  status: ProjectDisplay['status'];
  goal: string;
  startsOn?: string;
  targetOn?: string;
  dateTimeZone?: string;
}>;
type KnowledgeItemCommand = Readonly<{ entityKind: 'person' | 'project'; entityId: string; expectedEntityRevision: number; itemId?: string }>;
type RemoveKnowledgeItemCommand = Omit<KnowledgeItemCommand, 'itemId'> & Readonly<{ itemId: string }>;
type Props = {
  visible: boolean;
  kind: 'person' | 'project';
  entity?: EntityDisplay;
  people: readonly PersonDisplay[];
  documents: WorkspaceSnapshotDTO['state']['documents'];
  references: readonly KnowledgeSourceChoiceDisplay[];
  workspaceRevision?: number;
  busy: boolean;
  onClose: () => void;
  onSavePerson: (input: KnowledgeEntityEditCommand) => Promise<unknown>;
  onSaveProject: (input: KnowledgeProjectEditCommand) => Promise<unknown>;
  onSaveFact: (input: { entityKind: 'person' | 'project'; entityId: string; expectedEntityRevision: number; itemId?: string; statement: string }) => Promise<unknown>;
  onRemoveFact: (input: RemoveKnowledgeItemCommand) => Promise<unknown>;
  onSaveContact: (input: { entityKind: 'person'; entityId: string; expectedEntityRevision: number; itemId?: string; address: string; label: string }) => Promise<unknown>;
  onRemoveContact: (input: Omit<RemoveKnowledgeItemCommand, 'entityKind'> & Readonly<{ entityKind: 'person' }>) => Promise<unknown>;
  sourceLinks: WorkspaceActionCapability<Readonly<{
    save: (input: { entityKind: 'person' | 'project'; entityId: string; expectedEntityRevision: number; itemId?: string; referenceChoiceId?: string; label: string }) => Promise<unknown>;
    remove: (input: RemoveKnowledgeItemCommand) => Promise<unknown>;
    loadChoices?: (expectedRevision: number) => Promise<readonly KnowledgeSourceChoiceDisplay[]>;
  }>>;
  onSaveMember: (input: { entityKind: 'project'; entityId: string; expectedEntityRevision: number; itemId?: string; personId: string; personRevision: number; role: string }) => Promise<unknown>;
  onRemoveMember: (input: Omit<RemoveKnowledgeItemCommand, 'entityKind'> & Readonly<{ entityKind: 'project' }>) => Promise<unknown>;
};

export function KnowledgeEntitySheet(props: Props) {
  const { visible, kind, entity, people, documents, references, workspaceRevision, busy, onClose } = props;
  const operation = useRef<object | undefined>(undefined);
  const sourceLoadGeneration = useRef(0);
  const sourceLoadLock = useRef(false);
  const sourceLinkActions = props.sourceLinks.available ? props.sourceLinks.action : undefined;
  const [loadedReferences, setLoadedReferences] = useState<readonly KnowledgeSourceChoiceDisplay[]>();
  const [sourceChoicesLoading, setSourceChoicesLoading] = useState(() => Boolean(visible && entity && sourceLinkActions?.loadChoices && workspaceRevision !== undefined));
  const [sourceChoicesError, setSourceChoicesError] = useState('');
  useEffect(() => () => { operation.current = undefined; }, []);
  const project = entity && 'members' in entity ? entity : undefined;
  const person = entity && 'contacts' in entity ? entity : undefined;
  const entityId = entity?.id;
  const openingSourceChoiceRead = useRef({ entityId, workspaceRevision, loadChoices: sourceLinkActions?.loadChoices });
  useLayoutEffect(() => { openingSourceChoiceRead.current = { entityId, workspaceRevision, loadChoices: sourceLinkActions?.loadChoices }; }, [entityId, workspaceRevision, sourceLinkActions?.loadChoices]);
  const availableReferences = loadedReferences ?? references;
  const referenceOptions = availableReferences.filter(({ reference }) => !(entity && reference.kind === kind && reference.id === entity.id));
  const narrativeDoc = entity ? documents.find((doc) => doc.path === entity.narrativePath) : undefined;
  const [openingSnapshot] = useState({
    documentRevision: narrativeDoc?.revision,
    name: entity?.name ?? '', aliases: entity?.aliases.join(', ') ?? '', narrative: narrativeDoc?.content ?? '',
    goal: project?.goal ?? '', status: project?.status ?? 'planned' as ProjectDisplay['status'],
    startsOn: project?.startsOn ?? '', targetOn: project?.targetOn ?? '', timeZone: project?.dateTimeZone ?? '',
  });
  const [baseRevision, setBaseRevision] = useState(entity?.revision);
  const [baseDocumentRevision] = useState(narrativeDoc?.revision);
  const [name, setName] = useState(() => entity?.name ?? '');
  const [aliases, setAliases] = useState(() => entity?.aliases.join(', ') ?? '');
  const [narrative, setNarrative] = useState(() => narrativeDoc?.content ?? '');
  const [goal, setGoal] = useState(() => project?.goal ?? '');
  const [status, setStatus] = useState<ProjectDisplay['status']>(() => project?.status ?? 'planned');
  const [startsOn, setStartsOn] = useState(() => project?.startsOn ?? '');
  const [targetOn, setTargetOn] = useState(() => project?.targetOn ?? '');
  const [timeZone, setTimeZone] = useState(() => project?.dateTimeZone ?? '');
  const [fact, setFact] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const [contactLabel, setContactLabel] = useState('Email address');
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(null);
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
  const selectedReference = referenceOptions.find((option) => option.id === selectedReferenceId);
  const selectedReferenceAvailable = Boolean(selectedReference);
  const close = () => { operation.current = undefined; onClose(); };
  const loadSourceChoices = async (expectedRevision = workspaceRevision) => {
    if (!sourceLinkActions?.loadChoices || expectedRevision === undefined || sourceLoadLock.current) return;
    sourceLoadLock.current = true;
    const generation = ++sourceLoadGeneration.current;
    setSourceChoicesLoading(true); setSourceChoicesError('');
    try {
      const choices = await sourceLinkActions.loadChoices(expectedRevision);
      if (sourceLoadGeneration.current !== generation) return;
      setLoadedReferences(choices);
      setSelectedReferenceId((selected) => selected && choices.some((choice) => choice.id === selected) ? selected : null);
    } catch (error) {
      if (sourceLoadGeneration.current === generation) setSourceChoicesError(error instanceof Error ? error.message : 'Source choices could not be loaded. Reload and choose again.');
    } finally {
      if (sourceLoadGeneration.current === generation) { sourceLoadLock.current = false; setSourceChoicesLoading(false); }
    }
  };
  useEffect(() => {
    const opening = openingSourceChoiceRead.current;
    if (visible && opening.entityId && opening.loadChoices && opening.workspaceRevision !== undefined) {
      const generation = ++sourceLoadGeneration.current;
      sourceLoadLock.current = true;
      void opening.loadChoices(opening.workspaceRevision).then((choices) => {
        if (sourceLoadGeneration.current !== generation) return;
        setLoadedReferences(choices);
        setSelectedReferenceId((selected) => selected && choices.some((choice) => choice.id === selected) ? selected : null);
      }).catch((error) => {
        if (sourceLoadGeneration.current === generation) setSourceChoicesError(error instanceof Error ? error.message : 'Source choices could not be loaded. Reload and choose again.');
      }).finally(() => {
        if (sourceLoadGeneration.current === generation) { sourceLoadLock.current = false; setSourceChoicesLoading(false); }
      });
    }
    return () => { sourceLoadGeneration.current += 1; sourceLoadLock.current = false; };
    // Load once when this keyed editor opens; changed props do not silently rebase the draft.
  }, [visible]);

  const submit = async () => {
    if (operation.current || busy || sourceChanged) return;
    const token = {};
    operation.current = token;
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
      if (operation.current !== token) return;
      if (saved) close();
      else setMessage('Changes were not saved. Check the app notice, then try again.');
    } catch (error) {
      if (operation.current === token) setMessage(error instanceof Error ? error.message : 'This item changed elsewhere. Close and reopen it to review the latest version.');
    } finally {
      if (operation.current === token) operation.current = undefined;
    }
  };
  const itemAction = async (action: () => Promise<unknown>) => {
    if (operation.current || busy) return;
    const token = {};
    operation.current = token;
    setMessage('');
    try {
      const saved = await action();
      if (operation.current !== token || !saved) return;
      setBaseRevision((revision) => revision === undefined ? undefined : revision + 1);
    } catch (error) {
      if (operation.current === token) setMessage(error instanceof Error ? error.message : 'The saved context changed. Reopen this item to review the latest version.');
    } finally {
      if (operation.current === token) operation.current = undefined;
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView style={s.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.modalHeader}>
          <IconButton name="close" label="Close knowledge editor" onPress={close} />
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
            {entity.sourceLinks.map((item) => editingLinkId === item.id && sourceLinkActions ? <View key={item.id} style={s.knowledgeInlineForm}><Text style={s.knowledgeFootnote}>{referenceSummary(item.reference, references)}</Text><Field label="Link label" value={sourceLabel} onChangeText={setSourceLabel} /><Button label="Save link" tone="quiet" disabled={itemDisabled || !sourceLabel.trim()} onPress={() => void itemAction(async () => { const saved = await sourceLinkActions.save({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: item.id, label: sourceLabel.trim() }); if (saved) setEditingLinkId(null); return saved; })} /><Button label="Cancel edit" tone="quiet" disabled={busy} onPress={() => setEditingLinkId(null)} /></View> : sourceLinkActions ? <ClaimRow key={item.id} title={`${item.label} · ${referenceSummary(item.reference, references)}`} provenance={item.provenance} busy={itemDisabled} onEdit={() => { setEditingLinkId(item.id); setSourceLabel(item.label); }} onRemove={() => void itemAction(() => sourceLinkActions.remove({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, itemId: item.id }))} /> : <View key={item.id} style={s.knowledgeClaim}><View style={{ flex: 1, gap: 3 }}><Text style={s.knowledgeMeta}>{item.provenance === 'user_authored' ? 'Entered by you' : 'Kept inference'}</Text><Text style={s.analysisText}>{item.label} · {referenceSummary(item.reference, references)}</Text></View></View>)}
            {sourceLinkActions ? <>
              <Text style={s.label}>Add a source link</Text>
              {sourceLinkActions.loadChoices ? <>
                <Button label={sourceChoicesLoading ? 'Loading source choices…' : 'Reload source choices'} tone="quiet" disabled={sourceChoicesLoading || busy} onPress={() => void loadSourceChoices()} />
                {sourceChoicesError ? <Text accessibilityRole="alert" style={s.knowledgeError}>{sourceChoicesError}</Text> : null}
              </> : null}
              {sourceChoicesLoading ? <Text style={s.knowledgeFootnote}>Checking current saved sources…</Text> : referenceOptions.length ? referenceOptions.map((option) => <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ selected: selectedReferenceId === option.id }} onPress={() => setSelectedReferenceId(option.id)} style={[s.knowledgeStatusChoice, selectedReferenceId === option.id && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{option.label}</Text></Pressable>) : <Text style={s.knowledgeFootnote}>{sourceLinkActions.loadChoices && !loadedReferences ? 'Load the current source choices before creating a link.' : 'No saved sources are available to link yet.'}</Text>}
              {selectedReference && !selectedReferenceAvailable ? <Text style={s.knowledgeError}>That source changed or is no longer available. Choose a current source.</Text> : null}
              <Field label="Why is this relevant?" value={sourceLabel} onChangeText={setSourceLabel} />
              <Button label="Save source link" tone="quiet" disabled={itemDisabled || sourceChoicesLoading || !selectedReferenceAvailable || !sourceLabel.trim()} onPress={() => {
                const referenceChoiceId = selectedReference && selectedReferenceAvailable ? selectedReference.id : undefined;
                if (!referenceChoiceId) return;
                void itemAction(async () => { const saved = await sourceLinkActions.save({ entityKind: kind, entityId: entity.id, expectedEntityRevision: baseRevision ?? entity.revision, referenceChoiceId, label: sourceLabel.trim() }); if (saved) { setSelectedReferenceId(null); setSourceLabel(''); } return saved; });
              }} />
            </> : <Text style={s.knowledgeFootnote}>{props.sourceLinks.available ? '' : props.sourceLinks.reason}</Text>}
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

function MemberRow({ member, people, busy, onEdit, onRemove }: { member: ProjectMemberDisplay; people: readonly PersonDisplay[]; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const person = 'personId' in member ? people.find((item) => item.id === member.personId) : undefined;
  const name = person?.name ?? ('label' in member ? member.label : 'Person unavailable');
  return <ClaimRow title={`${name}${member.role ? ` · ${member.role}` : ''}${!person && 'sourcePersonId' in member ? ' · historical member unavailable' : ''}`} provenance={member.provenance} busy={busy || !person} removeDisabled={busy} onEdit={onEdit} onRemove={onRemove} />;
}

function referenceSummary(reference: KnowledgeReferenceDisplay, options: readonly KnowledgeSourceChoiceDisplay[]) {
  if (reference.kind === 'historical') return `${reference.originalKind} · ${reference.label} (historical)`;
  const match = options.find(({ reference: candidate }) => referenceKey(candidate) === referenceKey(reference));
  if (match) return match.label;
  if (reference.kind === 'person' || reference.kind === 'project') return `${reference.kind === 'person' ? 'Person' : 'Project'} · historical entity unavailable`;
  return `${reference.kind} · historical source unavailable`;
}

function referenceKey(reference: KnowledgeReferenceDisplay) {
  if (reference.kind === 'historical') return JSON.stringify([reference.kind, reference.originalKind, reference.label]);
  if (reference.kind === 'mail') return JSON.stringify([reference.kind, reference.id, reference.identityKey, reference.connectionGeneration]);
  if (reference.kind === 'calendar') return JSON.stringify([reference.kind, reference.id, reference.calendarId, reference.identityKey, reference.connectionGeneration]);
  return JSON.stringify([reference.kind, reference.id]);
}
