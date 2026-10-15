import type { KnowledgeItemCommand, SaveKnowledgeContactInput, SaveKnowledgeFactInput, SaveKnowledgeMemberInput } from '../core';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { LibraryKnowledgeEntityActions } from '../ui/LibraryScreen';
import type { KnowledgeEntityEditCommand, KnowledgeProjectEditCommand } from '../ui/KnowledgeEntitySheet';
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

  return {
    documents: { available: true, action: saveDocument },
    entities: { available: true, action: {
      archive, savePerson: (input) => saveEntity('person', input), saveProject: (input) => saveEntity('project', input), saveFact, removeFact, saveContact, removeContact,
      sourceLinks: { available: false, reason: 'Source links are viewable here; editing them is not connected to workspace commands yet.' },
      saveMember, removeMember,
    } },
  };
}
