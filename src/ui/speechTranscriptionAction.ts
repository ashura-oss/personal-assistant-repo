export type SpeechTranscriptionActionProvider = 'azure' | 'openrouter';
export type SpeechTranscriptionGateResult = 'ready' | 'settings_required' | 'credential_status_unavailable' | 'preview_blocked';
export type SpeechTranscriptionAdmissionResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'busy' }
  | { status: 'failed' };

/** Synchronous singleflight covering credential checks as well as the upload callback. */
export function createSpeechTranscriptionAdmission() {
  let active = false;
  return {
    run<T>(action: () => Promise<T>): Promise<SpeechTranscriptionAdmissionResult<T>> {
      if (active) return Promise.resolve({ status: 'busy' });
      active = true;
      return Promise.resolve()
        .then(action)
        .then((value): SpeechTranscriptionAdmissionResult<T> => ({ status: 'completed', value }))
        .catch((): SpeechTranscriptionAdmissionResult<T> => ({ status: 'failed' }))
        .finally(() => { active = false; });
    },
  };
}

export async function runExplicitSpeechTranscriptionAction(input: {
  provider: SpeechTranscriptionActionProvider;
  enabled: boolean;
  hasAzureEndpoint: boolean;
  isolatedPreview: boolean;
  transcriptionSample: boolean;
  readOpenRouterConfigured: () => Promise<boolean>;
}, actions: {
  openSettings: () => void;
  onPreviewBlocked: () => void;
  onCredentialStatusUnavailable: () => void;
  onReady: () => Promise<void>;
}): Promise<SpeechTranscriptionGateResult> {
  if ((input.isolatedPreview && !input.transcriptionSample) ||
      (input.transcriptionSample && input.provider === 'openrouter')) {
    actions.onPreviewBlocked();
    return 'preview_blocked';
  }
  if (!input.enabled || (input.provider === 'azure' && !input.hasAzureEndpoint)) {
    actions.openSettings();
    return 'settings_required';
  }
  if (input.provider === 'openrouter') {
    let configured: boolean;
    try { configured = await input.readOpenRouterConfigured(); }
    catch {
      actions.onCredentialStatusUnavailable();
      return 'credential_status_unavailable';
    }
    if (!configured) {
      actions.openSettings();
      return 'settings_required';
    }
  }
  await actions.onReady();
  return 'ready';
}
