import type { WorkspaceCommandEnvelope, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';

/** Compile-only browser contract proof; no AppState or Node capability enters the command shape. */
export function typedWorkspaceCommand(commandId: string): WorkspaceCommandEnvelope {
  return { schemaVersion: 1, commandId, expectedRevision: 0, expectedPrivacyEpoch: 0,
    command: { kind: 'tasks.complete', taskId: 'legacy opaque task id' } };
}

export function typedWorkspaceCommandResponse(response: WorkspaceCommandResponse): WorkspaceCommandResponse {
  return response;
}

// @ts-expect-error only the three explicit commands are part of this first contract.
const unsupportedCommand: WorkspaceCommandEnvelope['command'] = { kind: 'notes.delete', noteId: 'x' };
void unsupportedCommand;
