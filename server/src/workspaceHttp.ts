import type { JsonValue } from './kernel.js';
import type { KnowledgeHttpApi } from './knowledgeHttp.js';
import type { BackgroundHttpApi } from './backgroundHttp.js';

/** Trusted in-process port for explicitly mounted workspace routes. */
export interface WorkspaceHttpAdmission {
  readonly sessionToken: string;
  readonly assertCurrent: () => void;
}

export interface WorkspaceHttpApi extends Partial<KnowledgeHttpApi>, Partial<BackgroundHttpApi> {
  assertWorkspaceAdmission?(admission: WorkspaceHttpAdmission): void;
  getSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue>;
  refreshSnapshot(admission: WorkspaceHttpAdmission): Promise<JsonValue>;
  dispatchCommand(admission: WorkspaceHttpAdmission, envelope: unknown): Promise<JsonValue>;
  inspectCommand(admission: WorkspaceHttpAdmission, commandId: string): JsonValue;
  listCommandHistory(admission: WorkspaceHttpAdmission, cursor?: string): JsonValue;
  cancelTranscription(admission: WorkspaceHttpAdmission, commandId: string): JsonValue;
  prepareWorkspaceErase?(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  confirmWorkspaceErase?(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  executeWorkspaceErase?(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  cancelWorkspaceErase?(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  retryWorkspaceEraseCleanup?(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  inspectWorkspaceErase?(admission: WorkspaceHttpAdmission, commandId: string): Promise<JsonValue | undefined>;
  inspectWorkspaceEraseStatus?(admission: WorkspaceHttpAdmission): Promise<JsonValue>;
  readMailReplySource?(admission: WorkspaceHttpAdmission, input: Readonly<{ messageId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readMailReplyText?(admission: WorkspaceHttpAdmission, input: Readonly<{ messageId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readProposalReview?(admission: WorkspaceHttpAdmission, input: Readonly<{ proposalId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readDispatchReview?(admission: WorkspaceHttpAdmission, input: Readonly<{ recordId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readMailReplyBatchReview?(admission: WorkspaceHttpAdmission, input: Readonly<{ planId: string; jobId: string; accountId: string; expectedConnectionGeneration: number; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readPeriodSummaryResult?(admission: WorkspaceHttpAdmission, input: Readonly<{ jobId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  readPeriodSummaryApplicationPreview?(admission: WorkspaceHttpAdmission, input: Readonly<{ planId: string; jobId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  exportPortableBackup?(admission: WorkspaceHttpAdmission, input: Readonly<{ expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  preparePortableBackupImport?(admission: WorkspaceHttpAdmission, input: Readonly<{ bytes: Uint8Array; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  prepareImportedKnowledgeActivation?(admission: WorkspaceHttpAdmission, input: Readonly<{ archiveId: string; cohortId: string;
    kind: 'person' | 'project'; entityId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<JsonValue>;
  cancelImportedKnowledgeActivation?(admission: WorkspaceHttpAdmission, input: Readonly<{ sessionId: string; expectedRevision: number; expectedPrivacyEpoch: number }>): Promise<void>;
}
