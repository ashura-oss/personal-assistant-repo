import type { JsonValue } from '../../server/src/kernel.js';
import type { WorkspaceHttpAdmission, WorkspaceHttpApi } from '../../server/src/workspaceHttp.js';
import type { KnowledgeHttpApi } from '../../server/src/knowledgeHttp.js';
import type { OwnedWorkspaceRuntime } from './ownedWorkspaceRuntime.node';
import { dispatchWorkspaceCommand, inspectWorkspaceCommand } from './workspaceCommands.node';
import type { WorkspaceCommandResponse } from './workspaceCommands';
import type { WorkspaceSnapshotDTO } from './workspaceDto';

/** Binds the HTTP port only to the safe snapshot and explicit command APIs. */
export function createWorkspaceHttpApi(runtime: OwnedWorkspaceRuntime): WorkspaceHttpApi {
  return Object.freeze({
    async getSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue> {
      return serializeSnapshot(await runtime.getSnapshot(admission));
    },
    async refreshSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue> {
      return serializeSnapshot(await runtime.refreshSnapshot(admission));
    },
    async dispatchCommand(admission: WorkspaceHttpAdmission, envelope: unknown): Promise<JsonValue> {
      return serializeCommandResponse(await dispatchWorkspaceCommand(runtime, admission, envelope));
    },
    async readKnowledgeSourceChoices(admission: WorkspaceHttpAdmission, input: Parameters<KnowledgeHttpApi['readKnowledgeSourceChoices']>[1]) {
      admission.assertCurrent();
      const result = await runtime.readKnowledgeSourceChoices(admission, input);
      admission.assertCurrent();
      return serializeKnowledgeRead(result);
    },
    async readKnowledgeSuggestionReview(admission: WorkspaceHttpAdmission, input: Parameters<KnowledgeHttpApi['readKnowledgeSuggestionReview']>[1]) {
      admission.assertCurrent();
      const result = await runtime.readKnowledgeSuggestionReview(admission, input);
      admission.assertCurrent();
      return serializeKnowledgeRead(result);
    },
    inspectCommand(admission: WorkspaceHttpAdmission, commandId: string): JsonValue {
      return serializeCommandResponse(inspectWorkspaceCommand(runtime, admission, commandId));
    },
    listCommandHistory(admission: WorkspaceHttpAdmission, cursor?: string) {
      admission.assertCurrent();
      const page = runtime.listCommandHistory(admission, cursor);
      admission.assertCurrent();
      return JSON.parse(JSON.stringify(page)) as JsonValue;
    },
    cancelTranscription(admission: WorkspaceHttpAdmission, commandId: string): JsonValue {
      const status = runtime.requestTranscriptionCancellation(admission, commandId);
      return { schemaVersion: 1, commandId, status };
    },
  });
}

function serializeKnowledgeRead(value: Awaited<ReturnType<KnowledgeHttpApi['readKnowledgeSourceChoices']>> | Awaited<ReturnType<KnowledgeHttpApi['readKnowledgeSuggestionReview']>>): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function serializeSnapshot(snapshot: WorkspaceSnapshotDTO): JsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as JsonValue;
}

function serializeCommandResponse(response: WorkspaceCommandResponse): JsonValue {
  return JSON.parse(JSON.stringify(response)) as JsonValue;
}
