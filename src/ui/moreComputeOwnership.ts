import type { Account, AppSettings } from '../core';

type MoreComputeSettingsFence = Omit<Pick<AppSettings,
  'mode' | 'llmProvider' | 'openRouterModel' | 'openRouterReasoningEffort' | 'llmRequestContractVersion' | 'timezone'>,
  'llmRequestContractVersion'> & { llmRequestContractVersion?: number };
export type MoreComputeRuntimeFence = Readonly<{ workspaceGeneration: number; sessionEpoch: string | null; sessionRuntimeId: string | null }>;

/** Internal owner fingerprint; includes account lifecycle and authorization state, never credentials. */
export function moreComputeConfigurationFingerprint(settings: MoreComputeSettingsFence, accounts: readonly Account[], runtime: MoreComputeRuntimeFence): string {
  const accountState = accounts.map((account) => [
    account.id, account.provider, account.connected, account.authStatus, account.connectionGeneration ?? null,
    account.identity ? [account.identity.providerNamespace ?? null, account.identity.clientId ?? null, account.identity.subject,
      account.identity.issuer ?? null, account.identity.tenantId ?? null, account.identity.resourceUserId ?? null] : null,
    account.verifiedEmail ?? null, account.grantedScopes ?? [], account.capabilities ?? [], account.capabilityLimits ?? [],
  ] as const).sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify([
    settings.mode, settings.llmProvider ?? null, settings.openRouterModel ?? null,
    settings.openRouterReasoningEffort ?? null, settings.llmRequestContractVersion ?? null, settings.timezone, accountState,
    runtime.workspaceGeneration, runtime.sessionEpoch, runtime.sessionRuntimeId,
  ]);
}

export type MoreComputeWorkspaceGate = Readonly<{
  startupReady: boolean;
  loading: boolean;
  demo: boolean;
  previewFailed: boolean;
  privacyBlocked: boolean;
  settingsOpen: boolean;
  backgroundActionBlocked: boolean;
  audioActive: boolean;
  captureLoading: boolean;
  capturePending: boolean;
  foregroundBlocked: boolean;
  recoveryBlocked: boolean;
  proposalReviewOpen: boolean;
  reminderReviewOpen: boolean;
  documentOpen: boolean;
  recordingAttachmentOpen: boolean;
  manualChatOpen: boolean;
  mailAlertTapOpen: boolean;
  chatDeleteReviewOpen: boolean;
  chatInteractionLocked: boolean;
  dispatchRecoveryOpen: boolean;
  knowledgeReviewOpen: boolean;
  voiceTransferReviewOpen: boolean;
  startupRecoveryOpen: boolean;
}>;

/** Workspace-wide blockers. The owner-specific NoteDetail and mail composer are checked separately. */
export function moreComputeWorkspaceIsBlocked(state: MoreComputeWorkspaceGate): boolean {
  return !state.startupReady || state.loading || state.demo || state.previewFailed || state.privacyBlocked || state.settingsOpen ||
    state.backgroundActionBlocked || state.audioActive || state.captureLoading || state.capturePending || state.foregroundBlocked ||
    state.recoveryBlocked || state.proposalReviewOpen || state.reminderReviewOpen || state.documentOpen || state.recordingAttachmentOpen ||
    state.manualChatOpen || state.mailAlertTapOpen || state.chatDeleteReviewOpen || state.chatInteractionLocked || state.dispatchRecoveryOpen ||
    state.knowledgeReviewOpen || state.voiceTransferReviewOpen || state.startupRecoveryOpen;
}
