import type { JsonValue } from './kernel.js';

/** Trusted in-process port for explicitly mounted workspace routes. */
export interface WorkspaceHttpAdmission {
  readonly sessionToken: string;
  readonly assertCurrent: () => void;
}

export interface WorkspaceHttpApi {
  getSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue>;
  refreshSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue>;
  dispatchCommand(admission: WorkspaceHttpAdmission, envelope: unknown): Promise<JsonValue>;
  inspectCommand(admission: WorkspaceHttpAdmission, commandId: string): JsonValue;
  listCommandHistory(admission: WorkspaceHttpAdmission, cursor?: string): JsonValue;
  cancelTranscription(admission: WorkspaceHttpAdmission, commandId: string): JsonValue;
}
