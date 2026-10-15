import type { WorkspaceCommandEnvelope, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';

/** Compile-only browser contract proof; no AppState or Node capability enters the command shape. */
export function typedWorkspaceCommand(commandId: string): WorkspaceCommandEnvelope {
  return { schemaVersion: 1, commandId, expectedRevision: 0, expectedPrivacyEpoch: 0,
    command: { kind: 'tasks.complete', taskId: 'legacy opaque task id' } };
}

export function typedWorkspaceCommandResponse(response: WorkspaceCommandResponse): WorkspaceCommandResponse {
  return response;
}

// @ts-expect-error commands outside the fixed protocol remain unavailable.
const unsupportedCommand: WorkspaceCommandEnvelope['command'] = { kind: 'notes.delete', noteId: 'x' };
const createPerson: WorkspaceCommandEnvelope['command'] = { kind: 'knowledge.person.save', operation: 'create',
  input: { name: 'Ada', aliases: [], narrative: '' } };
const updatePerson: WorkspaceCommandEnvelope['command'] = { kind: 'knowledge.person.save', operation: 'update',
  input: { id: '123e4567-e89b-42d3-a456-426614174001', expectedRevision: 1, expectedDocumentRevision: null,
    name: 'Ada', aliases: [], narrative: '' } };
const ambiguousCreate: WorkspaceCommandEnvelope['command'] = { kind: 'knowledge.person.save', operation: 'create',
  input: {
    // @ts-expect-error creating a server-identified entity cannot supply an ID.
    id: '123e4567-e89b-42d3-a456-426614174001', name: 'Ada', aliases: [], narrative: '' } };
void [unsupportedCommand, createPerson, updatePerson, ambiguousCreate];
