import type { JsonValue } from '../../server/src/kernel.js';
import type { OwnedWorkspaceAdmission, OwnedWorkspaceRuntime } from './ownedWorkspaceRuntime.node';
import {
  canonicalWorkspaceCommand,
  parseWorkspaceCommandEnvelope,
  parseWorkspaceCommandId,
  parseWorkspaceCommandReceipt,
  type WorkspaceCommandEnvelope,
  type WorkspaceCommandResponse,
  type WorkspaceCommandStatus,
} from './workspaceCommands';

export * from './workspaceCommands';

/** Execute only the small, explicit command allowlist through the owned controller. */
export async function dispatchWorkspaceCommand(runtime: OwnedWorkspaceRuntime, admission: OwnedWorkspaceAdmission,
  untrustedEnvelope: unknown): Promise<WorkspaceCommandResponse> {
  const envelope = parseWorkspaceCommandEnvelope(untrustedEnvelope);
  const command = envelope.command;
  const result = await runtime.executeCommand({ ...admission, expectedRevision: envelope.expectedRevision,
    expectedPrivacyEpoch: envelope.expectedPrivacyEpoch, idempotencyKey: envelope.commandId,
    kind: command.kind, canonicalBody: canonicalWorkspaceCommand(envelope) }, async (controller) => {
    let objectId: string;
    switch (command.kind) {
      case 'tasks.complete': objectId = (await controller.completeTask(command.taskId)).id; break;
      case 'tasks.reopen': objectId = (await controller.reopenTask(command.taskId)).id; break;
      case 'chat.create': objectId = (await controller.createChatConversation(command.title)).id; break;
      default: return assertNever(command);
    }
    return parseWorkspaceCommandReceipt({ schemaVersion: 1, commandId: envelope.commandId, kind: command.kind, objectId },
      expectedReceipt(envelope.commandId, command));
  }, (receipt): JsonValue => ({ schemaVersion: receipt.schemaVersion, commandId: receipt.commandId,
    kind: receipt.kind, objectId: receipt.objectId }));

  if (result.admission.fresh) {
    const receipt = parseWorkspaceCommandReceipt(result.result, expectedReceipt(envelope.commandId, command));
    if (!result.snapshot) throw new Error('workspace_command_snapshot_unavailable');
    return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt, snapshot: result.snapshot });
  }

  const status = result.admission.status as WorkspaceCommandStatus;
  if (status === 'finished') {
    const receipt = parseWorkspaceCommandReceipt(result.admission.receipt, expectedReceipt(envelope.commandId, command));
    return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status, receipt,
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
  if (admissionResult.status === 'finished') {
    const receipt = parseWorkspaceCommandReceipt(admissionResult.receipt, { commandId });
    return Object.freeze({ schemaVersion: 1, commandId, status: 'finished', receipt });
  }
  return Object.freeze({ schemaVersion: 1, commandId, status: admissionResult.status as WorkspaceCommandStatus });
}

function assertNever(_value: never): never { throw new Error('workspace_command_unsupported'); }

function expectedReceipt(commandId: string, command: WorkspaceCommandEnvelope['command']) {
  return { commandId, kind: command.kind, ...('taskId' in command ? { objectId: command.taskId } : {}) };
}
