import type { KnowledgeItemCommand, SaveKnowledgeContactInput, SaveKnowledgeFactInput, SaveKnowledgeMemberInput } from '../core';
import type { PublicKnowledgeChange, WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { LibraryKnowledgeEntityActions } from '../ui/LibraryScreen';
import type { KnowledgeEntityEditCommand, KnowledgeProjectEditCommand } from '../ui/KnowledgeEntitySheet';
import type { KnowledgeSuggestionDisplay, KnowledgeSuggestionEditInput, KnowledgeSuggestionReviewInput, KnowledgeSuggestionReviewDisplay } from '../ui/knowledgeDisplayTypes';
import { projectKnowledgeSuggestionDisplay } from '../ui/libraryDisplay';
import type { KnowledgeSourceChoicesDTO, KnowledgeSuggestionDisplayDTO, KnowledgeSuggestionReviewDTO } from '../cloud/knowledgeHttpContracts';
import type { WorkspaceActionCapability } from '../ui/workspaceCapabilities';
import type { WorkspaceDocumentSaveAction } from '../ui/WorkspaceDocumentEditor';
import { isCanonicalKnowledgeId } from '../knowledge';

type SessionState = Readonly<{
  status: 'loading' | 'ready' | 'error';
  snapshot?: WorkspaceSnapshotDTO;
  busy: boolean;
  pendingCommand?: Readonly<{ commandId: string; kind: WorkspaceCommand['kind'] }>;
  refreshRequired: boolean;
  error?: string;
}>;

export type CloudKnowledgeStorePort = Readonly<{
  getSnapshot: () => SessionState;
  execute: (command: WorkspaceCommand) => Promise<WorkspaceCommandResponse>;
  readKnowledgeSourceChoices?: (expectedRevision: number) => Promise<KnowledgeSourceChoicesDTO>;
  readKnowledgeSuggestionReview?: (input: Readonly<{ suggestionId: string; expectedSuggestionRevision: number; expectedRevision: number }>) => Promise<KnowledgeSuggestionReviewDTO>;
}>;
type CloudLibraryKnowledgeEntityActions = Omit<LibraryKnowledgeEntityActions, 'archive'> & Readonly<{
  archive: (kind: 'person' | 'project', id: string, revision: number, archived: boolean) => Promise<unknown>;
}>;

const positiveRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function requireFinishedReceipt(response: WorkspaceCommandResponse, kind: WorkspaceCommand['kind'], objectId?: string) {
  const receipt = response.receipt;
  if (response.status !== 'finished' || !receipt || receipt.schemaVersion !== 1 || receipt.commandId !== response.commandId || receipt.kind !== kind ||
      (objectId !== undefined && receipt.objectId !== objectId)) {
    throw new Error('The saved change could not be confirmed. Inspect the pending workspace command before continuing.');
  }
  return receipt;
}

export function createCloudKnowledgeActions(store: CloudKnowledgeStorePort, owner: Readonly<{ workspaceId: string; privacyEpoch: number }>): Readonly<{
  documents: WorkspaceActionCapability<WorkspaceDocumentSaveAction>;
  entities: WorkspaceActionCapability<CloudLibraryKnowledgeEntityActions>;
  suggestions: WorkspaceActionCapability<CloudKnowledgeSuggestionActions>;
}> {
  let operation: object | undefined;
  const readCurrent = () => {
    const state = store.getSnapshot();
    const snapshot = state.snapshot;
    if (!snapshot || state.status !== 'ready' || snapshot.workspaceId !== owner.workspaceId || snapshot.privacyEpoch !== owner.privacyEpoch) {
      throw new Error('This workspace changed. Reload before saving these changes.');
    }
    if (state.busy || state.pendingCommand || state.refreshRequired) {
      throw new Error(state.error ?? 'Resolve the pending workspace operation before saving.');
    }
    return snapshot;
  };
  const execute = async <T,>(command: WorkspaceCommand, verify: (response: WorkspaceCommandResponse) => T): Promise<T> => {
    if (operation) throw new Error('Another Library change is already being saved.');
    const token = {};
    operation = token;
    try {
      readCurrent();
      const response = await store.execute(command);
      readCurrentAfterCommand();
      return verify(response);
    } finally {
      if (operation === token) operation = undefined;
    }
  };
  const readCurrentAfterCommand = () => {
    const state = store.getSnapshot();
    const snapshot = state.snapshot;
    if (!snapshot || state.status !== 'ready' || snapshot.workspaceId !== owner.workspaceId || snapshot.privacyEpoch !== owner.privacyEpoch) {
      throw new Error('The workspace changed before this result could be attached to the open editor.');
    }
  };
  const readOwnerSnapshot = () => {
    const state = store.getSnapshot();
    const snapshot = state.snapshot;
    if (!snapshot || state.status !== 'ready' || snapshot.workspaceId !== owner.workspaceId || snapshot.privacyEpoch !== owner.privacyEpoch) {
      throw new Error('This workspace changed. Reload before continuing.');
    }
    return snapshot;
  };
  const assertPersonOrProject = (snapshot: WorkspaceSnapshotDTO, kind: 'person' | 'project', id: string, expectedRevision: number) => {
    const collection = kind === 'person' ? snapshot.state.knowledge.people : snapshot.state.knowledge.projects;
    const entity = collection.find((item) => item.id === id);
    if (!entity || entity.revision !== expectedRevision) throw new Error('This item changed. Refresh it before saving.');
    const document = snapshot.state.documents.find((item) => item.path === entity.narrativePath);
    return { entity, documentRevision: document?.revision ?? null };
  };
  const verifyEntityReceipt = (response: WorkspaceCommandResponse, kind: 'knowledge.person.save' | 'knowledge.project.save' | 'knowledge.entity.archive', entityKind: 'person' | 'project', expectedId?: string) => {
    const receipt = requireFinishedReceipt(response, kind, expectedId);
    if (!isCanonicalKnowledgeId(receipt.objectId) || !('entityKind' in receipt) || receipt.entityKind !== entityKind || !('entityRevision' in receipt) || !positiveRevision(receipt.entityRevision)) {
      throw new Error('The workspace returned an unexpected saved-item receipt. Inspect it before continuing.');
    }
    return receipt;
  };
  const verifyItemReceipt = (response: WorkspaceCommandResponse, kind: WorkspaceCommand['kind'], entityKind: 'person' | 'project', entityId: string, expectedItemId?: string) => {
    const receipt = requireFinishedReceipt(response, kind, entityId);
    if (!('entityKind' in receipt) || receipt.entityKind !== entityKind || !('entityRevision' in receipt) || !positiveRevision(receipt.entityRevision) ||
        !('itemId' in receipt) || (expectedItemId ? receipt.itemId !== expectedItemId : !isCanonicalKnowledgeId(receipt.itemId))) {
      throw new Error('The workspace returned an unexpected saved-claim receipt. Inspect it before continuing.');
    }
    return receipt;
  };

  const saveDocument: WorkspaceDocumentSaveAction = async (input) => {
    const snapshot = readCurrent();
    const existing = snapshot.state.documents.find((item) => item.path === input.path);
    if (input.expectedRevision === null ? Boolean(existing) : existing?.revision !== input.expectedRevision) {
      throw new Error('This document changed. Reload the saved version before saving your draft.');
    }
    const response = await execute({ kind: 'documents.save', path: input.path, content: input.content, expectedRevision: input.expectedRevision }, (result) => {
      const receipt = requireFinishedReceipt(result, 'documents.save', input.path);
      if (!('documentRevision' in receipt) || !positiveRevision(receipt.documentRevision)) throw new Error('The workspace returned an invalid document revision. Inspect it before continuing.');
      return { revision: receipt.documentRevision, snapshotUpdated: Boolean(result.snapshot) };
    });
    return response;
  };

  const saveEntity = async (kind: 'person' | 'project', input: KnowledgeEntityEditCommand | KnowledgeProjectEditCommand) => {
    const snapshot = readCurrent();
    if (input.id) {
      if (!positiveRevision(input.expectedRevision)) throw new Error('The saved item revision is unavailable. Refresh before saving.');
      const current = assertPersonOrProject(snapshot, kind, input.id, input.expectedRevision);
      if (current.documentRevision !== (input.expectedDocumentRevision ?? null)) throw new Error('The saved notes for this item changed. Refresh before saving.');
    }
    const fields = { name: input.name, aliases: [...input.aliases], narrative: input.narrative };
    if (kind === 'person') {
      const command: WorkspaceCommand = input.id
        ? { kind: 'knowledge.person.save', operation: 'update', input: { ...fields, id: input.id, expectedRevision: input.expectedRevision!, expectedDocumentRevision: input.expectedDocumentRevision ?? null } }
        : { kind: 'knowledge.person.save', operation: 'create', input: fields };
      return execute(command, (result) => {
        const receipt = verifyEntityReceipt(result, 'knowledge.person.save', 'person', input.id);
        return receipt.objectId;
      });
    }
    if (!('status' in input)) throw new Error('The project details could not be confirmed. Reopen the editor before saving.');
    const projectInput: KnowledgeProjectEditCommand = input;
    const projectFields = { ...fields, status: projectInput.status, goal: projectInput.goal,
      ...(projectInput.startsOn ? { startsOn: projectInput.startsOn } : {}), ...(projectInput.targetOn ? { targetOn: projectInput.targetOn } : {}),
      ...(projectInput.dateTimeZone ? { dateTimeZone: projectInput.dateTimeZone } : {}) };
    const command: WorkspaceCommand = input.id
      ? { kind: 'knowledge.project.save', operation: 'update', input: { ...projectFields, id: input.id, expectedRevision: input.expectedRevision!, expectedDocumentRevision: input.expectedDocumentRevision ?? null } }
      : { kind: 'knowledge.project.save', operation: 'create', input: projectFields };
    return execute(command, (result) => verifyEntityReceipt(result, 'knowledge.project.save', 'project', input.id).objectId);
  };

  const ensureEntity = (input: Pick<KnowledgeItemCommand, 'entityKind' | 'entityId' | 'expectedEntityRevision'>) => {
    const snapshot = readCurrent();
    assertPersonOrProject(snapshot, input.entityKind, input.entityId, input.expectedEntityRevision);
  };
  const saveFact = async (input: SaveKnowledgeFactInput) => {
    ensureEntity(input);
    return execute({ kind: 'knowledge.fact.save', entityKind: input.entityKind, entityId: input.entityId, expectedEntityRevision: input.expectedEntityRevision,
      ...(input.itemId ? { itemId: input.itemId } : {}), statement: input.statement }, (result) => verifyItemReceipt(result, 'knowledge.fact.save', input.entityKind, input.entityId, input.itemId));
  };
  const removeFact = async (input: KnowledgeItemCommand) => {
    if (!input.itemId) throw new Error('Choose the exact saved fact before removing it.');
    ensureEntity(input);
    return execute({ kind: 'knowledge.fact.remove', entityKind: input.entityKind, entityId: input.entityId, expectedEntityRevision: input.expectedEntityRevision, itemId: input.itemId },
      (result) => verifyItemReceipt(result, 'knowledge.fact.remove', input.entityKind, input.entityId, input.itemId));
  };
  const saveContact = async (input: SaveKnowledgeContactInput) => {
    ensureEntity(input);
    return execute({ kind: 'knowledge.contact.save', entityKind: 'person', entityId: input.entityId, expectedEntityRevision: input.expectedEntityRevision,
      ...(input.itemId ? { itemId: input.itemId } : {}), address: input.address, label: input.label }, (result) => verifyItemReceipt(result, 'knowledge.contact.save', 'person', input.entityId, input.itemId));
  };
  const removeContact = async (input: KnowledgeItemCommand & { entityKind: 'person' }) => {
    if (!input.itemId) throw new Error('Choose the exact contact claim before removing it.');
    ensureEntity(input);
    return execute({ kind: 'knowledge.contact.remove', entityKind: 'person', entityId: input.entityId, expectedEntityRevision: input.expectedEntityRevision, itemId: input.itemId },
      (result) => verifyItemReceipt(result, 'knowledge.contact.remove', 'person', input.entityId, input.itemId));
  };
  const saveMember = async (input: SaveKnowledgeMemberInput) => {
    ensureEntity(input);
    const person = readCurrent().state.knowledge.people.find((item) => item.id === input.personId);
    if (!person || person.revision !== input.personRevision || person.archivedAt) throw new Error('Choose a current, active person before saving this membership.');
    return execute({ kind: 'knowledge.member.save', entityKind: 'project', entityId: input.entityId, expectedEntityRevision: input.expectedEntityRevision,
      ...(input.itemId ? { itemId: input.itemId } : {}), personId: input.personId, personRevision: input.personRevision, role: input.role },
      (result) => verifyItemReceipt(result, 'knowledge.member.save', 'project', input.entityId, input.itemId));
  };
  const removeMember = async (input: KnowledgeItemCommand & { entityKind: 'project' }) => {
    if (!input.itemId) throw new Error('Choose the exact project member before removing them.');
    ensureEntity(input);
    return execute({ kind: 'knowledge.member.remove', entityKind: 'project', entityId: input.entityId, expectedEntityRevision: input.expectedEntityRevision, itemId: input.itemId },
      (result) => verifyItemReceipt(result, 'knowledge.member.remove', 'project', input.entityId, input.itemId));
  };
  const archive = async (kind: 'person' | 'project', id: string, expectedRevision: number, archived: boolean) => {
    const current = readCurrent();
    const entity = kind === 'person' ? current.state.knowledge.people.find((item) => item.id === id) : current.state.knowledge.projects.find((item) => item.id === id);
    if (!entity || entity.revision !== expectedRevision) throw new Error('This item changed. Refresh before changing its archive status.');
    return execute({ kind: 'knowledge.entity.archive', entityKind: kind, id, expectedRevision, archived }, (result) => verifyEntityReceipt(result, 'knowledge.entity.archive', kind, id));
  };

  const sourceLinks = {
    loadChoices: async (expectedRevision: number) => {
      if (!store.readKnowledgeSourceChoices) throw new Error('Source choices are unavailable in this workspace session.');
      const snapshot = readOwnerSnapshot();
      if (snapshot.revision !== expectedRevision) throw new Error('The workspace changed. Reload source choices.');
      const result = await store.readKnowledgeSourceChoices(expectedRevision);
      const current = readOwnerSnapshot();
      if (current.revision !== expectedRevision || result.workspaceId !== owner.workspaceId || result.privacyEpoch !== owner.privacyEpoch || result.revision !== expectedRevision) {
        throw new Error('The workspace changed while source choices were loading. Reload before continuing.');
      }
      return result.choices.map(({ id, label, reference }) => ({ id, label, reference }));
    },
    save: async (input: { entityKind: 'person' | 'project'; entityId: string; expectedEntityRevision: number; itemId?: string; referenceChoiceId?: string; label: string }) => {
      const snapshot = readCurrent();
      const { entity } = assertPersonOrProject(snapshot, input.entityKind, input.entityId, input.expectedEntityRevision);
      const existing = input.itemId ? entity.sourceLinks.find((item) => item.id === input.itemId) : undefined;
      if (input.itemId && !existing) throw new Error('This source link changed. Reload the current item before saving.');
      if (!input.itemId && !input.referenceChoiceId) throw new Error('Choose a current source before creating a link.');
      const response = await execute({ kind: 'knowledge.sourceLink.save', entityKind: input.entityKind, entityId: input.entityId,
        expectedEntityRevision: input.expectedEntityRevision, ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(input.referenceChoiceId ? { referenceChoiceId: input.referenceChoiceId } : {}), label: input.label }, (result) => {
        const receipt = requireFinishedReceipt(result, 'knowledge.sourceLink.save', input.entityId);
        if (!('entityKind' in receipt) || receipt.entityKind !== input.entityKind || !('entityRevision' in receipt) || !positiveRevision(receipt.entityRevision) ||
            !('itemId' in receipt) || (input.itemId ? receipt.itemId !== input.itemId : !isCanonicalKnowledgeId(receipt.itemId))) {
          throw new Error('The workspace returned an unexpected source-link receipt. Inspect it before continuing.');
        }
        return receipt;
      });
      return response;
    },
    remove: async (input: KnowledgeItemCommand) => {
      if (!input.itemId) throw new Error('Choose the exact source link before removing it.');
      const itemId = input.itemId;
      const snapshot = readCurrent();
      const { entity } = assertPersonOrProject(snapshot, input.entityKind, input.entityId, input.expectedEntityRevision);
      if (!entity.sourceLinks.some((item) => item.id === itemId)) throw new Error('This source link changed. Reload the current item before removing it.');
      return execute({ kind: 'knowledge.sourceLink.remove', entityKind: input.entityKind, entityId: input.entityId, expectedEntityRevision: input.expectedEntityRevision, itemId }, (result) => {
        const receipt = requireFinishedReceipt(result, 'knowledge.sourceLink.remove', input.entityId);
        if (!('entityKind' in receipt) || receipt.entityKind !== input.entityKind || !('entityRevision' in receipt) || !positiveRevision(receipt.entityRevision) ||
            !('itemId' in receipt) || receipt.itemId !== itemId) throw new Error('The workspace returned an unexpected source-link receipt. Inspect it before continuing.');
        return receipt;
      });
    },
  };

  const suggestionContext = (suggestionId: string, expectedRevision: number) => {
    const snapshot = readOwnerSnapshot();
    const suggestion = snapshot.state.knowledge.suggestions.find((item) => item.id === suggestionId && item.revision === expectedRevision && item.status === 'pending');
    if (!suggestion) throw new Error('This suggestion changed. Reload the latest Memory list before continuing.');
    const collection = suggestion.change.entityKind === 'person' ? snapshot.state.knowledge.people : snapshot.state.knowledge.projects;
    const target = collection.find((entity) => entity.id === suggestion.change.entityId);
    if (!target) throw new Error('The target changed. Reload before reviewing this suggestion.');
    const memberChange = suggestion.change;
    const memberPerson = memberChange.type === 'add_member'
      ? snapshot.state.knowledge.people.find((person) => person.id === memberChange.personId && !person.archivedAt)
      : undefined;
    return { snapshot, suggestion, target, memberPerson };
  };
  const suggestions: CloudKnowledgeSuggestionActions = {
    prepare: async (id, input) => {
      if (!store.readKnowledgeSuggestionReview) throw new Error('Suggestion review is unavailable in this workspace session.');
      const snapshot = readOwnerSnapshot();
      if (input.expectedWorkspaceRevision === undefined || snapshot.revision !== input.expectedWorkspaceRevision) throw new Error('The workspace changed. Reload the latest Memory list before preparing this suggestion.');
      const result = await store.readKnowledgeSuggestionReview({ suggestionId: id, expectedSuggestionRevision: input.expectedRevision, expectedRevision: snapshot.revision });
      const latest = readOwnerSnapshot();
      if (latest.revision !== input.expectedWorkspaceRevision || result.workspaceId !== owner.workspaceId || result.privacyEpoch !== owner.privacyEpoch || result.revision !== input.expectedWorkspaceRevision) {
        throw new Error('The workspace changed while the suggestion was loading. Reload before continuing.');
      }
      return toSuggestionReviewDisplay(result);
    },
    review: async (id, input) => {
      const { suggestion, target, memberPerson } = suggestionContext(id, input.expectedRevision);
      if (input.targetRevision !== undefined && input.targetRevision !== target.revision) throw new Error('The target changed. Reload this suggestion before reviewing it.');
      if (input.decision === 'accept' && target.archivedAt) throw new Error('The target is archived. Dismiss this suggestion or reopen the target before accepting it.');
      if (suggestion.change.type === 'add_member' && (!memberPerson || (input.memberPersonRevision !== undefined && input.memberPersonRevision !== memberPerson.revision))) {
        throw new Error('The project member changed. Reload this suggestion before reviewing it.');
      }
      return execute({ kind: 'knowledge.suggestion.review', suggestionId: id, expectedSuggestionRevision: input.expectedRevision, decision: input.decision,
        targetRevision: target.revision, ...(memberPerson ? { memberPersonRevision: memberPerson.revision } : {}) }, (result) => {
        const receipt = requireFinishedReceipt(result, 'knowledge.suggestion.review', id);
        if (!('suggestionId' in receipt) || receipt.suggestionId !== id || !('suggestionRevision' in receipt) || !positiveRevision(receipt.suggestionRevision) ||
            !('status' in receipt) || receipt.status !== (input.decision === 'accept' ? 'accepted' : 'dismissed')) throw new Error('The workspace returned an unexpected suggestion-review receipt. Inspect it before continuing.');
        return true;
      });
    },
    edit: async (id, input) => {
      const { snapshot, suggestion, target } = suggestionContext(id, input.expectedRevision);
      if (input.targetRevision !== target.revision || target.archivedAt) throw new Error('The target changed or is archived. Reload before editing this suggestion.');
      const change = input.change;
      if (change.type !== suggestion.change.type || change.entityKind !== suggestion.change.entityKind || change.entityId !== suggestion.change.entityId) {
        throw new Error('The suggestion changed. Reload the latest revision before editing it.');
      }
      if (change.type === 'add_source_link' && (!('referenceChoiceId' in change) || !change.referenceChoiceId)) throw new Error('Choose a current source before saving this suggestion.');
      const editedMemberPerson = change.type === 'add_member'
        ? snapshot.state.knowledge.people.find((person) => person.id === change.personId && person.revision === change.personRevision && !person.archivedAt)
        : undefined;
      if (change.type === 'add_member' && !editedMemberPerson) {
        throw new Error('Choose the current project member before saving this suggestion.');
      }
      const publicChange: PublicKnowledgeChange = change.type === 'add_source_link'
        ? { type: change.type, entityKind: change.entityKind, entityId: change.entityId, referenceChoiceId: change.referenceChoiceId, label: change.label }
        : change;
      return execute({ kind: 'knowledge.suggestion.edit', suggestionId: id, expectedSuggestionRevision: input.expectedRevision, expectedTargetRevision: input.targetRevision,
        ...(editedMemberPerson ? { expectedMemberPersonRevision: editedMemberPerson.revision } : {}), change: publicChange, evidence: input.evidence.map((entry) => ({ ...entry })) }, (result) => {
        const receipt = requireFinishedReceipt(result, 'knowledge.suggestion.edit', id);
        if (!('suggestionId' in receipt) || receipt.suggestionId !== id || !('suggestionRevision' in receipt) || !positiveRevision(receipt.suggestionRevision) ||
            !('status' in receipt) || receipt.status !== 'pending') throw new Error('The workspace returned an unexpected suggestion-edit receipt. Inspect it before continuing.');
        const saved = store.getSnapshot().snapshot?.state.knowledge.suggestions.find((item) => item.id === id && item.revision === receipt.suggestionRevision);
        return saved ? projectSuggestionDisplayFromSnapshot(saved) : undefined;
      });
    },
  };

  return {
    documents: { available: true, action: saveDocument },
    entities: { available: true, action: {
      archive, savePerson: (input) => saveEntity('person', input), saveProject: (input) => saveEntity('project', input), saveFact, removeFact, saveContact, removeContact,
      sourceLinks: { available: true, action: sourceLinks },
      saveMember, removeMember,
    } },
    suggestions: { available: true, action: suggestions },
  };
}

type CloudKnowledgeSuggestionActions = Readonly<{
  prepare: (id: string, input: { expectedRevision: number; expectedWorkspaceRevision?: number }) => Promise<KnowledgeSuggestionReviewDisplay>;
  review: (id: string, input: KnowledgeSuggestionReviewInput) => Promise<unknown>;
  edit: (id: string, input: KnowledgeSuggestionEditInput) => Promise<KnowledgeSuggestionDisplay | undefined>;
}>;

function toSuggestionReviewDisplay(dto: KnowledgeSuggestionReviewDTO): KnowledgeSuggestionReviewDisplay {
  return { suggestion: projectSuggestionDisplay(dto.review.suggestion), canEdit: dto.review.canEdit, canAccept: dto.review.canAccept,
    ...(dto.review.reason ? { reason: dto.review.reason } : {}) };
}

type WorkspaceSuggestion = WorkspaceSnapshotDTO['state']['knowledge']['suggestions'][number];
function projectSuggestionDisplay(item: KnowledgeSuggestionDisplayDTO): KnowledgeSuggestionDisplay {
  return { id: item.id, revision: item.revision, targetRevision: item.targetRevision, evidence: item.evidence, status: item.status,
    createdAt: item.createdAt, updatedAt: item.updatedAt, change: item.change,
    ...(item.originalChange ? { originalChange: item.originalChange } : {}),
    ...(item.originalEvidence ? { originalEvidence: item.originalEvidence } : {}), ...(item.staleReason ? { staleReason: item.staleReason } : {}) };
}
function projectSuggestionDisplayFromSnapshot(item: WorkspaceSuggestion): KnowledgeSuggestionDisplay { return projectKnowledgeSuggestionDisplay(item); }
