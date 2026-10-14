/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../src/core';
import { OPENROUTER_SPEECH_ENDPOINT, OPENROUTER_SPEECH_MODEL, type OpenRouterTranscriptionAttempt, type TranscriptionAttempt } from '../src/transcription';
import { TranscriptionPanel } from '../src/ui/TranscriptionPanel';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const view = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => ReactModule.createElement(tag, props, children);
  return { View: view('div'), Text: view('span') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', card: '#222', border: '#333', sage: '#9a9' }, s: { sectionTitle: {}, setupBody: {} } }));

const note = {
  id: '11111111-1111-4111-8111-111111111111', revision: 2, transcript: '', audioUri: 'file:///recording.m4a', durationSeconds: 4.125,
  audioAttachment: undefined,
} as unknown as Note;
const source = {
  audioUri: note.audioUri!, durationSeconds: 4.125, capturedAt: '2026-01-01T00:00:00.000Z', captureTimeZone: 'UTC',
  speechEnabled: true, maxAudioSeconds: 600, provider: 'openrouter' as const,
};
function openRouterAttempt(overrides: Partial<OpenRouterTranscriptionAttempt> = {}): OpenRouterTranscriptionAttempt {
  return {
    id: '22222222-2222-4222-8222-222222222222', leaseId: '33333333-3333-4333-8333-333333333333', noteId: note.id,
    sourceRevision: 2, source, endpoint: OPENROUTER_SPEECH_ENDPOINT, createdAt: '2026-01-01T00:00:01.000Z',
    dispatchStarted: true, outcome: 'completed', provider: 'openrouter', profileVersion: 1, model: OPENROUTER_SPEECH_MODEL,
    locale: 'auto', actualUsage: { seconds: 4.2, inputTokens: 0, outputTokens: 12, totalTokens: 12, costUsd: 0 }, unknownCharge: false,
    ...overrides,
  } as OpenRouterTranscriptionAttempt;
}
function azureAttempt(): TranscriptionAttempt {
  return {
    id: '44444444-4444-4444-8444-444444444444', leaseId: '55555555-5555-4555-8555-555555555555', noteId: note.id,
    sourceRevision: 2, source: { ...source, provider: 'azure' }, endpoint: 'https://speech.example.test', locale: 'en-US',
    createdAt: '2026-01-01T00:00:01.000Z', dispatchStarted: true, outcome: 'failed', code: 'provider_rejected',
    durationMilliseconds: 4200, billedEstimateSeconds: 5, rateEstimated: true, reservation: { month: '2026-01', day: '2026-01-01', reserve: 1 },
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function render(overrides: Partial<React.ComponentProps<typeof TranscriptionPanel>> = {}) {
  act(() => root.render(React.createElement(TranscriptionPanel, {
    note, attempts: [], speechProvider: 'azure', enabled: true, configured: true, busy: false,
    requestRunning: false, demoMode: false, onTranscribe: vi.fn(), onCancel: vi.fn(), onOpenSettings: vi.fn(),
    ...overrides,
  })));
}

describe('transcription provider history and request cleanup UI', () => {
  it('shows zero and available OpenRouter-reported usage without Azure estimates, regardless of current selection', () => {
    render({ speechProvider: 'azure', attempts: [openRouterAttempt()] });
    expect(host.textContent).toContain('OpenRouter Speech');
    expect(host.textContent).toContain('OpenRouter-reported cost · US$0.00000000');
    expect(host.textContent).toContain('OpenRouter-reported input tokens · 0');
    expect(host.textContent).toContain('OpenRouter-reported audio seconds · 4.2 seconds');
    expect(host.textContent).not.toContain('Azure Speech ·');
    expect(host.textContent).not.toContain('billing duration estimate');
  });

  it('preserves exact reported Whisper precision, tiny positive charges, and a distinct reported zero', () => {
    render({ speechProvider: 'azure', attempts: [openRouterAttempt({
      actualUsage: { seconds: 5.478, costUsd: 0.00001824174 },
    })] });
    expect(host.textContent).toContain('OpenRouter-reported cost · US$0.00001824174');

    render({ speechProvider: 'azure', attempts: [openRouterAttempt({
      actualUsage: { costUsd: 0.000000001 },
    })] });
    expect(host.textContent).toContain('OpenRouter-reported cost · US$1e-9');

    render({ speechProvider: 'azure', attempts: [openRouterAttempt({
      actualUsage: { costUsd: 0 },
    })] });
    expect(host.textContent).toContain('OpenRouter-reported cost · US$0.00000000');
  });

  it('does not invent missing OpenRouter usage or Azure Speech charges', () => {
    render({ speechProvider: 'openrouter', attempts: [openRouterAttempt({ actualUsage: undefined })] });
    expect(host.textContent).toContain('OpenRouter did not report usage for this request.');
    expect(host.textContent).not.toContain('US$');
    expect(host.textContent).not.toContain('Azure Speech rejected');

    render({ speechProvider: 'openrouter', attempts: [azureAttempt()] });
    expect(host.textContent).toContain('Azure Speech rejected the request');
    expect(host.textContent).toContain('Azure Speech cost is not reported here.');
    expect(host.textContent).not.toContain('Provider billing duration estimate');
  });

  it('keeps explicit local request cleanup available during other busy work and single-flights it', async () => {
    let resolveCleanup!: () => void;
    const pending = new Promise<void>((resolve) => { resolveCleanup = resolve; });
    const onRetryRequestCleanup = vi.fn(() => pending);
    render({
      busy: true,
      attempts: [openRouterAttempt({ outcome: 'unknown', unknownCharge: true })],
      requestCleanupAttemptIds: ['22222222-2222-4222-8222-222222222222'],
      onRetryRequestCleanup,
    });
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Finish local request cleanup')!;
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); button.click(); await Promise.resolve(); });
    expect(onRetryRequestCleanup).toHaveBeenCalledTimes(1);
    expect(onRetryRequestCleanup).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
    await act(async () => { resolveCleanup(); await pending; });
  });

  it('shows the explicit OpenRouter upload action without submitting on render', () => {
    const onTranscribe = vi.fn();
    render({ speechProvider: 'openrouter', configured: true, onTranscribe });
    expect(host.textContent).toContain('separate audio request and may incur a charge');
    expect(host.textContent).toContain('No cost is estimated');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Transcribe recording')).toBe(true);
    expect(onTranscribe).not.toHaveBeenCalled();
  });
});
