import { describe, expect, it } from 'vitest';
import type { Account, AppSettings } from '../src/core';
import { moreComputeConfigurationFingerprint, moreComputeWorkspaceIsBlocked, type MoreComputeWorkspaceGate } from '../src/ui/moreComputeOwnership';

type CompleteSettingsFence = Omit<Pick<AppSettings, 'mode' | 'llmProvider' | 'openRouterModel' | 'openRouterReasoningEffort' | 'llmRequestContractVersion' | 'timezone'>, 'llmRequestContractVersion'> & { llmRequestContractVersion?: number };
const runtime = { workspaceGeneration: 1, sessionEpoch: 'epoch-a', sessionRuntimeId: 'runtime-a' } as const;
const settings = (overrides: Partial<CompleteSettingsFence> = {}): CompleteSettingsFence => ({
  mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch', openRouterReasoningEffort: 'low',
  llmRequestContractVersion: 1, timezone: 'Asia/Singapore', ...overrides,
});

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'mail-account', provider: 'google', displayName: 'Mail', email: 'mail@example.test', connected: true,
  authStatus: 'connected', connectionGeneration: 3,
  identity: { providerNamespace: 'google', clientId: 'app-client', subject: 'provider-subject', issuer: 'https://accounts.example.test' },
  grantedScopes: ['mail.read'], capabilities: ['mail.read'], capabilityLimits: ['mail.read'],
  ...overrides,
});

const allowedGate: MoreComputeWorkspaceGate = {
  startupReady: true, loading: false, demo: false, previewFailed: false, privacyBlocked: false,
  settingsOpen: false, backgroundActionBlocked: false, audioActive: false, captureLoading: false,
  capturePending: false, foregroundBlocked: false, recoveryBlocked: false, proposalReviewOpen: false, reminderReviewOpen: false,
  documentOpen: false, recordingAttachmentOpen: false, manualChatOpen: false, mailAlertTapOpen: false, chatDeleteReviewOpen: false,
  chatInteractionLocked: false, dispatchRecoveryOpen: false, knowledgeReviewOpen: false, voiceTransferReviewOpen: false, startupRecoveryOpen: false,
};

describe('production More Compute ownership fences', () => {
  it('changes the captured configuration fingerprint on provider policy and account lifecycle changes', () => {
    const original = moreComputeConfigurationFingerprint(settings(), [account()], runtime);
    expect(moreComputeConfigurationFingerprint(settings(), [account()], runtime)).toBe(original);
    expect(moreComputeConfigurationFingerprint(settings({ openRouterReasoningEffort: 'none' }), [account()], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings({ timezone: 'UTC' }), [account()], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings({ llmRequestContractVersion: 2 }), [account()], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account({ connectionGeneration: 4 })], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account({ authStatus: 'reauth_required' })], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account({ connected: false })], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account({ identity: { providerNamespace: 'google', subject: 'replacement' } })], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account({ grantedScopes: ['mail.read', 'mail.send'] })], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account({ capabilities: ['mail.read', 'mail.send'] })], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account({ capabilityLimits: [] })], runtime)).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account()], { ...runtime, workspaceGeneration: 2 })).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account()], { ...runtime, sessionEpoch: 'epoch-b' })).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account()], { ...runtime, sessionRuntimeId: 'runtime-b' })).not.toBe(original);
    expect(moreComputeConfigurationFingerprint(settings(), [account(), account({ id: 'second', connectionGeneration: 9 })], runtime))
      .toBe(moreComputeConfigurationFingerprint(settings(), [account({ id: 'second', connectionGeneration: 9 }), account()], runtime));
  });

  it('blocks workspace actions for foreground, recovery, capture, privacy, and competing-overlay transitions', () => {
    expect(moreComputeWorkspaceIsBlocked(allowedGate)).toBe(false);
    const blockers: readonly (keyof MoreComputeWorkspaceGate)[] = [
      'backgroundActionBlocked', 'capturePending', 'captureLoading', 'foregroundBlocked', 'recoveryBlocked',
      'privacyBlocked', 'proposalReviewOpen', 'reminderReviewOpen', 'documentOpen', 'recordingAttachmentOpen', 'manualChatOpen',
      'mailAlertTapOpen', 'chatDeleteReviewOpen', 'chatInteractionLocked', 'dispatchRecoveryOpen', 'knowledgeReviewOpen',
      'voiceTransferReviewOpen', 'startupRecoveryOpen', 'settingsOpen', 'audioActive', 'loading', 'demo', 'previewFailed',
    ];
    for (const key of blockers) {
      expect(moreComputeWorkspaceIsBlocked({ ...allowedGate, [key]: true })).toBe(true);
    }
  });
});
