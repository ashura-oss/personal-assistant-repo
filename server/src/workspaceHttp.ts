import type { JsonValue } from './kernel.js';
import type { KnowledgeHttpApi } from './knowledgeHttp.js';
import type { BackgroundHttpApi } from './backgroundHttp.js';

/** Trusted in-process port for explicitly mounted workspace routes. */
export interface WorkspaceHttpAdmission {
  readonly sessionToken: string;
  readonly assertCurrent: () => void;
}

export interface WorkspaceHttpApi extends Partial<KnowledgeHttpApi>, Partial<BackgroundHttpApi> {
  getSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue>;
  refreshSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue>;
  dispatchCommand(admission: WorkspaceHttpAdmission, envelope: unknown): Promise<JsonValue>;
  inspectCommand(admission: WorkspaceHttpAdmission, commandId: string): JsonValue;
  listCommandHistory(admission: WorkspaceHttpAdmission, cursor?: string): JsonValue;
  cancelTranscription(admission: WorkspaceHttpAdmission, commandId: string): JsonValue;
  readMailReplySource?(admission: WorkspaceHttpAdmission, input: Readonly<{ messageId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readMailReplyText?(admission: WorkspaceHttpAdmission, input: Readonly<{ messageId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readProposalReview?(admission: WorkspaceHttpAdmission, input: Readonly<{ proposalId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readDispatchReview?(admission: WorkspaceHttpAdmission, input: Readonly<{ recordId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readMailReplyBatchReview?(admission: WorkspaceHttpAdmission, input: Readonly<{ planId: string; jobId: string; accountId: string; expectedConnectionGeneration: number; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
}
