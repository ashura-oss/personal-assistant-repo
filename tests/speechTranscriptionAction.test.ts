import { describe, expect, it, vi } from 'vitest';
import { createSpeechTranscriptionAdmission, runExplicitSpeechTranscriptionAction } from '../src/ui/speechTranscriptionAction';

function actions() {
  return { openSettings: vi.fn(), onPreviewBlocked: vi.fn(), onCredentialStatusUnavailable: vi.fn(), onReady: vi.fn(async () => undefined) };
}

describe('explicit Speech transcription action gate', () => {
  it('routes a missing OpenRouter key to Settings without calling the transcription action', async () => {
    const handlers = actions();
    const readOpenRouterConfigured = vi.fn(async () => false);
    const result = await runExplicitSpeechTranscriptionAction({
      provider: 'openrouter', enabled: true, hasAzureEndpoint: false, isolatedPreview: false,
      transcriptionSample: false, readOpenRouterConfigured,
    }, handlers);
    expect(result).toBe('settings_required');
    expect(readOpenRouterConfigured).toHaveBeenCalledTimes(1);
    expect(handlers.openSettings).toHaveBeenCalledTimes(1);
    expect(handlers.onReady).not.toHaveBeenCalled();
  });

  it('uses the configured OpenRouter key only on an explicit enabled action, with no Azure endpoint requirement', async () => {
    const handlers = actions();
    const readOpenRouterConfigured = vi.fn(async () => true);
    const result = await runExplicitSpeechTranscriptionAction({
      provider: 'openrouter', enabled: true, hasAzureEndpoint: false, isolatedPreview: false,
      transcriptionSample: false, readOpenRouterConfigured,
    }, handlers);
    expect(result).toBe('ready');
    expect(readOpenRouterConfigured).toHaveBeenCalledTimes(1);
    expect(handlers.onReady).toHaveBeenCalledTimes(1);
    expect(handlers.openSettings).not.toHaveBeenCalled();
  });

  it('opens Settings without reading keys or starting a request when transcription is disabled', async () => {
    const handlers = actions();
    const readOpenRouterConfigured = vi.fn(async () => true);
    const result = await runExplicitSpeechTranscriptionAction({
      provider: 'openrouter', enabled: false, hasAzureEndpoint: true, isolatedPreview: false,
      transcriptionSample: false, readOpenRouterConfigured,
    }, handlers);
    expect(result).toBe('settings_required');
    expect(readOpenRouterConfigured).not.toHaveBeenCalled();
    expect(handlers.openSettings).toHaveBeenCalledTimes(1);
    expect(handlers.onReady).not.toHaveBeenCalled();
  });

  it('keeps Azure independent and blocks provider access from the transcription sample', async () => {
    const azureHandlers = actions();
    const readOpenRouterConfigured = vi.fn(async () => true);
    await runExplicitSpeechTranscriptionAction({
      provider: 'azure', enabled: true, hasAzureEndpoint: true, isolatedPreview: false,
      transcriptionSample: false, readOpenRouterConfigured,
    }, azureHandlers);
    expect(readOpenRouterConfigured).not.toHaveBeenCalled();
    expect(azureHandlers.onReady).toHaveBeenCalledTimes(1);

    const sampleHandlers = actions();
    const sampleResult = await runExplicitSpeechTranscriptionAction({
      provider: 'openrouter', enabled: true, hasAzureEndpoint: false, isolatedPreview: true,
      transcriptionSample: true, readOpenRouterConfigured,
    }, sampleHandlers);
    expect(sampleResult).toBe('preview_blocked');
    expect(readOpenRouterConfigured).not.toHaveBeenCalled();
    expect(sampleHandlers.onReady).not.toHaveBeenCalled();
  });

  it('does not swallow a credential status failure into a controller call', async () => {
    const handlers = actions();
    const readOpenRouterConfigured = vi.fn(async () => { throw new Error('private key store detail'); });
    const result = await runExplicitSpeechTranscriptionAction({
      provider: 'openrouter', enabled: true, hasAzureEndpoint: false, isolatedPreview: false,
      transcriptionSample: false, readOpenRouterConfigured,
    }, handlers);
    expect(result).toBe('credential_status_unavailable');
    expect(handlers.onCredentialStatusUnavailable).toHaveBeenCalledTimes(1);
    expect(handlers.onReady).not.toHaveBeenCalled();
  });

  it('single-flights credential lookup through a failed upload before admitting another press', async () => {
    const admission = createSpeechTranscriptionAdmission();
    let releaseConfigured!: (value: boolean) => void;
    const firstRead = new Promise<boolean>((resolve) => { releaseConfigured = resolve; });
    const readOpenRouterConfigured = vi.fn(() => firstRead);
    const onReady = vi.fn().mockRejectedValueOnce(new Error('uncertain request result')).mockResolvedValue(undefined);
    const action = () => admission.run(() => runExplicitSpeechTranscriptionAction({
      provider: 'openrouter', enabled: true, hasAzureEndpoint: false, isolatedPreview: false,
      transcriptionSample: false, readOpenRouterConfigured,
    }, {
      openSettings: vi.fn(), onPreviewBlocked: vi.fn(), onCredentialStatusUnavailable: vi.fn(), onReady,
    }));

    const first = action();
    const second = await action();
    expect(second).toEqual({ status: 'busy' });
    expect(readOpenRouterConfigured).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();

    releaseConfigured(true);
    expect(await first).toEqual({ status: 'failed' });
    expect(onReady).toHaveBeenCalledTimes(1);

    const third = await action();
    expect(third.status).toBe('completed');
    expect(readOpenRouterConfigured).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledTimes(2);
  });
});
