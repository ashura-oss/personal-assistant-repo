import { describe, expect, it, vi } from 'vitest';
import type { AudioUploadHistoryPageDTO } from '../src/cloud/audioUploadHistoryDto';
import type { AudioUploadReceiptDTO } from '../src/cloud/audioUploadDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../src/cloud/workspaceCommands';
import type { AudioCaptureStopResult } from '../src/audio/types';
import { CloudVoiceCoordinator, type CloudVoiceCapturePort, type CloudVoiceWorkspacePort } from '../src/web/cloudVoiceCoordinator';
import type { AudioUploadClient, PendingAudioUpload } from '../src/web/audioClient';
import type { WorkspaceCommandAdmission } from '../src/web/workspaceClient';

const captureId = '11111111-1111-4111-8111-111111111111';
const uploadId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
// Capture adoption uses the capture ID as its resulting note ID.
const noteId = captureId;
const capturedAt = '2026-10-15T02:00:00.000Z';
const captureRevision = '55555555-5555-4555-8555-555555555555';

function readyReceipt(overrides: Partial<AudioUploadReceiptDTO> = {}): AudioUploadReceiptDTO {
  return { schemaVersion: 1, uploadId, status: 'ready', capture: { id: captureId, revision: captureRevision,
    capturedAt, timeZone: 'Asia/Singapore' }, media: { mediaId: `still-media:${noteId}`, sha256: 'a'.repeat(64),
      byteLength: 12, durationSeconds: 2, format: 'webm', mimeType: 'audio/webm' }, ...overrides };
}

function consumedReceipt(): AudioUploadReceiptDTO {
  const { media } = readyReceipt();
  return { schemaVersion: 1, uploadId, status: 'consumed', capture: { id: captureId, revision: captureRevision,
    capturedAt, timeZone: 'Asia/Singapore' }, consumption: { commandId, noteId, noteRevision: 1 }, media: media! };
}

function finishedAdoption(id = commandId, objectId = noteId, capId = captureId, revision = captureRevision): WorkspaceCommandResponse {
  return { schemaVersion: 1, commandId: id, status: 'finished', receipt: { schemaVersion: 1, commandId: id,
    kind: 'notes.capture.adopt', objectId, captureId: capId, captureRevision: revision } };
}

function admission(command: WorkspaceCommand): WorkspaceCommandAdmission {
  if (command.kind !== 'notes.capture.adopt') throw new Error('unexpected command');
  return { schemaVersion: 1, commandId, expectedRevision: 1, expectedPrivacyEpoch: 1, command };
}

function fakePorts(options: {
  stop?: () => Promise<AudioCaptureStopResult | null>;
  start?: () => Promise<void>;
  cancel?: () => Promise<void>;
  upload?: (onAdmitted: (pending: PendingAudioUpload) => void) => Promise<AudioUploadReceiptDTO>;
  inspectUpload?: (id: string) => Promise<AudioUploadReceiptDTO>;
  execute?: (command: WorkspaceCommand, admitted: (envelope: WorkspaceCommandAdmission) => void) => Promise<WorkspaceCommandResponse>;
  inspect?: (id: string) => Promise<WorkspaceCommandResponse>;
  makeCaptureId?: () => string;
} = {}) {
  const stop = vi.fn(options.stop ?? (async () => ({ uri: 'ram://clip', durationSeconds: 2, capturedAt, captureTimeZone: 'Asia/Singapore' } as const)));
  const readTemporaryClip = vi.fn(async () => new Blob(['voice'], { type: 'audio/webm' }));
  const commit = vi.fn();
  const cancel = vi.fn(options.cancel ?? (async () => undefined));
  const start = vi.fn(options.start ?? (async () => undefined));
  const capture: CloudVoiceCapturePort = { start, pause: async () => undefined, resume: async () => undefined,
    stop, readTemporaryClip, commit, cancel };
  let currentCapture = capture;
  let pendingUpload: PendingAudioUpload | undefined;
  const uploadClip = vi.fn(async (input: Parameters<AudioUploadClient['uploadClip']>[0], callback?: (pending: PendingAudioUpload) => void) => {
    const admit = (pending: PendingAudioUpload) => { pendingUpload = pending; callback?.(pending); };
    const pending = { uploadId, capture: input.capture };
    const receipt = options.upload ? await options.upload(admit) : (admit(pending), readyReceipt({ capture: {
      id: input.capture.id, revision: captureRevision, capturedAt: input.capture.capturedAt, timeZone: input.capture.timeZone,
    } }));
    if (receipt.status === 'ready' && pendingUpload?.uploadId === receipt.uploadId) pendingUpload = undefined;
    return receipt;
  });
  const inspectUpload = vi.fn(async (id: string) => {
    const receipt = options.inspectUpload ? await options.inspectUpload(id) : readyReceipt();
    if (pendingUpload?.uploadId === id && ['ready', 'failed', 'consumed', 'discarded'].includes(receipt.status)) pendingUpload = undefined;
    return receipt;
  });
  const listUploads = vi.fn(async (): Promise<AudioUploadHistoryPageDTO> => ({ schemaVersion: 1, entries: [] }));
  const audio: Pick<AudioUploadClient, 'uploadClip' | 'inspectUpload' | 'listUploads' | 'getPendingUpload' | 'dispose'> = {
    uploadClip, inspectUpload, listUploads, getPendingUpload: () => pendingUpload, dispose: vi.fn(),
  };
  const execute = vi.fn(options.execute ?? (async (command, admitted) => {
    if (command.kind !== 'notes.capture.adopt') throw new Error('unexpected command');
    admitted(admission(command));
    return finishedAdoption(commandId, command.captureId, command.captureId, command.captureRevision);
  }));
  const inspect = vi.fn(options.inspect ?? (async () => finishedAdoption()));
  const workspace: CloudVoiceWorkspacePort = { execute, inspect, refresh: vi.fn(async () => undefined), readSnapshot: () => undefined };
  const coordinator = new CloudVoiceCoordinator({ audio, workspace, getCapture: () => currentCapture,
    disposeAudioOnDispose: false, makeCaptureId: options.makeCaptureId ?? (() => captureId) });
  return { coordinator, capture, setCapture: (next: CloudVoiceCapturePort) => { currentCapture = next; }, stop,
    start, readTemporaryClip, commit, cancel, uploadClip, inspectUpload, listUploads, execute, inspect, audio, workspace };
}

describe('CloudVoiceCoordinator', () => {
  it('stops, uploads and adopts once, binding the final receipt before releasing RAM audio', async () => {
    const f = fakePorts();
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    expect(f.coordinator.getSnapshot().phase).toBe('saved');
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.uploadClip).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot().captureId).toBe(captureId);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[0]).toEqual({ kind: 'notes.capture.adopt', captureId, captureRevision });
    expect(f.commit).toHaveBeenCalledWith('ram://clip');
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'saved', noteId, localClipPresent: false });
  });

  it('cannot stop the same pending capture or re-adopt after the first save was admitted', async () => {
    const f = fakePorts();
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    await expect(f.coordinator.stopAndSave()).rejects.toThrow('while voice session is saved');
    await expect(f.coordinator.saveReady()).rejects.toThrow('without an admitted adoption');
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.uploadClip).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.commit).toHaveBeenCalledTimes(1);
    f.coordinator.resetAfterSave();
    expect(f.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('reuses one capture ID when a failed Stop is retried against the still-owned recorder', async () => {
    let attempts = 0;
    const makeCaptureId = vi.fn(() => captureId);
    const f = fakePorts({ makeCaptureId, stop: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('recorder stop not confirmed');
      return { uri: 'ram://clip', durationSeconds: 0, capturedAt, captureTimeZone: 'Asia/Singapore' };
    } });
    await f.coordinator.start();
    await f.coordinator.stopAndSave();
    expect(f.coordinator.getSnapshot().phase).toBe('recording');
    await f.coordinator.stopAndSave();
    expect(makeCaptureId).toHaveBeenCalledTimes(1);
    expect(f.uploadClip.mock.calls[0]?.[0]).toMatchObject({ capture: { id: captureId } });
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'saved', captureId });
  });

  it('mints a fresh capture ID after an explicitly reset, confirmed save', async () => {
    const secondCaptureId = '66666666-6666-4666-8666-666666666666';
    const ids = [captureId, secondCaptureId];
    const makeCaptureId = vi.fn(() => ids.shift() ?? '77777777-7777-4777-8777-777777777777');
    const f = fakePorts({ makeCaptureId });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    f.coordinator.resetAfterSave();
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    expect(makeCaptureId).toHaveBeenCalledTimes(2);
    expect(f.uploadClip.mock.calls.map(([input]) => input.capture.id)).toEqual([captureId, secondCaptureId]);
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'saved', captureId: secondCaptureId, noteId: secondCaptureId });
  });

  it('admits only one simultaneous stop/upload action', async () => {
    let release!: (value: AudioCaptureStopResult | null) => void;
    const f = fakePorts({ stop: () => new Promise((resolve) => { release = resolve; }) });
    await f.coordinator.start();
    const first = f.coordinator.stopAndSave();
    await expect(f.coordinator.stopAndSave()).rejects.toThrow('already in progress');
    release({ uri: 'ram://clip', durationSeconds: 2, capturedAt, captureTimeZone: 'Asia/Singapore' });
    await first;
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.uploadClip).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost upload acknowledgement by inspecting the admitted ID and never posts again', async () => {
    const f = fakePorts({ upload: async (admitted) => {
      admitted({ uploadId, capture: { id: captureId, capturedAt, timeZone: 'Asia/Singapore' } });
      throw new Error('connection lost');
    } });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'upload_unknown', uploadId, localClipPresent: true });
    await f.coordinator.inspectUpload(uploadId);
    expect(f.inspectUpload).toHaveBeenCalledExactlyOnceWith(uploadId);
    expect(f.uploadClip).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'ready', uploadId });
    await f.coordinator.saveReady();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('inspects, but never reexecutes, an adoption after its acknowledgement is lost', async () => {
    const f = fakePorts({ execute: async (_command, admitted) => { admitted(admission(_command)); throw new Error('lost ack'); } });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'adoption_unknown', adoptionCommandId: commandId });
    await f.coordinator.inspectAdoption();
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith(commandId);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.commit).toHaveBeenCalledWith('ram://clip');
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'saved', noteId });
  });

  it('does not let a ready upload inspection downgrade an admitted adoption into a resend', async () => {
    const f = fakePorts({ execute: async (_command, admitted) => { admitted(admission(_command)); throw new Error('lost ack'); } });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'adoption_unknown', adoptionCommandId: commandId });
    await f.coordinator.inspectUpload(uploadId);
    await expect(f.coordinator.saveReady()).rejects.toThrow('Only a ready upload');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'adoption_unknown', adoptionCommandId: commandId });
    await f.coordinator.inspectAdoption();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot().phase).toBe('saved');
  });

  it('requires the receipt to bind the exact command, capture revision, and note before commit', async () => {
    const f = fakePorts({ execute: async (_command, admitted) => {
      admitted(admission(_command)); return finishedAdoption(commandId, noteId, captureId, '66666666-6666-4666-8666-666666666666');
    } });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.coordinator.getSnapshot().phase).toBe('adoption_unknown');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps non-ready upload outcomes visible and does not adopt them', async () => {
    const failed: AudioUploadReceiptDTO = { schemaVersion: 1, uploadId, status: 'failed', capture: {
      id: captureId, revision: captureRevision, capturedAt, timeZone: 'Asia/Singapore' } };
    const f = fakePorts({ inspectUpload: async () => failed, upload: async (admitted) => {
      admitted({ uploadId, capture: { id: captureId, capturedAt, timeZone: 'Asia/Singapore' } }); return failed;
    } });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'stopped', uploadStatus: 'failed', localClipPresent: true });
    await expect(f.coordinator.saveReady()).rejects.toThrow('Only a ready upload');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    await f.coordinator.discardLocalClip();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'stopped', uploadId, localClipPresent: false });
    expect(f.coordinator.getSnapshot().error).toContain('Inspect this terminal upload ID');
    await expect(f.coordinator.start()).rejects.toThrow('while voice session is stopped');
    await f.coordinator.inspectUpload(uploadId);
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'idle', selectedUploadId: uploadId,
      selectedReceipt: failed, localClipPresent: false });
    expect(f.coordinator.getSnapshot().error).toContain('server record remains available in history');
    await expect(f.coordinator.start()).resolves.toBeUndefined();
  });

  it('recovers a consumed upload by inspecting its referenced adoption command instead of re-adopting', async () => {
    const f = fakePorts({ inspectUpload: async (id) => { expect(id).toBe(uploadId); return consumedReceipt(); } });
    await f.coordinator.selectUpload(uploadId);
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith(commandId);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'saved', noteId, uploadId });
  });

  it('allows an explicitly selected ready history item to be saved once without local bytes', async () => {
    const f = fakePorts({ inspectUpload: async () => readyReceipt() });
    await f.coordinator.selectUpload(uploadId);
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'ready', uploadId, localClipPresent: false });
    await f.coordinator.saveReady();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'saved', noteId, localClipPresent: false });
  });

  it('normalizes a ready history selection before inspecting another upload', async () => {
    const failed: AudioUploadReceiptDTO = { schemaVersion: 1, uploadId: '66666666-6666-4666-8666-666666666666',
      status: 'failed', capture: { id: '77777777-7777-4777-8777-777777777777', revision: captureRevision,
        capturedAt, timeZone: 'Asia/Singapore' } };
    const f = fakePorts({ inspectUpload: async (id) => id === uploadId ? readyReceipt() : failed });
    await f.coordinator.selectUpload(uploadId);
    expect(f.coordinator.getSnapshot().phase).toBe('ready');
    await f.coordinator.selectUpload(failed.uploadId);
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'idle', selectedUploadId: failed.uploadId,
      selectedReceipt: failed, localClipPresent: false });
    await expect(f.coordinator.saveReady()).rejects.toThrow('Only a ready upload');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('requires reset after one saved history item before selecting another', async () => {
    const secondId = '66666666-6666-4666-8666-666666666666';
    const f = fakePorts({ inspectUpload: async (id) => readyReceipt({ uploadId: id }) });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    await expect(f.coordinator.selectUpload(secondId)).rejects.toThrow('Reset the confirmed saved capture');
    f.coordinator.resetAfterSave();
    await f.coordinator.selectUpload(secondId);
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'ready', uploadId: secondId, selectedUploadId: secondId });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves the local RAM clip and recovery identity on explicit local discard after ambiguity', async () => {
    const f = fakePorts({ upload: async (admitted) => {
      admitted({ uploadId, capture: { id: captureId, capturedAt, timeZone: 'Asia/Singapore' } }); throw new Error('lost ack');
    } });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    await f.coordinator.discardLocalClip();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'upload_unknown', uploadId, localClipPresent: false });
    await expect(f.coordinator.uploadStoppedClip()).rejects.toThrow('safely retryable');
  });

  it('keeps a current unknown upload selected while still allowing metadata history reads', async () => {
    const f = fakePorts({ upload: async (admitted) => {
      admitted({ uploadId, capture: { id: captureId, capturedAt, timeZone: 'Asia/Singapore' } }); throw new Error('lost ack');
    } });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    await expect(f.coordinator.selectUpload('66666666-6666-4666-8666-666666666666')).rejects.toThrow('Resolve or explicitly discard');
    expect(f.listUploads).not.toHaveBeenCalled();
    const page = await f.coordinator.listHistory();
    expect(page.entries).toHaveLength(0);
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'upload_unknown', uploadId, localClipPresent: true });
  });

  it('explicitly discards an active recording locally without entering an upload flow', async () => {
    const f = fakePorts();
    await f.coordinator.start();
    await f.coordinator.cancelCurrentRecording();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.uploadClip).not.toHaveBeenCalled();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'idle', localClipPresent: false });
  });

  it('routes a failed start to recovery, allowing Stop for a retained recorder but no implicit upload', async () => {
    const f = fakePorts({ start: async () => { throw new Error('recorder remains active'); } });
    await expect(f.coordinator.start()).rejects.toThrow('recorder remains active');
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'capture_recovery', localClipPresent: false });
    expect(f.uploadClip).not.toHaveBeenCalled();
    await expect(f.coordinator.start()).rejects.toThrow('while voice session is capture_recovery');
    await f.coordinator.stopAndSave();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.uploadClip).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot().phase).toBe('saved');
  });

  it('routes a null Stop to recovery and permits a new recording only after successful local cleanup', async () => {
    const f = fakePorts({ stop: async () => null });
    await f.coordinator.start();
    await f.coordinator.stopAndSave();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'capture_recovery', localClipPresent: false });
    expect(f.uploadClip).not.toHaveBeenCalled();
    await f.coordinator.cancelCurrentRecording();
    expect(f.coordinator.getSnapshot().phase).toBe('idle');
    await f.coordinator.start();
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it('keeps failed cleanup in capture recovery and forbids replacement start', async () => {
    let cancelAttempts = 0;
    const f = fakePorts({ start: async () => { throw new Error('uncertain recorder state'); }, cancel: async () => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) throw new Error('stop not confirmed');
    } });
    await expect(f.coordinator.start()).rejects.toThrow('uncertain recorder state');
    await expect(f.coordinator.cancelCurrentRecording()).rejects.toThrow('stop not confirmed');
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'capture_recovery', error: 'stop not confirmed' });
    await expect(f.coordinator.start()).rejects.toThrow('while voice session is capture_recovery');
    await f.coordinator.cancelCurrentRecording();
    expect(f.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('returns to idle when discarding a known pre-send stopped clip and keeps it local-only', async () => {
    const f = fakePorts();
    f.readTemporaryClip.mockRejectedValueOnce(new Error('local read failed'));
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'stopped', localClipPresent: true });
    await f.coordinator.discardLocalClip();
    expect(f.coordinator.getSnapshot()).toMatchObject({ phase: 'idle', localClipPresent: false });
    expect(f.uploadClip).not.toHaveBeenCalled();
    await expect(f.coordinator.start()).resolves.toBeUndefined();
  });

  it('fences every continuation after session disposal, including an awaited clip read', async () => {
    let release!: (value: Blob) => void;
    const f = fakePorts();
    const replacementCapture: CloudVoiceCapturePort = { ...f.capture,
      readTemporaryClip: () => new Promise((resolve) => { release = resolve; }) };
    f.setCapture(replacementCapture);
    await f.coordinator.start();
    const run = f.coordinator.stopAndSave();
    // stop uses the replacement port's inherited method, then pauses at its read.
    await Promise.resolve(); await Promise.resolve();
    f.coordinator.dispose();
    release(new Blob(['late'], { type: 'audio/webm' }));
    await run;
    expect(f.uploadClip).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('fences an upload response after logout so it cannot start adoption', async () => {
    let release!: (receipt: AudioUploadReceiptDTO) => void;
    const f = fakePorts({ upload: (admitted) => {
      admitted({ uploadId, capture: { id: captureId, capturedAt, timeZone: 'Asia/Singapore' } });
      return new Promise((resolve) => { release = resolve; });
    } });
    await f.coordinator.start();
    const run = f.coordinator.stopAndSave();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    f.coordinator.dispose();
    release(readyReceipt());
    await run;
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('fences an exact adoption inspection response after logout before local commit', async () => {
    let release!: (response: WorkspaceCommandResponse) => void;
    const f = fakePorts({ execute: async (_command, admitted) => { admitted(admission(_command)); throw new Error('lost ack'); },
      inspect: () => new Promise((resolve) => { release = resolve; }) });
    await f.coordinator.start(); await f.coordinator.stopAndSave();
    const inspect = f.coordinator.inspectAdoption();
    await Promise.resolve();
    f.coordinator.dispose();
    release(finishedAdoption());
    await inspect;
    expect(f.commit).not.toHaveBeenCalled();
  });
});
