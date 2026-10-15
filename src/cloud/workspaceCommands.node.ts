import type { AppState } from '../core';
import type { JsonValue } from '../../server/src/kernel.js';
import type { OwnedWorkspaceAdmission, OwnedWorkspaceRuntime } from './ownedWorkspaceRuntime.node';
import {
  canonicalWorkspaceCommand,
  canonicalKnowledgeDocumentParent,
  parseWorkspaceCommandEnvelope,
  parseWorkspaceCommandId,
  parseWorkspaceCommandReceipt,
  type WorkspaceCommand,
  type WorkspaceCommandEnvelope,
  type WorkspaceCommandResponse,
  type WorkspaceCommandStatus,
} from './workspaceCommands';
import { workspaceCommandKindFromJournal } from './workspaceCommandHistory';

export * from './workspaceCommands';

/** Execute only explicit safe controller calls through the owned command journal. */
export async function dispatchWorkspaceCommand(runtime: OwnedWorkspaceRuntime, admission: OwnedWorkspaceAdmission,
  untrustedEnvelope: unknown): Promise<WorkspaceCommandResponse> {
  const envelope = parseWorkspaceCommandEnvelope(untrustedEnvelope);
  const command = envelope.command;
  const commandInput = { ...admission, expectedRevision: envelope.expectedRevision, expectedPrivacyEpoch: envelope.expectedPrivacyEpoch,
    idempotencyKey: envelope.commandId, kind: command.kind.toLowerCase(), canonicalBody: canonicalWorkspaceCommand(envelope) };
  if (command.kind === 'notes.transcribe') {
    const result = await runtime.executeTranscriptionCommand(commandInput, { noteId: command.noteId, expectedNoteRevision: command.expectedNoteRevision });
    const expectation = expectedReceipt(envelope.commandId, command);
    if (result.admission.fresh) {
      const commandReceipt = parseWorkspaceCommandReceipt(result.result, expectation);
      return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: commandReceipt,
        ...(result.snapshot ? { snapshot: result.snapshot } : {}) });
    }
    const status = result.admission.status as WorkspaceCommandStatus;
    if (status === 'finished') {
      const commandReceipt = parseWorkspaceCommandReceipt(result.admission.receipt, expectation);
      return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status, receipt: commandReceipt,
        ...(result.snapshot ? { snapshot: result.snapshot } : {}) });
    }
    return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status });
  }
  const result = await runtime.executeCommand(commandInput, async (controller) => {
    switch (command.kind) {
      case 'settings.update': {
        await controller.saveSettings({ ...command.patch, llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
        return receipt(envelope, command, { objectId: 'workspace-settings' });
      }
      case 'tasks.complete': return receipt(envelope, command, { objectId: (await controller.completeTask(command.taskId)).id });
      case 'tasks.reopen': return receipt(envelope, command, { objectId: (await controller.reopenTask(command.taskId)).id });
      case 'chat.create': return receipt(envelope, command, { objectId: (await controller.createChatConversation(command.title)).id });
      case 'notes.save': return receipt(envelope, command, { objectId: (await controller.saveNote({ transcript: command.transcript })).id });
      case 'notes.capture.adopt': return receipt(envelope, command, {
        objectId: (await controller.savePendingCapture({ id: command.captureId, revision: command.captureRevision })).id,
        captureId: command.captureId, captureRevision: command.captureRevision,
      });
      case 'accounts.installOAuth': {
        const account = await controller.installOAuthStage(command.stageId);
        return receipt(envelope, command, { objectId: account.id, stageId: command.stageId,
          accountGeneration: account.connectionGeneration ?? 0 });
      }
      case 'documents.save': {
        const document = await controller.saveDocument(command.path, command.content, {
          expectedRevision: command.expectedRevision ?? undefined, expectedEntityRevision: command.expectedEntityRevision,
        });
        const parent = canonicalKnowledgeDocumentParent(command.path);
        if (!parent) return receipt(envelope, command, { objectId: document.path, documentRevision: document.revision });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), parent.entityKind, parent.entityId);
        return receipt(envelope, command, { objectId: document.path, documentRevision: document.revision,
          entityKind: parent.entityKind, entityId: parent.entityId, entityRevision });
      }
      case 'knowledge.person.save': {
        const input = command.operation === 'create' ? { ...command.input, aliases: [...command.input.aliases] } : { ...command.input,
          aliases: [...command.input.aliases], expectedDocumentRevision: command.input.expectedDocumentRevision ?? undefined };
        const entity = await controller.savePerson(input);
        return receipt(envelope, command, { objectId: entity.id, entityKind: 'person', entityRevision: entity.revision });
      }
      case 'knowledge.project.save': {
        const input = command.operation === 'create' ? { ...command.input, aliases: [...command.input.aliases] } : { ...command.input,
          aliases: [...command.input.aliases], expectedDocumentRevision: command.input.expectedDocumentRevision ?? undefined };
        const entity = await controller.saveProject(input);
        return receipt(envelope, command, { objectId: entity.id, entityKind: 'project', entityRevision: entity.revision });
      }
      case 'knowledge.entity.archive': {
        const entity = await controller.setKnowledgeEntityArchived({ kind: command.entityKind, id: command.id,
          expectedRevision: command.expectedRevision, archived: command.archived });
        return receipt(envelope, command, { objectId: entity.id, entityKind: command.entityKind, entityRevision: entity.revision });
      }
      case 'knowledge.fact.save': {
        const item = await controller.saveKnowledgeFact({ entityKind: command.entityKind, entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, ...(command.itemId ? { itemId: command.itemId } : {}), statement: command.statement });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), command.entityKind, command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: command.entityKind, entityRevision, itemId: item.id });
      }
      case 'knowledge.fact.remove': {
        await controller.removeKnowledgeFact({ entityKind: command.entityKind, entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, itemId: command.itemId });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), command.entityKind, command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: command.entityKind, entityRevision, itemId: command.itemId });
      }
      case 'knowledge.contact.save': {
        const item = await controller.saveKnowledgeContact({ entityKind: 'person', entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, ...(command.itemId ? { itemId: command.itemId } : {}), address: command.address, label: command.label });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), 'person', command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: 'person', entityRevision, itemId: item.id });
      }
      case 'knowledge.contact.remove': {
        await controller.removeKnowledgeContact({ entityKind: 'person', entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, itemId: command.itemId });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), 'person', command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: 'person', entityRevision, itemId: command.itemId });
      }
      case 'knowledge.member.save': {
        const item = await controller.saveKnowledgeMember({ entityKind: 'project', entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, ...(command.itemId ? { itemId: command.itemId } : {}),
          personId: command.personId, personRevision: command.personRevision, role: command.role });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), 'project', command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: 'project', entityRevision, itemId: item.id });
      }
      case 'knowledge.member.remove': {
        await controller.removeKnowledgeMember({ entityKind: 'project', entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, itemId: command.itemId });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), 'project', command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: 'project', entityRevision, itemId: command.itemId });
      }
      case 'notes.updateTranscript': return receipt(envelope, command, {
        objectId: (await controller.updateTranscript(command.noteId, command.text, { expectedRevision: command.expectedNoteRevision })).id,
      });
      case 'assistant.batch.submitNote': {
        const job = await controller.submitNoteBatch(command.noteId, { intent: command.intent, question: command.question,
          knowledgeSelection: command.knowledgeSelection?.map(({ kind, id }) => ({ kind, id })) });
        return receipt(envelope, command, { objectId: command.noteId, jobId: job.id });
      }
      case 'assistant.batch.check': {
        await controller.refreshAssistantBatch(command.jobId);
        return receipt(envelope, command, { objectId: command.jobId });
      }
      case 'chat.submit': {
        const accepted = await controller.submitChatTurn({ conversationId: command.conversationId, text: command.text,
          knowledgeSelection: command.knowledgeSelection?.map(({ kind, id }) => ({ kind, id })) });
        return receipt(envelope, command, { objectId: accepted.conversationId, turnId: accepted.turnId, jobId: accepted.jobId });
      }
      case 'chat.refine': {
        const accepted = await controller.refineChatTurn({ conversationId: command.conversationId, parentTurnId: command.parentTurnId, effort: command.effort });
        return receipt(envelope, command, { objectId: accepted.conversationId, parentTurnId: command.parentTurnId,
          turnId: accepted.turnId, jobId: accepted.jobId });
      }
      default: return assertNever(command);
    }
  }, (value): JsonValue => ({ schemaVersion: value.schemaVersion, commandId: value.commandId, kind: value.kind,
    objectId: value.objectId, ...('jobId' in value ? { jobId: value.jobId } : {}), ...('turnId' in value ? { turnId: value.turnId } : {}),
    ...('parentTurnId' in value ? { parentTurnId: value.parentTurnId } : {}),
    ...('captureId' in value ? { captureId: value.captureId } : {}), ...('captureRevision' in value ? { captureRevision: value.captureRevision } : {}),
    ...('stageId' in value ? { stageId: value.stageId } : {}), ...('accountGeneration' in value ? { accountGeneration: value.accountGeneration } : {}),
    ...('documentRevision' in value ? { documentRevision: value.documentRevision } : {}),
    ...('entityKind' in value ? { entityKind: value.entityKind } : {}), ...('entityId' in value ? { entityId: value.entityId } : {}),
    ...('entityRevision' in value ? { entityRevision: value.entityRevision } : {}), ...('itemId' in value ? { itemId: value.itemId } : {}) }));

  const expectation = expectedReceipt(envelope.commandId, command);
  if (result.admission.fresh) {
    const commandReceipt = parseWorkspaceCommandReceipt(result.result, expectation);
    if (!result.snapshot) throw new Error('workspace_command_snapshot_unavailable');
    return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: commandReceipt, snapshot: result.snapshot });
  }

  const status = result.admission.status as WorkspaceCommandStatus;
  if (status === 'finished') {
    const commandReceipt = parseWorkspaceCommandReceipt(result.admission.receipt, expectation);
    return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status, receipt: commandReceipt,
      ...(result.snapshot ? { snapshot: result.snapshot } : {}) });
  }
  return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status });
}

/** Inspection does no controller load, command admission, or snapshot refresh. */
export function inspectWorkspaceCommand(runtime: OwnedWorkspaceRuntime, admission: OwnedWorkspaceAdmission,
  rawCommandId: unknown): WorkspaceCommandResponse {
  const commandId = parseWorkspaceCommandId(rawCommandId);
  const admissionResult = runtime.inspectCommandReceipt(admission, commandId);
  if (!admissionResult) return Object.freeze({ schemaVersion: 1, commandId, status: 'unverified' });
  const kind = workspaceCommandKindFromJournal(admissionResult.commandKind);
  if (!kind) throw new Error('workspace_command_unexposed');
  if (admissionResult.status === 'finished') {
    const commandReceipt = parseWorkspaceCommandReceipt(admissionResult.receipt, { commandId, kind });
    return Object.freeze({ schemaVersion: 1, commandId, status: 'finished', receipt: commandReceipt });
  }
  return Object.freeze({ schemaVersion: 1, commandId, status: admissionResult.status as WorkspaceCommandStatus });
}

function receipt(envelope: WorkspaceCommandEnvelope, command: WorkspaceCommand, fields: {
  readonly objectId: string; readonly jobId?: string; readonly turnId?: string; readonly parentTurnId?: string;
  readonly captureId?: string; readonly captureRevision?: string;
  readonly stageId?: string; readonly accountGeneration?: number;
  readonly documentRevision?: number; readonly entityKind?: 'person' | 'project'; readonly entityId?: string;
  readonly entityRevision?: number; readonly itemId?: string;
}) {
  return parseWorkspaceCommandReceipt({ schemaVersion: 1, commandId: envelope.commandId, kind: command.kind, ...fields },
    expectedReceipt(envelope.commandId, command));
}

function expectedReceipt(commandId: string, command: WorkspaceCommand) {
  switch (command.kind) {
    case 'settings.update': return { commandId, kind: command.kind, objectId: 'workspace-settings' };
    case 'tasks.complete': case 'tasks.reopen': return { commandId, kind: command.kind, objectId: command.taskId };
    case 'chat.create': case 'notes.save': return { commandId, kind: command.kind };
    case 'notes.capture.adopt': return { commandId, kind: command.kind, objectId: command.captureId,
      captureId: command.captureId, captureRevision: command.captureRevision };
    case 'accounts.installOAuth': return { commandId, kind: command.kind, stageId: command.stageId };
    case 'documents.save': {
      const parent = canonicalKnowledgeDocumentParent(command.path);
      return { commandId, kind: command.kind, objectId: command.path,
        ...(parent ? { entityKind: parent.entityKind, entityId: parent.entityId } : {}) };
    }
    case 'knowledge.person.save': return { commandId, kind: command.kind, entityKind: 'person' as const,
      ...(command.operation === 'update' ? { objectId: command.input.id } : {}) };
    case 'knowledge.project.save': return { commandId, kind: command.kind, entityKind: 'project' as const,
      ...(command.operation === 'update' ? { objectId: command.input.id } : {}) };
    case 'knowledge.entity.archive': return { commandId, kind: command.kind, objectId: command.id, entityKind: command.entityKind };
    case 'knowledge.fact.save': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.fact.remove': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind, itemId: command.itemId };
    case 'knowledge.contact.save': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: 'person' as const,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.contact.remove': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: 'person' as const, itemId: command.itemId };
    case 'knowledge.member.save': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: 'project' as const,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.member.remove': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: 'project' as const, itemId: command.itemId };
    case 'notes.updateTranscript': return { commandId, kind: command.kind, objectId: command.noteId };
    case 'notes.transcribe': return { commandId, kind: command.kind, objectId: command.noteId, sourceRevision: command.expectedNoteRevision };
    case 'assistant.batch.submitNote': return { commandId, kind: command.kind, objectId: command.noteId };
    case 'assistant.batch.check': return { commandId, kind: command.kind, objectId: command.jobId };
    case 'chat.submit': return { commandId, kind: command.kind, objectId: command.conversationId };
    case 'chat.refine': return { commandId, kind: command.kind, objectId: command.conversationId, parentTurnId: command.parentTurnId };
    default: return assertNever(command);
  }
}

function assertNever(_value: never): never { throw new Error('workspace_command_unsupported'); }

function knowledgeEntityRevision(snapshot: AppState, kind: 'person' | 'project', id: string): number {
  const entity = kind === 'person' ? snapshot.knowledge.people.find((row) => row.id === id)
    : snapshot.knowledge.projects.find((row) => row.id === id);
  if (!entity) throw new Error('workspace_knowledge_entity_missing');
  return entity.revision;
}
