import type { OAuthInstallStageStatus, OAuthStageCapability, OAuthStageProvider } from './oauthInstallStages.js';
import type { WorkspaceHttpAdmission } from './workspaceHttp.js';

export interface OAuthStartRequest {
  readonly startAttemptId: string;
  readonly requestedCapabilities: readonly OAuthStageCapability[];
  readonly reconnectAccountId?: string;
  readonly restartOfStartAttemptId?: string;
  readonly expectedRevision: number;
  readonly expectedPrivacyEpoch: number;
}

export interface OAuthStartResult {
  readonly kind: 'started' | 'existing';
  readonly status: OAuthInstallStageStatus;
  readonly authorizationUrl?: string;
  readonly cookie?: Readonly<{ name: string; value: string; maxAgeSeconds: number }>;
  readonly clearCookieNames?: readonly string[];
}

export interface OAuthAttemptMetadata {
  readonly startAttemptId: string;
  readonly provider: OAuthStageProvider;
  readonly status: OAuthInstallStageStatus['status'] | 'superseded' | 'building' | 'restart_required';
  readonly stageId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumption?: OAuthInstallStageStatus['consumption'];
}

export interface OAuthVerifiedAccountPreview {
  readonly displayName: string;
  readonly email?: string;
  readonly requestedCapabilities: readonly OAuthStageCapability[];
  readonly capabilities: readonly OAuthStageCapability[];
  readonly reconnectAccountId?: string;
}

export interface OAuthStageInspection {
  readonly stage: OAuthInstallStageStatus;
  readonly verifiedAccount?: OAuthVerifiedAccountPreview;
}

export interface OAuthCallbackInput {
  readonly state: string;
  readonly cookieBinding: string;
  readonly code?: string;
  readonly error?: string;
}

export interface OAuthHttpApi {
  availability(admission: WorkspaceHttpAdmission): Readonly<{ google: boolean; microsoft: boolean }>;
  start(admission: WorkspaceHttpAdmission, provider: OAuthStageProvider, input: unknown): Promise<OAuthStartResult>;
  inspectStart(admission: WorkspaceHttpAdmission, provider: OAuthStageProvider, startAttemptId: string): OAuthAttemptMetadata;
  listStarts(admission: WorkspaceHttpAdmission, provider?: OAuthStageProvider): readonly OAuthAttemptMetadata[];
  inspectStage(admission: WorkspaceHttpAdmission, stageId: string): OAuthStageInspection;
  /** Returns only the expected cookie name for a state hint; it grants no callback authority. */
  callbackCookieName(provider: OAuthStageProvider, state: string): string | undefined;
  callback(provider: OAuthStageProvider, input: OAuthCallbackInput): Promise<Readonly<{ attemptId?: string; status: string; clearCookieName?: string }>>;
  stopAdmission(): void;
  drain(): Promise<void>;
}
