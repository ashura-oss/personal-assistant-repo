/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { OPENROUTER_SPEECH_ENDPOINT, OPENROUTER_SPEECH_MODEL, type OpenRouterTranscriptionAttempt } from '../src/transcription';
import type { TranscriptionPanelAttempt } from '../src/ui/TranscriptionPanel';
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

const note = { revision: 2, transcript: '', durationSeconds: 4.125, audioAttachment: undefined };
function openRouterAttempt(overrides: Partial<TranscriptionPanelAttempt> = {}): TranscriptionPanelAttempt {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    source: { durationSeconds: 4.125 }, createdAt: '2026-01-01T00:00:01.000Z',
    dispatchStarted: true, outcome: 'completed', provider: 'openrouter',
    actualUsage: { seconds: 4.2, inputTokens: 0, outputTokens: 12, totalTokens: 12, costUsd: 0 }, unknownCharge: false,
    ...overrides,
  };
}
function azureAttempt(): TranscriptionPanelAttempt {
  return {
    id: '44444444-4444-4444-8444-444444444444', source: { durationSeconds: 4.125 },
    createdAt: '2026-01-01T00:00:01.000Z', dispatchStarted: true, outcome: 'failed', code: 'provider_rejected',
    provider: 'azure', durationMilliseconds: 4200,
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
    note, recordingAvailable: true, attempts: [], speechProvider: 'azure', enabled: true, configured: true, busy: false,
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

  it('keeps safe provider history visible when no recording is available and offers no upload action', () => {
    render({ recordingAvailable: false, attempts: [openRouterAttempt()] });
    expect(host.textContent).toContain('OpenRouter-reported cost · US$0.00000000');
    expect(host.textContent).toContain('Recording is no longer attached. Transcription history remains available.');
    expect([...host.querySelectorAll('button')].some((button) => /Transcribe|Upload again/.test(button.textContent ?? ''))).toBe(false);
  });

  it('renders a real safe workspace DTO without exposing its local audio URI or prepared lease', () => {
    const noteId = '11111111-1111-4111-8111-111111111111';
    const state = createInitialWorkspaceState(() => noteId);
    state.notes.push({
      id: noteId, title: 'DTO note', transcript: 'Saved words', audioUri: 'file:///private/recording.m4a', durationSeconds: 4.125,
      createdAt: '2026-01-01T00:00:00.000Z', capturedAt: '2026-01-01T00:00:00.000Z', captureTimeZone: 'UTC', status: 'recorded', revision: 2,
    });
    state.transcription.attempts.push({
      id: '22222222-2222-4222-8222-222222222222', leaseId: '33333333-3333-4333-8333-333333333333', noteId,
      sourceRevision: 2, source: { audioUri: 'file:///private/request.m4a', durationSeconds: 4.125, capturedAt: '2026-01-01T00:00:00.000Z', captureTimeZone: 'UTC', speechEnabled: true, maxAudioSeconds: 600, provider: 'openrouter' },
      endpoint: OPENROUTER_SPEECH_ENDPOINT, createdAt: '2026-01-01T00:00:01.000Z', prepared: {
        leaseId: '44444444-4444-4444-8444-444444444444', platform: 'native', format: 'm4a', mimeType: 'audio/mp4', byteLength: 1200,
        sha256: 'a'.repeat(64), durationSeconds: 4.125,
      },
      dispatchStarted: true, outcome: 'unknown', provider: 'openrouter', profileVersion: 1, model: OPENROUTER_SPEECH_MODEL,
      locale: 'auto', unknownCharge: true,
    } satisfies OpenRouterTranscriptionAttempt);
    const snapshot = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, {
      workspaceId: '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8', privacyEpoch: 0, revision: 1,
    });
    const safeNote = snapshot.state.notes[0]!;
    const safeAttempt = snapshot.state.transcription.attempts[0]!;
    expect(safeNote.audio).toMatchObject({ available: false });
    expect(safeNote).not.toHaveProperty('audioUri');
    expect(safeAttempt).not.toHaveProperty('leaseId');
    expect(safeAttempt).not.toHaveProperty('prepared');
    render({ note: safeNote, recordingAvailable: safeNote.audio?.available ?? false, attempts: snapshot.state.transcription.attempts });
    expect(host.textContent).toContain('OpenRouter did not report usage for this request.');
    expect(host.textContent).toContain('may have received this recording and may charge for it');
    expect(host.textContent).toContain('Recording is no longer attached. Transcription history remains available.');
    expect(host.textContent).not.toContain('file:///');
    expect([...host.querySelectorAll('button')].some((button) => /Transcribe|Upload again/.test(button.textContent ?? ''))).toBe(false);
  });
});
