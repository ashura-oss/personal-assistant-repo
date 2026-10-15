import type { JsonValue } from '../../server/src/kernel.js';
import type { WorkspaceHttpAdmission, WorkspaceHttpApi } from '../../server/src/workspaceHttp.js';
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

function serializeSnapshot(snapshot: WorkspaceSnapshotDTO): JsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as JsonValue;
}

function serializeCommandResponse(response: WorkspaceCommandResponse): JsonValue {
  return JSON.parse(JSON.stringify(response)) as JsonValue;
}
