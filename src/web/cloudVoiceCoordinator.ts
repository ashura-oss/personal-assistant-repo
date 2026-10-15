/** Session-owned orchestration for explicit browser audio upload and note adoption. */
import type { AudioCapture as CaptureController, AudioCaptureStopResult } from '../audio/types';
import type { AudioUploadHistoryPageDTO } from '../cloud/audioUploadHistoryDto';
import type { AudioUploadReceiptDTO } from '../cloud/audioUploadDto';
import type { WorkspaceCommand, WorkspaceCommandResponse } from '../cloud/workspaceCommands';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { AudioUploadClient } from './audioClient';
import type { WorkspaceCommandAdmission } from './workspaceClient';

type LegacyStoppedClip = Extract<NonNullable<AudioCaptureStopResult>, { readonly uri: string }>;

/** The small part of the hook result used by this coordinator. The getter stays live across renders. */
export type CloudVoiceCapturePort = Pick<CaptureController, 'start' | 'pause' | 'resume' | 'stop' | 'commit' | 'cancel'> &
  Readonly<{ readTemporaryClip(uri: string): Promise<Blob> }>;

/** Only the workspace operations needed to adopt and recover a capture. */
export type CloudVoiceWorkspacePort = Readonly<{
  execute(command: WorkspaceCommand, onAdmitted?: (envelope: WorkspaceCommandAdmission) => void): Promise<WorkspaceCommandResponse>;
  inspect(commandId: string): Promise<WorkspaceCommandResponse>;
  refresh(): Promise<WorkspaceSnapshotDTO | undefined>;
  readSnapshot(): WorkspaceSnapshotDTO | undefined;
}>;

export type CloudVoicePhase = 'idle' | 'recording' | 'paused' | 'capture_recovery' | 'stopped' | 'uploading' |
  'upload_unknown' | 'ready' | 'adopting' | 'adoption_unknown' | 'saved';

export type CloudVoiceCoordinatorState = Readonly<{
  phase: CloudVoicePhase;
  captureId?: string;
  capturedAt?: string;
  captureTimeZone?: string;
  durationSeconds?: number;
  uploadId?: string;
  uploadStatus?: AudioUploadReceiptDTO['status'];
  uploadReceipt?: AudioUploadReceiptDTO;
  adoptionCommandId?: string;
  noteId?: string;
  snapshot?: WorkspaceSnapshotDTO;
  history?: AudioUploadHistoryPageDTO;
  selectedUploadId?: string;
  selectedReceipt?: AudioUploadReceiptDTO;
  error?: string;
  localClipPresent: boolean;
}>;

export type CloudVoiceCoordinatorOptions = Readonly<{
  audio: Pick<AudioUploadClient, 'uploadClip' | 'inspectUpload' | 'listUploads' | 'getPendingUpload' | 'dispose'>;
  workspace: CloudVoiceWorkspacePort;
  /** Read on every operation to avoid holding an obsolete render's capture methods. */
  getCapture: () => CloudVoiceCapturePort;
  /** Explicit because a caller may share the authenticated transport with another session service. */
  disposeAudioOnDispose: boolean;
  makeCaptureId?: () => string;
  onChange?: (state: CloudVoiceCoordinatorState) => void;
}>;

type HeldClip = Readonly<{
  uri: string;
  captureId: string;
  capturedAt: string;
  captureTimeZone: string;
  durationSeconds: number;
}>;

type UploadReceiptDecision = 'ready' | 'consumed' | 'terminal' | 'unresolved' | 'adoption_bound';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createCaptureId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('Secure capture identifiers are unavailable in this browser.');
}

function isLegacyStop(value: AudioCaptureStopResult | null): value is LegacyStoppedClip {
  return !!value && 'uri' in value && typeof value.uri === 'string' && value.uri.length > 0 &&
    typeof value.capturedAt === 'string' && typeof value.captureTimeZone === 'string' &&
    Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0;
}

function sameCapture(receipt: AudioUploadReceiptDTO, clip: HeldClip): boolean {
  return receipt.capture.id === clip.captureId && receipt.capture.capturedAt === clip.capturedAt &&
    receipt.capture.timeZone === clip.captureTimeZone;
}

function exactAdoption(response: WorkspaceCommandResponse, commandId: string, captureId: string,
  captureRevision: string, expectedNoteId?: string): string | undefined {
  const receipt = response.receipt;
  if (response.status !== 'finished' || response.commandId !== commandId || !receipt ||
      receipt.kind !== 'notes.capture.adopt' || receipt.commandId !== commandId ||
      receipt.captureId !== captureId || receipt.captureRevision !== captureRevision ||
      receipt.objectId !== captureId || (expectedNoteId !== undefined && receipt.objectId !== expectedNoteId)) return undefined;
  return receipt.objectId;
}

/**
 * Owns one authenticated workspace voice-save flow. It deliberately has no automatic retries,
 * polling, transcription, or playback behavior.
 */
export class CloudVoiceCoordinator {
  private value: CloudVoiceCoordinatorState = Object.freeze({ phase: 'idle', localClipPresent: false });
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private operation = false;
  private clip?: HeldClip;
  private pendingCaptureId?: string;
  private selectedCommandId?: string;
  private selectedCapture?: Readonly<{ id: string; revision: string }>;

  constructor(private readonly options: CloudVoiceCoordinatorOptions) {}

  readonly getSnapshot = (): CloudVoiceCoordinatorState => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private current(ticket: number): boolean { return !this.disposed && ticket === this.generation; }

  private publish(ticket: number, next: CloudVoiceCoordinatorState): void {
    if (!this.current(ticket)) return;
    this.value = Object.freeze(next);
    try { this.options.onChange?.(this.value); } catch { /* Observer failures do not change transport admission. */ }
    for (const listener of this.listeners) { try { listener(); } catch { /* One observer cannot interrupt the owner. */ } }
  }

  private begin(): number {
    if (this.disposed) throw new Error('This voice session is no longer active.');
    if (this.operation) throw new Error('A voice save action is already in progress.');
    this.operation = true;
    return this.generation;
  }

  private finish(ticket: number): void {
    if (this.current(ticket)) this.operation = false;
  }

  private async captureAction(action: 'start' | 'pause' | 'resume'): Promise<void> {
    const phase = this.value.phase;
    if ((action === 'start' && phase !== 'idle') || (action === 'pause' && phase !== 'recording') ||
        (action === 'resume' && phase !== 'paused')) throw new Error(`Cannot ${action} while voice session is ${phase}.`);
    const ticket = this.begin();
    try {
      if (action === 'start') this.pendingCaptureId = undefined;
      await this.options.getCapture()[action]();
      if (this.current(ticket)) {
        const phase = action === 'pause' ? 'paused' : 'recording';
        this.publish(ticket, action === 'start'
          ? { phase, localClipPresent: false, ...(this.value.history ? { history: this.value.history } : {}),
              snapshot: this.options.workspace.readSnapshot() }
          : { ...this.value, phase, error: undefined });
      }
    } catch (error) {
      if (this.current(ticket) && action === 'start') this.publish(ticket, { ...this.value, phase: 'capture_recovery',
        localClipPresent: false, error: error instanceof Error ? error.message : 'Recording start needs explicit recovery.' });
      throw error;
    } finally { this.finish(ticket); }
  }

  start(): Promise<void> { return this.captureAction('start'); }
  pause(): Promise<void> { return this.captureAction('pause'); }
  resume(): Promise<void> { return this.captureAction('resume'); }

  /** One explicit Stop-and-save. The stopped clip identity is minted once and retained on failure. */
  async stopAndSave(): Promise<void> {
    if (this.value.phase !== 'recording' && this.value.phase !== 'paused' && this.value.phase !== 'capture_recovery') {
      throw new Error(`Cannot stop-and-save while voice session is ${this.value.phase}.`);
    }
    if (this.clip) throw new Error('A stopped clip is already held by this session. Continue or discard that exact clip first.');
    const ticket = this.begin();
    let stopResolved = false;
    try {
      if (!this.pendingCaptureId) {
        const candidate = this.options.makeCaptureId?.() ?? createCaptureId();
        if (!UUID_V4.test(candidate)) throw new Error('A secure capture identifier could not be created.');
        this.pendingCaptureId = candidate;
      }
      const stopped = await this.options.getCapture().stop();
      stopResolved = true;
      if (!this.current(ticket)) return;
      if (!isLegacyStop(stopped)) {
        this.pendingCaptureId = undefined;
        this.publish(ticket, { ...this.value, phase: 'capture_recovery', localClipPresent: false,
          error: stopped ? 'This capture requires explicit local recovery.' : 'Stop returned no clip. Explicitly discard or retry Stop before starting another capture.' });
        return;
      }
      const captureId = this.pendingCaptureId;
      this.pendingCaptureId = undefined;
      const clip: HeldClip = Object.freeze({ uri: stopped.uri, captureId, capturedAt: stopped.capturedAt,
        captureTimeZone: stopped.captureTimeZone, durationSeconds: stopped.durationSeconds });
      this.clip = clip;
      this.publish(ticket, { phase: 'stopped', captureId, capturedAt: clip.capturedAt, captureTimeZone: clip.captureTimeZone,
        durationSeconds: clip.durationSeconds, localClipPresent: true });
      await this.uploadHeldClip(ticket, clip, true);
    } catch (error) {
      if (this.current(ticket)) this.publish(ticket, { ...this.value,
        phase: stopResolved ? (this.value.uploadId ? 'upload_unknown' : 'stopped') : this.value.phase,
        error: error instanceof Error ? error.message : 'The capture could not be saved.' });
    } finally { this.finish(ticket); }
  }

  /** Explicit continuation after a known pre-send failure; an admitted or unknown upload cannot be resent. */
  async uploadStoppedClip(): Promise<void> {
    const clip = this.clip;
    if (!clip || this.value.uploadId || this.value.phase !== 'stopped') throw new Error('There is no safely retryable stopped clip.');
    const ticket = this.begin();
    try { await this.uploadHeldClip(ticket, clip, true); }
    catch (error) {
      if (this.current(ticket)) this.publish(ticket, { ...this.value, phase: this.value.uploadId ? 'upload_unknown' : 'stopped',
        error: error instanceof Error ? error.message : 'The upload could not be confirmed.' });
    } finally { this.finish(ticket); }
  }

  private async uploadHeldClip(ticket: number, clip: HeldClip, adoptReady: boolean): Promise<void> {
    this.publish(ticket, { ...this.value, phase: 'uploading', captureId: clip.captureId, capturedAt: clip.capturedAt,
      captureTimeZone: clip.captureTimeZone, durationSeconds: clip.durationSeconds, localClipPresent: !!this.clip, error: undefined });
    const blob = await this.options.getCapture().readTemporaryClip(clip.uri);
    if (!this.current(ticket)) return;
    let admittedUploadId: string | undefined;
    const receipt = await this.options.audio.uploadClip({ blob, capture: {
      id: clip.captureId, capturedAt: clip.capturedAt, timeZone: clip.captureTimeZone,
    } }, (pending) => {
      if (!this.current(ticket)) throw new Error('The voice session changed before upload admission.');
      admittedUploadId = pending.uploadId;
      this.publish(ticket, { ...this.value, uploadId: pending.uploadId });
    });
    if (!this.current(ticket)) return;
    if (!sameCapture(receipt, clip) || (admittedUploadId && receipt.uploadId !== admittedUploadId)) {
      this.publish(ticket, { ...this.value, phase: 'upload_unknown', uploadId: admittedUploadId ?? receipt.uploadId,
        error: 'The upload receipt did not match this stopped clip.' });
      return;
    }
    const decision = this.applyUploadReceipt(ticket, receipt, clip);
    if (adoptReady && decision === 'ready' && this.current(ticket)) {
      await this.adoptReady(ticket, receipt);
    } else if (adoptReady && decision === 'consumed' && receipt.consumption && this.current(ticket)) {
      await this.inspectExistingAdoption(ticket, receipt.consumption.commandId, receipt.capture.id,
        receipt.capture.revision, receipt.consumption.noteId);
    }
  }

  private applyUploadReceipt(ticket: number, receipt: AudioUploadReceiptDTO, clip?: HeldClip): UploadReceiptDecision {
    if (!this.current(ticket)) return 'unresolved';
    const localMatches = !!clip && this.clip === clip;
    const selectedReceiptFields = { selectedUploadId: receipt.uploadId, selectedReceipt: receipt };
    const bound = this.selectedCapture;
    if (this.selectedCommandId) {
      const captureMatches = bound?.id === receipt.capture.id && bound.revision === receipt.capture.revision;
      const consumedMatches = receipt.status === 'consumed' && receipt.consumption?.commandId === this.selectedCommandId;
      if (!captureMatches || (receipt.status === 'consumed' && !consumedMatches)) {
        this.publish(ticket, { ...this.value, phase: this.value.phase === 'saved' ? 'saved' : 'adoption_unknown',
          error: 'The upload receipt does not match the already admitted adoption. Inspect only the exact command ID.' });
        return 'unresolved';
      }
      this.publish(ticket, { ...this.value, phase: this.value.phase === 'saved' ? 'saved' : 'adoption_unknown',
        uploadId: receipt.uploadId, uploadStatus: receipt.status, uploadReceipt: receipt,
        ...selectedReceiptFields,
        adoptionCommandId: this.selectedCommandId, localClipPresent: localMatches,
        error: this.value.phase === 'saved' ? undefined : 'An adoption command is already admitted. Inspect that exact command before continuing.' });
      return consumedMatches ? 'consumed' : 'adoption_bound';
    }
    if (receipt.status === 'ready') {
      this.publish(ticket, { ...this.value, phase: 'ready', captureId: receipt.capture.id, capturedAt: receipt.capture.capturedAt,
        captureTimeZone: receipt.capture.timeZone, uploadId: receipt.uploadId, uploadStatus: receipt.status,
        uploadReceipt: receipt, ...selectedReceiptFields, localClipPresent: localMatches, error: undefined });
      this.selectedCapture = { id: receipt.capture.id, revision: receipt.capture.revision };
      return 'ready';
    }
    if (receipt.status === 'consumed' && receipt.consumption) {
      this.selectedCapture = { id: receipt.capture.id, revision: receipt.capture.revision };
      this.selectedCommandId = receipt.consumption.commandId;
      this.publish(ticket, { ...this.value, phase: 'adoption_unknown', captureId: receipt.capture.id,
        capturedAt: receipt.capture.capturedAt, captureTimeZone: receipt.capture.timeZone, uploadId: receipt.uploadId,
        uploadStatus: receipt.status, uploadReceipt: receipt, ...selectedReceiptFields, adoptionCommandId: receipt.consumption.commandId,
        localClipPresent: localMatches, error: 'This capture was already consumed. Inspect its existing adoption command.' });
      return 'consumed';
    }
    const uncertain = receipt.status === 'receiving' || receipt.status === 'inspect_required';
    const hasTransportHold = !!this.options.audio.getPendingUpload();
    if (uncertain || localMatches || hasTransportHold) {
      this.publish(ticket, { ...this.value, phase: uncertain ? 'upload_unknown' : 'stopped', uploadId: receipt.uploadId,
        uploadStatus: receipt.status, uploadReceipt: receipt, ...selectedReceiptFields, localClipPresent: localMatches,
        error: `The upload is ${receipt.status}; inspect its exact receipt before continuing.` });
    } else {
      this.pendingCaptureId = undefined;
      this.publish(ticket, { phase: 'idle', localClipPresent: false, ...(this.value.history ? { history: this.value.history } : {}),
        snapshot: this.value.snapshot, selectedUploadId: receipt.uploadId, selectedReceipt: receipt,
        error: `The upload is ${receipt.status}; its server record remains available in history.` });
    }
    return uncertain ? 'unresolved' : 'terminal';
  }

  /** Inspect exactly one upload ID. This is the only recovery path after an unknown upload. */
  async inspectUpload(uploadId: string): Promise<AudioUploadReceiptDTO> {
    const activeUploadId = this.value.uploadId;
    const isSame = uploadId === activeUploadId;
    const switchableReady = this.value.phase === 'ready' && !this.value.localClipPresent && !this.selectedCommandId;
    if (!isSame && this.value.phase !== 'idle' && this.value.phase !== 'saved' && !switchableReady) {
      throw new Error('Resolve or explicitly discard the current voice session before selecting another upload.');
    }
    if (!isSame && this.value.phase === 'saved') {
      throw new Error('Reset the confirmed saved capture before selecting another upload.');
    }
    const ticket = this.begin();
    if (!isSame) {
      this.selectedCommandId = undefined;
      this.selectedCapture = undefined;
      this.publish(ticket, { phase: 'idle', localClipPresent: false,
        ...(this.value.history ? { history: this.value.history } : {}), snapshot: this.value.snapshot,
        selectedUploadId: uploadId });
    }
    try {
      const receipt = await this.options.audio.inspectUpload(uploadId);
      if (!this.current(ticket)) return receipt;
      if (receipt.uploadId !== uploadId) throw new Error('The upload response did not match the exact selected ID.');
      const heldClip = this.clip;
      if (heldClip && isSame && (!sameCapture(receipt, heldClip) || receipt.uploadId !== this.value.uploadId)) {
        this.publish(ticket, { ...this.value, phase: 'upload_unknown',
          error: 'The inspected upload receipt did not match the held clip metadata.' });
        return receipt;
      }
      const clip = heldClip?.captureId === receipt.capture.id ? heldClip : undefined;
      const decision = this.applyUploadReceipt(ticket, receipt, clip);
      if (decision === 'consumed' && receipt.consumption) {
        await this.inspectExistingAdoption(ticket, receipt.consumption.commandId, receipt.capture.id,
          receipt.capture.revision, receipt.consumption.noteId);
      }
      return receipt;
    } catch (error) {
      if (this.current(ticket)) this.publish(ticket, { ...this.value,
        error: error instanceof Error ? error.message : 'The selected upload receipt could not be inspected.' });
      throw error;
    } finally { this.finish(ticket); }
  }

  async listHistory(cursor?: string): Promise<AudioUploadHistoryPageDTO> {
    const ticket = this.begin();
    try {
      const page = await this.options.audio.listUploads(cursor);
      if (this.current(ticket)) this.publish(ticket, { ...this.value, history: page, error: undefined });
      return page;
    } finally { this.finish(ticket); }
  }

  selectUpload(uploadId: string): Promise<AudioUploadReceiptDTO> { return this.inspectUpload(uploadId); }

  /** Explicitly adopt a ready receipt once; command admission ID is retained before network dispatch. */
  async saveReady(): Promise<void> {
    if (this.value.phase !== 'ready' || this.selectedCommandId) {
      throw new Error('Only a ready upload without an admitted adoption can start a new save command. Inspect an unknown adoption.');
    }
    const receipt = this.value.uploadReceipt ?? this.value.selectedReceipt;
    if (!receipt || receipt.status !== 'ready') throw new Error('Inspect a ready upload receipt before saving it.');
    const ticket = this.begin();
    try {
      await this.adoptReady(ticket, receipt);
    } catch (error) {
      if (this.current(ticket)) this.publish(ticket, { ...this.value, phase: this.selectedCommandId ? 'adoption_unknown' : 'ready',
        error: error instanceof Error ? error.message : 'The adoption result could not be confirmed.' });
    } finally { this.finish(ticket); }
  }

  private async adoptReady(ticket: number, receipt: AudioUploadReceiptDTO): Promise<void> {
    if (!this.current(ticket) || receipt.status !== 'ready' || this.selectedCommandId) return;
    const capture = { id: receipt.capture.id, revision: receipt.capture.revision };
    this.selectedCapture = capture;
    this.publish(ticket, { ...this.value, phase: 'adopting', captureId: capture.id, uploadId: receipt.uploadId,
      uploadStatus: 'ready', uploadReceipt: receipt, localClipPresent: !!this.clip, error: undefined });
    try {
      const response = await this.options.workspace.execute({ kind: 'notes.capture.adopt', captureId: capture.id,
        captureRevision: capture.revision }, (envelope) => {
        if (!this.current(ticket) || envelope.command.kind !== 'notes.capture.adopt' ||
            envelope.command.captureId !== capture.id || envelope.command.captureRevision !== capture.revision) {
          throw new Error('The exact capture adoption was not admitted.');
        }
        this.selectedCommandId = envelope.commandId;
        this.publish(ticket, { ...this.value, adoptionCommandId: envelope.commandId });
      });
      if (!this.current(ticket)) return;
      const noteId = this.selectedCommandId ? exactAdoption(response, this.selectedCommandId, capture.id, capture.revision) : undefined;
      if (!noteId) {
        this.publish(ticket, { ...this.value, phase: this.selectedCommandId ? 'adoption_unknown' : 'ready',
          error: this.selectedCommandId ? 'The adoption receipt needs exact inspection before the local clip can be released.' : 'The adoption was not admitted.' });
        return;
      }
      await this.confirmSaved(ticket, noteId);
    } catch (error) {
      if (this.current(ticket)) this.publish(ticket, { ...this.value, phase: this.selectedCommandId ? 'adoption_unknown' : 'ready',
        error: error instanceof Error ? error.message : 'The adoption result could not be confirmed.' });
    }
  }

  async inspectAdoption(commandId = this.selectedCommandId): Promise<void> {
    const capture = this.selectedCapture;
    if (!commandId || !capture || commandId !== this.selectedCommandId) throw new Error('Inspect only the exact admitted adoption command.');
    const ticket = this.begin();
    try { await this.inspectExistingAdoption(ticket, commandId, capture.id, capture.revision); }
    finally { this.finish(ticket); }
  }

  private async inspectExistingAdoption(ticket: number, commandId: string, captureId: string,
    captureRevision: string, expectedNoteId?: string): Promise<void> {
    if (!this.current(ticket)) return;
    const response = await this.options.workspace.inspect(commandId);
    if (!this.current(ticket)) return;
    const noteId = exactAdoption(response, commandId, captureId, captureRevision, expectedNoteId);
    if (!noteId) {
      this.publish(ticket, { ...this.value, phase: 'adoption_unknown', adoptionCommandId: commandId,
        error: 'The existing adoption command is not confirmed finished for this exact capture.' });
      return;
    }
    await this.confirmSaved(ticket, noteId);
  }

  private async confirmSaved(ticket: number, noteId: string): Promise<void> {
    if (!this.current(ticket)) return;
    const clip = this.clip;
    if (clip && clip.captureId === this.selectedCapture?.id) {
      try { this.options.getCapture().commit(clip.uri); this.clip = undefined; }
      catch { /* Server adoption is confirmed; leave the RAM reference visible if local cleanup failed. */ }
    }
    this.publish(ticket, { ...this.value, phase: 'saved', noteId, adoptionCommandId: this.selectedCommandId,
      snapshot: this.options.workspace.readSnapshot(), localClipPresent: !!this.clip, error: undefined });
    try {
      const snapshot = await this.options.workspace.refresh();
      if (this.current(ticket) && snapshot) this.publish(ticket, { ...this.value, snapshot });
    } catch { /* The exact finished receipt is the save evidence; a later explicit refresh may update the view. */ }
  }

  /** Local RAM cleanup only. It never deletes server media or clears an unknown server outcome. */
  async discardLocalClip(): Promise<void> {
    const clip = this.clip;
    if (!clip) throw new Error('There is no local RAM clip to discard.');
    const ticket = this.begin();
    try {
      await this.options.getCapture().cancel();
      if (!this.current(ticket)) return;
      this.clip = undefined;
      const unresolved = this.value.phase === 'upload_unknown' || this.value.phase === 'adoption_unknown';
      const knownTerminal = this.value.uploadStatus === 'failed' || this.value.uploadStatus === 'discarded';
      const safelyLocalOnly = this.value.phase === 'stopped' && !this.value.uploadId;
      const transportClear = !this.options.audio.getPendingUpload();
      if (safelyLocalOnly || (knownTerminal && transportClear)) {
        this.pendingCaptureId = undefined;
        this.selectedCommandId = undefined;
        this.selectedCapture = undefined;
        this.publish(ticket, { phase: 'idle', localClipPresent: false,
          ...(this.value.history ? { history: this.value.history } : {}), snapshot: this.options.workspace.readSnapshot(),
          error: 'The local RAM clip was discarded. Any server upload record remains unchanged.' });
      } else {
        this.publish(ticket, { ...this.value, localClipPresent: false,
          error: unresolved
            ? `${this.value.error ?? 'The server outcome is unknown.'} The local RAM clip was discarded; server media and the exact recovery IDs remain.`
            : knownTerminal && !transportClear
              ? 'The local RAM clip was discarded. Inspect this terminal upload ID to release the transport hold before starting another capture.'
              : 'The local RAM clip was discarded. Server media, if uploaded, remains unchanged.' });
      }
    } finally { this.finish(ticket); }
  }

  /** Cancel an active recording locally. A failure leaves the capture phase unchanged. */
  async cancelCurrentRecording(): Promise<void> {
    if (this.value.phase !== 'recording' && this.value.phase !== 'paused' && this.value.phase !== 'capture_recovery') {
      throw new Error('There is no active recording to discard.');
    }
    const ticket = this.begin();
    try {
      await this.options.getCapture().cancel();
      if (this.current(ticket)) {
        this.pendingCaptureId = undefined;
        this.publish(ticket, { phase: 'idle', localClipPresent: false });
      }
    } catch (error) {
      if (this.current(ticket)) this.publish(ticket, { ...this.value, phase: 'capture_recovery',
        error: error instanceof Error ? error.message : 'Local recording cleanup could not be confirmed.' });
      throw error;
    } finally { this.finish(ticket); }
  }

  /** Explicitly unlocks a new capture only after the previous server save is confirmed. */
  resetAfterSave(): void {
    if (this.disposed) throw new Error('This voice session is no longer active.');
    if (this.operation || this.value.phase !== 'saved' || this.clip) {
      throw new Error('A new capture is available only after the prior save is confirmed and local audio is released.');
    }
    this.publish(this.generation, { phase: 'idle', localClipPresent: false,
      ...(this.value.history ? { history: this.value.history } : {}), snapshot: this.options.workspace.readSnapshot() });
    this.selectedCommandId = undefined;
    this.selectedCapture = undefined;
    this.pendingCaptureId = undefined;
  }

  /** Invalidates pending continuations. Capture cleanup remains owned by the hook. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.operation = false;
    if (this.options.disposeAudioOnDispose) this.options.audio.dispose();
    this.listeners.clear();
  }
}
