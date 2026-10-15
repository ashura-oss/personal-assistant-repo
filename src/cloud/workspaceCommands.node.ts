import type { JsonValue } from '../../server/src/kernel.js';
import type { OwnedWorkspaceAdmission, OwnedWorkspaceRuntime } from './ownedWorkspaceRuntime.node';
import {
  canonicalWorkspaceCommand,
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
  const result = await runtime.executeCommand({ ...admission, expectedRevision: envelope.expectedRevision,
    expectedPrivacyEpoch: envelope.expectedPrivacyEpoch, idempotencyKey: envelope.commandId,
    // Journal kinds use a stable lowercase namespace; the canonical envelope
    // still binds the exact public discriminant and input bytes.
    kind: command.kind.toLowerCase(), canonicalBody: canonicalWorkspaceCommand(envelope) }, async (controller) => {
    switch (command.kind) {
      case 'tasks.complete': return receipt(envelope, command, { objectId: (await controller.completeTask(command.taskId)).id });
      case 'tasks.reopen': return receipt(envelope, command, { objectId: (await controller.reopenTask(command.taskId)).id });
      case 'chat.create': return receipt(envelope, command, { objectId: (await controller.createChatConversation(command.title)).id });
      case 'notes.save': return receipt(envelope, command, { objectId: (await controller.saveNote({ transcript: command.transcript })).id });
      case 'notes.capture.adopt': return receipt(envelope, command, {
        objectId: (await controller.savePendingCapture({ id: command.captureId, revision: command.captureRevision })).id,
        captureId: command.captureId, captureRevision: command.captureRevision,
      });
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
    ...('captureId' in value ? { captureId: value.captureId } : {}), ...('captureRevision' in value ? { captureRevision: value.captureRevision } : {}) }));

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
}) {
  return parseWorkspaceCommandReceipt({ schemaVersion: 1, commandId: envelope.commandId, kind: command.kind, ...fields },
    expectedReceipt(envelope.commandId, command));
}

function expectedReceipt(commandId: string, command: WorkspaceCommand) {
  switch (command.kind) {
    case 'tasks.complete': case 'tasks.reopen': return { commandId, kind: command.kind, objectId: command.taskId };
    case 'chat.create': case 'notes.save': return { commandId, kind: command.kind };
    case 'notes.capture.adopt': return { commandId, kind: command.kind, objectId: command.captureId,
      captureId: command.captureId, captureRevision: command.captureRevision };
    case 'notes.updateTranscript': return { commandId, kind: command.kind, objectId: command.noteId };
    case 'assistant.batch.submitNote': return { commandId, kind: command.kind, objectId: command.noteId };
    case 'assistant.batch.check': return { commandId, kind: command.kind, objectId: command.jobId };
    case 'chat.submit': return { commandId, kind: command.kind, objectId: command.conversationId };
    case 'chat.refine': return { commandId, kind: command.kind, objectId: command.conversationId, parentTurnId: command.parentTurnId };
    default: return assertNever(command);
  }
}

function assertNever(_value: never): never { throw new Error('workspace_command_unsupported'); }
